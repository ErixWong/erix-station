// LLM binding and LiteLLM admin API adapters (issue #117 phase 2).
// LiteLLM owns credentials and the model catalog; Station stores only per-FDE
// bindings and the virtual key returned once by /key/generate.

import { enqueueRouteChange } from './outbox.js';
import { createLlmGatewayClient, LlmGatewayError } from './llm-gateway.js';

export { LlmGatewayError };

export const LLM_MODEL_TYPES = ['text', 'embedding', 'vision', 'rerank', 'audio-tts', 'audio-stt', 'image-gen'];

export class LlmError extends Error {
  constructor(code, message, { httpStatus = 400, details } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export function maskKey(key) {
  if (typeof key !== 'string' || key.length < 8) return '***';
  return `sk-...${key.slice(-4)}`;
}

function getGatewayClient(candidate) {
  if (candidate && typeof candidate === 'object' && [
    'listModels', 'generateKey', 'deleteKey', 'listCredentials', 'createCredential',
  ].some((method) => typeof candidate[method] === 'function')) {
    return candidate;
  }
  const config = candidate ?? {};
  return createLlmGatewayClient({
    adminUrl: config.llmGatewayAdminUrl ?? process.env.LLM_GATEWAY_ADMIN_URL ?? 'http://station-litellm:4000',
    masterKey: config.llmGatewayMasterKey ?? process.env.LLM_GATEWAY_MASTER_KEY ?? '',
    fetchImpl: config.fetchImpl ?? fetch,
    timeoutMs: config.timeoutMs,
  });
}

function rowsFrom(payload, keys) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function credentialName(row) {
  return row?.credential_name ?? row?.name ?? row?.credential_info?.credential_name ?? '';
}

function credentialValues(row) {
  return row?.credential_values ?? row?.values ?? {};
}

function redactCredential(value) {
  if (Array.isArray(value)) return value.map(redactCredential);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    /^(api[_-]?key|master[_-]?key)$/i.test(key) && typeof child === 'string' ? maskKey(child) : redactCredential(child),
  ]));
}

function gatewayModels(payload) {
  return rowsFrom(payload, ['data', 'models']);
}

function modelCredentialName(model) {
  return model?.litellm_params?.litellm_credential_name
    ?? model?.litellm_params?.credential_name
    ?? model?.model_info?.litellm_credential_name
    ?? model?.model_info?.metadata?.credential_name
    ?? '';
}

function modelType(model) {
  const info = model?.model_info ?? {};
  const metadata = info.metadata ?? {};
  const mode = String(info.mode ?? model?.litellm_params?.mode ?? '').toLowerCase();
  const explicit = info.type ?? info.model_type ?? metadata.type ?? metadata.model_type;
  if (LLM_MODEL_TYPES.includes(explicit)) return explicit;
  if (mode === 'embedding') return 'embedding';
  if (mode === 'image_generation') return 'image-gen';
  if (mode === 'rerank') return 'rerank';
  return 'text';
}

function modelToolCalling(model) {
  const info = model?.model_info ?? {};
  const metadata = info.metadata ?? {};
  const value = info.tool_calling ?? info.supports_function_calling ?? metadata.tool_calling;
  return value === undefined ? modelType(model) === 'text' : value === true;
}

function isModelBlocked(model) {
  return model?.model_info?.blocked === true;
}

function modelId(model) {
  return model?.model_info?.id ?? model?.id ?? null;
}

function toModel(model) {
  const id = modelId(model);
  const modelName = model?.model_name ?? '';
  const params = model?.litellm_params ?? {};
  const info = model?.model_info ?? {};
  const metadata = info.metadata ?? {};
  const type = modelType(model);
  return {
    id,
    provider_id: modelCredentialName(model),
    model_id: id,
    model_name: modelName,
    name: info.display_name ?? metadata.display_name ?? modelName,
    type,
    tool_calling: modelToolCalling(model),
    context_window: info.context_window ?? metadata.context_window ?? null,
    enabled: !isModelBlocked(model),
    litellm_params: redactCredential(params),
    model_info: redactCredential(info),
  };
}

function toProvider(credential, models) {
  const name = credentialName(credential);
  const values = credentialValues(credential);
  const info = credential?.credential_info ?? {};
  return {
    id: name,
    name: info.display_name ?? info.name ?? name,
    base_url: values.api_base ?? values.base_url ?? '',
    api_format: 'openai',
    credential_info: redactCredential(info),
    credential_values: redactCredential(values),
    models,
  };
}

export async function listModels(gateway) {
  const client = getGatewayClient(gateway);
  return { items: gatewayModels(await client.listModels()).map(toModel) };
}

export async function listProviders(gateway) {
  const client = getGatewayClient(gateway);
  const [credentialPayload, modelPayload] = await Promise.all([client.listCredentials(), client.listModels()]);
  const models = gatewayModels(modelPayload).map(toModel);
  return {
    items: rowsFrom(credentialPayload, ['credentials', 'data']).map((credential) => {
      const name = credentialName(credential);
      return toProvider(credential, models.filter((model) => model.provider_id === name));
    }),
  };
}

export async function createProvider(gateway, input = {}) {
  const client = getGatewayClient(gateway);
  const name = input.credential_name ?? input.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new LlmError('validation_failed', 'name 为必填字段', { details: { field: 'name' } });
  }
  const info = input.credential_info ?? {
    credential_name: name.trim(),
    description: input.description ?? name.trim(),
  };
  const values = { ...(input.credential_values ?? {}) };
  if (input.base_url !== undefined) values.api_base = input.base_url;
  if (input.api_key !== undefined) values.api_key = input.api_key;
  const result = await client.createCredential({
    credential_name: name.trim(),
    credential_info: info,
    credential_values: values,
  });
  return toProvider(result?.credential ?? result ?? { credential_name: name.trim(), credential_info: info, credential_values: values }, []);
}

export async function updateProvider(gateway, name, { base_url, enabled, credential_info, credential_values } = {}) {
  const client = getGatewayClient(gateway);
  if (enabled !== undefined) {
    throw new LlmError('validation_failed', 'LiteLLM credential 不支持启停；请删除 credential 或管理其模型', {
      details: { field: 'enabled' },
    });
  }
  let values = credential_values;
  if (base_url !== undefined && !values) {
    const payload = await client.listCredentials();
    const current = rowsFrom(payload, ['credentials', 'data']).find((item) => credentialName(item) === name);
    if (!current) throw new LlmError('not_found', 'credential not found', { httpStatus: 404 });
    values = { ...credentialValues(current), api_base: base_url };
  }
  const body = {
    ...(credential_info === undefined ? {} : { credential_info }),
    ...(values === undefined ? {} : { credential_values: values }),
  };
  const result = await client.updateCredential(name, body);
  return toProvider(result?.credential ?? result ?? { credential_name: name, credential_info, credential_values: values }, []);
}

export async function deleteProvider(gateway, name) {
  return getGatewayClient(gateway).deleteCredential(name);
}

export async function createModel(gateway, input = {}) {
  const client = getGatewayClient(gateway);
  const modelName = input.model_name ?? input.model_id;
  if (typeof modelName !== 'string' || !modelName.trim()) {
    throw new LlmError('validation_failed', 'model_id 为必填字段', { details: { field: 'model_id' } });
  }
  const params = input.litellm_params ?? {
    model: input.model ?? input.model_id,
    litellm_credential_name: input.provider_id,
  };
  const suppliedInfo = input.model_info ?? {};
  const metadata = {
    ...(suppliedInfo.metadata ?? {}),
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.tool_calling === undefined ? {} : { tool_calling: input.tool_calling === true }),
    ...(input.context_window === undefined ? {} : { context_window: input.context_window }),
  };
  const model_info = {
    ...suppliedInfo,
    ...(input.name === undefined ? {} : { display_name: input.name }),
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.tool_calling === undefined ? {} : { tool_calling: input.tool_calling === true }),
    ...(input.context_window === undefined ? {} : { context_window: input.context_window }),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
  return client.createModel({ model_name: modelName.trim(), litellm_params: params, model_info });
}

async function findGatewayModel(client, id) {
  const models = gatewayModels(await client.listModels());
  const found = models.find((model) => String(modelId(model)) === String(id));
  if (!found) throw new LlmError('not_found', 'model not found', { httpStatus: 404 });
  return found;
}

export async function updateModel(gateway, id, { name, enabled, tool_calling, context_window } = {}) {
  const client = getGatewayClient(gateway);
  const current = await findGatewayModel(client, id);
  const currentEnabled = !isModelBlocked(current);
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new LlmError('validation_failed', 'enabled 必须为 boolean', { details: { field: 'enabled' } });
  }
  if (enabled !== undefined && enabled !== currentEnabled) {
    if (enabled) await client.unblockModel(id);
    else await client.blockModel(id);
  }
  if (name !== undefined || tool_calling !== undefined || context_window !== undefined) {
    const info = current.model_info ?? {};
    const metadata = { ...(info.metadata ?? {}) };
    if (tool_calling !== undefined) metadata.tool_calling = tool_calling === true;
    if (context_window !== undefined) metadata.context_window = context_window;
    await client.updateModel({
      model_id: id,
      model_info: {
        ...info,
        ...(name === undefined ? {} : { display_name: name }),
        ...(tool_calling === undefined ? {} : { tool_calling: tool_calling === true }),
        ...(context_window === undefined ? {} : { context_window }),
        metadata,
      },
    });
  }
  return toModel(await findGatewayModel(client, id));
}

export async function deleteModel(gateway, id) {
  const client = getGatewayClient(gateway);
  const current = await findGatewayModel(client, id);
  return client.deleteModel(current.model_info?.id ?? id);
}

function slot(model_id, name, type) {
  if (model_id == null) return null;
  if (typeof name !== 'string' || name.length === 0) {
    throw new LlmGatewayError(502, 'Active LiteLLM binding is missing the data-plane model name');
  }
  return { model_id, name, type };
}

/** Internal full binding read. api_key is the LiteLLM virtual key and must not be logged or exposed. */
export async function getFdeLlmConfig(pool, userId) {
  const r = await pool.query(
    `SELECT provider_id, api_key, gateway, gateway_user_id, key_id, key_alias, state,
            main_model_id, main_model_name, embedding_model_id, embedding_model_name,
            vision_model_id, vision_model_name
       FROM fde_llm_bindings
      WHERE fde_id = $1 AND state = 'active' AND gateway = 'litellm'`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    provider_id: row.provider_id,
    provider_name: row.provider_id,
    gateway: row.gateway,
    gateway_user_id: row.gateway_user_id ?? null,
    key_id: row.key_id ?? null,
    key_alias: row.key_alias,
    api_key: row.api_key ?? null,
    main: slot(row.main_model_id, row.main_model_name, 'text'),
    embedding: slot(row.embedding_model_id, row.embedding_model_name, 'embedding'),
    vision: slot(row.vision_model_id, row.vision_model_name, 'vision'),
  };
}

/** Model ids are LiteLLM model_info.id strings and need no join to a Station-owned catalog. */
export async function getFdeLlmHeartbeatModels(pool, userId) {
  const r = await pool.query(
    `SELECT main_model_id, main_model_name,
            embedding_model_id, embedding_model_name,
            vision_model_id, vision_model_name
       FROM fde_llm_bindings
      WHERE fde_id = $1 AND state = 'active' AND gateway = 'litellm'
        AND api_key IS NOT NULL AND api_key <> ''`,
    [userId],
  );
  const row = r.rows[0];
  if (!row?.main_model_id) return null;
  if (!row.main_model_name) {
    throw new LlmGatewayError(502, 'Active LiteLLM binding is missing the data-plane model name');
  }
  if ((row.embedding_model_id && !row.embedding_model_name) || (row.vision_model_id && !row.vision_model_name)) {
    throw new LlmGatewayError(502, 'Active LiteLLM binding is missing a data-plane model name');
  }
  const models = { main: { model: row.main_model_name, type: 'text' } };
  if (row.embedding_model_id) {
    models.embedding = { model: row.embedding_model_name, type: 'embedding' };
  }
  if (row.vision_model_id) {
    models.vision = { model: row.vision_model_name, type: 'vision' };
  }
  return models;
}

export async function getFdeLlmEcho(pool, fdeName) {
  const u = await pool.query(`SELECT id FROM users WHERE fde_name = $1 AND status = 'active'`, [fdeName]);
  if (u.rows.length === 0) throw new LlmError('not_found', 'not found', { httpStatus: 404 });
  const config = await getFdeLlmConfig(pool, u.rows[0].id);
  if (!config) return null;
  return { ...config, api_key: config.api_key == null ? null : maskKey(config.api_key) };
}

function validateSlotModel(model, { slotName, modelId, providerId, expectedType, requireToolCalling }) {
  const fail = (message) => {
    throw new LlmError('validation_failed', message, {
      details: { field: slotName, model_id: modelId },
    });
  };
  if (isModelBlocked(model)) fail(`${slotName} 模型已停用`);
  const actualCredential = modelCredentialName(model);
  if (providerId && actualCredential !== providerId) fail(`${slotName} 模型与 credential 不匹配`);
  const type = modelType(model);
  if (type !== expectedType) fail(`${slotName} 模型类型不匹配（期望 ${expectedType}，实际 ${type}）`);
  if (requireToolCalling && !modelToolCalling(model)) fail(`${slotName} 模型不支持 tool_calling`);
  return model;
}

async function selectGatewayModels(gateway, { providerId, mainModelId, embeddingModelId, visionModelId }) {
  const client = getGatewayClient(gateway);
  const models = gatewayModels(await client.listModels());
  const select = (slotName, id, expectedType, requireToolCalling = false) => {
    if (id == null) return null;
    const model = models.find((item) => String(modelId(item)) === String(id));
    if (!model) {
      throw new LlmError('validation_failed', `${slotName} 模型不存在`, {
        details: { field: slotName, model_id: id },
      });
    }
    return validateSlotModel(model, {
      slotName, modelId: id, providerId, expectedType, requireToolCalling,
    });
  };
  return {
    client,
    main: select('main', mainModelId, 'text', true),
    embedding: select('embedding', embeddingModelId, 'embedding'),
    vision: select('vision', visionModelId, 'vision'),
  };
}

async function ensureGatewayUser(client, { fdeName, userId }) {
  const result = await client.createUser({ user_email: `fde-${fdeName}@station.invalid` });
  const gatewayUserId = result?.user_id ?? result?.id;
  if (typeof gatewayUserId !== 'string' || !gatewayUserId) {
    throw new LlmGatewayError(502, 'LiteLLM did not return a user_id');
  }
  return gatewayUserId;
}

async function generateFdeKey(client, { fdeId, fdeName, gatewayUserId, selectedModels }) {
  const userId = gatewayUserId || await ensureGatewayUser(client, { fdeName, userId: fdeId });
  const modelNames = [selectedModels.main, selectedModels.embedding, selectedModels.vision]
    .filter(Boolean)
    .map((model) => model.model_name)
    .filter((name) => typeof name === 'string' && name.length > 0);
  const result = await client.generateKey({
    models: [...new Set(modelNames)],
    user_id: userId,
    key_alias: `fde-${fdeName}`,
    metadata: { fde_id: fdeId, fde_name: fdeName },
  });
  if (typeof result?.key !== 'string' || !result.key) {
    throw new LlmGatewayError(502, 'LiteLLM did not return a virtual key');
  }
  return {
    gatewayUserId: userId,
    apiKey: result.key,
    keyId: result.key_id ?? result.token_id ?? result.id ?? null,
    keyAlias: result.key_alias ?? `fde-${fdeName}`,
  };
}

/**
 * Save a binding and mint its model-restricted virtual key. `api_key` is no longer
 * an upstream credential; upstream secrets belong to LiteLLM credentials.
 */
export async function setFdeLlmConfig(pool, {
  actorId = null, fdeName, provider_id, api_key, main_model_id, embedding_model_id = null, vision_model_id = null,
  force = false, gateway,
} = {}) {
  if (typeof provider_id !== 'string' || provider_id === '') {
    throw new LlmError('validation_failed', 'provider_id 为必填字段', { details: { field: 'provider_id' } });
  }
  if (typeof main_model_id !== 'string' || main_model_id === '') {
    throw new LlmError('validation_failed', 'main_model_id 为必填字段', { details: { field: 'main_model_id' } });
  }
  if (api_key !== undefined && api_key !== null && api_key !== '') {
    throw new LlmError('validation_failed', '上游 API key 必须保存在 LiteLLM credential 中，不得按 FDE 提交', {
      details: { field: 'api_key' },
    });
  }

  const gatewayClient = getGatewayClient(gateway);
  const selected = await selectGatewayModels(gatewayClient, {
    providerId: provider_id, mainModelId: main_model_id, embeddingModelId: embedding_model_id, visionModelId: vision_model_id,
  });
  const client = await pool.connect();
  let oldKey = null;
  let oldWasGatewayKey = false;
  let generated = null;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`llm-binding:${fdeName}`]);
    const u = await client.query(`SELECT id, fde_name FROM users WHERE fde_name = $1 AND status = 'active'`, [fdeName]);
    if (u.rows.length === 0) throw new LlmError('not_found', 'not found', { httpStatus: 404 });
    const userId = u.rows[0].id;
    const existing = await client.query(
      `SELECT provider_id, api_key, gateway, gateway_user_id, key_id, key_alias, state,
              main_model_id, main_model_name, embedding_model_id, embedding_model_name,
              vision_model_id, vision_model_name, generation
         FROM fde_llm_bindings WHERE fde_id = $1 FOR UPDATE`,
      [userId],
    );
    const current = existing.rows[0] ?? null;
    const sameBinding = current?.state === 'active'
      && current.gateway === 'litellm'
      && current.api_key
      && current.provider_id === provider_id
      && current.main_model_id === main_model_id
      && (current.embedding_model_id ?? null) === (embedding_model_id ?? null)
      && (current.vision_model_id ?? null) === (vision_model_id ?? null)
      && current.main_model_name === selected.main.model_name
      && (current.embedding_model_name ?? null) === (selected.embedding?.model_name ?? null)
      && (current.vision_model_name ?? null) === (selected.vision?.model_name ?? null);

    if (!sameBinding && force !== true && current?.state === 'active') {
      const activeRun = await client.query(
        `SELECT 1 FROM runs r
          JOIN chat_sessions s ON s.id = r.session_id
         WHERE s.user_id = $1 AND r.status IN ('queued', 'running', 'cancelling')
         LIMIT 1`,
        [userId],
      );
      if (activeRun.rows.length > 0) {
        throw new LlmError('active_run_conflict',
          '该 FDE 有进行中的 run：更改模型白名单会轮换 LiteLLM key。确认无影响请带 force=true 重试。',
          { httpStatus: 409 });
      }
    }

    if (sameBinding) {
      await client.query('COMMIT');
      return {
        provider_id,
        provider_name: provider_id,
        gateway: 'litellm',
        key_id: current.key_id ?? null,
        key_alias: current.key_alias,
        api_key: maskKey(current.api_key),
        main: { model_id: modelId(selected.main), name: selected.main.model_name, type: 'text' },
        embedding: selected.embedding ? { model_id: modelId(selected.embedding), name: selected.embedding.model_name, type: 'embedding' } : null,
        vision: selected.vision ? { model_id: modelId(selected.vision), name: selected.vision.model_name, type: 'vision' } : null,
      };
    }

    generated = await generateFdeKey(gatewayClient, {
      fdeId: userId,
      fdeName,
      gatewayUserId: current?.gateway_user_id ?? null,
      selectedModels: selected,
    });
    oldKey = current?.api_key ?? null;
    oldWasGatewayKey = current?.gateway === 'litellm' && oldKey !== null;
    if (current) {
      await client.query(
        `UPDATE fde_llm_bindings
            SET provider_id = $2, api_key = $3, key_id = $4, key_alias = $5, gateway = 'litellm',
                gateway_user_id = $6, state = 'active', revoked_at = NULL,
                main_model_id = $7, main_model_name = $8,
                embedding_model_id = $9, embedding_model_name = $10,
                vision_model_id = $11, vision_model_name = $12,
                generation = CASE WHEN $13 THEN generation + 1 ELSE generation END,
                rotated_at = CASE WHEN $13 THEN now() ELSE rotated_at END,
                updated_at = now()
          WHERE fde_id = $1`,
        [userId, provider_id, generated.apiKey, generated.keyId, generated.keyAlias, generated.gatewayUserId,
          modelId(selected.main), selected.main.model_name,
          selected.embedding ? modelId(selected.embedding) : null, selected.embedding?.model_name ?? null,
          selected.vision ? modelId(selected.vision) : null, selected.vision?.model_name ?? null, oldWasGatewayKey],
      );
    } else {
      await client.query(
        `INSERT INTO fde_llm_bindings
           (fde_id, gateway, gateway_user_id, key_id, key_alias, state, generation, provider_id, api_key,
            main_model_id, main_model_name, embedding_model_id, embedding_model_name, vision_model_id, vision_model_name)
         VALUES ($1, 'litellm', $2, $3, $4, 'active', 1, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [userId, generated.gatewayUserId, generated.keyId, generated.keyAlias, provider_id, generated.apiKey,
          modelId(selected.main), selected.main.model_name,
          selected.embedding ? modelId(selected.embedding) : null, selected.embedding?.model_name ?? null,
          selected.vision ? modelId(selected.vision) : null, selected.vision?.model_name ?? null],
      );
    }
    await enqueueRouteChange(client, {
      aggregate: 'llm_binding',
      aggregateId: userId,
      op: 'upsert',
      payload: {
        fde_name: fdeName,
        provider_id,
        gateway: 'litellm',
        main_model_id: modelId(selected.main),
        embedding_model_id: selected.embedding ? modelId(selected.embedding) : null,
        vision_model_id: selected.vision ? modelId(selected.vision) : null,
        has_api_key: true,
      },
    });
    await client.query(
      `INSERT INTO audit_log (actor_id, action, target, details)
       VALUES ($1, 'llm.config_updated', $2, $3)`,
      [actorId, fdeName, JSON.stringify({
        fde_name: fdeName,
        provider_id,
        main_model: selected.main.model_name,
        embedding_model: selected.embedding?.model_name ?? null,
        vision_model: selected.vision?.model_name ?? null,
        virtual_key_rotated: true,
      })],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (generated?.apiKey) {
      try {
        await gatewayClient.deleteKey({ keys: [generated.apiKey] });
      } catch {
        throw new LlmGatewayError(502, 'Binding save failed and the newly generated LiteLLM key could not be cleaned up');
      }
    }
    throw err;
  } finally {
    client.release();
  }

  if (oldWasGatewayKey && oldKey && oldKey !== generated.apiKey) {
    await gatewayClient.deleteKey({ keys: [oldKey] });
  }
  return {
    provider_id,
    provider_name: provider_id,
    gateway: 'litellm',
    key_id: generated.keyId,
    key_alias: generated.keyAlias,
    api_key: maskKey(generated.apiKey),
    main: { model_id: modelId(selected.main), name: selected.main.model_name, type: 'text' },
    embedding: selected.embedding ? { model_id: modelId(selected.embedding), name: selected.embedding.model_name, type: 'embedding' } : null,
    vision: selected.vision ? { model_id: modelId(selected.vision), name: selected.vision.model_name, type: 'vision' } : null,
  };
}

/** Delete the LiteLLM key before committing offboarding; a failed revoke aborts the DB transaction. */
export async function revokeFdeLlmConfigTx(client, { fdeId, fdeName, gateway } = {}) {
  const current = await client.query(
    `SELECT api_key, key_alias, gateway FROM fde_llm_bindings
      WHERE fde_id = $1 AND state = 'active' FOR UPDATE`,
    [fdeId],
  );
  const row = current.rows[0];
  if (!row) return false;
  if (row.gateway === 'litellm') {
    await getGatewayClient(gateway).deleteKey({ keys: [row.api_key ?? row.key_alias] });
  }
  const result = await client.query(
    `UPDATE fde_llm_bindings
        SET state = 'revoked', api_key = NULL, revoked_at = now(), updated_at = now()
      WHERE fde_id = $1 AND state = 'active'`,
    [fdeId],
  );
  if (result.rowCount === 0) return false;
  await enqueueRouteChange(client, {
    aggregate: 'llm_binding',
    aggregateId: fdeId,
    op: 'delete',
    payload: { fde_name: fdeName },
  });
  return true;
}

/** Onboard republishes an existing virtual key or rotates one after a revoked binding is restored. */
export async function syncFdeLlmBindingOnOnboard(pool, { fdeId, fdeName, restoreRevoked = false, gateway } = {}) {
  const gatewayClient = getGatewayClient(gateway);
  const client = await pool.connect();
  let oldKey = null;
  let oldWasGatewayKey = false;
  let generated = null;
  let restored = false;
  let republished = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`llm-binding:${fdeName}`]);
    const r = await client.query(
      `SELECT state, provider_id, api_key, key_id, key_alias, gateway, gateway_user_id,
              main_model_id, main_model_name, embedding_model_id, embedding_model_name,
              vision_model_id, vision_model_name
         FROM fde_llm_bindings WHERE fde_id = $1 FOR UPDATE`,
      [fdeId],
    );
    const row = r.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return { restored: false, republished: false };
    }
    const shouldRestore = row.state === 'revoked' && restoreRevoked && row.main_model_id != null;
    const needsKey = shouldRestore
      || (row.state === 'active' && (
        row.gateway !== 'litellm'
        || !row.api_key
        || !row.main_model_name
        || (row.embedding_model_id && !row.embedding_model_name)
        || (row.vision_model_id && !row.vision_model_name)
      ));
    let effective = row.state === 'active';
    if (needsKey) {
      const selected = await selectGatewayModels(gatewayClient, {
        providerId: row.provider_id,
        mainModelId: row.main_model_id,
        embeddingModelId: row.embedding_model_id,
        visionModelId: row.vision_model_id,
      });
      if (!selected.main) {
        await client.query('COMMIT');
        return { restored: false, republished: false };
      }
      generated = await generateFdeKey(gatewayClient, {
        fdeId,
        fdeName,
        gatewayUserId: row.gateway_user_id ?? null,
        selectedModels: selected,
      });
      oldKey = row.api_key ?? null;
      oldWasGatewayKey = row.gateway === 'litellm' && oldKey !== null;
      await client.query(
        `UPDATE fde_llm_bindings
            SET gateway = 'litellm', gateway_user_id = $2, key_id = $3, key_alias = $4,
                api_key = $5, state = 'active', revoked_at = NULL,
                main_model_name = $6, embedding_model_name = $7, vision_model_name = $8,
                generation = CASE WHEN $9 THEN generation + 1 ELSE generation END,
                rotated_at = CASE WHEN $9 THEN now() ELSE rotated_at END,
                updated_at = now()
          WHERE fde_id = $1`,
        [fdeId, generated.gatewayUserId, generated.keyId, generated.keyAlias, generated.apiKey,
          selected.main.model_name, selected.embedding?.model_name ?? null, selected.vision?.model_name ?? null,
          row.state === 'active' && oldWasGatewayKey],
      );
      restored = shouldRestore;
      effective = true;
    } else if (shouldRestore) {
      restored = true;
      effective = true;
      await client.query(
        `UPDATE fde_llm_bindings SET state = 'active', revoked_at = NULL, updated_at = now()
          WHERE fde_id = $1`,
        [fdeId],
      );
    }
    if (effective) {
      await enqueueRouteChange(client, {
        aggregate: 'llm_binding',
        aggregateId: fdeId,
        op: 'upsert',
        payload: { fde_name: fdeName, restored, gateway: 'litellm' },
      });
      republished = true;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (generated?.apiKey) {
      try {
        await gatewayClient.deleteKey({ keys: [generated.apiKey] });
      } catch {
        throw new LlmGatewayError(502, 'Onboard failed and the newly generated LiteLLM key could not be cleaned up');
      }
    }
    throw err;
  } finally {
    client.release();
  }
  if (oldWasGatewayKey && oldKey && generated?.apiKey !== oldKey) {
    await gatewayClient.deleteKey({ keys: [oldKey] });
  }
  return { restored, republished };
}

export async function deleteFdeLlmConfig(pool, { actorId = null, fdeName, gateway } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`llm-binding:${fdeName}`]);
    const u = await client.query(`SELECT id FROM users WHERE fde_name = $1 AND status = 'active'`, [fdeName]);
    if (!u.rows.length) throw new LlmError('not_found', 'not found', { httpStatus: 404 });
    const binding = await client.query(
      `SELECT api_key, key_alias, gateway FROM fde_llm_bindings WHERE fde_id = $1 FOR UPDATE`,
      [u.rows[0].id],
    );
    if (!binding.rows.length) {
      await client.query('COMMIT');
      return false;
    }
    const row = binding.rows[0];
    if (row.gateway === 'litellm') await getGatewayClient(gateway).deleteKey({ keys: [row.api_key ?? row.key_alias] });
    await client.query(`DELETE FROM fde_llm_bindings WHERE fde_id = $1`, [u.rows[0].id]);
    await enqueueRouteChange(client, {
      aggregate: 'llm_binding', aggregateId: u.rows[0].id, op: 'delete', payload: { fde_name: fdeName },
    });
    await client.query(
      `INSERT INTO audit_log (actor_id, action, target, details)
       VALUES ($1, 'llm.config_deleted', $2, $3)`,
      [actorId, fdeName, JSON.stringify({ fde_name: fdeName })],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
