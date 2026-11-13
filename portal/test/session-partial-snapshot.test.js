// issue #502 D-5：断线重连时「未完稿正文」的补发通路（SSE 侧的后端那一半）。
//
// 为什么单开一个文件：判据 4/5（补发衔接两个方向 + 内存丢失）的**前端**那一半在
// `portal/frontend/src/composables/useEventStream.spec.ts`（覆盖式赋值 / 占位提示 / 不推水位线），
// **后端**那一半在这里：帧到底发不发、发的是内存还是库里那一行、有没有污染 `Last-Event-ID`。
// 两侧分开承重是有意的：前端改了 dispatch 分支不会让这里的 gate 变绿，反之亦然。
//
// 隔离（docs/testing.md §2.1）：注入内存 fake pool，不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { partialOutputs } from '../src/run-partial-buffer.js';
import { FakePool } from './fake-pool.js';

const USER = {
  id: '00000000-0000-4000-8000-0000000000a1', login: 'alice', display_name: 'alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const SESSION_ID = 'a1b2c3d4-1111-4111-8111-abcdefabcdef';
const RUN_ID = 'r-502-snapshot';
const TOKEN = 'tok-partial-snapshot-test';

class SnapshotPool extends FakePool {
  constructor() {
    super({ users: [USER] });
    this.sessions.push({
      id: 'ls1', user_id: USER.id, token_hash: auth.hashToken(TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
    this.sessionRow = {
      id: SESSION_ID, user_id: USER.id, project_id: 'p1', title: 't', model: null,
      status: 'active', last_seq: 9, project_name: 'proj1',
    };
    this.replayRows = [];   // 补发查询（durable 档）返回的行
    this.partialRows = [];  // `type = 'partial_output'` 那一行
    this.windowRuns = [];   // `loadWindowRuns` 的返回（占位判据用）
    this.sqlLog = [];       // 断言「重放 SQL 排除 partial_output」这类文本级事实
  }

  async query(sql, params = []) {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    this.sqlLog.push(flat);
    if (flat.includes('FROM chat_sessions s')) return { rows: [this.sessionRow] };
    // ⚠ 顺序要紧：`partial_output` 那条查询里也有 `FROM run_events`，先分派它。
    if (flat.includes('FROM run_events') && flat.includes("type = 'partial_output'")) {
      return { rows: this.partialRows };
    }
    if (flat.includes('FROM run_events') && flat.includes('seq >')) return { rows: this.replayRows };
    if (flat.includes('FROM runs r')) return { rows: this.windowRuns };
    if (flat.includes('FROM messages')) return { rows: [] };
    if (flat.includes('FROM runs')) return { rows: [] };
    return super.query(sql, params);
  }
}

async function startServer() {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-snap-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800, sessionRenewIntervalSeconds: 3600, pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 5, maxEntries: 100 },
    kdfConcurrency: 2, kdfQueueLimit: 10, kdfQueueTimeoutMs: 5000,
    maxBodyBytes: 64 * 1024, maxLoginLength: 128, maxPasswordLength: 256, staticDir,
  };
  const pool = new SnapshotPool();
  const server = createServer({ pool, config });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    pool, base,
    cookieHeader: `${config.cookie.name}=${TOKEN}`,
    // 连 SSE 并把帧读干净（服务端 goLive 之后必发一帧 `event: ping` ⇒ 拿它当「补发段结束」的信号）
    stream: async ({ lastEventId, waitFor = 'event: ping', label = '补发段结束' } = {}) => {
      const q = lastEventId == null ? '' : `?last_event_id=${lastEventId}`;
      const res = await fetch(`${base}/api/sessions/${SESSION_ID}/events${q}`, {
        headers: { Cookie: `${config.cookie.name}=${TOKEN}`, Accept: 'text/event-stream' },
      });
      assert.equal(res.status, 200);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const deadline = Date.now() + 5000;
      try {
        while (Date.now() < deadline) {
          const left = deadline - Date.now();
          const race = await Promise.race([
            reader.read(),
            new Promise((r) => setTimeout(() => r('timeout'), Math.max(left, 1))),
          ]);
          if (race === 'timeout') break;
          if (race.done) break;
          buf += dec.decode(race.value, { stream: true });
          if (buf.includes(waitFor)) break;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock?.();
      }
      assert.ok(buf.includes(waitFor), `SSE 未达条件 ${label}：已读=${JSON.stringify(buf.slice(0, 400))}`);
      return buf;
    },
    close: async () => { await new Promise((res) => server.close(res)); fs.rmSync(staticDir, { recursive: true, force: true }); },
  };
}

/** 把 SSE 文本拆成 `[{event, id, data}]`（自己拆，不用第三方解析器）。 */
function framesOf(raw) {
  return raw.split('\n\n').filter((b) => b.includes('event:')).map((block) => {
    const event = /event: (\S+)/.exec(block)?.[1] ?? null;
    const id = /^id: (.*)$/m.exec(block)?.[1] ?? null;
    const data = /data: (.*)/.exec(block)?.[1] ?? null;
    return { event, id, data: data ? JSON.parse(data) : null };
  });
}
const partialFrames = (raw) => framesOf(raw).filter((f) => f.event === 'partial_output');

/** 往进程内累加器里喂碎片（真写路径的同一入口，`internal.js` 的写循环调的就是它）。 */
function feedDeltas(runId, texts, { startSeq = 3 } = {}) {
  texts.forEach((text, i) => partialOutputs.observe(runId, {
    session_id: SESSION_ID, run_id: runId, type: 'assistant_delta',
    client_event_id: `${runId}:1:${startSeq + i}`, seq: null, payload: { text },
  }));
  //  durable 事件（`round_end`）推进 `uptoSeq`：快照的「已看到哪里」只认落库的那些
  partialOutputs.observe(runId, {
    session_id: SESSION_ID, run_id: runId, type: 'round_end',
    client_event_id: `${runId}:1:900`, seq: startSeq + texts.length, payload: { round: 1 },
  });
}

const reset = () => partialOutputs.clear();

test('#502 D-5：重连时内存里有未完稿正文 ⇒ 发一帧 source=memory，且**不带 id:**（不污染 Last-Event-ID）', async () => {
  const s = await startServer();
  try {
    reset();
    feedDeltas(RUN_ID, ['断线前', '流过的', '那半句']);
    const raw = await s.stream({ lastEventId: 1 });
    const parts = partialFrames(raw);
    assert.equal(parts.length, 1, `补发段应恰一条快照帧：${raw.slice(0, 300)}`);
    assert.equal(parts[0].id, null, '快照帧不许带 `id:`（浏览器会把它当 Last-Event-ID，下一轮重连就从没存在的 seq 起补）');
    assert.equal(parts[0].data.source, 'memory');
    assert.equal(parts[0].data.text, '断线前流过的那半句', '全量正文，不是增量');
    assert.equal(parts[0].data.run_id, RUN_ID);
    assert.equal(parts[0].data.uptoSeq, 6, '`uptoSeq` = 已落库事件的最大 seq（碎片自己不占号）');
    assert.equal(parts[0].data.chunks, 3);
    // 重放 SQL 必须把那一行排除掉（否则「重放一行 + 快照一行」= 同一段正文两个帧）
    const replaySql = s.pool.sqlLog.find((q) => q.includes('FROM run_events') && q.includes('seq >'));
    assert.match(replaySql, /type <> 'partial_output'/, `重放 SQL 未排除那一行：${replaySql}`);
  } finally {
    reset();
    await s.close();
  }
});

test('#502 判据 4（不重复的方向）：uptoSeq <= Last-Event-ID ⇒ 客户端已看全，一条快照都不发', async () => {
  const s = await startServer();
  try {
    reset();
    feedDeltas(RUN_ID, ['早就说完的一句']);
    const upto = partialOutputs.snapshot(RUN_ID).uptoSeq; // = 4
    const raw = await s.stream({ lastEventId: upto });
    assert.deepEqual(partialFrames(raw), [], `水位线已到 ⇒ 再发一遍就是重复：${raw.slice(0, 300)}`);
  } finally {
    reset();
    await s.close();
  }
});

test('#502 判据 5（内存丢失）：内存空、库里有那一行 ⇒ source=db 回落（并按展示窗口截断）', async () => {
  const s = await startServer();
  try {
    reset(); // 模拟 portal 重启：累加器空了
    s.pool.partialRows = [{
      run_id: RUN_ID, seq: 8,
      payload: { text: 'x'.repeat(2500), reasoning: '', uptoSeq: 8, chunks: 60, truncated: false, source: 'terminal' },
    }];
    const raw = await s.stream({ lastEventId: 1 });
    const parts = partialFrames(raw);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].data.source, 'db');
    assert.equal(parts[0].data.text.length, 2000, '库里那一行可能比展示窗口长 ⇒ 截断仍由读侧统一拿笔');
    assert.equal(parts[0].data.truncated, true, '截断过就必须谎报得了：truncated 要置真');
    assert.equal(parts[0].id, null);
  } finally {
    reset();
    await s.close();
  }
});

test('#502：同一 run 内存与库里都有 ⇒ 只发内存那一份（两份正文是同一段，发两遍就是重复）', async () => {
  const s = await startServer();
  try {
    reset();
    feedDeltas(RUN_ID, ['内存里的更新一份']);
    s.pool.partialRows = [{
      run_id: RUN_ID, seq: 8,
      payload: { text: '库里那份旧一点的', reasoning: '', uptoSeq: 8, chunks: 2, truncated: false, source: 'terminal' },
    }];
    const raw = await s.stream({ lastEventId: 1 });
    const parts = partialFrames(raw);
    assert.equal(parts.length, 1, `同一 run 至多一帧：${JSON.stringify(parts.map((p) => p.data.source))}`);
    assert.equal(parts[0].data.source, 'memory');
    assert.equal(parts[0].data.text, '内存里的更新一份');
  } finally {
    reset();
    await s.close();
  }
});

test('#502 判据 5 的另一半 + #278 底线：内存与库都没有 ⇒ 出**占位帧**，不是空白', async () => {
  const s = await startServer();
  try {
    reset();
    // 断线窗口里那个 run 终态了（补发里有 `run_end`），且没有 assistant 锚点
    s.pool.replayRows = [{
      seq: 5, run_id: RUN_ID, type: 'run_end',
      payload: { termination: { reason: 'aborted' } }, ts: new Date(),
    }];
    s.pool.windowRuns = [{ run_id: RUN_ID, status: 'failed', has_anchor: false, last_seq: 5 }];
    const raw = await s.stream({ lastEventId: 1 });
    const parts = partialFrames(raw);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].data.source, 'none');
    assert.equal(parts[0].data.placeholder, true, '占位标记必须给（前端据此出中性提示，而不是挂一个空气泡）');
    assert.equal(parts[0].data.text, '');
    assert.equal(parts[0].data.uptoSeq, null);
    // 补发的 `run_end` 帧自己带 id（可重放事件照旧进水位线）
    const end = framesOf(raw).find((f) => f.event === 'run_end');
    assert.equal(end.id, '5');
  } finally {
    reset();
    await s.close();
  }
});

test('#502：有 assistant 锚点 ⇒ 不出占位（正文在 messages 那条路上，再出一行就是重复正文）', async () => {
  const s = await startServer();
  try {
    reset();
    s.pool.replayRows = [{ seq: 5, run_id: RUN_ID, type: 'run_end', payload: {}, ts: new Date() }];
    s.pool.windowRuns = [{ run_id: RUN_ID, status: 'finished', has_anchor: true, last_seq: 5 }];
    const raw = await s.stream({ lastEventId: 1 });
    assert.deepEqual(partialFrames(raw), []);
  } finally {
    reset();
    await s.close();
  }
});

test('#502：首连（无 Last-Event-ID）仍然一条历史都不补发 —— 快照帧也不例外', async () => {
  const s = await startServer();
  try {
    reset();
    feedDeltas(RUN_ID, ['正在写的正文']);
    const raw = await s.stream({ lastEventId: null });
    assert.deepEqual(partialFrames(raw), [], '首连不补发是 §5.2.3 的红线，#502 没动它');
    assert.ok(raw.includes(': connected'), '首连只有 `connected` 注释 + ping');
  } finally {
    reset();
    await s.close();
  }
});
