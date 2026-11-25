// #758 下半场的单测：夹具给 pg Pool 挂的 error 监听，语义必须是
// 只吞拆库导致的连接终止，其余一律进 log。用假 Pool（EventEmitter）。
// 不需真库。对照组：不挂监听时 EventEmitter 直接抛，故必须挂。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// —— 源码守卫：测试里建池必须挂拆库终止监听 ——
//
// 这条守的是一次**真实复发**：同一个 57P01 uncaughtException 修了两轮 ——
//   ① #763 修 `pg-fixture.js` 自己创建的两个 pool；
//   ② 但 `migrate-fresh-db` / `upload-settings-real-db` 里是**用例自己 createPool()** 的，
//      于是 CI 又炸同一条（`uncaughtException: terminating connection due to administrator command`）。
//
// 两轮之间隔了一次合并。**「修了夹具就以为修完了」是这个 bug 的复发机制** ——
// 而人眼扫不到「还有谁在自己建池」。所以让 CI 扫：测试文件里出现裸 `createPool(` 而
// 没有防护包装 ⇒ 当场红，点名是哪个文件。
//
// ⚠ 为什么限定 `portal/test/`：非测试代码**不该**吞 57P01（真实的管理员关机必须可见）。

const POOL_GUARDS = ['guardPoolErrors', 'attachPoolErrorHandler'];

/** 剥掉整行注释（`//` 起头与 JSDoc 的 ` * ` 起头），免得注释里提到 `createPool(` 被误判。 */
function stripCommentLines(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/** 判定：这段源码「建了池」却「没挂防护」。抽出来给两条用例共用，避免守卫与自检各写一套。 */
function isUnguardedPoolBuild(src) {
  const code = stripCommentLines(src);
  const buildsPool = /(^|[^A-Za-z0-9_])createPool\s*\(/m.test(code);
  if (!buildsPool) return false;
  return !POOL_GUARDS.some((g) => code.includes(g));
}

test('源码守卫：portal/test 里不许有「裸建池」文件（必须用 guardPoolErrors / attachPoolErrorHandler 包一层）', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    if (f === 'pg-fixture.js') continue; // 夹具本体：防护函数就定义在这里
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (isUnguardedPoolBuild(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    `这些测试文件自己建池却没挂拆库终止监听（DROP DATABASE … FORCE 会踢出 57P01 ⇒ `
    + `pool.emit('error') 无监听 ⇒ uncaughtException ⇒ 整条真库腿红）：${offenders.join(', ')}`);
});

test('源码守卫自检：判定对四种样本给对答案（防止守卫本身恒绿或恒红）', () => {
  assert.equal(isUnguardedPoolBuild('const p = createPool(url, { max: 1 });'), true,
    '裸建池必须判红');
  assert.equal(isUnguardedPoolBuild('const p = guardPoolErrors(createPool(url), log);'), false,
    '包过就不判红');
  assert.equal(isUnguardedPoolBuild('// 说明文字里提到 createPool( 不算\nconst x = 1;'), false,
    '纯注释不算（剥注释后才判）');
  assert.equal(isUnguardedPoolBuild('const p = attachPoolErrorHandler(createPool(url));'), false,
    '另一种包装也算');
  assert.equal(isUnguardedPoolBuild('const p = createTestPoolLike(url);'), false,
    '别的函数名不误伤（\`createPool\` 要独立成词）');
});
