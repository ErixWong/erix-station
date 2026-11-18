// HTTP 层测试（issue #261014 切片 B2）：POST /api/sessions/:id/messages 建 run 前的**模型 id 可解析性**预检。
//   会话属主的 active LiteLLM binding 里某个已配置槽位的 `model_info.id` 在网关 `/model/info` 里查不到
//   （模型被删除/重建 ⇒ id 变）→ `409 llm_model_not_found`（`details={slot, model_id}`，`retryable: true`），
//   且**失败面必须干净**：不写 transcript、不入队 run、不开业务事务、不把失败钉进幂等台账（走 release）。
//   反向口径（同样是红线）：**网关不可达一律放行**（网关抖一下不许让用户发不出消息）、
//   **无活绑定一律放行**（那是 `409 llm_not_configured` 的职责，见 message-precheck.test.js）。
// 技法与假 pool 形状照 portal/test/message-precheck.test.js（#41 那条预检的既有范式）。
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool + **注入假网关 client**，零真 HTTP、零真 DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import * as llm from '../src/llm.js';

import { FakePool } from './fake-pool.js';
import { fakeTranscriptRounds } from './fake-transcript-rounds.js';

const USER = {
  id: '00000000-0000-4000-8000-0000000000b2', login: 'carol', display_name: 'carol',
  role: 'fde', fde_name: 'carol', auth_source: 'local', status: 'active',
};
const SESSION_ID = 'b1c2d3e4-2222-4222-8222-abcdefabcdef';
const TOKEN = 'tok-model-precheck-b2';

/** 活绑定行（心跳/预检那条 SELECT 的形状）：三个槽位全配，id 与 name 成对。 */
function bindingRow(overrides = {}) {
  return {
    main_model_id: 'mid-main', main_model_name: 'gpt-main',
    embedding_model_id: 'mid-emb', embedding_model_name: 'gpt-emb',
    vision_model_id: 'mid-vis', vision_model_name: 'gpt-vis',
    api_key: 'sk-fake-key-1234',
    ...overrides,
  };
}

/** 网关 `/model/info` 的响应形状（llm.js 的 gatewayModels() 吃 `data`/`models` 两种键）。 */
function modelInfo(...ids) {
  return { data: ids.map((id) => ({ model_info: { id }, model_name: `name-of-${id}` })) };
}

/**
 * 假网关 client：只带 `listModels`（`getGatewayClient()` 认这一件事即原样返回，不现造真 client）。
 * `fail=true` 模拟网关不可达；`calls` 用来钉「TTL 缓存按 client 对象身份分槽」（同单例只打一次）。
 */
function fakeGateway({ models = modelInfo('mid-main', 'mid-emb', 'mid-vis'), fail = false } = {}) {
  const state = { calls: 0, fail, models };
  return {
    state,
    async listModels() {
      state.calls += 1;
      if (state.fail) throw Object.assign(new Error('gateway down'), { httpStatus: 503 });
      return state.models;
    },
  };
}

/**
 * 内存 pool：登录会话 + 两条发消息预检（#41 的 llm_not_configured、B2 的模型 id 预检）
 * + postMessage 业务事务 + 幂等台账。`sqlLog` 是**全量 SQL 流水**（第 ⑤ 条「预检只读」靠它）。
 */
class PrecheckPool extends FakePool {
  constructor({ binding = bindingRow() } = {}) {
    super({ users: [USER] });
    this.binding = binding; // null ⇒ 无活绑定（心跳谓词空结果）
    this.connected = 0;
    this.idem = new Map();
    this.sqlLog = [];
    this.sessions.push({
      id: 'ls1', user_id: USER.id, token_hash: auth.hashToken(TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
    this.sessionRow = {
      id: SESSION_ID, user_id: USER.id, project_id: 'p1', title: 't', model: null,
      status: 'active', last_seq: 5, project_name: 'proj1',
    };
  }

  /** 预检是否只读：整条流水里除 postMessage 的写入外不许有 INSERT/UPDATE。 */
  writes() {
    return this.sqlLog.filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql) && !sql.includes('idempotency_keys'));
  }

  async query(sql, params = []) {
    this.sqlLog.push(sql);
    // ---- 幂等台账（内存模拟 idempotency_keys） ----
    if (sql.includes('INSERT INTO idempotency_keys')) {
      const [userId, endpoint, key, hash, claimToken] = params;
      const k = `${userId}|${endpoint}|${key}`;
      if (this.idem.has(k)) return { rows: [] };
      this.idem.set(k, { state: 'in_progress', request_hash: hash, claim_token: claimToken, status_code: null, response: null, created_at: new Date() });
      return { rows: [{ claimed: 1 }] };
    }
    if (sql.includes('FROM idempotency_keys') && sql.includes("state = 'done'")) {
      const [userId, endpoint, key] = params;
      const row = this.idem.get(`${userId}|${endpoint}|${key}`);
      return { rows: row && row.state === 'done' ? [row] : [] };
    }
    if (sql.includes('FROM idempotency_keys') && !sql.includes('DELETE FROM')) {
      const [userId, endpoint, key] = params;
      return { rows: this.idem.has(`${userId}|${endpoint}|${key}`) ? [this.idem.get(`${userId}|${endpoint}|${key}`)] : [] };
    }
    if (sql.includes('UPDATE idempotency_keys') && sql.includes("SET state = 'done'")) {
      const [userId, endpoint, key, statusCode, response, claimToken] = params;
      const row = this.idem.get(`${userId}|${endpoint}|${key}`);
      if (!row || row.state !== 'in_progress' || row.claim_token !== claimToken) return { rows: [], rowCount: 0 };
      row.state = 'done';
      row.status_code = statusCode;
      row.response = JSON.parse(response);
      return { rows: [{ state: 'done' }], rowCount: 1 };
    }
    if (sql.includes('DELETE FROM idempotency_keys') && params.length === 4) {
      const [userId, endpoint, key, claimToken] = params;
      const k = `${userId}|${endpoint}|${key}`;
      const row = this.idem.get(k);
      if (row && row.state === 'in_progress' && row.claim_token === claimToken) this.idem.delete(k);
      return { rows: [] };
    }
    // ---- #41 预检（`SELECT 1 … LIMIT 1`）：只要存在活绑定就放行（本文件的用例默认都有） ----
    if (sql.includes('FROM fde_llm_bindings') && /^\s*SELECT 1/i.test(sql)) {
      return { rows: this.binding ? [{ '?column?': 1 }] : [] };
    }
    // ---- B2 预检 / 心跳那条读绑定的 SELECT（同心跳谓词，逐列取回 id/name） ----
    if (sql.includes('FROM fde_llm_bindings')) {
      return { rows: this.binding ? [this.binding] : [] };
    }
    if (sql.includes('FROM chat_sessions s')) return { rows: [this.sessionRow] };
    if (sql.includes('FROM runs')) return { rows: [] };
    if (sql.includes('FROM containers')) return { rows: [{ id: 'c1' }] };
    if (sql.includes('UPDATE chat_sessions SET last_seq')) return { rows: [{ last_seq: 6 }] };
    if (sql.includes('INSERT INTO messages')) {
      return { rows: [{ id: 'm1', seq: 6, content: params[2], created_at: new Date('2026-10-14T00:00:00Z') }] };
    }
    // #333 M2：`transcript_rounds` 走共用仿真件（真库约束行为，不是一律空行）——
    // 旧写法首次预写就伪报冲突（见 fake-transcript-rounds.js 头注释）。
    const rounds = (this.rounds ??= fakeTranscriptRounds({ rows: this.transcript ?? [] }));
    const roundHit = rounds.query(sql, params);
    if (roundHit) return roundHit;
    if (sql.includes('INSERT INTO runs')) return { rows: [{ id: params[0], status: 'queued' }] };
    return super.query(sql, params);
  }

  async connect() {
    this.connected += 1;
    const pool = this;
    return { query: (sql, params) => pool.query(sql, params), release() {} };
  }
}

async function startServer({ binding = bindingRow(), gateway = fakeGateway(), pool = null } = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-model-precheck-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, perTokenMaxFailures: 5, maxEntries: 10000 },
    kdfConcurrency: 2,
    kdfQueueLimit: 100,
    kdfQueueTimeoutMs: 30000,
    maxBodyBytes: 64 * 1024,
    maxLoginLength: 128,
    maxPasswordLength: 256,
    staticDir,
  };
  const activePool = pool ?? new PrecheckPool({ binding });
  // ⚠ 注入 llmGateway：既避免真 HTTP，也正是在钉「复用同一个 client 对象」这条接线红线
  //   （llm.js 的 model_info.id→model_name 映射 TTL 缓存按 client 身份分槽）。
  const server = createServer({ pool: activePool, config, llmGateway: gateway });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    pool: activePool,
    base,
    gateway,
    cookieHeader: `${config.cookie.name}=${TOKEN}`,
    close: async () => { await new Promise((res) => server.close(res)); fs.rmSync(staticDir, { recursive: true, force: true }); },
  };
}

function postMessage(s, body, key = null) {
  const headers = { 'Content-Type': 'application/json', Cookie: s.cookieHeader };
  if (key) headers['Idempotency-Key'] = key;
  return fetch(`${s.base}/api/sessions/${SESSION_ID}/messages`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
}

/** 捕获 console.warn（网关不可达那条可观测标记要能被断言）。 */
function captureWarnings(fn) {
  const seen = [];
  const original = console.warn;
  console.warn = (...args) => { seen.push(args); };
  return Promise.resolve()
    .then(fn)
    .finally(() => { console.warn = original; })
    .then(() => seen);
}

// ---------------------------------------------------------------------------
// ① 未知模型 id ⇒ 409 llm_model_not_found，且库里没留下用户消息、没入队 run
// ---------------------------------------------------------------------------

test('issue #261014 B2：绑定的 main 模型 id 在网关里不存在 → 409 llm_model_not_found + details 齐全', async () => {
  const gateway = fakeGateway({ models: modelInfo('mid-emb', 'mid-vis') }); // 网关里没有 mid-main
  const s = await startServer({ gateway });
  try {
    const r = await postMessage(s, { content: 'hi', attachments: [] });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.error.code, 'llm_model_not_found');
    assert.deepEqual(body.error.details, { slot: 'main', model_id: 'mid-main', model_name: 'gpt-main' });
    assert.equal(body.error.retryable, true, '管理员改配后可原样重试（本预检零副作用、不占幂等位）');
    // 说人话：**绑定里的调用名**才是用户认得的词，必须是文案主语；槽位与 id（UUID）做辅助定位。
    assert.match(body.error.message, /主模型/);
    assert.match(body.error.message, /「gpt-main」/, '给人看的是名字，不是 UUID');
    assert.match(body.error.message, /mid-main/);
    assert.match(body.error.message, /管理台/);
  } finally {
    await s.close();
  }
});

test('issue #261014 B2：失败面干净——不写 transcript、不入队 run、不开业务事务、不占幂等位（顺序红线）', async () => {
  const gateway = fakeGateway({ models: modelInfo('mid-emb', 'mid-vis') });
  const s = await startServer({ gateway });
  // 第二个 serve 用**新的 client 对象**（⇒ TTL 缓存按 client 身份分槽 ⇒ 重新取映射），
  // 与「管理员改配 + 缓存过期」等价；共用同一个 pool ⇒ 幂等台账也是同一份。
  const s2 = await startServer({ pool: s.pool, gateway: fakeGateway() });
  try {
    const r = await postMessage(s, { content: 'hi', attachments: [] }, 'k-model-missing');
    assert.equal(r.status, 409);
    assert.equal(s.pool.connected, 0, '预检 fail-fast：postMessage 业务事务不得开启（⇒ 用户消息与 run 都没写）');
    assert.deepEqual(s.pool.writes(), [], '整条 SQL 流水里除幂等台账外不得有任何 INSERT/UPDATE/DELETE');
    assert.equal(
      s.pool.sqlLog.some((sql) => /INSERT INTO messages|INSERT INTO runs|INSERT INTO transcript_rounds/.test(sql)),
      false,
      '不得留下用户消息 / 不得入队 run（预检必须插在写 transcript 之前）',
    );
    assert.equal(s.pool.idem.size, 0, 'fn 抛错路径必须 release 占位行：失败结果不许被钉进幂等台账');

    // 已接受代价（同切片 A/B1 的 TTL 口径）：同一 client 上缓存未过期前重试仍是 409（默认 60s）。
    assert.equal((await postMessage(s, { content: 'hi', attachments: [] }, 'k-model-missing')).status, 409);
    assert.equal(s.pool.idem.size, 0, '第二次失败同样不占位');

    // 管理员把模型补回网关且映射重新取到 ⇒ **同一个 Idempotency-Key** 原样重试就能成功建 run。
    const r2 = await postMessage(s2, { content: 'hi', attachments: [] }, 'k-model-missing');
    assert.equal(r2.status, 202, '改配后同 key 重试应重新占位并成功（不被首次失败永久钉死）');
    const body2 = await r2.json();
    assert.equal(body2.message.role, 'user');
    assert.equal(body2.run.status, 'queued');
  } finally {
    await s.close();
    await s2.close();
  }
});

test('issue #261014 B2：embedding 槽位的 id 不存在也拦（details.slot=embedding），且只在 main 正常时仍算失败', async () => {
  const s = await startServer({ gateway: fakeGateway({ models: modelInfo('mid-main', 'mid-vis') }) });
  try {
    const r = await postMessage(s, { content: 'hi' });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.error.code, 'llm_model_not_found');
    assert.deepEqual(body.error.details, { slot: 'embedding', model_id: 'mid-emb', model_name: 'gpt-emb' });
    assert.match(body.error.message, /嵌入模型/);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ② 回归：id 全都在 ⇒ 正常入队
// ---------------------------------------------------------------------------

test('issue #261014 B2：三个槽位的 id 网关里都在 → 预检放行 → 202 正常入队（回归）', async () => {
  const gateway = fakeGateway();
  const s = await startServer({ gateway });
  try {
    const r = await postMessage(s, { content: 'hi', attachments: [] });
    assert.equal(r.status, 202, 'id 全部可解析时必须照常建 run');
    const body = await r.json();
    assert.equal(body.message.role, 'user');
    assert.equal(body.run.status, 'queued');
    assert.equal(s.pool.connected, 1, '业务事务恰好开启一次');
    assert.equal(gateway.state.calls, 1, '一次发消息恰好打一次 /model/info（TTL 缓存 miss 路径）');
  } finally {
    await s.close();
  }
});

test('issue #261014 B2：同一个 llmGateway 单例的两次发消息只打一次 /model/info（TTL 缓存按 client 身份分槽）', async () => {
  const gateway = fakeGateway();
  const s = await startServer({ gateway });
  try {
    assert.equal((await postMessage(s, { content: 'a' })).status, 202);
    assert.equal((await postMessage(s, { content: 'b' })).status, 202);
    assert.equal(gateway.state.calls, 1, '复用同一个 client 对象 ⇒ 第二次命中模块级 TTL 缓存');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ③ 网关不可达 ⇒ 一律放行（fail-open）
// ---------------------------------------------------------------------------

test('issue #261014 B2：网关不可达 → 放行（消息照发 202），并留下 model_list_unavailable 可观测标记', async () => {
  const s = await startServer({ gateway: fakeGateway({ fail: true }) });
  try {
    const warns = await captureWarnings(async () => {
      const r = await postMessage(s, { content: 'hi', attachments: [] });
      assert.equal(r.status, 202, '网关抖一下不许让用户发不出消息');
      const body = await r.json();
      assert.equal(body.run.status, 'queued');
    });
    assert.equal(s.pool.connected, 1);
    const marker = warns.find((args) => String(args[0]).includes('message precheck skipped'));
    assert.ok(marker, '必须留一条 warn 供运维定位（网关不可达被静默放行时不能毫无痕迹）');
    assert.deepEqual(marker[1], {
      fde_id: USER.id, status: 'pass', reason: 'model_list_unavailable', error_status: 503,
    });
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ④ 无活绑定 ⇒ 预检放行（「没配 LLM」是 llm_not_configured 的职责）
// ---------------------------------------------------------------------------

test('issue #261014 B2：无活绑定 → assertBindingModelsResolvable 直接放行且不打网关（不抢 llm_not_configured 的队）', async () => {
  const gateway = fakeGateway();
  const pool = new PrecheckPool({ binding: null });
  const result = await llm.assertBindingModelsResolvable(pool, USER.id, { gateway });
  assert.deepEqual(result, { status: 'pass', reason: 'no_active_binding' });
  assert.equal(gateway.state.calls, 0, '无活绑定时连 /model/info 都不该打');
  assert.deepEqual(pool.writes(), [], '无活绑定的判定也必须只读');
});

test('issue #261014 B2：端到端面——无活绑定时仍是 409 llm_not_configured（新预检不改变既有语义）', async () => {
  const s = await startServer({ binding: null, gateway: fakeGateway() });
  try {
    const r = await postMessage(s, { content: 'hi' });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error.code, 'llm_not_configured');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ⑤ 预检只读（零 UPDATE / 零 INSERT / 零 updateKey）
// ---------------------------------------------------------------------------

test('issue #261014 B2：预检只读——单元面零写库、零 updateKey（对账回写是心跳的事）', async () => {
  const gateway = fakeGateway();
  gateway.updateKey = async () => { throw new Error('预检不许调 /key/update'); };
  const pool = new PrecheckPool();
  const seen = await captureWarnings(async () => {
    // 放行路径
    assert.deepEqual(
      await llm.assertBindingModelsResolvable(pool, USER.id, { gateway }),
      { status: 'pass', reason: 'all_slots_resolved', slots: ['main', 'embedding', 'vision'] },
    );
    // 失败路径
    await assert.rejects(
      () => llm.assertBindingModelsResolvable(pool, USER.id, {
        gateway: fakeGateway({ models: modelInfo('mid-emb', 'mid-vis') }),
      }),
      (err) => err.code === 'llm_model_not_found' && err.httpStatus === 409
        && err.retryable === true
        && JSON.stringify(err.details) === JSON.stringify({ slot: 'main', model_id: 'mid-main', model_name: 'gpt-main' }),
    );
    // 网关不可达路径
    const unreachable = fakeGateway({ fail: true });
    assert.deepEqual(
      await llm.assertBindingModelsResolvable(pool, USER.id, { gateway: unreachable }),
      { status: 'pass', reason: 'model_list_unavailable', error_status: 503 },
    );
  });
  assert.equal(seen.length, 1, '只有网关不可达那一条路留 warn');
  assert.deepEqual(pool.writes(), [], '三条路径全程零 INSERT/UPDATE/DELETE');
  assert.equal(
    pool.sqlLog.some((sql) => /FOR UPDATE|pg_advisory/i.test(sql)),
    false,
    '预检不加锁、不进事务',
  );
});

test('issue #261014 B2：TTL 过期后重取映射（now 注入 ⇒ 不靠真实时钟），仍只读', async () => {
  const gateway = fakeGateway();
  const pool = new PrecheckPool();
  const clock = { t: 1_000 };
  const now = () => clock.t;
  await llm.assertBindingModelsResolvable(pool, USER.id, { gateway, now, ttlMs: 60_000 });
  await llm.assertBindingModelsResolvable(pool, USER.id, { gateway, now, ttlMs: 60_000 });
  assert.equal(gateway.state.calls, 1, 'TTL 内复用缓存');
  clock.t += 60_001;
  await llm.assertBindingModelsResolvable(pool, USER.id, { gateway, now, ttlMs: 60_000 });
  assert.equal(gateway.state.calls, 2, 'TTL 过期后重新打 /model/info');
  assert.deepEqual(pool.writes(), []);
});

// ---------------------------------------------------------------------------
// 顺序：体校验先于预检（既有口径不许被新预检插队）
// ---------------------------------------------------------------------------

test('issue #261014 B2：体校验 400 优先于模型预检（未知 id 也先报 validation_failed）', async () => {
  const s = await startServer({ gateway: fakeGateway({ models: modelInfo('mid-emb', 'mid-vis') }) });
  try {
    const r = await postMessage(s, { content: '' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, 'validation_failed');
    assert.equal(s.pool.connected, 0);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ④ 写路径必须失效 TTL 缓存（261118 真机 e2e 抓到的产品 bug）
// ---------------------------------------------------------------------------
//
// 现场：管理员刚建好的模型，用户立刻发消息 ⇒ `409 llm_model_not_found`，文案「绑定的主模型在
// LLM 网关里**已不存在**」——可同一时刻 `GET /model/info` 明明查得到它（wp6 诊断三方 id 全打出来了）。
// 根因：`dataPlaneNameMap` 的模块级 TTL 缓存（60s）**只有过期这一条出路**，建/改/删模型都不失效
// ⇒ 用户被一段过期快照挡在门外，且错误文案把人指向「模型没了」这个错方向。
// 判据（行为面，不测内部函数名）：删掉网关里的模型后**立刻**再发一次消息，必须已经是 409，
// 且网关被打第二次（说明缓存真的被丢了，而不是靠 60s 过期蒙对）。

test('261118：deleteModel 之后 TTL 缓存立刻失效——删完再发消息立即 409（不用等 60s）', async () => {
  const gateway = fakeGateway();
  // 假网关补两个写路径方法：findGatewayModel 走 listModels，deleteModel 真把条目摘掉。
  gateway.deleteModel = async (id) => {
    gateway.state.models = { data: (gateway.state.models.data ?? []).filter((m) => m.model_info.id !== id) };
    return { deleted: id };
  };
  const s = await startServer({ gateway });
  try {
    assert.equal((await postMessage(s, { content: 'a' })).status, 202, '第一发：三个槽位都在 ⇒ 放行');
    assert.equal(gateway.state.calls, 1, '第一发打了一次 /model/info 并缓存');

    await llm.deleteModel(gateway, 'mid-main');
    // deleteModel 自己也会 listModels 一次（findGatewayModel）⇒ 以删除之后的读数为基准
    const callsAfterDelete = gateway.state.calls;

    const after = await postMessage(s, { content: 'b' });
    assert.equal(after.status, 409, '删掉主模型后**立刻**发消息必须 409（旧缓存不许再放行）');
    assert.equal((await after.json()).error.code, 'llm_model_not_found');
    assert.equal(gateway.state.calls, callsAfterDelete + 1,
      '写路径失效缓存 ⇒ 第二发必须重新打网关；若缓存没失效这里会停在 callsAfterDelete（靠 60s TTL 蒙对）');
  } finally {
    await s.close();
  }
});

test('261118：在飞的 /model/info 不许把「刚发生的失效」悄悄撤销（代际号 race）', async () => {
  // 现场：A 请求正在 await listModels（拿到的是**建模型之前**的旧目录），B 请求此刻把模型建好并
  // 失效缓存。A 回来若无条件写回缓存 ⇒ 失效被撤销，用户继续吃 60s 过期快照。
  // 判据：A 回来之后**下一次**发消息必须重新打网关（calls 递增），且看到新模型。
  let releaseFirstList;
  const firstListGate = new Promise((resolve) => { releaseFirstList = resolve; });
  let listCalls = 0;
  const state = { models: modelInfo('mid-emb', 'mid-vis') }; // 主模型还不在目录里
  const gateway = {
    state,
    async listModels() {
      listCalls += 1;
      if (listCalls === 1) {
        // 第一趟：先卡住，等测试放行（模拟「读在飞」），且返回的是**旧快照**
        const snapshot = state.models;
        await firstListGate;
        return snapshot;
      }
      return state.models;
    },
  };
  const s = await startServer({ gateway });
  try {
    const inflight = postMessage(s, { content: 'a' }); // 这一发会在 listModels 里卡住
    // 等它真的进了 listModels（否则 releaseFirstList 还没意义）
    for (let i = 0; i < 200 && listCalls === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(listCalls, 1, '第一发已经进到网关读里（在飞）');

    // B 请求：模型建好了（目录变了）+ 失效缓存
    state.models = modelInfo('mid-main', 'mid-emb', 'mid-vis');
    llm.invalidateDataPlaneNameCache();

    releaseFirstList(); // 放行那趟在飞的读（它拿到的是旧快照）
    const first = await inflight;
    assert.equal(first.status, 409, '在飞的那一发按它自己那趟的读数判：旧目录里没有主模型 ⇒ 409');

    const after = await postMessage(s, { content: 'b' });
    assert.equal(after.status, 202, '下一发必须看到新目录（在飞的旧快照不许写回缓存）');
    assert.equal(listCalls, 2, '下一发必须重新打网关；若旧快照被写回，这里会停在 1（靠 60s TTL 蒙对）');
  } finally {
    await s.close();
  }
});

test('261118：updateModel 写成功但读回失败时，缓存仍必须已失效（审计 MED①）', async () => {
  // 现场：`client.updateModel()` 已经写成功，紧接着的读回（findGatewayModel）失败 ⇒ 若失效放在
  // 读回之后，写已落地而缓存还是旧的 —— 本 PR 要修的 bug 换个入口。
  // 判据：读回抛错之后，**下一次发消息必须重新打网关**（calls 递增）。缓存在读回之前就失效了才会这样。
  let listCalls = 0;
  let failOnCall = null; // 只让「写成功之后那次读回」失败（updateModel 开头还有一次预读，别误伤）
  const state = { models: modelInfo('mid-main', 'mid-emb', 'mid-vis') };
  const gateway = {
    state,
    async listModels() {
      listCalls += 1;
      if (failOnCall === listCalls) throw Object.assign(new Error('read-back down'), { httpStatus: 503 });
      return state.models;
    },
    async updateModel() {
      // 写成功：把主模型从目录里摘掉（模拟改名后旧名消失）
      state.models = modelInfo('mid-emb', 'mid-vis');
      return { updated: true };
    },
  };
  const s = await startServer({ gateway });
  try {
    assert.equal((await postMessage(s, { content: 'a' })).status, 202, '第一发：目录齐全 ⇒ 放行');
    const callsAfterFirst = listCalls;
    assert.equal(callsAfterFirst, 1, '第一发打了一次并缓存');

    // updateModel 的调用序列：预读（第 2 次 listModels）→ 写 → 读回（第 3 次）。只让第 3 次失败。
    failOnCall = callsAfterFirst + 2;
    await assert.rejects(() => llm.updateModel(gateway, 'mid-main', { name: 'renamed' }),
      '读回失败必须冒泡（不能静默吞）');
    assert.equal(listCalls, callsAfterFirst + 2, '预读 + 读回各一次，写本身不打列表');

    failOnCall = null;
    const after = await postMessage(s, { content: 'b' });
    assert.equal(listCalls, callsAfterFirst + 3,
      '预读 + 读回 + 第二发 = +3。若失效放在读回之后，第二发会吃旧缓存 ⇒ 这里只有 +2');
    assert.equal(after.status, 409, '缓存已失效 + 目录里主模型没了 ⇒ 必须 409（不是拿旧缓存放行 202）');
  } finally {
    await s.close();
  }
});
