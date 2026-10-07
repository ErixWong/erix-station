// station TranscriptStore adapter（IPC 版，runner-integration §9；0.14.0 仅要求 appendRound/load）。
// worker 每 run 一个实例；transport 可注入（生产 = IPC store_request → agentd → portal internal 端点；
// 测试 = 内存 IPC peer 桩）。契约锚点：erix-agent test/contract/transcript-store.js（transcriptStoreContract）。
//
// issue #81 P2（docs/design/conversation-state.md §4.1）：store key 切 session 维度——引擎传来的
// 方法参数 r（=runToolLoop 的 runId 选项）就是 transcript key（sessionId），原样转发新 session
// 端点；makeStore 的第一参只是缺省 key，契约/测试可直接用任意 key 调用各方法（多 key 隔离）。
//
// ⚠️ run 状态与终态记录分离：
//   - 'running'：runs 表生命周期信号（U2 /runs/:id/state）——按 **真 runId**（worker IPC 下行），
//     transcript key（sessionId）绝不进 U2。runId 缺省（旧调用/契约测试）→ 回退引擎传入的 key。
//   - markRunState 的状态写入独立 status 通道；saveRunState 只写 run-state 快照。
//
// 方法 → IPC method → internal 端点（§9.1 映射表）：
//   appendRound          → PUT /transcript/:key/rounds/:round        （session，P2 新增）
//   load                 → GET /transcript/:key                      （session，P2 新增）
//   recall               → GET /runs/:id/transcript/recall          （U7 legacy，保持 run 作用域不动）
//   markRunState         → PUT /runs/:id/state（'running'，真 runId） （U2）
//                          → PUT /transcript/:key/runstate {state}（状态通道，session）
//   saveRunSnapshot      → PUT /transcript/:key/checkpoint           （session，revision CAS）
//   loadLatestRunSnapshot→ GET /transcript/:key/checkpoint/latest    （session）
//   saveRunState         → PUT /transcript/:key/runstate {run_state} （session）
//   loadRunState         → GET /transcript/:key/runstate              （session；无 → undefined）
//   loadRunStateStatus   → GET /transcript/:key/runstate/status       （session；返回 status?.status）
//   （旧 run 作用域 U5–U9/runstate 端点保留不动，供旧 runner/旧 agentd 兼容——本 adapter 自 P2 起只走 session 端点。）
const RETRY_DELAYS = [1000, 2000, 5000];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} key transcript key（缺省；生产 = sessionId）
 * @param {{request:(method:string, args:object)=>Promise<any>, runId?:string}} options
 *   request：IPC transport（生产侧接 ipcRequest）；runId：真 runId（U2 'running' 上报用，缺省回退 key）
 */
export function makeStore(key, { request, runId }) {
  let revision = 0;

  async function requestWithRetry(method, args) {
    let lastErr;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        return await request(method, args);
      } catch (err) {
        lastErr = err;
        const retryable = err?.retryable === true && err?.code !== 'checkpoint_stale';
        if (!retryable || attempt >= RETRY_DELAYS.length) throw err;
        const delay = RETRY_DELAYS[attempt] * (0.8 + Math.random() * 0.4);
        await sleep(delay);
      }
    }
    throw lastErr;
  }

  return {
    async appendRound(r, record) {
      await requestWithRetry('appendRound', { runId: r, record });
    },
    async load(r) {
      const res = await requestWithRetry('load', { runId: r });
      return Array.isArray(res?.records) ? res.records : [];
    },
    async recall(r, fromRound, toRound, pattern) {
      const res = await requestWithRetry('recall', { runId: r, fromRound, toRound, pattern });
      return typeof res?.text === 'string' ? res.text : '';
    },
    async markRunState(r, state) {
      if (state === 'running') {
        // 'running' 是 runs 表生命周期信号：按真 runId 走 U2（见头注释双路语义拆分）。
        // erix-agent 在 start 调 'running'；终态（runs.status）由 worker 在 runToolLoop
        // resolve/reject 后经 run_finished → agentd U2 上报（§6.3-9），不经此处。
        await requestWithRetry('markRunState', { runId: runId ?? r, state });
        return;
      }
      // 引擎终态标记走独立 status 通道；不合并进 run-state 快照，也不触碰 runs.status。
      await requestWithRetry('markRunState', { runId: r, state });
    },
    async saveRunState(r, runState) {
      const snapshot = { ...(runState ?? {}) };
      delete snapshot.state;
      await requestWithRetry('saveRunState', { runId: r, runState: snapshot });
    },
    async loadRunState(r) {
      const res = await requestWithRetry('loadRunState', { runId: r });
      return res?.run_state ?? undefined;
    },
    async loadRunStateStatus(r) {
      const res = await requestWithRetry('loadRunStateStatus', { runId: r });
      if (res?.status == null) return undefined;
      if (typeof res.status !== 'object' || Array.isArray(res.status)
          || typeof res.status.status !== 'string' || res.status.status.length === 0) {
        throw new Error(`malformed run-state status response for ${String(r)}`);
      }
      return res.status.status;
    },
    async saveRunSnapshot(r, snapshot) {
      revision += 1;
      try {
        await requestWithRetry('saveRunSnapshot', { runId: r, revision, snapshot });
      } catch (err) {
        // §9.5：revision <= 当前 → checkpoint_stale 视为「本快照已过期」，不重试、不抛（继续以最新为准）。
        if (err?.code === 'checkpoint_stale') return;
        throw err;
      }
    },
    async loadLatestRunSnapshot(r) {
      const res = await requestWithRetry('loadLatestRunSnapshot', { runId: r });
      if (!res || !res.checkpoint) {
        revision = 0;
        return undefined;
      }
      revision = Number(res.checkpoint.revision ?? 0);
      return res.checkpoint.snapshot;
    },
  };
}
