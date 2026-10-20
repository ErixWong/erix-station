// runner/lib/llm-models.js 单测（issue #38 Phase B2）：心跳下行模型集解析 + run 模型名决议。
// 纯函数零依赖；worker.js / agentd.js 因顶层 import erix-agent（未安装）无法在单测进程内加载，
// 故模型名覆盖逻辑抽成本模块，本文件即其 mock 层断言（对应验收「worker：带 models → 下行名」）。
//
// issue #309 切片 2 补两组：① parseHeartbeatModels 接 `context_window` / `max_output_tokens`
// （只收正整数 + 无两键时逐字节向后兼容）；② resolveModelMetadata 的 1/4 钳制判据（本单硬红线：
// 钳不对 ⇒ 每个 run 第 1 轮前 invalid_budget 全灭）。行为级（真 runToolLoop + 真 HTTP 请求体）与
// worker 源码级防漂移在 runner/test/model-metadata.test.js（那边顶层 import erix-agent）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartbeatModels, resolveRunModel, resolveModelMetadata } from '../lib/llm-models.js';

test('parseHeartbeatModels：完整下行（main/embedding/vision）按槽位解析', () => {
  const out = parseHeartbeatModels({
    models: {
      main: { model: 'gpt-4o', type: 'text' },
      embedding: { model: 'text-embedding-3', type: 'embedding' },
      vision: { model: 'gpt-4o-vision', type: 'vision' },
    },
  });
  assert.deepEqual(out, {
    main: { model: 'gpt-4o', type: 'text' },
    embedding: { model: 'text-embedding-3', type: 'embedding' },
    vision: { model: 'gpt-4o-vision', type: 'vision' },
  });
});

test('parseHeartbeatModels：仅 main（无 embedding/vision）→ 只带 main', () => {
  const out = parseHeartbeatModels({ models: { main: { model: 'claude-sonnet', type: 'text' } } });
  assert.deepEqual(out, { main: { model: 'claude-sonnet', type: 'text' } });
  assert.ok(!('embedding' in out) && !('vision' in out));
});

test('parseHeartbeatModels：兼容——无 models 字段 / models=null / 非对象 / 缺 main / 空 model → null', () => {
  assert.equal(parseHeartbeatModels({}), null, '旧 portal 不下行 → null');
  assert.equal(parseHeartbeatModels({ models: null }), null, '无配置 → null');
  assert.equal(parseHeartbeatModels({ models: 'x' }), null);
  assert.equal(parseHeartbeatModels({ models: [] }), null, '数组非法');
  assert.equal(parseHeartbeatModels({ models: { embedding: { model: 'e1', type: 'embedding' } } }), null, '缺 main → 不完整下行不采用');
  assert.equal(parseHeartbeatModels({ models: { main: { model: '', type: 'text' } } }), null, '空 model 名非法');
  assert.equal(parseHeartbeatModels(null), null);
  assert.equal(parseHeartbeatModels(undefined), null);
});

test('parseHeartbeatModels：未知槽位忽略、未知字段不污染（未知字段保持现状兼容）', () => {
  const out = parseHeartbeatModels({
    models: { main: { model: 'm1', type: 'text', extra: 1 }, rerank: { model: 'r1', type: 'rerank' } },
  });
  assert.deepEqual(out, { main: { model: 'm1', type: 'text' } }, 'rerank 等未知槽位不下发');
});

test('resolveRunModel：带下行模型集 → 用下行 main.model（真模型名，进请求体 model 字段）', () => {
  assert.equal(resolveRunModel('placeholder-model', { main: { model: 'gpt-4o', type: 'text' } }), 'gpt-4o');
  assert.equal(
    resolveRunModel('placeholder-model', { main: { model: 'deepseek-chat', type: 'text' }, embedding: { model: 'e', type: 'embedding' } }),
    'deepseek-chat',
  );
});

test('resolveRunModel：不带 models（旧 agentd / 无配置）→ 占位 config 的 model 名（现状行为）', () => {
  assert.equal(resolveRunModel('placeholder-model', null), 'placeholder-model');
  assert.equal(resolveRunModel('placeholder-model', undefined), 'placeholder-model');
  assert.equal(resolveRunModel('placeholder-model', {}), 'placeholder-model');
  assert.equal(resolveRunModel('placeholder-model', { embedding: { model: 'e', type: 'embedding' } }), 'placeholder-model');
  assert.equal(resolveRunModel('placeholder-model', { main: { model: '' } }), 'placeholder-model');
});

// ---------------------------------------------------------------------------
// issue #309 切片 2 ① + issue #316：parseHeartbeatModels 接两个元数据键（正整数归一，非法形态丢键不丢模型名）
// ---------------------------------------------------------------------------

/**
 * issue #316：**两侧镜像的表驱动 fixture**（工单 feat-261019-06）。
 * ⚠ 这份表在 `portal/test/llm.test.js` 有一份**逐行镜像**（同一个 `FIXTURES` 内容）：门户那边断言
 * 「显示与回退值」，这边断言「解析与下行形状」。两侧跑的是同一条规则
 * （`runner/lib/llm-models.js` 的 `positiveIntOrNull` ↔ `portal/src/llm.js` 的 `positiveIntOrNull`），
 * **改一侧必须改对面**，否则 #316 的病症（门户显示着窗口、runner 丢键 ⇒ 压缩静默关）会复发。
 * `accepted` = 应被归一成的正整数；`null` = 判**不可得**（整键不写，不是 0、不是 floor）。
 */
const TOKEN_FIXTURES = [
  { value: 262144, accepted: 262144, why: '正整数：原样' },
  { value: '262144', accepted: 262144, why: '#316 病症本体：数字串归一成正整数（旧行为是整键丢掉）' },
  { value: ' 262144 ', accepted: 262144, why: '带空白的数字串：同一条规则（门户旧口径就 trim）' },
  { value: '262144.0', accepted: 262144, why: '整值浮点的字符串形态：值就是 262144' },
  { value: 262144.0, accepted: 262144, why: '整值浮点（JS 里 262144.0 === 262144）：原样' },
  { value: 1000, accepted: 1000, why: '小但合法的正整数（能不能算出预算是 resolveModelMetadata 的活）' },
  { value: '1e3', accepted: 1000, why: '科学计数法数字串：值是整数 1000 ⇒ 归一（与门户旧口径一致）' },
  { value: 262144.5, accepted: null, why: '真小数 = 配错：判不可得，**不 floor**（floor 是替管理员编数）' },
  { value: '262144.5', accepted: null, why: '真小数字符串形态同样不可得' },
  { value: 0, accepted: null, why: '0 不可得（硬塞 0 会让 computeBudget 直接抛 invalid_budget）' },
  { value: -5, accepted: null, why: '负数不可得' },
  { value: 'abc', accepted: null, why: '非数字串不可得' },
  { value: '', accepted: null, why: '空串不可得' },
  { value: '   ', accepted: null, why: '空白串不可得（trim 后空）' },
  { value: null, accepted: null, why: '显式 null = 没配' },
  { value: undefined, accepted: null, why: '缺键' },
  { value: Number.NaN, accepted: null, why: 'NaN' },
  { value: Number.POSITIVE_INFINITY, accepted: null, why: 'Infinity：不是安全整数 ⇒ 不可得' },
  { value: true, accepted: null, why: '布尔' },
  { value: false, accepted: null, why: '布尔' },
  { value: {}, accepted: null, why: '对象' },
  { value: [], accepted: null, why: '数组' },
];

test('#316 parseHeartbeatModels：表驱动归一（镜像面在 portal/test/llm.test.js）——两键各自过同一条规则', () => {
  for (const { value, accepted, why } of TOKEN_FIXTURES) {
    const out = parseHeartbeatModels({
      models: { main: { model: 'm', type: 'text', context_window: value, max_output_tokens: value } },
    });
    assert.ok(out, `任何元数据形态都不得抖掉整个下行（模型名是 #38 的既有契约）：${String(value)}`);
    assert.equal(out.main.model, 'm', `main.model 必须照样解析成功：${String(value)}`);
    for (const key of ['context_window', 'max_output_tokens']) {
      if (accepted === null) {
        assert.ok(!Object.hasOwn(out.main, key),
          `${key}=${String(value)} 判**不可得** ⇒ 整键不写（不是 key: undefined、不是 0、不是 floor）：${why}`);
      } else {
        assert.ok(Object.hasOwn(out.main, key), `${key}=${String(value)} 应收下：${why}`);
        // ⚠ #316 的核心：落盘必须是**归一后的 number**，不是原字符串。下游 `Math.floor(ctx/4)`
        // 与引擎 `computeBudget({contextWindowTokens, maxOutputTokens})` 都按数字算，喂字符串就是
        // 第二套「两侧各自解释」的坑（`"262144" > floor(...)` 这类比较先错）。
        assert.equal(typeof out.main[key], 'number', `${key}=${String(value)} 落盘必须是 number：${why}`);
        assert.equal(out.main[key], accepted, `${key}=${String(value)} 必须归一成 ${accepted}：${why}`);
        assert.ok(Number.isSafeInteger(out.main[key]) && out.main[key] > 0, `归一后必须是正整数：${why}`);
      }
    }
  }
});

test('#316 parseHeartbeatModels：不可得的键整键不在（JSON 文本比 deepStrictEqual 更硬）', () => {
  const out = parseHeartbeatModels({
    models: { main: { model: 'm', type: 'text', context_window: 262144.5, max_output_tokens: 'abc' } },
  });
  assert.equal(JSON.stringify(out), '{"main":{"model":"m","type":"text"}}',
    '两个键都不可得 ⇒ 结构与「无元数据的下行」逐字节相同（#309 切片 2 钉住的向后兼容面）');
  assert.equal(resolveModelMetadata(out), null, '丢键后落到「ctx 缺失 ⇒ 不传」支路（= 现状行为）');
});

test('#316 贯通【#316 判据本体】：context_window 存成数字串 ⇒ 归一后一路到引擎，压缩真的开着', () => {
  // 修复前：`ctx:"262144"` 在解析层整键丢掉 ⇒ resolveModelMetadata 返回 null ⇒ 引擎压缩总开关不进入，
  // 而门户列表明明显示着 262144。主 agent 的探针（631bc46）：parsed 带 ctx=false → resolved=null。
  const snapshot = parseHeartbeatModels({
    models: { main: { model: 'glm-4.6', type: 'text', context_window: '262144', max_output_tokens: 32768 } },
  });
  assert.deepEqual(snapshot.main,
    { model: 'glm-4.6', type: 'text', context_window: 262144, max_output_tokens: 32768 },
    '数字串窗口必须被归一成 number 两键带下去（这里红 = #316 复发）');
  assert.equal(resolveRunModel('placeholder-model', snapshot), 'glm-4.6', '模型名语义仍不变');

  const calls = [];
  const gate = (...args) => { calls.push(args); return 1; }; // 不抛 = 引擎认为这对值能算出正预算
  const r = resolveModelMetadata(snapshot, { computeBudget: gate });
  assert.deepEqual(r,
    { context_window: 262144, max_output_tokens: 32768, clamped: false, clamped_from: 32768 },
    '数字串窗口归一后必须是「原样使用」支路（不是整对不传）');
  assert.equal(calls.length, 1, '闸必须被调到（恰好一次）');
  assert.deepEqual(calls[0], [{ contextWindowTokens: 262144, maxOutputTokens: 32768 }],
    '喂给上游闸的必须是**数字**（字符串 = 归一没做到位）');
});

test('#309 parseHeartbeatModels：main 带 context_window / max_output_tokens → 原样透传（snake_case）', () => {
  const out = parseHeartbeatModels({
    models: { main: { model: 'glm-4.6', type: 'text', context_window: 262144, max_output_tokens: 200000 } },
  });
  assert.deepEqual(out.main,
    { model: 'glm-4.6', type: 'text', context_window: 262144, max_output_tokens: 200000 },
    '两个键必须原样透传（本层**不做钳制**：200000 > 1/4 也照收，钳制是 resolveModelMetadata 的活）');
  assert.ok(!('contextWindowTokens' in out.main) && !('maxTokens' in out.main), '解析层不得提前改名');
});

test('#309 parseHeartbeatModels：embedding / vision 槽位同样接两键（不限于 main）', () => {
  const out = parseHeartbeatModels({
    models: {
      main: { model: 'm', type: 'text' },
      embedding: { model: 'e', type: 'embedding', context_window: 8192 },
      vision: { model: 'v', type: 'vision', max_output_tokens: 1024 },
    },
  });
  assert.deepEqual(out.embedding, { model: 'e', type: 'embedding', context_window: 8192 });
  assert.deepEqual(out.vision, { model: 'v', type: 'vision', max_output_tokens: 1024 });
});

test('#309 parseHeartbeatModels：非法形态（0/负数/真小数/非数字串/true/NaN）⇒ 丢该键但 main.model 照样解析', () => {
  // ⚠ #316 后这份列表里**没有**数字串与整值浮点（`"262144"` / `"1e3"` / `262144.0`）——它们现在
  // 会被归一成正整数（见上面那条表驱动用例）。完整形态表以 `TOKEN_FIXTURES` 为单一真相。
  const bad = [0, -1, -262144, 1.5, Number.NaN, 'abc', '', true, false, null, undefined, {}, []];
  for (const value of bad) {
    const out = parseHeartbeatModels({
      models: { main: { model: 'm', type: 'text', context_window: value, max_output_tokens: value } },
    });
    assert.ok(out, `非法元数据不得连带抖掉整个下行（模型名是 #38 的既有契约）：${String(value)}`);
    assert.equal(out.main.model, 'm', `main.model 必须照样解析成功：${String(value)}`);
    assert.ok(!('context_window' in out.main), `非法值必须**丢键**而不是透传：${String(value)}`);
    assert.ok(!('max_output_tokens' in out.main), `同上：${String(value)}`);
    assert.equal(resolveModelMetadata(out), null, '丢键后落到「ctx 缺失 ⇒ 不传」支路（= 现状行为）');
  }
});

test('#309 parseHeartbeatModels：无两键时返回值与改动前逐字节相同（向后兼容面）', () => {
  const out = parseHeartbeatModels({
    models: {
      main: { model: 'gpt-4o', type: 'text' },
      embedding: { model: 'text-embedding-3', type: 'embedding' },
    },
  });
  // JSON 文本比 deepStrictEqual 更硬：多一个值为 undefined 的键 deepStrictEqual 会放过。
  assert.equal(JSON.stringify(out),
    '{"main":{"model":"gpt-4o","type":"text"},"embedding":{"model":"text-embedding-3","type":"embedding"}}',
    '旧 portal（不下行元数据）看到的结构必须与 #309 之前逐字节相同');
  assert.deepEqual(out.main, { model: 'gpt-4o', type: 'text' });
});

// ---------------------------------------------------------------------------
// issue #309 切片 2 ②：resolveModelMetadata 的 1/4 钳制（决策者定稿：非法值按 1/4 兜底）
// 背背：引擎 computeBudget 在启动期**无 try/catch**（erix-agent 0.20.0
// src/loop/orchestrator.js:1141-1148），不钳 ⇒ KitError invalid_budget ⇒ 每个 run 第 1 轮前就死。
// ---------------------------------------------------------------------------

test('#309 resolveModelMetadata：ctx 与 maxOut 都合法且 ≤ floor(ctx/4) ⇒ 原样用（不钳、不告警）', () => {
  const r = resolveModelMetadata({ main: { model: 'm', context_window: 262144, max_output_tokens: 32000 } });
  assert.deepEqual(r, { context_window: 262144, max_output_tokens: 32000, clamped: false, clamped_from: 32000 });
});

test('#309 resolveModelMetadata：ctx=262144 且 maxOut=200000 ⇒ 钳到 65536，并回报「从 200000 钳到 65536」', () => {
  const r = resolveModelMetadata({ main: { model: 'm', context_window: 262144, max_output_tokens: 200000 } });
  assert.equal(r.max_output_tokens, 65536, '生效值必须是 floor(262144/4)=65536（原样透传 200000 = 本单要修的坑）');
  assert.equal(r.clamped, true, '必须回报「钳了」——worker 据此发 IPC warn');
  assert.equal(r.clamped_from, 200000, '必须回报「从多少钳到多少」的原值，否则告警写不出原值');
  assert.equal(r.context_window, 262144, '窗口本身不被改动');
});

test('#309 resolveModelMetadata：maxOut 正好等于 floor(ctx/4) ⇒ 不算被钳（边界）', () => {
  for (const ctx of [262144, 128000, 1001]) {
    const quarter = Math.floor(ctx / 4);
    const r = resolveModelMetadata({ main: { model: 'm', context_window: ctx, max_output_tokens: quarter } });
    assert.deepEqual(r, { context_window: ctx, max_output_tokens: quarter, clamped: false, clamped_from: quarter },
      `ctx=${ctx}：正好卡在上限不算钳（portal 侧 1/4 校验用的就是同一个上限，不得多告一次警）`);
  }
});

test('#309 resolveModelMetadata：maxOut 非法（缺失/0/负/小数/字符串/true/NaN）⇒ 钳成 floor(ctx/4) 并回报原值', () => {
  const bad = [undefined, null, 0, -5, 1.5, '200000', true, false, Number.NaN, '', {}, []];
  for (const value of bad) {
    const r = resolveModelMetadata({ main: { model: 'm', context_window: 262144, max_output_tokens: value } });
    assert.equal(r?.max_output_tokens, 65536, `非法 maxOut 必须按 1/4 兜底，不得透传：${String(value)}`);
    assert.equal(r.clamped, true, `非法 maxOut 也算被钳（要告警）：${String(value)}`);
    assert.equal(r.clamped_from, value, `原值要原样回报，供告警文案写「从 X 钳到 Y」：${String(value)}`);
  }
});

test('#309 resolveModelMetadata：ctx 缺失或非法 ⇒ null（不管 maxOut 多体面）= 什么都不传 = 现状', () => {
  const badCtx = [undefined, null, 0, -262144, 1.5, '262144', true, Number.NaN, '', {}];
  for (const ctx of badCtx) {
    assert.equal(resolveModelMetadata({ main: { model: 'm', context_window: ctx, max_output_tokens: 4096 } }), null,
      `ctx 非法⇒整对不传（硬塞 0 会让 computeBudget 直接抛 invalid_budget）：ctx=${String(ctx)}`);
    assert.equal(resolveModelMetadata({ main: { model: 'm', context_window: ctx } }), null,
      `ctx 缺失同样不传：${String(ctx)}`);
  }
});

test('#309 resolveModelMetadata：无下行（旧 portal / 无配置 / 无 main）⇒ null，不告警不报错', () => {
  for (const models of [null, undefined, {}, { embedding: { model: 'e', type: 'embedding', context_window: 8192 } }]) {
    assert.equal(resolveModelMetadata(models), null,
      '无 main 下行时行为与 #309 之前一致（模型名回退占位 config，不喂元数据）');
  }
});

test('#309 resolveModelMetadata：奇数窗口用 floor（不是 round/ceil），且不超 1/4', () => {
  const r = resolveModelMetadata({ main: { model: 'm', context_window: 1001, max_output_tokens: 1000 } });
  assert.equal(r.max_output_tokens, 250, 'floor(1001/4)=250，向上取整会把预算压负');
  assert.ok(r.max_output_tokens * 4 <= 1001);
  assert.equal(r.clamped, true);
  assert.equal(r.clamped_from, 1000);
});

test('#309 全链形状：心跳原文 → parseHeartbeatModels → resolveModelMetadata → 生效值（模型名语义不变）', () => {
  const snapshot = parseHeartbeatModels({
    models: { main: { model: 'glm-4.6', type: 'text', context_window: 262144, max_output_tokens: 200000 } },
  });
  assert.equal(resolveRunModel('placeholder-model', snapshot), 'glm-4.6',
    '接了元数据后 resolveRunModel 的模型名语义不得变（回归）');
  assert.equal(resolveModelMetadata(snapshot).max_output_tokens, 65536,
    '心跳原样的 200000 到引擎入参处必须是 65536');
  assert.equal(JSON.stringify(resolveModelMetadata(snapshot)),
    '{"context_window":262144,"max_output_tokens":65536,"clamped":true,"clamped_from":200000}',
    '纯函数返回值继续用 snake_case（camelCase 只许在 worker 装配那一站）');
});

// ---------------------------------------------------------------------------
// issue #309 切片 2b（工单 §3.1）：候选值还要过**上游自己**那道闸（规则 4）。
// 闸 = erix-agent 包根导出的 computeBudget({contextWindowTokens, maxOutputTokens})，
// 用**第二入参注入**——本文件继续保持零依赖（不 import erix-agent），全部用桩闸。
// 为什么必须补：ctx 合法但很小（1001 / 2000 / 2666）时 1/4 钳完预算仍非正 ⇒ 每个 run 第 1 轮前抛
// invalid_budget；兜成「不传元数据」才是可接受的后果（压缩关，run 照活）。
// 三组实测数字（真包，主 agent 与工单一致）：1001/250 → −1249 抛、2000/500 → −500 抛、
// 2666/666 → 0 抛、2667/666 → 1 活。
// ---------------------------------------------------------------------------

/** 桩闸：一律抛（= 上游算出非正预算时的形状），并记录被调次数。 */
function throwingBudget(sink = []) {
  const fn = (...args) => {
    sink.push(args);
    throw new Error('stub: Computed context budget must be positive (got -1249)');
  };
  fn.calls = sink;
  return fn;
}

/** 桩闸：一律放行，记录每次调用的**实参列表**（用于钉住「单对象 camelCase、值 = 候选值」）。 */
function recordingBudget(sink) {
  return (...args) => {
    sink.push(args);
    return 1;
  };
}

test('#309-2b resolveModelMetadata：probe 抛 ⇒ 返回 null（= 整对不传 = 现状），且**优先于**「钳了」的结论', () => {
  // 这三组**没有闸时**都会把值喂给引擎（钳后 250 / 原样 500 / 钳后 666），而引擎说预算非正 ⇒
  // 本单要堵的就是这里：交出这些值 = 该 FDE 每个 run 启动即死且不可重试。
  const combos = [
    { models: { main: { model: 'm', context_window: 1001, max_output_tokens: 1000 } }, fed: 250, why: '钳后 250 → 预算 −1249' },
    { models: { main: { model: 'm', context_window: 2000, max_output_tokens: 500 } }, fed: 500, why: '正好等于 floor(2000/4) 不算钳，仍 → 预算 −500' },
    { models: { main: { model: 'm', context_window: 2666, max_output_tokens: 667 } }, fed: 666, why: '钳后 666 → 预算正好 0（0 也是非正）' },
  ];
  for (const { models, fed, why } of combos) {
    const before = resolveModelMetadata(models);
    assert.equal(before?.max_output_tokens, fed,
      `前置事实：无闸时 ctx=${models.main.context_window} 会把 ${fed} 喂给引擎（${why}）`);
    assert.equal(resolveModelMetadata(models, { computeBudget: throwingBudget() }), null,
      `ctx=${models.main.context_window}：闸抛 ⇒ 必须是 null（交出钳后值 = 第 1 轮之前就炸）；${why}`);
  }
  // 原样支路（完全没钳）也照样要过闸：闸看的是「窗口 + 候选值」这对组合，不是「有没有被钳」。
  const passthrough = { main: { model: 'm', context_window: 262144, max_output_tokens: 32000 } };
  assert.deepEqual(resolveModelMetadata(passthrough),
    { context_window: 262144, max_output_tokens: 32000, clamped: false, clamped_from: 32000 },
    '前置：这组无闸时是原样透传');
  assert.equal(resolveModelMetadata(passthrough, { computeBudget: throwingBudget() }), null,
    '原样支路里 probe 抛同样 ⇒ null（不许做成「只有被钳了才过闸」）');
});

test('#309-2b resolveModelMetadata：probe 不抛 ⇒ 返回值与不传 probe 时逐字节相同，且按候选值调一次', () => {
  const cases = [
    { models: { main: { model: 'm', context_window: 262144, max_output_tokens: 32000 } }, expected: { context_window: 262144, max_output_tokens: 32000, clamped: false, clamped_from: 32000 } },
    { models: { main: { model: 'm', context_window: 262144, max_output_tokens: 200000 } }, expected: { context_window: 262144, max_output_tokens: 65536, clamped: true, clamped_from: 200000 } },
    { models: { main: { model: 'm', context_window: 2667, max_output_tokens: 700 } }, expected: { context_window: 2667, max_output_tokens: 666, clamped: true, clamped_from: 700 } },
  ];
  for (const { models, expected } of cases) {
    const calls = [];
    const r = resolveModelMetadata(models, { computeBudget: recordingBudget(calls) });
    assert.equal(JSON.stringify(r), JSON.stringify(expected), '闸放行 ⇒ 生效值不得被改动');
    assert.equal(JSON.stringify(r), JSON.stringify(resolveModelMetadata(models)),
      '闸放行 ⇒ 与「不传 probe」的现状逐字节相同（兼容面）');
    assert.equal(calls.length, 1, '闸必须被调到（恰好一次），否则这条守卫是空的');
    assert.deepEqual(calls[0],
      [{ contextWindowTokens: expected.context_window, maxOutputTokens: expected.max_output_tokens }],
      '调用形状：**一个**对象 + 上游 camelCase 键 + 值是**候选值**（原样或钳后），不是两个位置参数');
  }
});

test('#309-2b resolveModelMetadata：不传 probe（或注入位不是函数）⇒ 与切片 2 逐字节相同；ctx 非法支路根本不调闸', () => {
  const legacy = [
    [{ main: { model: 'm', context_window: 262144, max_output_tokens: 32000 } },
      '{"context_window":262144,"max_output_tokens":32000,"clamped":false,"clamped_from":32000}'],
    [{ main: { model: 'm', context_window: 262144, max_output_tokens: 200000 } },
      '{"context_window":262144,"max_output_tokens":65536,"clamped":true,"clamped_from":200000}'],
    [{ main: { model: 'm', context_window: 1001, max_output_tokens: 1000 } },
      '{"context_window":1001,"max_output_tokens":250,"clamped":true,"clamped_from":1000}'],
    [{ main: { model: 'm', context_window: 1001 } },
      '{"context_window":1001,"max_output_tokens":250,"clamped":true}'], // clamped_from=undefined ⇒ 键不在（与切片 2 同）
    [{ main: { model: 'm', max_output_tokens: 4096 } }, 'null'],
    [null, 'null'],
  ];
  for (const [models, json] of legacy) {
    assert.equal(JSON.stringify(resolveModelMetadata(models)), json, '不传第二入参 = 现状逐字节不变');
    assert.equal(JSON.stringify(resolveModelMetadata(models, {})), json, '空依赖对象同样跳过');
    assert.equal(JSON.stringify(resolveModelMetadata(models, { computeBudget: undefined })), json);
    assert.equal(JSON.stringify(resolveModelMetadata(models, { computeBudget: 'not-a-function' })), json,
      '注入位不是函数 ⇒ 按「没闸」处理（不许因为传了个怪东西就顺带把元数据废掉）');
  }
  // 闸在钳制**之后**、且在「ctx 非法 ⇒ null」之后：ctx 不合法的支路必须压根不碰闸（否则旧 portal
  // 的下行会被这道新守卫误伤成另一条路径）。
  for (const models of [{ main: { model: 'm', context_window: 0, max_output_tokens: 100 } },
    { main: { model: 'm', context_window: '262144', max_output_tokens: 100 } },
    { main: { model: 'm' } }, {}]) {
    const gate = throwingBudget();
    assert.equal(resolveModelMetadata(models, { computeBudget: gate }), null);
    assert.equal(gate.calls.length, 0, `ctx 非法/缺失支路不得调闸：${JSON.stringify(models)}`);
  }
});
