// DirSelect 单测（issue #84 P5.4）：目录下拉数据源（store.dirs）、●N 运行态徽标
//（N=running+queued，0 不显）、末项「＋ 新建目录」、切换 selectDir。
// store 状态直填、fetch 桩掉（不碰真实后端）。事件消费侧（new-dir/refresh）在 SidebarPanel.spec 覆盖。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import DirSelect from './DirSelect.vue';
import { useWorkbenchStore } from '../stores/workbench';
import { i18n, setLocale } from '../i18n';

// selectDir 会触发 loadSessions：桩掉 fetch（不碰真实后端）。
beforeEach(() => {
  // issue #101 P2：装配真实 i18n 单例，每例重置为 zh-CN。
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"items":[]}', { status: 200 })));
});

function setup(dirs: { name: string; cwd: string; running_count: number; queued_count: number }[]) {
  const store = useWorkbenchStore();
  store.dirs = dirs;
  store.dirCwd = dirs[0]?.cwd ?? null;
  const wrapper = mount(DirSelect, { props: {}, global: { plugins: [i18n] } });
  return { store, wrapper };
}

describe('DirSelect（目录下拉）', () => {
  it('选项 = 目录名 + ●N 徽标（N=running+queued；0 不显示徽标）+ 末项「＋ 新建目录」', () => {
    const { wrapper } = setup([
      { name: 'llm-smoke', cwd: '~/projects/llm-smoke', running_count: 1, queued_count: 1 },
      { name: 'idle', cwd: '~/projects/idle', running_count: 0, queued_count: 0 },
    ]);
    const options = wrapper.findAll('option');
    expect(options.map((o) => o.text())).toEqual(['llm-smoke ●2', 'idle', '＋ 新建目录']);
    expect(options[0].attributes('value')).toBe('~/projects/llm-smoke');
  });

  it('切换选项 → store.selectDir（cwd 切换，会话列表按新 cwd 重载）', async () => {
    const { store, wrapper } = setup([
      { name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 },
      { name: 'b', cwd: '~/projects/b', running_count: 0, queued_count: 0 },
    ]);
    await wrapper.get('select').setValue('~/projects/b');
    expect(store.dirCwd).toBe('~/projects/b');
    const called = vi.mocked(fetch).mock.calls.some(([u]) => String(u).startsWith('/api/sessions?cwd='));
    expect(called).toBe(true);
  });

  it('选中「＋ 新建目录」→ 下拉弹回当前选中，不产生 cwd 切换', async () => {
    const { store, wrapper } = setup([
      { name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 },
    ]);
    const select = wrapper.get('select');
    await select.setValue('__new__');
    expect(store.dirCwd).toBe('~/projects/a'); // 未切目录（表单流程由 SidebarPanel 承接）
    expect(select.element.value).toBe('~/projects/a'); // 弹回
  });

  it('无目录：显示占位选项；平台管理员「＋ 新建目录」禁用', async () => {
    const { store, wrapper } = setup([]);
    store.noDir = true;
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('option')[0]?.text()).toBe('（无目录）');

    const store2 = useWorkbenchStore();
    store2.dirs = [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }];
    store2.dirCwd = '~/projects/a';
    store2.isPlatformAdmin = true;
    const wrapper2 = mount(DirSelect, { props: {}, global: { plugins: [i18n] } });
    await wrapper2.vm.$nextTick();
    expect(store2.newDirDisabled).toBe(true);
    const opt = wrapper2.findAll('option').find((o) => o.text() === '＋ 新建目录');
    expect(opt?.attributes('disabled')).toBeDefined();
  });
});
