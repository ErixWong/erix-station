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

/** 站内时区口径：UTC+8（`02` 篇 §1 / `03` 篇 §556 的 `{{date}}`）。日期/时刻一律按这个偏移算。 */
export const TZ_OFFSET_MINUTES = 8 * 60;
/** 免打扰时段（UTC+8，`03` 篇 §296 / `04` 篇 §201）：22:00–08:00。 */
export const QUIET_HOURS = Object.freeze({ start: 22, end: 8 });
/** 评估间隔默认值（`09` 篇 §1.1 新鲜阈值 = 3× 间隔 ⇒ 默认 180s）。 */
export const EVAL_INTERVAL_MS = 60_000;
/** 陈旧判定的余量倍数（`09` 篇 §1.1「留 3 倍余量」）。 */
export const STALE_INTERVAL_MULTIPLE = 3;
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

/** 当前是否落在免打扰时段（UTC+8）：[22:00,24:00) ∪ [00:00,08:00)。 */
export function isQuietHours(epochMs) {
  const { hour } = inTz8(epochMs);
  return hour >= QUIET_HOURS.start || hour < QUIET_HOURS.end;
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
  const ts = lastEvaluatedAt instanceof Date ? lastEvaluatedAt.getTime() : Date.parse(lastEvaluatedAt);
  if (!Number.isFinite(ts)) return true;
  return nowMs - ts > STALE_INTERVAL_MULTIPLE * intervalMs;
}

/** 归一 `now()`（可注入 Date / 数字）为 epoch ms。 */
function nowMsOf(now) {
  const v = typeof now === 'function' ? now() : now;
  return v instanceof Date ? v.getTime() : Number(v);
}

/** 从模板 params 取 `max_per_day`（budget 在 params.budget 或 params 顶层，见 `03` 篇 §610/§622）。 */
function extractMaxPerDay(params) {
  const v = params?.budget?.max_per_day ?? params?.max_per_day;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
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
 * @returns {{stop: () => void, tick: () => Promise<{intents: object[], evaluated: number, failed: number}>}}
 */
export function startMacroEvalLoop(pool, _config = {}, { log = console, intervalMs = EVAL_INTERVAL_MS, now = () => new Date() } = {}) {
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
  const expired = a.until != null && Date.parse(a.until) <= nowMs;
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
 */
export async function evalExpiry(pool, a, nowMs, { log } = {}) {
  const claimed = await claimMacroRun(pool, {
    assignmentId: a.id, anchor: `assignment:${a.id}`, criterion: 'tick', bucket: 'expiry', now: new Date(nowMs),
  });
  if (!claimed) return null; // 已产过 / 已被 W1 停用 ⇒ 不再产
  log.info?.(`[macro-eval] 到期意图 assignment=${a.id}`);
  return buildIntent(a, { anchor: `assignment:${a.id}`, criterion: 'tick', bucket: 'expiry', macroRunId: claimed.id, evidence: { until: a.until, now: new Date(nowMs).toISOString() } });
}

/**
 * ① E5 时钟（scheduled-task）。判据是**状态型**：「今天（UTC+8）没有 `clock:<date>` 的触发记录
 *    且 现在 ≥ 当日 at」——不是「正好到点」，所以进程重启/错过一拍也不会漏。
 * `at` 是 HH:MM **UTC+8**；`clock:<date>` 的 date 也必须是 UTC+8 的 date（`AGENTS`/`02` §1）。
 */
export async function evalClock(pool, a, nowMs, { log } = {}) {
  const at = a.params?.at;
  if (!at) return null; // 缺 at：无从判点，视作未命中（本 kind 已「看过」，仍由调用方推进水位线）
  const { date } = inTz8(nowMs);
  if (nowMs < atToEpochMs(date, at)) return null; // 未到今日 at ⇒ 今天还没到点（求值成功、未命中）
  const anchor = `clock:${date}`;
  const claimed = await claimMacroRun(pool, {
    assignmentId: a.id, anchor, criterion: 'tick', bucket: date, now: new Date(nowMs),
  });
  if (!claimed) return null; // 今天已 tick 过（幂等键命中）⇒ 不再产意图
  return gateAndIntent(pool, a, {
    anchor, criterion: 'tick', bucket: date, macroRunId: claimed.id,
    evidence: { at, local_date: date, fired_at: new Date(nowMs).toISOString() },
    gateFor: 'scheduled-task', log,
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
    const sinceTs = lastEv ? Date.parse(lastEv.ts) : Date.parse(run.started_at ?? run.queued_at);
    const silentMs = nowMs - sinceTs;
    if (!(silentMs > threshold)) continue;
    const anchor = `run:${run.id}`;
    const claimed = await claimMacroRun(pool, {
      assignmentId: a.id, anchor, criterion: 'silent', bucket: phase, now: new Date(nowMs),
    });
    if (!claimed) continue; // 同一 (run,相位) 已产过 ⇒ 幂等键挡下
    const it = await gateAndIntent(pool, a, {
      anchor, criterion: 'silent', bucket: phase, macroRunId: claimed.id,
      evidence: { silent_ms: silentMs, phase, threshold_ms: threshold, last_event_type: lastEv?.type ?? null, last_event_ts: lastEv?.ts ?? null },
      gateFor: 'run-silence-alert', log,
    });
    if (it) intents.push(it);
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
export async function gateAndIntent(pool, a, { anchor, criterion, bucket, macroRunId, evidence, gateFor, log }) {
  const reason = await evaluateSkipGates(pool, a, { nowMs: Date.parse(evidence.fired_at ?? '') || Date.now(), gateFor });
  if (reason) {
    await finishMacroRun(pool, { macroRunId, status: 'skipped', skippedReason: reason });
    log.info?.(`[macro-eval] 跳过 anchor=${anchor} reason=${reason}`);
    return null;
  }
  return buildIntent(a, { anchor, criterion, bucket, macroRunId, evidence });
}

/** 逐条门禁，返回第一个命中的 skipped_reason（无则 null）。 */
export async function evaluateSkipGates(pool, a, { nowMs, gateFor }) {
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
  if (isQuietHours(nowMs)) return 'quiet_hours';
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
