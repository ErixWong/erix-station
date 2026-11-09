// 单测：issue #472 片 A —— per-user「文件上传」开关 `users.file_upload_enabled`（迁移 0029）。
//
// 判据编号对应工单（`~/plans-261109/workorder-472-A.md` §1 A5）：
//   A-1 updateUser 开 ⇒ DTO 与库里都是 true
//   A-2 非布尔入参 ⇒ 400 validation_failed + details.field
//   A-3 safeUser 把 `'f'` / `0` / `undefined` 一律收成 false（专门钉 `'f'`）
//   A-4 五个 safeUser 生产点的 DTO 都含该键且值与库一致
//   A-5 重激活显式清零（不继承旧权限）
//   A-6 四条 user DTO 路径（authenticate / verifyTotpForUser / loadActiveUser / findSessionUser）键集一致
//
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool，不碰真实 DB / docker。
// fake 的红线（AGENTS §8.14）：**按 SQL 说的做** —— 该列只在 SQL 文本里出现时才回，
// 产品代码漏补列 ⇒ 这里拿不到 ⇒ 用例会红，而不是被 fake 好心兼平成假绿。
import test from 'node:test';
import assert from 'node:assert/strict';

import * as admin from '../src/admin.js';
import * as auth from '../src/auth.js';
import * as totp from '../src/totp.js';
import { FakePool } from './fake-pool.js';

const ADMIN = {
  id: 'a0000000-0000-4000-8000-000000000001', login: 'root', display_name: 'root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
};

/** 建一个「库里」的用户行（默认值与迁移 0029 一致：file_upload_enabled = false）。 */
function userRow(over = {}) {
  return {
    id: 'b0000000-0000-4000-8000-000000000002', login: 'alice', display_name: 'Alice',
    email: 'alice@example.test', display_role: 'fde', role: 'fde', fde_name: 'alice',
    auth_source: 'local', status: 'active', created_at: new Date('2026-11-01T00:00:00Z'),
    file_upload_enabled: false, ...over,
  };
}

/**
 * 只管本单五条 `safeUser` 生产点的 fake pool（形状取自 `admin.js` 的真实 SQL）。
 * 每条语句都**按 SQL 文本决定回不回这一列**：RETURNING / SELECT 里没有 `file_upload_enabled`
 * 就不回（= 产品代码漏补列时 DTO 缺键 ⇒ A-4 该红）。
 */
class AdminFlagPool extends FakePool {
  constructor(users) {
    super({ users: users.map((u) => ({ ...u })) });
    this.sqlLog = [];
  }

  /** RETURNING / SELECT 段里是否点名了这一列。 */
  #selects(sql, column) {
    return new RegExp(`\\b${column}\\b`).test(sql);
  }

  async query(sql, params = []) {
    this.sqlLog.push({ sql, params });

    // createUser 的重激活分支：`UPDATE users SET ... WHERE id = $1 AND status = 'disabled'`
    if (sql.includes('UPDATE users') && sql.includes('SET login = $2')) {
      const [id, login, email, displayName, passwordHash, totpSecret] = params;
      const user = this.users.find((u) => u.id === id && u.status === 'disabled');
      if (!user) return { rows: [] };
      Object.assign(user, {
        login, email, display_name: displayName, password_hash: passwordHash,
        totp_secret: totpSecret, last_totp_step: null, status: 'active', disabled_at: null,
      });
      // 按 SQL 文本落：SQL 没写 `file_upload_enabled = false` 就**保持原值**（继承旧权限的缺陷能真的重现）。
      if (/file_upload_enabled\s*=\s*false\b/.test(sql)) user.file_upload_enabled = false;
      return { rows: [this.#returning(sql, user)] };
    }

    // createUser 的新建分支：INSERT（列清单里没有 file_upload_enabled ⇒ 吃 DEFAULT false）
    if (sql.includes('INSERT INTO users (')) {
      const [login, email, displayName, passwordHash, totpSecret, fdeName] = params;
      const row = {
        id: `b0000000-0000-4000-8000-${String(this.users.length + 10).padStart(12, '0')}`,
        login, email, display_name: displayName, role: 'fde', auth_source: 'local', status: 'active',
        password_hash: passwordHash, totp_secret: totpSecret, fde_name: fdeName,
        file_upload_enabled: false, created_at: new Date(),
      };
      this.users.push(row);
      return { rows: [this.#returning(sql, row)] };
    }

    // updateUser：`WITH updated AS (UPDATE users SET ... RETURNING ...)`
    if (sql.includes('WITH updated AS') && sql.includes('UPDATE users SET')) {
      const user = this.users.find((u) => u.id === params[0]);
      if (!user) return { rows: [] };
      for (const column of ['display_name', 'email', 'role', 'fde_name', 'status',
        'mail_otp_enabled', 'file_upload_enabled']) {
        const match = sql.match(new RegExp(`${column} = \\$([0-9]+)`));
        if (match) user[column] = params[Number(match[1]) - 1];
      }
      return { rows: [{ ...this.#returning(sql, user), last_login_at: null }] };
    }

    // enrollUserTotp：`WITH target AS (UPDATE users SET totp_secret = $2 ... RETURNING ...)`
    if (sql.includes('WITH target AS') && sql.includes('totp_secret = $2')) {
      const user = this.users.find((u) => u.id === params[0]);
      if (!user) return { rows: [] };
      user.totp_secret = params[1];
      user.last_totp_step = null;
      return { rows: [{ ...this.#returning(sql, user), totp_enabled: true, last_login_at: null }] };
    }

    // listUsers
    if (sql.includes('FROM users') && sql.includes('LEFT JOIN')) {
      return {
        rows: this.users.map((u) => ({
          id: u.id, login: u.login, display_name: u.display_name,
          email: u.email ?? null, role: u.role, fde_name: u.fde_name ?? null,
          auth_source: u.auth_source, status: u.status, created_at: u.created_at ?? new Date(),
          totp_enabled: u.totp_secret != null, last_login_at: null, git_host_id: null,
          onboarding_state: null, offboarding_state: null,
          ...(this.#selects(sql, 'file_upload_enabled')
            ? { file_upload_enabled: u.file_upload_enabled }
            : {}),
        })),
      };
    }

    // updateUser / createUser 的读侧辅助查询（不涉本列，够用即可）
    if (sql.includes('SELECT id, login, fde_name FROM users WHERE id')) {
      const u = this.users.find((x) => x.id === params[0]);
      return { rows: u ? [{ id: u.id, login: u.login, fde_name: u.fde_name ?? null }] : [] };
    }
    if (sql.includes('SELECT email, mail_otp_enabled FROM users WHERE id')) {
      const u = this.users.find((x) => x.id === params[0]);
      return { rows: u ? [{ email: u.email ?? null, mail_otp_enabled: u.mail_otp_enabled === true }] : [] };
    }
    if (sql.includes('SELECT id, status FROM users WHERE fde_name')) {
      const u = this.users.find((x) => x.fde_name === params[0]);
      return { rows: u ? [{ id: u.id, status: u.status }] : [] };
    }
    if (sql.includes('SELECT state FROM fde_offboarding')) return { rows: [] };
    if (sql.includes('SELECT git_host_id, token_ref FROM fde_git_accounts')) return { rows: [] };
    if (sql.includes('SELECT 1 FROM users WHERE login')
        || sql.includes('SELECT 1 FROM users WHERE email')
        || sql.includes('SELECT 1 FROM users WHERE fde_name')
        || sql.includes('lower(email) = lower($1)')) {
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO audit_log')) return { rows: [] };
    if (sql.includes('DELETE FROM login_sessions') || sql.includes('DELETE FROM login_pending')
        || sql.includes('DELETE FROM api_tokens') || sql.includes('UPDATE fde_git_accounts')) {
      return { rows: [] };
    }
    return super.query(sql, params);
  }

  /** 按 RETURNING 段的列清单造返回行（fake 不替产品代码补列）。 */
  #returning(sql, user) {
    const row = {
      id: user.id, login: user.login, display_name: user.display_name, role: user.role,
      fde_name: user.fde_name ?? null, auth_source: user.auth_source, status: user.status,
      created_at: user.created_at ?? new Date(),
      totp_enabled: user.totp_secret != null,
    };
    if (/RETURNING[\s\S]*?\bemail\b/.test(sql) && /RETURNING[\s\S]*?\bmail_otp_enabled\b/.test(sql)) {
      row.email = user.email ?? null;
      row.mail_otp_enabled = user.mail_otp_enabled === true;
    }
    if (/RETURNING[\s\S]*?\bfile_upload_enabled\b/.test(sql)) {
      row.file_upload_enabled = user.file_upload_enabled;
    }
    return row;
  }
}

// ---------------------------------------------------------------------------
// A-1 / A-2：updateUser 的写入面
// ---------------------------------------------------------------------------

test('A-1 updateUser({file_upload_enabled:true}) ⇒ DTO 回读 true 且库里也是 true', async () => {
  const pool = new AdminFlagPool([userRow()]);
  const { user } = await admin.updateUser(pool, 'b0000000-0000-4000-8000-000000000002', {
    file_upload_enabled: true,
  });
  assert.equal(user.file_upload_enabled, true, 'DTO 必须是 true');
  assert.equal(pool.users[0].file_upload_enabled, true, '库里（fake 的行）也必须是 true');

  // 关掉同样要落库（同一个开关的两向都要能写）
  const off = await admin.updateUser(pool, 'b0000000-0000-4000-8000-000000000002', {
    file_upload_enabled: false,
  });
  assert.equal(off.user.file_upload_enabled, false);
  assert.equal(pool.users[0].file_upload_enabled, false);
});

test('A-1b 打开上传开关不要求邮箱、也不受邮件通道的交叉防护影响（与 mail_otp 是两件事）', async () => {
  const pool = new AdminFlagPool([userRow({ email: null })]);
  const { user } = await admin.updateUser(pool, 'b0000000-0000-4000-8000-000000000002', {
    file_upload_enabled: true,
  });
  assert.equal(user.file_upload_enabled, true, '没邮箱也能开上传');
});

test('A-2 非布尔（\'true\' / 1 / 0 / null / 数组）⇒ 400 validation_failed + details.field', async () => {
  for (const bad of ['true', 'false', 1, 0, null, [], {}]) {
    const pool = new AdminFlagPool([userRow({ file_upload_enabled: false })]);
    const err = await admin.updateUser(pool, 'b0000000-0000-4000-8000-000000000002', {
      file_upload_enabled: bad,
    }).then(() => null, (e) => e);
    assert.ok(err instanceof admin.AdminError, `${JSON.stringify(bad)} ⇒ 必须抛 AdminError（实得 ${String(err)}）`);
    assert.equal(err.code, 'validation_failed');
    assert.equal(err.httpStatus, 400, 'HTTP 状态必须是 400');
    assert.deepEqual(err.details, { field: 'file_upload_enabled' }, '必须点名是哪一格');
    assert.equal(pool.users[0].file_upload_enabled, false, '拒绝保存 ⇒ 库里不许被改');
  }
});

test('A-2b 未列入白名单的键仍被拒（本单只开 file_upload_enabled 这一个口子）', async () => {
  const pool = new AdminFlagPool([userRow()]);
  const err = await admin.updateUser(pool, 'b0000000-0000-4000-8000-000000000002', {
    file_uploads_enabled: true, // 拼错的键
  }).then(() => null, (e) => e);
  assert.equal(err?.code, 'validation_failed');
  assert.deepEqual(err?.details, { field: 'file_uploads_enabled' });
});

// ---------------------------------------------------------------------------
// A-3：safeUser 的布尔收口（专门钉 'f'）
// ---------------------------------------------------------------------------

test('A-3 safeUser 对 \'f\' / \'t\' / 0 / 1 / undefined 一律收成布尔（\'f\' 必须是 false）', async () => {
  // 走**生产路径**（listUsers → safeUser），而不是把 safeUser 导出：测的是真实消费形状。
  // `Boolean('f') === true` 是实现陷阱（评审 major 6），所以 `'f'` 必须专门断言。
  const shapes = [
    ['f', false], ['t', false], [0, false], [1, false], ['', false],
    [undefined, false], [null, false], [true, true], [false, false],
  ];
  for (const [raw, expected] of shapes) {
    const pool = new AdminFlagPool([userRow({ file_upload_enabled: raw })]);
    const { items } = await admin.listUsers(pool);
    assert.equal('file_upload_enabled' in items[0], true, `${JSON.stringify(raw)} ⇒ DTO 必须有这个键`);
    assert.equal(items[0].file_upload_enabled, expected,
      `库里给 ${JSON.stringify(raw)} ⇒ DTO 必须是 ${expected}（safeUser 用 === true，不是 Boolean()）`);
    assert.equal(typeof items[0].file_upload_enabled, 'boolean');
  }
});

// ---------------------------------------------------------------------------
// A-4：五个 safeUser 生产点
// ---------------------------------------------------------------------------

test('A-4 五个 safeUser 生产点的 DTO 都含该键，且值与库里一致', async () => {
  const pool = new AdminFlagPool([userRow({ file_upload_enabled: true })]);
  const aliceId = pool.users[0].id;

  // ① listUsers
  const list = await admin.listUsers(pool);
  assert.equal(list.items[0].file_upload_enabled, true, 'listUsers');
  // ② updateUser
  const updated = await admin.updateUser(pool, aliceId, { file_upload_enabled: true });
  assert.equal(updated.user.file_upload_enabled, true, 'updateUser');
  // ③ enrollUserTotp
  const enrolled = await admin.enrollUserTotp(pool, aliceId, { actorId: ADMIN.id });
  assert.equal(enrolled.user.file_upload_enabled, true, 'enrollUserTotp');
  // ④ createUser 新建分支（库里 false = 列默认值）
  const created = await admin.createUser(pool, {
    actorId: ADMIN.id, login: 'bob', display_name: 'Bob', password: 'secret-pass-1',
    email: 'bob@example.test', fde_name: 'bob',
  });
  assert.equal(created.user.file_upload_enabled, false, 'createUser 新建：DTO 含键且为 false');
  assert.equal(pool.users.find((u) => u.login === 'bob').file_upload_enabled, false, '库里同样是 false');
  // ⑤ createUser 重激活分支
  pool.users.find((u) => u.login === 'alice').status = 'disabled';
  const reactivated = await admin.createUser(pool, {
    actorId: ADMIN.id, login: 'alice', display_name: 'Alice', password: 'secret-pass-2',
    email: 'alice@example.test', fde_name: 'alice',
  });
  assert.equal(reactivated.reactivated, true, '确实走了重激活分支');
  assert.equal(reactivated.user.file_upload_enabled, false, '重激活 ⇒ DTO 为 false（见 A-5）');
});

test('A-4b 生产 SQL 的每一条都真的带了这一列（fake 只在 SQL 点名时回列 ⇒ 漏补列这里就红）', async () => {
  const pool = new AdminFlagPool([userRow()]);
  await admin.listUsers(pool);
  await admin.updateUser(pool, pool.users[0].id, { file_upload_enabled: true });
  await admin.enrollUserTotp(pool, pool.users[0].id);
  await admin.createUser(pool, {
    actorId: ADMIN.id, login: 'carol', password: 'secret-pass-1',
    email: 'carol@example.test', fde_name: 'carol',
  });
  pool.users.find((u) => u.login === 'alice').status = 'disabled';
  await admin.createUser(pool, {
    actorId: ADMIN.id, login: 'alice', password: 'secret-pass-2',
    email: 'alice@example.test', fde_name: 'alice',
  });

  const carrying = (label, predicate) => {
    const hit = pool.sqlLog.filter((entry) => predicate(entry.sql));
    assert.ok(hit.length > 0, `${label}：没有任何一条语句带 file_upload_enabled`);
  };
  carrying('listUsers 的 SELECT', (s) => /users\.file_upload_enabled/.test(s));
  carrying('updateUser 的 RETURNING', (s) => s.includes('WITH updated AS') && /RETURNING[\s\S]*file_upload_enabled/.test(s));
  carrying('enrollUserTotp 的 RETURNING', (s) => s.includes('WITH target AS') && /RETURNING[\s\S]*file_upload_enabled/.test(s));
  carrying('createUser 新建的 RETURNING', (s) => s.includes('INSERT INTO users (') && /RETURNING[\s\S]*file_upload_enabled/.test(s));
  carrying('createUser 重激活的 RETURNING', (s) => s.includes('SET login = $2') && /RETURNING[\s\S]*file_upload_enabled/.test(s));
});

// ---------------------------------------------------------------------------
// A-5：重激活清零
// ---------------------------------------------------------------------------

test('A-5 重激活：disabled 行先置 true，再 createUser 同名 ⇒ 库里与 DTO 都是 false', async () => {
  const pool = new AdminFlagPool([userRow({ file_upload_enabled: true, status: 'disabled' })]);
  assert.equal(pool.users[0].file_upload_enabled, true, '前置条件：曾开过上传');

  const { user, reactivated } = await admin.createUser(pool, {
    actorId: ADMIN.id, login: 'alice', display_name: 'Alice', password: 'secret-pass-2',
    email: 'alice@example.test', fde_name: 'alice',
  });
  assert.equal(reactivated, true, '走的是重激活（UPDATE）分支，不是新建');
  assert.equal(pool.users[0].file_upload_enabled, false, '库里必须被清零（不继承旧权限）');
  assert.equal(user.file_upload_enabled, false, 'DTO 也必须报 false');
});

test('A-5b createUser 不接受 file_upload_enabled 入参：开户一律 false（新行与重激活都不吃入参）', async () => {
  const pool = new AdminFlagPool([]);
  const created = await admin.createUser(pool, {
    actorId: ADMIN.id, login: 'dave', password: 'secret-pass-1',
    email: 'dave@example.test', fde_name: 'dave', file_upload_enabled: true,
  });
  assert.equal(created.user.file_upload_enabled, false, '新建：入参被忽略 ⇒ false');
  assert.equal(pool.users[0].file_upload_enabled, false);
});

// ---------------------------------------------------------------------------
// A-6：四条 user DTO 路径键集一致（评审 blocker 1 的牙）
// ---------------------------------------------------------------------------

test('A-6 四条 user DTO 路径的键集完全一致（同一夹具），且都拿到 true', async () => {
  const secret = totp.generateSecret(20);
  const seed = userRow({
    file_upload_enabled: true, password_hash: await auth.hashPassword('secret-pass'),
    totp_secret: secret, must_change_password: false,
  });
  const pool = new FakePool({ users: [seed] });
  const now = new Date('2026-01-01T00:00:00Z');
  const code = totp.totp(secret, { time: now.getTime() });

  const p1 = await auth.authenticate(pool, 'alice', 'secret-pass');
  assert.equal(p1.ok, true, '口令必须过（否则整条用例空转）');
  const p2 = await auth.verifyTotpForUser(pool, seed.id, code, { now });
  assert.equal(p2.ok, true, 'TOTP 必须过');
  const p3 = await auth.loadActiveUser(pool, seed.id);
  assert.ok(p3);
  const { token } = await auth.createSession(pool, seed.id, { ttlSeconds: 100, now });
  const p4 = await auth.findSessionUser(pool, token, { now });
  assert.ok(p4, '会话必须能读出用户');

  const base = ['id', 'login', 'display_name', 'role', 'fde_name', 'auth_source', 'file_upload_enabled'].sort();
  assert.deepEqual(Object.keys(p1.user).sort(), base, 'authenticate');
  assert.deepEqual(Object.keys(p2.user).sort(), base, 'verifyTotpForUser');
  assert.deepEqual(Object.keys(p3.user).sort(), base, 'loadActiveUser');
  // findSessionUser 只多一个**会话态**键（#255 的受限会话门），它刻意不进 toSessionUser。
  assert.deepEqual(Object.keys(p4.user).sort(), [...base, 'must_change_password'].sort(), 'findSessionUser');

  // 值也要一致：四条路径都必须真的把库里的 true 带出来（fake 只在 SELECT 点了这一列时才回）——
  // 「登录能拿到、/api/me 拿不到」这类半截 DTO 就是这里红的（评审 blocker 1）。
  for (const [label, dto] of [['authenticate', p1.user], ['verifyTotpForUser', p2.user],
    ['loadActiveUser', p3.user], ['findSessionUser', p4.user]]) {
    assert.equal(dto.file_upload_enabled, true, `${label}：首登/会话路径必须带出能力位`);
  }
});

test('A-6b 库里是 false 时四条路径都报 false（不是 undefined，也不许缺键）', async () => {
  const seed = userRow({ file_upload_enabled: false, password_hash: await auth.hashPassword('secret-pass') });
  const pool = new FakePool({ users: [seed] });
  const now = new Date('2026-01-01T00:00:00Z');

  const p1 = await auth.authenticate(pool, 'alice', 'secret-pass');
  const p3 = await auth.loadActiveUser(pool, seed.id);
  const { token } = await auth.createSession(pool, seed.id, { ttlSeconds: 100, now });
  const p4 = await auth.findSessionUser(pool, token, { now });

  for (const [label, dto] of [['authenticate', p1.user], ['loadActiveUser', p3.user],
    ['findSessionUser', p4.user]]) {
    assert.equal(dto.file_upload_enabled, false, label);
    assert.ok('file_upload_enabled' in dto, `${label}：键必须存在（缺键 = 前端三态会当「未知」）`);
  }
});

test('A-6c 库里给 \'f\'（pg 文本形状）时四条路径都收成 false', async () => {
  const seed = userRow({ file_upload_enabled: 'f', password_hash: await auth.hashPassword('secret-pass') });
  const pool = new FakePool({ users: [seed] });
  const now = new Date('2026-01-01T00:00:00Z');
  const p1 = await auth.authenticate(pool, 'alice', 'secret-pass');
  const p3 = await auth.loadActiveUser(pool, seed.id);
  const { token } = await auth.createSession(pool, seed.id, { ttlSeconds: 100, now });
  const p4 = await auth.findSessionUser(pool, token, { now });
  for (const [label, dto] of [['authenticate', p1.user], ['loadActiveUser', p3.user],
    ['findSessionUser', p4.user]]) {
    assert.equal(dto.file_upload_enabled, false, `${label}：'f' 不许被真值性放行`);
  }
});
