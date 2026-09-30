// i18n 基建（issue #101 P1）：createI18n（Composition API 模式）+ 语言检测 + 持久化。
//
// 语言优先级（见 issue #101 方案）：localStorage('locale') 合法值 → 浏览器语言（zh 开头 → zh-CN，否则 en）
// → 兜底 zh-CN。偏好只存 localStorage（不上传服务端/用户表）。
// key 类型：locales/zh-CN.ts 的 MessageSchema 经 vue-i18n 泛型 + DefineLocaleMessage 注入（见 types.d.ts）。

import { createI18n } from 'vue-i18n';
import { zhCN, type MessageSchema } from './locales/zh-CN';
import { en } from './locales/en';

/** 支持的 locale 列表（新增语言时同步补 locales/<locale>.ts 与 messages）。 */
export const LOCALES = ['zh-CN', 'en'] as const;
export type AppLocale = (typeof LOCALES)[number];

/** 兜底语言：无持久化偏好且浏览器语言未知时使用。 */
export const DEFAULT_LOCALE: AppLocale = 'zh-CN';

/** localStorage 中语言偏好的键名。 */
export const LOCALE_STORAGE_KEY = 'locale';

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

/** 按优先级检测初始语言：localStorage → navigator.language → zh-CN。 */
export function detectLocale(): AppLocale {
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
 * 切换语言：改 i18n 当前 locale（响应式生效）+ 同步 <html lang> + 写入 localStorage 偏好。
 * 只接受受支持的 locale（调用方传字面量即可，类型已约束）。
 */
export function setLocale(locale: AppLocale): void {
  i18n.global.locale.value = locale;
  document.documentElement.lang = locale;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* 隐私模式/禁用存储：本次会话仍生效，仅不持久化 */
  }
}

// 初始加载同步 <html lang>（index.html 静态值为 zh-CN，需按检测结果纠正）。
document.documentElement.lang = i18n.global.locale.value;
