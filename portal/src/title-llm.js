// portal/src/title-llm.js —— portal 侧「用 LLM 给会话起标题」的**唯一实现点**（issue #322）。
//
// 为什么单独一个文件（而不是两份各写一遍）：#88 之后标题长期有**两套实现**——
// `runner/lib/session-title.js`（worker 在 run 终态前用引擎 provider 起一个，随 `run_finished` 上报）
// 与 `portal/src/session-title.js`（落库评估）。同一个「≤30 字标题」被两处各写一遍（`AUTO_TITLE_MAX_LEN`
// / `sanitizeTitle` / prompt / `maxTokens: 512` 各一份，且**无测试锁**），#315 是这份重复开的第一张账单
// （门户那条手搓 `fetch` 漏发 `max_tokens`）。#322 把生成者统一回 portal，本文件就是那个「唯一实现点」：
//
//   · **手工「AI 改名」**（`sessions.js` `generateAiTitle`，用户点按钮）──┐
//   · **自动改名**（`session-title.js` `evaluateAutoTitle`，run 终态后）  ─┴─→ 本文件 `generateTitle()`
//                                                                          └→ `llm-chat.js`（对话调用面唯一出口）
//
// ⇒ 系统提示、输出预算（`max_tokens`）、温度、provider 形态**只在这里有一份**；
//   两条路径的差别只剩「拿什么文本当输入」与「失败时抛错还是静默降级」。
//
// 与 `llm.js` 的分工（#326 定稿的口径，别混）：`llm.js` = 网关**管理面**（目录/凭据/binding CRUD，
// 不发对话）；`llm-chat.js` = **对话调用面**（发一次 `chat/completions`）；本文件 = 标题**业务**层，
// 负责「取活绑定 → 拼 prompt → 调 client」，自己**不发** HTTP、不拼 URL、不写 `max_tokens` 键。
//
// key 纪律（同 `llm.js` 三条存储纪律 ③）：api_key 只经 `llm-chat.js` 进 `Authorization` 头，
// 本文件的返回值/日志/错误文本里都不出现它。
import { chatCompletion, LLM_CHAT_DEFAULT_MAX_TOKENS, LLM_CHAT_DEFAULT_TIMEOUT_MS } from './llm-chat.js';
import { getFdeLlmConfig } from './llm.js';

/**
 * 标题生成的输出预算 = **`llm-chat.js` 的默认值**（512）。
 *
 * 为什么不给标题单独一个数：#315 的病根就是「两条做同一件事的路径各自记 `max_tokens`」（当时只有
 * runner 那条设了 512，门户那条没设 ⇒ 吃网关注入的模型级预算 ⇒ 小窗口下请求被拒）。现在两条路径
 * 共用本函数 ⇒ 只有一个数；而且它是 `llm-chat.js` 的缺省值本身，不是这里另抄的字面量。
 * 必发的结构性保证在对面（`llm-chat.js` 发出前的断言 + `portal/test/llm-chat.test.js`）。
 */
export const TITLE_LLM_MAX_TOKENS = LLM_CHAT_DEFAULT_MAX_TOKENS;

/** 标题生成的超时（沿用 #114 定的 ~15s；同样取 `llm-chat.js` 的缺省值，不另立数值）。 */
export const TITLE_LLM_TIMEOUT_MS = LLM_CHAT_DEFAULT_TIMEOUT_MS;

/**
 * 标题生成的系统提示（手工与自动**共用同一段**）。
 * 措辞刻意与输入形态解耦：输入可能是「最早 3 条用户消息」（手工）或「会话最后一段助手文本」（自动），
 * 两条都叫「会话内容片段」。长度口径与 `session-title.js` 的 `AUTO_TITLE_MAX_LEN`（30）一致，
 * 落库前仍会再 `sanitizeTitle` 一遍（提示词不是守卫）。
 */
export const TITLE_SYSTEM_PROMPT =
  '你是会话命名助手。根据下面给出的会话内容片段，为这次会话生成一个简短标题。'
  + '要求：不超过 30 个字符；与输入文本的语言一致；只输出标题本身，不要引号、序号、解释或结尾标点。';

/** 手工「AI 改名」的上下文：会话最早的 N 条 user 消息（单条折叠空白后截 TITLE_CONTEXT_MAX_LEN 字符）。 */
export const TITLE_CONTEXT_MESSAGES = 3;
export const TITLE_CONTEXT_MAX_LEN = 200;
/** 自动改名的输入（会话最后一段助手文本）进 prompt 前的截断长度，防超长输入白烧 token。 */
export const TITLE_ASSISTANT_SNIPPET_MAX_LEN = 500;

/** 折叠空白 + 截断（纯函数）：两条路径的片段清洗共用。 */
function snippet(text, maxLen) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/**
 * 手工路径的 user 提示（纯函数，供单测锚定语义）：最早 N 条 user 消息编号列出。
 * 形状与 #114 起的历史实现逐字一致（本函数是从 `sessions.js` **搬过来**的，不是第三份拷贝）。
 */
export function buildAiTitlePrompt(messages) {
  const list = (Array.isArray(messages) ? messages : [])
    .slice(0, TITLE_CONTEXT_MESSAGES)
    .map((m, i) => `${i + 1}. ${snippet(m, TITLE_CONTEXT_MAX_LEN)}`);
  return `用户消息：\n${list.join('\n')}\n\n请只输出标题。`;
}

/**
 * 自动路径的 user 提示（纯函数，供单测锚定语义）：只给**会话最后一段助手文本**（截 500 字符）。
 * 为什么用助手文本而不是首条用户消息：自动改名发生在 run 终态，此刻最能代表「这次会话到底做了什么」
 * 的是助手的收尾回复（旧 runner 实现的输入也是 `finalText` + 首条用户消息，#88 的既有语义）。
 */
export function buildAutoTitlePrompt(assistantText) {
  return `助手在本次会话里的收尾回复：\n${snippet(assistantText, TITLE_ASSISTANT_SNIPPET_MAX_LEN)}\n\n请只输出标题。`;
}

/**
 * 解析「该 FDE 的活绑定」成一次对话调用要的 provider（照 `sessions.js` 既有的做法：只认
 * `fde_llm_bindings` 里 `state='active' AND gateway='litellm'` 那一行，`api_key` = per-FDE 虚拟 key，
 * model = 绑定的 LiteLLM data-plane `model_name`；**不回退**已退役的 Station provider/model 目录）。
 *
 * @returns {Promise<{base_url:string, api_key:string, model:string, source:'fde_binding'}|null>}
 *          缺 api_key 或缺主模型 ⇒ **null**（不抛错）。抛不抛错是调用方的业务判断：
 *          手工路径 → `409 llm_not_configured`（`sessions.js` `resolveAiTitleProvider`），
 *          自动路径 → 静默退到降级链（`session-title.js`）。
 */
export async function resolveTitleLlmProvider(pool, userId, { gatewayUrl = 'http://127.0.0.1:4100' } = {}) {
  const cfg = await getFdeLlmConfig(pool, userId);
  const mainModel = cfg?.main?.name;
  if (!cfg?.api_key || !mainModel) return null;
  return { base_url: gatewayUrl, api_key: cfg.api_key, model: mainModel, source: 'fde_binding' };
}

/**
 * 发**一次**「起标题」的对话请求，返回模型给的原始文本（清洗与落库归调用方，那是会话业务）。
 *
 * 本函数是 portal 侧标题生成的**唯一出口**：`sessions.js`（手工）与 `session-title.js`（自动）都调它，
 * 它自己只把 `messages` 交给 `llm-chat.js`。`max_tokens` 的「必发」由 `llm-chat.js` 结构性保证
 * （这里传 `TITLE_LLM_MAX_TOKENS`，那个文件在发出前还会断言一次）。
 *
 * @throws 透传 `llm-chat.js` 的错误（`llm_not_configured` / `llm_upstream_failed` / `validation_failed`）；
 *         错误类型由 `ErrorCtor` 决定（手工路径传 `SessionError` ⇒ `http.js` 的映射一行都不用改，
 *         错误面与收口前逐字一致）。
 *         **本函数不吞错**：要不要静默降级由调用方按自己的业务判（自动路径外面包 try/catch）。
 */
export async function generateTitle({
  provider, userPrompt, maxTokens = TITLE_LLM_MAX_TOKENS, timeoutMs = TITLE_LLM_TIMEOUT_MS,
  fetchImpl = fetch, ErrorCtor, log = console, logTag = 'title', logContext = '',
} = {}) {  const { text } = await chatCompletion({
    provider,
    messages: [
      { role: 'system', content: TITLE_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    maxTokens,
    timeoutMs,
    fetchImpl,
    ErrorCtor,
    log,
    logTag,
    logContext,
  });
  return text;
}
