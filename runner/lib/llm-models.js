// issue #38 Phase B2：心跳下行模型集的 agent 侧纯函数（零依赖，可单测）。
//
// 传导链：portal 心跳响应 `models` 字段（{ main: {model,type}, embedding?, vision? }，上游真模型名）
//   → agentd parseHeartbeatModels 存 state.llmModels（IPC 内存传递，**不落任何文件/日志**）
//   → spawnWorker 的 RUN_START 带模型快照（run 启动瞬间锁定）
//   → worker resolveRunModel 用下行名覆盖占位 config.json 的 model 字段（endpoint/key 仍走占位文件）。
//
// 向后兼容：旧 portal 不下行 models / 无配置（models: null）/ 未知字段 → parseHeartbeatModels 返回
// null → state.llmModels=null → RUN_START 不带 models → worker 用占位 config 的 model 名（现状行为）。
//
// issue #309 切片 2：main 槽位多带两个**可选**元数据键 `context_window` / `max_output_tokens`
// （portal 心跳原样，snake_case；权威位 = litellm `model_info.context_window` /
// `model_info.max_output_tokens`）。它们决定引擎的压缩总开关与单轮输出上限，因此
// **必须经过本模块的纯函数 resolveModelMetadata 钳制**后才能喂给引擎（见该函数注释里的死法）。
// 命名纪律（决策者定稿）：整条链只有两种形态——心跳原样的 `context_window`/`max_output_tokens`
// 与引擎入参的 `contextWindowTokens`/`maxOutputTokens`/`maxTokens`；camelCase 那三个只允许出现在
// worker 构造引擎入参的那一处（映射点唯一），本模块内一律 snake_case，也不要发明第四个名字。

/** 正整数（且是安全整数）——两个元数据键唯一的合法形态：0/负数/小数/字符串/布尔/NaN 一律不认。 */
function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * 解析心跳响应的 models 字段。结构非法/缺失/空 → null（与「无下行」同义，调用方保持现状行为）。
 * 只认三个已知槽位且 model 必须是非空字符串；type 以 portal 下行值为准（portal 侧已按槽位校验）。
 *
 * issue #309 切片 2：main（以及 embedding/vision，同一套规则）额外**透传** `context_window` /
 * `max_output_tokens` 两个键——**只收正整数**，其它形态（缺失 / `0` / 负数 / 小数 / `"1e3"` 这类
 * 字符串 / `true` / `NaN`）一律**丢掉该键**（`main.model` 照样解析成功，模型名语义与本单无关）。
 * 丢键而非置 `undefined` 是刻意的：无这两键时返回值与改动前**逐字节相同**（向后兼容面，
 * 见 runner/test/llm-models.test.js 的 deepStrictEqual 用例）。
 * 本函数只管「收到没有」，**合法性钳制不在这里**（那是 resolveModelMetadata 的活）。
 */
export function parseHeartbeatModels(data) {
  const m = data?.models;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const out = {};
  for (const slot of ['main', 'embedding', 'vision']) {
    const s = m[slot];
    if (s && typeof s === 'object' && typeof s.model === 'string' && s.model.length > 0) {
      out[slot] = { model: s.model, type: typeof s.type === 'string' ? s.type : slot === 'main' ? 'text' : slot };
      // issue #309 切片 2：只正整数才收，非法形态整键不写（不是写 undefined——那会让
      // 「无元数据的下行」在结构与日志面上都跟现状不一样）。
      if (isPositiveInt(s.context_window)) out[slot].context_window = s.context_window;
      if (isPositiveInt(s.max_output_tokens)) out[slot].max_output_tokens = s.max_output_tokens;
    }
  }
  // main 是必备位：portal 有 active binding 时必带；缺 main 视为不完整下行，整体不采用。
  if (!out.main) return null;
  return out;
}

/**
 * 解析 run 实际使用的模型名：RUN_START 带下行模型集 → 用 main.model（真模型名，进请求体 model 字段）；
 * 否则（旧 agentd / 无配置）→ 占位 config.json 的 model 名。endpoint/key 始终走占位文件，本函数只定 model 名。
 */
export function resolveRunModel(defaultModel, models) {
  const m = models?.main?.model;
  return typeof m === 'string' && m.length > 0 ? m : defaultModel;
}

/**
 * issue #309 切片 2：把下行模型元数据换算成「能安全喂给引擎」的一对值。**钳制必须在这个纯函数里**
 * ——worker 只做装配与告警，否则这条判据只能靠起进程测，测不住。
 *
 * 为什么非要钳（硬红线）：引擎在启动期算预算时**没有 try/catch**——
 * `erix-agent` 0.20.0 `src/loop/orchestrator.js:1141-1148` 直调 `computeBudget()`（
 * `src/compact/budget.js`：非正整数、或 `ctx − maxOut − max(2000,⌈10%·ctx⌉) ≤ 0` 就抛
 * `KitError invalid_budget`，`retryable:false`）与 `validateBudget()`（非正安全整数同样抛）。
 * 后果不是「这一轮不好」，而是**每个 run 第 1 轮之前就失败**——比现在「不压缩」更糟。
 *
 * 规则（决策者定稿，非法值按 1/4 兜底）：
 * 1. `context_window` 是正整数且 `max_output_tokens` 是正整数且 `≤ floor(context_window/4)` → 原样；
 * 2. `max_output_tokens` 非法（非正整数）**或** `> floor(context_window/4)` → **钳成 `floor(context_window/4)`**
 *    （`clamped: true` + `clamped_from` 回报原值，调用方据此发 warn，run 照跑）；
 *    边界：正好等于 `floor(context_window/4)` **不算被钳**（portal 侧 1/4 校验用的就是同一个上限）；
 * 3. `context_window` 非法 / 缺失（无论 `max_output_tokens` 是什么，也无论有没有下行）→ **返回 `null`**
 *    = 「什么都不传」= 现状行为（引擎自己发一次性 `model_metadata_missing`，压缩开关不进入）。
 *    这一支不硬塞 0：`context_window: 0` 会让 computeBudget 直接抛 invalid_budget。
 *
 * 已知边界（本单不覆盖，见工单 §2.2 与报告的「已知边界」）：`context_window` 合法但极小时，
 * 钳后的 1/4 仍可能让引擎那条公式算出非正预算；封它需要在 runner 里复制引擎内部公式，本单不做。
 *
 * @param {{main?:{model?:string,context_window?:unknown,max_output_tokens?:unknown}}|null|undefined} models RUN_START 的下行模型快照
 * @returns {{context_window:number, max_output_tokens:number, clamped:boolean, clamped_from:unknown}|null}
 */
export function resolveModelMetadata(models) {
  const main = models?.main;
  if (!main || typeof main !== 'object') return null; // 无下行（旧 portal / 无配置）→ 现状行为
  const ctx = main.context_window;
  if (!isPositiveInt(ctx)) return null; // 规则 3：ctx 是唯一的「整对不传」判据，maxOut 再体面也没用
  const quarter = Math.floor(ctx / 4);
  const maxOut = main.max_output_tokens;
  if (isPositiveInt(maxOut) && maxOut <= quarter) {
    return { context_window: ctx, max_output_tokens: maxOut, clamped: false, clamped_from: maxOut };
  }
  return { context_window: ctx, max_output_tokens: quarter, clamped: true, clamped_from: maxOut };
}
