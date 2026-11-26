// issue #801：管理台「提示词」页的**生效面**数据层判据（契约 docs/api/portal.md §4.19-5）。
//
// 装配照 portal/test/platform-prompts.test.js：node:test + node:assert/strict + mkdtemp + 假 pool。
// 临时目录在本文件各格子的 teardown（t.after）里 rmSync(..., {recursive:true, force:true})，前缀自带。
// 隔离约定（docs/testing.md §2.1）：注入假 pool / 临时目录 / fs 桩，不碰真实 DB / 容器 / 网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { FakePool } from './fake-pool.js';
import { renderHomeAgentsMd } from '../src/materializer.js';
import { FDE_NAME_RE } from '../src/projects.js';
import {
  EFFECTIVE_DISK_READ_MAX_BYTES, EFFECTIVE_DISK_STATES,
  homeAgentsMdPathOf, readDiskHomeAgentsMd, toEffectiveAgentsMdDto, getEffectiveAgentsMd,
  PlatformPromptsError,
} from '../src/platform-prompts.js';

const sha = (text) => crypto.createHash('sha256').update(Buffer.from(String(text), 'utf8')).digest('hex');
const utf8 = (text) => Buffer.byteLength(String(text ?? ''), 'utf8');

const quietLog = { warn() {}, debug() {}, info() {}, error() {} };

/** 造一份临时用户空间根：建 `<root>/<fde>/home/`（可选再写 AGENTS.md）。返回带 cleanup。 */
function makeRoot({ fde, fileBody = undefined, dirInstead = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eff-userspace-'));
  const home = path.join(root, fde, 'home');
  fs.mkdirSync(home, { recursive: true });
  const target = path.join(home, 'AGENTS.md');
  if (dirInstead) {
    fs.mkdirSync(target, { recursive: true });
  } else if (typeof fileBody === 'string' || Buffer.isBuffer(fileBody)) {
    fs.writeFileSync(target, fileBody);
  }
  return { root, home, target, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * 模块层假 pool：按 SQL 分派，记全部语句。
 * - `SELECT id, fde_name, status FROM users WHERE fde_name = $1` → user（或空行）
 * - `SELECT ... FROM platform_prompts WHERE id = 1` → promptsRow（或空行；failPrompts 时抛）
 */
class EfPool {
  constructor({ user = null, promptsRow = null, failPrompts = false } = {}) {
    this.user = user;
    this.promptsRow = promptsRow;
    this.failPrompts = failPrompts;
    this.statements = [];
  }

  async query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    this.statements.push({ sql: s, params });
    if (s.includes('FROM users WHERE fde_name = $1')) {
      return { rows: this.user ? [{ id: 'u1', fde_name: this.user.fde_name, status: this.user.status ?? 'active' }] : [] };
    }
    if (s.includes('platform_prompts')) {
      if (this.failPrompts) { throw new Error('boom: platform_prompts 读不到'); }
      return { rows: this.promptsRow ? [this.promptsRow] : [] };
    }
    return { rows: [] };
  }
}

const promptsRow = ({ addendum = '', override = '', titlePrompt = '' } = {}) => ({
  agents_md_addendum: addendum, agents_md_override: override, title_prompt: titlePrompt,
  updated_at: new Date(), updated_by: null,
});

// ── 模块层格子 E1–E12 ───────────────────────────────────────────────────────────

test('E1 ok 且一致', async (t) => {
  const fde = 'alice';
  const r = makeRoot({ fde }); t.after(r.cleanup);
  const body = renderHomeAgentsMd({ fdeName: fde, addendum: '', override: '' });
  fs.writeFileSync(r.target, body);
  const pool = new EfPool({ user: { fde_name: fde }, promptsRow: promptsRow() });
  const dto = await getEffectiveAgentsMd({ pool, userSpaceRoot: r.root, fdeName: fde, log: quietLog });
  assert.equal(dto.disk.state, 'ok');
  assert.equal(dto.matches, true);
  assert.equal(dto.expected.bytes, dto.disk.bytes);
  assert.equal(dto.expected.sha256, sha(body));
  assert.equal(dto.disk.sha256, sha(body));
});

test('E2 盘上落后于 DB', async (t) => {
  const fde = 'alice';
  const r = makeRoot({ fde }); t.after(r.cleanup);
  // 盘上仍是「无追加段」那份；DB 里已经有追加段 ⇒ 盘上落后。
  fs.writeFileSync(r.target, renderHomeAgentsMd({ fdeName: fde, addendum: '', override: '' }));
  const pool = new EfPool({ user: { fde_name: fde }, promptsRow: promptsRow({ addendum: '收工前必须跑 npm test。' }) });
  const dto = await getEffectiveAgentsMd({ pool, userSpaceRoot: r.root, fdeName: fde, log: quietLog });
  assert.equal(dto.matches, false, '盘上那份 ≠ 该有那份');
  assert.ok(dto.expected.text.includes('平台补充约定'), '该有那份含追加段标题');
  assert.equal(dto.db.addendumBytes, 30);
  assert.equal(dto.source, 'db');
});

test('E3 盘上没有', async (t) => {
  const fde = 'alice';
  const r = makeRoot({ fde }); t.after(r.cleanup); // 目录存在但没有 AGENTS.md
  const pool = new EfPool({ user: { fde_name: fde }, promptsRow: promptsRow() });
  const dto = await getEffectiveAgentsMd({ pool, userSpaceRoot: r.root, fdeName: fde, log: quietLog });
  assert.equal(dto.disk.state, 'missing');
  assert.equal(dto.matches, null, '比对不了 ⇒ null，不塌成 false');
  assert.equal(dto.disk.text, null);
});

test('E4 不是普通文件', async (t) => {
  const fde = 'alice';
  const r = makeRoot({ fde, dirInstead: true }); t.after(r.cleanup); // AGENTS.md 是个目录
  const pool = new EfPool({ user: { fde_name: fde }, promptsRow: promptsRow() });
  const dto = await getEffectiveAgentsMd({ pool, userSpaceRoot: r.root, fdeName: fde, log: quietLog });
  assert.equal(dto.disk.state, 'not_a_file');
  assert.equal(dto.matches, null);
});

test('E4b symlink 不当生效全文', async (t) => {
  const fde = 'alice';
  // 临时用户空间：真文件放别处，`home/AGENTS.md` 做成指向它的 symlink。
  const r = makeRoot({ fde }); t.after(r.cleanup);
  const realFile = path.join(r.root, 'real-agents.md');
  fs.writeFileSync(realFile, renderHomeAgentsMd({ fdeName: fde }));
  fs.symlinkSync(realFile, r.target); // home/AGENTS.md 是指向真文件的 symlink
  // 直接读不抛（symlink 被 `lstat` 认出 ⇒ `not_a_file`，绝不被当成生效全文读进来）。
  const disk = await readDiskHomeAgentsMd({ userSpaceRoot: r.root, fdeName: fde, log: quietLog });
  assert.equal(disk.state, 'not_a_file');
  assert.equal(disk.text, null, 'symlink 不交出生效全文');
  // 走完整 DTO：同样 `not_a_file`、比对不了、没有盘上全文。
  const pool = new EfPool({ user: { fde_name: fde }, promptsRow: promptsRow() });
  const dto = await getEffectiveAgentsMd({ pool, userSpaceRoot: r.root, fdeName: fde, log: quietLog });
  assert.equal(dto.disk.state, 'not_a_file');
  assert.equal(dto.matches, null);
  assert.equal(dto.disk.text, null);
});

test('E5 读失败', async (t) => {
  const fde = 'alice';
  const r = makeRoot({ fde, fileBody: renderHomeAgentsMd({ fdeName: fde }) }); t.after(r.cleanup);
  const pool = new EfPool({ user: { fde_name: fde }, promptsRow: promptsRow() });
  const realOpen = fs.promises.open;
  fs.promises.open = async () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
  t.after(() => { fs.promises.open = realOpen; });
  const dto = await getEffectiveAgentsMd({ pool, userSpaceRoot: r.root, fdeName: fde, log: quietLog });
  assert.equal(dto.disk.state, 'read_failed');
  assert.equal(dto.matches, null);
});

test('E6 超读上限', async (t) => {
  const fde = 'alice';
  const size = EFFECTIVE_DISK_READ_MAX_BYTES + 700;
  const buf = Buffer.alloc(size, 0x61); // 'a' * size
  const r = makeRoot({ fde, fileBody: buf }); t.after(r.cleanup);
  const pool = new EfPool({ user: { fde_name: fde }, promptsRow: promptsRow() });
  const dto = await getEffectiveAgentsMd({ pool, userSpaceRoot: r.root, fdeName: fde, log: quietLog });
  assert.equal(dto.disk.truncated, true);
  assert.equal(dto.disk.sha256, null, '超限后不再承诺 sha256');
  assert.equal(dto.matches, null);
  assert.ok(dto.disk.text.length > 0);
  assert.equal(dto.disk.bytes, size, 'bytes 是真实大小');
});

test('E7 工位不存在', async () => {
  const pool = new EfPool({ user: null });
  await assert.rejects(
    () => getEffectiveAgentsMd({ pool, userSpaceRoot: '/tmp/whatever', fdeName: 'ghost', log: quietLog }),
    (err) => {
      assert.ok(err instanceof PlatformPromptsError);
      assert.equal(err.httpStatus, 404);
      assert.equal(err.code, 'not_found');
      assert.equal(err.details.field, 'fde_name');
      return true;
    },
  );
});

test('E8 fde 缺失/非法', async () => {
  const pool = new EfPool({ user: { fde_name: 'alice' } });
  for (const bad of ['', undefined, '../escape', 'a/b', 'A']) {
    await assert.rejects(
      () => getEffectiveAgentsMd({ pool, userSpaceRoot: '/tmp/whatever', fdeName: bad, log: quietLog }),
      (err) => {
        assert.ok(err instanceof PlatformPromptsError, `非法输入 ${JSON.stringify(bad)} 必须 400`);
        assert.equal(err.httpStatus, 400);
        assert.equal(err.code, 'validation_failed');
        assert.equal(err.details.field, 'fde');
        return true;
      },
      `非法输入 ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(pool.statements.length, 0, '校验在发任何 SQL 之前 ⇒ 一条 SQL 都不发');
});

test('E9 DB 读不到', async (t) => {
  const fde = 'alice';
  const r = makeRoot({ fde }); t.after(r.cleanup);
  const pool = new EfPool({ user: { fde_name: fde }, failPrompts: true });
  const dto = await getEffectiveAgentsMd({ pool, userSpaceRoot: r.root, fdeName: fde, log: quietLog });
  assert.equal(dto.source, 'builtin');
  assert.equal(dto.reason, 'read_failed');
  assert.equal(dto.expected.text, renderHomeAgentsMd({ fdeName: fde, addendum: '', override: '' }));
});

test('E10 零写零审计', async (t) => {
  const fde = 'alice';
  const r = makeRoot({ fde, fileBody: renderHomeAgentsMd({ fdeName: fde }) }); t.after(r.cleanup);
  const pool = new EfPool({ user: { fde_name: fde }, promptsRow: promptsRow() });
  await getEffectiveAgentsMd({ pool, userSpaceRoot: r.root, fdeName: fde, log: quietLog });
  assert.ok(pool.statements.length > 0, '至少发了 SELECT');
  for (const { sql } of pool.statements) {
    assert.ok(!/\bINSERT\b/i.test(sql), `无 INSERT：${sql}`);
    assert.ok(!/\bUPDATE\b/i.test(sql), `无 UPDATE：${sql}`);
    assert.ok(!/\bDELETE\b/i.test(sql), `无 DELETE：${sql}`);
    assert.ok(!/audit_log/i.test(sql), `无审计：${sql}`);
  }
});

test('E11 盘上用真工位名', async (t) => {
  const fde = 'alice-real-name-2026'; // 比 example（7）长
  assert.ok(FDE_NAME_RE.test(fde));
  assert.ok(fde.length > 'example'.length);
  const r = makeRoot({ fde }); t.after(r.cleanup);
  const pool = new EfPool({ user: { fde_name: fde }, promptsRow: promptsRow() });
  const dto = await getEffectiveAgentsMd({ pool, userSpaceRoot: r.root, fdeName: fde, log: quietLog });
  assert.ok(dto.expected.text.includes(`（FDE 标识：${fde}）`), '末尾标识行用真名');
  assert.ok(!dto.expected.text.includes('（FDE 标识：example）'), '不许出现示例名');
  assert.notEqual(dto.expected.bytes, 9021, '真名渲染字节 ≠ example 预览的 9021');
});

test('E12 响应键集合', async (t) => {
  const fde = 'alice';
  const r = makeRoot({ fde }); t.after(r.cleanup);
  const pool = new EfPool({ user: { fde_name: fde }, promptsRow: promptsRow() });
  const dto = await getEffectiveAgentsMd({ pool, userSpaceRoot: r.root, fdeName: fde, log: quietLog });
  assert.deepEqual(Object.keys(dto).sort(),
    ['db', 'disk', 'expected', 'fdeName', 'matches', 'reason', 'renderLimitBytes', 'source'].sort());
  assert.deepEqual(Object.keys(dto.disk).sort(),
    ['bytes', 'mtime', 'sha256', 'state', 'text', 'truncated'].sort());
  assert.deepEqual(Object.keys(dto.expected).sort(), ['bytes', 'sha256', 'text'].sort());
  assert.deepEqual(Object.keys(dto.db).sort(), ['addendumBytes', 'overrideBytes'].sort());
  // disk.state 取值集白名单
  assert.deepEqual(EFFECTIVE_DISK_STATES, Object.freeze(['ok', 'missing', 'not_a_file', 'read_failed']));
  assert.ok(EFFECTIVE_DISK_STATES.includes(dto.disk.state));
});

test('E13 父目录是 symlink 也不越界', async (t) => {
  // 场景：宿主机上 `<用户空间根>/<fde>` 与 `<用户空间根>/<fde>/home` 两级归工位用户可写，
  // 工位把 `home` 整跳换成指向**根外**目录的 symlink ⇒ 只靠词法 containment 的话，
  // `lstat` 看末端是普通文件、`open` 跟随中间的 `home` ⇒ 会读到用户空间之外那份。
  const fde = 'alice';
  const r = makeRoot({ fde }); t.after(r.cleanup);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eff-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const marker = 'E13-越界读探针串-801';
  fs.writeFileSync(path.join(outside, 'AGENTS.md'), `根外那份 ${marker}\n`);
  fs.rmdirSync(r.home); // 先拿掉真 home 目录（未写文件时是空的），再把同位置做成指向根外的 symlink
  fs.symlinkSync(outside, r.home);
  const pool = new EfPool({ user: { fde_name: fde }, promptsRow: promptsRow() });
  // 不抛：越界是 `state`，不是异常。
  const dto = await getEffectiveAgentsMd({ pool, userSpaceRoot: r.root, fdeName: fde, log: quietLog });
  assert.equal(dto.disk.state, 'not_a_file');
  assert.equal(dto.disk.text, null);
  assert.equal(dto.matches, null);
  const whole = JSON.stringify(dto);
  assert.ok(!whole.includes(marker), `响应里泄露了根外文件的内容：${whole.slice(0, 200)}`);
});

test('E14 目录还没物化仍是 missing', async (t) => {
  // `<fde>` 存在但没有 `home` 这一跳：realpath 那一跳 ENOENT 必须**放过**，交给 `lstat` 的 ENOENT
  // 走 `missing`。这一格存在的唯一理由是挡住「把 ENOENT 判成 read_failed」的写法。
  const fde = 'alice';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eff-userspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, fde), { recursive: true }); // 只建 `<fde>`，不建 `home`
  const pool = new EfPool({ user: { fde_name: fde }, promptsRow: promptsRow() });
  const dto = await getEffectiveAgentsMd({ pool, userSpaceRoot: root, fdeName: fde, log: quietLog });
  assert.equal(dto.disk.state, 'missing');
  assert.equal(dto.matches, null);
  assert.equal(dto.disk.text, null);
});

// ── HTTP 层格子 H1–H4 ────────────────────────────────────────────────────────────

const ADMIN = {
  id: 'd0000000-0000-4000-8000-0000000000a1', login: 'root', display_name: 'Root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
};
const FDE_U = {
  id: 'd0000000-0000-4000-8000-0000000000a2', login: 'alice', display_name: 'Alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};

/** FakePool + 生效面两条读 SQL（HTTP 层要真走会话鉴权，复用 FakePool 的会话面）。 */
class EfHttpPool extends FakePool {
  constructor({ failPrompts = false } = {}) {
    super({ users: [ADMIN, FDE_U] });
    this.failPrompts = failPrompts;
    this.tokens = new Map();
    for (const u of [ADMIN, FDE_U]) {
      const token = `${u.login}-tok`;
      this.tokens.set(u.login, token);
      this.sessions.push({
        id: `s-${u.login}`, user_id: u.id, token_hash: hashToken(token),
        created_at: new Date(), expires_at: new Date(Date.now() + 3_600_000),
        last_seen_at: new Date(), revoked_at: null,
      });
    }
  }

  async query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s.includes('FROM users WHERE fde_name = $1')) {
      return { rows: [{ id: FDE_U.id, fde_name: 'alice', status: 'active' }] };
    }
    if (s.includes('platform_prompts')) {
      if (this.failPrompts) throw new Error('boom');
      return { rows: [] };
    }
    return super.query(sql, params);
  }
}

async function startEf({ poolOpts = {}, seedFile = true } = {}) {
  const pool = new EfHttpPool(poolOpts);
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eff-static-'));
  const userSpaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eff-userspace-http-'));
  if (seedFile) {
    const home = path.join(userSpaceRoot, 'alice', 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'AGENTS.md'), renderHomeAgentsMd({ fdeName: 'alice' }));
  }
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'T', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 5, maxEntries: 100 },
    kdfConcurrency: 2, kdfQueueLimit: 10, kdfQueueTimeoutMs: 30_000,
    maxLoginLength: 128, maxPasswordLength: 256,
    staticDir, userSpaceRoot,
    fdeUid: process.getuid?.() ?? 1000,
    fdeGid: process.getgid?.() ?? 1000,
  };
  const server = createServer({ pool, config });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    pool,
    base: `http://127.0.0.1:${server.address().port}`,
    cookieFor: (login) => `fde_session_dev=${pool.tokens.get(login)}`,
    close: () => new Promise((r) => server.close(r))
      .finally(() => fs.rmSync(staticDir, { recursive: true, force: true }))
      .finally(() => fs.rmSync(userSpaceRoot, { recursive: true, force: true })),
  };
}

const call = (s, { path: p, method = 'GET', login = 'root' } = {}) => fetch(`${s.base}${p}`, {
  method,
  headers: { cookie: s.cookieFor(login) },
});

async function readResp(res) {
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON：留给断言消息 */ }
  return { status: res.status, text, json };
}

test('H1 GET 200 且键集合白名单', async () => {
  const s = await startEf();
  try {
    const r = await readResp(await call(s, { path: '/api/admin/prompts/effective-agents-md?fde=alice' }));
    assert.equal(r.status, 200, `必须 200；实际 ${r.status} ${r.text}`);
    assert.deepEqual(Object.keys(r.json).sort(),
      ['db', 'disk', 'expected', 'fdeName', 'matches', 'reason', 'renderLimitBytes', 'source'].sort());
  } finally { await s.close(); }
});

test('H2 非 GET ⇒ 405', async () => {
  const s = await startEf();
  try {
    const r = await readResp(await call(s, { path: '/api/admin/prompts/effective-agents-md?fde=alice', method: 'POST' }));
    assert.equal(r.status, 405);
    assert.equal(r.json.error.code, 'method_not_allowed');
  } finally { await s.close(); }
});

test('H3 非管理员 ⇒ 403', async () => {
  const s = await startEf();
  try {
    const r = await readResp(await call(s, { path: '/api/admin/prompts/effective-agents-md?fde=alice', login: 'alice' }));
    assert.equal(r.status, 403);
  } finally { await s.close(); }
});

test('H4 fde 非法 ⇒ 400 details.field=\'fde\'', async () => {
  const s = await startEf();
  try {
    const r = await readResp(await call(s, { path: '/api/admin/prompts/effective-agents-md' }));
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'validation_failed');
    assert.equal(r.json.error.details.field, 'fde');
  } finally { await s.close(); }
});
