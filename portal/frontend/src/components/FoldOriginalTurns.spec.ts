// issue #816 第④步a：折叠原文渲染组件的单测（这份渲染原先长在 StreamPanel 的折叠横幅里，
// 现在两处共用：旧横幅 + #816 折叠面板的每一行）。四态各一条 + 四类内容都画 + 占位收窄。
// 断言只认 DOM（类名 / 文本），不用 `w.emitted()`（NODE_ENV=production 下恒空 ⇒ 假红）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import FoldOriginalTurns from './FoldOriginalTurns.vue';
import { i18n, setLocale } from '../i18n';
import type { FoldedOriginalState } from '../stores/workbench';

function mountTurns(state: FoldedOriginalState, onRetry?: () => void) {
  return mount(FoldOriginalTurns, {
    props: { state },
    attrs: onRetry ? { onRetry } : {},
    global: { plugins: [i18n] },
  });
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
});

describe('FoldOriginalTurns · 四态（#816④a：单一实现，与 StreamPanel 旧横幅同一份）', () => {
  it('loading → 只有加载文案，不渲染任何 turn', () => {
    const w = mountTurns({ status: 'loading' });
    expect(w.text()).toBe('加载中…');
    expect(w.find('.folded-original-turn').exists()).toBe(false);
    expect(w.find('.folded-original-missing').exists()).toBe(false);
    expect(w.find('.folded-original-error').exists()).toBe(false);
  });

  it('missing（后端 404）→ 友好「无原文」，非红错、无重试按钮', () => {
    const w = mountTurns({ status: 'missing' });
    expect(w.get('.folded-original-missing').text()).toBe('这一段没有可显示的原文（账本里也没有）');
    expect(w.find('.folded-original-error').exists()).toBe(false);
    expect(w.find('.retry-original').exists()).toBe(false);
  });

  it('loaded + truncated → 夹断提示带上被丢掉的条数，turns 照渲染，不报红也不报「没原文」', () => {
    const w = mountTurns({
      status: 'loaded',
      turns: [{ role: 'assistant', text: '补齐的尾部原文' }],
      source: 'rebuilt',
      truncated: true,
      droppedMessages: 317,
    });
    const cap = w.get('.folded-original-truncated');
    expect(cap.text()).toContain('本次归档被截断');
    expect(cap.text()).toContain('317');
    expect(w.findAll('.folded-original-turn')).toHaveLength(1);
    expect(w.find('.folded-original-missing').exists()).toBe(false);
    expect(w.find('.folded-original-error').exists()).toBe(false);
  });

  it('loaded（未夹断）→ 不渲染夹断提示（旧后端无可选键，不拼 undefined）', () => {
    const w = mountTurns({ status: 'loaded', turns: [{ role: 'user', text: '存量全量归档' }] });
    expect(w.find('.folded-original-truncated').exists()).toBe(false);
    expect(w.text()).not.toContain('undefined');
    // #816 ④b：正文是**主对话同款气泡**（旧断言「角色标签 = 用户」就此作废——气泡自己就是角色）
    expect(w.get('.msg.user').text()).toBe('存量全量归档');
  });

  // #816 ④b：**有意的口径变更**——展开原文的正文不再是「角色标签 + `folded-original-text` 文本块」，
  // 而是与主对话**共用 `MessageBubble`** 的那一份气泡；旧的 `folded-original-role` 标签直接退役。
  it('正文在 `.msg` 气泡里（与主对话同一份渲染），且**不再**渲染 folded-original-role 角色标签（#816④b）', () => {
    const w = mountTurns({
      status: 'loaded',
      turns: [{ role: 'user', text: '用户问的那句' }, { role: 'assistant', text: '助手答的那句' }],
    });
    const bubbles = w.findAll('.msg');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0].classes()).toContain('user');
    expect(bubbles[0].text()).toContain('用户问的那句');
    // markdown 路径与助手终稿一致（`.md` 由 `MessageBubble` 自己按 html 加上）
    expect(bubbles[1].classes()).toEqual(expect.arrayContaining(['assistant', 'md']));
    expect(bubbles[1].text()).toContain('助手答的那句');
    // 角色标签彻底没了（键也随之下线 ⇒ localeParity 绿）
    expect(w.findAll('.folded-original-role')).toHaveLength(0);
    // 但旧 DOM 钩子 `folded-original-text` 仍在（落在气泡自己身上 ⇒ StreamPanel 的既有定位不破）
    expect(w.findAll('.folded-original-text')).toHaveLength(2);
    expect(w.get('.msg.user').classes()).toContain('folded-original-text');
  });

  // #384 的病症：只画 text ⇒ 真的干了活的那几轮（只有 reasoning + 工具调用）整片渲染成空行。
  it('loaded → user 身份 + 正文 + reasoning + 工具行（name/argsSummary/resultPreview）四类都画', () => {
    const w = mountTurns({
      status: 'loaded',
      turns: [{
        role: 'user',
        text: '把仓库 clone 下来',
        reasoning: '先看工作目录再决定 clone 方式',
        toolCalls: [{ name: 'exec', argsSummary: 'git clone …', isError: true, resultPreview: 'cloned ok' }],
      }],
    });
    const turn = w.get('.folded-original-turn');
    // #816 ④b：正文改住**主对话同款气泡**（`.msg.user`），不再是 `folded-original-text` 文本块 + 角色标签
    expect(turn.get('.msg.user').text()).toContain('把仓库 clone 下来');
    expect(turn.find('.folded-original-role').exists()).toBe(false);
    expect(turn.get('.folded-original-reasoning').text()).toContain('先看工作目录再决定 clone 方式');
    const tool = turn.get('.folded-original-tool');
    expect(tool.text()).toContain('exec');
    expect(tool.text()).toContain('git clone …');
    expect(tool.text()).toContain('（失败）');
    expect(tool.get('.folded-original-tool-result').text()).toContain('cloned ok');
    // 占位语义已收窄成「这一条真的什么都没有」⇒ 有内容就不许多画占位
    expect(turn.text()).not.toContain('（无文本内容）');
  });

  // #387：结果配不上时 `resultPreview` **键缺席**（不是空串）⇒ 宁可少一行，不许凭空造「↳ （空）」。
  it('loaded → toolCalls 无 resultPreview 时不画结果行（不许冒出「↳ （空）」）', () => {
    const w = mountTurns({
      status: 'loaded',
      turns: [
        { role: 'assistant', toolCalls: [{ name: 'readFile', argsSummary: 'src/a.ts' }] },
        { role: 'assistant', toolCalls: [{ name: 'exec', argsSummary: 'ls', resultPreview: '' }] },
      ],
    });
    const tools = w.findAll('.folded-original-tool');
    expect(tools).toHaveLength(2);
    expect(tools[0].findAll('.folded-original-tool-result')).toHaveLength(0);
    expect(tools[1].findAll('.folded-original-tool-result')).toHaveLength(0);
    expect(w.text()).not.toContain('↳ （空）');
    expect(w.findAll('.folded-original-turn')[0].text()).not.toContain('（无文本内容）');
  });

  it('loaded 但四类都空 → 才给占位；turns 为空数组 → 同样只给一条占位', () => {
    const one = mountTurns({ status: 'loaded', turns: [{ role: 'assistant' }] });
    expect(one.findAll('.folded-original-turn')).toHaveLength(1);
    expect(one.get('.folded-original-turn').text()).toBe('（无文本内容）');
    const none = mountTurns({ status: 'loaded', turns: [] });
    expect(none.findAll('.folded-original-turn')).toHaveLength(0);
    expect(none.text()).toBe('（无文本内容）');
  });

  it('error → 红字带原因 + 重试按钮；点重试把 retry 交给宿主（不自己改状态）', async () => {
    const onRetry = vi.fn();
    const w = mountTurns({ status: 'error', message: 'boom' }, onRetry);
    expect(w.get('.folded-original-error').text()).toContain('原文加载失败：boom');
    await w.get('.retry-original').trigger('click');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
