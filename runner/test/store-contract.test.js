// station store adapter（runner/lib/store.js，IPC 版 TranscriptStore）契约测试 harness。
// 对 adapter 跑上游 transcriptStoreContract（erix-agent/contract-tests，0.16.0：
// latest-only run snapshot、独立状态通道、多 runId 隔离、写失败向上抛、RoundRecord/message 保真往返、
// 同 round 按持久化追加序）。
// agentd + portal 用内存 IPC peer 桩掉（语义 = portal internal session 端点：snapshot revision CAS、
// run-state 快照/状态分列、多 runId 隔离、同 round 不同 dedupKey 共存 + dedupKey 幂等），
// transport 注入 adapter——不 fork 进程、不碰网络/DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptStoreContract } from 'erix-agent/contract-tests';
import { makeStore } from '../lib/store.js';
// #333 M2：peer 桩模拟的是 **portal internal 端点**的轮记录语义 ⇒ 幂等/冲突判据必须与 portal
// 用同一把尺，不得在 runner 侧另抄一份。测试面跨包引 portal 源码有先例
// （`runner/test/system-prompt.test.js:173` 引 `portal/src/previewpool.js`）；
// runner 的**运行期**代码（lib/store.js、agentd.js）仍零 portal 依赖——判据本来就在 portal 侧。
import {
  payloadFingerprint, samePayload, dedupPayloadConflict, transcriptRecordKey,
} from '../../portal/src/transcript-payload.js';
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
          // 0.16.0 语义（= portal putSessionRound）：同 round、不同 dedupKey 的记录合法共存；
          // 幂等判据 = dedupKey（同 dedupKey 同内容 → no-op；folded false→true → UPDATE；
          // 同 dedupKey 不同 body → round_conflict）。无 dedupKey 的契约记录（ROUND_1 等）视为唯一追加。
          const list = transcripts.get(runId) ?? [];
          const record = structuredClone(args.record);
          // 键的取法 = 上游 recordKey / runner lib/ipc.js normalizeRoundRecord 同式
          // （dedupKey ?? roundKey ?? `<key>:round:<n>`；原先的 `__auto:<n>` 自造哨兵会让契约
          // 第 22 条的隐式键断言与「同 payload 重放幂等」双双失效）。
          const dedupKey = transcriptRecordKey(runId, record);
          const existing = list.find((entry) => entry.dedupKey === dedupKey);
          if (existing) {
            // 判据 = portal 的 payload 指纹（顶层 ts/round 漂了仍算重放；数组顺序/宿主字段算内容）。
            if (samePayload(existing.record, record)) return { inserted: false }; // 幂等命中
            if (record.folded === true && existing.record.folded !== true) {
              existing.record = record; // fold 更新（同 dedupKey）
              return { inserted: true };
            }
            // store 面（引擎看得见的这一面）按随包契约用 `dedup_payload_conflict` 这个 code；
            // 真系统里 portal internal 端点回的是 409 `round_conflict`（零新错误码），两面同方向
            // 且都不可重试 ⇒ adapter 一律上抛 ⇒ 引擎按持久化失败处理。
            throw dedupPayloadConflict({
              runId,
              key: dedupKey,
              existing: existing.record,
              incoming: record,
              existingFingerprint: payloadFingerprint(existing.record),
              incomingFingerprint: payloadFingerprint(record),
            });
          }
          list.push({ dedupKey, record }); // 数组序 = 持久化追加序
          transcripts.set(runId, list);
          return { inserted: true };
        }
        case 'load': {
          const list = transcripts.get(runId) ?? [];
          // 同 round 按追加序（数组序，稳定排序）；引擎不再二次排序（0.16.0 契约）。
          const records = list
            .map((entry, index) => ({ record: structuredClone(entry.record), index }))
            .sort((a, b) => (a.record.round - b.record.round) || (a.index - b.index))
            .map((entry) => entry.record);
          return { records };
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
