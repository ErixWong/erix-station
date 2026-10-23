// 工作台「预览端口」区块单测（#246 交付② 单 B）。装配风格照 WorkbenchView.spec.ts：
// 真实 i18n 单例 + createAppRouter(createMemoryHistory()) + 按 URL 分派的 fetch 桩。
// 钉四条：① 进视图就拉 GET /api/me/ports（折叠也拉）；② **未点击不得请求签票**（防预取）；
// ③ 点击才签票、且签的是列表行的 id、新标签地址是带票的预览地址（当前页 URL 上不出现 ticket）；
// ④ 空列表（admin/未分段）与加载失败都有可见反馈，state 文案不写「健康/运行中」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import WorkbenchView from './WorkbenchView.vue';
import { createAppRouter } from '../router';
import { useAuthStore, type AuthUser } from '../stores/auth';
import { i18n, setLocale } from '../i18n';

const FDE_USER = {
  id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local',
} as AuthUser;
// issue #308（M3）：原夹具是「无工位管理员」（`admin` 且 `fde_name=null`）——#334 的准入闸
// （lib/workbenchGate.ts：`role==='admin' && !fde_name` ⇒ 改写去 /admin）之后这个形状**进不到工作台**，
// 拿它当夹具等于给不可达状态做覆盖。换成第 ② 类人（`admin` **且**有工位，闸放行）：
// 他同样能走到「端口列表为空」这条路径（尚未分段），空态覆盖因此保住。
const ADMIN_WITH_SEAT = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: 'root', auth_source: 'local',
} as AuthUser;
const DIRS = [{ name: 'demo', cwd: '~/projects/demo', running_count: 0, queued_count: 0 }];

const UUID_22000 = 'aaaaaaaa-0000-4000-8000-000000002200';
const UUID_22001 = 'aaaaaaaa-0000-4000-8000-000000002201';
const UUID_22002 = 'aaaaaaaa-0000-4000-8000-000000002202';

function portRow(id: string, port: number, state: string) {
  return {
    id,
    port,
    hostname: `alice-p-${port}.fde.erix.vip`,
    url: `http://alice-p-${port}.fde.erix.vip:8090`,
    state,
    scope: 'fde',
    role: 'spare',
    exposure: 'private',
  };
}

const THREE_PORTS = [
  portRow(UUID_22000, 22000, 'allocated'),
  portRow(UUID_22001, 22001, 'active'),
  portRow(UUID_22002, 22002, 'active'),
];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Handler = (url: string, init?: RequestInit) => Response | undefined;

/** 挂载工作台：/api/me/ports 由 handler 决定，其余走工作台自身需要的最小集合。 */
async function mountWorkbench(user: AuthUser, portsHandler: Handler) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const handled = portsHandler(url, init);
    if (handled) return handled;
    if (url.startsWith('/api/me')) return jsonResponse(200, { user });
    if (url.startsWith('/api/dirs')) return jsonResponse(200, { dirs: DIRS });
    if (url.startsWith('/api/sessions')) return jsonResponse(200, { items: [] });
    return jsonResponse(404, { error: { code: 'not_found', message: 'not found' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const auth = useAuthStore();
  auth.user = user;
  auth.ready = true; // 守卫不再打 /api/me
  const router = createAppRouter(createMemoryHistory());
  router.push('/');
  await router.isReady();
  const wrapper = mount(WorkbenchView, { global: { plugins: [pinia, router, i18n] }, attachTo: document.body });
  await flushPromises();
  return { wrapper, fetchMock };
}

/** 假标签：jsdom 的 window.open 未实现（返回 null），必须桩掉才能断言「新标签的地址」。 */
function stubOpen() {
  const tabs: Array<{ location: { href: string }; opener?: unknown; close: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal('open', vi.fn(() => {
    const tab = { location: { href: '' }, opener: {}, close: vi.fn() };
    tabs.push(tab);
    return tab;
  }));
  return tabs;
}

function toggle(wrapper: VueWrapper) {
  return wrapper.get('[data-test="preview-ports-toggle"]');
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('工作台 · 预览端口区块', () => {
  it('进视图即拉 GET /api/me/ports（不展开始终拉一次），折叠条报条数；未点击绝不签票', async () => {
    const { wrapper, fetchMock } = await mountWorkbench(FDE_USER, (url, init) => {
      if (url === '/api/me/ports' && !init?.method) return jsonResponse(200, { items: THREE_PORTS });
      if (/preview-ticket$/.test(url)) {
        throw new Error(`未点击就签了票：${url}（ticket 60 秒过期且一次性，不许预取）`);
      }
      return undefined;
    });
    try {
      expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/me/ports')).toHaveLength(1);
      const bar = toggle(wrapper);
      expect(bar.text()).toContain('预览端口（3 个）');
      expect(bar.attributes('aria-expanded')).toBe('false');
      // 防预取：整个面板只打过列表端点，一条 POST 都没有
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    } finally {
      wrapper.unmount();
    }
  });

  it('展开：3 条 items ⇒ 3 行，port/hostname/state 齐；state 文案不出现「健康/运行中」', async () => {
    const { wrapper } = await mountWorkbench(FDE_USER, (url, init) =>
      url === '/api/me/ports' && !init?.method ? jsonResponse(200, { items: THREE_PORTS }) : undefined);
    try {
      await toggle(wrapper).trigger('click');
      const rows = wrapper.findAll('[data-test="preview-port-row"]');
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.get('[data-test="preview-port-value"]').text()))
        .toEqual(['22000', '22001', '22002']);
      expect(rows[0].get('[data-test="preview-port-hostname"]').text())
        .toBe('alice-p-22000.fde.erix.vip');
      const states = rows.map((row) => row.get('[data-test="preview-port-state"]'));
      // issue #308：端口段搬进左侧栏（最窄档内容宽约 163px）后行内只放**短**标签
      // ——长口径「已放行过（仅表示首次放行过）」单格就约 168px，装不下。
      // 判据仍承重：短标签逐字 + **完整口径必须仍可达**（title/aria-label），两条缺一就退化成「只有短词/只有颜色」。
      expect(states.map((node) => node.text())).toEqual(['待首次访问', '已放行过', '已放行过']);
      const fullLabels = [
        '已分配 · 待首次访问',
        '已放行过（仅表示首次放行过）',
        '已放行过（仅表示首次放行过）',
      ];
      expect(states.map((node) => node.attributes('title'))).toEqual(fullLabels);
      expect(states.map((node) => node.attributes('aria-label'))).toEqual(fullLabels);
      for (const node of states) {
        // 可见文本与完整口径都不许写「健康/运行中」（§4.7a）
        const text = `${node.text()} ${node.attributes('title')}`;
        expect(text).not.toMatch(/健康/);
        expect(text).not.toMatch(/运行中/);
      }
      // 4 列表格形态在侧栏里装不下（§3.1）⇒ 工作台走 variant='list'
      expect(wrapper.find('[data-test="preview-ports-table"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="preview-ports-list"]').exists()).toBe(true);
    } finally {
      wrapper.unmount();
    }
  });

  it('点第 2 行「打开预览」：POST 该行的 allocation id，新标签地址 = <url>/?preview_ticket=…，当前页 URL 不留票', async () => {
    const { wrapper, fetchMock } = await mountWorkbench(FDE_USER, (url, init) => {
      if (url === '/api/me/ports' && !init?.method) return jsonResponse(200, { items: THREE_PORTS });
      if (url === `/api/ports/${UUID_22001}/preview-ticket` && init?.method === 'POST') {
        return jsonResponse(201, {
          ticket: 'pt_22001',
          url: 'http://alice-p-22001.fde.erix.vip:8090/?preview_ticket=pt_22001',
          expires_in: 60,
        });
      }
      return undefined;
    });
    const tabs = stubOpen();
    try {
      await toggle(wrapper).trigger('click');
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);

      await wrapper.findAll('[data-test="preview-port-open"]')[1].trigger('click');
      await flushPromises();

      expect(fetchMock.mock.calls.filter(([url]) => /preview-ticket$/.test(String(url))))
        .toHaveLength(1);
      expect(String(fetchMock.mock.calls.find(([url]) => /preview-ticket$/.test(String(url)))![0]))
        .toBe(`/api/ports/${UUID_22001}/preview-ticket`);
      expect(tabs).toHaveLength(1);
      expect(tabs[0]!.location.href).toBe('http://alice-p-22001.fde.erix.vip:8090/?preview_ticket=pt_22001');
      // ticket 不许进当前页 URL（面板所在的工作台地址不该出现票）
      expect(window.location.href).not.toContain('preview_ticket');
    } finally {
      wrapper.unmount();
    }
  });

  it('签票失败（429 rate_limited）：先同步开的空白标签收回去，面板显示错误码与原文', async () => {
    const { wrapper } = await mountWorkbench(FDE_USER, (url, init) => {
      if (url === '/api/me/ports' && !init?.method) return jsonResponse(200, { items: THREE_PORTS });
      if (/preview-ticket$/.test(url) && init?.method === 'POST') {
        return jsonResponse(429, { error: { code: 'rate_limited', message: '预览 ticket 签发过于频繁，请稍后再试' } });
      }
      return undefined;
    });
    const tabs = stubOpen();
    try {
      await toggle(wrapper).trigger('click');
      await wrapper.findAll('[data-test="preview-port-open"]')[0].trigger('click');
      await flushPromises();
      expect(wrapper.get('[data-test="preview-ticket-error"]').text())
        .toContain('签发预览通行票失败（rate_limited）：预览 ticket 签发过于频繁');
      // 点击手势内同步开的空白标签：签票失败必须被收回，且从没被填上预览地址
      expect(tabs).toHaveLength(1);
      expect(tabs[0]!.location.href).toBe('');
      expect(tabs[0]!.close).toHaveBeenCalledTimes(1);
    } finally {
      wrapper.unmount();
    }
  });

  it('列表为空（有工位但平台尚未分段）⇒ 折叠条不带条数，展开走空态而不是空白', async () => {
    const { wrapper } = await mountWorkbench(ADMIN_WITH_SEAT, (url, init) =>
      url === '/api/me/ports' && !init?.method ? jsonResponse(200, { items: [] }) : undefined);
    try {
      expect(toggle(wrapper).text()).toContain('预览端口');
      expect(toggle(wrapper).text()).not.toContain('（');
      await toggle(wrapper).trigger('click');
      expect(wrapper.find('[data-test="preview-ports-table"]').exists()).toBe(false);
      expect(wrapper.get('[data-test="preview-ports-empty"]').text()).toContain('你还没有预览端口');
    } finally {
      wrapper.unmount();
    }
  });

  it('列表加载失败：折叠条标出「加载失败」，展开显示错误码 + 原文，重试再拉一次', async () => {
    let calls = 0;
    const { wrapper, fetchMock } = await mountWorkbench(FDE_USER, (url, init) => {
      if (url === '/api/me/ports' && !init?.method) {
        calls += 1;
        return jsonResponse(503, { error: { code: 'db_unavailable', message: '数据库暂时不可用' } });
      }
      return undefined;
    });
    try {
      expect(calls).toBe(1);
      expect(toggle(wrapper).text()).toContain('预览端口（加载失败）');
      await toggle(wrapper).trigger('click');
      expect(wrapper.get('[data-test="preview-ports-error"]').text())
        .toBe('预览端口加载失败（db_unavailable）：数据库暂时不可用');
      await wrapper.get('[data-test="preview-ports-retry"]').trigger('click');
      await flushPromises();
      expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/me/ports')).toHaveLength(2);
    } finally {
      wrapper.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// issue #308：区块从「顶栏与 main 之间的全宽横条」搬进左侧栏底部（aside 内的底部堆叠区），
// 与目录树各自折叠。本套件钉搬迁的**结构事实**（工单 §五.6 的可判形式）与那条不得破坏的标记契约。
// ---------------------------------------------------------------------------
describe('工作台 · 预览端口段已搬进左栏（issue #308）', () => {
  it('折叠条在 aside 的底部栈里；header 之后直接是 main（横条确已消失）；标记仍唯一', async () => {
    const { wrapper } = await mountWorkbench(FDE_USER, (url, init) =>
      url === '/api/me/ports' && !init?.method ? jsonResponse(200, { items: THREE_PORTS }) : undefined);
    try {
      const bar = toggle(wrapper);
      // ① 标记契约：`preview-ports-toggle` 在工作台挂载时必须存在（#255 拿它当挂载标记，不许改名/删除）
      expect(wrapper.find('[data-test="preview-ports-toggle"]').exists()).toBe(true);
      expect(document.querySelectorAll('[data-test="preview-ports-toggle"]')).toHaveLength(1); // 搬完不留旧的一份
      // ② 位置：在 aside 内的底部堆叠区里（与目录树同栈）
      expect(bar.element.closest('aside')).not.toBeNull();
      expect(bar.element.closest('[data-test="sidebar-bottom-stack"]')).not.toBeNull();
      // ③ 结构判据：header 的下一个兄弟就是 main ⇒ 顶栏与消息流之间不再有端口区块
      expect(wrapper.get('header').element.nextElementSibling!.tagName.toLowerCase()).toBe('main');
      // ④ 消息流那一栏（aside 的兄弟 section）里没有端口面板（面板只在侧栏里）
      expect(wrapper.get('main > section').element.querySelector('[data-test="preview-ports-panel-body"]')).toBeNull();
      // ⑤ 三个几何钩子在工作台 DOM 上都在
      expect(wrapper.find('[data-test="sidebar-aside"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="sidebar-session-list"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="sidebar-bottom-stack"]').exists()).toBe(true);
      // ⑥ 默认折叠（搬进侧栏不改变默认态）
      expect(bar.attributes('aria-expanded')).toBe('false');
    } finally {
      wrapper.unmount();
    }
  });
});
