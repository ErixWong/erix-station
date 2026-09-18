// 写操作幂等（portal.md §1.4 / §4.3）：POST 端点可选 `Idempotency-Key` 请求头，
// 同 (user_id, endpoint, key) 重复提交返回**首次结果**（不产生第二次副作用，如第二条 user 消息/第二个 run）。
//
// 依据与口径：
//   - portal.md §1.4（写操作幂等）与 §4.3（POST .../messages 支持 Idempotency-Key）。
//   - 表：`idempotency_keys`（baseline docs/data/schema.sql §3.1；增量迁移 deploy/migrations/0001-idempotency-keys.sql）。
//   - TTL 24h：命中判定带 `created_at > now() - interval '24 hours'`；过期行语义上等同不存在
//     （重执行时由条件 upsert —— ON CONFLICT DO UPDATE ... WHERE 过期 —— 原子覆盖同名过期行），
//     并另由 reaper 低频调用 `purgeExpired` 物理清理（portal/src/internal.js startReaperLoop）。
//   - 命中且 request_hash 一致 → 回放首次 {statusCode, response}（replayed=true）；
//     命中但 request_hash 不一致 → 409 `idempotency_key_reuse`；
//     并发同 key → 输者探写台账失败（同名行仍新鲜）后回查首次结果（replayed=true）；回查仍无 → 409 `idempotency_conflict`。
//   - key 为 null（无头 / 空串）→ 无幂等语义，直接执行 fn()。
//
// 注意：本模块刻意不 import internal.js（internal.js 反向 import 本模块的 purgeExpired，避免循环依赖），
//   故自带一份稳定的序列化 `stableStringify`（仅用于本表内的 hash 相等判定，不跨模块共享语义）。

import crypto from 'node:crypto';

/** 幂等记录有效期（小时）。过期记录不参与命中，由 purgeExpired 物理清理。 */
export const IDEMPOTENCY_TTL_HOURS = 24;

/** Idempotency-Key 长度上限（超出 → 400 validation_failed）。 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

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
 */
export function normalizeKey(headerValue) {
  if (headerValue === undefined || headerValue === null) return null;
  if (typeof headerValue !== 'string') {
    throw new IdempotencyError('validation_failed', 'Idempotency-Key 必须为字符串', {
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
  // 控制字符（U+0000–U+001F、U+007F）：头注入/不可见字符一律拒绝。
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    throw new IdempotencyError('validation_failed', 'Idempotency-Key 含非法控制字符', {
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
 */
export function requestHash(body) {
  const normalized = {
    content: typeof body?.content === 'string' ? body.content : '',
    attachments: Array.isArray(body?.attachments) ? body.attachments : [],
  };
  return crypto.createHash('sha256').update(stableStringify(normalized)).digest('hex');
}

/** 查未过期记录（TTL 24h）。 */
async function findActive(pool, { userId, endpoint, key }) {
  const res = await pool.query(
    `SELECT request_hash, status_code, response
       FROM idempotency_keys
      WHERE user_id = $1 AND endpoint = $2 AND key = $3
        AND created_at > now() - interval '${IDEMPOTENCY_TTL_HOURS} hours'`,
    [userId, endpoint, key],
  );
  return res.rows?.[0] ?? null;
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

/**
 * 幂等执行包装。
 * @param pool    pg pool（或测试用 fake pool）
 * @param ctx     { userId, endpoint, key, requestHash }
 *                endpoint 为**具体端点**（含路径参数，如 `POST /api/sessions/<id>/messages`）——
 *                同 key 跨 session 不串号；key 为 null 时无幂等语义。
 * @param fn      async () => ({ statusCode, response })，仅在首次（未命中）时执行；
 *                副作用（如 notify 唤醒）应留在 fn 内，回放路径绝不再执行。
 * @returns { replayed, statusCode, response }
 */
export async function executeWithIdempotency(pool, { userId, endpoint, key, requestHash: hash }, fn) {
  if (key == null) {
    const fresh = await fn();
    return { replayed: false, ...fresh };
  }

  // ① 未过期记录命中 → 回放首次结果（不执行 fn，不产生第二次副作用）
  const hit = await findActive(pool, { userId, endpoint, key });
  if (hit) return replayHit(hit, hash);

  // ② 未命中 → 执行首次，然后把结果记入台账
  //    ON CONFLICT DO UPDATE ... WHERE 过期：并发输者（同名行仍新鲜）写入 0 行；
  //    而过期行（物理未清理）会被本次结果原子覆盖（否则 stale 行会拦住 INSERT → 误报 conflict）。
  const fresh = await fn();
  const statusCode = fresh.statusCode;
  const response = fresh.response;

  const inserted = await pool.query(
    `INSERT INTO idempotency_keys (user_id, endpoint, key, request_hash, status_code, response)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, endpoint, key) DO UPDATE
       SET request_hash = EXCLUDED.request_hash,
           status_code  = EXCLUDED.status_code,
           response     = EXCLUDED.response,
           created_at   = now()
       WHERE idempotency_keys.created_at <= now() - interval '${IDEMPOTENCY_TTL_HOURS} hours'
     RETURNING 1 AS inserted`,
    [userId, endpoint, key, hash, statusCode, JSON.stringify(response)],
  );
  if ((inserted.rows?.length ?? 0) > 0) return { replayed: false, statusCode, response };

  // ③ 写入 0 行 = 同名行仍新鲜（并发赢家先写入）→ 回查并回放（防并发双执行）
  const concurrent = await findActive(pool, { userId, endpoint, key });
  if (concurrent) return replayHit(concurrent, hash);

  // ④ 回查仍无（例如并发赢家事务回滚）：不可重复执行，交给客户端重试。
  throw new IdempotencyError('idempotency_conflict', '同一 Idempotency-Key 的并发请求未收敛，请重试', {
    httpStatus: 409,
    retryable: true,
    details: { field: 'Idempotency-Key' },
  });
}

/** 物理清理过期幂等记录（TTL 24h）。返回删除行数；由 reaper 低频调用（见 internal.js startReaperLoop）。 */
export async function purgeExpired(pool) {
  const res = await pool.query(
    `DELETE FROM idempotency_keys WHERE created_at < now() - interval '${IDEMPOTENCY_TTL_HOURS} hours'`,
  );
  return res.rowCount ?? 0;
}
