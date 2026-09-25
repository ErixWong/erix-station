// 会话标题自动生成与自动更新（issue #88）。
// 依据：issue #88 设计要点——run 终态事件（finished/failed）后**异步**评估（不阻塞消息主链路），
//   用该会话用户的 LLM 配置走一次轻量补全生成 ≤30 字符标题；失败/超时降级链：
//   「LLM 生成」→「首条用户消息截断」→「cwd basename」。手工优先：只写 title_source='auto' 的行。
//
// 触发与节流：
//   * 触发点 = internal.js finishRun 终态收敛提交后调用 scheduleAutoTitle（fire-and-forget）——
//     天然「每 run 至多评估一次」。
//   * 防抖判据（纯函数 shouldRefreshTitle，供单测）：首启（标题空 / 从未自动更新）必生成；
//     否则距上次自动更新 ≥ minNew 轮新用户消息 → 刷新；或 ≥1 轮新消息且最新用户消息与现标题
//     关键词零重合（廉价话题漂移启发式，不上嵌入）→ 刷新。
//
// LLM 调用：portal 无既有 LLM HTTP 客户端（llm.js 是存储层；数据面路由由 Traefik 发布给容器），
//   故这里按 fde_llm_bindings 的 api_format='openai'（唯一枚举，迁移 0002）走最小
//   POST {base_url}/v1/chat/completions：低 max_tokens、单轮、非流式、AbortController 超时。
//   凭据 = 该 FDE 自己的 api_key（与 run 同口径，计入用户既有配置与限额，不新增网关面）。
//   fetchImpl 可注入（单测 mock，不碰真实网络）。
//
// 失败口径：链路任何一步失败（无 LLM 配置/网络错/超时/响应畸形/标题不合规）都安静降级到
//   下一级；全过程不抛（scheduleAutoTitle 包最后一层 catch），绝不影响 run 终态响应。
import path from 'node:path';
import { loadConfig } from './config.js';
import { getFdeLlmConfig } from './llm.js';

/** 自动标题长度上限（issue #88：≤30 字符左右）。 */
export const AUTO_TITLE_MAX_LEN = 30;
/** LLM 生成超时（AbortController）；超时即降级，不拖住评估链。 */
export const AUTO_TITLE_LLM_TIMEOUT_MS = 10_000;
/** 防抖默认值：距上次自动更新至少 N 轮新用户消息才刷新（env ERIX_SESSION_AUTO_TITLE_MIN_NEW 可调）。 */
export const AUTO_TITLE_DEFAULT_MIN_NEW = 3;
/** 进 LLM prompt 的用户消息截断（防超长输入）。 */
const PROMPT_SNIPPET_LEN = 500;

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

/** 标题清洗（纯函数）：去引号包裹/书名号、折叠空白、取首行、截断到上限。不合规（空）返回 null。 */
export function sanitizeTitle(raw) {
  if (typeof raw !== 'string') return null;
  let t = raw.replace(/^[「『“”"'\s]+/, '').replace(/[」』“”"'\s]+$/, '');
  t = t.split('\n')[0].replace(/\s+/g, ' ').trim();
  t = t.replace(/^《(.+?)》$/, '$1').trim();
  if (t === '') return null;
  return Array.from(t).slice(0, AUTO_TITLE_MAX_LEN).join('');
}

/** 降级标题：首条用户消息截断（纯函数）；空消息 → null（再降级 cwd basename）。 */
export function clipTitleFromMessage(content) {
  const t = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  return Array.from(t).slice(0, AUTO_TITLE_MAX_LEN).join('');
}

/** 末级降级：cwd basename（~/projects/<name> → <name>；basename 空 → '未命名会话'）。 */
export function fallbackTitleFromCwd(cwd) {
  const base = path.basename(String(cwd ?? '')).trim();
  return base === '' || base === '.' ? '未命名会话' : Array.from(base).slice(0, AUTO_TITLE_MAX_LEN).join('');
}

/**
 * 组装 OpenAI 兼容补全请求体（纯函数，供单测锚定 prompt 语义）。max_tokens 给足「30 字 + 余量」。
 */
export function buildTitlePrompt({ firstUserContent, latestUserContent }) {
  const first = String(firstUserContent ?? '').slice(0, PROMPT_SNIPPET_LEN);
  const latest = String(latestUserContent ?? '').slice(0, PROMPT_SNIPPET_LEN);
  const lines = [
    '你是会话标题生成器。为下面这段编程助手对话起一个简短标题。',
    `要求：不超过 ${AUTO_TITLE_MAX_LEN} 个字符；只输出标题文本本身，不要引号、书名号、解释或标点收尾。`,
    '',
    `对话首条用户消息：${first}`,
  ];
  if (latest && latest !== first) lines.push(`最近一条用户消息：${latest}`);
  return lines.join('\n');
}

/** 单次 OpenAI 兼容 chat completion（可注入 fetchImpl / AbortController 超时；畸形响应抛错）。 */
async function callLlmForTitle({ cfg, prompt, fetchImpl, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const base = String(cfg.base_url).replace(/\/+$/, '');
    // base_url 惯例常已带 /v1（OpenAI SDK 形态）——带则不再重复拼接。
    const url = /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.api_key}`,
      },
      body: JSON.stringify({
        model: cfg.main.model_id,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        // 512 而非 64：用户主模型可能是思考型（如 deepseek-flash，reasoning_content 先烧 token），
        // 给小会把 max_tokens 全烧在 reasoning、content 空串 → 白白降级（真机实锳）。512 对标题任务仍极廉价。
        max_tokens: 512,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`llm http ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('llm response malformed');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 自动标题评估（异步；失败全降级、不抛错）。
 * @param {object} pool
 * @param {object} arg
 * @param {string} arg.sessionId
 * @param {string} [arg.runId]      触发本次评估的 run（仅日志用）
 * @param {object} [arg.config]     loadConfig 产物（缺省现场加载；单测注入）
 * @param {Function} [arg.fetchImpl] 缺省全局 fetch（单测 mock）
 * @param {Function} [arg.notify]   (sessionId, events) => void，标题更新后推 SSE（internal.notifySessionEvents）
 * @param {object} [arg.log]        缺定 console
 * @returns {Promise<string|null>}  实际写入的标题；未刷新/被手工抢占返回 null
 */
export async function evaluateAutoTitle(pool, { sessionId, runId, config, fetchImpl, notify, log = console } = {}) {
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

    // 首条 / 最新 user 消息 + 距上次自动更新的新 user 轮数（三条小查询；评估每 run 至多一次，量可忽略）
    const firstRes = await pool.query(
      `SELECT content, seq FROM messages WHERE session_id = $1 AND role = 'user' ORDER BY seq ASC LIMIT 1`,
      [sessionId],
    );
    const latestRes = await pool.query(
      `SELECT content, seq FROM messages WHERE session_id = $1 AND role = 'user' ORDER BY seq DESC LIMIT 1`,
      [sessionId],
    );
    const first = firstRes.rows?.[0];
    const latest = latestRes.rows?.[0] ?? first;
    if (!first) return null; // 会话内还没有用户消息（不应发生：触发点是终态 run）
    // 新 user 轮数 = seq > auto_title_seq（NULL 游标 = 从未自动更新 → 按全部 user 消息计）
    const newRes = await pool.query(
      `SELECT count(*)::int AS n FROM messages WHERE session_id = $1 AND role = 'user' AND seq > $2`,
      [sessionId, s.auto_title_seq ?? 0],
    );
    const newUserCount = Number(newRes.rows?.[0]?.n ?? 0);

    if (!shouldRefreshTitle({ title: s.title, autoTitleSeq: s.auto_title_seq, newUserCount, latestUserContent: latest.content, minNew })) {
      return null; // 防抖：不到刷新阈值
    }

    // 生成：LLM → 首条消息截断 → cwd basename
    let title = null;
    const llmCfg = await getFdeLlmConfig(pool, s.user_id);
    if (llmCfg?.api_key && llmCfg?.base_url && llmCfg?.main?.model_id) {
      try {
        const raw = await callLlmForTitle({
          cfg: llmCfg,
          prompt: buildTitlePrompt({ firstUserContent: first.content, latestUserContent: latest.content }),
          fetchImpl: fetchImpl ?? fetch,
          timeoutMs: AUTO_TITLE_LLM_TIMEOUT_MS,
        });
        title = sanitizeTitle(raw);
      } catch (err) {
        log?.warn?.(`[auto-title] llm 生成失败，降级首条消息截断（session=${sessionId} run=${runId ?? ''}）：${String(err?.message ?? err)}`);
      }
    } else if (llmCfg) {
      // 配置存在但缺关键字段（如 key/base_url 空）——静默降级，留 warn 便于排查。
      log?.warn?.(`[auto-title] llm 配置不完整，降级首条消息截断（session=${sessionId}）`);
    }
    if (title == null && llmCfg) {
      log?.warn?.(`[auto-title] llm 返回不可用（空/畸形），降级首条消息截断（session=${sessionId} run=${runId ?? ''}）`);
    }
    if (title == null) title = clipTitleFromMessage(first.content);
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
export function scheduleAutoTitle(pool, { sessionId, runId, notify, log } = {}) {
  Promise.resolve()
    .then(() => evaluateAutoTitle(pool, { sessionId, runId, notify, log }))
    .catch(() => { /* 最后一层兜底：评估链自身已 catch，这里防意外 */ });
}
