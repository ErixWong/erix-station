import { describe, expect, it } from 'vitest';
import { modelOptionLabel } from './modelLabel';
import type { LlmModel } from '../stores/admin';

// 只关心标签用到的字段，其余按 LlmModel 形状补齐即可。
function model(overrides: Partial<LlmModel>): LlmModel {
  return {
    id: 'uuid-1',
    provider_id: 'p1',
    model_id: '920aa0c6-f336-4085-b6b1-607660883b35',
    model_name: 'deepseek-flash',
    name: 'deepseek-flash',
    type: 'text',
    tool_calling: true,
    context_window: null,
    max_tokens: null,
    enabled: true,
    ...overrides,
  } as LlmModel;
}

describe('modelOptionLabel（下拉/提示里的模型标签）', () => {
  it('展示名与调用名相同（存量绝大多数）：只显示一次，不带 UUID', () => {
    expect(modelOptionLabel(model({}))).toBe('deepseek-flash');
  });

  it('展示名 ≠ 调用名（#296 双名）：显示名在前、调用名进括号', () => {
    expect(modelOptionLabel(model({ name: '深度求索 Flash' }))).toBe('深度求索 Flash (deepseek-flash)');
  });

  it('绝不打 UUID 主键（model_id）——这是本函数存在的全部理由', () => {
    const label = modelOptionLabel(model({ name: 'GPT-4o', model_name: 'gpt-4o' }));
    expect(label).toBe('GPT-4o (gpt-4o)');
    expect(label).not.toContain('920aa0c6');
    expect(label).not.toContain('uuid');
  });

  it('缺展示名时退回调用名；两者都缺才退回 model_id（宁可给个能认的）', () => {
    expect(modelOptionLabel(model({ name: '' }))).toBe('deepseek-flash');
    expect(modelOptionLabel(model({ name: '', model_name: '' })))
      .toBe('920aa0c6-f336-4085-b6b1-607660883b35');
  });
});
