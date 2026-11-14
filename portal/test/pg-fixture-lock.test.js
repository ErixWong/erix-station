// 真库夹具那把**跨进程文件锁**的本体用例（`portal/test/pg-fixture.js`）。
//
// 为什么单开一个文件（审计第 8 条，261114-05）：锁的实现本来**一条用例都没有** —— 它只在
// `withFreshDatabase` 里被顺带用一下，而那条路径要真库才走得到。结果就是「`CREATE DATABASE`
// 抛错时锁泄不泄」这种纯本地事实，**没有 PG 的机器上永远不会红**。本文件不需要 PG：
// 锁是文件系统的，建库那一步用注入的钩子模拟。
//
// 覆盖（四条都是「锁的契约」，缺一条就可能有真后果）：
//   ① 建库抛错 ⇒ 锁必须**当场释放**（审计第 8 条那个真 bug：原来 `release()` 在 `try` 里，
//      而建库在 `try` **外面** ⇒ 泄锁到 10 分钟 stale，后面所有真库用例卡在锁上）；
//   ② 跨进程互斥（两个 Node 进程真的抢同一把锁）；
//   ③ 持锁进程已死 ⇒ 立刻可抢（否则崩溃的持锁者会把整条套件钉到超时）；
//   ④ `token` 不匹配的 release **不得删别人的锁**（超时那条腿已经放手了，不能去 unlink
//      刚被别人拿走的锁 —— 那会让两个进程同时进临界区，正是这把锁要防的 `tuple concurrently updated`）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { acquireBootstrapLock, createPgFixture } from './pg-fixture.js';

const FIXTURE_SRC = fileURLToPath(new URL('./pg-fixture.js', import.meta.url));
/** 每个用例自己的锁文件（默认那个是与真库用例共用的，`npm test` 并发跑时去碰它就是自找竞态）。 */
const tmpLock = (tag) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), `lock-${tag}-`)), 'bootstrap.lock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一个「不会真连库」的夹具：建库/删库都走注入钩子。 */
const fakeFixture = (lockFile, createDatabase) => createPgFixture(
  'postgres://u:p@127.0.0.1:1/none',   // createPool 是惰性的：不 query 就不连
  { prefix: 'lktest', lockFile, createDatabase, dropDatabase: async () => ({ rows: [] }) },
);

test('审计第 8 条：CREATE DATABASE 抛错 ⇒ 锁**当场释放**（后续 acquire 立刻成功，不等到 stale）', async () => {
  const file = tmpLock('leak');
  const fx = fakeFixture(file, async () => { throw Object.assign(new Error('database creation failed'), { code: '42P04' }); });
  await assert.rejects(
    () => fx.withFreshDatabase(() => assert.fail('建库失败就不该跑用例体')),
    /database creation failed/,
  );
  assert.equal(fs.existsSync(file), false, `建库失败后锁文件必须不存在（泄了就留到 10 分钟 stale）：${file}`);
  // 直接证据：下一次 acquire **不用等**（staleMs 给得比 sleep 大得多 ⇒ 只能靠「文件已没了」赢）
  const t0 = Date.now();
  const release = await acquireBootstrapLock({ file, timeoutMs: 2_000, staleMs: 600_000 });
  assert.ok(Date.now() - t0 < 1_000, `acquire 等了 ${Date.now() - t0}ms —— 说明上一把没释放，是等 stale 才赢的`);
  release();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('夹具（反向自证）：用例体抛错 / migrate 抛错也照样释放；正常路径也释放', async () => {
  const file = tmpLock('body');
  const ok = fakeFixture(file, async () => ({ rows: [] }));
  // 用例体抛错
  await assert.rejects(() => ok.withFreshDatabase(() => { throw new Error('用例体炸了'); }, { migrate: false }));
  assert.equal(fs.existsSync(file), false, '用例体抛错也必须释放');
  // 正常路径
  let ran = false;
  await ok.withFreshDatabase(() => { ran = true; }, { migrate: false });
  assert.equal(ran, true, '前置：正常路径确实跑了');
  assert.equal(fs.existsSync(file), false, '正常路径也要释放（这条一直在做对，写下来是为了别被改坏）');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('锁：跨进程互斥 —— 另一个进程持锁时 acquire 必须等（等不到就报错，不得插队）', async () => {
  const file = tmpLock('xproc');
  // 子进程：真用同一个实现拿锁，持有 1.2s 后释放（用 spawn 而不是线程：这把锁的语义就是跨进程）
  const child = spawn(process.execPath, ['-e', `
    const { acquireBootstrapLock } = await import(${JSON.stringify('file://' + FIXTURE_SRC)});
    const release = await acquireBootstrapLock({ file: ${JSON.stringify(file)}, timeoutMs: 5000 });
    process.stdout.write('HELD\\n');
    setTimeout(() => { release(); process.stdout.write('RELEASED\\n'); }, 1200);
  `, '--input-type=module'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', (b) => { out += b.toString(); if (out.includes('HELD')) resolve(); });
    child.on('exit', (code) => { if (!out.includes('HELD')) reject(new Error(`子进程没拿上锁：rc=${code}`)); });
  });
  try {
    await done;
    assert.equal(fs.existsSync(file), true, '子进程持锁期间锁文件必须在');
    // 等不到 ⇒ 必须**抛错**，而不是插队进临界区
    await assert.rejects(
      () => acquireBootstrapLock({ file, timeoutMs: 250, staleMs: 600_000 }),
      /拿不到真库夹具文件锁/,
      '子进程还活着且没过期 ⇒ 只能等；等不到就红（插队就是两个进程同时改集群目录）',
    );
    // 等得到 ⇒ 子进程释放后立刻成功
    const release = await acquireBootstrapLock({ file, timeoutMs: 5_000, staleMs: 600_000 });
    release();
  } finally {
    child.kill();
    await new Promise((r) => child.on('exit', r));
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('锁：持锁进程已死（pid 不存在）⇒ 立刻抢，不等到 stale', async () => {
  const file = tmpLock('dead');
  // 找一个**确定不存在**的 pid：`kill(pid,0)` 必须 ESRCH
  const dead = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let s = '';
    c.stdout.on('data', (b) => { s += b; });
    c.on('exit', () => (s ? resolve(Number(s)) : reject(new Error('拿不到 pid'))));
  });
  await sleep(150); // 让它真的走完
  fs.writeFileSync(file, JSON.stringify({ pid: dead, token: '别人的', at: Date.now() }));
  const t0 = Date.now();
  const release = await acquireBootstrapLock({ file, timeoutMs: 3_000, staleMs: 600_000 });
  assert.ok(Date.now() - t0 < 1_000, `抢死锁等了 ${Date.now() - t0}ms（活性探测没生效）`);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token !== '别人的', true, '抢到就是把锁换成自己的了');
  release();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('锁：token 不匹配 ⇒ release **不得删别人的锁**（否则两个进程同时在临界区）', async () => {
  const file = tmpLock('token');
  const mine = await acquireBootstrapLock({ file, timeoutMs: 3_000 });
  // 模拟「我这边超时已经放手，锁被别人抢走」：文件里现在是**别人**的 token
  const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: `${cur.token}-other`, at: Date.now() }));
  mine();                       // 我这张release 券现在作废了
  assert.equal(fs.existsSync(file), true, 'release 不得 unlink 别人刚拿到的锁');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, `${cur.token}-other`,
    '别人的锁内容必须逐字还在');
  // 别人的锁还在 ⇒ 我再次 acquire 必须等（证明临界区没被放开的假象骗过去）
  await assert.rejects(() => acquireBootstrapLock({ file, timeoutMs: 200, staleMs: 600_000 }), /拿不到真库夹具文件锁/);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('锁：release 是幂等的（重复调不会把别人的锁删掉）', async () => {
  const file = tmpLock('idem');
  const r = await acquireBootstrapLock({ file, timeoutMs: 3_000 });
  r();
  assert.equal(fs.existsSync(file), false, '第一次 release 就该删掉自己的锁');
  // 我放手后别人拿了锁 ⇒ 我再调一次自己的 release（重复调）不得动它
  const other = await acquireBootstrapLock({ file, timeoutMs: 3_000 });
  r();
  assert.equal(fs.existsSync(file), true, '第二次 release 不得删掉别人刚拿的锁');
  other();
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
