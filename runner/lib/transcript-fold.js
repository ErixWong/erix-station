// 消息行读侧折叠（**runner 侧镜像**）—— issue #351（口径真相源：`portal/src/transcript-fold.js`）
//
// **为什么要有这份镜像**：上游 erix-agent 0.23.0 的「一条消息一落盘」把读侧折叠放在 **store 的 `load()`
// 里**（`store/message-rows.js#foldMessageRows` 由 file/memory 两个内置 store 的 `load()` 调用；
// `host-consumer-contract.md:2405-2409` 与 `:2442`「宿主读账本必须经 `load()`，不要自己重折」），
// 而本站引擎面向的 store 是 `runner/lib/store.js`（HTTP/IPC 版），它过去**直通 portal 原始行**
// ⇒ 引擎从来没经过任何折叠 ⇒ 会话永久 `invalid_messages`（真标本：`:input:` 行插在 `tool_use`
// 与它迟到的 `tool_result` 之间 ⇒ `index 56`；链式 `partOf` ⇒ `index 81`）。
// 折叠口径与 portal 那份**必须同一条尺**，而运行期不能跨包 import：FDE 镜像的 build context 是
// `runner/`（`runner/Dockerfile`），portal 源码不在镜像里。⇒ 镜像 + 机器锁，先例见
// `runner/lib/llm-models.js` 的 `positiveIntOrNull`（与 `portal/src/llm.js` 同名镜像 + 对面测试）。
//
// **两条机器锁**（`runner/test/store-load-fold.test.js`）：
//   1. 下面 `SHARED-FOLD-CORE` 区间的**源码逐字节**与 `portal/src/transcript-fold.js` 的同名区间相同
//      ⇒ 单边改口径必红（漂移只能靠两边一起改）；
//   2. 与**上游真件**（按文件路径 import `node_modules/erix-agent/src/store/message-rows.js`）在
//      「无链账本」上逐字段对拍 ⇒ 上游改口径/挪文件那边红。
//
// **#341 解链闸照搬**（分片行也登记自己的 key）：上游 erix-agent #415 未修 ⇒ 这块是**闸**不是设计，
// 上游落地并升 pin 后与 portal 那份**一起撤**（`portal/test/transcript-fold.test.js` 的源码级哨兵会红
// 提示撤闸；撤闸时两份镜像同时收缩，别只撤一边）。
//
// **挂在哪**：`runner/lib/store.js#load`（引擎 `store.load()` 的唯一实现点，agentd 已把游标翻页
// 的**全量**拉齐 ⇒ 折叠看得见整轮；**不要**接到 portal 分页端点的页内，一轮跨页会漏折，#338 同根）。
// **故意不折**：portal 侧 `transcript-store.js` 的 `load`/`loadByDedupKey`/`loadMaxRound`（发消息
// 预写幂等面要看见自己那条 `:input:` 行）、`session-text.js` 的单行点查——与本模块无关。

// ===== SHARED-FOLD-CORE BEGIN =====
/** 消息行的 `kind` 字面值（上游 `message-rows.js#MESSAGE_ROW_KIND` 同值）。 */
export const MESSAGE_ROW_KIND = 'message';

/**
 * 可折叠的消息行：`kind === "message"` 且带轮内序号 `seq` 且带非空 `messages`。
 * 与上游 `isFoldableMessageRow` 逐字同构（谓词放宽会误折宿主的 `:input:` 行 / 非消息行）。
 * @param {any} record
 * @returns {boolean}
 */
export function isFoldableMessageRow(record) {
  return record?.kind === MESSAGE_ROW_KIND
    && Number.isSafeInteger(record.seq)
    && Array.isArray(record.messages)
    && record.messages.length > 0;
}

/** 行 key：`dedupKey ?? roundKey`（上游 `rowKey` 同式；非字符串 = 无 key）。 */
function defaultKeyOf(record) {
  const key = record?.dedupKey ?? record?.roundKey;
  return typeof key === 'string' ? key : '';
}

/**
 * 这一行能不能当该轮的载体（正文挂回它身上）。口径见文件头第 2 条：
 * `<…>:round:<n>` 或 `<…>:round:<n>:resume`（后者是 resume 预落盘的轮行）。
 */
function isRoundCarrier(record, round, keyOf) {
  const key = keyOf(record);
  if (typeof key !== 'string' || key === '') return false;
  const suffix = `:round:${String(round)}`;
  return key.endsWith(suffix) || key.endsWith(`${suffix}:resume`);
}

/** 把分片的 content blocks 接到目标消息后面；目标消息是浅拷贝，不改动入参行（上游同式）。 */
function mergePartIntoMessage(target, part) {
  const targetContent = Array.isArray(target.content) ? [...target.content] : [target.content];
  const partContent = Array.isArray(part.content) ? part.content : [part.content];
  return { ...target, content: [...targetContent, ...partContent] };
}

/**
 * 折叠计划：哪些行被吸收（`consumed`）、哪个载体接哪批正文（`attached`）。
 * 无可折叠行 / 折完一行都没被吸收 ⇒ `null`（调用方据此返回**入参本身**）。
 * @param {any[]} records
 * @param {(record: any) => string} keyOf
 * @returns {{ consumed: Set<number>, attached: Map<number, object[]> } | null}
 */
function planFold(records, keyOf) {
  /** @type {Map<number, { carrier: number, rows: number[] }>} */
  const groups = new Map();
  let foldable = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const round = Number.isSafeInteger(record?.round) ? record.round : undefined;
    if (round === undefined) continue;
    let group = groups.get(round);
    if (group === undefined) {
      group = { carrier: -1, rows: [] };
      groups.set(round, group);
    }
    if (isFoldableMessageRow(record)) {
      foldable += 1;
      group.rows.push(index);
    } else if (group.carrier === -1 && isRoundCarrier(record, round, keyOf)) {
      group.carrier = index;
    }
  }
  if (foldable === 0) return null;

  /** @type {Set<number>} 被吸收（不再单独出现在返回数组里）的行下标 */
  const consumed = new Set();
  /** @type {Map<number, object[]>} 载体行下标 → 折回的正文 */
  const attached = new Map();
  for (const group of groups.values()) {
    if (group.carrier === -1 || group.rows.length === 0) continue; // 无载体：消息行原样留着
    const ordered = [...group.rows].sort((left, right) => (
      (records[left].seq ?? 0) - (records[right].seq ?? 0) || left - right
    ));
    const messages = [];
    /** @type {Map<string, number>} partOf 目标行 key → messages 里的下标 */
    const parts = new Map();
    for (const index of ordered) {
      const row = records[index];
      consumed.add(index);
      const key = keyOf(row);
      const partOf = typeof row.partOf === 'string' ? row.partOf : '';
      const partTargetIndex = partOf === '' ? -1 : parts.get(partOf) ?? -1;
      if (partTargetIndex >= 0 && row.messages.length === 1) {
        // 分片：接到它指认的那条消息后面（分片行自身不出现在正文里）
        messages[partTargetIndex] = mergePartIntoMessage(messages[partTargetIndex], row.messages[0]);
        // #341 解链：分片行**自己也登记**进 parts，指向它被接进去的那个同一消息下标。
        // 0.23 写侧把 `partOf` 写成**链**（`orchestrator.js` 里每落一片就 `toolResultRowKey =
        // persistedRowKey`，后一片指前一片）⇒ 不登记的话第 3 片起 `parts.get(partOf)` 落空，
        // 它会被当成一条**独立消息**排出去（同一轮的聚合 `tool_result` 被劈成多条）。
        // 上游 `foldMessageRows` 尚未修（erix-agent #415）；上游落地并升 pin 后本段整体可撤。
        if (key !== '') parts.set(key, partTargetIndex);
        continue;
      }
      if (key !== '') parts.set(key, messages.length);
      messages.push(...row.messages);
    }
    attached.set(group.carrier, messages);
  }
  if (consumed.size === 0) return null;
  return { consumed, attached };
}

/**
 * 读侧折叠（record 级）：把 `kind: "message"` 行的正文按轮拼回轮行。
 * 无可折叠行 ⇒ **返回入参本身**（同一数组引用；老账本零改写是硬要求）。
 *
 * @template {{ round?: number, seq?: number, kind?: string, partOf?: string, messages?: object[] }} T
 * @param {T[]} records
 * @param {{ keyOf?: (record: T) => string }} [options] `keyOf` 取行 key（缺省 `dedupKey ?? roundKey`，
 *   与上游同式）。**对拍测试必须显式传**：站内 record 带 `dedupKey`，而一旦缺省口径变了，对拍会
 *   退化成「两边都认不出载体」的假绿。
 * @returns {T[]}
 */
export function foldLedgerRecords(records, { keyOf = defaultKeyOf } = {}) {
  if (!Array.isArray(records)) return records;
  const plan = planFold(records, keyOf);
  if (plan === null) return records;
  const folded = [];
  for (let index = 0; index < records.length; index += 1) {
    if (plan.consumed.has(index)) continue;
    const record = records[index];
    const messages = plan.attached.get(index);
    folded.push(messages === undefined
      ? record
      : { ...record, messages: [...(record.messages ?? []), ...messages] });
  }
  return folded;
}
// ===== SHARED-FOLD-CORE END =====

