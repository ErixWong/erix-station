// issue #808：徽标五态渲染 + 超额文案 + 弹窗空区间文案 + 点「重试」emit refresh。
// 事件观测不用 emitted()（#496 环境地板），走父级回调 + DOM 复述。
import { beforeEach, describe, expect, it } from 'vitest';
import { defineComponent, h, reactive } from 'vue';
import { mount } from '@vue/test-utils';
import UsageBadge from './UsageBadge.vue';
import { i18n, setLocale } from '../i18n';

function quota(over: Record<string, unknown> = {}) {
  return {
    budget_usd: 10, budget_period: '1mo', max_budget: 10, budget_duration: '1mo',
    budget_reset_at: '2026-12-01T00:00:00Z', spend: 2.05, remaining: 7.95, spend_scope: 'period',
    ...over,
  };
}

const base = {
  quota: null as unknown, reason: null as unknown, loading: false, loaded: true,
  error: null as unknown, days: [] as unknown[], totals: null as unknown,
  usageLoading: false, usageError: null as unknown,
};

function mountBadge(props: Record<string, unknown> = {}) {
  // UsageBadge 的 props 全为必填，test-utils 对全必填 props 的类型很严；测试只验渲染，props 转 any。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(UsageBadge, { props: { ...base, ...props } as any, global: { plugins: [i18n] } });
}

/** 事件复述宿主：把 refresh/open/refreshUsage 计数渲染进 DOM。 */
function mountBadgeHost(props: Record<string, unknown> = {}) {
  const seen = reactive({ refresh: 0, open: 0, refreshUsage: 0 });
  const Host = defineComponent({
    setup() {
      return () =>
        h('div', [
          h(UsageBadge, {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...(( { ...base, ...props,
              onRefresh: () => { seen.refresh += 1; },
              onOpen: () => { seen.open += 1; },
              onRefreshUsage: () => { seen.refreshUsage += 1; },
            }) as any),
          }),
          h('span', { 'data-test': 'host-refresh' }, String(seen.refresh)),
          h('span', { 'data-test': 'host-open' }, String(seen.open)),
        ]);
    },
  });
  return mount(Host, { global: { plugins: [i18n] } });
}

const DAY = { date: '2026-11-29', spend: 2.05, prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, api_requests: 1 };

/** 本地时区「今天往前 n 天」的 `YYYY-MM-DD`（窗口是滚动的，用例不钉死绝对日期）。 */
function localDayKeyBack(back: number): string {
  const d = new Date();
  d.setDate(d.getDate() - back);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 把某天包成一行日聚合（其余字段取占位值）。 */
function usageRow(date: string, spend: number) {
  return { date, spend, prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, api_requests: 1 };
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
});

describe('徽标五态', () => {
  it('未加载完：渲染「…」（不拿 — 冒充没有）', () => {
    const w = mountBadge({ quota: null, reason: null, loading: true, loaded: false, error: null });
    expect(w.get('[data-test="usage-badge"]').text()).toBe('…');
  });

  it('无绑定（quota==null && reason==no_binding）：整块不渲染', () => {
    const w = mountBadge({ quota: null, reason: 'no_binding', loading: false, loaded: true, error: null });
    expect(w.find('[data-test="usage-badge"]').exists()).toBe(false);
  });

  it('有额度（月）：`月 $2.05/$10.00`；title/aria-label 用完整词「本月」', () => {
    const w = mountBadge({ quota: quota() });
    const badge = w.get('[data-test="usage-badge"]');
    expect(badge.text()).toContain('月');
    expect(badge.text()).toContain('$2.05');
    expect(badge.text()).toContain('$10.00');
    expect(badge.classes()).toContain('whitespace-nowrap');
    const title = badge.attributes('title') ?? '';
    expect(title).toContain('本月');
    expect(badge.attributes('aria-label')).toBe(title);
  });

  it('有额度（日）：`日 …`', () => {
    const w = mountBadge({ quota: quota({ budget_duration: '1d', spend: 0.3, remaining: 0, max_budget: 0.3 }) });
    expect(w.get('[data-test="usage-badge"]').text()).toContain('日');
  });

  it('未设额度（lifetime）：`累 $5.09`，措辞绝不出现「本周期/本月」', () => {
    const w = mountBadge({ quota: quota({ spend_scope: 'lifetime', spend: 5.09, remaining: null }) });
    const badge = w.get('[data-test="usage-badge"]');
    expect(badge.text()).toContain('累');
    expect(badge.text()).toContain('$5.09');
    expect(badge.attributes('title') ?? '').not.toContain('本月');
    expect(badge.attributes('title') ?? '').not.toContain('本周期');
  });

  it('拿不到读数（error，首次就失败）：`—`，title 说明「暂时拿不到读数」', () => {
    const w = mountBadge({ quota: null, reason: null, loading: false, loaded: false, error: '网关不可达' });
    const badge = w.get('[data-test="usage-badge"]');
    expect(badge.text()).toBe('—');
    expect(badge.attributes('title')).toContain('暂时拿不到读数');
  });
});

describe('弹窗明细', () => {
  it('超额：进度满 + 「已超额 $0.09」，不显示负剩余', async () => {
    const w = mountBadge({
      quota: quota({ spend: 10.09, remaining: -0.09 }),
      days: [DAY],
    });
    await w.get('[data-test="usage-badge"]').trigger('click');
    expect(w.get('[data-test="usage-overage"]').text()).toContain('已超额 $0.09');
    expect(w.find('[data-test="usage-progress"]').exists()).toBe(true);
    expect(w.find('[data-test="usage-remaining"]').exists()).toBe(false);
  });

  it('未设额度：只说「未设额度，当前为终身累计 $5.09」，不出进度/剩余两段', async () => {
    const w = mountBadge({ quota: quota({ spend_scope: 'lifetime', spend: 5.09, remaining: null }), days: [DAY] });
    await w.get('[data-test="usage-badge"]').trigger('click');
    expect(w.get('[data-test="usage-lifetime"]').text()).toContain('未设额度，当前为终身累计 $5.09');
    expect(w.find('[data-test="usage-progress"]').exists()).toBe(false);
    expect(w.find('[data-test="usage-remaining"]').exists()).toBe(false);
  });

  it('待载（pending）点开弹窗：只显「正在读取…」，绝不出未设额度文案与 — 金额', async () => {
    // 徽标还在 … 时点开：不得把「未确认」当成「未设额度」，也不得拿 — 冒充金额。
    const w = mountBadge({ quota: null, reason: null, loading: true, loaded: false, error: null });
    await w.get('[data-test="usage-badge"]').trigger('click');
    expect(w.find('[data-test="usage-pending"]').exists()).toBe(true);
    expect(w.find('[data-test="usage-lifetime"]').exists()).toBe(false);
    const body = w.text();
    expect(body).not.toContain('未设额度');
    expect(body).not.toContain('—');
  });

  it('30 天窗口：一条日行都没有 ⇒ 30 个 0 点（贴底 0 线是诚实结论），**不**退化成空态', async () => {
    // 缺陷 1 回归钉：缺行 = 那天没请求 = 花 0，不是「无数据」。
    const w = mountBadge({ quota: quota(), days: [] });
    await w.get('[data-test="usage-badge"]').trigger('click');
    const line = w.get('[data-test="metric-chart-line"]');
    expect((line.attributes('d') ?? '').length).toBeGreaterThan(0);
    // 折线画得出 ⇒ 空态文案已退场（常驻 DOM 但 aria-hidden/opacity-0）
    expect(w.get('[data-test="metric-chart-svg"]').attributes('aria-hidden')).toBe('false');
    const empty = w.get('[data-test="metric-chart-empty"]');
    expect(empty.attributes('aria-hidden')).toBe('true');
    expect(empty.classes()).toContain('opacity-0');
    // 30 个全 0 的点 ⇒ y 轴两端都是 $0.00（而不是不标）
    expect(w.get('[data-test="metric-chart-y-max"]').text()).toBe('$0.00');
  });

  it('只有 1 行日行：不再显「该区间无数据」，窗口被补成 30 点并画出真线', async () => {
    const w = mountBadge({ quota: quota(), days: [usageRow(localDayKeyBack(1), 0.39)] });
    await w.get('[data-test="usage-badge"]').trigger('click');
    const empty = w.get('[data-test="metric-chart-empty"]');
    expect(empty.attributes('aria-hidden')).toBe('true');
    expect(empty.classes()).toContain('opacity-0');
    const d = w.get('[data-test="metric-chart-line"]').attributes('d') ?? '';
    expect(d.length).toBeGreaterThan(0);
    // 30 个点 ⇒ 30 段（1 个 M + 29 个 L），证明窗口被补齐而不是只喂那一行
    expect((d.match(/L/g) ?? []).length).toBe(29);
  });

  it('横轴两端是日期 `MM-DD`（日粒度下 `HH:mm` 永远 `00:00`，零信息）', async () => {
    const w = mountBadge({ quota: quota(), days: [usageRow(localDayKeyBack(1), 0.39)] });
    await w.get('[data-test="usage-badge"]').trigger('click');
    const start = w.get('[data-test="metric-chart-x-start"]').text();
    const end = w.get('[data-test="metric-chart-x-end"]').text();
    expect(start).toMatch(/^\d{2}-\d{2}$/);
    expect(end).toMatch(/^\d{2}-\d{2}$/);
    expect(start).not.toBe(end);
    // 钉住今天（本地）作为窗口右端
    const p = (n: number) => String(n).padStart(2, '0');
    const now = new Date();
    expect(end).toBe(`${p(now.getMonth() + 1)}-${p(now.getDate())}`);
  });

  it('拿不到数据：usageError 非空 ⇒ 出 note 那句，且不画假线、不出贴底 0 线', async () => {
    const w = mountBadge({ quota: quota(), days: [], usageError: '网关不可达' });
    await w.get('[data-test="usage-badge"]').trigger('click');
    const empty = w.get('[data-test="metric-chart-empty"]');
    expect(empty.text()).toContain('网关不可达');
    expect(empty.attributes('aria-hidden')).toBe('false');
    expect(w.get('[data-test="metric-chart-line"]').attributes('d')).toBe('');
    expect(w.get('[data-test="metric-chart-svg"]').attributes('aria-hidden')).toBe('true');
  });

  it('近 30 天合计：totals.spend 有值 ⇒ 出「近 30 天合计 $X」', async () => {
    const w = mountBadge({ quota: quota(), days: [DAY], totals: { spend: 3.5, total_tokens: 450 } });
    await w.get('[data-test="usage-badge"]').trigger('click');
    expect(w.get('[data-test="usage-totals"]').text()).toContain('近 30 天合计 $3.50');
  });

  it('totals 缺失 ⇒ 合计那一行不渲染（不拿 $0.00 冒充）', async () => {
    const w = mountBadge({ quota: quota(), days: [DAY], totals: null });
    await w.get('[data-test="usage-badge"]').trigger('click');
    expect(w.find('[data-test="usage-totals"]').exists()).toBe(false);
    expect(w.text()).not.toContain('近 30 天合计');
  });

  it('进度条用蓝色族（与 MetricChart 同族），不是品牌绿', async () => {
    const w = mountBadge({ quota: quota(), days: [DAY] });
    await w.get('[data-test="usage-badge"]').trigger('click');
    const bar = w.get('[data-test="usage-progress"] > div');
    expect(bar.classes()).toContain('bg-blue-600');
    expect(bar.classes()).not.toContain('bg-brand');
    expect(w.get('[data-test="usage-progress"]').classes()).toContain('bg-black/10');
  });

  it('有额度常规：已用/额度/剩余/清零都在；清零用「清零」不写「已清零」', async () => {
    const w = mountBadge({ quota: quota(), days: [DAY] });
    await w.get('[data-test="usage-badge"]').trigger('click');
    expect(w.get('[data-test="usage-used"]').text()).toContain('已用 $2.05');
    expect(w.get('[data-test="usage-remaining"]').text()).toContain('$7.95');
    const reset = w.get('[data-test="usage-reset"]').text();
    expect(reset).toContain('清零');
    expect(reset).not.toContain('已清零');
    // title 用完整词，不复用窄标签黑话
    expect(w.get('[data-test="usage-badge"]').attributes('title')).toContain('本月');
  });
});

describe('事件契约（父级回调 + DOM 复述）', () => {
  it('点「重试」emit refresh', async () => {
    const w = mountBadgeHost({ quota: null, reason: null, loading: false, loaded: false, error: '网关不可达' });
    // unknown 态徽标渲染，点开 → 空态 → 重试
    await w.get('[data-test="usage-badge"]').trigger('click');
    await w.get('[data-test="usage-retry"]').trigger('click');
    expect(w.get('[data-test="host-refresh"]').text()).toBe('1');
  });

  it('打开弹窗 emit open（调用方去 loadUsage）', async () => {
    const w = mountBadgeHost({ quota: quota(), days: [] });
    expect(w.get('[data-test="host-open"]').text()).toBe('0');
    await w.get('[data-test="usage-badge"]').trigger('click');
    expect(w.get('[data-test="host-open"]').text()).toBe('1');
  });
});
