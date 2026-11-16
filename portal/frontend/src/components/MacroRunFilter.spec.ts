// MacroRunFilter 单测（issue #529，事件平台 W6）。
// 红线：**不用 w.emitted()**（NODE_ENV=production 下恒空）。用「harness 把 model 打到 DOM」
// 来间接断言 defineModel 的更新（子组件 emit → 父级 ref 被整体替换 → dump 里能看到新值）。
import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import MacroRunFilter, { type MacroRunFilters } from './MacroRunFilter.vue';
import { i18n, setLocale } from '../i18n';

const OPTS = [
  { id: 'tpl-1', name: '失败告警' },
  { id: 'tpl-2', name: '每日巡检' },
];

function empty(): MacroRunFilters {
  return { templateId: '', status: '', verdict: '', from: '', to: '', userId: '' };
}

/** 挂一个把当前 model JSON 打到 DOM 的壳；返回 wrapper + model ref。 */
function mountScope(scope: 'admin' | 'user'): { wrapper: VueWrapper; model: ReturnType<typeof ref<MacroRunFilters>> } {
  const model = ref<MacroRunFilters>(empty());
  const wrapper = mount(
    {
      components: { MacroRunFilter },
      setup() {
        return { model, scope, OPTS };
      },
      template:
        '<MacroRunFilter v-model="model" :scope="scope" :templates="OPTS" />' +
        '<pre data-test="dump">{{ JSON.stringify(model) }}</pre>',
    },
    { global: { plugins: [i18n] } },
  );
  return { wrapper, model };
}

function dump(wrapper: VueWrapper): MacroRunFilters {
  return JSON.parse(wrapper.get('[data-test="dump"]').text()) as MacroRunFilters;
}

beforeEach(() => {
  setLocale('zh-CN');
});

describe('MacroRunFilter：admin 5 个筛选 / user 2 个筛选', () => {
  it('admin scope：模板 / 状态 / 判决 / 时间 / 用户 全都在', () => {
    const { wrapper } = mountScope('admin');
    for (const id of ['filter-template', 'filter-status', 'filter-verdict', 'filter-from', 'filter-to', 'filter-user']) {
      expect(wrapper.find(`[data-test="${id}"]`).exists(), `缺筛选控件 ${id}`).toBe(true);
    }
    expect(wrapper.get('[data-test="macro-run-filter"]').attributes('data-scope')).toBe('admin');
  });

  it('user scope：只有模板 / 判决，没有状态 / 时间 / 用户（口径同 MacroDrawer）', () => {
    const { wrapper } = mountScope('user');
    expect(wrapper.find('[data-test="filter-template"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="filter-verdict"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="filter-status"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="filter-from"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="filter-user"]').exists()).toBe(false);
  });
});

describe('MacroRunFilter：候选与 model 更新', () => {
  it('模板下拉渲染调用方传入的候选（组件不自己拉，避免漏权限口径）', () => {
    const { wrapper } = mountScope('admin');
    const options = wrapper.get('[data-test="filter-template"]').findAll('option').map((o) => o.text());
    expect(options).toContain('失败告警');
    expect(options).toContain('每日巡检');
  });

  it('改模板下拉 ⇒ model 同步（DOM dump 里能看到新 templateId）', async () => {
    const { wrapper } = mountScope('admin');
    await wrapper.get('[data-test="filter-template"]').setValue('tpl-2');
    await flushPromises();
    expect(dump(wrapper).templateId).toBe('tpl-2');
  });

  it('改状态 / 判决下拉 ⇒ model 同步', async () => {
    const { wrapper } = mountScope('admin');
    await wrapper.get('[data-test="filter-status"]').setValue('skipped');
    await wrapper.get('[data-test="filter-verdict"]').setValue('red');
    await flushPromises();
    const d = dump(wrapper);
    expect(d.status).toBe('skipped');
    expect(d.verdict).toBe('red');
  });

  it('清除按钮把所有条件重置为空', async () => {
    const { wrapper } = mountScope('admin');
    await wrapper.get('[data-test="filter-template"]').setValue('tpl-1');
    await wrapper.get('[data-test="filter-user"]').setValue('user-9');
    await flushPromises();
    expect(dump(wrapper).userId).toBe('user-9');
    await wrapper.get('[data-test="filter-clear"]').trigger('click');
    await flushPromises();
    expect(dump(wrapper)).toEqual(empty());
  });
});
