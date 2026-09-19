// 写操作幂等（portal.md §1.4 / §4.3）：POST 端点可选 `Idempotency-Key` 请求头，
// 同 (user_id, endpoint, key) 重复提交返回**首次结果**（不产生第二次副作用，如第二条 user 消息/第二个 run）。
//
// 依据与口径：
//   - portal.md §1.4（写操作幂等）与 §4.3（POST .../messages 支持 Idempotency-Key）。
//   - 表：`idempotency_keys`（**仅由**增量迁移 deploy/migrations/0001-idempotency-keys.sql 提供；
//     baseline docs/data/schema.sql 自 P1 冻结、不改动，见 deploy/migrations/README.md）。
//   - 流程（**先占位后执行 + 记账并入业务事务**，F1/G2 裁决）：
//     ① `state='done'` 且未过期（TTL 24h）→ 回放首次结果（不执行 fn，不产生第二次副作用）；
//     ② 否则**先占位**（占位语句：无同名行 → 插入；同名行仍新鲜 → 0 行，等价于 `ON CONFLICT DO NOTHING`；
//        同名 `done` 行已过期 → 原子覆盖，故不必等 reaper 清过期行也能重发）——
//        并发同 key 只有一个请求能占到，故**fn 至多执行一次**；
//     ③ 占到占位 → 执行 `fn(record)`；fn 在**自己的业务事务内**调用 `record(client, statusCode, response)`
//        把台账行改为 `done`（同 client 同事务）→ 业务写入与记账**同一次 COMMIT**，
//        故「同 key 至多一次副作用（记账与业务写入同事务）」（崩溃窗口归零）；
//        fn 未调用 record（向后兼容，见 record 说明）→ 本模块在 fn 返回后补记（该路径仍有
//        「业务已提交、记账未提交」的残余窗口，故不绝对化）；
//        fn 抛错 → `DELETE` 占位行后原样 rethrow（释放 key，客户端可重试；不把瞬时错误钉成永久结果）；
//     ④ 占位 0 行（并发竞争/残留）→ 读现有行判定：
//        - `done` 且未过期 → 回放（request_hash 不一致 → 409 idempotency_key_reuse）；
//        - `done` 但已过期 → 视同不存在，重试占位（原子覆盖过期行）；
//        - `in_progress` 且 < IDEMPOTENCY_IN_PROGRESS_STALE_MINUTES（5 分钟）→ 409 idempotency_conflict
//          （retryable: true，先到先得；**输者不执行 fn**）；
//        - `in_progress` 且 ≥ 5 分钟（持有者崩溃残留）→ 视同可覆盖：UPDATE 抢回为本次 in_progress 后执行 fn。
//   - **owner fencing（claim_token，G2）**：占位/抢回时写入新的 `crypto.randomUUID()`；
//     `record` / 补记（writeDone） / `release` 一律带 `AND claim_token = $` 条件。A 崩溃后 B 抢回会改写 token，
//     于是迟到的 A 的记账/释放全部 0 行：A 的 `record()` 抛 409（业务事务随之回滚，不会提交第二次副作用），
//     迟到的 A 的 release 不会删掉 B 的占位。
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
 * 占位：抢写 `state='in_progress'` 本行（同时写入本次请求的 owner 标识 `claim_token`）。
 *   - 无同名行 → 插入成功（1 行）；
 *   - 同名行仍新鲜（`done` 未过期 / `in_progress` 未超时）→ 0 行（并发输者，由调用方判定）；
 *   - 同名 `done` 行已过期 → 原子覆盖为本轮占位（1 行，避免过期行拦住重发）。
 * 返回是否占到占位。
 */
async function claim(pool, { userId, endpoint, key, hash, claimToken }) {
  const res = await pool.query(
    `INSERT INTO idempotency_keys (user_id, endpoint, key, request_hash, state, status_code, response, claim_token)
     VALUES ($1, $2, $3, $4, 'in_progress', NULL, NULL, $5)
     ON CONFLICT (user_id, endpoint, key) DO UPDATE
        SET request_hash = EXCLUDED.request_hash,
            state        = 'in_progress',
            status_code  = NULL,
            response     = NULL,
            claim_token  = EXCLUDED.claim_token,
            created_at   = now()
      WHERE idempotency_keys.state = 'done'
        AND idempotency_keys.created_at <= now() - interval '${IDEMPOTENCY_TTL_HOURS} hours'
     RETURNING 1 AS claimed`,
    [userId, endpoint, key, hash, claimToken],
  );
  return (res.rows?.length ?? 0) > 0;
}

/**
 * 抢回崩溃残留的 in_progress 占位（≥ IDEMPOTENCY_IN_PROGRESS_STALE_MINUTES）。
 * 条件 UPDATE 保证并发下只有一个请求能抢到（其余 0 行 → 继续走 conflict/回查判定）；
 * 抢回时**改写 claim_token**——被抢回方的迟到记账/释放因此全部失配（fencing）。
 */
async function takeOverStale(pool, { userId, endpoint, key, hash, claimToken }) {
  const res = await pool.query(
    `UPDATE idempotency_keys
        SET request_hash = $4,
            state        = 'in_progress',
            status_code  = NULL,
            response     = NULL,
            claim_token  = $5,
            created_at   = now()
      WHERE user_id = $1 AND endpoint = $2 AND key = $3
        AND state = 'in_progress'
        AND created_at <= now() - interval '${IDEMPOTENCY_IN_PROGRESS_STALE_MINUTES} minutes'
     RETURNING 1 AS claimed`,
    [userId, endpoint, key, hash, claimToken],
  );
  return (res.rows?.length ?? 0) > 0;
}

/**
 * 台账转 `done` 的**带所有者条件** UPDATE（fencing 的唯一写点）：
 *   `state='in_progress' AND claim_token = $6` 两个条件都必须成立。
 * 返回是否命中本 owner 的占位行；0 行 = 本请求已不是 owner（被抢回/释放/清理）。
 * `runner` 可以是业务事务的 client（record 路径：同 client 同事务）或 pool（补记路径）。
 */
async function writeDone(runner, { userId, endpoint, key, claimToken, statusCode, response }) {
  const res = await runner.query(
    `UPDATE idempotency_keys
        SET state = 'done', status_code = $4, response = $5
      WHERE user_id = $1 AND endpoint = $2 AND key = $3
        AND state = 'in_progress'
        AND claim_token = $6`,
    [userId, endpoint, key, statusCode, JSON.stringify(response), claimToken],
  );
  return (res.rowCount ?? res.rows?.length ?? 0) > 0;
}

/** 释放占位（fn 抛错路径）：删除**本 owner 的** in_progress 占位行，客户端可原样重试。 */
async function release(pool, { userId, endpoint, key, claimToken }) {
  await pool.query(
    `DELETE FROM idempotency_keys
      WHERE user_id = $1 AND endpoint = $2 AND key = $3
        AND state = 'in_progress'
        AND claim_token = $4`,
    [userId, endpoint, key, claimToken],
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
 * 本请求已**不再是占位 owner**（被抢回/释放/清理）——`record()` 命中 0 行时抛出。
 * 语义上就是 409 `idempotency_conflict`（retryable）：fn 的业务事务会随之回滚，
 * 不会提交第二次副作用；客户端重试会拿到新 owner 的结果（回放）。
 */
function lostClaimError() {
  return new IdempotencyError(
    'idempotency_conflict',
    '本请求的幂等占位已被其它请求接管（owner fencing），本次业务写入已回滚，请重试',
    { httpStatus: 409, retryable: true, details: { field: 'Idempotency-Key' } },
  );
}

/**
 * 幂等执行包装（**先占位后执行，记账并入业务事务**）。
 * @param pool    pg pool（或测试用 fake pool）
 * @param ctx     { userId, endpoint, key, requestHash, log? }
 *                endpoint 为**具体端点**（含路径参数，如 `POST /api/sessions/<id>/messages`）——
 *                同 key 跨 session 不串号；key 为 null 时无幂等语义。
 *                log 用于非致命告警（release 失败、补记失配），默认 console。
 * @param fn      `async (record) => ({ statusCode, response })`，**至多执行一次**（占位赢家才执行）；
 *                副作用（如 notify 唤醒）应留在 fn 内，回放路径绝不执行。
 *                `record(client, statusCode, response)`：**在 fn 自己的业务事务内**调用，
 *                把台账行改为 done（同 client 同事务）——业务写入与记账同一次 COMMIT。
 *                fn 可以不调用它（向后兼容）：此时由本模块在 fn 返回后补记（残余窗口，见文件头）。
 * @returns { replayed, statusCode, response }
 */
export async function executeWithIdempotency(pool, { userId, endpoint, key, requestHash: hash, log = console }, fn) {
  if (key == null) {
    const fresh = await fn();
    return { replayed: false, ...fresh };
  }

  // 本次请求的 owner 标识：随占位写入，并作为 record/补记/release 的 fencing 条件
  const claimToken = crypto.randomUUID();

  let owned = false;
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS && !owned; attempt += 1) {
    // ① 已完成且未过期 → 回放首次结果（不执行 fn，不产生第二次副作用）
    const done = await findDone(pool, { userId, endpoint, key });
    if (done) return replayHit(done, hash);

    // ② 先占位：并发同 key 只有一个请求能占到（其余 0 行）→ fn 至多执行一次
    if (await claim(pool, { userId, endpoint, key, hash, claimToken })) {
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
    if (await takeOverStale(pool, { userId, endpoint, key, hash, claimToken })) owned = true; // 崩溃残留 → 抢回后执行
  }
  if (!owned) throw conflictError();

  // ④ 记账回调（G2）：交给 fn 在**它自己的业务事务内**调用 —— 消息/run 的写入与台账转 done
  //    同一 client、同一事务提交，故崩溃窗口归零（portal.md §1.4）。
  let recorded = null;
  const record = async (client, statusCode, response) => {
    if (!client || typeof client.query !== 'function') {
      // 编程错误（不是请求错误）：必须传业务事务的 client，否则记账会落在别的连接/事务上
      throw new TypeError('record(client, statusCode, response)：client 必须是业务事务的 client（同 client 同事务记账）');
    }
    if (!(await writeDone(client, { userId, endpoint, key, claimToken, statusCode, response }))) {
      // 占位已被其它 owner 接管（fencing）：抛 409 → fn 的事务回滚（不提交第二次副作用）→ 客户端重试拿回放
      throw lostClaimError();
    }
    recorded = { statusCode, response };
    return recorded;
  };

  // ⑤ 本请求持有占位 → 执行唯一一次副作用（fn 自行决定是否在事务内调 record）
  let fresh;
  try {
    fresh = await fn(record);
  } catch (err) {
    // 释放占位：客户端可原样重试（不落失败态，避免把一次瞬时错误钉成永久结果）。
    // 释放失败**不再静默吞**：告警后照旧 rethrow 原错误（占位最迟在 stale 窗口后由后续请求抢回）。
    try {
      await release(pool, { userId, endpoint, key, claimToken });
    } catch (releaseErr) {
      log?.warn?.(
        `[idempotency] 占位释放失败（endpoint=${endpoint}）：${releaseErr?.message}；` +
          `${IDEMPOTENCY_IN_PROGRESS_STALE_MINUTES} 分钟后可由后续请求抢回`,
      );
    }
    throw err;
  }

  // ⑥ fn 已在自身事务内记账（record 路径）→ 台账已是 done，直接返回；
  //    否则（fn 未调用 record）走补记路径——该路径仍有「业务已提交、记账未提交」的残余窗口（文件头有注）。
  if (recorded === null) {
    const done = await writeDone(pool, {
      userId, endpoint, key, claimToken, statusCode: fresh.statusCode, response: fresh.response,
    });
    if (!done) {
      log?.warn?.(
        `[idempotency] 台账补记未命中本 owner（claim_token 失配，endpoint=${endpoint}）：` +
          '该调用方未使用 record 同事务记账，存在既知残余窗口（portal.md §1.4）',
      );
    }
  }
  return { replayed: false, statusCode: fresh.statusCode, response: fresh.response };
}

/** 物理清理过期幂等记录（TTL 24h）。返回删除行数；由 reaper 低频调用（见 internal.js startReaperLoop）。 */
export async function purgeExpired(pool) {
  const res = await pool.query(
    `DELETE FROM idempotency_keys WHERE created_at < now() - interval '${IDEMPOTENCY_TTL_HOURS} hours'`,
  );
  return res.rowCount ?? 0;
}
