// issue #808 用户面额度/用量端点 + createQuotaCache 的单测。
// 写法照 portal/test/llm.test.js（同测 llm.js 纯函数与 http 端点），但独立成文件，不动 llm.test.js。
// 假库照 portal/test/git-hosts.test.js：FakePool 解析会话，注入假 llmGateway，createServer + fetch 端到端。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createQuotaCache,
  getSelfQuota,
  getSelfUsage,
  LlmError,
  LlmGatewayError,
} from '../src/llm.js';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { FakePool } from './fake-pool.js';

const ALICE_ID = '00000000-0000-4000-8000-0000000000a1';
const BOB_ID = '00000000-0000-4000-8000-0000000000b0';
const GHOST_ID = '00000000-0000-4000-8000-00000000000c'; // 无 fde_name 的账号（测 fde_name_required）
const ALICE_TOKEN = 'self-quota-alice';
const BOB_TOKEN = 'self-quota-bob';
const GHOST_TOKEN = 'self-quota-ghost';

// ── 纯函数腿用的最小假库 / 假网关 ──────────────────────────────────────────
function makeBinding(overrides = {}) {
  return {
    provider_id: 'p1',
    api_key: 'sk-self-test-key',
    gateway: 'litellm',
    gateway_user_id: 'gw-user-1',
    key_id: 'k1',
    key_alias: 'alice',
    state: 'active',
    budget_usd: 100,
    budget_period: '1mo',
    main_model_id: null, main_model_name: null,
    embedding_model_id: null, embedding_model_name: null,
    vision_model_id: null, vision_model_name: null,
    ...overrides,
  };
}

// getFdeBudget / getFdeBudgetUsage 只会打这两条 SQL；binding=null 模拟「无 active litellm 绑定」。
function makeLlmStubPool({ binding = makeBinding(), userExists = true } = {}) {
  return {
    calls: [],
    async query(sql, params = []) {
      this.calls.push({ sql, params });
      if (sql.includes('SELECT id FROM users WHERE fde_name')) {
        return { rows: userExists ? [{ id: 'u-1' }] : [] };
      }
      if (sql.includes('FROM fde_llm_bindings') && sql.includes("state = 'active'")) {
        return { rows: binding ? [binding] : [] };
      }
      return { rows: [] };
    },
  };
}

// getGatewayClient 走鸭子判定：必须至少带 generateKey/updateKey/listModels 之一才会被当作网关客户端。
function makeGateway({ keyInfoResult = {}, keyInfoError = null, dailyResult = { results: [] }, dailyError = null } = {}) {
  return {
    keyInfoCalls: [],
    dailyCalls: [],
    generateKey: async () => ({}),
    async keyInfo(key) {
      this.keyInfoCalls.push(key);
      if (keyInfoError) throw keyInfoError;
      return keyInfoResult;
    },
    async userDailyActivity(query) {
      this.dailyCalls.push(query);
      if (dailyError) throw dailyError;
      return dailyResult;
    },
  };
}

const QUOTA_INFO = { info: { max_budget: 100, budget_duration: '1mo', budget_reset_at: '2026-12-01T00:00:00Z', spend: 7.5 } };

// ── getSelfQuota ────────────────────────────────────────────────────────────
test('getSelfQuota：有 active 绑定 ⇒ quota 与 getFdeBudget 同形、spend_scope=period、reason=null', async () => {
  const pool = makeLlmStubPool({ binding: makeBinding({ budget_usd: 100, budget_period: '1mo' }) });
  const gateway = makeGateway({ keyInfoResult: QUOTA_INFO });
  const result = await getSelfQuota(pool, { fdeName: 'alice', gateway });

  assert.equal(result.reason, null);
  assert.equal(result.quota.spend_scope, 'period', '有 budget_duration ⇒ 本周期口径');
  // 字段齐全：与 §4.10 / getFdeBudget 的 projectQuota 形状逐字一致
  assert.deepEqual(Object.keys(result.quota).sort(), [
    'budget_duration', 'budget_period', 'budget_reset_at', 'budget_usd',
    'max_budget', 'remaining', 'spend', 'spend_scope',
  ]);
  assert.equal(result.quota.budget_usd, 100);   // DB 真相
  assert.equal(result.quota.budget_period, '1mo');
  assert.equal(result.quota.max_budget, 100);   // 网关读数
  assert.equal(result.quota.spend, 7.5);
  assert.equal(result.quota.remaining, 92.5);
  assert.equal(result.quota.budget_duration, '1mo');
});

test('getSelfQuota：无 active 绑定 ⇒ quota=null、reason=no_binding（getFdeBudget 抛 not_found）', async () => {
  const pool = makeLlmStubPool({ binding: null });
  const gateway = makeGateway({ keyInfoResult: QUOTA_INFO });
  const result = await getSelfQuota(pool, { fdeName: 'alice', gateway });
  assert.equal(result.quota, null);
  assert.equal(result.reason, 'no_binding');
  // 无绑定时 getFdeBudget 在打网关 keyInfo 之前就抛，故根本没查网关
  assert.equal(gateway.keyInfoCalls.length, 0);
});

test('getSelfQuota：网关抛 LlmGatewayError ⇒ 原样向上抛，绝不吞成 no_binding 空态', async () => {
  const pool = makeLlmStubPool({ binding: makeBinding() });
  const gateway = makeGateway({ keyInfoError: new LlmGatewayError(502, 'gateway down') });
  await assert.rejects(
    getSelfQuota(pool, { fdeName: 'alice', gateway }),
    (err) => err instanceof LlmGatewayError && err.status === 502,
    '网关错误必须透传，不能变成 quota:null 的假空态',
  );
});

test('getSelfQuota：非 not_found 的 LlmError 也原样抛（只有 not_found 才是空态）', async () => {
  const pool = {
    async query() { throw new LlmError('validation_failed', 'boom', { httpStatus: 400 }); },
  };
  await assert.rejects(
    getSelfQuota(pool, { fdeName: 'alice', gateway: makeGateway() }),
    (err) => err instanceof LlmError && err.code === 'validation_failed',
  );
});

// ── getSelfUsage：委托 getFdeBudgetUsage，不复制逻辑 ────────────────────────
test('getSelfUsage：委托 getFdeBudgetUsage ⇒ 返回 {days,totals}，把 days 透传到网关查询', async () => {
  const pool = makeLlmStubPool({ binding: makeBinding() });
  const gateway = makeGateway({
    dailyResult: { results: [{ date: '2026-06-01', metrics: { spend: 1, total_tokens: 10, prompt_tokens: 4, completion_tokens: 6, api_requests: 2 } }] },
  });
  const usage = await getSelfUsage(pool, { fdeName: 'alice', gateway, days: 7 });
  assert.deepEqual(Object.keys(usage).sort(), ['days', 'totals']);
  assert.equal(usage.totals.spend, 1);
  assert.equal(usage.totals.total_tokens, 10);
  assert.equal(gateway.dailyCalls.length, 1, '走的是网关聚合端点（委托，不自己算）');
  assert.equal(gateway.dailyCalls[0].timezone, 480);
  // days=7 ⇒ 区间跨度应为 7 天（start = 6 天前，end = 今天）
  const start = new Date(gateway.dailyCalls[0].start_date);
  const end = new Date(gateway.dailyCalls[0].end_date);
  assert.equal(Math.round((end - start) / 86_400_000), 6);
});

// ── createQuotaCache ────────────────────────────────────────────────────────
test('createQuotaCache：TTL 内命中返回旧值；过 TTL（注入 now）自动过期；clear 立即生效', () => {
  let clock = 1000;
  const cache = createQuotaCache({ ttlMs: 30_000, now: () => clock });
  assert.equal(cache.get('alice'), undefined, '未命中 ⇒ undefined');

  cache.set('alice', { quota: { max_budget: 1 }, reason: null });
  clock = 1000 + 29_999;
  assert.deepEqual(cache.get('alice'), { quota: { max_budget: 1 }, reason: null }, 'TTL 内命中');

  clock = 1000 + 30_000; // 到点即过期（>=）
  assert.equal(cache.get('alice'), undefined, '过 TTL ⇒ 过期重取');

  cache.set('bob', 'B');
  cache.clear();
  assert.equal(cache.get('bob'), undefined, 'clear 后全部作废');
});

test('createQuotaCache：端点用法（get-else-fetch-set）下错误不入缓存 ⇒ 连续两次都真打', async () => {
  // 复刻 http 端点里那 4 行 get-else-fetch-set 模式，用计数 fetcher 证明「失败不写缓存」。
  const cache = createQuotaCache({ ttlMs: 30_000, now: () => 0 });
  let attempts = 0;
  const fetchFail = async () => {
    attempts += 1;
    throw new LlmGatewayError(500, 'down');
  };
  const readThrough = async (fetcher) => {
    const hit = cache.get('alice');
    if (hit !== undefined) return hit;
    const value = await fetcher(); // 抛错时下面 set 不执行 ⇒ 不写缓存
    cache.set('alice', value);
    return value;
  };
  await assert.rejects(() => readThrough(fetchFail));
  await assert.rejects(() => readThrough(fetchFail));
  assert.equal(attempts, 2, '失败不写缓存 ⇒ 两次调用都真打到网关');
});

// ── HTTP 端点腿 ─────────────────────────────────────────────────────────────
class SelfPool extends FakePool {
  constructor({ bindings } = {}) {
    super({
      users: [
        { id: ALICE_ID, login: 'alice', role: 'fde', fde_name: 'alice', status: 'active', auth_source: 'local', display_name: 'Alice' },
        { id: BOB_ID, login: 'bob', role: 'fde', fde_name: 'bob', status: 'active', auth_source: 'local', display_name: 'Bob' },
        { id: GHOST_ID, login: 'ghost', role: 'fde', fde_name: null, status: 'active', auth_source: 'local', display_name: 'Ghost' },
      ],
    });
    this.bindings = bindings ?? {}; // userId -> binding row（null/缺失 ⇒ 无 active 绑定）
  }

  async query(sql, params = []) {
    if (sql.includes('SELECT id FROM users WHERE fde_name')) {
      const u = this.users.find((x) => x.fde_name === params[0] && x.status === 'active');
      return { rows: u ? [{ id: u.id }] : [] };
    }
    if (sql.includes('FROM fde_llm_bindings') && sql.includes("state = 'active'")) {
      const binding = this.bindings[params[0]];
      return { rows: binding ? [binding] : [] };
    }
    return super.query(sql, params);
  }
}

async function startSelfServer({ pool, gateway }) {
  const config = {
    cookie: cookieSettings('self-quota-test', 600),
    sessionTtlSeconds: 600,
    sessionRenewIntervalSeconds: 3600,
    loginRateLimit: { maxFailures: 20, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: {
      maxFailures: 20, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 20, maxEntries: 100,
    },
    kdfConcurrency: 1,
    kdfQueueLimit: 10,
    kdfQueueTimeoutMs: 1000,
    staticDir: process.cwd(),
  };
  for (const [id, token] of [[ALICE_ID, ALICE_TOKEN], [BOB_ID, BOB_TOKEN], [GHOST_ID, GHOST_TOKEN]]) {
    pool.sessions.push({
      id: `session-${id}`,
      user_id: id,
      token_hash: hashToken(token),
      created_at: new Date(),
      expires_at: new Date(Date.now() + 600_000),
      last_seen_at: new Date(),
      revoked_at: null,
    });
  }
  const server = createServer({ pool, config, log: { error() {}, warn() {} }, llmGateway: gateway });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    cookie: (token) => `${config.cookie.name}=${token}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('GET /api/me/llm-quota：200 且形状对（quota + reason），有绑定时 spend_scope=period', async () => {
  const pool = new SelfPool({ bindings: { [ALICE_ID]: makeBinding({ budget_usd: 100 }) } });
  const gateway = makeGateway({ keyInfoResult: QUOTA_INFO });
  const srv = await startSelfServer({ pool, gateway });
  try {
    const res = await fetch(`${srv.base}/api/me/llm-quota`, { headers: { cookie: srv.cookie(ALICE_TOKEN) } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['quota', 'reason']);
    assert.equal(body.reason, null);
    assert.equal(body.quota.spend_scope, 'period');
    assert.equal(body.quota.budget_usd, 100);
    assert.equal(body.quota.remaining, 92.5);
    assert.equal(gateway.keyInfoCalls.length, 1);
  } finally {
    await srv.close();
  }
});

test('GET /api/me/llm-quota：30s 缓存 ⇒ 同一 server 内两次 GET 只打一次网关', async () => {
  const pool = new SelfPool({ bindings: { [ALICE_ID]: makeBinding({ budget_usd: 100 }) } });
  const gateway = makeGateway({ keyInfoResult: QUOTA_INFO });
  const srv = await startSelfServer({ pool, gateway });
  try {
    const a = await (await fetch(`${srv.base}/api/me/llm-quota`, { headers: { cookie: srv.cookie(ALICE_TOKEN) } })).json();
    const b = await (await fetch(`${srv.base}/api/me/llm-quota`, { headers: { cookie: srv.cookie(ALICE_TOKEN) } })).json();
    assert.deepEqual(a, b);
    assert.equal(gateway.keyInfoCalls.length, 1, '第二次应命中缓存');
  } finally {
    await srv.close();
  }
});

test('GET /api/me/llm-usage?days=7：正常透传到网关，返回 {days,totals}', async () => {
  const pool = new SelfPool({ bindings: { [ALICE_ID]: makeBinding() } });
  const gateway = makeGateway({
    dailyResult: { results: [{ date: '2026-06-01', metrics: { spend: 2, total_tokens: 20, prompt_tokens: 8, completion_tokens: 12, api_requests: 3 } }] },
  });
  const srv = await startSelfServer({ pool, gateway });
  try {
    const res = await fetch(`${srv.base}/api/me/llm-usage?days=7`, { headers: { cookie: srv.cookie(ALICE_TOKEN) } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['days', 'totals']);
    assert.equal(body.totals.spend, 2);
    assert.equal(gateway.dailyCalls.length, 1);
    assert.equal(gateway.dailyCalls[0].timezone, 480);
    const start = new Date(gateway.dailyCalls[0].start_date);
    const end = new Date(gateway.dailyCalls[0].end_date);
    assert.equal(Math.round((end - start) / 86_400_000), 6, 'days=7 ⇒ 6 天跨度');
  } finally {
    await srv.close();
  }
});

for (const [label, qs] of [['0', 'days=0'], ['91', 'days=91'], ['空串 ?days=', 'days=']]) {
  test(`GET /api/me/llm-usage 非法 days（${label}）⇒ 400 validation_failed + details.field=days`, async () => {
    const pool = new SelfPool({ bindings: { [ALICE_ID]: makeBinding() } });
    const gateway = makeGateway();
    const srv = await startSelfServer({ pool, gateway });
    try {
      const res = await fetch(`${srv.base}/api/me/llm-usage?${qs}`, { headers: { cookie: srv.cookie(ALICE_TOKEN) } });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, 'validation_failed');
      assert.equal(body.error.details.field, 'days');
      assert.equal(gateway.dailyCalls.length, 0, '校验在打网关之前就拒');
    } finally {
      await srv.close();
    }
  });
}

test('非 GET ⇒ 405 method_not_allowed（llm-quota 与 llm-usage 都是）', async () => {
  const pool = new SelfPool({ bindings: { [ALICE_ID]: makeBinding() } });
  const srv = await startSelfServer({ pool, gateway: makeGateway() });
  try {
    for (const path of ['/api/me/llm-quota', '/api/me/llm-usage']) {
      const res = await fetch(`${srv.base}${path}`, { method: 'POST', headers: { cookie: srv.cookie(ALICE_TOKEN) } });
      assert.equal(res.status, 405, `${path} 非 GET 应 405`);
      const body = await res.json();
      assert.equal(body.error.code, 'method_not_allowed');
    }
  } finally {
    await srv.close();
  }
});

test('未认证 ⇒ 401（requireSession 既有语义）', async () => {
  const pool = new SelfPool({ bindings: { [ALICE_ID]: makeBinding() } });
  const srv = await startSelfServer({ pool, gateway: makeGateway() });
  try {
    for (const path of ['/api/me/llm-quota', '/api/me/llm-usage']) {
      const res = await fetch(`${srv.base}${path}`);
      assert.equal(res.status, 401, `${path} 无 cookie 应 401`);
    }
  } finally {
    await srv.close();
  }
});

test('越权面：两个 session 用户各查各的账（结构上无 fde 参数路径，?fde_name 被忽略）', async () => {
  // alice / bob 额度不同（budget_usd 取各自 DB 绑定）；若端点能从 query/body 取 fde 就会串号。
  const pool = new SelfPool({
    bindings: {
      [ALICE_ID]: makeBinding({ budget_usd: 100 }),
      [BOB_ID]: makeBinding({ budget_usd: 250 }),
    },
  });
  const gateway = makeGateway({ keyInfoResult: QUOTA_INFO });
  const srv = await startSelfServer({ pool, gateway });
  try {
    const alice = await (await fetch(`${srv.base}/api/me/llm-quota`, { headers: { cookie: srv.cookie(ALICE_TOKEN) } })).json();
    const bob = await (await fetch(`${srv.base}/api/me/llm-quota`, { headers: { cookie: srv.cookie(BOB_TOKEN) } })).json();
    assert.equal(alice.quota.budget_usd, 100, 'alice 看 alice 的额度');
    assert.equal(bob.quota.budget_usd, 250, 'bob 看 bob 的额度');

    // 即便显式带 ?fde_name=bob，alice 仍拿到自己的（端点根本不读这个参数）
    const srv2 = await startSelfServer({
      pool: new SelfPool({ bindings: { [ALICE_ID]: makeBinding({ budget_usd: 100 }), [BOB_ID]: makeBinding({ budget_usd: 250 }) } }),
      gateway: makeGateway({ keyInfoResult: QUOTA_INFO }),
    });
    try {
      const trick = await (await fetch(`${srv2.base}/api/me/llm-quota?fde_name=bob`, { headers: { cookie: srv2.cookie(ALICE_TOKEN) } })).json();
      assert.equal(trick.quota.budget_usd, 100, '?fde_name=bob 被忽略，仍是自己的账');
    } finally {
      await srv2.close();
    }
  } finally {
    await srv.close();
  }
});

test('无 fde_name 的账号 ⇒ 400 fde_name_required（与 git-credential 同口径）', async () => {
  const pool = new SelfPool({ bindings: {} });
  const srv = await startSelfServer({ pool, gateway: makeGateway() });
  try {
    const res = await fetch(`${srv.base}/api/me/llm-quota`, { headers: { cookie: srv.cookie(GHOST_TOKEN) } });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'fde_name_required');
  } finally {
    await srv.close();
  }
});
