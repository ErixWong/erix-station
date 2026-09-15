// 路由 reconciler：消费 route_outbox（route_revisions head 语义）→ 生成 Traefik file provider 动态配置。
// 依据：docs/design/topology.md §5/§5.1/§8、docs/data/schema.sql §9（route_outbox/revisions）。
// 每 allocation 一条显式 router + service（否决单通配 service）；来源规则从 fde_networks 精确 subnet 派生（禁 /16 聚合）。
// 原子替换（tmp → 校验 → rename），失败保留上一版。

import path from 'node:path';
import { atomicWriteFile } from './fsutil.js';
import { parseCidr } from './ipam.js';

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const MAX_ATTEMPTS = 5;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

/**
 * 生成 Traefik 动态配置（YAML 文本）。含 portal 路由、internal 路由（ipAllowList 精确派生）、
 * 每 allocation 一条 router+service（带 forwardAuth 占位 + strip-cookie）。
 */
export function generateTraefikConfig({ portalHost, portalBackendUrl, entryPoint, allocations, sourceRanges }) {
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
  lines.push(`      rule: ${yq(`Host(\`${portalHost}\`) && PathPrefix(\`/api/internal\`)`)}`);
  lines.push('      priority: 200');
  lines.push('      middlewares: [internal-allow]');
  lines.push('      service: portal');

  const routerNames = [];
  for (const a of allocations) {
    const name = `fde-${String(a.hostname).split('.')[0]}`;
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

/** 轻量校验（生成后、rename 前）：非空 + 关键节存在 + 无重复 router 名。 */
export function validateTraefikConfig(text, allocations) {
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('generated config empty');
  if (!text.includes('http:') || !text.includes('routers:') || !text.includes('services:')) {
    throw new Error('generated config missing sections');
  }
  const names = new Set();
  for (const a of allocations) {
    const name = `fde-${String(a.hostname).split('.')[0]}`;
    if (names.has(name)) throw new Error(`duplicate router name: ${name}`);
    names.add(name);
  }
  return true;
}

/** 从 DB 读取路由所需 desired state（active/allocated 网络 + 未释放 allocation → backend URL）。 */
export async function readRouteDesiredState(pool, config) {
  const networks = await pool.query(
    `SELECT fde_id, subnet FROM fde_networks WHERE state IN ('allocated', 'active') ORDER BY subnet`,
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

/** 全量重生成一份 Traefik 动态配置并原子替换（启动/定时对账用，不依赖 outbox 行）。 */
export async function rebuildRoutes(pool, config, { log = console } = {}) {
  const state = await readRouteDesiredState(pool, config);
  const text = generateTraefikConfig({
    portalHost: config.portalHost,
    portalBackendUrl: config.portalBackendUrl,
    entryPoint: config.traefikEntryPoint,
    allocations: state.allocations,
    sourceRanges: state.sourceRanges,
  });
  validateTraefikConfig(text, state.allocations);
  const target = path.join(config.traefikDynamicDir, config.traefikDynamicFile ?? 'routes.yml');
  atomicWriteFile(target, text, { mode: 0o644, root: config.traefikDynamicDir });
  return { target, allocations: state.allocations.length, sourceRanges: state.sourceRanges };
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
  (async () => {
    // 启动全量重建（portal/Traefik 重启后从 DB 重建缺失状态，topology §8）。
    try {
      await rebuildRoutes(pool, config, { log });
    } catch (err) {
      log.warn?.(`[routes] startup rebuild failed: ${err.message}`);
    }
    while (!stopped) {
      try {
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
