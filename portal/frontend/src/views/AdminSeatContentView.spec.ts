// issue #727 片 2：管理台「工位内容」页单测（契约 docs/api/portal.md §4.22）。
// 逐条对应工单判据（用例名里点明判据号）：
//   ① 进 tab 才发请求；未选 FDE 时一个工位端点请求都不发
//   ② 只读红线：整条交互流程里 fetch 的 method 全是 GET、URL 不含 `/pv/`、没有 EventSource 实例
//   ③ 点会话 ⇒ 文件树自动展开并高亮该 `cwd` 对应的一级目录
//   ④ 会话「加载更多」用 `next_cursor`；文件树「加载更多」用 `next_after`（复合游标原样透传）
//   ⑥ AdminUsersView 的跳转链接带 `?fde=`
// ⚠ 断言一律走 DOM / fetch 桩（不用 `w.emitted()`：NODE_ENV=production 下恒空）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, type Router } from 'vue-router';
import App from '../App.vue';
import { createAppRouter } from '../router';
import { nextRouteLanding } from '../test-utils/navigation';
import { i18n, setLocale } from '../i18n';

const ADMIN_USER = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local',
};

const USERS = {
  items: [
    {
      id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alpha-fde',
      status: 'active', totp_enabled: false, last_login_at: null, last_activity_at: null,
      onboarding: { state: 'done', step: null, error: null },
    },
    {
      id: 'u2', login: 'nobody', display_name: 'Nobody', role: 'fde', fde_name: null,
      status: 'active', totp_enabled: false, last_login_at: null, last_activity_at: null,
      onboarding: { state: 'done', step: null, error: null },
    },
  ],
};

const SESSIONS_PAGE_1 = {
  items: [
    {
      id: 's-1', project_id: null, cwd: '~/projects/repo-a', title: '修登录页',
      title_source: 'auto', origin: 'human', model: 'gpt-x', status: 'active', last_seq: 90,
      created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-05T00:00:00.000Z',
      active_run_id: null, message_count: 3,
    },
  ],
  next_cursor: '2026-01-05T00:00:00.000Z:s-1',
};

const SESSIONS_PAGE_2 = {
  items: [
    {
      id: 's-2', project_id: null, cwd: '~/projects/repo-b', title: null,
      title_source: 'auto', origin: 'human', model: null, status: 'active', last_seq: 10,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-04T00:00:00.000Z',
      active_run_id: null, message_count: 1,
    },
  ],
  next_cursor: null,
};

// ⚠ 这份夹具**故意不含** `created_at` / `updated_at`：详情端点的 `session` 来自
// `fetchSession()` 的 SELECT 里没有这两列（真机 bug 的根因）。
// 真数据只在列表 `items` 里 ⇒ 夹具与后端一致。
const SESSION_DETAIL = {
  session: {
    id: 's-1', project_id: null, cwd: '~/projects/repo-a', title: '修登录页', title_source: 'auto',
    origin: 'human', model: 'gpt-x', status: 'active', last_seq: 90,
    active_run_id: null, message_count: 3,
    queued_messages: { steering: [], follow_up: [] },
  },
  messages: [
    {
      id: 'm-1', run_id: null, seq: 1, role: 'user', content: '把按钮改蓝',
      synthetic: false, attachments: [], created_at: '2026-01-02T00:00:00.000Z',
    },
  ],
  last_seq: 90,
  next_cursor: null,
};

const TREE_ROOT_PAGE_1 = {
  entries: [{ name: 'repo-a', type: 'dir' }, { name: 'notes.md', type: 'file' }],
  truncated: true,
  // 复合游标：`f:notes.md`（`d`/`f` + 名字）。前端必须原样回传，不拆解、不改写。
  next_after: 'f:notes.md',
};

const TREE_ROOT_PAGE_2 = {
  entries: [{ name: 'zeta', type: 'dir' }],
  truncated: false,
  next_after: null,
};

const TREE_REPO_A = {
  entries: [{ name: 'README.md', type: 'file' }],
  truncated: false,
  next_after: null,
};

const FILE_MD = { name: 'notes.md', path: 'notes.md', kind: 'text', data: '# 标题\n正文' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Handler = (url: string, init?: RequestInit) => Response | undefined | Promise<Response | undefined>;

function defaultHandler(url: string): Response | undefined {
  if (url === '/api/me') return jsonResponse(200, { user: ADMIN_USER });
  if (url === '/api/admin/users') return jsonResponse(200, USERS);
  return undefined;
}

/** 「事件流哨兵」：谁 new EventSource 就计数（只读红线用）。 */
class EventSourceSpy {
  static count = 0;
  constructor() {
    EventSourceSpy.count += 1;
  }
}

async function mountSeat(handler: Handler = () => undefined, path = '/admin/users') {
  const pinia = createPinia();
  setActivePinia(pinia);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return (await handler(url, init)) ?? defaultHandler(url)
      ?? jsonResponse(404, { error: { code: 'not_found', message: 'not found' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  EventSourceSpy.count = 0;
  vi.stubGlobal('EventSource', EventSourceSpy);
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [pinia, router, i18n] }, attachTo: document.body });
  await flushPromises();
  return { wrapper, fetchMock, router };
}

/** 工位端点（`/api/admin/fdes/...`）的全部请求。 */
function seatCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/admin/fdes/'));
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, prefix: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith(prefix));
}

/** 点管理台 tab（零墙钟：先订阅落地，再点，再冲刷）。 */
async function clickTab(router: Router, wrapper: VueWrapper, label: string, awaitSelector: string) {
  const tab = wrapper.findAll('nav a').find((item) => item.text() === label);
  if (!tab) throw new Error(`管理台 tab「${label}」不存在`);
  const landed = nextRouteLanding(router);
  await tab.trigger('click');
  await landed;
  await flushPromises();
  expect(wrapper.find(awaitSelector).exists(), `${awaitSelector} 未挂载`).toBe(true);
  await flushPromises();
}

async function selectFde(wrapper: VueWrapper, fde = 'alpha-fde'): Promise<void> {
  await wrapper.get('[data-test="fde-select"]').setValue(fde);
  await flushPromises();
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
describe('issue #727 判据①：进 tab 才发请求，未选 FDE 不发工位端点', () => {
  it('判据①：停在 /admin/users 时工位端点 0 次；切到「工位内容」tab 后仍然 0 次（没选工位就不该请求）', async () => {
    const { wrapper, fetchMock, router } = await mountSeat();
    try {
      expect(seatCalls(fetchMock)).toHaveLength(0);
      expect(wrapper.find('[data-test="seat-content-page"]').exists()).toBe(false);

      const usersBefore = callsTo(fetchMock, '/api/admin/users').length;
      await clickTab(router, wrapper, '工位内容', '[data-test="seat-content-page"]');
      // 页面挂上了：只读了下拉的数据源（用户表，恰好 1 次），没有读任何 `/api/admin/fdes/*`。
      expect(wrapper.find('[data-test="seat-content-page"]').exists()).toBe(true);
      expect(seatCalls(fetchMock)).toHaveLength(0);
      expect(callsTo(fetchMock, '/api/admin/users').length - usersBefore).toBe(1);
    } finally {
      wrapper.unmount();
    }
  });

  it('判据①：选中 FDE 才发该工位的会话列表与根目录树（各恰好 1 次，路径是 `.`）', async () => {
    const { wrapper, fetchMock } = await mountSeat((url) => {
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions')) {
        return jsonResponse(200, SESSIONS_PAGE_1);
      }
      if (url.startsWith('/api/admin/fdes/alpha-fde/files/tree')) {
        return jsonResponse(200, TREE_ROOT_PAGE_1);
      }
      return undefined;
    }, '/admin/seat-content');
    try {
      expect(seatCalls(fetchMock)).toHaveLength(0);
      await selectFde(wrapper);
      expect(callsTo(fetchMock, '/api/admin/fdes/alpha-fde/sessions?')).toHaveLength(1);
      const tree = callsTo(fetchMock, '/api/admin/fdes/alpha-fde/files/tree');
      expect(tree).toHaveLength(1);
      expect(new URL(String(tree[0]![0]), 'http://x').searchParams.get('path')).toBe('.');
      // 页面顶部同时给出「当前 FDE 名 + 只读标记」。
      expect(wrapper.get('[data-test="current-fde"]').text()).toContain('alpha-fde');
      expect(wrapper.get('[data-test="read-only-badge"]').text()).toBe('只读');
    } finally {
      wrapper.unmount();
    }
  });

  it('判据①：深链 `?fde=` 直接选位并加载；`?fde=` 是不存在的工位时不发工位请求', async () => {
    const deep = await mountSeat((url) => {
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions')) return jsonResponse(200, SESSIONS_PAGE_1);
      if (url.startsWith('/api/admin/fdes/alpha-fde/files/tree')) return jsonResponse(200, TREE_ROOT_PAGE_1);
      return undefined;
    }, '/admin/seat-content?fde=alpha-fde');
    try {
      expect(callsTo(deep.fetchMock, '/api/admin/fdes/alpha-fde/sessions?')).toHaveLength(1);
      expect(deep.wrapper.find('[data-test="session-row"]').exists()).toBe(true);
    } finally {
      deep.wrapper.unmount();
    }

    const typo = await mountSeat(undefined, '/admin/seat-content?fde=nope');
    try {
      expect(seatCalls(typo.fetchMock)).toHaveLength(0);
      expect(typo.wrapper.find('[data-test="empty-state"]').exists()).toBe(true);
    } finally {
      typo.wrapper.unmount();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('issue #727 判据②：只读红线（全程 GET、不碰 `/pv/`、不建 EventSource）', () => {
  it('判据②：选 FDE → 点会话 → 点文件 → 两次「加载更多」的全流程里，所有 fetch 都是 GET', async () => {
    const { wrapper, fetchMock } = await mountSeat((url) => {
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions/s-1/events/history')) {
        return jsonResponse(200, { events: [], next_cursor: null });
      }
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions/s-1')) {
        return jsonResponse(200, SESSION_DETAIL);
      }
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions?')) {
        return url.includes('cursor=') ? jsonResponse(200, SESSIONS_PAGE_2) : jsonResponse(200, SESSIONS_PAGE_1);
      }
      if (url.startsWith('/api/admin/fdes/alpha-fde/files/tree')) {
        return url.includes('after=') ? jsonResponse(200, TREE_ROOT_PAGE_2)
          : url.includes('path=repo-a') ? jsonResponse(200, TREE_REPO_A)
            : jsonResponse(200, TREE_ROOT_PAGE_1);
      }
      if (url.startsWith('/api/admin/fdes/alpha-fde/file?')) return jsonResponse(200, FILE_MD);
      return undefined;
    }, '/admin/seat-content');
    try {
      await selectFde(wrapper);
      await wrapper.get('[data-test="session-row"]').trigger('click');
      await flushPromises();
      await wrapper.get('[data-test="tree-node"][data-node-path="repo-a/README.md"]').trigger('click');
      await flushPromises();
      await wrapper.get('[data-test="sessions-load-more"]').trigger('click');
      await flushPromises();
      await wrapper.get('[data-test="tree-load-more"]').trigger('click');
      await flushPromises();

      const methods = fetchMock.mock.calls.map(([, init]) =>
        String((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase());
      expect(methods.length).toBeGreaterThan(5);
      expect(methods.filter((m) => m !== 'GET')).toEqual([]);
      const urls = fetchMock.mock.calls.map(([url]) => String(url));
      expect(urls.filter((u) => u.includes('/pv/'))).toEqual([]);
      expect(urls.filter((u) => u.includes('/api/preview-tickets'))).toEqual([]);
      expect(EventSourceSpy.count).toBe(0);
      // 页面上也没有任何写侧按钮（发送 / 停止 / 上传 / 审批）。
      expect(wrapper.find('[data-test="seat-content-page"]').text()).not.toMatch(/上传/);
    } finally {
      wrapper.unmount();
    }
  });

  it('判据②：Office / zip 只给下载，不发任何预览请求（URL 是 `mode=download`）', async () => {
    const { wrapper, fetchMock } = await mountSeat((url) => {
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions?')) return jsonResponse(200, SESSIONS_PAGE_1);
      if (url.startsWith('/api/admin/fdes/alpha-fde/files/tree')) {
        return url.includes('path=repo-a')
          ? jsonResponse(200, { entries: [{ name: 'spec.docx', type: 'file' }], truncated: false, next_after: null })
          : jsonResponse(200, { entries: [{ name: 'repo-a', type: 'dir' }], truncated: false, next_after: null });
      }
      return undefined;
    }, '/admin/seat-content');
    try {
      await selectFde(wrapper);
      await wrapper.get('[data-test="tree-node"][data-node-path="repo-a"]').trigger('click');
      await flushPromises();
      await wrapper.get('[data-test="tree-node"][data-node-path="repo-a/spec.docx"]').trigger('click');
      await flushPromises();

      expect(wrapper.find('[data-test="file-download-only"]').exists()).toBe(true);
      expect(callsTo(fetchMock, '/api/admin/fdes/alpha-fde/file?')).toHaveLength(0);
      const href = wrapper.get('[data-test="file-download"]').attributes('href') ?? '';
      expect(href).toContain('mode=download');
      expect(href).toContain('path=repo-a%2Fspec.docx');
    } finally {
      wrapper.unmount();
    }
  });

  it('判据②：PDF 走 `mode=stream` 的 `<object>`，本页不发这个请求', async () => {
    const { wrapper, fetchMock } = await mountSeat((url) => {
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions?')) return jsonResponse(200, SESSIONS_PAGE_1);
      if (url.startsWith('/api/admin/fdes/alpha-fde/files/tree')) {
        return jsonResponse(200, { entries: [{ name: 'doc.pdf', type: 'file' }], truncated: false, next_after: null });
      }
      return undefined;
    }, '/admin/seat-content');
    try {
      await selectFde(wrapper);
      await wrapper.get('[data-test="tree-node"][data-node-path="doc.pdf"]').trigger('click');
      await flushPromises();
      expect(wrapper.get('[data-test="file-pdf"]').attributes('data')).toBe(
        '/api/admin/fdes/alpha-fde/file?path=doc.pdf&mode=stream',
      );
      expect(callsTo(fetchMock, '/api/admin/fdes/alpha-fde/file?')).toHaveLength(0);
    } finally {
      wrapper.unmount();
    }
  });

  it('判据②：预览失败（413）把服务端 message 原文显示出来，并给下载兜底', async () => {
    const { wrapper } = await mountSeat((url) => {
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions?')) return jsonResponse(200, SESSIONS_PAGE_1);
      if (url.startsWith('/api/admin/fdes/alpha-fde/files/tree')) {
        return jsonResponse(200, { entries: [{ name: 'big.txt', type: 'file' }], truncated: false, next_after: null });
      }
      if (url.startsWith('/api/admin/fdes/alpha-fde/file?')) {
        return jsonResponse(413, { error: { code: 'file_too_large', message: '文件超过预览上限（2MB）' } });
      }
      return undefined;
    }, '/admin/seat-content');
    try {
      await selectFde(wrapper);
      await wrapper.get('[data-test="tree-node"][data-node-path="big.txt"]').trigger('click');
      await flushPromises();
      expect(wrapper.get('[data-test="file-error"]').text()).toContain('文件超过预览上限（2MB）');
      expect(wrapper.get('[data-test="file-download-instead"]').attributes('href')).toContain('mode=download');
    } finally {
      wrapper.unmount();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('issue #727 判据③：点会话 ⇒ 文件树展开并高亮该 cwd 的一级目录', () => {
  it('判据③：cwd=`~/projects/repo-a` 的会话被点后，`repo-a` 节点高亮且其子层已加载', async () => {
    const { wrapper } = await mountSeat((url) => {
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions/s-1/events/history')) {
        return jsonResponse(200, { events: [], next_cursor: null });
      }
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions/s-1')) return jsonResponse(200, SESSION_DETAIL);
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions?')) return jsonResponse(200, SESSIONS_PAGE_1);
      if (url.startsWith('/api/admin/fdes/alpha-fde/files/tree')) {
        return url.includes('path=repo-a') ? jsonResponse(200, TREE_REPO_A) : jsonResponse(200, TREE_ROOT_PAGE_1);
      }
      return undefined;
    }, '/admin/seat-content');
    try {
      await selectFde(wrapper);
      const before = wrapper.get('[data-test="tree-node"][data-node-path="repo-a"]');
      expect(before.attributes('data-highlight')).toBe('0');
      expect(wrapper.find('[data-test="tree-node"][data-node-path="repo-a/README.md"]').exists()).toBe(false);

      await wrapper.get('[data-test="session-row"]').trigger('click');
      await flushPromises();

      const after = wrapper.get('[data-test="tree-node"][data-node-path="repo-a"]');
      expect(after.attributes('data-highlight')).toBe('1');
      // 展开 = 这一层的子节点已渲染（一级即可，不展开到文件内容）。
      expect(wrapper.find('[data-test="tree-node"][data-node-path="repo-a/README.md"]').exists()).toBe(true);
      // 右栏同时给出面包屑与元信息（消息数取 session.message_count）。
      expect(wrapper.text()).toContain('修登录页');
      expect(wrapper.get('[data-test="meta-cwd"]').text()).toContain('~/projects/repo-a');
      expect(wrapper.get('[data-test="meta-messages"]').text()).toContain('3');
    } finally {
      wrapper.unmount();
    }
  });

  it('判据③：cwd 形状不符（不是 `~/projects/<name>`）时不高亮、不报错', async () => {
    const odd = JSON.parse(JSON.stringify(SESSION_DETAIL));
    odd.session.cwd = '/var/tmp/other';
    const { wrapper } = await mountSeat((url) => {
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions/s-1/events/history')) {
        return jsonResponse(200, { events: [], next_cursor: null });
      }
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions/s-1')) return jsonResponse(200, odd);
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions?')) return jsonResponse(200, SESSIONS_PAGE_1);
      if (url.startsWith('/api/admin/fdes/alpha-fde/files/tree')) return jsonResponse(200, TREE_ROOT_PAGE_1);
      return undefined;
    }, '/admin/seat-content');
    try {
      await selectFde(wrapper);
      await wrapper.get('[data-test="session-row"]').trigger('click');
      await flushPromises();
      expect(wrapper.get('[data-test="tree-node"][data-node-path="repo-a"]').attributes('data-highlight')).toBe('0');
    } finally {
      wrapper.unmount();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('issue #727 判据④：两条游标各自原样透传', () => {
  it('判据④：会话「加载更多」把 `next_cursor` 原样放进 `cursor`', async () => {
    const { wrapper, fetchMock } = await mountSeat((url) => {
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions?')) {
        return url.includes('cursor=') ? jsonResponse(200, SESSIONS_PAGE_2) : jsonResponse(200, SESSIONS_PAGE_1);
      }
      if (url.startsWith('/api/admin/fdes/alpha-fde/files/tree')) {
        return jsonResponse(200, { entries: [], truncated: false, next_after: null });
      }
      return undefined;
    }, '/admin/seat-content');
    try {
      await selectFde(wrapper);
      await wrapper.get('[data-test="sessions-load-more"]').trigger('click');
      await flushPromises();
      const pages = callsTo(fetchMock, '/api/admin/fdes/alpha-fde/sessions?');
      expect(pages).toHaveLength(2);
      const cursor = new URL(String(pages[1]![0]), 'http://x').searchParams.get('cursor');
      expect(cursor).toBe(SESSIONS_PAGE_1.next_cursor);
      // 第二页到底 ⇒ 按钮消失，两条会话都在列表里。
      expect(wrapper.findAll('[data-test="session-row"]')).toHaveLength(2);
      expect(wrapper.find('[data-test="sessions-load-more"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  it('判据④：文件树「加载更多」把 `next_after` 复合游标 `f:notes.md` 原样放进 `after`', async () => {
    const { wrapper, fetchMock } = await mountSeat((url) => {
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions?')) return jsonResponse(200, SESSIONS_PAGE_1);
      if (url.startsWith('/api/admin/fdes/alpha-fde/files/tree')) {
        return url.includes('after=') ? jsonResponse(200, TREE_ROOT_PAGE_2) : jsonResponse(200, TREE_ROOT_PAGE_1);
      }
      return undefined;
    }, '/admin/seat-content');
    try {
      await selectFde(wrapper);
      await wrapper.get('[data-test="tree-load-more"]').trigger('click');
      await flushPromises();
      const trees = callsTo(fetchMock, '/api/admin/fdes/alpha-fde/files/tree');
      expect(trees).toHaveLength(2);
      const params = new URL(String(trees[1]![0]), 'http://x').searchParams;
      expect(params.get('after')).toBe('f:notes.md');
      expect(params.get('path')).toBe('.');
      // 续页到底 ⇒ 按钮消失，两层的条目拼在一起（不是替换）。
      const names = wrapper.findAll('[data-test="tree-node"]').map((n) => n.attributes('data-node-path'));
      expect(names).toEqual(expect.arrayContaining(['repo-a', 'notes.md', 'zeta']));
      expect(wrapper.find('[data-test="tree-load-more"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  it('判据④：搜索框回车带 `q`，勾「含已归档」带 `include_archived=1`（关掉时整键不出现）', async () => {
    const { wrapper, fetchMock } = await mountSeat((url) => {
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions?')) return jsonResponse(200, SESSIONS_PAGE_1);
      if (url.startsWith('/api/admin/fdes/alpha-fde/files/tree')) {
        return jsonResponse(200, { entries: [], truncated: false, next_after: null });
      }
      return undefined;
    }, '/admin/seat-content');
    try {
      await selectFde(wrapper);
      const first = new URL(String(callsTo(fetchMock, '/api/admin/fdes/alpha-fde/sessions?')[0]![0]), 'http://x');
      expect(first.searchParams.get('limit')).toBe('50');
      expect(first.searchParams.has('include_archived')).toBe(false);

      await wrapper.get('[data-test="session-search"]').setValue('登录');
      await wrapper.get('[data-test="session-search"]').trigger('keyup.enter');
      await flushPromises();
      const searched = callsTo(fetchMock, '/api/admin/fdes/alpha-fde/sessions?').slice(-1)[0];
      expect(new URL(String(searched![0]), 'http://x').searchParams.get('q')).toBe('登录');

      await wrapper.get('[data-test="include-archived"]').setValue(true);
      await flushPromises();
      const archived = callsTo(fetchMock, '/api/admin/fdes/alpha-fde/sessions?').slice(-1)[0];
      expect(new URL(String(archived![0]), 'http://x').searchParams.get('include_archived')).toBe('1');
    } finally {
      wrapper.unmount();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('issue #727 判据⑥：users 行的「会话/文件」链接带 ?fde=', () => {
  it('判据⑥：有 fde_name 的行渲染链接且 href 指向 seat-content?fde=；没有 fde_name 的行不渲染', async () => {
    const { wrapper } = await mountSeat();
    try {
      const rows = wrapper.findAll('[data-test="user-row"]');
      expect(rows).toHaveLength(2);
      const alice = rows.find((row) => row.text().includes('alice'));
      const nobody = rows.find((row) => row.text().includes('nobody'));
      const link = alice?.find('[data-test="seat-content-link"]');
      expect(link?.exists()).toBe(true);
      // hash 路由（真机）/ memory history（单测）两种 href 形态只差开头的 `#`，
      // 判据只钉住「落在 seat-content 这个地址上 + 带上 `?fde=`」这两件事。
      const href = link?.attributes('href') ?? '';
      expect(href).toContain('/admin/seat-content');
      expect(href).toContain('fde=alpha-fde');
      expect(nobody?.find('[data-test="seat-content-link"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });
});

// ── 真机回访与哨兵 ──
// 真机回访（playwright，管理台 host，FDE=eric）抓到的一格 bug + 防回潮哨兵。
// 两个根因叠在一起：① 元信息行调的键名 `created` 不在语言包里（
// 那里是 `createdAt`）⇒ 印出裸 key；② 详情没那两列 ⇒ 恒为「—」。
// 现在格子的值来自左栏列表项 `sessions.items`，找不到就不给那一格。
// 哨兵一次抓住所有「用了不存在的 key」：parity 用例只比键集合，
// 对这种错是盲的。
describe('issue #727 真机回访：会话元信息行（裸 key 哨兵 + 真数据源）', () => {
  /** 够跑完整页的桩：会话列表 + 详情 + 历史 + 两层目录 + md 文件 JSON。 */
  function fullHandler(url: string): Response | undefined {
    if (url.startsWith('/api/admin/fdes/alpha-fde/sessions/s-1/events/history')) {
      return jsonResponse(200, { events: [], next_cursor: null });
    }
    if (url.startsWith('/api/admin/fdes/alpha-fde/sessions/s-1')) {
      return jsonResponse(200, SESSION_DETAIL);
    }
    if (url.startsWith('/api/admin/fdes/alpha-fde/sessions?')) {
      return jsonResponse(200, SESSIONS_PAGE_1);
    }
    if (url.startsWith('/api/admin/fdes/alpha-fde/files/tree')) {
      // `path=repo-a` 是会话 cwd 那一层（点会话时会被自动展开）。
      return url.includes('path=repo-a')
        ? jsonResponse(200, TREE_REPO_A)
        : jsonResponse(200, TREE_ROOT_PAGE_1);
    }
    if (url.startsWith('/api/admin/fdes/alpha-fde/file?')) {
      return jsonResponse(200, FILE_MD);
    }
    return undefined;
  }

  it('哨兵：整页文本不得出现裸 key `admin.seatContent.`', async () => {
    const { wrapper } = await mountSeat(fullHandler, '/admin/seat-content');
    try {
      await selectFde(wrapper);
      expect(wrapper.text()).not.toContain('admin.seatContent.');

      await wrapper.get('[data-test="session-row"]').trigger('click');
      await flushPromises();
      // 元信息行的标签必须是语言包里的中文，不是键名。
      expect(wrapper.text()).toContain('创建');
      expect(wrapper.text()).toContain('更新');
      expect(wrapper.text()).not.toContain('admin.seatContent.');

      const readme = wrapper.get('[data-test="tree-node"][data-node-path="repo-a/README.md"]');
      await readme.trigger('click');
      await flushPromises();
      expect(wrapper.text()).not.toContain('admin.seatContent.');
    } finally {
      wrapper.unmount();
    }
  });

  it('元信息行：created / updated 取列表项的真值，不是「—」', async () => {
    const { wrapper } = await mountSeat(fullHandler, '/admin/seat-content');
    try {
      await selectFde(wrapper);
      await wrapper.get('[data-test="session-row"]').trigger('click');
      await flushPromises();

      const created = wrapper.get('[data-test="meta-created"]').text();
      const updated = wrapper.get('[data-test="meta-updated"]').text();
      expect(created).toContain('创建');
      expect(created).toContain('2026-01-02T00:00:00.000Z');
      expect(updated).toContain('2026-01-05T00:00:00.000Z');
      // 「—」只留给真的没数据的格子；有列表项时这两格不许拿它兼差。
      expect(created).not.toContain('—');
      expect(updated).not.toContain('—');
    } finally {
      wrapper.unmount();
    }
  });

  it('元信息行：列表里没这条会话 ⇒ 两格整格不渲染', async () => {
    const { wrapper } = await mountSeat((url) => {
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions/s-1/events/history')) {
        return jsonResponse(200, { events: [], next_cursor: null });
      }
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions/s-1')) {
        return jsonResponse(200, SESSION_DETAIL);
      }
      // 列表里只有 s-2：详情拿得到、列表项拿不到（深链直开）。
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions?')) {
        return jsonResponse(200, SESSIONS_PAGE_2);
      }
      if (url.startsWith('/api/admin/fdes/alpha-fde/files/tree')) {
        return jsonResponse(200, {
          entries: [{ name: 'repo-a', type: 'dir' }],
          truncated: false,
          next_after: null,
        });
      }
      return undefined;
    }, '/admin/seat-content?fde=alpha-fde&session=s-1');
    try {
      // 其余格子照常（详情给得出 cwd 与 message_count）：不是整行没渲染。
      expect(wrapper.get('[data-test="meta-cwd"]').text()).toContain('repo-a');
      expect(wrapper.get('[data-test="meta-messages"]').text()).toContain('3');
      expect(wrapper.find('[data-test="meta-created"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="meta-updated"]').exists()).toBe(false);
      expect(wrapper.text()).not.toContain('admin.seatContent.');
    } finally {
      wrapper.unmount();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 验收补充（本单）：① folder → session 二级菜单（目录过滤 + 双向联动）；
// ② 运行态可见（会话行 / 详情 meta） + 「刷新」按钮。全程仍只读。
// ⚠ 一律走 DOM / fetch 桩，不用 `w.emitted()`。
// ─────────────────────────────────────────────────────────────────────────────
describe('issue #727 补充：会话目录二级菜单 + 运行态 + 刷新（只读）', () => {
  const DIRS = {
    dirs: [
      { name: 'repo-a', cwd: '~/projects/repo-a', running_count: 2, queued_count: 1 },
      { name: 'repo-b', cwd: '~/projects/repo-b', running_count: 0, queued_count: 0 },
      { name: 'repo-c', cwd: '~/projects/repo-c', running_count: 0, queued_count: 3 },
    ],
  };

  // 带 active_run_id 的会话行（非空 = 有活 run）。
  const SESSIONS_RUNNING = {
    items: [
      {
        id: 's-run', project_id: null, cwd: '~/projects/repo-a', title: '在跑的任务',
        title_source: 'auto', origin: 'human', model: 'gpt-x', status: 'active', last_seq: 5,
        created_at: '2026-01-06T00:00:00.000Z', updated_at: '2026-01-06T00:00:00.000Z',
        active_run_id: 'run-99', message_count: 2,
      },
    ],
    next_cursor: null,
  };

  const DETAIL_RUNNING = {
    session: {
      id: 's-run', project_id: null, cwd: '~/projects/repo-a', title: '在跑的任务',
      title_source: 'auto', origin: 'human', model: 'gpt-x', status: 'active', last_seq: 5,
      active_run_id: 'run-99', message_count: 2,
      queued_messages: { steering: [], follow_up: [] },
    },
    messages: [], last_seq: 5, next_cursor: null,
  };

  /** 树根返回 repo-a / repo-b 两个一级目录（够测一级联动）。 */
  const TREE_TWO = {
    entries: [{ name: 'repo-a', type: 'dir' }, { name: 'repo-b', type: 'dir' }],
    truncated: false, next_after: null,
  };

  /** 够跑目录联动全套的桩：dirs + 会话（按 cwd 分）+ 两层树。 */
  function dirHandler(url: string): Response | undefined {
    if (url.startsWith('/api/admin/fdes/alpha-fde/dirs')) return jsonResponse(200, DIRS);
    if (url.startsWith('/api/admin/fdes/alpha-fde/sessions/s-1/events/history')) {
      return jsonResponse(200, { events: [], next_cursor: null });
    }
    if (url.startsWith('/api/admin/fdes/alpha-fde/sessions/s-1')) {
      return jsonResponse(200, SESSION_DETAIL);
    }
    if (url.startsWith('/api/admin/fdes/alpha-fde/sessions?')) {
      return jsonResponse(200, SESSIONS_PAGE_1);
    }
    if (url.startsWith('/api/admin/fdes/alpha-fde/files/tree')) {
      return url.includes('path=repo-a')
        ? jsonResponse(200, TREE_REPO_A)
        : jsonResponse(200, TREE_TWO);
    }
    return undefined;
  }

  /** 最后一条会话列表请求（`sessions?`）的 `cwd` 参数。 */
  function lastSessionsCwd(fetchMock: ReturnType<typeof vi.fn>): string | null {
    const calls = callsTo(fetchMock, '/api/admin/fdes/alpha-fde/sessions?');
    const last = calls[calls.length - 1];
    if (!last) return null;
    return new URL(String(last[0]), 'http://x').searchParams.get('cwd');
  }

  it('目录二级菜单①：目录下拉存在且首项是「全部目录」；选目录后会话请求带 cwd=~/projects/<name>', async () => {
    const { wrapper, fetchMock } = await mountSeat(dirHandler, '/admin/seat-content');
    try {
      await selectFde(wrapper);
      const select = wrapper.get('[data-test="session-dir-select"]');
      const options = select.findAll('option');
      expect(options.length).toBeGreaterThanOrEqual(2);
      expect(options[0]!.attributes('value')).toBe('');
      expect(options[0]!.text()).toContain('全部目录');
      // 计数：repo-a 有 2 运行 / 1 排队 ⇒ 标签里出现；repo-b 两者为 0 ⇒ 只有目录名。
      const labels = options.map((o) => o.text());
      expect(labels.join(' ')).toContain('2 运行');
      expect(labels.join(' ')).toContain('1 排队');
      // 选 repo-a ⇒ 会话请求带 cwd=~/projects/repo-a。
      await select.setValue('~/projects/repo-a');
      await flushPromises();
      expect(lastSessionsCwd(fetchMock)).toBe('~/projects/repo-a');
    } finally {
      wrapper.unmount();
    }
  });

  it('目录二级菜单②：点文件树一级目录节点 ⇒ 会话请求切到该 cwd 且下拉选中态同步', async () => {
    const { wrapper, fetchMock } = await mountSeat(dirHandler, '/admin/seat-content');
    try {
      await selectFde(wrapper);
      expect(lastSessionsCwd(fetchMock)).toBe(null);
      await wrapper.get('[data-test="tree-node"][data-node-path="repo-b"]').trigger('click');
      await flushPromises();
      expect(lastSessionsCwd(fetchMock)).toBe('~/projects/repo-b');
      expect((wrapper.get('[data-test="session-dir-select"]').element as HTMLSelectElement).value)
        .toBe('~/projects/repo-b');
    } finally {
      wrapper.unmount();
    }
  });

  it('目录二级菜单③：点会话时其 cwd 与当前过滤不同 ⇒ 过滤切到它（后续请求带该 cwd）', async () => {
    const { wrapper, fetchMock } = await mountSeat(dirHandler, '/admin/seat-content');
    try {
      await selectFde(wrapper);
      // 初始「全部」：首条会话列表请求不带 cwd。
      expect(lastSessionsCwd(fetchMock)).toBe(null);
      // s-1 的 cwd = ~/projects/repo-a：点它 ⇒ 过滤从「全部」收窄到它。
      await wrapper.get('[data-test="session-row"]').trigger('click');
      await flushPromises();
      expect(lastSessionsCwd(fetchMock)).toBe('~/projects/repo-a');
    } finally {
      wrapper.unmount();
    }
  });

  it('运行态④：会话行 active_run_id 非空 ⇒ 出现 session-running；为空 ⇒ 不出现', async () => {
    const running = await mountSeat((url) => {
      if (url.startsWith('/api/admin/fdes/alpha-fde/dirs')) return jsonResponse(200, DIRS);
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions?')) {
        return jsonResponse(200, SESSIONS_RUNNING);
      }
      if (url.startsWith('/api/admin/fdes/alpha-fde/files/tree')) {
        return jsonResponse(200, TREE_TWO);
      }
      return undefined;
    }, '/admin/seat-content');
    try {
      await selectFde(running.wrapper);
      expect(running.wrapper.find('[data-test="session-row"]').exists()).toBe(true);
      expect(running.wrapper.find('[data-test="session-running"]').exists()).toBe(true);
      expect(running.wrapper.find('[data-test="session-running"]').text()).toContain('运行中');
    } finally {
      running.wrapper.unmount();
    }

    const idle = await mountSeat((url) => {
      if (url.startsWith('/api/admin/fdes/alpha-fde/dirs')) return jsonResponse(200, DIRS);
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions?')) {
        return jsonResponse(200, SESSIONS_PAGE_1);
      }
      if (url.startsWith('/api/admin/fdes/alpha-fde/files/tree')) {
        return jsonResponse(200, TREE_TWO);
      }
      return undefined;
    }, '/admin/seat-content');
    try {
      await selectFde(idle.wrapper);
      expect(idle.wrapper.findAll('[data-test="session-row"]').length).toBeGreaterThan(0);
      expect(idle.wrapper.find('[data-test="session-running"]').exists()).toBe(false);
    } finally {
      idle.wrapper.unmount();
    }
  });

  it('运行态⑤：详情元信息行 active_run_id 非空 ⇒ 出现 meta-running', async () => {
    const { wrapper } = await mountSeat((url) => {
      if (url.startsWith('/api/admin/fdes/alpha-fde/dirs')) return jsonResponse(200, DIRS);
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions/s-run/events/history')) {
        return jsonResponse(200, { events: [], next_cursor: null });
      }
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions/s-run')) {
        return jsonResponse(200, DETAIL_RUNNING);
      }
      if (url.startsWith('/api/admin/fdes/alpha-fde/sessions?')) {
        return jsonResponse(200, SESSIONS_RUNNING);
      }
      if (url.startsWith('/api/admin/fdes/alpha-fde/files/tree')) {
        return jsonResponse(200, TREE_TWO);
      }
      return undefined;
    }, '/admin/seat-content');
    try {
      await selectFde(wrapper);
      await wrapper.get('[data-test="session-row"]').trigger('click');
      await flushPromises();
      expect(wrapper.find('[data-test="meta-running"]').exists()).toBe(true);
      expect(wrapper.text()).not.toContain('admin.seatContent.');
    } finally {
      wrapper.unmount();
    }
  });

  it('运行态⑥：刷新按钮 ⇒ 重取列表与详情各 +1，且全程只有 GET', async () => {
    const { wrapper, fetchMock } = await mountSeat(dirHandler, '/admin/seat-content');
    try {
      await selectFde(wrapper);
      await wrapper.get('[data-test="session-row"]').trigger('click');
      await flushPromises();
      const listUrl = '/api/admin/fdes/alpha-fde/sessions?';
      const detailUrl = '/api/admin/fdes/alpha-fde/sessions/s-1';
      const detailCount = () => fetchMock.mock.calls.filter(([u]) => {
        const s = String(u);
        return s.startsWith(detailUrl) && !s.includes('/events/');
      }).length;
      const beforeList = callsTo(fetchMock, listUrl).length;
      const beforeDetail = detailCount();
      await wrapper.get('[data-test="sessions-refresh"]').trigger('click');
      await flushPromises();
      expect(callsTo(fetchMock, listUrl).length).toBe(beforeList + 1);
      expect(detailCount()).toBe(beforeDetail + 1);
      // 只读红线：刷新全程只有 GET，不碰 `/pv/`，不建 EventSource。
      const methods = fetchMock.mock.calls.map(([, init]) =>
        String((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase());
      expect(methods.filter((m) => m !== 'GET')).toEqual([]);
      const urls = fetchMock.mock.calls.map(([u]) => String(u));
      expect(urls.filter((u) => u.includes('/pv/'))).toEqual([]);
      expect(EventSourceSpy.count).toBe(0);
    } finally {
      wrapper.unmount();
    }
  });
});
