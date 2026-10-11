// materializer：把 DB desired state 物化为 FDE 用户空间文件（D-6 直写宿主 bind mount）。
// 依据：docs/design/user-space.md（路径映射/文件清单/原子写/manifest/generation/权限/失败状态机）。
// 纯渲染（可单测）+ 原子落盘 + materialize_outbox 消费（revision head 语义 / latest-wins / 失败退避）。

import fs from 'node:fs';
import path from 'node:path';
import {
  sha256,
  atomicWriteFile,
  ensureDirSafe,
  readFileIfExists,
  assertSafePath,
  writeTempFile,
  commitTempFile,
} from './fsutil.js';

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

export function renderConfigJson({ llmBaseUrl }) {
  // erix-agent v0.3.5 实测：createJsonFileModelConfigProvider 读 `slots.{default,audit,fold}` 嵌套结构，
  // 且 OpenAI provider 字段为 `endpoint`（非 baseURL）。占位 key + endpoint，零真实 LLM 凭据（runner §6.3/§11）。
  const endpoint = `${String(llmBaseUrl).replace(/\/+$/, '')}/v1`;
  return json({
    slots: {
      // 占位 model 用真实存在且 relay 支持的名字（#79 教训：冷启动竞态回退时会真发请求，
      //      虚构名会被 relay 拒绝——占位即兜底，必须可用）。
      default: { apiKey: 'erix-placeholder', endpoint, model: 'deepseek-flash' },
      audit: { apiKey: 'erix-placeholder', endpoint, model: 'deepseek-flash' },
      fold: { apiKey: 'erix-placeholder', endpoint, model: 'deepseek-flash' },
    },
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
    `- 一个项目 = \`~/projects/<project>\`（本容器用户 ${FDE_CONTAINER_USER}）——目录即项目，无注册`,
    '- 一个 run 直接在项目目录 `~/projects/<project>` 工作，交付物留在项目目录内',
    '- **端口一律从 `~/.erix/ports.json` 取**，不要自己挑；dev server 绑 `0.0.0.0`',
    // issue #240：端口事实的「告知」落点之一（另一个是 runner 的 SYSTEM_PROMPT）——
    // 平台已在开户时预建 10 条预览域名，口径与 fde-platform.md §8.2 一致：固定 10 条、不做配额。
    '- 平台已预建 **10 条预览域名**（端口 `4000–4009`，每条带真实 `url`），**不够用也不会再给**：在这 10 条里选',
    '- 回流走 fork/PR，不直接在主干改',
    '- `node_modules` 每项目一份 → 用 pnpm store / npm cache 共享（`~/cache`）',
    '',
    '## clone 方式',
    '',
    '- 平台不 clone、不下发 git 凭据；SSH key / token 由你在容器内自行配置（等同你自己的开发机）',
    '- 空目录：`git clone <地址> .`（`.` 后缀 = clone 进当前目录）',
    '- 或直接 `git init` 新建；目录非空时 clone 到临时目录再搬移',
    '',
    '## 环境事实（先查再用，不要重复安装）',
    '',
    '- Node 22 / npm / pnpm（corepack）、python3 + venv/pip、gcc/g++/make、.NET SDK 8 已预装',
    '- **Playwright 浏览器已烘焙在 `/ms-playwright`（chromium + headless shell），无需 `playwright install`**；浏览器不在 PATH 上（`which chromium` 为空是正常的），用 `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` 或 `chromium.executablePath()` 定位',
    '- `which` 探测不到 ≠ 未安装；先查 `/ms-playwright`、`/usr/local/lib/node_modules` 再动手',
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

// P5 去项目化（directory-as-project §3/§5）：ports.json 升为 FDE 级单一文件 ~/.erix/ports.json——
// allocations 不再按项目分组（port_allocations.project_id 已退役，迁移 0008）。
export function renderPortsJson({ fdeName, allocations, generation }) {
  return json({
    schema: 1,
    fde: fdeName,
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
 * D8 修订 + P5：projects/cache 是独立挂载（user-space §2.4），worktrees 挂载已拆除（#81 P2.5）。
 */
export function hostPathFor(root, fdeName, containerPath) {
  const rel = containerPath.replace(new RegExp(`^${CONTAINER_HOME}/`), '');
  const top = rel.split('/')[0];
  // 容器内 projects/cache 是独立挂载（user-space §2.4），直接映射到 <root>/<fde>/<top>；
  // 其余（home 内容：AGENTS.md、.erix/* 等）映射到 <root>/<fde>/home/<rel>。
  if (top === 'projects' || top === 'cache') {
    return path.join(root, fdeName, rel);
  }
  return path.join(root, fdeName, 'home', rel);
}

/**
 * 纯函数：由 DB desired state 渲染该 FDE 全部平台文件（不含 manifest）。
 * P5：项目级物化（.gitignore / .erix/ports.json / .erix/AGENTS.md）整体退役——平台文件只落家目录
 * 骨架 + FDE 级 ports.json；旧项目脚手架靠 stale 清理（manifest 机制）自然移除。
 * @returns { files: [{ containerPath, hostPath, content, mode }] }
 */
export function buildFilePlan({ fdeName, baseDomain, llmBaseUrl, allocations, root, generation }) {
  const files = [];
  const add = (containerPath, content, mode = FILE_MODE) => {
    files.push({ containerPath, hostPath: hostPathFor(root, fdeName, containerPath), content, mode });
  };

  add(`${CONTAINER_HOME}/AGENTS.md`, renderHomeAgentsMd({ fdeName }));
  add(`${CONTAINER_HOME}/.erix/config.json`, renderConfigJson({ llmBaseUrl }));
  add(`${CONTAINER_HOME}/.erix/mcp.json`, renderMcpJson());
  add(`${CONTAINER_HOME}/.erix/ports.json`, renderPortsJson({ fdeName, allocations, generation }));
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
  async function materialize({ fdeName, baseDomain, llmBaseUrl, allocations, generation, prevManifest, materializedAt = new Date() }) {
    const rootReal = path.resolve(root);
    const prevFiles = (prevManifest && prevManifest.files) || {};

    const files = buildFilePlan({ fdeName, baseDomain, llmBaseUrl, allocations, root: rootReal, generation });

    ensureWorkspaceDirs(files);

    // 3) 逐文件原子写（内容不变则跳过，user-space §8.2）；记录最终 entries。
    // F6：用 lstat 判断（不跟随 symlink）——即使同内容，目标为 symlink 也强制走 atomicWriteFile，
    //    由 assertSafePath 拒绝（materialize_path_tampered），绝不静默保留 symlink。
    const entries = {};
    let contentChanged = false;
    for (const f of files) {
      const prev = prevFiles[f.containerPath];
      const newSha = sha256(f.content);
      let current = null;
      let isSymlink = false;
      try {
        const st = fs.lstatSync(f.hostPath);
        if (st.isSymbolicLink()) isSymlink = true;
        else current = readFileIfExists(f.hostPath);
      } catch {
        current = null;
      }
      const changed = isSymlink || current !== f.content;
      if (changed) contentChanged = true;
      const revision = changed ? (prev?.revision ?? 0) + 1 : (prev?.revision ?? 0);
      if (changed) {
        atomicWriteFile(f.hostPath, f.content, { mode: f.mode, root: rootReal });
      }
      entries[f.containerPath] = { sha256: newSha, revision };
    }

    // M2：stale-only 变更也算「变更」——本次实际会删除的 stale 文件数 > 0 时，materialized_at 必须更新。
    // 预扫描（不实际删除），保证「先备好新 manifest 再删除」的提交点顺序不被打乱。
    const desiredPaths = new Set(Object.keys(entries));
    const staleScan = collectStaleFiles(prevFiles, desiredPaths, rootReal, fdeName);
    const anyChanged = contentChanged || staleScan.candidates.length > 0;

    // F8：内容未变（且无 stale 删除）时沿用旧 manifest 的 materialized_at，保证同快照字节级相同（幂等）。
    const effectiveMaterializedAt = (!anyChanged && prevManifest?.materialized_at)
      ? prevManifest.materialized_at
      : materializedAt;

    // 4) 提交点（F5）：新 manifest 先写 tmp（不 rename）→ 删除 stale → 最后 rename manifest。
    //    先备好新 manifest 再删除，避免「删了 stale 才发现 manifest 写失败」破坏旧版本。
    const manifestPath = path.join(rootReal, fdeName, 'home', '.erix', 'manifest.json');
    const manifestContent = renderManifest({ fdeName, generation, entries, materializedAt: effectiveMaterializedAt });
    if (readFileIfExists(manifestPath) !== manifestContent) {
      const tmp = writeTempFile(manifestPath, manifestContent, { mode: MANIFEST_MODE, root: rootReal });
      try {
        removeStaleFiles(prevFiles, desiredPaths, rootReal, fdeName, log);
        // L5：commitTempFile 返回 false（rename 已提交但目录 fsync 失败）时按失败处理，不标记发布成功。
        if (!commitTempFile(tmp, manifestPath, { root: rootReal })) {
          throw new Error(`fsync directory failed after manifest rename: ${manifestPath}`);
        }
      } catch (err) {
        try {
          fs.unlinkSync(tmp);
        } catch {}
        throw err;
      }
    } else {
      removeStaleFiles(prevFiles, desiredPaths, rootReal, fdeName, log);
    }

    return { generation, manifest: manifestContent, files: entries };
  }

  return { materialize, ensureWorkspaceDirs };
}

/**
 * 平台管理路径的精确判定（不用「后缀猜」）：只认平台自己会生成的路径——
 * home/.erix 目录、home/AGENTS.md（精确）、projects/<project>/.gitignore（恰好在项目根）、
 * projects/<project>/.erix/*。用户自建的嵌套 .gitignore/AGENTS.md（如 projects/<project>/<repo>/.gitignore）不在此列。
 */
function isPlatformManagedPath(containerPath) {
  if (typeof containerPath !== 'string' || !containerPath.startsWith(`${CONTAINER_HOME}/`)) return false;
  const rel = containerPath.slice(CONTAINER_HOME.length + 1);
  if (rel === 'AGENTS.md') return true;
  if (rel.startsWith('.erix/')) return true;
  if (!rel.startsWith('projects/')) return false;
  const parts = rel.split('/');
  // projects/<project>/.gitignore（项目根，不含再往下的嵌套 repo 路径）
  if (parts.length === 3 && parts[2] === '.gitignore') return true;
  // projects/<project>/.erix/<file>
  if (parts.length === 4 && parts[2] === '.erix') return true;
  return false;
}

/**
 * 预扫描上一版 manifest 中需要删除的 stale 文件（不实际删除）。
 * 返回 { candidates: [{containerPath, hostPath}], skipped: [{containerPath, message}] }。
 * 与 removeStaleFiles 共用同一判定，保证「预判将被删」与「实际删除」一致。
 */
function collectStaleFiles(prevFiles, desiredContainerPaths, root, fdeName) {
  const rootReal = path.resolve(root);
  const fdeRoot = path.resolve(rootReal, fdeName);
  const candidates = [];
  const skipped = [];
  for (const containerPath of Object.keys(prevFiles)) {
    if (desiredContainerPaths.has(containerPath)) continue;
    try {
      // F1：删除路径来自磁盘 prevManifest，不可信——无论是否平台管理路径，先重新规范化 + assertSafePath，
      // 强制处于当前 FDE root 之内；任何逃逸 / 含 symlink 的可疑路径跳过并告警（不删、不 500）。
      const hostPath = path.resolve(hostPathFor(rootReal, fdeName, containerPath));
      const rel = path.relative(fdeRoot, hostPath);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`stale path escapes FDE root: ${containerPath}`);
      }
      assertSafePath(fdeRoot, hostPath);
      // 只清理「平台管理路径集合」中、且已不在本次 desired plan 的文件；其余一律不动（不告警，属用户自建文件）。
      if (!isPlatformManagedPath(containerPath)) continue;
      if (fs.existsSync(hostPath)) candidates.push({ containerPath, hostPath });
    } catch (e) {
      skipped.push({ containerPath, message: e.message });
    }
  }
  return { candidates, skipped };
}

function removeStaleFiles(prevFiles, desiredContainerPaths, root, fdeName, log) {
  const { candidates, skipped } = collectStaleFiles(prevFiles, desiredContainerPaths, root, fdeName);
  for (const s of skipped) {
    log.warn?.(`[materializer] skip stale file ${s.containerPath}: ${s.message}`);
  }
  let deleted = 0;
  for (const { containerPath, hostPath } of candidates) {
    try {
      fs.unlinkSync(hostPath);
      deleted += 1;
    } catch (e) {
      log.warn?.(`[materializer] skip stale file ${containerPath}: ${e.message}`);
    }
  }
  return deleted;
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
  // issue #183：awaiting_credential 也是「活」状态（容器/工作区已在，只是 Git 凭据待补），
  // 平台文件应照常物化——凭据待补不应阻塞 ~/.erix（否则 agent 每次 run 都 ENOENT config.json）。
  // 仅排除 disabled（offboarding 后不再物化）。
  const user = await pool.query(
    `SELECT id, fde_name FROM users WHERE id = $1 AND status IN ('active', 'awaiting_credential')`,
    [fdeId],
  );
  if (user.rows.length === 0) return null;
  const fdeName = user.rows[0].fde_name;
  // P5：FDE 级单一 ports.json——allocations 平铺（不再按项目分组；projects 表不再参与物化）。
  const allocs = await pool.query(
    `SELECT id, scope, port, role, run_id, url, exposure, state
       FROM port_allocations WHERE fde_id = $1 AND state <> 'released' ORDER BY port`,
    [fdeId],
  );
  return {
    fdeName,
    allocations: allocs.rows,
    llmBaseUrl: config.llmPublicBaseUrl,
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
        llmBaseUrl: state.llmBaseUrl,
        allocations: state.allocations,
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
    // issue #183：与 readFdeDesiredState 同口径——awaiting_credential 照常物化，disabled 跳过。
    `SELECT id, fde_name FROM users WHERE fde_name IS NOT NULL AND status IN ('active', 'awaiting_credential')`,
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
