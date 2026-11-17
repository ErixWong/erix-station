// issue #650 管理台「系统」面板（宿主资源快照）的前端单测。装配风格照 `AdminAboutView.spec.ts` /
// `PreviewPoolUsageView.spec.ts`：真实 i18n 单例 + App + createAppRouter(createMemoryHistory())
// + 按 URL 分派的 fetch 桩。⚠ **不用 `w.emitted()`**（本机 NODE_ENV=production 下恒空，历史上假红过）
// —— 全部走 DOM 文本与请求桩。
//
// 逐条对应工单 §检查点 B 的判据：
//   S-1 四张卡各显示自己的读数（CPU 带归一化 load 行 / 内存 used+total+available / 磁盘**每设备一行**
//       且 diskUnreadable 露面 / 容器 running-total + FDE + 对账行）
//   S-2 三态各自独立降级：`enabled:false` ⇒ 采样已关闭（附怎么开）；`latest:null` ⇒ 等待首拍；
//       `seriesError` ⇒ **只有图区**红，四张卡照常
//   S-3 所有「拿不到」渲染「未知」，页面上不许出现 0 / NaN / undefined / null 当值
//   S-4 范围切换：请求带 `?range=`，选中态跟**服务端回显的生效值**走（不是本地点了啥）
//   S-5 轮询 5s + `document.hidden` 暂停 + 回到前台立刻拉
//   S-6 首次加载中是骨架，不是 0
//   S-7 懒挂载：进管理台 0 次请求，点开「系统」才发
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, type Router } from 'vue-router';
import App from '../App.vue';
import { createAppRouter } from '../router';
import { nextRouteLanding } from '../test-utils/navigation';
import { i18n, setLocale } from '../i18n';
import { SYSTEM_METRICS_PATH } from '../lib/systemMetrics';

const t = i18n.global.t;

const ADMIN_USER = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local',
};

const GIB = 1024 ** 3;

/** 真库形状（工单里那份逐字段 JSON 的放大版：数值都有辨识度，脏值与缺值由变体自己造）。 */
const METRICS = {
  latest: {
    sampled_at: new Date(Date.now() - 30_000).toISOString(),
    cpu: { usagePct: 12.5, cores: 36, load: [5.26, 3.1, 2.4] },
    mem: {
      totalBytes: 128 * GIB, usedBytes: 40 * GIB, availableBytes: 84 * GIB,
      cachedBytes: 12 * GIB, swapUsedBytes: 2 * GIB, usedPct: 31.3,
    },
    // 两块物理盘（服务端已按设备去重）⇒ 页面必须出两行
    disk: [
      {
        device: '/dev/nvme0n1p2', path: '/', fs: 'ext4',
        totalBytes: 937 * GIB, usedBytes: 676 * GIB, availBytes: 214 * GIB, usedPct: 72.1,
      },
      {
        device: '/dev/sda1', path: '/srv/erix', fs: 'xfs',
        totalBytes: 4 * 1024 * GIB, usedBytes: 1 * 1024 * GIB, availBytes: 3 * 1024 * GIB, usedPct: 25,
      },
    ],
    diskUnreadable: [{ path: '/data', reason: 'ENOENT' }],
    containers: {
      total: 41, running: 33, paused: 2, stopped: 6, station: 12, fde: 7, fdeRunning: 6,
      drift: { db: 7, docker: 7, onlyDb: [], onlyDocker: [], count: 0 },
    },
  },
  series: {
    bucketSeconds: 30,
    points: [
      { t: new Date(Date.now() - 120_000).toISOString(), cpuAvg: 20, cpuMax: 40, memUsed: 30 * GIB, containersRunning: 30, samples: 2 },
      { t: new Date(Date.now() - 90_000).toISOString(), cpuAvg: 30, cpuMax: 55, memUsed: 36 * GIB, containersRunning: 32, samples: 2 },
      { t: new Date(Date.now() - 60_000).toISOString(), cpuAvg: 12.5, cpuMax: 33, memUsed: 40 * GIB, containersRunning: 33, samples: 1 },
    ],
  },
  range: '1h',
  retentionDays: 30,
  seriesError: null,
  enabled: true,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Handler = (url: string, init?: RequestInit) => Response | undefined | Promise<Response | undefined>;

function defaultHandler(url: string): Response | undefined {
  if (url === '/api/me') return jsonResponse(200, { user: ADMIN_USER });
  if (url === '/api/admin/users') return jsonResponse(200, { items: [] });
  if (url === '/api/admin/git-hosts') return jsonResponse(200, { items: [] });
  if (url === '/api/admin/llm/providers') return jsonResponse(200, { items: [] });
  return undefined;
}

/** 捕获 `setInterval` 的回调：轮询判据要能「手动拨一下」，而不是等真 5s 墙钟。 */
let tickCallback: (() => void) | null = null;
let tickPeriodMs = 0;
let intervalCleared = 0;

function stubTimer(): void {
  tickCallback = null;
  tickPeriodMs = 0;
  intervalCleared = 0;
  vi.stubGlobal('setInterval', (cb: () => void, ms: number) => {
    tickCallback = cb;
    tickPeriodMs = ms;
    return 9_999 as unknown as ReturnType<typeof setInterval>;
  });
  vi.stubGlobal('clearInterval', () => { intervalCleared += 1; });
}

/** `document.hidden` 在 jsdom 里是只读 getter，要用 defineProperty 换掉。 */
function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

async function mountAdmin(handler: Handler = () => undefined, path = '/admin/users') {
  const pinia = createPinia();
  setActivePinia(pinia);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return (await handler(url, init)) ?? defaultHandler(url)
      ?? jsonResponse(404, { error: { code: 'not_found', message: 'not found' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  stubTimer();
  setDocumentHidden(false);
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [pinia, router, i18n] }, attachTo: document.body });
  await flushPromises();
  return { wrapper, fetchMock, router };
}

function metricsCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith(SYSTEM_METRICS_PATH));
}

/** 点管理台 tab（零墙钟：先订阅 afterEach，再点，再 await 落地；见 #473 family B 的说明）。 */
async function openTab(router: Router, wrapper: VueWrapper, key: string) {
  const label = String(t(`admin.tabs.${key}`));
  const tab = wrapper.findAll('nav a').find((item) => item.text() === label);
  if (!tab) throw new Error(`管理台 tab「${label}」不存在`);
  const landed = nextRouteLanding(router);
  await tab.trigger('click');
  await landed;
  await flushPromises();
}

/** 点开「系统」tab，返回可直接断言的上下文（其余端点走 `defaultHandler`）。 */
async function openSystem(handler: Handler = () => undefined) {
  const ctx = await mountAdmin(handler);
  await openTab(ctx.router, ctx.wrapper, 'system');
  return ctx;
}

/** 只对**本端点**回 200 的桩（别的 URL 一律 `undefined` 让默认桩接，否则 `/api/me` 会被顶成系统读数）。 */
function withMetrics(payload: Partial<typeof METRICS> | ((url: string) => unknown) = {}): Handler {
  return (url) => (url.startsWith(SYSTEM_METRICS_PATH)
    ? jsonResponse(200, typeof payload === 'function' ? payload(url) : { ...METRICS, ...payload })
    : undefined);
}

/** 「第 1 次回真数据，之后挂住」的桩：用来钉「新数据没到之前旧读数必须留着」。 */
function firstThenStall(): { handler: Handler; release: () => void } {
  let calls = 0;
  let release: ((r: Response) => void) | null = null;
  const handler: Handler = (url) => {
    if (!url.startsWith(SYSTEM_METRICS_PATH)) return undefined;
    calls += 1;
    if (calls === 1) return jsonResponse(200, METRICS);
    return new Promise<Response>((resolve) => { release = resolve; });
  };
  return {
    handler,
    release: () => release?.(jsonResponse(200, METRICS)),
  };
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  setDocumentHidden(false);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('判据 S-7：懒挂载 —— 进管理台不请求，点开「系统」才开始请求', () => {
  it('判据 S-7：/admin/users 落地时 0 次；点开「系统」后开始有请求，且默认带 `?range=1h`', async () => {
    const { wrapper, fetchMock, router } = await mountAdmin(withMetrics());
    expect(metricsCalls(fetchMock), '没点开 tab 就不该发请求').toHaveLength(0);
    await openTab(router, wrapper, 'system');
    const calls = metricsCalls(fetchMock);
    expect(calls.length, 'tab 点开必须立刻拉一次').toBeGreaterThanOrEqual(1);
    expect(String(calls[0][0])).toBe(`${SYSTEM_METRICS_PATH}?range=1h`);
    const init = calls[0][1] as RequestInit | undefined;
    expect(init?.method ?? 'GET', '只读端点：不许发非 GET').toBe('GET');
    expect(wrapper.find('[data-test="admin-system"]').exists()).toBe(true);
  });

  it('判据 S-5：轮询周期 5s；`document.hidden` 时拨一下不发，回到前台立刻补发一次', async () => {
    const { fetchMock } = await openSystem(withMetrics());
    expect(tickPeriodMs, '轮询周期必须是 5s（issue #650 写死的常量）').toBe(5_000);
    const before = metricsCalls(fetchMock).length;

    setDocumentHidden(true);
    tickCallback?.();
    await flushPromises();
    expect(metricsCalls(fetchMock).length, '页面隐藏时不许继续打端点').toBe(before);

    setDocumentHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(metricsCalls(fetchMock).length, '回到前台必须立刻拉一次，不等下一个 5s').toBe(before + 1);

    setDocumentHidden(false);
    tickCallback?.();
    await flushPromises();
    expect(metricsCalls(fetchMock).length, '可见时定时器照常发').toBe(before + 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('判据 S-1：四张卡各显示自己的读数', () => {
  it('CPU：使用率 + **归一化 load 行**（工单点名的 `load 5.26 / 36 核 ≈ 14.6%`）', async () => {
    const { wrapper } = await openSystem(withMetrics());
    expect(wrapper.find('[data-test="card-cpu"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="cpu-usage"]').text()).toContain('12.5%');
    expect(wrapper.get('[data-test="cpu-cores"]').text()).toContain('36');
    const load = wrapper.get('[data-test="cpu-load"]').text();
    expect(load).toContain('5.26');
    expect(load).toContain('36');
    // 归一化幅度：5.26 / 36 = 14.61% ⇒ 界面上必须是「≈ 14.6%」这一侧，不能只报裸 load。
    expect(load).toMatch(/14\.6\s*%/);
  });

  it('内存：used / total + available / cached / swap（单位带口径后缀 GiB）', async () => {
    const { wrapper } = await openSystem(withMetrics());
    const used = wrapper.get('[data-test="mem-used"]').text();
    expect(used).toContain('40 GiB');
    expect(used).toContain('128 GiB');
    expect(used).toContain('31.3%');
    expect(wrapper.get('[data-test="mem-available"]').text()).toContain('84 GiB');
    expect(wrapper.get('[data-test="mem-cached"]').text()).toContain('12 GiB');
    expect(wrapper.get('[data-test="mem-swap"]').text()).toContain('2 GiB');
  });

  it('磁盘：**每个 device 一行**（设备名 + 挂载点 + 类型 + 用量），diskUnreadable 的路径也露面', async () => {
    const { wrapper } = await openSystem(withMetrics());
    const rows = wrapper.findAll('[data-test="disk-row"]');
    expect(rows).toHaveLength(2);
    const first = rows[0];
    expect(first.get('[data-test="disk-device"]').text()).toContain('/dev/nvme0n1p2');
    expect(first.get('[data-test="disk-mount"]').text()).toContain('/');
    expect(first.get('[data-test="disk-fs"]').text()).toContain('ext4');
    expect(first.get('[data-test="disk-usage"]').text()).toContain('72.1%');
    expect(first.find('[data-test="disk-bar"]').exists(), '每行要有用量条').toBe(true);
    expect(rows[1].get('[data-test="disk-device"]').text()).toContain('/dev/sda1');
    expect(rows[1].get('[data-test="disk-fs"]').text()).toContain('xfs');

    const unreadable = wrapper.findAll('[data-test="disk-unreadable"]');
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0].text()).toContain('/data');
    expect(unreadable[0].text()).toContain('ENOENT');
    // 「已监控 N 个文件系统」要说得出 N（与行数一致，不是悄悄少一行）
    expect(wrapper.get('[data-test="disk-monitored"]').text()).toContain('2');
  });

  it('容器：running / total + FDE x/y + 对账行 `DB N 台 ↔ Docker M 台`（一致时**不**点名）', async () => {
    const { wrapper } = await openSystem(withMetrics());
    expect(wrapper.get('[data-test="containers-running"]').text()).toContain('33');
    expect(wrapper.get('[data-test="containers-running"]').text()).toContain('41');
    expect(wrapper.get('[data-test="containers-fde"]').text()).toContain('6');
    expect(wrapper.get('[data-test="containers-fde"]').text()).toContain('7');
    const drift = wrapper.get('[data-test="containers-drift"]').text();
    expect(drift).toContain('DB');
    expect(drift).toMatch(/7\s*台?\s*↔\s*7/);
    expect(wrapper.find('[data-test="drift-only-db"]').exists(), 'count=0 时不许列名字（是噪声）').toBe(false);
    expect(wrapper.find('[data-test="drift-only-docker"]').exists()).toBe(false);
  });

  it('容器：`drift.count > 0` 才列 onlyDb / onlyDocker 的名字', async () => {
    const drifting = {
      ...METRICS,
      latest: {
        ...METRICS.latest,
        containers: {
          total: 41, running: 33, paused: 0, stopped: 8, station: 12, fde: 8, fdeRunning: 6,
          drift: { db: 7, docker: 8, onlyDb: ['fde-gone'], onlyDocker: ['fde-stray'], count: 2 },
        },
      },
    };
    const { wrapper } = await openSystem(withMetrics(drifting));
    expect(wrapper.get('[data-test="drift-only-db"]').text()).toContain('fde-gone');
    expect(wrapper.get('[data-test="drift-only-docker"]').text()).toContain('fde-stray');
  });

  it('每卡一条 sparkline + 采样时刻（`30 秒前`）', async () => {
    const { wrapper } = await openSystem(withMetrics());
    // 三张有历史序列的卡各一条图（磁盘本端点不下发历史 ⇒ 只有 sparkline 的那三张）
    expect(wrapper.findAll('[data-test="metric-chart"]').length).toBeGreaterThanOrEqual(3);
    expect(wrapper.findAll('[data-test="metric-chart-line"]').length).toBeGreaterThanOrEqual(3);
    for (const key of ['cpu', 'mem', 'containers']) {
      const at = wrapper.get(`[data-test="${key}-sampled-at"]`).text();
      expect(at, `${key} 卡必须带采样时刻`).toMatch(/30\s*秒前|刚刚/);
    }
  });

  it('每卡都有采样时刻，且**不是** `0` / `NaN` / `undefined` / `null` 字样', async () => {
    const { wrapper } = await openSystem(withMetrics());
    const text = wrapper.get('[data-test="admin-system"]').text();
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');
    expect(text).not.toMatch(/\bnull\b/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('判据 S-3：拿不到 ⇒ 「未知」，绝不渲染成 0', () => {
  it('latest 整份缺值（每格 null）⇒ 一格 0 都没有，也一个 NaN 都没有', async () => {
    const blank = {
      ...METRICS,
      series: { bucketSeconds: 30, points: [] },
      latest: {
        sampled_at: null,
        cpu: { usagePct: null, cores: null, load: [null, null, null] },
        mem: {
          totalBytes: null, usedBytes: null, availableBytes: null,
          cachedBytes: null, swapUsedBytes: null, usedPct: null,
        },
        disk: [],
        diskUnreadable: [],
        containers: null,
      },
    };
    const { wrapper } = await openSystem(withMetrics(blank));
    const unknown = String(t('admin.system.unknown'));
    expect(wrapper.get('[data-test="cpu-usage"]').text()).toBe(unknown);
    expect(wrapper.get('[data-test="cpu-cores"]').text()).toBe(unknown);
    expect(wrapper.get('[data-test="cpu-load"]').text()).toBe(unknown);
    expect(wrapper.get('[data-test="mem-used"]').text()).not.toMatch(/\b0\b/);
    expect(wrapper.get('[data-test="mem-available"]').text()).toBe(unknown);
    expect(wrapper.get('[data-test="containers-unknown"]').exists()).toBe(true);
    expect(wrapper.text()).not.toMatch(/NaN|undefined/);
    expect(wrapper.text()).not.toMatch(/\bnull\b/);
  });

  it('`containers: null` = docker 不可达 ⇒ 说「读不到」，不说「0 台」（#586 口径）', async () => {
    const noDocker = { ...METRICS, latest: { ...METRICS.latest, containers: null } };
    const { wrapper } = await openSystem(withMetrics(noDocker));
    const text = wrapper.get('[data-test="card-containers"]').text();
    expect(text).toContain('读不到');
    expect(text).toContain('docker');
    expect(wrapper.find('[data-test="containers-running"]').exists(), '不许把整格兜成 0 / 0').toBe(false);
    // 别张卡不受影响（一格坏 ≠ 整页坏）
    expect(wrapper.get('[data-test="cpu-usage"]').text()).toContain('12.5%');
  });

  it('服务端给的 `unknown` 字面量（设备名 / fs）收成「未知」，不原样上屏', async () => {
    const unknownDevice = {
      ...METRICS,
      latest: {
        ...METRICS.latest,
        disk: [{ device: 'unknown', path: '/x', fs: 'unknown', totalBytes: null, usedBytes: null, availBytes: null, usedPct: null }],
      },
    };
    const { wrapper } = await openSystem(withMetrics(unknownDevice));
    const row = wrapper.get('[data-test="disk-row"]');
    const unknown = String(t('admin.system.unknown'));
    expect(row.get('[data-test="disk-device"]').text()).toBe(unknown);
    expect(row.get('[data-test="disk-fs"]').text()).toBe(unknown);
    expect(row.text()).not.toMatch(/\b0\b/, '用量全缺 ⇒ 不许出现 0');
  });

  it('采样时刻不可解析 / 在未来 ⇒ 原样给出，不夹成「刚刚」也不出 NaN', async () => {
    const weird = {
      ...METRICS,
      latest: { ...METRICS.latest, sampled_at: '2099-01-01T00:00:00.000Z' },
    };
    const { wrapper } = await openSystem(withMetrics(weird));
    const at = wrapper.get('[data-test="cpu-sampled-at"]').text();
    expect(at).toContain('2099');
    expect(at).not.toMatch(/NaN|Invalid Date/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('判据 S-2：三态各自独立降级（一个错不许整页红）', () => {
  it('`enabled:false` ⇒ 显式「采样已关闭」并附怎么开（`SYSTEM_METRICS_ENABLED=1` + 重启 portal）', async () => {
    const { wrapper } = await openSystem(withMetrics({ enabled: false, latest: null }));
    const banner = wrapper.find('[data-test="system-disabled"]');
    expect(banner.exists(), '采样关闭时必须有那句话').toBe(true);
    expect(banner.text()).toContain('SYSTEM_METRICS_ENABLED=1');
    expect(banner.text()).toContain('重启');
    // 这是「已关闭」而不是「等首拍」：两条文案不许同时出现（前端不许自己猜是哪种）
    expect(wrapper.find('[data-test="system-waiting"]').exists()).toBe(false);
  });

  it('`enabled:true` 而 `latest:null` ⇒ 说「等待首拍」，**不说**采样已关闭', async () => {
    const { wrapper } = await openSystem(withMetrics({ enabled: true, latest: null }));
    expect(wrapper.find('[data-test="system-waiting"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="system-disabled"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('SYSTEM_METRICS_ENABLED=1');
  });

  it('`enabled` 缺键（老后端）⇒ 两句都别说（「没说」不是「说了不是」）', async () => {
    const { enabled: _drop, ...noEnabled } = METRICS;
    const { wrapper } = await openSystem(withMetrics(noEnabled));
    expect(wrapper.find('[data-test="system-disabled"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="system-waiting"]').exists()).toBe(false);
  });

  it('`seriesError` ⇒ 只有图区说「历史不可用：<原因>」，四张卡照常渲染（这是本端点存在的理由）', async () => {
    const broken = {
      ...METRICS,
      series: { bucketSeconds: 900, points: [] },
      seriesError: '57P01',
    };
    const { wrapper } = await openSystem(withMetrics(broken));
    const note = wrapper.get('[data-test="system-series-error"]').text();
    expect(note).toBe(String(t('admin.system.historyUnavailable', { reason: '57P01' })));
    for (const card of ['card-cpu', 'card-mem', 'card-disk', 'card-containers']) {
      expect(wrapper.find(`[data-test="${card}"]`).exists(), `${card} 必须照常渲染`).toBe(true);
    }
    expect(wrapper.get('[data-test="cpu-usage"]').text()).toContain('12.5%');
    // 图区里也要说同一句（sparkline 自己走空态，不画贴底假线）
    expect(wrapper.findAll('[data-test="metric-chart-empty"]').length).toBeGreaterThanOrEqual(3);
    expect(wrapper.findAll('[data-test="metric-chart-empty"]').at(0)!.text()).toContain('57P01');
  });

  it('无 seriesError 但区间真的没点 ⇒ 图区「该区间无数据」，且不画贴底的假线', async () => {
    const empty = { ...METRICS, series: { bucketSeconds: 30, points: [] } };
    const { wrapper } = await openSystem(withMetrics(empty));
    const empties = wrapper.findAll('[data-test="metric-chart-empty"]');
    expect(empties.length).toBeGreaterThanOrEqual(3);
    expect(empties[0].text()).toContain(String(t('admin.system.noData')));
    for (const line of wrapper.findAll('[data-test="metric-chart-line"]')) {
      expect(line.attributes('d'), '没有点就不许有 d').toBe('');
    }
    expect(wrapper.find('[data-test="system-series-error"]').exists(), '没出错就不许说「历史不可用」').toBe(false);
  });

  it('请求本身失败（403 / 网络）⇒ 一行错误 + 服务端 message 原文，且四张卡不假装成 0', async () => {
    const { wrapper } = await openSystem((url) => (url.startsWith(SYSTEM_METRICS_PATH)
      ? jsonResponse(403, { error: { code: 'forbidden', message: 'admin-only-650' } })
      : undefined));
    expect(wrapper.get('[data-test="system-error"]').text()).toContain('admin-only-650');
    expect(wrapper.find('[data-test="card-cpu"]').exists(), '没 loaded 就整段不渲染（而不是渲染成 0）').toBe(false);
    expect(wrapper.find('[data-test="system-loading"]').exists()).toBe(false);
  });

  it('判据 S-6：首次加载中是骨架，一个数字都没有', async () => {
    // 第一次请求挂住不回（用桩：永不 resolve），骨架必须出现在 loaded 之前
    let release: ((r: Response) => void) | null = null;
    const { wrapper } = await openSystem((url) => {
      if (!url.startsWith(SYSTEM_METRICS_PATH)) return undefined;
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    await flushPromises();
    const skeleton = wrapper.find('[data-test="system-loading"]');
    expect(skeleton.exists(), '首次加载中必须有骨架').toBe(true);
    expect(skeleton.text()).not.toMatch(/\d/);
    expect(wrapper.find('[data-test="card-cpu"]').exists()).toBe(false);
    release?.(jsonResponse(200, METRICS));
    await flushPromises();
    expect(wrapper.find('[data-test="system-loading"]').exists(), '数据到了骨架必须让位').toBe(false);
    expect(wrapper.find('[data-test="card-cpu"]').exists()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('判据 S-4：范围切换（选中态跟服务端回显走）', () => {
  it('点 `24h` ⇒ 发一次带 `?range=24h` 的请求，选中态跟着走；`7d`/`30d` 的横轴带日期', async () => {
    const { wrapper, fetchMock } = await openSystem(withMetrics((url) => ({
      ...METRICS,
      range: url.includes('range=24h') ? '24h' : METRICS.range,
      series: url.includes('range=24h')
        ? {
            bucketSeconds: 900,
            points: [
              { t: new Date(Date.now() - 20 * 3_600_000).toISOString(), cpuAvg: 5, cpuMax: 9, memUsed: GIB, containersRunning: 10, samples: 3 },
              { t: new Date(Date.now() - 3_600_000).toISOString(), cpuAvg: 8, cpuMax: 12, memUsed: 2 * GIB, containersRunning: 11, samples: 3 },
            ],
          }
        : METRICS.series,
    })));
    expect(wrapper.get('[data-test="range-1h"]').attributes('aria-pressed')).toBe('true');

    await wrapper.get('[data-test="range-24h"]').trigger('click');
    await flushPromises();
    expect(metricsCalls(fetchMock).some(([url]) => String(url).includes('range=24h'))).toBe(true);
    expect(wrapper.get('[data-test="range-24h"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-test="range-1h"]').attributes('aria-pressed')).toBe('false');
    // 桶宽一句话要跟着生效桶宽说（900s ⇒ 15 分钟）
    expect(wrapper.get('[data-test="system-bucket"]').text()).toContain('15');
    // 端点标签必须能区分是哪一天（跨日范围只写「08:00」读不出）
    expect(wrapper.findAll('[data-test="metric-chart-x-start"]').length).toBeGreaterThanOrEqual(3);
  });

  it('服务端把 range 回显成 `1h`（非法入参被回落）⇒ 选中态画 `1h`，不画本地点过的那个', async () => {
    const { wrapper } = await openSystem((url) => (url.startsWith(SYSTEM_METRICS_PATH)
      ? jsonResponse(200, { ...METRICS, range: '1h' })
      : undefined));
    await wrapper.get('[data-test="range-7d"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="range-1h"]').attributes('aria-pressed'),
      '选中态必须跟**生效**值（页面不许撒谎）').toBe('true');
    expect(wrapper.get('[data-test="range-7d"]').attributes('aria-pressed')).toBe('false');
  });

  it('切换区间时新数据没到 ⇒ 旧读数留在原地（不闪白、不清空，也不退回首屏骨架）', async () => {
    const stalled = firstThenStall();
    const { wrapper } = await openSystem(stalled.handler);
    expect(wrapper.get('[data-test="cpu-usage"]').text()).toContain('12.5%');

    await wrapper.get('[data-test="range-6h"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="cpu-usage"]').text(), '新数据没到之前旧读数必须在').toContain('12.5%');
    expect(wrapper.find('[data-test="system-loading"]').exists(),
      '已有读数时不许退回首屏骨架').toBe(false);
    stalled.release();
    await flushPromises();
  });

  it('请求成功后错误行让位（轮询里 DB 抖一下又恢复 ⇒ 不该留着红字）', async () => {
    let calls = 0;
    const { wrapper } = await openSystem((url) => {
      if (!url.startsWith(SYSTEM_METRICS_PATH)) return undefined;
      calls += 1;
      return calls === 1
        ? jsonResponse(500, { error: { code: 'internal', message: 'flaky-650' } })
        : jsonResponse(200, METRICS);
    });
    expect(wrapper.get('[data-test="system-error"]').text()).toContain('flaky-650');
    setDocumentHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(wrapper.find('[data-test="system-error"]').exists(), '恢复后错误行必须收掉').toBe(false);
    expect(wrapper.find('[data-test="card-cpu"]').exists()).toBe(true);
  });
});
