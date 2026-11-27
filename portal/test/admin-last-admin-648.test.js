// issue #648 B：**最后一名 active admin 不能被降级或停用**（契约 docs/api/portal.md §`PATCH /api/admin/users/:id`）。
//
// 这一层验的是**入口 + 判据形状**：409 `last_admin`（新码，带 `en` 文案）、显式确认位 `confirm_last_admin`
// 的放行与审计、护栏**按目标账号**而非 actor 判、值域校验行为不变，以及判据必须与 UPDATE **同一条 SQL**。
//
// 隔离约定（docs/testing.md §2.1）：`FakePool` 子类 + 真 HTTP（fetch），零真 DB、零容器。
// 夹具形状照抄 `portal/test/admin-seat-content.test.js`（含 `trackTmp` + `afterEach` 收尾——
// 仓库规矩：mkdtemp 必须与它的 rm 落在同一个夹具里，不靠进程退出）。
//
// fake 的红线（与 `FakePool.projectFileUpload` 同口径）：**按 SQL 说的做**。
// 护栏谓词在 SQL 里 ⇒ fake 就替 PG 判一次 WHERE 并把不成立的 UPDATE 打成 0 行；SQL 里没有那段谓词
// （实现被删/被注释）⇒ fake 老老实实把 UPDATE 落下去 ⇒ 用例会红。fake **不会**自己再数一遍 active admin
// 来"帮忙"，否则「先查后改」这种写错的实现也能被 fake 兜成绿。
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { AdminError, updateUser } from '../src/admin.js';
import { FakePool } from './fake-pool.js';

const ADMIN_SOLO = {
  id: '64800000-0000-4000-8000-0000000000a1', login: 'root', display_name: 'Root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
  file_upload_enabled: false,
};
/** 第二名 active admin：B-4「还有别人 ⇒ 不多要确认位」用。 */
const ADMIN_TWO = {
  id: '64800000-0000-4000-8000-0000000000a2', login: 'root2', display_name: 'Root2',
  role: 'admin', fde_name: 'root2', auth_source: 'local', status: 'active',
  file_upload_enabled: false,
};
/** 已停用的 admin：B-5 拿它当 actor，钉「护栏按**目标账号**判，不按 actor」。 */
const ADMIN_DISABLED = {
  id: '64800000-0000-4000-8000-0000000000a3', login: 'root3', display_name: 'Root3',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'disabled',
  file_upload_enabled: false,
};
const FDE_USER = {
  id: '64800000-0000-4000-8000-0000000000b1', login: 'alice', display_name: 'Alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
  file_upload_enabled: true,
};
const FDE_DISABLED = {
  id: '64800000-0000-4000-8000-0000000000b2', login: 'bob', display_name: 'Bob',
  role: 'fde', fde_name: 'bob', auth_source: 'local', status: 'disabled',
  file_upload_enabled: true,
};

/** 产品侧护栏谓词的指纹（`updateUser` 里那段 WHERE）。fake 与用例都只认这个字面量。 */
const GUARD_MARK = 'last_admin_guard';

class LastAdminPool extends FakePool {
  constructor(users) {
    super({ users: users.map((u) => ({ ...u })) });
    this.offboardings = [];
  }

  async query(sql, params = []) {
    const text = String(sql);
    this.statements.push({ sql: text, params });

    // updateUser 的前置读（既有产品 SQL，列清单照原样回）。
    if (/SELECT id, login, fde_name FROM users WHERE id/.test(text)) {
      const u = this.users.find((x) => x.id === params[0]);
      return { rows: u ? [{ id: u.id, login: u.login, fde_name: u.fde_name ?? null }] : [] };
    }

    // #648：UPDATE 一行没命中后的**选错误码**回查（「这一行是否仍是唯一的 active admin」）。
    if (/FROM users guarded/.test(text)) {
      const u = this.users.find((x) => x.id === params[0]);
      const isLast = !!u && u.role === 'admin' && u.status === 'active'
        && !this.users.some((o) => o.id !== u.id && o.role === 'admin' && o.status === 'active');
      return { rows: isLast ? [{ '?column?': 1 }] : [] };
    }

    // #648：确认位落审计前的事实核对（**更新之后**还剩几名 active admin）。
    if (/AS active_admins FROM users/.test(text)) {
      const n = this.users.filter((u) => u.role === 'admin' && u.status === 'active').length;
      return { rows: [{ active_admins: n }] };
    }

    if (/WITH updated AS/.test(text) && /UPDATE users SET/.test(text)) {
      const user = this.users.find((u) => u.id === params[0]);
      if (!user) return { rows: [] };
      // 既有的下线护栏（`status='active'` 重激活 / 改 fde_name 时才有这段）。
      if (/NOT EXISTS \(SELECT 1 FROM fde_offboarding/.test(text)
        && this.offboardings.some((row) => row.fde_id === user.id)) {
        return { rows: [] };
      }
      // #648 的 active-admin 护栏：**按 SQL 说的做** —— 谓词在 SQL 里才判它。
      // 判定用的是改前的行（PG 的 UPDATE WHERE 看到的就是改前值），且必须把目标行自己排掉。
      if (text.includes(GUARD_MARK)) {
        const wasActiveAdmin = user.role === 'admin' && user.status === 'active';
        const hasOtherActiveAdmin = this.users.some(
          (o) => o.id !== user.id && o.role === 'admin' && o.status === 'active',
        );
        if (wasActiveAdmin && !hasOtherActiveAdmin) return { rows: [] };
      }
      const field = (name) => {
        const m = new RegExp(`${name} = \\$([0-9]+)`).exec(text);
        return m ? params[Number(m[1]) - 1] : undefined;
      };
      for (const name of ['display_name', 'email', 'role', 'fde_name', 'file_upload_enabled',
        'mail_otp_enabled', 'totp_login_enabled', 'locale']) {
        const value = field(name);
        if (value !== undefined) user[name] = value;
      }
      const status = field('status');
      if (status !== undefined) {
        user.status = status;
        user.disabled_at = status === 'disabled' ? new Date() : null;
      }
      // 停用 ⇒ 原子吊销会话（既有行为，B-2 用它反证「409 时一格都没落库」）。
      if (user.status === 'disabled') {
        for (const s of this.sessions) {
          if (s.user_id === user.id && s.revoked_at === null) s.revoked_at = new Date();
        }
      }
      const has = (col) => new RegExp(`RETURNING[^)]*\\b${col}\\b`, 'i').test(text);
      return {
        rows: [{
          id: user.id, login: user.login, display_name: user.display_name,
          ...(has('email') ? { email: user.email ?? null } : {}),
          ...(has('mail_otp_enabled') ? { mail_otp_enabled: user.mail_otp_enabled === true } : {}),
          ...(has('file_upload_enabled') ? { file_upload_enabled: user.file_upload_enabled === true } : {}),
          ...(has('totp_login_enabled') ? { totp_login_enabled: user.totp_login_enabled === true } : {}),
          ...(has('locale') ? { locale: user.locale ?? null } : {}),
          role: user.role,
          fde_name: user.fde_name ?? null,
          auth_source: user.auth_source,
          status: user.status,
          created_at: user.created_at ?? new Date(),
          last_activity_at: user.last_activity_at ?? null,
          totp_enabled: user.totp_secret != null,
          last_login_at: null,
        }],
      };
    }

    return super.query(sql, params);
  }
}

// ---- 夹具生命周期（#880）：谁建谁收尾，不靠进程退出 ----
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

async function startStack(users = [ADMIN_SOLO, FDE_USER]) {
  const pool = new LastAdminPool(users);
  const tokens = new Map();
  for (const u of users) {
    const token = `${u.login}-tok`;
    tokens.set(u.login, token);
    if (u.status !== 'active') continue; // 停用账号的会话按真库口径早已被吊销
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
    staticDir: trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'station-648-static-'))),
    userSpaceRoot: trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'station-648-space-'))),
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
    user: (login) => pool.users.find((u) => u.login === login),
    auditRows: (action) => pool.audit.filter((r) => r.action === action),
    /** PATCH /api/admin/users/:id，返回 {status, body}；默认以 root 的身份发。 */
    async patch(login, body, as = 'root', locale = null) {
      const headers = { cookie: `fde_session_dev=${tokens.get(as)}`, 'content-type': 'application/json' };
      if (locale !== null) headers['accept-language'] = locale; // #803：错误文案按请求语言挑（`err.en` 不是响应键）
      const res = await fetch(`${s.base}/api/admin/users/${s.user(login).id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    close: () => new Promise((r) => server.close(r)),
  };
  return s;
}

test('#648-B1 最后一名 active admin 被降级 ⇒ 409 last_admin（带 en 文案，且库里一格都没改）', async () => {
  const s = await startStack();
  try {
    const r = await s.patch('root', { role: 'fde' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'last_admin');
    // 中英两条都给（#803 的形状：`AdminError(msg, { en })` ⇒ 同一码按请求语言选文案，**不是**响应里多一个 `en` 键）
    assert.match(r.body.error.message, /最后一名 active 管理员/);
    const en = await s.patch('root', { role: 'fde' }, 'root', 'en');
    assert.equal(en.status, 409);
    assert.equal(en.body.error.code, 'last_admin');
    assert.match(en.body.error.message, /last active administrator/i);
    assert.deepEqual(r.body.error.details, { field: 'role' });
    // 真拦住了：库里仍是 admin，且**没有**「保存成功」的那条审计
    assert.equal(s.user('root').role, 'admin');
    assert.equal(s.auditRows('admin.user_updated').length, 0);
  } finally { await s.close(); }
});

test('#648-B2 停用最后一名 active admin 走同一条判据 ⇒ 409 last_admin（会话也没被吊销）', async () => {
  const s = await startStack();
  try {
    const r = await s.patch('root', { status: 'disabled' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'last_admin');
    assert.deepEqual(r.body.error.details, { field: 'status' });
    // 判据是「改完之后还有没有 active admin」，与被降级/被停用无关 ⇒ 这条路同样不许落库
    assert.equal(s.user('root').status, 'active');
    assert.equal(s.pool.sessions.filter((x) => x.revoked_at !== null).length, 0);
  } finally { await s.close(); }
});

test('#648-B3 带 confirm_last_admin:true 放行，并另落一行 admin.user_last_admin_confirmed', async () => {
  const s = await startStack();
  try {
    const r = await s.patch('root', { role: 'fde', confirm_last_admin: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.role, 'fde');
    assert.equal(s.user('root').role, 'fde');
    // 既有审计不动（纯增量），确认位另算一行
    assert.equal(s.auditRows('admin.user_updated').length, 1);
    const rows = s.auditRows('admin.user_last_admin_confirmed');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target, 'root');
    assert.deepEqual(JSON.parse(rows[0].details), {
      confirm_last_admin: true, remaining_active_admins: 0, role: 'fde', status: 'active',
    });
  } finally { await s.close(); }
});

test('#648-B4 库里还有第二名 active admin ⇒ 照常降级，不多要确认位也不多写审计', async () => {
  const s = await startStack([ADMIN_SOLO, ADMIN_TWO, FDE_USER]);
  try {
    const r = await s.patch('root', { role: 'fde' }); // 没带确认位
    assert.equal(r.status, 200);
    assert.equal(r.body.user.role, 'fde');
    assert.equal(s.user('root').role, 'fde');
    assert.equal(s.user('root2').role, 'admin'); // 剩下那名仍然活着
    assert.equal(s.auditRows('admin.user_last_admin_confirmed').length, 0);
  } finally { await s.close(); }
});

test('#648-B5 护栏按目标账号判、不按 actor：已停用的 admin 去改最后一名 active admin 也 409', async () => {
  // 函数级（不走 HTTP）：`requireAdmin` 要求 actor 是 **active** admin，所以「actor 是另一名 admin
  // 而目标才是最后一名 active admin」这个形状在 HTTP 面进不来（DBA 直接翻 status 之类才会出现）。
  // 判据本身与 actor 无关，这一格钉的就是「把 actor 换成谁都不许放行」。
  const pool = new LastAdminPool([ADMIN_SOLO, ADMIN_DISABLED, FDE_USER]);
  await assert.rejects(
    () => updateUser(pool, ADMIN_SOLO.id, { role: 'fde' }, { actorId: ADMIN_DISABLED.id }),
    (err) => {
      assert.ok(err instanceof AdminError);
      assert.equal(err.code, 'last_admin');
      assert.equal(err.httpStatus, 409);
      assert.equal(err.details.field, 'role');
      return true;
    },
  );
  assert.equal(pool.users.find((u) => u.id === ADMIN_SOLO.id).role, 'admin');
});

test('#648-B6 判据与 UPDATE 同一条 SQL（先查后改的写法会在这里红）', async () => {
  const s = await startStack();
  try {
    const r = await s.patch('root', { role: 'fde' });
    assert.equal(r.status, 409);
    const stmts = s.pool.statements.map((x) => x.sql);
    const updateAt = stmts.findIndex((sql) => /WITH updated AS/.test(sql) && /UPDATE users SET/.test(sql));
    assert.ok(updateAt >= 0, '没找到那条 UPDATE');
    // ① 护栏谓词必须在那条 UPDATE 自己的 WHERE 里（同语句 ⇒ 判定与写入共用一个快照）
    const updateSql = stmts[updateAt];
    assert.match(updateSql, /WHERE id = \$1[\s\S]*last_admin_guard[\s\S]*\.id <> users\.id/);
    // ② 它之前不许出现任何「先数一遍 active admin」的查询（先查后改 = 并发下双双通过）
    const before = stmts.slice(0, updateAt);
    for (const sql of before) {
      assert.doesNotMatch(sql, /last_admin_guard/, '护栏被拆成了先查后改');
      assert.doesNotMatch(sql, /AS active_admins/, 'UPDATE 之前先数了一遍 active admin');
    }
  } finally { await s.close(); }
});

test('#648-B7 值域校验行为不变：role:"root" 仍 validation_failed；确认位只认真布尔', async () => {
  const s = await startStack();
  try {
    const badRole = await s.patch('root', { role: 'root' });
    assert.equal(badRole.status, 400);
    assert.equal(badRole.body.error.code, 'validation_failed');
    assert.deepEqual(badRole.body.error.details, { field: 'role' });
    assert.equal(s.user('root').role, 'admin');

    // 控制位也只认真布尔（与 mail_otp_enabled / file_upload_enabled 同形状的既有红线）
    for (const bad of ['true', 1, null]) {
      const r = await s.patch('root', { role: 'fde', confirm_last_admin: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.body.error.code, 'validation_failed', JSON.stringify(bad));
      assert.deepEqual(r.body.error.details, { field: 'confirm_last_admin' }, JSON.stringify(bad));
    }
    // 只带确认位 ⇒ 仍然「至少提供一个可更新字段」（它是一枚控制位，不是一格数据）
    const alone = await s.patch('root', { confirm_last_admin: true });
    assert.equal(alone.status, 400);
    assert.equal(alone.body.error.code, 'validation_failed');
    assert.match(alone.body.error.message, /至少提供一个可更新字段/);
    assert.equal(s.user('root').role, 'admin');
  } finally { await s.close(); }
});

test('#648-B8 confirm_last_admin:false 等于没确认（照样 409）；没拦住任何东西时不写「最后一名」审计', async () => {
  const s = await startStack([ADMIN_SOLO, ADMIN_TWO, FDE_USER]);
  try {
    // 带确认位但**本不拦住任何东西**（root 还是 active admin）⇒ 不写假台账（台账走更新后的存量数）
    const confirmed = await s.patch('root2', { role: 'fde', confirm_last_admin: true });
    assert.equal(confirmed.status, 200);
    assert.equal(s.user('root2').role, 'fde');
    assert.equal(s.auditRows('admin.user_last_admin_confirmed').length, 0);
    // 现在 root 才是最后一名：`false` 是「没确认」，不是「确认了」（变异靶子 M5：`!== true` 写成「键存在就放行」）
    const denied = await s.patch('root', { role: 'fde', confirm_last_admin: false });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.error.code, 'last_admin');
    assert.equal(s.user('root').role, 'admin');
    assert.equal(s.auditRows('admin.user_last_admin_confirmed').length, 0);
    // 同一请求体只差这一位 ⇒ true 就放行，并落下那一行台账
    const allowed = await s.patch('root', { role: 'fde', confirm_last_admin: true });
    assert.equal(allowed.status, 200);
    assert.equal(s.user('root').role, 'fde');
    assert.equal(s.pool.users.filter((u) => u.role === 'admin' && u.status === 'active').length, 0);
    assert.equal(s.auditRows('admin.user_last_admin_confirmed').length, 1);
  } finally { await s.close(); }
});

test('#648-B9 护栏只管「离开 active admin 集合」这个动作：非 admin 目标与重新启用一律照常放行', async () => {
  const s = await startStack([ADMIN_SOLO, FDE_DISABLED, FDE_USER]);
  try {
    // fde → fde（目标从来不是 active admin ⇒ 谓词成立，不需要确认位）
    const same = await s.patch('alice', { role: 'fde' });
    assert.equal(same.status, 200);
    // fde → admin 是**加人**，永远不许拦（否则「只剩一名 admin 时提第二个人」会自锁）
    const promote = await s.patch('bob', { role: 'admin', status: 'active' });
    assert.equal(promote.status, 200);
    assert.equal(s.user('bob').role, 'admin');
    // 再停用它也不该要确认位（还剩 root）
    const disable = await s.patch('bob', { status: 'disabled' });
    assert.equal(disable.status, 200);
    assert.equal(s.user('bob').status, 'disabled');
    // 而最后那名（root）依旧动不了
    const last = await s.patch('root', { status: 'disabled' });
    assert.equal(last.status, 409);
    assert.equal(last.body.error.code, 'last_admin');
  } finally { await s.close(); }
});
// 评审发现的口径差：`details.field` 原本按「请求里有没有 role」选，于是 `{role:'admin', status:'disabled'}`
// 会报 `role`——可 role 根本没离开 active-admin 集合，真正在改的是 status。这三格钉的是**指对格子**。
test('#648-B10 role 原样保留 + status 停用 ⇒ details.field 必须指 status（不是「请求里有 role」就报 role）', async () => {
  const s = await startStack();
  try {
    const r = await s.patch('root', { role: 'admin', status: 'disabled' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'last_admin');
    assert.deepEqual(r.body.error.details, { field: 'status' },
      `role 仍是 admin、没离开集合 ⇒ 触发者是 status，details.field 必须指 status：${JSON.stringify(r.body.error.details)}`);
    assert.equal(s.user('root').status, 'active', '被挡下 ⇒ 一格都不该落库');
  } finally { await s.close(); }
});

test('#648-B11 role 降级 + status 保持 active ⇒ details.field 必须指 role', async () => {
  const s = await startStack();
  try {
    const r = await s.patch('root', { role: 'fde', status: 'active' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'last_admin');
    assert.deepEqual(r.body.error.details, { field: 'role' },
      `只有 role 离开集合 ⇒ 必须指 role：${JSON.stringify(r.body.error.details)}`);
  } finally { await s.close(); }
});

test('#648-B12 两格同时离开集合 ⇒ 报 role（先按主字段），且两格都没落库', async () => {
  const s = await startStack();
  try {
    const r = await s.patch('root', { role: 'fde', status: 'disabled' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'last_admin');
    assert.deepEqual(r.body.error.details, { field: 'role' });
    assert.equal(s.user('root').role, 'admin');
    assert.equal(s.user('root').status, 'active');
  } finally { await s.close(); }
});
