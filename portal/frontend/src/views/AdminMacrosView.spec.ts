// AdminMacrosView 单测（issue #529，事件平台 W6）。装配照 `AdminMailView.spec.ts`；
// 红线：**不用 w.emitted()**，全部经 DOM / 请求体断言。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import AdminMacrosView from './AdminMacrosView.vue';
import { i18n, setLocale } from '../i18n';

interface Recorded { url: string; method: string; body: unknown; params: URLSearchParams }
type Handler = (c: Recorded) => Response | undefined;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function stubFetch(handler: Handler): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = typeof init?.body === 'string' ? init.body : null;
    const rec: Recorded = {
      url, method, body: raw === null ? null : JSON.parse(raw),
      params: new URL(url, 'http://localhost').searchParams,
    };
    calls.push(rec);
    const res = handler(rec);
    if (!res) throw new Error(`fetch 桩没处理 ${method} ${url}`);
    return res;
  }));
  return calls;
}

function tpl(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, kind: 'run-notify', name: `模板-${id}`, params: {}, audience: 'all',
    scope: 'session', enabled: true, deleted_at: null, ...over,
  };
}

async function mountView(handler: Handler): Promise<{ wrapper: VueWrapper; calls: Recorded[] }> {
  const calls = stubFetch(handler);
  const wrapper = mount(AdminMacrosView, { global: { plugins: [i18n] } });
  await flushPromises();
  return { wrapper, calls };
}

const listHandler: Handler = (c) => {
  if (c.url.startsWith('/api/admin/macro-templates') && c.method === 'GET') {
    return json(200, { items: [tpl('t-live'), tpl('t-gone', { deleted_at: '2026-11-01T00:00:00.000Z' })] });
  }
  return undefined;
};

beforeEach(() => setLocale('zh-CN'));
afterEach(() => vi.unstubAllGlobals());

describe('① 删除三分支的平台判定文案', () => {
  it('零引用 ⇒ mode=deleted ⇒ 「已物理删除」（不出现「软」）', async () => {
    const { wrapper } = await mountView((c) => {
      const base = listHandler(c);
      if (base) return base;
      if (c.url.includes('/api/admin/macro-templates/t-live') && c.method === 'DELETE') {
        return json(200, { mode: 'deleted', assignmentsRemoved: 0, notifications: 0, macroRuns: 0 });
      }
      return undefined;
    });
    await wrapper.get('[data-test="delete-t-live"]').trigger('click');
    await flushPromises();
    const txt = wrapper.get('[data-test="macros-result"]').text();
    expect(txt).toContain('已物理删除');
    expect(txt).not.toContain('软');
  });

  it('只有订阅 ⇒ mode=deleted_with_assignments ⇒ 「级联清除了 N 条订阅」', async () => {
    const { wrapper } = await mountView((c) => {
      const base = listHandler(c);
      if (base) return base;
      if (c.url.includes('/api/admin/macro-templates/t-live') && c.method === 'DELETE') {
        return json(200, { mode: 'deleted_with_assignments', assignmentsRemoved: 3, notifications: 0, macroRuns: 0 });
      }
      return undefined;
    });
    await wrapper.get('[data-test="delete-t-live"]').trigger('click');
    await flushPromises();
    const txt = wrapper.get('[data-test="macros-result"]').text();
    expect(txt).toContain('级联');
    expect(txt).toContain('3');
  });

  it('有执行账/通知 ⇒ mode=soft ⇒ 「软删除（保留历史）」并带 runs / notifications 数', async () => {
    const { wrapper } = await mountView((c) => {
      const base = listHandler(c);
      if (base) return base;
      if (c.url.includes('/api/admin/macro-templates/t-live') && c.method === 'DELETE') {
        return json(200, { mode: 'soft', assignmentsRemoved: 0, notifications: 2, macroRuns: 7,
          template: tpl('t-live', { deleted_at: '2026-11-16T00:00:00.000Z' }) });
      }
      // 软删后组件会重取列表刷新标记
      if (c.url.startsWith('/api/admin/macro-templates') && c.method === 'GET') return base ?? json(200, { items: [] });
      return undefined;
    });
    await wrapper.get('[data-test="delete-t-live"]').trigger('click');
    await flushPromises();
    const txt = wrapper.get('[data-test="macros-result"]').text();
    expect(txt).toContain('软删');
    expect(txt).toContain('7');
    expect(txt).toContain('2');
  });
});

describe('② 先选 kind 再填表（字段表来自 KIND_SCHEMA；kind 不可改）', () => {
  it('选 run-review ⇒ 渲染该 kind 的参数字段（on_fail 枚举有 reflow/notify_only）并显示固定区', async () => {
    const { wrapper } = await mountView(listHandler);
    await wrapper.get('[data-test="macros-create-open"]').trigger('click');
    await flushPromises();
    // 未选 kind：没有参数字段，但有「先选类型」提示与「kind 不可改」提示。
    expect(wrapper.get('[data-test="create-kind-locked"]').text()).toContain('不可');
    expect(wrapper.find('[data-test="param-on_fail"]').exists()).toBe(false);

    await wrapper.get('[data-test="create-kind"]').setValue('run-review');
    await flushPromises();
    const onFail = wrapper.get('[data-test="param-on_fail"]');
    const opts = onFail.findAll('option').map((o) => o.text());
    expect(opts).toContain('reflow');
    expect(opts).toContain('notify_only');
    expect(wrapper.find('[data-test="param-max_rounds"]').exists()).toBe(true);
    // 固定区显示该 kind 的 scope（run-review = session）。
    expect(wrapper.get('[data-test="create-fixed-scope"]').text()).toContain('会话');
  });

  it('提交创建 ⇒ POST 带 kind 且 scope 取自 KIND_SCOPE（run-review=session），并显示用户视角预览', async () => {
    const { wrapper, calls } = await mountView((c) => {
      const base = listHandler(c);
      if (base && c.method === 'GET') return base;
      if (c.url === '/api/admin/macro-templates' && c.method === 'POST') {
        return json(200, { template: tpl('new-1', { kind: 'run-review', scope: 'session', name: '巡检' }) });
      }
      return base;
    });
    await wrapper.get('[data-test="macros-create-open"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="create-kind"]').setValue('run-review');
    await wrapper.get('[data-test="create-name"]').setValue('巡检');
    await flushPromises();
    await wrapper.get('[data-test="macros-create-form"]').trigger('submit');
    await flushPromises();

    const post = calls.find((c) => c.method === 'POST');
    expect(post).toBeTruthy();
    const body = post!.body as Record<string, unknown>;
    expect(body.kind).toBe('run-review');
    expect(body.scope).toBe('session'); // 前端按 KIND_SCOPE 送，用户不能手填
    expect(body.name).toBe('巡检');
    // 创建后显示用户视角预览。
    expect(wrapper.find('[data-test="created-preview"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="created-preview-text"]').text()).toContain('巡检');
  });
});

describe('列表列：订阅数占位 + 启停 PATCH', () => {
  it('后端未下发订阅数 ⇒ 显示占位「—」而不是 0（不冒充「没人订」）', async () => {
    const { wrapper } = await mountView(listHandler);
    const subs = wrapper.findAll('[data-test="row-subs"]');
    expect(subs.length).toBeGreaterThan(0);
    expect(subs[0].text()).toBe('—');
    expect(subs[0].text()).not.toBe('0');
  });

  it('点「停用」⇒ PATCH 请求体 {enabled:false}', async () => {
    const { wrapper, calls } = await mountView((c) => {
      const base = listHandler(c);
      if (base && c.method === 'GET') return base;
      if (c.url.endsWith('/api/admin/macro-templates/t-live') && c.method === 'PATCH') {
        return json(200, { template: tpl('t-live', { enabled: false }) });
      }
      return base;
    });
    await wrapper.get('[data-test="toggle-t-live"]').trigger('click');
    await flushPromises();
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch).toBeTruthy();
    expect(patch!.body).toEqual({ enabled: false });
  });

  it('软删模板行显示「（已删除）」', async () => {
    const { wrapper } = await mountView(listHandler);
    const rows = wrapper.findAll('[data-test="macro-row"]');
    const gone = rows.find((r) => r.attributes('data-template-id') === 't-gone');
    expect(gone!.get('[data-test="row-name"]').text()).toContain('已删除');
  });
});

// ── issue #759：编辑入口 ────────────────────────────────────────────────────────
// 红线同文件头：不用 w.emitted()，全部经 DOM / 请求桩断言。

describe('编辑入口（#759）：kind/scope 只读、预填取模板值、PATCH 不带 kind/scope、400 不清空、就地更新', () => {
  // 编辑目标：run-silence-alert，params **故意与 schema default 不同**——
  //   threshold = 30m（默认 15m）、phases = ['awaiting_llm']（默认 ['tool_running']）。
  //   这样「预填取模板值」与「预填取 schema default」可区分：若编辑误走 initialParams()，
  //   用例会当场红（反向自证 ①）。audience=admin 也刻意不同于新建默认的 all。
  function sil(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id, kind: 'run-silence-alert', name: '静默-原值',
      params: { threshold: '30m', phases: ['awaiting_llm'] },
      audience: 'admin', scope: 'session', enabled: true, deleted_at: null,
      subscriberCount: 4, ...over,
    };
  }
  const editList: Handler = (c) =>
    c.url.startsWith('/api/admin/macro-templates') && c.method === 'GET'
      ? json(200, { items: [sil('t-sil')] })
      : undefined;

  /** param 控件是 `:value` + `@change`（非 v-model）：改值要手动触发 change 才回写 form.params。 */
  async function changeInput(wrapper: VueWrapper, test: string, value: string): Promise<void> {
    const el = wrapper.get(`[data-test="${test}"]`).element as HTMLInputElement;
    el.value = value;
    await wrapper.get(`[data-test="${test}"]`).trigger('change');
  }

  it('① 每行有编辑入口（data-test=edit-<id>）', async () => {
    const { wrapper } = await mountView(editList);
    expect(wrapper.find('[data-test="edit-t-sil"]').exists()).toBe(true);
  });

  it('② 打开编辑 ⇒ name/audience/params 预填的是模板已有值（不是 schema default）', async () => {
    const { wrapper } = await mountView(editList);
    await wrapper.get('[data-test="edit-t-sil"]').trigger('click');
    await flushPromises();
    // name / audience 是模板的值（audience=admin 而非新建默认 all）。
    expect((wrapper.get('[data-test="edit-name"]').element as HTMLInputElement).value).toBe('静默-原值');
    expect((wrapper.get('[data-test="edit-audience"]').element as HTMLSelectElement).value).toBe('admin');
    // params 取模板已有值：threshold=30m（默认是 15m）。
    expect((wrapper.get('[data-test="param-threshold"]').element as HTMLInputElement).value).toBe('30m');
    // enum[] 按模板数组勾选：awaiting_llm 勾上（默认那档），tool_running 不勾（默认是它）。
    expect((wrapper.get('[data-test="param-array-phases-awaiting_llm"]').element as HTMLInputElement).checked).toBe(true);
    expect((wrapper.get('[data-test="param-array-phases-tool_running"]').element as HTMLInputElement).checked).toBe(false);
  });

  it('③ 编辑表单里 kind/scope 是纯文本，没有 input/select', async () => {
    const { wrapper } = await mountView(editList);
    await wrapper.get('[data-test="edit-t-sil"]').trigger('click');
    await flushPromises();
    const kind = wrapper.get('[data-test="edit-kind"]');
    expect(kind.text()).toContain('静默'); // kind 的人话标签（run-silence-alert = 静默告警）
    expect(kind.find('input').exists()).toBe(false);
    expect(kind.find('select').exists()).toBe(false);
    const scope = wrapper.get('[data-test="edit-scope"]');
    expect(scope.text()).toContain('会话'); // scope=session 的人话（会话（session））
    expect(scope.find('input').exists()).toBe(false);
    expect(scope.find('select').exists()).toBe(false);
    // 编辑态不该有新建那套 kind 下拉。
    expect(wrapper.find('[data-test="create-kind"]').exists()).toBe(false);
  });

  it('④ 保存 ⇒ PATCH 到模板 id、body 含改后 name/params、绝不含 kind/scope', async () => {
    const { wrapper, calls } = await mountView((c) => {
      if (c.method === 'GET' && c.url.startsWith('/api/admin/macro-templates')) return json(200, { items: [sil('t-sil')] });
      if (c.method === 'PATCH' && c.url.endsWith('/api/admin/macro-templates/t-sil')) {
        return json(200, { template: { ...sil('t-sil'), name: '改名', params: { threshold: '5m', phases: ['awaiting_llm'] } } });
      }
      return undefined;
    });
    await wrapper.get('[data-test="edit-t-sil"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="edit-name"]').setValue('改名');
    await changeInput(wrapper, 'param-threshold', '5m');
    await wrapper.get('[data-test="macros-edit-form"]').trigger('submit');
    await flushPromises();

    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch).toBeTruthy();
    expect(patch!.url).toContain('/api/admin/macro-templates/t-sil');
    const body = patch!.body as Record<string, unknown>;
    // kind/scope 出现在 body 里后端就 400 ⇒ 前端必须不带。
    expect('kind' in body).toBe(false);
    expect('scope' in body).toBe(false);
    expect(body.name).toBe('改名');
    expect((body.params as Record<string, unknown>).threshold).toBe('5m');
  });

  it('⑤ 后端 400 ⇒ 表单仍打开、输入仍在、错误文案原样显示', async () => {
    const { wrapper } = await mountView((c) => {
      if (c.method === 'GET' && c.url.startsWith('/api/admin/macro-templates')) return json(200, { items: [sil('t-sil')] });
      if (c.method === 'PATCH' && c.url.endsWith('/api/admin/macro-templates/t-sil')) {
        return json(400, { error: { message: 'threshold 不是合法时长', code: 'validation_failed' } });
      }
      return undefined;
    });
    await wrapper.get('[data-test="edit-t-sil"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="edit-name"]').setValue('我改的名字还没丢');
    await wrapper.get('[data-test="macros-edit-form"]').trigger('submit');
    await flushPromises();
    // 表单没关、输入没被清空、后端错误文案原样显示。
    expect(wrapper.find('[data-test="macros-edit-form"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="edit-error"]').text()).toContain('threshold 不是合法时长');
    expect((wrapper.get('[data-test="edit-name"]').element as HTMLInputElement).value).toBe('我改的名字还没丢');
  });

  it('⑥ 保存成功后列表就地更新（不整页重拉）', async () => {
    const { wrapper, calls } = await mountView((c) => {
      if (c.method === 'GET' && c.url.startsWith('/api/admin/macro-templates')) return json(200, { items: [sil('t-sil')] });
      if (c.method === 'PATCH' && c.url.endsWith('/api/admin/macro-templates/t-sil')) {
        return json(200, { template: { ...sil('t-sil'), name: '改名后' } });
      }
      return undefined;
    });
    await wrapper.get('[data-test="edit-t-sil"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="edit-name"]').setValue('改名后');
    await wrapper.get('[data-test="macros-edit-form"]').trigger('submit');
    await flushPromises();
    // 编辑保存只 PATCH，不再 GET 列表（初始那次 load 是唯一一次 GET）。
    expect(calls.filter((c) => c.method === 'GET').length).toBe(1);
    // 列表行就地反映新名字，且编辑表单已关闭。
    const row = wrapper.findAll('[data-test="macro-row"]').find((r) => r.attributes('data-template-id') === 't-sil');
    expect(row!.get('[data-test="row-name"]').text()).toContain('改名后');
    expect(wrapper.find('[data-test="macros-edit-form"]').exists()).toBe(false);
  });
});
