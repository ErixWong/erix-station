// 管理台外壳（顶栏 + tab 导航）的单测——**只钉一件事**：那颗登出按钮确实汇到 `auth.logout()`。
//
// 为什么值得单独一个文件（issue #431）：登出的收口判据是「**全站有几颗登出按钮**」，不是「哪个视图
// 想到了要收摊」。全站三颗——`WorkbenchView` / 本文件 / `ForcePasswordChangeView`，而 `stores/auth.spec.ts`
// 钉的是 `logout()` ⇒ `notifyUserScopeReset()`、`WorkbenchView.spec.ts` 钉的是 `notify` ⇒ 断流清空，
// 中间一直缺「AdminLayout 这颗按钮 = `auth.logout()`」这段胶水（本组件此前**没有任何 spec**）。
// 现在 #429 又把预览凭证的回收也挂在同一条 logout 上 ⇒ 这颗按钮漏接就是「换个平面继续穿越」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import AdminLayout from './AdminLayout.vue';
import LocaleSwitch from '../components/LocaleSwitch.vue';
import { useAuthStore } from '../stores/auth';
import { useSiteStore } from '../stores/site';
import { i18n, setLocale } from '../i18n';
import { clearLocaleCookie } from '../lib/localeCookie';
import { routes } from '../router';
import { setUserScopeResetListener } from '../lib/userScope';

const ADMIN_WITH_SEAT = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: 'root', auth_source: 'local',
};

/** 真路由表里 `/admin` 的子路由名字（= AdminLayout 的 tab 名字集合）。 */
function adminChildNames(): string[] {
  const adminRoute = routes.find((route) => route.path === '/admin');
  return (adminRoute?.children ?? [])
    .map((child) => (typeof child.name === 'string' ? child.name : null))
    .filter((name): name is string => name !== null);
}

/** 不带应用守卫的裸路由：本组件只用 useRoute/useRouter，守卫的 /api/me 与本单无关。 */
function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      // ⚠ 这里**不能**再挂 `AdminLayout`（#818 起）：挂载点本身就是 AdminLayout，它自己的
      //   `<router-view/>` 会再渲染一份 AdminLayout ⇒ DOM 里出现**两份**导航（15 项变 30 项、
      //   6 组变 12 组）。旧的扁平 tab 用例按 `slice(0, 12)` 与「相邻索引」断言，翻倍看不出来；
      //   #818 要钉「15 项不多不少」，所以落点必须是一个不会自我嵌套的桩。
      { path: '/', component: { template: '<div />' } },
      { path: '/login', component: { template: '<div>login</div>' } },
      // 顶栏 tab 用的是 `{ name: ... }` 形式的 :to ⇒ 路由表里没有这些名字，挂载当场就
      // "No match for {name:'admin-users'}" 抛错（不是断言失败）。给桩即可，本单不测 tab。
      // ⚠ **历史上每加一个 tab 都要回来这里加一个名字**，漏了不是「那条 tab 断言红」而是整个组件
      //   挂载就抛 ⇒ 本文件**所有**用例红（含与 tab 无关的登出、返回工作台）。#485 片 A 加
      //   `admin-upload` 时踩过。#586（加 `admin-about`）起改成从**真路由表**推导名字，
      //   这个坑从此结构性消失（名字集合只能来自 `router.ts`，不会与它漂移）。
      //   ⇒ #596 片 B 加的 `admin-prompts` 也由此自动覆盖：名字集合里已经有它，无需再改本文件。
      ...adminChildNames().map((name) => ({ path: `/${name}`, name, component: { template: '<div />' } })),
    ],
  });
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  // #804：setLocale 现在**双写**，上面那句会顺手写 cookie='zh-CN'；cookie 必须在它之后清
  //（jsdom 的 document.cookie 在本文件内共享，不清会跳用例污染）。语言复位靠上一行的 setLocale。
  clearLocaleCookie();
  setActivePinia(createPinia());
});

afterEach(() => {
  setUserScopeResetListener(null);
  vi.unstubAllGlobals();
});

describe('AdminLayout 顶栏登出（#431 收口链路的那颗按钮）', () => {
  it('点「登出」：打 /api/auth/logout、跳 /login，并触发用户 scope 复位', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return new Response(null, { status: 204 });
    }));
    let notified = 0;
    setUserScopeResetListener(() => { notified += 1; }); // 工作台侧注册的就是这个（此处用 spy 代替）

    const auth = useAuthStore();
    auth.user = ADMIN_WITH_SEAT as never;
    auth.ready = true;
    const router = makeRouter();
    router.push('/');
    await router.isReady();
    const wrapper = mount(AdminLayout, { global: { plugins: [router, i18n] } });

    const logout = wrapper.findAll('header button').at(-1)!;
    expect(logout.text()).toBe('登出');
    await logout.trigger('click');
    await flushPromises();

    expect(calls.filter((u) => u.startsWith('/api/auth/logout'))).toHaveLength(1);
    expect(router.currentRoute.value.path).toBe('/login');
    expect(notified, '这颗按钮必须汇到 auth.logout()——否则从管理台登出时上一账号的 SSE 没人关').toBe(1);
  });
});

// issue #449：新 tab 「邮件通道」必须真在导航里，且指向 `admin-mail`（只加路由不加 tab ⇒ 这页没入口）。
describe('AdminLayout tab 导航（#449 邮件通道）', () => {
  it('导航里有「邮件通道」，指向 admin-mail，且排在仓库管理之后、号池之前', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const auth = useAuthStore();
    auth.user = ADMIN_WITH_SEAT as never;
    auth.ready = true;
    const router = makeRouter();
    router.push('/');
    await router.isReady();
    const wrapper = mount(AdminLayout, { global: { plugins: [router, i18n] } });

    // 裸路由把 tab 桩成 `/<name>`，所以 href 是 `/admin-mail`（真实应用里是 `/admin/mail`，
    // 路由表那条由本用例末尾的 `routes` 断言钉住）。
    // ⚠ 12 = 到号池占用为止（#596 的 prompts、#595 的 market、#650 的 system、#677 的 runtime 四颗
    //   tab 都插在 upload 与 pool 之间 ⇒ 原本窗口里的 8 格多了三格；#727 片 2 又在 users 之后插了
    //   「工位内容」一格 ⇒ 窗口整体右移一格。本用例只钉 mail 的相邻，多带不影响判据）。
    const links = wrapper.findAll('nav a').slice(0, 12);
    const hrefs = links.map((link) => link.attributes('href'));
    expect(hrefs).toContain('/admin-mail');

    const mailLink = links.find((link) => link.attributes('href') === '/admin-mail')!;
    expect(mailLink.text()).toBe('邮件通道');

    // 顺序：仓库管理 → 邮件通道 → …（#456 的证书页插在邮件之后）→ 号池占用。
    // 精确位置由下面那条「#456 证书页」用例钉住，这里只钉本 tab 的相邻关系。
    const repos = hrefs.indexOf('/admin-repos');
    const mail = hrefs.indexOf('/admin-mail');
    const pool = hrefs.indexOf('/admin-preview-pool');
    expect(repos).toBeGreaterThanOrEqual(0);
    expect(mail).toBe(repos + 1);
    expect(pool).toBeGreaterThan(mail);

    // 路由表本身：`/admin` 的 children 里有 `mail` → `admin-mail`，且要求 admin 角色（照 admin-repos 的写法）
    const adminRoute = routes.find((route) => route.path === '/admin')!;
    const mailRoute = (adminRoute.children ?? []).find((child) => child.name === 'admin-mail')!;
    expect(mailRoute.path).toBe('mail');
    expect(mailRoute.meta).toEqual({ requiresRole: 'admin' });
    expect(typeof mailRoute.component).toBe('function');
  });
});

// issue #456 M2：新 tab「证书」必须真在导航里，且指向 `admin-tls`（只加路由不加 tab ⇒ 这页没入口）。
describe('AdminLayout tab 导航（#456 证书页）', () => {
  it('导航里有「证书」，指向 admin-tls，且排在邮件通道之后、号池占用之前', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const auth = useAuthStore();
    auth.user = ADMIN_WITH_SEAT as never;
    auth.ready = true;
    const router = makeRouter();
    router.push('/');
    await router.isReady();
    const wrapper = mount(AdminLayout, { global: { plugins: [router, i18n] } });

    const links = wrapper.findAll('nav a').slice(0, 12);
    const hrefs = links.map((link) => link.attributes('href'));
    expect(hrefs).toContain('/admin-tls');

    const tlsLink = links.find((link) => link.attributes('href') === '/admin-tls')!;
    expect(tlsLink.text()).toBe('证书');

    // 顺序：users → llm → repos → mail → **certs** → upload → prompts → runtime → market → system → pool
    // ⚠ 第二条原本断言「号池占用紧挨证书」，#485 片 A 在两者之间插了「上传上限」⇒ 相邻关系改了。
    //    这里改成钉「证书排在邮件之后 + 号池占用仍在窗口末格」，精确相邻由下面 #485 那条钉。
    //    窗口取 11 格：#596 / #595 / #650 / #677 又各插了一颗平台配置 tab（理由同上条用例的注释）。
    expect(hrefs.indexOf('/admin-tls')).toBe(hrefs.indexOf('/admin-mail') + 1);
    expect(hrefs.indexOf('/admin-preview-pool')).toBe(hrefs.length - 1);

    // 路由表本身：`/admin` 的 children 里有 `tls` → `admin-tls`，懒加载且要求 admin 角色
    const adminRoute = routes.find((route) => route.path === '/admin')!;
    const tlsRoute = (adminRoute.children ?? []).find((child) => child.name === 'admin-tls')!;
    expect(tlsRoute.path).toBe('tls');
    expect(tlsRoute.meta).toEqual({ requiresRole: 'admin' });
    expect(typeof tlsRoute.component).toBe('function');
  });
});

// issue #485 片 A：新 tab「上传上限」必须真在导航里且指向 `admin-upload`（同 #449/#456 的判据形状：
// 只加路由不加 tab ⇒ 这一页在管理台里没有入口，等于没做）。
describe('AdminLayout tab 导航（#485 片 A 上传上限）', () => {
  it('导航里有「上传上限」，指向 admin-upload，且排在证书之后、号池占用之前', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const auth = useAuthStore();
    auth.user = ADMIN_WITH_SEAT as never;
    auth.ready = true;
    const router = makeRouter();
    router.push('/');
    await router.isReady();
    const wrapper = mount(AdminLayout, { global: { plugins: [router, i18n] } });

    const links = wrapper.findAll('nav a').slice(0, 12);
    const hrefs = links.map((link) => link.attributes('href'));
    expect(hrefs).toContain('/admin-upload');
    expect(links.find((link) => link.attributes('href') === '/admin-upload')!.text()).toBe('上传上限');

    // 顺序：certs → **upload** → prompts → runtime → …（平台配置挨在一起，只读的号池占用永远留最后）
    // ⚠ #818 把顶栏 15 项搬进了**分组侧栏**，DOM 里的顺序 = 分组顺序 ⇒ 跨组的相邻（旧「runtime → market」）
    //   不再成立：能力市场现在与 LLM 同在「模型与能力」组。本用例只钉同组内的相邻与「在号池之前」。
    expect(hrefs.indexOf('/admin-upload')).toBe(hrefs.indexOf('/admin-tls') + 1);
    expect(hrefs.indexOf('/admin-prompts')).toBe(hrefs.indexOf('/admin-upload') + 1);
    expect(hrefs.indexOf('/admin-runtime')).toBe(hrefs.indexOf('/admin-prompts') + 1);
    expect(hrefs.indexOf('/admin-preview-pool')).toBeGreaterThan(hrefs.indexOf('/admin-runtime'));
    // tab 总数：这一格是「加 tab 必须同步改本文件桩路由」那条红线的正面（漏改 ⇒ 挂载就抛，不会走到这里）
    // ⚠ 12 = #677 P2b 在 prompts 与 market 之间插了「运行时设置」，#727 片 2 又在 users 之后插了
    //   「工位内容」⇒ 到号池占用为止各多一格。
    expect(hrefs).toHaveLength(12);

    // 路由表本身：`/admin` 的 children 里有 `upload` → `admin-upload`，懒加载且要求 admin 角色
    const adminRoute = routes.find((route) => route.path === '/admin')!;
    const uploadRoute = (adminRoute.children ?? []).find((child) => child.name === 'admin-upload')!;
    expect(uploadRoute.path).toBe('upload');
    expect(uploadRoute.meta).toEqual({ requiresRole: 'admin' });
    expect(typeof uploadRoute.component).toBe('function');
  });
});

// issue #596 片 B：新 tab「提示词」必须真在导航里且指向 `admin-prompts`（同 #449/#456/#485 的判据
// 形状：只加路由不加 tab ⇒ 这一页在管理台里没有入口，等于没做）。
describe('AdminLayout tab 导航（#596 片 B 提示词面板）', () => {
  it('导航里有「提示词」，指向 admin-prompts，且排在上传上限之后、号池占用之前', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const auth = useAuthStore();
    auth.user = ADMIN_WITH_SEAT as never;
    auth.ready = true;
    const router = makeRouter();
    router.push('/');
    await router.isReady();
    const wrapper = mount(AdminLayout, { global: { plugins: [router, i18n] } });

    const links = wrapper.findAll('nav a').slice(0, 12);
    const hrefs = links.map((link) => link.attributes('href'));
    expect(hrefs).toContain('/admin-prompts');
    expect(links.find((link) => link.attributes('href') === '/admin-prompts')!.text()).toBe('提示词');

    // 顺序：upload → **prompts** → runtime → market → pool（都是平台配置；只读的号池占用仍留最后）
    // ⚠ #595 的「能力市场」与本单并行落地、插在 prompts 与 pool 之间；#677 P2b 又在两者之间插了
    //    「运行时设置」⇒ 「pool 紧挨 prompts」早己让位；「排在 upload 之后、号池占用之前」原样保留。
    expect(hrefs.indexOf('/admin-prompts')).toBe(hrefs.indexOf('/admin-upload') + 1);
    expect(hrefs.indexOf('/admin-preview-pool')).toBeGreaterThan(hrefs.indexOf('/admin-prompts'));

    // 路由表本身：`/admin` 的 children 里有 `prompts` → `admin-prompts`，懒加载且要求 admin 角色
    const adminRoute = routes.find((route) => route.path === '/admin')!;
    const promptsRoute = (adminRoute.children ?? []).find((child) => child.name === 'admin-prompts')!;
    expect(promptsRoute.path).toBe('prompts');
    expect(promptsRoute.meta).toEqual({ requiresRole: 'admin' });
    expect(typeof promptsRoute.component).toBe('function');
  });
});

// issue #595 M2：新 tab「能力市场」必须真在导航里且指向 `admin-market`（同 #449/#456/#485 的判据
// 形状：只加路由不加 tab ⇒ 这一页在管理台里没有入口，等于没做）。
describe('AdminLayout tab 导航（#595 能力市场）', () => {
  it('导航里有「能力市场」，指向 admin-market，且排在上传上限之后、号池占用之前', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const auth = useAuthStore();
    auth.user = ADMIN_WITH_SEAT as never;
    auth.ready = true;
    const router = makeRouter();
    router.push('/');
    await router.isReady();
    const wrapper = mount(AdminLayout, { global: { plugins: [router, i18n] } });

    const links = wrapper.findAll('nav a');
    const hrefs = links.map((link) => link.attributes('href'));
    expect(hrefs).toContain('/admin-market');
    expect(links.find((link) => link.attributes('href') === '/admin-market')!.text()).toBe('能力市场');

    // 精确相邻（#818 分组后）：market 与 llm 同在「模型与能力」组 ⇒ market 紧跟 llm；
    // 而 runtime 属「平台配置」组，旧的「runtime → market」跨组相邻已不成立（DOM 顺序 = 分组顺序）。
    expect(hrefs.indexOf('/admin-market')).toBe(hrefs.indexOf('/admin-llm') + 1);
    // 「运行观察」组内部：system 仍紧挨号池占用，且 market（平台配置）在号池之前
    expect(hrefs.indexOf('/admin-system')).toBeLessThan(hrefs.indexOf('/admin-preview-pool'));
    expect(hrefs.indexOf('/admin-market')).toBeLessThan(hrefs.indexOf('/admin-preview-pool'));

    // 路由表本身：`/admin` 的 children 里有 `market` → `admin-market`，懒加载且要求 admin 角色
    const adminRoute = routes.find((route) => route.path === '/admin')!;
    const marketRoute = (adminRoute.children ?? []).find((child) => child.name === 'admin-market')!;
    expect(marketRoute.path).toBe('market');
    expect(marketRoute.meta).toEqual({ requiresRole: 'admin' });
    expect(typeof marketRoute.component).toBe('function');
  });
});

// issue #650：新 tab「系统」必须真在导航里且指向 `admin-system`（同 #449/#456/#485/#595 的判据形状：
// 只加路由不加 tab ⇒ 这一页在管理台里没有入口，等于没做）。
describe('AdminLayout tab 导航（#650 系统监控）', () => {
  it('导航里有「系统」，指向 admin-system，排在能力市场之后、号池占用之前', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const auth = useAuthStore();
    auth.user = ADMIN_WITH_SEAT as never;
    auth.ready = true;
    const router = makeRouter();
    router.push('/');
    await router.isReady();
    const wrapper = mount(AdminLayout, { global: { plugins: [router, i18n] } });

    const links = wrapper.findAll('nav a');
    const hrefs = links.map((link) => link.attributes('href'));
    expect(hrefs).toContain('/admin-system');
    expect(links.find((link) => link.attributes('href') === '/admin-system')!.text()).toBe('系统');

    // 精确相邻（#818 分组后）：market 已搬进「模型与能力」组，与 system 不再相邻；
    // 本用例的判据（system 在号池之前 + 「只读快照挨在一起」）改钉同组内的 system → pool 相邻。
    expect(hrefs.indexOf('/admin-preview-pool')).toBe(hrefs.indexOf('/admin-system') + 1);
    expect(hrefs.indexOf('/admin-system')).toBeGreaterThan(hrefs.indexOf('/admin-runtime'));

    // 路由表本身：`/admin` 的 children 里有 `system` → `admin-system`，懒加载且要求 admin 角色
    const adminRoute = routes.find((route) => route.path === '/admin')!;
    const systemRoute = (adminRoute.children ?? []).find((child) => child.name === 'admin-system')!;
    expect(systemRoute.path).toBe('system');
    expect(systemRoute.meta).toEqual({ requiresRole: 'admin' });
    expect(typeof systemRoute.component).toBe('function');
  });
});

// #450 A2：「← 返回工作台」是**跨 host** 链接（管理台 `admin.<伞域>:9443` → 用户面 `station.<伞域>`）。
// A1 之后同一份 SPA 也从用户 host 下发，若这颗按钮还是 `router-link to="/"`，它会把人送到
// 「管理台 host 上的工作台」——页面渲染得出来、所有用户 API 全 404。判据：href 来自 site store 的 userBaseUrl。
describe('AdminLayout「← 返回工作台」（#450 A2：跨 host 绝对地址）', () => {
  it('site 有值 ⇒ userBaseUrl#/；拿不到 ⇒ 退回相对 hash `#/`（fail-open）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const auth = useAuthStore();
    auth.user = ADMIN_WITH_SEAT as never;
    auth.ready = true;
    const router = makeRouter();
    router.push('/');
    await router.isReady();
    const wrapper = mount(AdminLayout, { global: { plugins: [router, i18n] } });
    const link = () => wrapper.get('[data-test="back-to-workbench"]');

    expect(link().attributes('href')).toBe('#/');

    useSiteStore().info = {
      userBaseUrl: 'http://station.fde.erix.vip:8090',
      adminBaseUrl: 'https://admin.fde.erix.vip:9443',
    };
    await flushPromises();
    expect(link().attributes('href')).toBe('http://station.fde.erix.vip:8090#/');
    // 文案不变（issue #101 的 i18n 键仍是唯一真相）
    expect(link().text()).toBe('← 返回工作台');
  });
});

// 2026-11-06（真机蹦极）：无工位管理员不该看到「Back to workbench」——点过去必被打回管理台，
// 而两个 host 的登录 cookie 互不相通 ⇒ 只会让他登录两次、在两个入口之间来回。
describe('AdminLayout：Back to workbench 只给**有工位**的人', () => {
  async function mountWith(user: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const auth = useAuthStore();
    auth.user = user as never;
    auth.ready = true;
    useSiteStore().info = {
      userBaseUrl: 'http://station.example.test:8090',
      adminBaseUrl: 'https://admin.example.test:9443',
    };
    const router = makeRouter();
    router.push('/');
    await router.isReady();
    return mount(AdminLayout, { global: { plugins: [router, i18n] } });
  }

  it('无工位管理员（fde_name 空）⇒ 不渲染该链接', async () => {
    const wrapper = await mountWith({ ...ADMIN_WITH_SEAT, fde_name: null });
    expect(wrapper.find('[data-test="back-to-workbench"]').exists()).toBe(false);
  });

  it('有工位的管理员 ⇒ 渲染，且 href 是 userBaseUrl 的绝对地址（跨 host）', async () => {
    const wrapper = await mountWith(ADMIN_WITH_SEAT);
    const link = wrapper.find('[data-test="back-to-workbench"]');
    expect(link.exists()).toBe(true);
    expect(link.attributes('href')).toBe('http://station.example.test:8090#/');
  });
});

// issue #804：管理台是**独立 origin**（`admin.<伞域>:<端口>`），localStorage 按 origin 隔离 ⇒ 语言偏好
// 不跟用户面共享，中文浏览器进来恒中文。两条判据各钉一半：控件在不在（没它就只能恒中文）、
// 切了是不是当场生效（i18n 是同一份单例，理论上就该生效；这里真正会被回归的是「插错位置把
// header 里最后一颗按钮——登出——挤掉」，那会让 #431 的收口判据取错按钮）。
describe('AdminLayout 顶栏语言切换（#804：管理台必须能就地切语言）', () => {
  async function mountLayout() {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const auth = useAuthStore();
    auth.user = ADMIN_WITH_SEAT as never;
    auth.ready = true;
    const router = makeRouter();
    router.push('/');
    await router.isReady();
    return mount(AdminLayout, { global: { plugins: [router, i18n] } });
  }

  it('顶栏有语言切换控件，且它的按钮 aria-label 就是 locale.label', async () => {
    const wrapper = await mountLayout();
    const control = wrapper.findComponent(LocaleSwitch);
    expect(control.exists()).toBe(true);
    expect(control.find('button').attributes('aria-label')).toBe(i18n.global.t('locale.label'));
  });

  it('在管理台里切到 English：tab 文案当场变英文，且登出仍是 header 最后一颗按钮', async () => {
    const wrapper = await mountLayout();
    const tabs = () => wrapper.findAll('nav a').map((link) => link.text());
    const zhTabLabel = tabs()[0]; // 第一颗 tab 的中文取值（本文件其它用例同样直接断言中文文案）

    const control = wrapper.findComponent(LocaleSwitch);
    await control.find('button').trigger('click');
    const english = control.findAll('[role="menuitem"]').find((item) => item.text() === 'English');
    if (!english) throw new Error('English 菜单项不存在');
    await english.trigger('click');
    await wrapper.vm.$nextTick();

    // 真生效（不是只改了偏好）：nav 里至少一颗 tab 的文案 = 英文取值，且已不是原来的中文
    expect(i18n.global.t('admin.tabs.users')).toBe('User management');
    expect(tabs()).toContain(i18n.global.t('admin.tabs.users'));
    expect(tabs()[0]).not.toBe(zhTabLabel);

    // 结构判据：切换器插在登出**之前** ⇒ 登出仍是 `header button` 的最后一颗（#431 靠这个取按钮）
    const headerButtons = wrapper.findAll('header button');
    expect(headerButtons.length).toBeGreaterThanOrEqual(2);
    expect(headerButtons.at(-1)!.text()).toBe(i18n.global.t('common.logout'));
  });
});

// ============================ issue #818：左侧分组侧栏 ============================
// 顶栏 15 项 tab 搬进左侧 6 组 + 底部「关于」。这里钉的是**导航还在不在、能不能找到**：
// ① 15 项一个不少（漏分组 = 这一页在管理台里没有任何入口，历史上加 tab 只要塞一行，现在多了一层）；
// ② 默认只展开当前组；③ 导航时强制展开目标组；④「跳到…」过滤；⑤ 展开态过 localStorage 往返；
// ⑥ a11y（aria-expanded / aria-current / nav[aria-label] / skip 链接）。
// 断言只认 DOM（收起的组用 `v-show` ⇒ 链接恒在 DOM，可见性用 `isVisible()`，不用 `w.emitted()`）。
const ALL_TAB_PATHS = [
  '/admin-users', '/admin-seat-content', '/admin-llm', '/admin-market', '/admin-repos',
  '/admin-mail', '/admin-tls', '/admin-upload', '/admin-prompts', '/admin-runtime',
  '/admin-system', '/admin-preview-pool', '/admin-macros', '/admin-macro-runs', '/admin-about',
];
const GROUP_IDS = ['usersSeats', 'models', 'platformAccess', 'platformConfig', 'observe', 'macros'];
const GROUP_TITLES = ['用户与工位', '模型与能力', '平台接入', '平台配置', '运行观察', '宏'];

async function mountAt(path: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
  const auth = useAuthStore();
  auth.user = ADMIN_WITH_SEAT as never;
  auth.ready = true;
  const router = makeRouter();
  await router.push(path);
  await router.isReady();
  const wrapper = mount(AdminLayout, { global: { plugins: [router, i18n] } });
  return { wrapper, router };
}
type MountedLayout = Awaited<ReturnType<typeof mountAt>>;
const navLinks = (wrapper: MountedLayout['wrapper']) => wrapper.findAll('nav a');
const groupButton = (wrapper: MountedLayout['wrapper'], id: string) =>
  wrapper.get(`[data-test="nav-group-${id}"]`);

describe('AdminLayout 左侧分组侧栏（#818）', () => {
  it('① 渲染 6 个组标题 + 底部「关于」，且 15 个链接不多不少', async () => {
    const { wrapper } = await mountAt('/');
    expect(wrapper.findAll('[data-test^="nav-group-"]')).toHaveLength(6);
    expect(wrapper.findAll('[data-test^="nav-group-"]').map((b) => b.text()).map((t) => t.replace(/[▸▾]/, '').trim()))
      .toEqual(GROUP_TITLES);
    // 15 项不多不少（`nav a` 里只有导航链接：skip 链接在 nav 外，过滤框是 input，折叠键是 button）
    expect(navLinks(wrapper)).toHaveLength(15);
    expect(navLinks(wrapper).map((l) => l.attributes('href'))).toEqual(ALL_TAB_PATHS);
    // 「关于」是底部固定项：不并进任何组，但仍在同一个 <nav> 里（它属于那 15 项）
    expect(wrapper.find('[data-test="nav-footer"] [data-test="nav-link-admin-about"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-test^="nav-group-"] [data-test="nav-link-admin-about"]')).toHaveLength(0);
    // 结构自检位：分组表漏抄一项 ⇒ 这里会渲染出失联的 tab 名（正常态不该存在）
    expect(wrapper.find('[data-test="nav-unassigned"]').exists()).toBe(false);
  });

  it('② 默认只展开当前路由所在组，其余全部收起', async () => {
    const { wrapper } = await mountAt('/admin-macros');
    expect(groupButton(wrapper, 'macros').attributes('aria-expanded')).toBe('true');
    for (const id of GROUP_IDS.filter((each) => each !== 'macros')) {
      expect(groupButton(wrapper, id).attributes('aria-expanded'), id).toBe('false');
    }
    expect(wrapper.get('[data-test="nav-link-admin-macros"]').isVisible()).toBe(true);
    expect(wrapper.get('[data-test="nav-link-admin-users"]').isVisible(), '收起的组只是不可见，链接仍在 DOM').toBe(false);
    // 当前项还标了 aria-current（读屏才知道自己在哪）
    expect(wrapper.get('[data-test="nav-link-admin-macros"]').attributes('aria-current')).toBe('page');
  });

  it('② 没有当前组（落在 /）⇒ 一律收起，但 15 项链接仍在 DOM', async () => {
    const { wrapper } = await mountAt('/');
    for (const id of GROUP_IDS) expect(groupButton(wrapper, id).attributes('aria-expanded'), id).toBe('false');
    expect(navLinks(wrapper)).toHaveLength(15);
  });

  it('③ 手动收起「宏」后再导航到宏流水：目标组被强制展开', async () => {
    const { wrapper, router } = await mountAt('/admin-macros');
    await groupButton(wrapper, 'macros').trigger('click');
    expect(groupButton(wrapper, 'macros').attributes('aria-expanded')).toBe('false');

    await router.push('/admin-macro-runs');
    await flushPromises();
    expect(groupButton(wrapper, 'macros').attributes('aria-expanded'), '刚点进去的组收起着 = 看不见自己在哪').toBe('true');
    expect(wrapper.get('[data-test="nav-link-admin-macro-runs"]').isVisible()).toBe(true);
  });

  it('④「跳到…」：输入即过滤（中英任一命中）、清空恢复 15 项、无匹配给一行提示', async () => {
    const { wrapper } = await mountAt('/');
    const filter = wrapper.get('[data-test="nav-filter"]');

    await filter.setValue('宏');
    expect(navLinks(wrapper).map((l) => l.attributes('href'))).toEqual(['/admin-macros', '/admin-macro-runs']);
    expect(wrapper.findAll('[data-test^="nav-group-"]')).toHaveLength(1); // 空组连标题一起藏
    // 过滤态强制展开：不需要再点一下才看见搜到的东西
    expect(groupButton(wrapper, 'macros').attributes('aria-expanded')).toBe('true');

    // 英文界面下用中文词也命中（匹配中文项名**与**英文译文两者之一）
    await filter.setValue('run');
    expect(navLinks(wrapper).map((l) => l.text())).toContain('宏流水'); // Macro runs
    expect(navLinks(wrapper).every((l) => l.isVisible())).toBe(true);

    await filter.setValue('');
    expect(navLinks(wrapper)).toHaveLength(15);
    expect(wrapper.find('[data-test="nav-no-match"]').exists()).toBe(false);

    await filter.setValue('qqqzzz');
    expect(navLinks(wrapper)).toHaveLength(0);
    expect(wrapper.get('[data-test="nav-no-match"]').text()).toBe('没有匹配项');
  });

  it('⑤ 收起某组 ⇒ localStorage 不含它；重新挂载仍是收起（键 admin.nav.expanded，不进 DB）', async () => {
    const { wrapper } = await mountAt('/admin-macros');
    await groupButton(wrapper, 'macros').trigger('click');
    const stored = JSON.parse(localStorage.getItem('admin.nav.expanded') ?? 'null');
    expect(Array.isArray(stored), '值是组 id 数组').toBe(true);
    expect(stored).not.toContain('macros');

    // 重新挂载 = 重新读 localStorage（**存了空数组 ≠ 没存过**：后者才会回落到「展开当前组」）
    const again = await mountAt('/admin-macros');
    expect(groupButton(again.wrapper, 'macros').attributes('aria-expanded')).toBe('false');
  });

  it('⑤ localStorage 里是脏值（非数组 / 未知组 id）⇒ 不抛、回落默认', async () => {
    localStorage.setItem('admin.nav.expanded', '{not json');
    const dirty = await mountAt('/admin-macros');
    expect(groupButton(dirty.wrapper, 'macros').attributes('aria-expanded')).toBe('true');

    localStorage.setItem('admin.nav.expanded', JSON.stringify(['models', 42, 'nope']));
    const unknown = await mountAt('/');
    expect(unknown.wrapper.findAll('[data-test^="nav-group-"]')).toHaveLength(6);
    expect(groupButton(unknown.wrapper, 'models').attributes('aria-expanded')).toBe('true');
    expect(groupButton(unknown.wrapper, 'macros').attributes('aria-expanded')).toBe('false');
  });

  it('⑥ a11y：组标题是带 aria-expanded 的 <button>、当前项 aria-current、nav 有名字、skip 链接指向 #admin-main', async () => {
    const { wrapper } = await mountAt('/admin-macros');
    for (const id of GROUP_IDS) {
      const button = groupButton(wrapper, id);
      expect(button.element.tagName, id).toBe('BUTTON');
      expect(button.attributes('aria-expanded'), id).toBeTruthy();
      // 组图标是装饰（读屏读的是组名）
      expect(button.get('svg').attributes('aria-hidden'), id).toBe('true');
    }
    expect(wrapper.get('nav').attributes('aria-label')).toBe(i18n.global.t('admin.tabs.label'));
    expect(wrapper.get('[data-test="nav-link-admin-macros"]').attributes('aria-current')).toBe('page');
    expect(wrapper.get('[data-test="nav-link-admin-macro-runs"]').attributes('aria-current')).toBeUndefined();

    const skip = wrapper.get('[data-test="skip-to-content"]');
    expect(skip.attributes('href')).toBe('#admin-main');
    expect(skip.text()).toBe(i18n.global.t('admin.nav.skip'));
    expect(wrapper.get('#admin-main').attributes('id')).toBe('admin-main');
    // skip 链接必须在 nav **之前**（否则键盘用户要先 TAB 过 15 项才拿到它）
    const focusables = wrapper.element.querySelectorAll('a, button, input');
    expect(Array.prototype.indexOf.call(focusables, skip.element)).toBe(0);
  });

  it('⑥ 两个滚动面分开：侧栏的滚动容器与 main 的滚动容器是两个元素', async () => {
    const { wrapper } = await mountAt('/');
    const aside = wrapper.get('aside');
    const main = wrapper.get('#admin-main');
    const asideScroller = aside.get('nav');
    expect(asideScroller.classes()).toContain('overflow-y-auto');
    expect(main.classes()).toContain('overflow-y-auto');
    // 一个 overflow 管两边 = 长页面把导航顶出视野 ⇒ 滚动容器不能是同一个元素
    expect(asideScroller.element).not.toBe(main.element);
    expect(main.element.contains(asideScroller.element)).toBe(false);
  });

  it('⑤ 每个分组标题都带自维护内联 SVG 图标（不引图标库）', async () => {
    const { wrapper } = await mountAt('/');
    const icons = wrapper.findAll('[data-test^="nav-group-"] [data-test="app-icon"]');
    expect(icons).toHaveLength(6);
    expect(icons.map((icon) => icon.attributes('data-icon'))).toEqual(['users', 'cpu', 'plug', 'sliders', 'activity', 'zap']);
    expect(wrapper.findAll('path').length).toBeGreaterThan(0);
  });
});
