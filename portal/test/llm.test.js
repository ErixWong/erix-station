// 单测：llm.js（issue #38 Phase A LLM 配置存储层）+ http.js admin LLM 端点。
// 覆盖：maskKey 边界 / provider+model CRUD 与 409 引用拒绝 / FDE 配置校验 400 /
//       route outbox 联动（aggregate='llm_binding'）/ audit 不含 key / 掩码回显（响应体无完整 key）/
//       migration 文件文本断言（无 PG 环境的弱断言，TODO e2e 真跑）。
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool，不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  maskKey,
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  createModel,
  updateModel,
  deleteModel,
  getFdeLlmConfig,
  getFdeLlmEcho,
  setFdeLlmConfig,
  revokeFdeLlmConfigTx,
  syncFdeLlmBindingOnOnboard,
  LlmError,
  LLM_MODEL_TYPES,
} from '../src/llm.js';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { FakePool } from './fake-pool.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 内存 fake pool：llm_providers / llm_models / fde_llm_bindings / users +
//               route_revisions head + route_outbox + audit_log（真记录，供断言）。
// ---------------------------------------------------------------------------

class LlmFakePool {
  constructor({ users = [], providers = [], models = [], bindings = [] } = {}) {
    this.users = users.map((u) => ({ ...u }));
    this.providers = providers.map((p) => ({
      api_format: 'openai', enabled: true, created_at: new Date(), updated_at: new Date(), ...p,
    }));
    this.models = models.map((m) => ({
      tool_calling: false, context_window: null, enabled: true, created_at: new Date(), updated_at: new Date(), ...m,
    }));
    this.bindings = bindings.map((b) => ({ ...b }));
    this.revisions = new Map(); // `${aggregate}:${aggregateId}` -> revision
    this.outbox = [];           // { aggregate, aggregate_id, op, revision, payload, state }
    this.audit = [];            // { actor_id, action, target, details }
    this.sqlLog = [];           // { sql, params }
  }

  async query(sql, params = []) {
    this.sqlLog.push({ sql, params });
    return this.#dispatch(sql, params);
  }

  async connect() {
    const self = this;
    return {
      query: async (sql, params = []) => { self.sqlLog.push({ sql, params }); return self.#dispatch(sql, params); },
      release: () => {},
    };
  }

  #dispatch(sql, params) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };

    // route_revisions head 递增（outbox.js bumpRouteRevision）
    if (sql.includes('INSERT INTO route_revisions')) {
      const key = `${params[0]}:${params[1]}`;
      const rev = (this.revisions.get(key) ?? 0) + 1;
      this.revisions.set(key, rev);
      return { rows: [{ revision: rev }] };
    }
    // route_outbox 行（outbox.js enqueueRouteOp）
    if (sql.includes('INSERT INTO route_outbox')) {
      this.outbox.push({
        aggregate: params[0], aggregate_id: params[1], op: params[2],
        revision: Number(params[3]), payload: JSON.parse(params[4]), state: 'pending',
      });
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO audit_log')) {
      // llm.js 写法：VALUES ($1, '<action>', $2, $3) —— action 为 SQL 字面量
      const action = sql.match(/VALUES \(\$1, '([^']+)'/)?.[1] ?? null;
      this.audit.push({ actor_id: params[0], action, target: params[1], details: params[2] });
      return { rows: [] };
    }

    // users
    if (sql.includes('FROM users WHERE fde_name')) {
      const [fdeName] = params;
      const wantActive = sql.includes("status = 'active'");
      return { rows: this.users.filter((u) => u.fde_name === fdeName && (!wantActive || u.status === 'active')) };
    }

    // llm_providers
    if (sql.includes('FROM llm_providers WHERE name')) {
      return { rows: this.providers.filter((p) => p.name === params[0]) };
    }
    if (sql.includes('SELECT id, name, base_url, api_format, enabled, created_at, updated_at\n       FROM llm_providers ORDER BY name') || (sql.includes('FROM llm_providers ORDER BY name'))) {
      return { rows: [...this.providers].sort((a, b) => a.name.localeCompare(b.name)) };
    }
    if (sql.includes('INSERT INTO llm_providers')) {
      const row = {
        id: `p${this.providers.length + 1}`, name: params[0], base_url: params[1],
        api_format: 'openai', enabled: true, created_at: new Date(), updated_at: new Date(),
      };
      this.providers.push(row);
      return { rows: [row] };
    }
    if (sql.includes('UPDATE llm_providers')) {
      const p = this.providers.find((x) => x.id === params[0]);
      if (!p) return { rows: [] };
      if (params[1] != null) p.base_url = params[1];
      if (params[2] != null) p.enabled = params[2];
      p.updated_at = new Date();
      return { rows: [{ ...p }] };
    }
    if (sql.includes('SELECT id, enabled FROM llm_providers WHERE id')) {
      return { rows: this.providers.filter((p) => p.id === params[0]) };
    }
    if (sql.includes('SELECT id, name, enabled FROM llm_providers WHERE id')) {
      return { rows: this.providers.filter((p) => p.id === params[0]) };
    }
    if (sql.includes('SELECT 1 FROM llm_providers WHERE id')) {
      return { rows: this.providers.filter((p) => p.id === params[0]).map(() => ({ '?column?': 1 })) };
    }
    if (sql.includes('DELETE FROM llm_models WHERE provider_id')) {
      this.models = this.models.filter((m) => m.provider_id !== params[0]);
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM llm_providers WHERE id')) {
      this.providers = this.providers.filter((p) => p.id !== params[0]);
      return { rows: [] };
    }

    // llm_models
    if (sql.includes('FROM llm_models WHERE provider_id = $1 ORDER BY model_id')) {
      return { rows: this.models.filter((m) => m.provider_id === params[0]) };
    }
    if (sql.includes('SELECT 1 FROM llm_models WHERE provider_id = $1 AND model_id = $2')) {
      const hit = this.models.some((m) => m.provider_id === params[0] && m.model_id === params[1]);
      return { rows: hit ? [{ '?column?': 1 }] : [] };
    }
    if (sql.includes('INSERT INTO llm_models')) {
      const row = {
        id: `m${this.models.length + 1}`, provider_id: params[0], model_id: params[1], name: params[2],
        type: params[3], tool_calling: params[4], context_window: params[5],
        enabled: true, created_at: new Date(), updated_at: new Date(),
      };
      this.models.push(row);
      return { rows: [row] };
    }
    if (sql.includes('UPDATE llm_models')) {
      const m = this.models.find((x) => x.id === params[0]);
      if (!m) return { rows: [] };
      if (params[1] != null) m.name = params[1];
      if (params[2] != null) m.enabled = params[2];
      if (params[3] != null) m.tool_calling = params[3];
      if (params[4] != null) m.context_window = params[4];
      m.updated_at = new Date();
      return { rows: [{ ...m }] };
    }
    if (sql.includes('SELECT id, model_id, name, type, tool_calling, enabled, provider_id FROM llm_models WHERE id')) {
      return { rows: this.models.filter((m) => m.id === params[0]) };
    }
    if (sql.includes('SELECT 1 FROM llm_models WHERE id')) {
      return { rows: this.models.some((m) => m.id === params[0]) ? [{ '?column?': 1 }] : [] };
    }
    if (sql.includes('main_model_id = $1 OR embedding_model_id = $1')) {
      const hit = this.bindings.some((b) => b.main_model_id === params[0] || b.embedding_model_id === params[0] || b.vision_model_id === params[0]);
      return { rows: hit ? [{ '?column?': 1 }] : [] };
    }
    if (sql.includes('DELETE FROM llm_models WHERE id')) {
      this.models = this.models.filter((m) => m.id !== params[0]);
      return { rows: [] };
    }

    // fde_llm_bindings
    if (sql.includes('FROM fde_llm_bindings b') && sql.includes('JOIN llm_providers')) {
      const b = this.bindings.find((x) => x.fde_id === params[0] && x.state === 'active');
      if (!b) return { rows: [] };
      const p = this.providers.find((x) => x.id === b.provider_id);
      if (!p) return { rows: [] };
      const model = (id) => this.models.find((x) => x.id === id);
      const mm = model(b.main_model_id);
      const em = model(b.embedding_model_id);
      const vm = model(b.vision_model_id);
      return {
        rows: [{
          fde_id: b.fde_id, api_key: b.api_key, state: b.state,
          provider_id: p.id, provider_name: p.name, base_url: p.base_url,
          main_upstream: mm?.model_id ?? null, main_name: mm?.name ?? null, main_type: mm?.type ?? null,
          embedding_upstream: em?.model_id ?? null, embedding_name: em?.name ?? null, embedding_type: em?.type ?? null,
          vision_upstream: vm?.model_id ?? null, vision_name: vm?.name ?? null, vision_type: vm?.type ?? null,
        }],
      };
    }
    if (sql.includes('SELECT 1 FROM fde_llm_bindings WHERE provider_id')) {
      const hit = this.bindings.some((b) => b.provider_id === params[0]);
      return { rows: hit ? [{ '?column?': 1 }] : [] };
    }
    if (sql.includes('SELECT api_key FROM fde_llm_bindings WHERE fde_id')) {
      return { rows: this.bindings.filter((b) => b.fde_id === params[0]).map((b) => ({ api_key: b.api_key })) };
    }
    // issue #38 Phase B1：offboard 吊销联动（revokeFdeLlmConfigTx）——必须在通用 UPDATE 处理器之前。
    if (sql.includes('UPDATE fde_llm_bindings') && sql.includes("SET state = 'revoked'")) {
      const b = this.bindings.find((x) => x.fde_id === params[0] && x.state === 'active');
      if (b) { b.state = 'revoked'; b.revoked_at = new Date(); b.updated_at = new Date(); }
      return { rows: [], rowCount: b ? 1 : 0 };
    }
    // issue #38 Phase B1：onboard 恢复联动（syncFdeLlmBindingOnOnboard）。
    if (sql.includes('SELECT state FROM fde_llm_bindings WHERE fde_id') && sql.includes('FOR UPDATE')) {
      const b = this.bindings.find((x) => x.fde_id === params[0]);
      return { rows: b ? [{ state: b.state }] : [] };
    }
    if (sql.includes('UPDATE fde_llm_bindings') && sql.includes("SET state = 'active', revoked_at = NULL")) {
      const b = this.bindings.find((x) => x.fde_id === params[0]);
      if (b) { b.state = 'active'; b.revoked_at = null; b.updated_at = new Date(); }
      return { rows: [], rowCount: b ? 1 : 0 };
    }
    if (sql.includes('SELECT 1 FROM fde_llm_bindings WHERE fde_id')) {
      return { rows: this.bindings.some((b) => b.fde_id === params[0]) ? [{ '?column?': 1 }] : [] };
    }
    if (sql.includes('UPDATE fde_llm_bindings')) {
      const b = this.bindings.find((x) => x.fde_id === params[0]);
      if (b) {
        b.provider_id = params[1]; b.api_key = params[2]; b.main_model_id = params[3];
        b.embedding_model_id = params[4]; b.vision_model_id = params[5];
        b.gateway = 'direct'; b.state = 'active'; b.updated_at = new Date();
      }
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO fde_llm_bindings')) {
      this.bindings.push({
        // SQL: (fde_id, gateway, key_alias, state, generation, provider_id, api_key, main, embedding, vision)
        //      VALUES ($1, 'direct', $2, 'active', 1, $3, $4, $5, $6, $7)
        fde_id: params[0], gateway: 'direct', key_alias: params[1], state: 'active', generation: 1,
        provider_id: params[2], api_key: params[3], main_model_id: params[4],
        embedding_model_id: params[5], vision_model_id: params[6],
        key_id: null, revoked_at: null, rotated_at: null, created_at: new Date(), updated_at: new Date(),
      });
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM fde_llm_bindings WHERE fde_id')) {
      this.bindings = this.bindings.filter((b) => b.fde_id !== params[0]);
      return { rows: [] };
    }

    return { rows: [] };
  }
}

// ---------------------------------------------------------------------------
// maskKey 边界
// ---------------------------------------------------------------------------

test('maskKey：正常 → sk-...last4；短/空 → ***', () => {
  assert.equal(maskKey('sk-abcdef1234567890'), 'sk-...7890');
  assert.equal(maskKey('0123456789abcdef'), 'sk-...cdef');
  assert.equal(maskKey('abcdefgh'), 'sk-...efgh', '8 字符是边界（<8 才 ***）');
  assert.equal(maskKey('abc'), '***');
  assert.equal(maskKey(''), '***');
  assert.equal(maskKey(null), '***');
  assert.equal(maskKey(undefined), '***');
});

// ---------------------------------------------------------------------------
// provider CRUD
// ---------------------------------------------------------------------------

test('provider CRUD：create → list（含 models）→ update → delete', async () => {
  const pool = new LlmFakePool();
  const p = await createProvider(pool, { name: 'openai', base_url: 'https://api.openai.com/v1' });
  assert.equal(p.name, 'openai');
  assert.equal(p.api_format, 'openai');
  assert.equal(p.enabled, true);

  await createModel(pool, { provider_id: p.id, model_id: 'gpt-4o', name: 'GPT-4o', type: 'text', tool_calling: true, context_window: 128000 });
  const { items } = await listProviders(pool);
  assert.equal(items.length, 1);
  assert.equal(items[0].models.length, 1);
  assert.equal(items[0].models[0].model_id, 'gpt-4o');

  const updated = await updateProvider(pool, p.id, { enabled: false });
  assert.equal(updated.enabled, false);
  assert.equal(updated.name, 'openai', 'name 不可改');

  await deleteProvider(pool, p.id);
  assert.equal(pool.providers.length, 0);
  assert.equal(pool.models.length, 0, '删 provider 级联删其 models');
});

test('provider create：重名 → 409 name_conflict；非法 base_url → 400', async () => {
  const pool = new LlmFakePool();
  await createProvider(pool, { name: 'openai', base_url: 'https://api.openai.com/v1' });
  await assert.rejects(
    () => createProvider(pool, { name: 'openai', base_url: 'https://x.example.com' }),
    (e) => e instanceof LlmError && e.httpStatus === 409 && e.code === 'name_conflict',
  );
  await assert.rejects(
    () => createProvider(pool, { name: 'bad', base_url: 'not-a-url' }),
    (e) => e instanceof LlmError && e.httpStatus === 400 && e.code === 'validation_failed',
  );
});

test('provider delete：被 fde_llm_bindings 引用 → 409 provider_in_use', async () => {
  const pool = new LlmFakePool({
    providers: [{ id: 'p1', name: 'openai', base_url: 'https://api.openai.com/v1' }],
    bindings: [{
      fde_id: 'u1', gateway: 'direct', key_alias: 'alice@llm', state: 'active', generation: 1,
      provider_id: 'p1', api_key: 'sk-test', main_model_id: 'm1',
    }],
  });
  await assert.rejects(
    () => deleteProvider(pool, 'p1'),
    (e) => e instanceof LlmError && e.httpStatus === 409 && e.code === 'provider_in_use',
  );
  assert.equal(pool.providers.length, 1, '拒绝删除');
});

// ---------------------------------------------------------------------------
// model CRUD
// ---------------------------------------------------------------------------

test('model create：type 枚举校验 / provider 停用拒绝 / 重复 model_id → 409', async () => {
  const pool = new LlmFakePool({
    providers: [
      { id: 'p1', name: 'openai', base_url: 'https://api.openai.com/v1', enabled: true },
      { id: 'p2', name: 'dead', base_url: 'https://x.example.com', enabled: false },
    ],
  });
  const m = await createModel(pool, { provider_id: 'p1', model_id: 'gpt-4o', name: 'GPT-4o', type: 'text', tool_calling: true });
  assert.equal(m.tool_calling, true);

  await assert.rejects(
    () => createModel(pool, { provider_id: 'p1', model_id: 'x', name: 'x', type: 'video' }),
    (e) => e instanceof LlmError && e.httpStatus === 400 && e.code === 'validation_failed' && e.details.field === 'type',
  );
  assert.deepEqual(LLM_MODEL_TYPES, ['text', 'embedding', 'vision', 'rerank', 'audio-tts', 'audio-stt', 'image-gen']);
  await assert.rejects(
    () => createModel(pool, { provider_id: 'p2', model_id: 'x', name: 'x', type: 'text' }),
    (e) => e instanceof LlmError && e.httpStatus === 400 && e.code === 'validation_failed',
  );
  await assert.rejects(
    () => createModel(pool, { provider_id: 'p1', model_id: 'gpt-4o', name: 'dup', type: 'text' }),
    (e) => e instanceof LlmError && e.httpStatus === 409 && e.code === 'name_conflict',
  );
});

test('model delete：被任一模型位引用 → 409 model_in_use；未引用可删', async () => {
  const pool = new LlmFakePool({
    providers: [{ id: 'p1', name: 'openai', base_url: 'https://api.openai.com/v1' }],
    models: [{ id: 'm1', provider_id: 'p1', model_id: 'gpt-4o', name: 'GPT-4o', type: 'text' }],
    bindings: [{
      fde_id: 'u1', gateway: 'direct', key_alias: 'alice@llm', state: 'active', generation: 1,
      provider_id: 'p1', api_key: 'sk-test', main_model_id: 'm1', embedding_model_id: null, vision_model_id: null,
    }],
  });
  await assert.rejects(
    () => deleteModel(pool, 'm1'),
    (e) => e instanceof LlmError && e.httpStatus === 409 && e.code === 'model_in_use',
  );
  await deleteModel(pool, 'm-nonexistent-xyz') // 不存在 → 404（先断言存在性，再断言引用）
    .then(() => assert.fail('应 404'), (e) => assert.equal(e.httpStatus, 404));
});

// ---------------------------------------------------------------------------
// FDE LLM 配置写入：校验 400 + outbox 联动 + audit 不含 key
// ---------------------------------------------------------------------------

function seedPool() {
  return new LlmFakePool({
    users: [{ id: 'u1', fde_name: 'alice', status: 'active' }],
    providers: [
      { id: 'p1', name: 'openai', base_url: 'https://api.openai.com/v1', enabled: true },
      { id: 'p2', name: 'other', base_url: 'https://other.example.com', enabled: true },
    ],
    models: [
      { id: 'm-main', provider_id: 'p1', model_id: 'gpt-4o', name: 'GPT-4o', type: 'text', tool_calling: true, enabled: true },
      { id: 'm-main-notool', provider_id: 'p1', model_id: 'gpt-3.5', name: 'GPT-3.5', type: 'text', tool_calling: false, enabled: true },
      { id: 'm-emb', provider_id: 'p1', model_id: 'text-embedding-3', name: 'Emb3', type: 'embedding', tool_calling: false, enabled: true },
      { id: 'm-vis', provider_id: 'p1', model_id: 'gpt-4o-vis', name: 'Vis', type: 'vision', tool_calling: false, enabled: true },
      { id: 'm-other-provider', provider_id: 'p2', model_id: 'gpt-4o', name: 'GPT-4o(p2)', type: 'text', tool_calling: true, enabled: true },
      { id: 'm-disabled', provider_id: 'p1', model_id: 'old', name: 'Old', type: 'text', tool_calling: true, enabled: false },
    ],
  });
}

const FULL_KEY = 'sk-live-abcdef1234567890xyz';

test('setFdeLlmConfig：main 未 tool_calling → 400 validation_failed', async () => {
  const pool = seedPool();
  await assert.rejects(
    () => setFdeLlmConfig(pool, { fdeName: 'alice', provider_id: 'p1', api_key: FULL_KEY, main_model_id: 'm-main-notool' }),
    (e) => e instanceof LlmError && e.httpStatus === 400 && e.code === 'validation_failed' && e.details.field === 'main',
  );
});

test('setFdeLlmConfig：embedding 位选了 text 模型 → 400（type 不匹配）', async () => {
  const pool = seedPool();
  await assert.rejects(
    () => setFdeLlmConfig(pool, {
      fdeName: 'alice', provider_id: 'p1', api_key: FULL_KEY,
      main_model_id: 'm-main', embedding_model_id: 'm-main',
    }),
    (e) => e instanceof LlmError && e.httpStatus === 400 && e.code === 'validation_failed' && e.details.field === 'embedding',
  );
});

test('setFdeLlmConfig：模型 provider 与配置 provider 不一致 → 400', async () => {
  const pool = seedPool();
  await assert.rejects(
    () => setFdeLlmConfig(pool, { fdeName: 'alice', provider_id: 'p1', api_key: FULL_KEY, main_model_id: 'm-other-provider' }),
    (e) => e instanceof LlmError && e.httpStatus === 400 && e.code === 'validation_failed' && /不匹配/.test(e.message),
  );
});

test('setFdeLlmConfig：模型停用 / provider 停用 / 首次缺 api_key → 400', async () => {
  const pool = seedPool();
  await assert.rejects(
    () => setFdeLlmConfig(pool, { fdeName: 'alice', provider_id: 'p1', api_key: FULL_KEY, main_model_id: 'm-disabled' }),
    (e) => e.httpStatus === 400 && e.code === 'validation_failed',
  );
  await assert.rejects(
    () => setFdeLlmConfig(pool, { fdeName: 'alice', provider_id: 'p-nonexistent', api_key: FULL_KEY, main_model_id: 'm-main' }),
    (e) => e.httpStatus === 400 && e.code === 'validation_failed' && e.details.field === 'provider_id',
  );
  await assert.rejects(
    () => setFdeLlmConfig(pool, { fdeName: 'alice', provider_id: 'p1', main_model_id: 'm-main' }),
    (e) => e.httpStatus === 400 && e.code === 'validation_failed' && e.details.field === 'api_key',
  );
});

test('setFdeLlmConfig：成功 → upsert + route outbox（llm_binding）+ audit 不含 key；返回掩码', async () => {
  const pool = seedPool();
  const echo = await setFdeLlmConfig(pool, {
    actorId: 'admin-1', fdeName: 'alice', provider_id: 'p1', api_key: FULL_KEY,
    main_model_id: 'm-main', embedding_model_id: 'm-emb', vision_model_id: 'm-vis',
  });
  assert.equal(echo.api_key, maskKey(FULL_KEY), '响应只给掩码');
  assert.equal(echo.main.model_id, 'gpt-4o');
  assert.equal(echo.embedding.model_id, 'text-embedding-3');

  // bindings 行：gateway='direct' / key_alias=fde@llm / state=active / generation=1
  const b = pool.bindings.find((x) => x.fde_id === 'u1');
  assert.equal(b.gateway, 'direct');
  assert.equal(b.key_alias, 'alice@llm');
  assert.equal(b.state, 'active');
  assert.equal(b.generation, 1);
  assert.equal(b.api_key, FULL_KEY, 'DB 存明文（已定稿决策）');

  // route outbox 联动：与 projects.js port_allocation 完全同构（aggregate='llm_binding', aggregate_id=fde_id）
  assert.equal(pool.outbox.length, 1);
  assert.equal(pool.outbox[0].aggregate, 'llm_binding');
  assert.equal(pool.outbox[0].aggregate_id, 'u1');
  assert.equal(pool.outbox[0].op, 'upsert');
  assert.equal(pool.outbox[0].revision, 1);
  assert.equal(pool.outbox[0].state, 'pending');
  assert.equal(pool.revisions.get('llm_binding:u1'), 1, 'route_revisions head 同事务递增');
  assert.equal(pool.outbox[0].payload.has_api_key, true);
  assert.ok(!('api_key' in pool.outbox[0].payload), 'outbox payload 不含 key（红线 ③）');
  assert.equal(pool.outbox[0].payload.provider_id, 'p1');

  // audit：action 正确、details 无 key
  assert.equal(pool.audit.length, 1);
  assert.equal(pool.audit[0].action, 'llm.config_updated');
  assert.equal(pool.audit[0].target, 'alice');
  assert.ok(!pool.audit[0].details.includes(FULL_KEY), 'audit details 不含 key');
  assert.ok(pool.audit[0].details.includes('openai') && pool.audit[0].details.includes('gpt-4o'));

  // outbox / audit 的参数不得含真 key（红线 ③：不进日志/审计；binding INSERT 存明文是设计内）
  for (const call of pool.sqlLog) {
    if (call.sql.includes('route_outbox') || call.sql.includes('audit_log')) {
      for (const p of call.params ?? []) {
        assert.notEqual(p, FULL_KEY, `outbox/audit SQL 参数不得含真 key: ${call.sql.slice(0, 60)}`);
      }
    }
  }
});

test('setFdeLlmConfig：二次更新 api_key 缺省 = 保留旧值；generation 不变；outbox revision 递增', async () => {
  const pool = seedPool();
  await setFdeLlmConfig(pool, { fdeName: 'alice', provider_id: 'p1', api_key: FULL_KEY, main_model_id: 'm-main' });
  const echo = await setFdeLlmConfig(pool, { fdeName: 'alice', provider_id: 'p1', main_model_id: 'm-main' });
  assert.equal(echo.api_key, maskKey(FULL_KEY), '未重传 key → 保留旧值（掩码回显）');
  const b = pool.bindings.find((x) => x.fde_id === 'u1');
  assert.equal(b.api_key, FULL_KEY);
  assert.equal(b.generation, 1, '更新不改 generation');
  assert.equal(pool.outbox.length, 2);
  assert.equal(pool.outbox[1].revision, 2, 'route_revisions head 单调递增');
});

test('getFdeLlmConfig：内部全量（含明文 key，供心跳下行/发布器）；getFdeLlmEcho：掩码回显；无配置 → null', async () => {
  const pool = seedPool();
  assert.equal(await getFdeLlmEcho(pool, 'alice'), null, '无配置 200 + null');

  await setFdeLlmConfig(pool, { fdeName: 'alice', provider_id: 'p1', api_key: FULL_KEY, main_model_id: 'm-main', embedding_model_id: 'm-emb' });

  const cfg = await getFdeLlmConfig(pool, 'u1');
  assert.equal(cfg.api_key, FULL_KEY, '内部读取给明文（不落地日志的调用方纪律）');
  assert.equal(cfg.base_url, 'https://api.openai.com/v1');
  assert.deepEqual(cfg.main, { model_id: 'gpt-4o', name: 'GPT-4o', type: 'text' });
  assert.equal(cfg.embedding.type, 'embedding');
  assert.equal(cfg.vision, null);

  const echo = await getFdeLlmEcho(pool, 'alice');
  assert.equal(echo.api_key, maskKey(FULL_KEY));
  await assert.rejects(() => getFdeLlmEcho(pool, 'ghost'), (e) => e.httpStatus === 404);
});

// ---------------------------------------------------------------------------
// HTTP 层：admin 鉴权 + 掩码回显（响应体无完整 key）
// ---------------------------------------------------------------------------

const ADMIN = {
  id: '00000000-0000-4000-8000-0000000000a1', login: 'root', display_name: 'root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
};
const FDE_USER = {
  id: '00000000-0000-4000-8000-0000000000b2', login: 'alice', display_name: 'alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const ADMIN_TOKEN = 'tok-llm-admin-test';

/** HTTP 测试 pool：FakePool（登录会话/audit）+ LlmFakePool 的 LLM 表模拟。 */
class HttpLlmPool extends FakePool {
  constructor(seed) {
    super({ users: [ADMIN, FDE_USER] });
    this.llm = new LlmFakePool({ users: [FDE_USER], ...seed });
    this.sessions.push({
      id: 'ls-llm', user_id: ADMIN.id, token_hash: auth.hashToken(ADMIN_TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
  }

  async query(sql, params = []) {
    if (/llm_providers|llm_models|fde_llm_bindings|route_revisions|route_outbox|pg_advisory_xact_lock/.test(sql)
        || sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK'
        || (sql.includes('FROM users WHERE fde_name'))) {
      return this.llm.query(sql, params);
    }
    return super.query(sql, params);
  }

  async connect() {
    const llmClient = await this.llm.connect();
    return {
      query: (sql, params = []) => {
        if (sql.includes('INSERT INTO audit_log')) {
          // llm.js 写法：VALUES ($1, '<action>', $2, $3) —— action 为 SQL 字面量
          const action = sql.match(/VALUES \(\$1, '([^']+)'/)?.[1] ?? null;
          this.llm.audit.push({ actor_id: params[0], action, target: params[1], details: params[2] });
          return Promise.resolve({ rows: [] });
        }
        return llmClient.query(sql, params);
      },
      release: () => llmClient.release(),
    };
  }
}

async function startAdminServer(seed = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-llm-static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'INDEX');
  const config = {
    cookie: cookieSettings('dev-llm', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    loginRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 100, maxEntries: 10000 },
    kdfConcurrency: 2,
    kdfQueueLimit: 100,
    kdfQueueTimeoutMs: 30000,
    maxBodyBytes: 64 * 1024,
    staticDir,
  };
  const pool = new HttpLlmPool(seed);
  const server = createServer({ pool, config, log: { error: () => {}, warn: () => {}, log: () => {} } });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    pool, base,
    admin: { cookie: `${config.cookie.name}=${ADMIN_TOKEN}` },
    close: () => new Promise((res) => server.close(res)),
  };
}

test('HTTP：无 cookie → 401；fde role 会话 → 403 forbidden（requireAdmin）', async () => {
  const { base, pool, admin, close } = await startAdminServer();
  try {
    const anon = await fetch(`${base}/api/admin/llm/providers`);
    assert.equal(anon.status, 401);

    // 注入 fde role 会话（与 admin 不同 token，同 cookie 名）
    pool.sessions.push({
      id: 'ls-fde', user_id: FDE_USER.id, token_hash: auth.hashToken('tok-fde'),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
    const cookieName = admin.cookie.split('=')[0];
    const res = await fetch(`${base}/api/admin/llm/providers`, { headers: { cookie: `${cookieName}=tok-fde` } });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'forbidden');
  } finally {
    await close();
  }
});

test('HTTP：完整管理流——建 provider/model → PUT 配置 → GET 回显掩码（响应体无完整 key）', async (t) => {
  const seed = {
    providers: [{ id: 'p1', name: 'openai', base_url: 'https://api.openai.com/v1', enabled: true }],
    models: [
      { id: 'm-main', provider_id: 'p1', model_id: 'gpt-4o', name: 'GPT-4o', type: 'text', tool_calling: true, enabled: true },
      { id: 'm-emb', provider_id: 'p1', model_id: 'text-embedding-3', name: 'Emb3', type: 'embedding', enabled: true },
    ],
  };
  const { base, pool, admin, close } = await startAdminServer(seed);
  try {
    const KEY = 'sk-http-flow-secretkey12345';

    // 无配置 → 200 + null
    let res = await fetch(`${base}/api/admin/fdes/alice/llm`, { headers: { cookie: admin.cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { config: null });

    // PUT 配置
    res = await fetch(`${base}/api/admin/fdes/alice/llm`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ provider_id: 'p1', api_key: KEY, main_model_id: 'm-main', embedding_model_id: 'm-emb' }),
    });
    assert.equal(res.status, 200);
    const putBody = await res.json();
    assert.equal(putBody.config.api_key, maskKey(KEY));
    assert.ok(!JSON.stringify(putBody).includes(KEY), 'PUT 响应体无完整 key');

    // GET 回显：掩码、无完整 key
    res = await fetch(`${base}/api/admin/fdes/alice/llm`, { headers: { cookie: admin.cookie } });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(KEY), 'GET 响应体无完整 key');
    const { config } = JSON.parse(text);
    assert.equal(config.api_key, maskKey(KEY));
    assert.equal(config.main.model_id, 'gpt-4o');

    // 校验失败 → 400 validation_failed（embedding 位塞 text 模型）
    res = await fetch(`${base}/api/admin/fdes/alice/llm`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ provider_id: 'p1', main_model_id: 'm-emb' }),
    });
    assert.equal(res.status, 400);
    const errBody = await res.json();
    assert.equal(errBody.error.code, 'validation_failed');
    assert.ok(!JSON.stringify(errBody).includes(KEY), '错误信息不含 key');

    // outbox + audit 断言（HTTP 路径与模块路径同一写入逻辑）
    assert.equal(pool.llm.outbox.length, 1);
    assert.equal(pool.llm.outbox[0].aggregate, 'llm_binding');
    assert.equal(pool.llm.audit.length, 1);
    assert.equal(pool.llm.audit[0].action, 'llm.config_updated');
    assert.ok(!pool.llm.audit[0].details.includes(KEY));

    // fde role → 403：构造 fde 会话 cookie（cookie 名与 admin 相同，只是 token 不同）
    pool.sessions.push({
      id: 'ls-fde2', user_id: FDE_USER.id, token_hash: auth.hashToken('tok-fde2'),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_000_000), last_seen_at: new Date(), revoked_at: null,
    });
    const cookieName = admin.cookie.split('=')[0];
    res = await fetch(`${base}/api/admin/llm/providers`, { headers: { cookie: `${cookieName}=tok-fde2` } });
    assert.equal(res.status, 403);
    const forbid = await res.json();
    assert.equal(forbid.error.code, 'forbidden');
  } finally {
    await close();
  }
});

test('HTTP：provider/model 管理端点（POST/PATCH/DELETE + 409 引用拒绝）', async () => {
  const seed = {
    providers: [{ id: 'p1', name: 'openai', base_url: 'https://api.openai.com/v1', enabled: true }],
    models: [
      { id: 'm-main', provider_id: 'p1', model_id: 'gpt-4o', name: 'GPT-4o', type: 'text', tool_calling: true, enabled: true },
    ],
  };
  const { base, pool, admin, close } = await startAdminServer(seed);
  try {
    const H = { cookie: admin.cookie, 'content-type': 'application/json' };

    // 列表
    let res = await fetch(`${base}/api/admin/llm/providers`, { headers: { cookie: admin.cookie } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).items[0].models.length, 1);

    // 新建 provider + model
    res = await fetch(`${base}/api/admin/llm/providers`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'anthropic', base_url: 'https://api.anthropic.com' }) });
    assert.equal(res.status, 201);
    const p2 = (await res.json()).provider;
    res = await fetch(`${base}/api/admin/llm/providers/${p2.id}/models`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ model_id: 'claude-sonnet', name: 'Sonnet', type: 'text', tool_calling: true, context_window: 200000 }),
    });
    assert.equal(res.status, 201);

    // PATCH provider enabled / PATCH model
    res = await fetch(`${base}/api/admin/llm/providers/${p2.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ enabled: false }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).provider.enabled, false);

    // 未引用时 model/provider 可删（先把 m-main 换成未被引用的 m-vis 再删 p2 系）
    // 先配置 FDE 引用 p1/m-main，再删 → 双双 409
    res = await fetch(`${base}/api/admin/fdes/alice/llm`, {
      method: 'PUT', headers: H,
      body: JSON.stringify({ provider_id: 'p1', api_key: 'sk-x12345678', main_model_id: 'm-main' }),
    });
    assert.equal(res.status, 200);

    // 被引用的 model 删 → 409 model_in_use
    res = await fetch(`${base}/api/admin/llm/models/m-main`, { method: 'DELETE', headers: H });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'model_in_use');

    // 被引用的 provider 删 → 409 provider_in_use
    res = await fetch(`${base}/api/admin/llm/providers/p1`, { method: 'DELETE', headers: H });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'provider_in_use');
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// migration 文件弱断言（无 PG 环境，TODO e2e 真跑；deploy/docker-compose MIGRATE_ON_START=1）
// ---------------------------------------------------------------------------

test('migration 0002-llm-config.sql：包含全部预期语句（弱断言，TODO e2e 真跑验证）', () => {
  const sql = fs.readFileSync(path.join(HERE, '../../deploy/migrations/0002-llm-config.sql'), 'utf8');
  for (const snippet of [
    'issue #38',
    'CREATE TABLE IF NOT EXISTS llm_providers',
    'CREATE TABLE IF NOT EXISTS llm_models',
    "api_format IN ('openai')",
    "'text','embedding','vision','rerank','audio-tts','audio-stt','image-gen'",
    'UNIQUE (provider_id, model_id)',
    'ALTER TABLE fde_llm_bindings',
    'ADD COLUMN IF NOT EXISTS provider_id',
    'ADD COLUMN IF NOT EXISTS api_key',
    'ADD COLUMN IF NOT EXISTS main_model_id',
    'ADD COLUMN IF NOT EXISTS embedding_model_id',
    'ADD COLUMN IF NOT EXISTS vision_model_id',
    "值 'direct'",
  ]) {
    assert.ok(sql.includes(snippet), `migration 应包含：${snippet}`);
  }
  // 不改 baseline（checksum 防改机制）
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(baseline.includes('CREATE TABLE fde_llm_bindings ('), 'baseline 保留 fde_llm_bindings 原表');
  assert.ok(!baseline.includes('llm_providers'), 'baseline 不含新表（结构变更只走增量迁移）');
});

// ---------------------------------------------------------------------------
// issue #38 Phase B1：offboard/onboard 联动事务助手（revokeFdeLlmConfigTx /
// syncFdeLlmBindingOnOnboard）——与 provisioner 前置吊销/复用恢复分支同构验证。
// ---------------------------------------------------------------------------

test('B1：revokeFdeLlmConfigTx——active → revoked（revoked_at=now()）+ outbox delete（payload 不含 key）', async () => {
  const pool = new LlmFakePool({
    users: [{ id: 'u1', fde_name: 'alice', status: 'active' }],
    bindings: [{ fde_id: 'u1', provider_id: 'p1', api_key: 'sk-test-1234567890', state: 'active', main_model_id: 'm1' }],
  });
  const client = await pool.connect();
  const revoked = await revokeFdeLlmConfigTx(client, { fdeId: 'u1', fdeName: 'alice' });
  assert.equal(revoked, true);
  const b = pool.bindings.find((x) => x.fde_id === 'u1');
  assert.equal(b.state, 'revoked');
  assert.ok(b.revoked_at instanceof Date);
  const del = pool.outbox.filter((o) => o.aggregate === 'llm_binding');
  assert.equal(del.length, 1);
  assert.equal(del[0].op, 'delete');
  assert.equal(del[0].aggregate_id, 'u1');
  assert.equal(del[0].payload.fde_name, 'alice');
  assert.ok(!JSON.stringify(del[0].payload).includes('sk-test-1234567890'), 'tombstone payload 不得含 key（红线 ③）');
  // 幂等：已 revoked → 返回 false 且不再写 outbox
  const again = await revokeFdeLlmConfigTx(client, { fdeId: 'u1', fdeName: 'alice' });
  assert.equal(again, false);
  assert.equal(pool.outbox.filter((o) => o.aggregate === 'llm_binding').length, 1);
});

test('B1：revokeFdeLlmConfigTx——无 binding 行 → false，不写 outbox（兼容无 LLM 配置的 FDE）', async () => {
  const pool = new LlmFakePool({ users: [{ id: 'u1', fde_name: 'alice', status: 'active' }] });
  const client = await pool.connect();
  assert.equal(await revokeFdeLlmConfigTx(client, { fdeId: 'u1', fdeName: 'alice' }), false);
  assert.equal(pool.outbox.length, 0);
});

test('B1：syncFdeLlmBindingOnOnboard——复用分支 revoked → active（revoked_at=NULL）+ outbox upsert', async () => {
  const pool = new LlmFakePool({
    users: [{ id: 'u1', fde_name: 'alice', status: 'active' }],
    bindings: [{
      fde_id: 'u1', provider_id: 'p1', api_key: 'sk-test-1234567890', state: 'revoked',
      revoked_at: new Date(), main_model_id: 'm1',
    }],
  });
  const out = await syncFdeLlmBindingOnOnboard(pool, { fdeId: 'u1', fdeName: 'alice', restoreRevoked: true });
  assert.deepEqual(out, { restored: true, republished: true });
  const b = pool.bindings[0];
  assert.equal(b.state, 'active');
  assert.equal(b.revoked_at, null, '复活必须清 revoked_at（同 #37 防御逻辑；注意是 fde_llm_bindings 本表，非 containers 表）');
  const ups = pool.outbox.filter((o) => o.aggregate === 'llm_binding' && o.op === 'upsert');
  assert.equal(ups.length, 1);
  assert.equal(ups[0].aggregate_id, 'u1');
  assert.ok(!JSON.stringify(ups[0].payload).includes('sk-test-1234567890'), 'payload 不得含 key');
});

test('B1：syncFdeLlmBindingOnOnboard——全新 onboard（restoreRevoked=false）不复活 revoked 配置', async () => {
  const pool = new LlmFakePool({
    bindings: [{
      fde_id: 'u1', provider_id: 'p1', api_key: 'sk-test-1234567890', state: 'revoked',
      revoked_at: new Date(), main_model_id: 'm1',
    }],
  });
  const out = await syncFdeLlmBindingOnOnboard(pool, { fdeId: 'u1', fdeName: 'alice', restoreRevoked: false });
  assert.deepEqual(out, { restored: false, republished: false });
  assert.equal(pool.bindings[0].state, 'revoked', 'offboard 是管理员意图，全新 onboard 不得自动恢复 LLM');
  assert.equal(pool.outbox.length, 0);
});

test('B1：syncFdeLlmBindingOnOnboard——active 配置幂等 upsert（revision 递增）；无 binding 行 → no-op', async () => {
  const pool = new LlmFakePool({
    bindings: [{ fde_id: 'u1', provider_id: 'p1', api_key: 'sk-test-1234567890', state: 'active', main_model_id: 'm1' }],
  });
  const out1 = await syncFdeLlmBindingOnOnboard(pool, { fdeId: 'u1', fdeName: 'alice', restoreRevoked: false });
  assert.deepEqual(out1, { restored: false, republished: true });
  const rev = pool.revisions.get('llm_binding:u1');
  const out2 = await syncFdeLlmBindingOnOnboard(pool, { fdeId: 'u1', fdeName: 'alice', restoreRevoked: false });
  assert.deepEqual(out2, { restored: false, republished: true });
  assert.equal(pool.revisions.get('llm_binding:u1'), rev + 1, '每次 upsert revision 递增（head 语义，与 setFdeLlmConfig 同构）');

  const empty = new LlmFakePool({});
  assert.deepEqual(
    await syncFdeLlmBindingOnOnboard(empty, { fdeId: 'u9', fdeName: 'nobody', restoreRevoked: true }),
    { restored: false, republished: false },
  );
});
