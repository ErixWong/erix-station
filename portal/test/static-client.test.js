// 单测：前端 SSE 客户端逻辑（portal/static/index.html 内联脚本）——跳号检测 / resync 监听 /
// 带 last_event_id 重连 / run_end 状态机守卫不被破坏（portal.md §5.1/§5.2）。
// 前端无构建步骤与模块导出，故用最小 DOM/EventSource/fetch 桩 + node:vm 在进程内直接驱动
// handleEvent / connectEvents（零额外依赖，不起浏览器）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const INDEX_HTML = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../static/index.html');

/** EventSource 桩：记录 URL/是否 close，并可手动投递具名事件帧。 */
class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.listeners = new Map();
    this.onerror = null;
    this.onmessage = null;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    const set = this.listeners.get(type) ?? [];
    set.push(fn);
    this.listeners.set(type, set);
  }
  close() { this.closed = true; }
  emit(type, data) {
    const frame = { data: typeof data === 'string' ? data : JSON.stringify(data) };
    for (const fn of this.listeners.get(type) ?? []) fn(frame);
  }
}

function makeEl() {
  return {
    style: {}, dataset: {}, textContent: '', innerHTML: '', value: '', disabled: false,
    scrollTop: 0, scrollHeight: 0,
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild() {}, remove() {},
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    addEventListener() {},
    focus() {}, reset() {},
  };
}

/** 载入 index.html 的内联脚本（桩化 document/EventSource/fetch），导出测试需要的内部绑定。 */
function loadClient({ fetch: fetchImpl } = {}) {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'index.html 应含单个内联脚本');
  const els = new Map();
  const created = []; // sep()/msg 等 createElement 产物（断言渲染文本用）
  const document = {
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); },
    createElement() { const el = makeEl(); created.push(el); return el; },
  };
  const sandbox = {
    document,
    EventSource: FakeEventSource,
    fetch: fetchImpl ?? (async () => { throw new Error('fetch 在单测中禁用'); }), // boot() 走 renderLogin 分支
    location: { reload() {} },
    alert() {}, prompt() { return null; },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  const ctx = vm.createContext(sandbox);
  // 顶层 const/let 不进 globalThis，用同脚本片段把内部绑定导出给测试驱动
  const code = `${m[1]}\n;globalThis.__client = { S, handleEvent, connectEvents, resyncEvents, switchProject, openSession, initWorkspace };`;
  new vm.Script(code).runInContext(ctx);
  FakeEventSource.instances = [];
  return { client: ctx.__client, elements: els, created };
}

/** 构造事件载荷（emit 会自行包成 SSE 帧）；带 seq + run_id 的典型事件。 */
const evt = (seq, extra = {}) => ({ seq, run_id: 'run-1', ts: '2026-09-12T00:00:00.000Z', ...extra });

test('前端：首连不补发历史（URL 无 last_event_id）', () => {
  const { client } = loadClient();
  client.S.sessionId = 'sess-1';
  client.connectEvents('sess-1');
  assert.equal(FakeEventSource.instances.length, 1);
  assert.equal(FakeEventSource.instances[0].url, '/api/sessions/sess-1/events');
});

test('前端：seq 跳号**不**触发重连（事件流有合法空洞：messages 与 run_events 共用 seq 分配器）', () => {
  // 裁决依据（issue #25 B.3，(a) 口径）：事件流单独看存在合法空洞（user 消息/assistant 回写占号），
  // 以跳号作为重连触发条件会无限重连（实测复现）；丢失恢复靠自动重连（Last-Event-ID）+ 服务端 resync。
  const { client } = loadClient();
  const { S } = client;
  S.sessionId = 'sess-1'; S.esSessionId = 'sess-1'; S.lastSeq = 1; S.activeRunId = 'run-1';
  client.connectEvents('sess-1');
  const es1 = FakeEventSource.instances.at(-1);

  for (const seq of [2, 3, 4]) es1.emit('assistant_delta', evt(seq, { text: 'x' }));
  assert.equal(S.lastSeq, 4);
  assert.equal(FakeEventSource.instances.length, 1);

  es1.emit('run_end', evt(6, { run_id: 'run-1', termination: { reason: 'end_turn' } })); // 5 = assistant 回写占号
  assert.equal(FakeEventSource.instances.length, 1, '跳号不重连（不风暴）');
  assert.equal(es1.closed, false);
  assert.equal(S.lastSeq, 6, '水位线照常推进');

  // 陈旧连接的在途帧仍被忽略
  es1.emit('assistant_delta', evt(20, { text: 'stale' }));
  client.connectEvents('sess-1');
  const es2 = FakeEventSource.instances.at(-1);
  es1.emit('assistant_delta', evt(30, { text: 'stale-2' }));
  assert.equal(S.lastSeq, 20, '旧连接帧不再推进水位线');
  es2.emit('assistant_delta', evt(21, { text: 'new' }));
  assert.equal(S.lastSeq, 21);
});

test('前端：resync 控制帧（服务端缓冲溢出）→ close + 带 last_event_id 重连', () => {
  const { client } = loadClient();
  const { S } = client;
  S.sessionId = 'sess-2'; S.esSessionId = 'sess-2'; S.lastSeq = 7;
  client.connectEvents('sess-2');
  const es1 = FakeEventSource.instances.at(-1);

  es1.emit('resync', { reason: 'buffer_overflow', last_seq: 7 });
  assert.equal(es1.closed, true, 'resync 后关闭旧连接');
  const es2 = FakeEventSource.instances.at(-1);
  assert.equal(es2.url, '/api/sessions/sess-2/events?last_event_id=7');
  assert.equal(S.lastSeq, 7, 'resync 不推进 lastSeq');
});

test('前端：lastSeq=0（无已知历史）→ 不重连；resync 仍能带游标重连收敛', () => {
  const { client } = loadClient();
  const { S } = client;
  S.sessionId = 'sess-3'; S.esSessionId = 'sess-3'; S.lastSeq = 0;
  client.connectEvents('sess-3');
  const es1 = FakeEventSource.instances.at(-1);

  es1.emit('assistant_delta', evt(5, { text: 'x' })); // 无已知 lastSeq → 不做跳号判定
  assert.equal(FakeEventSource.instances.length, 1);
  assert.equal(S.lastSeq, 5);

  es1.emit('resync', { reason: 'buffer_overflow', last_seq: 5 });
  assert.equal(FakeEventSource.instances.at(-1).url, '/api/sessions/sess-3/events?last_event_id=5');
});

test('前端：resync 重连后 run_end 状态机守卫不变（仅 activeRunId 匹配时驱动 UI）', () => {
  const { client, elements } = loadClient();
  const { S } = client;
  S.sessionId = 'sess-4'; S.esSessionId = 'sess-4'; S.lastSeq = 2; S.activeRunId = 'run-cur';
  client.connectEvents('sess-4');
  let es = FakeEventSource.instances.at(-1);
  es.emit('resync', { reason: 'buffer_overflow', last_seq: 2 });
  es = FakeEventSource.instances.at(-1);
  assert.equal(es.url, '/api/sessions/sess-4/events?last_event_id=2');

  // 历史重放的旧 run_end（run_id 不匹配）不得驱动状态机（不关停止按钮）
  es.emit('run_end', evt(3, { run_id: 'run-old', termination: { reason: 'end_turn' } }));
  assert.equal(S.activeRunId, 'run-cur', '旧 run_end 不清当前 run');
  assert.equal(elements.get('stopBtn').style.display, undefined, '旧 run_end 不改停止按钮');

  // 当前 run 的 run_end → 收尾（按钮隐藏 + 清除 activeRunId）
  es.emit('run_end', evt(4, { run_id: 'run-cur', termination: { reason: 'end_turn' } }));
  assert.equal(S.activeRunId, null);
  assert.equal(elements.get('stopBtn').style.display, 'none');
});

test('前端：0.9.0 新事件类型白名单 + 载荷对齐（compaction/final_guard/forced_final/judge extend/passThrough，issue #43 评审 F4）', () => {
  const { client, created } = loadClient();
  const { S } = client;
  S.sessionId = 'sess-9'; S.esSessionId = 'sess-9'; S.lastSeq = 0; S.activeRunId = 'run-9';
  client.connectEvents('sess-9');
  const es = FakeEventSource.instances.at(-1);

  // 白名单：新事件类型已注册具名监听（未注册 = 事件被 EventSource 静默丢弃）
  for (const type of ['compaction', 'final_guard', 'forced_final']) {
    assert.ok(es.listeners.has(type), `SSE 白名单缺 ${type}`);
  }

  // compaction：详情在 d.compaction（orchestrator recordCompactionStat）
  es.emit('compaction', evt(2, { round: 5, compaction: { compacted: true, foldedRounds: 3, tokensBefore: 9000, tokensAfter: 4000, layers: 1 } }));
  // final_guard：action + reason（termination.js）
  es.emit('final_guard', evt(3, { round: 6, action: 'accept' }));
  // forced_final：round + reason（termination.js:215，0.9.0 最后一轮强制无 tools 终稿）
  es.emit('forced_final', evt(4, { round: 7, reason: 'max_rounds_cap' }));
  // judge passThrough：挂在 intercept 类事件上（checkpoint-executor）
  es.emit('judge', evt(5, { kind: 'intercept', action: 'executed', passThrough: 'on_track', tool: { name: 'readFile' } }));
  es.emit('judge', evt(6, { kind: 'intercept', action: 'executed', passThrough: 'readonly', tool: { name: 'note_read' } }));
  // judge 扩轮：extend/extendReason/plan 在 d.decision 内（round judge）
  es.emit('judge', evt(7, { kind: 'round', action: 'extend', decision: { extend: true, extendReason: '任务未完成', plan: '继续实现登录页' } }));
  es.emit('judge', evt(8, { kind: 'round', action: 'decline_extend', decision: { extend: false, extendReason: '足够好' } }));
  // judge 拦截（无 passThrough）：action + decision.reason
  es.emit('judge', evt(9, { kind: 'intercept', action: 'blocked', decision: { done: false, reason: '方向偏离' } }));

  const seps = created.filter((el) => el.className === 'roundsep').map((el) => el.textContent);
  const joined = seps.join('\n');
  assert.ok(seps.some((t) => t.includes('上下文折叠') && t.includes('3 轮折叠') && t.includes('9000 → 4000')), `compaction 渲染：${joined}`);
  assert.ok(seps.some((t) => t.includes('final guard：accept')), `final_guard 渲染：${joined}`);
  assert.ok(seps.some((t) => t.includes('forced final') && t.includes('max_rounds_cap')), `forced_final 渲染：${joined}`);
  assert.ok(seps.some((t) => t.includes('放行（on_track）')), `judge passThrough(on_track)：${joined}`);
  assert.ok(seps.some((t) => t.includes('放行（readonly）')), `judge passThrough(readonly)：${joined}`);
  assert.ok(seps.some((t) => t.includes('扩轮') && t.includes('继续实现登录页')), `judge extend（decision 内 plan）：${joined}`);
  assert.ok(seps.some((t) => t.includes('不扩轮')), `judge decline_extend：${joined}`);
  assert.ok(seps.some((t) => t.includes('blocked') && t.includes('方向偏离')), `judge 拦截：${joined}`);
  assert.equal(S.lastSeq, 9, '水位线照常推进');
});

test('前端：切换项目清理旧会话、EventSource 和聊天区', async () => {
  const { client, elements } = loadClient();
  const { S } = client;
  S.user = { role: 'user', fde_name: 'alice' };
  S.projects = [{ id: 'p2', name: 'project-2' }];
  S.sessionId = 's1';
  S.es = new FakeEventSource('/api/sessions/s1/events');
  elements.set('stream', makeEl());
  elements.get('stream').innerHTML = '<div>旧项目消息</div>';

  await client.switchProject('p2', { loadSessions: false });

  assert.equal(S.projectId, 'p2');
  assert.equal(S.sessionId, null);
  assert.equal(S.es, null);
  assert.equal(S.activeRunId, null);
  assert.equal(S.lastSeq, 0);
  assert.equal(S.esSessionId, null);
  assert.equal(S.deltaBuf, null);
  assert.deepEqual(Object.keys(S.toolCards), []);
  assert.equal(S.renderedIds, null);
  assert.equal(S.sessions.length, 0);
  assert.equal(FakeEventSource.instances[0].closed, true);
  assert.equal(elements.get('stream').innerHTML, '<p class="muted">选择或新建会话</p>');
});

test('前端：openSession 迟到响应被项目切换作废且不建立旧会话连接', async () => {
  let resolveSession;
  const sessionResponse = new Promise((resolve) => { resolveSession = resolve; });
  const fetchImpl = async (url) => {
    if (url === '/api/me') throw new Error('未登录');
    if (url === '/api/sessions/s1') return sessionResponse;
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { client } = loadClient({ fetch: fetchImpl });
  const { S } = client;
  S.user = { role: 'user', fde_name: 'alice' };
  S.projects = [{ id: 'p2', name: 'project-2' }];

  const pending = client.openSession('s1');
  await Promise.resolve();
  await client.switchProject('p2', { loadSessions: false });
  resolveSession({
    ok: true,
    status: 200,
    async json() {
      return {
        last_seq: 3,
        messages: [{ id: 'm1', role: 'assistant', content: '旧项目', run_id: 'run-1' }],
        session: { active_run_id: 'run-1' },
      };
    },
  });
  await pending;

  assert.equal(S.sessionId, null);
  assert.equal(FakeEventSource.instances.length, 0);
});

test('前端：创建项目路径与 onchange 共用项目切换清理', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    if (url === '/api/me') throw new Error('未登录');
    if (url === '/api/projects' && !opts.method) {
      return { ok: true, status: 200, async json() { return { items: [{ id: 'p1', name: 'one' }] }; } };
    }
    if (url === '/api/projects' && opts.method === 'POST') {
      return { ok: true, status: 200, async json() { return { project: { id: 'p2', name: 'two' } }; } };
    }
    if (url.startsWith('/api/sessions?project_id=')) {
      calls.push(url);
      return { ok: true, status: 200, async json() { return { items: [] }; } };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { client, elements } = loadClient({ fetch: fetchImpl });
  const { S } = client;
  S.user = { role: 'user', fde_name: 'alice' };
  await client.initWorkspace();

  S.sessionId = 's1';
  const oldEs = new FakeEventSource('/api/sessions/s1/events');
  S.es = oldEs;
  elements.get('projectSel').value = 'p1';
  await elements.get('projectSel').onchange();
  assert.equal(S.sessionId, null);
  assert.equal(oldEs.closed, true);

  elements.get('newProjName').value = 'two';
  await elements.get('newProjForm').onsubmit({ preventDefault() {} });

  assert.equal(S.projectId, 'p2');
  assert.equal(S.sessionId, null);
  assert.equal(oldEs.closed, true);
  assert.deepEqual(calls, ['/api/sessions?project_id=p1', '/api/sessions?project_id=p1', '/api/sessions?project_id=p2']);
});
