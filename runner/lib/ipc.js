// IPC 协议常量与辅助（agentd ↔ worker 共享，零依赖）。
// 依据：docs/design/runner-integration.md §5（消息表）——传输用 Node child_process.fork 内建 IPC 通道（JSON 序列化）。
// 所有消息 {type, ...}；请求/响应式消息带 req_id（worker 侧单调递增）。

/** 消息类型（runner §5 消息表）。 */
export const MSG = {
  // worker → agentd
  WORKER_READY: 'worker_ready',
  EVENT: 'event',
  STORE_REQUEST: 'store_request',
  APPROVAL_REQUEST: 'approval_request',
  RUN_FINISHED: 'run_finished',
  LOG: 'log',
  /**
   * issue #288（缺陷 A + D）：shell 子进程执行期信号。**宿主内部信号，不是 run_events/U3 事件**
   * （agentd 侧只刷 `lastIpcAt` + 记账 pgid，最多 `log('debug', …)`，绝不入事件队列）。
   * `{ run_id, phase: 'spawn'|'heartbeat'|'exit', pgid, command }`：
   *   - `spawn` / `exit`：子命令自成进程组（`detached:true` ⇒ pgid = child.pid），agentd 登记/销登记，
   *     在每一条 worker 终止路径上 SIGKILL worker 组**之后**再逐个 `-pgid` 补杀（缺陷 D）。
   *   - `heartbeat`：命令在跑但零 IPC 期间的保活心跳（缺陷 A），任意 IPC 天然刷 `lastIpcAt`。
   */
  SHELL_LIVENESS: 'shell_liveness',
  /**
   * issue #608（MCP 通道）§6.8：MCP server 子进程的**存活信号**，与 `SHELL_LIVENESS` 同类。
   * `{ run_id, phase: 'spawn'|'exit', pgid, name }`：stdio server 用 `detached:true` 自成进程组
   * （pgid = child.pid），agentd 记账后在**每一条** worker 终止路径上 `-pgid` 补杀。
   * ⚠ 也是**宿主内部信号**：绝不入事件队列（否则多出一条 run_events/U3 事件）。
   * worker 的 `finally` 只能盖住「自己走到收尾」那一条路，watchdog SIGKILL 盖不住（§6.8）。
   */
  MCP_PROCESS: 'mcp_process',
  /**
   * issue #608 §6.1：worker → agentd，要本次 run 的 MCP 配置（**含明文槽值**）。
   * 为什么必须绕这一道：worker 不持 token——`buildWorkerEnv`（agentd.js）**删掉**
   * `ERIX_STATION_TOKEN`，per-container token 只属于 agentd。
   * `{ req_id, run_id }` ⇒ `MCP_CONFIG_RESPONSE`。**一次 run 只取一次**（与技能同口径）。
   */
  MCP_CONFIG_REQUEST: 'mcp_config_request',
  /**
   * issue #608 §6.6：worker → agentd 的元数据回填（`list` 现场发现到的工具清单）。
   * `{ req_id, slug, tools: [{name, description, inputSchema?}] }`：agentd 代发
   * `POST /api/internal/mcp/tools-cache` → portal 写 `manifest.tools_cache`。
   * 为什么要回填：`search` 走的是本地缓存，缓存来自下次物化 ⇒ server 挂掉时仍可搜（§6.6）。
   * 失败只记日志（回填是优化，不是 run 的依赖）。
   */
  MCP_TOOLS_CACHE: 'mcp_tools_cache',
  // agentd → worker
  RUN_START: 'run_start',
  STORE_RESPONSE: 'store_response',
  APPROVAL_DECISION: 'approval_decision',
  ABORT: 'abort',
  /**
   * #370：转向标记（agentd → worker）。**与 `ABORT` 的区别就是 issue #370 的全部要点**：
   * `ABORT` = 「现在就砍」——agentd 同时起 5s SIGKILL 宽限，正在跑的 shell 进进程组被杀；
   * `STEER_ARM` = 「**本轮跑完再停**」——只装一个标记，worker 在 erix-agent 的 `onRound`
   * （本轮已落库、下一次 provider 调用之前）里自己 abort。于是转向的投递点与 pi 的 steer 定义
   * 重合（*after the current assistant turn finishes executing its tool calls, before the next
   * LLM call*）。⇒ 收到它**不得**发 SIGKILL、不得起宽限、不得置 `ctx.dropped`。
   */
  STEER_ARM: 'steer_arm',
  /**
   * issue #608 §6.1：agentd → worker，代 portal 回本 run 的 server 声明**与明文槽值**。
   * `{ req_id, ok, servers: [{name, values:{SLOT:v}}], missing: [{name, slots}], error? }`。
   * 值只经 IPC 内存传递：agentd **不写盘、不写日志**（§10.3）；`ok:false` ⇒ worker 降级为
   * 「本次 run 无 MCP」，**不打死 run**。
   */
  MCP_CONFIG_RESPONSE: 'mcp_config_response',
};

/**
 * store_request 支持的 method（runner §9.1 映射表）。
 * 0.14.0 TranscriptStore 必需 appendRound/load；run-state 是可选能力。
 * `loadRunStateStatus` 是 station 的宿主读接口，不属于引擎能力校验。
 * `recall` 为 **legacy 兼容项**（0.8.0 recall 退役：引擎不再调用、worker 不注册 recall 工具；
 * U7 端点保留只读兼容，见 issue #43 拍板）——不属于 TranscriptStore 契约。
 *
 * ⚠ **`saveRunSnapshot` / `loadLatestRunSnapshot` 已随 issue #640 整条删除**（erix-agent 0.33.0 起引擎
 * 不再调它们，上游 `OPTIONAL_CAPABILITIES` 也已删掉 `runSnapshot` 这个能力名）——不是「暂时摘申报」，
 * 是 IPC 白名单 / agentd 路由 / portal 端点 / 快照表一起退役。
 *
 * issue #500（erix-agent 0.32/0.33 的**账本恢复行**三件套）：`appendRecoveryRow` / `listRecoveryRows` /
 * `clearRecoveryRows` 都是引擎侧**可选**方法，本站全实现。**三个必须同进同出**：引擎按方法名单独探测，
 * 只做一半就是「写了但读不回」（引擎以为证据已落账 ⇒ 比证据缺席更容易把副作用重放一遍）或
 * 「读方法在但永远读不到」。**没有**旧 run 作用域兼容面：恢复行只有 session（transcript key）语义。
 */
export const STORE_METHODS = new Set([
  'appendRound',
  'load',
  // issue #501：引擎 `appendUserTurn` 快路径结清悬空 `tool_use` 的唯一账本来源（与 `load` 同源、不折叠）。
  'loadRawRows',
  'markRunState',
  'saveRunState',
  'loadRunState',
  'loadRunStateStatus',
  // issue #500：账本恢复行（引擎 0.32+/0.33.0 的可选能力，#530 之后没有快照兜底）。
  'appendRecoveryRow',
  'listRecoveryRows',
  'clearRecoveryRows',
  // legacy（0.8.0 recall 退役，非 0.9.0 契约方法）：
  'recall',
]);

/**
 * 规范化 RoundRecord 为 portal U5 请求体。
 * erix-agent v0.3.5 的 appendRound record 使用 roundKey（round 0 种子）或 roundKey+dedupKey（常规轮），
 * portal U5 要求必填 dedupKey（≤256 字符）；这里兜底注入 dedupKey，并对齐 folded/messages/foldedPayload 字段。
 */
export function normalizeRoundRecord(runId, record) {
  const round = Number.isInteger(record?.round) ? record.round : 0;
  const dedupKey = typeof record?.dedupKey === 'string' && record.dedupKey.length > 0
    ? record.dedupKey
    : (typeof record?.roundKey === 'string' && record.roundKey.length > 0
      ? record.roundKey
      : `${String(runId)}:round:${String(round)}`);
  return {
    ...(record ?? {}),
    dedupKey,
    round,
    folded: record?.folded === true,
    messages: Array.isArray(record?.messages) ? record.messages : [],
    foldedPayload: record?.foldedPayload ?? null,
  };
}

/** 生成单调递增的 req_id（worker 侧）。 */
export function createReqIdGenerator() {
  let n = 0;
  return () => ++n;
}

/** 发送 IPC 消息（忽略通道关闭的写失败，避免 shutdown 竞态抛错）。 */
export function sendIpc(proc, msg) {
  // ⚠️ Node IPC 背压语义（真机 bug 实证）：proc.send() 返回 false 有两种含义——
  //   ① channel 已关闭（真失败）；② 消息超过内部缓冲阈值，**已入队**待 'drain'（背压，非失败！）。
  // 原实现把 false 一律当失败 → 大 checkpoint（transcript 增长跨过阈值）被误判
  // 'ipc channel closed' → 引擎 fail-closed → run 在固定 round 确定性失败。
  // 修法：connected 为真时 send 只可能「成功/入队」或「抛错」，false 一律视为已入队成功。
  if (proc && typeof proc.send === 'function' && proc.connected) {
    try {
      proc.send(msg);
      return true;
    } catch (err) {
      // 序列化失败（BigInt/循环引用）或 send 时 channel 恰好关闭——真失败，留痕。
      lastSendError = err?.message ?? String(err);
      return false;
    }
  }
  lastSendError = 'channel closed';
  return false;
}

/** 最近一次 sendIpc 失败的真实原因（ipcRequest reject 时透传，避免误诊）。 */
export let lastSendError = null;
