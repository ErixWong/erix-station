// useSessionBrowser 单测（issue #94，评审裁决瘦身版）：单次全量拉取 / 请求序号防竞态 / 三态。
// fetch 全局桩掉；effectScope 包裹以驱动 onScopeDispose。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type Ref } from 'vue';
import { useSessionBrowser, type PickerSession } from './useSessionBrowser';

interface Ctx {
  scope: Ref<'cwd' | 'all'>;
  cwd: Ref<string | null>;
  browser: ReturnType<typeof useSessionBrowser>;
  stop: () => void;
}

function mountBrowser(opts: { scope?: 'cwd' | 'all'; cwd?: string | null } = {}): Ctx {
  const scope = ref(opts.scope ?? 'cwd');
  const cwd = ref(opts.cwd ?? '~/projects/demo');
  const s = effectScope();
  let browser!: ReturnType<typeof useSessionBrowser>;
  s.run(() => {
    browser = useSessionBrowser({ scope, cwd });
  });
  return { scope, cwd, browser, stop: () => s.stop() };
}

const resp = (items: PickerSession[]) =>
  new Response(JSON.stringify({ items, next_cursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** 受控 fetch：每次调用返回的 promise 由调用方决定 resolve 时机（竞态测试用）。 */
function controlledFetch() {
  const calls: Array<{ url: string; deferred: { resolve: (r: Response) => void; reject: (e: unknown) => void } }> = [];
  const mock = vi.fn((url: string) => {
    let resolve!: (r: Response) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<Response>((res, rej) => { resolve = res; reject = rej; });
    calls.push({ url: String(url), deferred: { resolve, reject } });
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSessionBrowser（issue #94 评审裁决瘦身版）', () => {
  it('首屏立即加载：单次全量（limit=100 后端上限），带 cwd、无 cursor', async () => {
    const fetchMock = vi.fn(async () => resp([{ id: 's1' }]));
    vi.stubGlobal('fetch', fetchMock);
    const { browser, stop } = mountBrowser();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = urlOf(fetchMock, 0);
    expect(url.pathname).toBe('/api/sessions');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('cwd')).toBe('~/projects/demo');
    expect(url.searchParams.get('cursor')).toBeNull();
    expect(browser.items.value.map((s) => s.id)).toEqual(['s1']);
    expect(browser.loading.value).toBe(false);
    stop();
  });

  it('竞态防护：条件变更后旧请求的迟到响应被忽略（请求序号）', async () => {
    const calls = controlledFetch();
    const { scope, browser, stop } = mountBrowser();
    await settle(); // 首屏请求挂起（calls[0]）
    scope.value = 'all'; // 条件变更立即重拉
    await settle(); // 第二个请求发出（calls[1]）
    expect(calls).toHaveLength(2);
    // 先 resolve 新请求，再 resolve 旧请求：旧响应不得覆盖新列表
    calls[1].deferred.resolve(resp([{ id: 'new' }]));
    await settle();
    calls[0].deferred.resolve(resp([{ id: 'stale' }]));
    await settle();
    expect(browser.items.value.map((s) => s.id)).toEqual(['new']);
    stop();
  });

  it('条件变更：下一请求按新条件重拉全量（不带 cwd），列表替换为新结果', async () => {
    const bodies: PickerSession[][] = [[{ id: 'p1' }], [{ id: 'p2' }, { id: 'p3' }]];
    const fetchMock = vi.fn(async () => resp(bodies[fetchMock.mock.calls.length - 1] ?? []));
    vi.stubGlobal('fetch', fetchMock);
    const { scope, browser, stop } = mountBrowser();
    await settle();
    expect(browser.items.value.map((s) => s.id)).toEqual(['p1']);
    scope.value = 'all';
    await settle();
    expect(browser.items.value.map((s) => s.id)).toEqual(['p2', 'p3']); // 列表替换
    const url = urlOf(fetchMock, 1);
    expect(url.searchParams.get('cwd')).toBeNull();
    expect(url.searchParams.get('limit')).toBe('100');
    stop();
  });

  it('三态·失败：保留旧列表，retry 重新拉全量成功', async () => {
    let fail = true;
    const fetchMock = vi.fn(async () => {
      if (fail) throw new Error('网络错误');
      return resp([{ id: 'a' }, { id: 'b' }]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { browser, stop } = mountBrowser();
    await settle();
    expect(browser.error.value).toBe('网络错误');
    expect(browser.items.value).toEqual([]); // 首屏失败：旧列表为空
    expect(browser.loading.value).toBe(false);
    fail = false;
    browser.retry();
    expect(browser.loading.value).toBe(true);
    await settle();
    expect(browser.error.value).toBeNull();
    expect(browser.items.value.map((s) => s.id)).toEqual(['a', 'b']);
    stop();
  });

  it('三态·失败：非首屏失败保留旧列表', async () => {
    const bodies: PickerSession[][] = [[{ id: 'a' }]];
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length > 1) throw new Error('网络错误');
      return resp(bodies[fetchMock.mock.calls.length - 1]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { scope, browser, stop } = mountBrowser();
    await settle();
    expect(browser.items.value.map((s) => s.id)).toEqual(['a']);
    scope.value = 'all'; // 条件变更重拉 → 失败
    await settle();
    expect(browser.error.value).toBe('网络错误');
    expect(browser.items.value.map((s) => s.id)).toEqual(['a']); // 旧列表保留
    stop();
  });

  it('三态·无结果：empty 为真（非加载、非失败、空列表）', async () => {
    const fetchMock = vi.fn(async () => resp([]));
    vi.stubGlobal('fetch', fetchMock);
    const { browser, stop } = mountBrowser();
    expect(browser.loading.value).toBe(true); // 加载中
    await settle();
    expect(browser.loading.value).toBe(false);
    expect(browser.empty.value).toBe(true);
    expect(browser.error.value).toBeNull();
    stop();
  });

  it('组件卸载：reqSeq 推进，迟到响应不再写状态', async () => {
    const calls = controlledFetch();
    const { browser, stop } = mountBrowser();
    await settle();
    expect(calls).toHaveLength(1);
    stop();
    calls[0].deferred.resolve(resp([{ id: 'late' }]));
    await settle();
    expect(browser.items.value).toEqual([]); // 卸载后迟到响应被丢弃
  });
});
