// runner/lib/ipc.js 纯函数单测（零依赖，不碰 docker）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoundRecord, createReqIdGenerator, sendIpc } from '../lib/ipc.js';

test('normalizeRoundRecord：常规轮（roundKey+dedupKey）保留字段并注入 round', () => {
  const record = {
    round: 3,
    roundKey: 'run1:round:3',
    dedupKey: 'run1:round:3',
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
    ts: '2026-09-12T00:00:00.000Z',
    folded: false,
    foldedPayload: null,
  };
  const out = normalizeRoundRecord('run1', record);
  assert.equal(out.dedupKey, 'run1:round:3');
  assert.equal(out.round, 3);
  assert.equal(out.folded, false);
  assert.deepEqual(out.messages, record.messages);
  assert.equal(out.foldedPayload, null);
});

test('normalizeRoundRecord：round 0 种子记录（只有 roundKey）兜底注入 dedupKey', () => {
  const out = normalizeRoundRecord('run1', {
    round: 0,
    roundKey: 'run1:round:0',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'seed' }] }],
    ts: '2026-09-12T00:00:00.000Z',
  });
  assert.equal(out.dedupKey, 'run1:round:0');
  assert.equal(out.round, 0);
  assert.equal(out.folded, false);
  assert.deepEqual(out.messages, [{ role: 'user', content: [{ type: 'text', text: 'seed' }] }]);
});

test('normalizeRoundRecord：无任何 key 时用 run_id:round:计数 兜底', () => {
  const out = normalizeRoundRecord('run2', { round: 5, messages: [] });
  assert.equal(out.dedupKey, 'run2:round:5');
});

test('createReqIdGenerator：单调递增', () => {
  const next = createReqIdGenerator();
  assert.equal(next(), 1);
  assert.equal(next(), 2);
  assert.equal(next(), 3);
});

test('sendIpc：背压返回 false 视为已入队成功（真机 bug 回归：大 checkpoint 误判 channel closed）', () => {
  // Node IPC：send() 返回 false 可能只是「消息超过缓冲阈值已入队」，channel 仍健康。
  const proc = {
    connected: true,
    send() { return false; }, // 模拟背压入队
  };
  assert.equal(sendIpc(proc, { hello: 'world' }), true);
});

test('sendIpc：channel 已连接但 send 抛错 → 失败并留真实原因', async () => {
  const mod = await import('../lib/ipc.js');
  const proc = {
    connected: true,
    send() { throw new Error('Do not know how to serialize a BigInt'); },
  };
  assert.equal(sendIpc(proc, { x: 1 }), false);
  assert.match(mod.lastSendError, /BigInt/);
});

test('sendIpc：connected=false → 失败（channel closed）', () => {
  const proc = { connected: false, send() { return true; } };
  assert.equal(sendIpc(proc, {}), false);
});
