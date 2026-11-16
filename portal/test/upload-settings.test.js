// issue #485 片 A：单文件上传上限搬进管理台（DB 存、每次上传现读、改完立即生效）。
//
// 两层：
//   * **模块层**（优先级/解析/校验/回落）—— 纯函数与假 pool，判据是「哪个值生效、为什么」。
//   * **复 audit 返修**（§4）—— 判据是「那次读取不返回时上传还过不过」+「设置与审计同生共死」，见本节头。
//   * **HTTP 层**（`POST /api/files/upload` + `GET|PUT /api/admin/upload/settings`）—— 判据是工单原文：
//     「管理台把上限改成 1 MiB ⇒ **不重启**，下一次上传 2 MiB 就 413」+「`413` 的 `details.max_bytes`
//     必须等于**生效值**（不是 env 值）」。
//
// 隔离约定（docs/testing.md §2.1）：tmp userspace + FakePool + 手工 session，不碰真实 DB / 真实 dev 栈。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/http.js';
import { cookieSettings, loadConfig } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { FakePool } from './fake-pool.js';
import {
  DEFAULT_MAX_FILE_BYTES, MIN_MAX_FILE_BYTES, MAX_MAX_FILE_BYTES,
  parseDbMaxFileBytes, resolveFromRow, resolveEffectiveMaxFileBytes,
  getUploadSettings, updateUploadSettings, UploadSettingsError,
  readTimeoutMs, DEFAULT_READ_TIMEOUT_MS, READ_TIMEOUT_ENV_VAR, AUDIT_ACTION, AUDIT_TARGET,
} from '../src/upload-settings.js';

const MIB = 1024 * 1024;
const ADMIN = {
  id: 'd0000000-0000-4000-8000-0000000000a1', login: 'root', display_name: 'Root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active', file_upload_enabled: false,
};
const UPLOADER = {
  id: 'd0000000-0000-4000-8000-0000000000a2', login: 'alice', display_name: 'Alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active', file_upload_enabled: true,
};
const NO_UPLOAD = {
  id: 'd0000000-0000-4000-8000-0000000000a3', login: 'bob', display_name: 'Bob',
  role: 'fde', fde_name: 'bob', auth_source: 'local', status: 'active', file_upload_enabled: false,
};

// ---------------------------------------------------------------------------
// 1. 模块层：优先级与解析（工单判据「DB > env > 默认」+「非法值不许按半个值生效」）
// ---------------------------------------------------------------------------

const ENV32 = { fileUploadMaxBytes: DEFAULT_MAX_FILE_BYTES, fileUploadMaxBytesSource: 'env' };
const ENV_ABSENT = { fileUploadMaxBytes: DEFAULT_MAX_FILE_BYTES, fileUploadMaxBytesSource: 'default' };

test('US-1 优先级 DB > env > 默认：三档各自行使一次，且 reason 说清"为什么不是 DB"', () => {
  const db = resolveFromRow({ max_file_bytes: String(2 * MIB) }, { config: ENV32 });
  assert.deepEqual(
    { v: db.maxBytes, s: db.source, r: db.reason },
    { v: 2 * MIB, s: 'db', r: null },
    'DB 有合法行 ⇒ 用它，env 靠后',
  );

  const env = resolveFromRow(null, { config: ENV32 });
  assert.deepEqual(
    { v: env.maxBytes, s: env.source, r: env.reason },
    { v: DEFAULT_MAX_FILE_BYTES, s: 'env', r: 'no_row' },
    '无行 + env 显式 ⇒ 落 env，reason=no_row（不是报错）',
  );

  const def = resolveFromRow(null, { config: ENV_ABSENT });
  assert.deepEqual(
    { v: def.maxBytes, s: def.source, r: def.reason },
    { v: DEFAULT_MAX_FILE_BYTES, s: 'default', r: 'no_row' },
    '无行 + env 没写 ⇒ 落默认 32 MiB，来源必须报 default 而不是 env',
  );

  const bad = resolveFromRow({ max_file_bytes: '0' }, { config: ENV32 });
  assert.deepEqual(
    { v: bad.maxBytes, s: bad.source, r: bad.reason },
    { v: DEFAULT_MAX_FILE_BYTES, s: 'env', r: 'invalid_db_value' },
    '有行但值非法 ⇒ 回落 env 并标 invalid_db_value（不许 500，也不许按半个值生效）',
  );
});

test('US-2 解析红线：0/负数/1e7 字符串/带空格/小数/超安全整数/区间外 ⇒ 全部 null；纯数字串与同值 number 同形', () => {
  // 工单点名的形状，逐个钉住（`parseInt('1e4') === 1` 那一族：半个值静默生效比报错难查十倍）。
  for (const raw of [0, -1, '0', '-1', '', '   ', '1e7', ' 100 ', '1048576 ', '1.5', 1.5, NaN, Infinity,
    null, undefined, '0x100000', '1,048,576', '99999999999999999999']) {
    assert.equal(parseDbMaxFileBytes(raw), null, `${JSON.stringify(raw)} 必须判为不可用，不许猜它想表达什么`);
  }
  // 区间外（手工 UPDATE 成一个比管理台天花板还大的数）同样不可用 ⇒ 回落。
  assert.equal(parseDbMaxFileBytes('2199023255552'), null, '2 TiB 在管理台天花板之外 ⇒ 不可用');
  assert.equal(parseDbMaxFileBytes(String(MIN_MAX_FILE_BYTES - 1)), null, '比下限小 1 字节 ⇒ 不可用');
  // 边界内两侧都可用。
  assert.equal(parseDbMaxFileBytes(String(MIN_MAX_FILE_BYTES)), MIN_MAX_FILE_BYTES);
  assert.equal(parseDbMaxFileBytes(String(MAX_MAX_FILE_BYTES)), MAX_MAX_FILE_BYTES);
  // `1e7` 作为 **JSON number** 是合法的（10000000，精确可表示）：非法的是字符串形状。
  assert.equal(parseDbMaxFileBytes(1e7), 10_000_000);
  assert.equal(parseDbMaxFileBytes(String(1e7)), 10_000_000);
  // 常量本身：默认值必须落在写侧区间内（否则 GET 显示"合法区间"却存不下默认值）。
  assert.ok(MIN_MAX_FILE_BYTES <= DEFAULT_MAX_FILE_BYTES && DEFAULT_MAX_FILE_BYTES <= MAX_MAX_FILE_BYTES);
});

test('US-3 写侧只接受区间内的 JSON number：字符串 / 空串 / 0 / 负数 / 越界 / 小数 ⇒ 一律 400 并点名字段与区间', async () => {
  const pool = new FakePool();
  const cases = [
    ['字符串数字', { maxFileBytes: '1048576' }],
    ['空串（HTML number input 清空就是它，Number("") === 0）', { maxFileBytes: '' }],
    ['科学计数法字符串', { maxFileBytes: '1e7' }],
    ['零', { maxFileBytes: 0 }],
    ['负数', { maxFileBytes: -1 }],
    ['小数', { maxFileBytes: 1.5 }],
    ['低于 1 MiB', { maxFileBytes: MIN_MAX_FILE_BYTES - 1 }],
    ['高于天花板', { maxFileBytes: MAX_MAX_FILE_BYTES + 1 }],
    ['键缺席', {}],
    ['null', { maxFileBytes: null }],
  ];
  for (const [label, fields] of cases) {
    const err = await updateUploadSettings({ pool, config: ENV32, fields }).then(() => null, (e) => e);
    assert.ok(err instanceof UploadSettingsError, `${label}：必须报错`);
    assert.equal(err.httpStatus, 400, `${label}：写侧校验错必须是 400，不是 500`);
    assert.equal(err.code, 'validation_failed', `${label}`);
    assert.equal(err.details.field, 'maxFileBytes', `${label}：必须点名旋钮`);
    assert.equal(err.details.min_bytes, MIN_MAX_FILE_BYTES, `${label}：必须把允许区间回给调用方`);
    assert.equal(err.details.max_bytes, MAX_MAX_FILE_BYTES, `${label}`);
  }
  // 非对象体（数组 / null）也算 400，字段名是 body。
  for (const body of [null, [], 'x', 7]) {
    const err = await updateUploadSettings({ pool, config: ENV32, fields: body }).then(() => null, (e) => e);
    assert.ok(err instanceof UploadSettingsError, `体=${JSON.stringify(body)} 必须 400`);
    assert.equal(err.details.field, 'body');
  }
  assert.equal(pool.uploadSettings, null, '校验不过时一条写语句都不该发出去（不落半个值）');
});

test('US-4 保存的 DTO 出自 RETURNING（不是回显输入），previous 是**改动前真正生效的那个数**', async () => {
  const pool = new FakePool();
  pool.uploadSettings = { max_file_bytes: 8 * MIB, updated_at: new Date(), updated_by: null };
  const first = await updateUploadSettings({ pool, config: ENV32, actorId: 'actor-1', fields: { maxFileBytes: 2 * MIB } });
  assert.equal(first.settings.maxFileBytes, 2 * MIB, '返回的生效值 = 真落库的值');
  assert.equal(first.settings.source, 'db');
  assert.equal(first.previous.maxFileBytes, 8 * MIB, '审计要的 previous 是改动前的**生效值**');
  assert.equal(first.previous.source, 'db');
  assert.ok(first.settings.updatedAt, 'updatedAt 来自 DB 行（now()），不是本地时钟猜的');
  assert.equal(first.settings.updatedBy, 'actor-1');

  // previous 在「之前无行」时要报**当时真正在用的那个来源**（env），不是 null。
  const pool2 = new FakePool();
  const second = await updateUploadSettings({ pool: pool2, config: ENV32, fields: { maxFileBytes: 4 * MIB } });
  assert.deepEqual(
    { v: second.previous.maxFileBytes, s: second.previous.source },
    { v: DEFAULT_MAX_FILE_BYTES, s: 'env' },
    '从无行状态改成 DB 值：previous 必须说"之前用的是 env 的 32 MiB"',
  );
});

test('US-5 DB 读失败：上传侧回落 env + warn 点名两个旋钮；管理台 GET 仍是 DTO 而不是抛', async () => {
  const warns = [];
  const log = { warn: (...a) => warns.push(a.join(' ')) };
  const boom = { async query() { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; } };

  const resolved = await resolveEffectiveMaxFileBytes({ pool: boom, config: ENV32, log });
  assert.deepEqual(
    { v: resolved.maxBytes, s: resolved.source, r: resolved.reason },
    { v: DEFAULT_MAX_FILE_BYTES, s: 'env', r: 'read_failed' },
    '读失败 ≠ 无行：reason 必须区分（运维要知道是哪种）',
  );
  assert.equal(warns.length, 1, '必须有一条 warn');
  assert.match(warns[0], /upload_settings\.max_file_bytes/, 'warn 点名 DB 旋钮');
  assert.match(warns[0], /FILE_UPLOAD_MAX_BYTES/, 'warn 同时点名 env 兜底旋钮');
  assert.match(warns[0], /上传不受影响/, 'warn 要说清影响面（上传照常）');

  const dto = await getUploadSettings({ pool: boom, config: ENV32, log });
  assert.equal(dto.maxFileBytes, DEFAULT_MAX_FILE_BYTES, '管理台这一页不许白屏（读失败也是 DTO）');
  assert.equal(dto.source, 'env');
  assert.equal(dto.reason, 'read_failed');
  assert.equal(dto.dbMaxFileBytes, null);
  assert.equal(dto.limits.minBytes, MIN_MAX_FILE_BYTES);
});

test('US-6 config 缺 fileUploadMaxBytes 时兜底不许变成 undefined（undefined maxBytes = 没有上限）', async () => {
  const resolved = await resolveEffectiveMaxFileBytes({ pool: new FakePool(), config: {}, log: { warn() {} } });
  assert.equal(resolved.maxBytes, DEFAULT_MAX_FILE_BYTES);
  assert.equal(resolved.source, 'default', 'config 没写来源 ⇒ 不许谎报 env');
});

// ---------------------------------------------------------------------------
// 2. HTTP 层
// ---------------------------------------------------------------------------

async function startStack({ configOverrides = {}, users = [ADMIN, UPLOADER, NO_UPLOAD] } = {}) {
  const userspace = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-485a-'));
  for (const u of users) {
    if (u.fde_name) fs.mkdirSync(path.join(userspace, u.fde_name, 'projects', 'demo'), { recursive: true });
  }
  const pool = new FakePool({ users });
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
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'T', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 5, maxEntries: 100 },
    kdfConcurrency: 2, kdfQueueLimit: 10, kdfQueueTimeoutMs: 30_000,
    maxBodyBytes: 64 * 1024, maxLoginLength: 128, maxPasswordLength: 256,
    staticDir: fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-')),
    userSpaceRoot: userspace,
    fdeUid: process.getuid?.() ?? 1000,
    fdeGid: process.getgid?.() ?? 1000,
    // env 侧**显式**给了 32 MiB（这一层的判据就是「DB 值要压过它」）。
    fileUploadMaxBytes: DEFAULT_MAX_FILE_BYTES,
    fileUploadMaxBytesSource: 'env',
    ...configOverrides,
  };
  const server = createServer({
    pool, config,
    llmGateway: { async listCredentials() { return { credentials: [] }; }, async listModels() { return { data: [] }; } },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    server, pool, config, userspace,
    proj: path.join(userspace, 'alice', 'projects', 'demo'),
    base: `http://127.0.0.1:${server.address().port}`,
    cookieFor: (login) => `fde_session_dev=${tokens.get(login)}`,
    close: () => new Promise((r) => server.close(r)).finally(() => fs.rmSync(userspace, { recursive: true, force: true })),
  };
}

async function readResp(res) {
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON：留给断言消息看 text */ }
  return { status: res.status, text, json };
}

const upload = ({ s, login = 'alice', name = 'f.bin', bytes, overwrite }) => {
  const q = new URLSearchParams({ cwd: '~/projects/demo', path: '.', name });
  if (overwrite) q.set('overwrite', '1');
  return fetch(`${s.base}/api/files/upload?${q}`, {
    method: 'POST',
    headers: { cookie: s.cookieFor(login), 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(bytes, 0x42),
  });
};

// ⚠ GET 带 body 会被 fetch 直接拒（`Request with GET/HEAD method cannot have body`），所以 GET 走另一条。
const adminFetch = (s, { method = 'GET', body, login = 'root' } = {}) => fetch(`${s.base}/api/admin/upload/settings`, {
  method,
  headers: { cookie: s.cookieFor(login), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** 数 fake 收到过的 upload_settings 语句（0 条 = 「压根没去读配置」的可观察证据）。 */
const uploadSettingsStatements = (pool) => pool.statements.filter((r) => /upload_settings/.test(r.sql));

test('US-7【工单判据 1+3】DB 里的 1 MiB 压过 env 的 32 MiB：2 MiB 上传 413，details.max_bytes 是**生效值**且标来源', async () => {
  const s = await startStack();
  try {
    s.pool.uploadSettings = { max_file_bytes: MIN_MAX_FILE_BYTES, updated_at: new Date(), updated_by: null };
    const res = await readResp(await upload({ s, bytes: 2 * MIB }));
    assert.equal(res.status, 413, `DB 上限 1 MiB，2 MiB 必须 413；实际 ${res.status} ${res.text}`);
    assert.equal(res.json.error.code, 'file_too_large');
    assert.equal(res.json.error.details.max_bytes, MIN_MAX_FILE_BYTES,
      'details.max_bytes 必须是**生效值**（DB 的 1 MiB），不是 env 的 32 MiB');
    assert.equal(res.json.error.details.limit_source, 'db', '413 要说清这个上限来自哪一边');
    assert.deepEqual(fs.readdirSync(s.proj).filter((n) => n.endsWith('.tmp')), [], '超限不留 temp 残骸');

    // 反向对照：同一个 2 MiB，在 DB 无行时必须能过（证明上面那条红是 DB 造成的，不是别的门槛）。
    s.pool.uploadSettings = null;
    const ok = await readResp(await upload({ s, name: 'ok.bin', bytes: 2 * MIB }));
    assert.equal(ok.status, 201, `无 DB 行 ⇒ 回落 env 32 MiB，2 MiB 该过；实际 ${ok.status} ${ok.text}`);
  } finally {
    await s.close();
  }
});

test('US-8【工单判据 2 + 立即生效】管理台 PUT 把上限改大 ⇒ **不重启**，下一次同样的上传就通过；改小 ⇒ 下一次就 413', async () => {
  const s = await startStack();
  try {
    s.pool.uploadSettings = { max_file_bytes: MIN_MAX_FILE_BYTES, updated_at: new Date(), updated_by: null };
    const before = await readResp(await upload({ s, name: 'x.bin', bytes: 2 * MIB }));
    assert.equal(before.status, 413, '起点：1 MiB 上限下 2 MiB 传不进');

    const put = await readResp(await adminFetch(s, { method: 'PUT', body: { maxFileBytes: 4 * MIB } }));
    assert.equal(put.status, 200, `保存必须 200；实际 ${put.status} ${put.text}`);
    assert.equal(put.json.maxFileBytes, 4 * MIB, '响应回的是**落库后的生效值**');
    assert.equal(put.json.source, 'db');

    // 同一个 server 进程、同一个 createServer 闭包，**没有任何重启/失效调用**。
    const after = await readResp(await upload({ s, name: 'x.bin', bytes: 2 * MIB, overwrite: true }));
    assert.equal(after.status, 200, `改大后同一个 2 MiB 必须过（判据是"改完立即生效"）；实际 ${after.status} ${after.text}`);

    const tighten = await readResp(await adminFetch(s, { method: 'PUT', body: { maxFileBytes: MIN_MAX_FILE_BYTES } }));
    assert.equal(tighten.status, 200);
    const again = await readResp(await upload({ s, name: 'y.bin', bytes: 2 * MIB }));
    assert.equal(again.status, 413, '改回去也必须立刻生效（双向）');

    // 审计：平台级操作，且要能看出「谁把哪个值改成哪个值」（fake 与真库一样存 jsonb 的文本）。
    const audits = s.pool.audit.filter((a) => a.action === 'admin.upload_settings_updated');
    assert.equal(audits.length, 2, `两次保存应有两条审计，实际 ${audits.length}`);
    assert.deepEqual(
      JSON.parse(audits[0].details),
      { max_file_bytes: 4 * MIB, previous_max_bytes: MIN_MAX_FILE_BYTES, previous_source: 'db' },
      '审计必须带新值 + 改动前的生效值与来源',
    );
    assert.equal(audits[0].target, 'upload_settings');
    assert.equal(audits[0].actor_id, ADMIN.id, '审计必须知道是谁改的');
  } finally {
    await s.close();
  }
});

test('US-9 管理台 GET 把三个来源与「当前生效值」一起回出来（来源不许猜）', async () => {
  const s = await startStack();
  try {
    const none = await readResp(await adminFetch(s));
    assert.equal(none.status, 200);
    assert.deepEqual(
      { v: none.json.maxFileBytes, src: none.json.source, r: none.json.reason, db: none.json.dbMaxFileBytes },
      { v: DEFAULT_MAX_FILE_BYTES, src: 'env', r: 'no_row', db: null },
      '无行 + env 显式 ⇒ 生效值是 env 的 32 MiB，来源 env',
    );
    assert.equal(none.json.envIsExplicit, true);
    assert.equal(none.json.envMaxFileBytes, DEFAULT_MAX_FILE_BYTES);
    assert.equal(none.json.defaultMaxFileBytes, DEFAULT_MAX_FILE_BYTES);
    assert.deepEqual(none.json.limits, { minBytes: MIN_MAX_FILE_BYTES, maxBytes: MAX_MAX_FILE_BYTES });

    // env 没写这一档：来源必须报 default（报 env 就是指着一个没被设置的值）。
    const s2 = await startStack({ configOverrides: { fileUploadMaxBytesSource: 'default' } });
    try {
      const d = await readResp(await adminFetch(s2));
      assert.equal(d.json.source, 'default');
      assert.equal(d.json.envIsExplicit, false);
    } finally { await s2.close(); }

    // 手工写进 DB 的非法值（8 TiB，区间外）⇒ 回落 env + reason，而不是 500/白屏。
    s.pool.uploadSettings = { max_file_bytes: 8 * 1024 * MIB, updated_at: new Date(), updated_by: null };
    const bad = await readResp(await adminFetch(s));
    assert.equal(bad.status, 200);
    assert.deepEqual(
      { v: bad.json.maxFileBytes, src: bad.json.source, r: bad.json.reason, db: bad.json.dbMaxFileBytes },
      { v: DEFAULT_MAX_FILE_BYTES, src: 'env', r: 'invalid_db_value', db: null },
      'DB 值非法 ⇒ 明确回落并点名来源（不许按半个值生效）',
    );
    // 同一条非法值下，上传照常工作（不是 500）。
    const up = await readResp(await upload({ s, name: 'still-works.bin', bytes: 2 * MIB }));
    assert.equal(up.status, 201, `DB 里是非法值时上传必须照常（判据：回落，不是 500）；实际 ${up.status} ${up.text}`);
  } finally {
    await s.close();
  }
});

test('US-10 鉴权与非 2xx 形状：非管理员读写都 403；PUT 非法值 400 且**不落库**；GET/PUT 之外的方法 405', async () => {
  const s = await startStack();
  try {
    for (const method of ['GET', 'PUT']) {
      const res = await readResp(await adminFetch(s, {
        method, login: 'alice', ...(method === 'PUT' ? { body: { maxFileBytes: 2 * MIB } } : {}),
      }));
      assert.equal(res.status, 403, `fde 用户 ${method} 必须 403，实际 ${res.status} ${res.text}`);
      assert.equal(res.json.error.code, 'forbidden');
    }
    assert.equal(s.pool.uploadSettings, null, '403 的那次 PUT 不得写库');

    const bad = await readResp(await adminFetch(s, { method: 'PUT', body: { maxFileBytes: '1048576' } }));
    assert.equal(bad.status, 400, `字符串值必须 400，实际 ${bad.status} ${bad.text}`);
    assert.equal(bad.json.error.code, 'validation_failed');
    assert.equal(bad.json.error.details.field, 'maxFileBytes');
    assert.equal(bad.json.error.details.min_bytes, MIN_MAX_FILE_BYTES);
    assert.equal(s.pool.uploadSettings, null, '校验不过不许落库');

    const del = await readResp(await adminFetch(s, { method: 'DELETE' }));
    assert.equal(del.status, 405);
    assert.equal(del.json.error.code, 'method_not_allowed');
  } finally {
    await s.close();
  }
});

test('US-11 关着的账号仍然是「读 body 之前」就 403：#485 新增的那次 SELECT 不得排在能力位之前', async () => {
  const s = await startStack();
  try {
    s.pool.uploadSettings = { max_file_bytes: MIN_MAX_FILE_BYTES, updated_at: new Date(), updated_by: null };
    const res = await readResp(await upload({ s, login: 'bob', name: 'no.bin', bytes: 4 * MIB }));
    assert.equal(res.status, 403, `未开上传的账号必须 403；实际 ${res.status} ${res.text}`);
    assert.equal(res.json.error.code, 'upload_disabled');
    assert.deepEqual(fs.readdirSync(path.join(s.userspace, 'bob', 'projects', 'demo')), [], '盘上零痕迹');
    // #472 的判据形状是「答复那一刻 data 事件 0 次」（http-upload.test.js 里已钉）；这一层补的是
    // **#485 自己的破坏面**：新加的取上限查询必须在能力位**之后** —— 关着的账号一次配置都不该读。
    assert.equal(uploadSettingsStatements(s.pool).length, 0,
      '未开上传的账号不该触发 upload_settings 查询（否则它先把 DB 查询+body 都花掉才被拒）');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// 3. 部署面 + 迁移纪律（同族的「两头说法」判据）
// ---------------------------------------------------------------------------

test('US-12 默认值三处同源：config 默认 == 模块常量 == compose 注入的默认（改一处不改另两处必红）', () => {
  const compose = fs.readFileSync(new URL('../../deploy/docker-compose.yml', import.meta.url), 'utf8');
  const m = compose.match(/FILE_UPLOAD_MAX_BYTES:\s*\$\{FILE_UPLOAD_MAX_BYTES:-(\d+)\}/);
  assert.ok(m, 'compose 的 portal service 必须显式注入 FILE_UPLOAD_MAX_BYTES（没有 env_file，不写就不生效）');
  assert.equal(Number(m[1]), DEFAULT_MAX_FILE_BYTES, 'compose 默认值必须等于 config 默认值');
  assert.equal(DEFAULT_MAX_FILE_BYTES, 32 * MIB);

  // config.js 的字面默认值也得是同一个数（上面那条测的是 compose，这一条测 config 自己）。
  const configSrc = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.match(configSrc, /fileUploadMaxBytes:\s*intEnv\(env,\s*'FILE_UPLOAD_MAX_BYTES',\s*32 \* 1024 \* 1024\)/,
    'config 的字面默认值必须与模块常量同数（32 MiB）');

  // 语义：env 已不是唯一真相 —— 文档必须说清 DB 优先（两头说法判据）。
  const envDoc = fs.readFileSync(new URL('../../docs/env.md', import.meta.url), 'utf8');
  assert.match(envDoc, /FILE_UPLOAD_MAX_BYTES/, 'env 文档保留这个旋钮');
  assert.match(envDoc, /upload_settings/, 'env 文档必须点名 DB 侧的真相表（否则运维只看得见 env）');
  const apiDoc = fs.readFileSync(new URL('../../docs/api/portal.md', import.meta.url), 'utf8');
  assert.match(apiDoc, /\/api\/admin\/upload\/settings/, '新端点必须登记进 API 契约');
});

test('US-13 迁移 0035：单行表 + bigint + CHECK > 0 + 幂等 + 末尾只读 DO（不许 UPDATE/DELETE）', () => {
  const file = new URL('../../deploy/migrations/0035-upload-settings.sql', import.meta.url);
  const sql = fs.readFileSync(file, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS upload_settings/, '必须 IF NOT EXISTS（重放是零 DDL 空操作）');
  assert.match(sql, /id\s+int PRIMARY KEY DEFAULT 1 CHECK \(id = 1\)/, '单行写成 DB 事实（与 0026 同手法）');
  assert.match(sql, /max_file_bytes\s+bigint NOT NULL CHECK \(max_file_bytes > 0\)/,
    'bigint（int 只到 2 GiB）+ > 0 的 DB 事实；产品区间由写侧挡（理由见迁移头注释）');
  assert.match(sql, /updated_by\s+uuid\s*\n\)/, 'updated_by 不建 FK（管理员被停用后配置要留着）');
  assert.doesNotMatch(sql, /^\s*(UPDATE|DELETE|DROP|ALTER)\b/m, '本片是新增表，不许回头改别的表');
  assert.match(sql, /RAISE NOTICE/, '重放证据（只读 DO 块）');
  assert.doesNotMatch(sql, /RAISE EXCEPTION/, '无行是正常态 ⇒ 不许在重放时炸');
  // baseline 冻结：新表不许回写 schema.sql。
  const baseline = fs.readFileSync(new URL('../../docs/data/schema.sql', file), 'utf8');
  assert.ok(!baseline.includes('upload_settings'), 'docs/data/schema.sql 是冻结 baseline，一字节不许改');
});

test('US-14 loadConfig：FILE_UPLOAD_MAX_BYTES 的来源标注（给了但非法 ⇒ default，不许谎报 env）', () => {
  const base = { MAX_BODY_BYTES: '1024' };
  const unset = loadConfig(base);
  assert.equal(unset.fileUploadMaxBytes, DEFAULT_MAX_FILE_BYTES);
  assert.equal(unset.fileUploadMaxBytesSource, 'default');

  assert.equal(loadConfig({ ...base, FILE_UPLOAD_MAX_BYTES: '1048576' }).fileUploadMaxBytesSource, 'env');
  // 给了但 intEnv 不采纳 ⇒ 生效的其实是默认值，来源就不许报 env。
  for (const raw of ['0', '-1', 'abc', '', '   ']) {
    const c = loadConfig({ ...base, FILE_UPLOAD_MAX_BYTES: raw });
    assert.equal(c.fileUploadMaxBytes, DEFAULT_MAX_FILE_BYTES, `${raw}：值回落默认`);
    assert.equal(c.fileUploadMaxBytesSource, 'default', `${raw}：来源必须跟着说真话（不许指着 env）`);
  }
  // 显式写了「恰好等于默认值」：来源是 env（运维确实设了它，管理台要如实显示）。
  assert.equal(loadConfig({ ...base, FILE_UPLOAD_MAX_BYTES: '33554432' }).fileUploadMaxBytesSource, 'env');
});

// ---------------------------------------------------------------------------
// 4. 复 audit 返修（2026-11-17）：活一 = 那次读取必须有超时；活二 = 保存与审计必须同生共死
// ---------------------------------------------------------------------------
//
// 两条都是「现在能工作，但故障形状没被挡住」：
//   * 活一：`readRow()` 只 `catch` 抛错。查询**发出去而不返回**（连接挂住、服务端不答）永远进不了 catch，
//     而这一次读取是**每次上传**都发的（无缓存是片 A 的取舍；前端逐文件上传 ⇒ N 文件 N 次读）。
//     #520 刚为降 DB 负载做了一整单，这条路径挂住 = 上传挂住。
//   * 活二：`SELECT 旧值 → UPSERT → await auth.audit()` 三个 await 之间谁都能插进来：并发保存把
//     `previous_*` 记成自己进来之前的数；审计 INSERT 失败则**设置已生效而审计一行没有**。

const READ_TIMEOUT_KNOB = READ_TIMEOUT_ENV_VAR;

/** 只在**这些用例**里改全局旋钮（顶层用例默认串行 ⇒ 不会互相踩）。用完必删，别把 50ms 留给后面的用例。 */
async function withKnob(raw, fn) {
  if (raw === undefined) delete process.env[READ_TIMEOUT_KNOB];
  else process.env[READ_TIMEOUT_KNOB] = String(raw);
  try {
    return await fn();
  } finally {
    delete process.env[READ_TIMEOUT_KNOB];
  }
}

// 心跳：故意留一个**被引用**的定时器，让「永不 settle」的读取不会把事件循环抽干。
// 没有它，变异「去掉超时」的表现是整轮 runner 被 `cancelledByParent` 带走（连带 6 条无辜的红，
// 看不出哪条是信号）；有了它，表现就是**该红的用例各自超时**（US-15/17），其余照跑。
const heartbeat = setInterval(() => {}, 1000);
after(() => clearInterval(heartbeat));

/** 一条**永不 settle**的读语句（不是抛错！抛错那条路径 US-5 已经钉过了）。 */
const HANGING_READ_POOL = { query: () => new Promise(() => {}) };

test('US-15【活一】查询不返回（永不 settle、不抛错）也必须按时给答案：read_timeout + 回落 env + 不刷 warn',
  { timeout: 10_000 }, async () => {
    const warns = [];
    const debugs = [];
    const log = { warn: (...a) => warns.push(a.join(' ')), debug: (...a) => debugs.push(a.join(' ')) };
    const t0 = Date.now();
    const resolved = await withKnob(50, () => resolveEffectiveMaxFileBytes({ pool: HANGING_READ_POOL, config: ENV32, log }));
    const waited = Date.now() - t0;
    assert.ok(waited < 3_000, `到点必须自己给答案（实测等 ${waited}ms ⇒ 变异「去掉超时」在这里就是整条用例挂死）`);
    assert.deepEqual(
      { v: resolved.maxBytes, s: resolved.source, r: resolved.reason },
      { v: DEFAULT_MAX_FILE_BYTES, s: 'env', r: 'read_timeout' },
      '超时 = 读不到：回落 env，reason 必须是 read_timeout（不是 read_failed，也不是 no_row）',
    );
    assert.deepEqual(warns, [], '超时是这条路径的常态兜底 ⇒ 不许 warn（一个慢 DB 会把日志刷满，#520 同族）');
    assert.equal(debugs.length, 1, '留一条 debug（值班要能看出这是超时，不是没配）');
    assert.match(debugs[0], /未返回/);
    assert.match(debugs[0], /FILE_UPLOAD_MAX_BYTES/);

    // 管理台那一页同理：超时也是 DTO，不许 500/白屏（与 `read_failed` 同口径）。
    const dto = await withKnob(50, () => getUploadSettings({ pool: HANGING_READ_POOL, config: ENV32, log }));
    assert.equal(dto.reason, 'read_timeout');
    assert.equal(dto.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
    assert.equal(dto.source, 'env');
  });

test('US-16【活一】UPLOAD_SETTINGS_READ_TIMEOUT_MS 只认正整数；非法形状 ⇒ 默认 1500 并 warn 点名旋钮；旋钮必须已登记', () => {
  const warns = [];
  const log = { warn: (...a) => warns.push(a.join(' ')) };
  assert.equal(readTimeoutMs({ env: {}, log }), DEFAULT_READ_TIMEOUT_MS, '未设 ⇒ 默认');
  assert.equal(readTimeoutMs({ env: { [READ_TIMEOUT_KNOB]: '250' }, log }), 250, '正整数 ⇒ 采纳');
  assert.equal(warns.length, 0, '合法值不该有 warn');
  for (const raw of ['0', '-1', 'abc', '   ', '1.5', 'Infinity', 'NaN']) {
    const w0 = warns.length;
    assert.equal(readTimeoutMs({ env: { [READ_TIMEOUT_KNOB]: raw }, log }), DEFAULT_READ_TIMEOUT_MS,
      `${raw}：不是正整数 ⇒ 必须用默认，不许把上传超时设成 0 或 NaN`);
    assert.equal(warns.length, w0 + 1, `${raw}：静默换默认值不行，要 warn`);
    assert.match(warns[warns.length - 1], new RegExp(READ_TIMEOUT_KNOB), 'warn 点名旋钮');
  }
  assert.equal(readTimeoutMs({ env: { [READ_TIMEOUT_KNOB]: '' }, log }), DEFAULT_READ_TIMEOUT_MS,
    'compose 里 `K=${K:-}` 会给空串 ⇒ 当未设处理');
  assert.ok(DEFAULT_READ_TIMEOUT_MS > 0 && DEFAULT_READ_TIMEOUT_MS <= 5_000,
    '默认值必须「远大于一次单行主键查、远小于一次可接受的上传等待」');

  // 两头说法：代码里有旋钮，env 文档与 .env.example 必须点名（只在代码里加的旋钮运维找不到）。
  const envDoc = fs.readFileSync(new URL('../../docs/env.md', import.meta.url), 'utf8');
  assert.match(envDoc, new RegExp(READ_TIMEOUT_KNOB), 'docs/env.md 必须登记这个旋钮');
  assert.match(envDoc, /read_timeout/, 'env 文档要说清超时的表现（reason=read_timeout，不挡上传）');
  const example = fs.readFileSync(new URL('../../deploy/.env.example', import.meta.url), 'utf8');
  assert.match(example, new RegExp(READ_TIMEOUT_KNOB), 'deploy/.env.example 必须登记这个旋钮');
});

/** 把「读 `upload_settings` 的那条 SELECT」换成永不 settle（写语句与其余语句照常走 fake）。 */
function hangUploadSettingsReads(pool) {
  const orig = pool.query.bind(pool);
  pool.query = (sql, params) => {
    if (/FROM upload_settings/.test(sql) && !sql.includes('INSERT INTO upload_settings')) {
      // 语句流水照记：不然「确实去读过、只是没回」与「压根没读」在判据里分不开。
      pool.statements.push({ sql, params });
      return new Promise(() => {});
    }
    return orig(sql, params);
  };
}

test('US-17【活一·工单口径】DB 卡住（读取不返回）时上传**不许被挡住**：仍按 env 值 201，管理台 GET 也是 200',
  { timeout: 20_000 }, async () => {
    const s = await startStack();
    try {
      hangUploadSettingsReads(s.pool);
      s.pool.uploadSettings = { max_file_bytes: MIN_MAX_FILE_BYTES, updated_at: new Date(), updated_by: null };
      // DB 里其实是 1 MiB；读不到 ⇒ 回落 env 的 32 MiB ⇒ 2 MiB 该过（「读不到不许挡住上传」）。
      const t0 = Date.now();
      const res = await readResp(await upload({ s, name: 'hang.bin', bytes: 2 * MIB }));
      const waited = Date.now() - t0;
      assert.equal(res.status, 201, `DB 卡住时上传必须照常（回落 env 32 MiB）；实际 ${res.status} ${res.text}`);
      assert.ok(waited < 5_000, `答复时间由超时决定（实测 ${waited}ms ⇒ 没有超时就是整条请求挂死）`);
      assert.ok(uploadSettingsStatements(s.pool).length >= 1, '确实试过读 DB（不是压根没读）');

      const got = await readResp(await adminFetch(s));
      assert.equal(got.status, 200, `管理台 GET 不许 500；实际 ${got.status} ${got.text}`);
      assert.equal(got.json.reason, 'read_timeout');
      assert.equal(got.json.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
    } finally {
      await s.close();
    }
  });

test('US-18【活二】保存只发**一条**语句，且那条语句同时写 upload_settings 与 audit_log（旧值也在这条里取）', async () => {
  const pool = new FakePool();
  pool.uploadSettings = { max_file_bytes: 8 * MIB, updated_at: new Date(), updated_by: null };
  await updateUploadSettings({ pool, config: ENV32, actorId: ADMIN.id, fields: { maxFileBytes: 2 * MIB } });
  const touched = pool.statements.filter((r) => /upload_settings|audit_log/.test(r.sql));
  assert.equal(touched.length, 1,
    `保存必须是**一条**语句（读旧值 + upsert + 审计）；实际发了 ${touched.length} 条：`
    + touched.map((r) => r.sql.replace(/\s+/g, ' ').slice(0, 60)).join(' | '));
  const sql = touched[0].sql;
  assert.match(sql, /INSERT INTO upload_settings/, '这条要写设置');
  assert.match(sql, /INSERT INTO audit_log/, '同一条要写审计（分开两个 await 就是活二那个洞）');
  assert.match(sql, /\bWITH\s+prev\b/i, '旧值必须在同一条语句里取（另发一条 SELECT 就是可插队的窗口）');
  assert.equal(pool.audit.length, 1, '一次保存恰好一条审计（调用方再补一笔 auth.audit 就是重复记账）');
});

test('US-19【活二】并发两次保存：每条审计的 previous 是**紧邻的前一个值**，不是自己进来之前的那个数', async () => {
  const pool = new FakePool();
  pool.uploadSettings = { max_file_bytes: 8 * MIB, updated_at: new Date(), updated_by: null };
  await Promise.all([
    updateUploadSettings({ pool, config: ENV32, actorId: ADMIN.id, fields: { maxFileBytes: 2 * MIB } }),
    updateUploadSettings({ pool, config: ENV32, actorId: ADMIN.id, fields: { maxFileBytes: 4 * MIB } }),
  ]);
  const auditPrev = pool.audit.map((a) => JSON.parse(a.details).previous_max_bytes).sort((x, y) => x - y);
  // 一条语句 ⇒ 第二条看到的是第一条写完的值：{8 MiB, 2 MiB} 两个**不同**的旧值。
  // 旧的「先 SELECT 再 UPSERT」⇒ 两条都先读到 8 MiB ⇒ {8 MiB, 8 MiB} ⇒ 本条红（变异读数见交付报告）。
  assert.deepEqual(auditPrev, [2 * MIB, 8 * MIB],
    '两条审计必须串成一条链（8→2→4）。两条都记 8 MiB 就是"看不出谁把谁改成谁"');
  assert.equal(pool.uploadSettings.max_file_bytes, 4 * MIB, '最后写入的值必须是终值');
});

test('US-20【活二】审计里 previous_* 与接口返回的 previous **逐值等价**（SQL 那份 CASE 不许自成一套）', async () => {
  const cases = [
    ['DB 里是合法值（8 MiB）', { max_file_bytes: 8 * MIB, updated_at: new Date(), updated_by: null }, 'db', 8 * MIB],
    ['DB 里没有行（回落 env）', null, 'env', DEFAULT_MAX_FILE_BYTES],
    // 区间外的行（8 TiB）：SQL 的 `BETWEEN $5 AND $6` 与 JS 的 parseDbMaxFileBytes 必须判成同一件事。
    ['DB 里是区间外的值', { max_file_bytes: 8 * 1024 * MIB, updated_at: new Date(), updated_by: null }, 'env', DEFAULT_MAX_FILE_BYTES],
  ];
  for (const [label, seed, wantSource, wantBytes] of cases) {
    const pool = new FakePool();
    pool.uploadSettings = seed;
    const before = pool.audit.length;
    const res = await updateUploadSettings({ pool, config: ENV32, actorId: ADMIN.id, fields: { maxFileBytes: 2 * MIB } });
    const details = JSON.parse(pool.audit[before].details);
    assert.deepEqual(
      { prev: res.previous.maxFileBytes, src: res.previous.source },
      { prev: details.previous_max_bytes, src: details.previous_source },
      `${label}：接口说的 previous 与审计记的 previous 必须是同一个数/同一个来源`,
    );
    assert.deepEqual(
      { prev: details.previous_max_bytes, src: details.previous_source },
      { prev: wantBytes, src: wantSource },
      `${label}：审计里的 previous 必须是当时真正在用的那个值`,
    );
    assert.equal(details.max_file_bytes, 2 * MIB, `${label}：新值就是落库值`);
    assert.equal(pool.audit[before].action, AUDIT_ACTION);
    assert.equal(pool.audit[before].target, AUDIT_TARGET);
  }
});

test('US-21【活二】审计写不进去 ⇒ 整条保存失败且**设置一格没变**（设置生效而无审计是不可接受的形态）', async () => {
  const pool = new FakePool();
  pool.uploadSettings = { max_file_bytes: 8 * MIB, updated_at: new Date(), updated_by: null };
  pool.failAudit = true;
  const err = await updateUploadSettings({ pool, config: ENV32, actorId: ADMIN.id, fields: { maxFileBytes: 2 * MIB } })
    .then(() => null, (e) => e);
  assert.ok(err, '审计写失败必须把错误招出来，不许静默 200');
  assert.equal(pool.uploadSettings.max_file_bytes, 8 * MIB,
    '设置必须**没改**：改成「设置已生效而审计一行没有」就是活二（两步写法在这里会红）');
  assert.equal(pool.audit.length, 0);

  // 取消注入后同一份 pool 能正常保存（证明上面那次失败没把库改成半个状态）。
  pool.failAudit = false;
  const ok = await updateUploadSettings({ pool, config: ENV32, actorId: ADMIN.id, fields: { maxFileBytes: 2 * MIB } });
  assert.equal(ok.settings.maxFileBytes, 2 * MIB);
  assert.equal(ok.previous.maxFileBytes, 8 * MIB, '上一次失败的保存没有留下痕迹（previous 仍是 8 MiB）');
  assert.equal(pool.audit.length, 1);
});
