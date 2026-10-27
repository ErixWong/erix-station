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
    // issue #236：`failed` 也有母语标签了（此前上屏是裸英文 `failed`）
    expect(hooks.onSysErr).toHaveBeenCalledWith('run 结束：failed — 运行失败'); // 无 usage 字段时不拼 tokens 后缀
    expect(hooks.onSysErr).toHaveBeenCalledWith('run 失败：llm_error — boom');
    expect(hooks.onSep).not.toHaveBeenCalledWith(expect.stringContaining('run 结束'));
  });

  // issue #261：引擎 0.18.0 在 `reason === "failed"` 的终局 additive 透出 `termination.errorCode`
  // （值域由引擎定义，station 原样透传），前端把它贴到失败横幅末尾——R-2 演练里 8 次 provider
  // 超时杀 run，用户看不出是 timeout 还是 auth，只能盲重发。
  it('run_end 失败横幅（#261）：termination.errorCode 非空时原文追加（code=…）到终局文案末尾', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    s.activeRunId.value = 'run-1';
    lastES().emit('run_end', {
      seq: 1, run_id: 'run-1',
      termination: { reason: 'failed', detail: 'upstream timeout', errorCode: 'timeout' },
      usage: { input_tokens: 3, output_tokens: 5 },
    });
    // 追加位置在文案**末尾**（tokens 后缀由外层 i18n 模板拼接，故 code 在 reason 片段末尾、tokens 之前）
    expect(hooks.onSysErr).toHaveBeenLastCalledWith('run 结束：failed — 运行失败（code=timeout） · tokens 3+5');
    // 与 error 信封并存：两行各自成立，互不覆盖
    s.activeRunId.value = 'run-2';
    lastES().emit('run_end', {
      seq: 2, run_id: 'run-2',
      termination: { reason: 'failed', errorCode: 'rate_limited' },
      error: { code: 'rate_limited', message: '429' },
    });
    expect(hooks.onSysErr).toHaveBeenNthCalledWith(2, 'run 结束：failed — 运行失败（code=rate_limited）');
    expect(hooks.onSysErr).toHaveBeenNthCalledWith(3, 'run 失败：rate_limited — 429');
  });

  it('run_end 失败横幅（#261）：无/空 errorCode 时终局文案逐字不变；非字符串也不渗进文案', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    // 旧 run / 旧引擎：termination 里没有 errorCode 键
    s.activeRunId.value = 'run-1';
    lastES().emit('run_end', { seq: 1, run_id: 'run-1', termination: { reason: 'failed' } });
    expect(hooks.onSysErr).toHaveBeenLastCalledWith('run 结束：failed — 运行失败');
    // 显式空串 / null / 非字符串：一律不追加（不能让 `（code=undefined）` 渗进用户可见文案）
    // issue #236：`aborted` 已改判中性分隔条（用户按停止不是故障）⇒ 看 onSep。
    s.activeRunId.value = 'run-2';
    lastES().emit('run_end', { seq: 2, run_id: 'run-2', termination: { reason: 'aborted', errorCode: '' } });
    expect(hooks.onSep).toHaveBeenLastCalledWith('run 结束：aborted — 已中止');
    s.activeRunId.value = 'run-3';
    lastES().emit('run_end', { seq: 3, run_id: 'run-3', termination: { reason: 'aborted', errorCode: null } });
    expect(hooks.onSep).toHaveBeenLastCalledWith('run 结束：aborted — 已中止');
    s.activeRunId.value = 'run-4';
    lastES().emit('run_end', { seq: 4, run_id: 'run-4', termination: { reason: 'max_rounds_cap', errorCode: 7 } });
    expect(hooks.onSysErr).toHaveBeenLastCalledWith('run 结束：max_rounds_cap — 达到轮数上限');
    // 与既有标签/落盘细节片段共存：errorCode 缺失时 persistence_failed 的老文案一字不动
    s.activeRunId.value = 'run-5';
    lastES().emit('run_end', { seq: 5, run_id: 'run-5', termination: { reason: 'persistence_failed' } });
    expect(hooks.onSysErr).toHaveBeenLastCalledWith('run 结束：persistence_failed — 快照未落盘（崩溃恢复可能重复副作用）');
    // 红色与中性两路都不得带 code 片段
    const allLines = [...hooks.onSysErr.mock.calls, ...hooks.onSep.mock.calls].map((c) => String(c[0]));
    expect(allLines.every((line) => !line.includes('code='))).toBe(true);
  });

  // 技术细节不进 i18n（工单 #261B）：英文界面下同样原样透出，不新增词条、不回落中文。
  it('run_end 失败横幅（#261）：en 界面下 code 片段同形（不进 i18n）', () => {
    setLocale('en');
    try {
      const hooks = makeHooks();
      const s = useEventStream(hooks);
      s.connect('sess-1');
      s.activeRunId.value = 'run-1';
      lastES().emit('run_end', { seq: 1, run_id: 'run-1', termination: { reason: 'failed', errorCode: 'timeout' } });
      expect(hooks.onSysErr).toHaveBeenLastCalledWith('run ended: failed — run failed（code=timeout）');
      s.activeRunId.value = 'run-2';
      lastES().emit('run_end', { seq: 2, run_id: 'run-2', termination: { reason: 'failed' } });
      expect(hooks.onSysErr).toHaveBeenLastCalledWith('run ended: failed — run failed');
    } finally {
      setLocale('zh-CN');
    }
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
    // 截断类 reason（引擎给出但不在红色集合）保持灰色中性分隔条——本次决策不动它；
    // issue #236：文案从裸英文枚举改为母语标签。
    s.activeRunId.value = 'run-3';
    lastES().emit('run_end', { seq: 5, run_id: 'run-3', termination: { reason: 'continuation_exhausted' } });
    expect(hooks.onSep).toHaveBeenLastCalledWith('run 结束：continuation_exhausted — 续跑次数耗尽');
    expect(hooks.onSysErr).toHaveBeenCalledTimes(2); // 只有两次红色，灰色那条不算
  });

  // issue #236 §1 第 1 条：`aborted` 等 reason 的母语标签 + 呈现分级（实时与历史共用一条规则）。
  it('run_end（#236）：aborted 走**中性**分隔条 + 母语「已中止」；失败类仍红；未知 reason 回落原文', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    // ① 用户按停止 ⇒ 中性分隔条（此前是红色 syserr + 裸英文 aborted）
    s.activeRunId.value = 'run-1';
    lastES().emit('run_end', { seq: 1, run_id: 'run-1', termination: { reason: 'aborted' } });
    expect(hooks.onSep).toHaveBeenLastCalledWith('run 结束：aborted — 已中止');
    expect(hooks.onSysErr).not.toHaveBeenCalled();
    // ② failed / persistence_failed / final_guard_unverified 仍是红色（**没有把红色降级成中性**）
    for (const [i, reason] of ['failed', 'persistence_failed', 'final_guard_unverified'].entries()) {
      s.activeRunId.value = `run-red-${i}`;
      lastES().emit('run_end', { seq: 10 + i, run_id: `run-red-${i}`, termination: { reason } });
      expect(hooks.onSysErr, `reason=${reason} 必须仍走 .syserr`).toHaveBeenCalledTimes(i + 1);
    }
    // ③ 引擎新增的未知 reason：不在标签表里 ⇒ 逐字透传原文（不编造翻译，§5.3）
    s.activeRunId.value = 'run-unknown';
    lastES().emit('run_end', { seq: 20, run_id: 'run-unknown', termination: { reason: 'some_future_reason' } });
    expect(hooks.onSep).toHaveBeenLastCalledWith('run 结束：some_future_reason');
  });

  // issue #236：历史合成项 `run_termination` 的取词/分级入口（**与实时 run_end 共用同一个函数**）。
  it('historyRunEndEntry（#236）：历史项与实时同文案同分级；脏载荷 ⇒ null（不编 reason）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    const hist = (payload: Record<string, unknown>) => ({ seq: 1, run_id: 'r1', type: 'run_termination', payload });
    expect(s.historyRunEndEntry(hist({ status: 'finished', termination: { reason: 'aborted' } })))
      .toEqual({ kind: 'sep', text: 'run 结束：aborted — 已中止' });
    expect(s.historyRunEndEntry(hist({ termination: { reason: 'failed', errorCode: 'timeout' } })))
      .toEqual({ kind: 'syserr', text: 'run 结束：failed — 运行失败（code=timeout）' });
    expect(s.historyRunEndEntry(hist({ termination: { reason: 'end_turn' } })))
      .toEqual({ kind: 'sep', text: 'run 结束：正常完成' });
    for (const dirty of [{}, { termination: null }, { termination: { reason: '' } }, { termination: { reason: 7 } }]) {
      expect(s.historyRunEndEntry(hist(dirty)), `脏载荷不得渲染：${JSON.stringify(dirty)}`).toBeNull();
    }
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

  // issue #228：上游 erix-agent 文件工具的返回形态按工具分三套（readFile/tree/edit → string，
  // searchText → {content, metadata}，writeFile → number）。事件里给到哪一种都必须能摘要，
  // 且不得渲染成 "[object Object]"，也不得把 number 0 当成「没有结果」丢掉。
  it('tool_result 三种返回形态都能摘要（string / {content, metadata} / number；含 0 与缺失）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');

    // ① string：readFile 的正文（截断信息写在尾部 marker 里）
    lastES().emit('tool_use', { tool_call_id: 'r', name: 'readFile', input: { path: 'a.txt' } });
    lastES().emit('tool_result', {
      tool_call_id: 'r', ok: true, duration_ms: 3,
      result_digest: '1: hello\n[共 12 行，剩余 7 行；下一步：readFile 传 offset=5 继续]',
    });
    expect(s.toolCards.get('r')!.out).toBe('✓ 1: hello\n[共 12 行，剩余 7 行；下一步：readFile 传 offset=5 继续]（3ms）');

    // ② {content, metadata}：searchText 的结构化结果 → 只展示 content（metadata 不上 UI）
    lastES().emit('tool_use', { tool_call_id: 's', name: 'searchText', input: { pattern: 'hit', mode: 'literal' } });
    lastES().emit('tool_result', {
      tool_call_id: 's', ok: true, duration_ms: 7,
      result_digest: { content: 'a.js:1:hit', metadata: { searchHits: 1, searchSkipped: { vendorDirectories: 2 } } },
    });
    const searchCard = s.toolCards.get('s')!;
    expect(searchCard.out).toBe('✓ a.js:1:hit（7ms）');
    expect(searchCard.out).not.toContain('[object Object]');
    expect(searchCard.out).not.toContain('vendorDirectories');

    // ③ number：writeFile 返回写入字节数；0 也必须正常显示（不是「无结果」）
    lastES().emit('tool_use', { tool_call_id: 'w', name: 'writeFile', input: { path: 'b.txt', content: '' } });
    lastES().emit('tool_result', { tool_call_id: 'w', ok: true, duration_ms: 1, result_digest: 0 });
    expect(s.toolCards.get('w')!.out).toBe('✓ 0（1ms）');

    // ④ 缺失（null / undefined）不炸，摘要退化成空串
    lastES().emit('tool_use', { tool_call_id: 'n', name: 'tree', input: {} });
    lastES().emit('tool_result', { tool_call_id: 'n', ok: true, duration_ms: 2, result_digest: null });
    expect(s.toolCards.get('n')!.out).toBe('✓ （2ms）');
    lastES().emit('tool_result', { tool_call_id: 'n', ok: true, duration_ms: 2 });
    expect(s.toolCards.get('n')!.out).toBe('✓ （2ms）');
  });

  // issue #283：引擎 0.18.0 只给结构化返回写 duration ⇒ 真库里 98% 的 tool_result 没时长，
  // 而旧代码 `d.duration_ms ?? 0` 把「没有」伪装成 0（现象：每条工具调用恒显 0s）。
  it('issue #283：缺 duration_ms ⇒ card.dur 保持 undefined、文案不出现 0ms/undefined/空括号', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');

    lastES().emit('tool_use', { tool_call_id: 'd1', name: 'shell', input: { command: 'sleep 5' } });
    lastES().emit('tool_result', { tool_call_id: 'd1', ok: true, result_digest: 'slept' }); // 无 duration_ms
    const card = s.toolCards.get('d1')!;
    // 变异取证②：把 `?? 0` 加回 card.dur 就红在本行
    expect(card.dur).toBeUndefined();
    expect(card.out).toBe('✓ slept');
    for (const junk of ['0ms', '0s', 'undefined', 'null', '（）', '()']) expect(card.out).not.toContain(junk);

    // worker 没时长时下发的是 **null**（runner/worker.js 保持 null 语义）⇒ 同样不算有时长
    lastES().emit('tool_use', { tool_call_id: 'd2', name: 'shell', input: {} });
    lastES().emit('tool_result', { tool_call_id: 'd2', ok: false, duration_ms: null, result_digest: 'boom' });
    expect(s.toolCards.get('d2')!.dur).toBeUndefined();
    expect(s.toolCards.get('d2')!.out).toBe('✗ boom');

    // 非数字（字符串）也不冒充时长：宁可不显示，不给一个假的耗时
    lastES().emit('tool_use', { tool_call_id: 'd3', name: 'shell', input: {} });
    lastES().emit('tool_result', { tool_call_id: 'd3', ok: true, duration_ms: '12', result_digest: 'x' });
    expect(s.toolCards.get('d3')!.dur).toBeUndefined();
    expect(s.toolCards.get('d3')!.out).toBe('✓ x');
  });

  it('issue #283：有时长走可读单位三档（999 ⇒ 999ms、4321 ⇒ 4.3s、65000 ⇒ 1m 5s），card.dur 仍是毫秒原值', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    const cases: Array<[number, string]> = [[999, '999ms'], [4321, '4.3s'], [65000, '1m 5s'], [12, '12ms']];
    for (const [ms, text] of cases) {
      const callId = `c${ms}`;
      lastES().emit('tool_use', { tool_call_id: callId, name: 'shell', input: {} });
      lastES().emit('tool_result', { tool_call_id: callId, ok: true, duration_ms: ms, result_digest: 'done' });
      const card = s.toolCards.get(callId)!;
      expect(card.out).toBe(`✓ done（${text}）`);
      expect(card.dur).toBe(ms); // 卡片存原值毫秒，展示时才格式化
    }
  });

  it('投影卡片（DTO 路径）的 resultPreview 同样过归一：number/对象不炸、0 不被丢', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.projectToolCard('p1', { name: 'writeFile', argsSummary: 'path=b.txt', resultPreview: 0, executionStatus: 'succeeded' });
    const card = s.toolCards.get('p1')!;
    expect(card.resultPreview).toBe('0');
    expect(card.ok).toBe(true);
    s.projectToolCard('p2', {
      name: 'searchText',
      resultPreview: { content: 'a.js:1:hit', metadata: { searchHits: 1 } },
      isError: false,
    });
    expect(s.toolCards.get('p2')!.resultPreview).toBe('a.js:1:hit');
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
      'judge：建议扩轮 — P（R）',
      'judge：不建议扩轮 — 够用了',
      'judge：工具审计：已放行（on_track，非任务完成）',
      'judge：工具审计：已放行（非任务完成） · 评审理由：ok',
      '上下文折叠（round 2，策略 未知）：3 轮折叠，100 → 40 tokens',
      'final guard：accept — fine',
      'forced final（round 5）：cap',
    ]);
    expect(hooks.onSysErr).not.toHaveBeenCalled();
  });

  // #464 A（本站 D 片）：事件里带实例策略名时必须原样显示——它是「这次折叠到底是谁做的」的唯一实时答案，
  // 而空串/缺字段一律显式成「未知」，不能让人以为策略名字是空的。
  it('compaction 分隔行显示实例策略名（缺失时显式「未知」）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('compaction', {
      round: 9,
      compaction: { foldedRounds: 46, tokensBefore: 261345, tokensAfter: 8000, strategyName: 'fold-statistical' },
    });
    expect(hooks.onSep.mock.calls.map((c) => c[0])).toEqual([
      '上下文折叠（round 9，策略 fold-statistical）：46 轮折叠，261345 → 8000 tokens',
    ]);
  });

  it('judge 分隔行带 variant=judge，其余状态行（round/compaction 等）不带', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('judge', { decision: { extend: true, plan: 'P', extendReason: 'R' } });
    lastES().emit('judge', { decision: { extend: false, extendReason: '够用了' } });
    lastES().emit('judge', { passThrough: 'on_track' });
    lastES().emit('judge', { kind: 'intercept', action: 'executed', decision: { reason: 'ok' } });
    // judge 四分支均以第二参数 'judge' 产出（面板样式高亮；issue #321 分轴文案）
    expect(hooks.onSep.mock.calls).toEqual([
      ['judge：建议扩轮 — P（R）', 'judge'],
      ['judge：不建议扩轮 — 够用了', 'judge'],
      ['judge：工具审计：已放行（on_track，非任务完成）', 'judge'],
      ['judge：工具审计：已放行（非任务完成） · 评审理由：ok', 'judge'],
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
      // issue #279：身份键含 run（这批回放事件没有 round_start ⇒ 轮号段不拼）⇒ 键是 `r1:c1`，不再是裸 `c1`。
      const card = s.toolCards.get('r1:c1')!;
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
        ['judge：不建议扩轮 — 够用了', 'judge'],
        ['round 1'],
        ['上下文折叠（round 2，策略 未知）：1 轮折叠，9 → 3 tokens'],
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

      // 实时路径同 callId 回填（历史与实时同一 toolCards 渲染路径的直接证据）。
      // issue #279：这条实时帧**不带 run_id** ⇒ 精确身份键是裸 `c1`、命不中历史那张 `r1:c1`，
      // 靠「callId → 最新卡片」的关联索引找回同一张（结果关联不拿轮号当尺，见 cardForCorrelation）。
      s.connect('sess-1');
      lastES().emit('tool_result', { seq: 8, tool_call_id: 'c1', ok: false, result_digest: 'boom', duration_ms: 3 });
      expect(s.toolCards.get('r1:c1')!.ok).toBe(false);
      expect(s.toolCards.get('r1:c1')!.out).toBe('✗ boom（3ms）');
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
      '上下文折叠（round 1，策略 未知）：2 轮折叠，9 → 4 tokens',
      'judge：建议扩轮 — P（R）',
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
      'judge: suggests extending rounds — P (R)',
      'judge: suggests no extension — enough',
      'judge: tool audit: released (on_track; not task completion)',
      'Context compaction (round 1, strategy unknown): 2 rounds folded, 9 → 4 tokens',
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

// ---------------------------------------------------------------------------
// issue #299 (c)（erix-agent 0.20.0 / host-upgrade-guide-0.20.0 §7）：
// `executionStatus` **只在两种特殊状态下存在**（`intercepted` / `interrupted`），普通块上**缺席**。
// ⇒ 判「值得关注」必须**拿值比**（`isSpecialExecutionStatus`），**不得**拿「字段在不在」当判据。
// 变异靶：把判据改回 `fields.executionStatus !== undefined` ⇒ 本块必须红。
// ---------------------------------------------------------------------------
describe('issue #299：executionStatus 只在特殊状态存在（值比对，不是存在性）', () => {
  it('普通成功块**不带**该键 ⇒ 卡片正常成 ok=true，不出现异常态', () => {
    const s = useEventStream(makeHooks());
    s.projectToolCard('plain', { name: 'readFile', resultPreview: 'FILE BODY' });
    const card = s.toolCards.get('plain')!;
    expect(card.ok).toBe(true);
    expect('executionStatus' in card).toBe(false);
    expect(card.resultPreview).toBe('FILE BODY');
  });

  it('引擎若给一个**非特殊值**（历史脏数据/未来新增取值）⇒ 不得仅凭「字段在」就判成有结果', () => {
    const s = useEventStream(makeHooks());
    // 既没有 isError 也没有 resultPreview：只有存在性判据会把这张卡判成「已经有结果」
    s.projectToolCard('odd', { name: 'readFile', executionStatus: 'succeeded' });
    expect(s.toolCards.get('odd')!.ok).toBeNull();
    s.projectToolCard('odd2', { name: 'readFile', executionStatus: '' });
    expect(s.toolCards.get('odd2')!.ok).toBeNull();
  });

  it('两种真特殊状态（值比对命中）⇒ 仍然算「有结果」，并按 isError 定成败', () => {
    const s = useEventStream(makeHooks());
    s.projectToolCard('blocked', { name: 'bash', executionStatus: 'intercepted', isError: true });
    s.projectToolCard('cut', { name: 'bash', executionStatus: 'interrupted' });
    expect(s.toolCards.get('blocked')!.ok).toBe(false);
    expect(s.toolCards.get('cut')!.ok).toBe(true); // 没给 isError ⇒ 与既有口径一致按非失败处理
    expect(s.toolCards.get('blocked')!.executionStatus).toBe('intercepted');
  });

  it('实时路已建卡时，投影带特殊状态只补字段、不把已成功的卡片与实时时长翻掉', () => {
    const s = useEventStream(makeHooks());
    s.connect('sess-1');
    lastES().emit('tool_use', { seq: 1, tool_call_id: 'c1', name: 'bash', input: { cmd: 'ls' } });
    lastES().emit('tool_result', { seq: 2, tool_call_id: 'c1', ok: true, result_digest: 'done', duration_ms: 5 });
    s.projectToolCard('c1', { name: 'bash', executionStatus: 'interrupted', durationMs: 9999 });
    const card = s.toolCards.get('c1')!;
    expect(card.ok).toBe(true);                 // 实时路判的成功不被投影改写
    expect(card.dur).toBe(5);                   // 实时时长优先（投影值不许覆盖）
    expect(card.executionStatus).toBe('interrupted');
  });
});

// ---------------------------------------------------------------------------
// issue #283 M3：刷新后时长不丢——投影路径的宿主字段 `durationMs`（来源 = 本站 tool_calls，
// 引擎投影不带）进卡片；但实时路已拿到的值不得被投影覆盖，旧数据（无该键）仍是不显示。
// ---------------------------------------------------------------------------
describe('issue #283：投影路径的 durationMs（刷新后不丢）', () => {
  it('投影带 durationMs ⇒ card.dur 拿到原值（刷新后仍有时长）；不带 ⇒ 保持 undefined（不是 0）', () => {
    const s = useEventStream(makeHooks());

    s.projectToolCard('withDur', { name: 'shell', resultPreview: 'ok', durationMs: 4321 });
    expect(s.toolCards.get('withDur')!.dur).toBe(4321);

    s.projectToolCard('noDur', { name: 'shell', resultPreview: 'ok' });
    const noDur = s.toolCards.get('noDur')!;
    expect(noDur.dur).toBeUndefined();
    expect('dur' in noDur).toBe(false); // 不塞 `dur: undefined` 占位

    // 旧数据：DTO 没这个键（库里 NULL）⇒ 卡片依旧无时长，不伪装成 0
    s.projectToolCard('legacy', { name: 'shell', resultPreview: 'ok', durationMs: undefined });
    expect(s.toolCards.get('legacy')!.dur).toBeUndefined();
  });

  it('实时路已拿到时长 ⇒ 投影不得覆盖（两路同 callId 归并以实时为准）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('tool_use', { tool_call_id: 'c1', name: 'shell', input: { command: 'sleep 5' } });
    lastES().emit('tool_result', { tool_call_id: 'c1', ok: true, duration_ms: 12, result_digest: 'ok' });
    expect(s.toolCards.get('c1')!.dur).toBe(12);

    // 刷新：DTO 投影带一个不同的值（库里回读）→ 实时值胜出，不被覆盖
    s.projectToolCard('c1', { name: 'shell', resultPreview: 'ok', durationMs: 9999 });
    expect(s.toolCards.get('c1')!.dur).toBe(12);
  });

  it('实时事件**没给**时长、投影给了 ⇒ 投影补上（补完仍是原毫秒值，渲染时才格式化）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('tool_use', { tool_call_id: 'c1', name: 'shell', input: {} });
    lastES().emit('tool_result', { tool_call_id: 'c1', ok: true, result_digest: 'ok' }); // 无 duration_ms
    expect(s.toolCards.get('c1')!.dur).toBeUndefined();

    s.projectToolCard('c1', { name: 'shell', resultPreview: 'ok', durationMs: 5021 });
    expect(s.toolCards.get('c1')!.dur).toBe(5021);
    expect(hooks.onToolCardCreated).toHaveBeenCalledTimes(1); // 归并到同一张卡，不重复占位
  });

  it('非有限数的 durationMs（脉不明的脉外值）不入卡片：宁可不显示', () => {
    const s = useEventStream(makeHooks());
    s.projectToolCard('bad', { name: 'shell', durationMs: null as unknown as number });
    s.projectToolCard('nan', { name: 'shell', durationMs: Number.NaN });
    expect(s.toolCards.get('bad')!.dur).toBeUndefined();
    expect(s.toolCards.get('nan')!.dur).toBeUndefined();
  });
});

// issue #288（缺陷 B）：worker 被 watchdog 杀掉并重排必须是用户看得见的事件。
// 载荷由 portal 在 release-requeue 分支合成（docs/api/portal.md §5.3 第 14 行）：
// {attempt, max_attempts, reason, killed_by, silent_ms?}——**不新增 UI 结构**，走 onSep 分隔行。
describe('#288 attempt_killed（attempt 被杀并重排）', () => {
  it('实时 SSE：watchdog + silent_ms ⇒ 渲染「第 N/M 次尝试被终止（原因）…（静默 <时长>）」', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('attempt_killed', {
      seq: 41, run_id: 'run-1', attempt: 1, max_attempts: 3,
      reason: 'watchdog_silent', killed_by: 'watchdog', silent_ms: 301584,
    });
    expect(hooks.onSep).toHaveBeenCalledWith(
      '第 1/3 次尝试被终止（执行期静默超时，被看门狗终止），已重排等待重试（静默 5m 1s）',
    );
    expect(s.lastSeq.value).toBe(41); // 与既有事件同轴推进水位线（§5.1）
  });

  it('crash 且没有 silent_ms ⇒ 整段静默文案不出现（不留空括号、不拿 0 冒充「静默 0ms」）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('attempt_killed', {
      seq: 1, run_id: 'run-1', attempt: 2, max_attempts: 3, reason: 'worker_crashed', killed_by: 'crash',
    });
    expect(hooks.onSep).toHaveBeenCalledWith('第 2/3 次尝试被终止（worker 非预期退出），已重排等待重试');
    const line = hooks.onSep.mock.calls.at(-1)![0] as string;
    for (const banned of ['（静默', '（）', '()', 'undefined', 'null', '[object Object]']) {
      expect(line).not.toContain(banned);
    }
  });

  it('silent_ms 是脏值（字符串 / 负数 / NaN）⇒ 同样不显示静默段（后端不给力时前端也不炸）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    for (const bad of ['300000', -1, Number.NaN, null, {}]) {
      lastES().emit('attempt_killed', { seq: 2, attempt: 1, max_attempts: 3, killed_by: 'watchdog', silent_ms: bad });
      const line = hooks.onSep.mock.calls.at(-1)![0] as string;
      // 只钉「静默段」（`（静默 …）`）不出现；watchdog 的原因文案本身就带「静默」二字
      expect(line, String(bad)).not.toMatch(/（静默|\(silent/);
      expect(line, String(bad)).toContain('第 1/3 次尝试被终止');
    }
  });

  it('未知 / 畸形 killed_by 退化不炸：有 reason 就透出原文，没有就说「原因未知」', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('attempt_killed', { seq: 3, attempt: 1, max_attempts: 3, reason: 'nuclear_freeze', killed_by: 'nuclear' });
    expect(hooks.onSep).toHaveBeenLastCalledWith('第 1/3 次尝试被终止（nuclear_freeze），已重排等待重试');

    lastES().emit('attempt_killed', { seq: 4, attempt: 1, max_attempts: 3, killed_by: { why: 'x' } });
    expect(hooks.onSep).toHaveBeenLastCalledWith('第 1/3 次尝试被终止（原因未知），已重排等待重试');

    lastES().emit('attempt_killed', { seq: 5 }); // 整个载荷都不齐
    const line = hooks.onSep.mock.calls.at(-1)![0] as string;
    expect(line).toContain('第 ?/? 次尝试被终止');
    expect(line).not.toMatch(/undefined|\[object Object\]|（）/);
  });

  it('历史回放（刷新后）走同一渲染路径且不推进水位线（#89 红线）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.replayEvent({
      seq: 41, run_id: 'run-1', type: 'attempt_killed',
      payload: { attempt: 1, max_attempts: 3, reason: 'watchdog_silent', killed_by: 'watchdog', silent_ms: 301584 },
    });
    expect(hooks.onSep).toHaveBeenCalledWith(
      '第 1/3 次尝试被终止（执行期静默超时，被看门狗终止），已重排等待重试（静默 5m 1s）',
    );
    expect(s.lastSeq.value).toBe(0);
  });
});

// issue #288（缺陷 C）：崩溃恢复时挂起工具**没被重放**必须让用户看见，且**实时与刷新后一致**。
// ⚠ 本文件的两条用例分别钉两个独立集合：实时那条靠 `EVENT_TYPES`（EventSource 逐类型挂监听，
// 漏加 ⇒ 帧根本没投递进来），回放那条靠 `HISTORY_REPLAY_TYPES`（漏加 ⇒ replayEvent 直接 return）。
// 只写一条的话，另一处漏配永远测不出来——AGENTS §8.8 的坑，本分支已经踩过一次。
// 载荷口径：docs/api/portal.md §5.3 第 15 行（runner `loopEventPayload` 映射后的 snake_case 字段）。
describe('#288 tool_replay_decision_required（挂起工具未重放）', () => {
  const clean = {
    tool_call_id: 'call-shell-1', engine_run_id: 'sess-1', round: 3, name: 'shell',
    replay: 'unsafe', requires_host_decision: true, partial_output_available: false,
  };

  it('实时 SSE：EVENT_TYPES 未注册就一条都收不到 ⇒ 渲染「工具执行被中断，未重放…（shell）」', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('tool_replay_decision_required', { seq: 41, run_id: 'run-1', ...clean });
    expect(hooks.onSep).toHaveBeenCalledWith(
      '工具执行被中断，未重放，由模型决定是否重试（shell）',
    );
    expect(s.lastSeq.value).toBe(41); // 与既有事件同轴推进水位线（§5.1）
  });

  it('历史回放（刷新后）走同一渲染路径、文案逐字相同、且不推进水位线（#89 红线）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.replayEvent({ seq: 41, run_id: 'run-1', type: 'tool_replay_decision_required', payload: clean });
    expect(hooks.onSep).toHaveBeenCalledWith(
      '工具执行被中断，未重放，由模型决定是否重试（shell）',
    );
    expect(s.lastSeq.value).toBe(0);

    // 两种可见性**逐字一致**：同源 payload 经两条通路必须产出同一个字符串
    const liveHooks = makeHooks();
    const live = useEventStream(liveHooks);
    live.connect('sess-1');
    lastES().emit('tool_replay_decision_required', { seq: 1, run_id: 'run-1', ...clean });
    expect(liveHooks.onSep.mock.calls.at(-1)![0]).toBe(hooks.onSep.mock.calls.at(-1)![0]);
  });

  it('中性呈现：不是错误行（onSysErr 零调用），也不碰工具卡片以外的状态', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('tool_replay_decision_required', { seq: 2, ...clean });
    expect(hooks.onSep).toHaveBeenCalledTimes(1);
    expect(hooks.onSysErr).not.toHaveBeenCalled(); // 「没重放」≠ 失败：卡片已由成对 tool_result 亮 ✗
    expect(hooks.onCurrentRunEnd).not.toHaveBeenCalled(); // 不驱动运行态状态机
  });

  it('name 是脏值（对象 / 空串 / 数字 / 缺失）⇒ 只去掉后缀片段，主文案照出且绝无 [object Object]', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    for (const bad of [{ name: { deep: 1 } }, '', 0, null, undefined, [], true]) {
      lastES().emit('tool_replay_decision_required', { seq: 3, ...clean, name: bad });
      const line = hooks.onSep.mock.calls.at(-1)![0] as string;
      expect(line, JSON.stringify(bad)).toBe('工具执行被中断，未重放，由模型决定是否重试');
      expect(line, JSON.stringify(bad)).not.toMatch(/\[object Object\]|undefined|\{name\}|\{tool\}|（）|\(\)/);
    }
  });

  it('载荷整个缺失（后端 additive 字段没给）⇒ 文案仍是完整中性句，不出现占位符残留', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('tool_replay_decision_required', { seq: 4 });
    expect(hooks.onSep).toHaveBeenCalledWith('工具执行被中断，未重放，由模型决定是否重试');
  });

  it('en 语言下同一事件出英文（双语都真的写了，不是拿中文交差）', () => {
    setLocale('en');
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('tool_replay_decision_required', { seq: 5, ...clean });
    const line = hooks.onSep.mock.calls.at(-1)![0] as string;
    expect(line).toContain('not been replayed');
    expect(line).toContain('(shell)');
    expect(line).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

// issue #300：合成项 `partial_output` 只存在于**历史响应**里（后端不落库、不推 SSE）。
// 前端两个集合都**不许**加它：加了 `EVENT_TYPES` ⇒ 实时多挂一个监听（同一 run 变成「实时一条 +
// 历史一条」的起点）；加了 `HISTORY_REPLAY_TYPES` ⇒ 它会流进展示层状态机（本单要的是中性 entry，
// 由 store 自己分流，见 stores/workbench.ts 的 addPartialOutput）。
describe('#300 partial_output 不进 EVENT_TYPES / HISTORY_REPLAY_TYPES', () => {
  it('实时：EventSource 没有为 partial_output 挂监听（加进 EVENT_TYPES 就红）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    expect(lastES().listeners.has('partial_output')).toBe(false);
    // 顺手钉住它也不是 assistant_delta 的别名：正文增量仍只有 assistant_delta 一条通路
    expect(lastES().listeners.has('assistant_delta')).toBe(true);
    expect(s.lastSeq.value).toBe(0);
  });

  it('回放：replayEvent 收到 partial_output 时零副作用（未进 HISTORY_REPLAY_TYPES）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.replayEvent({ seq: 41, run_id: 'r1', type: 'partial_output', payload: { text: '半截', chunks: 3, truncated: false } });
    expect(hooks.onSep).not.toHaveBeenCalled();
    expect(hooks.onSysErr).not.toHaveBeenCalled();
    expect(hooks.onToolCardCreated).not.toHaveBeenCalled();
    expect(s.lastSeq.value).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// issue #321：judge 分轴文案——judge 只是意见，不是验收；「已完成」唯一来源是 run 终态。
// 四组红线：executed=工具审计放行（非任务完成）；done=true=「评审认为目标已达成（未独立核验）」
// 且收尾由模型自判；off_track/uncertain 不被 passThrough/extend 遮掉；extend+redirect 不得被
// 反推成「工具已执行」（实测存在 kind=intercept 而 action=extend+redirect、真实审计为拦截）。
// ---------------------------------------------------------------------------
describe('useEventStream · judge 分轴文案（issue #321）', () => {
  it('executed = 工具审计放行（非任务完成），done=false 同轴并存', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('judge', {
      kind: 'intercept', tool: { name: 'shell' }, action: 'executed',
      decision: { done: false, confidence: 0.8, reason: '继续写测试', direction: 'on_track' },
    });
    expect(hooks.onSep).toHaveBeenCalledWith(
      'judge：工具审计：已放行（非任务完成） · 评审认为目标未达成（置信度 0.8） · 评审理由：继续写测试',
      'judge',
    );
    const text = hooks.onSep.mock.calls[0][0];
    // 旧文案「judge：executed」把用户骗成「任务完成」（ISSUES.md 第 4 条放大器）——新文案不得回退。
    expect(text).not.toMatch(/已完成|已核验|已验证/);
    expect(text).not.toMatch(/judge：executed/);
  });

  it('done=true 是意见不是验收：未独立核验 + 收尾由模型自行判定；不产生终态分隔条', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    s.activeRunId.value = 'run-1'; // 有活跃 run：judge 若敢驱动终态，这里就会被抓到
    lastES().emit('judge', {
      kind: 'round', action: 'judge_done',
      decision: { done: true, confidence: 0.95, reason: '部署并复验通过', direction: 'on_track' },
    });
    expect(hooks.onSep).toHaveBeenCalledWith(
      'judge：评审认为目标已达成（未独立核验；是否收尾由模型自行判定）（置信度 0.95） · 评审理由：部署并复验通过',
      'judge',
    );
    const text = hooks.onSep.mock.calls[0][0];
    expect(text).toContain('未独立核验');
    // 终态只有一个来源（run_end）：judge_done 事件不得驱动状态机、不得刷红、不得自称完成/终态分隔。
    expect(hooks.onSysErr).not.toHaveBeenCalled();
    expect(hooks.onCurrentRunEnd).not.toHaveBeenCalled();
    expect(s.activeRunId.value).toBe('run-1');
    expect(text).not.toMatch(/run 结束|已完成|已核验|已验证/);
  });

  it('off_track + 扩轮同时展示（各维度非互斥，可同时非空）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('judge', {
      kind: 'round', action: 'extend+redirect',
      decision: {
        done: false, confidence: 0.6, direction: 'off_track', directionReason: '在错的目录里改',
        extend: true, extendReason: '还差测试', plan: '先回到 src 下',
      },
    });
    expect(hooks.onSep).toHaveBeenCalledWith(
      'judge：评审认为目标未达成（置信度 0.6） · 方向：可能偏离 — 在错的目录里改 · 建议扩轮 — 先回到 src 下（还差测试）',
      'judge',
    );
  });

  it('实测欺骗形态 kind=intercept + action=extend+redirect：不得解读成「工具已执行」', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('judge', {
      kind: 'intercept', tool: { name: 'editFile' }, action: 'extend+redirect',
      decision: { done: false, direction: 'off_track', extend: true, extendReason: '还差测试' },
    });
    const text = hooks.onSep.mock.calls[0][0];
    // 从 action 反推「已放行/已执行」会被骗（真实审计可为拦截）；执行与否以工具卡片为准。
    expect(text).toContain('工具审计：结果未知（extend+redirect），执行与否以工具卡片为准');
    expect(text).not.toMatch(/已放行|已执行/);
    // 且意见轴不被处置遮蔽（三个维度同时非空）。
    expect(text).toContain('评审认为目标未达成');
    expect(text).toContain('方向：可能偏离');
    expect(text).toContain('建议扩轮（还差测试）');
  });

  it('blocked + uncertain 完整展示；passThrough（readonly）不再提前 return 遮掉 done/uncertain', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('judge', {
      kind: 'intercept', tool: { name: 'writeFile' }, action: 'blocked',
      decision: { done: false, confidence: 0.7, direction: 'uncertain', reason: '方向不明就写文件' },
    });
    expect(hooks.onSep.mock.calls[0][0]).toBe(
      'judge：工具审计：已拦截（本次工具调用未执行） · 评审认为目标未达成（置信度 0.7） · 评审理由：方向不明就写文件 · 方向：不确定',
    );
    lastES().emit('judge', {
      kind: 'intercept', tool: { name: 'readFile' }, action: 'executed', passThrough: 'readonly',
      decision: { done: false, direction: 'uncertain' },
    });
    expect(hooks.onSep.mock.calls[1][0]).toBe(
      'judge：工具审计：已放行（readonly，非任务完成） · 评审认为目标未达成 · 方向：不确定',
    );
  });

  it('degraded 与未知 action 走中性降级（灰色 judge 面板行，不刷红、不解读）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('judge', { kind: 'intercept', tool: { name: 'shell' }, action: 'degraded', error: 'parse', decision: null });
    lastES().emit('judge', { kind: 'round', action: 'degraded' }); // error 缺失 → unknown 兜底
    lastES().emit('judge', { kind: 'round', action: 'frobnicate', decision: { done: true, confidence: 0.9 } }); // 引擎 additive 新值
    lastES().emit('judge', {}); // 全脏载荷
    expect(hooks.onSep.mock.calls.map((c) => c[0])).toEqual([
      'judge：评审降级（parse），本轮未给出意见',
      'judge：评审降级（unknown），本轮未给出意见',
      'judge：评审认为目标已达成（未独立核验；是否收尾由模型自行判定）（置信度 0.9） · 评审动作：frobnicate',
      'judge：评审事件（无可解读细节）',
    ]);
    for (const call of hooks.onSep.mock.calls) expect(call[1]).toBe('judge');
    expect(hooks.onSysErr).not.toHaveBeenCalled();
  });

  it('实时流与历史回放（replayEvent）逐字同文案', () => {
    const payloads: Array<Record<string, unknown>> = [
      { kind: 'intercept', tool: { name: 'shell' }, action: 'executed', decision: { done: false, confidence: 0.8, reason: '继续写测试', direction: 'on_track' } },
      { kind: 'round', action: 'judge_done', decision: { done: true, confidence: 0.95, reason: '部署并复验通过', direction: 'on_track' } },
      { kind: 'intercept', tool: { name: 'editFile' }, action: 'extend+redirect', decision: { done: false, direction: 'off_track', extend: true, extendReason: '还差测试' } },
      { kind: 'intercept', action: 'degraded', error: 'timeout', decision: null },
    ];
    for (const payload of payloads) {
      const live = makeHooks();
      const replay = makeHooks();
      const sLive = useEventStream(live);
      sLive.connect('sess-1');
      sLive.activeRunId.value = 'run-1';
      lastES().emit('judge', payload);
      const sReplay = useEventStream(replay);
      sReplay.replayEvent({ seq: 7, run_id: 'r1', type: 'judge', payload });
      expect(replay.onSep.mock.calls).toEqual(live.onSep.mock.calls);
      expect(sReplay.activeRunId.value).toBeNull(); // 回放同样不驱动运行态状态机
    }
  });

  it('切 English：done=true 意见文案成对（不含承诺式 verified/completed）', () => {
    setLocale('en');
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('judge', { kind: 'round', action: 'judge_done', decision: { done: true, confidence: 0.95, reason: 'deployed & re-checked', direction: 'on_track' } });
    const text = hooks.onSep.mock.calls[0][0];
    expect(text).toContain('not independently verified');
    // 只允许否定式出现 verified（not independently verified），不得出现承诺式的 completed。
    expect(text).not.toMatch(/completed/i);
    expect(text).toContain('judge: goal considered met (not independently verified; the model itself decides whether to wrap up) (confidence 0.95) · reason: deployed & re-checked');
  });
});

// ===========================================================================
// issue #279：provider `tool_call_id` **跨轮复用** ⇒ 卡片身份必须含轮号。
// 缺陷本体（真机症状「每轮恒 ✓ readFile，edit 卡片看不见」）：`toolCards` 以裸 provider id 为键 +
// 命中即返回（`name` 首写冻结）⇒ 第二轮起所有调用并进第一轮那张卡。dev 栈不触发（我们的上游 id
// 带随机后缀），所以只能**造形状**测：同一个 run 内两轮、id 相同而 name 不同。
// 契约依据：`tool_use`/`tool_result` 载荷**没有** round（docs/api/portal.md §5.3 第 6/7 类），
// 轮号只能来自 `round_start`（实时 EVENT_TYPES 与历史下发白名单里都有它）。
// ===========================================================================
const CROSS_ROUND_EVENTS = [
  { seq: 1, run_id: 'r1', type: 'round_start', payload: { round: 1 } },
  { seq: 2, run_id: 'r1', type: 'tool_use', payload: { tool_call_id: 'c1', name: 'readFile', input: { path: 'a.txt' } } },
  { seq: 3, run_id: 'r1', type: 'tool_result', payload: { tool_call_id: 'c1', ok: true, result_digest: 'file A', duration_ms: 12 } },
  { seq: 4, run_id: 'r1', type: 'round_start', payload: { round: 2 } },
  { seq: 5, run_id: 'r1', type: 'tool_use', payload: { tool_call_id: 'c1', name: 'edit', input: { path: 'a.txt', oldText: 'x' } } },
  { seq: 6, run_id: 'r1', type: 'tool_result', payload: { tool_call_id: 'c1', ok: false, result_digest: 'conflict', duration_ms: 7 } },
] as const;

/** 卡片产出快照（身份键 + 逐字段内容 + 宿主占位顺序）——两条路径拿它做**逐字**比对。 */
function cardSnapshot(s: ReturnType<typeof useEventStream>, placeholders: unknown[][]): string {
  return JSON.stringify({
    keys: [...s.toolCards.keys()],
    cards: [...s.toolCards.values()],
    placeholders,
  });
}

describe('issue #279：跨轮复用 provider call id ⇒ 卡片身份含轮号', () => {
  it('实时路：同一 run 两轮同 id 不同名 ⇒ **两张卡**、名字各自正确', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    for (const ev of CROSS_ROUND_EVENTS) {
      lastES().emit(ev.type, { seq: ev.seq, run_id: ev.run_id, ...ev.payload });
    }
    expect([...s.toolCards.keys()]).toEqual(['r1:1:c1', 'r1:2:c1']);
    expect(s.toolCards.get('r1:1:c1')!.name).toBe('readFile');
    expect(s.toolCards.get('r1:2:c1')!.name).toBe('edit'); // 缺陷本体：这一张以前根本不存在
    expect(hooks.onToolCardCreated.mock.calls).toEqual([['r1:1:c1'], ['r1:2:c1']]);
  });

  it('历史回放路：产出与实时路**逐字一致**（防「实时看着对、刷新后错」）', () => {
    const liveHooks = makeHooks();
    const sLive = useEventStream(liveHooks);
    sLive.connect('sess-1');
    for (const ev of CROSS_ROUND_EVENTS) {
      lastES().emit(ev.type, { seq: ev.seq, run_id: ev.run_id, ...ev.payload });
    }
    const replayHooks = makeHooks();
    const sReplay = useEventStream(replayHooks);
    for (const ev of CROSS_ROUND_EVENTS) sReplay.replayEvent({ ...ev });
    expect(cardSnapshot(sReplay, replayHooks.onToolCardCreated.mock.calls))
      .toBe(cardSnapshot(sLive, liveHooks.onToolCardCreated.mock.calls));
  });

  it('结果关联**不串轮**：第二轮的 tool_result 只写第二轮那张（载荷里没有轮号）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    for (const ev of CROSS_ROUND_EVENTS) {
      lastES().emit(ev.type, { seq: ev.seq, run_id: ev.run_id, ...ev.payload });
    }
    const first = s.toolCards.get('r1:1:c1')!;
    const second = s.toolCards.get('r1:2:c1')!;
    expect(first.ok).toBe(true);
    expect(first.out).toBe('✓ file A（12ms）');
    expect(first.dur).toBe(12);
    expect(second.ok).toBe(false); // 若结果写错了卡片，这里会连着名字一起错
    expect(second.out).toBe('✗ conflict（7ms）');
    expect(second.dur).toBe(7);
  });

  it('索引只用于关联，**不当身份**：同 id 跨轮 ⇒ 身份两张卡、索引指向最新那张', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    for (const ev of CROSS_ROUND_EVENTS) {
      lastES().emit(ev.type, { seq: ev.seq, run_id: ev.run_id, ...ev.payload });
    }
    expect(s.toolCards.size).toBe(2); // 身份 = 两张
    expect(s.cardIdentityOfCall('c1')).toBe('r1:2:c1'); // 关联索引 = 最新那张
  });

  it('跨 run 复用同一个 id ⇒ 也是两张卡（会话级 Map 不再串台）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('tool_use', { seq: 1, run_id: 'rA', tool_call_id: 'c1', name: 'readFile', input: {} });
    lastES().emit('tool_use', { seq: 2, run_id: 'rB', tool_call_id: 'c1', name: 'edit', input: {} });
    expect([...s.toolCards.keys()]).toEqual(['rA:c1', 'rB:c1']);
    expect(s.toolCards.get('rB:c1')!.name).toBe('edit');
  });

  it('tool_call_delta 与后来的 tool_use 落在**同一张**卡（增量不另起一张）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('round_start', { seq: 1, run_id: 'r1', round: 3 });
    lastES().emit('tool_call_delta', { seq: 2, run_id: 'r1', tool_call_id: 'c1', name: 'edit', arguments_delta: '{"path"' });
    lastES().emit('tool_call_delta', { seq: 3, run_id: 'r1', tool_call_id: 'c1', arguments_delta: ':"a.txt"}' });
    lastES().emit('tool_use', { seq: 4, run_id: 'r1', tool_call_id: 'c1', name: 'edit', input: { path: 'a.txt' } });
    expect([...s.toolCards.keys()]).toEqual(['r1:3:c1']);
    expect(s.toolCards.get('r1:3:c1')!.args).toBe('{"path":"a.txt"}');
    expect(hooks.onToolCardCreated).toHaveBeenCalledTimes(1);
  });

  it('实时漏收 round_start ⇒ 身份退化成 `r1:c1`（**不伪造轮号**），迟到结果仍靠索引找回同一张', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('tool_use', { seq: 9, run_id: 'r1', tool_call_id: 'c1', name: 'readFile', input: {} });
    expect([...s.toolCards.keys()]).toEqual(['r1:c1']); // 没有轮号段，也不拿 0/1 冒充
    lastES().emit('tool_result', { seq: 10, run_id: 'r1', tool_call_id: 'c1', ok: true, result_digest: 'ok', duration_ms: 4 });
    expect(s.toolCards.size).toBe(1);
    expect(s.toolCards.get('r1:c1')!.ok).toBe(true);
  });

  it('round_start 之外的轮内事件（attempt/recovering）也能立起轮号水位线（重连漏收 round_start 的补点）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('recovering', { seq: 1, run_id: 'r1', round: 7, attempt: 2, maxAttempts: 3 });
    lastES().emit('tool_use', { seq: 2, run_id: 'r1', tool_call_id: 'c1', name: 'shell', input: {} });
    expect([...s.toolCards.keys()]).toEqual(['r1:7:c1']);
  });

  // 变异取证补的用例：把 toolCard 的「命中即返回」改成「后到覆盖 name」时，原先 623 条**全绿**。
  // 它**不是空操作**（at-least-once 重投 / delta 首帧名与 tool_use 名不一致时真会改写卡片）⇒
  // 属覆盖缺口。身份已含轮号之后「首写冻结」不再是缺陷，而是刻意的口径：同一张卡 = 同一个真实调用。
  it('同一身份键上后到的名字**不改写**卡片（`name` 首写冻结是保留的决定，不是漏改）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('round_start', { seq: 1, run_id: 'r1', round: 1 });
    lastES().emit('tool_use', { seq: 2, run_id: 'r1', tool_call_id: 'c1', name: 'readFile', input: { path: 'a.txt' } });
    // 同一次调用的迟到重投（同一 run 同一轮同一 id）：名字形状不同也不许把卡片改名
    lastES().emit('tool_use', { seq: 3, run_id: 'r1', tool_call_id: 'c1', name: 'editor', input: { path: 'a.txt' } });
    lastES().emit('tool_call_delta', { seq: 4, run_id: 'r1', tool_call_id: 'c1', name: 'reader', arguments_delta: '{}' });
    expect(s.toolCards.size).toBe(1);
    expect(s.toolCards.get('r1:1:c1')!.name).toBe('readFile');
    // 投影那条路同口径：命中既有卡片时只补缺字段，不改 name（#188 的「不覆盖实时完整数据」延伸）
    s.projectToolCard('r1:1:c1', { name: 'editor', argsSummary: 'path=a.txt' }, { key: 'r1:1:c1', runId: 'r1', roundToken: '1', callId: 'c1' });
    expect(s.toolCards.get('r1:1:c1')!.name).toBe('readFile');
    expect(s.toolCards.get('r1:1:c1')!.argsSummary).toBe('path=a.txt');
    expect(s.toolCards.size).toBe(1);
  });

  it('resetStreamState 连轮号水位线与关联索引一起清（换会话不得串轮号）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('round_start', { seq: 1, run_id: 'r1', round: 4 });
    lastES().emit('tool_use', { seq: 2, run_id: 'r1', tool_call_id: 'c1', name: 'readFile', input: {} });
    s.resetStreamState();
    s.connect('sess-2');
    lastES().emit('tool_use', { seq: 1, run_id: 'r1', tool_call_id: 'c1', name: 'edit', input: {} });
    expect([...s.toolCards.keys()]).toEqual(['r1:c1']); // 新连接没观测到 round_start ⇒ 退化键
    expect(s.cardIdentityOfCall('c1')).toBe('r1:c1');
  });
});

// ---------------------------------------------------------------------------
// issue #371-A：`persistence_error`（引擎落盘失败告警，经 runner `diagnostics.error` 上报）。
// 缺陷本体：本站从没传 `diagnostics` ⇒ 真机 `run_events` 该类型 0 行，「剥掉折叠归档重试一次」
// 这类**非致命降级**在界面上全隐形（run 绿、有正文、无提示）。所以这里钉的不是样式，而是
// 「这条事件到底有没有被接住」——含实时监听面（漏加 EVENT_TYPES 就是一条都收不到）。
// ---------------------------------------------------------------------------
describe('#371-A persistence_error（落盘失败告警）', () => {
  const P = { port: 'transcript', phase: 'write', operation: 'appendRound', engine_run_id: 'sess-1' };

  it('fatal:false → 中性分隔行（onSep，不是 onSysErr 红行），文案带 operation', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('persistence_error', { seq: 3, ...P, fatal: false, error: { name: 'Error', message: 'too large' } });
    expect(hooks.onSep).toHaveBeenCalledTimes(1);
    expect(hooks.onSep).toHaveBeenCalledWith('落盘降级：appendRound 记录未存入（本次任务不受影响）');
    expect(hooks.onSysErr).not.toHaveBeenCalled(); // 非致命刷红 = 谎报严重程度
  });

  it('fatal:true 与「字段缺失」（= erix-agent 0.23.0 及以前的旧事件）都**不刷**：红面归 run_end 的 persistence_failed', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('persistence_error', { seq: 1, ...P, fatal: true });
    lastES().emit('persistence_error', { seq: 2, ...P }); // 旧引擎没有 fatal
    expect(hooks.onSep).not.toHaveBeenCalled();
    expect(hooks.onSysErr).not.toHaveBeenCalled();
  });

  it('operation 脏值/缺失 → 退回 round，绝不把 [object Object] 渗进用户可见文案', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('persistence_error', { seq: 1, ...P, fatal: false, operation: { x: 1 } });
    lastES().emit('persistence_error', { seq: 2, ...P, fatal: false, operation: '' });
    expect(hooks.onSep.mock.calls.map((c) => c[0])).toEqual([
      '落盘降级：round 记录未存入（本次任务不受影响）',
      '落盘降级：round 记录未存入（本次任务不受影响）',
    ]);
  });

  it('EventSource 必须挂上这个具名监听（EVENT_TYPES 漏加 = 实时一条都收不到，且不报错不警告）', () => {
    const s = useEventStream(makeHooks());
    s.connect('sess-1');
    expect([...lastES().listeners.keys()]).toContain('persistence_error');
  });
});
