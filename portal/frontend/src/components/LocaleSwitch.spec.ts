// LocaleSwitch 单测（issue #101 P1）：菜单文案、切换生效 + 持久化、刷新后保持，
// 以及 i18n 基建的语言检测优先级（localStorage → 浏览器语言 → 兜底 zh-CN）。
// 用真实 i18n 单例（与 main.ts 装配一致），不 mock t()。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import LocaleSwitch from './LocaleSwitch.vue';
import { LOCALE_STORAGE_KEY, createAppI18n, detectLocale, i18n, setLocale } from '../i18n';

function mountSwitch(): VueWrapper {
  return mount(LocaleSwitch, { global: { plugins: [i18n] } });
}

function menuItems(wrapper: VueWrapper) {
  return wrapper.findAll('[role="menuitem"]');
}

/** 展开下拉并点选指定语言（'中文' / 'English'）。 */
async function pick(wrapper: VueWrapper, label: '中文' | 'English') {
  await wrapper.find('button').trigger('click');
  const target = menuItems(wrapper).find((i) => i.text() === label);
  if (!target) throw new Error(`菜单项 ${label} 不存在`);
  await target.trigger('click');
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LocaleSwitch', () => {
  it('默认 zh-CN：按钮显示当前语言，展开后两项为「中文」/「English」', async () => {
    const wrapper = mountSwitch();
    expect(wrapper.find('button').text()).toContain('中文');
    expect(wrapper.find('button').attributes('aria-expanded')).toBe('false');
    expect(menuItems(wrapper)).toHaveLength(0); // 默认收起

    await wrapper.find('button').trigger('click');
    expect(menuItems(wrapper).map((i) => i.text())).toEqual(['中文', 'English']);
    expect(wrapper.find('button').attributes('aria-expanded')).toBe('true');
  });

  it('切到 English：按钮文案变英文、菜单收起、localStorage 与 <html lang> 同步', async () => {
    const wrapper = mountSwitch();
    await pick(wrapper, 'English');

    expect(wrapper.find('button').text()).toContain('English');
    expect(wrapper.find('button').attributes('aria-label')).toBe('Language'); // locale.* 文案随语言变
    expect(menuItems(wrapper)).toHaveLength(0); // 选完自动收起
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('刷新后保持：localStorage 已存 en，重建 i18n 仍按 en 初始化', async () => {
    const wrapper = mountSwitch();
    await pick(wrapper, 'English');

    // 「刷新」= 重新走一遍 detectLocale + createI18n（index.ts 的初始化路径）
    expect(detectLocale()).toBe('en');
    expect(createAppI18n().global.locale.value).toBe('en');
  });
});

describe('locale 检测优先级（i18n 基建）', () => {
  function stubBrowserLanguage(language: string) {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue(language);
  }

  it('localStorage 合法偏好优先于浏览器语言', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    stubBrowserLanguage('zh-CN');
    expect(detectLocale()).toBe('en');
  });

  it('localStorage 脏值忽略：浏览器语言 zh 开头 → zh-CN，否则 en', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'fr-FR'); // 非受支持值
    stubBrowserLanguage('zh-TW');
    expect(detectLocale()).toBe('zh-CN');

    stubBrowserLanguage('fr-FR');
    expect(detectLocale()).toBe('en');
  });

  it('无偏好且浏览器语言为空 → 兜底 zh-CN', () => {
    stubBrowserLanguage('');
    expect(detectLocale()).toBe('zh-CN');
  });
});
