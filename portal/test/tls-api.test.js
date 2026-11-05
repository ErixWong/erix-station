// issue #456 管理台证书生命周期：HTTP 层（`/api/admin/tls*`）端到端。
//
// 判据来源：工单 `.work-orders/feat-261105-03-456-tls-api.md` §4/§5、issue #456、docs/api/portal.md §4.13。
// 隔离约定（docs/testing.md §2.1）：注入 `FakePool`（按 SQL 文本真模拟 `tls_certificates`）
// + **临时 dynamic 目录**（`os.tmpdir()`）+ 假 `tls.connect` / 假 `/proc/net/route` ⇒
// 不碰真实 DB、不碰真网络、不碰 `deploy/traefik/dynamic`（现网证书目录一个字节都不动）。
//
// 十条判据（编号与工单 §5 对齐，每条都能被打红）：
//   ① GET 无证书 ⇒ `configured:false` 且 `coverage.covered:false`（不抛、不 404）
//   ② PUT 合法 ⇒ 两文件落盘（**key 0600**）+ `tls.yml` 被重写（含新 fingerprint）+ DB 一行 + 审计一行且**不含 PEM**
//   ③ PUT 覆盖不了 adminHost ⇒ 400 + 码 + details，**盘上一个字节没变**（失败零副作用）
//   ④ PUT 私钥不配对 ⇒ 400 `tls_key_mismatch`，盘上不变
//   ⑤ PUT 过期证书 ⇒ 400 `tls_cert_expired`
//   ⑥ PUT 覆盖成功 ⇒ 旧证书进 `certs/prev/`（`meta.json` 存在且**不含 PEM**）
//   ⑦ rollback ⇒ 盘上回到 prev 内容 + 物化 + 审计；无 prev ⇒ 404 `tls_no_previous`
//   ⑧ verify：同指纹 ⇒ `live`；别的指纹 ⇒ `mismatch`；抛错/超时 ⇒ `unreachable`；三种都不许带 PEM/私钥
//   ⑨ GET 的响应键集**恰好**是白名单（防以后有人顺手加 `keyPem`）
//   ⑩ 超 64 KiB ⇒ 400 `validation_failed` + `details.field`

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { FakePool } from './fake-pool.js';
import { makeCert, makeChain, makeExpiredCert } from './tls-fixtures.js';

const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const FDE_ID = '00000000-0000-4000-8000-000000000002';
const ADMIN_TOKEN = 'tls-admin-session';
const FDE_TOKEN = 'tls-fde-session';
const ADMIN_HOST = 'admin.fde.erix.vip';
const ADMIN_PORT = 9443;

const WILDCARD = makeCert(); // CN=*.fde.erix.vip（覆盖 admin.fde.erix.vip）
const OTHER = makeCert({ cn: 'other.example', sans: ['other.example'] });
// 第二张**能覆盖 adminHost** 的证书（覆盖上传 / 回滚要用它：换一张同样合法但不同的证书）
const SECOND = makeCert({ cn: ADMIN_HOST, sans: [ADMIN_HOST] });
const EXPIRED = makeExpiredCert();
// #462：真三级链 root → intermediate → leaf（叶子 CN/SAN 覆盖 adminHost）。
const CHAIN = makeChain();

/** 假路由表（默认网关 172.32.0.1 = 现网实测值），避免依赖本机路由。 */
function fakeRoutePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlsapi-route-'));
  const p = path.join(dir, 'route');
  fs.writeFileSync(
    p,
    'Iface\tDestination\tGateway\tFlags\tRefCount\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n'
    + 'eth0\t00000000\t010020AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n',
  );
  return p;
}

async function startServer({ dynamicDir, connect } = {}) {
  const dir = dynamicDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tlsapi-dyn-'));
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlsapi-static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'INDEX');
  const config = {
    cookie: cookieSettings('tls-api-test', 600),
    sessionTtlSeconds: 600,
    sessionRenewIntervalSeconds: 3600,
    loginRateLimit: { maxFailures: 20, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: {
      maxFailures: 20, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 20, maxEntries: 100,
    },
    kdfConcurrency: 1,
    kdfQueueLimit: 10,
    kdfQueueTimeoutMs: 1000,
    maxBodyBytes: 64 * 1024,
    staticDir,
    // #456：证书面依赖的三个配置（`loadConfig` 的真实字段名）
    traefikDynamicDir: dir,
    adminHost: ADMIN_HOST,
    adminPort: ADMIN_PORT,
  };
  const pool = new FakePool({
    users: [
      { id: ADMIN_ID, login: 'admin', role: 'admin', status: 'active', auth_source: 'local' },
      { id: FDE_ID, login: 'alice', role: 'fde', fde_name: 'alice', status: 'active', auth_source: 'local' },
    ],
  });
  for (const [id, token] of [[ADMIN_ID, ADMIN_TOKEN], [FDE_ID, FDE_TOKEN]]) {
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
  const server = createServer({
    pool,
    config,
    log: { error() {}, warn() {}, log() {} },
    ...(connect ? { tlsConnect: connect } : {}),
    tlsRoutePath: fakeRoutePath(),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    pool,
    config,
    dynamicDir: dir,
    base,
    adminCookie: `${config.cookie.name}=${ADMIN_TOKEN}`,
    fdeCookie: `${config.cookie.name}=${FDE_TOKEN}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function call(base, method, pathname, { body, cookie, rawBody } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined || rawBody !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${base}${pathname}`, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json(res) {
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text === '' ? null : JSON.parse(text) };
}

const getTls = async (srv, cookie = srv.adminCookie) => json(await call(srv.base, 'GET', '/api/admin/tls', { cookie }));
const putTls = async (srv, body, cookie = srv.adminCookie) =>
  json(await call(srv.base, 'PUT', '/api/admin/tls', { body, cookie }));
const verifyTls = async (srv, cookie = srv.adminCookie) =>
  json(await call(srv.base, 'POST', '/api/admin/tls/verify', { body: {}, cookie }));
const rollbackTls = async (srv, cookie = srv.adminCookie) =>
  json(await call(srv.base, 'POST', '/api/admin/tls/rollback', { body: {}, cookie }));
// #456 M2：**解析但不落盘**（唯一允许的后端追加）。
const inspectTls = async (srv, body, cookie = srv.adminCookie) =>
  json(await call(srv.base, 'POST', '/api/admin/tls/inspect', { body, cookie }));

/** 盘上快照：`certs/**` + `tls.yml` 的 路径→内容 映射（用来证明「失败零副作用」）。 */
function snapshot(dynamicDir) {
  const out = {};
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else out[path.relative(dynamicDir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  if (fs.existsSync(dynamicDir)) walk(dynamicDir);
  return out;
}

const auditRows = (pool, action) => pool.audit.filter((row) => row.action === action);
// FakePool 按真实 SQL 存 `details`（`JSON.stringify` 后的字符串，与 `audit_log.details` 的 jsonb 同形）。
const auditDetails = (row) => JSON.parse(row.details);
const keyPath = (dir) => path.join(dir, 'certs', 'tls.key');
const certPath = (dir) => path.join(dir, 'certs', 'tls.crt');
const tlsYmlPath = (dir) => path.join(dir, 'tls.yml');

// ---------------------------------------------------------------------------
// ① 无证书 ⇒ 200 + configured:false（未配置是正常态）
// ---------------------------------------------------------------------------

test('#456API① 无证书 ⇒ GET 200 + configured:false + coverage.covered:false（不抛不 404）', async () => {
  const srv = await startServer();
  try {
    const res = await getTls(srv);
    assert.equal(res.status, 200, '未配置是正常态：200 而不是 404');
    assert.equal(res.body.configured, false);
    assert.equal(res.body.active, null);
    assert.deepEqual(res.body.coverage, { adminHost: ADMIN_HOST, covered: false });
    assert.deepEqual(res.body.live, { status: 'unknown', checkedAt: null });
    assert.equal(res.body.previous, null);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// ② PUT 合法 ⇒ 落盘 + 物化 + 台账 + 审计（且审计/响应都不含 PEM）
// ---------------------------------------------------------------------------

test('#456API② PUT 合法 ⇒ 两文件落盘（key 0600）+ tls.yml 重写 + DB 一行 + 审计一行（不含 PEM）', async () => {
  const srv = await startServer();
  try {
    const res = await putTls(srv, { certPem: WILDCARD.certPem, keyPem: WILDCARD.keyPem });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.configured, true);
    assert.equal(res.body.coverage.covered, true);

    // 盘上两文件
    assert.equal(fs.readFileSync(certPath(srv.dynamicDir), 'utf8'), WILDCARD.certPem);
    assert.equal(fs.readFileSync(keyPath(srv.dynamicDir), 'utf8'), WILDCARD.keyPem);
    assert.equal(fs.statSync(keyPath(srv.dynamicDir)).mode & 0o777, 0o600, '私钥必须 0600（事实①）');
    assert.equal(fs.statSync(certPath(srv.dynamicDir)).mode & 0o777, 0o644);

    // tls.yml 被重写：fingerprint 行 = 新证书的 sha256（reload 把手，事实②）
    const yml = fs.readFileSync(tlsYmlPath(srv.dynamicDir), 'utf8');
    const expectedDigest = crypto.createHash('sha256').update(WILDCARD.certPem).digest('hex');
    assert.ok(yml.includes(`# fingerprint=sha256:${expectedDigest} keymtime=`), 'tls.yml 必须带新证书的 fingerprint');
    assert.ok(!yml.includes('PRIVATE KEY'), 'tls.yml 正文里不许有私钥');

    // DB 台账一行
    assert.equal(srv.pool.tlsCerts.length, 1);
    assert.equal(srv.pool.tlsCerts[0].kind, 'upload');
    assert.equal(srv.pool.tlsCerts[0].uploaded_by, ADMIN_ID);
    assert.match(srv.pool.tlsCerts[0].fingerprint_sha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.deepEqual(srv.pool.tlsCerts[0].sans, ['*.fde.erix.vip', 'fde.erix.vip']);

    // 审计一行，且**不含 PEM / 私钥**
    const audits = auditRows(srv.pool, 'admin.tls_updated');
    assert.equal(audits.length, 1);
    assert.deepEqual(Object.keys(auditDetails(audits[0])).sort(), [
      'backupCreated', 'fingerprintSha256', 'notAfter', 'sans', 'subjectCN',
    ]);
    const detailsText = audits[0].details;
    assert.ok(!detailsText.includes('BEGIN'), '审计 details 里不许有 PEM');
    assert.ok(!detailsText.includes('PRIVATE KEY'));

    // 响应里也不许有 PEM / 私钥
    assert.ok(!res.text.includes('BEGIN CERTIFICATE'));
    assert.ok(!res.text.includes('PRIVATE KEY'));
    assert.ok(!res.text.includes(WILDCARD.keyPem.slice(40, 80)));
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// ③④⑤ 校验失败 ⇒ 400 + 具名码 + 盘上一个字节没变
// ---------------------------------------------------------------------------

test('#456API③ 覆盖不了 adminHost ⇒ 400 + details.missing，**盘上零变化**', async () => {
  const srv = await startServer();
  try {
    // 先装一张合法的，再拿不覆盖的来撞 ⇒ 失败必须保住旧证书
    assert.equal((await putTls(srv, { certPem: WILDCARD.certPem, keyPem: WILDCARD.keyPem })).status, 200);
    const before = snapshot(srv.dynamicDir);

    const res = await putTls(srv, { certPem: OTHER.certPem, keyPem: OTHER.keyPem });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'tls_cert_domain_mismatch');
    assert.deepEqual(res.body.error.details.missing, [ADMIN_HOST]);
    assert.deepEqual(res.body.error.details.certDomains, ['other.example']);
    assert.equal(res.body.error.retryable, false);

    assert.deepEqual(snapshot(srv.dynamicDir), before, '校验失败必须零副作用（盘上一个字节都不变）');
    assert.equal(srv.pool.tlsCerts.length, 1, '失败不许落台账');
    assert.equal(auditRows(srv.pool, 'admin.tls_updated').length, 1, '失败不许写审计');
  } finally {
    await srv.close();
  }
});

test('#456API④ 私钥不配对 ⇒ 400 tls_key_mismatch，盘上不变', async () => {
  const srv = await startServer();
  try {
    assert.equal((await putTls(srv, { certPem: WILDCARD.certPem, keyPem: WILDCARD.keyPem })).status, 200);
    const before = snapshot(srv.dynamicDir);
    const res = await putTls(srv, { certPem: WILDCARD.certPem, keyPem: OTHER.keyPem });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'tls_key_mismatch');
    assert.deepEqual(snapshot(srv.dynamicDir), before);
  } finally {
    await srv.close();
  }
});

test('#456API⑤ 过期证书 ⇒ 400 tls_cert_expired（且盘上不变）', async () => {
  const srv = await startServer();
  try {
    const res = await putTls(srv, { certPem: EXPIRED.certPem, keyPem: EXPIRED.keyPem });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'tls_cert_expired');
    assert.equal(srv.pool.tlsCerts.length, 0);
    assert.deepEqual(snapshot(srv.dynamicDir), {});
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// ⑥ 覆盖上传 ⇒ 上一代进 certs/prev/（meta.json 不含 PEM）
// ---------------------------------------------------------------------------

test('#456API⑥ 覆盖上传 ⇒ 旧证书进 certs/prev/（meta.json 存在且不含 PEM）', async () => {
  const srv = await startServer();
  try {
    assert.equal((await putTls(srv, { certPem: WILDCARD.certPem, keyPem: WILDCARD.keyPem })).status, 200);
    const res = await putTls(srv, { certPem: SECOND.certPem, keyPem: SECOND.keyPem });
    assert.equal(res.status, 200, res.text);
    assert.ok(res.body.previous, '响应里必须告诉前端「有可回滚备份」');
    assert.equal(res.body.previous.fingerprintSha256, crypto.X509Certificate
      ? new crypto.X509Certificate(WILDCARD.certPem).fingerprint256
      : null);

    const prevCert = path.join(srv.dynamicDir, 'certs', 'prev', 'tls.crt');
    const prevKey = path.join(srv.dynamicDir, 'certs', 'prev', 'tls.key');
    const prevMeta = path.join(srv.dynamicDir, 'certs', 'prev', 'meta.json');
    assert.equal(fs.readFileSync(prevCert, 'utf8'), WILDCARD.certPem, 'prev 里是**上一代**（不是刚上传的这张）');
    assert.equal(fs.statSync(prevKey).mode & 0o777, 0o600);
    const metaText = fs.readFileSync(prevMeta, 'utf8');
    assert.ok(!metaText.includes('BEGIN'), 'meta.json 里不许有 PEM');
    assert.ok(!metaText.includes('PRIVATE KEY'));
    const meta = JSON.parse(metaText);
    assert.deepEqual(Object.keys(meta).sort(), ['fingerprintSha256', 'notAfter', 'savedAt', 'subjectCN']);
    assert.equal(meta.subjectCN, '*.fde.erix.vip');

    // 审计里的 backupCreated 反映「真的建了备份」
    assert.equal(auditDetails(auditRows(srv.pool, 'admin.tls_updated').at(-1)).backupCreated, true);
    // 第二次上传也是 upload 两行台账
    assert.equal(srv.pool.tlsCerts.length, 2);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// ⑦ rollback
// ---------------------------------------------------------------------------

test('#456API⑦ rollback ⇒ 回到 prev 内容 + 物化 + 审计；无 prev ⇒ 404 tls_no_previous', async () => {
  const srv = await startServer();
  try {
    const none = await rollbackTls(srv);
    assert.equal(none.status, 404);
    assert.equal(none.body.error.code, 'tls_no_previous');
    assert.equal(none.body.error.retryable, false);

    assert.equal((await putTls(srv, { certPem: WILDCARD.certPem, keyPem: WILDCARD.keyPem })).status, 200);
    assert.equal((await putTls(srv, { certPem: SECOND.certPem, keyPem: SECOND.keyPem })).status, 200);

    const res = await rollbackTls(srv);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.active.subjectCN, '*.fde.erix.vip', '回到上一代');
    assert.equal(fs.readFileSync(certPath(srv.dynamicDir), 'utf8'), WILDCARD.certPem);
    assert.equal(fs.statSync(keyPath(srv.dynamicDir)).mode & 0o777, 0o600);
    // 物化了：tls.yml 的 fingerprint 行跟着变回旧证书
    const digest = crypto.createHash('sha256').update(WILDCARD.certPem).digest('hex');
    assert.ok(fs.readFileSync(tlsYmlPath(srv.dynamicDir), 'utf8').includes(`# fingerprint=sha256:${digest} keymtime=`));

    const audits = auditRows(srv.pool, 'admin.tls_rolled_back');
    assert.equal(audits.length, 1);
    assert.equal(auditDetails(audits[0]).subjectCN, '*.fde.erix.vip');
    assert.equal(auditDetails(audits[0]).backupCreated, false, '回滚不产生新备份');
    assert.ok(!audits[0].details.includes('BEGIN'));
    assert.equal(srv.pool.tlsCerts.at(-1).kind, 'rollback');
    // 回滚后 prev 仍在（重复回滚幂等）
    assert.equal((await rollbackTls(srv)).status, 200);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// ⑧ verify（假 tls.connect）
// ---------------------------------------------------------------------------

test('#456API⑧ verify：live / mismatch / unreachable 三种，且都不把 PEM 或私钥带进响应', async () => {
  const state = { fingerprint256: null, error: null };
  const connect = (opts) => {
    const sock = new EventEmitter();
    sock.destroy = () => {};
    sock.getPeerCertificate = () => ({
      fingerprint256: state.fingerprint256,
      raw: new crypto.X509Certificate(WILDCARD.certPem).raw,
    });
    if (state.error) setImmediate(() => sock.emit('error', Object.assign(new Error(state.error), { code: state.error })));
    else setImmediate(() => sock.emit('secureConnect'));
    assert.equal(opts.servername, ADMIN_HOST);
    assert.equal(opts.port, ADMIN_PORT);
    assert.equal(opts.rejectUnauthorized, false);
    return sock;
  };
  const srv = await startServer({ connect });
  try {
    // 盘上无证书 ⇒ 没有基准，报 unreachable + no_certificate（不瞎连）
    const noCert = await verifyTls(srv);
    assert.equal(noCert.status, 200);
    assert.equal(noCert.body.live.status, 'unreachable');
    assert.equal(noCert.body.live.error, 'no_certificate');

    assert.equal((await putTls(srv, { certPem: WILDCARD.certPem, keyPem: WILDCARD.keyPem })).status, 200);
    const expected = new crypto.X509Certificate(WILDCARD.certPem).fingerprint256;

    state.fingerprint256 = expected;
    const live = await verifyTls(srv);
    assert.equal(live.status, 200);
    assert.equal(live.body.live.status, 'live');
    assert.equal(live.body.live.fingerprintSha256, expected);
    assert.ok(live.body.live.checkedAt);
    // GET 随后回放的是缓存结果（不主动连接）
    assert.equal((await getTls(srv)).body.live.status, 'live');

    state.fingerprint256 = new crypto.X509Certificate(OTHER.certPem).fingerprint256;
    const mismatch = await verifyTls(srv);
    assert.equal(mismatch.body.live.status, 'mismatch');
    assert.equal(mismatch.body.live.fingerprintSha256, state.fingerprint256);

    state.fingerprint256 = expected;
    state.error = 'ECONNREFUSED';
    const unreachable = await verifyTls(srv);
    assert.equal(unreachable.body.live.status, 'unreachable');
    assert.equal(unreachable.body.live.error, 'ECONNREFUSED');

    for (const res of [noCert, live, mismatch, unreachable]) {
      assert.ok(!res.text.includes('BEGIN CERTIFICATE'), 'verify 响应不许带 PEM');
      assert.ok(!res.text.includes('PRIVATE KEY'), 'verify 响应不许带私钥');
    }
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// ⑨ 响应键集白名单
// ---------------------------------------------------------------------------

test('#456API⑨ GET 的响应键集**恰好**是白名单（无证书 / 有证书两种形态）', async () => {
  const srv = await startServer();
  try {
    const empty = await getTls(srv);
    assert.deepEqual(Object.keys(empty.body).sort(), ['active', 'configured', 'coverage', 'live', 'previous']);
    assert.deepEqual(Object.keys(empty.body.coverage).sort(), ['adminHost', 'covered']);
    assert.deepEqual(Object.keys(empty.body.live).sort(), ['checkedAt', 'status']);

    assert.equal((await putTls(srv, { certPem: WILDCARD.certPem, keyPem: WILDCARD.keyPem })).status, 200);
    const full = await getTls(srv);
    assert.deepEqual(Object.keys(full.body).sort(), ['active', 'configured', 'coverage', 'live', 'previous']);
    assert.deepEqual(Object.keys(full.body.active).sort(), [
      'fingerprintSha256', 'issuerCN', 'notAfter', 'notBefore', 'sans', 'subjectCN',
    ]);
    // 白名单的**反面**：任何密钥派生值都不许出现
    for (const forbidden of ['publicKeyPem', 'keyPem', 'certPem', 'privateKey', 'key']) {
      assert.ok(!(forbidden in full.body.active), `active 里不许有 ${forbidden}`);
      assert.ok(!(forbidden in full.body), `顶层不许有 ${forbidden}`);
    }
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// ⑩ 体积上限
// ---------------------------------------------------------------------------

test('#456API⑩ 单份 PEM 超 64 KiB ⇒ 400 validation_failed + details.field（不是 413）', async () => {
  const srv = await startServer();
  try {
    const huge = `-----BEGIN CERTIFICATE-----\n${'A'.repeat(64 * 1024)}\n-----END CERTIFICATE-----\n`;
    const res = await putTls(srv, { certPem: huge, keyPem: WILDCARD.keyPem });
    assert.equal(res.status, 400, res.text);
    assert.equal(res.body.error.code, 'validation_failed');
    assert.equal(res.body.error.details.field, 'certPem');
    // 私钥那份同样拦
    const res2 = await putTls(srv, { certPem: WILDCARD.certPem, keyPem: huge });
    assert.equal(res2.status, 400);
    assert.equal(res2.body.error.details.field, 'keyPem');
    assert.deepEqual(snapshot(srv.dynamicDir), {}, '超限不许写盘');
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// 附：鉴权 / 方法 / 限流（工单 §4 的「全部 requireAdmin」）
// ---------------------------------------------------------------------------

test('#456API+ 非 admin ⇒ 403；未登录 ⇒ 401；方法不对 ⇒ 405', async () => {
  const srv = await startServer();
  try {
    const forbidden = await getTls(srv, srv.fdeCookie);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'forbidden');

    const anon = await json(await call(srv.base, 'GET', '/api/admin/tls'));
    assert.equal(anon.status, 401);

    const badMethod = await json(await call(srv.base, 'DELETE', '/api/admin/tls', { cookie: srv.adminCookie }));
    assert.equal(badMethod.status, 405);
  } finally {
    await srv.close();
  }
});

test('#456API+ 上传限流：第 11 次 429 + Retry-After（按管理员计，10 次/小时）', async () => {
  const srv = await startServer();
  try {
    for (let i = 0; i < 10; i += 1) {
      const ok = await putTls(srv, { certPem: WILDCARD.certPem, keyPem: WILDCARD.keyPem });
      assert.equal(ok.status, 200, `第 ${i + 1} 次应当成功：${ok.text}`);
    }
    const blocked = await putTls(srv, { certPem: WILDCARD.certPem, keyPem: WILDCARD.keyPem });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'rate_limited');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0, '429 必须带 Retry-After');
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// ⑪~⑭ inspect（issue #456 M2）：**解析但不落盘**。四条判据逐条对应工单 §4。
// ---------------------------------------------------------------------------

test('#456API⑪ inspect 合法 ⇒ 200 + cert 六键白名单（SAN/覆盖判定齐全），且响应不含 PEM', async () => {
  const srv = await startServer();
  try {
    const res = await inspectTls(srv, { certPem: WILDCARD.certPem, keyPem: WILDCARD.keyPem });
    assert.equal(res.status, 200, res.text);
    // cert 的键集**恰好**是白名单（`publicKeyPem` 不许混进来）
    assert.deepEqual(Object.keys(res.body.cert).sort(), [
      'fingerprintSha256', 'issuerCN', 'notAfter', 'notBefore', 'sans', 'subjectCN',
    ]);
    assert.deepEqual(res.body.cert.sans, ['*.fde.erix.vip', 'fde.erix.vip']);
    assert.equal(res.body.cert.subjectCN, '*.fde.erix.vip');
    assert.match(res.body.cert.fingerprintSha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    // 覆盖判定：`*.fde.erix.vip` 覆盖 admin.fde.erix.vip（通配符只匹配一层，口径与后端同一函数）
    assert.deepEqual(res.body.coverage, { adminHost: ADMIN_HOST, covered: true });
    assert.equal(res.body.keyMatches, true);
    assert.deepEqual(res.body.warnings, []);
    assert.deepEqual(Object.keys(res.body).sort(), ['cert', 'coverage', 'keyMatches', 'warnings']);

    // 不覆盖 adminHost 的证书：**不报错**，只把事实说清（coverage.covered:false + 具名告警）
    const other = await inspectTls(srv, { certPem: OTHER.certPem, keyPem: OTHER.keyPem });
    assert.equal(other.status, 200, '不覆盖 adminHost 不是错误（用户可能就是在传一张还没生效的证书）');
    assert.equal(other.body.coverage.covered, false);
    assert.deepEqual(other.body.warnings, ['admin_host_not_covered']);

    for (const r of [res, other]) {
      assert.ok(!r.text.includes('BEGIN CERTIFICATE'), 'inspect 响应不许带 PEM');
      assert.ok(!r.text.includes('PRIVATE KEY'), 'inspect 响应不许带私钥');
      assert.ok(!r.text.includes(WILDCARD.keyPem.slice(40, 80)));
    }
  } finally {
    await srv.close();
  }
});

test('#456API⑫ inspect 省略 keyPem ⇒ keyMatches:null（空串/不传两种写法都算省略）', async () => {
  const srv = await startServer();
  try {
    const omitted = await inspectTls(srv, { certPem: WILDCARD.certPem });
    assert.equal(omitted.status, 200, omitted.text);
    assert.equal(omitted.body.keyMatches, null);

    const empty = await inspectTls(srv, { certPem: WILDCARD.certPem, keyPem: '' });
    assert.equal(empty.status, 200, empty.text);
    assert.equal(empty.body.keyMatches, null, '空串 = 没给（不是「给了一把坏钥匙」）');
  } finally {
    await srv.close();
  }
});

test('#456API⑬ inspect 私钥不配对 ⇒ 200 + keyMatches:false（**不是 400**）', async () => {
  const srv = await startServer();
  try {
    const res = await inspectTls(srv, { certPem: WILDCARD.certPem, keyPem: OTHER.keyPem });
    assert.equal(res.status, 200, '不配对只回事实，让 UI 自己禁用「确认安装」');
    assert.equal(res.body.keyMatches, false);
    // 形态坏掉才是 400：证书解析不出 / 私钥解析不出（沿用 M1 的码，不新增）
    const badCert = await inspectTls(srv, { certPem: 'not a pem', keyPem: WILDCARD.keyPem });
    assert.equal(badCert.status, 400);
    assert.equal(badCert.body.error.code, 'tls_cert_invalid');
    const badKey = await inspectTls(srv, { certPem: WILDCARD.certPem, keyPem: 'not a key' });
    assert.equal(badKey.status, 400);
    assert.equal(badKey.body.error.code, 'tls_key_invalid');
    // 过期证书也**不拒**（只进 warnings）：inspect 只做形态与配对判据
    const expired = await inspectTls(srv, { certPem: EXPIRED.certPem, keyPem: EXPIRED.keyPem });
    assert.equal(expired.status, 200, '过期是 PUT 的拒因，不是 inspect 的');
    assert.ok(expired.body.warnings.includes('cert_expired'));
  } finally {
    await srv.close();
  }
});

test('#456API⑭ inspect **零副作用**：盘上/DB/审计/tlsLive 全不变，且不发任何写语句', async () => {
  // 假 `tls.connect`：verify 要拿到「盘上那张」的指纹才算 live（本用例**不碰真网络**）。
  const connect = () => {
    const sock = new EventEmitter();
    sock.destroy = () => {};
    sock.getPeerCertificate = () => ({
      fingerprint256: new crypto.X509Certificate(WILDCARD.certPem).fingerprint256,
      raw: new crypto.X509Certificate(WILDCARD.certPem).raw,
    });
    setImmediate(() => sock.emit('secureConnect'));
    return sock;
  };
  const srv = await startServer({ connect });
  try {
    // 先装一张 + 真机校验一次，好让「缓存」与「台账」都有非零基线（否则「没变」毫无意义）
    assert.equal((await putTls(srv, { certPem: WILDCARD.certPem, keyPem: WILDCARD.keyPem })).status, 200);
    const liveRes = await verifyTls(srv);
    assert.equal(liveRes.body.live.status, 'live');

    const diskBefore = snapshot(srv.dynamicDir);
    const certsBefore = srv.pool.tlsCerts.length;
    const auditBefore = srv.pool.audit.length;
    srv.pool.statements.length = 0; // 只看 inspect 自己发了什么语句

    const res = await inspectTls(srv, { certPem: SECOND.certPem, keyPem: SECOND.keyPem });
    assert.equal(res.status, 200, res.text);

    assert.deepEqual(snapshot(srv.dynamicDir), diskBefore, '盘上一个字节都不许变（不落盘是这条的全部意义）');
    assert.equal(srv.pool.tlsCerts.length, certsBefore, '不许写台账');
    assert.equal(srv.pool.audit.length, auditBefore, '不许写审计');
    // `tlsLive` 缓存也不许动：上一次 verify 的结论仍然成立（inspect 的是**别的一张**）
    const after = await getTls(srv);
    assert.equal(after.body.live.status, 'live', 'inspect 不许重置/覆盖 tlsLive');
    assert.equal(
      after.body.active.fingerprintSha256,
      new crypto.X509Certificate(WILDCARD.certPem).fingerprint256,
      '盘上仍是上一张（inspect 的是别的一张，不许换上去）',
    );
    assert.notEqual(after.body.active.fingerprintSha256, res.body.cert.fingerprintSha256);

    // 连一条写语句都不许发（鉴权那几条 SELECT 不在本次窗口里：sqlLog 在 inspect 之前已清空，
    // 但鉴权发生在路由之前——所以这里按语句类型判，而不是按条数）
    const writes = srv.pool.statements.filter(({ sql }) => /^\s*(INSERT|UPDATE|DELETE|WITH)\b/i.test(sql));
    assert.deepEqual(writes, [], `inspect 不许发写语句：${JSON.stringify(writes)}`);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// #462 链完整性（M1 的 HTTP 面）：inspect 的 C1/C3/C5/C6/C7、PUT 的 C5/C7、
// 审计 chainWarnings、**落盘字节 == 提交字节**。
// ---------------------------------------------------------------------------

test('#462API① inspect C1：叶子+中间（正确顺序）⇒ 200 + 无 chain warning，cert 取**叶子**', async () => {
  const srv = await startServer();
  try {
    const res = await inspectTls(srv, { certPem: CHAIN.fullchainPem, keyPem: CHAIN.keyPem });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.cert.subjectCN, 'admin.fde.erix.vip', 'cert 必须是叶子（不是第 1 段以外的任何东西）');
    assert.equal(res.body.cert.issuerCN, 'Test Intermediate CA');
    assert.deepEqual(res.body.cert.sans, ['admin.fde.erix.vip', '*.fde.erix.vip']);
    assert.equal(res.body.keyMatches, true);
    assert.deepEqual(res.body.warnings, [], 'bundle 是期望形态：不警告');
    assert.deepEqual(res.body.coverage, { adminHost: ADMIN_HOST, covered: true });

    // 带根（C2）同样无警告
    const withRoot = await inspectTls(srv, { certPem: CHAIN.withRootPem, keyPem: CHAIN.keyPem });
    assert.equal(withRoot.status, 200, withRoot.text);
    assert.deepEqual(withRoot.body.warnings, [], '多发一张根无害 ⇒ 不警告');
  } finally {
    await srv.close();
  }
});

test('#462API② inspect C3：只有叶子（非自签）⇒ 200 + warnings 含 chain_looks_leaf_only（警告不拒）', async () => {
  const srv = await startServer();
  try {
    const res = await inspectTls(srv, { certPem: CHAIN.leafPem, keyPem: CHAIN.keyPem });
    assert.equal(res.status, 200, 'leaf-only 不是错误（确有只发 leaf 也够用的内部部署）');
    assert.deepEqual(res.body.warnings, ['chain_looks_leaf_only']);
  } finally {
    await srv.close();
  }
});

test('#462API③ inspect C5：顺序反了**且有私钥** ⇒ 400 tls_cert_order_invalid + details 两键', async () => {
  const srv = await startServer();
  try {
    const res = await inspectTls(srv, { certPem: CHAIN.wrongOrderPem, keyPem: CHAIN.keyPem });
    assert.equal(res.status, 400, res.text);
    assert.equal(res.body.error.code, 'tls_cert_order_invalid');
    assert.equal(res.body.error.retryable, false, '要改输入才能过 ⇒ 不可重试');
    assert.deepEqual(res.body.error.details, {
      firstSubjectCN: 'Test Intermediate CA',
      leafSubjectCN: 'admin.fde.erix.vip',
    });
    assert.ok(!res.text.includes('-----BEGIN CERTIFICATE-----'), '400 的 details 里不许带 PEM 正文');
    assert.ok(!res.text.includes('PRIVATE KEY'));
  } finally {
    await srv.close();
  }
});

test('#462API④ inspect C6：顺序反了**但没私钥** ⇒ 200 + chain_order_suspect（拿不到配对信息，只能警告）', async () => {
  const srv = await startServer();
  try {
    const res = await inspectTls(srv, { certPem: CHAIN.wrongOrderPem });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.keyMatches, null);
    assert.ok(res.body.warnings.includes('chain_order_suspect'), JSON.stringify(res.body.warnings));
  } finally {
    await srv.close();
  }
});

test('#462API⑤ inspect C7：接不上 ⇒ 200 + chain_broken（PUT 才拒）', async () => {
  const srv = await startServer();
  try {
    const res = await inspectTls(srv, { certPem: `${CHAIN.leafPem}${OTHER.certPem}`, keyPem: CHAIN.keyPem });
    assert.equal(res.status, 200, 'inspect 只做形态与配对判据：断链是 PUT 的拒因');
    assert.deepEqual(res.body.warnings, ['chain_broken']);
  } finally {
    await srv.close();
  }
});

test('#462API⑥ PUT C5：顺序反了 ⇒ 400 tls_cert_order_invalid，**盘上零变化**（且不是 tls_key_mismatch）', async () => {
  const srv = await startServer();
  try {
    assert.equal((await putTls(srv, { certPem: CHAIN.fullchainPem, keyPem: CHAIN.keyPem })).status, 200);
    const before = snapshot(srv.dynamicDir);
    const res = await putTls(srv, { certPem: CHAIN.wrongOrderPem, keyPem: CHAIN.keyPem });
    assert.equal(res.status, 400, res.text);
    assert.equal(res.body.error.code, 'tls_cert_order_invalid');
    assert.notEqual(res.body.error.code, 'tls_key_mismatch', '私钥是对的，报配对错是误导');
    assert.deepEqual(snapshot(srv.dynamicDir), before, '校验失败必须零副作用');
    assert.equal(srv.pool.tlsCerts.length, 1, '失败不许落台账');
  } finally {
    await srv.close();
  }
});

test('#462API⑦ PUT C7：链接不上 ⇒ 400 tls_cert_chain_broken + details 点名第几段，盘上不变', async () => {
  const srv = await startServer();
  try {
    const before = snapshot(srv.dynamicDir);
    const res = await putTls(srv, { certPem: `${CHAIN.leafPem}${OTHER.certPem}`, keyPem: CHAIN.keyPem });
    assert.equal(res.status, 400, res.text);
    assert.equal(res.body.error.code, 'tls_cert_chain_broken');
    assert.equal(res.body.error.retryable, false);
    assert.deepEqual(res.body.error.details, {
      index: 1,
      subjectCN: 'admin.fde.erix.vip',
      issuerCN: 'Test Intermediate CA',
      nextSubjectCN: 'other.example',
    });
    assert.deepEqual(snapshot(srv.dynamicDir), before, '断链不许写盘');
  } finally {
    await srv.close();
  }
});

test('#462API⑧ PUT C1：fullchain **原样落盘**（不重排、不裁剪）+ 台账取叶子 + 无 chainWarnings 键', async () => {
  const srv = await startServer();
  try {
    const res = await putTls(srv, { certPem: CHAIN.fullchainPem, keyPem: CHAIN.keyPem });
    assert.equal(res.status, 200, res.text);
    // 落盘字节 == 提交字节（红线：不许重排/裁剪/重新序列化）
    assert.equal(fs.readFileSync(certPath(srv.dynamicDir), 'utf8'), CHAIN.fullchainPem);
    assert.equal(fs.readFileSync(keyPath(srv.dynamicDir), 'utf8'), CHAIN.keyPem);
    assert.equal(fs.statSync(keyPath(srv.dynamicDir)).mode & 0o777, 0o600);

    // 台账 / 响应取的都是**叶子**
    assert.equal(srv.pool.tlsCerts.length, 1);
    assert.equal(srv.pool.tlsCerts[0].subject_cn, 'admin.fde.erix.vip');
    assert.deepEqual(srv.pool.tlsCerts[0].sans, ['admin.fde.erix.vip', '*.fde.erix.vip']);
    assert.equal(srv.pool.tlsCerts[0].fingerprint_sha256, new crypto.X509Certificate(CHAIN.leafPem).fingerprint256);
    assert.equal(res.body.active.subjectCN, 'admin.fde.erix.vip');
    assert.equal(res.body.active.issuerCN, 'Test Intermediate CA');
    assert.equal(res.body.coverage.covered, true);

    // 无警告 ⇒ 审计 details 里**不写** chainWarnings（老行形状不变）
    const audit = auditRows(srv.pool, 'admin.tls_updated').at(-1);
    assert.deepEqual(Object.keys(auditDetails(audit)).sort(), [
      'backupCreated', 'fingerprintSha256', 'notAfter', 'sans', 'subjectCN',
    ]);
  } finally {
    await srv.close();
  }
});

test('#462API⑨ PUT C3：leaf-only ⇒ 200 落盘 + 审计 details.chainWarnings 记下提示', async () => {
  const srv = await startServer();
  try {
    const res = await putTls(srv, { certPem: CHAIN.leafPem, keyPem: CHAIN.keyPem });
    assert.equal(res.status, 200, res.text);
    assert.equal(fs.readFileSync(certPath(srv.dynamicDir), 'utf8'), CHAIN.leafPem);
    const audit = auditRows(srv.pool, 'admin.tls_updated').at(-1);
    const details = auditDetails(audit);
    assert.deepEqual(details.chainWarnings, ['chain_looks_leaf_only'], '审计要留下「这张只有叶子」的证据');
    assert.ok(!audit.details.includes('BEGIN'), '审计里不许有 PEM');
    assert.ok(!audit.details.includes('PRIVATE KEY'));
  } finally {
    await srv.close();
  }
});

test('#462API⑩ verify DTO：chain_incomplete 的 reason/chainDepth 出现在响应里（缺席不写）', async () => {
  // 桩：端出**盘上那张的指纹**，但只发 1 张证书（链深 1）且非自签 ⇒ chain_incomplete
  const connect = () => {
    const sock = new EventEmitter();
    sock.destroy = () => {};
    sock.getPeerCertificate = () => ({
      fingerprint256: new crypto.X509Certificate(CHAIN.leafPem).fingerprint256,
      raw: new crypto.X509Certificate(CHAIN.leafPem).raw,
    });
    setImmediate(() => sock.emit('secureConnect'));
    return sock;
  };
  const srv = await startServer({ connect });
  try {
    assert.equal((await putTls(srv, { certPem: CHAIN.leafPem, keyPem: CHAIN.keyPem })).status, 200);
    const res = await verifyTls(srv);
    assert.equal(res.status, 200);
    assert.equal(res.body.live.status, 'mismatch');
    assert.equal(res.body.live.reason, 'chain_incomplete');
    assert.equal(res.body.live.chainDepth, 1);
    assert.equal(res.body.live.fingerprintSha256, new crypto.X509Certificate(CHAIN.leafPem).fingerprint256);
    // GET 回放缓存时两个可选键跟着走（白名单放行）
    const cached = await getTls(srv);
    assert.equal(cached.body.live.reason, 'chain_incomplete');
    assert.equal(cached.body.live.chainDepth, 1);
    // unknown 的 live 不带这两个键（缺席语义：不知道就不写）
    const fresh = await startServer();
    try {
      assert.deepEqual((await getTls(fresh)).body.live, { status: 'unknown', checkedAt: null });
    } finally {
      await fresh.close();
    }
  } finally {
    await srv.close();
  }
});
