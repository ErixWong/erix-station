// 全局守卫单测：/api/me 401 → /login；已登录访问 /login → /；管理台子路由均限制 admin。
// #255 补：守卫重定向链条**熔断接线**的行为级用例（`router.ts` 里 budget 的接线：工厂作用域 +
// afterEach/onError 归零）——没有这两条，把 `router.afterEach(() => budget.reset())` 整行删掉
// 或把 budget 搬进 `beforeEach` 内部，**没有任何用例会红**，而后果是真实的（累计跳够 12 次就
// 静默停止导航）。见本文件末尾的「熔断接线」describe。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, isNavigationFailure, NavigationFailureType } from 'vue-router';
import { createAppRouter } from './router';
// FORCE_PASSWORD_PATH 从产品侧拿（不抄字面量：守卫与改密屏共用同一个真相；下面的 vi.mock 用
// importOriginal 透传，只覆盖了 restrictedNavigationDecision，这个常量仍是真值）。
import { FORCE_PASSWORD_PATH, REDIRECT_BUDGET_DEFAULT_LIMIT } from './lib/forcePasswordGuard';
import { useAuthStore } from './stores/auth';
import type { AuthUser } from './stores/auth';
import type { RestrictedNavigationInput } from './lib/forcePasswordGuard';

// #255：只对「熔断接线」那一条用例把判据换成**故意写坏的两态版**（见下面的 vi.mock）。
// vi.mock 是**文件级**的（会影响本文件所有用例），所以用一个可关的开关：默认原样转发实现，
// 只有显式扳开的那条用例才走「坏版本」。
const guardSwitch = vi.hoisted(() => ({
  /** 扳开 ⇒ 判据走「故意写坏的两态版」（只影响扳开它的那条用例）。 */
  brokenTwoState: false,
  /** 两态版被进来的趟数（= 守卫被进来的趟数），给「环真的转起来了」提供可断言的计数。 */
  brokenCalls: 0,
}));

// ⚠ **环的保险上界必须由测试自己出**（与 forcePasswordGuard.spec.ts「环的形状」那条同一原理）：
// 本机 NODE_ENV=production（AGENTS §4 的派工环境），vue-router 走的是 **prod 分支** ——
// `createRouterError` 不写 message，且 dev 专属的「_count > 30 无限重定向兜底」**根本不生效**。
// 于是「熔断器被拿掉」时环会在微任务里永远转下去 ⇒ 测试挂死（exit 124），而挂死既不像成功
// 也不像失败。所以这里给自己一个上界：转够 {@link RING_ESCAPE_AFTER} 趟就退回真判据（⇒ allow 落地）
// 把环解开，让「熔断掐断了链条」这件事以**断言失败**的形式出现，而不是以挂死的形式出现。
// 取值：远大于预算 12（正常代码下永远轮不到它），又足够小以保证秒级结束。
const RING_ESCAPE_AFTER = 60;

vi.mock('./lib/forcePasswordGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/forcePasswordGuard')>();
  // ⚠ 用 importOriginal 只覆盖那一个函数：createRedirectBudget / REDIRECT_BUDGET_DEFAULT_LIMIT /
  // FORCE_PASSWORD_PATH 必须还是真实现（把整个模块替空会连带打断 router.ts 的接线与本文件其余用例）。
  const realDecision = actual.restrictedNavigationDecision;
  return {
    ...actual,
    restrictedNavigationDecision: (input: RestrictedNavigationInput) => {
      if (!guardSwitch.brokenTwoState) return realDecision(input);
      guardSwitch.brokenCalls += 1;
      // 故意写坏的**两态**版：受限态连 `/change-password` **自己也改写过去**（没有 allow 分支）
      // ⇒ `/change-password → /change-password` 的重定向环。这正是三态判据要避免的那个形状
      //（见 lib/forcePasswordGuard.ts 里 RestrictedNavigationDecision 的注释与本仓那条「三态而非两态」用例）。
      if (input.restricted && input.signedIn && guardSwitch.brokenCalls <= RING_ESCAPE_AFTER) {
        return { action: 'rewrite', path: actual.FORCE_PASSWORD_PATH } as const;
      }
      // 未扳开的分支 / 保险上界已到 ⇒ 原样退回真判据（环解开 ⇒ 导航落地 ⇒ 断言红，而不是挂死）。
      return realDecision(input);
    },
  };
});

const FDE_USER = {
  id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local',
} as AuthUser;
const ADMIN_USER = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local',
} as AuthUser;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetchMe(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(status, body)));
}

async function freshRouter() {
  setActivePinia(createPinia());
  // createAppRouter 注册了全局守卫；push 会 await 守卫（含 ensureMe 的 /api/me）完成。
  return createAppRouter(createMemoryHistory());
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('全局路由守卫', () => {
  it('未登录（/api/me 401）访问 / → 重定向 /login', async () => {
    fetchMe(401, { error: { code: 'unauthorized', message: 'unauthorized' } });
    const router = await freshRouter();
    await router.push('/');
    expect(router.currentRoute.value.path).toBe('/login');
  });

  it('已登录访问受保护路由 → 放行', async () => {
    fetchMe(200, { user: FDE_USER });
    const router = await freshRouter();
    await router.push('/');
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('已登录访问 /login → 回工作台 /', async () => {
    fetchMe(200, { user: FDE_USER });
    const router = await freshRouter();
    await router.push('/login');
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('非 admin 访问 /admin → 回工作台 /', async () => {
    fetchMe(200, { user: FDE_USER });
    const router = await freshRouter();
    await router.push('/admin');
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('admin 访问 /admin → 重定向到用户管理页', async () => {
    fetchMe(200, { user: ADMIN_USER });
    const router = await freshRouter();
    await router.push('/admin');
    expect(router.currentRoute.value.path).toBe('/admin/users');
    expect(router.currentRoute.value.name).toBe('admin-users');
  });

  it('非 admin 访问任一管理台 tab → 回工作台', async () => {
    fetchMe(200, { user: FDE_USER });
    const router = await freshRouter();
    await router.push('/admin/llm');
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('无 session cookie（无响应体 401）也能落到 /login', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    const router = await freshRouter();
    await router.push('/');
    expect(router.currentRoute.value.path).toBe('/login');
  });

  it('未登录访问深链 → /login 且带 redirect 回跳（hash 模式下 URL 为 #/session/s1）', async () => {
    fetchMe(401, { error: { code: 'unauthorized', message: 'unauthorized' } });
    const router = await freshRouter();
    await router.push('/session/s1');
    expect(router.currentRoute.value.path).toBe('/login');
    expect(router.currentRoute.value.query.redirect).toBe('/session/s1');
  });

  it('已登录访问 /login?redirect=... → 回跳到 redirect 目标', async () => {
    fetchMe(200, { user: FDE_USER });
    const router = await freshRouter();
    await router.push({ path: '/login', query: { redirect: '/session/s1' } });
    expect(router.currentRoute.value.path).toBe('/session/s1');
  });

  it('已登录访问 /login（无 redirect）→ 回工作台 /', async () => {
    fetchMe(200, { user: FDE_USER });
    const router = await freshRouter();
    await router.push('/login');
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('/session/:id 路由存在且复用工作台组件', async () => {
    fetchMe(200, { user: FDE_USER });
    const router = await freshRouter();
    await router.push('/session/abc');
    expect(router.currentRoute.value.name).toBe('session');
    expect(router.currentRoute.value.params.id).toBe('abc');
  });
});

// issue #332：工作台**准入闸的接线**用例。与 lib/workbenchGate.spec.ts 的分工：那里测「判据算得对」
// （纯函数），这里测「守卫里真的调了它、并且接在挂载前」。
// 对应变异：删掉 `router.ts:124-125` 的
//   const gate = workbenchGateDecision({ user: auth.user, toPath: to.path });
//   if (gate.action === 'rewrite') return { path: gate.path };
// ⇒ 前两条必红（线上表现：无工位的管理员照样落在 #/ 上，并白打 /api/dirs + /api/sessions + /api/me/ports）。
// 第三、四条是反向保险：判据若被写成「role==='admin' 就挡」（漏掉 `!fde_name`）⇒ 第三条红；
// 若被写成「无条件改写」⇒ 第四条红。（无工位管理员访 /admin 不改写这件事由上面的
// 「admin 访问 /admin → 重定向到用户管理页」钉着——它的夹具正是无工位的 root。）
describe('#332 工作台准入闸的守卫接线', () => {
  /** 第 ③ 类人：`role='admin'` 且 `fde_name` 为 null ⇒ 没有工位，不得停留工作台。 */
  const SEATLESS_ADMIN = {
    id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local',
  } as AuthUser;
  /** 第 ② 类人：`role='admin'` 但 `fde_name` 有值 ⇒ 有工位，本单必须放他进工作台。 */
  const ADMIN_WITH_SEAT = {
    ...SEATLESS_ADMIN, id: 'u9', login: 'root2', display_name: 'Root2', fde_name: 'root',
  } as AuthUser;

  it('第 ③ 类人访问 / → 落到管理台（#/admin/users），不是工作台 #/', async () => {
    fetchMe(200, { user: SEATLESS_ADMIN });
    const router = await freshRouter();
    await router.push('/');
    expect(router.currentRoute.value.path).toBe('/admin/users');
    expect(router.currentRoute.value.name).toBe('admin-users');
  });

  it('第 ③ 类人深链 /session/:id（别人名下的会话）→ 同样落到管理台（工单 §二.3：不再踢回 #/）', async () => {
    fetchMe(200, { user: SEATLESS_ADMIN });
    const router = await freshRouter();
    await router.push('/session/someone-elses-session');
    expect(router.currentRoute.value.path).toBe('/admin/users');
  });

  it('第 ② 类人（admin + 有 fde_name）访 / 与 /session/:id → 照常落地（挡的是「没工位」不是 admin）', async () => {
    fetchMe(200, { user: ADMIN_WITH_SEAT });
    const router = await freshRouter();
    await router.push('/');
    expect(router.currentRoute.value.path).toBe('/');
    expect(router.currentRoute.value.name).toBe('workbench');
    await router.push('/session/s1');
    expect(router.currentRoute.value.path).toBe('/session/s1');
    expect(router.currentRoute.value.name).toBe('session');
  });

  it('FDE 访 / 与 /session/:id → 落地不受影响（零回归）', async () => {
    fetchMe(200, { user: FDE_USER });
    const router = await freshRouter();
    await router.push('/');
    expect(router.currentRoute.value.path).toBe('/');
    await router.push('/session/s2');
    expect(router.currentRoute.value.path).toBe('/session/s2');
  });
});

// #255 熔断**接线**的行为级用例。与 lib/forcePasswordGuard.spec.ts 的分工：那里测「熔断器本体
// 算得对」，这里测「它被接对了地方」——两条接线各自对应一条变异：
//  · `router.afterEach(() => budget.reset())` 被删 → (a) 红（后果：app 累计跳够 12 次就静默停导航）；
//  · `createRedirectBudget()` 被搬进 `beforeEach` 内部（每次导航新建 ⇒ 永不触发）→ (b) 红。
describe('#255 守卫重定向链条的熔断接线', () => {
  let warnSpy: MockInstance<typeof console.warn>;

  beforeEach(() => {
    guardSwitch.brokenTwoState = false;
    guardSwitch.brokenCalls = 0;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    guardSwitch.brokenTwoState = false;
    guardSwitch.brokenCalls = 0;
    vi.restoreAllMocks();
  });

  it('连续合法落地 16 次（远超预算 12）次次都成功 ⇒ 能落地的导航不消耗预算', async () => {
    // 判据：把 `router.ts` 的 `router.afterEach(() => budget.reset())` 注释掉 ⇒ 本条必红。
    // 目标选 `'/'` ↔ `'/session/sN'`：两个都是「已登录可直接落地」的真路由（不是被改写到别处，
    // 也不是与当前路由重复的 duplicated 空转），每一跳都真的走完 afterEach。
    fetchMe(200, { user: FDE_USER });
    const router = await freshRouter();
    const NAVIGATIONS = 16; // > REDIRECT_BUDGET_DEFAULT_LIMIT（12）

    for (let i = 0; i < NAVIGATIONS; i += 1) {
      const target = i % 2 === 0 ? `/session/s${i}` : '/';
      const failure = await router.push(target);
      // vue-router 导航成功时 push **resolve undefined**；任何失败（aborted / duplicated / …）都
      // resolve 一个 NavigationFailure 对象 ⇒ 「成功」的判据就是「没有 failure」。
      expect(failure, `第 ${i + 1} 次导航（→ ${target}）应当成功落地`).toBeUndefined();
      expect(router.currentRoute.value.path, `第 ${i + 1} 次导航后的 currentRoute`).toBe(target);
    }

    // 全程不该出现熔断 warn（合法链条不被误熔断，正是预算默认值取 12 的理由）。
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('判据退化成两态（改密屏自己也改写）时环被预算掐断：导航被终止、停在原地、恰好一条 warn', async () => {
    // 为什么不拿真判据测：真判据下根本不成环（/change-password 自己返 allow）。所以把判据换成
    // 「受限态连改密屏自己也改写过去」的两态版——正是三态判据要避免的那个环（见本文件 vi.mock）。
    //
    // 前置为什么必须先落在**另一个**路由上：vue-router 的重复导航判定比的是「目标 vs **当前**路由」
    // （`pushWithRedirect` 开头 `isSameRouteLocation(stringifyQuery, from, targetLocation)`），不是比
    // 上一跳。若已经站在 /change-password，第一次改写会被判 NAVIGATION_DUPLICATED ⇒ 走 afterEach
    // ⇒ 预算归零 ⇒ 环转不起来，测不到熔断。
    //
    // 「导航被终止」怎么判（vue-router 4.6.4 的行为依据，已读 node_modules/vue-router/dist 源码）：
    //  ① 守卫 `return false` → `guardToPromiseFn` 里 `reject(createRouterError(ErrorTypes.NAVIGATION_ABORTED, {from,to}))`；
    //  ② `pushWithRedirect` 的 `.catch` 把它归为 **navigation failure**（只有 GUARD_REDIRECT 那一支才继续重定向），
    //     于是 `router.push()` **resolve 一个 NavigationFailure 对象，而不是抛**；
    //  ③ `finalizeNavigation` 被跳过 ⇒ currentRoute 不更新 ⇒ 「停在原地」。
    // 判据用 `isNavigationFailure(failure, NavigationFailureType.aborted)`（公开 API），**不用 message**：
    // NODE_ENV=production 时 `createRouterError` 走「不写 message」的分支，文案断言会假红。
    fetchMe(200, { user: FDE_USER });
    const router = await freshRouter();

    // 先站上一个与改写目标不同的原地（此时不受限 ⇒ 真落地，不是被改写）。
    expect(await router.push('/session/hold')).toBeUndefined();
    expect(router.currentRoute.value.path).toBe('/session/hold');
    expect(warnSpy).not.toHaveBeenCalled();

    // 受限旗标落下（真实路径是 /api/me 的 user.must_change_password → store 的这个字段；守卫只读它）。
    useAuthStore().passwordChangeRequired = true;
    guardSwitch.brokenTwoState = true;
    guardSwitch.brokenCalls = 0;

    let failure: unknown;
    try {
      failure = await router.push('/admin');
    } catch (err) {
      failure = err; // 熔断被拿掉且环被测试自己的上界解开时，这一跳会「成功落地」⇒ 下面的断言红。
    }

    expect(
      isNavigationFailure(failure, NavigationFailureType.aborted),
      `期望一个 NAVIGATION_ABORTED 失败对象（熔断掐断了链条），实际：${String(failure)}`,
    ).toBe(true);
    // 环被掐断的位置：被拒的是「改写后的那一趟」（目标 = 改密屏），起点仍是我们站着的原地。
    const aborted = failure as { to?: { path?: string }; from?: { path?: string } };
    expect(aborted.to?.path).toBe(FORCE_PASSWORD_PATH);
    expect(aborted.from?.path).toBe('/session/hold');
    // 停在原地：环既没有把 URL 拖到别处，也没有把它钉在改密屏上。
    expect(router.currentRoute.value.path).toBe('/session/hold');
    expect(router.currentRoute.value.path).not.toBe(FORCE_PASSWORD_PATH);
    // 熔断器不是装饰：恰好**一条**来自守卫的 warn（超预算后守卫自己 reset，所以不会反复喷），
    // 且它是**我们**的那条（含 `[router]` 前缀），不是 vue-router 自己的无限重定向告警。
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('[router]');
    // 环真的转起来了，而且是被**预算**掐断的（转的趟数正好等于预算），不是被测试自带的保险上界放过的。
    expect(guardSwitch.brokenCalls).toBe(REDIRECT_BUDGET_DEFAULT_LIMIT);
    expect(guardSwitch.brokenCalls).toBeLessThan(RING_ESCAPE_AFTER);
  });
});

