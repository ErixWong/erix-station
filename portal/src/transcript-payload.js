// transcript **payload 指纹**——本站唯一的「同 dedupKey 的两条记录算不算同一份」判据（issue #333 / M2）。
//
// 为什么要有这个文件（真雷，逐条已复证）：
//   erix-agent 0.22 新增三类「产生即入账」的补充行（`orchestrator.js:2123` `…:control:<slot>`、
//   `:fold:<fp>` / `:ttl:<fp>`），它们每次都带 `ts: new Date().toISOString()`，而 resume 重放同一个
//   dedupKey 时**必然拿到新的 ts**（`round` 同理：宿主预写行的 round 取 store 现有最大值）。
//   本站原先的幂等判据是「**整条 record** 的规范化 sha256」——`canonicalJson` 排的是整条记录，
//   顶层 `ts`/`round` 都算进哈希 ⇒ 引擎的崩溃重跑形状会被判成 `409 round_conflict`
//   （`internal.js` putRound/putSessionRound），而 `runner/lib/store.js` 对非 2xx 一律上抛
//   ⇒ 引擎按持久化失败处理，终局 `persistence_failed`。**不发这一半可以，发一半不行。**
//
// 尺子从哪来：引擎侧的同名判据在 `erix-agent/src/store/transcript-dedup.js`（issue #326 事实①），
// 但包 `exports` 只有 `.` / `./tools` / `./contract-tests` ⇒ **本站 import 不到**，只能自己实现等价件。
// 本文件的口径与上游逐字对齐（`portal/test/transcript-payload.test.js` 用深路径 import 上游模块
// 做**行为对拍**，漂移即红）：
//   · 摘要 = `sha256:` + 规范化 JSON 的 sha256 hex **前 24 位**；
//   · 规范化：对象**逐层排序键**（字段顺序不是语义）、数组**保序**（消息顺序是语义）；
//   · 只剥**顶层**四个键 `dedupKey`/`roundKey`（就是 key 本身）与 `round`/`ts`（写盘派生 / 墙钟）；
//     嵌套层的 `ts` 一律算内容（消息正文里的 ts 是内容不是信封）；宿主自有未知字段算内容；
//   · 非 JSON 叶子兜底与上游同：`bigint`→十进制字符串字面量、循环→`"[Circular]"`、
//     对象成员里的 `undefined`/函数/symbol 丢弃、`NaN`/`Infinity` 经 JSON.stringify 记成 `null`、
//     有 `toJSON()` 的先走 toJSON。
//
// ⚠ 判据只此一份：`internal.js`（U5 putRound / session putSessionRound 的幂等命中）与
//   `transcript-store.js`（引擎 appendUserTurn 消费面的适配器）都从这里取，**不许各写一份**。
//   runner 侧的运行期判据本来就在 portal（agentd 只是转发），故 runner 不另实现一份；
//   `runner/test/store-contract.test.js` 的内存 IPC peer 桩**直接 import 本文件**
//   （测试面跨包引用 portal 有先例：`runner/test/system-prompt.test.js:173` 引 `portal/src/previewpool.js`）。
import crypto from 'node:crypto';

/** 可判定的冲突码：宿主不必 instanceof 就能分流（随包契约套件第 17–22 条按 code 判，不按类型判）。 */
export const DEDUP_CONFLICT_CODE = 'dedup_payload_conflict';

/**
 * 顶层「身份 / 派生 / 墙钟」键：它们说明这条记录是谁、什么时候写的，**不**属于 payload。
 * 只剥顶层同名键，嵌套层级照常参与摘要。变异测试 ①/② 就是在动这张表。
 */
export const PAYLOAD_VOLATILE_FIELDS = Object.freeze(['dedupKey', 'roundKey', 'round', 'ts']);
const VOLATILE = new Set(PAYLOAD_VOLATILE_FIELDS);

/** 规范化 JSON（键逐层排序、数组保序、非 JSON 叶子确定性兜底）。 */
function canonicalJson(value, seen) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'undefined' || type === 'function' || type === 'symbol') return 'null';
  if (type === 'bigint') return JSON.stringify(String(value));
  if (type !== 'object') return JSON.stringify(value) ?? 'null';
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  try {
    const toJSON = value.toJSON;
    if (typeof toJSON === 'function') return canonicalJson(toJSON.call(value), seen);
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const childType = typeof value[key];
      // 与 JSON.stringify 同取舍：对象成员里的 undefined/函数/symbol 整个丢掉。
      if (childType === 'undefined' || childType === 'function' || childType === 'symbol') continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/** 参与摘要的那一份：顶层身份/派生字段剥掉，其余原样（非对象原样返回，与上游同）。 */
export function payloadOf(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return record;
  const kept = {};
  for (const [field, value] of Object.entries(record)) {
    if (VOLATILE.has(field)) continue;
    kept[field] = value;
  }
  return kept;
}

/** 摘要：`sha256:<24 hex>`（比较与日志指认用，不当密码学承诺）。 */
function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value, new WeakSet())).digest('hex').slice(0, 24)}`;
}

/** payload 指纹（幂等/冲突的唯一判据）。 */
export function payloadFingerprint(record) {
  return digest(payloadOf(record));
}

/** 同 key 的两份记录是否同一份 payload（internal 端点幂等命中的判据）。 */
export function samePayload(existing, incoming) {
  return payloadFingerprint(existing) === payloadFingerprint(incoming);
}

/**
 * 诊断用：两份记录的顶层差异字段名（含只在一侧出现的字段）；取不到正文时返回空数组。
 * 排序后取前 8 个，避免一条错误消息把整个字段表抄完（与上游同口径）。
 */
export function differingTopLevelFields(existing, incoming) {
  const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!plain(existing) || !plain(incoming)) return [];
  const ex = payloadOf(existing);
  const inc = payloadOf(incoming);
  const differing = [];
  for (const name of [...new Set([...Object.keys(ex), ...Object.keys(inc)])].sort()) {
    if (digest(ex[name]) !== digest(inc[name])) differing.push(name);
  }
  return differing.slice(0, 8);
}

/**
 * 同 key 异 payload 的冲突错误。**code 是公开判据**（随包契约套件按 `code === 'dedup_payload_conflict'`
 * 分流，不是 instanceof），并带 key / 两份指纹 / 差异顶层字段，message 里必须含 key。
 */
export class TranscriptPayloadConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TranscriptPayloadConflictError';
    this.code = DEDUP_CONFLICT_CODE;
    this.runId = details.runId;
    this.key = details.key;
    this.existingFingerprint = details.existingFingerprint;
    this.incomingFingerprint = details.incomingFingerprint;
    this.differingFields = details.differingFields ?? [];
  }
}

/**
 * 造冲突错误（消息形状与上游 `dedupConflictError` 对齐：runId、key、两份指纹、差异字段、
 * 以及「既不覆盖也不静默丢弃」的语义声明）。`existing` 传 undefined = 既有正文取不到，只能比指纹。
 */
export function dedupPayloadConflict({ runId, key, existing, incoming, existingFingerprint, incomingFingerprint }) {
  const differingFields = differingTopLevelFields(existing, incoming);
  const where = differingFields.length > 0
    ? ` differing top-level fields: ${differingFields.join(', ')}.`
    : '';
  return new TranscriptPayloadConflictError(
    `transcript appendRound dedup conflict (runId=${runId}, key=${key}):`
      + ` a record with this key is already persisted but its payload differs`
      + ` (existingFingerprint=${existingFingerprint}, incomingFingerprint=${incomingFingerprint}).`
      + ` Same-key append with a different payload is rejected — no overwrite, no silent drop;`
      + ` the stored record stays as-is.${where}`
      + ` Payload fingerprint = sha256 over the canonical JSON of the record with the top-level`
      + ` identity/volatile fields (${PAYLOAD_VOLATILE_FIELDS.join(', ')}) removed;`
      + ` object keys are sorted, array order is kept.`,
    { runId, key, existingFingerprint, incomingFingerprint, differingFields },
  );
}

/**
 * 去重键派生——与上游 `recordKey(runId, record)` 逐字同式：`dedupKey ?? roundKey ?? <key>:round:<round>`。
 * 随包契约套件第 22 条要求 `error.key` 等于**回落后的**值 ⇒ 任何报冲突的地方都必须用本函数取键。
 * portal 的两个适配器因迁移 0006 的列口径一直要求 `dedupKey ?? roundKey` 至少存在一个（§8.6 既定
 * shape，列必填），所以本函数主要用在 runner 的 IPC peer 桩与测试侧 fixture 造隐式键上。
 */
export function transcriptRecordKey(key, record) {
  return record?.dedupKey
    ?? record?.roundKey
    ?? `${String(key)}:round:${String(record?.round)}`;
}

/**
 * internal 端点用的冲突详情（**零新错误码**：409 面继续用既有 `round_conflict`，只把可指认的证据
 * 挂进 `details`）：两份 payload 指纹 + 顶层差异字段名。
 */
export function dedupConflictDetails(existing, incoming) {
  return {
    existingFingerprint: payloadFingerprint(existing),
    incomingFingerprint: payloadFingerprint(incoming),
    differingFields: differingTopLevelFields(existing, incoming),
  };
}
