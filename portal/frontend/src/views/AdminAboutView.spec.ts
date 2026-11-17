// issue #586 管理台「关于」面板（版本三格）的前端单测。装配风格照 `PreviewPoolUsageView.spec.ts`：
// 真实 i18n 单例 + App + createAppRouter(createMemoryHistory()) + 按 URL 分派的 fetch 桩。
//
// 逐条对应工单 261116-12 的 C 段判据（名字里点明判据号，报告可直接引用）：
//   C-1 三段分开呈现（服务端 / 平台侧引擎 / 每台 FDE）
//   C-2 **不许互抄**：三格各显示自己那一格的值（夹具故意让三个数互不相同）
//   C-3 FDE 段必须显示「provision 时快照」字样（`containers.agent_version` 不作准）
//   C-4 懒挂载：进管理台 0 次请求，切到该 tab 恰好 1 次
//   C-5 「读不到」≠「没有 FDE」；`unknown` ≠ 空串 ≠ 0（不猜数）
//   C-6 错误面可见（.syserr 一行 + 服务端 message 原文，只加本地化前缀）
// 另加两条源码级红线（读 `?raw`，jsdom 里不能用 `node:fs`——#349 的坑）：
//   R-1 前端零版本字面量（写死一个 `x.y.z` 就是造第二个会漂的账）
//   R-2 前端不许现编时间当构建时刻（`Date.now()` / `new Date()`）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, type Router } from 'vue-router';
import App from '../App.vue';
import { createAppRouter } from '../router';
import { nextRouteLanding } from '../test-utils/navigation';
import { i18n, setLocale } from '../i18n';
import {
  VERSION_PATH,
  formatInstant,
  normalizeVersionInfo,
  shortRevision,
  versionErrorText,
  versionSourceOf,
} from '../lib/versionSurface';
import viewSource from './AdminAboutView.vue?raw';
import libSource from '../lib/versionSurface.ts?raw';

const t = i18n.global.t;

const ADMIN_USER = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local',
};

/**
 * 三格**互不相同**的夹具（互抄就会在这里露馅）：
 *   服务端 `9.1.1-from-image` / 平台侧引擎 `0.900.1-platform-engine` / 每台 FDE `0.910.7-fde-side`。
 */
const ABOUT = {
  server: {
    station: '9.1.1-from-image', revision: 'b'.repeat(40),
    builtAt: '2026-11-16T03:45:00Z', source: 'build-info',
  },
  platformEngine: { version: '0.900.1-platform-engine' },
  // 服务端实际读的那条路径（复验要求可见；这里给的是镜像内的默认位置）。
  buildInfoPath: '/app/build-info.json',
  fdes: [
    {
      name: 'eric', agentVersion: '0.910.7-fde-side', image: 'ghcr.io/erixwong/erix-station-fde@sha256:aaa',
      provisionedAt: '2026-11-16T02:00:00.000Z', lastHeartbeatAt: null, revoked: false,
      versionSource: 'containers.agent_version', snapshot: 'provision',
    },
    {
      name: 'bob', agentVersion: 'unknown', image: 'unknown',
      provisionedAt: null, lastHeartbeatAt: null, revoked: true,
      versionSource: 'containers.agent_version', snapshot: 'provision',
    },
  ],
  fdesPresent: true,
  // #643 B：服务端顶层真布尔。夹具给 `false`（发布件形状）⇒ 既有断言不受影响；
  // 新用例自己造变体（true / 缺键），不去改既有预期值。
  localBuild: false,
  provenance: {
    server: 'build-info.json', platformEngine: 'build-info.json', fdes: 'containers.agent_version', fdesSnapshot: 'provision',
  },
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

async function mountAdmin(handler: Handler = () => undefined, path = '/admin/users') {
  const pinia = createPinia();
  setActivePinia(pinia);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return (await handler(url, init)) ?? defaultHandler(url)
      ?? jsonResponse(404, { error: { code: 'not_found', message: 'not found' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [pinia, router, i18n] }, attachTo: document.body });
  await flushPromises();
  return { wrapper, fetchMock, router };
}

function versionCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith(VERSION_PATH));
}

/** 点管理台 tab（零墙钟：先订阅 afterEach，再点，再 await 落地；见 #473 family B 的说明）。 */
async function openAboutTab(router: Router, wrapper: VueWrapper) {
  const label = String(t('admin.tabs.about'));
  const tab = wrapper.findAll('nav a').find((item) => item.text() === label);
  if (!tab) throw new Error(`管理台 tab「${label}」不存在`);
  const landed = nextRouteLanding(router);
  await tab.trigger('click');
  await landed;
  await flushPromises();
  expect(wrapper.find('[data-test="admin-about"]').exists(), 'AdminAboutView 未挂载').toBe(true);
  await flushPromises();
}

async function openAbout(handler: Handler = () => undefined) {
  const ctx = await mountAdmin(handler, '/admin/users');
  await openAboutTab(ctx.router, ctx.wrapper);
  return ctx;
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
});

// ─────────────────────────────────────────────────────────────────────────────
describe('判据 C-4：懒挂载 —— 进管理台不请求，切到「关于」tab 恰好 1 次', () => {
  it('判据 C-4：/admin/users 落地时 0 次；点开「关于」后恰好 1 次 GET /api/admin/version', async () => {
    const { wrapper, fetchMock, router } = await mountAdmin(
      (url) => (url.startsWith(VERSION_PATH) ? jsonResponse(200, ABOUT) : undefined),
    );
    expect(versionCalls(fetchMock)).toHaveLength(0);
    await openAboutTab(router, wrapper);
    expect(versionCalls(fetchMock)).toHaveLength(1);
    const init = versionCalls(fetchMock)[0][1] as RequestInit | undefined;
    expect(init?.method ?? 'GET', '只读端点：不许发非 GET').toBe('GET');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('判据 C-1 / C-2：三段分开呈现，且各显示自己那一格的值（互抄就红）', () => {
  it('三段各显示自己的来源值，三个数互不相同', async () => {
    const { wrapper } = await openAbout((url) => (url.startsWith(VERSION_PATH) ? jsonResponse(200, ABOUT) : undefined));
    expect(wrapper.find('[data-test="about-server"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="about-engine"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="about-fdes"]').exists()).toBe(true);

    expect(wrapper.get('[data-test="server-station"]').text()).toContain('9.1.1-from-image');
    expect(wrapper.get('[data-test="engine-version"]').text()).toContain('0.900.1-platform-engine');
    const eric = wrapper.findAll('[data-test="fde-item"]').find((row) => row.text().includes('eric'));
    expect(eric).toBeTruthy();
    expect(eric!.get('[data-test="fde-agent-version"]').text()).toContain('0.910.7-fde-side');
    // 互抄的三种形状都要红：FDE 格显示平台侧引擎、或显示服务端版本。
    expect(eric!.get('[data-test="fde-agent-version"]').text()).not.toContain('0.900.1-platform-engine');
    expect(eric!.get('[data-test="fde-agent-version"]').text()).not.toContain('9.1.1-from-image');
    expect(wrapper.get('[data-test="engine-version"]').text()).not.toContain('0.910.7-fde-side');
  });

  it('判据 C-3：FDE 每一项都带「provision 时快照」字样（派生副本不作准）', async () => {
    const { wrapper } = await openAbout((url) => (url.startsWith(VERSION_PATH) ? jsonResponse(200, ABOUT) : undefined));
    const rows = wrapper.findAll('[data-test="fde-item"]');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.get('[data-test="fde-snapshot"]').text()).toContain(String(t('admin.about.snapshotProvision')));
    }
    expect(wrapper.text()).toContain('provision 时快照');
  });

  it('服务端段还给出 revision / builtAt / 来源（只报一个版本号等于没说）', async () => {
    const { wrapper } = await openAbout((url) => (url.startsWith(VERSION_PATH) ? jsonResponse(200, ABOUT) : undefined));
    expect(wrapper.get('[data-test="server-revision"]').text()).toContain('b'.repeat(12));
    expect(wrapper.get('[data-test="server-revision"]').attributes('title')).toBe('b'.repeat(40));
    expect(wrapper.get('[data-test="server-built-at"]').text()).not.toBe(String(t('admin.about.unknown')));
    expect(wrapper.get('[data-test="server-source"]').text()).toContain(String(t('admin.about.sourceBuildInfo')));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('判据 C-5：不猜数 —— `unknown` 是「未知」，不是空串、不是 0、不是别处的数', () => {
  it('FDE 那格是 `unknown` ⇒ 渲染成「未知」，且不拿平台侧引擎顶上去', async () => {
    const { wrapper } = await openAbout((url) => (url.startsWith(VERSION_PATH) ? jsonResponse(200, ABOUT) : undefined));
    const bob = wrapper.findAll('[data-test="fde-item"]').find((row) => row.text().includes('bob'));
    expect(bob!.get('[data-test="fde-agent-version"]').text().trim()).toBe(String(t('admin.about.unknown')));
    expect(bob!.text()).not.toContain('0.900.1-platform-engine');
    expect(bob!.text()).toContain(String(t('admin.about.revoked')));
  });

  it('整份 build-info 都是 unknown（本地源码态）⇒ 三格各自显示「未知」，一个 0 都没有', async () => {
    const blank = {
      server: { station: 'unknown', revision: 'unknown', builtAt: 'unknown', source: 'package' },
      platformEngine: { version: 'unknown' },
      fdes: [],
      fdesPresent: true,
      provenance: {},
    };
    const { wrapper } = await openAbout((url) => (url.startsWith(VERSION_PATH) ? jsonResponse(200, blank) : undefined));
    const unknown = String(t('admin.about.unknown'));
    expect(wrapper.get('[data-test="server-station"]').text()).toBe(unknown);
    expect(wrapper.get('[data-test="server-revision"]').text()).toBe(unknown);
    expect(wrapper.get('[data-test="server-built-at"]').text()).toBe(unknown);
    expect(wrapper.get('[data-test="engine-version"]').text()).toBe(unknown);
    expect(wrapper.text()).not.toMatch(/\b0\b/);
    expect(wrapper.get('[data-test="server-source"]').text()).toContain(String(t('admin.about.sourcePackage')));
    expect(wrapper.find('[data-test="fdes-empty"]').exists()).toBe(true);
  });

  it('判据 C-5：`fdesPresent:false` ⇒ 说「读不到」，不说「没有 FDE」', async () => {
    const unreadable = { ...ABOUT, fdes: [], fdesPresent: false };
    const { wrapper } = await openAbout((url) => (url.startsWith(VERSION_PATH) ? jsonResponse(200, unreadable) : undefined));
    expect(wrapper.find('[data-test="fdes-unreadable"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="fdes-empty"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="fdes-unreadable"]').text()).toContain('containers.agent_version');
  });

  it('服务端没给快照标注（`snapshot` 缺失）⇒ 说「口径未给出」，不许默认当成快照', async () => {
    const noSnapshot = {
      ...ABOUT,
      fdes: [{ name: 'zed', agentVersion: '1.2.3', image: null, provisionedAt: null, revoked: false }],
    };
    const { wrapper } = await openAbout((url) => (url.startsWith(VERSION_PATH) ? jsonResponse(200, noSnapshot) : undefined));
    const row = wrapper.get('[data-test="fde-item"]');
    expect(row.get('[data-test="fde-snapshot"]').text()).toContain(String(t('admin.about.snapshotUnknown')));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 复验阻断（第二轮）：来源标注**由服务端按实际来源推导**后下发，路径注入要可见。
// 写死 `'build-info.json'` 的旧形状在「本 PR 之前构建的 portal 镜像」上就是说谎：那份镜像里
// 根本没有 build-info.json，引擎号其实是从 node_modules/erix-agent/package.json 读的。
describe('复验阻断：来源标注跟着实际来源走，build-info 路径可见', () => {
  it('build-info 读不到（旧镜像形状）⇒ 引擎段说「不是镜像里的构建产物」，不许顶着 build-info 那句', async () => {
    const oldImage = {
      ...ABOUT,
      server: { station: '0.666.0-old-station', revision: 'unknown', builtAt: 'unknown', source: 'package' },
      platformEngine: { version: '0.777.0-old-engine' },
      buildInfoPath: '/app/build-info.json',
      provenance: { server: 'package.json', platformEngine: 'package.json', fdes: 'containers.agent_version', fdesSnapshot: 'provision' },
    };
    const { wrapper } = await openAbout((url) => (url.startsWith(VERSION_PATH) ? jsonResponse(200, oldImage) : undefined));
    expect(wrapper.get('[data-test="engine-version"]').text()).toContain('0.777.0-old-engine');
    const engineSource = wrapper.get('[data-test="engine-source"]').text();
    expect(engineSource).toContain(String(t('admin.about.engineSourcePackage')));
    // 来源标注必须点名真正的载体（光说「未知」等于没说）。
    expect(engineSource).toContain('package.json');
    // 不许把 package 兜底说成镜像里的构建产物（复验阻断的那句谎话）。
    expect(engineSource).not.toContain(String(t('admin.about.engineSourceBuildInfo')));
    expect(wrapper.get('[data-test="server-source"]').text()).toContain(String(t('admin.about.sourcePackage')));
  });

  it('build-info 读到时仍说 build-info.json（推导不是恒降级），且界面给出实际读取路径', async () => {
    const { wrapper } = await openAbout((url) => (url.startsWith(VERSION_PATH) ? jsonResponse(200, ABOUT) : undefined));
    expect(wrapper.get('[data-test="engine-source"]').text()).toContain(String(t('admin.about.engineSourceBuildInfo')));
    // 路径被 STATION_BUILD_INFO_PATH / ERIX_BUILD_INFO_PATH 改过时，管理员要能看见是哪条。
    expect(wrapper.get('[data-test="server-build-info-path"]').text()).toContain('/app/build-info.json');
  });

  it('服务端没说路径（老端点 / 桩）⇒ 路径格显示「未知」，不猜成 /app/build-info.json', async () => {
    const noPath = { ...ABOUT };
    delete (noPath as { buildInfoPath?: string }).buildInfoPath;
    const { wrapper } = await openAbout((url) => (url.startsWith(VERSION_PATH) ? jsonResponse(200, noPath) : undefined));
    expect(wrapper.get('[data-test="server-build-info-path"]').text().trim()).toBe(String(t('admin.about.unknown')));
  });

  it('归一化：`buildInfoPath` 的 `unknown` / 缺失收成 null（判据 2 同口径），snake_case 也认', () => {
    expect(normalizeVersionInfo({ buildInfoPath: 'unknown' }).buildInfoPath).toBeNull();
    expect(normalizeVersionInfo({ build_info_path: '/tmp/injected.json' }).buildInfoPath).toBe('/tmp/injected.json');
    expect(normalizeVersionInfo({}).buildInfoPath).toBeNull();
    expect(normalizeVersionInfo(ABOUT).provenance.platformEngine).toBe('build-info.json');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('判据 C-6：错误面（服务端 message 原文 + 本地化前缀，.syserr 一行）', () => {
  it('端点 500 ⇒ 面板给出错误行，且不把「没读到」渲染成三格 0', async () => {
    const { wrapper } = await openAbout((url) => (url.startsWith(VERSION_PATH)
      ? jsonResponse(500, { error: { code: 'internal', message: 'boom-586', retryable: false } })
      : undefined));
    expect(wrapper.find('[data-test="about-error"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="about-error"]').text()).toContain('boom-586');
    expect(wrapper.find('[data-test="admin-about"]').text()).toContain(String(t('admin.about.title')));
    // 没请求成功就没有 loaded：三格整段不渲染（而不是渲染成 0 / 空版本，或把错误伪装成「尚未加载」）。
    expect(wrapper.find('[data-test="about-server"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="about-not-loaded"]').exists()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('lib/versionSurface：归一化与两条源码级红线', () => {
  it('归一化：`unknown` / 空串 / 非字符串一律收成 null，不猜、不 Number() 硬转', () => {
    const normalized = normalizeVersionInfo({
      server: { station: ' ', revision: 42, builtAt: 'unknown', source: 'weird' },
      platformEngine: { version: 0.9 },
      fdes: 'not-an-array',
    });
    expect(normalized.server).toEqual({ station: null, revision: null, builtAt: null, source: 'other' });
    expect(normalized.platformEngineVersion).toBeNull();
    expect(normalized.fdes).toEqual([]);
    expect(normalized.fdesPresent).toBe(false);
    expect(versionSourceOf('build-info')).toBe('build-info');
    expect(versionSourceOf(undefined)).toBe('other');
  });

  it('归一化认后端下发的 snake_case 列名（`agent_version`），也认 camelCase（契约换形不至于显示「未知」）', () => {
    const snake = normalizeVersionInfo({ fdes: [{ name: 'a', agent_version: '0.1.2', snapshot: 'provision' }], fdesPresent: true });
    expect(snake.fdes[0].agentVersion).toBe('0.1.2');
    const camel = normalizeVersionInfo({ fdes: [{ name: 'a', agentVersion: '0.1.2' }], fdesPresent: true });
    expect(camel.fdes[0].agentVersion).toBe('0.1.2');
  });

  it('半截响应 / null / 数组都不许炸', () => {
    for (const raw of [null, undefined, {}, [], 'x', 42, { server: null, fdes: [null, 1] }]) {
      expect(() => normalizeVersionInfo(raw)).not.toThrow();
    }
  });

  it('时间戳：解析不了的原样给出（脏值不静默丢），revision 只截不猜', () => {
    expect(formatInstant(null)).toEqual({ kind: 'unknown' });
    expect(formatInstant('昨天下午').kind).toBe('raw');
    expect(shortRevision('b'.repeat(40))).toBe(`${'b'.repeat(12)}…`);
    expect(shortRevision('abc')).toBe('abc');
    expect(shortRevision(null)).toBeNull();
  });

  it('错误文本取服务端 message（原文，不翻译）', () => {
    expect(versionErrorText(new Error('kaboom'))).toBe('kaboom');
    expect(versionErrorText({ message: 'from-server' })).toBe('from-server');
    expect(versionErrorText(undefined)).toBe('undefined');
  });

  it('红线 R-1：前端零版本字面量（写死一个 x.y.z 就是造第二个会漂的账）', () => {
    for (const [name, source] of [['AdminAboutView.vue', viewSource], ['versionSurface.ts', libSource]] as const) {
      const code = source.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\/\*[\s\S]*?\*\//g, '');
      expect(code.match(/\b\d+\.\d+\.\d+\b/), `${name} 里出现了版本字面量`).toBeNull();
    }
  });

  it('红线 R-2：前端不许现编时间当构建时刻（`Date.now()` / `new Date()` 都不许出现在这两份源文件里）', () => {
    for (const [name, source] of [['AdminAboutView.vue', viewSource], ['versionSurface.ts', libSource]] as const) {
      const code = source.replace(/^\s*\/\/.*$/gm, '');
      // `new Date(raw)`（把服务端给的串解析成本地时间）是允许的；自己 `new Date()` / `Date.now()` 造当下时刻不许。
      expect(code.match(/new Date\(\s*\)/), `${name} 里出现了 new Date()`).toBeNull();
      expect(code.match(/Date\.now\(\)/), `${name} 里出现了 Date.now()`).toBeNull();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// issue #643 B 前端腿。服务端现在下发**顶层真布尔** `localBuild`（算法在服务端：
// `revision === 'unknown'` ⇒ true），界面只在它**真的是 true** 时加一句中性标注。三态：
//   * `true` ⇒ 必须有那句（否则本地构建被当成发布件，就是 #643 本体的形状）。
//   * `false` ⇒ 服务端说「不是」⇒ 发布件，那一节必须干净（多一句就是噪声）。
//   * 缺键 / 脏值 ⇒ 收成 `null` = **服务端没说**：同样不渲染，而且**不许**写成
//     「已烘 build-info / 不是本地构建」这类反面结论 ——「没说」不是「说了不是」。
// 另钉两条红线：归一化只认真布尔（`'true'` 不算）；前端不许从 `revision` 自己推。
const withLocalBuild = (patch: Record<string, unknown>) => (url: string) =>
  url.startsWith(VERSION_PATH) ? jsonResponse(200, { ...ABOUT, ...patch }) : undefined;

/** 把顶层 `localBuild` 从响应里抹掉 = 「服务端没说」（老端点 / 桩给半截）。 */
function withoutKey<T extends object>(payload: T): T {
  const copy = { ...payload } as T & { localBuild?: unknown };
  delete copy.localBuild;
  return copy;
}

describe('判据 #643B-1：只在 `localBuild === true` 时标注；`false` 与「没说」都不出现', () => {
  it('#643B-1a：`localBuild:true` ⇒ 服务端那一节出 `server-local-build`，文案说「本地构建」', async () => {
    const { wrapper } = await openAbout(withLocalBuild({ localBuild: true }));
    const badge = wrapper.find('[data-test="server-local-build"]');
    expect(badge.exists(), 'localBuild:true 却没标注 ⇒ 本地构建被当成发布件').toBe(true);
    const text = badge.text();
    // 语义三要素（工单口径）：本地构建 / 没烘 build-info / 不能当发布件对账。
    expect(text).toContain('本地构建');
    expect(text).toContain('build-info');
    expect(text).toMatch(/发布件/);
    expect(text).toMatch(/对账/);
    // 它属于**服务端那一节**（说的是什么东西是本地构建，不是引擎也不是 FDE）。
    expect(wrapper.get('[data-test="about-server"]').text()).toContain('本地构建');
    // 中性标注：它是状态不是警报（D9 同口径）⇒ 不给 `⚠`、不给告警底色。
    expect(text).not.toContain('⚠');
    expect(badge.attributes('class') ?? '').not.toMatch(/amber|red|syserr/);
  });

  it('#643B-1b：`localBuild:false` ⇒ 不渲染（发布件那一节必须是干净的）', async () => {
    const { wrapper } = await openAbout(withLocalBuild({ localBuild: false }));
    expect(wrapper.find('[data-test="server-local-build"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="about-server"]').text()).not.toContain('本地构建');
  });

  it('#643B-1c：**缺键**（服务端没说）⇒ 不渲染，也不许冒充「已烘」的反面结论', async () => {
    // 响应里**没有** `localBuild` 这个键（ABOUT 本身带 false，所以这里必须真删）。
    const { wrapper } = await openAbout((url) => (url.startsWith(VERSION_PATH)
      ? jsonResponse(200, withoutKey(ABOUT)) : undefined));
    expect(wrapper.find('[data-test="server-local-build"]').exists(),
      '服务端没说却渲染了标注 ⇒ 把「没说」当成「是本地构建」').toBe(false);
    const serverText = wrapper.get('[data-test="about-server"]').text();
    expect(serverText).not.toContain('本地构建');
    // 「没说」不许被写成反面结论（钉住 null ≠ false）：不许出现「已烘 / 不是本地构建」这类断言。
    expect(serverText).not.toMatch(/已烘|不是本地构建|非本地构建/);
  });

  it('#643B-1d：`revision:unknown` 但服务端没说 ⇒ 仍然不渲染（前端不许自已完成构建判定）', async () => {
    const blank = withoutKey({
      ...ABOUT,
      server: { station: 'unknown', revision: 'unknown', builtAt: 'unknown', source: 'package' },
    });
    const { wrapper } = await openAbout((url) => (url.startsWith(VERSION_PATH)
      ? jsonResponse(200, blank) : undefined));
    expect(wrapper.get('[data-test="server-revision"]').text()).toBe(String(t('admin.about.unknown')));
    expect(wrapper.find('[data-test="server-local-build"]').exists()).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 归一化真值表：逐格写死。**口径**：只有 `true` / `false` 两个真布尔才算「服务端说了话」。
// `'true'` 这类字符串**不当真**（M-3 要红的就是这里）：把脏值读成 true 就是「前端替服务端
// 做主」，而这一格要说的是能不能当发布件对账 —— 说错方向就是假账，宁可什么都没说。
describe('判据 #643B-2：`normalizeVersionInfo` 把 `localBuild` 收成三态（只认真布尔）', () => {
  it('#643B-2a：真值表逐格（true/false 是真话；`\'true\'` / `\'no\'` / `1` / 缺失 ⇒ null）', () => {
    expect(normalizeVersionInfo({ localBuild: true }).localBuild).toBe(true);
    expect(normalizeVersionInfo({ localBuild: false }).localBuild).toBe(false);
    // 脏值一律落到「服务端没说」，**不许**被宽松当真。
    expect(normalizeVersionInfo({ localBuild: 'true' }).localBuild).toBeNull();
    expect(normalizeVersionInfo({ localBuild: 'false' }).localBuild).toBeNull();
    expect(normalizeVersionInfo({ localBuild: 'no' }).localBuild).toBeNull();
    expect(normalizeVersionInfo({ localBuild: 1 }).localBuild).toBeNull();
    expect(normalizeVersionInfo({ localBuild: 0 }).localBuild).toBeNull();
    expect(normalizeVersionInfo({ localBuild: null }).localBuild).toBeNull();
    expect(normalizeVersionInfo({}).localBuild).toBeNull();
    expect(normalizeVersionInfo(null).localBuild).toBeNull();
    // snake_case 也认（照 `buildInfoPath` 的先例），但脏值同样不算真。
    expect(normalizeVersionInfo({ local_build: true }).localBuild).toBe(true);
    expect(normalizeVersionInfo({ local_build: false }).localBuild).toBe(false);
    expect(normalizeVersionInfo({ local_build: 'true' }).localBuild).toBeNull();
    // camelCase 在场时以它为准（与 `buildInfoPath ?? build_info_path` 同一条取法）。
    expect(normalizeVersionInfo({ localBuild: false, local_build: true }).localBuild).toBe(false);
    // 它是**顶层**字段，不嵌在 `server` 里（契约写的是顶层真布尔）。
    expect(normalizeVersionInfo({ server: { localBuild: true } }).localBuild).toBeNull();
  });

  it('#643B-2b：`revision` 不参与判定 —— 服务端没说时，`revision` 是 `unknown` 也不许推出 true', () => {
    // 这是反向红线的**行为面**：算法在服务端，前端只搬值，不替服务端做主。
    expect(normalizeVersionInfo({ server: { revision: 'unknown' } }).localBuild).toBeNull();
    expect(normalizeVersionInfo({ server: { revision: 'b'.repeat(40) } }).localBuild).toBeNull();
    // 服务端说了就照它 —— 即使 `revision` 看上去相反（两个方向都不许被 revision 翻）。
    expect(normalizeVersionInfo({ server: { revision: 'unknown' }, localBuild: true }).localBuild).toBe(true);
    expect(normalizeVersionInfo({ server: { revision: 'b'.repeat(40) }, localBuild: false }).localBuild).toBe(false);
    expect(normalizeVersionInfo({ server: { revision: 'b'.repeat(40) }, localBuild: true }).localBuild).toBe(true);
    expect(normalizeVersionInfo({ server: { revision: 'unknown' }, localBuild: false }).localBuild).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 红线 #643B-R：前端不许出现**由 `revision` 推出的**本地构建判定（第二份口径）。
// 做法：剥掉注释（注释里写 `revision` 是**解释**，代码里写才是**判定**），再从每一处
// 「本地构建」出现点取出**它所在的判定表达式**：到最近的语句边界（`, ; } >`）为止。
// 边界是**语句级而不是行尾**，所以跨行写法（多行 `computed`）也跑不掉。
describe('红线 #643B-R：`localBuild` 那一侧的推导不许引用 `revision`', () => {
  it('#643B-R1：两份源文件中，每一处本地构建判定表达式都不含 revision', () => {
    for (const [name, source] of [['AdminAboutView.vue', viewSource], ['versionSurface.ts', libSource]] as const) {
      for (const clause of localBuildClauses(stripComments(source))) {
        expect(clause, `${name} 的本地构建判定里出现了 revision：${clause}`).not.toMatch(/revision/i);
      }
    }
  });

  it('#643B-R2：地板——R1 不得因「根本找不到 localBuild」而空转（防判据是死的）', () => {
    expect(localBuildClauses(stripComments(libSource)).length).toBeGreaterThan(0);
    expect(localBuildClauses(stripComments(viewSource)).length).toBeGreaterThan(0);
    // 渲染条件就是那一个 `=== true`（多一个条件就是有人在前端加了自己的口径）。
    expect(stripComments(viewSource)).toContain('localBuild === true');
    expect(stripComments(libSource)).toMatch(/localBuild:\s*booleanOrNull\(/);
  });
});

/** 「本地构建」的出现点（camel / snake / kebab 都算，渲染与归一化两侧都要被盖到）。 */
const LOCAL_BUILD_MENTION = /localBuild|local_build|local-build/gi;

/** 剥注释：`// …`、`/* … *\/`、模板里的 `<!-- … -->`。 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
}

/** 每一处出现点所在的判定表达式片段（到最近的语句边界 `, ; } >` 为止，上限 300 字）。 */
function localBuildClauses(source: string): string[] {
  return [...source.matchAll(LOCAL_BUILD_MENTION)].map((match) => {
    const from = (match.index ?? 0) + match[0].length;
    const rest = source.slice(from, from + 300);
    const stop = rest.search(/[,;}>]/);
    return stop < 0 ? rest : rest.slice(0, stop);
  });
}
