// issue #502（D-4 / 形态 M）：**stream 档正文的进程内缓冲**（按轮槽位，不是按 run 累加）。
//
// 为什么存在：`assistant_delta` / `reasoning_delta` / `tool_call_delta` 这三类**逐字碎片**此前每条
// 都进 `run_events` 并各占一个 seq（dev 实测 884,163 行里 877,155 行是这三类，占 472 MB 的 99.2%），
// 而它们是引擎 `EVENT_TIERS` 里的 `stream` 档——「成型的那一份在别处」。issue #502 把它们**停止落库**
// 之后，「断线重连时那段还没写完的正文」只剩一个来源：**这个进程内缓冲**（终态那半截走 `run_end`
// 的 `partial_text`，已完成轮次走 `round_end.final_text`——见 `internal.js` 与 `docs/api/portal.md` §4.4a）。
//
// 四条口径必须钉住（都在 `portal/test/run-partial-buffer.test.js` 里有具名用例）：
//   ① **档位判据来自引擎**：哪些事件算碎片，只问 `erix-agent` 的 `eventTierOf`/`EVENT_TIER_STREAM`，
//      本模块**不手抄**那三个字符串（手抄 = 引擎新增碎片类型时本站静默漏，与 `internal.js` 写入侧同源）。
//   ② **正文按轮重置**（形态 M，不是「按 run 累加」）：`round_start` 一到就把正文槽清空。
//      前端的流式气泡本来也是 `round_start` 置 null（`useEventStream.ts`），两边同一口径；
//      跨轮累加会拼出界面上从来没出现过的一段话（审计 B-1）。
//      `reasoning` **独立累加**：推理增量不在轮边界清空，也不与正文混写（前端本来就不展示它，
//      见 `useEventStream.ts` 的 `case 'reasoning_delta'` ⇒ 它只是给补发帧留的观测面）。
//   ③ **快照带 `roundSeq`**（当前轮 `round_start` 事件自己的 `seq`，没带 ⇒ `null`）：补发帧靠它自证
//      「我是哪一轮的」，前端拿自己观测到的 `round_start.seq` 对得上才覆盖气泡（判据 4）。
//      ⚠ **没有 `uptoSeq` 这种东西**（形态 M 删掉的旧设计）：碎片不落库就没有 seq 坐标系，
//      拿「已落库事件的最大 seq」当水位线去和客户端的 `Last-Event-ID` 比是**两套坐标硬比**
//      （审计 B-2/B-3：比赢会漏发、比输会重发，两种错都长得像「正文重复 / 空洞」）。
//   ④ **变更只在 COMMIT 之后生效**：写入侧走 `stage()`（事务内暂存副本），`COMMIT` 成功才 `commit()`
//      并进真相（审计 B-4：事务里直接改缓冲 ⇒ 回滚后「内存有、库里无」，补发与终态写都拿假象当真值）。
//
// 内存上界（**构造参数可注入**，两个数字都要算给学生看）：
//   单 entry 正文上界 = `textCap` × 2 路（`text` 与 `reasoning` **各自**夹到 `textCap`）
//                    = 16384 × 2 = 32768 字符 ≈ 64 KB（V8 字符串按 UTF-16，最坏 2 B/字符）；
//   counters 上界 = `maxCounters` 个 attempt 计数（默认 8，几十字节量级，见 `isRedelivery`）；
//   全表上界 = `maxEntries` × 64 KB = 32 × 64 KB ≈ **2 MB**。
//   ⚠ 为什么不是 256 条：256 × 64 KB ≈ 16 MB，而单进程同时能跑的 run 是个位数（认领 SQL 串行 +
//   会话租约）⇒ 32 已是十倍余量，多出来的一律是常驻浪费。
//   ⚠ 为什么不是旧的 2000 字符：真库现查 `round_end.final_text` 最长 **31,707** 字符、均值 467，
//   2000 那道闸会把「停止前已经吐了 5000 字符」的正文截掉——#278 那条「刷新后不许比停止前少」
//   的红线就是被它咬住的（工单判据 3 专门钉 > 2000 这一格）。
import { EVENT_TIER_STREAM, eventTierOf } from 'erix-agent';

/** 单 run 单轮正文的字符上限（**两路各自**夹到这个值）。 */
export const PARTIAL_TEXT_CAP_DEFAULT = 16384;
/** LRU 上界：同时缓冲多少个 run。见文件头「内存上界」算术。 */
export const PARTIAL_MAX_ENTRIES_DEFAULT = 32;
/** 每 entry 的 `counters`（重投判重）条数上界——它按 attempt 增长，必须封顶。 */
export const PARTIAL_MAX_COUNTERS_DEFAULT = 8;

/**
 * 事件是不是「逐字碎片」——**只问引擎的分级表**。
 * 单独成一个导出：`internal.js` 写入侧与补发侧都要用同一个判据，第二份实现就是第二把尺。
 */
export function isStreamTierType(type) {
  return eventTierOf(type) === EVENT_TIER_STREAM;
}

/** 该事件是不是「轮起点」——正文槽位的重置信号（`round_start` 是事实档，自带 seq）。 */
function isRoundStart(type) {
  return type === 'round_start';
}

/**
 * @param {{maxEntries?: number, textCap?: number, maxCounters?: number, log?: {warn?: (m: string) => void}}} [options]
 * @returns {{
 *   observe: (runId: string, ev: object) => boolean,
 *   stage: () => {
 *     observe: (runId: string, ev: object) => boolean,
 *     markTerminal: (runId: string) => void,
 *     closeRound: (runId: string) => void,
 *     drop: (runId: string) => void,
 *     snapshot: (runId: string) => object | null,
 *     commit: () => void,
 *   },
 *   snapshot: (runId: string) => object | null,
 *   drop: (runId: string) => boolean,
 *   closeRound: (runId: string) => boolean,
 *   markTerminal: (runId: string) => boolean,
 *   clear: () => number,
 *   sessionRuns: (sessionId: string) => string[],
 *   size: () => number,
 *   stats: () => object,
 * }}
 */
export function createPartialBuffer({
  maxEntries = PARTIAL_MAX_ENTRIES_DEFAULT,
  textCap = PARTIAL_TEXT_CAP_DEFAULT,
  maxCounters = PARTIAL_MAX_COUNTERS_DEFAULT,
  log = console,
} = {}) {
  /** @type {Map<string, object>} 插入序 = LRU 序（`Map` 的迭代顺序就是插入顺序，重新 set 即刷新） */
  const entries = new Map();
  /** 逐出「仍在流的 run」的次数（`stats()` 暴露；「不许静默逐出」这条口径靠它可观测）。 */
  let evictedActive = 0;

  const blank = (sessionId) => ({
    sessionId: sessionId ?? null,
    round: null,        // 当前轮的 `round_start.payload.round`
    roundSeq: null,     // 当前轮的 `round_start` 事件自己的 seq（M-4 前端对账用它）
    text: '',
    reasoning: '',
    chunks: 0,
    truncatedByCap: false,
    // **只有正文**被夹到上限时才置它（审计第 3 条）。`truncatedByCap` 是两路**共用**的观测位
    //（reasoning 截尾也会置它），所以终态那半截正文到底「有没有被截」必须另开一位：
    // 复用 `truncatedByCap` 会把「推理截了、正文没截」谎报成「正文被截」。
    textTruncated: false,
    counters: new Map(), // attempt → 已观测的最大 `client_event_id` 计数（at-least-once 去重）
    terminal: false,
  });
  const clone = (e) => ({ ...e, counters: new Map(e.counters) });

  /** 把碎片累加进已有缓冲；已夹到上限就只置 `truncated`（内存有界，不追长尾）。 */
  function append(entry, field, chunk) {
    if (typeof chunk !== 'string' || chunk === '') return;
    // 可观测性：**收到过一片就算一条**（上限之后仍到帐的碎片也要能数出来）。
    // ⚠ 只数**正文**片：`chunks` 与 `text` 同一个槽、跟着 `round_start` 一起重置，把不按轮重置的
    //   `reasoning` 混进来，这个数字就没法拿去核对「这一段」的片数（它变成 run 级累计，语义两半）。
    if (field === 'text') entry.chunks += 1;
    const room = textCap - entry[field].length;
    if (room <= 0) {
      entry.truncatedByCap = true; // 上限之后还有内容 ⇒ 这段确实丢了尾巴
      if (field === 'text') entry.textTruncated = true;
      return;
    }
    if (chunk.length > room) entry.truncatedByCap = true;
    if (chunk.length > room && field === 'text') entry.textTruncated = true;
    entry[field] += chunk.slice(0, room);
  }

  /**
   * at-least-once 重投去重（适用范围见 `applyTo` 头注释）。
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
    if (prev === undefined || counter > prev) {
      entry.counters.set(attempt, counter);
      // **counters 必须封顶**（按 attempt 无界增长 = 长跑 run 的隐性泄漏）：丢最老的 attempt 计数。
      // 代价是「那个远古 attempt 的重投」退化成「重新累加」——只影响内存里那段气泡，
      // 终态正文另有 `run_end.partial_text` 兜底 ⇒ 宁可丢判据也不放大内存。
      while (entry.counters.size > maxCounters) {
        const oldest = entry.counters.keys().next();
        if (oldest.done) break;
        entry.counters.delete(oldest.value);
      }
    }
    return prev !== undefined && counter <= prev;
  }

  /**
   * 「这一轮的正文已经 durable 了」（审计第 2 条）：durable `round_end` **插入成功且 COMMIT 之后**
   * 调（`internal.js` 的写入侧走 `stage().closeRound`，与 `observe` 同一条 COMMIT-后生效口径）。
   *
   * 为什么必须清：本槽此后的用途只有一个 —— 终态时写 `run_end.partial_text`，而历史投影读的是
   * **`round_end.final_text` 拼 `run_end.partial_text`**（`http.js#projectPartialOutputItems`）。
   * 已完成那一轮的正文此刻**已经在** `round_end.final_text` 里，槽不清空就会在
   * 「`round_end` 之后、下一轮 `round_start` 之前」被 reaper / offboard / 取消终态化时**再写一遍**
   * ⇒ 界面上同一轮正文出现两遍（历史投影拼出来就是重复一轮）。
   *
   * 清的是**正文**（`text` / `chunks` / 两个截断位），**留着** `round` / `roundSeq` / `reasoning`：
   *   · 轮号与轮起点 seq 仍是「当前轮」的（下一轮 `round_start` 才会换），补发帧的对账凭据不能瞎；
   *   · `reasoning` 本来就不按轮清（口径②），也不落库，与本槽的 durable 判据无关。
   * 清空**不是**「关闭这个 run」：此后到的碎片继续累加（那是 `round_end` **之后**新说的一半，
   * 库里没有它，正是 `partial_text` 该装的东西），也不会再触发重复。
   */
  function closeRoundText(entry) {
    entry.text = '';
    entry.chunks = 0;
    entry.truncatedByCap = false;
    entry.textTruncated = false;
  }

  /**
   * 把一条事件的效果**应用到给定 entry**（`observe` 与 `stage().observe` 共用同一份语义——
   * 两份实现就会有两种行为，这是本模块唯一的重用点）。
   * @returns {boolean} 是否**首次观察**（重投 ⇒ false ⇒ 调用方不得再转 SSE，见 M-6①）
   */
  function applyTo(entry, runId, ev) {
    const seen = isRedelivery(entry, runId, ev);
    if (seen) return false;
    if (isRoundStart(ev.type)) {
      // **轮边界**：正文槽清空（形态 M 口径②），轮号与轮起点自己的 seq 一起换。
      entry.round = Number.isFinite(Number(ev.payload?.round)) ? Number(ev.payload.round) : entry.round;
      entry.roundSeq = Number.isFinite(Number(ev.seq)) ? Number(ev.seq) : null;
      entry.text = '';
      entry.chunks = 0;
      entry.truncatedByCap = false;
      entry.textTruncated = false;
    } else {
      const payload = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
      // `assistant_delta` 与 `reasoning_delta` 的载荷键都由 runner 固定为 `text`
      //（`runner/worker.js:1054/1057`），不是猜的：**拿值比类型**，脏值一律当「没给正文」。
      append(entry, 'text', ev.type === 'assistant_delta' ? payload.text : undefined);
      append(entry, 'reasoning', ev.type === 'reasoning_delta' ? payload.text : undefined);
    }
    if (entry.sessionId == null && typeof ev.session_id === 'string') entry.sessionId = ev.session_id;
    return true;
  }

  /** 该事件值不值得进缓冲（碎片 or 轮起点；其余事实档与本槽无关）。 */
  const matters = (type) => isStreamTierType(type) || isRoundStart(type);

  /** LRU 写入：删旧位再 set 才是「刷新位置」。 */
  function touch(runId, entry) {
    entries.delete(runId);
    entries.set(runId, entry);
  }

  /**
   * 逐出一条。**先逐已终态的 run**；全是活跃 run 时逐最老的那一条，但**必须出声**
   * （计数 + `log.warn`）——静默逐出活跃 run 会让它终态时写不出 `partial_text`，那就是静默丢正文。
   */
  function evictOne() {
    let victim = null;
    for (const [runId, e] of entries) {
      if (e.terminal === true) { victim = runId; break; }
    }
    if (victim === null) victim = entries.keys().next().value ?? null;
    if (victim === null) return;
    const wasActive = entries.get(victim)?.terminal !== true;
    entries.delete(victim);
    if (wasActive) {
      evictedActive += 1;
      try {
        const warn = log && typeof log.warn === 'function' ? log.warn.bind(log) : console.warn;
        warn(`[run-partial-buffer] LRU 上界 ${maxEntries} 已满 ⇒ 逐出仍在流的 run ${victim}`
          + `（累计 ${evictedActive} 次：该 run 的未完稿正文可能写不进 run_end.partial_text）`);
      } catch { /* 日志不承重 */ }
    }
  }

  const view = (entry) => ({
    text: entry.text,
    reasoning: entry.reasoning,
    round: entry.round,
    roundSeq: entry.roundSeq,
    chunks: entry.chunks,
    truncated: entry.truncatedByCap,
    // 审计第 3 条：**正文自己的**截断位（`truncated` 是两路共用的观测位，不能拿它写终态）。
    textTruncated: entry.textTruncated === true,
    sessionId: entry.sessionId,
    terminal: entry.terminal === true,
  });

  /**
   * 喂一条**已处理**的 U3 事件（立即生效版；写入侧走 `stage()`，见口径④）。
   * @returns {boolean} 这条事件是否**首次观察**进了缓冲（重投 ⇒ false）
   */
  function observe(runId, ev) {
    if (typeof runId !== 'string' || runId === '' || !ev || typeof ev !== 'object') return false;
    if (!matters(ev.type)) return false; // 既不是碎片也不是轮起点 ⇒ 与这个槽无关
    let entry = entries.get(runId);
    if (!entry) {
      while (entries.size >= maxEntries) evictOne();
      entry = blank(ev.session_id);
      entries.set(runId, entry);
    } else {
      touch(runId, entry);
    }
    return applyTo(entry, runId, ev);
  }

  /** 快照（无该 run ⇒ null）。返回**副本**：调用方改写不影响缓冲。 */
  function snapshot(runId) {
    const e = entries.get(runId);
    return e ? view(e) : null;
  }

  /**
   * 事务内暂存（`internal.js` 写入侧的唯一入口，口径④）。
   * 暂存期内所有读写都作用在**副本**上：`commit()` 之前，真相（`entries`）一个字都不动。
   */
  function stage() {
    const DROPPED = Symbol('dropped');
    /** @type {Map<string, object|symbol>} runId → entry 副本 | DROPPED */
    const staged = new Map();
    /** undefined = 本事务没碰过；null = 本事务里已 drop；object = 副本 */
    const readStaged = (runId) => (staged.has(runId) ? (staged.get(runId) === DROPPED ? null : staged.get(runId)) : undefined);

    return {
      observe(runId, ev) {
        if (typeof runId !== 'string' || runId === '' || !ev || typeof ev !== 'object') return false;
        if (!matters(ev.type)) return false;
        const known = readStaged(runId);
        if (known === null) return false; // 本事务已 drop 它 ⇒ 不再往里写（drop 是终态语义）
        let entry = known;
        if (entry === undefined) {
          const live = entries.get(runId);
          entry = live ? clone(live) : blank(ev.session_id);
        }
        staged.set(runId, entry);
        return applyTo(entry, runId, ev);
      },
      markTerminal(runId) {
        const known = readStaged(runId);
        if (known === null) return; // 已 drop：终态标记无意义
        const entry = known ?? (entries.has(runId) ? clone(entries.get(runId)) : null);
        if (entry === null) return;
        entry.terminal = true;
        staged.set(runId, entry);
      },
      /** 审计第 2 条：durable `round_end` 之后清正文槽（同样**在 COMMIT 之后**才并进真相）。 */
      closeRound(runId) {
        if (typeof runId !== 'string' || runId === '') return;
        const known = readStaged(runId);
        if (known === null) return; // 本事务已 drop 它 ⇒ 无槽可清
        const entry = known ?? (entries.has(runId) ? clone(entries.get(runId)) : null);
        if (entry === null) return;  // 本 run 根本没进过缓冲 ⇒ 不为此造槽（内存不白涨）
        closeRoundText(entry);
        staged.set(runId, entry);
      },
      drop(runId) {
        if (!entries.has(runId) && !staged.has(runId)) return;
        staged.set(runId, DROPPED);
      },
      snapshot(runId) {
        const s = readStaged(runId);
        if (s === null) return null;       // 本事务里 drop 过 ⇒ 视图里就是没有
        if (s !== undefined) return view(s);
        const e = entries.get(runId);
        return e ? view(e) : null;
      },
      /** COMMIT 成功后调用：把暂存的变更并进真相。 */
      commit() {
        for (const [runId, entry] of staged) {
          if (entry === DROPPED) { entries.delete(runId); continue; }
          while (entries.size >= maxEntries && !entries.has(runId)) evictOne();
          touch(runId, entry);
        }
        staged.clear();
      },
    };
  }

  /** 主动丢弃（测试 / 「这段已经不再需要」）。返回是否真删了东西。 */
  function drop(runId) {
    return entries.delete(runId);
  }

  /**
   * 立即版的「轮正文已 durable」（与 `stage().closeRound` 同一语义，只是不等 COMMIT）。
   * 写入侧走的是 `stage()`；这条给测试与「已经确定在事务外」的调用方用。
   */
  function closeRound(runId) {
    const e = entries.get(runId);
    if (!e) return false;
    closeRoundText(e);
    touch(runId, e);
    return true;
  }

  /** 标终态：LRU 优先逐它（`internal.js` 的终态点在 **COMMIT 之后**调）。 */
  function markTerminal(runId) {
    const e = entries.get(runId);
    if (!e) return false;
    e.terminal = true;
    touch(runId, e);
    return true;
  }

  /** 全清（测试用它模拟「portal 重启 ⇒ 内存空」）。返回清掉的条数。 */
  function clear() {
    const n = entries.size;
    entries.clear();
    return n;
  }

  /**
   * 该会话当前**还在写**的 run（补发侧的候选集；顺序 = 观测序）。
   * 已标终态的 run **不算**：它的正文已经进了 `run_end`/`round_end`，再发一份快照就是重复正文。
   */
  function sessionRuns(sessionId) {
    const out = [];
    for (const [runId, e] of entries) if (e.sessionId === sessionId && e.terminal !== true) out.push(runId);
    return out;
  }

  return {
    observe,
    stage,
    snapshot,
    drop,
    closeRound,
    markTerminal,
    clear,
    sessionRuns,
    size: () => entries.size,
    stats: () => ({ size: entries.size, maxEntries, textCap, maxCounters, evictedActive }),
  };
}

/**
 * 进程内单例：`internal.js` 写侧喂它，`http.js` 补发侧读它。
 * 单例是**刻意的**（同一进程内一份真相），测试用 `clear()` 复位、用 `createPartialBuffer()` 起独立实例。
 * ⚠ **per-process**：多副本 portal 必须改成共享状态（见 `docs/api/portal.md` §4.4a 的部署前提）。
 */
export const partialOutputs = createPartialBuffer();
