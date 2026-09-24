// 单测：issue #69 会话历史下行——ticket.history → 引擎 initialMessages 纯映射。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapHistoryToInitialMessages } from '../lib/history.js';

test('mapHistoryToInitialMessages：正常映射为引擎消息形态（content:[{type:text,text}]）', () => {
  const out = mapHistoryToInitialMessages([
    { role: 'user', content: '上一次的问题' },
    { role: 'assistant', content: '上一次的回答' },
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: [{ type: 'text', text: '上一次的问题' }] },
    { role: 'assistant', content: [{ type: 'text', text: '上一次的回答' }] },
  ]);
});

test('mapHistoryToInitialMessages：content 非字符串 → String() 强转；null/undefined → 空串', () => {
  const out = mapHistoryToInitialMessages([
    { role: 'user', content: 42 },
    { role: 'assistant', content: null },
    { role: 'user', content: undefined },
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: [{ type: 'text', text: '42' }] },
    { role: 'assistant', content: [{ type: 'text', text: '' }] },
    { role: 'user', content: [{ type: 'text', text: '' }] },
  ]);
});

test('mapHistoryToInitialMessages：非法入参回退 []（非数组 / 元素缺 role）', () => {
  assert.deepEqual(mapHistoryToInitialMessages(null), []);
  assert.deepEqual(mapHistoryToInitialMessages('history'), []);
  assert.deepEqual(mapHistoryToInitialMessages({ role: 'user' }), []);
  assert.deepEqual(mapHistoryToInitialMessages([{ content: 'no role' }]), []);
  assert.deepEqual(mapHistoryToInitialMessages([{ role: '', content: 'x' }]), []);
  // 任一元素缺 role：整体回退（不做部分映射，避免半个会话上下文）
  assert.deepEqual(
    mapHistoryToInitialMessages([{ role: 'user', content: 'a' }, { content: 'broken' }]),
    [],
  );
});

test('mapHistoryToInitialMessages：空数组 → []', () => {
  assert.deepEqual(mapHistoryToInitialMessages([]), []);
});
