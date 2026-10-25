// issue #261：runner 侧 LLM 四相超时的三层钉子。
//
//   ① 纯函数单测：默认值逐键、env 覆盖、非法值回落 + warn 一次、值域不变量（永不产出 0/Infinity）。
//   ② **引擎契约（本单真正的回归门）**：把 helper 的返回对象喂给引擎 `resolveProviderTimeouts`，
//      断言 `explicitPhase === true` 且 `legacyTimeoutMs === undefined`——legacy 120s 总闸的关闭
//      就是被这件事触发的，不是被数值触发的。
//   ③ 陷阱钉：`streamTotalTimeoutMs` 没有「显式关闭」的值（undefined/null 回落 300s；0/false 原样
//      透传后被 `Math.max(0, …)` 变成「立刻超时」；Infinity 原样透传后在非流式路被 Node 钳成 1ms）。
//   ④ 源码级钉（沿用 system-prompt.test.js / termination.test.js 的「不 import worker.js」先例——
//      worker.js 顶层有 umask / process.on('message') / WORKER_READY 副作用）：worker 必须仍然把
//      `timeouts` 传给 createOpenAIProvider，防将来重构时静默丢配置。
//   ⑤ 文档钉：四个 env 名必须在 docs/env.md 里有条目（第二真相防腐，同 §8.7 的文档枚举交叉核对）。
//
// 引擎深路径导入说明：包 exports 只放行 "." / "./tools" / "./contract-tests"，
// `import 'erix-agent/src/providers/payload.js'` 直接撞 ERR_PACKAGE_PATH_NOT_EXPORTED（实测）。
// 所以先按裸名解析包入口（`import.meta.resolve('erix-agent')`，与 cwd 无关），再从包根拼深路径
// 用 file URL 导入——file URL 不经 exports 解析。包根入口/目录结构一旦搬家就 fail-closed 报错，
// 逼升级时重新核对本文件的语义断言（而不是静默跳过）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  resolveLlmTimeouts,
  DEFAULT_LLM_TIMEOUTS,
  LLM_TIMEOUT_ENV,
  MAX_TIMER_MS,
} from '../lib/llm-timeouts.js';
import { createOpenAIProvider } from 'erix-agent';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.join(RUNNER_DIR, '..');
// 引擎超时相语义的对齐版本。**本常量的作用是逼人工复核**：升 erix-agent 时必须先 diff
// `src/providers/payload.js` 与 `src/providers/timeout.js`，确认四相/legacy 口径没变再动它。
// 0.18.0 → 0.19.0 → 0.20.0 复核结果（#299）：**三个版本上这两个文件逐字节相同**
// （`diff -q` 对 0.18/0.19/0.20 两两都是 IDENTICAL），
// resolveProviderTimeouts 的 explicitPhase / legacyTimeoutMs=120_000 / streamTotal 默认 300_000
// 全部不变 ⇒ 只追版本号，下面所有断言一字未改。
// 0.20.0 → **0.22.0** 复核结果（#333）：`diff -q` 对 0.20.0（npm pack 解包）与 0.22.0 的
// `src/providers/payload.js` / `src/providers/timeout.js` / `src/providers/errors.js` 三个文件**逐字节相同**
// ⇒ 四相超时语义、legacy 120s 总闸、streamTotal 默认 300s 一字未变，仍然只追版本号（§8.27 先例）。
// 0.22.0 → **0.23.0** 复核结果（#337 升级片）：`diff -r` 对 0.22.0（npm pack 解包）与 0.23.0 的
// **整个 `src/providers/` 目录**（不只是三个文件）无任何输出 ⇒ 逐字节相同；0.23.0 的 `src/` 变更面只有
// `display/projection.js` / `loop/orchestrator.js` / `loop/resume-manager.js` / `store/file.js` /
// `store/memory.js` / `store/message-rows.js`(新增) / `tools/file-tools.js`，**providers 一个文件没动**。
// ⇒ 四相超时语义、legacy 120s 总闸、streamTotal 默认 300s 一字未变，仍然只追版本号（§8.27 先例）。
const ENGINE_VERSION_PINNED = '0.26.0';

// 决策者定稿的四相默认值（工单 /tmp/TICKET-261.md）——本文件里**唯一**的期望值来源是 helper，
// 数值本身在 ① 里逐键钉一次，改数值必须同时改 docs/env.md §10.4（⑤ 会盯）。
const EXPECTED = {
  firstByteTimeoutMs: 240_000,
  streamIdleTimeoutMs: 180_000,
  streamTotalTimeoutMs: 2_147_483_647,
  requestTimeoutMs: 300_000,
};

// ---------------------------------------------------------------------------
// 引擎侧装载（深路径，见文件头）
// ---------------------------------------------------------------------------
async function loadEngineTimeoutModules() {
  let entryUrl;
  try {
    entryUrl = import.meta.resolve('erix-agent');
  } catch (err) {
    assert.fail(`解析不到 erix-agent 包入口（${err.code ?? err.name}）——先 npm ci --prefer-offline`);
  }
  const pkgDir = path.resolve(path.dirname(fileURLToPath(entryUrl)), '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  assert.equal(
    pkg.version,
    ENGINE_VERSION_PINNED,
    `引擎已从 ${ENGINE_VERSION_PINNED} 升到 ${pkg.version}：本文件的超时相语义断言需人工复核后再更新此常量`,
  );
  const deep = async (rel) => {
    const file = path.join(pkgDir, rel);
    assert.ok(fs.existsSync(file), `引擎包结构变了，找不到 ${rel}（${file}）——超时相断言需重新定位`);
    return import(pathToFileURL(file).href);
  };
  const payload = await deep('src/providers/payload.js');
  const timeout = await deep('src/providers/timeout.js');
  assert.equal(typeof payload.resolveProviderTimeouts, 'function', 'payload.js 不再导出 resolveProviderTimeouts');
  assert.equal(typeof timeout.createProviderTimeoutContext, 'function', 'timeout.js 不再导出 createProviderTimeoutContext');
  return { resolveProviderTimeouts: payload.resolveProviderTimeouts, createProviderTimeoutContext: timeout.createProviderTimeoutContext };
}

// ---------------------------------------------------------------------------
// ① helper 纯函数
// ---------------------------------------------------------------------------
test('① 未设置任何 env 时逐键等于决策者定稿的默认值', () => {
  const t = resolveLlmTimeouts({});
  assert.deepEqual(t, EXPECTED);
  assert.deepEqual({ ...DEFAULT_LLM_TIMEOUTS }, EXPECTED);
  // streamTotalTimeoutMs 必须是 setTimeout 不溢出的最大值（不是 Infinity、不是 0、不是 300000）。
  assert.equal(t.streamTotalTimeoutMs, MAX_TIMER_MS);
  assert.equal(MAX_TIMER_MS, 2 ** 31 - 1);
});

test('① helper 只产出这四个键，且四个键都是引擎认的显式相键名', () => {
  const t = resolveLlmTimeouts({});
  assert.deepEqual(Object.keys(t).sort(), [
    'firstByteTimeoutMs', 'requestTimeoutMs', 'streamIdleTimeoutMs', 'streamTotalTimeoutMs',
  ]);
  // 键名写错（拼写漂移）= 传了等于没传，legacy 总闸悄悄回来。
  assert.deepEqual(Object.keys(LLM_TIMEOUT_ENV).sort(), Object.keys(EXPECTED).sort());
});

test('① env 覆盖对四项各自生效（含带空白的字符串）', () => {
  const t = resolveLlmTimeouts({
    ERIX_LLM_TIMEOUT_FIRST_BYTE_MS: '30000',
    ERIX_LLM_TIMEOUT_STREAM_IDLE_MS: '99000',
    ERIX_LLM_TIMEOUT_STREAM_TOTAL_MS: '900000',
    ERIX_LLM_TIMEOUT_REQUEST_MS: '45000',
  });
  assert.deepEqual(t, {
    firstByteTimeoutMs: 30_000,
    streamIdleTimeoutMs: 99_000,
    streamTotalTimeoutMs: 900_000,
    requestTimeoutMs: 45_000,
  });
  assert.equal(resolveLlmTimeouts({ ERIX_LLM_TIMEOUT_STREAM_IDLE_MS: ' 99000 ' }).streamIdleTimeoutMs, 99_000);
  // 覆盖只作用于被设的那一项，其余仍取默认（防「设一项丢三项」）。
  const one = resolveLlmTimeouts({ ERIX_LLM_TIMEOUT_STREAM_IDLE_MS: '1234' });
  assert.equal(one.firstByteTimeoutMs, EXPECTED.firstByteTimeoutMs);
  assert.equal(one.streamTotalTimeoutMs, EXPECTED.streamTotalTimeoutMs);
  assert.equal(one.requestTimeoutMs, EXPECTED.requestTimeoutMs);
});

test('① 未设置 / 空串静默取默认且不 warn（没配过不算配错）', () => {
  const warns = [];
  const t = resolveLlmTimeouts(
    { ERIX_LLM_TIMEOUT_FIRST_BYTE_MS: '', ERIX_LLM_TIMEOUT_STREAM_IDLE_MS: '   ', ERIX_LLM_TIMEOUT_REQUEST_MS: undefined },
    { warn: (name, raw, msg) => warns.push([name, raw, msg]) },
  );
  assert.equal(t.firstByteTimeoutMs, EXPECTED.firstByteTimeoutMs);
  assert.equal(t.streamIdleTimeoutMs, EXPECTED.streamIdleTimeoutMs);
  assert.equal(t.requestTimeoutMs, EXPECTED.requestTimeoutMs);
  assert.deepEqual(warns, []);
});

test('① 非法值一律回落默认 + warn 一次，且**永不抛错**（炸 run 比误配更糟）', () => {
  const bad = ['abc', '0', '-1', '-5000', 'NaN', 'Infinity', '1e999', '12abc', '0xzz', {}, [], Number.NaN];
  for (const raw of bad) {
    const warns = [];
    let t;
    assert.doesNotThrow(() => { t = resolveLlmTimeouts({ ERIX_LLM_TIMEOUT_STREAM_TOTAL_MS: raw }, { warn: (n, r, m) => warns.push(m) }); });
    assert.equal(t.streamTotalTimeoutMs, EXPECTED.streamTotalTimeoutMs, `非法值 ${String(raw)} 必须回落默认`);
    assert.equal(warns.length, 1, `非法值 ${String(raw)} 必须恰好 warn 一次`);
    assert.match(warns[0], /ERIX_LLM_TIMEOUT_STREAM_TOTAL_MS/);
  }
});

test('① `Infinity` 当非法值处理（而不是透传）——它正是本单禁用的秒死写法', () => {
  const warns = [];
  const t = resolveLlmTimeouts({ ERIX_LLM_TIMEOUT_STREAM_TOTAL_MS: 'Infinity' }, { warn: () => warns.push(1) });
  assert.equal(t.streamTotalTimeoutMs, EXPECTED.streamTotalTimeoutMs);
  assert.equal(warns.length, 1);
});

test('① 值域不变量：无论 env 给什么，四项永远落在 [1, MAX_TIMER_MS]（不可能产出 0 / Infinity / undefined）', () => {
  const fuzz = [undefined, null, '', ' ', '0', '-1', '1', '0.5', 'Infinity', '-Infinity', 'NaN', '9e999',
    '999999999999999', String(2 ** 31), String(2 ** 53), 'abc', '7', Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY];
  for (const raw of fuzz) {
    const env = {};
    for (const name of Object.values(LLM_TIMEOUT_ENV)) env[name] = raw;
    const t = resolveLlmTimeouts(env, { warn: () => {} });
    for (const [field, value] of Object.entries(t)) {
      assert.ok(Number.isFinite(value), `${field} 产出非有限值：${String(value)}（env=${String(raw)}）`);
      assert.ok(value >= 1, `${field} 产出 ${String(value)} < 1 → 会被 setTimeout(…, 0/1) 立刻杀掉（env=${String(raw)}）`);
      assert.ok(value <= MAX_TIMER_MS, `${field} 产出 ${String(value)} > ${MAX_TIMER_MS} → Node setTimeout 溢出钳成 1ms（env=${String(raw)}）`);
    }
    // 超上限的合法正数不是回落，而是**钳到上限**（用户要的是「不要总闸」，回落成 300s 反而更糟）。
    if (raw === '999999999999999') assert.equal(t.streamTotalTimeoutMs, MAX_TIMER_MS);
  }
});

test('① 同一个坏值只 warn 一次（默认 console.warn 路径的去重，跨多次解析不刷日志）', () => {
  const seen = [];
  const realWarn = console.warn;
  console.warn = (msg) => seen.push(msg);
  try {
    // 用只在测试里出现的哨兵值，避免与别的用例/别的测试进程抢去重表。
    const sentinel = '__261_dup_probe__';
    resolveLlmTimeouts({ ERIX_LLM_TIMEOUT_FIRST_BYTE_MS: sentinel });
    resolveLlmTimeouts({ ERIX_LLM_TIMEOUT_FIRST_BYTE_MS: sentinel });
    resolveLlmTimeouts({ ERIX_LLM_TIMEOUT_FIRST_BYTE_MS: sentinel });
  } finally {
    console.warn = realWarn;
  }
  assert.equal(seen.length, 1, `同一坏值应只 warn 一次，实际 ${seen.length} 次：${seen.join(' | ')}`);
  assert.match(seen[0], /\[station-runner\].*ERIX_LLM_TIMEOUT_FIRST_BYTE_MS/);
});

test('① 缺省实参取 process.env（worker 就是这么调的），且不写回 env', () => {
  const key = LLM_TIMEOUT_ENV.streamIdleTimeoutMs;
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const before = process.env[key];
  process.env[key] = '4321';
  try {
    assert.equal(resolveLlmTimeouts().streamIdleTimeoutMs, 4_321);
  } finally {
    if (had) process.env[key] = before; else delete process.env[key];
  }
  assert.equal(process.env[key], undefined);
  assert.equal(resolveLlmTimeouts(undefined, { warn: () => {} }).streamTotalTimeoutMs, EXPECTED.streamTotalTimeoutMs);
});

// ---------------------------------------------------------------------------
// ② 引擎契约（真正的回归门）
// ---------------------------------------------------------------------------
test('②【回归门】helper 的四相 ⇒ 引擎 explicitPhase=true 且 legacyTimeoutMs=undefined', async () => {
  const { resolveProviderTimeouts } = await loadEngineTimeoutModules();
  const ours = resolveLlmTimeouts({});
  const r = resolveProviderTimeouts({ timeouts: ours });
  assert.equal(r.explicitPhase, true, 'explicitPhase 必须是 true：任一显式相超时都会打开三相模式');
  assert.equal(r.legacyTimeoutMs, undefined,
    'legacyTimeoutMs 必须是 undefined——引擎 timeout.js:43-46 只有在这个前提下才不再算 legacyDeadline，\
120s 绝对总闸（issue #261 的主犯）才算被关掉');
  // 逐键核对：引擎不得把我们传的值改掉或回落成自己的默认。
  assert.equal(r.firstByteTimeoutMs, EXPECTED.firstByteTimeoutMs);
  assert.equal(r.streamIdleTimeoutMs, EXPECTED.streamIdleTimeoutMs);
  assert.equal(r.streamTotalTimeoutMs, EXPECTED.streamTotalTimeoutMs);
  assert.equal(r.requestTimeoutMs, EXPECTED.requestTimeoutMs);
});

test('② 对照组：什么都不传 = legacy 模式 = 120s 绝对总闸（这正是本单要关掉的东西）', async () => {
  const { resolveProviderTimeouts } = await loadEngineTimeoutModules();
  const legacy = resolveProviderTimeouts({});
  assert.equal(legacy.explicitPhase, false);
  assert.equal(legacy.legacyTimeoutMs, 120_000, 'legacy 总闸默认值（issue #261 现象值；0.19.0 复测未变）');
  assert.equal(legacy.requestTimeoutMs, 120_000);
  assert.equal(legacy.streamTotalTimeoutMs, 300_000, '显式模式下引擎自己的 streamTotal 默认仍是 300s');
  // 只传 legacy 入口（timeoutMs）同样不关总闸——所以本单必须传**相**超时，而不是把 120000 换大。
  assert.equal(resolveProviderTimeouts({ timeoutMs: 900_000 }).legacyTimeoutMs, 900_000);
  assert.equal(resolveProviderTimeouts({ timeoutMs: 900_000 }).explicitPhase, false);
  // 只传一项相超时也足以关闸（更正评论的「传任一即关闭」语义）；本单四项全给，留余量与可配性。
  const onePhase = resolveProviderTimeouts({ timeouts: { streamIdleTimeoutMs: 180_000 } });
  assert.equal(onePhase.explicitPhase, true);
  assert.equal(onePhase.legacyTimeoutMs, undefined);
});

test('② 真·行为门（虚拟时钟）：legacy 在 120s 掐死一条仍在回流 chunk 的流，本站四相配置下它活着', async () => {
  const { createProviderTimeoutContext, resolveProviderTimeouts } = await loadEngineTimeoutModules();
  const ours = resolveLlmTimeouts({});
  const legacyOnly = resolveProviderTimeouts({});

  // 与 openai.js:492-505 同形态的三相 entries（firstByte / streamIdle 交替 + streamTotal 剩余量）。
  const entriesFor = (timeouts, elapsed) => {
    const entries = [{
      phase: elapsed === 0 ? 'firstByte' : 'streamIdle',
      duration: elapsed === 0 ? timeouts.firstByteTimeoutMs : timeouts.streamIdleTimeoutMs,
    }];
    const remaining = timeouts.streamTotalTimeoutMs === undefined
      ? undefined
      : timeouts.streamTotalTimeoutMs - elapsed;
    if (remaining !== undefined) entries.push({ phase: 'streamTotal', duration: Math.max(0, remaining) });
    return entries;
  };

  // 20 次读取 × 每次 10s 虚拟静默 = 200s：任何一相都没超（idle 180s、total ≈24.85 天），
  // 但 legacy 的绝对死线在 120s 就到期——就是 R-2 演练里「chunk 一直在流、run 仍被杀」的形状。
  const runStream = async (timeouts) => {
    const clock = createVirtualClock();
    const ctx = createProviderTimeoutContext({ timeouts, clock });
    const seen = [];
    try {
      for (let i = 0; i < 20; i += 1) {
        let resolveRead;
        const pending = new Promise((res) => { resolveRead = res; });
        // 立即接住 rejection：虚拟时间推进到死线时 raced 会先于下面的 await 而 reject，
        // 不先挂上处理就会炸成 unhandledRejection。
        const settled = ctx.race(pending, entriesFor(timeouts, i * 10_000))
          .then((value) => ({ ok: true, value }), (err) => ({ ok: false, err }));
        await clock.advance(10_000);          // 虚拟时间推进：chunk 之间的静默期
        resolveRead({ done: false, value: `chunk-${i}` });   // chunk 到了（有返回就不算超时）
        const out = await settled;
        if (!out.ok) throw out.err;
        seen.push(out.value);
      }
      return { ok: true, chunks: seen.length };
    } catch (err) {
      return { ok: false, code: err?.code, phase: err?.phase, message: err?.message, chunks: seen.length };
    } finally {
      ctx.dispose();
    }
  };

  const legacy = await withRealTimeout(runStream(legacyOnly), 5_000, 'legacy 用例挂住（虚拟时钟没被引擎采纳？）');
  assert.equal(legacy.ok, false, `legacy 模式必须在 120s 绝对线上死掉，实际活着跑完 ${legacy.chunks ?? 0} 个 chunk`);
  assert.equal(legacy.code, 'timeout');
  assert.equal(legacy.phase, 'request', 'issue #261 的 termination.detail="request timed out" 就是这个 phase');
  assert.ok(legacy.chunks > 0, 'legacy 必须是在**有 chunk 回流**的中途被杀（否则没复刻到演练场景）');
  assert.ok(legacy.chunks < 20);

  const oursRun = await withRealTimeout(runStream(ours), 5_000, '四相用例挂住');
  assert.equal(oursRun.ok, true, `四相配置必须跑完 20 个 chunk，实际失败：${oursRun.phase} ${oursRun.message}`);
  assert.equal(oursRun.chunks, 20);
});

// ---------------------------------------------------------------------------
// ③ 陷阱钉（为什么 streamTotalTimeoutMs 只能用 2147483647）
// ---------------------------------------------------------------------------
test('③ streamTotalTimeoutMs：Infinity / 0 都被引擎**原样透传**（不做归一），所以陷阱必须在宿主侧挡掉', async () => {
  const { resolveProviderTimeouts } = await loadEngineTimeoutModules();
  const ours = { ...resolveLlmTimeouts({}) };

  // Infinity 原样透传（注意：JSON.stringify(Infinity) 会印成 null，断言必须用恒等比较）。
  const inf = resolveProviderTimeouts({ timeouts: { ...ours, streamTotalTimeoutMs: Infinity } });
  assert.ok(Object.is(inf.streamTotalTimeoutMs, Infinity), `Infinity 必须原样透传，实际 ${String(inf.streamTotalTimeoutMs)}`);
  assert.equal(inf.explicitPhase, true, 'Infinity 也算「显式相」——所以它连关闸都不如 2147483647 稳');

  // 0 原样透传（`?? 300000` 不拦 0/false）→ openai.js 的 Math.max(0, 0-elapsed)=0 → 立刻超时。
  const zero = resolveProviderTimeouts({ timeouts: { ...ours, streamTotalTimeoutMs: 0 } });
  assert.equal(zero.streamTotalTimeoutMs, 0, '0 必须原样透传（不是回落 300000）——正因为透传，它才是秒死陷阱');
  assert.equal(resolveProviderTimeouts({ timeouts: { ...ours, streamTotalTimeoutMs: false } }).streamTotalTimeoutMs, false);

  // 没有「显式关闭」这个值：undefined / null 一律回落引擎默认 300s（重型轮子 >300s 会被杀）。
  for (const absent of [undefined, null]) {
    const r = resolveProviderTimeouts({ timeouts: { ...ours, streamTotalTimeoutMs: absent } });
    assert.equal(r.streamTotalTimeoutMs, 300_000, `${String(absent)} 会回落 300s，不是关闭总闸`);
  }

  // 2147483647 是**唯一**被原样接受且不超过 Node setTimeout 上限的写法。
  const max = resolveProviderTimeouts({ timeouts: { ...ours } });
  assert.equal(max.streamTotalTimeoutMs, MAX_TIMER_MS);
  assert.ok(max.streamTotalTimeoutMs <= MAX_TIMER_MS && max.streamTotalTimeoutMs > 0);
});

test('③【实测】streamTotalTimeoutMs=0 ⇒ 流一开跑就被杀（streamTotal timed out）', async () => {
  const res = await withRealTimeout(streamProbe({ streamTotalTimeoutMs: 0 }, [0, 120, 0]), 5_000, 'streamTotal=0 探针挂住');
  assert.equal(res.ok, false, 'streamTotal=0 必须失败（值被原样透传 → setTimeout(fn, 0)）');
  assert.equal(res.code, 'timeout');
  assert.equal(res.phase, 'streamTotal');
});

test('③【实测】requestTimeoutMs=Infinity ⇒ Node setTimeout 溢出钳成 1ms ⇒ 非流式路径立刻 request timed out', async () => {
  // Node 对 > 2^31-1 / Infinity 的 delay 发 TimeoutOverflowWarning 并把延时钳成 1ms；
  // 非流式路径（openai.js chat()）把 requestTimeout 直接交给 setTimeout，不经过 normalizeDuration，
  // 所以「以为不超时」的 Infinity 在这里就是**秒死**——症状与本单要修的 120s 完全同形。
  // （测试输出里会看到 TimeoutOverflowWarning 那一行，那是陷阱真的触发了，不是噪音。）
  const res = await withRealTimeout(chatProbe({ ...resolveLlmTimeouts({}), requestTimeoutMs: Infinity }, 40), 5_000, 'chat Infinity 探针挂住');
  assert.equal(res.ok, false, 'Infinity 作为 requestTimeoutMs 必须失败（Node 把延时钳成 1ms）');
  assert.equal(res.code, 'timeout');
  assert.equal(res.phase, 'request');
  assert.ok(res.elapsedMs < 1_000, `Infinity 陷阱的表现应是「秒死」（实测 ${res.elapsedMs}ms），不是等到 300s`);

  // 同一位置换成 2147483647 就活着（其它三项与本站默认完全一致，只差这一个数）。
  const ok = await withRealTimeout(chatProbe(resolveLlmTimeouts({}), 40), 5_000, 'chat 默认值探针挂住');
  assert.equal(ok.ok, true, `默认四相下非流式路径必须成功：${ok.message}`);
});

// ---------------------------------------------------------------------------
// ④ worker.js 源码级钉（不 import worker.js：顶层有 fork 期副作用）
// ---------------------------------------------------------------------------
function readWorkerSource() {
  return fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8');
}

/** 抠出 `createOpenAIProvider({ … })` 的实参对象文本（配平花括号，跳过字符串/模板里的括号）。 */
function extractCreateOpenAIProviderArgs(src) {
  const marker = 'createOpenAIProvider({';
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, 'worker.js 必须仍在某处调 createOpenAIProvider({…})');
  let depth = 1;
  let i = start + marker.length;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\\') { i += 1; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      for (i += 1; i < src.length; i += 1) {
        if (src[i] === '\\') { i += 1; continue; }
        if (src[i] === c) break;
      }
      continue;
    }
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  assert.ok(depth === 0, 'createOpenAIProvider(… 的花括号没配平——抠取器假设的形状变了，同步本文件');
  return src.slice(start + marker.length, i);
}

test('④ worker.js 必须仍然 import 并传入 resolveLlmTimeouts（防重构静默丢配置）', () => {
  const src = readWorkerSource();
  assert.match(src, /import\s*\{\s*resolveLlmTimeouts\s*\}\s*from\s*'\.\/lib\/llm-timeouts\.js'/,
    'worker.js 必须从 ./lib/llm-timeouts.js import resolveLlmTimeouts');
  const args = extractCreateOpenAIProviderArgs(src);
  assert.match(args, /\btimeouts\s*:/, 'createOpenAIProvider 的实参里必须有 timeouts 键');
  assert.match(args, /timeouts:\s*resolveLlmTimeouts\(\s*process\.env\s*\)/,
    '必须传 resolveLlmTimeouts(process.env)——不传/传字面量都会让 legacy 120s 总闸回来（issue #261）');
});

test('④ worker.js 没有把超时数值或 Infinity 写死在调用点上（数值只有一个真相源：lib/llm-timeouts.js）', () => {
  const args = extractCreateOpenAIProviderArgs(readWorkerSource());
  assert.doesNotMatch(args, /\b(firstByte|streamIdle|streamTotal|request)Timeout(Ms)?\s*:/,
    '四相数值不得在 worker.js 里再写一遍（第二真相）');
  assert.doesNotMatch(args, /Infinity/, '调用点上不得出现 Infinity（本单实测的秒死写法）');
});

test('④ helper 自身的约：不 import 引擎、无进程级副作用（否则单测被包结构绑死）', () => {
  const helper = fs.readFileSync(path.join(RUNNER_DIR, 'lib', 'llm-timeouts.js'), 'utf8');
  assert.doesNotMatch(helper, /from\s+['"]erix-agent/, 'helper 必须是纯函数（不 import 引擎），否则单测被包结构绑死');
  assert.doesNotMatch(helper, /process\.exit|process\.on\(/, 'helper 不得有进程级副作用');
  assert.match(helper, /env\s*=\s*process\.env/, 'helper 缺省实参必须是 process.env');
});

// ---------------------------------------------------------------------------
// ⑤ 文档钉
// ---------------------------------------------------------------------------
test('⑤ docs/env.md 里必须有四个 env 条目与 2147483647 的语义说明', () => {
  const docPath = path.join(REPO_ROOT, 'docs', 'env.md');
  const doc = fs.readFileSync(docPath, 'utf8');
  for (const name of Object.values(LLM_TIMEOUT_ENV)) {
    assert.ok(doc.includes(name), `docs/env.md 缺 ${name} 条目（issue #261 的下发口径必须有登记）`);
  }
  assert.ok(doc.includes('2147483647'), 'docs/env.md 必须写清总闸用的是 2147483647 而不是 Infinity');
  assert.match(doc, /#261/, 'docs/env.md 该段要指向 issue #261');
});

// ---------------------------------------------------------------------------
// 测试内工具
// ---------------------------------------------------------------------------

/** 虚拟时钟：引擎 timeout.js 支持注入 clock（{now, setTimeout, clearTimeout}），120s 场景零等待。 */
function createVirtualClock() {
  let nowMs = 0;
  let seq = 0;
  const timers = new Set();
  const clock = {
    now: () => nowMs,
    setTimeout: (fn, delay) => {
      const d = Number(delay);
      // 复刻 Node 的溢出钳制（>2^31-1 或 NaN → 1ms），别让测试比引擎更宽容。
      const ms = !Number.isFinite(d) || d > MAX_TIMER_MS ? 1 : Math.max(0, d);
      const t = { fn, at: nowMs + ms, id: ++seq };
      timers.add(t);
      return t;
    },
    clearTimeout: (t) => { if (t) timers.delete(t); },
    async advance(ms) {
      const target = nowMs + ms;
      for (;;) {
        const due = [...timers].filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers.delete(due);
        nowMs = due.at;
        due.fn();
        await tick();
      }
      nowMs = target;
      await tick();
    },
  };
  return clock;
}

const tick = () => new Promise((res) => setImmediate(res));

/** 给 promise 套一条真实时间保险丝：虚拟时钟若失效就明确失败，而不是把测试挂死。 */
async function withRealTimeout(promise, ms, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${message}（超过 ${ms}ms 真实时间）`)), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

function sseDelta(text) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}
const SSE_DONE = 'data: [DONE]\n\n';
const encoder = new TextEncoder();

/** 用真 provider + 假 fetch 跑一次真流式读取；gaps 是各 chunk 之间的**真实**毫秒间隔。 */
async function streamProbe(timeouts, gaps) {
  let i = 0;
  const chunks = [sseDelta('hi '), sseDelta('there'), SSE_DONE];
  const body = new ReadableStream({
    pull(controller) {
      return new Promise((res) => {
        if (i >= chunks.length) { controller.close(); return res(); }
        setTimeout(() => { controller.enqueue(encoder.encode(chunks[i])); i += 1; res(); }, gaps[Math.min(i, gaps.length - 1)] ?? 0);
      });
    },
  });
  const provider = createOpenAIProvider({
    endpoint: 'https://llm.invalid/v1', apiKey: 'placeholder', model: 'probe-model', timeouts,
    fetchImpl: async () => ({ status: 200, body }),
  });
  const t0 = Date.now();
  try {
    const res = await provider.chatStream({ messages: [{ role: 'user', content: 'ping' }] });
    return { ok: true, text: res?.content?.map?.((p) => p.text).join('') ?? '', elapsedMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, code: err?.code, phase: err?.phase, message: String(err?.message ?? err), elapsedMs: Date.now() - t0 };
  }
}

/** 非流式路径探针（会话标题生成走的就是这条），delayMs 模拟上游响应耗时。 */
async function chatProbe(timeouts, delayMs) {
  const payload = JSON.stringify({ choices: [{ message: { content: '标题' }, finish_reason: 'stop' }] });
  const provider = createOpenAIProvider({
    endpoint: 'https://llm.invalid/v1', apiKey: 'placeholder', model: 'probe-model', timeouts,
    fetchImpl: async () => {
      await new Promise((res) => setTimeout(res, delayMs));
      return { status: 200, body: undefined, text: async () => payload, json: async () => JSON.parse(payload) };
    },
  });
  const t0 = Date.now();
  try {
    const res = await provider.chat({ messages: [{ role: 'user', content: 'ping' }] });
    return { ok: true, res, elapsedMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, code: err?.code, phase: err?.phase, message: String(err?.message ?? err), elapsedMs: Date.now() - t0 };
  }
}
