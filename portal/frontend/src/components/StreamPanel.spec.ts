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
    store.entries.push({ kind: 'sep', text: 'judge：扩轮 — P（R）', variant: 'judge' });
    const wrapper = mountPanel();
    const seps = wrapper.findAll('.roundsep');
    expect(seps).toHaveLength(2);
    expect(seps[0].classes()).toEqual(['roundsep']);
    expect(seps[1].classes()).toEqual(['roundsep', 'judge-panel']);
    expect(seps[1].text()).toBe('judge：扩轮 — P（R）');
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
      argsSummary: 'path=src/a.js', resultPreview: 'BOOM', executionStatus: 'failed',
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
    expect(wrapper.text()).toContain('failed · BOOM');
  });

  // issue #228：上游文件工具的返回形态按工具分三套（string / {content, metadata} / number）。
  // 展开区的结果行必须把 number 与 null 也渲染出来，且绝不出现 "[object Object]"。
  it('结果行兼容 number / 对象 / 缺失的 resultPreview（issue #228）', async () => {
    const store = useWorkbenchStore();
    store.es.toolCards.set('num', {
      name: 'writeFile', dig: '', args: '', ok: true, out: '',
      executionStatus: 'succeeded', resultPreview: 0 as unknown as string,
    });
    store.es.toolCards.set('obj', {
      name: 'searchText', dig: '', args: '', ok: true, out: '',
      executionStatus: 'succeeded',
      resultPreview: { content: 'a.js:1:hit', metadata: { searchHits: 1 } } as unknown as string,
    });
    store.es.toolCards.set('none', {
      name: 'tree', dig: '', args: '', ok: true, out: '', executionStatus: 'succeeded', resultPreview: null as unknown as string,
    });
    store.entries.push({ kind: 'tool', callId: 'num' }, { kind: 'tool', callId: 'obj' }, { kind: 'tool', callId: 'none' });
    const wrapper = mountPanel();
    for (const btn of wrapper.findAll('button[aria-expanded]')) await btn.trigger('click');
    const text = wrapper.text();
    expect(text).toContain('succeeded · 0'); // number 0 不能被当成「无结果」丢掉
    expect(text).toContain('succeeded · a.js:1:hit'); // {content, metadata} 只展示 content
    expect(text).not.toContain('[object Object]');
    expect(text).toContain('succeeded'); // resultPreview 缺失时只剩状态串，不渲染 null/undefined
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
  it('有折叠 → 独立横幅（非 .msg 气泡）：标题「已压缩 9 条消息（第 2–5 轮）」', () => {
    const store = useWorkbenchStore();
    store.entries.push(foldedEntry());
    const wrapper = mountPanel();
    const banner = wrapper.get('.folded-banner');
    expect(banner.classes()).not.toContain('msg'); // 独立视觉：不是普通气泡
    expect(banner.text()).toContain('已压缩 9 条消息（第 2–5 轮）');
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
    expect(turns[0].text()).toBe('原文甲');
    expect(turns[1].text()).toBe('（无文本内容）'); // 空 text 降级占位

    await wrapper.get('.view-original').trigger('click'); // 缓存命中不重发
    await flushPromises();
    expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('/folded/'))).toHaveLength(1);
  });

  it('原文 404 → 友好提示（非红错）', async () => {
    mockFoldedFetch(() => ({ status: 404, body: { error: { code: 'folded_payload_not_found', message: 'gone' } } }));
    const store = useWorkbenchStore();
    store.entries.push(foldedEntry());
    const wrapper = mountPanel();
    await wrapper.get('.view-original').trigger('click');
    await flushPromises();
    expect(wrapper.get('.folded-original-missing').text()).toBe('原文已不可用（上游未保留折叠前载荷）');
    expect(wrapper.find('.folded-original-error').exists()).toBe(false);
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
    expect(wrapper.get('.folded-banner').text()).toContain('Compressed 3 messages');
    expect(wrapper.get('.view-original').text()).toBe('View original');
    setLocale('zh-CN');
  });
});
