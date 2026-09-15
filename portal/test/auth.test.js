// 单测：auth.js（口令哈希严格解析、session 只存 hash、过期/吊销真校验、pending token 单次消费、滚动续期）。
// 隔离约定（docs/testing.md §2.1）：注入 in-memory fake pool，不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as auth from '../src/auth.js';
import * as totp from '../src/totp.js';
import { FakePool } from './fake-pool.js';

test('createSession 只存 token_hash，DB 里查不到原文', async () => {
  const pool = new FakePool();
  const { token, tokenHash } = await auth.createSession(pool, 'user-1', { ttlSeconds: 604800 });
  assert.ok(token);
  assert.equal(pool.sessions.length, 1);
  assert.equal(pool.sessions[0].token_hash, tokenHash);
  assert.equal(pool.sessions[0].token_hash, auth.hashToken(token));
  assert.notEqual(pool.sessions[0].token_hash, token);
  assert.ok(!JSON.stringify(pool.sessions).includes(token));
});

test('hashPassword 产出自描述格式且可被 parseStoredHash 严格解析', async () => {
  const stored = await auth.hashPassword('correct horse battery staple');
  assert.ok(stored.startsWith('scrypt$16384$8$1$'));
  const parsed = auth.parseStoredHash(stored);
  assert.ok(parsed);
  assert.equal(parsed.expected.length, 64);
  assert.equal(parsed.salt.length, 16);
});

test('verifyPassword：正确口令 true、错误口令 false', async () => {
  const stored = await auth.hashPassword('secret-pass');
  assert.equal(await auth.verifyPassword('secret-pass', stored), true);
  assert.equal(await auth.verifyPassword('wrong', stored), false);
});

test('畸形 password_hash：scrypt$16384$8$1$00$zz（空 hash）→ false，不抛错', async () => {
  const malformed = 'scrypt$16384$8$1$00$zz';
  assert.equal(auth.parseStoredHash(malformed), null);
  assert.equal(await auth.verifyPassword('anything', malformed), false);
});

test('畸形 password_hash：scrypt$bad$8$1$00$00（非整数参数）→ false，不抛错不 500', async () => {
  const malformed = 'scrypt$bad$8$1$00$00';
  assert.equal(auth.parseStoredHash(malformed), null);
  assert.equal(await auth.verifyPassword('anything', malformed), false);
});

test('畸形 password_hash 全谱：非 hex、奇数 hex、非白名单算法、越界 N、keylen 不符 → null', async () => {
  assert.equal(auth.parseStoredHash(null), null);
  assert.equal(auth.parseStoredHash(''), null);
  assert.equal(auth.parseStoredHash('scrypt$16384$8$1$zz$' + 'a'.repeat(128)), null); // 非法 salt hex
  assert.equal(auth.parseStoredHash('scrypt$16384$8$1$abc$' + 'a'.repeat(128)), null); // 奇数 salt hex
  assert.equal(auth.parseStoredHash('argon2id$16384$8$1$abc$' + 'a'.repeat(128)), null); // 非白名单算法
  assert.equal(auth.parseStoredHash('scrypt$8$8$1$' + 'a'.repeat(32) + '$' + 'b'.repeat(128)), null); // N 过小
  assert.equal(auth.parseStoredHash('scrypt$16384$8$1$' + 'a'.repeat(32) + '$' + 'b'.repeat(10)), null); // keylen 不符（不由 DB 决定）
});

test('authenticate：畸形 hash 返回 malformed_hash（仍拉平时序），不 500', async () => {
  const pool = new FakePool({
    users: [
      {
        id: 'u1',
        login: 'alice',
        display_name: 'Alice',
        role: 'admin',
        fde_name: null,
        auth_source: 'local',
        status: 'active',
        password_hash: 'scrypt$16384$8$1$00$zz',
      },
    ],
  });
  const r = await auth.authenticate(pool, 'alice', 'whatever');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed_hash');
});

test('authenticate：用户不存在也跑 dummy scrypt（防用户枚举），返回 invalid_credentials', async () => {
  const pool = new FakePool({ users: [] });
  const r = await auth.authenticate(pool, 'nobody', 'whatever');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_credentials');
});

test('createPendingToken 只存 hash；consumePendingToken 单次消费、过期拒绝', async () => {
  const pool = new FakePool({ users: [{ id: 'u1' }] });
  const t0 = new Date('2026-01-01T00:00:00Z');
  const { token, tokenHash } = await auth.createPendingToken(pool, 'u1', { ttlSeconds: 120, now: t0 });
  assert.equal(pool.pending.length, 1);
  assert.equal(pool.pending[0].token_hash, tokenHash);
  assert.ok(!JSON.stringify(pool.pending).includes(token)); // 不存原文

  // 非消费读取可重复拿到 user
  assert.equal(await auth.findPendingUser(pool, token, { now: new Date(t0.getTime() + 1000) }), 'u1');

  const userId = await auth.consumePendingToken(pool, token, { now: new Date(t0.getTime() + 1000) });
  assert.equal(userId, 'u1');
  // 消费后：读取与再次消费均 null（单次）
  assert.equal(await auth.findPendingUser(pool, token, { now: new Date(t0.getTime() + 2000) }), null);
  const again = await auth.consumePendingToken(pool, token, { now: new Date(t0.getTime() + 2000) });
  assert.equal(again, null);
});

test('consumePendingToken：过期 → null', async () => {
  const pool = new FakePool({ users: [{ id: 'u1' }] });
  const t0 = new Date('2026-01-01T00:00:00Z');
  const { token } = await auth.createPendingToken(pool, 'u1', { ttlSeconds: 120, now: t0 });
  const userId = await auth.consumePendingToken(pool, token, { now: new Date(t0.getTime() + 121 * 1000) });
  assert.equal(userId, null);
});

test('findSessionUser：过期与吊销都拒绝（真校验，不再假覆盖）', async () => {
  const user = { id: 'u1', login: 'alice', display_name: 'Alice', role: 'admin', fde_name: null, auth_source: 'local', status: 'active' };
  const pool = new FakePool({ users: [user] });
  const t0 = new Date('2026-01-01T00:00:00Z');
  const { token } = await auth.createSession(pool, 'u1', { ttlSeconds: 100, now: t0 });

  // 未过期 → 找到
  assert.ok(await auth.findSessionUser(pool, token, { now: new Date(t0.getTime() + 50 * 1000) }));
  // 过期 → null
  assert.equal(await auth.findSessionUser(pool, token, { now: new Date(t0.getTime() + 101 * 1000) }), null);

  // 吊销 → null
  const { token: token2 } = await auth.createSession(pool, 'u1', { ttlSeconds: 100, now: t0 });
  await auth.revokeSession(pool, token2);
  assert.equal(await auth.findSessionUser(pool, token2, { now: t0 }), null);
});

test('renewSession：距上次续期超阈值才写库并返回新 expires_at；阈值内不写', async () => {
  const user = { id: 'u1', login: 'alice', display_name: 'Alice', role: 'admin', fde_name: null, auth_source: 'local', status: 'active' };
  const pool = new FakePool({ users: [user] });
  const t0 = new Date('2026-01-01T00:00:00Z');
  const { token } = await auth.createSession(pool, 'u1', { ttlSeconds: 100, now: t0 });
  const found = await auth.findSessionUser(pool, token, { now: t0 });
  const sessionId = found.session.id;

  // 阈值内（renewIntervalMs=1h，仅过 1 分钟）→ 不写
  const notYet = await auth.renewSession(pool, sessionId, { ttlSeconds: 100, renewIntervalMs: 60 * 60 * 1000, now: new Date(t0.getTime() + 60 * 1000) });
  assert.equal(notYet, null);

  // 超阈值 → 写并返回新 expires_at
  const renewed = await auth.renewSession(pool, sessionId, { ttlSeconds: 100, renewIntervalMs: 60 * 60 * 1000, now: new Date(t0.getTime() + 2 * 60 * 60 * 1000) });
  assert.ok(renewed);
  assert.equal(new Date(renewed).getTime(), t0.getTime() + 2 * 60 * 60 * 1000 + 100 * 1000);
});

test('renewSession：连续多次活动请求 expires_at 持续前移，last_seen_at 写为活动时间', async () => {
  const user = { id: 'u1', login: 'alice', display_name: 'Alice', role: 'admin', fde_name: null, auth_source: 'local', status: 'active' };
  const pool = new FakePool({ users: [user] });
  const t0 = new Date('2026-01-01T00:00:00Z');
  const { token } = await auth.createSession(pool, 'u1', { ttlSeconds: 100, now: t0 });
  const found = await auth.findSessionUser(pool, token, { now: t0 });
  const sessionId = found.session.id;
  const interval = 60 * 60 * 1000;

  // 第一次续期：t0+2h → expires = t0+2h+100s
  const r1 = await auth.renewSession(pool, sessionId, { ttlSeconds: 100, renewIntervalMs: interval, now: new Date(t0.getTime() + 2 * interval) });
  assert.equal(new Date(r1).getTime(), t0.getTime() + 2 * interval + 100 * 1000);
  const after1 = await auth.findSessionUser(pool, token, { now: new Date(t0.getTime() + 2 * interval) });
  assert.equal(new Date(after1.session.last_seen_at).getTime(), t0.getTime() + 2 * interval); // 活动时间而非未来 expires

  // 第二次续期：t0+4h → expires 继续前移（不再被未来 last_seen_at 卡住）
  const r2 = await auth.renewSession(pool, sessionId, { ttlSeconds: 100, renewIntervalMs: interval, now: new Date(t0.getTime() + 4 * interval) });
  assert.equal(new Date(r2).getTime(), t0.getTime() + 4 * interval + 100 * 1000);

  // 紧随其后（阈值内）→ 不再写
  const r3 = await auth.renewSession(pool, sessionId, { ttlSeconds: 100, renewIntervalMs: interval, now: new Date(t0.getTime() + 4 * interval + 60 * 1000) });
  assert.equal(r3, null);
});

test('verifyTotpForUser：正确码通过、错误码拒绝、重放拒绝', async () => {
  const secret = totp.generateSecret(20);
  const user = {
    id: 'u1',
    login: 'alice',
    display_name: 'Alice',
    role: 'admin',
    fde_name: null,
    auth_source: 'local',
    status: 'active',
    totp_secret: secret,
    last_totp_step: null,
  };
  const pool = new FakePool({ users: [user] });
  const now = new Date('2026-01-01T00:00:00Z');
  const code = totp.totp(secret, { time: now.getTime() });

  const ok = await auth.verifyTotpForUser(pool, 'u1', code, { now });
  assert.equal(ok.ok, true);
  assert.equal(ok.user.login, 'alice');
  assert.equal(user.last_totp_step, Math.floor(now.getTime() / 1000 / 30));

  // 同码重放 → 拒绝（last_totp_step 已推进）
  const replay = await auth.verifyTotpForUser(pool, 'u1', code, { now });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'totp_replay');

  // 错误码 → totp_invalid
  const wrong = await auth.verifyTotpForUser(pool, 'u1', '000000', { now });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'totp_invalid');
});

test('verifyTotpForUser：畸形 totp_secret（非法 base32）→ totp_invalid，不抛错不 500', async () => {
  const user = {
    id: 'u1',
    login: 'alice',
    display_name: 'Alice',
    role: 'admin',
    fde_name: null,
    auth_source: 'local',
    status: 'active',
    totp_secret: 'not-base32!',
    last_totp_step: null,
  };
  const pool = new FakePool({ users: [user] });
  const r = await auth.verifyTotpForUser(pool, 'u1', '123456', { now: new Date() });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'totp_invalid');
});
