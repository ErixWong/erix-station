// 单测：issue #803 S2-C——从 **HTTP 面** 钉住会话面（`portal/src/sessions.js` 的 `SessionError`）与
// 目录面（`portal/src/dirs.js` 的 `DirError`）经 `throw` 抛给客户端的错误文案「双语 + 错误体形状」。
// 仿 `http-messages-i18n.test.js`（S2-B）的起服务与两腿断言写法，并借 `http-upload.test.js` 的 tmp
// userspace + FakePool + 手工 session（内存 fake pool，不碰真实 DB / docker；docs/testing.md §2.1）。
//
// 每个 case 两腿：
//   · `Cookie: locale=en` ⇒ `error.message` **逐字**等于抛出点写的 `en`；
//   · 不带 locale cookie ⇒ **逐字**等于原中文（既有行为不破的钉子）。
// 另钉：错误体键集合不变（`code`/`message`/`retryable`，给了才有 `details`）、目录面的 `retryable`
// 语义不变（默认 false；`upload_interrupted` 仍 true）、`en` 不外泄。
//
// ⚠ 重复文案的红线（S2-B 踩过）：本文件的 8 类里 `title 必须为 ≤200 字符的字符串`（sessions.js 两处）、
//   `path 不得逃逸目录根` / `path 必须是目录` / `userSpaceRoot/fde_name 缺失`（dirs.js 各三处）都是**同文案多处抛**，
//   本片已把它们**全部**补了同一英文对，故任一腿无论命中哪一处都出英文——不留「删一处仍绿」的假象。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { DirError } from '../src/dirs.js';
import { FakePool } from './fake-pool.js';

const SELF_UID = process.getuid?.() ?? 1000;
const SELF_GID = process.getgid?.() ?? 1000;

// alice：有工位、开了上传（目录面的 3 个走真盘 + 上传占用用例）。
const FDE = {
  id: 'b0000000-0000-4000-8000-00000000000a', login: 'alice', display_name: 'Alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active', file_upload_enabled: true,
};
// root：没有 fde_name（目录面 `userSpaceRoot/fde_name 缺失` 用例；会话面的必填/形态类校验也在它身上触发）。
const NOFDE = {
  id: 'b0000000-0000-4000-8000-00000000000b', login: 'root', display_name: 'root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
};
const FDE_TOKEN = 'tok-s2c-fde';
const NOFDE_TOKEN = 'tok-s2c-nofde';
const SOME_UUID = '11111111-1111-4111-8111-111111111111';

async function startServer() {
  const userspace = fs.mkdtempSync(path.join(os.tmpdir(), 'station-s2c-userspace-'));
  const demo = path.join(userspace, 'alice', 'projects', 'demo');
  fs.mkdirSync(demo, { recursive: true });
  fs.writeFileSync(path.join(demo, 'hello.txt'), 'hi'); // D3（path 是文件）、D4（目标已存在）都要它
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-s2c-static-'));

  const pool = new FakePool({ users: [{ ...FDE }, { ...NOFDE }] });
  for (const [u, tok, id] of [[FDE, FDE_TOKEN, 'ls-fde'], [NOFDE, NOFDE_TOKEN, 'ls-nofde']]) {
    pool.sessions.push({
      id, user_id: u.id, token_hash: auth.hashToken(tok),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
  }
  const config = {
    cookie: cookieSettings('dev-s2c', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    loginRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 100, maxEntries: 10000 },
    kdfConcurrency: 2, kdfQueueLimit: 100, kdfQueueTimeoutMs: 30000,
    maxLoginLength: 128, maxPasswordLength: 256,
    totp: { issuer: 'erix-station-test', digits: 6, period: 30, window: 1 },
    dockerHost: 'tcp://127.0.0.1:1', staticDir,
    userSpaceRoot: userspace, fdeUid: SELF_UID, fdeGid: SELF_GID, fileUploadMaxBytes: 32 * 1024 * 1024,
  };
  const server = createServer({
    pool, config, docker: null,
    llmGateway: { async listCredentials() { return { credentials: [] }; }, async listModels() { return { data: [] }; } },
    log: { error: () => {}, warn: () => {}, log: () => {} },
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    fdeCookie: `${config.cookie.name}=${FDE_TOKEN}`,
    nofdeCookie: `${config.cookie.name}=${NOFDE_TOKEN}`,
    close: () => new Promise((res) => server.close(res)).finally(() => fs.rmSync(userspace, { recursive: true, force: true })),
  };
}

/** 一次请求：返回 {status, error}（error = 响应体 error 信封）。 */
async function hit(base, { method, p, cookie, ct = 'application/json', body }) {
  const headers = {};
  if (ct) headers['content-type'] = ct;
  if (cookie) headers['cookie'] = cookie;
  const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
  const res = await fetch(base + p, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON：留 null */ }
  return { status: res.status, error: json?.error };
}

/**
 * 8 类真能到达的抛出点（会话 4 + 目录 4）。`cookieOf(s)` 给出该用例要带的**基线会话 cookie**
 * （会话面走 alice、`userSpaceRoot/fde_name 缺失` 走 root）；locale 腿由测试外层拼。
 * zh/en 逐字抄自抛出点。`withDetails` 标记该用例错误体是否本就带 `details`（供键集合钉子复用）。
 */
const CASES = [
  {
    name: '会话·建会话：cwd 形态非法（validateSessionCwd）',
    cookieOf: (s) => s.fdeCookie,
    req: (cookie) => ({ method: 'POST', p: '/api/sessions', cookie, body: { project_id: 'bad' } }),
    zh: 'project_id（cwd）必须是 ~/projects/<name> 一级目录形式',
    en: 'project_id (cwd) must be a single-level directory of the form ~/projects/<name>',
  },
  {
    name: '会话·建会话：title 超过 200 字符（同文案另有 PATCH 一处，已一并补）',
    cookieOf: (s) => s.fdeCookie,
    req: (cookie) => ({ method: 'POST', p: '/api/sessions', cookie, body: { cwd: '~/projects/demo', title: 'x'.repeat(201) } }),
    zh: 'title 必须为 ≤200 字符的字符串',
    en: 'title must be a string of at most 200 characters',
  },
  {
    name: '会话·发消息：content 必填（唯一文案，负向自证取它）',
    cookieOf: (s) => s.fdeCookie,
    req: (cookie) => ({ method: 'POST', p: `/api/sessions/${SOME_UUID}/messages`, cookie, body: {} }),
    zh: 'content 必填且非空',
    en: 'content is required and must not be empty',
  },
  {
    name: '会话·发消息：attachments 非数组',
    cookieOf: (s) => s.fdeCookie,
    req: (cookie) => ({ method: 'POST', p: `/api/sessions/${SOME_UUID}/messages`, cookie, body: { content: 'x', attachments: 'nope' } }),
    zh: 'attachments 必须为数组',
    en: 'attachments must be an array',
  },
  {
    name: '目录·列目录：userSpaceRoot/fde_name 缺失（同文案另有两处，已一并补）',
    cookieOf: (s) => s.nofdeCookie,
    req: (cookie) => ({ method: 'GET', p: '/api/dirs', cookie, ct: null }),
    zh: 'userSpaceRoot/fde_name 缺失',
    en: 'userSpaceRoot/fde_name is missing',
  },
  {
    name: '目录·文件树：path 逃逸目录根（同文案另有两处，已一并补）',
    cookieOf: (s) => s.fdeCookie,
    req: (cookie) => ({ method: 'GET', p: '/api/files/tree?cwd=~/projects/demo&path=../escape', cookie, ct: null }),
    zh: 'path 不得逃逸目录根',
    en: 'path must not escape the directory root',
  },
  {
    name: '目录·文件树：path 是文件不是目录（同文案另有两处，已一并补）',
    cookieOf: (s) => s.fdeCookie,
    req: (cookie) => ({ method: 'GET', p: '/api/files/tree?cwd=~/projects/demo&path=hello.txt', cookie, ct: null }),
    zh: 'path 必须是目录',
    en: 'path must be a directory',
  },
  {
    name: '目录·上传：目标文件已存在（不覆盖）',
    cookieOf: (s) => s.fdeCookie,
    req: (cookie) => ({ method: 'POST', p: '/api/files/upload?cwd=~/projects/demo&path=.&name=hello.txt', cookie, ct: 'application/octet-stream', body: 'data' }),
    zh: '目标文件已存在',
    en: 'the target file already exists',
  },
];

test('会话/目录报错文案：locale=en 出英文逐字、缺省出中文逐字（8 类各两腿）', async () => {
  const s = await startServer();
  try {
    for (const c of CASES) {
      const baseCookie = c.cookieOf(s);
      const enCookie = `${baseCookie}; locale=en`;
      const zhCookie = baseCookie;

      const enRes = await hit(s.base, { ...c.req(enCookie), cookie: enCookie });
      assert.ok(enRes.error, `${c.name}：en 腿应返回 error 信封（实际 status=${enRes.status}）`);
      assert.equal(enRes.error.message, c.en, `${c.name}：en 腿文案逐字`);

      const zhRes = await hit(s.base, { ...c.req(zhCookie), cookie: zhCookie });
      assert.ok(zhRes.error, `${c.name}：zh 腿应返回 error 信封（实际 status=${zhRes.status}）`);
      assert.equal(zhRes.error.message, c.zh, `${c.name}：zh 腿文案逐字`);
    }
  } finally {
    await s.close();
  }
});

test('错误体键集合不变（code/message/retryable，给了才有 details）且 en 不外泄', async () => {
  const s = await startServer();
  try {
    // 无 details 的一条（`/api/dirs` 缺 fde_name ⇒ DirError internal 不带 details）：键集合恰为 {code,message,retryable}
    const noDetails = await hit(s.base, {
      method: 'GET', p: '/api/dirs', cookie: s.nofdeCookie, ct: null,
    });
    assert.ok(noDetails.error, 'noDetails 腿应返回 error 信封');
    assert.deepEqual(Object.keys(noDetails.error).sort(), ['code', 'message', 'retryable']);
    assert.ok(!('en' in noDetails.error), 'en 不得出现在错误体里（缺省腿）');

    // 有 details 的一条（path 逃逸目录根 ⇒ details.field='path'）：键集合恰为 {code,message,retryable,details}
    const withDetails = await hit(s.base, {
      method: 'GET', p: '/api/files/tree?cwd=~/projects/demo&path=../escape', cookie: s.fdeCookie, ct: null,
    });
    assert.ok(withDetails.error.details, '给了 details 就必须出现在错误体里');
    assert.deepEqual(Object.keys(withDetails.error).sort(), ['code', 'details', 'message', 'retryable']);

    // en 腿同样不外泄：键仍是那套，en 只是替了 message 的值
    const enLeg = await hit(s.base, {
      method: 'GET', p: '/api/files/tree?cwd=~/projects/demo&path=../escape', cookie: `${s.fdeCookie}; locale=en`, ct: null,
    });
    assert.equal(enLeg.error.message, 'path must not escape the directory root');
    assert.ok(!('en' in enLeg.error), 'en 不得出现在错误体里（en 腿）');
    assert.deepEqual(Object.keys(enLeg.error).sort(), ['code', 'details', 'message', 'retryable']);
  } finally {
    await s.close();
  }
});

test('目录面经 HTTP 出的错误 retryable 恒 false（非 upload_interrupted）', async () => {
  const s = await startServer();
  try {
    const probes = [
      { method: 'GET', p: '/api/dirs', cookie: s.nofdeCookie, ct: null },
      { method: 'GET', p: '/api/files/tree?cwd=~/projects/demo&path=../escape', cookie: s.fdeCookie, ct: null },
      { method: 'POST', p: '/api/files/upload?cwd=~/projects/demo&path=.&name=hello.txt', cookie: s.fdeCookie, ct: 'application/octet-stream', body: 'data' },
    ];
    for (const pr of probes) {
      const r = await hit(s.base, pr);
      assert.ok(r.error, `应返回错误信封：${pr.p}`);
      assert.equal(r.error.retryable, false, `${pr.p} 非 upload_interrupted ⇒ retryable 必须 false`);
    }
  } finally {
    await s.close();
  }
});

test('DirError retryable 语义未变：默认 false、仅显式 true；补 en 后 message 仍是中文、与 retryable 解耦', () => {
  // 默认形状（既有全部 DirError）逐字节不变 ⇒ retryable 恒 false。
  assert.equal(new DirError('file_too_large', '文件超过预览上限').retryable, false);
  // 只有 upload_interrupted 那条显式要 true；加 en 不改这一格，也不改中文原文。
  const e = new DirError(
    'upload_interrupted', '上传在传输完成前中断',
    { httpStatus: 400, retryable: true, en: 'the upload was interrupted before the transfer completed', details: { bytes: 1 } },
  );
  assert.equal(e.retryable, true, 'upload_interrupted 必须仍为 true');
  assert.equal(e.en, 'the upload was interrupted before the transfer completed');
  assert.equal(e.message, '上传在传输完成前中断', 'super(message) 仍传中文原文');
});
