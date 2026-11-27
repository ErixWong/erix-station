// 单测：issue #803 S2-G——从 **HTTP 面** 钉住「市场 + 委派」两族错误文案的
// 「双语 + 错误体形状 + httpStatus 语义」。仿 `macro-messages-i18n.test.js`（S2-F）的起服务与两腿写法。
//
// 每个 case 两腿：
//   · `Cookie: <session>; locale=en` ⇒ `error.message` **逐字**等于错误新增 `en` 透出的英文；
//   · 不带 locale cookie ⇒ **逐字**等于原中文（`this.en` 缺省时行为逐字不变的回归钉子）。
// `twoLeg` 统一再钉：错误体键集合不变、`en` 不外泄、`httpStatus` 语义不变（断言 status 码）。
//
// 覆盖 8 类：
//   市场（`MarketError`，出口 http.js:1127）：条目不存在 / 必填校验错 / 未发布（状态冲突 409）/
//     启用数超限（预算 409）。
//   委派（`DelegationError`，出口 http.js:1143）：runId 形态非法 / fde_name 缺失 / tail 形状错 /
//     子 run 账本超限（413）。
// 注：委派「路径逃逸」（`assertUnderRoot`）与「`userSpaceRoot` 未配置 500」都不可从 HTTP 命中
//   （前者被 `PARENT_RUN_ID_RE`/`CHILD_RUN_ID_RE` 锁死形状、后者 `config.userSpaceRoot` 恒有值），
//   故 HTTP 面以可达的「runId 形态非法」（同守住路径边界的前置）替之，另以直调钉 500 一条的
//   `httpStatus`+`en`（见文件末尾）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import * as market from '../src/market.js';
import * as delegation from '../src/delegation.js';
import { FakePool } from './fake-pool.js';

const SELF_UID = process.getuid?.() ?? 1000;
const SELF_GID = process.getgid?.() ?? 1000;

// admin：跑 `/api/admin/*`（requireAdmin 只看 role === 'admin'）；带 fde_name 又能满足用户面的
// `marketFdeOf`（安装/委派根都读 `user.fde_name`）。
const ADMIN = {
  id: 'a0000000-0000-4000-8000-00000000000a', login: 'root', display_name: 'Root',
  role: 'admin', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const ADMIN_TOKEN = 'tok-s2g-admin';
// 一个有会话、但 `fde_name` 为空的普通用户：命中委派 `delegationRoot` 的 fde_name 缺失分支。
const UFDE = {
  id: 'b0000000-0000-4000-8000-00000000000b', login: 'nofde', display_name: 'NoFde',
  role: 'fde', fde_name: null, auth_source: 'local', status: 'active',
};
const UFDE_TOKEN = 'tok-s2g-ufde';

const UUID = '00000000-0000-4000-8000-000000000001';
const SESSION_A = '10000000-0000-4000-8000-00000000000a';
const SESSION_B = '10000000-0000-4000-8000-00000000000b';
const PARENT_RUN = '20000000-0000-4000-8000-00000000000a';
const PARENT_RUN_B = '20000000-0000-4000-8000-00000000000b';
const CHILD = 'sub-30000000-0000-4000-8000-00000000000c';

// ── 服务与断言脚手架（与 S2-F 同形）────────────────────────────────────────────
const KEYSET = ['code', 'details', 'message', 'retryable'];

async function hit(base, { method, p, cookie, ct = 'application/json', body }) {
  const headers = {};
  if (ct) headers['content-type'] = ct;
  if (cookie) headers['cookie'] = cookie;
  const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
  const res = await fetch(base + p, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON：留 null */ }
  return { status: res.status, error: json?.error };
}

async function twoLeg(s, req, { code, enMsg, zhMsg, http, keys = KEYSET }) {
  const en = await hit(s.base, { ...req, cookie: `${req.cookie}; locale=en` });
  assert.ok(en.error, `en 腿应返回错误信封：${req.method} ${req.p}`);
  assert.equal(en.status, http, `en 腿 httpStatus 语义变了：${req.p}`);
  assert.equal(en.error.code, code, `en 腿 code 不符：${req.p}`);
  assert.equal(en.error.message, enMsg, `en 腿文案不符：${req.p}`);
  assert.ok(!('en' in en.error), `en 不得出现在错误体（en 腿）：${req.p}`);
  assert.deepEqual(Object.keys(en.error).sort(), keys, `en 腿错误体键集合变了：${req.p}`);

  const zh = await hit(s.base, { ...req });
  assert.ok(zh.error, `缺省腿应返回错误信封：${req.method} ${req.p}`);
  assert.equal(zh.status, http, `缺省腿 httpStatus 语义变了：${req.p}`);
  assert.equal(zh.error.code, code, `缺省腿 code 不符：${req.p}`);
  assert.equal(zh.error.message, zhMsg, `缺省腿文案不符：${req.p}`);
  assert.ok(!('en' in zh.error), `en 不得出现在错误体（缺省腿）：${req.p}`);
  assert.deepEqual(Object.keys(zh.error).sort(), keys, `缺省腿错误体键集合变了：${req.p}`);
}

function baseConfig(userspace) {
  return {
    cookie: cookieSettings('dev-s2g', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    loginRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 100, maxEntries: 10000 },
    kdfConcurrency: 2, kdfQueueLimit: 100, kdfQueueTimeoutMs: 30000,
    maxLoginLength: 128, maxPasswordLength: 256,
    totp: { issuer: 'erix-station-test', digits: 6, period: 30, window: 1 },
    dockerHost: 'tcp://127.0.0.1:1', staticDir: fs.mkdtempSync(path.join(os.tmpdir(), 'station-s2g-static-')),
    userSpaceRoot: userspace, fdeUid: SELF_UID, fdeGid: SELF_GID, fileUploadMaxBytes: 32 * 1024 * 1024,
    traefikDynamicDir: fs.mkdtempSync(path.join(os.tmpdir(), 'station-s2g-tls-')),
  };
}

async function serve(pool, userspace) {
  const config = baseConfig(userspace);
  const server = createServer({
    pool, config, docker: null, llmGateway: null,
    log: { error: () => {}, warn: () => {}, log: () => {}, debug: () => {} },
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    pool,
    adminCookie: `${config.cookie.name}=${ADMIN_TOKEN}`,
    ufdeCookie: `${config.cookie.name}=${UFDE_TOKEN}`,
    userspace,
    close: () => new Promise((res) => server.close(res))
      .finally(() => fs.rmSync(userspace, { recursive: true, force: true })),
  };
}

// ── 市场：Pool 只对「按 slug 取条目 / 已装记录 / 启用计数」三条给行，其余回落 FakePool（空行）────
function marketItem(slug, state) {
  return {
    id: '40000000-0000-4000-8000-0000000000d0', slug, version: '1.0.0',
    name: 'Demo', summary: 'demo', kind: 'skill', state,
    manifest: {}, security_score: null, security_warnings: [],
  };
}
class MarketPool extends FakePool {
  constructor() {
    super({ users: [ADMIN] });
    this.sessions.push({
      id: 'ls-admin', user_id: ADMIN.id, token_hash: auth.hashToken(ADMIN_TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
  }

  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.includes('FROM capability_items WHERE slug = $1')) {
      const state = params[0] === 'draft-skill' ? 'draft' : params[0] === 'pub-skill' ? 'published' : null;
      return { rows: state ? [marketItem(params[0], state)] : [] };
    }
    // `selectInstall`：一律「未装」（触发默认 wantEnabled）。
    if (s.includes('FROM fde_capability_installs inst JOIN capability_items i ON i.id = inst.item_id WHERE inst.fde_id = $1 AND i.slug = $2')) {
      return { rows: [] };
    }
    // `countEnabled`：给到上限值，触发预算 409。
    if (s.includes('count(*)::int AS n')) return { rows: [{ n: market.LIMITS.maxEnabledSkills }] };
    return super.query(sql, params); // 登录会话、`getAdminItem`（按 id）等回落：未识别 SELECT ⇒ 空行 ⇒ notFound。
  }
}

async function startMarketServer() {
  const userspace = fs.mkdtempSync(path.join(os.tmpdir(), 'station-s2g-market-'));
  return serve(new MarketPool(), userspace);
}

// ── 委派：补三条查询（会话属主 / fde_name / 父 run 归属），登录会话仍交 FakePool ─────────────
class DelegationPool extends FakePool {
  constructor() {
    super({ users: [ADMIN, UFDE] });
    for (const [id, token] of [['ls-admin', ADMIN_TOKEN], ['ls-ufde', UFDE_TOKEN]]) {
      const uid = id === 'ls-admin' ? ADMIN.id : UFDE.id;
      this.sessions.push({
        id, user_id: uid, token_hash: auth.hashToken(token),
        created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
      });
    }
    this.chatSessions = [
      { id: SESSION_A, user_id: ADMIN.id, status: 'active' },
      { id: SESSION_B, user_id: UFDE.id, status: 'active' },
    ];
    this.runs = [
      { id: PARENT_RUN, session_id: SESSION_A, status: 'running' },
      { id: PARENT_RUN_B, session_id: SESSION_B, status: 'running' },
    ];
  }

  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.includes('AS run_status')) {
      const sess = this.chatSessions.find((x) => x.id === params[0]);
      if (!sess) return { rows: [] };
      const u = this.users.find((x) => x.id === sess.user_id && x.status === 'active');
      const run = params[1] == null ? null : this.runs.find((r) => r.id === params[1] && r.session_id === sess.id);
      return { rows: [{ id: sess.id, user_id: sess.user_id, status: sess.status, fde_name: u ? u.fde_name : null, run_id: run ? run.id : null, run_status: run ? run.status : null }] };
    }
    if (s.includes('FROM chat_sessions s')) {
      const row = this.chatSessions.find((x) => x.id === params[0]);
      return { rows: row ? [{ ...row, project_id: null, cwd: '~/projects/p', title: '', title_source: 'auto', model: null, last_seq: 0 }] : [] };
    }
    if (s.includes('fde_name FROM users')) {
      const u = this.users.find((x) => x.id === params[0] && x.status === 'active');
      return { rows: u ? [{ fde_name: u.fde_name }] : [] };
    }
    if (s.includes('FROM runs WHERE id = $1 AND session_id = $2')) {
      return { rows: this.runs.some((r) => r.id === params[0] && r.session_id === params[1]) ? [{ '?column?': 1 }] : [] };
    }
    return super.query(sql, params);
  }
}

async function startDelegationServer({ withTranscript } = {}) {
  const userspace = fs.mkdtempSync(path.join(os.tmpdir(), 'station-s2g-deleg-'));
  if (withTranscript) {
    // 名册 + 一份超 8 MiB 的账本，命中 `getDelegateTranscript` 的 413（在解析账本**之前**抛出）。
    const roster = path.join(userspace, 'alice', 'home', 'delegation', 'roster', PARENT_RUN);
    const transcripts = path.join(userspace, 'alice', 'home', 'delegation', 'transcripts');
    fs.mkdirSync(roster, { recursive: true });
    fs.mkdirSync(transcripts, { recursive: true });
    fs.writeFileSync(path.join(roster, `${CHILD}.json`), JSON.stringify({ state: 'done' }));
    fs.writeFileSync(path.join(transcripts, `${CHILD}.jsonl`), Buffer.alloc(delegation.DELEGATE_TRANSCRIPT_MAX_BYTES + 1));
  }
  return serve(new DelegationPool(), userspace);
}

// ── 市场 8 类中的 4 类，各两腿 ─────────────────────────────────────────────────

test('市场·条目不存在（GET 管理台条目 → notFound 404 capability_not_found）', async () => {
  const s = await startMarketServer();
  try {
    await twoLeg(s, { method: 'GET', p: `/api/admin/market/items/${UUID}/secrets`, cookie: s.adminCookie }, {
      code: 'capability_not_found', http: 404,
      enMsg: 'item does not exist', zhMsg: '条目不存在',
    });
  } finally { await s.close(); }
});

test('市场·必填校验错（POST 发布空体 → name 必填 400 validation_failed）', async () => {
  const s = await startMarketServer();
  try {
    await twoLeg(s, { method: 'POST', p: '/api/admin/market/items', cookie: s.adminCookie, body: {} }, {
      code: 'validation_failed', http: 400,
      enMsg: 'name is required', zhMsg: 'name 必填',
    });
  } finally { await s.close(); }
});

test('市场·未发布（安装 draft 条目 → 状态冲突 409 capability_not_published，模板串插值）', async () => {
  const s = await startMarketServer();
  try {
    await twoLeg(s, { method: 'POST', p: '/api/market/items/draft-skill/install', cookie: s.adminCookie, body: {} }, {
      code: 'capability_not_published', http: 409,
      enMsg: 'item state is draft; only published items can be installed',
      zhMsg: '条目状态是 draft，只有 published 可安装',
    });
  } finally { await s.close(); }
});

test('市场·启用数超限（安装已发布技能且启用数达上限 → 预算 409 capability_budget_exceeded）', async () => {
  const s = await startMarketServer();
  try {
    const limit = market.LIMITS.maxEnabledSkills;
    await twoLeg(s, { method: 'POST', p: '/api/market/items/pub-skill/install', cookie: s.adminCookie, body: {} }, {
      code: 'capability_budget_exceeded', http: 409,
      enMsg: `enabled skills have reached the limit of ${limit}`,
      zhMsg: `启用的技能已达上限 ${limit} 个`,
    });
  } finally { await s.close(); }
});

// ── 委派 8 类中的 4 类，各两腿 ─────────────────────────────────────────────────

test('委派·runId 形态非法（delegates 缺省查询带坏 runId → 400 validation_failed）', async () => {
  const s = await startDelegationServer();
  try {
    await twoLeg(s, { method: 'GET', p: `/api/sessions/${SESSION_A}/delegates?runId=notauuid`, cookie: s.adminCookie, ct: null }, {
      code: 'validation_failed', http: 400,
      enMsg: 'invalid runId', zhMsg: 'runId 形态非法',
    });
  } finally { await s.close(); }
});

test('委派·fde_name 缺失（属主会话有、无 fde_name → 400 validation_failed，与 sessions.js 同口径）', async () => {
  const s = await startDelegationServer();
  try {
    await twoLeg(s, { method: 'GET', p: `/api/sessions/${SESSION_B}/delegates?runId=${PARENT_RUN_B}`, cookie: s.ufdeCookie, ct: null }, {
      code: 'validation_failed', http: 400,
      enMsg: 'the current user has no fde_name configured, cannot determine the home directory',
      zhMsg: '当前用户未配置 fde_name，无法确定家目录',
    });
  } finally { await s.close(); }
});

test('委派·tail 形状错（越界 tail → 400 validation_failed，details.field=tail）', async () => {
  const s = await startDelegationServer();
  try {
    await twoLeg(s, { method: 'GET', p: `/api/sessions/${SESSION_A}/delegates/${CHILD}?runId=${PARENT_RUN}&tail=999`, cookie: s.adminCookie, ct: null }, {
      code: 'validation_failed', http: 400,
      enMsg: `tail must be an integer between 1 and ${delegation.DELEGATE_TAIL_MAX}`,
      zhMsg: `tail 必须是 1..${delegation.DELEGATE_TAIL_MAX} 的整数`,
    });
  } finally { await s.close(); }
});

test('委派·账本超限（子 run 账本 > 8 MiB → 413 payload_too_large，details.size/max_bytes 不变）', async () => {
  const s = await startDelegationServer({ withTranscript: true });
  try {
    const req = { method: 'GET', p: `/api/sessions/${SESSION_A}/delegates/${CHILD}?runId=${PARENT_RUN}`, cookie: s.adminCookie, ct: null };
    await twoLeg(s, req, {
      code: 'payload_too_large', http: 413,
      enMsg: 'child run ledger exceeds the read limit', zhMsg: '子 run 账本超过读取上限',
    });
    // 另钉 `details` 的两格语义不变（数字键，不随 locale 变）。
    const en = await hit(s.base, { ...req, cookie: `${req.cookie}; locale=en` });
    assert.equal(en.error.details.max_bytes, delegation.DELEGATE_TRANSCRIPT_MAX_BYTES);
    assert.ok(en.error.details.size > delegation.DELEGATE_TRANSCRIPT_MAX_BYTES, 'details.size 应为真实超限字节数');
  } finally { await s.close(); }
});

// ── 直调钉 500 一条：`userSpaceRoot` 未配置（config.userSpaceRoot 恒有值 ⇒ 不可从 HTTP 命中）────
test('委派·userSpaceRoot 未配置（直调 delegationRoot → internal 500 + en，httpStatus 语义不变）', () => {
  let err;
  try {
    delegation.delegationRoot({ fdeName: 'alice' }); // 不给 userSpaceRoot
  } catch (e) { err = e; }
  assert.ok(err instanceof delegation.DelegationError);
  assert.equal(err.httpStatus, 500, 'httpStatus 500 语义不许动');
  assert.equal(err.code, 'internal');
  assert.equal(err.message, 'userSpaceRoot 未配置');
  assert.equal(err.en, 'userSpaceRoot is not configured');
});

// ── #803 返修第 ④ 条：同一句中文有**两个抛点**的文案，两支都必须钉 ──────────────────
//
// 坑的来历：`market.js` 里这两句文案各有两个抛出点，而本片此前只覆盖了「安装」那一支
// （甚至凭据缺失两支都没覆盖）——删掉另一支的 `en:` 时用例仍是绿的。
//   · 预算：`installCapability`（market.js 安装分支）与 `setCapabilityEnabled`（启用分支）；
//   · 凭据缺失：`installCapability`（安装即启用）与 `setCapabilityEnabled`（启用时再查槽位）。
// 下面三支：启用分支的预算一条、凭据缺失的两支各一条 ⇒ 三处抛出点各有自己的判据。
const MCP_SLUG = 'pub-mcp';

function marketMcpItem(slug) {
  return { ...marketItem(slug, 'published'), kind: 'mcp' };
}

/**
 * 启用面 / 槽位面都要用到的 pool：
 *   · 条目按 slug 给（`pub-skill` = 已发布技能，`pub-mcp` = 已发布 MCP）；
 *   · `selectInstall` 给调用方指定的那一行（`null` = 未装）；
 *   · `countEnabled` **按 kind 分开**：技能给到上限（让启用分支撞预算），MCP 给 0
 *     （让请求走到槽位闸，而不是先被预算拦下——预算排在槽位之前）；
 *   · `capability_params` 声明一个必填 secret，`capability_param_values` 无行 ⇒ `missing` 非空。
 */
class BranchPool extends FakePool {
  constructor({ installRow = null } = {}) {
    super({ users: [ADMIN] });
    this.installRow = installRow;
    this.sessions.push({
      id: 'ls-admin', user_id: ADMIN.id, token_hash: auth.hashToken(ADMIN_TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
  }

  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.includes('FROM capability_items WHERE slug = $1')) {
      if (params[0] === 'pub-skill') return { rows: [marketItem(params[0], 'published')] };
      if (params[0] === MCP_SLUG) return { rows: [marketMcpItem(params[0])] };
      return { rows: [] };
    }
    if (s.includes('FROM fde_capability_installs inst JOIN capability_items i ON i.id = inst.item_id WHERE inst.fde_id = $1 AND i.slug = $2')) {
      return { rows: this.installRow ? [{ version: '1.0.0', ...this.installRow }] : [] };
    }
    if (s.includes('count(*)::int AS n')) {
      return { rows: [{ n: params[1] === 'mcp' ? 0 : market.LIMITS.maxEnabledSkills }] };
    }
    if (/FROM\s+capability_params\b/.test(s)) {
      return { rows: [{ name: 'API_TOKEN', kind: 'secret', inject: 'env', required: true }] };
    }
    if (s.includes('FROM capability_param_values')) return { rows: [] };
    return super.query(sql, params);
  }
}

async function startBranchServer({ installRow = null } = {}) {
  const userspace = fs.mkdtempSync(path.join(os.tmpdir(), 'station-s2g-branch-'));
  return serve(new BranchPool({ installRow }), userspace);
}

test('市场·启用数超限（启用分支，market.js 的第二个预算抛点）→ 预算 409 capability_budget_exceeded', async () => {
  const s = await startBranchServer({ installRow: { enabled: false } });
  try {
    const limit = market.LIMITS.maxEnabledSkills;
    const req = { method: 'POST', p: '/api/market/items/pub-skill/enabled', cookie: s.adminCookie, body: { enabled: true } };
    await twoLeg(s, req, {
      code: 'capability_budget_exceeded', http: 409,
      enMsg: `enabled skills have reached the limit of ${limit}`,
      zhMsg: `启用的技能已达上限 ${limit} 个`,
    });
    // 数字格与 locale 无关（钉的是「两条语言腿共用同一份机器可读 details」）。
    const en = await hit(s.base, { ...req, cookie: `${req.cookie}; locale=en` });
    assert.deepEqual(en.error.details, { max_enabled: limit, enabled_now: limit, kind: 'skill' });
  } finally { await s.close(); }
});

const SECRET_MISSING_ZH = '还有必填凭据没配置，无法启用（等管理员配置）';
const SECRET_MISSING_EN = 'required credentials are not configured yet, cannot enable (waiting for an administrator to configure them)';

test('市场·凭据缺失（安装分支：装 MCP 且 enabled:true）→ 409 capability_secret_missing', async () => {
  const s = await startBranchServer(); // 未装 ⇒ 走 installCapability
  try {
    const req = { method: 'POST', p: `/api/market/items/${MCP_SLUG}/install`, cookie: s.adminCookie, body: { enabled: true } };
    await twoLeg(s, req, {
      code: 'capability_secret_missing', http: 409, enMsg: SECRET_MISSING_EN, zhMsg: SECRET_MISSING_ZH,
    });
    const en = await hit(s.base, { ...req, cookie: `${req.cookie}; locale=en` });
    assert.deepEqual(en.error.details, { slug: MCP_SLUG, missing: ['API_TOKEN'] });
  } finally { await s.close(); }
});

test('市场·凭据缺失（启用分支，market.js 的第二个凭据抛点）→ 409 capability_secret_missing', async () => {
  // `existing.enabled = true`：预算闸的条件是「这次要启用 且 当前是停用」，所以这条**绕开预算**，
  // 专门打槽位闸（§4：MCP 只要请求启用就查槽位，不只在状态迁移时查）。
  const s = await startBranchServer({ installRow: { enabled: true } });
  try {
    const req = { method: 'POST', p: `/api/market/items/${MCP_SLUG}/enabled`, cookie: s.adminCookie, body: { enabled: true } };
    await twoLeg(s, req, {
      code: 'capability_secret_missing', http: 409, enMsg: SECRET_MISSING_EN, zhMsg: SECRET_MISSING_ZH,
    });
    const en = await hit(s.base, { ...req, cookie: `${req.cookie}; locale=en` });
    assert.deepEqual(en.error.details, { slug: MCP_SLUG, missing: ['API_TOKEN'] });
  } finally { await s.close(); }
});
