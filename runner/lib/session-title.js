// issue #88 修订（2026-09-25 用户拍板）：会话标题改由 **agent（worker）侧生成**、
// 随 run_finished 上报、portal 落库——取代旧「portal 独立调 relay」路径。理由：
//   ①不重复造 LLM HTTP 客户端（worker 已有 provider，§6.3 config.json 占位 key + endpoint，
//     真实 key 由 Traefik 数据面注入）；②思考型模型兼容（reasoning_content 烧 token）归引擎
//     provider 层管；③复用同一数据面路由与 key 注入。
//
// 本模块（runner 侧）职责：
//   * runToolLoop 正常返回后，用**既有 provider 实例**发一次小请求（非流式、AbortController
//     10s 超时、maxTokens 512 给足思考型模型 reasoning 余量）生成 ≤30 字符纯文本标题；
//   * 失败/超时/空 → 空串（portal 侧走降级链：首条用户消息截断 → cwd basename），
//     **绝不阻塞 run_finished**（generateSessionTitle 全链 catch，永不抛错）。
//   * 开关：env ERIX_SESSION_AUTO_TITLE（沿用同名开关，'0' 关；经 provisioner 下发链
//     compose station-portal → provisioner Env → FDE 容器 env，fde-proxy ENV_KEY_ALLOW 白名单已登记）。
//
// 清洗逻辑（sanitizeTitle）自 portal/src/session-title.js 同函数移植——agent 先清洗，
// portal 落库前再过一遍（幂等），两侧语义一致，单测各守一侧（runner/portal 是独立包，
// 无共享模块，各自维护同构纯函数）。

/** 自动标题长度上限（issue #88：≤30 字符左右）。 */
export const AUTO_TITLE_MAX_LEN = 30;
/** LLM 生成超时（AbortController）；超时即返回空串，不拖住终态上报。 */
export const AUTO_TITLE_TIMEOUT_MS = 10_000;
/** 进 LLM prompt 的输入截断（首条用户消息 / finalText 各截此长度，防超长输入）。 */
const PROMPT_SNIPPET_LEN = 500;

/** 标题清洗（纯函数，移植自 portal/src/session-title.js）：去引号包裹/书名号、折叠空白、
 *  取首行、截断到上限。不合规（空）返回 null。 */
export function sanitizeTitle(raw) {
  if (typeof raw !== 'string') return null;
  let t = raw.replace(/^[「『“”"'\s]+/, '').replace(/[」』“”"'\s]+$/, '');
  t = t.split('\n')[0].replace(/\s+/g, ' ').trim();
  t = t.replace(/^《(.+?)》$/, '$1').trim();
  if (t === '') return null;
  return Array.from(t).slice(0, AUTO_TITLE_MAX_LEN).join('');
}

/**
 * 组装标题生成 prompt（纯函数，供单测锚定语义）：只给首条用户消息 + finalText（各截 500 字符），
 * 要求 ≤30 字符纯文本标题。
 */
export function buildTitlePrompt({ firstUserContent, finalText }) {
  const first = String(firstUserContent ?? '').slice(0, PROMPT_SNIPPET_LEN);
  const final = String(finalText ?? '').slice(0, PROMPT_SNIPPET_LEN);
  const lines = [
    '你是会话标题生成器。为下面这段编程助手对话起一个简短标题。',
    `要求：不超过 ${AUTO_TITLE_MAX_LEN} 个字符；只输出标题文本本身，不要引号、书名号、解释或标点收尾。`,
    '',
    `对话首条用户消息：${first}`,
  ];
  if (final && final !== first) lines.push(`助手最终回复摘要：${final}`);
  return lines.join('\n');
}

/**
 * 从 RUN_START 数据推「首条用户消息」（纯函数）：history（claim ticket 下行，时间升序）
 * 里第一条 user 消息；无 history/无 user 消息 → 当前 task 即首条。都取不到 → null。
 * @param {object} arg
 * @param {Array<{role:string, content:string}>} [arg.history]
 * @param {string} [arg.task]
 * @returns {string|null}
 */
export function resolveFirstUserContent({ history, task } = {}) {
  if (Array.isArray(history)) {
    for (const m of history) {
      if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim() !== '') {
        return m.content;
      }
    }
  }
  if (typeof task === 'string' && task.trim() !== '') return task;
  return null;
}

/**
 * agent 侧标题生成（总函数：全链 catch，永不抛错，绝不阻塞 run_finished）。
 * @param {object} arg
 * @param {object} arg.provider       worker 既有 OpenAI provider 实例（createOpenAIProvider）
 * @param {string} [arg.firstUserContent] 首条用户消息（resolveFirstUserContent 产物；缺省只给 finalText）
 * @param {string} [arg.finalText]    runToolLoop 收尾回复
 * @param {number} [arg.timeoutMs]    超时（默认 AUTO_TITLE_TIMEOUT_MS）
 * @param {object} [arg.log]          缺省 console；失败留 warn 便于排查
 * @returns {Promise<string>} 清洗后的标题；任何失败/超时/空 → 空串
 */
export async function generateSessionTitle({ provider, firstUserContent, finalText, timeoutMs = AUTO_TITLE_TIMEOUT_MS, log = console } = {}) {
  try {
    if (!provider || typeof provider.chat !== 'function') return '';
    const prompt = buildTitlePrompt({ firstUserContent, finalText });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await provider.chat({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 512,
        temperature: 0.2,
        signal: ctrl.signal,
      });
      const raw = Array.isArray(res?.content)
        ? res.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
        : '';
      return sanitizeTitle(raw) ?? '';
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // 失败口径：安静降级（portal 侧走首条消息截断 → cwd basename），不阻塞终态上报。
    log?.warn?.(`[session-title] worker 侧标题生成失败，title 置空（portal 走降级链）：${String(err?.message ?? err)}`);
    return '';
  }
}
