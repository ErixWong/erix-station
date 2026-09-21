// runner/lib/llm-models.js 单测（issue #38 Phase B2）：心跳下行模型集解析 + run 模型名决议。
// 纯函数零依赖；worker.js / agentd.js 因顶层 import erix-agent（未安装）无法在单测进程内加载，
// 故模型名覆盖逻辑抽成本模块，本文件即其 mock 层断言（对应验收「worker：带 models → 下行名」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartbeatModels, resolveRunModel } from '../lib/llm-models.js';

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
