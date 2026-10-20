// 会话标题自动落库与自动更新（issue #88；**issue #322 起生成者回到 portal**）。
//
// 历史：#88 原文是「只动 portal + 前端展示；runner/agentd 零改动（标题是 portal 会话元数据，不是引擎
// 事务）」，但实现曾把它挪到 runner（`runner/lib/session-title.js` 用引擎 provider 起标题、随
// `run_finished` 上报、portal 只落库）⇒ 同一件事两份实现（`AUTO_TITLE_MAX_LEN=30` / `sanitizeTitle` /
// prompt / `maxTokens: 512` 各一份，**无测试锁**），#315 是这份重复开的第一张账单。**#322 已拆除 runner
// 那一份**：portal 是标题的唯一实现点，生成一律走 `title-llm.js` → `llm-chat.js`（不再有「例外」这回事）。
//
// 本模块（portal 侧）职责：终态 run 的 finishRun 收敛后 scheduleAutoTitle 异步评估（fire-and-forget，
// 不阻塞终态响应）→ 防抖判据 → **调 `title-llm.js` 生成**（输入 = 会话最后一段助手文本 + 该 FDE 的活绑定）
// → `title_source='auto'` 守卫落库 → SSE `session_updated` 推送。
//
// 降级链（生成拿不到 / 无活绑定 / 网关失败 → 首条用户消息截断 → cwd basename）。手工优先：只写
// title_source='auto' 的行。
//
// 触发与节流：
//   * 触发点 = internal.js finishRun 终态收敛提交后调用 scheduleAutoTitle（fire-and-forget）——
//     天然「每 run 至多评估一次」。
//   * 防抖判据（纯函数 shouldRefreshTitle，供单测）：首启（标题空 / 从未自动更新）必生成；
//     否则距上次自动更新 ≥ minNew 轮新用户消息 → 刷新；或 ≥1 轮新消息且最新用户消息与现标题
//     关键词零重合（廉价话题漂移启发式，不上嵌入）→ 刷新。
//
// 失败口径（#322 的红线）：**自动改名是锦上添花，绝不能把 run 的终态处理弄失败**。链路任何一步失败
//   （无活绑定 / 网关超时或非 2xx / DB 错 / 标题全降级链空）都安静降级到降级链，全过程不抛
//   （scheduleAutoTitle 包最后一层 catch）；错误码一个都不新增（静默面不对外报码）。
import path from 'node:path';
import { loadConfig } from './config.js';
import { fetchUserTextTurns, fetchRunAssistantText } from './session-text.js';
import { buildAutoTitlePrompt, generateTitle, resolveTitleLlmProvider } from './title-llm.js';

/** 自动标题长度上限（issue #88：≤30 字符左右；agent 侧生成时已按同口径清洗，此处再过一遍幂等）。 */
export const AUTO_TITLE_MAX_LEN = 30;
/**
 * 旧「agent 上报 title」的截断上限（issue #88 时代的产物）。**issue #322 起退役**：worker 恒发空串、
 * `internal.js` 只校类型不吃值 ⇒ 本站不再有消费者。常量暂留只为让「谁在引用它」这条grep 有意义，
 * 真要清就整行删（删了不会有任何调用点报错）。
 */
export const AGENT_TITLE_MAX_LEN = 200;
/** 防抖默认值：距上次自动更新至少 N 轮新用户消息才刷新（env ERIX_SESSION_AUTO_TITLE_MIN_NEW 可调）。 */
export const AUTO_TITLE_DEFAULT_MIN_NEW = 3;

/**
 * 刷新判据（纯函数，供单测）。
 * @param {object} arg
 * @param {string} arg.title            现标题（可能为空串）
 * @param {number|null} arg.autoTitleSeq 上次自动更新时的 last_seq 快照（NULL = 从未自动更新）
 * @param {number} arg.newUserCount     距上次自动更新的新 user 消息轮数（seq > autoTitleSeq）
 * @param {string} arg.latestUserContent 最新一条 user 消息内容
 * @param {number} arg.minNew           防抖阈值 N
 * @returns boolean 本次是否应生成/刷新标题
 */
export function shouldRefreshTitle({ title, autoTitleSeq, newUserCount, latestUserContent, minNew }) {
  const hasTitle = typeof title === 'string' && title.trim() !== '';
  if (!hasTitle) return true; // 首启：无标题必生成
  if (autoTitleSeq == null) return newUserCount >= minNew; // 存量旧标题（无游标）：只按 N 轮防抖
  const n = Number(newUserCount) || 0;
  if (n >= minNew) return true;
  if (n >= 1 && !keywordsOverlap(latestUserContent ?? '', title)) return true; // 话题漂移启发式
  return false;
}

/** 关键词抽取（纯函数）：ASCII 词（≥2 字符）+ 单个 CJK 字符（中文无词边界，字粒度最廉价）。 */
export function extractKeywords(text) {
  const out = new Set();
  const s = String(text ?? '').toLowerCase();
  for (const m of s.matchAll(/[a-z0-9]{2,}/g)) out.add(m[0]);
  for (const ch of s) if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch)) out.add(ch);
  return out;
}

/** 话题漂移启发式（纯函数）：最新用户消息与现标题关键词是否**有**重合。 */
export function keywordsOverlap(messageContent, title) {
  const a = extractKeywords(messageContent);
  if (a.size === 0) return false; // 抽不出关键词 → 判漂移（宁可多刷新，不可挂死旧标题）
  const b = extractKeywords(title);
  if (b.size === 0) return false;
  for (const k of a) if (b.has(k)) return true;
  return false;
}

/** 标题清洗（纯函数）：去引号包裹/书名号、折叠空白、取首行、截断到上限。不合规（空）返回 null。
 *  issue #322 起本站只此一份（runner 侧那份已删）；手工改名与自动改名都过它。 */
export function sanitizeTitle(raw) {
  if (typeof raw !== 'string') return null;
  let t = raw.replace(/^[「『“”"'\s]+/, '').replace(/[」』“”"'\s]+$/, '');
  t = t.split('\n')[0].replace(/\s+/g, ' ').trim();
  t = t.replace(/^《(.+?)》$/, '$1').trim();
  if (t === '') return null;
  return Array.from(t).slice(0, AUTO_TITLE_MAX_LEN).join('');
}

/** 降级标题：首条用户消息截断（纯函数）；空消息 → null（再降级 cwd basename）。
 *
 * issue #114：新增 `ellipsis` 选项——内容超过上限被截断时尾部补 `…`（未截断不加）。
 * 默认 false 以**保持 #88 既有调用方语义**（evaluateAutoTitle 的降级链不想要省略号）；
 * 首条消息默认命名（sessions.postMessage）显式传 `{ ellipsis: true }`。 */
export function clipTitleFromMessage(content, { ellipsis = false } = {}) {
  const t = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  const chars = Array.from(t);
  const clipped = chars.slice(0, AUTO_TITLE_MAX_LEN).join('');
  return ellipsis && chars.length > AUTO_TITLE_MAX_LEN ? `${clipped}…` : clipped;
}

/** 末级降级：cwd basename（~/projects/<name> → <name>；basename 空 → '未命名会话'）。 */
export function fallbackTitleFromCwd(cwd) {
  const base = path.basename(String(cwd ?? '')).trim();
  return base === '' || base === '.' ? '未命名会话' : Array.from(base).slice(0, AUTO_TITLE_MAX_LEN).join('');
}

/**
 * 自动改名的 LLM 生成（issue #322）：**只走 `title-llm.js`**（它再走 `llm-chat.js`，portal 侧直连对话的唯一出口）。
 *
 * 输入 = **会话最后一段助手文本**（`fetchRunAssistantText` → transcript 投影，与对话流 DTO 同一口径）；
 * 模型 = 会话属主 FDE 的**活绑定**（`resolveTitleLlmProvider`，照 `sessions.js` 既有的取数做法）。
 *
 * ⚠ **静默契约**（#322 红线，有专测钉着）：本函数**吃掉一切异常**并返回 null，**绝不向上抛**——
 * 无活绑定 / 网关超时 / 上游非 2xx / 无助手文本 / 清洗后为空 都只是「本次生成没成」，
 * 由调用方退到降级链。自动改名是锦上添花，不能把 run 的终态处理弄失败，也不新加任何错误码。
 *
 * @returns {Promise<string|null>} 清洗后的标题（≤30 字）；null = 本次不生成（降级）
 */
export async function generateAutoTitle(pool, {
  sessionId, runId, userId, config, fetchImpl = fetch, gatewayUrl, timeoutMs, log = console,
} = {}) {
  let apiKey = '';
  try {
    if (typeof runId !== 'string' || runId === '') return null;   // 没有 run 就没有「最后一段助手文本」可依据
    const assistant = await fetchRunAssistantText(pool, { sessionId, runId });
    const snippet = String(assistant?.text ?? '').trim();
    if (snippet === '') return null;                              // 投影与 legacy 都拿不到正文 ⇒ 降级

    const cfg = config ?? {};
    const provider = await resolveTitleLlmProvider(pool, userId, {
      // 与手工改名同一个选型（`http.js` 传的是 `llmGatewayAdminUrl ?? llmGatewayUrl`）：
      // portal 容器里只有 backend 地址能到数据面（`docs/env.md` 「AI-title 从 portal 容器经此 backend URL 调用数据面」）。
      gatewayUrl: gatewayUrl ?? cfg.llmGatewayAdminUrl ?? cfg.llmGatewayUrl ?? 'http://127.0.0.1:4100',
    });
    if (!provider) return null;                                   // 绑定缺失 ⇒ 静默退到降级链（不抛 409）
    apiKey = provider.api_key ?? '';

    const text = await generateTitle({
      provider,
      userPrompt: buildAutoTitlePrompt(snippet),
      // 默认吃 `title-llm.js` 的现值（= `llm-chat.js` 的 15s）；显式传只服务于单测（假 fetch 超时要快）。
      ...(timeoutMs ? { timeoutMs } : {}),
      fetchImpl,
      log,
      logTag: 'auto-title',
      logContext: `session=${sessionId}`,
    });
    const title = sanitizeTitle(text);
    if (title == null) log?.warn?.(`[auto-title] 上游未返回可用标题（session=${sessionId}）`);
    return title;
  } catch (err) {
    // 全链兼容的兵库：错误文本已过 llm-chat.js 的 redactSecret（key 不进来），本层只再拼一层文案。
    log?.warn?.(`[auto-title] LLM 生成失败，退到降级链（session=${sessionId}）：${String(err?.message ?? err)}`);
    return null;
  } finally {
    apiKey = '';
  }
}

/**
 * 自动标题评估（异步；失败全降级、不抛错）。
 * @param {object} pool
 * @param {object} arg
 * @param {string} arg.sessionId
 * @param {string} [arg.runId]       触发本次评估的 run（生成输入「最后一段助手文本」锥它取；也用于日志）
 * @param {object} [arg.config]      loadConfig 产物（缺省现场加载；单测注入）
 * @param {Function} [arg.notify]    (sessionId, events) => void，标题更新后推 SSE（internal.notifySessionEvents）
 * @param {Function} [arg.fetchImpl] 上游对话 fetch 的注入点（单测用假 fetch，零网络）
 * @param {number} [arg.timeoutMs]   生成请求的超时覆盖（只给单测用；缺省走 `title-llm.js` 的 15s）
 * @param {object} [arg.log]         缺省 console
 * @returns {Promise<string|null>}   实际写入的标题；未刷新/被手工抢占返回 null
 */
export async function evaluateAutoTitle(pool, {
  sessionId, runId, config, notify, fetchImpl, timeoutMs, log = console,
} = {}) {
  const cfg = config ?? loadConfig(process.env);
  if (cfg.sessionAutoTitle === false) return null; // 开关关闭（ERIX_SESSION_AUTO_TITLE=0）
  const minNew = Number.isInteger(cfg.sessionAutoTitleMinNew) && cfg.sessionAutoTitleMinNew > 0
    ? cfg.sessionAutoTitleMinNew
    : AUTO_TITLE_DEFAULT_MIN_NEW;
  try {
    const sres = await pool.query(
      `SELECT id, user_id, title, title_source, cwd, auto_title_seq, last_seq, status
         FROM chat_sessions WHERE id = $1`,
      [sessionId],
    );
    const s = sres.rows?.[0];
    if (!s || s.status !== 'active') return null;
    if (s.title_source !== 'auto') return null; // 手工优先：manual 行绝不自动覆盖

    // P3 PR②b B1 ②③：首条 / 最新 user 正文**改从 transcript 投影取**（`fetchUserTextTurns`，
    // 与对话流 DTO 同一口径）；投影对该轮无证据时才 legacy 回退 `messages.content`
    // （迁移 0015 之前的行；legacy-only，不用于新会话）。新 user 轮数仍按 messages.seq 计数（不是文本）。
    const userTurns = await fetchUserTextTurns(pool, { sessionId });
    const first = userTurns[0] ?? null;
    const latest = userTurns.at(-1) ?? first;
    if (!first) return null; // 会话内还没有用户消息（不应发生：触发点是终态 run）
    // 新 user 轮数 = seq > auto_title_seq（NULL 游标 = 从未自动更新 → 按全部 user 消息计）
    const newRes = await pool.query(
      `SELECT count(*)::int AS n FROM messages WHERE session_id = $1 AND role = 'user' AND seq > $2`,
      [sessionId, s.auto_title_seq ?? 0],
    );
    const newUserCount = Number(newRes.rows?.[0]?.n ?? 0);

    if (!shouldRefreshTitle({ title: s.title, autoTitleSeq: s.auto_title_seq, newUserCount, latestUserContent: latest.text, minNew })) {
      return null; // 防抖：不到刷新阈值
    }

    // 落库标题（#322 定稿）：**portal 自己生成**（会话最后一段助手文本 → `title-llm.js` → `llm-chat.js`）
    //   → 首条消息截断 → cwd basename。旧「容器上报 title」那一级的来源已在 #322 撤掉（worker 恒发空串，
    //   `internal.js` 只校类型不吃值）；降级链的两级本身一字未动。
    let title = await generateAutoTitle(pool, { sessionId, runId, userId: s.user_id, config: cfg, fetchImpl, timeoutMs, log });
    if (title == null) title = clipTitleFromMessage(first.text);
    if (title == null) title = fallbackTitleFromCwd(s.cwd);

    // 只写 source='auto' 的行（并发手工 PATCH 已置 manual → 0 行，安静放弃）
    const upd = await pool.query(
      `UPDATE chat_sessions
          SET title = $2, auto_title_seq = last_seq, updated_at = now()
        WHERE id = $1 AND title_source = 'auto' AND status = 'active'`,
      [sessionId, title],
    );
    if ((upd.rowCount ?? upd.rows?.length ?? 0) === 0) return null;

    log?.info?.(`[auto-title] 会话标题已更新（session=${sessionId}）：${title}`);
    // 经既有 session SSE hub 推一条 live 事件（不落 run_events：标题不是时间线事件），
    // 前端收到后原地更新列表项标题（useEventStream 'session_updated'）。
    try {
      notify?.(sessionId, [{ ts: new Date().toISOString(), type: 'session_updated', payload: { title } }]);
    } catch { /* 推送失败不影响已落库的标题 */ }
    return title;
  } catch (err) {
    // 评估链任何意外都不许影响主流程（终态响应已返回）
    log?.warn?.(`[auto-title] 评估失败（session=${sessionId}）：${String(err?.message ?? err)}`);
    return null;
  }
}

/**
 * fire-and-forget 入口（internal.js finishRun 终态收敛后调用）：
 * 异步评估、全链 catch——绝不阻塞/绝不 reject 回主链路。配置现场加载（env 改动下次生效）。
 */
export function scheduleAutoTitle(pool, { sessionId, runId, notify, fetchImpl, log } = {}) {
  Promise.resolve()
    .then(() => evaluateAutoTitle(pool, { sessionId, runId, notify, fetchImpl, log }))
    .catch(() => { /* 最后一层兜底：评估链自身已 catch，这里防意外 */ });
}
