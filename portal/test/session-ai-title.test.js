// HTTP 级测试：issue #114「AI 改名」端点 POST /api/sessions/:id/ai-title。
// 三态（issue 验收）：成功（mock LiteLLM 数据面）/ 无 binding 409 / LLM 失败 502；
// 另覆盖：属主鉴权 404、无用户消息 409、无本地 provider 回退、key 纪律（不进响应/日志）。
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool + 桩掉上游 fetch，不碰真实 DB / 网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { generateAiTitle, AI_TITLE_MAX_TOKENS } from '../src/sessions.js';
import { createSessionTextHandler, inputTranscriptRow } from './fake-session-text.js';
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
 * （fetchSession / 首 3 条 user 消息 / FDE binding）+ 落库 UPDATE。
 */
class AiTitlePool extends FakePool {
  constructor({ binding = null, providerRow = null, messages = [], transcriptRows = [], ownerId = USER.id } = {}) {
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
    // P3 PR②b B1 ①：AI 改名上下文改走 session-text（锚点 + transcript 投影）。
    // `messages` 元素：字符串 = 只有锚点正文（legacy 形态）；
    // `{ anchor, transcript }` = 锚点正文与 transcript 正文**不同**（用来断言取数来源）。
    this.anchoredMessages = messages.map((content, index) => ({
      id: `am${index + 1}`,
      session_id: SESSION_ID,
      run_id: `ar${index + 1}`,
      seq: index + 1,
      role: 'user',
      content: typeof content === 'string' ? content : content.anchor,
      synthetic: false,
      attachments: [],
    }));
    this.transcriptRows = transcriptRows ?? [];
    for (const [index, content] of messages.entries()) {
      if (typeof content === 'string' || typeof content.transcript !== 'string') continue;
      this.transcriptRows.push(inputTranscriptRow({
        sessionId: SESSION_ID,
        messageId: this.anchoredMessages[index].id,
        text: content.transcript,
        round: index + 1,
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)),
      }));
    }
    this.sessionText = createSessionTextHandler({
      messages: this.anchoredMessages, transcriptRows: this.transcriptRows, sessionId: SESSION_ID,
    });
    this.titleUpdates = [];
    this.seenSql = [];
  }

  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.seenSql.push(s);
    const hit = this.sessionText(s, params);
    if (hit) return hit;
    if (s.includes('FROM chat_sessions s')) return { rows: [this.sessionRow] };
    if (s.includes('FROM fde_llm_bindings')) return { rows: this.binding ? [this.binding] : [] };
    if (s.startsWith('UPDATE chat_sessions SET title')) {
      this.titleUpdates.push({ sql: s, params });
      this.sessionRow.title = params[1];
      this.sessionRow.title_source = 'manual';
      return { rows: [{ ...this.sessionRow, updated_at: new Date('2026-10-01T01:00:00.000Z') }] };
    }
    return super.query(sql, params);
  }
}

/** FDE binding row: Station stores model_info.id and sends LiteLLM model_name to the data plane. */
const bindingRow = (over = {}) => ({
  fde_id: USER.id, api_key: API_KEY, state: 'active', gateway: 'litellm',
  provider_id: 'deepseek', main_model_id: 'model-info-id-deepseek-flash', main_model_name: 'deepseek-flash',
  embedding_model_id: null, vision_model_id: null,
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
    llmGatewayUrl: 'http://127.0.0.1:4100',
    llmGatewayAdminUrl: 'http://station-litellm:4000',
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
    assert.equal(stub.calls[0].url, 'http://station-litellm:4000/v1/chat/completions', 'portal 使用 backend 上 LiteLLM 地址，Traefik 则使用 host-network 回环 URL');
    assert.equal(stub.calls[0].init.method, 'POST');
    assert.equal(stub.calls[0].init.headers.Authorization, `Bearer ${API_KEY}`);
    const payload = JSON.parse(stub.calls[0].init.body);
    assert.equal(payload.model, 'deepseek-flash', '用 binding 保存的 LiteLLM data-plane model_name');
    assert.equal(payload.stream, false);
    assert.equal(payload.max_tokens, AI_TITLE_MAX_TOKENS, '#315：显式带上 max_tokens，不吃网关注入的模型级默认');
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

test('issue #114：无 FDE binding → 不回退到已退役的本地 provider/model 目录', async () => {
  const s = await startServer({
    binding: null,
    providerRow: { base_url: 'http://127.0.0.1:4100', model_id: 'deepseek-flash' },
    messages: ['本地自建端点'],
  });
  const stub = stubUpstreamFetch(() => jsonResponse(200, { choices: [{ message: { content: '本地端点命名' } }] }));
  try {
    const r = await callAiTitle(s);
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error.code, 'llm_not_configured');
    assert.equal(stub.calls.length, 0, '不允许回退到退役目录表');
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

// ---------------------------------------------------------------------------
// P3 PR②b B1 ①：AI 改名上下文取数来源 = transcript 投影（不再是 messages.content）
// ---------------------------------------------------------------------------

test('P3 PR②b ①：AI 改名上下文取自 transcript 投影；messages.content 只在投影无证据时 legacy 兜底', async () => {
  const s = await startServer({
    binding: bindingRow(),
    // 每条的锚点正文（messages.content）与 transcript 正文**不同** → 只有取到 transcript 才会命中后者。
    messages: [
      { anchor: '锚点旧文A', transcript: 'transcript 正文A' },
      { anchor: '锚点旧文B', transcript: 'transcript 正文B' },
    ],
  });
  const stub = stubUpstreamFetch(() => jsonResponse(200, { choices: [{ message: { content: '标题' } }] }));
  try {
    const r = await callAiTitle(s);
    assert.equal(r.status, 200);
    const payload = JSON.parse(stub.calls[0].init.body);
    assert.match(payload.messages[1].content, /transcript 正文A/);
    assert.match(payload.messages[1].content, /transcript 正文B/);
    assert.equal(payload.messages[1].content.includes('锚点旧文A'), false, '正文不得来自 messages.content');
  } finally {
    stub.restore();
    await s.close();
  }
});

test('#315 跨路径一致：AI 改名发的 max_tokens == runner 自动标题的 maxTokens == 512（不一致就是这张单的本体）', async () => {
  // 这个数为什么必须两边一样：两条路径干同一件事（给会话起标题），只是执行位置不同
  //（runner 随 run 终态自动起 / portal 响应用户点「AI 改名」）。历史上只有 runner 那条设了上限
  // ⇒ 同一次起标题，走哪条路决定了要不要吃网关注入的模型级 max_tokens。
  assert.equal(AI_TITLE_MAX_TOKENS, 512, '门户侧那个数本身钉在 512（标题 ≤30 字，够用）');
  const runnerSrc = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../runner/lib/session-title.js'), 'utf8');
  assert.match(runnerSrc, /maxTokens:\s*512/,
    'runner 侧仍是 512 —— 两边任一改动都必须同时改对面（这条用例就是那个提醒）');
});

test('P3 PR②b ① legacy 兜底：投影对该轮无证据（无 transcript 行）→ 回退 messages.content，AI 改名仍可用', async () => {
  const s = await startServer({ binding: bindingRow(), messages: ['仅锚点正文的一条老消息'] });
  const stub = stubUpstreamFetch(() => jsonResponse(200, { choices: [{ message: { content: '标题' } }] }));
  try {
    const r = await callAiTitle(s);
    assert.equal(r.status, 200);
    const payload = JSON.parse(stub.calls[0].init.body);
    assert.match(payload.messages[1].content, /仅锚点正文的一条老消息/, 'legacy-only 兜底（迁移 0015 之前的行）');
  } finally {
    stub.restore();
    await s.close();
  }
});
