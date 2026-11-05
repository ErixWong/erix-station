// #450 A2：`stores/site.ts` 的单测（契约见 docs/api/portal.md §2.12）。
//
// 只钉 store 那一层：单飞、失败 fail-open + 30s 冷却、30s 后重试、缺字段视为不可用。
// 「守卫真的用它」在 `router.spec.ts` 钉；「判据算得对」在 `lib/hostGate.spec.ts` 钉。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { SITE_FAILURE_TTL_MS, SITE_PATH, parseSiteInfo, useSiteStore } from './site';

const SITE = {
  userBaseUrl: 'http://station.fde.erix.vip:8090',
  adminBaseUrl: 'https://admin.fde.erix.vip:9443',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 记录每次请求的 URL；`handler` 决定回什么。 */
function stubFetch(handler: (url: string) => Response | Promise<Response>): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    return handler(url);
  }));
  return urls;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('#450 A2 site store：单飞', () => {
  it('并发两次 ensureSite() 只发一次请求（router 的重定向链一次导航会进来好几趟）', async () => {
    const urls = stubFetch(() => jsonResponse(200, SITE));
    const site = useSiteStore();
    const [a, b] = await Promise.all([site.ensureSite(), site.ensureSite()]);
    expect(urls).toEqual([SITE_PATH]);
    expect(a).toEqual(SITE);
    expect(b).toEqual(SITE);
    // 拿到之后再不重复请求（后续每次导航都调它）。
    await site.ensureSite();
    expect(urls).toEqual([SITE_PATH]);
  });

  it('并发 5 次（跨 await 边界）也只发一次', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const urls = stubFetch(async () => {
      await gate;
      return jsonResponse(200, SITE);
    });
    const site = useSiteStore();
    const all = Array.from({ length: 5 }, () => site.ensureSite());
    release();
    const results = await Promise.all(all);
    expect(urls).toEqual([SITE_PATH]);
    expect(results.every((r) => r?.adminBaseUrl === SITE.adminBaseUrl)).toBe(true);
  });
});

describe('#450 A2 site store：失败 fail-open + 30s 冷却', () => {
  it('网络层失败 ⇒ 返回 null（不抛）+ unavailable；30s 内再调不重打', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T00:00:00Z'));
    const urls = stubFetch(() => { throw new TypeError('fetch failed'); });
    const site = useSiteStore();

    await expect(site.ensureSite()).resolves.toBeNull();
    expect(site.unavailable).toBe(true);
    expect(site.info).toBeNull();

    // 冷却窗口内：多次导航一律零请求。
    await site.ensureSite();
    await site.ensureSite();
    expect(urls).toEqual([SITE_PATH]);

    // 差 1ms 到点：仍然不重打。
    vi.setSystemTime(new Date(Date.now() + SITE_FAILURE_TTL_MS - 1));
    await site.ensureSite();
    expect(urls).toEqual([SITE_PATH]);
  });

  it('30s 之后重试（网络恢复即自愈）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T00:00:00Z'));
    let fail = true;
    const urls = stubFetch(() => (fail ? jsonResponse(503, { error: { code: 'unavailable', message: 'x' } }) : jsonResponse(200, SITE)));
    const site = useSiteStore();

    expect(await site.ensureSite()).toBeNull();
    expect(urls).toHaveLength(1);

    fail = false;
    vi.setSystemTime(new Date(Date.now() + SITE_FAILURE_TTL_MS));
    expect(await site.ensureSite()).toEqual(SITE);
    expect(urls).toHaveLength(2);
    expect(site.unavailable).toBe(false);
    expect(site.failedAt).toBe(0);
  });

  it('5xx / 401 / 403 一律 fail-open（不把导航变成失败）', async () => {
    for (const status of [500, 502, 401, 403, 404]) {
      setActivePinia(createPinia());
      stubFetch(() => jsonResponse(status, { error: { code: 'x', message: 'y' } }));
      const site = useSiteStore();
      await expect(site.ensureSite()).resolves.toBeNull();
      expect(site.unavailable).toBe(true);
    }
  });
});

describe('#450 A2 site store：缺字段 / 脏值 ⇒ 不可用（不许拼出 `undefined#/x`）', () => {
  it('响应少一个键 ⇒ 视为不可用', async () => {
    for (const body of [
      {},
      { userBaseUrl: SITE.userBaseUrl },
      { adminBaseUrl: SITE.adminBaseUrl },
      { userBaseUrl: SITE.userBaseUrl, adminBaseUrl: '' },
      { userBaseUrl: SITE.userBaseUrl, adminBaseUrl: 'not-a-url' },
      { userBaseUrl: SITE.userBaseUrl, adminBaseUrl: 123 },
      { userBaseUrl: SITE.userBaseUrl, adminBaseUrl: 'ftp://admin.fde.erix.vip' },
      null,
      'oops',
    ]) {
      setActivePinia(createPinia());
      stubFetch(() => jsonResponse(200, body));
      const site = useSiteStore();
      expect(await site.ensureSite()).toBeNull();
      expect(site.unavailable).toBe(true);
      expect(site.info).toBeNull();
    }
  });

  it('parseSiteInfo 是纯函数：形状对才返回，且值 trim 过', () => {
    expect(parseSiteInfo(SITE)).toEqual(SITE);
    expect(parseSiteInfo({ userBaseUrl: ` ${SITE.userBaseUrl} `, adminBaseUrl: SITE.adminBaseUrl }))
      .toEqual(SITE);
    expect(parseSiteInfo({ ...SITE, extra: 'ignored' })).toEqual(SITE);
    expect(parseSiteInfo(undefined)).toBeNull();
    expect(parseSiteInfo({ userBaseUrl: 'javascript:alert(1)', adminBaseUrl: SITE.adminBaseUrl })).toBeNull();
  });
});

describe('#450 A2 site store：状态机边界', () => {
  it('拿到之后失败不会把已有的两个 URL 抹掉（缓存值优先，导航不必重打）', async () => {
    let fail = false;
    stubFetch(() => (fail ? jsonResponse(500, {}) : jsonResponse(200, SITE)));
    const site = useSiteStore();
    expect(await site.ensureSite()).toEqual(SITE);
    fail = true;
    // 已经有值 ⇒ ensureSite 直接返回缓存，不再发请求（所以这里不会走到失败分支）。
    expect(await site.ensureSite()).toEqual(SITE);
    expect(site.info).toEqual(SITE);
  });

  it('reset() 清干净（测试/换页会话用）', async () => {
    const urls = stubFetch(() => jsonResponse(200, SITE));
    const site = useSiteStore();
    await site.ensureSite();
    site.reset();
    expect(site.info).toBeNull();
    expect(site.unavailable).toBe(false);
    expect(site.inflight).toBeNull();
    await site.ensureSite();
    expect(urls).toEqual([SITE_PATH, SITE_PATH]);
  });
});
