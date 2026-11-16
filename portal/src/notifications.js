/**
 * 通知读写层（issue #526，事件平台 W3；契约 `docs/design/event-platform/10-implementation-contract.md` §3/§4）。
 *
 * 职责边界：这里只管 `notifications` 表（0036）——创建、列表（keyset）、已读、未读数、
 * 意图投递（消费 W2 的到期意图，`10` 篇 §4 第 3 条）。HTTP 形状在 `macro-routes.js`，
 * 错误信封沿用站内形状（复用 `macros.js` 的 `MacroError`：带 `code/httpStatus/details`，
 * http.js 一处映射，零新错误类型）。
 *
 * 两条契约红线（都在这个文件落地，路由层不再判）：
 *  1. **severity 由「收件人 + 结果」推导，不由动作类型推导**（§3.4）：
 *     投递成功且收件人含该用户 ⇒ `info`；投递失败且收件人含该用户 ⇒ `error`；
 *     收件人只有管理员 ⇒ **不写 notifications 行**（只进执行历史）。
 *     ——所以 `deliverIntent` 的入参是收件人清单 + 成败，而不是动作类型。
 *  2. 时间字段应用侧写（AGENTS.md §3.4：DDL 无 DEFAULT CURRENT_TIMESTAMP）：
 *     `created_at` / `read_at` 都由本文件带 `now` 写入，同一个调用内共用一个时刻。
 *
 * keyset 分页口径与 `macros.js` 的 macro-runs 游标同款：`base64url(JSON({t: ISO, i: id}))`，
 * 按 `(created_at, id)` 全序倒排——OFFSET 在边翻页边写入时会重/漏行，通知列表正是这种形状。
 */
import crypto from 'node:crypto';

import { MacroError, toInstant } from './macros.js';

export const NOTIFICATIONS_DEFAULT_LIMIT = 50;
export const NOTIFICATIONS_MAX_LIMIT = 100; // 契约 §3.1：limit ∈ 1..100
export const NOTIFICATION_SEVERITIES = Object.freeze(['info', 'error']);

/** 站内短字符串 id：32 位 hex（`crypto.randomBytes(16)`），恰好铺满 VARCHAR(32)、单层无分段。 */
export function newId() {
  return crypto.randomBytes(16).toString('hex');
}

/** 通知行 → 用户面形状。⚠ 契约没有要求隐藏的列这里也不发明：id/严重度/正文/读态/时刻。 */
export function toNotificationSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    severity: row.severity,
    title: row.title,
    body: row.body ?? '',
    read_at: row.read_at ?? null,
    created_at: row.created_at,
  };
}

/** 通知游标：与 macro-runs 游标同构，但键是 `(created_at, id)`。 */
export function encodeNotificationCursor(row) {
  if (!row) return null;
  const t = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  return Buffer.from(JSON.stringify({ t, i: row.id }), 'utf8').toString('base64url');
}

export function decodeNotificationCursor(cursor) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw new MacroError('validation_failed', 'cursor 无法解析', { details: { field: 'cursor' } });
  }
  const at = toInstant('cursor.t', parsed?.t);
  if (!at || typeof parsed.i !== 'string') {
    throw new MacroError('validation_failed', 'cursor 形状非法', { details: { field: 'cursor' } });
  }
  return { createdAt: at, id: parsed.i };
}

export function normalizeNotificationsLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) return NOTIFICATIONS_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), NOTIFICATIONS_MAX_LIMIT);
}

/**
 * 写一条通知。`createdAt` 可注入（测试/重放用同一时钟）；`macroRunId` 可空——
 * 通知是用户资产，执行账被清（SET NULL）也不能带走它（0036 文件头）。
 */
export async function createNotification(pool, {
  userId, macroRunId = null, severity = 'info', title, body = '', createdAt = new Date(),
} = {}) {
  if (!NOTIFICATION_SEVERITIES.includes(severity)) {
    throw new MacroError('validation_failed', 'severity 非法', { details: { field: 'severity', allowed: NOTIFICATION_SEVERITIES } });
  }
  const safeTitle = typeof title === 'string' && title.trim() !== '' ? title.trim() : null;
  if (!safeTitle) throw new MacroError('validation_failed', 'title 不能为空', { details: { field: 'title' } });
  const at = toInstant('createdAt', createdAt) ?? new Date();
  const res = await pool.query(
    `INSERT INTO notifications (id, user_id, macro_run_id, severity, title, body, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [newId(), userId, macroRunId, severity, safeTitle, body ?? '', at],
  );
  return toNotificationSnapshot(res.rows[0]);
}

/**
 * 列表（keyset 倒序）。`unreadOnly=true` 只扫未读部分（0036 的部分索引就是为它建的）。
 * 返回 `{ items, nextCursor }`——契约 §3.1 的响应形状在这一层就成形。
 */
export async function listNotifications(pool, {
  userId, unreadOnly = false, limit = NOTIFICATIONS_DEFAULT_LIMIT, cursor = null,
} = {}) {
  const where = ['user_id = $1'];
  const params = [userId];
  if (unreadOnly) where.push('read_at IS NULL');
  if (cursor) {
    const c = decodeNotificationCursor(cursor);
    params.push(c.createdAt, c.id);
    // 行值比较与 `ORDER BY created_at DESC, id DESC` 同序；(created_at,id) 是全序 ⇒ 不重不漏。
    where.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
  }
  const safeLimit = normalizeNotificationsLimit(limit);
  params.push(safeLimit + 1);
  const res = await pool.query(
    `SELECT * FROM notifications WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const rows = res.rows.map(toNotificationSnapshot);
  const hasMore = rows.length > safeLimit;
  const page = hasMore ? rows.slice(0, safeLimit) : rows;
  return { items: page, nextCursor: hasMore ? encodeNotificationCursor(page[page.length - 1]) : null };
}

/**
 * 标记已读。**非属主与不存在一律 404**（不泄露存在性，口径同 `fetchSession`）。
 * 幂等：已读过的再点一次返回既有 `read_at`，不报错、也不刷新时刻（「已读」是事件不是时长）。
 */
export async function markRead(pool, { notificationId, userId, now = new Date() } = {}) {
  const at = toInstant('now', now) ?? new Date();
  const upd = await pool.query(
    `UPDATE notifications SET read_at = $3
      WHERE id = $1 AND user_id = $2 AND read_at IS NULL
      RETURNING *`,
    [notificationId, userId, at],
  );
  if (upd.rows[0]) return toNotificationSnapshot(upd.rows[0]);
  const own = await pool.query(
    'SELECT * FROM notifications WHERE id = $1 AND user_id = $2 LIMIT 1',
    [notificationId, userId],
  );
  if (!own.rows[0]) {
    throw new MacroError('not_found', '通知不存在', { httpStatus: 404, details: { notificationId } });
  }
  return toNotificationSnapshot(own.rows[0]);
}

/** 未读数（铃铛角标）。与 `markRead` 共用 `read_at IS NULL` 这一个谓词——一致性靠同源。 */
export async function unreadCount(pool, { userId } = {}) {
  const res = await pool.query(
    'SELECT COUNT(*)::bigint AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * **投递一条意图**（消费 W2 `macro-eval.js` 的意图，`10` 篇 §4 第 3 条；到期意图的
 * 账 W2 已 claim，这里只补「人」这一侧，不再碰 `macro_runs`）。
 *
 * severity 推导（红线，§3.4）：**收件人 + 结果**，与动作类型无关——
 *   - `recipients` 为空（收件人只有管理员）⇒ **一行都不写**，返回 `{ wrote: 0 }`；
 *   - 否则每个收件人一行，`success ? 'info' : 'error'`。
 * 为什么不由 kind 推导：同一个 kind 对管理员是运维噪音、对当事用户可能是事故；
 * 类型说不清「谁该紧张」，收件人 × 成败才说清。
 */
export async function deliverIntent(pool, intent, {
  recipients = [], success = true, title = null, body = null, now = new Date(),
} = {}) {
  const list = [...new Set(recipients.filter(Boolean))];
  if (list.length === 0) return { wrote: 0, severity: null, notifications: [] };
  const severity = success ? 'info' : 'error';
  const safeTitle = title ?? `宏「${intent?.templateName ?? '?'}」${success ? '已完成' : '执行失败'}`;
  const safeBody = body ?? '';
  const rows = [];
  for (const userId of list) {
    rows.push(await createNotification(pool, {
      userId,
      macroRunId: intent?.macroRunId ?? null,
      severity,
      title: safeTitle,
      body: safeBody,
      createdAt: now,
    }));
  }
  return { wrote: rows.length, severity, notifications: rows };
}
