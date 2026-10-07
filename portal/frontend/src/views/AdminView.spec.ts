import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import App from '../App.vue';
import { createAppRouter } from '../router';
import { useAdminStore, type AdminUser } from '../stores/admin';
import { useAuthStore } from '../stores/auth';
import { i18n, setLocale } from '../i18n';

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,MOCKQR') },
}));

const ADMIN_USER = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local',
};

const PROVIDERS = {
  items: [
    {
      id: 'p1', name: 'openai', base_url: 'https://api.openai.com/v1',
      models: [
        { id: 'm1', provider_id: 'p1', model_id: 'gpt-4o', name: 'GPT-4o', type: 'text', tool_calling: true, context_window: 128000, max_tokens: 16384, enabled: true, litellm_params: { model: 'openai/gpt-4o' } },
        { id: 'm2', provider_id: 'p1', model_id: 'text-embedding-3', name: 'Embedding 3', type: 'embedding', tool_calling: false, context_window: null, max_tokens: null, enabled: false },
      ],
    },
    { id: 'p2', name: 'anthropic', base_url: 'https://api.anthropic.com', models: [] },
  ],
};
const USERS = {
  items: [
    {
      id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alpha-fde',
      status: 'active', totp_enabled: true, last_login_at: '2026-10-03T12:00:00.000Z',
      onboarding: { state: 'failed', step: 'provision', error: 'Docker unavailable' },
    },
    {
      id: 'u2', login: 'bob', display_name: 'Bob', role: 'fde', fde_name: null,
      status: 'active', totp_enabled: false, last_login_at: null,
      onboarding: { state: 'done', step: null, error: null },
    },
  ],
};
const GIT_HOSTS = {
  items: [
    {
      id: 'gh1', name: 'Gitea', provider: 'gitea', base_url: 'https://git.example.com',
      admin_key: '****4567', admin_key_configured: true, mode: 'minted', enabled: true,
    },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

function fetchMock(handler: Handler) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init) ?? defaultHandler(url);
  });
}

function defaultHandler(url: string): Response {
  if (url === '/api/me') return jsonResponse(200, { user: ADMIN_USER });
  if (url === '/api/admin/llm/providers') return jsonResponse(200, PROVIDERS);
  if (url === '/api/admin/users') return jsonResponse(200, USERS);
  if (url === '/api/admin/git-hosts') return jsonResponse(200, GIT_HOSTS);
  return jsonResponse(404, { error: { code: 'not_found', message: 'not found' } });
}

async function mountAdmin(path = '/admin/users', extra?: Handler) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const fetchFn = fetchMock(extra ?? (() => undefined));
  vi.stubGlobal('fetch', fetchFn);
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  expect(router.currentRoute.value.path).toBe(path === '/admin' ? '/admin/users' : path);
  const wrapper = mount(App, { global: { plugins: [pinia, router, i18n] }, attachTo: document.body });
  await flushPromises();
  return { wrapper, fetchFn, router, pinia };
}

function callsTo(fetchFn: ReturnType<typeof fetchMock>, method: string, path: string) {
  return fetchFn.mock.calls.filter(([url, init]) => String(url) === path && init?.method === method);
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

describe('Admin console routing and layout', () => {
  it('/admin redirects to /admin/users; shared header and current tab are rendered', async () => {
    const { wrapper, router } = await mountAdmin('/admin');
    expect(router.currentRoute.value.path).toBe('/admin/users');
    expect(wrapper.get('h1').text()).toBe('FDE Station 管理台');
    expect(wrapper.get('header').text()).toContain('root（admin）');
    expect(wrapper.get('header').text()).toContain('返回工作台');
    expect(wrapper.get('header').text()).toContain('登出');
    expect(wrapper.find('a[aria-current="page"]').text()).toBe('用户管理');
    wrapper.unmount();
  });

  it('tab links navigate to their routes and opening the saved URL restores the LLM tab', async () => {
    const { wrapper, router, pinia } = await mountAdmin();
    try {
      await wrapper.find('a[href="/admin/llm"]').trigger('click');
      await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/admin/llm'));
      await flushPromises();
      expect(wrapper.find('a[aria-current="page"]').text()).toBe('LLM 管理');

      wrapper.unmount();
      const refreshedRouter = createAppRouter(createMemoryHistory());
      await refreshedRouter.push('/admin/llm');
      await refreshedRouter.isReady();
      const refreshed = mount(App, { global: { plugins: [pinia, refreshedRouter, i18n] }, attachTo: document.body });
      await flushPromises();
      expect(refreshedRouter.currentRoute.value.path).toBe('/admin/llm');
      expect(refreshed.find('a[aria-current="page"]').text()).toBe('LLM 管理');
      refreshed.unmount();
    } finally {
      wrapper.unmount();
    }
  });

  it('repository tab loads and renders configured Git hosts', async () => {
    const { wrapper, fetchFn } = await mountAdmin('/admin/repos');
    expect(wrapper.text()).toContain('Gitea');
    expect(wrapper.text()).toContain('https://git.example.com');
    expect(wrapper.get('[data-test="mode-badge"]').text()).toBe('代铸');
    expect(wrapper.get('[data-test="admin-key-mask"]').text()).toContain('****4567');
    expect(fetchFn.mock.calls.filter(([url]) => String(url) === '/api/admin/git-hosts')).toHaveLength(1);
    wrapper.unmount();
  });
});

describe('AdminReposView · Git host registry', () => {
  it('provider dropdown lists Gitea and GitLab but not GitHub', async () => {
    const { wrapper } = await mountAdmin('/admin/repos');
    try {
      await wrapper.get('[data-test="open-add-git-host"]').trigger('click');
      const providerSelect = wrapper.get('[data-test="git-host-form"] select');
      expect(providerSelect.find('option[value="gitea"]').exists()).toBe(true);
      expect(providerSelect.find('option[value="gitlab"]').exists()).toBe(true);
      expect(providerSelect.find('option[value="github"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  it('adds, edits, toggles, and deletes hosts through modals without exposing admin key', async () => {
    const { wrapper, fetchFn } = await mountAdmin('/admin/repos', (url, init) => {
      if (url === '/api/admin/git-hosts' && init?.method === 'POST') return jsonResponse(201, { host: {} });
      if (url === '/api/admin/git-hosts/gh1' && init?.method === 'PATCH') return jsonResponse(200, { host: {} });
      if (url === '/api/admin/git-hosts/gh1' && init?.method === 'DELETE') return new Response(null, { status: 204 });
      return undefined;
    });
    try {
      await wrapper.get('[data-test="open-add-git-host"]').trigger('click');
      const addForm = wrapper.get('[data-test="git-host-form"]');
      const addInputs = addForm.findAll('input');
      await addInputs[0].setValue('GitLab');
      await addForm.get('select').setValue('gitlab');
      await addInputs[1].setValue('https://gitlab.example.com');
      await addInputs[2].setValue('admin-secret-not-echoed');
      await addForm.trigger('submit.prevent');
      await flushPromises();
      const post = callsTo(fetchFn, 'POST', '/api/admin/git-hosts')[0];
      expect(JSON.parse(String(post[1]?.body))).toEqual({
        name: 'GitLab',
        provider: 'gitlab',
        base_url: 'https://gitlab.example.com',
        admin_key: 'admin-secret-not-echoed',
      });
      expect(wrapper.text()).not.toContain('admin-secret-not-echoed');
      expect(wrapper.find('[role="dialog"]').exists()).toBe(false);

      await wrapper.get('[data-test="edit-git-host"]').trigger('click');
      const editForm = wrapper.get('[data-test="git-host-form"]');
      await editForm.findAll('input')[0].setValue('Gitea renamed');
      await editForm.findAll('input')[1].setValue('https://git-new.example.com');
      await editForm.findAll('input')[2].setValue('new-admin-secret');
      await editForm.trigger('submit.prevent');
      await flushPromises();
      const patch = callsTo(fetchFn, 'PATCH', '/api/admin/git-hosts/gh1')
        .find(([, init]) => String(init?.body).includes('new-admin-secret'));
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
        name: 'Gitea renamed',
        provider: 'gitea',
        base_url: 'https://git-new.example.com',
        admin_key: 'new-admin-secret',
      });

      await wrapper.get('[data-test="toggle-git-host"]').trigger('click');
      await flushPromises();
      const toggle = callsTo(fetchFn, 'PATCH', '/api/admin/git-hosts/gh1')
        .find(([, init]) => JSON.parse(String(init?.body)).enabled === false);
      expect(JSON.parse(String(toggle?.[1]?.body))).toEqual({ enabled: false });

      await wrapper.get('[data-test="delete-git-host"]').trigger('click');
      expect(wrapper.get('[role="dialog"]').text()).toContain('确认删除 Git host「Gitea」？');
      await wrapper.get('[data-test="confirm-delete-git-host"]').trigger('click');
      await flushPromises();
      expect(callsTo(fetchFn, 'DELETE', '/api/admin/git-hosts/gh1')).toHaveLength(1);
      expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });
});

describe('AdminView · LLM 管理', () => {
  it('新增供应商按钮位于 LLM 区块标题行末尾', async () => {
    const { wrapper } = await mountAdmin('/admin/llm');
    const sectionTitle = wrapper.findAll('h2').find((heading) => heading.text() === 'LLM 供应商');
    expect(sectionTitle).toBeDefined();
    const headingRow = sectionTitle!.element.parentElement;
    expect(headingRow).not.toBeNull();
    if (!headingRow) throw new Error('LLM section heading row is missing');

    const trigger = wrapper.get('[data-test="open-add-provider"]');
    expect(headingRow.classList.contains('flex')).toBe(true);
    expect(headingRow.classList.contains('items-center')).toBe(true);
    expect(Array.from(headingRow.children).map((child) => child.tagName)).toEqual(['H2', 'SPAN', 'BUTTON']);
    expect(headingRow.children[1].classList.contains('flex-1')).toBe(true);
    expect(headingRow.lastElementChild).toBe(trigger.element);
    expect(wrapper.get('[data-test="provider-list"]').find('[data-test="open-add-provider"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('默认展开全部供应商；手动折叠后 reload 保留选择并展开新供应商', async () => {
    let providerItems = PROVIDERS.items;
    const { wrapper, pinia } = await mountAdmin('/admin/llm', (url) => {
      if (url === '/api/admin/llm/providers') return jsonResponse(200, { items: providerItems });
      return undefined;
    });
    const store = useAdminStore(pinia);
    expect(store.expandedProviders).toEqual(['p1', 'p2']);
    expect(wrapper.findAll('[data-test="provider-card"]')[0].find('[data-test="model-row"]').exists()).toBe(true);

    store.toggleExpandedProvider('p1');
    providerItems = [
      ...providerItems,
      { id: 'p3', name: 'new-provider', base_url: 'https://new.example/v1', models: [] },
    ];
    await store.loadProviders();
    expect(store.expandedProviders).toEqual(['p2', 'p3']);
    expect(wrapper.findAll('[data-test="provider-card"]')[0].find('[data-test="model-row"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-test="provider-card"]')[2].text()).toContain('new-provider');
    wrapper.unmount();
  });

  it('删除供应商会保留用户的展开状态偏好', async () => {
    let providerItems = PROVIDERS.items;
    const { wrapper, pinia } = await mountAdmin('/admin/llm', (url, init) => {
      if (url === '/api/admin/llm/providers') return jsonResponse(200, { items: providerItems });
      if (url === '/api/admin/llm/providers/p1' && init?.method === 'DELETE') {
        providerItems = providerItems.filter((provider) => provider.id !== 'p1');
        return new Response(null, { status: 204 });
      }
      return undefined;
    });
    const store = useAdminStore(pinia);
    expect(store.expansionTouched).toBe(false);
    await store.removeProvider(store.providers[0]);
    expect(store.expansionTouched).toBe(true);
    expect(store.expandedProviders).toEqual(['p2']);
    wrapper.unmount();
  });

  it('供应商标题不渲染启停状态或按钮，并以确认 modal 执行删除', async () => {
    const { wrapper, fetchFn } = await mountAdmin('/admin/llm', (url, init) => {
      if (url === '/api/admin/llm/providers/p1' && init?.method === 'DELETE') return new Response(null, { status: 204 });
      return undefined;
    });
    const cards = wrapper.findAll('[data-test="provider-card"]');
    expect(cards[0].text()).toContain('openai');
    expect(cards[0].text()).toContain('https://api.openai.com/v1');
    const providerHeader = cards[0].get('[data-test="provider-header"]');
    expect(providerHeader.findAll('button')[0].attributes('data-test')).toBe('open-add-model');
    expect(providerHeader.findAll('button')[1].attributes('data-test')).toBe('toggle-provider-models');
    for (const card of cards) {
      const header = card.get('[data-test="provider-header"]');
      expect(header.text()).not.toMatch(/启用|停用/);
      expect(header.findAll('button').map((button) => button.text()).join(' ')).not.toMatch(/启用|停用/);
    }

    await wrapper.findAll('[data-test="provider-card"]')[0].findAll('button')
      .find((button) => button.text() === '删除')!.trigger('click');
    expect(wrapper.find('[role="dialog"]').text()).toContain('确认删除供应商 openai？其下模型将一并删除。');
    await wrapper.get('[data-test="confirm-delete"]').trigger('click');
    await flushPromises();
    expect(callsTo(fetchFn, 'DELETE', '/api/admin/llm/providers/p1')).toHaveLength(1);
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('新增和编辑供应商可提交上游 API key；留空时不提交 key', async () => {
    const { wrapper, fetchFn } = await mountAdmin('/admin/llm', (url, init) => {
      if (url === '/api/admin/llm/providers' && init?.method === 'POST') return jsonResponse(201, {});
      if (url === '/api/admin/llm/providers/p1' && init?.method === 'PATCH') return jsonResponse(200, {});
      return undefined;
    });

    await wrapper.get('[data-test="open-add-provider"]').trigger('click');
    const addForm = wrapper.get('[data-test="add-provider-form"]');
    await addForm.findAll('input')[0].setValue('new-provider');
    await addForm.findAll('input')[1].setValue('https://llm.example/v1');
    const addKey = addForm.get('[data-test="add-provider-api-key"]');
    expect(addKey.attributes('type')).toBe('password');
    expect(addKey.attributes('autocomplete')).toBe('new-password');
    expect(addKey.attributes('required')).toBeUndefined();
    await addKey.setValue(' sk-upstream-add ');
    await addForm.trigger('submit.prevent');
    await flushPromises();
    expect(JSON.parse(String(callsTo(fetchFn, 'POST', '/api/admin/llm/providers')[0][1]?.body)))
      .toEqual({ name: 'new-provider', base_url: 'https://llm.example/v1', api_key: ' sk-upstream-add ' });
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);

    await wrapper.get('[data-test="open-add-provider"]').trigger('click');
    const addWithoutKey = wrapper.get('[data-test="add-provider-form"]');
    await addWithoutKey.findAll('input')[0].setValue('mock-provider');
    await addWithoutKey.findAll('input')[1].setValue('http://mock-llm/v1');
    await addWithoutKey.trigger('submit.prevent');
    await flushPromises();
    expect(JSON.parse(String(callsTo(fetchFn, 'POST', '/api/admin/llm/providers')[1][1]?.body)))
      .toEqual({ name: 'mock-provider', base_url: 'http://mock-llm/v1' });

    await wrapper.findAll('[data-test="provider-card"]')[0].get('[data-test="edit-provider"]').trigger('click');
    const editForm = wrapper.get('[data-test="edit-provider-form"]');
    expect(editForm.findAll('input')).toHaveLength(2);
    const editKey = editForm.get('[data-test="edit-provider-api-key"]');
    expect(editKey.attributes('type')).toBe('password');
    expect(editKey.attributes('autocomplete')).toBe('new-password');
    expect((editKey.element as HTMLInputElement).value).toBe('');
    await editForm.findAll('input')[0].setValue('https://new.openai.com/v1');
    await editForm.trigger('submit.prevent');
    await flushPromises();
    const patch = callsTo(fetchFn, 'PATCH', '/api/admin/llm/providers/p1').find(
      ([, init]) => JSON.parse(String(init?.body)).base_url === 'https://new.openai.com/v1',
    );
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ base_url: 'https://new.openai.com/v1' });
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);

    await wrapper.findAll('[data-test="provider-card"]')[0].get('[data-test="edit-provider"]').trigger('click');
    const editWithKey = wrapper.get('[data-test="edit-provider-form"]');
    await editWithKey.get('[data-test="edit-provider-api-key"]').setValue('sk-upstream-edit');
    await editWithKey.trigger('submit.prevent');
    await flushPromises();
    const keyedPatch = callsTo(fetchFn, 'PATCH', '/api/admin/llm/providers/p1').find(
      ([, init]) => JSON.parse(String(init?.body)).api_key === 'sk-upstream-edit',
    );
    expect(JSON.parse(String(keyedPatch?.[1]?.body))).toEqual({
      base_url: 'https://api.openai.com/v1', api_key: 'sk-upstream-edit',
    });
  });

  it('模型启停不变；新增和编辑分别保留不可编辑字段并 PATCH 允许字段', async () => {
    const { wrapper, fetchFn } = await mountAdmin('/admin/llm', (url, init) => {
      if (url === '/api/admin/llm/providers/p1/models' && init?.method === 'POST') return jsonResponse(201, {});
      if (url === '/api/admin/llm/models/m1' && init?.method === 'PATCH') return jsonResponse(200, {});
      if (url === '/api/admin/llm/models/m1' && init?.method === 'DELETE') return new Response(null, { status: 204 });
      return undefined;
    });
    const modelRow = wrapper.get('[data-test="model-row"]');
    expect(modelRow.findAll('td')).toHaveLength(7);
    expect(modelRow.findAll('td')[4].text()).toBe('16384');
    expect(wrapper.findAll('[data-test="model-row"]')[1].findAll('td')[4].text()).toBe('—');
    expect(modelRow.text()).not.toContain('gpt-4o');
    await modelRow.findAll('button')[0].trigger('click');
    await flushPromises();
    const toggle = callsTo(fetchFn, 'PATCH', '/api/admin/llm/models/m1').find(
      ([, init]) => JSON.parse(String(init?.body)).enabled === false,
    );
    expect(JSON.parse(String(toggle?.[1]?.body))).toEqual({ enabled: false });

    await wrapper.get('[data-test="open-add-model"]').trigger('click');
    const addForm = wrapper.get('[data-test="add-model-form"]');
    expect(addForm.findAll('input')[0].attributes('required')).toBeDefined();
    await addForm.findAll('input')[0].setValue('gpt-4o-mini');
    const addUpstreamModel = addForm.get('[data-test="add-model-upstream-id"]');
    expect(addUpstreamModel.attributes('required')).toBeDefined();
    expect(addUpstreamModel.attributes('placeholder')).toBe('openai/<model>');
    await addUpstreamModel.setValue('openai/gpt-4o-mini');
    await addForm.findAll('input')[2].setValue('GPT-4o mini');
    const addMaxTokens = addForm.get('[data-test="add-model-max-tokens"]');
    expect(addMaxTokens.attributes('type')).toBe('number');
    expect(addMaxTokens.attributes('min')).toBe('1');
    await addMaxTokens.setValue('2048');
    await addForm.get('select').setValue('text');
    await addForm.find('input[type="checkbox"]').setValue(true);
    await addForm.trigger('submit.prevent');
    await flushPromises();
    const post = callsTo(fetchFn, 'POST', '/api/admin/llm/providers/p1/models')[0];
    expect(JSON.parse(String(post[1]?.body))).toEqual({
      model_id: 'gpt-4o-mini', model: 'openai/gpt-4o-mini', name: 'GPT-4o mini', type: 'text', tool_calling: true, context_window: null, max_tokens: 2048,
    });

    const refreshedRow = wrapper.get('[data-test="model-row"]');
    await refreshedRow.get('[data-test="edit-model"]').trigger('click');
    const editForm = wrapper.get('[data-test="edit-model-form"]');
    expect(editForm.text()).not.toContain('model_id');
    expect(wrapper.get('[role="dialog"]').text()).toContain('编辑模型 GPT-4o');
    const editType = editForm.get('[data-test="edit-model-type"]');
    expect((editType.element as HTMLSelectElement).value).toBe('text');
    const editUpstreamModel = editForm.get('[data-test="edit-model-upstream-id"]');
    expect((editUpstreamModel.element as HTMLInputElement).value).toBe('openai/gpt-4o');
    const editMaxTokens = editForm.get('[data-test="edit-model-max-tokens"]');
    expect(editMaxTokens.attributes('min')).toBe('1');
    expect((editMaxTokens.element as HTMLInputElement).value).toBe('16384');
    await editUpstreamModel.setValue('openai/gpt-4o-edited');
    await editMaxTokens.setValue('4096');
    await editForm.findAll('input')[1].setValue('GPT-4o edited');
    await editForm.findAll('input')[2].setValue('65536');
    await editType.setValue('embedding');
    await editForm.find('input[type="checkbox"]').setValue(false);
    await editForm.trigger('submit.prevent');
    await flushPromises();
    const patch = callsTo(fetchFn, 'PATCH', '/api/admin/llm/models/m1').find(
      ([, init]) => JSON.parse(String(init?.body)).name === 'GPT-4o edited',
    );
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      model: 'openai/gpt-4o-edited', name: 'GPT-4o edited', type: 'embedding', tool_calling: false, context_window: 65536, max_tokens: 4096,
    });

    const deleteButton = wrapper.get('[data-test="model-row"]').findAll('button')
      .find((button) => button.text() === '删除')!;
    await deleteButton.trigger('click');
    expect(wrapper.find('[role="dialog"]').text()).toContain('确认删除模型 GPT-4o？');
    await wrapper.find('[role="dialog"]').findAll('button')
      .find((button) => button.text() === '取消')!.trigger('click');
    expect(callsTo(fetchFn, 'DELETE', '/api/admin/llm/models/m1')).toHaveLength(0);

    await wrapper.get('[data-test="model-row"]').findAll('button')
      .find((button) => button.text() === '删除')!.trigger('click');
    await wrapper.get('[data-test="confirm-delete"]').trigger('click');
    await flushPromises();
    expect(callsTo(fetchFn, 'DELETE', '/api/admin/llm/models/m1')).toHaveLength(1);
  });

  it('编辑模型的上游模型 id 留空时保持不变', async () => {
    const { wrapper, fetchFn } = await mountAdmin('/admin/llm', (url, init) => {
      if (url === '/api/admin/llm/models/m1' && init?.method === 'PATCH') return jsonResponse(200, {});
      return undefined;
    });
    await wrapper.get('[data-test="model-row"]').get('[data-test="edit-model"]').trigger('click');
    const editForm = wrapper.get('[data-test="edit-model-form"]');
    await editForm.get('[data-test="edit-model-upstream-id"]').setValue('');
    await editForm.get('[data-test="edit-model-max-tokens"]').setValue('');
    await editForm.trigger('submit.prevent');
    await flushPromises();
    const patch = callsTo(fetchFn, 'PATCH', '/api/admin/llm/models/m1')[0];
    expect(JSON.parse(String(patch[1]?.body))).not.toHaveProperty('model');
    expect(JSON.parse(String(patch[1]?.body))).not.toHaveProperty('max_tokens');
    wrapper.unmount();
  });

  it('删除请求失败时确认 modal 保持打开并展示错误', async () => {
    const { wrapper } = await mountAdmin('/admin/llm', (url, init) => {
      if (url === '/api/admin/llm/providers/p1' && init?.method === 'DELETE') {
        return jsonResponse(500, { error: { message: 'delete failed' } });
      }
      return undefined;
    });
    const deleteButton = wrapper.findAll('[data-test="provider-card"]')[0].findAll('button')
      .find((button) => button.text() === '删除')!;
    await deleteButton.trigger('click');
    await wrapper.get('[data-test="confirm-delete"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(wrapper.find('[role="dialog"]').text()).toContain('delete failed');
  });
});

describe('Admin modals', () => {
  it('Esc closes the modal, focuses its first input, restores the trigger, and unlocks prior scroll state', async () => {
    const { wrapper } = await mountAdmin('/admin/llm');
    const trigger = wrapper.get('[data-test="open-add-provider"]');
    document.body.style.overflow = 'clip';
    (trigger.element as HTMLElement).focus();
    await trigger.trigger('click');
    await flushPromises();

    const input = wrapper.get('[data-test="add-provider-form"] input').element;
    expect(document.activeElement).toBe(input);
    expect(document.body.style.overflow).toBe('hidden');
    await wrapper.get('[data-test="add-provider-form"] input').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    expect(document.body.style.overflow).toBe('clip');
    wrapper.unmount();
  });

  it('clicking the backdrop closes the modal but clicking its contents does not', async () => {
    const { wrapper } = await mountAdmin('/admin/llm');
    await wrapper.get('[data-test="open-add-provider"]').trigger('click');
    await flushPromises();
    await wrapper.get('[role="dialog"]').trigger('click');
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    await wrapper.get('[data-test="modal-backdrop"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('failed create does not close the form or discard its input', async () => {
    const { wrapper } = await mountAdmin('/admin/llm', (url, init) => {
      if (url === '/api/admin/llm/providers' && init?.method === 'POST') {
        return jsonResponse(500, { error: { message: 'provider create failed' } });
      }
      return undefined;
    });
    await wrapper.get('[data-test="open-add-provider"]').trigger('click');
    const form = wrapper.get('[data-test="add-provider-form"]');
    await form.findAll('input')[0].setValue('kept-name');
    await form.findAll('input')[1].setValue('https://provider.example/v1');
    await form.trigger('submit.prevent');
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(form.text()).toContain('provider create failed');
    expect((wrapper.get('[data-test="add-provider-form"] input').element as HTMLInputElement).value)
      .toBe('kept-name');
    wrapper.unmount();
  });
});

describe('AdminView · FDE 用户', () => {
  it('编辑 modal 展示用户与 LLM 提示、最近登录；新用户成功后展示一次性 TOTP modal', async () => {
    const created = {
      user: { id: 'u3', login: 'carol', display_name: 'Carol', role: 'fde', fde_name: 'carol', status: 'active' },
      totp_uri: 'otpauth://totp/erix-station:carol?secret=JBSWY3DPEHPK3PXP&issuer=erix-station',
      totp_secret: 'JBSWY3DPEHPK3PXP',
    };
    const { wrapper, fetchFn } = await mountAdmin('/admin/users', (url, init) => {
      if (url === '/api/admin/users' && init?.method === 'POST') return jsonResponse(201, created);
      return undefined;
    });
    const list = wrapper.find('[data-test="user-list"]');
    expect(list.text()).toContain('alice');
    expect(list.findAll('[data-test="user-row"]')).toHaveLength(2);
    expect(list.text()).toContain('✓');
    expect(list.findAll('thead th')).toHaveLength(9);
    expect(list.findAll('thead th')[6].text()).toBe('开户 / 下线');
    expect(list.findAll('thead th')[7].text()).toBe('最近登录');
    const rows = list.findAll('[data-test="user-row"]');
    expect(rows[0].findAll('td')).toHaveLength(9);
    expect(rows[0].findAll('td')[6].text()).toContain('失败');
    expect(rows[0].findAll('td')[6].find('span').attributes('title')).toBe('Docker unavailable');
    expect(rows[0].findAll('td')[7].text())
      .toBe(new Date('2026-10-03T12:00:00.000Z').toLocaleString('zh-CN'));
    expect(rows[1].findAll('td')[7].text()).toBe('从未登录');
    expect(rows[0].findAll('button')).toHaveLength(3);
    expect(list.find('[data-test="user-menu-button"]').exists()).toBe(false);
    expect(rows[0].attributes('tabindex')).toBeUndefined();
    await rows[0].trigger('click');
    expect(wrapper.find('[data-test="user-details-modal"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="view-user"]').exists()).toBe(false);
    await rows[1].get('[data-test="edit-user"]').trigger('click');
    await flushPromises();
    const editor = wrapper.get('[data-test="user-edit-modal"]');
    expect(editor.text()).toContain('bob');
    expect((editor.get('[data-test="user-profile-form"] input').element as HTMLInputElement).value).toBe('Bob');
    expect(editor.get('[data-test="edit-tab-profile"]').attributes('aria-selected')).toBe('true');
    await editor.get('[data-test="edit-tab-llm"]').trigger('click');
    expect(editor.get('[data-test="edit-panel-llm"]').text()).toContain('该用户未配置 fde_name，无需 LLM 配置。');
    await editor.get('[aria-label="关闭"]').trigger('click');

    await wrapper.get('[data-test="open-add-user"]').trigger('click');
    const form = wrapper.get('[data-test="add-user-form"]');
    await form.findAll('input')[0].setValue('carol');
    await form.findAll('input')[1].setValue('Carol');
    await form.get('[data-test="generate-password"]').trigger('click');
    const generatedPassword = (form.get('#new-user-password').element as HTMLInputElement).value;
    expect(generatedPassword).toHaveLength(16);
    expect(generatedPassword).toMatch(/[a-z]/);
    expect(generatedPassword).toMatch(/[A-Z]/);
    expect(generatedPassword).toMatch(/[0-9]/);
    await form.get('#new-user-password').setValue('pass123');
    await form.get('[data-test="user-email"]').setValue('carol@example.test');
    await form.get('[data-test="user-fde-name"]').setValue('carol');
    await form.get('[data-test="new-user-git-host"]').setValue('gh1');
    await form.get('[data-test="new-user-llm-provider"]').setValue('p1');
    await form.get('[data-test="new-user-main-model"]').setValue('m1');
    await form.get('[data-test="user-totp-enabled"]').setValue(true);
    await form.trigger('submit.prevent');
    await flushPromises();

    expect(JSON.parse(String(callsTo(fetchFn, 'POST', '/api/admin/users')[0][1]?.body))).toEqual({
      login: 'carol', display_name: 'Carol', password: 'pass123', email: 'carol@example.test',
      fde_name: 'carol', git_host_id: 'gh1',
      llm: { provider_id: 'p1', main_model_id: 'm1', embedding_model_id: null, vision_model_id: null },
      totp_enabled: true,
    });
    const totp = wrapper.get('[data-test="totp-box"]');
    expect(totp.text()).toContain('仅此一次显示');
    expect(totp.text()).toContain(created.totp_uri);
    expect(totp.text()).toContain(created.totp_secret);
    expect(totp.find('img').attributes('src')).toBe('data:image/png;base64,MOCKQR');
    expect(totp.find('[data-test="copy-totp-uri"]').exists()).toBe(true);
    expect(totp.find('[data-test="copy-totp-secret"]').exists()).toBe(true);
    await wrapper.get('[data-test="totp-saved"]').trigger('click');
    expect(wrapper.find('[data-test="totp-box"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('编辑 modal 默认显示资料 tab；四个 tab 可访问切换且保留资料表单输入', async () => {
    const { wrapper } = await mountAdmin('/admin/users', (url) =>
      url === '/api/admin/fdes/alpha-fde/llm'
        ? jsonResponse(200, { config: null, active_run: false })
        : undefined);
    const row = wrapper.findAll('[data-test="user-row"]').find((item) => item.text().includes('alice'));
    if (!row) throw new Error('alice row not found');
    await row.get('[data-test="edit-user"]').trigger('click');

    const editor = wrapper.get('[data-test="user-edit-modal"]');
    const tabNames = ['profile', 'security', 'llm', 'danger'] as const;
    expect(editor.get('[role="tablist"]').classes()).toContain('flex-wrap');
    expect(wrapper.find('[data-test="view-user"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="user-details-modal"]').exists()).toBe(false);
    expect(editor.get('[data-test="edit-panel-profile"]').isVisible()).toBe(true);
    await editor.get('[data-test="user-profile-form"] input').setValue('Edited but not saved');
    setLocale('en');
    await flushPromises();
    expect(editor.get('[data-test="edit-tab-profile"]').text()).toBe('Profile');
    expect(editor.get('[data-test="edit-tab-security"]').text()).toBe('Security');
    expect(editor.get('[data-test="edit-tab-llm"]').text()).toBe('LLM & Repository');
    expect(editor.get('[data-test="edit-tab-danger"]').text()).toBe('Danger zone');
    setLocale('zh-CN');
    await flushPromises();

    for (const name of tabNames) {
      const tab = editor.get(`[data-test="edit-tab-${name}"]`);
      const panel = editor.get(`[data-test="edit-panel-${name}"]`);
      await tab.trigger('click');
      if (name === 'llm') await flushPromises();
      expect(tab.attributes('aria-selected')).toBe('true');
      expect(tab.attributes('aria-controls')).toBe(`edit-panel-${name}`);
      expect(panel.attributes('role')).toBe('tabpanel');
      expect(panel.attributes('aria-labelledby')).toBe(`edit-tab-${name}`);
      expect(panel.isVisible()).toBe(true);
      if (name === 'security') {
        expect(panel.text()).toContain('重置用户密码');
        expect(panel.text()).toContain('TOTP 设置');
      } else if (name === 'llm') {
        await panel.get('[data-test="provider-select"]').setValue('p2');
      }
      for (const otherName of tabNames.filter((candidate) => candidate !== name)) {
        expect(editor.get(`[data-test="edit-tab-${otherName}"]`).attributes('aria-selected')).toBe('false');
        expect(editor.get(`[data-test="edit-panel-${otherName}"]`).isVisible()).toBe(false);
      }
    }

    await editor.get('[data-test="edit-tab-llm"]').trigger('click');
    expect((editor.get('[data-test="edit-panel-llm"] [data-test="provider-select"]').element as HTMLSelectElement).value)
      .toBe('p2');
    await editor.get('[data-test="edit-tab-profile"]').trigger('click');
    expect((editor.get('[data-test="user-profile-form"] input').element as HTMLInputElement).value)
      .toBe('Edited but not saved');
    await editor.get('[data-test="edit-tab-danger"]').trigger('click');
    await editor.get('[aria-label="关闭"]').trigger('click');
    await row.get('[data-test="edit-user"]').trigger('click');
    expect(wrapper.get('[data-test="user-edit-modal"] [data-test="edit-tab-profile"]').attributes('aria-selected'))
      .toBe('true');
    wrapper.unmount();
  });

  it('默认不勾选 TOTP；重激活响应显示提示且不展示一次性盒', async () => {
    const created = {
      user: { id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alpha-fde', status: 'active', totp_enabled: false },
      reactivated: true,
    };
    const { wrapper, fetchFn } = await mountAdmin('/admin/users', (url, init) => {
      if (url === '/api/admin/users' && init?.method === 'POST') return jsonResponse(201, created);
      return undefined;
    });
    try {
      await wrapper.get('[data-test="open-add-user"]').trigger('click');
      const form = wrapper.get('[data-test="add-user-form"]');
      const totpCheckbox = form.get('[data-test="user-totp-enabled"]').element as HTMLInputElement;
      expect(totpCheckbox.checked).toBe(false);
      await form.findAll('input')[0].setValue('dave');
      await form.get('#new-user-password').setValue('pass123');
      await form.get('[data-test="user-email"]').setValue('dave@example.test');
      await form.get('[data-test="user-fde-name"]').setValue('dave');
      await form.get('[data-test="new-user-git-host"]').setValue('gh1');
      await form.get('[data-test="new-user-llm-provider"]').setValue('p1');
      await form.get('[data-test="new-user-main-model"]').setValue('m1');
      await form.trigger('submit.prevent');
      await flushPromises();

      expect(JSON.parse(String(callsTo(fetchFn, 'POST', '/api/admin/users')[0][1]?.body))).toEqual({
        login: 'dave', display_name: '', password: 'pass123', email: 'dave@example.test',
        fde_name: 'dave', git_host_id: 'gh1',
        llm: { provider_id: 'p1', main_model_id: 'm1', embedding_model_id: null, vision_model_id: null },
        totp_enabled: false,
      });
      expect(wrapper.find('[data-test="add-user-form"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="totp-box"]').exists()).toBe(false);
      expect(wrapper.text()).toContain('已重新激活既有 FDE 账号');
    } finally {
      wrapper.unmount();
    }
  });

  it('创建用户表单必须先选择有效主模型；目录不可用时显示错误并禁止提交', async () => {
    const { wrapper, fetchFn, pinia } = await mountAdmin();
    try {
      await wrapper.get('[data-test="open-add-user"]').trigger('click');
      await flushPromises();
      const form = wrapper.get('[data-test="add-user-form"]');
      await form.findAll('input')[0].setValue('no-model');
      await form.get('#new-user-password').setValue('pass123');
      await form.get('[data-test="user-email"]').setValue('no-model@example.test');
      await form.get('[data-test="user-fde-name"]').setValue('no-model');
      await form.get('[data-test="new-user-git-host"]').setValue('gh1');
      const submit = form.get('button[type="submit"]');
      expect((submit.element as HTMLButtonElement).disabled).toBe(true);
      await form.trigger('submit.prevent');
      expect(callsTo(fetchFn, 'POST', '/api/admin/users')).toHaveLength(0);

      await form.get('[data-test="new-user-llm-provider"]').setValue('p1');
      await form.get('[data-test="new-user-main-model"]').setValue('m1');
      expect((submit.element as HTMLButtonElement).disabled).toBe(false);

      const store = useAdminStore(pinia);
      store.providersLoaded = false;
      store.llmErr = 'LiteLLM is unavailable';
      await flushPromises();
      expect(form.find('[role="alert"]').text()).toMatch(/启用或修复|Enable or repair/i);
      expect((submit.element as HTMLButtonElement).disabled).toBe(true);
      await form.trigger('submit.prevent');
      expect(callsTo(fetchFn, 'POST', '/api/admin/users')).toHaveLength(0);
    } finally {
      wrapper.unmount();
    }
  });

  it('在编辑 modal 中绑定或重绑 TOTP 后只展示一次新密钥', async () => {
    const enrolled = {
      user: { ...USERS.items[1], totp_enabled: true },
      totp_uri: 'otpauth://totp/erix-station:bob?secret=TEST_ONLY_TOTP_SEED&issuer=erix-station',
      totp_secret: 'TEST_ONLY_TOTP_SEED',
    };
    const { wrapper, fetchFn } = await mountAdmin('/admin/users', (url, init) => {
      if (url === '/api/admin/users/u2/totp-enroll' && init?.method === 'POST') {
        return jsonResponse(200, enrolled);
      }
      return undefined;
    });
    const bobRow = wrapper.findAll('[data-test="user-row"]').find((row) => row.text().includes('bob'));
    if (!bobRow) throw new Error('bob row not found');
    await bobRow.get('[data-test="edit-user"]').trigger('click');
    const editor = wrapper.get('[data-test="user-edit-modal"]');
    await editor.get('[data-test="edit-tab-security"]').trigger('click');
    expect(editor.text()).toContain('TOTP 设置');
    expect(editor.text()).toContain('绑定 TOTP');
    expect(editor.find('[data-test="confirm-totp-reset"]').exists()).toBe(false);
    expect(callsTo(fetchFn, 'POST', '/api/admin/users/u2/totp-enroll')).toHaveLength(0);

    await editor.get('[data-test="confirm-totp-enroll"]').trigger('click');
    await flushPromises();
    const post = callsTo(fetchFn, 'POST', '/api/admin/users/u2/totp-enroll')[0];
    expect(post).toBeDefined();
    expect(post?.[1]?.body).toBeUndefined();
    const totp = wrapper.get('[data-test="totp-box"]');
    expect(totp.text()).toContain('仅此一次显示');
    expect(totp.text()).toContain(enrolled.totp_uri);
    expect(totp.text()).toContain(enrolled.totp_secret);
    expect(totp.find('img').attributes('src')).toBe('data:image/png;base64,MOCKQR');
    expect(totp.find('[data-test="copy-totp-uri"]').exists()).toBe(true);
    expect(totp.find('[data-test="copy-totp-secret"]').exists()).toBe(true);
    await wrapper.get('[data-test="totp-saved"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="totp-box"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain(enrolled.totp_secret);
    const resumedEditor = wrapper.get('[data-test="user-edit-modal"]');
    expect(resumedEditor.get('[data-test="edit-tab-security"]').attributes('aria-selected')).toBe('true');
    expect(resumedEditor.get('[data-test="edit-panel-security"]').isVisible()).toBe(true);

    const aliceRow = wrapper.findAll('[data-test="user-row"]').find((row) => row.text().includes('alice'));
    if (!aliceRow) throw new Error('alice row not found');
    await resumedEditor.get('[aria-label="关闭"]').trigger('click');
    await aliceRow.get('[data-test="edit-user"]').trigger('click');
    const aliceEditor = wrapper.get('[data-test="user-edit-modal"]');
    await aliceEditor.get('[data-test="edit-tab-security"]').trigger('click');
    expect(aliceEditor.text()).toContain('重绑 TOTP（旧码作废）');
    expect(wrapper.find('[data-test="confirm-totp-reset"]').exists()).toBe(true);
    expect(callsTo(fetchFn, 'POST', '/api/admin/users/u2/totp-enroll')).toHaveLength(1);
    wrapper.unmount();
  });

  it('重置 TOTP 保留编辑 modal 并按最新状态隐藏重置动作', async () => {
    let users = USERS.items.map((user) => ({ ...user }));
    const { wrapper, fetchFn } = await mountAdmin('/admin/users', (url, init) => {
      if (url === '/api/admin/users' && !init?.method) return jsonResponse(200, { items: users });
      if (url === '/api/admin/users/u1/totp-reset' && init?.method === 'POST') {
        users = users.map((user) => user.id === 'u1' ? { ...user, totp_enabled: false } : user);
        return new Response(null, { status: 204 });
      }
      return undefined;
    });
    const aliceRow = wrapper.findAll('[data-test="user-row"]').find((row) => row.text().includes('alice'));
    if (!aliceRow) throw new Error('alice row not found');
    await aliceRow.get('[data-test="edit-user"]').trigger('click');
    const editor = wrapper.get('[data-test="user-edit-modal"]');
    await editor.get('[data-test="edit-tab-security"]').trigger('click');
    expect(editor.text()).toContain('重绑 TOTP（旧码作废）');
    const reset = editor.get('[data-test="confirm-totp-reset"]');
    expect(reset.classes()).toContain('bg-red-700');
    await reset.trigger('click');
    await flushPromises();
    expect(callsTo(fetchFn, 'POST', '/api/admin/users/u1/totp-reset')).toHaveLength(1);
    expect(wrapper.get('[data-test="user-edit-modal"]').text()).toContain('TOTP 已重置');
    expect(wrapper.get('[data-test="user-edit-modal"]').text()).toContain('绑定 TOTP');
    expect(wrapper.find('[data-test="confirm-totp-reset"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('用户资料与密码分区独立提交并各自反馈', async () => {
    const { wrapper, fetchFn } = await mountAdmin('/admin/users', (url, init) => {
      if (url === '/api/admin/users/u1' && init?.method === 'PATCH') return jsonResponse(200, {});
      if (url === '/api/admin/users/u1/reset-password' && init?.method === 'POST') {
        return new Response(null, { status: 204 });
      }
      return undefined;
    });
    const aliceRow = wrapper.findAll('[data-test="user-row"]').find((row) => row.text().includes('alice'));
    if (!aliceRow) throw new Error('alice row not found');
    await aliceRow.get('[data-test="edit-user"]').trigger('click');

    const profileForm = wrapper.get('[data-test="user-profile-form"]');
    await profileForm.findAll('input')[0].setValue('Alice Updated');
    await profileForm.findAll('input')[1].setValue('alpha-renamed');
    await profileForm.trigger('submit.prevent');
    await flushPromises();
    const patch = callsTo(fetchFn, 'PATCH', '/api/admin/users/u1')[0];
    expect(JSON.parse(String(patch[1]?.body))).toEqual({
      display_name: 'Alice Updated', role: 'fde', fde_name: 'alpha-renamed',
    });
    expect(profileForm.text()).toContain('资料已更新');

    await wrapper.get('[data-test="user-edit-modal"] [data-test="edit-tab-security"]').trigger('click');
    const passwordForm = wrapper.get('[data-test="user-password-form"]');
    await passwordForm.get('input').setValue('new-password');
    await passwordForm.trigger('submit.prevent');
    await flushPromises();
    expect(JSON.parse(String(callsTo(fetchFn, 'POST', '/api/admin/users/u1/reset-password')[0][1]?.body)))
      .toEqual({ password: 'new-password' });
    expect(passwordForm.text()).toContain('密码已重置');
    await wrapper.get('[data-test="user-edit-modal"] [data-test="edit-tab-profile"]').trigger('click');
    expect(profileForm.text()).toContain('资料已更新');
    expect(wrapper.find('[data-test="user-edit-modal"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('编辑 modal 的 LLM tab 按用户切换配置面板或无 FDE 提示', async () => {
    const { wrapper } = await mountAdmin('/admin/users', (url) =>
      url === '/api/admin/fdes/alpha-fde/llm'
        ? jsonResponse(200, { config: null, active_run: false })
        : undefined);
    const rows = wrapper.findAll('[data-test="user-row"]');

    await rows[0].trigger('click');
    expect(wrapper.find('[data-test="user-details-modal"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="view-user"]').exists()).toBe(false);

    await rows[0].get('[data-test="edit-user"]').trigger('click');
    const aliceEditor = wrapper.get('[data-test="user-edit-modal"]');
    await aliceEditor.get('[data-test="edit-tab-llm"]').trigger('click');
    await flushPromises();
    expect(aliceEditor.text()).toContain('alice');
    expect((aliceEditor.get('[data-test="user-profile-form"] input').element as HTMLInputElement).value).toBe('Alice');
    expect(aliceEditor.get('[data-test="edit-panel-llm"]').findAll('[data-test="provider-select"]')).toHaveLength(1);
    await aliceEditor.get('[aria-label="关闭"]').trigger('click');

    await rows[1].get('[data-test="edit-user"]').trigger('click');
    const bobEditor = wrapper.get('[data-test="user-edit-modal"]');
    await bobEditor.get('[data-test="edit-tab-llm"]').trigger('click');
    expect(bobEditor.get('[data-test="edit-panel-llm"]').text()).toContain('该用户未配置 fde_name，无需 LLM 配置。');
    expect(bobEditor.findAll('[data-test="provider-select"]')).toHaveLength(0);
    wrapper.unmount();
  });

  it('用户搜索按登录名、显示名和 FDE 名称不区分大小写过滤', async () => {
    const { wrapper } = await mountAdmin();
    const search = wrapper.get('[data-test="user-search"]');
    await search.setValue('ALIce');
    expect(wrapper.findAll('[data-test="user-row"]')).toHaveLength(1);
    expect(wrapper.find('[data-test="user-row"]').text()).toContain('alice');

    await search.setValue('bOB');
    expect(wrapper.findAll('[data-test="user-row"]')).toHaveLength(1);
    expect(wrapper.find('[data-test="user-row"]').text()).toContain('bob');

    await search.setValue('ALPHA-FDE');
    expect(wrapper.findAll('[data-test="user-row"]')).toHaveLength(1);
    expect(wrapper.find('[data-test="user-row"]').text()).toContain('alpha-fde');
    wrapper.unmount();
  });

  it('切换状态向用户 PATCH status 并刷新表格', async () => {
    let users = USERS.items.map((user) => ({ ...user }));
    const { wrapper, fetchFn } = await mountAdmin('/admin/users', (url, init) => {
      if (url === '/api/admin/users' && !init?.method) return jsonResponse(200, { items: users });
      if (url === '/api/admin/users/u1' && init?.method === 'PATCH') {
        const fields = JSON.parse(String(init.body)) as { status: string };
        users = users.map((user) => user.id === 'u1' ? { ...user, ...fields } : user);
        return jsonResponse(200, { user: users[0] });
      }
      return undefined;
    });
    await wrapper.find('[data-test="user-row"] button[aria-label="停用"]').trigger('click');
    await flushPromises();
    const patch = callsTo(fetchFn, 'PATCH', '/api/admin/users/u1')[0];
    expect(JSON.parse(String(patch[1]?.body))).toEqual({ status: 'disabled' });
    expect(wrapper.find('[data-test="user-row"]').text()).toContain('停用');
    expect(wrapper.find('[data-test="user-row"] button[aria-label="启用"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('删除必须输入登录名确认；409 原样显示在确认弹窗与用户行内', async () => {
    const { wrapper, fetchFn } = await mountAdmin('/admin/users', (url, init) => {
      if (url === '/api/admin/users/u1' && init?.method === 'DELETE') {
        return jsonResponse(409, {
          error: { code: 'user_has_active_fde', message: 'user still has an active FDE container' },
        });
      }
      return undefined;
    });
    await wrapper.get('[data-test="user-row"]').get('[data-test="edit-user"]').trigger('click');
    await wrapper.get('[data-test="user-edit-modal"] [data-test="edit-tab-danger"]').trigger('click');
    await wrapper.get('[data-test="open-user-delete"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="user-edit-modal"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="user-delete-modal"]').text()).toContain('账号将立即停用并开始 FDE 下线');
    expect(document.body.style.overflow).toBe('hidden');
    const confirmation = wrapper.get('[data-test="delete-login-confirmation"]');
    const confirmButton = wrapper.get('[data-test="confirm-user-delete"]');
    expect((confirmButton.element as HTMLButtonElement).disabled).toBe(true);
    expect(callsTo(fetchFn, 'DELETE', '/api/admin/users/u1')).toHaveLength(0);

    await confirmation.setValue('alice');
    expect((confirmButton.element as HTMLButtonElement).disabled).toBe(false);
    await confirmButton.trigger('click');
    await flushPromises();
    expect(callsTo(fetchFn, 'DELETE', '/api/admin/users/u1')).toHaveLength(1);
    expect(wrapper.get('[data-test="user-delete-modal"] [role="alert"]').text())
      .toContain('user still has an active FDE container');
    expect(wrapper.find('[data-test="user-list"]').text()).toContain('user still has an active FDE container');
    await wrapper.get('[data-test="user-delete-modal"] button').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="user-delete-modal"]').exists()).toBe(false);
    const resumedEditor = wrapper.get('[data-test="user-edit-modal"]');
    expect(resumedEditor.get('[data-test="edit-tab-danger"]').attributes('aria-selected')).toBe('true');
    expect(resumedEditor.get('[data-test="edit-panel-danger"]').isVisible()).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
    wrapper.unmount();
  });

  it('当前登录者的编辑 modal 不显示删除入口；行内菜单不存在', async () => {
    const self = {
      ...ADMIN_USER,
      status: 'active',
      totp_enabled: true,
      last_login_at: null,
    };
    const { wrapper } = await mountAdmin('/admin/users', (url, init) =>
      url === '/api/admin/users' && !init?.method ? jsonResponse(200, { items: [self] }) : undefined);
    expect(wrapper.find('[data-test="user-menu-button"]').exists()).toBe(false);
    await wrapper.get('[data-test="user-row"]').get('[data-test="edit-user"]').trigger('click');
    const editor = wrapper.get('[data-test="user-edit-modal"]');
    await editor.get('[data-test="edit-tab-danger"]').trigger('click');
    expect(editor.find('[data-test="open-user-delete"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="view-user"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="user-details-modal"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('空列表显示创建引导；用户请求加载中显示三条 skeleton 行', async () => {
    const empty = await mountAdmin('/admin/users', (url, init) =>
      url === '/api/admin/users' && !init?.method ? jsonResponse(200, { items: [] }) : undefined);
    expect(empty.wrapper.find('[data-test="user-list"]').text()).toContain('暂无用户。');
    expect(empty.wrapper.find('[data-test="user-list"] [data-test="open-add-user"]').exists()).toBe(false);
    expect(empty.wrapper.find('[data-test="open-add-user"]').exists()).toBe(true);
    empty.wrapper.unmount();

    let resolveUsers: ((response: Response) => void) | undefined;
    const loading = await mountAdmin('/admin/users', (url, init) =>
      url === '/api/admin/users' && !init?.method
        ? new Promise<Response>((resolve) => { resolveUsers = resolve; })
        : undefined);
    expect(loading.wrapper.get('[data-test="user-skeleton"]').findAll('div')).toHaveLength(3);
    resolveUsers?.(jsonResponse(200, USERS));
    await flushPromises();
    expect(loading.wrapper.find('[data-test="user-skeleton"]').exists()).toBe(false);
    expect(loading.wrapper.findAll('[data-test="user-row"]')).toHaveLength(2);
    loading.wrapper.unmount();
  });

  it('开户必填字段有原生校验；没有可用 Git host 时提示并禁用提交', async () => {
    const { wrapper } = await mountAdmin('/admin/users', (url) =>
      url === '/api/admin/git-hosts' ? jsonResponse(200, { items: [] }) : undefined);
    await wrapper.get('[data-test="open-add-user"]').trigger('click');
    const form = wrapper.get('[data-test="add-user-form"]');
    expect(form.get('[data-test="user-email"]').attributes('type')).toBe('email');
    expect(form.get('[data-test="user-email"]').attributes('required')).toBeDefined();
    expect(form.get('[data-test="user-fde-name"]').attributes('required')).toBeDefined();
    expect(form.get('[data-test="new-user-git-host"]').attributes('required')).toBeDefined();
    expect(form.text()).toContain('没有可用的 Git host');
    expect((form.get('button[type="submit"]').element as HTMLButtonElement).disabled).toBe(true);
    wrapper.unmount();
  });

  it('失败开户状态显示错误并可重试，编辑资料 tab 同样展示状态', async () => {
    type TestUser = Omit<typeof USERS.items[number], 'onboarding'> & {
      onboarding: { state: string; step: string | null; error: string | null };
    };
    let users: TestUser[] = USERS.items.map((user) => ({ ...user }));
    const { wrapper, fetchFn } = await mountAdmin('/admin/users', (url, init) => {
      if (url === '/api/admin/users' && !init?.method) return jsonResponse(200, { items: users });
      if (url === '/api/admin/users/u1/onboard/retry' && init?.method === 'POST') {
        users = users.map((user) => user.id === 'u1'
          ? { ...user, onboarding: { state: 'pending', step: 'provision', error: null } }
          : user);
        return jsonResponse(200, { onboarding: users[0]?.onboarding });
      }
      return undefined;
    });
    const row = wrapper.findAll('[data-test="user-row"]').find((item) => item.text().includes('alice'));
    if (!row) throw new Error('alice row not found');
    expect(row.text()).toContain('失败');
    await row.get('[data-test="edit-user"]').trigger('click');
    const editor = wrapper.get('[data-test="edit-panel-profile"]');
    expect(editor.get('[data-test="profile-onboarding"]').text()).toContain('失败');
    expect(editor.text()).toContain('Docker unavailable');
    expect(editor.findAll('[data-test="retry-onboarding-profile"]')).toHaveLength(1);
    await wrapper.get('[data-test="user-edit-modal"] button[aria-label="关闭"]').trigger('click');

    await row.get('[data-test="retry-onboarding"]').trigger('click');
    await flushPromises();
    expect(callsTo(fetchFn, 'POST', '/api/admin/users/u1/onboard/retry')).toHaveLength(1);
    expect(row.text()).toContain('开户中');
    expect(row.findAll('[data-test="retry-onboarding"]')).toHaveLength(0);
    wrapper.unmount();
  });

  it('整体开户已完成但 LLM 绑定失败时仍显示错误并可重试', async () => {
    let users: AdminUser[] = [{
      id: 'u-llm', login: 'llm-user', display_name: 'LLM User', role: 'fde', fde_name: 'llm-user',
      status: 'awaiting_credential', totp_enabled: false, last_login_at: null,
      onboarding: {
        state: 'awaiting_credential', step: null, error: null,
        llm_binding: { state: 'failed', error: 'LiteLLM virtual-key setup failed (HTTP 502)' },
      },
    }];
    const { wrapper, fetchFn } = await mountAdmin('/admin/users', (url, init) => {
      if (url === '/api/admin/users' && !init?.method) return jsonResponse(200, { items: users });
      if (url === '/api/admin/users/u-llm/onboard/retry' && init?.method === 'POST') {
        users = users.map((user) => ({
          ...user,
          onboarding: {
            state: 'pending', step: 'llm-binding', error: null,
            llm_binding: { state: 'pending', error: null },
          },
        }));
        return jsonResponse(200, { onboarding: users[0]?.onboarding });
      }
      return undefined;
    });
    const row = wrapper.get('[data-test="user-row"]');
    const status = row.get('[data-test="onboarding-status"]');
    expect(status.text()).toMatch(/待凭据\s+·\s+LLM 绑定失败/);
    expect(status.attributes('title'))
      .toBe('LiteLLM virtual-key setup failed (HTTP 502)');
    await row.get('[data-test="retry-onboarding"]').trigger('click');
    await flushPromises();
    expect(callsTo(fetchFn, 'POST', '/api/admin/users/u-llm/onboard/retry')).toHaveLength(1);
    expect(row.text()).toContain('开户中');
    expect(row.find('[data-test="retry-onboarding"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('下线 DELETE 返回 202 后保留用户并显示下线中状态', async () => {
    let users: AdminUser[] = [{
      id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alpha-fde',
      status: 'active',
      totp_enabled: true, last_login_at: '2026-10-03T12:00:00.000Z',
      onboarding: null,
      offboarding: null,
    }];
    const { wrapper, fetchFn } = await mountAdmin('/admin/users', (url, init) => {
      if (url === '/api/admin/users' && !init?.method) return jsonResponse(200, { items: users });
      if (url === '/api/admin/users/u1' && init?.method === 'DELETE') {
        users = users.map((user) => ({
          ...user,
          status: 'disabled',
          offboarding: {
            state: 'pending', step: 'disable-user', error: null, workspace_purge_after: null,
          },
        }));
        return jsonResponse(202, { offboarding: users[0]?.offboarding });
      }
      return undefined;
    });
    const row = wrapper.get('[data-test="user-row"]');
    await row.get('[data-test="edit-user"]').trigger('click');
    await wrapper.get('[data-test="user-edit-modal"] [data-test="edit-tab-danger"]').trigger('click');
    await wrapper.get('[data-test="open-user-delete"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="delete-login-confirmation"]').setValue('alice');
    await wrapper.get('[data-test="confirm-user-delete"]').trigger('click');
    await flushPromises();

    expect(callsTo(fetchFn, 'DELETE', '/api/admin/users/u1')).toHaveLength(1);
    expect(wrapper.findAll('[data-test="user-row"]')).toHaveLength(1);
    expect(row.get('[data-test="offboarding-status"]').text()).toContain('下线中');
    expect(wrapper.text()).toContain('已开始下线；账号立即停用');
    expect(row.text()).toContain('停用');
    wrapper.unmount();
  });

  it('失败下线状态展示失败步骤并可重试', async () => {
    let users: AdminUser[] = [{
      id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alpha-fde',
      status: 'disabled',
      totp_enabled: true, last_login_at: '2026-10-03T12:00:00.000Z',
      onboarding: null,
      offboarding: {
        state: 'failed', step: 'stop-container', error: 'Docker unavailable',
        workspace_purge_after: null,
      },
    }];
    const { wrapper, fetchFn } = await mountAdmin('/admin/users', (url, init) => {
      if (url === '/api/admin/users' && !init?.method) return jsonResponse(200, { items: users });
      if (url === '/api/admin/users/u1/offboarding/retry' && init?.method === 'POST') {
        users = users.map((user) => ({
          ...user,
          offboarding: {
            state: 'pending', step: 'stop-container', error: null, workspace_purge_after: null,
          },
        }));
        return jsonResponse(200, { offboarding: users[0]?.offboarding });
      }
      return undefined;
    });
    const row = wrapper.get('[data-test="user-row"]');
    expect(row.get('[data-test="offboarding-status"]').text()).toContain('下线失败');
    expect(row.get('[data-test="offboarding-status"]').text()).toContain('停止 FDE 容器');
    expect(row.get('[data-test="offboarding-status"]').attributes('title')).toBe('Docker unavailable');
    await row.get('[data-test="retry-offboarding"]').trigger('click');
    await flushPromises();
    expect(callsTo(fetchFn, 'POST', '/api/admin/users/u1/offboarding/retry')).toHaveLength(1);
    expect(row.get('[data-test="offboarding-status"]').text()).toContain('下线中');
    expect(row.find('[data-test="retry-offboarding"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shared header identity continues to update with the English locale', async () => {
    const { wrapper } = await mountAdmin();
    setLocale('en');
    const auth = useAuthStore();
    auth.user = { ...ADMIN_USER, fde_name: 'alice' };
    await flushPromises();
    expect(wrapper.get('h1').text()).toBe('FDE Station Admin Console');
    expect(wrapper.get('header').text()).toContain('root (admin / alice)');
    expect(wrapper.get('header').text()).toContain('← Back to workbench');
    expect(wrapper.find('a[aria-current="page"]').text()).toBe('User management');
    wrapper.unmount();
  });
});
