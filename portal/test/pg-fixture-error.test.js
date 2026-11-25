// #758 下半场的单测：夹具给 pg Pool 挂的 error 监听，语义必须是
// 只吞拆库导致的连接终止，其余一律进 log。用假 Pool（EventEmitter）。
// 不需真库。对照组：不挂监听时 EventEmitter 直接抛，故必须挂。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  attachPoolErrorHandler, guardPoolErrors, isDropDbTermination,
} from './pg-fixture.js';

function makePool() {
  return new EventEmitter();
}

test('57P01 admin_shutdown 被忽略：不抛、不进 log', () => {
  const logs = [];
  const pool = makePool();
  attachPoolErrorHandler(pool, (m) => logs.push(m));
  const err = Object.assign(new Error('boom'), { code: '57P01' });
  assert.doesNotThrow(() => pool.emit('error', err, pool));
  assert.equal(logs.length, 0);
});

test('terminating connection 报文被忽略（即便没有 code）', () => {
  const logs = [];
  const pool = makePool();
  attachPoolErrorHandler(pool, (m) => logs.push(m));
  const err = new Error('terminating connection due to administrator command');
  assert.doesNotThrow(() => pool.emit('error', err, pool));
  assert.equal(logs.length, 0);
});

test('其余错误不能吞：进 log 且不外抛', () => {
  const logs = [];
  const pool = makePool();
  attachPoolErrorHandler(pool, (m) => logs.push(m));
  const err = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
  assert.doesNotThrow(() => pool.emit('error', err, pool));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /connection refused/);
});

test('无 message 的真错误也要留痕（落到 String(err)）', () => {
  const logs = [];
  const pool = makePool();
  attachPoolErrorHandler(pool, (m) => logs.push(m));
  assert.doesNotThrow(() => pool.emit('error', undefined, pool));
  assert.equal(logs.length, 1);
});

test('对照组：不挂监听时 EventEmitter 对 error 事件直接抛', () => {
  const pool = makePool();
  assert.throws(() => pool.emit('error', new Error('x')), /x/);
});

// ---- guardPoolErrors：直建池测试的入口（#758 下半场）----
// 与 attachPoolErrorHandler 同口径，但把同一个池原样返回，供建池处内联。
test('guardPoolErrors：返回值是同一个池（可内联在 createPool 外层）', () => {
  const pool = makePool();
  assert.equal(guardPoolErrors(pool, () => {}), pool);
});

test('guardPoolErrors：57P01 拆库终止不进 log、不外抛', () => {
  const logs = [];
  const pool = guardPoolErrors(makePool(), (m) => logs.push(m));
  const err = Object.assign(new Error('boom'), { code: '57P01' });
  assert.doesNotThrow(() => pool.emit('error', err, pool));
  assert.equal(logs.length, 0);
});

test('guardPoolErrors：其余错误仍要进 log（不静默）', () => {
  const logs = [];
  const pool = guardPoolErrors(makePool(), (m) => logs.push(m));
  assert.doesNotThrow(() => pool.emit('error', new Error('connection refused'), pool));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /connection refused/);
});

test('isDropDbTermination 已导出：只认 57P01 / administrator command 两类', () => {
  assert.equal(isDropDbTermination(Object.assign(new Error('x'), { code: '57P01' })), true);
  assert.equal(isDropDbTermination(
    new Error('terminating connection due to administrator command')), true);
  assert.equal(isDropDbTermination(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), false);
  assert.equal(isDropDbTermination(null), false);
});
