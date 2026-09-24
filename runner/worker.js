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

// user-space §6.2：umask 0002（新建文件 664/目录 775）——worker/agent 写 worktree 与 spool 的文件
// 需跨 UID（1002↔1001/1000，同 GID 1000）组可写；fork 时已从 agentd/entrypoint 继承（entrypoint.sh
// 早有 umask 0002，本处为防御性重设，评审 F8）。
process.umask(0o002);

import path from 'node:path';
import {
  createJsonFileModelConfigProvider,
  createOpenAIProvider,
  runToolLoop,
} from 'erix-agent';
import { createToolRegistry } from 'erix-agent/tools';
import { MSG, createReqIdGenerator, sendIpc } from './lib/ipc.js';
import { resolveRunModel } from './lib/llm-models.js';
import { createFileTools, createJail } from './lib/file-tools.js';
import { createShellTools } from './lib/shell-tools.js';
import { createNotesTools } from './lib/notes-tools.js';
import { makeStore } from './lib/store.js';
import { planTranscriptSeed } from './lib/transcript-seed.js';
import { mapHistoryToInitialMessages } from './lib/history.js';

// issue #64（R2）：system prompt 为 runToolLoop 合法顶层选项（erix-llm-kit
// docs/host-consumer-contract.md §runToolLoop options 白名单含 system）——
// 约束真模型收尾行为：交付物落盘、回复只写简短摘要、不贴代码全文。
const SYSTEM_PROMPT = `你是运行在 FDE 工作台容器中的编码 agent，工作目录是本次 run 独占的 worktree。

交付规则：
1. 交付物（代码/配置/文档）必须用 writeFile 写入工作目录的文件系统——磁盘上的文件才是交付物。
2. 修改既有文件前先 readFile 看现状，不要凭空整文件覆写。
3. 收尾回复只写简短摘要：做了什么、写入/修改了哪些文件、如何运行与验证；不要在回复里粘贴代码全文或大段文件内容。
4. 若任务只是问答或解释、不产生交付物，直接回答即可，无需写文件。
5. 交付前尽量用 shell 工具运行验证命令（构建/测试/lint），跑通再交付；命令在容器内执行，不要改动 worktree 之外的状态。`;

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
      reject(Object.assign(new Error('ipc channel closed'), { code: 'ipc_closed', retryable: true }));
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

  // 3) tools（§6.3-3：jail + 自带 file 工具（0.6.0 起库不提供，牢笼由本项目提供，不变式 1）
  //    + note 工作流工具（0.8.0 recall 退役，档案取回归 note_list→note_read；issue #46 起走
  //    0.10.0 装配工厂，notesDir 为 agentd 下行的 run 数据目录，logical-run 作用域跨 attempt 保留）；
  //    approvals 钩子 P2 留空）。
  const jail = createJail({ root: cwd, writable: [cwd] });
  const fileTools = createFileTools(jail);
  // issue #46（选项 A，logical-run 作用域）：notesDir 由 agentd 下行（run 数据目录
  // <home>/runs/<runId>/notes，跨 attempt 保留，与 worktree 生命周期解耦——resume 不再丢 notes）。
  // 旧 agentd 无 notes_dir 字段 → 回退 worktree 内 .notes（旧语义，resume 仍会丢，warn 明示）。
  let noteTools = { schemas: [], executeTool: null, lifecycle: null };
  try {
    const notesDir = typeof msg.notes_dir === 'string' && msg.notes_dir.length > 0
      ? msg.notes_dir
      : path.join(cwd, '.notes');
    if (typeof msg.notes_dir !== 'string' || msg.notes_dir.length === 0) {
      sendIpc(process, {
        type: MSG.LOG, run_id: runId, level: 'warn',
        msg: 'notes_dir missing from RUN_START (old agentd?), fallback to worktree-local .notes; notes will NOT survive resume',
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
  // 同为纯 {executors, schemas} 形态，并入 registry 最简；note_* 例外走工厂结构化 executeTool
  // （工厂内部强制宿主作用域），保持独立分支不动。
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
    return registry.executeTool(options.name, options.input, options.context);
  };

  // issue #81 P2：CLI「预写入 + resume」模式（planTranscriptSeed 三分支，见 lib/transcript-seed.js）：
  // 空本子 → 不 resume（initialMessages/initialUserMessage 全新路径，引擎 round 0 种子入档）；
  // 新消息未入档 → 宿主预写 dedupKey=`<key>:input:<messageId>` → resume=true；
  // 已入档（崩溃重跑）→ 直接 resume=true 不重复写（幂等红线）。
  // resume=true 对齐 repl.js:656：不传 initialMessages/initialUserMessage（恢复记录即完整上文）。
  // ⚠️ 放在 runToolLoop 主 try 之外：load/预写失败 = 崩溃语义（exit 1 无 RUN_FINISHED）——
  // agentd 视同为 worker 崩溃走 releaseAndRequeue（attempt+1 重试，dedupKey 幂等收敛）；
  // 不发 RUN_FINISHED failed（那才是 U2 终态，瞬时不应把用户 run 打死）。
  let transcriptPlan = { resume: msg.resume === true, record: null };
  if (sessionId && messageId) {
    try {
      const records = await store.load(transcriptKey);
      transcriptPlan = planTranscriptSeed({
        records, transcriptKey, messageId, attempt, task, legacyResume: msg.resume === true,
      });
      if (transcriptPlan.record) {
        await store.appendRound(transcriptKey, transcriptPlan.record);
        sendIpc(process, {
          type: MSG.LOG, run_id: runId, level: 'info',
          msg: `transcript prewrite: key=${transcriptKey} round=${transcriptPlan.record.round} dedup=${transcriptPlan.record.dedupKey}`,
        });
      }
    } catch (err) {
      sendIpc(process, {
        type: MSG.LOG, run_id: runId, level: 'warn',
        msg: `transcript seed failed, exit for requeue: ${String(err?.message ?? err)}`,
      });
      // 延迟退出让 LOG 入队（同 finally 的 200ms 约定）。
      setTimeout(() => process.exit(1), 200);
      return;
    }
  }

  try {
    // issue #46：notes 生命周期——onRunStart（janitor）在 runToolLoop 前（上游 bin/cli.js 模式）；
    // 失败只告警不中断 run（档案工具仍在，仅清扫未跑）。
    if (noteTools.lifecycle) {
      try {
        await noteTools.lifecycle.onRunStart();
      } catch (err) {
        sendIpc(process, {
          type: MSG.LOG, run_id: runId, level: 'warn',
          msg: `notes onRunStart (janitor) failed, run continues: ${String(err?.message ?? err)}`,
        });
      }
    }
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
      // 1) task 显式传（§1.3 硬注意-1）；2) 本轮用户输入经 transcript 预写入/引擎种子入档，
      //    resume 时不再传 initialMessages/initialUserMessage（对齐 repl.js:656）。
      task,
      ...(transcriptPlan.resume ? {} : {
        // issue #69：会话历史下行——非 resume 时把 RUN_START.history 映射为引擎 initialMessages
        // （纯函数非法入参回退 []；#70 注入本 PR 保留，P3 随 transcript 投影退役）。
        initialMessages: mapHistoryToInitialMessages(msg.history),
        initialUserMessage: task,
      }),
      tools,
      executeTool,
      store,
      // issue #81 P2：引擎 store key = transcript key（sessionId），非真 runId。
      runId: transcriptKey,
      resume: transcriptPlan.resume === true,
      maxRounds: 8,
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

    sendIpc(process, {
      type: MSG.RUN_FINISHED,
      run_id: runId,
      ok: true,
      termination: result.termination ?? { reason: 'end_turn' },
      usage: result.usage ?? { input_tokens: 0, output_tokens: 0 },
      rounds: result.rounds ?? 0,
      final_text: result.finalText ?? '',
    });
  } catch (err) {
    const aborted = abortController?.signal?.aborted === true;
    const code = aborted ? 'aborted' : (err?.code ?? 'failed');
    sendIpc(process, {
      type: MSG.RUN_FINISHED,
      run_id: runId,
      ok: false,
      termination: { reason: aborted ? 'aborted' : 'failed' },
      usage: { input_tokens: 0, output_tokens: 0 },
      rounds: 0,
      final_text: '',
      error: {
        code,
        message: String(err?.message ?? err),
        retryable: err?.retryable === true || code === 'checkpoint_failed' || code === 'rate_limited',
      },
    });
  } finally {
    // issue #46：onRunComplete（completeRun→janitor）在 finally 收尾；errors[] 只记日志，
    // 不覆盖 run 主错误（上游 bin/cli.js 同款 completionErrors 模式）。
    if (noteTools.lifecycle) {
      try {
        const completion = await noteTools.lifecycle.onRunComplete();
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
