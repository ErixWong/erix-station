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
    // ⚠ **循环上界必须来自测试自己，不能来自被测对象**（上一个 worker 实测）：写成
    // `while (budget.notePass()) passes += 1;` 时，把 `notePass()` 变异成恒返回 true
    // 会让这条用例**挂死**（exit 124 / 240s / vitest worker 100% CPU 忙等），而不是变红——
    // 那正是本模块存在的理由（「挂死」这一失败模式本身要消掉），所以本文件里绝不能再引进来。
    // 上界 100 远大于预算 12 ⇒ 循环只能靠「预算自己说不」停下来；`passes.length !== 100`
    // 顺带钉住「是熔断掐断的，不是上界兜住的」。
    const LOOP_CAP = 100;
    const passes: number[] = [];
    for (let i = 0; i < LOOP_CAP && budget.notePass(); i += 1) passes.push(i);
    expect(passes.length).toBe(12);
    expect(passes.length).toBeLessThan(LOOP_CAP); // 终止信号来自预算，不是来自循环上界
  });

  it('超预算后 used 不再增长（恒 ≤ 预算，与 used 的文档口径一致）', () => {
    // 实现体是「先判后加」（见 forcePasswordGuard.ts 的注释），所以 used 的取值范围被钉在
    // `0..limit`。本条钉住这个形状：越过预算之后再读 used，必须仍是 limit（不是 limit + 1），
    // 且继续 notePass() 恒 false、used 也不再往上爬。少了这条，「恒 ≤ 预算」就只是一句
    // 不可验证的注释——把实现改成「先加后判」（used += 1 后再比大小）时 used 会到 limit + 1，
    // 而其余用例全绿。
    const limit = 3;
    const budget = createRedirectBudget(limit);
    for (let i = 0; i < limit; i += 1) expect(budget.notePass()).toBe(true);
    expect(budget.used).toBe(limit);

    // 越界一次 + 再多跑两趟：结论恒 false，used 停在 limit 不动。
    for (let i = 0; i < 3; i += 1) {
      expect(budget.notePass()).toBe(false);
      expect(budget.used).toBeLessThanOrEqual(limit);
      expect(budget.used, `第 ${i + 1} 次超预算后 used 不应继续增长`).toBe(limit);
    }

    // 归零后重新计数（used 的上界随 reset 一起回到 0，不是被「借走」的额度）。
    budget.reset();
    expect(budget.used).toBe(0);
    expect(budget.notePass()).toBe(true);
    expect(budget.used).toBe(1);
  });
});
