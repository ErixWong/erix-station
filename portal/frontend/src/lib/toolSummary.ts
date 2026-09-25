// 工具卡片单行摘要（issue #85，参照 pi web getToolPreview）：
// 从卡片 args（JSON 文本）里按工具语义取代表性键值——优先 command/path/file_path/pattern/query，
// 兜底第一个键的值，统一截 120 字符；args 不是可解析的对象 JSON 时返回 ''，
// 由调用方回退到 es 的 dig 摘要（旧 JSON 截 120 字语义）。
const PREVIEW_KEYS = ['command', 'path', 'file_path', 'pattern', 'query'] as const;
const PREVIEW_LEN = 120;

export function getToolPreview(argsText: string): string {
  let input: unknown;
  try {
    input = JSON.parse(argsText);
  } catch {
    return '';
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  for (const key of PREVIEW_KEYS) {
    if (key in input) return String((input as Record<string, unknown>)[key]).slice(0, PREVIEW_LEN);
  }
  return String((input as Record<string, unknown>)[keys[0]]).slice(0, PREVIEW_LEN);
}
