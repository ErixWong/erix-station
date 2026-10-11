// FDE 级预览域名预分配（issue #240 引入，issue #246 交付①改为**号池 + 块分配**）。
// 开户（provision）时一次性写一组预览域名（默认 10 条），并在**同一事务**内入队 route outbox +
// materialize revision——Traefik 路由与容器内 ~/.erix/ports.json 由此自动跟上，不需要人工
// `enqueueFullRebuild` / `runMaterializerOnce`。
//
// 依据（决策者 2026-10-11 裁决，issue #246 取代 issue #240 的分配规则；规格 §8.1 / §8.2）：
//   - 粒度 = **FDE 级**（`scope='fde'`，迁移 0018 放开该值；`run_id` 恒 NULL，满足
//     `CHECK ((scope='run') = (run_id IS NOT NULL))`）；条数 = **默认一块 10 个**（管理员可覆盖）；
//   - 端口 = **全局号池 22000–29999 内「最小的未占用对齐块」**（常量与块几何全在 `previewpool.js`）；
//     #240 的「人人都是 4000–4009」已被取代——那个实现让真机 eric 与 tetris 同时持有 4000–4009；
//   - **跨 FDE 不重叠是硬不变式，由 DB 保证**：迁移 0019 的
//     `port_allocations_live_global_port_key UNIQUE (port) WHERE state <> 'released'`。应用层因此
//     **不做**「先查后插」的查重循环，只算候选块 + 把 23505 翻成可操作错误码（见下）由调用方重试；
//   - `role='spare'`、`exposure='private'`、`state='allocated'`（首次 forward-auth 放行时由 http.js
//     幂等升级为 `active`，§8.6）；
//   - `hostname`/`url` 与读侧**同源**：projects.buildHostname / projects.previewUrl（§8.5，URL 的
//     scheme/端口从公开入口 `config.portalPublicBaseUrl` 派生，#57 阶段2）；
//   - 平台**不做容器侧端口管控**（不检查、不限制、不 reconcile 容器实际监听什么），只做「告知」：
//     本模块写的行经 materializer 落 `~/.erix/ports.json`，runner 的 SYSTEM_PROMPT 再复述一次同一口径。
//
// 幂等判据（不靠「先查后插」的 TOCTOU）：既有部分唯一索引
//   `port_allocations_live_port_key UNIQUE (fde_id, port) WHERE state <> 'released'`
//   + `ON CONFLICT (fde_id, port) WHERE state <> 'released' DO NOTHING`。
//   部分索引做冲突目标**必须显式写 WHERE 谓词**让 PG 做索引推断，漏写谓词会直接报
//   `there is no unique or exclusion constraint matching the ON CONFLICT specification`。
//   ⇒ 二次调用零插入；「已有部分行」只补缺口。该索引与 0019 新增的全局索引**并存**：同 FDE 重跑仍然
//   零插入（冲突目标命中它），跨 FDE 撞号则冲突目标不匹配 ⇒ 23505 冒出来（正是我们要的信号）。
//
// 存量遗留行：迁移 0019 已把**活行**整体重排进号池（`released` 历史行保留旧号码、不占位），所以本模块
// 不再需要「窗口内已有遗留行也算已存在」的特例；块选择的占用判据就是「全局活行端口」，不分 scope/role。

import { buildHostname, previewUrl, validateFdeNameForHostname } from './projects.js';
import { enqueueMaterializeChange, enqueueRouteChange } from './outbox.js';
import {
  PREVIEW_PORT_POOL_START,
  PREVIEW_PORT_POOL_END,
  PREVIEW_PORT_COUNT,
  PREVIEW_PORT_BLOCK_COUNT,
  alignedPreviewBlockStart,
  assertAlignedPreviewBlockStart,
  firstFreePreviewBlockStart,
  isPreviewPortInPool,
  previewBlockPorts,
} from './previewpool.js';

// 号池常量继续从本模块导出（#240 起的既有引用面 + 防漂移测试都从这里取，口径只有一份）。
export {
  PREVIEW_PORT_POOL_START,
  PREVIEW_PORT_POOL_END,
  PREVIEW_PORT_COUNT,
  PREVIEW_PORT_BLOCK_COUNT,
  previewBlockPorts,
  alignedPreviewBlockStart,
  firstFreePreviewBlockStart,
  isPreviewPortInPool,
} from './previewpool.js';

/**
 * 号池里的**第一个对齐块**（22000–22009）。
 * ⚠ 只是「没有 DB 上下文时」的默认期望态（纯函数 `previewAllocationPlan` 与若干单测拿它当样例）——
 * 真正的开户分配走 `choosePreviewBlockStart()`（池内最小的未占用对齐块），不看这个常量。
 */
export const PREVIEW_PORTS = previewBlockPorts(PREVIEW_PORT_POOL_START);

export const PREVIEW_SCOPE = 'fde';
export const PREVIEW_ROLE = 'spare';
export const PREVIEW_EXPOSURE = 'private';
/** route_outbox 聚合名（schema.sql §9 注释里的 'port_allocation'）。 */
export const PREVIEW_ROUTE_AGGREGATE = 'port_allocation';

/** 块尾（含）。 */
export function previewBlockEnd(blockStart) {
  return blockStart + PREVIEW_PORT_COUNT - 1;
}

/** 块的展示名（CLI 输出与错误文案共用：`22000-22009`）。 */
export function previewBlockLabel(blockStart) {
  return `${blockStart}-${previewBlockEnd(blockStart)}`;
}

function invalidArgs(message) {
  const err = new Error(`ensureFdePreviewPorts: ${message}`);
  err.code = 'preview_ports_invalid_args';
  return err;
}

/**
 * 纯函数：一组预览域名的期望态（不落库，供插入与单测逐字段核对）。
 * hostname/url 一律走 projects.js 的唯一生成入口，本模块不自己拼字符串。
 * @param {number[]} [ports] 端口列表；缺省 = 号池第一个对齐块（见 `PREVIEW_PORTS` 的 ⚠ 注）
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
 * 占用判据的取数面：**全局活行**端口（`state <> 'released'`，不分 FDE / scope / role）——
 * 与迁移 0019 那条全局部分唯一索引的谓词逐字同口径；`released` 行不返回 ⇒ 号码可回收复用。
 * 只用于算候选块，不参与「是否插入」的判定（那由索引 + ON CONFLICT 决定）。
 */
export async function listOccupiedPreviewPorts(client, { fdeId = null } = {}) {
  const params = [PREVIEW_PORT_POOL_START, PREVIEW_PORT_POOL_END];
  let ownFilter = '';
  if (fdeId) {
    params.push(fdeId);
    ownFilter = ` AND fde_id = $3`;
  }
  const r = await client.query(
    `SELECT DISTINCT port FROM port_allocations
      WHERE state <> 'released' AND port BETWEEN $1 AND $2${ownFilter}`,
    params,
  );
  return r.rows.map((row) => Number(row.port));
}

/**
 * 挑一个块（不改库）：
 *   1) 本 FDE 已经在池内占有端口 ⇒ 补自己那一块（幂等重跑与「缺几条补几条」走这条），
 *      前提是该块内没有**外来**活行——有外来行说明这一段被侵吞过，硬补会在 INSERT 时撞全局索引，
 *      不如换整段；
 *   2) 否则取「池内最小的整块空闲对齐块」（`firstFreePreviewBlockStart`）。
 * @returns {Promise<number>} 块起点
 */
export async function choosePreviewBlockStart(client, { fdeId }) {
  // 两次取数**顺序**跑（不 Promise.all）：调用方传的是**事务内同一连接**，串行才能保证两次读
  // 落在同一个语句快照上，也不会与同事务里尚未完成的写入乱序。
  const occupied = await listOccupiedPreviewPorts(client);
  const ownPorts = await listOccupiedPreviewPorts(client, { fdeId });
  const own = new Set(ownPorts);
  const foreign = occupied.filter((port) => !own.has(port));

  const ownBlocks = [...new Set([...own].map((port) => alignedPreviewBlockStart(port)))].sort((a, b) => a - b);
  for (const block of ownBlocks) {
    // 这一段里有**外来**活行 ⇒ 整段被侵吞过（历史上手工插行/改块都可能造成），不补。
    const infringed = foreign.some((port) => port >= block && port <= previewBlockEnd(block));
    if (!infringed) return block;
  }

  const block = firstFreePreviewBlockStart(occupied);
  if (block === null) {
    const err = new Error(
      `ensureFdePreviewPorts: 号池 ${PREVIEW_PORT_POOL_START}–${PREVIEW_PORT_POOL_END} 的 `
      + `${PREVIEW_PORT_BLOCK_COUNT} 段已无整块空闲（每段 ${PREVIEW_PORT_COUNT} 个）——`
      + '需要扩池或回收（released）旧段后重试',
    );
    err.code = 'preview_port_pool_exhausted';
    throw err;
  }
  return block;
}

/**
 * **调用方事务内**补齐该 FDE 的一组预览域名（默认一整块，幂等，只补缺口），并在真的有插入时
 * 同事务入队派生链。调用方负责 BEGIN/COMMIT——「写库」与「入队」必须在同一事务里，
 * 这样任何一次失败都不会留下「行已写、路由/ports.json 永远不重算」的半截状态。
 *
 * 入队顺序（与 offboarding.js releaseNetworkRoutes 的既有范式一致，测试逐序断言）：
 *   BEGIN → [取候选块] → 逐行 INSERT（DO NOTHING）→ [每条新行 route_revisions → route_outbox]×N
 *         → materialize_revisions → materialize_outbox → COMMIT
 *
 * @param client            pg 事务内 client
 * @param fdeId             users.id（= port_allocations.fde_id）
 * @param fdeName           users.fde_name（hostname 首段）
 * @param baseDomain        config.baseDomain（伞域，#57 语义）
 * @param publicBaseUrl     config.portalPublicBaseUrl（url 的 scheme/端口来源）
 * @param {number} [blockStart] 显式指定块起点（管理员覆盖 / 交付② 的「改块」入口）；必须对齐且在池内
 * @param {number[]} [ports]  显式指定端口清单（单个端口覆盖）；每个都必须落在池内
 * @returns {Promise<{requested, inserted, skipped, routeRevisions, materializeRevision, blockStart, blockEnd, ports}>}
 */
export async function ensureFdePreviewPorts(client, {
  fdeId, fdeName, baseDomain, publicBaseUrl = null, ports = null, blockStart = null, log = console,
}) {
  if (!fdeId || !fdeName) throw invalidArgs('fdeId/fdeName required');
  if (!baseDomain) {
    throw invalidArgs('baseDomain required（hostname 与 Traefik 路由同源生成，§8.5）');
  }
  // #202 的第四道强制点：hostname 一旦拼错，0017 的 DB CHECK 会在事务中途炸掉整个开户，
  // 错误文案只剩一句 23514。这里按同一口径前置校验，给出可操作的文案（预算 55，#246 起随池宽度推导）。
  const grammar = validateFdeNameForHostname(fdeName, { baseDomain });
  if (!grammar.ok) {
    const err = new Error(`ensureFdePreviewPorts: ${grammar.message}`);
    err.code = 'preview_hostname_invalid';
    throw err;
  }

  // 端口来源：显式块起点 > 显式端口清单 > 池内最小的未占用对齐块。
  let block;
  let portsIn;
  if (blockStart !== null && blockStart !== undefined) {
    assertAlignedPreviewBlockStart(blockStart);   // code='preview_port_block_invalid'
    block = blockStart;
    portsIn = previewBlockPorts(blockStart);
  } else if (Array.isArray(ports) && ports.length > 0) {
    const outside = ports.filter((port) => !isPreviewPortInPool(port));
    if (outside.length > 0) {
      const err = new Error(
        `ensureFdePreviewPorts: 端口 ${outside.join(',')} 不在号池 ${PREVIEW_PORT_POOL_START}–${PREVIEW_PORT_POOL_END} 内`
        + '（活行必须落在池内，否则 0019 的 port CHECK 会以 23514 拒绝整笔事务）',
      );
      err.code = 'preview_port_out_of_pool';
      throw err;
    }
    portsIn = [...ports].sort((a, b) => a - b);
    block = alignedPreviewBlockStart(portsIn[0]);
  } else {
    block = await choosePreviewBlockStart(client, { fdeId });
    portsIn = previewBlockPorts(block);
  }

  const plan = previewAllocationPlan({ fdeName, baseDomain, publicBaseUrl, ports: portsIn });
  const inserted = [];
  try {
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
  } catch (err) {
    // 跨 FDE 撞号 / 并发抢同一块：冲突目标 (fde_id, port) 不匹配 ⇒ 0019 的全局索引抛 23505。
    // PG 在显式事务里遇错即整笔 aborted，**不能**就地换号继续 ⇒ 翻成可操作错误码后由调用方重试
    // （重试会重新算候选块，自动取下一段）。这就是「并发安全交给索引」的具体落点。
    if (err?.code === '23505') {
      const clash = new Error(
        `预览端口块 ${previewBlockLabel(block)} 与既有活行重叠（DB 唯一索引 `
        + 'port_allocations_live_global_port_key 拒绝了重叠，issue #246 的硬不变式）：'
        + '请重试本次开户/改块（会自动取号池里下一个空闲块），或显式指定其它块起点',
      );
      clash.code = 'preview_port_block_taken';
      clash.cause = err;
      throw clash;
    }
    throw err;
  }

  if (inserted.length === 0) {
    // 幂等重跑：一行都没插 ⇒ 一个 outbox 字节都不写（派生链无需重算，也不该重算）。
    log.log?.(`[portalloc] fde=${fdeName} 预览端口块 ${previewBlockLabel(block)} 已齐备，零插入`);
    return {
      requested: plan.length, inserted: [], skipped: plan.length,
      routeRevisions: [], materializeRevision: null,
      blockStart: block, blockEnd: previewBlockEnd(block), ports: portsIn,
    };
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

  log.log?.(`[portalloc] fde=${fdeName} 预分配预览域名 ${inserted.length}/${plan.length} 条（块 ${previewBlockLabel(block)}），同事务入队 route outbox ×${inserted.length} + materialize revision ${materializeRevision}`);
  return {
    requested: plan.length, inserted, skipped: plan.length - inserted.length,
    routeRevisions, materializeRevision,
    blockStart: block, blockEnd: previewBlockEnd(block), ports: portsIn,
  };
}

/**
 * 独立事务包装：开户 / `cli.js provision-fde` 重跑入口（老 FDE 补齐、管理员指定块都走这里）。
 * 事务边界在这里，是因为「写一组行 + 入队派生链」必须原子；Docker 侧动作不在本事务内
 * （onboardFde 已完成网络/容器），所以本事务只持 port_allocations / outbox 的锁。
 */
export async function provisionFdePreviewPorts(pool, config, { fdeId, fdeName, blockStart = null, log = console } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await ensureFdePreviewPorts(client, {
      fdeId,
      fdeName,
      baseDomain: config.baseDomain,
      publicBaseUrl: config.portalPublicBaseUrl ?? null,
      blockStart,
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
