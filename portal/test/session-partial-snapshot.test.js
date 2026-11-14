// issue #502 D-5（**形态 M**）：断线重连时「未完稿正文」的补发通路（SSE 侧的后端那一半）。
//
// 为什么单开一个文件：判据 4/5（补发衔接两个方向 + 内存丢失）的**前端**那一半在
// `portal/frontend/src/composables/useEventStream.spec.ts`（覆盖式赋值 / `roundSeq` 对账），
// **后端**那一半在这里：帧到底发不发、带不带 `roundSeq`、有没有污染 `Last-Event-ID`。
// 两侧分开承重是有意的：前端改了 dispatch 分支不会让这里的 gate 变绿，反之亦然。
//
// **形态 M 改了本文件的三条口径（每处理由写在改动点旁边）**：
//   ① **只有内存这一个来源**。旧版有「库里 `partial_output` 那一行」的回落（`source:'db'`），
//      形态 M 把终态正文写进了**既有的** `run_end.payload.partial_text` ⇒ 那一行不存在了，
//      回落分支连同它的行数上界一起删掉 ⇒ 原来断 `source:'db'` / 断「内存与库里都有 ⇒ 只发内存」
//      两条用例的**对象消失了**，改成断「内存空 ⇒ 一帧都不发（正文的事归历史投影）」。
//   ② **`uptoSeq` 闸门整条删除**（审计 B-2/B-3：碎片不落库就没有 seq 坐标系，拿已落库事件的最大
//      seq 与客户端 `Last-Event-ID` 硬比 = 两套坐标比大小，比赢漏发、比输重发）。判据从「服务端猜
//      水位线」换成「帧自带 `roundSeq`，前端拿自己观测到的 `round_start.seq` 对账」⇒ 原来那条
//      「`uptoSeq <= Last-Event-ID` ⇒ 不发」的用例**反转**成「水位线再高也照发，由前端判」。
//   ③ **占位帧搬到历史投影**（`session-partial-output.test.js`）：SSE 重连时前端本来就会重拉
//      history，两条通道各说一句就是同一件事说两遍 ⇒ 这里改成断「SSE 不再发占位」。
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
import { notifySessionEvents } from '../src/internal.js';
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
    this.sqlLog = [];       // 断言「重放 SQL 排除 partial_output」这类文本级事实
    // 审计第 1 条用得到的钩子：补发查询**跑的那一刻**回调（那正是「已注册、尚未转 live」的窗口）。
    this.onReplayQuery = null;
  }

  async query(sql, params = []) {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    this.sqlLog.push(flat);
    if (flat.includes('FROM chat_sessions s')) return { rows: [this.sessionRow] };
    if (flat.includes('FROM run_events') && flat.includes('seq >')) {
      // 钩子在返回行**之前**跑：模拟「补发查询进行中，另一批事件落库并推给了这个尚未 live 的客户端」。
      if (this.onReplayQuery) await this.onReplayQuery();
      return { rows: this.replayRows };
    }
    if (flat.includes('FROM runs r')) return { rows: [] };
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

/**
 * **客户端拼装的仿真**（审计第 1 条的尺）：按**到达顺序**把帧拼成界面上那一段正文。
 *
 * 两个语义不能舍：`assistant_delta` 是**追加**，`partial_output` 是**覆盖**（`useEventStream.ts`
 * 的 `case 'partial_output'` 写得很明白：「这一帧的语义是当前这段未完稿正文的全量」）。
 * 所以重复不是「两个帧看起来一样」，而是「快照已含全文后，同一批碎片又被当增量追了一遍」。
 * 轮闸（`roundSeq`）按本连接已观测到的轮号解开（= 前端对上了），不拿它掩盖顺序 bug。
 */
function assembleClientText(raw, { roundSeq } = {}) {
  let text = '';
  for (const f of framesOf(raw)) {
    if (f.event === 'assistant_delta') text += f.data?.text ?? '';
    else if (f.event === 'partial_output') {
      const frameSeq = typeof f.data?.roundSeq === 'number' ? f.data.roundSeq : null;
      if (roundSeq !== undefined && frameSeq !== roundSeq) continue; // 轮对不上 ⇒ 整帧丢弃
      text = f.data?.text ?? text;
    }
  }
  return text;
}

/**
 * 往进程内缓冲里喂碎片（真写路径的同一入口，`internal.js` 的写循环调的就是它）。
 * **形态 M 的改动**：先喂一条 `round_start`（带 `seq`）——正文槽位是按轮的，没有轮起点就没有
 * `roundSeq`，而 `roundSeq` 正是这一路唯一的对账凭据（不是旧版的 `uptoSeq`，见文件头 ②）。
 */
function feedDeltas(runId, texts, { startSeq = 3, round = 1 } = {}) {
  partialOutputs.observe(runId, {
    session_id: SESSION_ID, run_id: runId, type: 'round_start',
    client_event_id: `${runId}:1:0`, seq: startSeq - 1, payload: { round },
  });
  texts.forEach((text, i) => partialOutputs.observe(runId, {
    session_id: SESSION_ID, run_id: runId, type: 'assistant_delta',
    client_event_id: `${runId}:1:${startSeq + i}`, seq: null, payload: { text },
  }));
}

const reset = () => partialOutputs.clear();

test('#502 D-5：重连时内存里有未完稿正文 ⇒ 发一帧 source=memory 带 roundSeq，且**不带 id:**（不污染 Last-Event-ID）', async () => {
  const s = await startServer();
  try {
    reset();
    feedDeltas(RUN_ID, ['断线前', '流过的', '那半句']); // round_start 的 seq = 2
    const raw = await s.stream({ lastEventId: 1 });
    const parts = partialFrames(raw);
    assert.equal(parts.length, 1, `补发段应恰一条快照帧：${raw.slice(0, 300)}`);
    assert.equal(parts[0].id, null, '快照帧不许带 `id:`（浏览器会把它当 Last-Event-ID，下一轮重连就从没存在的 seq 起补）');
    assert.equal(parts[0].data.source, 'memory');
    assert.equal(parts[0].data.text, '断线前流过的那半句', '全量正文，不是增量');
    assert.equal(parts[0].data.run_id, RUN_ID);
    // 改写的旧断言：`uptoSeq: 6` ⇒ `roundSeq: 2`（形态 M 删了 uptoSeq，见文件头 ②；
    // 换断 `roundSeq` = 当前轮 `round_start` 自己的 seq，前端拿它与自己观测到的轮起点对账）。
    assert.equal(parts[0].data.roundSeq, 2, '`roundSeq` = 当前轮 `round_start` 的 seq（碎片自己不占号，所以只能带轮起点的号）');
    assert.equal(parts[0].data.round, 1);
    assert.equal(parts[0].data.chunks, 3);
    assert.ok(!('uptoSeq' in parts[0].data), `帧里不许再有 uptoSeq（那套坐标已删）：${JSON.stringify(parts[0].data)}`);
    // 重放 SQL 必须仍把那一行排除掉（形态 M 之后是**防御性**的：新代码不写它，但旧库有存量行，
    // 不排掉就是「一行真事件 + 一份快照」两套正文同屏 ⇒ 这条断言的**意图**（同一段正文只出现一次）
    // 与旧版完全一致，只是它防的对象从「两条活通路」变成「活通路 + 存量脏行」。
    const replaySql = s.pool.sqlLog.find((q) => q.includes('FROM run_events') && q.includes('seq >'));
    assert.match(replaySql, /type <> 'partial_output'/, `重放 SQL 未排除那一行：${replaySql}`);
  } finally {
    reset();
    await s.close();
  }
});

test('#502 M-4：Last-Event-ID 再高也照发 —— 闸门交给前端的 roundSeq 对账（不再由服务端猜水位线）', async () => {
  const s = await startServer();
  try {
    reset();
    feedDeltas(RUN_ID, ['还在写的一句']);
    // 旧版这里断的是「`uptoSeq <= Last-Event-ID` ⇒ 一条都不发」。形态 M 反过来：
    // 服务端**没有**可靠水位线可用（碎片不落库 ⇒ 没有 seq 坐标系），猜出来的水位线要么漏发
    // 要么重发；把「是不是我已经有了」交给唯一知道答案的一端（前端拿 roundSeq 对）。
    // 少发一帧的代价 = 界面上少一段还没写完的正文（刷新即回）；错发一帧的代价 = 重复正文（#300 头号坑），
    // 而后者现在由前端 roundSeq 不匹配 ⇒ 整帧丢弃来兜住（`useEventStream.spec.ts` 判据 4 承重）。
    // 9 = 夹具里会话的 `last_seq`（再大就 404 `last_event_id beyond session`，那是另一条口径）
    // ⇒ 水位线已经盖住整个会话，本帧照样发。
    const raw = await s.stream({ lastEventId: 9 });
    assert.equal(partialFrames(raw).length, 1, '内存里有未完稿正文就发，判据不在服务端');
  } finally {
    reset();
    await s.close();
  }
});

test('#502 判据 5（内存丢失）：内存空 ⇒ SSE 一帧都不发（终态正文归历史投影，不再回落读库）', async () => {
  const s = await startServer();
  try {
    reset(); // 模拟 portal 重启：缓冲空了
    // 旧版这里播 `partialRows`（库里那一行）并断 `source:'db'` + 截到 2000。形态 M 里
    // **那一行根本不存在**（终态正文在 `run_end.payload.partial_text`，已完成轮次在
    // `round_end.payload.final_text`，两者都由 `GET /events/history` 的投影取回，
    // 见 `session-partial-output.test.js` 的「两处都读」用例）⇒ 断的是「本通路不越界去库里拼一份
    // 看起来像流式的正文」：那会拿**已完成轮次的终稿**冒充「还在流的那一轮」。
    const raw = await s.stream({ lastEventId: 1 });
    assert.deepEqual(partialFrames(raw), [], `内存没东西就不许发帧（读库那一半归历史投影）：${raw.slice(0, 300)}`);
    assert.deepEqual(
      s.pool.sqlLog.filter((q) => q.includes('FROM run_events') && q.includes("type = 'partial_output'")),
      [], '补发通路不许再打「读那一行」的查询（回落分支已删 ⇒ 一次查询都不许多发）',
    );
  } finally {
    reset();
    await s.close();
  }
});

test('#502 M-4：已标终态的 run 不再发快照（正文已进 run_end.payload，再发一份就是重复正文）', async () => {
  const s = await startServer();
  try {
    reset();
    feedDeltas(RUN_ID, ['刚说完的半轮']);
    partialOutputs.markTerminal(RUN_ID); // 终态点的**唯一**缓冲动作（`internal.js#retirePartialBuffer`）
    const raw = await s.stream({ lastEventId: 1 });
    assert.deepEqual(partialFrames(raw), [], '终态 run 的候选资格必须收掉：否则刷新后历史一份 + 补发一份 = 两段正文');
  } finally {
    reset();
    await s.close();
  }
});

test('#502 M-4：SSE 不再发占位帧（占位搬到历史投影，两条通道不各说一句）', async () => {
  const s = await startServer();
  try {
    reset();
    // 断线窗口里那个 run 终态了（补发里有 `run_end`）；旧版这里出 `source:'none'` + `placeholder:true` 帧。
    s.pool.replayRows = [{
      seq: 5, run_id: RUN_ID, type: 'run_end',
      payload: { termination: { reason: 'aborted' } }, ts: new Date(),
    }];
    const raw = await s.stream({ lastEventId: 1 });
    assert.deepEqual(partialFrames(raw), [], '占位改由 GET /events/history 的投影给（#278 那条红线没动，只是换了通路）');
    // 补发的 `run_end` 帧自己带 id（可重放事件照旧进水位线）
    const end = framesOf(raw).find((f) => f.event === 'run_end');
    assert.equal(end.id, '5');
    // 占位不再需要锚点判据 ⇒ 补发通路也不许再打 `loadWindowRuns` 那条 runs 查询（省一次查询是净删）
    assert.deepEqual(s.pool.sqlLog.filter((q) => q.includes('FROM runs r')), [], '占位通路已删 ⇒ 不该再有 runs 窗口查询');
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

// ---------------------------------------------------------------------------
// 审计第 1 条（261114-05）：**重连时正文会重复一遍** —— 快照帧与 hub flush 的顺序承重。
//
// 复现的形状（这就是五组审计里那条【高】）：客户端断开后重连，`registerSessionClient` 先注册
// （此后落库/转发的事件进 `rec.buffer`），然后跑补发查询。**补发窗口内**到达的同轮碎片会：
//   ① 进进程内正文缓冲（`partialOutputs` 是它的写手）⇒ 于是**快照帧里已经有它**；
//   ② 同时进 `rec.buffer`，而 `sessionClientGoLive` 过滤 seq-less 帧的条件是
//      `ev.seq != null && ev.seq <= sinceSeq`（`internal.js` D-2 ①，碎片 `seq=null` 永不为真）
//      ⇒ **它照样被 flush 出去**。
// 于是「快照先、flush 后」= 界面上先把全量盖进气泡、再把同一批碎片当增量追一遍 ⇒ 重复一遗。
// 旧顺序在本用例里会红（拼出来是 `…补发期间到的补发期间到的`）；改后（先 flush、后快照）不红。
// ---------------------------------------------------------------------------
test('审计第 1 条：注册后、**补发窗口内**到达的同轮碎片不得把正文重复一遍（快照必须在 flush 之后）', async () => {
  const s = await startServer();
  try {
    reset();
    // 断线之前已经流过的半句（轮起点 seq = 2 ⇒ 客户端观测到的也是同一个 2）
    feedDeltas(RUN_ID, ['断线前']);
    const late = {
      session_id: SESSION_ID, run_id: RUN_ID, type: 'assistant_delta',
      client_event_id: `${RUN_ID}:1:99`, seq: null, payload: { text: '补发期间到的' },
    };
    // 钩子跑在「已注册、尚未 goLive」那个窗口里：这条碎片**同时**进正文缓冲与 hub 的 rec.buffer
    //（与 U3 写侧同一条顺序：先 `bufferTx.commit()` 再 `notifySessionEvents`）。
    s.pool.onReplayQuery = async () => {
      partialOutputs.observe(RUN_ID, late);
      notifySessionEvents(SESSION_ID, [{
        seq: null, ts: new Date().toISOString(), run_id: RUN_ID, type: 'assistant_delta', payload: { text: '补发期间到的' },
      }]);
    };
    const raw = await s.stream({ lastEventId: 1 });

    // ① 拼装面：同一段文字**只出现一次**（这就是「界面上看见的那一段」）
    const got = assembleClientText(raw, { roundSeq: 2 });
    assert.equal(got, '断线前补发期间到的',
      `客户端拼出来的正文（重复就是快照先、碎片后）：${JSON.stringify(got)}`);
    const fragCount = got.split('补发期间到的').length - 1;
    assert.equal(fragCount, 1, `那段碎片出现了 ${fragCount} 次（应为 1）：${JSON.stringify(got)}`);

    // ② 结构面：**所有** `partial_output` 帧都排在**最后一条** `assistant_delta` 之后
    //（覆盖式语义只能排在追加式之后；反过来就是这一条 bug 的形状）。
    const evs = framesOf(raw).map((f) => f.event);
    const lastDelta = evs.lastIndexOf('assistant_delta');
    const firstPartial = evs.indexOf('partial_output');
    assert.ok(lastDelta >= 0 && firstPartial >= 0, `夹具没跑起来：${JSON.stringify(evs)}`);
    assert.ok(firstPartial > lastDelta,
      `快照帧必须排在碎片之后（覆盖式不能排在追加式前面）：顺序=${JSON.stringify(evs)}`);
    // 碎片本身仍然发了（D-2 ① 那条红线没被这次修复弄回去：碎片**不许**被 sinceSeq 过滤掉）
    assert.equal(partialFrames(raw).length, 1, '快照仍只有一条（本轮就一段未完稿正文）');
  } finally {
    reset();
    await s.close();
  }
});
