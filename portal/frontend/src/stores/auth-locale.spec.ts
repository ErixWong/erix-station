// issue #828 P2：登录后应用账号语言偏好（GET /api/me 与三条登录路径）。
// 断言一律走请求桩 + DOM（document.cookie / localStorage / i18n 当前 locale），不用 w.emitted()。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import { useAuthStore, NO_SESSION_LOCALE_OWNER } from './auth';
import { i18n, LOCALE_STORAGE_KEY, LOCALE_USER_CHOSEN_KEY, setLocale } from '../i18n';
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
  it('本地未表态（cookie+localStorage 都空）且 /api/me 返回 en ⇒ 应用成 en，cookie 与 localStorage 写上（换设备生效），且不立用户标记', async () => {
    clearLocalLocale(); // 两个本地载体都空：模拟换设备 / 清了站点数据
    vi.stubGlobal('fetch', fetchMock(() => json(200, { user: { ...FDE, locale: 'en' } })));
    const auth = useAuthStore();
    await auth.ensureMe();
    expect(i18n.global.locale.value).toBe('en');
    expect(readLocaleCookie()).toBe('en');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
    // #828 复核查：账号种子**不立** `locale.userChosen` 标记（否则种子会把自己当成用户的选择，
    // 导致此后账号默认语言变化永不生效）。
    expect(localStorage.getItem(LOCALE_USER_CHOSEN_KEY)).toBeNull();
  });

  it('账号种子不立标记⇒未点过开关的浏览器上，账号默认语言从 en 改成 zh-CN 会跟随（旧缺陷：载体有值把它永久挡掉）', async () => {
    clearLocalLocale();
    vi.stubGlobal('fetch', fetchMock(() => json(200, { user: { ...FDE, locale: 'en' } })));
    const auth = useAuthStore();
    await auth.ensureMe();
    expect(i18n.global.locale.value).toBe('en');
    expect(localStorage.getItem(LOCALE_USER_CHOSEN_KEY)).toBeNull(); // 种子不立标记
    // 用户后来在别处把账号默认语言改成 zh-CN ⇒ 这台没点过开关的浏览器应跟随。
    vi.stubGlobal('fetch', fetchMock(() => json(200, { user: { ...FDE, locale: 'zh-CN' } })));
    await auth.refreshMe();
    expect(i18n.global.locale.value).toBe('zh-CN'); // 旧代码：载体里已是 en ⇒ hasLocalLocalePreference 恒真→不跟随（会变红）
    expect(readLocaleCookie()).toBe('zh-CN');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN');
  });

  it('用户亲自点过开关（标记立起）而账号值是 en ⇒ 本地 zh-CN 说话、refreshMe 后仍是 zh-CN（不抢）', async () => {
    localStorage.clear();
    document.cookie = 'locale=; Path=/; Max-Age=0';
    setLocale('zh-CN', { fromUser: true }); // 用户亲自点：立标记 + 双写载体
    expect(localStorage.getItem(LOCALE_USER_CHOSEN_KEY)).toBe('1');
    const setItem = vi.spyOn(Storage.prototype, 'setItem'); // 基线写发生在 spy 之前
    vi.stubGlobal('fetch', fetchMock(() => json(200, { user: { ...FDE, locale: 'en' } })));
    const auth = useAuthStore();
    await auth.refreshMe(); // /api/me 账号值是过期的 en
    expect(i18n.global.locale.value).toBe('zh-CN'); // 本地选择说话，不被账号值盖掉
    expect(readLocaleCookie()).toBe('zh-CN');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN');
    expect(setItem).not.toHaveBeenCalled(); // setLocale 没被账号值调用（去掉「用户点过就不抢」那道判断即变红）
  });

  it('清掉标记与载体后回到「新设备」⇒ 账号值重新生效（哪怕之前点过开关）', async () => {
    localStorage.clear();
    document.cookie = 'locale=; Path=/; Max-Age=0';
    setLocale('en', { fromUser: true }); // 之前在这台浏览器上点过开关（标记已立）
    expect(localStorage.getItem(LOCALE_USER_CHOSEN_KEY)).toBe('1');
    clearLocalLocale(); // 清站点数据：标记 + 两个载体一起没
    expect(localStorage.getItem(LOCALE_USER_CHOSEN_KEY)).toBeNull();
    vi.stubGlobal('fetch', fetchMock(() => json(200, { user: { ...FDE, locale: 'en' } })));
    const auth = useAuthStore();
    await auth.ensureMe();
    expect(i18n.global.locale.value).toBe('en'); // 新设备⇒账号值生效
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

// #828 复核查：pendingLocaleWrite 带账号归属，登出/会话失效一并清理，换账号不替别人改偏好。
describe('#828 pendingLocaleWrite 账号归属与登出/失效清理', () => {
  const BOB = { ...FDE, id: 'u2', login: 'bob', fde_name: 'bob' };

  it('记下 pending 后 logout ⇒ 会话清空且 pending 被清（不隔会话残留给下一个账号）', async () => {
    const auth = useAuthStore();
    auth.user = { ...FDE }; // alice 已登录
    auth.pendingLocaleWrite = { login: 'alice', locale: 'en' };
    vi.stubGlobal('fetch', fetchMock(() => json(200, {}))); // logout POST 回 200
    await auth.logout();
    expect(auth.user).toBeNull();
    expect(auth.pendingLocaleWrite).toBeNull();
  });

  it('会话确认失效（/api/me 回 401）⇒ pending 被清（上一位的选择不能留给下一位）', async () => {
    const auth = useAuthStore();
    auth.user = { ...FDE };
    // 不设 ready：ensureMe 首行 `if (this.ready) return` 会短路；留 ready=false 才会真去拉 /api/me。
    auth.pendingLocaleWrite = { login: 'alice', locale: 'en' };
    vi.stubGlobal('fetch', fetchMock(() => json(401, { error: { code: 'unauthorized', message: 'gone' } })));
    await auth.ensureMe(); // 会话已确认失效 ⇒ user=null 分支
    expect(auth.user).toBeNull();
    expect(auth.pendingLocaleWrite).toBeNull();
  });

  it('A 记的 pending（login=alice），换成 B 登录后 flush ⇒ 不发 PATCH 且 pending 被丢弃', async () => {
    const auth = useAuthStore();
    auth.pendingLocaleWrite = { login: 'alice', locale: 'en' }; // A 记的选择，未及补发就换人
    auth.user = { ...BOB }; // 现在站着 B（login 不同，且账号值与 pending 不同）
    const fetchFn = fetchMock(() => json(200, {}));
    vi.stubGlobal('fetch', fetchFn);
    await auth.flushPendingLocale();
    await flushPromises();
    expect(auth.pendingLocaleWrite).toBeNull(); // 归属对不上 ⇒ 丢弃
    const urls = fetchFn.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    expect(urls.filter((u) => u === '/api/me/locale')).toHaveLength(0); // 一枪都不发
  });

  it('哨兵（无主）pending ⇒ 谁先就绪就补发给谁（登录后的第一个人照发）', async () => {
    const auth = useAuthStore();
    auth.pendingLocaleWrite = { login: NO_SESSION_LOCALE_OWNER, locale: 'en' };
    auth.user = { ...BOB }; // login 与哨兵不同，但哨兵=无主 ⇒ 允许补发
    const fetchFn = fetchMock(() => json(200, {}));
    vi.stubGlobal('fetch', fetchFn);
    await auth.flushPendingLocale();
    await flushPromises();
    const urls = fetchFn.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    expect(urls.filter((u) => u === '/api/me/locale')).toHaveLength(1); // 无主→发一次
    expect(auth.pendingLocaleWrite).toBeNull();
  });

  it('会话就绪后延迟补发 flushPendingLocale 失败 ⇒ 发了 PATCH 但 localeSyncFailed=true、pending 已清', async () => {
    // 前置：会话未就绪时记下选择（无主哨兵，谁先就绪补发给谁）。
    const auth = useAuthStore();
    auth.pendingLocaleWrite = { login: NO_SESSION_LOCALE_OWNER, locale: 'en' };
    // 让 user 就绪（BOB 无 locale，与待补发 en 不同）⇒ flush 会真发一枪。
    auth.user = { ...BOB };
    // 这一枪桩返回 500（api() 会抛 ApiError ⇒ catch 里置 localeSyncFailed=true）。
    const fetchFn = fetchMock(() => json(500, { error: { code: 'boom', message: 'boom' } }));
    vi.stubGlobal('fetch', fetchFn);
    await auth.flushPendingLocale();
    await flushPromises();
    // ① 确实发出一枪：method=PATCH、URL 对，桩数得出。
    const patch = fetchFn.mock.calls.filter((c) => (typeof c[0] === 'string' ? c[0] : '') === '/api/me/locale');
    expect(patch).toHaveLength(1);
    expect((patch[0][1] as RequestInit | undefined)?.method).toBe('PATCH');
    // ② 延迟补发失败也要可见：旗标置起（把 auth.ts 的 `this.localeSyncFailed = true` 改成 = false 即变红）。
    expect(auth.localeSyncFailed).toBe(true);
    // ③ 先清后发 ⇒ pending 已清，不会重复补发。
    expect(auth.pendingLocaleWrite).toBeNull();
  });
});
