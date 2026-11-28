// issue #905：「LLM 上游配好了吗」这条预检从 http 层收口到**写 `runs` 的唯一出口**
// （`sessions.postMessage`）——三条调用路（人发消息 / 宏任务 run / 只读审查 run）一次覆盖。
//
// 四条判据：
//   ① 唯一出口本身：直接调 `sessions.postMessage` ⇒ 无 active binding 即抛 `llm_not_configured`，
//      且 `INSERT INTO runs` **一条没执行**、业务事务**一次没开**（正向对照：配好了才走到 connect）。
//   ② 宏任务腿：`executeScheduledIntent` ⇒ 不建 run（`runs` 里零新行）、宏 run 归 **failed**（不是 done，
//      不许把失败伪装成完成）、`reason` 里带可判读的机器码 `llm_not_configured`。
//   ③ 审查腿：`runReviewTaskDefault` ⇒ 抛出且**不起审查会话的 run**。
//   ④ API 响应逐字不变：409 + 同一个 `code` + 中文原文 / 英文原文（两腿各逐字等值）+ 错误体键集合不变。
//
// 环境（口径见 docs/testing.md §2.1）：**不碰真实 DB**，注入内存 fake pool。本文件**始终执行**
// （不挂 `TEST_DATABASE_URL` 门）——宏腿/审查腿的既有测试文件（`macro-scheduled.test.js` /
// `macro-dispatcher.test.js`）是 pg-fixture 门，无库时整文件 skip；判据挂在那儿就永远不会变红，
// 所以宏腿照 `macro-dispatcher-reason.test.js`（#850）的注入式 fake pool 写法，http 腿照
// `message-precheck.test.js`（#41）的 `FakePool` 子类写法，不自造 harness。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as auth from '../src/auth.js';
import * as sessions from '../src/sessions.js';
import { executeScheduledIntent } from '../src/macro-scheduled.js';
import { runReviewTaskDefault } from '../src/macro-dispatcher.js';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { FakePool } from './fake-pool.js';

const USER_ID = '00000000-0000-4000-8000-000000000905';
const SESSION_ID = '90500905-0000-4000-8000-000000000905';

/**
 * 「按 SQL 说的做」的谓词模拟（fake pool 不许把「读绑定」那条一律回空行，否则假绿）：
 * 种子 = 该 FDE 有**一条不合格的**绑定（非 active、虚拟 key 空、主模型槽空）。
 * 查询**逐条带上** readiness 的五个谓词 ⇒ 按谓词过滤 ⇒ 空行 = 未配置；
 * 少任一个谓词（变异②：放宽成只查 `fde_id`）⇒ 这一行就落进结果集 ⇒ 放行。
 */
const READINESS_NEEDLES = [
  "state = 'active'",
  "gateway = 'litellm'",
  'api_key IS NOT NULL',
  "api_key <> ''",
  'main_model_id IS NOT NULL',
];
function readinessRows(sql) {
  const strict = READINESS_NEEDLES.every((needle) => sql.includes(needle));
  return strict ? [] : [{ '?column?': 1 }]; // 谓词被放宽 ⇒ 库里那条不合格绑定就"算数"了
}

/** ① 唯一出口的判据用：只服务「预检 + 到业务事务门口」这一段。 */
class ChokePool {
  constructor({ ready = false } = {}) {
    this.ready = ready;
    this.runs = []; // `INSERT INTO runs` 的真落点（本判据要的「runs 里没有新行」就数这个）
    this.connects = 0;
    this.bindingsQueries = [];
  }

  async query(sql, params = []) {
    if (/FROM fde_llm_bindings/i.test(sql)) {
      this.bindingsQueries.push(sql);
      return { rows: this.ready ? [{ '?column?': 1 }] : readinessRows(sql) };
    }
    if (/INSERT INTO runs/i.test(sql)) {
      this.runs.push({ id: params[0] });
      return { rows: [{ id: params[0], status: 'queued' }] };
    }
    return { rows: [] };
  }

  async connect() {
    // 正向对照：预检放行后**必须**走到开业务事务。这里用哨兵停住，免得为一趟成功发消息
    // 去仿真整条 postMessage 事务（那是 message-precheck.test.js 的口径，本判据不重复）。
    this.connects += 1;
    throw new Error('SENTINEL_REACHED_TRANSACTION');
  }

  async end() {}
}

// —— ① 唯一出口本身：无绑定 ⇒ 抛 + `INSERT INTO runs` 没执行 + 业务事务没开 ——
test('#905 ①：sessions.postMessage 自己就是判据点——无 active binding 即抛 llm_not_configured，且不建 run、不开业务事务', async () => {
  const pool = new ChokePool({ ready: false });
  await assert.rejects(
    () => sessions.postMessage(pool, { userId: USER_ID, sessionId: SESSION_ID, content: 'hi', attachments: [] }),
    (err) => {
      assert.equal(err.name, 'FdeLlmPrecheckError', '错误载体必须是 llm.js 的领域层错误（不许是 http.js 的 HttpError）');
      assert.equal(err.code, 'llm_not_configured');
      assert.equal(err.status, 409);
      assert.equal(err.message, '该 FDE 未配置 LLM 上游，请在管理台配置');
      assert.equal(err.en, 'This FDE has no LLM upstream configured; please configure it in the admin console');
      return true;
    },
  );
  assert.deepEqual(pool.runs, [], '`INSERT INTO runs` 一条都不许执行（判据在建 run 之前）');
  assert.equal(pool.connects, 0, '业务事务一次都不许开（失败面：不留用户消息、不入队）');
  assert.equal(pool.bindingsQueries.length, 1, '只读一条绑定查询');
});

// —— ① 正向对照：配好了 ⇒ 预检放行，走到开业务事务那一步 ——
test('#905 ①正向对照：有 active binding ⇒ 预检放行，控制流抵达业务事务（不是"永远拦"）', async () => {
  const pool = new ChokePool({ ready: true });
  await assert.rejects(
    () => sessions.postMessage(pool, { userId: USER_ID, sessionId: SESSION_ID, content: 'hi', attachments: [] }),
    /SENTINEL_REACHED_TRANSACTION/,
  );
  assert.equal(pool.connects, 1, '预检放行后必须开业务事务');
});

/** ②③ 宏腿/审查腿用：认得这几条语句 + 谓词模拟 + 记 `INSERT INTO runs`。 */
class MacroPrecheckPool {
  constructor({ ready = false } = {}) {
    this.ready = ready;
    this.runs = []; // 两条腿判据「runs 里没有新行」数这个
    this.sessionsCreated = [];
    this.macroRunUpdates = []; // finishMacroRun 的 UPDATE 参数（status / reason 从这里读）
  }

  async query(sql, params = []) {
    if (/FROM fde_llm_bindings/i.test(sql)) return { rows: this.ready ? [{ '?column?': 1 }] : readinessRows(sql) };
    if (/INSERT INTO runs/i.test(sql)) {
      this.runs.push({ id: params[0] });
      return { rows: [{ id: params[0], status: 'queued' }] };
    }
    if (/INSERT INTO chat_sessions/i.test(sql)) {
      const id = crypto.randomUUID();
      this.sessionsCreated.push(id);
      return { rows: [{ id }] };
    }
    // 审查腿：宏账 → 属主
    if (/FROM macro_runs r JOIN macro_assignments a/i.test(sql)) return { rows: [{ user_id: USER_ID }] };
    // 宏会话复用（getOrCreateMacroSession 的查找命中 ⇒ 不新建）
    if (/FROM chat_sessions/i.test(sql)) return { rows: [{ id: SESSION_ID }] };
    // finishMacroRun 的收口 UPDATE（`SET status = $2 … reason = $N … RETURNING *`）
    if (/UPDATE macro_runs/i.test(sql)) {
      const statusAt = /\bstatus\s*=\s*\$(\d+)/i.exec(sql);
      const reasonAt = /\breason\s*=\s*\$(\d+)/i.exec(sql);
      const update = {
        status: statusAt ? params[Number(statusAt[1]) - 1] : undefined,
        reason: reasonAt ? params[Number(reasonAt[1]) - 1] : undefined,
      };
      this.macroRunUpdates.push(update);
      return { rows: [{ id: params[0], assignment_id: 'a1', status: update.status, reason: update.reason, started_at: new Date() }] };
    }
    return { rows: [] };
  }

  async connect() {
    const pool = this;
    return { query: (sql, params) => pool.query(sql, params), release() {} };
  }

  async end() {}
}

const tickIntent = (macroRunId) => ({
  assignmentId: 'a1', templateId: 't1', templateKind: 'scheduled-task',
  templateName: 'daily-demo', params: { at: '09:00', cwd: '~/projects/demo', task: '整理今日变更', maxRounds: 16 },
  userId: USER_ID, sessionId: null, cwd: '~/projects/demo',
  anchor: 'clock:2026-11-16', criterion: 'tick', bucket: '2026-11-16', evidence: {}, macroRunId,
});

// —— ② 宏任务腿：无绑定 ⇒ 不建 run、宏 run 落 failed（不是 done）、reason 带机器码 ——
test('#905 ②：宏任务腿 executeScheduledIntent 无 active binding ⇒ 不建 run、宏 run 归 failed（不是 done）、reason 带 llm_not_configured', async () => {
  const pool = new MacroPrecheckPool({ ready: false });
  const macroRunId = crypto.randomUUID();
  let runTaskCalls = 0;
  const notified = [];
  const out = await executeScheduledIntent(pool, tickIntent(macroRunId), {
    reportsRoot: path.join(os.tmpdir(), `p905-reports-${macroRunId}`),
    runTask: async () => { runTaskCalls += 1; return { ok: true, text: '不该被跑到' }; },
    notifyImpl: async (_pool, _intent, msg) => { notified.push(msg); },
    log: { info() {}, warn() {}, error() {} },
  });

  assert.equal(out.status, 'failed', `宏 run 必须是 failed，实际 ${out.status}（不许把入队失败伪装成完成）`);
  assert.notEqual(out.status, 'done');
  assert.equal(out.childRunId, null, '没有 child run');
  assert.match(out.reason, /llm_not_configured/, `reason 必须带可判读的机器码，实际：${out.reason}`);
  assert.match(out.reason, /该 FDE 未配置 LLM 上游/, 'reason 仍要留着给人看的中文原句');
  assert.deepEqual(pool.runs, [], 'runs 里必须零新行（判据在建 run 之前拦住）');
  assert.equal(runTaskCalls, 0, '根本没起 run ⇒ 执行体一次都不该被驱动');
  assert.equal(pool.macroRunUpdates.length, 1, '恰好一次失败收口');
  assert.equal(pool.macroRunUpdates[0].status, 'failed', '账上 macro_runs.status 必须是 failed');
  assert.match(pool.macroRunUpdates[0].reason, /llm_not_configured/);
  assert.equal(notified.length, 1, '失败必须通知订阅人');
  assert.equal(notified[0].success, false);
});

// —— ③ 审查腿：无绑定 ⇒ 抛出且不起审查会话的 run ——
test('#905 ③：审查腿 runReviewTaskDefault 无 active binding ⇒ 抛出，且审查会话没有 run', async () => {
  const pool = new MacroPrecheckPool({ ready: false });
  let reviewTaskCalls = 0;
  await assert.rejects(
    () => runReviewTaskDefault({
      pool,
      brief: '审一下这次变更',
      macroRunId: crypto.randomUUID(),
      cwd: '~/projects/review',
      reviewTask: async () => { reviewTaskCalls += 1; return { ok: true, text: 'x' }; },
      log: { info() {}, warn() {}, error() {} },
    }),
    (err) => {
      assert.equal(err.code, 'llm_not_configured', `审查腿必须被第一道硬拦，实际错误：${err?.code} / ${err?.message}`);
      assert.equal(err.status, 409);
      return true;
    },
  );
  assert.equal(pool.sessionsCreated.length, 1, '审查会话本身照旧建（本单不动它的生命周期）');
  assert.deepEqual(pool.runs, [], '但审查会话下必须零 run（以前这条 run 会建出来然后卡死）');
  assert.equal(reviewTaskCalls, 0, '没有 run 就没有可轮询的东西');
});

// —— ④ API 响应逐字不变（预检换了位置，对外一个字都不许变）——
const API_USER = {
  id: USER_ID, login: 'p905', display_name: 'p905', role: 'fde', fde_name: 'p905',
  auth_source: 'local', status: 'active',
};
const API_TOKEN = 'tok-p905-chokepoint';

/** http 腿的假 pool：形状照 `message-precheck.test.js`（#41）的 `MessagePool`。 */
class ApiPool extends FakePool {
  constructor() {
    super({ users: [API_USER] });
    this.sessions.push({
      id: 'ls1', user_id: API_USER.id, token_hash: auth.hashToken(API_TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
    this.sessionRow = {
      id: SESSION_ID, user_id: API_USER.id, project_id: 'p1', title: 't', model: null,
      status: 'active', last_seq: 5, project_name: 'proj1',
    };
    this.runs = [];
    this.connects = 0;
  }

  async query(sql, params = []) {
    if (/FROM fde_llm_bindings/i.test(sql)) return { rows: readinessRows(sql) };
    if (/FROM chat_sessions s/i.test(sql)) return { rows: [this.sessionRow] };
    if (/INSERT INTO runs/i.test(sql)) {
      this.runs.push({ id: params[0] });
      return { rows: [{ id: params[0], status: 'queued' }] };
    }
    return super.query(sql, params);
  }

  async connect() {
    this.connects += 1;
    const pool = this;
    return { query: (sql, params) => pool.query(sql, params), release() {} };
  }
}

async function startApi() {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-p905-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, perTokenMaxFailures: 5, maxEntries: 10000 },
    kdfConcurrency: 2, kdfQueueLimit: 100, kdfQueueTimeoutMs: 30000,
    maxLoginLength: 128, maxPasswordLength: 256,
    staticDir,
  };
  const pool = new ApiPool();
  const server = createServer({ pool, config });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    pool,
    base,
    cookieHeader: `${config.cookie.name}=${API_TOKEN}`,
    close: async () => {
      await new Promise((res) => server.close(res));
      fs.rmSync(staticDir, { recursive: true, force: true });
    },
  };
}

// 两腿钉子（口径同 `macro-messages-i18n.test.js`）：en 腿逐字英文、缺省腿逐字中文，
// 再钉错误体键集合不变 + `en` 不外泄 + 状态码语义不变。
test('#905 ④：API 响应逐字不变——409 + llm_not_configured + 中英双语文案逐字等值 + 错误体键集合不变', async () => {
  const s = await startApi();
  try {
    const post = (cookie) => fetch(`${s.base}/api/sessions/${SESSION_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ content: 'hi', attachments: [] }),
    });

    const zh = await post(s.cookieHeader);
    assert.equal(zh.status, 409);
    const zhBody = await zh.json();
    assert.equal(zhBody.error.code, 'llm_not_configured');
    assert.equal(zhBody.error.message, '该 FDE 未配置 LLM 上游，请在管理台配置');
    assert.equal(zhBody.error.retryable, false);
    assert.deepEqual(Object.keys(zhBody.error).sort(), ['code', 'message', 'retryable'], '错误体键集合不许变');

    const en = await post(`${s.cookieHeader}; locale=en`);
    assert.equal(en.status, 409);
    const enBody = await en.json();
    assert.equal(enBody.error.code, 'llm_not_configured');
    assert.equal(enBody.error.message, 'This FDE has no LLM upstream configured; please configure it in the admin console');
    assert.deepEqual(Object.keys(enBody.error).sort(), ['code', 'message', 'retryable']);

    assert.deepEqual(s.pool.runs, [], '两条腿都没建 run');
    assert.equal(s.pool.connects, 0, '失败面不开业务事务');
  } finally {
    await s.close();
  }
});
