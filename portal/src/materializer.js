// materializer：把 DB desired state 物化为 FDE 用户空间文件（D-6 直写宿主 bind mount）。
// 依据：docs/design/user-space.md（路径映射/文件清单/原子写/manifest/generation/权限/失败状态机）。
// 纯渲染（可单测）+ 原子落盘 + materialize_outbox 消费（revision head 语义 / latest-wins / 失败退避）。

import fs from 'node:fs';
import path from 'node:path';
import { sha256, atomicWriteFile, ensureDirSafe, readFileIfExists } from './fsutil.js';

// 容器内用户名固定 erix（⚠️ 待决策者确认，user-space §2.4）。
export const FDE_CONTAINER_USER = 'erix';
export const CONTAINER_HOME = `/home/${FDE_CONTAINER_USER}`;

// 平台文件权限（user-space §6.2）：普通平台文件 0644，manifest 0444。
const FILE_MODE = 0o644;
const MANIFEST_MODE = 0o444;
// 目录权限：工作区目录 2770，.erix 0750（user-space §6.2）。
const WORKSPACE_DIR_MODE = 0o2770;
const ERIX_DIR_MODE = 0o750;

function json(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// 纯渲染（同 DB 快照 → 字节级相同输出）
// ---------------------------------------------------------------------------

export function renderConfigJson({ llmHost }) {
  const baseURL = `https://${llmHost}/v1`;
  return json({
    default: { apiKey: 'erix-placeholder', baseURL, model: 'claude-sonnet' },
    audit: { apiKey: 'erix-placeholder', baseURL, model: 'claude-haiku' },
    fold: { apiKey: 'erix-placeholder', baseURL, model: 'claude-haiku' },
  });
}

export function renderMcpJson() {
  return json({ mcpServers: {} });
}

export function renderHomeAgentsMd({ fdeName }) {
  return [
    '# FDE 工位约定',
    '',
    '> 本文件由平台（materializer）生成，属平台所有（root:root 0644）；改动会被对账重物化覆盖。',
    '',
    '## 目录约定',
    '',
    `- 一个项目 = \`~/projects/<project>\`（本容器用户 ${FDE_CONTAINER_USER}）`,
    `- 一个 run = \`~/worktrees/<project>-<runId>\` + 分支 \`agent/<runId>\``,
    '- 端口一律从 `~/projects/<project>/.erix/ports.json` 取，不要自己挑；dev server 绑 `0.0.0.0`',
    '- 回流走 fork/PR，不直接在主干改',
    '- `node_modules` 每 worktree 一份 → 用 pnpm store / npm cache 共享（`~/cache`）',
    '',
    '## git',
    '',
    '- clone 与 git 凭据（SSH key / token）由你在容器内自行配置（等同你自己的开发机）',
    '- 平台不 clone、不下发 git 凭据',
    '',
    `（FDE 标识：${fdeName}）`,
    '',
  ].join('\n');
}

export function renderProjectAgentsMd({ fdeName, projectName }) {
  return [
    `# ${projectName} · 项目级约定`,
    '',
    '> 本文件由平台生成（root:root 0644），位于 `.erix/` 内（已被 `.gitignore` 忽略），clone/checkout 不会触碰。',
    '',
    '## clone 方式指引',
    '',
    '目录非空（含 `.erix/`、`.gitignore`），clone 到临时目录再搬移，或 `git init + remote add + fetch + checkout`：',
    '',
    '```bash',
    `git init && git remote add origin <repo_url> && git fetch origin && git checkout -b main origin/main`,
    '```',
    '',
    '两种方式都不会触碰 `.erix/`。',
    '',
    '## 端口',
    '',
    '- 端口从 `.erix/ports.json` 取，不自己挑',
    '- dev server 绑 `0.0.0.0`',
    '',
    `（FDE：${fdeName} / 项目：${projectName}）`,
    '',
  ].join('\n');
}

export function renderGitignore() {
  return '.erix/\n';
}

export function renderPortsJson({ fdeName, projectName, allocations, generation }) {
  return json({
    schema: 1,
    fde: fdeName,
    project: projectName,
    generation,
    allocations: allocations.map((a) => ({
      scope: a.scope,
      port: Number(a.port),
      role: a.role,
      run_id: a.run_id,
      url: a.url,
      exposure: a.exposure,
      state: a.state,
    })),
  });
}

export function renderManifest({ fdeName, generation, entries, materializedAt }) {
  // files 键字典序（幂等序列化，user-space §5.5）。
  const keys = Object.keys(entries).sort();
  const files = {};
  for (const k of keys) {
    files[k] = { sha256: entries[k].sha256, revision: entries[k].revision };
  }
  return json({
    schema: 1,
    fde: fdeName,
    generation,
    materialized_at: materializedAt instanceof Date ? materializedAt.toISOString() : materializedAt,
    files,
  });
}

/**
 * 计算 hostPath（宿主路径 = <root>/<fde> 前缀 + 容器相对路径）。
 * 容器绝对路径 /home/erix/... → 宿主 <root>/<fde>/home/...。
 */
export function hostPathFor(root, fdeName, containerPath) {
  const rel = containerPath.replace(new RegExp(`^${CONTAINER_HOME}/`), '');
  const top = rel.split('/')[0];
  // 容器内 projects/worktrees/cache 是独立挂载（user-space §2.4），直接映射到 <root>/<fde>/<top>；
  // 其余（home 内容：AGENTS.md、.erix/* 等）映射到 <root>/<fde>/home/<rel>。
  if (top === 'projects' || top === 'worktrees' || top === 'cache') {
    return path.join(root, fdeName, rel);
  }
  return path.join(root, fdeName, 'home', rel);
}

/**
 * 纯函数：由 DB desired state 渲染该 FDE 全部平台文件（不含 manifest）。
 * @returns { files: [{ containerPath, hostPath, content, mode }] }
 */
export function buildFilePlan({ fdeName, baseDomain, llmHost, projects, allocationsByProject, root, generation }) {
  const files = [];
  const add = (containerPath, content, mode = FILE_MODE) => {
    files.push({ containerPath, hostPath: hostPathFor(root, fdeName, containerPath), content, mode });
  };

  add(`${CONTAINER_HOME}/AGENTS.md`, renderHomeAgentsMd({ fdeName }));
  add(`${CONTAINER_HOME}/.erix/config.json`, renderConfigJson({ llmHost }));
  add(`${CONTAINER_HOME}/.erix/mcp.json`, renderMcpJson());

  for (const project of projects) {
    const allocs = allocationsByProject.get(project.id) ?? [];
    add(`${CONTAINER_HOME}/projects/${project.name}/.gitignore`, renderGitignore());
    add(
      `${CONTAINER_HOME}/projects/${project.name}/.erix/ports.json`,
      renderPortsJson({ fdeName, projectName: project.name, allocations: allocs, generation }),
    );
    add(`${CONTAINER_HOME}/projects/${project.name}/.erix/AGENTS.md`, renderProjectAgentsMd({ fdeName, projectName: project.name }));
  }
  return files;
}

// ---------------------------------------------------------------------------
// 落盘（原子写 + 权限 + 属主 + 幂等 + manifest 提交点 + 删除清理）
// ---------------------------------------------------------------------------

/**
 * 创建 materializer（root/uid/gid 可注入，供单测隔离；生产 root=0, uid/gid=1000）。
 */
export function createMaterializer({ root, uid = 1000, gid = 1000, log = console }) {
  if (!root) throw new Error('materializer root is required');

  function ensureWorkspaceDirs(files) {
    // 顶层 userspace root：0755 root:root（仅 portal 可写，user-space §6.2）。
    ensureDirSafe(root, root, { mode: 0o755, uid: null, gid: null, log });
    // 逐文件父目录：<root>/<fde> 及以下工作区目录 2770，.erix 0750，属主 erix(1000)。
    const seen = new Set();
    for (const f of files) {
      const dir = path.dirname(f.hostPath);
      const rel = path.relative(path.resolve(root), path.resolve(dir));
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      let acc = path.resolve(root);
      for (const seg of rel.split(path.sep)) {
        acc = path.join(acc, seg);
        if (seen.has(acc)) continue;
        seen.add(acc);
        const mode = seg === '.erix' ? ERIX_DIR_MODE : WORKSPACE_DIR_MODE;
        ensureDirSafe(root, acc, { mode, uid, gid, log });
      }
    }
  }

  /**
   * 渲染 + 落盘该 FDE 全部平台文件 + manifest（提交点）。
   * 返回 manifest 内容与最终 generation（供测试断言）。
   */
  async function materialize({ fdeName, baseDomain, llmHost, projects, allocationsByProject, generation, prevManifest, materializedAt = new Date() }) {
    const rootReal = path.resolve(root);
    const prevFiles = (prevManifest && prevManifest.files) || {};

    const files = buildFilePlan({ fdeName, baseDomain, llmHost, projects, allocationsByProject, root: rootReal, generation });

    ensureWorkspaceDirs(files);

    // 3) 逐文件原子写（内容不变则跳过，user-space §8.2）；记录最终 entries。
    const entries = {};
    for (const f of files) {
      const prev = prevFiles[f.containerPath];
      const current = readFileIfExists(f.hostPath);
      const newSha = sha256(f.content);
      const changed = current !== f.content;
      const revision = changed ? (prev?.revision ?? 0) + 1 : (prev?.revision ?? 0);
      if (changed) {
        atomicWriteFile(f.hostPath, f.content, { mode: f.mode, root: rootReal });
      }
      entries[f.containerPath] = { sha256: newSha, revision };
    }

    // 4) 清理已删除文件（prevManifest 中不在本次 desired 集里的平台文件）。
    removeStaleFiles(prevFiles, new Set(Object.keys(entries)), rootReal, fdeName, log);

    // 5) 最后写 manifest（提交点，0444）；内容不变则不重写（user-space §8.2 幂等）。
    const manifestPath = path.join(rootReal, fdeName, 'home', '.erix', 'manifest.json');
    const manifestContent = renderManifest({ fdeName, generation, entries, materializedAt });
    if (readFileIfExists(manifestPath) !== manifestContent) {
      atomicWriteFile(manifestPath, manifestContent, { mode: MANIFEST_MODE, root: rootReal });
    }

    return { generation, manifest: manifestContent, files: entries };
  }

  return { materialize, ensureWorkspaceDirs };
}

function removeStaleFiles(prevFiles, desiredContainerPaths, root, fdeName, log) {
  for (const containerPath of Object.keys(prevFiles)) {
    if (desiredContainerPaths.has(containerPath)) continue;
    // 只清理平台所有文件（.erix/ 下、.gitignore、AGENTS.md）。
    const isPlatform = containerPath.startsWith(`${CONTAINER_HOME}/`) &&
      (containerPath.includes('/.erix/') ||
        containerPath.endsWith('/.gitignore') ||
        containerPath.endsWith('/AGENTS.md'));
    if (!isPlatform) continue;
    const real = hostPathFor(root, fdeName, containerPath);
    try {
      if (fs.existsSync(real)) fs.unlinkSync(real);
    } catch (e) {
      log.warn?.(`[materializer] unlink stale file ${real}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// materialize_outbox 消费（revision head / latest-wins / 失败退避）
// ---------------------------------------------------------------------------

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const MAX_ATTEMPTS = 5;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readFdeDesiredState(pool, fdeId, config) {
  const user = await pool.query(
    `SELECT id, fde_name FROM users WHERE id = $1 AND status = 'active'`,
    [fdeId],
  );
  if (user.rows.length === 0) return null;
  const fdeName = user.rows[0].fde_name;
  const projects = await pool.query(
    `SELECT id, name FROM projects WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    [fdeId],
  );
  const allocs = await pool.query(
    `SELECT id, project_id, scope, port, role, run_id, url, exposure, state
       FROM port_allocations WHERE fde_id = $1 AND state <> 'released' ORDER BY port`,
    [fdeId],
  );
  const allocationsByProject = new Map();
  for (const a of allocs.rows) {
    const list = allocationsByProject.get(a.project_id) ?? [];
    list.push(a);
    allocationsByProject.set(a.project_id, list);
  }
  return {
    fdeName,
    projects: projects.rows,
    allocationsByProject,
    llmHost: config.llmHost,
    baseDomain: config.baseDomain,
  };
}

async function readPrevManifest(root, fdeName) {
  const p = path.join(root, fdeName, 'home', '.erix', 'manifest.json');
  const raw = readFileIfExists(p);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 领取 materialize_outbox head 行（revision==head），并丢弃 revision<head 的晚到旧事件。 */
async function claimMaterializeRows(pool, workerId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE materialize_outbox o
         SET state = 'published', published_at = now(), last_error = NULL
        FROM materialize_revisions r
       WHERE o.fde_id = r.fde_id AND o.revision < r.revision AND o.state = 'pending'`,
    );
    const rows = await client.query(
      `UPDATE materialize_outbox o
          SET state = 'processing', claimed_at = now(), lease_until = now() + interval '60 seconds', worker_id = $1
        WHERE o.state = 'pending'
          AND o.id IN (
            SELECT o2.id FROM materialize_outbox o2
            JOIN materialize_revisions r ON r.fde_id = o2.fde_id AND r.revision = o2.revision
            WHERE o2.state = 'pending'
            ORDER BY o2.created_at
            FOR UPDATE OF o2 SKIP LOCKED
            LIMIT 10
          )
        RETURNING o.id, o.fde_id, o.revision, o.op`,
      [workerId],
    );
    await client.query('COMMIT');
    return rows.rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function markMaterializePublished(pool, id) {
  await pool.query(
    `UPDATE materialize_outbox SET state = 'published', published_at = now(), last_error = NULL WHERE id = $1`,
    [id],
  );
}

async function markMaterializeFailed(pool, id, error) {
  const r = await pool.query(
    `UPDATE materialize_outbox SET attempts = attempts + 1, last_error = $2,
       state = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END,
       claimed_at = NULL, lease_until = NULL, worker_id = NULL
     WHERE id = $1 RETURNING state`,
    [id, String(error?.message ?? error), MAX_ATTEMPTS],
  );
  return r.rows[0]?.state;
}

/**
 * 消费一轮 materialize_outbox。返回 { processed, stale } 供测试/观测。
 */
export async function runMaterializerOnce(pool, config, { log = console, workerId = 'materializer-1' } = {}) {
  const mat = createMaterializer({
    root: config.userSpaceRoot,
    uid: config.fdeUid ?? 1000,
    gid: config.fdeGid ?? 1000,
    log,
  });
  const rows = await claimMaterializeRows(pool, workerId);
  let processed = 0;
  for (const row of rows) {
    try {
      const state = await readFdeDesiredState(pool, row.fde_id, config);
      if (!state) {
        await markMaterializePublished(pool, row.id);
        continue;
      }
      const prevManifest = await readPrevManifest(config.userSpaceRoot, state.fdeName);
      await mat.materialize({
        fdeName: state.fdeName,
        baseDomain: state.baseDomain,
        llmHost: state.llmHost,
        projects: state.projects,
        allocationsByProject: state.allocationsByProject,
        generation: Number(row.revision),
        prevManifest,
      });
      await markMaterializePublished(pool, row.id);
      processed += 1;
    } catch (err) {
      log.warn?.(`[materializer] failed fde=${row.fde_id}: ${err.message}`);
      await markMaterializeFailed(pool, row.id, err);
    }
  }
  return { processed, claimed: rows.length };
}

/** 崩溃恢复：回收 processing 且租约过期的孤儿行（materializer 启动/定时调用）。 */
export async function recoverMaterializeOrphans(pool) {
  await pool.query(
    `UPDATE materialize_outbox
        SET state = 'pending', attempts = attempts + 1, claimed_at = NULL, lease_until = NULL, worker_id = NULL
      WHERE state = 'processing' AND lease_until < now()`,
  );
}

/** 启动全量重物化所有 FDE（portal 重启后从 DB 重建缺失状态，user-space §8.1）。 */
export async function rebuildAllFdes(pool, config, { log = console } = {}) {
  const mat = createMaterializer({
    root: config.userSpaceRoot,
    uid: config.fdeUid ?? 1000,
    gid: config.fdeGid ?? 1000,
    log,
  });
  const users = await pool.query(
    `SELECT id, fde_name FROM users WHERE fde_name IS NOT NULL AND status = 'active'`,
  );
  for (const u of users.rows) {
    const state = await readFdeDesiredState(pool, u.id, config);
    if (!state) continue;
    const rev = await pool.query(`SELECT revision FROM materialize_revisions WHERE fde_id = $1`, [u.id]);
    const generation = Number(rev.rows[0]?.revision ?? 1);
    const prevManifest = await readPrevManifest(config.userSpaceRoot, state.fdeName);
    await mat.materialize({ ...state, generation, prevManifest });
  }
  return users.rows.length;
}

/** 启动一个常驻消费循环（由 cli serve 调用）。 */
export function startMaterializerLoop(pool, config, { log = console, workerId = 'materializer-1', onPause } = {}) {
  let stopped = false;
  let consecutiveFailures = 0;
  (async () => {
    // 启动全量重物化（幂等：内容不变不重写，user-space §8.1）。
    try {
      await rebuildAllFdes(pool, config, { log });
    } catch (err) {
      log.warn?.(`[materializer] startup rebuild failed: ${err.message}`);
    }
    while (!stopped) {
      try {
        await recoverMaterializeOrphans(pool);
        await runMaterializerOnce(pool, config, { log, workerId });
        consecutiveFailures = 0;
        await sleep(250);
      } catch (err) {
        consecutiveFailures += 1;
        log.warn?.(`[materializer] loop error: ${err.message}`);
        onPause?.('materializer', err);
        const backoff = BACKOFF_MS[Math.min(consecutiveFailures - 1, BACKOFF_MS.length - 1)];
        await sleep(backoff);
      }
    }
  })();
  return {
    stop() {
      stopped = true;
    },
  };
}
