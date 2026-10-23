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

/** 交付② 的错误工厂（码沿用既有口径：`preview_port_block_taken` / `preview_hostname_invalid`）。 */
function portsError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
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
 *
 * **自动选块的冲突重算（issue #246 交付②，补交付① 的已知边界）**：
 *   - **未**显式指定 `blockStart` 时，遇到 `preview_port_block_taken`（并发抢号被 0019 的全局唯一索引拒）
 *     ⇒ **开新事务重算**（重新取全局占用 → `firstFreePreviewBlockStart` 取下一段），总尝试上限
 *     `PREVIEW_BLOCK_MAX_ATTEMPTS` = **3 次**（含首试）；用尽后抛同一可操作错误码 `preview_port_block_taken`。
 *   - **显式**指定 `blockStart`（管理员指定块 / `cli.js --block-start`）⇒ **不重算**，直接冒错：
 *     管理员挑的那一段被占就是「要人去看一眼」的信号，偷偷换成另一段会让他以为分到了指定的号。
 *
 * ⚠ **重试只覆盖「端口分配」这一小段，不是整笔开户回滚后重来**（本文件最容易误读的一句）：
 *   `provisioner.js:809` 的事实是「**网络与容器已落地之后、LLM 联动之前**」才调本函数 ⇒
 *   冲突时**已经建好的 Docker 网络与容器不会回滚**（它们不在本事务里），而 LLM binding 尚未执行。
 *   已有的 `withFdeLock` 锁键是 `fde:${fdeName}`，**串行化不了不同 FDE 抢同一空闲块**，
 *   所以「0019 的全局部分唯一索引 + 新事务重算」才是正解，别指望加锁。
 */
export const PREVIEW_BLOCK_MAX_ATTEMPTS = 3;

async function provisionFdePreviewPortsOnce(pool, config, { fdeId, fdeName, blockStart = null, log = console }) {
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

export async function provisionFdePreviewPorts(pool, config, { fdeId, fdeName, blockStart = null, log = console } = {}) {
  const explicitBlock = blockStart !== null && blockStart !== undefined;
  const maxAttempts = explicitBlock ? 1 : PREVIEW_BLOCK_MAX_ATTEMPTS;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await provisionFdePreviewPortsOnce(pool, config, { fdeId, fdeName, blockStart, log });
    } catch (err) {
      // 只有「抢号失败」值得重算（每次都是新事务 + 重新取占用 ⇒ 会自然落到下一个空闲块）。
      // 其余错误（池耗尽 / hostname 超预算 / 参数非法）重试一万次也是同样结果 ⇒ 原样冒。
      if (err?.code !== 'preview_port_block_taken' || attempt === maxAttempts) {
        if (explicitBlock || err?.code !== 'preview_port_block_taken') throw err;
        lastErr = err;
        break;
      }
      log.warn?.(`[portalloc] fde=${fdeName} 第 ${attempt}/${maxAttempts} 次抢号冲突（预览端口块），开新事务重算下一段`);
      lastErr = err;
    }
  }
  throw portsError(
    'preview_port_block_taken',
    `${lastErr?.message ?? '预览端口块与既有活行重叠'}（已尝试 ${maxAttempts} 次 = 首试 + 自动重算 ${maxAttempts - 1} 次，`
    + '每次都是新事务重取占用后取下一个空闲段，仍然冲突 ⇒ 号池里没有「算出来空闲但插不进去」的整块了，'
    + '请管理员显式改块 POST /api/admin/fdes/:fdeName/ports/block）',
    lastErr?.cause ?? lastErr,
  );
}

// ---------------------------------------------------------------------------
// 交付②（issue #246）：列端口读端点 + 管理员「改块」= **搬迁**事务
// ---------------------------------------------------------------------------

/**
 * 列端点的 DTO 列（口径见 docs/api/portal.md §4.7a）：**`id` 必给**——签票端点
 * `POST /api/ports/:id/preview-ticket` 吃的是 allocation UUID，没有它这个列表就没有意义（#246 的起因）。
 * 不含 `released_at` 等运维字段：活行口径下它恒 NULL。
 */
const PREVIEW_PORT_LIST_COLUMNS = 'id, port, hostname, url, state, scope, role, exposure';

/**
 * 某个 FDE 的**活行**预览 allocation（`state <> 'released'`），按 `port ASC`。
 * 两个列端点（本人 / admin 面）共用同一个取数与 DTO，避免两个端点漂成两套字段。
 * 只读 ⇒ 不加事务、不取锁（列表容忍并发：读到的是「那一刻的活行」，前端每次签票前重取即可）。
 */
export async function listFdePreviewPorts(clientOrPool, { fdeId }) {
  if (!fdeId) throw portsError('preview_ports_invalid_args', 'listFdePreviewPorts: fdeId required');
  const r = await clientOrPool.query(
    `SELECT ${PREVIEW_PORT_LIST_COLUMNS} FROM port_allocations
      WHERE fde_id = $1 AND state <> 'released'
      ORDER BY port ASC`,
    [fdeId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    port: Number(row.port),
    hostname: row.hostname,
    url: row.url,
    state: row.state,
    scope: row.scope,
    role: row.role,
    exposure: row.exposure,
  }));
}

/**
 * 号池占用总览（issue #256 交付①）里 `free_blocks.items` 的**默认**条数。
 * 段总数是 800（`PREVIEW_PORT_BLOCK_COUNT`），一次全列出来对「选一段空闲号」没有帮助 ⇒ 默认只给前 50 段
 * 起点 + `has_more`，调用方要更多就用 `?limit=` 显式说。
 */
export const PREVIEW_USAGE_FREE_LIMIT_DEFAULT = 50;

/**
 * 号池**占用总览**（issue #256 交付①，`GET /api/admin/preview-ports/usage`，portal.md §4.7a）。
 *
 * 存在的理由：管理员「改块」原本只能填一个数字试错，撞 `409 preview_port_block_taken` 才知道那段被占。
 * 本函数把「哪几段被占、哪几段整段空闲」一次算清楚，改块因此可以**先选空闲段**。
 *
 * 硬性口径（工单 #256 + 与 `firstFreePreviewBlockStart` 同源）：
 *   - 占用判据 = **全局活行**（`state <> 'released'`，不分 FDE / scope / role），与迁移 0019 的部分唯一索引同口径；
 *     `released` 行**不占位**（号码可回收是 #246 的硬判据）；
 *   - **整块**判定：段内有 1 个活行 ⇒ 整段不进 `free_blocks`（与 `firstFreePreviewBlockStart` 的整块跳过一致，
 *     避免把外来行侵吞进自己的段里）；`partial` = 占 1..N-1 个，`occupied` = 占满整块；
 *   - `fde_names` **是数组**：单端口覆盖可以造出「一段里多个 FDE」的 mixed 形状，只显示第一个会骗人；
 *   - 所有数字都从 `previewpool.js` 推导（本函数体内**零端口字面量**，测试有源码级断言）；
 *   - **只读**：一条 SELECT 取活行端口 + 所属 FDE 名，不写库、不入队 outbox/revision、不加事务。
 *
 * @param clientOrPool pg pool 或事务内 client（读端点用 pool 即可）
 * @param {{ freeLimit?: number }} [opts] freeLimit：`free_blocks.items` 的条数上限（默认 50）
 */
export async function previewPortPoolUsage(clientOrPool, { freeLimit = PREVIEW_USAGE_FREE_LIMIT_DEFAULT } = {}) {
  if (!Number.isInteger(freeLimit) || freeLimit < 1) {
    throw portsError('preview_ports_invalid_args', 'previewPortPoolUsage: freeLimit 必须是正整数');
  }
  const r = await clientOrPool.query(
    `SELECT pa.port AS port, u.fde_name AS fde_name
       FROM port_allocations pa
       LEFT JOIN users u ON u.id = pa.fde_id
      WHERE pa.state <> 'released' AND pa.port BETWEEN $1 AND $2
      ORDER BY pa.port ASC`,
    [PREVIEW_PORT_POOL_START, PREVIEW_PORT_POOL_END],
  );

  // 块起点 → { 活行数, FDE 名集合 }。名字用 Set 去重（同一 FDE 在一段里的每行都同名）。
  const byBlock = new Map();
  for (const row of r.rows ?? []) {
    const port = Number(row.port);
    if (!isPreviewPortInPool(port)) continue;   // 池外活行不计入总览（0019 的 CHECK 本就不许，防御性跳过）
    const start = alignedPreviewBlockStart(port);
    let entry = byBlock.get(start);
    if (!entry) {
      entry = { count: 0, names: new Set() };
      byBlock.set(start, entry);
    }
    entry.count += 1;
    if (typeof row.fde_name === 'string' && row.fde_name !== '') entry.names.add(row.fde_name);
  }

  const occupiedBlocks = [];
  const freeStarts = [];
  let partial = 0;
  let occupied = 0;
  // 遍历池内**每一个对齐块**（不是只遍历被占的块）：空闲段要按号池顺序整段列出来。
  for (let block = PREVIEW_PORT_POOL_START; block + PREVIEW_PORT_COUNT - 1 <= PREVIEW_PORT_POOL_END; block += PREVIEW_PORT_COUNT) {
    const entry = byBlock.get(block);
    if (!entry) {
      freeStarts.push(block);
      continue;
    }
    if (entry.count >= PREVIEW_PORT_COUNT) occupied += 1;
    else partial += 1;
    occupiedBlocks.push({
      start: block,
      end: previewBlockEnd(block),
      occupied_count: entry.count,
      fde_names: [...entry.names].sort(),
    });
  }

  const items = freeStarts.slice(0, freeLimit);
  return {
    pool: {
      start: PREVIEW_PORT_POOL_START,
      end: PREVIEW_PORT_POOL_END,
      block_size: PREVIEW_PORT_COUNT,
      total_blocks: PREVIEW_PORT_BLOCK_COUNT,
    },
    occupied_blocks: occupiedBlocks,
    free_blocks: { items, has_more: freeStarts.length > items.length, limit: freeLimit },
    summary: {
      total_blocks: PREVIEW_PORT_BLOCK_COUNT,
      free: freeStarts.length,
      partial,
      occupied,
    },
  };
}

/**
 * 按 `users.fde_name` 取 `{id, fde_name}`；不存在返回 null（调用方 → 404 `not_found`）。
 * **不按 status 过滤**：offboarding 只停用不删号（fde-platform §7.3），`fde_name` 又带 UNIQUE，
 * 所以停用中的 FDE 仍是「已知 FDE」⇒ 列端点回空列表（它的行都已 released）而不是 404。
 */
export async function resolveFdeByName(clientOrPool, fdeName) {
  const r = await clientOrPool.query(`SELECT id, fde_name FROM users WHERE fde_name = $1`, [fdeName]);
  return r.rows[0] ?? null;
}

/**
 * **管理员改块 = 搬迁事务**（issue #246 交付②）。不是「追加」：
 * `ensureFdePreviewPorts` 全文件零 `UPDATE port_allocations`（insert-only），直接复用它补一段
 * 会让旧 10 条行继续活着占号、旧域名继续可访问（真机就会是 20 条活行）。所以这里
 * 先在**同一事务**里把本 FDE 的活行按 offboarding 的写法释放 + 撤 grant，再插新块。
 *
 * 原子顺序（测试逐序 deepEqual 钉住，`portal/test/preview-ports.test.js`）：
 *   BEGIN → 取本 FDE 活行 → 取全局活行 →（幂等判定 / 冲突判定，都不写库）
 *         → UPDATE 旧行 released（released_at=COALESCE(...)）→ UPDATE preview_grants revoked
 *         → 10× INSERT（ON CONFLICT (fde_id,port) WHERE state<>'released' DO NOTHING）
 *         → route_revisions → route_outbox → materialize_revisions → materialize_outbox → COMMIT
 * 任一步失败 ⇒ 整笔 ROLLBACK，零残留（旧行仍活、无新行、两条 outbox 都没有新行）。
 *
 * 幂等：目标块已经是本 FDE 的**整块**活行 ⇒ 直接返回 `changed:false`，**一个 SQL 写都不发**
 * （也不写审计；审计在 http 层、只在 `changed:true` 时落一行）。
 * 号码回收：`released` 行不占位 ⇒ 搬出去再搬回同一块能成功。
 *
 * @returns {Promise<{changed, blockStart, blockEnd, ports, releasedAllocations, revokedGrants,
 *                    inserted, routeRevisions, materializeRevision}>}
 * @throws `preview_port_block_invalid`（块起点非法）/ `preview_hostname_invalid`（FDE 名超域名预算）
 *         / `preview_port_block_taken`（块内有外来活行，或并发抢号导致插入数 ≠ 10）
 */
export async function moveFdePreviewBlock(pool, config, {
  fdeId, fdeName, blockStart, log = console,
} = {}) {
  if (!fdeId || !fdeName) {
    throw portsError('preview_ports_invalid_args', 'moveFdePreviewBlock: fdeId/fdeName required');
  }
  if (!config?.baseDomain) {
    throw portsError('preview_ports_invalid_args', 'moveFdePreviewBlock: baseDomain required（hostname 与路由同源生成，§8.5）');
  }
  // 纯校验一律**前置到开事务之前**：400 类错误（块非法 / 名超预算）必须做到零 SQL 就返回。
  assertAlignedPreviewBlockStart(blockStart);                       // code='preview_port_block_invalid'
  const grammar = validateFdeNameForHostname(fdeName, { baseDomain: config.baseDomain });
  if (!grammar.ok) throw portsError('preview_hostname_invalid', `moveFdePreviewBlock: ${grammar.message}`);

  const targetPorts = [...previewBlockPorts(blockStart)];
  const targetLabel = previewBlockLabel(blockStart);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 两次取数串行跑（同一连接）：与 ensureFdePreviewPorts 里的候选块取数同理，保证落在同一语句快照上。
    const ownPorts = await listOccupiedPreviewPorts(client, { fdeId });
    const occupied = await listOccupiedPreviewPorts(client);
    const own = new Set(ownPorts);

    // ① 幂等：本 FDE 的活行已经正好是**这一整块** ⇒ 零写返回（不释放、不重插、不入队、不写审计）。
    //    只有部分行（历史残缺）不当作「已经是这一块」——走完整搬迁，顺手补齐成整块。
    if (ownPorts.length === PREVIEW_PORT_COUNT && targetPorts.every((port) => own.has(port))) {
      await client.query('COMMIT');
      log.log?.(`[portalloc] fde=${fdeName} 已在预览端口块 ${targetLabel}，改块是空操作（零 SQL 写）`);
      return {
        changed: false, blockStart, blockEnd: previewBlockEnd(blockStart), ports: targetPorts,
        releasedAllocations: 0, revokedGrants: 0, inserted: 0,
        routeRevisions: [], materializeRevision: null,
      };
    }

    // ② 冲突：目标块内**有外来活行**就报错，**禁止**偷偷换成第一个空闲块（管理员显式指定的块）。
    //    本 FDE 自己的活行不算冲突——它们会在本事务里被释放（这也是「搬回自己刚释放的号」能成功的理由）。
    const foreign = targetPorts.filter((port) => occupied.includes(port) && !own.has(port));
    if (foreign.length > 0) {
      throw portsError(
        'preview_port_block_taken',
        `预览端口块 ${targetLabel} 已被占用（外来活行端口：${foreign.join(',')}；`
        + `占用判据 = 全局活行 state <> 'released'，本 FDE 自己的活行不算冲突）：`
        + `先释放或改走那段，或换一个整块空闲的对齐起点（${PREVIEW_PORT_POOL_START}、`
        + `${PREVIEW_PORT_POOL_START + PREVIEW_PORT_COUNT}、…，每段 ${PREVIEW_PORT_COUNT} 个）`,
      );
    }

    // ③ 释放旧行（照 offboarding.js:217-224 的写法：state='released' + released_at=COALESCE(now())，
    //    带 RETURNING 供 grant 撤权与「插入数 ≠ 10 也要回滚」的判据用）。
    const released = await client.query(
      `UPDATE port_allocations
          SET state = 'released', released_at = COALESCE(released_at, now())
        WHERE fde_id = $1 AND state <> 'released'
        RETURNING id`,
      [fdeId],
    );
    // ④ 撤 grant（与 offboarding 的 `release-network-routes` **同一口径**，#252）：
    //    - **只撤 `state = 'active'`**——`used` 是历史事实（已消费的 ticket 本身不再授予访问，它派生的
    //      session 才是活的东西，而 session 在同一批里会被撤）。把 `used` 塞进 `revoked` 会当场撞
    //      baseline 的双向 CHECK `(state = 'used') = (used_at IS NOT NULL)`（`preview_grants_check3`），
    //      真机就是本函数报的 500（issue #252）；而「顺手清 `used_at`」虽过 CHECK，是篡改历史。
    //    - **无条付发**（不挂在「本次真的释放了行」上）：幂等跟重试都要能走到这里，撤 0 行也是成功。
    const revoked = await client.query(
      `UPDATE preview_grants
          SET state = 'revoked', revoked_at = COALESCE(revoked_at, now())
        WHERE allocation_id = ANY($1::uuid[]) AND state = 'active'
        RETURNING id`,
      [released.rows.map((row) => row.id)],
    );
    const revokedGrants = revoked.rows.length;

    // ⑤ 插新块 + 两条派生链（**复用** ensureFdePreviewPorts：本 FDE 的活行此刻已全部 released，
    //    所以它不会再「补缺口」，10 条全走真插入 ⇒ route outbox ×10 + materialize revision 各一次）。
    const out = await ensureFdePreviewPorts(client, {
      fdeId,
      fdeName,
      baseDomain: config.baseDomain,
      publicBaseUrl: config.portalPublicBaseUrl ?? null,
      blockStart,
      log,
    });
    // ⑥ 插入数 ≠ 10 ⇒ 一定有并发抢号（占用取数与 INSERT 之间别人落了行，而 DO NOTHING 吃掉了一条），
    //    整笔回滚，**不许部分提交**（旧行还在 released 状态、但事务未 COMMIT ⇒ 外面看仍是旧的 10 条活行）。
    if (out.inserted.length !== PREVIEW_PORT_COUNT) {
      throw portsError(
        'preview_port_block_taken',
        `预览端口块 ${targetLabel} 搬迁中途只插入 ${out.inserted.length}/${PREVIEW_PORT_COUNT} 条（并发抢号）：`
        + '整笔事务判定回滚，旧块保持不变，请重试本次改块',
      );
    }

    await client.query('COMMIT');
    log.log?.(`[portalloc] fde=${fdeName} 改块 → ${targetLabel}：释放旧行 ${released.rows.length} 条、撤 grant ${revokedGrants} 条、新插 ${out.inserted.length} 条，同事务入队 route outbox ×${out.routeRevisions.length} + materialize revision ${out.materializeRevision}`);
    return {
      changed: true, blockStart, blockEnd: previewBlockEnd(blockStart), ports: targetPorts,
      releasedAllocations: released.rows.length, revokedGrants, inserted: out.inserted.length,
      routeRevisions: out.routeRevisions, materializeRevision: out.materializeRevision,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
