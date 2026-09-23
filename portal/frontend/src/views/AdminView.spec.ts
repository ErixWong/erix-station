// 管理台组件交互单测（issue #61 P3）：
//   ①供应商卡片渲染 + 启停/删除触发对应 API；
//   ②无 fde_name 用户的提示文案；活跃 run warnbox 在 UserLlmPane.spec 覆盖；
//   ③新增用户成功后一次性 TOTP 盒展示（qrcode mock）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import AdminView from './AdminView.vue';
import { createAppRouter } from '../router';

// qrcode 换 npm 包（P3 要求）：单测固定 data URL，避免真实绘制。
vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,MOCKQR') },
}));

const ADMIN_USER = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local',
};

const PROVIDERS = {
  items: [
    {
      id: 'p1', name: 'openai', base_url: 'https://api.openai.com/v1', enabled: true,
      models: [
        { id: 'm1', provider_id: 'p1', model_id: 'gpt-4o', name: 'GPT-4o', type: 'text', tool_calling: true, context_window: 128000, enabled: true },
        { id: 'm2', provider_id: 'p1', model_id: 'text-embedding-3', name: 'Embedding 3', type: 'embedding', tool_calling: false, context_window: null, enabled: false },
      ],
    },
    { id: 'p2', name: 'anthropic', base_url: 'https://api.anthropic.com', enabled: false, models: [] },
  ],
};
const USERS = {
  items: [
    { id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', status: 'active' },
    { id: 'u2', login: 'bob', display_name: 'Bob', role: 'fde', fde_name: null, status: 'active' },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  });
}

/** 默认 handler：GET providers/users/me 走静态夹具，其余 404（用例自行覆盖）。 */
function defaultHandler(url: string): Response {
  if (url === '/api/me') return jsonResponse(200, { user: ADMIN_USER });
  if (url === '/api/admin/llm/providers') return jsonResponse(200, PROVIDERS);
  if (url === '/api/admin/users') return jsonResponse(200, USERS);
  return jsonResponse(404, { error: { code: 'not_found', message: 'not found' } });
}

async function mountAdmin(extra?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createAppRouter(createMemoryHistory());
  router.push('/admin');
  await router.isReady();
  const fetchFn = fetchMock((url, init) => extra?.(url, init) ?? defaultHandler(url));
  vi.stubGlobal('fetch', fetchFn);
  const wrapper = mount(AdminView, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return { wrapper, fetchFn, router };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('AdminView · LLM 供应商区', () => {
  it('渲染供应商卡片：名称/base_url/启停徽章/模型明细按钮；空态文案对齐旧版', async () => {
    const { wrapper } = await mountAdmin();
    const list = wrapper.find('[data-test="provider-list"]');
    expect(list.text()).toContain('openai');
    expect(list.text()).toContain('https://api.openai.com/v1');
    expect(list.text()).toContain('启用');
    expect(list.text()).toContain('模型明细（2）');
    expect(list.text()).toContain('停用'); // p2 的启停按钮文案（p2.enabled=false）
    // p2 无模型：展开后空态文案
    const p2Card = wrapper.findAll('[data-test="provider-card"]')[1];
    await p2Card.findAll('button')[0].trigger('click'); // 「模型明细（0）」
    await flushPromises();
    expect(wrapper.find('[data-test="provider-list"]').text()).toContain('该供应商下暂无模型');
  });

  it('供应商启停触发 PATCH { enabled: !当前值 }，删除触发 DELETE（confirm 文案保留）', async () => {
    const confirmFn = vi.fn(() => true); // 旧版 confirm 提示
    vi.stubGlobal('confirm', confirmFn);
    const { wrapper, fetchFn } = await mountAdmin();
    // openai 卡片的三个按钮：模型明细 / 停用 / 删除
    const openaiBtns = wrapper.findAll('[data-test="provider-card"]')[0].findAll('button');
    await openaiBtns[1].trigger('click'); // 停用（p1.enabled=true → false）
    await flushPromises();
    const patchCall = fetchFn.mock.calls.find(([u, i]) =>
      String(u).includes('/api/admin/llm/providers/p1') && i?.method === 'PATCH');
    expect(patchCall).toBeTruthy();
    expect(JSON.parse(String(patchCall![1]?.body))).toEqual({ enabled: false });

    await openaiBtns[2].trigger('click'); // 删除
    await flushPromises();
    expect(confirmFn).toHaveBeenCalledWith('确认删除供应商 openai？其下模型将一并删除。');
    const delCall = fetchFn.mock.calls.find(([u, i]) =>
      String(u).includes('/api/admin/llm/providers/p1') && i?.method === 'DELETE');
    expect(delCall).toBeTruthy();
  });

  it('模型明细表渲染 + 模型启停/删除触发对应 API；删除 confirm 取消则不调用', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false)); // 取消删除：DELETE 不得发出
    const { wrapper, fetchFn } = await mountAdmin();
    // 展开 openai 的模型明细
    const openaiCard = wrapper.findAll('[data-test="provider-card"]')[0];
    await openaiCard.findAll('button')[0].trigger('click');
    await flushPromises();
    const detail = wrapper.findAll('[data-test="provider-card"]')[0];
    expect(detail.text()).toContain('model_id');
    expect(detail.text()).toContain('gpt-4o');
    expect(detail.text()).toContain('上下文窗口');
    expect(detail.text()).toContain('128000');

    // 模型行按钮：停用 / 删除
    const modelBtns = detail.findAll('tbody button');
    await modelBtns[0].trigger('click'); // m1 停用
    await flushPromises();
    const patchCall = fetchFn.mock.calls.find(([u, i]) =>
      String(u).includes('/api/admin/llm/models/m1') && i?.method === 'PATCH');
    expect(JSON.parse(String(patchCall![1]?.body))).toEqual({ enabled: false });

    await modelBtns[1].trigger('click'); // 删除（confirm=false → 不调用 DELETE）
    await flushPromises();
    expect(fetchFn.mock.calls.some(([u, i]) =>
      String(u).includes('/api/admin/llm/models/m1') && i?.method === 'DELETE')).toBe(false);
  });

  it('供应商下新增模型表单：POST body 逐字段对齐旧版（context_window 可空、tool_calling 勾选）', async () => {
    const { wrapper, fetchFn } = await mountAdmin();
    const openaiCard = wrapper.findAll('[data-test="provider-card"]')[0];
    await openaiCard.findAll('button')[0].trigger('click'); // 展开
    await flushPromises();
    const detail = wrapper.findAll('[data-test="provider-card"]')[0];
    await detail.find('input[placeholder="gpt-4o"]').setValue('gpt-4o-mini');
    await detail.find('input[placeholder="GPT-4o"]').setValue('GPT-4o mini');
    await detail.find('select').setValue('text');
    await detail.find('input[type="checkbox"]').setValue(true);
    // context_window 留空 → null
    await detail.find('form').trigger('submit.prevent');
    await flushPromises();
    const postCall = fetchFn.mock.calls.find(([u, i]) =>
      String(u).includes('/api/admin/llm/providers/p1/models') && i?.method === 'POST');
    expect(postCall).toBeTruthy();
    expect(JSON.parse(String(postCall![1]?.body))).toEqual({
      model_id: 'gpt-4o-mini', name: 'GPT-4o mini', type: 'text', tool_calling: true, context_window: null,
    });
  });
});

describe('AdminView · FDE 管理区', () => {
  it('用户卡片渲染 login/display_name/role/fde_name/status；无 fde_name 展开显示提示文案', async () => {
    const { wrapper } = await mountAdmin();
    const list = wrapper.find('[data-test="user-list"]');
    expect(list.text()).toContain('alice');
    expect(list.text()).toContain('Alice');
    expect(list.text()).toContain('fde');
    expect(list.text()).toContain('alice'); // fde_name 徽章
    expect(list.text()).toContain('active');
    expect(list.text()).toContain('无 fde_name'); // bob

    // 展开 bob（无 fde_name）：LLM 配置 pane 的提示文案逐字保留
    const bobCard = wrapper.findAll('[data-test="user-card"]')[1];
    await bobCard.find('button').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="user-list"]').text())
      .toContain('该用户未配置 fde_name，无需 LLM 配置。');
  });

  it('新增用户：POST body（fde_name 可空省略）→ 一次性 TOTP 盒（URI/种子/二维码）', async () => {
    const created = {
      user: { id: 'u3', login: 'carol', display_name: 'Carol', role: 'fde', fde_name: 'carol', status: 'active' },
      totp_uri: 'otpauth://totp/erix-station:carol?secret=JBSWY3DPEHPK3PXP&issuer=erix-station',
      totp_secret: 'JBSWY3DPEHPK3PXP',
    };
    const { wrapper, fetchFn } = await mountAdmin((url, init) => {
      if (url === '/api/admin/users' && init?.method === 'POST') return jsonResponse(201, created);
      return undefined;
    });
    const form = wrapper.find('[data-test="add-user-form"]');
    await form.findAll('input')[0].setValue('carol');
    await form.findAll('input')[1].setValue('Carol');
    await form.findAll('input')[2].setValue('pass123');
    await form.findAll('input')[3].setValue('carol');
    await form.trigger('submit.prevent');
    await flushPromises();

    const postCall = fetchFn.mock.calls.find(([u, i]) => u === '/api/admin/users' && i?.method === 'POST');
    expect(JSON.parse(String(postCall![1]?.body))).toEqual({
      login: 'carol', display_name: 'Carol', password: 'pass123', fde_name: 'carol',
    });

    // 一次性 TOTP 盒：URI/种子/二维码 data URL + 「仅此一次显示」文案
    const box = wrapper.find('[data-test="totp-box"]');
    expect(box.exists()).toBe(true);
    expect(box.text()).toContain('仅此一次显示');
    expect(box.text()).toContain(created.totp_uri);
    expect(box.text()).toContain(created.totp_secret);
    expect(box.find('img').attributes('src')).toBe('data:image/png;base64,MOCKQR');
  });

  it('新增用户不带 fde_name 时 body 省略该字段（旧版语义）', async () => {
    const created = {
      user: { id: 'u4', login: 'dave', display_name: '', role: 'fde', fde_name: null, status: 'active' },
      totp_uri: 'otpauth://totp/x',
      totp_secret: 'SECRET',
    };
    const { wrapper, fetchFn } = await mountAdmin((url, init) => {
      if (url === '/api/admin/users' && init?.method === 'POST') return jsonResponse(201, created);
      return undefined;
    });
    const form = wrapper.find('[data-test="add-user-form"]');
    await form.findAll('input')[0].setValue('dave');
    await form.findAll('input')[2].setValue('pass123');
    await form.trigger('submit.prevent');
    await flushPromises();
    const postCall = fetchFn.mock.calls.find(([u, i]) => u === '/api/admin/users' && i?.method === 'POST');
    expect(JSON.parse(String(postCall![1]?.body))).toEqual({
      login: 'dave', display_name: '', password: 'pass123',
    });
  });
});
