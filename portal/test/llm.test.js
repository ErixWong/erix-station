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
  listModels,
  createProvider,
  updateProvider,
  deleteProvider,
  createModel,
  updateModel,
  deleteModel,
  getFdeLlmConfig,
  getFdeLlmEcho,
  getFdeLlmHeartbeatModels,
  setFdeLlmConfig,
  revokeFdeLlmConfigTx,
  syncFdeLlmBindingOnOnboard,
  LlmError,
  LLM_MODEL_TYPES,
  typeToMode,
} from '../src/llm.js';
import { createServer } from '../src/http.js';
import { postMessage } from '../src/sessions.js';
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
      tool_calling: false, context_window: null, max_tokens: null, enabled: true, created_at: new Date(), updated_at: new Date(), ...m,
    }));
    this.bindings = bindings.map((b) => ({ gateway: 'litellm', ...b }));
    this.revisions = new Map(); // `${aggregate}:${aggregateId}` -> revision
    this.outbox = [];           // { aggregate, aggregate_id, op, revision, payload, state }
    this.audit = [];            // { actor_id, action, target, details }
    this.sqlLog = [];           // { sql, params }
    this.gatewayCalls = [];
    this.generatedKeys = [];
    this.nextGatewayId = 0;
    this.createModelError = null;
    this.deleteModelError = null;
    this.updateKeyError = null;
    this.activeRun = false;     // N2/N3：fdeHasActiveRun 同口径的活跃 run 开关（llm.js 事务内复检用）
  }

  #gatewayError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  async listCredentials() {
    this.gatewayCalls.push({ method: 'listCredentials' });
    return {
      credentials: this.providers.map((p) => ({
        credential_name: p.id,
        credential_info: { credential_name: p.id, display_name: p.name },
        credential_values: { api_base: p.base_url, ...(p.api_key ? { api_key: p.api_key } : {}) },
      })),
    };
  }

  async createCredential(body) {
    this.gatewayCalls.push({ method: 'createCredential', body });
    if (this.providers.some((p) => p.id === body.credential_name)) {
      throw this.#gatewayError(422, 'credential already exists');
    }
    const p = {
      id: body.credential_name,
      name: body.credential_info?.display_name ?? body.credential_name,
      base_url: body.credential_values?.api_base ?? '',
      api_key: body.credential_values?.api_key,
      api_format: 'openai',
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    }
    this.providers.push(p);
    return { success: true, message: 'Credential created successfully' };
  }

  async updateCredential(name, body) {
    this.gatewayCalls.push({ method: 'updateCredential', name, body });
    const p = this.providers.find((x) => x.id === name);
    if (!p) throw this.#gatewayError(404, 'credential not found');
    if (body.credential_info?.display_name !== undefined) p.name = body.credential_info.display_name;
    if (body.credential_values?.api_base !== undefined) p.base_url = body.credential_values.api_base;
    if (body.credential_values?.api_key !== undefined) p.api_key = body.credential_values.api_key;
    p.updated_at = new Date();
    return { success: true, message: 'Credential updated successfully' };
  }

  async deleteCredential(name) {
    this.gatewayCalls.push({ method: 'deleteCredential', name });
    if (!this.providers.some((p) => p.id === name)) throw this.#gatewayError(404, 'credential not found');
    this.providers = this.providers.filter((p) => p.id !== name);
    return { deleted: true };
  }

  async listModels() {
    this.gatewayCalls.push({ method: 'listModels' });
    return {
      data: this.models.map((m) => ({
        model_name: m.model_id,
        litellm_params: {
          model: m.upstream_model ?? m.model_id,
          litellm_credential_name: m.provider_id,
          ...(m.max_tokens == null ? {} : { max_tokens: m.max_tokens }),
        },
        model_info: {
          id: m.id,
          type: m.type,
          mode: m.mode,
          blocked: m.enabled === false,
          tool_calling: m.tool_calling,
          context_window: m.context_window,
          display_name: m.name,
          metadata: { type: m.type, tool_calling: m.tool_calling, context_window: m.context_window },
        },
      })),
    };
  }

  async createModel(body) {
    this.gatewayCalls.push({ method: 'createModel', body });
    const id = body.model_info?.id ?? `m${++this.nextGatewayId}`;
    const type = body.model_info?.type ?? body.model_info?.metadata?.type ?? 'text';
    this.models.push({
      id,
      provider_id: body.litellm_params?.litellm_credential_name,
      model_id: body.model_name,
      name: body.model_info?.display_name ?? body.model_name,
      type,
      mode: body.model_info?.mode,
      tool_calling: body.model_info?.tool_calling ?? body.model_info?.metadata?.tool_calling ?? false,
      context_window: body.model_info?.context_window ?? body.model_info?.metadata?.context_window ?? null,
      max_tokens: body.litellm_params?.max_tokens ?? null,
      upstream_model: body.litellm_params?.model,
      enabled: true,
    });
    if (this.createModelError) throw this.createModelError;
    return { model_id: id };
  }

  async updateModel(body) {
    this.gatewayCalls.push({ method: 'updateModel', body });
    const m = this.models.find((x) => x.id === (body.model_id ?? body.model_info?.id));
    if (!m) throw this.#gatewayError(404, 'model not found');
    const info = body.model_info ?? {};
    if (info.display_name !== undefined) m.name = info.display_name;
    if (info.type !== undefined) m.type = info.type;
    if (info.metadata?.type !== undefined) m.type = info.metadata.type;
    if (info.mode !== undefined) m.mode = info.mode;
    if (info.tool_calling !== undefined) m.tool_calling = info.tool_calling;
    if (info.context_window !== undefined) m.context_window = info.context_window;
    if (body.litellm_params !== undefined) {
      m.upstream_model = body.litellm_params.model;
      m.provider_id = body.litellm_params.litellm_credential_name;
      m.max_tokens = body.litellm_params.max_tokens ?? null;
    }
    return { model_id: m.id };
  }

  async deleteModel(id) {
    this.gatewayCalls.push({ method: 'deleteModel', id });
    if (this.deleteModelError) throw this.deleteModelError;
    if (!this.models.some((m) => m.id === id)) throw this.#gatewayError(404, 'model not found');
    this.models = this.models.filter((m) => m.id !== id);
    return { deleted: true };
  }

  async blockModel(id) {
    this.gatewayCalls.push({ method: 'blockModel', id });
    const m = this.models.find((x) => x.id === id);
    if (!m) throw this.#gatewayError(404, 'model not found');
    m.enabled = false;
  }

  async unblockModel(id) {
    this.gatewayCalls.push({ method: 'unblockModel', id });
    const m = this.models.find((x) => x.id === id);
    if (!m) throw this.#gatewayError(404, 'model not found');
    m.enabled = true;
  }

  async createUser(body) {
    this.gatewayCalls.push({ method: 'createUser', body });
    return { user_id: `gateway-user-${body.user_email}` };
  }

  async generateKey(body) {
    this.gatewayCalls.push({ method: 'generateKey', body });
    const key = `sk-test-virtual-${++this.nextGatewayId}`;
    this.generatedKeys.push(key);
    return { key, key_id: `key-id-${this.nextGatewayId}`, key_alias: body.key_alias };
  }

  async updateKey(body) {
    this.gatewayCalls.push({ method: 'updateKey', body });
    if (this.updateKeyError) throw this.updateKeyError;
    return { key: body.key, models: body.models };
  }

  async deleteKey(body) {
    this.gatewayCalls.push({ method: 'deleteKey', body });
    this.generatedKeys = this.generatedKeys.filter((key) => !body.keys.includes(key));
    return { deleted_keys: body.keys };
  }

  async blockKey(body) {
    this.gatewayCalls.push({ method: 'blockKey', body });
    return { blocked: true };
  }

  async unblockKey(body) {
    this.gatewayCalls.push({ method: 'unblockKey', body });
    return { blocked: false };
  }

  async keyInfo(key) {
    this.gatewayCalls.push({ method: 'keyInfo', key });
    return { info: { key_alias: key } };
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

    // N2/N3（Round C 评审）：fdeHasActiveRun 同口径的活跃 run 判定（llm.js 事务内复检）
    if (sql.includes('FROM runs r') && sql.includes('JOIN chat_sessions')) {
      return { rows: this.activeRun ? [{ '?column?': 1 }] : [] };
    }

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
      const allowAwaitingCredential = sql.includes("status IN ('active', 'awaiting_credential')");
      return {
        rows: this.users.filter((u) =>
          u.fde_name === fdeName
          && (allowAwaitingCredential
            ? ['active', 'awaiting_credential'].includes(u.status)
            : (!wantActive || u.status === 'active'))),
      };
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
    // D1：updateProvider 事务内当前值读取（同值 PATCH 按值判定事实变化，不走 UPDATE）
    if (sql.includes('SELECT id, name, base_url, api_format, enabled') && sql.includes('FROM llm_providers WHERE id')) {
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

    // fde_llm_bindings stores LiteLLM IDs and the generated virtual key directly.
    if (sql.includes('SELECT main_model_id, main_model_name')) {
      const b = this.bindings.find((x) => x.fde_id === params[0] && x.state === 'active' && x.gateway === 'litellm' && x.api_key);
      return { rows: b ? [{
        main_model_id: b.main_model_id,
        main_model_name: b.main_model_name ?? null,
        embedding_model_id: b.embedding_model_id ?? null,
        embedding_model_name: b.embedding_model_name ?? null,
        vision_model_id: b.vision_model_id ?? null,
        vision_model_name: b.vision_model_name ?? null,
      }] : [] };
    }
    if (sql.includes('SELECT provider_id, api_key, gateway') && sql.includes('FROM fde_llm_bindings') && !sql.includes('FOR UPDATE')) {
      const b = this.bindings.find((x) => x.fde_id === params[0] && x.state === 'active' && x.gateway === 'litellm');
      return { rows: b ? [{
        provider_id: b.provider_id, api_key: b.api_key, gateway: b.gateway,
        gateway_user_id: b.gateway_user_id ?? null, key_id: b.key_id ?? null, key_alias: b.key_alias ?? null,
        state: b.state, main_model_id: b.main_model_id,
        main_model_name: b.main_model_name ?? null,
        embedding_model_id: b.embedding_model_id ?? null, vision_model_id: b.vision_model_id ?? null,
        embedding_model_name: b.embedding_model_name ?? null, vision_model_name: b.vision_model_name ?? null,
      }] : [] };
    }
    if (sql.includes('SELECT state, provider_id, api_key, key_id, key_alias, gateway, gateway_user_id')) {
      const b = this.bindings.find((x) => x.fde_id === params[0]);
      return { rows: b ? [{ ...b }] : [] };
    }
    if (sql.includes('SELECT provider_id FROM fde_llm_bindings')) {
      const b = this.bindings.find((x) => x.fde_id === params[0] && x.state === 'active');
      return { rows: b ? [{ provider_id: b.provider_id }] : [] };
    }
    if (sql.includes('SELECT api_key, key_alias, gateway FROM fde_llm_bindings')) {
      const b = this.bindings.find((x) => x.fde_id === params[0] && x.state === 'active');
      return { rows: b ? [{ api_key: b.api_key, key_alias: b.key_alias, gateway: b.gateway }] : [] };
    }
    if (sql.includes('SELECT provider_id, api_key, gateway, gateway_user_id') && sql.includes('FOR UPDATE')) {
      const b = this.bindings.find((x) => x.fde_id === params[0]);
      return { rows: b ? [{ ...b }] : [] };
    }
    if (sql.includes('UPDATE fde_llm_bindings') && sql.includes("SET state = 'revoked'")) {
      const b = this.bindings.find((x) => x.fde_id === params[0] && x.state === 'active');
      if (b) {
        b.state = 'revoked'; b.api_key = null; b.revoked_at = new Date(); b.updated_at = new Date();
      }
      return { rows: [], rowCount: b ? 1 : 0 };
    }
    if (sql.includes('UPDATE fde_llm_bindings') && sql.includes("SET gateway = 'litellm'")) {
      const [fdeId, gatewayUserId, keyId, keyAlias, apiKey, mainModelName, embeddingModelName, visionModelName, incrementGeneration] = params;
      const b = this.bindings.find((x) => x.fde_id === fdeId);
      if (b) {
        Object.assign(b, {
          gateway: 'litellm', gateway_user_id: gatewayUserId, key_id: keyId, key_alias: keyAlias,
          api_key: apiKey, main_model_name: mainModelName, embedding_model_name: embeddingModelName,
          vision_model_name: visionModelName, state: 'active', revoked_at: null, updated_at: new Date(),
        });
        if (incrementGeneration) {
          b.generation = (b.generation ?? 1) + 1;
          b.rotated_at = new Date();
        }
      }
      return { rows: [], rowCount: b ? 1 : 0 };
    }
    if (sql.includes('UPDATE fde_llm_bindings') && sql.includes('SET provider_id = $2')) {
      const [fdeId, providerId, apiKey, keyId, keyAlias, gatewayUserId,
        mainId, mainName, embId, embName, visId, visName, incrementGeneration] = params;
      const b = this.bindings.find((x) => x.fde_id === fdeId);
      if (b) {
        Object.assign(b, {
          provider_id: providerId, api_key: apiKey, key_id: keyId, key_alias: keyAlias,
          gateway: 'litellm', gateway_user_id: gatewayUserId, state: 'active', revoked_at: null,
          main_model_id: mainId, main_model_name: mainName,
          embedding_model_id: embId, embedding_model_name: embName,
          vision_model_id: visId, vision_model_name: visName, updated_at: new Date(),
        });
        if (incrementGeneration) b.generation = (b.generation ?? 1) + 1;
      }
      return { rows: [], rowCount: b ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO fde_llm_bindings')) {
      const [fdeId, gatewayUserId, keyId, keyAlias, providerId, apiKey,
        mainId, mainName, embId, embName, visId, visName] = params;
      this.bindings.push({
        fde_id: fdeId, gateway: 'litellm', gateway_user_id: gatewayUserId,
        key_id: keyId, key_alias: keyAlias, state: 'active', generation: 1,
        provider_id: providerId, api_key: apiKey, main_model_id: mainId, main_model_name: mainName,
        embedding_model_id: embId, embedding_model_name: embName,
        vision_model_id: visId, vision_model_name: visName, revoked_at: null,
      });
      return { rows: [], rowCount: 1 };
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

test('credential CRUD：create → list（含 models）→ update base_url → delete', async () => {
  const pool = new LlmFakePool();
  const p = await createProvider(pool, { name: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-test-upstream-secret' });
  assert.equal(p.name, 'deepseek');
  assert.equal(p.api_format, 'openai');
  assert.equal('enabled' in p, false, 'LiteLLM credential 没有供应商启停字段');
  assert.equal(pool.gatewayCalls.find((call) => call.method === 'createCredential').body.credential_values.api_key, 'sk-test-upstream-secret');

  await createModel(pool, { provider_id: p.id, model_id: 'deepseek-flash', model: 'deepseek/deepseek-chat', name: 'DeepSeek Flash', type: 'text', tool_calling: true, context_window: 128000 });
  const { items } = await listProviders(pool);
  assert.equal(items.length, 1);
  assert.equal(items[0].models.length, 1);
  assert.equal(items[0].models[0].model_id, 'm1');
  assert.equal(items[0].credential_values.api_key, maskKey('sk-test-upstream-secret'));

  const updated = await updateProvider(pool, p.id, { base_url: 'https://proxy.deepseek.example/v1' });
  assert.equal(updated.base_url, 'https://proxy.deepseek.example/v1');
  assert.equal(pool.providers[0].api_key, 'sk-test-upstream-secret');

  await deleteProvider(pool, p.id);
  assert.equal(pool.providers.length, 0);
  assert.equal(pool.models.length, 1, 'LiteLLM owns credential/model cascade semantics');
});

test('credential create：includes required credential_info and forwards duplicate rejection', async () => {
  const pool = new LlmFakePool();
  await createProvider(pool, { name: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-test-key' });
  const call = pool.gatewayCalls.find((item) => item.method === 'createCredential');
  assert.equal(call.body.credential_info.credential_name, 'deepseek');
  assert.equal(call.body.credential_values.api_base, 'https://api.deepseek.com/v1');
  await assert.rejects(
    () => createProvider(pool, { name: 'deepseek' }),
    (e) => e.status === 422 && /credential already exists/.test(e.message),
  );
});

test('credential delete：thin proxy does not query Station binding references', async () => {
  const pool = new LlmFakePool({
    providers: [{ id: 'p1', name: 'deepseek', base_url: 'https://api.deepseek.com/v1' }],
    bindings: [{
      fde_id: 'u1', state: 'active', provider_id: 'p1', api_key: 'sk-test-virtual-key', main_model_id: 'deepseek-flash',
    }],
  });
  await deleteProvider(pool, 'p1');
  assert.equal(pool.gatewayCalls.at(-1).method, 'deleteCredential');
  assert.equal(pool.sqlLog.some((call) => call.sql.includes('fde_llm_bindings')), false);
});

// ---------------------------------------------------------------------------
// LiteLLM credential PATCH no longer changes a Station-owned provider router.
// ---------------------------------------------------------------------------

function seedProviderWithBindings() {
  return new LlmFakePool({
    users: [{ id: 'u1', fde_name: 'alice', status: 'active' }, { id: 'u2', fde_name: 'bob', status: 'active' }],
    providers: [{ id: 'p1', name: 'openai', base_url: 'https://api.openai.com/v1', enabled: true }],
    bindings: [
      { fde_id: 'u1', gateway: 'direct', key_alias: 'alice@llm', state: 'active', generation: 1, provider_id: 'p1', api_key: 'sk-secret-alice', main_model_id: 'm1' },
      { fde_id: 'u2', gateway: 'direct', key_alias: 'bob@llm', state: 'active', generation: 1, provider_id: 'p1', api_key: 'sk-secret-bob', main_model_id: 'm1' },
    ],
  });
}

test('credential PATCH base_url preserves credentials and does not write route outbox', async () => {
  const pool = seedProviderWithBindings();
  const updated = await updateProvider(pool, 'p1', { base_url: 'https://proxy.internal/v2' });
  assert.equal(updated.base_url, 'https://proxy.internal/v2');
  assert.equal(pool.gatewayCalls.find((call) => call.method === 'updateCredential').body.credential_values.api_base, 'https://proxy.internal/v2');
  assert.equal(pool.outbox.length, 0);
});

test('credential PATCH rejects enabled because credentials have no enabled state', async () => {
  const pool = seedProviderWithBindings();
  await assert.rejects(() => updateProvider(pool, 'p1', { enabled: false }),
    (e) => e instanceof LlmError && e.code === 'validation_failed' && e.details.field === 'enabled');
  assert.equal(pool.gatewayCalls.length, 0);
});

test('credential PATCH forwards empty updates and propagates missing credential 404', async () => {
  const pool = seedProviderWithBindings();
  await updateProvider(pool, 'p1', {});
  assert.equal(pool.outbox.length, 0, '无 base_url/enabled 变更不写 outbox');
  await assert.rejects(() => updateProvider(pool, 'p-ghost', { base_url: 'https://proxy.internal/v2' }),
    (e) => e.httpStatus === 404);
  assert.equal(pool.outbox.length, 0);
});

test('credential PATCH does not block or mutate based on an FDE active run', async () => {
  const pool = seedProviderWithBindings();
  pool.activeRun = true;
  const updated = await updateProvider(pool, 'p1', { base_url: 'https://new-upstream.example.com' });
  assert.equal(updated.base_url, 'https://new-upstream.example.com');
  assert.equal(pool.outbox.length, 0);
  assert.equal(pool.sqlLog.some((entry) => entry.sql.includes('FROM runs')), false);
});

test('credential PATCH delegates equal-value updates without Station state checks', async () => {
  const pool = seedProviderWithBindings();
  pool.activeRun = true;
  await updateProvider(pool, 'p1', { base_url: 'https://api.openai.com/v1' });
  assert.equal(pool.gatewayCalls.filter((call) => call.method === 'updateCredential').length, 1);
  assert.equal(pool.outbox.length, 0);
});

test('credential PATCH takes no provider advisory lock', async () => {
  const pool = seedProviderWithBindings();
  pool.activeRun = true;
  await updateProvider(pool, 'p1', { base_url: 'https://proxy.example/v1' });
  assert.equal(pool.sqlLog.some((entry) => entry.sql.includes('pg_advisory_xact_lock')), false);
  assert.equal(pool.outbox.length, 0);
});

test('postMessage lock order remains chat_sessions → llm-binding → containers', async () => {
  // 按现有 fake pool 测试风格：内存 client 派发 postMessage 的全部 SQL 并记录顺序。
  const order = [];
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const client = {
    async query(sql, params = []) {
      order.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
      if (s.includes('pg_advisory_xact_lock')) return { rows: [] };
      // P5：fetchSession 不再 JOIN projects（cwd 为权威绑定，project_id 可空留档）。
      if (s.includes('FROM chat_sessions s') && s.includes('FOR UPDATE')) {
        return { rows: [{ id: sessionId, user_id: 'u1', project_id: null, cwd: '~/projects/p', title: 't', model: null, status: 'active', last_seq: 0 }] };
      }
      if (s.includes('FROM runs WHERE session_id')) return { rows: [] };
      if (s.includes('SELECT fde_name FROM users WHERE id')) return { rows: [{ fde_name: 'alice' }] };
      if (s.includes('FROM containers')) return { rows: [{ id: 'c1' }] };
      if (s.includes('UPDATE chat_sessions SET last_seq')) return { rows: [{ last_seq: 1 }] };
      if (s.startsWith('INSERT INTO messages')) {
        return { rows: [{ id: 'm1', seq: 1, role: 'user', content: 'hi', attachments: '[]', created_at: new Date() }] };
      }
      if (s.startsWith('INSERT INTO runs')) return { rows: [{ id: 'r1', status: 'queued' }] };
      if (s.startsWith('INSERT INTO run_queue')) return { rows: [] };
      if (s.startsWith('UPDATE messages SET run_id')) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const pool = { connect: async () => client };
  const posted = await postMessage(pool, { userId: 'u1', sessionId, content: 'hi', attachments: [] });
  assert.equal(posted.run.status, 'queued');

  const seq = order.map((e) => e.sql);
  const idx = (pred) => seq.findIndex(pred);
  const iChat = idx((s) => s.includes('FROM chat_sessions s') && s.includes('FOR UPDATE'));
  const iBindLock = order.findIndex((e) => e.sql.includes('pg_advisory_xact_lock') && e.params[0] === 'llm-binding:alice');
  const iContainers = idx((s) => s.includes('FROM containers') && s.includes('FOR UPDATE'));
  assert.ok(iChat !== -1 && iChat < iBindLock, 'chat_sessions FOR UPDATE 最先');
  assert.equal(order[iBindLock].params[0], 'llm-binding:alice');
  assert.ok(iBindLock < iContainers, 'binding lock precedes the container row lock');
});

test('setFdeLlmConfig rechecks active runs before model-binding changes; force permits allowlist changes', async () => {
  const pool = seedPool();
  await saveFdeConfig(pool, { fdeName: 'alice', provider_id: 'p1', main_model_id: 'm-main' });
  const outboxBase = pool.outbox.length;
  const firstKey = pool.bindings[0].api_key;
  pool.activeRun = true;

  // Changing the credential/model allowlist while a run is active is rejected.
  await assert.rejects(
    () => saveFdeConfig(pool, { fdeName: 'alice', provider_id: 'p2', main_model_id: 'm-other-provider' }),
    (e) => e instanceof LlmError && e.code === 'active_run_conflict' && e.httpStatus === 409
      && /白名单/.test(e.message) && !/轮换/.test(e.message),
  );

  // Upstream credentials cannot be submitted through per-FDE configuration.
  await assert.rejects(
    () => saveFdeConfig(pool, { fdeName: 'alice', provider_id: 'p1', api_key: FULL_KEY, main_model_id: 'm-main' }),
    (e) => e instanceof LlmError && e.code === 'validation_failed' && e.details.field === 'api_key',
  );
  const b0 = pool.bindings.find((b) => b.fde_id === 'u1');
  assert.equal(b0.provider_id, 'p1', '409 不写库');
  assert.equal(b0.api_key, firstKey, '409 不写库');
  assert.equal(pool.outbox.length, outboxBase, '409 不写 outbox');

  // An identical binding is idempotent even while a run is active.
  const ok1 = await saveFdeConfig(pool, { fdeName: 'alice', provider_id: 'p1', main_model_id: 'm-main' });
  assert.equal(ok1.api_key, maskKey(firstKey));
  assert.equal(pool.outbox.length, outboxBase);

  const ok2 = await saveFdeConfig(pool, {
    fdeName: 'alice', provider_id: 'p2', main_model_id: 'm-other-provider', force: true,
  });
  assert.equal(ok2.api_key, maskKey(firstKey), 'force permits an in-place allowlist update');
  assert.equal(pool.generatedKeys.length, 1, 'allowlist change does not mint a replacement key');
  assert.equal(pool.gatewayCalls.filter((call) => call.method === 'updateKey').length, 1);
  assert.equal(pool.gatewayCalls.filter((call) => call.method === 'generateKey').length, 1);
  assert.equal(pool.bindings[0].generation, 1, 'in-place allowlist updates do not bump generation');
  assert.equal(pool.outbox.length, outboxBase + 1, 'forced change writes its binding outbox');

  const seq = pool.sqlLog.map((e) => e.sql);
  assert.ok(seq.some((sql) => sql.includes('pg_advisory_xact_lock')));
  assert.ok(seq.some((sql) => sql.includes('FROM runs r') && sql.includes('JOIN chat_sessions')));
  assert.ok(seq.some((sql) => sql.includes('INSERT INTO route_outbox')));
});

// ---------------------------------------------------------------------------
// model CRUD
// ---------------------------------------------------------------------------

test('typeToMode：模型用途映射，未知类型默认 chat', () => {
  for (const [type, mode] of [
    ['text', 'chat'],
    ['vision', 'chat'],
    ['embedding', 'embedding'],
    ['rerank', 'rerank'],
    ['audio-tts', 'audio_speech'],
    ['audio-stt', 'audio_transcription'],
    ['image-gen', 'image_generation'],
    [undefined, 'chat'],
    ['unknown', 'chat'],
  ]) {
    assert.equal(typeToMode(type), mode);
  }
});

test('model create：proxy sends explicit upstream model, credential and metadata', async () => {
  const pool = new LlmFakePool({
    providers: [
      { id: 'p1', name: 'deepseek', base_url: 'https://api.deepseek.com/v1', enabled: true },
    ],
  });
  const m = await createModel(pool, {
    provider_id: 'p1',
    model_id: 'deepseek-flash',
    model: 'deepseek/deepseek-chat',
    name: 'DeepSeek Flash',
    type: 'text',
    tool_calling: true,
    max_tokens: 4096,
  });
  assert.equal(m.model_id, 'm1');
  const call = pool.gatewayCalls.find((entry) => entry.method === 'createModel');
  assert.equal(call.body.model_name, 'deepseek-flash');
  assert.equal(call.body.litellm_params.model, 'deepseek/deepseek-chat');
  assert.equal(call.body.litellm_params.litellm_credential_name, 'p1');
  assert.equal(call.body.litellm_params.max_tokens, 4096);
  assert.equal(call.body.model_info.type, 'text');
  assert.equal(call.body.model_info.mode, 'chat');
  assert.equal(call.body.model_info.tool_calling, true);
  assert.deepEqual(LLM_MODEL_TYPES, ['text', 'embedding', 'vision', 'rerank', 'audio-tts', 'audio-stt', 'image-gen']);
});

test('model create：max_tokens 为 undefined 或 null 时不写入 LiteLLM 参数', async () => {
  for (const max_tokens of [undefined, null]) {
    const pool = new LlmFakePool();
    await createModel(pool, {
      provider_id: 'p1',
      model_id: 'gpt-4o',
      model: 'openai/gpt-4o',
      max_tokens,
    });
    const call = pool.gatewayCalls.find((entry) => entry.method === 'createModel');
    assert.equal(Object.hasOwn(call.body.litellm_params, 'max_tokens'), false);
  }
});

test('model list：toModel exposes max_tokens and defaults missing values to null', async () => {
  const pool = new LlmFakePool({
    models: [
      { id: 'm1', provider_id: 'p1', model_id: 'gpt-4o', max_tokens: 8192 },
      { id: 'm2', provider_id: 'p1', model_id: 'gpt-4o-mini' },
    ],
  });
  const { items } = await listModels(pool);
  assert.equal(items[0].max_tokens, 8192);
  assert.equal(items[1].max_tokens, null);
});

test('model create：max_tokens 只接受正整数', async () => {
  const pool = new LlmFakePool();
  for (const max_tokens of [0, -1, 1.5, '1024', true]) {
    await assert.rejects(
      () => createModel(pool, {
        provider_id: 'p1',
        model_id: 'gpt-4o',
        model: 'openai/gpt-4o',
        max_tokens,
      }),
      (error) => error instanceof LlmError
        && error.code === 'validation_failed'
        && error.details.field === 'max_tokens',
    );
  }
  assert.equal(pool.gatewayCalls.length, 0);
});

test('model create：缺少上游 model id 时拒绝且不访问网关', async () => {
  const pool = new LlmFakePool();
  await assert.rejects(
    () => createModel(pool, { provider_id: 'p1', model_id: 'display-name' }),
    (error) => error instanceof LlmError
      && error.code === 'validation_failed'
      && error.details.field === 'model',
  );
  assert.equal(pool.gatewayCalls.length, 0);
});

test('model create：创建失败后回滚新增同名记录但保留既有记录', async () => {
  const failure = new Error('model reload failed');
  const pool = new LlmFakePool({
    models: [
      { id: 'existing', provider_id: 'p1', model_id: 'tmp-model', upstream_model: 'openai/original', name: 'Existing', type: 'text' },
      { id: 'other', provider_id: 'p1', model_id: 'other-model', upstream_model: 'openai/other', name: 'Other', type: 'text' },
    ],
  });
  pool.createModelError = failure;
  await assert.rejects(
    () => createModel(pool, {
      provider_id: 'p1',
      model_id: 'tmp-model',
      model: 'openai/tmp-model',
      name: 'Temporary',
    }),
    (error) => error === failure,
  );
  assert.deepEqual(pool.models.map((model) => model.id), ['existing', 'other']);
  assert.deepEqual(
    pool.gatewayCalls.filter((call) => call.method === 'deleteModel'),
    [{ method: 'deleteModel', id: 'm1' }],
  );
});

test('model create：回滚删除失败时仍抛原始创建错误', async () => {
  const createFailure = new Error('model reload failed');
  const pool = new LlmFakePool();
  pool.createModelError = createFailure;
  pool.deleteModelError = new Error('delete failed');
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    await assert.rejects(
      () => createModel(pool, {
        provider_id: 'p1',
        model_id: 'tmp-model',
        model: 'openai/tmp-model',
      }),
      (error) => error === createFailure,
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], '[llm] LiteLLM model create rollback failed');
  assert.equal(logged[0][1].model_id, 'm1');
});

test('model update：透传上游 model，并同时更新 model_info 与 metadata', async () => {
  const pool = new LlmFakePool({
    models: [{
      id: 'm1',
      provider_id: 'p1',
      model_id: 'gpt-4o',
      upstream_model: 'openai/gpt-4o',
      name: 'GPT-4o',
      type: 'text',
      tool_calling: true,
      context_window: 128000,
      max_tokens: 4096,
    }],
  });
  await updateModel(pool, 'm1', {
    model: ' openai/gpt-4o-updated ',
    type: 'embedding',
    tool_calling: false,
    context_window: 4096,
    max_tokens: 8192,
  });
  const call = pool.gatewayCalls.find((entry) => entry.method === 'updateModel');
  assert.deepEqual(call.body.litellm_params, {
    model: 'openai/gpt-4o-updated',
    litellm_credential_name: 'p1',
    max_tokens: 8192,
  });
  assert.equal(call.body.model_info.type, 'embedding');
  assert.equal(call.body.model_info.mode, 'embedding');
  assert.equal(call.body.model_info.metadata.type, 'embedding');
  assert.equal(call.body.model_info.tool_calling, false);
  assert.equal(call.body.model_info.context_window, 4096);
  assert.equal(call.body.model_info.metadata.tool_calling, false);
  assert.equal(call.body.model_info.metadata.context_window, 4096);
  assert.equal(pool.models[0].upstream_model, 'openai/gpt-4o-updated');
  assert.equal(pool.models[0].type, 'embedding');
  assert.equal(pool.models[0].mode, 'embedding');
  assert.equal(pool.models[0].max_tokens, 8192);

  await updateModel(pool, 'm1', { name: 'Embedding renamed' });
  const nameOnlyCall = pool.gatewayCalls.filter((entry) => entry.method === 'updateModel')[1];
  assert.equal(nameOnlyCall.body.model_info.type, 'embedding');
  assert.equal(nameOnlyCall.body.model_info.mode, 'embedding');
  assert.equal(nameOnlyCall.body.model_info.metadata.type, 'embedding');

  await updateModel(pool, 'm1', { model: ' ' });
  assert.equal(pool.gatewayCalls.filter((entry) => entry.method === 'updateModel').length, 2);

  await updateModel(pool, 'm1', { max_tokens: null });
  const clearMaxTokensCall = pool.gatewayCalls.filter((entry) => entry.method === 'updateModel')[2];
  assert.deepEqual(clearMaxTokensCall.body.litellm_params, {
    model: 'openai/gpt-4o-updated',
    litellm_credential_name: 'p1',
  });
  assert.equal(pool.models[0].max_tokens, null);
});

test('model update：max_tokens 只接受 null 或正整数', async () => {
  const pool = new LlmFakePool({
    models: [{ id: 'm1', provider_id: 'p1', model_id: 'gpt-4o', upstream_model: 'openai/gpt-4o' }],
  });
  for (const max_tokens of [0, -1, 1.5, '1024', true]) {
    await assert.rejects(
      () => updateModel(pool, 'm1', { max_tokens }),
      (error) => error instanceof LlmError
        && error.code === 'validation_failed'
        && error.details.field === 'max_tokens',
    );
  }
  assert.equal(pool.gatewayCalls.length, 0);
});

test('model delete：forwards the LiteLLM model_info.id; missing model propagates 404', async () => {
  const pool = new LlmFakePool({
    providers: [{ id: 'p1', name: 'deepseek', base_url: 'https://api.deepseek.com/v1' }],
    models: [{ id: 'm1', provider_id: 'p1', model_id: 'deepseek-flash', name: 'DeepSeek Flash', type: 'text' }],
    bindings: [{
      fde_id: 'u1', state: 'active', provider_id: 'p1', api_key: 'sk-test-virtual-key', main_model_id: 'm1',
    }],
  });
  await deleteModel(pool, 'm1');
  assert.deepEqual(pool.gatewayCalls.at(-1), { method: 'deleteModel', id: 'm1' });
  await assert.rejects(() => deleteModel(pool, 'm1'), (e) => e.httpStatus === 404);
});

// ---------------------------------------------------------------------------
// FDE LLM 配置写入：校验 400 + outbox 联动 + audit 不含 key
// ---------------------------------------------------------------------------

function seedPool({ userStatus = 'active' } = {}) {
  return new LlmFakePool({
    users: [{ id: 'u1', fde_name: 'alice', status: userStatus }],
    providers: [
      { id: 'p1', name: 'deepseek', base_url: 'https://api.deepseek.com/v1', enabled: true },
      { id: 'p2', name: 'other', base_url: 'https://other.example.com', enabled: true },
    ],
    models: [
      { id: 'm-main', provider_id: 'p1', model_id: 'deepseek-flash', name: 'DeepSeek Flash', type: 'text', tool_calling: true, enabled: true },
      { id: 'm-main-notool', provider_id: 'p1', model_id: 'deepseek-flash', name: 'DeepSeek Flash (no tools)', type: 'text', tool_calling: false, enabled: true },
      { id: 'm-emb', provider_id: 'p1', model_id: 'text-embedding-3', name: 'Emb3', type: 'embedding', tool_calling: false, enabled: true },
      { id: 'm-vis', provider_id: 'p1', model_id: 'deepseek-flash', name: 'DeepSeek Flash Vision', type: 'vision', tool_calling: false, enabled: true },
      { id: 'm-other-provider', provider_id: 'p2', model_id: 'deepseek-flash', name: 'DeepSeek Flash (other)', type: 'text', tool_calling: true, enabled: true },
      { id: 'm-disabled', provider_id: 'p1', model_id: 'deepseek-flash', name: 'DeepSeek Flash (blocked)', type: 'text', tool_calling: true, enabled: false },
    ],
  });
}

const FULL_KEY = 'sk-live-abcdef1234567890xyz';
const saveFdeConfig = (pool, options) => setFdeLlmConfig(pool, { ...options, gateway: pool });

test('setFdeLlmConfig：main 未 tool_calling → 400 validation_failed', async () => {
  const pool = seedPool();
  await assert.rejects(
    () => saveFdeConfig(pool, { fdeName: 'alice', provider_id: 'p1', main_model_id: 'm-main-notool' }),
    (e) => e instanceof LlmError && e.httpStatus === 400 && e.code === 'validation_failed' && e.details.field === 'main',
  );
});

test('setFdeLlmConfig：embedding 位选了 text 模型 → 400（type 不匹配）', async () => {
  const pool = seedPool();
  await assert.rejects(
    () => saveFdeConfig(pool, {
      fdeName: 'alice', provider_id: 'p1',
      main_model_id: 'm-main', embedding_model_id: 'm-main',
    }),
    (e) => e instanceof LlmError && e.httpStatus === 400 && e.code === 'validation_failed' && e.details.field === 'embedding',
  );
});

test('setFdeLlmConfig：模型 provider 与配置 provider 不一致 → 400', async () => {
  const pool = seedPool();
  await assert.rejects(
    () => saveFdeConfig(pool, { fdeName: 'alice', provider_id: 'p1', main_model_id: 'm-other-provider' }),
    (e) => e instanceof LlmError && e.httpStatus === 400 && e.code === 'validation_failed' && /不匹配/.test(e.message),
  );
});

test('setFdeLlmConfig：blocked model / mismatched credential / upstream key submission are rejected', async () => {
  const pool = seedPool();
  await assert.rejects(
    () => saveFdeConfig(pool, { fdeName: 'alice', provider_id: 'p1', main_model_id: 'm-disabled' }),
    (e) => e.httpStatus === 400 && e.code === 'validation_failed',
  );
  await assert.rejects(
    () => saveFdeConfig(pool, { fdeName: 'alice', provider_id: 'p-nonexistent', main_model_id: 'm-main' }),
    (e) => e.httpStatus === 400 && e.code === 'validation_failed',
  );
  await assert.rejects(
    () => saveFdeConfig(pool, { fdeName: 'alice', provider_id: 'p1', api_key: FULL_KEY, main_model_id: 'm-main' }),
    (e) => e.httpStatus === 400 && e.code === 'validation_failed' && e.details.field === 'api_key',
  );
});

test('setFdeLlmConfig：成功 → upsert + route outbox（llm_binding）+ audit 不含 key；返回掩码', async () => {
  const pool = seedPool();
  const echo = await saveFdeConfig(pool, {
    actorId: 'admin-1', fdeName: 'alice', provider_id: 'p1',
    main_model_id: 'm-main', embedding_model_id: 'm-emb', vision_model_id: 'm-vis',
  });
  assert.equal(echo.api_key, maskKey(pool.generatedKeys[0]), '响应只给 virtual-key 掩码');
  assert.equal(echo.main.model_id, 'm-main');
  assert.equal(echo.embedding.model_id, 'm-emb');

  // binding stores the minted LiteLLM virtual key and model_info.id slots.
  const b = pool.bindings.find((x) => x.fde_id === 'u1');
  assert.equal(b.gateway, 'litellm');
  assert.equal(b.key_alias, 'fde-alice');
  assert.equal(b.state, 'active');
  assert.equal(b.generation, 1);
  assert.equal(b.api_key, pool.generatedKeys[0], 'DB stores only the LiteLLM virtual key');
  assert.deepEqual(pool.gatewayCalls.find((call) => call.method === 'generateKey').body.models, ['deepseek-flash', 'text-embedding-3']);

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
  assert.equal(JSON.parse(pool.audit[0].details).virtual_key_action, 'created');
  assert.equal(JSON.parse(pool.audit[0].details).virtual_key_rotated, false);
  assert.ok(!pool.audit[0].details.includes(b.api_key), 'audit details 不含 virtual key');
  assert.ok(pool.audit[0].details.includes('deepseek-flash'));

  // outbox / audit 的参数不得含真 key（红线 ③：不进日志/审计；binding INSERT 存明文是设计内）
  for (const call of pool.sqlLog) {
    if (call.sql.includes('route_outbox') || call.sql.includes('audit_log')) {
      for (const p of call.params ?? []) {
        assert.notEqual(p, b.api_key, `outbox/audit SQL 参数不得含 virtual key: ${call.sql.slice(0, 60)}`);
      }
    }
  }
});

test('setFdeLlmConfig：active LiteLLM key 原地更新白名单，不铸新 key 且 generation 不变', async () => {
  const pool = seedPool();
  const first = await saveFdeConfig(pool, {
    fdeName: 'alice', provider_id: 'p1', main_model_id: 'm-main',
  });
  const rotatedAt = new Date('2026-01-01T00:00:00.000Z');
  pool.bindings[0].rotated_at = rotatedAt;
  const original = { ...pool.bindings[0] };

  const updated = await saveFdeConfig(pool, {
    fdeName: 'alice', provider_id: 'p1', main_model_id: 'm-main', embedding_model_id: 'm-emb',
  });

  assert.deepEqual(
    pool.gatewayCalls.filter((call) => call.method === 'updateKey').map((call) => call.body),
    [{ key: original.api_key, models: ['deepseek-flash', 'text-embedding-3'] }],
  );
  assert.equal(pool.gatewayCalls.filter((call) => call.method === 'generateKey').length, 1);
  assert.equal(updated.api_key, first.api_key);
  assert.equal(pool.bindings[0].api_key, original.api_key);
  assert.equal(pool.bindings[0].key_id, original.key_id);
  assert.equal(pool.bindings[0].key_alias, original.key_alias);
  assert.equal(pool.bindings[0].generation, original.generation);
  assert.equal(pool.bindings[0].rotated_at, rotatedAt, 'allowlist update does not change rotated_at');
  assert.equal(pool.outbox.length, 2, '修改白名单仍发布新的 binding');
  const audit = JSON.parse(pool.audit.at(-1).details);
  assert.equal(audit.virtual_key_action, 'allowlist_updated');
  assert.equal(audit.virtual_key_rotated, false);
});

test('setFdeLlmConfig：active key 在 LiteLLM 不存在时回退铸新 key', async () => {
  const pool = seedPool();
  await saveFdeConfig(pool, { fdeName: 'alice', provider_id: 'p1', main_model_id: 'm-main' });
  const oldKey = pool.bindings[0].api_key;
  pool.generatedKeys = [];
  pool.updateKeyError = Object.assign(new Error('Virtual key not found'), { status: 404 });

  const updated = await saveFdeConfig(pool, {
    fdeName: 'alice', provider_id: 'p1', main_model_id: 'm-main', embedding_model_id: 'm-emb',
  });

  assert.equal(pool.gatewayCalls.filter((call) => call.method === 'updateKey').length, 1);
  assert.equal(pool.gatewayCalls.filter((call) => call.method === 'generateKey').length, 2);
  assert.notEqual(pool.bindings[0].api_key, oldKey);
  assert.equal(pool.bindings[0].api_key, pool.generatedKeys[0]);
  assert.equal(pool.bindings[0].key_alias, 'fde-alice');
  assert.equal(pool.bindings[0].generation, 2, 'repair mint replaces the missing active key');
  assert.equal(updated.api_key, maskKey(pool.bindings[0].api_key));
  assert.equal(pool.gatewayCalls.filter((call) => call.method === 'deleteKey').length, 0,
    'do not try to revoke the key already reported missing');
  const audit = JSON.parse(pool.audit.at(-1).details);
  assert.equal(audit.virtual_key_action, 'rotated');
  assert.equal(audit.virtual_key_rotated, true);
});

test('setFdeLlmConfig：无旧 binding 的首次配置仍调用 generateKey', async () => {
  const pool = seedPool();
  const config = await saveFdeConfig(pool, {
    fdeName: 'alice', provider_id: 'p1', main_model_id: 'm-main',
  });

  assert.equal(pool.gatewayCalls.filter((call) => call.method === 'generateKey').length, 1);
  assert.equal(pool.gatewayCalls.filter((call) => call.method === 'updateKey').length, 0);
  assert.equal(config.api_key, maskKey(pool.bindings[0].api_key));
});

test('setFdeLlmConfig：开户可为 awaiting_credential 用户建 key；onlyIfMissing 不覆盖已有 binding', async () => {
  const pool = seedPool({ userStatus: 'awaiting_credential' });
  const config = await setFdeLlmConfig(pool, {
    fdeName: 'alice',
    provider_id: 'p1',
    main_model_id: 'm-main',
    allowAwaitingCredential: true,
    onlyIfMissing: true,
    gateway: pool,
  });
  assert.equal(config.api_key, maskKey(pool.bindings[0].api_key));
  assert.equal(pool.bindings[0].state, 'active');
  assert.equal(pool.gatewayCalls.filter((call) => call.method === 'generateKey').length, 1);

  const original = structuredClone(pool.bindings[0]);
  const modelCatalogCalls = pool.gatewayCalls.filter((call) => call.method === 'listModels').length;
  const skipped = await setFdeLlmConfig(pool, {
    fdeName: 'alice',
    provider_id: 'p1',
    main_model_id: 'm-emb',
    allowAwaitingCredential: true,
    onlyIfMissing: true,
    gateway: pool,
  });
  assert.deepEqual(skipped, { skipped: true });
  assert.deepEqual(pool.bindings[0], original, 'existing binding is never overwritten');
  assert.equal(pool.gatewayCalls.filter((call) => call.method === 'generateKey').length, 1);
  assert.equal(pool.gatewayCalls.filter((call) => call.method === 'listModels').length, modelCatalogCalls,
    'idempotent onboarding does not require a gateway lookup');
});

test('setFdeLlmConfig：默认仍拒绝 awaiting_credential 用户，LLM tab 不放宽 active 限制', async () => {
  const pool = seedPool({ userStatus: 'awaiting_credential' });
  await assert.rejects(
    () => setFdeLlmConfig(pool, {
      fdeName: 'alice',
      provider_id: 'p1',
      main_model_id: 'm-main',
      gateway: pool,
    }),
    (error) => error.httpStatus === 404,
  );
  assert.equal(pool.bindings.length, 0);
  assert.equal(pool.gatewayCalls.filter((call) => call.method === 'generateKey').length, 0);
});

test('setFdeLlmConfig：相同 binding 幂等复用 virtual key；generation 不变且不重复发 outbox', async () => {
  const pool = seedPool();
  const first = await saveFdeConfig(pool, { fdeName: 'alice', provider_id: 'p1', main_model_id: 'm-main' });
  const echo = await saveFdeConfig(pool, { fdeName: 'alice', provider_id: 'p1', main_model_id: 'm-main' });
  assert.equal(echo.api_key, first.api_key, '相同配置复用原有 virtual key');
  const b = pool.bindings.find((x) => x.fde_id === 'u1');
  assert.equal(b.api_key, pool.generatedKeys[0]);
  assert.equal(b.generation, 1, '更新不改 generation');
  assert.equal(pool.outbox.length, 1, '幂等重试不写新 outbox');
  assert.equal(pool.generatedKeys.length, 1, '幂等重试不再次 mint key');
});

test('getFdeLlmHeartbeatModels：stored model_info.id resolves to LiteLLM data-plane model_name; missing binding → null', async () => {
  const pool = seedPool();
  assert.equal(await getFdeLlmHeartbeatModels(pool, 'u1'), null, '无配置 → null');

  await saveFdeConfig(pool, { fdeName: 'alice', provider_id: 'p1', main_model_id: 'm-main', embedding_model_id: 'm-emb' });

  const models = await getFdeLlmHeartbeatModels(pool, 'u1');
  assert.deepEqual(models, {
    main: { model: 'deepseek-flash', type: 'text' },
    embedding: { model: 'text-embedding-3', type: 'embedding' },
  }, '请求体使用 LiteLLM model_name，不可误用不同的 model_info.id');
  assert.equal(pool.bindings[0].main_model_id, 'm-main', 'DB 仍保存 LiteLLM model_info.id');
  assert.equal(pool.bindings[0].main_model_name, 'deepseek-flash', '数据面别名单独保存');

  // LiteLLM owns model metadata; heartbeat returns the stored slot without a local model join.
  pool.models.find((m) => m.id === 'm-main').tool_calling = false;
  assert.deepEqual(await getFdeLlmHeartbeatModels(pool, 'u1'), models);

  // binding revoked → null
  pool.bindings.find((b) => b.fde_id === 'u1').state = 'revoked';
  assert.equal(await getFdeLlmHeartbeatModels(pool, 'u1'), null);

  // Missing virtual key → null.
  pool.bindings.find((b) => b.fde_id === 'u1').state = 'active';
  pool.bindings.find((b) => b.fde_id === 'u1').api_key = null;
  assert.equal(await getFdeLlmHeartbeatModels(pool, 'u1'), null);
});

test('getFdeLlmConfig：内部全量（含明文 key，供心跳下行/发布器）；getFdeLlmEcho：掩码回显；无配置 → null', async () => {
  const pool = seedPool();
  assert.equal(await getFdeLlmEcho(pool, 'alice'), null, '无配置 200 + null');

  await saveFdeConfig(pool, { fdeName: 'alice', provider_id: 'p1', main_model_id: 'm-main', embedding_model_id: 'm-emb' });

  const cfg = await getFdeLlmConfig(pool, 'u1');
  assert.equal(cfg.api_key, pool.generatedKeys[0], 'internal read contains the virtual key for route injection');
  assert.equal(cfg.base_url, undefined, 'binding no longer stores an upstream base URL');
  assert.deepEqual(cfg.main, { model_id: 'm-main', name: 'deepseek-flash', type: 'text' });
  assert.equal(cfg.embedding.type, 'embedding');
  assert.equal(cfg.vision, null);

  const echo = await getFdeLlmEcho(pool, 'alice');
  assert.equal(echo.api_key, maskKey(pool.generatedKeys[0]));
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
    this.activeRun = false; // F6：fdeHasActiveRun 的开关（口径同 sessions.js ACTIVE_RUN_STATES）
    this.sessions.push({
      id: 'ls-llm', user_id: ADMIN.id, token_hash: auth.hashToken(ADMIN_TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
  }

  async query(sql, params = []) {
    // F6：active run 判定（fdeHasActiveRun 的 JOIN；FakePool 不覆盖，默认无活跃 run）
    if (sql.includes('FROM runs r') && sql.includes('JOIN chat_sessions')) {
      return { rows: this.activeRun ? [{ '?column?': 1 }] : [] };
    }
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
        // N2/N3：llm.js 的活跃 run 复检经 connect() 的 client 发起（不再只走 pool.query 预检）
        if (sql.includes('FROM runs r') && sql.includes('JOIN chat_sessions')) {
          return Promise.resolve({ rows: this.activeRun ? [{ '?column?': 1 }] : [] });
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
  const server = createServer({
    pool, config, llmGateway: pool.llm,
    log: { error: () => {}, warn: () => {}, log: () => {} },
  });
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

test('HTTP：credential/model 管理、虚拟 key 绑定与掩码回显', async () => {
  const seed = {
    providers: [{ id: 'p1', name: 'deepseek', base_url: 'https://api.deepseek.com/v1', enabled: true }],
    models: [
      { id: 'm-main', provider_id: 'p1', model_id: 'deepseek-flash', name: 'DeepSeek Flash', type: 'text', tool_calling: true, enabled: true },
      { id: 'm-emb', provider_id: 'p1', model_id: 'text-embedding-3', name: 'Emb3', type: 'embedding', enabled: true },
    ],
  };
  const { base, pool, admin, close } = await startAdminServer(seed);
  try {
    // 无配置 → 200 + null
    let res = await fetch(`${base}/api/admin/fdes/alice/llm`, { headers: { cookie: admin.cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { config: null, active_run: false });

    // PUT 配置
    res = await fetch(`${base}/api/admin/fdes/alice/llm`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ provider_id: 'p1', main_model_id: 'm-main', embedding_model_id: 'm-emb' }),
    });
    assert.equal(res.status, 200);
    const putBody = await res.json();
    const virtualKey = pool.llm.generatedKeys[0];
    assert.equal(putBody.config.api_key, maskKey(virtualKey));
    assert.ok(!JSON.stringify(putBody).includes(virtualKey), 'PUT response never exposes the generated key');

    // GET 回显：掩码、无完整 key
    res = await fetch(`${base}/api/admin/fdes/alice/llm`, { headers: { cookie: admin.cookie } });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(virtualKey), 'GET response never exposes the generated key');
    const { config } = JSON.parse(text);
    assert.equal(config.api_key, maskKey(virtualKey));
    assert.equal(config.main.model_id, 'm-main');

    // 校验失败 → 400 validation_failed（embedding 位塞 text 模型）
    res = await fetch(`${base}/api/admin/fdes/alice/llm`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ provider_id: 'p1', main_model_id: 'm-emb' }),
    });
    assert.equal(res.status, 400);
    const errBody = await res.json();
    assert.equal(errBody.error.code, 'validation_failed');
    assert.ok(!JSON.stringify(errBody).includes(virtualKey), 'error response does not expose virtual key');

    // outbox + audit 断言（HTTP 路径与模块路径同一写入逻辑）
    assert.equal(pool.llm.outbox.length, 1);
    assert.equal(pool.llm.outbox[0].aggregate, 'llm_binding');
    assert.equal(pool.llm.audit.length, 1);
    assert.equal(pool.llm.audit[0].action, 'llm.config_updated');
    assert.ok(!pool.llm.audit[0].details.includes(virtualKey));

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

test('HTTP：active run blocks model allowlist changes; force permits them, upstream API keys are rejected', async () => {
  const { base, pool, admin, close } = await startAdminServer({
    providers: [
      { id: 'p1', name: 'deepseek', base_url: 'https://api.deepseek.com/v1', enabled: true },
      { id: 'p2', name: 'deepseek-secondary', base_url: 'https://api.deepseek.com', enabled: true },
    ],
    models: [
      { id: 'm-main', provider_id: 'p1', model_id: 'deepseek-flash', name: 'DeepSeek Flash', type: 'text', tool_calling: true, enabled: true },
      { id: 'm-x', provider_id: 'p2', model_id: 'deepseek-flash', name: 'DeepSeek Flash secondary', type: 'text', tool_calling: true, enabled: true },
      { id: 'm-x2', provider_id: 'p2', model_id: 'deepseek-flash', name: 'DeepSeek Flash secondary alternate', type: 'text', tool_calling: true, enabled: true },
    ],
  });
  try {
    const H = { cookie: admin.cookie, 'content-type': 'application/json' };
    const put = (body) => fetch(`${base}/api/admin/fdes/alice/llm`, { method: 'PUT', headers: H, body: JSON.stringify(body) });

    // 前置（用例③：无活跃 run 不拦）：首次配置 → 200
    let res = await put({ provider_id: 'p1', main_model_id: 'm-main' });
    assert.equal(res.status, 200, `首次配置：${JSON.stringify(await res.json())}`);
    const outboxBase = pool.llm.outbox.length;
    assert.equal(outboxBase, 1, '首次配置写 1 条 outbox');

    // ① 活跃 run + provider_id 变更 → 409 且不写 outbox
    pool.activeRun = true;
    res = await put({ provider_id: 'p2', main_model_id: 'm-x' });
    assert.equal(res.status, 409, `换 provider 应 409：${JSON.stringify(await res.json())}`);
    assert.equal(pool.llm.outbox.length, outboxBase, '409 路径不得写 outbox');

    // Upstream credentials cannot be entered in per-FDE settings.
    res = await put({ provider_id: 'p1', api_key: 'sk-test-upstream-secret', main_model_id: 'm-main' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'validation_failed');
    assert.equal(pool.llm.outbox.length, outboxBase, '409 路径不得写 outbox');

    // force=true updates the existing LiteLLM key's restricted model allowlist.
    res = await put({ provider_id: 'p2', main_model_id: 'm-x', force: true });
    assert.equal(res.status, 200, `force=true 应放行：${JSON.stringify(await res.json())}`);
    assert.equal(pool.llm.outbox.length, outboxBase + 1, 'force 放行必须写 outbox');
    assert.equal(pool.llm.outbox.at(-1).aggregate, 'llm_binding');
    assert.equal(pool.llm.outbox.at(-1).op, 'upsert');

    // Changing a model slot also changes the key allowlist and remains guarded while active.
    res = await put({ provider_id: 'p2', main_model_id: 'm-x2' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'active_run_conflict');
    assert.equal(pool.llm.outbox.length, outboxBase + 1);

    // No active run → model allowlist change succeeds normally.
    pool.activeRun = false;
    res = await put({ provider_id: 'p2', main_model_id: 'm-x2' });
    assert.equal(res.status, 200);
    assert.equal(pool.llm.outbox.length, outboxBase + 2);
  } finally {
    await close();
  }
});

test('HTTP：FDE config cannot submit upstream API keys; same binding reuses its virtual key', async () => {
  const { base, pool, admin, close } = await startAdminServer({
    providers: [{ id: 'p1', name: 'deepseek', base_url: 'https://api.deepseek.com/v1', enabled: true }],
    models: [
      { id: 'm-main', provider_id: 'p1', model_id: 'deepseek-flash', name: 'DeepSeek Flash', type: 'text', tool_calling: true, enabled: true },
    ],
  });
  try {
    const H = { cookie: admin.cookie, 'content-type': 'application/json' };
    const put = (fde, body) => fetch(`${base}/api/admin/fdes/${fde}/llm`, { method: 'PUT', headers: H, body: JSON.stringify(body) });
    let res = await put('alice', { provider_id: 'p1', main_model_id: 'm-main' });
    assert.equal(res.status, 200, `首次配置：${JSON.stringify(await res.json())}`);
    const outboxBase = pool.llm.outbox.length;
    const virtualKey = pool.llm.bindings.find((binding) => binding.fde_id === FDE_USER.id).api_key;
    pool.activeRun = true;

    res = await put('alice', { provider_id: 'p1', main_model_id: 'm-main' });
    assert.equal(res.status, 200, 'same binding remains idempotent with an active run');
    assert.equal(pool.llm.outbox.length, outboxBase);
    assert.equal(pool.llm.bindings.find((binding) => binding.fde_id === FDE_USER.id).api_key, virtualKey);

    res = await put('alice', { provider_id: 'p1', api_key: 'sk-test-upstream-key', main_model_id: 'm-main' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'validation_failed');
    assert.equal(pool.llm.outbox.length, outboxBase);

    // Null is equivalent to omitting the retired upstream-key field; it does not erase the virtual key.
    res = await put('alice', { provider_id: 'p1', api_key: null, main_model_id: 'm-main', force: true });
    assert.equal(res.status, 200);
    assert.equal(pool.llm.bindings.find((binding) => binding.fde_id === FDE_USER.id).api_key, virtualKey);
    assert.equal(pool.llm.generatedKeys.length, 1);
  } finally {
    await close();
  }
});

test('HTTP：credential PATCH changes LiteLLM upstream settings without provider activation or route outbox', async () => {
  const { base, pool, admin, close } = await startAdminServer({
    providers: [{ id: 'p1', name: 'deepseek', base_url: 'https://api.deepseek.com/v1', enabled: true }],
    models: [
      { id: 'm-main', provider_id: 'p1', model_id: 'deepseek-flash', name: 'DeepSeek Flash', type: 'text', tool_calling: true, enabled: true },
    ],
    bindings: [{
      fde_id: FDE_USER.id, gateway: 'litellm', key_alias: 'fde-alice', state: 'active',
      provider_id: 'p1', api_key: 'sk-test-virtual', main_model_id: 'm-main',
    }],
  });
  try {
    const H = { cookie: admin.cookie, 'content-type': 'application/json' };
    const patch = (body) => fetch(`${base}/api/admin/llm/providers/p1`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });

    // Credential updates go to LiteLLM regardless of FDE run state.
    let res = await patch({ base_url: 'https://proxy.internal/v2' });
    assert.equal(res.status, 200);
    const outboxBase = pool.llm.outbox.length;
    assert.equal(outboxBase, 0);

    pool.activeRun = true;
    // No enabled field exists on a LiteLLM credential.
    res = await patch({ enabled: false });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'validation_failed');
    assert.equal(pool.llm.outbox.length, outboxBase, '409 不得写 outbox');

    // base_url still delegates while an FDE has an active run.
    res = await patch({ base_url: 'https://evil-upstream.example.com' });
    assert.equal(res.status, 200);
    assert.equal(pool.llm.outbox.length, outboxBase);
    assert.equal(pool.llm.providers.find((p) => p.id === 'p1').base_url, 'https://evil-upstream.example.com');
    assert.equal(pool.llm.sqlLog.some((entry) => entry.sql.includes('fde_llm_bindings')), false);
  } finally {
    await close();
  }
});

test('HTTP：credential/model admin endpoints proxy create, update, block and delete', async () => {
  const seed = {
    providers: [{ id: 'p1', name: 'deepseek', base_url: 'https://api.deepseek.com/v1', enabled: true }],
    models: [
      { id: 'm-main', provider_id: 'p1', model_id: 'deepseek-flash', name: 'DeepSeek Flash', type: 'text', tool_calling: true, enabled: true },
    ],
  };
  const { base, pool, admin, close } = await startAdminServer(seed);
  try {
    const H = { cookie: admin.cookie, 'content-type': 'application/json' };

    // 列表
    let res = await fetch(`${base}/api/admin/llm/providers`, { headers: { cookie: admin.cookie } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).items[0].models.length, 1);

    // New credential (its key stays in LiteLLM) + model.
    res = await fetch(`${base}/api/admin/llm/providers`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'anthropic', base_url: 'https://api.anthropic.com' }) });
    assert.equal(res.status, 201);
    const p2 = (await res.json()).provider;
    res = await fetch(`${base}/api/admin/llm/providers/${p2.id}/models`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ model_id: 'deepseek-flash', model: 'deepseek/deepseek-chat', name: 'DeepSeek Flash', type: 'text', tool_calling: true, context_window: 200000 }),
    });
    assert.equal(res.status, 201);
    assert.equal(pool.llm.models.find((model) => model.provider_id === p2.id).upstream_model, 'deepseek/deepseek-chat');

    // Credential base_url update; credential enable/disable is unsupported.
    res = await fetch(`${base}/api/admin/llm/providers/${p2.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ enabled: false }) });
    assert.equal(res.status, 400);
    res = await fetch(`${base}/api/admin/llm/providers/${p2.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ base_url: 'https://proxy.example/v1' }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).provider.base_url, 'https://proxy.example/v1');

    const modelId = pool.llm.models.find((model) => model.provider_id === p2.id).id;
    res = await fetch(`${base}/api/admin/llm/models/${modelId}/block`, { method: 'POST', headers: H });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).enabled, false);
    res = await fetch(`${base}/api/admin/llm/models/${modelId}/unblock`, { method: 'POST', headers: H });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).enabled, true);

    res = await fetch(`${base}/api/admin/llm/models/${modelId}`, { method: 'DELETE', headers: H });
    assert.equal(res.status, 204);
    res = await fetch(`${base}/api/admin/llm/providers/${p2.id}`, { method: 'DELETE', headers: H });
    assert.equal(res.status, 204);
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
  const revoked = await revokeFdeLlmConfigTx(client, { fdeId: 'u1', fdeName: 'alice', gateway: pool });
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
  const again = await revokeFdeLlmConfigTx(client, { fdeId: 'u1', fdeName: 'alice', gateway: pool });
  assert.equal(again, false);
  assert.equal(pool.outbox.filter((o) => o.aggregate === 'llm_binding').length, 1);
});

test('B1：revokeFdeLlmConfigTx——无 binding 行 → false，不写 outbox（兼容无 LLM 配置的 FDE）', async () => {
  const pool = new LlmFakePool({ users: [{ id: 'u1', fde_name: 'alice', status: 'active' }] });
  const client = await pool.connect();
  assert.equal(await revokeFdeLlmConfigTx(client, { fdeId: 'u1', fdeName: 'alice', gateway: pool }), false);
  assert.equal(pool.outbox.length, 0);
});

test('B1：syncFdeLlmBindingOnOnboard——复用分支 revoked → active（revoked_at=NULL）+ outbox upsert', async () => {
  const pool = new LlmFakePool({
    users: [{ id: 'u1', fde_name: 'alice', status: 'active' }],
    providers: [{ id: 'p1', name: 'deepseek' }],
    models: [{ id: 'm1', provider_id: 'p1', model_id: 'deepseek-flash', name: 'DeepSeek Flash', type: 'text', tool_calling: true }],
    bindings: [{
      fde_id: 'u1', provider_id: 'p1', api_key: null, state: 'revoked',
      revoked_at: new Date(), main_model_id: 'm1',
    }],
  });
  const out = await syncFdeLlmBindingOnOnboard(pool, { fdeId: 'u1', fdeName: 'alice', restoreRevoked: true, gateway: pool });
  assert.deepEqual(out, { restored: true, republished: true });
  const b = pool.bindings[0];
  assert.equal(b.state, 'active');
  assert.equal(b.revoked_at, null, '复活必须清 revoked_at（同 #37 防御逻辑；注意是 fde_llm_bindings 本表，非 containers 表）');
  const ups = pool.outbox.filter((o) => o.aggregate === 'llm_binding' && o.op === 'upsert');
  assert.equal(ups.length, 1);
  assert.equal(ups[0].aggregate_id, 'u1');
  assert.ok(!JSON.stringify(ups[0].payload).includes(b.api_key), 'payload 不得含 virtual key');
});

test('B1：syncFdeLlmBindingOnOnboard——全新 onboard（restoreRevoked=false）不复活 revoked 配置', async () => {
  const pool = new LlmFakePool({
    bindings: [{
      fde_id: 'u1', provider_id: 'p1', api_key: 'sk-test-1234567890', state: 'revoked',
      revoked_at: new Date(), main_model_id: 'm1',
    }],
  });
  const out = await syncFdeLlmBindingOnOnboard(pool, { fdeId: 'u1', fdeName: 'alice', restoreRevoked: false, gateway: pool });
  assert.deepEqual(out, { restored: false, republished: false });
  assert.equal(pool.bindings[0].state, 'revoked', 'offboard 是管理员意图，全新 onboard 不得自动恢复 LLM');
  assert.equal(pool.outbox.length, 0);
});

test('B1：syncFdeLlmBindingOnOnboard——active 配置幂等 upsert（revision 递增）；无 binding 行 → no-op', async () => {
  const pool = new LlmFakePool({
    bindings: [{
      fde_id: 'u1', provider_id: 'p1', gateway: 'litellm', key_alias: 'fde-alice',
      api_key: 'sk-test-virtual-active', state: 'active',
      main_model_id: 'deepseek-flash', main_model_name: 'deepseek-flash',
    }],
  });
  const out1 = await syncFdeLlmBindingOnOnboard(pool, { fdeId: 'u1', fdeName: 'alice', restoreRevoked: false, gateway: pool });
  assert.deepEqual(out1, { restored: false, republished: true });
  const rev = pool.revisions.get('llm_binding:u1');
  const out2 = await syncFdeLlmBindingOnOnboard(pool, { fdeId: 'u1', fdeName: 'alice', restoreRevoked: false, gateway: pool });
  assert.deepEqual(out2, { restored: false, republished: true });
  assert.equal(pool.revisions.get('llm_binding:u1'), rev + 1, '每次 upsert revision 递增（head 语义，与 setFdeLlmConfig 同构）');

  const empty = new LlmFakePool({});
  assert.deepEqual(
    await syncFdeLlmBindingOnOnboard(empty, { fdeId: 'u9', fdeName: 'nobody', restoreRevoked: true, gateway: empty }),
    { restored: false, republished: false },
  );
});
