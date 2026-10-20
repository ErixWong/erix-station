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
import { runOnboardingOnce } from '../src/onboarding.js';
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
          ...(m.input_cost_per_token == null ? {} : { input_cost_per_token: m.input_cost_per_token }),
          ...(m.output_cost_per_token == null ? {} : { output_cost_per_token: m.output_cost_per_token }),
        },
        model_info: {
          id: m.id,
          type: m.type,
          mode: m.mode,
          blocked: m.enabled === false,
          tool_calling: m.tool_calling,
          context_window: m.context_window,
          display_name: m.name,
          // #309：`max_output_tokens` 是 LiteLLM `model_info` 自带的真字段。**只在非 null 时发**，
          // 才能模出「存量模型只有 litellm_params.max_tokens」的形状（读侧回退用例靠它）。
          ...(m.max_output_tokens == null ? {} : { max_output_tokens: m.max_output_tokens }),
          // LiteLLM mirrors litellm_params pricing onto model_info and lists explicitly
          // overridden fields in pricing_overrides. cost_map_* stands in for rates LiteLLM
          // resolves from its built-in cost map for a known model name.
          input_cost_per_token: m.input_cost_per_token ?? m.cost_map_input_cost_per_token ?? null,
          output_cost_per_token: m.output_cost_per_token ?? m.cost_map_output_cost_per_token ?? null,
          pricing_overrides: [
            ...(m.input_cost_per_token == null ? [] : ['input_cost_per_token']),
            ...(m.output_cost_per_token == null ? [] : ['output_cost_per_token']),
          ],
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
      max_output_tokens: body.model_info?.max_output_tokens ?? null,
      input_cost_per_token: body.litellm_params?.input_cost_per_token ?? null,
      output_cost_per_token: body.litellm_params?.output_cost_per_token ?? null,
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
    // ⚠ fake 的 NULL_CLEARABLE 行为：显式 null = 从 model_info 移除（= 清空），缺省 = 不动。
    // **那是 fake，不是真网关**：真 LiteLLM v1.103.2 对 JSON `null` 是**忽略**语义（实测 200 而值一字
    // 未动，issue #314）⇒ 这里照 fake 清是为了钉住「门户发了什么形状」（形状用例），不是钉网关行为。
    if ('max_output_tokens' in info) m.max_output_tokens = info.max_output_tokens ?? null;
    if (body.litellm_params !== undefined) {
      m.upstream_model = body.litellm_params.model;
      m.provider_id = body.litellm_params.litellm_credential_name;
      m.max_tokens = body.litellm_params.max_tokens ?? null;
      if ('input_cost_per_token' in body.litellm_params) {
        m.input_cost_per_token = body.litellm_params.input_cost_per_token ?? null;
      }
      if ('output_cost_per_token' in body.litellm_params) {
        m.output_cost_per_token = body.litellm_params.output_cost_per_token ?? null;
      }
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
      if (s.startsWith('SELECT round, dedup_key, record')) return { rows: [] }; // appendUserTurn 的回退路径 load(key)
      // 0.17.0 成对快路径探针（#193）：空 transcript → 未命中 + max_round null（round 仍为 0）。
      if (s.startsWith('SELECT record FROM transcript_rounds')) return { rows: [] };
      if (s.startsWith('SELECT MAX(round)')) return { rows: [{ max_round: null }] };
      if (s.startsWith('INSERT INTO transcript_rounds')) return { rows: [] };
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

// --- issue #309 切片 1：`max_output_tokens`（1/4 硬上限 + 绑死双写 + 读侧回退） ----------------
// 背景：引擎侧算预算用这个值（`budgetTokens = ctx − maxOutput − max(2000, ⌈10%·ctx⌉)`），
// 填得不合公式会让**每个 run 第 1 轮之前就死**：`computeBudget` 抱 `invalid_budget`（实测文案
// "Computed context budget must be positive (got -71)"，`erix-agent/src/compact/budget.js:23-25`，
// 调用点 `orchestrator.js:1141-1148` 无 try/catch）。
// 上限 = floor(context_window / 4)：**产品约束**（比引擎临界更严，会拒掉引擎其实跑得动的值）；
// 真正致命面（预算非正）由 runner 侧上游闸兜 —— 定性见 portal/src/llm.js 的 validateMaxOutputTokens 注释。

/** 超限拒的公共断言：零新错误码（§8.20）⇒ 一律 validation_failed，细分看 details。 */
function assertOverLimit(error, expected) {
  assert.equal(error.code, 'validation_failed');
  assert.deepEqual(error.details, expected);
  return true;
}

test('#309 max_output_tokens：硬上限就是 floor(context_window/4) —— 边界值放行、+1 被拒', async () => {
  // ⚠ #318 上线后写侧多了「窗口 ≥ 65536」硬下限 ⇒ 本用例的窗口值全部改成坐在下限之上的数。
  // 窗口在这里只是分母：1/4 边界本身（边界放行 / +1 拒 / `Math.floor` 口径）**一条都没放宽**。
  const cases = [
    { context_window: 262144, allowed: 65536 },
    { context_window: 200000, allowed: 50000 },
    { context_window: 65538, allowed: 16384 }, // 钉住 Math.floor（16384.5 ⇒ 16384）：不是四舍五入、不是浮点 /4
  ];
  for (const { context_window, allowed } of cases) {
    const pool = new LlmFakePool();
    await createModel(pool, {
      provider_id: 'p1', model_id: 'm-a', model: 'openai/m-a', type: 'text',
      context_window, max_output_tokens: allowed,
    });
    const body = pool.gatewayCalls.find((entry) => entry.method === 'createModel').body;
    assert.equal(body.model_info.max_output_tokens, allowed, `ctx=${context_window}：上限 ${allowed} 必须放行`);
    assert.equal(body.litellm_params.max_tokens, allowed);

    const rejected = new LlmFakePool();
    const error = await createModel(rejected, {
      provider_id: 'p1', model_id: 'm-a', model: 'openai/m-a', type: 'text',
      context_window, max_output_tokens: allowed + 1,
    }).then(() => null, (caught) => caught);
    assert.ok(error, `ctx=${context_window}：${allowed + 1} 必须被拒`);
    assertOverLimit(error, { field: 'max_output_tokens', max_allowed: allowed, context_window });
    // message 要能当人读：点名「上限 = context_window 的 1/4」与两个数字（前端不做本地校验，
    // 直接透传 error.message ⇒ 这句话就是用户看到的全部）。
    assert.match(error.message, /1\/4/);
    assert.match(error.message, new RegExp(String(allowed)));
    assert.match(error.message, new RegExp(String(allowed + 1)));
    assert.equal(rejected.gatewayCalls.some((entry) => entry.method === 'createModel'), false,
      '被校验拦下时不得打到网关');
  }
});

test('#309 max_output_tokens：非正整数一律拒（details 只点名字段）', async () => {
  for (const value of [0, -1, 1.5, '2000', true, Number.NaN, Number.POSITIVE_INFINITY]) {
    const pool = new LlmFakePool();
    await assert.rejects(
      () => createModel(pool, {
        provider_id: 'p1', model_id: 'm-a', model: 'openai/m-a', context_window: 262144, max_output_tokens: value,
      }),
      (error) => assertOverLimit(error, { field: 'max_output_tokens' }),
      `max_output_tokens=${String(value)} 必须被拒`,
    );
    assert.equal(pool.gatewayCalls.length, 0);
  }
});

test('#309 max_output_tokens：没有 context_window 就判不了 1/4 ⇒ 拒（context_window_missing），不写半套', async () => {
  const missing = { field: 'max_output_tokens', reason: 'context_window_missing' };

  const created = new LlmFakePool();
  await assert.rejects(
    () => createModel(created, { provider_id: 'p1', model_id: 'm-a', model: 'openai/m-a', max_output_tokens: 2000 }),
    (error) => assertOverLimit(error, missing),
  );
  assert.equal(created.gatewayCalls.some((entry) => entry.method === 'createModel'), false,
    '新建被拒时不得打到网关');

  // 存量模型真的没窗口（model_info.context_window 为 null）同样拒；且**不产生任何网关写**。
  const pool = new LlmFakePool({
    models: [{ id: 'm1', provider_id: 'p1', model_id: 'gpt-4o', type: 'text', context_window: null }],
  });
  await assert.rejects(() => updateModel(pool, 'm1', { max_output_tokens: 2000 }),
    (error) => assertOverLimit(error, missing));
  assert.equal(pool.gatewayCalls.some((entry) => entry.method === 'updateModel'), false,
    '缺窗口时不得只把 max_tokens 写进数据面（那正是「半套」）');

  // 同一条 PATCH 里补上窗口则可放行（新值优先，不拿旧值判；窗口取 ≥ #318 下限 65536 的数）。
  const both = new LlmFakePool({
    models: [{ id: 'm1', provider_id: 'p1', model_id: 'gpt-4o', type: 'text', context_window: null }],
  });
  await updateModel(both, 'm1', { context_window: 262144, max_output_tokens: 2000 });
  assert.equal(both.gatewayCalls.find((entry) => entry.method === 'updateModel').body.model_info.max_output_tokens, 2000);
});

test('#309 max_output_tokens：1/4 用「有效窗口」——本次提交的新值优先，否则退到现存值', async () => {
  // 存量窗口 8000（上限 2000）：同一条 PATCH 把窗口抬到 200000 并配 50000 ⇒ 必须放行。
  const grow = new LlmFakePool({
    models: [{ id: 'm1', provider_id: 'p1', model_id: 'gpt-4o', type: 'text', context_window: 8000 }],
  });
  await updateModel(grow, 'm1', { context_window: 200000, max_output_tokens: 50000 });
  const body = grow.gatewayCalls.find((entry) => entry.method === 'updateModel').body;
  assert.equal(body.model_info.context_window, 200000);
  assert.equal(body.model_info.max_output_tokens, 50000);
  assert.equal(body.litellm_params.max_tokens, 50000);

  // 反向：存量 200000，同一条 PATCH 把窗口压到 66000（仍在 #318 的 65536 下限之上）却仍带 50000
  // ⇒ 按**新**窗口拒（本用例钉的是「新值优先」这个优先级，不是某个具体的窗口数）。
  const shrink = new LlmFakePool({
    models: [{ id: 'm1', provider_id: 'p1', model_id: 'gpt-4o', type: 'text', context_window: 200000 }],
  });
  await assert.rejects(() => updateModel(shrink, 'm1', { context_window: 66000, max_output_tokens: 50000 }),
    (error) => assertOverLimit(error, { field: 'max_output_tokens', max_allowed: 16500, context_window: 66000 }));
  assert.equal(shrink.gatewayCalls.some((entry) => entry.method === 'updateModel'), false);

  // 不提交窗口 ⇒ 退到该模型现存的 model_info.context_window。存量 8000 低于 #318 的下限，但那条下限
  // 只管**本次提交的**窗口（带外/存量配错的模型仍得改预算），所以这里报的仍是 1/4 超限而不是 too_small。
  const stored = new LlmFakePool({
    models: [{ id: 'm1', provider_id: 'p1', model_id: 'gpt-4o', type: 'text', context_window: 8000 }],
  });
  await assert.rejects(() => updateModel(stored, 'm1', { max_output_tokens: 2001 }),
    (error) => assertOverLimit(error, { field: 'max_output_tokens', max_allowed: 2000, context_window: 8000 }));
});

test('#309 回归锚：不传 / 传 null ⇒ 写入体与改前一致（model_info 无该键、litellm_params 无 max_tokens）', async () => {
  for (const value of [undefined, null]) {
    const pool = new LlmFakePool();
    await createModel(pool, {
      provider_id: 'p1', model_id: 'gpt-4o', model: 'openai/gpt-4o', type: 'text', context_window: 128000,
      ...(value === undefined ? {} : { max_output_tokens: null }),
    });
    const body = pool.gatewayCalls.find((entry) => entry.method === 'createModel').body;
    assert.equal(Object.hasOwn(body.model_info, 'max_output_tokens'), false,
      `max_output_tokens=${String(value)} 时 model_info 不得多出该键`);
    assert.equal(Object.hasOwn(body.litellm_params, 'max_tokens'), false,
      `max_output_tokens=${String(value)} 时 litellm_params 不得多出 max_tokens`);
  }

  // PATCH 只改展示名：既不带 max_output_tokens 也不带 max_tokens，也不得多出空 litellm_params。
  const pool = new LlmFakePool({
    models: [{ id: 'm1', provider_id: 'p1', model_id: 'gpt-4o', type: 'text', context_window: 128000 }],
  });
  await updateModel(pool, 'm1', { name: '只改展示名' });
  const body = pool.gatewayCalls.find((entry) => entry.method === 'updateModel').body;
  assert.equal(Object.hasOwn(body.model_info, 'max_output_tokens'), false);
  assert.equal(body.litellm_params, undefined, '没碰数据面参数就别带 litellm_params');
});

test('#309 双写（**发给网关的请求形状**）：新建传了 ⇒ 两处同值；PATCH 改 ⇒ 两处一起改；传 null ⇒ 请求体里两处都是「清除」形状', async () => {
  // ⚠ 用例名里的「形状」是 #317 加的限定词：本用例钉的是**门户往网关发什么**（fake 会按 NULL_CLEARABLE
  // 真清），而真 LiteLLM v1.103.2 对 JSON `null` 是**忽略**语义（实测 200 但值一字未动，#314）
  // ⇒ 断言一条都不许改松，也不要把它当「真网关能清空」的证据。
  const created = new LlmFakePool();
  await createModel(created, {
    provider_id: 'p1', model_id: 'gpt-4o', model: 'openai/gpt-4o', type: 'text',
    context_window: 128000, max_output_tokens: 16384,
  });
  const createBody = created.gatewayCalls.find((entry) => entry.method === 'createModel').body;
  assert.equal(createBody.model_info.max_output_tokens, 16384, '权威位：model_info.max_output_tokens');
  assert.equal(createBody.litellm_params.max_tokens, 16384,
    '绑死同值：引擎真正送到 provider 的是 litellm_params.max_tokens，只写 model_info 就是第二套真相源');
  const createdItem = (await listModels(created)).items[0];
  assert.equal(createdItem.max_output_tokens, 16384);
  assert.equal(createdItem.max_tokens, 16384);

  // PATCH 改值：两处一起改。（128000 / 4 = 32000 ⇒ 24576 是合法值，别拿一个越界的数当「改值」。）
  await updateModel(created, 'm1', { max_output_tokens: 24576 });
  const patchBody = created.gatewayCalls.filter((entry) => entry.method === 'updateModel').at(-1).body;
  assert.equal(patchBody.model_info.max_output_tokens, 24576);
  assert.equal(patchBody.litellm_params.max_tokens, 24576, '同一次 PATCH 里数据面必须跟到新值');
  const patched = (await listModels(created)).items[0];
  assert.equal(patched.max_output_tokens, 24576);
  assert.equal(patched.max_tokens, 24576);

  // 传 null：两处一起消失（不留「model_info 没了、max_tokens 还挂着旧值」的半套）。
  await updateModel(created, 'm1', { max_output_tokens: null });
  const clearBody = created.gatewayCalls.filter((entry) => entry.method === 'updateModel').at(-1).body;
  assert.equal(clearBody.model_info.max_output_tokens, null, '形状：显式 null 才是门户的清空请求（缺省是「不动」）；真网关 v1.103.2 会忽略它（#314）');
  assert.equal(Object.hasOwn(clearBody.litellm_params, 'max_tokens'), false, '数据面一侧直接不带该键');
  const cleared = (await listModels(created)).items[0];
  // ⚠ 切片 1.5 行为变化（有意）：清空后读侧不再是 null 而是回退值 floor(128000/4)=32000。
  // 这条断言同时**反证两处真的都清了**：只要 model_info.max_output_tokens 或 litellm_params.max_tokens
  // 还剩一个（旧值 24576），`??` 链就会让它赢，这里就不可能是 32000。
  assert.equal(cleared.max_output_tokens, 32000, '两处清空 ⇒ 读侧退到 floor(ctx/4)（而不是退到旧值）');
  assert.equal(cleared.max_tokens, null, '两处真的都消失了，而不是只清了权威位（legacy 读侧一字未改）');
});

test('#309 双写优先级：同一次请求同时传 legacy max_tokens 与 max_output_tokens ⇒ 以绑定字段为准', async () => {
  const pool = new LlmFakePool();
  await createModel(pool, {
    provider_id: 'p1', model_id: 'gpt-4o', model: 'openai/gpt-4o', type: 'text',
    context_window: 128000, max_tokens: 1024, max_output_tokens: 8192,
  });
  const body = pool.gatewayCalls.find((entry) => entry.method === 'createModel').body;
  assert.equal(body.litellm_params.max_tokens, 8192, '绑死字段后写 ⇒ 数据面不会出现「两个入口各执一词」的中间态');
  assert.equal(body.model_info.max_output_tokens, 8192);
});

test('#309 回退与 legacy：model_info 优先、没有则退 litellm_params.max_tokens、都没有则 null', async () => {
  const pool = new LlmFakePool({
    models: [
      // 两处都有且不同值 ⇒ 读 model_info（权威位）
      { id: 'm-auth', provider_id: 'p1', model_id: 'a', type: 'text', context_window: 128000, max_output_tokens: 3000, max_tokens: 1000 },
      // 只有 litellm_params.max_tokens 的存量模型（写入侧上线前配好的）
      { id: 'm-legacy', provider_id: 'p1', model_id: 'b', type: 'text', context_window: 128000, max_tokens: 4096 },
      // 什么都没有
      { id: 'm-none', provider_id: 'p1', model_id: 'c', type: 'text' },
    ],
  });
  const byId = Object.fromEntries((await listModels(pool)).items.map((m) => [m.id, m]));
  assert.equal(byId['m-auth'].max_output_tokens, 3000, 'model_info.max_output_tokens 是权威位');
  assert.equal(byId['m-legacy'].max_output_tokens, 4096, '存量模型只有 litellm_params.max_tokens ⇒ 回退必须取到（否则显示成「没配」）');
  assert.equal(byId['m-none'].max_output_tokens, null);
  // legacy `max_tokens` 自己的读侧一字未改（兼容面）
  assert.equal(byId['m-auth'].max_tokens, 1000);
  assert.equal(byId['m-legacy'].max_tokens, 4096);
  assert.equal(byId['m-none'].max_tokens, null);
});

// --- issue #309 切片 1.5：读侧回退值 = `floor(context_window / 4)` ------------------------------
// 定稿的四级链（决策者 2026-10-19）：
//   生效值 = model_info.max_output_tokens          -- 上游配了什么就是什么
//        ?? litellm_params.max_tokens            -- 同上（今天真正被网关注进请求体的那个）
//        ?? floor(正数 context_window / 4)         -- 都没配 ⇒ 按窗口 1/4 假定
//        ?? null                                  -- 连 context_window 都没有 ⇒ 真的没有
// 意义：**缺元数据不再等于关压缩**（引擎要 ctx 与 maxOutputTokens 同时存在才推得出 budgetTokens）。
// 决策者否决了「区分配置值 vs 假定值」的字段拆分 ⇒ 断言只能看到一列 `max_output_tokens`。

/** 一批只给窗口、不给预算的存量形状。 */
function onlyWindowPool(contextWindows) {
  return new LlmFakePool({
    models: contextWindows.map(({ id, context_window }) => ({
      id, provider_id: 'p1', model_id: `m-${id}`, type: 'text', context_window,
    })),
  });
}

async function itemsById(pool) {
  return Object.fromEntries((await listModels(pool)).items.map((m) => [m.id, m]));
}

test('#309 切片1.5 回退四级链逐支钉：只 model_info / 只 max_tokens / 都没有但 ctx 有 / 连 ctx 也没有', async () => {
  const pool = new LlmFakePool({
    models: [
      // 第 1 级：model_info 配了（哪怕同时也有 legacy max_tokens）—— 上游配了什么就是什么
      { id: 'l1', provider_id: 'p1', model_id: 'a', type: 'text', context_window: 200000, max_output_tokens: 3000, max_tokens: 1000 },
      // 第 2 级：只有 litellm_params.max_tokens（写入侧上线前配好的存量模型）
      { id: 'l2', provider_id: 'p1', model_id: 'b', type: 'text', context_window: 200000, max_tokens: 4096 },
      // 第 3 级：都没配、但 ctx 可得 ⇒ 按 1/4 假定（200000/4 = 50000）
      { id: 'l3', provider_id: 'p1', model_id: 'c', type: 'text', context_window: 200000 },
      // 第 4 级：连 ctx 都没有 ⇒ 真的是 null（不是 0、不是 NaN）
      { id: 'l4', provider_id: 'p1', model_id: 'd', type: 'text' },
    ],
  });
  const byId = await itemsById(pool);
  assert.equal(byId.l1.max_output_tokens, 3000, '第 1 级：model_info.max_output_tokens 是权威位，配了就不算');
  assert.equal(byId.l2.max_output_tokens, 4096, '第 2 级：回退到 litellm_params.max_tokens（网关今天真用的那个）');
  assert.equal(byId.l3.max_output_tokens, 50000, '第 3 级：都没配 ⇒ floor(ctx/4)，而不是 null');
  assert.equal(byId.l4.max_output_tokens, null, '第 4 级：连 ctx 都没配才是真的没有');
  // 形状约束：没有新增「它是怎么来的」这类字段（决策者明确否决），也只有这一个拼写。
  assert.equal(Object.hasOwn(byId.l3, 'effective_max_output_tokens'), false, '不加 effective_ 前缀的旁证字段');
  assert.equal(Object.hasOwn(byId.l3, 'max_output_tokens_source'), false, '不加来源字段：就一列数字');
});

test('#309 切片1.5 回退值是 floor(ctx/4)：边界与取整口径钉死（262144/512000/非 4 的倍数/数字串）', async () => {
  const cases = [
    { ctx: 262144, expected: 65536 },
    { ctx: 512000, expected: 128000 },
    { ctx: 99999, expected: 24999 },  // 不是 4 的倍数 ⇒ floor，不是四舍五入（25000 就红）
    { ctx: 999, expected: 249 },
    { ctx: 7, expected: 1 },           // 商不是整数时也至少留个正整数（7/4=1.75 ⇒ 1），不会下发 0
    { ctx: '128000', expected: 32000 }, // 历史上存成数字串的窗口：与手填校验同一口径，照样能算
  ];
  const pool = onlyWindowPool(cases.map((c, i) => ({ id: `c${i}`, context_window: c.ctx })));
  const byId = await itemsById(pool);
  cases.forEach((c, i) => {
    assert.equal(byId[`c${i}`].max_output_tokens, c.expected,
      `ctx=${String(c.ctx)} ⇒ 回退值必须是 floor(ctx/4)=${c.expected}`);
    assert.ok(Number.isInteger(byId[`c${i}`].max_output_tokens) && byId[`c${i}`].max_output_tokens >= 1,
      `ctx=${String(c.ctx)}：下发的是正整数，不是小数/0/NaN`);
  });
});

test('#309 切片1.5 窗口不可得 ⇒ 不算回退（0 / 负数 / 非数字串 / 空串 / NaN ⇒ null，绝不是 0 或 NaN）', async () => {
  const unusable = [0, -8000, 'abc', '', Number.NaN, -0.5];
  const pool = onlyWindowPool(unusable.map((ctx, i) => ({ id: `u${i}`, context_window: ctx })));
  // 对照组：没这个键与显式 null 同样算不可得
  const baseline = new LlmFakePool({ models: [
    { id: 'missing', provider_id: 'p1', model_id: 'missing', type: 'text' },
    { id: 'explicit-null', provider_id: 'p1', model_id: 'explicit-null', type: 'text', context_window: null },
  ] });
  const byId = { ...await itemsById(pool), ...await itemsById(baseline) };
  [...unusable.map((_, i) => `u${i}`), 'missing', 'explicit-null'].forEach((id) => {
    const value = byId[id].max_output_tokens;
    assert.equal(value, null, `${id}：窗口不可得 ⇒ 生效值 null（不硬算出 0/NaN 下发）`);
    assert.ok(!Number.isNaN(value), `${id}：不得把 NaN 下发给 runner`);
  });
  // 窗口本身照原样显示（读侧口径没改），只有预算算不出来
  assert.equal(byId.u0.context_window, 0, 'context_window=0 照原样显示，不被回退逻辑改写');
});

test('#309 切片1.5 一致性：回退算出的值再提交也合法（1/4 既是上限也是回退，平台不自打）', async () => {
  for (const context_window of [262144, 512000, 99999, 8000]) {
    const pool = onlyWindowPool([{ id: 'x1', context_window }]);
    const fallback = (await itemsById(pool)).x1.max_output_tokens;
    assert.equal(fallback, Math.floor(context_window / 4));

    // 把回退值当手填值提交回去：必须放行，且两处同值落库
    await updateModel(pool, 'x1', { max_output_tokens: fallback });
    const body = pool.gatewayCalls.find((entry) => entry.method === 'updateModel').body;
    assert.equal(body.model_info.max_output_tokens, fallback, `ctx=${context_window}：回退值自己必须过得了自己的校验`);
    assert.equal(body.litellm_params.max_tokens, fallback);

    // 上限仍然只高一就不放：回退**没有**把校验抹掉
    const over = new LlmFakePool({ models: [{ id: 'x1', provider_id: 'p1', model_id: 'x', type: 'text', context_window }] });
    await assert.rejects(() => updateModel(over, 'x1', { max_output_tokens: fallback + 1 }),
      (error) => {
        assert.equal(error.code, 'validation_failed');
        assert.deepEqual(error.details, { field: 'max_output_tokens', max_allowed: fallback, context_window });
        return true;
      }, `ctx=${context_window}：上限仍是 floor(ctx/4)=${fallback}`);
  }
});

test('#309 切片1.5 回退不动 legacy 语义：max_tokens 的读侧与写入体一个字节都没改', async () => {
  const pool = new LlmFakePool({ models: [
    { id: 'k1', provider_id: 'p1', model_id: 'a', type: 'text', context_window: 128000, max_tokens: 1024 },
    { id: 'k2', provider_id: 'p1', model_id: 'b', type: 'text', max_tokens: 512 },
  ] });
  const byId = await itemsById(pool);
  assert.equal(byId.k1.max_tokens, 1024, 'legacy 读侧只看 litellm_params.max_tokens，不会被回退污染');
  assert.equal(byId.k2.max_tokens, 512, '没窗口的模型 legacy 值照旧可读（只有 max_output_tokens 变）');
  assert.equal(byId.k2.max_output_tokens, 512);

  await updateModel(pool, 'k1', { max_tokens: 2048 });
  const body = pool.gatewayCalls.find((entry) => entry.method === 'updateModel').body;
  assert.equal(body.litellm_params.max_tokens, 2048);
  assert.equal(body.model_info, undefined,
    '只改 legacy max_tokens 不得捎带写权威位（没传 max_output_tokens 就是不动，连 model_info 块都不带）');
  const after = (await itemsById(pool)).k1;
  assert.equal(after.max_tokens, 2048, 'legacy 字段照旧只读自己那一位');
  assert.equal(after.max_output_tokens, 2048, '生效值退到刚写的 max_tokens（第 2 级），而不是退到 ctx/4');
});

// --- issue #316：token 数的「正整数」口径归一（与 runner 同一条规则，镜像 fixture） --------------
// 规则（工单 feat-261019-06 定稿，两侧各执行一次）：数字串与整值浮点**归一成正整数**；
// 真小数 / ≤0 / NaN / Infinity / 非数字串一律**判不可得**（不 floor、不兜 0）。
// ⚠ `TOKEN_FIXTURES` 在对面有一份**逐行镜像**：`runner/test/llm-models.test.js`（那边断言解析与下行
// 形状，这边断言显示与回退值）。判据本身：`portal/src/llm.js` 的 `positiveIntOrNull()`
// ↔ `runner/lib/llm-models.js` 的 `positiveIntOrNull()`。改一侧必须改对面。

/** #316 两侧镜像的 fixture 表（与 runner 同名同内容）：`accepted` = 归一后的正整数，`null` = 不可得。 */
const TOKEN_FIXTURES = [
  { value: 262144, accepted: 262144, why: '正整数：原样' },
  { value: '262144', accepted: 262144, why: '#316 病症本体：数字串归一（历史存量，门户一直容忍而 runner 不认）' },
  { value: ' 262144 ', accepted: 262144, why: '带空白的数字串：trim 后同一条规则' },
  { value: '262144.0', accepted: 262144, why: '整值浮点的字符串形态：值就是 262144' },
  { value: 262144.0, accepted: 262144, why: '整值浮点（JS 里 262144.0 === 262144）：原样' },
  { value: 1000, accepted: 1000, why: '小但合法的正整数（能不能算出预算是 runner 那道闸的活）' },
  { value: '1e3', accepted: 1000, why: '科学计数法数字串：值是整数 1000 ⇒ 归一（沿用旧 `Number()` 口径）' },
  { value: 262144.5, accepted: null, why: '真小数 = 配错：判不可得，**不 floor**（floor 是替管理员编数）' },
  { value: '262144.5', accepted: null, why: '真小数字符串形态同样不可得' },
  { value: 0, accepted: null, why: '0 不可得（绝不能下发 0）' },
  { value: -5, accepted: null, why: '负数不可得' },
  { value: 'abc', accepted: null, why: '非数字串不可得' },
  { value: '', accepted: null, why: '空串不可得' },
  { value: '   ', accepted: null, why: '空白串不可得（trim 后空）' },
  { value: null, accepted: null, why: '显式 null = 没配' },
  { value: undefined, accepted: null, why: '缺键' },
  { value: Number.NaN, accepted: null, why: 'NaN' },
  { value: Number.POSITIVE_INFINITY, accepted: null, why: 'Infinity：不是安全整数 ⇒ 不可得（旧口径会当正数算出 NaN）' },
  { value: true, accepted: null, why: '布尔' },
  { value: false, accepted: null, why: '布尔' },
  { value: {}, accepted: null, why: '对象' },
  { value: [], accepted: null, why: '数组' },
];

test('#316 读侧表驱动：窗口形态归一后才算回退值（镜像面在 runner/test/llm-models.test.js）', async () => {
  const pool = onlyWindowPool(TOKEN_FIXTURES.map((f, i) => ({ id: `t${i}`, context_window: f.value })));
  const byId = await itemsById(pool);
  TOKEN_FIXTURES.forEach((f, i) => {
    const item = byId[`t${i}`];
    const label = `ctx=${JSON.stringify(f.value)}`;
    // 显示面：`context_window` 照原样回读（切片 1 的既有口径，本单**不改显示**，只改算不算得出预算）。
    assert.deepEqual(item.context_window ?? null, f.value ?? null, `${label}：显示不被回退逻辑改写`);
    if (f.accepted === null) {
      assert.equal(item.max_output_tokens, null,
        `${label}：窗口判不可得 ⇒ 生效值 null（不 floor、不兜 0、不下发 NaN）：${f.why}`);
      assert.ok(!Number.isNaN(item.max_output_tokens), `${label}：绝不能把 NaN 下发给 runner`);
    } else {
      const expected = Math.floor(f.accepted / 4);
      assert.equal(item.max_output_tokens, expected,
        `${label}：先归一成 ${f.accepted} 再算 floor(/4)=${expected}：${f.why}`);
      assert.ok(Number.isInteger(item.max_output_tokens) && item.max_output_tokens >= 1,
        `${label}：下发的是正整数：${f.why}`);
    }
  });
  // 本单真正的行为变化（只有真小数那一支）：旧口径把 262144.5 当正数算出 65536 并下发，
  // 而 runner 整键丢掉 ⇒ 「门户显示 65536、压缩静默关」（#316）。今天两侧同一句：算不出就是 null。
  const decimal = TOKEN_FIXTURES.findIndex((f) => f.value === 262144.5);
  assert.equal(byId[`t${decimal}`].max_output_tokens, null,
    '#316 病症那一格：真小数窗口不再算出 floor(262144.5/4)=65536 ⇒ 与 runner 的「丢键」结论对齐');
});

test('#316 写侧校验一字未动（#325 归一除外）：数字串窗口与整值浮点窗口照旧能算 1/4 上限；真小数拒', async () => {
  // 上限本身（≤ floor(ctx/4)）、双写、validation_failed 三者一个字节都没改；只是读「窗口」用的
  // 是那条唯一判据 ⇒ 真小数窗口不再能定上限（与读侧/runner 同一口径），而不是把上限改宽或改紧。
  for (const context_window of ['262144', 262144.0, '262144.0']) {
    const ok = new LlmFakePool();
    await createModel(ok, {
      provider_id: 'p1', model_id: 'm-a', model: 'openai/m-a', context_window, max_output_tokens: 65536,
    });
    const body = ok.gatewayCalls.find((entry) => entry.method === 'createModel').body;
    assert.equal(body.model_info.max_output_tokens, 65536, `ctx=${JSON.stringify(context_window)}：归一后上限 65536 放行`);
    assert.equal(body.litellm_params.max_tokens, 65536, '双写照旧（同值两处）');
    // #325 只加不减：数字串/整值浮点形态**不得落库**，网关收到的必须是归一后的 number。
    assert.equal(body.model_info.context_window, 262144, `ctx=${JSON.stringify(context_window)}：落库是 number 262144`);
    assert.equal(typeof body.model_info.context_window, 'number', '字符串形态不得原样存进目录（#325 的病根）');
    assert.equal(body.model_info.metadata.context_window, 262144, 'metadata 镜像位也必须是归一后的 number');

    const over = new LlmFakePool();
    await assert.rejects(
      () => createModel(over, {
        provider_id: 'p1', model_id: 'm-a', model: 'openai/m-a', context_window, max_output_tokens: 65537,
      }),
      (error) => assertOverLimit(error, { field: 'max_output_tokens', max_allowed: 65536, context_window: 262144 }),
      `ctx=${JSON.stringify(context_window)}：+1 仍被拒（上限没被改宽）`,
    );
    assert.equal(over.gatewayCalls.length, 0, '被拦下时不得打到网关');
  }

  // 真小数窗口：写侧也拒。⚠ **#318 只改了它报哪个 `reason`**：以前要拿窗口去算 1/4 才发现它不可得
  // ⇒ `max_output_tokens / context_window_missing`；现在窗口自身的形态判据**排在 1/4 之前**（#318 D2）
  // ⇒ 直接报 `context_window / not_positive_integer`，点名真正的病因。**不是放宽**：同样拒、同样零网关写，
  // 而且今天连「不带预算只带坏窗口」也拒（以前那条能静默落库）。
  const decimal = new LlmFakePool();
  await assert.rejects(
    () => createModel(decimal, { provider_id: 'p1', model_id: 'm-a', model: 'openai/m-a', context_window: 262144.5, max_output_tokens: 2000 }),
    (error) => assertOverLimit(error, { field: 'context_window', reason: 'not_positive_integer', min: 65536, value: 262144.5 }),
    '真小数窗口在写侧就是非法形态（旧口径会拿它算出 65536 当上限并放行）',
  );
  assert.equal(decimal.gatewayCalls.some((entry) => entry.method === 'createModel'), false);
  // 不带动预算也拒（#325 补上的那一格：以前静默落库）。
  const shapeOnly = new LlmFakePool();
  await assert.rejects(
    () => createModel(shapeOnly, { provider_id: 'p1', model_id: 'm-a', model: 'openai/m-a', context_window: 262144.5 }),
    (error) => assertOverLimit(error, { field: 'context_window', reason: 'not_positive_integer', min: 65536, value: 262144.5 }),
  );
  assert.equal(shapeOnly.gatewayCalls.length, 0, '零请求：校验不过不得打网关');
});

test('#316 一致性仍然成立：真小数归一后的回退值再提交回去也合法（1/4 既是上限也是回退）', async () => {
  for (const context_window of ['262144', 262144.0, 512000]) {
    const pool = onlyWindowPool([{ id: 'x1', context_window }]);
    const fallback = (await itemsById(pool)).x1.max_output_tokens;
    await updateModel(pool, 'x1', { max_output_tokens: fallback });
    const body = pool.gatewayCalls.find((entry) => entry.method === 'updateModel').body;
    assert.equal(body.model_info.max_output_tokens, fallback, `ctx=${JSON.stringify(context_window)}：回退值过得了自己的校验`);
    assert.equal(body.litellm_params.max_tokens, fallback);
  }
});

// --- issue #318 + #325：门户写侧的「窗口硬下限 65536」与「token 数形态归一」 -------------------------
// 病症（#318）：管理员把窗口手滑配成 2048、输出上限留空 ⇒ 门户**保存成功、零提示**，而引擎算不出
// 正的压缩预算 ⇒ runner 那道上游闸把整对元数据不发给引擎 ⇒ **压缩静默关**（界面上看不见）。
// 病症（#325）：写侧以前**原样透传**——带外 `PATCH {"context_window":"262144"}` 真网关就存成字符串
// `'262144'`（2026-10-20 dev 实测），脏形态会永久留在目录里。读侧/心跳早已归一（#316），runner 不受影响。
// 两条都在 `validateContextWindow()` 一处完成：形态（唯一判据 `positiveIntOrNull()`）+ 下限 65536。

/** #318/#325 的拒法：零新错误码 ⇒ `validation_failed` + details 逐字段钉死。 */
function assertWindowRejected(error, expected) {
  assert.equal(error.code, 'validation_failed', '零新错误码（§8.20）：细分只能靠 details.reason');
  assert.deepEqual(error.details, expected, 'details 形状逐字段');
  return true;
}

test('#318 窗口硬下限：65536 放行、65535 与 2048 拒（POST/PATCH 都是），details 与文案逐字段钉死', async () => {
  // 下边界本身：65536 必须**放行**（不是「> 65536」）。
  const edge = new LlmFakePool();
  await createModel(edge, {
    provider_id: 'p1', model_id: 'm-edge', model: 'openai/m-edge', context_window: 65536, max_output_tokens: 16384,
  });
  const edgeBody = edge.gatewayCalls.find((e) => e.method === 'createModel').body;
  assert.equal(edgeBody.model_info.context_window, 65536, '65536 本身必须放行');

  const patched = new LlmFakePool({
    models: [{ id: 'm1', provider_id: 'p1', model_id: 'a', type: 'text', context_window: 262144 }],
  });
  await updateModel(patched, 'm1', { context_window: 65536 });
  assert.equal(patched.gatewayCalls.find((e) => e.method === 'updateModel').body.model_info.context_window, 65536,
    'PATCH 把窗口改到恰好下边界也必须放行');

  // 差一（65535）与典型手滑值（2048）：两个入口都拒，且 details 逐字段对。
  for (const value of [65535, 2048]) {
    const details = { field: 'context_window', reason: 'too_small', min: 65536, value };

    const post = new LlmFakePool();
    await assert.rejects(
      () => createModel(post, { provider_id: 'p1', model_id: 'm-a', model: 'openai/m-a', context_window: value }),
      (error) => assertWindowRejected(error, details),
      `POST context_window=${value} 必须被拒`,
    );
    assert.equal(post.gatewayCalls.length, 0, 'POST 被拦下时不得打网关（连读请求都不发）');

    // 正是 #318 的病症形状：窗口配小、输出上限**留空** ⇒ 以前保存成功、零提示。
    const patch = new LlmFakePool({
      models: [{ id: 'm1', provider_id: 'p1', model_id: 'a', type: 'text', context_window: 262144 }],
    });
    await assert.rejects(() => updateModel(patch, 'm1', { context_window: value }),
      (error) => assertWindowRejected(error, details), `PATCH context_window=${value} 必须被拒`);
    assert.equal(patch.gatewayCalls.length, 0, 'PATCH 被拦下时网关零请求（含 findGatewayModel 那次读）');
  }

  // 文案是写给**管理员**看的：点名下限、传入值、算式与后果（照 §4.9 那条 1/4 上限的写法）。
  const err = await createModel(new LlmFakePool(), {
    provider_id: 'p1', model_id: 'm-a', model: 'openai/m-a', context_window: 2048,
  }).then(() => null, (caught) => caught);
  assert.match(err.message, /不能低于 65536/);
  assert.match(err.message, /传入 2048/);
  assert.match(err.message, /窗口 − 输出上限 − max\(2000, 10%×窗口\)/, '文案必须带算式（否则人不知道为什么是 64k）');
  assert.match(err.message, /压缩会静默关闭/, '文案必须带后果/出路');
});

test('#325 写侧形态归一：落到网关的是 number（不是调用方原值）；真小数/0/负数/非数字串拒', async () => {
  // 数字串→归一成 number 落库（两个入口、三个落点：model_info / metadata / 以及双写的两个预算位）。
  const created = new LlmFakePool();
  await createModel(created, {
    provider_id: 'p1', model_id: 'm-a', model: 'openai/m-a', context_window: '262144', max_output_tokens: 65536,
  });
  const body = created.gatewayCalls.find((e) => e.method === 'createModel').body;
  assert.equal(body.model_info.context_window, 262144, '#325 病症本体：数字串不得原样落库');
  assert.equal(typeof body.model_info.context_window, 'number');
  assert.equal(body.model_info.metadata.context_window, 262144, 'metadata 镜像位同样归一（否则两处形态不一致）');
  // max_output_tokens 的入口闸比 positiveIntOrNull 更严（#309 既有用例钉着「2000」这类数字串照旧拒），
  // 所以归一对它是恒等的；这里钉的是「两处落库都是 number」这条形状不变量。
  assert.equal(body.model_info.max_output_tokens, 65536);
  assert.equal(body.litellm_params.max_tokens, 65536);

  const patched = new LlmFakePool({
    models: [{ id: 'm1', provider_id: 'p1', model_id: 'a', type: 'text', context_window: 262144 }],
  });
  await updateModel(patched, 'm1', { context_window: ' 512000 ' });
  const patchBody = patched.gatewayCalls.find((e) => e.method === 'updateModel').body;
  assert.equal(patchBody.model_info.context_window, 512000, 'PATCH 同样归一（带空白也 trim）');
  assert.equal(typeof patchBody.model_info.context_window, 'number');
  assert.equal(patchBody.model_info.metadata.context_window, 512000);

  // 形态不可得一律拒（`details.value` 存的是**调用方原值**，方便对账）。
  for (const [value, reason] of [[262144.5, 'not_positive_integer'], [0, 'not_positive_integer'],
    [-1, 'not_positive_integer'], ['abc', 'not_positive_integer'], [true, 'not_positive_integer']]) {
    const pool = new LlmFakePool();
    await assert.rejects(
      () => createModel(pool, { provider_id: 'p1', model_id: 'm-a', model: 'openai/m-a', context_window: value }),
      (error) => assertWindowRejected(error, { field: 'context_window', reason, min: 65536, value }),
      `context_window=${JSON.stringify(value)} 必须被拒`,
    );
    assert.equal(pool.gatewayCalls.length, 0, '形态不可得时零请求');
    const shapePool = new LlmFakePool();
    await assert.rejects(
      () => createModel(shapePool, { provider_id: 'p1', model_id: 'm-a', model: 'openai/m-a', context_window: value }),
      (error) => {
        assert.match(error.message, /上下文窗口必须是正整数/, '形态错的文案与下限错的文案不同一句');
        return true;
      },
    );
  }
  // 整值浮点（JS 里 262144.0 === 262144）仍归一放行：不是「小数」。
  const wholeFloat = new LlmFakePool();
  await createModel(wholeFloat, { provider_id: 'p1', model_id: 'm-a', model: 'openai/m-a', context_window: 262144.0 });
  assert.equal(wholeFloat.gatewayCalls.find((e) => e.method === 'createModel').body.model_info.context_window, 262144);
});

test('#318 次序：窗口 1000 + 上限 500 ⇒ 报 too_small（而不是 1/4 上限错），两个入口都是', async () => {
  // 拿旧顺序跑：1/4 校验会先报「上限 250、传入 500」⇒ 管理员去改预算，真正的病因（窗口配错了）被藏掉。
  const details = { field: 'context_window', reason: 'too_small', min: 65536, value: 1000 };

  const post = new LlmFakePool();
  await assert.rejects(
    () => createModel(post, {
      provider_id: 'p1', model_id: 'm-a', model: 'openai/m-a', context_window: 1000, max_output_tokens: 500,
    }),
    (error) => assertWindowRejected(error, details),
  );
  const earlyError = await createModel(new LlmFakePool(), {
    provider_id: 'p1', model_id: 'm-a', model: 'openai/m-a', context_window: 1000, max_output_tokens: 500,
  }).then(() => null, (caught) => caught);
  assert.doesNotMatch(earlyError.message, /1\/4/, '不得抢在 1/4 上限错前面（那会把病因藏起来）');
  assert.equal(post.gatewayCalls.length, 0);

  const patch = new LlmFakePool({
    models: [{ id: 'm1', provider_id: 'p1', model_id: 'a', type: 'text', context_window: 262144 }],
  });
  await assert.rejects(() => updateModel(patch, 'm1', { context_window: 1000, max_output_tokens: 500 }),
    (error) => assertWindowRejected(error, details));
  assert.equal(patch.gatewayCalls.length, 0, 'PATCH 抢在 1/4 之前 ⇒ 连那次读目录的请求都不发');
});

test('#318/#325 PATCH 省略字段 = 不改（窗口与预算都是），且不因下限而误伤存量小窗口', async () => {
  const pool = new LlmFakePool({
    models: [{ id: 'm1', provider_id: 'p1', model_id: 'a', type: 'text', context_window: 262144, max_output_tokens: 65536, max_tokens: 65536 }],
  });
  await updateModel(pool, 'm1', { name: '只改展示名' });
  const body = pool.gatewayCalls.find((e) => e.method === 'updateModel').body;
  // 没提交窗口/预算 ⇒ 写侧不往 model_info 里新增这两个键（体里出现的只是 `...current.model_info` 原样镜像
  // 回来的现值，网关自己也是「没带就不动」）；数据面块干脆不带。
  assert.equal(body.model_info.context_window, 262144, '没提交窗口 ⇒ 镜像回来的仍是现值，没被改写');
  assert.equal(body.model_info.max_output_tokens, 65536, '没提交预算 ⇒ 现值原样');
  assert.notEqual(body.model_info.context_window, undefined);
  assert.equal(body.litellm_params, undefined, '不碰数据面参数就别带 litellm_params');
  const after = (await listModels(pool)).items[0];
  assert.equal(after.context_window, 262144, '存量窗口一字不动');
  assert.equal(after.max_output_tokens, 65536, '存量预算一字不动');

  // 存量小窗口（带外配出来的 8000）仍能只改预算：下限只管**本次提交的**窗口，不回头禁掉存量。
  const legacy = new LlmFakePool({
    models: [{ id: 'm2', provider_id: 'p1', model_id: 'b', type: 'text', context_window: 8000 }],
  });
  await updateModel(legacy, 'm2', { max_output_tokens: 2000 });
  const legacyBody = legacy.gatewayCalls.find((e) => e.method === 'updateModel').body;
  assert.equal(legacyBody.model_info.max_output_tokens, 2000);
  assert.equal(legacyBody.model_info.context_window, 8000,
    '没提交窗口就不得替它「顺手归一」一个窗口进去（存量脏值由带外面自己负的责任）');
});

test('#318 缺窗口不设下限：POST 的 context_window: null（新建表单的「留空」）照旧放行', async () => {
  // ⚠ 这是对 D1「出现了（非 undefined）就校验」的**唯一一处收窄**，理由全部在代码与工单里：
  //   1. #318 正文第 3 条把「缺窗口」划为另一条既有口径（输出上限留空 ⇒ `context_window_missing`）；
  //   2. `positiveIntOrNull(null)` 在 #316 的镜像表里写的是「显式 null = 没配」，不是「配错」；
  //   3. 新建表单留空发的就是显式 `null`（`AdminView.vue` 的 `context_window: … ? Number(…) : null`）
  //      ⇒ 拒 `null` 会把「建一个没配窗口的模型」（典型：embedding 位）在门户里直接堵死。
  const created = new LlmFakePool();
  await createModel(created, {
    provider_id: 'p1', model_id: 'm-emb', model: 'openai/embed', type: 'embedding', context_window: null,
  });
  const body = created.gatewayCalls.find((e) => e.method === 'createModel').body;
  assert.equal(body.model_info.context_window, null, '显式 null 仍是「没配窗口」的形状，不得被下限拒');
  assert.equal(body.model_info.metadata.context_window, null);

  // 没窗口时「配预算」仍按既有口径拒（本单没把它改成「只能配 ≥ 下限的窗口」）。
  const missing = new LlmFakePool();
  await assert.rejects(
    () => createModel(missing, { provider_id: 'p1', model_id: 'm-a', model: 'openai/m-a', max_output_tokens: 2000 }),
    (error) => {
      assert.deepEqual(error.details, { field: 'max_output_tokens', reason: 'context_window_missing' });
      return true;
    },
  );
});

// --- issue #164：自定义模型定价（虚拟 key spend 恒 0） -------------------------------

test('model create：定价写入 litellm_params（USD/token），不写进 model_info', async () => {
  const pool = new LlmFakePool();
  await createModel(pool, {
    provider_id: 'p1',
    model_id: 'deepseek-v4-pro',
    model: 'openai/deepseek-flash',
    name: 'DeepSeek V4 Pro',
    type: 'text',
    input_cost_per_token: 0.0000003,
    output_cost_per_token: 0.0000012,
  });
  const call = pool.gatewayCalls.find((entry) => entry.method === 'createModel');
  // LiteLLM v1.103.2 strips pricing echoed in model_info; the authoritative blob is litellm_params.
  assert.equal(call.body.litellm_params.input_cost_per_token, 0.0000003);
  assert.equal(call.body.litellm_params.output_cost_per_token, 0.0000012);
  assert.equal(Object.hasOwn(call.body.model_info, 'input_cost_per_token'), false);
  assert.equal(Object.hasOwn(call.body.model_info, 'output_cost_per_token'), false);
});

test('model create：未填定价时请求体不含 cost 字段（由 list 的 pricing_configured 显式标记）', async () => {
  const pool = new LlmFakePool();
  await createModel(pool, {
    provider_id: 'p1',
    model_id: 'deepseek-v4-pro',
    model: 'openai/deepseek-flash',
    type: 'text',
  });
  const call = pool.gatewayCalls.find((entry) => entry.method === 'createModel');
  assert.equal(Object.hasOwn(call.body.litellm_params, 'input_cost_per_token'), false);
  assert.equal(Object.hasOwn(call.body.litellm_params, 'output_cost_per_token'), false);
});

test('model list：pricing_configured 标记未定价 / 显式定价 / 价目表命中', async () => {
  const pool = new LlmFakePool({
    models: [
      // 自定义名，无定价 → 必须显式暴露未配置（不再静默为 0）
      { id: 'm-none', provider_id: 'p1', model_id: 'deepseek-v4-pro', type: 'text' },
      // 显式填了两项定价
      {
        id: 'm-override', provider_id: 'p1', model_id: 'glm-5.3-flash-awq', type: 'text',
        input_cost_per_token: 0.0000001, output_cost_per_token: 0.0000004,
      },
      // 只填了 input：LiteLLM 无法完整计价 → 仍视为未配置
      { id: 'm-partial', provider_id: 'p1', model_id: 'partial-model', type: 'text', input_cost_per_token: 0.0000001 },
      // 名字命中 LiteLLM 内置价目表 → 自动计价
      {
        id: 'm-costmap', provider_id: 'p1', model_id: 'gpt-4o', type: 'text',
        cost_map_input_cost_per_token: 0.0000025, cost_map_output_cost_per_token: 0.00001,
      },
    ],
  });
  const { items } = await listModels(pool);
  const byId = Object.fromEntries(items.map((m) => [m.id, m]));
  assert.equal(byId['m-none'].pricing_configured, false);
  assert.equal(byId['m-none'].pricing_source, 'none');
  assert.equal(byId['m-none'].input_cost_per_token, null);
  assert.equal(byId['m-override'].pricing_configured, true);
  assert.equal(byId['m-override'].pricing_source, 'override');
  assert.equal(byId['m-override'].input_cost_per_token, 0.0000001);
  assert.equal(byId['m-override'].output_cost_per_token, 0.0000004);
  assert.equal(byId['m-partial'].pricing_configured, false);
  assert.equal(byId['m-costmap'].pricing_configured, true);
  assert.equal(byId['m-costmap'].pricing_source, 'cost_map');
});

test('model update：定价写入 litellm_params；null 清空；undefined 保持不变', async () => {
  const pool = new LlmFakePool({
    models: [
      {
        id: 'm1', provider_id: 'p1', model_id: 'deepseek-v4-pro', name: 'V4', type: 'text',
        upstream_model: 'openai/deepseek-flash',
        input_cost_per_token: 0.0000003, output_cost_per_token: 0.0000012,
      },
    ],
  });

  // 只改名字：不带定价 → 请求体不触碰 litellm_params
  await updateModel(pool, 'm1', { name: 'V4 renamed' });
  let call = pool.gatewayCalls.filter((entry) => entry.method === 'updateModel').at(-1);
  assert.equal(call.body.litellm_params, undefined);

  // 改定价：写入 litellm_params
  await updateModel(pool, 'm1', { input_cost_per_token: 0.0000005, output_cost_per_token: 0.000002 });
  call = pool.gatewayCalls.filter((entry) => entry.method === 'updateModel').at(-1);
  assert.equal(call.body.litellm_params.input_cost_per_token, 0.0000005);
  assert.equal(call.body.litellm_params.output_cost_per_token, 0.000002);
  assert.equal(pool.models[0].input_cost_per_token, 0.0000005);

  // null 清空：显式发 null（LiteLLM 才会从两个 blob 移除）
  await updateModel(pool, 'm1', { input_cost_per_token: null, output_cost_per_token: null });
  call = pool.gatewayCalls.filter((entry) => entry.method === 'updateModel').at(-1);
  assert.equal(call.body.litellm_params.input_cost_per_token, null);
  assert.equal(call.body.litellm_params.output_cost_per_token, null);
  assert.equal(pool.models[0].input_cost_per_token, null);
  assert.equal(pool.models[0].output_cost_per_token, null);
});

test('model create/update：定价必须是有限非负数', async () => {
  const pool = new LlmFakePool({
    models: [{ id: 'm1', provider_id: 'p1', model_id: 'x', type: 'text', upstream_model: 'openai/x' }],
  });
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, '0.1', true]) {
    await assert.rejects(
      () => createModel(pool, { provider_id: 'p1', model_id: 'x', model: 'openai/x', input_cost_per_token: value }),
      (error) => error instanceof LlmError
        && error.code === 'validation_failed'
        && error.details.field === 'input_cost_per_token',
    );
    await assert.rejects(
      () => updateModel(pool, 'm1', { output_cost_per_token: value }),
      (error) => error instanceof LlmError
        && error.code === 'validation_failed'
        && error.details.field === 'output_cost_per_token',
    );
  }
  assert.equal(pool.gatewayCalls.length, 0);
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
    context_window: 262144,
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
  assert.equal(call.body.model_info.context_window, 262144);
  assert.equal(call.body.model_info.metadata.tool_calling, false);
  assert.equal(call.body.model_info.metadata.context_window, 262144);
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

function onboardingPoolForLlm(llmPool) {
  const onboarding = {
    fde_id: 'u1',
    state: 'pending',
    steps: {
      provision: { state: 'done' },
      materialize: { state: 'done' },
      'llm-binding': {
        state: 'pending',
        models: { provider_id: 'p1', main_model_id: 'm-main', embedding_model_id: null, vision_model_id: null },
      },
    },
  };
  const dispatch = (sql, params = []) => {
    if (sql.includes('SELECT o.fde_id, o.steps, u.fde_name, a.git_host_id')) {
      return onboarding.state === 'pending'
        ? { rows: [{ fde_id: 'u1', steps: structuredClone(onboarding.steps), fde_name: 'alice', git_host_id: 'git1' }] }
        : { rows: [] };
    }
    if (sql.includes('UPDATE fde_onboarding') && sql.includes("SET state = 'running'")) {
      onboarding.state = 'running';
      return { rows: [{ attempt: 1 }] };
    }
    if (sql.includes('UPDATE fde_onboarding') && sql.includes('SET steps = jsonb_set')) {
      onboarding.steps[params[1]] = JSON.parse(params[2]);
      return { rows: [] };
    }
    if (sql.includes('SELECT status FROM users WHERE id')) {
      return { rows: llmPool.users.filter((user) => user.id === params[0]).map((user) => ({ status: user.status })) };
    }
    if (sql.includes('UPDATE fde_onboarding') && sql.includes('SET state = $2')) {
      onboarding.state = params[1];
      return { rows: [] };
    }
    return undefined;
  };
  return {
    onboarding,
    async query(sql, params = []) {
      const result = dispatch(sql, params);
      if (result !== undefined) return result;
      throw new Error(`Unexpected onboarding test query: ${sql}`);
    },
    async connect() {
      const llmClient = await llmPool.connect();
      return {
        async query(sql, params = []) {
          const result = dispatch(sql, params);
          return result === undefined ? llmClient.query(sql, params) : result;
        },
        release: () => llmClient.release(),
      };
    },
  };
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

test('onboarding llm-binding 步骤会恢复 revoked binding 并发布新路由 revision', async () => {
  const llmPool = seedPool();
  llmPool.bindings.push({
    fde_id: 'u1', gateway: 'litellm', gateway_user_id: null, provider_id: 'p1',
    api_key: null, key_id: null, key_alias: 'fde-alice', state: 'revoked', revoked_at: new Date(),
    generation: 1, main_model_id: 'deepseek-flash', main_model_name: 'DeepSeek Flash',
    embedding_model_id: null, embedding_model_name: null, vision_model_id: null, vision_model_name: null,
  });
  const pool = onboardingPoolForLlm(llmPool);

  const result = await runOnboardingOnce(pool, llmPool, {
    bindLlm: setFdeLlmConfig,
    log: { warn() {} },
  });

  assert.deepEqual(result, { claimed: true, fdeId: 'u1', state: 'done' });
  assert.equal(pool.onboarding.steps['llm-binding'].state, 'done');
  assert.equal('skipped' in pool.onboarding.steps['llm-binding'], false);
  assert.equal(llmPool.bindings[0].state, 'active');
  assert.equal(llmPool.bindings[0].revoked_at, null);
  assert.equal(llmPool.bindings[0].api_key, llmPool.generatedKeys[0], 'revoked key is freshly minted');
  assert.equal(llmPool.gatewayCalls.filter((call) => call.method === 'generateKey').length, 1);
  assert.equal(llmPool.outbox.length, 1);
  assert.deepEqual(
    { aggregate: llmPool.outbox[0].aggregate, op: llmPool.outbox[0].op, revision: llmPool.outbox[0].revision },
    { aggregate: 'llm_binding', op: 'upsert', revision: 1 },
  );
});

test('onboarding llm-binding 步骤遇到 active binding 时仍幂等跳过且不覆盖', async () => {
  const llmPool = seedPool();
  llmPool.bindings.push({
    fde_id: 'u1', gateway: 'litellm', gateway_user_id: 'gateway-user-alice', provider_id: 'p1',
    api_key: 'sk-existing-active-key', key_id: 'key-existing', key_alias: 'fde-alice', state: 'active',
    generation: 2, main_model_id: 'deepseek-flash', main_model_name: 'DeepSeek Flash',
    embedding_model_id: null, embedding_model_name: null, vision_model_id: null, vision_model_name: null,
  });
  const original = structuredClone(llmPool.bindings[0]);
  const pool = onboardingPoolForLlm(llmPool);

  const result = await runOnboardingOnce(pool, llmPool, {
    bindLlm: setFdeLlmConfig,
    log: { warn() {} },
  });

  assert.equal(result.state, 'done');
  assert.deepEqual(llmPool.bindings[0], original, 'active binding is not overwritten');
  assert.equal(llmPool.gatewayCalls.length, 0, 'active skip does not call LiteLLM');
  assert.equal(llmPool.outbox.length, 0, 'active skip does not change the route by itself');
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
      body: JSON.stringify({ model_id: 'deepseek-flash', model: 'deepseek/deepseek-chat', name: 'DeepSeek Flash', type: 'text', tool_calling: true, context_window: 200000, input_cost_per_token: 0.0000003, output_cost_per_token: 0.0000012 }),
    });
    assert.equal(res.status, 201);
    const created = pool.llm.models.find((model) => model.provider_id === p2.id);
    assert.equal(created.upstream_model, 'deepseek/deepseek-chat');
    // issue #164：定价经 HTTP 透传到 litellm_params，list 响应带 pricing_configured。
    assert.equal(created.input_cost_per_token, 0.0000003);
    assert.equal(created.output_cost_per_token, 0.0000012);
    res = await fetch(`${base}/api/admin/llm/models`, { headers: { cookie: admin.cookie } });
    assert.equal(res.status, 200);
    const listed = (await res.json()).items.find((model) => model.id === created.id);
    assert.equal(listed.pricing_configured, true);
    assert.equal(listed.pricing_source, 'override');

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

test('B1：syncFdeLlmBindingOnOnboard——restoreRevoked=false 不恢复 revoked binding', async () => {
  const pool = new LlmFakePool({
    bindings: [{
      fde_id: 'u1', provider_id: 'p1', api_key: 'sk-test-1234567890', state: 'revoked',
      revoked_at: new Date(), main_model_id: 'm1',
    }],
  });
  const out = await syncFdeLlmBindingOnOnboard(pool, { fdeId: 'u1', fdeName: 'alice', restoreRevoked: false, gateway: pool });
  assert.deepEqual(out, { restored: false, republished: false });
  assert.equal(pool.bindings[0].state, 'revoked', 'restoreRevoked=false 的 provision sync 不恢复 revoked binding');
  assert.equal(pool.outbox.length, 0);
});

test('B1：syncFdeLlmBindingOnOnboard——needRecreate 时 active binding 仍发布 upsert revision；无 binding → no-op', async () => {
  const pool = new LlmFakePool({
    bindings: [{
      fde_id: 'u1', provider_id: 'p1', gateway: 'litellm', key_alias: 'fde-alice',
      api_key: 'sk-test-virtual-active', state: 'active',
      main_model_id: 'deepseek-flash', main_model_name: 'deepseek-flash',
    }],
  });
  const out1 = await syncFdeLlmBindingOnOnboard(pool, { fdeId: 'u1', fdeName: 'alice', restoreRevoked: false, gateway: pool });
  assert.deepEqual(out1, { restored: false, republished: true });
  assert.equal(pool.outbox.length, 1);
  assert.deepEqual(
    { op: pool.outbox[0].op, revision: pool.outbox[0].revision },
    { op: 'upsert', revision: 1 },
    'recreated container 的 active route 必须产生新 outbox revision',
  );
  const rev = pool.revisions.get('llm_binding:u1');
  const out2 = await syncFdeLlmBindingOnOnboard(pool, { fdeId: 'u1', fdeName: 'alice', restoreRevoked: false, gateway: pool });
  assert.deepEqual(out2, { restored: false, republished: true });
  assert.equal(pool.revisions.get('llm_binding:u1'), rev + 1, '每次 upsert revision 递增（head 语义，与 setFdeLlmConfig 同构）');
  assert.equal(pool.outbox.length, 2);

  const empty = new LlmFakePool({});
  assert.deepEqual(
    await syncFdeLlmBindingOnOnboard(empty, { fdeId: 'u9', fdeName: 'nobody', restoreRevoked: true, gateway: empty }),
    { restored: false, republished: false },
  );
  assert.equal(empty.outbox.length, 0, '新 FDE 没有 binding 时，provision sync 不写路由 outbox');
  assert.equal(empty.gatewayCalls.length, 0, '新 FDE 没有 binding 时，provision sync 不调用 LiteLLM');
});
