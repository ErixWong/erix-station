// issue #727：管理台按 FDE 只读浏览「会话记录 + 项目文件」（7
// 个只读端点的数据层入口）。
//
// 为什么能零复制复用工作台代码：`sessions.js` / `dirs.js`
// 的属主校验**入参是 userId**，
// 不是登录态——管理台把「目标 FDE 的 id」当 userId 传进去，
// 得到的就是同一套校验与同一份
// DTO。只有下面三件事是管理台独有的，
// 因此单独成模块而不是往数据层里塞：
//   ① 目标用户解析（按 fde_name，**不限 status**：
//   停用用户的文件仍要能看）；
//   ② 审计（每个端点恰好一行，见「审计去重」）；
//   ③ 已归档会话可读（`include_archived=1`，缺省关 ⇒
//   工作台行为逐字节不变）。
//
// 红线：
//   · 只读：本模块没有任何写路径（归档 / 删除 / 改名都不在这里）；
//   · 「不属于该 FDE」与「不存在」一律同一个 404
//   `not_found`（不泄露存在性，
//     复用 `fetchSession` 既有语义，不新造错误码）；
//   · 审计写失败只 warn，不阻断响应（它是台账不是事务参与者）。

import * as admin from './admin.js';
import * as dirs from './dirs.js';
import * as queuedInputs from './queued-inputs.js';
import * as sessions from './sessions.js';

/** query 开关的统一口径：只认 `1` / `true`（与工作台既有布尔参数一致，
 * 不把 `?x=0` 读成真）。 */
function isOn(value) {
  return value === '1' || value === 'true';
}

/**
 * 按 `fde_name` 解析目标用户（**不限 `status`**：停用/离职 FDE
 * 的历史记录与文件仍是可读对象，
 * 这是本单与 `portalloc.resolveFdeByName`（只认 active）唯一的差别）。
 * 查不到 ⇒ 与 `http.js` 的 `resolveAdminFde` 同码同文案（同一个 404 形状，
 * 不新造码）。
 */
export async function resolveTargetFde(pool, fdeName) {
  const res = await pool.query(
    `SELECT id, fde_name, status FROM users WHERE fde_name = $1`,
    [fdeName],
  );
  const row = res.rows?.[0];
  if (!row || !row.id) {
    throw new admin.AdminError('not_found', `FDE「${fdeName}」不存在`, {
      httpStatus: 404,
      details: { field: 'fde_name' },
      en: `FDE "${fdeName}" does not exist`,
    });
  }
  return row;
}

/** 会话不存在 / 不属该 FDE 的统一 404（与 `fetchSession` 的文案逐字相同）
 * 。 */
function sessionNotFound() {
  return new admin.AdminError('not_found', 'session not found', { httpStatus: 404 });
}

/**
 * 审计去重（成本红线）：
 * 文件类读取会被前端反复触发（树展开、预览来回点、Range 分段拉同一个
 * 文件），每次都写一行会把台账刷成噪音。键 = `actorId|fdeName|path|mode`，
 * 窗口 5 分钟：
 * 窗口内**第二次及以后**不再写。会话/目录类不做去重（一次导航一行，
 * 本来就是想要的信息）。
 */
const AUDIT_DEDUP_WINDOW_MS = 5 * 60 * 1000;
const auditDedup = new Map();
/** 去重表的体积上限：超过就扫一遍扫掉过期项（见 `evictAuditDedup`）。 */
const AUDIT_DEDUP_MAX = 5000;

/** 单测用：清空去重表（模块级 Map 在测试进程里会跨用例残留）。 */
export function resetAuditDedupForTest() {
  auditDedup.clear();
}

/**
 * 体积兼底（**不是 LRU**）：这张表的键含 `path`，理论上可以被「扫一个干万个文件的目录」
 * 无上限地堆下去，而它只服务 5 分钟窗口。所以：超上限先清所有**已过期**项；清完还超限
 * 就整体 `clear()`（宁可少去重几行，也不让一个只读面把内存当自由存储）。
 */
function evictAuditDedup(now) {
  if (auditDedup.size <= AUDIT_DEDUP_MAX) return;
  for (const [key, ts] of auditDedup) {
    if (now - ts >= AUDIT_DEDUP_WINDOW_MS) auditDedup.delete(key);
  }
  if (auditDedup.size > AUDIT_DEDUP_MAX) auditDedup.clear();
}

/**
 * 写一行管理台审计。`dedupKey` 给了才走去重；写失败只 warn——
 * `recordAdminAudit` 自己 catch 了异步失败，这里 catch 的是**同步抛出**（fake
 * pool 常这样）。
 */
async function writeAudit({
  pool, actorId, action, target, details, log = console, dedupKey = null,
} = {}) {
  if (dedupKey != null) {
    const now = Date.now();
    const last = auditDedup.get(dedupKey);
    if (last != null && now - last < AUDIT_DEDUP_WINDOW_MS) return;
    evictAuditDedup(now);
    auditDedup.set(dedupKey, now);
  }
  try {
    await admin.recordAdminAudit(pool, actorId, action, target, details);
  } catch (err) {
    const msg = err?.message ?? String(err);
    (log ?? console).warn?.(`[admin-seat-content] 审计写入失败已忽略 ${action}: ${msg}`);
  }
}

/** GET /api/admin/fdes/:fdeName/dirs → 同 `/api/dirs` 的形状（目标 FDE 的 `~/projects`
 * 一级目录）。 */
export async function listFdeDirs({ pool, ctx, fdeName, actorId, log = console } = {}) {
  const fde = await resolveTargetFde(pool, fdeName);
  const result = await dirs.listDirs(pool, {
    userId: fde.id,
    userSpaceRoot: ctx.config.userSpaceRoot,
    fdeName,
    log,
  });
  await writeAudit({
    pool, actorId, log,
    action: 'admin.fde_dirs_listed',
    target: fdeName,
    details: { fde_name: fdeName, item_count: result.dirs.length },
  });
  return result;
}

/** GET /api/admin/fdes/:fdeName/sessions → 同 `/api/sessions` 形状 + `include_archived` /
 * `q`。 */
export async function listFdeSessions(
  { pool, ctx, fdeName, actorId, query, log = console } = {},
) {
  const fde = await resolveTargetFde(pool, fdeName);
  const cwd = query?.get('cwd') || null;
  const cursor = query?.get('cursor') || null;
  const limit = query?.get('limit') || undefined;
  const q = query?.get('q') || null;
  const includeArchived = isOn(query?.get('include_archived'));
  const result = await sessions.listSessions(pool, {
    userId: fde.id, cwd, cursor, limit, includeArchived, q,
  });
  await writeAudit({
    pool, actorId, log,
    action: 'admin.fde_sessions_listed',
    target: fdeName,
    details: {
      fde_name: fdeName,
      item_count: result.items.length,
      cwd: cwd ?? null,
      include_archived: includeArchived,
    },
  });
  return result;
}

/**
 * GET /api/admin/fdes/:fdeName/sessions/:sessionId → 同 `/api/sessions/:id` 形状。
 * `queued_messages` 的补法照 `http.js` 的 `handleGetSession`（含 catch 兜底成空队列）
 * ：
 * 它是补齐面，不许把整个详情拖成 5xx。
 */
export async function getFdeSession(
  { pool, ctx, fdeName, actorId, sessionId, query, log = console } = {},
) {
  const fde = await resolveTargetFde(pool, fdeName);
  const includeArchived = isOn(query?.get('include_archived'));
  const result = await sessions.getSession(pool, {
    userId: fde.id,
    sessionId,
    limit: query?.get('limit') || undefined,
    messagesCursor: query?.get('cursor'),
    includeArchived,
  });
  try {
    result.session.queued_messages = await queuedInputs.snapshotQueuedInputs(pool, sessionId);
  } catch {
    result.session.queued_messages = { steering: [], follow_up: [] };
  }
  await writeAudit({
    pool, actorId, log,
    action: 'admin.fde_session_read',
    target: fdeName,
    details: { fde_name: fdeName, session_id: sessionId },
  });
  return result;
}

/**
 * GET /api/admin/fdes/:fdeName/sessions/:sessionId/events/history
 * → 同用户面 `/api/sessions/:id/events/history`（`limit` / `before` 分页 + 合成
 * `partial_output` / `run_termination` + `next_cursor` 口径全部同源）。
 * 差别只有两处：属主谓词换成**目标** FDE 的 id，以及 `include_archived=1`
 * 时放开 active。
 * 合成项的四个助手在 `http.js` 里（不在这里复制）：
 * 那里是它们的唯一实现处。
 */
export async function getFdeSessionHistory(
  { pool, ctx, fdeName, actorId, sessionId, query, log = console } = {},
) {
  const http = await import('./http.js');
  const fde = await resolveTargetFde(pool, fdeName);
  const includeArchived = isOn(query?.get('include_archived'));
  const own = await pool.query(
    `SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2`
      + (includeArchived ? `` : ` AND status = 'active'`),
    [sessionId, fde.id],
  );
  if (!own.rows?.length) throw sessionNotFound();

  let limit = Number(query?.get('limit') ?? http.HISTORY_EVENT_DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new admin.AdminError('validation_failed', 'limit 必须为正整数', {
      httpStatus: 400, details: { field: 'limit' }, en: 'limit must be a positive integer',
    });
  }
  limit = Math.min(limit, http.HISTORY_EVENT_MAX_LIMIT);
  const beforeRaw = query?.get('before');
  let before = null;
  if (beforeRaw != null && beforeRaw !== '') {
    before = Number(beforeRaw);
    if (!Number.isInteger(before) || before < 1) {
      throw new admin.AdminError('validation_failed', 'before 必须为正整数', {
        httpStatus: 400, details: { field: 'before' }, en: 'before must be a positive integer',
      });
    }
  }

  const params = [sessionId, [...http.HISTORY_EVENT_TYPES]];
  let where = 'session_id = $1 AND type = ANY($2)';
  if (before != null) {
    params.push(before);
    where += ` AND seq < $${params.length}`;
  }
  params.push(limit + 1); // 多取 1 条判 hasOlder（§1.3 keyset 口径，对齐用户面）
  const r = await pool.query(
    `SELECT seq, run_id, type, payload FROM run_events WHERE ${where}`
      + ` ORDER BY seq DESC LIMIT $${params.length}`,
    params,
  );
  const hasOlder = r.rows.length > limit;
  const rows = r.rows.slice(0, limit).reverse(); // 升序返回
  const events = rows.map((row) => ({
    seq: Number(row.seq),
    run_id: row.run_id ?? null,
    type: row.type,
    payload: http.truncateHistoryPayload(row.payload ?? {}),
  }));
  const pageLow = rows.length > 0 ? Number(rows[0].seq) : 0;
  const synth = await http.buildHistorySynthItems(pool, rows, {
    before, sessionId, pageLow, limit,
  });
  const whitelistCursor = hasOlder && rows.length > 0 ? pageLow : null;
  // 空页游标由候选发现行驱动（#514 返修口径，与用户面逐字同判据）：
  // 空页不等于到底。
  const minDiscoveredSeq = synth.discovery.minSeq;
  const tailCursor = rows.length === 0 && synth.discovery.truncated
    && Number.isSafeInteger(minDiscoveredSeq) && minDiscoveredSeq >= 1
    && (before == null || minDiscoveredSeq < before)
    ? minDiscoveredSeq
    : null;
  await writeAudit({
    pool, actorId, log,
    action: 'admin.fde_session_read',
    target: fdeName,
    details: { fde_name: fdeName, session_id: sessionId },
  });
  return {
    events: http.mergeSynthItemsBySeq(events, synth.items),
    next_cursor: whitelistCursor ?? tailCursor,
  };
}

/** GET /api/admin/fdes/:fdeName/sessions/:sessionId/folded/:round → 同用户面 folded
 * 形状。 */
export async function getFdeFolded(
  { pool, ctx, fdeName, actorId, sessionId, round, query, log = console } = {},
) {
  const fde = await resolveTargetFde(pool, fdeName);
  const result = await sessions.getFoldedPayload(pool, {
    userId: fde.id,
    sessionId,
    round,
    log,
    includeArchived: isOn(query?.get('include_archived')),
  });
  await writeAudit({
    pool, actorId, log,
    action: 'admin.fde_folded_read',
    target: fdeName,
    details: { fde_name: fdeName, session_id: sessionId, round: Number(round) },
  });
  return result;
}

/**
 * GET /api/admin/fdes/:fdeName/files/tree?path=&after=&limit=
 * → `{ entries, truncated, next_after }`（根 = 目标 FDE 的 `~/projects`，`.git`
 * 目录不进树）。
 */
export async function getFdeFileTree(
  { pool, ctx, fdeName, actorId, query, log = console } = {},
) {
  const fde = await resolveTargetFde(pool, fdeName);
  const relPath = query?.get('path') ?? '.';
  const result = await dirs.fileTreeUnderProjects({
    userSpaceRoot: ctx.config.userSpaceRoot,
    fdeName,
    relPath,
    after: query?.get('after') ?? null,
    limit: query?.get('limit') ?? 500,
  });
  await writeAudit({
    pool, actorId, log,
    action: 'admin.fde_files_tree',
    target: fdeName,
    dedupKey: `${actorId}|${fdeName}|${relPath}|tree`,
    details: { fde_name: fdeName, path: relPath, item_count: result.entries.length },
  });
  return result;
}

/**
 * GET /api/admin/fdes/:fdeName/file?path=&mode=json|stream|download
 * → 同用户面 `/api/file`：`json` 回 `{ name, path, kind, data }`，`stream`/`download`
 * 回 `openFileStream` 的 DTO（`status` + `headers` + `stream`，由 http 层原样写出）。
 * 牢笼走 `rootKind: 'projects'`（根 = `~/projects`），
 * 预览/流式实现**没有第二份**。
 */
export async function getFdeFile(
  { pool, ctx, fdeName, actorId, query, range = null, log = console } = {},
) {
  const fde = await resolveTargetFde(pool, fdeName);
  const relPath = query?.get('path');
  const modeRaw = query?.get('mode') ?? '';
  // 与用户面 `handleFilePreview` 同一口径：`''` / `json` 之外只认 `stream` / `download`，
  // 其余 ⇒ 400。静默当 json 会把拼错的 `mode` 读成「预览成功」（复审 MINOR 2）。
  if (modeRaw !== '' && modeRaw !== 'json' && modeRaw !== 'stream' && modeRaw !== 'download') {
    throw new admin.AdminError('validation_failed', 'mode 只支持 json|stream|download', {
      httpStatus: 400, details: { field: 'mode' }, en: 'mode only supports json|stream|download',
    });
  }
  const mode = modeRaw === '' ? 'json' : modeRaw;
  const base = {
    userSpaceRoot: ctx.config.userSpaceRoot,
    fdeName,
    relPath,
    rootKind: 'projects',
  };
  const result = mode === 'json'
    ? await dirs.readFilePreview(base)
    : await dirs.openFileStream({
      ...base,
      range,
      disposition: mode === 'download' ? 'download' : 'inline',
    });
  await writeAudit({
    pool, actorId, log,
    action: 'admin.fde_file_read',
    target: fdeName,
    dedupKey: `${actorId}|${fdeName}|${relPath}|${mode}`,
    details: { fde_name: fdeName, path: relPath ?? null, mode },
  });
  return result;
}
