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

/**
 * 「这台浏览器上用户**亲自点过**语言开关」标记的 cookie 名（#902 ①）。
 *
 * 为什么要有它（而不是只有 localStorage 那份标记）：`locale` 偏好本身是 `Domain=父域` 的
 * 跨子域 cookie（管理台与用户面是两个 origin 共享同一份），可「点过开关」这个事实此前只落在
 * **localStorage**（按 origin 隔离、两边各一份）⇒ 在管理台点了 English、切到用户面 origin 就看不到
 * 标记 ⇒ 账号默认语言盖掉那份**共享** cookie ⇒ 回到管理台又变回账号语言。标记必须跟偏好**同作用域**，
 * 判据才不会被两个 host 各算各的。属性（Domain/Secure/…）与 `locale` 走同一套推导，见下。
 */
export const LOCALE_CHOSEN_COOKIE_NAME = 'locale_chosen';

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

/**
 * 拼 cookie 字面量（纯函数，属性顺序即输出顺序，便于断言）——**同族共用**这一段：
 * `locale` 偏好与 `locale_chosen` 标记只差 cookie 名，Domain/Secure/Path/Max-Age/SameSite 全共用，
 * 所以标记与偏好天然同作用域（这正是 #902 ① 要的性质）。`localeCookieDomainOf` 只认 hostname，
 * 与 cookie 名无关，故两个名字拿到的 Domain 完全一致。
 */
export function serializeCookie(
  name: string,
  value: string,
  opts: { hostname?: string; secure?: boolean } = {},
): string {
  const host = opts.hostname ?? (typeof window !== 'undefined' ? window.location.hostname : '');
  const secure = opts.secure ?? (typeof window !== 'undefined' ? window.location.protocol === 'https:' : false);
  const domain = localeCookieDomainOf(host);
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${LOCALE_COOKIE_MAX_AGE}`,
    'SameSite=Lax',
  ];
  if (domain) parts.push(`Domain=${domain}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** `locale` 偏好 cookie 的序列化（保留的名字与签名不变，现有测试照钉它产 `locale=`）。 */
export function serializeLocaleCookie(
  value: string,
  opts: { hostname?: string; secure?: boolean } = {},
): string {
  return serializeCookie(LOCALE_COOKIE_NAME, value, opts);
}

/** 按名读 cookie 原值（同族共用）；没有/不可读 ⇒ null（不校验语义，那是调用方的事）。 */
function readCookieValue(name: string): string | null {
  try {
    const raw = typeof document !== 'undefined' ? document.cookie : '';
    if (!raw) return null;
    for (const pair of raw.split(';')) {
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      if (pair.slice(0, idx).trim() !== name) continue;
      const v = decodeURIComponent(pair.slice(idx + 1).trim());
      return v === '' ? null : v;
    }
  } catch {
    /* 禁用 cookie / 不可解码：当作没有 */
  }
  return null;
}

/** 按名清 cookie（同族共用；必须与写入时同样的 Domain/Path 属性才删得掉）。 */
function clearCookieByName(name: string): void {
  try {
    if (typeof document === 'undefined') return;
    const host = window.location.hostname;
    const domain = localeCookieDomainOf(host);
    document.cookie = `${name}=${domain ? `; Domain=${domain}` : ''}; Path=/; Max-Age=0; SameSite=Lax`;
  } catch {
    /* 忽略 */
  }
}

/** 读偏好 cookie 里的语言原值；没有/不可读 ⇒ null（不校验语言合法性，那是调用方的事）。 */
export function readLocaleCookie(): string | null {
  return readCookieValue(LOCALE_COOKIE_NAME);
}

/**
 * 读「用户亲自点过开关」标记 cookie（#902 ①）：值 `'1'` ⇒ `true`，其它/没有/不可读 ⇒ `false`。
 * 这就是跨子域可见的那一份标记，和 localStorage 那份由 `hasUserChosenLocale` 取「或」。
 */
export function readLocaleChosenCookie(): boolean {
  return readCookieValue(LOCALE_CHOSEN_COOKIE_NAME) === '1';
}

/** 写偏好 cookie（双写由调用方 `setLocale` 负责，这里只管 cookie）。 */
export function writeLocaleCookie(value: string): void {
  try {
    if (typeof document !== 'undefined') document.cookie = serializeLocaleCookie(value);
  } catch {
    /* 忽略：退化成只有 localStorage */
  }
}

/**
 * 写「用户亲自点过开关」标记 cookie（#902 ①）：值 `'1'`，属性走与 `locale` 同一套推导
 * （`serializeCookie` ⇒ 同一个 `Domain=父域`），所以标记和偏好跨子域可见性一致。
 * 只在用户亲自点开关时写（见 `src/i18n` 的 `setLocale` 的 `fromUser`）；写失败静默，退化成「像新设备」。
 */
export function writeLocaleChosenCookie(): void {
  try {
    if (typeof document !== 'undefined') {
      document.cookie = serializeCookie(LOCALE_CHOSEN_COOKIE_NAME, '1');
    }
  } catch {
    /* 忽略：退化成只有 localStorage 那份标记 */
  }
}

/** 清掉偏好 cookie（必须与写入时同样的 Domain/Path 属性才删得掉）。 */
export function clearLocaleCookie(): void {
  clearCookieByName(LOCALE_COOKIE_NAME);
}

/** 清掉「用户亲自点过开关」标记 cookie（与偏好一起清 ⇒「清站点数据 ⇒ 回到新设备」这条性质不变，#902 ①）。 */
export function clearLocaleChosenCookie(): void {
  clearCookieByName(LOCALE_CHOSEN_COOKIE_NAME);
}
