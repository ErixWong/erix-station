// StreamPanel 工具卡片单测（issue #85）：折叠交互（默认收起/点击展开收起/chevron 旋转）、
// 单行语义摘要、ok/err 分级色（左边框 + 工具名/✗ 变红）、耗时显示、展开态跨重渲染不丢、
// clearExpandedToolCalls 复位。store 状态直填，不碰真实后端/SSE。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import StreamPanel from './StreamPanel.vue';
import { useWorkbenchStore } from '../stores/workbench';
import { clearExpandedToolCalls } from '../lib/toolCallExpansion';
import { i18n, setLocale } from '../i18n';

// issue #101 P2：装配真实 i18n 单例（组件内 useI18n() 需要），本文件多处 mount 统一经此助手。
function mountPanel() {
  return mount(StreamPanel, { global: { plugins: [i18n] } });
}

beforeEach(() => {
  // 每例重置语言为 zh-CN（既有中文断言逐字不变）。
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
  clearExpandedToolCalls();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"items":[]}', { status: 200 })));
});

function setup(cards: Record<string, { name: string; dig: string; args: string; ok: boolean | null; out: string; dur?: number }>) {
  const store = useWorkbenchStore();
  for (const [callId, card] of Object.entries(cards)) {
    store.es.toolCards.set(callId, card);
    store.entries.push({ kind: 'tool', callId });
  }
  const wrapper = mountPanel();
  return { store, wrapper };
}

function cardBtn(wrapper: ReturnType<typeof mount>) {
  return wrapper.get('button[aria-expanded]');
}

describe('消息渲染（pi-web 风格对齐）', () => {
  it('助手终稿与流式增量均为 .msg.assistant.md；助手无气泡（无背景类），用户消息右对齐气泡', () => {
    const store = useWorkbenchStore();
    store.renderedIds = new Set();
    store.addMessage({ id: 'm1', role: 'assistant', content: '# 标题\n正文' });
    store.addMessage({ id: 'm2', role: 'user', content: '用户输入' });
    store.entries.push({ kind: 'delta', text: '增量 **粗体**' });
    const wrapper = mountPanel();
    const assistant = wrapper.get('.msg.assistant.md');
    expect(assistant.html()).toContain('<h1>标题</h1>');
    const delta = wrapper.get('div.msg.assistant.md ~ div.msg.assistant.md');
    expect(delta.html()).toContain('<strong>粗体</strong>');
    expect(delta.classes()).toEqual(expect.arrayContaining(['msg', 'assistant', 'md']));
    const user = wrapper.get('.msg.user');
    expect(user.text()).toBe('用户输入');
    expect(user.classes()).not.toContain('md');
  });

  it('流式增量半截 ``` 容错：未闭合围栏吞到文末收尾，不产出未闭合标签', () => {
    const store = useWorkbenchStore();
    store.entries.push({ kind: 'delta', text: '说明\n```ts\nconst a = 1' });
    const wrapper = mountPanel();
    const delta = wrapper.get('.msg.assistant.md');
    expect(delta.find('.md-code').exists()).toBe(true);
    expect(delta.find('.md-lang').text()).toBe('ts');
    expect(delta.get('.md-code pre code').text()).toContain('const a = 1');
  });
});

describe('分隔行渲染（roundsep）', () => {
  it('judge variant 渲染为黄色面板 .roundsep.judge-panel；普通 sep 保持灰色 .roundsep', () => {
    const store = useWorkbenchStore();
    store.entries.push({ kind: 'sep', text: 'round 2' });
    store.entries.push({ kind: 'sep', text: 'judge：建议扩轮 — P（R）', variant: 'judge' });
    const wrapper = mountPanel();
    const seps = wrapper.findAll('.roundsep');
    expect(seps).toHaveLength(2);
    expect(seps[0].classes()).toEqual(['roundsep']);
    expect(seps[1].classes()).toEqual(['roundsep', 'judge-panel']);
    expect(seps[1].text()).toBe('judge：建议扩轮 — P（R）');
  });

  // issue #321：judge 意见行（done=true）只是黄色面板分隔行——它**不是**终态分隔条：
  // 不渲染成 .syserr，也不自带「run 结束」终态文本（终态只由 run_end 产生）。
  it('issue #321：judge done=true 意见行只产 judge-panel 分隔行，不产终态分隔条（.syserr / run 结束）', () => {
    const store = useWorkbenchStore();
    store.entries.push({
      kind: 'sep',
      text: i18n.global.t('stream.event.judgeAxes', { axes: i18n.global.t('stream.event.judgeGoalDoneTrue') }),
      variant: 'judge',
    });
    const wrapper = mountPanel();
    const seps = wrapper.findAll('.roundsep');
    expect(seps).toHaveLength(1);
    expect(seps[0].classes()).toEqual(['roundsep', 'judge-panel']);
    expect(seps[0].text()).toContain('未独立核验');
    expect(seps[0].text()).not.toMatch(/已完成|已核验|已验证/);
    expect(wrapper.find('.syserr').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('run 结束');
  });
});

describe('工具卡片折叠（issue #85）', () => {
  it('默认折叠：只有头部 button，无 pre 结果区', () => {
    const { wrapper } = setup({ c1: { name: 'bash', dig: '{}', args: '{"command":"ls"}', ok: null, out: '' } });
    const btn = cardBtn(wrapper);
    expect(btn.attributes('aria-expanded')).toBe('false');
    expect(btn.text()).toContain('bash');
    expect(wrapper.find('pre').exists()).toBe(false);
  });

  it('点击展开：显示完整 args 的 pre 块 + 结果行；chevron rotate-180；再点收起', async () => {
    const { wrapper } = setup({
      c1: { name: 'bash', dig: '', args: '{"command":"ls -la"}', ok: true, out: '✓ done（12ms）', dur: 12 },
    });
    await cardBtn(wrapper).trigger('click');
    expect(cardBtn(wrapper).attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('pre').text()).toContain('{"command":"ls -la"}');
    // pre 防溢出三件套
    expect(wrapper.get('pre').classes()).toEqual(expect.arrayContaining(['whitespace-pre-wrap', 'break-all', 'overflow-auto']));
    expect(wrapper.text()).toContain('✓ done（12ms）');
    // chevron 旋转
    expect(cardBtn(wrapper).find('.rotate-180').exists()).toBe(true);
    expect(cardBtn(wrapper).find('.transition-transform').exists()).toBe(true);
    // 收起
    await cardBtn(wrapper).trigger('click');
    expect(wrapper.find('pre').exists()).toBe(false);
    expect(cardBtn(wrapper).find('.rotate-180').exists()).toBe(false);
  });

  it('展开状态跨组件重渲染不丢（SSE 补发/重挂载场景），clear 后回到默认收起', async () => {
    const store = useWorkbenchStore();
    store.es.toolCards.set('c1', { name: 'bash', dig: '', args: '{"command":"x"}', ok: null, out: '' });
    store.entries.push({ kind: 'tool', callId: 'c1' });
    const first = mountPanel();
    await first.get('button[aria-expanded]').trigger('click');
    expect(first.get('button[aria-expanded]').attributes('aria-expanded')).toBe('true');
    first.unmount();
    // 模拟事件补发重建 entries + 组件重挂载：展开态应从模块记忆回灌
    store.entries = [{ kind: 'tool', callId: 'c1' }];
    const second = mountPanel();
    expect(second.get('button[aria-expanded]').attributes('aria-expanded')).toBe('true');
    // 离开会话路径（workbench 挂 clearExpandedToolCalls）的等价效果
    clearExpandedToolCalls();
    store.entries = [{ kind: 'tool', callId: 'c1' }];
    second.unmount();
    const third = mountPanel();
    expect(third.get('button[aria-expanded]').attributes('aria-expanded')).toBe('false');
  });

  it('单行摘要取语义键（command 等），折叠态头部可见工具名/摘要/状态', () => {
    const { wrapper } = setup({
      c1: { name: 'bash', dig: '{"command":"ls -la"}', args: '{"command":"ls -la","timeout":30}', ok: null, out: '' },
    });
    const btn = cardBtn(wrapper);
    expect(btn.text()).toContain('ls -la');
    expect(btn.text()).not.toContain('timeout');
    // 摘要 ellipsis 三件套 + 占满剩余宽
    const summary = btn.get('span.overflow-hidden');
    expect(summary.classes()).toEqual(expect.arrayContaining(['text-ellipsis', 'whitespace-nowrap', 'flex-1', 'min-w-0']));
  });

  it('args 解析失败回退 dig；args 为空显示「参数生成中」', () => {
    const { wrapper } = setup({
      c1: { name: 't', dig: 'dig-fallback', args: 'not json', ok: null, out: '' },
      c2: { name: 'u', dig: '', args: '', ok: null, out: '' },
    });
    const btns = wrapper.findAll('button[aria-expanded]');
    expect(btns[0].text()).toContain('dig-fallback');
    expect(btns[1].text()).toContain('（参数生成中…）');
  });

  it('ok/err 分级：左边框色 + 工具名/✗ 红 + 耗时；null 显示 …', () => {
    const { wrapper } = setup({
      ok1: { name: 'a', dig: '', args: '{}', ok: true, out: '', dur: 5 },
      err1: { name: 'b', dig: '', args: '{}', ok: false, out: '', dur: 7 },
      null1: { name: 'c', dig: '', args: '{}', ok: null, out: '' },
    });
    const cards = wrapper.findAll('.border-l-4');
    expect(cards[0].classes()).toContain('border-l-green-600');
    expect(cards[1].classes()).toContain('border-l-red-600');
    expect(cards[2].classes()).toContain('border-l-neutral-500');
    expect(cards[0].get('button').text()).toContain('✓ 5ms');
    expect(cards[1].get('button').text()).toContain('✗ 7ms');
    expect(cards[1].get('button').find('.text-red-600').exists()).toBe(true);
    expect(cards[2].get('button').text()).toContain('…');
  });

  // issue #283：卡片头部耗时走可读单位三档（`formatDuration`），**没有时长就只出 ✓/✗**。
  it('issue #283：头部耗时可读单位（4321 ⇒ 4.3s、65000 ⇒ 1m 5s）；无时长不出现 0ms', () => {
    const { wrapper } = setup({
      sec: { name: 'a', dig: '', args: '{}', ok: true, out: '', dur: 4321 },
      min: { name: 'b', dig: '', args: '{}', ok: false, out: '', dur: 65000 },
      none: { name: 'c', dig: '', args: '{}', ok: true, out: '' }, // 引擎未给时长
    });
    const cards = wrapper.findAll('.border-l-4');
    expect(cards[0].get('button').text()).toContain('✓ 4.3s');
    expect(cards[1].get('button').text()).toContain('✗ 1m 5s');
    const header = cards[2].get('button').text();
    expect(header).toContain('✓');
    for (const junk of ['0ms', '0s', 'undefined', 'NaN']) expect(header).not.toContain(junk);
  });

  // issue #283 M3：刷新后不丢——卡片由 DTO 投影路径建立（`projectToolCard`），时长来自
  // 宿主自己 join 的 `durationMs`（引擎投影不带）。
  it('issue #283：刷新（投影路径）的卡片仍显示可读时长；旧数据无该字段 ⇒ 不显示 0ms', () => {
    const store = useWorkbenchStore();
    store.es.projectToolCard('p-dur', { name: 'shell', argsSummary: 'command=sleep 5', resultPreview: 'exit_code: 0', durationMs: 4321 });
    store.es.projectToolCard('p-legacy', { name: 'shell', argsSummary: 'command=sleep 5', resultPreview: 'exit_code: 0' });
    store.entries.push({ kind: 'tool', callId: 'p-dur' }, { kind: 'tool', callId: 'p-legacy' });
    const cards = mountPanel().findAll('.border-l-4');
    // 变异取证④：摘掉前端对 `durationMs` 的消费（或后端 join）就红在本行
    expect(cards[0].get('button').text()).toContain('✓ 4.3s');
    const legacy = cards[1].get('button').text();
    expect(legacy).toContain('✓');
    for (const junk of ['0ms', '0s', 'undefined']) expect(legacy).not.toContain(junk);
  });
});

// ---------------------------------------------------------------------------
// issue #101 P2：消息流用户可见文案走 i18n（zh-CN 基线逐字不变，切 en 即时生效）
// ---------------------------------------------------------------------------
describe('StreamPanel · i18n（issue #101 P2）', () => {
  it('zh-CN 基线：空态「选择或新建会话」+ 工具卡片参数兜底「（参数生成中…）」', () => {
    expect(mountPanel().text()).toContain('选择或新建会话');

    const { wrapper } = setup({ c1: { name: 'bash', dig: '', args: '', ok: null, out: '' } });
    expect(wrapper.get('button[aria-expanded]').text()).toContain('（参数生成中…）');
  });

  it('切 English：空态与参数兜底文案即时变英文', async () => {
    const empty = mountPanel();
    expect(empty.text()).toContain('选择或新建会话');
    setLocale('en');
    await flushPromises();
    expect(empty.text()).toContain('Select or create a session');
    expect(empty.text()).not.toContain('选择或新建会话');

    const { wrapper } = setup({ c1: { name: 'bash', dig: '', args: '', ok: null, out: '' } });
    expect(wrapper.get('button[aria-expanded]').text()).toContain('(generating arguments…)');
  });
});

describe('issue #188：投影工具卡片与推理块渲染', () => {
  it('投影卡片渲染 name/argsSummary/resultPreview/executionStatus；isError 变红；展开显示摘要与结果', async () => {
    const store = useWorkbenchStore();
    store.es.toolCards.set('c1', {
      name: 'read', dig: 'path=src/a.js', args: '', ok: false, out: '',
      // #299/guide §7：引擎只在两种特殊状态下写 executionStatus ⇒ 夹具用**真值** `interrupted`
      // （旧夹具写的 'failed' 从来不是引擎取值，是凭空造的；普通块上这个键根本不存在）
      argsSummary: 'path=src/a.js', resultPreview: 'BOOM', executionStatus: 'interrupted',
    });
    store.entries.push({ kind: 'tool', callId: 'c1' });
    const wrapper = mountPanel();

    const btn = wrapper.get('button[aria-expanded]');
    expect(btn.text()).toContain('read');
    expect(btn.text()).toContain('path=src/a.js');
    expect(btn.text()).toContain('✗');
    expect(btn.get('span.font-semibold').classes()).toContain('text-red-600');
    // 默认收起：无 pre
    expect(wrapper.find('pre').exists()).toBe(false);

    await btn.trigger('click');
    expect(wrapper.get('pre').text()).toContain('path=src/a.js');
    expect(wrapper.text()).toContain('interrupted · BOOM');
  });

  // issue #228：上游文件工具的返回形态按工具分三套（string / {content, metadata} / number）。
  // 展开区的结果行必须把 number 与 null 也渲染出来，且绝不出现 "[object Object]"。
  it('结果行兼容 number / 对象 / 缺失的 resultPreview（issue #228）', async () => {
    const store = useWorkbenchStore();
    store.es.toolCards.set('num', {
      name: 'writeFile', dig: '', args: '', ok: true, out: '',
      // #299：普通结果块**没有** executionStatus 键（0.20.0 §7）⇒ 展开区只剩结果正文
      resultPreview: 0 as unknown as string,
    });
    store.es.toolCards.set('obj', {
      name: 'searchText', dig: '', args: '', ok: true, out: '',
      resultPreview: { content: 'a.js:1:hit', metadata: { searchHits: 1 } } as unknown as string,
    });
    store.es.toolCards.set('none', {
      name: 'tree', dig: '', args: '', ok: true, out: '', resultPreview: null as unknown as string,
    });
    store.entries.push({ kind: 'tool', callId: 'num' }, { kind: 'tool', callId: 'obj' }, { kind: 'tool', callId: 'none' });
    const wrapper = mountPanel();
    for (const btn of wrapper.findAll('button[aria-expanded]')) await btn.trigger('click');
    // 直接看三张卡片的展开区正文（顺序 = entries 顺序：num / obj / none）
    // 结果行是 `<div class="font-normal text-black/50">`（`<pre>` 是 args 块），按类名取三张卡的结果行
    const outs = wrapper.findAll('div')
      .filter((node) => node.classes().includes('text-black/50'))
      .map((node) => node.text());
    expect(outs).toEqual(['0', 'a.js:1:hit', '']);
    // ↑ number 0 不被当成「无结果」丢掉 / {content,metadata} 只展示 content / null preview ⇒ 空串（不是 "null"）
    const text = wrapper.text();
    expect(text).not.toContain('[object Object]');
    // #299 (c)：普通块上 executionStatus **缺席** ⇒ 不得渲染成异常，也不得出现 undefined / 空状态串
    expect(text).not.toContain('undefined');
    expect(text).not.toMatch(/\b0ms\b/);  // 「没有时长」不许被渲染成 0ms
    expect(text).not.toContain(' · ');    // 状态串缺席 ⇒ 不能留下空的「 · 」连接符
    expect(text.match(/✓/g)?.length).toBe(3); // 三张卡都判成成功（不是 …/✗）
  });

  it('推理块默认收起、可展开；摘要取首行，展开显示全文', async () => {
    const store = useWorkbenchStore();
    store.entries.push({ kind: 'reasoning', id: 'm2', text: '第一行推理\n第二行细节' });
    const wrapper = mountPanel();

    const btn = wrapper.get('button[aria-expanded]');
    expect(btn.text()).toContain('推理过程');
    expect(btn.text()).toContain('第一行推理');
    expect(btn.text()).not.toContain('第二行细节');
    expect(wrapper.find('pre').exists()).toBe(false);

    await btn.trigger('click');
    expect(btn.attributes('aria-expanded')).toBe('true');
    expect(btn.find('.rotate-180').exists()).toBe(true);
    expect(wrapper.get('pre').text()).toContain('第二行细节');
  });
});

// ---------------------------------------------------------------------------
// issue #299 收尾：展开区（cardOut）的 executionStatus 读点必须**拿值比**（`isSpecialExecutionStatus`）
// —— 这条缺口是主 agent 跑变异发现的：把 `isSpecialExecutionStatus(card.executionStatus)` 换成
// `card.executionStatus !== undefined`（= 0.19 的旧误读）后，补测前 `StreamPanel.spec.ts` **29 条全绿 rc=0**
// ⇒ 旧夹具里没有任何「executionStatus 是非特殊值」的卡片，这个读点根本没被值比逻辑覆盖过。
// 引擎 0.20.0（host-upgrade-guide-0.20.0 §7 + lib/toolSummary 注释）：`erix.executionStatus`
// **只在** `intercepted` / `interrupted` 两种特殊状态下存在，普通成功/失败块上**缺席**；
// 上游哪天多写一个普通值（'ok' / 'succeeded' / 任何将来取值）也不许被当成状态渲进展开区，
// 更不许留下空的「 · 」连接符。
// `cardOut` 是 `<script setup>` 内部函数、未导出 ⇒ 沿用本文件既有技法（挂载 + 点击展开 +
// 取结果行 `div.text-black/50`，`<pre>` 是 args 块）读渲染文本，**不为测试改产品码导出面**。
// 变异靶：
//   ① `isSpecialExecutionStatus(...)` → `... !== undefined`（存在性误读）⇒ 「非特殊值」那条必须红；
//   ② 值比写成永返 false（特殊值也不渲染）⇒ 「特殊值正向」那条必须红。
// ---------------------------------------------------------------------------

/** 全部卡片展开后，按 entries 顺序取结果行正文（结果行 = 展开区里唯一的 div.text-black/50）。 */
async function expandAllAndReadOutRows(wrapper: ReturnType<typeof mount>): Promise<string[]> {
  for (const btn of wrapper.findAll('button[aria-expanded]')) await btn.trigger('click');
  return wrapper.findAll('div')
    .filter((node) => node.classes().includes('text-black/50'))
    .map((node) => node.text());
}

describe('issue #299：展开区 executionStatus 拿值比（非特殊值不得渲染成状态）', () => {
  // 变异①靶：普通值（上游多写的 / 空串）走值比 ⇒ 结果行只剩结果正文；存在性判据会把值本身渲出来。
  it('非特殊值（ok/succeeded/running/空串/未知取值）不进展开区：不出现该值、无空「 · 」、无 undefined', async () => {
    const store = useWorkbenchStore();
    const fixtures = [
      // callId, 上游写进 executionStatus 的**非特殊**值, resultPreview
      ['plain-ok', 'ok', 'BODY-OK'],
      ['plain-succeeded', 'succeeded', 'BODY-SUCCEEDED'],
      ['plain-running', 'running', 'BODY-RUNNING'],
      ['plain-empty', '', 'BODY-EMPTY'],
      // 上游将来新增取值（我们没登记过）⇒ 同样不许当状态渲染，也不许被当成「没结果」丢掉正文
      ['plain-unknown', 'cancelled-by-new-policy', 'BODY-UNKNOWN'],
      // 非特殊值 + 无 resultPreview ⇒ 结果行是空串（存在性判据会在这里单独渲染出状态串）
      ['plain-nopreview', 'succeeded', undefined],
    ] as const;
    for (const [callId, executionStatus, resultPreview] of fixtures) {
      store.es.toolCards.set(callId, {
        name: 'readFile', dig: '', args: '', ok: true, out: '',
        resultPreview: resultPreview as string | undefined,
        executionStatus,
      });
      store.entries.push({ kind: 'tool', callId });
    }
    const wrapper = mountPanel();
    // 默认收起时头部也不该出现状态串（cardOut 只在展开区，但整页文本一起兜底）
    const rows = await expandAllAndReadOutRows(wrapper);
    expect(rows).toEqual(['BODY-OK', 'BODY-SUCCEEDED', 'BODY-RUNNING', 'BODY-EMPTY', 'BODY-UNKNOWN', '']);
    fixtures.forEach(([, status, preview], i) => {
      // 状态值本身不许出现在结果行（大小写故意分开：正文用大写 BODY-*，不与 'ok'/'succeeded' 撞串）
      for (const junk of [status, 'undefined', ' · ']) {
        if (junk) expect(rows[i]).not.toContain(junk);
      }
      if (preview) expect(rows[i]).toContain(preview); // 结果正文本身一个字符都不能少
    });
    const text = wrapper.text();
    expect(text).not.toContain('undefined');
    expect(text).not.toContain(' · '); // 状态段缺席 ⇒ 不能留下空连接符
    expect(text.match(/✓/g)?.length).toBe(fixtures.length); // 六张卡都判成成功（不是 …/✗）
  });

  // 变异②靶：值比写成永返 false / 只认其中一种 ⇒ 引擎真写了特殊状态时展开区必须看得见。
  it('特殊值 interrupted / intercepted 必须渲染（防值比被写成永返 false）', async () => {
    const store = useWorkbenchStore();
    store.es.toolCards.set('cut', {
      name: 'bash', dig: '', args: '', ok: false, out: '',
      resultPreview: 'KILLED', executionStatus: 'interrupted',
    });
    store.es.toolCards.set('blocked', {
      name: 'bash', dig: '', args: '', ok: false, out: '',
      resultPreview: 'DENIED', executionStatus: 'intercepted',
    });
    // 特殊值 + 没有 resultPreview ⇒ 只出状态串，且不留下尾巴「 · 」
    store.es.toolCards.set('cut-only', {
      name: 'bash', dig: '', args: '', ok: null, out: '', executionStatus: 'interrupted',
    });
    store.entries.push({ kind: 'tool', callId: 'cut' }, { kind: 'tool', callId: 'blocked' }, { kind: 'tool', callId: 'cut-only' });
    const wrapper = mountPanel();
    expect(await expandAllAndReadOutRows(wrapper)).toEqual(['interrupted · KILLED', 'intercepted · DENIED', 'interrupted']);
    expect(wrapper.text()).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// issue #189：折叠段（compaction）横幅——独立视觉、摘要默认收起、「查看原文」只读懒加载
// （loading → turns / 404 友好提示 / error + 重试）；会话头部状态行（N 条消息 · 已压缩 M 次）。
// ---------------------------------------------------------------------------
function foldedEntry(over: { id?: string; sessionId?: string | null; folded?: Record<string, unknown> } = {}) {
  return {
    kind: 'folded' as const,
    id: over.id ?? 'm2',
    sessionId: over.sessionId === undefined ? 's1' : over.sessionId,
    folded: {
      text: '折叠摘要全文\n第二行',
      foldedRoundRange: { from: 2, to: 5 },
      foldedPayloadMessages: 9,
      round: 8, // #189 收尾：折叠行自己的 round（故意≠ range.to=5，验证查的是行号不是范围末端）
      ...(over.folded ?? {}),
    },
  };
}

function mockFoldedFetch(handler: (url: string) => { status: number; body: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    new Response(JSON.stringify(handler(url).body), {
      status: handler(url).status,
      headers: { 'Content-Type': 'application/json' },
    })));
}

describe('issue #189：折叠横幅渲染', () => {
  it('有折叠 → 独立横幅（非 .msg 气泡）：#375 后标题只报轮范围「已压缩第 2–5 轮」', () => {
    const store = useWorkbenchStore();
    store.entries.push(foldedEntry());
    const wrapper = mountPanel();
    const banner = wrapper.get('.folded-banner');
    expect(banner.classes()).not.toContain('msg'); // 独立视觉：不是普通气泡
    expect(banner.text()).toContain('已压缩第 2–5 轮');
    // #375：条数不得再上横幅——foldedPayloadMessages 自 erix-agent 0.25.0 起是「本条记录携带的
    // 归档条数」（去重+夹断后），拿它说「压掉了多少条」会说假话。
    expect(banner.text()).not.toContain('9 条');
    expect(wrapper.findAll('.msg')).toHaveLength(0);
  });

  it('无折叠消息 → 不渲染横幅', () => {
    const store = useWorkbenchStore();
    store.sessionId = 's1';
    store.renderedIds = new Set();
    store.addMessage({ id: 'm1', role: 'assistant', content: '普通消息' });
    const plain = mountPanel();
    expect(plain.find('.folded-banner').exists()).toBe(false);
    expect(store.sessionStats?.folded).toBe(0);
  });

  it('字段缺失逐级降级：缺范围 → 「已压缩 N 条消息」；再缺条数 → 「已压缩」', () => {
    const store = useWorkbenchStore();
    store.entries.push(foldedEntry({ folded: { foldedRoundRange: undefined } }));
    store.entries.push(foldedEntry({ id: 'm3', folded: { text: 'x', foldedRoundRange: undefined, foldedPayloadMessages: undefined } }));
    const wrapper = mountPanel();
    const banners = wrapper.findAll('.folded-banner');
    expect(banners[0].text()).toContain('已压缩 9 条消息');
    expect(banners[0].text()).not.toContain('第 ');
    expect(banners[1].text()).toContain('已压缩');
    expect(banners[1].text()).not.toContain('9');
  });

  it('摘要默认收起，点击展开显示全文，再点收起', async () => {
    const store = useWorkbenchStore();
    store.entries.push(foldedEntry());
    const wrapper = mountPanel();
    const btn = wrapper.get('.folded-toggle');
    expect(btn.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('.folded-summary').exists()).toBe(false);

    await btn.trigger('click');
    expect(wrapper.get('.folded-toggle').attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('.folded-summary').text()).toContain('折叠摘要全文');
    expect(wrapper.get('.folded-summary').text()).toContain('第二行');

    await wrapper.get('.folded-toggle').trigger('click');
    expect(wrapper.find('.folded-summary').exists()).toBe(false);
  });

  it('「查看原文」→ 调懒加载端点并只读渲染返回 turns；再点不重发（缓存）', async () => {
    mockFoldedFetch((url) => url.includes('/folded/')
      ? { status: 200, body: { round: 5, turns: [{ role: 'user', text: '原文甲' }, { role: 'assistant', text: '' }] } }
      : { status: 200, body: { items: [] } });
    const store = useWorkbenchStore();
    store.entries.push(foldedEntry());
    const wrapper = mountPanel();

    await wrapper.get('.view-original').trigger('click');
    await flushPromises();
    const fetchUrl = String(vi.mocked(fetch).mock.calls.find(([u]) => String(u).includes('/folded/'))?.[0]);
    // #189 收尾：:round = 折叠行自己的 round（folded.round=8），**不是**被折叠范围末端 foldedRoundRange.to=5
    expect(fetchUrl).toBe('/api/sessions/s1/folded/8');
    const turns = wrapper.findAll('.folded-original-turn');
    expect(turns).toHaveLength(2);
    // #384：user 轮现在带一个很轻的身份标记（原来满屏正文分不清是谁说的）⇒ 断言从 `toBe` 改 `toContain`。
    expect(turns[0].text()).toContain('原文甲');
    expect(turns[0].text()).toContain('用户');
    expect(turns[1].text()).toBe('（无文本内容）'); // 四类（text/reasoning/工具/身份）都空才给占位

    await wrapper.get('.view-original').trigger('click'); // 缓存命中不重发
    await flushPromises();
    expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('/folded/'))).toHaveLength(1);
  });

  it('#384 原文里「只有思考 + 工具调用」的轮不再被渲染成空行（真机 round 100 的 112 条里 40 条是这形状）', async () => {
    mockFoldedFetch((url) => url.includes('/folded/')
      ? {
        status: 200,
        body: {
          round: 8,
          turns: [{
            role: 'assistant',
            text: '',
            reasoning: '先看工作目录再决定 clone 方式',
            toolCalls: [
              { name: 'shell', argsSummary: 'command=pwd && ls -la' },
              { name: 'readFile', argsSummary: 'path=missing.txt', isError: true },
            ],
          }],
        },
      }
      : { status: 200, body: { items: [] } });
    const store = useWorkbenchStore();
    store.entries.push(foldedEntry());
    const wrapper = mountPanel();

    await wrapper.get('.view-original').trigger('click');
    await flushPromises();

    const turn = wrapper.get('.folded-original-turn');
    // 旧行为：整块就一句「（无文本内容）」——活干了但没正文，占位符在说谎。
    expect(turn.text()).not.toContain('（无文本内容）');
    expect(turn.get('.folded-original-reasoning').text()).toContain('先看工作目录再决定 clone 方式');
    const tools = wrapper.findAll('.folded-original-tool');
    expect(tools).toHaveLength(2);
    expect(tools[0].text()).toContain('shell');
    expect(tools[0].text()).toContain('command=pwd && ls -la');
    expect(tools[1].text(), 'isError 的工具行要标出失败').toContain('（失败）');
  });

  it('原文 404 → 友好提示（非红错）', async () => {
    mockFoldedFetch(() => ({ status: 404, body: { error: { code: 'folded_payload_not_found', message: 'gone' } } }));
    const store = useWorkbenchStore();
    store.entries.push(foldedEntry());
    const wrapper = mountPanel();
    await wrapper.get('.view-original').trigger('click');
    await flushPromises();
    expect(wrapper.get('.folded-original-missing').text()).toBe('这一段没有可显示的原文（账本里也没有）');
    expect(wrapper.find('.folded-original-error').exists()).toBe(false);
  });

  // #375：后端改成「有 foldedRoundRange 就从账本重建」，多返三个可选键 source/truncated/dropped_messages。
  it('#375 差分归档被夹断 → turns 照渲染（重建的完整原文）并给中性截断说明，不报红也不报「没原文」', async () => {
    mockFoldedFetch((url) => url.includes('/folded/')
      ? {
          status: 200,
          body: {
            round: 8,
            turns: [{ role: 'user', text: '被夹断丢掉的头部原文' }, { role: 'assistant', text: '尾部原文' }],
            source: 'rebuilt', truncated: true, dropped_messages: 317,
          },
        }
      : { status: 200, body: { items: [] } });
    const store = useWorkbenchStore();
    store.entries.push(foldedEntry());
    const wrapper = mountPanel();
    await wrapper.get('.view-original').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.folded-original-turn')).toHaveLength(2);
    const cap = wrapper.get('.folded-original-truncated');
    expect(cap.text()).toContain('317');
    expect(cap.text()).toContain('本次归档被截断');
    expect(wrapper.find('.folded-original-missing').exists()).toBe(false);
    expect(wrapper.find('.folded-original-error').exists()).toBe(false);
  });

  it('#375 旧后端（无三个可选键）→ 不渲染截断说明（向后兼容，不拼「undefined」）', async () => {
    mockFoldedFetch((url) => url.includes('/folded/')
      ? { status: 200, body: { round: 8, turns: [{ role: 'user', text: '存量全量归档' }] } }
      : { status: 200, body: { items: [] } });
    const store = useWorkbenchStore();
    store.entries.push(foldedEntry());
    const wrapper = mountPanel();
    await wrapper.get('.view-original').trigger('click');
    await flushPromises();
    expect(wrapper.find('.folded-original-truncated').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('undefined');
  });

  it('无 folded.round → 隐藏「查看原文」按钮（有 range 也不能拿 range.to/from 去查：那是被折叠范围，会 404）', () => {
    const store = useWorkbenchStore();
    store.entries.push(foldedEntry({ id: 'm9', folded: { round: undefined } }));
    const w2 = mountPanel();
    expect(w2.find('.view-original').exists()).toBe(false);
  });

  it('非整数 round（字符串/小数）同样不渲染按钮（foldedQueryRound 只认整数）', () => {
    const store = useWorkbenchStore();
    store.entries.push(foldedEntry({ id: 'ma', folded: { round: '8' } }));
    store.entries.push(foldedEntry({ id: 'mb', folded: { round: 2.5 } }));
    const w = mountPanel();
    expect(w.findAll('.view-original')).toHaveLength(0);
  });

  it('原文加载失败（5xx）→ 红字 + 重试按钮，重试成功渲染 turns', async () => {
    let fail = true;
    mockFoldedFetch(() => fail
      ? { status: 500, body: { error: { code: 'internal', message: 'boom' } } }
      : { status: 200, body: { round: 5, turns: [{ text: '重试后原文' }] } });
    const store = useWorkbenchStore();
    store.entries.push(foldedEntry());
    const wrapper = mountPanel();
    await wrapper.get('.view-original').trigger('click');
    await flushPromises();
    expect(wrapper.get('.folded-original-error').text()).toContain('boom');

    fail = false;
    await wrapper.get('.retry-original').trigger('click');
    await flushPromises();
    expect(wrapper.find('.folded-original-error').exists()).toBe(false);
    expect(wrapper.get('.folded-original-turn').text()).toBe('重试后原文');
  });

  it('守卫断言（产品决策）：普通消息不出现轮号标注——轮号只在折叠横幅范围里出现', () => {
    const store = useWorkbenchStore();
    store.renderedIds = new Set();
    store.addMessage({ id: 'm1', role: 'user', content: '任务一' });
    store.addMessage({ id: 'm2', role: 'assistant', content: '答复一', toolCalls: [{ name: 'bash', id: 'c1' }] });
    store.addMessage({ id: 'm3', role: 'assistant', content: '答复二', reasoning: '想一想' });
    const wrapper = mountPanel();
    for (const msg of wrapper.findAll('.msg')) {
      expect(msg.text()).not.toMatch(/第\s*\d+\s*轮|round\s*\d+/i);
    }
    // 折叠横幅是唯一允许出现轮号的位置
    store.entries.push(foldedEntry());
    const w2 = mountPanel();
    expect(w2.get('.folded-banner').text()).toContain('第 2–5 轮');
  });
});

describe('issue #189（追加）：会话头部状态行「N 条消息 · 已压缩 M 次」', () => {
  it('有会话有折叠 → 计数行含压缩次数 + 克制提示', () => {
    mockFoldedFetch(() => ({ status: 200, body: { items: [] } }));
    const store = useWorkbenchStore();
    store.sessionId = 's1';
    store.renderedIds = new Set();
    store.addMessage({ id: 'm1', role: 'user', content: 'x' });
    store.addMessage({ id: 'm2', role: 'assistant', content: 'y', folded: { text: '摘要' } });
    const wrapper = mountPanel();
    expect(wrapper.get('.session-stats').text()).toContain('2 条消息');
    expect(wrapper.get('.session-stats').text()).toContain('已压缩 1 次');
    expect(wrapper.get('.session-compaction-hint').text()).toBe('上下文已开始压缩；如需保留完整细节，建议新开会话');
  });

  it('有会话无折叠 → 降级只报条数、无压缩段/提示；无会话 → 整行不渲染', () => {
    const store = useWorkbenchStore();
    store.renderedIds = new Set();
    store.addMessage({ id: 'm1', role: 'user', content: 'x' }); // 未选中会话 → 整行缺席
    const noSess = mountPanel();
    expect(noSess.find('.session-stats').exists()).toBe(false);

    store.sessionId = 's1';
    const plain = mountPanel();
    expect(plain.get('.session-stats').text()).toBe('1 条消息');
    expect(plain.find('.session-compaction-hint').exists()).toBe(false);
  });

  it('切 English：横幅与状态行文案即时变英文（无硬编码中文）', async () => {
    const store = useWorkbenchStore();
    store.sessionId = 's1';
    store.renderedIds = new Set();
    store.addMessage({ id: 'm1', role: 'user', content: 'x' });
    store.addMessage({ id: 'm2', role: 'assistant', content: 'y', folded: { text: 's', foldedPayloadMessages: 3, foldedRoundRange: { from: 1, to: 2 }, round: 3 } });
    setLocale('en');
    const wrapper = mountPanel();
    expect(wrapper.get('.session-stats').text()).toContain('2 messages');
    expect(wrapper.get('.session-stats').text()).toContain('compacted 1×');
    expect(wrapper.get('.session-compaction-hint').text())
      .toBe('Context compaction has started; open a new session if you need to keep full details');
    expect(wrapper.get('.folded-banner').text()).toContain('Compressed rounds 1–2'); // #375：有 range 只报范围
    expect(wrapper.get('.view-original').text()).toBe('View original');
    setLocale('zh-CN');
  });
});

// ---------------------------------------------------------------------------
// issue #300：中止/失败 run 的部分正文（kind:'partial' → **中性助手气泡**，不是红色 .syserr）
// 双语都断言（zh-CN 由 beforeEach 复位，en 在用例内显式切换后切回）。
// ---------------------------------------------------------------------------
describe('issue #300：partial entry 渲染（中性助手气泡 + 双语标签）', () => {
  function seedPartial(text = '已经生成的**半截正文**', truncated = false) {
    const store = useWorkbenchStore();
    store.renderedIds = new Set();
    store.entries.length = 0; // 同例内二次装配时不得残留上一条（否则 truncated 断言会看到旧 entry）
    store.entries.push({ kind: 'partial', id: 'partial:r1', text, truncated, sessionId: 's1' });
    return { store, wrapper: mountPanel() };
  }

  it('zh-CN：标签「已中止 · 部分输出」+ 正文走助手 markdown；类名不含 syserr', () => {
    const { wrapper } = seedPartial();
    const node = wrapper.get('.msg.assistant.partial');
    expect(node.classes()).toContain('md'); // 与助手终稿同一渲染路径
    expect(node.find('.partial-label').text()).toBe('已中止 · 部分输出');
    expect(node.html()).toContain('<strong>半截正文</strong>'); // markdown 渲染（不是纯文本转义）
    expect(wrapper.find('.syserr').exists()).toBe(false);
    expect(node.classes()).not.toContain('syserr');
    expect(node.classes()).not.toContain('roundsep');
    // 中性口径：标签既不说「已完成」也不说「错误」
    const label = node.find('.partial-label').text();
    expect(label).not.toMatch(/完成|错误|失败/);
  });

  it('en：标签 "Aborted · partial output"，同样不是 syserr', () => {
    setLocale('en');
    const { wrapper } = seedPartial();
    const node = wrapper.get('.msg.assistant.partial');
    expect(node.find('.partial-label').text()).toBe('Aborted · partial output');
    expect(wrapper.find('.syserr').exists()).toBe(false);
    expect(node.find('.partial-label').text()).not.toMatch(/complete|error|fail/i);
    setLocale('zh-CN');
  });

  it('truncated=true ⇒ 出截断提示（zh/en 成对）；false ⇒ 一字不出', () => {
    const { wrapper } = seedPartial('半截', true);
    expect(wrapper.get('.partial-truncated').text()).toBe('输出在停止前未生成完全（已截断）');
    setLocale('en');
    const enWrapper = mountPanel();
    expect(enWrapper.get('.partial-truncated').text()).toBe('Output was not finished before the run stopped (truncated)');
    setLocale('zh-CN');

    const plain = seedPartial('半截', false);
    expect(plain.wrapper.find('.partial-truncated').exists()).toBe(false);
  });

  it('正文与标签分离：标签不得混进 markdown 正文', () => {
    const { wrapper } = seedPartial('第一行\n第二行');
    const body = wrapper.get('.msg.assistant.partial').html();
    expect(body).toContain('第一行');
    expect(wrapper.get('.partial-label').text()).not.toContain('第一行');
  });
});

// 试用台账 #10：「加载更早消息」入口——后端一直分页（默认只给最新一窗），前端消费
// next_cursor 后由本按钮触发取更早批；游标 null（到底/旧后端）不渲染。
describe('加载更早消息入口（台账 #10）', () => {
  it('有游标 → 渲染按钮并可点击调用 store.loadOlderMessages；加载中禁用；无游标不渲染', async () => {
    const store = useWorkbenchStore();
    const spy = vi.spyOn(store, 'loadOlderMessages').mockResolvedValue(true);
    store.olderMessagesCursor = 42;
    const wrapper = mountPanel();
    const btn = wrapper.get('[data-test="load-older"]');
    expect(btn.text()).toBe('加载更早消息');
    await btn.trigger('click');
    expect(spy).toHaveBeenCalledTimes(1);

    store.olderLoading = true;
    await flushPromises();
    const loadingBtn = wrapper.get('[data-test="load-older"]');
    expect((loadingBtn.element as HTMLButtonElement).disabled).toBe(true);
    expect(loadingBtn.text()).toBe('正在加载…');

    store.olderLoading = false;
    store.olderMessagesCursor = null; // 已到底 / 旧后端无此字段
    await flushPromises();
    expect(wrapper.find('[data-test="load-older"]').exists()).toBe(false);
  });
});
