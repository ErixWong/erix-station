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
// issue #228 / #299：工具结果的展示文本（上游 erix-agent 文件工具的**四种**成功返回形态）
//
// 0.20.0 把这四形态钉成了契约（guide-0.20.0 §6，上游 #220），并且导出了判别式：
//   | 工具 | 成功形态 | `classifyFileToolResult().kind` |
//   | --- | --- | --- |
//   | `readFile` | `string` | `text` |
//   | `edit` | `string` | `text` |
//   | `writeFile` | `number`（写入字节数，**0 = 成功写了空文件**） | `bytes` |
//   | `searchText` | `{ content, metadata }` | `content-metadata` |
//   | （其它/错误结果） | 字符串或任意 | `unknown` |
// 上游判别式 `classifyFileToolResult` 从 **`erix-agent/tools` 子路径**导出（**不在包根**，ADR-005）。
// 本文件**故意不引它**：前端不依赖 erix-agent（`grep -rE "from ['\"]erix-agent" portal/frontend/src` = 0 命中，
// 也不在 portal/frontend/package.json 的 deps/devDeps 里，见 #299 报告），所以这里**保持手写**。
// ⇒ 上游新增第五种形态时，只有随包契约套件与 runner/lib/file-tools.js（已改用判别式）会先红，
// 本函数会走 JSON 兜底——下一班请**先改上面这张表**再动代码，不要重新发现已有四形态。
//
// 两个已被上游点名的坑（别重新踩）：`if (!result)` 把 writeFile 的 0 当失败；
// `typeof result === 'string'` 不是成败判据（**错误结果也是字符串**）。
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

// ---------------------------------------------------------------------------
// issue #299（erix-agent 0.20.0 / host-upgrade-guide-0.20.0 §7，上游 #286 追加项）：
// `executionStatus` 的存在条件——**只在特殊状态下存在**（0.25.0 起是三种，上游 #409 加了 `rejected`）
//   * `intercepted` = 审计拦截（调用从未执行）
//   * `interrupted` = resume 改写 / 续跑时被中止
//   * `rejected`    = **引数解析失败**（工具从未执行；判词见引擎 `src/messages/tool-arguments.js`）
// 普通成功或失败的结果块上这个字段是**缺席**的（`undefined`）——不是空串、也不是 `ok` 占位。
// 机器可读条件在引擎常量里：`TOOL_RESULT_CONTRACT.engine.fields.executionStatus`
//   = `{ writtenFor: "special states only", presentValues: ["intercepted","interrupted","rejected"] }`
//   （`tool-fact.js:77`，0.25.0 实测）。⚠ **这张表由上游驱动**：0.23→0.25 就加了一个值，上面那句
//   「两种」的旧注释已经错过一次 ⇒ 升级引擎时必须与随包契约套件同时核，不要手改口径。
//
// ⚠ 因此**禁止**把「字段存在」当成「这个块值得关注」的判据（那是 0.19 之前的误读）：
//    判特殊状态请拿值与**这张表**比，用下面的 `isSpecialExecutionStatus`，不要写 `!== undefined`。
//    随包 `toolResultEnvelopeContract` 现在会在普通块上**无条件断言其缺席**。
// ---------------------------------------------------------------------------

/** 引擎 `erix.executionStatus` 的合法取值（与上游常量 `TOOL_RESULT_CONTRACT…presentValues` 逐项一致）。 */
export const SPECIAL_EXECUTION_STATUSES = ['intercepted', 'interrupted', 'rejected'] as const;

/** 值比对（不是存在性比对）：这个 executionStatus 是不是「值得关注」的特殊状态。 */
export function isSpecialExecutionStatus(status: unknown): boolean {
  return typeof status === 'string'
    && (SPECIAL_EXECUTION_STATUSES as readonly string[]).includes(status);
}
