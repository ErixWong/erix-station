// LocaleSwitch 单测（issue #101 P1）：菜单文案、切换生效 + 持久化、刷新后保持，
// 以及 i18n 基建的语言检测优先级（cookie → localStorage → 浏览器语言 → 兜底 zh-CN，#804）。
// 用真实 i18n 单例（与 main.ts 装配一致），不 mock t()。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import LocaleSwitch from './LocaleSwitch.vue';
import { LOCALE_STORAGE_KEY, createAppI18n, detectLocale, i18n, setLocale } from '../i18n';
import { clearLocaleCookie, readLocaleCookie, writeLocaleCookie } from '../lib/localeCookie';
import { useAuthStore } from '../stores/auth';

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
  // ⚠ #804：setLocale 现在**双写**，上面那句会顺手写下 cookie='zh-CN'；cookie 必须在它之后清，
  // 否则默认态就带着一份 cookie 偏好，会把「localStorage 优先于浏览器语言」这类用例挤到 cookie
  // 分支上去。jsdom 的 document.cookie 在同一文件里是共享的，不清就会跳用例污染。
  clearLocaleCookie();
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
    // #804：cookie 那份必须同步写上，否则管理台（另一个 origin）依旧读不到。
    expect(readLocaleCookie()).toBe('en');
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

  // 以下三条是 #804 换载体后的新口径：cookie 是跨 origin 那一份，所以它赢，但只对**合法值**赢。
  it('cookie 与 localStorage 冲突 ⇒ cookie 优先（不共享的那份不能反过来覆盖共享的那份）', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN');
    writeLocaleCookie('en');
    expect(detectLocale()).toBe('en');
  });

  it('cookie 脏值（非受支持语言）忽略 ⇒ 落回 localStorage；localStorage 也没有 ⇒ 落回浏览器语言', () => {
    document.cookie = 'locale=fr; Path=/';

    localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    stubBrowserLanguage('zh-CN');
    expect(detectLocale()).toBe('en'); // 脏 cookie 不得抢在合法 localStorage 之前

    localStorage.clear();
    expect(detectLocale()).toBe('zh-CN'); // 也不能把浏览器语言吞掉
  });

  it('禁用存储（localStorage 与 cookie 两种持久化都坏）：setLocale 本次会话仍生效，只是没持久化', () => {
    // 两种持久化都坏才算真兜底：光让 setItem 抛错只能证「localStorage 坏了本次仍生效」，
    // 但 setLocale 之后还会写 cookie，必须把 cookie 也变成写不进，才能证明「两种都坏仍生效」。
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    // cookie 也写不进（afterEach 的 vi.restoreAllMocks() 会复原这个 accessor spy，不污染后续用例）。
    vi.spyOn(document, 'cookie', 'set').mockImplementation(() => {
      throw new Error('cookie disabled');
    });
    setLocale('en');
    expect(i18n.global.locale.value).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });
});

// #828 P2：已登录时切换器顺手回写 PATCH /api/me/locale（失败静默）；未登录不发。
describe('LocaleSwitch · #828 回写账号语言', () => {
  function mountWithAuth(loggedIn: boolean): VueWrapper {
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = loggedIn
      ? { id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local' }
      : null;
    return mount(LocaleSwitch, { global: { plugins: [pinia, i18n] } });
  }

  function stubFetch(responder: () => Response) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      return responder();
    }));
    return calls;
  }

  it('已登录点 English ⇒ 发一次 PATCH /api/me/locale，body {"locale":"en"}', async () => {
    const calls = stubFetch(() => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const w = mountWithAuth(true);
    await pick(w, 'English');
    await flushPromises();
    const patch = calls.filter((c) => c.url === '/api/me/locale');
    expect(patch).toHaveLength(1);
    expect(patch[0].init?.method).toBe('PATCH');
    expect(JSON.parse(String(patch[0].init?.body))).toEqual({ locale: 'en' });
  });

  it('回写返回 500 ⇒ 切换仍生效、不弹红条', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { code: 'x', message: 'boom' } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }));
    const w = mountWithAuth(true);
    await pick(w, 'English');
    await flushPromises();
    expect(i18n.global.locale.value).toBe('en'); // 界面已切过去
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
    expect(w.find('button').text()).toContain('English');
    expect(w.find('[role="alert"]').exists()).toBe(false); // 不弹红条
  });

  it('未登录点 English ⇒ 一个请求都不发（切换仍只落 cookie+localStorage）', async () => {
    const calls = stubFetch(() => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const w = mountWithAuth(false);
    await pick(w, 'English');
    await flushPromises();
    expect(calls).toHaveLength(0);
    expect(i18n.global.locale.value).toBe('en'); // 本地切换照常生效
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });
});
