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
// 唯一例外（切片 2b）：本模块调上游 probe `computeBudget({ contextWindowTokens, maxOutputTokens })`
// 时**必须**用引擎那对 camelCase 键名——那是上游的入参名，不是我们的第四种形态（防漂移用例只扫
// worker.js 的**构造点**，probe 调用点是入参不是构造点，工单 §2.3 明确允许）。

/** 正整数（且是安全整数）——`resolveModelMetadata` 的钳制判据（**本模块内部的第二道闸**，见下面归一函数的注释）。 */
function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * issue #316：**token 数（`context_window` / `max_output_tokens`）的入口归一 —— 一条规则，两侧各执行一次**。
 *
 * 规则（决策者定稿，与 `portal/src/llm.js` 的 `positiveIntOrNull()` 是**同一条**，镜像测试在对面：
 * `runner/test/llm-models.test.js` ↔ `portal/test/llm.test.js`）：
 *   1. **正整数**（且是安全整数）→ 原样返回；
 *   2. **数字串**（`"262144"` / 带空白的 `" 262144 "`）与**整值浮点**（`262144.0`、字符串 `"262144.0"`）
 *      → **归一成正整数**（返回 number，不是原字符串）；
 *   3. **真小数**（`262144.5`）、`≤ 0`、`NaN`、`Infinity`、非数字串、布尔、对象 → **返回 `null` = 不可得**。
 *      ⚠ 判不可得**不是**取整、**不是**兜底成 0。
 *
 * 为什么第 2 条要容忍（#316 的病症本体）：门户读侧一直容忍数字串（`llm.js` 里那条同源的窗口判据，
 * 注释原话「兼容历史上存成数字串的值」⇒ 存量真的存在）。于是「门户列表显示着 262144、runner 解析层
 * 整键丢掉 ⇒ `resolveModelMetadata` 返回 null ⇒ **压缩静默关闭**」——同一个数在两侧有两种结论。
 * 让 runner **认下来**比让门户退回「没配」好：前者是「显示有数、压缩真开」，后者是「显示没数、压缩关」。
 *
 * 为什么第 3 条不许 floor：`262144.5` 是配错，floor 是在替管理员编一个他没填的数。两侧都判不可得
 * ⇒ 门户显示 null、心跳不带键、压缩关，**三处一致**，可解释。
 *
 * ⚠ 返回值一定是 `number`（或 `null`），**绝不把原字符串往下传**：下游 `resolveModelMetadata` 的
 * `Math.floor(ctx / 4)` 与引擎的 `computeBudget({contextWindowTokens, maxOutputTokens})` 都按数字算，
 * 喂字符串就是另一套「两侧各自解释」的坑（`"262144" / 4` 侥幸能算，`"262144" > floor(...)` 这类比较就先错了）。
 * 归一只做在**入口**（`parseHeartbeatModels`）：`resolveModelMetadata` 继续用严格的 `isPositiveInt`，
 * 万一有人绕过入口塞了怪值，那道钳制支路的行为与 #309 切片 2 逐字节相同。
 */
function positiveIntOrNull(value) {
  let raw = value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    raw = Number(trimmed);
  }
  return isPositiveInt(raw) ? raw : null;
}

/**
 * 解析心跳响应的 models 字段。结构非法/缺失/空 → null（与「无下行」同义，调用方保持现状行为）。
 * 只认三个已知槽位且 model 必须是非空字符串；type 以 portal 下行值为准（portal 侧已按槽位校验）。
 *
 * issue #309 切片 2：main（以及 embedding/vision，同一套规则）额外**透传** `context_window` /
 * `max_output_tokens` 两个键。**issue #316 起这两个键走 `positiveIntOrNull()` 归一**：数字串与整值浮点
 * 归一成正整数后**以 number 落盘**；真小数 / `0` / 负数 / 非数字串 / `true` / `NaN` 一律**丢掉该键**
 * （`main.model` 照样解析成功，模型名语义与本单无关）。丢键而非置 `undefined` 是刻意的：无这两键时
 * 返回值与改动前**逐字节相同**（向后兼容面，见 runner/test/llm-models.test.js 的 deepStrictEqual 用例）。
 * 本函数只管「收到没有 + 形态归一」，**合法性钳制不在这里**（那是 resolveModelMetadata 的活）。
 */
export function parseHeartbeatModels(data) {
  const m = data?.models;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const out = {};
  for (const slot of ['main', 'embedding', 'vision']) {
    const s = m[slot];
    if (s && typeof s === 'object' && typeof s.model === 'string' && s.model.length > 0) {
      out[slot] = { model: s.model, type: typeof s.type === 'string' ? s.type : slot === 'main' ? 'text' : slot };
      // issue #309 切片 2 + #316：过 `positiveIntOrNull()` 归一，**落盘的是归一后的 number**。
      // 不可得（含真小数/≤0/非数字串）⇒ 整键不写（不是写 undefined——那会让「无元数据的下行」
      // 在结构与日志面上都跟现状不一样）。
      const contextWindow = positiveIntOrNull(s.context_window);
      if (contextWindow !== null) out[slot].context_window = contextWindow;
      const maxOutputTokens = positiveIntOrNull(s.max_output_tokens);
      if (maxOutputTokens !== null) out[slot].max_output_tokens = maxOutputTokens;
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
 * 1. `context_window` 是正整数且 `max_output_tokens` 是正整数且 `≤ floor(context_window/4)` → 原样（候选）；
 * 2. `max_output_tokens` 非法（非正整数）**或** `> floor(context_window/4)` → **钳成 `floor(context_window/4)`**
 *    （`clamped: true` + `clamped_from` 回报原值，调用方据此发 warn，run 照跑）；
 *    边界：正好等于 `floor(context_window/4)` **不算被钳**（portal 侧 1/4 校验用的就是同一个上限）；
 * 3. `context_window` 非法 / 缺失（无论 `max_output_tokens` 是什么，也无论有没有下行）→ **返回 `null`**
 *    = 「什么都不传」= 现状行为（引擎自己发一次性 `model_metadata_missing`，压缩开关不进入）。
 *    这一支不硬塞 0：`context_window: 0` 会让 computeBudget 直接抛 invalid_budget。
 *
 * 规则 4（切片 2b 补的最后一条死法）：`context_window` **合法但很小**时，1/4 钳完预算仍然非正 ⇒ 照样炸。
 * 实测（钳后 `max_output_tokens = floor(ctx/4)`）：ctx=1001 → 预算 −1249、ctx=2000 → −500、
 * ctx=2666 → 0（都是「抛」）；ctx=2667 → 1（勉强活）。现实触发面是管理员把 `context_window`
 * 误填成 2048 这类笔误 ⇒ 该 FDE **每次 run 都启动即死**且错误不可重试。
 * 所以拿到候选值（原样**或**钳后）之后还要再过一道闸，**闸本身来自上游**：
 * `erix-agent` 包根导出的 `computeBudget({ contextWindowTokens, maxOutputTokens })`（同一个
 * `src/loop/budget.js`，公式随上游版本漂，我们这边**一个常量都不复制**）。
 * 它**抛** ⇒ 本函数返回 `null` = 「什么都不传」= 规则 3 的支路（压缩关、run 照活、
 * 引擎自己发一次性 `model_metadata_missing`）。**这条优先于「钳了」的结论**：钳完还是非正 ⇒ `null`，
 * 不是把那个钳后值交出去。告警文案由 worker 自己算（它手上就有 ctx 与原值），返回值里不塞第三个概念。
 *
 * @param {{main?:{model?:string,context_window?:unknown,max_output_tokens?:unknown}}|null|undefined} models RUN_START 的下行模型快照
 * @param {{computeBudget?: (input:{contextWindowTokens:number, maxOutputTokens:number}) => number}} [deps] 依赖注入位：
 *   `computeBudget` = 上游那道闸（worker 传真包；**不传则跳过规则 4**，与本模块改动前逐字节相同——
 *   这是纯函数零依赖这个既有性质的保持手段，也是既有 18 条纯函数用例不必改的兼容面）
 * @returns {{context_window:number, max_output_tokens:number, clamped:boolean, clamped_from:unknown}|null}
 */
export function resolveModelMetadata(models, { computeBudget } = {}) {
  const main = models?.main;
  if (!main || typeof main !== 'object') return null; // 无下行（旧 portal / 无配置）→ 现状行为
  const ctx = main.context_window;
  if (!isPositiveInt(ctx)) return null; // 规则 3：ctx 是唯一的「整对不传」判据，maxOut 再体面也没用
  const quarter = Math.floor(ctx / 4);
  const maxOut = main.max_output_tokens;
  const candidate = isPositiveInt(maxOut) && maxOut <= quarter
    ? { context_window: ctx, max_output_tokens: maxOut, clamped: false, clamped_from: maxOut }
    : { context_window: ctx, max_output_tokens: quarter, clamped: true, clamped_from: maxOut };
  if (typeof computeBudget !== 'function') return candidate; // 没注入闸 → 切片 2 的现状（兼容面）
  try {
    // 规则 4：入参是**一个对象**（不是两个位置参数），键名是上游的 camelCase 入参名。
    // 只看「抛不抛」，不用返回值——用返回值就得在这里重算公式（= 复制上游，本单明令禁止）。
    computeBudget({ contextWindowTokens: ctx, maxOutputTokens: candidate.max_output_tokens });
  } catch {
    return null; // 预算非正 ⇒ 整对不传（= 现状：压缩关，但 run 不炸）
  }
  return candidate;
}
