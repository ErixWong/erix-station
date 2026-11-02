// issue #421 判据（前端行为面）+ issue #438 切片 B（0.29.0 的 19 类与联合外的那几类）。
//
// 「三处集合是否齐」这种**结构**对账不在这里（跨端读后端源码在 jsdom 下只能走 vite `?raw`，而
// vite 的 fs 边界不许越出 `portal/frontend`，issue #349）——那部分住在
// `portal/test/event-surface-contract.test.js`，而且从 #438 起它**从已安装引擎源码解析**
// `LoopEvent` 联合类型（不再手抄）。本文件**故意不再抄一份引擎清单**（那正是本片要治的病）：
// 引擎侧的对账归那条 node 测，这里只证**行为**：
//   · `EVENT_TYPES` 里的每一类都真被 `addEventListener` 过（`FakeEventSource` 只投得住订过的类型）；
//   · 实时帧与历史回放帧是否都落到同一行中性分隔行（`HISTORY_REPLAY_TYPES` 的活证）；
//   · 豁免的那几类：订得到，但**不刷行**（写了决定就得真的不刷）；
//   · 文案里的数字缺了就是缺了（不拿 0 冒充，#283），脏值不渗 `[object Object]`（#261）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENT_TYPES, useEventStream, type EventStreamHooks } from './useEventStream';
import { setLocale } from '../i18n';

/** #421 新接的四类诊断事件（#438 又在同一族里加了 `compaction_deferred` / `budget_below_working_set`）。 */
const DIAGNOSTIC_EVENTS = [
  'compaction_strategy_fallback', 'model_metadata_missing',
  'persistence_capability_degraded', 'resume_journal_skipped',
  // issue #438 切片 B：`LoopEvent` 联合类型新增、本站裁定「进时间线」的两类。
  'compaction_deferred', 'budget_below_working_set',
];

/**
 * #438 切片 B：**豁免**（订得到、但不刷行、不回放）。理由在 `portal/test/event-surface-contract.test.js`
 * 的豁免表里；这里只钉「决定真的被执行了」（订了 + 不刷行）。
 */
const EXEMPT_EVENTS = ['run_outcome', 'config_override_conflict', 'continuity_injection_skipped'];

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

describe('#421/#438 承接面（行为面）', () => {
  it('`EVENT_TYPES` 里的每一类都真被订上（漏一类就是浏览器一条都收不到，且不报错不警告）', () => {
    useEventStream(makeHooks()).connect('sess-1');
    const subscribed = new Set(lastES().listeners.keys());
    // 不在这里另抄一份引擎清单：`EVENT_TYPES` 与引擎 `LoopEvent` 联合类型的对账归
    // `portal/test/event-surface-contract.test.js`（它从已安装引擎源码解析，本文件读不到那里）。
    expect(EVENT_TYPES.length).toBeGreaterThan(20);
    for (const type of EVENT_TYPES) {
      expect(subscribed.has(type), `未监听 ${type}`).toBe(true);
    }
  });

  it('六类诊断事件：实时帧与历史回放帧都刷同一行中性分隔行', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    for (const type of DIAGNOSTIC_EVENTS) {
      hooks.onSep.mockClear();
      lastES().emit(type, { round: 2, count: 1, method: 'saveRunSnapshot', reason: 'pending_tool_use', budgetTokens: 9000, workingSetTokens: 15000, attempts: 3, suggestedBudgetTokens: 24000 });
      expect(hooks.onSep.mock.calls.length, `${type} 实时不刷行`).toBe(1);
      hooks.onSep.mockClear();
      s.replayEvent({ seq: 1, run_id: 'r1', type, payload: { round: 2, count: 1, method: 'saveRunSnapshot', reason: 'pending_tool_use', budgetTokens: 9000, workingSetTokens: 15000, attempts: 3, suggestedBudgetTokens: 24000 } });
      expect(hooks.onSep.mock.calls.length, `${type} 漏在 HISTORY_REPLAY_TYPES ⇒ 刷新后消失`).toBe(1);
    }
    expect(hooks.onSysErr).not.toHaveBeenCalled(); // 全是中性行：它们不是失败
  });

  it('豁免的那几类：订得到、但**不刷时间线**（决定写了就得真执行；理由钉在 portal/test/event-surface-contract.test.js）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    for (const type of EXEMPT_EVENTS) {
      expect(lastES().listeners.has(type), `${type} 订都订不到就不叫豁免`).toBe(true);
      lastES().emit(type, { rounds: 3, termination: { reason: 'end_turn' }, conflicts: [{ path: 'run.maxRounds' }] });
      s.replayEvent({ seq: 1, run_id: 'r1', type, payload: { rounds: 3 } });
    }
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

  // issue #438 切片 B：`LoopEvent` 新增的两类——载荷形状对着引擎发射点写（orchestrator.js:4884 / :4056）。
  it('compaction_deferred：说清「这轮没折」与原因；数字缺就 ?，不拿 0 冒充', () => {
    const hooks = makeHooks();
    useEventStream(hooks).connect('sess-1');
    lastES().emit('compaction_deferred', { round: 3, reason: 'pending_tool_use' });
    const line = hooks.onSep.mock.calls[0][0] as string;
    expect(line).toContain('3');
    expect(line).toContain('pending_tool_use');
    expect(line).toContain('未折叠');
    hooks.onSep.mockClear();
    // 脏 reason 过形状闸（#261），缺 round 写 ?（#283）
    lastES().emit('compaction_deferred', { reason: { nope: 1 } });
    const dirty = hooks.onSep.mock.calls[0][0] as string;
    expect(dirty).toContain('?');
    expect(dirty).not.toContain('[object Object]');
    expect(dirty).not.toMatch(/(^|[^0-9])0([^0-9]|$)/);
  });

  it('budget_below_working_set：三个数字原样给出（工作集 / 预算 / 建议），缺了就 ?', () => {
    const hooks = makeHooks();
    useEventStream(hooks).connect('sess-1');
    lastES().emit('budget_below_working_set', {
      round: 5, budgetTokens: 9000, workingSetTokens: 15000, attempts: 3, suggestedBudgetTokens: 24000,
    });
    const line = hooks.onSep.mock.calls[0][0] as string;
    for (const needle of ['15000', '9000', '3', '24000']) expect(line, needle).toContain(needle);
    hooks.onSep.mockClear();
    lastES().emit('budget_below_working_set', {});
    const bare = hooks.onSep.mock.calls[0][0] as string;
    expect(bare).toContain('?');
    expect(bare).not.toMatch(/(^|[^0-9])0([^0-9]|$)/);
  });

  it('en 语言下六类都有文案（i18n 两份语言同步；缺 key 会回落中文 ⇒ 这条会红）', async () => {
    setLocale('en');
    const hooks = makeHooks();
    useEventStream(hooks).connect('sess-1');
    lastES().emit('compaction_strategy_fallback', { round: 7 });
    lastES().emit('model_metadata_missing', {});
    lastES().emit('persistence_capability_degraded', { method: 'saveRunSnapshot' });
    lastES().emit('resume_journal_skipped', { count: 2, round: 1 });
    lastES().emit('compaction_deferred', { round: 3, reason: 'pending_tool_use' });
    lastES().emit('budget_below_working_set', { budgetTokens: 9000, workingSetTokens: 15000, attempts: 3, suggestedBudgetTokens: 24000 });
    const lines = hooks.onSep.mock.calls.map((c) => c[0] as string);
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(line).not.toMatch(/[\u4e00-\u9fff]/); // 一条中文都不该有
      expect(line.length).toBeGreaterThan(10);
    }
  });
});
