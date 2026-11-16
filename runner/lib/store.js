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
//   appendRecoveryRow    → PUT /transcript/:key/recovery-rows         （session，issue #500；true/false）
//   listRecoveryRows     → GET /transcript/:key/recovery-rows          （session，#500；返回**数组**）
//   clearRecoveryRows    → DELETE /transcript/:key/recovery-rows       （session，#500；true/false 原样透出）
//   （旧 run 作用域 U5–U9/runstate 端点保留不动，供旧 runner/旧 agentd 兼容——本 adapter 自 P2 起只走 session 端点。
//   恢复行**没有** run 作用域旧端点可回退：那张新表只有一个键列，agentd 侧 sessionKey 缺失就是抛错。）
import { foldLedgerRecords } from './transcript-fold.js';

const RETRY_DELAYS = [1000, 2000, 5000];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} key transcript key（缺省；生产 = sessionId）
 * @param {{request:(method:string, args:object)=>Promise<any>, runId?:string}} options
 *   request：IPC transport（生产侧接 ipcRequest）；runId：真 runId（U2 'running' 上报用，缺省回退 key）
 */
// ── issue #500：恢复行布尔判据的读法（模块级，`makeStore` 之外）──
/**
 * 从 `{added}` / `{cleared}` 应答里取那个布尔。**只对「完全没有应答」fail-closed**：
 * `null` / 非对象 ⇒ 抛（传输层没给出可判定的答案；把它说成 `false` 就是替 portal 编一句
 * 「本来就没有」，而那正是 #500 要防的「把唯一的执行证据说成没有证据」）。
 * 应答是对象但缺这个布尔 ⇒ 读成 `false`：本站 portal 端点恒发 `{added}` / `{cleared}`，
 * 真缺字段说明对端是老版本，此时偏保守的解释是「没写成 / 没删动」——**不会**把
 * 「可能没落账」说成「已落账」。
 * ⚠ 本族唯一被契约点名的 fail-closed 判据在**读**面（`listRecoveryRows` 的「非数组 ⇒ 抛」，
 *   见下面那个方法），它比这里严格，是故意的（引擎要的是 `recovery_rows_unreadable`，不是空账本）。
 */
function readFlag(res, field, method, key) {
  if (res === null || typeof res !== 'object') {
    throw new Error(`malformed ${method} response for ${String(key)}`
      + ` (expected object with {${field}:boolean}, got ${res === null ? 'null' : typeof res})`);
  }
  return res[field] === true;
}


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
      const records = Array.isArray(res?.records) ? res.records : [];
      // issue #351：上游 0.23.0 的读侧折叠属于 **store 的职责**，不是引擎的职责。
      // `host-consumer-contract.md:2405-2409`：`foldMessageRows` 由 file/memory 两个内置 store 的
      // `load()` 调用，折回轮行才是「host-visible shape of load()」；`:2442`：宿主读账本必须经
      // `load()`。引擎 resume 只调 `foldLedgerMessages`（只把 `partOf` 分片接回原消息），**不做载体
      // 折叠**；`resume-manager.js:239-241` 的 `seq` 播种注释也写明它面向的是「折叠过的输出」。
      // 本站过去直通 portal 原始行 ⇒ 引擎拿到的序列里 `tool_use` 与它的 `tool_result` 之间可以夹一条
      // `:input:` 文本（真标本 index 56），链式 `partOf` 也能把聚合结果劈成两条（index 81）
      // ⇒ 会话永久 `invalid_messages`。
      // 折在全量拉齐之后（agentd `case 'load'` 已把游标翻页聚合成一个数组）；无消息行的账本（≤ 0.22）
      // 由 `foldLedgerRecords` 原样返回**入参本身**，一个字节不改。
      return foldLedgerRecords(records);
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
    // ── issue #500：账本恢复行三件套（erix-agent 0.32/0.33 的可选能力面，本站全实现）──
    //
    // 三个都**可选**，但本站不允许「在而做错」：引擎按方法名单独探测，名字就是契约。
    //   · 读方法「在但 reject / 返回非数组」⇒ 引擎终局 `recovery_rows_unreadable`；
    //   · 写方法「在而什么都不存」⇒ 引擎以为「执行过了」已落账，实际没落，比证据缺席更容易把
    //     副作用重放一遍。
    // ⇒ 本层的一条纪律：**不吞错、不把畸形应答翻译成「空」**。「空」在契约里只有一个形状
    //（`{rows: []}`），把它与「读坏了」混成一谈就是 #500 要修的那个洞本身。
    // 重试预算在 agentd 那一层已经是有限的（`RECOVERY_ROWS_MAX_RETRIES`），本站这层
    // `requestWithRetry` 只重试 `err.retryable === true` 的错误，两层叠起来仍是**有限**。
    /**
     * 追加一条恢复行（引擎在**执行器返回那一刻**写 `tool-executed`，早于结果行与任何快照写）。
     * @returns {Promise<boolean>} `true` = 写入；`false` = 同 dedupKey 同 payload 的幂等跳过。
     */
    async appendRecoveryRow(r, record) {
      const res = await requestWithRetry('appendRecoveryRow', { runId: r, record });
      return readFlag(res, 'added', 'appendRecoveryRow', r);
    },
    /**
     * 读该 key 的全部恢复行（引擎 resume 时读，按落盘序）。
     * @returns {Promise<object[]>} **数组**；空数组 = 这条 run 没有恢复行（唯一可以静默兜底的回答）。
     * 应答形状不合（不是数组）⇒ **抛出去**：引擎要的是 `recovery_rows_unreadable`，不是空账本。
     */
    async listRecoveryRows(r) {
      const res = await requestWithRetry('listRecoveryRows', { runId: r });
      const rows = res?.rows;
      if (!Array.isArray(rows)) {
        throw new Error(`malformed listRecoveryRows response for ${String(r)}`
          + ` (expected {rows:array}, got ${res === null ? 'null' : typeof rows})`);
      }
      return rows;
    },
    /**
     * fresh start 清盘（引擎在 `resume !== true` 的第一件事）。`true`/`false` **原样透出**：
     * `true` = 至少删了一行，`false` = 本来就没有。两者都是成功；只有**抛错**才是契约里那个
     * `recovery_rows_clear` 终局 ⇒ 本站不许把「删不动」与「没删成」混成一谈。
     */
    async clearRecoveryRows(r) {
      const res = await requestWithRetry('clearRecoveryRows', { runId: r });
      return readFlag(res, 'cleared', 'clearRecoveryRows', r);
    },
  };
}
