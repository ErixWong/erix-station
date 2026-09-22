// station TranscriptStore adapter（IPC 版，runner-integration §9；0.9.0 起引擎 fail-closed 校验 8 方法）。
// worker 每 run 一个实例；transport 可注入（生产 = IPC store_request → agentd → portal internal 端点；
// 测试 = 内存 IPC peer 桩）。契约锚点：erix-agent test/contract/transcript-store.js（transcriptStoreContract）。
//
// 方法 → IPC method → internal 端点（§9.1 映射表）：
//   appendRound          → PUT /runs/:id/transcript/rounds/:round   （U5）
//   load                 → GET /runs/:id/transcript                 （U6）
//   recall               → GET /runs/:id/transcript/recall          （U7，0.8.0 起引擎不再调用；端点保留）
//   markRunState         → PUT /runs/:id/state（'running'）          （U2）
//                          → PUT /runs/:id/runstate {state}（引擎终态标记，合并进 run_state blob）
//   saveCheckpoint       → PUT /runs/:id/checkpoint                 （U8，revision CAS）
//   appendCheckpoint     → 同 saveCheckpoint（上游 file 实现即别名）
//   loadLatestCheckpoint → GET /runs/:id/checkpoint/latest          （U9）
//   saveRunState         → PUT /runs/:id/runstate {run_state}       （0.6.0 新增，落 runs.run_state jsonb）
//   loadRunState         → GET /runs/:id/runstate                   （0.6.0 新增；无 → undefined）
const RETRY_DELAYS = [1000, 2000, 5000];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} runId
 * @param {{request:(method:string, args:object)=>Promise<any>}} transport IPC transport（生产侧接 ipcRequest）
 */
export function makeStore(runId, { request }) {
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
        // erix-agent 在 start 调 'running'；终态（runs.status）由 worker 在 runToolLoop
        // resolve/reject 后经 run_finished → agentd U2 上报（§6.3-9），不经此处。
        await requestWithRetry('markRunState', { runId: r, state });
        return;
      }
      // 引擎终态标记（succeeded / unverified_error / guard_error，0.9.0 termination.js finish()）：
      // 合并进 runs.run_state blob（reference 语义 = 上游 file store 的 markRunState 合并写）；
      // 不触碰 runs.status——宿主终态唯一权威仍是 U2（不变式 3）。
      await requestWithRetry('markRunState', { runId: r, state });
    },
    async saveRunState(r, runState) {
      await requestWithRetry('saveRunState', { runId: r, runState });
    },
    async loadRunState(r) {
      const res = await requestWithRetry('loadRunState', { runId: r });
      return res?.run_state ?? undefined;
    },
    async saveCheckpoint(r, checkpoint) {
      revision += 1;
      try {
        await requestWithRetry('saveCheckpoint', { runId: r, revision, snapshot: checkpoint });
      } catch (err) {
        // §9.5：revision <= 当前 → checkpoint_stale 视为「本快照已过期」，不重试、不抛（继续以最新为准）。
        if (err?.code === 'checkpoint_stale') return;
        throw err;
      }
    },
    async appendCheckpoint(r, checkpoint) {
      await this.saveCheckpoint(r, checkpoint);
    },
    async loadLatestCheckpoint(r) {
      const res = await requestWithRetry('loadLatestCheckpoint', { runId: r });
      if (!res || !res.checkpoint) {
        revision = 0;
        return undefined;
      }
      revision = Number(res.checkpoint.revision ?? 0);
      return res.checkpoint.snapshot;
    },
  };
}
