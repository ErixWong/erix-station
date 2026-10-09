#!/usr/bin/env node
// station-runner worker：每 run 一个子进程，跑 erix-agent runToolLoop。
// 依据：docs/design/runner-integration.md §3/§5/§6.3/§9/§11。
//
// 关键约束：
//   - 无任何平台凭据（fork 时 env 已剔除 ERIX_STATION_TOKEN，§11）；
//   - 全部平台网络 IO 经 IPC `store_request` → agentd（agentd 加 Authorization + X-Claim-Token 转发，§9.1）；
//   - 事件经 IPC `event` 逐条回 agentd 批量上报（§5/§7）；
//   - provider 用 erix-agent `createJsonFileModelConfigProvider`（config.json 内占位 key + endpoint，零真实 LLM 凭据，§6.3）；
//   - 终态由 agentd 经 U2 上报（worker 只回 run_finished，不发 run_end 事件，§7.6）。

// user-space §6.2：umask 0002（新建文件 664/目录 775）——worker/agent 写项目目录与 spool 的文件
// 需跨 UID（1002↔1001/1000，同 GID 1000）组可写；fork 时已从 agentd/entrypoint 继承（entrypoint.sh
// 早有 umask 0002，本处为防御性重设，评审 F8）。
process.umask(0o002);

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createJsonFileModelConfigProvider,
  createOpenAIProvider,
  runToolLoop,
} from 'erix-agent';
import { createToolRegistry } from 'erix-agent/tools';
import { MSG, createReqIdGenerator, sendIpc, lastSendError } from './lib/ipc.js';
import { parseMaxRounds } from './lib/config.js';
import { resolveRunModel } from './lib/llm-models.js';
import { createJail, createStationFileTools } from './lib/file-tools.js';
import { createShellTools } from './lib/shell-tools.js';
import { createNotesTools } from './lib/notes-tools.js';
import { makeStore } from './lib/store.js';
import { planTranscriptSeed, buildEngineSeedOptions } from './lib/transcript-seed.js';
import { generateSessionTitle, resolveFirstUserContent } from './lib/session-title.js';
import { buildFailureEnvelope } from './lib/termination.js';

// issue #64（R2）：system prompt 为 runToolLoop 合法顶层选项（erix-llm-kit
// docs/host-consumer-contract.md §runToolLoop options 白名单含 system）——
// 约束真模型收尾行为：交付物落盘、回复只写简短摘要、不贴代码全文。
const SYSTEM_PROMPT = `你是运行在 FDE 工作台容器中的编码 agent，工作目录是项目目录 \`~/projects/<project>\`（本次 run 直接在此工作，交付物留在项目目录内）。

交付规则：
1. 交付物（代码/配置/文档）必须用 writeFile 写入工作目录的文件系统——磁盘上的文件才是交付物。
2. 修改既有文件前先 readFile 看现状，不要凭空整文件覆写。
3. 收尾回复只写简短摘要：做了什么、写入/修改了哪些文件、如何运行与验证；不要在回复里粘贴代码全文或大段文件内容。
4. 若任务只是问答或解释、不产生交付物，直接回答即可，无需写文件。
5. 交付前尽量用 shell 工具运行验证命令（构建/测试/lint），跑通再交付；命令在容器内执行，不要改动项目目录之外的状态。
6. 始终使用用户消息所用的语言进行回复与会话摘要；用户消息是英文就用英文，中文就用中文。`;

const nextReqId = createReqIdGenerator();
let runStart = null;

// ---------------------------------------------------------------------------
// IPC 基础
// ---------------------------------------------------------------------------
const pendingStore = new Map(); // req_id -> {resolve, reject}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case MSG.RUN_START:
      startRun(msg);
      break;
    case MSG.STORE_RESPONSE: {
      const p = pendingStore.get(msg.req_id);
      if (p) {
        pendingStore.delete(msg.req_id);
        if (msg.ok) p.resolve(msg.result);
        else {
          const err = new Error(msg.error?.message ?? 'store error');
          err.code = msg.error?.code ?? 'store_error';
          err.retryable = msg.error?.retryable === true;
          p.reject(err);
        }
      }
      break;
    }
    case MSG.ABORT:
      if (abortController) abortController.abort();
      break;
    case MSG.APPROVAL_DECISION: {
      const p = pendingApproval.get(msg.req_id);
      if (p) {
        pendingApproval.delete(msg.req_id);
        p.resolve(msg.decision === 'approved' ? 'approved' : 'denied');
      }
      break;
    }
    default:
      break;
  }
});

function ipcRequest(type, payload) {
  return new Promise((resolve, reject) => {
    const reqId = nextReqId();
    pendingStore.set(reqId, { resolve, reject });
    const ok = sendIpc(process, { type, req_id: reqId, ...payload });
    if (!ok) {
      pendingStore.delete(reqId);
      reject(Object.assign(new Error(`ipc send failed: ${lastSendError ?? 'channel closed'}`), { code: 'ipc_closed', retryable: true }));
    }
  });
}

// ---------------------------------------------------------------------------
// 事件桥接（§5/§7.3：client_event_id = run_id:attempt:计数）
// ---------------------------------------------------------------------------
let eventCounter = 0;
let runId = null;
let attempt = 1;
let abortController = null;
const pendingApproval = new Map();

function makeEvent(type, payload) {
  return {
    client_event_id: `${runId}:${attempt}:${eventCounter++}`,
    type,
    ts: new Date().toISOString(),
    payload,
  };
}

let droppedEventCount = 0;

function emitEvent(type, payload) {
  // F7：sendIpc false = 通道关闭/背压丢消息——不能静默丢：计数 + stderr 告警
  // （通道已关时 LOG IPC 也发不出，只能写 stderr，agentd 会透传到自己的 stdout）。
  const ok = sendIpc(process, { type: MSG.EVENT, run_id: runId, event: makeEvent(type, payload) });
  if (!ok) {
    droppedEventCount += 1;
    // eslint-disable-next-line no-console
    console.error(`[worker] ipc send failed, event dropped (total=${droppedEventCount}, type=${type})`);
  }
}

function loopEventPayload(event) {
  switch (event?.type) {
    case 'round_start':
      return { round: event.round };
    case 'attempt':
      return { round: event.round, attempt: event.attempt, maxAttempts: event.maxAttempts };
    case 'recovering':
      return { round: event.round, attempt: event.attempt, maxAttempts: event.maxAttempts };
    case 'recovered':
      return { round: event.round, attempt: event.attempt };
    case 'usage':
      return { round: event.round, usage: event.usage };
    case 'tool_use':
      return {
        tool_call_id: event.toolUse?.id ?? null,
        round: event.round,
        name: event.toolUse?.name ?? null,
        input: event.toolUse?.input ?? {},
      };
    case 'tool_result': {
      const tr = event.toolResult ?? {};
      return {
        tool_call_id: tr.tool_use_id ?? null,
        round: event.round,
        name: null,
        result_digest: String(tr.content ?? '').slice(0, 500),
        duration_ms: Number.isFinite(tr.duration) ? tr.duration : null,
        ok: tr.is_error !== true,
      };
    }
    case 'round_end':
      return {
        round: event.round,
        final_text: event.finalText ?? '',
        stop_reason: event.stopReason ?? null,
        usage: event.usage ?? null,
      };
    default:
      return event ?? {};
  }
}

// ---------------------------------------------------------------------------
// run 主流程（§6.3 组装 runToolLoop 参数）
// ---------------------------------------------------------------------------
/**
 * 确保项目目录是 git 仓库（issue #84 P5 配套，2026-09-24 用户要求强制）：
 * cwd/.git 不存在 → git init -b main（以 worker 身份跑，属主天然正确；幂等；失败仅 warn 不阻断）。
 * 动机：①产物快照对所有项目走 diff 模式（只拍变化，天然小）；②用户 git 自治的基线。
 * 已是仓库（含 clone 来的）→ 零操作。execFileSync 导入自 child_process 的 spawnSync 不依赖 PATH 外组件。
 */
function ensureGitRepo(cwd, log2) {
  if (fs.existsSync(path.join(cwd, '.git'))) return;
  const r = spawnSync('git', ['init', '-b', 'main'], { cwd, timeout: 10_000, stdio: 'ignore' });
  if (r.error || r.status !== 0) {
    sendIpc(process, {
      type: MSG.LOG, run_id: runId, level: 'warn',
      msg: `git init failed (continuing without repo): ${String(r.error?.message ?? `exit ${r.status}`)}`,
    });
    return;
  }
  sendIpc(process, { type: MSG.LOG, run_id: runId, level: 'info', msg: `git init -b main in project dir (was not a repo)` });
}

async function startRun(msg) {
  runStart = msg;
  runId = msg.run_id;
  attempt = Number(msg.attempt ?? 1);
  abortController = new AbortController();

  const { task, cwd } = msg;
  const modelConfigPath = msg.config?.model_config_path || '/home/erix/.erix/config.json';

  // issue #81 P2（conversation-state.md §4.1）：transcript key = sessionId（引擎 runToolLoop 的
  // store key），runId 退回纯运维身份（事件流/IPC）。store adapter 双身份：engine 面 key=sessionId，
  // U2 'running' 面真 runId（makeStore 第二参，见 store.js 头注释）。旧 ticket 无 session_id →
  // 回退 runId（旧 portal 兼容，agentd 侧走 run 作用域旧端点）。
  const sessionId = typeof msg.session_id === 'string' && msg.session_id.length > 0 ? msg.session_id : null;
  const messageId = typeof msg.message_id === 'string' && msg.message_id.length > 0 ? msg.message_id : null;
  const transcriptKey = sessionId ?? runId;
  const store = makeStore(transcriptKey, {
    request: (method, args) => ipcRequest(MSG.STORE_REQUEST, { method, args }),
    runId,
  });

  // 1) provider（§6.3-1：config.json 占位 key + endpoint；真实 key 由 Traefik 注入）。
  const modelProvider = createJsonFileModelConfigProvider({ path: modelConfigPath });
  const defaultCfg = await modelProvider.resolve('default');
  // issue #38 Phase B2：RUN_START 带下行模型集（run 边界生效的快照）→ 请求体 model 字段用下行真模型名；
  // 旧 agentd / 无配置（msg 无 models）→ 占位 config 的 model 名（现状行为）。endpoint/key 始终走占位文件。
  // models 只经 IPC 内存传递，**不写任何文件/日志**。
  const modelName = resolveRunModel(defaultCfg.model, msg.models);
  const provider = createOpenAIProvider({
    endpoint: defaultCfg.endpoint,
    apiKey: defaultCfg.apiKey,
    model: modelName,
  });

  // 3) tools（§6.3-3：jail + 文件工具（issue #228 起 = 上游 erix-agent createFileTools 的薄装配，
  //    边界谓词与 jail **相与**；0.6.0 起库不提供沙箱，牢笼仍由本项目提供，不变式 1）
  //    + note 工作流工具（0.8.0 recall 退役，档案取回归 note_list→note_read；issue #46 起走
  //    0.10.0 装配工厂，notesDir 为 agentd 下行的 run 数据目录，logical-run 作用域跨 attempt 保留）；
  //    approvals 钩子 P2 留空）。
  ensureGitRepo(cwd);
  const jail = createJail({ root: cwd, writable: [cwd] });
  const fileTools = createStationFileTools({ jail, cwd });
  // issue #46（选项 A，logical-run 作用域）：notesDir 由 agentd 下行（run 数据目录
  // <home>/runs/<runId>/notes，跨 attempt 保留，与 run 工作区生命周期解耦——resume 不再丢 notes）。
  // 旧 agentd 无 notes_dir 字段 → 回退 cwd 内 .notes（旧语义，resume 仍会丢，warn 明示）。
  let noteTools = { schemas: [], executeTool: null, lifecycle: null };
  try {
    const notesDir = typeof msg.notes_dir === 'string' && msg.notes_dir.length > 0
      ? msg.notes_dir
      : path.join(cwd, '.notes');
    if (typeof msg.notes_dir !== 'string' || msg.notes_dir.length === 0) {
      sendIpc(process, {
        type: MSG.LOG, run_id: runId, level: 'warn',
        msg: 'notes_dir missing from RUN_START (old agentd?), fallback to cwd-local .notes; notes will NOT survive resume',
      });
    }
    noteTools = await createNotesTools({ runId, notesDir });
  } catch (err) {
    sendIpc(process, {
      type: MSG.LOG, run_id: runId, level: 'warn',
      msg: `notes tools unavailable, run continues without note workflow: ${String(err?.message ?? err)}`,
    });
  }
  // issue #72：shell 工具（进程内命令执行，v1 自动执行 + tool 事件审计）——与 file 工具
  // 同为纯 {executors, schemas} 形态（issue #228：file 侧的 executors 是 name→fn 对象，上游
  // 原生那个 executors 是**函数**、铺进对象会铺出空集），并入 registry 最简；note_* 例外走工厂
  // 结构化 executeTool（工厂内部强制宿主作用域），保持独立分支不动。
  const shellTools = createShellTools({ worktreeRoot: cwd });
  const registry = createToolRegistry({
    executors: { ...fileTools.executors, ...shellTools.executors },
    schemas: [...fileTools.schemas, ...shellTools.schemas],
  });
  const tools = [...fileTools.schemas, ...shellTools.schemas, ...noteTools.schemas];
  const noteToolNames = new Set(noteTools.schemas.map((s) => s.name));
  const executeTool = async (options) => {
    if (noteTools.executeTool && noteToolNames.has(options.name)) {
      return noteTools.executeTool(options);
    }
    // issue #211：abort signal 必须转交。引擎契约把 run 的 signal 放在 executeTool 的**顶层**
    // options.signal（erix-agent 0.17.0 orchestrator.js:324 声明 + run-snapshot-executor.js:237
    // `signal: ctx.toolSignal` 实传），而 registry.executeTool 只有 (name, input, context) 三个
    // 位置参数、没有 signal 槽位——所以 signal 只能搭 context 下去（registry.js:143
    // `executor(input, context)` 原样转给 executor）。此前包装只转 name/input/context，
    // signal 在这一步被丢弃：shell/rg 完全收不到中止，用户点「停止」后引擎侧靠
    // awaitWithAbort 竞速先返回了，但 spawn 出去的命令没人杀，要等满超时（默认 60s，
    // env 放宽可到 3600s）才停——本行是这条链路的唯一入口，别在重构中再丢一次。
    return registry.executeTool(options.name, options.input, {
      ...options.context,
      signal: options.signal,
    });
  };

  // P3 PR②a：portal 已在 POST 事务内预写 `:input:<messageId>`。
  // 空本子（旧 ticket）走引擎 round 0 seed；已有档案直接 resume；旧 ticket 沿用 ticket.resume。
  // resume=true 对齐 repl.js:656：不传 initialMessages/initialUserMessage（恢复记录即完整上文）。
  // ⚠️ 放在 runToolLoop 主 try 之外：load 失败 = 崩溃语义（exit 1 无 RUN_FINISHED）——
  // agentd 视同为 worker 崩溃走 releaseAndRequeue；
  // 不发 RUN_FINISHED failed（那才是 U2 终态，瞬时不应把用户 run 打死）。
  let transcriptPlan = { resume: msg.resume === true };
  if (sessionId && messageId) {
    try {
      const records = await store.load(transcriptKey);
      transcriptPlan = planTranscriptSeed({
        records, transcriptKey, messageId, legacyResume: msg.resume === true,
      });
    } catch (err) {
      sendIpc(process, {
        type: MSG.LOG, run_id: runId, level: 'warn',
        msg: `transcript load failed, exit for requeue: ${String(err?.message ?? err)}`,
      });
      // 延迟退出让 LOG 入队（同 finally 的 200ms 约定）。
      setTimeout(() => process.exit(1), 200);
      return;
    }
  }

  try {
    const result = await runToolLoop({
      provider,
      // 0) system prompt（issue #64 R2）：交付物落盘、收尾回复只写摘要不贴代码全文。
      system: SYSTEM_PROMPT,
      // 6) 回调：全桥接到 IPC event（§6.3-6）。
      onEvent: (event) => {
        if (event?.type === 'usage') return; // 双源去重：记账以返回值 usage 为准（§7.3/§6.3-6）
        emitEvent(event.type, loopEventPayload(event));
      },
      onDelta: (chunk) => {
        if (typeof chunk === 'string' && chunk.length > 0) emitEvent('assistant_delta', { text: chunk });
      },
      onReasoningDelta: (chunk) => {
        if (typeof chunk === 'string' && chunk.length > 0) emitEvent('reasoning_delta', { text: chunk });
      },
      onToolCall: (fragment) => {
        if (fragment && typeof fragment === 'object') emitEvent('tool_call_delta', fragment);
      },
      onJudge: (info) => {
        if (info && typeof info === 'object') emitEvent('judge', info);
      },
      onUsage: () => {}, // 记账以 runToolLoop 返回值 usage 为准（§7.3）
      onPersistenceError: (err) => {
        sendIpc(process, { type: MSG.LOG, run_id: runId, level: 'warn', msg: `persistence error: ${String(err?.message ?? err)}` });
      },
      onObserverError: (err) => {
        sendIpc(process, { type: MSG.LOG, run_id: runId, level: 'warn', msg: `observer error: ${String(err?.message ?? err)}` });
      },
      // task 显式传（§1.3 硬注意-1）；种子片段对齐上游 CLI 的 `...(resume ? {} : { initialUserMessage })`：
      // resume 不传任何种子选项（恢复记录即完整上文），空本子只种 `task`。
      // P3 PR③：会话历史文本注入（issue #69）已退役 —— 两个分支都永不传 `initialMessages`，
      // 上下文唯一来源 = transcript（conversation-state.md §6 契约③）。
      task,
      ...buildEngineSeedOptions({ resume: transcriptPlan.resume === true, task }),
      tools,
      executeTool,
      // ADR-015：notes 工厂 semanticStateProvider 透传——引擎在
      // context 折叠重建 run state 时回调（宿主契约 §Run state），返回 {text, version, status}
      // 注入 run-state 的 semantic 段；undefined/非函数时引擎按「未提供」跳过（工厂加载失败的
      // 降级路径同样安全：noteTools 回退对象无此字段）。
      semanticStateProvider: noteTools.semanticStateProvider,
      store,
      // issue #81 P2：引擎 store key = transcript key（sessionId），非真 runId。
      runId: transcriptKey,
      resume: transcriptPlan.resume === true,
      // maxRounds：env ERIX_MAX_ROUNDS 可调（默认 16；2026-09-24 用户拍板自 8 上调，与上游
      // judge 常规搭配 DEFAULT_REFLECTION_MIN_ROUNDS=16 对齐）。改值 = 改容器 env + 重建容器，
      // 不需重建镜像（provisioner 注入，docs/env.md 登记）。
      maxRounds: parseMaxRounds(process.env.ERIX_MAX_ROUNDS),
      stream: true,
      // 8) reflection / wrapup 显式传（§6.3-8）。judge（扩轮）已开：用户 2026-09-22 拍板，
      // 推翻「P1 mock 关 judge」决策（issue #43）——每轮 end_turn 走 round judge 评估，
      // nearLimit 时可 extend 扩轮；judgeIntercept 默认开（工具透明审计）。judge 输出非法
      // JSON 时 fail-closed 不扩轮（roundJudgeFailures 限 3 后本轮禁用）。wrapup 保持关（对话型宿主）。
      reflection: { enabled: true, roundJudge: true },
      wrapup: false,
      // 7) signal
      signal: abortController.signal,
    });

    // issue #88 修订（2026-09-25 用户拍板）：标题改由 agent 侧顺带生成——runToolLoop 正常返回后
    // 用既有 provider 发一次小请求（非流式、10s 超时、maxTokens 512；思考型模型兼容归引擎 provider
    // 层管，portal 不再独立调 relay）。开关 ERIX_SESSION_AUTO_TITLE（'0' 关，provisioner 下发链）。
    // 失败/超时/空 → 空串（portal 走降级链），generateSessionTitle 全链 catch，绝不阻塞终态上报。
    let title = '';
    if (process.env.ERIX_SESSION_AUTO_TITLE !== '0') {
      title = await generateSessionTitle({
        provider,
        // P3 PR③：历史下行退役后，标题输入 = 本轮 task（首启时会话首条用户消息就是它）。
        firstUserContent: resolveFirstUserContent({ task }),
        finalText: result.finalText ?? '',
        // 失败 warn 走 IPC LOG → agentd 日志（与 worker 其它日志同径，stderr 兜底在 lib 内）。
        log: { warn: (m) => sendIpc(process, { type: MSG.LOG, run_id: runId, level: 'warn', msg: m }) },
      });
    }
    sendIpc(process, {
      type: MSG.RUN_FINISHED,
      run_id: runId,
      ok: true,
      termination: result.termination ?? { reason: 'end_turn' },
      usage: result.usage ?? { input_tokens: 0, output_tokens: 0 },
      rounds: result.rounds ?? 0,
      final_text: result.finalText ?? '',
      title,
    });
  } catch (err) {
    // issue #212：失败/中止终态信封（构造逻辑与单测在 runner/lib/termination.js）。
    // 优先**透传**引擎挂在错误上的完整 termination（reason 可能是 persistence_failed，
    // 并带 operation/phase/sideEffect），引擎没给才回退旧的拍平口径；retryable 改用与
    // 上游对齐的码表（旧代码是手写半截清单）。
    // erix-agent #180（0.18.0）：usage/rounds 也从信封取引擎挂在错误上的真值，
    // 「停止」/失败的 run 不再是账面上的 0 token（引擎没挂时回退零值）。
    const aborted = abortController?.signal?.aborted === true;
    const { termination, error, usage, rounds } = buildFailureEnvelope({ err, aborted });
    sendIpc(process, {
      type: MSG.RUN_FINISHED,
      run_id: runId,
      ok: false,
      termination,
      usage,
      rounds,
      final_text: '',
      title: '', // 失败路径不生成标题（portal 降级链兜住）
      error,
    });
  } finally {
    // issue #46：onRunComplete 仅完成 active notes；收尾错误只记日志，不覆盖 run 主错误。
    if (noteTools.lifecycle) {
      try {
        const completion = await noteTools.lifecycle.onRunComplete();
        const completedCount = completion?.completed?.completed;
        if (Number.isInteger(completedCount) && completedCount > 0) {
          sendIpc(process, {
            type: MSG.LOG, run_id: runId, level: 'info',
            msg: `notes completed: ${completedCount}`,
          });
        }
        for (const failure of completion?.errors ?? []) {
          sendIpc(process, {
            type: MSG.LOG, run_id: runId, level: 'warn',
            msg: `notes completion error (${failure.operation}): ${String(failure.error?.message ?? failure.error)}`,
          });
        }
      } catch (err) {
        sendIpc(process, {
          type: MSG.LOG, run_id: runId, level: 'warn',
          msg: `notes onRunComplete failed: ${String(err?.message ?? err)}`,
        });
      }
    }
    // 给 agentd 足够时间接收 run_finished 后再退出（IPC 有序，send 即已入队，短延迟防 race）。
    setTimeout(() => process.exit(0), 200);
  }
}

process.send?.({ type: MSG.WORKER_READY, pid: process.pid });
