// 单测：llm.js 心跳路径的数据面模型名对账（station #289 / fix-261014-05a）。
// 缺陷：fde_llm_bindings.*_model_name 与 per-FDE virtual key 的 models 白名单都是绑定时快照，
//       LiteLLM 带外改名（model_info.id 不变）后两处同时过期 ⇒ 每次请求被挡，错误面是 auth。
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool + 假网关（listModels/updateKey），不发真 HTTP。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import {
  getFdeLlmHeartbeatModels, reconcileDataPlaneNameRename, updateModel,
} from '../src/llm.js';
import { heartbeat } from '../src/internal.js';

const ROW = {
  main_model_id: 'm-main', main_model_name: 'deepseek-flash',
  embedding_model_id: 'm-emb', embedding_model_name: 'text-embedding-3',
  vision_model_id: null, vision_model_name: null,
  api_key: 'sk-abcdef123456',
};

/** Strict fake pool: only the heartbeat SELECT and the reconcile UPDATE are legal; anything else throws. */
function fakePool(rows) {
  const table = rows.map((row) => ({ fde_id: 'u1', ...row }));
  const state = { selects: 0, updates: [], affected: [{ fde_id: 'u1' }], affectedSelects: 0, affectedParams: null };
  return {
    state,
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      // #296 立即对账的「哪些绑定引用了这个 model_info.id」（只读；命中集由 state.affected 控制）
      if (/^SELECT fde_id FROM fde_llm_bindings/i.test(text)) {
        state.affectedSelects += 1;
        state.affectedParams = params;
        return { rows: state.affected.map((row) => ({ ...row })) };
      }
      if (/^SELECT/i.test(text)) {
        state.selects += 1;
        // 按 fde_id 筛（真库是 WHERE fde_id = $1）——不然多 FDE 用例里第二个绑定会看见第一个的回写。
        const hit = table.filter((row) => row.fde_id === params[0]);
        return { rows: hit.map((row) => ({ ...row })) };
      }
      if (/^UPDATE fde_llm_bindings/i.test(text)) {
        state.updates.push({ sql: text, params });
        if (state.failUpdate) throw new Error('fake db down');
        const setClause = text.match(/SET\s+(.*?)\s+WHERE/i);
        if (!setClause) throw new Error(`unparsable UPDATE: ${text}`);
        const target = table.find((row) => row.fde_id === params[0]);
        if (!target) throw new Error(`UPDATE without a matching binding row: ${params[0]}`);
        for (const part of setClause[1].split(',')) {
          const trimmed = part.trim();
          if (trimmed === 'updated_at = now()') continue;
          const hit = trimmed.match(/^(\w+) = \$(\d+)$/);
          if (!hit) throw new Error(`unexpected SET fragment: ${trimmed}`);
          target[hit[1]] = params[Number(hit[2]) - 1];
        }
        return { rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
}

/** Fake gateway client; also serves as the injected listModels/updateKey so counters stay shared. */
function fakeGateway(models = []) {
  const state = { listCalls: 0, updateCalls: [], updateModelCalls: [], listError: null, updateKeyError: null, updateModelError: null };
  const gw = {
    models, // #296：改名用例要能在两次调用之间把网关里的名字改掉（同一个 client 身份）
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
    // #296：改名用。按真网关实测语义应用：顶层 model_name 只改数据面名（**不动** model_info.display_name，
    // 也**不动** model_info.id）——探针结论见 #296 工单报告。
    async updateModel(body) {
      state.updateModelCalls.push(body);
      if (state.updateModelError) throw state.updateModelError;
      const hit = models.find((m) => String(m.model_info?.id) === String(body.model_id));
      if (!hit) throw Object.assign(new Error('model not found'), { status: 404 });
      if (body.model_name !== undefined) hit.model_name = body.model_name;
      if (body.model_info !== undefined) hit.model_info = { ...hit.model_info, ...body.model_info };
      if (body.litellm_params !== undefined) hit.litellm_params = { ...hit.litellm_params, ...body.litellm_params };
      return { model_id: hit.model_info.id };
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

// ---------------------------------------------------------------------------
// #289 切片 B1 接线断言：心跳调用点必须把 gateway 传进对账（http.js → internal.heartbeat）。
// 下面两条是「修复没被拆回休眠」的守卫：切片 A 之后对账本体一直是休眠的，因为心跳不传 gateway。
// ---------------------------------------------------------------------------

/** heartbeat 形状的最小 fake pool：只额外认容器心跳 UPDATE，其余仍走严格 fakePool。 */
function heartbeatPool(rows) {
  const pool = fakePool(rows);
  const raw = pool.query.bind(pool);
  pool.query = async (sql, params = []) => (
    /^UPDATE containers\b/i.test(sql.replace(/\s+/g, ' ').trim())
      ? { rows: [], rowCount: 1 }
      : raw(sql, params)
  );
  return pool;
}

/** 一次空 runs 的心跳：不带 llmGateway 就是接线前的调用形状（兼容面）。 */
function beat(pool, llmGateway) {
  return heartbeat(pool, {
    container: { id: 'c-1', user_id: 'u1' },
    user: { id: 'u1', login: 'alice' },
    body: { agent_version: '0.1', runs: [] },
    ...(llmGateway === undefined ? {} : { llmGateway }),
  });
}

test('#289 B1 接线：heartbeat 收到 llmGateway ⇒ 心跳路径上真的对账（listModels + updateKey + UPDATE + 下行新名）', async () => {
  const pool = heartbeatPool([ROW]);
  const { gw, state } = fakeGateway([gatewayModel('m-main', 'deepseek-v4'), gatewayModel('m-emb', 'text-embedding-3')]);

  const hb = await beat(pool, gw);

  assert.equal(hb.models.main.model, 'deepseek-v4', '心跳下行必须是新名——否则 #289 的持续 403 依旧存在');
  assert.equal(hb.models.embedding.model, 'text-embedding-3', '未漂移槽位保持存储名');
  assert.equal(state.listCalls, 1, '心跳路径确实摸到了网关（接线没被删回休眠）');
  assert.equal(state.updateCalls.length, 1, '先扩 key 白名单');
  assert.equal(state.updateCalls[0].key, ROW.api_key);
  assert.deepEqual([...state.updateCalls[0].models].sort(), ['deepseek-flash', 'deepseek-v4', 'text-embedding-3'].sort(),
    '白名单新旧名并存');
  assert.equal(pool.state.updates.length, 1, '后回写 fde_llm_bindings');
  assert.deepEqual(pool.state.updates[0].params, ['u1', 'deepseek-v4']);
});

test('#289 B1 接线：调用方必须传同一个 gateway 单例 ⇒ TTL 内第二次心跳不再打网关', async () => {
  const pool = heartbeatPool([ROW]);
  const { gw, state } = fakeGateway([gatewayModel('m-main', 'deepseek-v4'), gatewayModel('m-emb', 'text-embedding-3')]);

  await beat(pool, gw);
  const second = await beat(pool, gw);

  // 映射缓存按 client 对象身份分槽：谁在心跳路径现造 client，谁就让每次心跳多打一次 GET /model/info。
  assert.equal(state.listCalls, 1, '同一 client 身份在 TTL 内只取一次映射');
  assert.equal(state.updateCalls.length, 1, '第二次已无漂移 ⇒ 不再 updateKey');
  assert.equal(second.models.main.model, 'deepseek-v4');
});

test('#289 B1 兼容面：heartbeat 不传 llmGateway ⇒ 零网关调用、下行仍是存储名', async () => {
  const pool = heartbeatPool([ROW]);
  const { state } = fakeGateway([gatewayModel('m-main', 'deepseek-v4')]);

  const hb = await beat(pool);

  assert.equal(hb.models.main.model, 'deepseek-flash');
  assert.equal(state.listCalls, 0);
  assert.equal(pool.state.updates.length, 0);
});

test('reconcile: updateKey 成功但回写 DB 抛错 ⇒ 不抛错、下行仍用旧名、warn reason=binding_update_failed', async () => {
  const pool = fakePool([ROW]);
  pool.state.failUpdate = true;
  const { gw, state } = fakeGateway([gatewayModel('m-main', 'deepseek-v4'), gatewayModel('m-emb', 'text-embedding-3')]);

  const { value: models, warnings } = await captureWarnings(() => getFdeLlmHeartbeatModels(pool, 'u1', {
    gateway: gw,
    now: () => 1000,
    ttlMs: 0,
    listModels: () => gw.listModels(),
  }));

  assert.equal(state.updateCalls.length, 1, '白名单已扩成新旧名并存，所以旧名照样可服务');
  assert.equal(pool.state.updates.length, 1, '确实尝试过一次回写');
  assert.equal(models.main.model, 'deepseek-flash', '回写失败 ⇒ 下行保持旧名，不得出现 DB 旧名/下行新名分叉');
  assert.equal(models.embedding.model, 'text-embedding-3');
  const log = warnings.find(([tag]) => String(tag).includes('binding model name reconcile failed'));
  assert.ok(log, '缺结构化 warn 日志');
  assert.equal(log[1].reason, 'binding_update_failed', '运维照这个 reason 字面量 grep');
  assert.deepEqual(log[1].slots, ['main']);
  assert.equal(log[1].fde_id, 'u1');
});

// ---------------------------------------------------------------------------
// #289 切片 B1 端到端接线：从 HTTP 端点打进来。
// 这是 http.js 那行 `llmGateway: ctx.llmGateway` 的唯一守卫——删掉它 ⇒ 对账回到休眠；
// 把它换成现造 client ⇒ 第二次心跳的 listModels 计数变 2（TTL 缓存按 client 对象身份分槽）。
// ---------------------------------------------------------------------------
test('#289 B1 端到端：POST /api/internal/heartbeat ⇒ http 层透传 ctx.llmGateway 单例（两跳只打一次网关）', async () => {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-hb-wiring-'));
  const inner = fakePool([ROW]);
  const pool = {
    state: inner.state,
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (/^UPDATE containers\b/i.test(text)) return { rows: [], rowCount: 1 };
      if (/FROM containers c/i.test(text)) {
        return {
          rows: [{
            container_id: 'c-1', user_id: 'u1', revoked_at: null, container_status: 'running',
            fde_name: 'alice', container_name: 'erix_fde_alice', token_generation: 1,
            login: 'alice', display_name: 'Alice', email: 'a@a.test', user_status: 'active',
          }],
        };
      }
      return inner.query(sql, params);
    },
    async end() {},
  };
  const { gw, state } = fakeGateway([gatewayModel('m-main', 'deepseek-v4'), gatewayModel('m-emb', 'text-embedding-3')]);
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 900000, blockMs: 60000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 5, windowMs: 900000, perTokenMaxFailures: 5, blockMs: 60000, maxEntries: 10000 },
    kdfConcurrency: 2,
    kdfQueueLimit: 100,
    kdfQueueTimeoutMs: 30000,
    maxBodyBytes: 64 * 1024,
    maxLoginLength: 128,
    maxPasswordLength: 256,
    staticDir,
  };
  const server = createServer({ pool, config, llmGateway: gw, log: { error() {}, warn() {}, log() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const beatHttp = async () => {
    const res = await fetch(`${base}/api/internal/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wiring-token' },
      body: JSON.stringify({ agent_version: '0.1', runs: [] }),
    });
    assert.equal(res.status, 200, `心跳端点应 200（实际 ${res.status}）`);
    return res.json();
  };

  try {
    const first = await beatHttp();
    const second = await beatHttp();

    assert.equal(first.models.main.model, 'deepseek-v4', '端点下行必须已是新名（接线在）');
    assert.equal(state.listCalls, 1, '两跳共用 ctx.llmGateway 单例 ⇒ model_list 映射命中 TTL；现造 client 会变 2');
    assert.equal(state.updateCalls.length, 1, '第二跳无漂移 ⇒ 不再写白名单');
    assert.equal(inner.state.updates.length, 1, '回写只发生一次');
    assert.equal(second.models.main.model, 'deepseek-v4');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(staticDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #296：管理台「改名」拆成两个字段。
//   * `call_name` → 顶层 `model_name`（数据面：FDE 请求实际发的名字、bindings.*_model_name、
//     per-FDE key 白名单存的都是它）；
//   * `name` → `model_info.display_name`（纯展示名，语义一字未动）。
// 以及「改名成功后立即触发一次对账」——**复用**上面那条心跳路径，不重写并集逻辑。
// 三条实测事实进了断言（LiteLLM v1.103.2，dev 真机）：
//   ① 改顶层 `model_name` **不会**顺手改或清 `model_info.display_name`；
//   ② 它**不拦同名**，且同名后按名字轮询两个 deployment ⇒ 门户必须自己拦；
//   ③ 改名时 LiteLLM 自己把 key 的 `models` 重写成「只有新名」⇒ 并集是必须的那一手。
// ---------------------------------------------------------------------------

const CATALOG = () => ([
  { model_info: { id: 'm-main', display_name: '旧展示名' }, model_name: 'deepseek-flash' },
  { model_info: { id: 'm-emb', display_name: 'Embedding 3' }, model_name: 'text-embedding-3' },
]);

test('#296: call_name 只写顶层 model_name（数据面），一个字都不碰 model_info', async () => {
  const { gw, state } = fakeGateway(CATALOG());

  const model = await updateModel(gw, 'm-main', { call_name: '  deepseek-v4  ' });

  assert.equal(state.updateModelCalls.length, 1);
  const body = state.updateModelCalls[0];
  assert.equal(body.model_name, 'deepseek-v4', 'trim 后写进 PATCH 顶层 model_name');
  assert.deepEqual(Object.keys(body).sort(), ['model_id', 'model_name'],
    '只给调用名 ⇒ body 只带 model_id + model_name（多了 model_info 就是顺手改展示名，变异①）');
  assert.equal(model.model_name, 'deepseek-v4', '响应回读新调用名');
  assert.equal(model.name, '旧展示名', '展示名仍走 display_name，不跟着调用名漂');
});

test('#296: call_name 与 name 同一条 PATCH ⇒ 两个字段各写各的位置', async () => {
  const { gw, state } = fakeGateway(CATALOG());

  const model = await updateModel(gw, 'm-main', { call_name: 'new-call', name: '新展示名' });

  const body = state.updateModelCalls[0];
  assert.equal(body.model_name, 'new-call', '调用名进顶层');
  assert.equal(body.model_info.display_name, '新展示名', '展示名进 model_info');
  assert.equal(model.model_name, 'new-call');
  assert.equal(model.name, '新展示名');
});

test('#296: call_name 空串/空白/非字符串 ⇒ validation_failed + details.field=call_name，且零 PATCH', async () => {
  const { gw, state } = fakeGateway(CATALOG());

  for (const bad of ['', '   ', '\t\n', 7, true, {}, [], null]) {
    await assert.rejects(
      () => updateModel(gw, 'm-main', { call_name: bad }),
      (error) => {
        assert.equal(error.code, 'validation_failed');
        assert.deepEqual(error.details, { field: 'call_name' });
        return true;
      },
      `call_name=${JSON.stringify(bad)} 必须被拒（数据面名不许空）`,
    );
  }
  assert.equal(state.updateModelCalls.length, 0, '校验阶段就得拦住：一条 PATCH 都不许发出去');
  assert.equal(state.updateCalls.length, 0, '更不许动 key 白名单');
});

test('#296: 占用中的调用名 ⇒ 409 model_name_conflict（真网关不拦同名并会轮询 deployment ⇒ 门户拦）', async () => {
  const { gw, state } = fakeGateway(CATALOG());

  await assert.rejects(
    () => updateModel(gw, 'm-main', { call_name: 'text-embedding-3' }),
    (error) => {
      assert.equal(error.code, 'model_name_conflict');
      assert.equal(error.httpStatus, 409);
      assert.equal(error.details.field, 'call_name');
      assert.equal(error.details.call_name, 'text-embedding-3');
      assert.equal(error.details.conflicting_model_id, 'm-emb', '把撞车的模型 id 给出去，运维才知道要去动谁');
      // 但给人看的文案不得是主键 id（真实网关那是 UUID）：用撞车模型的名字。
      assert.match(error.message, /已被模型「/, error.message);
      assert.ok(!error.message.includes('m-emb'), `文案里不该出现主键：${error.message}`);
      return true;
    },
  );
  assert.equal(state.updateModelCalls.length, 0, '拦在写之前：网关里两个名字都没动');

  // 改成自己现在的名字不算冲突（幂等提交、以及「只改展示名顺带把调用名原样带回」的表单形状）
  const same = await updateModel(gw, 'm-main', { call_name: 'deepseek-flash', name: '只改展示名' });
  assert.equal(same.model_name, 'deepseek-flash');
  assert.equal(same.name, '只改展示名');
});

test('#296: 改名后的立即对账 ⇒ 复用 #289 那条路径（先 updateKey 扩并集、后回写 bindings）', async () => {
  const pool = fakePool([ROW]);
  const { gw, state } = fakeGateway(CATALOG());
  // 改名已在网关落定（updateModel 的产物），库里还是旧名 ⇒ 这就是漂移
  gw.models[0].model_name = 'deepseek-v4';
  const order = [];

  const outcome = await reconcileDataPlaneNameRename(pool, gw, 'm-main', {
    listModels: async () => { order.push('listModels'); return gw.listModels(); },
    updateKey: async (body) => { order.push('updateKey'); return gw.updateKey(body); },
  });

  assert.equal(outcome.status, 'reconciled');
  assert.deepEqual(outcome.bindings, ['u1']);
  assert.deepEqual(order, ['listModels', 'updateKey'], '先取映射、再扩白名单（顺序红线同心跳对账）');
  assert.equal(state.updateCalls.length, 1, '恰一次 /key/update');
  assert.equal(state.updateCalls[0].key, ROW.api_key);
  assert.deepEqual([...state.updateCalls[0].models].sort(), ['deepseek-flash', 'deepseek-v4', 'text-embedding-3'].sort(),
    '白名单 = 新旧名并集（LiteLLM 改名时自己只留新名，旧名靠这里兜回来）');
  assert.equal(pool.state.updates.length, 1, '后回写 fde_llm_bindings');
  assert.deepEqual(pool.state.updates[0].params, ['u1', 'deepseek-v4']);
  assert.match(pool.state.updates[0].sql, /main_model_name = \$2/);
  assert.deepEqual(pool.state.affectedParams, ['m-main'], '按 model_info.id 找受影响绑定（名字可改、id 稳定）');
});

test('#296: 立即对账必须绕开改名前那份 TTL 映射，且 N 个受影响绑定只打一次 GET /model/info', async () => {
  const pool = fakePool([
    { fde_id: 'u1', ...ROW },
    { fde_id: 'u2', ...ROW, api_key: 'sk-abcdef123457' },
  ]);
  pool.state.affected = [{ fde_id: 'u1' }, { fde_id: 'u2' }];
  const { gw, state } = fakeGateway(CATALOG());

  // 改名**前**先跑一次心跳 ⇒ 模块级 TTL 缓存里存着旧名，client 身份与后面完全同一个
  await getFdeLlmHeartbeatModels(pool, 'u1', { gateway: gw });
  assert.equal(state.listCalls, 1);
  gw.models[0].model_name = 'deepseek-v4';

  const outcome = await reconcileDataPlaneNameRename(pool, gw, 'm-main');

  assert.deepEqual(outcome.bindings, ['u1', 'u2']);
  assert.equal(state.listCalls, 2,
    '改名后必须重取一次映射（拿旧映射会判成「没漂移」⇒ 空对账，改了名仍 403）；但两个绑定合起来只多打这一趟');
  assert.equal(state.updateCalls.length, 2, '两个受影响 FDE 各扩一次白名单');
  assert.deepEqual([...new Set(state.updateCalls.map((call) => call.key))].sort(), [ROW.api_key, 'sk-abcdef123457'],
    '各用各的 per-FDE 虚拟 key（不是拿第一个 key 写两遍）');
  assert.equal(pool.state.updates.length, 2);
  assert.deepEqual([...new Set(pool.state.updates.map((u) => u.params[0]))].sort(), ['u1', 'u2']);
});

test('#296: 没有 FDE 引用这个模型 ⇒ 零网关写；gateway 缺席 ⇒ skipped（接线拆掉时的形状）', async () => {
  const pool = fakePool([ROW]);
  pool.state.affected = [];
  const { gw, state } = fakeGateway(CATALOG());
  gw.models[0].model_name = 'deepseek-v4';

  const idle = await reconcileDataPlaneNameRename(pool, gw, 'm-orphan');
  assert.deepEqual(idle, { status: 'no_bindings', bindings: [] });
  assert.equal(state.listCalls, 0, '没人用的模型不必打网关');
  assert.equal(pool.state.updates.length, 0);

  const unhooked = await reconcileDataPlaneNameRename(pool, null, 'm-main', {
    listModels: () => { throw new Error('gateway 缺席时注入点也不该被摸到'); },
  });
  assert.equal(unhooked.status, 'skipped');
  assert.equal(unhooked.reason, 'no_gateway_client');
  assert.deepEqual(unhooked.bindings, []);
});

test('#296: 立即对账整条不抛错（改名已落定，不得把 PATCH 拖成 500）', async () => {
  const pool = fakePool([ROW]);
  pool.state.failUpdate = true;
  const { gw, state } = fakeGateway(CATALOG());
  gw.models[0].model_name = 'deepseek-v4';

  const { value, warnings } = await captureWarnings(() => reconcileDataPlaneNameRename(pool, gw, 'm-main'));

  assert.equal(value.status, 'reconciled', '回写失败 = 白名单已双名的安全态，不是抛错');
  assert.ok(warnings.some(([tag]) => String(tag).includes('binding model name reconcile failed')),
    '沿用 #289 那条 warn 口径（运维 grep 前缀不变）');

  // 连「哪些绑定受影响」这条 SELECT 都失败 ⇒ skipped + 自己的 warn，同样不抛
  const lookupDown = fakePool([ROW]);
  lookupDown.state.affected = [{ fde_id: 'u1' }];
  const rawQuery = lookupDown.query.bind(lookupDown);
  lookupDown.query = async (sql, params) => (
    /SELECT fde_id FROM fde_llm_bindings/.test(sql) ? Promise.reject(new Error('db down')) : rawQuery(sql, params)
  );
  const { value: skipped, warnings: w2 } = await captureWarnings(() => reconcileDataPlaneNameRename(lookupDown, gw, 'm-main'));
  assert.deepEqual(skipped, { status: 'skipped', reason: 'binding_lookup_failed', bindings: [] });
  assert.ok(w2.some(([, payload]) => payload?.reason === 'binding_lookup_failed'));
  assert.equal(state.updateCalls.length, 1, '全程没有第二次白名单写入（失败的这次没走到 key）');
});

// ---------------------------------------------------------------------------
// #296 接线断言：PATCH /api/admin/llm/models/:id 带 call_name ⇒ http 层必须把 **ctx.llmGateway
// 单例**喂给立即对账。把它传成 null（或整段删掉）⇒ 下面第一条红（白名单并集与回写都不发生）。
// ---------------------------------------------------------------------------

/** 只额外认「admin 会话查表」的严格 fake pool，其余仍走 fakePool。 */
function adminPool(rows, token) {
  const inner = fakePool(rows);
  return {
    state: inner.state,
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (/FROM login_sessions s JOIN users u/i.test(text)) {
        return {
          rows: params[0] === hashToken(token)
            ? [{
              id: 'u1', login: 'root', display_name: 'root', role: 'admin', fde_name: null,
              auth_source: 'local', status: 'active', must_change_password: false,
              session_id: 'ls-296', expires_at: new Date(Date.now() + 3_600_000), last_seen_at: new Date(),
            }]
            : [],
        };
      }
      return inner.query(sql, params);
    },
    async end() {},
  };
}

function adminServerConfig(staticDir) {
  return {
    cookie: cookieSettings('dev-296', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 900000, blockMs: 60000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 5, windowMs: 900000, perTokenMaxFailures: 5, blockMs: 60000, maxEntries: 10000 },
    kdfConcurrency: 2,
    kdfQueueLimit: 100,
    kdfQueueTimeoutMs: 30000,
    maxBodyBytes: 64 * 1024,
    maxLoginLength: 128,
    maxPasswordLength: 256,
    staticDir,
  };
}

async function withAdminApi(handler) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-296-admin-'));
  const token = 'tok-296-admin';
  const config = adminServerConfig(staticDir);
  const server = createServer({ pool: handler.pool, config, llmGateway: handler.gateway, log: { error() {}, warn() {}, log() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await handler.run({
      base: `http://127.0.0.1:${server.address().port}`,
      cookie: `${config.cookie.name}=${token}`,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(staticDir, { recursive: true, force: true });
  }
}

test('#296 端到端：PATCH call_name ⇒ 顶层 model_name 落网关 + 立刻铺并集与回写；只改展示名则零对账', async () => {
  const pool = adminPool([ROW], 'tok-296-admin');
  const { gw, state } = fakeGateway(CATALOG());

  await withAdminApi({ pool, gateway: gw, run: async ({ base, cookie }) => {
    const patch = (body) => fetch(`${base}/api/admin/llm/models/m-main`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

    // ① 只改展示名（`name`）⇒ 数据面一字不动、零 key 白名单写入（误导面不许复活成「半条传播」）
    const displayOnly = await patch({ name: '只改展示名' });
    assert.equal(displayOnly.status, 200);
    assert.equal((await displayOnly.json()).model.name, '只改展示名');
    assert.equal(state.updateCalls.length, 0, '没改调用名就不该去动 key 白名单');
    assert.equal(pool.state.updates.length, 0);

    // ② 改调用名 ⇒ 顶层 model_name 落网关，并且**本次请求内**就完成「先并集、后回写」
    const renamed = await patch({ call_name: 'deepseek-v4' });
    assert.equal(renamed.status, 200);
    const body = (await renamed.json()).model;
    assert.equal(body.model_name, 'deepseek-v4', '响应回读新调用名');
    assert.equal(body.name, '只改展示名', '展示名不跟着动');
    const renameCalls = state.updateModelCalls.filter((call) => call.model_name === 'deepseek-v4');
    assert.equal(renameCalls.length, 1);
    assert.equal('model_info' in renameCalls[0], false, '改调用名不得附带 model_info');
    assert.equal(state.updateCalls.length, 1, '改名这一次请求内就铺了白名单（不等心跳 15s + TTL 60s）');
    assert.deepEqual([...state.updateCalls[0].models].sort(), ['deepseek-flash', 'deepseek-v4', 'text-embedding-3'].sort());
    assert.equal(pool.state.updates.length, 1, '后回写 fde_llm_bindings');
    assert.deepEqual(pool.state.updates[0].params, ['u1', 'deepseek-v4']);
  } });
});

test('#296 端到端：同名调用名被 409 挡住，且不留半截状态', async () => {
  const pool = adminPool([ROW], 'tok-296-admin');
  const { gw, state } = fakeGateway(CATALOG());

  await withAdminApi({ pool, gateway: gw, run: async ({ base, cookie }) => {
    const res = await fetch(`${base}/api/admin/llm/models/m-main`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ call_name: 'text-embedding-3' }),
    });
    assert.equal(res.status, 409);
    const err = await res.json();
    assert.equal(err.error.code, 'model_name_conflict');
    assert.equal(err.error.details.field, 'call_name');
    assert.equal(err.error.details.conflicting_model_id, 'm-emb');
    assert.equal(state.updateModelCalls.length, 0, '没写网关 ⇒ 也不会有第二次请求里的半截传播');
    assert.equal(state.updateCalls.length, 0);
    assert.equal(pool.state.updates.length, 0);
  } });
});

// ---------------------------------------------------------------------------
// #309 切片 1：心跳下行的模型元数据（只 main 槽位，只在非 null 时带键）。
// 决策者定稿见 issue #309 §2.3：值与门户模型列表同一来源（同一个 `toModel` 语义），且必须跟
// **对账后的新名**取自同一个 deployment；没值就整个键不出现，别写 `key: null`。
// ---------------------------------------------------------------------------

/** 带元数据的目录条目：窗口/预算在 `model_info`，legacy 的 `max_tokens` 在 `litellm_params`。 */
const metaModel = (id, name, { contextWindow = null, maxOutputTokens = null, legacyMaxTokens = null } = {}) => ({
  model_info: {
    id,
    ...(contextWindow == null ? {} : { context_window: contextWindow }),
    ...(maxOutputTokens == null ? {} : { max_output_tokens: maxOutputTokens }),
  },
  model_name: name,
  ...(legacyMaxTokens == null ? {} : { litellm_params: { model: `upstream/${id}`, max_tokens: legacyMaxTokens } }),
});

test('#309 心跳下行：main 带 context_window + max_output_tokens，且取的是**对账后新名**那个 deployment', async () => {
  const pool = fakePool([ROW]);
  // binding 存量名是 deepseek-flash，而目录里这个名字现在属于**另一个**部署（8192/2048）；
  // m-main 的真名是 deepseek-v4（200000/50000）⇒ 按存量旧名取就带错部署，本用例立刻红。
  const { gw, state } = fakeGateway([
    metaModel('m-main', 'deepseek-v4', { contextWindow: 200000, maxOutputTokens: 50000 }),
    metaModel('m-other', 'deepseek-flash', { contextWindow: 8192, maxOutputTokens: 2048 }),
    metaModel('m-emb', 'text-embedding-3', { contextWindow: 8191, maxOutputTokens: 2047 }),
  ]);

  const models = await getFdeLlmHeartbeatModels(pool, 'u1', {
    gateway: gw,
    now: () => 1000,
    ttlMs: 0,
    listModels: () => gw.listModels(),
    updateKey: () => Promise.resolve({}),
  });

  assert.deepEqual(models.main, {
    model: 'deepseek-v4', type: 'text', context_window: 200000, max_output_tokens: 50000,
  }, 'main 带两个元数据字段，且值来自对账后的新名所在的那个部署');
  assert.deepEqual(models.embedding, { model: 'text-embedding-3', type: 'embedding' },
    'embedding / vision 不带元数据（切片 1 只给 main）');
  assert.equal(Object.hasOwn(models.embedding, 'context_window'), false);
  assert.equal(Object.hasOwn(models.embedding, 'max_output_tokens'), false);
  assert.equal(state.listCalls, 1, '元数据必须复用对账那一次 GET /model/info，不得新增网关调用');
});

test('#309 心跳下行：只有 litellm_params.max_tokens 的存量部署，max_output_tokens 走同一条回退链', async () => {
  const pool = fakePool([ROW]);
  const { gw } = fakeGateway([
    metaModel('m-main', 'deepseek-flash', { contextWindow: 32768, legacyMaxTokens: 4096 }),
    metaModel('m-emb', 'text-embedding-3'),
  ]);

  const models = await getFdeLlmHeartbeatModels(pool, 'u1', {
    gateway: gw,
    now: () => 1000,
    ttlMs: 0,
    listModels: () => gw.listModels(),
    updateKey: () => Promise.reject(new Error('must not be called')),
  });

  assert.deepEqual(models.main, {
    model: 'deepseek-flash', type: 'text', context_window: 32768, max_output_tokens: 4096,
  }, 'model_info 里没有 max_output_tokens 时回退到 litellm_params.max_tokens（与门户列表同一口径）');
});

test('#309 切片1.5 行为变化：配了窗口但从未手填预算的存量模型 ⇒ main 开始带 ctx + max_output_tokens=floor(ctx/4)', async () => {
  // 这就是本单唯一的行为变化（有意）：切片 1 里这种模型两个键都不出现 ⇒ runner 拿不到元数据 ⇒
  // 引擎压缩开关关着（#309 事故的形态）。回退生效后它会开始带两个键。
  const pool = fakePool([ROW]);
  const { gw } = fakeGateway([
    metaModel('m-main', 'deepseek-flash', { contextWindow: 262144 }),
    metaModel('m-emb', 'text-embedding-3'),
  ]);
  const models = await getFdeLlmHeartbeatModels(pool, 'u1', {
    gateway: gw, now: () => 1000, ttlMs: 0, listModels: () => gw.listModels(), updateKey: () => Promise.resolve({}),
  });
  assert.deepEqual(models.main, {
    model: 'deepseek-flash', type: 'text', context_window: 262144, max_output_tokens: 65536,
  }, 'model_info 里没有 max_output_tokens ⇒ 心跳带的是同一个回退生效值（不在心跳里另算一次除法）');
  assert.equal(models.main.max_output_tokens, Math.floor(models.main.context_window / 4),
    '下行值与下行窗口同源（同一个 toModel 生效值）');
});

test('#309 心跳下行：连 context_window 都没配 ⇒ 两键都不出现（不是 key: null）；只配预算也只出现预算', async () => {
  const bare = fakePool([ROW]);
  const { gw: bareGw } = fakeGateway([metaModel('m-main', 'deepseek-flash'), metaModel('m-emb', 'text-embedding-3')]);
  const bareModels = await getFdeLlmHeartbeatModels(bare, 'u1', {
    gateway: bareGw, now: () => 1000, ttlMs: 0, listModels: () => bareGw.listModels(), updateKey: () => Promise.resolve({}),
  });
  assert.deepEqual(bareModels.main, { model: 'deepseek-flash', type: 'text' });
  assert.deepEqual(Object.keys(bareModels.main), ['model', 'type'],
    '算不出回退值（连窗口都没有）就整个键都不出现：宁可不带，也别下发一个 0 或 null');

  // 两个键各自独立：只配了预算（没窗口 ⇒ 算不出但也不需要算）就只出现预算，不补 null 占位。
  const partial = fakePool([ROW]);
  const { gw: partialGw } = fakeGateway([
    metaModel('m-main', 'deepseek-flash', { maxOutputTokens: 2048 }),
    metaModel('m-emb', 'text-embedding-3'),
  ]);
  const partialModels = await getFdeLlmHeartbeatModels(partial, 'u1', {
    gateway: partialGw, now: () => 2000, ttlMs: 0, listModels: () => partialGw.listModels(), updateKey: () => Promise.resolve({}),
  });
  assert.deepEqual(partialModels.main, { model: 'deepseek-flash', type: 'text', max_output_tokens: 2048 },
    '只配了一项就只出现那一项：不补一个 null 占位');
  assert.equal(Object.hasOwn(partialModels.main, 'context_window'), false);
});

test('#316 心跳下行：数字串窗口归一成正整数后带下去；真小数/非数字 ⇒ 两键都不出现（不是 key: null）', async () => {
  // #316 的病症：门户列表显示着窗口、runner 解析层整键丢掉 ⇒ 压缩静默关。今天两侧同一条规则
  //（`portal/src/llm.js` 的 `positiveIntOrNull()` ↔ `runner/lib/llm-models.js`），下行只会带
  // **归一后的正整数**，算不出来就整个键不出现（runner 用「键在不在」判有无，不解析 null/怪形态）。
  const cases = [
    { ctx: '262144', expected: 262144, why: '数字串 ⇒ 归一成 number 带下去（旧行为：原样带字符串下去）' },
    { ctx: 262144.0, expected: 262144, why: '整值浮点 ⇒ 原样' },
    { ctx: 262144.5, expected: null, why: '真小数 = 配错 ⇒ 不可得（不 floor，也别把一个 runner 一定丢的数发下去）' },
    { ctx: 0, expected: null, why: '0 ⇒ 不可得（runner 收到 0 会让 computeBudget 直接抛）' },
    { ctx: -8000, expected: null, why: '负数 ⇒ 不可得' },
    { ctx: 'abc', expected: null, why: '非数字串 ⇒ 不可得' },
  ];
  for (const { ctx, expected, why } of cases) {
    const pool = fakePool([ROW]);
    const { gw } = fakeGateway([
      // 只给窗口、不给预算：max_output_tokens 走同一条回退链，所以两键的「可得性」必须同源。
      metaModel('m-main', 'deepseek-flash', { contextWindow: ctx }),
      metaModel('m-emb', 'text-embedding-3'),
    ]);
    const models = await getFdeLlmHeartbeatModels(pool, 'u1', {
      gateway: gw, now: () => 1000, ttlMs: 0,
      listModels: () => gw.listModels(), updateKey: () => Promise.resolve({}),
    });
    const label = `context_window=${JSON.stringify(ctx)}`;
    if (expected === null) {
      assert.deepEqual(models.main, { model: 'deepseek-flash', type: 'text' },
        `${label}：${why} ⇒ 两键都不出现（回退值也算不出，两者同源）`);
      assert.deepEqual(Object.keys(models.main), ['model', 'type'], `${label}：不补 null 占位`);
    } else {
      assert.deepEqual(models.main, {
        model: 'deepseek-flash', type: 'text',
        context_window: expected, max_output_tokens: Math.floor(expected / 4),
      }, `${label}：${why}，且下行的是 number`);
      assert.equal(typeof models.main.context_window, 'number', `${label}：下行必须是 number（#316 的核心）`);
    }
  }
});

test('#309 切片1.5 兼容面：不传 gateway 的老调用形状仍逐字节不变（回退不得泄进这条兼容路）', async () => {
  // 目录里就算躺着带窗口的部署也不能影响这条：老调用形状根本不碰网关 ⇒ 一个字节都不能变。
  const table = [ROW];
  const { gw } = fakeGateway([metaModel('m-main', 'deepseek-flash', { contextWindow: 262144, maxOutputTokens: 65536 })]);
  const legacy = await getFdeLlmHeartbeatModels(fakePool(table), 'u1');
  const withNullGateway = await getFdeLlmHeartbeatModels(fakePool(table), 'u1', { gateway: null, listModels: () => gw.listModels() });
  assert.equal(JSON.stringify(legacy), JSON.stringify({
    main: { model: 'deepseek-flash', type: 'text' },
    embedding: { model: 'text-embedding-3', type: 'embedding' },
  }), '不传 gateway ⇒ 仍是存储快照，没多出 context_window / max_output_tokens 任何一个键');
  assert.deepEqual(withNullGateway, legacy, 'gateway: null 与整个 opts 不传同形');
});

test('#309 心跳下行：目录里找不到这个名字（或目录整体拿不到）⇒ 退回无元数据，不抛错', async () => {
  const pool = fakePool([ROW]);
  // 目录只有 embedding：main 的 id 判不出名字（#289 的 unknown_model_id 分支）且按名也取不到部署。
  const { gw } = fakeGateway([metaModel('m-emb', 'text-embedding-3', { contextWindow: 8192, maxOutputTokens: 2048 })]);
  const { value: models, warnings } = await captureWarnings(() => getFdeLlmHeartbeatModels(pool, 'u1', {
    gateway: gw, now: () => 1000, ttlMs: 0, listModels: () => gw.listModels(), updateKey: () => Promise.resolve({}),
  }));
  assert.deepEqual(models.main, { model: 'deepseek-flash', type: 'text' });
  assert.ok(warnings.some(([tag]) => String(tag).includes('reconcile skipped')));
});
