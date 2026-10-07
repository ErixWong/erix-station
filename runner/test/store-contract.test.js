// station store adapter（runner/lib/store.js，IPC 版 TranscriptStore）契约测试 harness。
// 对 adapter 跑上游 transcriptStoreContract（erix-agent/contract-tests，0.14.0：
// latest-only run snapshot、独立状态通道、多 runId 隔离、写失败向上抛）。
// agentd + portal 用内存 IPC peer 桩掉（语义 = portal internal 端点：snapshot revision CAS、
// run-state 快照/状态分列、多 runId 隔离），transport 注入 adapter——不 fork 进程、不碰网络/DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptStoreContract } from 'erix-agent/contract-tests';
import { makeStore } from '../lib/store.js';
import { STORE_METHODS } from '../lib/ipc.js';

/** 内存 IPC peer 桩：模拟 agentd → portal internal 端点的 store 语义。 */
function createFakeAgentdPeer() {
  const transcripts = new Map(); // runId -> round records[]
  const snapshots = new Map(); // runId -> {snapshot, revision}
  const runStates = new Map();   // runId -> object
  const runStateStatuses = new Map(); // runId -> {status}

  const peer = {
    calls: [],
    async handle(method, args = {}) {
      peer.calls.push({ method, args });
      const runId = args.runId;
      switch (method) {
        case 'appendRound': {
          const list = transcripts.get(runId) ?? [];
          if (list.some((r) => r.round === args.record?.round)) {
            const err = new Error('round_conflict');
            err.code = 'round_conflict';
            err.retryable = false;
            throw err;
          }
          list.push(structuredClone(args.record));
          transcripts.set(runId, list);
          return { inserted: true };
        }
        case 'load': {
          const list = (transcripts.get(runId) ?? []).map((r) => structuredClone(r));
          list.sort((a, b) => a.round - b.round);
          return { records: list };
        }
        case 'recall':
          return { text: '' };
        case 'markRunState': {
          runStateStatuses.set(runId, { status: args.state, runId });
          return { ok: true };
        }
        case 'saveRunState': {
          runStates.set(runId, { ...(runStates.get(runId) ?? {}), ...structuredClone(args.runState), runId });
          return { ok: true };
        }
        case 'loadRunState': {
          const state = runStates.get(runId);
          return state === undefined ? null : { run_state: structuredClone(state) };
        }
        case 'loadRunStateStatus': {
          const status = runStateStatuses.get(runId);
          if (status) return { status: structuredClone(status) };
          const legacy = runStates.get(runId)?.state;
          return typeof legacy === 'string' ? { status: { status: legacy } } : null;
        }
        case 'saveRunSnapshot': {
          const current = snapshots.get(runId);
          const revision = Number(args.revision ?? 0);
          if (current && revision <= current.revision) {
            const err = new Error('checkpoint revision 不大于当前');
            err.code = 'checkpoint_stale';
            err.retryable = false;
            throw err;
          }
          snapshots.set(runId, { snapshot: structuredClone(args.snapshot), revision });
          return { revision };
        }
        case 'loadLatestRunSnapshot': {
          const cp = snapshots.get(runId);
          if (!cp) return null;
          return { checkpoint: { snapshot: structuredClone(cp.snapshot), revision: cp.revision } };
        }
        default:
          throw new Error(`unknown method: ${method}`);
      }
    },
  };
  return peer;
}

test('STORE_METHODS：0.14.0 必需/可选契约与 status 读接口在 IPC 白名单内；recall 为 legacy 兼容项', async () => {
  const upstreamContract = [
    'appendRound', 'load', 'saveRunSnapshot', 'loadLatestRunSnapshot',
    'saveRunState', 'loadRunState', 'markRunState',
    'loadRunStateStatus',
  ];
  for (const m of upstreamContract) {
    assert.ok(STORE_METHODS.has(m), `STORE_METHODS 缺 ${m}`);
  }
  // adapter 覆盖两个必需方法及所有可选能力/宿主 status reader。
  const peer = createFakeAgentdPeer();
  const store = makeStore('surface-run', { request: (method, args) => peer.handle(method, args) });
  for (const m of upstreamContract) {
    assert.equal(typeof store[m], 'function', `adapter 缺 ${m}`);
  }
  assert.equal(typeof store.saveCheckpoint, 'undefined', '旧快照方法名不得暴露给引擎');
  assert.equal(typeof store.loadLatestCheckpoint, 'undefined', '旧快照方法名不得暴露给引擎');
  // recall：legacy（0.8.0 退役），保留但标注为非契约方法。
  assert.ok(STORE_METHODS.has('recall'), 'recall 保留（legacy 只读兼容）');
  assert.ok(!upstreamContract.includes('recall'), 'recall 不属于 0.14.0 TranscriptStore 能力');
});

// 上游契约套件（transcriptStoreContract 会注册多个 node:test 用例）。
transcriptStoreContract('station-ipc-store', async () => {
  const peer = createFakeAgentdPeer();
  return makeStore('contract-run', { request: (method, args) => peer.handle(method, args) });
});

test('station-ipc-store：agentd 写入失败向上抛（IPC error 透传，fail-closed 语义）', async () => {
  const peer = createFakeAgentdPeer();
  const store = makeStore('run-x', { request: (method, args) => peer.handle(method, args) });
  await store.appendRound('run-x', { round: 1, ts: '2026-09-22T00:00:00.000Z', messages: [] });

  // 模拟 portal 5xx（可重试）后成功：adapter 内部重试应对调用方透明。
  let calls = 0;
  const flakyPeer = {
    async handle(method, args) {
      calls += 1;
      if (calls === 1) {
        const err = new Error('boom');
        err.code = 'network_error';
        err.retryable = true;
        throw err;
      }
      return peer.handle(method, args);
    },
  };
  const flakyStore = makeStore('run-x', { request: (method, args) => flakyPeer.handle(method, args) });
  const loaded = await flakyStore.load('run-x');
  assert.equal(loaded.length, 1);
  assert.equal(calls, 2);
});

test('run-state status reader：读 status?.status、legacy fallback、malformed response 抛错', async () => {
  const statusPeer = {
    async handle(method) {
      if (method === 'loadRunStateStatus') return { status: { status: 'succeeded' } };
      throw new Error(`unexpected method ${method}`);
    },
  };
  const store = makeStore('run-status', { request: (method, args) => statusPeer.handle(method, args) });
  assert.equal(await store.loadRunStateStatus('run-status'), 'succeeded');

  const malformedStore = makeStore('run-status', {
    request: async () => ({ status: { status: 7 } }),
  });
  await assert.rejects(() => malformedStore.loadRunStateStatus('run-status'), /malformed run-state status/);
});
