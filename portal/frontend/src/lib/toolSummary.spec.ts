// getToolPreview 单测（issue #85）：语义键优先 / 兜底首键 / 截 120 字 / 非对象 JSON 回退空串。
import { describe, expect, it } from 'vitest';
import { getToolPreview, getToolResultSummary } from './toolSummary';

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

// issue #228：上游 erix-agent 文件工具的返回形态按工具分三套（string / {content, metadata} / number），
// 展示文本在入口收敛成一次归一；这里钉的是「三种形态都不炸、且不显示成 [object Object]」。
describe('getToolResultSummary（工具结果 → 展示文本，issue #228）', () => {
  it('字符串原样返回（readFile / tree / edit 的正文，含尾部截断 marker）', () => {
    expect(getToolResultSummary('1: hello\n2: world')).toBe('1: hello\n2: world');
    expect(getToolResultSummary('a.txt:1:hit\n[共 3 行，剩余 1 行；下一步：readFile 传 offset=2 继续]'))
      .toBe('a.txt:1:hit\n[共 3 行，剩余 1 行；下一步：readFile 传 offset=2 继续]');
    expect(getToolResultSummary('')).toBe('');
  });

  it('number（writeFile 的字节数）转字符串，0 不被吞成空串', () => {
    expect(getToolResultSummary(9)).toBe('9');
    expect(getToolResultSummary(0)).toBe('0');
    expect(getToolResultSummary(true)).toBe('true');
  });

  it('{content, metadata} 只展示 content，metadata 不外泄成 JSON（截断信息本来就在 content 的 marker 里）', () => {
    expect(getToolResultSummary({
      content: 'a.js:1:hit\n[命中过多，已按 max_results=50 截断；下一步：searchText 传 offset=50 继续]',
      metadata: { searchHits: 50, searchTruncated: true, searchSkipped: { vendorDirectories: 3 } },
    })).toBe('a.js:1:hit\n[命中过多，已按 max_results=50 截断；下一步：searchText 传 offset=50 继续]');
    // content 本身是 number / 对象也要能归一
    expect(getToolResultSummary({ content: 0, metadata: {} })).toBe('0');
    expect(getToolResultSummary({ content: null, metadata: {} })).toBe('');
    // 没有 content 键的对象不算「结构化结果」，走下面的 JSON 兜底（不把 metadata 当成正文）
    expect(getToolResultSummary({ metadata: { searchHits: 0 } })).toBe('{"metadata":{"searchHits":0}}');
  });

  it('null / undefined → 空串（不渲染 "undefined"、不抛）', () => {
    expect(getToolResultSummary(null)).toBe('');
    expect(getToolResultSummary(undefined)).toBe('');
  });

  it('裸对象/数组走 JSON 兜底并截 400 字；循环引用不抛', () => {
    expect(getToolResultSummary({ foo: 'bar' })).toBe('{"foo":"bar"}');
    expect(getToolResultSummary([1, 2])).toBe('[1,2]');
    expect(getToolResultSummary({ x: 'y'.repeat(500) })).toHaveLength(400);
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => getToolResultSummary(circular)).not.toThrow();
    expect(typeof getToolResultSummary(circular)).toBe('string');
  });
});
