// issue #212：worker 失败/中止终态信封单测——透传引擎 termination + 与上游对齐的 retryable 码表；
// issue #180（erix-agent 0.18.0）：失败/中止同样透传引擎挂在错误上的 usage/rounds。
// 上游依据：erix-agent 0.18.0 `src/loop/orchestrator.js:950-1008`（fail() 定 reason、挂落盘细节，
// 并在 :995-1000 把 `readLoopPayload()` 交给 annotateTermination）与
// `src/loop/termination.js:74-91`（把 termination 与同口径的 usage/rounds/finalText 塞进错误对象）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RETRYABLE_ERROR_CODES,
  buildFailureEnvelope,
  buildRunTermination,
  isRetryableErrorCode,
} from '../lib/termination.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 引擎 fail() 在「快照没落盘」时挂在错误上的 termination 形状（字段名逐字对齐上游）。 */
const PERSISTENCE_TERMINATION = {
  reason: 'persistence_failed',
  detail: 'Checkpoint persistence failed before tool execution (runId=sess-1, round=3)',
  operation: 'saveRunState',
  phase: 'checkpoint_before_tool',
  sideEffect: 'not_started',
};

test('引擎挂了 termination 时原样透传（保留 reason/operation/phase/sideEffect/detail 与未来新增键）', () => {
  const err = Object.assign(new Error('snapshot write failed'), {
    code: 'checkpoint_failed',
    termination: PERSISTENCE_TERMINATION,
  });
  const { termination, error } = buildFailureEnvelope({ err });
  assert.deepEqual(termination, PERSISTENCE_TERMINATION);
  assert.equal(termination.reason, 'persistence_failed', '不得再被拍平成 failed');
  assert.equal(termination.phase, 'checkpoint_before_tool', '前端要能看见 phase');
  assert.deepEqual(error, {
    code: 'checkpoint_failed',
    message: 'snapshot write failed',
    retryable: true,
  });
});

test('透传不丢上游未来新增的键（additive 兼容）', () => {
  const { termination } = buildFailureEnvelope({
    err: { message: 'x', termination: { reason: 'failed', future_field: 42 } },
  });
  assert.equal(termination.future_field, 42);
});

test('引擎没给 termination → 回退历史拍平口径（failed / aborted）', () => {
  assert.deepEqual(buildFailureEnvelope({ err: new Error('boom') }).termination, { reason: 'failed' });
  assert.deepEqual(buildFailureEnvelope({ err: new Error('boom'), aborted: true }).termination, { reason: 'aborted' });
  // 形状不合（reason 非字符串 / 空串 / 非对象）同样回退
  for (const junk of [undefined, null, {}, { reason: 42 }, { reason: '' }, 'failed']) {
    assert.deepEqual(buildRunTermination({ termination: junk }), { reason: 'failed' }, JSON.stringify(junk));
  }
});

test('竞态兜底：signal 已 abort 但引擎给了兜底值 failed → 以 aborted 呈现（其它键保留）', () => {
  const { termination } = buildFailureEnvelope({
    err: { message: 'aborted mid-tool', code: 'disconnect', termination: { reason: 'failed', detail: 'd' } },
    aborted: true,
  });
  assert.deepEqual(termination, { reason: 'aborted', detail: 'd' });
  // agentd 据此把 run 收敛为 finished（runner/agentd.js:929），与改动前一致：「停止」不会变红成失败
});

test('竞态兜底只覆盖兜底值 failed：引擎给出 persistence_failed 时仍以引擎为准', () => {
  const { termination } = buildFailureEnvelope({
    err: { message: 'm', termination: PERSISTENCE_TERMINATION },
    aborted: true,
  });
  assert.equal(termination.reason, 'persistence_failed');
  assert.equal(termination.sideEffect, 'not_started');
});

test('retryable 判据与上游可重试码逐项一致（旧代码是只认两值的半截清单）', () => {
  assert.deepEqual(
    [...RETRYABLE_ERROR_CODES].sort(),
    ['checkpoint_failed', 'disconnect', 'rate_limited', 'server', 'timeout'],
  );
  for (const code of ['timeout', 'rate_limited', 'server', 'disconnect', 'checkpoint_failed']) {
    assert.equal(isRetryableErrorCode(code), true, code);
    assert.equal(buildFailureEnvelope({ err: { message: 'm', code } }).error.retryable, true, code);
  }
  for (const code of ['provider_config', 'validation_failed', 'internal', 'aborted', 'max_attempts_exceeded', 'spool_full']) {
    assert.equal(buildFailureEnvelope({ err: { message: 'm', code } }).error.retryable, false, code);
  }
  // 非字符串 code 不误判
  assert.equal(isRetryableErrorCode(undefined), false);
  assert.equal(isRetryableErrorCode(42), false);
});

test('上游显式 retryable=true 优先；aborted 的 code 恒为 aborted 且不可重试', () => {
  assert.equal(buildFailureEnvelope({ err: { message: 'm', code: 'internal', retryable: true } }).error.retryable, true);
  assert.equal(buildFailureEnvelope({ err: { message: 'm', code: 'timeout', retryable: false } }).error.retryable, true, '码表命中即可重试');
  const aborted = buildFailureEnvelope({ err: { message: 'm', code: 'timeout' }, aborted: true });
  assert.equal(aborted.error.code, 'aborted');
  assert.equal(aborted.error.retryable, false);
});

test('message 兜底：无 message 时用 String(err)，绝不产出 undefined', () => {
  assert.equal(buildFailureEnvelope({ err: 'boom' }).error.message, 'boom');
  assert.equal(buildFailureEnvelope({ err: { code: 'server' } }).error.message, '[object Object]');
});

test('worker.js 确实用了本模块（catch 里没有第二份实现）', () => {
  const worker = fs.readFileSync(path.join(HERE, '../worker.js'), 'utf8');
  assert.match(worker, /import \{ buildFailureEnvelope \} from '\.\/lib\/termination\.js';/);
  assert.match(worker, /const \{ termination, error, usage, rounds \} = buildFailureEnvelope\(\{ err, aborted \}\);/);
});

// ---------- erix-agent #180（0.18.0）：失败/中止终态不再谎报零用量 ----------

test('#180 ①：引擎挂了 usage/rounds → 信封带真值（与正常路径同形）', () => {
  const err = Object.assign(new Error('provider disconnected mid-round'), {
    code: 'disconnect',
    termination: { reason: 'failed', detail: 'socket hang up', errorCode: 'disconnect' },
    usage: { input_tokens: 4211, output_tokens: 873 },
    rounds: 4,
  });
  const env = buildFailureEnvelope({ err });
  assert.deepEqual(env.usage, { input_tokens: 4211, output_tokens: 873 });
  assert.equal(env.rounds, 4);
  assert.equal(env.termination.reason, 'failed');
  assert.equal(env.error.code, 'disconnect');
});

test('#180 ②：引擎没挂 usage/rounds → 回退零值（旧引擎 / runToolLoop 之前抛错），绝不抛错', () => {
  for (const err of [new Error('boom'), { message: 'm', code: 'server' }, 'boom', undefined]) {
    const env = buildFailureEnvelope({ err });
    assert.deepEqual(env.usage, { input_tokens: 0, output_tokens: 0 }, JSON.stringify(err ?? null));
    assert.equal(env.rounds, 0);
  }
  // 只挂一半时各自回退，不出现「有真 token / rounds=0」的半截账
  assert.equal(buildFailureEnvelope({ err: { message: 'm', usage: { input_tokens: 7, output_tokens: 1 } } }).rounds, 0);
  assert.deepEqual(buildFailureEnvelope({ err: { message: 'm', rounds: 2 } }).usage, { input_tokens: 0, output_tokens: 0 });
});

test('#180 ③：中止路径（aborted:true + 带 usage）→ reason=aborted 且 usage 为真值', () => {
  const err = Object.assign(new Error('aborted by user'), {
    code: 'aborted',
    // 引擎 withTerminationPayload（0.18.0 termination.js:59-72）会往 aborted 的 termination 里
    // 同步 { usage, rounds, partial:true }；这里逐字段还原上游形状。
    termination: { reason: 'aborted', usage: { input_tokens: 900, output_tokens: 120 }, rounds: 2, partial: true },
    usage: { input_tokens: 900, output_tokens: 120 },
    rounds: 2,
  });
  const env = buildFailureEnvelope({ err, aborted: true });
  assert.equal(env.termination.reason, 'aborted');
  assert.equal(env.termination.partial, true, 'abort 终局的 partial 标记不得被抹掉');
  assert.deepEqual(env.usage, { input_tokens: 900, output_tokens: 120 }, '「停止」的 run 不再是账面上的 0');
  assert.equal(env.rounds, 2);
  assert.equal(env.error.code, 'aborted');
  assert.equal(env.error.retryable, false);
});

test('#180 ④：引擎 usage 含额外字段（cache/total 类）→ 原样透传不丢字段、不添字段', () => {
  const usage = { input_tokens: 1000, output_tokens: 250, cacheRead: 640, cacheWrite: 32, total_tokens: 1250 };
  const env = buildFailureEnvelope({ err: { message: 'm', code: 'server', usage, rounds: 9 } });
  assert.deepEqual(env.usage, usage);
  assert.deepEqual(Object.keys(env.usage).sort(), ['cacheRead', 'cacheWrite', 'input_tokens', 'output_tokens', 'total_tokens']);
  assert.equal(env.usage.cacheRead, 640, '引擎新增计量维度不能在本层被洗掉');
  assert.equal(env.rounds, 9);
});
