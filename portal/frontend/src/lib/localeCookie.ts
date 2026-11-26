// 语言偏好的跨 origin 载体（issue #804）：同站 cookie。
//
// 为什么必须有它（不是「再加一份存储」，而是换载体）：语言偏好此前只存 localStorage
// （`src/i18n/index.ts` 的 LOCALE_STORAGE_KEY），而 localStorage 按 **origin** 隔离；
// 管理台入口是 `admin.<伞域>:<端口>`、用户面是 `station.<伞域>`，两个 host 各发一份 SPA
// ⇒ 用户面切的英文，管理台读不到，只能按 navigator.language 重新检测（中文浏览器恒中文）。
// 同站 cookie（Domain = 父域）是浏览器里唯一能跨子域可见的客户端存储，且**不是凭据**，
// 泄露面只有「界面语言」。
//
// 为什么同时保留 localStorage：隐私模式/禁用 cookie 时 document.cookie 写不进读不出，
// 那条路必须继续能用（同一会话内仍然生效）。cookie 优先只在「两边都有」时生效。
//
// 三条硬口径：
//   1. **Domain 推导是保守的**：只有 hostname ≥3 段且不是 IP 才下发 Domain（去最左一段）；
//      否则退回 host-only cookie。宁可少共享，也不能把偏好发到不该收到的 host 上。
//   2. **不猜语言值**：读回来的值由调用方（`src/i18n`）用 isAppLocale 校验；本模块只搬运字符串。
//   3. **序列化是纯函数**：Domain/Secure 这些属性在 jsdom 里受 document.domain 限制（宿主名不匹配时
//      浏览器/jsdom 会直接丢掉带 Domain 的 cookie），所以「拼对了没有」必须能在纯函数上断言，
//      不能只断言 document.cookie。

/** cookie 名（与 localStorage 键同名是刻意的：两边语义一致，不是两个偏好）。 */
export const LOCALE_COOKIE_NAME = 'locale';

/** 一年（秒）。语言偏好是长期偏好，跟着设备走。 */
export const LOCALE_COOKIE_MAX_AGE = 31536000;

/** 是否像 IP（IPv4 点分十进制或 IPv6 含冒号）：IP 上不能设 Domain。 */
function looksLikeIp(hostname: string): boolean {
  return /^[\d.]+$/.test(hostname) || hostname.includes(':');
}

/**
 * 由 hostname 推 cookie 的 `Domain`。**拿不到就返回 null（host-only），不要猜。**
 * `admin.<伞域>` / `station.<伞域>` ⇒ `<伞域>`（去最左一段，两 host 因此共享同一份偏好）；
 * `localhost` / `127.0.0.1` / 两段 hostname ⇒ null（开发期用 IP 访问时自动 fail-open）。
 */
export function localeCookieDomainOf(hostname: string): string | null {
  const h = (hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || looksLikeIp(h)) return null;
  const parts = h.split('.');
  if (parts.length < 3) return null;
  const parent = parts.slice(1).join('.');
  return parent.includes('.') ? parent : null;
}

/** 拼 cookie 字面量（纯函数，属性顺序即输出顺序，便于断言）。 */
export function serializeLocaleCookie(
  value: string,
  opts: { hostname?: string; secure?: boolean } = {},
): string {
  const host = opts.hostname ?? (typeof window !== 'undefined' ? window.location.hostname : '');
  const secure = opts.secure ?? (typeof window !== 'undefined' ? window.location.protocol === 'https:' : false);
  const domain = localeCookieDomainOf(host);
  const parts = [
    `${LOCALE_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${LOCALE_COOKIE_MAX_AGE}`,
    'SameSite=Lax',
  ];
  if (domain) parts.push(`Domain=${domain}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** 读 cookie 里的偏好原值；没有/不可读 ⇒ null（不校验语言合法性，那是调用方的事）。 */
export function readLocaleCookie(): string | null {
  try {
    const raw = typeof document !== 'undefined' ? document.cookie : '';
    if (!raw) return null;
    for (const pair of raw.split(';')) {
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      if (pair.slice(0, idx).trim() !== LOCALE_COOKIE_NAME) continue;
      const v = decodeURIComponent(pair.slice(idx + 1).trim());
      return v === '' ? null : v;
    }
  } catch {
    /* 禁用 cookie / 不可解码：当作没有偏好 */
  }
  return null;
}

/** 写偏好 cookie（双写由调用方 `setLocale` 负责，这里只管 cookie）。 */
export function writeLocaleCookie(value: string): void {
  try {
    if (typeof document !== 'undefined') document.cookie = serializeLocaleCookie(value);
  } catch {
    /* 忽略：退化成只有 localStorage */
  }
}

/** 清掉偏好 cookie（必须与写入时同样的 Domain/Path 属性才删得掉）。 */
export function clearLocaleCookie(): void {
  try {
    if (typeof document === 'undefined') return;
    const host = window.location.hostname;
    const domain = localeCookieDomainOf(host);
    document.cookie = `${LOCALE_COOKIE_NAME}=; Path=/${domain ? `; Domain=${domain}` : ''}; Max-Age=0; SameSite=Lax`;
  } catch {
    /* 同上 */
  }
}
