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
});
