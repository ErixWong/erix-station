// issue #525（W2 评估循环）：宏平台的「求值器」。
//
// 形状照 `portal/src/routesdrift.js` 的 `startRouteDriftMonitor`：返回 `{ stop, tick }`，
// `inflight` 去重（重入时**等同一轮**，不是静默跳过），`timer.unref()` 不拖进程退出。
//
// 职责边界（`10-implementation-contract.md` §2.1）：本模块**只产意图**，不执行动作。
//   * 命中 → `claimMacroRun` 占位 → 产一条 `Intent`（内存数组，不落库）；
//   * 命中但要跳过 → `claimMacroRun` 占位 → `finishMacroRun({status:'skipped', skippedReason})`（跳过也落一行）；
//   * 未命中 → 不建记录（`09` 篇 §1：未命中不建记录，「看过没有」只靠水位线证明）。
//
// 水位线（`09-observability.md` §1.1，本单最容易做错的一格）：
//   求值成功（无论命中与否）→ UPDATE last_evaluated_at；求值抛异常 → **不写**（保持陈旧暴露故障）。
//   ⇒ **先求值成功、再推进水位线**，且**逐条写不批量**（批量会把失败的一起推进）。
import { claimMacroRun, finishMacroRun } from './macros.js';

/** 站内时区口径：UTC+8（`02` 篇 §1 / `03` 篇 §556 的 `{{date}}`）。日期/时刻一律按这个偏移算。 */
export const TZ_OFFSET_MINUTES = 8 * 60;
/** 免打扰时段（UTC+8，`03` 篇 §296 / `04` 篇 §201）：22:00–08:00。 */
export const QUIET_HOURS = Object.freeze({ start: 22, end: 8 });
/** 评估间隔默认值（`09` 篇 §1.1 新鲜阈值 = 3× 间隔）。 */
export const EVAL_INTERVAL_MS = 60_000;
/** 静默阈值默认值与「按相位」口径（`10` 篇 §1 KIND_SCHEMA / `05` 篇）。 */
export const SILENCE_DEFAULT_THRESHOLD_MS = 15 * 60_000; // tool_running 默认 15m
export const SILENCE_PHASE_THRESHOLDS_MS = Object.freeze({
  tool_running: 15 * 60_000,
  awaiting_llm: null, // 默认关（null ⇒ 该相位不判）
});
/** 活跃 run 状态（`02`/`08` 篇：静默只对活跃 run 算）。 */
export const ACTIVE_RUN_STATUSES = Object.freeze(['pending', 'claimed', 'running']);

/** 把 epoch ms 转成 UTC+8 的 {date:'YYYY-MM-DD', hour, minute, minutesOfDay}。 */
export function inTz8(epochMs) {
  const shifted = new Date(Number(epochMs) + TZ_OFFSET_MINUTES * 60_000);
  const date = shifted.toISOString().slice(0, 10);
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  return { date, hour, minute, minutesOfDay: hour * 60 + minute };
}

/** `at`（HH:MM UTC+8）→ 当天那个时刻的 epoch ms（date 用 UTC+8 的 date）。 */
export function atToEpochMs(dateStr, atHHMM) {
  const [h, m] = String(atHHMM).split(':').map((x) => Number(x));
  // 当天 date（UTC+8）的 HH:MM ⇒ 该时刻的 UTC epoch = 当日 00:00 UTC+8 + h:m
  const dayStartUtc8 = Date.parse(`${dateStr}T00:00:00Z`) - TZ_OFFSET_MINUTES * 60_000;
  return dayStartUtc8 + (h * 60 + m) * 60_000;
}

/** 当前是否落在免打扰时段（UTC+8）：[22:00,24:00) ∪ [00:00,08:00)。 */
export function isQuietHours(epochMs) {
  const { hour } = inTz8(epochMs);
  return hour >= QUIET_HOURS.start || hour < QUIET_HOURS.end;
}

/** 解析 `'15m' / '2h' / '30s'` 为 ms。 */
export function parseDurationMs(str, fallbackMs) {
  const m = /^(\d+)\s*([smhd])?$/.exec(String(str ?? '').trim());
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const unit = m[2] || 'm';
  const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return n * mult;
}

/** 产意图的骨架模块；具体判据在下方各 `eval*` 里补齐。 */
export function startMacroEvalLoop(pool, _config = {}, { log = console, intervalMs = EVAL_INTERVAL_MS, now = () => new Date() } = {}) {
  let stopped = false;
  /** @type {Promise<object>|null} 正在进行的一轮（去重靠它，重入等同一轮）。 */
  let inflight = null;

  const tick = async () => {
    if (stopped) return { intents: [], evaluated: 0, failed: 0, failedReason: 'stopped' };
    if (inflight) return inflight; // 等同一轮，不静默跳过
    const round = (async () => {
      const nowMs = now() instanceof Date ? now().getTime() : Number(now());
      const intents = [];
      let evaluated = 0;
      let failed = 0;
      try {
        const rows = await listEvaluableAssignments(pool);
        // 1) 到期扫描（`10` 篇 §4）：enabled=true 且 until<=now ⇒ 产一条到期意图。
        for (const a of rows) {
          try {
            const it = await evalExpiry(pool, a, nowMs, { log });
            if (it) intents.push(it);
          } catch (err) { failed += 1; log.warn?.(`[macro-eval] 到期求值异常 id=${a.id}: ${err?.message}`); }
        }
        // 2) E5 时钟 + E1 静默：按 kind 分派，逐条求值成功才推进水位线。
        for (const a of rows) {
          try {
            const before = intents.length;
            await evalAssignment(pool, a, nowMs, intents, { log });
            evaluated += 1;
            // 求值成功 ⇒ 逐条推进水位线（放在求值**之后**，见文件头）。
            await advanceWatermark(pool, a.id);
            void before;
          } catch (err) { failed += 1; log.warn?.(`[macro-eval] 求值异常 id=${a.id}: ${err?.message}`); }
        }
      } catch (err) {
        log.warn?.(`[macro-eval] 轮次异常（取订阅失败）：${err?.message}`);
        return { intents, evaluated, failed, roundError: err?.message };
      }
      return { intents, evaluated, failed };
    })();
    inflight = round;
    try { return await round; } finally { if (inflight === round) inflight = null; }
  };

  void tick();
  const timer = setInterval(() => { void tick(); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() { stopped = true; clearInterval(timer); },
    tick,
    now,
  };
}

// —— 下面的取数与求值函数在里程碑 ②/③ 补齐，先给能编译通过的占位实现。 —

/** 取「本轮要评估的订阅」：JOIN `macro_templates` 拿 kind/name/params（`toAssignmentSnapshot` 不带 kind）。 */
export async function listEvaluableAssignments(_pool) { return []; }

/** 求值成功 ⇒ 逐条推进水位线（不批量）。 */
export async function advanceWatermark(pool, assignmentId) {
  await pool.query('UPDATE macro_assignments SET last_evaluated_at = now() WHERE id = $1', [assignmentId]);
}

/** 到期意图（`10` 篇 §4）。 */
export async function evalExpiry(_pool, _a, _nowMs, _opts) { return null; }

/** 按 kind 分派的单条求值：E5 时钟 / E1 静默。 */
export async function evalAssignment(_pool, _a, _nowMs, _intents, _opts) { return null; }

void claimMacroRun; void finishMacroRun;
