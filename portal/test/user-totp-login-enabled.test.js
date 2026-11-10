// 单测：工单 feat-261110-02 —— per-user「**允许用 TOTP 登录**」`users.totp_login_enabled`（迁移 0030）
// 的管理台侧 + 登录读取侧判据。
//
// 这一位存在的全部理由：`totp_enabled`（= `totp_secret IS NOT NULL`）说的是「绑过验证器」，
// 而登录要不要走 TOTP 以前**直接**从它推出来 ⇒ 「绑过」与「允许用」被压成一位，
// 「密钥留着、登录只走邮箱码」这一格根本表达不出来（想改只能重绑或删密钥）。
//
// 判据：
//   T-1 updateUser 两向都能写（DTO 与库里一致）
//   T-2 非布尔入参 ⇒ 400 validation_failed + details.field（不许把 `'true'` / `1` 塞进 boolean 列）
//   T-3 **五个 safeUser 生产点**的 DTO 都含该键且值与库一致（漏补 SELECT/RETURNING 列就红）
//   T-4 关掉它**不清密钥**：`totp_enabled` 仍为 true（关掉 ≠ 解绑，这是本单最容易做错的一处）
//   T-5 与 `mail_otp_enabled` 的交叉防护互不影响（没邮箱也关得掉 TOTP 登录）
//   T-6 登录侧两条读取路径（`authenticate` / `loadActiveUser`）都把这一位带出去，且**缺键按 true**
//
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool，不碰真实 DB / docker。
// fake 红线（AGENTS §8.14）：**按 SQL 说的做** —— 该列只在 SQL 文本里出现时才回，
// 产品代码漏补列 ⇒ 这里拿不到 ⇒ 用例会红，而不是被 fake 好心兼平成假绿。
import test from 'node:test';
import assert from 'node:assert/strict';

import * as admin from '../src/admin.js';
import * as auth from '../src/auth.js';
import { FakePool } from './fake-pool.js';

const PASSWORD = 'correct horse battery staple';
let passwordHashCache = null;
async function passwordHash() {
  if (!passwordHashCache) passwordHashCache = await auth.hashPassword(PASSWORD);
  return passwordHashCache;
}

const USER_ID = 'b0000000-0000-4000-8000-000000000002';

/** 建一个「库里」的用户行（默认值与迁移 0030 一致：totp_login_enabled = true）。 */
function userRow(over = {}) {
  return {
    id: USER_ID, login: 'alice', display_name: 'Alice',
    email: 'alice@example.test', role: 'fde', fde_name: 'alice',
    auth_source: 'local', status: 'active', created_at: new Date('2026-11-01T00:00:00Z'),
    password_hash: null, totp_secret: 'SEEDSEEDSEEDSEEDSEED', last_totp_step: null,
    mail_otp_enabled: false, file_upload_enabled: false,
    totp_login_enabled: true, ...over,
  };
}

/** 只管本单这几个生产点的 fake pool（形状取自 `admin.js` 的真实 SQL）。 */
class TotpLoginPool extends FakePool {
  constructor(users) {
    super({ users: users.map((u) => ({ ...u })) });
    this.sqlLog = [];
  }

  #selects(sql, column) {
    return new RegExp(`\\b${column}\\b`).test(sql);
  }

  async query(sql, params = []) {
    this.sqlLog.push({ sql, params });

    // createUser 的重激活分支（UPDATE ... WHERE id = $1 AND status = 'disabled'）
    if (sql.includes('UPDATE users') && sql.includes('SET login = $2')) {
      const [id, login, email, displayName, hash, totpSecret] = params;
      const user = this.users.find((u) => u.id === id && u.status === 'disabled');
      if (!user) return { rows: [] };
      Object.assign(user, {
        login, email, display_name: displayName, password_hash: hash,
        totp_secret: totpSecret, last_totp_step: null, status: 'active', disabled_at: null,
      });
      return { rows: [this.#returning(sql, user)] };
    }

    // createUser 的新建分支（INSERT ⇒ 该列吃 DEFAULT true）
    if (sql.includes('INSERT INTO users (')) {
      const [login, email, displayName, hash, totpSecret, fdeName] = params;
      const row = {
        id: `b0000000-0000-4000-8000-${String(this.users.length + 10).padStart(12, '0')}`,
        login, email, display_name: displayName, role: 'fde', auth_source: 'local', status: 'active',
        password_hash: hash, totp_secret: totpSecret, fde_name: fdeName,
        file_upload_enabled: false,
        // 列清单里没有 `totp_login_enabled` ⇒ 真库吃 `DEFAULT true`（迁移 0030）。fake 必须**按 SQL
        // 说的做**（AGENTS §8.14）：这里模拟的就是那条 DEFAULT，而不是「fake 忘了」。
        // 产品代码想在 INSERT 之后立刻看见它，只能把列补进 RETURNING —— 这正是 T-3 要钉的东西。
        totp_login_enabled: true,
        created_at: new Date(),
      };
      this.users.push(row);
      return { rows: [this.#returning(sql, row)] };
    }

    // updateUser
    if (sql.includes('WITH updated AS') && sql.includes('UPDATE users SET')) {
      const user = this.users.find((u) => u.id === params[0]);
      if (!user) return { rows: [] };
      for (const column of ['display_name', 'email', 'role', 'fde_name', 'status',
        'mail_otp_enabled', 'file_upload_enabled', 'totp_login_enabled']) {
        const match = sql.match(new RegExp(`${column} = \\$([0-9]+)`));
        if (match) user[column] = params[Number(match[1]) - 1];
      }
      return { rows: [{ ...this.#returning(sql, user), last_login_at: null }] };
    }

    // enrollUserTotp
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
          ...(this.#selects(sql, 'file_upload_enabled') ? { file_upload_enabled: u.file_upload_enabled } : {}),
          ...(this.#selects(sql, 'totp_login_enabled') ? { totp_login_enabled: u.totp_login_enabled } : {}),
        })),
      };
    }

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
    // ⚠ 与 `file_upload_enabled` 一样：**没点名列就整个键都不给**（不是给 undefined 键）。
    // 这样产品侧 `row.totp_login_enabled === true` 得 false ⇒ T-3 会红；而「键都不给」也正好
    // 复现「旧后端 / 旧响应」的形状，让前端那一侧的缺键处理有用例可对。
    if (/RETURNING[\s\S]*?\btotp_login_enabled\b/.test(sql)) {
      row.totp_login_enabled = user.totp_login_enabled;
    }
    return row;
  }
}

// ---------------------------------------------------------------------------
// T-1 / T-2：写入面
// ---------------------------------------------------------------------------

test('T-1 updateUser({totp_login_enabled}) 两向都能写：DTO 与库里一致', async () => {
  const pool = new TotpLoginPool([userRow()]);
  const off = await admin.updateUser(pool, USER_ID, { totp_login_enabled: false });
  assert.equal(off.user.totp_login_enabled, false, 'DTO 必须是 false');
  assert.equal(pool.users[0].totp_login_enabled, false, '库里（fake 的行）也必须是 false');

  const on = await admin.updateUser(pool, USER_ID, { totp_login_enabled: true });
  assert.equal(on.user.totp_login_enabled, true);
  assert.equal(pool.users[0].totp_login_enabled, true);
});

test('T-1b 保存只发这一列：UPDATE 的 SET 段里不许夹带别的字段', async () => {
  const pool = new TotpLoginPool([userRow({ display_name: 'Alice', email: 'alice@example.test' })]);
  await admin.updateUser(pool, USER_ID, { totp_login_enabled: false });
  const update = pool.sqlLog.find((s) => s.sql.includes('UPDATE users SET'));
  assert.ok(update, '必须发一条 UPDATE');
  const setSegment = /UPDATE users SET([\s\S]*?)WHERE/.exec(update.sql)?.[1] ?? '';
  const assigned = [...setSegment.matchAll(/\b([a-z_]+)\s*=\s*\$/g)].map((m) => m[1]);
  assert.deepEqual(assigned, ['totp_login_enabled'], `SET 段只该有这一列，实得：${setSegment.trim()}`);
});

test('T-2 非布尔（\'true\' / 1 / 0 / null / 数组）⇒ 400 validation_failed + details.field', async () => {
  for (const bad of ['true', 'false', 1, 0, null, [], {}]) {
    const pool = new TotpLoginPool([userRow({ totp_login_enabled: true })]);
    const err = await admin.updateUser(pool, USER_ID, { totp_login_enabled: bad }).then(() => null, (e) => e);
    assert.ok(err instanceof admin.AdminError, `${JSON.stringify(bad)} ⇒ 必须抛 AdminError（实得 ${String(err)}）`);
    assert.equal(err.code, 'validation_failed');
    assert.equal(err.httpStatus, 400);
    assert.deepEqual(err.details, { field: 'totp_login_enabled' }, '必须点名是哪一格');
    assert.equal(pool.users[0].totp_login_enabled, true, '拒绝保存 ⇒ 库里不许被改');
  }
});

// ---------------------------------------------------------------------------
// T-3：五个 safeUser 生产点（漏补列就红）
// ---------------------------------------------------------------------------

test('T-3 五个 safeUser 生产点的 DTO 都含 totp_login_enabled，且值与库一致', async () => {
  const pool = new TotpLoginPool([userRow({ totp_login_enabled: true })]);

  // ① listUsers
  const listed = await admin.listUsers(pool);
  assert.equal(listed.items[0].totp_login_enabled, true, 'listUsers 的 SELECT 漏列 ⇒ 这里会是 false');

  // ② updateUser（写入面同时是读回面）
  const updated = await admin.updateUser(pool, USER_ID, { totp_login_enabled: false });
  assert.equal(updated.user.totp_login_enabled, false);

  // ③ enrollUserTotp（重绑也走 safeUser）
  const enrolled = await admin.enrollUserTotp(pool, USER_ID);
  assert.equal(enrolled.user.totp_login_enabled, false,
    '重绑不该顺手把「允许 TOTP 登录」打开或关掉（那是管理员的决定，不是重绑的副作用）');

  // ④ createUser 新建分支（列吃 DEFAULT true ⇒ 新账号一开户就允许，与存量同形）
  const created = await admin.createUser(pool, {
    login: 'bob', display_name: 'Bob', password: PASSWORD, email: 'bob@example.test',
    fde_name: 'bob', totp_enabled: false,
  });
  assert.equal(created.user.totp_login_enabled, true,
    '新建账号吃 DEFAULT true（INSERT 没写这一列 ⇒ 由 RETURNING 带回真实默认值）');

  // ⑤ createUser 的重激活分支（UPDATE 复用了 disabled 旧行 ⇒ 走的是另一条 SQL）
  const reactivatePool = new TotpLoginPool([
    userRow({ id: 'c0000000-0000-4000-8000-000000000003', login: 'carol', fde_name: 'carol',
      status: 'disabled', totp_login_enabled: false }),
  ]);
  const reactivated = await admin.createUser(reactivatePool, {
    login: 'carol', display_name: 'Carol', password: PASSWORD, email: 'carol@example.test',
    fde_name: 'carol', totp_enabled: false,
  });
  assert.ok(Object.hasOwn(reactivated.user, 'totp_login_enabled'),
    '重激活分支的 RETURNING 也要带这一列（缺键会被前端读成「没被谁关掉」= true，把库里存量的 false 洗掉）');
  assert.equal(reactivated.user.totp_login_enabled, false,
    '重激活**不**重置这一位：库里是 false 就还是 false（不猜运维的意图）');
});

// ---------------------------------------------------------------------------
// T-4 / T-5：与既有语义的边界
// ---------------------------------------------------------------------------

test('T-4 关掉「允许 TOTP 登录」不清密钥：totp_enabled 仍为 true（关掉 ≠ 解绑）', async () => {
  const pool = new TotpLoginPool([userRow({ totp_login_enabled: true })]);
  const secretBefore = pool.users[0].totp_secret;

  const { user } = await admin.updateUser(pool, USER_ID, { totp_login_enabled: false });
  assert.equal(user.totp_enabled, true, '「绑过」与「允许用」必须分得开');
  assert.equal(user.totp_login_enabled, false);
  assert.equal(pool.users[0].totp_secret, secretBefore, '一个字节都不许动（重绑要重新扫码，代价不该由这一位付）');

  // 再打开 ⇒ 立刻回到「可用」，不需要重新绑定
  const back = await admin.updateUser(pool, USER_ID, { totp_login_enabled: true });
  assert.equal(back.user.totp_enabled, true);
  assert.equal(back.user.totp_login_enabled, true);
  assert.equal(pool.users[0].totp_secret, secretBefore);
});

test('T-5 与 mail_otp_enabled 的交叉防护互不影响：没邮箱也关得掉 TOTP 登录', async () => {
  const pool = new TotpLoginPool([userRow({ email: null, mail_otp_enabled: false })]);
  const { user } = await admin.updateUser(pool, USER_ID, { totp_login_enabled: false });
  assert.equal(user.totp_login_enabled, false, '关掉 TOTP 登录不要求邮箱（那条防护只管邮件码）');
});

test('T-5b 没绑 TOTP 也允许写这一位（无害，且省一次往返）', async () => {
  const pool = new TotpLoginPool([userRow({ totp_secret: null })]);
  const { user } = await admin.updateUser(pool, USER_ID, { totp_login_enabled: true });
  assert.equal(user.totp_enabled, false, '没绑就是没绑');
  assert.equal(user.totp_login_enabled, true,
    '服务端不拦「先打开再绑」：真正决定走不走 TOTP 的是 `hasTotpEnrollment`，不是这里');
});

// ---------------------------------------------------------------------------
// T-6：登录侧的两条读取路径
// ---------------------------------------------------------------------------

test('T-6 authenticate 与 loadActiveUser 都把这一位带出去；缺键按 true', async () => {
  const off = userRow({ totp_login_enabled: false });
  const pool = new FakePool({ users: [off] });
  const viaLogin = await auth.authenticate(pool, off.login, 'wrong-password-just-for-shape');
  assert.equal(viaLogin.ok, false, '口令不对 ⇒ 但这一位是**读**出来的，与口令无关');

  const okUser = { ...off, password_hash: await passwordHash() };
  const pool2 = new FakePool({ users: [okUser] });
  const authenticated = await auth.authenticate(pool2, okUser.login, PASSWORD);
  assert.equal(authenticated.ok, true);
  assert.equal(authenticated.totpLoginEnabled, false,
    'authenticate 的 SELECT 漏这一列 ⇒ 这里会是 true ⇒ 「关掉」在登录路径上根本不生效');

  const loaded = await auth.loadActiveUser(pool2, okUser.id);
  assert.equal(loaded.totpLoginEnabled, false,
    '第二步（邮箱码）与重发路径读的是这一条 ⇒ 漏一处就是「第一步判对了、审计说胡话」');

  // 缺键（旧后端 / 旧形状的 users 行）⇒ 两侧都按 true，绝不打回口令直通
  const legacy = { ...userRow(), password_hash: await passwordHash() };
  delete legacy.totp_login_enabled;
  const pool3 = new FakePool({ users: [legacy] });
  assert.equal((await auth.authenticate(pool3, legacy.login, PASSWORD)).totpLoginEnabled, true,
    '缺键 = 没人关过 ⇒ true（`=== true` 会把所有人打成「只剩口令」）');
  assert.equal((await auth.loadActiveUser(pool3, legacy.id)).totpLoginEnabled, true);
});
