// 单测：issue #506 的 copilot **第四轮（最终验收）复审③**——`envInt` 用 `Number.parseInt(raw, 10)`，
// 而它吃的是**数字前缀**：`'1e4'` → **1**、`'10000abc'` → **10000**，两种都**静默**。
//
// 为什么这条「低危但要紧」：`*_ORPHAN_RECOVERY_INTERVAL_MS=1e4` 是运维写 10000 的习惯写法，
// 被读成 **1ms** ⇒ 那条与有没有活无关的孤儿回收**每拍都跑**——正好把 #506 省下来的空闲开销原样吐回去
// （#506 的本体就是「空闲时别每拍打库」）。`'10000abc'` 则是「配了垃圾值却按 10000 生效」，
// 比直接不认更难查（现场看配置以为生效了，实际谁也没读过那串东西）。
//
// 判据形状（两个文件**同形**，所以每条都在 routes / materializer 上各跑一遍）：
//   · `'1e4'` / `'10000abc'` ⇒ 回落默认 + 恰好一条 warn（退避阶梯回到默认阶梯、回收回到 10s 一拍）；
//   · `'10000'` ⇒ 照常生效、一条 warn 都不刷；
//   · `' 10000 '` ⇒ **合法**（口径：先 trim 再整串严格匹配，前后空格放行，理由见源码注释）。
// 隔离约定（AGENTS.md / docs/testing.md）：fake pool + 临时目录 + 假时钟，不碰真库、不真等 timer。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startRoutesLoop, MAX_BACKOFF_MS_SAFE as ROUTES_MAX } from '../src/routes.js';
import { startMaterializerLoop, MAX_BACKOFF_MS_SAFE as MAT_MAX } from '../src/materializer.js';

const DEFAULT_LADDER = [250, 500, 1000, 2000, 2000, 2000]; // 默认 max=2000 的阶梯
const LOOSE_LADDER = [250, 500, 1000, 2000, 4000, 8000];   // max=10000 生效时的阶梯

// ---------------------------------------------------------------------------
// 假时钟 + fake pool（与 idle-backoff-safe-range-506b.test.js 同一形状，自带一份避免跨文件耦合夹具）
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

  #dispatch(sql) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes(this.table) && sql.includes("SET state = 'pending'")) {
      this.orphanRecoveries += 1;
      return { rows: [] };
    }
    if (sql.includes(this.table) && sql.includes("SET state = 'processing'")) {
      this.claims += 1;
      return { rows: [] }; // 永远认领 0 行 ⇒ 走空闲退避路径
    }
    return { rows: [] };
  }

  async query(sql) { return this.#dispatch(sql); }

  async connect() {
    const self = this;
    return { query: async (sql) => self.#dispatch(sql), release: () => {} };
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

const tmpdir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function recordingLog() {
  const warns = [];
  return { warns, warn: (m) => warns.push(String(m)), error: () => {}, log: () => {} };
}

const SUITES = [
  {
    name: 'routes',
    src: '../src/routes.js',
    maxSafe: ROUTES_MAX, // 见下面「越界仍回落」用例
    idleVar: 'ROUTE_IDLE_BACKOFF_MAX_MS',
    orphanVar: 'ROUTE_ORPHAN_RECOVERY_INTERVAL_MS',
    start(pool, opts) {
      const dir = tmpdir('routes-506e-');
      return { loop: startRoutesLoop(pool, ROUTES_CONFIG(dir), opts), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    },
    pool: () => new LoopFakePool({ table: 'route_outbox' }),
  },
  {
    name: 'materializer',
    src: '../src/materializer.js',
    maxSafe: MAT_MAX,
    idleVar: 'MATERIALIZE_IDLE_BACKOFF_MAX_MS',
    orphanVar: 'MATERIALIZE_ORPHAN_RECOVERY_INTERVAL_MS',
    start(pool, opts) {
      const root = tmpdir('mat-506e-');
      return { loop: startMaterializerLoop(pool, MATERIALIZER_CONFIG(root), opts), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
    },
    pool: () => new LoopFakePool({ table: 'materialize_outbox' }),
  },
];

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

/**
 * 在指定 env 下让循环空转若干拍，返回退避阶梯 / 孤儿回收次数 / warn。
 * `ticks` 默认 6（只看阶梯）；测回收节奏时放大到 12（假时钟累计 ~17s ⇒ 默认 10s 一拍能数到）。
 */
async function observe(suite, ticks = 6) {
  const fakes = makeFakeClock();
  const log = recordingLog();
  const pool = suite.pool();
  const { loop, cleanup } = suite.start(pool, { log, sleep: fakes.sleep, now: fakes.now });
  try {
    await fakes.arm();
    const ladder = [];
    for (let i = 0; i < ticks; i += 1) ladder.push(await fakes.release());
    return { ladder, warns: log.warns, recoveries: pool.orphanRecoveries, claims: pool.claims };
  } finally {
    loop.stop();
    fakes.clock.pending?.finish(true);
    await Promise.resolve(loop.done).catch(() => {});
    cleanup();
  }
}

const warnsAbout = (warns, name) => warns.filter((m) => m.includes(name));

// ---------------------------------------------------------------------------
// 退避上限旋钮：前缀误读 ⇒ 回落默认阶梯 + warn
// ---------------------------------------------------------------------------

for (const suite of SUITES) {
  test(`#${suite.name}③ ${suite.idleVar}='1e4' ⇒ 回落默认 2000（改前 parseInt 读成 1 ⇒ 阶梯被压平）且 warn`, async () => {
    await withEnv(suite.idleVar, '1e4', async () => {
      const { ladder, warns } = await observe(suite);
      assert.deepEqual(ladder, DEFAULT_LADDER,
        `必须回落到默认阶梯（实测 ${ladder.join(',')}）——改前 parseInt('1e4')=1 ⇒ idleDelayMs 夹到基准 250 ⇒ 全程 250 空转`);
      assert.equal(warnsAbout(warns, suite.idleVar).length, 1, `回落必须看得见（实测 ${JSON.stringify(warns)}）`);
      assert.match(warnsAbout(warns, suite.idleVar)[0], /严格正整数/, '要说清是「整串严格匹配」没过，而不是笼统的「不是数字」');
      assert.match(warnsAbout(warns, suite.idleVar)[0], /回落/);
    });
  });

  test(`#${suite.name}③ ${suite.idleVar}='10000abc' ⇒ 回落默认（改前静默按 10000 生效，一条 warn 都没有）`, async () => {
    await withEnv(suite.idleVar, '10000abc', async () => {
      const { ladder, warns } = await observe(suite);
      assert.deepEqual(ladder, DEFAULT_LADDER,
        `尾巴上带垃圾就必须整串不认（实测 ${ladder.join(',')}）——改前 parseInt 给出 10000 ⇒ 阶梯被放宽到 ${LOOSE_LADDER.join(',')}`);
      assert.equal(warnsAbout(warns, suite.idleVar).length, 1, '静默误读改成人人可见');
    });
  });

  test(`#${suite.name}③ ${suite.idleVar} 其它前缀形状（'+10000' / '0x10' / '1_0000' / '12.5'）⇒ 一律回落 + warn`, async () => {
    for (const raw of ['+10000', '0x10', '1_0000', '12.5']) {
      await withEnv(suite.idleVar, raw, async () => {
        const { ladder, warns } = await observe(suite);
        assert.deepEqual(ladder, DEFAULT_LADDER, `'${raw}' 不许被 parseInt 读成个数（实测 ${ladder.join(',')}）`);
        assert.equal(warnsAbout(warns, suite.idleVar).length, 1, `'${raw}' 必须 warn（实测 ${JSON.stringify(warns)}）`);
      });
    }
  });

  test(`#${suite.name}③ ${suite.idleVar}='10000' 照常生效；' 10000 ' 也算合法（trim 后严格匹配）且不刷 warn`, async () => {
    // 「前后空格算不算合法」的口径由本用例钉住：**算**（compose / env-file 里带空格很常见）。
    for (const raw of ['10000', ' 10000 ', '\t10000']) {
      await withEnv(suite.idleVar, raw, async () => {
        const { ladder, warns } = await observe(suite);
        assert.deepEqual(ladder, LOOSE_LADDER, `'${raw}' 是合法正整数，必须真的放宽阶梯（实测 ${ladder.join(',')}）`);
        assert.deepEqual(warnsAbout(warns, suite.idleVar), [], `'${raw}' 合法 ⇒ 不许刷噪声（实测 ${JSON.stringify(warns)}）`);
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 孤儿回收间隔旋钮：就是「把 #506 收益吐回去」的那一条
  // ---------------------------------------------------------------------------

  test(`#${suite.name}③ ${suite.orphanVar}='1e4' ⇒ 不再每拍回收（改前读成 1ms ⇒ 一拍一次）且 warn`, async () => {
    await withEnv(suite.orphanVar, '1e4', async () => {
      const { recoveries, warns, claims } = await observe(suite, 12);
      assert.ok(claims >= 10, `夹带：循环确实跑了多拍（claims=${claims}）`);
      assert.ok(recoveries <= 4,
        `回落成 10s 一拍后，假时钟走 ~17s 最多回收几次（实测 ${recoveries}）——改前间隔是 1ms ⇒ 几乎每拍一次（≈claims 次）`);
      assert.equal(warnsAbout(warns, suite.orphanVar).length, 1, `回落必须看得见（实测 ${JSON.stringify(warns)}）`);
      assert.match(warnsAbout(warns, suite.orphanVar)[0], /严格正整数/);
    });
  });

  test(`#${suite.name}③ ${suite.orphanVar}='10000abc' ⇒ 回落 + warn（改前静默按 10000 生效，warn 一条也没有）`, async () => {
    await withEnv(suite.orphanVar, '10000abc', async () => {
      const { warns, recoveries } = await observe(suite, 12);
      assert.equal(warnsAbout(warns, suite.orphanVar).length, 1,
        `改前 parseInt('10000abc')=10000 恰好等于默认值 ⇒ 缺陷完全静默（实测 ${JSON.stringify(warns)}）`);
      assert.ok(recoveries >= 1, `回落成默认 10s 后仍要照常回收（实测 ${recoveries}）——回落不是「关掉回收」`);
    });
  });

  test(`#${suite.name}③ ${suite.orphanVar}='10000' / ' 10000 ' ⇒ 生效且不刷 warn，回收仍按 10s 一拍`, async () => {
    for (const raw of ['10000', '  10000  ']) {
      await withEnv(suite.orphanVar, raw, async () => {
        const { warns, recoveries, claims } = await observe(suite, 12);
        assert.deepEqual(warnsAbout(warns, suite.orphanVar), [], `'${raw}' 合法 ⇒ 不许 warn（实测 ${JSON.stringify(warns)}）`);
        assert.ok(recoveries >= 1 && recoveries <= claims, `'${raw}' 下回收次数要落在正常节奏内（实测 ${recoveries}/${claims}）`);
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 源码钉：两个文件同形（别只改一个）
  // ---------------------------------------------------------------------------

  test(`#${suite.name}③ 源码钉：${suite.src} 用整串严格匹配，不再用 parseInt 读 env`, () => {
    const s = fs.readFileSync(new URL(suite.src, import.meta.url), 'utf8');
    assert.ok(s.includes('const STRICT_POSITIVE_INT_RE = /^\\d+$/;'), `${suite.src}：必须有「整串数字」的严格正则常量`);
    assert.match(s, /STRICT_POSITIVE_INT_RE\.test\(raw\) \? Number\(raw\) : Number\.NaN/, `${suite.src}：校验必须走严格正则`);
    assert.match(s, /Number\.isSafeInteger\(n\) \|\| n <= 0/, `${suite.src}：回落判据要用 isSafeInteger（一长串数字也不能溢出成 1e21）`);
    assert.doesNotMatch(s, /Number\.parseInt\(raw/, `${suite.src}：env 解析不许再用 parseInt 的前缀匹配`);
    assert.match(s, /不是严格正整数/, `${suite.src}：warn 要说清是严格性没过`);
    assert.equal(suite.maxSafe, 60_000, `${suite.src}：严格性只改「怎么读」，不许顺手改安全上限（#506b 的 60s 业务上限）`);
  });
}

test('#506e③ 严格性不许把安全上限那一条挤掉：越界仍回落 + warn（两个文件）', async () => {
  for (const suite of SUITES) {
    await withEnv(suite.idleVar, '3000000000', async () => {
      const { ladder, warns } = await observe(suite);
      assert.deepEqual(ladder, DEFAULT_LADDER, `${suite.name}：3e9 仍要回落默认（否则 #506b 的 timer 夹取白做）`);
      assert.equal(warnsAbout(warns, suite.idleVar).length, 1);
      assert.match(warnsAbout(warns, suite.idleVar)[0], /超过安全上限/);
    });
    // 一整串 25 个数字：正则过、但不是 safeInteger ⇒ 同样回落（不许变成 Infinity/1e24 进 timer）
    await withEnv(suite.idleVar, '1'.repeat(25), async () => {
      const { ladder, warns } = await observe(suite);
      assert.deepEqual(ladder, DEFAULT_LADDER, `${suite.name}：超长数字串不许当合法值（实测 ${ladder.join(',')}）`);
      assert.equal(warnsAbout(warns, suite.idleVar).length, 1, `${suite.name}：超长数字串也要 warn`);
    });
  }
});
