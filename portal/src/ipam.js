// IPAM：FDE 网络子网分配（H-B D-10，topology.md §3）。
// 默认池 10.200.0.0/16（/29），大 FDE 段 10.201.0.0/16（/28）。
// 纯函数子网算术（零依赖，uint32）+ DB 分配（写 fde_networks）。
// 依据：docs/design/topology.md §3/§5.1、docs/data/schema.sql §9（fde_networks）、docs/env.md §5.2。

import crypto from 'node:crypto';

// 全局 IPAM 锁：串行化「查空闲块 → 插行」，避免并发分配到同一 subnet（fde_networks.subnet UNIQUE 兜底）。
const IPAM_LOCK_KEY = 74452312;

export const POOLS = {
  default: { cidr: '10.200.0.0/16', prefixLen: 29 },
  large: { cidr: '10.201.0.0/16', prefixLen: 28 },
};

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
    return row.rows[0];
  }

  const row = await client.query(
    `INSERT INTO fde_networks (fde_id, network_name, subnet, prefix_len, gateway, pool, state)
     VALUES ($1, $2, $3, $4, $5, $6, 'allocated')
     RETURNING fde_id, network_name, subnet, prefix_len, gateway, pool, state`,
    [userId, networkName, cand.subnet, cand.prefixLen, cand.gateway, poolName],
  );
  log.log?.(`[ipam] allocated ${cand.subnet} (${networkName}) for fde=${fdeName}`);
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
