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
import { executeScheduledIntent, defaultReportsRoot } from './macro-scheduled.js';
import { runMacroReview } from './macro-review.js';
import { deliverIntent } from './notifications.js';

/** 超时回收阈值（要求④）：`pending` 且 `started_at` 早于 now-此值 ⇒ 判为「派发途中进程崩了」，落 failed。 */
export const DISPATCH_TIMEOUT_MS = 10 * 60_000;
/** 超时清扫循环的间隔（与评估循环**分开**起：职责不同，见 issue 要求④「别和评估循环合并」）。 */
export const SWEEP_INTERVAL_MS = 5 * 60_000;

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
  reportsRoot = defaultReportsRoot(),
  sessionsHome = os.homedir(),
  runTask,
  reviewRunner,
  executeScheduledIntent: execScheduled = executeScheduledIntent,
  runMacroReview: execReview = runMacroReview,
  deliverIntent: deliver = deliverIntent,
  now = () => new Date(),
} = {}) {
  const nowVal = () => (typeof now === 'function' ? now() : now);

  // 生产缺省 runTask：没有进程内模型适配器时，W7 已经通过 postMessage 把 run 入队（真起了 run），
  // 这里只做「已入队」的诚实收口（不谎报产物）。真实模型驱动由调用方注入 runTask 覆盖。
  const defaultRunTask = async ({ childRunId }) => ({ ok: true, text: '', childRunId });
  // 生产缺省 reviewRunner：没有模型适配器 ⇒ 明确抛错（dispatcher 会补 finish(failed)，不留 pending）。
  const defaultReviewRunner = async () => {
    throw new Error('未配置 reviewRunner（W4b 需要模型适配器；当前会落 failed 而非留 pending）');
  };

  /** 分派单条意图；抛异常由 `dispatch` 接住并收尾 failed。 */
  async function dispatchOne(intent) {
    const kind = intent?.templateKind;
    const macroRunId = intent?.macroRunId;
    if (!macroRunId) throw new Error('意图缺 macroRunId（无法收尾）');
    switch (kind) {
      case 'scheduled-task':
        // 执行器自收尾（done/failed 都它自己 finish）⇒ dispatcher 不再 finish。
        await execScheduled(pool, intent, {
          reportsRoot, sessionsHome, runTask: runTask ?? defaultRunTask, now: nowVal(), log,
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
