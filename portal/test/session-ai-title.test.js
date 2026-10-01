// HTTP 级测试：issue #114「AI 改名」端点 POST /api/sessions/:id/ai-title。
// 三态（issue 验收）：成功（mock fetch 上游）/ 无 provider 409 / LLM 失败 502；
// 另覆盖：属主鉴权 404、无用户消息 409、回退 provider（无 binding）、key 纪律（不进响应/日志）。
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool + 桩掉上游 fetch，不碰真实 DB / 网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { generateAiTitle } from '../src/sessions.js';
import { FakePool } from './fake-pool.js';

const USER = {
  id: '00000000-0000-4000-8000-0000000000b1', login: 'alice', display_name: 'alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const OTHER_USER_ID = '00000000-0000-4000-8000-0000000000b2';
const SESSION_ID = 'b1b2c3d4-2222-4222-8222-abcdefabcdef';
const TOKEN = 'tok-ai-title-test';
/** 测试用上游 key（断言它绝不出现在响应/日志里）。 */
const API_KEY = 'sk-test-secret-key-123456';

/**
 * 内存 pool：登录会话（FakePool）+ AI 改名链路的四条查询
 * （fetchSession / 首 3 条 user 消息 / FDE binding / 回退 provider）+ 落库 UPDATE。
 */
class AiTitlePool extends FakePool {
  constructor({ binding = null, providerRow = null, messages = [], ownerId = USER.id } = {}) {
    super({ users: [USER] });
    this.sessions.push({
      id: 'ls1', user_id: USER.id, token_hash: auth.hashToken(TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
    this.sessionRow = {
      id: SESSION_ID, user_id: ownerId, project_id: null, cwd: '~/projects/demo',
      title: '', title_source: 'auto', model: null, status: 'active', last_seq: 3,
      created_at: new Date('2026-10-01T00:00:00.000Z'), updated_at: new Date('2026-10-01T00:00:00.000Z'),
    };
    this.binding = binding;
    this.providerRow = providerRow;
    this.messages = messages;
    this.titleUpdates = [];
    this.seenSql = [];
  }

  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.seenSql.push(s);
    if (s.includes('FROM chat_sessions s')) return { rows: [this.sessionRow] };
    if (s.includes('FROM messages') && s.includes("role = 'user'")) {
      return { rows: this.messages.slice(0, params[1] ?? 3).map((c) => ({ content: c })) };
    }
    if (s.includes('FROM fde_llm_bindings b')) return { rows: this.binding ? [this.binding] : [] };
    if (s.includes('FROM llm_providers p')) return { rows: this.providerRow ? [this.providerRow] : [] };
    if (s.startsWith('UPDATE chat_sessions SET title')) {
      this.titleUpdates.push({ sql: s, params });
      this.sessionRow.title = params[1];
      this.sessionRow.title_source = 'manual';
      return { rows: [{ ...this.sessionRow, updated_at: new Date('2026-10-01T01:00:00.000Z') }] };
    }
    return super.query(sql, params);
  }
}

/** FDE binding 行（llm.js getFdeLlmConfig 的 JOIN 形状）。 */
const bindingRow = (over = {}) => ({
  fde_id: USER.id, api_key: API_KEY, state: 'active',
  provider_id: 'p1', provider_name: 'upstream', base_url: 'https://llm.example.com/v1',
  main_upstream: 'gpt-4o-mini', main_name: 'GPT-4o mini', main_type: 'text',
  embedding_upstream: null, embedding_name: null, embedding_type: null,
  vision_upstream: null, vision_name: null, vision_type: null,
  ...over,
});

async function startServer(poolOpts = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-aititle-'));
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
  const logs = { info: [], warn: [], error: [] };
  const log = { info: (m) => logs.info.push(String(m)), warn: (m) => logs.warn.push(String(m)), error: (m) => logs.error.push(String(m)) };
  const pool = new AiTitlePool(poolOpts);
  const server = createServer({ pool, config, log });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    pool,
    base,
    logs,
    cookieHeader: `${config.cookie.name}=${TOKEN}`,
    close: async () => {
      await new Promise((res) => server.close(res));
      fs.rmSync(staticDir, { recursive: true, force: true });
    },
  };
}

/**
 * 桩掉**上游** fetch：只拦截 chat/completions（测试自身的 HTTP 客户端仍走真 fetch）。
 * @param {(url: string, init: object) => Promise<Response>} handler
 */
function stubUpstreamFetch(handler) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, init) => {
    const u = String(url);
    if (u.includes('/chat/completions')) {
      calls.push({ url: u, init });
      return Promise.resolve(handler(u, init));
    }
    return realFetch(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function callAiTitle(s, { sessionId = SESSION_ID, cookie } = {}) {
  return fetch(`${s.base}/api/sessions/${sessionId}/ai-title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie === null ? {} : { Cookie: cookie ?? s.cookieHeader }) },
    body: '{}',
  });
}

// ---------------------------------------------------------------------------
// ① 成功：mock fetch → 落库 title_source='manual'
// ---------------------------------------------------------------------------

test('issue #114 成功态：一次 chat/completions → sanitizeTitle 清洗 → 落库 title_source=manual', async () => {
  const s = await startServer({
    binding: bindingRow(),
    messages: ['帮我修复登录页白屏', '再补一个回归测试用例', '第三轮：顺便看一下部署脚本', '第四条不该进上下文'],
  });
  const stub = stubUpstreamFetch(() => jsonResponse(200, { choices: [{ message: { content: '「登录页白屏修复」' } }] }));
  try {
    const r = await callAiTitle(s);
    assert.equal(r.status, 200);
    const raw = await r.text();
    const body = JSON.parse(raw);
    assert.equal(body.session.title, '登录页白屏修复', 'sanitizeTitle 去掉包裹引号');
    assert.equal(body.session.title_source, 'manual', '用户主动触发 → manual（自动流程不得覆盖）');
    assert.equal(raw.includes(API_KEY), false, 'key 绝不进 HTTP 响应');
    assert.equal(s.logs.warn.length + s.logs.error.length, 0, '成功路径不写 warn/error');

    // 上游请求形状：OpenAI 兼容 chat/completions，一次往返，带 Bearer key
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, 'https://llm.example.com/v1/chat/completions', 'base 已含 /v1 不重复拼接');
    assert.equal(stub.calls[0].init.method, 'POST');
    assert.equal(stub.calls[0].init.headers.Authorization, `Bearer ${API_KEY}`);
    const payload = JSON.parse(stub.calls[0].init.body);
    assert.equal(payload.model, 'gpt-4o-mini', '用 binding 的 main 模型位');
    assert.equal(payload.stream, false);
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.messages[0].role, 'system');
    assert.match(payload.messages[1].content, /帮我修复登录页白屏/);
    assert.match(payload.messages[1].content, /再补一个回归测试用例/);
    assert.match(payload.messages[1].content, /第三轮：顺便看一下部署脚本/, '取最早 3 条 user 消息');
    assert.equal(payload.messages[1].content.includes('第四条不该进上下文'), false, '第 4 条不进上下文');

    // 落库语句
    assert.equal(s.pool.titleUpdates.length, 1);
    assert.ok(s.pool.titleUpdates[0].sql.includes("title_source = 'manual'"));
    assert.equal(s.pool.titleUpdates[0].params[1], '登录页白屏修复');
  } finally {
    stub.restore();
    await s.close();
  }
});

test('issue #114：上游超长标题 → sanitizeTitle 截断 ≤30 字', async () => {
  const s = await startServer({ binding: bindingRow(), messages: ['随便一条消息'] });
  const stub = stubUpstreamFetch(() => jsonResponse(200, { choices: [{ message: { content: '长'.repeat(80) } }] }));
  try {
    const r = await callAiTitle(s);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(Array.from(body.session.title).length, 30);
  } finally {
    stub.restore();
    await s.close();
  }
});

test('issue #114：无 FDE binding → 回退第一个启用的 text provider+model（无 key，不带 Authorization）', async () => {
  const s = await startServer({
    binding: null,
    providerRow: { base_url: 'http://127.0.0.1:4000', model_id: 'local-text-7b' },
    messages: ['本地自建端点'],
  });
  const stub = stubUpstreamFetch(() => jsonResponse(200, { choices: [{ message: { content: '本地端点命名' } }] }));
  try {
    const r = await callAiTitle(s);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).session.title, '本地端点命名');
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, 'http://127.0.0.1:4000/v1/chat/completions', 'base 不含 /v1 → 补 /v1');
    assert.equal('Authorization' in stub.calls[0].init.headers, false, 'provider 表无 key（红线 ①）→ 不带鉴权头');
    assert.equal(JSON.parse(stub.calls[0].init.body).model, 'local-text-7b');
  } finally {
    stub.restore();
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ② 无 provider → 409（清晰文案；不发任何上游请求）
// ---------------------------------------------------------------------------

test('issue #114 无 provider 态：binding 与 text provider 都没有 → 409 llm_not_configured，且不打上游', async () => {
  const s = await startServer({ binding: null, providerRow: null, messages: ['hi'] });
  const stub = stubUpstreamFetch(() => jsonResponse(200, { choices: [] }));
  try {
    const r = await callAiTitle(s);
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.error.code, 'llm_not_configured');
    assert.match(body.error.message, /管理台/, '文案给出可操作指引');
    assert.equal(stub.calls.length, 0, '无 provider 不得发起上游请求');
    assert.equal(s.pool.titleUpdates.length, 0, '失败不落库');
  } finally {
    stub.restore();
    await s.close();
  }
});

test('issue #114：会话还没有用户消息 → 409 no_user_messages（不落库）', async () => {
  const s = await startServer({ binding: bindingRow(), messages: [] });
  const stub = stubUpstreamFetch(() => jsonResponse(200, { choices: [] }));
  try {
    const r = await callAiTitle(s);
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error.code, 'no_user_messages');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ③ LLM 失败 → 502（简短原因；key 不进响应/日志）
// ---------------------------------------------------------------------------

test('issue #114 LLM 失败态：上游 401 → 502 llm_upstream_failed，key 不进响应与日志', async () => {
  const s = await startServer({ binding: bindingRow(), messages: ['hi'] });
  const stub = stubUpstreamFetch(() => jsonResponse(401, { error: { message: `invalid api key ${API_KEY}` } }));
  try {
    const r = await callAiTitle(s);
    assert.equal(r.status, 502);
    const raw = await r.text();
    const body = JSON.parse(raw);
    assert.equal(body.error.code, 'llm_upstream_failed');
    assert.match(body.error.message, /HTTP 401/);
    assert.equal(raw.includes(API_KEY), false, '上游回显的 key 必须被脱敏');
    assert.match(body.error.message, /invalid api key \*\*\*/, '已知 key 被替换为 ***');
    const allLogs = [...s.logs.warn, ...s.logs.error, ...s.logs.info].join('\n');
    assert.equal(allLogs.includes(API_KEY), false, 'key 绝不进日志（llm.js 纪律 ③）');
    assert.equal(s.pool.titleUpdates.length, 0, '失败不落库');
  } finally {
    stub.restore();
    await s.close();
  }
});

test('issue #114 LLM 失败态：网络错误（fetch 抛错）→ 502，不落库', async () => {
  const s = await startServer({ binding: bindingRow(), messages: ['hi'] });
  const stub = stubUpstreamFetch(() => { throw new Error('connect ECONNREFUSED 127.0.0.1:443'); });
  try {
    const r = await callAiTitle(s);
    assert.equal(r.status, 502);
    const body = await r.json();
    assert.equal(body.error.code, 'llm_upstream_failed');
    assert.match(body.error.message, /ECONNREFUSED/);
    assert.equal(s.pool.titleUpdates.length, 0);
  } finally {
    stub.restore();
    await s.close();
  }
});

test('issue #114 LLM 失败态：上游 200 但标题不可解析（空 content）→ 502', async () => {
  const s = await startServer({ binding: bindingRow(), messages: ['hi'] });
  const stub = stubUpstreamFetch(() => jsonResponse(200, { choices: [{ message: { content: '   ' } }] }));
  try {
    const r = await callAiTitle(s);
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error.code, 'llm_upstream_failed');
    assert.equal(s.pool.titleUpdates.length, 0);
  } finally {
    stub.restore();
    await s.close();
  }
});

test('issue #114 LLM 失败态：超时 → 502 且原因为超时（直调 generateAiTitle，注入 20ms 超时）', async () => {
  const s = await startServer({ binding: bindingRow(), messages: ['hi'] });
  const realFetch = globalThis.fetch;
  // 上游永不返回（仅在 abort 时拒绝）→ 只能由内部超时定时器终止。
  globalThis.fetch = (url, init) => {
    if (!String(url).includes('/chat/completions')) return realFetch(url, init);
    return new Promise((_res, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    });
  };
  try {
    await assert.rejects(
      () => generateAiTitle(s.pool, { userId: USER.id, sessionId: SESSION_ID, timeoutMs: 20, log: { warn() {}, info() {} } }),
      (e) => e.code === 'llm_upstream_failed' && e.httpStatus === 502 && /超时/.test(e.message),
    );
    assert.equal(s.pool.titleUpdates.length, 0, '超时不落库');
  } finally {
    globalThis.fetch = realFetch;
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// 属主鉴权（同 PATCH）
// ---------------------------------------------------------------------------

test('issue #114：非属主 / 未登录 → 404 / 401（不泄露存在性）', async () => {
  const s = await startServer({ binding: bindingRow(), messages: ['hi'], ownerId: OTHER_USER_ID });
  const stub = stubUpstreamFetch(() => jsonResponse(200, { choices: [{ message: { content: 'x' } }] }));
  try {
    const notOwner = await callAiTitle(s);
    assert.equal(notOwner.status, 404, '他人会话一律 404（不泄露存在性）');
    assert.equal((await notOwner.json()).error.code, 'not_found');

    const anonymous = await callAiTitle(s, { cookie: null });
    assert.equal(anonymous.status, 401);

    const badId = await callAiTitle(s, { sessionId: 'not-a-uuid' });
    assert.equal(badId.status, 404);
    assert.equal(stub.calls.length, 0, '鉴权失败不得触达上游');
  } finally {
    stub.restore();
    await s.close();
  }
});
