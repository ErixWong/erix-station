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
// issue #261123-20：体积保险丝的上限。来路是叶子模块 `./transcript-limits.js`，**不是 `internal.js`**
// ——`internal.js` 本来就 import 本文件，反向 import 会成环；两处校验（internal 传输层 400 与
// 本处写入口抛错）共用同一个常量、同一把尺。
import { MAX_ROUND_BYTES } from './transcript-limits.js';

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
      // issue #261123-20 体积保险丝（**先判后写**：超限抛错，下面的 INSERT 一次都不许执行）。
      // 本函数是唯一写入口：宿主预写（sessions.js postMessage → appendUserInputTurn，此前无闸）
      // 与 agent 回传（internal.js putRound，那里是传输层更早的一次 400 拦截）都从这里过。
      const fuseBytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
      if (fuseBytes > MAX_ROUND_BYTES) throw Object.assign(new Error(`transcript store: record is ${fuseBytes} bytes, exceeds ${MAX_ROUND_BYTES} byte limit`), { code: 'transcript_record_too_large' });
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
    // ── issue #500：账本恢复行三件套（erix-agent 0.33.0 的**可选**能力面，本站全实现）──
    //
    // 名字是引擎契约钉死的三个（`store.appendRecoveryRow` / `store.listRecoveryRows` /
    // `store.clearRecoveryRows`，`orchestrator.js` 按名字探测）。三个都**可选**，但「在而做错」比
    // 「缺席」更坑：读方法在而 reject ⇒ `recovery_rows_unreadable` 终局；写方法在而什么都不存
    // ⇒ 引擎以为「执行过了」这条证据已落账，实际没落 ⇒ 比彻底不做更容易把副作用重放一遍。
    // ⇒ **整组做，或者整组不做**（本站全做，SQL 面见 `createRecoveryRowStore`）。
    //
    // 为什么这个适配器（`load`/`appendRound` 这一族）也要带恢复行三件套：它的键**两种作用域都有**——
    // session 键（`appendUserInputTurn` 的真实路径）与真 runId（随包契约套件与旧 portal 回退面）都从
    // 这里进来。恢复行只有 session 语义，但本站的**适配器能力面**必须成套，否则契约套件的
    // 「实现了就必须真断言」守卫会在半个能力上静默跳过（issue #739 那条口径的本站版）。
    // 与轮记录同一个 client（红线：判冲突与判幂等的那笔 SELECT 必须落在同一事务里）。
    ...createRecoveryRowStore(client),
  };
}

/**
 * `kind: "recovery"` 的行类型判别键（引擎 `RECOVERY_ROW_KIND`）。这里写**字面量**不是偷懒：
 * `erix-agent` 的 `package.json#exports`（现查 0.33.0）只开 `.` / `./tools` / `./contract-tests`，
 * `src/store/recovery-rows.js` 在面之外 ⇒ 运行期深路径 import 直接 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
 * 本站对它的全部依赖只剩「这两个字符串」+「写侧不收畸形行」这一条闸，判据的**真相**由
 * `portal/test/transcript-recovery-rows.test.js` 按文件路径深路径 import 上游模块做**行为对拍**钉住
 * （与 `transcript-payload.js` ↔ 上游 `transcript-dedup.js` 完全同一手法，先例见
 * `portal/test/transcript-payload.test.js`）：上游改了形状/判别键，那条对拍当场红。
 */
const RECOVERY_ROW_KIND = 'recovery';
/** 写侧只拦这一种事件：它是「工具真的执行过了」的唯一证据（引擎 `RECOVERY_EVENT_TOOL_EXECUTED`）。 */
const RECOVERY_EVENT_TOOL_EXECUTED = 'tool-executed';

/**
 * 恢复行 `dedup_key` 的列宽上限：与迁移 `0036-transcript-recovery-rows.sql` 里
 * `CHECK (length(dedup_key) <= 255)` **同一个数**（两处不一致 = 报错由 PG 抛 23514，
 * 到了排障的人手里就只剩「23514」，没有「谁的哪一行」可说）。
 * 与轮记录端点那条「`dedupKey` ≤256」故意差一个：那张表的 `dedup_key` 列上没有 CHECK。
 */
const RECOVERY_DEDUP_KEY_MAX_LEN = 255;

/**
 * `tool-executed` 恢复行的形状判据 —— **上游同件的本仓副本**（`toolExecutedRecoveryRowShapeProblem`）：
 * 返回**第一个不合的字段名**，全合返 `null`。三条判据照上游逐字（`toolUseId` 非空串 / `round` 安全整数 /
 * `dedupKey` 非空串），**一格不加**——上游那句注释说得清楚：写侧根本不可能产出 `round: NaN` 或没有
 * `dedupKey` 的行，那种行是宿主手写/半截修复/被截断的，把它的 `toolUseId` 并进「执行过了」集合
 * 等于拿一行的**身份**去坐实它自己都说不出的一次执行。
 *
 * 位置说明（别读成「本站把守卫搬走了」）：契约把这条守卫放在**读侧**（引擎 `readExecutedToolIdRecoveryRows`
 * 抛 `TypeError` ⇒ 包成 `recovery_rows_unreadable`）。本站**照旧不在读侧动手**（`listRecoveryRows`
 * 原样回行，见下面那份实现）；在**写侧**多拦一道是**严格超集**：能存进来的行必然过读侧守卫，
 * 于是「写成功、下一次续跑才炸」这个更差的排障时序被换成了当场 400。
 */
function toolExecutedRecoveryRowShapeProblem(row) {
  if (typeof row?.toolUseId !== 'string' || row.toolUseId === '') return 'toolUseId';
  if (!Number.isSafeInteger(row?.round)) return 'round';
  if (typeof row?.dedupKey !== 'string' || row.dedupKey === '') return 'dedupKey';
  return null;
}

/**
 * 恢复行的**写侧形状闸**（红线：本站不是「收下行就写」的假实现，但也不越权重写）。
 * 只校「这条行能不能进这张表」：判别键 + 主键列 + 轮号 + `tool-executed` 的形状。
 *
 * `tool-result-unledgered` / `partial-text` **故意不在写侧校**：上游对它们的守卫
 * （`readUnledgeredToolResultRecoveryRows` 那一串 `notYetLedgered` / `toolResult.tool_use_id` 对齐…、
 * `readPartialTextRecoveryRow` 的 `text` 非空）长在**读侧**并抛 `TypeError`，本站再校一遍就是
 * 第二把尺（漂移风险 > 收益），交给引擎读侧去抛 —— 那才是契约指定的位置。
 *
 * @param {any} row
 * @returns {string|null} 人可读的违规描述；合规则 `null`
 */
function recoveryRowWriteProblem(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row) || row.kind !== RECOVERY_ROW_KIND) {
    // `kind` 是唯一判别键（引擎 `isRecoveryRow` 只认它）；不认识的行本站**不收**，不污染这张表。
    return `record.kind must be "${RECOVERY_ROW_KIND}"`;
  }
  const dedupKey = row.dedupKey;
  if (typeof dedupKey !== 'string' || dedupKey === '') {
    return 'record.dedupKey is required (engine recoveryEventKey, host must not recompute it)';
  }
  if (dedupKey.length > RECOVERY_DEDUP_KEY_MAX_LEN) {
    return `record.dedupKey exceeds ${RECOVERY_DEDUP_KEY_MAX_LEN} characters (transcript_recovery_rows CHECK)`;
  }
  if (!Number.isSafeInteger(row.round) || row.round < 0) {
    // 列上也有 CHECK (round >= 0)，这里先拦：报错要说得出是哪个字段，且 `round: NaN` 进 jsonb 会变成 null。
    return `record.round must be a non-negative safe integer (received ${String(row.round)})`;
  }
  if (row.recoveryEvent === RECOVERY_EVENT_TOOL_EXECUTED) {
    const problem = toolExecutedRecoveryRowShapeProblem(row);
    if (problem !== null) {
      return `tool-executed recovery row is malformed on field "${problem}"`
        + ' (engine toolExecutedRecoveryRowShapeProblem): refusing to persist execution evidence'
        + ' that the engine would refuse to read back';
    }
  }
  return null;
}

/**
 * 恢复行三件套的 SQL 面（迁移 0036 的新表；与轮记录表 `transcript_rounds` **无外键关系**）。
 * 导出理由：`internal.js` 的三个 internal 端点要的是同一套 SQL —— 两处各写一份就会出现
 * 「store 适配器幂等、端点不幂等」这种只在一侧可观测的行为（与 `transcript-payload.js`
 * 「判据只此一份」同一条纪律）。测试也直接打这一层（`portal/test/transcript-recovery-rows.test.js`）。
 *
 * 参数位一律用 `engineKey` 而不是 `key`：这一层是**双作用域**的——`load` / `appendRound` 那两法的
 * `key` 既可能是 sessionId（session 作用域）也可能是真 runId（run 作用域，agentd 的旧 portal 回退面），
 * 而恢复行只有 session 语义。写清楚名字，省得后来人以为这里该做 run 作用域兼容。
 */
export function createRecoveryRowStore(client) {
  return {
    /**
     * `appendRecoveryRow`：追加一条恢复行。返回 `true` = 真写进去一行；`false` = 同 `dedupKey` + 同 payload ⇒ 幂等跳过。
     * 同 key + **异 payload** ⇒ 抛 `code === 'dedup_payload_conflict'`（**既不覆盖也不静默丢弃**）。
     *
     * 判据与轮记录**同一把尺**：`./transcript-payload.js` 的 payload 指纹（顶层只剔
     * `dedupKey`/`roundKey`/`round`/`ts`）。为什么恢复行尤其需要「剔顶层」这一半：崩溃重跑同一个
     * 工具调用时，引擎重新算出的行只有 `ts`（和极端情况下的 `round`）会漂，payload 一个字节都没变，
     * 拿整条记录去哈希就会把重放判成冲突 ⇒ 写侧抛错 → 引擎 `persistence_failed`，证据反而丢了。
     *
     * ⚠ `ON CONFLICT DO NOTHING` 之后必须读回既有行：`DO NOTHING` 本身分不清「幂等」与「真冲突」，
     * 而这两种在契约里是两个结局（幂等 = `false` 继续跑；冲突 = 抛错让引擎按持久化失败收场）。
     * 并发同 key 已被 `PRIMARY KEY (transcript_key, dedup_key)` 序列化 ⇒ 本事务之外最多一条落地。
     */
    async appendRecoveryRow(engineKey, row) {
      const problem = recoveryRowWriteProblem(row);
      if (problem !== null) throw new Error(`transcript recovery row rejected: ${problem}`);
      const inserted = await client.query(
        `INSERT INTO transcript_recovery_rows (transcript_key, dedup_key, round, record)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (transcript_key, dedup_key) DO NOTHING
         RETURNING dedup_key`,
        [engineKey, row.dedupKey, row.round, JSON.stringify(row)],
      );
      if ((inserted.rows?.length ?? 0) > 0) return true;

      const existing = (await client.query(
        `SELECT record FROM transcript_recovery_rows
          WHERE transcript_key = $1 AND dedup_key = $2`,
        [engineKey, row.dedupKey],
      )).rows?.[0]?.record ?? null;
      if (existing === null) {
        // ON CONFLICT 已跳过、却又读不到行：唯一可能是并发事务插完后立刻回滚（DO NOTHING 会等它
        // 落地才判跳过）。**不静默成功**：按最保守方向报冲突（同 `appendRound` 那一格）。
        throw dedupPayloadConflict({
          runId: engineKey,
          key: transcriptRecordKey(engineKey, row),
          existing: undefined,
          incoming: row,
          existingFingerprint: 'sha256:000000000000000000000000',
          incomingFingerprint: payloadFingerprint(row),
        });
      }
      // 幂等命中：顶层 `ts`（重放必然带来新时刻）漂了仍算重放 ⇒ `false`，不新增行、不动既有行。
      if (samePayload(existing, row)) return false;
      throw dedupPayloadConflict({
        runId: engineKey,
        key: transcriptRecordKey(engineKey, row),
        existing,
        incoming: row,
        existingFingerprint: payloadFingerprint(existing),
        incomingFingerprint: payloadFingerprint(row),
      });
    },
    /**
     * `listRecoveryRows`：读该 key 的全部恢复行，按**持久化追加序** `append_seq` 升序（**不是**时间）。
     * 契约：返回数组，空数组 = 「这条 run 没有恢复行」（唯一可以静默兜底的回答）。
     * 本站**不吞错误**：client 抛错就让它抛出去——引擎把「方法在而 reject」判成
     * `recovery_rows_unreadable`（吞掉 = 把唯一的执行证据当没有，正是本切片存在的理由）。
     *
     * 返回的是 `record` 本体（列 `round` **不合成进去**，与 `loadByDedupKey` 的保真要求同口径）：
     * 引擎读侧的形状守卫读的就是 record 里那些字段，套一层列值会把手写行的畸形「修好」再放行，
     * 于是守卫永远不响。
     *
     * ⚠ 没有 `partial-text` 的「每轮只有一个槽位」这回事：引擎文件存储靠**整文件重写**保证槽位语义，
     * 本站是 append-only ⇒ 同轮多条 `partial-text` 会都在（读侧 `readPartialTextRecoveryRow` 取
     * **最后落盘**那条，与文件存储语义一致）。今天本站没开 `partialPersistence`（#301）⇒ 该事件不产生。
     */
    async listRecoveryRows(engineKey) {
      const res = await client.query(
        `SELECT record
           FROM transcript_recovery_rows
          WHERE transcript_key = $1
          ORDER BY append_seq`,
        [engineKey],
      );
      return (res.rows ?? []).map((r) => r.record);
    },
    /**
     * `clearRecoveryRows`：清光该 key 的恢复行（引擎在 **fresh start**、第一轮写之前调）。返回 `true` = 至少删掉一行，
     * `false` = 本来就没有（两者都是成功；**抛错才是**契约里那个终局 `recovery_rows_clear` 失败）。
     *
     * 为什么这条 DELETE 不破坏「折叠重建可证无损」：它**只打新表**。`transcript_rounds` 上
     * 「全站 `DELETE FROM transcript_rounds` 零命中」是 `sessions.js` 那条论证的前提，本方法一个字节
     * 都不碰那张表（`portal/test/transcript-recovery-rows.test.js` 里有用例钉住）。
     *
     * 顺序红线（引擎 `dedup_payload_conflict` 之外唯一一条）：清盘**不许**被折叠进「本轮末尾」——
     * `tool-executed` 只在执行器返回那一刻写一次，中途没有任何再确认，清早了 = 那一轮的执行证据永久丢失。
     * 时序由调用方保证（引擎在 `resume !== true` 的分支里第一件事就是它，`orchestrator.js:2191-2199`）。
     */
    async clearRecoveryRows(engineKey) {
      const res = await client.query(
        `DELETE FROM transcript_recovery_rows
          WHERE transcript_key = $1
          RETURNING 1`,
        [engineKey],
      );
      return (res.rowCount ?? 0) > 0;
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
