// issue delegation P1（2026-11-08）——`delegate` 工具的宿主装配（子 run = **同进程嵌套的第二个
// `runToolLoop`**，不是本站 `runs` 表的一行）。
//
// 依据：`docs/design/delegation-2026-11-08.md` §2（引擎事实清单，已逐条验证，本文件不重新推导）
// 与 `P1-WORKORDER.md` §2。库侧边界（`erix-agent` 0.31.0 `src/tools/delegation/tool.js`）：
//   · 库不 fork / 不 spawn / 不 import child_process —— **子 run 怎么跑起来归宿主**（`runChild`）；
//   · 父身份 `parentRunId` 由库从执行上下文 `context.runId` 自取，模型不可填（`tool.js:330`）；
//   · `termination` 只认**字符串**，给对象一律落 `failed`（`tool.js:94-98`）；
//   · `TERMINATION_TO_STATE` 表外一律 `failed`（`tool.js:67-79`）⇒ 本站判「正常收尾」的
//     `no_tool` / `continuation_exhausted` 必须**在交给库之前**归一成 `end_turn`（见下）；
//   · `deadlineMs` 给宿主的是**时长**，而引擎 `config.timing.deadlineMs` 要**绝对时刻**
//     （`tool.js:405` vs `orchestrator.js:2059-2062`）⇒ 换算只发生在 `runChild` 这一处；
//   · 前台子的 `cancel` 恒 `not_owned`（`owned` 只登记后台分支，`tool.js:455`/`:547`），库自己的
//     `AbortController` 不接外层 ⇒ **中止只能由宿主把父 signal 串到子的 signal 上**；
//   · `transcriptPathFor` 的返回值必须由宿主提供（库不猜路径），且必须与引擎文件 store 的
//     命名口径一致（`<dir>/<safeRunId(runId)>.jsonl`；`sub-<uuid>` 过 `safeRunId` 恒等）。
//
// 三条本站裁决（不是引擎要求，是决策者定的形状，改之前先读工单）：
//   ① **子的工具面 = 文件工具 + shell 两个实例的 schemas**，显式给出而不是从父数组里 filter：
//      不含 `delegate`（v1 不递归）、不含 `note_*`（父子共用 `scopeRef=sessionId` 的同一批笔记，
//      而引擎的 single-writer 约定靠 `runs_one_active_per_session` 唯一索引兜底——同进程嵌套的两个
//      loop 它管不到，见 `runner/worker.js` 的 notes 注释）、不含 skills 工具。
//      并且**复用父的 executor 实例**（`executeTool` 就是父那一个）⇒ 沙箱 jail 只有一个。
//   ② **子有自己那段短 system prompt**，不复用父的 `SYSTEM_PROMPT`（父那段写着 delegate 用法、
//      AGENTS.md 注入、预览端口规则，对子全是噪音，还会诱导它去调自己没有的工具）。
//   ③ **子的 usage 并进父的 `RUN_FINISHED.usage`**，不另发 ledger（`usage_ledger_run_source_key
//      UNIQUE (run_id, source)` + `ON CONFLICT DO NOTHING`，第二行会被静默吞掉）。
import path from 'node:path';

import { createFileTranscriptStore, runToolLoop } from 'erix-agent';
import { createDelegateTool } from 'erix-agent/tools';

/** 缺省子 run 轮数预算（env `ERIX_DELEGATE_CHILD_ROUNDS` 覆盖）。 */
export const DEFAULT_CHILD_MAX_ROUNDS = 8;
/** 缺省子 run 时间预算（env `ERIX_DELEGATE_CHILD_TIMEOUT_MS`；必须 < 300s 的 agentd watchdog）。 */
export const DEFAULT_CHILD_DEADLINE_MS = 240_000;
/** 缺省每 FDE 子 run 并发上限（env `ERIX_DELEGATE_MAX`；租约目录每 FDE 共享 ⇒ 跨进程生效）。 */
export const DEFAULT_MAX_CONCURRENT = 2;
/** 子 run 保活的最小间隔（同一子 15s 内只上一次心跳）。 */
export const LIVENESS_MIN_INTERVAL_MS = 15_000;

/** usage 里会被累加的字段（引擎口径：`cacheRead`/`cacheWrite` 只在来源报过时才出现）。 */
const USAGE_FIELDS = Object.freeze(['input_tokens', 'output_tokens', 'cacheRead', 'cacheWrite']);

/**
 * 本站判「正常收尾」、但引擎映射表里落 `failed` 的 reason（`tool.js:67-79` 表外一律 failed）。
 * 分级依据：`portal/frontend/src/lib/terminationReasons.ts` 的 FAIL 集合**不含**这两个（灰不是红），
 * 而名册 state 只有 7 个取值、没有「灰」这一档 ⇒ 在交给库之前归一成 `end_turn`（**不改库、不自造新词**）。
 * 原始 reason 只进日志，不进名册（库的 `finishRun` 只搬白名单键，多余的键根本落不了盘）。
 */
export const STATION_OK_BUT_ENGINE_FAILED = Object.freeze(['no_tool', 'continuation_exhausted']);

/** 子 run 的 system prompt（裁决 ②）。刻意短，且明说「没有 delegate 工具」。 */
export const CHILD_SYSTEM_PROMPT = [
      '你是由父 run 派出的**子 run**：只做被交给你的这一件事，做完就汇报。',
      '可用工具只有文件工具（readFile / searchText / tree / edit / writeFile）与 shell。',
      '你**没有** delegate 工具，不要再派生子 run；也**没有**笔记工具（父子共用同一批笔记，并发写会互踩）。',
      '工作目录是父 run 交给你的目录；只在其中做读与写，不要试图越界。',
      '完成后用一段话给出结论与关键证据（文件路径、行号、命令输出摘要）——父 run 只看得到这段文本，看不到你的过程。',
].join('\n');

/** 取 termination 的 reason 字符串（引擎给的是对象 `{ reason, ... }`，库只认字符串）。 */
export function terminationReasonOf(termination) {
  if (typeof termination === 'string') return termination === '' ? undefined : termination;
  const reason = termination?.reason;
  return typeof reason === 'string' && reason !== '' ? reason : undefined;
}

/**
 * 引擎 reason → **交给库的** reason（本站的归一，工单 §2.3）。
 * · `no_tool` / `continuation_exhausted` → `end_turn`（本站当正常收尾，名册要落 `completed`）；
 * · 其余原样透传（`end_turn` / `judge_done` / `aborted` / `max_rounds_cap` / `stall` / `failed` /
 *   `persistence_failed` / `final_guard_unverified` …）；
 * · 拿不到 reason → `undefined`（让库按「没给 termination」处理，不自己发明词）。
 */
export function normalizeChildTermination(termination) {
  const reason = terminationReasonOf(termination);
  if (reason === undefined) return undefined;
  return STATION_OK_BUT_ENGINE_FAILED.includes(reason) ? 'end_turn' : reason;
}

/**
 * usage 逐字段相加，返回**新对象**（绝不原地改：引擎的 usage 对象身份是契约，见
 * `orchestrator.js:1247` 的注释）。
 * 口径：`input_tokens` / `output_tokens` 恒在（缺字段按 0）；`cacheRead` / `cacheWrite`
 * **只在任一侧真的出现过时才出现**（两边都没报过就不要写出一个假的 0）。
 */
export function mergeUsage(base, extra) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const merged = {
    input_tokens: num(base?.input_tokens) + num(extra?.input_tokens),
    output_tokens: num(base?.output_tokens) + num(extra?.output_tokens),
  };
  for (const key of ['cacheRead', 'cacheWrite']) {
    if (Number.isFinite(Number(base?.[key])) || Number.isFinite(Number(extra?.[key]))) {
      merged[key] = num(base?.[key]) + num(extra?.[key]);
    }
  }
  return merged;
}

/**
 * 保活节流（工单 §5 判据 10）：同一个子 run 在 `intervalMs` 内只回调一次。
 * 去掉节流 ⇒ 每个引擎事件上一次心跳（一轮几十个事件 ⇒ IPC 洪水）；去掉保活 ⇒ 子 run 执行期
 * 父 worker 零 IPC ⇒ agentd 的 F6 watchdog（默认 300s）会把真在跑的子当死循环误杀。两个方向各红一次。
 */
export function createLivenessThrottle({ onEvent, intervalMs = LIVENESS_MIN_INTERVAL_MS, clock = () => Date.now() } = {}) {
  const lastAt = new Map();
  return (childRunId) => {
    const now = clock();
    const prev = lastAt.get(childRunId);
    if (prev !== undefined && now - prev < intervalMs) return false;
    lastAt.set(childRunId, now);
    try {
      onEvent?.(childRunId);
    } catch {
      // 心跳是加分项：观察者抛错绝不打死子 run（引擎观察者的通用口径）。
    }
    return true;
  };
}

/**
 * 存活谓词（照 `bin/delegation.js:83-101` 的语义，逐条不许改）：
 * `kill(pid,0)` 成功 ⇒ 活；`EPERM` ⇒ 活（存在但没权限发信号）；`ESRCH` ⇒ 死；
 * **其它错误码 ⇒ 算活**（库拿这个谓词写 `interrupted`，只有「确知没这个进程」才允许说死）。
 */
export function isProcessAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    return true;
  }
}

/** 串中止：父 signal 或库给的 signal 任一 aborted ⇒ 子的 signal aborted。 */
function combineSignals(signals) {
  const list = signals.filter((s) => s !== undefined && s !== null);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  // Node < 22 兜底（本站 engines >= 22，正常走不到）：手工桥接。
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * 装配本站的 `delegate` 工具。
 *
 * @param {Object} o
 * @param {string} o.parentRunId        **本站真 runId**（不是 transcriptKey/sessionId，工单 §5-1）
 * @param {string} o.parentCwd          子 run 的缺省工作目录（= 父的 cwd）
 * @param {string} o.delegationDir      `<home>/delegation`（由 agentd 下行 `delegation_dir`，
 *                                      **不要**在这里从 `process.env.HOME` 自己拼 ⇒ 路径只有一个真相源）
 * @param {Object} o.provider           父的 provider 实例（同一凭据 / 超时口径）
 * @param {Array} o.childTools          子的工具面（裁决 ①：文件工具 + shell 的 schemas，显式给出）
 * @param {Function} o.executeTool      父的 executeTool（子的 file/shell 执行走**同一个**实例 ⇒ 同一个 jail）
 * @param {string} [o.childSystemPrompt] 子的 system prompt（缺省 `CHILD_SYSTEM_PROMPT`）
 * @param {Object} [o.modelMetadata]    与父同源（`config.metadata.modelMetadata`）
 * @param {number} [o.maxTokens]        与父同源（`config.tuning.maxTokens`）
 * @param {number} [o.childMaxRounds]   子轮数预算
 * @param {number} [o.childDeadlineMs]  子时间预算（**时长**）
 * @param {number} [o.maxConcurrent]    并发上限（跨进程共享 `leaseDir`）
 * @param {AbortSignal} [o.parentSignal] 父 run 的 abort signal（中止级联的唯一通路）
 * @param {(childRunId: string) => void} [o.onChildLiveness] 保活出口（内部节流 ≥ `livenessIntervalMs`）
 * @param {(level: string, msg: string, fields?: Object) => void} [o.logger]
 * @param {() => number} [o.clock]      可注入时钟（判据 9 要注入定值）
 * @param {number} [o.livenessIntervalMs]
 */
export function createStationDelegation(o = {}) {
  const {
    parentRunId, parentCwd, delegationDir,
    provider, childTools, executeTool, childSystemPrompt = CHILD_SYSTEM_PROMPT,
    modelMetadata, maxTokens,
    childMaxRounds = DEFAULT_CHILD_MAX_ROUNDS,
    childDeadlineMs = DEFAULT_CHILD_DEADLINE_MS,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    parentSignal, onChildLiveness, logger = () => {},
    clock = () => Date.now(),
    livenessIntervalMs = LIVENESS_MIN_INTERVAL_MS,
  } = o;

  if (typeof parentRunId !== 'string' || parentRunId === '') {
    throw new TypeError('delegation: parentRunId 必须是本站真 runId（非空字符串）');
  }
  if (typeof delegationDir !== 'string' || delegationDir === '') {
    throw new TypeError('delegation: delegationDir 必须是 agentd 下行的 delegation_dir（非空字符串）');
  }
  if (!Array.isArray(childTools)) {
    throw new TypeError('delegation: childTools 必须由调用方显式给出（文件工具 + shell 的 schemas 数组）');
  }

  // §3 落盘布局（唯一真相，门户 P2 按同一布局读）：roster 按父 run 分片、leases 每 FDE 共享、
  // transcripts 扁平按子 runId。
  const rosterDir = path.join(delegationDir, 'roster', parentRunId);
  const leaseDir = path.join(delegationDir, 'leases');
  const transcriptsDir = path.join(delegationDir, 'transcripts');
  const childStore = createFileTranscriptStore({ dir: transcriptsDir });

  /** 子的 usage 累加器（`takeChildUsage()` 取走并清零；worker 把它并进 `RUN_FINISHED.usage`）。 */
  let childUsage = { input_tokens: 0, output_tokens: 0 };
  const childToolNames = new Set(childTools.map((t) => t?.name).filter((n) => typeof n === 'string'));

  const notifyLiveness = createLivenessThrottle({
    intervalMs: livenessIntervalMs,
    clock,
    onEvent: (childRunId) => {
      try {
        onChildLiveness?.(childRunId);
      } catch (err) {
        logger('warn', 'delegate liveness send failed', { childRunId, err: String(err?.message ?? err) });
      }
    },
  });

  /** 宿主登记的子账本位置（引擎文件 store 的命名口径；`sub-<uuid>` 过 `safeRunId` 恒等）。 */
  const transcriptPathFor = (runId) => path.join(transcriptsDir, `${runId}.jsonl`);

  /** 子的实际工作目录：没给就用父的（P1 不做子独立 cwd 校验，越界由 jail 在工具层拒）。 */
  const cwdFor = (requested) => path.resolve(requested ?? parentCwd ?? process.cwd());

  function accumulateUsage(usage) {
    for (const key of USAGE_FIELDS) {
      const value = Number(usage?.[key]);
      if (Number.isFinite(value) && value !== 0) {
        childUsage[key] = (Number(childUsage[key]) || 0) + value;
      }
    }
  }

  /**
   * 子 run 怎么跑（库的唯一注入点）。**必须把抛错归一成正常返回**：abort / 轮数耗尽 / 超时是
   * 「子 run 的结局」，不是宿主的异常——上抛会让库写 `state=failed` + `errorMessage`，而父 run
   * 不该因为子怎么结束而失败。
   */
  async function runChild(request) {
    const childRunId = request.runId;
    const childCwd = cwdFor(request.cwd);
    const budgetMs = Number.isFinite(request.deadlineMs) && request.deadlineMs > 0
      ? request.deadlineMs
      : childDeadlineMs;
    const signal = combineSignals([request.signal, parentSignal]);

    try {
      const result = await runToolLoop({
        provider,
        tools: childTools,
        executeTool,
        store: childStore,
        ...(signal ? { signal } : {}),
        config: {
          input: {
            system: childSystemPrompt,
            initialUserMessage: typeof request.task === 'string' ? request.task : String(request.task ?? ''),
            wrapup: false,
          },
          run: {
            runId: childRunId,
            parentRunId,
            cwd: childCwd,
            maxRounds: childMaxRounds,
            stream: true,
            // 与父同口径（issue #288 缺陷 C）：崩溃恢复时不盲目重放挂起工具。
            replayPolicy: 'per-tool-declaration',
            // 子 run 不跑反思/judge（省一次主力模型调用，也让终局词汇收敛）。
            reflection: false,
            completion: false,
          },
          ...(modelMetadata || maxTokens
            ? {
              metadata: {
                task: request.task,
                ...(modelMetadata ? { modelMetadata } : {}),
              },
              tuning: { ...(maxTokens ? { maxTokens } : {}) },
            }
            : {}),
          folding: { context: { strategy: 'fold-llm', keepRounds: 6 } },
          // ⚠ **绝对时刻**：库里那个 `deadlineMs` 是时长（名册的 `deadlineAt = now + deadlineMs`），
          // 引擎读的是 epoch 毫秒 ⇒ 换算只在这一处（工单 §5 判据 9）。
          timing: { deadlineMs: clock() + budgetMs },
        },
        // 只保活，**不转发事件**（子的对话不进父的事件流；P2 从子的账本文件读）。
        onEvent: () => notifyLiveness(childRunId),
      });

      const rawReason = terminationReasonOf(result?.termination);
      const reason = normalizeChildTermination(result?.termination);
      if (rawReason !== undefined && rawReason !== reason) {
        // 原始 reason 只进日志：库的 `finishRun` 只搬白名单键，多余的键根本落不了盘（工单更正）。
        logger('info', 'delegate child finished', {
          childRunId, reason: rawReason, normalized: reason, state: 'completed',
        });
      }
      accumulateUsage(result?.usage);
      return {
        text: typeof result?.finalText === 'string' ? result.finalText : '',
        termination: reason,
        verification: result?.verification,
        usage: result?.usage,
        rounds: result?.rounds,
      };
    } catch (err) {
      const rawReason = terminationReasonOf(err?.termination);
      const reason = normalizeChildTermination(err?.termination) ?? 'failed';
      accumulateUsage(err?.usage);
      logger('warn', 'delegate child finished', {
        childRunId, reason: rawReason ?? 'threw', normalized: reason,
        err: String(err?.message ?? err),
      });
      return {
        text: typeof err?.finalText === 'string' ? err.finalText : '',
        termination: reason,
        error: String(err?.message ?? err),
      };
    }
  }

  const tool = createDelegateTool({
    runChild,
    rosterDir,
    leaseDir,
    maxConcurrent,
    transcriptPathFor,
    cwdFor,
    isProcessAlive,
    clock,
    // P1 不投递（§4.4）：后台子 run 完成只记一行日志，父 run 自己 `action=result` 去取。
    notifyParent: (text) => logger('warn', 'delegate child finished', { parentRunId, notification: text }),
  });

  return {
    definition: tool.definition,
    /** 名字集合（判据 8 用；子的工具面里不该有 delegate / note_* / skills）。 */
    childToolNames,
    rosterDir,
    leaseDir,
    transcriptsDir,
    transcriptPathFor,
    execute: (input, context) => tool.execute(input, context ?? {}),
    /** 取走并清零子的 usage（worker 在 `RUN_FINISHED` 之前调一次）。 */
    takeChildUsage() {
      const taken = childUsage;
      childUsage = { input_tokens: 0, output_tokens: 0 };
      return taken;
    },
    /**
     * 库没有 `release`/`dispose` 口（`capacity.release` 在每次终态写里自己还槽，工具实例本身
     * 只有 `definition` / `execute`）⇒ 本方法是空实现，只清保活水位，给将来留一个接点。
     */
    dispose() {
      childUsage = { input_tokens: 0, output_tokens: 0 };
    },
  };
}
