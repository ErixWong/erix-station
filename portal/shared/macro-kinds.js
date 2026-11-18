/**
 * 宏平台枚举的**单一真源**（issue #528 / 契约 `10-implementation-contract.md` §1）。
 *
 * 为什么在 `portal/shared/` 而不是 `portal/frontend/src/lib/`：后端不能 import 前端，
 * 而前端也要用同一份（chip 文案、下拉、判决映射、跳过人话都要按枚举取值）。
 * 契约红线：**只有一个真源，不许两边各维护一份**——防漂移测试见
 * `portal/test/macro-kinds-single-source.test.js`。
 *
 * 纪律：纯 ESM、零依赖、`Object.freeze`；**不许 import 任何 Node 内置模块或 npm 包**
 * （前端 vite 会原样打进浏览器包）。
 *
 * 内容是从 `portal/src/macros.js` 原样搬过来的（W1 的取值一个没动），
 * `macros.js` 现在 re-export 本文件，导出名保持不变（W2/W3/W4b/W7 都在用）。
 */

/** 模板 kinds（迁移 0035 CHECK 的 JS 侧同一份数字，漂了就当场报错而不是写进 DB 才炸）。 */
export const KINDS = Object.freeze(['run-notify', 'run-silence-alert', 'run-review', 'scheduled-task']);
/** 可见范围：`all` 全员可订阅，`admin` 仅管理员（鉴权在调用方，本模块只做形状校验）。 */
export const AUDIENCES = Object.freeze(['all', 'admin']);
/** 订阅范围：`session` 必须带 `session_id`，`user` 必须不带（口径见 `macros.js#assignTemplate`）。 */
export const SCOPES = Object.freeze(['session', 'user']);

/**
 * **每个 kind 的 scope 是固定的**（`07` §1.3：`scheduled-task` 只能 `user`，其余只能 `session`）。
 * 建模板与改模板都要按这张表校验——否则「一个模板既能挂会话又能挂用户」，
 * 会让「它到底在盯什么」变成运行时才知道的事。
 */
export const KIND_SCOPE = Object.freeze({
  'run-notify': 'session',
  'run-silence-alert': 'session',
  'run-review': 'session',
  'scheduled-task': 'user',
});

/**
 * **每个 kind 的参数 schema**（`10-implementation-contract.md` §1 的唯一真源）。
 * `required` 缺了报错；`default` 缺了由**服务端补上**（issue #625：不只前端补——API 直连也要拿到默认值）；
 * `enum`/`enum[]` 校验取值；`int` 校验上下界；`duration` 只校验形态。
 * ⚠ 只做**形状**校验，不做语义校验（语义在各宏的实现里）。
 *
 * ⚠ **`default` / `required` 必须与契约 §1 逐字一致**（issue #625 的起因就是这里缺了两项）：
 *   缺 `default` ⇒ 前端只能用通用规则猜（`run-notify` 建出来 `states: []` ⇒ **永远不会通知**、
 *   界面却显示 Enabled）；缺 `required` ⇒ `validateKindParams` 对缺字段 `continue`，
 *   能建出没有 `at` 的 `scheduled-task`（永不触发、静默死）。
 *   防漂测试：`portal/test/macro-kinds-single-source.test.js`。
 *
 * ⚠ **budget 拍平成 `max_per_day` / `quiet_hours` 两个顶层字段，不嵌套 `budget: {...}`**：
 *   `validateKindParams`（`macros.js`）只支持 `enum/enum[]/int/duration/time/path/text/quiet_window`
 *   这些**扁平类型**，加 `object` 要多写一层递归校验；拍平实现简单、前端按 `KIND_SCHEMA` 直接出表单。
 *   且 `validateKindParams` **拒绝未知键**（防拼错字段静默失效），所以字段必须**显式列进来**才填得进去（#617）。
 *   只给**通知型两个 kind** 加：`scheduled-task`/`run-review` 靠 `clock:<date>` 幂等键控频，
 *   没有「别把我淹了」的诉求，也不该被 quiet_hours 挡（#611）。
 */
export const KIND_SCHEMA = Object.freeze({
  'run-notify': {
    states: { type: 'enum[]', values: ['completed', 'failed', 'capped', 'aborted',
      'persistence_failed', 'guard_unverified'], default: ['failed', 'capped', 'aborted',
      'persistence_failed', 'guard_unverified'] },
    channel: { type: 'enum', values: ['site'], default: 'site' },
    // budget 拆出来的两个字段（`04` §201）：`max_per_day`（别把我淹了）+ `quiet_hours`（什么时候值得叫我）。
    max_per_day: { type: 'int', min: 1, max: 200 },
    quiet_hours: { type: 'quiet_window' },
  },
  'run-silence-alert': {
    threshold: { type: 'duration', default: '15m', min: '1m', max: '2h' },
    phases: { type: 'enum[]', values: ['tool_running', 'awaiting_llm'], default: ['tool_running'] },
    max_per_day: { type: 'int', min: 1, max: 200 },
    quiet_hours: { type: 'quiet_window' },
  },
  'run-review': {
    review_depth: { type: 'int', values: [0, 1], default: 1 },
    on_fail: { type: 'enum', values: ['reflow', 'notify_only'], default: 'reflow' },
    max_rounds: { type: 'int', default: 24, min: 1, max: 100 },
  },
  'scheduled-task': {
    at: { type: 'time', required: true },
    cwd: { type: 'path', required: true },
    task: { type: 'text', required: true, max: 8000 },
    maxRounds: { type: 'int', default: 16, min: 1, max: 100 },
    jitter: { type: 'duration', default: '10m', min: '0m', max: '30m' },
  },
});

/**
 * 执行账的**生命周期**（迁移 0035 CHECK 同一份）：
 * `pending → running → done | failed`；`pending → skipped`（被门禁挡下）；
 * `pending → superseded`（同桶被更新的一次取代，不执行）。终态集合见 `TERMINAL_STATUSES`。
 * ⚠ 这一列**会随执行推进而变** ⇒ 绝不进幂等键（键里带它 = 状态一迁移幂等就失效）。
 */
export const STATUS = Object.freeze(['pending', 'running', 'done', 'skipped', 'failed', 'superseded']);
/** 终态：进了这四个就不再推进，`finishMacroRun` 会给它们补 `finished_at`。 */
export const TERMINAL_STATUSES = Object.freeze(['done', 'skipped', 'failed', 'superseded']);
/**
 * **触发判据**（迁移 0035 CHECK 同一份）：写完就不变 ⇒ 是幂等键的一部分。
 * 与 `STATUS` 是**两个轴**，合成一列就得让幂等键跟着状态跑。
 *   `terminal`   run 进终态触发的宏（run-notify / run-review）
 *   `silent`     静默告警（run-silence-alert，按 `bucket` 的聚合窗口去重）
 *   `tick`       定时 / 轮询（scheduled-task，W2 的定时器驱动）
 *   `mechanical` M9 判据：机械可判定的那一路（不需要模型裁决）
 *   `semantic`   M9 判据：要模型语义裁决的那一路
 */
export const CRITERION = Object.freeze(['terminal', 'silent', 'tick', 'mechanical', 'semantic']);
/** 八种门禁（09 篇 §7 的「为什么没跑」分组维度）——**穷举**成 CHECK，不留自由文本。 */
export const SKIPPED_REASON = Object.freeze([
  'budget_exhausted', 'quiet_hours', 'human_present', 'run_in_progress',
  'deferred', 'deferred_timeout', 'active_run_in_cwd', 'cancelled_by_user',
  // issue #676（丙=止血）：M9 降级为「只出事实、不下判决」——审查暂不可用（快照方案待定，见 #673）。
  // 这一档同样是「为什么没做」，不是错误码。
  'review_unavailable',
]);
/** 归一化后的结果判定；原话留在 `verdict_raw`，口径改了可以回溯重算。 */
export const VERDICT = Object.freeze(['pass', 'red', 'no-op-claim', 'needs-human', 'unclassified']);

/** `duration` 参数的形态（`Ns`/`Nm`/`Nh`/`Nms`），校验逻辑仍在 `macros.js`。 */
export const DURATION_RE = /^\d+(ms|s|m|h)$/;
/** `time` 参数的形态（`HH:MM`，UTC+8）。 */
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/**
 * `quiet_hours` 参数的形态：`"HH:MM-HH:MM"`（UTC+8，start 与 end 各自是合法时刻）或 `"off"`（不静默）。
 * 语义在 `macro-eval.js`（解析 + 跨午夜判定），这里只管形状。
 */
export const QUIET_WINDOW_RE = /^(off|([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d)$/;

/**
 * 评估间隔（`09` 篇 §1.1）。与枚举一样是**跨端面**的：执行器拿它当轮询周期，
 * 用户面拿它算「上次评估多久没动了算陈旧」——两边各写一份数字就会漂。
 * 权威位在本文件；`portal/src/macro-eval.js` re-export 它。
 */
export const EVAL_INTERVAL_MS = 60_000;
/** 水位线陈旧余量倍数（`09` 篇 §1.1「留 3 倍余量」，因为单轮求值可能要查 git / 查 run 状态）。 */
export const STALE_INTERVAL_MULTIPLE = 3;
