// useEventStream 单测：mock EventSource 驱动——补发（last_event_id 续传）、resync 主动重连、
// 陈旧连接事件丢弃、run_end 终态语义（历史 run_end 不干扰当前 run）、水位线推进与合法空洞。
// 语义锚点：portal/static/index.html 内联 JS 的 connectEvents/handleEvent/resyncEvents（§5.1/§5.2）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEventStream, type EventStreamHooks } from './useEventStream';
import { setLocale } from '../i18n';

/** EventSource 桩：记录 URL/close，手动投递具名事件帧（等价旧 static-client.test.js 的 FakeEventSource）。 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
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
}

function makeHooks() {
  return {
    onSep: vi.fn(),
    onSysErr: vi.fn(),
    onToolCardCreated: vi.fn(),
    onCurrentRunEnd: vi.fn(),
    onSessionUpdated: vi.fn(), // issue #88 自动标题刷新
  } satisfies EventStreamHooks;
}

beforeEach(() => {
  // issue #101 P2：事件状态行文案走 i18n 单例（非组件上下文 i18n.global.t），每例固定 zh-CN。
  localStorage.clear();
  setLocale('zh-CN');
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

function lastES() {
  const inst = FakeEventSource.instances;
  return inst[inst.length - 1];
}

describe('useEventStream（mock EventSource）', () => {
  it('首连不带参；?last_event_id=<seq> 续传补发', () => {
    const s = useEventStream(makeHooks());
    s.connect('sess-1');
    expect(lastES().url).toBe('/api/sessions/sess-1/events');

    // 服务端补发 seq > last_event_id 的事件（§5.2）：水位推进、delta 追加、卡片/分隔行正常分发
    lastES().emit('assistant_delta', { seq: 5, text: '你好' });
    lastES().emit('assistant_delta', { seq: 6, text: '世界' });
    expect(s.deltaText.value).toBe('你好世界');
    expect(s.lastSeq.value).toBe(6);

    // 断线重连：携带当前水位作为 last_event_id
    //（connect 自身不关旧连接——旧 connectEvents 语义：关闭由调用方负责，旧连接变「陈旧连接」）
    s.connect('sess-1', s.lastSeq.value);
    expect(lastES().url).toBe('/api/sessions/sess-1/events?last_event_id=6');
    expect(FakeEventSource.instances.length).toBe(2);
  });

  it('水位线只对合法数字推进；seq 空洞（合法空洞 §5.1）不触发任何重连', () => {
    const s = useEventStream(makeHooks());
    s.connect('sess-1');
    lastES().emit('ping', { ts: 'x' }); // 无 seq：不推进
    expect(s.lastSeq.value).toBe(0);
    lastES().emit('tool_use', { seq: 10, tool_call_id: 'c1', name: 'bash', input: { cmd: 'ls' } });
    lastES().emit('assistant_delta', { seq: 13, text: 'hi' }); // 10 → 13 空洞：正常接受
    expect(s.lastSeq.value).toBe(13);
    // 没有产生新的重连（不做事后启发式跳号判定）
    expect(FakeEventSource.instances.length).toBe(1);
    lastES().emit('round_start', { seq: 'oops', round: 1 }); // 非数字 seq：不推进不报错
    expect(s.lastSeq.value).toBe(13);
  });

  it('resync 控制帧 → 主动断开并以 lastSeq 重连（服务端缓冲溢出文案）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('assistant_delta', { seq: 7, text: 'a' });
    const old = lastES();

    lastES().emit('resync', { reason: 'buffer_overflow' });
    expect(old.closed).toBe(true);
    expect(FakeEventSource.instances.length).toBe(2);
    expect(lastES().url).toBe('/api/sessions/sess-1/events?last_event_id=7');
    expect(hooks.onSep).toHaveBeenCalledWith('事件流需重同步（服务端缓冲溢出），正在重连补发…');

    // 未知 reason 兜底 'resync'
    lastES().emit('resync', {});
    expect(lastES().url).toBe('/api/sessions/sess-1/events?last_event_id=7');
    expect(hooks.onSep).toHaveBeenLastCalledWith('事件流需重同步（resync），正在重连补发…');
  });

  it('陈旧连接事件一律忽略（重连后旧连接在途帧不重复渲染/不推进水位）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    const stale = lastES();
    s.connect('sess-1', s.lastSeq.value); // 重连：stale 变为陈旧连接（connect 不关旧连接，由守卫忽略其事件）
    expect(FakeEventSource.instances.length).toBe(2);

    stale.emit('assistant_delta', { seq: 99, text: 'STALE' });
    stale.emit('tool_use', { seq: 100, tool_call_id: 'cx', name: 'x', input: {} });
    expect(s.deltaText.value).toBeNull();
    expect(s.lastSeq.value).toBe(0); // 陈旧帧不得推进水位线
    expect(s.toolCards.size).toBe(0);
    expect(hooks.onSep).not.toHaveBeenCalled();
    expect(hooks.onToolCardCreated).not.toHaveBeenCalled();

    // 新连接正常
    lastES().emit('assistant_delta', { seq: 1, text: 'new' });
    expect(s.deltaText.value).toBe('new');
    expect(s.lastSeq.value).toBe(1);
  });

  it('run_end 终态语义：仅当前 run 参与状态机；历史 run_end 被忽略', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    s.activeRunId.value = 'run-9';
    s.deltaText.value = '流式半截';
    s.toolCards.set('c1', { name: 'bash', dig: '{}', args: '', ok: null, out: '' });

    // 历史重放的旧 run_end（run_id 不匹配）：不得清运行态/不得触发刷新
    lastES().emit('run_end', { seq: 20, run_id: 'run-OLD', termination: { reason: 'end_turn' } });
    expect(s.activeRunId.value).toBe('run-9');
    expect(s.deltaText.value).toBe('流式半截');
    expect(hooks.onCurrentRunEnd).not.toHaveBeenCalled();
    expect(hooks.onSep).not.toHaveBeenCalledWith('run 结束：正常完成');

    // 当前 run 的 run_end：移除增量气泡、end_turn 灰色文案、清运行态、通知宿主刷新
    lastES().emit('run_end', { seq: 21, run_id: 'run-9', termination: { reason: 'end_turn' }, usage: { input_tokens: 3, output_tokens: 5 } });
    expect(s.activeRunId.value).toBeNull();
    expect(s.deltaText.value).toBeNull();
    expect(hooks.onSep).toHaveBeenCalledWith('run 结束：正常完成 · tokens 3+5');
    expect(hooks.onSysErr).not.toHaveBeenCalled();
    expect(hooks.onCurrentRunEnd).toHaveBeenCalledTimes(1);
  });

  it('issue #88 session_updated：通知宿主原地更新标题（live-only 帧，无 seq 不进消息流）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('session_updated', { ts: 'x', session_id: 'sess-1', title: '修复登录白屏' });
    expect(hooks.onSessionUpdated).toHaveBeenCalledTimes(1);
    expect(hooks.onSessionUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'sess-1', title: '修复登录白屏' }),
    );
    // 无 seq：不推进水位线；不产生 sep/syserr（标题不是时间线事件）
    expect(s.lastSeq.value).toBe(0);
    expect(hooks.onSep).not.toHaveBeenCalled();
    expect(hooks.onSysErr).not.toHaveBeenCalled();
  });

  it('run_end 分级：failed 红色 syserr + error 信封；tokens 缺省 0', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    s.activeRunId.value = 'run-1';
    lastES().emit('run_end', { seq: 1, run_id: 'run-1', termination: { reason: 'failed' }, error: { code: 'llm_error', message: 'boom' } });
    expect(hooks.onSysErr).toHaveBeenCalledWith('run 结束：failed'); // 无 usage 字段时不拼 tokens 后缀
    expect(hooks.onSysErr).toHaveBeenCalledWith('run 失败：llm_error — boom');
    expect(hooks.onSep).not.toHaveBeenCalledWith(expect.stringContaining('run 结束'));
  });

  // issue #212：worker 透传引擎 termination 后，这两个 reason 必须到工作台前台（红色 syserr），
  // 绝不能落到灰色中性分隔条分支——尤其 persistence_failed（快照没落盘 = 崩溃恢复可能重复副作用）。
  it('run_end 分级（#212）：persistence_failed 红色 syserr，并显示 operation/phase/sideEffect', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    s.activeRunId.value = 'run-1';
    lastES().emit('run_end', {
      seq: 2,
      run_id: 'run-1',
      termination: {
        reason: 'persistence_failed',
        detail: 'Checkpoint persistence failed before tool execution (runId=sess-1, round=3)',
        operation: 'saveRunState',
        phase: 'checkpoint_before_tool',
        sideEffect: 'not_started',
      },
      usage: { input_tokens: 3, output_tokens: 5 },
    });
    expect(hooks.onSysErr).toHaveBeenCalledWith(
      'run 结束：persistence_failed — 快照未落盘（崩溃恢复可能重复副作用） · 落盘细节 saveRunState/checkpoint_before_tool/not_started · tokens 3+5',
    );
    expect(hooks.onSep).not.toHaveBeenCalled(); // 关键：不是灰色分隔条
    expect(hooks.onCurrentRunEnd).toHaveBeenCalledTimes(1);
  });

  it('run_end 分级（#212）：final_guard_unverified 红色 syserr 带标签；缺 phase 时不拼细节；未列入红色集合的原因仍走灰色 sep', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    // 无 operation/phase/sideEffect（例如 final guard 分支）：只有标签，不出现「落盘细节」
    s.activeRunId.value = 'run-1';
    lastES().emit('run_end', { seq: 3, run_id: 'run-1', termination: { reason: 'persistence_failed' } });
    expect(hooks.onSysErr).toHaveBeenLastCalledWith('run 结束：persistence_failed — 快照未落盘（崩溃恢复可能重复副作用）');
    s.activeRunId.value = 'run-2';
    lastES().emit('run_end', { seq: 4, run_id: 'run-2', termination: { reason: 'final_guard_unverified', detail: 'guard retries exhausted' } });
    expect(hooks.onSysErr).toHaveBeenLastCalledWith('run 结束：final_guard_unverified — 终稿未经核验');
    // 截断类 reason（引擎给出但不在红色集合）保持灰色中性分隔条——本次决策不动它
    s.activeRunId.value = 'run-3';
    lastES().emit('run_end', { seq: 5, run_id: 'run-3', termination: { reason: 'continuation_exhausted' } });
    expect(hooks.onSep).toHaveBeenLastCalledWith('run 结束：continuation_exhausted');
    expect(hooks.onSysErr).toHaveBeenCalledTimes(2); // 只有两次红色，灰色那条不算
  });

  it('run_end 分级（#212）：en 语言下新原因给英文标签（双语齐全，不是只写中文）', () => {
    setLocale('en');
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    s.activeRunId.value = 'run-1';
    lastES().emit('run_end', {
      seq: 6,
      run_id: 'run-1',
      termination: { reason: 'persistence_failed', operation: 'markRunState', phase: 'checkpoint_after_tool', sideEffect: 'maybe_started' },
    });
    expect(hooks.onSysErr).toHaveBeenLastCalledWith(
      'run ended: persistence_failed — run snapshot not persisted (side effects may repeat on resume) · persistence detail markRunState/checkpoint_after_tool/maybe_started',
    );
    s.activeRunId.value = 'run-2';
    lastES().emit('run_end', { seq: 7, run_id: 'run-2', termination: { reason: 'final_guard_unverified' } });
    expect(hooks.onSysErr).toHaveBeenLastCalledWith('run ended: final_guard_unverified — final answer not verified');
  });

  it('tool_use/tool_call_delta/tool_result 卡片生命周期（callId 去重、ok/err、摘要截 120 字）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');

    // tool_call_delta 先行：卡片占位「参数流式生成中…」，args 累加
    lastES().emit('tool_call_delta', { tool_call_id: 'c1', name: 'bash', arguments_delta: '{"cmd"' });
    lastES().emit('tool_call_delta', { tool_call_id: 'c1', arguments_delta: ':"ls"}' });
    expect(hooks.onToolCardCreated).toHaveBeenCalledTimes(1);
    const card = s.toolCards.get('c1')!;
    expect(card.dig).toBe('（参数流式生成中…）');
    expect(card.args).toBe('{"cmd":"ls"}');

    // tool_use 同 callId 去重（不重复占位），args 被整体覆盖（旧版 dataset 覆写语义）
    lastES().emit('tool_use', { tool_call_id: 'c1', name: 'bash', input: { cmd: 'ls' } });
    expect(hooks.onToolCardCreated).toHaveBeenCalledTimes(1);
    expect(s.toolCards.size).toBe(1);
    expect(card.args).toBe('{"cmd":"ls"}');

    // tool_result 回填 ok/out
    lastES().emit('tool_result', { tool_call_id: 'c1', ok: true, result_digest: 'file1 file2', duration_ms: 12 });
    expect(card.ok).toBe(true);
    expect(card.out).toBe('✓ file1 file2（12ms）');

    // 长 input 摘要截 120 字
    lastES().emit('tool_use', { tool_call_id: 'c2', name: 'read', input: { data: 'x'.repeat(500) } });
    expect(s.toolCards.get('c2')!.dig.length).toBe(120);

    // 无卡片时的 tool_result 静默忽略
    lastES().emit('tool_result', { tool_call_id: 'nope', ok: false, result_digest: 'x', duration_ms: 1 });
    expect(s.toolCards.has('nope')).toBe(false);
  });

  it('round/attempt/recovering/judge/compaction/final_guard/forced_final 分隔行文案', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    s.deltaText.value = 'prev';
    lastES().emit('round_start', { round: 2 });
    expect(s.deltaText.value).toBeNull(); // round 切换只 detach 气泡，不做 remove
    lastES().emit('attempt', { round: 2, attempt: 1, maxAttempts: 3 });
    lastES().emit('recovering', { attempt: 2, maxAttempts: 3 });
    lastES().emit('recovered', {});
    lastES().emit('judge', { decision: { extend: true, plan: 'P', extendReason: 'R' } });
    lastES().emit('judge', { decision: { extend: false, extendReason: '够用了' } });
    lastES().emit('judge', { passThrough: 'on_track' });
    lastES().emit('judge', { kind: 'intercept', action: 'executed', decision: { reason: 'ok' } });
    lastES().emit('compaction', { round: 2, compaction: { foldedRounds: 3, tokensBefore: 100, tokensAfter: 40 } });
    lastES().emit('final_guard', { action: 'accept', reason: 'fine' });
    lastES().emit('forced_final', { round: 5, reason: 'cap' });
    expect(hooks.onSep.mock.calls.map((c) => c[0])).toEqual([
      'round 2',
      'round 2 · 尝试 1/3',
      '重试中（2/3）',
      '重试成功',
      'judge：扩轮 — P（R）',
      'judge：不扩轮 — 够用了',
      'judge：放行（on_track）',
      'judge：executed — ok',
      '上下文折叠（round 2）：3 轮折叠，100 → 40 tokens',
      'final guard：accept — fine',
      'forced final（round 5）：cap',
    ]);
    expect(hooks.onSysErr).not.toHaveBeenCalled();
  });

  it('judge 分隔行带 variant=judge，其余状态行（round/compaction 等）不带', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('judge', { decision: { extend: true, plan: 'P', extendReason: 'R' } });
    lastES().emit('judge', { decision: { extend: false, extendReason: '够用了' } });
    lastES().emit('judge', { passThrough: 'on_track' });
    lastES().emit('judge', { kind: 'intercept', action: 'executed', decision: { reason: 'ok' } });
    // judge 四分支均以第二参数 'judge' 产出（面板样式高亮）
    expect(hooks.onSep.mock.calls).toEqual([
      ['judge：扩轮 — P（R）', 'judge'],
      ['judge：不扩轮 — 够用了', 'judge'],
      ['judge：放行（on_track）', 'judge'],
      ['judge：executed — ok', 'judge'],
    ]);

    // 其余状态行保持无 variant 的灰色分隔行语义
    lastES().emit('round_start', { round: 2 });
    lastES().emit('compaction', { round: 2, compaction: { foldedRounds: 3, tokensBefore: 100, tokensAfter: 40 } });
    lastES().emit('final_guard', { action: 'accept', reason: 'fine' });
    lastES().emit('forced_final', { round: 5, reason: 'cap' });
    for (const call of hooks.onSep.mock.calls.slice(4)) {
      expect(call[1]).toBeUndefined();
    }
  });

  it('reasoning_delta/usage/未知类型忽略；畸形 JSON 忽略；ping 忽略', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('reasoning_delta', { text: 'think' });
    lastES().emit('usage', { tokens: 1 });
    lastES().emit('ping', { ts: 'x' });
    lastES().emit('brand_new_event', { seq: 2 }); // 已注册的未知类型帧？走 default 分支需经 handleEvent
    lastES().emit('assistant_delta', '{not json');
    expect(hooks.onSep).not.toHaveBeenCalled();
    expect(s.lastSeq.value).toBe(0); // brand_new_event 未被注册监听，且畸形帧不得推进水位
    expect(s.deltaText.value).toBeNull();
  });

  describe('replayEvent（issue #89 历史回放：刷新后重建展示层）', () => {
    it('历史 tool_use/tool_result → 卡片（与实时同一渲染路径，callId 去重占位一次）', () => {
      const hooks = makeHooks();
      const s = useEventStream(hooks);
      s.replayEvent({ seq: 2, run_id: 'r1', type: 'tool_use', payload: { tool_call_id: 'c1', name: 'bash', input: { cmd: 'ls' } } });
      s.replayEvent({ seq: 3, run_id: 'r1', type: 'tool_result', payload: { tool_call_id: 'c1', ok: true, result_digest: 'file1', duration_ms: 9 } });
      expect(hooks.onToolCardCreated).toHaveBeenCalledTimes(1);
      expect(s.toolCards.size).toBe(1);
      const card = s.toolCards.get('c1')!;
      expect(card.name).toBe('bash');
      expect(card.args).toBe('{"cmd":"ls"}');
      expect(card.ok).toBe(true);
      expect(card.out).toBe('✓ file1（9ms）');

      // 同 callId 二次回放（重复拉取/竞态）不重复占位
      s.replayEvent({ seq: 2, run_id: 'r1', type: 'tool_use', payload: { tool_call_id: 'c1', name: 'bash', input: { cmd: 'ls' } } });
      expect(hooks.onToolCardCreated).toHaveBeenCalledTimes(1);
      expect(s.toolCards.size).toBe(1);
    });

    it('历史 judge → variant=judge 的 sep；round/compaction/final_guard 同样只产 sep', () => {
      const hooks = makeHooks();
      const s = useEventStream(hooks);
      s.replayEvent({ seq: 4, run_id: 'r1', type: 'judge', payload: { decision: { extend: false, extendReason: '够用了' } } });
      s.replayEvent({ seq: 1, run_id: 'r1', type: 'round_start', payload: { round: 1 } });
      s.replayEvent({ seq: 5, run_id: 'r1', type: 'compaction', payload: { round: 2, compaction: { foldedRounds: 1, tokensBefore: 9, tokensAfter: 3 } } });
      s.replayEvent({ seq: 6, run_id: 'r1', type: 'final_guard', payload: { action: 'accept', reason: 'fine' } });
      // vi.fn 不记录末尾 undefined 实参：单参调用表现为 ['文案']
      expect(hooks.onSep.mock.calls).toEqual([
        ['judge：不扩轮 — 够用了', 'judge'],
        ['round 1'],
        ['上下文折叠（round 2）：1 轮折叠，9 → 3 tokens'],
        ['final guard：accept — fine'],
      ]);
    });

    it('红线：历史 run_end 强制短路——不驱动状态机（不通知宿主/不动 activeRunId/不产 sep）', () => {
      const hooks = makeHooks();
      const s = useEventStream(hooks);
      s.activeRunId.value = 'run-CURRENT';
      // 模拟服务端误下发当前 run 的 run_end：history 模式也不得触发 onCurrentRunEnd
      s.replayEvent({ seq: 9, run_id: 'run-CURRENT', type: 'run_end', payload: { termination: { reason: 'end_turn' } } });
      // 历史 run 的 run_end 同样忽略
      s.replayEvent({ seq: 8, run_id: 'run-OLD', type: 'run_end', payload: { termination: { reason: 'failed' } } });
      expect(hooks.onCurrentRunEnd).not.toHaveBeenCalled();
      expect(hooks.onSep).not.toHaveBeenCalled();
      expect(hooks.onSysErr).not.toHaveBeenCalled();
      expect(s.activeRunId.value).toBe('run-CURRENT');
    });

    it('白名单外类型（assistant_delta/usage/heartbeat）忽略：不产生增量气泡', () => {
      const hooks = makeHooks();
      const s = useEventStream(hooks);
      s.replayEvent({ seq: 2, run_id: 'r1', type: 'assistant_delta', payload: { text: '半截' } });
      s.replayEvent({ seq: 3, run_id: 'r1', type: 'usage', payload: { usage: {} } });
      s.replayEvent({ seq: 4, run_id: 'r1', type: 'heartbeat', payload: {} });
      expect(s.deltaText.value).toBeNull();
      expect(s.lastSeq.value).toBe(0);
      expect(hooks.onSep).not.toHaveBeenCalled();
    });

    it('不推进水位线（openSession 已按 detail.last_seq 初始化）；历史卡片可被实时 tool_result 回填', () => {
      const hooks = makeHooks();
      const s = useEventStream(hooks);
      s.lastSeq.value = 7; // openSession 预置
      s.replayEvent({ seq: 5, run_id: 'r1', type: 'tool_use', payload: { tool_call_id: 'c1', name: 'bash', input: {} } });
      expect(s.lastSeq.value).toBe(7);

      // 实时路径同 callId 回填（历史与实时同一 toolCards 渲染路径的直接证据）
      s.connect('sess-1');
      lastES().emit('tool_result', { seq: 8, tool_call_id: 'c1', ok: false, result_digest: 'boom', duration_ms: 3 });
      expect(s.toolCards.get('c1')!.ok).toBe(false);
      expect(s.toolCards.get('c1')!.out).toBe('✗ boom（3ms）');
      expect(s.lastSeq.value).toBe(8);
    });
  });

  it('resetStreamState 复位全部协议状态并断开连接', () => {
    const s = useEventStream(makeHooks());
    s.connect('sess-1');
    s.lastSeq.value = 9;
    s.activeRunId.value = 'run-1';
    s.deltaText.value = 'x';
    s.toolCards.set('c1', { name: 't', dig: '', args: '', ok: null, out: '' });
    const old = lastES();
    s.resetStreamState();
    expect(old.closed).toBe(true);
    expect(s.lastSeq.value).toBe(0);
    expect(s.activeRunId.value).toBeNull();
    expect(s.deltaText.value).toBeNull();
    expect(s.toolCards.size).toBe(0);
    expect(s.esSessionId.value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// issue #101 P2：事件状态行/错误行文案走 i18n（zh-CN 基线逐字不变，切 en 即时生效）
// ---------------------------------------------------------------------------
describe('useEventStream · i18n（issue #101 P2）', () => {
  it('zh-CN 基线：状态行/工具卡片结果行/重同步文案逐字不变', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('recovering', { attempt: 2, maxAttempts: 3 });
    lastES().emit('compaction', { round: 1, compaction: { foldedRounds: 2, tokensBefore: 9, tokensAfter: 4 } });
    lastES().emit('judge', { decision: { extend: true, plan: 'P', extendReason: 'R' } });
    lastES().emit('tool_use', { tool_call_id: 'c1', name: 'bash', input: { cmd: 'ls' } });
    lastES().emit('tool_result', { tool_call_id: 'c1', ok: true, result_digest: 'ok', duration_ms: 5 });
    lastES().emit('resync', { reason: 'buffer_overflow' });
    expect(hooks.onSep.mock.calls.map((c) => c[0])).toEqual([
      '重试中（2/3）',
      '上下文折叠（round 1）：2 轮折叠，9 → 4 tokens',
      'judge：扩轮 — P（R）',
      '事件流需重同步（服务端缓冲溢出），正在重连补发…',
    ]);
    expect(s.toolCards.get('c1')!.out).toBe('✓ ok（5ms）');
  });

  it('切 English：状态行 / judge 后缀 / 工具卡片结果行 / 重同步文案即时变英文', () => {
    setLocale('en');
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('recovering', { attempt: 2, maxAttempts: 3 });
    lastES().emit('recovered', {});
    lastES().emit('judge', { decision: { extend: true, plan: 'P', extendReason: 'R' } });
    lastES().emit('judge', { decision: { extend: false, extendReason: 'enough' } });
    lastES().emit('judge', { passThrough: 'on_track' });
    lastES().emit('compaction', { round: 1, compaction: { foldedRounds: 2, tokensBefore: 9, tokensAfter: 4 } });
    lastES().emit('forced_final', { round: 5, reason: 'cap' });
    lastES().emit('tool_use', { tool_call_id: 'c1', name: 'bash', input: { cmd: 'ls' } });
    lastES().emit('tool_result', { tool_call_id: 'c1', ok: true, result_digest: 'ok', duration_ms: 5 });
    expect(hooks.onSep.mock.calls.map((c) => c[0])).toEqual([
      'Retrying (2/3)',
      'Retry succeeded',
      'judge: extend rounds — P (R)',
      'judge: no extension — enough',
      'judge: pass through (on_track)',
      'Context compaction (round 1): 2 rounds folded, 9 → 4 tokens',
      'forced final (round 5): cap',
    ]);
    expect(s.toolCards.get('c1')!.out).toBe('✓ ok (5ms)');

    // 事件流重同步 + run 终态/失败分级
    s.activeRunId.value = 'run-1';
    lastES().emit('resync', { reason: 'buffer_overflow' });
    expect(hooks.onSep).toHaveBeenLastCalledWith('Event stream needs resync (server buffer overflow); reconnecting to catch up…');
    lastES().emit('run_end', { seq: 9, run_id: 'run-1', termination: { reason: 'end_turn' }, usage: { input_tokens: 3, output_tokens: 5 } });
    expect(hooks.onSep).toHaveBeenLastCalledWith('run ended: completed normally · tokens 3+5');
    lastES().emit('run_end', { seq: 10, run_id: null, termination: { reason: 'failed' }, error: { code: 'llm_error', message: 'boom' } });
    expect(hooks.onSysErr).toHaveBeenLastCalledWith('run failed: llm_error — boom');
  });
});

describe('issue #188：projectToolCard（DTO 投影路径）', () => {
  it('首次登记占位一次并透传上游字段；同 callId 再登记不重复占位', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);

    s.projectToolCard('c1', {
      name: 'read', argsSummary: 'path=src/a.js', resultPreview: 'FILE BODY',
      isError: false, executionStatus: 'succeeded',
    });
    expect(hooks.onToolCardCreated).toHaveBeenCalledTimes(1);
    expect(hooks.onToolCardCreated).toHaveBeenCalledWith('c1');
    const card = s.toolCards.get('c1')!;
    expect(card.name).toBe('read');
    expect(card.dig).toBe('path=src/a.js');
    expect(card.argsSummary).toBe('path=src/a.js');
    expect(card.resultPreview).toBe('FILE BODY');
    expect(card.executionStatus).toBe('succeeded');
    expect(card.ok).toBe(true);

    // 第二次（同一调用的另一路 DTO 消息 / 重复加载）→ 幂等：不再占位
    s.projectToolCard('c1', { name: 'read', argsSummary: 'path=src/a.js' });
    expect(hooks.onToolCardCreated).toHaveBeenCalledTimes(1);
  });

  it('事件流先建的卡片：投影只补全缺失字段，不覆盖实时完整数据', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);

    s.handleEvent('tool_use', { data: JSON.stringify({ tool_call_id: 'c1', name: 'read', input: { path: 'src/a.js' } }) } as MessageEvent);
    s.projectToolCard('c1', {
      name: 'read', argsSummary: 'path=src/a.js', resultPreview: 'FILE BODY', executionStatus: 'succeeded',
    });
    const card = s.toolCards.get('c1')!;
    expect(card.args).toBe('{"path":"src/a.js"}'); // 实时路径的完整 args 保留
    expect(card.argsSummary).toBe('path=src/a.js'); // 投影补全缺失字段
    expect(card.resultPreview).toBe('FILE BODY');
    expect(hooks.onToolCardCreated).toHaveBeenCalledTimes(1);
  });

  it('isError=true → ok=false；仅 name 无结果 → ok=null', () => {
    const s = useEventStream(makeHooks());
    s.projectToolCard('err', { name: 'bash', isError: true, resultPreview: 'boom' });
    s.projectToolCard('pending', { name: 'read' });
    expect(s.toolCards.get('err')!.ok).toBe(false);
    expect(s.toolCards.get('pending')!.ok).toBeNull();
  });
});
