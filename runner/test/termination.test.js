// issue #212：worker 失败/中止终态信封单测——透传引擎 termination + 与上游对齐的 retryable 码表。
// 上游依据：erix-agent 0.17.0 `src/loop/orchestrator.js:734-773`（fail() 定 reason 并挂落盘细节）
// 与 `src/loop/termination.js:40-49`（annotateTermination 把对象塞进 error.termination）。
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
  assert.match(worker, /const \{ termination, error \} = buildFailureEnvelope\(\{ err, aborted \}\);/);
});
