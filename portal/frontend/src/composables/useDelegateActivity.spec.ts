// `useDelegateActivity` 的轮询纪律与归一化（issue #592 交付 1，判据 9~13/16 的数据层那一半）。
// 形状照 `useGitLight.spec.ts`：`effectScope()` 包住（`onScopeDispose` 才会走）+ 全局 `fetch` 桩，
// 不引 pinia（本 composable 不依赖 store，三个入参以 getter 显式注入 ⇒ 单测能直接驱动判据）。
//
// ⚠ 这里**不用** `w.emitted()`（`NODE_ENV=production` 下恒空，AGENTS.md §4 / issue #496），
//   本文件压根没有组件，只数 `fetch` 的调用次数与 ref 的值。
import { afterEach, beforeEach, describe, expect, it, vi, onTestFinished } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import {
  DELEGATE_ACTIVITY_FAIL_THRESHOLD,
  delegateRosterUrl,
  normalizeDelegateItems,
  useDelegateActivity,
  type DelegateActivityCardLike,
} from './useDelegateActivity';
import { DELEGATE_POLL_MS } from '../lib/delegate';

const PARENT = 'run-1';
const SESSION = 'sess-1';

/** 一条名册记录（缺省是「活着的 running 子」，各用例只覆盖自己要的那一格）。 */
function rosterItem(overrides: Record<string, unknown> = {}) {
  return {
    childRunId: 'sub-aaaa',
    state: 'running',
    cwd: '~/projects/demo',
    model: 'gpt-6-luna',
    createdAt: 1_700_000_000_000,
    endedAt: null,
    updatedAt: null,
    termination: null,
    errorMessage: null,
    resultTruncated: false,
    hasTranscript: true,
    ...overrides,
  };
}

function rosterBody(...items: unknown[]) {
  return { items, skipped: 0 };
}

/** delegate 卡（真实 `ToolCardState` 的结构子集）；缺省是「结果还没回来」的前台子常态。 */
function delegateCard(overrides: Record<string, unknown> = {}): DelegateActivityCardLike {
  return {
    name: 'delegate',
    ok: null,
    runId: PARENT,
    out: '',
    resultPreview: '',
    ...overrides,
  } as DelegateActivityCardLike;
}

const fetchMock = vi.fn();

function ok(body: unknown) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
}

function fail(status: number) {
  // `api()` 会读 `Retry-After` 头（#255）⇒ 桩必须带 headers，否则 headers.get 自己抛 TypeError，
  // 用例验的就不再是「服务端 500」这个形状了。
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({ error: { message: 'boom', code: 'internal_error' } }),
  };
}

/** 依次吐响应；用尽后重复最后一个（免得尾部拿到 undefined 变成假形状）。 */
function queueResponses(...responses: Array<{ ok: boolean; status: number; headers: { get: (k: string) => null }; json: () => Promise<unknown> }>) {
  fetchMock.mockImplementation(async () => {
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return next;
  });
}

interface Harness {
  sessionId: { value: string | null };
  activeRunId: { value: string | null };
  cards: { value: DelegateActivityCardLike[] };
  handle: ReturnType<typeof useDelegateActivity>;
  scope: ReturnType<typeof effectScope>;
}

function setup(options: {
  sessionId?: string | null;
  activeRunId?: string | null;
  cards?: DelegateActivityCardLike[];
  pollMs?: number;
} = {}): Harness {
  const sessionId = ref<string | null>(options.sessionId === undefined ? SESSION : options.sessionId);
  const activeRunId = ref<string | null>(options.activeRunId === undefined ? PARENT : options.activeRunId);
  const cards = ref<DelegateActivityCardLike[]>(options.cards ?? []);
  const scope = effectScope();
  const handle = scope.run(() => useDelegateActivity({
    sessionId: () => sessionId.value,
    activeRunId: () => activeRunId.value,
    cards: () => cards.value,
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
  }))!;
  // 不收尾就会漏：interval 活到下一个用例，一开 fake timers 全部一起响（"6 次请求"这种假象的来处）。
  onTestFinished(() => scope.stop());
  return { sessionId, activeRunId, cards, handle, scope };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ok(rosterBody()));
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_060_000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 推进 fake timers 并冲刷微任务（fetch 桩是 promise，纯 advanceTimersByTime 不够）。 */
async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  await nextTick();
}

function setVisible(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
}

describe('触发判据（本轮存在 delegate 卡才轮询，设计 §4.2）', () => {
  it('判据 1：没有任何 delegate 卡 ⇒ 一个请求都不发（哪怕 run 在跑）', async () => {
    const { handle } = setup({ cards: [{ name: 'bash', ok: null, runId: PARENT }] });
    await tick(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(handle.shouldPoll.value).toBe(false);
  });

  it('判据 1 反证面：没有会话或没有活跃 run ⇒ 也不发（没有名册可读）', async () => {
    const noSession = setup({ sessionId: null, cards: [delegateCard()] });
    await tick(6_000);
    expect(fetchMock).not.toHaveBeenCalled();
    noSession.scope.stop();

    setup({ activeRunId: null, cards: [delegateCard()] }); // 没有活跃 run ⇒ 连一次都不该发
    await tick(6_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('卡 `runId` 缺失 / 属于别的 run ⇒ 不算触发（宁可少触发，也不在老 run 上永久轮询）', async () => {
    const { handle } = setup({
      cards: [
        { name: 'delegate', ok: null } as DelegateActivityCardLike, // 没有 runId（脏数据/旧卡片）
        delegateCard({ runId: 'some-older-run' }),                  // 属于上一个 run
      ],
    });
    await tick(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(handle.shouldPoll.value).toBe(false);
  });

  it('结果已回且子已终态（completed）⇒ 不触发（工具卡自己就够了，不必再开面板）', async () => {
    const { handle } = setup({
      cards: [delegateCard({
        ok: true,
        resultPreview: JSON.stringify({ ok: true, runId: 'sub-aaaa', state: 'completed', action: 'dispatch' }),
      })],
    });
    await tick(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(handle.shouldPoll.value).toBe(false);
  });

  it('判据 2/7：pending 卡（ok:null，含刷新回放重建的那条）⇒ 立刻一发，之后每 2s 一发', async () => {
    queueResponses(ok(rosterBody(rosterItem())), ok(rosterBody(rosterItem())), ok(rosterBody(rosterItem())));
    const { handle } = setup({ cards: [delegateCard()] });
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(`/api/sessions/${SESSION}/delegates?runId=${PARENT}`);
    expect(handle.shouldPoll.value).toBe(true);

    await tick(DELEGATE_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(DELEGATE_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('两个 id 都被 encode（会话 id 里有 `/` 也不越界）', async () => {
    const { handle } = setup({ sessionId: 'a/b', activeRunId: 'r 1' });
    await handle.poll();
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/sessions/a%2Fb/delegates?runId=r%201');
  });

  it('后台子（结果已回但 state=running）⇒ 照样触发轮询', async () => {
    setup({
      cards: [delegateCard({
        ok: true,
        out: `✓ ${JSON.stringify({ ok: true, runId: 'sub-aaaa', state: 'running', action: 'dispatch' })} (0.1s)`,
      })],
    });
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('轮询四条纪律', () => {
  it('纪律 1：上一发挂住 ⇒ 到点也不并发第二发；落定后恢复按拍', async () => {
    let release: (value: unknown) => void = () => {};
    fetchMock.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    setup({ cards: [delegateCard()] });
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await tick(DELEGATE_POLL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 挂住期间一次都没多发

    release(ok(rosterBody(rosterItem())));
    await tick(0);
    await tick(DELEGATE_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('纪律 2：hidden 期间零请求；恢复可见立刻补一发', async () => {
    setVisible('visible');
    queueResponses(ok(rosterBody(rosterItem())));
    const { handle } = setup({ cards: [delegateCard()] });
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    setVisible('hidden');
    await tick(DELEGATE_POLL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    setVisible('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('纪律 3：全部子终态且没有 pending 卡 ⇒ 停（之后再也不发）', async () => {
    queueResponses(
      ok(rosterBody(rosterItem({ state: 'running' }))),
      ok(rosterBody(rosterItem({ state: 'completed' }))),
    );
    const { handle } = setup({
      cards: [delegateCard({
        ok: true,
        resultPreview: JSON.stringify({ ok: true, runId: 'sub-aaaa', state: 'running', action: 'dispatch' }),
      })],
    });
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await tick(DELEGATE_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(handle.shouldPoll.value).toBe(false);

    await tick(DELEGATE_POLL_MS * 5);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 终态 ⇒ 一条都不多发
  });

  it('纪律 3 的另一半：子全终态但还有 pending 卡 ⇒ 不许停（那个卡随时还会再生子）', async () => {
    queueResponses(ok(rosterBody(rosterItem({ state: 'completed' }))));
    const { handle } = setup({ cards: [delegateCard()] }); // ok:null 的卡
    await tick(0);
    await tick(DELEGATE_POLL_MS);
    expect(handle.shouldPoll.value).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('`activeRunId` 变 null（run 结束）⇒ 当场停，且上一个 run 的行不残留', async () => {
    queueResponses(ok(rosterBody(rosterItem())));
    const { activeRunId, handle } = setup({ cards: [delegateCard()] });
    await tick(0);
    expect(handle.items.value).toHaveLength(1);

    activeRunId.value = null;
    await nextTick();
    const at = fetchMock.mock.calls.length;
    await tick(DELEGATE_POLL_MS * 4);
    expect(fetchMock.mock.calls.length).toBe(at);
    expect(handle.items.value).toEqual([]);
    expect(handle.hasLive.value).toBe(false);
  });

  it('纪律 4：作用域销毁 ⇒ 清 timer + abort 在途，abort 之后的 reject 不当故障', async () => {
    let rejectRequest: (e: unknown) => void = () => {};
    fetchMock.mockImplementation(
      (_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        rejectRequest = reject;
      }),
    );
    const { scope, handle } = setup({ cards: [delegateCard()] });
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    scope.stop();
    rejectRequest(new Error('should never surface as a fault'));
    await tick(DELEGATE_POLL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handle.error.value).toBe(false);
    expect(handle.hasRows.value).toBe(false);
  });
});

describe('归一化与徽标计数', () => {
  it('判据 5：徽标数 = 活态子数（终态子不计数，脏 state 走中性灰但不计数）', async () => {
    queueResponses(ok(rosterBody(
      rosterItem({ childRunId: 'sub-a1', state: 'running' }),
      rosterItem({ childRunId: 'sub-a2', state: 'queued' }),
      rosterItem({ childRunId: 'sub-a3', state: 'completed' }),
      rosterItem({ childRunId: 'sub-a4', state: 'failed' }),
      rosterItem({ childRunId: 'sub-a5', state: 42 }),
    )));
    const { handle } = setup({ cards: [delegateCard()] });
    await tick(0);
    expect(handle.items.value).toHaveLength(5);
    expect(handle.liveCount.value).toBe(2);
    expect(handle.hasLive.value).toBe(true);
  });

  it('脏响应不 throw：items 不是数组 / 记录不是对象 / childRunId 缺席 ⇒ 只丢那一行', () => {
    expect(normalizeDelegateItems(null)).toEqual([]);
    expect(normalizeDelegateItems({ items: 'nope' })).toEqual([]);
    expect(normalizeDelegateItems({ items: [null, 'x', 7] })).toEqual([]);
    expect(normalizeDelegateItems({ items: [{ state: 'running' }] })).toEqual([]); // 没有身份 ⇒ 丢
    const rows = normalizeDelegateItems({ items: [{ childRunId: 'c1', createdAt: 'nope', state: 42 }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ childRunId: 'c1', state: '', createdAt: null, cwd: null, hasTranscript: false });
  });

  it('已跑时长用 createdAt + 客户端时钟；createdAt 缺席 ⇒ null（不画 0s 假时长）', async () => {
    vi.setSystemTime(1_700_000_042_000);
    queueResponses(ok(rosterBody(
      rosterItem({ childRunId: 'sub-a1', createdAt: 1_700_000_000_000 }),
      rosterItem({ childRunId: 'sub-a2', createdAt: null }),
    )));
    const { handle } = setup({ cards: [delegateCard()] });
    await tick(0);
    expect(handle.elapsedMs(handle.items.value[0])).toBe(42_000);
    expect(handle.elapsedMs(handle.items.value[1])).toBeNull();

    await tick(5_000); // 1s 时钟继续走
    expect(handle.elapsedMs(handle.items.value[0])).toBe(47_000);
  });
});

describe('失败语义（判据 16：静默保留，不渲染红条）', () => {
  it('一发 500 ⇒ 保留上次的行、不置 error（面板连灰字都不出）', async () => {    queueResponses(ok(rosterBody(rosterItem())), fail(500));
    const { handle } = setup({ cards: [delegateCard()] });
    await tick(0);
    expect(handle.items.value).toHaveLength(1);

    await tick(DELEGATE_POLL_MS);
    expect(handle.items.value).toHaveLength(1); // 数据没被清空
    expect(handle.error.value).toBe(false);
  });

  it(`连续 ${DELEGATE_ACTIVITY_FAIL_THRESHOLD} 次失败 ⇒ 才置中性 error；中途一次成功就清零`, async () => {
    queueResponses(fail(500));
    const { handle } = setup({ cards: [delegateCard()] });
    for (let i = 1; i < DELEGATE_ACTIVITY_FAIL_THRESHOLD; i += 1) {
      await tick(i === 1 ? 0 : DELEGATE_POLL_MS);
      expect(handle.error.value, `第 ${i} 次失败`).toBe(false);
    }
    await tick(DELEGATE_POLL_MS);
    expect(handle.error.value).toBe(true);
    expect(handle.hasRows.value).toBe(true); // 「暂不可读」那一行要挂得住

    queueResponses(ok(rosterBody(rosterItem())));
    await tick(DELEGATE_POLL_MS);
    expect(handle.error.value).toBe(false);
    expect(handle.items.value).toHaveLength(1);
  });

  it('degraded（必修 1）：一次都没拉到 ⇒ degraded=true；拉到过之后的失败只 error、**不** degraded', async () => {
    // 「读不到」与「没有」必须分家：徒标的可见性靠 degraded，只看 `liveCount` 会把首次就失败的
    // 情形说成「没有子任务」（那句「暂不可读」就永远不可达）。
    queueResponses(fail(500));
    const { handle } = setup({ cards: [delegateCard()] });
    for (let i = 0; i < DELEGATE_ACTIVITY_FAIL_THRESHOLD; i += 1) {
      await tick(i === 0 ? 0 : DELEGATE_POLL_MS);
    }
    expect(handle.error.value).toBe(true);
    expect(handle.loaded.value).toBe(false);
    expect(handle.degraded.value).toBe(true);

    // 一旦拉到过，就退回「保留上次数据 + 一行灰字」，徒标不再进降级态。
    queueResponses(ok(rosterBody(rosterItem())));
    await tick(DELEGATE_POLL_MS);
    expect(handle.loaded.value).toBe(true);
    expect(handle.degraded.value).toBe(false);

    queueResponses(fail(500));
    for (let i = 0; i < DELEGATE_ACTIVITY_FAIL_THRESHOLD; i += 1) {
      await tick(DELEGATE_POLL_MS);
    }
    expect(handle.error.value).toBe(true);
    expect(handle.degraded.value).toBe(false);
    expect(handle.items.value).toHaveLength(1); // 上次数据仍在
  });

  it('URL 构造器对两个 id 都编码（端点路径段不许裸拼）', () => {
    expect(delegateRosterUrl('s/1', 'r 2')).toBe('/api/sessions/s%2F1/delegates?runId=r%202');
  });
});
