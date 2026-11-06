// #450 A2：**host 闸**（纯函数，零 vue-router / 零 pinia 依赖）。
//
// 要治的是什么（#450 决策 D3）：A1 把**边缘**隔离做实了——用户入口（`station.<伞域>`）把 `/api/admin/*`
// 挡成 404，管理台入口（`admin.<伞域>:9443`）把除 `/api/admin`、`/api/auth`、`/api/me`、`/api/site`
// 之外的 `/api/*` 也挡成 404——而 **SPA 仍是同一份、hash 路由不变**，两个 host 都把它发下去。于是
// 「在用户 host 上打开 `#/admin/users`」的观感是「页面渲染得出来、所有管理 API 全 404」。
//
// 本模块只回答一件事：**「按当前 origin + 目标路径，该不该换一个 origin 继续」**。判据落在这里
// （照 `lib/workbenchGate.ts` / `lib/forcePasswordGuard.ts` 的先例：不 import vue-router、不挂载组件）
// ⇒ 单测直接调函数即可秒级变红；`router.ts` 只负责接线。
//
// 三条硬要求（工单 §2）：
//  ① **fail-open**：`/api/site` 拿不到 / 值解析不出 URL ⇒ **不跳**。跳错方向比不跳更糟——管理台 host
//     不可达时会把用户踢到一个死地址，且他连「改地址回来」都得手打 URL。
//  ② **防环**：只有目标 origin 与当前 origin **真的不同**才跳；这件事由本函数自己算（`new URL().origin`
//     比较），**不靠调用方记得**。
//  ③ **不能吃错误路径**：`toPath` 原样进 hash（`#/session/<id>` 的深链与 query 都要保住），
//     不重新编码、不丢 query。
//
// ⚠ 为什么用 `new URL(x).origin` 而不是字符串前缀比较：`adminBaseUrl` 是 `https://admin.x:9443` 形态，
// 而 `currentOrigin` 可能是 `https://admin.x:9443`（显式端口）或 `https://admin.x`（443 隐式端口）。
// `URL` 会把默认端口规范化掉（`https://admin.x:443` → origin `https://admin.x`），前缀比较则会在
// 「443 与显式端口」这两种合法形态之间判错——那正是重定向环的入口。
import { ADMIN_CONSOLE_PATH } from './workbenchGate';

/** 登录页路径（管理台 host 上允许停留：管理台自己也要登录）。 */
export const LOGIN_PATH = '/login';

/**
 * 强制改密屏路径。**必须**与 `lib/forcePasswordGuard.FORCE_PASSWORD_PATH` 同值（`hostGate.spec.ts` 里
 * 有一条断言直接拿两者比对）——本模块刻意不 import 那个文件：它 import 了 `stores/auth`（连带 pinia /
 * api / i18n），会把「一个纯判据」变成「一个会拉起半个前端运行时」的模块。
 */
export const CHANGE_PASSWORD_PATH = '/change-password';

/** 两态结论。`redirect` 是**跨 origin** 的（vue-router 管不到），调用方必须整页换地址而不是导航。 */
export type HostGateDecision = { action: 'allow' } | { action: 'redirect'; url: string };

export interface HostGateInput {
  /** 当前页面的 origin（`window.location.origin`，形如 `https://admin.x:9443`）。 */
  currentOrigin: string | null | undefined;
  /** `GET /api/site` 的 `userBaseUrl`（用户面 base）。拿不到时传 null/undefined ⇒ fail-open。 */
  userBaseUrl: string | null | undefined;
  /** `GET /api/site` 的 `adminBaseUrl`（管理台 base）。拿不到时传 null/undefined ⇒ fail-open。 */
  adminBaseUrl: string | null | undefined;
  /** 目标路径（`to.fullPath`：路径 + query）。原样进 hash。 */
  toPath: string | null | undefined;
}

/**
 * `base + '#/' + path` 的唯一实现（host 闸与 SPA 里的硬链接共用它，避免「跳转」与「链接」两套拼法）。
 *
 * 只取 base 的 **origin**：值形态本来就是 `scheme://host[:port]`（`docs/api/portal.md` §2.12），
 * 取 origin 顺带把尾斜杠、默认端口（443/80）规范化掉——于是「防环比较」与「跳转落点」永远自洽。
 * base 不可解析 / 空 ⇒ `null`（调用方按 fail-open 处理，绝不拼出 `undefined#/x`）。
 */
export function hashUrl(baseUrl: string | null | undefined, toPath: string): string | null {
  const origin = parseOrigin(baseUrl);
  if (origin === null) return null;
  return `${origin}#${toPath}`;
}

/** `scheme://host[:port]` → **hostname**（不带端口/协议）。判「我在哪个面」用它，判「要不要跳」用 origin。 */
function parseHostname(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** `scheme://host[:port]` → 规范化 origin；空串 / 非 URL / 非 http(s) ⇒ null。 */
function parseOrigin(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.origin;
}

/**
 * 取路径部分：`/login?redirect=/x` → `/login`。
 *
 * ⚠ 为什么必须剥 query（2026-11-06 真机 bug）：守卫传给本模块的是 `to.fullPath`（**含 query**），
 * 而矩阵里的比较原来写成 `toPath === LOGIN_PATH` 精确等于。管理台上未登录时守卫跳的是
 * `/login?redirect=/admin/users` ⇒ 不等于 `/login` ⇒ 落进「其余路径」分支 ⇒ **被踢回用户面**；
 * 用户在用户面登录后 cookie 种在用户面 host（host-only），回跳管理台仍然 401 ⇒ **死循环**
 * （`admin.<伞域>:9443/#/admin/users` ↔ `station.<伞域>/#/login?redirect=/admin/users`）。
 * 同一处 `isAdminPath('/admin?x=1')` 也曾误判成「非管理路径」。
 */
export function pathOf(toPath: string): string {
  const q = toPath.indexOf('?');
  const h = toPath.indexOf('#');
  const cut = [q, h].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  return cut === undefined ? toPath : toPath.slice(0, cut);
}

/** 管理台路径集合：`/admin` 与 `/admin/...`（`/adminx` 不算——本仓没有这条路由，别把无关路径送去管理台）。 */
export function isAdminPath(toPath: string): boolean {
  const path = pathOf(toPath);
  return path === ADMIN_CONSOLE_PATH || path.startsWith(`${ADMIN_CONSOLE_PATH}/`);
}

/**
 * 判据本体。**目标 origin** 决定一切：管理台路径 ⇒ 管理台 host；其余 ⇒ 用户面 host。
 *
 * 矩阵（工单 §2 的表，逐行都有单测）：
 * | 当前 host | 目标 path | 结果 |
 * |---|---|---|
 * | 管理台 | `/admin*`、`/login`、`/change-password` | allow |
 * | 管理台 | 其它（`/`、`/session/*`、未知路径） | redirect 到 `userBaseUrl#<toPath>` |
 * | 用户面 | `/admin*` | redirect 到 `adminBaseUrl#<toPath>` |
 * | 用户面 | 其它 | allow |
 * | 任一 | 无法判定（site 信息拿不到 / URL 解析失败） | allow（fail-open） |
 * | 任一 | 目标 origin === 当前 origin（已经在对的 host 上） | allow（**防重定向环**） |
 *
 * 规格没覆盖的一格，本实现的取舍（写进报告）：**当前 origin 既不是用户面也不是管理台**时（`vite dev`
 * 的 `localhost:5173`、预览 host、任何陌生 host）一律 allow。理由与 fail-open 同源：判不出「我是谁」
 * 就不该替用户换地址；dev 下 `/api/site` 会回真实 base URL，若照跳就会把本地联调踢到线上域名。
 */
export function hostGateDecision(input: HostGateInput): HostGateDecision {
  const here = parseOrigin(input.currentOrigin);
  const userOrigin = parseOrigin(input.userBaseUrl);
  const adminOrigin = parseOrigin(input.adminBaseUrl);
  // 无法判定 ⇒ fail-open（跳错方向比不跳更糟）。
  if (here === null || userOrigin === null || adminOrigin === null) return { action: 'allow' };

  // 脏输入：非「以 / 开头的路径」不是本闸该处理的东西（`to.fullPath` 契约上恒为 `/...`）。
  const toPath = input.toPath;
  if (typeof toPath !== 'string' || !toPath.startsWith('/')) return { action: 'allow' };

  const targetOrigin = isAdminPath(toPath) ? adminOrigin : userOrigin;
  // ① 防环：已经站在目标 host 上 ⇒ 立刻放行（**先于**任何其它判断，不依赖调用方记得）。
  if (targetOrigin === here) return { action: 'allow' };

  // ② 判「我是谁」用 **hostname**，不用 origin —— 2026-11-06 真机 bug：用户面同时有
  //   `http://station.<伞域>:8090` 与 `https://station.<伞域>:8443`，而 `/api/site` 的 `userBaseUrl`
  //   只有一个（8090）。用 origin 比较 ⇒ 8443 被当成「认不出的 host」⇒ fail-open ⇒
  //   **管理台页面直接在用户面渲染出来**（`https://station...:8443/#/admin/users` 显示 Admin Console）。
  //   同一个 hostname 的不同端口/协议是**同一个面**；跳转目标仍用完整 origin（那是 ① 的事）。
  const hereHost = parseHostname(input.currentOrigin);
  const userHost = parseHostname(input.userBaseUrl);
  const adminHost = parseHostname(input.adminBaseUrl);
  if (hereHost === null || userHost === null || adminHost === null) return { action: 'allow' };

  // ③ 判不出当前是谁（既非用户面也非管理台）⇒ 不替用户换地址。
  if (hereHost !== userHost && hereHost !== adminHost) return { action: 'allow' };

  if (hereHost === adminHost) {
    // ③ 管理台 host：登录页与改密屏留在原地（管理台自己也要登录；受限会话的第一屏就是改密屏）。
    //    比较用**剥掉 query 的路径**：`/login?redirect=/admin/users` 必须命中（见 `pathOf` 头注）。
    const path = pathOf(toPath);
    if (path === LOGIN_PATH || path === CHANGE_PASSWORD_PATH) return { action: 'allow' };
    // 管理台 host 上的管理路径就地渲染（不跳）。① 的 origin 相等在「配置写成 :443 隐式、实际走 :9443」
    // 这类同 host 不同端口的形态下不成立，所以这里要显式判一次——否则管理台会把自己跳走。
    if (isAdminPath(toPath)) return { action: 'allow' };
    // 其余（工作台、会话深链、未知路径）⇒ 回用户面。
    const url = hashUrl(input.userBaseUrl, toPath);
    return url === null ? { action: 'allow' } : { action: 'redirect', url };
  }

  // ④ 用户面：**只有** `/admin*` 要去管理台，其余一律放行。
  //   ⚠ 这里必须先判 isAdminPath：用户面可能不是「配置里那个 origin」（如 https:8443 vs 配置的 http:8090），
  //   此时 ① 的 origin 相等不成立，若不判就会把普通路径也送去管理台（2026-11-06 真机回归）。
  if (!isAdminPath(toPath)) return { action: 'allow' };
  const url = hashUrl(input.adminBaseUrl, toPath);
  return url === null ? { action: 'allow' } : { action: 'redirect', url };
}
