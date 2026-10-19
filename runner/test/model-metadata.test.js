// issue #309 切片 2（runner 把模型元数据喂给 erix-agent，并**显式**发 max_tokens）的
// **行为级**回归锁 + worker 源码级防漂移锁。
//
// 为什么新开一个文件而不并进 runner/test/llm-models.test.js：本文件的判据要跑**真 runToolLoop
// + 真 createOpenAIProvider**（顶层 import erix-agent），而 llm-models.test.js 的定位是「纯函数
// 零依赖」——混进去会让那十几条纯函数用例白白背上引擎加载。纯函数判据（1/4 钳制本身）留在
// llm-models.test.js，这里只测「装配出去的值在真引擎里到底生效没有」。
//
// 技法来源：
//   - runner/test/replay-policy.test.js：真引擎 + 内存 store + 桩，**且判据用从 worker.js 源码里
//     抠出来的真值**（见下面 workerEngineModelParams）——测试里再抄一份字面量的话，「删掉 worker
//     那行」这条变异就永远测不出来。
//   - runner/test/llm-timeouts.test.js：真 provider + 假 fetchImpl ⇒ 能看见**真 HTTP 请求体**，
//     于是「显式传 max_tokens」有决策者要的那种可判证据（`payload.max_tokens`，
//     erix-agent src/providers/openai.js:56 `if (maxTokens !== undefined) payload.max_tokens = maxTokens`）。
//
// ⚠ 不要 import worker.js：它顶层有 fork / process.on 副作用（工单 §4-4 明令）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runToolLoop, createOpenAIProvider } from 'erix-agent';
import { parseHeartbeatModels, resolveRunModel, resolveModelMetadata } from '../lib/llm-models.js';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(RUNNER_DIR, rel), 'utf8');
const TRANSCRIPT_KEY = 'sess-model-metadata-1';

// ---------------------------------------------------------------------------
// 1) 从 worker.js 源码抠出**真传给 runToolLoop 的**元数据入参（不是测试另抄一份字面量）
// ---------------------------------------------------------------------------

const PARAMS_MARKERS = /\/\* #309:engine-model-params:start \*\/([\s\S]*?)\/\* #309:engine-model-params:end \*\//;

/**
 * 求值 worker 的装配段：`engineModelMetadata`（resolveModelMetadata 的返回值，snake_case）
 * → 真传给引擎的 `{ modelMetadata?, maxTokens? }`。
 * 元数据缺失时 worker 走 `: {}` ⇒ 这里得到空对象 = 「什么都不传」= 现状行为；
 * 若 worker 改成「硬塞 0」，这里就会带出 0（正是变异 c 要红的地方）。
 */
function workerEngineModelParams(engineModelMetadata) {
  const src = read('worker.js');
  const block = src.match(PARAMS_MARKERS);
  assert.ok(block,
    'worker.js 必须有一对配对的 `/* #309:engine-model-params:start|end */` 标记：'
    + '标记没了 = 装配点被搬走或删了，本文件的判据会静默失去对象（宁可先红在这里）');
  return new Function('engineModelMetadata', `return {${block[1]}}`)(engineModelMetadata);
}

// ---------------------------------------------------------------------------
// 现场装配：内存 store + 真 createOpenAIProvider + 假 fetchImpl（记录真 HTTP 请求体）
// ---------------------------------------------------------------------------

function makeStore() {
  const records = new Map();
  return {
    async appendRound(key, record) {
      if (!records.has(key)) records.set(key, []);
      records.get(key).push(record);
    },
    async load(key) { return [...(records.get(key) ?? [])]; },
    async saveRunSnapshot() {},
    async loadLatestRunSnapshot() { return undefined; },
    async saveRunState() {},
    async loadRunState() { return undefined; },
    async markRunState() {},
  };
}

const encoder = new TextEncoder();

/** 一次就收尾的 SSE 应答（内容 'done' + finish_reason stop ⇒ end_turn，一轮就完）。 */
function sseResponse() {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'done' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  let i = 0;
  return {
    status: 200,
    body: new ReadableStream({
      pull(controller) {
        if (i >= chunks.length) { controller.close(); return; }
        controller.enqueue(encoder.encode(chunks[i]));
        i += 1;
      },
    }),
  };
}

/**
 * 跑一次真 runToolLoop：入参 = worker 源码抠出来的装配段（`extra` 用于变异反证时覆盖）。
 * 返回真 HTTP 请求体、事件流、终局与错误，让断言能指明「红在哪」。
 */
async function runOnce({ models, extraParams = {} }) {
  const snapshot = parseHeartbeatModels({ models });
  const engineModelMetadata = resolveModelMetadata(snapshot);
  const params = { ...workerEngineModelParams(engineModelMetadata), ...extraParams };
  const bodies = [];
  const events = [];
  const provider = createOpenAIProvider({
    endpoint: 'https://llm.invalid/v1',
    apiKey: 'placeholder',
    model: resolveRunModel('placeholder-model', snapshot),
    fetchImpl: async (url, options) => {
      bodies.push(JSON.parse(options.body));
      return sseResponse();
    },
  });
  let result;
  let error;
  try {
    result = await runToolLoop({
      provider,
      store: makeStore(),
      runId: TRANSCRIPT_KEY,
      maxRounds: 4,
      stream: true,
      completion: false,
      initialUserMessage: 'go',
      // 本桩一轮就 end_turn，不会真调工具；但 0.20.0 的装配口**强制要求** executeTool
      // （orchestrator.js:546 `assembly port is missing methods: executeTool`），缺了就测不到下游。
      executeTool: async () => { throw new Error('harness: no tool call expected'); },
      onEvent: (event) => events.push(event),
      ...params,
    });
  } catch (err) {
    error = err;
  }
  return { bodies, events, result, error, params, engineModelMetadata };
}

/** 请求体里 max_tokens 的**存在性**（不传时必须整键不在，而不是 null/0 —— 决策者的「显式传」判据）。 */
function maxTokensOf(body) {
  return { present: Object.prototype.hasOwnProperty.call(body, 'max_tokens'), value: body.max_tokens };
}

const missingEvents = (events) => events.filter((e) => e?.type === 'model_metadata_missing');

// ---------------------------------------------------------------------------
// 2) 行为级：桩收到的请求体 max_tokens === 生效值
// ---------------------------------------------------------------------------

test('#309 行为级：元数据齐 ⇒ 真请求体带 max_tokens=生效值，且**不再**发 model_metadata_missing', async () => {
  const { bodies, events, error, result } = await runOnce({
    models: { main: { model: 'glm-4.6', type: 'text', context_window: 262144, max_output_tokens: 32000 } },
  });
  assert.equal(error, undefined, `run 不该失败：${String(error?.code ?? error?.message ?? error)}`);
  assert.ok(bodies.length > 0, '桩必须收到请求（引擎真的发了）');
  const probe = maxTokensOf(bodies[0]);
  assert.equal(probe.present, true, '显式传 max_tokens 的**唯一可判证据** = 请求体里有这个键');
  assert.equal(probe.value, 32000, 'max_tokens 必须等于生效值（= 钳制后的 max_output_tokens）');
  assert.deepEqual(missingEvents(events), [],
    '喂了元数据后引擎不该再发 model_metadata_missing（发了 = 压缩总开关仍没进）');
  assert.equal(bodies[0].model, 'glm-4.6',
    '回归：接元数据不得改变 resolveRunModel 的模型名语义（下行真名进请求体 model 字段）');
  assert.equal(result?.finalText, 'done');
});

test('#309 行为级：maxOut 正好等于 floor(ctx/4) ⇒ max_tokens 就是那个边界值（不被二次改动）', async () => {
  const { bodies, error } = await runOnce({
    models: { main: { model: 'glm-4.6', type: 'text', context_window: 262144, max_output_tokens: 65536 } },
  });
  assert.equal(error, undefined);
  assert.equal(maxTokensOf(bodies[0]).value, 65536);
});

test('#309 行为级：喂会触发钳制的组合（ctx=262144, maxOut=200000）⇒ run 不失败且 max_tokens=65536', async () => {
  const { bodies, events, error, result } = await runOnce({
    models: { main: { model: 'glm-4.6', type: 'text', context_window: 262144, max_output_tokens: 200000 } },
  });
  assert.equal(error, undefined,
    `填错元数据的行必须照跑（不钳 ⇒ 引擎启动期抛 invalid_budget ⇒ 每个 run 第 1 轮前就死）；`
    + `实际：code=${String(error?.code)} message=${String(error?.message)}`);
  assert.equal(maxTokensOf(bodies[0]).value, 65536,
    '桩必须看到钳后值 65536（看到 200000 = 钳制被改成原样透传，变异 b 的红点就在这里）');
  assert.deepEqual(missingEvents(events), [], '钳后仍在喂元数据 ⇒ 压缩开关进入，不该发缺元数据事件');
  assert.equal(result?.finalText, 'done');
});

test('#309 行为级：会压负预算的元数据（ctx=100000, maxOut=95000）——钳了才活，原样透传必死 invalid_budget', async () => {
  // 这一条同时是「本单修的是真问题」的证据：不钳时引擎在**第 1 轮之前**就抛 invalid_budget。
  const models = { main: { model: 'glm-4.6', type: 'text', context_window: 100000, max_output_tokens: 95000 } };
  const clamped = await runOnce({ models });
  assert.equal(clamped.error, undefined,
    `钳到 floor(100000/4)=25000 后必须能跑；实际 code=${String(clamped.error?.code)}`);
  assert.equal(maxTokensOf(clamped.bodies[0]).value, 25000);

  const raw = await runOnce({
    models,
    // 反证：把「原样透传」显式装回去（等价变异 b 的效果），必须死在引擎启动期的预算推导上。
    extraParams: {
      modelMetadata: { contextWindowTokens: 100000, maxOutputTokens: 95000 },
      maxTokens: 95000,
    },
  });
  assert.equal(raw.error?.code, 'invalid_budget',
    `不钳时必须是 invalid_budget（红得有内容）；实际 code=${String(raw.error?.code)} `
    + `message=${String(raw.error?.message)}，请求发了 ${raw.bodies.length} 次`);
  assert.equal(raw.bodies.length, 0, 'invalid_budget 在启动期抛出 ⇒ 一次请求都不会发出去（= 第 1 轮之前就死）');
});

test('#309 行为级：ctx 缺失支路 ⇒ 请求体里**没有** max_tokens 键，且引擎发 model_metadata_missing（= 现状）', async () => {
  const { bodies, events, error, params } = await runOnce({
    models: { main: { model: 'glm-4.6', type: 'text', max_output_tokens: 4096 } },
  });
  assert.equal(error, undefined);
  assert.deepEqual(params, {},
    'ctx 读不到时 worker 必须**什么都不传**（改成硬塞 0 就红在这里；见下一条为什么不能塞 0）');
  assert.equal(maxTokensOf(bodies[0]).present, false,
    '没钳到值时请求体里必须整键不在（保持现状：输出上限退回 provider 默认/引擎 4096 口径）');
  assert.equal(missingEvents(events).length, 1,
    '这条同时证明「不传 modelMetadata = 现状」：引擎自己发**恰好一条**一次性诊断事件');
  assert.equal(bodies[0].model, 'glm-4.6', '模型名语义仍然不变');
});

test('#309 行为级反证：ctx 缺失时若硬塞 0 ⇒ 引擎 invalid_budget、一个请求都不发（所以只能「不传」）', async () => {
  const forced = await runOnce({
    models: { main: { model: 'glm-4.6', type: 'text' } },
    extraParams: {
      modelMetadata: { contextWindowTokens: 0, maxOutputTokens: 0 },
      maxTokens: 0,
    },
  });
  assert.equal(forced.error?.code, 'invalid_budget',
    'context_window: 0 过不了 computeBudget 的 `<= 0` 判据 ⇒ 「不传」支路不许改成塞 0');
  assert.equal(forced.bodies.length, 0, 'run 第 1 轮之前就死：没有任何请求体可断言');

  const statusQuo = await runOnce({ models: { main: { model: 'glm-4.6', type: 'text' } } });
  assert.equal(statusQuo.error, undefined, '同一份下行，「不传」是能跑的（= 现状行为）');
  assert.equal(missingEvents(statusQuo.events).length, 1);
});

// ---------------------------------------------------------------------------
// 3) 防漂移：camelCase 三键只在 worker 构造引擎入参那**一处**（源码级，不 import worker）
// ---------------------------------------------------------------------------

/** 剥掉注释（只剥**整行**注释与块注释，避免误伤 URL 字符串）后剩下的代码文本。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
}

const countOccurrences = (text, needle) => (typeof needle === 'string'
  ? text.split(needle).length - 1
  : (text.match(new RegExp(needle.source, 'g')) ?? []).length);

test('#309 防漂移：camelCase 三键在 worker.js 里各只出现 1 次，且全在 #309 装配段内', () => {
  const src = read('worker.js');
  const block = src.match(PARAMS_MARKERS);
  assert.ok(block, 'worker.js 少了 #309 装配段的成对标记（映射点没了 = 命名纪律无从谈起）');
  const code = stripComments(src);
  const blockCode = stripComments(block[1]);
  for (const key of ['contextWindowTokens', 'maxOutputTokens', 'maxTokens']) {
    const total = countOccurrences(code, key);
    const inside = countOccurrences(blockCode, key);
    assert.equal(total, 1,
      `worker.js 里 \`${key}\` 必须**恰好 1 次**（映射点唯一），实际 ${total} 次 = 有人另起了一处改名`);
    assert.equal(inside, 1,
      `那唯一一次必须在 \`/* #309:engine-model-params */\` 段内（\`${key}\` 实际段内 ${inside} 次）`);
  }
  // 第四个名字：决策者点名禁止的拼写不得出现在装配段里（避免又造一套同义变量）。
  // ⚠ 必须用词边界：子串匹配会被引擎自己的 `maxOutputTokens` 误伤（它开头就是 maxOut）。
  for (const alias of ['outputBudget', 'maxOut', 'outLimit']) {
    assert.equal(countOccurrences(blockCode, new RegExp(`\\b${alias}\\b`)), 0,
      `装配段里不许出现第四个名字：${alias}`);
  }
});

test('#309 防漂移：装配段确实在 runToolLoop 调用里，且 worker 走的是纯函数 + MSG.LOG（不新增事件类型）', () => {
  const src = read('worker.js');
  const callAt = src.indexOf('await runToolLoop({');
  const blockAt = src.search(PARAMS_MARKERS);
  assert.ok(callAt >= 0, 'worker.js 必须仍有一处 `await runToolLoop({`');
  assert.equal(src.indexOf('await runToolLoop({', callAt + 1), -1,
    'runToolLoop 只能有一处调用点（多一处 = 元数据入参得在两处同步，本单的锁只钉了一处）');
  assert.ok(blockAt > callAt, '#309 装配段必须在 runToolLoop 的实参对象里，不在别处');

  // 判据必须在纯函数里：worker 只 import + 调用，不许就地重算 1/4。
  assert.match(src, /import \{[^}]*\bresolveModelMetadata\b[^}]*\} from '\.\/lib\/llm-models\.js'/,
    'worker 必须从 lib/llm-models.js 引入 resolveModelMetadata（钳制住纯函数里，否则测不住）');
  assert.doesNotMatch(src, /Math\.floor\([^)]*\/\s*4\)/,
    'worker 里不许就地重算 floor(ctx/4)（判据在纯函数里；两处各算一份必然漂移）');

  // 告警走现成 IPC LOG，**不新增事件类型**（否则多出一条 run_events/U3 用户可见事件）。
  // 取「钳制告警那一段」再核内容：必须同时带原值（clamped_from）与钳后值，且就是 MSG.LOG + warn。
  const clampBranch = src.match(/if \(engineModelMetadata\?\.clamped\)\s*\{([\s\S]*?)\n\s*\} else if/);
  assert.ok(clampBranch, 'worker 必须有「if (engineModelMetadata?.clamped) { … } else if」这段告警分支');
  const clampBody = clampBranch[1];
  assert.match(clampBody, /type: MSG\.LOG/, '钳制告警必须走现成 IPC MSG.LOG（本单不新增事件类型）');
  assert.match(clampBody, /level: .warn./, '等级必须是 warn');
  assert.match(clampBody, /model metadata clamped: max_output_tokens/, '告警文案必须点名被钳的字段');
  assert.match(clampBody, /clamped_from/, '告警必须带原值（「从多少钳到多少」）');
  assert.match(clampBody, /max_output_tokens\}/, '告警必须带钳后值');
  assert.match(src, /model metadata unusable: context_window=/,
    'ctx 非法/缺失支路也必须 warn（含原因），否则「压缩被关掉」这件事再次零告警');
  assert.doesNotMatch(src, /emitEvent\(\s*['"]model_metadata/,
    '元数据告警不得走 emitEvent（本单明令不新增事件类型）');
});

test('#309 上游前提：引擎仍然用 modelMetadata/maxTokens 这两个入参名（升级 erix-agent 时本文件要一起看）', () => {
  const require = createRequire(import.meta.url);
  const pkgRoot = path.dirname(path.dirname(require.resolve('erix-agent')));
  const readUpstream = (...segments) => fs.readFileSync(path.join(pkgRoot, ...segments), 'utf8');
  const upstream = readUpstream('src', 'loop', 'budget.js');
  assert.match(upstream, /candidate\.contextWindowTokens !== undefined/,
    'erix-agent modelMetadataFor 的读点变了 ⇒ worker 的入参名要跟着改，本单的断言同步更新');
  const orchestrator = readUpstream('src', 'loop', 'orchestrator.js');
  assert.match(orchestrator, /notifyModelMetadataMissing/,
    'model_metadata_missing 诊断事件仍在 ⇒ 「不传 = 可观测」这条判据仍然成立');
  assert.match(orchestrator, /if \(maxTokens !== undefined\) requestForJudge\.maxTokens = maxTokens;/,
    '已知副作用仍在：wrap-up judge 继承宿主 maxTokens（工单 §3，不要顺手修）');
});
