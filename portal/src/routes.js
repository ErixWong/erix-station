// 路由 reconciler：消费 route_outbox（route_revisions head 语义）→ 生成 Traefik file provider 动态配置。
// 依据：docs/design/topology.md §5/§5.1/§8、docs/data/schema.sql §9（route_outbox/revisions）。
// 每 allocation 一条显式 router + service（否决单通配 service）；来源规则从 fde_networks 精确 subnet 派生（禁 /16 聚合）。
// 原子替换（tmp → 校验 → rename）。发布顺序与回滚见 rebuildRoutes 注释：先发含密 llm-routes.yml、
// 再无密 routes.yml，任一环节失败按 fail-closed 处置（绝不让旧/半截含密文件继续被 Traefik 使用）。
//
// issue #38 Phase B1：LLM 段拆独立文件 llm-routes.yml（mode 600，含 per-FDE virtual key）——
// 主文件 routes.yml 保持 0644（无密钥）。两文件同目录、同 atomicWriteFile、同一次全量重建，
// Traefik file provider 按目录 watch 自动合并生效。outbox 消费对 aggregate 无感（claimRouteRows
// 通用），aggregate='llm_binding' 行与 port_allocation 走同一条领取/租约/全量重建链路。

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './fsutil.js';
import { parseCidr } from './ipam.js';
import { enqueueRouteChange } from './outbox.js';

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const MAX_ATTEMPTS = 5;

// F3'（Round B 评审）：route_revisions / route_outbox 的 aggregate_id 是 uuid NOT NULL
//（schema.sql §9），非 UUID 字符串在真实 DB 上会报 invalid input syntax for type uuid。
// full_rebuild 的 outbox 行只是「触发一次全量重建」的信号、不对应真实聚合行，用固定 nil UUID 哨兵：
// 满足 uuid 类型约束，且多次重试复用同一聚合 → 复用既有 revision head / 租约 / 重试链路。
export const FULL_REBUILD_AGGREGATE_ID = '00000000-0000-0000-0000-000000000000';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// DNS label：小写字母数字，不以 - 开头/结尾（hostname grammar，fde-platform §8.5）。
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_LITERAL_SHAPE_RE = /^\d+(?:\.\d+){3}$/;

/** 严格 hostname grammar 校验（拒绝换行/控制字符/大写/下划线/非法字符；DB 无 CHECK，代码层先挡）。 */
export function isValidHostname(h) {
  if (typeof h !== 'string' || h.length === 0 || h.length > 253) return false;
  return h.split('.').every((label) => DNS_LABEL_RE.test(label));
}

function isValidInternalHost(host) {
  if (typeof host !== 'string') return false;
  if (!IPV4_LITERAL_SHAPE_RE.test(host)) return isValidHostname(host);
  try {
    parseCidr(`${host}/32`);
    return true;
  } catch {
    return false;
  }
}

/** allocation/router key：`fde-<hostname 首段>`（需先 isValidHostname，否则拒绝）。 */
export function routerNameFor(hostname) {
  return `fde-${String(hostname).split('.')[0]}`;
}

/** 来源规则唯一口径（topology §5.1）：state ∈ {allocated,active} 的每行取精确 subnet（/29 或 /28），禁止写 /16 池。 */
export function deriveSourceRanges(networkRows) {
  return networkRows.map((r) => r.subnet).sort();
}

/**
 * revision head 过滤（latest-wins）：revision < head 的晚到旧事件/旧 tombstone 丢弃；
 * revision == head 的当前行才发布。
 * @param rows   route_outbox 行 [{ aggregate, aggregate_id, revision }]
 * @param heads  Map<`aggregate:aggregate_id`, revision>
 */
export function filterCurrentHead(rows, heads) {
  const current = [];
  const stale = [];
  for (const row of rows) {
    const key = `${row.aggregate}:${row.aggregate_id}`;
    const head = heads.get(key);
    if (head === undefined || Number(row.revision) === Number(head)) {
      current.push(row);
    } else {
      stale.push(row);
    }
  }
  return { current, stale };
}

function yq(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function ylist(items) {
  return `[${items.map(yq).join(', ')}]`;
}

// 所有进 yml 的字符串值先过控制字符/换行拒绝（yq 不转义换行，防 YAML 注入；M3）。
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

function assertSafeString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (CONTROL_CHARS_RE.test(value)) {
    throw new Error(`${label} contains control characters`);
  }
  return value;
}

/**
 * F5：YAML 裸写 token 白名单——凡直接裸拼进 YAML（不加引号/不进 yq）的值（entryPoints flow list、
 * providerId 前缀的 service key）必须命中 ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$，否则视为注入直接抛错。
 * 控制字符/换行仍由 assertSafeString 先行拒绝（报错信息区分两层原因）。
 */
const SAFE_TOKEN_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function assertSafeToken(value, label) {
  assertSafeString(value, label);
  if (!SAFE_TOKEN_RE.test(value)) {
    throw new Error(`${label} must be a safe token (^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$): ${JSON.stringify(value)}`);
  }
  return value;
}

function assertHttpUrl(value, label) {
  assertSafeString(value, label);
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL: ${JSON.stringify(value)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`${label} must use http/https scheme`);
  }
  return value;
}

/**
 * 生成 Traefik 主动态配置（YAML 文本，无密钥，mode 0644）。含 portal 路由、internal 路由
 * （ipAllowList 精确派生）、每 allocation 一条 router+service（带 forwardAuth + strip-cookie）。
 * LLM 段（含 LiteLLM virtual key 明文）由 generateLlmTraefikConfig 单独生成 llm-routes.yml（mode 600）。
 * 所有 hostname/router key/subnet 严格校验（F9）；非法输入直接抛错（fail-closed）。
 */
export function generateTraefikConfig({
  portalHost,
  portalInternalHosts = [],
  portalBackendUrl,
  entryPoint,
  allocations,
  sourceRanges,
}) {
  // F9：渲染边界严格校验，拒绝换行/控制字符/非法字符（DB 无 CHECK，代码层挡）。
  if (!isValidHostname(portalHost)) throw new Error(`invalid portal hostname: ${JSON.stringify(portalHost)}`);
  for (const host of portalInternalHosts) {
    if (!isValidInternalHost(host)) throw new Error(`invalid portal internal hostname: ${JSON.stringify(host)}`);
  }
  for (const a of allocations) {
    if (!isValidHostname(a.hostname)) throw new Error(`invalid allocation hostname: ${JSON.stringify(a.hostname)}`);
  }
  for (const r of sourceRanges) parseCidr(r); // 非法/含控制字符的 CIDR 直接拒绝

  // M3/F5：非 hostname 值同样拒绝控制字符/换行（yq 不转义换行）；URL 额外要求 http/https 可解析；
  // entryPoint 裸拼进 entryPoints flow list（不加引号），须命中安全 token 白名单（F5 注入面收口）。
  assertSafeToken(entryPoint, 'entryPoint');
  assertHttpUrl(portalBackendUrl, 'portalBackendUrl');

  const forwardAuthAddress = `${portalBackendUrl.replace(/\/$/, '')}/api/forward-auth`;
  const lines = ['http:'];
  lines.push('  routers:');
  lines.push('    portal:');
  lines.push(`      entryPoints: [${entryPoint}]`);
  lines.push(`      rule: ${yq(`Host(\`${portalHost}\`)`)}`);
  lines.push('      priority: 100');
  lines.push('      service: portal');
  lines.push('    internal:');
  lines.push(`      entryPoints: [${entryPoint}]`);
  const internalHostRule = portalInternalHosts.length === 0
    ? `Host(\`${portalHost}\`)`
    : `(${[portalHost, ...portalInternalHosts].map((host) => `Host(\`${host}\`)`).join(' || ')})`;
  lines.push(`      rule: ${yq(`${internalHostRule} && PathPrefix(\`/api/internal\`)`)}`);
  lines.push('      priority: 200');
  lines.push('      middlewares: [internal-allow]');
  lines.push('      service: portal');

  const routerNames = [];
  for (const a of allocations) {
    const name = routerNameFor(a.hostname);
    routerNames.push(name);
    lines.push(`    ${name}:`);
    lines.push(`      entryPoints: [${entryPoint}]`);
    lines.push(`      rule: ${yq(`Host(\`${a.hostname}\`)`)}`);
    lines.push('      priority: 200');
    lines.push('      middlewares: [fde-auth, strip-cookie]');
    lines.push(`      service: ${name}`);
  }

  lines.push('  middlewares:');
  lines.push('    fde-auth:');
  lines.push('      forwardAuth:');
  lines.push(`        address: ${yq(forwardAuthAddress)}`);
  // #57：trustForwardHeader 是 **forwardAuth 中间件**字段（非 entryPoint 级）：host 网络直连，
  // 不信入站 X-Forwarded-*，由 Traefik 自己按真实连接覆写（同时消 station-edge 启动 WRN）。
  lines.push('        trustForwardHeader: false');
  lines.push('        authRequestHeaders: [X-Forwarded-Host, X-Forwarded-Uri, X-Forwarded-Method, X-Forwarded-Proto, Cookie]');
  lines.push('        authResponseHeaders: [X-Auth-User]');
  lines.push('    strip-cookie:');
  lines.push('      headers:');
  lines.push('        customRequestHeaders:');
  lines.push('          Cookie: ""');
  lines.push('    internal-allow:');
  lines.push('      ipAllowList:');
  lines.push(`        sourceRange: ${ylist(sourceRanges)}`);

  lines.push('  services:');
  lines.push('    portal:');
  lines.push('      loadBalancer:');
  lines.push('        servers:');
  lines.push(`          - url: ${yq(portalBackendUrl)}`);
  for (let i = 0; i < allocations.length; i++) {
    const name = routerNames[i];
    const a = allocations[i];
    lines.push(`    ${name}:`);
    lines.push('      loadBalancer:');
    lines.push('        servers:');
    lines.push(`          - url: ${yq(a.backendUrl)}`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * 生成 LLM 段 Traefik 动态配置（YAML 文本，**含 per-FDE LiteLLM key 明文**——文件 mode 600）。
 * 每个 FDE 使用独立的来源网段路由和 key 注入 middleware，所有路由共用 LiteLLM 数据面 service。
 *
 * 结构（与 issue 定稿一致）：
 *   routers:    llm-<fdeName>           rule: Host(`<llmHost>`) && ClientIP(`<精确 subnet>`)
 *   middlewares: llm-key-<fdeName>      headers.customRequestHeaders.Authorization = Bearer <api_key>
 *   services:   llm-gateway              loadBalancer.servers.url = LiteLLM data-plane URL
 *
 * fail-closed：virtual key 为 NULL（未配置）的 binding 不生成路由（该 FDE 无 LLM 可用，不注入空凭据）；
 * 无 ClientIP 条件的兜底路由禁止生成。所有值过控制字符/URL/hostname 校验；virtual key 只进返回值，
 * **绝不写日志/错误消息**（调用方同责）。
 *
 * @param llmBindings [{ fdeName, subnet, apiKey }]（apiKey=null 跳过）
 */
// 零 active binding 的空产物 = **不写文件**（rebuildRoutes unlink）。实测口径（wp4 e2e，Traefik v3 file provider）：
//   - 'http: {}' / 纯注释 / 空 map 子键（routers: {} 等）→ 全部被拒（"cannot be a standalone element"，
//     YAML null 同样报错）且**连坐同目录 routes.yml**——整个目录加载失败，全部路由 404（wp4 断言②实锤）。
//   → 唯一安全的「无 LLM 配置」形态是文件不存在：file provider 对缺失文件无感知。
// 返回 null 表示零 binding（调用方负责 unlink）。
export const LLM_EMPTY_CONFIG = null;

export function generateLlmTraefikConfig({ entryPoint, llmHost, llmGatewayUrl, llmBindings = [] }) {
  // F5：entryPoint 裸拼进每 router 的 entryPoints flow list（不加引号）——合法与否与 binding 数量无关，
  // 入口处先校验（fail-fast，先校验后写）。
  assertSafeToken(entryPoint, 'entryPoint');
  const active = [];
  for (const b of llmBindings) {
    if (b == null) continue;
    if (b.apiKey == null) continue; // 未配置 key → 无 LLM 可用，fail-closed 不发布
    if (!isValidHostname(b.fdeName)) throw new Error(`invalid fde name: ${JSON.stringify(b.fdeName)}`);
    parseCidr(b.subnet);
    assertSafeString(b.apiKey, 'apiKey');
    active.push(b);
  }
  if (active.length === 0) return LLM_EMPTY_CONFIG;
  if (!isValidHostname(llmHost)) throw new Error(`invalid llm hostname: ${JSON.stringify(llmHost)}`);
  assertHttpUrl(llmGatewayUrl, 'llmGatewayUrl');

  // 确定性输出：binding 按 fdeName 排序——同 DB 状态两次渲染字节相同（幂等）。
  active.sort((x, y) => x.fdeName.localeCompare(y.fdeName));

  const lines = ['http:'];
  lines.push('  routers:');
  for (const b of active) {
    lines.push(`    llm-${b.fdeName}:`);
    lines.push(`      entryPoints: [${entryPoint}]`);
    lines.push(`      rule: ${yq(`Host(\`${llmHost}\`) && ClientIP(\`${b.subnet}\`)`)}`);
    lines.push('      priority: 200');
    lines.push(`      middlewares: [llm-key-${b.fdeName}]`);
    lines.push('      service: llm-gateway');
  }

  lines.push('  middlewares:');
  for (const b of active) {
    lines.push(`    llm-key-${b.fdeName}:`);
    lines.push('      headers:');
    // Traefik v3 headers middleware 注入请求头 = customRequestHeaders（Phase C e2e 实测：
    // v2 风格 request.set 在 v3.7 报 "field not found, node: request"，整份动态配置被拒）。
    lines.push('        customRequestHeaders:');
    lines.push(`          Authorization: ${yq(`Bearer ${b.apiKey}`)}`);
  }

  lines.push('  services:');
  lines.push('    llm-gateway:');
  lines.push('      loadBalancer:');
  lines.push('        servers:');
  lines.push(`          - url: ${yq(llmGatewayUrl)}`);
  // 流式必需：保持较短 flush interval，避免 token 流被缓冲成整段。
  lines.push('        responseForwarding:');
  lines.push('          flushInterval: 100ms');

  return `${lines.join('\n')}\n`;
}

/** 轻量结构断言（LLM 段）：控制字符拒绝 + 关键节存在 + router/middleware 成对 + service 去重无重复。 */
export function validateLlmTraefikConfig(text, llmBindings) {
  const fdeNames = llmBindings.filter((b) => b?.apiKey != null).map((b) => b.fdeName).sort();
  if (text === LLM_EMPTY_CONFIG) {
    // null 契约：零 active binding 时不写文件（rebuildRoutes 负责 unlink）。
    if (fdeNames.length > 0) throw new Error('generated llm config empty with active bindings');
    return true;
  }
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('generated llm config empty');
  if (/[\x00-\x09\x0b-\x1f\x7f]/.test(text)) throw new Error('generated llm config contains control characters');
  if (fdeNames.length === 0) throw new Error('generated llm config not empty for zero bindings');
  if (!text.includes('  routers:') || !text.includes('  middlewares:') || !text.includes('  services:')) {
    throw new Error('generated llm config missing sections');
  }
  const lines = text.split('\n');
  const seen = new Set();
  for (const name of fdeNames) {
    if (seen.has(name)) throw new Error(`duplicate llm router name: ${name}`);
    seen.add(name);
    if (!lines.includes(`    llm-${name}:`)) throw new Error(`missing llm router for ${name}`);
    if (!lines.includes(`    llm-key-${name}:`)) throw new Error(`missing llm middleware for ${name}`);
    if (!lines.some((l) => l === `      middlewares: [llm-key-${name}]`)) {
      throw new Error(`llm router ${name} missing key middleware reference`);
    }
  }
  if (lines.filter((l) => l === '    llm-gateway:').length !== 1) {
    throw new Error('llm service llm-gateway must exist exactly once');
  }
  for (const name of fdeNames) {
    if (!lines.includes(`      service: llm-gateway`)) throw new Error(`llm router ${name} missing gateway service`);
  }
  return true;
}

/** 轻量结构断言（F9）：非空 + 无控制字符 + 关键节存在 + 每 allocation 的 router/service 成对存在 + 无重复 router 名。 */
export function validateTraefikConfig(text, allocations) {
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('generated config empty');
  // 除 \n 行分隔符外，其余控制字符（含 \t、\r、\0）一律拒绝；\n 注入已在 generateTraefikConfig 的取值边界被拒绝。
  if (/[\x00-\x09\x0b-\x1f\x7f]/.test(text)) throw new Error('generated config contains control characters');
  if (!text.includes('http:') || !text.includes('routers:') || !text.includes('services:')) {
    throw new Error('generated config missing sections');
  }
  const lines = text.split('\n');
  const names = new Set();
  for (const a of allocations) {
    const name = routerNameFor(a.hostname);
    if (names.has(name)) throw new Error(`duplicate router name: ${name}`);
    names.add(name);
    // 同名字段必须同时出现在 routers 与 services 两节（各一次，成对）。
    const count = lines.filter((l) => l === `    ${name}:`).length;
    if (count < 2) throw new Error(`missing router or service for ${name}`);
  }
  return true;
}

/**
 * 从 DB 读取路由所需 desired state（active/allocated 网络 + 未释放 allocation → backend URL
 * + active LiteLLM binding → 发布事实：fde_name/subnet/virtual key）。
 * virtual key 明文只进返回值（渲染进 mode 600 文件），**绝不写日志/错误消息**（调用方同责）。
 */
export async function readRouteDesiredState(pool, config) {
  const networks = await pool.query(
    `SELECT n.fde_id, n.subnet, u.fde_name
       FROM fde_networks n
       JOIN users u ON u.id = n.fde_id
      WHERE n.state IN ('allocated', 'active')
      ORDER BY n.subnet`,
  );
  const llmRows = await pool.query(
    `SELECT b.fde_id, b.api_key, u.fde_name, n.subnet
       FROM fde_llm_bindings b
       JOIN users u ON u.id = b.fde_id
       JOIN fde_networks n ON n.fde_id = b.fde_id AND n.state IN ('allocated', 'active')
      WHERE b.state = 'active' AND b.gateway = 'litellm'
        AND b.api_key IS NOT NULL AND b.api_key <> ''
      ORDER BY u.fde_name`,
  );
  const allocs = await pool.query(
    `SELECT a.id, a.fde_id, a.hostname, a.port, n.subnet
       FROM port_allocations a
       JOIN fde_networks n ON n.fde_id = a.fde_id AND n.state IN ('allocated', 'active')
      WHERE a.state <> 'released'
      ORDER BY a.hostname`,
  );
  const allocations = allocs.rows.map((a) => {
    const subnet = parseCidr(a.subnet);
    // 后端 = FDE 主容器固定位 .2（topology §3/§4-L2）。
    const backendIp = (subnet.base + 2) >>> 0;
    const octets = [(backendIp >>> 24) & 255, (backendIp >>> 16) & 255, (backendIp >>> 8) & 255, backendIp & 255];
    return {
      id: a.id,
      fde_id: a.fde_id,
      hostname: a.hostname,
      port: Number(a.port),
      backendUrl: `http://${octets.join('.')}:${a.port}`,
    };
  });
  return {
    allocations,
    sourceRanges: deriveSourceRanges(networks.rows),
    llmBindings: llmRows.rows.map((r) => ({
      fdeName: r.fde_name,
      subnet: r.subnet,
      apiKey: r.api_key ?? null,
    })),
  };
}

/** 领取 route_outbox head 行（revision==head），丢弃 revision<head 的晚到旧事件。 */
async function claimRouteRows(pool, workerId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE route_outbox o
         SET state = 'published', published_at = now(), last_error = NULL
        FROM route_revisions r
       WHERE o.aggregate = r.aggregate AND o.aggregate_id = r.aggregate_id
         AND o.revision < r.revision AND o.state = 'pending'`,
    );
    const rows = await client.query(
      `UPDATE route_outbox o
          SET state = 'processing', claimed_at = now(), lease_until = now() + interval '60 seconds', worker_id = $1
        WHERE o.state = 'pending'
          AND o.id IN (
            SELECT o2.id FROM route_outbox o2
            JOIN route_revisions r ON r.aggregate = o2.aggregate AND r.aggregate_id = o2.aggregate_id AND r.revision = o2.revision
            WHERE o2.state = 'pending'
            ORDER BY o2.created_at
            FOR UPDATE OF o2 SKIP LOCKED
            LIMIT 100
          )
        RETURNING o.id, o.aggregate, o.aggregate_id, o.revision, o.op`,
      [workerId],
    );
    await client.query('COMMIT');
    return rows.rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function markRoutePublished(pool, id) {
  await pool.query(
    `UPDATE route_outbox SET state = 'published', published_at = now(), last_error = NULL WHERE id = $1`,
    [id],
  );
}

async function markRouteFailed(pool, id, error) {
  await pool.query(
    `UPDATE route_outbox SET attempts = attempts + 1, last_error = $2,
       state = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END,
       claimed_at = NULL, lease_until = NULL, worker_id = NULL
     WHERE id = $1`,
    [id, String(error?.message ?? error), MAX_ATTEMPTS],
  );
}

/**
 * F3-5（启动重建失败补偿）：写一条全量重建 outbox 行（aggregate='full_rebuild'）作为重试信号。
 * 选 (a)「写 pending outbox 行触发循环重试」而非 (b)「定时兜底全量重建」的理由：复用既有
 * claim/租约/重试/标记链路（含 crash 恢复），不引入新的时间轮询维度；无 pending 行时循环照常 250ms 低耗空转。
 */
export async function enqueueFullRebuild(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await enqueueRouteChange(client, {
      aggregate: 'full_rebuild',
      aggregateId: FULL_REBUILD_AGGREGATE_ID,
      op: 'upsert',
      payload: { reason: 'startup_rebuild_failed' },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 全量重生成 Traefik 动态配置并原子替换（启动/定时对账用，不依赖 outbox 行）。
 * 拆两份文件：routes.yml（无密钥，0644）+ llm-routes.yml（含 virtual key 明文，**0600**，issue #38 Phase B1）。
 * 两份都先生成+校验再落盘：任一渲染失败则两份都不写（不落半截）。
 *
 * F3 发布语义（fail-closed 硬红线：任何失败都不允许让「已撤销/已停用」的 key 继续被 Traefik 使用）：
 *   1. 先发含密文件 llm-routes.yml（零 binding → unlink；有 binding → 写新内容 0600）；
 *   2. 再无密主文件 routes.yml（0644）——若第 2 步失败，主文件保持上一版不动，回滚删除
 *      llm-routes.yml（宁可不给 LLM 路由，也不让旧 key 在新主配置下继续生效），再抛错；
 *   3. 若第 1 步含密文件发布本身失败（写或 unlink）→ 主文件不动（保持上一版），并尽力摘除盘上
 *      旧含密文件；摘除失败属异常态，错误/日志必须明示「含密文件可能残留」，绝不静默。
 */
export async function rebuildRoutes(pool, config, { log = console } = {}) {
  const state = await readRouteDesiredState(pool, config);
  const text = generateTraefikConfig({
    portalHost: config.portalHost,
    portalInternalHosts: config.portalInternalHosts,
    portalBackendUrl: config.portalBackendUrl,
    entryPoint: config.traefikEntryPoint,
    allocations: state.allocations,
    sourceRanges: state.sourceRanges,
  });
  validateTraefikConfig(text, state.allocations);
  const llmText = generateLlmTraefikConfig({
    entryPoint: config.traefikEntryPoint,
    llmHost: config.llmHost,
    llmGatewayUrl: config.llmGatewayUrl,
    llmBindings: state.llmBindings,
  });
  validateLlmTraefikConfig(llmText, state.llmBindings);
  const target = path.join(config.traefikDynamicDir, config.traefikDynamicFile ?? 'routes.yml');
  const llmTarget = path.join(config.traefikDynamicDir, config.traefikLlmDynamicFile ?? 'llm-routes.yml');

  // 第 1 步：先发含密文件（零 binding → unlink；有 binding → 写新内容）。
  try {
    if (llmText === null) {
      // 零 binding：文件不得存在（见 LLM_EMPTY_CONFIG 注释——任何形式的空文件都会连坐整个目录）。
      // unlink 原子；ENOENT 幂等。
      await fs.promises.unlink(llmTarget).catch((e) => { if (e?.code !== 'ENOENT') throw e; });
    } else {
      // 红线：本文件含 LiteLLM virtual key 明文，必须 0600（key 只存在于 DB → 内存 → mode 600 文件）。
      atomicWriteFile(llmTarget, llmText, { mode: 0o600, root: config.traefikDynamicDir });
    }
  } catch (err) {
    // 第 1 步失败：主文件保持上一版不动（不进入第 2 步）；尽力摘除盘上旧含密文件，
    // 绝不静默——摘除失败必须明示「含密文件可能残留」异常态（旧 virtual key 可能仍被 Traefik 使用）。
    try {
      await fs.promises.unlink(llmTarget);
      log.warn?.(`[routes] llm-routes.yml publish failed (${err.message}); 已摘除含密文件，主文件保持上一版`);
    } catch (e2) {
      // D3（Round D 评审）：ENOENT = 含密文件本就不在 = fail-closed 已达成（无任何含 key 文件
      // 可被 Traefik 使用），视为摘除成功，绝不误报「可能残留」。
      if (e2?.code === 'ENOENT') {
        log.warn?.(`[routes] llm-routes.yml publish failed (${err.message}); 含密文件本就不存在（fail-closed 状态达成），主文件保持上一版`);
        throw new Error(`llm-routes.yml publish failed: ${err.message}; 主文件保持上一版`);
      }
      log.error?.(`[routes] llm-routes.yml publish failed (${err.message}) 且旧含密文件摘除失败: ${e2.message} —— 含密文件可能残留，旧 virtual key 可能仍被 Traefik 使用（异常态）`);
      throw new Error(`llm-routes.yml publish failed: ${err.message}; 含密文件可能残留（摘除失败: ${e2.message}）`);
    }
    throw new Error(`llm-routes.yml publish failed: ${err.message}; 已摘除含密文件，主文件保持上一版`);
  }

  // 第 2 步：再无密主文件。失败 → fail-closed 回滚：删除 llm-routes.yml（宁可无 LLM 路由，
  // 也不让含 key 的 llm 文件与旧/新主文件组合被 Traefik 继续使用），再抛错。
  try {
    atomicWriteFile(target, text, { mode: 0o644, root: config.traefikDynamicDir });
  } catch (err) {
    // N4（Round C 评审）：回滚摘除失败与第 1 步**同一严格口径**——绝不谎称「已摘除」：
    // 旧代码 unlink 失败被 .catch(() => {}) 吞掉后仍 warn「已摘除」，撒谎（旧 key 文件可能仍被
    // Traefik 使用）。摘除失败必须 error 级明示「含密文件可能残留」，并把该事实带进抛出的错误。
    try {
      await fs.promises.unlink(llmTarget);
      log.warn?.(`[routes] routes.yml publish failed (${err.message}); fail-closed：已摘除 llm-routes.yml，含密文件不再被 Traefik 使用`);
    } catch (e2) {
      // D3（Round D 评审）：ENOENT = 含密文件本就不在 = fail-closed 已达成，视为摘除成功，
      // 只抛原始的主文件发布错误，绝不误报「可能残留」。
      if (e2?.code === 'ENOENT') {
        log.warn?.(`[routes] routes.yml publish failed (${err.message}); fail-closed：含密文件本就不存在（fail-closed 状态达成）`);
        throw err;
      }
      log.error?.(`[routes] routes.yml publish failed (${err.message}) 且含密文件 llm-routes.yml 摘除失败: ${e2.message} —— 含密文件可能残留，旧 virtual key 可能仍被 Traefik 使用（异常态）`);
      throw new Error(`routes.yml publish failed: ${err.message}; 含密文件可能残留（摘除失败: ${e2.message}）`);
    }
    throw err;
  }
  return {
    target,
    llmTarget,
    llmPublished: llmText !== null,
    allocations: state.allocations.length,
    sourceRanges: state.sourceRanges,
    llmBindings: state.llmBindings.length,
  };
}

/** 消费一轮 route_outbox：全量重生成一份 Traefik 动态配置并原子替换。 */
export async function runRoutesOnce(pool, config, { log = console, workerId = 'routes-1' } = {}) {
  const rows = await claimRouteRows(pool, workerId);
  if (rows.length === 0) return { processed: 0 };
  try {
    const out = await rebuildRoutes(pool, config, { log });
    for (const row of rows) await markRoutePublished(pool, row.id);
    return { processed: rows.length, target: out.target };
  } catch (err) {
    log.warn?.(`[routes] publish failed: ${err.message}`);
    for (const row of rows) await markRouteFailed(pool, row.id, err);
    throw err;
  }
}

/** 崩溃恢复：回收 processing 且租约过期的孤儿行。 */
export async function recoverRouteOrphans(pool) {
  await pool.query(
    `UPDATE route_outbox
        SET state = 'pending', attempts = attempts + 1, claimed_at = NULL, lease_until = NULL, worker_id = NULL
      WHERE state = 'processing' AND lease_until < now()`,
  );
}

/** 启动常驻消费循环（由 cli serve 调用）。 */
export function startRoutesLoop(pool, config, { log = console, workerId = 'routes-1', onPause } = {}) {
  let stopped = false;
  let consecutiveFailures = 0;
  // N5（Round C 评审）：启动重建失败且 full_rebuild 入队**也**失败（如 DB 抖动）时，旧代码只 warn——
  // DB 恢复后不会再有任何全量重建触发。保留内存标记 needsFullRebuild：此后每次循环迭代
  // （消费 outbox 之前）重试入队，成功即清位。复用既有 250ms 循环节奏（正常路径零成本空转），
  // 不新增高频轮询/新时间轮；进程重启后由启动路径的 enqueueFullRebuild 重新尝试。
  let needsFullRebuild = false;
  (async () => {
    // 启动全量重建（portal/Traefik 重启后从 DB 重建缺失状态，topology §8）。
    try {
      await rebuildRoutes(pool, config, { log });
    } catch (err) {
      log.warn?.(`[routes] startup rebuild failed: ${err.message}`);
      // F3-5：启动重建失败必须可重试——写一条 full_rebuild outbox 行，循环消费到即重试全量重建
      //（不改成高频轮询；outbox 行本身带 claim/租约/重试语义，见 enqueueFullRebuild 注释）。
      try {
        await enqueueFullRebuild(pool);
        log.warn?.('[routes] startup rebuild 失败：已写入 full_rebuild outbox 行，等待循环重试');
      } catch (e2) {
        needsFullRebuild = true;
        log.warn?.(`[routes] enqueue full_rebuild row failed: ${e2.message}；已置 needsFullRebuild 标记，循环内将持续重试入队`);
      }
    }
    while (!stopped) {
      try {
        // N5：标记为真 → 消费 outbox 之前先重试入队（成功清位；失败保持标记，下轮继续）。
        if (needsFullRebuild) {
          try {
            await enqueueFullRebuild(pool);
            needsFullRebuild = false;
            log.warn?.('[routes] full_rebuild 入队重试成功：循环将消费该行走全量重建');
          } catch (e2) {
            log.warn?.(`[routes] full_rebuild 入队重试仍失败: ${e2.message}（needsFullRebuild 保持，下轮继续）`);
          }
        }
        await recoverRouteOrphans(pool);
        await runRoutesOnce(pool, config, { log, workerId });
        consecutiveFailures = 0;
        await sleep(250);
      } catch (err) {
        consecutiveFailures += 1;
        log.warn?.(`[routes] loop error: ${err.message}`);
        onPause?.('routes', err);
        const backoff = BACKOFF_MS[Math.min(consecutiveFailures - 1, BACKOFF_MS.length - 1)];
        await sleep(backoff);
      }
    }
  })();
  return { stop() { stopped = true; } };
}
