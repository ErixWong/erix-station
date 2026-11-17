// issue #616（事件平台·意图消费者 / intent dispatcher）：评估器（W2）产出的意图**消费者**。
//
// 背景（issue #616）：W2 的 `startMacroEvalLoop.tick()` 产出 `{intents, ...}`，但全仓**没有任何
// 消费者**——`executeScheduledIntent`（W7）/`runMacroReview`（W4b）/`deliverIntent`（W3）生产代码零调用，
// 于是 M1 通知 / M9 审查 / M7 定时任务三条主功能全断；更糟的是 `gateAndIntent` 通过门禁时
// 返回意图而 `claimMacroRun` 已插入 `status='pending'` ⇒ 那条 `macro_runs` 行**永久停在 pending**
// （既没执行也没 finish），管理台 `triggered` 一直涨、`done` 永远不涨。
//
// 本模块**独立成文件**（不在 macro-eval.js 里直接 import 执行器）：契约 `10` §2 划的是「评估器
// 不执行动作，执行器消费意图」——把执行器 import 进评估循环会把评估与执行**耦死**、破 W2 边界。
// 因此 `macro-eval.js` 只持有一个**可注入**的 `onIntents` 回调（见其 `startMacroEvalLoop`），
// 真正的执行器由本模块持有、由 `cli.js` 组装时接线（`onIntents: dispatcher.dispatch`）。
//
// 收尾边界（本单最容易做错的一格）：
//   * `scheduled-task`/`run-review` 的执行器（`executeScheduledIntent`/`runMacroReview`）**自己 finish**
//     （done 时带**具体 verdict**：pass/red/needs-human…）。dispatcher **不重复 finish**——否则会用
//     `finishMacroRun` 缺省的 `unclassified` 覆盖掉审查判决。dispatcher 只在执行器**抛异常**时补
//     `finishMacroRun(failed)`（要求③：失败必须收尾，绝不留 pending）。
//   * `run-notify`/`run-silence-alert` 的执行器 `deliverIntent` **不碰账**（只写 notifications）⇒
//     由 dispatcher **自己** finish：投递成功⇒done，抛异常⇒failed。
import os from 'node:os';
import { finishMacroRun, MacroError } from './macros.js';
import { executeScheduledIntent } from './macro-scheduled.js';
import { runMacroReview } from './macro-review.js';
import { deliverIntent } from './notifications.js';

/** 超时回收阈值（要求④）：`pending` 且 `started_at` 早于 now-此值 ⇒ 判为「派发途中进程崩了」，落 failed。 */
export const DISPATCH_TIMEOUT_MS = 10 * 60_000;
/** 超时清扫循环的间隔（与评估循环**分开**起：职责不同，见 issue 要求④「别和评估循环合并」）。 */
export const SWEEP_INTERVAL_MS = 5 * 60_000;

/** runTask 真实实现等 run 到终态的**上限**（#637 ①）：超时 ⇒ `run_timeout`（不重试，`06` §8：时间意图会过期，补跑重复烧钱）。 */
export const RUN_TASK_TIMEOUT_MS = 30 * 60_000;
/** runTask 轮询 `runs.status` 的间隔。 */
export const RUN_TASK_POLL_MS = 2_000;

/**
 * 从 `transcript_rounds` 取该 run 的**最后一条 assistant 正文**（#637 ①）。
 *
 * ⚠ 不能读 `messages.content`：P3 PR②b 起 `messages` 对 assistant **停双写**（`content` 恒为空串，
 * 真相在 `transcript_rounds.messages` = 引擎 canonical 消息数组），口径同读侧
 * `session-view.assistantTurnText` / `session-text.fetchRunAssistantText`。
 * 逐轮（新→旧）倒序扫 `messages` 数组，取第一条 `role==='assistant'` 且正文非空的文本；
 * `content` 可为 string 或 block 数组（取 block 的 `text` 拼接）。取不到 ⇒ ''（空产物，不影响终态判定）。
 */
async function collectRunFinalText(pool, runId) {
  if (!runId) return '';
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT round, messages FROM transcript_rounds WHERE run_id = $1 ORDER BY round DESC LIMIT 40`,
      [runId],
    ));
  } catch {
    return '';
  }
  const extract = (msg) => {
    if (!msg || typeof msg !== 'object' || msg.role !== 'assistant') return null;
    const c = msg.content ?? msg.text;
    if (typeof c === 'string') return c === '' ? null : c;
    if (Array.isArray(c)) {
      const t = c.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).filter(Boolean).join('\n').trim();
      return t === '' ? null : t;
    }
    return null;
  };
  for (const row of rows) {
    const msgs = Array.isArray(row.messages) ? row.messages : [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const t = extract(msgs[i]);
      if (t) return t;
    }
  }
  return '';
}

/**
 * runTask 的**生产真实实现**（#637 ①）：轮询 `runs.status` 直到终态（`finished` / `failed`，
 * `cancelling` 属非终态继续等它落到终态），把 `status` / `error` / 最后一条 assistant 正文收集起来。
 *
 * 返回 `{ ok: status === 'finished', text, termination: { reason, error }, error }`（额外带一个顶层
 * `error` 字符串，供 `executeScheduledIntent.failRun` 的 reason 可读）。超时 ⇒ `{ ok:false,
 * termination:{reason:'run_timeout'} }`。**不重试**（`06` §8）。超时/轮询/时钟/睡眠都可注入（测试用短超时）。
 *
 * @param {{pool:object, childRunId?:string, log?:object}} ctx 执行器传入的执行上下文
 * @param {{timeoutMs?:number, pollMs?:number, now?:()=>number, sleep?:(ms:number)=>Promise<void>}} [opts]
 */
export async function pollRunTask({ pool, childRunId } = {}, {
  timeoutMs = RUN_TASK_TIMEOUT_MS,
  pollMs = RUN_TASK_POLL_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const fail = (reason, error) => ({
    ok: false, text: '',
    termination: { reason, error: error ?? null },
    error: error?.message ? `${reason}: ${error.message}` : String(reason),
  });
  if (!childRunId) return fail('no_child_run', null);
  const deadline = now() + timeoutMs;
  for (;;) {
    let row;
    try {
      ({ rows: [row] } = await pool.query(
        `SELECT status, termination, error FROM runs WHERE id = $1`, [childRunId]));
    } catch (err) {
      return fail('run_query_failed', { message: err?.message ?? String(err) });
    }
    if (!row) return fail('run_not_found', null);
    const { status } = row;
    if (status === 'finished' || status === 'failed') {
      const runError = row.error ?? null;
      const tReason = row.termination?.reason ?? runError?.code ?? null;
      const text = await collectRunFinalText(pool, childRunId);
      if (status === 'finished') {
        return { ok: true, text, termination: { reason: tReason ?? 'finished', error: null }, error: null };
      }
      // failed（含 cancelling 落到的终态失败）：不记 done，交执行器 failRun。
      return {
        ok: false, text,
        termination: { reason: tReason ?? 'run_failed', error: runError },
        error: runError?.message ? `${tReason ?? 'run_failed'}: ${runError.message}`
          : String(tReason ?? 'run_failed'),
      };
    }
    // 非终态（queued / running / cancelling）：超时则放弃（不重试），否则再等一拍。
    if (now() >= deadline) return fail('run_timeout', null);
    await sleep(pollMs);
  }
}

/**
 * 从 `run-review` 意图里取「该被审查的原 run id」。
 * 口径（写清，issue 要求⑤）：`run-review` 的 `anchor` 形如 `run:<id>`（见 macro-eval 的
 * `evalSilence`/W1 终态触发都按 `run:${run.id}` 造 anchor）。优先读 `evidence.runId`（若上游
 * 显式塞了），否则从 `anchor` 前缀 `run:` 解析。都拿不到 ⇒ null（`runMacroReview` 会把
 * `originalRunId=null` 传下去，由其工作包构建自行处理缺来源的情形）。
 */
export function extractReviewRunId(intent) {
  const fromEvidence = intent?.evidence?.runId;
  if (typeof fromEvidence === 'string' && fromEvidence) return fromEvidence;
  const anchor = String(intent?.anchor ?? '');
  if (anchor.startsWith('run:')) {
    const id = anchor.slice('run:'.length).trim();
    if (id) return id;
  }
  return null;
}

/** 到期意图的固定分派坐标（`macro-eval.js#evalExpiry` 产的：`criterion='tick'` + `bucket='expiry'`）。 */
export const EXPIRY_BUCKET = 'expiry';

/**
 * 是不是「到期」意图（issue #624）。
 *
 * ⚠ **为什么要在按 kind 分派**之前**拦一刀**：到期意图的 `templateKind` 是订阅原本的 kind
 *   （`run-notify` / `scheduled-task` / …），直接落到 kind 分支上会：
 *     - `scheduled-task` ⇒ **真的起一个 run**（到期只是不想再跑了，不是又要跑一次）；
 *     - `run-review` ⇒ 白起一次审查；
 *   到期是**生命周期的正常结束**，该做的只说一声 + 把账收成 `done`（**不是 `failed`**）。
 */
export function isExpiryIntent(intent) {
  return intent?.criterion === 'tick' && intent?.bucket === EXPIRY_BUCKET;
}

/** 到期通知的正文：说清「到什么时候了、已停用」，而不是通用的「触发（tick）」。 */
function expiryText(intent) {
  const name = intent?.templateName ?? '?';
  const until = intent?.evidence?.until;
  const untilText = until ? `到期时刻 ${until}` : '已到到期时刻';
  return {
    title: `宏「${name}」已到期`,
    body: intent?.evidence?.message ?? intent?.evidence?.body
      ?? `宏「${name}」${untilText}，订阅已自动停用（正常生命周期结束，不是失败）。`,
  };
}

/** 通知类意图的标题/正文（run-notify / run-silence-alert 共用）：优先用意图 evidence 里的文案。 */
function notifyText(intent) {
  const name = intent?.templateName ?? '?';
  const body = intent?.evidence?.message ?? intent?.evidence?.body
    ?? `宏「${name}」触发（${intent?.criterion ?? ''}）。`;
  return { title: `宏「${name}」`, body };
}

/**
 * 创建一个意图分发器。所有执行器都可注入（默认 = 生产实现），便于「桩执行器」单测。
 *
 * @param {{pool:object, config?:object, log?:object, reportsRoot?:string, sessionsHome?:string,
 *   runTask?:(ctx)=>Promise<object>, reviewRunner?:(arg)=>Promise<string>,
 *   executeScheduledIntent?:Function, runMacroReview?:Function, deliverIntent?:Function,
 *   now?:(()=>Date|Date)}} [deps]
 * @returns {{dispatch:(intents:object[])=>Promise<{dispatched:number,failed:number}>}}
 */
export function createIntentDispatcher({
  pool,
  config = {},
  log = console,
  reportsRoot, // 缺省 undefined ⇒ 由 executeScheduledIntent 按 config.userSpaceRoot + fde_name 现算（#637 ②）
  sessionsHome = os.homedir(),
  runTask,
  reviewRunner,
  executeScheduledIntent: execScheduled = executeScheduledIntent,
  runMacroReview: execReview = runMacroReview,
  deliverIntent: deliver = deliverIntent,
  now = () => new Date(),
} = {}) {
  const nowVal = () => (typeof now === 'function' ? now() : now);

  // 生产缺省 runTask（#637 ①）：**真实实现** = 轮询 run 到终态、收集判决与正文（过去是空壳桩 ⇒
  // 立刻返回空文本 + done，把失败伪装成完成、产物为空）。超时不重试（`06` §8）。
  const defaultRunTask = async (ctx) => pollRunTask(ctx);
  // 生产缺省 reviewRunner：没有模型适配器 ⇒ 明确抛错（dispatcher 会补 finish(failed)，不留 pending）。
  const defaultReviewRunner = async () => {
    throw new Error('未配置 reviewRunner（W4b 需要模型适配器；当前会落 failed 而非留 pending）');
  };

  /** 分派单条意图；抛异常由 `dispatch` 接住并收尾 failed。 */
  async function dispatchOne(intent) {
    const kind = intent?.templateKind;
    const macroRunId = intent?.macroRunId;
    if (!macroRunId) throw new Error('意图缺 macroRunId（无法收尾）');
    // 到期先于 kind 分派（#624）：否则 `scheduled-task` 的到期会真的再起一个 run。
    if (isExpiryIntent(intent)) {
      // 到期 = 正常结束 ⇒ `done`；说一声走同一个 `deliverIntent`（无消费者就没人知道它停了）。
      const { title, body } = expiryText(intent);
      await deliver(pool, intent, {
        recipients: intent.userId ? [intent.userId] : [],
        success: true, title, body, now: nowVal(),
      });
      await finishMacroRun(pool, { macroRunId, status: 'done' });
      return;
    }
    switch (kind) {
      case 'scheduled-task':
        // 执行器自收尾（done/failed 都它自己 finish）⇒ dispatcher 不再 finish。
        await execScheduled(pool, intent, {
          reportsRoot, sessionsHome, runTask: runTask ?? defaultRunTask, now: nowVal(), log, config,
        });
        return;
      case 'run-review':
        await execReview(pool, {
          macroRunId,
          originalRunId: extractReviewRunId(intent),
          reviewRunner: reviewRunner ?? defaultReviewRunner,
          now: nowVal(),
        });
        return;
      case 'run-notify':
      case 'run-silence-alert': {
        // ⚠ 收件人是**普通用户**（intent.userId），不是 admin：deliverIntent 自己会挡「全管理员」情形。
        const { title, body } = notifyText(intent);
        await deliver(pool, intent, {
          recipients: intent.userId ? [intent.userId] : [],
          success: true, title, body, now: nowVal(),
        });
        // deliverIntent 不碰账 ⇒ 由 dispatcher 收尾。
        await finishMacroRun(pool, { macroRunId, status: 'done' });
        return;
      }
      default:
        throw new Error(`未知 templateKind：${String(kind)}`);
    }
  }

  /** 收尾 failed；已是终态（409，重放）幂等吞掉，其余异常向上冒到 dispatch 的 catch 之外再兜一层。 */
  async function finishFailed(macroRunId, reason) {
    if (!macroRunId) return;
    try {
      await finishMacroRun(pool, { macroRunId, status: 'failed', reason });
    } catch (err) {
      if (err instanceof MacroError && err.httpStatus === 409) {
        log.info?.(`[macro-dispatch] 账已终态（重放），跳过失败收尾：${err.message}`);
        return;
      }
      log.warn?.(`[macro-dispatch] 失败收尾本身异常（id=${macroRunId}）：${err?.message ?? err}`);
    }
  }

  /**
   * 消费一批意图（`onIntents` 的实现）。逐条 try/catch：一条失败不影响其余条（要求③/判据4）。
   * @returns {Promise<{dispatched:number, failed:number}>}
   */
  async function dispatch(intents = []) {
    let dispatched = 0;
    let failed = 0;
    for (const intent of intents) {
      try {
        await dispatchOne(intent);
        dispatched += 1;
      } catch (err) {
        failed += 1;
        log.warn?.(`[macro-dispatch] 分派异常 kind=${intent?.templateKind} id=${intent?.macroRunId}：${err?.message ?? err}`);
        // 要求③：任何分派异常都要 finish(failed)，绝不留 pending（finishFailed 内部已吞 409）。
        await finishFailed(intent?.macroRunId, `dispatch_failed: ${err?.message ?? String(err)}`);
      }
    }
    return { dispatched, failed };
  }

  return { dispatch };
}

/**
 * 超时回收（要求④）：`status='pending'` 且 `started_at` 早于 `now - timeoutMs` 的行 ⇒ `failed`
 * （reason='dispatch_timeout'）。进程崩溃/在途丢失会让某些行永远留在 pending，这条清扫兜底。
 *
 * 逐条走 `finishMacroRun`（复用「终态不回退」等闸，语义与执行器一致），不裸 UPDATE。
 * 返回被回收的 id 数组（供日志/测试）。
 *
 * @param {{pool:object, timeoutMs?:number, now?:(()=>Date|Date), log?:object}} opts
 * @returns {Promise<{ids:string[]}>}
 */
export async function reclaimTimedOutPendingRuns({
  pool,
  timeoutMs = DISPATCH_TIMEOUT_MS,
  now = () => new Date(),
  log = console,
} = {}) {
  const nowVal = (typeof now === 'function' ? now() : now);
  const nowMs = nowVal instanceof Date ? nowVal.getTime() : Number(nowVal);
  const cutoff = new Date(nowMs - timeoutMs);
  const { rows } = await pool.query(
    `SELECT id FROM macro_runs
      WHERE status = 'pending' AND started_at < $1
      ORDER BY started_at ASC
      LIMIT 500`,
    [cutoff],
  );
  const ids = [];
  for (const r of rows) {
    try {
      await finishMacroRun(pool, { macroRunId: r.id, status: 'failed', reason: 'dispatch_timeout' });
      ids.push(r.id);
    } catch (err) {
      // 已被别的消费者收尾（409）或已消失 ⇒ 跳过，不算错。
      if (err instanceof MacroError && err.httpStatus === 409) continue;
      log.warn?.(`[macro-dispatch] 超时回收单条异常 id=${r.id}：${err?.message ?? err}`);
    }
  }
  if (ids.length) log.info?.(`[macro-dispatch] 超时回收 ${ids.length} 条 pending → failed`);
  return { ids };
}

/**
 * 超时回收循环：形状照 `startMacroEvalLoop` / W4a 的孤儿清扫——启动跑一次、此后每 `intervalMs` 一次，
 * `timer.unref()` 不拖进程退出，`stop()` 收尾。**独立于评估循环**（职责不同，要求④）。
 * @returns {{stop:()=>void, sweep:()=>Promise<{ids:string[]}>}}
 */
export function startPendingSweepLoop(pool, _config = {}, {
  log = console, intervalMs = SWEEP_INTERVAL_MS, timeoutMs = DISPATCH_TIMEOUT_MS, now = () => new Date(),
} = {}) {
  let stopped = false;
  const sweep = async () => {
    if (stopped) return { ids: [], stopped: true };
    try {
      return await reclaimTimedOutPendingRuns({ pool, timeoutMs, now, log });
    } catch (err) {
      // 整轮扫描失败（取行报错）⇒ 不崩，下轮再试。
      log.warn?.(`[macro-dispatch] 超时清扫整轮异常（下轮再试）：${err?.message ?? err}`);
      return { ids: [], roundError: err?.message };
    }
  };
  void sweep();
  const timer = setInterval(() => { void sweep(); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop() { stopped = true; clearInterval(timer); },
    sweep,
  };
}
