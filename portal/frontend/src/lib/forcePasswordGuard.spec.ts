// #255 前端 ②（任务 4）：**受限态守卫判据的函数级单测**——不挂载、不碰 vue-router。
//
// 为什么专门要这一份（主 agent 实测要求，写进代码注释免得后人删）：
// 「受限判定必须排在 meta.public 之前」这条回归，在**挂载式**测试里的失败模式是挂死进程：
// 把判据改成 `restricted && !to.meta.public`（/login 变成绕过口）之后，
// `/login → / → /change-password → /` 的重定向环跑在微任务里，vitest 的 testTimeout 被饥饿吃掉
// ⇒ 实测 200 秒零输出被 timeout 杀掉（exit 124，零用例完成），CI 里白烧一整段预算。
// 本文件**既不 import vue-router 也不 mount 组件** ⇒ 变异必须秒级变红，这条就是它的验收判据。
import { describe, expect, it } from 'vitest';
import { FORCE_PASSWORD_PATH, createRedirectBudget, restrictedNavigationDecision } from './forcePasswordGuard';
import type { RestrictedNavigationInput } from './forcePasswordGuard';
import type { AuthUser } from '../stores/auth';

const FDE = {
  id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local',
} as AuthUser;
/** 平台管理员（admin 且无 fde_name）⇒ 落地页是 /admin（与 stores/auth.afterLoginRoute 同口径）。 */
const ADMIN = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local',
} as AuthUser;

/** 受限 + 有会话：守卫唯一需要的那对事实。 */
const restricted = (over: Partial<RestrictedNavigationInput> = {}): RestrictedNavigationInput => ({
  restricted: true,
  signedIn: true,
  toPath: '/',
  metaPublic: false,
  user: FDE,
  ...over,
});

describe('#255 受限态导航判据（函数级，不经过挂载）', () => {
  it('受限态访 /login ⇒ 改写去 /change-password（哪怕它是 meta.public 的公开路由）', () => {
    // /login 的 meta.public=true：这条就是 M1 的靶心——判据一旦被加上 `&& !metaPublic` 立刻在这里红。
    expect(restrictedNavigationDecision(restricted({ toPath: '/login', metaPublic: true })))
      .toEqual({ action: 'rewrite', path: FORCE_PASSWORD_PATH });
  });

  it('受限态访深链 /session/s1 ⇒ 改写去 /change-password', () => {
    expect(restrictedNavigationDecision(restricted({ toPath: '/session/s1' })))
      .toEqual({ action: 'rewrite', path: FORCE_PASSWORD_PATH });
  });

  it('受限态访 /admin ⇒ 改写去 /change-password（管理台也不是绕过口）', () => {
    expect(restrictedNavigationDecision(restricted({ toPath: '/admin', user: ADMIN })))
      .toEqual({ action: 'rewrite', path: FORCE_PASSWORD_PATH });
  });

  it('受限态访 / 与 /change-password 之外的任意路径都算「别处」', () => {
    for (const path of ['/', '/admin/llm', '/admin/repos', '/session/abc', '/nope']) {
      expect(restrictedNavigationDecision(restricted({ toPath: path })), path)
        .toEqual({ action: 'rewrite', path: FORCE_PASSWORD_PATH });
    }
  });

  it('受限态访 /change-password 自身 ⇒ allow（**三态而非两态**：两态会掉进重定向死循环）', () => {
    // 这里若退化成 `next`，守卫后半段的 meta.public 分支会把它改写成落地页，
    // 而落地页又被受限判定改回 /change-password ⇒ 微任务里的死循环（挂载式测试表现为挂死）。
    expect(restrictedNavigationDecision(restricted({ toPath: FORCE_PASSWORD_PATH, metaPublic: true })))
      .toEqual({ action: 'allow' });
  });

  it('metaPublic **不参与**受限判定：同一个 to 在 metaPublic 两种取值下结论完全相同', () => {
    for (const path of ['/login', '/', '/admin', FORCE_PASSWORD_PATH]) {
      expect(restrictedNavigationDecision(restricted({ toPath: path, metaPublic: true })), path)
        .toEqual(restrictedNavigationDecision(restricted({ toPath: path, metaPublic: false })));
    }
  });

  it('不受 meta.public 影响 ⇒ 公开路由集合里没有一个能当绕过口', () => {
    // 逐条钉住「目前所有 meta.public 的路由」（新增公开路由若不判这条，就得说明为什么它能绕过）。
    for (const publicPath of ['/login', FORCE_PASSWORD_PATH]) {
      expect(restrictedNavigationDecision(restricted({ toPath: publicPath, metaPublic: true })), publicPath)
        .toEqual({ action: publicPath === FORCE_PASSWORD_PATH ? 'allow' : 'rewrite', ...(publicPath === FORCE_PASSWORD_PATH ? {} : { path: FORCE_PASSWORD_PATH }) });
    }
  });

  it('不受限（旗标 false）访 /change-password ⇒ 回落地页：fde 回 /，平台管理员回 /admin', () => {
    expect(restrictedNavigationDecision(restricted({ restricted: false, toPath: FORCE_PASSWORD_PATH })))
      .toEqual({ action: 'rewrite', path: '/' });
    expect(restrictedNavigationDecision(restricted({ restricted: false, toPath: FORCE_PASSWORD_PATH, user: ADMIN })))
      .toEqual({ action: 'rewrite', path: '/admin' });
  });

  it('未登录（无会话）访 /change-password ⇒ 回 /login（没有会话就谈不上「欠改密」）', () => {
    expect(restrictedNavigationDecision(restricted({ restricted: false, signedIn: false, user: null, toPath: FORCE_PASSWORD_PATH })))
      .toEqual({ action: 'rewrite', path: '/login' });
  });

  it('旗标为真但**没有会话** ⇒ 不归本判据管（next，交给守卫后半段的未登录规则）', () => {
    // 反证「只看 restricted 不看 signedIn」：那样会把未登录的人也被改写到改密屏，
    // 而本端点对未登录者根本没有可改的会话（App 闸门同样要求有会话）。
    expect(restrictedNavigationDecision(restricted({ signedIn: false, user: null, toPath: '/' })))
      .toEqual({ action: 'next' });
  });

  it('非受限态访其它路由（含 /login）⇒ next，不动既有的未登录/requiresRole 规则', () => {
    for (const path of ['/', '/session/s1', '/admin', '/login']) {
      expect(restrictedNavigationDecision(restricted({ restricted: false, toPath: path })), path)
        .toEqual({ action: 'next' });
    }
  });
});

describe('#255 守卫重定向链条的熔断器（失败模式必须是红，不是挂死）', () => {
  it('预算内一路放行，超过预算立刻要求终止导航', () => {
    const budget = createRedirectBudget(3);
    expect([budget.notePass(), budget.notePass(), budget.notePass()]).toEqual([true, true, true]);
    expect(budget.notePass()).toBe(false);
    expect(budget.notePass()).toBe(false);
  });

  it('导航落地（afterEach）后归零：正常的多次跳转不会被误熔断', () => {
    const budget = createRedirectBudget(2);
    expect(budget.notePass() && budget.notePass()).toBe(true);
    budget.reset();
    expect(budget.used).toBe(0);
    expect(budget.notePass()).toBe(true);
  });

  it('环的形状：连续 12 趟（远超正常链条的 3~4 趟）必然触发终止', () => {
    const budget = createRedirectBudget();
    let passes = 0;
    while (budget.notePass()) passes += 1;
    expect(passes).toBe(12);
  });
});
