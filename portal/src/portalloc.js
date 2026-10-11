// FDE 级预览域名预分配（issue #240）：开户（provision）时一次性写 10 条预览域名，
// 并在**同一事务**内入队 route outbox + materialize revision——Traefik 路由与容器内
// ~/.erix/ports.json 由此自动跟上，不再需要人工 `enqueueFullRebuild` / `runMaterializerOnce`
// （真机现状：`port_allocations` 过去只被手工插过 4 行，插完之后派生链一律不动）。
//
// 依据（决策者 2026-10-11 裁决，fde-platform §7.2 第 3 步 / §8.1 / §8.2）：
//   - 粒度 = **FDE 级**（`scope='fde'`，迁移 0018 放开该值；`run_id` 恒 NULL，满足
//     `CHECK ((scope='run') = (run_id IS NOT NULL))`）；
//   - 固定 **10 条**、端口 `4000–4009`、`role='spare'`、`exposure='private'`、`state='allocated'`
//     （首次 forward-auth 放行时由 http.js 幂等升级为 `active`，§8.6）；
//   - `hostname`/`url` 与读侧**同源**：projects.buildHostname / projects.previewUrl（§8.5，
//     URL 的 scheme/端口从公开入口 `config.portalPublicBaseUrl` 派生，#57 阶段2）；
//   - 固定 10 条 ⇒ 没有「端口配额」这回事，`port_quota_exceeded` 随文档一并删除；
//   - 平台**不做容器侧端口管控**（不检查、不限制、不 reconcile 容器实际监听什么），
//     只做「告知」：本模块写的行经 materializer 落 `~/.erix/ports.json`，runner 的
//     SYSTEM_PROMPT 再向模型复述一次同一口径。
//
// 幂等判据（不靠「先查后插」的 TOCTOU）：既有部分唯一索引
//   `port_allocations_live_port_key UNIQUE (fde_id, port) WHERE state <> 'released'`
//   + `ON CONFLICT (fde_id, port) WHERE state <> 'released' DO NOTHING`。
//   部分索引做冲突目标**必须显式写 WHERE 谓词**让 PG 做索引推断，漏写谓词会直接报
//   `there is no unique or exclusion constraint matching the ON CONFLICT specification`。
//   ⇒ 二次调用零插入；「已有部分行」只补缺口。
//
// 存量遗留行**不迁移、不改不删**（真机 4 行全是 P5「去项目化」前手工插的 `scope='project'`，
// 含 tetris 的 4100，在本窗口之外）：`routes.js:382` 只看 `state <> 'released'` 与 hostname，
// 不看 scope，所以它们继续有效；窗口内若已有同端口行（哪怕 `scope='project'`/`role='frontend'`）
// 也**当成已存在**、不重复插——正是上面那条部分唯一索引给出的语义。

import { buildHostname, previewUrl, validateFdeNameForHostname } from './projects.js';
import { enqueueMaterializeChange, enqueueRouteChange } from './outbox.js';

/** 预分配窗口：4000–4009（schema.sql `port` CHECK 允许 4000–4999，本窗口天然满足）。 */
export const PREVIEW_PORT_START = 4000;
export const PREVIEW_PORT_COUNT = 10;
export const PREVIEW_PORTS = Object.freeze(
  Array.from({ length: PREVIEW_PORT_COUNT }, (_, i) => PREVIEW_PORT_START + i),
);

export const PREVIEW_SCOPE = 'fde';
export const PREVIEW_ROLE = 'spare';
export const PREVIEW_EXPOSURE = 'private';
/** route_outbox 聚合名（schema.sql §9 注释里的 'port_allocation'）。 */
export const PREVIEW_ROUTE_AGGREGATE = 'port_allocation';

/**
 * 纯函数：10 条预览域名的期望态（不落库，供插入与单测逐字段核对）。
 * hostname/url 一律走 projects.js 的唯一生成入口，本模块不自己拼字符串。
 */
export function previewAllocationPlan({ fdeName, baseDomain, publicBaseUrl = null, ports = PREVIEW_PORTS }) {
  return ports.map((port) => {
    const hostname = buildHostname({ fdeName, port, baseDomain });
    return {
      port,
      hostname,
      url: previewUrl(hostname, { publicBaseUrl }),
      scope: PREVIEW_SCOPE,
      role: PREVIEW_ROLE,
      exposure: PREVIEW_EXPOSURE,
      state: 'allocated',
    };
  });
}

/**
 * **调用方事务内**补齐该 FDE 的 10 条预览域名（幂等，只补缺口），并在真的有插入时
 * 同事务入队派生链。调用方负责 BEGIN/COMMIT——「写库」与「入队」必须在同一事务里，
 * 这样任何一次失败都不会留下「行已写、路由/ports.json 永远不重算」的半截状态。
 *
 * 入队顺序（与 offboarding.js releaseNetworkRoutes 的既有范式一致，测试逐序断言）：
 *   BEGIN → 逐行 INSERT（DO NOTHING）→ [每条新行 route_revisions → route_outbox]×N
 *         → materialize_revisions → materialize_outbox → COMMIT
 *
 * @param client            pg 事务内 client
 * @param fdeId             users.id（= port_allocations.fde_id）
 * @param fdeName           users.fde_name（hostname 首段）
 * @param baseDomain        config.baseDomain（伞域，#57 语义）
 * @param publicBaseUrl     config.portalPublicBaseUrl（url 的 scheme/端口来源）
 * @returns {requested, inserted, skipped, routeRevisions, materializeRevision}
 */
export async function ensureFdePreviewPorts(client, {
  fdeId, fdeName, baseDomain, publicBaseUrl = null, ports = PREVIEW_PORTS, log = console,
}) {
  if (!fdeId || !fdeName) {
    const err = new Error('ensureFdePreviewPorts: fdeId/fdeName required');
    err.code = 'preview_ports_invalid_args';
    throw err;
  }
  if (!baseDomain) {
    const err = new Error('ensureFdePreviewPorts: baseDomain required（hostname 与 Traefik 路由同源生成，§8.5）');
    err.code = 'preview_ports_invalid_args';
    throw err;
  }
  // #202 的第四道强制点：10 条 hostname 一旦拼错，0017 的 DB CHECK 会在事务中途炸掉整个开户，
  // 错误文案只剩一句 23514。这里按同一口径前置校验，给出可操作的文案（FDE 名预算 56）。
  const grammar = validateFdeNameForHostname(fdeName, { baseDomain });
  if (!grammar.ok) {
    const err = new Error(`ensureFdePreviewPorts: ${grammar.message}`);
    err.code = 'preview_hostname_invalid';
    throw err;
  }

  const plan = previewAllocationPlan({ fdeName, baseDomain, publicBaseUrl, ports });
  const inserted = [];
  for (const row of plan) {
    // 冲突目标写全谓词 ⇒ 部分唯一索引 port_allocations_live_port_key 被推断到；
    // 已 released 的行不在索引内，所以「释放后重分配」仍然会插新行（软删除语义，model.md §4）。
    const r = await client.query(
      `INSERT INTO port_allocations (fde_id, scope, port, role, hostname, url, exposure, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'allocated')
       ON CONFLICT (fde_id, port) WHERE state <> 'released' DO NOTHING
       RETURNING id, port`,
      [fdeId, PREVIEW_SCOPE, row.port, PREVIEW_ROLE, row.hostname, row.url, PREVIEW_EXPOSURE],
    );
    if (r.rows?.length > 0) inserted.push({ ...row, id: r.rows[0].id });
  }

  if (inserted.length === 0) {
    // 幂等重跑：一行都没插 ⇒ 一个 outbox 字节都不写（派生链无需重算，也不该重算）。
    log.log?.(`[portalloc] fde=${fdeName} preview ports 4000-${PREVIEW_PORT_START + plan.length - 1} 已齐备，零插入`);
    return { requested: plan.length, inserted: [], skipped: plan.length, routeRevisions: [], materializeRevision: null };
  }

  // 派生链①：Traefik 路由。每条新 allocation 一个聚合实例（schema.sql §9：aggregate_id = port_allocations.id），
  // reconciler 消费时按 DB 全量重生成文件，逐 allocation 入队只为与「一条 allocation 一条 router」的聚合语义对齐。
  const routeRevisions = [];
  for (const row of inserted) {
    const revision = await enqueueRouteChange(client, {
      aggregate: PREVIEW_ROUTE_AGGREGATE,
      aggregateId: row.id,
      op: 'upsert',
      payload: { fde_name: fdeName, hostname: row.hostname, port: row.port, scope: PREVIEW_SCOPE },
    });
    routeRevisions.push(revision);
  }
  // 派生链②：~/.erix/ports.json（materialize 聚合本来就是每 FDE 一个，故只入队一次）。
  const materializeRevision = await enqueueMaterializeChange(client, {
    fdeId,
    op: 'upsert',
    payload: { reason: 'fde_preview_ports', ports: inserted.map((r) => r.port) },
  });

  log.log?.(`[portalloc] fde=${fdeName} 预分配预览域名 ${inserted.length}/${plan.length} 条（端口 ${inserted.map((r) => r.port).join(',')}），同事务入队 route outbox ×${inserted.length} + materialize revision ${materializeRevision}`);
  return { requested: plan.length, inserted, skipped: plan.length - inserted.length, routeRevisions, materializeRevision };
}

/**
 * 独立事务包装：开户 / `cli.js provision-fde` 重跑入口（老 FDE 补齐到 10 条走的就是这里）。
 * 事务边界在这里，是因为「写 10 行 + 入队派生链」必须原子；Docker 侧动作不在本事务内
 * （onboardFde 已完成网络/容器），所以本事务只持 port_allocations / outbox 的锁。
 */
export async function provisionFdePreviewPorts(pool, config, { fdeId, fdeName, log = console } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await ensureFdePreviewPorts(client, {
      fdeId,
      fdeName,
      baseDomain: config.baseDomain,
      publicBaseUrl: config.portalPublicBaseUrl ?? null,
      log,
    });
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
