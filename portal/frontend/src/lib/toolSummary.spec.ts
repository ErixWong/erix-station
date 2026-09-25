// getToolPreview 单测（issue #85）：语义键优先 / 兜底首键 / 截 120 字 / 非对象 JSON 回退空串。
import { describe, expect, it } from 'vitest';
import { getToolPreview } from './toolSummary';

describe('getToolPreview（工具卡片单行摘要）', () => {
  it('优先取 command/path/file_path/pattern/query 等语义键', () => {
    expect(getToolPreview('{"command":"ls -la"}')).toBe('ls -la');
    expect(getToolPreview('{"path":"/tmp/a.txt"}')).toBe('/tmp/a.txt');
    expect(getToolPreview('{"file_path":"src/main.ts"}')).toBe('src/main.ts');
    expect(getToolPreview('{"pattern":"TODO"}')).toBe('TODO');
    expect(getToolPreview('{"query":"select 1"}')).toBe('select 1');
  });

  it('语义键优先于其他键（即使排后面）', () => {
    expect(getToolPreview('{"timeout":30,"command":"make test"}')).toBe('make test');
  });

  it('无语义键时兜底第一个键的值', () => {
    expect(getToolPreview('{"content":"hello"}')).toBe('hello');
    expect(getToolPreview('{"timeout":30,"shell":"/bin/bash"}')).toBe('30');
  });

  it('统一截 120 字符', () => {
    const long = 'x'.repeat(200);
    expect(getToolPreview(`{"command":"${long}"}`).length).toBe(120);
    expect(getToolPreview(`{"zzz":"${long}"}`).length).toBe(120);
  });

  it('非对象 JSON / 解析失败返回空串（调用方回退 dig）', () => {
    expect(getToolPreview('')).toBe('');
    expect(getToolPreview('not json')).toBe('');
    expect(getToolPreview('"plain"')).toBe('');
    expect(getToolPreview('[1,2]')).toBe('');
    expect(getToolPreview('{}')).toBe('');
  });

  it('键值非字符串时转 String', () => {
    expect(getToolPreview('{"path":123}')).toBe('123');
    expect(getToolPreview('{"query":null}')).toBe('null');
  });
});
