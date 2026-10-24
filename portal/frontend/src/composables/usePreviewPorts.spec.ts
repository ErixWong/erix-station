// usePreviewPorts / requestBlockMove 单测（#246 交付② 单 B）——数据层三条判据：
//   ① 列表端点按「本人 / 代看某个 FDE」分派；
//   ② **ticket 不预取**：只调 load() 不得出现任何 preview-ticket 请求；只有 openPreview() 才签，
//      且签的是列表行的 allocation id、开的是 `<url>/?preview_ticket=<ticket>`；
//   ③ 改块请求体恒为 `{ block_start: <整数> }`，错误保留 code 与 details.field。
// 风格照 useSessionBrowser.spec.ts：effectScope 包裹 + 全局 fetch 桩。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { requestBlockMove, usePreviewPorts } from './usePreviewPorts';
import type { PreviewPortItem } from '../lib/previewPorts';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function portItem(id: string, port: number, overrides: Partial<PreviewPortItem> = {}): PreviewPortItem {
  return {
    id,
    port,
    hostname: `alice-p-${port}.fde.erix.vip`,
    url: `http://alice-p-${port}.fde.erix.vip:8090`,
    state: 'allocated',
    scope: 'fde',
    role: 'spare',
    exposure: 'private',
    ...overrides,
  };
}

const ITEMS = [portItem(UUID_A, 22000), portItem(UUID_B, 22001, { state: 'active' })];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** fetch 桩（带类型的 vi.fn：mock.calls 保留 [url, init] 元组，断言 init.method 不用 cast）。 */
function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn(handler);
  vi.stubGlobal('fetch', mock);
  return mock;
}

function settle() {
  return new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

interface FakeTab {
  location: { href: string };
  opener?: unknown;
  close: ReturnType<typeof vi.fn>;
}

function fakeTab(): FakeTab {
  return { location: { href: '' }, opener: {}, close: vi.fn() };
}

/** window.open 桩：返回可控的假标签（jsdom 真实现返回 null，会走「被拦截」分支）。 */
function stubOpen(tab: FakeTab | null) {
  const mock = vi.fn(() => tab);
  vi.stubGlobal('open', mock);
  return mock;
}

function mountPorts(fdeName: string | null = null) {
  const scope = effectScope();
  let ports!: ReturnType<typeof usePreviewPorts>;
  scope.run(() => {
    ports = usePreviewPorts({ fdeName: () => fdeName });
  });
  return { ports, stop: () => scope.stop() };
}

function callsTo(
  fetchMock: ReturnType<typeof stubFetch>,
  method: string,
  path: string,
) {
  return fetchMock.mock.calls.filter(
    ([url, init]) => String(url) === path && (init?.method ?? 'GET') === method,
  );
}

function postCalls(fetchMock: ReturnType<typeof stubFetch>) {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('usePreviewPorts：列表端点', () => {
  it('未指定 fdeName ⇒ GET /api/me/ports（本人）；给了 ⇒ GET /api/admin/fdes/:fde/ports（代看）', async () => {
    const fetchMock = stubFetch(async () => json(200, { items: ITEMS }));

    const self = mountPorts();
    await self.ports.load();
    expect(callsTo(fetchMock, 'GET', '/api/me/ports')).toHaveLength(1);
    expect(self.ports.items.value.map((item) => item.port)).toEqual([22000, 22001]);
    expect(self.ports.loaded.value).toBe(true);
    self.stop();

    const admin = mountPorts('bob-x');
    await admin.ports.load();
    expect(callsTo(fetchMock, 'GET', '/api/admin/fdes/bob-x/ports')).toHaveLength(1);
    admin.stop();
  });

  it('items 缺失/非数组时收成空列表并标记已加载（空态而不是空白）', async () => {
    stubFetch(async () => json(200, {}));
    const { ports, stop } = mountPorts();
    await ports.load();
    expect(ports.items.value).toEqual([]);
    expect(ports.loaded.value).toBe(true);
    expect(ports.listError.value).toBeNull();
    stop();
  });

  it('列表失败：错误码 + 服务端 message 原文都留着（旧列表不闪成空白）', async () => {
    stubFetch(async () => json(503, {
      error: { code: 'db_unavailable', message: '数据库暂时不可用' },
    }));
    const { ports, stop } = mountPorts();
    await ports.load();
    expect(ports.listError.value).toMatchObject({
      status: 503,
      code: 'db_unavailable',
      message: '数据库暂时不可用',
    });
    expect(ports.loaded.value).toBe(false);
    stop();
  });

  it('竞态：换目标的旧请求迟到响应不得覆盖新列表（请求序号守卫）', async () => {
    const deferred: Array<{ url: string; resolve: (r: Response) => void }> = [];
    stubFetch(async (url) => {
      const path = String(url);
      if (path === '/api/me/ports') {
        return new Promise<Response>((resolve) => { deferred.push({ url: path, resolve }); });
      }
      return json(200, { items: [portItem(UUID_B, 29990)] });
    });

    let fdeName: string | null = null;
    const scope = effectScope();
    let ports!: ReturnType<typeof usePreviewPorts>;
    scope.run(() => {
      ports = usePreviewPorts({ fdeName: () => fdeName });
    });
    const firstLoad = ports.load(); // 挂在旧目标（本人）上
    fdeName = 'bob-x';
    await ports.load(); // 新目标先落地
    deferred[0]!.resolve(json(200, { items: ITEMS })); // 旧请求迟到
    await firstLoad;
    await settle();

    expect(deferred.map((entry) => entry.url)).toEqual(['/api/me/ports']);
    expect(ports.items.value.map((item) => item.port)).toEqual([29990]);
    scope.stop();
  });
});

describe('usePreviewPorts.openPreview：点击当场签票 + 新标签打开', () => {
  it('只调 load() 不得签票（防预取：ticket 60 秒过期且一次性）', async () => {
    const fetchMock = stubFetch(async () => json(200, { items: ITEMS }));
    const open = stubOpen(fakeTab());

    const { ports, stop } = mountPorts();
    await ports.load();
    await settle();

    expect(callsTo(fetchMock, 'POST', `/api/ports/${UUID_A}/preview-ticket`)).toHaveLength(0);
    expect(callsTo(fetchMock, 'POST', `/api/ports/${UUID_B}/preview-ticket`)).toHaveLength(0);
    expect(postCalls(fetchMock)).toHaveLength(0);
    expect(open).not.toHaveBeenCalled();
    expect(ports.popupBlockedUrl.value).toBeNull();
    stop();
  });

  it('openPreview(行 B)：POST 该行的 allocation id（body {}），并把票地址填进新标签', async () => {
    const fetchMock = stubFetch(async (url) => {
      if (String(url) === `/api/ports/${UUID_B}/preview-ticket`) {
        return json(201, {
          ticket: 'pt_B',
          url: 'http://alice-p-22001.fde.erix.vip:8090/?preview_ticket=pt_B', // §2.8：后端已拼好
          expires_in: 60,
        });
      }
      return json(200, { items: ITEMS });
    });
    const tab = fakeTab();
    const open = stubOpen(tab);

    const { ports, stop } = mountPorts();
    await ports.load();
    const row = ports.items.value.find((item) => item.id === UUID_B)!;
    const outcome = await ports.openPreview(row);

    expect(outcome).toBe('opened');
    const post = callsTo(fetchMock, 'POST', `/api/ports/${UUID_B}/preview-ticket`);
    expect(post).toHaveLength(1);
    expect(String(post[0][1]?.body)).toBe('{}');
    // ticket 只出现一次（后端已拼 ⇒ 不重复拼），且没落到当前页 URL（只写新标签）
    expect(tab.location.href).toBe('http://alice-p-22001.fde.erix.vip:8090/?preview_ticket=pt_B');
    expect(tab.location.href.match(/preview_ticket=/g)).toHaveLength(1);
    expect(tab.opener).toBeNull(); // 预览页拿不到 portal 标签句柄
    expect(open).toHaveBeenCalledTimes(1);
    expect(ports.ticketBusyId.value).toBeNull();
    expect(ports.ticketError.value).toBeNull();
    stop();
  });

  it('后端给裸 url 时按工单形态补挂一张票（<url>/?preview_ticket=…）', async () => {
    stubFetch(async () => json(201, {
      ticket: 'pt_A', url: 'http://alice-p-22000.fde.erix.vip:8090', expires_in: 60,
    }));
    const tab = fakeTab();
    stubOpen(tab);

    const { ports, stop } = mountPorts();
    await ports.openPreview(portItem(UUID_A, 22000));
    expect(tab.location.href).toBe('http://alice-p-22000.fde.erix.vip:8090?preview_ticket=pt_A');
    stop();
  });

  it('签票失败（429 rate_limited）：收回空白标签 + 错误码与原文都留下', async () => {
    stubFetch(async () => json(429, {
      error: { code: 'rate_limited', message: '预览 ticket 签发过于频繁，请稍后再试' },
    }));
    const tab = fakeTab();
    stubOpen(tab);

    const { ports, stop } = mountPorts();
    const outcome = await ports.openPreview(portItem(UUID_A, 22000));
    expect(outcome).toBe('failed');
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe('');
    expect(ports.ticketError.value).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(ports.ticketError.value?.message).toContain('签发过于频繁');
    stop();
  });

  it('window.open 返回 null（弹窗被拦）⇒ 不报错，给带票的兜底链接', async () => {
    stubFetch(async () => json(201, {
      ticket: 'pt_A', url: 'http://alice-p-22000.fde.erix.vip:8090?preview_ticket=pt_A', expires_in: 60,
    }));
    stubOpen(null);

    const { ports, stop } = mountPorts();
    const outcome = await ports.openPreview(portItem(UUID_A, 22000));
    expect(outcome).toBe('blocked');
    expect(ports.ticketError.value).toBeNull();
    expect(ports.popupBlockedUrl.value).toBe('http://alice-p-22000.fde.erix.vip:8090?preview_ticket=pt_A');
    stop();
  });

  it('一次只签一张票：签票中重复点击直接返回 failed，不再签第二张', async () => {
    const deferred: Array<{ resolve: (r: Response) => void }> = [];
    const fetchMock = stubFetch(() => new Promise<Response>((resolve) => { deferred.push({ resolve }); }));
    stubOpen(fakeTab());

    const { ports, stop } = mountPorts();
    const first = ports.openPreview(portItem(UUID_A, 22000));
    const second = await ports.openPreview(portItem(UUID_B, 22001));
    expect(second).toBe('failed');
    deferred[0]!.resolve(json(201, { ticket: 'pt_A', url: 'http://h?preview_ticket=pt_A', expires_in: 60 }));
    expect(await first).toBe('opened');
    expect(postCalls(fetchMock)).toHaveLength(1);
    stop();
  });
});

describe('requestBlockMove（确认后由调用方发出）', () => {
  it('body 恒为 { block_start: <整数> }，成功返回 200 的搬迁计数', async () => {
    const fetchMock = stubFetch(async () => json(200, {
      changed: true,
      fde_name: 'alice',
      block_start: 22010,
      block_end: 22019,
      ports: [22010, 22011, 22012, 22013, 22014, 22015, 22016, 22017, 22018, 22019],
      released_allocations: 10,
      revoked_grants: 3,
      inserted_allocations: 10,
    }));

    const outcome = await requestBlockMove('alice', 22010);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.result.inserted_allocations).toBe(10);
    expect(outcome.result.revoked_grants).toBe(3);
    const post = callsTo(fetchMock, 'POST', '/api/admin/fdes/alice/ports/block')[0];
    expect(JSON.parse(String(post[1]?.body))).toEqual({ block_start: 22010 });
  });

  it('409 保留 code 与全文 message；400 保留 details.field', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls += 1;
      return calls === 1
        ? json(409, {
          error: {
            code: 'preview_port_block_taken',
            message: '预览端口块 22010–22019 已被占用（外来活行端口：22011,22012）',
            retryable: false,
          },
        })
        : json(400, {
          error: {
            code: 'validation_failed',
            message: 'block_start 必须是号池 22000–29999 内、按 10 对齐的整数块起点',
            details: { field: 'block_start' },
          },
        });
    });

    const taken = await requestBlockMove('alice', 22010);
    expect(taken.ok).toBe(false);
    if (taken.ok) throw new Error('unreachable');
    expect(taken.error.code).toBe('preview_port_block_taken');
    expect(taken.error.message).toContain('22011,22012');

    const invalid = await requestBlockMove('alice', 22005);
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error('unreachable');
    expect(invalid.error.code).toBe('validation_failed');
    expect(invalid.error.field).toBe('block_start');
  });
});

