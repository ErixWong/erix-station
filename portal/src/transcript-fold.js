// 消息行读侧折叠 —— issue #337 切片 A+B（erix-agent 0.23.0「一条消息一落盘」的宿主读面）。
//
// 背景（上游 0.23.0 改的是**写侧形状**，本站读侧必须跟着折）：一轮的正文不再写在轮记录上，而是
// 一条消息一成型就落一行 `kind: "message"`（`dedupKey = <key>:msg:<round>:<seq>`，`seq` 轮内从 0
// 递增；一轮多个 `tool_result` 各写一行，用 `partOf` 指认「我是哪条逻辑消息的分片」），轮记录只剩
// 元数据。上游 `store.load()` 在返回前把它们折回轮行（`erix-agent/src/store/message-rows.js`
// 的 `foldMessageRows`），所以**引擎自己的读法（`foldLedgerMessages` / 投影 / resume）看到的仍是
// 「一轮一条记录、记录自带 messages」的老形状**。
//
// 本站漏了这一折：`projectSessionMessages` 把 `transcript_rounds` 的**原始行**逐行喂给
// `projectTranscriptForDisplay`，而 session 作用域行的 `run_id` 恒为 NULL（迁移 0015）⇒ 消息行在
// `session-view.js` 的 `isSessionRound` 守卫处被**整行丢弃**（`<sessionId>:msg:<round>:<seq>` 既不是
// `:round:` 也不是 `:engine:round:` 前缀），轮行又没有 `messages` ⇒ 投影回退 `response.content`，
// 而 `response.content` 只有 assistant 侧的块 ⇒ **工具结果配不上对**：
// 刷新/重开会话后每张工具卡片从 `✓`/`✗` 退化成 `…`（`resultPreview` / `isError` / `executionStatus`
// 三件全丢）。正文没坏、也不重复（上一片 §4.2/§9 实测）。
//
// 折叠口径与上游 `foldMessageRows` **逐字同构**（三条，缺一不可）：
//   1. **分组**：按顶层 `round` 分组；组内按 `seq` 升序（`seq` 相同按行序）拼接 `messages`；
//   2. **载体**：拼回该轮的**轮行**——key 以 `:round:<n>` 或 `:round:<n>:resume` 结尾的非消息行
//      （`<key>:engine:round:<n>`、`<key>:round:<n>`、`<key>:engine:round:<n>:resume`）；
//      **载体不在场**（分页切在轮中间、崩溃在轮行落盘之前）⇒ 消息行**原样留在数组里**，一个字节不改：
//      每行各自一条记录（key 与 `round` 都是它自己的，`partOf` 也不合并），**绝不静默丢内容**；
//   3. **老账本原样透传**：整个数组没有可折叠消息行 ⇒ 返回**入参本身**（同一个数组引用、同一批对象），
//      不复制不改写 ⇒ 0.22 及更早的账本（轮行自带 `messages`、没有消息行）读出来逐字节不变。
//
// 两个刻意的设计约束（与上游一致，别自己发明）：
//   · **只有带安全整数 `seq` 且 `messages` 非空的消息行参与折叠**。宿主 `appendUserTurn` 写的
//     `:input:<messageId>` 行**带正文但不带 `kind`**，没有轮内序号也就没有排序依据；更硬的理由是它的
//     幂等判据是「`load()` 里能看见自己那条 dedupKey」——被折叠吸走就会重复追加同一轮追问。
//   · **`partOf`**：一条逻辑消息的分片（一轮多个 `tool_result`）接回它指认的那条消息后面，拼成
//     **同一条**消息 ⇒ 折叠后的 `messages` 与 0.22 那条聚合消息深比较相等（否则恢复上下文会
//     `invalid_messages`：一条 assistant 的 `tool_use` 必须由紧随其后的**那一条** user 消息结清）。
//
// 为什么本站要自己实现一份而不是 import 上游：`foldMessageRows` **不在包 exports 面**（只有 `.` /
// `./tools` / `./contract-tests`）。本站先例是 `./transcript-payload.js`（同为「与上游同源的单一条尺」），
// 它的做法照抄过来：`portal/test/transcript-fold.test.js` 按**文件路径** import 上游真件做逐字段对拍，
// 上游挪文件/改名/改口径 ⇒ 那边红，而不是两把尺各自漂移。
//
// 挂在哪：`session-view.js#projectSessionMessages`（咽喉点）。全站喂 `projectTranscriptForDisplay`
// 的两个业务读点（`sessions.js#fetchSession` 的对话流、`session-text.js#projectAnchors`）都过它，
// 一处接线覆盖两个调用方，结构上不会「改了一个漏一个」。
// **故意不折的地方**（各有硬理由，别顺手也折上）：
//   · `transcript-store.js` 的 `load` / `loadByDedupKey` / `loadMaxRound` —— 发消息**预写幂等**面，
//     必须看见自己那条 `:input:` 行（与上游「两个点查探针不折叠」同口径）；
//   · `session-text.js#fetchInputTextByMessageId` —— 按 `dedup_key = <sessionId>:input:<messageId>`
//     **点查单行**，读的是 `appendUserTurn` 写的用户输入行，天生不需要折；
//   · `internal.js#getSessionTranscript`（引擎 resume 取上下文，引擎自己会 `foldLedgerMessages`）与
//     `getTranscript` / `collectRoundText` / `recallTranscript`（run 作用域 legacy，session 行 `run_id`
//     为 NULL ⇒ 新数据不在命中集里）。

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

/** 行级折叠的缺省写法：`transcript_rounds` 行形状（正文在 `row.record.messages` 上）。 */
function defaultWithRecord(row, messages, record) {
  return { ...row, record: { ...record, messages: [...(record.messages ?? []), ...messages] } };
}

/**
 * 读侧折叠（DB 行级）：与 `foldLedgerRecords` **同一份计划**（单一真相源），只是把结果写回行。
 * `recordOf` 必须由调用方注入——它要合成 `dedupKey`/`round`（`session-view.js#recordForProjection`
 * 的口径），本模块不复制那套规则，避免两处漂移。
 *
 * 无可折叠行 ⇒ **返回入参本身**（同一数组引用）。
 *
 * @template {{ record?: object, round?: number }} R
 * @param {R[]} rows
 * @param {{ recordOf: (row: R) => any, withRecord?: (row: R, messages: object[], record: any) => R,
 *   keyOf?: (record: any) => string }} options
 * @returns {R[]}
 */
export function foldTranscriptRows(rows, { recordOf, withRecord = defaultWithRecord, keyOf = defaultKeyOf } = {}) {
  if (!Array.isArray(rows)) return rows;
  const records = rows.map((row) => recordOf(row));
  const plan = planFold(records, keyOf);
  if (plan === null) return rows;
  const folded = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (plan.consumed.has(index)) continue;
    const messages = plan.attached.get(index);
    folded.push(messages === undefined
      ? rows[index]
      : withRecord(rows[index], messages, records[index]));
  }
  return folded;
}
