// issue #803 S1：服务端下发文案的请求语言谈判（**零依赖、纯函数、可单测**）。
//
// 为什么单独成文件：谈判逻辑要在 `http.js`（错误响应出口）与 `runtime-settings.js`（管理台
// label/hint）两侧共用，而这两者都不能反过来依赖对方；放这里既不成环（本文件不 import 任何
// `portal/src` 模块）又可独立单测。
//
// ⚠ **别 import `./http.js`**：`http.js` 是错误出口、会 import 本文件，反向 import 直接成环。
//   cookie 解析在本文件里自持一份（`http.js` 的 `getCookie` 是同形态参照，**不去改它**）。
//
// 谈判顺序（契约固定，缺省必须还是 `zh-CN`）：
//   ① `Cookie: locale=`（白名单 `zh-CN` | `en`，脏值忽略）
//   ② `Accept-Language`（按 q 值择优，`zh*` ⇒ `zh-CN`、`en*` ⇒ `en`，`*` 与其他语言落回；
//     `q <= 0` 的项按 RFC 算「不要」⇒ 不参与匹配，详见 `parseAcceptLanguage` 的头注）
//   ③ 缺省 `zh-CN`。
//   任何脏输入都不许抛，逐级落回；无 req / 无 headers 也要能调用。

/** 支持的语言白名单（顺序即展示口径，`zh-CN` 在前）。 */
export const SUPPORTED_LOCALES = Object.freeze(['zh-CN', 'en']);

/** 谈判全落回时用的缺省语言（**不许改成 en**——这是既有契约）。 */
export const DEFAULT_LOCALE = 'zh-CN';

// 小写键 → 规范名。cookie 走**精确**匹配（白名单只有 `zh-CN`/`en`，`zh` 算脏值）；
// Accept-Language 的前缀匹配另走 `fromLanguageTag`。
const EXACT_LOCALES = Object.freeze({ 'zh-cn': 'zh-CN', 'en': 'en' });

/**
 * cookie 白名单归一：把 `locale` 的值收成受支持的语言名，脏值 ⇒ `null`。
 * 只认 `zh-CN` / `en` 两档（大小写不敏感、前后空白忽略）；`zh`、`fr`、空串、非字符串一律 `null`
 * （cookie 是客户端可写的，脏值必须忽略而不是抛，也不能被当成合法语言）。
 * @param {unknown} value
 * @returns {'zh-CN'|'en'|null}
 */
export function normalizeLocale(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  // `Object.hasOwn` 而不是 `EXACT_LOCALES[key]`：`{}` 字面量带着 `Object.prototype`，
  // `'constructor'` / `'toString'` 这类名会命中继承来的值（一个函数）而漏过白名单。
  return Object.hasOwn(EXACT_LOCALES, key) ? EXACT_LOCALES[key] : null;
}

/**
 * 单个语言标签 → 受支持的语言名。`zh*` ⇒ `zh-CN`、`en*` ⇒ `en`；
 * `*`（通配）与其他语言 ⇒ `null`（落回，不在这里决定缺省）。大小写不敏感。
 */
function fromLanguageTag(tag) {
  const t = String(tag).trim().toLowerCase();
  if (t === '' || t === '*') return null;
  // `zh`、`zh-CN`、`zh-TW`、`zh-Hans` … 一律归到 `zh-CN`（本服务只有这一档中文）。
  if (t === 'zh' || t.startsWith('zh-')) return 'zh-CN';
  if (t === 'en' || t.startsWith('en-')) return 'en';
  return null;
}

/**
 * 解析 `Accept-Language` 头，按 q 值择优出一个受支持的语言名；没有可用项 ⇒ `null`（由调用方落回缺省）。
 *
 * 规则：逗号分割成 `(tag, q)` 段；按 q **降序**（同 q 保留原序，稳定）逐个试 `fromLanguageTag`，
 * 第一个受支持的胜出。`*` 与其他语言（`fr` 等）只跳过、不匹配。任何脏输入（非字符串、乱串、
 * 非法 q）都不抛——解析不了的段直接跳过。
 *
 * `q` 的三条口径（#803 返修 m4：与 RFC 7231 对齐）：
 *   · **缺省 `q=1`**（裸标签就是「最想要」）；
 *   · **`q <= 0` 的语言项不参与匹配**（RFC 的「我不要这个语言」）：`en;q=0` 单独一条 ⇒ `null`
 *     ⇒ 由调用方落回缺省，而不是选中它；`q` 为负（`q=-1`）同口径；
 *   · **非法 / 缺值的 q 仍按 `q=1`**（`en;q=abc`、`zh-CN;q=`、`en;;q=`）：那是写法坑，不是
 *     「拒绝」——不因为一个坏权重把整段丢掉，**该标签照常参与匹配**。
 * @param {unknown} header 原始 `Accept-Language` 头值
 * @returns {'zh-CN'|'en'|null}
 */
export function parseAcceptLanguage(header) {
  if (typeof header !== 'string') return null;
  const parts = header.split(',');
  const scored = [];
  for (let i = 0; i < parts.length; i += 1) {
    const raw = parts[i];
    if (raw === undefined) continue;
    const bits = raw.split(';');
    const tag = bits[0];
    // 权重默认 1；`;q=` 里能解析出的有限数就用它，解析不出（乱码/缺值）就当 1 跳过权重、
    // 但标签本身仍照常参与匹配——不因为一个坏 q 把整段丢掉。
    let q = 1;
    for (let k = 1; k < bits.length; k += 1) {
      const p = bits[k].trim();
      if (p.toLowerCase().startsWith('q=')) {
        const parsed = Number.parseFloat(p.slice(2));
        if (Number.isFinite(parsed)) q = parsed;
        break;
      }
    }
    // `q <= 0` 是 RFC 的「不要这个语言」⇒ 整段不进候选（#803 返修 m4）。
    // 注意只滤**解析出来的** 0：`q=abc` / `q=` 在上面已经退回 q=1，仍然参与匹配。
    if (q <= 0) continue;
    // `i` 作次键：q 相同时保持头里的原序（稳定排序），符合「越靠左越优先」的 RFC 语义。
    scored.push({ tag, q, order: i });
  }
  scored.sort((a, b) => (b.q - a.q) || (a.order - b.order));
  for (const { tag } of scored) {
    const locale = fromLanguageTag(tag);
    if (locale !== null) return locale;
  }
  return null;
}

/**
 * 从 cookie 头里抠出 `locale` 的值（自持解析，形状照 `http.js#getCookie`，**不去改它**）。
 * 没有 / 没有这个键 ⇒ `null`。不做 URL 解码（cookie 里的语言名不需要解码）。
 */
function readLocaleCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === 'locale') return part.slice(idx + 1).trim();
  }
  return null;
}

/**
 * 从一个请求（或任何带 `headers` 的对象）谈出这一次响应用的 locale。
 * **永不抛**：`req` 缺省、`headers` 缺省或非对象、cookie / accept-language 是脏值，全都逐级落回，
 * 最终落回 `DEFAULT_LOCALE`。
 * @param {{headers?: Record<string, unknown>}|null|undefined} req
 * @returns {'zh-CN'|'en'}
 */
export function resolveRequestLocale(req) {
  try {
    const headers = req && typeof req === 'object' && req.headers && typeof req.headers === 'object'
      ? req.headers
      : {};
    const fromCookie = normalizeLocale(readLocaleCookie(headers.cookie));
    if (fromCookie !== null) return fromCookie;
    const fromHeader = parseAcceptLanguage(headers['accept-language']);
    if (fromHeader !== null) return fromHeader;
    return DEFAULT_LOCALE;
  } catch {
    // 兜底：谈判逻辑本身不该抛，但「任何脏输入都不许抛」是硬契约，宁可落回缺省也不冒 500 的险。
    return DEFAULT_LOCALE;
  }
}
