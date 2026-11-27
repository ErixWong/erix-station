// station store adapter（runner/lib/store.js，IPC 版 TranscriptStore）契约测试 harness。
// 对 adapter 跑上游 transcriptStoreContract（erix-agent/contract-tests，0.16.0：
// 独立状态通道、多 runId 隔离、写失败向上抛、RoundRecord/message 保真往返、
// 同 round 按持久化追加序）。
// agentd + portal 用内存 IPC peer 桩掉（语义 = portal internal session 端点：
// run-state 快照/状态分列、多 runId 隔离、同 round 不同 dedupKey 共存 + dedupKey 幂等），
// transport 注入 adapter——不 fork 进程、不碰网络/DB。
//
// ⚠ **run snapshot 已退役（issue #640）**：0.33.0 的上游套件里 `runSnapshot` 能力名与方法名都是 0 命中，
//   本文件的 peer 桩也不再实现 `saveRunSnapshot` / `loadLatestRunSnapshot`（末尾那条反向自证钉住它）。
//   本仓历史注释里提到的 0.14–0.32 时代语义（latest-only snapshot / revision CAS）只是来历，不是现状。
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
// issue #501：必需方法清单 / #640 退役清单 / legacy 清单 / 能力申报全部搬到
// `./store-contract-surface.js`（唯一一份），`agentd-store-route.test.js` 的 #501 判据 2/3 复用同一份。
import {
  UPSTREAM_CONTRACT_METHODS, RETIRED_STORE_METHODS, DECLARED_OPTIONAL_CAPABILITIES,
} from './store-contract-surface.js';

/** 内存 IPC peer 桩：模拟 agentd → portal internal 端点的 store 语义。 */
function createFakeAgentdPeer() {
  const transcripts = new Map(); // runId -> round records[]
  const runStates = new Map();   // runId -> object
  const runStateStatuses = new Map(); // runId -> {status}
  const recoveryRows = new Map(); // runId -> 恢复行 [{dedupKey, record}]（数组序 = append_seq）

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
        // issue #501：peer = portal internal 端点，本就不折叠（折叠是 `makeStore.load` 的职责），
        // 故 `loadRawRows` 与 `load` 在桩里**同源**（同一批原始行、同一排序）；两 case 直接穿透。
        case 'load':
        case 'loadRawRows': {
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
        // ⚠ 旧 `saveRunSnapshot` / `loadLatestRunSnapshot` 两条路由已随 issue #640 删除（表也 DROP 了）。
        // 本 peer **不实现它们**：任何代码或上游套件重新调这两个名字，就会得到下面 `default` 的
        // `unknown method` ⇒ 当场红，而不是静默「看起来能用」（末尾有显式反向自证）。
        // ── issue #500：账本恢复行三条路由 ──
        //
        // 为什么必须在这里补：`makeStore()` 自本单起**带着**这三个方法，本 peer 站的是 agentd 的位置
        // —— 不补这三条就是 `unknown method`（任何碰到恢复行的用例当场红，与恢复行本身的对错无关）。
        // ⚠ **随包契约套件并不覆盖恢复行**：现查 0.33.0 的 `OPTIONAL_CAPABILITIES` 只有
        //   `runState` / `runStateStatus` / `rawRows` / `fastPathProbes` 四组，没有恢复行那一组
        //   ⇒ 本站**不往 `optionalCapabilities` 申报里加东西**（申报一个名单里没有的能力名会被
        //   「守卫写错了能力名」当场判红），恢复行的判据由 `recovery-rows-adapter.test.js` 自己写。
        //
        // 语义 = portal `appendSessionRecoveryRow` / `listSessionRecoveryRows` / `clearSessionRecoveryRows`
        // 四个判据（幂等 / 冲突 / 清空 true|false / 按落盘序返回），幂等判据**与 portal 同一把尺**
        // （本文件头那句「peer 桩模拟的是 portal 端点语义，不得另抄一份」在本族同样成立）。
        case 'appendRecoveryRow': {
          const list = recoveryRows.get(runId) ?? [];
          const record = structuredClone(args.record);
          const dedupKey = record?.dedupKey;
          if (typeof dedupKey !== 'string' || dedupKey === '') {
            const err = new Error('transcript recovery row rejected: record.dedupKey is required');
            err.retryable = false;
            throw err;
          }
          const existing = list.find((entry) => entry.dedupKey === dedupKey);
          if (existing) {
            if (samePayload(existing.record, record)) return { added: false };   // 幂等跳过（顶层 ts/round 漂了仍算重放）
            throw dedupPayloadConflict({
              runId,
              key: transcriptRecordKey(runId, record),
              existing: existing.record,
              incoming: record,
              existingFingerprint: payloadFingerprint(existing.record),
              incomingFingerprint: payloadFingerprint(record),
            });
          }
          list.push({ dedupKey, record });   // 数组序 = 持久化追加序（= 真库的 append_seq）
          recoveryRows.set(runId, list);
          return { added: true };
        }
        case 'listRecoveryRows': {
          const list = recoveryRows.get(runId) ?? [];
          return { rows: list.map((entry) => structuredClone(entry.record)) };
        }
        case 'clearRecoveryRows': {
          const had = (recoveryRows.get(runId) ?? []).length > 0;
          recoveryRows.set(runId, []);
          return { cleared: had };   // true = 至少删了一行；false = 本来就没有
        }
        default:
          throw new Error(`unknown method: ${method}`);
      }
    },
  };
  return peer;
}

test('STORE_METHODS：必需/可选契约与 status 读接口在 IPC 白名单内；recall 为 legacy 兼容项；快照两面已退役', async () => {
  const upstreamContract = UPSTREAM_CONTRACT_METHODS;
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
  // **反向自证（issue #640）**：快照本体也已退役——不是「换了个名字」，而是整条竖切（IPC 白名单 /
  // agentd 路由 / portal 端点 / 快照表）都没了。名字一旦回来（引擎回退或有人
  // 「顺手补上」），本用例会红，而不是默默多一个没人调的方法。
  for (const retired of RETIRED_STORE_METHODS) {
    assert.equal(typeof store[retired], 'undefined', `快照方法 ${retired} 已随 #640 退役，不得再现`);
    assert.equal(STORE_METHODS.has(retired), false, `IPC 白名单不得再包 ${retired}`);
  }
  // recall：legacy（0.8.0 退役），保留但标注为非契约方法。
  assert.ok(STORE_METHODS.has('recall'), 'recall 保留（legacy 只读兼容）');
  assert.ok(!upstreamContract.includes('recall'), 'recall 不属于 0.14.0 TranscriptStore 能力');
});

// 上游契约套件（transcriptStoreContract 会注册多个 node:test 用例）。
// 第三个参数是**诚实申报**（erix-agent 0.30.0 上游 #739 把「可选」做实，#499 升级片把本站的申报补齐；
// 名单自 #501 起住在 `./store-contract-surface.js` 的 `DECLARED_OPTIONAL_CAPABILITIES`，
// 与 `agentd-store-route.test.js` 的 #501 判据 3 共用一份 ⇒ 只改一边必红）：
//   · `runState`（`saveRunState` + `loadRunState` + `markRunState`）、`runStateStatus`（`loadRunStateStatus`）
//     ——本站这两组**真实现**（`runner/lib/store.js` + peer 桩后的 portal internal 端点），所以申报出来：
//     实现被删时套件当场红，而不是被成对守卫当「宿主本来就没选这个能力」静默跳过；
//   · `rawRows`（`loadRawRows`）**本站已有**（#501：portal `createSessionTranscriptStore` 与
//     `runner/lib/store.js` 都补了这根探针，且与 `load()` 共用**同一条读路径** ⇒ `foldMessageRows(loadRawRows(id))`
//     逐字等于 `load(id)`）⇒ **整组报出来**（报半组会被「声明了却没整组实现」当场判红）；
//   · `fastPathProbes`（`loadByDedupKey` + `loadMaxRound`）仍**本站没有** ⇒ 不报（点查探针跑在 portal
//     POST 事务内，不经这条 IPC 契约面）。
//
// ⚠ **erix-agent 0.33.0（issue #838 S2，本站 #530）：`runSnapshot` 这个能力名已从上游名单里删除**
//   （现查 0.33.0：`test/contract/transcript-store.js` 里 `runSnapshot` **0 命中**；`OPTIONAL_CAPABILITIES`
//   只剩 `runState` / `runStateStatus` / `rawRows` / `fastPathProbes` 四组）。本站当时只是**从申报里摘掉**，
//   方法本体连同 IPC 白名单 / agentd 路由 / portal 端点 / 快照表一起留给了另单——
//   **那个另单已落地：issue #640 把整条竖切删干净了**（表由迁移 `0041` DROP）。
//   ⇒ 本文件的 peer 桩不再实现快照方法，上面的反向自证钉住「不得再加回来」。
transcriptStoreContract('station-ipc-store', async () => {
  const peer = createFakeAgentdPeer();
  return makeStore('contract-run', { request: (method, args) => peer.handle(method, args) });
}, { optionalCapabilities: DECLARED_OPTIONAL_CAPABILITIES });

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
