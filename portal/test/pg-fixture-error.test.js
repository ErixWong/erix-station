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

/**
 * 剥掉注释与字符串字面量，只留「会真的执行」的代码。
 *
 * 两件都必须剥：
 * - **注释**：注释里提到 `createPool(` 不是调用。
 * - **字符串字面量**：本文件的自检样本就是字符串（`'const p = createPool(url)'`），
 *   不剥的话守卫会把自己扫成违规（实测就是这么红的）。
 *
 * ⚠ 这是给守卫用的粗粒度剥法（正则），不追求完美 tokenize。它对**假红**宽容、对
 *   **假绿**不宽容 —— 而假绿正是这条守卫存在的理由（漏掉真违规 = 守卫不存在）。
 */
function stripCommentsAndStrings(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')                          // 块注释（含 JSDoc）
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")                        // 单引号串
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')                        // 双引号串
    .replace(/`(?:\\.|[^`\\])*`/g, '``')                          // 模板串
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))         // 行注释（`://` 不误伤 URL）
    .join('\n');
}

/**
 * 逐个建池调用判「有没有被防护包住」（审查 #3：**原来按整文件判**，一个文件里只要出现过
 * `guardPoolErrors` 字样就整份放过 ⇒ 「一个包过的 + 一个裸的」这种混合文件会**假绿**）。
 *
 * 判定：`createPool(` 之前（跳过空白/换行）紧挨着的必须是 `guardPoolErrors(` 或
 * `attachPoolErrorHandler(`。这正是 `guardPoolErrors(createPool(url), log)` 的形状。
 *
 * 返回**未被防护**的调用次数。
 */
function unguardedPoolBuilds(src) {
  const code = stripCommentsAndStrings(src);
  const re = /(^|[^A-Za-z0-9_])createPool\s*\(/g;
  let bad = 0;
  let m;
  while ((m = re.exec(code)) !== null) {
    const before = code.slice(0, m.index + m[1].length).replace(/\s+$/, '');
    const wrapped = POOL_GUARDS.some((g) => before.endsWith(`${g}(`));
    if (!wrapped) bad += 1;
  }
  return bad;
}

/** 这段源码「建了池」却「有未被防护的调用」。 */
function isUnguardedPoolBuild(src) {
  return unguardedPoolBuilds(src) > 0;
}

test('源码守卫：portal/test 里每个 createPool( 都必须被 guardPoolErrors / attachPoolErrorHandler 包住', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    if (f === 'pg-fixture.js') continue; // 夹具本体：防护函数就定义在这里
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const bad = unguardedPoolBuilds(src);
    if (bad > 0) offenders.push(`${f}（${bad} 处未防护）`);
  }
  assert.deepEqual(offenders, [],
    `这些测试文件里有未被防护的建池（DROP DATABASE … FORCE 会踢出 57P01 ⇒ `
    + `pool.emit('error') 无监听 ⇒ uncaughtException ⇒ 整条真库腿红）：${offenders.join('; ')}`);
});

test('源码守卫自检：判定对六种样本给对答案（防恒绿 / 防按整文件放过）', () => {
  // ① 裸建池 ⇒ 红
  assert.equal(unguardedPoolBuilds('const p = createPool(url, { max: 1 });'), 1, '裸建池必须判红');
  // ② 包过 ⇒ 绿
  assert.equal(unguardedPoolBuilds('const p = guardPoolErrors(createPool(url), log);'), 0, '包过不判红');
  assert.equal(unguardedPoolBuilds('const p = attachPoolErrorHandler(createPool(url));'), 0, '另一种包装也算');
  // ③ **混合文件**（审查 #3 的核心）：一个包过 + 一个裸的 ⇒ 必须红（旧实现会假绿）
  const mixed = 'const a = guardPoolErrors(createPool(u1), log);\nconst b = createPool(u2);';
  assert.equal(unguardedPoolBuilds(mixed), 1, '混合文件必须报出那 1 处未防护的（按整文件判会假绿）');
  // ④ 纯注释不算
  assert.equal(unguardedPoolBuilds('// 说明里提到 createPool( 不算\nconst x = 1;'), 0, '行注释不算');
  assert.equal(unguardedPoolBuilds('/* 块注释里 createPool( 也不算 */\nconst x = 1;'), 0, '块注释不算');
  // ⑤ 多行包装也认（包装与调用不在同一行）
  assert.equal(unguardedPoolBuilds('const p = guardPoolErrors(\n  createPool(url),\n  log);'), 0,
    '跨行包装要认（否则 migrate-fresh-db 的 mkPool 会被误判）');
  // ⑥ 别的函数名不误伤
  assert.equal(unguardedPoolBuilds('const p = createTestPoolLike(url);'), 0, '别的函数名不误伤');
});
