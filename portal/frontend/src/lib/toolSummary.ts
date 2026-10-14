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

// ---------------------------------------------------------------------------
// issue #228：工具结果的展示文本（上游 erix-agent 文件工具把返回形态分成了三套）
//
// 上游实测：`readFile` / `tree` / `edit` → string（截断信息写在尾部 marker 里）；
// `searchText` → **对象** `{content, metadata}`（metadata 进 transcript、不上 wire）；
// `writeFile` → **number**（写入字节数）。引擎会归一一道，但工作台不能依赖「上游永远给字符串」：
// 历史事件、DTO 投影、后续新工具都可能是三种形态之一，所以入口先收敛一次，
// 卡片里存的永远是字符串。
//
// 口径：
//   * `{content, metadata}` → 只展示 content。截断/跳过信息已经在 content 自己的 marker 文本里
//     （「[命中过多…下一步：searchText 传 offset=N 继续]」），不另造 UI、不新增文案；
//   * number（writeFile 字节数）→ String(0) 必须是 "0"，不能被 falsy 判空吞掉；
//   * null / undefined → 空串（没结果就是没结果，不能报「undefined」）；
//   * 其它对象/数组 → JSON 文本（沿用 dig 摘要的老兜底语义），仅这条路走长度闸门。
// ---------------------------------------------------------------------------

/** 非字符串结果的 JSON 兜底截断长度（与上游 resultPreview 的 400 字预览同口径）。 */
const RESULT_TEXT_LIMIT = 400;

/** 把任意工具结果（string / {content, metadata} / number / null）归一成展示文本。 */
export function getToolResultSummary(result: unknown): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'number' || typeof result === 'boolean' || typeof result === 'bigint') {
    return String(result);
  }
  if (typeof result === 'object' && !Array.isArray(result)
    && Object.prototype.hasOwnProperty.call(result, 'content')) {
    // 结构化结果：content 就是模型看到的正文（含截断/跳过 marker），递归归一防 content 又不是字符串。
    return getToolResultSummary((result as { content?: unknown }).content);
  }
  try {
    const serialized = JSON.stringify(result);
    return (typeof serialized === 'string' ? serialized : String(result)).slice(0, RESULT_TEXT_LIMIT);
  } catch {
    return String(result).slice(0, RESULT_TEXT_LIMIT);
  }
}

// ---------------------------------------------------------------------------
// issue #283：工具耗时的可读单位（三档，口径对齐 AGENTS §8.9 第 6 条）。
//
// 存进卡片的永远是**原始毫秒**（`ToolCardState.dur`），展示时才格式化；「没有时长」是
// `dur === undefined`，由调用方走「不渲染时长」分支——**不得把缺失当 0 传进来**
// （那正是 issue #283「恒显 0s」的前端共犯）。非有限数 / 负数一律返回空串，同样由调用方
// 当成「没有时长」处理（宁可不显示，也不给一个假的 `0ms`）。
//
// 三档：
//   * `< 1000`          → `Nms`（例 `0` → `0ms`、`432` → `432ms`、`999` → `999ms`）
//   * `1000 ≤ ms < 60000` → `X.Ys`，**截断**到一位小数（不四舍五入，免得 59999 显示成「60.0s」
//     这种跨档的值）：`1000` → `1.0s`、`4321` → `4.3s`、`59999` → `59.9s`
//   * `>= 60000`        → `Xm Ys`（秒取整）：`60000` → `1m 0s`、`125500` → `2m 5s`
// ---------------------------------------------------------------------------

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;

/** 把毫秒时长格式化成 `Nms` / `X.Ys` / `Xm Ys`；非有限数或负数 → 空串（调用方按「无时长」处理）。 */
export function formatDuration(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < MS_PER_SECOND) return `${Math.floor(ms)}ms`;
  if (ms < MS_PER_MINUTE) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const minutes = Math.floor(ms / MS_PER_MINUTE);
  const seconds = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND);
  return `${minutes}m ${seconds}s`;
}
