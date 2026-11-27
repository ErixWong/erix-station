// 顶栏铃铛的单测（issue #850：通知标题存「键 + 参数」，**渲染时按读者当前语言拼**）。
//
// 判据（钉**具体字面**，不是「有没有翻译」）：
//   ① 同一条带键的行：`locale=zh-CN` ⇒ 逐字 `宏「x」已到期`；`locale=en` ⇒ 逐字 `Macro "x" expired`
//      ——「同一个读者换语言」与「同一行换读者语言」是同一件事，两句话必须都精确等值。
//   ② **只有旧文本的行**（存量：没有 `title_key`）⇒ 原样渲染，且**两种 locale 下逐字相同**
//      （存量行不许被翻译层碰一下）。
//   ③ `te()` 兜底：`title_key` 是个没登记的键 ⇒ 退回 `title`，绝不裸露 `notifications.xxx`。
//   ④ 四条键在中/英都渲染成工单钉的那句（写入侧的中文字面与 zh 模板逐字一致 ⇒ 回退面与渲染面同源）。
//
// ⚠ 不用 `w.emitted()`（`NODE_ENV=production` 下恒空，AGENTS.md §4）；断言一律读 DOM。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import MacroBell from './MacroBell.vue';
import { i18n, setLocale } from '../i18n';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** 一条后端行（用户面形状：`title` 永远在，`title_key`/`title_params` 可选出现）。 */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'n-1', severity: 'info', title: '宏「x」已到期', body: '订阅已自动停用',
    read_at: null, created_at: '2026-11-27T03:00:00.000Z',
    title_key: 'notifications.macroExpired', title_params: { name: 'x' },
    ...over,
  };
}

let pinia: Pinia;

function stubNotifications(items: Record<string, unknown>[]): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/notifications/unread-count')) return json({ count: items.length });
    return json({ items });
  }));
}

/** 挂载并展开面板（面板关着时一个列表请求都不发，`07` §16），返回 wrapper。 */
async function mountOpenBell(items: Record<string, unknown>[]) {
  stubNotifications(items);
  const wrapper = mount(MacroBell, {
    global: { plugins: [i18n, pinia] },
    attachTo: document.body,
  });
  await wrapper.find('[data-test="macro-bell-button"]').trigger('click');
  await flushPromises();
  return wrapper;
}

const titlesOf = (wrapper: VueWrapper): string[] =>
  wrapper.findAll('[data-test="notification-title"]').map((node) => node.text());

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  pinia = createPinia();
  setActivePinia(pinia);
  setLocale('zh-CN');
});

describe('#850 标题按读者语言拼（同一行，两种 locale）', () => {
  it('同一条记录：zh-CN ⇒ 逐字 `宏「x」已到期`，en ⇒ 逐字 `Macro "x" expired`', async () => {
    setLocale('zh-CN');
    const zh = await mountOpenBell([row()]);
    expect(titlesOf(zh)).toEqual(['宏「x」已到期']);

    setLocale('en');
    const en = await mountOpenBell([row()]);
    expect(titlesOf(en)).toEqual(['Macro "x" expired']);

    // 正文与时刻不参与翻译层（本单只收标题）：body 仍原样。
    expect(en.text()).toContain('订阅已自动停用');
  });

  it('四条键各自渲染成工单钉的那句（zh / en 各一遍，逐字）', async () => {
    const rows = [
      row({ id: 'a', title_key: 'notifications.macroExpired', title_params: { name: 'x' }, title: '宏「x」已到期' }),
      row({ id: 'b', title_key: 'notifications.macroTriggered', title_params: { name: 'x' }, title: '宏「x」' }),
      row({ id: 'c', title_key: 'notifications.reviewUnavailable', title: '完成审查暂未启用' }),
      row({ id: 'd', title_key: 'notifications.macroFailed', title_params: { name: 'x' }, title: '宏「x」执行失败' }),
    ];
    setLocale('zh-CN');
    expect(titlesOf(await mountOpenBell(rows))).toEqual([
      '宏「x」已到期', '宏「x」', '完成审查暂未启用', '宏「x」执行失败',
    ]);
    setLocale('en');
    expect(titlesOf(await mountOpenBell(rows))).toEqual([
      'Macro "x" expired', 'Macro "x"', 'Review-on-completion is not enabled yet', 'Macro "x" failed to run',
    ]);
  });
});

describe('#850 存量行与未登记键：原样显示 title', () => {
  it('只有旧文本的行（无 title_key）⇒ 原样渲染，两种 locale 下逐字相同', async () => {
    const legacy = row({ title_key: undefined, title_params: undefined });
    setLocale('zh-CN');
    const zh = titlesOf(await mountOpenBell([legacy]));
    setLocale('en');
    const en = titlesOf(await mountOpenBell([legacy]));
    expect(zh).toEqual(['宏「x」已到期']);
    expect(en).toEqual(zh);
  });

  it('title_key 没在 locales 登记 ⇒ te() 兜底退回 title（不裸露键名）', async () => {
    const stray = row({ title_key: 'notifications.notRegisteredAnywhere', title_params: { name: 'x' } });
    setLocale('en');
    const titles = titlesOf(await mountOpenBell([stray]));
    expect(titles).toEqual(['宏「x」已到期']);
    expect(titles[0]).not.toContain('notifications.');
  });
});
