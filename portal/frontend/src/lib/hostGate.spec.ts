// #450 A2：host 闸判据的单测（`lib/hostGate.ts`）。
//
// 分工（照 `lib/workbenchGate.spec.ts` 的先例）：**判据算得对**在这里钉；**守卫真的调了它**在
// `router.spec.ts` 钉。本文件不需要挂载、不需要 pinia、不需要 vue-router ⇒ 秒级跑完。
import { describe, expect, it } from 'vitest';
import {
  CHANGE_PASSWORD_PATH,
  LOGIN_PATH,
  hashUrl,
  hostGateDecision,
  isAdminPath,
  pathOf,
} from './hostGate';
import { FORCE_PASSWORD_PATH } from './forcePasswordGuard';
import { ADMIN_CONSOLE_PATH } from './workbenchGate';

// 现网形态（docs/deploy/edge-routing.md §1/§4）：用户面 http://station.fde.erix.vip:8090，
// 管理台 https://admin.fde.erix.vip:9443。
const USER_BASE = 'http://station.fde.erix.vip:8090';
const ADMIN_BASE = 'https://admin.fde.erix.vip:9443';
const USER_ORIGIN = 'http://station.fde.erix.vip:8090';
const ADMIN_ORIGIN = 'https://admin.fde.erix.vip:9443';

function decide(toPath: string, currentOrigin: string, extra: Partial<Parameters<typeof hostGateDecision>[0]> = {}) {
  return hostGateDecision({
    currentOrigin,
    userBaseUrl: USER_BASE,
    adminBaseUrl: ADMIN_BASE,
    toPath,
    ...extra,
  });
}

describe('#450 A2 hostGate：矩阵六行（工单 §2 的表）', () => {
  it('管理台 host + /admin* ⇒ allow（已经在对的 host 上）', () => {
    expect(decide('/admin', ADMIN_ORIGIN)).toEqual({ action: 'allow' });
    expect(decide('/admin/users', ADMIN_ORIGIN)).toEqual({ action: 'allow' });
    expect(decide('/admin/preview-pool', ADMIN_ORIGIN)).toEqual({ action: 'allow' });
  });

  it('管理台 host + /login、/change-password ⇒ allow（管理台自己也要登录/改密）', () => {
    expect(decide(LOGIN_PATH, ADMIN_ORIGIN)).toEqual({ action: 'allow' });
    expect(decide(CHANGE_PASSWORD_PATH, ADMIN_ORIGIN)).toEqual({ action: 'allow' });
  });

  it('管理台 host + 其它（/、/session/*、未知路径）⇒ redirect 到 userBaseUrl#<toPath>', () => {
    for (const path of ['/', '/session/abc', '/whatever/else']) {
      expect(decide(path, ADMIN_ORIGIN)).toEqual({
        action: 'redirect',
        url: `${USER_ORIGIN}#${path}`,
      });
    }
  });

  it('用户面 host + /admin* ⇒ redirect 到 adminBaseUrl#<toPath>', () => {
    expect(decide('/admin', USER_ORIGIN)).toEqual({
      action: 'redirect',
      url: `${ADMIN_ORIGIN}#/admin`,
    });
    expect(decide('/admin/users', USER_ORIGIN)).toEqual({
      action: 'redirect',
      url: `${ADMIN_ORIGIN}#/admin/users`,
    });
  });

  it('用户面 host + 其它 ⇒ allow（零回归：工作台、登录页、会话深链都不动）', () => {
    for (const path of ['/', '/session/s1', LOGIN_PATH, CHANGE_PASSWORD_PATH, '/unknown']) {
      expect(decide(path, USER_ORIGIN)).toEqual({ action: 'allow' });
    }
  });

  it('任一 + 无法判定（site 信息拿不到 / URL 解析失败）⇒ allow（fail-open，不跳）', () => {
    // 三个输入各自缺失的三种形状：拿不到（null）、空串、非 URL。
    for (const broken of [null, undefined, '', 'not-a-url', 'ftp://admin.fde.erix.vip']) {
      // 管理台 host 上要跳的那一格（`/`）在 site 坏掉时必须**不跳**：跳错方向比不跳更糟。
      expect(decide('/', ADMIN_ORIGIN, { adminBaseUrl: broken as string | null })).toEqual({ action: 'allow' });
      expect(decide('/', ADMIN_ORIGIN, { userBaseUrl: broken as string | null })).toEqual({ action: 'allow' });
      // 用户面 host 上要跳的那一格（`/admin/users`）同理。
      expect(decide('/admin/users', USER_ORIGIN, { adminBaseUrl: broken as string | null })).toEqual({ action: 'allow' });
      expect(decide('/admin/users', USER_ORIGIN, { userBaseUrl: broken as string | null })).toEqual({ action: 'allow' });
      // currentOrigin 本身坏掉 ⇒ 也判不出「我在哪」⇒ allow。
      expect(decide('/admin/users', broken as string, {})).toEqual({ action: 'allow' });
    }
  });

  it('任一 + 目标 origin === 当前 origin ⇒ allow（**防重定向环**）', () => {
    // 两种「同一台机器、两种写法」的形态都必须判成「已经在对的 host 上」：
    // 否则「管理台 host 上访 /admin」会自己跳自己（无限环）。
    expect(decide('/admin/users', 'https://admin.fde.erix.vip:9443', {
      adminBaseUrl: 'https://admin.fde.erix.vip:443', // 443 隐式端口的另一种写法
    })).toEqual({ action: 'allow' });
    expect(decide('/', 'http://station.fde.erix.vip:8090', {
      userBaseUrl: 'http://station.fde.erix.vip:8090/',
    })).toEqual({ action: 'allow' });
  });
});

describe('#450 A2 hostGate：端口 / 443 两形态（用 URL 比 origin，不用字符串前缀）', () => {
  it('管理台 443（不带端口）时两种写法都认得出「我就在管理台上」', () => {
    const base = 'https://admin.fde.erix.vip';
    // 显式 :443 与隐式端口是同一个 origin（URL 规范化）。
    for (const currentOrigin of ['https://admin.fde.erix.vip', 'https://admin.fde.erix.vip:443']) {
      expect(hostGateDecision({ currentOrigin, userBaseUrl: USER_BASE, adminBaseUrl: base, toPath: '/admin/users' }))
        .toEqual({ action: 'allow' });
      // 反方向：443 管理台 host 上的会话深链 ⇒ 跳用户面（落点不带端口，与 base 同形）。
      expect(hostGateDecision({ currentOrigin, userBaseUrl: USER_BASE, adminBaseUrl: base, toPath: '/session/x' }))
        .toEqual({ action: 'redirect', url: `${USER_ORIGIN}#/session/x` });
    }
  });

  it('base 写 :443、地址栏不带端口 ⇒ 仍是同一个 host（字符串相等比较会在这里判成「不同 host」⇒ 自跳环）', () => {
    expect(hostGateDecision({
      currentOrigin: 'https://admin.fde.erix.vip',
      userBaseUrl: USER_BASE,
      adminBaseUrl: 'https://admin.fde.erix.vip:443',
      toPath: '/admin/users',
    })).toEqual({ action: 'allow' });
    expect(hostGateDecision({
      currentOrigin: 'http://station.fde.erix.vip:80',
      userBaseUrl: 'http://station.fde.erix.vip',
      adminBaseUrl: ADMIN_BASE,
      toPath: '/',
    })).toEqual({ action: 'allow' });
  });

  it('同 host 不同端口：按 **hostname** 判「我是谁」（2026-11-06 改：原来按 origin 全等）', () => {
    // 口径变更（真机回归驱动）：用户面同时有 `http://station.<伞域>:8090` 与 `https://station.<伞域>:8443`，
    // 而 `/api/site` 只给一个 `userBaseUrl`。按 origin 全等 ⇒ 8443 被判成「陌生 host」⇒ fail-open ⇒
    // **管理台页面在用户面渲染出来**（`https://station...:8443/#/admin/users` 显示 Admin Console）。
    // 现在的规则：**同一个 hostname 的不同端口/协议是同一个面**；陌生 hostname 仍 fail-open。
    // 结果与旧断言一致（都 allow），但理由从「判不出我是谁」变成「我确实是管理台 host 上的管理路径」。
    expect(decide('/admin/users', 'https://admin.fde.erix.vip')).toEqual({ action: 'allow' });
    expect(decide('/admin/users', 'https://admin.fde.erix.vip:443')).toEqual({ action: 'allow' });
  });
});

describe('#450 A2 hostGate：深链保真（toPath 原样进 hash）', () => {
  it('`/session/<id>` 与 query 都不丢、不重编码', () => {
    expect(decide('/session/8f1c-2b?tab=diff&x=1', ADMIN_ORIGIN)).toEqual({
      action: 'redirect',
      url: `${USER_ORIGIN}#/session/8f1c-2b?tab=diff&x=1`,
    });
    expect(decide('/admin/users?q=%E5%BC%A0%E4%B8%89', USER_ORIGIN)).toEqual({
      action: 'redirect',
      url: `${ADMIN_ORIGIN}#/admin/users?q=%E5%BC%A0%E4%B8%89`,
    });
  });

  it('hashUrl：base 的尾斜杠/默认端口被规范化，不可解析的 base ⇒ null（绝不拼出 `undefined#/x`）', () => {
    expect(hashUrl('https://admin.fde.erix.vip:443/', '/admin/users')).toBe('https://admin.fde.erix.vip#/admin/users');
    expect(hashUrl('http://station.fde.erix.vip:8090', '/session/x')).toBe('http://station.fde.erix.vip:8090#/session/x');
    for (const broken of [null, undefined, '', '   ', 'not-a-url', 'ftp://x']) {
      expect(hashUrl(broken as string | null, '/admin')).toBeNull();
    }
  });
});

describe('#450 A2 hostGate：脏输入一律 allow（fail-open，不抛）', () => {
  it('toPath 为 undefined / 空串 / 不以 / 开头 ⇒ allow', () => {
    for (const dirty of [undefined, null, '', 'admin/users', 'https://evil.example/#/admin']) {
      expect(decide(dirty as string, USER_ORIGIN)).toEqual({ action: 'allow' });
      expect(decide(dirty as string, ADMIN_ORIGIN)).toEqual({ action: 'allow' });
    }
  });

  it('当前 origin 既不是用户面也不是管理台（vite dev / 预览 host）⇒ allow（判不出我是谁就不换地址）', () => {
    for (const origin of ['http://localhost:5173', 'http://alice-p-22000.fde.erix.vip:8090']) {
      expect(decide('/admin/users', origin)).toEqual({ action: 'allow' });
      expect(decide('/', origin)).toEqual({ action: 'allow' });
    }
  });

  it('`/adminx` 不是管理台路径（前缀相似但不是那条路由）', () => {
    expect(isAdminPath('/adminx')).toBe(false);
    expect(isAdminPath('/admin')).toBe(true);
    expect(isAdminPath('/admin/')).toBe(true);
    // 用户面访 /adminx ⇒ 不动（它是未知路径，路由自己回工作台/404，本闸不替它做主）。
    expect(decide('/adminx', USER_ORIGIN)).toEqual({ action: 'allow' });
  });
});

describe('#450 A2 hostGate：与既有常量的同值契约（防漂移）', () => {
  it('改密屏路径必须等于 forcePasswordGuard 的 FORCE_PASSWORD_PATH；管理台根等于 workbenchGate 的 ADMIN_CONSOLE_PATH', () => {
    expect(CHANGE_PASSWORD_PATH).toBe(FORCE_PASSWORD_PATH);
    expect(isAdminPath(ADMIN_CONSOLE_PATH)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2026-11-06 真机 bug：`toPath` 是 `to.fullPath`（**含 query**），矩阵里的精确比较会漏。
// 症状：管理台未登录 ⇒ 守卫跳 `/login?redirect=/admin/users` ⇒ 旧判据不认 `/login`（因为多了 query）
// ⇒ 踢回用户面 ⇒ 用户面登录后 cookie 在用户面 host（host-only）⇒ 回跳管理台仍 401 ⇒ **死循环**。
// ---------------------------------------------------------------------------
describe('#450 A2 hostGate：带 query 的 fullPath（真机死循环回归）', () => {
  it('管理台 host + `/login?redirect=/admin/users` ⇒ allow（**不许**踢回用户面）', () => {
    expect(decide('/login?redirect=/admin/users', ADMIN_ORIGIN)).toEqual({ action: 'allow' });
    expect(decide('/login?redirect=%2Fadmin%2Fusers', ADMIN_ORIGIN)).toEqual({ action: 'allow' });
    expect(decide('/login', ADMIN_ORIGIN)).toEqual({ action: 'allow' });
  });

  it('管理台 host + `/change-password?x=1` ⇒ allow（同一条剥 query 口径）', () => {
    expect(decide(`${CHANGE_PASSWORD_PATH}?from=forced`, ADMIN_ORIGIN)).toEqual({ action: 'allow' });
  });

  it('`isAdminPath` 剥 query：`/admin?x=1`、`/admin/users?page=2` 都算管理路径', () => {
    expect(isAdminPath('/admin?x=1')).toBe(true);
    expect(isAdminPath('/admin/users?page=2')).toBe(true);
    expect(isAdminPath('/adminx?x=1')).toBe(false);
    // 用户面访 `/admin/users?page=2` ⇒ 仍要送去管理台（query 必须原样带过去）。
    expect(decide('/admin/users?page=2', USER_ORIGIN)).toEqual({
      action: 'redirect',
      url: `${ADMIN_BASE}#/admin/users?page=2`,
    });
  });

  it('管理台 host + 其它带 query 的路径 ⇒ 仍回用户面（剥 query 只影响命中判定，不放宽矩阵）', () => {
    expect(decide('/session/abc?x=1', ADMIN_ORIGIN)).toEqual({
      action: 'redirect',
      url: `${USER_BASE}#/session/abc?x=1`,
    });
    expect(decide('/?tab=1', ADMIN_ORIGIN)).toEqual({ action: 'redirect', url: `${USER_BASE}#/?tab=1` });
  });

  it('`pathOf` 剥 `?` 与 `#`，取最先出现的那个', () => {
    expect(pathOf('/login')).toBe('/login');
    expect(pathOf('/login?a=1')).toBe('/login');
    expect(pathOf('/login#frag')).toBe('/login');
    expect(pathOf('/a?b=1#c')).toBe('/a');
  });
});

// ---------------------------------------------------------------------------
// 2026-11-06 真机 bug：用户面有两个 origin（`http://station.<伞域>:8090` 与 `https://station.<伞域>:8443`），
// 而 `/api/site` 的 `userBaseUrl` 只有一个。用 **origin 全等**判「我在哪个面」⇒ 8443 被当成陌生 host
// ⇒ fail-open ⇒ **管理台页面在用户面渲染出来**（`https://station...:8443/#/admin/users` 显示 Admin Console）。
// 修法：「我是谁」按 hostname 判；「要不要跳」仍按 origin（防环那步不变）。
// ---------------------------------------------------------------------------
describe('#450 A2 hostGate：同一 hostname 的不同端口/协议算同一个面（8443 回归）', () => {
  const USER_HTTPS = 'https://station.fde.erix.vip:8443';

  it('用户面 https:8443 + `/admin/users` ⇒ 必须送去管理台（**不许**就地渲染）', () => {
    expect(decide('/admin/users', USER_HTTPS)).toEqual({
      action: 'redirect',
      url: `${ADMIN_BASE}#/admin/users`,
    });
    expect(decide('/admin', USER_HTTPS)).toEqual({ action: 'redirect', url: `${ADMIN_BASE}#/admin` });
  });

  it('用户面 https:8443 + 普通路径 ⇒ allow（不跳）', () => {
    expect(decide('/', USER_HTTPS)).toEqual({ action: 'allow' });
    expect(decide('/session/abc', USER_HTTPS)).toEqual({ action: 'allow' });
    expect(decide('/login', USER_HTTPS)).toEqual({ action: 'allow' });
  });

  it('管理台 host 上（无论哪个端口形态）判成管理台：`/admin*` allow、其它回用户面', () => {
    expect(decide('/admin/users', ADMIN_ORIGIN)).toEqual({ action: 'allow' });
    expect(decide('/', ADMIN_ORIGIN)).toEqual({ action: 'redirect', url: `${USER_BASE}#/` });
  });

  it('陌生 hostname 仍 fail-open（不替用户换地址）', () => {
    expect(decide('/admin/users', 'https://someone-else.example.com')).toEqual({ action: 'allow' });
  });
});
