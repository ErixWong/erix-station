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
