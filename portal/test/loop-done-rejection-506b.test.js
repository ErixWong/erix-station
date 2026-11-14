// 单测：issue #506 评审③——循环的 `done` 没人接拒绝 ⇒ **未捕获拒绝**。
//
// 缺陷形状（现查）：`done` 是裸 async IIFE 返回的 Promise（`routes.js` / `materializer.js`），
// `cli.js` 过去只是 `stop()`、从不消费 `done`。循环异常分支里的 `log.warn` / `onPause` / 注入的
// `sleep` 只要抛错，异常就穿出 `catch` 块 ⇒ `done` 变 rejected 且无人 catch ⇒ 进程级
// unhandledRejection。本仓已知的坑就是「测试摘要全绿，但进程 rc=1」（AGENTS.md §4 的判绿口径）。
//
// 判据形状：不是「代码里有个 .catch」，而是**注册 process 级 unhandledRejection 监听**，
// 在**不去 await done**（await 等于自己把拒绝吃掉）的情况下等若干轮事件循环，断言一条都没漏，
// 同时断言失败被记录下来、且正常关闭路径下 `done` 仍能 resolve（处理器没吞掉正常返回）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startRoutesLoop } from '../src/routes.js';
import { startMaterializerLoop } from '../src/materializer.js';

const ROUTES_CONFIG = (dir) => ({
  portalHost: 'station.localhost',
  portalBackendUrl: 'http://127.0.0.1:18080',
  traefikEntryPoint: 'web',
  llmHost: 'llm.localhost',
  llmGatewayUrl: 'http://station-litellm:4000',
  traefikDynamicFile: 'routes.yml',
  traefikLlmDynamicFile: 'llm-routes.yml',
  traefikDynamicDir: dir,
});
const MATERIALIZER_CONFIG = (root) => ({
  userSpaceRoot: root,
  llmPublicBaseUrl: 'http://llm.localhost:8090',
  baseDomain: 'localhost',
});
const tmpdir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** 每拍都抛的 fake pool：让循环立刻进异常分支（异常分支正是 onPause/log.warn 待的地方）。 */
class ExplodingPool {
  constructor() { this.queries = 0; }

  async query() { this.queries += 1; throw new Error('boom: 库炸了'); }

  async connect() {
    const self = this;
    return { query: async () => { self.queries += 1; throw new Error('boom: 库炸了'); }, release: () => {} };
  }
}

const SUITES = [
  {
    name: 'routes',
    tag: 'routes',
    start(opts) {
      const dir = tmpdir('routes-506c-');
      return { loop: startRoutesLoop(new ExplodingPool(), ROUTES_CONFIG(dir), opts), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    },
  },
  {
    name: 'materializer',
    tag: 'materializer',
    start(opts) {
      const root = tmpdir('mat-506c-');
      return { loop: startMaterializerLoop(new ExplodingPool(), MATERIALIZER_CONFIG(root), opts), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
    },
  },
];

/** 让事件循环转若干轮（未捕获拒绝是在微任务排空后的宏任务边界上发的，必须给它机会）。 */
const drain = () => new Promise((resolve) => setTimeout(resolve, 80));

/**
 * 关键前置：本用例**故意不 await loop.done**——await 就等于自己给 promise 挂了处理器，
 * 那么旧代码（没挂处理器）也会「看起来没漏」，判据就废了。
 */
for (const suite of SUITES) {
  test(`#${suite.name} onPause 在异常分支抛错 ⇒ done 拒绝被就地接住（无未捕获拒绝）且失败被记录`, async () => {
    const seen = [];
    const onUnhandled = (reason) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const warns = [];
    const log = { warn: (m) => warns.push(String(m)), error: () => {}, log: () => {} };
    const onPause = () => { throw new Error('boom: onPause 自己炸了'); };
    const { loop, cleanup } = suite.start({
      log,
      onPause,
      sleep: async () => true, // 异常分支退避立刻放行（真 setTimeout 会把用例拖成 1s 起）
      now: () => 0,
      workerId: `${suite.name}-t1`,
    });
    try {
      await drain();
      assert.deepEqual(seen.map((e) => e?.message ?? String(e)), [],
        `done 的拒绝必须被启动时挂的处理器接住；漏出来的就是「摘要全绿但 rc=1」那条坑（漏了：${JSON.stringify(seen.map((e) => e?.message))}）`);
      // 失败必须看得见（接住 ≠ 吞掉）
      assert.ok(warns.some((m) => m.includes('boom: 库炸了')), `异常分支自己的 warn 要在（实测 ${JSON.stringify(warns.slice(0, 3))}）`);
      const exitWarn = warns.find((m) => m.includes('消费循环异常退出'));
      assert.ok(exitWarn, `循环退出的原因必须记一条（实测 ${JSON.stringify(warns.slice(0, 4))}）`);
      assert.match(exitWarn, /onPause 自己炸了/, '退出的真正原因（onPause 抛错）要写进日志');
      assert.equal(loop.failure()?.message, 'boom: onPause 自己炸了', 'failure() 要能拿到那个错误');
      // 语义没被改变：done 仍是**会拒绝**的那一个（别把处理器挂成吞掉结果）
      const state = await Promise.race([
        loop.done.then(() => 'resolved', () => 'rejected'),
        drain().then(() => 'pending'),
      ]);
      assert.equal(state, 'rejected', 'done 本身必须仍以拒绝结束（处理器只是接住，不改变语义）');
      await loop.settled; // settled 永不拒绝
    } finally {
      loop.stop();
      await loop.settled;
      cleanup();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test(`#${suite.name} 异常分支里 log.warn 自己抛错 ⇒ 也不许漏未捕获拒绝（处理器自己得炸不响）`, async () => {
    const seen = [];
    const onUnhandled = (reason) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    // 每条 warn 都抛：循环的 catch 块第一句就炸 ⇒ done 拒绝 ⇒ 处理器里再 warn ⇒ 又炸
    const log = { warn: () => { throw new Error('boom: log.warn 炸了'); }, error: () => {}, log: () => {} };
    const { loop, cleanup } = suite.start({ log, sleep: async () => true, now: () => 0, workerId: `${suite.name}-t2` });
    try {
      await drain();
      assert.deepEqual(seen.map((e) => e?.message ?? String(e)), [],
        `处理器里的 log.warn 抛错不许变成第二条未捕获拒绝（漏了：${JSON.stringify(seen.map((e) => e?.message))}）`);
      await Promise.race([
        loop.settled,
        drain().then(() => { throw new Error('settled 竟然会拒绝（挂错地方了）'); }),
      ]);
      assert.equal(typeof loop.failure, 'function', '句柄要带 failure()，否则故障时无法定位');
    } finally {
      loop.stop();
      await loop.settled;
      cleanup();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test(`#${suite.name} 正常关闭路径：done 仍 resolve（处理器没把正常返回变成悬挂/拒绝）`, async () => {
    const seen = [];
    const onUnhandled = (reason) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const warns = [];
    const log = { warn: (m) => warns.push(String(m)), error: () => {}, log: () => {} };
    const { loop, cleanup } = suite.start({
      log,
      sleep: async (ms, signal) => { void ms; void signal; return false; }, // 第一拍就被「stop 打断」
      now: () => 0,
      workerId: `${suite.name}-t3`,
    });
    try {
      const outcome = await Promise.race([
        loop.done.then(() => 'resolved', () => 'rejected'),
        drain().then(() => 'pending'),
      ]);
      assert.equal(outcome, 'resolved', '正常退出时 done 必须 resolve（挂了处理器不许把它变成悬挂）');
      assert.equal(loop.failure(), null, '正常退出 failure() 必须是 null');
      assert.equal(warns.filter((m) => m.includes('消费循环异常退出')).length, 0, '正常退出不许报“异常退出”');
      loop.stop();
      await loop.settled;
      await drain();
      assert.deepEqual(seen.map((e) => e?.message ?? String(e)), [], '正常路径也不许漏未捕获拒绝');
    } finally {
      loop.stop();
      await loop.settled;
      cleanup();
      process.off('unhandledRejection', onUnhandled);
    }
  });
}

test('#506 评审③：两个循环都在**启动时**挂处理器，且同时暴露 done / settled（不许只留一份）', () => {
  for (const file of ['../src/routes.js', '../src/materializer.js']) {
    const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const doneAt = src.indexOf('const done = (async () => {');
    const catchAt = src.indexOf('done.catch(');
    const returnAt = src.indexOf('  return {\n    stop() {');
    assert.ok(doneAt > 0 && catchAt > doneAt && catchAt < returnAt,
      `${file}：拒绝处理器必须在 IIFE 之后、return 之前挂上（挂晚了 = 启动阶段的拒绝没人接）`);
    assert.match(src, /const settled = done\.catch\(/, `${file}：处理器要挂在 const settled 上`);
    assert.match(src, /^\s+settled,$/m, `${file}：句柄要暴露 settled（永不拒绝的那份）`);
    assert.match(src, /^\s+done, \/\/.*resolve/m, `${file}：done 仍要按原语义暴露`);
    assert.match(src, /\} catch \{/, `${file}：处理器内部要防 log 面自己抛错（否则又造一条未捕获拒绝）`);
  }
});
