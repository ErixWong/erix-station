// HTTP 级集成测试：POST /api/files/upload（issue #472 片 B）。
// 这里只管**闸门与线上传输**（工单判据 B-1、B-3、B-11 的线上形状 + DTO/状态码/受限会话/同源门）；
// 落盘语义（B-2、B-4..B-10、B-12）在 `file-upload.test.js`（那里可以直接喂流，不必绕网络）。
// 隔离约定：tmp userspace + FakePool + 手工 session（照 pv-proxy.test.js 的套路），不碰真实环境。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { createServer, RESTRICTED_SESSION_ALLOWLIST } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { FakePool } from './fake-pool.js';

const SELF_UID = process.getuid?.() ?? 1000;
const SELF_GID = process.getgid?.() ?? 1000;

const ENABLED = {
  id: 'c0000000-0000-4000-8000-000000000001', login: 'alice', display_name: 'Alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
  file_upload_enabled: true,
};
const DISABLED = {
  id: 'c0000000-0000-4000-8000-000000000002', login: 'bob', display_name: 'Bob',
  role: 'fde', fde_name: 'bob', auth_source: 'local', status: 'active',
  file_upload_enabled: false,
};
// 「缺键」形状（片 A 的 A-3 口径：DTO 里应当有键，但**旧会话/旧 DTO** 可能压根没带）：
// 关掉 fake 的按 SQL 投影 ⇒ 让这一行的 `file_upload_enabled` 是 undefined。
const UNKNOWN = {
  id: 'c0000000-0000-4000-8000-000000000003', login: 'carol', display_name: 'Carol',
  role: 'fde', fde_name: 'carol', auth_source: 'local', status: 'active',
  file_upload_enabled: undefined,
};
const NO_SEAT = {
  id: 'c0000000-0000-4000-8000-000000000004', login: 'dave', display_name: 'Dave',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
  file_upload_enabled: true,
};
const RESTRICTED = {
  id: 'c0000000-0000-4000-8000-000000000005', login: 'erin', display_name: 'Erin',
  role: 'fde', fde_name: 'erin', auth_source: 'local', status: 'active',
  file_upload_enabled: true, must_change_password: true,
};

async function startStack({ users = [ENABLED, DISABLED, UNKNOWN, NO_SEAT, RESTRICTED], config: configOverrides = {} } = {}) {
  const userspace = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-upload-http-'));
  fs.mkdirSync(path.join(userspace, 'alice', 'projects', 'demo'), { recursive: true });
  fs.mkdirSync(path.join(userspace, 'bob', 'projects', 'demo'), { recursive: true });
  fs.mkdirSync(path.join(userspace, 'carol', 'projects', 'demo'), { recursive: true });
  fs.mkdirSync(path.join(userspace, 'erin', 'projects', 'demo'), { recursive: true });
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-'));

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
    staticDir,
    userSpaceRoot: userspace,
    // 属主：默认取**本进程真的能设**的值（非 root 只能 chown 到自身 uid / 所属组，
    // 见 fsutil-chown.test.js），这样这一层也能断真落盘属主；「值来自 config」由下面几条 spy 钉。
    fdeUid: configOverrides.fdeUid ?? SELF_UID,
    fdeGid: configOverrides.fdeGid ?? SELF_GID,
    fileUploadMaxBytes: configOverrides.fileUploadMaxBytes ?? 32 * 1024 * 1024,
    ...configOverrides,
  };
  const server = createServer({ pool, config, llmGateway: { async listCredentials() { return { credentials: [] }; }, async listModels() { return { data: [] }; } } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const proj = path.join(userspace, 'alice', 'projects', 'demo');
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    userspace, proj, pool, config,
    cookieFor: (login) => `fde_session_dev=${tokens.get(login)}`,
    dirEntries: (dir = proj) => fs.readdirSync(dir).sort(),
    close: () => new Promise((r) => server.close(r)).finally(() => fs.rmSync(userspace, { recursive: true, force: true })),
  };
}

const uploadUrl = ({ cwd = '~/projects/demo', relPath = '.', name, overwrite, base }) => {
  const q = new URLSearchParams({ cwd, path: relPath, name });
  if (overwrite) q.set('overwrite', '1');
  return `${base}/api/files/upload?${q}`;
};

/**
 * 数**服务端**请求流的 `data` 事件次数（B-1 的判据形状）。
 * 为什么不是 `req.on('data', ...)`：挂一个 data 监听器本身就**让流进入 flowing 模式**，
 * 于是「handler 到底读没读 body」被观察者改写了（实测：挂上监听器后，即使 handler 一个字节没读，
 * 事件照样来）。这里改成包住 `req.emit` 只**观察**不发车 ⇒ 零扰动，数到的才是 handler 真实读到的次数。
 * 同时在 `res` 的 `finish` 上取快照：Node 会在响应发完后自己把剩余 body 排空（`_dump`），
 * 事后再看 `readableDidRead` 一定是 true，那个时刻的快照才说明「答复时一个字节都还没读」。
 */
function watchRequestBodies(server) {
  const seen = [];
  server.prependListener('request', (req, res) => {
    const rec = {
      url: req.url,
      dataEvents: 0, dataBytes: 0,                        // 累计（含响应后的排空）⇒ 只作诊断输出
      dataEventsAtResponse: null, didReadAtResponse: null, listenerCountAtResponse: null, // **判据面**：答复那一刻的快照
    };
    seen.push(rec);
    const orig = req.emit.bind(req);
    req.emit = (ev, ...args) => {
      if (ev === 'data') { rec.dataEvents += 1; rec.dataBytes += args[0]?.length ?? 0; }
      return orig(ev, ...args);
    };
    res.once('finish', () => {
      // ⚠ 判据只能取**这一刻**的快照：响应发完 Node 会自己把剩余 body 排空（`IncomingMessage._dump()`
      //   ⇒ resume() ⇒ flowing），于是「之后」再数 data 事件必然 > 0，与 handler 读没读无关。
      rec.dataEventsAtResponse = rec.dataEvents;
      rec.didReadAtResponse = req.readableDidRead;
      rec.listenerCountAtResponse = req.listenerCount('data');
    });
  });
  return seen;
}

/** 真 http 客户端：先写 64KiB，等 500ms（响应必须在这段时间里已经到达）再写完剩下的。 */
function slowUpload({ base, body, headers = {}, pauseMs = 500 }) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}`, {
      method: 'POST',
      headers: { 'content-length': String(body.length), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    const first = body.subarray(0, Math.min(64 * 1024, body.length));
    const rest = body.subarray(first.length);
    req.write(first);
    setTimeout(() => { if (rest.length) req.end(rest); else req.end(); }, pauseMs);
  });
}

const remnants = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));

/**
 * 读一次响应体，同时给出状态码 / 原文 / 解析后的信封。
 * ⚠ 为什么要有这个：`await res.text()` 与 `await res.json()` 是**两次消费**，第二次会抛
 * `Body is unusable: Body has already been read` —— 而把它写在断言的 message 位上看起来人畜无害
 * （`assert.equal(res.status, 201, await res.text())`），于是「断言还没跑，测试先红」。
 */
async function readResp(res) {
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON：留给调用方看 text */ }
  return { status: res.status, text, json };
}
const waitFor = async (fn, ms = 2000) => {
  const until = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
};

// ---------------------------------------------------------------------------
// B-1：能力位关 ⇒ 403，而且**根本没读 body**
// ---------------------------------------------------------------------------

test('B-1 file_upload_enabled=false ⇒ 403 upload_disabled：盘上零新文件 + 请求体 data 事件 0 次', async () => {
  const s = await startStack();
  const seen = watchRequestBodies(s.server);
  try {
    const before = s.dirEntries();
    const body = Buffer.alloc(512 * 1024, 0x41);
    const res = await slowUpload({
      base: uploadUrl({ base: s.base, name: 'never.txt' }),
      body,
      headers: { cookie: s.cookieFor('bob'), 'content-type': 'application/octet-stream' },
    });
    assert.equal(res.status, 403, `应当 403，实际 ${res.status} ${res.text}`);
    const envelope = JSON.parse(res.text);
    assert.equal(envelope.error.code, 'upload_disabled');
    assert.equal(envelope.error.details.action, 'enable_in_admin_console');

    const rec = seen.find((r) => r.url.startsWith('/api/files/upload'));
    assert.ok(rec, '必须抓到这条请求');
    // 判据取**答复那一刻**的快照（`_dump` 之后的排空不算，见 watchRequestBodies 的注释）。
    assert.equal(rec.dataEventsAtResponse, 0,
      `答复那一刻服务端必须一个字节都没读才算「判据在读 body 之前」（评审 blocker 5）；`
      + `实际答复前 data 事件 ${rec.dataEventsAtResponse} 次（答复后累计含排空 ${rec.dataEvents} 次 / ${rec.dataBytes} 字节）`);
    assert.equal(rec.didReadAtResponse, false, '答复发出那一刻 body 不该被读过');
    assert.equal(rec.listenerCountAtResponse, 0, 'handler 不该给请求流挂 data 监听器（= 开始消费）');

    assert.deepEqual(s.dirEntries(), before, '关掉的账号不得在盘上留下任何新条目');
    assert.equal(fs.existsSync(path.join(s.proj, 'never.txt')), false);
    assert.deepEqual(remnants(s.proj), [], '也不得留下 temp');
  } finally {
    await s.close();
  }
});

test('B-1 DTO 缺键（旧会话没带 file_upload_enabled）也算未开 ⇒ 同样 403 且零读取', async () => {
  const s = await startStack();
  const seen = watchRequestBodies(s.server);
  try {
    const res = await fetch(uploadUrl({ base: s.base, name: 'x.txt' }), {
      method: 'POST',
      headers: { cookie: s.cookieFor('carol'), 'content-type': 'application/octet-stream' },
      body: Buffer.from('bytes'),
    });
    const r = await readResp(res);
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'upload_disabled');
    const rec = seen.find((r) => r.url.startsWith('/api/files/upload'));
    assert.equal(rec.dataEventsAtResponse, 0, '缺键 = 不知道 = 不授权，并且一样不许收 body');
    assert.deepEqual(remnants(s.proj), []);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// B-3：属主两个值都来自 config（环境无关的实参断言）
// ---------------------------------------------------------------------------

test('B-3 fdeUid/fdeGid 是**注入值**而不是硬编码：fchown 实参 = (config.fdeUid, config.fdeGid)，mode 0660', async () => {
  // 注入两个非 1000 的值。非 root 环境下真 fchown 会 EPERM，所以这里把 fchown 换成「记录 + 吞掉」的桩：
  // 断的是**调用点传了什么**（正是「摘掉 uid/gid」这个变异要抓的东西）；真落盘属主由下一条覆盖。
  const real = fs.fchownSync;
  const calls = [];
  fs.fchownSync = (fd, uid, gid) => { calls.push([uid, gid]); };
  const s = await startStack({ config: { fdeUid: 4321, fdeGid: 5432 } });
  try {
    const res = await fetch(uploadUrl({ base: s.base, name: 'owner.txt' }), {
      method: 'POST',
      headers: { cookie: s.cookieFor('alice'), 'content-type': 'application/octet-stream' },
      body: Buffer.from('payload'),
    });
    const r = await readResp(res);
    assert.equal(r.status, 201, r.text);
    assert.equal(calls.length, 1, `上传必须恰好改一次属主，实际 ${calls.length} 次`);
    assert.deepEqual(calls[0], [4321, 5432],
      '两个值都必须来自 ctx.config（只传 uid ⇒ 留下 gid=0=root 组 ⇒ agent 改不动；一个都不传 ⇒ 文件是 root 的）');
    assert.equal(fs.statSync(path.join(s.proj, 'owner.txt')).mode & 0o777, 0o660);
  } finally {
    fs.fchownSync = real;
    await s.close();
  }
});

test('B-3 真落盘属主：config 给的就是盘上看到的（root 环境注入外部 uid/gid 同样成立）', async () => {
  const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
  const gid = IS_ROOT ? 4321 : (() => {
    // 非 root：挑一个本进程真的能设、且**与 egid 不同**的所属组（`id -G`）。
    const g = execSync('id -G', { encoding: 'utf8' }).trim().split(/\s+/).map(Number)
      .find((x) => Number.isFinite(x) && x !== SELF_GID);
    return g ?? SELF_GID;
  })();
  const s = await startStack({ config: { fdeUid: IS_ROOT ? 4321 : SELF_UID, fdeGid: gid } });
  try {
    const res = await fetch(uploadUrl({ base: s.base, name: 'real.txt' }), {
      method: 'POST',
      headers: { cookie: s.cookieFor('alice'), 'content-type': 'application/octet-stream' },
      body: Buffer.from('payload'),
    });
    assert.equal(res.status, 201);
    const st = fs.statSync(path.join(s.proj, 'real.txt'));
    assert.equal(st.uid, IS_ROOT ? 4321 : SELF_UID);
    assert.equal(st.gid, gid);
    assert.equal(st.mode & 0o777, 0o660);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// 线上形状：状态码 / DTO / 上限 / 0 字节 / 断流
// ---------------------------------------------------------------------------

test('开着的账号 ⇒ 201 + { path, bytes, overwritten:false }，字节逐字节相同；已存在 ⇒ 409；overwrite=1 ⇒ 200 + overwritten:true 且内容真的换掉', async () => {
  const s = await startStack();
  try {
    const payload = Buffer.from([0x00, 0xff, 0x41, 0x80, 0xe4, 0xbd, 0xa0]);
    const r1 = await fetch(uploadUrl({ base: s.base, name: 'wire.bin' }), {
      method: 'POST',
      headers: { cookie: s.cookieFor('alice'), 'content-type': 'application/octet-stream' },
      body: payload,
    });
    const b1 = await readResp(r1);
    assert.equal(b1.status, 201, b1.text);
    assert.deepEqual(b1.json, { path: 'wire.bin', bytes: payload.length, overwritten: false });
    assert.deepEqual(Buffer.from(fs.readFileSync(path.join(s.proj, 'wire.bin'))), payload);

    const r2 = await fetch(uploadUrl({ base: s.base, name: 'wire.bin' }), {
      method: 'POST',
      headers: { cookie: s.cookieFor('alice'), 'content-type': 'application/octet-stream' },
      body: Buffer.from('different'),
    });
    assert.equal(r2.status, 409);
    const e2 = await r2.json();
    assert.equal(e2.error.code, 'file_exists');
    assert.deepEqual(Buffer.from(fs.readFileSync(path.join(s.proj, 'wire.bin'))), payload, '409 之后原内容必须未变');

    const fresh = Buffer.from('REPLACED');
    const r3 = await fetch(uploadUrl({ base: s.base, name: 'wire.bin', overwrite: true }), {
      method: 'POST',
      headers: { cookie: s.cookieFor('alice'), 'content-type': 'application/octet-stream' },
      body: fresh,
    });
    const b3 = await readResp(r3);
    assert.equal(b3.status, 200, b3.text);
    assert.deepEqual(b3.json, { path: 'wire.bin', bytes: fresh.length, overwritten: true });
    assert.equal(fs.readFileSync(path.join(s.proj, 'wire.bin'), 'utf8'), 'REPLACED');

    // 子目录：path 参数进 jail，DTO 带前缀。
    fs.mkdirSync(path.join(s.proj, 'sub'), { recursive: true });
    const r4 = await fetch(uploadUrl({ base: s.base, relPath: 'sub', name: 'in.txt' }), {
      method: 'POST',
      headers: { cookie: s.cookieFor('alice'), 'content-type': 'application/octet-stream' },
      body: Buffer.from('x'),
    });
    const b4 = await readResp(r4);
    assert.equal(b4.status, 201, b4.text);
    assert.equal(b4.json.path, `sub${path.sep}in.txt`);
    assert.deepEqual(remnants(s.proj), []);
  } finally {
    await s.close();
  }
});

test('0 字节 body（Content-Length: 0）⇒ 201 + 落一个 0 字节文件', async () => {
  const s = await startStack();
  try {
    const res = await fetch(uploadUrl({ base: s.base, name: 'zero' }), {
      method: 'POST',
      headers: { cookie: s.cookieFor('alice'), 'content-type': 'application/octet-stream' },
    });
    const r = await readResp(res);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.bytes, 0);
    assert.equal(fs.statSync(path.join(s.proj, 'zero')).size, 0);
  } finally {
    await s.close();
  }
});

test('超过 FILE_UPLOAD_MAX_BYTES ⇒ 413 file_too_large + details.max_bytes，且无 .tmp 残留', async () => {
  const s = await startStack({ config: { fileUploadMaxBytes: 4096 } });
  try {
    const res = await fetch(uploadUrl({ base: s.base, name: 'big.bin' }), {
      method: 'POST',
      headers: { cookie: s.cookieFor('alice'), 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(64 * 1024, 7),
    });
    const r = await readResp(res);
    assert.equal(r.status, 413, r.text);
    const env = r.json;
    assert.equal(env.error.code, 'file_too_large');
    assert.equal(env.error.details.max_bytes, 4096);
    assert.equal(fs.existsSync(path.join(s.proj, 'big.bin')), false);
    assert.ok(await waitFor(() => remnants(s.proj).length === 0), '超限之后不得留下 .tmp 残骸');

    // 上限是**这个端点**的：MAX_BODY_BYTES(64KiB) 不参与，否则任何真实上传都会 413。
    const ok = await fetch(uploadUrl({ base: s.base, name: 'small.bin' }), {
      method: 'POST',
      headers: { cookie: s.cookieFor('alice'), 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(2048, 7),
    });
    const okBody = await readResp(ok);
    assert.equal(okBody.status, 201, okBody.text);
  } finally {
    await s.close();
  }
});

test('B-11 线上断流（客户端发一半就 destroy）⇒ 不落盘、无 .tmp 残留、连接被关', async () => {
  const s = await startStack();
  try {
    const url = new URL(uploadUrl({ base: s.base, name: 'half.bin' }));
    const outcome = await new Promise((resolve) => {
      const req = http.request({
        host: url.hostname, port: url.port, path: url.pathname + url.search, method: 'POST',
        headers: { cookie: s.cookieFor('alice'), 'content-length': String(256 * 1024) },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ kind: 'response', status: res.statusCode, text }));
      });
      req.on('error', (e) => resolve({ kind: 'error', code: e.code }));
      req.write(Buffer.alloc(96 * 1024, 7));
      setTimeout(() => req.destroy(), 60); // 剩下 160KiB 永远不发
    });
    assert.ok(outcome.kind === 'error' || outcome.status === 400,
      `断流要么连接被关（客户端看到 error），要么看到 400 upload_interrupted；实际 ${JSON.stringify(outcome)}`);
    assert.ok(await waitFor(() => !fs.existsSync(path.join(s.proj, 'half.bin')) && remnants(s.proj).length === 0),
      '断流之后盘上必须干净：没有 target，也没有 .tmp');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// 鉴权与门
// ---------------------------------------------------------------------------

test('无会话 ⇒ 401 且不落盘；未分配工位 ⇒ 400 fde_name_required', async () => {
  const s = await startStack();
  try {
    const anon = await fetch(uploadUrl({ base: s.base, name: 'x.txt' }), { method: 'POST', body: Buffer.from('x') });
    assert.equal(anon.status, 401);
    assert.deepEqual(s.dirEntries(), []);

    const noSeat = await fetch(`${s.base}/api/files/upload?cwd=${encodeURIComponent('~/projects/demo')}&name=x.txt`, {
      method: 'POST',
      headers: { cookie: s.cookieFor('dave'), 'content-type': 'application/octet-stream' },
      body: Buffer.from('x'),
    });
    const ns = await readResp(noSeat);
    assert.equal(ns.status, 400, ns.text);
    assert.equal(ns.json.error.code, 'fde_name_required');
  } finally {
    await s.close();
  }
});

test('本端点**不进**受限会话清单：欠改密的会话撞门 403，且一个字节都不收', async () => {
  assert.equal(
    RESTRICTED_SESSION_ALLOWLIST.some((e) => e.path === '/api/files/upload'), false,
    '写端点进清单 = 欠改密的账号也能往自己磁盘写东西（#255 的语义漏口）',
  );
  const s = await startStack();
  const seen = watchRequestBodies(s.server);
  try {
    const res = await fetch(uploadUrl({ base: s.base, name: 'locked.txt' }), {
      method: 'POST',
      headers: { cookie: s.cookieFor('erin'), 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(32 * 1024, 7),
    });
    const r = await readResp(res);
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'password_change_required');
    assert.deepEqual(s.dirEntries(), []);
    const rec = seen.find((r) => r.url.startsWith('/api/files/upload'));
    assert.equal(rec.dataEventsAtResponse, 0, '受限会话门在 handler 之前，连 body 都不该碰');
  } finally {
    await s.close();
  }
});

test('#234 同源门覆盖写请求：跨站 POST 403 cross_origin_forbidden（不落盘）', async () => {
  const s = await startStack();
  try {
    const res = await fetch(uploadUrl({ base: s.base, name: 'csrf.txt' }), {
      method: 'POST',
      headers: { cookie: s.cookieFor('alice'), origin: 'https://evil.example' },
      body: Buffer.from('x'),
    });
    const r = await readResp(res);
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.error.code, 'cross_origin_forbidden');
    assert.deepEqual(s.dirEntries(), []);
  } finally {
    await s.close();
  }
});

test('GET /api/files/upload ⇒ 404（路由按 method+path 键控，与同族的 /api/files/tree 同一形状）；缺 name ⇒ 400 details.field=name', async () => {
  const s = await startStack();
  try {
    const wrong = await fetch(`${s.base}/api/files/upload?cwd=${encodeURIComponent('~/projects/demo')}&name=x`, {
      headers: { cookie: s.cookieFor('alice') },
    });
    const w = await readResp(wrong);
    // 404 而不是 405 是**本仓既有口径**：路由写成 `pathname === X && req.method === 'POST'`
    // ⇒ 方法不匹配就落到静态兜底的 404（`/api/files/tree` 的 POST 同形状）；405 只出现在
    // 「path 命中、handler 自己判方法」的端点（/api/me/password、/api/site）。不是本端点的新发明。
    assert.equal(w.status, 404, w.text);
    assert.equal(w.json.error.code, 'not_found');

    const noName = await fetch(`${s.base}/api/files/upload?cwd=${encodeURIComponent('~/projects/demo')}`, {
      method: 'POST',
      headers: { cookie: s.cookieFor('alice'), 'content-type': 'application/octet-stream' },
      body: Buffer.from('x'),
    });
    const nn = await readResp(noName);
    assert.equal(nn.status, 400, nn.text);
    assert.equal(nn.json.error.details.field, 'name');
    assert.deepEqual(remnants(s.proj), []);
  } finally {
    await s.close();
  }
});

test('越狱的 path 参数 ⇒ 与只读通道同一口径（400 validation_failed + details.field=path），不落盘', async () => {
  const s = await startStack();
  try {
    for (const relPath of ['..', '../../bob', '/etc', 'sub/../..']) {
      const res = await fetch(uploadUrl({ base: s.base, relPath, name: 'esc.txt' }), {
        method: 'POST',
        headers: { cookie: s.cookieFor('alice'), 'content-type': 'application/octet-stream' },
        body: Buffer.from('x'),
      });
      assert.equal(res.status, 400, `${relPath} 应当 400，实际 ${res.status}`);
      const env = await res.json();
      assert.equal(env.error.code, 'validation_failed');
      assert.equal(env.error.details.field, 'path');
    }
    assert.deepEqual(s.dirEntries(), []);
  } finally {
    await s.close();
  }
});
