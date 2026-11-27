// issue #818 §⑤：`AppIcon` 的两条判据——命中要有 `<path>`，不命中要渲染空 svg **且不抛**。
//
// 第二条是本单唯一真正会咬人的退化：图标表是**手维护**的，将来加组 / 改名时漏一个键是必然会发生
// 的事；漏了的后果必须是「少一个装饰」，不能是「管理台侧栏整块渲染失败」（那会让 15 项导航全没入口）。
// 断言只认 DOM（本仓库红线：新用例别用 `w.emitted()`）。
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AppIcon from './AppIcon.vue';
import { ICON_PATHS } from '../lib/icons';

describe('AppIcon（#818 自维护内联 SVG）', () => {
  it('name 命中 ⇒ 渲染 viewBox/stroke 齐备的 svg 与至少一条 <path>', () => {
    const wrapper = mount(AppIcon, { props: { name: 'users' } });
    const svg = wrapper.get('svg');
    expect(svg.attributes('viewBox')).toBe('0 0 24 24');
    expect(svg.attributes('stroke')).toBe('currentColor');
    expect(svg.attributes('stroke-width')).toBe('1.5');
    expect(svg.attributes('fill')).toBe('none');
    expect(svg.attributes('aria-hidden'), '图标是装饰：读屏必须只读旁边那个词').toBe('true');
    const d = wrapper.findAll('path').map((p) => p.attributes('d'));
    expect(d.length).toBeGreaterThan(0);
    expect(d).toEqual(ICON_PATHS.users);
  });

  it('name 不命中 ⇒ 空 <svg>、零 <path>、不抛', () => {
    let wrapper = null as null | ReturnType<typeof mount>;
    expect(() => {
      wrapper = mount(AppIcon, { props: { name: 'no-such-icon' } });
    }).not.toThrow();
    if (!wrapper) throw new Error('挂载没返回 wrapper');
    expect(wrapper.find('svg').exists()).toBe(true);
    expect(wrapper.findAll('path')).toHaveLength(0);
  });

  it('表里每个键都有几何，且每条 d 都是非空字符串（手维护的表不许出现空条目）', () => {
    const keys = Object.keys(ICON_PATHS);
    expect(keys.length).toBeGreaterThanOrEqual(7); // 6 个组图标 + 「关于」
    for (const key of keys) {
      expect(ICON_PATHS[key].length, key).toBeGreaterThan(0);
      for (const d of ICON_PATHS[key]) expect(d.trim().length, `${key}:${d}`).toBeGreaterThan(0);
    }
  });
});
