// IPAM：FDE 网络子网分配（H-B D-10，topology.md §3）。
// 缺省池 10.200.0.0/16（/29），大 FDE 段 10.201.0.0/16（/28）；两段取值可由 env 旋钮改段
// （`IPAM_POOL_DEFAULT` / `IPAM_POOL_LARGE`，宿主侧 `FDE_IPAM_POOL_*`，issue #270），前缀长度不可配。
// 纯函数子网算术（零依赖，uint32）+ DB 分配（写 fde_networks）。
// 依据：docs/design/topology.md §3/§5.1、docs/data/schema.sql §9（fde_networks）、docs/env.md §5.2/§10.1。

import crypto from 'node:crypto';
import { enqueueRouteChange } from './outbox.js';

// 全局 IPAM 锁：串行化「查空闲块 → 插行」，避免并发分配到同一 subnet（fde_networks.subnet UNIQUE 兜底）。
const IPAM_LOCK_KEY = 74452312;

/**
 * IPAM 池的**缺省**规格 —— 也就是 issue #270 之前 `POOLS` 里硬编码的那两个字面量。
 * 单独导出的理由：它是「不设 env ⇒ 行为零变化」这条反向自证的唯一对照物（单测逐字比对它），
 * 也是 `prefixLen` 的唯一真相源（见下：前缀长度**不是**旋钮）。
 */
export const DEFAULT_IPAM_POOLS = Object.freeze({
  default: Object.freeze({ cidr: '10.200.0.0/16', prefixLen: 29 }),
  large: Object.freeze({ cidr: '10.201.0.0/16', prefixLen: 28 }),
});

/**
 * 池名 → portal 侧 env 旋钮（**唯一映射点**，issue #270）。
 * 宿主/compose 侧是 `FDE_` 前缀版（`FDE_IPAM_POOL_DEFAULT` / `FDE_IPAM_POOL_LARGE`），
 * 由 `deploy/docker-compose.yml` 的 station-portal.environment 去掉前缀下发（沿用仓内既有风格）。
 *
 * ⚠ 与 `FDE_IPAM_POOLS`（= fde-proxy 的 `IPAM_POOLS`，`network create` 的**白名单闸门**）是两个
 * 不同语义：这一对是**分配器**从哪一段里切，那一条是**放行**哪些段。名字刻意不复用，
 * 一个变量背两个语义 = 第二本账必然过期。
 */
export const IPAM_POOL_ENV_KEYS = Object.freeze({ default: 'IPAM_POOL_DEFAULT', large: 'IPAM_POOL_LARGE' });

/**
 * 每个池的分配前缀**钉在** `DEFAULT_IPAM_POOLS.prefixLen` 上，env 只开 CIDR，理由三条：
 *  1. e2e 只需要换段（并行隔离栈各切一段），不需要改前缀；
 *  2. baseline DDL 把「池名 ↔ 前缀」钉成死对（`docs/data/schema.sql` §9：`fde_networks` 的 CHECK
 *     `pool='default' ⇒ prefix_len=29` / `pool='large' ⇒ prefix_len=28`，且 baseline 已冻结不可改），
 *     把前缀也开成旋钮 = 开一个「一改就被 DB CHECK 炸成 23514」的假旋钮；
 *  3. 别为将来预支结构复杂度（值形态 `<cidr>` 就够，`<cidr>:<前缀>` 只是多一个能写错的格子）。
 *
 * 段归属同理：baseline CHECK 还把「池名 ↔ 保留段」钉成 `default ⇒ << 10.200.0.0/16`、
 * `large ⇒ << 10.201.0.0/16`，所以**合法取值只能是保留段内的一块子段**（典型用法：隔离栈取
 * `10.201.<n>.0/24`，两套并行栈的 `fde-*` 网络不再从同一个池头撞车）。这个边界在**启动期**就判
 * （见 resolveIpamPools），不让脏值活到 provision 才在 INSERT 上撞 23514；同时它也是
 * topology §3 / deploy-contract §4.4 的口径（`10.200/16` 与 `10.201/16` 保留给 FDE 网络专用，
 * 防火墙兜底 DROP 只覆盖这两段 ⇒ 分配段跑出这两段 = 脱离兜底防线）。
 * 保留段的字面量就复用 `DEFAULT_IPAM_POOLS[*].cidr`（与缺省分配段同源，不抄第二份）。
 */

/** 整串严格形态：`d.d.d.d/<前缀>`，不许空白、不许端口式后缀、不许 CIDR 之外的任何写法。 */
const POOL_CIDR_RE = /^([0-9]{1,3}(?:\.[0-9]{1,3}){3})\/(\d{1,2})$/;

function poolEnvError(envKey, raw, reason) {
  const err = new Error(`非法的 IPAM 池配置 ${envKey}=${JSON.stringify(raw)}：${reason}`);
  err.code = 'ipam_pool_env_invalid';
  err.envKey = envKey;
  return err;
}

/**
 * 由 env 解析 IPAM 池（issue #270：让分配段可配，缺省逐字等于 #270 之前的硬编码值）。
 *
 * 值形态：单个 CIDR（`IPAM_POOL_LARGE=10.201.37.0/24`）；前缀长度不进字符串，理由见
 * `DEFAULT_IPAM_POOLS` 上方那段（前缀不是旋钮，恒为 29/28）。
 *
 * 判据口径：**整串严格校验 + 当场报错并点名旋钮**，不学 `parseInt('1e4')===1` 那族静默按半个值生效
 * （台账 §8.126 附近的同型事故）。四条：
 *   ① 形态：必须整串匹配 `<d.d.d.d>/<前缀>`；
 *   ② 语义：八位组 ≤255、池前缀 ≤32（`parseCidr` 的既有判据）；
 *   ③ 规范：主机位必须为 0（`10.201.0.7/16` 直接拒——`parseCidr` 会**静默 mask** 成 10.201.0.0/16，
 *      那是最典型的「按半个值生效」）；
 *   ④ DB 自洽：段必须整体落在该池的 DDL 保留段内（`schema.sql` §9 的 CHECK，baseline 冻结件），
 *      且池自身的前缀不得比分配前缀更长（否则池里切不出一块，`enumerateSubnets` 会抛）。
 *
 * 空串 / 未设 ⇒ 该池回退缺省值（compose 的 `${VAR:-默认}` 也走这条路，两头都是同一个字面量）。
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{default: {cidr: string, prefixLen: number}, large: {cidr: string, prefixLen: number}}}
 */
export function resolveIpamPools(env = process.env) {
  const pools = {};
  for (const [name, envKey] of Object.entries(IPAM_POOL_ENV_KEYS)) {
    const fallback = DEFAULT_IPAM_POOLS[name];
    const raw = env[envKey];
    if (raw === undefined || String(raw).trim() === '') {
      pools[name] = { ...fallback };
      continue;
    }
    const value = String(raw).trim();
    const m = POOL_CIDR_RE.exec(value);
    if (!m) {
      throw poolEnvError(envKey, raw, '必须是 `<网络地址>/<前缀>` 的整串形态（例：10.201.0.0/16），不接受空格、网段列表或前缀长度后缀');
    }
    let parsed;
    try {
      parsed = parseCidr(value);
    } catch (err) {
      throw poolEnvError(envKey, raw, err.message);
    }
    if (parsed.base !== parsed.ipInt) {
      throw poolEnvError(envKey, raw, `必须是规范的网络地址（主机位全 0）；${value} 会被静默压成 ${parsed.cidr}，那种「半个值生效」不许出现`);
    }
    const dbSegment = DEFAULT_IPAM_POOLS[name].cidr;
    const allowed = parseCidr(dbSegment);
    if (!(allowed.base <= parsed.base && parsed.last <= allowed.last)) {
      throw poolEnvError(envKey, raw, `必须整体落在 ${dbSegment} 之内（fde_networks 的 CHECK「pool='${name}' ⇒ subnet << ${dbSegment}」是 baseline DDL，见 schema.sql §9；脏值活到 provision 就是 INSERT 23514）`);
    }
    if (parsed.prefixLen > fallback.prefixLen) {
      throw poolEnvError(envKey, raw, `池前缀 /${parsed.prefixLen} 比该池的分配前缀 /${fallback.prefixLen} 还长，池里切不出一块（前缀长度不是旋钮，恒为 /${fallback.prefixLen}）`);
    }
    pools[name] = { cidr: parsed.cidr, prefixLen: fallback.prefixLen };
  }
  return pools;
}

/**
 * 运行期池表（模块加载时按 env 解析一次）。
 * 消费方保持原样：`allocateNetworkInTx` 按池名取，`routebackends.js` 的 `FDE_IPAM_POOLS`
 * 是它的**派生视图**（路由后端白名单随之跟着分配段走，不存在第二本账）。
 */
export const POOLS = resolveIpamPools();

export function ipToInt(ip) {
  const parts = String(ip).trim().split('.');
  if (parts.length !== 4) throw new Error(`invalid ipv4: ${ip}`);
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`invalid ipv4: ${ip}`);
    n = (n * 256 + v) >>> 0;
  }
  return n >>> 0;
}

export function intToIp(n) {
  const u = n >>> 0;
  return [(u >>> 24) & 255, (u >>> 16) & 255, (u >>> 8) & 255, u & 255].join('.');
}

/** 解析 CIDR 字符串（如 '10.200.0.0/16'），返回 uint32 网络区间。 */
export function parseCidr(cidr) {
  const m = String(cidr).trim().match(/^([0-9]{1,3}(?:\.[0-9]{1,3}){3})\/(\d{1,2})$/);
  if (!m) throw new Error(`invalid cidr: ${cidr}`);
  const ipInt = ipToInt(m[1]);
  const prefixLen = Number(m[2]);
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) {
    throw new Error(`invalid prefix length: ${cidr}`);
  }
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  const base = (ipInt & mask) >>> 0;
  const last = (base | ((~mask) >>> 0)) >>> 0;
  return {
    cidr: `${intToIp(base)}/${prefixLen}`,
    ipInt,
    prefixLen,
    base,
    mask,
    last,
    size: last - base + 1,
  };
}

/** 两个 CIDR 网络区间是否重叠（含边界）。 */
export function cidrsOverlap(a, b) {
  return a.base <= b.last && b.base <= a.last;
}

/**
 * 枚举池内全部子网（按序）。step = 2^(32-prefixLen)。
 * 返回 [{ subnet, base, prefixLen, last, gateway }]。
 */
export function enumerateSubnets(poolCidr, prefixLen) {
  const range = parseCidr(poolCidr);
  if (prefixLen < range.prefixLen) throw new Error('prefixLen cannot be larger than pool prefixLen');
  const step = 2 ** (32 - prefixLen);
  const out = [];
  for (let base = range.base; base <= range.last; base = (base + step) >>> 0) {
    if (base + step - 1 > 0xffffffff) break;
    const last = (base + step - 1) >>> 0;
    out.push({
      subnet: `${intToIp(base)}/${prefixLen}`,
      base,
      prefixLen,
      last,
      gateway: intToIp((base + 1) >>> 0),
    });
    if (base + step > 0xffffffff) break;
  }
  return out;
}

/**
 * 在池内挑下一块不与 existingCidrs 重叠的子网。
 * existingCidrs 为 fde_networks.subnet（任意 state）与保留网段的并集。
 */
export function nextAvailableSubnet(existingCidrs, { cidr, prefixLen }) {
  const existing = existingCidrs.map((c) => parseCidr(c));
  for (const cand of enumerateSubnets(cidr, prefixLen)) {
    const c = parseCidr(cand.subnet);
    if (!existing.some((e) => cidrsOverlap(c, e))) return cand;
  }
  const err = new Error('IPAM 池已耗尽：无可用子网');
  err.code = 'ipam_pool_exhausted';
  throw err;
}

/**
 * 在**调用方事务内**为 FDE 分配子网并写 fde_networks（幂等：已有活跃网络则直接返回）。
 * 调用方负责 BEGIN/COMMIT；本函数用 pg_advisory_xact_lock 串行化空闲块分配。
 * @param client   pg 事务内 client
 * @param userId   users.id（= fde_id）
 * @param fdeName  users.fde_name（网络名 fde-<name>）
 * @param opts     { poolName: 'default'|'large', reservedSubnets: string[], log }
 */
export async function allocateNetworkInTx(client, userId, fdeName, opts = {}) {
  const { poolName = 'default', reservedSubnets = [], log = console } = opts;
  if (!userId || !fdeName) throw new Error('allocateNetwork: userId/fdeName required');
  const poolSpec = POOLS[poolName];
  if (!poolSpec) throw new Error(`unknown pool: ${poolName}`);
  const networkName = `fde-${fdeName}`;
  await client.query('SELECT pg_advisory_xact_lock($1)', [IPAM_LOCK_KEY]);
  // 幂等：已有活跃网络直接复用（fde_networks 每 FDE 一行）。
  const existing = await client.query(
    `SELECT fde_id, network_name, subnet, prefix_len, gateway, pool, state
       FROM fde_networks WHERE fde_id = $1 AND state IN ('allocated', 'active')`,
    [userId],
  );
  if (existing.rows.length > 0) return existing.rows[0];
  // 收集已占 subnet（含 released 历史行，UNIQUE(subnet) 全局唯一，复用前需腾行）+ 保留网段。
  const taken = await client.query(`SELECT subnet FROM fde_networks`);
  const existingCidrs = taken.rows.map((r) => r.subnet).concat(reservedSubnets);
  const cand = nextAvailableSubnet(existingCidrs, poolSpec);

  // F4：fde_networks.fde_id 是主键，released 行仍占用该主键 → 直接 INSERT 会冲突 500。
  // 同 fde_id 已有 released 行时 UPDATE 复用该行（改 subnet/gateway/state/revision），否则 INSERT。
  const released = await client.query(
    `SELECT fde_id FROM fde_networks WHERE fde_id = $1 AND state = 'released'`,
    [userId],
  );
  if (released.rows.length > 0) {
    const row = await client.query(
      `UPDATE fde_networks
          SET network_name = $2, subnet = $3, prefix_len = $4, gateway = $5, pool = $6,
              state = 'allocated', revision = revision + 1, released_at = NULL
        WHERE fde_id = $1 AND state = 'released'
        RETURNING fde_id, network_name, subnet, prefix_len, gateway, pool, state`,
      [userId, networkName, cand.subnet, cand.prefixLen, cand.gateway, poolName],
    );
    log.log?.(`[ipam] reallocated ${cand.subnet} (${networkName}) for fde=${fdeName}`);
    await enqueueRouteChange(client, { aggregate: 'fde_network', aggregateId: userId, op: 'upsert', payload: { subnet: cand.subnet, network_name: networkName } });
    return row.rows[0];
  }

  const row = await client.query(
    `INSERT INTO fde_networks (fde_id, network_name, subnet, prefix_len, gateway, pool, state)
     VALUES ($1, $2, $3, $4, $5, $6, 'allocated')
     RETURNING fde_id, network_name, subnet, prefix_len, gateway, pool, state`,
    [userId, networkName, cand.subnet, cand.prefixLen, cand.gateway, poolName],
  );
  log.log?.(`[ipam] allocated ${cand.subnet} (${networkName}) for fde=${fdeName}`);
  await enqueueRouteChange(client, { aggregate: 'fde_network', aggregateId: userId, op: 'upsert', payload: { subnet: cand.subnet, network_name: networkName } });
  return row.rows[0];
}

/**
 * 独立事务版：为 FDE 分配子网并写 fde_networks（幂等）。
 */
export async function allocateNetwork(pool, userId, fdeName, opts = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await allocateNetworkInTx(client, userId, fdeName, opts);
    await client.query('COMMIT');
    return row;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** 随机 hex（materializer/route 原子写 temp 名）。 */
export function randomHex(bytes = 4) {
  return crypto.randomBytes(bytes).toString('hex');
}
