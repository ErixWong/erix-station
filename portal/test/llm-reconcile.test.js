// 单测：llm.js 心跳路径的数据面模型名对账（station #289 / fix-261014-05a）。
// 缺陷：fde_llm_bindings.*_model_name 与 per-FDE virtual key 的 models 白名单都是绑定时快照，
//       LiteLLM 带外改名（model_info.id 不变）后两处同时过期 ⇒ 每次请求被挡，错误面是 auth。
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool + 假网关（listModels/updateKey），不发真 HTTP。
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFdeLlmHeartbeatModels, updateModel } from '../src/llm.js';

const ROW = {
  main_model_id: 'm-main', main_model_name: 'deepseek-flash',
  embedding_model_id: 'm-emb', embedding_model_name: 'text-embedding-3',
  vision_model_id: null, vision_model_name: null,
  api_key: 'sk-abcdef123456',
};

/** Strict fake pool: only the heartbeat SELECT and the reconcile UPDATE are legal; anything else throws. */
function fakePool(rows) {
  const table = rows.map((row) => ({ ...row }));
  const state = { selects: 0, updates: [] };
  return {
    state,
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (/^SELECT/i.test(text)) {
        state.selects += 1;
        return { rows: table.map((row) => ({ ...row })) };
      }
      if (/^UPDATE fde_llm_bindings/i.test(text)) {
        state.updates.push({ sql: text, params });
        const setClause = text.match(/SET\s+(.*?)\s+WHERE/i);
        if (!setClause) throw new Error(`unparsable UPDATE: ${text}`);
        for (const part of setClause[1].split(',')) {
          const trimmed = part.trim();
          if (trimmed === 'updated_at = now()') continue;
          const hit = trimmed.match(/^(\w+) = \$(\d+)$/);
          if (!hit) throw new Error(`unexpected SET fragment: ${trimmed}`);
          table[0][hit[1]] = params[Number(hit[2]) - 1];
        }
        return { rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
}

/** Fake gateway client; also serves as the injected listModels/updateKey so counters stay shared. */
function fakeGateway(models = []) {
  const state = { listCalls: 0, updateCalls: [], listError: null, updateKeyError: null };
  const gw = {
    async listModels() {
      state.listCalls += 1;
      if (state.listError) throw state.listError;
      return { data: models };
    },
    async updateKey(body) {
      state.updateCalls.push(body);
      if (state.updateKeyError) throw state.updateKeyError;
      return { key: body.key };
    },
  };
  return { gw, state };
}

const gatewayModel = (id, name) => ({ model_info: { id }, model_name: name });

/** Capture console.warn payloads emitted during fn(). */
async function captureWarnings(fn) {
  const seen = [];
  const original = console.warn;
  console.warn = (...args) => { seen.push(args); };
  try {
    const value = await fn();
    return { value, warnings: seen };
  } finally {
    console.warn = original;
  }
}

test('reconcile: 漂移 ⇒ 先 updateKey 扩白名单（新旧名并存），后只 SET 命中列，下行用新名', async () => {
  const pool = fakePool([ROW]);
  const { gw, state } = fakeGateway([gatewayModel('m-main', 'deepseek-v4'), gatewayModel('m-emb', 'text-embedding-3')]);
  const updateKeyCalls = [];
  const order = [];

  const models = await getFdeLlmHeartbeatModels(pool, 'u1', {
    gateway: gw,
    now: () => 1000,
    ttlMs: 0,
    listModels: async () => { order.push('listModels'); return gw.listModels(); },
    updateKey: async (body) => { order.push('updateKey'); updateKeyCalls.push(body); return gw.updateKey(body); },
  });

  assert.deepEqual(models, {
    main: { model: 'deepseek-v4', type: 'text' },
    embedding: { model: 'text-embedding-3', type: 'embedding' },
  }, '漂移槽位下行必须用新名，未漂移槽位不变');
  assert.equal(updateKeyCalls.length, 1, '恰一次 /key/update');
  assert.equal(updateKeyCalls[0].key, ROW.api_key, '用表里的 api_key 明文，且原地 updateKey（不轮换 key）');
  assert.deepEqual([...updateKeyCalls[0].models].sort(), ['deepseek-flash', 'deepseek-v4', 'text-embedding-3'].sort(),
    '白名单新旧名并存且去重');
  assert.equal(updateKeyCalls[0].models.length, 3, '无重复名');
  assert.deepEqual(order, ['listModels', 'updateKey'], '先取映射、再扩白名单');
  assert.equal(state.updateCalls.length, 1);

  assert.equal(pool.state.updates.length, 1, '恰一条 UPDATE 回写');
  const { sql, params } = pool.state.updates[0];
  assert.match(sql, /main_model_name = \$2/);
  assert.doesNotMatch(sql, /embedding_model_name/, '未漂移槽位的列不得出现在 SQL 里');
  assert.doesNotMatch(sql, /vision_model_name/);
  assert.match(sql, /updated_at = now\(\)/);
  assert.match(sql, /WHERE fde_id = \$1 AND state = 'active'/);
  assert.deepEqual(params, ['u1', 'deepseek-v4']);
});

test('reconcile: 多槽位漂移 ⇒ 一条 UPDATE SET 两个命中列；未配置的 embedding 列不参与', async () => {
  const pool = fakePool([{ ...ROW, embedding_model_id: null, embedding_model_name: null, vision_model_id: 'm-vis', vision_model_name: 'old-vision' }]);
  const { gw } = fakeGateway([gatewayModel('m-main', 'deepseek-v4'), gatewayModel('m-vis', 'new-vision')]);
  const calls = [];

  const models = await getFdeLlmHeartbeatModels(pool, 'u1', {
    gateway: gw,
    now: () => 1000,
    ttlMs: 0,
    listModels: () => gw.listModels(),
    updateKey: (body) => { calls.push(body); return Promise.resolve({}); },
  });

  assert.deepEqual(models, {
    main: { model: 'deepseek-v4', type: 'text' },
    vision: { model: 'new-vision', type: 'vision' },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual([...calls[0].models].sort(), ['deepseek-flash', 'old-vision', 'deepseek-v4', 'new-vision'].sort());
  assert.equal(pool.state.updates.length, 1, '多槽位漂移合并成一条 UPDATE');
  const { sql, params } = pool.state.updates[0];
  assert.match(sql, /main_model_name = \$2/);
  assert.match(sql, /vision_model_name = \$3/);
  assert.doesNotMatch(sql, /embedding_model_name/);
  assert.deepEqual(params, ['u1', 'deepseek-v4', 'new-vision']);
});

test('reconcile: 映射 TTL 内只取一次（ttlMs=0 则每次取），过期后再取', async () => {
  const pool = fakePool([ROW]);
  const { gw, state } = fakeGateway([gatewayModel('m-main', 'deepseek-v4'), gatewayModel('m-emb', 'text-embedding-3')]);
  let now = 1000;

  const first = await getFdeLlmHeartbeatModels(pool, 'u1', { gateway: gw, now: () => now, listModels: () => gw.listModels(), updateKey: () => Promise.resolve({}) });
  assert.equal(first.main.model, 'deepseek-v4');
  assert.equal(state.listCalls, 1);

  now = 1000 + 30_000; // 默认 ttlMs=60_000 之内
  await getFdeLlmHeartbeatModels(pool, 'u1', { gateway: gw, now: () => now, listModels: () => gw.listModels(), updateKey: () => Promise.resolve({}) });
  assert.equal(state.listCalls, 1, 'TTL 内第二次调用不得再取映射');

  now = 1000 + 60_001; // 过期
  await getFdeLlmHeartbeatModels(pool, 'u1', { gateway: gw, now: () => now, listModels: () => gw.listModels(), updateKey: () => Promise.resolve({}) });
  assert.equal(state.listCalls, 2, 'TTL 过期后重新取映射');
  assert.equal(pool.state.updates.length, 1, '回写一次之后不再产生新的写库');
});

test('reconcile: 无漂移 ⇒ 零 updateKey 零 UPDATE，下行用存储名', async () => {
  const pool = fakePool([ROW]);
  const { gw, state } = fakeGateway([gatewayModel('m-main', 'deepseek-flash'), gatewayModel('m-emb', 'text-embedding-3')]);

  const models = await getFdeLlmHeartbeatModels(pool, 'u1', {
    gateway: gw, now: () => 1000, ttlMs: 0, listModels: () => gw.listModels(), updateKey: () => Promise.reject(new Error('must not be called')),
  });

  assert.deepEqual(models, {
    main: { model: 'deepseek-flash', type: 'text' },
    embedding: { model: 'text-embedding-3', type: 'embedding' },
  });
  assert.equal(state.updateCalls.length, 0, '无漂移不得动 key 白名单');
  assert.equal(pool.state.updates.length, 0, '无漂移不得写库');
});

test('reconcile: updateKey 抛错 ⇒ 整笔不做（零 UPDATE、下行仍用旧名、结构化 warn）', async () => {
  const pool = fakePool([ROW]);
  const { gw } = fakeGateway([gatewayModel('m-main', 'deepseek-v4'), gatewayModel('m-emb', 'text-embedding-3')]);
  const calls = [];

  const { value: models, warnings } = await captureWarnings(() => getFdeLlmHeartbeatModels(pool, 'u1', {
    gateway: gw,
    now: () => 1000,
    ttlMs: 0,
    listModels: () => gw.listModels(),
    updateKey: (body) => { calls.push(body); return Promise.reject(Object.assign(new Error('upstream'), { httpStatus: 500 })); },
  }));

  assert.equal(calls.length, 1, '确实尝试过一次白名单写入');
  assert.equal(pool.state.updates.length, 0, '白名单没扩成功就一个字节都不回写');
  assert.equal(models.main.model, 'deepseek-flash', '宁可继续 403，也不造出 DB/key 分叉');
  const log = warnings.find(([tag]) => String(tag).includes('binding model name reconcile failed'));
  assert.ok(log, '缺结构化 warn 日志');
  assert.deepEqual(log[1].slots, ['main']);
  assert.equal(log[1].fde_id, 'u1');
  assert.equal(log[1].error_status, 500);
});

test('reconcile: model_info.id 不在映射里 ⇒ 零写库、下行旧名、warn unknown_model_id（本切片不抛错）', async () => {
  const pool = fakePool([ROW]);
  const { gw } = fakeGateway([gatewayModel('m-emb', 'text-embedding-3')]);
  const calls = [];

  const { value: models, warnings } = await captureWarnings(() => getFdeLlmHeartbeatModels(pool, 'u1', {
    gateway: gw,
    now: () => 1000,
    ttlMs: 0,
    listModels: () => gw.listModels(),
    updateKey: (body) => { calls.push(body); return Promise.resolve({}); },
  }));

  assert.equal(models.main.model, 'deepseek-flash');
  assert.equal(pool.state.updates.length, 0);
  assert.equal(calls.length, 0, '没有任何已确认的漂移就不该动 key');
  const log = warnings.find(([, payload]) => payload?.reason === 'unknown_model_id');
  assert.ok(log, '缺 unknown_model_id warn');
  assert.equal(log[1].slot, 'main');
  assert.equal(log[1].model_id, 'm-main');
});

test('reconcile: 取映射本身抛错（网关抖动）⇒ 保守放行：零写库、不抛错、下行旧名', async () => {
  const pool = fakePool([ROW]);
  const { gw, state } = fakeGateway([]);
  state.listError = Object.assign(new Error('ECONNREFUSED'), { httpStatus: 503 });

  const { value: models, warnings } = await captureWarnings(() => getFdeLlmHeartbeatModels(pool, 'u1', {
    gateway: gw,
    now: () => 1000,
    ttlMs: 0,
    listModels: () => gw.listModels(),
    updateKey: () => Promise.reject(new Error('must not be called')),
  }));

  assert.deepEqual(models, {
    main: { model: 'deepseek-flash', type: 'text' },
    embedding: { model: 'text-embedding-3', type: 'embedding' },
  }, '心跳路径不能被网关抖动拖死');
  assert.equal(pool.state.updates.length, 0);
  assert.ok(warnings.some(([tag]) => String(tag).includes('reconcile skipped')));
});

test('reconcile: 未注入 gateway ⇒ 零网关调用（internal.js / 旧调用点的兼容面）', async () => {
  const pool = fakePool([ROW]);
  const { gw, state } = fakeGateway([gatewayModel('m-main', 'deepseek-v4')]);

  const legacy = await getFdeLlmHeartbeatModels(pool, 'u1');
  assert.deepEqual(legacy, {
    main: { model: 'deepseek-flash', type: 'text' },
    embedding: { model: 'text-embedding-3', type: 'embedding' },
  }, '旧的两参调用形状行为不变');
  assert.equal(state.listCalls, 0);
  assert.equal(pool.state.updates.length, 0);

  const withNull = await getFdeLlmHeartbeatModels(pool, 'u1', { gateway: null, listModels: () => gw.listModels() });
  assert.deepEqual(withNull, legacy);
  assert.equal(state.listCalls, 0, 'gateway 缺席时注入点也不该被摸到');
  assert.equal(pool.state.updates.length, 0);
});

test('reconcile: 缺省走 getGatewayClient(gateway)（不注入 listModels/updateKey 也能对账）', async () => {
  const pool = fakePool([ROW]);
  const { gw, state } = fakeGateway([gatewayModel('m-main', 'deepseek-v4'), gatewayModel('m-emb', 'text-embedding-3')]);

  const models = await getFdeLlmHeartbeatModels(pool, 'u1', { gateway: gw, now: () => 1000, ttlMs: 0 });
  assert.equal(models.main.model, 'deepseek-v4');
  assert.equal(state.listCalls, 1);
  assert.equal(state.updateCalls.length, 1);
  assert.deepEqual([...state.updateCalls[0].models].sort(), ['deepseek-flash', 'deepseek-v4', 'text-embedding-3'].sort());
  assert.equal(pool.state.updates.length, 1);
});

test('#296: updateModel 的 name 只改 model_info.display_name，不碰数据面 model_name', async () => {
  const bodies = [];
  const client = {
    async listModels() {
      return { data: [{ model_info: { id: 'm-main' }, model_name: 'deepseek-flash' }] };
    },
    async updateModel(body) { bodies.push(body); return {}; },
  };

  await updateModel(client, 'm-main', { name: 'DeepSeek 显示名' });

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].model_info.display_name, 'DeepSeek 显示名');
  assert.equal('model_name' in bodies[0], false, 'body 顶层不得出现数据面 model_name');
  assert.equal('model_name' in bodies[0].model_info, false, 'model_info 里也不得出现 model_name');
  assert.equal(bodies[0].litellm_params, undefined, '只改显示名不应带 litellm_params');
});
