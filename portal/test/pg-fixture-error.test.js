// #758 下半场的单测：夹具给 pg Pool 挂的 error 监听，语义必须是
// 只吞拆库导致的连接终止，其余一律进 log。用假 Pool（EventEmitter）。
// 不需真库。对照组：不挂监听时 EventEmitter 直接抛，故必须挂。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachPoolErrorHandler } from './pg-fixture.js';

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

// —— issue #766：光修夹具不够，**用例自己建的 pool 也得挂** ——
//
// #763 只给夹具创建的两个 pool 挂了监听，但 `migrate-fresh-db` / `upload-settings-real-db`
// 里是**用例自己 `createPool()`** 的 ⇒ 2026-11-25 CI 上又炸了同一条 57P01
//（`uncaughtException: terminating connection due to administrator command`）。
//
// 下面两条：① 钉 `createTestPool` 真的挂了监听；② 源码级守卫——测试文件里不许再出现裸
// `createPool(`（新写的用例最容易忘）。② 才是能挡住回归的那一条。
import { createTestPool } from './pg-fixture.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('#766 createTestPool 建出来的 pool 自带拆库终止监听（57P01 不外抛）', () => {
  const fakeCreatePool = () => new EventEmitter();
  const pool = createTestPool(fakeCreatePool, 'postgres://x/y', { max: 1 });
  assert.ok(pool.listenerCount('error') >= 1, 'createTestPool 必须挂 error 监听');
  const err = new Error('terminating connection due to administrator command');
  err.code = '57P01';
  assert.doesNotThrow(() => pool.emit('error', err), '拆库终止不能外抛');
});

test('#766 源码守卫：测试文件里不许裸调 createPool(（必须走 createTestPool）', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    if (f === 'pg-fixture.js') continue; // 夹具本体：它自己就是被包装的那一层
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // 只认真正的调用（`createPool(`），不认注释里的字样（`createTestPool(` 也不匹配）。
    if (/(^|[^A-Za-z0-9_])createPool\s*\(/m.test(src) && !src.includes('createTestPool')) {
      offenders.push(f);
    }
  }
  assert.deepEqual(offenders, [],
    `这些测试文件直接建池却没挂拆库终止监听（DROP DATABASE … FORCE 会踢出 57P01 ⇒ uncaughtException ⇒ 整条腿红）：${offenders.join(', ')}。改用 createTestPool(createPool, url, opts)`);
});
