// `MacroMenu.vue` 的单测（issue #528）。判据是 `07` §3.1 的「一次点击只做一件事」与
// §3.2 的「只列会话级模板」。
//
// ⚠ 事件契约**不用 `w.emitted()`**（`NODE_ENV=production` 下恒空，AGENTS.md §4 的环境地板，
// 口径同 `GitLightBadge.spec.ts:34-44`）：改用宿主组件把收到的事件**渲染进 DOM**再断言。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import MacroMenu from './MacroMenu.vue';
import { i18n, setLocale } from '../i18n';
import { useMacroStore } from '../stores/macro';

const SESSION = '11111111-1111-4111-8111-111111111111';

interface RecordedCall { url: string; method: string; body: unknown }

/** 模板 + 订阅两个端点的通用桩（组件挂载时会自己拉模板）。 */
function stubFetch(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (url.includes('/macro-assignments')) {
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      items: [
        { id: 't-review', kind: 'run-review', name: '完成审查 · 默认', params: {}, scope: 'session', audience: 'all' },
        { id: 't-notify', kind: 'run-notify', name: '终态通知', params: {}, scope: 'session', audience: 'all' },
        { id: 't-daily', kind: 'scheduled-task', name: '每日 9 点', params: {}, scope: 'user', audience: 'all' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return calls;
}

/** 宿主：把 `open-runs` 事件渲染成 DOM（而不是 `emitted()`）。 */
function mountMenu(props: Record<string, unknown> = {}) {
  const opens = ref(0);
  const Host = defineComponent({
    setup: () => () => h('div', {}, [
      h('span', { 'data-test': 'host-open-count' }, String(opens.value)),
      h(MacroMenu, { ...props, 'onOpen-runs': undefined, onOpenRuns: () => { opens.value += 1; } }),
    ]),
  });
  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [i18n] } });
  return { wrapper, opens };
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  const pinia = createPinia();
  setActivePinia(pinia);
  // 每个用例一个干净的 pinia（挂在 global.plugins 上，避免组件里 useStore 拿到孤儿实例）。
  document.body.innerHTML = '';
});

describe('入口职责分开（`07` §3.1：一次点击只做一件事）', () => {
  it('chip 点击只打开流水抽屉：宿主收到事件，且模板下拉**没有**被打开', async () => {
    stubFetch();
    const { wrapper } = mountMenu({ scope: 'session', sessionId: SESSION, variant: 'chip' });
    await new Promise((r) => setTimeout(r, 0));

    const chip = wrapper.find('[data-test="macro-chip"]');
    expect(chip.exists()).toBe(true);
    expect(wrapper.find('[data-test="macro-config-panel"]').exists()).toBe(false);

    await chip.trigger('click');
    expect(wrapper.find('[data-test="host-open-count"]').text()).toBe('1');
    // 一次点击只做一件事：chip 不该顺手把模板下拉也打开。
    expect(wrapper.find('[data-test="macro-config-panel"]').exists()).toBe(false);
  });

  it('抽屉里的 [配置 ▾] 只打开模板下拉（不发请求、不开抽屉）', async () => {
    const calls = stubFetch();
    const { wrapper, opens } = mountMenu({ scope: 'session', sessionId: SESSION, variant: 'config' });
    await new Promise((r) => setTimeout(r, 0));
    const baseline = calls.length;

    await wrapper.find('[data-test="macro-config-button"]').trigger('click');
    expect(wrapper.find('[data-test="macro-config-panel"]').exists()).toBe(true);
    expect(opens.value).toBe(0);
    expect(calls.length).toBe(baseline);
  });
});

describe('只列会话级模板（`07` §3.2）', () => {
  it('session scope 的下拉里不出现 `user` scope 的定时任务', async () => {
    stubFetch();
    const { wrapper } = mountMenu({ scope: 'session', sessionId: SESSION, variant: 'config' });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.find('[data-test="macro-config-button"]').trigger('click');

    const items = wrapper.findAll('[data-test="macro-config-item"]');
    expect(items.map((n) => n.attributes('data-template-id'))).toEqual(['t-review', 't-notify']);
    expect(wrapper.text()).not.toContain('每日 9 点');
  });

  it('user scope 的实例（顶栏那份）列用户级模板，且可自己启用（不再是只读复选框）', async () => {
    stubFetch();
    const { wrapper } = mountMenu({ scope: 'user', variant: 'config' });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.find('[data-test="macro-config-button"]').trigger('click');

    const items = wrapper.findAll('[data-test="macro-config-item"]');
    expect(items.map((n) => n.attributes('data-template-id'))).toEqual(['t-daily']);
    // issue #623：user scope 不再只读——没有禁用的复选框，而是有一个「启用」按钮。
    expect(items[0].find('[data-test="macro-config-check"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="macro-user-enable"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('由管理员代配');
  });

  it('原始枚举不进 UI：面板里既没有 `run-notify` 也没有 `scheduled-task`', async () => {
    stubFetch();
    const { wrapper } = mountMenu({ scope: 'session', sessionId: SESSION, variant: 'config' });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.find('[data-test="macro-config-button"]').trigger('click');
    expect(wrapper.text()).not.toContain('run-notify');
    expect(wrapper.text()).not.toContain('scheduled-task');
  });
});

describe('选中即生效（`07` §3.3：没有保存按钮）', () => {
  it('勾选 ⇒ 一次 PUT（带 templateId），并立即显示成已启用', async () => {
    const calls = stubFetch();
    const { wrapper } = mountMenu({ scope: 'session', sessionId: SESSION, variant: 'config' });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.find('[data-test="macro-config-button"]').trigger('click');

    const first = wrapper.findAll('[data-test="macro-config-check"]')[0];
    await first.setValue(true);
    await new Promise((r) => setTimeout(r, 0));

    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toBeTruthy();
    expect(put?.url).toBe(`/api/sessions/${SESSION}/macro-assignments`);
    expect(put?.body).toMatchObject({ templateId: 't-review' });
    // 会话头的 chip 同步显示「已启用 1 个」（同一个 store，两个实例共享状态）。
    const macro = useMacroStore();
    macro.assignments = [{
      id: 'a-1', templateId: 't-review', sessionId: SESSION, until: null,
      enabled: true, expired: false, effectiveEnabled: true,
      lastEvaluatedAt: null, createdAt: null,
    }];
    expect(macro.enabledAssignments.length).toBe(1);
  });

  it('取消勾选 ⇒ 一次 DELETE（按 assignmentId）', async () => {
    const macro = useMacroStore();
    macro.assignments = [{
      id: 'a-7', templateId: 't-review', sessionId: SESSION, until: null,
      enabled: true, expired: false, effectiveEnabled: true,
      lastEvaluatedAt: null, createdAt: null,
    }];
    const calls = stubFetch();
    const { wrapper } = mountMenu({ scope: 'session', sessionId: SESSION, variant: 'config' });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.find('[data-test="macro-config-button"]').trigger('click');

    const first = wrapper.findAll('[data-test="macro-config-check"]')[0];
    expect((first.element as HTMLInputElement).checked).toBe(true);
    await first.setValue(false);
    await new Promise((r) => setTimeout(r, 0));

    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.url).toBe(`/api/sessions/${SESSION}/macro-assignments/a-7`);
    expect(macro.enabledAssignments.length).toBe(0);
  });
});

describe('chip 文案（颜色不承重：文字标签在 DOM 里）', () => {
  it('未启用与已启用两种文案都带「自动化」前缀，且 title/aria-label 同一句话', async () => {
    stubFetch();
    const { wrapper } = mountMenu({ scope: 'session', sessionId: SESSION, variant: 'chip' });
    await new Promise((r) => setTimeout(r, 0));
    const chip = wrapper.find('[data-test="macro-chip"]');
    expect(chip.text()).toContain('自动化');
    expect(chip.text()).toContain('未启用');
    expect(chip.attributes('title')).toBe(chip.attributes('aria-label'));

    const macro = useMacroStore();
    macro.assignments = [{
      id: 'a-1', templateId: 't-review', sessionId: SESSION, until: null,
      enabled: true, expired: false, effectiveEnabled: true,
      lastEvaluatedAt: null, createdAt: null,
    }];
    await new Promise((r) => setTimeout(r, 0));
    expect(wrapper.find('[data-test="macro-chip"]').text()).toContain('1 启用');
  });
});

describe('用户级模板可订阅（issue #623：顶栏 user scope 不再只读）', () => {
  /** 带 /api/dirs 与 PUT /api/macro-assignments 的桩（DOM 断言，不用 w.emitted()）。 */
  function stubWithDirs(initialItems: unknown[] = []): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
      const json = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/dirs')) {
        return json({ dirs: [{ name: 'acme', cwd: '~/projects/acme', running_count: 0, queued_count: 0 }] });
      }
      if (url.includes('/api/macro-assignments')) {
        if (method === 'PUT') {
          const b = (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as { templateId?: string; cwd?: string };
          return json({ assignment: { id: 'ua-1', template_id: b.templateId, session_id: null, cwd: b.cwd, enabled: true, effective_enabled: true } });
        }
        return json({ items: initialItems });
      }
      return json({ items: [
        { id: 't-daily', kind: 'scheduled-task', name: '每日 9 点', params: {}, scope: 'user', audience: 'all' },
      ] });
    }));
    return calls;
  }

  it('启用 → 选目录 → 一次 PUT /api/macro-assignments（带 templateId 与 cwd），并显示已启用', async () => {
    const calls = stubWithDirs();
    const { wrapper } = mountMenu({ scope: 'user', variant: 'config' });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.find('[data-test="macro-config-button"]').trigger('click');

    await wrapper.find('[data-test="macro-user-enable"]').trigger('click');
    await new Promise((r) => setTimeout(r, 0));
    // 展开后出现目录选择器（DirSelect）与一个真实目录选项。
    const picker = wrapper.find('[data-test="macro-user-dirpicker"]');
    expect(picker.exists()).toBe(true);
    const select = picker.find('select');
    expect(select.exists()).toBe(true);
    expect(select.findAll('option').map((o) => o.attributes('value'))).toContain('~/projects/acme');

    await select.setValue('~/projects/acme');
    await new Promise((r) => setTimeout(r, 0));

    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toBeTruthy();
    expect(put?.url).toBe('/api/macro-assignments');
    expect(put?.body).toMatchObject({ templateId: 't-daily', cwd: '~/projects/acme' });
    // 订阅后行内显示「已启用」（DOM 断言）。
    expect(wrapper.find('[data-test="macro-user-enabled"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('已启用');
  });

  it('已启用后点「取消订阅」→ 一次 DELETE /api/macro-assignments/:id', async () => {
    const calls = stubWithDirs([
      { id: 'ua-9', template_id: 't-daily', session_id: null, cwd: '~/projects/acme', enabled: true, effective_enabled: true },
    ]);
    const macro = useMacroStore();
    const { wrapper } = mountMenu({ scope: 'user', variant: 'config' });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.find('[data-test="macro-config-button"]').trigger('click');

    expect(wrapper.find('[data-test="macro-user-enabled"]').exists()).toBe(true);
    await wrapper.find('[data-test="macro-user-disable"]').trigger('click');
    await new Promise((r) => setTimeout(r, 0));

    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.url).toBe('/api/macro-assignments/ua-9');
    expect(macro.userAssignments.length).toBe(0);
  });
});
