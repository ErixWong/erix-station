// issue #332：FDE 工作台**准入闸**的判据单测（纯函数，不挂载、不 import vue-router）。
// 分工：本文件钉「判据算得对」；`router.spec.ts` 钉「守卫接对了地方」；
// `views/SeatlessAdminGate.spec.ts` 钉「工作台整棵子树没挂载 ⇒ 那三趟空请求一条都不发」。
// 抽成纯模块的理由与 lib/forcePasswordGuard.ts 同源：判据写在守卫里时，写反一次的表现形式是
// **重定向环 / 挂死**，而不是一条断言失败——纯函数让「红」回到断言层面。
import { describe, expect, it } from 'vitest';
import {
  ADMIN_CONSOLE_PATH,
  isSeatlessAdmin,
  isWorkbenchPath,
  seatAwareLanding,
  workbenchGateDecision,
} from './workbenchGate';

/** 第 ③ 类人：平台管理员，**没有**工位（`fde_name` 为 null）。 */
const SEATLESS_ADMIN = { role: 'admin', fde_name: null };
/** 第 ② 类人：管理员，但**有**工位 ⇒ 本单必须放他进工作台（工单 §一：挡的是「没工位」不是「admin」）。 */
const ADMIN_WITH_SEAT = { role: 'admin', fde_name: 'root' };
/** 第 ① 类人：普通 FDE（有工位，无管理台）。 */
const FDE = { role: 'fde', fde_name: 'alice' };

describe('#332 判据 isSeatlessAdmin（admin 且无 fde_name）', () => {
  it('三类人 + 未登录的完整真值表', () => {
    expect(isSeatlessAdmin(SEATLESS_ADMIN)).toBe(true);
    // 变异靶子 M1：把判据写成 `role === 'admin'`（漏掉 `!fde_name`）⇒ 这一条必红，
    // 线上表现是「有自己的工位的管理员也被踢出工作台」。
    expect(isSeatlessAdmin(ADMIN_WITH_SEAT)).toBe(false);
    expect(isSeatlessAdmin(FDE)).toBe(false);
    // 变异靶子 M2：把判据写成 `!user.fde_name`（漏掉 role）⇒ 这一条必红
    // （`role='fde'` 但 fde_name 为空的畸形账号会被踢去它根本没有权限的管理台）。
    expect(isSeatlessAdmin({ role: 'fde', fde_name: null })).toBe(false);
    // 未登录不是「没有工位」：那是 /login 的事（守卫里排在它之前）。
    expect(isSeatlessAdmin(null)).toBe(false);
    expect(isSeatlessAdmin(undefined)).toBe(false);
  });

  it("空串 fde_name 也算没有工位（真库里未开户的账号可能是空串而不是 null）", () => {
    expect(isSeatlessAdmin({ role: 'admin', fde_name: '' })).toBe(true);
    expect(isSeatlessAdmin({ role: 'admin', fde_name: 'root' })).toBe(false);
  });
});

describe('#332 工作台地址集合 isWorkbenchPath', () => {
  it('工作台只有 `/` 与 `/session/*` 两条；管理台与登录/改密屏都不算', () => {
    expect(isWorkbenchPath('/')).toBe(true);
    expect(isWorkbenchPath('/session/s1')).toBe(true);
    expect(isWorkbenchPath('/session/%E4%B8%AD%E6%96%87')).toBe(true);
    expect(isWorkbenchPath(ADMIN_CONSOLE_PATH)).toBe(false);
    expect(isWorkbenchPath('/admin/users')).toBe(false);
    expect(isWorkbenchPath('/login')).toBe(false);
    expect(isWorkbenchPath('/change-password')).toBe(false);
    // 前缀相似的地址不许被顺手算进来（`startsWith('/session')` 这种写法会在这里红）。
    expect(isWorkbenchPath('/sessions')).toBe(false);
    expect(isWorkbenchPath('/admin/session/s1')).toBe(false);
  });
});

describe('#332 落点 seatAwareLanding（afterLoginRoute 的同一判据）', () => {
  it('没有工位 ⇒ /admin；其余（含第 ② 类人）⇒ /', () => {
    expect(seatAwareLanding(SEATLESS_ADMIN)).toBe('/admin');
    expect(seatAwareLanding(ADMIN_WITH_SEAT)).toBe('/');
    expect(seatAwareLanding(FDE)).toBe('/');
    expect(seatAwareLanding(null)).toBe('/');
  });
});

describe('#332 准入闸 workbenchGateDecision', () => {
  it('第 ③ 类人访问工作台任意路由 ⇒ 改写去管理台（`/` 与深链 `/session/:id` 都要挡）', () => {
    // 变异靶子 M3：只挡 `/`（漏掉深链）⇒ 第一条过、第二条必红。
    expect(workbenchGateDecision({ user: SEATLESS_ADMIN, toPath: '/' })).toEqual({ action: 'rewrite', path: '/admin' });
    expect(workbenchGateDecision({ user: SEATLESS_ADMIN, toPath: '/session/someone-else' }))
      .toEqual({ action: 'rewrite', path: '/admin' });
  });

  it('第 ② 类人（admin + 有工位）访问工作台 ⇒ 放行（本单挡的是「没工位」不是「admin」）', () => {
    expect(workbenchGateDecision({ user: ADMIN_WITH_SEAT, toPath: '/' })).toEqual({ action: 'next' });
    expect(workbenchGateDecision({ user: ADMIN_WITH_SEAT, toPath: '/session/s1' })).toEqual({ action: 'next' });
  });

  it('FDE（含 fde_name 为空的畸形 fde）访问工作台 ⇒ 放行（服务端另有 403 写闸兜底）', () => {
    expect(workbenchGateDecision({ user: FDE, toPath: '/' })).toEqual({ action: 'next' });
    expect(workbenchGateDecision({ user: { role: 'fde', fde_name: null }, toPath: '/' })).toEqual({ action: 'next' });
  });

  it('第 ③ 类人访管理台 / 登录页 / 改密屏 ⇒ 不改写（否则 /admin → /admin 自环）', () => {
    for (const toPath of ['/admin', '/admin/users', '/admin/llm', '/admin/repos', '/login', '/change-password']) {
      expect(workbenchGateDecision({ user: SEATLESS_ADMIN, toPath }), toPath).toEqual({ action: 'next' });
    }
  });

  it('未登录（user=null）⇒ 不改写：/login 的跳转归既有规则，本闸不抢它的语义', () => {
    expect(workbenchGateDecision({ user: null, toPath: '/' })).toEqual({ action: 'next' });
    expect(workbenchGateDecision({ user: null, toPath: '/session/s1' })).toEqual({ action: 'next' });
  });

  it('改写目标与登录落地页是同一个真相（不存在第二份 `/admin` 字面量语义）', () => {
    const gate = workbenchGateDecision({ user: SEATLESS_ADMIN, toPath: '/' });
    expect(gate.action === 'rewrite' ? gate.path : null).toBe(seatAwareLanding(SEATLESS_ADMIN));
    expect(ADMIN_CONSOLE_PATH).toBe('/admin');
  });
});
