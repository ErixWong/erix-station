// issue #727：管理台按 FDE 只读浏览「会话记录 + 项目文件」的 HTTP 层判据
// （契约 docs/api/portal.md §4.22）。
//
// 这一层验的是**入口**：鉴权、跨属主的 404 形状、`include_archived` 的开与关、
// 牢笼的四条 400、审计「恰好一行 + 5 分钟去重 + 写失败不阻断」。
// 牢笼算法本身（containment / 逐段 lstat）在 `dirs.test.js` 里已经钉过，这里不重复。
//
// 隔离约定（docs/testing.md §2.1）：`FakePool` 子类 + 真 HTTP（fetch），零真 DB、零容器。
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { FakePool } from './fake-pool.js';
import { listSessions } from '../src/sessions.js';
import { resetAuditDedupForTest } from '../src/admin-seat-content.js';

const ADMIN = {
  id: 'e0000000-0000-4000-8000-0000000000b1', login: 'root', display_name: 'Root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
  file_upload_enabled: false,
};
const FDE = {
  id: 'e0000000-0000-4000-8000-0000000000b2', login: 'alice', display_name: 'Alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
  file_upload_enabled: true,
};
const FDE_BOB = {
  id: 'e0000000-0000-4000-8000-0000000000b3', login: 'bob', display_name: 'Bob',
  // **停用**用户的记录仍要可读：这是本单与 `resolveFdeByName`（只认 active）的差别。
  role: 'fde', fde_name: 'bob', auth_source: 'local', status: 'disabled',
  file_upload_enabled: true,
};

const S_ACTIVE = 'a0000000-0000-4000-8000-00000000a001';
const S_ARCHIVED = 'a0000000-0000-4000-8000-00000000a002';
const S_BOB = 'b0000000-0000-4000-8000-00000000b001';
const S_MISSING = 'c0000000-0000-4000-8000-00000000c001';

const T1 = new Date('2026-11-20T10:00:00.000Z');
const T2 = new Date('2026-11-21T10:00:00.000Z');

function seedChat() {
  return [
    {
      id: S_ACTIVE, user_id: FDE.id, project_id: null, cwd: '~/projects/proj-a',
      title: 'alpha 会话', title_source: 'manual', model: 'm', status: 'active',
      last_seq: 5, origin: 'web', created_at: T1, updated_at: T2,
    },
    {
      id: S_ARCHIVED, user_id: FDE.id, project_id: null, cwd: '~/projects/proj-b',
      title: 'beta 归档会话', title_source: 'manual', model: 'm', status: 'archived',
      last_seq: 2, origin: 'web', created_at: T1, updated_at: T1,
    },
    {
      id: S_BOB, user_id: FDE_BOB.id, project_id: null, cwd: '~/projects/proj-c',
      title: 'bob 的会话', title_source: 'manual', model: 'm', status: 'active',
      last_seq: 1, origin: 'web', created_at: T1, updated_at: T2,
    },
  ];
}

/** LIKE 语义的 fake 实现（`%` / `_` / `ESCAPE '\'` 都按 SQL 说的做，不拿 includes 兼平）。 */
function likeToRegExp(pattern) {
  const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\') { out += esc(pattern[i + 1] ?? ''); i += 1; continue; }
    if (c === '%') { out += '[\\s\\S]*'; continue; }
    if (c === '_') { out += '[\\s\\S]'; continue; }
    out += esc(c);
  }
  return new RegExp(`${out}$`, 'i');
}

/** 按 SELECT 的列清单投影（真 PG 只回点名的列；漏补列必须能在用例里红出来）。 */
function projectCols(sql, row, extras = {}) {
  const m = /SELECT ([\s\S]*?)\n\s+FROM /.exec(sql);
  if (!m) return { ...row };
  const out = {};
  for (const raw of m[1].split(',')) {
    const t = raw.trim();
    const as = /\bAS\s+(\w+)\s*$/i.exec(t);
    let name = as ? as[1] : null;
    if (!name && /^[\w.]+$/.test(t)) name = t.split('.').pop();
    if (!name) continue;
    out[name] = name in extras ? extras[name] : (row[name] ?? null);
  }
  return out;
}

class SeatPool extends FakePool {
  constructor(opts = {}) {
    super(opts);
    this.chat = opts.chat ?? seedChat();
    this.runEvents = opts.runEvents ?? [];
    this.transcript = opts.transcript ?? [];
    this.failQueued = opts.failQueued ?? false;
    this.messageCount = opts.messageCount ?? 3;
  }

  async query(sql, params = []) {
    const text = String(sql);
    this.statements.push({ sql: text, params });

    if (/FROM\s+users WHERE fde_name = \$1/i.test(text)) {
      // **不带 status 条件**：停用用户也要查得到（本单口径），所以只按名字过滤。
      const u = this.users.find((x) => x.fde_name === params[0]);
      return { rows: u ? [{ id: u.id, fde_name: u.fde_name, status: u.status }] : [] };
    }

    if (/FROM\s+chat_sessions s\s+WHERE s\.id = \$1/i.test(text)) { // fetchSession
      const row = this.chat.find((c) => c.id === params[0]);
      if (!row) return { rows: [] };
      return {
        rows: [projectCols(text, row, {
          message_count: /\bAS message_count\b/i.test(text) ? this.messageCount : undefined,
        })],
      };
    }

    if (/SELECT\s+id\s+FROM\s+chat_sessions WHERE id = \$1 AND user_id = \$2/i.test(text)) {
      // events/history 的属主谓词（用户面与 admin 面同一条形状，只差 status 条件）。
      const row = this.chat.find((c) => c.id === params[0] && c.user_id === params[1]);
      const activeOnly = /AND\s+status = 'active'/i.test(text);
      return { rows: row && (!activeOnly || row.status === 'active') ? [{ id: row.id }] : [] };
    }

    if (/FROM\s+chat_sessions s\b/i.test(text) && /user_id = \$1/i.test(text)) { // listSessions
      const limit = Number(params[params.length - 1]);
      let rows = this.chat.filter((c) => c.user_id === params[0]);
      if (/AND\s+status = 'active'/i.test(text)) rows = rows.filter((c) => c.status === 'active');
      const cwdM = / AND cwd = \$(\d+)/i.exec(text);
      if (cwdM) rows = rows.filter((c) => c.cwd === params[Number(cwdM[1]) - 1]);
      const qM = /ILIKE \$(\d+)/i.exec(text);
      if (qM) {
        const re = likeToRegExp(params[Number(qM[1]) - 1]);
        rows = rows.filter((c) => re.test(c.title ?? '') || re.test(c.cwd ?? ''));
      }
      const keyM = /\(s\.updated_at, s\.id\) < \$(\d+), \$(\d+)/i.exec(text);
      if (keyM) {
        const tu = String(params[Number(keyM[1]) - 1]);
        const tid = String(params[Number(keyM[2]) - 1]);
        rows = rows.filter((c) => String(c.updated_at) < tu
          || (String(c.updated_at) === tu && String(c.id) < tid));
      }
      rows.sort((a, b) => (String(b.updated_at) < String(a.updated_at) ? -1
        : String(b.updated_at) > String(a.updated_at) ? 1
          : String(b.id) < String(a.id) ? -1 : 1));
      return {
        rows: rows.slice(0, limit).map((c) => projectCols(text, c, {
          active_run_id: null, message_count: this.messageCount,
        })),
      };
    }

    if (/SELECT\s+run_id, seq\s+FROM\s+run_events/i.test(text)) { // #514 候选发现
      return { rows: [] };
    }

    if (/FROM\s+run_events WHERE session_id = \$1 AND type = ANY\(\$2\)/i.test(text)) {
      const limit = Number(params[params.length - 1]);
      let rows = this.runEvents.filter((e) => e.session_id === params[0]
        && params[1].includes(e.type));
      const beforeM = / AND seq < \$(\d+)/i.exec(text);
      if (beforeM) {
        const before = Number(params[Number(beforeM[1]) - 1]);
        rows = rows.filter((e) => e.seq < before);
      }
      rows.sort((a, b) => b.seq - a.seq);
      return { rows: rows.slice(0, limit).map((e) => ({ ...e })) };
    }

    if (/FROM\s+transcript_rounds/i.test(text)) {
      const rows = this.transcript.filter(
        (t) => t.transcript_key === params[0] && t.round === Number(params[1]),
      );
      return { rows: rows.slice(0, Number(params[2] ?? rows.length)).map((t) => ({ ...t })) };
    }

    if (/FROM\s+queued_inputs/i.test(text)) {
      if (this.failQueued) throw new Error('fake：queued_inputs 读取失败（注入）');
      return { rows: [] };
    }

    if (/FROM\s+(messages|runs|tool_calls)\b/i.test(text)) return { rows: [] };

    return super.query(sql, params);
  }
}

function buildTree(userspace) {
  const root = path.join(userspace, 'alice', 'projects');
  fs.mkdirSync(path.join(root, 'proj-a', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(root, 'proj-a', '.git'), { recursive: true });
  // 点开头的**目录**：唯一的排除项是 `.git`，其余照常列（复审 MAJOR 1）
  fs.mkdirSync(path.join(root, 'proj-a', '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'proj-a', '.github', 'workflows', 'ci.yml'), 'on: push\n');
  fs.mkdirSync(path.join(root, 'proj-b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'proj-a', 'README.md'), '# alpha\n');
  fs.writeFileSync(path.join(root, 'proj-a', '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(root, 'proj-a', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(root, 'proj-a', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(root, 'proj-a', 'nested', 'note.txt'), 'nested note\n');
  for (const name of ['f01.txt', 'f02.txt', 'f03.txt', 'f04.txt']) {
    fs.writeFileSync(path.join(root, 'proj-b', name), `${name}\n`);
  }
  fs.symlinkSync('README.md', path.join(root, 'proj-a', 'link.md'));
  fs.symlinkSync('nested', path.join(root, 'proj-a', 'linkdir'));
}

// ---- 夹具生命周期（#880）：谁建谁收尾，不靠进程退出 ----
// startStack 里的 staticDir（`station-static-`）进 tmpDirs，afterEach 逐格 rm（**不带 force**：rm 失败当场红）。
// userspace（`erix-727-`）照旧由 `close()` 收（既有写法，本单不动），故**不**进 tmpDirs。
const tmpDirs = [];
function trackTmp(dir) {
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, maxRetries: 3 });
  }
});

async function startStack(opts = {}) {
  const userspace = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-727-'));
  buildTree(userspace);
  const users = [ADMIN, FDE, FDE_BOB];
  const pool = new SeatPool({ users, ...opts });
  const tokens = new Map();
  for (const u of users) {
    const token = `${u.login}-tok`;
    tokens.set(u.login, token);
    pool.sessions.push({
      id: `s-${u.login}`, user_id: u.id, token_hash: hashToken(token),
      created_at: new Date(), expires_at: new Date(Date.now() + 3_600_000),
      last_seen_at: new Date(), revoked_at: null,
    });
  }
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 86400,
    sessionTtlSecondsSource: 'env',
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'T', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: {
      maxFailures: 5, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 5, maxEntries: 100,
    },
    kdfConcurrency: 2, kdfQueueLimit: 10, kdfQueueTimeoutMs: 30_000,
    maxLoginLength: 128, maxPasswordLength: 256,
    staticDir: trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-'))),
    userSpaceRoot: userspace,
    fdeUid: process.getuid?.() ?? 1000,
    fdeGid: process.getgid?.() ?? 1000,
    fileUploadMaxBytes: 32 * 1024 * 1024,
    fileUploadMaxBytesSource: 'env',
  };
  const server = createServer({
    pool,
    config,
    llmGateway: {
      async listCredentials() { return { credentials: [] }; },
      async listModels() { return { data: [] }; },
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const s = {
    pool,
    base: `http://127.0.0.1:${server.address().port}`,
    userspace,
    async get(p, login = 'root') {
      const res = await fetch(`${s.base}${p}`, {
        headers: { cookie: `fde_session_dev=${tokens.get(login)}` },
      });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      return { status: res.status, body, text, headers: res.headers };
    },
    async send(p, method, login = 'root') {
      const res = await fetch(`${s.base}${p}`, {
        method, headers: { cookie: `fde_session_dev=${tokens.get(login)}` },
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    close: () => new Promise((r) => server.close(r))
      .finally(() => fs.rmSync(userspace, { recursive: true, force: true })),
  };
  return s;
}

const auditRows = (pool, action) => pool.audit.filter((r) => r.action === action);

test('#727-1 非 admin 打七条端点一律 403 forbidden（鉴权在 handleAdminApi 入口）', async () => {
  const s = await startStack();
  try {
    const paths = [
      '/dirs', '/sessions', `/sessions/${S_ACTIVE}`,
      `/sessions/${S_ACTIVE}/events/history`, `/sessions/${S_ACTIVE}/folded/1`,
      '/files/tree', '/file?path=proj-a/README.md',
    ];
    for (const p of paths) {
      const r = await s.get(`/api/admin/fdes/alice${p}`, 'alice');
      assert.equal(r.status, 403, p);
      assert.equal(r.body.error.code, 'forbidden', p);
    }
  } finally { await s.close(); }
});

test('#727-1b 非 GET 一律 405 method_not_allowed', async () => {
  const s = await startStack();
  try {
    for (const p of ['/dirs', '/sessions', '/files/tree', '/file']) {
      const r = await s.send(`/api/admin/fdes/alice${p}`, 'POST');
      assert.equal(r.status, 405, p);
      assert.equal(r.body.error.code, 'method_not_allowed', p);
    }
  } finally { await s.close(); }
});

test('#727-2 跨 FDE 的 sessionId 与不存在的 sessionId：404 响应体逐字相同', async () => {
  const s = await startStack();
  try {
    for (const kind of ['', '/events/history', '/folded/1']) {
      const mine = await s.get(`/api/admin/fdes/alice/sessions/${S_BOB}${kind}`);
      const none = await s.get(`/api/admin/fdes/alice/sessions/${S_MISSING}${kind}`);
      assert.equal(mine.status, 404, kind);
      assert.equal(none.status, 404, kind);
      assert.equal(mine.text, none.text, kind); // 「不泄露存在性」的判据：两体逐字相同
      assert.equal(mine.body.error.code, 'not_found', kind);
      assert.equal(mine.body.error.message, 'session not found', kind);
    }
    // FDE 本身不存在 ⇒ 与 http.js 的 resolveAdminFde 同码同文案。
    const r = await s.get('/api/admin/fdes/nosuch/dirs');
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'not_found');
    assert.equal(r.body.error.message, 'FDE「nosuch」不存在');
    assert.deepEqual(r.body.error.details, { field: 'fde_name' });
  } finally { await s.close(); }
});

test('#727-3 include_archived 缺席：列表不含归档、详情 404；带 =1 三者都能读', async () => {
  const runEvents = [1, 2, 3].map((seq) => ({
    seq, run_id: null, type: 'round_end', session_id: S_ARCHIVED, payload: { round: seq },
  }));
  const transcript = [{
    transcript_key: S_ARCHIVED, round: 1, folded: true, append_seq: 1,
    folded_payload: [{ role: 'user', content: [{ type: 'text', text: '原文' }] }],
    record: null,
  }];
  const s = await startStack({ runEvents, transcript });
  try {
    const off = await s.get('/api/admin/fdes/alice/sessions');
    assert.equal(off.status, 200);
    assert.deepEqual(off.body.items.map((i) => i.id), [S_ACTIVE]);

    const on = await s.get('/api/admin/fdes/alice/sessions?include_archived=1');
    assert.deepEqual(on.body.items.map((i) => i.id).sort(), [S_ACTIVE, S_ARCHIVED].sort());

    const offDetail = await s.get(`/api/admin/fdes/alice/sessions/${S_ARCHIVED}`);
    assert.equal(offDetail.status, 404);

    const detail = await s.get(
      `/api/admin/fdes/alice/sessions/${S_ARCHIVED}?include_archived=1`,
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.session.id, S_ARCHIVED);

    const histOff = await s.get(`/api/admin/fdes/alice/sessions/${S_ARCHIVED}/events/history`);
    assert.equal(histOff.status, 404);
    const hist = await s.get(
      `/api/admin/fdes/alice/sessions/${S_ARCHIVED}/events/history?include_archived=1`,
    );
    assert.equal(hist.status, 200);
    assert.deepEqual(hist.body.events.map((e) => e.seq), [1, 2, 3]);

    const foldedOff = await s.get(`/api/admin/fdes/alice/sessions/${S_ARCHIVED}/folded/1`);
    assert.equal(foldedOff.status, 404);
    const folded = await s.get(
      `/api/admin/fdes/alice/sessions/${S_ARCHIVED}/folded/1?include_archived=1`,
    );
    assert.equal(folded.status, 200);
    assert.equal(folded.body.round, 1);
    assert.equal(folded.body.source, 'archive');

    // 停用 FDE 的目录列表仍可读（目标用户解析不限 status）。
    const bobDirs = await s.get('/api/admin/fdes/bob/dirs');
    assert.equal(bobDirs.status, 200);
    assert.deepEqual(bobDirs.body.dirs, []);
  } finally { await s.close(); }
});

test('#727-3b q 过滤：命中 title/cwd，转义 % 与 _，空白不加条件、超长 400', async () => {
  const s = await startStack();
  try {
    const hit = await s.get('/api/admin/fdes/alice/sessions?q=alpha');
    assert.deepEqual(hit.body.items.map((i) => i.id), [S_ACTIVE]);

    // q 命中的是 cwd（ILIKE 不区分大小写）；归档那条默认不在列表里，要带 include_archived。
    const hitCwd = await s.get('/api/admin/fdes/alice/sessions?q=PROJ-A');
    assert.deepEqual(hitCwd.body.items.map((i) => i.id), [S_ACTIVE]);
    const hitArch = await s.get(
      '/api/admin/fdes/alice/sessions?q=proj-b&include_archived=1',
    );
    assert.deepEqual(hitArch.body.items.map((i) => i.id), [S_ARCHIVED]);

    const escaped = await s.get('/api/admin/fdes/alice/sessions?q=%25'); // 字面量 %
    assert.deepEqual(escaped.body.items, []);

    for (const q of ['q=', 'q=%20%20']) {
      const r = await s.get(`/api/admin/fdes/alice/sessions?${q}`);
      assert.equal(r.status, 200, q);
      assert.deepEqual(r.body.items.map((i) => i.id), [S_ACTIVE], q);
    }
    // 超长（>100）⇒ 400，不是静默忽略（复审 MINOR 4：静默会让管理员以为搜过了）
    const tooLong = await s.get(`/api/admin/fdes/alice/sessions?q=${'x'.repeat(101)}`);
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error.code, 'validation_failed');
    assert.deepEqual(tooLong.body.error.details, { field: 'q' });
    assert.equal(tooLong.body.error.message, 'q 过长（≤100 字符）');
    // 边界：恰好 100 字符仍可用
    const justLong = await s.get(`/api/admin/fdes/alice/sessions?q=${'x'.repeat(100)}`);
    assert.equal(justLong.status, 200);
    const sql = s.pool.statements.map((x) => x.sql).join('\n');
    assert.match(sql, /ILIKE \$2 ESCAPE '\\' OR cwd ILIKE \$2 ESCAPE '\\'/);
  } finally { await s.close(); }
});

test('#727-4 详情带 queued_messages（取数抛错也兜底成空队列）', async () => {
  const s = await startStack();
  try {
    const r = await s.get(`/api/admin/fdes/alice/sessions/${S_ACTIVE}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.session.queued_messages, { steering: [], follow_up: [] });
    assert.equal(r.body.session.message_count, 3);
    assert.equal(r.body.last_seq, 5);
  } finally { await s.close(); }

  const s2 = await startStack({ failQueued: true });
  try {
    const r = await s2.get(`/api/admin/fdes/alice/sessions/${S_ACTIVE}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.session.queued_messages, { steering: [], follow_up: [] });
  } finally { await s2.close(); }
});

test('#727-4b history 的 before 分页与 next_cursor 与用户面逐字一致', async () => {
  const runEvents = [1, 2, 3, 4, 5].map((seq) => ({
    seq, run_id: null, type: 'round_end', session_id: S_ACTIVE, payload: { round: seq },
  }));
  const s = await startStack({ runEvents });
  try {
    for (const qs of ['limit=2', 'limit=2&before=4', 'limit=2&before=2', 'limit=2&before=1']) {
      const adminSide = await s.get(
        `/api/admin/fdes/alice/sessions/${S_ACTIVE}/events/history?${qs}`,
      );
      const userSide = await s.get(`/api/sessions/${S_ACTIVE}/events/history?${qs}`, 'alice');
      assert.equal(adminSide.status, 200, qs);
      assert.equal(userSide.status, 200, qs);
      assert.deepEqual(adminSide.body, userSide.body, qs);
    }
    const page1 = await s.get(
      `/api/admin/fdes/alice/sessions/${S_ACTIVE}/events/history?limit=2`,
    );
    assert.deepEqual(page1.body.events.map((e) => e.seq), [4, 5]);
    assert.equal(page1.body.next_cursor, 4);
    const page2 = await s.get(
      `/api/admin/fdes/alice/sessions/${S_ACTIVE}/events/history?limit=2&before=4`,
    );
    assert.deepEqual(page2.body.events.map((e) => e.seq), [2, 3]);
    assert.equal(page2.body.next_cursor, 2);
    const last = await s.get(
      `/api/admin/fdes/alice/sessions/${S_ACTIVE}/events/history?limit=2&before=2`,
    );
    assert.deepEqual(last.body.events.map((e) => e.seq), [1]);
    assert.equal(last.body.next_cursor, null);

    const badLimit = await s.get(
      `/api/admin/fdes/alice/sessions/${S_ACTIVE}/events/history?limit=0`,
    );
    assert.equal(badLimit.status, 400);
    assert.deepEqual(badLimit.body.error.details, { field: 'limit' });
    const badBefore = await s.get(
      `/api/admin/fdes/alice/sessions/${S_ACTIVE}/events/history?before=abc`,
    );
    assert.equal(badBefore.status, 400);
    assert.deepEqual(badBefore.body.error.details, { field: 'before' });
  } finally { await s.close(); }
});

test('#727-5 文件树：四条 400 与 after 续页、truncated 语义', async () => {
  const s = await startStack();
  try {
    const root = await s.get('/api/admin/fdes/alice/files/tree');
    assert.equal(root.status, 200);
    assert.deepEqual(root.body, {
      entries: [{ name: 'proj-a', type: 'dir' }, { name: 'proj-b', type: 'dir' }],
      truncated: false, next_after: null,
    });

    const cases = [
      ['../x', 'path 不得逃逸目录根', 400],
      ['a/%2e%2e/b', 'path 不得逃逸目录根', 400],
      ['%2fetc%2fpasswd', 'path 不得逃逸目录根', 400],
      ['proj-a/linkdir', 'path 含符号链接，拒绝读取', 400],
      ['proj-a/.git', 'path 不得进入 .git 目录', 400],
      ['proj-a/.git/HEAD', 'path 不得进入 .git 目录', 400],
      ['nope', 'path not found', 404],
    ];
    for (const [p, msg, status, details] of cases) {
      const r = await s.get(`/api/admin/fdes/alice/files/tree?path=${p}`);
      assert.equal(r.status, status, p);
      assert.equal(r.body.error.message, msg, p);
      assert.deepEqual(r.body.error.details, details ?? { field: 'path' }, p);
    }

    const listing = await s.get('/api/admin/fdes/alice/files/tree?path=proj-a');
    assert.deepEqual(listing.body.entries, [
      // 唯一的排除项是 `.git` 目录；其余点开头目录照常列（复审 MAJOR 1）
      { name: '.github', type: 'dir' },
      { name: 'nested', type: 'dir' },
      { name: '.gitignore', type: 'file' },
      { name: 'README.md', type: 'file' },
      { name: 'pic.png', type: 'file' },
    ]); // `.git` 目录不进树；link.md / linkdir 是 symlink 也不列

    const p1 = await s.get('/api/admin/fdes/alice/files/tree?path=proj-b&limit=2');
    assert.deepEqual(p1.body.entries.map((e) => e.name), ['f01.txt', 'f02.txt']);
    assert.equal(p1.body.truncated, true);
    assert.equal(p1.body.next_after, 'f:f02.txt', '游标 = <rank>:<name>');

    const p2 = await s.get(
      `/api/admin/fdes/alice/files/tree?path=proj-b&after=${p1.body.next_after}&limit=2`,
    );
    assert.deepEqual(p2.body.entries.map((e) => e.name), ['f03.txt', 'f04.txt']);
    assert.equal(p2.body.truncated, false);
    assert.equal(p2.body.next_after, null);

    const notDir = await s.get('/api/admin/fdes/alice/files/tree?path=proj-a/README.md');
    assert.equal(notDir.status, 400);
    assert.equal(notDir.body.error.message, 'path 必须是目录');
  } finally { await s.close(); }
});

test('#727-5b 单文件读取：json/stream/download 三档与牢笼 400', async () => {
  const s = await startStack();
  try {
    const json = await s.get('/api/admin/fdes/alice/file?path=proj-a/README.md');
    assert.equal(json.status, 200);
    assert.deepEqual(json.body, {
      name: 'README.md', path: 'proj-a/README.md', kind: 'text', data: '# alpha\n',
    });

    const stream = await s.get('/api/admin/fdes/alice/file?path=proj-a/README.md&mode=stream');
    assert.equal(stream.status, 200);
    // `.md` 不在媒体白名单 ⇒ 未知字节流强制 attachment（同源不 inline，防 XSS）。
    assert.equal(stream.headers.get('content-disposition'), 'attachment; filename="README.md"');
    assert.equal(stream.text, '# alpha\n');

    const png = await s.get('/api/admin/fdes/alice/file?path=proj-a/pic.png&mode=stream');
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(png.headers.get('content-disposition'), 'inline; filename="pic.png"');

    const range = await fetch(
      `${s.base}/api/admin/fdes/alice/file?path=proj-a/README.md&mode=stream`,
      { headers: { cookie: 'fde_session_dev=root-tok', range: 'bytes=0-1' } },
    );
    assert.equal(range.status, 206);
    assert.match(range.headers.get('content-range'), /^bytes 0-1\/\d+$/);
    assert.equal(await range.text(), '# ');

    const dl = await s.get('/api/admin/fdes/alice/file?path=proj-a/README.md&mode=download');
    assert.equal(dl.headers.get('content-disposition'), 'attachment; filename="README.md"');

    const dotfile = await s.get('/api/admin/fdes/alice/file?path=proj-a/.gitignore');
    assert.equal(dotfile.status, 200); // `.gitignore` 是文件，不受 `.git` 目录那条限制

    for (const p of ['proj-a/link.md', 'proj-a/.git/HEAD', '../x']) {
      const r = await s.get(`/api/admin/fdes/alice/file?path=${p}`);
      assert.equal(r.status, 400, p);
    }
    const noPath = await s.get('/api/admin/fdes/alice/file');
    assert.equal(noPath.status, 400); // `'.'` 不是具体文件
    assert.equal(noPath.body.error.message, 'path 必须是文件');
  } finally { await s.close(); }
});

test('#727-5c 分页并集 = 全量（同层目录+文件，游标必须带 rank）', async () => {
  const s = await startStack();
  try {
    const all = await s.get('/api/admin/fdes/alice/files/tree?path=proj-a');
    assert.equal(all.body.entries.filter((e) => e.type === 'dir').length, 2);
    assert.equal(all.body.entries.filter((e) => e.type === 'file').length, 3);

    const seen = [];
    let after = null;
    for (let guard = 0; ; guard += 1) {
      assert.ok(guard <= 20, '游标必须收敛');
      const tail = after ? `&after=${after}` : '';
      const page = await s.get(
        `/api/admin/fdes/alice/files/tree?path=proj-a&limit=1${tail}`,
      );
      assert.equal(page.status, 200);
      assert.equal(page.body.entries.length, 1, '每页恰好 limit 项');
      seen.push(...page.body.entries);
      if (!page.body.truncated) {
        assert.equal(page.body.next_after, null);
        break;
      }
      after = page.body.next_after;
    }
    // 逐页翻到底的并集 == 一次性全量：既不重复、也不整组跳过文件组
    assert.deepEqual(seen, all.body.entries);
    assert.equal(new Set(seen.map((e) => e.name)).size, seen.length);
  } finally { await s.close(); }
});

test('#727-5d after / mode 非法参数 ⇒ 400 且带 details.field', async () => {
  const s = await startStack();
  try {
    for (const bad of ['nested', '0:zzz', 'x:zzz', '%3Azzz']) {
      const r = await s.get(`/api/admin/fdes/alice/files/tree?after=${bad}`);
      assert.equal(r.status, 400, bad);
      assert.equal(r.body.error.code, 'validation_failed', bad);
      assert.deepEqual(r.body.error.details, { field: 'after' }, bad);
      assert.equal(r.body.error.message, 'after 非法', bad);
    }
    // mode 与用户面同口径：'' / json / stream / download 之外一律 400，不静默当 json
    for (const bad of ['bogus', 'JSON', 'STREAM']) {
      const r = await s.get(
        `/api/admin/fdes/alice/file?path=proj-a/README.md&mode=${bad}`,
      );
      assert.equal(r.status, 400, bad);
      assert.equal(r.body.error.code, 'validation_failed', bad);
      assert.deepEqual(r.body.error.details, { field: 'mode' }, bad);
      assert.equal(r.body.error.message, 'mode 只支持 json|stream|download', bad);
    }
    const ok = await s.get('/api/admin/fdes/alice/file?path=proj-a/README.md&mode=json');
    assert.equal(ok.status, 200);
  } finally { await s.close(); }
});

test('#727-6 审计：一次成功读取恰好一行，同键 5 分钟内不再写，写失败仍是 200', async () => {
  resetAuditDedupForTest();
  const s = await startStack();
  try {
    const p = 'path=proj-a/README.md';
    const one = await s.get(`/api/admin/fdes/alice/file?${p}`);
    assert.equal(one.status, 200);
    const rows = auditRows(s.pool, 'admin.fde_file_read');
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0].details), {
      fde_name: 'alice', path: 'proj-a/README.md', mode: 'json',
    });

    await s.get(`/api/admin/fdes/alice/file?${p}`);
    await s.get(`/api/admin/fdes/alice/file?${p}`);
    assert.equal(auditRows(s.pool, 'admin.fde_file_read').length, 1); // 去重窗口内

    await s.get(`/api/admin/fdes/alice/file?${p}&mode=download`); // 键含 mode ⇒ 另算一行
    assert.equal(auditRows(s.pool, 'admin.fde_file_read').length, 2);

    // 会话/目录类不去重：一次导航一行。
    await s.get('/api/admin/fdes/alice/dirs');
    await s.get('/api/admin/fdes/alice/dirs');
    assert.equal(auditRows(s.pool, 'admin.fde_dirs_listed').length, 2);
    assert.deepEqual(JSON.parse(auditRows(s.pool, 'admin.fde_dirs_listed')[0].details), {
      fde_name: 'alice', item_count: 2,
    });

    await s.get(`/api/admin/fdes/alice/sessions/${S_ACTIVE}`);
    await s.get(`/api/admin/fdes/alice/sessions/${S_ACTIVE}`);
    const reads = auditRows(s.pool, 'admin.fde_session_read');
    assert.equal(reads.length, 2);
    assert.deepEqual(JSON.parse(reads[0].details), {
      fde_name: 'alice', session_id: S_ACTIVE,
    });

    await s.get('/api/admin/fdes/alice/sessions');
    const listed = auditRows(s.pool, 'admin.fde_sessions_listed');
    assert.equal(listed.length, 1);
    assert.deepEqual(JSON.parse(listed[0].details), {
      fde_name: 'alice', item_count: 1, cwd: null, include_archived: false,
    });

    // 审计写抛错 ⇒ 只 warn，响应仍 200（`recordAdminAudit` 的失败不许冒泡）。
    s.pool.failAudit = true;
    resetAuditDedupForTest();
    const ok = await s.get('/api/admin/fdes/alice/file?path=proj-a/nested/note.txt');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.kind, 'text');
  } finally { await s.close(); }
});

test('#727-7 数据层默认行为不变：缺省 SQL 仍带 status 条件与转义后的 q', async () => {
  const seen = [];
  const spyPool = {
    async query(sql, params = []) {
      seen.push({ sql, params });
      return { rows: [] };
    },
  };
  await listSessions(spyPool, { userId: 'u1' });
  assert.match(seen[0].sql, /WHERE user_id = \$1 AND status = 'active'/);
  assert.doesNotMatch(seen[0].sql, /ILIKE/);

  await listSessions(spyPool, { userId: 'u1', includeArchived: true });
  assert.match(seen[1].sql, /WHERE user_id = \$1\n/);
  assert.doesNotMatch(seen[1].sql, /AND status = 'active'/);

  await listSessions(spyPool, { userId: 'u1', q: 'a\\b%c_d' });
  assert.match(seen[2].sql, /ILIKE \$2 ESCAPE '\\' OR cwd ILIKE \$2 ESCAPE '\\'/);
  assert.equal(seen[2].params[1], '%a\\\\b\\%c\\_d%');
});
