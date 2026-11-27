// `MacroDrawer.vue` 的单测（issue #528）——`07` §21.5 指定五类判据，**不做快照测试**。
//   ① 空态四选一      ② 跳过聚合      ③ 判决映射      ④ 成本缺失      ⑤ 健康告警位置
// 外加 §11 的形态红线（覆盖式遮罩 + 右侧面板，**任何宽度都不并排**）与 §12 的
// 「附注行按数据有无显示」。断言一律读 DOM，不用 `w.emitted()`。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import MacroDrawer from './MacroDrawer.vue';
import { i18n, setLocale } from '../i18n';
import { useMacroStore } from '../stores/macro';
import type { MacroAssignment, MacroRun } from '../lib/macroView';

const SESSION = '11111111-1111-4111-8111-111111111111';
/** 固定时钟（判据⑤要判「47 分钟前」这类相对时刻，必须钉住 now）。 */
const NOW = Date.parse('2026-11-16T06:40:00.000Z');

function assignment(over: Partial<MacroAssignment> = {}): MacroAssignment {
  return {
    id: 'a-1', templateId: 't-review', sessionId: SESSION, until: null,
    enabled: true, expired: false, effectiveEnabled: true,
    lastEvaluatedAt: '2026-11-16T06:39:30.000Z', createdAt: null,
    ...over,
  };
}

function run(over: Partial<MacroRun> = {}): MacroRun {
  return {
    id: 'r-1', assignmentId: 'a-1', anchor: 'run 9f3a', status: 'done', criterion: 'terminal',
    verdict: 'pass', skippedReason: null, actionText: '审查完成',
    reason: null, remediationText: null,
    startedAt: '2026-11-16T06:03:12.000Z', finishedAt: '2026-11-16T06:07:24.000Z',
    depth: 0, childSessionId: null, childRunId: null, usage: null, pending: false,
    ...over,
  };
}

/** 抽屉挂载时子组件会拉模板；这里给一个只读模板桩。 */
function stubTemplates(): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    items: [
      { id: 't-review', kind: 'run-review', name: '完成审查 · 默认', params: {}, scope: 'session', audience: 'all' },
      { id: 't-daily', kind: 'scheduled-task', name: '每日 9 点', params: {}, scope: 'user', audience: 'all' },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
}

let pinia: Pinia;

function mountDrawer(props: Record<string, unknown> = {}) {
  return mount(MacroDrawer, {
    props: { sessionId: SESSION, ...props },
    global: { plugins: [i18n, pinia] },
    attachTo: document.body,
  });
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  document.body.innerHTML = '';
  pinia = createPinia();
  setActivePinia(pinia);
  stubTemplates();
});

describe('判据①：空态四选一（技术态与业务态各说各的）', () => {
  it('首次加载中 ⇒ 只渲染加载中，不渲染空态文案', async () => {
    const macro = useMacroStore();
    macro.assignments = [assignment()];
    macro.runsLoading = true;
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="macro-loading"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="macro-empty"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('加载中');
  });

  it('加载失败 ⇒ 「加载失败」+ 重试按钮 + 错误原文（不伪装成空）', async () => {
    const macro = useMacroStore();
    macro.assignments = [assignment()];
    macro.runsFailed = true;
    macro.runsErrorText = 'HTTP 500';
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    const error = wrapper.find('[data-test="macro-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain('加载失败');
    expect(wrapper.find('[data-test="macro-error-detail"]').text()).toContain('HTTP 500');
    expect(wrapper.find('[data-test="macro-retry"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="macro-empty"]').exists()).toBe(false);
  });

  it('无订阅 ⇒ 「这个会话没挂模板」+ 一个直达下拉的按钮', async () => {
    const macro = useMacroStore();
    macro.assignments = [];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    const empty = wrapper.find('[data-test="macro-empty"]');
    expect(empty.text()).toContain('这个会话没挂模板');
    expect(wrapper.find('[data-test="macro-empty-configure"]').exists()).toBe(true);
  });

  it('有订阅未触发 ⇒ 说清「启用 N 个、还没触发过」并带上上次评估时刻', async () => {
    const macro = useMacroStore();
    macro.assignments = [assignment({ lastEvaluatedAt: '2026-11-16T06:39:12.000Z' })];
    macro.runs = [];
    macro.setClock(() => NOW);
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    const empty = wrapper.find('[data-test="macro-empty"]');
    expect(empty.text()).toContain('已启用 1 个，还没触发过');
    expect(empty.text()).toMatch(/14:39:12|06:39:12/);
  });

  it('筛选后为空 ⇒ 「没有匹配的记录」+ 清除筛选（不写成「没挂模板」）', async () => {
    const macro = useMacroStore();
    macro.assignments = [assignment()];
    macro.runs = [run()];
    macro.setTemplateFilter('t-other');   // 没有订阅指向这个模板 ⇒ 本地筛后为空
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="macro-empty"]').text()).toContain('没有匹配的记录');
    expect(wrapper.find('[data-test="macro-empty-clear"]').exists()).toBe(true);
  });
});

describe('判据②：跳过聚合（连续同因**一条**汇总行，不同因不合并）', () => {
  it('连续 3 次静默时段 + 连续 2 次额度用完 ⇒ 两条汇总行，条数各为 3 / 2', async () => {
    const macro = useMacroStore();
    macro.assignments = [assignment()];
    macro.runs = [
      run({ id: 'r-top', verdict: 'pass' }),
      run({ id: 'q-3', status: 'skipped', verdict: null, skippedReason: 'quiet_hours', actionText: null }),
      run({ id: 'q-2', status: 'skipped', verdict: null, skippedReason: 'quiet_hours', actionText: null }),
      run({ id: 'q-1', status: 'skipped', verdict: null, skippedReason: 'quiet_hours', actionText: null }),
      run({ id: 'b-2', status: 'skipped', verdict: null, skippedReason: 'budget_exhausted', actionText: null }),
      run({ id: 'b-1', status: 'skipped', verdict: null, skippedReason: 'budget_exhausted', actionText: null }),
      run({ id: 'r-bottom', verdict: 'red', actionText: '整改 · 3 个未跟踪文件' }),
    ];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();

    const groups = wrapper.findAll('[data-test="macro-skip-group"]');
    expect(groups).toHaveLength(2);
    expect(groups[0].attributes('data-reason')).toBe('quiet_hours');
    expect(groups[0].attributes('data-count')).toBe('3');
    expect(groups[1].attributes('data-reason')).toBe('budget_exhausted');
    expect(groups[1].attributes('data-count')).toBe('2');
    // 主列表只留汇总行：5 次跳过在列表里各只占一条（普通记录仍是 2 条）。
    expect(wrapper.findAll('[data-test="macro-run"]')).toHaveLength(2);
    // 人话而不是原始枚举，且带「最近 N 次同原因」。
    expect(groups[0].text()).toContain('静默时段');
    expect(groups[0].text()).toContain('最近 3 次同原因');
    expect(groups[0].text()).not.toContain('quiet_hours');
    expect(groups[1].text()).toContain('今日额度用完');
    expect(groups[1].text()).not.toContain('budget_exhausted');
  });

  it('不同因**不合并**（静默 / 额度 / 静默 = 三条，即便首尾同因）', async () => {
    const macro = useMacroStore();
    macro.assignments = [assignment()];
    macro.runs = [
      run({ id: 'q-a', status: 'skipped', verdict: null, skippedReason: 'quiet_hours' }),
      run({ id: 'b-1', status: 'skipped', verdict: null, skippedReason: 'budget_exhausted' }),
      run({ id: 'q-b', status: 'skipped', verdict: null, skippedReason: 'quiet_hours' }),
    ];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    const groups = wrapper.findAll('[data-test="macro-skip-group"]');
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.attributes('data-count'))).toEqual(['1', '1', '1']);
  });

  it('`human_present` 写中性事实，不归责用户（不出现「因为你在说话」）', async () => {
    const macro = useMacroStore();
    macro.assignments = [assignment()];
    macro.runs = [run({ id: 'h-1', status: 'skipped', verdict: null, skippedReason: 'human_present' })];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    const text = wrapper.find('[data-test="macro-skip-group"]').text();
    expect(text).toContain('你刚发了消息，不插话');
    expect(text).not.toContain('因为你在说话');
  });
});

describe('判据③：判决映射（五个 verdict 各自渲染成 §6.1 的词）', () => {
  it('pass / red / no-op-claim / needs-human / unclassified ⇒ 通过 / 整改 / 未证实有改动 / 需人工 / 未判', async () => {
    const macro = useMacroStore();
    macro.assignments = [assignment()];
    macro.runs = [
      run({ id: 'v-1', verdict: 'pass' }),
      run({ id: 'v-2', verdict: 'red' }),
      run({ id: 'v-3', verdict: 'no-op-claim' }),
      run({ id: 'v-4', verdict: 'needs-human' }),
      run({ id: 'v-5', verdict: 'unclassified' }),
    ];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();

    const nodes = wrapper.findAll('[data-test="macro-verdict"]');
    expect(nodes).toHaveLength(5);
    const seen = Object.fromEntries(nodes.map((n) => [n.attributes('data-verdict'), n.text()]));
    expect(seen).toEqual({
      pass: '通过',
      red: '整改',
      'no-op-claim': '未证实有改动',
      'needs-human': '需人工',
      unclassified: '未判',
    });
    // 原始枚举不承重也不外泄。
    expect(wrapper.text()).not.toContain('no-op-claim');
  });

  it('未知判决退回「未判」，不是空白也不是原始字面量', async () => {
    const macro = useMacroStore();
    macro.assignments = [assignment()];
    macro.runs = [run({ id: 'v-x', verdict: 'quantum-flux' })];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="macro-verdict"]').text()).toBe('未判');
  });
});

describe('A2/#850：宏 run 的 reason 渲染（已知码走 i18n、未知值原样、不吞）', () => {
  it('已知机器码 dispatch_failed:unknown_template_kind ⇒ zh 出「分派失败：未知的模板类型」', async () => {
    setLocale('zh-CN');
    const macro = useMacroStore();
    macro.assignments = [assignment()];
    macro.runs = [run({ id: 'd-1', status: 'failed', verdict: null, remediationText: null, reason: 'dispatch_failed:unknown_template_kind' })];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="macro-run-action"]').text()).toBe('分派失败：未知的模板类型');
  });

  it('同一码切到 en ⇒ 出 Dispatch failed: unknown template kind.', async () => {
    setLocale('en');
    const macro = useMacroStore();
    macro.assignments = [assignment()];
    macro.runs = [run({ id: 'd-2', status: 'failed', verdict: null, remediationText: null, reason: 'dispatch_failed:unknown_template_kind' })];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="macro-run-action"]').text()).toBe('Dispatch failed: unknown template kind.');
  });

  it('未知 reason 值原样显示（不吞、不渲染成空、不退到「已执行」）', async () => {
    setLocale('zh-CN');
    const macro = useMacroStore();
    macro.assignments = [assignment()];
    macro.runs = [run({ id: 'd-3', status: 'failed', verdict: null, remediationText: null, reason: 'dispatch_failed: 模型炸了' })];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    const el = wrapper.find('[data-test="macro-run-action"]');
    expect(el.text()).toBe('dispatch_failed: 模型炸了');
    expect(el.text()).not.toBe('已执行');
    expect(el.text()).not.toBe('');
  });

  it('有整改人话时优先原样显示 remediationText，不走 i18n、不被 reason 顶掉', async () => {
    const macro = useMacroStore();
    macro.assignments = [assignment()];
    macro.runs = [run({ id: 'd-4', status: 'done', verdict: 'red', remediationText: '已自动整改，补了两个测试', reason: 'some-code' })];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="macro-run-action"]').text()).toBe('已自动整改，补了两个测试');
  });
});

describe('判据④：成本缺失（无 usage 不渲染 `↑0 ↓0`）', () => {
  it('没有 usage ⇒ 不出现 `↑0 ↓0`，附注行整段不渲染', async () => {
    const macro = useMacroStore();
    macro.assignments = [assignment()];
    macro.runs = [run({ id: 'c-1', usage: null, finishedAt: null, depth: 0 })];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('↑0');
    expect(wrapper.text()).not.toContain('↓0');
    expect(wrapper.find('[data-test="macro-run-cost"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="macro-run-note"]').exists()).toBe(false);
    // 汇总也不补 0：写「用量未知」。
    expect(wrapper.find('[data-test="macro-cost-tokens"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="macro-cost-unknown"]').text()).toContain('用量未知');
  });

  it('有 usage ⇒ 逐条实测 `↑82k ↓3.1k`，汇总是 token；单价未定 ⇒ 不出现金额', async () => {
    const macro = useMacroStore();
    macro.assignments = [assignment()];
    macro.runs = [run({ id: 'c-2', usage: { inputTokens: 82000, outputTokens: 3100 } })];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="macro-run-cost"]').text()).toBe('↑82k ↓3.1k');
    expect(wrapper.find('[data-test="macro-cost-tokens"]').text()).toContain('↑82k ↓3.1k');
    expect(wrapper.find('[data-test="macro-cost-estimate-toggle"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('¥');
  });

  it('给了单价 ⇒ 金额出现但**默认折叠**，点开关才显示且标「估算」', async () => {
    const macro = useMacroStore();
    macro.assignments = [assignment()];
    macro.runs = [run({ id: 'c-3', usage: { inputTokens: 1000000, outputTokens: 38000 } })];
    // 单价**给了**（每 token）：金额可以出现，但必须带「估算」且默认折叠（`07` §15 第 3 条）。
    const wrapper = mountDrawer({ price: { inputPerToken: 0.000003, outputPerToken: 0.000012 } });
    await wrapper.vm.$nextTick();
    // 默认折叠：没点开关就不该有金额行。
    expect(wrapper.find('[data-test="macro-cost-estimate"]').exists()).toBe(false);
    await wrapper.find('[data-test="macro-cost-estimate-toggle"]').trigger('click');
    const estimate = wrapper.find('[data-test="macro-cost-estimate"]');
    expect(estimate.exists()).toBe(true);
    expect(estimate.text()).toContain('估算');
  });
});

describe('判据⑤：健康告警位置（顶部状态条，不在空态区）', () => {
  it('水位线陈旧 + 有订阅未触发 ⇒ 告警在顶部状态条，空态文案里不重复', async () => {
    const macro = useMacroStore();
    macro.setClock(() => NOW);
    macro.assignments = [assignment({ lastEvaluatedAt: '2026-11-16T05:53:00.000Z' })];
    macro.runs = [];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();

    const health = wrapper.find('[data-test="macro-health"]');
    expect(health.exists()).toBe(true);
    expect(health.text()).toContain('上次评估在');
    expect(health.text()).toContain('宏可能不生效');
    // 预期频率（`07` §17.3 要求「最后时刻 + 预期频率 + 下一步」三个信息）。
    expect(health.text()).toContain('60');

    const empty = wrapper.find('[data-test="macro-empty"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).not.toContain('宏可能不生效');

    // 位置判据：状态条在 DOM 里排在空态区**之前**（顶部），不是塞在列表容器里。
    const all = wrapper.findAll('[data-test="macro-drawer"] > *');
    const nodes = all.map((w) => w.element);
    expect(nodes.indexOf(health.element)).toBeLessThan(nodes.indexOf(empty.element));
  });

  it('水位线新鲜 ⇒ 顶部状态条不出现（哪怕一条记录都没有）', async () => {
    const macro = useMacroStore();
    macro.setClock(() => NOW);
    macro.assignments = [assignment({ lastEvaluatedAt: '2026-11-16T06:39:30.000Z' })];
    macro.runs = [];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="macro-health"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="macro-empty"]').exists()).toBe(true);
  });

  it('刚建的首次订阅（null 且在宽限窗内）⇒ 顶部不出现 ⚠，卡片写「尚未评估」（#615 不再狼来了）', async () => {
    const macro = useMacroStore();
    macro.setClock(() => NOW);
    macro.assignments = [assignment({ lastEvaluatedAt: null, createdAt: new Date(NOW).toISOString() })];
    macro.runs = [];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    // 不再占据顶部告警位（这是旧代码的 bug：每个新订阅都闪一次 ⚠）
    expect(wrapper.find('[data-test="macro-health"]').exists()).toBe(false);
    // 唯一的中性信号：订阅卡片上写「尚未评估」而不是一个具体时刻
    expect(wrapper.find('[data-test="macro-last-evaluated"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="macro-last-evaluated"]').text()).not.toContain('0 分钟前');
  });

  it('首次订阅且过了宽限窗（null 仍没推进）⇒ 顶部 ⚠ 说「还没被评估过」而不是「0 分钟前」', async () => {
    const macro = useMacroStore();
    macro.setClock(() => NOW);
    macro.assignments = [assignment({ lastEvaluatedAt: null, createdAt: new Date(NOW - 10 * 60_000).toISOString() })];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    const health = wrapper.find('[data-test="macro-health"]');
    expect(health.find('[data-test="macro-health-never"]').exists()).toBe(true);
    expect(health.text()).not.toContain('0 分钟前');
  });

  it('订阅卡片显示「上次评估 HH:MM:SS」（用户能看到的唯一平台健康信号）', async () => {
    const macro = useMacroStore();
    macro.setClock(() => NOW);
    macro.assignments = [assignment({ lastEvaluatedAt: '2026-11-16T06:03:12.000Z' })];
    macro.runs = [run()];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    const card = wrapper.find('[data-test="macro-last-evaluated"]');
    expect(card.text()).toMatch(/上次评估.*(14:03:12|06:03:12)/);
  });
});

describe('形态红线（`07` §11 / §21.2：覆盖式右抽屉，任何宽度都不并排）', () => {
  it('遮罩是 `fixed inset-0`，面板是 `right-0` 覆盖 + ≥1024px 取 520px + <768px 有返回箭头', async () => {
    const macro = useMacroStore();
    macro.assignments = [assignment()];
    macro.runs = [run()];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();

    const root = wrapper.find('[data-test="macro-drawer-root"]');
    expect(root.classes()).toContain('fixed');
    expect(root.classes()).toContain('inset-0');

    const panel = wrapper.find('[data-test="macro-drawer"]');
    const classes = panel.classes();
    expect(classes).toContain('inset-y-0');
    expect(classes).toContain('right-0');
    // 三档宽度：`w-full`（<768）→ `md:max-w-md`（768–1023）→ `lg:w-[520px]`（≥1024）。
    expect(classes).toContain('w-full');
    expect(classes).toContain('md:max-w-md');
    expect(classes).toContain('lg:w-[520px]');
    // 并排的做法（把消息流挤窄）在本面板里不存在：面板不在文档流里。
    expect(classes).not.toContain('flex-row');

    expect(wrapper.find('[data-test="macro-back"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="macro-close"]').exists()).toBe(true);
  });

  it('用户看不到 `snapshot_id` / `worktree_path`：整段 DOM 文本里没有这两个词', async () => {
    const macro = useMacroStore();
    macro.assignments = [assignment()];
    macro.runs = [run({ id: 'x-1' })];
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('snapshot_id');
    expect(wrapper.text()).not.toContain('worktree_path');
  });

  it('有未完成的记录才显示状态为「进行中」，且抽屉关闭会停轮询', async () => {
    const macro = useMacroStore();
    macro.assignments = [assignment()];
    macro.runs = [run({ id: 'p-1', status: 'running', finishedAt: null, pending: true })];
    macro.drawerOpen = true;
    const wrapper = mountDrawer();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="macro-status"]').text()).toBe('进行中');

    await wrapper.find('[data-test="macro-close"]').trigger('click');
    expect(macro.drawerOpen).toBe(false);
  });
});

// #614：顶栏用户级 chip 开的是「无会话」形态抽屉——卡片必须显示用户级模板而不是会话模板。
describe('用户级形态（sessionId=null，issue #614）', () => {
  it('卡片列用户级模板（scope=user）而不是会话模板', async () => {
    const wrapper = mountDrawer({ sessionId: null });
    await flushPromises();   // 等 MacroMenu onMounted 的 loadTemplates 落地（fetch 桩）
    await wrapper.vm.$nextTick();
    // stubTemplates 里的用户级模板名：'每日 9 点'（scope='user'）
    const cards = wrapper.findAll('[data-test="macro-subscription-card"]').map((w) => w.text());
    expect(cards.some((tx) => tx.includes('每日 9 点'))).toBe(true);
    // 会话级模板名 '完成审查 · 默认'（scope='session'）不该出现在用户级卡片里
    expect(cards.some((tx) => tx.includes('完成审查'))).toBe(false);
  });

  it('sessionId=null 时仍渲染抽屉根节点（无会话也要能开）', async () => {
    const wrapper = mountDrawer({ sessionId: null });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="macro-drawer"]').exists()).toBe(true);
  });
});
