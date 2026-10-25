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
  // issue #309 切片 2b：上游预算闸（与 runToolLoop 同源，包根导出）。只作为**依赖注入**传给
  // resolveModelMetadata——本文件不自己算预算，也不把它的返回值当数据用（只看它抛不抛）。
  computeBudget,
} from 'erix-agent';
import { createToolRegistry, buildSkillTools } from 'erix-agent/tools';
import { MSG, createReqIdGenerator, sendIpc, lastSendError } from './lib/ipc.js';
import { parseMaxRounds } from './lib/config.js';
import { resolveRunModel, resolveModelMetadata } from './lib/llm-models.js';
import { resolveLlmTimeouts } from './lib/llm-timeouts.js';
import { createJail, createStationFileTools } from './lib/file-tools.js';
import { createShellTools } from './lib/shell-tools.js';
import { createNotesTools } from './lib/notes-tools.js';
import { makeStore } from './lib/store.js';
import { planTranscriptSeed, buildEngineSeedOptions } from './lib/transcript-seed.js';
import { buildFailureEnvelope } from './lib/termination.js';

// issue #64（R2）：system prompt 为 runToolLoop 合法顶层选项（erix-llm-kit
// docs/host-consumer-contract.md §runToolLoop options 白名单含 system）——
// 约束真模型收尾行为：交付物落盘、回复只写简短摘要、不贴代码全文。
//
// 工具面用法段（2026-10-10，首次真实部署前补票）：issue #228 把文件工具换成上游
// erix-agent 0.18.0 的 createFileTools 之后，工具面变了（`rg` 退役 → `searchText`，新增 `edit`），
// 而这段提示词还停在 fork 时代。真机已付出过代价：模型不知道 `searchText` 的 `mode` 必填、
// 不知道默认跳过 vendor/点目录，看到「（无命中）」就断定「代码里没有」，甚至绕去跑 shell 命令。
// **这里只是提示词**——工具行为与 schemas 一律由上游实现决定，本段只负责把它的既有的口径讲清楚。
// 防漂移：runner/test/system-prompt.test.js 会拿注册面（STATION_FILE_TOOL_NAMES）逐名核对这段文本，
// 并在提示词提到未注册的上游别名时要求它处在否定语境里——改工具面必须同步这里。
//
// 预览告知的分工（2026-10-12，issue #257 + #258 落点定稿，#issuecomment-6117800165）：
// **平台约束的单一真相 = materializer 下发的 `~/AGENTS.md`**（预览访问 8 条要求链 + 错误形态对照；
// 第 7 条「应用自己的登录态不要用 Cookie」来自 #262，边缘全方法剥 `Cookie` 头，#263 复测定口径；
// 第 8 条「报『服务已起』必须给出清单里那条完整预览 URL 并提醒逐 host 放行」来自 #285，告知义务）
// 本段只留一句「开工前先读 `~/AGENTS.md`」的**强制指针**，不抄规则——同 §8.10「工具名从注册面取、
// 不手抄清单」：提示词与 portal 文案是两个包里的两份字，抄一遍就是埋下一份必然过期的第二真相。
// ⚠ 前提单 **#259** 未落地前 `createJail({ root: cwd })` 的读边界只有项目根（无只读例外），
//   所以指针必须同时带「家目录用 shell 读」的口径（真机里模型用 `readFile` 读 `~/AGENTS.md` 会撞
//   「被宿主边界拒绝」白烧一轮）。R-1 复测新增 **P0：下发了 ≠ 读了**，transcript 里读 `~/AGENTS.md`
//   的调用数为 0 直接判失败。防漂移断言：同文件里的「强制指针存在 / 八个具体规则词不得出现（allowedHosts
//   · credentials · CORS · Set-Cookie · localStorage · Bearer，后三个是 #262 第 7 条带进来的；
//   最后两个 · 打开预览 · markdown 链接 是 #285 第 8 条带进来的）/ 不出现
//   伞域字面量」三条。
const SYSTEM_PROMPT = `你是运行在 FDE 工作台容器中的编码 agent，工作目录是项目目录 \`~/projects/<project>\`（本次 run 直接在此工作，交付物留在项目目录内）。

工具面只有这些：文件工具 readFile / searchText / tree / edit / writeFile，外加 shell（在容器内执行命令）与 note_* 工作流工具。上游提供的 rg / grep 只是 searchText 的退役别名，本站没有注册它们——调不存在的工具只会拿到 Unknown tool。

文件工具怎么用（照做可省掉大量返工）：
- searchText：搜文件内容。mode **必填且没有默认值**——固定字符串传 mode="literal"，正则传 mode="regex"，漏传或写错直接是错误结果，没人替你猜。默认跳过 node_modules/dist/build/target/vendor 与所有点目录（含 .git），结果尾部的「已跳过 …」是**排除账**而不是错误：确实要把它们一起搜，就传 include_vendor=true / include_hidden=true。所以看到「（无命中）」先回看排除账，再决定要不要下「代码里没有」的结论。三件事含义不同，别混：「（无命中）」= 范围内没搜到；「错误：无效正则：…」= 你的正则写错了；「错误：…被宿主边界拒绝：…」= 路径越界或被遮蔽。全仓搜索请用 searchText 本身，别改用 shell 命令去代替它。
- edit：改既有文件的首选。入参是 edits:[{oldText, newText}]。它只做**逐字节精确匹配**（空白与缩进都算，没有任何模糊兜底），且每条 oldText 必须**恰好命中一次**——0 处或多处命中都会整次失败、一个字节都不落盘。所以 oldText 要从 readFile 的输出里**逐字复制**（含缩进与行尾风格），命中多处就多带几行上下文让它唯一；不要凭记忆重打一遍原文。
- readFile：单次返回有 256KB 上限。被截断时尾部 marker 已经写好了下一步（offset=… 续读，或提高 max_bytes）——照 marker 给的参数继续即可，别自己猜行数，也别以为文件只有这么多。
- tree：列目录结构，默认同样跳过 vendor 与点目录（要看得更全传 include_vendor=true / include_hidden=true）。根标签是 ./，它下面的条目都是相对名，可以直接当 path 传回去。
- searchText / tree 的 name_pattern 之类名字过滤只匹配**文件名**，不跨越 / ，所以 "**/*.ts" 这种写法不生效，要写 "*.ts"。
- 读文件回「错误：…被宿主边界拒绝：…」时，不要在原路径上反复重试：那是路径越出了项目目录，或是要读的文件被平台刻意遮蔽（密钥类）。真需要内容时用 shell 定点看那一个文件，别把整文件灌进回复。

预览域名与端口（段由平台分配，**清单是唯一真相**，不需要你自己发明）：
- **开工前先读 \`~/AGENTS.md\`**（尤其是要让外部浏览器访问你起的服务时）：工位约定与平台约束都在那份文件里，本提示词**有意不复述**它的应用侧规则（抄一遍就是第二个会过期的真相源）。
- 预览端口段由平台在本 FDE 开户时**分配**：从全局号池里发一整段连续端口（默认 10 个，管理员可改段）。这一段到底是哪几个号，**唯一真相是 \`~/.erix/ports.json\` 里的清单**（每条带对应的真实访问 \`url\`）——不要凭记忆、也不要假设是固定的某几个端口。
- dev server 的端口**必须从清单里选**，并绑 \`0.0.0.0\`（绑 127.0.0.1 入口进不来）；对外访问直接用清单里那一条的 \`url\`。
- 域名由平台按 \`<fde>-p-<端口>\` 生成（与入口路由同源）：**不要自造域名或端口**，也不要要求平台再加——清单里那段就是全部，不够用就在它们里复用。
- \`~/.erix/ports.json\` 与 \`~/AGENTS.md\` 都在家目录（项目目录之外），文件工具读不到它们（会回「被宿主边界拒绝」），用 shell 读：\`cat ~/.erix/ports.json\`、\`cat ~/AGENTS.md\`。

交付规则：
1. 交付物（代码/配置/文档）必须用 writeFile 写入工作目录的文件系统——磁盘上的文件才是交付物。
2. 修改既有文件前先 readFile 看现状，不要凭空整文件覆写；小范围改动用 edit。
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

/**
 * LoopEvent → U3 事件 payload 的映射（§5/§7.3）。
 * issue #283 / #299：`export` 仅为单测可见面（runner/test/tool-result-envelope-contract.test.js
 * 要钉 `duration_ms` 的取值口径：新记录读 `erix.durationMs`、老记录回退顶层 `duration`、
 * 两者都缺⇒ `null`，**绝不伪装成 0**）；worker 自身调用方式不变。
 */
export function loopEventPayload(event) {
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
        // erix-agent 0.20.0（上游 #284 / host-upgrade-guide-0.20.0 §2、§3）：**引擎事实从 `tool_result`
        // 块顶层搬进了 `erix.*`**，`TOOL_RESULT_CONTRACT.legacy.written === false` ⇒ 退役名单
        // （`erixRound`/`duration`/`executionStatus`/`success`/宿主扩展键）**不再出现在新记录顶层**。
        // 所以正确读点是 **`tr.erix.durationMs`**，不是顶层 `tr.duration`：
        //   * 0.20.0 之前这里读顶层 `tr.duration`（那是 0.17/0.18 引擎把 `execution.metadata` 摊平到
        //     顶层的结果，当时 host-upgrade-guide-0.17.0 也是这么要求的）——0.20.0 之后这条读法会
        //     **静默退化成 null**（引擎不报错，只是不写了），本行就是为它改的。
        //   * `?? tr.duration` 的回退**只为盘上的旧记录保留**：引擎读侧保留一代兼容（指南 §3），
        //     真机库里 740+ 条旧 `tool_result` 只带顶层 `duration`。⚠ 回退只保一代：引擎已不再写
        //     顶层，下一轮引擎 minor 就会真的没有这个字段，届时删掉回退项（勿新增顶层读法）。
        //   * 缺失 ⇒ `null`（「不知道」不是 0，0.20.0 明确把 `?? 0` 当错口径：guide §2）。
        //     真执行过的四种形态 0.20.0 都会写值（判据见 .work-orders/probe.md 探针 1）；
        //     没值的只剩「judge 拦截 / unsafe 重放被中止 / executor 未 settle 就被中止」三种。
        duration_ms: Number.isFinite(tr.erix?.durationMs) ? tr.erix.durationMs
          : (Number.isFinite(tr.duration) ? tr.duration : null),
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
    case 'tool_replay_decision_required': {
      // issue #288（缺陷 C）：崩溃恢复时挂起工具**没被重放**（引擎 `orchestrator.js:2605-2614` 发出）。
      // 字段名以**引擎事件对象的实际形状**为准（0.18.0 `:2606-2613` 逐字核过）：
      //   `{ type, runId, round, toolUseId, toolName, replay, requiresHostDecision, partialOutputAvailable }`
      // ——引擎只给这几个，**没有** `input` / `command` / `duration`，不要在这里臆造默认值补位。
      // ⚠ `event.runId` 是**引擎 store key = transcriptKey = sessionId**（worker.js 传 `runId: transcriptKey`，
      //   issue #81 P2），**不是** station 的 run id。落名 `engine_run_id` 而不是 `run_id`：U3 行本身的
      //   `run_id` 列已是 station 口径（`makeEvent`/`enqueueEvent`），再塞一个同名不同义的字段就是坑。
      // 布尔位一律 `=== true` 归一：引擎给的是真布尔，但 additive 字段面对脏值（旧数据/手工注入）
      // 得退到 false 而不是把 `undefined`/对象透到下游。
      return {
        tool_call_id: event.toolUseId ?? null,
        engine_run_id: event.runId ?? null,
        round: event.round,
        name: event.toolName ?? null,
        replay: typeof event.replay === 'string' ? event.replay : null,
        requires_host_decision: event.requiresHostDecision === true,
        partial_output_available: event.partialOutputAvailable === true,
      };
    }
    case 'persistence_error': {
      // issue #371-A：引擎的**落盘失败事件**（`orchestrator.js` 的 `persistenceErrorEvent`）。
      // ⚠ 它**不走 `onEvent`**，走 `diagnostics.error`（本站此前根本没传 `diagnostics` ⇒ 这个事件
      // 从来没进过 `run_events`；真机全库 `type='persistence_error'` = **0 行**，2026-10-24 查得）。
      // 字段以引擎 `persistenceErrorEvent` 的实际形状为准（钉在 0.23.0 `orchestrator.js:206-222`，
      // 与 #461 后的 0.25 同形）：`{type, port, phase, operation, runId, fatal, sideEffect,
      // error:{name,message,stack}, ts}`。两个故意取舍：
      //   · **`stack` 不透**：那是宿主日志的东西，塞进 UI payload 只会淹没前端（单事件上限 256KB）。
      //   · `fatal` **归一成布尔且缺字段算致命**（`!== false`）：前端靠它分「降级继续」与「run 已终止」，
      //     脏值/缺字段时宁可报重不可报轻（把真失败刷成灰 = 谎报严重程度，#212 口径）。
      // ⚠ `runId` 是引擎 store key = transcriptKey = sessionId（#81 P2 老坑），落名 `engine_run_id`。
      const err = event.error && typeof event.error === 'object' ? event.error : {};
      const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
      return {
        port: str(event.port) ?? 'transcript',
        phase: str(event.phase),
        operation: str(event.operation) ?? 'unknown',
        engine_run_id: str(event.runId),
        fatal: event.fatal !== false,
        sideEffect: event.sideEffect ?? null,
        error: { name: str(err.name) ?? 'Error', message: str(err.message) ?? '' },
        ts: str(event.ts),
      };
    }
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
  // issue #309 切片 2：把下行元数据（context_window / max_output_tokens）喂给引擎，并**显式**发输出上限。
  // 为什么值得接：缺这两个数时引擎的压缩总开关不进入（budgetTokens 未定义→overBudget 恒 false）、
  // 单轮聚合输出预算整体关闭、输出截断上限退回 4096，而此前全链路零告警（真机 92 轮 run compaction=0）。
  // ⚠ 判据与钳制**全在 lib/llm-models.js 的纯函数 resolveModelMetadata 里**（那里能单测），本处只做
  // 装配 + 告警，**不要再算一遍**。必须钳的硬红线：引擎启动期算预算无 try/catch
  // （erix-agent 0.20.0 src/loop/orchestrator.js:1141-1148），越界值抛 KitError invalid_budget ⇒
  // **每个 run 第 1 轮之前就死**（不是「这一轮不好」，也不是「不压缩」）。
  // 切片 2b：第二入参把**上游那道闸**注进去（包根 computeBudget，公式不复制到本站）——ctx 合法但
  // 很小（1001/2000/2666 这类）时 1/4 钳完预算仍非正，闸会抛 ⇒ 纯函数兜成 null ⇒ 同样是「什么都不传」。
  // 本处不传 probe 则守卫失效（小窗口元数据会把每个 run 炸死），所以**必须传**（源码级锁：
  // runner/test/model-metadata.test.js）。
  const engineModelMetadata = resolveModelMetadata(msg.models, { computeBudget });
  if (engineModelMetadata?.clamped) {
    // 填错元数据的模型行照跑，但必须留痕：走现成 IPC LOG（**不新增事件类型**，否则污染用户可见事件流）。
    sendIpc(process, {
      type: MSG.LOG, run_id: runId, level: 'warn',
      msg: `model metadata clamped: max_output_tokens ${String(engineModelMetadata.clamped_from)}`
        + ` → ${engineModelMetadata.max_output_tokens}`
        + ` (limit = floor(context_window/4), context_window=${engineModelMetadata.context_window})`,
    });
  } else if (!engineModelMetadata && msg.models?.main) {
    // 同一个 LOG，但要把**两种成因**说清（共用一条 = 不新增事件类型，文案各自点名）：
    //   a) `context_window` **下行未带或形态非法**（#316：入口 `parseHeartbeatModels` 把真小数 / ≤0 /
    //      非数字串这类值**整键丢掉** ⇒ 到这里只能看到「键不在」；数字串与整值浮点已在入口归一成正整数）；
    //   b) context_window 合法但很**小**，1/4 钳完预算仍非正——上游闸抛了（纯函数规则 4）。
    // 两种都落到「什么都不传」= 压缩关掉但 run 照活。⚠ 这里只区分成因、**不重算公式**（本站不许出现
    // floor(/4) 以外的钳制判据，引擎那两个常量一个也不抄）；候选值也不从返回值拿，直接报下行原值。
    // ⚠ 成因 a 的文案必须同时点名「未带」与「形态非法」两种可能（#316 的运维教训：旧文案只报
    // `context_window=undefined`，读起来像 portal 根本没发，而真因是形态被入口判不可得）。
    const ctxRaw = msg.models.main.context_window;
    const ctxShapeOk = Number.isSafeInteger(ctxRaw) && ctxRaw > 0; // 与规则 3 同一形状判据（非引擎公式）
    sendIpc(process, {
      type: MSG.LOG, run_id: runId, level: 'warn',
      msg: `model metadata unusable: context_window=${String(ctxRaw)}`
        + (ctxShapeOk
          ? ` with max_output_tokens=${String(msg.models.main.max_output_tokens)}`
            + ' → computed context budget is not positive (engine computeBudget rejected this pair,'
            + ' even at the 1/4 cap)'
          : ' (not carried by the downlink, or dropped as an invalid shape by parseHeartbeatModels:'
            + ' a token count must be a positive integer; see runner/lib/llm-models.js)')
        + ' → engine metadata and the explicit output cap are not sent;'
        + ' engine compaction stays off (= 现状)',
    });
  }
  // issue #261：显式传相超时（四项默认与 env 覆盖见 lib/llm-timeouts.js）。真正要的效果不是数值本身，
  // 而是「传了显式相 ⇒ 引擎 hasExplicitPhase=true ⇒ legacyTimeoutMs=undefined」，关掉那条从请求发起
  // 就定死的 120s 绝对死线（重型轮子必撞）。回归门：runner/test/llm-timeouts.test.js ②。
  const provider = createOpenAIProvider({
    endpoint: defaultCfg.endpoint,
    apiKey: defaultCfg.apiKey,
    model: modelName,
    timeouts: resolveLlmTimeouts(process.env),
  });

  // 3) tools（§6.3-3：jail + 文件工具（issue #228 起 = 上游 erix-agent createFileTools 的薄装配，
  //    边界谓词与 jail **相与**；0.6.0 起库不提供沙箱，牢笼仍由本项目提供，不变式 1）
  //    + note 工作流工具（0.8.0 recall 退役，档案取回归 note_list→note_read；issue #46 起走
  //    0.10.0 装配工厂，notesDir 为 agentd 下行的 run 数据目录，logical-run 作用域跨 attempt 保留）；
  //    approvals 钩子 P2 留空）。
  ensureGitRepo(cwd);
  const jail = createJail({ root: cwd, writable: [cwd] });
  const fileTools = createStationFileTools({ jail, cwd });
  // issue #46（选项 A）+ #392（B 片）：notesDir 由 agentd 下行。作用域已从 **logical-run**
  // 改为**会话**：下行的是 `<home>/sessions/<sessionId>/notes`，同一会话的每个 run 看到的是
  // **同一个** notes 目录 + 同一个 scopeRef ⇒ `note_list` 与引擎 run-state 小抄目录跨 run 可见。
  // （旧语义：笔记跟 run 同生同灭，而本站**一条用户消息就是一个 run** ⇒ 笔记天然无效。）
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
    // issue #392（B 片）：`scopeRef = sessionId` ⇒ 笔记作用域 = 会话。
    // 真机依据（会话 `bdef6dd7`，195 轮 / 12 run）：`note_take` 共 3 次，而每次写的都是
    // `scopeRef=runId` ⇒ **下一个 run 一行也读不到**（笔记与它想救的那个上下文同命）。
    // 并发安全：`runs_one_active_per_session`（同会话同时最多一个活跃 run）⇒ 不会有两个 worker
    // 同时写同一个会话的 notes 目录，引擎那条 single-writer 约定依旧成立。
    // 无 session（旧下行 / 无本子的工单）⇒ `scopeRef` 为 undefined ⇒ **逐字退回旧的 run 作用域**。
    /* #392:notes-session-scope:start */
    noteTools = await createNotesTools({
      runId,
      notesDir,
      scopeRef: sessionId ?? undefined,
    });
    /* #392:notes-session-scope:end */
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
  // issue #288（缺陷 A + D）：liveness = shell 执行期的宿主侧信号上行（默认 30s 一跳，env
  // `ERIX_SHELL_LIVENESS_MS` 可下调、钳 ≤60s）。本工具执行期间引擎侧**零 IPC**（无 round/tool 回调），
  // agentd 的 F6 watchdog（默认 300s）会把一条真在跑的长命令当死循环误杀（dev 真机：`sleep 360`
  // + `timeout_ms:420000` 在 300s 整被杀 → requeue → **同一条命令再跑一遍**，3 次后只给一句
  // 「没有原因的 attempts exhausted」）。走现有 IPC 通道 ⇒ agentd 天然刷 `lastIpcAt`。
  // ⚠ `MSG.SHELL_LIVENESS` 是宿主内部信号：走 sendIpc 直发，**绝不得走 emitEvent**
  //（否则多出一条 run_events/U3 事件，污染用户可见事件流）；工具返回正文逐字节不变。
  const shellTools = createShellTools({
    worktreeRoot: cwd,
    liveness: {
      onEvent: (ev) => sendIpc(process, {
        type: MSG.SHELL_LIVENESS,
        run_id: runId,
        phase: ev.phase,
        pgid: ev.pgid,
        // 只有 spawn/exit 需要带命令文本（agentd 侧 debug 记账用）；心跳不带，避免长命令反复上送。
        command: ev.phase === 'heartbeat' ? undefined : ev.command,
        elapsed_ms: ev.elapsed_ms,
      }),
    },
  });
  const registry = createToolRegistry({
    executors: { ...fileTools.executors, ...shellTools.executors },
    schemas: [...fileTools.schemas, ...shellTools.schemas],
  });
  // #363：平台技能 bundled 通道 = FDE 镜像内 /opt/erix/skills（COPY 进镜像，不可变随 digest pin）。
  // 不用 bind mount：fde-proxy 契约只放 rw + userSpace 内源，ro 平台目录要改安全面；而 loader
  // 原生优先级 project > ~/.erix/skills > bundled 已把**迭代通道**白送给用户空间：把同名技能丢进
  // ~/.erix/skills（宿主 users/<fde>/home/.erix/skills，rw bind 现成）即秒级覆盖镜像版。
  // 目录缺席 = 通道空，静默降级（notes 同款 warn 不阻断）。工具名冲突 builtin 优先（#65 语义）。
  let skillTools = { tools: [], executeTool: null, errors: [] };
  try {
    skillTools = await buildSkillTools({
      home: process.env.HOME || '/home/erix',
      cwd,
      bundledDir: process.env.STATION_SKILLS_DIR || '/opt/erix/skills',
      builtinNames: [...fileTools.schemas, ...shellTools.schemas, ...noteTools.schemas].map((s) => s.name),
    });
    for (const e of skillTools.errors) {
      sendIpc(process, {
        type: MSG.LOG, run_id: runId, level: 'warn',
        msg: `skill ${e.skillId ?? '?'} skipped: ${e.error}`,
      });
    }
  } catch (err) {
    sendIpc(process, {
      type: MSG.LOG, run_id: runId, level: 'warn',
      msg: `skills unavailable, run continues without them: ${String(err?.message ?? err)}`,
    });
  }
  const skillToolNames = new Set(skillTools.tools.map((t) => t.name));
  const tools = [...fileTools.schemas, ...shellTools.schemas, ...noteTools.schemas, ...skillTools.tools];
  const noteToolNames = new Set(noteTools.schemas.map((s) => s.name));
  // erix-agent 0.20.0（#285）：引擎对**四种返回形态真执行过的调用都写 `erix.durationMs`**（string /
  // number / `{content,metadata}` / 招异常），所以下面**不再包一层计时**。
  // issue #283 留下的 `wrapToolResultForDuration` 适配闸已撤（撤闸判据 = .work-orders/probe.md 探针 1：
  // 0.20.0 下四种形态无闸均带 `erix.durationMs`，延时 25ms 的执行器给 25ms）；回装会被
  // `runner/test/tool-result-envelope-contract.test.js` 的防回装断言红掉（`tool-duration.test.js` 已随撤闸删除）。本处只保留两件事：note_* 路由，以及
  // issue #211 的 abort signal 转交（下面注释）。引擎对抛异常自己 catch ⇒ 本处不 catch。
  const executeTool = async (options) => {
    if (noteTools.executeTool && noteToolNames.has(options.name)) {
      return noteTools.executeTool(options);
    }
    // 技能工具：上游 executeTool(name, input) 位置参形态（契约见 loader 契约测试），与 notes 的
    // options 对象形态不同，故单独一段路由。
    if (skillTools.executeTool && skillToolNames.has(options.name)) {
      return skillTools.executeTool(options.name, options.input);
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
      // issue #309 切片 2：模型元数据 + 显式 max_tokens（值已在 resolveModelMetadata 里钳过）。
      // 命名纪律（决策者定稿）：camelCase 三键（contextWindowTokens / maxOutputTokens / maxTokens）
      // **在本文件里只允许出现在下面这一对 #309 标记之间**（引擎入参的唯一映射点）。措辞刻意
      // 不说「全站」：锁只数 worker.js（见 model-metadata.test.js 那条用例）；runner 侧过去另有一处
      // `maxTokens: 512`（`lib/session-title.js` 给 provider.chat 用），#322 已随该文件一并删除。
      // 防漂移锁：runner/test/model-metadata.test.js（从 worker.js 源码正则数次数，不 import worker）。
      // 已知副作用（都核过行号，**不要顺手修**）：
      //   - wrap-up 归一化 judge 的请求**继承**宿主 maxTokens（orchestrator.js:3115
      //     `if (maxTokens !== undefined) requestForJudge.maxTokens = maxTokens`）⇒ 它的输出上限从
      //     「provider 默认」变成我们那个数（**变严**，不是变松）；
      //   - round judge / 扩轮 judge **不受影响**（:2319 固定 `maxTokens: 1024`，另一条路径）；
      //   - fold-llm 压缩 summarizer 也继承 maxTokens（:1175）——但**只有真选了 `fold-llm` 才成立**：
      //     本站自 #392 起显式选 `fold-statistical`（零 LLM，见下面 `#392:context-strategy` 标记段），
      //     超预算时也不再退到 `createSlidingWindowStrategy()` 兜底 ⇒ 这条继承对本站至今不适用。
      /* #309:engine-model-params:start */
      ...(engineModelMetadata ? {
        modelMetadata: {
          contextWindowTokens: engineModelMetadata.context_window,
          maxOutputTokens: engineModelMetadata.max_output_tokens,
        },
        maxTokens: engineModelMetadata.max_output_tokens,
      } : {}),
      /* #309:engine-model-params:end */
      // 0) system prompt（issue #64 R2）：交付物落盘、收尾回复只写摘要不贴代码全文。
      system: SYSTEM_PROMPT,
      // issue #392（A 片）：**显式选折叠策略，唯一目的是让折叠产出确定性替代物**。
      // 此前本站连 `context` 都不传 ⇒ 超预算时引擎自己 `createSlidingWindowStrategy()` 兜底
      // （0.25.0 `loop/orchestrator.js:3136` 那条 fallback）。真机标本（erix-station 现网会话
      // `bdef6dd7`，erix-agent 0.25.0，195 轮 / 12 run / 666 条轮记录）：7 次整轮折叠**全部**是
      // slidingWindow，账本里 `foldedSummary` 与 `navigationRecord` 各 **0 行**、`summary` 恒
      // `"missing"`、`[已折叠]` 占位 0 条（`stubFor` 没人给 ⇒ `resolveFoldStubs` 直接返回 `[]`）
      // ⇒ 一次折叠 = 从第 1 轮起到 `budget-6` 轮的**整块静默硬删**（单次最多折走 32.7 万 token），
      // 模型事后既不知道自己少了什么、也无从判断该去哪找。**这条静默不是 bug 而是本站选的后果**。
      // 换成 `fold-statistical`（同版本、零 LLM、零调用成本）之后：机械摘要被 **prepend 进 head**
      // （`compact/fold-statistical.js:546` → `formatFoldSummary`：范围句 + 工具足迹 + 导航记录 +
      // `[已折叠]` 占位 + 锚点节，本会话实测那一份 732 B）⇒ ① 模型当场看得见「早期第 1–107 轮已
      // 折叠」这类事实；② 因为它是真进了请求的正文，`orchestrator.js:3257` 的
      // `fedSummaryText !== ""` 成立 ⇒ 同一份摘要**同时进账本**（`record.foldedSummary`，#326 wo-C）
      // ⇒ 宿主横幅与引擎喂给 judge 的轮次历史第一次有料（此前两者只能看见 `"missing"`）。
      // ⚠ 三件**不要**把本行读成的事：
      //   ① **不是为了少折**。0.25.0 的 `selectFoldedRounds` 对两种策略都是「折掉除最后
      //      `keepRounds` 轮以外的全部」，没有按预算缺口比例裁剪的逻辑（真机每次折到预算的
      //      1.4%–5.4% 就是这个）⇒ 那是 erix-agent#464 的 C 档，**仍未做**，本行不改变它。
      //   ② **故意不传 `keepRounds`**：0.25.0 里 `context.keepRounds` 既不进工厂入参
      //      （`orchestrator.js:1301-1305` 只转发 `recoveryHint` / `stubFor`），也不在调用期
      //      白名单里（`:3090-3097` 那六个键）⇒ 传了没任何人读 = #331 那根「没人读的光纤」。
      //      真要用它只能改对象形态 `createFoldStatisticalStrategy({ keepRounds })`（包根
      //      `index.js:41` 有导出）。判据钉在 `runner/test/fold-strategy.test.js`，见该文件注释。
      //   ③ **不选 `fold-llm`**：真机 39.9 s 同步阻塞在轮与轮之间、最大一次喂进 261345 token
      //      撞 262144 窗口 → 400 后静默降级，而它无超时 / 无输入上限 / 从不看 finish_reason
      //      （erix-agent#469 未修）⇒ 那张单落地之前不提。
      // 不给 env 旋钮：策略名不是运维参数（改它要改的是判据不是配置），且 #331 的前例摆在那儿。
      /* #392:context-strategy:start */
      context: {
        strategy: 'fold-statistical',
      },
      /* #392:context-strategy:end */
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
      // issue #371-A：引擎落盘失败的**事件**通道。与上面的 `onPersistenceError` 是两条不同的嘴：
      // 那条只拿得到 `Error` 对象（本站只落一条 warn 日志，界面上什么都看不见），而
      // `diagnostics.error` 才是带 `fatal`/`operation`/`phase` 的完整事件。此前本站**从来没传
      // `diagnostics`** ⇒ 事件整条丢弃（真机 `run_events` 里 `persistence_error` 恒 0 行）。
      // 接上之后：致命那条仍由 `run_end`（`persistence_failed`）刷红，本事件只负责可审计的明细；
      // 非致命那条（erix-agent#109 宿主端口桥 / #461 剥归档重试）以前是**真隐形**，现在会中性刷一行。
      diagnostics: {
        // 引擎现在只从 `persistenceErrorEvent` 报（type 恒为 `persistence_error`），但那是上游
        // 可能改的自由面：type 缺失/不是非空字符串时守到 `persistence_error`，不让事件因为一个
        // 名字而整条丢（丢了就是又隐形回去）。
        error: (event) => {
          const type = typeof event?.type === 'string' && event.type !== '' ? event.type : 'persistence_error';
          emitEvent(type, loopEventPayload(event));
        },
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
      // issue #288（缺陷 C）：崩溃恢复时**不再盲目重放**挂起工具 —— 交给引擎 0.18.0 已有的能力，
      // 本站只是接线。真机标本：一条 `sleep 360` 的 shell 被 watchdog 杀掉后，resume 把**同一个
      // `tool_use` 从头再执行一遍**（`run_events` 里同 `call_id` 出现 3 条 `tool_use`）——非幂等命令
      // （kill 旧进程、重启 backend/vite、重跑测试）每轮真的再掀一次桌。
      // 引擎读点（erix-agent **0.18.0**，已逐个核过行号）：
      //   - `loop/orchestrator.js:425` 选项文档；`:558` **默认 `"always-replay"`**（= 本站原来的行为）；
      //     `:634-635` 取值校验（只认两个字面量，写错就 TypeError，不会静默退化）。
      //   - `:2565-2620` resume 分支：`:2571` 门 `replayPolicy === "per-tool-declaration" && resumePendingTool.replay !== "safe"`
      //     ⇒ **不调 executor**，合成一条 `is_error: true` + `executionStatus: "interrupted"` 的 tool_result
      //     （:2586-2597，正文带已捕获的部分输出），并发 `tool_replay_decision_required`
      //     （:2605-2614，`requiresHostDecision: true`）；**引擎自己不重试**，是否重跑交给模型。
      //   - `replay` 的值从哪来：`resume-manager.js:256-264` 把 `run snapshot.pendingToolUses` 灌进
      //     `resumePendingTools`，而条目上的 `replay` 是崩溃**当时**由 `:1783-1786` `withReplayDeclaration`
      //     按 `:1770-1782` 解析后盖上去的（源头 = 工具定义顶层 `replay` 键，见 lib/shell-tools.js）。
      // ⚠ 「撤销一条已记录的旧决定」只能改这里，改工具定义不够：`:1775-1777` 规定**快照里已记的
      //   `replay` 值优先于当前工具定义**（「恢复用当初的意图」是上游故意设计）。所以将来若把某个
      //   工具改成 `replay: "safe"`，**存量挂起快照仍按旧值不重放**；要翻案就得同时换本选项或清空快照。
      // 代价（刻意的保守）：上游 0.18.0 `createFileTools` **未给任何工具标 replay**（`src/tools/*.js`
      // grep `replay:` 零命中），而 `:1781` 的判据是 `=== "safe"` ⇒ **未标注也算非 safe**，
      // 5 个文件工具挂起时同样不重放（写文件是幂等的，少跑一次比多跑一次安全，模型可自行重试）。
      // 口径钉在 runner/test/replay-policy.test.js；详细边界见 AGENTS §8.22。
      replayPolicy: 'per-tool-declaration',
      // 8) reflection / wrapup 显式传（§6.3-8）。judge（扩轮）已开：用户 2026-09-22 拍板，
      // 推翻「P1 mock 关 judge」决策（issue #43）——每轮 end_turn 走 round judge 评估，
      // nearLimit 时可 extend 扩轮；judgeIntercept 默认开（工具透明审计）。judge 输出非法
      // JSON 时 fail-closed 不扩轮（roundJudgeFailures 限 3 后本轮禁用）。wrapup 保持关（对话型宿主）。
      // erix-agent 0.22 新增（**上游缺省 false = 不开**，`orchestrator.js:1304-1308`）：
      // 评审判「目标已达成」且置信度够（`>= JUDGE_DONE_CONFIDENCE_THRESHOLD`）时，把那句评审意见
      // **作为一条普通文本消息注入下文**（软提示，不硬断 run、不改 termination）。
      // 决策：2026-10-21 决策者要求默认开。**故意不给 env 旋钮**（#331 那根死光纤的前例：
      // 下发一根没人读的光纤 = 多一个假旋钮）。注入行的 marker = `meta.source === 'judge-control'`，
      // 取数面已在 `portal/src/session-view.js` 里排掉（界面上不显示，也不当用户原话去起标题）。
      reflection: { enabled: true, roundJudge: true, judgeDoneAdvisory: true },
      wrapup: false,
      // 7) signal
      signal: abortController.signal,
    });

    // issue #322：标题归 portal 生成（`portal/src/title-llm.js` → `portal/src/llm-chat.js`），
    // **worker 恒发空串**。本行以前那段「agent 侧顺带生成标题」（跑 `lib/session-title.js` 的
    // `generateSessionTitle`：终态前再发一次小请求）**已整块删除**——同一件事当时有两份实现
    //（≤30 字 / `sanitizeTitle` / prompt / `maxTokens: 512` 各一份），#322 把它收回 portal。
    // 字段本身仍留在信封里（旧 portal 拿到空串 ⇒ 走它的降级链；契约形状不变，见 agentd 透传与
    // `docs/api/portal.md` §9.6 的 `title` 兼容面）。
    sendIpc(process, {
      type: MSG.RUN_FINISHED,
      run_id: runId,
      ok: true,
      termination: result.termination ?? { reason: 'end_turn' },
      usage: result.usage ?? { input_tokens: 0, output_tokens: 0 },
      rounds: result.rounds ?? 0,
      final_text: result.finalText ?? '',
      title: '',   // 标题归 portal 生成，worker 恒发空串（#322）
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
      title: '', // 失败路径也不生成标题（#322：标题归 portal，worker 恒发空串）
      error,
    });
  } finally {
    // issue #46：onRunComplete 仅完成 active notes；收尾错误只记日志，不覆盖 run 主错误。
    // issue #392（B 片）：会话作用域下**不能**调它——`completeRun` 按 scopeRef 批量把 active
    // 改 done（erix-agent 0.25.0 `src/store/notes.js:94`），而 scopeRef 现在 = sessionId
    // ⇒ 每个 run 收尾会把**整个会话**的笔记刷成 done，下个 run 又看不到 ⇒ 与本片目的相反。
    // 标志位由 `lib/notes-tools.js` 给出（不在这里重新推 `msg.session_id`）：作用域与是否收尾
    // 必须是同一个判断的两种说法，两处各自解析就会有不一致的可能。
    if (noteTools.lifecycle && noteTools.completesRunNotes !== false) {
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
