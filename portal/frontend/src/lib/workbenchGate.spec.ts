// issue #332 + #648：FDE 工作台**准入闸**的判据单测（纯函数，不挂载、不 import vue-router）。
// 分工：本文件钉「判据算得对」；`router.spec.ts` 钉「守卫接对了地方」；
// `views/SeatlessAdminGate.spec.ts` 钉「工作台整棵子树没挂载 ⇒ 那三趟空请求一条都不发」。
// 抽成纯模块的理由与 lib/forcePasswordGuard.ts 同源：判据写在守卫里时，写反一次的表现形式是
// **重定向环 / 挂死**，而不是一条断言失败——纯函数让「红」回到断言层面。
import { describe, expect, it } from 'vitest';
import {
  ADMIN_CONSOLE_PATH,
  hasNoSeat,
  isWorkbenchPath,
  seatAwareLanding,
  workbenchGateDecision,
} from './workbenchGate';

/** 第 ③ 类人：平台管理员，**没有**工位（`fde_name` 为 null）。 */
const SEATLESS_ADMIN = { role: 'admin', fde_name: null };
/** 第 ② 类人：管理员，但**有**工位 ⇒ 本单必须放他进工作台（挡的是「没工位」不是「admin」）。 */
const ADMIN_WITH_SEAT = { role: 'admin', fde_name: 'root' };
/** 第 ① 类人：普通 FDE（有工位，无管理台）。 */
const FDE = { role: 'fde', fde_name: 'alice' };
/** 第 ④ 类人（#648）：`role='fde'` 但**没有工位** —— 他的工作台 API 全是服务端报错（见 lib 顶部）。 */
const SEATLESS_FDE = { role: 'fde', fde_name: null };

describe('#332/#648 判据 hasNoSeat（`!fde_name` 就是没工位，与 role 无关）', () => {
  it('四类人 + 未登录的完整真值表', () => {
    expect(hasNoSeat(SEATLESS_ADMIN)).toBe(true);
    // 变异靶子 M1：把判据写成 `role === 'admin'`（漏掉 `!fde_name`）⇒ 这一条必红，
    // 线上表现是「有自己的工位的管理员也被踢出工作台」。
    expect(hasNoSeat(ADMIN_WITH_SEAT)).toBe(false);
    expect(hasNoSeat(FDE)).toBe(false);
    // 变异靶子 M2（#648 把 #332 的方向挑反了）：判据退回 `role === 'admin' && !fde_name` ⇒ 这一条必红。
    // 线上表现：第 ④ 类人被留在工作台，等待他的是 `/api/dirs` 的 500 `internal`
    // 与 `/api/sessions` 的 `validation_failed`（要吃满三趟请求才看见错）。
    expect(hasNoSeat(SEATLESS_FDE)).toBe(true);
    // 未登录不是「没有工位」：那是 /login 的事（守卫里排在它之前）。
    expect(hasNoSeat(null)).toBe(false);
    expect(hasNoSeat(undefined)).toBe(false);
  });

  it("空串 fde_name 也算没有工位（真库里未开户的账号可能是空串而不是 null）", () => {
    expect(hasNoSeat({ role: 'admin', fde_name: '' })).toBe(true);
    expect(hasNoSeat({ role: 'admin', fde_name: 'root' })).toBe(false);
    // 空串与 null 同判，④ 类人不例外（否则「空串」与「null」两种脉形一个被挡一个被放）
    expect(hasNoSeat({ role: 'fde', fde_name: '' })).toBe(true);
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

describe('#332/#648 落点 seatAwareLanding（afterLoginRoute 的同一判据）', () => {
  it('没有工位（③ 与 ④）⇒ /admin；其余（含第 ② 类人）⇒ /', () => {
    expect(seatAwareLanding(SEATLESS_ADMIN)).toBe('/admin');
    expect(seatAwareLanding(ADMIN_WITH_SEAT)).toBe('/');
    expect(seatAwareLanding(FDE)).toBe('/');
    // #648：④ 类人登录后也不该落在一个他一进去就 500 的页面
    expect(seatAwareLanding(SEATLESS_FDE)).toBe('/admin');
    expect(seatAwareLanding(null)).toBe('/');
  });
});

describe('#332/#648 准入闸 workbenchGateDecision', () => {
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

  // #648 的新格子。#332 当年这里钉的是 `next`，理由是「服务端另有 400 写闸」——实测不成立：
  // `/api/dirs` 是 500 `internal`（`portal/src/dirs.js:57`），`/api/sessions` 才是 400
  //（`portal/src/sessions.js:333`），而且他要先把三趟请求打满才知道页面是空的。
  it('#648 第 ④ 类人（fde 且无 fde_name）访工作台 ⇒ 同样改写去管理台（`/` 与深链都要挡）', () => {
    // 变异靶子 M4：判据退回 `role === 'admin' && !fde_name` ⇒ 这两条必红。
    expect(workbenchGateDecision({ user: SEATLESS_FDE, toPath: '/' })).toEqual({ action: 'rewrite', path: '/admin' });
    expect(workbenchGateDecision({ user: SEATLESS_FDE, toPath: '/session/alice-1' }))
      .toEqual({ action: 'rewrite', path: '/admin' });
    // 空串形状与 null 同判（真库里未开户的账号两种都可能）
    expect(workbenchGateDecision({ user: { role: 'fde', fde_name: '' }, toPath: '/' }))
      .toEqual({ action: 'rewrite', path: '/admin' });
    // 而有工位的普通 FDE（①）一律放行 —— 本格同时钉住「改动没有误伤 ①」
    expect(workbenchGateDecision({ user: FDE, toPath: '/' })).toEqual({ action: 'next' });
    expect(workbenchGateDecision({ user: FDE, toPath: '/session/s1' })).toEqual({ action: 'next' });
  });

  it('第 ③/④ 类人访管理台 / 登录页 / 改密屏 ⇒ 不改写（否则 /admin → /admin 自环）', () => {
    for (const toPath of ['/admin', '/admin/users', '/admin/llm', '/admin/repos', '/login', '/change-password']) {
      expect(workbenchGateDecision({ user: SEATLESS_ADMIN, toPath }), toPath).toEqual({ action: 'next' });
      expect(workbenchGateDecision({ user: SEATLESS_FDE, toPath }), toPath).toEqual({ action: 'next' });
    }
  });

  it('未登录（user=null）⇒ 不改写：/login 的跳转归既有规则，本闸不抢它的语义', () => {
    expect(workbenchGateDecision({ user: null, toPath: '/' })).toEqual({ action: 'next' });
    expect(workbenchGateDecision({ user: null, toPath: '/session/s1' })).toEqual({ action: 'next' });
  });

  it('改写目标与登录落地页是同一个真相（不存在第二份 `/admin` 字面量语义）', () => {
    const gate = workbenchGateDecision({ user: SEATLESS_ADMIN, toPath: '/' });
    expect(gate.action === 'rewrite' ? gate.path : null).toBe(seatAwareLanding(SEATLESS_ADMIN));
    // ④ 类人共用同一个落点（判据与落点都不抄第二份）
    const fdeGate = workbenchGateDecision({ user: SEATLESS_FDE, toPath: '/session/s1' });
    expect(fdeGate.action === 'rewrite' ? fdeGate.path : null).toBe(seatAwareLanding(SEATLESS_FDE));
    expect(ADMIN_CONSOLE_PATH).toBe('/admin');
  });
});
