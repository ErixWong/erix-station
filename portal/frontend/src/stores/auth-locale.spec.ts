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

/**
 * 把**两个本地载体都清干净**（cookie + localStorage），但不动当前 i18n 值。
 * #828 新语义下，账号语言值只在「本地没表过态」时生效——验证「应用账号值」一类用例
 * 必须先走到这个态（模拟换设备 / 清了站点数据），否则 beforeEach 留下的 cookie+localStorage
 * 会被当成「已表过态」而拦住账号值。每个用例开头都会 resetLocale，彼此不串台。
 */
function clearLocalLocale() {
  localStorage.clear();
  document.cookie = 'locale=; Path=/; Max-Age=0';
}

beforeEach(() => {
  setActivePinia(createPinia());
  resetLocale('zh-CN');
});
afterEach(() => {
  vi.unstubAllGlobals();
  // #828：多个用例会 `vi.spyOn(Storage.prototype, 'setItem')` 钉「没写持久化」；
  // 不还原的话 spy 会跨用例累积，后面的防打转用例会误报到前面用例的 setItem。
  vi.restoreAllMocks();
});

describe('#828 登录后应用账号语言', () => {
  it('本地未表态（cookie+localStorage 都空）且 /api/me 返回 en ⇒ 应用成 en，cookie 与 localStorage 写上（换设备生效）', async () => {
    clearLocalLocale(); // 两个本地载体都空：模拟换设备 / 清了站点数据
    vi.stubGlobal('fetch', fetchMock(() => json(200, { user: { ...FDE, locale: 'en' } })));
    const auth = useAuthStore();
    await auth.ensureMe();
    expect(i18n.global.locale.value).toBe('en');
    expect(readLocaleCookie()).toBe('en');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });

  it('本地已表过态（cookie 或 localStorage 为 zh-CN）而账号值是 en ⇒ refreshMe 后界面仍是 zh-CN（缺陷②的钉子）', async () => {
    resetLocale('zh-CN'); // cookie + localStorage 均为 zh-CN：本地已表过态
    const setItem = vi.spyOn(Storage.prototype, 'setItem'); // 基线写发生在 spy 之前
    vi.stubGlobal('fetch', fetchMock(() => json(200, { user: { ...FDE, locale: 'en' } })));
    const auth = useAuthStore();
    await auth.refreshMe(); // /api/me 账号值是过期的 en
    expect(i18n.global.locale.value).toBe('zh-CN'); // 本地选择说话，不被账号值盖掉
    expect(readLocaleCookie()).toBe('zh-CN');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN');
    expect(setItem).not.toHaveBeenCalled(); // setLocale 没被账号值调用（去掉「本地已表态就不抢」那道判断即变红）
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

  it('本地未表态且 /api/me 返回与当前相同的 en ⇒ 不重复 setLocale（防打转：只发一次请求、不再写持久化）', async () => {
    resetLocale('en'); // 先把当前界面语言设为 en
    clearLocalLocale(); // 再清掉两个本地载体：让「不切」只能靠「与当前相同」这道判断（而非 hasLocal）
    const setItem = vi.spyOn(Storage.prototype, 'setItem'); // 基线写与清载体都发生在 spy 之前
    const fetchFn = fetchMock(() => json(200, { user: { ...FDE, locale: 'en' } }));
    vi.stubGlobal('fetch', fetchFn);
    const auth = useAuthStore();
    await auth.ensureMe();
    expect(fetchFn).toHaveBeenCalledTimes(1); // 只发一次 /api/me
    expect(setItem).not.toHaveBeenCalled(); // 同值 ⇒ 不重写 localStorage（去掉「比对当前值」这一步即变红）
    expect(i18n.global.locale.value).toBe('en');
  });

  it('login 直通：本地未表态且 user.locale=en ⇒ 界面与持久化切到 en', async () => {
    clearLocalLocale();
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

  it('submitTotp 第二步：本地未表态且 user.locale=en ⇒ 应用并同步持久化', async () => {
    clearLocalLocale();
    vi.stubGlobal('fetch', fetchMock(() => json(200, { user: { ...FDE, locale: 'en' } })));
    const auth = useAuthStore();
    auth.pendingToken = 'ptok';
    await auth.submitTotp('123456');
    expect(i18n.global.locale.value).toBe('en');
    expect(readLocaleCookie()).toBe('en');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });

  it('submitEmailCode 第二步：本地未表态且 user.locale=en ⇒ 应用', async () => {
    clearLocalLocale();
    vi.stubGlobal('fetch', fetchMock(() => json(200, { user: { ...FDE, locale: 'en' } })));
    const auth = useAuthStore();
    auth.pendingToken = 'ptok';
    await auth.submitEmailCode('123456');
    expect(i18n.global.locale.value).toBe('en');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });
});
