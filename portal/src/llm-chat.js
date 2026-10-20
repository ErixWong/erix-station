// portal/src/llm-chat.js —— portal 侧**唯一**的「发一次 OpenAI 兼容 chat/completions」出口
// （issue #315 的追加范围，工单 261020-04）。
//
// 职责边界（三者别混，这是本文件存在的理由）：
//   · `portal/src/llm.js`        = LLM **网关管理面**：LiteLLM 的模型目录 / 凭据 / per-FDE binding 的
//                                  CRUD。它名字像 client，但**不发对话请求**。
//   · `portal/src/llm-chat.js`   = **对话调用面**（本文件）：发一次 `chat/completions` 并取回助手文本。
//                                  不查库、不持配置：provider（base_url / api_key / model）由调用方给。
//   · `runner/lib/llm-timeouts.js` + `runner/lib/session-title.js` = runner 侧自己那一套（**不在本文件
//                                  范围内**，跨路径一致性由 `portal/test/session-ai-title.test.js` 钉住）。
//
// ⇒ **未来 portal 侧任何「直连一次对话」一律走本文件**，不要在调用点再手搓一条 `fetch`。
//
// 为什么要收（#315 的根因，别退回去）：「发一次对话请求」这件事过去在每个调用点各写一遍，
// 各自记参数 ⇒ AI 改名那条**漏发了 `max_tokens`** ⇒ LiteLLM 注入该 deployment 的
// `litellm_params.max_tokens`（**模型级**输出预算，现网 32768）⇒ `context_window` 被配小时
// 上游按「prompt + 预留 32768 输出」判超限 ⇒ 请求被直接拒，症状是「点了 AI 改名没反应」。
// 所以本模块把 **`max_tokens` 必发**做成**结构性保证**而不是约定：请求体只有一个构造点，
// 调用方不给就填显式默认（`LLM_CHAT_DEFAULT_MAX_TOKENS`），且**发出前还有一道断言**——
// 「省掉这个字段」的请求根本发不出去。变异（把字段拿掉）必须让测试变红。
//
// key 纪律（`llm.js` 三条存储纪律 ③）：`api_key` **只**进 `Authorization` 头，**绝不**进
// 返回值 / 日志 / 错误信息（所有对外文本一律过 `redactSecret` 兜底）。
//
// 错误映射（**不新增错误码**，§8.20 口径）：
//   · provider 未配置（缺 base_url / api_key / model）→ `llm_not_configured` / 409
//   · 上游非 2xx、网络错误、超时到点           → `llm_upstream_failed` / 502
//   · 调用方参数非法（messages / max_tokens / timeoutMs）→ `validation_failed` / 400
// 错误实例的**类型**由调用方决定（`ErrorCtor`，缺省 `LlmChatError`）：`sessions.js` 传 `SessionError`，
// 于是 `http.js` 的映射一行都不用改，状态码 / `error.code` / 文案与收口前一致（`details` 是错误体里
// 本就可选的附加结构，只放原因与状态码，`docs/api/portal.md` §4.5a 已同步）。
// ⇒ 错误码只有 `llm_not_configured` / `llm_upstream_failed` / `validation_failed`（+ 不可达的 `internal`
// 兜底断言），**没新增任何一个**。
//
// 离线可测：`fetchImpl` 注入假 fetch，测试不打真模型。

/**
 * 调用方没给 `max_tokens` 时的**显式默认**（#315：绝不允许省略该字段）。
 * 512 与 `sessions.js` 的 `AI_TITLE_MAX_TOKENS`、`runner/lib/session-title.js` 的 `maxTokens: 512`
 * 是同一个数（做同一件事的两条路径必须同一个预算）；一致性由测试钉住，**不要**在这里 import
 * `sessions.js`（那会构成循环依赖，且对话调用面不该反向依赖会话业务）。
 */
export const LLM_CHAT_DEFAULT_MAX_TOKENS = 512;

/** 缺省超时：沿用收口前 `AI_TITLE_TIMEOUT_MS` 的现值（issue #114 定的 ~15s），本单不改数值。 */
export const LLM_CHAT_DEFAULT_TIMEOUT_MS = 15_000;

/** 与 `sessions.SessionError` 同构的错误类（`ErrorCtor` 缺省值；`code` / `httpStatus` / `details`）。 */
export class LlmChatError extends Error {
  constructor(code, message, { httpStatus = 400, details } = {}) {
    super(message);
    this.name = 'LlmChatError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/** OpenAI 兼容 chat/completions URL：base 已带 /v1 则直接用，否则补 /v1（口径同 erix-agent provider）。 */
export function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

/** 从 OpenAI 兼容响应体取助手文本（纯函数）：content 为字符串或分片数组。 */
export function extractAssistantText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

/** 脱敏（纯函数）：从任意文本里抹掉已知 key 与 sk-* 形态串，并截断长度（纪律 ③ 兜底）。 */
export function redactSecret(text, secret) {
  let out = String(text ?? '');
  if (typeof secret === 'string' && secret.length >= 6) out = out.split(secret).join('***');
  out = out.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***');
  return out.slice(0, 200);
}

/** 超时时间的可读形式（进错误文案/日志，绝不含 key）。 */
function timeoutLabel(ms) {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

/** 造错误实例：类型由调用方给（`sessions.js` 传 `SessionError`），构造签名两边一致。 */
function makeError(ErrorCtor, code, message, httpStatus, details) {
  const Ctor = typeof ErrorCtor === 'function' ? ErrorCtor : LlmChatError;
  return new Ctor(code, message, { httpStatus, details });
}

/**
 * `max_tokens` 的解析（纯函数，供单测）：**这就是 #315 的那一条**。
 * 没给（`undefined`/`null`）⇒ 填显式默认；给了但不是正整数 ⇒ 直接 400（不能把「0 / 负数 / 小数」
 * 悄悄发上去，也不能因此省掉字段）。**任何情况下都返回一个正整数**，绝不返回 undefined。
 */
export function resolveMaxTokens(value) {
  if (value === undefined || value === null) return LLM_CHAT_DEFAULT_MAX_TOKENS;
  if (!Number.isInteger(value) || value <= 0) return null; // null = 非法，由调用方转成 validation_failed
  return value;
}

/**
 * 发一次 OpenAI 兼容 `chat/completions`，返回助手文本。**portal 侧直连对话的唯一出口。**
 *
 * @param {object} args
 * @param {{base_url?: string, api_key?: string, model?: string}} args.provider
 *        调用方解析好的 provider（AI 改名用 FDE binding 的 LiteLLM 虚拟 key）。缺任一字段 → 409。
 * @param {Array<{role: string, content: string}>} args.messages OpenAI 形态消息数组（非空）。
 * @param {number} [args.maxTokens] 输出预算。**不给就填 `LLM_CHAT_DEFAULT_MAX_TOKENS`（512）**；
 *        请求体里 `max_tokens` 恒存在（发出前有断言）。
 * @param {number} [args.temperature] 给了才透传（不给就整个字段省略，与收口前口径一致）。
 * @param {boolean} [args.stream=false] 本出口只做一次性非流式往返；`true` 也会照发（调用方自负）。
 * @param {number} [args.timeoutMs=15000] 到点**必然**明确报错（502），不悬挂：竞速用的定时器与
 *        `AbortController` 一起走，即使注入的假 fetch 完全不理会 signal 也拦得住。
 * @param {(url: string, init: object) => Promise<any>} [args.fetchImpl=fetch] 注入点（测试用假 fetch）。
 * @param {Function} [args.ErrorCtor] 错误类型（`sessions.js` 传 `SessionError`）；缺省 `LlmChatError`。
 * @param {object} [args.log=console] 日志器（只用 `warn`；文本一律脱敏后）。
 * @param {string} [args.logTag='llm-chat'] 日志前缀（`sessions.js` 传 `ai-title`，保持运维口径不变）。
 * @param {string} [args.logContext=''] 日志上下文（如 `session=<id>`）。
 * @returns {Promise<{text: string, body: object|null, status: number, url: string, maxTokens: number}>}
 *          `text` 为助手文本（拿不到就是 `''`，由调用方按业务判断）；返回值里**不含 api key**。
 * @throws {LlmChatError|SessionError} 见文件头「错误映射」。
 */
export async function chatCompletion({
  provider, messages, maxTokens, temperature, stream = false,
  timeoutMs = LLM_CHAT_DEFAULT_TIMEOUT_MS, fetchImpl = fetch, ErrorCtor,
  log = console, logTag = 'llm-chat', logContext = '',
} = {}) {
  const ctx = logContext ? `（${logContext}）` : '';
  const fail = (code, message, httpStatus, details) => makeError(ErrorCtor, code, message, httpStatus, details);

  // ── 入参校验：未配置 → 409（口径同收口前 `resolveAiTitleProvider`）；参数非法 → 400 ──
  const apiKey = typeof provider?.api_key === 'string' ? provider.api_key.trim() : '';
  const baseUrl = typeof provider?.base_url === 'string' ? provider.base_url.trim() : '';
  const model = typeof provider?.model === 'string' ? provider.model.trim() : '';
  const missing = [!baseUrl && 'base_url', !apiKey && 'api_key', !model && 'model'].filter(Boolean);
  if (missing.length > 0) {
    // details 只放字段名，**不放 key 的值**。
    throw fail('llm_not_configured',
      `LLM provider 未配置（缺 ${missing.join(' / ')}）：需要一次 LLM 调用的功能请先在管理台配置 LiteLLM 模型`,
      409, { missing });
  }
  if (!Array.isArray(messages) || messages.length === 0 || messages.some((m) => !m || typeof m.role !== 'string')) {
    throw fail('validation_failed', 'messages 必须是 {role, content} 形式的非空数组', 400, { field: 'messages' });
  }
  const maxTokensResolved = resolveMaxTokens(maxTokens);
  if (maxTokensResolved === null) {
    throw fail('validation_failed', `max_tokens 必须是正整数（收到 ${JSON.stringify(maxTokens) ?? String(maxTokens)}）`,
      400, { field: 'max_tokens' });
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw fail('validation_failed', `timeoutMs 必须是正整数毫秒（收到 ${String(timeoutMs)}）`, 400, { field: 'timeoutMs' });
  }
  if (typeof fetchImpl !== 'function') {
    throw fail('validation_failed', 'fetchImpl 必须是函数', 400, { field: 'fetchImpl' });
  }

  const url = chatCompletionsUrl(baseUrl);
  const payload = {
    model,
    messages,
    ...(temperature === undefined || temperature === null ? {} : { temperature }),
    stream: stream === true,
    // #315：**必发**。省略 ⇒ 网关注入模型级 `litellm_params.max_tokens`（不是这次调用该用的预算）。
    max_tokens: maxTokensResolved,
  };
  // 发出前的断言（结构性保证，不是注释）：宁可当场报错，也绝不发出「省了 max_tokens」的请求。
  if (!Object.hasOwn(payload, 'max_tokens') || !Number.isInteger(payload.max_tokens) || payload.max_tokens <= 0) {
    throw fail('internal', '内部错误：请求体缺少合法的 max_tokens（#315 的回归，见 llm-chat.js 文件头）',
      500, { field: 'max_tokens' });
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  // 「到点必须明确报错，不许悬挂」：与 fetch **竞速**，所以注入的假 fetch 无视 AbortSignal 也拦得住。
  const budget = new Promise((_res, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(fail('llm_upstream_failed', `LLM 调用失败：上游调用超时（>${timeoutLabel(timeoutMs)}）`, 502,
        { reason: 'timeout', timeoutMs }));
    }, timeoutMs);
  });

  let res;
  try {
    const pending = fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // key 纪律 ③：只在这里进一次请求头，别处（含日志/错误/返回值）都不出现。
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    pending.catch(() => {}); // 输掉竞速后的异步拒绝不该变成 unhandled rejection
    res = await Promise.race([pending, budget]);
  } catch (err) {
    const reason = timedOut
      ? `上游调用超时（>${timeoutLabel(timeoutMs)}）`
      : redactSecret(err?.message ?? err, apiKey);
    log?.warn?.(`[${logTag}] 上游调用失败${ctx}：${reason}`);
    if (err && typeof err === 'object' && err.code === 'llm_upstream_failed') throw err; // 超时：上面已记日志
    throw fail('llm_upstream_failed', `LLM 调用失败：${reason}`, 502, {
      reason: timedOut ? 'timeout' : 'network',
    });
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    // 只回显上游 error.message（脱敏 + 截断），不回显整个响应体，也不带请求头。
    let hint = '';
    try {
      const msg = JSON.parse(raw)?.error?.message;
      if (typeof msg === 'string' && msg.trim() !== '') hint = `（${redactSecret(msg, apiKey)}）`;
    } catch { /* 非 JSON 响应体：不给细节 */ }
    const reason = `上游返回 HTTP ${res.status}${hint}`;
    log?.warn?.(`[${logTag}] 上游返回错误${ctx}：${reason}`);
    throw fail('llm_upstream_failed', `LLM 调用失败：${reason}`, 502, { reason: 'upstream_status', status: res.status });
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch { /* 非 JSON：text 给空串，由调用方按业务判（AI 改名侧 → 「未返回可用的标题」/502） */ }
  return {
    text: extractAssistantText(parsed),
    body: parsed,
    status: res.status,
    url,
    maxTokens: maxTokensResolved,
  };
}
