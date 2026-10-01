// HTTP/会话层测试（无真实 DB）：
//   F3 —— sessions.validateMessageBody 纯函数（幂等占位前的体校验口径）；
//   F4 —— handleSessionStream 在 registerSessionClient 之后**立即**安装 cleanup：
//         补发（DB 查询）期间客户端断开也必须把 rec 从 hub 摘除（否则 rec 永久泄漏 + 心跳常驻）；
//   F5 —— 路由分发的 session id 归一化为小写：用**大写** UUID 连上的客户端必须收到
//         以 DB（小写）id 为 key 推送的实时事件（否则 SSE hub key 大小写不一致 → 永远收不到事件）。
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool，不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import * as internal from '../src/internal.js';
import { SessionError, MAX_MESSAGE_CONTENT_LENGTH, validateMessageBody } from '../src/sessions.js';
import { FakePool } from './fake-pool.js';

// ---------------------------------------------------------------------------
// F3：validateMessageBody（纯函数）
// ---------------------------------------------------------------------------

test('F3 validateMessageBody：合法体 → 返回 {content, attachments}（元素裁剪为 {kind,path,name}）', () => {
  assert.deepEqual(validateMessageBody({ content: ' hi ' }), { content: ' hi ', attachments: [] });
  assert.deepEqual(
    validateMessageBody({ content: 'hi', attachments: [{ kind: 'file', path: '/a.txt', name: 'a.txt', size: 9, ui_id: 'z' }] }),
    { content: 'hi', attachments: [{ kind: 'file', path: '/a.txt', name: 'a.txt' }] },
    '多送的 UI 字段被裁掉（既不落库也不参与幂等 hash）',
  );
  assert.deepEqual(
    validateMessageBody({ content: 'hi', attachments: [{ kind: 'image', path: '/b.png' }] }),
    { content: 'hi', attachments: [{ kind: 'image', path: '/b.png' }] },
  );
});

test('F3 validateMessageBody：非法体 → 400 validation_failed（field 与文案同 §4.3）', () => {
  const cases = [
    [{}, 'content'],
    [{ content: '' }, 'content'],
    [{ content: '   ' }, 'content'],
    [{ content: 123 }, 'content'],
    [{ content: 'x'.repeat(MAX_MESSAGE_CONTENT_LENGTH + 1) }, 'content'],
    [{ content: 'ok', attachments: 'nope' }, 'attachments'],
    [{ content: 'ok', attachments: [null] }, 'attachments'],
    [{ content: 'ok', attachments: [{ kind: 'dir', path: '/a' }] }, 'attachments'],
    [{ content: 'ok', attachments: [{ kind: 'file', path: '' }] }, 'attachments'],
    [{ content: 'ok', attachments: [{ kind: 'file' }] }, 'attachments'],
  ];
  for (const [body, field] of cases) {
    assert.throws(
      () => validateMessageBody(body),
      (e) => e instanceof SessionError && e.httpStatus === 400 && e.code === 'validation_failed' && e.details?.field === field,
      `应拒绝：${JSON.stringify(body)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// F4 / F5：真实 HTTP + SSE（内存 pool）
// ---------------------------------------------------------------------------

const USER = {
  id: '00000000-0000-4000-8000-0000000000a1', login: 'alice', display_name: 'alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const SESSION_ID = 'a1b2c3d4-1111-4111-8111-abcdefabcdef';
const TOKEN = 'tok-session-http-test';

/** 内存 pool：登录会话（复用 FakePool）+ chat_sessions/run_events 补发查询（可挂起）。 */
class SessionSsePool extends FakePool {
  constructor() {
    super({ users: [USER] });
    this.sessions.push({
      id: 'ls1', user_id: USER.id, token_hash: auth.hashToken(TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
    this.sessionRow = {
      id: SESSION_ID, user_id: USER.id, project_id: 'p1', title: 't', model: null,
      status: 'active', last_seq: 5, project_name: 'proj1',
    };
    this.replayGate = null; // 非 null → 补发查询挂起（模拟慢查询/大补发窗口）
  }

  async query(sql, params = []) {
    if (sql.includes('FROM chat_sessions s')) return { rows: [this.sessionRow] };
    // issue #107：PATCH /api/sessions/:id 的落库（updateSession 的 UPDATE ... RETURNING）；
    // 与真实 DB 同语义：title 改写 + title_source 置 'manual'（手工优先守卫，issue #88）。
    if (sql.startsWith('UPDATE chat_sessions') && sql.includes("title_source = 'manual'")) {
      this.sessionRow.title = params[1];
      this.sessionRow.title_source = 'manual';
      return { rows: [{ ...this.sessionRow, cwd: '~/projects/a', updated_at: new Date(), created_at: new Date() }] };
    }
    if (sql.includes('FROM messages')) return { rows: [] };
    if (sql.includes('FROM runs')) return { rows: [] };
    if (sql.includes('FROM run_events')) {
      if (this.replayGate) await this.replayGate;
      return { rows: [] };
    }
    return super.query(sql, params);
  }
}

async function startServer() {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-sse-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, perTokenMaxFailures: 5, maxEntries: 10000 },
    kdfConcurrency: 2,
    kdfQueueLimit: 100,
    kdfQueueTimeoutMs: 30000,
    maxBodyBytes: 64 * 1024,
    maxLoginLength: 128,
    maxPasswordLength: 256,
    staticDir,
  };
  const pool = new SessionSsePool();
  const server = createServer({ pool, config });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    pool,
    base,
    cookieHeader: `${config.cookie.name}=${TOKEN}`,
    close: async () => { await new Promise((res) => server.close(res)); fs.rmSync(staticDir, { recursive: true, force: true }); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到谓词为真（超时即失败）。 */
async function waitUntil(predicate, { label, timeoutMs = 5000, intervalMs = 10 }) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  assert.fail(`timeout: ${label}（${timeoutMs}ms）`);
}

/** 从 SSE 流里读帧，直到谓词满足（返回已读文本；达条件后取消读取 → 关闭连接）。 */
async function readSseUntil(res, predicate, { label, timeoutMs = 5000 } = {}) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        sleep(deadline - Date.now()).then(() => { throw new Error(`SSE 超时：${label}\n已读=${JSON.stringify(buf)}`); }),
      ]);
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      if (predicate(buf)) return buf;
    }
  } finally {
    await reader.cancel().catch(() => {}); // 关连接（服务端 res 'close' → hub 摘除）
    reader.releaseLock?.();
  }
  assert.fail(`SSE 未达条件：${label}\n已读=${JSON.stringify(buf)}`);
}

test('F4：补发（DB 查询）期间客户端断开 → rec 立即从 session hub 摘除（不泄漏）', async () => {
  const s = await startServer();
  const ac = new AbortController();
  let releaseReplay;
  s.pool.replayGate = new Promise((r) => { releaseReplay = r; });
  try {
    assert.equal(internal.hubStats().sessionClients, 0);
    const res = await fetch(`${s.base}/api/sessions/${SESSION_ID}/events?last_event_id=1`, {
      headers: { Cookie: s.cookieHeader, Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    assert.equal(res.status, 200, 'SSE 连接 200');
    // 补发查询被挂起（仍在 handleSessionStream 的 await 中）→ rec 已注册
    await waitUntil(() => internal.hubStats().sessionClients === 1, { label: 'SSE 客户端已注册' });

    ac.abort(); // 客户端在补发窗口内断开
    await waitUntil(() => internal.hubStats().sessionClients === 0, { label: '断开后 rec 被摘除' });

    releaseReplay(); // 补发查询此刻才返回：handler 不得再写帧、不得把 rec 复活
    await sleep(30);
    assert.equal(internal.hubStats().sessionClients, 0, '补发返回后仍无残留 rec');
  } finally {
    s.pool.replayGate = null;
    typeof releaseReplay === 'function' && releaseReplay();
    await s.close();
  }
});

test('F4：正常连接在断开后同样摘除 rec（once 守卫，重复 cleanup 不报错）', async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/api/sessions/${SESSION_ID}/events`, {
      headers: { Cookie: s.cookieHeader, Accept: 'text/event-stream' },
    });
    assert.equal(res.status, 200);
    await readSseUntil(res, (t) => t.includes('event: ping'), { label: '首个 ping' }); // 首连不补发历史
    await waitUntil(() => internal.hubStats().sessionClients === 0, { label: '断开后 rec 被摘除' });
    // 再次向同一 session 推事件：rec 已摘除 → 不抛错、不复活
    internal.notifySessionEvents(SESSION_ID, [{ seq: 9, ts: '2026-09-12T00:00:00.000Z', run_id: 'r1', type: 'ping', payload: {} }]);
    assert.equal(internal.hubStats().sessionClients, 0);
  } finally {
    await s.close();
  }
});

test('F5：大写 UUID 路径的 session id 归一化为小写（SSE hub key 对齐 DB，实时事件可达）', async () => {
  const s = await startServer();
  try {
    assert.equal(SESSION_ID, SESSION_ID.toLowerCase(), '样本 id 本身是小写（DB 回读形态）');
    const upperPath = `/api/sessions/${SESSION_ID.toUpperCase()}/events`;
    assert.notEqual(upperPath, `/api/sessions/${SESSION_ID}/events`, '样本路径确实是大写形态');
    const res = await fetch(`${s.base}${upperPath}`, {
      headers: { Cookie: s.cookieHeader, Accept: 'text/event-stream' },
    });
    assert.equal(res.status, 200, '大写路径同样 200（UUID 大小写等价）');
    // 等到 ping（写在 goLive 之后）→ 该客户端已完成注册并转 live
    await waitUntil(() => internal.hubStats().sessionClients === 1, { label: 'SSE 客户端已注册' });
    const reading = readSseUntil(res, (t) => t.includes('assistant_delta'), { label: '实时事件' });

    // 宿主侧推送用的是 DB 回读的**小写** session id（run_events.session_id）
    internal.notifySessionEvents(SESSION_ID, [{
      seq: 6, ts: '2026-09-12T00:00:00.000Z', run_id: 'r1', type: 'assistant_delta', payload: { text: 'hi' },
    }]);
    const text = await reading;
    assert.ok(text.includes('assistant_delta'), `小写 key 推送的大写路径客户端能收到：${JSON.stringify(text)}`);
    assert.ok(text.includes('id: 6'), '帧带 seq');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// issue #107：PATCH /api/sessions/:id 成功 → 推 `session_updated`（手工改名多标签页同步）
// ---------------------------------------------------------------------------

test('issue #107：PATCH 改名成功后推 session_updated（live-only 帧，payload.title = 新标题）', async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/api/sessions/${SESSION_ID}/events`, {
      headers: { Cookie: s.cookieHeader, Accept: 'text/event-stream' },
    });
    assert.equal(res.status, 200, 'SSE 连接 200');
    await waitUntil(() => internal.hubStats().sessionClients === 1, { label: 'SSE 客户端已注册' });
    // 读帧直到第一条 session_updated（连接已注册；未 live 时事件进缓冲，flush 后同样到达）
    const reading = readSseUntil(res, (t) => t.includes('session_updated'), { label: 'session_updated 帧' });

    // 先发一条**超长**（>200）标题：必须 400 且**不推**任何帧（notify 只在落库成功后发生）
    const tooLong = '不该出现'.repeat(60);
    const bad = await fetch(`${s.base}/api/sessions/${SESSION_ID}`, {
      method: 'PATCH',
      headers: { Cookie: s.cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: tooLong }),
    });
    assert.equal(bad.status, 400, '超 200 字符 → 400 validation_failed');
    assert.equal((await bad.json()).error.code, 'validation_failed');

    const okRes = await fetch(`${s.base}/api/sessions/${SESSION_ID}`, {
      method: 'PATCH',
      headers: { Cookie: s.cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '  手工改的名  ' }), // 原样落库（trim 是前端职责，后端只校验长度）
    });
    assert.equal(okRes.status, 200);
    const body = await okRes.json();
    assert.equal(body.session.title, '  手工改的名  ');
    assert.equal(body.session.title_source, 'manual', '手工改名置 title_source=manual（#88 守卫闭环）');

    const text = await reading;
    // 首条 session_updated 携带的就是成功那次的新标题：证明 400 那次没有推帧
    assert.ok(text.includes('"title":"  手工改的名  "'), `session_updated 携带新标题：${JSON.stringify(text)}`);
    assert.ok(!text.includes('不该出现'), '校验失败（400）不得推 session_updated');
    assert.ok(text.includes('event: session_updated'), '帧名 = session_updated');
    assert.ok(!text.includes('id:'), 'live-only 帧不带 seq（不进消息流水位线）');
  } finally {
    await s.close();
  }
});
