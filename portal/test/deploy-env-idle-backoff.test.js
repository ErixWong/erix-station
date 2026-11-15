// 单测：issue #520 的**运维面三腿一致性**（PR #552 审计 LOW-1 / LOW-2 的返工判据）。
//
// 为什么这条必须存在（不是「文档里写一下就行」）：
//   `deploy/docker-compose.yml` 里 `station-portal` 用的是**显式 `environment` 列表、没有 `env_file`**
//   （该文件自己在 `FILE_UPLOAD_MAX_BYTES` 那条注释里就写了这个行为）。⇒ 一根新旋钮只要没在那张列表里
//   登记，运维在 `deploy/.env` 里写它**完全不生效**，而且**没有任何报错**：容器里还是代码缺省值，
//   看现象像「配了没用/运维不会配」。#520 新加的三根 `*_IDLE_BACKOFF_MAX_MS` 就是这个形状
//   （审计实测：`PROVISIONER_IDLE_BACKOFF_MAX_MS=5000` 在标准部署里是空气）。
//   先例：#472（`FILE_UPLOAD_MAX_BYTES`，评审 major 8）、#270（IPAM 池，`ipam-pool-env.test.js`）、
//   #450（管理台端口三处一致）—— 同一族病，同一味药：**从磁盘读 YAML 跟代码常量对，别用同源常量自证**。
//
// 四条判据（每条注明它治哪一种红）：
//   G1 三条都登记在 compose 的 `station-portal.environment`，且必须是 `${VAR:-数字}` 插值形态
//      （写成裸字面量也算红：那运维在 `.env` 里改还是无效，正是本次要修的病）
//   G2 **三腿一致**：compose 的插值缺省 == 代码缺省常量 == **循环真正生效的封顶值**
//      （第三腿是真起循环看 sleep 毫秒序列，不是再读一遍常量 —— 那会漏掉「常量对但没接线」）
//   G3 三条都登记在 `deploy/.env.example`（运维唯一的可配清单；缺了就等于「不知道有这根旋钮」）
//   G4 LOW-2：`PROVISIONER_IDLE_BACKOFF_MAX_MS=60000` ⇒ 生效值必须是 **15000**（按本循环业务上限钳）
//      **且 warn 点名旋钮**；对照组：开户侧配 60000 必须**真生效**（证明钳制是按循环的，没顺手全局钳）
//
// 隔离约定（docs/testing.md §2.1）：假 pool + 假 docker + 注入假睡眠，不碰真实 DB / Docker / /srv/erix。
// 时钟口径（issue #531）：判据全部打在**注入的假睡眠**上；`waitUntil` 只用截止时刻兜底，不用轮次预算。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'yaml';

import { startOnboardingLoop, IDLE_BACKOFF_MAX_MS_DEFAULT as ONBOARDING_DEFAULT } from '../src/onboarding.js';
import { startOffboardingLoop, IDLE_BACKOFF_MAX_MS_DEFAULT as OFFBOARDING_DEFAULT } from '../src/offboarding.js';
import {
  startProvisionerLoop,
  resolveIdleBackoffMaxMs,
  IDLE_BACKOFF_MAX_MS_DEFAULT as PROVISIONER_DEFAULT,
  IDLE_BACKOFF_MAX_MS_BUSINESS_CAP as PROVISIONER_CAP,
} from '../src/provisioner.js';
import { MAX_BACKOFF_MS_SAFE } from '../src/loop-timing.js';

const COMPOSE = new URL('../../deploy/docker-compose.yml', import.meta.url);
const ENV_EXAMPLE = new URL('../../deploy/.env.example', import.meta.url);

/** 口径照 `deploy-env-defaults.test.js` / `ipam-pool-env.test.js`，不另造一套。 */
function interpolationDefault(value) {
  const m = /^\$\{([A-Z0-9_]+):-([^}]*)\}$/.exec(String(value));
  return m ? m[2] : String(value);
}

function composePortalEnv() {
  return parse(fs.readFileSync(COMPOSE, 'utf8')).services['station-portal'].environment;
}

const silentLog = { log() {}, warn() {}, error() {} };

/** 收集 warn 文案（G1/G4 都要判「有没有点名旋钮」，静默回落是本单明令禁止的形状）。 */
function captureLog() {
  const warns = [];
  return { warns, log: { log() {}, warn: (...a) => warns.push(a.join(' ')), error() {} } };
}

// ---------------------------------------------------------------------------
// 假睡眠：记录每一拍毫秒数，且**不自己醒**（循环必须停在 sleep 上，由测试放行）。
// 形状与 `idle-backoff-520.test.js` 一致（那边是退避行为本体，这边只管「旋钮的值有没有真的进到循环」）。
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
    assert.ok(pending, '循环必须停在某一拍的 sleep 上（没停住 = 循环抛错或已经退了）');
    pending.finish(true);
  };
  return { sleeps, sleep, pass };
}

/** 等到条件成立（截止时刻兜底，不是轮次预算 —— #531）。 */
async function waitUntil(cond, label, deadlineMs = 15_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) assert.fail(`等超时（${deadlineMs}ms，同机负载？）：${label}`);
    await new Promise((r) => setImmediate(r));
  }
}

/** 推到「停在第 n 拍」为止（前面的拍逐拍放行；假睡眠不会自己醒）。 */
async function parkAt(fake, n, who = '循环') {
  for (let i = 1; i < n; i += 1) {
    await waitUntil(() => fake.sleeps.length >= i, `${who} 应已走到第 ${i} 拍 sleep；实际 ${fake.sleeps.length} 拍`);
    fake.pass();
  }
  await waitUntil(() => fake.sleeps.length >= n, `${who} 应已停在第 ${n} 拍 sleep；实际 ${fake.sleeps.length} 拍`);
  return fake.sleeps.slice();
}

// ---------------------------------------------------------------------------
// 假 pool / 假 docker：只要「这一拍没活」这一件事，所以越小越好。
// ---------------------------------------------------------------------------
/** 认领 0 行的万能 pool（开户/销号共用：`FROM fde_onboarding` / `FROM fde_offboarding` 都返回空）。 */
function makeIdlePool() {
  return {
    async query() { return { rows: [] }; },
    async connect() { return { query: async () => ({ rows: [] }), release() {} }; },
  };
}

/** 对账无事可做：desired 0 行 + 无孤儿容器/网络 ⇒ `reconcileDidWork(stats)` 为假 ⇒ 走空闲阶梯。 */
function makeIdleProvisioner() {
  const docker = {
    async listContainers() { return { status: 200, data: [] }; },
    async listNetworks() { return { status: 200, data: [] }; },
  };
  return { pool: makeIdlePool(), docker };
}

/**
 * 空闲阶梯的**封闭形式**（独立于 `idleDelayMs` 的实现写出来，免得用实现自证实现）：
 * 第 n 个连续空闲拍 = min(基准 5000 × 2^(n-1), 旋钮上限)，旋钮低于基准时按基准兜住。
 */
function ladderFor(maxMs, ticks = 5) {
  return Array.from({ length: ticks }, (_, i) => Math.min(5000 * 2 ** i, Math.max(5000, maxMs)));
}

const PROVISIONER_CONFIG = {
  dockerHost: 'tcp://fake:2375',
  userspaceRoot: '/tmp/station-520-env',
  userspaceRootHost: '/tmp/station-520-env',
  fdeUid: 1000, fdeGid: 1000,
  fdeImage: 'traefik/whoami',
  fdeCmd: ['-port', '4000'],
  fdeMemoryLimit: '512m',
  fdeAgentVersion: 'dev',
  baseDomain: 'localhost',
  llmHost: 'llm.localhost',
  fdePool: 'default',
  stackId: 'default',
};

/**
 * 三根旋钮的表：**代码侧真值从被测模块 import**（不是在本文件里再抄一个 30000），
 * compose 侧从磁盘解析。两条腿 + 「循环真正生效值」= 三腿。
 * `expectIdleLadder(envMax)` 给出「喂进这个上限时应该看到的空闲 sleep 序列」（阶梯 = 5000 起翻倍）。
 */
const KNOBS = [
  {
    key: 'ONBOARDING_IDLE_BACKOFF_MAX_MS',
    codeDefault: ONBOARDING_DEFAULT,
    altMax: 15_000, // 与缺省不同的另一个值：用它证「旋钮是活的」（见 G2b）
    expectIdleLadder: (max) => ladderFor(max, 5),
    start: ({ pool, sleep, env, log }) => startOnboardingLoop(pool, {}, { docker: {}, log, sleep, env }),
  },
  {
    key: 'OFFBOARDING_IDLE_BACKOFF_MAX_MS',
    codeDefault: OFFBOARDING_DEFAULT,
    altMax: 15_000,
    expectIdleLadder: (max) => ladderFor(max, 5),
    // `workspaceRetentionDays: 7` 是**特性开关**：0/未设 ⇒ 清理整段直接 return，用例测不到那条 SQL 的形状
    start: ({ pool, sleep, env, log }) => startOffboardingLoop(pool, { userSpaceRoot: '/tmp/station-520-env', workspaceRetentionDays: 7 }, { docker: {}, log, sleep, env }),
  },
  {
    key: 'PROVISIONER_IDLE_BACKOFF_MAX_MS',
    codeDefault: PROVISIONER_DEFAULT,
    altMax: 5_000, // = 台账里那个逃生口：配 5000 回到 #520 之前的固定 5s 节拍
    expectIdleLadder: (max) => ladderFor(max, 4),
    start: ({ sleep, env, log }) => {
      const { pool, docker } = makeIdleProvisioner();
      return startProvisionerLoop(pool, PROVISIONER_CONFIG, { docker, log, sleep, env });
    },
  },
];

// ---------------------------------------------------------------------------
// G1 登记 + 形态
// ---------------------------------------------------------------------------
test('#520 G1 三根空闲退避旋钮必须登记在 compose 的 station-portal.environment（且是可覆盖的插值形态）', () => {
  const env = composePortalEnv();
  for (const { key } of KNOBS) {
    const raw = env?.[key];
    assert.ok(raw !== undefined,
      `deploy/docker-compose.yml 的 station-portal.environment 里没有 ${key}：`
      + 'portal 的 environment 是**显式列表、无 env_file**，没登记 ⇒ 运维在 deploy/.env 里写它根本不生效（PR #552 审计 LOW-1）');
    const shape = new RegExp(`^\\$\\{${key}:-([0-9]+)\\}$`).exec(String(raw));
    assert.ok(shape,
      `${key} 必须写成 \`\${${key}:-<正整数>}\` 插值形态，实际是 ${JSON.stringify(raw)}：`
      + '裸字面量等于把旋钮焊死在 compose 里，运维照样改不动');
    assert.ok(Number(shape[1]) > 0, `${key} 的插值缺省必须是正整数，实际 ${shape[1]}`);
  }
});

// ---------------------------------------------------------------------------
// G2 三腿一致（compose 插值缺省 == 代码缺省常量 == 循环真正生效值）
// ---------------------------------------------------------------------------
test('#520 G2 三腿一致：compose 插值缺省 == 代码缺省常量 == 循环真正生效的封顶值（逐拍 sleep 序列）', async () => {
  const env = composePortalEnv();
  for (const { key, codeDefault, expectIdleLadder, start } of KNOBS) {
    const composeDefault = Number(interpolationDefault(env[key]));
    assert.equal(composeDefault, codeDefault,
      `${key}：compose 插值缺省 ${composeDefault} ≠ 代码缺省 ${codeDefault}`
      + '（#472/#270 同型病：两头各说各话，文档与部署面分叉）');

    // 第三腿：**把 compose 里那个值喂进循环**，看真实 sleep 毫秒序列。
    // 只比常量会漏掉「常量对但循环没用它」这种接线断掉的形状。
    const fake = makeFakeSleep();
    const pool = makeIdlePool();
    const loop = start({ pool, sleep: fake.sleep, env: { [key]: String(composeDefault) }, log: silentLog });
    try {
      const ladder = await parkAt(fake, expectIdleLadder(composeDefault).length, key);
      assert.deepEqual(ladder, expectIdleLadder(composeDefault),
        `${key}：喂进 compose 缺省 ${composeDefault} 后的空闲 sleep 序列不是期望阶梯`
        + `（期望 ${JSON.stringify(expectIdleLadder(composeDefault))}，实际 ${JSON.stringify(ladder)}）`);
      assert.equal(ladder.at(-1), composeDefault,
        `${key}：循环的封顶值 ${ladder.at(-1)} ≠ 运维面看到的 ${composeDefault} ⇒ 部署面写的数字与真实行为不符`);
    } finally {
      loop.stop?.();
      await loop.done;
    }
  }
});

// ---------------------------------------------------------------------------
// G3 运维可配清单
// ---------------------------------------------------------------------------
test('#520 G3 deploy/.env.example 必须登记这三根旋钮（注释形态可以，缺行不行）', () => {
  const text = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  for (const { key, codeDefault } of KNOBS) {
    const line = text.split('\n').find((l) => new RegExp(`^\\s*#?\\s*${key}\\s*=`).test(l));
    assert.ok(line, `deploy/.env.example 里没有 ${key}：运维唯一的可配清单上找不到它（compose 里登记了却没处可查）`);
    const value = line.split('=').slice(1).join('=').trim();
    // `.env.example` 里这三行是**注释掉**的（= 用代码缺省），所以只钉「若写了值就必须与代码缺省一致」
    if (value !== '') {
      assert.equal(Number(value), codeDefault,
        `${key}：.env.example 给的示例值 ${value} ≠ 代码缺省 ${codeDefault} ⇒ 抄示例就等于改了行为`);
    }
  }
});

// ---------------------------------------------------------------------------
// G4 LOW-2：provisioner 的业务上限是硬的，且必须说话
// ---------------------------------------------------------------------------
test('#520 G4 LOW-2：PROVISIONER_IDLE_BACKOFF_MAX_MS=60000 ⇒ 生效 15000 且 warn 点名旋钮；对照开户侧必须真生效', async () => {
  assert.equal(PROVISIONER_CAP, 15_000, '对账的业务上限应当是 15000（漂移发现延迟是业务承诺）');
  assert.ok(PROVISIONER_CAP < MAX_BACKOFF_MS_SAFE,
    '本条判据的意义就是「缺省 < 共享上限」：两者相等时钳制与回落不可分辨，用例失去意义');

  // ① 解析层：env=60000 ⇒ 钳到 15000，并且 warn 里点名旋钮与钳后值（静默回落是禁止的形状）
  const { warns, log } = captureLog();
  assert.equal(resolveIdleBackoffMaxMs({ log, env: { PROVISIONER_IDLE_BACKOFF_MAX_MS: '60000' } }), 15_000,
    'env=60000 的生效值必须是 15000：一个 env 不该把「漂移即修」的发现延迟静默放宽到 4 倍');
  assert.equal(warns.length, 1, `应当恰好 warn 一次（静默回落不算放行），实际 ${JSON.stringify(warns)}`);
  assert.match(warns[0], /PROVISIONER_IDLE_BACKOFF_MAX_MS/, `warn 必须点名旋钮，实际：${warns[0]}`);
  assert.match(warns[0], /15000/, `warn 必须给出钳后的生效值 15000，实际：${warns[0]}`);

  // ② 端到端：同一个 env 喂进循环 ⇒ 空闲阶梯仍封顶 15000（证明钳制真的接在循环上）
  const fake = makeFakeSleep();
  const { pool, docker } = makeIdleProvisioner();
  const loop = startProvisionerLoop(pool, PROVISIONER_CONFIG, {
    docker, log: silentLog, sleep: fake.sleep, env: { PROVISIONER_IDLE_BACKOFF_MAX_MS: '60000' },
  });
  try {
    assert.deepEqual(await parkAt(fake, 4, 'provisioner(env=60000)'), [5000, 10000, 15_000, 15_000],
      'env=60000 被接受并真产生 60s 延迟 = 审计 LOW-2 的原始形状（钳制撤掉后这一格必须红）');
  } finally {
    loop.stop();
    await loop.done;
  }

  // ③ 对照组：**开户侧不钳**（它的业务上限就是共享的 60s）。全局钳会把这条 LOW 修成另一条错。
  const ob = makeFakeSleep();
  const obLoop = startOnboardingLoop(makeIdlePool(), {}, {
    docker: {}, log: silentLog, sleep: ob.sleep, env: { ONBOARDING_IDLE_BACKOFF_MAX_MS: '60000' },
  });
  try {
    assert.deepEqual(await parkAt(ob, 5, 'onboarding(env=60000)'), [5000, 10_000, 20_000, 40_000, 60_000],
      '开户侧 60000 必须**真生效**（注释里写的「要更激进就配 60000」要能兑现；被一起钳到 15s 就是假话）');
  } finally {
    obLoop.stop();
    await obLoop.done;
  }

  // ④ 越界仍然是「回落 + warn」，不是「悄悄用你写的数」（共享上限 60s 由 envInt 守，口径见 A3）
  const big = captureLog();
  assert.equal(resolveIdleBackoffMaxMs({ log: big.log, env: { PROVISIONER_IDLE_BACKOFF_MAX_MS: '600000' } }), 15_000);
  assert.equal(big.warns.length, 1, `env=600000 也必须 warn 一次，实际 ${JSON.stringify(big.warns)}`);
  assert.match(big.warns[0], /PROVISIONER_IDLE_BACKOFF_MAX_MS/);
});

// ---------------------------------------------------------------------------
// G2b 旋钮必须是活的（每个循环各证一次）
// ---------------------------------------------------------------------------
test('#520 G2b 旋钮是活的：喂一个不同于缺省的上限 ⇒ 空闲阶梯随之变（把循环焊死在缺省上必须红）', async () => {
  // G2 只能证「缺省这一档对得上」；如果接线断在「循环里硬写了缺省常量」，G2 仍旧绿。
  // 所以每个循环再喂一个**不同于缺省**的值，看阶梯真的跟着动。
  for (const { key, codeDefault, altMax, expectIdleLadder, start } of KNOBS) {
    assert.notEqual(altMax, codeDefault, `${key}：altMax 必须与缺省不同，否则本条证不了「旋钮是活的」`);
    const fake = makeFakeSleep();
    const loop = start({ pool: makeIdlePool(), sleep: fake.sleep, env: { [key]: String(altMax) }, log: silentLog });
    try {
      const ladder = await parkAt(fake, expectIdleLadder(altMax).length, `${key}(env=${altMax})`);
      assert.deepEqual(ladder, expectIdleLadder(altMax),
        `${key}=${altMax} 的空闲阶梯应为 ${JSON.stringify(expectIdleLadder(altMax))}，` 
        + `实际 ${JSON.stringify(ladder)} ⇒ 旋钮没接到循环上（或钳位把合法值也抹了）`);
    } finally {
      loop.stop?.();
      await loop.done;
    }
  }
});

test.after(() => {});
