// issue #502（D-4）：**stream 档正文的进程内缓冲**。
//
// 为什么存在：`assistant_delta` / `reasoning_delta` / `tool_call_delta` 这三类**逐字碎片**此前每条
// 都进 `run_events` 并各占一个 seq（dev 实测 884,163 行里 877,155 行是这三类，占 472 MB 的 99.2 %），
// 而它们是引擎 `EVENT_TIERS` 里的 `stream` 档——「成型的那一份在别处」。issue #502 把它们**停止落库**
// 之后，「断线重连后那段未完稿的正文」就只剩两个来源：这个进程内缓冲，与终态时落的**那一行**
// `type='partial_output'`（见 `internal.js#insertPartialOutputRow`）。本模块只负责前者。
//
// 三个口径必须钉住（都在 `portal/test/run-partial-buffer.test.js` 里有具名用例）：
//   ① **档位判据来自引擎**：哪些事件算碎片，只问 `erix-agent` 的 `eventTierOf`/`EVENT_TIER_STREAM`，
//      本模块**不手抄**那三个字符串（手抄 = 引擎新增碎片类型时本站静默漏，与 `internal.js` 写入侧同源）。
//   ② **快照语义 = 「当前这段未完稿正文」，不按轮切段**：前端只有**一个**流式气泡
//      （`useEventStream.ts` 的 `deltaText`，`round_start` 置 null ⇒ 一轮结束就清屏），
//      所以缓冲里跨轮累加的那个字符串恰好就是界面上那一段。按轮切段反而与界面不符。
//   ③ `uptoSeq` = 该 run **已落库**事件的最大 seq：补发侧拿它判「客户端的水位线有没有盖住这段正文」
//      （`X >= uptoSeq` ⇒ 客户端已经看到更多，不再发；`X < uptoSeq` ⇒ 它缺一块，必须发）。
//      因此每条 durable 事件落库成功后都要 `observe` 一次更新它，而 stream 档事件**不参与** `uptoSeq`。
//
// 内存上界：单 run 正文夹到 `textCap`（默认 2000 字符，与 `http.js` 的 `PARTIAL_OUTPUT_TEXT_CAP`
// 同口径 ⇒ 内存快照与库里那一行的长度口径一致，补发时不会出现「刷新前后长度不同」），
// run 数夹到 `maxEntries`（默认 256，LRU 逐出）。构造参数可注入，便于测试与部署调参。
import { EVENT_TIER_STREAM, eventTierOf } from 'erix-agent';

/** 与 `http.js` 的 `PARTIAL_OUTPUT_TEXT_CAP` 同口径（两处必须等值，否则补发与刷新看到的长度不同）。 */
export const PARTIAL_TEXT_CAP_DEFAULT = 2000;
/** LRU 上界：同时缓冲多少个 run。 */
export const PARTIAL_MAX_ENTRIES_DEFAULT = 256;

/**
 * 事件是不是「逐字碎片」——**只问引擎的分级表**。
 * 单独成一个导出：`internal.js` 写入侧与补发侧都要用同一个判据，第二份实现就是第二把尺。
 */
export function isStreamTierType(type) {
  return eventTierOf(type) === EVENT_TIER_STREAM;
}

/**
 * @param {{maxEntries?: number, textCap?: number}} [options]
 * @returns {{
 *   observe: (runId: string, ev: {type?: string, payload?: unknown, seq?: number|null, session_id?: string|null}) => boolean,
 *   snapshot: (runId: string) => ({text: string, reasoning: string, uptoSeq: number|null, chunks: number, truncated: boolean, sessionId: string|null} | null),
 *   drop: (runId: string) => boolean,
 *   clear: () => number,
 *   sessionRuns: (sessionId: string) => string[],
 *   size: () => number,
 * }}
 */
export function createPartialBuffer({
  maxEntries = PARTIAL_MAX_ENTRIES_DEFAULT,
  textCap = PARTIAL_TEXT_CAP_DEFAULT,
} = {}) {
  /** @type {Map<string, object>} 插入序 = LRU 序（`Map` 的迭代顺序就是插入顺序，重新 set 即刷新） */
  const entries = new Map();

  /** 把碎片累加进已有缓冲；已夹到上限就只置 `truncated`（内存有界，不追长尾）。 */
  function append(entry, field, chunk) {
    if (typeof chunk !== 'string' || chunk === '') return;
    entry.chunks += 1; // 可观测性：**收到过**一片就算一条（上限之后仍到帐的碎片也要能数出来）
    const room = textCap - entry[field].length;
    if (room <= 0) {
      entry.truncatedByCap = true; // 上限之后还有内容 ⇒ 这段确实丢了尾巴
      return;
    }
    if (chunk.length > room) entry.truncatedByCap = true;
    entry[field] += chunk.slice(0, room);
  }

  /**
   * at-least-once 重投去重（判据与它的适用范围见 `observe` 头注释）。
   * `client_event_id` 的形状 = `run_id:attempt:计数`（`internal.js#isValidClientEventId` 校验的就是它）。
   */
  function isRedelivery(entry, runId, ev) {
    const id = ev.client_event_id;
    if (typeof id !== 'string' || id === '') return false;
    // `runId` 里只有 hex 与 `-`，但正则转义仍照做：不拿「今天恰好安全」当理由。
    // ⚠ 拼接用普通字符串而**不是模板字面量**：模板里的 `\d` 会被当成未知转义而**退化成 `d`**，
    //   正则就永不同名 ⇒ 去重静默失效（实测拼出 `^r1:d+:d+$`）。
    const re = new RegExp('^' + runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+):(\\d+)$');
    const m = re.exec(id);
    if (!m) return false; // 不是 worker 的编号形状 ⇒ 不拿它当判据（宁重不漏）
    const attempt = m[1];
    const counter = Number(m[2]);
    const prev = entry.counters.get(attempt);
    if (prev === undefined || counter > prev) entry.counters.set(attempt, counter);
    return prev !== undefined && counter <= prev;
  }

  /**
   * 喂一条**已处理**的 U3 事件（写入侧每事件一次，见 `internal.js#postEvents`）。
   *
   * - stream 档：按载荷累加正文 / 推理（`tool_call_delta` 的载荷是**工具入参**，成型副本在
   *   `tool_use.input`，界面上也不进正文气泡 ⇒ 有意不累加，只算一条观测计数）。
   * - 其余（durable 档）：带 `seq` 就推进 `uptoSeq`（**只增不减**）。
   *
   * at-least-once：U3 整批重发是常态（`runner/agentd.js:700-740` 可重试时放回队首）。durable 行的
   * 去重由库里的 `UNIQUE (run_id, client_event_id)` 提供，而 stream 档**不落库** ⇒ 没有库面可依赖，
   * 重投一批碎片就会把正文拼两遍（而这段正文现在是终态那一行 `partial_output` 的唯一来源）。
   * 去重判据 = 同一 attempt 内 `client_event_id` 计数的高水位（`runner/worker.js:193` 的编号是
   * `run_id:attempt:计数` 且 worker 逐事件递增，agentd 的发送队列是 FIFO 且重投总是重放前缀）。
   * 不是那个形状（合成 / 手工事件的 `client_event_id`）⇒ **不当判据**，宁重不漏。
   *
   * @returns {boolean} 这条事件是否进了缓冲
   */
  function observe(runId, ev) {
    if (typeof runId !== 'string' || runId === '' || !ev || typeof ev !== 'object') return false;
    const type = ev.type;
    const stream = isStreamTierType(type);
    const seq = Number(ev.seq);
    if (!stream && !Number.isFinite(seq)) return false; // 既不是碎片、也没有可推进的水位线 ⇒ 不进缓冲
    let entry = entries.get(runId);
    if (entry) entries.delete(runId); // 重新插入 = 刷新 LRU 位置
    else {
      entry = {
        sessionId: ev.session_id ?? null,
        text: '', reasoning: '', uptoSeq: null, chunks: 0, truncatedByCap: false,
        counters: new Map(), // attempt → 已观测的最大 `client_event_id` 计数（at-least-once 去重）
      };
      // 超上界先逐出**最久未观测**的那个 run（有界内存是这条通道的存在前提，不是优化项）
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    }
    if (entry.sessionId == null && typeof ev.session_id === 'string') entry.sessionId = ev.session_id;
    const seen = isRedelivery(entry, runId, ev);
    if (!seen) {
      if (stream) {
        const payload = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
        // `assistant_delta` 与 `reasoning_delta` 的载荷键都由 runner 固定为 `text`
        //（`runner/worker.js:1054/1057`），不是猜的：**拿值比类型**，脏值一律当「没给正文」。
        append(entry, 'text', type === 'assistant_delta' ? payload.text : undefined);
        append(entry, 'reasoning', type === 'reasoning_delta' ? payload.text : undefined);
      } else if (Number.isFinite(seq) && (entry.uptoSeq == null || seq > entry.uptoSeq)) {
        entry.uptoSeq = seq;
      }
    }
    entries.set(runId, entry);
    return !seen;
  }

  /** 快照（无该 run ⇒ null）。返回**副本**：调用方改写不影响缓冲。 */
  function snapshot(runId) {
    const e = entries.get(runId);
    if (!e) return null;
    return {
      text: e.text,
      reasoning: e.reasoning,
      uptoSeq: e.uptoSeq,
      chunks: e.chunks,
      truncated: e.truncatedByCap,
      sessionId: e.sessionId,
    };
  }

  /** 主动丢弃（run 已终态且那一行已落盘 / 测试用）。返回是否真删了东西。 */
  function drop(runId) {
    return entries.delete(runId);
  }

  /** 全清（测试用它模拟「portal 重启 ⇒ 内存空」）。返回清掉的条数。 */
  function clear() {
    const n = entries.size;
    entries.clear();
    return n;
  }

  /** 该会话当前在缓冲里的 run（补发侧的候选集；顺序 = 观测序）。 */
  function sessionRuns(sessionId) {
    const out = [];
    for (const [runId, e] of entries) if (e.sessionId === sessionId) out.push(runId);
    return out;
  }

  return { observe, snapshot, drop, clear, sessionRuns, size: () => entries.size };
}

/**
 * 进程内单例：`internal.js` 写侧喂它，`http.js` 补发侧读它。
 * 单例是**刻意的**（同一进程内一份真相），测试用 `clear()` 复位、用 `createPartialBuffer()` 起独立实例。
 */
export const partialOutputs = createPartialBuffer();
