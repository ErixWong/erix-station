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
import path from 'node:path';
import { finishMacroRun, MacroError } from './macros.js';
import { executeScheduledIntent } from './macro-scheduled.js';
import { runMacroReview } from './macro-review.js';
import { deliverIntent } from './notifications.js';
import { fetchRunAssistantText } from './session-text.js';
// issue #662：审查 run 的真实实现需要——起只读审查会话（postMessage）+ 建快照（createSnapshot）。
import { postMessage as postMessageSession, validateRunCwd } from './sessions.js';
// #676：jail 宿主子目录的单一真值表（`resolveOriginalRepoDir` 的 projects 段从它取）。
import { jailHostDir } from '../shared/jail-mounts.js';
import { createSnapshot as createSnapshotDefault } from './macro-snapshot.js';

/** 超时回收阈值（要求④）：`pending` 且 `started_at` 早于 now-此值 ⇒ 判为「派发途中进程崩了」，落 failed。 */
export const DISPATCH_TIMEOUT_MS = 10 * 60_000;
/** 超时清扫循环的间隔（与评估循环**分开**起：职责不同，见 issue 要求④「别和评估循环合并」）。 */
export const SWEEP_INTERVAL_MS = 5 * 60_000;

/** runTask 真实实现等 run 到终态的**上限**（#637 ①）：超时 ⇒ `run_timeout`（不重试，`06` §8：时间意图会过期，补跑重复烧钱）。 */
export const RUN_TASK_TIMEOUT_MS = 30 * 60_000;
/** runTask 轮询 `runs.status` 的间隔。 */
export const RUN_TASK_POLL_MS = 2_000;

/**
 * 取该 run 的**最后一条 assistant 正文**（#637 ①；**#652 修正取数口径**）。
 *
 * ⚠ **#652 的根因**：本函数过去自己写 `SELECT … FROM transcript_rounds WHERE run_id = $1`，
 * 而那张表的 `run_id` **真机 97% 是 NULL**（实测 96/3219）——引擎 sidecar 走的是 session 维度
 * 写入（`transcript-store.js#appendRound`：`run_id = NULL` + `transcript_key = sessionId`），
 * 于是按 run_id 查恒返回 0 行 ⇒ 正文 `''` ⇒ **M7 产物 0 字节**。
 * 也不能读 `messages.content`：P3 PR②b 起 assistant **停双写**（该列对 assistant 恒为空串）。
 *
 * ⇒ 唯一正确口径 = **站内既有读侧投影**：`session-text.fetchRunAssistantText`（内部
 * `projectAnchors` + `loadTextContext`，按 `transcript_key = sessionId` 整会话读轮次、用官方
 * `projectTranscriptForDisplay` 展正文、再按 run 归属配回 assistant 锚点）——与
 * `GET /api/sessions/:id` 对话流（`session-view.assistantTurnText`）**同一口径**，不再自写 SQL。
 *
 * @param {object} pool
 * @param {{runId: string, sessionId?: string|null}} [arg] `sessionId` 缺省时回查**一次**
 *   `runs.session_id`（投影是 session 作用域的，没有 sessionId 无从下手；一次查询，不在轮询里循环）
 * @returns {Promise<string>} 取不到 ⇒ `''`（空产物的处置见 `macro-scheduled.js` 的产物口径注释）
 */
async function collectRunFinalText(pool, { runId, sessionId } = {}) {
  if (!runId) return '';
  try {
    let sid = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
    if (sid === null) {
      const res = await pool.query(`SELECT session_id FROM runs WHERE id = $1`, [runId]);
      const found = res.rows?.[0]?.session_id;
      sid = typeof found === 'string' && found !== '' ? found : null;
    }
    if (sid === null) return '';
    const hit = await fetchRunAssistantText(pool, { sessionId: sid, runId });
    return typeof hit?.text === 'string' ? hit.text : '';
  } catch {
    // 读正文失败不许改判 run 的终态（终态已经由 runs.status 定了）。
    return '';
  }
}

/**
 * runTask 的**生产真实实现**（#637 ①）：轮询 `runs.status` 直到终态（`finished` / `failed`，
 * `cancelling` 属非终态继续等它落到终态），把 `status` / `error` / 最后一条 assistant 正文收集起来。
 *
 * 返回 `{ ok: status === 'finished', text, termination: { reason, error }, error }`（额外带一个顶层
 * `error` 字符串，供 `executeScheduledIntent.failRun` 的 reason 可读）。超时 ⇒ `{ ok:false,
 * termination:{reason:'run_timeout'} }`。**不重试**（`06` §8）。超时/轮询/时钟/睡眠都可注入（测试用短超时）。
 *
 * @param {{pool:object, childRunId?:string, sessionId?:string|null, log?:object}} ctx 执行器传入的执行上下文
 *   （`sessionId` = 该 run 的会话；`executeScheduledIntent` 本来就传，缺省时 `collectRunFinalText`
 *   回查一次 `runs.session_id`——读侧投影是 **session 作用域**的，#652）
 * @param {{timeoutMs?:number, pollMs?:number, now?:()=>number, sleep?:(ms:number)=>Promise<void>}} [opts]
 */
export async function pollRunTask({ pool, childRunId, sessionId } = {}, {
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
      const text = await collectRunFinalText(pool, { runId: childRunId, sessionId });
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

// ── issue #662 C/D：审查 run 的真实执行体 ─────────────────────────────────────────

/** 审查 run 的缺省轮数上限（run-review kind schema 的 `max_rounds` default=8）。 */
export const DEFAULT_REVIEW_MAX_ROUNDS = 8;

/** 审查轮数归一：1..100（与 `macro-kinds` run-review.max_rounds 同口径）；非法 ⇒ 缺省 8。 */
function normalizeReviewMaxRounds(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : DEFAULT_REVIEW_MAX_ROUNDS;
}

/**
 * 取「原 run 的项目目录」（D）：`runs.session_id → chat_sessions.cwd`（**一次 JOIN**）。
 * cwd 存的是容器相对形式 `~/projects/<name>`；portal 对用户空间是 RW 挂载，真实路径
 * = `userSpaceRoot/<fde_name>/projects/<name>`（口径同 `macro-scheduled` 的 reportsRoot）。
 * 拿不到（无 run / 无会话 / 无 cwd）⇒ null；非 `~/projects/<name>` 形态（如绝对路径）⇒ 原样交出
 *（由快照自己因非 git 仓而失败并带回 reason）。
 * @returns {Promise<string|null>}
 */
export async function resolveOriginalRepoDir(pool, { originalRunId, config } = {}) {
  if (!originalRunId) return null;
  const res = await pool.query(
    `SELECT s.cwd, u.fde_name
       FROM runs r JOIN chat_sessions s ON s.id = r.session_id
       JOIN users u ON u.id = s.user_id
      WHERE r.id = $1`,
    [originalRunId],
  );
  const row = res.rows?.[0];
  const cwd = typeof row?.cwd === 'string' ? row.cwd : '';
  if (!cwd) return null;
  const m = /^~\/projects\/([^/]+)\/?$/.exec(cwd);
  if (!m) return cwd;
  const userSpaceRoot = config?.userSpaceRoot ?? '/srv/erix/users';
  // #676：projects 宿主目录取自 jail 单一真值表（与 provisioner / 校验器同一源，不三拄）。
  return path.join(jailHostDir(userSpaceRoot, row.fde_name ?? '', 'projects'), m[1]);
}

/**
 * 建一条**独立审查会话**（B：不复用宏会话，否则会把宏会话的 cwd 改掉）。cwd = 快照 worktree；
 * origin = `review:<macroRunId>`（可追溯）；title = `审查 · <原 run 短 id>`。会话用完不删
 *（历史留档），worktree 由 W4a 孤儿清扫回收（worktree_path 已落 macro_runs）。
 */
export async function createReviewSession(pool, { userId, cwd, originalRunId, macroRunId, config = {} } = {}) {
  const shortId = String(originalRunId ?? macroRunId ?? '').slice(0, 8);
  // #676 ①：审查会话的 cwd 也不能任意字符串——裸 INSERT 同样走越界校验器。
  // 绝对路径需要 fde_name + userSpaceRoot 才能判 jail 归属（从 userId 查 fde_name）。
  if (typeof cwd === 'string' && cwd.trim() !== '') {
    const fdeRes = await pool.query(`SELECT fde_name FROM users WHERE id = $1`, [userId]);
    validateRunCwd(cwd, { userSpaceRoot: config?.userSpaceRoot, fdeName: fdeRes.rows?.[0]?.fde_name ?? null });
  }
  const res = await pool.query(
    `INSERT INTO chat_sessions (user_id, cwd, title, title_source, origin)
     VALUES ($1, $2, $3, 'manual', $4)
     RETURNING id`,
    [userId, cwd, `审查 · ${shortId}`, `review:${macroRunId}`],
  );
  return res.rows?.[0]?.id ?? null;
}

/**
 * `defaultReviewRunner` 的真实实现（C）。就写在**本文件**（复用模块私有的 `pollRunTask`，
 * 不再多一道导出）：
 *   1. 建一条独立只读审查会话（cwd = 快照 worktree）；
 *   2. `postMessage({ content: brief, triggerKind:'synthetic', reviewOnly:true, cwd, maxRounds })`；
 *   3. 轮询到终态（**复用同文件的 `pollRunTask`**，走读侧投影取正文）；
 *   4. 返回正文；终态失败 ⇒ 抛错（`runMacroReview` 会归到 failed + unclassified，
 *      那是「没判成」而非「判成没过」）。
 * 所有外部件（postMessage / reviewTask / 轮询 opts）都可注入——测试不真调模型。
 */
export async function runReviewTaskDefault({
  pool, brief, macroRunId, originalRunId = null, snapshot,
  postMessage = postMessageSession, reviewTask = (ctx, opts) => pollRunTask(ctx, opts),
  pollOpts, log = console, maxRounds = DEFAULT_REVIEW_MAX_ROUNDS, config = {},
} = {}) {
  const acct = await pool.query(
    `SELECT a.user_id FROM macro_runs r JOIN macro_assignments a ON a.id = r.assignment_id WHERE r.id = $1`,
    [macroRunId],
  );
  const userId = acct.rows?.[0]?.user_id ?? null;
  const cwd = snapshot?.worktreePath ?? null;
  if (!userId) throw new Error('审查会话缺 userId（无法起只读审查 run）');
  if (!cwd) throw new Error('审查快照缺 worktreePath（cwd 无法指向隔离现场）');

  const sessionId = await createReviewSession(pool, { userId, cwd, originalRunId, macroRunId, config });
  const posted = await postMessage(pool, {
    userId, sessionId, content: brief, triggerKind: 'synthetic', cwd, reviewOnly: true, maxRounds, config,
  });
  const childRunId = posted?.run?.id ?? null;
  const res = await reviewTask({ pool, childRunId, sessionId }, pollOpts);
  if (!res?.ok) {
    const reason = res?.termination?.reason ?? 'unknown';
    throw new Error(`审查 run 未成功（${reason}）：${res?.error ?? ''}`);
  }
  return typeof res.text === 'string' ? res.text : '';
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
  // issue #662 D/B/C：快照与只读审查 run 的三个可注入件（缺省 = 生产实现）。
  createSnapshot = createSnapshotDefault,
  postMessage = postMessageSession,
  reviewTask = (ctx, opts) => pollRunTask(ctx, opts),
  reviewPollOpts,
  executeScheduledIntent: execScheduled = executeScheduledIntent,
  runMacroReview: execReview = runMacroReview,
  deliverIntent: deliver = deliverIntent,
  now = () => new Date(),
} = {}) {
  const nowVal = () => (typeof now === 'function' ? now() : now);

  // 生产缺省 runTask（#637 ①）：**真实实现** = 轮询 run 到终态、收集判决与正文（过去是空壳桩 ⇒
  // 立刻返回空文本 + done，把失败伪装成完成、产物为空）。超时不重试（`06` §8）。
  const defaultRunTask = async (ctx) => pollRunTask(ctx);
  // issue #662 C：缺省 reviewRunner 不再是「只会抛错的空壳」——在 run-review 分支里按「本次
  // 快照 + 轮数」现建 `runReviewTaskDefault`（起只读审查会话 + 复用 pollRunTask 取正文）。
  // 注入的 `reviewRunner` 优先（测试用桩）。

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
      case 'run-review': {
        // D：只在 run-review 分支建快照（run-notify 不建，快照有成本 ≤60s/≤500MB）。
        // 原 run 的项目目录 = runs.session_id → chat_sessions.cwd（一次查询）。
        const originalRunId = extractReviewRunId(intent);
        // issue #676 ②（丙 = 止血）：`reviewMode='disabled'`（缺省）⇒ **只出事实、不下判决**：
        //   不调 reviewRunner、不建快照、不解析判决；runMacroReview 落 skipped/review_unavailable、
        //   verdict NULL，并给用户发一条「审查暂未启用」通知。甲/乙（快照 / 活目录指纹）见 #673，
        //   定下来后把 reviewMode 改成 `'snapshot'` / `'live-fingerprint'` 走下面的真审查。
        const reviewMode = config?.reviewMode ?? 'disabled';
        if (reviewMode === 'disabled') {
          await execReview(pool, {
            macroRunId,
            originalRunId,
            userId: intent?.userId ?? null,
            reviewUnavailable: true,
            now: nowVal(),
          });
          return;
        }
        // —— 真审查路径（甲 = 快照；乙 = 活目录指纹待接）——
        const repoDir = await resolveOriginalRepoDir(pool, { originalRunId, config });
        const snapshot = repoDir
          ? await createSnapshot({ repoDir })
          : { ok: false, reason: 'worktree_add_failed' };
        // worktree_path / snapshot_id 落 macro_runs ⇒ W4a 孤儿清扫据 worktree_path 关联到账，
        //   只在「终态>1h / running>1h」才回收（不写的话清扫会把在途审查的 worktree 也当孤儿删）。
        if (snapshot?.ok) {
          await pool.query(
            `UPDATE macro_runs SET worktree_path = $2, snapshot_id = $3 WHERE id = $1`,
            [macroRunId, snapshot.worktreePath, snapshot.snapshotId ?? null],
          );
        }
        // 快照失败（ok:false）**原样传下去**，让 runMacroReview 走它已实现的失败出口
        //（status=failed / verdict=unclassified / 不回灌）——**这里不自己吞**。
        const runner = reviewRunner
          ?? ((ctx) => runReviewTaskDefault({
            pool, brief: ctx.brief, macroRunId: ctx.macroRunId, originalRunId, snapshot,
            maxRounds: normalizeReviewMaxRounds(intent?.params?.max_rounds),
            postMessage, reviewTask, pollOpts: reviewPollOpts, log, config,
          }));
        await execReview(pool, {
          macroRunId,
          originalRunId,
          snapshot,
          reviewRunner: runner,
          now: nowVal(),
        });
        return;
      }
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
