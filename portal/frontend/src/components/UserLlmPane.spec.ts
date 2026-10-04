// per-user LLM 配置 pane 单测（issue #61 P3）：
//   ② 409 active_run_conflict → 展示服务端拒绝原因 + 「确认无影响，强制保存」显式确认按钮；
//      首次提交绝不带 force 字段，点击确认后才带 force=true 重试（不静默 force）。
//   附带：活跃 run warnbox、供应商下拉联动过滤模型下拉、provision 成功文案。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import UserLlmPane from './UserLlmPane.vue';
import type { AdminUser, GitHost, LlmProvider } from '../stores/admin';
import { i18n, setLocale } from '../i18n';

const FDE_USER = {
  id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', status: 'active',
  totp_enabled: true, last_login_at: null,
} as AdminUser;

const PROVIDERS = [
  {
    id: 'p1', name: 'openai', base_url: 'https://api.openai.com/v1',
    models: [
      { id: 'm1', provider_id: 'p1', model_id: 'gpt-4o', name: 'GPT-4o', type: 'text', tool_calling: true, context_window: 128000, enabled: true },
      { id: 'm2', provider_id: 'p1', model_id: 'text-embedding-3', name: 'Embedding 3', type: 'embedding', tool_calling: false, context_window: null, enabled: true },
      { id: 'm3', provider_id: 'p1', model_id: 'claude-x', name: 'Claude X', type: 'text', tool_calling: false, context_window: null, enabled: true },
    ],
  },
  {
    id: 'p2', name: 'anthropic', base_url: 'https://api.anthropic.com',
    models: [
      { id: 'm4', provider_id: 'p2', model_id: 'claude-sonnet', name: 'Sonnet', type: 'text', tool_calling: true, context_window: 200000, enabled: false },
    ],
  },
] as LlmProvider[];

const GIT_HOSTS: GitHost[] = [
  {
    id: 'gh1',
    name: 'GitHub',
    provider: 'github',
    base_url: 'https://github.com',
    admin_key: null,
    admin_key_configured: false,
    mode: 'per_fde_pat',
    enabled: true,
  },
];

const GET_CONFIG = {
  config: {
    provider_id: 'p1',
    api_key: 'sk•••',
    main: { model_id: 'gpt-4o' },
    embedding: { model_id: 'text-embedding-3' },
    vision: null,
  },
  active_run: true,
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

function putCalls(fetchFn: ReturnType<typeof fetchMock>) {
  return fetchFn.mock.calls.filter(([u, i]) =>
    String(u).includes('/api/admin/fdes/alice/llm') && i?.method === 'PUT');
}

async function mountPane(
  extra?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
  user: AdminUser = FDE_USER,
  gitHosts: GitHost[] = [],
) {
  const fetchFn = fetchMock((url, init) => extra?.(url, init)
    ?? (url === '/api/admin/fdes/alice/llm' && !init?.method
      ? jsonResponse(200, GET_CONFIG)
      : url === '/api/admin/users'
        ? jsonResponse(200, { items: [user] })
      : jsonResponse(404, { error: { code: 'not_found', message: 'not found' } })));
  vi.stubGlobal('fetch', fetchFn);
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(UserLlmPane, {
    props: { user, providers: PROVIDERS, gitHosts },
    global: { plugins: [pinia, i18n] },
  });
  await flushPromises();
  return { wrapper, fetchFn };
}

beforeEach(() => {
  // issue #101 P3：装配真实 i18n 单例（不 mock t()），每例重置为 zh-CN（既有中文断言逐字不变）。
  localStorage.clear();
  setLocale('zh-CN');
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());

describe('UserLlmPane · LLM 配置表单', () => {
  it('加载 config + active_run：warnbox 与只读虚拟 key 展示；模型下拉按类型/能力过滤并回填', async () => {
    const { wrapper } = await mountPane();
    expect(wrapper.text()).toContain('⚠️ 有活跃 run：更换供应商或 API key 会被服务端拒绝');
    expect(wrapper.find('[data-test="virtual-key"]').text()).toBe('当前虚拟 key：sk•••');
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);

    // 主模型下拉：仅 text 且 tool_calling 的启用模型（m1 gpt-4o；m3 无 tool_calling 被过滤）
    const mainOpts = wrapper.find('[data-test="main-model"]').findAll('option');
    expect(mainOpts.map((o) => o.text())).toEqual(['（不配置）', 'gpt-4o — GPT-4o']);
    expect((wrapper.find('[data-test="main-model"]').element as HTMLSelectElement).value).toBe('m1');

    // embedding 下拉回填 m2；vision 无可选项 → 不配置
    expect((wrapper.find('[data-test="embedding-model"]').element as HTMLSelectElement).value).toBe('m2');
    expect((wrapper.find('[data-test="vision-model"]').element as HTMLSelectElement).value).toBe('');

    // 供应商切到 anthropic：主模型只剩「（不配置）」（其唯一模型未启用）
    await wrapper.find('[data-test="provider-select"]').setValue('p2');
    expect(wrapper.find('[data-test="main-model"]').findAll('option').map((o) => o.text())).toEqual(['（不配置）']);
  });

  it('保存成功：不提交上游 key，展示保存状态和只读的虚拟 key 掩码', async () => {
    const { wrapper, fetchFn } = await mountPane((url, init) => {
      if (String(url).includes('/llm') && init?.method === 'PUT') {
        return jsonResponse(200, { config: { provider_id: 'p1', api_key: 'sk•••', main: { model_id: 'gpt-4o' } } });
      }
      return undefined;
    });
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(wrapper.text()).toContain('已保存：主模型 gpt-4o');
    expect(wrapper.find('[data-test="virtual-key"]').text()).toBe('当前虚拟 key：sk•••');
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);
    const puts = putCalls(fetchFn);
    expect(puts).toHaveLength(1);
    expect('api_key' in JSON.parse(String(puts[0][1]?.body))).toBe(false);
  });

  it('409 active_run_conflict：首次 PUT 不带 force 字段；显式点击「确认无影响，强制保存」才带 force=true 重试', async () => {
    let putCount = 0;
    const { wrapper, fetchFn } = await mountPane((url, init) => {
      if (String(url).includes('/llm') && init?.method === 'PUT') {
        putCount += 1;
        if (putCount === 1) {
          return jsonResponse(409, {
            error: {
              code: 'active_run_conflict',
              message: '该 FDE 有进行中的 run：更换供应商或 API key 会改变运行中 run 的上游/凭据。确认无影响请带 force=true 重试。',
            },
          });
        }
        return jsonResponse(200, { config: { provider_id: 'p1', api_key: 'sk•••', main: { model_id: 'gpt-4o' } } });
      }
      return undefined;
    });

    // ① 首次保存 → 409：展示服务端拒绝原因 + 显式确认按钮（绝不静默 force）
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    const firstPut = putCalls(fetchFn)[0];
    const firstBody = JSON.parse(String(firstPut[1]?.body));
    expect('force' in firstBody).toBe(false); // 首次提交绝不带 force 字段
    expect('api_key' in firstBody).toBe(false);
    expect(wrapper.text()).toContain('已拒绝（409）：该 FDE 有进行中的 run');
    const forceBtn = wrapper.find('[data-test="force-save"]');
    expect(forceBtn.exists()).toBe(true);
    expect(wrapper.text()).not.toContain('已保存：主模型');

    // ② 显式点击确认 → 第二次 PUT 带 force=true → 成功文案
    await forceBtn.trigger('click');
    await flushPromises();
    const secondPut = putCalls(fetchFn)[1];
    expect(JSON.parse(String(secondPut[1]?.body)).force).toBe(true);
    expect(wrapper.text()).toContain('已保存：主模型 gpt-4o');
    expect(wrapper.find('[data-test="force-save"]').exists()).toBe(false);
  });

  it('非 409 错误：普通错误文案，不出现强制保存按钮', async () => {
    const { wrapper } = await mountPane((url, init) => {
      if (String(url).includes('/llm') && init?.method === 'PUT') {
        return jsonResponse(400, { error: { code: 'validation_failed', message: 'fde_name 非法' } });
      }
      return undefined;
    });
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(wrapper.text()).toContain('错误：fde_name 非法');
    expect(wrapper.find('[data-test="force-save"]').exists()).toBe(false);
  });

  it('provision 容器：POST 成功展示 container/network/subnet', async () => {
    const { wrapper, fetchFn } = await mountPane((url, init) => {
      if (String(url).includes('/provision') && init?.method === 'POST') {
        return jsonResponse(200, { fde: 'alice', network: 'fde-alice', subnet: '10.0.0.0/29', container: 'fde-alice' });
      }
      return undefined;
    });
    const buttons = wrapper.findAll('form button');
    await buttons[1].trigger('click'); // provision 容器
    await flushPromises();
    expect(wrapper.text()).toContain('provision 完成：fde-alice（fde-alice 10.0.0.0/29）');
    expect(fetchFn.mock.calls.some(([u, i]) =>
      String(u).includes('/api/admin/fdes/alice/provision') && i?.method === 'POST')).toBe(true);
  });

  it('选择 per_fde_pat host 后录入凭据；token 成功提交后清空且不再显示表单', async () => {
    const { wrapper, fetchFn } = await mountPane((url, init) => {
      if (String(url).includes('/provision') && init?.method === 'POST') {
        return jsonResponse(200, {
          fde: 'alice', network: 'fde-alice', subnet: '10.0.0.0/29', container: 'fde-alice',
          status: 'awaiting_credential',
        });
      }
      if (String(url).endsWith('/git-credential') && init?.method === 'PUT') return jsonResponse(200, {});
      return undefined;
    }, FDE_USER, GIT_HOSTS);

    await wrapper.get('[data-test="git-host-select"]').setValue('gh1');
    await wrapper.findAll('form button')[1].trigger('click');
    await flushPromises();
    const provisionCall = fetchFn.mock.calls.find(([url]) => String(url).includes('/provision'));
    expect(JSON.parse(String(provisionCall?.[1]?.body))).toEqual({ git_host_id: 'gh1' });
    expect(wrapper.find('[data-test="git-credential-form"]').exists()).toBe(true);

    const form = wrapper.get('[data-test="git-credential-form"]');
    await form.findAll('input')[0].setValue('alice-gh');
    await form.findAll('input')[1].setValue('ghp-secret-value');
    await form.trigger('submit.prevent');
    await flushPromises();
    const credentialCall = fetchFn.mock.calls.find(([url, init]) =>
      String(url).endsWith('/git-credential') && init?.method === 'PUT');
    expect(JSON.parse(String(credentialCall?.[1]?.body))).toEqual({
      host: 'github.com',
      username: 'alice-gh',
      token: 'ghp-secret-value',
    });
    expect(wrapper.find('[data-test="git-credential-form"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('ghp-secret-value');
    expect(wrapper.text()).toContain('凭据已保存，FDE 账号已启用。');
  });
});

// issue #101 P3：切 English 的双向断言（zh 基线断言在上面各用例中逐字未改）。
describe('UserLlmPane · 语言切换（issue #101 P3）', () => {
  it('切 English：表单标签/占位符/选项/按钮与活跃 run 告警变英文', async () => {
    const { wrapper } = await mountPane();
    setLocale('en');
    await flushPromises();

    expect(wrapper.text()).toContain('⚠️ Active run: changing the provider or API key');
    expect(wrapper.find('[data-test="virtual-key"]').text()).toBe('Current virtual key: sk•••');
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);

    const form = wrapper.find('form').text();
    expect(form).toContain('Provider');
    expect(form).toContain('Main model (text · tool_calling)');
    expect(form).toContain('Embedding (optional)');
    expect(form).toContain('Vision (optional)');
    expect(form).toContain('Save LLM config');
    expect(form).toContain('Provision container');

    // 「（不配置）」选项英文（三个下拉）
    for (const sel of ['main-model', 'embedding-model', 'vision-model']) {
      expect(wrapper.find(`[data-test="${sel}"]`).findAll('option')[0].text()).toBe('(not configured)');
    }
    expect(wrapper.find('[data-test="main-model"]').findAll('option').map((o) => o.text()))
      .toEqual(['(not configured)', 'gpt-4o — GPT-4o']);
  });

  it('切 English：保存成功 / 409 拒绝 / provision 完成 / 错误前缀文案英文', async () => {
    // ① 保存成功；虚拟 key 在独立只读区域展示，不拼入保存状态文案。
    const { wrapper, fetchFn } = await mountPane((url, init) => {
      if (String(url).includes('/llm') && init?.method === 'PUT') {
        return jsonResponse(200, { config: { provider_id: 'p1', api_key: 'sk•••', main: { model_id: 'gpt-4o' } } });
      }
      if (String(url).includes('/provision') && init?.method === 'POST') {
        return jsonResponse(200, { fde: 'alice', network: 'fde-alice', subnet: '10.0.0.0/29', container: 'fde-alice' });
      }
      return undefined;
    });
    setLocale('en');
    await flushPromises();

    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(wrapper.text()).toContain('Saved: main model gpt-4o');
    expect(wrapper.find('[data-test="virtual-key"]').text()).toBe('Current virtual key: sk•••');

    // ② provision 完成文案
    await wrapper.findAll('form button')[1].trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Provisioned: fde-alice (fde-alice 10.0.0.0/29)');
    expect(putCalls(fetchFn)).toHaveLength(1);

    // ③ 409 拒绝前缀英文（其后仍为服务端原文，不译）
    let putCount = 0;
    const conflict = await mountPane((url, init) => {
      if (String(url).includes('/llm') && init?.method === 'PUT') {
        putCount += 1;
        return jsonResponse(409, {
          error: { code: 'active_run_conflict', message: '该 FDE 有进行中的 run：更换供应商或 API key 会改变运行中 run 的上游/凭据。确认无影响请带 force=true 重试。' },
        });
      }
      return undefined;
    });
    setLocale('en');
    await flushPromises();
    await conflict.wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(putCount).toBe(1);
    expect(conflict.wrapper.text()).toContain('Rejected (409): 该 FDE 有进行中的 run');
    expect(conflict.wrapper.find('[data-test="force-save"]').text()).toBe('No impact — force save');

    // ④ 非 409 错误：「Error: 」前缀 + 服务端原文
    const err = await mountPane((url, init) => {
      if (String(url).includes('/llm') && init?.method === 'PUT') {
        return jsonResponse(400, { error: { code: 'validation_failed', message: 'fde_name 非法' } });
      }
      return undefined;
    });
    setLocale('en');
    await flushPromises();
    await err.wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(err.wrapper.text()).toContain('Error: fde_name 非法');
  });
});
