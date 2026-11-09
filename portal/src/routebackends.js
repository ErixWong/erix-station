// issue #474 S2：Traefik 路由后端**白名单**（主防线的判据库）。
//
// 为什么单独一个模块：后端 URL / hostname / 来源网段这三样是「DB 行 → 边缘路由」的唯一咽喉，
// 判据必须**在拼装的那一层**执行（校验输入，不是解析输出），并且能被单测直接打到。
// 拼装点原先在 routes.js 的 readRouteDesiredState 里内联（`http://${octets.join('.')}:${port}`），
// 内联的问题不是「没校验」而是**没有边界**：任何上游污染行都会静默变成一个可路由后端。
//
// 四类允许后端（全部条件都要满足，缺一即抛）：
//   ① portal      —— URL 字符串全等 `config.portalBackendUrl`
//   ② 预览        —— `http://<subnetBase+2>:<port>`：网段在 FDE IPAM 池内 + 前缀等于该 FDE 的分配前缀
//                    + 端口 ∈ [PREVIEW_PORT_POOL_START, PREVIEW_PORT_POOL_END]（闭区间）+ 主机恰为 base+2
//   ③ LLM 网关    —— URL 字符串全等 `config.llmGatewayUrl`
//   ④ noop@internal —— 字面量（Traefik 内建服务引用，不是 URL）
//
// 两条评审补的 HIGH（F1/F2）都不在「URL 形状」这一层，所以本模块同时管 hostname 与 CIDR：
//   · F1：只判「以 `.<伞域>` 结尾」不够——`station.<伞域>` 也满足，而预览 router 的 priority 是 200
//     > portal 的 100，抢注会**赢**。⇒ hostname 必须由 fdeName+port+baseDomain 重算逐字相等，
//     且不得落在平台保留 host 集合内。
//   · F2：`parseCidr()` 只验语法（实测 `0.0.0.0/0` 与 `127.0.0.0/8` 都放行），所以「能解析」
//     ≠「是 FDE 网段」。⇒ `assertFdeSubnet()` 另加网络地址规范 / 池归属 / 前缀 / 与 FDE 关联四条。
//     管理员 `ADMIN_IP_ALLOWLIST` **不受此限**（它可能合法地是宽网段，且它是配置面不是 DB 面）。
//
// 红线（#474 §3）：本模块抛出的错误消息**只含** host / 端口 / 网段 / 文件名这类非敏感字面值，
// 绝不含 YAML 正文、也绝不碰 api key（key 根本不进本模块）。
// 零依赖纪律：不引 YAML parser——第二道「发布前文本断言」用严格文本正则（见文件下半部）。

import { POOLS, parseCidr, ipToInt, intToIp } from './ipam.js';
import { PREVIEW_PORT_POOL_START, PREVIEW_PORT_POOL_END, isPreviewPortInPool } from './previewpool.js';
import { buildHostname } from './projects.js';

/** FDE IPAM 池（与 ipam.js 同一份对象，绝不另抄一份 CIDR）。 */
export const FDE_IPAM_POOLS = Object.values(POOLS);

/** 预览后端固定位：FDE 主容器 = 子网基址 + 2（topology §3/§4-L2）。 */
export const PREVIEW_BACKEND_HOST_OFFSET = 2;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

/**
 * FDE 网段判据（评审 F2）：语法之外还要「网络地址规范 + 池归属 + 前缀」。
 *
 * `parseCidr()` 会把非规范地址**静默 mask 成 base**（`10.200.0.3/29` → base `10.200.0.0/29`），
 * 所以「规范」这条必须自己比 `base === ipInt`：否则一条脏行就能让后端指向网段外的地址。
 *
 * @param {string} cidr 形如 `10.200.1.0/29`
 * @param {{ pools?: typeof POOLS extends any ? any[] : any, expectedPrefix?: number }} [opts]
 *        - pools：池清单（默认取 ipam.js 的 POOLS 值）
 *        - expectedPrefix：该 FDE 记录的分配前缀；给定则必须**逐字相等**；
 *          未给定（第二道文本断言没有 FDE 上下文）⇒ 前缀必须等于**某个池的 prefixLen**，
 *          这仍然挡掉 `0.0.0.0/0`、`127.0.0.0/8`、`10.200.0.0/16`（前缀不是 29/28）。
 * @returns {{cidr: string, base: number, prefixLen: number, pool: object}} 已校验的解析结果
 */
export function assertFdeSubnet(cidr, { pools = FDE_IPAM_POOLS, expectedPrefix } = {}) {
  let parsed;
  try {
    parsed = parseCidr(cidr);
  } catch {
    return fail('fde_subnet_invalid', `subnet is not a valid cidr: ${JSON.stringify(String(cidr))}`);
  }
  // ② 网络地址规范（拒绝 `10.200.0.3/29` 这类主机位非零的脏行）。
  if (parsed.base !== parsed.ipInt) {
    return fail(
      'fde_subnet_not_canonical',
      `subnet is not a canonical network address: ${JSON.stringify(parsed.cidr)} (host bits must be zero)`,
    );
  }
  // ③ 池归属（整段必须完整落在某一个 FDE 池内）。
  const pool = pools.find((p) => {
    const r = parseCidr(p.cidr);
    return r.base <= parsed.base && parsed.last <= r.last;
  });
  if (!pool) {
    return fail('fde_subnet_out_of_pool', `subnet ${parsed.cidr} is outside the FDE IPAM pools`);
  }
  // ④ 前缀：有 FDE 上下文 ⇒ 必须等于该 FDE 的分配前缀；否则 ⇒ 必须等于池前缀（挡宽网段）。
  if (expectedPrefix !== undefined && expectedPrefix !== null) {
    if (parsed.prefixLen !== Number(expectedPrefix)) {
      return fail(
        'fde_subnet_prefix_mismatch',
        `subnet ${parsed.cidr} prefix ${parsed.prefixLen} does not match the assigned prefix ${expectedPrefix}`,
      );
    }
  } else {
    // 池的**分配前缀**（POOLS.prefixLen = 29/28），不是池自己的前缀（/16）：
    // 拿 parseCidr(pool.cidr).prefixLen 会得 {16} ⇒ `10.200.0.0/16` 这类宽网段反而过关。
    const allowedPrefixes = new Set(pools.map((p) => (p.prefixLen ?? parseCidr(p.cidr).prefixLen)));
    if (!allowedPrefixes.has(parsed.prefixLen)) {
      return fail(
        'fde_subnet_prefix_mismatch',
        `subnet ${parsed.cidr} prefix ${parsed.prefixLen} is not an FDE allocation prefix (${[...allowedPrefixes].join('/')})`,
      );
    }
  }
  return { ...parsed, pool };
}

/**
 * 平台保留 host 集合（评审 F1）：预览 host 不得占用这些名字。
 * 从 config 取，不写死：写死 `station.` 就会在 `PORTAL_HOST` 改名时静默失效。
 */
export function reservedPlatformHosts(config = {}) {
  const set = new Set();
  for (const h of [config.portalHost, config.adminHost, config.llmHost]) {
    if (typeof h === 'string' && h !== '') set.add(h);
  }
  for (const h of config.portalInternalHosts ?? []) {
    if (typeof h === 'string' && h !== '') set.add(h);
  }
  return set;
}

/**
 * 预览后端的**唯一**构造点（同时是它的校验点）。
 *
 * 校验输入而不是解析输出：URL 一旦拼出来就已经是「边缘上的后端」了，再解析回去只是自我确认。
 *
 * @param {{
 *   subnet: string,          // 该 FDE 的网段（fde_networks.subnet）
 *   prefix?: number,         // 该 FDE 记录的分配前缀（缺省 ⇒ 用池前缀口径）
 *   port: number|string,     // 预览端口
 *   hostname?: string,       // port_allocations.hostname（给定则必须与重算值逐字相等）
 *   fdeName?: string,        // 用于重算 hostname
 *   baseDomain?: string,     // 伞域
 *   pools?: any[],
 *   reservedHosts?: Set<string>,
 * }} input
 * @returns {string} `http://<subnetBase+2>:<port>`
 */
export function buildPreviewBackend(input = {}) {
  const {
    subnet, prefix, port, hostname, fdeName, baseDomain,
    pools = FDE_IPAM_POOLS, reservedHosts = null,
  } = input;

  // 1) 网段：语法 + 规范 + 池归属 + 前缀（F2）。
  const parsed = assertFdeSubnet(subnet, { pools, expectedPrefix: prefix });

  // 2) 端口：整数 + 池内闭区间（判据与 previewpool 同一份常量，不另写 22000/29999）。
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || !isPreviewPortInPool(portNum)) {
    return fail(
      'preview_port_out_of_pool',
      `preview port ${JSON.stringify(port)} is outside the pool [${PREVIEW_PORT_POOL_START}, ${PREVIEW_PORT_POOL_END}]`,
    );
  }

  // 3) 主机必须恰为 subnetBase+2（拼出来就是它，这里不做二次解析）。
  const backendIp = (parsed.base + PREVIEW_BACKEND_HOST_OFFSET) >>> 0;
  const backendUrl = `http://${intToIp(backendIp)}:${portNum}`;

  // 4) hostname（评审 F1）：重算 + 逐字相等 + 不落保留集。
  //    只在调用方给了 hostname 时判——纯算 URL 的老调用方（无域名上下文）不受影响。
  if (hostname !== undefined && hostname !== null) {
    if (typeof fdeName !== 'string' || fdeName === '' || typeof baseDomain !== 'string' || baseDomain === '') {
      return fail('preview_hostname_unverifiable', 'hostname given without fdeName/baseDomain to recompute it from');
    }
    const expected = buildHostname({ fdeName, port: portNum, baseDomain });
    if (hostname !== expected) {
      return fail(
        'preview_hostname_mismatch',
        `allocation hostname ${JSON.stringify(hostname)} does not equal the recomputed ${JSON.stringify(expected)}`,
      );
    }
    const reserved = reservedHosts instanceof Set ? reservedHosts : reservedPlatformHosts(reservedHosts ?? {});
    if (reserved.has(hostname)) {
      return fail(
        'preview_hostname_reserved',
        `allocation hostname ${JSON.stringify(hostname)} collides with a reserved platform host (preview routers win on priority 200 > 100)`,
      );
    }
  }

  return backendUrl;
}

// ---------------------------------------------------------------------------
// 第二道：发布前对**最终文本**的结构断言（评审 §4.4「两道都要」）
// ---------------------------------------------------------------------------
// 为什么不引 YAML parser（零依赖纪律）：这里要的不是「读懂 YAML」，而是「没有任何一行能
// 逃出白名单」。逐行匹配 `url:` / `Host()` / `ClientIP()` 这三种**由本仓库自己生成**的形态
// 就够了——生成器输出的形状是稳定的（routes.yml / llm-routes.yml 都是行数组 join）。
// 残余（写不下的表达力）：本断言不理解 YAML 语义，所以① 缩进/引号风格变了就匹配不到；
// ② 它只能证明「匹配到的每一行都在允许集合内」，不能证明「没有多余的键」。
// 这两条残余由第一道（构造期判据 + 生成器只接受白名单输入）兜住，写在这里而不是藏起来。

/** `url:` 行（生成器固定输出 `          - url: "..."`）。 */
const URL_LINE_RE = /^\s*-\s*url:\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*$/;
/** `Host(\`...\`)` 出现的全部位置（rule 行里可能有多条）。 */
const HOST_RE = /Host\(`([^`]+)`\)/g;
/** `ClientIP(\`<cidr>\`)`。 */
const CLIENT_IP_RE = /ClientIP\(`([^`]+)`\)/g;
/** ipAllowList 的 sourceRange flow list（生成器永远写成 `["a", "b"]`）。 */
const SOURCE_RANGE_RE = /^\s*sourceRange:\s*\[([^\]]*)\]\s*$/;
/** 中间件名行（`  middlewares:` 节下的四空格缩进键）。 */
const MW_NAME_RE = /^    ([a-z0-9-]+):$/;
/** `  middlewares:` / `  services:` 节切换。 */
const SECTION_RE = /^  ([a-z]+):$/;
/**
 * 哪些 ipAllowList 中间件的 sourceRange 受 FDE 池约束：
 *   · `internal-allow` —— 它的来源集 = 全部 FDE 网段，脏行会变成「谁都能打 `/api/internal`」（= 平台的
 *     agentd 入口，带虚拟身份），所以必须同 `ClientIP()` 一样在池内；
 *   · `admin-allow`（ADMIN_IP_ALLOWLIST）与 `admin-deny`（硬编码 192.0.2.0/24）**不受池限**（评审 F2 第 6 条）。
 */
const POOLED_SOURCE_RANGE_MIDDLEWARES = new Set(['internal-allow']);
/** 未加引号的 `url:` 值（生成器总是加引号；不加引号 ⇒ 形态漂移，也要拦）。 */
const URL_LINE_BARE_RE = /^\s*-\s*url:\s*(\S[^\n]*)$/;

function unquoteYamlDouble(s) {
  return s.replace(/\\(["\\])/g, '$1');
}

/** 池前缀的预览 host 子模式（每池一条：`10\.200\.\d{1,3}\.\d{1,3}`）；首两段从 POOLS 派生，不写死。 */
function poolHostPatterns(pools) {
  return pools.map((p) => {
    const head = intToIp(parseCidr(p.cidr).base).split('.').slice(0, 2).join('\\.');
    return `${head}\\.\\d{1,3}\\.\\d{1,3}`;
  });
}

/**
 * 一个「预览后端 host」是否合法：必须是某块**对齐**的 FDE 池内子网的 base+2。
 * 与 `buildPreviewBackend` **独立实现**（那里是「由网段拼出来」，这里是「由 host 反推网段」），
 * 第二道要的是独立复算，不是再跑一遍同一行代码。
 */
function isPreviewBackendHost(host, pools) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  let ip;
  try {
    ip = ipToInt(host);
  } catch {
    return false;
  }
  const base = (ip - PREVIEW_BACKEND_HOST_OFFSET) >>> 0;
  if (ip > 0 && base === 0xffffffff) return false;
  return pools.some((p) => {
    const range = parseCidr(p.cidr);
    const step = 2 ** (32 - p.prefixLen);
    if (range.base > base || base > range.last) return false;
    if ((base - range.base) % step !== 0) return false;
    return base + PREVIEW_BACKEND_HOST_OFFSET <= range.last;
  });
}

/**
 * 对**最终 YAML 文本**做结构断言。任何一行越界 ⇒ 抛错（调用方按「读取/校验失败」处理：
 * 保留 last-known-good，绝不写盘）。
 *
 * @param {{
 *   text: string,             // routes.yml 正文（无密钥）
 *   llmText: string|null,     // llm-routes.yml 正文（含 key；null = 合法空）
 *   config: {portalBackendUrl: string, llmGatewayUrl: string, llmHost: string, baseDomain: string,
 *            portalHost?: string, adminHost?: string, portalInternalHosts?: string[]},
 *   pools?: any[],
 *   file?: string, llmFile?: string,
 * }} args
 * @returns {true}
 */
export function assertRenderedRouteText({ text, llmText = null, config = {}, pools = FDE_IPAM_POOLS, file = 'routes.yml', llmFile = 'llm-routes.yml' }) {
  // ⚠ 逐池成完整模式后再 join：早前写成「先 join 再接后缀」，`|` 优先级低 ⇒ 只有最后一条
  // 带上了后两段，结果 `10.200.1.2` 这类止规地址反而不匹配（自测直接报「不在白名单」）。
  const previewUrlRe = new RegExp(`^http://(${poolHostPatterns(pools).join('|')}):(\\d{1,5})$`);
  const reserved = reservedPlatformHosts(config);
  const baseDomain = typeof config.baseDomain === 'string' && config.baseDomain !== '' ? config.baseDomain : null;

  const checkUrl = (url, where) => {
    if (url === config.portalBackendUrl || url === config.llmGatewayUrl) return;
    const m = previewUrlRe.exec(url);
    if (!m) {
      fail('route_url_not_allowlisted', `${where}: backend url ${JSON.stringify(url)} is not portal / llm gateway / in-pool preview`);
    }
    const [, host, portStr] = m;
    const portNum = Number(portStr);
    if (!Number.isInteger(portNum) || !isPreviewPortInPool(portNum)) {
      fail('preview_port_out_of_pool', `${where}: preview backend port ${JSON.stringify(portStr)} is outside the pool [${PREVIEW_PORT_POOL_START}, ${PREVIEW_PORT_POOL_END}]`);
    }
    if (!isPreviewBackendHost(host, pools)) {
      fail('preview_backend_host_invalid', `${where}: preview backend host ${JSON.stringify(host)} is not <aligned FDE subnet base> + ${PREVIEW_BACKEND_HOST_OFFSET}`);
    }
  };

  const checkText = (body, name) => {
    if (body === null || body === undefined) return;
    if (typeof body !== 'string') {
      fail('route_text_missing', `${name}: rendered text must be a string`);
    }
    for (const raw of body.split('\n')) {
      const u = URL_LINE_RE.exec(raw);
      if (u) {
        checkUrl(unquoteYamlDouble(u[1]), `${name} url line`);
        continue;
      }
      const bare = URL_LINE_BARE_RE.exec(raw);
      if (bare) {
        fail('route_url_not_quoted', `${name}: backend url line is not in the generated quoted form (text shape drifted)`);
      }
    }
    for (const m of body.matchAll(HOST_RE)) {
      const host = m[1];
      if (reserved.has(host)) continue;
      // 预览 host 的允许形态：`<fde>-p-<port 4 位补零>.<伞域>`（与 projects.buildHostname 同口径），
      // 且端口必须在号池内 —— 「以 .<伞域> 结尾」单独不够（F1）。
      if (!baseDomain) {
        fail('route_host_unverifiable', `${name}: Host(${host}) found but config.baseDomain is missing, cannot verify preview hosts`);
      }
      const suffix = `.${baseDomain}`;
      if (!host.endsWith(suffix)) {
        fail('route_host_not_allowlisted', `${name}: Host(${JSON.stringify(host)}) is neither a reserved platform host nor under the base domain`);
      }
      const label = host.slice(0, -suffix.length);
      const pm = /^(.+)-p-(\d{4,})$/.exec(label);
      if (!pm) {
        fail('route_host_not_allowlisted', `${name}: Host(${JSON.stringify(host)}) is not a preview hostname shape (<fde>-p-<port>)`);
      }
      const portNum = Number(pm[2]);
      if (!Number.isInteger(portNum) || !isPreviewPortInPool(portNum)) {
        fail('preview_port_out_of_pool', `${name}: Host(${JSON.stringify(host)}) carries a port outside the preview pool`);
      }
    }
    for (const m of body.matchAll(CLIENT_IP_RE)) {
      try {
        assertFdeSubnet(m[1], { pools });
      } catch (err) {
        const e = new Error(`${name}: ClientIP subnet ${JSON.stringify(m[1])} is not an FDE pool subnet (${err.code ?? err.message})`);
        e.code = 'route_clientip_out_of_pool';
        throw e;
      }
    }
    // ipAllowList 的 sourceRange：只有 `internal-allow` 受池约束（admin-allow / admin-deny 不受）。
    let section = null;
    let middleware = null;
    for (const raw of body.split('\n')) {
      const sec = SECTION_RE.exec(raw);
      if (sec) {
        section = sec[1];
        middleware = null;
        continue;
      }
      if (section === 'middlewares') {
        const nm = MW_NAME_RE.exec(raw);
        if (nm) middleware = nm[1];
      }
      const sr = SOURCE_RANGE_RE.exec(raw);
      if (!sr || !POOLED_SOURCE_RANGE_MIDDLEWARES.has(middleware ?? '')) continue;
      const items = sr[1].split(',').map((s) => s.trim()).filter((s) => s !== '');
      for (const item of items) {
        const value = item.replace(/^"|"$/g, '');
        try {
          assertFdeSubnet(value, { pools });
        } catch (err) {
          const e = new Error(`${name}: ${middleware} sourceRange ${JSON.stringify(value)} is not an FDE pool subnet (${err.code ?? err.message})`);
          e.code = 'route_source_range_out_of_pool';
          throw e;
        }
      }
    }
  };

  checkText(text, file);
  checkText(llmText, llmFile);
  return true;
}
