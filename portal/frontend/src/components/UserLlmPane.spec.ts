// per-user LLM 配置 pane 单测（issue #61 P3）：
//   ② 409 active_run_conflict → 展示服务端拒绝原因 + 「确认无影响，强制保存」显式确认按钮；
//      首次提交绝不带 force 字段，点击确认后才带 force=true 重试（不静默 force）。
//   附带：活跃 run warnbox、供应商下拉联动过滤模型下拉、provision 成功文案。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import UserLlmPane from './UserLlmPane.vue';
import type { AdminUser, LlmProvider } from '../stores/admin';

const FDE_USER = {
  id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', status: 'active',
} as AdminUser;

const PROVIDERS = [
  {
    id: 'p1', name: 'openai', base_url: 'https://api.openai.com/v1', enabled: true,
    models: [
      { id: 'm1', provider_id: 'p1', model_id: 'gpt-4o', name: 'GPT-4o', type: 'text', tool_calling: true, context_window: 128000, enabled: true },
      { id: 'm2', provider_id: 'p1', model_id: 'text-embedding-3', name: 'Embedding 3', type: 'embedding', tool_calling: false, context_window: null, enabled: true },
      { id: 'm3', provider_id: 'p1', model_id: 'claude-x', name: 'Claude X', type: 'text', tool_calling: false, context_window: null, enabled: true },
    ],
  },
  {
    id: 'p2', name: 'anthropic', base_url: 'https://api.anthropic.com', enabled: true,
    models: [
      { id: 'm4', provider_id: 'p2', model_id: 'claude-sonnet', name: 'Sonnet', type: 'text', tool_calling: true, context_window: 200000, enabled: false },
    ],
  },
] as LlmProvider[];

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

async function mountPane(extra?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const fetchFn = fetchMock((url, init) => extra?.(url, init)
    ?? (url === '/api/admin/fdes/alice/llm' && !init?.method
      ? jsonResponse(200, GET_CONFIG)
      : jsonResponse(404, { error: { code: 'not_found', message: 'not found' } })));
  vi.stubGlobal('fetch', fetchFn);
  const wrapper = mount(UserLlmPane, { props: { user: FDE_USER, providers: PROVIDERS } });
  await flushPromises();
  return { wrapper, fetchFn };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('UserLlmPane · LLM 配置表单', () => {
  it('加载 config + active_run：warnbox 与 key 掩码提示展示；模型下拉按类型/能力过滤并回填', async () => {
    const { wrapper } = await mountPane();
    expect(wrapper.text()).toContain('⚠️ 有活跃 run：更换供应商或 API key 会被服务端拒绝');
    expect(wrapper.find('[data-test="key-hint"]').text()).toBe('已配置 sk•••，重输以修改');

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

  it('保存成功：展示「已保存：主模型 …」并清空 API key 输入框', async () => {
    const { wrapper, fetchFn } = await mountPane((url, init) => {
      if (String(url).includes('/llm') && init?.method === 'PUT') {
        return jsonResponse(200, { config: { provider_id: 'p1', api_key: 'sk•••', main: { model_id: 'gpt-4o' } } });
      }
      return undefined;
    });
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(wrapper.text()).toContain('已保存：主模型 gpt-4o');
    expect((wrapper.find('input[type="password"]').element as HTMLInputElement).value).toBe('');
    expect(putCalls(fetchFn)).toHaveLength(1);
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
});
