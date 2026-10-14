// LLM binding and LiteLLM admin API adapters (issue #117 phase 2).
// LiteLLM owns credentials and the model catalog; Station stores only per-FDE
// bindings and the virtual key returned once by /key/generate.

import { enqueueRouteChange } from './outbox.js';
import { createLlmGatewayClient, LlmGatewayError } from './llm-gateway.js';

export { LlmGatewayError };

export const LLM_MODEL_TYPES = ['text', 'embedding', 'vision', 'rerank', 'audio-tts', 'audio-stt', 'image-gen'];

export function typeToMode(type) {
  switch (type) {
    case 'embedding':
      return 'embedding';
    case 'rerank':
      return 'rerank';
    case 'audio-tts':
      return 'audio_speech';
    case 'audio-stt':
      return 'audio_transcription';
    case 'image-gen':
      return 'image_generation';
    case 'text':
    case 'vision':
    default:
      return 'chat';
  }
}

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
    'listModels', 'generateKey', 'updateKey', 'deleteKey', 'listCredentials', 'createCredential',
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

/** A finite, non-negative number, or null for anything else (LiteLLM may echo null/strings). */
function costOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pricingOverrideFields(model) {
  const overrides = model?.model_info?.pricing_overrides;
  return Array.isArray(overrides) ? overrides : [];
}

/**
 * Custom per-model pricing (issue #164).
 *
 * LiteLLM v1.103.2 resolves cost by model name against its built-in cost map; a custom
 * catalog name is not in that map, so the virtual key's `spend` stays 0. The authoritative
 * place to declare a rate for a custom deployment is `litellm_params` (the server mirrors
 * those fields onto `model_info` and strips any pricing echoed back in `model_info`).
 *
 * `pricing_configured` is true only when both per-token rates are known, because LiteLLM
 * needs both to bill a request completely. When false the caller must surface it explicitly
 * instead of letting usage silently record 0.
 */
function modelPricing(model) {
  const params = model?.litellm_params ?? {};
  const info = model?.model_info ?? {};
  const explicitInput = costOrNull(params.input_cost_per_token);
  const explicitOutput = costOrNull(params.output_cost_per_token);
  const overrides = pricingOverrideFields(model);
  const overrideInput = explicitInput ?? (overrides.includes('input_cost_per_token') ? costOrNull(info.input_cost_per_token) : null);
  const overrideOutput = explicitOutput ?? (overrides.includes('output_cost_per_token') ? costOrNull(info.output_cost_per_token) : null);
  const input = overrideInput ?? costOrNull(info.input_cost_per_token);
  const output = overrideOutput ?? costOrNull(info.output_cost_per_token);
  const hasOverride = overrideInput !== null || overrideOutput !== null;
  const hasCostMap = costOrNull(info.input_cost_per_token) !== null || costOrNull(info.output_cost_per_token) !== null;
  return {
    input_cost_per_token: input,
    output_cost_per_token: output,
    pricing_configured: input !== null && output !== null,
    pricing_source: hasOverride ? 'override' : (hasCostMap ? 'cost_map' : 'none'),
  };
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
    max_tokens: params.max_tokens ?? null,
    enabled: !isModelBlocked(model),
    ...modelPricing(model),
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

function toProviderMutationResult(result, { name, info = {}, values = {} }) {
  const credential = result?.credential ?? result;
  return toProvider(
    credentialName(credential)
      ? credential
      : { credential_name: name, credential_info: info, credential_values: values },
    [],
  );
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

export async function validateFdeLlmSelection(gateway, input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new LlmError('validation_failed', 'llm 必须是对象', {
      details: { field: 'llm' },
    });
  }
  const {
    provider_id,
    main_model_id,
    embedding_model_id = null,
    vision_model_id = null,
  } = input;
  if (typeof provider_id !== 'string' || provider_id.trim() === '') {
    throw new LlmError('validation_failed', 'provider_id 为必填字段', {
      details: { field: 'llm.provider_id' },
    });
  }
  if (typeof main_model_id !== 'string' || main_model_id.trim() === '') {
    throw new LlmError('validation_failed', 'main_model_id 为必填字段', {
      details: { field: 'llm.main_model_id' },
    });
  }
  for (const [field, value] of [
    ['embedding_model_id', embedding_model_id],
    ['vision_model_id', vision_model_id],
  ]) {
    if (value != null && value !== '' && typeof value !== 'string') {
      throw new LlmError('validation_failed', `${field} 必须是字符串或空值`, {
        details: { field: `llm.${field}` },
      });
    }
  }

  let providers;
  try {
    providers = (await listProviders(gateway)).items;
  } catch {
    throw new LlmError(
      'llm_catalog_unavailable',
      'LiteLLM 模型目录不可用；请先启用或修复可选 LiteLLM profile 后再开户',
      { httpStatus: 503 },
    );
  }
  const provider = providers.find((item) => item.id === provider_id);
  if (!provider) {
    throw new LlmError('validation_failed', '所选 LiteLLM credential 不存在', {
      details: { field: 'llm.provider_id' },
    });
  }
  const select = (slotName, id, expectedType, requireToolCalling = false) => {
    if (id == null || id === '') return null;
    const model = provider.models.find((item) => String(modelId(item)) === id);
    if (!model) {
      throw new LlmError('validation_failed', `${slotName} 模型不存在或不属于所选 provider`, {
        details: { field: `llm.${slotName}`, model_id: id },
      });
    }
    return validateSlotModel(model, {
      slotName: `llm.${slotName}`,
      modelId: id,
      providerId: provider_id,
      expectedType,
      requireToolCalling,
    });
  };
  select('main_model_id', main_model_id, 'text', true);
  select('embedding_model_id', embedding_model_id, 'embedding');
  select('vision_model_id', vision_model_id, 'vision');
  return {
    provider_id,
    main_model_id,
    embedding_model_id: embedding_model_id || null,
    vision_model_id: vision_model_id || null,
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
  return toProviderMutationResult(result, { name: name.trim(), info, values });
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
    values = { api_base: base_url };
  }
  const body = {
    credential_info: credential_info ?? {},
    ...(values === undefined ? {} : { credential_values: values }),
  };
  const result = await client.updateCredential(name, body);
  return toProviderMutationResult(result, { name, info: body.credential_info, values });
}

export async function deleteProvider(gateway, name) {
  return getGatewayClient(gateway).deleteCredential(name);
}

function validateMaxTokens(value) {
  if (value === undefined || value === null) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new LlmError('validation_failed', 'max_tokens 必须为正整数', { details: { field: 'max_tokens' } });
  }
}

/**
 * Validate a per-token USD rate. `undefined` means "leave unchanged"; `null` means "clear";
 * a finite non-negative number sets the rate. Units are USD per token, matching LiteLLM's
 * `input_cost_per_token` / `output_cost_per_token`.
 */
function validateCost(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new LlmError('validation_failed', `${field} 必须为非负数字（USD / token）`, { details: { field } });
  }
  return value;
}

export async function createModel(gateway, input = {}) {
  const client = getGatewayClient(gateway);
  validateMaxTokens(input.max_tokens);
  const inputCost = validateCost(input.input_cost_per_token, 'input_cost_per_token');
  const outputCost = validateCost(input.output_cost_per_token, 'output_cost_per_token');
  const modelName = input.model_name ?? input.model_id;
  if (typeof modelName !== 'string' || !modelName.trim()) {
    throw new LlmError('validation_failed', 'model_id 为必填字段', { details: { field: 'model_id' } });
  }
  const upstreamModel = input.model ?? input.litellm_params?.model;
  if (typeof upstreamModel !== 'string' || !upstreamModel.trim()) {
    throw new LlmError('validation_failed', 'model 为必填字段', { details: { field: 'model' } });
  }
  const params = input.litellm_params == null
    ? { model: upstreamModel.trim(), litellm_credential_name: input.provider_id }
    : { ...input.litellm_params, model: upstreamModel.trim() };
  if (input.max_tokens === null) delete params.max_tokens;
  else if (input.max_tokens !== undefined) params.max_tokens = input.max_tokens;
  // Pricing belongs on litellm_params (LiteLLM strips pricing echoed back in model_info).
  if (inputCost !== null) params.input_cost_per_token = inputCost;
  if (outputCost !== null) params.output_cost_per_token = outputCost;
  const suppliedInfo = input.model_info ?? {};
  const metadata = {
    ...(suppliedInfo.metadata ?? {}),
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.tool_calling === undefined ? {} : { tool_calling: input.tool_calling === true }),
    ...(input.context_window === undefined ? {} : { context_window: input.context_window }),
  };
  const model_info = {
    ...suppliedInfo,
    mode: typeToMode(input.type),
    ...(input.name === undefined ? {} : { display_name: input.name }),
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.tool_calling === undefined ? {} : { tool_calling: input.tool_calling === true }),
    ...(input.context_window === undefined ? {} : { context_window: input.context_window }),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
  const normalizedModelName = modelName.trim();
  const existingIds = new Set(
    gatewayModels(await client.listModels())
      .map(modelId)
      .filter((id) => id != null)
      .map(String),
  );
  try {
    return await client.createModel({
      model_name: normalizedModelName,
      litellm_params: params,
      model_info,
    });
  } catch (createError) {
    try {
      const modelsAfterFailure = gatewayModels(await client.listModels());
      const newlyAddedModels = modelsAfterFailure.filter((model) => {
        const id = modelId(model);
        return model?.model_name === normalizedModelName
          && id != null
          && !existingIds.has(String(id));
      });
      for (const model of newlyAddedModels) {
        const id = modelId(model);
        try {
          await client.deleteModel(id);
        } catch (rollbackError) {
          console.error('[llm] LiteLLM model create rollback failed', {
            model_id: id,
            status: rollbackError?.status ?? null,
          });
        }
      }
    } catch (rollbackError) {
      console.error('[llm] LiteLLM model create rollback failed', {
        stage: 'list_models',
        status: rollbackError?.status ?? null,
      });
    }
    throw createError;
  }
}

async function findGatewayModel(client, id) {
  const models = gatewayModels(await client.listModels());
  const found = models.find((model) => String(modelId(model)) === String(id));
  if (!found) throw new LlmError('not_found', 'model not found', { httpStatus: 404 });
  return found;
}

// #296: `name` maps to `model_info.display_name` only — it never rewrites the data-plane
// `model_name` that fde_llm_bindings.*_model_name and the virtual key allow-list refer to.
export async function updateModel(gateway, id, {
  name, type, enabled, tool_calling, context_window, max_tokens, model,
  input_cost_per_token, output_cost_per_token,
} = {}) {
  const client = getGatewayClient(gateway);
  validateMaxTokens(max_tokens);
  const inputCost = validateCost(input_cost_per_token, 'input_cost_per_token');
  const outputCost = validateCost(output_cost_per_token, 'output_cost_per_token');
  const pricingTouched = input_cost_per_token !== undefined || output_cost_per_token !== undefined;
  let upstreamModel;
  if (model !== undefined) {
    if (typeof model !== 'string') {
      throw new LlmError('validation_failed', 'model 必须为字符串', { details: { field: 'model' } });
    }
    upstreamModel = model.trim() || undefined;
  }
  const current = await findGatewayModel(client, id);
  const currentEnabled = !isModelBlocked(current);
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new LlmError('validation_failed', 'enabled 必须为 boolean', { details: { field: 'enabled' } });
  }
  if (enabled !== undefined && enabled !== currentEnabled) {
    if (enabled) await client.unblockModel(id);
    else await client.blockModel(id);
  }
  if (
    name !== undefined
    || type !== undefined
    || tool_calling !== undefined
    || context_window !== undefined
    || max_tokens !== undefined
    || upstreamModel !== undefined
    || pricingTouched
  ) {
    const info = current.model_info ?? {};
    const metadata = { ...(info.metadata ?? {}) };
    if (type !== undefined) metadata.type = type;
    if (tool_calling !== undefined) metadata.tool_calling = tool_calling === true;
    if (context_window !== undefined) metadata.context_window = context_window;
    const update = { model_id: id };
    if (name !== undefined || type !== undefined || tool_calling !== undefined || context_window !== undefined) {
      update.model_info = {
        ...info,
        ...(type === undefined ? {} : { type, mode: typeToMode(type) }),
        ...(name === undefined ? {} : { display_name: name }),
        ...(tool_calling === undefined ? {} : { tool_calling: tool_calling === true }),
        ...(context_window === undefined ? {} : { context_window }),
        metadata,
      };
    }
    if (upstreamModel !== undefined || max_tokens !== undefined || pricingTouched) {
      const params = { ...(current.litellm_params ?? {}) };
      if (upstreamModel !== undefined) params.model = upstreamModel;
      if (max_tokens === null) delete params.max_tokens;
      else if (max_tokens !== undefined) params.max_tokens = max_tokens;
      // Explicit null clears the rate: LiteLLM removes a field that arrives as null from
      // both litellm_params and model_info (NULL_CLEARABLE_LITELLM_PARAMS). Omitting it
      // would instead leave the stored value untouched.
      if (input_cost_per_token === null) params.input_cost_per_token = null;
      else if (inputCost !== null) params.input_cost_per_token = inputCost;
      if (output_cost_per_token === null) params.output_cost_per_token = null;
      else if (outputCost !== null) params.output_cost_per_token = outputCost;
      update.litellm_params = params;
    }
    await client.updateModel(update);
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

/**
 * Data-plane model name drift reconciliation (issue #261014 slice A).
 *
 * Both `fde_llm_bindings.*_model_name` and the per-FDE virtual key's `models` allow-list are
 * snapshots taken at bind time. When LiteLLM's data-plane `model_name` is renamed out-of-band
 * (model_info.id unchanged) both go stale, and every request is then rejected with a misleading
 * `auth` error ("The requested model '…' is not available for this API key").
 *
 * Order matters: widen the key allow-list **first**, then write the DB back. The reverse order
 * produces "DB already says the new name, key allow-list still holds the old one" ⇒ still 403.
 * If `/key/update` fails we do **not** write anything: 宁可继续 403，也不要造出 DB/key 分叉。
 */
const HEARTBEAT_NAME_SLOTS = [
  { slot: 'main', idColumn: 'main_model_id', nameColumn: 'main_model_name' },
  { slot: 'embedding', idColumn: 'embedding_model_id', nameColumn: 'embedding_model_name' },
  { slot: 'vision', idColumn: 'vision_model_id', nameColumn: 'vision_model_name' },
];

/** Single-slot module TTL cache for the gateway `model_info.id → model_name` map. */
const dataPlaneNameCache = { client: null, at: 0, map: null };

function errorStatus(error) {
  return error?.httpStatus ?? error?.status ?? error?.cause?.httpStatus ?? null;
}

function configuredNameSlots(row) {
  return HEARTBEAT_NAME_SLOTS.filter(({ idColumn, nameColumn }) => Boolean(row[idColumn]) && Boolean(row[nameColumn]));
}

/** Reuse the module's own response parsing: gatewayModels() + modelId(), never a second parser. */
async function loadDataPlaneNameMap(client, { listModels }) {
  const payload = listModels ? await listModels() : await client.listModels();
  const map = new Map();
  for (const model of gatewayModels(payload)) {
    const id = modelId(model);
    const name = model?.model_name;
    if (id == null || typeof name !== 'string' || name.length === 0) continue;
    map.set(String(id), name);
  }
  return map;
}

async function dataPlaneNameMap(client, { now, ttlMs, listModels }) {
  const at = now();
  if (ttlMs > 0 && dataPlaneNameCache.client === client && dataPlaneNameCache.map
    && at - dataPlaneNameCache.at <= ttlMs) {
    return dataPlaneNameCache.map;
  }
  const map = await loadDataPlaneNameMap(client, { listModels });
  dataPlaneNameCache.client = client;
  dataPlaneNameCache.at = at;
  dataPlaneNameCache.map = map;
  return map;
}

/**
 * @returns {Promise<Record<string, string>>} slot → data-plane name to send downstream
 *          (the new name only for slots that were fully reconciled, the stored name otherwise).
 */
async function reconcileHeartbeatNames(pool, userId, row, client, { now, ttlMs, listModels, updateKey }) {
  const slots = configuredNameSlots(row);
  const effective = Object.fromEntries(slots.map(({ slot, nameColumn }) => [slot, row[nameColumn]]));
  let map;
  try {
    map = await dataPlaneNameMap(client, { now, ttlMs, listModels });
  } catch (error) {
    // Gateway is unreachable: the heartbeat path must not be dragged down by gateway flapping.
    console.warn('[llm] binding model name reconcile skipped', {
      fde_id: userId, reason: 'model_list_unavailable', error_status: errorStatus(error),
    });
    return effective;
  }

  const drifts = [];
  for (const { slot, idColumn, nameColumn } of slots) {
    const current = map.get(String(row[idColumn]));
    if (current == null) {
      // Slice A stays silent-fail on purpose: this is the heartbeat path, so throwing only hits
      // agentd, never the user. The user-visible fail-fast lives in slice B's message precheck.
      console.warn('[llm] binding model name reconcile skipped', {
        fde_id: userId, slot, reason: 'unknown_model_id', model_id: String(row[idColumn]),
      });
      continue;
    }
    if (current !== row[nameColumn]) drifts.push({ slot, nameColumn, from: row[nameColumn], to: current });
  }
  if (drifts.length === 0) return effective;

  // Keep the old names in the allow-list: dropping them is not required to fix the 403 and would
  // risk rejecting in-flight traffic that still carries the stale name.
  const allowModels = [...new Set([...slots.map(({ nameColumn }) => row[nameColumn]), ...drifts.map((d) => d.to)])];
  const writeAllowList = updateKey ? (body) => updateKey(body) : (body) => client.updateKey(body);
  try {
    await writeAllowList({ key: row.api_key, models: allowModels });
  } catch (error) {
    console.warn('[llm] binding model name reconcile failed', {
      fde_id: userId, slots: drifts.map((d) => d.slot), error_status: errorStatus(error),
    });
    return effective;
  }

  const params = [userId, ...drifts.map((d) => d.to)];
  const setClauses = drifts.map((d, index) => `${d.nameColumn} = $${index + 2}`);
  try {
    await pool.query(
      `UPDATE fde_llm_bindings SET ${setClauses.join(', ')}, updated_at = now()
        WHERE fde_id = $1 AND state = 'active'`,
      params,
    );
  } catch (error) {
    // The allow-list now accepts both names, so keeping the old name downstream stays servable.
    console.warn('[llm] binding model name reconcile failed', {
      fde_id: userId, slots: drifts.map((d) => d.slot), reason: 'binding_update_failed', error_status: errorStatus(error),
    });
    return effective;
  }

  for (const drift of drifts) effective[drift.slot] = drift.to;
  return effective;
}

/** Model ids are LiteLLM model_info.id strings and need no join to a Station-owned catalog. */
export async function getFdeLlmHeartbeatModels(pool, userId, opts = {}) {
  const r = await pool.query(
    `SELECT main_model_id, main_model_name,
            embedding_model_id, embedding_model_name,
            vision_model_id, vision_model_name,
            api_key
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
  // Backward compatibility: without an injected gateway client nothing is reconciled, so the
  // heartbeat keeps returning exactly the stored snapshot (internal.js behaviour is unchanged).
  const { gateway = null, now = Date.now, ttlMs = 60_000, listModels = null, updateKey = null } = opts ?? {};
  let names = null;
  if (gateway) {
    names = await reconcileHeartbeatNames(pool, userId, row, getGatewayClient(gateway), { now, ttlMs, listModels, updateKey });
  }
  const nameFor = (slot, stored) => names?.[slot] ?? stored;
  const models = { main: { model: nameFor('main', row.main_model_name), type: 'text' } };
  if (row.embedding_model_id) {
    models.embedding = { model: nameFor('embedding', row.embedding_model_name), type: 'embedding' };
  }
  if (row.vision_model_id) {
    models.vision = { model: nameFor('vision', row.vision_model_name), type: 'vision' };
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

function selectedModelNames(selectedModels) {
  return [...new Set([selectedModels.main, selectedModels.embedding, selectedModels.vision]
    .filter(Boolean)
    .map((model) => model.model_name)
    .filter((name) => typeof name === 'string' && name.length > 0))];
}

function isMissingGatewayKeyError(error) {
  const message = [error?.upstreamMessage, error?.message, error?.code]
    .filter((value) => typeof value === 'string')
    .join(' ');
  return /(?:\b(?:virtual\s+)?key\b|\btoken\b).{0,80}\b(?:not found|does not exist|doesn't exist|not exist|unknown|missing|not present|could not be found|cannot be found)\b|\b(?:not found|does not exist|doesn't exist|not exist|unknown|missing|not present|could not be found|cannot be found).{0,80}\b(?:key|token)\b|\bno (?:such )?(?:virtual )?key\b/i.test(message);
}

async function generateFdeKey(client, { fdeId, fdeName, gatewayUserId, selectedModels }) {
  const userId = gatewayUserId || await ensureGatewayUser(client, { fdeName, userId: fdeId });
  const result = await client.generateKey({
    models: selectedModelNames(selectedModels),
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
 * Save a binding and reconcile its model-restricted virtual key. `api_key` is no
 * longer an upstream credential; upstream secrets belong to LiteLLM credentials.
 */
export async function setFdeLlmConfig(pool, {
  actorId = null, fdeName, provider_id, api_key, main_model_id, embedding_model_id = null, vision_model_id = null,
  force = false, allowAwaitingCredential = false, onlyIfMissing = false, gateway,
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
  let selected;
  if (!onlyIfMissing) {
    selected = await selectGatewayModels(gatewayClient, {
      providerId: provider_id, mainModelId: main_model_id, embeddingModelId: embedding_model_id, visionModelId: vision_model_id,
    });
  }
  const client = await pool.connect();
  let oldKey = null;
  let oldWasGatewayKey = false;
  let generated = null;
  let updatedExistingKey = false;
  let oldKeyMissing = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`llm-binding:${fdeName}`]);
    const statusFilter = allowAwaitingCredential
      ? `status IN ('active', 'awaiting_credential')`
      : `status = 'active'`;
    const u = await client.query(`SELECT id, fde_name FROM users WHERE fde_name = $1 AND ${statusFilter}`, [fdeName]);
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
    if (onlyIfMissing && current?.state === 'active') {
      await client.query('COMMIT');
      return { skipped: true };
    }
    selected ??= await selectGatewayModels(gatewayClient, {
      providerId: provider_id, mainModelId: main_model_id, embeddingModelId: embedding_model_id, visionModelId: vision_model_id,
    });
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
          '该 FDE 有进行中的 run：更改模型白名单会在 run 执行中途生效，影响后续请求。确认无影响请带 force=true 重试。',
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

    oldKey = current?.api_key ?? null;
    oldWasGatewayKey = current?.gateway === 'litellm' && oldKey !== null;
    if (current?.state === 'active' && current.gateway === 'litellm'
      && typeof current.api_key === 'string' && current.api_key.length > 0) {
      try {
        await gatewayClient.updateKey({
          key: current.api_key,
          models: selectedModelNames(selected),
        });
        generated = {
          gatewayUserId: current.gateway_user_id ?? null,
          apiKey: current.api_key,
          keyId: current.key_id ?? null,
          keyAlias: current.key_alias,
        };
        updatedExistingKey = true;
      } catch (err) {
        if (!isMissingGatewayKeyError(err)) throw err;
        oldKeyMissing = true;
        oldKey = null;
      }
    }
    if (!updatedExistingKey) {
      generated = await generateFdeKey(gatewayClient, {
        fdeId: userId,
        fdeName,
        gatewayUserId: current?.gateway_user_id ?? null,
        selectedModels: selected,
      });
    }
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
          selected.vision ? modelId(selected.vision) : null, selected.vision?.model_name ?? null,
          oldWasGatewayKey && !updatedExistingKey],
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
        virtual_key_action: updatedExistingKey ? 'allowlist_updated' : (oldWasGatewayKey ? 'rotated' : 'created'),
        virtual_key_rotated: oldWasGatewayKey && !updatedExistingKey,
      })],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (generated?.apiKey && !updatedExistingKey) {
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

  if (oldWasGatewayKey && oldKey && !oldKeyMissing && oldKey !== generated.apiKey) {
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
