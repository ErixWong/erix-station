// 预览端口**全局号池**（issue #246 交付①）——池边界 / 块几何 / 预览域名预算常量的唯一真相源。
//
// 决策（决策者 2026-10-11，issue #246）：全局唯一一个号池 `22000–29999`（8000 个号 = 800 段），
// 开户默认发「池内最小的未占用**对齐块**」（10 个一段：22000–22009、22010–22019 …）。这条**取代**
// #240 的「每个 FDE 都发同一段 4000–4009」——那条实现让真机 eric 与 tetris 同时持有 4000–4009
// （10 组跨 FDE 重叠），因为既有唯一索引只按 FDE 判重。重叠从此是**硬不变式**，由迁移 0019 建的
// 部分唯一索引 `port_allocations_live_global_port_key UNIQUE (port) WHERE state <> 'released'` 保证。
//
// 为什么要单独一个叶子模块（而不是把常量放在 portalloc.js 里让 projects.js 反向引用）：
//   `projects.js`（域名语法与预算）与 `portalloc.js`（分配）都要用这批常量，而 portalloc 已经
//   单向依赖 projects（`buildHostname` / `previewUrl` / `validateFdeNameForHostname`）。让
//   `projects.js` 再 import `portalloc.js` 就构成 ESM 循环，而循环里 `projects.js` 顶层要读的
//   `const` 在「先加载 portalloc」的入口（`portal/test/portalloc.test.js`、
//   `runner/test/system-prompt.test.js`）上还没初始化 → TDZ ReferenceError。本模块零依赖，
//   两边都只向下引用，预算与池边界因此仍然只有一份。
//
// 5 位端口的连锁（issue #246 最容易漏的一组）：`buildHostname` 的首标签固定段是 `-p-<port>`，
// 端口进 5 位后固定段从 7 字符变 8 字符 ⇒ **FDE 名预算 56 → 55**。预算由 `PREVIEW_PORT_POOL_END`
// 的实际宽度推导（见 `PREVIEW_PORT_LABEL_WIDTH`），不写死 `4000`、也不写死 56/55——写死就会让
// 56 字符的名字过应用校验、再到 INSERT 时被 0017 的 hostname CHECK 以 23514 炸掉（#202 的病根）。

/** 号池边界（含端点）。`0019` 的 port CHECK 活行分支与本常量同口径。 */
export const PREVIEW_PORT_POOL_START = 22000;
export const PREVIEW_PORT_POOL_END = 29999;

/** 默认块大小（决策者：一个 FDE 默认一段 10 个）。同时是块对齐粒度。 */
export const PREVIEW_PORT_COUNT = 10;

/** 号池总段数（容量口径写进文档：800 段）。 */
export const PREVIEW_PORT_BLOCK_COUNT = (PREVIEW_PORT_POOL_END + 1 - PREVIEW_PORT_POOL_START) / PREVIEW_PORT_COUNT;

/** `buildHostname` 里端口段的 `padStart` 宽度（端口不足 4 位时零填充）。 */
export const PREVIEW_PORT_LABEL_MIN_WIDTH = 4;

/** hostname 首标签的固定标记段（P5 去项目化后无项目名段，规格 §8.5）。 */
export const PREVIEW_PORT_SEGMENT = '-p-';

/** DNS 单标签上限（RFC 1035）。 */
export const DNS_LABEL_MAX_LEN = 63;

/**
 * 首标签里**端口段的最坏宽度**：池内最大端口的十进制位数（5），且不低于 `padStart` 的补零宽度（4）。
 * ⇒ 号池换边界时这里自动跟着变，不需要人记「现在是 4 位还是 5 位」。
 */
export const PREVIEW_PORT_LABEL_WIDTH = Math.max(
  PREVIEW_PORT_LABEL_MIN_WIDTH,
  String(PREVIEW_PORT_POOL_END).length,
);

/** 首标签固定段 `-p-<port>` 占的字符数（号池口径下 = 3 + 5 = **8**；旧的 4 位端口时代是 7）。 */
export const PREVIEW_PORT_SEGMENT_LEN = PREVIEW_PORT_SEGMENT.length + PREVIEW_PORT_LABEL_WIDTH;

/** FDE 名参与预览域名的有效预算 = 63 − 固定段 = **55**（#240 时代是 56）。 */
export const MAX_FDE_NAME_LEN_FOR_HOSTNAME = DNS_LABEL_MAX_LEN - PREVIEW_PORT_SEGMENT_LEN;

/**
 * 预算校验用的**探测端口**：取池内最宽的端口，拼出来的首标签就是最坏情况。
 * （旧实现把 `4000` 写死在这里，是「56 字符过关 → DB 23514」的直接原因。）
 */
export const PREVIEW_PORT_BUDGET_PROBE_PORT = PREVIEW_PORT_POOL_END;

/** 端口是否落在号池内（活行的硬判据，与 0019 的 CHECK 活行分支同口径）。 */
export function isPreviewPortInPool(port) {
  return Number.isInteger(port) && port >= PREVIEW_PORT_POOL_START && port <= PREVIEW_PORT_POOL_END;
}

/** 端口所在对齐块的起点（`22000 / 22010 / …`）。 */
export function alignedPreviewBlockStart(port) {
  return PREVIEW_PORT_POOL_START + Math.floor((port - PREVIEW_PORT_POOL_START) / PREVIEW_PORT_COUNT) * PREVIEW_PORT_COUNT;
}

/** 块起点是否合法：10 的倍数（池起点本身是 10 的倍数）且整块落在池内。 */
export function isAlignedPreviewBlockStart(blockStart) {
  return Number.isInteger(blockStart)
    && (blockStart - PREVIEW_PORT_POOL_START) % PREVIEW_PORT_COUNT === 0
    && blockStart >= PREVIEW_PORT_POOL_START
    && blockStart + PREVIEW_PORT_COUNT - 1 <= PREVIEW_PORT_POOL_END;
}

/**
 * 校验调用方指定的块起点（管理员覆盖 / 交付② 的「改块」入口）。
 * 不合法直接抛 `preview_port_block_invalid`，文案给出池边界与对齐要求。
 */
export function assertAlignedPreviewBlockStart(blockStart) {
  if (!isAlignedPreviewBlockStart(blockStart)) {
    const err = new Error(
      `预览端口块起点 ${JSON.stringify(blockStart)} 不合法：必须是 ${PREVIEW_PORT_COUNT} 的倍数、`
      + `且整块落在号池 ${PREVIEW_PORT_POOL_START}–${PREVIEW_PORT_POOL_END} 内`
      + `（合法起点：${PREVIEW_PORT_POOL_START}、${PREVIEW_PORT_POOL_START + PREVIEW_PORT_COUNT}、…、${PREVIEW_PORT_POOL_END - PREVIEW_PORT_COUNT + 1}）`,
    );
    err.code = 'preview_port_block_invalid';
    throw err;
  }
}

/** 一段块里的端口（升序）。 */
export function previewBlockPorts(blockStart) {
  assertAlignedPreviewBlockStart(blockStart);
  return Object.freeze(
    Array.from({ length: PREVIEW_PORT_COUNT }, (_, i) => blockStart + i),
  );
}

/**
 * 纯函数：**池内最小的「整块无人占用」对齐块**起点；号池用尽返回 null。
 *
 * 占用判据（issue #246，与迁移 0019 的索引谓词逐字同口径）：
 *   - 只看**全局活行**（`state <> 'released'`），**不分 FDE**、不分 scope/role ⇒ 跨 FDE 不重叠；
 *   - `released` 行不算占用 ⇒ 号码可回收复用；
 *   - **整块**判定：块内 10 个端口只要有 1 个被占，整块跳过 ⇒ 一个 FDE 拿到的是连续一整段，
 *     也不会把外来行侵吞进自己的段里（那样下一次插入就会撞全局唯一索引）。
 *
 * 这里只是**算候选**，不是「先查后插」的查重：真正的并发安全由 0019 的全局唯一索引提供
 * （撞号 ⇒ 23505 → `preview_port_block_taken` ⇒ 调用方重试取下一段），所以不需要 advisory lock。
 *
 * @param {Iterable<number>} occupiedPorts 全局活行端口（调用方从 DB 取）
 * @param {{ skipBlocks?: Iterable<number> }} [opts] skipBlocks：额外整块排除的块起点
 *        （例如本 FDE 已在池外占过号、需要跳过历史块；一般用不到）
 */
export function firstFreePreviewBlockStart(occupiedPorts, { skipBlocks = [] } = {}) {
  const occupied = new Set(occupiedPorts);
  const skip = new Set(skipBlocks);
  for (let block = PREVIEW_PORT_POOL_START; block + PREVIEW_PORT_COUNT - 1 <= PREVIEW_PORT_POOL_END; block += PREVIEW_PORT_COUNT) {
    if (skip.has(block)) continue;
    let taken = false;
    for (let i = 0; i < PREVIEW_PORT_COUNT; i += 1) {
      if (occupied.has(block + i)) { taken = true; break; }
    }
    if (!taken) return block;
  }
  return null;
}
