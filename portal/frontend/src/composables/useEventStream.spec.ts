// useEventStream 单测：mock EventSource 驱动——补发（last_event_id 续传）、resync 主动重连、
// 陈旧连接事件丢弃、run_end 终态语义（历史 run_end 不干扰当前 run）、水位线推进与合法空洞。
// 语义锚点：portal/static/index.html 内联 JS 的 connectEvents/handleEvent/resyncEvents（§5.1/§5.2）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEventStream, type EventStreamHooks } from './useEventStream';

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
