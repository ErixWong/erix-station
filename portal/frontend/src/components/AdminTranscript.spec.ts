// issue #727 片 2：`AdminTranscript`（只读对话）单测。
// 判据⑤：synthetic 行纯文本、assistant 走 Markdown、工具卡默认收起、`run_termination` 按
// `lib/terminationReasons` 的红/中性口径上色；另钉「加载更早」用 `before`、折叠原文 404 不报红。
// ⚠ 断言走 DOM / fetch 桩（不用 `w.emitted()`）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import AdminTranscript from './AdminTranscript.vue';
import { i18n, setLocale } from '../i18n';
import type { SeatMessage, SeatSessionDetail } from '../stores/adminSeatContent';

function msg(patch: Partial<SeatMessage>): SeatMessage {
  return {
    id: 'm-x', run_id: null, seq: 1, role: 'assistant', content: '',
    synthetic: false, attachments: [], created_at: null, ...patch,
  };
}

function detail(messages: SeatMessage[]): SeatSessionDetail {
  return {
    session: {
      id: 's-1', project_id: null, cwd: '~/projects/repo-a', title: 'T', model: 'm', status: 'active',
      last_seq: 10, created_at: null, updated_at: null, message_count: messages.length,
    },
    messages,
    last_seq: 10,
    next_cursor: null,
  };
}

const HISTORY_URL = '/api/admin/fdes/alpha-fde/sessions/s-1/events/history';
const FOLDED_URL = '/api/admin/fdes/alpha-fde/sessions/s-1/folded/7';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function mountTranscript(
  messages: SeatMessage[],
  events: unknown[] = [],
  nextCursor: number | null = null,
  extra: (url: string) => Response | undefined = () => undefined,
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.startsWith(HISTORY_URL)) {
      return jsonResponse(200, { events, next_cursor: nextCursor });
    }
    return extra(url) ?? jsonResponse(404, { error: { code: 'not_found', message: 'not found' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(AdminTranscript, {
    props: { fde: 'alpha-fde', sessionId: 's-1', detail: detail(messages), includeArchived: false },
    global: { plugins: [pinia, i18n] },
    attachTo: document.body,
  });
  return { wrapper, fetchMock };
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('issue #727 判据⑤：消息与事件的只读渲染', () => {
  it('synthetic 行是纯文本（含 Markdown 语法也不解析），且带灰底', async () => {
    const { wrapper } = mountTranscript([
      msg({ id: 'm-s', seq: 1, role: 'system', content: '**加粗** 与 # 井号', synthetic: true }),
    ]);
    await flushPromises();
    const row = wrapper.get('[data-test="msg-synthetic"]');
    expect(row.text()).toBe('**加粗** 与 # 井号');
    expect(row.html()).not.toContain('<strong>');
    expect(row.classes()).toContain('bg-black/5');
    wrapper.unmount();
  });

  it('user 行纯文本、assistant 行走 Markdown（`#` 变 `<h1>`）', async () => {
    const { wrapper } = mountTranscript([
      msg({ id: 'm-u', seq: 1, role: 'user', content: '<b>原样</b>' }),
      msg({ id: 'm-a', seq: 2, content: '# 标题' }),
    ]);
    await flushPromises();
    expect(wrapper.get('[data-test="msg-user"]').text()).toContain('<b>原样</b>');
    // 序列化里是转义体 ⇒ 证明它是**文本节点**而不是被当 HTML 解析了。
    expect(wrapper.get('[data-test="msg-user"]').html()).toContain('&lt;b&gt;原样');
    expect(wrapper.get('[data-test="msg-assistant"]').html()).toContain('<h1>标题</h1>');
    wrapper.unmount();
  });

  it('工具卡默认收起，点卡片头才展开详情（事件流与投影两条路都成立）', async () => {
    const { wrapper } = mountTranscript(
      [msg({
        id: 'm-a',
        seq: 1,
        content: '正文',
        toolCalls: [{ name: 'readFile', argsSummary: '{"path":"a.ts"}', resultPreview: 'ok', durationMs: 1234 }],
      })],
      [
        { seq: 2, run_id: 'r1', type: 'tool_use', payload: { tool_call_id: 'c1', name: 'exec', input: { command: 'ls -la' } } },
        { seq: 3, run_id: 'r1', type: 'tool_result', payload: { tool_call_id: 'c1', ok: true, result_digest: 'done', duration_ms: 4321 } },
      ],
    );
    await flushPromises();
    const cards = wrapper.findAll('[data-test="tool-card"]');
    expect(cards).toHaveLength(2);
    expect(wrapper.find('[data-test="tool-card-body"]').exists()).toBe(false);

    await wrapper.findAll('[data-test="tool-card-head"]')[1]!.trigger('click');
    await flushPromises();
    const body = wrapper.get('[data-test="tool-card-body"]');
    expect(body.text()).toContain('ls -la');
    expect(body.text()).toContain('done');
    // 时长走 lib/toolSummary.formatDuration（4321ms → `4.3s`）
    expect(wrapper.findAll('[data-test="tool-card-head"]')[1]!.text()).toContain('4.3s');
    wrapper.unmount();
  });

  it('run_termination 上色：红色集内 reason 进 `.syserr`，`end_turn` / `aborted` 不进', async () => {
    const { wrapper } = mountTranscript([], [
      { seq: 1, run_id: 'r1', type: 'run_termination', payload: { status: 'failed', termination: { reason: 'failed' } } },
      { seq: 2, run_id: 'r2', type: 'run_termination', payload: { status: 'completed', termination: { reason: 'end_turn' } } },
      { seq: 3, run_id: 'r3', type: 'run_termination', payload: { status: 'cancelled', termination: { reason: 'aborted' } } },
      { seq: 4, run_id: 'r4', type: 'run_termination', payload: { status: 'failed', termination: { reason: 'persistence_failed', phase: 'ledger' } } },
    ]);
    await flushPromises();
    const bars = wrapper.findAll('[data-test="run-termination"]');
    expect(bars).toHaveLength(4);
    expect(bars[0]!.classes()).toContain('syserr');
    expect(bars[0]!.attributes('data-syserr')).toBe('1');
    expect(bars[1]!.classes()).not.toContain('syserr');
    expect(bars[1]!.attributes('data-syserr')).toBe('0');
    expect(bars[1]!.text()).toContain('正常完成');
    // 用户主动停止不是故障（#236 口径）
    expect(bars[2]!.classes()).not.toContain('syserr');
    expect(bars[3]!.classes()).toContain('syserr');
    expect(bars[3]!.text()).toContain('phase=ledger');
    wrapper.unmount();
  });

  it('partial_output：正文 + 「被截断」提示；占位帧给「没留住正文」的文案', async () => {
    const { wrapper } = mountTranscript([], [
      { seq: 1, run_id: 'r1', type: 'partial_output', payload: { text: '半截正文', chunks: 2, truncated: true } },
      { seq: 2, run_id: 'r2', type: 'partial_output', payload: { text: '', chunks: 0, truncated: false, placeholder: true } },
    ]);
    await flushPromises();
    const blocks = wrapper.findAll('[data-test="event-partial"]');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text()).toContain('半截正文');
    expect(blocks[0]!.text()).toContain('正文被截断');
    expect(blocks[1]!.text()).toContain('没有留下可展示的正文');
    wrapper.unmount();
  });

  it('折叠横幅 + 「查看原文」懒加载；404 `folded_payload_not_found` 是友好提示不是红色错误', async () => {
    const folded = msg({
      id: 'm-f', seq: 1, content: '摘要正文', folded: { text: '摘要正文', round: 7 } as never,
    });
    const ok = mountTranscript([folded], [], null, (url) => (url === FOLDED_URL
      ? jsonResponse(200, { round: 7, turns: [{ text: '被折叠的原文第一段' }, { text: '第二段' }], source: 'rebuilt' })
      : undefined));
    await flushPromises();
    expect(ok.wrapper.get('[data-test="folded-banner"]').text()).toContain('第 7 轮');
    expect(ok.wrapper.find('[data-test="folded-original"]').exists()).toBe(false);
    await ok.wrapper.get('[data-test="folded-toggle"]').trigger('click');
    await flushPromises();
    expect(ok.wrapper.get('[data-test="folded-original"]').text()).toContain('被折叠的原文第一段');
    expect(ok.wrapper.get('[data-test="folded-original"]').text()).toContain('第二段');
    ok.wrapper.unmount();

    const missing = mountTranscript([folded], [], null, () =>
      jsonResponse(404, { error: { code: 'folded_payload_not_found', message: 'no payload' } }));
    await flushPromises();
    await missing.wrapper.get('[data-test="folded-toggle"]').trigger('click');
    await flushPromises();
    const notice = missing.wrapper.get('[data-test="folded-missing"]');
    expect(notice.text()).toContain('原文已不可用');
    expect(notice.classes()).not.toContain('syserr');
    expect(missing.wrapper.find('[data-test="folded-error"]').exists()).toBe(false);
    missing.wrapper.unmount();
  });

  it('「加载更早」把服务端 `next_cursor` 原样当 `before` 传，并把更早的条目前插', async () => {
    const { wrapper, fetchMock } = mountTranscript(
      [msg({ id: 'm-new', seq: 50, role: 'user', content: '新的' })],
      [{ seq: 40, run_id: 'r1', type: 'partial_output', payload: { text: '本页', chunks: 1, truncated: false } }],
      40,
    );
    await flushPromises();
    expect(wrapper.get('[data-test="load-earlier"]').text()).toContain('加载更早');
    await wrapper.get('[data-test="load-earlier"]').trigger('click');
    await flushPromises();
    const calls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith(HISTORY_URL));
    expect(calls).toHaveLength(2);
    expect(new URL(String(calls[1]![0]), 'http://x').searchParams.get('before')).toBe('40');
    wrapper.unmount();
  });

  it('到底（`next_cursor=null`）时不渲染按钮，改说「已到最早一条」', async () => {
    const { wrapper } = mountTranscript([msg({ id: 'm-1', seq: 1, role: 'user', content: '只有一条' })]);
    await flushPromises();
    expect(wrapper.find('[data-test="load-earlier"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="no-earlier"]').text()).toContain('已到最早一条');
    wrapper.unmount();
  });

  it('只读红线：组件内没有输入框 / 发送 / 停止 / 审批按钮', async () => {
    const { wrapper } = mountTranscript([msg({ id: 'm-1', seq: 1, role: 'user', content: 'hi' })]);
    await flushPromises();
    expect(wrapper.find('input').exists()).toBe(false);
    expect(wrapper.find('textarea').exists()).toBe(false);
    const labels = wrapper.findAll('button').map((b) => b.text());
    expect(labels.filter((l) => /发送|停止|审批|上传|Send|Stop/i.test(l))).toEqual([]);
    wrapper.unmount();
  });
});
