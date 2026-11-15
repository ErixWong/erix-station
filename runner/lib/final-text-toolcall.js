// issue #243 —— 终局正文「文本化工具调用」识别（宿主侧兜底的第一块砖）。
//
// 现象（工单原文 + 两次真机演练）：模型经 LiteLLM 把 tool call 以标记形式**吐进 `content`**
// （而不是 provider 的 `tool_calls` 字段），引擎没有识别 ⇒ 当作最终文本收下、run 正常
// `finished` 结束。用户在工作台看到的「最终回复」就是那一堆标记 ⇒ **等于没交报告**，而
// `termination.reason` 仍是正常值（静默发生）。本模块只回答一个问题：
// **这段终局正文看起来像不像「被文本化的工具调用」**——不发事件、不改终态、不碰引擎。
//
// ── 缺省特征集为什么是这三条（**取证在下方注释里，不是拍的**）────────────────────────
// 三条全部来自本机 dev 库 `station-db` 的**真实样本**（只读查询，2026-11-16 现查）：
//
// 1. `<｜｜DSML｜｜`（U+FF5C ×2 + `DSML` + U+FF5C ×2）——DSML 那一族的**前缀**。
//    样本 A（run `f4dfea1d-c439-…`，2026-10-11，`round_end.payload.final_text` seq 37223，
//    `encode(convert_to(...,'UTF8'),'hex')` 逐字核过码点 `3c ff5c ff5c 44 53 4d 4c ff5c ff5c`）：
//        `<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="shell">\n<｜｜DSML｜｜parameter …`
//    样本 B（run `11fa3c68-353b-…`，2026-09-24，`messages` 行 `0549e113-…`）：
//        `<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="shell">…`  ← **标记名前多一个空格**
//    ⚠ 所以**不能拿 `<｜｜DSML｜｜invoke` 当特征**：样本 A 的第一行是 `tool_calls`（不是 invoke），
//    样本 B 那个标记写作 `<｜｜DSML｜｜ invoke`（带空格）——两条真实样本都**命不中**那个字面串。
//    取「到 `｜｜` 为止的前缀」才同时覆盖 `tool_calls` / `invoke` / `parameter` 与带空格变体。
// 2. `<tool_call` —— 覆盖 `<tool_calls>` / `<tool_call>` / `<tool_call name=…>`。
// 3. `<｜Function` —— 覆盖 `<｜Function_calls｜>` / `<｜Function=…｜>` 一族（同一个 U+FF5C 族）。
//
// ⚠ **不许只钉 DSML 一条**：这类泄漏的成因是「上游/网关把 tool call 编进 content」，不同上游
// 的编码不同（工单原文：「只要所用模型的 tool-call 编码落到 content…就会复现，不是偶发」）。
//
// ── 匹配口径（误伤面就写在这里）────────────────────────────────────────────────
// · 命中判据 = **逐字子串**（大小写不敏感，U+FF5C 不受大小写影响）。不做位置/结构推断。
// · 匹配前先剥掉 ``` 代码块与 `行内代码`：正常交付摘要**引用**这些标记时是写在代码里的
//   （本仓的台账/文档就是这么写的），那段是「谈这个标记」不是「泄漏了这个标记」。
//   两条真实样本里都没有反引号（现查），剥代码不会把真泄漏剥掉。
// · 「提到工具名」（「我调用了 shell 工具」）天然不命中：那里面没有 `<`。
// · 残余误伤面（诚实标注）：正文在代码块**之外**裸写 `<tool_call` 这类字面串的正常交付摘要
//   会被判真。本模块的结论只是「值得提示」，不是「失败」——下游一律按**中性提示**渲染。
// · 非法特征值**不许静默**：`invalid[]` 逐条带原值与理由，`warnings[]` 是人话（点名是哪个值）；
//   全部条目都非法 ⇒ 回退缺省三条，**不是**关掉检测（静默关掉 = 又把问题吞回去）。

/** 特征集的环境变量名（下发光纤与其余 runner 旋钮同族：compose → provisioner → 容器 env）。 */
export const TOOLCALL_MARKERS_ENV = 'ERIX_FINAL_TEXT_TOOLCALL_MARKERS';

/**
 * 缺省特征集（三条，逐条理由见文件头；**顺序即匹配优先级**，命中就带回是哪一条）。
 * 值域说明：这三条都含 `<`，且长度 ≥3 —— 下面解析器拒绝的正是「不含 `<`」与「短于 3」两类，
 * 因为那种值会在自然语言里大面积误伤（`off` 会命中 "offset"，`<` 会命中一切正文）。
 */
export const DEFAULT_TOOLCALL_MARKERS = Object.freeze(['<｜｜DSML｜｜', '<tool_call', '<｜Function']);

/** 显式关掉检测的哨兵值（整串就是它，大小写不敏感）。**必须显式写**，写错字不会静默关。 */
export const TOOLCALL_MARKERS_OFF = 'off';

/** 一条特征至少这么长（`<x` 这种两字符子串会在正文里乱咬）。 */
const MIN_MARKER_LENGTH = 3;

/**
 * 解析特征集配置（纯函数：不读 `process.env`、不打日志、不抛错）。
 *
 * 口径（与 `runner/lib/config.js` 的 env 族同族，但这一族的「不静默」靠**返回值带账**）：
 * · `undefined` / `null` / 空串 / 全空白 ⇒ 缺省三条（`source: 'default'`，无告警）。
 * · `off`（整串，大小写不敏感）⇒ 显式关闭：`disabled: true`、`markers: []`，并给一条人话告警
 *   （关闭是个会影响可见面的决定，必须留痕）。
 * · 逗号分隔 ⇒ 逐条 `trim`；空段丢掉不告警（`a,,b` 是手滑，不是写错值）。
 * · 每条必须**长度 ≥3 且含 `<`**；否则**丢弃该条并点名**（进 `invalid[]` + `warnings[]`）。
 * · 全部条目都被丢 ⇒ 回退缺省三条并告警——**绝不因为配错就把检测关掉**。
 *
 * @param {unknown} raw 原始 env 值（字符串；其它类型按 `String()` 处理，不抛错）
 * @param {{ key?: string }} [opts] `key` 只影响告警里点名的变量名
 * @returns {{ markers: string[], invalid: Array<{value: string, reason: string}>,
 *            disabled: boolean, source: 'default'|'env', warnings: string[] }}
 */
export function parseToolCallMarkers(raw, { key = TOOLCALL_MARKERS_ENV } = {}) {
  const warnings = [];
  const invalid = [];
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (text === '') return { markers: [...DEFAULT_TOOLCALL_MARKERS], invalid, disabled: false, source: 'default', warnings };

  if (text.toLowerCase() === TOOLCALL_MARKERS_OFF) {
    warnings.push(`${key}=${JSON.stringify(text)} ⇒ 显式关闭终局文本化工具调用检测（#243 的降级交付提示将不再出现）`);
    return { markers: [], invalid, disabled: true, source: 'env', warnings };
  }

  const seen = new Set();
  const markers = [];
  let sawAnyEntry = false;
  for (const piece of text.split(',')) {
    const entry = piece.trim();
    if (entry === '') continue; // 空段：手滑的逗号，不算「写错一个值」，不告警
    sawAnyEntry = true;
    if (entry.length < MIN_MARKER_LENGTH) {
      invalid.push({ value: entry, reason: `长度 < ${MIN_MARKER_LENGTH}，会在正文里大面积误伤` });
      warnings.push(`${key} 条目 ${JSON.stringify(entry)} 非法（长度 < ${MIN_MARKER_LENGTH}），已丢弃`);
      continue;
    }
    if (!entry.includes('<')) {
      invalid.push({ value: entry, reason: '不含 `<`，不是标记类字面串，会命中普通自然语言' });
      warnings.push(`${key} 条目 ${JSON.stringify(entry)} 非法（不含 \`<\`，不是标记形态），已丢弃`);
      continue;
    }
    const dedupKey = entry.toLowerCase();
    if (seen.has(dedupKey)) continue; // 重复条目不是错误，静默去重
    seen.add(dedupKey);
    markers.push(entry);
  }

  if (!sawAnyEntry) return { markers: [...DEFAULT_TOOLCALL_MARKERS], invalid, disabled: false, source: 'default', warnings };
  if (markers.length === 0) {
    warnings.push(`${key} 的全部条目都非法 ⇒ 回退缺省三条（**不是**关掉检测：配错不该把可见面也吞掉）`);
    return { markers: [...DEFAULT_TOOLCALL_MARKERS], invalid, disabled: false, source: 'default', warnings };
  }
  return { markers, invalid, disabled: false, source: 'env', warnings };
}

/**
 * 从 env 解析特征集（薄壳：只做「读哪个键」这一件事，判据全在 `parseToolCallMarkers`）。
 * 调用方负责把 `warnings` 落到 LOG 面（runner 侧是 `MSG.LOG`；**不要**丢返回值）。
 */
export function toolCallMarkersFromEnv(env = process.env, { key = TOOLCALL_MARKERS_ENV } = {}) {
  return parseToolCallMarkers(env?.[key], { key });
}

/** 剥掉 ``` 围栏与 `行内代码`（见文件头「匹配口径」；两条真实样本都不含反引号）。 */
function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/**
 * 这段终局正文是不是「被文本化的工具调用」？
 *
 * @param {unknown} text 终局正文（`result.finalText`）
 * @param {readonly string[]} [markers] 特征集（缺省 = `DEFAULT_TOOLCALL_MARKERS`）
 * @returns {{ hit: boolean, marker: string | null, chars: number }}
 *   `chars` = 剥代码前的正文字符数（0 ⇒ 没有正文，谈不上降级交付）。
 *   空正文/非字符串 ⇒ `hit: false`（**没有正文是另一件事**，#442 的 `finalTextFallback` 管）。
 */
export function detectTextualizedToolCall(text, markers = DEFAULT_TOOLCALL_MARKERS) {
  if (typeof text !== 'string' || text.trim() === '') return { hit: false, marker: null, chars: 0 };
  const haystack = stripCode(text).toLowerCase();
  for (const marker of markers ?? []) {
    if (typeof marker !== 'string' || marker === '') continue;
    if (haystack.includes(marker.toLowerCase())) return { hit: true, marker, chars: text.length };
  }
  return { hit: false, marker: null, chars: text.length };
}

// ---------------------------------------------------------------------------
// 事件面的两件事（工单第 2 步）：additive 字段怎么带、事件叫什么名字
//
// 载荷字段完全照 issue #442 的 `final_text_fallback` 那条链抄（`runner/lib/termination.js` 的
// `finalTextFallbackField` → `worker.js` 的 RUN_FINISHED 信封 → `agentd.js` 的逐字透传 →
// `portal/src/internal.js` 的 `finishRun`），三条口径一字不改：
//   ① **只在命中时给这两个键**（缺席 = 没命中）。绝不写 `false`：那会把「旧 runner 根本不认识
//      这个键」与「明确没命中」在 U2 载荷上分不开（#442 的同款理由）。
//   ② 命名跟既有 `final_text` 走 snake_case（IPC / U2 载荷都是这个风格）。
//   ③ **不改终态语义**：`termination.reason` / `usage` / `rounds` / `final_text` 一个字节都不动。
//      命中与否只多带一个布尔 + 命中的那条特征；界面那一半是 portal 在**同一个终态事务里**合成的
//      `textualized_tool_call` 事件（中性提示），红色面仍只由 `run_end` 负责（#212 口径）。
//
// 事件类型名要自解释：`textualized_tool_call` = 「终局正文是一段**被文本化的工具调用**」。
// 不叫 `anomaly` / `degraded` 那种含糊名 —— 含糊名的代价是下一个人得先猜它指什么，
// 而这一族事件已经因为「同一件事在三处各说各话」修过四次（#288 / #371-A / #421 / #442）。
// ---------------------------------------------------------------------------

/**
 * 诊断事件类型名。三处集合必须同改（漏一边就是「实时收不到」或「刷新后消失」）：
 * `portal/src/http.js` 的 `HISTORY_EVENT_TYPES` + 前端 `useEventStream.ts` 的 `EVENT_TYPES`
 * 与 `HISTORY_REPLAY_TYPES`。名字在本文件与 portal 侧各写一份字符串，由
 * `portal/test/textualized-toolcall.test.js` 的源码级断言对账（跨端不能 import）。
 */
export const TEXTUALIZED_TOOL_CALL_EVENT_TYPE = 'textualized_tool_call';

/**
 * 把识别结果换算成 RUN_FINISHED / U2 的 additive 字段。
 *
 * @param {unknown} finalText `result.finalText`
 * @param {readonly string[]} [markers] 特征集（调用方从 env 解析后传进来；空数组 = 显式关闭）
 * @returns {{ textualized_tool_call: true, textualized_tool_call_marker: string }|{}}
 *   命中 ⇒ 两个键；没命中 / 空正文 / 显式关闭 ⇒ **空对象**（一个字节都不多带）。
 */
export function textualizedToolCallField(finalText, markers = DEFAULT_TOOLCALL_MARKERS) {
  const hit = detectTextualizedToolCall(finalText, markers);
  if (!hit.hit) return {};
  return { textualized_tool_call: true, textualized_tool_call_marker: hit.marker };
}
