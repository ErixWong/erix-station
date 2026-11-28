// issue #816 第④b步：`MessageBubble` 的单测——**主对话气泡的渲染本体**（从 StreamPanel 抽出来的那份）。
// 它现在有两个消费者：① 主对话的流（`en.kind === 'msg'`）；② 折叠「查看原文」的正文。
// 于是「展开原文 = 主对话同款气泡」是**结构事实**而不是口号，本文件钉住它的 DOM 形状。
// 断言只认 DOM（类名 / 文本 / 属性），不用 `w.emitted()`（NODE_ENV=production 下恒空 ⇒ 假红）。
import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageBubble from './MessageBubble.vue';
import { i18n, setLocale } from '../i18n';
import { renderMarkdown } from '../lib/markdown';

// props 形状与组件一致（不拿 `Record<string, unknown>` 糊弄 vue-tsc：props 类型对不上会直接报）。
type BubbleProps = { role: string; synthetic?: boolean; createdAt?: string; html?: string | null; text?: string; textualized?: boolean };

function mountBubble(props: BubbleProps) {
  return mount(MessageBubble, { props, global: { plugins: [i18n] } });
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
});

describe('MessageBubble · #816④b：流与折叠原文共用的那一份气泡', () => {
  it('① role=user + 纯文本 ⇒ .msg.user（**无** md 类），文本原样上屏', () => {
    const w = mountBubble({ role: 'user', text: '把仓库 clone 下来' });
    const bubble = w.get('.msg.user');
    expect(bubble.classes()).not.toContain('md');
    expect(bubble.text()).toBe('把仓库 clone 下来');
  });

  it('② role=assistant + html ⇒ .msg.assistant.md，且渲染的是 markdown 结果（**粗** ⇒ <strong>）', () => {
    const w = mountBubble({ role: 'assistant', html: renderMarkdown('## 轮标题\n**粗**'), text: '## 轮标题\n**粗**' });
    const bubble = w.get('.msg.assistant.md');
    // markdown 路径：走 v-html ⇒ 有真的 <h2>/<strong>；纯文本兜底不得同时出现（否则是双写）
    expect(bubble.html()).toContain('<h2>轮标题</h2>');
    expect(bubble.html()).toContain('<strong>粗</strong>');
    expect(bubble.text()).not.toContain('**');
  });

  it('③ synthetic=true ⇒ 带 synthetic 类（黄色左条语义仍在气泡上）', () => {
    const w = mountBubble({ role: 'assistant', synthetic: true, text: '系统注入' });
    expect(w.find('.msg.assistant.synthetic').exists()).toBe(true);
  });

  it('④ 无 createdAt ⇒ **不渲染** time.msg-time（也不冒出 undefined / Invalid Date / NaN）', () => {
    const w = mountBubble({ role: 'user', text: '没有时刻' });
    expect(w.find('time.msg-time').exists()).toBe(false);
    expect(w.text()).not.toMatch(/undefined|Invalid Date|NaN/);
  });

  it('⑤ 有 createdAt ⇒ 渲染 time，datetime 属性 = 原值，文本是 HH:MM:SS，title 是本地化文案', () => {
    const iso = '2026-10-23T13:42:07.000Z';
    const w = mountBubble({ role: 'assistant', createdAt: iso, text: '带时刻' });
    const time = w.get('time.msg-time');
    expect(time.attributes('datetime')).toBe(iso);
    expect(time.text()).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(time.attributes('title')).toBe('消息时刻');
    // 时刻挂在气泡**内部**（不是另起一个气泡）
    expect(w.get('.msg.assistant').find('time.msg-time').exists()).toBe(true);
  });
});

describe('MessageBubble · #243：终局正文是被文本化工具调用时的中性状态行', () => {
  it('⑥ textualized=true ⇒ 气泡内出中性状态行，文案是本地化状态词且不含告警词', () => {
    const w = mountBubble({ role: 'assistant', text: '⟨|DSML invoke name=…', textualized: true });
    const notice = w.get('[data-test="textualized-notice"]');
    // 挂在气泡内部（与该轮正文同一气泡），文案是状态词（机器标记 / 可能不完整）
    expect(w.get('.msg.assistant').find('[data-test="textualized-notice"]').exists()).toBe(true);
    expect(notice.text()).toContain('机器标记');
    expect(notice.text()).toContain('可能不完整');
    // run 正常结束⇒中性而非报错：不得出现「错误/失败」告警词，也不抢红色 .syserr
    expect(notice.text()).not.toMatch(/错误|失败/);
    expect(notice.classes()).not.toContain('syserr');
    expect(notice.attributes('title')).toContain('正常结束');
  });

  it('⑦ 无 textualized（缺省）⇒ **不渲染**状态行，也不冒出 undefined', () => {
    const w = mountBubble({ role: 'assistant', text: '正常结论' });
    expect(w.find('[data-test="textualized-notice"]').exists()).toBe(false);
    expect(w.text()).not.toMatch(/undefined|机器标记/);
  });

  it('⑧ en 语下同一开关⇒英文状态文案（双语都真写了）', () => {
    setLocale('en');
    const w = mountBubble({ role: 'assistant', text: 'x', textualized: true });
    const notice = w.get('[data-test="textualized-notice"]');
    expect(notice.text().toLowerCase()).toContain('machine marker');
    expect(notice.text().toLowerCase()).toContain('incomplete');
    expect(notice.text()).not.toMatch(/error|failed/i);
  });
});
