// issue #64 R1：run 终态 worktree 产物回收——agentd 侧捕获与上传。
// 依据：docs/design/runner-integration.md §4.2 U13 / §6.6。
//
// 捕获内容（终态确认后、cleanupWorktree/archiveRunData 之前）：
//   - git worktree：`git diff HEAD`（含 staged）→ diff.patch；`git status --porcelain` 中
//     untracked（`??`）新文件 → 快照进 tar。
//   - 非 git 目录：全量文件清单（排除 .git/node_modules/.notes）。
// 打包：单 tar.gz = diff.patch + files/NNNNNN 快照 + manifest.json（真实路径/大小/sha256/truncated
// 只在 manifest 内，tar 条目名恒为短名 ≤100B——读写两侧都免 longname/pax 编码）。
// 上限：文件快照累计超 maxBytes（默认 20MB）即截断并在 manifest.truncated 标记（不静默丢）。
// 失败语义：本模块任何失败都不抛出给清场路径——返回 { ok:false } 由调用方记 warn 日志。

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
export const ARTIFACT_MANIFEST_NAME = 'manifest.json';

const EXCLUDE_DIRS = new Set(['.git', 'node_modules', '.notes']);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// 极简 ustar writer（与 portal/src/artifacts.js 的 reader 成对约定）：
// 只写常规文件条目，name ≤100B（调用方保证），无 longname/pax。
// ---------------------------------------------------------------------------

function writeOctal(buf, off, len, value) {
  // 前 len-1 位：八进制数字 + NUL 结尾（末位保持 0）。
  const s = Math.floor(value).toString(8).padStart(len - 1, '0');
  buf.write(s.slice(-(len - 1)), off, 'ascii');
  buf[off + len - 1] = 0;
}

function tarHeader(name, size) {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 'utf8'); // ≤100B，越界由调用方截断保证不发生
  writeOctal(buf, 100, 8, 0o644); // mode
  writeOctal(buf, 108, 8, 0);     // uid
  writeOctal(buf, 116, 8, 0);     // gid
  writeOctal(buf, 124, 12, size); // size
  writeOctal(buf, 136, 12, Math.floor(Date.now() / 1000)); // mtime
  buf[156] = 0x30; // '0' = 常规文件
  buf.write('ustar', 257, 'ascii');
  buf[262] = 0;
  buf.write('00', 263, 'ascii');
  buf.write('erix', 265, 'ascii');   // uname
  buf.write('erix', 297, 'ascii');   // gname
  // 校验和：先填空格再求和，写「6 位八进制 + NUL + 空格」。
  for (let i = 148; i < 156; i++) buf[i] = 0x20;
  let sum = 0;
  for (const b of buf) sum += b;
  const s = sum.toString(8).padStart(6, '0');
  buf.write(s, 148, 'ascii');
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

/** 打 ustar 包（条目：{name, data:Buffer|string}）。 */
export function buildTar(entries) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    parts.push(tarHeader(e.name, data.length), data);
    const rem = data.length % 512;
    if (rem) parts.push(Buffer.alloc(512 - rem));
  }
  parts.push(Buffer.alloc(1024)); // 结束块
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// 捕获
// ---------------------------------------------------------------------------

function defaultGitExec(args) {
  return new Promise((resolve) => {
    execFile('git', args, { timeout: 30000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/** git status --porcelain 的 `??` 行解出路径（容忍带引号转义，失败原样返回）。 */
export function parseUntrackedPaths(porcelain) {
  const paths = [];
  for (const line of String(porcelain ?? '').split('\n')) {
    if (!line.startsWith('?? ')) continue;
    let p = line.slice(3).trim();
    if (p.startsWith('"') && p.endsWith('"')) {
      try { p = JSON.parse(p); } catch { /* 保留原文 */ }
    }
    if (p) paths.push(p);
  }
  return paths;
}

/** 非 git 目录递归收集文件（排除 .git/node_modules/.notes，符号链接跳过）。 */
export function walkFiles(root) {
  const out = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (rel === '' && EXCLUDE_DIRS.has(ent.name)) continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) stack.push(childRel);
      else if (ent.isFile()) out.push(childRel);
    }
  }
  return out.sort();
}

/**
 * 捕获 worktree 产物 → 单 tar.gz（含 manifest.json）。
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.worktreePath
 * @param {number} [opts.maxBytes] 文件快照累计上限（截断标记 truncated）
 * @param {(args:string[])=>Promise<string|null>} [opts.gitExec] 可注入的 git 执行器（测试用）
 * @returns {Promise<{buffer:Buffer, manifest:object}|null>} 无产物（worktree 不存在/空变更）返回 null
 */
export async function captureArtifact({ runId, worktreePath, maxBytes = ARTIFACT_MAX_BYTES, gitExec }) {
  if (!worktreePath || !fs.existsSync(worktreePath)) return null;
  const git = gitExec ?? defaultGitExec;
  const isGit = (await git(['-C', worktreePath, 'rev-parse', '--is-inside-work-tree']))?.trim() === 'true';

  let diff = '';
  let untracked = [];
  let allFiles = null; // 非 git 场景：全量清单
  if (isGit) {
    diff = (await git(['-C', worktreePath, 'diff', 'HEAD'])) ?? ''; // 含 staged
    const porcelain = await git(['-C', worktreePath, 'status', '--porcelain']);
    if (porcelain !== null) untracked = parseUntrackedPaths(porcelain);
  } else {
    allFiles = walkFiles(worktreePath);
  }

  const entries = [];
  const files = [];
  let truncated = false;
  let used = 0;
  if (isGit && diff.length > 0) {
    entries.push({ name: 'diff.patch', data: Buffer.from(diff, 'utf8') });
  }

  const snapshot = (rel) => {
    const abs = path.join(worktreePath, rel);
    let buf;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return;
      buf = fs.readFileSync(abs);
    } catch { return; }
    if (used + buf.length > maxBytes) { truncated = true; return; }
    const name = `files/${String(files.length).padStart(6, '0')}`;
    files.push({ path: rel, size: buf.length, sha256: sha256(buf), tar: name });
    entries.push({ name, data: buf });
    used += buf.length;
  };

  for (const rel of untracked) {
    if (truncated) break;
    const abs = path.join(worktreePath, rel);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      // porcelain 对全新未跟踪目录整体折叠（`?? src/`）→ 递归展开成文件清单。
      for (const sub of walkFiles(abs)) {
        if (truncated) break;
        snapshot(path.join(rel, sub));
      }
    } else {
      snapshot(rel);
    }
  }
  if (allFiles) {
    for (const rel of allFiles) {
      if (truncated) break;
      snapshot(rel);
    }
  }

  // 无任何产物（无 diff、无文件）→ 不上传，兼容现状（artifacts 表无行 = 无产物）。
  if (entries.length === 0) return null;

  const manifest = {
    schema: 1,
    run_id: runId,
    captured_at: new Date().toISOString(),
    worktree: worktreePath,
    git: isGit,
    truncated,
    diff_bytes: entries[0]?.name === 'diff.patch' ? entries[0].data.length : 0,
    files,
  };
  entries.push({ name: ARTIFACT_MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest), 'utf8') });
  const tar = buildTar(entries);
  return { buffer: zlib.gzipSync(tar), manifest };
}

// ---------------------------------------------------------------------------
// 捕获 + 上传（供 agentd 清场路径调用；best-effort，不抛出）
// ---------------------------------------------------------------------------

/**
 * 捕获并上传 run 产物 bundle。
 * @param {object} opts
 * @param {(bundle:{buffer:Buffer,size:number,sha256:string,manifest:object})=>Promise<void>} opts.upload
 * @returns {Promise<{ok:boolean,captured?:boolean,deduped?:boolean,size?:number,sha256?:string,truncated?:boolean,error?:string}>}
 */
export async function captureAndUploadArtifact({ runId, worktreePath, maxBytes, gitExec, upload, log = () => {} }) {
  try {
    const captured = await captureArtifact({ runId, worktreePath, maxBytes, gitExec });
    if (!captured) {
      log('info', 'no artifact to capture', { run_id: runId });
      return { ok: true, captured: false };
    }
    const digest = sha256(captured.buffer);
    try {
      await upload({
        buffer: captured.buffer,
        size: captured.buffer.length,
        sha256: digest,
        manifest: captured.manifest,
      });
    } catch (err) {
      // 幂等：portal 已有该 run 产物（409 artifact_exists）→ 视为成功，不覆盖。
      if (err?.code === 'artifact_exists') {
        log('info', 'artifact already uploaded, skip', { run_id: runId });
        return { ok: true, captured: true, deduped: true };
      }
      throw err;
    }
    log('info', 'artifact uploaded', {
      run_id: runId, size: captured.buffer.length, truncated: captured.manifest.truncated,
    });
    return {
      ok: true,
      captured: true,
      size: captured.buffer.length,
      sha256: digest,
      truncated: captured.manifest.truncated === true,
    };
  } catch (err) {
    // 失败不得阻塞清场：warn 由调用方落日志，这里只回结果。
    log('warn', 'artifact capture/upload failed', { run_id: runId, msg: String(err?.message ?? err) });
    return { ok: false, error: String(err?.message ?? err) };
  }
}
