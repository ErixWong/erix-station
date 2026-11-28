// issue #867：实时流断线状态条（StreamStatusBanner）的**渲染契约**。
//
// 判据（工单判据 3）：三态各有单测，且**全部走 DOM**——不用 `w.emitted()`
// （`NODE_ENV=production` 下恒空 ⇒ 假绿，AGENTS.md §4 / issue #496）。
// 三态的驱动方式是「真接一条假 EventSource」而不是直接改一个字符串：状态机是 composable 里的，
// 界面读的是它的投影，这样钉住的是「真的断得出来、真的连得回去」，不是「组件会读一个 ref」。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import StreamStatusBanner from './StreamStatusBanner.vue';
import { useWorkbenchStore } from '../stores/workbench';
import { i18n, setLocale } from '../i18n';
import { zhCN } from '../i18n/locales/zh-CN';
import { en } from '../i18n/locales/en';

const SESSION = 'sess-1';

/** EventSource 桩：可手动投 `open` / `error`（带 readyState）/ 具名帧，并记录 URL 与 close。 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  /** 1 = CONNECTING（浏览器还在试）；2 = CLOSED（端点回了非 2xx，按规范判死不再重试）。 */
  readyState = 1;
  closed = false;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    const set = this.listeners.get(type) ?? [];
    set.push(fn);
    this.listeners.set(type, set);
  }
  close() { this.closed = true; }
  emit(type: string, data: unknown) {
    const frame = { data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent;
    for (const fn of this.listeners.get(type) ?? []) fn(frame);
  }
  fireOpen() { this.onopen?.(); }
  fireError(readyState: number) { this.readyState = readyState; this.onerror?.(); }
}

const lastES = () => {
  const inst = FakeEventSource.instances;
  return inst[inst.length - 1];
};

function mountBanner() {
  setActivePinia(createPinia());
  const store = useWorkbenchStore();
  store.sessionId = SESSION;
  const wrapper = mount(StreamStatusBanner, { global: { plugins: [i18n] } });
  return { store, wrapper };
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"items":[]}', { status: 200 })));
});

describe('StreamStatusBanner（#867 三态渲染契约）', () => {
  it('`connected`（收到过帧）⇒ 整条不渲染：正常态不占一行', async () => {
    const { store, wrapper } = mountBanner();
    store.es.connect(SESSION);
    await wrapper.vm.$nextTick();
    // 先证明「开流但还没证明能送帧」那一态确实会出条（否则下面的「不出条」可能只是压根没挂组件）
    expect(wrapper.find('[data-testid="stream-status-banner"]').exists()).toBe(true);

    lastES().emit('ping', { ts: 'x' });
    await wrapper.vm.$nextTick();
    expect(store.streamStatus).toBe('connected');
    expect(wrapper.find('[data-testid="stream-status-banner"]').exists()).toBe(false);
  });

  it('`disconnected`（端点回非 2xx ⇒ 浏览器判死不再重试）⇒ 中性状态条 + 重连入口，正文一个字都不掉', async () => {
    const { store, wrapper } = mountBanner();
    // 已经上屏的正文（这就是这个 issue 的全部：断流时它必须还在）
    store.entries.push({ kind: 'sep', text: '已经在屏上的那段正文' });
    store.es.connect(SESSION);
    lastES().emit('assistant_delta', { seq: 5, text: '半截' });
    lastES().fireError(2); // CLOSED
    await wrapper.vm.$nextTick();

    expect(store.streamStatus).toBe('disconnected');
    const banner = wrapper.find('[data-testid="stream-status-banner"]');
    expect(banner.exists()).toBe(true);
    expect(banner.attributes('data-stream-status')).toBe('disconnected');
    expect(wrapper.find('[data-testid="stream-status-text"]').text()).toBe(zhCN.stream.status.disconnected);
    expect(wrapper.find('[data-testid="stream-status-hint"]').text()).toBe(zhCN.stream.status.disconnectedHint);
    expect(wrapper.find('[data-testid="stream-status-reconnect"]').exists()).toBe(true);
    // 正文保留：断流不清屏
    expect(store.entries.some((e) => e.kind === 'sep' && e.text === '已经在屏上的那段正文')).toBe(true);
    // ⚠ `store.es.*` 是 Pinia `reactive` 的投影：嵌套 ref **已被解包**，这里直接读值（写 `.value` 会拿到 undefined）。
    expect(store.es.deltaText).toBe('半截');
  });

  it('`reconnecting`（浏览器自动重试在途）⇒ 说「重连中」，不说「已断开」', async () => {
    const { store, wrapper } = mountBanner();
    store.es.connect(SESSION);
    lastES().emit('ping', { ts: 'x' });
    lastES().fireError(1); // CONNECTING：浏览器还会按服务端 retry 间隔继续试
    await wrapper.vm.$nextTick();

    expect(store.streamStatus).toBe('reconnecting');
    const banner = wrapper.find('[data-testid="stream-status-banner"]');
    expect(banner.attributes('data-stream-status')).toBe('reconnecting');
    expect(wrapper.find('[data-testid="stream-status-text"]').text()).toBe(zhCN.stream.status.reconnecting);
  });

  it('点「点此重连」⇒ 关掉判死的那条、带水位重开；态回到 `reconnecting`，正文照旧在', async () => {
    const { store, wrapper } = mountBanner();
    store.entries.push({ kind: 'sep', text: '已经在屏上的那段正文' });
    store.es.connect(SESSION);
    lastES().emit('assistant_delta', { seq: 7, text: 'x' });
    const dead = lastES();
    dead.fireError(2);
    await wrapper.vm.$nextTick();

    await wrapper.find('[data-testid="stream-status-reconnect"]').trigger('click');
    await wrapper.vm.$nextTick();

    expect(dead.closed).toBe(true);
    expect(lastES().url).toBe('/api/sessions/sess-1/events?last_event_id=7'); // 缺的那段由服务端补发接上
    expect(store.streamStatus).toBe('reconnecting');
    expect(wrapper.find('[data-testid="stream-status-banner"]').attributes('data-stream-status')).toBe('reconnecting');
    expect(store.entries.some((e) => e.kind === 'sep' && e.text === '已经在屏上的那段正文')).toBe(true);

    // 重连成功：真收到帧 ⇒ 条自己消失（不是靠超时隐藏）
    lastES().emit('assistant_delta', { seq: 8, text: 'y' });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="stream-status-banner"]').exists()).toBe(false);
  });

  it('重连只对流过的会话有意义：没开过流 ⇒ 点按钮不凭空拨号', async () => {
    const { wrapper } = mountBanner();
    // 刚挂载：一条流都没开过（`esSessionId` 空）⇒ 条已经在（初态就是 `disconnected`），但点它不该拨号
    await wrapper.find('[data-testid="stream-status-reconnect"]').trigger('click');
    expect(FakeEventSource.instances.length).toBe(0);
  });

  it('中性面：不用告警色（无 red/amber 类），中英两套措辞都不出现「错误/失败/崩溃」那类词', async () => {
    // zh
    const a = mountBanner();
    a.store.es.connect(SESSION);
    lastES().fireError(2); // 真走一遍「判死」，不直接改状态字符串
    await a.wrapper.vm.$nextTick();
    const cls = a.wrapper.find('[data-testid="stream-status-banner"]').attributes('class') ?? '';
    expect(cls).not.toMatch(/red|amber|rose|orange/);
    const zhText = a.wrapper.find('[data-testid="stream-status-banner"]').text();
    expect(zhText).toContain(zhCN.stream.status.disconnected);
    for (const word of ['错误', '失败', '崩溃']) {
      expect(zhText.includes(word), zhText).toBe(false);
    }
    a.wrapper.unmount();

    // en
    setLocale('en');
    const b = mountBanner();
    b.store.es.connect(SESSION);
    lastES().fireError(2);
    await b.wrapper.vm.$nextTick();
    const enText = b.wrapper.find('[data-testid="stream-status-banner"]').text();
    expect(enText).toContain(en.stream.status.disconnected);
    for (const word of ['error', 'fail', 'crash']) {
      expect(enText.toLowerCase().includes(word), enText).toBe(false);
    }
    expect(enText).toContain(en.stream.status.disconnected);
  });

  it('没有选中会话 ⇒ 整条不挂（没有流可说）', () => {
    setActivePinia(createPinia());
    const store = useWorkbenchStore();
    const wrapper = mount(StreamStatusBanner, { global: { plugins: [i18n] } });
    expect(wrapper.find('[data-testid="stream-status-banner"]').exists()).toBe(false);
    expect(store.sessionId).toBeNull();
  });
});
