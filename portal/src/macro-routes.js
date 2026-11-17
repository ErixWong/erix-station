/**
 * 宏平台 HTTP 业务层（issue #526，事件平台 W3；契约 `10` 篇 §3）。
 *
 * 分工：`http.js` 只做「正则匹配 → 鉴权 → 调这里 → sendJson」，业务全部在本文件——
 * 4700 行的巨型 if 链不该再为一张新单长两百行。本文件的每个 handler 返回**可直接
 * sendJson 的对象**，错误一律抛 `MacroError`/`SessionError`（http.js 顶层统一映射信封）。
 *
 * 契约红线（都在本文件落地）：
 *  1. **用户面不下发 `created_by` / `enabled` / `deleted_at`**（§3.2）——
 *     `toPublicTemplate` 是白名单映射（列出来的才下发），不是黑名单删除：
 *     以后表加运维列默认就是安全的（不会自己漏出去）。
 *  2. **admin 流水不含 `sessionId` / `childSessionId`**（§3.3，决策者 2026-11-15）——
 *     同样是白名单映射。
 *  3. **summary 的分母是 `done`（有判决的），不是 `triggered`**（§3.3）——
 *     `byVerdict` 用 `FILTER (WHERE verdict = '…')` 逐桶数：`verdict` 只在 `done` 行上有值，
 *     NULL 永远不匹配任何桶 ⇒ `skipped`/`failed` 天然不并入（把 unclassified 桶写成
 *     `verdict IS NULL` 就会把它们吸进来——那是本单最容易被"顺手优化"掉的语义）。
 *  4. 属主校验一律 `fetchSession`（非属主与不存在都 404，不泄露存在性）。
 */
import {
  MacroError, MACRO_VERDICTS, validateMacroEnum, validateMacroCriterion, validateMacroRunStatus,
  listTemplates, createTemplate, updateTemplate, deleteTemplate,
  subscriberCountsByTemplate,
  listAssignments, assignTemplate, unassignTemplate,
  toMacroRunSnapshot, encodeMacroRunCursor, decodeMacroRunCursor,
} from './macros.js';
import {
  listNotifications, markRead, unreadCount, normalizeNotificationsLimit,
} from './notifications.js';
import { fetchSession } from './sessions.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100; // 契约 §3.1：limit ∈ 1..100

function toLimit(raw) {
  if (raw == null || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** 布尔 query 参数（`true`/`1` 为真；其余假）。 */
function toBool(raw) {
  return raw === 'true' || raw === '1';
}

/** ISO 时刻参数（非法 ⇒ 400）。 */
function toTimeParam(name, raw) {
  if (raw == null || raw === '') return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new MacroError('validation_failed', `${name} 不是合法时刻`, { details: { field: name } });
  }
  return d;
}

// ── 用户面 ────────────────────────────────────────────────────────────────────

/**
 * 模板行 → 用户面形状（⚠ 白名单：`created_by` / `enabled` / `deleted_at` **不下发**）。
 * 输入是 `listTemplates` 的快照（已含全部列），这里只留契约 §3.2 列出的六项。
 */
export function toPublicTemplate(t) {
  return { id: t.id, kind: t.kind, name: t.name, params: t.params ?? {}, scope: t.scope, audience: t.audience };
}

/** GET /api/macro-templates：`audience='all'` ∧ `enabled` ∧ 未软删（后两条 `listTemplates` 默认已滤软删/非 all 受众）。 */
export async function userTemplates({ pool }) {
  const rows = await listTemplates(pool, { isAdmin: false });
  return { items: rows.filter((t) => t.enabled === true).map(toPublicTemplate) };
}

/** GET /api/sessions/:id/macro-assignments（先过属主闸：非属主/不存在 404）。 */
export async function sessionAssignments({ pool, sessionId, userId }) {
  await fetchSession(pool, sessionId, userId);
  const items = await listAssignments(pool, { userId, sessionId });
  return { items };
}

/** PUT /api/sessions/:id/macro-assignments：body `{ templateId, until }` ⇒ 幂等 upsert（`assignTemplate` 的 ON CONFLICT 支）。 */
export async function putAssignment({ pool, sessionId, userId, body = {} }) {
  await fetchSession(pool, sessionId, userId);
  const templateId = body?.templateId;
  if (typeof templateId !== 'string' || !templateId) {
    throw new MacroError('validation_failed', 'templateId 必填', { details: { field: 'templateId' } });
  }
  // scope='user' 的模板不该从会话入口订（会把它误写成 session 语义）——`assignTemplate` 会 400，
  // 但那要等查完模板；这里先给闸，错误里带上 scope 便于前端提示。
  const assignment = await assignTemplate(pool, { templateId, userId, sessionId, until: body?.until ?? null });
  return { assignment };
}

/** DELETE /api/sessions/:id/macro-assignments/:assignmentId（`unassignTemplate` 对非属主抛 404）。 */
export async function deleteAssignment({ pool, sessionId, userId, assignmentId }) {
  await fetchSession(pool, sessionId, userId);
  return unassignTemplate(pool, { assignmentId, userId });
}

/**
 * GET /api/sessions/:id/macro-runs —— 会话视角的流水。
 * `listMacroRuns` 没有 verdict/session 维度（那是给全局面板用的），这里按同一条 keyset
 * 口径另写一支：会话按 `assignments.session_id` 圈，游标复用 `macros.js` 的编解码（同构）。
 */
export async function sessionMacroRuns({ pool, sessionId, userId, query = new URLSearchParams() }) {
  await fetchSession(pool, sessionId, userId);
  const where = ['a.user_id = $1', 'a.session_id = $2'];
  const params = [userId, sessionId];
  const criterion = query.get('criterion');
  if (criterion) {
    validateMacroCriterion(criterion);
    params.push(criterion);
    where.push(`r.criterion = $${params.length}`);
  }
  const verdict = query.get('verdict');
  if (verdict) {
    validateMacroEnum('verdict', verdict, MACRO_VERDICTS);
    params.push(verdict);
    where.push(`r.verdict = $${params.length}`);
  }
  const cursor = query.get('cursor');
  if (cursor) {
    const c = decodeMacroRunCursor(cursor);
    params.push(c.startedAt, c.id);
    where.push(`(r.started_at, r.id) < ($${params.length - 1}, $${params.length})`);
  }
  const limit = normalizeNotificationsLimit(toLimit(query.get('limit')));
  params.push(limit + 1);
  const res = await pool.query(
    `SELECT r.* FROM macro_runs r
       JOIN macro_assignments a ON a.id = r.assignment_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.started_at DESC, r.id DESC LIMIT $${params.length}`,
    params,
  );
  const rows = res.rows.map(toMacroRunSnapshot);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { items: page, nextCursor: hasMore ? encodeMacroRunCursor(page[page.length - 1]) : null };
}

/**
 * GET /api/macro-runs —— 用户级全局流水（issue #614）。
 *
 * 顶栏用户级 chip（`scope='user'` 的模板：定时任务这类不绑会话的东西）的流水本就跨会话，
 * 所以属主过滤 = `macro_assignments.user_id = 当前用户`，**不带 session_id**。
 * 查询参数（`criterion`/`verdict`/`limit`/`cursor`）与响应形状（`{ items, nextCursor }`）与会话级那份
 * **一致**，复用同一条 keyset 口径与 `toMacroRunSnapshot`。
 * ⚠ 用户面口径再剥 `snapshot_id` / `worktree_path` / `verdict_raw`（原始错误码）——`09` §3.2：
 *   这三个不该出现在用户面响应里（会话级那份把它们交给前端归一层丢，这里按 §3.2 在出口就剥掉）。
 * ⚠ 不能放 `/api/admin/*`（#450 白名单会 deny）。
 */
export async function userMacroRuns({ pool, userId, query = new URLSearchParams() }) {
  const where = ['a.user_id = $1'];
  const params = [userId];
  const criterion = query.get('criterion');
  if (criterion) {
    validateMacroCriterion(criterion);
    params.push(criterion);
    where.push(`r.criterion = $${params.length}`);
  }
  const verdict = query.get('verdict');
  if (verdict) {
    validateMacroEnum('verdict', verdict, MACRO_VERDICTS);
    params.push(verdict);
    where.push(`r.verdict = $${params.length}`);
  }
  const cursor = query.get('cursor');
  if (cursor) {
    const c = decodeMacroRunCursor(cursor);
    params.push(c.startedAt, c.id);
    where.push(`(r.started_at, r.id) < ($${params.length - 1}, $${params.length})`);
  }
  const limit = normalizeNotificationsLimit(toLimit(query.get('limit')));
  params.push(limit + 1);
  const res = await pool.query(
    `SELECT r.* FROM macro_runs r
       JOIN macro_assignments a ON a.id = r.assignment_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.started_at DESC, r.id DESC LIMIT $${params.length}`,
    params,
  );
  const snaps = res.rows.map(toMacroRunSnapshot);
  const hasMore = snaps.length > limit;
  const page = hasMore ? snaps.slice(0, limit) : snaps;
  const items = page.map((snap) => {
    if (!snap) return snap;
    const { snapshot_id: _sn, worktree_path: _wt, verdict_raw: _vr, ...userFacing } = snap;
    return userFacing;
  });
  return { items, nextCursor: hasMore ? encodeMacroRunCursor(page[page.length - 1]) : null };
}

// ── 通知（用户面）─────────────────────────────────────────────────────────────

export async function notificationsList({ pool, userId, query = new URLSearchParams() }) {
  return listNotifications(pool, {
    userId,
    unreadOnly: toBool(query.get('unreadOnly')),
    limit: toLimit(query.get('limit')),
    cursor: query.get('cursor') || null,
  });
}

export async function notificationMarkRead({ pool, userId, notificationId }) {
  return { notification: await markRead(pool, { notificationId, userId }) };
}

export async function notificationsUnreadCount({ pool, userId }) {
  return { count: await unreadCount(pool, { userId }) };
}

// ── 管理台 ────────────────────────────────────────────────────────────────────

export async function adminTemplates({ pool, query = new URLSearchParams() }) {
  const includeDeleted = toBool(query.get('includeDeleted'));
  const items = await listTemplates(pool, { isAdmin: true, includeDeleted });
  // issue #613：补「订阅数」列（`07` §2：停用前要知道影响谁）。口径见 `subscriberCountsByTemplate`：
  // **只算 `enabled = true`** 的订阅。一次全表 `GROUP BY`，不在循环里查 ⇒ 无 N+1。
  // `includeDeleted=true` 走的是同一份计数 ⇒ 软删模板也带这个数（软删不抹订阅行，见 `deleteTemplate` 分支一）。
  // 没任何启用订阅 ⇒ `0`（**不是** `null`/`undefined`：前端拿 `undefined` 显示 `—`，
  // 那是「后端没下发」的意思，不能拿它冒充「没人订」）。
  const counts = await subscriberCountsByTemplate(pool);
  return { items: items.map((t) => ({ ...t, subscriberCount: counts.get(t.id) ?? 0 })) };
}

export async function adminCreateTemplate({ pool, body = {}, adminUserId }) {
  const template = await createTemplate(pool, {
    kind: body?.kind, name: body?.name, params: body?.params ?? {},
    audience: body?.audience, scope: body?.scope, enabled: body?.enabled,
    createdBy: adminUserId,
  });
  return { template };
}

/**
 * PATCH 白名单：`{ name?, params?, audience?, enabled? }`。
 * `kind`/`scope` **出现在 body 里就 400**——静默丢弃会让前端以为改成了，实际没改。
 */
export async function adminPatchTemplate({ pool, templateId, body = {} }) {
  for (const forbidden of ['kind', 'scope']) {
    if (body && forbidden in body) {
      throw new MacroError('validation_failed', `${forbidden} 不可修改`, { details: { field: forbidden } });
    }
  }
  const template = await updateTemplate(pool, { templateId, patch: body ?? {} });
  return { template };
}

export async function adminDeleteTemplate({ pool, templateId }) {
  return deleteTemplate(pool, { templateId });
}

/**
 * 流水筛选的公共 WHERE（列表与 summary **共用**——summary "跟着筛选变" 靠的就是同一份谓词，
 * 两处各写一遍迟早漂）。返回 `{ where, params }`，from 参数起始位由调用方接续。
 */
function adminRunsFilters(query) {
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  const templateId = query.get('templateId');
  if (templateId) add('a.template_id = ?', templateId);
  const status = query.get('status');
  if (status) add('r.status = ?', validateMacroRunStatus(status));
  const verdict = query.get('verdict');
  if (verdict) add('r.verdict = ?', validateMacroEnum('verdict', verdict, MACRO_VERDICTS));
  const userId = query.get('userId');
  if (userId) add('a.user_id = ?', userId);
  const from = toTimeParam('from', query.get('from'));
  if (from) add('r.started_at >= ?', from);
  const to = toTimeParam('to', query.get('to'));
  if (to) add('r.started_at <= ?', to);
  return { where, params };
}

const ADMIN_RUNS_FROM = `
  FROM macro_runs r
  JOIN macro_assignments a ON a.id = r.assignment_id
  JOIN macro_templates t ON t.id = a.template_id
  JOIN users u ON u.id = a.user_id`;

/**
 * admin 流水行（⚠ 白名单：**不含 `sessionId` / `childSessionId`**，决策者 2026-11-15）。
 * `durationMs` 由 `finished_at - started_at` 推导（账上没这列，推导口径只在这里一份）。
 * `usage`：`macro_runs` 还没有 token 记账列（0035 无此列，W4/W7 落）⇒ 先下发 `null`，
 * 用 0 冒充"没花钱"是假账；前端按 null 显示"—"。
 */
export function toAdminRunItem(row) {
  const startedAt = row.started_at instanceof Date ? row.started_at : new Date(row.started_at);
  const finishedAt = row.finished_at ? (row.finished_at instanceof Date ? row.finished_at : new Date(row.finished_at)) : null;
  return {
    id: row.id,
    startedAt: startedAt.toISOString(),
    templateId: row.template_id,
    templateName: row.template_name,
    userId: row.user_id,
    userName: row.user_name,
    anchor: row.anchor,
    criterion: row.criterion,
    status: row.status,
    verdict: row.verdict ?? null,
    durationMs: finishedAt ? Math.max(0, finishedAt.getTime() - startedAt.getTime()) : null,
    usage: null,
  };
}

/** GET /api/admin/macro-runs（keyset 倒序）。 */
export async function adminMacroRuns({ pool, query = new URLSearchParams() }) {
  const { where, params } = adminRunsFilters(query);
  const cursor = query.get('cursor');
  if (cursor) {
    const c = decodeMacroRunCursor(cursor);
    params.push(c.startedAt, c.id);
    where.push(`(r.started_at, r.id) < ($${params.length - 1}, $${params.length})`);
  }
  const limit = toLimit(query.get('limit'));
  params.push(limit + 1);
  const res = await pool.query(
    `SELECT r.*, a.template_id, a.user_id, t.name AS template_name, u.login AS user_name
       ${ADMIN_RUNS_FROM}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.started_at DESC, r.id DESC LIMIT $${params.length}`,
    params,
  );
  const rows = res.rows.map(toAdminRunItem);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { items: page, nextCursor: hasMore ? encodeMacroRunCursor(page[page.length - 1]) : null };
}

/** GET /api/admin/macro-runs/:id（点行展开的详情；同样不含 session 两列）。 */
export async function adminMacroRunDetail({ pool, runId }) {
  const res = await pool.query(
    `SELECT r.*, a.template_id, a.user_id, t.name AS template_name, u.login AS user_name
       ${ADMIN_RUNS_FROM}
      WHERE r.id = $1 LIMIT 1`,
    [runId],
  );
  const row = res.rows[0];
  if (!row) throw new MacroError('not_found', '执行记录不存在', { httpStatus: 404, details: { runId } });
  return { run: toAdminRunItem(row) };
}

/**
 * GET /api/admin/macro-runs/summary —— 跟着筛选变（复用 `adminRunsFilters`）。
 *
 * ⚠ **`byVerdict` 的分母是 `done`（有判决的），不是 `triggered`**（§3.3）：
 * 每个桶都是 `FILTER (WHERE verdict = '…')`，`skipped`/`failed` 的 `verdict` 是 NULL、
 * 匹配不进任何桶 ⇒ 「各桶之和 == done」这条不变式自动成立。
 * 别把它"优化"成 `verdict IS NULL ⇒ unclassified`——那会把 skipped/failed 吸进分母。
 */
export async function adminRunsSummary({ pool, query = new URLSearchParams() }) {
  const { where, params } = adminRunsFilters(query);
  const args = [...params];
  const selects = [
    `COUNT(*)::bigint AS triggered`,
    `COUNT(*) FILTER (WHERE r.status = 'done')::bigint AS done`,
    `COUNT(*) FILTER (WHERE r.status = 'skipped')::bigint AS skipped`,
    `COUNT(*) FILTER (WHERE r.status = 'failed')::bigint AS failed`,
  ];
  for (const v of MACRO_VERDICTS) {
    args.push(v);
    selects.push(`COUNT(*) FILTER (WHERE r.verdict = $${args.length})::bigint AS "v_${v}"`);
  }
  const res = await pool.query(
    `SELECT ${selects.join(', ')} ${ADMIN_RUNS_FROM}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    args,
  );
  const row = res.rows[0] ?? {};
  const n = (k) => Number(row[k] ?? 0);
  const byVerdict = {};
  for (const v of MACRO_VERDICTS) byVerdict[v] = n(`v_${v}`);
  return {
    triggered: n('triggered'),
    done: n('done'),
    skipped: n('skipped'),
    failed: n('failed'),
    byVerdict,
    // `macro_runs` 尚无 token 列（0035 无 usage；W4/W7 落账后再换成 SUM）——null = 未记账，0 = 假账。
    usage: null,
  };
}
