// 管理台「预览端口 / 改块」单测（#246 交付② 单 B）——挂在真实的 FDE 编辑框里（不新造导航）。
// 装配风格照 AdminView.spec.ts（App + createAppRouter(createMemoryHistory) + 按 URL 分派的 fetch 桩）。
// 最重要的一条：**未确认不得发出 POST**（改块是不可撤销的搬迁：旧段 10 条预览域名当场 404）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import App from '../App.vue';
import { createAppRouter } from '../router';
import { i18n, setLocale } from '../i18n';

const ADMIN_USER = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local',
};

const USERS = {
  items: [
    {
      id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alpha-fde',
      status: 'active', totp_enabled: false, last_login_at: null,
      onboarding: { state: 'done', step: null, error: null },
    },
    {
      id: 'u2', login: 'bob', display_name: 'Bob', role: 'fde', fde_name: null,
      status: 'active', totp_enabled: false, last_login_at: null,
      onboarding: { state: 'done', step: null, error: null },
    },
  ],
};

const PORTS = {
  items: [
    {
      id: 'aaaaaaaa-0000-4000-8000-000000002200', port: 22000,
      hostname: 'alpha-fde-p-22000.fde.erix.vip', url: 'http://alpha-fde-p-22000.fde.erix.vip:8090',
      state: 'allocated', scope: 'fde', role: 'spare', exposure: 'private',
    },
    {
      id: 'aaaaaaaa-0000-4000-8000-00002201', port: 22001,
      hostname: 'alpha-fde-p-22001.fde.erix.vip', url: 'http://alpha-fde-p-22001.fde.erix.vip:8090',
      state: 'active', scope: 'fde', role: 'spare', exposure: 'private',
    },
    {
      id: 'aaaaaaaa-0000-4000-8000-00002202', port: 22009,
      hostname: 'alpha-fde-p-22009.fde.erix.vip', url: 'http://alpha-fde-p-22009.fde.erix.vip:8090',
      state: 'active', scope: 'fde', role: 'spare', exposure: 'private',
    },
  ],
};

const MOVED = {
  changed: true,
  fde_name: 'alpha-fde',
  block_start: 22010,
  block_end: 22019,
  ports: [22010, 22011, 22012, 22013, 22014, 22015, 22016, 22017, 22018, 22019],
  released_allocations: 10,
  revoked_grants: 3,
  inserted_allocations: 10,
};

const BLOCK_TAKEN_MESSAGE =
  '预览端口块 22010–22019 已被占用（外来活行端口：22011,22012；占用判据 = 全局活行 state <> \'released\'，'
  + '本 FDE 自己的活行不算冲突）：先释放或改走那段，或换一个整块空闲的对齐起点（22000、22010、…，每段 10 个）';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function defaultHandler(url: string): Response | undefined {
  if (url === '/api/me') return jsonResponse(200, { user: ADMIN_USER });
  if (url === '/api/admin/users') return jsonResponse(200, USERS);
  if (url === '/api/admin/git-hosts') return jsonResponse(200, { items: [] });
  if (url === '/api/admin/llm/providers') return jsonResponse(200, { items: [] });
  if (url === '/api/admin/fdes/alpha-fde/ports') return jsonResponse(200, PORTS);
  return undefined;
}

async function mountAdminPorts(handler: Handler) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init) ?? defaultHandler(url) ?? jsonResponse(404, {
      error: { code: 'not_found', message: 'not found' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createAppRouter(createMemoryHistory());
  await router.push('/admin/users');
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [pinia, router, i18n] }, attachTo: document.body });
  await flushPromises();
  return { wrapper, fetchMock };
}

/** 打开某个登录名的编辑框并切到「预览端口」tab（列表只在这之后才拉）。 */
async function openPortsTab(wrapper: Awaited<ReturnType<typeof mountAdminPorts>>['wrapper'], login: string) {
  const row = wrapper.findAll('[data-test="user-row"]').find((item) => item.text().includes(login));
  if (!row) throw new Error(`${login} 行不存在`);
  await row.get('[data-test="edit-user"]').trigger('click');
  await flushPromises();
  const editor = wrapper.get('[data-test="user-edit-modal"]');
  await editor.get('[data-test="edit-tab-ports"]').trigger('click');
  await flushPromises();
  return editor;
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, method: string, path: string) {
  // api() 的 GET 不显式带 method ⇒ 缺省按 GET 计（与 AdminView.spec 里 `!init?.method` 同口径）。
  return fetchMock.mock.calls.filter(
    ([url, init]) => String(url) === path && ((init as RequestInit | undefined)?.method ?? 'GET') === method,
  );
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

describe('管理台 · FDE 预览端口面板', () => {
  it('tab 默认不拉端口；点开才 GET /api/admin/fdes/:fde/ports 并渲染 3 行', async () => {
    const { wrapper, fetchMock } = await mountAdminPorts(() => undefined);
    try {
      const row = wrapper.findAll('[data-test="user-row"]').find((item) => item.text().includes('alice'))!;
      await row.get('[data-test="edit-user"]').trigger('click');
      await flushPromises();
      expect(callsTo(fetchMock, 'GET', '/api/admin/fdes/alpha-fde/ports')).toHaveLength(0);

      await wrapper.get('[data-test="user-edit-modal"] [data-test="edit-tab-ports"]').trigger('click');
      await flushPromises();
      expect(callsTo(fetchMock, 'GET', '/api/admin/fdes/alpha-fde/ports')).toHaveLength(1);
      const panel = wrapper.get('[data-test="fde-ports-pane"]');
      expect(panel.findAll('[data-test="preview-port-row"]')).toHaveLength(3);
      expect(panel.text()).toContain('alpha-fde-p-22009.fde.erix.vip');
      expect(panel.get('[data-test="block-current-range"]').text()).toContain('22000–22009');
      // 代看别人时也照常给出可签票的入口（admin 对 private 端口可代签）
      expect(panel.findAll('[data-test="preview-port-open"]')).toHaveLength(3);
    } finally {
      wrapper.unmount();
    }
  });

  it('没有 fde_name 的用户：该 tab 说明「没有预览端口」且一个端口请求都不发', async () => {
    const { wrapper, fetchMock } = await mountAdminPorts(() => undefined);
    try {
      await openPortsTab(wrapper, 'bob');
      const panel = wrapper.get('[data-test="edit-panel-ports"]');
      expect(panel.text()).toContain('该用户没有 fde_name');
      expect(wrapper.find('[data-test="fde-ports-pane"]').exists()).toBe(false);
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/ports'))).toHaveLength(0);
    } finally {
      wrapper.unmount();
    }
  });

  it('改块：点提交先出确认（点名旧段与新段、404 与链接会断），**未确认不发 POST**；取消也不发', async () => {
    const { wrapper, fetchMock } = await mountAdminPorts(() => undefined);
    try {
      await openPortsTab(wrapper, 'alice');
      await wrapper.get('[data-test="block-start-input"]').setValue('22010');
      await wrapper.get('[data-test="open-block-move"]').trigger('click');
      await flushPromises();

      const confirm = wrapper.get('[data-test="block-move-confirm"]');
      expect(confirm.attributes('role')).toBe('alertdialog');
      expect(confirm.text()).toContain('把 alpha-fde 的预览端口段从 22000–22009 搬到 22010–22019');
      expect(confirm.text()).toContain('立刻失效');
      expect(confirm.text()).toContain('404');
      expect(confirm.text()).toContain('FDE 手里的旧链接会断');
      expect(callsTo(fetchMock, 'POST', '/api/admin/fdes/alpha-fde/ports/block')).toHaveLength(0);

      await wrapper.get('[data-test="cancel-block-move"]').trigger('click');
      await flushPromises();
      expect(wrapper.find('[data-test="block-move-confirm"]').exists()).toBe(false);
      expect(callsTo(fetchMock, 'POST', '/api/admin/fdes/alpha-fde/ports/block')).toHaveLength(0);
    } finally {
      wrapper.unmount();
    }
  });

  it('输入框里按 Enter 等价于点「改块…」：仍然只出确认，确认前不发 POST', async () => {
    const { wrapper, fetchMock } = await mountAdminPorts(() => undefined);
    try {
      await openPortsTab(wrapper, 'alice');
      await wrapper.get('[data-test="block-start-input"]').setValue('22010');

      await wrapper.get('[data-test="block-start-input"]').trigger('keydown.enter');
      await flushPromises();

      expect(wrapper.find('[data-test="block-move-confirm"]').exists()).toBe(true);
      expect(callsTo(fetchMock, 'POST', '/api/admin/fdes/alpha-fde/ports/block')).toHaveLength(0);
    } finally {
      wrapper.unmount();
    }
  });

  it('确认后发出 { block_start: 22010 }，展示释放/撤销/新分配三个数并重新拉列表', async () => {
    let listCalls = 0;
    const { wrapper, fetchMock } = await mountAdminPorts((url, init) => {
      if (url === '/api/admin/fdes/alpha-fde/ports' && !init?.method) {
        listCalls += 1;
        return jsonResponse(200, listCalls === 1 ? PORTS : {
          items: PORTS.items.map((item) => ({ ...item, port: item.port + 10 })),
        });
      }
      if (url === '/api/admin/fdes/alpha-fde/ports/block' && init?.method === 'POST') {
        return jsonResponse(200, MOVED);
      }
      return undefined;
    });
    try {
      await openPortsTab(wrapper, 'alice');
      expect(listCalls).toBe(1);
      await wrapper.get('[data-test="block-start-input"]').setValue('22010');
      await wrapper.get('[data-test="open-block-move"]').trigger('click');
      await wrapper.get('[data-test="confirm-block-move"]').trigger('click');
      await flushPromises();

      const post = callsTo(fetchMock, 'POST', '/api/admin/fdes/alpha-fde/ports/block')[0];
      expect(JSON.parse(String((post as [string, RequestInit])[1].body))).toEqual({ block_start: 22010 });
      const result = wrapper.get('[data-test="block-move-result"]').text();
      expect(result).toContain('22000–22009 → 22010–22019');
      expect(result).toContain('释放 10 条');
      expect(result).toContain('撤销 3 条');
      expect(result).toContain('新分配 10 条');
      expect(wrapper.get('[data-test="block-move-ports"]').text()).toContain('22010, 22011');
      // 搬迁后立刻重拉：列表段号换成新段，「当前段」也跟着变
      await flushPromises();
      expect(wrapper.get('[data-test="block-current-range"]').text()).toContain('22010–22019');
    } finally {
      wrapper.unmount();
    }
  });

  it('changed:false（幂等空操作）⇒ 明说零写入，不假装搬了家', async () => {
    const { wrapper } = await mountAdminPorts((url, init) => {
      if (url === '/api/admin/fdes/alpha-fde/ports/block' && init?.method === 'POST') {
        return jsonResponse(200, {
          changed: false, fde_name: 'alpha-fde', block_start: 22000, block_end: 22009,
          ports: [22000, 22001, 22002, 22003, 22004, 22005, 22006, 22007, 22008, 22009],
          released_allocations: 0, revoked_grants: 0, inserted_allocations: 0,
        });
      }
      return undefined;
    });
    try {
      await openPortsTab(wrapper, 'alice');
      await wrapper.get('[data-test="block-start-input"]').setValue('22000');
      await wrapper.get('[data-test="open-block-move"]').trigger('click');
      await wrapper.get('[data-test="confirm-block-move"]').trigger('click');
      await flushPromises();
      expect(wrapper.get('[data-test="block-move-result"]').text())
        .toContain('目标段 22000–22009 已经是该 FDE 的现有整块');
      expect(wrapper.get('[data-test="block-move-result"]').text()).toContain('零写入');
    } finally {
      wrapper.unmount();
    }
  });

  it('409 preview_port_block_taken ⇒ 后端 message 全文可见（被占的 22011,22012 出现在 DOM）+ 换段指引', async () => {
    const { wrapper } = await mountAdminPorts((url, init) => {
      if (url === '/api/admin/fdes/alpha-fde/ports/block' && init?.method === 'POST') {
        return jsonResponse(409, { error: { code: 'preview_port_block_taken', message: BLOCK_TAKEN_MESSAGE, retryable: false } });
      }
      return undefined;
    });
    try {
      await openPortsTab(wrapper, 'alice');
      await wrapper.get('[data-test="block-start-input"]').setValue('22010');
      await wrapper.get('[data-test="open-block-move"]').trigger('click');
      await wrapper.get('[data-test="confirm-block-move"]').trigger('click');
      await flushPromises();

      const error = wrapper.get('[data-test="block-move-error"]').text();
      expect(error).toContain('改块失败（preview_port_block_taken）');
      expect(error).toContain(BLOCK_TAKEN_MESSAGE); // 全文，不吞成「操作失败」
      expect(error).toContain('22011,22012');
      expect(wrapper.get('[data-test="block-move-taken-hint"]').text()).toContain('换一个整块空闲的对齐起点');
    } finally {
      wrapper.unmount();
    }
  });

  it('400 validation_failed（details.field=block_start）⇒ 错误指到输入框（aria-invalid + 字段名）', async () => {
    const { wrapper } = await mountAdminPorts((url, init) => {
      if (url === '/api/admin/fdes/alpha-fde/ports/block' && init?.method === 'POST') {
        return jsonResponse(400, {
          error: {
            code: 'validation_failed',
            message: 'block_start 必须是号池 22000–29999 内、按 10 对齐的整数块起点（合法值：22000、22010、…）',
            details: { field: 'block_start' },
          },
        });
      }
      return undefined;
    });
    try {
      await openPortsTab(wrapper, 'alice');
      await wrapper.get('[data-test="block-start-input"]').setValue('22005');
      await wrapper.get('[data-test="open-block-move"]').trigger('click');
      await wrapper.get('[data-test="confirm-block-move"]').trigger('click');
      await flushPromises();

      const fieldError = wrapper.get('[data-test="block-start-field-error"]');
      expect(fieldError.attributes('role')).toBe('alert');
      expect(fieldError.text()).toContain('block_start');
      expect(fieldError.text()).toContain('按 10 对齐的整数块起点');
      const input = wrapper.get('[data-test="block-start-input"]');
      expect(input.attributes('aria-invalid')).toBe('true');
      expect(input.attributes('aria-describedby')).toBe('block-start-error');
    } finally {
      wrapper.unmount();
    }
  });

  it('不是整数的起点：本地拦住并指向 block_start，一次请求都不发（凑不出合法 body 就别发）', async () => {
    const { wrapper, fetchMock } = await mountAdminPorts(() => undefined);
    try {
      await openPortsTab(wrapper, 'alice');
      await wrapper.get('[data-test="block-start-input"]').setValue('');
      await wrapper.get('[data-test="open-block-move"]').trigger('click');
      await flushPromises();
      expect(wrapper.get('[data-test="block-start-field-error"]').text())
        .toContain('block_start 必须是整数');
      expect(wrapper.find('[data-test="block-move-confirm"]').exists()).toBe(false);
      expect(callsTo(fetchMock, 'POST', '/api/admin/fdes/alpha-fde/ports/block')).toHaveLength(0);
    } finally {
      wrapper.unmount();
    }
  });

  it('代看端口时也能当场签票：点「打开预览」POST 列表行的 id 并开新标签', async () => {
    const tabs: Array<{ location: { href: string } }> = [];
    const { wrapper, fetchMock } = await mountAdminPorts((url, init) => {
      if (url === `/api/ports/${PORTS.items[1].id}/preview-ticket` && init?.method === 'POST') {
        return jsonResponse(201, {
          ticket: 'pt_admin_signed',
          url: 'http://alpha-fde-p-22001.fde.erix.vip:8090/?preview_ticket=pt_admin_signed',
          expires_in: 60,
        });
      }
      return undefined;
    });
    vi.stubGlobal('open', vi.fn(() => {
      const tab = { location: { href: '' }, opener: {}, close: vi.fn() };
      tabs.push(tab);
      return tab;
    }));
    try {
      await openPortsTab(wrapper, 'alice');
      await wrapper.findAll('[data-test="preview-port-open"]')[1].trigger('click');
      await flushPromises();
      expect(callsTo(fetchMock, 'POST', `/api/ports/${PORTS.items[1].id}/preview-ticket`)).toHaveLength(1);
      expect(tabs).toHaveLength(1);
      expect(tabs[0]!.location.href).toBe('http://alpha-fde-p-22001.fde.erix.vip:8090/?preview_ticket=pt_admin_signed');
    } finally {
      wrapper.unmount();
    }
  });
});
