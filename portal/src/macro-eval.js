// issue #525（事件平台 W2 评估循环）：宏平台的「求值器」。
//
// 形状照 `portal/src/routesdrift.js:463-507` 的 `startRouteDriftMonitor`：返回 `{ stop, tick }`，
// `inflight` 去重（重入时**等同一轮**，不是静默跳过），`timer.unref()` 不拖进程退出。
//
// 职责边界（`10-implementation-contract.md` §2.1）：本模块**只产意图**，不执行动作。
//   * 命中 → `claimMacroRun` 占位 → 产一条 `Intent`（内存数组，不落库）；
//   * 命中但要跳过 → `claimMacroRun` 占位 → `finishMacroRun({status:'skipped', skippedReason})`
//     （**跳过也必须落一行**，否则界面「开关开着但没反应」）；
//   * 未命中 → 不建记录（`09` 篇 §1：未命中不建记录，「看过没有」只靠水位线证明）。
//
// 水位线（`09-observability.md` §1.1，本单最容易做错的一格）：
//   求值成功（无论命中与否）→ UPDATE last_evaluated_at；求值抛异常 → **不写**（保持陈旧暴露故障）。
//   ⇒ **先求值成功、再推进水位线**（顺序反了会把「求值抛异常」显示成健康），
//     且**逐条写不批量**（批量会把失败的一起推进）。见 `tick()` 里 `advanceWatermark` 的位置。
import { claimMacroRun, finishMacroRun } from './macros.js';
// 评估间隔与陈旧余量是**跨端面**常量（执行器与用户面共用）⇒ 权威位在
// `shared/macro-kinds.js`（issue #528 / 契约 `10` 篇 §1），本文件只 re-export。
import { EVAL_INTERVAL_MS, STALE_INTERVAL_MULTIPLE, QUIET_WINDOW_RE } from '../shared/macro-kinds.js';

export { EVAL_INTERVAL_MS, STALE_INTERVAL_MULTIPLE };

/** 站内时区口径：UTC+8（`02` 篇 §1 / `03` 篇 §556 的 `{{date}}`）。日期/时刻一律按这个偏移算。 */
export const TZ_OFFSET_MINUTES = 8 * 60;
/** 免打扰时段缺省（UTC+8，`03` 篇 §296 / `04` 篇 §201）：22:00–08:00。形状保留作回落用。 */
export const QUIET_HOURS = Object.freeze({ start: 22, end: 8 });
/** quiet_hours 缺省形态（`04` §201）；params 未给且 env 未设时用它。 */
export const DEFAULT_QUIET_SPEC = '22:00-08:00';
/** max_per_day 缺省（#617：之前 extractMaxPerDay 不传就恒 null ⇒ 闸永不命中）。 */
export const DEFAULT_MAX_PER_DAY = 20;
/**
 * quiet_hours / max_per_day 只对**通知型** kind 生效（#611）：它们的语义是「什么时候值得叫我 /
 * 别把我淹了」。`scheduled-task` 是用户显式指定时刻要跑的任务，01:00 就是 01:00。
 */
export const NOTIFY_KINDS = Object.freeze(['run-notify', 'run-silence-alert']);
/** 静默阈值默认值与「按相位」口径（`10` 篇 §1 KIND_SCHEMA / `05` 篇）：
 *  tool_running 默认 15m；awaiting_llm **默认关**（null ⇒ 该相位不判）。 */
export const SILENCE_DEFAULT_THRESHOLD_MS = 15 * 60_000;
export const SILENCE_PHASE_THRESHOLDS_MS = Object.freeze({
  tool_running: 15 * 60_000,
  awaiting_llm: null,
});
/** run 事件类型 → 静默相位（`05` 篇：静默按「当前在等什么」分相）。 */
export const SILENCE_PHASE_OF_EVENT = Object.freeze({
  tool_use: 'tool_running',
  round_start: 'awaiting_llm',
  assistant_delta: 'awaiting_llm',
});
/**
 * 活跃 run 状态。**以 schema 为准**（`docs/data/schema.sql:203` runs.status 的 CHECK 是
 * `queued/running/cancelling/finished/failed`）——工单正文写的 `pending/claimed/running`
 * 与真库不符（那更像 `runs` 早期口径），此处取库里的真值：未进终态即活跃。
 */
export const ACTIVE_RUN_STATUSES = Object.freeze(['queued', 'running', 'cancelling']);

/** 把 epoch ms 转成 UTC+8 的 {date,hour,minute,minutesOfDay}。 */
export function inTz8(epochMs) {
  const shifted = new Date(Number(epochMs) + TZ_OFFSET_MINUTES * 60_000);
  const date = shifted.toISOString().slice(0, 10);
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  return { date, hour, minute, minutesOfDay: hour * 60 + minute };
}

/** `at`（HH:MM UTC+8）→ 当天（UTC+8 date）那个时刻的 epoch ms。 */
export function atToEpochMs(dateStr, atHHMM) {
  const [h, m] = String(atHHMM).split(':').map((x) => Number(x));
  const dayStartUtc8 = Date.parse(`${dateStr}T00:00:00Z`) - TZ_OFFSET_MINUTES * 60_000;
  return dayStartUtc8 + (h * 60 + m) * 60_000;
}

/** `HH:MM` → 当日分钟数（UTC+8）。 */
function minutesOfHHMM(hhmm) {
  const [h, m] = String(hhmm).split(':').map((x) => Number(x));
  return h * 60 + m;
}

/**
 * 解析 quiet_hours 形态为窗对象（#611/#617）：
 *   `'off'` ⇒ `{off:true}`（永不静默）；`'HH:MM-HH:MM'` ⇒ `{off:false,startMin,endMin}`（UTC+8）；
 *   空/未给 ⇒ 缺省 `22:00-08:00`；**解析失败 ⇒ 回落缺省并 `log.warn`**。
 */
export function parseQuietSpec(raw, { log } = {}) {
  const fallback = () => ({ off: false, startMin: QUIET_HOURS.start * 60, endMin: QUIET_HOURS.end * 60 });
  const s = String(raw ?? '').trim();
  if (s === '') return fallback();
  if (!QUIET_WINDOW_RE.test(s)) {
    log?.warn?.(`[macro-eval] quiet_hours 形态非法（${JSON.stringify(raw)}），回落缺省 ${DEFAULT_QUIET_SPEC}`);
    return fallback();
  }
  if (s === 'off') return { off: true };
  const [a, b] = s.split('-');
  return { off: false, startMin: minutesOfHHMM(a), endMin: minutesOfHHMM(b) };
}

/**
 * 解析一条订阅生效的安静窗（优先级）：`params.quiet_hours`（模板显式）> `ERIX_MACRO_QUIET_HOURS`（env，e2e 逃生阀）> 缺省。
 * env 只覆盖**缺省值**（#611 §5：否则 22:00–08:00 期间只能改代码做 e2e）；模板显式指定时以模板为准。
 */
export function quietSpecFor(params, { log } = {}) {
  const raw = params?.quiet_hours ?? process.env.ERIX_MACRO_QUIET_HOURS;
  return parseQuietSpec(raw, { log });
}

/** 给定时刻是否落在安静窗内（跨午夜窗：start>end，如 22:00-08:00）。 */
function windowActive(spec, epochMs) {
  if (!spec || spec.off) return false;
  const { minutesOfDay } = inTz8(epochMs);
  const { startMin, endMin } = spec;
  if (startMin === endMin) return false; // start==end ⇒ 空窗
  if (startMin < endMin) return minutesOfDay >= startMin && minutesOfDay < endMin;
  return minutesOfDay >= startMin || minutesOfDay < endMin; // 跨午夜
}

/**
 * 当前是否落在免打扰时段（UTC+8）。默认窗 22:00–08:00（不读 env，保证纯时钟口径用例稳定）；
 * 调用方传 `quietSpecFor(params)` 则按模板/env 解析后的窗判。#611 之前用冻结常量不看窗 ⇒ 不可配。
 */
export function isQuietHours(epochMs, spec) {
  return windowActive(spec ?? { off: false, startMin: QUIET_HOURS.start * 60, endMin: QUIET_HOURS.end * 60 }, epochMs);
}

/** 解析 `'15m' / '2h' / '30s' / '900'`（无单位按分钟）为 ms；解析失败给 fallback。 */
export function parseDurationMs(str, fallbackMs) {
  const m = /^(\d+)\s*([smhd])?$/.exec(String(str ?? '').trim());
  if (!m) return fallbackMs ?? null;
  const n = Number(m[1]);
  const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] || 'm'];
  return n * mult;
}

/**
 * 水位线陈旧判定（`09` 篇 §1.1）：`now - last_evaluated_at > 3 × 间隔` 即陈旧。
 * `last` 为 null（首次订阅、尚未评估）⇒ 视为陈旧（界面显示「尚未评估」）。
 */
export function isWatermarkStale(lastEvaluatedAt, nowMs, intervalMs = EVAL_INTERVAL_MS) {
  if (lastEvaluatedAt == null) return true;
  const ts = toMs(lastEvaluatedAt);
  if (!Number.isFinite(ts)) return true;
  return nowMs - ts > STALE_INTERVAL_MULTIPLE * intervalMs;
}

/** 归一 epoch ms（数字）、pg 返回的 timestamptz（JS Date）或 ISO 串为 epoch ms。 */
function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return Date.parse(v);
}

/** 归一 `now()`（可注入 Date / 数字）为 epoch ms。 */
function nowMsOf(now) {
  const v = typeof now === 'function' ? now() : now;
  return v instanceof Date ? v.getTime() : Number(v);
}

/** 从模板 params 取 `max_per_day`（#617：拍平后在 params 顶层，兼容旧的 params.budget.max_per_day）；缺省 20。 */
function extractMaxPerDay(params) {
  const v = params?.max_per_day ?? params?.budget?.max_per_day;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_PER_DAY;
}

/** 求一个相位的静默阈值（ms）；null ⇒ 该相位不判（默认 awaiting_llm 关）。 */
function silenceThresholdForPhase(phase, params) {
  const defaultMs = phase === 'tool_running' ? SILENCE_DEFAULT_THRESHOLD_MS : SILENCE_PHASE_THRESHOLDS_MS[phase];
  // 模板显式给了 threshold 就覆盖默认（仅对**已启用**的相位生效）。
  const override = parseDurationMs(params?.threshold, null);
  const enabled = Array.isArray(params?.phases) ? params.phases.includes(phase) : phase === 'tool_running';
  if (!enabled) return null;
  return override ?? defaultMs;
}

/**
 * 启动评估循环：启动即跑一次，此后每 `intervalMs` 一次。
 *
 * `onIntents`（issue #616）：**可注入**的意图消费者回调（默认 no-op）。本模块**只产意图不执行动作**
 * （契约 `10` §2 的 W2 边界）——它不 import 任何执行器，只把 `tick()` 攒下的意图交给注入方。
 * 真正的执行器与收尾在 `./macro-dispatcher.js`，由 `cli.js` 接线（`onIntents: dispatcher.dispatch`）。
 * ⚠ `onIntents` **抛异常不许打断评估循环**（故包 try/catch，只 warn）：消费者挂了，评估器仍要继续
 * 产意图/推进水位线，否则一处执行故障会把整条评估链显示成「循环没跑」。
 * @returns {{stop: () => void, tick: () => Promise<{intents: object[], evaluated: number, failed: number}>}}
 */
export function startMacroEvalLoop(pool, _config = {}, { log = console, intervalMs = EVAL_INTERVAL_MS, now = () => new Date(), onIntents = async () => {} } = {}) {
  let stopped = false;
  /** @type {Promise<object>|null} 正在进行的一轮（去重靠它，重入等同一轮，不静默跳过）。 */
  let inflight = null;

  const tick = async () => {
    if (stopped) return { intents: [], evaluated: 0, failed: 0, stopped: true };
    if (inflight) return inflight; // 等同一轮，而不是「静默丢掉这一拍」
    const round = (async () => {
      const nowMs = nowMsOf(now);
      const intents = [];
      let evaluated = 0;
      let failed = 0;
      let rows;
      try {
        rows = await listEvaluableAssignments(pool);
      } catch (err) {
        // 取订阅这一步失败 ⇒ 整轮没有任何订阅被求值 ⇒ 一个水位线都不推进（暴露为「循环没跑」）。
        log.warn?.(`[macro-eval] 取订阅失败（本轮不推进任何水位线）：${err?.message}`);
        return { intents, evaluated, failed, roundError: err?.message };
      }
      for (const a of rows) {
        let res;
        try {
          res = await evalOneAssignment(pool, a, nowMs, { log });
        } catch (err) {
          // 求值抛异常 ⇒ failed++ 且**不推进**这条的水位线（保持陈旧）。
          failed += 1;
          log.warn?.(`[macro-eval] 求值异常 id=${a.id} kind=${a.kind}：${err?.message}`);
          continue;
        }
        if (res.evaluated) {
          evaluated += 1;
          intents.push(...res.intents);
          // ⚠ **先求值成功、再推进水位线**；逐条写、不批量（`09` 篇 §1.1）。
          await advanceWatermark(pool, a.id);
        }
      }
      // issue #616：把本轮产出的意图交给**注入的消费者**（默认 no-op）。评估器只产不执行，
      // 且消费者抛异常**不许**打断评估——故 try/catch，失败只 warn，本轮结果照常返回。
      if (intents.length > 0) {
        try {
          await onIntents(intents);
        } catch (err) {
          log.warn?.(`[macro-eval] 意图消费者异常（已产 ${intents.length} 条，不影响本轮评估）：${err?.message ?? err}`);
        }
      }
      return { intents, evaluated, failed };
    })();
    inflight = round;
    try {
      return await round;
    } finally {
      if (inflight === round) inflight = null;
    }
  };

  void tick(); // 启动一次（不等 intervalMs：portal 刚重启最该立刻对账）。
  const timer = setInterval(() => { void tick(); }, intervalMs);
  // 定时器**不许**拖住进程退出（与其余 reconciler 一致：shutdown 里 stop，但兜底 unref）。
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() { stopped = true; clearInterval(timer); },
    tick,
    now,
  };
}

/**
 * 取本轮要评估的订阅：JOIN `macro_templates` 拿 `kind/name/params/scope`
 * （`toAssignmentSnapshot` 不带 `kind`，而分派必须按 kind）。只取 `enabled=true`；
 * 「到期」不在此处过滤（到期扫描要的就是「DB 里仍 enabled 但 until 已过」这批）。
 */
export async function listEvaluableAssignments(pool) {
  const res = await pool.query(
    `SELECT a.id, a.template_id, a.user_id, a.session_id, a.cwd, a.until, a.enabled,
            a.last_evaluated_at, t.kind, t.name AS template_name, t.params, t.scope
       FROM macro_assignments a
       JOIN macro_templates t ON t.id = a.template_id
      WHERE a.enabled = true
      LIMIT 500`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    templateId: r.template_id,
    userId: r.user_id,
    sessionId: r.session_id ?? null,
    cwd: r.cwd ?? null,
    until: r.until ?? null,
    enabled: r.enabled,
    lastEvaluatedAt: r.last_evaluated_at ?? null,
    kind: r.kind,
    templateName: r.template_name,
    params: r.params ?? {},
    scope: r.scope,
  }));
}

/** 求值成功 ⇒ **逐条**推进水位线（不批量，`09` 篇 §1.1）。 */
export async function advanceWatermark(pool, assignmentId) {
  await pool.query('UPDATE macro_assignments SET last_evaluated_at = now() WHERE id = $1', [assignmentId]);
}

/**
 * 单条订阅求值分派。返回 `{evaluated, intents}`：
 *   `evaluated=false` ⇒ 本 kind 不由评估循环负责（run-notify/run-review 由 W1 的终态触发驱动），
 *                        调用方**不推进**其水位线（「该条未求值 ⇒ 不写」）。
 *   抛异常 ⇒ 直接向外抛（调用方据此 failed++、不推进）。
 */
export async function evalOneAssignment(pool, a, nowMs, { log } = {}) {
  const intents = [];
  let evaluated = false;
  const expired = a.until != null && toMs(a.until) <= nowMs;
  if (expired) {
    // 到期扫描（`10` 篇 §4）：产一条到期意图（停用本身由 W1 的 applyExpiredAssignments 顺手做）。
    const it = await evalExpiry(pool, a, nowMs, { log });
    if (it) intents.push(it);
    evaluated = true;
  } else if (a.kind === 'scheduled-task') {
    const it = await evalClock(pool, a, nowMs, { log });
    if (it) intents.push(it);
    evaluated = true;
  } else if (a.kind === 'run-silence-alert') {
    intents.push(...await evalSilence(pool, a, nowMs, { log }));
    evaluated = true;
  }
  return { evaluated, intents };
}

/**
 * ③ `until` 到期扫描（`10` 篇 §4）：enabled=true 且 until<=now ⇒ 产一条到期意图。
 * anchor=`assignment:<id>`、criterion=`tick`、bucket=`expiry`。靠幂等键，每订阅只产一次。
 *
 * ⚠ **为什么这里不能直接用 `claimMacroRun`**：`claimMacroRun` 一进来就先跑
 *   `applyExpiredAssignments`（把 `until<=now` 的订阅置 `enabled=false`），而它那条
 *   `INSERT … WHERE EXISTS (… a.enabled)` 要求订阅**仍启用** ⇒ 对「刚过期」的订阅，
 *   资格谓词已被自己抹掉，claim 必返回 `null`，到期意图永远产不出。
 *   所以到期意图走下面的 `claimExpiryRun`（同样的幂等键 `ON CONFLICT DO NOTHING`，
 *   只是不带 `enabled` 谓词）。这是相对 §2.1「claim 一律走 `claimMacroRun`」的一处
 *   必要偏离，原因就记在这段注释里。
 */
export async function evalExpiry(pool, a, nowMs, { log } = {}) {
  const claimed = await claimExpiryRun(pool, { assignmentId: a.id, now: new Date(nowMs) });
  if (!claimed) return null; // 已产过（幂等键命中）⇒ 不再产
  log.info?.(`[macro-eval] 到期意图 assignment=${a.id}`);
  return buildIntent(a, { anchor: `assignment:${a.id}`, criterion: 'tick', bucket: 'expiry', macroRunId: claimed.id, evidence: { until: a.until, now: new Date(nowMs).toISOString() } });
}

/**
 * 到期意图专用的占位：与 `claimMacroRun` 同一条幂等键（`assignment_id,anchor,criterion,bucket`）、
 * 同一段 `last_evaluated_at` 推进、同样的**模板闸**（`t.enabled AND t.deleted_at IS NULL`，
 * 与 #524 审计回修后的 `claimMacroRun` 一致），**但不带订阅自身的 `a.enabled` 谓词**。
 *
 * 取舍（写清楚）：
 *   - 不查 `a.enabled` 是**刻意**的——到期这一刻订阅正要被置为停用，用启用谓词会把自己挡掉；
 *   - 查模板闸也是**刻意**的——模板已软删/停用时，那条订阅本来就不该再产生任何东西（包括到期
 *     通知），所以到期意图同样挡在模板闸之后。
 * 命中冲突（已产过）⇒ 返回 null。
 */
export async function claimExpiryRun(pool, { assignmentId, now }) {
  const at = now instanceof Date ? now : new Date(now);
  const res = await pool.query(
    `INSERT INTO macro_runs
         (assignment_id, anchor, criterion, status, bucket, started_at)
     SELECT $1, $2, 'tick', 'pending', 'expiry', $3
       WHERE EXISTS (SELECT 1 FROM macro_assignments a
                       JOIN macro_templates t ON t.id = a.template_id
                      WHERE a.id = $1 AND t.enabled AND t.deleted_at IS NULL)
     ON CONFLICT (assignment_id, anchor, criterion, bucket) DO NOTHING
     RETURNING id`,
    [assignmentId, `assignment:${assignmentId}`, at],
  );
  const id = res.rows[0]?.id ?? null;
  if (id) await pool.query('UPDATE macro_assignments SET last_evaluated_at = $2 WHERE id = $1', [assignmentId, at]);
  return id ? { id } : null;
}

/** `jitter` 上限（`07` 篇 §840 / `05` §21.6：范围 0–30m）。 */
export const JITTER_MAX_MS = 30 * 60_000;

/**
 * issue #627 ①：把 `jitter` 解析成**本订阅专用**的抖动上限（ms）。
 *
 * 口径（写清，避免下次又「存了不用」）：
 *   * `params.jitter` 非法/未给 ⇒ **0**（= 不打散，与 #627 之前的行为逐字相同）。
 *     设计稿（`05` §21.6）给的是「缺省 ±10m」，但 `KIND_SCHEMA` 里没有 default（`shared/macro-kinds.js:72`），
 *     平台也没有任何地方把缺省物化进 `params`——在这里凭空造一个缺省会让**所有**现有定时任务
 *     莫名晚几分钟起（那是另一种静默失效），所以只修「填了就得生效」，缺省仍是不打散。
 *   * 越界钳到 `[0, 30m]`（`07` §840 的范围）：写 `2h` 不该把任务拖到下午。
 */
export function jitterSpanMs(params) {
  const raw = parseDurationMs(params?.jitter, 0) ?? 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), JITTER_MAX_MS);
}

/**
 * 由订阅身份派生的**确定性**抖动偏移 ∈ [0, spanMs]（FNV-1a 32bit）。
 *
 * 为什么必须确定性而不是 `Math.random()`：评估循环每 60s 跑一拍，同一订阅在真正被 claim 前
 * 会被反复问「到点了吗」。随机偏移会让它**每拍的判点都不一样**——既可能提前 tick，也可能
 * 永远差一点；确定性 hash 保证「一个订阅一个固定判点」，而不同订阅各自错开（=打散并发）。
 * 偏移**只加不减**（`at + offset`，不是 `at ± offset`）：用户填 09:00，提前到 08:5x 起任务是
 * 错的（可能赶上用户还没开工的时段），延后才是 jitter 的本意（`06` §65：防 capacity=2 排队堆积）。
 */
export function jitterOffsetMs(seed, spanMs) {
  const span = Math.floor(Number(spanMs) || 0);
  if (span <= 0) return 0;
  const s = String(seed ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % (span + 1);
}

/**
 * ① E5 时钟（scheduled-task）。判据是**状态型**：「今天（UTC+8）没有 `clock:<date>` 的触发记录
 *    且 现在 ≥ 当日 at（+ jitter 偏移）」——不是「正好到点」，所以进程重启/错过一拍也不会漏。
 * `at` 是 HH:MM **UTC+8**；`clock:<date>` 的 date 也必须是 UTC+8 的 date（`AGENTS`/`02` §1）。
 * jitter 只改**何时算到点**，不改锚/桶（锚里带偏移会让同一天 tick 两次）。
 */
export async function evalClock(pool, a, nowMs, { log } = {}) {
  const at = a.params?.at;
  if (!at) return null; // 缺 at：无从判点，视作未命中（本 kind 已「看过」，仍由调用方推进水位线）
  const { date } = inTz8(nowMs);
  // issue #627 ①：`jitter` 过去被写进 params 却没人读（存了不用）⇒ 所有订阅在同一拍齐射，
  // 容器 capacity=2 直接排队。现在把每个订阅的固定偏移加到判点上：`at + hash(assignment)`。
  const jitterMs = jitterSpanMs(a.params);
  const offsetMs = jitterOffsetMs(a.id ?? a.templateId, jitterMs);
  const fireAtMs = atToEpochMs(date, at) + offsetMs;
  if (jitterMs > 0 && offsetMs > 0) {
    log?.debug?.(`[macro-eval] jitter assignment=${a.id} at=${at} 偏移=${offsetMs}ms（窗 ${jitterMs}ms）`);
  }
  if (nowMs < fireAtMs) return null; // 未到今日判点（含 jitter）⇒ 今天还没到点（求值成功、未命中）
  const anchor = `clock:${date}`;
  const claimed = await claimMacroRun(pool, {
    assignmentId: a.id, anchor, criterion: 'tick', bucket: date, now: new Date(nowMs),
  });
  if (!claimed) return null; // 今天已 tick 过（幂等键命中）⇒ 不再产意图
  return gateAndIntent(pool, a, {
    anchor, criterion: 'tick', bucket: date, macroRunId: claimed.id,
    evidence: { at, local_date: date, fired_at: new Date(nowMs).toISOString() },
    gateFor: 'scheduled-task', nowMs, log,
  });
}

/**
 * ② E1 静默（run-silence-alert）。判据 `now - max(run_events.ts) > threshold`，**按相位**。
 * ⚠ **时钟量必须是 `run_events`，不是 IPC**：`shell` 执行期每 30s 发 `shell_liveness` 心跳
 *    （`runner/worker.js:593-603`「绝不得走 emitEvent」⇒ 不落 run_events）⇒ 长命令期间 IPC 一直有、
 *    run_events 一条没有；用户感知的「没反馈」正是后者。
 * 只对活跃 run 算；anchor=`run:<id>`、criterion=`silent`、bucket=相位名（同 (run,相位) 只产一次）。
 */
export async function evalSilence(pool, a, nowMs, { log } = {}) {
  const intents = [];
  if (!a.sessionId) return intents; // session scope 才有会话可判
  // #611 ③：安静窗内不丢弃。对通知型：窗内命中⇒**不 claim、不落 skipped 行**（挂起），
  // 窗外的下一次求值把「静默起点落在窗内」的那些**合并成一颗 digest**（不是逐条补发）。
  const isNotify = NOTIFY_KINDS.includes(a.kind);
  const spec = isNotify ? quietSpecFor(a.params, { log }) : null;
  const inQuietNow = isNotify && windowActive(spec, nowMs);
  const digestBacklog = []; // 静默起点落在安静窗内、而现在已经出窗的 run（待合并）
  const runsRes = await pool.query(
    `SELECT id, started_at, queued_at FROM runs
      WHERE session_id = $1 AND status = ANY($2::text[])`,
    [a.sessionId, [...ACTIVE_RUN_STATUSES]],
  );
  for (const run of runsRes.rows) {
    // 最后一条 run_event 决定相位与静默起点。
    const evRes = await pool.query(
      `SELECT type, ts FROM run_events WHERE run_id = $1 ORDER BY ts DESC, seq DESC LIMIT 1`,
      [run.id],
    );
    const lastEv = evRes.rows[0] ?? null;
    const phase = lastEv ? (SILENCE_PHASE_OF_EVENT[lastEv.type] ?? null) : null;
    if (!phase) continue; // 最后一条不属于可判相位（如 tool_result/run_end）⇒ 不判
    const threshold = silenceThresholdForPhase(phase, a.params);
    if (threshold == null) continue; // 该相位默认关（awaiting_llm）⇒ 不判
    // 静默起点：有事件用最后事件 ts；无事件退到 run 起跑时刻（started/queued）。
    const sinceTs = lastEv ? toMs(lastEv.ts) : toMs(run.started_at ?? run.queued_at);
    const silentMs = nowMs - sinceTs;
    if (!(silentMs > threshold)) continue;
    if (inQuietNow) continue; // 窗内：不丢弃但不即时发（不 claim、不落 skipped），等窗外合并
    // 出窗：若静默起点落在安静窗内 ⇒ 这是被压住的积压，归入 digest（不单独发）。
    if (isNotify && windowActive(spec, sinceTs)) {
      digestBacklog.push({ runId: run.id, phase, silentMs });
      continue;
    }
    const anchor = `run:${run.id}`;
    const claimed = await claimMacroRun(pool, {
      assignmentId: a.id, anchor, criterion: 'silent', bucket: phase, now: new Date(nowMs),
    });
    if (!claimed) continue; // 同一 (run,相位) 已产过 ⇒ 幂等键挡下
    const it = await gateAndIntent(pool, a, {
      anchor, criterion: 'silent', bucket: phase, macroRunId: claimed.id,
      evidence: { silent_ms: silentMs, phase, threshold_ms: threshold, last_event_type: lastEv?.type ?? null, last_event_ts: lastEv?.ts ?? null },
      gateFor: 'run-silence-alert', nowMs, log,
    });
    if (it) intents.push(it);
  }
  // 积压合并：多条挂起的静默→**一封 digest**（幂等键 `digest:<window-date>`、criterion=tick、bucket=<日期>）。
  // 同一窗日只发一次（claim 幂等）；后续同日的求值 claim 拿 null ⇒ 不重复补发。
  if (digestBacklog.length) {
    const { date } = inTz8(nowMs);
    const anchor = `digest:${date}`;
    const claimed = await claimMacroRun(pool, {
      assignmentId: a.id, anchor, criterion: 'tick', bucket: date, now: new Date(nowMs),
    });
    if (claimed) {
      const it = await gateAndIntent(pool, a, {
        anchor, criterion: 'tick', bucket: date, macroRunId: claimed.id,
        evidence: { digest: true, merged: digestBacklog.length, runs: digestBacklog.map((d) => d.runId) },
        gateFor: a.kind, nowMs, log,
      });
      if (it) intents.push(it);
    }
  }
  return intents;
}

/**
 * ⑤ 跳过判定 + ⑥ 产意图。命中并已 claim 后，逐条门禁：命中门禁 ⇒ `finishMacroRun(skipped)`、
 * 不产意图（跳过也落一行）；全过 ⇒ 产 `Intent`。
 *
 * 门禁（`10` 篇 §1 `SKIPPED_REASON` 为准，**不在本模块另抄一份**）：
 *   - `budget_exhausted`：当日（UTC+8）该订阅已产 > max_per_day 条；
 *   - `quiet_hours`：落在 22:00–08:00（UTC+8）；
 *   - `run_in_progress` / `active_run_in_cwd`：**仅 scheduled-task 判**（这两个是「别再起新 run」的
 *     预检；静默告警本身就是因为有活跃 run 才响，判它会自相矛盾）。
 *
 * ⚠ `active_run_in_cwd` 在 W2 **只是意图层预检**（`10` 篇 §2.2）：结果可能过期，**最终裁决在
 *   W3/W4 创建 run 的那个事务里**（条件插入 / 行锁）。这里的判断不作为正确性保证。
 */
export async function gateAndIntent(pool, a, { anchor, criterion, bucket, macroRunId, evidence, gateFor, nowMs, log }) {
  const reason = await evaluateSkipGates(pool, a, { nowMs, gateFor, log });
  if (reason) {
    await finishMacroRun(pool, { macroRunId, status: 'skipped', skippedReason: reason });
    log.info?.(`[macro-eval] 跳过 anchor=${anchor} reason=${reason}`);
    return null;
  }
  return buildIntent(a, { anchor, criterion, bucket, macroRunId, evidence });
}

/** 逐条门禁，返回第一个命中的 skipped_reason（无则 null）。 */
export async function evaluateSkipGates(pool, a, { nowMs, gateFor, log } = {}) {
  // budget_exhausted：当日（UTC+8）已产 > max_per_day（本轮 claim 已计入 ⇒ 用 `>`）。
  const maxPerDay = extractMaxPerDay(a.params);
  if (maxPerDay != null) {
    const { date } = inTz8(nowMs);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM macro_runs
        WHERE assignment_id = $1 AND status <> 'superseded'
          AND (started_at AT TIME ZONE 'Asia/Shanghai')::date = $2::date`,
      [a.id, date],
    );
    if ((rows[0]?.n ?? 0) > maxPerDay) return 'budget_exhausted';
  }
  // quiet_hours：**只对通知型生效**（#611）；scheduled-task/run-review 不受约束。
  // 命中 ⇒ 返回 'quiet_hours'；但通知型的「不丢弃」在 evalSilence 层面处理（窗内不 claim、窗外合并发 digest），
  // 不会走到这里落 skipped；此返回值留给非窗内场景（已出窗 ⇒ windowActive=false ⇒ 不命中）。
  if (NOTIFY_KINDS.includes(gateFor) && isQuietHours(nowMs, quietSpecFor(a.params, { log }))) return 'quiet_hours';
  if (gateFor === 'scheduled-task') {
    // run_in_progress：同会话（若订阅绑了 session）有活跃 run。
    if (a.sessionId) {
      const { rows } = await pool.query(
        `SELECT 1 FROM runs WHERE session_id = $1 AND status = ANY($2::text[]) LIMIT 1`,
        [a.sessionId, [...ACTIVE_RUN_STATUSES]],
      );
      if (rows.length) return 'run_in_progress';
    }
    // active_run_in_cwd：同 cwd 有活跃 run（**意图层预检**，见上注；最终裁决在 W3/W4）。
    if (a.cwd) {
      const { rows } = await pool.query(
        `SELECT 1 FROM runs r
           JOIN chat_sessions s ON s.id = r.session_id
           JOIN projects p ON p.id = s.project_id
          WHERE p.root_path = $1 AND r.status = ANY($2::text[]) LIMIT 1`,
        [a.cwd, [...ACTIVE_RUN_STATUSES]],
      );
      if (rows.length) return 'active_run_in_cwd';
    }
  }
  return null;
}

/** 组装 `Intent`（`10` 篇 §2 结构；内存对象，不落库）。 */
function buildIntent(a, { anchor, criterion, bucket, macroRunId, evidence }) {
  return {
    assignmentId: a.id,
    templateId: a.templateId,
    templateKind: a.kind,
    templateName: a.templateName,   // 快照：模板改名后历史仍显示当时名字
    params: a.params ?? {},         // 快照：执行时不再回查模板
    userId: a.userId,
    sessionId: a.sessionId ?? null,
    cwd: a.cwd ?? null,
    anchor,
    criterion,
    bucket,
    evidence: evidence ?? {},
    macroRunId,                     // 已占位的账 id（W3/W4 只 finish，不重新 claim）
  };
}
