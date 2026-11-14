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

  // issue #442（erix-agent 0.30.0 / 上游 #661）：`summarizer_failed` 是**新增的终局错误码**
  // —— 摘要器失败不再静默降级成统计摘要，而是让 run 以 `failed` 收场。用户看到的不能只是引擎那句
  // 英文技术文本，必须有一句人话（「压缩摘要器调用失败 ⇒ 本次运行失败（可重试）」）。
  // ⚠ 口径：**不新增 UI 结构**（仍是既有红色 `.syserr` + `code=` 后缀），只换 `{message}` 那一格。
  it('历史回放（#451 真机演练补的缺口）：run_termination 合成项也必须带人话 —— 实时与历史同文案', () => {
    // 真机现场：同一个 `summarizer_failed`，实时 `run_end` 有 `d.error` 信封 ⇒ 人话；
    // 刷新后走 `run_termination` 合成项（只有 `termination`、没有 `error`）⇒ 只剩 `code=summarizer_failed`。
    // 这条钉住「两条路共用 `runEndReasonText`」，谁把查表挪回 `d.error` 那一支就红。
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    // 历史入口是 `historyRunEndEntry`（openSession 归并循环里调它），不是 `run_termination` 的 SSE 分支。
    const entry = s.historyRunEndEntry({
      seq: 9,
      run_id: 'run-hist',
      type: 'run_termination',
      payload: { status: 'failed', termination: { reason: 'failed', errorCode: 'summarizer_failed' } },
    });
    expect(entry, '历史回放必须给出终态行').not.toBeNull();
    expect(entry!.kind).toBe('syserr');
    expect(entry!.text).toContain('code=summarizer_failed');
    expect(entry!.text).toContain('压缩摘要器调用失败');
    expect(entry!.text).toContain('重试');
    // 反向对照：未登记的码逐字保持 `（code=xxx）`，不许被这张表吞掉或改写。
    const unknown = s.historyRunEndEntry({
      seq: 10,
      run_id: 'run-x',
      type: 'run_termination',
      payload: { termination: { reason: 'failed', errorCode: 'timeout' } },
    });
    expect(unknown!.text).toBe('run 结束：failed — 运行失败（code=timeout）');
  });

  it('run_end 失败横幅（#442）：summarizer_failed 走人话（码仍原样带出）；未知码照旧透传引擎原话', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    s.activeRunId.value = 'run-1';
    lastES().emit('run_end', {
      seq: 1, run_id: 'run-1',
      termination: { reason: 'failed', errorCode: 'summarizer_failed' },
      error: { code: 'summarizer_failed', message: 'No summary was produced: the summarizer returned no text.' },
    });
    const lines = hooks.onSysErr.mock.calls.map((c) => String(c[0]));
    // ① 终态行仍然带 code=（既有 #261 后缀面，一字未改）
    expect(lines.some((l) => l.includes('code=summarizer_failed'))).toBe(true);
    // ② 错误信封那一行是人话，不是引擎英文原句
    const detail = lines.find((l) => l.startsWith('run 失败：summarizer_failed'));
    expect(detail).toBeDefined();
    expect(detail).toContain('压缩摘要器调用失败');
    expect(detail).toContain('重试');
    expect(detail).not.toContain('No summary was produced');
    // ③ 未知码不许被这张表吞掉：照旧把引擎原话透传出来（不编翻译）
    hooks.onSysErr.mockClear();
    s.activeRunId.value = 'run-2';
    lastES().emit('run_end', {
      seq: 2, run_id: 'run-2',
      termination: { reason: 'failed' },
      error: { code: 'llm_error', message: 'boom' },
    });
    expect(hooks.onSysErr).toHaveBeenLastCalledWith('run 失败：llm_error — boom');
  });

  // issue #442（erix-agent 0.30.0 / 上游 #476）：`finalTextFallback === true` ⇒ 终稿是**引擎兜底文案**。
  // 判据（工单 §M4.2/M4.3）：
  //   ① 有标记 ⇒ 多**一行中性 sep**（不进 `.syserr`：兜底不是故障）；
  //   ② 无标记 ⇒ 一个字节都不多（缺席 = 不是兜底）；
  //   ③ `false` / 脏值也不算兜底（引擎从不写 false，但 DTO 可能被旧数据/手工注入污染）。
  it('run_end 兜底标记（#442）：finalTextFallback=true ⇒ 一行中性标记；缺席/false/脏值 ⇒ 一个字节都不多', () => {
    const runOnce = (termination: Record<string, unknown>) => {
      const hooks = makeHooks();
      const s = useEventStream(hooks);
      s.connect('sess-1');
      s.activeRunId.value = 'run-1';
      lastES().emit('run_end', { seq: 1, run_id: 'run-1', termination });
      return {
        sep: hooks.onSep.mock.calls.map((c) => String(c[0])),
        sysErr: hooks.onSysErr.mock.calls.map((c) => String(c[0])),
      };
    };
    const withFallback = runOnce({ reason: 'end_turn', forcedFinal: true, finalTextFallback: true });
    const marker = withFallback.sep.filter((line) => line.includes('引擎兜底文案'));
    expect(marker).toHaveLength(1);
    expect(marker[0]).toContain('非模型输出');
    // 中性：它绝不能出现在红色面里（兜底不是故障）
    expect(withFallback.sysErr.some((line) => line.includes('引擎兜底文案'))).toBe(false);
    // 反向：没有这个键 ⇒ 不多一行
    const plain = runOnce({ reason: 'end_turn', forcedFinal: true });
    expect(plain.sep.filter((line) => line.includes('引擎兜底文案'))).toHaveLength(0);
    // `false` 与脏值同样不算兜底
    for (const dirty of [false, 'true', 1, {}]) {
      const line = runOnce({ reason: 'end_turn', finalTextFallback: dirty });
      expect(line.sep.filter((l) => l.includes('引擎兜底文案')), JSON.stringify(dirty)).toHaveLength(0);
    }
    // 与 failed 红面共存时：红面照旧红，标记照旧中性（两行各在各的面里）
    const failed = runOnce({ reason: 'failed', errorCode: 'summarizer_failed', finalTextFallback: true });
    expect(failed.sysErr.some((l) => l.includes('run 结束：failed'))).toBe(true);
    expect(failed.sep.some((l) => l.includes('引擎兜底文案'))).toBe(true);
    expect(failed.sysErr.some((l) => l.includes('引擎兜底文案'))).toBe(false);
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

  // erix-agent #469 宿主侧后续（A2）：折叠事实只进 `CompactionStat.foldSummary`、**不新增事件类型**
  // （上游裁定一），不拼这一段就只能让人看出「折了 46 轮」而看不出「那份摘要是基于被裁过的材料写的」。
  // 同时钉住「无事实时逐字不变」：历史回放里的旧事件不得多出一段括号。
  //
  // ⚠ issue #442（erix-agent 0.30.0 / 上游 #661）：「降级」那一支**已删**（引擎不再生产
  // `degradeKind` / `degradeReason` / `degraded`）⇒ 下面**没有**降级后缀那几格，取而代之的是
  // 下面第 3 格的反向断言：喂一个退役键进横幅，**一个字节都不许多**（已退役的键不许复活）。
  it('compaction 分隔行把 foldSummary 里的折叠事实拼出来（无事实时逐字不变；退役的 degraded 键不许复活）', () => {
    const sepTexts = (payload: Record<string, unknown>) => {
      const hooks = makeHooks();
      const s = useEventStream(hooks);
      s.connect('sess-1');
      lastES().emit('compaction', { round: 9, compaction: payload });
      return hooks.onSep.mock.calls.map((c) => c[0])[0];
    };
    const base = { foldedRounds: 46, tokensBefore: 261345, tokensAfter: 8000, strategyName: 'fold-llm' };
    expect(sepTexts(base)).toBe('上下文折叠（round 9，策略 fold-llm）：46 轮折叠，261345 → 8000 tokens');
    expect(sepTexts({ ...base, foldSummary: {} })).toBe('上下文折叠（round 9，策略 fold-llm）：46 轮折叠，261345 → 8000 tokens');
    // ⚠ 退役键的反向断言（0.30.0 起引擎不生产它们）：喂进来也**一个字节都不许多**。
    // 这就是「已退役的键不许复活」的界面那一半（runner 那一半是 compact-knobs 的 K9）。
    for (const retired of [
      { degraded: true, degradeKind: 'timeout' },
      { degraded: true, degradeReason: '摘要器没在预算内回来' },
      { degradeKind: 'error', degradeReason: '整句' },
    ]) {
      expect(sepTexts({ ...base, foldSummary: retired })).toBe(
        '上下文折叠（round 9，策略 fold-llm）：46 轮折叠，261345 → 8000 tokens',
      );
    }
    // 另外两类非致命事实一条拼全：整条步骤预算耗尽（没自愈重试）+ 摘要被输出预算截断
    const both = sepTexts({ ...base, foldSummary: { budgetExhausted: true, finishReason: 'max_tokens' } });
    expect(both).toContain('摘要预算耗尽');
    expect(both).toContain('摘要被输出预算截断');
    // 输入面被裁（48 KB 整轮裁 / token 守卫逐条裁）必须带上数字，只说"被裁"等于没量化
    expect(sepTexts({ ...base, foldSummary: { droppedRounds: 7, droppedMessages: 3 } }))
      .toContain('摘要输入被裁（丢 7 轮 / 3 条');
    expect(sepTexts({ ...base, foldSummary: { inputTruncated: true } })).toContain('摘要输入被裁（丢 0 轮 / 0 条');
    // 正常收尾不是事实
    expect(sepTexts({ ...base, foldSummary: { finishReason: 'end_turn', budgetExhausted: false, inputTruncated: false, droppedRounds: 0, droppedMessages: 0, degraded: false } }))
      .toBe('上下文折叠（round 9，策略 fold-llm）：46 轮折叠，261345 → 8000 tokens');
  });

  // #438 切片 B（M3.3）：上面那条用的是**手写**形状；这一条用**真链路实测到的键面**。
  // 真形状（`runner/test/fold-notes-e2e.test.js` 的 E7 用真 `runToolLoop` + `fold-llm` 跑出来的）：
  //   · 成功那次：`foldSummary` 里**没有 `source`**（引擎 `compact/pipeline.js:228-232` 明确不进事件），
  //     只可能有 `inputTruncated` / `droppedMessages` / `finishReason` / `inputTokens` / `outputTokens`；
  //   · 失败那次（0.30.0 起）：**没有 compaction 事件**（那一折一个键都不留）——run 直接以
  //     `failed` / `summarizer_failed` 收场 ⇒ 横幅没有数据源，红面归 `run_end`（见本文件末尾那格）。
  // 跨端不能直连（jsdom 里跑不了引擎、也不许给前端加 erix-agent 依赖，`engine-upgrade-299` 判据①），
  // 所以这里用「真键面 + 真值」钉文案，形状本身由 runner 侧那条真跑用例守着。
  it('A2 真链路键面（成功折叠：只有裁剪/截断事实，没有降级后缀）', () => {
    const sepTexts = (payload: Record<string, unknown>) => {
      const hooks = makeHooks();
      const s = useEventStream(hooks);
      s.connect('sess-1');
      lastES().emit('compaction', { round: 1, compaction: payload });
      return hooks.onSep.mock.calls.map((c) => c[0])[0] as string;
    };
    const realSuccess = {
      foldedRounds: 21, tokensBefore: 5857, tokensAfter: 1692, strategyName: 'fold-llm',
      // 真成功形态：摘要输入被 token 守卫裁过（6k 窗口下的真实情形）
      foldSummary: { inputTruncated: true, droppedMessages: 21, finishReason: 'end_turn' },
    };
    expect(sepTexts(realSuccess)).toBe(
      '上下文折叠（round 1，策略 fold-llm）：21 轮折叠，5857 → 1692 tokens（⚠ 摘要输入被裁（丢 0 轮 / 21 条，据不完整材料写成））',
    );
    // 退役键（0.30.0 的引擎不会写它）出现在旧事件里时，横幅也不许多一个字节。
    const retiredShape = {
      foldedRounds: 21, tokensBefore: 5857, tokensAfter: 1692, strategyName: 'fold-llm',
      foldSummary: { degradeKind: 'timeout', degradeReason: 'summarizer timed out' },
    };
    expect(sepTexts(retiredShape)).toBe(
      '上下文折叠（round 1，策略 fold-llm）：21 轮折叠，5857 → 1692 tokens',
    );
    // 无任何裁剪事实 ⇒ 逐字回到旧文案（历史回放里的旧事件不得多出一段括号）
    expect(sepTexts({ foldedRounds: 21, tokensBefore: 5857, tokensAfter: 1692, strategyName: 'fold-llm' }))
      .toBe('上下文折叠（round 1，策略 fold-llm）：21 轮折叠，5857 → 1692 tokens');
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
describe('#300/#502 partial_output：只订不回放的展示项', () => {
  // 这条 describe 在 #300 时叫「partial_output 不进 EVENT_TYPES / HISTORY_REPLAY_TYPES」。
  // **issue #502 D-6 把前半句反过来了**（不是删断言，是换判据）：那一行/那一帧现在是补发通路的一部分，
  // EventSource **必须**订得到它 ⇒ 断言从 `false` 改成 `true`，标题也改成「只订不回放的展示项」。
  // 后半句（不进 HISTORY_REPLAY_TYPES）原样保留，它仍是 #300 那条「刷新后别出两条正文」的红线。
  it('#502：实时必须订得到 partial_output（漏进 EVENT_TYPES 就红：补发帧一条都收不到）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    expect(lastES().listeners.has('partial_output')).toBe(true);
    // 顺手钉住它不是 assistant_delta 的别名：碎片增量与快照覆盖是**两条**通路，都在册。
    expect(lastES().listeners.has('assistant_delta')).toBe(true);
    expect(s.lastSeq.value).toBe(0);
  });

  it('#502 判据 4（不重复的方向）：快照帧**覆盖**已有半截正文，不是追加', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('round_start', { seq: 4, round: 1, run_id: 'r1' }); // 形态 M：双闸的轮起点（帧要拿它对账）
    lastES().emit('assistant_delta', { seq: 5, run_id: 'r1', text: '半' });
    lastES().emit('assistant_delta', { seq: 6, run_id: 'r1', text: '截' });
    expect(s.deltaText.value).toBe('半截');
    // 重连补发的快照帧（无 `seq`、无 `id:`）：客户端已有「半截」，服务端给的是全量
    lastES().emit('partial_output', { run_id: 'r1', roundSeq: 4, text: '半截正文没说完', chunks: 42, source: 'memory' });
    expect(s.deltaText.value).toBe('半截正文没说完');
    expect(s.deltaText.value).not.toContain('半截半截');
  });

  it('#502 判据 4（不空洞的方向）：气泡被 run_end/round_start 清空后，快照帧把正文放回来', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('assistant_delta', { seq: 5, run_id: 'r1', text: '断线前的半句' });
    lastES().emit('round_start', { seq: 6, round: 2, run_id: 'r1' }); // 界面上那段被清空
    expect(s.deltaText.value).toBe(null);
    lastES().emit('partial_output', { run_id: 'r1', roundSeq: 6, text: '断线前的半句＋断线期间的那半句', chunks: 80, source: 'memory' });
    expect(s.deltaText.value).toBe('断线前的半句＋断线期间的那半句');
  });

  // ---- issue #502 形态 M：`roundSeq` 双闸（旧版靠 `uptoSeq` 猜水位线，形态 M 换成两端对同一个事实）----
  // 下面四条是本单的前端红线：「少一段」可接受（刷新即回），「盖错」不可接受（把别轮/别的 run
  // 的正文扣到当前气泡上）⇒ 不中整帧丢弃。不用 `w.emitted()`：本 composable 不挂组件，
  // 判据全部走导出面 `s.deltaText`（与同文件其余用例同一口径）。

  it('#502 形态 M 闸②（不匹配 ⇒ 整帧丢弃）：roundSeq 不是本连接观测到的当前轮 ⇒ 不盖正文也不清气泡', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('round_start', { seq: 6, round: 2, run_id: 'r1' });
    lastES().emit('assistant_delta', { seq: 7, run_id: 'r1', text: '本地已有的半截' });
    const sepBefore = hooks.onSep.mock.calls.length; // `round_start` 自己会发一行「round 2」，不能拿「零调用」当判据
    // 服务端手里是**上一轮**的快照（roundSeq=2 ≠ 当前轮 6）：盖上去就是把已完成轮次的正文当未定稿。
    lastES().emit('partial_output', { run_id: 'r1', roundSeq: 2, text: '上一轮的正文', chunks: 9, source: 'memory' });
    expect(s.deltaText.value, '轮对不上 ⇒ 连当前气泡都不许清（那可能是本轮自己的那段）').toBe('本地已有的半截');
    expect(hooks.onSep.mock.calls.length, '整帧丢弃 = 不产生任何行（含分隔行）').toBe(sepBefore);
  });

  it('#502 形态 M 闸①（run 不匹配 ⇒ 丢弃）：不是当前活跃 run 的帧，roundSeq 再对也不盖', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    // 先让 r1 成为当前活跃 run 并观测它的轮起点（`round_start` 自己**不**置活跃 run，
    // 那是 store 的责任：workbench.ts:788 / :1400 / :1471 三处）⇒ 这里直接摸导出面，与
    // workbench.spec.ts:216 同一口径。
    lastES().emit('round_start', { seq: 6, round: 2, run_id: 'r1' });
    s.activeRunId.value = 'r2';
    // r1 的旧轮快照（它的 roundSeq 在自己账上是对的）：活跃 run 已换成 r2 ⇒ 整帧丢弃
    lastES().emit('partial_output', { run_id: 'r1', roundSeq: 6, text: '上一个 run 的半截', chunks: 4, source: 'memory' });
    expect(s.deltaText.value).toBe(null);
  });

  it('#502 形态 M 闸①反面：activeRunId 未知（刚 connect）⇒ 接受（否则首连补发帧会全量丢光）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    expect(s.activeRunId.value).toBe(null);
    lastES().emit('round_start', { seq: 3, round: 1, run_id: 'r9' });
    lastES().emit('partial_output', { run_id: 'r9', roundSeq: 3, text: '重连就该看到的那段', chunks: 2, source: 'memory' });
    expect(s.deltaText.value).toBe('重连就该看到的那段');
  });

  it('#502 形态 M 闸②反面：帧的 roundSeq 为 null ⇒ 按不中处理（服务端不确定 ⇒ 谁都不许盖）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('round_start', { seq: 6, round: 2, run_id: 'r1' });
    lastES().emit('assistant_delta', { seq: 7, run_id: 'r1', text: '已有正文' });
    lastES().emit('partial_output', { run_id: 'r1', roundSeq: null, text: '服务端也不知道是哪轮', chunks: 1, source: 'memory' });
    expect(s.deltaText.value).toBe('已有正文');
  });

  it('#502 形态 M 闸②的依赖：round_start 没带可用 seq ⇒ 记 null ⇒ 后续帧全丢（宁缺不错盖）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('round_start', { round: 2, run_id: 'r1' }); // 脏帧：没有 seq
    lastES().emit('partial_output', { run_id: 'r1', roundSeq: 2, text: '拿上一轮的号来碰运气', chunks: 1, source: 'memory' });
    expect(s.deltaText.value, '轮起点未知 ⇒ 拿别的号来硬对就是错盖').toBe(null);
  });

  it('#502 形态 M：SSE 通路不再出占位（占位已搬进历史投影）⇒ 空帧只清气泡，不发分隔行', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('round_start', { seq: 3, round: 1, run_id: 'r1' });
    lastES().emit('assistant_delta', { seq: 4, run_id: 'r1', text: '残留的半截' });
    const sepBefore = hooks.onSep.mock.calls.length; // 同上：round_start 那一行不算在本判据里
    // 旧版这一帧会发 `stream.event.partialOutputLost` 分隔行；形态 M 之后后端**根本不发空帧**，
    // 真到了「一个字都没有」那一步是历史投影的 `placeholder` 条目在兑（workbench.spec 钉）。
    lastES().emit('partial_output', { run_id: 'r1', roundSeq: 3, text: '', chunks: 0, truncated: false, source: 'memory' });
    expect(s.deltaText.value, '空气泡比清空更坑 ⇒ 仍旧清').toBe(null);
    expect(hooks.onSep.mock.calls.length, '占位行已搬到历史投影，SSE 这条路不该再发').toBe(sepBefore);
    expect(hooks.onSysErr, '中性提示不是红色错误行').not.toHaveBeenCalled();
  });

  it('#502：快照帧没有 seq ⇒ 不推进本地水位线（不污染重连游标）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('round_start', { seq: 11, round: 1, run_id: 'r1' });
    lastES().emit('partial_output', { run_id: 'r1', roundSeq: 11, text: '正文', chunks: 3, source: 'memory' });
    expect(s.deltaText.value).toBe('正文');
    expect(s.lastSeq.value, '帧里没有 seq ⇒ 水位线一步都不许动（round_start 那条自己推过了）').toBe(11);
  });

  it('#502：脏快照（text 不是字符串）不当成正文，也不炸', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    lastES().emit('partial_output', { run_id: 'r1', text: 42, source: 'db' });
    expect(s.deltaText.value).toBe(null);
    expect(hooks.onSep).not.toHaveBeenCalled();
  });

  it('#300 仍在：回放（replayEvent）收到 partial_output 时零副作用（未进 HISTORY_REPLAY_TYPES）', () => {
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

// ---------------------------------------------------------------------------
// 审计第 4 / 6 条（261114-05）：旧页回放与脏快照
// ---------------------------------------------------------------------------
describe('审计第 4 条：旧页回放（?before= 拉到的更早一页）不得打死正在流的正文', () => {
  it('活跃 run 正在流 ⇒ 回放一条**更旧**的 round_start：deltaText 不变、轮水位不回退、当前轮快照仍被接受', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.activeRunId.value = 'r-current';
    s.connect('sess-1');
    // 当前轮：round_start 自己在 seq 50，正文已经开始流
    lastES().emit('round_start', { seq: 50, round: 4, run_id: 'r-current' });
    lastES().emit('assistant_delta', { run_id: 'r-current', text: '正在打字' });
    expect(s.deltaText.value).toBe('正在打字');
    const sepBefore = hooks.onSep.mock.calls.length;

    // 用户往上滚 ⇒ 更早一页（另一个 run 的更旧一轮，seq 比当前轮小得多）
    s.replayEvent({ seq: 7, run_id: 'r-old', type: 'round_start', payload: { round: 1 } }, 'older-page');
    expect(s.deltaText.value, '旧页不得清实时气泡（清了就是正在流的正文消失）').toBe('正在打字');
    expect(hooks.onSep.mock.calls.length, '展示面照旧：旧页的分隔行仍然要画').toBe(sepBefore + 1);
    expect(s.lastSeq.value, 'history 模式红线不变：旧页不推进水位线').toBe(50);

    // 轮水位没回退 ⇒ 随后到达的**当前轮**快照仍过得了双闸（改前轮号被写成旧页那个 run 的号，
    // 而这里更常见的是同一 run 的轮号被写回旧轮 ⇒ 帧整条丢弃 ⇒ 正文再也补不回来）
    lastES().emit('partial_output', { run_id: 'r-current', roundSeq: 50, text: '正在打字打完的那句', chunks: 6, source: 'memory' });
    expect(s.deltaText.value).toBe('正在打字打完的那句');
  });

  it('同一个 run 的旧页 round_start：轮水位只进不退（改前会被写成更旧的 seq ⇒ 当前轮快照被双闸误杀）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.activeRunId.value = 'r1';
    s.connect('sess-1');
    lastES().emit('round_start', { seq: 40, round: 3, run_id: 'r1' });
    lastES().emit('assistant_delta', { run_id: 'r1', text: '第三轮的正文' });
    // 旧页里同一个 run 的**第一轮**（seq 更小）
    s.replayEvent({ seq: 4, run_id: 'r1', type: 'round_start', payload: { round: 1 } }, 'older-page');
    expect(s.deltaText.value).toBe('第三轮的正文');
    // 用「号只对得上第四轮」的帧探水位实际停在哪：第三轮（40）的号还在 ⇒ 40 的帧被接受
    lastES().emit('partial_output', { run_id: 'r1', roundSeq: 40, text: '还是第三轮', chunks: 1, source: 'memory' });
    expect(s.deltaText.value, '轮水位必须仍是 40（改前这里会被回退成 4，于是整帧丢弃）').toBe('还是第三轮');
    // 脏 seq（旧页那行没带可用 seq）也不得把好水位镀成 null
    s.replayEvent({ seq: 3, run_id: 'r1', type: 'round_start', payload: { round: 0 } }, 'older-page');
    lastES().emit('partial_output', { run_id: 'r1', roundSeq: 40, text: '仍是第三轮', chunks: 1, source: 'memory' });
    expect(s.deltaText.value).toBe('仍是第三轮');
  });

  it('反向自证：**首屏历史重建（默认 mode）口径一个字没变** —— round_start 照旧清气泡', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.activeRunId.value = 'r1';
    s.connect('sess-1');
    lastES().emit('assistant_delta', { run_id: 'r1', text: '上一段残留' });
    expect(s.deltaText.value).toBe('上一段残留');
    // 同一条事件走 `'initial'`（缺省）⇒ 仍是 #502 形态 M 的口径
    s.replayEvent({ seq: 4, run_id: 'r1', type: 'round_start', payload: { round: 1 } });
    expect(s.deltaText.value, '首屏重建没有"正在流的那一段"要护 ⇒ 照旧清（本单不得顺手改这条）').toBe(null);
  });

  it('没有活跃 run 时旧页照旧写轮水位（那时它就是初始重建面，有号比没号好）', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.connect('sess-1');
    s.replayEvent({ seq: 9, run_id: 'r-x', type: 'round_start', payload: { round: 2 } }, 'older-page');
    // 没观测过 ⇒ 写得进去（用 roundSeq=9 的帧验：被接受就说明水位是 9）
    lastES().emit('partial_output', { run_id: 'r-x', roundSeq: 9, text: '写进去了', chunks: 1, source: 'memory' });
    expect(s.deltaText.value).toBe('写进去了');
  });
});

describe('审计第 6 条：脏快照只忽略，不动任何状态', () => {
  it('已有合法正文 + 来一帧 text 不是字符串 ⇒ deltaText 一个字都不变', () => {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.activeRunId.value = 'r1';
    s.connect('sess-1');
    lastES().emit('round_start', { seq: 12, round: 1, run_id: 'r1' });
    lastES().emit('assistant_delta', { run_id: 'r1', text: '合法的那段正文' });
    // 脏帧：`text` 是数字，而且**轮号也对不上**（改前它先清了气泡才走双闸）
    lastES().emit('partial_output', { run_id: 'r1', roundSeq: 999, text: 42, source: 'db' });
    expect(s.deltaText.value, '脏帧不得清掉当前合法正文').toBe('合法的那段正文');
    // 连「轮号对得上」的脏帧也不许清（那是另一种脏数据，不是「服务端说这段结束了」）
    lastES().emit('partial_output', { run_id: 'r1', roundSeq: 12, text: {}, source: 'db' });
    expect(s.deltaText.value).toBe('合法的那段正文');
    // 真·空串仍然是「清空」（那条口径没被本单改坏）
    lastES().emit('partial_output', { run_id: 'r1', roundSeq: 12, text: '', source: 'memory' });
    expect(s.deltaText.value).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// copilot 独立验收 #513 的 E2 条（261115-01）：**长正文重连时，被 textCap 截过的快照不得吃掉后缀**
//
// 事实链（三条都在产品里，不是假设）：
//   · 快照帧的 `text` 来自进程内正文缓冲，那里被 `PARTIAL_TEXT_CAP_DEFAULT = 16384` 夹过
//     （`portal/src/run-partial-buffer.js#append`：越界只置 `truncated`，**不追长尾**）；
//   · #513 把重连顺序改成「先 flush hub 缓冲、后发快照」，而 flush 的是**原始未截断**的碎片帧
//     （`portal/src/internal.js` 的 `rec.buffer` 按**条数**限，不按字节）；
//   · 前端 `partial_output` 是**覆盖式**赋值 ⇒ 正文超 16,384 时，flush 刚把完整正文送到，
//     紧随其后的那条**只有前 16,384 字符**的快照把后缀**永久盖掉**（要等 round_end/历史刷新才回）。
// 修法：同轮内正文**只增不减**——快照严格短于当前正文且是它的**前缀** ⇒ 忽略那条快照。
// 三条用例一起承重：前缀 ⇒ 忽略（新口径）；更长 ⇒ 照旧覆盖（判据 4「不重复」的方向）；
// 不是前缀 ⇒ 照旧覆盖（快照权威，别把这次修复写成「快照一律不信」）。
// ---------------------------------------------------------------------------
describe('copilot 验收 E2：被 textCap 截过的快照不得把 flush 已送达的后缀抹掉', () => {
  const CAP = 16_384; // `run-partial-buffer.js` 的 PARTIAL_TEXT_CAP_DEFAULT

  /** 起一个「当前轮正在流」的连接：轮起点 seq=7，活跃 run=r1，气泡里已有 `text`。 */
  function streaming(text: string) {
    const hooks = makeHooks();
    const s = useEventStream(hooks);
    s.activeRunId.value = 'r1';
    s.connect('sess-1');
    lastES().emit('round_start', { seq: 7, round: 1, run_id: 'r1' });
    lastES().emit('assistant_delta', { run_id: 'r1', text });
    expect(s.deltaText.value).toBe(text);
    return { s, hooks };
  }

  it('正文 20,000 字符 + 来一条 16,384 字符的**前缀**快照 ⇒ 正文仍是 20,000 字符（后缀没被吃掉）', () => {
    const full = '长'.repeat(20_000);
    const { s } = streaming(full);
    // 服务端快照：同一轮，但正文被 textCap 夹过 ⇒ 恰好是前 16,384 个字符 + truncated:true
    lastES().emit('partial_output', {
      run_id: 'r1', roundSeq: 7, text: full.slice(0, CAP), chunks: 400, truncated: true, source: 'memory',
    });
    expect(s.deltaText.value?.length, '覆盖式赋值把后缀盖掉了 ⇒ 客户端正文变短（E2 本体）')
      .toBe(full.length);
    expect(s.deltaText.value).toBe(full);
  });

  it('反例（修复能力不许丢）：正文 5,000 字符 + 快照 16,384 字符**更长** ⇒ 照旧覆盖', () => {
    const local = '甲'.repeat(5_000);
    const { s } = streaming(local);
    const snap = local + '乙'.repeat(CAP - 5_000); // 前缀 + 更多 ⇒ 更长
    expect(snap.length).toBe(CAP);
    lastES().emit('partial_output', {
      run_id: 'r1', roundSeq: 7, text: snap, chunks: 90, truncated: false, source: 'memory',
    });
    expect(s.deltaText.value, '断线期间流式过一段 ⇒ 更全的快照必须盖进来（#502 判据 4「不空洞」）')
      .toBe(snap);
  });

  it('反例（快照仍权威）：正文与快照**不是前缀关系** ⇒ 照旧覆盖', () => {
    const local = '断线前的半句';
    const { s } = streaming(local);
    // 快照比本地短，但**不是**本地正文的前缀 ⇒ 它不是「同一段被截过的那一份」，照旧以快照为准。
    //（代价口径：若快照恰好是前缀**又不是**因为 textCap（上游真的把这段话改短了），这里会选择不盖——
    // 两个形状在前端**无法区分**（帧里没有「客户端已有几个字」这一说），而吃后缀是**永久**丢字，
    // 少盖一次刷新即回 ⇒ 宁可少盖。）
    lastES().emit('partial_output', {
      run_id: 'r1', roundSeq: 7, text: '半句', chunks: 3, truncated: false, source: 'memory',
    });
    expect(s.deltaText.value).toBe('半句');
  });

  it('口径边界：空串快照**不算**「较短前缀」⇒ 照旧清气泡（E2 那条规则不得把它吞掉）', () => {
    // `'abc'.startsWith('')` 是 true、`0 < 3` 也成立 ⇒ 规则若排在空串分支**前面**，本用例立刻红。
    const { s, hooks } = streaming('已经流出的一段正文');
    const sepBefore = hooks.onSep.mock.calls.length;
    lastES().emit('partial_output', {
      run_id: 'r1', roundSeq: 7, text: '', chunks: 0, truncated: false, source: 'memory',
    });
    expect(s.deltaText.value, 'text 为空 = 服务端说这段没正文 ⇒ 清空，不是「忽略」').toBe(null);
    expect(hooks.onSep.mock.calls.length).toBe(sepBefore);
  });
});

// ---------------------------------------------------------------------------
// copilot 独立验收 #513 的 **E2** 被复审 261115-01 的 **②** 补了一代：前缀守卫缺「代际」信号
//
// 上面那条规则只问「快照是不是当前正文的严格前缀」，而**同轮内正文合法地重新变短**是存在的：
// `round_end` 把服务端正文槽清空后，下一段开写的内容完全可能恰是上一段的前缀（短句重说、
// 同一句开头）⇒ 那条规则把它当「被 textCap 截过的那一份」忽略 ⇒ 客户端**永久**停留在过期正文上
//（后续快照只会更长且不再等于当前值，盖不动；只有刷新/历史投影才能纠正）。
// 修法：服务端额外带一个单调不减的 `textSegment`（`run-partial-buffer.js` 只在 `round_start` /
// `closeRound` 两处 +1；**不能**拿 `chunks` 当代际号，它在这两处都会**归零**）。
// 三条规则（写在本单 `useEventStream.ts` 的注释里）+ 两条兜底：大⇒接受、等+严格前缀⇒忽略、
// 小⇒忽略；帧里没有该键（旧后端）或本连接从未见过该 run 的代际 ⇒ 退回旧前缀规则。
// ---------------------------------------------------------------------------
describe('copilot 复审 ②：快照带代际号时，「新一段恰是旧一段的前缀」必须被接受', () => {
  /** 起一个「当前轮正在流」的连接：轮起点 seq=7，活跃 run=r1，气泡里已有 `text`。 */
  function streaming(text: string) {
    const s = useEventStream(makeHooks());
    s.activeRunId.value = 'r1';
    s.connect('sess-1');
    lastES().emit('round_start', { seq: 7, round: 1, run_id: 'r1' });
    lastES().emit('assistant_delta', { run_id: 'r1', text });
    expect(s.deltaText.value).toBe(text);
    return s;
  }
  const snap = (over: Record<string, unknown> = {}) => lastES().emit('partial_output', {
    run_id: 'r1', roundSeq: 7, chunks: 9, truncated: false, source: 'memory', ...over,
  });

  it('代际 3 → 4，新正文是旧正文的**严格前缀** ⇒ 接受（本单核心：改前必红）', () => {
    const s = streaming('上一段说得很长的一段话');
    snap({ text: '上一段说得很长的一段话', textSegment: 3 }); // 先把基线建在 3
    expect(s.deltaText.value).toBe('上一段说得很长的一段话');
    // round_end 已清正文槽（代际 → 4），新一段开写，而它恰是上一段的前缀
    snap({ text: '上一段说', textSegment: 4 });
    expect(s.deltaText.value, '代际升了一格 = 新一段，哪怕更短、哪怕恰是前缀 ⇒ 必须盖进来')
      .toBe('上一段说');
  });

  it('代际相同 + 严格前缀 ⇒ 忽略（E2 那条截断保护不许回退）', () => {
    const s = streaming('已经送达的完整正文');
    snap({ text: '已经送达的完整正文', textSegment: 6 });
    snap({ text: '已经送达', textSegment: 6 }); // 同一段被 textCap 截过的那一份
    expect(s.deltaText.value, '同代际 + 严格前缀 = 同一段的较短那份 ⇒ 不得吃掉后缀')
      .toBe('已经送达的完整正文');
  });

  it('代际变小 ⇒ 忽略（过期快照，且不得把水位线拉回去）', () => {
    const s = streaming('当前这一段');
    snap({ text: '当前这一段', textSegment: 9 });
    snap({ text: '当前这一段更长的一份旧快照', textSegment: 8 }); // 更旧一代 ⇒ 整帧忽略
    expect(s.deltaText.value).toBe('当前这一段');
    // 水位线没被 8 拉回去 ⇒ 下一代（9 的下一格）仍能被认成「新一段」，哪怕它更短且是前缀
    snap({ text: '当前', textSegment: 10 });
    expect(s.deltaText.value, '过期帧不得把代际水位线拉低，否则下一代又被当旧帧').toBe('当前');
  });

  it('帧里**没有** textSegment（旧后端）⇒ 退回前缀规则，且不报错（兼容口径）', () => {
    const s = streaming('旧后端的完整正文');
    snap({ text: '旧后端的' }); // 无 textSegment + 严格前缀 ⇒ 走旧规则忽略
    expect(s.deltaText.value).toBe('旧后端的完整正文');
    snap({ text: '旧后端的完整正文与更多' }); // 更长 ⇒ 照旧覆盖
    expect(s.deltaText.value).toBe('旧后端的完整正文与更多');
  });

  it('本连接从未见过该 run 的代际（刚重连）⇒ 第一帧走前缀规则，但基线已建立，下一代能接上', () => {
    const s = streaming('重连前已经送达的完整正文');
    snap({ text: '重连前已', textSegment: 12 }); // 无基线 + 严格前缀 ⇒ 保守忽略（E2 不回退）
    expect(s.deltaText.value).toBe('重连前已经送达的完整正文');
    snap({ text: '重连后新的一段', textSegment: 13 }); // 代际 +1 ⇒ 新一段 ⇒ 接受
    expect(s.deltaText.value).toBe('重连后新的一段');
  });

  it('代际脏值（字符串/NaN）⇒ 当旧后端处理，不拿它当 0（宁缺不错）', () => {
    const s = streaming('正文当前长度');
    snap({ text: '正文', textSegment: '3' });   // 脏 ⇒ 当前缀规则 ⇒ 忽略
    expect(s.deltaText.value).toBe('正文当前长度');
    snap({ text: '正文', textSegment: Number.NaN });
    expect(s.deltaText.value).toBe('正文当前长度');
  });
});

// ---------------------------------------------------------------------------
// copilot 独立验收 #513 的 **D 条**（261115-01）：旧页回放同样不得回退**轮号**水位
//
// 审计第 4 条（261114-05）只给 `observeRoundSeq`（轮**起点 seq**）加了 `olderPage` 保护，
// 而 `observeRound`（轮**号** → `roundTokenByRun` → `cardIdentity`）仍是无条件写，
// `case 'round_start'` 又先调它再调 seq 那个 ⇒ 用户往上滚加载更早一页时：
//   旧页那轮的 `round_start` 把 `roundTokenByRun` 改回**旧轮** ⇒ 之后所有工具卡片
//   （`cardIdentity` → `roundTokenFor`）都拿错轮号当身份 ⇒ #279 那把身份尺整段失效
//   （新调用被归到旧轮那张卡上 / 同一轮的两次调用被拆成两种键形状）。
// 另修一处口径糊账：`observeRoundSeq` 原来把「从未观测」（Map 里没有 = `undefined`）与
// 「已观测但轮起点未知」（值是 `null`）当成同一种 ⇒ 旧页的有限 seq 能盖掉 `null`，
// 与它自己注释里「记 null ⇒ 谁都不许盖，宁缺不错」直接矛盾。
// 观测面：轮号从 `toolCards` 的**键**看（`cardIdentity` 就是那把尺，不测私有 Map）。
// ---------------------------------------------------------------------------
describe('copilot 验收 D：旧页回放不得回退轮号水位（roundTokenByRun），且 null ≠ undefined', () => {
  it('旧页回放同 run 更旧的 round_start ⇒ 卡片身份的轮号段不变（改前会被写成旧页那一轮）', () => {
    const s = useEventStream(makeHooks());
    s.activeRunId.value = 'r1';
    s.connect('sess-1');
    lastES().emit('round_start', { seq: 40, round: 3, run_id: 'r1' });
    lastES().emit('tool_use', { seq: 41, run_id: 'r1', tool_call_id: 'c1', name: 'bash', input: {} });
    expect([...s.toolCards.keys()]).toEqual(['r1:3:c1']); // 前置：轮号段确实是 3

    // 用户往上滚 ⇒ 更早一页里同一个 run 的**第一轮**
    s.replayEvent({ seq: 4, run_id: 'r1', type: 'round_start', payload: { round: 1 } }, 'older-page');
    lastES().emit('tool_use', { seq: 42, run_id: 'r1', tool_call_id: 'c2', name: 'edit', input: {} });
    expect([...s.toolCards.keys()], '旧页把轮号写回 1 ⇒ 新调用被挂到「第 1 轮」那张卡上')
      .toEqual(['r1:3:c1', 'r1:3:c2']);
  });

  it('首屏历史重建（initial）同一情形 ⇒ 轮号照旧被写进去（别把首屏也改坏）', () => {
    const s = useEventStream(makeHooks());
    s.activeRunId.value = 'r1';
    s.connect('sess-1');
    lastES().emit('round_start', { seq: 40, round: 3, run_id: 'r1' });
    lastES().emit('tool_use', { seq: 41, run_id: 'r1', tool_call_id: 'c1', name: 'bash', input: {} });
    expect([...s.toolCards.keys()]).toEqual(['r1:3:c1']);

    // 同一条事件走缺省 `'initial'` = 首屏重建面：那时没有「正在流的一段」要护，照旧照单写
    s.replayEvent({ seq: 4, run_id: 'r1', type: 'round_start', payload: { round: 1 } });
    lastES().emit('tool_use', { seq: 42, run_id: 'r1', tool_call_id: 'c2', name: 'edit', input: {} });
    expect([...s.toolCards.keys()], '首屏口径一个字都不许被 D 条改掉').toEqual(['r1:3:c1', 'r1:1:c2']);
  });

  it('旧页里含**更新**的同 run round_start（seq 与轮号都更大）⇒ 照旧接受（不能一刀切拒绝）', () => {
    const s = useEventStream(makeHooks());
    s.activeRunId.value = 'r1';
    s.connect('sess-1');
    lastES().emit('round_start', { seq: 40, round: 3, run_id: 'r1' });
    // 旧页里居然有一条更新的（例如本页跨到了下一轮，或实时漏收过一条 round_start）
    s.replayEvent({ seq: 50, run_id: 'r1', type: 'round_start', payload: { round: 5 } }, 'older-page');
    lastES().emit('tool_use', { seq: 51, run_id: 'r1', tool_call_id: 'c9', name: 'bash', input: {} });
    expect([...s.toolCards.keys()], '轮号必须跟到 5（D 条只挡「更旧 / 脏」，不是「旧页一律不要」）')
      .toEqual(['r1:5:c9']);
    // 轮**起点 seq** 水位同步跟上 ⇒ 第 5 轮的快照仍被双闸接受
    lastES().emit('partial_output', { run_id: 'r1', roundSeq: 50, text: '第五轮的正文', chunks: 2, source: 'memory' });
    expect(s.deltaText.value).toBe('第五轮的正文');
  });

  it('轮起点 seq 记成 null 时旧页的有限 seq **不得写**（已观测但未知 = 谁都不许盖）', () => {
    const s = useEventStream(makeHooks());
    s.activeRunId.value = 'r1';
    s.connect('sess-1');
    lastES().emit('round_start', { round: 2, run_id: 'r1' }); // 脏帧：没有 seq ⇒ 记 null
    lastES().emit('assistant_delta', { run_id: 'r1', text: '当前这段正文' });
    // 旧页拿来一条**有限**的 seq：改前 `cur !== null && cur !== undefined` 把 null 当成「没水位」放行
    s.replayEvent({ seq: 9, run_id: 'r1', type: 'round_start', payload: { round: 1 } }, 'older-page');
    lastES().emit('partial_output', { run_id: 'r1', roundSeq: 9, text: '拿旧页的号来硬对', chunks: 1, source: 'memory' });
    expect(s.deltaText.value, 'null 是「谁都不许盖」，不是「随便谁来填」').toBe('当前这段正文');
  });

  it('该 run 从未观测（undefined）⇒ 旧页的有限 seq 照旧写得进去（初始重建面）', () => {
    const s = useEventStream(makeHooks());
    s.activeRunId.value = 'r-never';
    s.connect('sess-1');
    s.replayEvent({ seq: 9, run_id: 'r-never', type: 'round_start', payload: { round: 1 } }, 'older-page');
    lastES().emit('partial_output', { run_id: 'r-never', roundSeq: 9, text: '写得进去', chunks: 1, source: 'memory' });
    expect(s.deltaText.value).toBe('写得进去');
    // 轮号同理：从未观测 ⇒ 旧页的轮号也写得进去（卡片身份拿得到轮号总比 `?` 好）
    lastES().emit('tool_use', { seq: 10, run_id: 'r-never', tool_call_id: 'c1', name: 'bash', input: {} });
    expect([...s.toolCards.keys()]).toEqual(['r-never:1:c1']);
  });

  it('轮号已观测但未知（`?`）⇒ 旧页的有限轮号**不得写**（与 seq 的 null 同一口径）', () => {
    const s = useEventStream(makeHooks());
    s.activeRunId.value = 'r1';
    s.connect('sess-1');
    lastES().emit('round_start', { seq: 40, run_id: 'r1' }); // 有 seq、没 round ⇒ 轮号记 `?`
    s.replayEvent({ seq: 4, run_id: 'r1', type: 'round_start', payload: { round: 1 } }, 'older-page');
    lastES().emit('tool_use', { seq: 41, run_id: 'r1', tool_call_id: 'c1', name: 'bash', input: {} });
    expect([...s.toolCards.keys()], '已观测过这个 run ⇒ 旧页那个 1 多半是更旧的一轮，宁缺不错')
      .toEqual(['r1:c1']);
  });

  it('`attempt` 也在旧页回放里 ⇒ 同一口径（不得把轮号写成旧页那一轮的）', () => {
    const s = useEventStream(makeHooks());
    s.activeRunId.value = 'r1';
    s.connect('sess-1');
    lastES().emit('round_start', { seq: 40, round: 3, run_id: 'r1' });
    s.replayEvent({ seq: 5, run_id: 'r1', type: 'attempt', payload: { round: 1, attempt: 2, maxAttempts: 3 } }, 'older-page');
    lastES().emit('tool_use', { seq: 41, run_id: 'r1', tool_call_id: 'c1', name: 'bash', input: {} });
    expect([...s.toolCards.keys()]).toEqual(['r1:3:c1']);
  });
});
