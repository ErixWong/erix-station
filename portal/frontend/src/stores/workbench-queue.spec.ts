// issue #370：输入队列（运行中说话）的前端语义。
//
// 钉的是**契约**而不是渲染：
//   1. `queue_update` 是**全量快照** ⇒ 本地整体覆盖（不是追加）——多标签页一致性的全部来源；
//   2. 详情快照 `session.queued_messages` 能补齐（刷新后队列条不许凭空消失）；旧后端无此字段 ⇒ 空队列；
//   3. 入队 POST 的 body 必须带 `kind`，且**直发/入队由服务端裁决**：响应是 `{posted}` 时前端要按
//      直发渲染（这条是防「前端自己判 running 从而重新引入竞态」的回归锚点）；
//   4. 整队取回回填口径：取回的文在前、已打草稿在后、空行分隔；
//   5. 入队失败 ⇒ 话回到输入框 + 撤销乐观条目（不许「说了却丢」）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { normalizeQueuedSnapshot, useWorkbenchStore } from './workbench';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this); }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() { this.closed = true; }
  emits(type: string) { return this.listeners.get(type) ?? []; }
  emit(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const calls: Array<{ url: string; init: RequestInit }> = [];

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  calls.length = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return jsonResponse(r.status, r.body);
  }));
}

const detail = (extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    session: { id: 's1', cwd: '/w', ...extra },
    messages: [],
    last_seq: 0,
  },
});

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe('normalizeQueuedSnapshot（#370 纯函数）', () => {
  it('旧后端无字段 / null / 形状不对 ⇒ 空队列（additive 兼容，绝不抛错）', () => {
    for (const raw of [undefined, null, 'x', 42, {}]) {
      expect(normalizeQueuedSnapshot(raw)).toEqual({ steering: [], follow_up: [] });
    }
  });
  it('对象条目与裸字符串都能吃（详情快照给对象，clear_queue 给字符串）', () => {
    const out = normalizeQueuedSnapshot({
      steering: [{ id: 'a', content: '慢一点' }, '纯字符串'],
      follow_up: [{ id: 'b', content: '' }],
    });
    expect(out.steering.map((x) => x.content)).toEqual(['慢一点', '纯字符串']);
    expect(out.follow_up).toEqual([]); // 空内容不入列（渲染面上的空行）
  });
});

describe('workbench store · 输入队列（#370）', () => {
  it('运行中 sendDisabled 为 false，且 Enter 走 steer 而不是 send', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') return detail();
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    store.es.activeRunId = 'r1';
    expect(store.running).toBe(true);
    expect(store.sendDisabled).toBe(false); // 断言被 #370 有意改掉：运行中照样能说

    store.inputValue = '慢一点';
    await store.sendQueued('steer');
    const post = calls.find((c) => c.url.endsWith('/queued-inputs'))!;
    expect(post.init.method).toBe('POST');
    expect(JSON.parse(String(post.init.body))).toMatchObject({ content: '慢一点', kind: 'steer' });
  });

  it('入队响应是 {posted}（服务端裁决成直发）⇒ 按直发渲染，不写进队列', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') return detail();
      if (url.endsWith('/queued-inputs')) {
        // 形状与后端逐字一致：`{posted:{message,run}, queued:null}`（run 嵌在 posted 里，http.js:1678）
        return { status: 202, body: { posted: { message: { id: 'm1', seq: 3, role: 'user', content: '直发' }, run: { id: 'r9' } }, queued: null } };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    store.inputValue = '直发';
    await store.sendQueued('follow_up');
    // 乐观插入的条目被权威快照取代的前提：直发时队列必须是空的（否则那句话会以「待发送」身份挂着）
    expect(store.queuedCount).toBe(0);
    expect(store.entries.some((e) => e.kind === 'msg' && e.id === 'm1')).toBe(true);
    expect(store.es.activeRunId).toBe('r9');
  });

  it('queue_update 是全量快照：整体覆盖而非追加（多标签页一致性的唯一来源）', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') return detail();
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    store.applyQueueSnapshot({ steering: [{ id: 'a', content: '一' }], follow_up: [] });
    expect(store.queuedCount).toBe(1);
    // 另一标签页删了一条之后到达的快照：本地必须跟着变空，而不是留下乐观残留
    store.applyQueueSnapshot({ steering: [], follow_up: [] }, 'container_not_running');
    expect(store.queuedCount).toBe(0);
    expect(store.queueBlocked).toBe('container_not_running');
  });

  it('SSE queue_update 帧经 useEventStream 落到 store（漏加 EVENT_TYPES 就是这条挂）', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') return detail();
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    const es = FakeEventSource.instances.at(-1)!;
    expect(es.emits('queue_update').length).toBe(1); // EventSource 真的挂了这个具名事件
    es.emit('queue_update', { steering: ['慢一点'], follow_up: ['结束后跑这个'], blocked: null });
    expect(store.queuedInputs.steering.map((x) => x.content)).toEqual(['慢一点']);
    expect(store.queuedInputs.follow_up.map((x) => x.content)).toEqual(['结束后跑这个']);
  });

  it('刷新后由详情快照补齐；旧后端无该字段 ⇒ 空队列且不报错', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') {
        return detail({ queued_messages: { steering: [{ id: 'a', content: '刷新前排的队' }], follow_up: [] } });
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(store.queuedCount).toBe(1);

    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s2') return { status: 200, body: { session: { id: 's2' }, messages: [], last_seq: 0 } };
      return { status: 200, body: { items: [] } };
    });
    await store.openSession('s2');
    expect(store.queuedCount).toBe(0);
  });

  it('整队取回：取回的文在前、已打草稿在后、空行分隔；本地队列立刻清空', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') return detail();
      if (url.endsWith('/queued-inputs')) {
        return { status: 200, body: { recalled: { steering: ['第一条'], follow_up: ['第二条'] } } };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    store.applyQueueSnapshot({ steering: [{ id: 'a', content: '第一条' }], follow_up: [{ id: 'b', content: '第二条' }] });
    store.inputValue = '我已打的草稿';
    await store.recallQueue();
    expect(store.inputValue).toBe('第一条\n\n第二条\n\n我已打的草稿');
    expect(store.queuedCount).toBe(0);
    expect(calls.some((c) => c.init.method === 'DELETE' && c.url.endsWith('/queued-inputs'))).toBe(true);
  });

  it('入队失败：话回到输入框、乐观条目撤销、刷一条 syserr（不许「说了却丢」）', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') return detail();
      if (url.endsWith('/queued-inputs')) {
        return { status: 429, body: { error: { code: 'queue_full', message: '同时最多 5 条待发送输入' } } };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    store.inputValue = '排不下的话';
    await store.sendQueued('follow_up');
    expect(store.inputValue).toBe('排不下的话');
    expect(store.queuedCount).toBe(0);
    // 文案由服务端 message 决定（#294：ApiError.message 是服务端文案的唯一出口），故断其内容而非话本身
    expect(store.entries.some((e) => e.kind === 'syserr' && String((e as { text: string }).text).includes('最多 5 条'))).toBe(true);
  });

  it('队列投递出去的 new run 被前端接管（评审抓到的 bug：不接管则状态条空闲 + 新 run 的 run_end 被丢）', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') return detail();
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(store.es.activeRunId).toBeNull();
    // 经真实 SSE 帧驱动（不是直接调 action）：漏接 onQueueUpdate 的第二段就该红
    const es = FakeEventSource.instances.at(-1)!;
    es.emit('queue_update', { steering: [], follow_up: [], blocked: null, delivered_run_id: 'r-new' });
    expect(store.es.activeRunId).toBe('r-new');
    expect(store.running).toBe(true);
  });

  it('本机已有活跃 run 时不抢（别把用户正在看的那个 run 换掉）', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') return detail();
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    store.es.activeRunId = 'r-mine';
    store.adoptDeliveredRun('r-other');
    expect(store.es.activeRunId).toBe('r-mine');
  });

  // 「重试上一条」的面由**真实 run_end 帧**驱动（不是直接调内部函数——它没导出，直接调会得到
  // 一个 undefined?.() 的空操作，测了等于没测）。两条一起放：普通 abort 必须亮，转向 abort 必须不亮。
  async function faceAfterRunEnd(termination: Record<string, unknown>) {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') return detail();
      if (url.endsWith('/messages')) {
        return { status: 202, body: { message: { id: 'm1', seq: 1, role: 'user', content: '长任务' }, run: { id: 'r1' } } };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    store.inputValue = '长任务';
    await store.send();                       // 记 lastSend + activeRunId=r1
    expect(store.es.activeRunId).toBe('r1');
    FakeEventSource.instances.at(-1)!.emit('run_end', { run_id: 'r1', termination });
    await flushPromises();
    return store.retryAvailable;
  }

  it('#370 普通 abort 点亮「重试上一条」（既有 #261B 语义不被本片改坏）', async () => {
    expect(await faceAfterRunEnd({ reason: 'aborted' })).toBe(true);
  });

  it('#370 转向导致的 abort 不点亮「重试上一条」（用户刚说「用这句继续」，重试是倒退）', async () => {
    expect(await faceAfterRunEnd({ reason: 'aborted', detail: 'steered' })).toBe(false);
  });

  it('切换会话清空队列（会话级状态，不得把上个会话的队列带过去）', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') return detail();
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    store.applyQueueSnapshot({ steering: [{ id: 'a', content: '属于 s1' }], follow_up: [] });
    store.resetSessionView();
    expect(store.queuedCount).toBe(0);
    expect(store.queueBlocked).toBeNull();
  });

  // ---- issue #799：队列投递出去的那句话当场渲染成 user 气泡（不再只在刷新后从库里读回来） ----
  type MsgEntry = { kind: string; id?: string; role?: string; text?: string };
  const msgEntries = (s: ReturnType<typeof useWorkbenchStore>) =>
    s.entries.filter((e) => (e as { kind?: string }).kind === 'msg') as unknown as MsgEntry[];
  const probe = { id: 'm-1', run_id: 'r-new', seq: 10, role: 'user', content: '转向探针-XYZ', synthetic: false, attachments: [] };

  it('#799 投递帧带 delivered ⇒ 当场渲染成实时 user 气泡，队列里不再挂着那句话', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') return detail();
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    const es = FakeEventSource.instances.at(-1)!;
    // 经真实 SSE 帧驱动（不是直接调 action）：漏接 onQueueUpdate 的第三步就该红
    es.emit('queue_update', { steering: [], follow_up: [], blocked: null, delivered_run_id: 'r-new', delivered: probe });
    await flushPromises();
    const bubble = msgEntries(store).find((e) => e.text === '转向探针-XYZ');
    expect(bubble).toBeTruthy();
    expect(bubble!.role).toBe('user');
    expect(store.queuedCount).toBe(0);
  });

  it('#799 同一投递帧连发两次 ⇒ 只一张气泡、头部计数只 +1（renderedIds 幂等）', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') return detail({ message_count: 5 });
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(store.sessionMessageCount).toBe(5); // 头部计数是后端权威值
    const es = FakeEventSource.instances.at(-1)!;
    const frame = { steering: [], follow_up: [], blocked: null, delivered_run_id: 'r-new', delivered: { ...probe, id: 'm-dup', content: '探针-重复' } };
    es.emit('queue_update', frame);
    es.emit('queue_update', frame);
    await flushPromises();
    expect(msgEntries(store).filter((e) => e.id === 'm-dup').length).toBe(1);
    expect(store.sessionMessageCount).toBe(6); // 只 +1，第二条被幂等集挡掉
  });

  it('#799 delivered 为 null / 缺键 / content 非字符串 ⇒ 不新增气泡、计数不动（不空气泡）', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') return detail({ message_count: 3 });
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    const before = msgEntries(store).length;
    const es = FakeEventSource.instances.at(-1)!;
    es.emit('queue_update', { steering: [], follow_up: [], blocked: null }); // 无 delivered 键
    es.emit('queue_update', { steering: [], follow_up: [], blocked: null, delivered: null }); // 显式 null
    es.emit('queue_update', { steering: [], follow_up: [], blocked: null, delivered: { id: 'x', role: 'user', content: 42 } }); // content 非字符串
    es.emit('queue_update', { steering: [], follow_up: [], blocked: null, delivered: { role: 'user', content: '缺 id' } }); // 缺 id
    await flushPromises();
    expect(msgEntries(store).length).toBe(before);
    expect(store.sessionMessageCount).toBe(3); // 不动
  });

  it('#799 投递帧排在旧 run 终稿之下（先等在飞的终态补拉，防倒序）', async () => {
    let detailCalls = 0;
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') {
        detailCalls += 1;
        if (detailCalls === 1) return detail({ message_count: 2 });
        // run_end 之后 refreshSession 的那次详情：带回旧 run 的助手终稿
        return {
          status: 200,
          body: { session: { id: 's1', cwd: '/w', message_count: 3 }, messages: [{ id: 'm-old', run_id: 'r1', seq: 5, role: 'assistant', content: '旧 run 的终稿', synthetic: false }], last_seq: 5 },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    store.es.activeRunId = 'r1';
    const es = FakeEventSource.instances.at(-1)!;
    es.emit('run_end', { run_id: 'r1', termination: { reason: 'end_turn' } }); // 触发 refreshSession，补拉在飞
    es.emit('queue_update', { steering: [], follow_up: [], blocked: null, delivered_run_id: 'r-new', delivered: probe });
    await flushPromises();
    const msgs = msgEntries(store);
    const aiIdx = msgs.findIndex((e) => e.role === 'assistant' && e.text === '旧 run 的终稿');
    const uIdx = msgs.findIndex((e) => e.text === '转向探针-XYZ');
    expect(aiIdx).toBeGreaterThanOrEqual(0);
    expect(uIdx).toBeGreaterThanOrEqual(0);
    expect(aiIdx).toBeLessThan(uIdx); // 旧 run 终稿在前，转向气泡在后
  });

  // ---- #799 评审修复轮新增回归用例（R1 代次守卫 / R2 句柄归属 / R3 计数不重复 / R5 形状收紧） ----

  it('#799 切会话竞态：旧会话的投递帧不得落进新会话（评审 R1 代次守卫）', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    calls.length = 0;
    let s1Detail = 0;
    let resolveRefresh: (v?: unknown) => void = () => {};
    const refreshGate = new Promise((r) => { resolveRefresh = r; });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.includes('/events/history')) return jsonResponse(200, { events: [] });
      const base = url.split('?')[0];
      if (base === '/api/sessions/s1') {
        s1Detail += 1;
        if (s1Detail === 1) return jsonResponse(200, { session: { id: 's1', cwd: '/w', message_count: 7 }, messages: [], last_seq: 1 });
        return refreshGate.then(() => jsonResponse(200, { session: { id: 's1', cwd: '/w', message_count: 8 }, messages: [{ id: 'm-old', run_id: 'r1', seq: 5, role: 'assistant', content: '旧会话终稿', synthetic: false }], last_seq: 5 }));
      }
      if (base === '/api/sessions/s2') return jsonResponse(200, { session: { id: 's2', cwd: '/w', message_count: 9 }, messages: [], last_seq: 0 });
      return jsonResponse(200, { items: [] });
    }));
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(store.sessionMessageCount).toBe(7);
    store.es.activeRunId = 'r1';
    const es = FakeEventSource.instances.at(-1)!;
    es.emit('run_end', { run_id: 'r1', termination: { reason: 'end_turn' } }); // 终态补拉在飞（详情响应被 gate 卡住）
    es.emit('queue_update', { steering: [], follow_up: [], blocked: null, delivered_run_id: 'r-new', delivered: probe }); // adopt 卡在 await refreshInFlight
    await store.openSession('s2'); // 切会话：refreshInFlight=null、代次++、entries 清空、计数=9
    resolveRefresh();              // 再放行旧详情响应
    await flushPromises();
    expect(msgEntries(store).some((e) => e.text === '转向探针-XYZ')).toBe(false); // 探针气泡没进新会话
    expect(store.sessionMessageCount).toBe(9); // 新会话计数没被旧投递帧动过
  });

  it('#799 权威计数已含投递那条 ⇒ 头部计数不再 +1（评审 R3：要「已计入」的证据）', async () => {
    let s1 = 0;
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') {
        s1 += 1;
        if (s1 === 1) return detail({ message_count: 1 });
        return { status: 200, body: { session: { id: 's1', cwd: '/w', message_count: 3 }, messages: [{ id: 'm-old', run_id: 'r1', seq: 5, role: 'assistant', content: '终稿', synthetic: false }, { id: 'm-1', run_id: 'r-new', seq: 10, role: 'user', content: '转向探针-XYZ', synthetic: false }], last_seq: 6 } };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    store.es.activeRunId = 'r1';
    const es = FakeEventSource.instances.at(-1)!;
    es.emit('run_end', { run_id: 'r1', termination: { reason: 'end_turn' } }); // 补拉返回的 message_count 已含那条
    es.emit('queue_update', { steering: [], follow_up: [], blocked: null, delivered_run_id: 'r-new', delivered: probe });
    await flushPromises();
    expect(store.sessionMessageCount).toBe(3); // = 响应里的权威值，不再 +1（R3 前会变 4）
    expect(msgEntries(store).filter((e) => e.id === 'm-1').length).toBe(1); // 气泡照常落一张
  });

  it('#799 形状收紧：空串 / 纯空白 / role 非 user ⇒ 不产气泡、计数不动（评审 R5）', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') return detail({ message_count: 3 });
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    const before = msgEntries(store).length;
    const es = FakeEventSource.instances.at(-1)!;
    for (const bad of [
      { id: 'b-empty', role: 'user', content: '' },
      { id: 'b-blank', role: 'user', content: '   ' },
      { id: 'b-role', role: 'assistant', content: '助手语气不该进对话流' },
    ]) {
      es.emit('queue_update', { steering: [], follow_up: [], blocked: null, delivered_run_id: 'r-new', delivered: bad });
    }
    await flushPromises();
    expect(msgEntries(store).length).toBe(before);
    expect(store.sessionMessageCount).toBe(3);
  });

  it('#799 在飞句柄归属：连发两次 run_end（旧慢新快），投递帧等的是最新那笔补拉（评审 R2）', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    calls.length = 0;
    let s1Detail = 0;
    let resolveOld: (v?: unknown) => void = () => {}; const oldGate = new Promise((r) => { resolveOld = r; });
    let resolveNew: (v?: unknown) => void = () => {}; const newGate = new Promise((r) => { resolveNew = r; });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.includes('/events/history')) return jsonResponse(200, { events: [] });
      const base = url.split('?')[0];
      if (base === '/api/sessions/s1') {
        s1Detail += 1;
        if (s1Detail === 1) return jsonResponse(200, { session: { id: 's1', cwd: '/w', message_count: 1 }, messages: [], last_seq: 1 });
        if (s1Detail === 2) return oldGate.then(() => jsonResponse(200, { session: { id: 's1', cwd: '/w', message_count: 2 }, messages: [{ id: 'm-old', run_id: 'r1', seq: 5, role: 'assistant', content: '第一轮终稿', synthetic: false }], last_seq: 5 }));
        return newGate.then(() => jsonResponse(200, { session: { id: 's1', cwd: '/w', message_count: 2 }, messages: [{ id: 'm-new', run_id: 'r1', seq: 6, role: 'assistant', content: '第二轮终稿', synthetic: false }], last_seq: 6 }));
      }
      return jsonResponse(200, { items: [] });
    }));
    const store = useWorkbenchStore();
    await store.openSession('s1');
    const es = FakeEventSource.instances.at(-1)!;
    store.es.activeRunId = 'r1';
    es.emit('run_end', { run_id: 'r1', termination: { reason: 'end_turn' } }); // 第一笔补拉在飞（旧，慢）
    store.es.activeRunId = 'r1';
    es.emit('run_end', { run_id: 'r1', termination: { reason: 'end_turn' } }); // 第二笔补拉在飞（新，快）
    resolveOld();          // 先放行**旧**那笔：它的 finally 不得清掉新登记的句柄（R2）
    await flushPromises();
    es.emit('queue_update', { steering: [], follow_up: [], blocked: null, delivered_run_id: 'r-new', delivered: probe });
    resolveNew();          // 再放行新那笔
    await flushPromises();
    const msgs = msgEntries(store);
    const newIdx = msgs.findIndex((e) => e.text === '第二轮终稿');
    const uIdx = msgs.findIndex((e) => e.text === '转向探针-XYZ');
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(uIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeLessThan(uIdx); // 气泡排在最新那笔补拉的终稿之后（不是被旧 finally 清掉后抢跑）
  });
});
