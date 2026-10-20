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
  constructor(code, message, { httpStatus = 400, details, retryable = false } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    // issue #261014 切片 B2：调用方（http.js 的 LlmError 分支）据此填 `error.retryable`。
    // 缺省 false ⇒ 既有 LlmError 的响应面逐字节不变。
    this.retryable = retryable;
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

/**
 * #309 切片 1.5（决策者定稿）：`max_output_tokens` 的**回退值** = `floor(context_window / 4)`。
 *
 * 为什么要回退（issue #309 的根因）：erix-agent 0.20.0 要 `contextWindowTokens` **和**
 * `maxOutputTokens` 同时到位才推得出 `budgetTokens`（压缩总开关），缺任一 ⇒ 压缩与单轮聚合输出
 * 预算一起关闭 ⇒ 长会话无压缩一路涨到 `ContextWindowExceededError`，run `failed`。而「从来没在
 * 门户手填过这个数」才是存量模型的常态，所以**缺元数据不再等于关压缩**：门户总会算出一个生效值
 * 并下发，引擎的压缩开关因此默认是开的。⚠ **三种**还关着压缩的情形（#317：原文写的「唯一一种」不对）：
 * ① 连 `context_window` 都没配；② 窗口形态 runner 不认（真小数 / `≤0` / 非数字 ⇒ `positiveIntOrNull()`
 * 判不可得 ⇒ 回退也算不出，口径见 `runner/lib/llm-models.js`）；③ 窗口小到 1/4 兜底仍算不出正预算
 * （`ctx ≤ 2666`，那道闸在 runner，见 `AGENTS.md` §8.31）。前两种上游的 `model_metadata_missing`
 * 诊断事件照发，就是它的告警。
 *
 * 1/4 这个数不是随手取的：**它恰好等于门户手填时的硬上限**（`validateMaxOutputTokens()` 里同为
 * `floor(window / 4)`）⇒ 平台自己永远不会造出一个被自己校验拒掉的值，回退算出来的数再提交回去也
 * 合法（同一条 `positiveIntOrNull()` 判据、同一个 `Math.floor`）——「1/4 既是上限又是回退」的
 * 一致性依据就是这条，两处若要改数必须一起改。
 *
 * 决策者明确否决了「区分配置值 vs 假定值」的字段拆分（原话：这有什么关系呢，不管怎么来的，有个
 * 数字就行）⇒ **不加** `effective_max_output_tokens` / `max_output_tokens_source` 之类的字段，
 * 门户 DTO、表单、心跳下行始终只有 `max_output_tokens` 这一列数字。
 */
function maxOutputTokensFallback(contextWindow) {
  // 窗口判据复用现成的 positiveIntOrNull()（函数声明提升 ⇒ 可前向引用），不另写一份：
  // 真小数 / 0 / 负数 / 非数字串一律算「窗口不可得」⇒ 交回 null，绝不硬算出 0 或 NaN 下发（#316：
  // 这里算得出而 runner 不认 = 压缩静默关）；历史上存成数字串的窗口（"128000"）照样能算。
  const window = positiveIntOrNull(contextWindow);
  return window === null ? null : Math.floor(window / 4);
}

/**
 * 读侧**生效值**：四级回退链（切片 1.5 定稿的最终形态）
 *   1. `model_info.max_output_tokens`            —— 上游 LiteLLM 配了什么就是什么（权威位）
 *   2. `litellm_params.max_tokens`               —— 同上（今天真正被网关注进请求体的那个）
 *   3. `floor(正数 context_window / 4)`           —— 都没配 ⇒ 按窗口的 1/4 假定
 *   4. `null`                                     —— 连 `context_window` 都没有 ⇒ 真的没有
 *
 * 回退到 `litellm_params.max_tokens`（第 2 级）是**刻意的**：写侧两者绑死同值，而存量模型只有
 * 后者，不回退就会把已经配好的模型显示成「没配」⇒ 管理员重存一次反而把数据面值改掉。
 * legacy `max_tokens` 字段自身的语义**一字未改**：这里只读它，不写它。
 */
function effectiveMaxOutputTokens({ info, params, contextWindow }) {
  return info.max_output_tokens ?? params.max_tokens ?? maxOutputTokensFallback(contextWindow) ?? null;
}

function toModel(model) {
  const id = modelId(model);
  const modelName = model?.model_name ?? '';
  const params = model?.litellm_params ?? {};
  const info = model?.model_info ?? {};
  const metadata = info.metadata ?? {};
  const type = modelType(model);
  // 口径沿用切片 1 那一行（`model_info.context_window` 优先，历史值可能落在 `metadata.context_window`）
  // ⇒ 回退值与门户显示的窗口**必然同源**，不会出现「显示 200000 却按别的数算预算」。
  const contextWindow = info.context_window ?? metadata.context_window ?? null;
  return {
    id,
    provider_id: modelCredentialName(model),
    model_id: id,
    model_name: modelName,
    name: info.display_name ?? metadata.display_name ?? modelName,
    type,
    tool_calling: modelToolCalling(model),
    context_window: contextWindow,
    max_tokens: params.max_tokens ?? null,
    // issue #309 切片 1：模型「单次响应输出预算上限」的权威位是 `model_info.max_output_tokens`；
    // 切片 1.5 补上后两级回退（`floor(正数 ctx/4)` → `null`）⇒ 存量未配的模型也拿得到一个数。
    // 值与心跳下行是**同一个 toModel() 生效值**（`indexGatewayModels()` 直接吃 toModel 的产物），
    // 别在别处再算一次除法。
    max_output_tokens: effectiveMaxOutputTokens({ info, params, contextWindow }),
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
 * issue #318：门户**写侧**的上下文窗口硬下限（与 `validateMaxOutputTokens()` 的 1/4 上限并列）。
 *
 * ⚠ **定性：这是产品约束，不是引擎安全必需**（与 1/4 上限同一条定性，别当安全不变量）。
 * 引擎唯一的致命判据是「压缩预算非正」（`erix-agent/src/compact/budget.js`：
 * `ctx − maxOut − max(2000, ⌈10%·ctx⌉) ≤ 0` ⇒ `KitError invalid_budget`）。
 * `ctx=32768 / maxOut=8192` 的预算约 **21,507**——引擎**跑得动**，我们拒它是产品决定。
 * 真正兜住致命面的仍然是 runner 那道上游闸（带外配置根本不经过门户写侧，#309 切片 2b）。
 *
 * 为什么恰好是 65,536（2026-10-20 dev 栈实测，不是估的；**下一个人要改这个数请先看这三个数**）：
 *   * 固定前缀（系统提示词 + 工具定义，实测 `usage.cacheRead`）≈ **3,328 tokens**；
 *   * 一个「只回两个字」的最省单轮回回来回 = **3,829–4,404 tokens**；
 *   * 近 7 天 35 条终态 run 的单 run 输入：**平均 27,641 / 最小 3,555 / 最大 257,207**。
 * ⇒ 64 Ki ≈ 16 个最省的来回、≈ 平均单 run 用量的 **2.3 倍**；**32 Ki 只有 1.2 倍**（约第 8 个来回起
 * 就开始反复压缩）。引擎「预算非正」的临界在 `ctx ≤ 2666`——那条才是致命线，64k 是**产品地板**。
 *
 * 病症（#318）：管理员把窗口手滑配成 2048、输出上限留空 ⇒ 门户**保存成功、零提示**，而 runner 的
 * 上游闸把整对元数据不发给引擎 ⇒ **压缩静默关闭**（界面上看不见，只有 runner 一条 warn）。
 * 有了这条下限，`ctx ≤ 2666` 那个死区**在门户里根本进不来**，不需要额外的提示逻辑。
 */
export const CONTEXT_WINDOW_MIN = 65_536;

/**
 * issue #318 + #325：`context_window` 的写侧校验。**三态**与其它字段同口径：
 *   * `undefined`（PATCH 没带这个键）⇒ 不校验、不改写；
 *   * `null` ⇒ 「没配窗口」（既有口径，读侧退到 `floor(ctx/4)` 也算不出 ⇒ `context_window_missing`）⇒
 *     不设下限（#318 正文第 3 条：缺窗口是另一条既有口径，本单不收紧它）；
 *   * 其它值 ⇒ ① **形态可得**（唯一判据 `positiveIntOrNull()`，#316/#325）② **`>= CONTEXT_WINDOW_MIN`**，
 *     否则 `400 validation_failed` + `details={field:'context_window', reason:'too_small'|'not_positive_integer', min, value}`
 *     ——**零新错误码**（§8.20），细分只靠 `details.reason`。
 *
 * ⚠ **返回值是归一后的 number**（#325）：调用方一律写这个返回值给网关，**不写原值**——今天写侧是
 * 原样透传（带外 `PATCH {"context_window":"262144"}` 网关就存成字符串 `'262144'`），于是脏形态会永久
 * 留在目录里。校验不过 ⇒ 抛错，**在发网关请求之前**返回（与 #296 的 `model_name_conflict` 同形状，
 * 网关零部分写入）。
 *
 * @returns {number|null|undefined} 归一后的窗口值（`undefined` = 本次不改，`null` = 清空/没配）
 */
function validateContextWindow(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const window = positiveIntOrNull(value);
  if (window === null) {
    throw new LlmError('validation_failed', `上下文窗口必须是正整数（传入 ${value}）`, {
      details: { field: 'context_window', reason: 'not_positive_integer', min: CONTEXT_WINDOW_MIN, value },
    });
  }
  if (window < CONTEXT_WINDOW_MIN) {
    throw new LlmError('validation_failed',
      `上下文窗口不能低于 ${CONTEXT_WINDOW_MIN}（传入 ${value}）。低于此值平台算不出正的压缩预算` +
      '（`窗口 − 输出上限 − max(2000, 10%×窗口)`），压缩会静默关闭', {
      details: { field: 'context_window', reason: 'too_small', min: CONTEXT_WINDOW_MIN, value },
    });
  }
  return window;
}

/**
 * issue #316：**token 数的唯一形态判据 = 正整数**，与 `runner/lib/llm-models.js` 的 `positiveIntOrNull()`
 * 是**同一条规则**（镜像测试在对面：`portal/test/llm.test.js` ↔ `runner/test/llm-models.test.js`）：
 *   * **数字串**（`"262144"`、带空白的 `" 262144 "`、`"262144.0"`、`"1e3"`）与**整值浮点** → **归一成正整数**（返回 `number`）；
 *   * **真小数**（`262144.5`）/ `≤ 0` / `NaN` / `Infinity` / 非数字串 / 布尔 / 对象 → `null` = **不可得**。
 *     ⚠ 判不可得**不是**取整、**不是**兜底成 0：`262144.5` 是配错，floor 是在替管理员编一个他没填的数。
 *
 * 旧名字 `positiveNumberOrNull()` 写着「正数」、判据也确实只要求「正数」（注释原话「兼容历史上存成
 * 数字串的值」），于是 `262144.5` 这类值能在门户算出一个回退值、而 runner 不认它 ⇒
 * **门户显示着窗口、压缩静默关**（#316 的病症）。今天起「窗口可得」与「runner 能算出预算」是同一件事。
 *
 * 影响面（工单 feat-261019-06 定稿）：读侧的**生效值**（`effectiveMaxOutputTokens()` 的第三级回退）与
 * **心跳下行的取值**（`attachHeartbeatModelMetadata()`）。写侧的 1/4 硬上限本身（`≤ floor(ctx/4)`、
 * `model_info`/`litellm_params` 双写、`validation_failed`）**一字未动**，只是它读「窗口」用的就是这
 * 唯一一条判据（不另写一份 ⇒「1/4 既是上限又是回退」的同源性仍成立；真小数窗口现在在写侧也算
 * 「没窗口」⇒ `context_window_missing`，那是同一个口径的必然结果，不是放宽也不是收紧上限）。
 */
function positiveIntOrNull(value) {
  let raw = value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    raw = Number(trimmed);
  }
  return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
}

/**
 * issue #309 切片 1：`max_output_tokens`（引擎侧单次 `generate_response` 的**输出预算上限**）。
 *
 * 三态与 `max_tokens`/定价同一口径：`undefined` = 不动、`null` = 清空、正整数 = 设定。
 *
 * 硬上限（决策者定稿）：**不得超过 `context_window` 的 1/4**。⚠ **它的定性是「产品约束」，
 * 不是「引擎安全的必需条件」**（2026-10-20 独立审计判过我们原来的措辞过度，按它改口）：
 *  1. 引擎真正的致命判据只有 `ctx - max(2000, ⌈10%·ctx⌉) - maxOutputTokens ≤ 0` ⇒ 抛
 *     `KitError code=invalid_budget`（`retryable=false`，实测文案 `Computed context budget must be
 *     positive (got -71)`，`src/compact/budget.js:23-25`，调用点 `src/loop/orchestrator.js:1141-1148`
 *     **没有 try/catch** ⇒ 第 1 轮之前就死，且错误现场只指向引擎、不指向门户那个输入框）。
 *  2. 本上限比那条临界**更严**（`ctx=262144`：临界 ≈235928，1/4 = 65536）⇒ 它会拒掉**引擎其实跑得动**
 *     的值（同一个例子填 `200000`：预算 35929 为正、能跑，只是几乎每轮都在压缩）。所以「不拦就会启动即死」
 *     只对**超过临界**的值成立，对「超过 1/4 但未超临界」的值不成立 —— 别拿它当安全不变量。
 *  3. 而且**带外配置根本不经过这里**（直接在 LiteLLM 上改的数、历史存量）⇒ 真正兜住致命面的是
 *     runner 侧那道注入的上游闸（切片 2b，`runner/lib/llm-models.js`），不是这条写侧校验。
 * 留着的理由是**产品性的**（决策者 #309 原话：1/4 是管理员能心算的数，不必先去翻预算公式；同时给输入
 * 留出窗口空间）。**要改这个比例得过决策者**，不要以「引擎兜得住」为理由自行放宽或拆掉。
 *
 * 零新错误码（§8.20）：一律 `validation_failed`，细分靠 `details.field` / `details.reason`。
 *
 * ⚠ **它读「窗口」只走 `positiveIntOrNull()`（#316），且它拿到的窗口已是 `validateContextWindow()` 的归一结果。**
 * 返回值是给写侧用的**归一后正整数**（#325：落库写归一结果、不写调用方原值）。本函数的入口闸仍比
 * `positiveIntOrNull()` **更严**（数字串 `"2000"` 今天照旧拒，`#309` 既有用例钉着）⇒ 这一步归一对本字段是
 * 恒等的，保留它的理由是「写侧永远不拿原值」这条形状不变量，而不是为了兼容数字串。
 */
function validateMaxOutputTokens(value, contextWindow) {
  if (value === undefined || value === null) return value;
  if (!Number.isInteger(value) || value < 1) {
    throw new LlmError('validation_failed', 'max_output_tokens 必须为正整数', {
      details: { field: 'max_output_tokens' },
    });
  }
  const window = positiveIntOrNull(contextWindow);
  if (window === null) {
    // 没窗口就判不了 1/4 ⇒ 不能只改一半：放行了就是一个「配了预算却没配窗口」的半套配置落库，
    // 而且这个值能否成立根本无法审计。
    throw new LlmError('validation_failed', '设置 max_output_tokens 前必须先配置 context_window'
      + '（或窗口形态非法：token 数必须是正整数，真小数按未配置处理）', {
      details: { field: 'max_output_tokens', reason: 'context_window_missing' },
    });
  }
  const maxAllowed = Math.floor(window / 4);
  if (value > maxAllowed) {
    throw new LlmError(
      'validation_failed',
      `max_output_tokens 不能超过上限 = context_window 的 1/4（context_window=${window} ⇒ 上限 ${maxAllowed}，传入 ${value}）`,
      { details: { field: 'max_output_tokens', max_allowed: maxAllowed, context_window: window } },
    );
  }
  // #325：归一后才是**落库的值**（本函数的入口闸已保证它是正整数 ⇒ 这里是恒等归一，但写侧不再拿原值）。
  return positiveIntOrNull(value);
}

/**
 * #309 定稿：`max_output_tokens` 与 `litellm_params.max_tokens` **绑死同值**（一处写、两处落）。
 *
 * 为什么必须双写——与 #296 的 `call_name`/`name`「各写各的」结论**相反**：本字段是**数据面参数**
 * 而不是展示元数据。`litellm_params.max_tokens` 是「调用方没发 `max_tokens` 时由 LiteLLM 注入给
 * 上游的那个值」（#309 事故里那个 131072 就是这么来的）；只写
 * `model_info.max_output_tokens` 就是「门户显示 2000、数据面仍旧默认值」的第二套真相源
 * （#296 拆的正是这类坑）。反过来只写 `litellm_params.max_tokens` 则门户列表与心跳下行
 * 没有权威可读。所以：**设定同值双写、清空一起清**，不存在「只改了一处」的中间态。
 *
 * 写入顺序上的约定：本函数**必须在 legacy `max_tokens` 处理之后调用**，同一次请求里两个字段
 * 都传时以绑定字段为准（不留半套）。`isCreate`：新建无旧值可清，`null` 就是不写该键。
 *
 * 为什么今天还要留着 `litellm_params.max_tokens`（切片 1.5 补的口径）：自 #309 切片 2 起 runner
 * 会在请求体里**显式**发 `max_tokens`，所以网关这份 `litellm_params.max_tokens` 已经**不再是引擎
 * 取值的来源**，它退化为「非平台调用方」的兜底 —— FDE 自己 curl 这个 endpoint、或在网关 UI 里
 * 试跑，都不会带 `max_tokens`，靠的就是它。**保留它的理由是这个，不是「引擎读它」**。
 */
function applyMaxOutputTokensWrite(params, modelInfo, value, { isCreate }) {
  if (value === undefined) return;
  if (value === null) {
    // 显式 null 是**门户发给网关的请求形状**里的清空语义（NULL_CLEARABLE_LITELLM_PARAMS 会从
    // litellm_params 与 model_info 两处移除）；params 侧用 delete，两边一起消失。
    // ⚠ 但那是**单测里的 fake** 的行为：真 LiteLLM v1.103.2 对 JSON `null` 是**忽略**语义（手工与门户
    // 两条路各实测一次：返 200 但值一字未动，issue #314）⇒ 真网关上今天**清不掉**，这个字段实际
    // 是「只能设值」。本文件保留这条形状（钉的是我们发什么，不是网关做什么）；要改行为就改这里
    // 并同步 portal.md §4.9（口径单一真相），别去把单测改松。
    if (isCreate) delete modelInfo.max_output_tokens;
    else modelInfo.max_output_tokens = null;
    delete params.max_tokens;
    return;
  }
  modelInfo.max_output_tokens = value;
  params.max_tokens = value;
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
  // #318：**次序**——窗口自身的两条判据（形态 + 下限）排在「输出上限 ≤ 窗口 1/4」**之前**。
  // 否则「窗口 1000 + 上限 500」会先报上限错（上限 250），把真正的病因（窗口配错了）藏起来。
  // 与 #325 一起：拿到的就是归一后的 number，下面落库一律用它，**不再拿 `input.context_window` 原值**。
  const contextWindow = validateContextWindow(input.context_window);
  // #309：新建只能拿本次提交的 context_window 判 1/4（没有「现存值」可退）。
  const maxOutputTokens = validateMaxOutputTokens(input.max_output_tokens, contextWindow);
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
    ...(input.context_window === undefined ? {} : { context_window: contextWindow }),
  };
  const model_info = {
    ...suppliedInfo,
    mode: typeToMode(input.type),
    ...(input.name === undefined ? {} : { display_name: input.name }),
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.tool_calling === undefined ? {} : { tool_calling: input.tool_calling === true }),
    ...(input.context_window === undefined ? {} : { context_window: contextWindow }),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
  // #309：绑死双写必须在 legacy `max_tokens` 之后（见 applyMaxOutputTokensWrite）。
  applyMaxOutputTokensWrite(params, model_info, maxOutputTokens, { isCreate: true });
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

/**
 * #296 定稿：模型有两个名字，职责不同，**不得互相顶替**。
 *   * `name` → `model_info.display_name`：**纯展示名**（既有语义，一字未改，兼容面保留）。
 *   * `call_name` → **顶层 `model_name`**：数据面调用名，即 FDE 请求实际发的那个名字
 *     （`fde_llm_bindings.*_model_name` 与 per-FDE 虚拟 key 的 `models` 白名单存的都是它）。
 * 门户改 `call_name` 会真的改数据面 ⇒ 从「只改展示名的误导面」变成**受管改名**，传播走
 * `reconcileDataPlaneNameRename()`（复用 #289 心跳对账那条路径，不另写并集逻辑）。
 */
export async function updateModel(gateway, id, {
  name, call_name, type, enabled, tool_calling, context_window, max_tokens, model,
  max_output_tokens,
  input_cost_per_token, output_cost_per_token,
} = {}) {
  const client = getGatewayClient(gateway);
  validateMaxTokens(max_tokens);
  // #318：**次序与位置**——窗口自身的两条判据（形态 + 下限）既排在「输出上限 ≤ 窗口 1/4」**之前**，
  // 也排在**任何网关请求之前**（PATCH 要读的 `findGatewayModel` 也算请求）⇒ 窗口配错时网关**零请求**、
  // 零部分写入（与 #296 的 `model_name_conflict` 同一个形状）。理由：否则「窗口 1000 + 上限 500」会先报
  // 上限错（上限 250），把真正的病因（窗口配错了）藏起来。
  // #325：拿到的就是归一后的 number ⇒ 下面 `metadata` / `model_info` 一律写它，**不写调用方原值**。
  const contextWindow = validateContextWindow(context_window);
  const inputCost = validateCost(input_cost_per_token, 'input_cost_per_token');
  const outputCost = validateCost(output_cost_per_token, 'output_cost_per_token');
  const pricingTouched = input_cost_per_token !== undefined || output_cost_per_token !== undefined;
  // #296: 调用名非空且 trim 后非空；空串/空白/非字符串一律拒（数据面名不能为空，静默清空更不行）。
  let callName;
  if (call_name !== undefined) {
    if (typeof call_name !== 'string' || call_name.trim() === '') {
      throw new LlmError('validation_failed', 'call_name 必须是非空字符串（数据面调用名）', {
        details: { field: 'call_name' },
      });
    }
    callName = call_name.trim();
  }
  let upstreamModel;
  if (model !== undefined) {
    if (typeof model !== 'string') {
      throw new LlmError('validation_failed', 'model 必须为字符串', { details: { field: 'model' } });
    }
    upstreamModel = model.trim() || undefined;
  }
  const current = await findGatewayModel(client, id);
  // #309：1/4 校验用的**有效** context_window——本次提交的新值优先（同一条 PATCH 里两者都改时
  // 不能拿旧窗口判新预算），否则退到该模型现存的 model_info.context_window（走 toModel，与门户
  // 列表同一个口径，不另取字段）。两者都没有 ⇒ 拒绝，不写半套。
  // ⚠ 本函数在 `validateContextWindow()` **之后**（#318 D2 的次序），且拿的是已归一的窗口值。
  const maxOutputTokens = validateMaxOutputTokens(
    max_output_tokens,
    context_window !== undefined ? contextWindow : toModel(current).context_window,
  );
  // #296 实测：LiteLLM **不拦同名**（两个 deployment 改成同一个 model_name 都返 200），而数据面
  // 按名字选 deployment ⇒ 同名之后同一个名字的请求会在两个 deployment 间轮询（真机探针 5 发
  // 打出 PROBE_B/PROBE_A 交替），且 `GET /v1/models` 只列一个 ⇒ 完全看不出来。故门户必须拦。
  // （改名不动 `model_info.id`，所以只有「别的模型占用同名」才算冲突。）
  if (callName !== undefined && callName !== current.model_name) {
    const conflicting = gatewayModels(await client.listModels())
      .filter((model) => String(modelId(model) ?? '') !== String(modelId(current) ?? ''))
      .find((model) => model?.model_name === callName);
    if (conflicting) {
      throw new LlmError('model_name_conflict', `调用名「${callName}」已被模型 ${modelId(conflicting)} 占用`, {
        httpStatus: 409,
        details: { field: 'call_name', call_name: callName, conflicting_model_id: String(modelId(conflicting)) },
      });
    }
  }
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
    || callName !== undefined
    || type !== undefined
    || tool_calling !== undefined
    || context_window !== undefined
    || max_tokens !== undefined
    || max_output_tokens !== undefined
    || upstreamModel !== undefined
    || pricingTouched
  ) {
    const info = current.model_info ?? {};
    const metadata = { ...(info.metadata ?? {}) };
    if (type !== undefined) metadata.type = type;
    if (tool_calling !== undefined) metadata.tool_calling = tool_calling === true;
    if (context_window !== undefined) metadata.context_window = contextWindow;
    // #296: `call_name` 只进**顶层** `model_name`（数据面）。实测：LiteLLM 改数据面名**不会**
    // 顺手改或清 `model_info.display_name`（探针：改名后 display_name 原值仍在），所以两个字段
    // 可以同一条 PATCH 各写各的。
    const update = { model_id: id, ...(callName === undefined ? {} : { model_name: callName }) };
    if (name !== undefined || type !== undefined || tool_calling !== undefined || context_window !== undefined
      || max_output_tokens !== undefined) {
      update.model_info = {
        ...info,
        ...(type === undefined ? {} : { type, mode: typeToMode(type) }),
        ...(name === undefined ? {} : { display_name: name }),
        ...(tool_calling === undefined ? {} : { tool_calling: tool_calling === true }),
        ...(context_window === undefined ? {} : { context_window: contextWindow }),
        metadata,
      };
    }
    if (upstreamModel !== undefined || max_tokens !== undefined || max_output_tokens !== undefined || pricingTouched) {
      const params = { ...(current.litellm_params ?? {}) };
      if (upstreamModel !== undefined) params.model = upstreamModel;
      if (max_tokens === null) delete params.max_tokens;
      else if (max_tokens !== undefined) params.max_tokens = max_tokens;
      // #309：绑死双写——同一份规则把值落到**两处**：`model_info.max_output_tokens`（权威位，
      // 门户列表与心跳下行读它）与 `litellm_params.max_tokens`（引擎真正送到 provider 的那个），
      // 传 null 则两处一起消失（见 applyMaxOutputTokensWrite 的「为什么与 #296 相反」）。
      // 前提：上面 model_info 块的触发条件已包含 `max_output_tokens !== undefined` ⇒ 这里
      // `update.model_info` 一定存在，不需要再兼容缺失分支。
      if (max_output_tokens !== undefined) {
        applyMaxOutputTokensWrite(params, update.model_info, maxOutputTokens, { isCreate: false });
      }
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

/** Single-slot module TTL cache for the gateway model catalog (name map + per-name metadata). */
const dataPlaneNameCache = { client: null, at: 0, map: null };

function errorStatus(error) {
  return error?.httpStatus ?? error?.status ?? error?.cause?.httpStatus ?? null;
}

function configuredNameSlots(row) {
  return HEARTBEAT_NAME_SLOTS.filter(({ idColumn, nameColumn }) => Boolean(row[idColumn]) && Boolean(row[nameColumn]));
}

/**
 * 一次 `GET /model/info` 同时产出两份索引 ⇒ **只打网关一趟**（缓存只有一份，不能为了元数据再跳一次）：
 *   * `names`：`model_info.id → model_name`（#289 名字漂移除账用）
 *   * `byName`：`model_name → toModel(model)`（#309 切片 1：心跳下行元数据用）
 *
 * `byName` 特意以**数据面名**为键：心跳要带的是「按对账后的新名选中的那个 deployment」的值，
 * 按旧名取会带错部署（改名之后旧名根本不存在或已属于另一个）。
 * 值直接走 `toModel()` ⇒ 与门户模型列表**同一份读侧语义**，不另取字段。
 */
function indexGatewayModels(payload) {
  const names = new Map();
  const byName = new Map();
  for (const model of gatewayModels(payload)) {
    const id = modelId(model);
    const name = model?.model_name;
    if (id == null || typeof name !== 'string' || name.length === 0) continue;
    names.set(String(id), name);
    // 同名多 deployment（LiteLLM 不拦同名，#296 实测）时取目录里第一个：不猜轮询结果，
    // 取确定性的那一份，同一个输入永远得同一个输出。
    if (!byName.has(name)) byName.set(name, toModel(model));
  }
  return { names, byName };
}

/** Reuse the module's own response parsing: gatewayModels() + modelId(), never a second parser. */
async function loadDataPlaneNameMap(client, { listModels }) {
  const payload = listModels ? await listModels() : await client.listModels();
  return indexGatewayModels(payload);
}

/** @returns {Promise<{names: Map<string,string>, byName: Map<string,object>}>} */
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
 * @returns {Promise<{effective: Record<string,string>, byName: Map<string,object>|null}>}
 *          `effective`：slot → 下行用的数据面名（只对账成功的槽位是新名，其余仍是存量）；
 *          `byName`：数据面名 → `toModel()` 视图（#309 心跳元数据），**取不到目录时为 null**。
 */
async function reconcileHeartbeatNames(pool, userId, row, client, { now, ttlMs, listModels, updateKey }) {
  const slots = configuredNameSlots(row);
  const effective = Object.fromEntries(slots.map(({ slot, nameColumn }) => [slot, row[nameColumn]]));
  let index;
  try {
    index = await dataPlaneNameMap(client, { now, ttlMs, listModels });
  } catch (error) {
    // Gateway is unreachable: the heartbeat path must not be dragged down by gateway flapping.
    console.warn('[llm] binding model name reconcile skipped', {
      fde_id: userId, reason: 'model_list_unavailable', error_status: errorStatus(error),
    });
    // 目录拿不到 ⇒ 元数据也无从谈起：交回 null，调用方按「无值」处理（键不出现），不抛错。
    return { effective, byName: null };
  }
  const map = index.names;

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
  if (drifts.length === 0) return { effective, byName: index.byName };

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
    return { effective, byName: index.byName };
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
    return { effective, byName: index.byName };
  }

  for (const drift of drifts) effective[drift.slot] = drift.to;
  return { effective, byName: index.byName };
}

/**
 * #309 切片 1：心跳下行的模型元数据（决策者定稿）。
 *
 * **只在非 null 时带键**：没有值就整个键都不出现，而不是写 `key: null`（runner 切片 2 用「键在不
 * 在」判有无，不解析 null）。#316/#317 之后「没值」是**三种**：① 连 `context_window` 都没配；
 * ② 窗口形态两侧都不认（真小数 / ≤0 / 非数字 ⇒ `positiveIntOrNull()` 判不可得）；③（下行侧不会发生，
 * 但压缩侧会）窗口小到 1/4 兜底仍算不出正预算 ⇒ runner 那道上游闸把整对拦掉——
 * ⚠ 行为变化（有意）：`context_window` 配了但没手填过预算的存量部署，现在会**开始带**
 * `context_window` + `max_output_tokens=ctx/4` 两个键，不再与 #309 之前逐字节相同；而**不传
 * gateway 的老调用形状**一个字节都不变（兼容面，llm.test.js / llm-reconcile.test.js 钉着）。
 * 值直接取 `toModel()` 的生效值 ⇒ **不在心跳里另算一次除法**，回退生效后这里自然带上。
 * 只给 `main`：embedding / vision 的上下文窗口不进 output 预算，切片 1 不下发。
 * 元数据缺席（网关抖动 / 未注入 client / 目录里找不到这个名字）都走同一条「不写键」路径。
 */
function attachHeartbeatModelMetadata(target, model) {
  if (!model) return;
  // #316：下行的是**归一后的正整数**（同一个 positiveIntOrNull）：真小数 / 非数字串算不出就不带键，
  // 而不是把一个 runner 一定会丢掉的值发下去（那正是「门户显示着窗口、runner 丢键 ⇒ 压缩静默关」）。
  const contextWindow = positiveIntOrNull(model.context_window);
  const maxOutputTokens = positiveIntOrNull(model.max_output_tokens);
  if (contextWindow !== null) target.context_window = contextWindow;
  if (maxOutputTokens !== null) target.max_output_tokens = maxOutputTokens;
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
  // #309：数据面名 → 模型元数据（`toModel` 视图）。**只有注了 gateway 才会有**：旧的两参调用形状
  // 不碰网关，也就一个字节都不变（兼容面，llm.test.js / llm-reconcile.test.js 钉着）。
  let metaByName = null;
  if (gateway) {
    const reconciled = await reconcileHeartbeatNames(pool, userId, row, getGatewayClient(gateway), { now, ttlMs, listModels, updateKey });
    names = reconciled.effective;
    metaByName = reconciled.byName;
  }
  const nameFor = (slot, stored) => names?.[slot] ?? stored;
  const mainName = nameFor('main', row.main_model_name);
  const models = { main: { model: mainName, type: 'text' } };
  // #309 切片 1：按**对账后的名字**取同一个 deployment 的元数据（按存量旧名取会在改名后带错部署）。
  attachHeartbeatModelMetadata(models.main, metaByName?.get(mainName) ?? null);
  if (row.embedding_model_id) {
    models.embedding = { model: nameFor('embedding', row.embedding_model_name), type: 'embedding' };
  }
  if (row.vision_model_id) {
    models.vision = { model: nameFor('vision', row.vision_model_name), type: 'vision' };
  }
  return models;
}

/**
 * #296：门户「受管改名」（PATCH `call_name` → 数据面 `model_name`）之后的**立即**对账。
 *
 * 为什么要它：#289 的对账只挂在 U4 心跳上，最坏 ≈15s（心跳）+ 60s（TTL）才铺平；管理员改完名
 * 立刻去试仍会拿到误导性的 auth 403。本函数把同一条对账推到改名后立即发生。
 *
 * **它是复用者，不是第二份实现**：只负责「哪些绑定受影响」这一句 SELECT，动作逐个交给
 * `getFdeLlmHeartbeatModels(...)`——判据、**先 `updateKey` 把白名单扩成新旧名并集、后回写
 * `fde_llm_bindings`** 的顺序、四种保守放行全部沿用 #289。另写一份并集就是第二个会过期的真相源。
 *
 * ⚠ **`gateway` 必须是 `ctx.llmGateway` 单例**（§8.25：`model_list` 映射的 TTL 缓存按 client 对象
 *   身份分槽，现造 client ⇒ 每个受影响绑定多打一次 `GET /model/info`）。
 * 参数位置单独摆 `gateway` 而不是塞进 opts，就是为了让「接线传 null」在 http.js 里显眼可审。
 *
 * 两个刻意的细节：
 *   * 改名前刚跑过的心跳会把**旧名**留在 TTL 缓存里 ⇒ 直接走默认 TTL 会得出「没漂移」的空对账，
 *     所以**第一条**绑定用 `ttlMs: 0` 强制重取映射（顺手把共享缓存刷成新名），其余条走默认 TTL
 *     ⇒ 整次改名**只打一次** `GET /model/info`（有用例钉住）。
 *   * 改名本身已经在 LiteLLM 落定 ⇒ 对账失败**不得**把 PATCH 拖成 500：整体 try/catch，只结构化
 *     warn，最坏退回「心跳 ≤15s+60s 自愈」的旧口径。
 *
 * @returns {Promise<{status: 'reconciled'|'no_bindings'|'skipped', reason?: string, bindings: string[]}>}
 *          可观测汇总（不进响应体，与 #289 切片 B2 同一口径）；本函数**不抛错**。
 */
export async function reconcileDataPlaneNameRename(pool, gateway, modelId, opts = {}) {
  if (!gateway) {
    // 接线缺席（例如没起 LiteLLM profile）：改名照样生效，漂移交心跳。
    return { status: 'skipped', reason: 'no_gateway_client', bindings: [] };
  }
  const { now = Date.now, listModels = null, updateKey = null } = opts ?? {};
  // 谓词逐字同 getFdeLlmHeartbeatModels（active + litellm + 非空虚拟 key），只多一条「哪个槽位引用了这个 id」。
  let affected;
  try {
    affected = await pool.query(
      `SELECT fde_id FROM fde_llm_bindings
        WHERE state = 'active' AND gateway = 'litellm'
          AND api_key IS NOT NULL AND api_key <> ''
          AND ($1 IN (main_model_id, embedding_model_id, vision_model_id))`,
      [String(modelId)],
    );
  } catch (error) {
    console.warn('[llm] rename reconcile skipped', {
      model_id: String(modelId), reason: 'binding_lookup_failed', error_status: errorStatus(error),
    });
    return { status: 'skipped', reason: 'binding_lookup_failed', bindings: [] };
  }
  const rows = affected.rows ?? [];
  if (rows.length === 0) return { status: 'no_bindings', bindings: [] };

  const bindings = [];
  let primed = false;
  for (const row of rows) {
    const fdeId = row.fde_id;
    try {
      // 首跳 ttlMs=0：绕过改名前那份旧映射；后续跳复用刚被刷新的缓存。
      await getFdeLlmHeartbeatModels(pool, fdeId, {
        gateway, now, ttlMs: primed ? 60_000 : 0, listModels, updateKey,
      });
      bindings.push(String(fdeId));
    } catch (error) {
      // getFdeLlmHeartbeatModels 里只有「槽位缺数据面名」会抛（502）；对账本体自己 warn 不抛。
      console.warn('[llm] rename reconcile skipped', {
        model_id: String(modelId), fde_id: fdeId, reason: 'binding_unreconcilable', error_status: errorStatus(error),
      });
    }
    primed = true; // 映射已被强制取过一次（成不成都不再重取）：N 个受影响绑定只打一次网关
  }
  return { status: 'reconciled', bindings };
}

/**
 * 发消息路径的「绑定的模型 id 还在不在网关里」预检（issue #261014 切片 B2）。
 *
 * 为什么需要它：Station 存的是 LiteLLM `model_info.id`。模型被删除/重建 ⇒ **id 变**，
 * 绑定里的 id 成为孤儿。心跳路径（切片 A）对这种情形只 `warn`（`reason: 'unknown_model_id'`，
 * 那里只有 agentd 看得见），用户发消息仍会入队，然后在 run 里撞一个看不懂的错。
 * 本函数把同一判据搬到**发消息**这条路上，变成用户看得见的 409。
 *
 * 口径（与切片 A 的三条保守放行同源，但方向相反：这里是 fail-fast）：
 *   * 只读**活绑定**（谓词逐字同心跳那条 SELECT）；无活绑定 ⇒ 直接放行——「没配 LLM」
 *     是 `409 llm_not_configured`（§4.3）的既有职责，本函数不插它的队。
 *   * **逐个已配置槽位**查 `model_info.id`：命中 ⇒ 过；不命中 ⇒ 抛 `llm_model_not_found`。
 *   * **拿映射本身失败（网关不可达）⇒ 一律放行**：网关抖一下不能让用户发不出消息。
 *   * **只读**：零写库、零 `updateKey`——名字漂移的回写是心跳对账的事（切片 A/B1）。
 *
 * TTL 缓存按 client 对象身份分槽，所以调用方必须复用 `ctx.llmGateway` 单例（同 B1）。
 *
 * @param gateway `ctx.llmGateway` 单例（或任何带 `listModels` 的 client）；缺失 ⇒ 不检（`skipped`）。
 * @param listModels 注入的网关列表替身（测试用，避开真 HTTP）。
 * @returns {Promise<{status: 'pass'|'skipped', reason: string, slots?: string[], error_status?: number|null}>}
 *          可观测标记（不放响应体，只供调用方记日志）；抛错才是失败信号。
 */
export async function assertBindingModelsResolvable(pool, userId, opts = {}) {
  const { gateway = null, now = Date.now, ttlMs = 60_000, listModels = null } = opts ?? {};
  if (!gateway) return { status: 'skipped', reason: 'no_gateway_client' };
  // 谓词逐字同 getFdeLlmHeartbeatModels（active + litellm + 非空虚拟 key）；只读，不加 FOR UPDATE。
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
  // 无活绑定（或旧数据没主模型槽）：交给 `409 llm_not_configured` 说，本预检不拦截。
  if (!row?.main_model_id) return { status: 'pass', reason: 'no_active_binding' };
  const slots = configuredNameSlots(row);
  if (slots.length === 0) return { status: 'pass', reason: 'no_configured_slot' };

  // #309：同一个 TTL 缓存现在携两份索引（`names` + `byName`）——本预检是第二个消费者，
  // 拿的是**同一趟** `GET /model/info`（不因为心跳要元数据就多打一次，用例钉着）。
  let index;
  try {
    index = await dataPlaneNameMap(getGatewayClient(gateway), { now, ttlMs, listModels });
  } catch (error) {
    // fail-open（故意）：网关不可达时用户照常发消息，错误在 run 里由 worker 面报。
    const observed = { status: 'pass', reason: 'model_list_unavailable', error_status: errorStatus(error) };
    console.warn('[llm] message precheck skipped', { fde_id: userId, ...observed });
    return observed;
  }

  for (const { slot, idColumn } of slots) {
    const modelId = String(row[idColumn]);
    if (index.names.has(modelId)) continue;
    throw new LlmError(
      'llm_model_not_found',
      `绑定的${SLOT_LABELS[slot] ?? slot}在 LLM 网关里已不存在（模型 id ${modelId}）：请到管理台 /admin 重新选模型后再发送（无权限请联系管理员）`,
      {
        httpStatus: 409,
        details: { slot, model_id: modelId },
        // 「管理员改配后可重试」：本预检零副作用且不写幂等台账，同 key 原样重试能重新占位（§1.4）；
        // 但盲目立即重试仍是同一码——解法只有一个（改配）。
        retryable: true,
      },
    );
  }
  return { status: 'pass', reason: 'all_slots_resolved', slots: slots.map(({ slot }) => slot) };
}

const SLOT_LABELS = { main: '主模型', embedding: '嵌入模型', vision: '视觉模型' };

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
