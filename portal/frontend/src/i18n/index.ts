// i18n 基建（issue #101 P1）：createI18n（Composition API 模式）+ 语言检测 + 持久化。
//
// 语言优先级（#101 定的方案，#804 换了载体）：cookie('locale') 合法值 → localStorage('locale') 合法值
// → 浏览器语言（zh 开头 → zh-CN，否则 en）→ 兜底 zh-CN。偏好存 cookie + localStorage 两个本地载体；
// #828 起账号也存一份 `users.locale`（服务端字段，登录后由前端经 setLocale 灌进上面两个载体）。优先级：
// 本地已切过的优先（cookie → localStorage）；账号值只是「这台浏览器初次见面的种子」——用户**亲自点过
// 语言开关**（`locale.userChosen` 标记，见 `hasUserChosenLocale`）之后本地值说话、账号默认语言不再来抢
// （要不要跟随的判据在 stores/auth 的 applyAccountLocale）。「不上传服务端/用户表」这句在 #828 后已不成立。
// 为什么 cookie 排在 localStorage 之前（#804）：管理台 `admin.<伞域>:<端口>` 与用户面 `station.<伞域>`
// 是两个 **origin**，而 localStorage 按 origin 隔离、两边各存一份互不相通 ⇒ 用户面切了英文，管理台
// 还是读不到。同站 cookie（Domain = 父域）两边都看得见，所以「两边都有」时以 cookie 为准；
// localStorage 继续保留是兜底：禁用 cookie / 隐私模式下它同一会话内仍然能用（那条路不能断）。
// key 类型：locales/zh-CN.ts 的 MessageSchema 经 vue-i18n 泛型 + DefineLocaleMessage 注入（见 types.d.ts）。

import { createI18n } from 'vue-i18n';
import { readLocaleCookie, writeLocaleCookie } from '../lib/localeCookie';
import { zhCN, type MessageSchema } from './locales/zh-CN';
import { en } from './locales/en';

/** 支持的 locale 列表（新增语言时同步补 locales/<locale>.ts 与 messages）。 */
export const LOCALES = ['zh-CN', 'en'] as const;
export type AppLocale = (typeof LOCALES)[number];

/** 兜底语言：无持久化偏好且浏览器语言未知时使用。 */
export const DEFAULT_LOCALE: AppLocale = 'zh-CN';

/** localStorage 中语言偏好的键名。 */
export const LOCALE_STORAGE_KEY = 'locale';

/**
 * localStorage 中「这台浏览器上用户**亲自点过**语言开关」标记的键名（#828 复核查）。
 *
 * 为什么另起一个键而不是复用载体（cookie/localStorage 里的 locale 值）：`setLocale` 会双写载体，
 * 而账号种子初次登录时也会走 `setLocale` ⇒ 载体里很快就有了值，「载体里有没有值」从此恒真，
 * 没法区分「用户选的」和「账号灌进来的」。这个标记**只在用户亲自点开关时**立（见 `setLocale` 的
 * `fromUser`），账号种子不立它 ⇒ 「要不要跟随账号默认语言」的判据才不会被种子自己污染。
 */
export const LOCALE_USER_CHOSEN_KEY = 'locale.userChosen';

/** 运行时判定字符串是否为受支持的 locale（localStorage 里可能是任意脏值）。 */
export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** 读取 localStorage 偏好；隐私模式/禁用存储时静默降级为「无偏好」。 */
function readStoredLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * 本地（这个浏览器）是否已经对语言**表过态**：同站 cookie 或 localStorage 任一持有受支持的
 * 合法值即算「表过态」。#828：这是「要不要应用账号上存的语言值」的唯一判据（见 `stores/auth`
 * 的 `applyAccountLocale`）。
 *
 * 语义：**账号值是「这台浏览器/设备第一次见面时的种子」，不是「压过本地选择的主人」**。
 * 换设备 / 清了站点数据时两个载体都空 ⇒ 账号值生效；同一浏览器里用户点过语言开关之后
 * （`setLocale` 会双写 cookie + localStorage）⇒ 本地值说话，账号值不得反过来盖掉刚选的那个。
 *
 * 两个载体都要看的原因：cookie 是**唯一跨 origin** 的那一份（管理台与用户面是两个 host，
 * localStorage 各存各的，#804），localStorage 是禁 cookie/隐私模式时的兜底——任一有有效值
 * 都说明「这个浏览器已经有人做过选择」，不能只查 cookie 而漏掉只在 localStorage 表过态的情形。
 */
export function hasLocalLocalePreference(): boolean {
  if (isAppLocale(readLocaleCookie())) return true;
  return isAppLocale(readStoredLocale());
}

/**
 * 这台浏览器上用户是否**亲自点过**语言开关（只读 `locale.userChosen` 标记，载体里有值不算）。
 *
 * 这是「要不要跟随账号默认语言」的唯一判据（见 `stores/auth` 的 `applyAccountLocale`）：
 * - **没点过** ⇒ 账号默认语言变了会跟随（含初次登录灌种子、以及用户后来在别处改了账号默认语言）；
 * - **点过** ⇒ 本地说话，账号值不再抢（这台浏览器是用户自己定的语言，账号值只是初次见面的种子）；
 * - **清了站点数据** ⇒ 标记随载体一起没了 ⇒ 回到「新设备」= 账号值重新生效。
 *
 * 隐私模式/禁用存储 ⇒ 静默返回 false（标记立不起来，退化成「每次都像新设备」，账号种子仍可用）。
 */
export function hasUserChosenLocale(): boolean {
  try {
    return localStorage.getItem(LOCALE_USER_CHOSEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** 按优先级检测初始语言：cookie → localStorage → navigator.language → zh-CN（#804）。 */
export function detectLocale(): AppLocale {
  // cookie 先：它是唯一跨 origin 可见的那一份（管理台与用户面是两个 host，localStorage 各存各的）。
  // 值在这里就要过 isAppLocale：cookie 是用户可以自己改的输入，脏值不能直接当 locale 用。
  const fromCookie = readLocaleCookie();
  if (isAppLocale(fromCookie)) return fromCookie;

  const stored = readStoredLocale();
  if (isAppLocale(stored)) return stored;

  // 非浏览器环境（无 navigator）走兜底；浏览器语言为 zh 开头取 zh-CN，其余一律 en。
  const nav = typeof navigator !== 'undefined' ? navigator.language : '';
  if (!nav) return DEFAULT_LOCALE;
  return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/** 构造 i18n 实例（单测用它模拟「刷新后按持久化偏好初始化」）。 */
export function createAppI18n() {
  return createI18n<[MessageSchema], AppLocale, false>({
    legacy: false,
    locale: detectLocale(),
    fallbackLocale: DEFAULT_LOCALE,
    messages: { 'zh-CN': zhCN, en },
  });
}

/** 全局 i18n 实例（main.ts `app.use(i18n)`；非组件上下文可用 i18n.global.t）。 */
export const i18n = createAppI18n();

/**
 * 切换语言：改 i18n 当前 locale（响应式生效）+ 同步 <html lang> + 双写偏好（cookie + localStorage）。
 * 只接受受支持的 locale（调用方传字面量即可，类型已约束）。
 *
 * `opts.fromUser === true` 表示**用户亲自点了语言开关**：额外立 `locale.userChosen` 标记（#828）。
 * 账号语言种子（`applyAccountLocale`）调用时**不传** `fromUser` ⇒ 不立标记，这样「跟随账号默认语言」
 * 的判据（`hasUserChosenLocale`）不会被种子自己污染。
 */
export function setLocale(locale: AppLocale, opts?: { fromUser?: boolean }): void {
  i18n.global.locale.value = locale;
  document.documentElement.lang = locale;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* 隐私模式/禁用存储：本次会话仍生效，仅不持久化 */
  }
  // cookie 是**跨 origin** 那一份（#804）：两边都写，读取时 cookie 优先。
  // 必须独立 try/catch（不能塞进上面那个）：任一边写不进都只影响持久化，不影响本次切换生效。
  try {
    writeLocaleCookie(locale);
  } catch {
    /* 禁用 cookie：退化成只有 localStorage（同一会话内仍生效） */
  }
  // #828：只有用户亲自点开关才立「这台浏览器用户表过态」的标记；账号种子不立（否则种子会把自己
  // 当成用户的选择，导致此后账号默认语言变化永不生效）。写失败静默，退化成「像新设备」。
  if (opts?.fromUser === true) {
    try {
      localStorage.setItem(LOCALE_USER_CHOSEN_KEY, '1');
    } catch {
      /* 隐私模式/禁用存储：标记立不起来，下次仍按「没点过」跟随账号值 */
    }
  }
}

// 初始加载同步 <html lang>（index.html 静态值为 zh-CN，需按检测结果纠正）。
document.documentElement.lang = i18n.global.locale.value;
