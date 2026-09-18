// 写操作幂等（portal.md §1.4 / §4.3）：POST 端点可选 `Idempotency-Key` 请求头，
// 同 (user_id, endpoint, key) 重复提交返回**首次结果**（不产生第二次副作用，如第二条 user 消息/第二个 run）。
//
// 依据与口径：
//   - portal.md §1.4（写操作幂等）与 §4.3（POST .../messages 支持 Idempotency-Key）。
//   - 表：`idempotency_keys`（**仅由**增量迁移 deploy/migrations/0001-idempotency-keys.sql 提供；
//     baseline docs/data/schema.sql 自 P1 冻结、不改动，见 deploy/migrations/README.md）。
//   - 流程（**先占位后执行**，F1 裁决：消除「先执行后记账」的双执行窗口）：
//     ① `state='done'` 且未过期（TTL 24h）→ 回放首次结果（不执行 fn，不产生第二次副作用）；
//     ② 否则**先占位**（`INSERT ... state='in_progress' ON CONFLICT DO NOTHING` 语义）——
//        并发同 key 只有一个请求能占到（其余 0 行），故**fn 至多执行一次**；
//     ③ 占到占位 → 执行 fn() → `UPDATE` 本行 `state='done'` + status_code/response → 返回；
//        fn() 抛错 → `DELETE` 占位行后原样 rethrow（释放 key，客户端可重试；不把瞬时错误钉成永久结果）；
//     ④ 占位 0 行（并发竞争/残留）→ 读现有行判定：
//        - `done` 且未过期 → 回放（request_hash 不一致 → 409 idempotency_key_reuse）；
//        - `done` 但已过期 → 视同不存在，重试占位（原子覆盖过期行）；
//        - `in_progress` 且 < IDEMPOTENCY_IN_PROGRESS_STALE_MINUTES（5 分钟）→ 409 idempotency_conflict
//          （retryable: true，先到先得；**输者不执行 fn**）；
//        - `in_progress` 且 ≥ 5 分钟（持有者崩溃残留）→ 视同可覆盖：UPDATE 抢回为本次 in_progress 后执行 fn。
//   - TTL 24h：命中判定带 `created_at > now() - interval '24 hours'`；过期行语义上等同不存在
//     （由占位语句的 `ON CONFLICT ... DO UPDATE ... WHERE 过期` 原子覆盖），
//     并另由 reaper 低频调用 `purgeExpired` 物理清理（portal/src/internal.js startReaperLoop）。
//   - key 为 null（无头 / 空串）→ 无幂等语义，直接执行 fn()。
//
// 注意：本模块刻意不 import internal.js（internal.js 反向 import 本模块的 purgeExpired，避免循环依赖），
//   故自带一份稳定的序列化 `stableStringify`（仅用于本表内的 hash 相等判定，不跨模块共享语义）。

import crypto from 'node:crypto';

/** 幂等记录有效期（小时）。过期记录不参与命中，由 purgeExpired 物理清理。 */
export const IDEMPOTENCY_TTL_HOURS = 24;

/** Idempotency-Key 长度上限（超出 → 400 validation_failed）。 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * `in_progress` 占位行的上限（分钟）：超过即视为**持有者崩溃残留**（stale），允许后续请求抢回覆盖。
 * 语义：小于该窗口的同 key 并发请求 → 409 `idempotency_conflict`（retryable，先到先得）；
 * 大于该窗口 → 视为可覆盖（否则一次进程崩溃会把该 key 永久钉死 409）。
 */
export const IDEMPOTENCY_IN_PROGRESS_STALE_MINUTES = 5;

/** 占位失败（并发竞争/残留刚被接管）时的重试上限——每次重试都是一次并发收敛尝试，超出即 409 conflict。 */
const MAX_CLAIM_ATTEMPTS = 3;

/** 幂等层错误（http.js 映射为标准错误信封：{code, message, retryable, details}）。 */
export class IdempotencyError extends Error {
  constructor(code, message, { httpStatus = 400, retryable = false, details } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.details = details;
  }
}

/**
 * 规范化 Idempotency-Key 请求头：
 *   - undefined / null / 空串（含纯空白）→ null（无幂等语义，调用方直通）；
 *   - 非字符串、长度 > 128、含控制字符（含 CR/LF 头部注入残留）→ 抛 400 validation_failed。
 * 返回值为去空白后的 key（node http 已剥离头值两侧 OWS，这里再兜底一次）。
 *
 * 控制字符检查用**原始值**（trim 之前，F6 裁决）：`"abc\n"` / `" abc\u0000"` 这类只在两侧带控制
 * 字符的输入也必须拒绝——否则会被 trim 洗成合法 key（"abc"），与「头注入残留一律拒绝」的口径不符。
 */
export function normalizeKey(headerValue) {
  if (headerValue === undefined || headerValue === null) return null;
  if (typeof headerValue !== 'string') {
    throw new IdempotencyError('validation_failed', 'Idempotency-Key 必须为字符串', {
      details: { field: 'Idempotency-Key' },
    });
  }
  // 控制字符（U+0000–U+001F、U+007F）：头注入/不可见字符一律拒绝（含两侧，先于 trim 判定）。
  if (/[\u0000-\u001f\u007f]/.test(headerValue)) {
    throw new IdempotencyError('validation_failed', 'Idempotency-Key 含非法控制字符', {
      details: { field: 'Idempotency-Key' },
    });
  }
  const key = headerValue.trim();
  if (key === '') return null;
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new IdempotencyError('validation_failed', `Idempotency-Key 长度超过上限 ${MAX_IDEMPOTENCY_KEY_LENGTH}`, {
      details: { field: 'Idempotency-Key' },
    });
  }
  return key;
}

/** 稳定序列化（对象键递归排序）——键序不同的等价请求体得到同一 hash。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * 规范化请求体的 sha256（十六进制）。
 * 只取幂等语义相关的字段：content + attachments（其余字段变化不改变业务载荷，
 * 例如后续可能新增的 UI 提示字段不应导致 409 idempotency_key_reuse）。
 * attachments 元素**裁剪**为实际消费的 `{kind, path, name?}` 子集（F3 / reviewer M-7）：
 * 调用方多送的 UI 字段（如 size/preview_url）不参与 hash，避免同一业务载荷被判成不同载荷。
 * 注：调用方（http.js handlePostMessage）已在幂等包装**之前**做请求体校验，故这里只做规范化兜底。
 */
export function requestHash(body) {
  const attachments = Array.isArray(body?.attachments)
    ? body.attachments.map((a) => {
      if (!a || typeof a !== 'object') return a;
      return a.name === undefined
        ? { kind: a.kind ?? null, path: a.path ?? null }
        : { kind: a.kind ?? null, path: a.path ?? null, name: a.name };
    })
    : [];
  const normalized = {
    content: typeof body?.content === 'string' ? body.content : '',
    attachments,
  };
  return crypto.createHash('sha256').update(stableStringify(normalized)).digest('hex');
}

/** 已完成的命中行（`state='done'` 且未过期，TTL 24h）——占位行不是结果，一律不命中。 */
async function findDone(pool, { userId, endpoint, key }) {
  const res = await pool.query(
    `SELECT request_hash, status_code, response, created_at
       FROM idempotency_keys
      WHERE user_id = $1 AND endpoint = $2 AND key = $3
        AND state = 'done'
        AND created_at > now() - interval '${IDEMPOTENCY_TTL_HOURS} hours'`,
    [userId, endpoint, key],
  );
  return res.rows?.[0] ?? null;
}

/** 读该 key 的**任意**现有行（含 state/created_at），用于占位失败后的判定。 */
async function findRow(pool, { userId, endpoint, key }) {
  const res = await pool.query(
    `SELECT request_hash, state, status_code, response, created_at
       FROM idempotency_keys
      WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
    [userId, endpoint, key],
  );
  return res.rows?.[0] ?? null;
}

/** 行是否仍新鲜（TTL 24h 内）。 */
function isFresh(row, now = Date.now()) {
  const t = row?.created_at instanceof Date ? row.created_at.getTime() : new Date(row?.created_at ?? 0).getTime();
  return t > now - IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000;
}

/** 是否超过 in_progress 占位上限（持有者崩溃残留）。 */
function isStaleInProgress(row, now = Date.now()) {
  const t = row?.created_at instanceof Date ? row.created_at.getTime() : new Date(row?.created_at ?? 0).getTime();
  return t <= now - IDEMPOTENCY_IN_PROGRESS_STALE_MINUTES * 60 * 1000;
}

/**
 * 占位：抢写 `state='in_progress'` 本行。
 *   - 无同名行 → 插入成功（1 行）；
 *   - 同名行仍新鲜（`done` 未过期 / `in_progress` 未超时）→ 0 行（并发输者，由调用方判定）；
 *   - 同名 `done` 行已过期 → 原子覆盖为本轮占位（1 行，避免过期行拦住重发）。
 * 返回是否占到占位。
 */
async function claim(pool, { userId, endpoint, key, hash }) {
  const res = await pool.query(
    `INSERT INTO idempotency_keys (user_id, endpoint, key, request_hash, state, status_code, response)
     VALUES ($1, $2, $3, $4, 'in_progress', NULL, NULL)
     ON CONFLICT (user_id, endpoint, key) DO UPDATE
        SET request_hash = EXCLUDED.request_hash,
            state        = 'in_progress',
            status_code  = NULL,
            response     = NULL,
            created_at   = now()
      WHERE idempotency_keys.state = 'done'
        AND idempotency_keys.created_at <= now() - interval '${IDEMPOTENCY_TTL_HOURS} hours'
     RETURNING 1 AS claimed`,
    [userId, endpoint, key, hash],
  );
  return (res.rows?.length ?? 0) > 0;
}

/**
 * 抢回崩溃残留的 in_progress 占位（≥ IDEMPOTENCY_IN_PROGRESS_STALE_MINUTES）。
 * 条件 UPDATE 保证并发下只有一个请求能抢到（其余 0 行 → 继续走 conflict/回查判定）。
 */
async function takeOverStale(pool, { userId, endpoint, key, hash }) {
  const res = await pool.query(
    `UPDATE idempotency_keys
        SET request_hash = $4,
            state        = 'in_progress',
            status_code  = NULL,
            response     = NULL,
            created_at   = now()
      WHERE user_id = $1 AND endpoint = $2 AND key = $3
        AND state = 'in_progress'
        AND created_at <= now() - interval '${IDEMPOTENCY_IN_PROGRESS_STALE_MINUTES} minutes'
     RETURNING 1 AS claimed`,
    [userId, endpoint, key, hash],
  );
  return (res.rows?.length ?? 0) > 0;
}

/** 落最终结果：占位行 → `state='done'` + 首次 status_code/response。 */
async function complete(pool, { userId, endpoint, key, statusCode, response }) {
  await pool.query(
    `UPDATE idempotency_keys
        SET state = 'done', status_code = $4, response = $5
      WHERE user_id = $1 AND endpoint = $2 AND key = $3
        AND state = 'in_progress'`,
    [userId, endpoint, key, statusCode, JSON.stringify(response)],
  );
}

/** 释放占位（fn 抛错路径）：删除本请求的 in_progress 占位行，客户端可原样重试。 */
async function release(pool, { userId, endpoint, key }) {
  await pool.query(
    `DELETE FROM idempotency_keys
      WHERE user_id = $1 AND endpoint = $2 AND key = $3
        AND state = 'in_progress'`,
    [userId, endpoint, key],
  );
}

/** 命中记录的收敛：hash 一致 → 回放首次结果；不一致 → 409 idempotency_key_reuse。 */
function replayHit(row, hash) {
  if (row.request_hash !== hash) {
    throw new IdempotencyError('idempotency_key_reuse', 'Idempotency-Key 已用于不同的请求载荷', {
      httpStatus: 409,
      details: { field: 'Idempotency-Key' },
    });
  }
  return { replayed: true, statusCode: Number(row.status_code), response: row.response };
}

/** 并发同 key 未收敛（先到先得，输者不执行 fn）→ 409 idempotency_conflict（retryable）。 */
function conflictError() {
  return new IdempotencyError('idempotency_conflict', '同一 Idempotency-Key 的并发请求未收敛，请重试', {
    httpStatus: 409,
    retryable: true,
    details: { field: 'Idempotency-Key' },
  });
}

/**
 * 幂等执行包装（**先占位后执行**）。
 * @param pool    pg pool（或测试用 fake pool）
 * @param ctx     { userId, endpoint, key, requestHash }
 *                endpoint 为**具体端点**（含路径参数，如 `POST /api/sessions/<id>/messages`）——
 *                同 key 跨 session 不串号；key 为 null 时无幂等语义。
 * @param fn      async () => ({ statusCode, response })，**至多执行一次**（占位赢家才执行）；
 *                副作用（如 notify 唤醒）应留在 fn 内，回放路径绝不执行。
 * @returns { replayed, statusCode, response }
 */
export async function executeWithIdempotency(pool, { userId, endpoint, key, requestHash: hash }, fn) {
  if (key == null) {
    const fresh = await fn();
    return { replayed: false, ...fresh };
  }

  let owned = false;
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS && !owned; attempt += 1) {
    // ① 已完成且未过期 → 回放首次结果（不执行 fn，不产生第二次副作用）
    const done = await findDone(pool, { userId, endpoint, key });
    if (done) return replayHit(done, hash);

    // ② 先占位：并发同 key 只有一个请求能占到（其余 0 行）→ fn 至多执行一次
    if (await claim(pool, { userId, endpoint, key, hash })) {
      owned = true;
      break;
    }

    // ③ 占位 0 行 → 读现有行判定归属
    const row = await findRow(pool, { userId, endpoint, key });
    if (!row) continue; // 占位行已被并发持有者的 fn 抛错路径释放 → 重试占位
    if (row.state === 'done') {
      if (isFresh(row)) return replayHit(row, hash); // 新鲜完成行 → 回放（hash 不一致 → 409 reuse）
      continue; // 过期完成行：本轮 claim 的 ON CONFLICT 应已覆盖；走到这里说明竞态，重试
    }
    if (!isStaleInProgress(row)) throw conflictError(); // in_progress 未超时：先到先得，输者不执行 fn
    if (await takeOverStale(pool, { userId, endpoint, key, hash })) owned = true; // 崩溃残留 → 抢回后执行
  }
  if (!owned) throw conflictError();

  // ④ 本请求持有占位 → 执行唯一一次副作用，并按结果落台账
  let fresh;
  try {
    fresh = await fn();
  } catch (err) {
    // 释放占位：客户端可原样重试（不落失败态，避免把一次瞬时错误钉成永久结果）
    await release(pool, { userId, endpoint, key }).catch(() => {});
    throw err;
  }
  await complete(pool, { userId, endpoint, key, statusCode: fresh.statusCode, response: fresh.response });
  return { replayed: false, statusCode: fresh.statusCode, response: fresh.response };
}

/** 物理清理过期幂等记录（TTL 24h）。返回删除行数；由 reaper 低频调用（见 internal.js startReaperLoop）。 */
export async function purgeExpired(pool) {
  const res = await pool.query(
    `DELETE FROM idempotency_keys WHERE created_at < now() - interval '${IDEMPOTENCY_TTL_HOURS} hours'`,
  );
  return res.rowCount ?? 0;
}
