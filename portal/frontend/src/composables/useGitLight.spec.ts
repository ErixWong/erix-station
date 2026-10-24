// 收工灯数据层单测（issue #359 P0b）。形状照 `usePreviewPorts.spec.ts`：`effectScope()` + fetch 桩，
// 不引 pinia（本 composable 不依赖 store，cwd 由调用方以 getter 注入）。
// 承重项：没选目录零请求、切目录不得让旧结论串台、失败保留旧结论、脏载荷当"没检查"、30s 轮询与
// 页面隐藏不轮询、卸载清定时器并作废在途。
import { afterEach, beforeEach, describe, expect, it, vi, onTestFinished } from 'vitest';
import { effectScope, nextTick } from 'vue';
import { useGitLight } from './useGitLight';
import type { GitLightPayload } from '../lib/gitLight';

function payloadOf(cwd: string, over: Partial<GitLightPayload> = {}): GitLightPayload {
  return {
    light: 'green', reason: 'synced', primary: null, cwd, repos: [],
    counts: { red: 0, yellow: 0, grey: 0, green: 1 }, partial: false, git_available: true,
    truncated_repos: 0, checked_at: '2026-10-24T08:00:00.000Z', ...over,
  } as GitLightPayload;
}

const fetchMock = vi.fn();
const urls: string[] = [];

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function fail(status: number, code: string) {
  // api() 会读 `Retry-After` 头（#255）⇒ 桩必须带 headers，否则 api() 自己在 headers.get 上抛 TypeError，
  // 测试就会把"网络错误"当成服务端 500 来验，验的是个假形状。
  return {
    ok: false, status,
    headers: { get: () => null },
    json: async () => ({ error: { message: 'boom', code } }),
  };
}

beforeEach(() => {
  urls.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return ok(payloadOf('~/projects/p1'));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** 在一个 effectScope 里挂 composable（卸载时才会走 onScopeDispose，与组件生命周期等价）。 */
function withComposable(cwd: () => string | null | undefined) {
  const scope = effectScope();
  const api = scope.run(() => useGitLight({ cwd }))!;
  // 不自动 stop 就会漏：composable 的 30s setInterval 活到后面的用例里，一开 fake timers
  // 全部一起响（"7 次请求"这种假象就是这么来的）。
  onTestFinished(() => scope.stop());
  return { scope, ...api };
}

describe('取数', () => {
  it('没选目录 ⇒ 一个请求都不发（顶栏也不该出现灯，视图侧另有 v-if）', async () => {
    const { payload, load } = withComposable(() => null);
    await load();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(payload.value).toBeNull();
  });

  it('有目录 ⇒ GET /api/git-light?cwd=<编码后>，结论落 payload', async () => {
    const { payload, loaded, load } = withComposable(() => '~/projects/我 的目录');
    await load();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe('/api/git-light?cwd=' + encodeURIComponent('~/projects/我 的目录'));
    expect(payload.value?.light).toBe('green');
    expect(loaded.value).toBe(true);
  });

  it('服务端 500 ⇒ error 带状态与码，**旧结论保留**（灯不许一闪变成"没检查"）', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    fetchMock.mockImplementation(async () => (mode === 'ok' ? ok(payloadOf('~/projects/p1')) : fail(500, 'git_unavailable')));
    const { payload, error, load } = withComposable(() => '~/projects/p1');
    await load();
    expect(payload.value?.light).toBe('green');
    mode = 'fail';
    await load();
    expect(error.value).toEqual({ status: 500, code: 'git_unavailable', message: 'boom' });
    expect(payload.value?.light).toBe('green');
  });

  it('载荷形状不认识 ⇒ 当"没检查"（payload 清空 + bad_payload），**不拿不认识的东西显绿**', async () => {
    fetchMock.mockImplementation(async () => ok({ light: 'green' /* repos 缺失 */ }));
    const { payload, error, loaded, load } = withComposable(() => '~/projects/p1');
    await load();
    expect(payload.value).toBeNull();
    expect(loaded.value).toBe(false);
    expect(error.value?.code).toBe('bad_payload');
  });

  it('切目录后旧目录的迟到响应不得覆盖新结论（reqSeq 守卫）', async () => {
    let current = '~/projects/p1';
    let resolveFirst: ((v: unknown) => void) | undefined;
    fetchMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; })) // p1 慢
      .mockImplementationOnce(async () => ok(payloadOf('~/projects/p2', { light: 'red', reason: 'untracked' }))); // p2 快
    const { payload, load } = withComposable(() => current);
    void load(); // p1 在途
    await nextTick();
    current = '~/projects/p2';
    await load(); // p2 已回
    expect(payload.value?.light).toBe('red');
    resolveFirst?.(ok(payloadOf('~/projects/p1', { light: 'green', reason: 'synced' })));
    await nextTick();
    await nextTick();
    expect(payload.value?.light).toBe('red'); // p1 的绿迟到了也不许顶掉 p2 的红
  });

  it('reset() 立刻作废在途并清空结论（切目录第一步）', async () => {
    let resolveFirst: ((v: unknown) => void) | undefined;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    const { payload, reset, load } = withComposable(() => '~/projects/p1');
    void load();
    await nextTick();
    reset();
    expect(payload.value).toBeNull();
    resolveFirst?.(ok(payloadOf('~/projects/p1')));
    await nextTick();
    await nextTick();
    expect(payload.value).toBeNull();
  });
});

describe('自动保鲜（30s 轮询 + 回前台即刷；页面隐藏不刷）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  function setVisible(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  }

  it('可见时每 30s 打一次；隐藏期间一次都不打', async () => {
    setVisible('visible');
    const { load } = withComposable(() => '~/projects/p1');
    await load();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    await nextTick();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    setVisible('hidden');
    vi.advanceTimersByTime(90_000);
    await nextTick();
    expect(fetchMock).toHaveBeenCalledTimes(2); // 睡眠标签不给服务端攒请求
  });

  it('回到前台（visibilitychange → visible）立刻刷一次', async () => {
    setVisible('visible');
    withComposable(() => '~/projects/p1');
    await vi.advanceTimersByTimeAsync(0);
    const before = fetchMock.mock.calls.length;
    setVisible('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fetchMock.mock.calls.length).toBe(before); // 隐藏时不刷
    setVisible('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await nextTick();
    expect(fetchMock.mock.calls.length).toBe(before + 1);
  });

  it('卸载：定时器清掉、在途响应作废（scope.stop 之后不再改状态）', async () => {
    const { scope, payload, load } = withComposable(() => '~/projects/p1');
    await load();
    const n = fetchMock.mock.calls.length;
    scope.stop();
    vi.advanceTimersByTime(120_000);
    await nextTick();
    expect(fetchMock.mock.calls.length).toBe(n); // 定时器不再发
    await load(); // 卸载后手动调用仍会发请求，但结果不得再写回 payload
    const late = payload.value;
    await nextTick();
    expect(payload.value).toBe(late);
  });
});
