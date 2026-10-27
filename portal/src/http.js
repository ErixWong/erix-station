// HTTP 服务：零框架 node:http 路由分发。
// 端点：GET /healthz、GET /api/health、POST /api/auth/login（口令→pending_token）、
//       POST /api/auth/login/totp（TOTP→session cookie）、POST /api/auth/logout、GET /api/me + 静态页面。
// 旧路径 /api/login、/api/logout 仅 307 到新路径（不保留旧单步发 cookie 行为）。
// cookie 语义见 docs/api/portal.md §2.5；两步登录见 §2.2/§2.3。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import * as auth from './auth.js';
import * as migrate from './migrate.js';
import * as projects from './projects.js';
import * as sessions from './sessions.js';
import * as queuedInputs from './queued-inputs.js'; // #370：对话输入队列
import * as idempotency from './idempotency.js';
import * as preview from './preview.js';
import * as internal from './internal.js';
import * as artifacts from './artifacts.js';
import * as llm from './llm.js';
import { createLlmGatewayClient, LlmGatewayError } from './llm-gateway.js';
import * as admin from './admin.js';
import * as dirs from './dirs.js';
import * as previewmiss from './previewmiss.js';
import * as previewproxy from './previewproxy.js';
import { getGitLight } from './gitlight.js';
import * as gitCredential from './git-credential.js';
import * as gitHosts from './git-hosts.js';
import { createDockerClient, onboardFde } from './provisioner.js';
import * as onboarding from './onboarding.js';
import * as offboarding from './offboarding.js';
import * as portalloc from './portalloc.js';
import {
  PREVIEW_PORT_COUNT,
  PREVIEW_PORT_POOL_START,
  isAlignedPreviewBlockStart,
  isPreviewPortInPool,
} from './previewpool.js';
import { createRateLimiter, createSemaphore } from './ratelimit.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 带标准错误信封的 HTTP 异常（route 层统一捕获 → sendJson）。 */
class HttpError extends Error {
  constructor(status, code, message, { retryable = false, details, headers } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.headers = headers;
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function errorBody(code, message, retryable = false, details) {
  const err = { code, message, retryable };
  if (details !== undefined) err.details = details;
  return { error: err };
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/**
 * #241：forwardAuth **deny** 响应的 CORS 头（单一实现，真实落点 = portal 的 deny 分支）。
 *
 * 为什么必须带：deny 响应经 Traefik 原样透给浏览器（实测：v3.7.13 把 auth 子响应的
 * 状态码/响应体/响应头都拷给客户端）。不带 ACAO 时浏览器只报
 * `No 'Access-Control-Allow-Origin' header is present`，把「需要预览票据」伪装成
 * 「应用 CORS 配错」——用户永远看不到真实原因（403 preview_ticket_required）。
 *
 * 口径：
 *  - **回显**单个 Origin（不用 `*`：预览流一律 `credentials:'include'`，带凭据时规范禁止通配）。
 *  - 只接受 `scheme://host[:port]`（含 IPv6 字面量）或字面量 `null`：禁空格/逗号/`/`/`?`/`#`/CR/LF，
 *    防响应头注入与「一个 ACAO 头里塞两个值」；非法 Origin 直接不回显（宁可退回浏览器原始报错）。
 *  - `Vary: Origin` 必带（响应随 Origin 变，缓存不得复用）。
 *  - 状态码与错误信封一律**不变**（安全底线：无票据仍 403，只是让浏览器能读出真相）。
 */
const CORS_ORIGIN_RE = new RegExp(
  ['^',
    '[A-Za-z][A-Za-z0-9+.-]*:\\/\\/', // scheme "://"
    '(?:',
    '[A-Za-z0-9._-]+', // IPv4 / 域名（字母数字与 . _ -）
    '|\\[[0-9A-Fa-f:]+\\]', // IPv6 字面量 [::1]
    ')',
    '(?::\\d{1,5})?', // 端口（dev :8090 必须原样保留，它是 origin 的一部分）
    '$',
  ].join(''),
);

export function corsDenyHeaders(originHeader) {
  const origin = typeof originHeader === 'string' ? originHeader.trim() : '';
  if (origin === '' || origin.length > 2048) return {};
  if (origin !== 'null' && !CORS_ORIGIN_RE.test(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

// ---- #234：跨站请求防线（Origin / Sec-Fetch-Site 同源校验）----
// 口径的单一真相在 docs/api/portal.md §2.11；这里只放判据本身（纯函数，便于单测）。

/** 参与校验的写方法（portal.md §2.11 判据①）：GET/HEAD/OPTIONS 一律放行。 */
const CSRF_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** 默认端口表：只在「与该 authority 自己的 scheme 相同」时才剥掉（非默认端口必须原样保留）。 */
const CSRF_DEFAULT_PORTS = { http: '80', https: '443' };
/**
 * Origin 的形状：`scheme://authority`（authority = 域名/IPv4 或 `[IPv6]`，可带端口），**不带路径**。
 * 与 #241 的 `CORS_ORIGIN_RE` 同一口径（两处若分叉， ACAO 回显与同源判定会互相打脸）。
 */
const CSRF_ORIGIN_PARTS_RE = new RegExp(
  ['^',
    '([A-Za-z][A-Za-z0-9+.-]*):\\/\\/', // 1 = scheme
    '(', // 2 = authority（host[:port]）
    '(?:',
    '[A-Za-z0-9._-]+', // IPv4 / 域名
    '|\\[[0-9A-Fa-f:]+\\]', // IPv6 字面量 [::1]
    ')',
    '(?::\\d{1,5})?', // 端口（dev 的 :8090 是 origin 的一部分，不得丢）
    ')$',
  ].join(''),
);

/** 小写 + 剥掉**与该 scheme 相同**的默认端口（http:80 / https:443）；非默认端口（dev `:8090`）原样留。 */
function normalizeCsrfAuthority(authority, scheme) {
  let value = String(authority).toLowerCase();
  // hasOwn 而非直取：scheme 是调用方给的，`constructor://x:9990` 这类野值不能让原型链上的 'function'
  // 充成默认端口表项（它不是端口，拼进正则会把 9990 之外的东西当端口剥）。
  const def = Object.hasOwn(CSRF_DEFAULT_PORTS, scheme) ? CSRF_DEFAULT_PORTS[scheme] : null;
  if (def) value = value.replace(new RegExp(`:${def}$`), '');
  return value;
}

/** 单值 + 无空白（含制表/CR/LF）+ 形状合法 ⇒ `{scheme, authority}`；否则 `null`（畸形 ⇒ 拒）。 */
function parseCsrfOrigin(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim(); // 首部 OWS 已由 HTTP 解析器剪掉；这里只兑代理粘的空白，内部空白仍按畸形拒
  if (value === '' || value.length > 2048) return null;
  if (/[\s,]/.test(value)) return null; // 空格/制表/CR-LF 或多值（重复 Origin 头 Node 会拼成 `a, b`）⇒ 拒
  const m = CSRF_ORIGIN_PARTS_RE.exec(value);
  if (!m) return null; // 带路径 / `null` / `javascript:alert(1)` / 不可解析 ⇒ 拒
  const scheme = m[1].toLowerCase();
  return { scheme, authority: normalizeCsrfAuthority(m[2], scheme) };
}

/**
 * 请求自身的 authority：优先 `X-Forwarded-Host`（本部署 Traefik `trustForwardHeader: false`，
 * 会按真实连接覆写），无则 `Host`（与 `handleForwardAuth` 取 host 的优先级一致）。
 * 返回 `null` = 两个头都没（无从判定）；`{malformed: true}` = 有但不合法。
 */
function parseCsrfRequestAuthority(forwardedHostHeader, hostHeader, scheme) {
  const raw = [forwardedHostHeader, hostHeader].find(
    (v) => typeof v === 'string' && v.trim() !== '',
  );
  if (raw === undefined) return null;
  const value = raw.trim();
  if (value.length > 2048 || /[\s,]/.test(value) || value.includes('://')) return { malformed: true };
  return { authority: normalizeCsrfAuthority(value, scheme) };
}

/**
 * #234：跨站请求防线的**纯判据**（不发响应、不读 cookie，因此可单独单测）。
 *
 * 为什么需要：session cookie 是 host-only 会话 cookie + `SameSite=Lax`（portal.md §2.5），Lax 只挡
 * 「跨站带 cookie」这一半；而本部署 portal 在 Traefik 后面、入口多个（`station.fde.erix.vip` 与
 * `100.100.0.3`），cookie 本身不区分发起方。这里加一道**不依赖配置项**（同源基线从请求自己的
 * Host 派生，天然支持多入口）的服务端防线，并把拒绝写审计（可观测）。
 *
 * 判据（按顺序，任一命中即定论）：
 *  a. `Sec-Fetch-Site` 为 `cross-site`/`cross-origin` ⇒ **拒**（fail-closed 优先，即使 Origin 缺失或看起来同源）；
 *  b. `same-origin` ⇒ **放行**（真同源，即使 Origin 缺失或畸形）；
 *  c. 否则有 `Origin` ⇒ **只比 authority**（host[:port]）与请求自身的 authority；
 *  d. 两者都没有（curl / CLI / 容器内脚本）⇒ **放行**。
 *
 * **`same-site` 不直接放行**（#234 返修，2026-10-13 主 agent 亲审发现）：`Sec-Fetch-Site: same-site` 的规范语义是
 * 「同注册域、不同 origin」，而本站恰好**整站坐在同一个注册域 `erix.vip` 下**（portal 在 `station.fde.erix.vip`、
 * FDE 预览在 `eric-p-22000.fde.erix.vip`），且 session cookie 是 **host-only + `SameSite=Lax`**（portal.md §2.5）——
 * `SameSite` 判的同样是注册域 ⇒ 预览 host 的 XHR **照样带上 portal 的会话 cookie**（Lax 不挡同站），CORS 只让它
 * 读不到响应、**写副作用已经发生** = 教科书意义上的 CSRF。这正是本站最现实的攻击面（预览 host 上跑的、agent 写的
 * 应用去 POST portal API），所以 `same-site` 必须落到判据 c 的 Origin authority 精确比对（同注册域但不同 origin
 * ⇒ 不等 ⇒ 拒 `origin_mismatch`）。`same-site` 且 Origin 缺失 ⇒ 落 d 放行（与既有口径一致，不新造严格性）。
 *
 * **只比 authority、不比 scheme**（契约点）：本部署处在 http（dev `:8090` / `100.100.0.3:8090`）与
 * https 共存的过渡期，portal 又常在边缘卸载 TLS，`X-Forwarded-Proto` 与 Origin 的 scheme 不总是同形；
 * 拿 scheme 参战会把「同一个站点上的 http/https 两面」误杀成跨站。CSRF 要防的是**别的站点**
 * 带本站点 cookie 发写请求（同站不同 scheme 不构成这个威胁），故 scheme 只用于默认端口归一化。
 *
 * 失败绝不默认同源（「解析失败就当同源」是这道防线唯一不能发的方式）：Origin 畸形（不可解析 /
 * 多值 / 含空白或 CR-LF / 带路径）与「有 Origin 但没有可比对的 Host」一律拒。
 *
 * @returns {{allow: boolean, verdict: string, details?: {origin: string|null, sec_fetch_site: string|null, method: string}}}
 *          verdict：`exempt` | `read_method` | `same_origin` | `origin_match` | `no_evidence`（放行）／
 *          `cross_site` | `origin_mismatch` | `malformed_origin` | `malformed_request_authority` |
 *          `missing_request_authority`（拒绝）。
 */
export function checkSameOrigin({
  method = '',
  originHeader = null,
  secFetchSiteHeader = null,
  hostHeader = null,
  forwardedHostHeader = null,
} = {}) {
  const httpMethod = typeof method === 'string' ? method.toUpperCase() : '';
  const origin = originHeader == null ? null : String(originHeader);
  // 已知四个 token 走精确小写比对；其余（拼错的、`none`）一律当「无结论」，落到 Origin 判据。
  // 多值（重复 SFS 头被 Node 拼成 `a, b`）按 token 展开：跨站 token 只要出现过就算跨站（fail-closed）。
  const secFetchSite = secFetchSiteHeader == null ? null : String(secFetchSiteHeader).trim().toLowerCase();
  const sfsTokens = secFetchSite === null ? [] : secFetchSite.split(',').map((token) => token.trim());
  const details = { origin, sec_fetch_site: secFetchSite, method: httpMethod };
  const deny = (verdict) => ({ allow: false, verdict, details });

  // ① 只判写方法：SSE `GET /api/sessions/:id/events`、预览 ticket 的 302 兑换都是 GET，不得打断。
  if (!CSRF_WRITE_METHODS.has(httpMethod)) return { allow: true, verdict: 'read_method' };

  // a. 显式跨站 ⇒ 拒（先看 SFS：它是浏览器给的、不可伪造，优先于可被代理改写的 Origin）。
  //    `cross-origin` 是**防御性值**：它不是 `Sec-Fetch-Site` 的合法取值（规范只有 same-origin / same-site /
  //    cross-site / none 四个），多接一个不存在的值不会漏、方向仍是 fail-closed，别误以为我们漏了个规范值。
  if (sfsTokens.some((token) => token === 'cross-site' || token === 'cross-origin')) return deny('cross_site');
  // b. 显式**同源** ⇒ 放行（即使 Origin 缺失或畸形）。`same-site` **不在这里**——同注册域不同 origin 就是本站
  //    最现实的 CSRF 形状（预览 host → portal API，host-only + Lax cookie 照样携带），必须落到 c 比 authority。
  if (sfsTokens.some((token) => token === 'same-origin')) {
    return { allow: true, verdict: 'same_origin', details };
  }

  // c. 有 Origin ⇒ 只比 authority。
  if (origin !== null && origin.trim() !== '') {
    const parsed = parseCsrfOrigin(origin);
    if (parsed === null) return deny('malformed_origin');
    const request = parseCsrfRequestAuthority(forwardedHostHeader, hostHeader, parsed.scheme);
    if (request === null) return deny('missing_request_authority');
    if (request.malformed) return deny('malformed_request_authority');
    if (request.authority !== parsed.authority) return deny('origin_mismatch');
    return { allow: true, verdict: 'origin_match', details };
  }

  // d. 两个头都没有 ⇒ 放行（否则 curl / CLI / 容器内脚本与现有 e2e 全挂）。
  return { allow: true, verdict: 'no_evidence', details };
}

/**
 * #234：把 #234 判据接到一个具体请求上，含两类**豁免端点**（无 CSRF 语义）：
 *  - `/api/internal/*`：容器 → portal，per-container token 鉴权、**不带 cookie**（§9）；
 *  - `/api/forward-auth`：Traefik 回调，它的 `Origin` 是**被代理页面**的 origin，天然不等于 portal host（§2.7）。
 */
export function csrfGateFor(req, pathname) {
  if (pathname.startsWith('/api/internal/') || pathname === '/api/forward-auth') {
    return { allow: true, verdict: 'exempt' };
  }
  return checkSameOrigin({
    method: req?.method,
    originHeader: req?.headers?.origin ?? null,
    secFetchSiteHeader: req?.headers?.['sec-fetch-site'] ?? null,
    hostHeader: req?.headers?.host ?? null,
    forwardedHostHeader: req?.headers?.['x-forwarded-host'] ?? null,
  });
}

// ---- #255 受限会话门（首登强制改密，portal.md §2.11a）----

/**
 * **受限会话** = 已认证、但 `users.must_change_password = true`（管理员代设/重置过口令，那枚口令
 * 还没经过本人之手）。这种会话在改密之前只能碰下面这张清单，其余 `/api/*` 一律
 * `403 password_change_required`（portal.md §2.11a）。
 *
 * 写成**显式常量**而不是散在 `if` 里的条件，是因为清单本身就是契约：
 * **少一条 = 死锁**（唯一出口被自己挡住，人被困在改密屏外），
 * **多一条 = 漏口**（拿别人设的口令照样能把平台用完，本单等于没做）。
 * 匹配形状：`{ method, path, reason }`；`method: '*'` = 任意方法；`prefix: true` = 前缀匹配。
 *
 * ⚠ **只管 `/api/*`**：静态资源与 SPA 外壳不在本门之下（`serveStatic` 在 `route()` 里另有一条路）——
 *    改密屏本身就是 SPA 页面，挡掉 JS/CSS 会让人连「去改密」的界面都打不开，那是自我锁死不是防线。
 */
export const RESTRICTED_SESSION_ALLOWLIST = Object.freeze([
  Object.freeze({
    method: 'GET',
    path: '/api/me',
    reason: '受限会话的唯一数据源：前端要靠它拿到「我是谁 + 为什么被弹去改密」（旗标随本端点的 user 对象下发，'
      + '§2.6）。挡掉它 = SPA 只看见一片 403，不知道该把用户送去哪儿。',
  }),
  Object.freeze({
    method: '*',
    path: '/api/me/password',
    reason: '受限状态的**唯一出口**（§2.6a），门必须能从这里出去；把它挡掉就是死锁。'
      + '整条路径放行而**不限方法**：非 POST 该由路由自己回 `405 method_not_allowed`，'
      + '而不是被门改成 403——403 会让前端以为「连改密这条路也被锁了」。',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/auth/logout',
    reason: '登出永远可达：不想改密的人至少能换账号/退出。挡住它会把人钉在一个自己进不去的会话里。',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/auth/login',
    reason: '第一步（口令校验）**此刻还没有会话**，本门对无会话请求本就无效（见 `restrictedSessionBlocked`）；'
      + '列进来是防「受限用户重新登录拿一枚新会话」被自己的旧会话形状误伤，也让清单与 §0.1 端点表对齐。',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/auth/login/totp',
    reason: '第二步（TOTP）同上：注册了 TOTP 的受限账号要能走完两步登录，否则连改密前的会话都拿不到。',
  }),
  Object.freeze({
    method: '*',
    path: '/api/forward-auth',
    reason: '⚠ **本单最大的雷**：Traefik forwardAuth 回调（§2.7）。`routes.js` 的 `authRequestHeaders` 白名单里就带 '
      + '`Cookie`，所以浏览器那侧的 cookie（登录 cookie 与预览 cookie 同源携带的形状，例如测试里同为 127.0.0.1、'
      + '以及 portal 与预览共享 cookie 作用域的部署形态）会原样进到这条请求；而它的语义是「这片预览该不该放行」，'
      + '与「本人是否欠一次改密」无关。被本门挡成 `403 password_change_required` 时，**Traefik 只会把它当成一次认证失败** '
      + '⇒ 该用户的**整片预览平面**（`*.fde.<base>` 全部端口）一起挂掉，而他要改的只是口令。'
      + '另注：本端点压根不查 `login_sessions`（凭证是 `preview_grants` 的 ticket / 预览 cookie），门在它身上没有可判的主体。',
  }),
  Object.freeze({
    method: '*',
    path: '/api/internal/',
    prefix: true,
    reason: '容器 → portal 的内部通道（§9）：per-container Bearer token 鉴权、**不带登录 cookie**，'
      + '改密状态与它无关。与 #234 的豁免端点同一批理由（见 `csrfGateFor`）。',
  }),
  // 旧路径 `POST /api/login` / `POST /api/logout`（→ 307 到新路径，portal.md §0.1）也**必须进清单**：
  // 本门挂在 routeApi 顶部、**在那两条 307 重写之前**执行，所以旧路径确实会走到本门（不是「到不了」）。
  // 两条都在下面的条目里，判据上「新旧两条」是真覆盖，不是注释里的安慰。
  Object.freeze({
    method: 'POST',
    path: '/api/login',
    reason: '旧登录路径（307 → /api/auth/login）。本门在 307 重写**之前**执行，所以旧路径同样会过门：'
      + '不列它，一个还带着旧会话 cookie 的受限用户连「重新登录」这个动作都会被 403 锁死。',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/logout',
    reason: '旧登出路径（307 → /api/auth/logout）：同上，两条路径的语义是同一个「退出」，必须一起可达。',
  }),
]);

/**
 * 受限会话门的放行判据（纯函数，`portal/test/must-change-password.test.js` 逐条钉住）。
 * `HEAD` 按 `GET` 判：HEAD 是 GET 的子集（只去 body），同一份放行理由对它同样成立。
 */
export function restrictedSessionAllows(method, pathname) {
  const m = method === 'HEAD' ? 'GET' : (method ?? 'GET');
  return RESTRICTED_SESSION_ALLOWLIST.some((entry) => {
    if (entry.method !== '*' && entry.method !== m) return false;
    return entry.prefix ? pathname.startsWith(entry.path) : pathname === entry.path;
  });
}

/**
 * #255：本请求是否该被受限会话门挡下。**只在放行清单之外**才去查会话 ⇒ 清单内零额外开销；
 * 清单外本来就要查一次会话（`requireSession`），这里用 `resolveSession` 的请求内缓存复用同一次查表，
 * 所以全链路仍然只有**一次** `login_sessions` 查表（不是每个 API 请求多一次往返）。
 *
 * 无会话 / 会话无效 ⇒ **不挡**：401 的语义归各 handler 自己（本门的职责只是「已认证但欠一次改密」）。
 */
async function restrictedSessionBlocked(req, ctx, pathname) {
  if (restrictedSessionAllows(req.method, pathname)) return false;
  const session = await resolveSession(req, ctx);
  return session?.user?.must_change_password === true;
}

/** F2：审计前只记 path，剥离所有 query（?preview_ticket=<明文> 等绝不入审计）。 */
function pathOnly(uri) {
  if (typeof uri !== 'string') return '/';
  const q = uri.indexOf('?');
  return q === -1 ? uri : uri.slice(0, q);
}

function sessionCookieHeader(cookie, token) {
  const parts = [`${cookie.name}=${token}`, `Path=${cookie.path}`];
  if (cookie.httpOnly) parts.push('HttpOnly');
  if (cookie.secure) parts.push('Secure');
  parts.push(`SameSite=${cookie.sameSite}`, `Max-Age=${cookie.maxAge}`);
  return parts.join('; ');
}

/** 预览 cookie（host-only，无 Domain）——ticket 换取 / 滚动续期重发（portal.md §2.7/§2.8）。 */
function previewCookieHeader(cookie, token) {
  const parts = [`${cookie.name}=${token}`, `Path=${cookie.path}`];
  if (cookie.httpOnly) parts.push('HttpOnly');
  if (cookie.secure) parts.push('Secure');
  parts.push(`SameSite=${cookie.sameSite}`, `Max-Age=${cookie.maxAge}`);
  return parts.join('; ');
}

function clearCookieHeader(cookie) {
  const parts = [
    `${cookie.name}=`,
    `Path=${cookie.path}`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (cookie.httpOnly) parts.push('HttpOnly');
  if (cookie.secure) parts.push('Secure');
  parts.push(`SameSite=${cookie.sameSite}`);
  return parts.join('; ');
}

/**
 * 校验 Content-Type（JSON 端点要求 application/json）。
 *
 * issue #236（第 2 条）：**无 body 的请求不再强制 `Content-Type`**。此前
 * `curl -X POST .../stop`（不带 body、不带该头）会 400 `validation_failed`
 * 「Content-Type 必须为 application/json」——前端总是发 `body: '{}'` 所以 UI 无感，但手工客户端 /
 * curl / 脚本按 REST 常识发空 body 就踩。现口径（决策者倾向的 ①）：
 *   ① 声明了 `application/json`（可带 `; charset=…`）⇒ 放行（唯一被接受的正向声明）；
 *   ② **没有** `Content-Type` 头 **且** 请求确实无 body ⇒ 放行（`readJsonBody` 对空体返回 `{}`）；
 *   ③ 其余（有 body 但没声明 json / 声明了别的类型 / 头显式为空串）⇒ 仍 400（校验面只放宽这一格）。
 * ⚠ 「无 body」只认 `Content-Length: 0` 或**既无 CL 也无 `Transfer-Encoding`**；chunked 的体在读完
 *   之前不可知 ⇒ 按「有 body」处理（fail-closed，绝不把带体请求放过去）。
 * ⚠ 本函数是**所有** JSON 端点的统一闸（POST / PUT / DELETE 共 40+ 处调用点），#234 的 Origin
 *   同源门在它**之前**（`routeApi` 开头），两者语义无关、互不影响。
 */
function requireJson(req) {
  const raw = req.headers['content-type'];
  const ct = (raw || '').split(';')[0].trim().toLowerCase();
  if (ct === 'application/json') return;
  if (raw === undefined && requestHasNoBody(req)) return;
  throw new HttpError(400, 'validation_failed', 'Content-Type 必须为 application/json');
}

/** issue #236：请求是否**确定**没有 body（`Content-Length: 0`，或既无 CL 也无 chunked 编码）。 */
function requestHasNoBody(req) {
  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined) {
    const n = Number(contentLength);
    return Number.isFinite(n) && n === 0;
  }
  return req.headers['transfer-encoding'] === undefined;
}

/** 读取 JSON 请求体：Content-Length 早期拒绝 413；流式超限也 413（不 destroy 连接，回错误信封）。 */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const contentLength = req.headers['content-length'];
    if (contentLength) {
      const n = Number(contentLength);
      if (Number.isFinite(n) && n > limit) {
        reject(new HttpError(413, 'payload_too_large', 'request body too large', { details: { max_bytes: limit } }));
        req.resume(); // 排空，配合响应 Connection: close
        return;
      }
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'payload_too_large', 'request body too large', { details: { max_bytes: limit } }));
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'validation_failed', 'invalid JSON body'));
      }
    });
    req.on('error', (e) => reject(e));
  });
}

/** 读取原始字节请求体（artifact 上传等二进制端点）；超限语义同 readJsonBody。 */
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const contentLength = req.headers['content-length'];
    if (contentLength) {
      const n = Number(contentLength);
      if (Number.isFinite(n) && n > limit) {
        reject(new HttpError(413, 'payload_too_large', 'request body too large', { details: { max_bytes: limit } }));
        req.resume(); // 排空，配合响应 Connection: close
        return;
      }
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'payload_too_large', 'request body too large', { details: { max_bytes: limit } }));
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (e) => reject(e));
  });
}

/**
 * readiness：DB 可达 + 迁移已到 head（baseline + deploy/migrations/*.sql 全部已应用）。
 * 对比实际 migration head（deploy-contract §3.3 / §8），而非仅 baseline 存在。
 */
export async function checkReady(pool, migrationsDir = migrate.defaultMigrationsDir()) {
  try {
    const r = await pool.query(`SELECT version FROM schema_migrations`);
    const applied = new Set((r.rows || []).map((x) => x.version));
    const expected = migrate.computeExpectedVersions(migrationsDir);
    return expected.length > 0 && expected.every((v) => applied.has(v));
  } catch {
    return false;
  }
}

export function createServer({ pool, config, log = console, docker = null, llmGateway = null }) {
  const loginLimiter = createRateLimiter(config.loginRateLimit);
  // TOTP 失败限流按「账户 + IP」计数（防换新 pending_token 绕过）；单 token 尝试上限单独计。
  const totpLimiter = createRateLimiter({
    maxFailures: config.totpRateLimit.maxFailures,
    windowMs: config.totpRateLimit.windowMs,
    blockMs: config.totpRateLimit.blockMs,
    maxEntries: config.totpRateLimit.maxEntries,
  });
  const totpTokenLimiter = createRateLimiter({
    maxFailures: config.totpRateLimit.perTokenMaxFailures,
    windowMs: config.totpRateLimit.windowMs,
    blockMs: config.totpRateLimit.blockMs,
    maxEntries: config.totpRateLimit.maxEntries,
  });
  const kdfSemaphore = createSemaphore({
    max: config.kdfConcurrency,
    maxQueue: config.kdfQueueLimit,
    queueTimeoutMs: config.kdfQueueTimeoutMs,
  });
  const previewTicketLimiter = createRateLimiter(config.previewTicketRateLimit ?? {
    maxFailures: 20,
    windowMs: 60 * 1000,
    blockMs: 60 * 1000,
    maxEntries: 10000,
  });
  const ctx = {
    pool, config, log, loginLimiter, totpLimiter, totpTokenLimiter, kdfSemaphore, previewTicketLimiter, docker,
    llmGateway: llmGateway ?? createLlmGatewayClient({
      adminUrl: config.llmGatewayAdminUrl ?? 'http://station-litellm:4000',
      masterKey: config.llmGatewayMasterKey ?? '',
    }),
  };
  // issue #38 Phase B2 admin UI：portal serve 进程本就有 config.dockerHost（cli.js serve 的
  // startProvisionerLoop 也用它自建 client——调查结论见 Phase B2 报告），故 provision 端点**可实现**：
  // 按需懒建并缓存 docker client（不持有连接，仅 HTTP 工厂）。测试可经 createServer({ docker }) 注入。
  let lazyDocker = null;
  ctx.adminDocker = () => {
    if (ctx.docker) return ctx.docker;
    if (!lazyDocker) lazyDocker = createDockerClient({ dockerHost: ctx.config.dockerHost });
    return lazyDocker;
  };

  return http.createServer(async (req, res) => {
    try {
      await route(req, res, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        const headers = { ...(err.headers || {}) };
        if (err.status === 413) headers['Connection'] = 'close'; // 未读完的请求体需断开
        sendJson(res, err.status, errorBody(err.code, err.message, err.retryable, err.details), headers);
        return;
      }
      if (err instanceof projects.ProjectError) {
        sendJson(res, err.httpStatus, errorBody(err.code, err.message, false, err.details));
        return;
      }
      if (err instanceof sessions.SessionError) {
        sendJson(res, err.httpStatus, errorBody(err.code, err.message, false, err.details));
        return;
      }
      if (err instanceof dirs.DirError) {
        sendJson(res, err.httpStatus, errorBody(err.code, err.message, false, err.details));
        return;
      }
      if (err instanceof idempotency.IdempotencyError) {
        sendJson(res, err.httpStatus, errorBody(err.code, err.message, err.retryable, err.details));
        return;
      }
      if (err instanceof internal.InternalError) {
        sendJson(res, err.status, errorBody(err.code, err.message, err.retryable, err.details));
        return;
      }
      if (err instanceof llm.LlmError) {
        // issue #261014 切片 B2：`retryable` 由错误自己带（既有 LlmError 不带 ⇒ 恒 false，行为不变）。
        sendJson(res, err.httpStatus, errorBody(err.code, err.message, err.retryable === true, err.details));
        return;
      }
      if (err instanceof LlmGatewayError) {
        sendJson(res, err.status, errorBody('llm_gateway_error', err.message));
        return;
      }
      if (err instanceof gitCredential.GitCredentialError) {
        sendJson(res, err.httpStatus, errorBody(err.code, err.message, false, err.details));
        return;
      }
      if (err instanceof gitHosts.GitHostError) {
        sendJson(res, err.httpStatus, errorBody(err.code, err.message, false, err.details));
        return;
      }
      if (err instanceof admin.AdminError) {
        sendJson(res, err.httpStatus, errorBody(err.code, err.message, false, err.details));
        return;
      }
      log.error?.('[portal] unhandled:', err);
      if (!res.headersSent) sendJson(res, 500, errorBody('internal', 'internal error'));
      else res.destroy();
    }
  });
}

/**
 * 路径参数中的 UUID 解码 + **归一化为小写**（F5 / reviewer M-4）。
 * UUID 大小写等价（十六进制），但宿主侧会把 session/run id 当**字符串**用：
 *   ① 幂等 `endpoint` 串（`POST /api/sessions/<id>/messages`）——同一 session 的大小写不同会变成两个幂等命名空间；
 *   ② session SSE hub 的 key（`registerSessionClient(sessionId)`）——DB 回读的 id 恒为小写，
 *      用大写路径连上来的客户端会被注册到另一个 key 下，**永远收不到实时事件**。
 * 合法 UUID 的字符集（0-9a-f）不受影响；仍按原样交给各自的 UUID 正则/DB 查询（非法值照常 404）。
 */
function decodeUuid(raw) {
  return decodeURIComponent(raw).toLowerCase();
}

/**
 * 标准 UUID 的字符形状（小写、带连字符）。用于**请求体里的** id 数组（路径参数另有各自的解码路径）：
 * 必须先判形状再交给 `= ANY($1::uuid[])`——畸形串会让 PG 直接 22P02（500），而这是客户端输入。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function decodeAdminUserUuid(raw) {
  let id;
  try {
    id = decodeUuid(raw);
  } catch {
    throw new HttpError(400, 'validation_failed', '用户 id 必须是 UUID', { details: { field: 'id' } });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new HttpError(400, 'validation_failed', '用户 id 必须是 UUID', { details: { field: 'id' } });
  }
  return id;
}

async function route(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  // /admin 兼容跳转（issue #61 P4）：管理台已 Vue 化（P3，/#/admin），旧 admin.html 退役。
  // GET/HEAD → 302 到 SPA hash 路由 /#/admin；认证与角色判断全部交给前端路由守卫：
  // 未登录 → /#/login?redirect=/admin，非 admin → 回工作台（portal/frontend/src/router.ts），
  // 与旧版「未登录 302 /、非 admin 403」语义等价且更简单——后端不再为页面路由维护会话/角色逻辑。
  // POST 等非幂等方法：SPA 页面路由下无意义，按惯例 405（不 302：避免改写非幂等请求的语义）。
  if (pathname === '/admin') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }
    res.writeHead(302, { Location: '/#/admin' });
    res.end();
    return;
  }

  if (pathname === '/healthz' || pathname === '/api/health') {
    if (req.method !== 'GET') {
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }
    const ok = await checkReady(ctx.pool);
    if (ok) return sendJson(res, 200, { status: 'ok' });
    return sendJson(res, 503, errorBody('migration_failed', 'not ready'));
  }

  if (pathname.startsWith('/api/')) {
    return routeApi(req, res, ctx, url);
  }
  // #366 P2：/pv/<code>/** 是带鉴权的反代路由，不是静态资源——必须在 serveStatic 分流之前进 routeApi。
  // （routeApi 内部只匹配 /api/* 的处理器，/pv 的路由条目就在那里；其余非 /api 路径照旧进静态。）
  if (pathname.startsWith('/pv/')) {
    return routeApi(req, res, ctx, url);
  }

  return serveStatic(req, res, ctx, url);
}

async function routeApi(req, res, ctx, url) {
  const { pathname } = url;
  const { pool, config } = ctx;

  // ---- #234：跨站写请求防线（portal.md §2.11）——先于任何 handler 执行，否则 CSRF 会先碰到底层副作用。----
  // 豁免（在 csrfGateFor 里）：/api/internal/* 与 /api/forward-auth。拒绝：403 `cross_origin_forbidden`
  // + #241 那套 CORS deny 头（否则浏览器只报 ACAO 缺失、看不到真实原因，AGENTS §8.11）+ 一条审计。
  const csrf = csrfGateFor(req, pathname);
  if (!csrf.allow) {
    // 审计失败不得影响响应（同 §2.7 forward-auth 口径）；details 只记 origin/sec_fetch_site/method，不含 cookie。
    await auth.audit(pool, {
      actorId: null,
      action: 'auth.csrf_denied',
      target: pathOnly(pathname),
      details: csrf.details,
    }).catch(() => {});
    return sendJson(
      res,
      403,
      errorBody('cross_origin_forbidden', 'cross-origin write request rejected', false, csrf.details),
      corsDenyHeaders(req.headers.origin),
    );
  }

  // ---- #255 受限会话门（首登强制改密，portal.md §2.11a）----
  // `must_change_password=true` 的会话（口令由管理员代设/重置，还没经过本人之手）在改密前只能碰
  // `RESTRICTED_SESSION_ALLOWLIST`。落点：紧跟 #234 CSRF 门之后、**分派到任何 handler 之前**（与 #234
  // 同一层 ⇒ 拒绝一定发生在副作用之前）。不改 #234 的逻辑，也不与它复用豁免表（两张清单理由不同：
  // CSRF 豁免看「有没有 CSRF 语义」，本清单看「改密前必需不需要」）。
  if (await restrictedSessionBlocked(req, ctx, pathname)) {
    // **不写审计**（与 CSRF 门不同，这里是刻意的）：受限会话下 SPA 的每个轮询都会撞门，审计会被客户端重试
    // 刷成噪声；而「欠改密」这个状态本身已由 `user.password_changed` 与管理员代设/重置那条审计钉住。
    return sendJson(res, 403, errorBody(
      'password_change_required',
      '当前口令由管理员代设，请先修改口令后再使用其它功能',
      false,
      { action: 'change_password', endpoint: 'POST /api/me/password' },
    ));
  }

  // 兼容旧路径：仅 307 到新路径，不保留旧的单步发 cookie 行为（portal.md §0.1）。
  // ⚠ 顺序契约：本门**在这一对 307 之前**，所以 `POST /api/login` / `POST /api/logout` 两条旧路径
  // 也要出现在放行清单里（清单条目里写了理由）。
  if (req.method === 'POST' && pathname === '/api/login') {
    res.writeHead(307, { Location: '/api/auth/login' });
    res.end();
    return;
  }
  if (req.method === 'POST' && pathname === '/api/logout') {
    res.writeHead(307, { Location: '/api/auth/logout' });
    res.end();
    return;
  }

  // 容器 → portal 全出站通道（per-container token 鉴权，不经 forwardAuth，portal.md §9）。
  if (pathname.startsWith('/api/internal/')) {
    return handleInternal(req, res, ctx, url);
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    return handleLoginStep1(req, res, ctx);
  }

  if (req.method === 'POST' && pathname === '/api/auth/login/totp') {
    return handleLoginTotp(req, res, ctx);
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const token = getCookie(req, config.cookie.name);
    if (!token) throw new HttpError(401, 'unauthorized', 'unauthorized');
    await auth.revokeSession(pool, token);
    res.writeHead(204, { 'Set-Cookie': clearCookieHeader(config.cookie) });
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    // #255：改走 `requireSession`（与其余端点同一个会话解析 + 同一份请求内缓存）。
    // 两条 401（无 cookie / 会话失效）与旧写法逐字同义，响应体不变。
    const session = await requireSession(req, ctx);
    const token = getCookie(req, config.cookie.name);
    const renewed = await auth.renewSession(pool, session.session.id, {
      ttlSeconds: config.sessionTtlSeconds,
      renewIntervalMs: config.sessionRenewIntervalSeconds * 1000,
    });
    const headers = {};
    if (renewed) headers['Set-Cookie'] = sessionCookieHeader(config.cookie, token);
    return sendJson(res, 200, { user: session.user }, headers);
  }
  // ---- #255 自助改密（首登强制改密的唯一出口，portal.md §2.6a）----
  if (pathname === '/api/me/password') {
    if (req.method === 'POST') return handleChangeMyPassword(req, res, ctx);
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }
  if (pathname === '/api/me/git-credential') {
    const session = await requireSession(req, ctx);
    const fdeName = session.user.fde_name;
    if (!fdeName) {
      throw new admin.AdminError('fde_name_required', '当前用户未分配 fde_name，无法管理 Git 凭据', { httpStatus: 400 });
    }
    if (req.method === 'GET') {
      const result = await gitCredential.listGitCredentials({ config: ctx.config, fdeName });
      return sendJson(res, 200, { items: result.hosts });
    }
    if (req.method === 'PUT') {
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const result = await gitCredential.setGitCredential({
        pool: ctx.pool,
        actorId: session.user.id,
        config: ctx.config,
        fdeName,
        host: body?.host,
        username: body?.username,
        token: body?.token,
        protocol: body?.protocol,
      });
      return sendJson(res, 200, result);
    }
    if (req.method === 'DELETE') {
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const result = await gitCredential.deleteGitCredential({
        pool: ctx.pool,
        actorId: session.user.id,
        config: ctx.config,
        fdeName,
        host: body?.host,
      });
      return sendJson(res, 200, result);
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }

  // 边缘授权回调（Traefik forwardAuth）：非浏览器 API，不要求 session cookie。
  if (pathname === '/api/forward-auth') {
    return handleForwardAuth(req, res, ctx);
  }

  // ---- 目录视图（P5 directory-as-project §4：目录下拉 + 目录树，portal 直读 bind mount） ----
  if (pathname === '/api/dirs' && req.method === 'GET') {
    return handleListDirs(req, res, ctx);
  }
  if (pathname === '/api/files/tree' && req.method === 'GET') {
    return handleFileTree(req, res, ctx, url);
  }
  if (pathname === '/api/file' && req.method === 'GET') {
    return handleFilePreview(req, res, ctx, url);
  }
  // 预览短码签发（#366 P2 隔离链③）：签一枚绑 (用户, 文件, mtime, exp) 的 HMAC 能力码，
  // 拼进 /pv/<code>/onlinePreview 当 iframe src。命名对齐同族 kebab-case 端点。
  if (pathname === '/api/preview-tickets' && req.method === 'POST') {
    return handleFilePreviewTicket(req, res, ctx);
  }
  // /pv/<code>/** 预览反代（#366 P2）：浏览器全程只见 portal 源，kk 主机名零暴露。
  const pvMatch = pathname.match(/^\/pv\/([^/]+)(\/.*)?$/);
  if (pvMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    return handlePvProxy(req, res, ctx, decodeURIComponent(pvMatch[1]), pvMatch[2] ?? '/', url.searchParams.toString());
  }
  // issue #359 P0a：目录 git「收工灯」（决策见 AGENTS.md §7 D9）——同一作用域、同一条直读通道。
  if (pathname === '/api/git-light' && req.method === 'GET') {
    return handleGitLight(req, res, ctx, url);
  }

  // ---- 项目与端口（portal.md §3；P5：写路径退役，projects 表留档只读） ----
  if (pathname === '/api/projects') {
    // P5 去项目化：项目注册已退役（目录即项目）。写端点 410 明示退役；GET 保留（归档只读）。
    if (req.method === 'POST') throw new HttpError(410, 'project_api_retired', '项目注册已退役（P5 目录即项目）：目录经 POST /api/sessions 的 project_id（cwd）自动创建');
    if (req.method === 'GET') return handleListProjects(req, res, ctx);
  }
  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    const projectId = decodeURIComponent(projectMatch[1]);
    if (req.method === 'GET') return handleGetProject(req, res, ctx, projectId);
    if (req.method === 'PATCH' || req.method === 'DELETE') {
      throw new HttpError(410, 'project_api_retired', '项目 CRUD 已退役（P5 目录即项目，projects 表留档只读）');
    }
  }
  // F10：端口列表（portal.md §4.7）。P5：port_allocations 去项目化后项目维度端口不可推导，退役。
  const projectPortsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/ports$/);
  if (projectPortsMatch) {
    throw new HttpError(410, 'project_api_retired', '项目维度端口列表已退役（P5）：端口一律见 FDE 级 ~/.erix/ports.json');
  }
  // issue #246 交付②：FDE 本人的预览端口列表（portal.md §4.7a）。GET /api/projects/:id/ports 退役后
  // 「没有任何列端口的 API」⇒ 签票端点要的 allocation UUID 人看不见。本端点就是那条路（单 B 面板用它）。
  if (pathname === '/api/me/ports' && req.method === 'GET') {
    return handleListMyPorts(req, res, ctx);
  }
  // #247 一键放行整组：一次请求签 N 张预览票（portal.md §4.7a）。命名取 kebab-case，
  // 与同族的 `/api/me/ports`、`/api/ports/:id/preview-ticket`、`/api/admin/fdes/:fdeName/ports/block` 一致。
  if (pathname === '/api/me/ports/batch-tickets' && req.method === 'POST') {
    return handleBatchPreviewTickets(req, res, ctx);
  }
  // 预览 ticket 签发（portal.md §2.8）。
  const portTicketMatch = pathname.match(/^\/api\/ports\/([^/]+)\/preview-ticket$/);
  if (portTicketMatch) {
    const portId = decodeURIComponent(portTicketMatch[1]);
    if (req.method === 'POST') return handlePreviewTicket(req, res, ctx, portId);
  }

  // ---- 会话与对话（portal.md §4/§5）----
  if (pathname === '/api/sessions') {
    if (req.method === 'POST') return handleCreateSession(req, res, ctx);
    if (req.method === 'GET') return handleListSessions(req, res, ctx);
  }
  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const sessionId = decodeUuid(sessionMatch[1]);
    if (req.method === 'GET') return handleGetSession(req, res, ctx, sessionId);
    if (req.method === 'PATCH') return handlePatchSession(req, res, ctx, sessionId);
    if (req.method === 'DELETE') return handleArchiveSession(req, res, ctx, sessionId);
  }
  if (req.method === 'POST' && /^\/api\/sessions\/([^/]+)\/ai-title$/.test(pathname)) {
    // issue #114：「AI 改名」——用户主动触发的一次性 LLM 调用（属主鉴权同 PATCH）。
    return handleAiTitle(req, res, ctx, decodeUuid(pathname.match(/^\/api\/sessions\/([^/]+)\/ai-title$/)[1]));
  }
  // ---- #370：对话输入队列（portal.md §4.3a/§4.3b）。须在 /messages 之前注册（两条路径不同，
  // 显式排序只为表达「队列入口」与「直发入口」是两条通路，且队列入口的 409 语义更多）。
  const queuedInputsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/queued-inputs$/);
  if (queuedInputsMatch) {
    const sessionId = decodeUuid(queuedInputsMatch[1]);
    if (req.method === 'POST') return handlePostQueuedInput(req, res, ctx, sessionId);
    if (req.method === 'DELETE') return handleRecallQueuedInputs(req, res, ctx, sessionId);
  }
  if (req.method === 'POST' && /^\/api\/sessions\/([^/]+)\/messages$/.test(pathname)) {
    return handlePostMessage(req, res, ctx, decodeUuid(pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)[1]));
  }
  // issue #89：run_events 展示类事件历史（前端刷新后重建工具卡片/judge 面板）。须在 SSE
  // 路由之前注册（两者路径不冲突，此处仅显式表达「REST 历史」与「SSE 实时」是两条通路）。
  if (req.method === 'GET' && /^\/api\/sessions\/([^/]+)\/events\/history$/.test(pathname)) {
    return handleSessionEventsHistory(req, res, ctx, decodeUuid(pathname.match(/^\/api\/sessions\/([^/]+)\/events\/history$/)[1]));
  }
  // issue #189：折叠原文只读端点 GET /api/sessions/:id/folded/:round（鉴权/错误映射同 events/history：
  // 非属主/不存在 404 不泄露存在性；payload 缺失 404 folded_payload_not_found 由 SessionError 链路透传）。
  if (req.method === 'GET' && /^\/api\/sessions\/([^/]+)\/folded\/(\d+)$/.test(pathname)) {
    const foldedMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/folded\/(\d+)$/);
    return handleSessionFoldedPayload(req, res, ctx, decodeUuid(foldedMatch[1]), Number(foldedMatch[2]));
  }
  if (req.method === 'GET' && /^\/api\/sessions\/([^/]+)\/events$/.test(pathname)) {
    return handleSessionStream(req, res, ctx, decodeUuid(pathname.match(/^\/api\/sessions\/([^/]+)\/events$/)[1]));
  }
  if (req.method === 'POST' && /^\/api\/sessions\/([^/]+)\/stop$/.test(pathname)) {
    return handleStopSession(req, res, ctx, decodeUuid(pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/)[1]));
  }
  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch) {
    const runId = decodeUuid(runMatch[1]);
    if (req.method === 'GET') return handleGetRun(req, res, ctx, runId);
  }
  // issue #64 R1：run 产物 bundle 取回（admin 或 run 属主；流式返回 tar.gz）。
  const runArtifactMatch = pathname.match(/^\/api\/runs\/([^/]+)\/artifact$/);
  if (runArtifactMatch) {
    const runId = decodeUuid(runArtifactMatch[1]);
    if (req.method === 'GET') return handleGetRunArtifact(req, res, ctx, runId);
  }

  // ---- admin LLM 配置（issue #38 Phase A；requireAdmin 鉴权） ----
  if (pathname.startsWith('/api/admin/')) {
    return handleAdminApi(req, res, ctx, url);
  }

  return sendJson(res, 404, errorBody('not_found', 'not found'));
}

// ---------------------------------------------------------------------------
// admin LLM 配置端点（issue #38 Phase A）
// ---------------------------------------------------------------------------

/** admin 鉴权：session 用户 role 必须为 'admin'，否则 403 forbidden。 */
async function requireAdmin(req, ctx) {
  const session = await requireSession(req, ctx);
  if (session.user.role !== 'admin') throw new HttpError(403, 'forbidden', 'forbidden');
  return session;
}

async function handleAdminApi(req, res, ctx, url) {
  const { pathname } = url;
  const session = await requireAdmin(req, ctx); // 所有 /api/admin/* 端点统一先鉴权

  const adminGitCredentialMatch = pathname.match(/^\/api\/admin\/fdes\/([^/]+)\/git-credential$/);
  if (adminGitCredentialMatch) {
    let fdeName;
    try {
      fdeName = decodeURIComponent(adminGitCredentialMatch[1]);
    } catch {
      throw new HttpError(400, 'validation_failed', 'fde_name 非法', { details: { field: 'fde_name' } });
    }
    if (!projects.validateFdeName(fdeName).ok) {
      throw new HttpError(400, 'validation_failed', 'fde_name 非法', { details: { field: 'fde_name' } });
    }
    if (req.method === 'GET') {
      const result = await gitCredential.listGitCredentials({ config: ctx.config, fdeName });
      return sendJson(res, 200, result);
    }
    if (req.method === 'PUT') {
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const result = await gitCredential.setGitCredential({
        pool: ctx.pool,
        actorId: session.user.id,
        config: ctx.config,
        fdeName,
        host: body?.host,
        username: body?.username,
        token: body?.token,
      });
      return sendJson(res, 200, result);
    }
    if (req.method === 'DELETE') {
      const result = await gitCredential.deleteGitCredential({
        pool: ctx.pool,
        actorId: session.user.id,
        config: ctx.config,
        fdeName,
        host: url.searchParams.get('host'),
      });
      return sendJson(res, 200, result);
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }

  // LiteLLM credential proxy (a supplier maps 1:1 to a credential).
  if (pathname === '/api/admin/llm/providers') {
    if (req.method === 'GET') {
      return sendJson(res, 200, await llm.listProviders(ctx.llmGateway));
    }
    if (req.method === 'POST') {
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const provider = await llm.createProvider(ctx.llmGateway, body);
      return sendJson(res, 201, { provider });
    }
  }
  const adminProviderMatch = pathname.match(/^\/api\/admin\/llm\/providers\/([^/]+)$/);
  if (adminProviderMatch) {
    const providerId = decodeURIComponent(adminProviderMatch[1]);
    if (req.method === 'PATCH') {
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const provider = await llm.updateProvider(ctx.llmGateway, providerId, body);
      return sendJson(res, 200, { provider });
    }
    if (req.method === 'DELETE') {
      await llm.deleteProvider(ctx.llmGateway, providerId);
      res.writeHead(204);
      res.end();
      return;
    }
  }
  const adminProviderModelsMatch = pathname.match(/^\/api\/admin\/llm\/providers\/([^/]+)\/models$/);
  if (adminProviderModelsMatch && req.method === 'POST') {
    requireJson(req);
    const body = await readJsonBody(req, ctx.config.maxBodyBytes);
    const model = await llm.createModel(ctx.llmGateway, {
      ...body,
      provider_id: decodeURIComponent(adminProviderModelsMatch[1]),
    });
    return sendJson(res, 201, { model });
  }

  if (pathname === '/api/admin/llm/models' && req.method === 'GET') {
    return sendJson(res, 200, await llm.listModels(ctx.llmGateway));
  }

  // LiteLLM model proxy. A provider's enabled flag has no meaning; model enabled maps to block/unblock.
  const adminModelMatch = pathname.match(/^\/api\/admin\/llm\/models\/([^/]+)$/);
  if (adminModelMatch) {
    const modelId = decodeURIComponent(adminModelMatch[1]);
    if (req.method === 'PATCH') {
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const model = await llm.updateModel(ctx.llmGateway, modelId, body);
      // #296：改了「调用名」（`call_name` → 数据面 `model_name`）就是真改名 ⇒ 立刻铺一次 #289 的
      // 对账，别让人等「心跳 15s + TTL 60s」。两个硬条件：**只传 ctx.llmGateway 单例**（§8.25
      // 的 TTL 缓存按 client 对象身份分槽，现造 client ⇒ 每个受影响绑定多打一次 /model/info）；
      // **不另写一份并集逻辑**（动作全在 reconcileDataPlaneNameRename 里转 getFdeLlmHeartbeatModels）。
      // 它自己吐错 ⇒ 改名已落定，不会被拖成 500；失败退回心跳自愈。
      if (body && Object.hasOwn(body, 'call_name')) {
        const rename = await llm.reconcileDataPlaneNameRename(ctx.pool, ctx.llmGateway, modelId);
        ctx.log.log('[llm] model rename reconcile', { model_id: modelId, ...rename });
      }
      return sendJson(res, 200, { model });
    }
    if (req.method === 'DELETE') {
      await llm.deleteModel(ctx.llmGateway, modelId);
      res.writeHead(204);
      res.end();
      return;
    }
  }
  const adminModelBlockMatch = pathname.match(/^\/api\/admin\/llm\/models\/([^/]+)\/(block|unblock)$/);
  if (adminModelBlockMatch && req.method === 'POST') {
    const modelId = decodeURIComponent(adminModelBlockMatch[1]);
    if (adminModelBlockMatch[2] === 'block') await ctx.llmGateway.blockModel(modelId);
    else await ctx.llmGateway.unblockModel(modelId);
    return sendJson(res, 200, { model_id: modelId, enabled: adminModelBlockMatch[2] === 'unblock' });
  }

  // admin 用户管理（issue #38 Phase B2 admin UI）
  if (pathname === '/api/admin/users') {
    if (req.method === 'GET') {
      return sendJson(res, 200, await admin.listUsers(ctx.pool));
    }
    if (req.method === 'POST') {
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const llmSelection = await llm.validateFdeLlmSelection(ctx.llmGateway, body?.llm);
      const rawGitHostId = body?.git_host_id;
      if (typeof rawGitHostId !== 'string'
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawGitHostId)) {
        throw new HttpError(400, 'validation_failed', 'git_host_id 必须是有效 UUID', { details: { field: 'git_host_id' } });
      }
      const gitHostId = rawGitHostId.toLowerCase();
      const client = await ctx.pool.connect();
      let created;
      let onboardingStatus;
      try {
        await client.query('BEGIN');
        const hostResult = await client.query(
          `SELECT id, provider, enabled FROM git_hosts WHERE id = $1 FOR SHARE`,
          [gitHostId],
        );
        const gitHost = hostResult.rows[0];
        if (!gitHost) {
          throw new admin.AdminError('validation_failed', 'git_host_id 不存在', { details: { field: 'git_host_id' } });
        }
        if (!gitHost.enabled) {
          throw new admin.AdminError('validation_failed', 'git host 已停用', { details: { field: 'git_host_id' } });
        }
        if (gitHost.provider === 'azure') {
          throw new admin.AdminError('validation_failed', 'azure provider 尚不支持开户', { details: { field: 'git_host_id' } });
        }

        created = await admin.createUser(client, {
          actorId: session.user.id,
          login: body?.login,
          display_name: body?.display_name,
          password: body?.password,
          email: body?.email,
          fde_name: body?.fde_name,
          totp_enabled: body?.totp_enabled === true,
          totpIssuer: ctx.config.totp?.issuer,
          limits: {
            maxLoginLength: ctx.config.maxLoginLength,
            maxPasswordLength: ctx.config.maxPasswordLength,
          },
          // #202：用真实 base 域拼最终预览 hostname 做整体校验（逐标签 ≤63 + 总长 ≤253）。
          baseDomain: ctx.config.baseDomain,
          deferAudit: true,
        });
        const previousTokenRef = created.previousTokenRef;
        const previousGitHostId = created.previousGitHostId;
        delete created.previousTokenRef;
        delete created.previousGitHostId;
        onboardingStatus = await onboarding.enqueueOnboarding(client, {
          fdeId: created.user.id,
          gitHostId,
          llm: llmSelection,
          previousTokenRef: previousGitHostId === gitHostId ? previousTokenRef : null,
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      await admin.writeUserCreatedAudit(ctx.pool, {
        actorId: session.user.id,
        login: created.user.login,
        fde_name: created.user.fde_name,
        reactivated: created.reactivated,
      });
      // 创建与补绑各自只在对应响应下发种子（红线）；列表/其它端点永不回显。
      return sendJson(res, 201, { ...created, onboarding: onboardingStatus });
    }
  }
  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)(?:\/(reset-password|totp-reset|totp-enroll|onboard\/retry|offboarding\/retry))?$/);
  if (adminUserMatch) {
    const userId = decodeAdminUserUuid(adminUserMatch[1]);
    const action = adminUserMatch[2] ?? null;
    if (action === 'onboard/retry' && req.method === 'POST') {
      const offboardingRow = await ctx.pool.query(
        `SELECT 1 FROM fde_offboarding
          WHERE fde_id = $1 AND state IN ('pending', 'running')`,
        [userId],
      );
      if (offboardingRow.rows.length > 0) {
        throw new admin.AdminError('user_offboarding', '用户正在下线或处于保留期，不能重试开户', { httpStatus: 409 });
      }
      const result = await onboarding.retryOnboarding(ctx.pool, userId);
      if (!result) {
        const user = await ctx.pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
        if (!user.rows[0]) throw new admin.AdminError('not_found', '用户不存在', { httpStatus: 404 });
        throw new admin.AdminError('onboarding_not_found', '用户没有开户任务', { httpStatus: 409 });
      }
      if (result.state === 'running') {
        throw new admin.AdminError('onboarding_running', '开户任务正在运行', { httpStatus: 409 });
      }
      return sendJson(res, 200, { onboarding: result });
    }
    if (action === 'offboarding/retry' && req.method === 'POST') {
      const result = await offboarding.retryOffboarding(ctx.pool, userId);
      if (!result) {
        const user = await ctx.pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
        if (!user.rows[0]) throw new admin.AdminError('not_found', '用户不存在', { httpStatus: 404 });
        throw new admin.AdminError('offboarding_not_found', '用户没有下线任务', { httpStatus: 409 });
      }
      if (result.state === 'running') {
        throw new admin.AdminError('offboarding_running', '下线任务正在运行', { httpStatus: 409 });
      }
      return sendJson(res, 200, { offboarding: result });
    }
    if (action === 'reset-password' && req.method === 'POST') {
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const result = await admin.resetUserPassword(ctx.pool, userId, body?.password, {
        actorId: session.user.id,
        limits: { maxPasswordLength: ctx.config.maxPasswordLength },
      });
      return sendJson(res, 200, result);
    }
    if (action === 'totp-reset' && req.method === 'POST') {
      const result = await admin.resetUserTotp(ctx.pool, userId, { actorId: session.user.id });
      return sendJson(res, 200, result);
    }
    if (action === 'totp-enroll' && req.method === 'POST') {
      const result = await admin.enrollUserTotp(ctx.pool, userId, {
        actorId: session.user.id,
        totpIssuer: ctx.config.totp?.issuer,
      });
      return sendJson(res, 200, result);
    }
    if (action === null && req.method === 'PATCH') {
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      return sendJson(res, 200, await admin.updateUser(ctx.pool, userId, body, { actorId: session.user.id }));
    }
    if (action === null && req.method === 'DELETE') {
      const result = await admin.deleteUser(ctx.pool, {
        actorId: session.user.id,
        userId,
        config: ctx.config,
        log: ctx.log,
      });
      if (result.offboarding) return sendJson(res, 202, { offboarding: result.offboarding });
      res.writeHead(204);
      res.end();
      return;
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }

  // Git host 注册表（issue #118）。
  if (pathname === '/api/admin/git-hosts') {
    if (req.method === 'GET') {
      return sendJson(res, 200, await gitHosts.listGitHosts(ctx.pool));
    }
    if (req.method === 'POST') {
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const host = await gitHosts.createGitHost(ctx.pool, body);
      return sendJson(res, 201, { host });
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }
  const adminGitHostMatch = pathname.match(/^\/api\/admin\/git-hosts\/([^/]+)$/);
  if (adminGitHostMatch) {
    const hostId = decodeUuid(adminGitHostMatch[1]);
    if (req.method === 'PATCH') {
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const host = await gitHosts.updateGitHost(ctx.pool, hostId, body);
      return sendJson(res, 200, { host });
    }
    if (req.method === 'DELETE') {
      await gitHosts.deleteGitHost(ctx.pool, hostId);
      res.writeHead(204);
      res.end();
      return;
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }

  // FDE 容器 provision（调查结论：portal serve 进程有 config.dockerHost，client 懒建，端点可实现）
  const adminProvisionMatch = pathname.match(/^\/api\/admin\/fdes\/([^/]+)\/provision$/);
  if (adminProvisionMatch && req.method === 'POST') {
    const fdeName = decodeURIComponent(adminProvisionMatch[1]);
    if (!projects.validateFdeName(fdeName).ok) {
      throw new HttpError(400, 'validation_failed', 'fde_name 非法', { details: { field: 'fde_name' } });
    }
    requireJson(req);
    const body = await readJsonBody(req, ctx.config.maxBodyBytes);
    const gitHostId = body?.git_host_id == null || body.git_host_id === ''
      ? null
      : decodeUuid(String(body.git_host_id));
    let out;
    try {
      out = await onboardFde(ctx.pool, ctx.config, {
        fdeName, gitHostId, docker: ctx.adminDocker(), log: ctx.log,
      });
    } catch (err) {
      // 对账循环仍在后台跑，失败不致命——把原因回给 admin（无敏感信息）。
      throw new HttpError(500, 'provision_failed', String(err?.message ?? err));
    }
    return sendJson(res, 200, {
      fde: fdeName,
      network: out.networkName,
      subnet: out.subnet,
      container: out.containerName,
      status: out.status,
      git_provider: out.gitProvider,
    });
  }

  // per-FDE LLM 配置（虚拟 key 由服务端铸造；响应只回显掩码，不接受上游 api_key）
  const adminFdeLlmMatch = pathname.match(/^\/api\/admin\/fdes\/([^/]+)\/llm$/);
  if (adminFdeLlmMatch) {
    const fdeName = decodeURIComponent(adminFdeLlmMatch[1]);
    if (!projects.validateFdeName(fdeName).ok) {
      throw new HttpError(400, 'validation_failed', 'fde_name 非法', { details: { field: 'fde_name' } });
    }
    if (req.method === 'GET') {
      // 无配置 200 + null；api_key 永不出响应（只掩码）。
      // active_run（口径同 sessions.js ACTIVE_RUN_STATES）：true 时更改 credential/模型会触发 409
      // 守卫（除非 force=true），避免活跃 run 的 key 白名单中途轮换。
      const config = await llm.getFdeLlmEcho(ctx.pool, fdeName);
      let activeRun = false;
      if (config) {
        const u = await ctx.pool.query(`SELECT id FROM users WHERE fde_name = $1 AND status = 'active'`, [fdeName]);
        if (u.rows[0]) activeRun = await admin.fdeHasActiveRun(ctx.pool, u.rows[0].id);
      }
      return sendJson(res, 200, { config, active_run: activeRun });
    }
    if (req.method === 'PUT') {
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const config = await llm.setFdeLlmConfig(ctx.pool, {
        actorId: session.user.id,
        fdeName,
        provider_id: body?.provider_id,
        api_key: body?.api_key,
        main_model_id: body?.main_model_id,
        embedding_model_id: body?.embedding_model_id,
        vision_model_id: body?.vision_model_id,
        force: body?.force === true,
        gateway: ctx.llmGateway,
      });
      return sendJson(res, 200, { config });
    }
  }

  // 预览端口号池**占用总览**（issue #256 交付①，portal.md §4.7a）：只读。
  // 存在的理由：改块原本只能填数字试错（撞 409 preview_port_block_taken 才知道哪段被占），
  // 有了总览就能**先选空闲段**。鉴权走 handleAdminApi 的 requireAdmin（非 admin ⇒ 403，零新错误码）。
  // #366 P0：预览未命中聚合（Office 预览需求数据，previewmiss 模块）。管理员取数：
  // GET /api/admin/preview-misses?days=14 → { days, items: [{kind, ext, hits, last_seen_at}] }。
  if (pathname === '/api/admin/preview-misses' && req.method === 'GET') {
    const days = Number(url.searchParams.get('days') ?? 14);
    return sendJson(res, 200, await previewmiss.summarizePreviewMisses({ pool: ctx.pool, days }));
  }

  if (pathname === '/api/admin/preview-ports/usage') {
    if (req.method === 'GET') return handleAdminPreviewPortsUsage(req, res, ctx, session, url);
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }

  // 预览端口（issue #246 交付②，portal.md §4.7a）：列他人端口 + **改块 = 搬迁**。
  const adminFdePortsMatch = pathname.match(/^\/api\/admin\/fdes\/([^/]+)\/ports$/);
  if (adminFdePortsMatch) {
    const fdeName = decodeAdminFdeName(adminFdePortsMatch[1]);
    if (req.method === 'GET') return handleAdminListFdePorts(req, res, ctx, session, fdeName);
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }
  const adminFdePortsBlockMatch = pathname.match(/^\/api\/admin\/fdes\/([^/]+)\/ports\/block$/);
  if (adminFdePortsBlockMatch) {
    const fdeName = decodeAdminFdeName(adminFdePortsBlockMatch[1]);
    if (req.method === 'POST') return handleAdminMoveFdePortsBlock(req, res, ctx, session, fdeName);
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }

  return sendJson(res, 404, errorBody('not_found', 'not found'));
}

/** 路径参数 :fdeName 的解码 + 语法校验（口径照 admin 面既有端点：非法语法 400 validation_failed）。 */
function decodeAdminFdeName(raw) {
  let fdeName;
  try {
    fdeName = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'validation_failed', 'fde_name 非法', { details: { field: 'fde_name' } });
  }
  if (!projects.validateFdeName(fdeName).ok) {
    throw new HttpError(400, 'validation_failed', 'fde_name 非法', { details: { field: 'fde_name' } });
  }
  return fdeName;
}

/** 按 fde_name 解析用户；不存在 → 404 `not_found`（复用 admin 面现有码，不新造）。 */
async function resolveAdminFde(ctx, fdeName) {
  const fde = await portalloc.resolveFdeByName(ctx.pool, fdeName);
  if (!fde || !fde.id) {
    throw new admin.AdminError('not_found', `FDE「${fdeName}」不存在`, {
      httpStatus: 404, details: { field: 'fde_name' },
    });
  }
  return fde;
}

/**
 * GET /api/admin/preview-ports/usage（issue #256 交付①）：号池占用总览。
 *
 * - **只读**：一条 SELECT 拿全局活行（`state <> 'released'`，与 0019 的部分唯一索引同口径），
 *   不写库、不入队 outbox/revision、不开事务；
 * - `?limit=`（可选）只控制 `free_blocks.items` 的条数（默认 50）；非法 ⇒ 400 `validation_failed`
 *   + `details.field='limit'`（复用既有错误码，不新造）；
 * - 审计**恰好一行** `admin.preview_ports_usage_listed`（读他人资源要留痕，照 `admin.fde_ports_listed`
 *   的先例）；`details` 只放计数，**不放整份响应体**（那是一整张号池快照，会把审计表撑成数据副本）。
 */
async function handleAdminPreviewPortsUsage(req, res, ctx, session, url) {
  const rawLimit = url.searchParams.get('limit');
  let freeLimit = portalloc.PREVIEW_USAGE_FREE_LIMIT_DEFAULT;
  if (rawLimit !== null && rawLimit !== '') {
    const parsed = /^\d+$/.test(rawLimit) ? Number(rawLimit) : null;
    const max = portalloc.PREVIEW_PORT_BLOCK_COUNT;
    if (parsed === null || !Number.isInteger(parsed) || parsed < 1 || parsed > max) {
      throw new HttpError(400, 'validation_failed',
        `limit 必须是 1–${max} 的整数（空闲段条数上限，默认 ${portalloc.PREVIEW_USAGE_FREE_LIMIT_DEFAULT}）`,
        { details: { field: 'limit' } });
    }
    freeLimit = parsed;
  }
  const usage = await portalloc.previewPortPoolUsage(ctx.pool, { freeLimit });
  await admin.recordPreviewPortsUsageListedAudit(ctx.pool, {
    actorId: session.user.id,
    totalBlocks: usage.summary.total_blocks,
    freeCount: usage.summary.free,
    occupiedBlockCount: usage.occupied_blocks.length,
    limit: usage.free_blocks.limit,
  });
  return sendJson(res, 200, usage);
}

/**
 * GET /api/me/ports（#246 交付②）：当前登录用户自己的预览 allocation，只列活行、port ASC。
 * **admin 自己通常没有 FDE**（`fde_name` 为 NULL）⇒ 返回空列表，不是 404（工单第 1 节）。
 */
async function handleListMyPorts(req, res, ctx) {
  const session = await requireSession(req, ctx);
  if (!session.user.fde_name) return sendJson(res, 200, { items: [] });
  const items = await portalloc.listFdePreviewPorts(ctx.pool, { fdeId: session.user.id });
  return sendJson(res, 200, { items });
}

/**
 * GET /api/admin/fdes/:fdeName/ports：管理员列他人端口。
 * 读他人资源**必须显式写一行审计**（不假定框架已自动写——现有 admin GET 并未一致落实，
 * 见 `admin.recordFdePortsListedAudit` 的注）。
 */
async function handleAdminListFdePorts(req, res, ctx, session, fdeName) {
  const fde = await resolveAdminFde(ctx, fdeName);
  const items = await portalloc.listFdePreviewPorts(ctx.pool, { fdeId: fde.id });
  await admin.recordFdePortsListedAudit(ctx.pool, {
    actorId: session.user.id, fdeName, itemCount: items.length,
  });
  return sendJson(res, 200, { items });
}

/**
 * POST /api/admin/fdes/:fdeName/ports/block（#246 交付②）：管理员改块 = **搬迁事务**，不是追加。
 * 校验顺序即判据（块非法 / 名超预算都是 400 且**零 SQL**；块被占是 409 且**零残留**）：
 *   ① `block_start` 整数 + 在池内 + 10 对齐 → 400 `validation_failed`（用现成的 isPreviewPortInPool /
 *      isAlignedPreviewBlockStart；**不**把 `preview_port_block_invalid` 直直透给前端，那是开户路径的码）；
 *   ② FDE 名预览域名预算（portalloc 里走 validateFdeNameForHostname）→ 400 `preview_hostname_invalid`（不降级为 warn）；
 *   ③ 目标块 == 当前块 → 200 `{changed:false}`，零写库零入队零审计；
 *   ④ 目标块有**外来**活行 → 409 `preview_port_block_taken`，**禁止**偷偷换成第一个空闲块。
 * 409 的 `retryable=false`：开户路径同码是 retryable（会自动重算下一段），而改块是管理员显式指定的块，
 * 盲试同一段必败 ⇒ 要先换一个起点（口径见 portal.md §4.7a）。
 */
async function handleAdminMoveFdePortsBlock(req, res, ctx, session, fdeName) {
  requireJson(req);
  const body = await readJsonBody(req, ctx.config.maxBodyBytes);
  const blockStart = body?.block_start;
  if (!Number.isInteger(blockStart) || !isPreviewPortInPool(blockStart) || !isAlignedPreviewBlockStart(blockStart)) {
    throw new HttpError(400, 'validation_failed',
      `block_start 必须是号池 ${PREVIEW_PORT_POOL_START}–${portalloc.PREVIEW_PORT_POOL_END} 内、按 ${PREVIEW_PORT_COUNT} 对齐的整数块起点`
      + `（合法值：${PREVIEW_PORT_POOL_START}、${PREVIEW_PORT_POOL_START + PREVIEW_PORT_COUNT}、…）`,
      { details: { field: 'block_start' } });
  }
  const fde = await resolveAdminFde(ctx, fdeName);
  // 改块前先读一眼当前块——只为审计里的 from_block_start（多一条 SELECT，不值得在搬迁事务里多开一次取数）。
  const before = await portalloc.listFdePreviewPorts(ctx.pool, { fdeId: fde.id });
  const fromBlockStart = before.length > 0
    ? portalloc.alignedPreviewBlockStart(Math.min(...before.map((item) => item.port)))
    : null;
  let moved;
  try {
    moved = await portalloc.moveFdePreviewBlock(ctx.pool, ctx.config, {
      fdeId: fde.id, fdeName: fde.fde_name, blockStart, log: ctx.log,
    });
  } catch (err) {
    if (err?.code === 'preview_port_block_taken') {
      throw new HttpError(409, 'preview_port_block_taken', String(err?.message ?? err));
    }
    if (err?.code === 'preview_hostname_invalid') {
      throw new HttpError(400, 'preview_hostname_invalid', String(err?.message ?? err), { details: { field: 'fde_name' } });
    }
    // 深层又冒上来的时候（入口已前置拦住）：对前端仍是「参数不合法」的 400 validation_failed。
    if (err?.code === 'preview_port_block_invalid') {
      throw new HttpError(400, 'validation_failed', String(err?.message ?? err), { details: { field: 'block_start' } });
    }
    throw err;
  }
  if (moved.changed) {
    await admin.recordFdePortsBlockMovedAudit(ctx.pool, {
      actorId: session.user.id,
      fdeName,
      fromBlockStart,
      toBlockStart: moved.blockStart,
      releasedAllocations: moved.releasedAllocations,
      inserted: moved.inserted,
      revokedGrants: moved.revokedGrants,
    });
  }
  return sendJson(res, 200, {
    changed: moved.changed,
    fde_name: fdeName,
    block_start: moved.blockStart,
    block_end: moved.blockEnd,
    ports: [...moved.ports],
    released_allocations: moved.releasedAllocations,
    revoked_grants: moved.revokedGrants,
    inserted_allocations: moved.inserted,
  });
}

async function handleListSessions(req, res, ctx) {
  const session = await requireSession(req, ctx);
  const url = new URL(req.url, 'http://x');
  const result = await sessions.listSessions(ctx.pool, {
    userId: session.user.id,
    projectId: url.searchParams.get('project_id') || undefined,
    cwd: url.searchParams.get('cwd') || undefined,
    cursor: url.searchParams.get('cursor') || undefined,
    limit: url.searchParams.get('limit') || undefined,
  });
  return sendJson(res, 200, result);
}

/** P5：POST /api/sessions —— project_id 即目录名（cwd 绑定；目录不存在时服务端 mkdir）。 */
async function handleCreateSession(req, res, ctx) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  const body = await readJsonBody(req, ctx.config.maxBodyBytes);
  const created = await sessions.createSession(ctx.pool, {
    userId: session.user.id,
    projectId: body?.cwd ?? body?.project_id, // P5：cwd 为准；project_id 为过渡别名（并行 worker 契约漂移兼容，issue #84）
    title: body?.title,
    model: body?.model,
    config: ctx.config,
  });
  return sendJson(res, 201, { session: created });
}

async function handleGetSession(req, res, ctx, sessionId) {
  const session = await requireSession(req, ctx);
  const url = new URL(req.url, 'http://x');
  const result = await sessions.getSession(ctx.pool, {
    userId: session.user.id, sessionId,
    limit: url.searchParams.get('limit') || undefined,
    messagesCursor: url.searchParams.get('cursor'),
  });
  // #370：未投递输入队列快照（`queued_messages`，pi `get_state.queuedMessages` 的等价物）——
  // 刷新 / 换设备 / 断线重连后队列条唯一的补齐来源（`queue_update` 是 live-only、不落库）。
  // 只读不加锁；取不到就按空队列渲染：它是补齐面，不许把整个会话详情拖成 5xx。
  // 挂在 DTO 出口而不是 sessions.getSession 内部的原因见 sessions.js 那条注释（依赖方向）。
  try {
    result.session.queued_messages = await queuedInputs.snapshotQueuedInputs(ctx.pool, sessionId);
  } catch { result.session.queued_messages = { steering: [], follow_up: [] }; }
  return sendJson(res, 200, result);
}

async function handlePatchSession(req, res, ctx, sessionId) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  const body = await readJsonBody(req, ctx.config.maxBodyBytes);
  const updated = await sessions.updateSession(ctx.pool, { userId: session.user.id, sessionId, title: body?.title });
  // issue #107：手工改名成功同样推一条 `session_updated`（与 session-title.js evaluateAutoTitle 同构，
  // 形状 { ts, type, payload:{ title } }）——多标签页 / SessionPicker 的列表标题实时同步。
  // 不落 run_events：标题是会话元数据而非时间线事件（同 #88 裁决）。推送失败不影响已落库的标题。
  try {
    internal.notifySessionEvents(sessionId, [{
      ts: new Date().toISOString(), type: 'session_updated', payload: { title: updated.title },
    }]);
  } catch { /* 尽力：无订阅者 / 连接已断都不影响 200 响应 */ }
  return sendJson(res, 200, { session: updated });
}

async function handleArchiveSession(req, res, ctx, sessionId) {
  const session = await requireSession(req, ctx);
  await sessions.archiveSession(ctx.pool, { userId: session.user.id, sessionId });
  res.writeHead(204); // §4.2：204 无体
  res.end();
}

/**
 * POST /api/sessions/:id/ai-title（issue #114）：「AI 改名」——按需调一次 LLM 生成标题。
 * 属主鉴权/存在性/active 校验在 sessions.generateAiTitle 内的 fetchSession（口径同 PATCH，404 不泄露存在性）。
 * 失败口径：无可用 provider → 409 llm_not_configured；上游超时/非 2xx/标题不可解析 → 502 llm_upstream_failed。
 * 成功：落库 title_source='manual' + 推 session_updated（多标签页列表标题同步；不落 run_events）。
 */
async function handleAiTitle(req, res, ctx, sessionId) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  await readJsonBody(req, ctx.config.maxBodyBytes); // 无体（空 JSON {}）；仍读掉请求体保持行为一致
  const updated = await sessions.generateAiTitle(ctx.pool, {
    userId: session.user.id,
    sessionId,
    gatewayUrl: ctx.config.llmGatewayAdminUrl ?? ctx.config.llmGatewayUrl,
    log: ctx.log,
    notify: internal.notifySessionEvents,
  });
  return sendJson(res, 200, { session: updated });
}

/**
 * 队列推送依赖包（#370）。`queued-inputs.js` **不得** import `internal.js`（终态出队的接线方
 * 就是 internal.js，反向 import 会成环），故 SSE/唤醒一律从这里注入。
 * `notifyQueueUpdate(sessionId, blocked)`：读一次快照再推——**推送载荷恒为全量快照**（pi
 * `queue_update` 同口径），增量会让断线重连的客户端永远缺一块。
 */
function queuedInputDeps(ctx) {
  return {
    notifyRunEnqueued: ({ runId, userId }) => internal.notifyRunEnqueued(userId, { run_id: runId }),
    notifySteerRequest: (userId, data) => internal.broadcastSteerRequest(userId, data),
    notifyQueueUpdate: async (sessionId, blocked = null, deliveredRunId = null) => {
      const rows = await queuedInputs.snapshotQueuedInputs(ctx.pool, sessionId);
      internal.notifyQueueUpdate(sessionId, rows, blocked, deliveredRunId);
    },
  };
}

/**
 * POST /api/sessions/:id/queued-inputs（portal.md §4.3a，issue #370）：运行中说话。
 * body `{content, attachments?, kind:'steer'|'follow_up'}`；可选 `Idempotency-Key`（§1.4）。
 * **入队还是直发由服务端事务内裁决**（照 pi `agent-session.js:1633`：读完 isStreaming 就分岔）
 * ⇒ 响应有两种形状：`{posted:{message,run}, queued:null}` 或 `{posted:null, queued:{...}}`。
 * 错误码：400 `validation_failed`、409 `queue_full`（本站新增，§1.2 清单）。
 */
async function handlePostQueuedInput(req, res, ctx, sessionId) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  const body = await readJsonBody(req, ctx.config.maxBodyBytes);
  // 校验前置到幂等包装之前（F3 口径，同 handlePostMessage）：非法体 400 且不占幂等占位行。
  // `kind` 缺省 = `steer`（前端主键 Enter 的动作，也是旧客户端不传 kind 时唯一的合理默认）。
  // ⚠ 缺省必须在**算 requestHash 之前**定形：否则「不传 kind」与「传 steer」的同 key 重试会被
  //   判成不同载荷 ⇒ 409 idempotency_key_reuse（同一个坑在 /messages 上踩过）。
  const kind = queuedInputs.validateQueuedKind(body?.kind ?? 'steer');
  const { content, attachments } = sessions.validateMessageBody(body);
  const key = idempotency.normalizeKey(req.headers['idempotency-key']);
  const endpoint = `POST /api/sessions/${sessionId}/queued-inputs`;
  const result = await idempotency.executeWithIdempotency(
    ctx.pool,
    {
      userId: session.user.id, endpoint, key,
      requestHash: idempotency.requestHash({ content, attachments, kind }),
      log: ctx.log,
    },
    async (record) => {
      // ⚠ 台账里存的必须是**响应体**而不是业务结果：回放路径直接吐台账里的 response，
      // 不做映射就会给出裸 DB 行（多 session_id/status/attachments…），首次与回放形状不一致。
      // 包一层让两条路共用同一个 `queuedInputResponse`，形状不可能漂。
      const recordBody = record
        ? (client, statusCode, payload) => record(client, statusCode, queuedInputResponse(payload))
        : undefined;
      const r = await queuedInputs.enqueueQueuedInput(ctx.pool, {
        userId: session.user.id, sessionId,
        kind, content, attachments,
        record: recordBody,
        deps: queuedInputDeps(ctx),
      });
      // ⚠ `executeWithIdempotency` 约定的 fn 返回形状是 `{statusCode, response}`（不是业务结果），
      // 带 key 与不带 key 两条路都按这个形状收（不带 key 时它把 `{replayed:false, ...fresh}` 透传）。
      // 直接返回业务结果是本次测试抓出来的 bug：无 key 时靠对象展开蒙对，带 key 时 `result.posted`
      // 恒 undefined ⇒ 500。
      return { statusCode: 202, response: queuedInputResponse(r) };
    },
  );
  // 回放路径按台账里的首次 status_code / response 原样返回（§1.4），形状与首次共用同一映射函数。
  return sendJson(res, result.statusCode, result.response);
}

/**
 * #370：入队结果 → 响应体（唯一一处映射，首次与幂等回放共用）。
 * 直发那一路与 §4.3 同形（前端复用同一段气泡渲染），入队那一路只回队列条目。
 */
function queuedInputResponse({ posted, queued }) {
  if (posted) return { posted, queued: null };
  return {
    posted: null,
    queued: {
      id: queued.id,
      kind: queued.kind,
      content: queued.content,
      position: Number(queued.position),
      created_at: queued.created_at?.toISOString?.() ?? queued.created_at,
    },
  };
}

/**
 * DELETE /api/sessions/:id/queued-inputs（portal.md §4.3b，= pi `clear_queue`）：整队取回。
 * 返回 `{steering:[...], follow_up:[...]}` 文本数组（steering 在前，pi 同序），前端回填输入框
 * （取回文本在前、已打草稿在后、中间空一行——agegr/pi-web `prependText` 的口径）。
 * 只有整队，**没有单条删除**：pi 明说单条删会和 loop 的 pull 竞态（`clear_queue` 注释）。
 */
async function handleRecallQueuedInputs(req, res, ctx, sessionId) {
  const session = await requireSession(req, ctx);
  const recalled = await queuedInputs.recallQueuedInputs(ctx.pool, {
    userId: session.user.id, sessionId, deps: queuedInputDeps(ctx),
  });
  return sendJson(res, 200, { recalled });
}

/**
 * POST /api/sessions/:id/messages（portal.md §4.3）：发用户消息 + 建 run 入队。
 * 可选 `Idempotency-Key`（§1.4）：同 key 重复提交返回**首次结果**（同 message.id / run.id），
 * 不产生第二条 user 消息/第二个 run，也**不重复副作用**（notify 唤醒只在首次执行路径发生，
 * 因为 replay 路径不会调用 sessions.postMessage）。
 *
 * G2：把幂等层给的 `record` 回调转交 sessions.postMessage，由它在**同一个业务事务内**调
 * `record(client, 202, payload)`——消息/run 与幂等台账同一次 COMMIT，“同 key 至多一次副作用”
 * （记账与业务写入同事务）；占位被接管时 record 抛 409 → 业务事务回滚。
 */
async function handlePostMessage(req, res, ctx, sessionId) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  // 先读体（与其它端点一致：413/400 行为不受密钥校验影响），再校验体与 Idempotency-Key 头
  const body = await readJsonBody(req, ctx.config.maxBodyBytes);
  // F3：请求体校验**前置到幂等包装之前**——非法体 400 且不占幂等占位行；
  // 否则首次非法体占位后，同 key 的合法重试会因 request_hash 不同撞 409 idempotency_key_reuse。
  const { content, attachments } = sessions.validateMessageBody(body);
  const key = idempotency.normalizeKey(req.headers['idempotency-key']); // 非法 → 400 validation_failed
  const endpoint = `POST /api/sessions/${sessionId}/messages`; // 含路径参数：同 key 跨 session 不串号
  const result = await idempotency.executeWithIdempotency(
    ctx.pool,
    { userId: session.user.id, endpoint, key, requestHash: idempotency.requestHash({ content, attachments }), log: ctx.log },
    async (record) => {
      await sessions.assertSessionOwner(ctx.pool, { userId: session.user.id, sessionId });
      // issue #117：建 run 前预检该 FDE 是否已绑定可用 LiteLLM 上游（active binding +
      // 非空 virtual key + main model slot）。
      // 未配置 → 409 llm_not_configured fail-fast：不入队 run（否则 run 永久排队，等一个永远不会
      // 出现的 LLM 出口）。
      // 评审 MEDIUM-1：预检必须放在 fn 内（executeWithIdempotency 之后）——回放优先（findDone 在
      // fn 之前返回首次结果，不被预检截断）；claim 后 fn 抛错走 ⑤ release 路径，「失败不占位」
      // 语义保持（修好绑定后同 key 原样重试可成功建 run）。
      const bound = await ctx.pool.query(
        `SELECT 1
           FROM fde_llm_bindings b
          WHERE b.fde_id = $1 AND b.state = 'active' AND b.gateway = 'litellm'
            AND b.api_key IS NOT NULL AND b.api_key <> '' AND b.main_model_id IS NOT NULL
          LIMIT 1`,
        [session.user.id],
      );
      if (!bound.rows?.length) {
        throw new HttpError(409, 'llm_not_configured', '该 FDE 未配置 LLM 上游，请在管理台配置');
      }
      // issue #261014 切片 B2：绑定里的 `model_info.id` 在网关里已不存在（模型被删/重建 ⇒ id 变）时，
      // 消息仍会入队并在 run 里跑出一个看不懂的错 ⇒ 这里 fail-fast（409 llm_model_not_found）。
      // 位置红线：与 llm_not_configured 同层（幂等 fn 内、**开业务事务与写 transcript 之前**）——
      // 失败时不留用户消息、不入队 run，且走 release 路径不把失败钉进幂等台账（同 MEDIUM-1 口径）。
      // ⚠ 必须传 `ctx.llmGateway` 本身：llm.js 的 `model_info.id → model_name` 映射 TTL 缓存按 client
      //   对象身份分槽（同 §9.5 心跳对账的接线红线）。网关不可达时该函数一律放行（fail-open）。
      await llm.assertBindingModelsResolvable(ctx.pool, session.user.id, { gateway: ctx.llmGateway });
      const posted = await sessions.postMessage(ctx.pool, {
        userId: session.user.id,
        sessionId,
        content,
        attachments,
        record,
        notify: ({ runId, userId }) => internal.notifyRunEnqueued(userId, { run_id: runId }),
        // issue #114：首条消息截断出默认标题时推 session_updated（侧栏标题立即到位；live-only）。
        onSessionTitle: (title) => internal.notifySessionEvents(sessionId, [{
          ts: new Date().toISOString(), type: 'session_updated', payload: { title },
        }]),
      });
      return { statusCode: 202, response: posted };
    },
  );
  // 回放路径按首次 status_code（202）与首次 body 原样返回（§1.4）
  return sendJson(res, result.statusCode, result.response);
}

async function handleStopSession(req, res, ctx, sessionId) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  await readJsonBody(req, ctx.config.maxBodyBytes); // 无体（空 JSON {}）
  const result = await sessions.stopSession(ctx.pool, {
    userId: session.user.id, sessionId,
    // #277-A2：「未开始就被直接终态」那条路 portal 是终态的**唯一产出者**，所以 `run_end` 也由它合成，
    // 并在提交后经 session SSE hub 推给活页面（口径同 finishRun / handleAiTitle 的 `notify` 注入）。
    // `running → cancelling` 分支不推：那条的 run_end 由 worker 的 U2 终态事务产出。
    notify: internal.notifySessionEvents,
  });
  // 即时停止通道：SSE 下行 stop_request 只服务**已领起该 run 且还活着的** worker（#220）。
  // ⚠ 不是「断线兜底」：心跳 `stop_run_ids` 的谓词是 `status='cancelling'` 且 run 在该 worker 上报的
  //   runs 列表里（internal.js heartbeat），而认领 SQL 又排除 `cancelling`、reaper 的候选集也不含它——
  //   ⇒ 容器离线 / worker 已死时，没有任何机制会把 `running → cancelling` 的 run 收敛成终态。
  //   queued 分支已在本片直接终态（sessions.js stopSession，#277-A）；**运行中 run 的停止对账兜底属下一片**。
  try {
    internal.broadcastStopRequest(session.user.id, { run_id: result.run.id, session_id: sessionId });
  } catch { /* 尽力推送：无 worker 在线不影响停止已落库 */ }
  // #370：停止也可能是**终态产出点**——「queued 且未被领走」那条路 portal 直接把 run 写成 finished
  // （sessions.js stopSession，#277-A2）。那条 run 永远不会再有 U2 ⇒ 不在这里出队，它排的队就死了。
  // `running → cancelling` 不在这里投：它的终态出队由 worker 上报后的 finishRun 负责（同 run_end 归属）。
  if (result.run?.status === 'finished' || result.run?.status === 'failed') {
    await internal.drainQueueAfterRun(ctx.pool, result.run.id);
  }
  return sendJson(res, 200, result);
}

/** 浏览器 SSE（portal.md §5）：先注册（缓冲）→ DB 补发（Last-Event-ID / ?last_event_id）→ flush 后转 live；15s 心跳。 */
async function handleSessionStream(req, res, ctx, sessionId) {
  const session = await requireSession(req, ctx);
  const s = await sessions.getSession(ctx.pool, {
    userId: session.user.id, sessionId, limit: 1, includeMessages: false,
  });
  const url = new URL(req.url, 'http://x');
  // 无 Last-Event-ID（首连）不补发历史（§5.2.3）；非法值 400（header/query 同口径）。
  const raw = req.headers['last-event-id'] ?? url.searchParams.get('last_event_id');
  let lastEventId = null;
  if (raw !== undefined && raw !== null && raw !== '') {
    lastEventId = Number(raw);
    if (!Number.isInteger(lastEventId) || lastEventId < 0) {
      throw new HttpError(400, 'validation_failed', 'Last-Event-ID 必须为非负整数');
    }
    if (lastEventId > s.last_seq) {
      throw new HttpError(404, 'not_found', 'last_event_id beyond session');
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write('retry: 3000\n\n');

  // 先注册（此后落库的事件进缓冲，不丢）；再补发；最后 flush 缓冲（跳过已补发 seq）转 live（§5.2）。
  const rec = internal.registerSessionClient(sessionId, res);

  // F4：注册后**立即**安装 cleanup（once 守卫）——补发前的 DB 查询/写帧期间客户端断开，
  // 也必须在第一时间把 rec 从 hub 摘除（否则 rec 永久残留：事件泄漏 + ping 定时器常驻）。
  let pingTimer = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (pingTimer) clearInterval(pingTimer);
    internal.unregisterSessionClient(sessionId, rec);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);

  let replayedSeq = null;
  if (lastEventId != null) {
    const replay = await ctx.pool.query(
      `SELECT seq, ts, run_id, type, payload FROM run_events
        WHERE session_id = $1 AND seq > $2 ORDER BY seq ASC`,
      [sessionId, lastEventId],
    );
    for (const row of replay.rows) {
      // 补发期间缓冲溢出 → hub 已写 resync 并 end()：停止补发（写入被 writeSseEvent 静默跳过）
      if (rec.resync) break;
      if (cleaned) return; // 补发期间连接已断开（cleanup 已摘除 rec）：不再写
      const seq = Number(row.seq);
      const data = JSON.stringify({
        seq, ts: row.ts?.toISOString?.() ?? row.ts,
        session_id: sessionId, run_id: row.run_id, type: row.type, ...row.payload,
      });
      internal.writeSseEvent(res, row.type, data, seq);
      replayedSeq = seq;
    }
  } else {
    internal.writeSseComment(res, 'connected'); // 首连不补发历史
  }
  if (cleaned) return; // 补发期间断开：连接已关，不再 goLive（rec 已摘除）/不再起心跳
  internal.sessionClientGoLive(sessionId, rec, replayedSeq);
  if (rec.resync) return; // 已判定需重同步（res.end 已调用）：跳过 ping 与心跳循环
  internal.writeSseEvent(res, 'ping', { ts: new Date().toISOString() });

  pingTimer = setInterval(() => {
    internal.writeSseComment(res, 'ping');
    internal.writeSseEvent(res, 'ping', { ts: new Date().toISOString() });
  }, 15000);
}

/**
 * issue #89：GET /api/sessions/:id/events/history —— run_events 展示类事件历史（前端刷新后
 * 重建工具卡片/judge 面板用，对齐 pi-web「转录即真相」）。红线：只读重建——白名单外类型
 * （run_end/usage/checkpoint/heartbeat/assistant_delta 等，含全部运行态语义事件）不下发，
 * 不驱动前端运行态状态机；SSE 首连不补发语义（§5.2.3）不变，本端点是独立 REST 通路。
 *
 * 契约：鉴权同 GET /api/sessions/:id（非属主/不存在 404，不泄露存在性）；keyset 分页
 * （§1.3）：默认取最新 limit 条（升序返回），before=<seq> 取更早一批；next_cursor 非 null
 * 表示还有更早批次。大小防护：limit 默认 500/上限 2000；payload 字符串叶值统一截 2000 字符
 * （tool_use.input / tool_call_delta.arguments_delta 可能很大），防超大响应。
 */
const HISTORY_EVENT_TYPES = new Set([
  'tool_use', 'tool_result', 'tool_call_delta', 'judge',
  'round', 'round_start', 'round_end', 'attempt', 'recovering', 'recovered',
  'compaction', 'final_guard', 'forced_final',
  // issue #288（缺陷 B）：portal 在 release-requeue 分支合成的**宿主事件**（attempt 被杀并重排）。
  // 它实时走 session SSE 推给浏览器，**不进白名单则刷新后消失**——与本白名单要修的毛病同构，故列入。
  'attempt_killed',
  // issue #288（缺陷 C）：崩溃恢复时挂起工具**没被重放**（引擎 `orchestrator.js:2605-2614` 发出，
  // `requiresHostDecision:true`）。同一个坑另发一次：runner 经 U3 落进 run_events、SSE 实时推得到，
  // **不进本白名单就「实时看得见、刷新后消失」**（AGENTS §8.8）——它出现的时机正是用户刷新页面来
  // 看「我这条 run 怎么了」的时刻，不可回放比不推更坑。payload 字段口径见 portal.md §5.3。
  'tool_replay_decision_required',
  // erix-agent #182（0.18.0）新增的**诊断类**事件：模型元信息缺失时上抛。SSE 实时路径会原样推
  // 给前端（前端 `useEventStream.ts` 的 `default: return;` 中性忽略），若不进白名单则刷新页面
  // 后历史回放会把它过滤掉——同一事件两种可见性就是口径不一致，故列入可回放集合。
  // ⚠ 上面那句「SSE 实时路径会原样推给前端（前端 `default: return;` 中性忽略）」**前提是错的**：
  // 前端 `EVENT_TYPES` 里从来没有这个类型，EventSource 不订 ⇒ **实时也收不到**（不是“收到但不展示”）。
  // issue #421 已把它接进 `EVENT_TYPES` 并刷一行中性分隔行，同时 runner 侧补了 warn 日志
  // （`runner/lib/engine-notices.js`）——现在实时 / 刷新 / 只读 LOG 三条路都看得见。
  'model_metadata_missing',
  // issue #421：引擎对宿主承诺的 16 类事件（`erix-agent` `src/loop/orchestrator.js:297`）里剩下的
  // 3 类。同一个形状：写入侧不过白名单 ⇒ `run_events` 里始织有行，读侧不进白名单就是「实时没有、
  // 刷新后也没有」（#371-A）。三处集合（前端 `EVENT_TYPES` / 前端 `HISTORY_REPLAY_TYPES` / 本表）
  // 仍独立存亡，只加一边就得到两种可见性不一致（#288），16 类的对账测在 `engineEventSurface.spec.ts`。
  // 只剩 `run_outcome` **显式不进**（与 `run_end` 语义重叠且今天无读者，豁免理由同在下测里写出）。
  'compaction_strategy_fallback', 'persistence_capability_degraded', 'resume_journal_skipped',
  // issue #371-A：`persistence_error`（引擎 erix-agent#461 起的落盘失败告警，带 `fatal`）此前
  // **库里存着、读不出来**：写入侧不过白名单（`internal.js` 直接 INSERT），展示侧不过 ⇒ 刷新后
  // 一条都不提。而这条事件最重要的时刻，正是用户刷新来看「我这轮到底存下没」的那一刻。
  // 前端只把 `fatal === false` 刷成**中性**分隔行（致命那条由 `run_end` 的 `persistence_failed`
  // 红色面负责，不在这里重复报）。与前端 `useEventStream.ts` 的 `EVENT_TYPES` +
  // `HISTORY_REPLAY_TYPES` 是**三处独立存亡的集合**（#288 教训），本单同改。
  'persistence_error',
]);
const HISTORY_EVENT_DEFAULT_LIMIT = 500;
const HISTORY_EVENT_MAX_LIMIT = 2000;
const HISTORY_PAYLOAD_STRING_CAP = 2000;
// issue #300：中止/失败 run 的**只读正文重建**。runner 的 catch 固定 `final_text: ''` ⇒ 该 run 在
// `messages` 里**零助手锚点**，而正文区本来就只从锚点渲染 ⇒ 界面上这次 run 一片空白（实测标本
// run 72e2577d / 会话 1ead0b1a）。`assistant_delta` 逐 chunk 落 run_events（全库 5.4 万条）⇒ 在
// 本**只读**端点里按 seq 聚合回一条合成项 `partial_output`。
// 硬口径：**不落库、不进 SSE、不进前端 EVENT_TYPES/HISTORY_REPLAY_TYPES**（它是响应期合成的，
// 进集合就变成「实时一条 + 历史一条」重复），也**不进** HISTORY_EVENT_TYPES（`assistant_delta` 同理
// 不能进白名单，否则同一段正文来两遍）。
const PARTIAL_OUTPUT_TYPE = 'partial_output';
// 上限沿用本端点既有 `HISTORY_PAYLOAD_STRING_CAP = 2000` 的先例；**差别是刻意的**：合成项不塞
// `…（已截断）` 文本，只给 `truncated` 布尔，截断标记由前端出（前端要能判定，见 StreamPanel）。
const PARTIAL_OUTPUT_TEXT_CAP = 2000;
// issue #236：**终态分隔条**的合成类型。名字**故意不叫 `run_end`**：`run_end` 是实时 SSE 的运行态
// 语义事件，绝不能进历史白名单（#217 / #236 的红线）——它是响应期投影出来的展示项，与
// `partial_output` 同一类存在（不落库、不进 SSE、两个前端集合都不加）。
const RUN_TERMINATION_TYPE = 'run_termination';

// 展示 payload 截断：字符串叶值超cap → 截断 + 标记（JSON 形状保持合法，前端 String() 路径原样可用）。
function truncateHistoryPayload(value, depth = 0) {
  if (typeof value === 'string') {
    return value.length > HISTORY_PAYLOAD_STRING_CAP
      ? value.slice(0, HISTORY_PAYLOAD_STRING_CAP) + '…（已截断）'
      : value;
  }
  if (Array.isArray(value)) {
    if (depth > 4) return value;
    return value.map((v) => truncateHistoryPayload(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (depth > 4) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateHistoryPayload(v, depth + 1);
    return out;
  }
  return value;
}

/**
 * issue #300：窗口行里的 distinct run_id（保序去重）。一个都没有 ⇒ 调用方**直接跳过整段合成**，
 * 一条额外查询都不发（成本红线：正常会话每次刷新都走这条端点，绝大多数会话永远用不上合成）。
 */
function distinctWindowRunIds(rows) {
  const ids = [];
  const seen = new Set();
  for (const row of rows) {
    const runId = row.run_id ?? null;
    if (runId == null || seen.has(runId)) continue;
    seen.add(runId);
    ids.push(runId);
  }
  return ids;
}

/**
 * issue #300 / #236：窗口内 run 的**终态信息**一条查询取齐（**只在窗口里真有 run 时才发**）。
 * - 只返回终态行（`status IN ('finished','failed')`，枚举见 schema.sql:207）；`queued`/`running`/
 *   `cancelling` **不算终态**——「还在跑就标已中止」是新造的误导（#300 判据②，本单沿用）。
 * - 锚点口径 = `messages` 里 `role='assistant'` 的**任意**行，**含 `synthetic = true`**：judge/wrapup
 *   注入的助手行同样是「这次 run 说过话」的证据。**有锚点就绝不能再合成一遍**（重复正文是 #300 头号坑）。
 * - `last_seq` = 该 run 在 `run_events` 里的**最大 seq**（`run_events_run_idx (run_id, seq)` 覆盖，零新索引）。
 *   合成项用它当 `seq`（**不新分配**，也不推进 `chat_sessions.last_seq`）：`run_end` 行本身就在这张表里，
 *   所以这个 seq 恰好就是「该 run 最后一条事件」的位置 ⇒ 终态分隔条天然排在本次 run 的内容之后。
 * - **一条查询同时服务两件事**（#300 的 `partial_output` 候选判定 + #236 的终态投影）⇒ 同一次响应里
 *   对同一批 `run_id` 只有**这一条** runs 查询（成本红线：不许为分隔条再打第二条同类查询）。
 */
async function loadWindowRuns(pool, runIds) {
  const r = await pool.query(
    `SELECT r.id AS run_id,
            r.status AS status,
            r.termination AS termination,
            (SELECT MAX(e.seq) FROM run_events e WHERE e.run_id = r.id) AS last_seq,
            EXISTS (SELECT 1 FROM messages m WHERE m.run_id = r.id AND m.role = 'assistant') AS has_anchor
       FROM runs r
      WHERE r.id = ANY($1) AND r.status IN ('finished', 'failed')`,
    [runIds],
  );
  return r.rows ?? [];
}

/**
 * issue #300 聚合（**只对候选发**，走 `run_events_run_idx (run_id, seq)`，零新索引）：
 * 整 run 的 `assistant_delta` 按 `seq` 升序拼接（`ORDER BY` 在 SQL 里 ⇒ 与插入顺序无关，测试钉这点）。
 * 脏载荷：`payload` 缺失/不是对象、`text` 缺键或不是字符串 ⇒ **跳过该片段**，绝不 `String()` 进来
 * （项目惯例：脏数据不得渲染成 `[object Object]` / `undefined`）。
 * 返回 Map<runId, 合成项>；聚合后正文为空 ⇒ 不给该项（被停在 `sleep` 上的 run 本来就无正文可给）。
 */
async function aggregatePartialOutputs(pool, candidateRunIds) {
  const out = new Map();
  if (!candidateRunIds?.length) return out;
  const r = await pool.query(
    `SELECT run_id, seq, payload FROM run_events
      WHERE run_id = ANY($1) AND type = 'assistant_delta'
      ORDER BY run_id, seq`,
    [candidateRunIds],
  );
  const groups = new Map();
  for (const row of r.rows ?? []) {
    const runId = row.run_id ?? null;
    if (runId == null) continue;
    const g = groups.get(runId) ?? { parts: [], chunks: 0, seq: null };
    const text = row.payload?.text; // 可选字段：非字符串就是「没给正文」，不是「正文是 [object Object]」
    if (typeof text === 'string') {
      g.parts.push(text);
      g.chunks += 1;
    }
    const seq = Number(row.seq);
    g.seq = Number.isFinite(seq) ? seq : g.seq; // `seq` 语义 = 该 run 最后一条 delta 的 seq（不是新分配）
    groups.set(runId, g);
  }
  for (const [runId, g] of groups) {
    if (g.seq == null) continue;
    const joined = g.parts.join('');
    if (joined === '') continue; // 空文本不合成
    const truncated = joined.length > PARTIAL_OUTPUT_TEXT_CAP;
    out.set(runId, {
      seq: g.seq,
      run_id: runId,
      type: PARTIAL_OUTPUT_TYPE,
      payload: {
        text: truncated ? joined.slice(0, PARTIAL_OUTPUT_TEXT_CAP) : joined,
        chunks: g.chunks, // 可观测性：让人能核对「聚合了多少片」
        truncated,
      },
    });
  }
  return out;
}

/** 合成项参与升序排序，但**不占 limit、不参与 next_cursor/hasOlder**（那两个仍只由真实事件决定）。 */
function mergeSynthItemsBySeq(realEvents, synthItems) {
  if (!synthItems.length) return realEvents;
  const parts = synthItems.slice().sort((a, b) => a.seq - b.seq);
  const merged = [];
  let i = 0;
  let j = 0;
  while (i < realEvents.length && j < parts.length) {
    // 同 seq 时真实事件在前（seq 在会话内唯一，理论不撞；撞了也不让合成项插到真实事件前面）
    if (realEvents[i].seq <= parts[j].seq) merged.push(realEvents[i++]);
    else merged.push(parts[j++]);
  }
  while (i < realEvents.length) merged.push(realEvents[i++]);
  while (j < parts.length) merged.push(parts[j++]);
  return merged;
}

/**
 * issue #189：GET /api/sessions/:id/folded/:round —— 折叠原文只读端点。
 * 鉴权同 GET /api/sessions/:id（属主校验在 sessions.getFoldedPayload 内的 fetchSession，
 * 404 不泄露存在性）；SessionError（含 404 folded_payload_not_found）由顶层统一错误映射转发。
 */
async function handleSessionFoldedPayload(req, res, ctx, sessionId, round) {
  const session = await requireSession(req, ctx);
  const result = await sessions.getFoldedPayload(ctx.pool, { userId: session.user.id, sessionId, round });
  return sendJson(res, 200, result);
}

async function handleSessionEventsHistory(req, res, ctx, sessionId) {
  const session = await requireSession(req, ctx);
  const own = await ctx.pool.query(
    `SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2 AND status = 'active'`,
    [sessionId, session.user.id],
  );
  if (!own.rows?.length) throw new HttpError(404, 'not_found', 'session not found');
  const url = new URL(req.url, 'http://x');
  let limit = Number(url.searchParams.get('limit') ?? HISTORY_EVENT_DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new HttpError(400, 'validation_failed', 'limit 必须为正整数', { details: { field: 'limit' } });
  }
  limit = Math.min(limit, HISTORY_EVENT_MAX_LIMIT);
  const beforeRaw = url.searchParams.get('before');
  let before = null;
  if (beforeRaw != null && beforeRaw !== '') {
    before = Number(beforeRaw);
    if (!Number.isInteger(before) || before < 1) {
      throw new HttpError(400, 'validation_failed', 'before 必须为正整数', { details: { field: 'before' } });
    }
  }
  const params = [sessionId, [...HISTORY_EVENT_TYPES]];
  let where = 'session_id = $1 AND type = ANY($2)';
  if (before != null) { params.push(before); where += ` AND seq < $${params.length}`; }
  params.push(limit + 1); // 多取 1 条判 hasOlder（§1.3 keyset 口径，对齐 getSession）
  const r = await ctx.pool.query(
    `SELECT seq, run_id, type, payload FROM run_events WHERE ${where} ORDER BY seq DESC LIMIT $${params.length}`,
    params,
  );
  const hasOlder = r.rows.length > limit;
  const rows = r.rows.slice(0, limit).reverse(); // 升序返回（展示回放按 seq 归并穿插）
  const events = rows.map((row) => ({
    seq: Number(row.seq),
    run_id: row.run_id ?? null,
    type: row.type,
    payload: truncateHistoryPayload(row.payload ?? {}),
  }));
  // issue #300 / #236：零候选 ⇒ 零额外查询（无 run ⇒ 连终态查询都不发）。
  // `next_cursor` / `hasOlder` 在上面已由**真实事件**算完，合成项不参与。
  const synth = await buildHistorySynthItems(ctx.pool, rows);
  return sendJson(res, 200, {
    events: mergeSynthItemsBySeq(events, synth),
    next_cursor: hasOlder && rows.length > 0 ? Number(rows[0].seq) : null,
  });
}

/**
 * issue #236：**终态分隔条**的响应期合成项（从 `runs` 的终态字段投影，**不是**把 `run_end` 塞进白名单）。
 *
 * 缺陷（issue #236 §1 第 2 条）：`run_end` 不在历史下发白名单（`HISTORY_EVENT_TYPES`，红线），
 * 所以终态分隔条只在**实时 SSE** 里出现过一次，刷新 / 重开会话后完全消失（#217 只补了「打开会话时
 * 对活跃 run 对账」，不覆盖终态回放）。修法**不碰白名单**：在只读端点里从 `runs.status` +
 * `runs.termination` 投影出一条合成项（`type = 'run_termination'`，**不落库、不进 SSE、不进
 * `HISTORY_EVENT_TYPES`，也不进前端 `EVENT_TYPES` / `HISTORY_REPLAY_TYPES`**——它只在本次响应里存在，
 * 与 #300 的 `partial_output` 同一种存在方式）。
 *
 * 判据（缺一不合成，**一条 run 至多一条**）：
 *   ① 该 run 出现在本次响应窗口里（`distinctWindowRunIds`）；
 *   ② `runs.status IN ('finished','failed')`（`queued`/`running`/`cancelling` 一律不合成）；
 *   ③ `termination.reason` 是**非空字符串**（缺 termination / 脏载荷 ⇒ 不合成：不拿 status 编一个 reason）。
 *
 * `seq` = 该 run 在 `run_events` 里的**最大 seq**（不新分配）：`run_end` 行本来就在表里 ⇒ 分隔条天然落在
 * 本次 run 内容之后，且分页窗口外的行也拿得到（`MAX(seq)` 不受 `before` 限制）。
 */
async function buildHistorySynthItems(pool, windowRows) {
  const runIds = distinctWindowRunIds(windowRows);
  if (runIds.length === 0) return []; // 成本红线：窗口无 run ⇒ 整段跳过，一条查询都不许多发
  // 一条 runs 查询同时服务 partial_output 的候选判定与 run_termination 的终态投影（不许打第二条）。
  const runRows = await loadWindowRuns(pool, runIds);
  const partialCandidates = runRows
    .filter((row) => row.has_anchor !== true)
    .map((row) => row.run_id ?? row.id)
    .filter((id) => id != null);
  const partials = await aggregatePartialOutputs(pool, partialCandidates);
  return [...partials.values(), ...buildRunTerminationItems(runRows)];
}

/**
 * issue #236：`runs` 终态行 → 合成项（一条 run 至多一条）。`payload.termination` 原样透传（前端
 * 的分级 / 标签 / `errorCode` 都从它取），只过一遍字符串截断（`detail` 等可能很长）。
 */
function buildRunTerminationItems(runRows) {
  const out = [];
  for (const row of runRows ?? []) {
    const runId = row.run_id ?? row.id ?? null;
    if (runId == null) continue;
    const termination = row.termination !== null && typeof row.termination === 'object' ? row.termination : null;
    const reason = typeof termination?.reason === 'string' ? termination.reason : '';
    if (reason === '') continue; // 判据③：没有 reason 就没什么可说的（绝不拿 status 编一个）
    const seq = Number(row.last_seq);
    if (!Number.isFinite(seq)) continue; // 无任何事件行 ⇒ 无处安放（窗口行里来的 run 理论上不会）
    out.push({
      seq,
      run_id: runId,
      type: RUN_TERMINATION_TYPE,
      payload: {
        status: row.status ?? null,
        termination: truncateHistoryPayload(termination),
      },
    });
  }
  return out;
}

/** GET /api/runs/:id（portal.md §4.6）：run 详情（属主经 session join 校验，不泄露存在性）。 */
async function handleGetRun(req, res, ctx, runId) {
  const session = await requireSession(req, ctx);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId ?? '')) {
    throw new HttpError(404, 'not_found', 'run not found');
  }
  const r = await ctx.pool.query(
    `SELECT r.id, r.session_id, r.status, r.termination, r.usage, r.error, r.cancel_requested_at,
            r.queued_at, r.started_at, r.ended_at
       FROM runs r JOIN chat_sessions s ON s.id = r.session_id
      WHERE r.id = $1 AND s.user_id = $2`,
    [runId, session.user.id],
  );
  const row = r.rows?.[0];
  if (!row) throw new HttpError(404, 'not_found', 'run not found');
  return sendJson(res, 200, {
    run: {
      id: row.id, session_id: row.session_id, status: row.status,
      termination: row.termination ?? null, usage: row.usage ?? null, error: row.error ?? null,
      cancel_requested_at: row.cancel_requested_at?.toISOString?.() ?? null,
      queued_at: row.queued_at?.toISOString?.() ?? null,
      started_at: row.started_at?.toISOString?.() ?? null,
      ended_at: row.ended_at?.toISOString?.() ?? null,
    },
  });
}

/**
 * GET /api/runs/:id/artifact（issue #64 R1）：run 终态产物 bundle 取回。
 * 鉴权：admin 或 run 属主（非属主 404，对齐 handleGetRun 不泄露存在性）；流式返回 tar.gz。
 */
async function handleGetRunArtifact(req, res, ctx, runId) {
  const session = await requireSession(req, ctx);
  const { filePath, row } = await artifacts.getRunArtifact(ctx.pool, {
    sessionUser: session.user,
    runId,
    artifactsRoot: ctx.config.artifactsRoot ?? '/srv/erix/artifacts',
  });
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${runId}.tar.gz"`,
    'X-Artifact-Truncated': row.manifest?.truncated === true ? 'true' : 'false',
  });
  fs.createReadStream(filePath).pipe(res);
}

async function handleLoginStep1(req, res, ctx) {
  const { pool, config } = ctx;
  requireJson(req);
  const body = await readJsonBody(req, config.maxBodyBytes);
  const login = typeof body.login === 'string' ? body.login.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!login || !password) {
    throw new HttpError(400, 'validation_failed', 'login 与 password 均为必填');
  }
  if (login.length > config.maxLoginLength) {
    throw new HttpError(400, 'validation_failed', `login 长度超过上限 ${config.maxLoginLength}`);
  }
  if (password.length > config.maxPasswordLength) {
    throw new HttpError(400, 'validation_failed', `password 长度超过上限 ${config.maxPasswordLength}`);
  }

  const ip = req.socket.remoteAddress || 'unknown';
  const rlKey = `login:${ip}:${login}`;
  const check = ctx.loginLimiter.check(rlKey);
  if (!check.allowed) {
    throw new HttpError(429, 'rate_limited', '尝试过于频繁，请稍后再试', {
      retryable: true,
      headers: { 'Retry-After': String(check.retryAfterSeconds) },
    });
  }

  // 限制并发 KDF：未认证请求不能无界并发触发 scrypt（S3）。
  // 队列满/排队超时快速失败（503 kdf_busy），不让请求无限排队。
  try {
    await ctx.kdfSemaphore.acquire();
  } catch (err) {
    if (err?.code === 'kdf_queue_full' || err?.code === 'kdf_queue_timeout') {
      throw new HttpError(503, 'kdf_busy', '服务繁忙，请稍后重试', {
        retryable: true,
        headers: { 'Retry-After': '1' },
      });
    }
    throw err;
  }
  let result;
  try {
    result = await auth.authenticate(pool, login, password, { log: ctx.log });
  } finally {
    ctx.kdfSemaphore.release();
  }

  if (!result.ok) {
    ctx.loginLimiter.recordFailure(rlKey);
    if (result.reason === 'malformed_hash') {
      ctx.log.warn?.(`[auth] malformed password_hash for login=${JSON.stringify(login)}`);
      await auth.audit(pool, { action: 'auth.login_malformed_hash', target: login, details: { login } }).catch(() => {});
    }
    throw new HttpError(401, 'invalid_credentials', '用户名或口令错误');
  }

  ctx.loginLimiter.reset(rlKey);

  // 未注册 TOTP（totp_secret 为空）→ 跳过第二因素，口令直通建会话。
  // （偏离规格 §7.1「强制 TOTP」：NULL secret 原语义 = 第二步永远失败 = 永久锁死；
  //   现改为「未注册即跳过」，用户决策 2026-09-22，规格同步见 issue）
  if (!(await auth.hasTotpEnrollment(pool, result.user.id))) {
    const session = await auth.createSession(pool, result.user.id, {
      ip,
      userAgent: req.headers['user-agent'] ?? null,
      ttlSeconds: config.sessionTtlSeconds,
    });
    await auditLoginSuccess(pool, result.user, 'password_direct');
    return sendJson(res, 200, {
      status: 'authenticated',
      // #255（纯 additive）：登录时就告诉前端「这枚会话是受限的」，不必等它去碰第一个 403。
      // 两个**发会话**的分支都有（下面是 TOTP 分支）；`totp_required` 中间响应**不带**：
      // 那一步尚未登录、无 cookie，谈不上受限（口径见 portal.md §2.2/§2.3）。
      password_change_required: result.mustChangePassword === true,
      user: result.user,
    }, {
      'Set-Cookie': sessionCookieHeader(config.cookie, session.token),
    });
  }

  const pending = await auth.createPendingToken(pool, result.user.id, {
    ip,
    userAgent: req.headers['user-agent'] ?? null,
    ttlSeconds: config.pendingTokenTtlSeconds,
  });
  return sendJson(res, 200, {
    status: 'totp_required',
    pending_token: pending.token,
    expires_in: config.pendingTokenTtlSeconds,
  });
}

async function handleLoginTotp(req, res, ctx) {
  const { pool, config } = ctx;
  requireJson(req);
  const body = await readJsonBody(req, config.maxBodyBytes);
  const pendingToken = typeof body.pending_token === 'string' ? body.pending_token : '';
  const code = typeof body.code === 'string' ? body.code : '';
  if (!pendingToken || !code) {
    throw new HttpError(400, 'validation_failed', 'pending_token 与 code 均为必填');
  }

  const ip = req.socket.remoteAddress || 'unknown';

  // 非消费读取：TOTP 错误允许用同一 pending_token 重试（错误码不烧 token）；
  // 只有 TOTP 通过才原子消费（单次消费）。先解出用户，再按「账户 + IP」限流。
  const userId = await auth.findPendingUser(pool, pendingToken);
  if (!userId) {
    throw new HttpError(401, 'pending_expired', 'pending_token 过期或已使用，请重新登录');
  }

  // 账户 + IP 失败计数：换新 pending_token 不重置（口令步成功也不清空），防第二因素爆破。
  const accountKey = `totp:${userId}:${ip}`;
  const accountCheck = ctx.totpLimiter.check(accountKey);
  if (!accountCheck.allowed) {
    throw new HttpError(429, 'rate_limited', '尝试过于频繁，请稍后再试', {
      retryable: true,
      headers: { 'Retry-After': String(accountCheck.retryAfterSeconds) },
    });
  }

  // 单 token 尝试上限（保留原有单 token 爆破防护）。
  const tokenKey = `totp-token:${ip}:${pendingToken}`;
  const tokenCheck = ctx.totpTokenLimiter.check(tokenKey);
  if (!tokenCheck.allowed) {
    throw new HttpError(429, 'rate_limited', '尝试过于频繁，请稍后再试', {
      retryable: true,
      headers: { 'Retry-After': String(tokenCheck.retryAfterSeconds) },
    });
  }

  const result = await auth.verifyTotpForUser(pool, userId, code, {
    digits: config.totp.digits,
    period: config.totp.period,
    window: config.totp.window,
    log: ctx.log,
  });
  if (!result.ok) {
    ctx.totpLimiter.recordFailure(accountKey);
    ctx.totpTokenLimiter.recordFailure(tokenKey);
    throw new HttpError(401, 'totp_invalid', 'TOTP 校验失败');
  }

  const consumedUserId = await auth.consumePendingToken(pool, pendingToken);
  if (!consumedUserId) {
    throw new HttpError(401, 'pending_expired', 'pending_token 过期或已使用，请重新登录');
  }

  ctx.totpLimiter.reset(accountKey);
  ctx.totpTokenLimiter.reset(tokenKey);
  const session = await auth.createSession(pool, result.user.id, {
    ip,
    userAgent: req.headers['user-agent'] ?? null,
    ttlSeconds: config.sessionTtlSeconds,
  });
  await auditLoginSuccess(pool, result.user, 'totp');
  const cookieHeader = sessionCookieHeader(config.cookie, session.token);
  // #255：与上一直通分支同口径——第二步才是本分支真正发会话的地方，受限旗标必须在这里带出去
  // （否则注册了 TOTP 的受限账号只能靠「第一个请求返 403」发现自己要改密）。
  return sendJson(res, 200, { password_change_required: result.mustChangePassword === true, user: result.user }, {
    'Set-Cookie': cookieHeader,
  });
}

/**
 * 成功登录审计（`audit_log.action='auth.login_success'`）：两个成功分支各写一条——
 * `password_direct`（未注册 TOTP，口令直通）与 `totp`（第二因素校验通过）。
 * details 只记 login / method / at，**不含口令、TOTP 码、session token 等敏感字段**。
 * best-effort（同 §2.7 forward-auth 审计口径）：审计写失败不阻断已成功的登录。
 */
async function auditLoginSuccess(pool, user, method) {
  await auth
    .audit(pool, {
      actorId: user.id,
      action: 'auth.login_success',
      target: user.login,
      details: { login: user.login, method, at: new Date().toISOString() },
    })
    .catch(() => {});
}

/**
 * 会话解析的**请求内缓存**（#255）。`Symbol` 键挂在 `req` 上：同一请求里受限会话门与
 * `requireSession` 共用**一次** `login_sessions` 查表，不是每请求两次。
 * 缓存安全：`findSessionUser` 是纯读（不续期、不写库），而一个请求只有一个 handler。
 */
const REQ_SESSION = Symbol('station.request.session');

/** 解析当前请求的会话；无 cookie / 会话失效 ⇒ `null`（**不抛错**，401 的语义归 `requireSession`）。 */
async function resolveSession(req, ctx) {
  if (req[REQ_SESSION] !== undefined) return req[REQ_SESSION];
  const token = getCookie(req, ctx.config.cookie.name);
  req[REQ_SESSION] = token ? await auth.findSessionUser(ctx.pool, token) : null;
  return req[REQ_SESSION];
}

/** 要求有效 session（除登录/forward-auth 外所有公开端点）。 */
async function requireSession(req, ctx) {
  const token = getCookie(req, ctx.config.cookie.name);
  if (!token) throw new HttpError(401, 'unauthorized', 'unauthorized');
  const session = await resolveSession(req, ctx);
  if (!session) throw new HttpError(401, 'unauthorized', 'unauthorized');
  return session;
}

/**
 * forwardAuth 回调（portal.md §2.7）。fail-closed：
 *  ① hostname 精确查 port_allocations（查不到 404 = 路由表里没有 = 不可达）；
 *  ② released → 403 allocation_released；
 *  ③ 无凭证 → 403 preview_ticket_required；ticket 无效/过期 → 401；撤销/不匹配/重放 → 403；
 *  ④ 凭证校验通过 → exposure 判定（private：owner/admin）；
 *  ⑤ ticket 通过 → 302 + Set-Cookie（换取预览 cookie）；cookie 通过 → 200 + X-Auth-User。
 * 例外（#241）：CORS 预检（OPTIONS + Access-Control-Request-Method）免凭证过②以后的所有凭证校验
 * （但 ①② 照旧）；deny 响应一律带 ACAO/ACAC/Vary（#241，见 corsDenyHeaders）。
 * 放行（allow/redirect）后执行 allocated→active 幂等升级（预检不参与，#241）：
 *   UPDATE port_allocations SET state='active' WHERE id=$1 AND state='allocated'（fde-platform §8.6）。
 */
async function handleForwardAuth(req, res, ctx) {
  // dev 端口（8090/8443）下浏览器 Host 恒带端口后缀（如 `xxx.fde.localhost:8090`），而
  // port_allocations.hostname 按无端口 hostname 存储（fix-250923-01）：剥端口 + 小写后再做
  // 精确匹配（生产 80/443 无端口后缀，行为不变）。归一化**口径唯一入口** = preview.normalizeHostHeader（#57 收口）。
  const rawHost = req.headers['x-forwarded-host'] || req.headers.host;
  const host = preview.normalizeHostHeader(rawHost);
  const uri = req.headers['x-forwarded-uri'] || req.url;
  const method = req.headers['x-forwarded-method'] || req.method;
  const scheme = req.headers['x-forwarded-proto'] || 'https';
  const cookieValue = getCookie(req, ctx.config.previewCookie?.name ?? '__Host-fde_preview');
  // #241：预检识别与 ACAO 回显依赖的两个头——Traefik forwardAuth 只转发 `authRequestHeaders`
  // 白名单内的头（routes.js 生成），所以 Origin / Access-Control-Request-Method 必须同时在
  // 白名单里，否则这里永远读到空（预检放行与 CORS 回显双双失效）。
  const origin = req.headers.origin ?? null;
  const accessControlRequestMethod = req.headers['access-control-request-method'] ?? null;

  const result = await preview.authorizeForwardAuth(ctx.pool, ctx.config, {
    hostname: host || '',
    // 原始 Host（可能带端口）：302 Location 需要保留非默认端口（fix-250923-01，dev 8090/8443）。
    hostHeader: rawHost || '',
    uri,
    cookieValue,
    method,
    scheme,
    accessControlRequestMethod,
  });

  // 审计：每次判定（无论通过与否）都写（portal.md §2.7）。details 不记 ticket/cookie 明文，也不记 query（F2：剥离所有 query，只记 path）。
  const details = {
    uri: pathOnly(uri),
    method,
    exposure: result.allocation?.exposure ?? null,
    result: result.outcome,
    grant_kind: result.grantKind ?? null,
    subject_id: result.subjectId ?? null,
    issuer_id: result.issuerId ?? null,
    grant_id: result.grantId ?? null,
  };
  await auth.audit(ctx.pool, {
    actorId: result.subjectId ?? null,
    action: 'auth.forward_auth',
    target: host || '',
    details,
  }).catch(() => {});

  if (result.outcome === 'deny') {
    // #241：deny 也带 CORS 头（状态码与错误信封不变）。落点在 portal：实测 Traefik v3.7.13
    // 会把 auth 子响应的头透给客户端，所以无需在边缘再加 cors 中间件（避免与上游应用自带的
    // ACAO 重复，那会让浏览器报「multiple values」而打断本已正常的带凭据请求）。
    return sendJson(res, result.status, errorBody(result.code, result.message), corsDenyHeaders(origin));
  }

  // 放行 → allocated→active 幂等升级（fde-platform §8.6）；不写 route outbox、不重发路由。
  // #241：预检放行**不**参与升级（无主体，升级语义仍是「首次凭证放行」；紧随其后的真身请求照常触发）。
  if (!result.preflight) {
    await ctx.pool
      .query(`UPDATE port_allocations SET state = 'active' WHERE id = $1 AND state = 'allocated'`, [result.allocation.id])
      .catch(() => {});
  }

  if (result.outcome === 'redirect') {
    const headers = {
      'Set-Cookie': previewCookieHeader(ctx.config.previewCookie, result.sessionToken),
      Location: result.location,
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    };
    res.writeHead(302, headers);
    res.end();
    return;
  }

  // allow：200 + X-Auth-User（Traefik authResponseHeaders 透传）；session 续期重发 Set-Cookie。
  const headers = { 'X-Auth-User': result.fdeName || '' };
  if (result.cookieToken) headers['Set-Cookie'] = previewCookieHeader(ctx.config.previewCookie, result.cookieToken);
  sendJson(res, 200, {}, headers);
}

/** 签发一次性预览 ticket（portal.md §2.8）。 */
async function handlePreviewTicket(req, res, ctx, portId) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  await readJsonBody(req, ctx.config.maxBodyBytes); // 无体（空 JSON {}）

  const ip = req.socket.remoteAddress || 'unknown';
  const rlKey = `ticket:${session.user.id}:${ip}`;
  const check = ctx.previewTicketLimiter.check(rlKey);
  if (!check.allowed) {
    throw new HttpError(429, 'rate_limited', '预览 ticket 签发过于频繁，请稍后再试', {
      retryable: true,
      headers: { 'Retry-After': String(check.retryAfterSeconds) },
    });
  }

  const result = await preview.issuePreviewTicket(ctx.pool, ctx.config, {
    allocationId: portId,
    session,
    ip,
    ua: req.headers['user-agent'] ?? null,
  });
  if (result.error) {
    const { status, code } = result.error;
    throw new HttpError(status, code, code === 'not_found' ? 'not found' : code);
  }

  // 记录本次成功签发（作为限流计数），防单用户短时刷 ticket。
  ctx.previewTicketLimiter.recordFailure(rlKey);
  return sendJson(res, 201, result);
}

/**
 * `POST /api/me/ports/batch-tickets`（issue #247 一键放行整组；portal.md §4.7a）。
 *
 * 语义：给**当前用户自己**的 FDE 一次请求签 N 张预览票（#247 的真痛点：票是 host 级，
 * 前后端分离应用要点两次「打开预览」）。请求体 `{ allocation_ids?: string[] }`；
 * 不给 ⇒ 该 FDE **全部活行**（`state <> 'released'`，含 `scope='project'` 遗留行），按 `port ASC`。
 *
 * 三条实现纪律（评审口径）：
 *  ① **复用** `preview.issuePreviewTicket`（幂等/哈希/过期/审计口径只有一份；本文件不复制签发逻辑，
 *     `preview.js` 的 `issuePreviewTicket` 本体一字未改）；
 *  ② **上限 = `PREVIEW_PORT_COUNT`**（与号池块大小同源，不写死数字）；超出 ⇒ `400 validation_failed`
 *     + `details.field='allocation_ids'`（**零新错误码**）；
 *  ③ 越界（别人的 / 不存在的 / 已 released 的 allocation）⇒ 复用 `404 not_found`（与单据端点同码，
 *     **不泄露「存在但不属于你」**——三种情况回同一个响应）。
 *
 * **为什么不开一个大事务**：每张票是一次独立 INSERT，读者（forwardAuth）逐张独立消费，把 10 次独立
 * 写包进一个事务并不能让它们对读者更原子，只会白占一条连接。取而代之的是「**先全量校验、再逐张签发**
 * + 失败补偿」：预检（形状/归属/活行/上限）在任何签发之前完成，所以越界/超限这类可预期的失败
 * **零写入**；只有签发途中的意外（并发下 allocation 被释放、DB 抖动）才可能留下已签的票，此时用一条
 * `UPDATE preview_grants SET state='revoked'` 把本批已签的票全部收回再抛错 ⇒ 对外**要么全成、要么报错**
 * （不返回半截 `items`），且已签的票不会在库里留下可用的残票。
 *
 * 审计：**逐张各写一行**（`auth.preview_ticket_issued`），形状照 §2.8 B3 的既有口径——
 * `details` 只记 `grant_kind`/`allocation_id`/`port`/`token_hash_prefix`/`expires_at`，
 * **绝不入 ticket 明文，也绝不入 `url`**（`url` 里就带着 `?preview_ticket=`；见 `pathOnly` 那条纪律）。
 * ⚠ 单据端点 `POST /api/ports/:id/preview-ticket` 目前**零审计**（源码实证），所以「照抄单据端点的
 * action」无处可抄；本端点按 §2.8 文档口径补上逐行审计，单据端点保持原样（不在本单范围内改它）。
 */
async function handleBatchPreviewTickets(req, res, ctx) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  const body = await readJsonBody(req, ctx.config.maxBodyBytes);
  const rawIds = body?.allocation_ids;

  // ① 形状校验（零 SQL）：可选字段；给了就必须是非空、无重复、合法的 UUID 字符串数组，且不超过上限。
  //    `details.field` 恒为 `allocation_ids`（前端按 field 定位输入，不解析文案）。
  const invalid = (message) => new HttpError(400, 'validation_failed', message, { details: { field: 'allocation_ids' } });
  let requestedIds = null;
  if (rawIds !== undefined && rawIds !== null) {
    if (!Array.isArray(rawIds)) throw invalid('allocation_ids 必须是字符串数组');
    if (rawIds.length === 0) throw invalid('allocation_ids 不能为空数组（不传该字段表示「本 FDE 全部活行」）');
    if (rawIds.length > PREVIEW_PORT_COUNT) {
      throw invalid(`一次最多签发 ${PREVIEW_PORT_COUNT} 张预览票（收到 ${rawIds.length} 个 allocation_ids）`);
    }
    requestedIds = rawIds.map((raw) => {
      if (typeof raw !== 'string' || !UUID_RE.test(raw.toLowerCase())) throw invalid('allocation_ids 的每一项都必须是 allocation UUID');
      return raw.toLowerCase();
    });
    if (new Set(requestedIds).size !== requestedIds.length) throw invalid('allocation_ids 不允许重复（同一行签两张票只会浪费一张）');
  }

  // ② 解析目标行（一次 SELECT，**零签发**）：显式 id 走归属校验；不给则取本 FDE 全部活行（port ASC）。
  //    归属判据 = `fde_id === 本人`：admin 代签他人是单据端点的能力，批量端点只服务「一键放行我自己的整组」。
  let targets;
  if (requestedIds) {
    const r = await ctx.pool.query(
      `SELECT id, fde_id, state, port, hostname FROM port_allocations WHERE id = ANY($1::uuid[])`,
      [requestedIds],
    );
    const byId = new Map((r.rows ?? []).map((row) => [String(row.id).toLowerCase(), row]));
    const rejected = requestedIds.some((id) => {
      const row = byId.get(id);
      return !row || row.fde_id !== session.user.id || row.state === 'released';
    });
    if (rejected) {
      // 不区分「不存在 / 已释放 / 别人的」：三种都回同一句（否则就成了存在性探针）。
      throw new HttpError(404, 'not_found', 'not found');
    }
    targets = requestedIds.map((id) => byId.get(id));
  } else {
    targets = await portalloc.listFdePreviewPorts(ctx.pool, { fdeId: session.user.id });
    if (targets.length > PREVIEW_PORT_COUNT) {
      // 平台不变式是一块 = `PREVIEW_PORT_COUNT` 行；活行超上限（历史遗留）只能显式分批签。
      throw invalid(`本 FDE 的活行有 ${targets.length} 条，超过一次上限 ${PREVIEW_PORT_COUNT}：请显式传 allocation_ids 分批签`);
    }
  }
  // 没有可签的行（admin 无 FDE / 尚未分段）：201 + 空列表（与 GET /api/me/ports 的「空列表不是 404」同口径），
  // 零签发、零审计、零限流计数。
  if (targets.length === 0) return sendJson(res, 201, { items: [] });

  // ③ 限流：先查一次，再**逐张各记一次**（一次点击 = N 张票，放大倍数必须计入配额，否则批量端点
  //    会把 20/60s 的限额放大 10 倍）。
  const ip = req.socket.remoteAddress || 'unknown';
  const rlKey = `ticket:${session.user.id}:${ip}`;
  const check = ctx.previewTicketLimiter.check(rlKey);
  if (!check.allowed) {
    throw new HttpError(429, 'rate_limited', '预览 ticket 签发过于频繁，请稍后再试', {
      retryable: true,
      headers: { 'Retry-After': String(check.retryAfterSeconds) },
    });
  }

  // ④ 逐张签发（同一 `now` ⇒ 整批同一个 expires_at，响应里不用为每张票各算一次 TTL）。
  const now = new Date();
  const ua = req.headers['user-agent'] ?? null;
  const issued = [];
  try {
    for (const target of targets) {
      const result = await preview.issuePreviewTicket(ctx.pool, ctx.config, {
        allocationId: target.id, session, ip, ua, now,
      });
      if (result.error) {
        const { status, code } = result.error;
        throw new HttpError(status, code, code === 'not_found' ? 'not found' : code);
      }
      ctx.previewTicketLimiter.recordFailure(rlKey);
      issued.push({ target, result });
    }
  } catch (err) {
    // 失败补偿：本批已签的票一律收回（`state='active'` 才动；`revoked ⇔ revoked_at` 靠 COALESCE 满足）。
    // 目的：不把「半截可用的票」留在库里——它们 60 秒内仍可换预览 cookie，等于悄悄放行了半个面板。
    if (issued.length > 0) {
      const hashes = issued.map(({ result }) => auth.hashToken(result.ticket));
      await ctx.pool.query(
        `UPDATE preview_grants SET state = 'revoked', revoked_at = COALESCE(revoked_at, now())
          WHERE token_hash = ANY($1::text[]) AND kind = 'ticket' AND state = 'active'`,
        [hashes],
      ).catch(() => {});
    }
    throw err;
  }

  // ⑤ 审计逐张各一行（不写 url —— 它带票）。
  const expiresAt = new Date(now.getTime() + ctx.config.previewTicketTtlSeconds * 1000).toISOString();
  for (const { target, result } of issued) {
    await auth.audit(ctx.pool, {
      actorId: session.user.id,
      action: 'auth.preview_ticket_issued',
      target: target.hostname ?? '',
      details: {
        grant_kind: 'ticket',
        allocation_id: target.id,
        port: Number(target.port),
        token_hash_prefix: auth.hashToken(result.ticket).slice(0, 12),
        expires_at: expiresAt,
      },
    }).catch(() => {});
  }

  return sendJson(res, 201, {
    items: issued.map(({ target, result }) => ({
      id: target.id,
      port: Number(target.port),
      url: result.url,
      ticket: result.ticket,
      expires_at: expiresAt,
    })),
  });
}

/**
 * `POST /api/me/password`（#255 首登强制改密，portal.md §2.6a）：体 `{current_password, new_password}`，
 * 可选第三个键 `confirm_password`（客户端一致性校验，见下）。
 *
 * 鉴权：`requireSession` —— 没有有效会话就是既有语义的 `401 unauthorized`（不新造码）。
 * 本端点**同时是受限会话门的放行项**（`RESTRICTED_SESSION_ALLOWLIST`）：旗标为 true 时它是唯一出口，
 * 把它挡掉 = 死锁。
 *
 * 三层既有防线照用，不因为「已登录」就跳过：
 *  - #234 CSRF 门（POST，见 §2.11）—— 在 routeApi 顶部，本 handler 之前；
 *  - KDF 并发闸 `ctx.kdfSemaphore`：一次请求跑两次 scrypt（验旧口令 + 铸新哈希），
 *    已认证 ≠ 可无限重放，队列满/超时同样 `503 kdf_busy`（与登录同一口径，S3）；
 *  - 复用登录限流器，key 前缀 `password:`（与 `login:` 命名空间不互相污染）：
 *    防「会话 cookie 被偷后拿当前口令爆破」——`invalid_credentials` 计数，成功即清零。
 *
 * 错误映射交给 `createServer` 的统一信封（`AdminError` → status/code/details）：
 * 当前口令不对 `401 invalid_credentials`（与登录同码，理由见 `admin.changeOwnPassword` 注释），
 * 新口令不合规或与当前相同 `400 validation_failed` + `details.field='new_password'`，
 * `confirm_password` 带了但与 `new_password` 不同 `400 validation_failed` + `details.field='confirm_password'`。
 *
 * `confirm_password`（#255 收尾）：前端表单会多发这一格做一致性校验，而服务端历史上**忽略未知键**
 * ⇒「两次新口令是否一致」只在前端判，绕过前端的调用可以把两个不同的新口令发上去照样成功。这里把它
 * **透传**给 `admin.changeOwnPassword`（校验规则落在那里，与 `new_password` 同一组，不另起一套）：
 * **可选**字段，没带就与旧行为完全一致（向后兼容，已有绕过前端的调用方），带了就必须等于 `new_password`。
 * 注意它**不走** `validatePassword` 的形状校验：只要 `=== new_password` 就必然合法（`new_password`
 * 已经过形状校验），再校一遍长度/非空就是「同一个约束两套判据」。
 */
async function handleChangeMyPassword(req, res, ctx) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  const body = await readJsonBody(req, ctx.config.maxBodyBytes);
  const limits = { maxPasswordLength: ctx.config.maxPasswordLength };
  const currentPassword = body?.current_password;
  const newPassword = body?.new_password;
  // 形状校验放在限流/验哈希之前：畸形请求不该消耗 scrypt 配额。
  admin.validatePassword(currentPassword, limits, { field: 'current_password' });
  admin.validatePassword(newPassword, limits, { field: 'new_password' });
  // `confirm_password` 故意不在这里比：它是「新口令那一组」的语义校验，要落在旧口令校验**之后**
  // （不能让一个还没通过旧口令校验的人因为这条新规则看到新响应），理由见 `admin.changeOwnPassword`。
  const confirmPassword = body?.confirm_password;

  const ip = req.socket.remoteAddress || 'unknown';
  const rlKey = `password:${session.user.id}:${ip}`;
  const check = ctx.loginLimiter.check(rlKey);
  if (!check.allowed) {
    throw new HttpError(429, 'rate_limited', '尝试过于频繁，请稍后再试', {
      retryable: true,
      headers: { 'Retry-After': String(check.retryAfterSeconds) },
    });
  }

  try {
    await ctx.kdfSemaphore.acquire();
  } catch (err) {
    if (err?.code === 'kdf_queue_full' || err?.code === 'kdf_queue_timeout') {
      throw new HttpError(503, 'kdf_busy', '服务繁忙，请稍后重试', {
        retryable: true,
        headers: { 'Retry-After': '1' },
      });
    }
    throw err;
  }
  let result;
  try {
    result = await admin.changeOwnPassword(ctx.pool, session.user.id, currentPassword, newPassword, {
      currentSessionId: session.session.id,
      confirmPassword,
      limits,
      log: ctx.log,
    });
  } catch (err) {
    if (err?.code === 'invalid_credentials') ctx.loginLimiter.recordFailure(rlKey);
    throw err;
  } finally {
    ctx.kdfSemaphore.release();
  }
  ctx.loginLimiter.reset(rlKey);
  return sendJson(res, 200, result);
}

async function handleListDirs(req, res, ctx) {
  const session = await requireSession(req, ctx);
  return sendJson(res, 200, await dirs.listDirs(ctx.pool, {
    userId: session.user.id,
    userSpaceRoot: ctx.config.userSpaceRoot,
    fdeName: session.user.fde_name,
    log: ctx.log,
  }));
}

/** 目录树懒展开（单层只读）：?cwd=<相对cwd>&path=<相对路径>（path 默认 '.'）。 */
async function handleFileTree(req, res, ctx, url) {
  const session = await requireSession(req, ctx);
  const result = await dirs.fileTree({
    userSpaceRoot: ctx.config.userSpaceRoot,
    fdeName: session.user.fde_name,
    cwd: url.searchParams.get('cwd'),
    relPath: url.searchParams.get('path') ?? '.',
  });
  return sendJson(res, 200, result);
}

/**
 * 单文件只读预览（P6 issue #84）：?cwd=<相对cwd>&path=<相对路径>；牢笼校验见 dirs.readFilePreview。
 * #366 P0 加 mode 三形态：缺省/`json`=旧契约逐字节不变；`stream`=原字节内联（Range/MIME 白名单，
 * PDF/音视频当场可看）；`download`=附件下载（415/413 死路页的出口）。JSON 通道的 415/413 同时
 * 被埋点计数（previewmiss，fire-and-forget，不改响应语义）。
 */
async function handleFilePreview(req, res, ctx, url) {
  const session = await requireSession(req, ctx);
  const mode = url.searchParams.get('mode') ?? '';
  if (mode === 'stream' || mode === 'download') {
    const opened = await dirs.openFileStream({
      userSpaceRoot: ctx.config.userSpaceRoot,
      fdeName: session.user.fde_name,
      cwd: url.searchParams.get('cwd'),
      relPath: url.searchParams.get('path') ?? '',
      range: req.headers.range ?? null,
      disposition: mode === 'download' ? 'download' : 'inline',
    });
    res.writeHead(opened.status, opened.headers);
    if (opened.stream) {
      opened.stream.on('error', () => res.destroy());
      opened.stream.pipe(res);
    } else {
      res.end(); // 416：只有头没有体
    }
    return undefined;
  }
  if (mode !== '' && mode !== 'json') {
    throw new HttpError(400, 'validation_failed', 'mode 只支持 json|stream|download', { details: { field: 'mode' } });
  }
  try {
    const result = await dirs.readFilePreview({
      userSpaceRoot: ctx.config.userSpaceRoot,
      fdeName: session.user.fde_name,
      cwd: url.searchParams.get('cwd'),
      relPath: url.searchParams.get('path') ?? '',
    });
    return sendJson(res, 200, result);
  } catch (err) {
    // 埋点（#366 P0）：Office/大文件的「死掉的点击」变需求数据。不 await：埋点绝不能改变
    // 响应的时间或语义；模块内部已吞写失败，.catch 只堆不冒泡。
    const kind = previewmiss.missKindFor(err);
    if (kind) {
      previewmiss
        .recordPreviewMiss({
          pool: ctx.pool,
          userId: session.user.id,
          kind,
          relPath: url.searchParams.get('path') ?? '',
          log: ctx.log,
        })
        .catch(() => {});
    }
    throw err;
  }
}

/**
 * 本站公开 origin（给 kk X-Base-Url 拼产物链接用）：头口径与 forwardAuth 同源（XFH 优先，
 * Traefik 权威覆写）；scheme 真机永远 https（edge TLS 终结 + XFP），直连/dev 按 cookie
 * profile 判（dev-http = 本地纯 http）。写死 https 会在 dev 里生成混合内容链接。
 */
function publicOriginOf(req, ctx) {
  const rawHost = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  // dev-http（cookie 非 secure）直连无 Traefik 头时才是 http；真机 edge TLS 终结必发 XFP。
  const proto = req.headers['x-forwarded-proto'] ?? (ctx.config.cookie.secure ? 'https' : 'http');
  return `${proto}://${rawHost}`;
}

/**
 * POST /api/preview-tickets（#366 P2）：{cwd, path} → { url, expires_in }。
 * 牢笼解析复用 dirs.resolveJailedFile（与预览同一红线）；mtime 进载荷做 cache-buster：
 * 文件被 agent 改写 → 旧码 403 → 前端重签 → kk 重转（陈旧性由机制自解决，不靠清缓存）。
 */
async function handleFilePreviewTicket(req, res, ctx) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  const body = await readJsonBody(req, ctx.config.maxBodyBytes);
  const jailed = dirs.resolveJailedFile({
    userSpaceRoot: ctx.config.userSpaceRoot,
    fdeName: session.user.fde_name,
    cwd: body?.cwd,
    relPath: body?.path,
  });
  const code = previewproxy.issuePreviewCode({
    secret: ctx.config.previewSessionSigningKey,
    userId: session.user.id,
    fdeName: session.user.fde_name,
    project: jailed.project,
    relPath: jailed.rel,
    mtimeMs: jailed.st.mtimeMs,
  });
  return sendJson(res, 200, {
    url: `/pv/${encodeURIComponent(code)}/onlinePreview`,
    expires_in: previewproxy.PREVIEW_CODE_TTL_SECONDS,
  });
}

/**
 * /pv/<code>/** 预览反代（#366 P2 定稿，previewproxy 模块注释是架构真相）：
 * 每请求过 会话（隔离链②）+ 能力码归属/时效（③）+ 路径白名单，再把载荷重写成 kk 的
 * 本地文件参数（路径泄露归零）；HTML 响应改写补前缀，子资源继续走同一闸门。
 */
async function handlePvProxy(req, res, ctx, code, subPath, query) {
  const session = await requireSession(req, ctx);
  const payload = previewproxy.verifyPreviewCode(ctx.config.previewSessionSigningKey, code);
  // 码验不过统一 404（不告诉探探器「有这枚码但过期了」这种存在性信息）。
  if (!payload) throw new HttpError(404, 'not_found', 'not found');
  // 路径白名单先于归属/时效：非路由就是 404，不把码的状态（有效/过期/他人）泄露给探测者。
  const kkPath = previewproxy.pvForwardPath(subPath);
  if (!kkPath) throw new HttpError(404, 'not_found', 'not found');
  if (payload.u !== session.user.id) throw new HttpError(403, 'forbidden', 'forbidden');
  const nowSec = Math.floor(Date.now() / 1000);
  if (!(Number(payload.e) > nowSec)) throw new HttpError(403, 'preview_code_expired', 'preview code expired', { retryable: true });
  // onlinePreview 的 url 参数由载荷重写为 file:// URL（客户端碰不到真实路径，SSRF 根）；
  // 其余子请求透传原 query。file URL 的根 = portal 自己的 userSpaceRoot（compose 保证 kk
  // 容器同路径 ro 挂载，两边看到同一盘 —— 用 portal 的值而非写死，测试/异路径部署都对）。
  const kkBase = ctx.config.kkInternalBaseUrl ?? previewproxy.KK_INTERNAL_BASE_URL;
  const upstreamUrl = kkPath === '/onlinePreview'
    ? `${kkBase}/onlinePreview?${previewproxy.kkOnlinePreviewQuery(payload, ctx.config.userSpaceRoot)}`
    : `${kkBase}${kkPath}${query ? `?${query}` : ''}`;
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      // 公开 origin：Traefik 权威覆写的 XFH/XFP（直连时回退 Host/scheme），给 kk 的 X-Base-Url
      // 拼闸门内绝对链接用（previewproxy 注释是口径真相）。
      headers: previewproxy.pvForwardHeaders(req, code, publicOriginOf(req, ctx)),
      redirect: 'manual',
    });
  } catch {
    throw new HttpError(502, 'preview_backend_unavailable', 'kkfileview unreachable', { retryable: true });
  }
  const headers = previewproxy.pvSanitizedHeaders(upstream);
  let outBody = Buffer.from(await upstream.arrayBuffer());
  const isHtml = String(upstream.headers.get('content-type') ?? '').includes('text/html');
  if (isHtml && upstream.status === 200 && req.method === 'GET') {
    const rewritten = previewproxy.rewriteKkHtml(outBody.toString('utf8'), code);
    if (rewritten !== null) outBody = Buffer.from(rewritten, 'utf8');
  }
  if (req.method === 'HEAD') {
    const cl = upstream.headers.get('content-length');
    if (cl !== null) headers['content-length'] = cl;
    res.writeHead(upstream.status, headers);
    res.end();
    return undefined;
  }
  headers['content-length'] = String(outBody.length);
  res.writeHead(upstream.status, headers);
  res.end(outBody);
  return undefined;
}

/**
 * issue #359 P0a：`GET /api/git-light?cwd=~/projects/<name>` → 一颗「收工灯」的完整判定。
 * 只读零写；作用域 = 当前会话用户的工位（不会扫全平台）；实现与口径见 `portal/src/gitlight.js`。
 * 错误沿用 `dirs.DirError` 同一条映射（cwd 非法 ⇒ 400，目录不存在 ⇒ 404）。
 */
async function handleGitLight(req, res, ctx, url) {
  const session = await requireSession(req, ctx);
  if (!session.user.fde_name) {
    throw new dirs.DirError('fde_name_required', '当前用户未分配工位', { httpStatus: 400 });
  }
  const result = await getGitLight({
    userSpaceRoot: ctx.config.userSpaceRoot,
    fdeName: session.user.fde_name,
    cwd: url.searchParams.get('cwd'),
  });
  return sendJson(res, 200, result);
}

async function handleListProjects(req, res, ctx) {
  const session = await requireSession(req, ctx);
  const url = new URL(req.url, 'http://localhost');
  const cursor = url.searchParams.get('cursor') || undefined;
  const limit = Number(url.searchParams.get('limit') || 20);
  const result = await projects.listProjects(ctx.pool, { userId: session.user.id, cursor, limit });
  return sendJson(res, 200, result);
}

async function handleGetProject(req, res, ctx, projectId) {
  const session = await requireSession(req, ctx);
  const result = await projects.getProject(ctx.pool, { userId: session.user.id, projectId });
  return sendJson(res, 200, result);
}

// P5：handleCreateProject / handlePatchProject / handleDeleteProject / handleGetProjectPorts 已随
// 项目注册制一并退役（写端点与项目维度端口端点在 routeApi 直接 410 project_api_retired）。

// ---------------------------------------------------------------------------
// internal 端点（portal.md §9）：容器 → portal 全出站通道。Bearer token 鉴权 + X-Claim-Token 租约凭证。
// ---------------------------------------------------------------------------

const INTERNAL_EVENTS_LIMIT = 320 * 1024; // 事件批 256KB 载荷 + 信封冗余
const INTERNAL_ROUND_LIMIT = 1.5 * 1024 * 1024; // transcript round 1MB + 信封冗余
const INTERNAL_CHECKPOINT_LIMIT = 2 * 1024 * 1024; // checkpoint snapshot 可较大

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : '';
}

function claimTokenHeader(req) {
  return (req.headers['x-claim-token'] || '').trim();
}

async function handleInternal(req, res, ctx, url) {
  const { pathname } = url;
  const identity = await internal.authenticateContainer(ctx.pool, bearerToken(req));
  const { container, user } = identity;

  // SSE 下行通道（§9.12）
  if (pathname === '/api/internal/stream') {
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    return handleInternalStream(req, res, ctx, identity);
  }

  // U1 claim（长轮询，§9.3）
  if (pathname === '/api/internal/claim') {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    requireJson(req);
    const body = await readJsonBody(req, ctx.config.maxBodyBytes);
    const capacity = body.capacity ?? 1;
    const holdMs = body.hold_ms ?? 30000;

    // issue #180：客户端（agentd）在响应写出前断开 → 中断长轮询，不为死连接领 ticket（否则 attempts+1、
    // 占住租约，ticket 写向死连接而丢失，崩溃恢复白等 90s 自然到期）。
    // Node 语义坑：`req` 的 'close' 在请求体读完时也会触发（HTTP/1.1 语义），不能单独用；
    // 以 `res` 的 'close' + `!res.writableEnded` 判定「响应没写完就断了」（正常响应 end() 后 writableEnded=true，
    // 同 socket keep-alive 复用的下一个请求有各自的 res，不会误判）。
    const ac = new AbortController();
    const onClientClose = () => { if (!res.writableEnded) ac.abort(); };
    res.on('close', onClientClose);
    // 防御：断开发生在监听器安装前（'close' 已错过）→ 以 destroyed 补判。
    if (res.destroyed || res.socket?.destroyed) ac.abort();
    try {
      const ticket = await internal.claimRun(ctx.pool, {
        container, user, capacity, holdMs, baseDomain: ctx.config.baseDomain, signal: ac.signal, log: ctx.log,
      });
      if (!ticket) {
        res.writeHead(204);
        res.end();
        return;
      }

      // ② 兜底：claim 已提交（attempts+1、租约占用）但响应写不出去（客户端已断）→ 释放认领并把 attempt 还回去。
      if (ac.signal.aborted) {
        await internal.releaseUndeliveredClaim(ctx.pool, { runId: ticket.run.id, claimToken: ticket.claim_token, log: ctx.log });
        res.writeHead(204);
        res.end();
        return;
      }
      return sendJson(res, 200, ticket);
    } finally {
      res.removeListener('close', onClientClose);
    }
  }

  // U4 heartbeat（§9.5）
  if (pathname === '/api/internal/heartbeat') {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    requireJson(req);
    const body = await readJsonBody(req, ctx.config.maxBodyBytes);
    // issue #289：把 serve 进程的 llmGateway 单例透传给心跳对账；必须传 ctx.llmGateway 本身，
    // 不可在此现造 client——llm.js 的映射 TTL 缓存按 client 对象身份分槽，现造 ⇒ 每次心跳多打一次 GET /model/info。
    const result = await internal.heartbeat(ctx.pool, { container, user, body, llmGateway: ctx.llmGateway, log: ctx.log });
    return sendJson(res, 200, result);
  }

  // U11 approval 结果轮询兜底（§9.10）
  const approvalMatch = pathname.match(/^\/api\/internal\/approvals\/([^/]+)$/);
  if (approvalMatch) {
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    const approvalId = decodeURIComponent(approvalMatch[1]);
    const result = await internal.getApproval(ctx.pool, { container, user, approvalId, claimToken: claimTokenHeader(req) });
    return sendJson(res, 200, result);
  }

  // session-scoped transcript（issue #81 P2，conversation-state.md §4.1；迁移 0006）。
  // key = sessionId（引擎 store key）；writer run 经 ?run_id= query 参数 + X-Claim-Token 头 fencing。
  const sessionTranscriptMatch = pathname.match(/^\/api\/internal\/transcript\/([^/]+)(\/.*)?$/);
  if (sessionTranscriptMatch) {
    const key = decodeURIComponent(sessionTranscriptMatch[1]);
    const sub = sessionTranscriptMatch[2] || '';
    const claimToken = claimTokenHeader(req);
    const writerRunIdParam = url.searchParams.get('run_id');
    const writerRunId = writerRunIdParam ? decodeUuid(writerRunIdParam) : null;
    if (writerRunId === null) {
      throw new HttpError(400, 'validation_failed', 'run_id query 参数必填（writer run，租约 fencing）', { details: { field: 'run_id' } });
    }
    const base = { container, user, key, claimToken, writerRunId };

    if (sub === '') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      const limit = Number(url.searchParams.get('limit') || 10000);
      // issue #338：游标是**不透明串** `<round>:<append_seq>`（真 keyset 断点），必须**原样透传**——
      // 旧代码 `Number(...)` 会把 `"1:1070"` 变成 `NaN` ⇒ 第二页从「从头」重读 ⇒ agentd 的分页循环
      // 永不终止（死循环 + 无限重复行）。形态校验失败 ⇒ 400 `validation_failed`（零新错误码）；
      // **故意不做**「纯数字旧游标」双形态兼容：唯一消费者是 agentd，它只回传 portal 给的串。
      const cursor = url.searchParams.get('cursor');
      if (cursor !== null && !/^[0-9]+:[0-9]+$/.test(cursor)) {
        throw new HttpError(400, 'validation_failed', 'cursor 必须为 `<round>:<append_seq>` 形式的不透明游标', { details: { field: 'cursor' } });
      }
      const result = await internal.getSessionTranscript(ctx.pool, { ...base, limit, cursor });
      return sendJson(res, 200, result);
    }
    const sessionRoundMatch = sub.match(/^\/rounds\/(\d+)$/);
    if (sessionRoundMatch) {
      if (req.method !== 'PUT') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      requireJson(req);
      const body = await readJsonBody(req, INTERNAL_ROUND_LIMIT);
      const result = await internal.putSessionRound(ctx.pool, { ...base, round: Number(sessionRoundMatch[1]), body });
      return sendJson(res, 200, result);
    }
    if (sub === '/checkpoint') {
      if (req.method !== 'PUT') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      requireJson(req);
      const body = await readJsonBody(req, INTERNAL_CHECKPOINT_LIMIT);
      const result = await internal.putSessionCheckpoint(ctx.pool, { ...base, body });
      return sendJson(res, 200, result);
    }
    if (sub === '/checkpoint/latest') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      const result = await internal.getSessionLatestCheckpoint(ctx.pool, base);
      if (result === null) {
        res.writeHead(204);
        res.end();
        return;
      }
      return sendJson(res, 200, result);
    }
    if (sub === '/runstate/status') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      const result = await internal.loadSessionRunStateStatus(ctx.pool, base);
      if (result === null) {
        res.writeHead(204);
        res.end();
        return;
      }
      return sendJson(res, 200, result);
    }
    if (sub === '/runstate') {
      if (req.method === 'PUT') {
        requireJson(req);
        const body = await readJsonBody(req, INTERNAL_CHECKPOINT_LIMIT);
        const result = await internal.saveSessionRunState(ctx.pool, { ...base, body });
        return sendJson(res, 200, result);
      }
      if (req.method === 'GET') {
        const result = await internal.loadSessionRunState(ctx.pool, base);
        if (result === null) {
          res.writeHead(204);
          res.end();
          return;
        }
        return sendJson(res, 200, result);
      }
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }
    return sendJson(res, 404, errorBody('not_found', 'not found'));
  }

  // runs/:id/*
  const runMatch = pathname.match(/^\/api\/internal\/runs\/([^/]+)(\/.*)?$/);
  if (runMatch) {
    const runId = decodeUuid(runMatch[1]);
    const sub = runMatch[2] || '';
    const claimToken = claimTokenHeader(req);

    if (sub === '/state') {
      if (req.method !== 'PUT') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      // #322 真机取证：`config` 必须下传 —— 自动改名要在 portal 侧调网关，网关地址只有 ctx.config 里那份
      // （`llmGatewayAdminUrl`）在容器里可达；漏传 ⇒ 退回 `127.0.0.1:4100` ⇒ ECONNREFUSED ⇒ 静默降级。
      const result = await internal.setRunState(ctx.pool, { container, user, runId, claimToken, body, config: ctx.config });
      return sendJson(res, 200, result);
    }
    if (sub === '/events') {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      requireJson(req);
      const body = await readJsonBody(req, INTERNAL_EVENTS_LIMIT);
      const result = await internal.postEvents(ctx.pool, { container, user, runId, claimToken, body });
      return sendJson(res, 200, result);
    }
    if (sub === '/release') {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const result = await internal.releaseRun(ctx.pool, { container, user, runId, claimToken, body });
      return sendJson(res, 200, result);
    }
    if (sub === '/checkpoint') {
      if (req.method !== 'PUT') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      requireJson(req);
      const body = await readJsonBody(req, INTERNAL_CHECKPOINT_LIMIT);
      const result = await internal.putCheckpoint(ctx.pool, { container, user, runId, claimToken, body });
      return sendJson(res, 200, result);
    }
    if (sub === '/checkpoint/latest') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      const result = await internal.getLatestCheckpoint(ctx.pool, { container, user, runId, claimToken });
      if (result === null) {
        res.writeHead(204);
        res.end();
        return;
      }
      return sendJson(res, 200, result);
    }
    if (sub === '/runstate/status') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      const result = await internal.loadRunStateStatus(ctx.pool, { container, user, runId, claimToken });
      if (result === null) {
        res.writeHead(204);
        res.end();
        return;
      }
      return sendJson(res, 200, result);
    }
    if (sub === '/runstate') {
      if (req.method === 'PUT') {
        requireJson(req);
        const body = await readJsonBody(req, INTERNAL_CHECKPOINT_LIMIT);
        const result = await internal.saveRunState(ctx.pool, { container, user, runId, claimToken, body });
        return sendJson(res, 200, result);
      }
      if (req.method === 'GET') {
        const result = await internal.loadRunState(ctx.pool, { container, user, runId, claimToken });
        if (result === null) {
          res.writeHead(204);
          res.end();
          return;
        }
        return sendJson(res, 200, result);
      }
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }
    if (sub === '/transcript') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      const limit = Number(url.searchParams.get('limit') || 10000);
      const cursor = url.searchParams.get('cursor') ? Number(url.searchParams.get('cursor')) : null;
      const result = await internal.getTranscript(ctx.pool, { container, user, runId, claimToken, limit, cursor });
      return sendJson(res, 200, result);
    }
    if (sub === '/transcript/recall') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      const fromRound = Number(url.searchParams.get('from_round') ?? 0);
      const toRoundRaw = url.searchParams.get('to_round');
      const toRound = toRoundRaw === null ? null : Number(toRoundRaw);
      const pattern = url.searchParams.get('pattern') ?? '';
      const result = await internal.recallTranscript(ctx.pool, { container, user, runId, claimToken, fromRound, toRound, pattern });
      return sendJson(res, 200, result);
    }
    if (sub === '/artifact') {
      // U13（issue #64 R1）：run 终态产物 bundle 上传。终态后租约已释放 → 仅容器 token + 属主校验。
      if (req.method !== 'PUT') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      const maxBytes = ctx.config.artifactMaxBytes ?? 20 * 1024 * 1024;
      // +1 余量：恰好超限的请求也能给出 413 而非连接截断。
      const data = await readRawBody(req, maxBytes + 1);
      if (data.length > maxBytes) {
        throw new HttpError(413, 'artifact_too_large', 'artifact 超过大小上限', { details: { max_bytes: maxBytes } });
      }
      const shaHeader = req.headers['x-sha-256'];
      const result = await artifacts.putRunArtifact(ctx.pool, {
        user, runId, data,
        sha256: typeof shaHeader === 'string' ? shaHeader.trim() : null,
        artifactsRoot: ctx.config.artifactsRoot ?? '/srv/erix/artifacts',
        maxBytes,
        log: ctx.log,
      });
      return sendJson(res, 200, result);
    }
    if (sub === '/approvals') {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const result = await internal.createApproval(ctx.pool, { container, user, runId, claimToken, body });
      return sendJson(res, result.status, { approval_id: result.approval_id });
    }

    const roundMatch = sub.match(/^\/transcript\/rounds\/(\d+)$/);
    if (roundMatch) {
      if (req.method !== 'PUT') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      requireJson(req);
      const body = await readJsonBody(req, INTERNAL_ROUND_LIMIT);
      const round = Number(roundMatch[1]);
      const result = await internal.putRound(ctx.pool, { container, user, runId, round, claimToken, body });
      return sendJson(res, 200, result);
    }
  }

  return sendJson(res, 404, errorBody('not_found', 'not found'));
}

/** SSE 下行：注册到 hub，15s 保活，断开时注销（§9.12）。 */
function handleInternalStream(req, res, ctx, identity) {
  const { container, user } = identity;
  internal.registerSseClient(container.id, user.id, res);
  res.writeHead(200, internal.sseHeaders());
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  internal.writeSseComment(res, 'connected');
  internal.writeSseEvent(res, 'ping', { ts: new Date().toISOString() });
  const pingTimer = setInterval(() => {
    internal.writeSseComment(res, 'ping');
    internal.writeSseEvent(res, 'ping', { ts: new Date().toISOString() });
  }, 15000);
  const cleanup = () => {
    clearInterval(pingTimer);
    internal.unregisterSseClient(container.id, res);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

async function serveStatic(req, res, ctx, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }
  const staticRoot = path.resolve(ctx.config.staticDir);
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'validation_failed', 'invalid path');
  }
  // issue #61 P2 翻转：/ 服务 Vue SPA——dist 由 Docker 多阶段构建注入 staticDir/app/
  //（vite base '/'，产物引用 /assets/*，故 /assets/ 前缀映射到注入目录；hash 路由承担子路径，
  // 无需 pathname catch-all）。旧 static/index.html 已于 P4 删除。
  if (rel === '/' || rel === '/index.html') rel = '/app/index.html';
  else if (rel.startsWith('/assets/')) rel = `/app${rel}`;
  // 以静态目录为根做规范化，再用 path.relative 校验未逃逸（静态路径穿越防护）。
  const filePath = path.resolve(staticRoot, `.${rel}`);
  const relPath = path.relative(staticRoot, filePath);
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
    return sendJson(res, 403, errorBody('forbidden', 'forbidden'));
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return sendJson(res, 404, errorBody('not_found', 'not found'));
    return sendStaticFile(res, filePath);
  } catch {
    return sendJson(res, 404, errorBody('not_found', 'not found'));
  }
}

/** 发送单个静态文件（serveStatic 专用；不存在走 404）。 */
function sendStaticFile(res, filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return sendJson(res, 404, errorBody('not_found', 'not found'));
    const contentType = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    return sendJson(res, 404, errorBody('not_found', 'not found'));
  }
}
