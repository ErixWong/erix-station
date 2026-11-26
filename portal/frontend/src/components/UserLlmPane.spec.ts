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
      { id: 'm1', provider_id: 'p1', model_id: 'pk-m1', model_name: 'gpt-4o', name: 'GPT-4o', type: 'text', tool_calling: true, context_window: 128000, enabled: true },
      { id: 'm2', provider_id: 'p1', model_id: 'pk-m2', model_name: 'text-embedding-3', name: 'Embedding 3', type: 'embedding', tool_calling: false, context_window: null, enabled: true },
      { id: 'm3', provider_id: 'p1', model_id: 'pk-m3', model_name: 'claude-x', name: 'Claude X', type: 'text', tool_calling: false, context_window: null, enabled: true },
    ],
  },
  {
    id: 'p2', name: 'anthropic', base_url: 'https://api.anthropic.com',
    models: [
      { id: 'm4', provider_id: 'p2', model_id: 'pk-m4', model_name: 'claude-sonnet', name: 'Sonnet', type: 'text', tool_calling: true, context_window: 200000, enabled: false },
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
    main: { model_id: 'pk-m1', name: 'gpt-4o', type: 'text' },
    embedding: { model_id: 'pk-m2', name: 'text-embedding-3', type: 'embedding' },
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
    expect(wrapper.find('[data-test="virtual-key"] span[title]').attributes('title')).toBe('sk•••');
    expect(wrapper.find('[data-test="virtual-key"] span[title]').classes()).toContain('truncate');
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);

    // 主模型下拉：仅 text 且 tool_calling 的启用模型（m1 gpt-4o；m3 无 tool_calling 被过滤）
    const mainOpts = wrapper.find('[data-test="main-model"]').findAll('option');
    expect(mainOpts.map((o) => o.text())).toEqual(['（不配置）', 'GPT-4o (gpt-4o)']);
    expect((wrapper.find('[data-test="main-model"]').element as HTMLSelectElement).value).toBe('m1');
    expect(wrapper.find('[data-test="main-model"]').attributes('title')).toBe('GPT-4o (gpt-4o)');
    // 回归：主键（model_id = LiteLLM model_info.id，真实环境是 UUID）不得出现在下拉文本/标题里。
    expect(wrapper.find('[data-test="main-model"]').text()).not.toContain('pk-m1');
    expect(wrapper.find('[data-test="embedding-model"]').text()).not.toContain('pk-m2');
    expect(wrapper.find('[data-test="main-model"]').classes()).toContain('truncate');

    // embedding 下拉回填 m2；vision 无可选项 → 不配置
    expect((wrapper.find('[data-test="embedding-model"]').element as HTMLSelectElement).value).toBe('m2');
    expect((wrapper.find('[data-test="vision-model"]').element as HTMLSelectElement).value).toBe('');
    const actionButtons = wrapper.find('form').findAll('button');
    for (const button of actionButtons) {
      expect(button.classes()).toEqual(expect.arrayContaining(['min-h-8', 'px-2.5', 'py-1.5', 'text-sm']));
    }

    // 供应商切到 anthropic：主模型只剩「（不配置）」（其唯一模型未启用）
    await wrapper.find('[data-test="provider-select"]').setValue('p2');
    expect(wrapper.find('[data-test="main-model"]').findAll('option').map((o) => o.text())).toEqual(['（不配置）']);
  });

  it('保存成功：不提交上游 key，展示保存状态和只读的虚拟 key 掩码', async () => {
    const { wrapper, fetchFn } = await mountPane((url, init) => {
      if (String(url).includes('/llm') && init?.method === 'PUT') {
        return jsonResponse(200, { config: { provider_id: 'p1', api_key: 'sk•••', main: { model_id: 'pk-m1', name: 'gpt-4o', type: 'text' } } });
      }
      return undefined;
    });
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(wrapper.text()).toContain('已保存：主模型 GPT-4o (gpt-4o)');
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
        return jsonResponse(200, { config: { provider_id: 'p1', api_key: 'sk•••', main: { model_id: 'pk-m1', name: 'gpt-4o', type: 'text' } } });
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
    expect(wrapper.text()).toContain('已保存：主模型 GPT-4o (gpt-4o)');
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
    expect(wrapper.find('[data-test="virtual-key"]').text()).toContain('Current virtual key:');
    expect(wrapper.find('[data-test="virtual-key"]').text()).toContain('sk•••');
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);

    const form = wrapper.find('form').text();
    expect(form).toContain('Provider');
    expect(form).toContain('Main model');
    expect(form).toContain('text · tool_calling');
    expect(form).toContain('Embedding (optional)');
    expect(form).toContain('Vision (optional)');
    expect(form).toContain('Save LLM config');
    expect(form).toContain('Provision container');

    // 「（不配置）」选项英文（三个下拉）
    for (const sel of ['main-model', 'embedding-model', 'vision-model']) {
      expect(wrapper.find(`[data-test="${sel}"]`).findAll('option')[0].text()).toBe('(not configured)');
    }
    expect(wrapper.find('[data-test="main-model"]').findAll('option').map((o) => o.text()))
      .toEqual(['(not configured)', 'GPT-4o (gpt-4o)']);
  });

  it('切 English：保存成功 / 409 拒绝 / provision 完成 / 错误前缀文案英文', async () => {
    // ① 保存成功；虚拟 key 在独立只读区域展示，不拼入保存状态文案。
    const { wrapper, fetchFn } = await mountPane((url, init) => {
      if (String(url).includes('/llm') && init?.method === 'PUT') {
        return jsonResponse(200, { config: { provider_id: 'p1', api_key: 'sk•••', main: { model_id: 'pk-m1', name: 'gpt-4o', type: 'text' } } });
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
    expect(wrapper.text()).toContain('Saved: main model GPT-4o (gpt-4o)');
    expect(wrapper.find('[data-test="virtual-key"]').text()).toContain('Current virtual key:');
    expect(wrapper.find('[data-test="virtual-key"]').text()).toContain('sk•••');

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

describe('UserLlmPane · 周期额度（#719）', () => {
  const QUOTA = {
    quota: {
      budget_usd: 5, budget_period: '1mo', max_budget: 5, budget_duration: '1mo',
      budget_reset_at: '2026-11-24T16:00:00Z', spend: 1.25, remaining: 3.75, spend_scope: 'period',
    },
  };
  const USAGE = {
    days: [
      { date: '2026-11-22', spend: 2, prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, api_requests: 3 },
      { date: '2026-11-23', spend: 1.5, prompt_tokens: 200, completion_tokens: 100, total_tokens: 300, api_requests: 5 },
    ],
    totals: { spend: 3.5, total_tokens: 450 },
  };

  function quotaProviders(mainPricing: boolean | undefined) {
    return [
      {
        id: 'p1', name: 'openai', base_url: 'https://api.openai.com/v1',
        models: [
          { id: 'm1', provider_id: 'p1', model_id: 'pk-m1', model_name: 'gpt-4o', name: 'GPT-4o', type: 'text', tool_calling: true, context_window: 128000, enabled: true, pricing_configured: mainPricing },
          { id: 'm2', provider_id: 'p1', model_id: 'pk-m2', model_name: 'text-embedding-3', name: 'Embedding 3', type: 'embedding', tool_calling: false, context_window: null, enabled: true, pricing_configured: true },
        ],
      },
    ] as unknown as LlmProvider[];
  }

  async function mountQuota(
    extra?: (url: string, init?: RequestInit) => Response | undefined,
    providers: LlmProvider[] = PROVIDERS,
  ) {
    const fetchFn = fetchMock((url, init) => extra?.(url, init)
      ?? (url === '/api/admin/fdes/alice/llm' && !init?.method
        ? jsonResponse(200, GET_CONFIG)
        : url === '/api/admin/fdes/alice/llm/budget' && !init?.method
          ? jsonResponse(200, QUOTA)
        : url.startsWith('/api/admin/fdes/alice/llm/usage') && !init?.method
          ? jsonResponse(200, USAGE)
        : url === '/api/admin/users'
          ? jsonResponse(200, { items: [FDE_USER] })
          : jsonResponse(404, { error: { code: 'not_found', message: 'not found' } })));
    vi.stubGlobal('fetch', fetchFn);
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(UserLlmPane, {
      props: { user: FDE_USER, providers, gitHosts: [] },
      global: { plugins: [pinia, i18n] },
    });
    await flushPromises();
    return { wrapper, fetchFn };
  }

  const quotaPuts = (fetchFn: ReturnType<typeof fetchMock>) =>
    fetchFn.mock.calls.filter(([u, i]) => String(u).includes('/llm/budget') && i?.method === 'PUT');

  it('渲染本周期已用（spend_scope=period）/ 剩余 / 本地重置时刻；周期下拉默认 1mo；近 30 天表与 UTC 桶注释', async () => {
    const { wrapper } = await mountQuota();
    expect(wrapper.find('[data-test="daily-budget"]').exists()).toBe(true);
    // spend_scope=period ⇒ 标签「本周期已用」
    expect(wrapper.find('[data-test="budget-state"]').text()).toContain('本周期已用');
    expect(wrapper.find('[data-test="budget-spend"]').text()).toBe('1.25');
    expect(wrapper.find('[data-test="budget-remaining"]').text()).toBe('3.75');
    // 周期下拉：默认 1mo（GET budget 回显 budget_period=1mo），两个选项每月/每日
    const periodSel = wrapper.find('[data-test="budget-period"]').element as HTMLSelectElement;
    expect(periodSel.value).toBe('1mo');
    expect(wrapper.find('[data-test="budget-period"]').findAll('option').map((o) => o.text()))
      .toEqual(['未设置', '每月', '每日']);
    // 重置时刻：本地时区格式化（不是原始 ISO 串）
    const expectedReset = new Date('2026-11-24T16:00:00Z').toLocaleString();
    expect(wrapper.find('[data-test="budget-reset"]').text()).toBe(expectedReset);
    expect(wrapper.find('[data-test="budget-reset"]').text()).not.toContain('2026-11-24T16:00:00Z');
    // 近 30 天表：两行 + UTC 日桶说明
    const rows = wrapper.findAll('[data-test="usage-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain('2026-11-22');
    expect(rows[0].text()).toContain('150');
    expect(wrapper.find('[data-test="daily-budget"]').text()).toContain('按 UTC 日分桶，与额度周期无关');
    // 额度回显：GET budget 的 budget_usd 进输入框
    expect((wrapper.find('[data-test="budget-input"]').element as HTMLInputElement).value).toBe('5');
  });

  it('spend_scope=lifetime（无额度）⇒ 已用标签为「累计已用（未设额度）」，不是「本周期已用」', async () => {
    const { wrapper } = await mountQuota((url, init) => {
      if (String(url).includes('/llm/budget') && !init?.method) {
        return jsonResponse(200, { quota: { budget_usd: null, budget_period: null, max_budget: null, budget_duration: null, budget_reset_at: null, spend: 0.084178176, remaining: null, spend_scope: 'lifetime' } });
      }
      return undefined;
    });
    expect(wrapper.find('[data-test="budget-state"]').text()).toContain('累计已用（未设额度）');
    expect(wrapper.find('[data-test="budget-state"]').text()).not.toContain('本周期已用');
    expect(wrapper.find('[data-test="budget-spend"]').text()).toBe('0.084178');   // 显示层截到 6 位小数
  });

  it('保存发出正确 body {budget_usd:number, budget_period}；保存成功后回显', async () => {
    const { wrapper, fetchFn } = await mountQuota((url, init) => {
      if (String(url).includes('/llm/budget') && init?.method === 'PUT') {
        return jsonResponse(200, { quota: { budget_usd: 10, budget_period: '1mo', max_budget: 10, budget_duration: '1mo', budget_reset_at: '2026-11-24T16:00:00Z', spend: 0, remaining: 10, spend_scope: 'period' } });
      }
      return undefined;
    });
    await wrapper.find('[data-test="budget-input"]').setValue('10');
    await wrapper.find('[data-test="budget-period"]').setValue('1mo');
    await wrapper.find('[data-test="budget-save"]').trigger('click');
    await flushPromises();
    const puts = quotaPuts(fetchFn);
    expect(puts).toHaveLength(1);
    expect(JSON.parse(String(puts[0][1]?.body))).toEqual({ budget_usd: 10, budget_period: '1mo' });
    expect(wrapper.find('[data-test="budget-msg"]').text()).toBe('额度已保存');
    // 回显：PUT 响应的 quota.budget_usd=10 回填输入框与剩余
    expect((wrapper.find('[data-test="budget-input"]').element as HTMLInputElement).value).toBe('10');
    expect(wrapper.find('[data-test="budget-remaining"]').text()).toBe('10.00');   // 至少 2 位小数
  });

  it('输入框留空 → 保存发 {budget_usd:null}（清空 = 不限，period 一并清空不发送）', async () => {
    const { wrapper, fetchFn } = await mountQuota((url, init) => {
      if (String(url).includes('/llm/budget') && init?.method === 'PUT') {
        return jsonResponse(200, { quota: { budget_usd: null, budget_period: null, max_budget: null, budget_duration: null, budget_reset_at: null, spend: 0, remaining: null, spend_scope: 'lifetime' } });
      }
      return undefined;
    });
    await wrapper.find('[data-test="budget-input"]').setValue('');
    await wrapper.find('[data-test="budget-save"]').trigger('click');
    await flushPromises();
    const puts = quotaPuts(fetchFn);
    expect(JSON.parse(String(puts[0][1]?.body))).toEqual({ budget_usd: null });
    // 清空后 remaining = null ⇒ 显示「不限」
    expect(wrapper.find('[data-test="budget-remaining"]').text()).toBe('不限');
  });

  it('金额显示：浮点噪声截到 6 位小数、大数至少 2 位；用量表花费同口径', async () => {
    const noisy = {
      quota: {
        budget_usd: 0.5, budget_period: '1mo', max_budget: 0.5, budget_duration: '1mo',
        budget_reset_at: '2026-11-30T16:00:00Z', spend: 0.08440703999999999, remaining: 0.41559296, spend_scope: 'period',
      },
    };
    const { wrapper } = await mountQuota((url, init) => (
      url === '/api/admin/fdes/alice/llm/budget' && !init?.method ? jsonResponse(200, noisy) : undefined
    ));
    expect(wrapper.find('[data-test="budget-spend"]').text()).toBe('0.084407');
    expect(wrapper.find('[data-test="budget-remaining"]').text()).toBe('0.415593');
    // 用量表花费同口径（2 → 2.00、1.5 → 1.50）
    const rows = wrapper.findAll('[data-test="usage-row"]');
    expect(rows[0].text()).toContain('2.00');
    expect(rows[1].text()).toContain('1.50');
  });

  it('未定价警告：已选模型 pricing_configured=false 时出现', async () => {
    const { wrapper } = await mountQuota(undefined, quotaProviders(false));
    expect(wrapper.find('[data-test="unpriced-warning"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="unpriced-warning"]').text()).toContain('未定价');
  });

  it('未定价警告：已选模型都定价（undefined/true）时不出现', async () => {
    const { wrapper } = await mountQuota(undefined, quotaProviders(true));
    expect(wrapper.find('[data-test="unpriced-warning"]').exists()).toBe(false);
    // 默认 PROVIDERS（无 pricing_configured 字段 = 未知）也不告警（只报 === false）
    const dflt = await mountQuota();
    expect(dflt.wrapper.find('[data-test="unpriced-warning"]').exists()).toBe(false);
  });

  it('quota GET 500 ⇒ 显式报错（budget-load-error）：不渲染 budget-state/budget-spend、不伪造 0、不出现「不限」；写控件仍可用', async () => {
    const { wrapper } = await mountQuota((url, init) => {
      if (url === '/api/admin/fdes/alice/llm/budget' && !init?.method) {
        return jsonResponse(500, { error: { code: 'server_error', message: 'gateway down' } });
      }
      return undefined;
    });
    expect(wrapper.find('[data-test="budget-load-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="budget-load-error"]').text()).toContain('无法读取额度');
    expect(wrapper.find('[data-test="budget-state"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="budget-spend"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('不限');
    // 读失败不影响写：保存按钮与输入框照旧可用
    expect(wrapper.find('[data-test="budget-input"]').exists()).toBe(true);
    const saveBtn = wrapper.find('[data-test="budget-save"]').element as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
  });

  it('usage GET 500 ⇒ 显式报错（usage-load-error）：不显示「暂无用量数据」；额度区不受牵连', async () => {
    const { wrapper } = await mountQuota((url, init) => {
      if (url.startsWith('/api/admin/fdes/alice/llm/usage') && !init?.method) {
        return jsonResponse(500, { error: { code: 'server_error', message: 'gateway down' } });
      }
      return undefined;
    });
    expect(wrapper.find('[data-test="usage-load-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="usage-load-error"]').text()).toContain('无法读取用量');
    expect(wrapper.text()).not.toContain('暂无用量');
    expect(wrapper.find('[data-test="usage-table"]').exists()).toBe(false);
    // 两个读互相独立：用量读失败不影响额度区正常渲染
    expect(wrapper.find('[data-test="budget-load-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="budget-spend"]').text()).toBe('1.25');
  });

  it('quota GET 404（无 active binding）⇒ 静默降级：既不报错也不渲染额度区', async () => {
    // 真实无绑定态：config 无 api_key ⇒ 额度区整块隐藏；budget/usage 404 也不报错。
    const { wrapper } = await mountQuota((url, init) => {
      if (url === '/api/admin/fdes/alice/llm' && !init?.method) {
        return jsonResponse(200, { config: { provider_id: 'p1', api_key: null }, active_run: false });
      }
      if ((url === '/api/admin/fdes/alice/llm/budget' || url.startsWith('/api/admin/fdes/alice/llm/usage')) && !init?.method) {
        return jsonResponse(404, { error: { code: 'not_found', message: 'no active binding' } });
      }
      return undefined;
    });
    expect(wrapper.find('[data-test="daily-budget"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="budget-load-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="usage-load-error"]').exists()).toBe(false);

    // 更强守卫：即便额度区可见（有 api_key），budget 404（not_found）也不得置 budgetLoadErr ⇒ 静默降级。
    const vis = await mountQuota((url, init) => {
      if (url === '/api/admin/fdes/alice/llm/budget' && !init?.method) {
        return jsonResponse(404, { error: { code: 'not_found', message: 'no active binding' } });
      }
      return undefined;
    });
    expect(vis.wrapper.find('[data-test="budget-load-error"]').exists()).toBe(false);
    expect(vis.wrapper.find('[data-test="budget-state"]').exists()).toBe(true);
  });

  // issue #800：修「未设额度却显示每月」的误导默认。
  it('未设额度（budget_period=null）⇒ 周期下拉选中空串且出现「未设置」选项（不再伪装成每月）', async () => {
    const { wrapper } = await mountQuota((url, init) => {
      if (String(url).includes('/llm/budget') && !init?.method) {
        return jsonResponse(200, { quota: { budget_usd: null, budget_period: null, max_budget: null, budget_duration: null, budget_reset_at: null, spend: 1, remaining: null, spend_scope: 'lifetime' } });
      }
      return undefined;
    });
    const sel = wrapper.find('[data-test="budget-period"]').element as HTMLSelectElement;
    expect(sel.value).toBe('');
    const optTexts = wrapper.find('[data-test="budget-period"]').findAll('option').map((o) => o.text());
    expect(optTexts).toEqual(['未设置', '每月', '每日']);
  });

  it('设了 1mo 时下拉仍显示「每月」（回显 budget_period=1mo）', async () => {
    const { wrapper } = await mountQuota(); // QUOTA.budget_period='1mo'
    const sel = wrapper.find('[data-test="budget-period"]').element as HTMLSelectElement;
    expect(sel.value).toBe('1mo');
  });

  it('保存时周期为空 ⇒ body 不带 budget_period（后端缺省按每月兜）；有金额+周期未设置时出现提示行', async () => {
    const { wrapper, fetchFn } = await mountQuota((url, init) => {
      if (String(url).includes('/llm/budget') && init?.method === 'PUT') {
        return jsonResponse(200, { quota: { budget_usd: 3, budget_period: '1mo', max_budget: 3, budget_duration: '1mo', budget_reset_at: '2026-12-01T00:00:00Z', spend: 0, remaining: 3, spend_scope: 'period' } });
      }
      return undefined;
    });
    await wrapper.find('[data-test="budget-input"]').setValue('3');
    await wrapper.find('[data-test="budget-period"]').setValue('');   // 选「未设置」
    expect(wrapper.find('[data-test="budget-period-hint"]').exists()).toBe(true); // 有金额 + 未设置
    await wrapper.find('[data-test="budget-save"]').trigger('click');
    await flushPromises();
    const puts = quotaPuts(fetchFn);
    expect(puts).toHaveLength(1);
    expect(JSON.parse(String(puts[0][1]?.body))).toEqual({ budget_usd: 3 }); // 无 budget_period
  });
});
