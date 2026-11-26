// HTTP 服务：零框架 node:http 路由分发。
// 端点：GET /healthz、GET /api/health、POST /api/auth/login（口令→pending_token）、
//       POST /api/auth/login/totp（TOTP→session cookie）、POST /api/auth/logout、GET /api/me + 静态页面。
// 旧路径 /api/login、/api/logout 仅 307 到新路径（不保留旧单步发 cookie 行为）。
// cookie 语义见 docs/api/portal.md §2.5；两步登录见 §2.2/§2.3。

import http from 'node:http';
import net from 'node:net';
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
import { partialOutputs } from './run-partial-buffer.js'; // issue #502 D-5：补发侧读的就是写入侧喂的那份缓冲
import * as artifacts from './artifacts.js';
import * as llm from './llm.js';
import { createLlmGatewayClient, LlmGatewayError } from './llm-gateway.js';
import * as admin from './admin.js';
import * as seatContent from './admin-seat-content.js'; // #727：管理台按 FDE 只读浏览会话/文件
import * as dirs from './dirs.js';
import * as previewmiss from './previewmiss.js';
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
// issue #586：版本三格的唯一读面（`/healthz` / `/api/health` 的 `version` 块与管理台「关于」面板都走它）。
import { aboutPanel, healthVersionBlock } from './version-info.js';
import { maskEmail } from './mailer.js'; // #449：邮件通道端口（登录邮箱验证码）
import { createMailProvider } from './mail-provider.js'; // #449：SMTP 配置的 DB 读取侧（60s 缓存）
import * as mailSettings from './mail-settings.js'; // #449：管理台邮件通道配置（写侧 + 测试发信）
import * as platformPrompts from './platform-prompts.js'; // #596 片 A：管理台「提示词」面板（读 + 写）
import * as uploadSettings from './upload-settings.js'; // #485 片 A：单文件上限进管理台（DB 优先 env，每次上传现读）
import * as runtimeSettings from './runtime-settings.js'; // #677 P2a：会话 TTL 进管理台（DB > env > 默认，热读）
import * as secrets from './secrets.js';   // #608：配置槽值的形态校验（只写不读）
import * as loginEmailCode from './login-email-code.js'; // #449：登录第二因素「邮箱验证码」
import * as apiTokens from './api-tokens.js'; // #736：API 令牌（Bearer 认证缝 + 管理台签发/吊销）
import * as tlsCert from './tls-cert.js'; // #456：管理台证书生命周期（上传/校验/回滚）
import * as delegation from './delegation.js'; // 子 run（delegation）读侧：名册 + 账本两个只读端点
import * as macroRoutes from './macro-routes.js'; // #526：宏平台 HTTP 业务层（if 链只做「匹配+鉴权+转发」，不再撑大本文件）
import { MacroError } from './macros.js'; // #526：宏域错误载体（httpStatus 自带在错误上，一处映射）
import * as market from './market.js'; // #595：能力市场（校验/安装面），本文件只做「匹配+鉴权+转发+审计」
import { metricsApiPayload } from './system-metrics.js'; // #650：管理台系统监控（响应本体在那个模块，本文件只做匹配+递旋钮）
import { resolveRequestLocale } from './locale.js'; // #803 S1：请求语言谈判（错误文案 + 运行时设置 label/hint 共用，纯函数零依赖）
import { normalizeUserLocale, setUserLocale } from './db.js'; // #828 P1：账号级语言偏好的写侧归一化 + 写库

/**
 * **全站 JSON 请求体默认上限（内存护栏 + scrypt 保护）。**
 *
 * 值 64 KiB。它替代了原请求体上限 env 的默认值（那个 env 从未接进
 * `deploy/docker-compose.yml` 的 station-portal environment 列表 ⇒ 生产设了也不生效，是个假旋钮，
 * issue #677 已删）。保留 64 KiB 的理由：① 防超大登录字段触发 scrypt / 打爆内存；
 * ② 有文档依据（`docs/api/portal.md` 登录请求体约束）。46 个调用点共用它，**不许放大**。
 */
const DEFAULT_JSON_BODY_LIMIT = 64 * 1024;

/**
 * **消息端点（`POST /api/sessions/:id/messages` 与 `.../queued-inputs`）的请求体上限。**
 *
 * 值 1 MiB。只给这两个「用户输入正文本身」的端点放宽，约束两条：
 * ① 必须 **>** `MAX_MESSAGE_CONTENT_LENGTH`（`sessions.js` = 100_000 字符）× 3 —— 中文 UTF-8
 *    最坏每字符 3 字节 ≈ 300 KB，否则业务闸在 64 KiB 传输闸下永远不可达（用户看到 413 而非「content 过长」）；
 * ② 必须 **≤** `MAX_ROUND_BYTES`（`transcript-limits.js` 契约常量 1 MiB，单轮 transcript 记录上限，消息会进这个记录）。
 *
 * ⚠ 约束 ② **没有动态联动**：`MAX_ROUND_BYTES` 是纯常量（原先的 env 覆盖已随 issue #677 删除——
 *   假旋钮从未接进 compose；真机要把闸调到几百 KB 复现「宿主拒 → 剥归档重试」，直接改
 *   `transcript-limits.js` 那一行并重跑），而这里写死 1 MiB、不跟着它动。
 *   所以一旦有人把 `MAX_ROUND_BYTES` 降到 1 MiB 以下，`MESSAGE_BODY_LIMIT` 就可能**超过**它、
 *   本文件也不会察觉（此时超限消息会在 `internal.js` 的 round 闸被拒，而非在传输层）。
 *   默认值相等（都 1 MiB）⇒ 约束 ② 恰好卡在上界，**不要**为了「留余量」把它调更小——
 *   再小就顶不住约束 ①（100k 中文 × 3 ≈ 300 KB 要过去），业务闸会重新变不可达。
 */
const MESSAGE_BODY_LIMIT = 1024 * 1024;

// #736：签发/列表/吊销端点当前停用（库里 0 枚、消费者 0，且不过期的管理员钥匙没人敢签 ⇒ #746 已关）。
// 认证缝（Bearer）保留；重新启用 = 把这个常量改成 true。
const TOKEN_ROUTES_ENABLED = false;

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
  // `en` 是 issue #803 的**可选**英文文案：给了就在 `locale === 'en'` 时替代 `message`，不给
  // ⇒ `this.en === undefined`、出口照旧出中文（渐进覆盖）。`super(message)` 仍传中文——
  // `Error.message` 的中文是日志与既有断言的依赖，**不许动**。
  constructor(status, code, message, { retryable = false, details, headers, en } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.headers = headers;
    this.en = en;
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

/**
 * 错误出口按请求 locale 挑一条消息文案（issue #803）。
 * `err.en` 缺失 ⇒ 出中文——这是**渐进覆盖的形状，不是 bug**：只有抛出点显式给了 `en:` 的条目，
 * 才在 `locale === 'en'` 时出英文，其余一律照旧出 `err.message`（中文）。各类 `*Error`
 * （ProjectError/SessionError/DirError/InternalError/LlmError/…）的 `en` 也由这里**通用读取**，
 * S1 不给它们加构造器参数。
 */
function pickMessage(err, locale) {
  if (locale === 'en' && typeof err?.en === 'string' && err.en !== '') return err.en;
  return err.message;
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
 * #736：从 `Authorization` 头取 Bearer 令牌。只认 `Bearer` 这一种 scheme（§2.13 设计点 5）。
 * @returns {{present:boolean, token:string|null, badScheme:boolean}}
 *   present=false 无 `Authorization` 头；badScheme=true 有头但 scheme 非 Bearer（⇒ 401
 *   `unsupported_scheme`）；否则 token = 明文（可能空串，交由下游当未知令牌 ⇒ 401）。
 */
function getBearerToken(req) {
  const header = req.headers.authorization;
  if (header === undefined || header === null || header === '') {
    return { present: false, token: null, badScheme: false };
  }
  const sp = header.indexOf(' ');
  const scheme = sp === -1 ? header : header.slice(0, sp);
  if (scheme !== 'Bearer') return { present: true, token: null, badScheme: true };
  const token = (sp === -1 ? '' : header.slice(sp + 1)).trim();
  return { present: true, token, badScheme: false };
}

/**
 * #740：真客户端 IP——**只在 socket 对端是可信代理时**采信 `X-Forwarded-For` 的**最右一项**。
 *
 * 为什么需要它：部署形态里「ingress 是唯一的路」（不变式 2）且 portal 只 publish `127.0.0.1`
 * ⇒ 每个进来的 socket 对端**按部署形态应当**是 edge（Traefik）那一侧的地址（DNAT 之后具体落哪个段要看拓扑：
 *   判据信的是「私网 / nexthop」这个**位置**，不是「对端身份是 ingress」，见下面「安全性」）。旧写法
 * `req.socket.remoteAddress` 于是把**全平台所有人**记成同一个网关 IP ⇒ 发信限流键 `email:<ip>`、
 * 失败计数、`login_pending.created_ip` 全挤进一个桶 = 等于没限流（工单 #740 的真实危害）。
 *
 * 判据：
 *  ① 只有 socket **对端本身**属于 loopback / RFC1918（`10/8`·`172.16/12`·`192.168/16`）/
 *     ULA `fc00::/7` / `::1` **或本机默认路由的 nexthop** 时才采信头。
 *     后半句是 **#740 追加刀（拓扑校正）**：真实部署里 portal 只 publish `127.0.0.1`，edge（Traefik）
 *     经 `http://127.0.0.1:<发布端口>` 打进来 ⇒ DNAT 之后容器看到的对端是 compose `backend` 网络
 *     （`172.32.0.0/24`）的**网桥网关 `172.32.0.1`**，而 `172.32/16` **不在** RFC1918 内（`172.16/12`
 *     只覆盖 172.16–172.31）⇒ 只认前三类会把真实拓扑的头整批拒掉（证据：库里
 *     `login_pending.created_ip` 110 行**全**是 `172.32.0.1` = 上一刀的判据在真机上是空转的）。
 *     安全性（#740 评审 F3 收准，原话「攻击者**伪造不了** nexthop／只有 ingress 本身能站到那个位置」说强了）：
 *     请求里没有任何字段能直接写出「本容器默认路由的 nexthop」，但**要站到那个位置上，得能占据该链路的
 *     下一跳**——同 L2 里抢下那个地址（`CAP_NET_RAW` / ARP 欺骗）仍可伪；代码信的是「对端落在私网 / nexthop
 *     这个**位置**」，不是「对端的**身份**是 ingress」。
 *     为什么今天暴露面小（261125 现验）：`station_backend` 上只有平台自己的容器（`station-db` `172.32.0.2`、
 *     `station-litellm` `172.32.0.3`、`station-docker-proxy` `172.32.0.4`、`station-portal` 自己 `172.32.0.5`），
 *     FDE 工位容器只挂自己的 `/29`（`fde-eric` = `10.200.0.2/29`），从 `fde-eric` 内直连 portal 的 backend 地址
 *     `172.32.0.5:8080` = NOT-REACHABLE ⇒ 今天被这条判据信任的私网对端 = **平台容器与宿主进程，不是 FDE 代码**。
 *     **换网络拓扑要重评**：FDE 侧能直连 portal、或 ingress 不在同一 L2 ⇒ 上面那句作废。
 *     读不到文件 / 无默认路由 /
 *     Gateway 为 `00000000` ⇒ **回落到原集合**（fail closed，测试 A8）。
 *     有人绕过 edge 直连（对端是公网地址、又不是本机 nexthop）⇒ 头可任意伪造 ⇒ 不信，用 socket 地址。
 *     **刻意不加 env 白名单旋钮**（#677 正在收 env）：可信集合由部署形态直接推导，没有「运维要加
 *     白名单」这个真实配置面，加旋钮只会多一个能配错的开关。
 *     **未覆盖 v6 默认路由**（`/proc/net/ipv6_route` 本轮不解析，届时再补）。
 *  ② 采信时取 XFF 的**最右一项**：标准里每跳代理把自己看到的对端**追加**到头后，最右一项 = 离 portal
 *     最近那跳（edge）写下的真客户端；**最左是客户端自己写的，可伪造**。头缺失 / 全空 / 最右一项解析
 *     不出合法 IP ⇒ 回落 socket 地址（**不向左继续找**，见工单）。
 *  ③ 多层代理时「最右」只剥**一层** edge（当前部署就是单 edge）；将来前面再加一层，要改成取右数第 N 项。
 *  ④ IPv6 带 zone（`%eth0`）先去掉；`::ffff:a.b.c.d` 映射地址还原成 v4 再记（否则同一 v4 客户端会以
 *     两种形态各占一桶）。
 *
 * 这里是 `req.socket.remoteAddress` 在 `portal/src/**` 下**唯一**的合法落点（防回潮闸见 portal/test）。
 *
 * @param {object} req 只读 `req.socket.remoteAddress` 与 `req.headers['x-forwarded-for']`
 * @param {{gatewayAddrs?: string[], procRoutePath?: string}} [opts] **仅供测试注入**：
 *   `gatewayAddrs` 直接给定可信 nexthop 集合；`procRoutePath` 指到夹具文件。
 *   生产 7 个调用点一律 `clientIp(req)`（走默认路径 + 懒算缓存），不传 opts。
 */
export function clientIp(req, { gatewayAddrs, procRoutePath } = {}) {
  const socketIp = normalizeIp(req.socket.remoteAddress);
  if (socketIp && isTrustedProxyAddr(socketIp, gatewayAddrs ?? gatewayAddrsFor(procRoutePath))) {
    const forwarded = rightmostForwardedIp(req.headers && req.headers['x-forwarded-for']);
    if (forwarded) return forwarded;
  }
  return socketIp || 'unknown';
}

/** 取 XFF 头的**最右一项**并解析成合法 IP；解析不出返回 null（调用方回落 socket 地址）。 */
function rightmostForwardedIp(header) {
  const value = Array.isArray(header) ? header[header.length - 1] : header;
  if (typeof value !== 'string') return null;
  const parts = value.split(',');
  return normalizeIp(parts[parts.length - 1]);
}

/** 归一化一个 IP 字面量：去 zone / 剥 `[...]` / 还原 v4-mapped；合法返回小写字符串，否则 null。 */
function normalizeIp(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  const zone = s.indexOf('%'); // fe80::1%eth0 → fe80::1
  if (zone !== -1) s = s.slice(0, zone);
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1); // [::1] 字面量
  s = s.toLowerCase();
  const mapped = /::ffff:((?:\d{1,3}\.){3}\d{1,3})$/.exec(s); // ::ffff:a.b.c.d → a.b.c.d
  if (mapped && net.isIPv4(mapped[1])) return mapped[1];
  return net.isIPv4(s) || net.isIPv6(s) ? s : null;
}

/**
 * #740 追加刀：解析 `/proc/net/route`，取**默认路由（目的 `00000000`）那行的 Gateway** = 本容器
 * 默认路由的 nexthop，并入可信代理集合。
 *
 * 格式（tab 分隔文本）：`Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT`，
 * 地址是**十六进制小端**：`010020AC` 要按字节反序还原成 `172.32.0.1`（即按 `AC 20 00 01` 读）；
 * 照大端直读会得到另一个完全不同的地址（字节序单独钉在测试 A10）。
 * 只取 `Destination == 00000000` 的行；Gateway 为 `00000000`（无下一跳，纯链路路由）或解析不出 ⇒ 跳过。
 * 文件读不到（非 Linux / 进不了 `/proc` / 测试指不存在的路径）⇒ `[]`（**回落原集合**，fail closed）。
 * 未覆盖 v6（`/proc/net/ipv6_route`），本轮不做。
 *
 * @param {{procRoutePath?: string}} [opts] 路径可注入（测试拿夹具文件喂）
 * @returns {string[]} 去重后的 IP 数组（无默认路由 / 读不到 ⇒ `[]`）
 */
export function defaultGatewayAddrs({ procRoutePath = '/proc/net/route' } = {}) {
  let text;
  try {
    text = fs.readFileSync(procRoutePath, 'utf8');
  } catch {
    return []; // 读不到 ⇒ 不扩可信集合（fail closed）
  }
  const addrs = [];
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    // 列不足 8 = 表头/残行；目的非 00000000 = 非默认路由（子网直连路 Gateway 恒 00000000，本来也要排除）
    if (cols.length < 8 || cols[1] !== '00000000') continue;
    const gw = decodeHexLeIpv4(cols[2]);
    if (gw && gw !== '0.0.0.0' && !addrs.includes(gw)) addrs.push(gw);
  }
  return addrs;
}

/** 把 `/proc/net/route` 的十六进制**小端**地址还原成点分 v4（`010020AC` → `172.32.0.1`）；非法返回 null。 */
function decodeHexLeIpv4(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{8}$/.test(hex)) return null;
  const octets = [];
  for (let i = 0; i < 8; i += 2) octets.push(parseInt(hex.slice(i, i + 2), 16));
  octets.reverse(); // 小端 → 网络序
  const ip = octets.join('.');
  return net.isIPv4(ip) ? ip : null;
}

/**
 * 默认路由 nexthop 集合的**懒算缓存**：只在第一次真需要时读 `procRoutePath`，之后直接复用。
 * 按路径缓存（生产只有一个默认路径 ⇒ 一个槽位；测试用不同夹具路径各算一次，不互相污染）。
 */
const gatewayAddrsCache = new Map();
function gatewayAddrsFor(procRoutePath = '/proc/net/route') {
  if (!gatewayAddrsCache.has(procRoutePath)) {
    gatewayAddrsCache.set(procRoutePath, Object.freeze(defaultGatewayAddrs({ procRoutePath })));
  }
  return gatewayAddrsCache.get(procRoutePath);
}

/**
 * socket 对端是否「可信代理地址」：loopback / RFC1918 / ULA `fc00::/7` / `::1`
 * **或** 属于 `gatewayAddrs`（本机默认路由 nexthop；不传则走懒算缓存）。
 */
function isTrustedProxyAddr(ip, gatewayAddrs = gatewayAddrsFor()) {
  if (staticTrustedProxyAddr(ip)) return true;
  return Array.isArray(gatewayAddrs) && gatewayAddrs.includes(ip);
}

/** 与部署无关的静态可信段判定（loopback / RFC1918 / ULA / `::1`）。 */
function staticTrustedProxyAddr(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127) return true; // 127/8 loopback
    if (a === 10) return true; // RFC1918 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
    if (a === 192 && b === 168) return true; // RFC1918 192.168/16
    return false;
  }
  const h = expandIpv6(ip); // IPv6
  if (!h) return false;
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA（首 hextet 高 7 位 = 0b1111110）
  return false;
}

/** 把合法 IPv6 串展开成 8 段数值（支持 `::` 压缩与尾部 v4）；段数不为 8 返回 null。 */
function expandIpv6(addr) {
  let s = addr.toLowerCase();
  const v4tail = /:((?:\d{1,3}\.){3}\d{1,3})$/.exec(s);
  if (v4tail) {
    const oct = v4tail[1].split('.').map(Number);
    const hi = ((oct[0] << 8) | oct[1]).toString(16);
    const lo = ((oct[2] << 8) | oct[3]).toString(16);
    s = s.slice(0, v4tail.index + 1) + hi + ':' + lo;
  }
  const dd = s.indexOf('::');
  let head, tail;
  if (dd !== -1) {
    head = s.slice(0, dd) === '' ? [] : s.slice(0, dd).split(':');
    const t = s.slice(dd + 2);
    tail = t === '' ? [] : t.split(':');
  } else {
    head = s.split(':');
    tail = [];
  }
  const headNums = head.map((x) => parseInt(x, 16));
  const tailNums = tail.map((x) => parseInt(x, 16));
  if (headNums.some(Number.isNaN) || tailNums.some(Number.isNaN)) return null;
  if (dd === -1) return headNums.length === 8 ? headNums : null;
  const missing = 8 - headNums.length - tailNums.length;
  if (missing < 0) return null;
  const out = [...headNums, ...new Array(missing).fill(0), ...tailNums];
  return out.length === 8 ? out : null;
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
 * `<宿主 tailnet IP>`），cookie 本身不区分发起方。这里加一道**不依赖配置项**（同源基线从请求自己的
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
 * **只比 authority、不比 scheme**（契约点）：本部署处在 http（dev `:8090` / `<宿主 tailnet IP>:8090`）与
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
    method: 'POST',
    path: '/api/auth/login/email-code',
    reason: '第二步（邮箱验证码，issue #449）：与 TOTP 第二步同一理由——受限账号重新登录时旧会话 cookie 仍在，'
      + '不列它就会被自己的旧会话形状挡成 403，连改密前的会话都拿不到。',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/auth/login/email-code/resend',
    reason: '邮箱码重发（issue #449）：同属登录第二步的组成部分（没收到信的人必须能重发），'
      + '与上一行同一批理由；它只对**未消费的 pending_token** 生效，不产生会话。',
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
  Object.freeze({
    method: 'GET',
    path: '/api/site',
    reason: '#450 A2 的 host 信息端点（§2.12）：**本身就是公开端点**（无会话也 200、只回两个对外 base URL），'
      + '拿「欠不欠改密」去挡它是不自洽的；而它被挡的后果不是 403 而是**静默降级**——前端路由守卫会把'
      + '「site 不可用」当成 fail-open（不跨 host 跳），于是受限会话在错的 host 上照样渲染出一片 404 的页面。',
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
function previewCookieHeader(cookie, token, maxAgeSeconds = cookie.maxAge) {
  const parts = [`${cookie.name}=${token}`, `Path=${cookie.path}`];
  if (cookie.httpOnly) parts.push('HttpOnly');
  if (cookie.secure) parts.push('Secure');
  // #677 P3 第五批：cookie 属性照旧，但 `Max-Age` 用现读值（`config.previewCookie.maxAge` 是启动
  // 时算死的快照，热改 `preview.session_ttl_seconds` 后必须跟着变，否则会话与 cookie 两套真相）。
  parts.push(`SameSite=${cookie.sameSite}`, `Max-Age=${maxAgeSeconds}`);
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
  // 这一条是 #803 的**机制端到端样桩**（返修 m6）：目前全仓只有这一处给了 `en:`，因此它是唯一
  // 能从 HTTP 面真走通 `err.en` ⇒ `pickMessage` 那条链的抛出点（判据：
  // `portal/test/admin-runtime-settings-api.test.js` 的 Content-Type 腿）。改动本行时**两边的
  // 逐字都有钉**，别只改一边。
  throw new HttpError(400, 'validation_failed', 'Content-Type 必须为 application/json', {
    en: 'Content-Type must be application/json',
  });
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
function readJsonBody(req, limit = DEFAULT_JSON_BODY_LIMIT) {
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

/**
 * issue #515（工单 fix-261115-11）：**「缓冲逐出活跃 run」这条降级必须对外可见**。
 *
 * 为什么挂在这里（而不是新开端点、不是新增鉴权面、不是事件流）：
 *   * `run-partial-buffer` 的 `evictOne()` 在「全表都是活跃 run」时会逐掉一个**仍在流**的 run，
 *     后果 = 该 run 终态时 `partial_text` 写歪或写不出（两种情形见 `docs/api/portal.md` §5.1 的
 *     已接受损失条目）。它本来已经有 `stats().evictedActive` 计数与一条 `log.warn`，但**没有
 *     任何对外读面**（portal 今天没有 `/metrics`，`grep -rn metrics portal/src` = 0 命中）⇒
 *     只能翻日志对账，界面上只表现为「那段没了」。本函数把那半个可观测面补成整只。
 *   * 本仓已定裁决（#515 的三选一）= **「已有 `stats()` 挂到既有 `/healthz`」+「文档显式接受」**。
 *     **不**新增宿主诊断事件（那要动 SSE 白名单 + 前端 + 事件面契约测，另单），**不**新增端点。
 *     ⚠ 也**不**借用 `persistence_capability_degraded` 当信号名：那个类型是**引擎发射**的
 *     （`orchestrator.js`，见 `docs/api/portal.md` §5.3 第 20 类），portal 拿它说自己的事 = 谎报发射方。
 *
 * 形状红线（`portal/test/healthz-partial-buffer.test.js` 逐条钉）：
 *   * **三个整数，没有别的**：`entries`（当前占用的槽数）/ `maxEntries`（槽位上界，缺省 32）/
 *     `evictedActive`（累计逐出活跃 run 的次数）。**不放 run id 列表、不放 sessionId、不放正文片段**
 *     ——健康端点的响应会被人整段贴进工单与日志，放 run id 就是往里塞用户数据（PII）。
 *   * **`status` 字段语义一字未动**（`{ status: 'ok' }` 仍是就绪判据），**503 分支的形状也没动**
 *     （未就绪时返回 `errorBody('migration_failed', …)`，不带本块）：容器健康检查
 *     （`deploy/docker-compose.yml` → `node portal/src/cli.js healthcheck`）只看 `res.ok`，
 *     不解析 body（取证见 `cli.js#healthcheck`），所以加字段对它结构性安全。
 *   * **观测块不得把健康端点打挂**：`stats()` 抛异常 ⇒ 整块缺席，`status: 'ok'` 照旧 200。
 *     一个观测用的附加块不该让 readiness 链（`docs/design/deploy-contract.md` §8）翻成 500。
 *
 * @param {{stats?: () => object}} [buffer] 注入点（默认进程内单例；测试可塞自定义缓冲实例）
 * @returns {{entries:number,maxEntries:number,evictedActive:number}|null} 取不到 ⇒ `null`（调用方省略该键）
 */
export function partialBufferHealth(buffer = partialOutputs) {
  try {
    const s = typeof buffer?.stats === 'function' ? buffer.stats() : null;
    if (!s) return null;
    // `stats()` 的键名是缓冲自己的口径（`size`），到对外契约这一层叫 `entries`：
    // 映射写在这里=只有一处翻译，不把内部键名泄成对外契约的一部分。
    return { entries: s.size, maxEntries: s.maxEntries, evictedActive: s.evictedActive };
  } catch {
    return null; // 观测面不承重（判据见上面的「观测块不得把健康端点打挂」）
  }
}

/**
 * @param {{pool: object, config: object, log?: Console, docker?: object, llmGateway?: object,
 *          mailerProvider?: object, tlsConnect?: Function, tlsRoutePath?: string}} opts
 *   `tlsConnect` / `tlsRoutePath` 仅供测试注入（#456 的真机校验探针）：前者换掉 `tls.connect`，
 *   后者换掉 `/proc/net/route`。生产形态两者都不传（走真 socket + 真路由表）。
 */
export function createServer({
  pool, config, log = console, docker = null, llmGateway = null, mailerProvider = null,
  tlsConnect = null, tlsRoutePath = '/proc/net/route',
}) {
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
  // #449：邮箱验证码的两个限流器。
  //   emailCodeLimiter：按「账户 + IP」计**校验失败**（换新 pending_token 不重置，防爆破 6 位码）；
  //   emailSendLimiter：按 IP 计**发信频率**（限流器只有 recordFailure 一个计数入口，所以每次发信都记一次）。
  const emailCodeLimiter = createRateLimiter({
    maxFailures: config.emailCodeRateLimit?.maxFailures ?? 10,
    windowMs: config.emailCodeRateLimit?.windowMs ?? 15 * 60 * 1000,
    blockMs: config.emailCodeRateLimit?.blockMs ?? 15 * 60 * 1000,
    maxEntries: config.emailCodeRateLimit?.maxEntries ?? config.loginRateLimit?.maxEntries ?? 10000,
  });
  const emailSendLimiter = createRateLimiter({
    maxFailures: config.emailSendRateLimit?.maxFailures ?? 20,
    windowMs: config.emailSendRateLimit?.windowMs ?? 15 * 60 * 1000,
    blockMs: config.emailSendRateLimit?.blockMs ?? 15 * 60 * 1000,
    maxEntries: config.emailSendRateLimit?.maxEntries ?? config.loginRateLimit?.maxEntries ?? 10000,
  });
  // #449 管理台：**测试发信**按管理员限流（5 次/小时，key `mailtest:<adminId>`）。
  // 语义与 emailSendLimiter 同族（限流器只有 recordFailure 一个计数入口 ⇒ 每次尝试记一次），
  // 但**只在通道确实启用时**才记（未启用的 409 不烧配额，否则「还没配好就先把额度用光」）。
  const mailTestLimiter = createRateLimiter({
    maxFailures: config.mailTestRateLimit?.maxFailures ?? 5,
    windowMs: config.mailTestRateLimit?.windowMs ?? 60 * 60 * 1000,
    blockMs: config.mailTestRateLimit?.blockMs ?? 60 * 60 * 1000,
    maxEntries: config.mailTestRateLimit?.maxEntries ?? config.loginRateLimit?.maxEntries ?? 10000,
  });
  // #456 管理台证书：上传/回滚 10 次/小时、真机校验 30 次/小时，都按管理员计（key `tlsupload:<adminId>` /
  // `tlsverify:<adminId>`）。同 mailTestLimiter 的形状（createRateLimiter 只有 recordFailure 一个计数入口）。
  // **只在真会落盘 / 真会握手时才记**：证书校验失败（PEM 错、不配对、不覆盖域名）不烧配额——
  // 用户改一张 PEM 常常要试几次，先把额度用光只会让他连「改对了」都提交不进去。
  const tlsUploadLimiter = createRateLimiter({
    maxFailures: config.tlsUploadRateLimit?.maxFailures ?? 10,
    windowMs: config.tlsUploadRateLimit?.windowMs ?? 60 * 60 * 1000,
    blockMs: config.tlsUploadRateLimit?.blockMs ?? 60 * 60 * 1000,
    maxEntries: config.tlsUploadRateLimit?.maxEntries ?? config.loginRateLimit?.maxEntries ?? 10000,
  });
  const tlsVerifyLimiter = createRateLimiter({
    maxFailures: config.tlsVerifyRateLimit?.maxFailures ?? 30,
    windowMs: config.tlsVerifyRateLimit?.windowMs ?? 60 * 60 * 1000,
    blockMs: config.tlsVerifyRateLimit?.blockMs ?? 60 * 60 * 1000,
    maxEntries: config.tlsVerifyRateLimit?.maxEntries ?? config.loginRateLimit?.maxEntries ?? 10000,
  });
  // #456 M2：`POST /api/admin/tls/inspect` 是**只解析不落盘**的端点（工单唯一允许的后端追加）。
  // 它**不烧上传配额**（那一档 10 次/小时是留给「真会改线上握手」的操作），单独一档 **120 次/小时**：
  // 解析一张 PEM 是纯 CPU（OpenSSL），限流只为防脚本刷；正常人手点几十次够用，改错了也不会被锁住。
  const tlsInspectLimiter = createRateLimiter({
    maxFailures: config.tlsInspectRateLimit?.maxFailures ?? 120,
    windowMs: config.tlsInspectRateLimit?.windowMs ?? 60 * 60 * 1000,
    blockMs: config.tlsInspectRateLimit?.blockMs ?? 60 * 60 * 1000,
    maxEntries: config.tlsInspectRateLimit?.maxEntries ?? config.loginRateLimit?.maxEntries ?? 10000,
  });
  // #664 管理台提示词三条 PUT（`addendum` / `agents-md` / `title-prompt`）：每次**成功保存**都会给
  // **全部启用中的 FDE** 各入队一条物化（`platform-prompts.js` 的 `enqueueMaterializeForAllFdes`：谓词
  // `fde_name IS NOT NULL AND status IN ('active','awaiting_credential')`）⇒ 一次保存扇出 W 条
  // outbox 行 + W 次 revision bump + W 次家目录重物化 + 一行审计（W = 启用中的工位数，真机 dev 实测 6）。
  // 消费侧（`materializer.js#claimMaterializeRows`）的 latest-wins 只把「真重写」合并成「每 FDE 每 claim
  // 周期 ≤1 次」，**不合并**入队侧的行/revision/审计，也不合并跨多个 claim 周期的重写 ⇒ 扇出的写放大
  // 仍要在**源头**钳住。`ADMIN_IP_ALLOWLIST` 为空（放行全部），「只有管理员碰得到」不成立。
  // 阈值 **30 次成功保存 / 操作者+端点 / 60 分钟**（口径照 mailTest/tls：createRateLimiter 只有 recordFailure
  // 一个计数入口 ⇒ 每次真保存记一次）：
  //   * 上界（不夹人手编辑）：单面板现实最猛的一轮改文案 < 10 次/小时，30 留 ≥3× 余量 ⇒ 正常管理员看不到 429；
  //   * 下界（钳写放大）：30/hr/端点 ⇒ 单操作者单端点每小时入队写 ≤ 30×W 行 + 30 行审计（W=6 时 ≤180），
  //     有界且小；blockMs=60min 让脚本连点一旦触顶就整点冷却，之后不再叠行；
  //   * 同量级（issue 要求「与既有登录类限流同量级」）：login 5 / mailTest 5 / tlsUpload 10（真改线上握手）
  //     / tlsInspect 120（纯 CPU 解析）——一次提示词保存比换证书轻、但比纯解析重（有扇出）⇒ 取 30，
  //     落在 tlsUpload(10) 与 tlsInspect(120) 之间。
  // 键含**端点 slug** ⇒ 三个端点各自独立计数；只读的那条 GET 不限流。
  const platformPromptsLimiter = createRateLimiter({
    maxFailures: config.platformPromptsRateLimit?.maxFailures ?? 30,
    windowMs: config.platformPromptsRateLimit?.windowMs ?? 60 * 60 * 1000,
    blockMs: config.platformPromptsRateLimit?.blockMs ?? 60 * 60 * 1000,
    maxEntries: config.platformPromptsRateLimit?.maxEntries
      ?? config.loginRateLimit?.maxEntries ?? 10000,
  });
  // #736：API 令牌签发限流（键 `auth-token-mint:user:<targetUserId>`，默认 10/小时）。
  // 口径照 tlsUpload（同为低频管理台写）：`createRateLimiter` 只有 recordFailure 一个计数入口
  // ⇒ 只在**真签发成功**时记一次（撞名 409 / 校验失败不烧配额）。
  const tokenMintRl = config.authTokenMintRateLimit ?? {};
  const authTokenMintLimiter = createRateLimiter({
    maxFailures: tokenMintRl.maxFailures ?? 10,
    windowMs: tokenMintRl.windowMs ?? 60 * 60 * 1000,
    blockMs: tokenMintRl.blockMs ?? 60 * 60 * 1000,
    maxEntries: tokenMintRl.maxEntries ?? config.loginRateLimit?.maxEntries ?? 10000,
  });
  // #449：邮件通道读取侧（SMTP 参数存 DB，见 `mail-provider.js`）。`mailerProvider` 参数仅供测试注入 fake。
  // 为什么不在启动时同步读一次：登录是热路径但启动不是；真正的「现在到底能不能发信」每次登录时由
  // `ctx.mailerProvider.get()` 回答（60s 缓存 + 急停硬闸）。这里只在 `config.mail` 存在（= `loadConfig`
  // 产物，即真实部署形态）时做一次异步探针，把「第二因素实际不生效」说在启动日志里。
  const mailProvider = mailerProvider ?? createMailProvider({ pool, config, log });
  if (config.mail) {
    mailProvider
      .get()
      .then((m) => {
        if (!m.enabled) {
          log?.warn?.(
            '[auth] email verification code disabled (mail settings unavailable or MAIL_TRANSPORT=disabled); accounts without TOTP log in with password only',
          );
        }
      })
      .catch(() => {}); // 探针永不拖垮启动（provider 自己已经把读取失败降级成 disabled）
  }
  const ctx = {
    pool, config, log, loginLimiter, totpLimiter, totpTokenLimiter, kdfSemaphore, previewTicketLimiter,
    mailerProvider: mailProvider, emailCodeLimiter, emailSendLimiter, mailTestLimiter, docker,
    tlsUploadLimiter, tlsVerifyLimiter, tlsInspectLimiter, platformPromptsLimiter,
    authTokenMintLimiter,
    // #456：真机校验的注入点（生产 = `tls.connect` + `/proc/net/route`；单测换成假 socket / 假路由表）。
    tlsConnect, tlsRoutePath,
    // #456：最近一次**真机校验**结果（内存态，单实例）。GET 只回缓存，绝不主动连（那是 verify 端点的事）。
    // 上传/回滚成功后会被重置成 `unknown`——旧结果对应的是上一张证书，留着就是撒谎。
    tlsLive: { status: 'unknown', checkedAt: null },
    llmGateway: llmGateway ?? createLlmGatewayClient({
      adminUrl: config.llmGatewayAdminUrl ?? 'http://station-litellm:4000',
      masterKey: config.llmGatewayMasterKey ?? '',
    }),
    // #808：用户面额度端点（`GET /api/me/llm-quota`）的 30s 进程内缓存。**故意挂在 ctx 上**
    // （而非模块级单例）：缓存在进程内跨请求共享（同一 server 多次 GET 只打一次网关），但**每个
    // server 实例一份**，单测 `createServer` 起来就是干净的一份、天然不串台，无需导出 clear 钩子。
    // TTL / 错误不缓存的口径见 `llm.createQuotaCache`。
    selfQuotaCache: llm.createQuotaCache(),
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
      const locale = resolveRequestLocale(req); // #803：一次请求只算一次，喂下面所有 errorBody 的文案挑选
      if (err instanceof HttpError) {
        const headers = { ...(err.headers || {}) };
        if (err.status === 413) headers['Connection'] = 'close'; // 未读完的请求体需断开
        sendJson(res, err.status, errorBody(err.code, pickMessage(err, locale), err.retryable, err.details), headers);
        return;
      }
      if (err instanceof projects.ProjectError) {
        sendJson(res, err.httpStatus, errorBody(err.code, pickMessage(err, locale), false, err.details));
        return;
      }
      if (err instanceof sessions.SessionError) {
        sendJson(res, err.httpStatus, errorBody(err.code, pickMessage(err, locale), false, err.details));
        return;
      }
      if (err instanceof dirs.DirError) {
        // issue #472：`retryable` 由错误自己带（既有 DirError 一律不带 ⇒ 恒 false，行为逐字不变），
        // 只有 `upload_interrupted` 声明 true（客户端断流，重发即可）。**没加新映射分支**。
        sendJson(res, err.httpStatus, errorBody(err.code, pickMessage(err, locale), err.retryable === true, err.details));
        return;
      }
      if (err instanceof idempotency.IdempotencyError) {
        sendJson(res, err.httpStatus, errorBody(err.code, pickMessage(err, locale), err.retryable, err.details));
        return;
      }
      if (err instanceof internal.InternalError) {
        sendJson(res, err.status, errorBody(err.code, pickMessage(err, locale), err.retryable, err.details));
        return;
      }
      if (err instanceof llm.LlmError) {
        // issue #261014 切片 B2：`retryable` 由错误自己带（既有 LlmError 不带 ⇒ 恒 false，行为不变）。
        sendJson(res, err.httpStatus, errorBody(err.code, pickMessage(err, locale), err.retryable === true, err.details));
        return;
      }
      if (err instanceof LlmGatewayError) {
        sendJson(res, err.status, errorBody('llm_gateway_error', pickMessage(err, locale)));
        return;
      }
      if (err instanceof gitCredential.GitCredentialError) {
        sendJson(res, err.httpStatus, errorBody(err.code, pickMessage(err, locale), false, err.details));
        return;
      }
      if (err instanceof gitHosts.GitHostError) {
        sendJson(res, err.httpStatus, errorBody(err.code, pickMessage(err, locale), false, err.details));
        return;
      }
      if (err instanceof mailSettings.MailSettingsError) {
        sendJson(res, err.httpStatus, errorBody(err.code, pickMessage(err, locale), false, err.details));
        return;
      }
      if (err instanceof uploadSettings.UploadSettingsError) {
        sendJson(res, err.httpStatus, errorBody(err.code, pickMessage(err, locale), false, err.details));
        return;
      }
      if (err instanceof platformPrompts.PlatformPromptsError) {
        // #596 片 A：httpStatus 与 `code` 自带 ⇒ **零新错误码、零新映射规则**（一律 `validation_failed`）。
        sendJson(res, err.httpStatus, errorBody(err.code, pickMessage(err, locale), false, err.details));
        return;
      }
      if (err instanceof runtimeSettings.RuntimeSettingsError) {
        // #677 P2a：写侧的三类 400（`unknown_setting` / `scalar_required` / `validation_failed`）在 HTTP 边界
        // **一律映成既有的 `validation_failed`**（零新错误码，口径同上面 `platform-prompts` 那一块）。
        // 模块里保留那三个细粒度 code 是给非 HTTP 调用方（CLI/脚本）定位用的；给运维的真相在
        // `details.field`（`key` 还是 `value`）与 `details.known` 里，它们原样透传。500 仍是 `internal`。
        const code = err.httpStatus === 400 ? 'validation_failed' : err.code;
        sendJson(res, err.httpStatus, errorBody(code, pickMessage(err, locale), false, err.details));
        return;
      }
      if (err instanceof secrets.SecretError) {
        // #608：槽值面的错误（空串 / 超长 / 未声明）有自己的 code 集合，别混进 validation_failed。
        sendJson(res, err.httpStatus ?? 400, errorBody(err.code, pickMessage(err, locale), false, err.details));
        return;
      }
      if (err instanceof market.MarketError) {
        // #595：市场域自己的错误载体（`code` 集合是 §7 的契约：validation_failed /
        // capability_not_found / capability_not_published / capability_budget_exceeded /
        // capability_kind_unsupported / capability_install_failed）。`details` 里只有字段名/数字/路径，
        // **不含包内容**（2 MiB 的源码不该进错误响应）。
        sendJson(res, err.httpStatus, errorBody(err.code, pickMessage(err, locale), false, err.details));
        return;
      }
      if (err instanceof tlsCert.TlsCertError) {
        // #456：证书面的错误一律 `retryable:false`（`tls_cert_expired` 也是——换一张证书才是出路，
        // 重试一万次还是同一张）。`details` 里只有字段名/域名/指纹，**没有 PEM、没有私钥**。
        sendJson(res, err.httpStatus, errorBody(err.code, pickMessage(err, locale), false, err.details));
        return;
      }
      if (err instanceof admin.AdminError) {
        sendJson(res, err.httpStatus, errorBody(err.code, pickMessage(err, locale), false, err.details));
        return;
      }
      if (err instanceof delegation.DelegationError) {
        // 子 run 读侧：只用既有错误码（not_found / validation_failed / payload_too_large / internal），
        // httpStatus 自带在错误上 ⇒ 零新码、零新映射规则。
        sendJson(res, err.httpStatus, errorBody(err.code, pickMessage(err, locale), false, err.details));
        return;
      }
      if (err instanceof MacroError) {
        // #526 宏域（macros.js / macro-routes.js / notifications.js 共用这一种错误载体）：
        // httpStatus 自带 ⇒ 与 SessionError/DelegationError 同形映射，零新错误码。
        sendJson(res, err.httpStatus, errorBody(err.code, pickMessage(err, locale), false, err.details));
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
    throw new HttpError(400, 'validation_failed', '用户 id 必须是 UUID', { en: 'User id must be a UUID', details: { field: 'id' } });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new HttpError(400, 'validation_failed', '用户 id 必须是 UUID', { en: 'User id must be a UUID', details: { field: 'id' } });
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
    // #515：就绪响应多带一块 `partialBuffer` 观测数字（**additive**，`status` 语义不变、503 形状不变、
    // 不新增端点与鉴权面）。为什么必须有：缓冲逐出活跃 run 只表现为「那段正文没了」，此前对外
    // 零读数（无 `/metrics`）⇒ 只有 `log.warn` 可对账。形状与红线见 `partialBufferHealth` 的注释。
    // #586：再 additive 一块 `version`（**只有** station/revision/builtAt，不带引擎版本；
    // 读不到就三格 `unknown`）。存在的理由：v0.1.69 发布时 portal 烘的是停在 0.1.68 的旧工作树，
    // 两边分裂一小时而**对外零读数**——`curl /api/health` 现在能直接把「跑的是哪份构建」说出来。
    // 对健康检查结构性安全（它只看 `res.ok`，不解析 body；口径见 deploy-contract.md §2.3）。
    if (ok) {
      const pb = partialBufferHealth();
      return sendJson(res, 200, pb
        ? { status: 'ok', version: healthVersionBlock(), partialBuffer: pb }
        : { status: 'ok', version: healthVersionBlock() });
    }
    return sendJson(res, 503, errorBody('migration_failed', 'not ready'));
  }

  if (pathname.startsWith('/api/')) {
    return routeApi(req, res, ctx, url);
  }
  return serveStatic(req, res, ctx, url);
}

async function routeApi(req, res, ctx, url) {
  const { pathname } = url;
  const { pool, config } = ctx;
  // #736：挂 `res` 供 `resolveSession` 在令牌命中时就地发 `X-Auth-Method: api_token`。
  req[REQ_RES] = res;

  // ---- #234：跨站写请求防线（portal.md §2.11）——先于任何 handler 执行，否则 CSRF 会先碰到底层副作用。----
  // 豁免（在 csrfGateFor 里）：/api/internal/* 与 /api/forward-auth。拒绝：403 `cross_origin_forbidden`
  // + #241 那套 CORS deny 头+ 一条审计。
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

  // #449：邮箱验证码的两条（第二步 + 重发）。与 TOTP 第二步同层：已在 `csrfGateFor` 之后。
  if (req.method === 'POST' && pathname === '/api/auth/login/email-code') {
    return handleLoginEmailCode(req, res, ctx);
  }

  if (req.method === 'POST' && pathname === '/api/auth/login/email-code/resend') {
    return handleLoginEmailCodeResend(req, res, ctx);
  }

  // ---- #450 A2：GET /api/site（公开、零秘密）----
  // 前端要知道「用户面与管理台各自的对外 URL」（跨 host 跳转的落点），而**登录页也要用**它 ⇒ 不能要求会话。
  // 只回这两个 URL：不含版本号 / 镜像 / host 清单 / ADMIN_IP_ALLOWLIST 等运维面信息（零秘密）。
  // 两个值都来自既有配置（`resolvePublicBaseUrl` 的产物与 A1 的 `adminPublicBaseUrl`），handler 里**不另拼 URL**
  // ——拼第二套就一定会与 agentd 拿到的 base URL / 预览 URL 漂移。
  // 两个入口都可达：管理台入口侧靠 routes.js 的 `admin-auth` 允许面 + `admin-deny-api` 的排除列表
  //（两份列表严格互补，`portal/test/routes.test.js` 用规则求值器钉住「/api/site 命中 admin-auth 而非 deny」）。
  if (pathname === '/api/site') {
    if (req.method !== 'GET') {
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }
    return sendJson(res, 200, {
      // `userBaseUrl` **跟随请求入口**（2026-11-06 真机：从 https:8443 进来却被告知用户面在
      // `http://…:8090`，于是「回工作台」把人从 https 送回 http）。只在「请求确实打在用户面 host 上」
      // 时才跟随；管理台 host 来问时仍报配置值（它不知道用户平时用哪个入口）。
      userBaseUrl: entryBaseFromRequest(req, { expectHost: configuredUserHostname(config.portalPublicBaseUrl) })
        ?? config.portalPublicBaseUrl,
      adminBaseUrl: config.adminPublicBaseUrl,
    });
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    // #736（设计点 12）：Bearer 令牌不能被「登出」，只能被吊销 ⇒ 400（不带 body 的旧语义不变）。
    if (getBearerToken(req).present) {
      throw new HttpError(
        400, 'logout_not_applicable_for_tokens',
        'API 令牌不能登出（令牌没有会话）；作废需由管理员吊销该令牌', { en: 'API tokens cannot log out (a token has no session); to invalidate one, an administrator must revoke the token' },
      );
    }
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
    // #677 P2a：会话 TTL 现在是**可热改的运行时旋钮**（`runtime_settings.session.ttl_seconds`）。
    // ⚠ 这一行**不是**「每个 `/api/me` 都发一次 DB 读」：`readSessionTtlSeconds` 带 5s 缓存，
    //   同一进程内同池最多 5 秒一次整表读（多副本同理，最坏 5 秒内各副本读数可以不同）。
    //   不缓存才是真 bug：那会把 `runtime_settings` 变成登录面的强依赖（#520 那一单的病根）。
    //   口径：管理台改完 → 本进程下一次读就变（写路径会失效缓存）；别的副本最多 5 秒追上。
    const ttlSeconds = await runtimeSettings.readSessionTtlSeconds({
      pool, config, log: ctx.log,
    });
    const renewIntervalSeconds = await runtimeSettings.readSessionRenewIntervalSeconds({
      pool, config, log: ctx.log,
    });
    const renewed = await auth.renewSession(pool, session.session.id, {
      ttlSeconds,
      renewIntervalMs: renewIntervalSeconds * 1000,
    });
    const headers = {};
    // cookie 的 `Max-Age` 必须跟着**刚才签发会话用的那个数**：`config.cookie.maxAge` 是
    // `loadConfig` 时算的副本（DB 改了它不会动），拿它发 cookie 就是「库里 1 小时、浏览器里 7 天」。
    if (renewed) {
      headers['Set-Cookie'] = sessionCookieHeader({ ...config.cookie, maxAge: ttlSeconds }, token);
    }
    return sendJson(res, 200, { user: session.user }, headers);
  }
  // ---- #255 自助改密（首登强制改密的唯一出口，portal.md §2.6a）----
  if (pathname === '/api/me/password') {
    if (req.method === 'POST') return handleChangeMyPassword(req, res, ctx);
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }
  // ---- #828 P1：本人改账号级语言偏好（会话认证，portal.md §2.6a）----
  // body `{ locale: 'zh-CN'|'en'|null }`；非法 ⇒ 400 `validation_failed` + `details.field='locale'`
  // （文案走 #803 双语机制：`HttpError` 带 `en`，`locale=en` 时出英文）；成功回 `{ locale: <归一化值> }`。
  // 服务端**不查库定语言**：这里只是写库，前端拿到响应后同时写 cookie + localStorage。
  if (pathname === '/api/me/locale') {
    if (req.method !== 'PATCH') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    const session = await requireSession(req, ctx);
    requireJson(req);
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'locale')) {
      throw new HttpError(400, 'validation_failed', 'locale 是必填（可为 null 以清除）', { en: 'locale is required (use null to clear)', details: { field: 'locale' } });
    }
    const norm = normalizeUserLocale(body.locale);
    if (!norm.ok) {
      throw new HttpError(400, 'validation_failed', "locale 只允许 'zh-CN'、'en' 或 null", { en: "locale must be 'zh-CN', 'en', or null", details: { field: 'locale' } });
    }
    const stored = await setUserLocale(ctx.pool, session.user.id, norm.value);
    return sendJson(res, 200, { locale: stored });
  }
  if (pathname === '/api/me/git-credential') {
    const session = await requireSession(req, ctx);
    const fdeName = session.user.fde_name;
    if (!fdeName) {
      throw new admin.AdminError('fde_name_required', '当前用户未分配 fde_name，无法管理 Git 凭据', { httpStatus: 400, en: 'the current user has no fde_name assigned, so managing Git credentials is not available' });
    }
    if (req.method === 'GET') {
      const result = await gitCredential.listGitCredentials({ config: ctx.config, fdeName });
      return sendJson(res, 200, { items: result.hosts });
    }
    if (req.method === 'PUT') {
      requireJson(req);
      const body = await readJsonBody(req);
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
      const body = await readJsonBody(req);
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

  // ---- #808 用户面额度 / 用量（portal.md §2.14 / §2.15）----
  // 与 git-credential 同一取法：人**一律**取 session.user.fde_name，**不接受**任何 fde_name 查询/路径参
  // 数（结构上看不了别人的账）。网关错误不吞（getSelfQuota 只把 not_found 收成 no_binding）。
  if (pathname === '/api/me/llm-quota') {
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    const session = await requireSession(req, ctx);
    const fdeName = session.user.fde_name;
    if (!fdeName) {
      throw new admin.AdminError('fde_name_required', '当前用户未分配 fde_name，无法读取额度', { httpStatus: 400, en: 'the current user has no fde_name assigned, so reading quota is not available' });
    }
    // 30s 缓存（挂在 ctx.selfQuotaCache，进程内跨请求共享）：命中直接用，不重复打网关。
    // 只缓存成功值（getSelfQuota 抛错时根本不 set），故网关故障不会被缓存成空态。
    const cache = ctx.selfQuotaCache;
    const cached = cache.get(fdeName);
    if (cached !== undefined) return sendJson(res, 200, cached);
    const result = await llm.getSelfQuota(ctx.pool, { fdeName, gateway: ctx.llmGateway });
    cache.set(fdeName, result);
    return sendJson(res, 200, result);
  }
  if (pathname === '/api/me/llm-usage') {
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    const session = await requireSession(req, ctx);
    const fdeName = session.user.fde_name;
    if (!fdeName) {
      throw new admin.AdminError('fde_name_required', '当前用户未分配 fde_name，无法读取用量', { httpStatus: 400, en: 'the current user has no fde_name assigned, so reading usage is not available' });
    }
    // days 校验逐字对齐管理侧 `/api/admin/fdes/:fde/llm/usage`（http.js 内那段）：
    // 只要带了 `days`（含空串 `?days=`）就必须是 1–90 整数；只有完全不写才走默认 30。
    const rawDays = url.searchParams.get('days');
    let days = 30;
    if (rawDays !== null) {
      days = Number(rawDays);
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        throw new HttpError(400, 'validation_failed', 'days 必须为 1–90 的整数', { details: { field: 'days' }, en: 'days must be an integer between 1 and 90' });
      }
    }
    const usage = await llm.getSelfUsage(ctx.pool, { fdeName, gateway: ctx.llmGateway, days });
    return sendJson(res, 200, usage);
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
  // issue #472：文件上传（原始字节体，零 multipart 依赖）。写请求 ⇒ #234 同源门已在 routeApi 入口过；
  // 本端点**不进** RESTRICTED_SESSION_ALLOWLIST（欠改密的会话不该能往用户磁盘写东西）。
  if (pathname === '/api/files/upload' && req.method === 'POST') {
    return handleFileUpload(req, res, ctx, url);
  }
  if (pathname === '/api/file' && req.method === 'GET') {
    return handleFilePreview(req, res, ctx, url);
  }
  // issue #359 P0a：目录 git「收工灯」（决策见 AGENTS.md §7 D9）——同一作用域、同一条直读通道。
  if (pathname === '/api/git-light' && req.method === 'GET') {
    return handleGitLight(req, res, ctx, url);
  }

  // ---- 项目与端口（portal.md §3；P5：写路径退役，projects 表留档只读） ----
  if (pathname === '/api/projects') {
    // P5 去项目化：项目注册已退役（目录即项目）。写端点 410 明示退役；GET 保留（归档只读）。
    if (req.method === 'POST') throw new HttpError(410, 'project_api_retired', '项目注册已退役（P5 目录即项目）：目录经 POST /api/sessions 的 project_id（cwd）自动创建', { en: 'Project registration is retired (P5: the directory is the project); directories are created automatically via project_id (cwd) on POST /api/sessions' });
    if (req.method === 'GET') return handleListProjects(req, res, ctx);
  }
  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    const projectId = decodeURIComponent(projectMatch[1]);
    if (req.method === 'GET') return handleGetProject(req, res, ctx, projectId);
    if (req.method === 'PATCH' || req.method === 'DELETE') {
      throw new HttpError(410, 'project_api_retired', '项目 CRUD 已退役（P5 目录即项目，projects 表留档只读）', { en: 'Project CRUD is retired (P5: the directory is the project; the projects table is a read-only archive)' });
    }
  }
  // F10：端口列表（portal.md §4.7）。P5：port_allocations 去项目化后项目维度端口不可推导，退役。
  const projectPortsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/ports$/);
  if (projectPortsMatch) {
    throw new HttpError(410, 'project_api_retired', '项目维度端口列表已退役（P5）：端口一律见 FDE 级 ~/.erix/ports.json', { en: 'Project-level port lists are retired (P5): ports are now defined only at the FDE level in ~/.erix/ports.json' });
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
  // 子 run（delegation）两个只读端点（docs/api/portal.md §4.4c、docs/design/delegation-2026-11-08.md §5）。
  // 鉴权同 GET /api/sessions/:id（属主校验在 delegation.js 的 fetchSession 里，404 不泄露存在性）。
  // 显式排在 `/events` 之前：路径不冲突，排序只为表达「只读快照」与「SSE 实时」是两条通路。
  // ⚠ `runId` 是**必填** query 参数（名册按父 run 分片 ⇒ 没有父身份就不知道该读哪个目录）；
  //   `childRunId` 走路径段，两个 id 的形态校验一律在 delegation.js 里（正则 + 前缀断言，P2 红线）。
  if (req.method === 'GET' && /^\/api\/sessions\/([^/]+)\/delegates$/.test(pathname)) {
    return handleSessionDelegates(req, res, ctx, decodeUuid(pathname.match(/^\/api\/sessions\/([^/]+)\/delegates$/)[1]));
  }
  if (req.method === 'GET' && /^\/api\/sessions\/([^/]+)\/delegates\/([^/]+)$/.test(pathname)) {
    const dMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/delegates\/([^/]+)$/);
    return handleSessionDelegateTranscript(req, res, ctx, decodeUuid(dMatch[1]), decodeUuid(dMatch[2]));
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

  // ---- #526 宏平台用户面（契约 10 篇 §3.2；⚠ 不能放 `/api/admin/*`——#450 白名单）。
  // 本链只做「正则匹配 → requireSession → 调 macro-routes → sendJson」，业务全部在 macro-routes.js；
  // 属主校验在其内部走 `fetchSession`（非属主/不存在都 404，不泄露存在性）。
  if (req.method === 'GET' && pathname === '/api/macro-templates') {
    await requireSession(req, ctx);
    return sendJson(res, 200, await macroRoutes.userTemplates({ pool: ctx.pool }));
  }
  // ---- issue #623：用户级订阅（`scope='user'` 模板如 scheduled-task 的开户入口；⚠ 不能放 `/api/admin/*`，#450 白名单）。
  // 属主一律当前 session 的 user（不接受 body 里的 userId）；响应复用 `toAssignmentSnapshot`。
  // ⚠ `DELETE .../:id` 排在 GET/PUT 之前注册：同名空间的静态段要先注册（口径同上 `unread-count` 那条注释）。
  const userMacroAssignOneMatch = pathname.match(/^\/api\/macro-assignments\/([^/]+)$/);
  if (req.method === 'DELETE' && userMacroAssignOneMatch) {
    const s = await requireSession(req, ctx);
    return sendJson(res, 200, await macroRoutes.deleteUserAssignment({
      pool: ctx.pool, userId: s.user.id, assignmentId: decodeUuid(userMacroAssignOneMatch[1]),
    }));
  }
  if (pathname === '/api/macro-assignments') {
    const s = await requireSession(req, ctx);
    if (req.method === 'GET') {
      return sendJson(res, 200, await macroRoutes.userAssignments({ pool: ctx.pool, userId: s.user.id }));
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await macroRoutes.putUserAssignment({ pool: ctx.pool, userId: s.user.id, body }));
    }
  }
  // ⚠ `unread-count` 排在 `/notifications/:id/read` 之前：两段都是 `/api/notifications/xxx`，
  // 后者的 `:id` 能吃掉 `unread-count`（同名空间里的静态段要先注册，口径同 macro-runs/summary）。
  if (req.method === 'GET' && pathname === '/api/notifications/unread-count') {
    const s = await requireSession(req, ctx);
    return sendJson(res, 200, await macroRoutes.notificationsUnreadCount({ pool: ctx.pool, userId: s.user.id }));
  }
  const notifReadMatch = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (req.method === 'POST' && notifReadMatch) {
    const s = await requireSession(req, ctx);
    return sendJson(res, 200, await macroRoutes.notificationMarkRead({
      pool: ctx.pool, userId: s.user.id, notificationId: decodeURIComponent(notifReadMatch[1]).toLowerCase(),
    }));
  }
  if (req.method === 'GET' && pathname === '/api/notifications') {
    const s = await requireSession(req, ctx);
    return sendJson(res, 200, await macroRoutes.notificationsList({ pool: ctx.pool, userId: s.user.id, query: url.searchParams }));
  }
  const sessMacroAssignMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/macro-assignments$/);
  if (sessMacroAssignMatch) {
    const s = await requireSession(req, ctx);
    const sessionId = decodeUuid(sessMacroAssignMatch[1]);
    if (req.method === 'GET') {
      return sendJson(res, 200, await macroRoutes.sessionAssignments({ pool: ctx.pool, sessionId, userId: s.user.id }));
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await macroRoutes.putAssignment({ pool: ctx.pool, sessionId, userId: s.user.id, body }));
    }
  }
  const sessMacroAssignOneMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/macro-assignments\/([^/]+)$/);
  if (req.method === 'DELETE' && sessMacroAssignOneMatch) {
    const s = await requireSession(req, ctx);
    return sendJson(res, 200, await macroRoutes.deleteAssignment({
      pool: ctx.pool,
      sessionId: decodeUuid(sessMacroAssignOneMatch[1]),
      userId: s.user.id,
      assignmentId: decodeUuid(sessMacroAssignOneMatch[2]),
    }));
  }
  if (req.method === 'GET' && /^\/api\/sessions\/([^/]+)\/macro-runs$/.test(pathname)) {
    const s = await requireSession(req, ctx);
    return sendJson(res, 200, await macroRoutes.sessionMacroRuns({
      pool: ctx.pool, userId: s.user.id,
      sessionId: decodeUuid(pathname.match(/^\/api\/sessions\/([^/]+)\/macro-runs$/)[1]),
      query: url.searchParams,
    }));
  }
  // issue #614：顶栏**用户级** chip 的跨会话流水（属主 = 当前用户，不绑 session）。
  // ⚠ 不能放 `/api/admin/*`（#450 白名单 deny）；与会话级那份同形（`{ items, nextCursor }`）。
  if (req.method === 'GET' && pathname === '/api/macro-runs') {
    const s = await requireSession(req, ctx);
    return sendJson(res, 200, await macroRoutes.userMacroRuns({
      pool: ctx.pool, userId: s.user.id, query: url.searchParams,
    }));
  }

  // ---- issue #595 能力市场：用户面（§7）。三条红线：只读 published、只作用于**当前登录用户自己的**
  // FDE、写操作一律审计。`fde_id` 与 `fde_name` 都取自 session，**不接受请求体里的 fde**
  // （收了就等于任何人都能往别人的家目录写文件）。 ----
  if (pathname === '/api/market/items') {
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    const s = await requireSession(req, ctx);
    const fde = marketFdeOf(s);
    return sendJson(res, 200, await market.listUserItems({ pool: ctx.pool, fdeId: fde.id }));
  }
  const marketItemMatch = pathname.match(/^\/api\/market\/items\/([^/]+)$/);
  if (marketItemMatch) {
    const s = await requireSession(req, ctx);
    const fde = marketFdeOf(s);
    const slug = decodeURIComponent(marketItemMatch[1]);
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    // slug 在**路径层**就卡形状：不合法根本不可能存条目，让它进库查一轮只会把 400 拖成 404。
    if (!market.SKILL_SLUG_RE.test(slug)) {
      throw new HttpError(400, 'validation_failed', 'slug 不合法', { en: 'invalid slug', details: { field: 'slug', slug } });
    }
    return sendJson(res, 200, { item: await market.getUserItem({ pool: ctx.pool, fdeId: fde.id, slug }) });
  }
  const marketActionMatch = pathname.match(/^\/api\/market\/items\/([^/]+)\/(install|uninstall|enabled)$/);
  if (marketActionMatch) {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    const s = await requireSession(req, ctx);
    const fde = marketFdeOf(s);
    const slug = decodeURIComponent(marketActionMatch[1]);
    const action = marketActionMatch[2];
    if (!market.SKILL_SLUG_RE.test(slug)) {
      throw new HttpError(400, 'validation_failed', 'slug 不合法', { en: 'invalid slug', details: { field: 'slug', slug } });
    }
    // install/enabled 带体（`enabled` / `force`）；uninstall 无体 ⇒ 不卡 Content-Type
    // （`requireJson` 会把没带 JSON 头的卸载请求直接 415，而它的语义本来就不需要体）。
    let body = {};
    if (action !== 'uninstall') {
      requireJson(req);
      body = await readJsonBody(req);
    }
    let result;
    if (action === 'install') {
      result = await market.installCapability({
        pool: ctx.pool, config: ctx.config, fde, slug,
        enabled: body?.enabled === undefined ? undefined : Boolean(body.enabled),
        force: body?.force === true,
        log: ctx.log,
      });
    } else if (action === 'uninstall') {
      result = await market.uninstallCapability({ pool: ctx.pool, config: ctx.config, fde, slug, log: ctx.log });
    } else {
      // #608：MCP 的启用闸要解析槽值（缺必填 ⇒ 409），所以要把 config 递下去。
      result = await market.setCapabilityEnabled({
        pool: ctx.pool, fde, slug, enabled: body?.enabled, config: ctx.config,
      });
    }
    await auth.audit(ctx.pool, {
      actorId: s.user.id,
      action: `user.capability_${action === 'enabled' ? 'enabled' : action}`,
      target: `capability:${slug}`,
      // 只记结果与版本：磁盘路径是平台内部事实，进了审计就会变成第二份真相。
      details: { changed: result.changed, version: result.version ?? null, enabled: result.enabled ?? null },
    });
    // 回包里同时给 `result`（这次做了什么）与 `item`（市面应长什么样）：前端装完要立刻把卡片翻成
    // 「已装/已启用」，拿刷新后的条目比让它自己拼三个字段便宜也不会不一致。
    const item = await market.getUserItem({ pool: ctx.pool, fdeId: fde.id, slug });
    return sendJson(res, 200, { result, item });
  }

  // ---- #736：管理台代 FDE 签发 / 列表 / 吊销 API 令牌（自己控制角色错误码与限流）----
  // 放在 `handleAdminApi` 的 blanket 分派**之前**：那层的 `requireAdmin` 对非 admin 产
  // `forbidden`，而 §2.13 契约要的是 `insufficient_role`；且签发要单独限流（`auth-token-mint`）。
  const apiTokenMatch = TOKEN_ROUTES_ENABLED ? pathname.match(/^\/api\/admin\/users\/([^/]+)\/tokens(?:\/([^/]+))?$/) : null;
  if (apiTokenMatch) return handleUserApiTokens(req, res, ctx, apiTokenMatch);

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
/**
 * #595：把 session 折成 `{id, name}` 的 FDE 坐标。
 * `fde_name` 缺失 = 这个账号没有自己的家目录（平台里 FDE 账号一定有），所以 400 而不是 403：
 * 这不是权限不够，是这个账号**没有可写的地方**。同 `git-credential` 那一条的口径。
 */
function marketFdeOf(session) {
  const name = session.user.fde_name;
  if (!name) {
    throw new HttpError(400, 'fde_name_required', '当前用户未分配 fde_name，无法安装能力（技能）',
      { en: 'The current user has no fde_name assigned and cannot install capabilities (skills)', details: { field: 'fde_name' } });
  }
  return { id: session.user.id, name };
}

async function requireAdmin(req, ctx) {
  const session = await requireSession(req, ctx);
  if (session.user.role !== 'admin') throw new HttpError(403, 'forbidden', 'forbidden');
  return session;
}

/**
 * #736：管理台代 FDE 签发 / 列表 / 吊销 API 令牌（§2.13）。
 * 只有 admin 能签（代 FDE）；目标用户按 login 解析，查不到 404。
 * 审计只记 `{token_id, name, user}`，绝不含 hash/明文。列表不审计。
 * @param {RegExpMatchArray} match `[^1]`=login，`[^2]`=令牌 id（可选）。
 */
async function handleUserApiTokens(req, res, ctx, match) {
  const { pool } = ctx;
  let login;
  try {
    login = decodeURIComponent(match[1]);
  } catch {
    throw new HttpError(400, 'validation_failed', 'login 非法', { en: 'invalid login', details: { field: 'login' } });
  }
  // 角色闸：非 admin ⇒ 403 `insufficient_role`（§2.13；与 blanket requireAdmin 的 `forbidden` 区分）。
  const actor = await requireSession(req, ctx);
  if (actor.user.role !== 'admin') {
    throw new HttpError(403, 'insufficient_role', '只有管理员能签发 API 令牌', { en: 'Only administrators can issue API tokens' });
  }
  const targetUserId = await apiTokens.findUserIdByLogin(pool, login);
  if (!targetUserId) throw new HttpError(404, 'not_found', '用户不存在', { en: 'User does not exist' });

  const rawId = match[2];
  const method = req.method;

  // POST /api/admin/users/<login>/tokens ⇒ 签发。
  if (!rawId && method === 'POST') {
    requireJson(req);
    const body = await readJsonBody(req);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 40) {
      throw new HttpError(400, 'validation_failed', 'name 必填且 1..40 字符', {
        en: 'name is required and must be 1..40 characters',
        details: { field: 'name' },
      });
    }
    // scopes 本期只支持空数组（给了非空 ⇒ 400，不许留死列）。
    if (body?.scopes !== undefined && (!Array.isArray(body.scopes) || body.scopes.length !== 0)) {
      throw new HttpError(400, 'scopes_unsupported', '本期 scopes 只支持空数组', { en: 'This iteration only supports an empty scopes array' });
    }
    // 限流（键 `auth-token-mint:user:<id>`，默认 10/小时）。
    const limiterKey = `auth-token-mint:user:${targetUserId}`;
    const gate = ctx.authTokenMintLimiter.check(limiterKey);
    if (!gate.allowed) {
      throw new HttpError(429, 'rate_limited', '签发令牌过于频繁，请稍后再试', {
        en: 'Token issuance is too frequent, please try again later',
        retryable: true,
        headers: { 'Retry-After': String(gate.retryAfterSeconds) },
      });
    }
    const token = apiTokens.generateApiToken();
    const tokenHash = apiTokens.hashApiToken(token);
    const minted = await apiTokens.mintToken(pool, { userId: targetUserId, name, tokenHash });
    if (!minted) {
      // 同账号重名（含已吊销，因为吊销不删行）⇒ 409，不冒 500。
      throw new HttpError(409, 'token_name_taken', '该用户已有同名令牌（吊销不释放名字）', { en: 'This user already has a token with the same name (revoking does not free the name)' });
    }
    ctx.authTokenMintLimiter.recordFailure(limiterKey);
    await auth.audit(pool, {
      actorId: actor.user.id,
      action: 'auth.token_created',
      target: login,
      details: { token_id: minted.id, name, user: login },
    }).catch(() => {});
    return sendJson(res, 201, {
      id: minted.id,
      name: minted.name,
      scopes: minted.scopes ?? [],
      created_at: minted.created_at,
      token,
    });
  }

  // GET /api/admin/users/<login>/tokens ⇒ 列表（不返 hash，含已吊销，创建时间升序，不审计）。
  if (!rawId && method === 'GET') {
    const tokens = await apiTokens.listTokens(pool, targetUserId);
    return sendJson(res, 200, { tokens });
  }

  // DELETE /api/admin/users/<login>/tokens/<id> ⇒ 吊销（幂等）。
  if (rawId && method === 'DELETE') {
    const tokenId = decodeAdminUserUuid(rawId);
    const result = await apiTokens.revokeToken(pool, { userId: targetUserId, tokenId });
    if (result.outcome === 'missing') throw new HttpError(404, 'not_found', '令牌不存在', { en: 'Token does not exist' });
    if (result.outcome === 'revoked') {
      await auth.audit(pool, {
        actorId: actor.user.id,
        action: 'auth.token_revoked',
        target: login,
        details: { token_id: tokenId, name: result.name, user: login },
      }).catch(() => {});
    }
    return sendJson(res, 200, { status: 'revoked', already_revoked: result.outcome === 'already' });
  }

  throw new HttpError(405, 'method_not_allowed', 'method not allowed');
}

async function handleAdminApi(req, res, ctx, url) {
  const { pathname } = url;
  const session = await requireAdmin(req, ctx); // 所有 /api/admin/* 端点统一先鉴权

  // ---- issue #586：「关于」面板（平台自述的版本三格）------------------------------------
  // **只读、零副作用、零新错误码**：读镜像里烘的 build-info.json（前两格）+ `containers.agent_version`
  // （第三格，派生副本）。存在的理由就是本单的事故：三个版本号此前**只在人脑里分开**，
  // 界面上一个读面都没有 ⇒ 「FDE 报 0.1.69、portal 报 0.1.68」分裂一小时无人发现。
  // 为什么放管理台而不做用户侧工作台：两个引擎数并排给 FDE 看需要解释文案，那会变成第二个会漂的账（判据 C）。
  if (pathname === '/api/admin/version' && req.method === 'GET') {
    return sendJson(res, 200, await aboutPanel({ pool: ctx.pool, log: ctx.log }));
  }

  // ---- issue #650：管理台「系统」tab 的后端面（宿主 CPU / 内存 / 磁盘 / 容器数）----------------
  // **只读、零副作用、零新错误码**（入口已统一过 `requireAdmin` ⇒ 非 admin 在上面就 403 了，不重复加）。
  // 存在理由与 #586 的版本三格同形：真相一直在（`htop` / `free` / `df`），但界面上一个读面都没有。
  // `latest` 与 `series` 来自**同一个**采样器（`cli.js serve` 经 `config.metricsSampler` 递进来），
  // 不是两份真相；采样器没跑时 `latest: null`，DB 读失败时只带 `seriesError`——**两者都是 200**（降级不报错）。
  if (pathname === '/api/admin/system/metrics' && req.method === 'GET') {
    return sendJson(res, 200, await metricsApiPayload({
      pool: ctx.pool,
      sampler: ctx.config?.metricsSampler ?? null,
      retentionDays: ctx.config?.systemMetrics?.retentionDays ?? null,
      range: url.searchParams.get('range') ?? undefined,
    }));
  }

  // ---- #526 宏平台管理台（契约 10 篇 §3.3；业务在 macro-routes.js，本处只转发）----
  if (pathname === '/api/admin/macro-templates') {
    if (req.method === 'GET') {
      return sendJson(res, 200, await macroRoutes.adminTemplates({ pool: ctx.pool, query: url.searchParams }));
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await macroRoutes.adminCreateTemplate({ pool: ctx.pool, body, adminUserId: session.user.id }));
    }
  }
  const adminMacroTemplateMatch = pathname.match(/^\/api\/admin\/macro-templates\/([^/]+)$/);
  if (adminMacroTemplateMatch) {
    const templateId = decodeUuid(adminMacroTemplateMatch[1]);
    if (req.method === 'PATCH') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await macroRoutes.adminPatchTemplate({ pool: ctx.pool, templateId, body }));
    }
    if (req.method === 'DELETE') {
      return sendJson(res, 200, await macroRoutes.adminDeleteTemplate({ pool: ctx.pool, templateId }));
    }
  }
  // ⚠ `summary` 必须排在 `/macro-runs/:id` 之前：否则字面量 `summary` 会被当成 run id 吞掉。
  if (req.method === 'GET' && pathname === '/api/admin/macro-runs/summary') {
    return sendJson(res, 200, await macroRoutes.adminRunsSummary({ pool: ctx.pool, query: url.searchParams }));
  }
  const adminMacroRunMatch = pathname.match(/^\/api\/admin\/macro-runs\/([^/]+)$/);
  if (req.method === 'GET' && adminMacroRunMatch) {
    return sendJson(res, 200, await macroRoutes.adminMacroRunDetail({ pool: ctx.pool, runId: decodeUuid(adminMacroRunMatch[1]) }));
  }
  if (req.method === 'GET' && pathname === '/api/admin/macro-runs') {
    return sendJson(res, 200, await macroRoutes.adminMacroRuns({ pool: ctx.pool, query: url.searchParams }));
  }

  const adminGitCredentialMatch = pathname.match(/^\/api\/admin\/fdes\/([^/]+)\/git-credential$/);
  if (adminGitCredentialMatch) {
    let fdeName;
    try {
      fdeName = decodeURIComponent(adminGitCredentialMatch[1]);
    } catch {
      throw new HttpError(400, 'validation_failed', 'fde_name 非法', { en: 'invalid fde_name', details: { field: 'fde_name' } });
    }
    if (!projects.validateFdeName(fdeName).ok) {
      throw new HttpError(400, 'validation_failed', 'fde_name 非法', { en: 'invalid fde_name', details: { field: 'fde_name' } });
    }
    if (req.method === 'GET') {
      const result = await gitCredential.listGitCredentials({ config: ctx.config, fdeName });
      return sendJson(res, 200, result);
    }
    if (req.method === 'PUT') {
      requireJson(req);
      const body = await readJsonBody(req);
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
      const body = await readJsonBody(req);
      const provider = await llm.createProvider(ctx.llmGateway, body);
      return sendJson(res, 201, { provider });
    }
  }
  const adminProviderMatch = pathname.match(/^\/api\/admin\/llm\/providers\/([^/]+)$/);
  if (adminProviderMatch) {
    const providerId = decodeURIComponent(adminProviderMatch[1]);
    if (req.method === 'PATCH') {
      requireJson(req);
      const body = await readJsonBody(req);
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
    const body = await readJsonBody(req);
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
      const body = await readJsonBody(req);
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
      const body = await readJsonBody(req);
      const llmSelection = await llm.validateFdeLlmSelection(ctx.llmGateway, body?.llm);
      const rawGitHostId = body?.git_host_id;
      if (typeof rawGitHostId !== 'string'
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawGitHostId)) {
        throw new HttpError(400, 'validation_failed', 'git_host_id 必须是有效 UUID', { en: 'git_host_id must be a valid UUID', details: { field: 'git_host_id' } });
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
          throw new admin.AdminError('validation_failed', 'git_host_id 不存在', { details: { field: 'git_host_id' }, en: 'git_host_id does not exist' });
        }
        if (!gitHost.enabled) {
          throw new admin.AdminError('validation_failed', 'git host 已停用', { details: { field: 'git_host_id' }, en: 'the git host is disabled' });
        }
        if (gitHost.provider === 'azure') {
          throw new admin.AdminError('validation_failed', 'azure provider 尚不支持开户', { details: { field: 'git_host_id' }, en: 'the azure provider does not yet support onboarding' });
        }

        // #677 Tier 2A：登录/口令长度上限是热读旋钮 ⇒ 建用户前各现读一次，喂进 admin.createUser。
        const createMaxLoginLength = await runtimeSettings.readMaxLoginLength({
          pool: ctx.pool, config: ctx.config, log: ctx.log,
        });
        const createMaxPasswordLength = await runtimeSettings.readMaxPasswordLength({
          pool: ctx.pool, config: ctx.config, log: ctx.log,
        });
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
            maxLoginLength: createMaxLoginLength,
            maxPasswordLength: createMaxPasswordLength,
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
        throw new admin.AdminError('user_offboarding', '用户正在下线或处于保留期，不能重试开户', { httpStatus: 409, en: 'the user is being offboarded or is in the retention period, so onboarding cannot be retried' });
      }
      const result = await onboarding.retryOnboarding(ctx.pool, userId);
      if (!result) {
        const user = await ctx.pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
        if (!user.rows[0]) throw new admin.AdminError('not_found', '用户不存在', { httpStatus: 404, en: 'user does not exist' });
        throw new admin.AdminError('onboarding_not_found', '用户没有开户任务', { httpStatus: 409, en: 'the user has no onboarding task' });
      }
      if (result.state === 'running') {
        throw new admin.AdminError('onboarding_running', '开户任务正在运行', { httpStatus: 409, en: 'the onboarding task is already running' });
      }
      return sendJson(res, 200, { onboarding: result });
    }
    if (action === 'offboarding/retry' && req.method === 'POST') {
      const result = await offboarding.retryOffboarding(ctx.pool, userId);
      if (!result) {
        const user = await ctx.pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
        if (!user.rows[0]) throw new admin.AdminError('not_found', '用户不存在', { httpStatus: 404, en: 'user does not exist' });
        throw new admin.AdminError('offboarding_not_found', '用户没有下线任务', { httpStatus: 409, en: 'the user has no offboarding task' });
      }
      if (result.state === 'running') {
        throw new admin.AdminError('offboarding_running', '下线任务正在运行', { httpStatus: 409, en: 'the offboarding task is already running' });
      }
      return sendJson(res, 200, { offboarding: result });
    }
    if (action === 'reset-password' && req.method === 'POST') {
      requireJson(req);
      const body = await readJsonBody(req);
      const resetMaxPasswordLength = await runtimeSettings.readMaxPasswordLength({
        pool: ctx.pool, config: ctx.config, log: ctx.log,
      });
      const result = await admin.resetUserPassword(ctx.pool, userId, body?.password, {
        actorId: session.user.id,
        limits: { maxPasswordLength: resetMaxPasswordLength },
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
      const body = await readJsonBody(req);
      // 2026-11-06：打开「邮件验证码」开关前必须确认 SMTP 真能用。
      // 全局 `transport` 不再是功能闸（per-user 开关说了算），所以「开关开着但发不出信」会变成
      // 「这个人登不进去」——在保存这一刻拦住，比让他到登录页才发现便宜得多。
      // 关掉开关 / 改别的字段不受影响（不碰 mailer，避免通道抖动时连资料都改不了）。
      if (body && typeof body === 'object' && body.mail_otp_enabled === true) {
        const mailer = await ctx.mailerProvider.get();
        if (mailer.enabled !== true) {
          throw new HttpError(400, 'validation_failed',
            '邮件通道未配置或不可用，无法为该用户启用邮件验证码（请先在「邮件通道」里配置并测试）',
            { en: 'The mail channel is not configured or unavailable, so mail verification codes cannot be enabled for this user (configure and test it under "Mail channel" first)', details: { field: 'mail_otp_enabled' } });
        }
      }
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
      const body = await readJsonBody(req);
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
      const body = await readJsonBody(req);
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

  // ---- 管理台证书生命周期（issue #456 M1，契约 portal.md §4.13） ----
  // 四个端点全部已在 handleAdminApi 入口过 `requireAdmin`；盘上证书是真相，DB 只是台账。
  // 响应一律由 `tls-cert.js#describeTls` **逐键白名单**拼装（私钥/PEM 原文永不出现）。
  if (pathname === '/api/admin/tls') {
    if (req.method === 'GET') return handleAdminTlsGet(req, res, ctx);
    if (req.method === 'PUT') return handleAdminTlsPut(req, res, ctx, session);
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }
  if (pathname === '/api/admin/tls/verify') {
    if (req.method === 'POST') return handleAdminTlsVerify(req, res, ctx, session);
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }
  // #456 M2：**解析但不落盘**（唯一允许的后端追加）。给「粘贴 → 抽出域名 → 确认后才装」的两步交互用。
  if (pathname === '/api/admin/tls/inspect') {
    if (req.method === 'POST') return handleAdminTlsInspect(req, res, ctx, session);
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }
  if (pathname === '/api/admin/tls/rollback') {
    if (req.method === 'POST') return handleAdminTlsRollback(req, res, ctx, session);
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }

  // 管理台「邮件通道」配置（issue #449 写侧切片，契约 portal.md §4.12）：GET 读 / PUT 写 / POST 测试发信。
  // 口令**只写不读**：响应只有 `hasPassword` 布尔（模块层就不把 `smtp_password` 放进 DTO）。
  if (pathname === '/api/admin/mail/settings') {
    if (req.method === 'GET') {
      // 无行（未配置）也是 200 + 默认 DTO：未配置是正常态，不是 404。
      return sendJson(res, 200, await mailSettings.getMailSettings(ctx.pool));
    }
    if (req.method === 'PUT') {
      requireJson(req);
      const body = await readJsonBody(req);
      const result = await mailSettings.updateMailSettings({
        pool: ctx.pool,
        actorId: session.user.id,
        fields: body,
      });
      // 改配置**立刻**生效：不等 60s TTL（否则「配好了却要等一分钟」会被当成配置没生效）。
      ctx.mailerProvider.invalidate();
      // 审计只记「改了哪些键」+ 口令是否变化：**绝不含口令明文**（`details` 里没有 password 值）。
      await auth.audit(ctx.pool, {
        actorId: session.user.id,
        action: 'admin.mail_settings_updated',
        target: 'mail_settings',
        details: {
          changed: result.changed,
          password_changed: result.passwordChanged,
          transport: result.transport,
        },
      });
      return sendJson(res, 200, result.settings);
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }
  if (pathname === '/api/admin/mail/test') {
    if (req.method === 'POST') return handleAdminMailTest(req, res, ctx, session);
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }

  // 管理台「上传上限」（issue #485 片 A，契约 portal.md §4.15）：GET 读生效值 + 来源 / PUT 写。
  // 与 mail/settings 不同：无需 `invalidate()` —— 上传端点本就每次现读 DB（无缓存），改完立即生效。
  if (pathname === '/api/admin/upload/settings') {
    if (req.method === 'GET') {
      return sendJson(res, 200, await uploadSettings.getUploadSettings({
        pool: ctx.pool, config: ctx.config, log: ctx.log,
      }));
    }
    if (req.method === 'PUT') {
      requireJson(req);
      const body = await readJsonBody(req);
      const result = await uploadSettings.updateUploadSettings({
        pool: ctx.pool,
        config: ctx.config,
        log: ctx.log,
        actorId: session.user.id,
        fields: body,
      });
      // 审计**不在这里**写（复 audit 活二 + #698b）：`admin.upload_settings_updated` 已经与 upsert 挤进
      // **同一个事务**（`upload-settings.js` 的 `BEGIN` → `SELECT … FOR UPDATE` → upsert → 审计 → `COMMIT`）。
      // 最早这里是「upsert 已成 → 再 await 一笔 INSERT」：INSERT 失败就是「设置已生效而审计一行没有」，
      // 并发保存还会把 `previous_*` 记成自己进来之前的数。再补一笔 `auth.audit` 会退回那两个窗口，
      // 并且多写一条审计行（`upload-settings.test.js` US-18 钉这一点）。
      return sendJson(res, 200, result.settings);
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }

  // 管理台「提示词」面板（issue #596 片 A，契约 portal.md §4.19）：`GET` 读三块当前值 + 生效全文，
  // `PUT /api/admin/prompts/{addendum,agents-md,title-prompt}` 写。与 upload/settings 同口径：
  // **无需** `invalidate()`——物化与改名都每次现读。表不存在 / 读失败也回 `200`（回落内置，不是 500）；
  // **不新增错误码**，校验失败一律 `validation_failed`（`details.field`）。
  if (pathname === '/api/admin/prompts') {
    if (req.method === 'GET') {
      return sendJson(res, 200, await platformPrompts.getPlatformPrompts({
        pool: ctx.pool, log: ctx.log,
      }));
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }
  // 管理台提示词页的**生效面**（issue #801，契约 portal.md §4.19-5）：按工位给「盘上那份」+
  // 「按 DB 该有那份」两份账，让页面能回答「模型现在被说了什么」而不是「库里存着什么」。
  // **只读：零写、零审计**（页每次挂载都发；`GET /api/admin/prompts` 本来也不审计）。
  if (pathname === '/api/admin/prompts/effective-agents-md') {
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    return sendJson(res, 200, await platformPrompts.getEffectiveAgentsMd({
      pool: ctx.pool,
      userSpaceRoot: ctx.config.userSpaceRoot,
      fdeName: url.searchParams.get('fde'),
      log: ctx.log,
    }));
  }
  const adminPromptMatch = pathname.match(/^\/api\/admin\/prompts\/(addendum|agents-md|title-prompt)$/);
  if (adminPromptMatch) {
    if (req.method !== 'PUT') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    // #664：保存一次会给**全部启用中的 FDE** 各扇出一条物化（见 `platformPromptsLimiter` 上方注释），
    // 所以按「操作者 + 端点」限流。闸在**读体之前**（超限连体都不必解析），且**只在真保存后**记一次
    // （`createRateLimiter` 只有 recordFailure 一个计数入口）——400 校验失败没有扇出，不烧配额。
    const slug = adminPromptMatch[1];
    const promptLimitKey = `platformPrompt:${slug}:${session.user.id}`;
    const promptGate = ctx.platformPromptsLimiter.check(promptLimitKey);
    if (!promptGate.allowed) {
      throw new HttpError(429, 'rate_limited', '提示词保存过于频繁，请稍后再试', {
        en: 'Prompt saving is too frequent, please try again later',
        retryable: true,
        headers: { 'Retry-After': String(promptGate.retryAfterSeconds) },
      });
    }
    // 路由 slug → 写侧字段名（唯一一处映射；形状与上限的闸全在 `platform-prompts.js`）。
    const field = {
      addendum: 'addendum', 'agents-md': 'agentsMd', 'title-prompt': 'titlePrompt',
    }[slug];
    requireJson(req);
    const body = await readJsonBody(req);
    // 体本身不是对象 ⇒ `details.field='body'`（不是 `'text'`：那时连请求体都不是一份请求体）。
    // 形状闸只有 `platform-prompts.js` 一份，这里只是把**原始** body 递过去。
    platformPrompts.assertJsonObjectBody(body);
    const result = await platformPrompts.updatePlatformPrompts({
      pool: ctx.pool,
      field,
      text: body.text,
      actorId: session.user.id,
      log: ctx.log,
    });
    // 保存已成 ⇒ 这次真会扇出 ⇒ 计一次（越界/形状错的 400 在上面已抛 ⇒ 不走到这里 ⇒ 不计）。
    ctx.platformPromptsLimiter.recordFailure(promptLimitKey);
    // 审计**不在这里**写：`admin.platform_prompts_updated` 已经与旧值快照、渲染闸、upsert 挤进同一条
    // CTE（`platform-prompts.js` 的 `SAVE_SQL`）。再补一笔 `auth.audit` 会退回「设置已生效而审计一行
    // 没有」与「并发保存记错 `previous_*`」两个窗口，并且多写一条审计行（判据 `P8`）。
    // 响应出自 `RETURNING`（不回显输入）+ `materializeEnqueued`（`=0` ⇒ 页面要说「已保存，但物化未通知」）。
    return sendJson(res, 200, {
      ...result.prompts, materializeEnqueued: result.materializeEnqueued,
    });
  }

  // 管理台「运行时设置」（issue #677 P2a，契约 portal.md §4.21）：`GET` 读每个旋钮的生效值 + 来源，
  // `PUT /api/admin/runtime-settings/:key` 写。与上面几块同口径：**形状闸只有一份，全在
  // `runtime-settings.js`**，这一层只做匹配 + 鉴权（入口已 `requireAdmin`）+ 转发；
  // **不新增错误码**（写侧三类 400 一律 `validation_failed`，`details.field` 点名是 `key` 还是 `value`）；
  // 表不存在 / 读失败也回 `200`（回落 env/默认 + `source` 如实，见 §4.21）。
  if (pathname === '/api/admin/runtime-settings') {
    if (req.method === 'GET') {
      return sendJson(res, 200, await runtimeSettings.listRuntimeSettingsAdmin({
        pool: ctx.pool, config: ctx.config, log: ctx.log, locale: resolveRequestLocale(req),
      }));
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }
  // key 的形状与 0046 的 CHECK（`^[a-z][a-z0-9_.]{2,63}$`）同形：不匹配的路径段（`../`、中文、
  // 超长）在这里就是「没有这个路由」⇒ 404，而不是拿去库里绕一圈再报 400。
  const adminRuntimeSettingMatch = pathname.match(/^\/api\/admin\/runtime-settings\/([a-z][a-z0-9_.]{2,63})$/);
  if (adminRuntimeSettingMatch) {
    if (req.method !== 'PUT') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    // 未知的 key 在**发 SQL 之前**拒（400 + `details.field='key'` + `details.known`）：未登记的 key
    // 写进去就是一行永不生效的孤儿配置。`updateRuntimeSettingAdmin` 里还有一道同样的闸（给
    // CLI/脚本用），两处同源（`isKnownSetting`），不是第二份真相。
    const key = decodeURIComponent(adminRuntimeSettingMatch[1]);
    if (!runtimeSettings.isKnownSetting(key)) {
      throw new HttpError(400, 'validation_failed', `未知的运行时配置项：${key}`, {
        en: `Unknown runtime setting: ${key}`,
        details: { field: 'key', known: Object.keys(runtimeSettings.RUNTIME_SETTING_REGISTRY) },
      });
    }
    requireJson(req);
    const body = await readJsonBody(req);
    // 体本身不是对象 ⇒ `details.field='body'`（与 prompts 那块逐字同口径）。
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'validation_failed', '请求体必须是 JSON 对象', {
        en: 'Request body must be a JSON object',
        details: { field: 'body' },
      });
    }
    // 值/区间的闸全在 `runtime-settings.js`（标量闸 + registry 的 `validate`），**在发 SQL 之前**：
    // 非法值必须零写库、零审计（判据在 `portal/test/admin-runtime-settings-api.test.js`）。
    const result = await runtimeSettings.updateRuntimeSettingAdmin({
      pool: ctx.pool,
      actorId: session.user.id,
      key,
      value: body.value,
      log: ctx.log,
      // #803 返修 M1：回包的 `label`/`hint` 与 GET 同一套 locale 谈判——前端保存成功后拿这一行
      // 顶掉表格里的整行，这里恒中文会让英文页面保存一次就变回中文。审计与校验文案仍恒中文。
      locale: resolveRequestLocale(req),
    });
    // 审计**不在这里**写：`admin.runtime_settings_updated` 已经与 upsert 在**同一个事务**里
    // （`runtime-settings.js` 的 `BEGIN` → `SELECT … FOR UPDATE` → upsert → 审计 → `COMMIT`）。
    // 在这里补 `auth.audit` 会退回「设置已生效而审计一行没有」那个窗口，还多写一笔（口径同
    // 上面 upload/settings 与 prompts 那两块）。保存的失效钩子也在数据层（`HOT_READ_INVALIDATORS`）。
    return sendJson(res, 200, { item: result.item });
  }

  // ---- issue #595 能力市场：管理面（§7）。全部已在 handleAdminApi 入口过 `requireAdmin`。
  // 这一层的职责只有四件：匹配、鉴权、把 body 递给 market.js、写审计。校验与落盘全在数据层
  // （判据必须与 CLI/脚本调用同一条路径，不能只长在 HTTP 上）。 ----
  if (pathname === '/api/admin/market/items') {
    if (req.method === 'GET') {
      const state = url.searchParams.get('state');
      // 非法 `?state=` 当场 400：静默当成「没筛」返回全量，管理台会以为筛选生效了（数字对不上才发觉）。
      if (state !== null && state !== '' && !['draft', 'published', 'retired'].includes(state)) {
        throw new HttpError(400, 'validation_failed', 'state 只允许 draft/published/retired',
          { en: 'state only allows draft/published/retired', details: { field: 'state', state } });
      }
      return sendJson(res, 200, await market.listAdminItems({ pool: ctx.pool, state: state || null }));
    }
    if (req.method === 'POST') {
      requireJson(req);
      // bundle 是 JSON 里的 base64：2 MiB 原文编码后约 2.75 MiB，而全站默认的 JSON 请求体上限
      // （`DEFAULT_JSON_BODY_LIMIT`）只有 64 KiB ⇒ 这一条路由必须显式抬高上限，否则 413 会先于任何校验发生（§4.15 记的同一条坑）。
      const body = await readJsonBody(req, market.BUNDLE_MAX_BODY_BYTES);
      const item = await market.publishItem({ pool: ctx.pool, actorId: session.user.id, fields: body });
      await auth.audit(ctx.pool, {
        actorId: session.user.id,
        action: 'admin.capability_created',
        target: `capability:${item.slug}`,
        // 审计里只记账面事实（版本/状态/扫描分），**不含包内容与 base64**。
        details: { id: item.id, version: item.version, state: item.state, security_score: item.security_score },
      });
      return sendJson(res, 201, { item });
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }
  const adminMarketStateMatch = pathname.match(/^\/api\/admin\/market\/items\/([^/]+)\/(publish|retire)$/);
  if (adminMarketStateMatch && req.method === 'POST') {
    const itemId = decodeUuid(adminMarketStateMatch[1]);
    // ⚠ URL 里的**动词**不等于库里的**状态**：`capability_items.state` 只允许 draft/published/retired，
    //   直接传 `publish` 会被 `setItemState` 的域校验拒成 400 `validation_failed`（真机发布过这条路）。
    //   映射表在 `market.STATE_VERBS`（单一真相，单测 MK-23 钉住），未知动词 ⇒ 405。
    const state = market.stateForVerb(adminMarketStateMatch[2]);
    const item = await market.setItemState({ pool: ctx.pool, itemId, state });
    await auth.audit(ctx.pool, {
      actorId: session.user.id,
      action: `admin.capability_${adminMarketStateMatch[2]}`,
      target: `capability:${item.slug}`,
      details: { id: item.id, state: item.state },
    });
    return sendJson(res, 200, { item });
  }
  // #608 §7.2：凭据读写（**只写不读**：GET 只回 has_value 元数据，永不含值）。
  const adminMarketSecretsMatch = pathname.match(/^\/api\/admin\/market\/items\/([^/]+)\/secrets$/);
  if (adminMarketSecretsMatch) {
    const itemId = decodeUuid(adminMarketSecretsMatch[1]);
    if (req.method === 'GET') {
      const item = await market.getAdminItem({ pool: ctx.pool, itemId });
      return sendJson(res, 200, { item: { id: item.id, slug: item.slug, slots: await market.listSlots({ pool: ctx.pool, itemId }) } });
    }
    if (req.method === 'PUT') {
      requireJson(req);
      const body = await readJsonBody(req);
      // 非法 scope **当场 400**（审计必修）：静默当 global 意味着「想写某台工位的凭据，结果写成了全局」，
      // 而全局值会被所有工位解析到——这是把一次误操作放大成一次凭据扩散。
      const scopeRaw = body?.scope ?? 'global';
      if (scopeRaw !== 'global' && scopeRaw !== 'fde') {
        throw new HttpError(400, 'validation_failed', 'scope 只允许 global | fde',
          { en: 'scope only allows global | fde', details: { field: 'scope', scope: scopeRaw } });
      }
      const scope = scopeRaw;
      const fdeId = scope === 'fde' ? decodeUuid(String(body?.fde_id ?? '')) : null;
      const out = await market.setSlotValues({
        pool: ctx.pool, itemId, actorId: session.user.id, scope, fdeId,
        values: body?.values ?? {},
      });
      await auth.audit(ctx.pool, {
        actorId: session.user.id,
        action: 'admin.capability_secrets_updated',
        target: `capability:${itemId}`,
        // 审计只记「改了哪几个槽 + 作用域」：**绝不含值**，连长度都不记（长度也是信息）。
        details: { scope, fde_id: fdeId, names: Object.keys(body?.values ?? {}), changed: out.changed },
      });
      return sendJson(res, 200, { item: { id: itemId, slots: await market.listSlots({ pool: ctx.pool, itemId }) } });
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }
  const adminMarketItemMatch = pathname.match(/^\/api\/admin\/market\/items\/([^/]+)$/);
  if (adminMarketItemMatch) {
    const itemId = decodeUuid(adminMarketItemMatch[1]);
    if (req.method === 'GET') {
      // 详情才带 manifest / files / warnings；列表**不取 bytea**（50 条 × 2 MiB 会先把进程吃掉）。
      return sendJson(res, 200, { item: await market.getAdminItem({ pool: ctx.pool, itemId }) });
    }
    if (req.method === 'PUT') {
      requireJson(req);
      const body = await readJsonBody(req, market.BUNDLE_MAX_BODY_BYTES);
      const item = await market.updateItem({ pool: ctx.pool, actorId: session.user.id, itemId, fields: body });
      await auth.audit(ctx.pool, {
        actorId: session.user.id,
        action: 'admin.capability_updated',
        target: `capability:${item.slug}`,
        // `has_bundle` 区分「只改了文案」与「出了新版」——事后追查「这台 FDE 为什么版本不同」时只看得到版本
        // 号，那是不够的，还得知道哪一次请求真正带了包。
        details: { id: item.id, version: item.version, has_bundle: body?.bundle != null },
      });
      return sendJson(res, 200, { item });
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }

  // FDE 容器 provision（调查结论：portal serve 进程有 config.dockerHost，client 懒建，端点可实现）
  const adminProvisionMatch = pathname.match(/^\/api\/admin\/fdes\/([^/]+)\/provision$/);
  if (adminProvisionMatch && req.method === 'POST') {
    const fdeName = decodeURIComponent(adminProvisionMatch[1]);
    if (!projects.validateFdeName(fdeName).ok) {
      throw new HttpError(400, 'validation_failed', 'fde_name 非法', { en: 'invalid fde_name', details: { field: 'fde_name' } });
    }
    requireJson(req);
    const body = await readJsonBody(req);
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
      throw new HttpError(400, 'validation_failed', 'fde_name 非法', { en: 'invalid fde_name', details: { field: 'fde_name' } });
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
      const body = await readJsonBody(req);
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

  // issue #800：整表读每 FDE 的「本周期已用金额」（用户列表「周期 / 用量」列）。整表**一次**网关调用，
  // 不是每人一次。网关不可达 ⇒ LlmGatewayError ⇒ 既有映射回 5xx；前端那一列自己降级成「—」+ 重试，
  // **用户列表本身不受影响**（那一列是独立的一次加载）。
  if (pathname === '/api/admin/llm/key-usage' && req.method === 'GET') {
    return sendJson(res, 200, await llm.listFdeKeyUsage(ctx.pool, { gateway: ctx.llmGateway }));
  }

  // issue #719：每 FDE 周期额度（USD / 周期）。两个独立 matcher，**不改上面那个老 /llm 正则**（避免回归）；
  // 鉴权继承 handleAdminApi 的 requireAdmin，fde_name 语法复用 decodeAdminFdeName。
  const adminFdeBudgetMatch = pathname.match(/^\/api\/admin\/fdes\/([^/]+)\/llm\/budget$/);
  if (adminFdeBudgetMatch) {
    const fdeName = decodeAdminFdeName(adminFdeBudgetMatch[1]);
    if (req.method === 'GET') {
      const quota = await llm.getFdeBudget(ctx.pool, { fdeName, gateway: ctx.llmGateway });
      return sendJson(res, 200, { quota });
    }
    if (req.method === 'PUT') {
      requireJson(req);
      const body = await readJsonBody(req);
      // 额度/周期直接交给 setFdeBudget 校验（金额：null 或 ≤ 上限的有限正数；周期：白名单 '1d'/'1mo'）；
      // 非法值⇒ LlmError validation_failed→ 400。budget_period 缺省⇒ setFdeBudget 内部默认 '1mo'。
      const quota = await llm.setFdeBudget(ctx.pool, {
        fdeName,
        budgetUsd: body?.budget_usd,
        budgetPeriod: body?.budget_period,
        gateway: ctx.llmGateway,
      });
      return sendJson(res, 200, { quota });
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }

  const adminFdeUsageMatch = pathname.match(/^\/api\/admin\/fdes\/([^/]+)\/llm\/usage$/);
  if (adminFdeUsageMatch) {
    const fdeName = decodeAdminFdeName(adminFdeUsageMatch[1]);
    if (req.method === 'GET') {
      const rawDays = url.searchParams.get('days');
      let days = 30;
      // 建议 5：只要带了 `days` 参数（含空串 `?days=`）就必须是 1–90 整数；只有完全不写才走默认 30。
      if (rawDays !== null) {
        days = Number(rawDays);
        if (!Number.isInteger(days) || days < 1 || days > 90) {
          throw new HttpError(400, 'validation_failed', 'days 必须为 1–90 的整数', { en: 'days must be an integer from 1 to 90', details: { field: 'days' } });
        }
      }
      const usage = await llm.getFdeBudgetUsage(ctx.pool, { fdeName, gateway: ctx.llmGateway, days });
      return sendJson(res, 200, usage);
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
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

  // issue #727（契约 portal.md §4.22）：管理台按 FDE 只读浏览会话记录与项目文件。
  // 7 条全部只读；handler 只是薄封装（目标 FDE 解析 / 牢笼 / 审计都在 admin-seat-content.js）。
  const adminFdeDirsMatch = pathname.match(/^\/api\/admin\/fdes\/([^/]+)\/dirs$/);
  if (adminFdeDirsMatch) {
    const fdeName = decodeAdminFdeName(adminFdeDirsMatch[1]);
    requireAdminReadMethod(req);
    const data = await seatContent.listFdeDirs({
      pool: ctx.pool, ctx, fdeName, actorId: session.user.id, log: ctx.log,
    });
    return sendJson(res, 200, data);
  }
  const adminFdeSessionsMatch = pathname.match(/^\/api\/admin\/fdes\/([^/]+)\/sessions$/);
  if (adminFdeSessionsMatch) {
    const fdeName = decodeAdminFdeName(adminFdeSessionsMatch[1]);
    requireAdminReadMethod(req);
    const data = await seatContent.listFdeSessions({
      pool: ctx.pool, ctx, fdeName, actorId: session.user.id,
      query: url.searchParams, log: ctx.log,
    });
    return sendJson(res, 200, data);
  }
  // 详情 / 历史 / 折叠原文：`sessionId` 不做形状预判——`fetchSession` 对非法 UUID
  // 已经给 404，这里再判一次只会多一个分流（同一形状的 404 不靠重复判断保证）。
  const adminFdeSessionMatch = pathname.match(/^\/api\/admin\/fdes\/([^/]+)\/sessions\/([^/]+)$/);
  if (adminFdeSessionMatch) {
    const fdeName = decodeAdminFdeName(adminFdeSessionMatch[1]);
    requireAdminReadMethod(req);
    const data = await seatContent.getFdeSession({
      pool: ctx.pool, ctx, fdeName, actorId: session.user.id,
      sessionId: adminFdeSessionMatch[2], query: url.searchParams, log: ctx.log,
    });
    return sendJson(res, 200, data);
  }
  const adminFdeSessionHistoryMatch =
    pathname.match(/^\/api\/admin\/fdes\/([^/]+)\/sessions\/([^/]+)\/events\/history$/);
  if (adminFdeSessionHistoryMatch) {
    const fdeName = decodeAdminFdeName(adminFdeSessionHistoryMatch[1]);
    requireAdminReadMethod(req);
    const data = await seatContent.getFdeSessionHistory({
      pool: ctx.pool, ctx, fdeName, actorId: session.user.id,
      sessionId: adminFdeSessionHistoryMatch[2], query: url.searchParams, log: ctx.log,
    });
    return sendJson(res, 200, data);
  }
  const adminFdeSessionFoldedMatch =
    pathname.match(/^\/api\/admin\/fdes\/([^/]+)\/sessions\/([^/]+)\/folded\/(\d+)$/);
  if (adminFdeSessionFoldedMatch) {
    const fdeName = decodeAdminFdeName(adminFdeSessionFoldedMatch[1]);
    requireAdminReadMethod(req);
    const data = await seatContent.getFdeFolded({
      pool: ctx.pool, ctx, fdeName, actorId: session.user.id,
      sessionId: adminFdeSessionFoldedMatch[2], round: adminFdeSessionFoldedMatch[3],
      query: url.searchParams, log: ctx.log,
    });
    return sendJson(res, 200, data);
  }
  const adminFdeFilesTreeMatch = pathname.match(/^\/api\/admin\/fdes\/([^/]+)\/files\/tree$/);
  if (adminFdeFilesTreeMatch) {
    const fdeName = decodeAdminFdeName(adminFdeFilesTreeMatch[1]);
    requireAdminReadMethod(req);
    const data = await seatContent.getFdeFileTree({
      pool: ctx.pool, ctx, fdeName, actorId: session.user.id,
      query: url.searchParams, log: ctx.log,
    });
    return sendJson(res, 200, data);
  }
  const adminFdeFileMatch = pathname.match(/^\/api\/admin\/fdes\/([^/]+)\/file$/);
  if (adminFdeFileMatch) {
    const fdeName = decodeAdminFdeName(adminFdeFileMatch[1]);
    requireAdminReadMethod(req);
    return handleAdminFdeFile(req, res, ctx, session, fdeName, url);
  }

  return sendJson(res, 404, errorBody('not_found', 'not found'));
}

/** 路径参数 :fdeName 的解码 + 语法校验（口径照 admin 面既有端点：非法语法 400 validation_failed）。 */
function decodeAdminFdeName(raw) {
  let fdeName;
  try {
    fdeName = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'validation_failed', 'fde_name 非法', { en: 'invalid fde_name', details: { field: 'fde_name' } });
  }
  if (!projects.validateFdeName(fdeName).ok) {
    throw new HttpError(400, 'validation_failed', 'fde_name 非法', { en: 'invalid fde_name', details: { field: 'fde_name' } });
  }
  return fdeName;
}

/**
 * 管理台只读面的方法闸门（issue #727）：口径与同族 admin 端点逐字相同（非 GET ⇒ 405
 * `method_not_allowed`）——抽成一个函数而不是贴 7 遍，是为了不出现「第六条忘了写」的分歧。
 */
function requireAdminReadMethod(req) {
  if (req.method !== 'GET') {
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }
}

/**
 * GET /api/admin/fdes/:fdeName/file（issue #727）：`mode=json|stream|download`。
 * 与用户面 `handleFilePreview` 同一条写出路径（DTO 自带 status + headers + stream），
 * 但不做 `previewmiss` 埋点：那是工作台用户的面板埋点，管理员浏览不该污染它。
 */
async function handleAdminFdeFile(req, res, ctx, session, fdeName, url) {
  const mode = url.searchParams.get('mode') ?? 'json';
  const data = await seatContent.getFdeFile({
    pool: ctx.pool, ctx, fdeName, actorId: session.user.id,
    query: url.searchParams, range: req.headers.range ?? null, log: ctx.log,
  });
  if (mode !== 'stream' && mode !== 'download') return sendJson(res, 200, data);
  res.writeHead(data.status, data.headers);
  if (data.stream) {
    data.stream.on('error', () => res.destroy());
    // #726 复审：客户端提前断开时 res 先毁，pipe 只会 unpipe、不会停源流；
    // 源流会停在半途握着 fd。随 res 'close' 毁掉源流 ⇒ FileHandle 关一次。
    res.on('close', () => data.stream.destroy());
    data.stream.pipe(res);
  } else {
    res.end(); // 416：只有头没有体
  }
  return undefined;
}

/** 按 fde_name 解析用户；不存在 → 404 `not_found`（复用 admin 面现有码，不新造）。 */
async function resolveAdminFde(ctx, fdeName) {
  const fde = await portalloc.resolveFdeByName(ctx.pool, fdeName);
  if (!fde || !fde.id) {
    throw new admin.AdminError('not_found', `FDE「${fdeName}」不存在`, {
      httpStatus: 404, details: { field: 'fde_name' }, en: `FDE "${fdeName}" does not exist`,
    });
  }
  return fde;
}

/**
 * POST /api/admin/mail/test（issue #449 管理台切片，契约 portal.md §4.12）：用**已保存的配置**真发一封测试信。
 *
 * 顺序（每一步都能被单测打红）：
 *   ① `to` 必填 + 过邮箱正则（与建号同一口径）⇒ 否则 400 `validation_failed`；
 *   ② 限流：每管理员 5 次/小时（`mailtest:<adminId>`）⇒ 超限 429 `rate_limited` + `Retry-After`；
 *   ③ 通道未启用（无行 / `transport='disabled'` / `MAIL_TRANSPORT=disabled` 急停）⇒ 409 `mail_not_configured`，
 *      **此时不烧配额**（还没配好就先把额度用光不合理）；
 *   ④ 发信失败 ⇒ 502 `email_send_failed`（`retryable:true`，`details` 只放 reason 摘要，**不含口令/正文**）。
 *
 * 正文是「这是测试信 + 时间戳」，**不含验证码**——运维手点的探活信不该带任何凭据。
 */
async function handleAdminMailTest(req, res, ctx, session) {
  requireJson(req);
  const body = await readJsonBody(req);
  const raw = body?.to;
  if (!mailSettings.isEmail(raw)) {
    throw new HttpError(400, 'validation_failed', 'to 必须是有效邮箱地址', { en: 'to must be a valid email address', details: { field: 'to' } });
  }
  const to = raw.trim();

  const limiterKey = `mailtest:${session.user.id}`;
  const gate = ctx.mailTestLimiter.check(limiterKey);
  if (!gate.allowed) {
    throw new HttpError(429, 'rate_limited', '测试发信过于频繁，请稍后再试', {
      en: 'Test sending is too frequent, please try again later',
      retryable: true,
      headers: { 'Retry-After': String(gate.retryAfterSeconds) },
    });
  }

  // 发信端口：SMTP 配置存 DB，`get()` 是 60s 缓存后的结果（急停/未配置/配了一半 ⇒ disabled）。
  const mailer = await ctx.mailerProvider.get();
  if (!mailer.enabled) {
    throw new HttpError(
      409,
      'mail_not_configured',
      '邮件通道未启用：请先在管理台配置 SMTP（transport=smtp 且填好主机与发件人）后再测试',
      { en: 'Mail channel is not enabled: configure SMTP in the admin console first (transport=smtp with the host and sender filled in), then test', retryable: false },
    );
  }

  // 只有真会发信才计次（见 ③）：这一条同时防「同一管理员并发点测试」把额度当并发数用。
  ctx.mailTestLimiter.recordFailure(limiterKey);

  const at = new Date().toISOString();
  const sent = await mailer.send(mailSettings.buildTestMessage({ to, at }));
  if (!sent.ok) {
    const reason = typeof sent.reason === 'string' && sent.reason !== '' ? sent.reason : 'send_failed';
    await auth.audit(ctx.pool, {
      actorId: session.user.id,
      action: 'admin.mail_test_failed',
      target: 'mail_settings',
      // 只记 reason 摘要：**不含口令、不含正文**（正文里有时间戳与收件人，没有价值且会扩散）。
      details: { to, at, reason },
    }).catch(() => {});
    throw new HttpError(502, 'email_send_failed', '测试邮件发送失败，请检查 SMTP 配置与网络', {
      en: 'Test email failed to send, please check the SMTP configuration and network',
      retryable: true,
      details: { reason },
    });
  }

  await auth.audit(ctx.pool, {
    actorId: session.user.id,
    action: 'admin.mail_test_sent',
    target: 'mail_settings',
    details: { to, at },
  });
  return sendJson(res, 200, { ok: true, to, at });
}

// ---------------------------------------------------------------------------
// 管理台证书生命周期（issue #456 M1，契约 portal.md §4.13）
// ---------------------------------------------------------------------------

/**
 * 证书上传请求体的**整体**上限。
 *
 * 为什么不是默认的 JSON 请求体上限（`DEFAULT_JSON_BODY_LIMIT`，默认 64 KiB）：两份 PEM **各**允许 64 KiB（工单 §4），
 * 合起来再加 JSON 转义就超过 64 KiB —— 用默认闸会在 `readJsonBody` 里先变成 413，
 * 而工单要求的是「超 64 KiB ⇒ 400 `validation_failed` + `details.field`」。所以：
 * 体级闸放到 256 KiB（宽松，只防离谱体积），**字段级 64 KiB 判据在 `tls-cert.js#validateUpload`**。
 */
const TLS_UPLOAD_BODY_LIMIT = 256 * 1024;

/** 证书目录（`<dynamic>/certs` 的父目录）：与 routes.yml / llm-routes.yml 同一个动态目录。 */
function tlsDynamicDir(ctx) {
  return ctx.config.traefikDynamicDir;
}

/** GET / PUT / verify / rollback 共用的响应形状（逐键白名单，见 `tls-cert.js#describeTls`）。 */
async function tlsStatusPayload(ctx) {
  return tlsCert.describeTls({
    dynamicDir: tlsDynamicDir(ctx),
    adminHost: ctx.config.adminHost,
    live: ctx.tlsLive,
  });
}

/** 429 信封（与 `handleAdminMailTest` 同一个形状）。 */
function tlsRateLimited(gate, message) {
  return new HttpError(429, 'rate_limited', message, {
    retryable: true,
    headers: { 'Retry-After': String(gate.retryAfterSeconds) },
  });
}

/**
 * GET /api/admin/tls：盘上证书元数据 + 覆盖判定 + **最近一次真机校验结果**（只读缓存，不主动连）+ 有无可回滚备份。
 *
 * 不写审计（纯读，每次进管理页都会调）。无证书也是 `200` + `configured:false`（未配置是正常态，不是 404）。
 */
async function handleAdminTlsGet(req, res, ctx) {
  return sendJson(res, 200, await tlsStatusPayload(ctx));
}

/**
 * PUT /api/admin/tls：上传/更新证书。顺序固定：
 *   校验（PEM / 配对 / 未过期 / 覆盖 adminHost / confirmDomains）→ 限流 → 备份 → 写 crt → 写 key
 *   → `materializeTlsAssets()`（重写 tls.yml = 唯一 reload 把手）→ 台账 → 审计。
 *
 * **校验失败零副作用**：所有校验都在写盘之前（盘上一个字节都不动，单测有判据）。
 * 限流**只在真会落盘时才计次**（同 mailTest 的口径：校验失败不烧配额）。
 */
async function handleAdminTlsPut(req, res, ctx, session) {
  requireJson(req);
  const body = await readJsonBody(req, TLS_UPLOAD_BODY_LIMIT);

  const result = tlsCert.validateUpload({
    certPem: body?.certPem,
    keyPem: body?.keyPem,
    adminHost: ctx.config.adminHost,
    confirmDomains: body?.confirmDomains,
  });
  if (!result.ok) {
    throw new tlsCert.TlsCertError(result.code, result.message, {
      httpStatus: 400,
      details: result.details,
    });
  }

  const limiterKey = `tlsupload:${session.user.id}`;
  const gate = ctx.tlsUploadLimiter.check(limiterKey);
  if (!gate.allowed) throw tlsRateLimited(gate, '证书上传过于频繁，请稍后再试');
  ctx.tlsUploadLimiter.recordFailure(limiterKey);

  const written = await tlsCert.writeCertificateAssets({
    dynamicDir: tlsDynamicDir(ctx),
    certPem: body.certPem,
    keyPem: body.keyPem,
    log: ctx.log,
  });

  // 台账：**盘是真相**，所以 DB 写失败不回滚已生效的证书（回滚才是更坏的后果），只记 error。
  try {
    await tlsCert.recordCertificateRow(ctx.pool, {
      cert: result.cert,
      kind: 'upload',
      uploadedBy: session.user.id,
    });
  } catch (err) {
    ctx.log?.error?.(`[tls] 证书已写盘但台账写入失败：${err?.message ?? err}`);
  }

  // 上一张证书的校验结果对这张不成立 —— 重置成 unknown（留着就是撒谎）。
  ctx.tlsLive = { status: 'unknown', checkedAt: null };

  await auth.audit(ctx.pool, {
    actorId: session.user.id,
    action: 'admin.tls_updated',
    target: 'tls_certificate',
    // 只有元数据：**不放 PEM、不放私钥**（红线）。
    details: {
      subjectCN: result.cert.subjectCN,
      sans: result.cert.sans,
      fingerprintSha256: result.cert.fingerprintSha256,
      notAfter: result.cert.notAfter,
      backupCreated: written.backup !== null,
      // #462：链形态的**非阻断**告警（只有非空时才写，老行形状不变）。零 DDL：只进 audit.details（jsonb）。
      ...(Array.isArray(result.chainWarnings) && result.chainWarnings.length > 0
        ? { chainWarnings: result.chainWarnings }
        : {}),
    },
  }).catch(() => {});

  return sendJson(res, 200, await tlsStatusPayload(ctx));
}

/**
 * POST /api/admin/tls/inspect：**解析但不落盘**（契约 portal.md §4.13-3a）。
 *
 * 零副作用：不写盘、不写 DB、不写审计、不动 `tlsLive`、**不烧上传配额**（单独一档宽松限流）。
 * 判据只有「形态与配对」：`keyPem` 省略 ⇒ `keyMatches:null`；不配对 / 不覆盖 adminHost / 已过期
 * 都**不报错**（各回 `keyMatches:false` / `coverage.covered:false` / `warnings`），让 UI 自己说。
 */
async function handleAdminTlsInspect(req, res, ctx, session) {
  requireJson(req);
  // 体级闸与上传同档（两份 PEM 各 64 KiB + JSON 转义放不进默认的 64 KiB）。
  const body = await readJsonBody(req, TLS_UPLOAD_BODY_LIMIT);

  const limiterKey = `tlsinspect:${session.user.id}`;
  const gate = ctx.tlsInspectLimiter.check(limiterKey);
  if (!gate.allowed) throw tlsRateLimited(gate, '证书解析过于频繁，请稍后再试');
  ctx.tlsInspectLimiter.recordFailure(limiterKey);

  return sendJson(res, 200, tlsCert.inspectCertificate({
    certPem: body?.certPem,
    keyPem: body?.keyPem,
    adminHost: ctx.config.adminHost,
  }));
}

/**
 * POST /api/admin/tls/verify：对管理台入口做一次**真 TLS 握手**，比对指纹。
 *
 * 连**默认网关**（从 `/proc/net/route` 读）+ `servername=adminHost`：portal 容器解析不了
 * `admin.<伞域>`（实测 ENOTFOUND），而证书 SAN 也不含 IP（事实③④）。`rejectUnauthorized:false`，
 * 判据只看 `fingerprint256`。
 *
 * 盘上无证书 ⇒ `live.status='unreachable'` + `error='no_certificate'`（没有可比的基准，不是「连不上」）。
 * 不写审计（探针不是变更）。
 */
async function handleAdminTlsVerify(req, res, ctx, session) {
  requireJson(req);
  const limiterKey = `tlsverify:${session.user.id}`;
  const gate = ctx.tlsVerifyLimiter.check(limiterKey);
  if (!gate.allowed) throw tlsRateLimited(gate, '证书校验过于频繁，请稍后再试');
  ctx.tlsVerifyLimiter.recordFailure(limiterKey);

  const active = await tlsCert.readActiveCertificate({ dynamicDir: tlsDynamicDir(ctx) });
  let live;
  if (!active.configured) {
    live = { status: 'unreachable', checkedAt: new Date().toISOString(), error: 'no_certificate' };
  } else {
    live = await tlsCert.verifyLiveCertificate({
      expectedFingerprint: active.cert.fingerprintSha256,
      adminHost: ctx.config.adminHost,
      adminPort: ctx.config.adminPort,
      // 测试可注入假 `tls.connect` / 假路由表（单测不碰真网络、不依赖本机路由）。
      ...(ctx.tlsConnect ? { connect: ctx.tlsConnect } : {}),
      routePath: ctx.tlsRoutePath,
    });
  }
  ctx.tlsLive = live;
  return sendJson(res, 200, await tlsStatusPayload(ctx));
}

/**
 * POST /api/admin/tls/rollback：从 `certs/prev/` 还原上一代 + 重写 `tls.yml` + 台账（`kind='rollback'`）+ 审计。
 * prev 不存在 ⇒ `404 tls_no_previous`（本单允许新增的码）。
 */
async function handleAdminTlsRollback(req, res, ctx, session) {
  requireJson(req);
  const limiterKey = `tlsupload:${session.user.id}`;
  const gate = ctx.tlsUploadLimiter.check(limiterKey);
  if (!gate.allowed) throw tlsRateLimited(gate, '回滚过于频繁，请稍后再试');
  ctx.tlsUploadLimiter.recordFailure(limiterKey);

  const out = await tlsCert.rollbackCertificateAssets({
    dynamicDir: tlsDynamicDir(ctx),
    log: ctx.log,
  });

  try {
    await tlsCert.recordCertificateRow(ctx.pool, {
      cert: out.cert,
      kind: 'rollback',
      uploadedBy: session.user.id,
    });
  } catch (err) {
    ctx.log?.error?.(`[tls] 回滚已生效但台账写入失败：${err?.message ?? err}`);
  }

  ctx.tlsLive = { status: 'unknown', checkedAt: null };

  await auth.audit(ctx.pool, {
    actorId: session.user.id,
    action: 'admin.tls_rolled_back',
    target: 'tls_certificate',
    details: {
      subjectCN: out.cert?.subjectCN ?? null,
      sans: out.cert?.sans ?? [],
      fingerprintSha256: out.cert?.fingerprintSha256 ?? null,
      notAfter: out.cert?.notAfter ?? null,
      // 回滚**不产生**新备份（prev 仍是那一代）⇒ 恒 false。
      backupCreated: false,
    },
  }).catch(() => {});

  return sendJson(res, 200, await tlsStatusPayload(ctx));
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
        { en: `limit must be an integer from 1 to ${max} (upper bound on idle-segment entries, default ${portalloc.PREVIEW_USAGE_FREE_LIMIT_DEFAULT})`, details: { field: 'limit' } });
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
  const body = await readJsonBody(req);
  const blockStart = body?.block_start;
  if (!Number.isInteger(blockStart) || !isPreviewPortInPool(blockStart) || !isAlignedPreviewBlockStart(blockStart)) {
    throw new HttpError(400, 'validation_failed',
      `block_start 必须是号池 ${PREVIEW_PORT_POOL_START}–${portalloc.PREVIEW_PORT_POOL_END} 内、按 ${PREVIEW_PORT_COUNT} 对齐的整数块起点`
      + `（合法值：${PREVIEW_PORT_POOL_START}、${PREVIEW_PORT_POOL_START + PREVIEW_PORT_COUNT}、…）`,
      { en: `block_start must be an integer block start within the pool ${PREVIEW_PORT_POOL_START}-${portalloc.PREVIEW_PORT_POOL_END}, aligned to ${PREVIEW_PORT_COUNT}` + ` (valid values: ${PREVIEW_PORT_POOL_START}, ${PREVIEW_PORT_POOL_START + PREVIEW_PORT_COUNT}, ...)`, details: { field: 'block_start' } });
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
  const body = await readJsonBody(req);
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
  const body = await readJsonBody(req);
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
  await readJsonBody(req); // 无体（空 JSON {}）；仍读掉请求体保持行为一致
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
    notifyQueueUpdate: async (sessionId, blocked = null, deliveredRunId = null, delivered = null) => {
      const rows = await queuedInputs.snapshotQueuedInputs(ctx.pool, sessionId);
      internal.notifyQueueUpdate(sessionId, rows, blocked, deliveredRunId, delivered);
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
  const body = await readJsonBody(req, MESSAGE_BODY_LIMIT);
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
  const body = await readJsonBody(req, MESSAGE_BODY_LIMIT);
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
        throw new HttpError(409, 'llm_not_configured', '该 FDE 未配置 LLM 上游，请在管理台配置', { en: 'This FDE has no LLM upstream configured; please configure it in the admin console' });
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
  await readJsonBody(req); // 无体（空 JSON {}）
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
      throw new HttpError(400, 'validation_failed', 'Last-Event-ID 必须为非负整数', { en: 'Last-Event-ID must be a non-negative integer' });
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
  /** 快照帧（**先算后发**：算在本块里，发在 goLive 之后——顺序承重，见下面那段注）。 */
  let snapshotFrames = [];
  if (lastEventId != null) {
    const replay = await ctx.pool.query(
      // #502：**碎片（`assistant_delta`/`reasoning_delta`/`tool_call_delta`）不再从库里补发**（已不落库），
      // `partial_output` 那一行也**不在这里发**：它改由下面的快照通路负责。
      // ⚠ `type <> 'partial_output'` 在形态 M 之后是**防御性保留**：新代码不再写这种行
      //（正文改读 `round_end.final_text` / `run_end.partial_text`），但**旧库里有存量**（迁移 0033
      // 只清残留、不保证清完）⇒ 不排掉就会“一行真事件 + 一份快照”两套正文同屏（审计 B-7）。
      `SELECT seq, ts, run_id, type, payload FROM run_events
        WHERE session_id = $1 AND seq > $2 AND type <> 'partial_output'
        ORDER BY seq ASC`,
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
    // issue #502 D-5（形态 M）：碎片不落库之后，「断线期间流式过的那段正文」只有一个来源：
    // **本进程的缓冲**（已终态的那半截不在这里：它已进 `run_end.partial_text`，刷新时走历史投影）。
    //
    // ⚠ **审计第 1 条：快照帧必须在 `sessionClientGoLive` **之后**发**（原来在它之前 ⇒ 正文会重复一遗）。
    // 机制：补发窗口内到达的同轮碎片既进了正文缓冲（它是 `partialOutputs` 写手），也进了 hub 的
    // `rec.buffer`；而 goLive 对 seq-less 帧的过滤条件是 `ev.seq != null && ev.seq <= sinceSeq`
    //（`internal.js` D-2 ①：碎片 `seq=null` **永不被过滤**，那是故意修的另一个 bug）。于是「快照先、
    // flush 后」就是：快照已含全文 → 再把同一批碎片当**增量**追在快照后面 ⇒ 界面上同一段正文两遗
    //（前端 `partial_output` 是覆盖式、`assistant_delta` 是追加，两个语义不能倒这个序）。
    // 先 flush 后快照就把顺序理顺了：碎片先落进气泡，快照随后**盖**上去（覆盖式，且它带的是全量）。
    // 代价是「flush 之后、快照之前」这个同进程窗口里直接转 SSE 的新碎片会排在快照之前——不坑：
    // U3 写侧是 `bufferTx.commit()` 在前、`notifySessionEvents` 在后 ⇒ 快照读到的总是已转发的超集，
    // 而覆盖式赋值对超集就是正确的。
    // 这里只把帧的生成留在补发块里（`lastEventId != null` 才发，首连不补发是 §5.2.3 的红线），
    // 真正的写推到 goLive 之后。
    snapshotFrames = rec.resync || cleaned ? [] : buildPartialSnapshotFrames({ sessionId });
  } else {
    internal.writeSseComment(res, 'connected'); // 首连不补发历史（§5.2.3 红线不变 ⇒ 也不发快照）
  }
  if (cleaned) return; // 补发期间断开：连接已关，不再 goLive（rec 已摘除）/不再起心跳
  internal.sessionClientGoLive(sessionId, rec, replayedSeq);
  if (rec.resync) return; // 已判定需重同步（res.end 已调用）：跳过快照、ping 与心跳循环
  // **顺序承重**：快照帧必须在上面的 flush **之后**（见上面那段注），否则同一段正文会发两遗。
  for (const f of snapshotFrames) {
    if (rec.resync) break;
    if (cleaned) return; // 转 live 之后断开：rec 已摘除，不再写
    // **不带 id**：快照帧不是库里的一行（内存帧根本没有 seq），让它污染浏览器 Last-Event-ID
    // 就会把补发游标推进到一个不存在的 seq 上（下一轮重连反而丢事件）。
    internal.writeSseEvent(res, PARTIAL_OUTPUT_TYPE, JSON.stringify(f), null);
  }
  if (cleaned) return;
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
export const HISTORY_EVENT_TYPES = new Set([
  // issue #502 D-7：`tool_call_delta` 从本白名单**摘掉**（三类碎片里此前只有它在册）。
  // 理由：① 它已不再落库（`internal.js` 写入侧按引擎 `eventTierOf` 拦住），存量也由迁移 0033 清掉
  //   ⇒ 留在集合里是一个**永不命中**的谓词；② 它的**成型副本**在 `tool_use.input`，工具卡片的入参
  //   就取自那里（#279：实时与刷新归并成同一张卡），不拿逐字碎片回放它；
  //   ③ 另两类 `assistant_delta` / `reasoning_delta` 本来就不在册（#300 起就不下发，免得与正文
  //   锚点重复），本单无需改动。前端 `useEventStream.ts` 的 `HISTORY_REPLAY_TYPES` **同步摘**
  //   （`event-surface-contract.test.js` 的 S4 要求两个集合逐项相等，只摘一边就红）。
  'tool_use', 'tool_result', 'judge',
  'round', 'round_start', 'round_end', 'attempt', 'recovering', 'recovered',
  'compaction', 'final_guard', 'forced_final',
  // issue #288（缺陷 B）：portal 在 release-requeue 分支合成的**宿主事件**（attempt 被杀并重排）。
  // 它实时走 session SSE 推给浏览器，**不进白名单则刷新后消失**——与本白名单要修的毛病同构，故列入。
  'attempt_killed',
  // issue #288（缺陷 C）：崩溃恢复时挂起工具**没被重放**（引擎 `orchestrator.js:2605-2614` 发出，
  // `requiresHostDecision:true`）。同一个坑另发一次：runner 经 U3 落进 run_events、SSE 实时推得到，
  // **不进本白名单就「实时看得见、刷新后消失」**——它出现的时机正是用户刷新页面来
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
  // issue #438 切片 B（erix-agent 0.29.0）：`LoopEvent` 联合类型从 16 类长到 **19 类**，这两类是
  // 本站裁定「进时间线」的那部分（第三类 `config_override_conflict` 与联合外的
  // `continuity_injection_skipped` **显式豁免**，理由在 `portal/test/event-surface-contract.test.js`
  // 的豁免表与 `useEventStream.ts` 的 EVENT_TYPES 段）。三处集合仍各自独立存亡（#288）：
  // 只加一边就是「实时收不到」或「刷新后消失」。
  'compaction_deferred', 'budget_below_working_set',
  // issue #371-A：`persistence_error`（引擎 erix-agent#461 起的落盘失败告警，带 `fatal`）此前
  // **库里存着、读不出来**：写入侧不过白名单（`internal.js` 直接 INSERT），展示侧不过 ⇒ 刷新后
  // 一条都不提。而这条事件最重要的时刻，正是用户刷新来看「我这轮到底存下没」的那一刻。
  // 前端只把 `fatal === false` 刷成**中性**分隔行（致命那条由 `run_end` 的 `persistence_failed`
  // 红色面负责，不在这里重复报）。与前端 `useEventStream.ts` 的 `EVENT_TYPES` +
  // `HISTORY_REPLAY_TYPES` 是**三处独立存亡的集合**（#288 教训），本单同改。
  'persistence_error',
  // issue #442（erix-agent 0.30.0）：`LoopEvent` 联合类型 19 类 → **27 类**。8 个新类型里本站只把
  // `user_turn_guard_unrecoverable` 裁定为**进时间线**（其余 5 个新类型 + `continuity_injection_skipped`
  // 是豁免，`forced_final` 早已在册）：它是随后那次上游 400 的**唯一归因信号**（引擎在请求发出之前就发它），
  // 用户刷新来看「这次怎么失败了」时必须看得到。与前端 `EVENT_TYPES` + `HISTORY_REPLAY_TYPES` 是
  // **三处独立存亡的集合**（#288 教训），本单同改。
  'user_turn_guard_unrecoverable',
  // issue #243：`textualized_tool_call`（**本站自造**，由 `internal.js#finishRun` 在终态事务里合成）
  // ——「这次终局正文是一段被文本化的工具调用」= 交付报告可能没生成。它**必须进本白名单**：
  // 上游 erix-agent #182 的教训就是「实时看得见、刷新后消失」，而这条事件说的恰恰是
  // 「用户刷新来看这次交付了什么」的那一刻。三处集合独立存亡（#288 老坑）：本表 + 前端
  // `EVENT_TYPES` + 前端 `HISTORY_REPLAY_TYPES`，只加一边就得到两种可见性不一致。
  // 判据：`portal/test/textualized-toolcall.test.js`（源码级 + 行为级各一条，行为级就在本端点）。
  'textualized_tool_call',
]);
export const HISTORY_EVENT_DEFAULT_LIMIT = 500;
export const HISTORY_EVENT_MAX_LIMIT = 2000;
const HISTORY_PAYLOAD_STRING_CAP = 2000;
// issue #300：中止/失败 run 的**只读正文重建**。runner 的 catch 固定 `final_text: ''` ⇒ 该 run 在
// `messages` 里**零助手锚点**，而正文区本来就只从锚点渲染 ⇒ 界面上这次 run 一片空白（实测标本
// run 72e2577d / 会话 1ead0b1a）。
// issue #502 形态 M 的取数：不再聚合碎片（那 877,155 行已停写），而是读**已有的两处 durable 正文**
// ⇒ `round_end.payload.final_text`（已完成轮次）+ `run_end.payload.partial_text`（停止时那半轮）。
// 硬口径：**不落库、不进 SSE、不进前端 EVENT_TYPES/HISTORY_REPLAY_TYPES**（它是响应期合成的，
// 进集合就变成「实时一条 + 历史一条」重复），也**不进** HISTORY_EVENT_TYPES（三类碎片同理
// 不能进白名单，否则同一段正文来两遍）。前端消费它时带 `placeholder` 支持（两处正文都没有 ⇒
// 一行中性提示，#278 底线）。
const PARTIAL_OUTPUT_TYPE = 'partial_output';
// issue #502 形态 M：**投影上限 65536 字符 + `truncated` 布尔**（取代旧的 `PARTIAL_OUTPUT_TEXT_CAP = 2000`）。
// 为什么不是 2000：那道闸会咬「刷新后逐字完整」这条红线（#278/#300 的既有口径：停止前看到的
// 不能比停止前少）——dev 真库现查 `round_end.final_text` **最长 31,707 字符**（均值 467），2000 会把
// 中位以上的正文都砍掉。为什么不是「无限」：本端点的响应直接进浏览器 JSON，一条失控的长稿不能
// 拖死整个会话视图；65536 ≈ 真库最长值的**两倍余量**且是 2 的幂（口径好记、算术可核对）。
// 超上限 ⇒ `truncated: true`，标记由前端出（StreamPanel），本端点**不塞**「…（已截断）」那种文本
// （那是 `truncateHistoryPayload` 给真实事件用的口径，合成项要能被前端判定，就得给布尔）。
const PARTIAL_PROJECTION_TEXT_CAP = 65536;
// issue #236：**终态分隔条**的合成类型。名字**故意不叫 `run_end`**：`run_end` 是实时 SSE 的运行态
// 语义事件，绝不能进历史白名单（#217 / #236 的红线）——它是响应期投影出来的展示项，与
// `partial_output` 同一类存在（不落库、不进 SSE、两个前端集合都不加）。
const RUN_TERMINATION_TYPE = 'run_termination';

/**
 * issue #502 D-5（形态 M）：**断线补发的快照通路**（碎片不落库之后，那段未完稿正文的唯一取回路径）。
 *
 * **只有一个来源：本进程的缓冲**（`run-partial-buffer`）。旧版这里有三个来源（内存 → 库里
 * `partial_output` 行 → 占位帧），形态 M 删掉后两个：
 *   * **库里那一行不存在了**：正文的 durable 落点改成 `round_end.final_text`（已完成轮次）+
 *     `run_end.partial_text`（停止时那半轮）。内存没东西时再去库里拼一份「看起来像流式」的正文，
 *     就是拿**已完成轮次的终稿**冒充「还在流的那一轮」；而终稿本来就该由历史投影
 *     （`buildPartialOutputItems`）给，两条通路各自完整、互不越界。
 *   * **占位帧搬到了历史投影**（M-4）：占位说的是「刷新后这片区域不许空白」（#278），而 SSE 重连时
 *     前端本来就会重拉 history ⇒ 两条通道各说一句就是同一件事说两遍（且两边 id 不同 ⇒ 渲染两行）。
 *
 * 硬口径：
 *   * **只发还在写的 run**（`partialOutputs.sessionRuns` 已排除已标终态的 entry）：终态 run 的正文
 *     已在库里，再发一帧就是重复正文（#300 头号坑）。
 *   * **没有 `uptoSeq` 闸门，也没有 `PARTIAL_SNAPSHOT_ROW_LIMIT`**（形态 M 删掉的旧设计）：碎片不落库
 *     就没有 seq 坐标系，拿缓冲里「已落库事件的最大 seq」与客户端 `Last-Event-ID` 比是**两套坐标硬比**
 *     （审计 B-2/B-3：比赢漏发、比输重发，两种错都长得像「正文空洞 / 重复」）。现在靠**帧自带
 *     `roundSeq`**、前端拿自己观测到的 `round_start.seq` 对账 ⇒ 判据从「服务端猜水位线」变成
 *     「两端对同一个事实」（`round_start` 是事实档、自带 seq，两边看到的是同一个数）。
 *   * 帧**不带 `seq`、也不带 SSE `id:`**：内存帧根本没有 seq，带 `id:` 会污染浏览器 Last-Event-ID。
 *
 * 成本：**零查询**（缓冲自带会话归属）——旧版的回落查询与占位用的 `loadWindowRuns` 查询一起消失。
 * ⚠ **per-process**：多副本 portal 下这份缓冲只在一个进程里 ⇒ 见 `docs/api/portal.md` §4.4a 部署前提。
 *
 * @returns {Array<object>} 快照帧（`type = 'partial_output'`，无 `id:`）
 */
function buildPartialSnapshotFrames({ sessionId }) {
  const frames = [];
  for (const runId of partialOutputs.sessionRuns(sessionId)) {
    const snap = partialOutputs.snapshot(runId);
    if (!snap || snap.text === '') continue; // 空正文没什么可补的（也不发空帧去清气泡）
    frames.push({
      session_id: sessionId, run_id: runId, type: PARTIAL_OUTPUT_TYPE,
      ts: new Date().toISOString(),
      // `roundSeq` 是前端唯一的对账依据（判据 4）：对不上当前轮就整帧丢弃，不覆盖、不追加。
      roundSeq: snap.roundSeq,
      round: snap.round,
      text: snap.text, reasoning: snap.reasoning,
      chunks: snap.chunks, truncated: snap.truncated,
      // copilot 复审 261115-01 的 **②**（**additive 键**：`chunks`/`roundSeq`/`truncated` 语义不动）：
      // 正文段的**代际号**（`run-partial-buffer.js`，只在 `round_start`/`closeRound` 两处 +1）。
      // 前端拿它分「新的一段（哪怕更短、哪怕恰是前缀）」与「同一段被截过的那一份」；
      // 旧前端不读这个键 ⇒ 多发一个键不破任何既有口径。
      textSegment: snap.textSegment,
      source: 'memory',
    });
  }
  return frames;
}

// 展示 payload 截断：字符串叶值超cap → 截断 + 标记（JSON 形状保持合法，前端 String() 路径原样可用）。
export function truncateHistoryPayload(value, depth = 0) {
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
 * issue #300 的正文取数（**issue #502 形态 M 改口径：读两处已有的 durable 正文**）。
 *
 * 三个版本依次是：① 按 seq 拼整 run 的 `assistant_delta`（dev 实测 877,155 行 / 472 MB 拼出一个字符串）
 * → ② 读 `partial_output` 那一行（上一版设计）→ ③ **本版：完全不引入新行**：
 *   * **已完成轮次** = `type='round_end'` 行的 `payload.final_text`，**按 seq 升序拼接**
 *     （引擎每轮收尾都写一条，runner `worker.js:290` 的 `final_text: event.finalText ?? ''` 就是它；
 *     dev 真库现查 1,008 行里 437 行非空 ⇒ 这是现成的真相，不需要再造一份）；
 *   * **停止时那半轮** = `type='run_end'` 行的 `payload.partial_text`（由 `internal.js#runEndPartialKeys`
 *     在终态事务里写进**既有**那一行）。
 *
 * 两处的顺序不能反：`round_end` 在前、`run_end` 在后就是「已经说完的话 + 说到一半的话」；
 * 拼接是**字符串级**的，中间不插分隔符（引擎写的轮次边界是模型自己的，不是我们的段落格式）。
 * `run_end` 只认它自己的 `partial_text` 键，**不拿 `termination`/`error` 当正文**（那不是正文）。
 *
 * **成本红线不变**（`portal/test/session-partial-output.test.js` 用 `sqlLog` 钉）：
 *   * 候选集合仍只来自 `loadWindowRuns` 那**一条**查询（终态 + `has_anchor=false`）；
 *   * 本函数仍只打**一条** `run_id = ANY($1)` 的查询，走 `run_events_run_idx (run_id, seq)`，零新索引
 *     （取的仍是「这些 run 的行」，只是 `type` 从 `partial_output` 换成 `round_end`/`run_end`）；
 *   * 窗口里没有 run ⇒ 整段跳过，一条查询都不许多发（`buildHistorySynthItems` 里那道早退）。
 *
 * 两处都没有正文 ⇒ **给一个占位项**（`placeholder: true`，#278 底线：中止态不许留空白）。
 * 占位原来在 SSE 补发通路里（`source:'none'` 帧），形态 M 搬到**这里**：刷新才是占位真正要解决的
 * 时刻（重连时前端会重拉 history），SSE 那份与它重复。
 *
 * 脏载荷：`payload` 缺失/不是对象、`final_text`/`partial_text` 缺键或不是字符串 ⇒ **当没给正文**
 * （项目惯例：脏数据不得渲染成 `[object Object]` / `undefined`）。
 * 截断由本端点统一拿笔（`PARTIAL_PROJECTION_TEXT_CAP = 65536`，真库最长值 31,707 的两倍余量）：
 * `truncated` 只认**真字面量 true** 或本端点真的切了长度（脏值不谎报），只给布尔、不给「…（已截断）」
 * 文本，截断标记由前端出（StreamPanel）。
 *
 * @param {Array<{run_id?: string, id?: string, last_seq?: number}>} candidates `loadWindowRuns` 的终态无锚点行
 * @returns {Promise<Array<{seq:number,run_id:string,type:string,payload:object}>>} 合成项（按 run 一条）
 */
async function projectPartialOutputItems(pool, candidates) {
  const items = [];
  const ids = (candidates ?? []).map((c) => c.run_id ?? c.id).filter((id) => id != null);
  if (ids.length === 0) return items;
  const r = await pool.query(
    `SELECT run_id, seq, type, payload FROM run_events
      WHERE run_id = ANY($1) AND type IN ('round_end', 'run_end')
      ORDER BY run_id, seq`,
    [ids],
  );
  /** @type {Map<string, {rounds: string[], partial: string|null, seqSum: number}>} */
  /** @type {Map<string, {rounds: string[], partial: string|null, partialTruncated: boolean}>} */
  const acc = new Map();
  for (const row of r.rows ?? []) {
    const runId = row.run_id ?? null;
    if (runId == null) continue;
    if (!acc.has(runId)) acc.set(runId, { rounds: [], partial: null, partialTruncated: false });
    const slot = acc.get(runId);
    const p = row.payload && typeof row.payload === 'object' ? row.payload : {};
    if (row.type === 'round_end') {
      // 可选字段：非字符串就是「没给终稿」（引擎在空轮上写 `''`），不是「正文是 [object Object]」。
      if (typeof p.final_text === 'string' && p.final_text !== '') slot.rounds.push(p.final_text);
    } else if (row.type === 'run_end' && typeof p.partial_text === 'string' && p.partial_text !== '') {
      // 那一行受 `run_events_run_end_key` 部分唯一索引保护 ⇒ 至多一条，不需要「取最后一条」的合并。
      slot.partial = p.partial_text;
      // 审计第 3 条：写入侧在缓冲里就看到的「正文已被 `textCap`（16,384）夹尾」那个事实
      //（`internal.js#runEndPartialKeys` 写的 `partial_truncated`）。**只认真字面量 `true`**：
      // 缺键（旧库里的行本来就不可能有这个键）与脏值都当「没截」，不拿脏值谎报。
      slot.partialTruncated = p.partial_truncated === true;
    }
  }
  for (const c of candidates ?? []) {
    const runId = c.run_id ?? c.id;
    if (runId == null) continue;
    const seq = Number(c.last_seq);
    if (!Number.isFinite(seq)) continue; // 无任何事件行 ⇒ 合成项无处安放
    const slot = acc.get(runId) ?? { rounds: [], partial: null, partialTruncated: false };
    const full = slot.rounds.join('') + (slot.partial ?? '');
    if (full === '') {
      // 占位（#278 底线）：这次 run 无锚点、两处正文都没有 ⇒ 界面仍要有一行话说「内容没留住」。
      items.push({
        seq, run_id: runId, type: PARTIAL_OUTPUT_TYPE,
        payload: { text: '', chunks: 0, truncated: false, placeholder: true, source: 'none' },
      });
      continue;
    }
    // 审计第 3 条：`truncated` 是**两个来源取或**：
    //   ① 本端点自己聚合后超 `PARTIAL_PROJECTION_TEXT_CAP`（65,536）——一直就有；
    //   ② 写入侧在缓冲里就看到的「正文已被 16,384 夹尾」（`run_end.partial_truncated`）。
    // 不取 ② 就是把一段被夹到 16,384 的正文说成「完整」（谎报）：投影自己没切长度是事实，
    // 但「库里存的那份已经是被截过的」也是事实，两个都得进读数。
    const overCap = full.length > PARTIAL_PROJECTION_TEXT_CAP;
    items.push({
      seq, // 该 run 的最大 seq（**不新分配**，也不推进 `chat_sessions.last_seq`）⇒ 排在本次 run 内容之后
      run_id: runId,
      type: PARTIAL_OUTPUT_TYPE,
      payload: {
        text: overCap ? full.slice(0, PARTIAL_PROJECTION_TEXT_CAP) : full,
        chunks: slot.rounds.length, // 可观测性：能核对「拼了几轮的终稿」（碎片级计数已随 #502 消失）
        truncated: overCap || slot.partialTruncated === true,
        // #502 additive 透传（前端今天不读，但人工排查看得到）：这一份是从哪里来的。
        source: slot.partial ? (slot.rounds.length > 0 ? 'round_end+run_end' : 'run_end') : 'round_end',
      },
    });
  }
  return items;
}

/** 合成项参与升序排序，但**不占 limit、不参与 next_cursor/hasOlder**（那两个仍只由真实事件决定）。 */
export function mergeSynthItemsBySeq(realEvents, synthItems) {
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
  const result = await sessions.getFoldedPayload(ctx.pool, { userId: session.user.id, sessionId, round, log: ctx.log });
  return sendJson(res, 200, result);
}

/**
 * GET /api/sessions/:id/delegates?runId=<parentRunId>[&activity=1] —— 某个父 run 的子 run 名册（只读，零审计）。
 * 属主校验 / 父 run 归属 / 路径解析全在 `delegation.js`，与 `GET /api/sessions/:id` 同一个 404 口径。
 * `activity`（issue #593）：**只认字符串 `1`**，其它任何值（`0` / `true` / `yes` / 空串 / 缺席）
 * 一律等价于不带 ⇒ 响应与今天逐字段相同。不在这里判形状：`delegation.js` 只接 `activity === true`，
 * 重一遍「只认 1」就会得到两把尺（与上面 `tail` 同口径）。
 */
async function handleSessionDelegates(req, res, ctx, sessionId) {
  const session = await requireSession(req, ctx);
  const url = new URL(req.url, 'http://x');
  const result = await delegation.listDelegates({
    pool: ctx.pool,
    sessionId,
    userId: session.user.id,
    parentRunId: requireDelegateRunId(url),
    userSpaceRoot: ctx.config.userSpaceRoot,
    activity: url.searchParams.get('activity') === '1',
  });
  return sendJson(res, 200, result);
}

/**
 * GET /api/sessions/:id/delegates/:childRunId?runId=<parentRunId>&tail=N —— 子 run 账本的只读投影。
 * `tail` 缺省 100、硬上限 500（越界 400 `validation_failed`，`details.field='tail'`）。
 * ⚠ `tail` 只做 `Number()`，**整数与范围不在这里判**：判据只有一份（`delegation.js`），
 *    那里才带得出 `details.field`；此处重复一遍就等于埋下两把尺。
 */
async function handleSessionDelegateTranscript(req, res, ctx, sessionId, childRunId) {
  const session = await requireSession(req, ctx);
  const url = new URL(req.url, 'http://x');
  const tailRaw = url.searchParams.get('tail');
  const result = await delegation.getDelegateTranscript({
    pool: ctx.pool,
    sessionId,
    userId: session.user.id,
    parentRunId: requireDelegateRunId(url),
    childRunId,
    tail: tailRaw == null || tailRaw === '' ? undefined : Number(tailRaw),
    userSpaceRoot: ctx.config.userSpaceRoot,
  });
  return sendJson(res, 200, result);
}

/**
 * `runId` 是**必填** query 参数（名册按父 run 分片 ⇒ 没有父身份就不知道该读哪个目录）。
 * 缺席/空串 ⇒ 400；形状（uuid）交给 `delegation.js` 的单点校验（同一个 `details.field='runId'`）。
 *
 * ⚠ **只归一化小写，不再 `decodeURIComponent`**（#593 修的既有缺陷，与 `decodeUuid` 不是一回事）：
 * `url.searchParams.get()` 返回的值**已经被 URL 解析器解码过一次**，再走 `decodeUuid` 就是**双重解码**：
 *   `?runId=%25` → `get()` 得 `'%'` → `decodeURIComponent('%')` 抛 `URIError` → 它不是 SessionError/
 *   DelegationError/MacroError ⇒ 落到请求处理的未捕获兜底（`log 'unhandled:'` + `500 internal`），
 *   而契约要的是 400 `validation_failed`（`details.field='runId'`）。
 *   同类：`%E0%A4%A`（坏转义序列）。路径参数才需要 `decodeUuid`（那一段确实没解码过），别顺手改它。
 * 非法值不需要在这里「解得出」：下游 `PARENT_RUN_ID_RE` 会把任何非 uuid 串判成 400 ⇒ 形状语义不少。
 */
function requireDelegateRunId(url) {
  const raw = url.searchParams.get('runId');
  if (raw == null || raw === '') {
    throw new HttpError(400, 'validation_failed', 'runId 必填（父 run id）', { en: 'runId is required (parent run id)', details: { field: 'runId' } });
  }
  return raw.toLowerCase();
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
    throw new HttpError(400, 'validation_failed', 'limit 必须为正整数', { en: 'limit must be a positive integer', details: { field: 'limit' } });
  }
  limit = Math.min(limit, HISTORY_EVENT_MAX_LIMIT);
  const beforeRaw = url.searchParams.get('before');
  let before = null;
  if (beforeRaw != null && beforeRaw !== '') {
    before = Number(beforeRaw);
    if (!Number.isInteger(before) || before < 1) {
      throw new HttpError(400, 'validation_failed', 'before 必须为正整数', { en: 'before must be a positive integer', details: { field: 'before' } });
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
  // `before` 要传下去（#502 M-6④）：合成项只许出现在它自己 seq 所属的那一页。
  // issue #514：`pageLow` = 本页最小的真实事件 seq（空页 ⇒ 0 = 不设下界），它是**候选发现的页界**；
  // `sessionId` 给发现查询用（那条查询按会话查 `run_end` 行，不像主窗口那样从行里带出 run_id）。
  const pageLow = rows.length > 0 ? Number(rows[0].seq) : 0;
  const synth = await buildHistorySynthItems(ctx.pool, rows, {
    before,
    sessionId,
    pageLow,
    limit,
  });
  // 白名单游标（既有口径，逐字未动）：本页有真实行且还有更早的 ⇒ 本页最老那一行的 seq。
  const whitelistCursor = hasOlder && rows.length > 0 ? pageLow : null;
  // issue #514 **返修**（二次审计第 1 条，主 agent 复核成立）：**空页的游标必须由候选发现行驱动**。
  // 空页不是「到底了」，它恰恰意味着「`before` 之下还有内容，只是全不是白名单事件」——而那条尾巴
  // （> `limit` 条「从未开始就被取消」的 run，每个只留一行 `run_end`）被发现的 `LIMIT` 截掉的部分，
  // 在旧口径下 `next_cursor` 恒 null（游标只由白名单行算，空页上白名单行不存在）⇒ 客户端不会再拉
  // 下一页 ⇒ 那些 run 的分隔条**永远没有页可达**（不是延迟出现，是永远看不见）。
  // 取**已发现行里最小的 seq**：下一页窗口 `[0, minSeq)` 与本页 `[0, before)` 严格不重叠（发现查询
  // 自己夹了 `seq < before` ⇒ minSeq 必然 < before，方向与白名单游标一致、不会倒退），
  // 且下一页的窗口从这条之后继续 ⇒ 不重不漏。是否「还有更老的」取**事实**而非猜测：发现查询按
  // 主窗口同一口径多取一行探针（`LIMIT limit + 1`），真拿到了第 `limit + 1` 行才算截断。
  // 非空页**不动游标**：那种页的截断残差在 `[minSeq, pageLow)` 之间，而页游标属于白名单行——把它
  // 压到 pageLow 之下会跳过**真实事件**（比丢一条分隔条更坑），所以那种页照旧、残余写进 §4.4a-2。
  const minDiscoveredSeq = synth.discovery.minSeq;
  const tailCursor = rows.length === 0 && synth.discovery.truncated
    && Number.isSafeInteger(minDiscoveredSeq) && minDiscoveredSeq >= 1
    && (before == null || minDiscoveredSeq < before)
    ? minDiscoveredSeq
    : null;
  return sendJson(res, 200, {
    events: mergeSynthItemsBySeq(events, synth.items),
    next_cursor: whitelistCursor ?? tailCursor,
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
 *   ① 该 run 是**本页的候选**：本页白名单行里出现过它（`distinctWindowRunIds`），**或**本页 seq 窗口内
 *     有它的 `run_end` 行（issue #514 补的那半：只写一行 `run_end` 的 run 在白名单行里零影子）；
 *   ② `runs.status IN ('finished','failed')`（`queued`/`running`/`cancelling` 一律不合成）；
 *   ③ `termination.reason` 是**非空字符串**（缺 termination / 脏载荷 ⇒ 不合成：不拿 status 编一个 reason）。
 *
 * ⚠ ① 的两路**都只发现 run id**：白名单行照旧下发，`run_end` 行照旧**不下发**（红线，#217/#236）。
 *
 *
 * `seq` = 该 run 在 `run_events` 里的**最大 seq**（不新分配）：`run_end` 行本来就在表里 ⇒ 分隔条天然落在
 * 本次 run 内容之后，且分页窗口外的行也拿得到（`MAX(seq)` 不受 `before` 限制）。
 */
export async function buildHistorySynthItems(pool, windowRows, { before = null, sessionId = null, pageLow = 0, limit = HISTORY_EVENT_DEFAULT_LIMIT } = {}) {
  const windowRunIds = distinctWindowRunIds(windowRows);
  // issue #514：**候选发现不能只认白名单行**。`stopSession` 的 killedQueued 分支（queued 从未开始
  // 就被取消）这次 run 只写**一行** `run_end`，而它不在下发白名单（红线）⇒ 这个 run 在白名单行里
  // **一个影子都没有** ⇒ 旧代码把它整个漏掉：既没有 `run_termination` 分隔条，也没有占位项，
  // 刷新后正文区完全空白。这里用页内的 `run_end` 行**发现 run id**（只是多一个候选 id，
  // 那一行本身仍不作为回放事件下发），后面的投影完全复用既有通路。
  const discovery = sessionId == null
    ? NO_TERMINAL_DISCOVERY
    : await discoverTerminalRuns(pool, sessionId, { pageLow, before, limit });
  const runIds = [...new Set([...windowRunIds, ...discovery.runIds])];
  // 成本红线：窗口无 run 且页内无终态行 ⇒ 整段跳过，一条 runs 查询都不许多发。
  if (runIds.length === 0) return { items: [], discovery };
  // 一条 runs 查询同时服务 partial_output 的候选判定与 run_termination 的终态投影（不许打第二条）。
  const runRows = await loadWindowRuns(pool, runIds);
  // 候选 = 终态且**无 assistant 锚点**的 run（有锚点 ⇒ 正文已在 `messages`/transcript 那条路上，
  // 再合成一份就是重复正文 —— #300 头号坑）。`last_seq` 一并带下去当合成项的 seq（不新分配）。
  const partialCandidates = runRows.filter((row) => row.has_anchor !== true);
  const partials = await projectPartialOutputItems(pool, partialCandidates);
  // issue #502 M-6④（审计第 4 条）：合成项只许在**它自己 seq 所属的那一页**出现。
  // 两类合成项的 `seq` 都是 `loadWindowRuns` 的 `MAX(e.seq)`，而 `MAX` **不受 `before` 约束**（它算的是
  // 全 run 的最大值）⇒ 同一个 run 的事件跳好几页时，它的合成项会在**每一页都出现一份**
  //（分页往上翻 = 同一段正文/同一条分隔线反复重演）。修法只在入口拦一道：
  // `seq >= before` 的项属于**更新的那一页**，本页不得返。不拿 `windowRows` 的最小 seq 去卡下界：
  // `seq` 永远 >= 本页最小行 seq（候选就是从本页行里来的），卡下界只会把刚好落在页首的项误删。
  const items = [...partials, ...buildRunTerminationItems(runRows)];
  // `discovery` 原样带出去（**不是**合成项的一部分）：分页游标要的是「发现行本身的最小 seq」与
  // 「是否被 `LIMIT` 截断」这两个**窗口事实**，而不是存活下来的合成项的 seq（项会被 M-6④ 的
  // `seq < before` 拦掉、会被「非终态 / 有锚点 / 无 reason」筛掉——拿它当游标会漏进可倒退的位置）。
  if (before == null) return { items, discovery };
  return { items: items.filter((it) => Number(it.seq) < before), discovery };
}

/** 会话未传（既有的调用口径：不跑发现查询）时的空发现结果。 */
const NO_TERMINAL_DISCOVERY = Object.freeze({ runIds: Object.freeze([]), truncated: false, minSeq: null });

/**
 * issue #514：**候选发现**——从本页 seq 窗口里的 `run_end` 行取 `run_id` 与 `seq`
 * （那一行本身照旧不下发；取出来的 seq 只用于**分页游标**，不拿它当合成项的位置——
 * 项的 `seq` 仍由 `loadWindowRuns` 的 `MAX(e.seq)` 定，#236/#300 口径未动）。
 *
 * 为什么需要它：合成项的候选集此前**只**来自「本页的白名单行里有哪个 run」，而一条从未开始就被
 * 取消的 run 只有一行 `run_end`（白名单外，红线不许加）⇒ 它永远进不了候选集 ⇒ 刷新后这条 run
 * 在界面上**不存在**（正文区空白，连「已中止」那一行都没有）。
 *
 * 判据与边界：
 *   * 只查 `type = 'run_end'`：`run_events_run_end_key`（部分唯一索引）保证每 run 至多一行 ⇒ 一次页
 *     窗口里的候选数 = 该页里终态的 run 数，天然有界；
 *   * **seq 下界 `pageLow`**（本页最小的白名单行 seq）：没有下界就会把**更老页**的终态 run 也拉进
 *     本页，同一根分隔条在每一页重演一次（#502 M-6④ 那个形状）。空页 ⇒ 下界 0：此时本页就是
 *     「白名单行的尾巴之下」那一段，本就没有更老的内容会被重复覆盖；
 *   * **seq 上界 `before`**：与主窗口同一口径（游标之下才属于本页）；
 *   * `LIMIT = limit + 1`（**多取一行探针**，与主窗口算 `hasOlder` 同一个手法，§1.3 keyset 口径）：
 *     拿到的行数**超过** `limit` 才是「真的被截断了」（事实），而不是「恰好返了 `limit` 条」（猜）；
 *     候选仍只取最新的 `limit` 条 ⇒「候选数不超过页大小」这条不变。
 *     为何不能拿「返了 `limit` 条」当截断：那种页恰好只剩 `limit` 条时，游标会被归到一条**已经展示
 *     过**的行上 ⇒ 客户端多跑一趟空页，而既有那条「空页 ⇒ 分页到头」的断言会变假（#514 页界用例）。
 *
 * **返的是窗口事实，不只是候选 id**（#514 返修，审计第 1 条）：`truncated` 与 `minSeq`（已保留行里
 * 最小的 `seq`）是分页游标的唯一合法来源（见 `handleSessionEventsHistory`）——游标要回答的是
 * 「这个窗口之下到底还有没有更老的行」，而不是「存活下来的合成项长什么样」（后者会被 M-6④ 的
 * `seq < before` 拦掉、会被「非终态 / 有锚点 / 无 reason」筛掉 ⇒ 拿它当游标会造出倒退的页边界）。
 *
 * 成本：**每次响应最多一条**（不是每 run 一枪）；非空页的扫描范围被 `[pageLow, before)` 夹住，
 * 空页是 `[0, before)` 那一段（访问路径不止一条，见下面 LOW-1：planner 按统计选）。此前那条
 * 「同一次响应里只允许一条 `runs` 查询」的成本红线不变（发现的是 `run_events`，候选 id 仍并进
 * `loadWindowRuns` 那**一条** runs 查询）。
 * ⚠ 成本的两条事实（二次审计 LOW-1 + 一次性真库自证，逐字同 §4.4a-2 成本段）：
 *   ① `LIMIT` 封的是**返回条数**，不是**过滤 / 排序前的行数**——`type = 'run_end'` 是残余过滤；
 *   ② planner 有**两条路**、按统计选：`UNIQUE (session_id, seq)` **反向扫**（扫页窗口内的事件行），
 *      或 `run_events_run_end_key`（部分唯一 `WHERE type='run_end'`）**+ Top-N 排序**（扫这一形状
 *      的 `run_end` 行，与 seq 窗口无关）。⇒ 「一定走倒序扫」与「`run_end_key` 帮不上忙」两句
 *      **各说对一半**，两句都别当承诺。
 */
async function discoverTerminalRuns(pool, sessionId, { pageLow = 0, before = null, limit = HISTORY_EVENT_DEFAULT_LIMIT } = {}) {
  const params = [sessionId, pageLow];
  let where = `session_id = $1 AND type = 'run_end' AND seq >= $2`;
  if (before != null) { params.push(before); where += ` AND seq < $${params.length}`; }
  const cap = Math.max(1, limit);
  params.push(cap + 1); // 探针行：只为判「窗口之下还有没有更老的」，不拿它当候选
  const r = await pool.query(
    `SELECT run_id, seq FROM run_events WHERE ${where} ORDER BY seq DESC LIMIT $${params.length}`,
    params,
  );
  const rows = (r.rows ?? []).filter((row) => row.run_id != null);
  const kept = rows.slice(0, cap);
  // `ORDER BY seq DESC` ⇒ 保留段的**最后一行**就是最小 seq（下一页游标要的正是它）。
  const last = kept.length > 0 ? Number(kept[kept.length - 1].seq) : null;
  return {
    runIds: kept.map((row) => row.run_id),
    truncated: rows.length > cap,
    minSeq: Number.isSafeInteger(last) ? last : null,
  };
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
  const body = await readJsonBody(req);
  const login = typeof body.login === 'string' ? body.login.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!login || !password) {
    throw new HttpError(400, 'validation_failed', 'login 与 password 均为必填', { en: 'Both login and password are required' });
  }
  // #677 Tier 2A：两个长度上限是热读旋钮 ⇒ 本请求各现读一次并复用（不进循环、不读两遍）。
  const maxLoginLength = await runtimeSettings.readMaxLoginLength({ pool, config, log: ctx.log });
  const maxPasswordLength = await runtimeSettings.readMaxPasswordLength({
    pool, config, log: ctx.log,
  });
  if (login.length > maxLoginLength) {
    throw new HttpError(400, 'validation_failed', `login 长度超过上限 ${maxLoginLength}`, { en: `login exceeds the limit of ${maxLoginLength} characters` });
  }
  if (password.length > maxPasswordLength) {
    throw new HttpError(400, 'validation_failed', `password 长度超过上限 ${maxPasswordLength}`, { en: `password exceeds the limit of ${maxPasswordLength} characters` });
  }

  const ip = clientIp(req);
  const rlKey = `login:${ip}:${login}`;
  const check = ctx.loginLimiter.check(rlKey);
  if (!check.allowed) {
    throw new HttpError(429, 'rate_limited', '尝试过于频繁，请稍后再试', {
      en: 'Too many attempts, please try again later',
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
        en: 'Service is busy, please try again later',
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
    throw new HttpError(401, 'invalid_credentials', '用户名或口令错误', { en: 'Invalid username or password' });
  }

  ctx.loginLimiter.reset(rlKey);

  // ---- 第二因素选择（issue #449 决策 2，纯函数在 login-email-code.js）----
  //   ① 已注册 TOTP            → totp_required（现状一字不改）
  //   ② 未注册 + 邮件通道启用 + 有邮箱 → email_code_required
  //   ③ 未注册 + 邮件通道启用 + 无邮箱 → 409 email_not_registered（**绝不静默退回口令**）
  //   ④ 邮件通道未启用（默认）  → 口令直通，但审计 method 标明「没有第二因素」
  const mailer = await ctx.mailerProvider.get();
  const secondFactor = loginEmailCode.chooseSecondFactor({
    hasTotpEnrollment: await auth.hasTotpEnrollment(pool, result.user.id),
    // feat-261110-02：「绑过 TOTP」与「登录允许用 TOTP」分开传（迁移 0030）。这一位不传就等于
    // 「所有人照旧」，于是管理台那个「允许 TOTP」的勾选框在界面上生效、在服务端是装饰。
    totpLoginEnabled: result.totpLoginEnabled !== false,
    // 2026-11-06：**唯一**判据是 per-user 开关（迁移 0028）。全局 `transport` 只是 SMTP 连接配置，
    // 不再一票否决 —— 否则「管理员打开了开关、界面显示已启用、实际永远走口令」是必然的死光纤。
    mailOtpEnabled: result.mailOtpEnabled === true,
    email: result.email,
  });
  // ⑤（#449 二选一）已绑 TOTP + 开关开 + 有邮箱 ⇒ 两条路并存。**必须在这一条里自己处理 SMTP**：
  //    下面那条 503 只属于 `email_code_required`（无 TOTP 时邮件码是唯一第二因素，发不出去就不能进）；
  //    二选一分支里 TOTP 是离线可用的强因素，绝不能因为 SMTP 抖动把人锁在门外。
  if (secondFactor === 'second_factor_choice') {
    return handleSecondFactorChoice(req, res, ctx, {
      user: result.user,
      email: result.email,
      ip,
      mailer,
    });
  }
  // 开关开着但 SMTP 没配 / 不可用 ⇒ **明确报错，绝不静默降级到口令**（静默降级是安全洞：
  // 用户以为自己过了第二因素，其实只是口令）。这是「全局 disabled 不再是功能闸」的代价，必须显式化。
  if (secondFactor === 'email_code_required' && mailer.enabled !== true) {
    throw new HttpError(503, 'email_channel_unavailable',
      '该账号要求邮件验证码，但邮件通道未配置或不可用，请联系管理员', { en: 'This account requires an email verification code, but the mail channel is not configured or unavailable; please contact an administrator', retryable: false });
  }

  if (secondFactor === 'email_not_registered') {
    // 邮件通道开着却没有邮箱 = 第二因素做不成。让人去找管理员补录，不给他「反正能进」的错觉。
    throw new HttpError(
      409,
      'email_not_registered',
      '当前账号未登记邮箱，无法接收登录验证码；请联系管理员补录邮箱后再登录',
      { en: 'The current account has no registered email address and cannot receive a login verification code; please contact an administrator to add one, then log in again', retryable: false },
    );
  }

  if (secondFactor === 'email_code_required') {
    return handleEmailCodeRequired(req, res, ctx, { user: result.user, email: result.email, ip });
  }
  // 未注册 TOTP（totp_secret 为空）且邮件通道未启用 → 跳过第二因素，口令直通建会话。
  // （偏离规格 §7.1「强制 TOTP」：NULL secret 原语义 = 第二步永远失败 = 永久锁死；
  //   现改为「未注册即跳过」，用户决策 2026-09-22，规格同步见 issue）
  if (secondFactor === 'password_direct_no_second_factor') {
    // #677 P2a：会话 TTL 热读（口径与 `/api/me` 那一处逐字相同：DB > env > 默认，5s 缓存）。
    const ttlSeconds = await runtimeSettings.readSessionTtlSeconds({ pool, config, log: ctx.log });
    const session = await auth.createSession(pool, result.user.id, {
      ip,
      userAgent: req.headers['user-agent'] ?? null,
      ttlSeconds,
    });
    // #449：method 明确写出「这一层没做第二因素」（邮件通道未配置）——审计能区分「有两层」与「只有一层」。
    await auditLoginSuccess(pool, result.user, 'password_direct_no_second_factor');
    return sendJson(res, 200, {
      status: 'authenticated',
      // #255（纯 additive）：登录时就告诉前端「这枚会话是受限的」，不必等它去碰第一个 403。
      // 两个**发会话**的分支都有（下面是 TOTP 分支）；`totp_required` 中间响应**不带**：
      // 那一步尚未登录、无 cookie，谈不上受限（口径见 portal.md §2.2/§2.3）。
      password_change_required: result.mustChangePassword === true,
      user: result.user,
    }, {
      'Set-Cookie': sessionCookieHeader({ ...config.cookie, maxAge: ttlSeconds }, session.token),
    });
  }

  // #677 Tier 2A：待决令牌 TTL 现读一次，同时喂落库 ttlSeconds 与响应 expires_in（同请求同源）。
  const pendingTtlSeconds = await runtimeSettings.readPendingTokenTtlSeconds({
    pool, config, log: ctx.log,
  });
  const pending = await auth.createPendingToken(pool, result.user.id, {
    ip,
    userAgent: req.headers['user-agent'] ?? null,
    ttlSeconds: pendingTtlSeconds,
  });
  return sendJson(res, 200, {
    status: 'totp_required',
    pending_token: pending.token,
    expires_in: pendingTtlSeconds,
  });
}

/** 邮箱验证码参数的缺省值（测试/旧配置没带 `loginEmailCode` 段时仍可工作；口径同 config.js 默认）。 */
const DEFAULT_EMAIL_CODE_POLICY = Object.freeze({
  ttlSeconds: 600,
  maxAttempts: 5,
  resendCooldownSeconds: 60,
  maxResends: 3,
});

function emailCodePolicy(config) {
  const raw = config.loginEmailCode ?? {};
  return {
    ttlSeconds: Number(raw.ttlSeconds ?? DEFAULT_EMAIL_CODE_POLICY.ttlSeconds),
    maxAttempts: Number(raw.maxAttempts ?? DEFAULT_EMAIL_CODE_POLICY.maxAttempts),
    resendCooldownSeconds: Number(raw.resendCooldownSeconds ?? DEFAULT_EMAIL_CODE_POLICY.resendCooldownSeconds),
    maxResends: Number(raw.maxResends ?? DEFAULT_EMAIL_CODE_POLICY.maxResends),
  };
}

/**
 * 邮箱码的邮件正文（**只在这里**拼入明文码；审计/日志绝不取这个字符串）。
 *
 * 双语（2026-11-10 用户要求「验证码邮件请使用双语」）：中文在前、英文紧随其后，两种语言各写一次
 * 有效期——收件人未必读得懂中文，而验证码邮件是登录的**唯一**凭据来源，看不懂就等于收不到。
 * 有效期分钟数从 `ttlSeconds` 现算（`EMAIL_CODE_TTL_SECONDS` 可覆盖），**不写死 10**。
 */
function emailCodeMessage(code, ttlSeconds) {
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  return {
    subject: 'FDE Station 登录验证码 / Sign-in verification code',
    text: [
      `你的登录验证码是 ${code}，${minutes} 分钟内有效。`,
      `Your sign-in verification code is ${code}. It is valid for ${minutes} minutes.`,
      '',
      '如非本人操作，请忽略本邮件并考虑联系管理员。',
      "If you didn't try to sign in, you can ignore this email — consider telling your administrator.",
    ].join('\n'),
  };
}

/**
 * 决策 2 的第②分支：发一枚邮箱验证码（`status='email_code_required'`）。
 * 发信失败 ⇒ `503 email_send_failed`（retryable），但 **pending_token 不作废**：用户点重发即可，不必重输口令。
 *
 * 顺序契约（评审返修 ①，issue #449）：**先发信、成功后才插码行**。
 * 反过来（先插码再发信）会让失败重试被自己插的那行的 `created_at` 卡在 60s 冷却里——
 * 用户看到的是「503 让我重试」紧接着「429 请稍后再试」，而 pending 只有 600s 寿命。
 * 发信失败时库里**一条码行都没有**，所以 `recordResend` 的重试路径（无码行 ⇒ 当首次发信）成立。
 *
 * 发信限流（评审返修 ②）：与重发同一把闸（`email:<ip>`），否则持有效口令的人可以反复调第一步刷邮箱。
 *
 * #737 口令步发信幂等：取证发现刷屏来自脚本**重复走口令步**（拿不到 cookie 就重试，每重试一封）。
 * 所以：**窗口（`policy.resendCooldownSeconds`，现值 60s，不新增旋钮）内同账号已有「未消费且未过期」
 * 的码 ⇒ 不再铸新码、不再发信**，而是把那枚已发出的码挂到本次新建的 pending 上（`adoptEmailCode`，
 * 复制 `code_hash` 字面值即可让旧邮件里的码在新 pending 上过 §2.3a）——同一个人在重试，不该再寄一封。
 * 复用**不续命**（`expires_at` 用旧码字面值）：反复登录不许把码的寿命无限延长；旧行同时作废，
 * 一枚码同一时刻只服务一个 pending。复用没发信 ⇒ 不占发信限流配额、审计记 `auth.email_code_reused`。
 */
async function handleEmailCodeRequired(req, res, ctx, { user, email, ip }) {
  const { pool, config } = ctx;
  // 这里再取一次（拿到的还是同一份 60s 缓存对象）；不用登录选择时那份是为了让本函数的依赖自己写清楚。
  const mailer = await ctx.mailerProvider.get();
  const policy = emailCodePolicy(config);

  // 发信频率闸先于建 pending：被限流时连 pending 行都不该留下（客户端稍后重走第一步即可）。
  const sendKey = `email:${ip}`;
  const sendCheck = ctx.emailSendLimiter.check(sendKey);
  if (!sendCheck.allowed) {
    throw new HttpError(429, 'rate_limited', '发信过于频繁，请稍后再试', {
      en: 'Sending is too frequent, please try again later',
      retryable: true,
      headers: { 'Retry-After': String(sendCheck.retryAfterSeconds) },
    });
  }

  // 待决令牌的 TTL 取 max(口令步 TTL, 码 TTL)：否则码还没过期、令牌先过期，`expires_in` 就是一句谎。
  // #677 Tier 2A：口令步 TTL 现读一次（默认 120），再与码 TTL 取 max；与 TOTP 分支同一个旋钮。
  const pendingBaseTtlSeconds = await runtimeSettings.readPendingTokenTtlSeconds({
    pool, config, log: ctx.log,
  });
  const pendingTtlSeconds = Math.max(pendingBaseTtlSeconds, policy.ttlSeconds);
  const pending = await auth.createPendingToken(pool, user.id, {
    ip,
    userAgent: req.headers['user-agent'] ?? null,
    ttlSeconds: pendingTtlSeconds,
  });

  // #737：窗口内同账号已有未消费未过期的码 ⇒ 复用，不铸新码、不发信（`now` 现取一次，两处共用同值）。
  const now = new Date();
  const reusable = await loginEmailCode.findReusableCode(pool, {
    userId: user.id,
    windowSeconds: policy.resendCooldownSeconds,
    now,
  });
  if (reusable) {
    const adopted = await loginEmailCode.adoptEmailCode(pool, {
      pendingTokenHash: pending.tokenHash,
      from: reusable,
      ttlSeconds: policy.ttlSeconds,
      maxAttempts: policy.maxAttempts,
      ip,
      userAgent: req.headers['user-agent'] ?? null,
      now,
    });
    // 没发信就不占 `email:<ip>` 配额（那把闸计的是「真的发了一封信」）；审计也不写 `sent`（假账）。
    await auth.audit(pool, {
      actorId: user.id,
      action: 'auth.email_code_reused',
      target: user.login,
      details: {
        login: user.login,
        email_hint: maskEmail(email),
        code_hash_prefix: adopted.codeHash.slice(0, 12),
        reused_from_code_id: reusable.id,
        expires_at: adopted.expiresAt.toISOString(),
        at: new Date().toISOString(),
      },
    }).catch(() => {});
    // 成功形状在既有五字段之外加 `email_reused`/`resend_after`（与 §2.3b 同口径）；**不带** `email_sent`。
    return sendJson(res, 200, {
      status: 'email_code_required',
      pending_token: pending.token,
      expires_in: pendingTtlSeconds,
      email_hint: maskEmail(email),
      email_code_ttl_seconds: policy.ttlSeconds,
      email_reused: true,
      resend_after: policy.resendCooldownSeconds,
    });
  }

  const code = loginEmailCode.generateEmailCode();

  const sent = await mailer.send({ to: email, ...emailCodeMessage(code, policy.ttlSeconds) });
  if (!sent.ok) {
    await auth.audit(pool, {
      actorId: user.id,
      action: 'auth.email_code_failed',
      target: user.login,
      details: { login: user.login, reason: sent.reason ?? 'send_failed', at: new Date().toISOString() },
    }).catch(() => {});
    // `details` 里带上 pending_token：发信失败时第一次响应就是 503（客户端还没拿到过令牌），
    // 不带它「pending 不作废、用户点重试即可」在协议上就不成立（只能回去重输口令）。
    throw new HttpError(503, 'email_send_failed', '验证码邮件发送失败，请稍后重试', {
      en: 'Failed to send the verification code email, please try again later',
      retryable: true,
      headers: { 'Retry-After': '5' },
      details: {
        pending_token: pending.token,
        expires_in: pendingTtlSeconds,
        email_hint: maskEmail(email),
        email_code_ttl_seconds: policy.ttlSeconds,
      },
    });
  }
  ctx.emailSendLimiter.recordFailure(sendKey); // 发信计数（限流器只有这一个计数入口）

  // 发信成功后才落库：这样「重发冷却」的起算点就是用户真的收到信的时刻。
  const created = await loginEmailCode.createEmailCode(pool, {
    pendingTokenHash: pending.tokenHash,
    code,
    ttlSeconds: policy.ttlSeconds,
    maxAttempts: policy.maxAttempts,
    ip,
    userAgent: req.headers['user-agent'] ?? null,
  });

  // 审计只记脱敏收件人 + 码哈希前缀（12 位）+ 过期时刻；**绝不出现明文码**（portal.md §2.3a）。
  await auth.audit(pool, {
    actorId: user.id,
    action: 'auth.email_code_sent',
    target: user.login,
    details: {
      login: user.login,
      email_hint: maskEmail(email),
      code_hash_prefix: created.codeHash.slice(0, 12),
      expires_at: created.expiresAt.toISOString(),
      at: new Date().toISOString(),
    },
  }).catch(() => {});

  return sendJson(res, 200, {
    status: 'email_code_required',
    pending_token: pending.token,
    expires_in: pendingTtlSeconds,
    email_hint: maskEmail(email),
    // 登录页要写「N 分钟内有效」：TTL 由 `EMAIL_CODE_TTL_SECONDS` 决定（默认 600s），
    // 前端不许自己写死 10 分钟 —— 配置一改就是一句谎。
    email_code_ttl_seconds: policy.ttlSeconds,
  });
}

/**
 * 二选一分支（issue #449 + #449 尾巴「懒发信」，portal.md §2.2）：已绑 TOTP + `mail_otp_enabled` + 有邮箱
 * ⇒ 第一步同时给出 **TOTP 与邮箱验证码两条路**，共用同一枚 `pending_token`（单次消费 ⇒ 谁先成功谁建会话，
 * 另一条自然失效）。
 *
 * **懒发信（2026-11-10 用户反馈）**：本分支**第一步一封邮件都不发**。旧行为是「口令一通过就发信」，
 * 于是每次登录都寄一封没人要的验证码（用户两天收了 7 封）。现在码子的第一封由**前端切到邮箱档那一刻**
 * 调 §2.3b 的 resend 端点发出 —— `recordResend` 本来就支持「该 pending 下零码行 ⇒ 当首次发信」且不套
 * 60s 冷却，所以懒发信不需要新端点、也不改 `login-email-code.js` 一个字。
 *
 * 但第一步仍要**预判这条通道当下可用**，否则用户切过去才撞错：
 *   ① `mailer.enabled !== true`（SMTP 未配置 / 急停）；② `email:<ip>` 的发信限流当下不允许。
 * `check()` 是**非消费型**预检，真正计数仍在 resend 端点里的 `recordFailure`。
 * 两种不可用都走 #449 既有的降级形状（不新造错误码）：`200` + `methods:["totp"]` + `email_sent:false` +
 * `email_unavailable:true` + `notice`，**绝不 503**（TOTP 离线可用，让它输于 SMTP 抖动比现状更糟）。
 *
 * ⚠ 成功形状**不带 `email_sent`**：那条降级的判据是 `email_sent:false`，而「还没发」不等于「不可用」——
 * 用**缺席**表达「还没发」，并用 `email_deferred:true` 明示「这条路可走，但码要等你切过来才发」。
 * 既然什么都没尝试过，就**不写** `auth.email_code_failed` 审计（写失败审计是假账）；只有真的判定了
 * 「邮件通道不可用」才留审计痕（运维要能查到为什么这个人只有一条路）。
 *
 * 与 `handleEmailCodeRequired` 的关键差别：那边邮件码是**唯一**第二因素 ⇒ 第一步就发信、发不出去就 503；
 * 这边只是**多给一条路** ⇒ 不发信、且永不因邮件而失败。
 * `expires_in` 与邮件码路径同口径 `max(PENDING_TOKEN_TTL_SECONDS, EMAIL_CODE_TTL_SECONDS)`：两路共用一枚
 * pending，取短的那个会让先到的邮件码比 TOTP 窗口还短，没有理由这么于。
 */
async function handleSecondFactorChoice(req, res, ctx, { user, email, ip, mailer }) {
  const { pool, config } = ctx;
  const policy = emailCodePolicy(config);
  // #677 Tier 2A：口令步 TTL 现读一次（默认 120）再与码 TTL 取 max；与另两条发码路径同一旋钮。
  const pendingBaseTtlSeconds = await runtimeSettings.readPendingTokenTtlSeconds({
    pool, config, log: ctx.log,
  });
  const pendingTtlSeconds = Math.max(pendingBaseTtlSeconds, policy.ttlSeconds);
  // pending 是两条路共同的入口：它建不成才是真错误（发信与它无关了）。
  const pending = await auth.createPendingToken(pool, user.id, {
    ip,
    userAgent: req.headers['user-agent'] ?? null,
    ttlSeconds: pendingTtlSeconds,
  });

  // 非消费型预检（见函数头）：不占配额、不计数，只回答「现在切过去发得出信吗」。
  const sendKey = `email:${ip}`;
  const emailUnavailable = mailer.enabled !== true || !ctx.emailSendLimiter.check(sendKey).allowed;
  if (emailUnavailable) {
    const reason = mailer.enabled !== true ? 'email_channel_disabled' : 'rate_limited';
    // 审计留痕：这条通道的不可用不是静默失败（运维能查到原因，但不影响登录）。
    await auth.audit(pool, {
      actorId: user.id,
      action: 'auth.email_code_failed',
      target: user.login,
      details: {
        login: user.login,
        reason,
        second_factor_choice: true,
        at: new Date().toISOString(),
      },
    }).catch(() => {});
    return sendJson(res, 200, {
      status: 'second_factor_choice',
      pending_token: pending.token,
      expires_in: pendingTtlSeconds,
      methods: ['totp'],
      email_hint: maskEmail(email),
      email_code_ttl_seconds: policy.ttlSeconds,
      email_sent: false,
      email_unavailable: true,
      notice: '邮件通道当前不可用，本次仅可用验证器应用（TOTP）',
    });
  }

  // 懒发信：这里**没有** `mailer.send`、没有码行、没有 `email_sent` 键（缺席 = 还没发）。
  return sendJson(res, 200, {
    status: 'second_factor_choice',
    pending_token: pending.token,
    expires_in: pendingTtlSeconds,
    methods: ['totp', 'email_code'],
    email_hint: maskEmail(email),
    email_code_ttl_seconds: policy.ttlSeconds,
    email_deferred: true,
  });
}

/**
 * `POST /api/auth/login/email-code`（portal.md §2.3a）：校验邮箱验证码 → 建会话。
 * 失败一律 `401 email_code_invalid`（不区分「码错」与「码不存在」，防探测；`too_many_attempts` 同样映射，
 * 只是 message 说明要重走第一步）；`pending_token` 无效/已用/过期 → 复用 `401 pending_expired`。
 */
async function handleLoginEmailCode(req, res, ctx) {
  const { pool, config } = ctx;
  requireJson(req);
  const body = await readJsonBody(req);
  const pendingToken = typeof body.pending_token === 'string' ? body.pending_token : '';
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!pendingToken || !code) {
    throw new HttpError(400, 'validation_failed', 'pending_token 与 code 均为必填', { en: 'Both pending_token and code are required' });
  }

  const ip = clientIp(req);
  // 非消费读取（码错可重试，不烧 pending）；成功才原子消费。
  const userId = await auth.findPendingUser(pool, pendingToken);
  if (!userId) {
    throw new HttpError(401, 'pending_expired', 'pending_token 过期或已使用，请重新登录', { en: 'pending_token expired or already used, please log in again' });
  }

  // 账户 + IP 失败计数（换新 pending_token 不重置，防 6 位码爆破）。
  const limiterKey = `emailcode:${userId}:${ip}`;
  const check = ctx.emailCodeLimiter.check(limiterKey);
  if (!check.allowed) {
    throw new HttpError(429, 'rate_limited', '尝试过于频繁，请稍后再试', {
      en: 'Too many attempts, please try again later',
      retryable: true,
      headers: { 'Retry-After': String(check.retryAfterSeconds) },
    });
  }

  const result = await loginEmailCode.verifyEmailCode(pool, {
    pendingTokenHash: auth.hashToken(pendingToken),
    code,
    now: new Date(),
  });
  if (!result.ok) {
    ctx.emailCodeLimiter.recordFailure(limiterKey);
    const message = result.reason === 'too_many_attempts'
      ? '验证码尝试次数已用尽，请重新登录获取新验证码'
      : '验证码错误或已失效';
    throw new HttpError(401, 'email_code_invalid', message);
  }

  const consumedUserId = await auth.consumePendingToken(pool, pendingToken);
  if (!consumedUserId) {
    throw new HttpError(401, 'pending_expired', 'pending_token 过期或已使用，请重新登录', { en: 'pending_token expired or already used, please log in again' });
  }
  ctx.emailCodeLimiter.reset(limiterKey);

  const loaded = await auth.loadActiveUser(pool, consumedUserId);
  if (!loaded) {
    throw new HttpError(401, 'pending_expired', 'pending_token 过期或已使用，请重新登录', { en: 'pending_token expired or already used, please log in again' });
  }

  // #677 P2a：会话 TTL 热读（DB > env > 默认，5s 缓存；见 `/api/me` 那一段的完整口径）。
  const ttlSeconds = await runtimeSettings.readSessionTtlSeconds({ pool, config, log: ctx.log });
  const session = await auth.createSession(pool, loaded.user.id, {
    ip,
    userAgent: req.headers['user-agent'] ?? null,
    ttlSeconds,
  });
  // 审计要能区分「走的是哪条」：同一枚 pending 可以是 `second_factor_choice` 签发的（该账号有 TOTP），
  // 用户选了邮件码 = 主动走了较弱的那一条 ⇒ 记 `email_code_alt`（#449 OR 语义的可审计口径）。
  // 无 TOTP 的账号（`email_code_required`）仍是 `email_code`（现状值不改）。
  // feat-261110-02：`alt` 的语义是「**明明有可用的 TOTP 却选了较弱的那条**」。管理员把
  // `totp_login_enabled` 关掉之后，邮件码是这个账号**唯一**被允许的第二因素，没有「放弃更强的一条」
  // 这回事 ⇒ 记 `email_code`，否则审计会让人以为运维在两档里挑了弱的（而界面上根本没有第二档）。
  const totpWasUsable = (await auth.hasTotpEnrollment(pool, loaded.user.id))
    && loaded.totpLoginEnabled !== false;
  const loginMethod = totpWasUsable ? 'email_code_alt' : 'email_code';
  await auditLoginSuccess(pool, loaded.user, loginMethod);
  await auth.audit(pool, {
    actorId: loaded.user.id,
    action: 'auth.email_code_verified',
    target: loaded.user.login,
    details: { login: loaded.user.login, method: loginMethod, at: new Date().toISOString() },
  }).catch(() => {});

  return sendJson(
    res,
    200,
    // #255：与 §2.3（TOTP 第二步）逐字同口径——`password_change_required` 恒为布尔且必须出现。
    { password_change_required: loaded.mustChangePassword === true, user: loaded.user },
    { 'Set-Cookie': sessionCookieHeader({ ...config.cookie, maxAge: ttlSeconds }, session.token) },
  );
}

/**
 * `POST /api/auth/login/email-code/resend`（portal.md §2.3b）：重发验证码。
 * 重发**必须换新码并作废旧码**；冷却中/超次数 ⇒ `429 rate_limited` + `Retry-After`；
 * pending 无效 ⇒ `401 pending_expired`。发信失败同 §2.3a：`503 email_send_failed`，pending 保留。
 */
async function handleLoginEmailCodeResend(req, res, ctx) {
  const { pool, config } = ctx;
  requireJson(req);
  const body = await readJsonBody(req);
  const pendingToken = typeof body.pending_token === 'string' ? body.pending_token : '';
  if (!pendingToken) {
    throw new HttpError(400, 'validation_failed', 'pending_token 为必填', { en: 'pending_token is required' });
  }

  const ip = clientIp(req);
  const userId = await auth.findPendingUser(pool, pendingToken);
  if (!userId) {
    throw new HttpError(401, 'pending_expired', 'pending_token 过期或已使用，请重新登录', { en: 'pending_token expired or already used, please log in again' });
  }

  // 按 IP 计发信频率（重发也计数：被当成邮件放大器时最先撞这条）。
  const sendKey = `email:${ip}`;
  const sendCheck = ctx.emailSendLimiter.check(sendKey);
  if (!sendCheck.allowed) {
    throw new HttpError(429, 'rate_limited', '发信过于频繁，请稍后再试', {
      en: 'Sending is too frequent, please try again later',
      retryable: true,
      headers: { 'Retry-After': String(sendCheck.retryAfterSeconds) },
    });
  }

  const loaded = await auth.loadActiveUser(pool, userId);
  if (!loaded) {
    throw new HttpError(401, 'pending_expired', 'pending_token 过期或已使用，请重新登录', { en: 'pending_token expired or already used, please log in again' });
  }
  if (!loaded.email) {
    throw new HttpError(
      409,
      'email_not_registered',
      '当前账号未登记邮箱，无法接收登录验证码；请联系管理员补录邮箱后再登录',
      { en: 'The current account has no registered email address and cannot receive a login verification code; please contact an administrator to add one, then log in again', retryable: false },
    );
  }

  const policy = emailCodePolicy(config);
  const now = new Date();
  const pendingTokenHash = auth.hashToken(pendingToken);
  // 发信端口：SMTP 配置存 DB，`get()` 是 60s 缓存后的结果（急停/未配置 ⇒ disabled）。
  const mailer = await ctx.mailerProvider.get();
  const gate = await loginEmailCode.recordResend(pool, {
    pendingTokenHash,
    cooldownSeconds: policy.resendCooldownSeconds,
    maxResends: policy.maxResends,
    now,
  });
  if (!gate.ok) {
    // `recordResend` 不再有 `not_found`（该 pending 下一条码行都没有 = 首次发信失败后的重试，
    // 语义上是「首次发信」而不是 401；pending 有效性上面已经由 `findPendingUser` 判过）。
    ctx.emailSendLimiter.recordFailure(sendKey);
    const retryAfter = Math.max(1, Number(gate.retryAfterSeconds ?? 0));
    throw new HttpError(
      429,
      'rate_limited',
      gate.reason === 'max_resends' ? '验证码重发次数已用尽，请重新登录' : '请稍后再试',
      { en: gate.reason === 'max_resends' ? 'The verification code resend limit has been reached, please log in again' : 'Please try again later', retryable: true, headers: { 'Retry-After': String(retryAfter) } },
    );
  }

  const code = loginEmailCode.generateEmailCode();
  // 与首次发信同一顺序契约：**先发信、成功后才落库**。发信失败时既不插新码也不作废旧码
  // ⇒ 用户手上的旧码仍然有效，且「立刻重试」不会被自己没收到的那封信的 created_at 卡 60s。
  // （代价：若发信成功而 INSERT 失败——纯 DB 故障——用户拿到的码不在库里。那是 500 级故障，
  //   与「发信失败被冷却卡 60s」这条**必然发生**的日常路径相比，取舍明确。）
  const sent = await mailer.send({ to: loaded.email, ...emailCodeMessage(code, policy.ttlSeconds) });
  if (!sent.ok) {
    await auth.audit(pool, {
      actorId: loaded.user.id,
      action: 'auth.email_code_failed',
      target: loaded.user.login,
      details: { login: loaded.user.login, reason: sent.reason ?? 'send_failed', at: new Date().toISOString() },
    }).catch(() => {});
    throw new HttpError(503, 'email_send_failed', '验证码邮件发送失败，请稍后重试', {
      en: 'Failed to send the verification code email, please try again later',
      retryable: true,
      headers: { 'Retry-After': '5' },
    });
  }
  ctx.emailSendLimiter.recordFailure(sendKey); // 发信计数（限流器只有这一个计数入口）

  const created = await loginEmailCode.createEmailCode(pool, {
    pendingTokenHash,
    code,
    ttlSeconds: policy.ttlSeconds,
    maxAttempts: policy.maxAttempts,
    resendCount: gate.resendCount,
    ip,
    userAgent: req.headers['user-agent'] ?? null,
    now,
  });
  // 先插新码再作废旧码：插失败不会留下「一枚可用码都没有」的死状态；而校验只认「最新未消费」一条，
  // 所以这段窗口里旧码本来也不会被接受（作废只是把它从「最新未消费」的位置上彻底摘掉）。
  await loginEmailCode.invalidateOtherCodes(pool, {
    pendingTokenHash,
    keepCodeHash: created.codeHash,
    now,
  });

  await auth.audit(pool, {
    actorId: loaded.user.id,
    action: 'auth.email_code_sent',
    target: loaded.user.login,
    details: {
      login: loaded.user.login,
      email_hint: maskEmail(loaded.email),
      code_hash_prefix: created.codeHash.slice(0, 12),
      expires_at: created.expiresAt.toISOString(),
      resend_count: gate.resendCount,
      at: new Date().toISOString(),
    },
  }).catch(() => {});

  return sendJson(res, 200, {
    expires_in: policy.ttlSeconds,
    resend_after: policy.resendCooldownSeconds,
    // 与第一步两个分支同名的字段：登录页的「N 分钟内有效」只有一个来源。
    email_code_ttl_seconds: policy.ttlSeconds,
  });
}

async function handleLoginTotp(req, res, ctx) {
  const { pool, config } = ctx;
  requireJson(req);
  const body = await readJsonBody(req);
  const pendingToken = typeof body.pending_token === 'string' ? body.pending_token : '';
  const code = typeof body.code === 'string' ? body.code : '';
  if (!pendingToken || !code) {
    throw new HttpError(400, 'validation_failed', 'pending_token 与 code 均为必填', { en: 'Both pending_token and code are required' });
  }

  const ip = clientIp(req);

  // 非消费读取：TOTP 错误允许用同一 pending_token 重试（错误码不烧 token）；
  // 只有 TOTP 通过才原子消费（单次消费）。先解出用户，再按「账户 + IP」限流。
  const userId = await auth.findPendingUser(pool, pendingToken);
  if (!userId) {
    throw new HttpError(401, 'pending_expired', 'pending_token 过期或已使用，请重新登录', { en: 'pending_token expired or already used, please log in again' });
  }

  // 账户 + IP 失败计数：换新 pending_token 不重置（口令步成功也不清空），防第二因素爆破。
  const accountKey = `totp:${userId}:${ip}`;
  const accountCheck = ctx.totpLimiter.check(accountKey);
  if (!accountCheck.allowed) {
    throw new HttpError(429, 'rate_limited', '尝试过于频繁，请稍后再试', {
      en: 'Too many attempts, please try again later',
      retryable: true,
      headers: { 'Retry-After': String(accountCheck.retryAfterSeconds) },
    });
  }

  // 单 token 尝试上限（保留原有单 token 爆破防护）。
  const tokenKey = `totp-token:${ip}:${pendingToken}`;
  const tokenCheck = ctx.totpTokenLimiter.check(tokenKey);
  if (!tokenCheck.allowed) {
    throw new HttpError(429, 'rate_limited', '尝试过于频繁，请稍后再试', {
      en: 'Too many attempts, please try again later',
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
    throw new HttpError(401, 'totp_invalid', 'TOTP 校验失败', { en: 'TOTP verification failed' });
  }

  const consumedUserId = await auth.consumePendingToken(pool, pendingToken);
  if (!consumedUserId) {
    throw new HttpError(401, 'pending_expired', 'pending_token 过期或已使用，请重新登录', { en: 'pending_token expired or already used, please log in again' });
  }

  ctx.totpLimiter.reset(accountKey);
  ctx.totpTokenLimiter.reset(tokenKey);
  // #677 P2a：会话 TTL 热读。工单上列了三处消费点（续期 / 口令直通 / 邮件码），**TOTP 这一步是第四处**：
  // 漏掉它的后果不是报错而是「注册了 TOTP 的人登录还是拿 env 的 TTL」，且界面上看不出来。
  const ttlSeconds = await runtimeSettings.readSessionTtlSeconds({ pool, config, log: ctx.log });
  const session = await auth.createSession(pool, result.user.id, {
    ip,
    userAgent: req.headers['user-agent'] ?? null,
    ttlSeconds,
  });
  await auditLoginSuccess(pool, result.user, 'totp');
  const cookieHeader = sessionCookieHeader({ ...config.cookie, maxAge: ttlSeconds }, session.token);
  // #255：与上一直通分支同口径——第二步才是本分支真正发会话的地方，受限旗标必须在这里带出去
  // （否则注册了 TOTP 的受限账号只能靠「第一个请求返 403」发现自己要改密）。
  return sendJson(res, 200, { password_change_required: result.mustChangePassword === true, user: result.user }, {
    'Set-Cookie': cookieHeader,
  });
}

/**
 * 成功登录审计（`audit_log.action='auth.login_success'`）：各成功分支各写一条，`method` 四值——
 * `password_direct_no_second_factor`（未注册 TOTP 且邮件通道未启用，口令直通）、
 * `totp`（TOTP 校验通过）、`email_code`（邮箱验证码校验通过且该账号无 TOTP，issue #449）、
 * `email_code_alt`（邮箱验证码校验通过、但**该账号同时有 TOTP** ⇒ 用户走的是 `second_factor_choice`
 * 里较弱的那一条，#449 二选一；运维拿这个值就能查出「本来有 TOTP 却用邮件码进来」）。
 * details 只记 login / method / at，**不含口令、TOTP 码、邮箱验证码、session token 等敏感字段**。
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
// #736：把 `res` 挂到 `req` 上，供 `resolveSession` 在令牌命中时**就地**发 `X-Auth-Method: api_token`
// （`setHeader` 会被后续 `writeHead` 并入，早于 handler 发响应 ⇒ 安全）。仅派发层写入。
const REQ_RES = Symbol('station.request.res');

/**
 * 解析当前请求的会话；无凭证 / 会话失效 ⇒ `null`（**不抛错**，401 的语义归 `requireSession`）。
 * #736 认证缝：cookie 命中走既有路径（不发 `X-Auth-Method`）；cookie miss 才试 Bearer，
 * 命中则发该头并节流写 `last_used_at`。cookie 与 Bearer 同时出现 ⇒ 400（不猜）；非 Bearer
 * scheme ⇒ 401。后两种在解析时抛 `HttpError`（经 `restrictedSessionBlocked` /
 * `requireSession` 冒到统一错误信封）。
 */
async function resolveSession(req, ctx) {
  if (req[REQ_SESSION] !== undefined) return req[REQ_SESSION];
  const cookieToken = getCookie(req, ctx.config.cookie.name);
  const bearer = getBearerToken(req);
  // 设计点 6：cookie 与 Bearer 同时出现 ⇒ 不猜客户端想用哪个（先于 scheme 判定，
  // 因为「两条凭证同时存在」本身就是要拒的事）。
  if (cookieToken && bearer.present) {
    throw new HttpError(
      400, 'ambiguous_credential',
      'cookie 与 Bearer 令牌不能同时用于同一请求（二选一）', { en: 'A cookie and a Bearer token cannot be used in the same request (choose one)' },
    );
  }
  if (cookieToken) {
    req[REQ_SESSION] = await auth.findSessionUser(ctx.pool, cookieToken);
    return req[REQ_SESSION];
  }
  // cookie miss：试 Bearer（脚本/agent 不登录、不寄邮件）。
  if (bearer.present) {
    if (bearer.badScheme) {
      throw new HttpError(401, 'unsupported_scheme', 'Authorization 只支持 Bearer scheme', { en: 'Authorization only supports the Bearer scheme' });
    }
    const viaToken = bearer.token
      ? await apiTokens.findApiTokenUser(ctx.pool, bearer.token)
      : null;
    req[REQ_SESSION] = viaToken;
    if (viaToken) {
      req[REQ_RES]?.setHeader?.('X-Auth-Method', 'api_token');
      // 节流写 last_used_at（设计点 8）：best-effort，失败不影响响应。
      Promise.resolve(apiTokens.touchToken(ctx.pool, viaToken.token.id)).catch(() => {});
    }
    return req[REQ_SESSION];
  }
  req[REQ_SESSION] = null;
  return null;
}

/**
 * 要求有效凭证（cookie 会话或 API 令牌；除登录/forward-auth 外所有公开端点）。
 * #736：无 cookie 但有 Bearer 也算有凭证（交给 `resolveSession` 解析，含 ambiguous/scheme 的抛出）。
 */
async function requireSession(req, ctx) {
  const cookieToken = getCookie(req, ctx.config.cookie.name);
  const bearer = getBearerToken(req);
  if (!cookieToken && !bearer.present) {
    throw new HttpError(401, 'unauthorized', 'unauthorized');
  }
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

  // #677 P3 第五批：预览会话 TTL 现在是**可热改的运行时旋钮**（`preview.session_ttl_seconds`）。
  // 与第二批签票同口径：**同一请求只现读一次**，下面透传给 authorizeForwardAuth（算 expires_at）
  // 与两处 Set-Cookie（算 Max-Age）——会话真到期与 cookie Max-Age 必须同源，否则界面 cookie 还
  // 没过期但库内已过期（或反之）。`readPreviewSessionTtlSeconds` 带 5s 缓存 + 同池在飞合并。
  const sessionTtlSeconds = await runtimeSettings.readPreviewSessionTtlSeconds({
    pool: ctx.pool, config: ctx.config, log: ctx.log,
  });

  const result = await preview.authorizeForwardAuth(ctx.pool, ctx.config, {
    hostname: host || '',
    // 原始 Host（可能带端口）：302 Location 需要保留非默认端口（fix-250923-01，dev 8090/8443）。
    hostHeader: rawHost || '',
    uri,
    cookieValue,
    method,
    scheme,
    accessControlRequestMethod,
    sessionTtlSeconds,
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
      'Set-Cookie': previewCookieHeader(
        ctx.config.previewCookie, result.sessionToken, sessionTtlSeconds),
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
  if (result.cookieToken) {
    headers['Set-Cookie'] = previewCookieHeader(
      ctx.config.previewCookie, result.cookieToken, sessionTtlSeconds);
  }
  sendJson(res, 200, {}, headers);
}

/** 签发一次性预览 ticket（portal.md §2.8）。 */
/**
 * 按**当前请求**推导「同一个 host 的另一个入口」的 origin（#450 用户面 HTTPS 8443）。
 *
 * 用在哪两处：预览票的 URL（`previewPublicBaseFromRequest`）与 `/api/site` 的 `userBaseUrl`。
 * 两处的病根是同一个：用户面现在有 `web` 8090（http）与 `websecure` 8443（https）两个入口，而配置里
 * 只有一个 `PUBLIC_BASE_URL` ⇒ https 页面会拿到 `http://…:8090` 的地址（预览是 mixed content，
 * 回工作台链接是**从 https 掉回 http**）。
 *
 * 判据：只用 Traefik 注入的头（`X-Forwarded-Proto` + `Host` 的端口）。没有协议头（直连 portal、
 * 测试桩）⇒ `null` ⇒ 调用方退回配置（旧行为逐字不变）。
 *
 * `expectHost` 给了就只在「请求确实打在这个 host 上」时才跟随——管理台 host 问
 * 「用户面在哪」时不能拿管理台的 host 去拼用户面 URL。
 */
/** 配置里的用户面 hostname（解析不出来 ⇒ null，`entryBaseFromRequest` 就不做 host 校验）。 */
function configuredUserHostname(publicBaseUrl) {
  try {
    return new URL(publicBaseUrl).hostname;
  } catch {
    return null;
  }
}

function entryBaseFromRequest(req, { expectHost = null } = {}) {
  const pick = (v) => (typeof v === 'string' ? v.split(',')[0].trim() : '');
  const proto = pick(req.headers['x-forwarded-proto']);
  if (proto !== 'http' && proto !== 'https') return null;
  const host = pick(req.headers['x-forwarded-host']) || pick(req.headers.host);
  if (!host) return null;
  const hostname = /^\[/.test(host) ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  if (expectHost && hostname.toLowerCase() !== expectHost.toLowerCase()) return null;
  const forwardedPort = pick(req.headers['x-forwarded-port']);
  const hostPort = /:\d+$/.test(host) ? host.slice(host.lastIndexOf(':') + 1) : '';
  const port = forwardedPort || hostPort;
  return port ? `${proto}://${hostname}:${port}` : `${proto}://${hostname}`;
}

/**
 * 按**当前请求**推导「预览 URL 该用哪个 scheme/端口」（#450 用户面 HTTPS 8443）。
 *
 * 为什么必须跟随请求：用户面有两个入口（`web` 8090 http / `websecure` 8443 https），预览 host 也挂了
 * 同一对入口。若 https 页面里拿到 `http://<host>:8090` 的预览地址，页内 fetch 会被浏览器按 mixed content
 * 直接拦掉（顶层导航也会掉进「不安全」页）—— 那不是配错，是两个入口共用一个 `PUBLIC_BASE_URL` 的必然结果。
 *
 * 判据只用 Traefik 注入的头（`X-Forwarded-Proto` / `Host` 的端口部分）：
 *  · 没有 `X-Forwarded-Proto`（直连 portal、测试桩）⇒ 返回 `null` ⇒ 调用方退回配置（旧行为逐字不变）；
 *  · 端口缺失（生产 443/80 默认端口）⇒ 不带端口（`URL.port` 对默认端口本就返回空串，口径一致）。
 */
function previewPublicBaseFromRequest(req) {
  // 预览 host 与用户面 host 是**不同的域名**（`<fde>-p-<port>.<伞域>` vs `station.<伞域>`），
  // 所以这里只借 scheme/端口，host 部分交给 `previewUrl()` 用 allocation 的 hostname 拼。
  const base = entryBaseFromRequest(req);
  if (base === null) return null;
  // 只借 scheme/端口，host 交给 `previewUrl()`（预览 host 与用户面 host 不是同一个域名）。
  try {
    const u = new URL(base);
    return u.port ? `${u.protocol}//preview.invalid:${u.port}` : `${u.protocol}//preview.invalid`;
  } catch {
    return null;
  }
}

async function handlePreviewTicket(req, res, ctx, portId) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  await readJsonBody(req); // 无体（空 JSON {}）

  const ip = clientIp(req);
  const rlKey = `ticket:${session.user.id}:${ip}`;
  const check = ctx.previewTicketLimiter.check(rlKey);
  if (!check.allowed) {
    throw new HttpError(429, 'rate_limited', '预览 ticket 签发过于频繁，请稍后再试', {
      en: 'Preview ticket issuance is too frequent, please try again later',
      retryable: true,
      headers: { 'Retry-After': String(check.retryAfterSeconds) },
    });
  }

  // #677 P3 第二批返修：单据端点也**现读**热旋钮（与批量端点同一口径、同一个
  // `readPreviewTicketTtlSeconds`）——上一轮只改了批量，同一个旋钮两处消费点就出现两种行为
  // （运维改了值，批量票变了、单据票没变）。⚠ 这一行**不是**「每个请求都发一次 DB 读」：只在
  //   **签发预览票**这一次走；`readPreviewTicketTtlSeconds` 带 5s 缓存 + 同池在飞合并，同进程
  //   同池最多 5 秒一次整表读；管理台写完会失效缓存，本进程下一次签票就用新值。
  const ticketTtlSeconds = await runtimeSettings.readPreviewTicketTtlSeconds({
    pool: ctx.pool, config: ctx.config, log: ctx.log,
  });
  const result = await preview.issuePreviewTicket(ctx.pool, ctx.config, {
    allocationId: portId,
    session,
    ip,
    ua: req.headers['user-agent'] ?? null,
    publicBaseUrl: previewPublicBaseFromRequest(req),
    ticketTtlSeconds,
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
 *  ① **复用** `preview.issuePreviewTicket`（幂等/哈希/过期/审计口径只有一份；本文件不复制签发逻辑。
 *     口径修正：#677 P3 第二批返修给本体加了一个**显式 TTL 入参** `ticketTtlSeconds`（缺省取
 *     `config.previewTicketTtlSeconds` ⇒ 不传参的旧调用逐字不变），除此之外签发逻辑仍只有一份）；
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
  const body = await readJsonBody(req);
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
  const ip = clientIp(req);
  const rlKey = `ticket:${session.user.id}:${ip}`;
  const check = ctx.previewTicketLimiter.check(rlKey);
  if (!check.allowed) {
    throw new HttpError(429, 'rate_limited', '预览 ticket 签发过于频繁，请稍后再试', {
      en: 'Preview ticket issuance is too frequent, please try again later',
      retryable: true,
      headers: { 'Retry-After': String(check.retryAfterSeconds) },
    });
  }

  // ④ 逐张签发（同一 `now` ⇒ 整批同一个 expires_at，响应里不用为每张票各算一次 TTL）。
  // #677 P3 第二批：预览票有效期现在是**可热改的运行时旋钮**（`runtime_settings.preview.
  // ticket_ttl_seconds`）。⚠ 这一行**不是**「每个请求都发一次 DB 读」：只在**签发预览票**
  //   这一次走；且 `readPreviewTicketTtlSeconds` 带 5s 缓存 + 同池在飞合并，同进程同池
  //   最多 5 秒一次整表读（口径与会话 TTL 那格逐字相同）。管理台改完 → 本进程下一次
  //   签票就用新值（写路径会失效缓存）；别的副本最多 5 秒追上。票的其它语义（`expiresAt`
  //   的算法、响应形状）一概不动，只把「用哪个秒数」从启动快照改成现读。
  // ⚠ 同一请求**只现读一次**：下面循环里每张票与 ⑤ 的审计都复用同一个 `ticketTtlSeconds`
  //   （不是多调一次：两次调用会命中 5s 缓存，但同一批票的两个数必须同源，不靠缓存当保证）。
  const now = new Date();
  const ua = req.headers['user-agent'] ?? null;
  const publicBaseUrl = previewPublicBaseFromRequest(req);
  const ticketTtlSeconds = await runtimeSettings.readPreviewTicketTtlSeconds({
    pool: ctx.pool, config: ctx.config, log: ctx.log,
  });
  const issued = [];
  try {
    for (const target of targets) {
      const result = await preview.issuePreviewTicket(ctx.pool, ctx.config, {
        allocationId: target.id, session, ip, ua, now, publicBaseUrl, ticketTtlSeconds,
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

  // ⑤ 审计逐张各一行（不写 url —— 它带票）。`ticketTtlSeconds` 复用 ④ 那一次现读（见上），
  //    所以审计里的 `expires_at`、响应里的 `expires_at` 与票在库里的 `expires_at` 同一个数。
  const expiresAt = new Date(now.getTime() + ticketTtlSeconds * 1000).toISOString();
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
  const body = await readJsonBody(req);
  // #677 Tier 2A：口令长度上限是热读旋钮 ⇒ 本请求现读一次，喂给两处 validatePassword/changeOwnPassword。
  const ownMaxPasswordLength = await runtimeSettings.readMaxPasswordLength({
    pool: ctx.pool, config: ctx.config, log: ctx.log,
  });
  const limits = { maxPasswordLength: ownMaxPasswordLength };
  const currentPassword = body?.current_password;
  const newPassword = body?.new_password;
  // 形状校验放在限流/验哈希之前：畸形请求不该消耗 scrypt 配额。
  admin.validatePassword(currentPassword, limits, { field: 'current_password' });
  admin.validatePassword(newPassword, limits, { field: 'new_password' });
  // `confirm_password` 故意不在这里比：它是「新口令那一组」的语义校验，要落在旧口令校验**之后**
  // （不能让一个还没通过旧口令校验的人因为这条新规则看到新响应），理由见 `admin.changeOwnPassword`。
  const confirmPassword = body?.confirm_password;

  const ip = clientIp(req);
  const rlKey = `password:${session.user.id}:${ip}`;
  const check = ctx.loginLimiter.check(rlKey);
  if (!check.allowed) {
    throw new HttpError(429, 'rate_limited', '尝试过于频繁，请稍后再试', {
      en: 'Too many attempts, please try again later',
      retryable: true,
      headers: { 'Retry-After': String(check.retryAfterSeconds) },
    });
  }

  try {
    await ctx.kdfSemaphore.acquire();
  } catch (err) {
    if (err?.code === 'kdf_queue_full' || err?.code === 'kdf_queue_timeout') {
      throw new HttpError(503, 'kdf_busy', '服务繁忙，请稍后重试', {
        en: 'Service is busy, please try again later',
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
 * POST /api/files/upload?cwd=&path=&name=[&overwrite=1] → 201/200 `{ path, bytes, overwritten }`
 * （issue #472 片 B，契约与三条闸门顺序的理由见 docs/api/portal.md §4.14）。
 *
 * 顺序本身就是契约（评审 blocker 5 + major 12）：
 *   1. 会话 → 2. 工位 → 3. **能力位 `file_upload_enabled`** → 4. jail/名字/存在性校验（在
 *      `receiveUpload` 内部，全在打开 temp 之前）→ 5. 流式落盘 → 6. 提交。
 * ⚠ 能力位必须在**读 body 之前**：否则一个没开上传的账号可以用一个 32MiB 的 PUT 把 portal 的
 * 内存/带宽花掉才被拒（而 portal 与全站共用一个进程）。判据直接数请求体的 `data` 事件次数。
 * ⚠ **不走 `readJsonBody`/`readRawBody`**：JSON 请求体上限默认 64 KiB（`http.js` 的 `DEFAULT_JSON_BODY_LIMIT`），走它任何真实上传都会 413；
 *    上限在流式写入里逐 chunk 兜，值由 `upload_settings` 单行表 → `FILE_UPLOAD_MAX_BYTES` → 默认 32MiB
 *    依次回落（#485 片 A：管理台可改且改完立即生效，见 `portal/src/upload-settings.js`）。
 * 属主两个值都传（只传 uid 会留下 gid=0=root 组，agent 改不动），口径见 docs/design/user-space.md §6.2。
 */
async function handleFileUpload(req, res, ctx, url) {
  const session = await requireSession(req, ctx);
  const fdeName = session.user.fde_name;
  if (!fdeName) {
    throw new dirs.DirError('fde_name_required', '当前用户未分配工位，无处可上传', { httpStatus: 400, en: 'the current user has no seat assigned, so there is nowhere to upload' });
  }
  // 能力位（片 A 的 per-user 开关）。`=== true`：缺键 / `'true'` / 1 都算未开（与前端 v-if 同口径）。
  if (session.user.file_upload_enabled !== true) {
    throw new dirs.DirError('upload_disabled', '该账号未开启文件上传，请让管理员在管理台开启', {
      httpStatus: 403,
      details: { action: 'enable_in_admin_console' },
      en: 'file upload is not enabled for this account; please ask an administrator to enable it in the admin console',
    });
  }
  // #485 片 A：上限在**请求时**现取（`DB > env > 默认`，无缓存）⇒ 管理台改完下一次上传就生效，
  // 不需要重启 portal。两个位置约束：
  //   * 必须在能力位**之后**——#472 的判据是「没开上传的账号不能先把 body 抽干再被拒」，这里只多
  //     一次单行主键 SELECT（不碰 `req` 流），所以不会破那条判据；
  //   * 必须在开 temp **之前**——超限行不该先落盘再删。
  // 读侧永不抛（表缺失 / DB 抖动 / 值非法 ⇒ 回落 env + warn），所以上传不会因为配置面而 500。
  const limit = await uploadSettings.resolveEffectiveMaxFileBytes({
    pool: ctx.pool, config: ctx.config, log: ctx.log,
  });
  let result;
  try {
    result = await dirs.receiveUpload({
      userSpaceRoot: ctx.config.userSpaceRoot,
      fdeName,
      cwd: url.searchParams.get('cwd'),
      relPath: url.searchParams.get('path') ?? '.',
      name: url.searchParams.get('name') ?? '',
      stream: req,
      maxBytes: limit.maxBytes,
      overwrite: url.searchParams.get('overwrite') === '1',
      uid: ctx.config.fdeUid,
      gid: ctx.config.fdeGid,
    });
  } catch (err) {
    // 把**来源**补进 413 的 `details`：`max_bytes` 已是生效值（`receiveUpload` 直接回弹它收到的 maxBytes），
    // 再标一下它是 DB / env / 默认，值班就不用去猜该改哪一边。不改状态码与错误码（零新错误码）。
    if (err instanceof dirs.DirError && err.code === 'file_too_large') {
      err.details = { ...(err.details ?? {}), limit_source: limit.source };
    }
    throw err;
  }
  // 201 = 新建；200 = 覆盖（`overwrite=1` 且真的提交掉了旧内容）。DTO 见 §4.14。
  return sendJson(res, result.overwritten ? 200 : 201, result);
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
      // #726：res 先毁时 pipe 只 unpipe 不停源流；随 res 'close' 毁源流
      // ⇒ FileHandle 自己关 fd（正常结束时 destroy 已关流是空操作）。
      res.on('close', () => opened.stream.destroy());
      opened.stream.pipe(res);
    } else {
      res.end(); // 416：只有头没有体
    }
    return undefined;
  }
  if (mode !== '' && mode !== 'json') {
    throw new HttpError(400, 'validation_failed', 'mode 只支持 json|stream|download', { en: 'mode only supports json|stream|download', details: { field: 'mode' } });
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
 * issue #359 P0a：`GET /api/git-light?cwd=~/projects/<name>` → 一颗「收工灯」的完整判定。
 * 只读零写；作用域 = 当前会话用户的工位（不会扫全平台）；实现与口径见 `portal/src/gitlight.js`。
 * 错误沿用 `dirs.DirError` 同一条映射（cwd 非法 ⇒ 400，目录不存在 ⇒ 404）。
 */
async function handleGitLight(req, res, ctx, url) {
  const session = await requireSession(req, ctx);
  if (!session.user.fde_name) {
    throw new dirs.DirError('fde_name_required', '当前用户未分配工位', { httpStatus: 400, en: 'the current user has no seat assigned' });
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
// issue #500：恢复行比轮记录小得多（`tool-executed` 实测百字节量级），但 `partial-text` 带**整段
// 未收敛正文**（契约会跟着文本长，不截断不封顶），闸得给它留地方。
// ⚠ 这一层是**传输级 413**，必须比 internal.js 的**业务级 400**（`MAX_RECOVERY_ROW_BYTES` = 512 KiB）
// **宽**：反过来了 oversized 的 body 会先被这里 413 掉，报信里就只剩「太大」，没有 internal 那条
// `details.bytes/limit` 可指认。今天本站不开 `partialPersistence`（#301）⇒ 真走到这个量级就是上游开了开关。
const INTERNAL_RECOVERY_ROW_LIMIT = 640 * 1024;
// **内部大 body 上限**（不是哪个端点专属）：今天只有两个 `/runstate` PUT 用它——
// run-state 快照随会话长度增长（上下文压缩摘要 / 折叠事实 / 工具清单都能撑进去），量级远超轮记录。
// 名字由来：它原本叫 `INTERNAL_CHECKPOINT_LIMIT`（给快照表的 body 用，
// issue #640 已连同四个 `/checkpoint*` 端点一起删），**常量本身活了下来** ⇒ 改名成按语义自解释。
// 新加大 body 的内部端点若量级相当，复用它是故意的（不是历史残留）。
const INTERNAL_LARGE_BODY_LIMIT = 2 * 1024 * 1024;

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
    const body = await readJsonBody(req);
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
  // #608 §7.2：MCP 配置下发（**只给 agentd**：per-container token 鉴权；worker 没有 token）。
  // 返回的是**已解析的明文值**——这是「凭据平台注入」的唯一出口，所以：
  //   ① 只对**自己这台容器所属的 FDE** 发（identity.user 由 token 推出，不接受 query 指定）；
  //   ② 审计只记 server / 槽位名，绝不记值；
  //   ③ 响应不缓存（no-store），避免中间层留存。
  if (pathname === '/api/internal/mcp/servers') {
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    // ⚠ `fde_name` 在 `identity.container` 上，**不在** `identity.user` 上（真机 e2e 抓到的）：
    // 写成 `user.fde_name` ⇒ 恒 undefined ⇒ 早退空清单 ⇒ 症状是「装了 MCP 但 run 里 declared=1
    // registered=0 missing=1」，而 portal 侧一切正常（没有任何报错）。
    const fde = { id: user.id, name: container?.fde_name };
    if (!fde.name) {
      ctx.log?.warn?.('[internal/mcp] container identity 缺 fde_name，无法解析 MCP 配置');
      return sendJson(res, 200, { servers: [], missing: [] });
    }
    let out;
    try {
      out = await market.resolveMcpServersForFde({ pool: ctx.pool, fde });
    } catch (err) {
      // 缺 key / 解密全失败 ⇒ 降级成「一台都没有」，让 run 正常继续（不把 run 打死）。
      ctx.log?.warn?.(`[internal/mcp] resolve failed fde=${fde.name}: ${err.message}`);
      out = { servers: [], missing: [] };
    }
    res.setHeader('cache-control', 'no-store');
    await auth.audit(ctx.pool, {
      actorId: null,
      action: 'internal.mcp_servers_resolved',
      target: `fde:${fde.name}`,
      details: {
        servers: out.servers.map((s) => s.name),
        slots: out.servers.flatMap((s) => Object.keys(s.values ?? {})),
        missing: out.missing,
      },
    }).catch(() => {});
    return sendJson(res, 200, out);
  }
  if (pathname === '/api/internal/mcp/tools-cache') {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    requireJson(req);
    const body = await readJsonBody(req);
    const slug = typeof body?.slug === 'string' ? body.slug : '';
    if (!market.SKILL_SLUG_RE.test(slug)) {
      throw new HttpError(400, 'validation_failed', 'slug 不合法', { en: 'invalid slug', details: { field: 'slug', slug } });
    }
    const out = await market.recordToolsCache({ pool: ctx.pool, slug, tools: body?.tools ?? [] });
    return sendJson(res, 200, out);
  }
  if (pathname === '/api/internal/heartbeat') {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    requireJson(req);
    const body = await readJsonBody(req);
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
      throw new HttpError(400, 'validation_failed', 'run_id query 参数必填（writer run，租约 fencing）', { en: 'run_id query parameter is required (writer run, lease fencing)', details: { field: 'run_id' } });
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
        throw new HttpError(400, 'validation_failed', 'cursor 必须为 `<round>:<append_seq>` 形式的不透明游标', { en: 'cursor must be an opaque cursor in the form `<round>:<append_seq>`', details: { field: 'cursor' } });
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
    // ⚠ 旧 S4/S5（`PUT /transcript/:key/checkpoint` 与 `GET /transcript/:key/checkpoint/latest`）已随
    //   issue #640 删除：erix-agent 0.33.0 不再读写 run snapshot ⇒ 落到本分支末尾的 **404 `not_found`**
    //   （不是 405：路径本身已不存在，旧 agentd 打过来要当「端点没了」而非「方法不对」）。
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
    // issue #500：账本恢复行三件套（引擎 0.33.0 的可选能力面）。writer fencing 与上面每一个 S 端点
    // **完全一致**（`?run_id=` 已在进入本分支前强制校验 + `X-Claim-Token`）：恢复行只有 session 语义，
    // 本站**没有**为它编 run 作用域兼容面。
    //
    // ⚠ 三个响应形状都是**对象包着一个字段**，不是裸数组/裸布尔：agentd 原样透传 `r.data`，
    // 204 会被解析成 `null` ⇒ 「空」与「读坏了」在 runner 侧就分不开。契约里这两者是两个结局
    //（空数组 = 合法降级；非数组 = `recovery_rows_unreadable` 终局），所以本端点**永不**返回 204。
    if (sub === '/recovery-rows') {
      if (req.method === 'GET') {
        const result = await internal.listSessionRecoveryRows(ctx.pool, base);
        return sendJson(res, 200, result); // {rows:[…]}，空 = {rows:[]}，不是 204
      }
      if (req.method === 'PUT') {
        requireJson(req);
        const body = await readJsonBody(req, INTERNAL_RECOVERY_ROW_LIMIT);
        const result = await internal.appendSessionRecoveryRow(ctx.pool, { ...base, body });
        return sendJson(res, 200, result); // {added:true|false}
      }
      if (req.method === 'DELETE') {
        const result = await internal.clearSessionRecoveryRows(ctx.pool, base);
        return sendJson(res, 200, result); // {cleared:true|false}
      }
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }
    if (sub === '/runstate') {
      if (req.method === 'PUT') {
        requireJson(req);
        const body = await readJsonBody(req, INTERNAL_LARGE_BODY_LIMIT);
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
      const body = await readJsonBody(req);
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
      const body = await readJsonBody(req);
      const result = await internal.releaseRun(ctx.pool, { container, user, runId, claimToken, body });
      return sendJson(res, 200, result);
    }
    // ⚠ 旧 U8/U9（`PUT /runs/:id/checkpoint` 与 `GET /runs/:id/checkpoint/latest`）已随 issue #640 删除
    //   （run snapshot 整条竖切退役）⇒ 两个路径现在落到本函数末尾的 **404 `not_found`**，不是 405/500。
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
        const body = await readJsonBody(req, INTERNAL_LARGE_BODY_LIMIT);
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
        throw new HttpError(413, 'artifact_too_large', 'artifact 超过大小上限', { en: 'artifact exceeds the size limit', details: { max_bytes: maxBytes } });
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
      const body = await readJsonBody(req);
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
