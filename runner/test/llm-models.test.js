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
// issue #309 切片 2 ①：parseHeartbeatModels 接两个元数据键（只收正整数，非法形态丢键不丢模型名）
// ---------------------------------------------------------------------------

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

test('#309 parseHeartbeatModels：非法形态（0/负数/小数/"1e3"/true/NaN）⇒ 丢该键但 main.model 照样解析', () => {
  const bad = [0, -1, -262144, 1.5, Number.NaN, '1e3', '262144', '', true, false, null, undefined, {}, []];
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
