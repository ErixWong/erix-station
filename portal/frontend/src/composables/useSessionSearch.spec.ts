// useSessionSearch 单测（issue #94）：防抖 / 竞态（请求序号 + AbortController）/ 游标重置 / 三态。
// fetch 全局桩掉；effectScope 包裹以驱动 onScopeDispose。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type Ref } from 'vue';
import { useSessionSearch, type PickerSession } from './useSessionSearch';

interface Ctx {
  scope: Ref<'cwd' | 'all'>;
  cwd: Ref<string | null>;
  search: ReturnType<typeof useSessionSearch>;
  stop: () => void;
}

function mountSearch(opts: { scope?: 'cwd' | 'all'; cwd?: string | null; debounceMs?: number } = {}): Ctx {
  const scope = ref(opts.scope ?? 'cwd');
  const cwd = ref(opts.cwd ?? '~/projects/demo');
  const s = effectScope();
  let search!: ReturnType<typeof useSessionSearch>;
  s.run(() => {
    search = useSessionSearch({ scope, cwd, debounceMs: opts.debounceMs ?? 300 });
  });
  return { scope, cwd, search, stop: () => s.stop() };
}

function okBody(items: PickerSession[], extra: Record<string, unknown> = {}) {
  return { items, next_cursor: null, total: items.length, ...extra };
}

const resp = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** 受控 fetch：每次调用返回的 promise 由调用方决定 resolve 时机（竞态测试用）。 */
function controlledFetch() {
  const calls: Array<{ url: string; signal?: AbortSignal; deferred: { resolve: (r: Response) => void; reject: (e: unknown) => void } }> = [];
  const mock = vi.fn((url: string, init?: RequestInit) => {
    let resolve!: (r: Response) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<Response>((res, rej) => { resolve = res; reject = rej; });
    calls.push({ url: String(url), signal: init?.signal ?? undefined, deferred: { resolve, reject } });
    return promise;
  });
  vi.stubGlobal('fetch', mock);
  return calls;
}

async function settle() {
  await nextTick();
  for (let i = 0; i < 20; i++) await Promise.resolve(); // Response.json() 链式微任务冲刷
}

/** 取第 i 次 fetch 的请求 URL（解析后断言，避开 ~ / 空格的编码差异）。 */
function urlOf(mock: ReturnType<typeof vi.fn>, i: number): URL {
  return new URL(String(mock.mock.calls[i][0]), 'http://x');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useSessionSearch（issue #94）', () => {
  it('首屏立即加载（不等防抖）：URL 带 limit/total/cwd，无 q/cursor', async () => {
    const fetchMock = vi.fn(async () => resp(okBody([{ id: 's1' }])));
    vi.stubGlobal('fetch', fetchMock);
    const { search, stop } = mountSearch();
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = urlOf(fetchMock, 0);
    expect(url.pathname).toBe('/api/sessions');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('total')).toBe('1');
    expect(url.searchParams.get('cwd')).toBe('~/projects/demo');
    expect(url.searchParams.get('q')).toBeNull();
    expect(url.searchParams.get('cursor')).toBeNull();
    expect(search.items.value.map((s) => s.id)).toEqual(['s1']);
    expect(search.total.value).toBe(1);
    expect(search.loading.value).toBe(false);
    stop();
  });

  it('输入防抖 300ms：期间不请求，防抖窗口后带 q 请求一次', async () => {
    const fetchMock = vi.fn(async () => resp(okBody([])));
    vi.stubGlobal('fetch', fetchMock);
    const { search, stop } = mountSearch();
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    search.query.value = '部 署';
    await settle();
    await vi.advanceTimersByTimeAsync(299);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 防抖窗口内不请求
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(fetchMock, 1).searchParams.get('q')).toBe('部 署');
    stop();
  });

  it('竞态防护：条件变更后旧请求的迟到响应被忽略（请求序号 + AbortController）', async () => {
    const calls = controlledFetch();
    const { search, stop } = mountSearch();
    await vi.runAllTimersAsync(); // 首屏请求挂起（calls[0]）
    search.query.value = '新条件';
    await settle();
    await vi.advanceTimersByTimeAsync(300); // 第二个请求发出（calls[1]）
    expect(calls).toHaveLength(2);
    // 条件变更即作废在途请求
    expect(calls[0].signal?.aborted).toBe(true);
    expect(calls[1].signal?.aborted).toBe(false);
    // 先 resolve 新请求，再 resolve 旧请求：旧响应不得覆盖新列表
    calls[1].deferred.resolve(resp(okBody([{ id: 'new' }])));
    await settle();
    calls[0].deferred.resolve(resp(okBody([{ id: 'stale' }])));
    await settle();
    expect(search.items.value.map((s) => s.id)).toEqual(['new']);
    stop();
  });

  it('条件变更清空列表并重置游标：下一请求不带 cursor', async () => {
    const bodies = [
      okBody([{ id: 'p1' }], { next_cursor: 'CUR1' }),
      okBody([{ id: 'p2' }]),
    ];
    const fetchMock = vi.fn(async (url: string) => resp(bodies[fetchMock.mock.calls.length - 1] ?? okBody([])));
    vi.stubGlobal('fetch', fetchMock);
    const { scope, search, stop } = mountSearch();
    await vi.runAllTimersAsync();
    expect(search.nextCursor.value).toBe('CUR1');
    search.loadMore(); // 携带 CUR1 翻页
    await settle();
    expect(urlOf(fetchMock, 1).searchParams.get('cursor')).toBe('CUR1');
    expect(search.items.value.map((s) => s.id)).toEqual(['p1', 'p2']);
    scope.value = 'all'; // 条件变更
    await settle();
    expect(search.items.value).toEqual([]); // 列表清空
    expect(search.nextCursor.value).toBeNull(); // 游标重置
    await vi.advanceTimersByTimeAsync(300);
    const url = urlOf(fetchMock, 2);
    expect(url.searchParams.get('cursor')).toBeNull();
    expect(url.searchParams.get('cwd')).toBeNull();
    stop();
  });

  it('三态·失败：追加失败保留旧列表与游标，retry 按原游标重放', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('cursor=')) throw new Error('网络错误');
      return resp(okBody([{ id: 'a' }, { id: 'b' }], { next_cursor: 'CUR9' }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { search, stop } = mountSearch();
    await vi.runAllTimersAsync();
    expect(search.items.value).toHaveLength(2);
    search.loadMore();
    await settle();
    expect(search.error.value).toBe('网络错误');
    expect(search.items.value.map((s) => s.id)).toEqual(['a', 'b']); // 失败保留旧列表
    expect(search.nextCursor.value).toBe('CUR9'); // 失败游标不动
    expect(search.loadingMore.value).toBe(false);
    // 修复 fetch 后重试：按 CUR9 原样重放且追加成功
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('cursor=')
        ? resp(okBody([{ id: 'c' }]))
        : resp(okBody([{ id: 'a' }, { id: 'b' }], { next_cursor: 'CUR9' })));
    search.retry();
    await settle();
    expect(search.error.value).toBeNull();
    expect(search.items.value.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    stop();
  });

  it('三态·无结果：empty 为真（非加载、非失败、空列表）', async () => {
    const fetchMock = vi.fn(async () => resp(okBody([])));
    vi.stubGlobal('fetch', fetchMock);
    const { search, stop } = mountSearch();
    vi.advanceTimersByTime(0); // 首屏请求已发出（同步执行 timer 回调）
    expect(search.loading.value).toBe(true); // 加载中
    await settle();
    expect(search.loading.value).toBe(false);
    expect(search.empty.value).toBe(true);
    expect(search.error.value).toBeNull();
    stop();
  });

  it('hasMore 随 next_cursor 就绪；loadMore 加载中防重入', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      resp(okBody([{ id: 'x' }], { next_cursor: String(url).includes('cursor=') ? null : 'CUR' })));
    vi.stubGlobal('fetch', fetchMock);
    const { search, stop } = mountSearch();
    await vi.runAllTimersAsync();
    expect(search.hasMore.value).toBe(true);
    search.loadMore();
    search.loadMore(); // 第二调用在 loadingMore 中 → 不重复请求
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(search.hasMore.value).toBe(false);
    stop();
  });

  it('组件卸载：在途请求被 abort（onScopeDispose 清理）', async () => {
    const calls = controlledFetch();
    const { stop } = mountSearch();
    await vi.runAllTimersAsync();
    expect(calls).toHaveLength(1);
    stop();
    expect(calls[0].signal?.aborted).toBe(true);
  });
});
