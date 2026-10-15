// issue #299（erix-agent 0.18.0 → 0.19.0）：4xx 分类变化**不得**改变我们的可重试结论。
//
// 上游 0.19.0（host-upgrade-guide-0.19.0 §3 / issue #179）把 `classifyHttpError` 的四个 status
// 从一律 `unknown` 改成 `invalid_request`(400/422) / `not_found`(404) / `conflict`(409)，
// **`retryable` 三个新码仍是 false**。`code` 同时经 `termination.errorCode`（上游 #176）到宿主，
// 并被我们写进 `run_finished.error.code` / `runs.error_code`。
//
// 本文件是**实测**而非推理：真调用包里的 `classifyHttpError`（不自己抄一张表），再喂给
// `runner/lib/termination.js` 的 `buildFailureEnvelope`，逐条钉住「我们的 `error.retryable` 不变」。
// 允许变的只有 `error.code` 的取值；可重试集合、termination.reason 一字不许动。
//
// 隔离约定：纯函数 + 内存对象，不打 LLM / DB / 容器 / 网络。
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyHttpError } from 'erix-agent';
import {
  RETRYABLE_ERROR_CODES,
  buildFailureEnvelope,
  isRetryableErrorCode,
} from '../../runner/lib/termination.js';

/**
 * 两张表都是**实测值**：
 *   old* = erix-agent 0.18.0 的实测结果（升级前基线，探针记录见 .work-orders/probe.md 探针 2）
 *   new  = erix-agent 0.19.0 的实测结果（指南 §3 的表 + 本地复测一致）
 * 「stationRetryable」列 = 我们 `buildFailureEnvelope` 的结论，两版**必须相同** ⇒ 它是本文件的判据。
 */
const TABLE = [
  { status: 400, oldCode: 'unknown', code: 'invalid_request', upstreamRetryable: false, stationRetryable: false },
  { status: 404, oldCode: 'unknown', code: 'not_found', upstreamRetryable: false, stationRetryable: false },
  { status: 409, oldCode: 'unknown', code: 'conflict', upstreamRetryable: false, stationRetryable: false },
  { status: 422, oldCode: 'unknown', code: 'invalid_request', upstreamRetryable: false, stationRetryable: false },
  // 未受影响的对照项（0.18/0.19 完全一致）：证明本文件不是「只挑新码好看」
  { status: 401, oldCode: 'auth', code: 'auth', upstreamRetryable: false, stationRetryable: false },
  { status: 403, oldCode: 'auth', code: 'auth', upstreamRetryable: false, stationRetryable: false },
  { status: 408, oldCode: 'timeout', code: 'timeout', upstreamRetryable: true, stationRetryable: true },
  { status: 429, oldCode: 'rate_limited', code: 'rate_limited', upstreamRetryable: true, stationRetryable: true },
  { status: 500, oldCode: 'server', code: 'server', upstreamRetryable: true, stationRetryable: true },
  { status: 418, oldCode: 'unknown', code: 'unknown', upstreamRetryable: false, stationRetryable: false },
];

/** 引擎 0.19.0 新增到 `termination.errorCode` / `error.code` 值域里的三个名字。 */
const NEW_ERROR_CODES = ['invalid_request', 'not_found', 'conflict'];

test('探针 2 的实测面：真调包里的 classifyHttpError，四个 4xx 的 code 已变、retryable 未变', () => {
  for (const row of TABLE) {
    const err = classifyHttpError(row.status, `status ${row.status}`);
    assert.equal(err.code, row.code, `${row.status}：包给出的 code 与实测表不符（值域又变了？按 §3 复核后改表）`);
    assert.equal(err.retryable, row.upstreamRetryable, `${row.status}：上游 retryable 变了，须复核我们的判据`);
    if (NEW_ERROR_CODES.includes(row.code)) {
      // 新码与 0.18 的旧取值必须不同（这张表不是拄的：旧版这四个 status 一律 unknown）
      assert.equal(row.oldCode, 'unknown', `${row.status}：oldCode 基线写错了`);
    }
  }
  // 三个新码确实**不是** 0.18 的取值（这张表不是抄的：新码在旧版里不可达）
  for (const code of NEW_ERROR_CODES) {
    assert.ok(!TABLE.filter((r) => NEW_ERROR_CODES.includes(r.code)).some((r) => r.oldCode === code),
      `${code}：oldCode 表写错了，它不该在 0.18 就存在`);
  }
});

test('我们的 error.retryable 结论逐条不变（4xx 四个 status 全部仍然不可重试）', () => {
  for (const row of TABLE) {
    const upstream = classifyHttpError(row.status, `status ${row.status}`);
    // 与 worker 现场同形：引擎上抛的 KitError 带 code / retryable，worker 只透传不加工
    const err = Object.assign(new Error(`http ${row.status}`), { code: upstream.code, retryable: upstream.retryable });
    const env = buildFailureEnvelope({ err });
    assert.equal(env.error.code, row.code, `${row.status}：error.code 透传口径变了？`);
    assert.equal(env.error.retryable, row.stationRetryable,
      `${row.status}：Station 的可重试结论变了（期望 ${row.stationRetryable}，实际 ${env.error.retryable}）`);
    assert.equal(env.termination.reason, 'failed', `${row.status}：非中止路径的 reason 必须是 failed`);
  }
});

test('三个新码都不在可重试码集里（集合本身也不许多加）', () => {
  for (const code of NEW_ERROR_CODES) {
    assert.equal(isRetryableErrorCode(code), false, `${code}：被当成可重试了 ⇒ 会重复打一个必然失败的请求`);
    assert.ok(!RETRYABLE_ERROR_CODES.has(code));
  }
  // 集合逐项仍是这五个（多一个/少一个都算漂移，与前端常量、文档 §6.4 的对齐由终止契约测钉）
  assert.deepEqual([...RETRYABLE_ERROR_CODES].sort(),
    ['checkpoint_failed', 'disconnect', 'rate_limited', 'server', 'timeout']);
  // 上游显式 `retryable === true` 的逃生门仍在（新码若哪天被上游标成可重试，这里会先亮）
  const env = buildFailureEnvelope({ err: Object.assign(new Error('x'), { code: 'conflict', retryable: true }) });
  assert.equal(env.error.retryable, true, 'err.retryable === true 的显式口径必须仍然优先');
});

test('unknown 那一支没消失（0.19 只是变窄：418 一类仍落 unknown）', () => {
  assert.equal(classifyHttpError(418, 'teapot').code, 'unknown');
  assert.equal(isRetryableErrorCode('unknown'), false);
});
