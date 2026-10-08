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

/**
 * 事务绑定的 session transcript store（引擎 load/appendRound 两方法契约
 * + 0.17.0 成对可选快路径探针 loadByDedupKey/loadMaxRound）。
 * @param {import('pg').PoolClient} client 调用方事务内的 PoolClient（禁止换成 pool 自身，否则脱离事务）
 */
export function createSessionTranscriptStore(client) {
  return {
    /** 读该 key 的全部轮记录（round/dedup_key 以权威列合成进 record，供引擎推导与幂等判据）。 */
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
      return (res.rows ?? []).map((row) => {
        const base = row.record && typeof row.record === 'object' ? row.record : {};
        return {
          ...base,
          round: Number(row.round),
          // appendUserTurn 幂等判据读 dedupKey ?? roundKey；列缺失时回退 record 内字段。
          dedupKey: row.dedup_key ?? base.dedupKey ?? base.roundKey ?? null,
        };
      });
    },
    /** 追加一轮：会话预写行恒为 run_id=NULL / folded=false / folded_payload=NULL（同 PR②a 形态）。 */
    async appendRound(key, record) {
      const dedupKey = record?.dedupKey ?? record?.roundKey;
      if (typeof dedupKey !== 'string' || dedupKey === '') {
        throw new Error('transcript store: record.dedupKey is required');
      }
      await client.query(
        `INSERT INTO transcript_rounds
           (run_id, transcript_key, dedup_key, round, record, folded, messages, folded_payload)
         VALUES (NULL, $1, $2, $3, $4, false, $5, NULL)
         ON CONFLICT (transcript_key, dedup_key) WHERE transcript_key IS NOT NULL DO NOTHING`,
        [key, dedupKey, record.round, JSON.stringify(record), JSON.stringify(record.messages ?? [])],
      );
    },
    /**
     * 快路径探针①（0.17.0 #157 / station #193，与 loadMaxRound 成对）：按 dedupKey 点查整条已存 record。
     * 未命中返回 null（不是抛错）；命中时**原样返回 record JSONB，不合成列字段**（0.16.0 起的保真要求：
     * 引擎命中面直接透传该 record，round/dedupKey 由引擎从 record 自取）。
     *
     * 谓词等价性：契约谓词是 `(record.dedupKey ?? record.roundKey) === dedupKey`，本实现用列等值
     * `dedup_key = $2`——station 的 `dedup_key` 列在 appendRound 写入时恒等于
     * `record.dedupKey ?? record.roundKey`（迁移 0006 部分唯一索引列），故对 station 数据两者等价。
     */
    async loadByDedupKey(key, dedupKey) {
      const res = await client.query(
        `SELECT record
           FROM transcript_rounds
          WHERE transcript_key = $1 AND dedup_key = $2
          LIMIT 1`,
        [key, dedupKey],
      );
      return res.rows?.[0]?.record ?? null;
    },
    /**
     * 快路径探针②（0.17.0 #157 / station #193，与 loadByDedupKey 成对）：该 key 的最大 round，
     * 等价于全量 load 结果的 `Math.max(0, 安全整数 round…)`。空 store 返回 null（引擎派生 0，
     * 与全量路径语义一致）。round 列是 int、pg 返回 number，Number() 只是对驱动行为的兜底。
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
