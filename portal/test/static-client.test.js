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
  };
}

/** 载入 index.html 的内联脚本（桩化 document/EventSource/fetch），导出测试需要的内部绑定。 */
function loadClient() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'index.html 应含单个内联脚本');
  const els = new Map();
  const document = {
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); },
    createElement() { return makeEl(); },
  };
  const sandbox = {
    document,
    EventSource: FakeEventSource,
    fetch: async () => { throw new Error('fetch 在单测中禁用'); }, // boot() 走 renderLogin 分支
    location: { reload() {} },
    alert() {}, prompt() { return null; },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  const ctx = vm.createContext(sandbox);
  // 顶层 const/let 不进 globalThis，用同脚本片段把内部绑定导出给测试驱动
  const code = `${m[1]}\n;globalThis.__client = { S, handleEvent, connectEvents, resyncEvents };`;
  new vm.Script(code).runInContext(ctx);
  FakeEventSource.instances = [];
  return { client: ctx.__client, elements: els };
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
