// portal 侧最小 transcript store 适配器（erix-agent 0.17.0 `appendUserTurn` 消费面）。
//
// 背景（P3 契约① / 上游 issue #97，docs/design/conversation-state.md §6）：
// POST 消息事务内的用户输入预写入自 0.15.0 起由引擎 API `appendUserTurn(store, {key, text, messageId})`
// 承担——round 推导、dedupKey 生成（`<key>:input:<messageId>`）、record 形态、幂等判据（按 dedupKey）
// 全部由引擎负责；本模块只提供引擎要求的 store 方法，**复用调用方传入的事务 client**，
// 使 load/探针/appendRound 与 messages 插入、run 入队落在同一事务（原子性红线，勿改动 client 来源）。
//
// 0.17.0 成对可选快路径探针（issue #193 / 上游 issue #157）：本 store 同时实现
// loadByDedupKey/loadMaxRound（缺一如缺二），appendUserTurn 遂改走点查快路径——命中即返回既有
// record、未命中才取 MAX(round)，**全程不再调 store.load**，POST 预写事务成本不再随 session 行数增长。
//
// 落库形态与手搓时代（PR②a）逐列等价：
//   run_id=NULL、transcript_key=key、dedup_key=record.dedupKey、round=record.round、
//   record=引擎 record 原样、folded=false、messages=record.messages（派生列）、folded_payload=NULL。
// 唯一性兜底保留 `ON CONFLICT (transcript_key, dedup_key) DO NOTHING`（迁移 0006 部分唯一索引）：
// 引擎的幂等判据是按 dedupKey 查既有记录（顺序重放语义：0.17.0 起走 loadByDedupKey 点查，
// 两探针缺任一才回退全量 load）；同 key 并发由 postMessage 的 session FOR UPDATE 串行化，
// ON CONFLICT 是本事务之外的最后防线。
import { appendUserTurn } from 'erix-agent';
import { foldLedgerRecords } from './transcript-fold.js'; // 0.25.0 契约判据：load() 必须返回折叠后形状
import {
  payloadFingerprint, samePayload, dedupPayloadConflict, transcriptRecordKey,
} from './transcript-payload.js';

/**
 * 点查既有 record（与 `loadByDedupKey` 同一条 SQL、同一个谓词）：appendRound 判「同 key 异 payload」
 * 时的读面——**判据只有一把尺**（`./transcript-payload.js`），读面也必须与探针同源，否则快路径与
 * 写入路径会对同一条行给出不同结论（随包契约「loadByDedupKey 与 load 事实一致」同源要求）。
 * @returns {Promise<object|null>}
 */
async function readStoredRecord(client, key, dedupKey) {
  const res = await client.query(
    `SELECT record
       FROM transcript_rounds
      WHERE transcript_key = $1 AND dedup_key = $2
      LIMIT 1`,
    [key, dedupKey],
  );
  return res.rows?.[0]?.record ?? null;
}

/**
 * 事务绑定的 session transcript store（引擎 load/appendRound 两方法契约
 * + 0.17.0 成对可选快路径探针 loadByDedupKey/loadMaxRound）。
 * @param {import('pg').PoolClient} client 调用方事务内的 PoolClient（禁止换成 pool 自身，否则脱离事务）
 */
export function createSessionTranscriptStore(client) {
  return {
    /** 读该 key 的全部轮记录（round/dedup_key 以权威列合成进 record，供引擎推导与幂等判据）。
     *
     *  **erix-agent 0.25.0 起本方法必须折叠**：上游 #458 把「宿主 `load()` 必须返回折叠后形状」
     *  从散文变成**随包契约断言**（`test/contract/transcript-store.js` 的 #401 / #458 那四格），
     *  不折就是宿主违约（实测翻红四格）。
     *  issue #337 当年「故意不折」的理由（`appendUserTurn` 要能看见自己那条
     *  `<key>:input:<messageId>` 行，被吸走就会重复追加同一轮追问）**依然成立，但与此不冲突**，两条都守住了：
     *    · 真正的幂等判据走 **`loadByDedupKey` 点查**（0.17.0 #157 起，见本文件头），那条路**照旧不折**；
     *    · `:input:` 行本身**折不走**——它不带 `kind: "message"` 也不带 `seq`，`isFoldableMessageRow`
     *      判不通过，折叠之后仍作为独立记录留在数组里（`portal/test/transcript-store.test.js` 钉着）。
     *  `loadMaxRound` 同样不折（成对探针只认原始行）。 */
    async load(key) {
      const res = await client.query(
        // 0.16.0 契约（host-upgrade-guide §1 same-round ordering）：同 round 多行必须按持久化
        // 追加序返回，引擎不再二次排序 → 用 append_seq（迁移 0016，恒非空），不再依赖 created_at。
        `SELECT round, dedup_key, record
           FROM transcript_rounds
          WHERE transcript_key = $1
          ORDER BY round, append_seq`,
        [key],
      );
      const records = (res.rows ?? []).map((row) => {
        const base = row.record && typeof row.record === 'object' ? row.record : {};
        return {
          ...base,
          round: Number(row.round),
          // appendUserTurn 幂等判据读 dedupKey ?? roundKey；列缺失时回退 record 内字段。
          dedupKey: row.dedup_key ?? base.dedupKey ?? base.roundKey ?? null,
        };
      });
      // 单一真相源：与展示面 / runner 镜像同一份 `planFold`（口径漂移会同时被三处用例抓到）
      return foldLedgerRecords(records);
    },
    /**
     * 追加一轮：会话预写行恒为 run_id=NULL / folded=false / folded_payload=NULL（同 PR②a 形态）。
     *
     * 幂等/冲突判据（issue #333 M2，与 `internal.js` 的两个轮记录端点**共用同一个件**
     * `./transcript-payload.js`，口径与上游 `erix-agent/src/store/transcript-dedup.js` 逐字对齐）：
     *   · `ON CONFLICT … DO NOTHING` 从「静默丢弃」降级成**并发防线**：真正判幂等的是命中后
     *     读回既有 record 再比 **payload 指纹**（只剔顶层 `dedupKey`/`roundKey`/`round`/`ts`）：
     *     同 key + 同 payload ⇒ 幂等 no-op（`{inserted:false}`，不新增行、不覆盖既有行）；
     *   · 同 key + 异 payload ⇒ 抛 `error.code === 'dedup_payload_conflict'`（随包契约套件第 17–22 条
     *     按 **code** 分流，不看 instanceof），**既不覆盖也不静默丢弃**——旧行为把真冲突也一起吞了，
     *     于是契约里「异 payload 必须报错」的 4 条在本站适配器上恒红。
     * ⚠ 继续复用**调用方事务里的同一个 client**（红线，勿换成 pool）：判冲突的那笔 SELECT 也必须
     *   落在同一事务里，否则「查既有 → 比对」与 INSERT 会跨事务撕裂。
     */
    async appendRound(key, record) {
      const dedupKey = record?.dedupKey ?? record?.roundKey;
      if (typeof dedupKey !== 'string' || dedupKey === '') {
        throw new Error('transcript store: record.dedupKey is required');
      }
      const inserted = await client.query(
        `INSERT INTO transcript_rounds
           (run_id, transcript_key, dedup_key, round, record, folded, messages, folded_payload)
         VALUES (NULL, $1, $2, $3, $4, false, $5, NULL)
         ON CONFLICT (transcript_key, dedup_key) WHERE transcript_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [key, dedupKey, record.round, JSON.stringify(record), JSON.stringify(record.messages ?? [])],
      );
      if ((inserted.rows?.length ?? 0) > 0) return { inserted: true };

      // (transcript_key, dedup_key) 已被占（同事务重放，或 postMessage 的 session FOR UPDATE 之外的
      // 并发重放）⇒ 读回既有 record 判「同一份 payload」还是「真冲突」（键的取法与上游 recordKey 同式）。
      const existing = await readStoredRecord(client, key, dedupKey);
      if (existing === null) {
        // ON CONFLICT 已跳过、却又读不到行：唯一可能是并发事务插完后立刻回滚（DO NOTHING 等它落地
        // 才判跳过）。**不静默成功**：按最保守方向报冲突，让调用方事务回滚重放。
        throw dedupPayloadConflict({
          runId: key,
          key: transcriptRecordKey(key, record),
          existing: undefined,
          incoming: record,
          existingFingerprint: 'sha256:000000000000000000000000',
          incomingFingerprint: payloadFingerprint(record),
        });
      }
      if (samePayload(existing, record)) return { inserted: false }; // 幂等命中（顶层 ts/round 漂了仍算重放）
      throw dedupPayloadConflict({
        runId: key,
        key: transcriptRecordKey(key, record),
        existing,
        incoming: record,
        existingFingerprint: payloadFingerprint(existing),
        incomingFingerprint: payloadFingerprint(record),
      });
    },
    /**
     * 快路径探针①（0.17.0 #157 / station #193，与 loadMaxRound 成对）：按 dedupKey 点查整条已存 record。
     * 未命中返回 null（不是抛错）；命中时**原样返回 record JSONB，不合成列字段**（0.16.0 起的保真要求：
     * 引擎命中面直接透传该 record，round/dedupKey 由引擎从 record 自取）。
     *
     * 谓词等价性：契约谓词是 `(record.dedupKey ?? record.roundKey) === dedupKey`，本实现用列等值
     * `dedup_key = $2`——station 的 `dedup_key` 列在 appendRound 写入时恒等于
     * `record.dedupKey ?? record.roundKey`（迁移 0006 部分唯一索引列），故对 station 数据两者等价。
     *
     * issue #337：**故意不折**——点查探针是对**原始行**的探针（与上游「两个点查探针不折叠」同口径）。
     */
    async loadByDedupKey(key, dedupKey) {
      // 读面与 appendRound 的冲突判定同源（同一条 SQL）；本探针**只读不判**：签名里只有 key、
      // 没有待写入的 payload，无从比对，而引擎 `appendUserTurn` 快路径命中即 written:false
      // （随包契约第 15/16 条要求原样返回库内 record）⇒ 真冲突全部由 appendRound 那条面兜
      // （同事务内 FOR UPDATE 串行化 + ON CONFLICT ⇒ 没有「同 key 异 payload 被静默接受」的窗口）。
      return readStoredRecord(client, key, dedupKey);
    },
    /**
     * 快路径探针②（0.17.0 #157 / station #193，与 loadByDedupKey 成对）：该 key 的最大 round，
     * 等价于全量 load 结果的 `Math.max(0, 安全整数 round…)`。空 store 返回 null（引擎派生 0，
     * 与全量路径语义一致）。round 列是 int、pg 返回 number，Number() 只是对驱动行为的兜底。
     * issue #337：**故意不折**——同 loadByDedupKey，成对探针只认原始行。
     */
    async loadMaxRound(key) {
      const res = await client.query(
        `SELECT MAX(round) AS max_round
           FROM transcript_rounds
          WHERE transcript_key = $1`,
        [key],
      );
      const max = res.rows?.[0]?.max_round ?? null;
      return max == null ? null : Number(max);
    },
  };
}

/**
 * POST 消息事务内的用户输入预写入（引擎 API 的唯一调用点）。
 * @returns {Promise<{key:string, dedupKey:string, round:number, written:boolean, record?:object}>}
 */
export function appendUserInputTurn(client, { key, text, messageId }) {
  return appendUserTurn(createSessionTranscriptStore(client), { key, text, messageId });
}
