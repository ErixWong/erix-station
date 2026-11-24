// issue #736 M4：API 令牌的**真库腿**。
//
// M1–M3 的 15 格在假库（FakePool）上全绿，但四条变异打不红——
// 假库按 SQL 文本裁决、语义在 JS 里又重写了一遍（见
// delta-not-persisted-db.test.js 头注释）。
// 本腿在真 postgres 上跑，专门盯那四条「假库够不到的 SQL 层」：
//   ① findActiveByToken 的 `AND t.revoked_at IS NULL`（吊销即失效，SQL 谓词）；
//   ② touchToken 的 5 分钟窗口（真 now() 语义，窗内第二次 0 行）；
//   ③ mintToken 的 `ON CONFLICT (user_id, name) DO NOTHING`（重名空 rows）；
//   ④ findApiTokenUser 折的 user 列面 + 折出的 session.id 必为 null。
//
// 夹具口径逐字照 upload-settings-real-db.test.js / delta-not-persisted-db.test.js：
// `TEST_DATABASE_URL` 未设 ⇒ 整文件 skip；每条用例自建自删库，
// 绝不碰真库 station-db。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import {
  hashApiToken,
  generateApiToken,
  mintToken,
  findActiveByToken,
  findApiTokenUser,
  touchToken,
  revokeToken,
} from '../src/api-tokens.js';
import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';

const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
const SKIP = URL_VALUE ? false : SKIP_WITHOUT_PG;
const fixture = URL_VALUE ? createPgFixture(URL_VALUE, { prefix: 'w736' }) : null;

const PASSWORD = 'correct horse battery staple';
let passwordHashCache = null;
async function passwordHash() {
  if (!passwordHashCache) passwordHashCache = await auth.hashPassword(PASSWORD);
  return passwordHashCache;
}

async function withFreshDb(fn, opts = {}) {
  return fixture.withFreshDatabase((ctx) => fn(ctx.pool, ctx), { log: () => {}, ...opts });
}

/** 口令直登账号：关 TOTP/邮箱码，file_upload_enabled 置 true（供 ④ 点名）。 */
async function seedUser(pool, { login, role = 'fde', email = null } = {}) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users
       (id, login, password_hash, status, role, email,
        must_change_password, file_upload_enabled, mail_otp_enabled, totp_login_enabled)
     VALUES ($1, $2, $3, 'active', $4, $5, false, true, false, false)`,
    [id, login, await passwordHash(), role, email],
  );
  return { id, login };
}

/** 给某账号签一枚令牌（真库 ON CONFLICT 生效），返回 { token, row }。 */
async function mintFor(pool, user, name) {
  const token = generateApiToken();
  const row = await mintToken(pool, { userId: user.id, name, tokenHash: hashApiToken(token) });
  return { token, row };
}

// ---------------------------------------------------------------------------
// 盲点 ①：findActiveByToken 的 `AND t.revoked_at IS NULL`。
// 变异 M1：谓词换成 `AND TRUE` ⇒ 吊销后仍能查回 ⇒ null 断言红。
// ---------------------------------------------------------------------------
test('#736 真库① 未吊销查回一行，吊销后查回 null', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const user = await seedUser(pool, { login: 'a1-revoker' });
    const { token, row } = await mintFor(pool, user, 'ci');
    assert.ok(row, '签发应返回一行');

    const live = await findActiveByToken(pool, token);
    assert.ok(live, '未吊销的令牌应查回一行');
    assert.equal(live.token_id, row.id);
    assert.equal(live.id, user.id, '联出的用户列 id 就是签发人');

    const gone = await findActiveByToken(pool, generateApiToken());
    assert.equal(gone, null, '未知令牌查回 null');

    const rev = await revokeToken(pool, { userId: user.id, tokenId: row.id });
    assert.equal(rev.outcome, 'revoked');
    assert.equal(rev.name, 'ci');

    // M1 的红点：吊销后必须查不回（真库上 revoked_at 谓词真的在过滤）。
    const dead = await findActiveByToken(pool, token);
    assert.equal(dead, null, '吊销后必须查回 null（M1 换 AND TRUE 会查回）');
  });
});

// ---------------------------------------------------------------------------
// 盲点 ②：touchToken 的真 now() 窗口。
// 变异 M2：窗口谓词换成 `AND TRUE` ⇒ 窗内第二次也写（返回 id）⇒ 红。
// ---------------------------------------------------------------------------
test('#736 真库② touchToken 窗内第二次 0 行，拨回后 1 行',
  { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const user = await seedUser(pool, { login: 'a2-throttle' });
    const { row } = await mintFor(pool, user, 'ci');

    // 第 1 次：last_used_at 是 NULL ⇒ 条件命中 ⇒ 写 1 行。
    const first = await touchToken(pool, row.id);
    assert.equal(first, row.id, '第 1 次（从未用过）应写一行');

    // 第 2 次：刚写的 last_used_at ≈ now()，不在 5 分钟窗口之外 ⇒ 0 行。
    const second = await touchToken(pool, row.id);
    assert.equal(second, null, '窗内第二次必须 0 行（M2 换 AND TRUE 会真写）');

    // 手动把 last_used_at 拨回 6 分钟前（真库时钟）⇒ 第 3 次应真写。
    await pool.query(
      `UPDATE api_tokens SET last_used_at = now() - interval '6 minutes' WHERE id = $1`,
      [row.id],
    );
    const third = await touchToken(pool, row.id);
    assert.equal(third, row.id, '窗口外应重新写一行');

    const after = await pool.query('SELECT last_used_at FROM api_tokens WHERE id = $1', [row.id]);
    const ageMs = Date.now() - new Date(after.rows[0].last_used_at).getTime();
    assert.ok(ageMs < 60 * 1000, `第 3 次写后 last_used_at 应贴近 now（${ageMs}ms 前）`);
  });
});

// ---------------------------------------------------------------------------
// 盲点 ③：mintToken 的 ON CONFLICT。
// 变异 M3：删掉 `ON CONFLICT (user_id, name) DO NOTHING` ⇒ 同名第二次撞 UNIQUE 抛错
//         ⇒ mintToken 抛 → 红。（假库当 JS 判断，从不抛 → 打不红。）
// ---------------------------------------------------------------------------
test('#736 真库③ 同名第二次 mintToken 空 rows（ON CONFLICT）',
  { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const user = await seedUser(pool, { login: 'a3-dup' });
    const first = await mintFor(pool, user, 'ci');
    assert.ok(first.row, '首次签发返回一行');

    const dup = await mintFor(pool, user, 'ci');
    assert.equal(dup.row, null,
      '同名第二次必须空 rows（M3 删 ON CONFLICT 会抛 UNIQUE → mintToken 抛）');

    const cnt = await pool.query(
      'SELECT count(*)::int AS n FROM api_tokens WHERE user_id = $1 AND name = $2',
      [user.id, 'ci'],
    );
    assert.equal(cnt.rows[0].n, 1, '被拒的签发不落第二行');

    // 吊销同名旁仍占名：吊销后再签同名还是空 rows（UNIQUE 含已吊销行）。
    await revokeToken(pool, { userId: user.id, tokenId: first.row.id });
    const afterRevoke = await mintFor(pool, user, 'ci');
    assert.equal(afterRevoke.row, null, '吊销后同名仍空 rows');
  });
});

// ---------------------------------------------------------------------------
// 盲点 ④：findApiTokenUser 折出的 user 列面 + session 形状。
// (a) 真列面：SELECT 的列全存在，user 与 cookie 路径折的 user 全等；
// (b) session.id 必为 null：M4 把 `session.id: null` 换成 `row.token_id` ⇒ 红。
//     真库 HTTP 也抓不到 M4（token_id 不是 login_session 主键，renew 命中 0 行、
//     仍不发 Set-Cookie）⇒ 只有直接读折出的 session.id 才打得到它。
// ---------------------------------------------------------------------------
test('#736 真库④ findApiTokenUser 折的 user 与 cookie 全等，session.id 为 null',
  { skip: SKIP }, async () => {
    await withFreshDb(async (pool) => {
      const user = await seedUser(pool, { login: 'a4-fold', email: 'a4@example.com' });

      // cookie 路径：真插一行 login_sessions，折出 user 作对照基准。
      const sess = await auth.createSession(pool, user.id, { ttlSeconds: 3600 });
      const viaCookie = await auth.findSessionUser(pool, sess.token);
      assert.ok(viaCookie, 'cookie 路径应折出会话');

      // 令牌路径：真签一枚令牌，折出 user + session。
      const { token, row } = await mintFor(pool, user, 'ci');
      const viaToken = await findApiTokenUser(pool, token);
      assert.ok(viaToken, '令牌路径应折出 user');

      // 少列会塌成 false，deepEqual 抓不到少列 ⇒ 下面逐格点名。
      assert.equal(viaCookie.user.file_upload_enabled, true,
        'cookie 路径 file_upload_enabled 必须 true（少列→false 当场红）');
      assert.equal(viaToken.user.file_upload_enabled, true,
        'Bearer 路径 file_upload_enabled 必须 true（少列→false 当场红）');
      assert.equal(viaCookie.user.must_change_password, false,
        'cookie 路径 must_change_password 必须 false（防少列收成 true）');
      assert.equal(viaToken.user.must_change_password, false,
        'Bearer 路径 must_change_password 必须 false（防少列收成 true）');

      // (a) 列面：两条路径 user 逐字段全等（真库能抓少列 / 混进秘密列）。
      assert.deepEqual(Object.keys(viaToken.user).sort(),
        ['auth_source', 'display_name', 'fde_name', 'file_upload_enabled', 'id', 'login',
          'must_change_password', 'role'].sort());
      assert.deepEqual(viaToken.user, viaCookie.user,
        '两条路径 user 逐字段相等（列面/秘密列/布尔化一致）');
      assert.equal(viaToken.user.id, user.id);

      // (b) session：令牌无 login_sessions 行 ⇒ session.id 必为 null（M4 红点）。
      assert.equal(viaToken.session.id, null,
        '折出的 session.id 必须是 null（M4 换成 row.token_id → 这里红）');
      assert.equal(viaToken.session.expires_at, null);
      assert.equal(viaToken.token.id, row.id, 'token.id 才是那枚令牌行 id');
      assert.equal(viaToken.viaToken, true);
    });
  });

// ---------------------------------------------------------------------------
// HTTP 端到端（真库 pool 注入 createServer）：
// 管理员签发 → Bearer GET /api/me 200 且无 Set-Cookie、带 X-Auth-Method: api_token
// → 吊销 → 同一令牌 401。吊销→401 依赖 revoked 谓词 ⇒ M1 也会打红这格。
// ---------------------------------------------------------------------------
function fakeMailerProvider() {
  const mailer = { enabled: false, async send() { return { ok: false, reason: 'disabled' }; } };
  return { sent: [], get: async () => mailer, invalidate() {} };
}

async function startServer(pool) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-736db-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: {
      maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, maxEntries: 10000,
    },
    totpRateLimit: {
      maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000,
      perTokenMaxFailures: 5, maxEntries: 10000,
    },
    kdfConcurrency: 2,
    kdfQueueLimit: 100,
    kdfQueueTimeoutMs: 30000,
    maxLoginLength: 128,
    maxPasswordLength: 256,
    staticDir,
    mail: { killSwitch: false },
    loginEmailCode: { ttlSeconds: 600, maxAttempts: 5, resendCooldownSeconds: 60, maxResends: 3 },
  };
  const server = createServer({ pool, config, mailerProvider: fakeMailerProvider() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  return { base, close };
}

async function req(base, { method = 'GET', pathname = '/api/me', body, cookie, authz } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (authz) headers.authorization = authz;
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return {
    status: res.status,
    json,
    text,
    setCookie: res.headers.get('set-cookie'),
    headers: res.headers,
  };
}

test('#736 真库 HTTP Bearer 200 无 Set-Cookie，吊销后 401', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    await seedUser(pool, { login: 'root736', role: 'admin' });
    await seedUser(pool, { login: 'eric736', role: 'fde' });
    const { base, close } = await startServer(pool);
    try {
      const login = await req(base, {
        method: 'POST',
        pathname: '/api/auth/login',
        body: { login: 'root736', password: PASSWORD },
      });
      assert.equal(login.status, 200, `管理员口令直登应 200：${login.text}`);
      assert.ok(login.setCookie, '登录响应应带会话 cookie');
      const cookie = login.setCookie.split(';')[0];

      const mint = await req(base, {
        method: 'POST',
        pathname: '/api/admin/users/eric736/tokens',
        cookie,
        body: { name: 'ci' },
      });
      assert.equal(mint.status, 201, `管理员代签应 201：${mint.text}`);
      const bearer = `Bearer ${mint.json.token}`;

      const me = await req(base, { authz: bearer });
      assert.equal(me.status, 200, `Bearer GET /api/me 应 200：${me.text}`);
      assert.equal(me.json.user.login, 'eric736');
      assert.equal(me.setCookie, null, '令牌路径绝不吐 Set-Cookie');
      assert.equal(me.headers.get('x-auth-method'), 'api_token', '令牌路径发 X-Auth-Method');

      const rev = await req(base, {
        method: 'DELETE',
        pathname: `/api/admin/users/eric736/tokens/${mint.json.id}`,
        cookie,
      });
      assert.equal(rev.status, 200, `吊销应 200：${rev.text}`);

      const dead = await req(base, { authz: bearer });
      assert.equal(dead.status, 401, '吊销后同一令牌应 401（M1 会让它仍查回）');
      assert.equal(dead.json.error.code, 'unauthorized');
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// 环境门自证（不设 skip）：没 PG 时上面五格必须是 skip，不是假通过。
// ---------------------------------------------------------------------------
const GUARDED = [
  '#736 真库① 未吊销查回一行，吊销后查回 null',
  '#736 真库② touchToken 窗内第二次 0 行，拨回后 1 行',
  '#736 真库③ 同名第二次 mintToken 空 rows（ON CONFLICT）',
  '#736 真库④ findApiTokenUser 折的 user 与 cookie 全等，session.id 为 null',
  '#736 真库 HTTP Bearer 200 无 Set-Cookie，吊销后 401',
];

test('#736 环境门自证：五格真库用例名与本文件一一对应，且门形状正确',
  () => {
  const selfSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.equal(GUARDED.length, 5, '真库判据五格：①②③④ + HTTP 端到端');
  for (const name of GUARDED) {
    assert.ok(selfSrc.includes(`test('${name}'`), `用例名漂移：${name}`);
  }
  if (!URL_VALUE) {
    assert.match(SKIP, /TEST_DATABASE_URL 未设置/, '无 PG 时必须整体 skip');
  } else {
    assert.equal(SKIP, false, '有 PG 时 skip 标志必须是 false（否则五格假通过）');
  }
});
