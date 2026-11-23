// 单测：issue #677 P3 第六批 —— 三个循环的空闲退避上限改成**每一拍现读**。
//
// 判据形状（工单点名的变异①）：**任一循环改回「启动时算一次」（envInt / resolveIdleBackoffMaxMs
// 进默认参数 = 快照）⇒ 对应那一格点名红**。红法：注入的 `readIdleBackoffMaxMs` 根本不会被调用，
// 或者调用了但结果没进 `idleDelayMs` ⇒ 观察到的 sleep 序列与「上一拍还用的那个值」不一致。
//
// 另两件事各钉一条：
//   · 现读走的是真机件（env 那一档 + 5s 缓存）：HB-4 改 env 并推过缓存窗口 ⇒ 下一拍就是新值；
//   · 对账那条的**钳位行为保留**：HB-5 `env=60000 ⇒ 生效 15000`（业务上限，不是 60000）。
//
// 夹具口径照 `idle-backoff-520.test.js`：假睡眠（永不自己醒，由测试放行）、假 pool、假 docker，
// 不碰真实 DB；「跑到第 n 拍」用**截止时刻**而不是轮次预算（#531 那族假红的教训）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { startOnboardingLoop } from '../src/onboarding.js';
import { startOffboardingLoop } from '../src/offboarding.js';
import { startProvisionerLoop } from '../src/provisioner.js';
import {
  HOT_READ_CACHE_TTL_MS,
  invalidateOnboardingIdleBackoffCache,
  invalidateProvisionerIdleBackoffCache,
  readOnboardingIdleBackoffMaxMs,
} from '../src/runtime-settings.js';

const silentLog = { debug() {}, warn() {}, error() {}, log() {} };

// ---------------------------------------------------------------------------
// 假睡眠与推进（形状照 idle-backoff-520：判据看**观察到的 sleep 毫秒序列**）
// ---------------------------------------------------------------------------

function makeFakeSleep() {
  const sleeps = [];
  let pending = null;
  const sleep = (ms, signal) => new Promise((resolve) => {
    sleeps.push(ms);
    const entry = { ms, done: false };
    entry.finish = (ok) => {
      if (entry.done) return;
      entry.done = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (pending === entry) pending = null;
      resolve(ok);
    };
    const onAbort = () => entry.finish(false);
    if (signal?.aborted) { entry.finish(false); return; }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    pending = entry;
  });
  const pass = () => {
    assert.ok(pending, '循环必须停在某一拍的 sleep 上（没停住 = 抛错或已退）');
    const entry = pending;
    entry.finish(true);
    return entry.ms;
  };
  return { sleeps, sleep, pass };
}

async function waitUntil(cond, label, deadlineMs = 15_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) {
      for (let i = 0; i < 5 && !cond(); i += 1) await new Promise((r) => setImmediate(r));
      if (cond()) return;
      assert.fail(`等超时（${deadlineMs}ms + 5 轮宽限）：${label}`);
    }
    await new Promise((r) => setImmediate(r));
  }
}

async function parkAt(fake, n, who = '循环') {
  for (let i = 1; i < n; i += 1) {
    await waitUntil(() => fake.sleeps.length >= i,
      `${who} 应已走到第 ${i} 拍 sleep（实际 ${fake.sleeps.length}）`);
    fake.pass();
  }
  await waitUntil(() => fake.sleeps.length >= n,
    `${who} 应已停在第 ${n} 拍 sleep（实际 ${JSON.stringify(fake.sleeps)}）`);
  return fake.sleeps;
}

/** 认领不到活的假池（`runtime_settings` 那条 SELECT 也回空 ⇒ 热读落 env/默认那一档）。 */
function makeIdlePool() {
  return {
    queries: [],
    async query(sql) { this.queries.push(String(sql)); return { rows: [] }; },
    async connect() { return { query: async () => ({ rows: [] }), release() {} }; },
  };
}

function makeIdleDocker() {
  return {
    async listContainers() { return { status: 200, data: [] }; },
    async listNetworks() { return { status: 200, data: [] }; },
  };
}

/** onboarding 的认领 SQL：永远回空 ⇒ 每拍都是空闲拍 ⇒ 阶梯一直爬。 */
function makeOnboardingPool() {
  return {
    async query(sql) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      return { rows: [] };
    },
    async connect() { return { query: async () => ({ rows: [] }), release() {} }; },
  };
}

// ---------------------------------------------------------------------------
// HB-1 / HB-2 / HB-3：现读位置 = **每一拍决定 sleep 之前**（变异①的点名牌）
// ---------------------------------------------------------------------------

test('HB-1 onboarding：退避上限每拍现读 ⇒ 改完下一拍就用新值（改回启动快照 ⇒ 这一格红）',
  async () => {
    const fake = makeFakeSleep();
    const seen = [];
    let cap = 7_000;
    const loop = startOnboardingLoop(makeOnboardingPool(), {}, {
      docker: {}, log: silentLog, sleep: fake.sleep,
      readIdleBackoffMaxMs: async (opts) => { seen.push(opts); return cap; },
    });
    try {
      await parkAt(fake, 2, 'onboarding');
      assert.deepEqual(fake.sleeps.slice(0, 2), [5_000, 7_000],
        '上限 7000 ⇒ 阶梯被它夹住（不夹就是 10000，与阶梯值同数就分不出「现读」与「快照」）');
      assert.equal(seen.length, 2, `每一拍都得读一次（实得 ${seen.length} 次）`);
      // 上一拍停在 sleep 上时改值 ⇒ 下一拍决定 sleep 时必须用新值。
      cap = 6_000;
      fake.pass();
      await waitUntil(() => fake.sleeps.length >= 3, 'onboarding 第 3 拍');
      assert.equal(fake.sleeps[2], 6_000,
        `改完没生效 = 拿的还是启动时那份快照（实得 sleep 序列 ${JSON.stringify(fake.sleeps)}）`);
      assert.ok(seen.length >= 3, '第 3 拍也必须现读');
      assert.ok(seen.every((o) => o && typeof o === 'object' && 'env' in o && 'now' in o),
        '现读要拿到 env 与 now（否则缓存与 env 那一档都接不上）');
    } finally {
      loop.stop();
      await loop.settled;
    }
  });

test('HB-2 provisioner：对账循环同样每拍现读（改回 resolveIdleBackoffMaxMs 快照 ⇒ 这一格红）',
  async () => {
    const fake = makeFakeSleep();
    let calls = 0;
    let cap = 9_000;
    const { pool, docker } = { pool: makeIdlePool(), docker: makeIdleDocker() };
    const loop = startProvisionerLoop(pool, {}, {
      docker, log: silentLog, sleep: fake.sleep, env: {},
      readIdleBackoffMaxMs: async () => { calls += 1; return cap; },
    });
    try {
      await parkAt(fake, 2, 'provisioner');
      assert.deepEqual(fake.sleeps.slice(0, 2), [5_000, 9_000]);
      cap = 6_000;
      fake.pass();
      await waitUntil(() => fake.sleeps.length >= 3, 'provisioner 第 3 拍');
      assert.equal(fake.sleeps[2], 6_000,
        `上限没跟着下一拍走 = 启动快照（实得 ${JSON.stringify(fake.sleeps)}）`);
      assert.ok(calls >= 3);
    } finally {
      loop.stop();
      await loop.settled;
    }
  });

test('HB-3 offboarding：退避上限每拍现读，且与保留天数那一格互不串（两个旋钮两个入口）',
  async () => {
    const fake = makeFakeSleep();
    const backoffCalls = { n: 0 };
    const retentionCalls = { n: 0 };
    let cap = 8_000;
    const loop = startOffboardingLoop(makeIdlePool(), {}, {
      docker: {}, log: silentLog, sleep: fake.sleep, env: {},
      now: () => 1_700_000_000_000,
      readRetention: async () => { retentionCalls.n += 1; return 30; },
      readIdleBackoffMaxMs: async () => { backoffCalls.n += 1; return cap; },
      sweep: async () => {},
    });
    try {
      await parkAt(fake, 2, 'offboarding');
      assert.deepEqual(fake.sleeps.slice(0, 2), [5_000, 8_000]);
      cap = 7_000;
      fake.pass();
      await waitUntil(() => fake.sleeps.length >= 3, 'offboarding 第 3 拍');
      assert.equal(fake.sleeps[2], 7_000, `实得 ${JSON.stringify(fake.sleeps)}`);
      assert.ok(backoffCalls.n >= 3 && retentionCalls.n >= 3,
        `两个旋钮各自每拍一次（退避 ${backoffCalls.n}、保留天数 ${retentionCalls.n}）`);
    } finally {
      loop.stop();
      await loop.settled;
    }
  });

// ---------------------------------------------------------------------------
// HB-4 / HB-5：真机件那一腿（不注 reader 注入缝）
// ---------------------------------------------------------------------------

test('HB-4 现读接的是真机件：改 env + 推过 5s 缓存窗口 ⇒ 下一拍就是新 env 值', async () => {
  invalidateOnboardingIdleBackoffCache();
  const fake = makeFakeSleep();
  const env = { ONBOARDING_IDLE_BACKOFF_MAX_MS: '10000' };
  let clock = 2_000_000;
  const loop = startOnboardingLoop(makeOnboardingPool(), {}, {
    docker: {}, log: silentLog, sleep: fake.sleep, env, now: () => clock,
  });
  try {
    await parkAt(fake, 2, 'onboarding(env=10000)');
    assert.deepEqual(fake.sleeps.slice(0, 2), [5_000, 10_000], 'env 那一档必须真的生效');
    env.ONBOARDING_IDLE_BACKOFF_MAX_MS = '6000';
    clock += HOT_READ_CACHE_TTL_MS + 1; // 缓存到点 ⇒ 下一拍重读
    fake.pass();
    await waitUntil(() => fake.sleeps.length >= 3, 'onboarding 第 3 拍');
    assert.equal(fake.sleeps[2], 6_000,
      `缓存到点后必须重读 env（实得 ${JSON.stringify(fake.sleeps)}）`);
  } finally {
    loop.stop();
    await loop.settled;
    invalidateOnboardingIdleBackoffCache();
  }
});

test('HB-5 钳位保留：对账 env=60000 ⇒ 生效 15000（业务上限）；开户 env=60000 ⇒ 真生效 60000',
  async () => {
    invalidateProvisionerIdleBackoffCache();
    invalidateOnboardingIdleBackoffCache();
    const pf = makeFakeSleep();
    const pLoop = startProvisionerLoop(makeIdlePool(), {}, {
      docker: makeIdleDocker(), log: silentLog, sleep: pf.sleep,
      env: { PROVISIONER_IDLE_BACKOFF_MAX_MS: '60000' }, now: () => 3_000_000,
    });
    const of = makeFakeSleep();
    const oLoop = startOnboardingLoop(makeOnboardingPool(), {}, {
      docker: {}, log: silentLog, sleep: of.sleep,
      env: { ONBOARDING_IDLE_BACKOFF_MAX_MS: '60000' }, now: () => 3_000_000,
    });
    try {
      assert.deepEqual(await parkAt(pf, 4, 'provisioner(env=60000)'),
        [5_000, 10_000, 15_000, 15_000],
        '对账越界必须落到 15000（业务上限）：搬到 registry 之后这条钳位不许被绕过');
      assert.deepEqual(await parkAt(of, 5, 'onboarding(env=60000)'),
        [5_000, 10_000, 20_000, 40_000, 60_000],
        '开户侧 60000 必须真生效（把它一起钳到 15s 就是另一处错）');
    } finally {
      pLoop.stop();
      oLoop.stop();
      await pLoop.settled;
      await oLoop.settled;
      invalidateProvisionerIdleBackoffCache();
      invalidateOnboardingIdleBackoffCache();
    }
  });

test('HB-6 三格的热读入口是三个不同函数，且开户那一格读的是自己的 key', async () => {
  invalidateOnboardingIdleBackoffCache();
  invalidateProvisionerIdleBackoffCache();
  const pool = {
    rows: [],
    async query() { return { rows: pool.rows }; },
    async connect() { return { query: async () => ({ rows: pool.rows }), release() {} }; },
  };
  pool.rows = [
    { key: 'loop.onboarding_idle_backoff_ms', value: 11_111 },
    { key: 'loop.provisioner_idle_backoff_ms', value: 12_222 },
  ];
  assert.equal(await readOnboardingIdleBackoffMaxMs({ pool, config: {}, env: {}, log: silentLog }),
    11_111, '循环拿的必须是同一套热读入口（值不串，见 RS-51）');
  invalidateOnboardingIdleBackoffCache();
  invalidateProvisionerIdleBackoffCache();
});
