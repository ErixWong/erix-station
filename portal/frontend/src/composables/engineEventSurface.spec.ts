// issue #421 判据（前端行为面）：引擎承诺、本站以前订不到的 5 类事件，界面上到底发生了什么。
//
// 「三处集合是否齐」这种**结构**对账不在这里（跨端读后端源码在 jsdom 下只能走 vite `?raw`，而
// vite 的 fs 边界不许越出 `portal/frontend`，issue #349）——那部分住在
// `portal/test/event-surface-contract.test.js`。本文件只证**行为**：
//   · 类型订得到吗（`FakeEventSource` 只有真被 `addEventListener` 过的类型才投得住帧）；
//   · 实时帧与历史回放帧是否都落到同一行中性分隔行（`HISTORY_REPLAY_TYPES` 的活证）；
//   · 文案里的数字缺了就是缺了（不拿 0 冒充，#283），脏值不渗 `[object Object]`（#261）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEventStream, type EventStreamHooks } from './useEventStream';
import { setLocale } from '../i18n';

/** 引擎承诺给宿主的事件全集（来源：`erix-agent` `src/loop/orchestrator.js` 的 `LoopEvent` 联合类型）。 */
const ENGINE_PROMISED_EVENTS = [
  'round_start', 'attempt', 'recovering', 'recovered', 'usage', 'tool_use', 'tool_result',
  'tool_replay_decision_required', 'round_end', 'compaction', 'final_guard',
  'persistence_capability_degraded', 'model_metadata_missing', 'resume_journal_skipped',
  'compaction_strategy_fallback', 'run_outcome',
];

/** #421 新接的四类诊断事件。 */
const DIAGNOSTIC_EVENTS = [
  'compaction_strategy_fallback', 'model_metadata_missing',
  'persistence_capability_degraded', 'resume_journal_skipped',
];

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this); }
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
}

function makeHooks() {
  return {
    onSep: vi.fn(), onSysErr: vi.fn(), onToolCardCreated: vi.fn(),
    onCurrentRunEnd: vi.fn(), onSessionUpdated: vi.fn(),
  } satisfies EventStreamHooks;
}

function lastES() {
  return FakeEventSource.instances[FakeEventSource.instances.length - 1];
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

describe('#421 承接面（行为面）', () => {
  it('引擎承诺的 16 类**全部订得到**（漏一类就是浏览器一条都收不到，且不报错不警告）', () => {
    useEventStream(makeHooks()).connect('sess-1');
    const subscribed = new Set(lastES().listeners.keys());
    for (const type of ENGINE_PROMISED_EVENTS) {
      expect(subscribed.has(type), `未监听 ${type}`).toBe(true);
    }
  });

  it('四类诊断事件：实时帧与历史回放帧都刷同一行中性分隔行', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    for (const type of DIAGNOSTIC_EVENTS) {
      hooks.onSep.mockClear();
      lastES().emit(type, { round: 2, count: 1, method: 'saveRunSnapshot' });
      expect(hooks.onSep.mock.calls.length, `${type} 实时不刷行`).toBe(1);
      hooks.onSep.mockClear();
      s.replayEvent({ seq: 1, run_id: 'r1', type, payload: { round: 2, count: 1, method: 'saveRunSnapshot' } });
      expect(hooks.onSep.mock.calls.length, `${type} 漏在 HISTORY_REPLAY_TYPES ⇒ 刷新后消失`).toBe(1);
    }
    expect(hooks.onSysErr).not.toHaveBeenCalled(); // 全是中性行：它们不是失败
  });

  it('run_outcome：订得到但**不刷时间线**（与 run_end 重叠，理由钉在 portal/test/event-surface-contract.test.js）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    expect(lastES().listeners.has('run_outcome')).toBe(true);
    lastES().emit('run_outcome', { rounds: 3, termination: { reason: 'end_turn' } });
    s.replayEvent({ seq: 1, run_id: 'r1', type: 'run_outcome', payload: { rounds: 3 } });
    expect(hooks.onSep).not.toHaveBeenCalled();
  });
});

describe('#421 四类诊断事件的文案', () => {
  it('compaction_strategy_fallback：说清「配的策略没生效，跑的是引擎兜底 sliding-window」', () => {
    const hooks = makeHooks();
    useEventStream(hooks).connect('sess-1');
    lastES().emit('compaction_strategy_fallback', { round: 7 });
    const line = hooks.onSep.mock.calls[0][0] as string;
    expect(line).toContain('sliding-window');
    expect(line).toContain('7');
  });

  it('model_metadata_missing：说清压缩闸门已关闭；载荷里**没有** round ⇒ 文案里不许出现数字', () => {
    const hooks = makeHooks();
    useEventStream(hooks).connect('sess-1');
    lastES().emit('model_metadata_missing', { detail: 'contextWindowTokens/maxOutputTokens unavailable' });
    const line = hooks.onSep.mock.calls[0][0] as string;
    expect(line).toContain('压缩');
    expect(line).not.toMatch(/\d/);
  });

  it('persistence_capability_degraded：能力名原样给出；脏值退 ?，绝不 [object Object]', () => {
    const hooks = makeHooks();
    useEventStream(hooks).connect('sess-1');
    lastES().emit('persistence_capability_degraded', { method: 'saveRunSnapshot' });
    expect(hooks.onSep.mock.calls[0][0]).toContain('saveRunSnapshot');
    hooks.onSep.mockClear();
    lastES().emit('persistence_capability_degraded', { method: { nope: 1 } });
    const line = hooks.onSep.mock.calls[0][0] as string;
    expect(line).toContain('?');
    expect(line).not.toContain('[object Object]');
  });

  it('resume_journal_skipped：条数/轮号没给就写「若干」/「?」，不拿 0 冒充（#283）', () => {
    const hooks = makeHooks();
    useEventStream(hooks).connect('sess-1');
    lastES().emit('resume_journal_skipped', { count: 3, round: 4, reason: 'crash_round_assistant_not_in_ledger' });
    const full = hooks.onSep.mock.calls[0][0] as string;
    expect(full).toContain('3');
    expect(full).toContain('4');
    hooks.onSep.mockClear();
    lastES().emit('resume_journal_skipped', {});
    const bare = hooks.onSep.mock.calls[0][0] as string;
    expect(bare).toContain('若干');
    expect(bare).toContain('?');
    expect(bare).not.toMatch(/(^|[^0-9])0([^0-9]|$)/);
  });

  it('en 语言下四类都有文案（i18n 两份语言同步；缺 key 会回落中文 ⇒ 这条会红）', async () => {
    setLocale('en');
    const hooks = makeHooks();
    useEventStream(hooks).connect('sess-1');
    lastES().emit('compaction_strategy_fallback', { round: 7 });
    lastES().emit('model_metadata_missing', {});
    lastES().emit('persistence_capability_degraded', { method: 'saveRunSnapshot' });
    lastES().emit('resume_journal_skipped', { count: 2, round: 1 });
    const lines = hooks.onSep.mock.calls.map((c) => c[0] as string);
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line).not.toMatch(/[\u4e00-\u9fff]/); // 一条中文都不该有
      expect(line.length).toBeGreaterThan(10);
    }
  });
});
