// 动量状态机单测（issue #282 B）：ingest 语义（增量/工具/轮号/usage/终态）、history 短路、
// 别的 run 的迟到帧不串台、store 的 SSE 旁路钩子（onEvent）真的把帧喂进来。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createRunMomentumFeed } from './useRunMomentum';
import { useWorkbenchStore } from '../stores/workbench';
import { setLocale } from '../i18n';

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"items":[]}', { status: 200 })));
});

describe('createRunMomentumFeed（状态机）', () => {
  it('beginRun 登记起跑时刻；重复登记同一 run 不清零已收到的增量', () => {
    const feed = createRunMomentumFeed();
    feed.beginRun('r1', 1_000);
    expect(feed.state.runId).toBe('r1');
    expect(feed.state.startedAt).toBe(1_000);
    feed.ingest('assistant_delta', { run_id: 'r1', text: 'abcdef' }, false, 2_000);
    expect(feed.state.outputChars).toBe(6);
    feed.beginRun('r1', 1_000); // POST + 首帧两次登记
    expect(feed.state.outputChars).toBe(6);
    expect(feed.state.samples).toHaveLength(1);
  });

  it('重复登记同一 run 不拿 null 覆盖已知起跑时刻（SSE 重连对账那条路径只能给 null）', () => {
    const feed = createRunMomentumFeed();
    feed.beginRun('r1', 1_000);
    feed.beginRun('r1', null); // 重连对账：起跑时刻未知
    expect(feed.state.startedAt).toBe(1_000);
    // 但「起跑时刻未知」的首次登记仍然生效（页面中途打开的真实场景）
    const late = createRunMomentumFeed();
    late.beginRun('r9', null);
    expect(late.state.startedAt).toBeNull();
  });

  it('assistant_delta 累计字符与 UTF-8 字节（中文 3 字节）', () => {
    const feed = createRunMomentumFeed();
    feed.beginRun('r1', 0);
    feed.ingest('assistant_delta', { run_id: 'r1', text: 'abc' }, false, 100);
    feed.ingest('assistant_delta', { run_id: 'r1', text: '中文' }, false, 200);
    expect(feed.state.outputChars).toBe(5);
    expect(feed.state.outputBytes).toBe(9);
    // 脏载荷（text 不是字符串）不推进计数，也不写 NaN
    feed.ingest('assistant_delta', { run_id: 'r1', text: 42 }, false, 300);
    expect(feed.state.outputChars).toBe(5);
  });

  it('轮号取最近一次带轮号的事件；脏轮号不覆盖已知值', () => {
    const feed = createRunMomentumFeed();
    feed.beginRun('r1', 0);
    feed.ingest('round_start', { run_id: 'r1', round: 3 }, false, 10);
    expect(feed.state.round).toBe(3);
    feed.ingest('round_start', { run_id: 'r1', round: 'nope' }, false, 20);
    expect(feed.state.round).toBe(3);
    feed.ingest('attempt', { run_id: 'r1', round: 4 }, false, 30);
    expect(feed.state.round).toBe(4);
  });

  it('工具：tool_use 计数；只有带有限时长的 tool_result 才计入均值', () => {
    const feed = createRunMomentumFeed();
    feed.beginRun('r1', 0);
    feed.ingest('tool_use', { run_id: 'r1', tool_call_id: 'c1' }, false, 10);
    feed.ingest('tool_use', { run_id: 'r1', tool_call_id: 'c2' }, false, 20);
    feed.ingest('tool_result', { run_id: 'r1', tool_call_id: 'c1', duration_ms: 4000 }, false, 30);
    feed.ingest('tool_result', { run_id: 'r1', tool_call_id: 'c2' }, false, 40); // 没时长：不计入
    expect(feed.state.toolCount).toBe(2);
    expect(feed.state.toolDurCount).toBe(1);
    expect(feed.state.toolDurTotalMs).toBe(4000);
  });

  it('run_end：usage 真值原样收下；没给 usage 就保持 null（不补 0）', () => {
    const feed = createRunMomentumFeed();
    feed.beginRun('r1', 0);
    feed.ingest('run_end', {
      run_id: 'r1',
      termination: { reason: 'end_turn' },
      usage: { input_tokens: 15_230, output_tokens: 2_104 },
    }, false, 5000);
    expect(feed.state.usage).toEqual({ input_tokens: 15_230, output_tokens: 2_104 });
    expect(feed.state.termination).toBe('end_turn');
    expect(feed.state.endedAt).toBe(5000);

    const noUsage = createRunMomentumFeed();
    noUsage.beginRun('r2', 0);
    noUsage.ingest('run_end', { run_id: 'r2', termination: { reason: 'aborted' }, usage: null }, false, 100);
    expect(noUsage.state.usage).toBeNull();
    expect(noUsage.state.endedAt).toBe(100);
  });

  it('history=true 的帧一律短路（硬刷新后运行态数字不保留，不许拿历史帧假装在跑）', () => {
    const feed = createRunMomentumFeed();
    feed.ingest('round_start', { run_id: 'r1', round: 9 }, true, 100);
    feed.ingest('assistant_delta', { run_id: 'r1', text: 'abc' }, true, 200);
    feed.ingest('tool_use', { run_id: 'r1', tool_call_id: 'c1' }, true, 300);
    feed.ingest('run_end', { run_id: 'r1', usage: { input_tokens: 1, output_tokens: 1 } }, true, 400);
    expect(feed.state).toMatchObject({
      runId: null, round: null, outputChars: 0, outputBytes: 0, toolCount: 0, usage: null, endedAt: null,
    });
  });

  it('别的 run 的迟到帧不串台：正在跑 r1 时 r2 的帧被忽略；r1 结束后 r2 的帧开启新 run', () => {
    const feed = createRunMomentumFeed();
    feed.beginRun('r1', 0);
    feed.ingest('assistant_delta', { run_id: 'r1', text: 'aaa' }, false, 100);
    feed.ingest('assistant_delta', { run_id: 'r2', text: 'bbbb' }, false, 200); // 迟到帧
    expect(feed.state.runId).toBe('r1');
    expect(feed.state.outputChars).toBe(3);
    feed.ingest('run_end', { run_id: 'r1' }, false, 300);
    feed.ingest('round_start', { run_id: 'r2', round: 1 }, false, 400);
    expect(feed.state.runId).toBe('r2');
    expect(feed.state.outputChars).toBe(0);
    expect(feed.state.endedAt).toBeNull();
  });

  it('没有 run 的帧不造 run（旧后端/无 run_id ⇒ 没有动量）', () => {
    const feed = createRunMomentumFeed();
    feed.ingest('assistant_delta', { text: 'abc' }, false, 100);
    expect(feed.state.runId).toBeNull();
    expect(feed.state.outputChars).toBe(0);
  });

  it('滑窗样本有界（只留最近两个窗口，长 run 不无限增长）', () => {
    const feed = createRunMomentumFeed();
    feed.beginRun('r1', 0);
    for (let i = 1; i <= 200; i++) {
      feed.ingest('assistant_delta', { run_id: 'r1', text: 'x' }, false, i * 1000);
    }
    expect(feed.state.samples.length).toBeLessThan(200);
    expect(feed.state.outputChars).toBe(200);
  });

  it('reset 清空一切（切会话不复用上一个会话的动量）', () => {
    const feed = createRunMomentumFeed();
    feed.beginRun('r1', 0);
    feed.ingest('assistant_delta', { run_id: 'r1', text: 'abc' }, false, 10);
    feed.reset();
    expect(feed.state).toMatchObject({ runId: null, startedAt: null, outputChars: 0, outputBytes: 0, samples: [] });
  });
});

describe('store 接线（useEventStream 的 onEvent 旁路）', () => {
  function frame(data: unknown): MessageEvent {
    return { data: JSON.stringify(data) } as MessageEvent;
  }

  it('SSE 帧经 store 进入动量状态机（round_start / assistant_delta / tool_use / run_end）', () => {
    const store = useWorkbenchStore();
    store.momentum.beginRun('r1', 0);
    store.es.handleEvent('round_start', frame({ run_id: 'r1', round: 12, seq: 1 }));
    store.es.handleEvent('assistant_delta', frame({ run_id: 'r1', text: 'hello world', seq: 2 }));
    store.es.handleEvent('tool_use', frame({ run_id: 'r1', tool_call_id: 'c1', name: 'bash', input: {}, seq: 3 }));
    store.es.handleEvent('tool_result', frame({ run_id: 'r1', tool_call_id: 'c1', ok: true, duration_ms: 12_000, seq: 4 }));
    store.es.handleEvent('run_end', frame({
      run_id: 'r1', termination: { reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 20 }, seq: 5,
    }));
    expect(store.momentum.state).toMatchObject({
      runId: 'r1', round: 12, toolCount: 1, toolDurCount: 1, toolDurTotalMs: 12_000,
      usage: { input_tokens: 10, output_tokens: 20 }, termination: 'end_turn',
    });
    expect(store.momentum.state.outputBytes).toBe(11);
    expect(store.momentum.state.endedAt).not.toBeNull();
  });

  it('usage 事件只推进「最后活动时刻」，不当 run tokens 显示（载荷是单次调用用量）', () => {
    const store = useWorkbenchStore();
    store.momentum.beginRun('r1', 0);
    store.es.handleEvent('usage', frame({ run_id: 'r1', round: 1, usage: { input_tokens: 999, output_tokens: 111 } }));
    expect(store.momentum.state.usage).toBeNull(); // 不拿单次调用用量冒充整 run 汇总
    expect(store.momentum.state.lastEventAt).not.toBeNull();
  });

  it('历史回放帧（replayEvent）不驱动运行态：刷新后状态条不会假装「在跑」', () => {
    const store = useWorkbenchStore();
    store.es.replayEvent({ seq: 1, run_id: 'r1', type: 'round_start', payload: { round: 7 } });
    store.es.replayEvent({ seq: 2, run_id: 'r1', type: 'tool_use', payload: { tool_call_id: 'c1', name: 'bash' } });
    expect(store.momentum.state).toMatchObject({ runId: null, round: null, toolCount: 0 });
  });

  it('send 链路登记起跑时刻（POST 返回 run id 即为最早已知起跑点）', async () => {
    const store = useWorkbenchStore();
    store.sessionId = 's1';
    store.dirCwd = '~/projects/demo';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      message: { id: 'm1', role: 'user', content: 'hi', created_at: '2026-10-23T13:42:07.000Z' },
      run: { id: 'run-1' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    store.inputValue = 'hi';
    await store.send();
    expect(store.momentum.state.runId).toBe('run-1');
    expect(store.momentum.state.startedAt).not.toBeNull();
    // issue #282 A：用户消息的时刻也来自 POST 返回的 created_at
    const msg = store.entries.find((en) => en.kind === 'msg');
    expect(msg && msg.kind === 'msg' ? msg.createdAt : undefined).toBe('2026-10-23T13:42:07.000Z');
  });
});

// ---- issue #425：相位跟踪 / usage 面 / 历史用量口子 ----
describe('#425 相位跟踪（让状态条一直说得出自己在等什么）', () => {
  it('round_start ⇒ 等 LLM；delta ⇒ 收流；tool_use ⇒ 工具中（带名字）；tool_result 全部交差 ⇒ 回到等 LLM', () => {
    const feed = createRunMomentumFeed();
    feed.beginRun('r1', 0);
    feed.ingest('round_start', { run_id: 'r1', round: 1 }, false, 1_000);
    expect(feed.state).toMatchObject({ phase: 'awaiting_llm', phaseAt: 1_000, pendingTools: 0 });

    feed.ingest('assistant_delta', { run_id: 'r1', text: 'hi' }, false, 2_000);
    expect(feed.state).toMatchObject({ phase: 'streaming', phaseAt: 2_000 });

    feed.ingest('reasoning_delta', { run_id: 'r1', text: 'hm' }, false, 2_500);
    expect(feed.state.phase).toBe('streaming');       // 推理增量同样算「上游在回话」
    expect(feed.state.phaseAt).toBe(2_000);           // 同相位内不重置计时（否则秒数永远停在 0）

    feed.ingest('tool_use', { run_id: 'r1', tool_call_id: 'c1', name: 'shell' }, false, 3_000);
    expect(feed.state).toMatchObject({ phase: 'tool_running', phaseAt: 3_000, activeToolName: 'shell', pendingTools: 1 });

    feed.ingest('tool_result', { run_id: 'r1', tool_call_id: 'c1', duration_ms: 5 }, false, 4_000);
    expect(feed.state).toMatchObject({ phase: 'awaiting_llm', phaseAt: 4_000, activeToolName: null, pendingTools: 0 });
  });

  it('并发工具：还有未交差的工具时相位留在 tool_running（不提前说「在等模型」）', () => {
    const feed = createRunMomentumFeed();
    feed.beginRun('r1', 0);
    feed.ingest('tool_use', { run_id: 'r1', tool_call_id: 'a', name: 'readFile' }, false, 10);
    feed.ingest('tool_use', { run_id: 'r1', tool_call_id: 'b', name: 'readFile' }, false, 11);
    feed.ingest('tool_result', { run_id: 'r1', tool_call_id: 'a', duration_ms: 1 }, false, 20);
    expect(feed.state.phase).toBe('tool_running');
    feed.ingest('tool_result', { run_id: 'r1', tool_call_id: 'b', duration_ms: 1 }, false, 30);
    expect(feed.state.phase).toBe('awaiting_llm');
  });

  it('tool_use 没带名字 ⇒ activeToolName 保持未知（文案整段不写工具名，不写 undefined）', () => {
    const feed = createRunMomentumFeed();
    feed.beginRun('r1', 0);
    feed.ingest('tool_use', { run_id: 'r1', tool_call_id: 'c1' }, false, 10);
    expect(feed.state.activeToolName).toBeNull();
    expect(feed.state.phase).toBe('tool_running');
  });
});

describe('#425 usage 面（单次调用 vs 本 run 累计两个数，都不估算）', () => {
  it('usage 落到 roundUsage（不是 run_end 的 usage）；同轮多次调用累加', () => {
    const feed = createRunMomentumFeed();
    feed.beginRun('r1', 0);
    feed.ingest('usage', { run_id: 'r1', round: 3, usage: { input_tokens: 100, output_tokens: 10 } }, false, 10);
    feed.ingest('usage', { run_id: 'r1', round: 3, usage: { input_tokens: 0, output_tokens: 5 } }, false, 11);
    expect(feed.state.roundUsage).toEqual({ input_tokens: 100, output_tokens: 15 });
    expect(feed.state.usage).toBeNull();  // 绝不拿单次调用冒充整 run
    expect(feed.state.runUsage).toBeNull();
  });

  it('换轮 ⇒ 本轮用量重置；round_end 填累计值且**不清**本轮（轮间空档不闪没）', () => {
    const feed = createRunMomentumFeed();
    feed.beginRun('r1', 0);
    feed.ingest('usage', { run_id: 'r1', round: 1, usage: { input_tokens: 100, output_tokens: 10 } }, false, 10);
    feed.ingest('round_end', { run_id: 'r1', round: 1, usage: { input_tokens: 100, output_tokens: 10 } }, false, 20);
    expect(feed.state.runUsage).toEqual({ input_tokens: 100, output_tokens: 10 });
    expect(feed.state.roundUsage).toEqual({ input_tokens: 100, output_tokens: 10 }); // 仍在（此刻界面说的就是这一轮）

    feed.ingest('round_start', { run_id: 'r1', round: 2 }, false, 30);
    expect(feed.state.roundUsage).toBeNull();          // 新一轮开始才清（不拿上一轮的数冒充本轮）
    expect(feed.state.runUsage).toEqual({ input_tokens: 100, output_tokens: 10 }); // 累计不清

    feed.ingest('round_end', { run_id: 'r1', round: 2, usage: { input_tokens: 260, output_tokens: 25 } }, false, 40);
    expect(feed.state.runUsage).toEqual({ input_tokens: 260, output_tokens: 25 }); // 引擎给的是累计 ⇒ 覆盖不是相加
  });

  it('context_window：正数才收；0 / 负 / 脏值不覆盖已知值', () => {
    const feed = createRunMomentumFeed();
    feed.beginRun('r1', 0);
    feed.ingest('usage', { run_id: 'r1', usage: { input_tokens: 1 }, context_window: 262_144 }, false, 10);
    expect(feed.state.contextWindow).toBe(262_144);
    feed.ingest('usage', { run_id: 'r1', usage: { input_tokens: 1 }, context_window: 0 }, false, 11);
    expect(feed.state.contextWindow).toBe(262_144);   // 不拿「没有」盖掉已知值
    feed.ingest('usage', { run_id: 'r1', usage: { input_tokens: 1 } }, false, 12);
    expect(feed.state.contextWindow).toBe(262_144);   // 没带也保持
  });

  it('round_end 不带 usage ⇒ 不覆盖已有累计（缺键 = 没拿到，不是 0）', () => {
    const feed = createRunMomentumFeed();
    feed.beginRun('r1', 0);
    feed.ingest('round_end', { run_id: 'r1', round: 1, usage: { input_tokens: 10, output_tokens: 1 } }, false, 10);
    feed.ingest('round_end', { run_id: 'r1', round: 2, usage: null }, false, 20);
    expect(feed.state.runUsage).toEqual({ input_tokens: 10, output_tokens: 1 });
  });
});

describe('#425 历史回放的唯一口子：round_end 的累计用量（其余历史帧仍一律短路）', () => {
  it('硬刷新后：历史 round_end 填出「上次 run」的 token 与窗口，但状态仍是空闲', () => {
    const feed = createRunMomentumFeed();
    feed.ingest('round_end', {
      run_id: 'r-old', round: 2,
      usage: { input_tokens: 2_048, output_tokens: 64 },
      context_window: 262_144,
    }, true, 5_000);
    expect(feed.state.runId).toBe('r-old');
    expect(feed.state.endedAt).toBe(5_000);              // 已结束 ⇒ 空闲态那一栏
    expect(feed.state.startedAt).toBeNull();             // 起跑时刻未知 ⇒ 不假一个时长
    expect(feed.state.usage).toEqual({ input_tokens: 2_048, output_tokens: 64 });
    expect(feed.state.contextWindow).toBe(262_144);
    expect(feed.state.phase).toBeNull();                 // 相位/轮号/速率一律不吃历史帧
    expect(feed.state.round).toBeNull();
  });

  it('按 seq 升序回放：后面的轮盖住前面的，累计量不回退', () => {
    const feed = createRunMomentumFeed();
    feed.ingest('round_end', { run_id: 'r1', round: 1, usage: { input_tokens: 100, output_tokens: 5 } }, true, 10);
    feed.ingest('round_end', { run_id: 'r1', round: 2, usage: { input_tokens: 260, output_tokens: 12 } }, true, 11);
    expect(feed.state.usage).toEqual({ input_tokens: 260, output_tokens: 12 });
  });

  it('正在跟踪活跃 run 时，别的 run 的历史 round_end 不得插进来', () => {
    const feed = createRunMomentumFeed();
    feed.beginRun('r-live', 0);
    feed.ingest('round_end', { run_id: 'r-old', round: 1, usage: { input_tokens: 9, output_tokens: 9 } }, true, 10);
    expect(feed.state.runId).toBe('r-live');
    expect(feed.state.usage).toBeNull();
    expect(feed.state.endedAt).toBeNull();
  });

  it('除 round_end 之外的历史帧照旧一律短路（不许借这个口子复活运行态）', () => {
    const feed = createRunMomentumFeed();
    feed.ingest('tool_use', { run_id: 'r1', tool_call_id: 'c1', name: 'shell' }, true, 10);
    feed.ingest('usage', { run_id: 'r1', usage: { input_tokens: 9, output_tokens: 9 } }, true, 11);
    expect(feed.state).toMatchObject({ runId: null, toolCount: 0, roundUsage: null, contextWindow: null });
  });

  it('reset 后不留上一个会话的用量与窗口', () => {
    const feed = createRunMomentumFeed();
    feed.ingest('round_end', { run_id: 'r1', usage: { input_tokens: 1, output_tokens: 1 }, context_window: 100 }, true, 10);
    feed.reset();
    expect(feed.state).toMatchObject({ runId: null, usage: null, runUsage: null, contextWindow: null, phase: null });
  });
});
