// 单测：issue #506 的**验收意见①**（copilot 复核，主 agent 现查核实）——空闲退避旋钮缺安全范围。
//
// 缺陷形状：`envInt` 原先只校验「正整数」，`idleDelayMs` 只做 `Math.min(…, Math.max(250, maxMs))`。
// 现查 Node v22.23.2：`setTimeout(()=>{}, 3e9)` 打印
//   `TimeoutOverflowWarning: 3000000000 does not fit into a 32-bit signed integer. Timeout duration was set to 1.`
// ⇒ 把 `ROUTE_IDLE_BACKOFF_MAX_MS` 配成 3000000000 的真实后果**不是**「退避变长」，而是循环以
// **1ms 空转**——比 #506 原本要修的 250ms 空转严重 250 倍。所以：越界必须**回落默认 + warn**
// （静默夹取会让人以为配置生效了），且 `idleDelayMs` 自身也要夹一次（防直接调用方传脏值）。
//
// 隔离约定（docs/testing.md §2.1）：fake pool + 临时目录 + 假时钟，不碰真实 DB / 真实 timer。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  startRoutesLoop,
  idleDelayMs as routesIdleDelayMs,
  sleepCancellable as routesSleepCancellable,
  MAX_BACKOFF_MS_SAFE as ROUTES_MAX_BACKOFF_MS_SAFE,
} from '../src/routes.js';
import {
  startMaterializerLoop,
  idleDelayMs as materializerIdleDelayMs,
  sleepCancellable as materializerSleepCancellable,
  MAX_BACKOFF_MS_SAFE as MATERIALIZER_MAX_BACKOFF_MS_SAFE,
} from '../src/materializer.js';

const NODE_TIMER_MAX_MS = 2147483647; // Node setTimeout 的 32 位有符号上限（越界 ⇒ duration=1）

// ---------------------------------------------------------------------------
// 假时钟 + fake pool（与 idle-backoff-506.test.js 同一形状，本文件自带一份避免跨文件耦合夹具）
// ---------------------------------------------------------------------------

function makeFakeClock() {
  const clock = { nowMs: 0, sleeps: [], pending: null };
  const now = () => clock.nowMs;
  const sleep = (ms, signal) => new Promise((resolve) => {
    clock.sleeps.push(ms);
    const entry = { ms, done: false };
    entry.finish = (ok) => {
      if (entry.done) return;
      entry.done = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (clock.pending === entry) clock.pending = null;
      resolve(ok);
    };
    const onAbort = () => entry.finish(false);
    if (signal?.aborted) { entry.finish(false); return; }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    clock.pending = entry;
  });
  async function arm() {
    for (let i = 0; i < 300 && !clock.pending; i += 1) await new Promise((r) => setImmediate(r));
    assert.ok(clock.pending, '循环必须停在某一拍的 sleep 上');
  }
  async function release() {
    const entry = clock.pending;
    assert.ok(entry, '没有挂起的 sleep 可放行');
    clock.pending = null;
    clock.nowMs += entry.ms;
    entry.finish(true);
    await arm();
    return entry.ms;
  }
  return { clock, now, sleep, arm, release };
}

class LoopFakePool {
  constructor({ table }) {
    this.table = table;
    this.claims = 0;
    this.orphanRecoveries = 0;
  }

  #rowsForClaim() {
    this.claims += 1;
    return { rows: [] }; // 永远认领 0 行 ⇒ 走空闲退避路径
  }

  #dispatch(sql) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes(this.table) && sql.includes("SET state = 'pending'")) {
      this.orphanRecoveries += 1;
      return { rows: [] };
    }
    if (sql.includes(this.table) && sql.includes("SET state = 'processing'")) return this.#rowsForClaim();
    return { rows: [] };
  }

  async query(sql, params = []) { return this.#dispatch(sql); }

  async connect() {
    const self = this;
    return { query: async (sql, params = []) => self.#dispatch(sql), release: () => {} };
  }
}

const ROUTES_CONFIG = (dir) => ({
  portalHost: 'station.localhost',
  portalBackendUrl: 'http://127.0.0.1:18080',
  portalFrontendOrigin: 'http://station.localhost',
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

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 记录 warn 的 log（本文件一半的判据是「回落必须看得见」）。 */
function recordingLog() {
  const warns = [];
  return { warns, warn: (m) => warns.push(String(m)), error: () => {}, log: () => {} };
}

/** 两套循环公共入口：判据必须**两边都跑**（同一个缺陷在两个文件里各有一份）。 */
const SUITES = [
  {
    name: 'routes',
    envMaxVar: 'ROUTE_IDLE_BACKOFF_MAX_MS',
    maxSafe: ROUTES_MAX_BACKOFF_MS_SAFE,
    idleDelayMs: routesIdleDelayMs,
    sleepCancellable: routesSleepCancellable,
    start(pool, opts) {
      const dir = tmpdir('routes-506b-');
      const loop = startRoutesLoop(pool, ROUTES_CONFIG(dir), opts);
      return { loop, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    },
    pool: () => new LoopFakePool({ table: 'route_outbox' }),
  },
  {
    name: 'materializer',
    envMaxVar: 'MATERIALIZE_IDLE_BACKOFF_MAX_MS',
    maxSafe: MATERIALIZER_MAX_BACKOFF_MS_SAFE,
    idleDelayMs: materializerIdleDelayMs,
    sleepCancellable: materializerSleepCancellable,
    start(pool, opts) {
      const root = tmpdir('mat-506b-');
      const loop = startMaterializerLoop(pool, MATERIALIZER_CONFIG(root), opts);
      return { loop, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
    },
    pool: () => new LoopFakePool({ table: 'materialize_outbox' }),
  },
];

/** 在临时 env 下跑一段（必须恢复，否则污染同文件后续用例）。 */
async function withEnv(name, value, fn) {
  const had = Object.hasOwn(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = String(value);
  try {
    return await fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

/** 让循环空转 `n` 拍，返回观察到的 sleep 序列。 */
async function observeSleeps(suite, { envValue, opts = {} } = {}, n = 6) {
  const fakes = makeFakeClock();
  const log = recordingLog();
  const pool = suite.pool();
  const { loop, cleanup } = suite.start(pool, { log, sleep: fakes.sleep, now: fakes.now, ...opts });
  try {
    await fakes.arm();
    const observed = [];
    for (let i = 0; i < n; i += 1) observed.push(await fakes.release());
    return { observed, warns: log.warns, claims: pool.claims };
  } finally {
    loop.stop();
    fakes.clock.pending?.finish(true);
    await Promise.resolve(loop.done).catch(() => {});
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// 纯函数侧：下限不许被配置压低，上限不许被配置冲破 Node timer 上限
// ---------------------------------------------------------------------------

for (const suite of SUITES) {
  test(`#${suite.name} idleDelayMs(5, 100) ⇒ 250：配置把上限调到 250 以下也不许压低基准节拍`, () => {
    // 改前实现是 `Math.min(250 * 2**4, Math.max(250, 100)) = min(4000, 250) = 250`（这条恰好也绿），
    // 但它**没有**任何声明说「下限优先」——本用例的意义是把这个不变式钉住，改回裸 Math.min 就红。
    assert.equal(suite.idleDelayMs(5, 100), 250);
    assert.equal(suite.idleDelayMs(1, 1), 250, 'maxMs=1 也必须回落到基准 250');
    assert.equal(suite.idleDelayMs(0, 100), 250);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, 'abc']) {
      const v = suite.idleDelayMs(3, bad);
      assert.ok(Number.isFinite(v) && v >= 250 && v <= suite.maxSafe,
        `脏 maxMs=${String(bad)} 必须回落成安全区间内的值，实测 ${v}`);
    }
  });

  test(`#${suite.name} idleDelayMs(40, 3e9) ⇒ ≤ ${suite.maxSafe}（配错不许退化成 1ms 空转）`, () => {
    const v = suite.idleDelayMs(40, 3e9);
    assert.ok(v <= suite.maxSafe, `返回值 ${v} 必须 ≤ MAX_BACKOFF_MS_SAFE=${suite.maxSafe}`);
    assert.ok(v <= NODE_TIMER_MAX_MS,
      `返回值 ${v} 必须 ≤ Node 32 位 timer 上限 ${NODE_TIMER_MAX_MS}，否则 setTimeout 会把 duration 设成 1`);
    // 越界值也不能从任何 idleTicks 上溜过去
    for (let idleTicks = 1; idleTicks <= 60; idleTicks += 1) {
      const d = suite.idleDelayMs(idleTicks, 3e9);
      assert.ok(d <= NODE_TIMER_MAX_MS && d >= 250, `idleTicks=${idleTicks} ⇒ ${d} 越界`);
    }
    // 合法的上限仍然生效（安全范围不是「一律忽略配置」）
    assert.equal(suite.idleDelayMs(5, 30_000), 4_000, '30s 这个合法上限必须照常生效（阶梯 250,500,1000,2000,4000）');
    assert.equal(suite.idleDelayMs(12, 30_000), 30_000, '爬到 30s 封顶');
  });
}

test('#506b MAX_BACKOFF_MS_SAFE = 60000（业务上限）且远小于 Node timer 上限', () => {
  for (const [file, maxSafe] of [['../src/routes.js', ROUTES_MAX_BACKOFF_MS_SAFE], ['../src/materializer.js', MATERIALIZER_MAX_BACKOFF_MS_SAFE]]) {
    assert.equal(maxSafe, 60_000, `${file}：退避超过 60s 对 outbox 消费没有意义，上限取 60s`);
    assert.ok(maxSafe <= NODE_TIMER_MAX_MS);
    const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(src, /const NODE_TIMER_MAX_MS = 2147483647;/, `${file}：Node timer 上限要用字面量写明`);
    assert.match(src, /MAX_BACKOFF_MS_SAFE = Math\.min\(NODE_TIMER_MAX_MS, 60_000\)/,
      `${file}：安全上限必须是「Node timer 上限」与「业务上限 60s」取小`);
    assert.match(src, /2147483647|32 位/, `${file}：注释要写明越界为什么是 1ms 空转`);
  }
});

// ---------------------------------------------------------------------------
// env 侧：越界 / 非法 ⇒ 回落默认 2000 + warn（三条：3e9、-1、'abc'）
// ---------------------------------------------------------------------------

for (const suite of SUITES) {
  // 3e9：旧代码 `envInt` 认为它是合法正整数 ⇒ 直接进 `Math.max(250, 3e9)` ⇒ 阶梯 5000/10000…，
  // 且 idleTicks 再大一点（2**24 > 3e9）就落到 3e9，被 Node 的 timer 截成 **1ms 空转**。
  test(`#${suite.name} env ${suite.envMaxVar}=3000000000 ⇒ 回落默认 2000（不越界、不 1ms 空转）且 warn`, async () => {
    await withEnv(suite.envMaxVar, '3000000000', async () => {
      const { observed, warns } = await observeSleeps(suite);
      assert.deepEqual(observed, [250, 500, 1000, 2000, 2000, 2000],
        `越界配置必须回落默认阶梯（实测 ${observed.join(',')}）`);
      assert.ok(observed.every((ms) => ms <= NODE_TIMER_MAX_MS), '没有一个值会撞 Node timer 上限');
      assert.ok(observed.every((ms) => ms >= 250), '回落之后仍是退避，不是 1ms 空转');
      assert.equal(warns.filter((m) => m.includes(suite.envMaxVar)).length, 1,
        `必须恰好转一条 warn 说明这行配置没生效（实测 ${JSON.stringify(warns)}）`);
      assert.match(warns.find((m) => m.includes(suite.envMaxVar)), /回落/);
    });
  });

  test(`#${suite.name} env ${suite.envMaxVar}=-1 ⇒ 回落默认 2000 且 warn（旧行为是静默回落）`, async () => {
    await withEnv(suite.envMaxVar, '-1', async () => {
      const { observed, warns } = await observeSleeps(suite);
      assert.deepEqual(observed, [250, 500, 1000, 2000, 2000, 2000]);
      assert.equal(warns.filter((m) => m.includes(suite.envMaxVar)).length, 1,
        `非法值也必须看得见（实测 ${JSON.stringify(warns)}）`);
    });
  });

  test(`#${suite.name} env ${suite.envMaxVar}='abc' ⇒ 回落默认 2000 且 warn`, async () => {
    await withEnv(suite.envMaxVar, 'abc', async () => {
      const { observed, warns } = await observeSleeps(suite);
      assert.deepEqual(observed, [250, 500, 1000, 2000, 2000, 2000]);
      assert.equal(warns.filter((m) => m.includes(suite.envMaxVar)).length, 1);
    });
  });

  test(`#${suite.name} env ${suite.envMaxVar} 合法值照常生效；没配则一条 warn 都不刷`, async () => {
    await withEnv(suite.envMaxVar, '30000', async () => {
      const { observed, warns } = await observeSleeps(suite, {}, 6);
      assert.deepEqual(observed, [250, 500, 1000, 2000, 4000, 8000],
        `合法上限 30000 必须真的放宽阶梯（实测 ${observed.join(',')}）——安全范围不是忽略配置`);
      assert.equal(warns.filter((m) => m.includes(suite.envMaxVar)).length, 0, '合法配置不该产生告警噪声');
    });
    await withEnv(suite.envMaxVar, undefined, async () => {
      const { observed, warns } = await observeSleeps(suite);
      assert.deepEqual(observed, [250, 500, 1000, 2000, 2000, 2000], '没配 ⇒ 默认 2000');
      assert.deepEqual(warns.filter((m) => m.includes(suite.envMaxVar)), [], '没配不是错误，不许刷噪声');
    });
  });

  // 孤儿回收间隔同一条红线（它是 `setTimeout` 之外的比较值，但同样会被配错成「永不回收」/越界）
  test(`#${suite.name} 孤儿回收间隔 env 越界 ⇒ 回落 10000 且 warn（同一条红线覆盖第二个旋钮）`, async () => {
    const orphanVar = suite.envMaxVar.replace('IDLE_BACKOFF_MAX_MS', 'ORPHAN_RECOVERY_INTERVAL_MS');
    await withEnv(orphanVar, '3000000000', async () => {
      const fakes = makeFakeClock();
      const log = recordingLog();
      const pool = suite.pool();
      const { loop, cleanup } = suite.start(pool, { log, sleep: fakes.sleep, now: fakes.now });
      try {
        await fakes.arm();
        for (let i = 0; i < 12; i += 1) await fakes.release(); // 假时钟走 ~11s
        assert.ok(pool.orphanRecoveries >= 2,
          `回落成 10s 后应回收多次（实测 ${pool.orphanRecoveries}）；不回落则 3e9 让回收永不发生`);
        assert.equal(log.warns.filter((m) => m.includes(orphanVar)).length, 1);
      } finally {
        loop.stop();
        fakes.clock.pending?.finish(true);
        await Promise.resolve(loop.done).catch(() => {});
        cleanup();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// sleepCancellable：timer 延迟必须等于传入值（不溢出 ⇒ 不会静默变 1ms）
// ---------------------------------------------------------------------------

for (const suite of SUITES) {
  test(`#${suite.name} sleepCancellable(MAX_BACKOFF_MS_SAFE) 建的 timer 延迟 === 60000（未被 Node 截成 1）`, async () => {
    const realSetTimeout = globalThis.setTimeout;
    const captured = [];
    globalThis.setTimeout = (fn, ms, ...rest) => {
      captured.push(ms);
      return realSetTimeout(fn, 1, ...rest); // 真的 timer 只走 1ms，用例不等 60s
    };
    const ac = new AbortController();
    try {
      const p = suite.sleepCancellable(suite.maxSafe, ac.signal);
      assert.equal(captured.length, 1, 'sleepCancellable 必须只建一个 timer');
      assert.equal(captured[0], 60_000, `timer 延迟必须原样等于传入值（实测 ${captured[0]}）`);
      assert.ok(captured[0] <= NODE_TIMER_MAX_MS, '延迟必须落在 32 位有符号区间内');
      assert.equal(await p, true, '被短接的 timer 仍要按「睡满了」返回 true');
      // 对照：把越界值直接喂给 setTimeout 才是那个坑（本用例只证明坑的存在，不改 Node 行为）
      globalThis.setTimeout = (fn, ms, ...rest) => { captured.push(ms); return realSetTimeout(fn, 1, ...rest); };
      const before = captured.length;
      await suite.sleepCancellable(suite.idleDelayMs(40, 3e9), undefined);
      assert.ok(captured[before] <= NODE_TIMER_MAX_MS,
        `退避函数越界值必须已被夹住（实测喂给 setTimeout 的是 ${captured[before]}）`);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      ac.abort();
    }
  });
}
