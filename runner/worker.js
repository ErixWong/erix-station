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
import { createNotesTools } from './lib/notes-tools.js';
import { makeStore } from './lib/store.js';

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

  const { task, cwd, resume } = msg;
  const modelConfigPath = msg.config?.model_config_path || '/home/erix/.erix/config.json';

  // store adapter（§9；IPC transport：store_request → agentd 转发；0.9.0 起引擎 fail-closed 校验 8 方法）。
  const store = makeStore(runId, {
    request: (method, args) => ipcRequest(MSG.STORE_REQUEST, { method, args }),
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
  //    + note 工作流工具（0.8.0 recall 退役，档案取回归 note_list→note_read；NotesStore 落盘
  //    在 run worktree 内）；approvals 钩子 P2 留空）。
  const jail = createJail({ root: cwd, writable: [cwd] });
  const fileTools = createFileTools(jail);
  let noteTools = { schemas: [], executors: {} };
  try {
    // notes 目录放 run worktree 内（worktree 随 run 清理回收，notes 为 run 作用域，D8）。
    noteTools = await createNotesTools({ runId, notesDir: path.join(cwd, '.notes') });
  } catch (err) {
    sendIpc(process, {
      type: MSG.LOG, run_id: runId, level: 'warn',
      msg: `notes tools unavailable, run continues without note workflow: ${String(err?.message ?? err)}`,
    });
  }
  const registry = createToolRegistry({
    executors: { ...fileTools.executors, ...noteTools.executors },
    schemas: [...fileTools.schemas, ...noteTools.schemas],
  });
  const tools = [...fileTools.schemas, ...noteTools.schemas];
  const executeTool = async (options) => registry.executeTool(options.name, options.input, options.context);

  try {
    const result = await runToolLoop({
      provider,
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
      // 1) task 显式传（§1.3 硬注意-1）；2) 本轮用户输入作为 task + 初始消息。
      task,
      initialUserMessage: task,
      tools,
      executeTool,
      store,
      runId,
      resume: resume === true,
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
    // 给 agentd 足够时间接收 run_finished 后再退出（IPC 有序，send 即已入队，短延迟防 race）。
    setTimeout(() => process.exit(0), 200);
  }
}

process.send?.({ type: MSG.WORKER_READY, pid: process.pid });
