// issue #828 P2：登录后应用账号语言偏好（GET /api/me 与三条登录路径）。
// 断言一律走请求桩 + DOM（document.cookie / localStorage / i18n 当前 locale），不用 w.emitted()。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAuthStore } from './auth';
import { i18n, LOCALE_STORAGE_KEY, setLocale } from '../i18n';
import { readLocaleCookie } from '../lib/localeCookie';

const FDE = {
  id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  });
}

/** 把语言偏好重置到指定值（清 cookie + localStorage 后 setLocale 双写一遍，建立已知基线）。 */
function resetLocale(to: 'zh-CN' | 'en') {
  localStorage.clear();
  document.cookie = 'locale=; Path=/; Max-Age=0';
  setLocale(to);
}

beforeEach(() => {
  setActivePinia(createPinia());
  resetLocale('zh-CN');
});
afterEach(() => vi.unstubAllGlobals());

describe('#828 登录后应用账号语言', () => {
  it('ensureMe：/api/me 返回 en ⇒ 界面变 en，cookie 与 localStorage 同步', async () => {
    vi.stubGlobal('fetch', fetchMock(() => json(200, { user: { ...FDE, locale: 'en' } })));
    const auth = useAuthStore();
    await auth.ensureMe();
    expect(i18n.global.locale.value).toBe('en');
    expect(readLocaleCookie()).toBe('en');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });

  it('ensureMe：/api/me 返回 null ⇒ 什么都不变（cookie/localStorage 不被改写，也不回落到 zh-CN）', async () => {
    resetLocale('en'); // 当前 en：cookie + localStorage 均为 en
    vi.stubGlobal('fetch', fetchMock(() => json(200, { user: { ...FDE, locale: null } })));
    const auth = useAuthStore();
    await auth.ensureMe();
    expect(i18n.global.locale.value).toBe('en'); // 没被动
    expect(readLocaleCookie()).toBe('en'); // 没被改写
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });

  it('ensureMe：/api/me 返回与当前相同的 en ⇒ 不重复 setLocale（防打转：只发一次请求、不再写持久化）', async () => {
    resetLocale('en');
    const setItem = vi.spyOn(Storage.prototype, 'setItem'); // 基线写发生在 spy 之前
    const fetchFn = fetchMock(() => json(200, { user: { ...FDE, locale: 'en' } }));
    vi.stubGlobal('fetch', fetchFn);
    const auth = useAuthStore();
    await auth.ensureMe();
    expect(fetchFn).toHaveBeenCalledTimes(1); // 只发一次 /api/me
    expect(setItem).not.toHaveBeenCalled(); // 同值 ⇒ 不重写 localStorage（去掉「比对当前值」这一步即变红）
    expect(i18n.global.locale.value).toBe('en');
  });

  it('login 直通：user.locale=en ⇒ 界面与持久化切到 en', async () => {
    vi.stubGlobal('fetch', fetchMock(() =>
      json(200, { status: 'authenticated', user: { ...FDE, locale: 'en' } })));
    const auth = useAuthStore();
    await auth.login('alice', 'secret');
    expect(i18n.global.locale.value).toBe('en');
    expect(readLocaleCookie()).toBe('en');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });

  it('login 直通：user.locale=null ⇒ 不动（当前 zh-CN 保持）', async () => {
    vi.stubGlobal('fetch', fetchMock(() =>
      json(200, { status: 'authenticated', user: { ...FDE, locale: null } })));
    const auth = useAuthStore();
    await auth.login('alice', 'secret');
    expect(i18n.global.locale.value).toBe('zh-CN');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN');
  });

  it('submitTotp 第二步：user.locale=en ⇒ 应用并同步持久化', async () => {
    vi.stubGlobal('fetch', fetchMock(() => json(200, { user: { ...FDE, locale: 'en' } })));
    const auth = useAuthStore();
    auth.pendingToken = 'ptok';
    await auth.submitTotp('123456');
    expect(i18n.global.locale.value).toBe('en');
    expect(readLocaleCookie()).toBe('en');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });

  it('submitEmailCode 第二步：user.locale=en ⇒ 应用', async () => {
    vi.stubGlobal('fetch', fetchMock(() => json(200, { user: { ...FDE, locale: 'en' } })));
    const auth = useAuthStore();
    auth.pendingToken = 'ptok';
    await auth.submitEmailCode('123456');
    expect(i18n.global.locale.value).toBe('en');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });
});
