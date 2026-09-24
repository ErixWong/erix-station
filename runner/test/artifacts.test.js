// runner/lib/artifacts.js 单测（issue #64 R1）：tar 结构可解出 diff 与新文件、20MB 上限截断、
// 非 git 全量清单、捕获+上传编排（失败不抛出 / 409 幂等）。
// D8 修订（2026-09-24）：捕获目标 = 项目目录（worker cwd），git 用例即真实项目目录场景。
// 隔离约定：tmp 目录作项目目录；git 用例为真实 `git init` 临时仓库（本机有 git，与 agentd 运行前提一致）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import {
  buildTar,
  parseUntrackedPaths,
  walkFiles,
  captureArtifact,
  captureAndUploadArtifact,
  ARTIFACT_MANIFEST_NAME,
} from '../lib/artifacts.js';

/** 极简 tar 解包（测试用，与 writer 同约定：短名常规文件条目）。 */
function untar(buf) {
  const out = new Map();
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const sizeRaw = header.subarray(124, 136).toString('ascii').replace(/[\0 ]/g, '');
    const size = parseInt(sizeRaw, 8);
    const bodyOff = off + 512;
    out.set(name, Buffer.from(buf.subarray(bodyOff, bodyOff + size)));
    off = bodyOff + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** 造一个带 run 产物（修改 + untracked）的真实 git 项目目录（D8 修订后捕获目标）。 */
function makeGitProject({ dirty = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-art-git-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'README.md'), '# base\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'base']);
  if (dirty) {
    // run 产物：修改已跟踪文件 + 两个 untracked 新文件（其一在子目录，验证 porcelain 折叠展开）
    fs.writeFileSync(path.join(root, 'README.md'), '# base\nmodified by agent\n');
    fs.writeFileSync(path.join(root, 'server.js'), 'console.log(1);\n');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const x = 1;\n');
  }
  return { root };
}

test('buildTar：ustar 结构可被系统 tar 解出（校验和/对齐正确）', () => {
  const tar = buildTar([
    { name: 'a.txt', data: 'hello' },
    { name: 'files/000001', data: Buffer.alloc(600, 7) }, // 跨 512 对齐
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-tar-check-'));
  try {
    fs.writeFileSync(path.join(dir, 'x.tar'), tar);
    const listing = execFileSync('tar', ['-tf', path.join(dir, 'x.tar')]).toString();
    assert.match(listing, /a\.txt/);
    assert.match(listing, /files\/000001/);
    execFileSync('tar', ['-xf', path.join(dir, 'x.tar'), '-C', dir]);
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hello');
    assert.equal(fs.readFileSync(path.join(dir, 'files/000001')).length, 600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseUntrackedPaths：只取 ?? 行，容忍引号转义', () => {
  const porcelain = [
    ' M tracked.js',
    '?? new file.js',
    '?? "dir/with space/a.js"',
    '!! ignored.log',
    '',
  ].join('\n');
  assert.deepEqual(parseUntrackedPaths(porcelain), ['new file.js', 'dir/with space/a.js']);
});

test('walkFiles：排除 .git/node_modules/.notes，符号链接跳过', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-walk-'));
  try {
    fs.mkdirSync(path.join(root, '.git')); fs.writeFileSync(path.join(root, '.git', 'x'), '1');
    fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'node_modules', 'm.js'), '1');
    fs.mkdirSync(path.join(root, '.notes')); fs.writeFileSync(path.join(root, '.notes', 'n.md'), '1');
    fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), '1');
    fs.writeFileSync(path.join(root, 'src', 'deep', 'b.js'), '1');
    fs.symlinkSync(path.join(root, 'src', 'a.js'), path.join(root, 'link.js'));
    assert.deepEqual(walkFiles(root), ['src/a.js', 'src/deep/b.js']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('captureArtifact（git）：tar 含 diff.patch（修改）+ 新文件快照 + manifest', async () => {
  const { root } = makeGitProject();
  try {
    const res = await captureArtifact({ runId: 'run1', cwd: root });
    assert.ok(res);
    const entries = untar(zlib.gunzipSync(res.buffer));
    // diff.patch 含已跟踪文件的修改
    const diff = entries.get('diff.patch')?.toString('utf8') ?? '';
    assert.match(diff, /modified by agent/);
    // 两个 untracked 新文件进快照，内容可解出
    const manifest = JSON.parse(entries.get(ARTIFACT_MANIFEST_NAME).toString('utf8'));
    assert.equal(manifest.git, true);
    assert.equal(manifest.truncated, false);
    assert.equal(manifest.files.length, 2);
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(byPath).sort(), ['server.js', 'src/app.js']);
    for (const f of manifest.files) {
      assert.ok(entries.get(f.tar), `tar 条目存在: ${f.tar}`);
      assert.equal(entries.get(f.tar).length, f.size);
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
    }
    assert.equal(entries.get(byPath['server.js'].tar).toString('utf8'), 'console.log(1);\n');
    // 已跟踪修改不重复进文件快照（diff 已覆盖）
    assert.equal(manifest.files.some((f) => f.path === 'README.md'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('captureArtifact（非 git）：全量文件清单进快照', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-art-plain-'));
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'aaa');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'bbbb');
    const res = await captureArtifact({ runId: 'run2', cwd: root });
    assert.ok(res);
    const entries = untar(zlib.gunzipSync(res.buffer));
    const manifest = JSON.parse(entries.get(ARTIFACT_MANIFEST_NAME).toString('utf8'));
    assert.equal(manifest.git, false);
    assert.deepEqual(manifest.files.map((f) => f.path).sort(), ['a.txt', 'sub/b.txt']);
    assert.equal(entries.get(manifest.files.find((f) => f.path === 'sub/b.txt').tar).toString(), 'bbbb');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('captureArtifact：超过 maxBytes 截断并标记 truncated（不静默丢）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-art-trunc-'));
  try {
    fs.writeFileSync(path.join(root, 'big1.bin'), Buffer.alloc(600, 1));
    fs.writeFileSync(path.join(root, 'big2.bin'), Buffer.alloc(600, 2));
    fs.writeFileSync(path.join(root, 'big3.bin'), Buffer.alloc(600, 3));
    const res = await captureArtifact({ runId: 'run3', cwd: root, maxBytes: 1200 });
    assert.ok(res);
    const manifest = JSON.parse(untar(zlib.gunzipSync(res.buffer)).get(ARTIFACT_MANIFEST_NAME).toString('utf8'));
    assert.equal(manifest.truncated, true);
    assert.equal(manifest.files.length, 2); // 1200B 只装得下两个 600B 文件
    assert.equal(manifest.files.reduce((s, f) => s + f.size, 0), 1200);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('captureArtifact：空项目目录 / 无变更 → null（不上传，表无行兼容现状）', async () => {
  const { root } = makeGitProject({ dirty: false });
  try {
    // 无 diff、无 untracked（干净仓库）
    assert.equal(await captureArtifact({ runId: 'run4', cwd: root }), null);
    assert.equal(await captureArtifact({ runId: 'run5', cwd: path.join(root, 'nope') }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('captureAndUploadArtifact：上传失败不抛出（ok:false，清场不被阻塞）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-art-up-'));
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    const logs = [];
    const res = await captureAndUploadArtifact({
      runId: 'run6', cwd: root,
      upload: async () => { throw Object.assign(new Error('boom'), { code: 'network_error' }); },
      log: (level, msg, extra) => logs.push([level, msg, extra]),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /boom/);
    assert.ok(logs.some(([level, msg]) => level === 'warn' && msg.includes('failed')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('captureAndUploadArtifact：409 artifact_exists 视为幂等成功（不覆盖既有产物）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-art-dedup-'));
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    let calls = 0;
    const res = await captureAndUploadArtifact({
      runId: 'run7', cwd: root,
      upload: async () => { calls += 1; throw Object.assign(new Error('exists'), { code: 'artifact_exists' }); },
      log: () => {},
    });
    assert.equal(res.ok, true);
    assert.equal(res.deduped, true);
    assert.equal(calls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('captureAndUploadArtifact：正常路径上传 bundle（sha/size/manifest 传递）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-art-ok-'));
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'payload');
    let got = null;
    const res = await captureAndUploadArtifact({
      runId: 'run8', cwd: root,
      upload: async (bundle) => { got = bundle; },
      log: () => {},
    });
    assert.equal(res.ok, true);
    assert.equal(res.captured, true);
    assert.match(res.sha256, /^[0-9a-f]{64}$/);
    assert.ok(got.buffer.length > 0);
    assert.equal(got.size, got.buffer.length);
    assert.equal(got.manifest.run_id, 'run8');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
