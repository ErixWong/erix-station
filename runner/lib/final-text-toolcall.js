// issue #243 —— 终局正文「文本化工具调用」识别（宿主侧兜底的第一块砖）。
//
// 现象（工单原文 + 两次真机演练）：模型经 LiteLLM 把 tool call 以标记形式**吐进 `content`**
// （而不是 provider 的 `tool_calls` 字段），引擎没有识别 ⇒ 当作最终文本收下、run 正常
// `finished` 结束。用户在工作台看到的「最终回复」就是那一堆标记 ⇒ **等于没交报告**，而
// `termination.reason` 仍是正常值（静默发生）。本模块只回答一个问题：
// **这段终局正文看起来像不像「被文本化的工具调用」**——不发事件、不改终态、不碰引擎。
//
// ── 缺省特征集为什么是这四条（**取证在下方注释里，不是拍的**）────────────────────────
// 前**三条**来自本机 dev 库 `station-db` 的**真实样本**（只读查询，2026-11-16 现查）；
// **第四条是预防性覆盖**（下面逐条标了它是实证还是预防——别把预防写成实证）：
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
// 4. `<invoke` —— XML 那一族（Anthropic/LiteLLM 把 tool call 编成 `<invoke name="exec">…</invoke>`）。
//    ⚠ **预防性覆盖，不是实证**：261116 返工现查 dev 库，`<invoke name=` 在 `run_events.payload`、
//    `messages.content`、`transcript_rounds(record/messages)` 三处**各 0 命中**（同一批查询里
//    `DSML` 的阴性对照是 6 / 1 / 8 行 ⇒ 不是查法失效，是库里真没有）。加它的理由只有两条：
//    形态确定（第三方复审在 PR #555 上复现了 `detect('<invoke name="exec">…') => hit:false`），
//    且**含 `<`、长度 7**，正常交付在代码块**外**裸写它的概率极低（代码块已剥）。
//
// 5. `chatcmpl-tool-`（**不含 `<`** 的那一族）—— OpenAI/LiteLLM 把 tool call 的 **id** 直接写进 content
//    时的前缀形态（第三方复审在 PR #555 上复现 `detect('…chatcmpl-tool-abc123def456') => hit:false`）。
//    它进不了「条目必须含 `<`」这条规则，而那条规则是**防误伤的承重墙**（`off` 会命中 "offset"），
//    所以不是把门槛调低，而是把「**像一个 id 前缀**」写成判据：
//    **不含 `<` 的条目要求长度 ≥12 且含 `-`**（`chatcmpl-tool-` 长 13、含 `-` ⇒ 过；
//    `chatcmpl` 长 8 ⇒ 拒；`offset` / `offer` ⇒ 拒）。
//    ⚠ 同样是**预防性覆盖，不是实证**：`chatcmpl-tool-` 在 `run_events.payload`、`messages.content`、
//    `transcript_rounds` 三处**各 0 命中**；`chatcmpl` 裸串全库只捞到 1 行，且那行是某个 run
//    用 `writeFile` 写下去的测试脚本正文（`tool_use` 载荷，不是终局正文）⇒ 它同时说明
//    「裸 `chatcmpl` 会出现在正常内容里」，这就是为什么进缺省的是**带 `-` 的 13 字符前缀**而不是短词。
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
//   全部条目都非法 ⇒ 回退缺省特征集，**不是**关掉检测（静默关掉 = 又把问题吞回去）。

/** 特征集的环境变量名（下发光纤与其余 runner 旋钮同族：compose → provisioner → 容器 env）。 */
export const TOOLCALL_MARKERS_ENV = 'ERIX_FINAL_TEXT_TOOLCALL_MARKERS';

/**
 * 缺省特征集（五条，逐条理由见文件头；**顺序即匹配优先级**，命中就带回是哪一条）。
 * 前三条是 dev 库真样本（**实证**），第四条 `<invoke` 与第五条 `chatcmpl-tool-` 是**预防性覆盖**
 * （库里现查各 0 命中，取数语句与读数在交付里；措辞不许写成实证）。
 * 值域说明：前四条**含 `<`** 且长度 ≥3 ⇒ 解析器对含 `<` 的条目拒的正是「短于 3」（`<` 会命中一切正文）；
 * 第五条**不含 `<`** ⇒ 它靠的是「**长度 ≥12 且含 `-**`」这条形状闸（「像 id 前缀」写成判据），
 * 同一个闸挡住 `off` / `chatcmpl` / `offset` 这类会咬自然语言的短词。
 */
export const DEFAULT_TOOLCALL_MARKERS = Object.freeze([
  '<｜｜DSML｜｜', '<tool_call', '<｜Function',
  '<invoke',            // XML 一族：**预防性覆盖**（dev 库现查 0 命中，理由见文件头）
  'chatcmpl-tool-',     // OpenAI 的 tool-call id 前缀：**预防性覆盖**，也是唯一一条**不含 `<`** 的
                        //（它进得来靠的是「长度 ≥12 且含 `-`」那条形状闸，不是靠把门槛调低）
]);

/** 显式关掉检测的哨兵值（整串就是它，大小写不敏感）。**必须显式写**，写错字不会静默关。 */
export const TOOLCALL_MARKERS_OFF = 'off';

/**
 * marker 片段的**字符上界**——三方同源（PR #555 复审 MED-2）：
 *   ① **runner**（本模块 `textualizedToolCallField`）与 `agentd` 的透传：超长的 marker
 *      **只丢 marker，布尔照传**（`textualized_tool_call: true` 照发）；
 *   ② **portal**（`internal.js` 的同名常量）：脏/超长 marker 仍 400，那是**契约闸**，
 *      但**新链路的产物不该走到那儿**；
 *   ③ 判据：`portal/test/textualized-toolcall.test.js` 的跨面行为格（拿真 `textualizedToolCallField`
 *      造的载荷必须过得了 portal 校验）+ 本模块的源码级对账格（两侧同名常量的数值必须相等，
 *      **不许两处各写一个裸数字**——那是下一次漂移的源头）。
 *
 * 为什么非要在源头丢：`internal.js` 的这道校验在**开事务之前**，400 会把**整条终态**打回
 * （终态不写、不重试，run 只能等租约过期 / reaper 收敛）⇒ 一个**纯观测性**的显示片段
 * 拿到了拒绝终态的能力，这是把可观测性变成可用性风险。marker 只是界面上的一段引用文本，
 * 丢了它界面少一句片段，事件与终态一个字都不受影响。
 */
export const TEXTUALIZED_MARKER_MAX_CHARS = 120;

/** 含 `<` 的条目至少这么长（`<x` 这种两字符子串会在正文里乱咬）。 */
const MIN_MARKER_LENGTH = 3;

/**
 * **不含 `<`** 的条目的形状闸（PR #555 复审 MED-1）：长度 ≥12 **且含 `-`**。
 *
 * 为什么需要它：OpenAI 那一族的特征是 tool-call **id 前缀**（`chatcmpl-tool-`），天生不含 `<`，
 * 而「条目必须含 `<`」是防误伤的承重墙（`off` 会命中 "offset"）。所以不是把门槛调低，
 * 而是把「**像一个 id 前缀**」写成判据：够长 + 带分隔符。缺省集合**不含**它（库里取不到真样本），
 * 但配置面收得下它 ⇒ FDE 现场遇到那一族时不必改代码。
 */
const MIN_BARE_MARKER_LENGTH = 12;
const BARE_MARKER_REQUIRED_CHAR = '-';

/** marker 能上界面的长度上界与 portal 同源 ⇒ 超长的条目**照样能判定**，只是命中时不带片段：这里先提示一句。 */
const MAX_CONFIG_MARKER_HINT = TEXTUALIZED_MARKER_MAX_CHARS;

/**
 * 解析特征集配置（纯函数：不读 `process.env`、不打日志、不抛错）。
 *
 * 口径（与 `runner/lib/config.js` 的 env 族同族，但这一族的「不静默」靠**返回值带账**）：
 * · `undefined` / `null` / 空串 / 全空白 ⇒ 缺省特征集（`source: 'default'`，无告警）。
 * · `off`（整串，大小写不敏感）⇒ 显式关闭：`disabled: true`、`markers: []`，并给一条人话告警
 *   （关闭是个会影响可见面的决定，必须留痕）。
 * · 逗号分隔 ⇒ 逐条 `trim`；空段丢掉不告警（`a,,b` 是手滑，不是写错值）。
 * · 含 `<` 的条目要求**长度 ≥3**；**不含 `<`** 的条目要求**长度 ≥12 且含 `-`**（「像 id 前缀」，
 *   收得下 `chatcmpl-tool-` 那一族，同时挡住 `off` / `chatcmpl` / `offset` 这类会咬自然语言的短词）；
 *   不合格者**丢弃该条并点名**（进 `invalid[]` + `warnings[]`）。
 * · 条目长过 `TEXTUALIZED_MARKER_MAX_CHARS` **不算非法**（照样判定），但会给一条告警：
 *   命中时那个 marker 片段不会上界面（上界三方同源，见下方 MED-2 注释）。
 * · 全部条目都被丢 ⇒ 回退缺省特征集并告警——**绝不因为配错就把检测关掉**。
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
      // 不含 `<` ⇒ 必须是「id 前缀」形态（长度 ≥12 且含 `-`），否则**承重墙**不放过它：
      // 一个不含 `<` 的短词会在正常交付里大面积命中（`off` 咬 "offset"、`offer` 咬 "offer"），
      // 每个 run 都刷一条中性提示 = 信号贬值 = 下一次真泄漏没人看。
      if (entry.length < MIN_BARE_MARKER_LENGTH || !entry.includes(BARE_MARKER_REQUIRED_CHAR)) {
        invalid.push({ value: entry, reason: `不含 \`<\` 又不是 id 前缀形态（要求长度 ≥${MIN_BARE_MARKER_LENGTH} 且含 \`${BARE_MARKER_REQUIRED_CHAR}\`），会命中普通自然语言` });
        warnings.push(`${key} 条目 ${JSON.stringify(entry)} 非法（不含 \`<\`，且长度 <${MIN_BARE_MARKER_LENGTH} 或不含 \`${BARE_MARKER_REQUIRED_CHAR}\`），已丢弃`);
        continue;
      }
    }
    if (entry.length > MAX_CONFIG_MARKER_HINT) {
      // 不是错误：这么长的字面串**照样参与判定**，只是命中后那个 marker 片段上不了界面
      // （上界与 portal 同源，见 `TEXTUALIZED_MARKER_MAX_CHARS`）。**提示一句而不是静默**——
      // 配了它的人该知道自己看到的提示会少一段。
      warnings.push(`${key} 条目 ${JSON.stringify(entry.slice(0, 24))}… 长 ${entry.length} > ${MAX_CONFIG_MARKER_HINT} ⇒ 命中时不再带 marker 片段（判定与事件不受影响，界面少一句引用）`);
    }
    const dedupKey = entry.toLowerCase();
    if (seen.has(dedupKey)) continue; // 重复条目不是错误，静默去重
    seen.add(dedupKey);
    markers.push(entry);
  }

  if (!sawAnyEntry) return { markers: [...DEFAULT_TOOLCALL_MARKERS], invalid, disabled: false, source: 'default', warnings };
  if (markers.length === 0) {
    warnings.push(`${key} 的全部条目都非法 ⇒ 回退缺省特征集（**不是**关掉检测：配错不该把可见面也吞掉）`);
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
  // MED-2：marker 超长 ⇒ **只丢这个显示片段，布尔照传**。命中与否由 `detect` 说了算，
  // 上界只管「这段文字能不能安全地送到界面」，不许反过来取消命中。
  if (typeof hit.marker === 'string' && hit.marker.length > TEXTUALIZED_MARKER_MAX_CHARS) {
    return { textualized_tool_call: true };
  }
  return { textualized_tool_call: true, textualized_tool_call_marker: hit.marker };
}
