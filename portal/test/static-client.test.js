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
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild() {}, remove() {},
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    // issue #55 A2：记录事件监听，测试可直接驱动 scroll 处理函数
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
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
  // issue #55：前端用到 document.body.classList（抽屉）与 document.hidden（通知）；
  // body.classList 记录 drawer-open 状态，测试可断言
  const bodyClasses = new Set();
  const document = {
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); },
    createElement() { const el = makeEl(); created.push(el); return el; },
    body: { classList: {
      add(c) { bodyClasses.add(c); },
      remove(c) { bodyClasses.delete(c); },
      toggle(c) { bodyClasses.has(c) ? bodyClasses.delete(c) : bodyClasses.add(c); },
      contains: (c) => bodyClasses.has(c),
    } },
    hidden: false,
  };
  const winListeners = {}; // issue #55 B1：记录 window 级监听（popstate）
  const historyCalls = []; // issue #55 B1：记录 pushState/replaceState
  const sandbox = {
    document,
    EventSource: FakeEventSource,
    fetch: fetchImpl ?? (async () => { throw new Error('fetch 在单测中禁用'); }), // boot() 走 renderLogin 分支
    // issue #55：前端用到 window（popstate）/history（hash 深链）/location.hash 等浏览器 API
    window: { addEventListener(type, fn) { winListeners[type] = fn; }, focus() {} },
    history: {
      pushState(_a, _b, url) { historyCalls.push(['push', url]); },
      replaceState(_a, _b, url) { historyCalls.push(['replace', url]); },
    },
    location: { reload() {}, hash: '', pathname: '/', search: '' },
    alert() {}, prompt() { return null; },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  const ctx = vm.createContext(sandbox);
  // 顶层 const/let 不进 globalThis，用同脚本片段把内部绑定导出给测试驱动
  const code = `${m[1]}\n;globalThis.__client = { S, handleEvent, connectEvents, resyncEvents, switchProject, openSession, refreshSession, initWorkspace };`;
  new vm.Script(code).runInContext(ctx);
  FakeEventSource.instances = [];
  return { client: ctx.__client, elements: els, created, winListeners, historyCalls, bodyClasses, loc: sandbox.location };
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

test('前端：refreshSession 迟到响应在同一会话重开后被丢弃', async () => {
  let resolveSession;
  const sessionResponse = new Promise((resolve) => { resolveSession = resolve; });
  const fetchImpl = async (url) => {
    if (url === '/api/sessions/s1') return sessionResponse;
    if (url === '/api/sessions?project_id=p1') {
      return { ok: true, status: 200, async json() { return { items: [] }; } };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { client, elements, created } = loadClient({ fetch: fetchImpl });
  const { S } = client;
  S.sessionId = 's1';
  S.projectId = 'p1';
  S.renderedIds = null;
  elements.set('stream', makeEl());
  elements.get('stream').innerHTML = '';

  const pendingRefresh = client.refreshSession('run-1');
  await Promise.resolve();
  const pendingOpen = client.openSession('s1');
  resolveSession({
    ok: true,
    status: 200,
    async json() {
      return {
        last_seq: 1,
        messages: [{ id: 'm-assistant', role: 'assistant', content: '迟到终稿', run_id: 'run-1' }],
        session: { active_run_id: null },
      };
    },
  });
  await Promise.all([pendingRefresh, pendingOpen]);

  const rendered = created.filter((el) => el.textContent === '迟到终稿');
  assert.equal(rendered.length, 1);
});

test('前端：同一会话重开不吞 send 失败回填', async () => {
  let resolveSend;
  const sendResponse = new Promise((resolve) => { resolveSend = resolve; });
  const fetchImpl = async (url, opts = {}) => {
    if (url === '/api/sessions/s1/messages' && opts.method === 'POST') return sendResponse;
    if (url === '/api/sessions/s1') {
      return {
        ok: true,
        status: 200,
        async json() {
          return { last_seq: 0, messages: [], session: { active_run_id: null } };
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { client, elements, created } = loadClient({ fetch: fetchImpl });
  const { S } = client;
  S.sessionId = 's1';
  S.projectId = 'p1';
  S.activeRunId = null;
  S.noProject = false;
  elements.get('input').value = '原始内容';

  const pendingSend = elements.get('sendBtn').onclick();
  await Promise.resolve();
  const pendingReopen = client.openSession(S.sessionId);
  resolveSend({
    ok: false,
    status: 500,
    async json() { return { error: { message: '发送失败原因' } }; },
  });
  await Promise.all([pendingSend, pendingReopen]);

  assert.equal(elements.get('input').value, '原始内容');
  assert.ok(created.some((el) => el.className === 'syserr' && el.textContent.includes('发送失败原因')));
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

test('前端：创建首个项目后会话列表加载失败仍解除工作区禁用态', async () => {
  const fetchImpl = async (url, opts = {}) => {
    if (url === '/api/projects' && !opts.method) {
      return { ok: true, status: 200, async json() { return { items: [] }; } };
    }
    if (url === '/api/projects' && opts.method === 'POST') {
      return { ok: true, status: 200, async json() { return { project: { id: 'p1', name: 'first' } }; } };
    }
    if (url.startsWith('/api/sessions?project_id=')) throw new Error('会话列表不可用');
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { client, elements, created } = loadClient({ fetch: fetchImpl });
  const { S } = client;
  S.user = { role: 'user', fde_name: 'alice' };
  await client.initWorkspace();

  elements.get('newProjName').value = 'first';
  await elements.get('newProjForm').onsubmit({ preventDefault() {} });

  assert.equal(S.noProject, false);
  assert.equal(elements.get('input').disabled, false);
  assert.ok(created.some((el) => el.className === 'syserr' && el.textContent.includes('项目已创建')));
});

test('前端：send 迟到响应不污染切换后的项目运行态', async () => {
  let resolveSend;
  const sendResponse = new Promise((resolve) => { resolveSend = resolve; });
  const fetchImpl = async (url, opts = {}) => {
    if (url === '/api/sessions/s1/messages' && opts.method === 'POST') return sendResponse;
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { client, elements } = loadClient({ fetch: fetchImpl });
  const { S } = client;
  S.user = { role: 'user', fde_name: 'alice' };
  S.projects = [{ id: 'p1', name: 'one' }, { id: 'p2', name: 'two' }];
  S.projectId = 'p1';
  S.sessionId = 's1';
  S.noProject = false;
  elements.get('input').value = '旧项目任务';

  const pending = elements.get('sendBtn').onclick();
  await Promise.resolve();
  await client.switchProject('p2', { loadSessions: false });
  resolveSend({
    ok: true,
    status: 200,
    async json() {
      return { message: { id: 'm1', content: '旧项目任务' }, run: { id: 'run-1' } };
    },
  });
  await pending;

  assert.equal(S.activeRunId, null);
  assert.notEqual(elements.get('stopBtn').style.display, 'inline-block');
});

test('前端：新会话迟到响应不写入切换后的项目且不打开旧会话', async () => {
  let resolveCreate;
  const createResponse = new Promise((resolve) => { resolveCreate = resolve; });
  const fetchImpl = async (url, opts = {}) => {
    if (url === '/api/sessions' && opts.method === 'POST') return createResponse;
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { client, elements } = loadClient({ fetch: fetchImpl });
  const { S } = client;
  S.user = { role: 'user', fde_name: 'alice' };
  S.projects = [{ id: 'p1', name: 'one' }, { id: 'p2', name: 'two' }];
  S.projectId = 'p1';

  const pending = elements.get('newSess').onclick();
  await Promise.resolve();
  await client.switchProject('p2', { loadSessions: false });
  resolveCreate({
    ok: true,
    status: 200,
    async json() {
      return { session: { id: 's-old', title: '旧项目会话' } };
    },
  });
  await pending;

  assert.equal(S.sessions.length, 0);
  assert.equal(FakeEventSource.instances.length, 0);
});

test('前端：连点新会话保留两个成功创建的会话', async () => {
  const createResolvers = [];
  const fetchImpl = async (url, opts = {}) => {
    if (url === '/api/sessions' && opts.method === 'POST') {
      return new Promise((resolve) => createResolvers.push(resolve));
    }
    if (url === '/api/sessions/s-1' || url === '/api/sessions/s-2') {
      return {
        ok: true,
        status: 200,
        async json() {
          return { last_seq: 0, messages: [], session: { active_run_id: null } };
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { client, elements } = loadClient({ fetch: fetchImpl });
  const { S } = client;
  S.user = { role: 'user', fde_name: 'alice' };
  S.projects = [{ id: 'p1', name: 'one' }];
  S.projectId = 'p1';

  const first = elements.get('newSess').onclick();
  const second = elements.get('newSess').onclick();
  assert.equal(elements.get('newSess').disabled, true);
  assert.equal(createResolvers.length, 2);

  createResolvers[1]({
    ok: true,
    status: 201,
    async json() { return { session: { id: 's-2', title: '第二个会话' } }; },
  });
  createResolvers[0]({
    ok: true,
    status: 201,
    async json() { return { session: { id: 's-1', title: '第一个会话' } }; },
  });
  await Promise.all([first, second]);

  assert.deepEqual(Array.from(S.sessions, (s) => s.id).sort(), ['s-1', 's-2']);
  assert.equal(elements.get('newSess').disabled, false);
});

// ---------------------------------------------------------------------------
// issue #55 P1：A1 会话草稿 / A2 滚动跟随 / B1 hash 深链 / B4 移动端抽屉
// ---------------------------------------------------------------------------

/** openSession 所需的会话详情 fetch 桩。 */
const sessDetailFetch = () => async (url, opts = {}) => {
  if (opts.method) throw new Error(`unexpected fetch: ${url}`);
  const m = url.match(/^\/api\/sessions\/(s-1|s-2|s-3)$/);
  if (m) {
    return { ok: true, status: 200, async json() { return { last_seq: 0, messages: [], session: { active_run_id: null } }; } };
  }
  throw new Error(`unexpected fetch: ${url}`);
};

test('issue #55 A1：切换会话保存并恢复输入草稿', async () => {
  const { client, elements } = loadClient({ fetch: sessDetailFetch() });
  const { S } = client;
  S.user = { role: 'user', fde_name: 'alice' };
  S.projects = [{ id: 'p1', name: 'one' }];
  S.projectId = 'p1';
  S.sessions = [{ id: 's-1', title: '会话一' }, { id: 's-2', title: '会话二' }];

  await client.openSession('s-1');
  elements.get('input').value = '写到一半的草稿';
  await client.openSession('s-2');
  assert.equal(elements.get('input').value, '', '新会话无草稿则清空输入框');
  elements.get('input').value = '第二条草稿';
  await client.openSession('s-1');
  assert.equal(elements.get('input').value, '写到一半的草稿', '切回会话一恢复其草稿');
  await client.openSession('s-2');
  assert.equal(elements.get('input').value, '第二条草稿', '切回会话二恢复其草稿');
});

test('issue #55 A1：切项目暂存草稿，重开会话可恢复；发送成功清除草稿', async () => {
  const { client, elements } = loadClient({ fetch: sessDetailFetch() });
  const { S } = client;
  S.user = { role: 'user', fde_name: 'alice' };
  S.projects = [{ id: 'p1', name: 'one' }];
  S.projectId = 'p1';
  S.sessions = [{ id: 's-1', title: '会话一' }];

  await client.openSession('s-1');
  elements.get('input').value = '跨项目的草稿';
  await client.switchProject('p1', { loadSessions: false });
  assert.equal(S.sessionId, null);
  assert.equal(elements.get('input').value, '', '切项目后输入框清空');
  await client.openSession('s-1');
  assert.equal(elements.get('input').value, '跨项目的草稿', '同项目重开会话恢复草稿');

  // 发送成功 → 输入框清空且草稿被清除
  elements.get('input').value = '已发送内容';
  let resolveSend;
  const sendP = new Promise((r) => { resolveSend = r; });
  const sendFetch = async (url, opts = {}) => {
    if (opts.method === 'POST') return sendP;
    if (url.startsWith('/api/sessions?project_id=')) {
      return { ok: true, status: 200, async json() { return { items: [] }; } };
    }
    return sessDetailFetch()(url, opts);
  };
  const c2 = loadClient({ fetch: sendFetch });
  c2.client.S.user = { role: 'user', fde_name: 'alice' };
  c2.client.S.projects = [{ id: 'p1', name: 'one' }];
  c2.client.S.projectId = 'p1';
  c2.client.S.sessions = [{ id: 's-1', title: '会话一' }];
  await c2.client.openSession('s-1');
  c2.elements.get('input').value = '已发送内容';
  const pending = c2.elements.get('sendBtn').onclick();
  await Promise.resolve();
  resolveSend({
    ok: true, status: 201,
    async json() { return { message: { id: 'm-1', content: '已发送内容', role: 'user', run_id: 'r-1' }, run: { id: 'r-1' } }; },
  });
  await pending;
  assert.equal(c2.elements.get('input').value, '');
  await c2.client.openSession('s-1');
  assert.equal(c2.elements.get('input').value, '', '发送成功后草稿已清除，重开不回填');
});

test('issue #55 A2：离开底部暂停自动跟随并显示「↓ 最新」，回底自动恢复', () => {
  const { client, elements } = loadClient();
  const { S } = client;
  S.user = { role: 'user', fde_name: 'alice' };
  S.sessionId = 'sess-1'; S.esSessionId = 'sess-1'; S.activeRunId = 'run-1';
  client.connectEvents('sess-1');
  const es = FakeEventSource.instances.at(-1);
  const stream = elements.get('stream');
  const onScroll = stream.listeners.scroll;
  assert.equal(typeof onScroll, 'function', 'scroll 监听已绑定');

  // 初始在底部：流式增量照常跟随（「↓ 最新」未出现；桩无 CSS，隐藏态即非 block）
  stream.scrollHeight = 1000; stream.clientHeight = 600; stream.scrollTop = 400;
  onScroll(); // gap=0 ≤80 → 跟随
  es.emit('assistant_delta', evt(1, { text: 'hello' }));
  assert.equal(stream.scrollTop, 1000, '跟随状态滚到底');
  assert.notEqual(elements.get('toLatest').style.display, 'block');

  // 用户向上滚动离开底部 → 暂停跟随 + 显示按钮；后续增量不再拉底
  stream.scrollTop = 200; // gap=200 >80
  onScroll();
  assert.equal(S.autoFollow, false);
  assert.equal(elements.get('toLatest').style.display, 'block');
  stream.scrollTop = 200;
  es.emit('assistant_delta', evt(2, { text: ' more' }));
  assert.equal(stream.scrollTop, 200, '暂停跟随后不拉底');

  // 点击「↓ 最新」回底并恢复跟随
  elements.get('toLatest').onclick();
  assert.equal(S.autoFollow, true);
  assert.equal(stream.scrollTop, 1000);
  assert.equal(elements.get('toLatest').style.display, 'none');

  // 手动滚回底部附近（<80px）自动恢复跟随
  stream.scrollTop = 150; onScroll();
  assert.equal(S.autoFollow, false);
  stream.scrollTop = 930; // gap=70 <80
  onScroll();
  assert.equal(S.autoFollow, true);
  assert.equal(elements.get('toLatest').style.display, 'none');
});

test('issue #55 B1：openSession 记录 hash 深链，popstate 切换/回退会话', async () => {
  const { client, elements, winListeners, historyCalls, loc } = loadClient({ fetch: sessDetailFetch() });
  const { S } = client;
  S.user = { role: 'user', fde_name: 'alice' };
  S.projects = [{ id: 'p1', name: 'one' }];
  S.projectId = 'p1';
  S.sessions = [{ id: 's-1', title: '会话一' }, { id: 's-2', title: '会话二' }];

  await client.openSession('s-1');
  assert.deepEqual(historyCalls.at(-1), ['push', '#/session/s-1'], '选中会话写入 hash');

  const onPop = winListeners.popstate;
  assert.equal(typeof onPop, 'function', 'popstate 监听已绑定');

  // 模拟前进/后退到另一会话的 hash：popstate 打开对应会话（不重复 push）
  historyCalls.length = 0;
  loc.hash = '#/session/s-2';
  onPop();
  assert.equal(S.sessionId, 's-2', 'popstate 切到 hash 指向的会话');
  assert.equal(historyCalls.filter(([k]) => k === 'push').length, 0, 'popstate 不再重复 push');

  // 模拟后退到无 hash：回退默认视图并清深链
  historyCalls.length = 0;
  loc.hash = '';
  onPop();
  assert.equal(S.sessionId, null, 'popstate 无 hash 时回退默认视图');
  assert.deepEqual(historyCalls.at(-1), ['replace', '/'], '清深链走 replaceState');
  assert.match(elements.get('stream').innerHTML, /选择或新建会话/);

  // hash 指向不存在的会话：静默回退默认视图
  historyCalls.length = 0;
  loc.hash = '#/session/s-404';
  onPop();
  assert.equal(S.sessionId, null);
  assert.deepEqual(historyCalls.at(-1), ['replace', '/']);
});

test('issue #55 B1：深链会话不存在时静默回退默认视图', async () => {
  const notFoundFetch = async (url, opts = {}) => {
    if (url === '/api/sessions/s-x' && !opts.method) {
      return { ok: false, status: 404, async json() { return { error: { code: 'not_found', message: '不存在' } }; } };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { client, elements, historyCalls } = loadClient({ fetch: notFoundFetch });
  const { S } = client;
  S.user = { role: 'user', fde_name: 'alice' };
  S.projects = [{ id: 'p1', name: 'one' }];
  S.projectId = 'p1';
  S.sessions = [{ id: 's-1', title: '会话一' }];

  await client.openSession('s-x');
  assert.equal(S.sessionId, null, '不存在的会话回退默认视图');
  assert.match(elements.get('stream').innerHTML, /选择或新建会话/);
  assert.deepEqual(historyCalls.at(-1), ['replace', '/'], '静默清掉失效深链');
});

test('issue #55 B4：选中会话自动收起移动端抽屉', async () => {
  const { client, elements, bodyClasses } = loadClient({ fetch: sessDetailFetch() });
  const { S } = client;
  S.user = { role: 'user', fde_name: 'alice' };
  S.projects = [{ id: 'p1', name: 'one' }];
  S.projectId = 'p1';
  S.sessions = [{ id: 's-1', title: '会话一' }];

  elements.get('navToggle').onclick(); // 模拟移动端展开抽屉
  assert.equal(bodyClasses.has('drawer-open'), true);
  elements.get('backdrop').onclick();
  assert.equal(bodyClasses.has('drawer-open'), false, 'backdrop 点击关闭抽屉');
  elements.get('navToggle').onclick();
  await client.openSession('s-1');
  assert.equal(bodyClasses.has('drawer-open'), false, '选中会话后自动收起抽屉');
});
