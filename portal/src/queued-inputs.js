// 对话输入队列（issue #370，portal.md §4.3a/§4.3b）。
//
// 一句话：任务运行中用户照常说话，话进两条队列——`steer`（转向：打断当前 run、用这句话继续）
// 与 `follow_up`（排队：当前 run 正常结束后依次发）。整条机制照 pi/pi-web，只有三处本站化改造：
//   ① 队列真相在 DB（`queued_inputs`），不在浏览器 state，也不在引擎进程内存（不变式 3）；
//   ② 投递由 portal 在 **run 终态**处驱动，不是浏览器的 agent_end 回调 ⇒ 关页面也照样发；
//   ③ 转向 = 「`onRound` 轮边界 abort + 新 run `resume` 续接」，投递点与 pi 的 steer 重合，
//      代价是多一个 run（各自一份 maxRounds 预算）。同 run 内注入是 P2 的上游优化。
//
// 照抄 pi 的三条口径（证据在 #370「参照系」节，动本文件前先读那条）：
//   * **入队与直发的判定必须在服务端事务内**（pi `agent-session.js:1633` 读完 isStreaming 就分岔，
//     中间不 await）。反过来——前端先看 running 再决定调哪个端点——在「点发送那一刻 run 刚好结束」
//     时会退化成 409，pi 的注释管这叫 *strand a message in an idle queue*。
//   * **只有整队取回**，没有单条删除（pi `clear_queue` → `clearAllQueues()`：单条删要和 loop 的
//     pull 竞态）。
//   * **停止不清队列**：`abort()` 不碰队列（pi `agent.js:218`），aborted 轮留下的 follow_up 在
//     **下一次 run 终态**时自动带出（pi `continue()` 先 steering 后 followUp），不是等用户点取回。
//
// 依赖方向：本文件可被 `internal.js` / `provisioner.js` import（终态出队接线），所以它
// **不得** import `internal.js`——SSE 推送一律由调用方注入（`notify` / `notifySteer`）。
import {
  ACTIVE_RUN_STATES, fetchSession, SessionError, postMessage, validateMessageBody,
} from './sessions.js';

/** 每会话未投递条数上限。pi 无上限（`PendingMessageQueue.enqueue` 裸 push），本站必须钉一个：
 *  每条 follow_up 都是一个新 run（各带 `maxRounds` 预算），无人看管时不能没有上界。 */
export const MAX_QUEUED_INPUTS_PER_SESSION = 20;

/** 认领（`delivering`）多久后可以被重新认领：覆盖「认领了但进程崩在建 run 之前」的窗口。
 *  取值远大于一次 `postMessage` 事务的正常耗时，又远小于人工发现卡住的时间。 */
export const CLAIM_STALE_MS = 60_000;

/** 什么算「正常终态」——只有它才投递 follow_up。口径同 `RUN_TERMINATION_SYSERR_REASONS` 的反面：
 *  用户停止（aborted）与故障（failed / persistence_failed / max_rounds_cap / …）都**不**投。 */
const NORMAL_END_REASONS = new Set(['end_turn', 'no_tool', 'judge_done']);

/** kind 白名单（纯函数，端点在校验体之前调它，免得非法 kind 白占幂等占位行）。 */
export function validateQueuedKind(kind) {
  if (kind !== 'steer' && kind !== 'follow_up') {
    throw new SessionError('validation_failed', "kind 必须是 'steer' 或 'follow_up'", {
      details: { field: 'kind' },
    });
  }
  return kind;
}

/** 队列快照（纯函数）：DB 行 → `{steering, follow_up}`，**steering 在前**（pi `clear_queue` 的返回顺序，
 *  也是「取回」回填输入框的顺序）。 */
export function toSnapshot(rows, { withId = true } = {}) {
  const out = { steering: [], follow_up: [] };
  for (const r of rows) {
    const bucket = r.kind === 'steer' ? out.steering : out.follow_up;
    bucket.push(withId ? { id: r.id, content: r.content } : r.content);
  }
  return out;
}

/** 会话当前未投递队列（GET /api/sessions/:id 的 `queued_messages` 快照，pi `get_state.queuedMessages`
 *  的等价物；刷新 / 多端 / 断线重连的唯一补齐来源）。只读，不加锁。 */
export async function snapshotQueuedInputs(client, sessionId) {
  const res = await client.query(
    `SELECT id, kind, content FROM queued_inputs
      WHERE session_id = $1 AND status IN ('pending', 'delivering')
      ORDER BY CASE kind WHEN 'steer' THEN 0 ELSE 1 END, position`,
    [sessionId],
  );
  return toSnapshot(res.rows);
}

/**
 * 入队（`POST /api/sessions/:id/queued-inputs`）。**原子分岔**（同事务、会话行锁内）：
 *  - 会话**无**活跃 run ⇒ 退化成直接发送，走既有 `postMessage`（LLM 预检 / 容器预检 / seq /
 *    transcript / 建 run 入队 / 幂等台账全复用，**不另起第二条发送链路**），返回 `{ posted, queued:null }`；
 *  - 有活跃 run ⇒ 落一行 `pending`，返回 `{ posted:null, queued:{...} }`；`kind='steer'` 另做两件事：
 *    记 `interrupted_run_id`（「这次 abort 是转向还是用户按停止」的唯一判据）+ 写
 *    `cancel_requested_at`（**不动 `status`**，红线见下方注释）。
 *
 * ⚠ 为什么 steer 只写 `cancel_requested_at` 而不写 `cancelling`：
 *   `cancelling` 是「用户按了停止、等 worker 报终态」的**终态前态**，三条既有谓词都按它分流
 *   （认领 SQL 排除它、心跳 `stop_run_ids` 要求它、worker 的 stop 路径按它报 aborted）。转向要走的是
 *   「轮边界 `onRound` 里 abort」，语义是「本轮跑完再停」，把 status 塞进 cancelling 会让 worker 立刻
 *   SIGKILL 正在跑的工具（#211 的进程组杀），轮次与 usage 就残缺了——那正是 #370 §6 更正掉的旧口径。
 *   status 保持 `running`、由下行 SSE `steer_request` 装标记、worker 在轮边界自己 abort。
 *
 * `deps`（全部由 http.js 注入，本文件不 import internal.js）：
 *   `notifyRunEnqueued({runId,userId})`、`notifyQueueUpdate(sessionId, snapshotWithBlocked)`、
 *   `notifySteerRequest(userId, {run_id})`、`postMessage`（**测试缝**：默认就是本站唯一发送路
 *   `sessions.js#postMessage`，注入只为让单测能跑完判定表而不必重建整条发送路的 SQL 世界）。
 */
export async function enqueueQueuedInput(pool, {
  userId, sessionId, kind, content, attachments, triggerKind, deps = {}, record,
}) {
  const safeKind = validateQueuedKind(kind);
  const { content: safeContent, attachments: safeAttachments } = validateMessageBody({ content, attachments });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = await fetchSession(client, sessionId, userId, { forUpdate: true });

    const active = await client.query(
      `SELECT r.id, r.status FROM runs r
        WHERE r.session_id = $1 AND r.status IN ${ACTIVE_RUN_STATES}
        ORDER BY r.queued_at DESC LIMIT 1`,
      [s.id],
    );
    const activeRunId = active.rows?.[0]?.id ?? null;

    // 无活跃 run ⇒ 直接发。⚠ 不在本事务里调 postMessage：它自开事务并再锁同一行 chat_sessions，
    // 同连接外的第二个连接会在这里等到天荒地老（锁序红线，口径同 sessions.js stopSession 的注释）。
    // 正确做法：**先提交**（此刻只有一把还没写任何东西的会话锁），提交后再调它。
    if (!activeRunId) {
      await client.query('COMMIT');
      // `record` 必须转交给 postMessage：它是这条路的业务事务产出者，幂等记账要**同 client 同事务**
      // （G2 口径，同 portal.md §1.4）。但直接传原回调会把台账里的 response 存成
      // `{message, run}`——回放时就会给出与本端点**不同形状**的响应体。所以在这里包一层，
      // 把 postMessage 的载荷映射成本端点的响应形状（`{posted, queued:null}`）。
      const recordForPost = record
        ? (client, _code, payload) => record(client, 202, { posted: payload, queued: null })
        : undefined;
      const posted = await (deps.postMessage ?? postMessage)(pool, {
        userId, sessionId, content: safeContent, attachments: safeAttachments,
        triggerKind: triggerKind ?? 'user_send',
        notify: deps.notifyRunEnqueued, record: recordForPost,
      });
      await safeNotify(() => deps.notifyQueueUpdate?.(sessionId));
      return { posted, queued: null };
    }

    // 上限（只在真的要入队这条路上算，直发路不吃这个数）
    const cnt = await client.query(
      `SELECT COUNT(*)::int AS n FROM queued_inputs
        WHERE session_id = $1 AND status IN ('pending', 'delivering')`,
      [s.id],
    );
    if (Number(cnt.rows[0].n) >= MAX_QUEUED_INPUTS_PER_SESSION) {
      throw new SessionError('queue_full',
        `待发送队列已满（≤${MAX_QUEUED_INPUTS_PER_SESSION} 条），请先取回或清空`,
        { httpStatus: 409, details: { limit: MAX_QUEUED_INPUTS_PER_SESSION } });
    }

    const ins = await client.query(
      `INSERT INTO queued_inputs (session_id, user_id, kind, content, attachments, interrupted_run_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING id, kind, content, position, status, created_at`,
      [s.id, userId, safeKind, safeContent, JSON.stringify(safeAttachments ?? []),
        safeKind === 'steer' ? activeRunId : null],
    );
    if (safeKind === 'steer') {
      // 只打停止意图的时间戳，**不动 status**（见函数头 ⚠）。
      await client.query(
        `UPDATE runs SET cancel_requested_at = COALESCE(cancel_requested_at, now())
          WHERE id = $1 AND status = 'running'`,
        [activeRunId],
      );
    }
    // 台账里存的是**入队结果本体**（不是裁剪过的响应体）：http.js 那层用一个纯函数把它映射成
    // 响应形状，首次与回放因此**共用同一个映射**，不可能漂。
    if (record) await record(client, 202, { posted: null, queued: ins.rows[0] });
    await client.query('COMMIT');

    // COMMIT 之后再推：绝不先于落库到达客户端（同 postMessage 的 onSessionTitle 口径）。
    await safeNotify(() => deps.notifyQueueUpdate?.(sessionId));
    if (safeKind === 'steer') {
      await safeNotify(() => deps.notifySteerRequest?.(userId, { run_id: activeRunId }));
    }
    return { posted: null, queued: ins.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 整队取回（`DELETE /api/sessions/:id/queued-inputs` = pi `clear_queue`）：`pending` → `recalled`
 * （**不硬删**，留一行给人查「他说过什么没发出去」），返回文本数组（steering 在前）。
 * 已在 `delivering` 的**不动**——它已经变成一条正在建的 run，此时清它等于把已发出的话再吐回输入框。
 */
export async function recallQueuedInputs(pool, { userId, sessionId, deps = {} }) {
  const client = await pool.connect();
  let rows;
  try {
    await client.query('BEGIN');
    const s = await fetchSession(client, sessionId, userId, { forUpdate: true });
    const upd = await client.query(
      `UPDATE queued_inputs SET status = 'recalled'
        WHERE session_id = $1 AND status = 'pending'
        RETURNING id, kind, content`,
      [s.id],
    );
    rows = upd.rows;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await safeNotify(() => deps.notifyQueueUpdate?.(sessionId));
  return toSnapshot(rows, { withId: false });
}

/**
 * 终态出队：**唯一**的「该不该投下一条」判定。由 run 终态产出的**五处**调用（#370 §3：
 * `internal.js finishRun` / `sessions.js stopSession` 直接终态分支 / `releaseRun` /
 * `reapExpiredRuns` / `provisioner.js terminateActiveRuns`——漏一处就是队列卡死）。
 *
 * 判定表（pi 同口径，证据在 #370）：
 *   队头是 `steer`              ⇒ **无条件投**（它就是造成这次终态的原因）
 *   队头是 `follow_up` 且正常终态 ⇒ 投
 *   队头是 `follow_up` 且 aborted 且**这次 abort 是转向**（存在 `kind='steer' AND
 *     interrupted_run_id = 本 run` 的行）⇒ 投（用户意图是接着说）
 *   其余（用户按停止 / failed / persistence_failed / max_rounds_cap …）⇒ **不投**，留在队列
 *     （别把排队的话烧在一个坏 run 上；下次终态再试，用户也可随时取回）
 *
 * 容器存活闸门（#370 拍板点 ②）：agentd 跑在容器里，容器停了没人 claim ⇒ 不投递、不丢弃，
 * 快照带 `blocked='container_not_running'` 让界面说清楚「为什么还没发」。
 *
 * `deps.postMessage` 同 `enqueueQueuedInput`（测试缝，默认走唯一发送路）。
 *
 * 事务形状：**认领**与**建 run** 分两次提交（`postMessage` 自开事务并锁 chat_sessions，同事务内调它
 * 会自锁）。认领用 CAS（`status='pending' → 'delivering'`），失败 0 行说明被别人抢先，直接放弃本轮；
 * 建 run 失败则把行退回 `pending`（下一次终态再来）。
 */
export async function drainQueuedInputs(pool, {
  userId, sessionId, endedRunId, termination, deps = {}, log = console,
}) {
  // 「可认领」= pending，**或认领过期**（`delivering` 但 `claimed_at` 已超过 CLAIM_STALE_MS）。
  // ⚠ 过期重认领必须写在这里，不是只写在注释里：认领与建 run 跨两次提交，中间崩一次，那行就
  //   永远停在 delivering —— 既不投递（本查询不认它）、也取不回（recall 只动 pending）、还算在
  //   上限里。那才是真正的「消息蒸发了」，而界面上毫无线索。判据同 run_queue 租约 / materializer
  //   的 lease 回收（本站已有两处同型先例）。
  const staleSeconds = Math.max(1, Math.round(CLAIM_STALE_MS / 1000));
  const CLAIMABLE = `(q.status = 'pending' OR (q.status = 'delivering' AND q.claimed_at < now() - make_interval(secs => $2::int)))`;
  const claim = await pool.query(
    `SELECT q.id, q.kind, q.content, q.attachments
       FROM queued_inputs q
      WHERE q.session_id = $1
        AND ${CLAIMABLE}
        -- steering 先、followUp 后（pi peekQueuedMessages 同序）；同组内 FIFO
        AND NOT EXISTS (SELECT 1 FROM queued_inputs q2
                         WHERE q2.session_id = q.session_id
                           AND (q2.status = 'pending' OR (q2.status = 'delivering'
                                AND q2.claimed_at < now() - make_interval(secs => $2::int)))
                           AND (CASE q2.kind WHEN 'steer' THEN 0 ELSE 1 END)
                             < (CASE q.kind WHEN 'steer' THEN 0 ELSE 1 END))
      ORDER BY CASE q.kind WHEN 'steer' THEN 0 ELSE 1 END, q.position
      LIMIT 1`,
    [sessionId, staleSeconds],
  );
  const head = claim.rows?.[0];
  if (!head) return null;

  // 「这次 abort 是不是转向」——由队列事实判定，不新增 run 状态 / termination reason。
  const steered = await pool.query(
    `SELECT 1 FROM queued_inputs
      WHERE kind = 'steer' AND interrupted_run_id = $1 LIMIT 1`,
    [endedRunId],
  );
  const reason = typeof termination?.reason === 'string' ? termination.reason : '';
  const deliverable = head.kind === 'steer'
    || NORMAL_END_REASONS.has(reason)
    || (reason === 'aborted' && steered.rows.length > 0);
  if (!deliverable) return { blocked: 'not_deliverable_at_terminal', head: head.kind };

  // 容器存活闸门。口径与 postMessage 那条容器查询一致（`status <> 'removed' AND revoked_at IS NULL`）。
  const container = await pool.query(
    `SELECT 1 FROM containers
      WHERE user_id = $1 AND status <> 'removed' AND revoked_at IS NULL LIMIT 1`,
    [userId],
  );
  if (!container.rows?.length) {
    await safeNotify(() => deps.notifyQueueUpdate?.(sessionId, 'container_not_running'));
    return { blocked: 'container_not_running', head: head.kind };
  }

  // 认领（CAS）。0 行 = 有人抢先（另一处终态 / 重放的终态），放弃。
  // CAS 的准入条件必须与上面的 pick 同一条谓词（含过期重认领），否则「选出来了但永远抢不到」。
  const got = await pool.query(
    `UPDATE queued_inputs SET status = 'delivering', claimed_at = now()
      WHERE id = $1
        AND (status = 'pending' OR (status = 'delivering'
             AND claimed_at < now() - make_interval(secs => $2::int)))
      RETURNING id, kind, content, attachments`,
    [head.id, staleSeconds],
  );
  if (!got.rows?.length) return { blocked: 'claimed_by_other', head: head.kind };
  const row = got.rows[0];

  let posted = null;
  try {
    posted = await (deps.postMessage ?? postMessage)(pool, {
      userId, sessionId,
      content: row.content,
      attachments: row.attachments ?? [],
      triggerKind: row.kind === 'steer' ? 'queued_steer' : 'queued_follow_up',
      notify: deps.notifyRunEnqueued,
    });
  } catch (err) {
    // 退回 pending：这一次没发出去，下一次终态还要来捞（会话已归档 / LLM 未绑定等都不是用户的错）。
    await pool.query(`UPDATE queued_inputs SET status = 'pending', claimed_at = NULL WHERE id = $1`, [row.id])
      .catch(() => {});
    // 会话没了（归档/删除）⇒ 别再空转，钉成 discarded 免得每次终态都撞一次。
    const code = err?.code ?? err?.httpStatus;
    if (err?.httpStatus === 404) {
      await pool.query(`UPDATE queued_inputs SET status = 'discarded' WHERE id = $1`, [row.id]).catch(() => {});
    }
    log.warn?.(`queued_inputs: 投递失败（run=${endedRunId} code=${code}）：${err?.message ?? err}`);
    await safeNotify(() => deps.notifyQueueUpdate?.(sessionId, 'deliver_failed'));
    return { blocked: 'deliver_failed', head: row.kind };
  }

  const done = await pool.query(
    `UPDATE queued_inputs SET status = 'delivered', run_id = $2, delivered_at = now()
      WHERE id = $1 AND status = 'delivering' RETURNING id`,
    [row.id, posted?.run?.id ?? null],
  );
  if (!done.rows?.length) {
    log.warn?.(`queued_inputs: 投递记账丢失（id=${row.id}），run=${posted?.run?.id}`);
  }
  // 帧里带 `delivered_run_id`：**这是前端知道「有一个它没亲手发出去的 run」的唯一推送路径**。
  // 前端平时只能从 POST 响应或会话详情知道活跃 run；队列投递两个都不是 ⇒ 不带上，界面就会
  // 在「旧 run 已终态、新 run 已在跑」的状态条上显示空闲，且新 run 那条 run_end 因 `isCurrent`
  // 判假被整条丢掉（终稿不刷新）。
  await safeNotify(() => deps.notifyQueueUpdate?.(sessionId, null, posted?.run?.id ?? null));
  return { delivered: row.id, kind: row.kind, runId: posted?.run?.id ?? null };
}

/** 推送一律 best-effort：SSE / IPC 的失败绝不能把 run 终态或 202 弄成 500。 */
async function safeNotify(fn) {
  try {
    await fn();
  } catch { /* 通知失败不影响主流程 */ }
}

/**
 * 「run 终态 ⇒ 试着投下一条」的**唯一入口**（#370 §3：五处终态产出点都调它）。
 * 调用方只给 run id：会话、属主、termination 全在这里从 DB 读——五处终态各拿到的东西不一样
 * （U2 有 body、reaper 只有 run 行、offboard 只有 user），把取数收在一处才不会五份判定漂移。
 * `deps` 由调用方注入（同 `drainQueuedInputs`）。返回 null = 这个 run 压根没有会话（不可达）或
 * 会话已归档（`drainQueuedInputs` 里投递会 404，那条路自己收口）。
 */
export async function drainAfterRunTerminal(pool, { runId, deps = {}, log = console }) {
  const run = await pool.query(
    `SELECT r.id, r.session_id, r.termination, s.user_id, s.status AS session_status
       FROM runs r JOIN chat_sessions s ON s.id = r.session_id
      WHERE r.id = $1`,
    [runId],
  );
  const row = run.rows?.[0];
  if (!row) return null;
  if (row.session_status !== 'active') return null; // 归档会话：不再自动投递（用户也看不见它了）
  return drainQueuedInputs(pool, {
    userId: row.user_id,
    sessionId: row.session_id,
    endedRunId: row.id,
    termination: row.termination ?? null,
    deps,
    log,
  });
}
