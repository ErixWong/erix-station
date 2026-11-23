// 运行时配置底座：`runtime_settings` 的**读侧 + 写侧 + config 覆盖层**（issue #677 P1）。
//
// 一句话：把「配置只有 env 一份真相、改一个数字要重建容器」换成「DB 是真相、env 是兜底」，
// 优先级 **`DB > env > 默认`**。env 一条都没少（那是 P5 的退役账），P1 只搬目的地与机制。
//
// 六条硬口径**照抄 `portal/src/upload-settings.js` 的头注释**（#485 那两片把它打磨过，
// 复 audit 的返修尤其别改回去）。为什么照抄而不是自己发明：那是同一形状（DB 存配置 + 读侧
// 永不抛 + 写侧保存配置）已经付过账的版本，第二套口径 = 第二本账。
// ⚠ **第 4/6 条现在比那边这一份新**：#698 返修把「保存 = 一条 CTE 语句」改成了「保存 = 一个
// 显式事务」（论证见下面第 6 条），本单直接按那个结论落地，不等它合进 main ⇒ 当前分支里的
// `upload-settings.js` 仍是旧的单语句形状，比对时不要把它当参照（那正是本条要修的口径）。
//   1. **优先级 `DB > env > 默认`**，且**读侧永不抛**：表不存在 / DB 抖动 / 值非法 ⇒
//      回落 env（env 也没有 ⇒ registry 的 `defaultValue`）+ 一条**点名 key** 的 `warn`。
//      配置面坏了不许把功能锁死（与 `mail-provider`「读取失败绝不 500」、`upload-settings`
//      口径 1 同一决策）。
//   2. **回落是有意的选择，不是"报错太麻烦"**：写侧（`saveRuntimeSetting`）才是严格闸
//      （非法值当场拒）；读侧遇到"绕过写侧进来的坏行"（手工 `UPDATE`、别的库搬来的行）
//      必须**继续工作**并说清用的是哪个值。⚠ 一律**不许** `Number(raw)` / `parseInt(raw)`
//      了事：`parseInt('1e4') === 1` 那一族（台账 §8.126），半个值静默生效比报错难查十倍。
//   3. **写侧只接受 JSON 标量**（`typeof value` 是 `'number' | 'boolean' | 'string'`）：
//      对象 / 数组 / `null` / `NaN` / `Infinity` / 函数 / `undefined` 一律拒。表是 `jsonb`，
//      存进 `{"a":1}` 读出来就是个对象 —— 类型纪律从列类型退化成 jsonb 之后，这道闸是承重墙。
//   4. **单行 upsert**（`INSERT … ON CONFLICT (key) DO UPDATE … RETURNING`），响应 DTO 一律来自
//      `RETURNING`（不信输入）——「保存成功」说的是库里现在的值。⚠ 它**不再是「一条 SQL」**：
//      写与审计在**同一个显式事务**里（第 6 条），「一条语句」从来不是本模块的原子性来源。
//   5. **读侧带超时**（默认 1500ms，`RUNTIME_SETTINGS_READ_TIMEOUT_MS` 可覆盖；超时按
//      「读不到」处理 ⇒ 回落 + 只留 debug）。⚠ 「永不抛」必须同时覆盖**抛错**（`catch`）与
//      **不返回**（到点没回），只 `catch` 抛错是假口径 —— 不返回就永远进不了 catch
//      （`upload-settings.js` 头注释第 5 条有完整论证：那一单的病根是「每次上传都发的那次
//      读取」，本模块是「每次 `serve()` 都发的那次读取」，同一形状）。
//   6. **写与审计在同一个事务里**（`BEGIN` → `SELECT … FOR UPDATE` 取旧值 → upsert → 审计 →
//      **在事务内**检查审计行数 === 1 → `COMMIT`；任何一步失败 ⇒ `ROLLBACK` + 抛）。
//      ⇒ **「设置生效而审计没写」不可表示**：审计被静默抑制（trigger `RETURN NULL`、rule）时
//      连设置一起回滚，调用方拿到 500 而库里一格没改（判据：RS-6b 假库 + RS-11 真库 trigger）。
//      ⚠ 旧口径「一条 CTE 语句 = 同生共死」**已作废**（#677 P1 返修，独立审计的两条 MED）：
//        * 单语句里 `audit_rows` 只能在 `pool.query()` **返回之后**判，而那一刻语句**已经提交**
//          ⇒ 审计被抑制时是「报错但设置已生效」，检查不能撤销任何事。
//        * 同一形状的另一半是旧值：一条**含 data-modifying CTE** 的语句里 `FOR UPDATE`
//          **看不见本语句要改的那一行**（真库实测 ⇒ `prev` 恒空集 ⇒ `previous_value` 恒 `null`）
//          ⇒ 「拿行锁」与「写这一行」在一条语句里**不可兼得**（#698 在 `upload-settings.js` 上
//          撞的是同一堵墙，两轮读数都在那边文件头第 6 条里）。
//      ⇒ 与 #698 返修后的 `upload-settings.js#updateUploadSettings` **同形状**：`FOR UPDATE` 单独
//      一条语句，**原子性由事务保证**，不再由「一条语句」保证。
//      ⇒ **调用方不得再补 `auth.audit`**（那会把原子性退回成两个 await，还多写一笔审计）。
//
// P1 的边界（别在代码里假装已完成，判据在 `portal/test/runtime-settings.test.js`）：
//   * `RUNTIME_SETTING_REGISTRY` 自 **P2a** 起有**第一格** `session.ttl_seconds`，自 **P3 第一批**起
//     有**第二格** `workspace.retention_days`，**P3 第二批**加**第三格** `preview.ticket_ttl_seconds`，
//     **P3 第三批**加**第四格** `session.auto_title_min_new`（其余旋钮仍逐批填；判据 RS-7 钉住
//     「只有这四格」，顺手多迁一格当场红）。
//     ⇒ `applyRuntimeOverrides` 在真机上从此**每次 `serve()` 发一次读**（不再是零 SQL），
//     启动路径的那一次是**整表一次**、不是每 key 一次（第 3 条）。
//   * HTTP 端点（`GET/PUT /api/admin/runtime-settings`）自 **P2a** 起在 `http.js`（形状在下面的
//     `listRuntimeSettingsAdmin` / `updateRuntimeSettingAdmin`，http 层只做匹配 + 鉴权 + 转发）。
//   * 热读：P2a 只有 `readSessionTtlSeconds` 一格；**P3 第一批**把它那套机件（5s 缓存 + 代际号
//     + 同池在飞合并 + 写路径失效 + env 过闸 + 一次热读只一条 warn + 永不抛）抽成了
//     `createHotReader`，于是 `readWorkspaceRetentionDays` 是同一工厂的第二份实例，
//     `readPreviewTicketTtlSeconds` / `readAutoTitleMinNew` 是第三、第四份实例。
//     拓新格只需：registry 加一格 + `createHotReader({...})` 一行 + `HOT_READ_INVALIDATORS` 登记一行
//     + 消费者把启动期 `config.X` 换成现读（判据 RS-23~RS-28）。
//   * 迁移 0046 建表；接线在 `cli.js` 的 `serve()`（`migrate()` 之后、`createServer` 之前，
//     且**所有 `start*Loop` 也用覆盖后的 config**，否则覆盖层只对 HTTP 生效）。
//
// env 侧为什么不在这里读：`loadConfig()` 必须保持同步纯函数（口径：DB 读取不许塞进它）。
// env 那一档的值就是**传进来的 `config`**（它已经由 `loadConfig` 算成 `env > 字面默认`）；
// 本模块只负责「DB 可用就压过它」，所以 `env` 参数只是给超时哨兵读的，不是第二份真相。

// 循环侧的共享上限（60s）只在这里引用一次：三个退避旋钮的**上界不许自己发明**，
// 口径源头是 `loop-timing.js`（Node timer 的 32 位语义边界）与对账循环的业务上限。
import { MAX_BACKOFF_MS_SAFE } from './loop-timing.js';

/** 读侧超时的默认值（毫秒）。口径照 `upload-settings.js` / `platform-prompts.js`：1500ms。 */
export const DEFAULT_READ_TIMEOUT_MS = 1500;

/** 超时可旋钮的名字。⚠ 刻意**没**登记进 compose 的 `station-portal.environment`。 */
export const READ_TIMEOUT_ENV_VAR = 'RUNTIME_SETTINGS_READ_TIMEOUT_MS';

/** 审计动作名（写侧唯一出口；`docs` 的登记随 P3 的端点一起做）。 */
export const AUDIT_ACTION = 'admin.runtime_settings_updated';

/** 审计 target：`runtime_settings:<key>`，一 key 一条 target（照 0046 一行一 key 的表形）。 */
export const AUDIT_TARGET_PREFIX = 'runtime_settings';

/**
 * 旋钮登记表。P2a 起了第一格 `session.ttl_seconds`，P3 第一批起了第二格
 * `workspace.retention_days`，其余归 P3 逐批填。
 *
 * 条目形状（P3 往里加，一格一条；键名同时是 DB 里的 `key`，受 0046 的 CHECK 约束
 * `^[a-z][a-z0-9_.]{2,63}$`）：
 *
 *   'demo.limit': {
 *     label: '演示上限',                     // 人话名字（管理台显示用）；**不是**第二份真相，
 *                                           //   只是 UI 文案，改了不影响行为
 *     configPath: 'demoLimit',              // 点分路径 ⇒ 只覆盖这一条 config 字段
 *     envVar: 'DEMO_LIMIT',                 // 只用于日志/文档点名，不在这里读 env
 *     defaultValue: 10,                     // 连 env 都没给时的兜底（第三档）
 *     applyMode: 'hot',                     // `'hot'` = 下一次读就生效；**其余一律按 `'restart'` 渲染**
 *                                           //   （未知值当 `'restart'` 是安全侧：多提醒一次重启，
 *                                           //   比让人以为已经生效好。渲染侧只认 `'hot'`）
 *     parse(raw) {                          // 读侧：DB 里的 jsonb → 可用值
 *       …return { ok: true, value: n };     //   不可用 ⇒ { ok: false, reason: 'not_a_count' }
 *     },                                    //   ⚠ 不许抛，也不许 `Number(raw)` 了事
 *     validate(value) {                     // 写侧：真值校验（先过 JSON 标量闸）
 *       …return true;                       //   不合格 ⇒ 返回点名的原因字符串
 *     },                                    //   ⇒ 抛 `RuntimeSettingsError`（HTTP 400）
 *   }
 *
 * 三档从哪来（口径 1）：`parse` 出来的 DB 值 > `config[configPath]`（env 那一档，
 * 由 `loadConfig` 算过）> `defaultValue`。
 *
 * ⚠ **`applyMode: 'hot'` 的一格必须在这里显式声明**，且写路径要接上失效（见
 * `HOT_READ_INVALIDATORS`）：热读有 5s 缓存，保存后不失效就是「界面保存了、值没变」。
 */

/**
 * 第一格旋钮 `session.ttl_seconds` 的口径（P2a）。
 *
 * 区间两端都是**产品口径**，不是随手拍的数：
 *   * 下限 **60 秒**：比一个小于一分钟的会话更容易出事 —— 会话在每个 `/api/me` 上续期，
 *     续期节流间隔是 `SESSION_RENEW_INTERVAL_SECONDS`（默认 3600s），把 TTL 压到分钟级以下
 *     等于让用户在两次续期之间被踢下线（症状是「页面开着就掉登录」）。
 *   * 上限 **2592000 秒 = 30 天**：再长就是「事实上永不过期」，与 `sessions` 表存在的理由
 *     （可宽限吊销）相冲。
 * 默认 **604800 = 7 天**，与 `config.js` 的 `DEFAULT_SESSION_TTL_SECONDS` 同值（单测钉住同源，
 * 照 `upload-settings.test.js` 的「默认值三处同源」那一格）。
 */
export const SESSION_TTL_KEY = 'session.ttl_seconds';
export const SESSION_TTL_MIN_SECONDS = 60;
export const SESSION_TTL_MAX_SECONDS = 2592000; // 30 天
export const SESSION_TTL_DEFAULT_SECONDS = 604800; // 7 天，与 config.js / compose / docs/env.md 同源

/**
 * 读侧解析（口径 2）：只认「JSON number 里的安全正整数」或「纯十进制数字串」。
 *
 * ⚠ 判定**不靠** `Number(raw)` / `parseInt(raw)`（台账 §8.126）：`'1e4'`、`' 60 '`、`'60s'`、
 * `'0x10'`、`'1.5'`、`''` 全部当场拒。数字串先过 `/^[0-9]+$/` 再转数，转数只是搬运、不是裁决。
 * 区间外也拒（返回点名区间的 reason）：手工 `UPDATE` 成 `5` 的那种行宁可**回落**，
 * 也不要「会话 5 秒就过期」这种查半天的现象（口径照 `upload-settings.js#parseDbMaxFileBytes`：
 * 区间外 = 不可用 = 回落）。
 */
export function parseSessionTtlSeconds(raw) {
  let text;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) return { ok: false, reason: 'not_a_ttl_seconds' };
    text = String(raw);
  } else if (typeof raw === 'string') {
    text = raw;
  } else {
    return { ok: false, reason: 'not_a_ttl_seconds' }; // 布尔 / null / 对象 / 数组
  }
  if (!/^[0-9]+$/.test(text)) return { ok: false, reason: 'not_a_ttl_seconds' };
  const value = Number(text); // 上面已经只放纯数字进来 ⇒ 这里只是搬运
  if (!Number.isSafeInteger(value)) return { ok: false, reason: 'not_a_ttl_seconds' };
  if (value < SESSION_TTL_MIN_SECONDS || value > SESSION_TTL_MAX_SECONDS) {
    return { ok: false, reason: 'ttl_out_of_range' };
  }
  return { ok: true, value };
}

/**
 * 写侧校验：只收 `number` 类型的安全整数（`'86400'` 这种**字符串**照样拒 —— JSON 标量闸
 * 放得过字符串，真值闸必须拦下，否则界面里填一个带引号的值就静默换了一档）。
 * 合格 ⇒ `true`；不合格 ⇒ 返回点名的原因字符串（上层 `fail()` 负麦 `details.field='value'`）。
 */
export function validateSessionTtlSeconds(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return `必须是 ${SESSION_TTL_MIN_SECONDS}–${SESSION_TTL_MAX_SECONDS} 的整数秒（不接受字符串、小数、布尔）`;
  }
  if (value < SESSION_TTL_MIN_SECONDS || value > SESSION_TTL_MAX_SECONDS) {
    return `必须在 ${SESSION_TTL_MIN_SECONDS}–${SESSION_TTL_MAX_SECONDS} 秒之间（1 分钟 ~ 30 天）`;
  }
  return true;
}

/**
 * 第二格旋钮 `workspace.retention_days` 的口径（#677 P3 第一批）。
 *
 * `0` 是**有效值并且是默认值**，含义是「不做自动清理」—— 它不是「没配」，所以三件事必须分开：
 *   * `parse` 不许把 `0` 当假值丢掉（`if (!raw) return 不可用` 是最顺手也最容易犯的错）；
 *   * `validate` 的下界是 **0**（不是 1）：管理台要能把「关掉清理」写回去；
 *   * 消费者（`offboarding.js`）判「 disabled」只能拿**现读到的那个数**比 `=== 0`，
 *     不许再拿启动期的 `config` 快照判（那正是本批要拆掉的形状）。
 *
 * 上界 **3650 天 = 10 年**，理由是产品口径而不是溢出算术：
 *   * `config.js` 的 `nonNegativeIntEnv`（`:17`）只要求「安全整数且 ≥ 0」—— 它**没有上界**，
 *     所以 env 那一档今天能写出任意大的数。registry 的闸必须自己给一个，否则「保留期」这一格
 *     在 DB 侧可以被写成任意数，而管理台显示的是同一格。
 *   * 「离职后保留多久」的现实尺度是天/月级：超过 10 年与「永不清理」在运维上不可区分，
 *     而「永不清理」已经有确定表达（`0`）⇒ 上界之外的值只能是把单位填错了
 *     （想写 30 天写成 `2592000`（秒）或 `30*86400*1000`（毫秒）那一族，#8.126 同族现象）。
 *   * 算术侧：`scheduleWorkspacePurge` 把它拼成 `now() + ($2 * interval '1 day')`，
 *      absurd 的数会让 `workspace_purge_after` 撞到 `timestamptz` 上界（PG 294276 年）而让
 *     那一步 offboarding 直接失败；3650 天离那个上界有一万个数量级，写错单位则一步之遥。
 *   * 越界的 env 值（例如既有部署写了 `4000`）由 `resolveEnvTier` 那一道闸拦下 ⇒ 落回**默认 0**
 *     = 「不清理」，是**更保守**的一档（少删目录），不会造成误删（判据：RS-24 的上界那一格）。
 */
export const WORKSPACE_RETENTION_KEY = 'workspace.retention_days';
export const WORKSPACE_RETENTION_MAX_DAYS = 3650; // 10 年，理由见上面那段
// 0 = 关闭自动清理，与 config.js / compose / docs/env.md 同源
export const WORKSPACE_RETENTION_DEFAULT_DAYS = 0;

/**
 * 给人看的一行提示（**可选字段**，只给有反直觉边界的旋钮写）。口径：
 *   * 它是**文案**，不是第二份真相 —— 不参与任何判定，真相在 `docs/api/portal.md` §4.21；
 *   * DTO 只在登记了的那格带上它（没登记 ⇒ 连键都没有），前端才能「有就渲染、没有就不占行」；
 *   * 为什么只有第二格有：`0` 那一档的语义不是「把已排定的删除也撤了」（A/B 两方向刻意不对称，
 *     裁定与理由见 §4.21）。这个坑不写在行面上，运维就会把旋钮当「暂停/撤销」两用开关。
 */
export const WORKSPACE_RETENTION_HINT = '0 = 关掉自动清理，但不会取消已排定的删除：'
  + '改回正数后，已过期的工位会在下一次清理被删除；'
  + '而 0 期间完成离职的工位不会被补上期限（也不会被追删）。';

/**
 * 读侧解析：与 `parseSessionTtlSeconds` 同一套形状（只认「安全整数」或「纯十进制数字串」，
 * 区间外拒），差别只有两点：下界是 **0**，以及 `0` 必须**原样通过**（它是有效值）。
 * `'1e3'` / `' 7 '` / `'7.0'` / `'-1'` / `true` / `null` / 对象 一律拒（台账 §8.126 那一族）。
 */
export function parseWorkspaceRetentionDays(raw) {
  let text;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) return { ok: false, reason: 'not_a_retention_days' };
    text = String(raw);
  } else if (typeof raw === 'string') {
    text = raw;
  } else {
    return { ok: false, reason: 'not_a_retention_days' }; // 布尔 / null / 对象 / 数组
  }
  if (!/^[0-9]+$/.test(text)) return { ok: false, reason: 'not_a_retention_days' };
  const value = Number(text); // 上面已经只放非负纯数字进来 ⇒ 这里只是搬运
  if (!Number.isSafeInteger(value)) return { ok: false, reason: 'not_a_retention_days' };
  if (value > WORKSPACE_RETENTION_MAX_DAYS) {
    return { ok: false, reason: 'retention_days_out_of_range' };
  }
  return { ok: true, value };
}

/**
 * 写侧校验：只收 `number` 类型的安全整数（字符串 `'7'` 照样拒，口径与 TTL 那格逐字相同）。
 * 合格 ⇒ `true`；不合格 ⇒ 返回点名的原因字符串。⚠ 下界写的是 **0**，别顺手写成 1。
 */
export function validateWorkspaceRetentionDays(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return `必须是 0–${WORKSPACE_RETENTION_MAX_DAYS} 的整数天（不接受字符串、小数、布尔）`;
  }
  if (value < 0) return `不能是负数（0 = 不自动清理，${WORKSPACE_RETENTION_MAX_DAYS} = 保留 10 年）`;
  if (value > WORKSPACE_RETENTION_MAX_DAYS) {
    return `必须在 0–${WORKSPACE_RETENTION_MAX_DAYS} 天之间（0 = 不自动清理；要更长请写 0）`;
  }
  return true;
}

// --- preview.ticket_ttl_seconds 专用闸（P3 第二批：预览票有效期进 DB） ------------------
// 上界 3600 秒（1 小时）的理由：预览票是「点开一条链接临时进面板」的一次性短票，
// 短才有意义（越短被截获/重放的窗口越小）；工单给的参考范围 1..3600 我照用 ——
// 60 秒是默认（与 config.js:410 同源），上界取整小时是「一张票最多覆盖一次排障会话」，
// 再长就该发会话 cookie 而不是票。下界 1（不含 0）：0 秒的票签出来立刻过期 = 白发，
// 与「不自动清理 = 0」那种 0-有语义 的旋钮不同，这里的 0 只会造成「签了却进不去」的困惑。
export const PREVIEW_TICKET_TTL_KEY = 'preview.ticket_ttl_seconds';
export const PREVIEW_TICKET_TTL_MIN_SECONDS = 1;
export const PREVIEW_TICKET_TTL_MAX_SECONDS = 3600; // 1 小时，理由见上面那段
// 默认与 config.js 的 `previewTicketTtlSeconds`（PREVIEW_TICKET_TTL_SECONDS 兜底 60）同源。
export const PREVIEW_TICKET_TTL_DEFAULT_SECONDS = 60;
export const PREVIEW_TICKET_TTL_HINT = '一次预览票从签出到过期的秒数；1..3600（默认 60）';

/**
 * 严格十进制正整数（形状口径同上面两格：只认 `/^[0-9]+$/` 的非负整数字面，再要求 > 0）。
 * 非法输入一律 `{ ok: false, reason }`，绝不返回 NaN，也绝不用 `Number()`/`parseInt()` 了事。
 */
export function parsePreviewTicketTtlSeconds(raw) {
  let text;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) {
      return { ok: false, reason: 'not_a_ticket_ttl_seconds' };
    }
    text = String(raw);
  } else if (typeof raw === 'string') {
    text = raw;
  } else {
    return { ok: false, reason: 'not_a_ticket_ttl_seconds' };
  }
  // 只认纯十进制数字：`'1e3'`（科学记数）、`' 60 '`（带空白）、`'+5'`（带符号）、
  // `'60.0'`（小数）、空串 全部在这一步被挡掉；`'-5'` 带负号同样进不来。
  if (!/^[0-9]+$/.test(text)) {
    return { ok: false, reason: 'not_a_ticket_ttl_seconds' };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    return { ok: false, reason: 'not_a_ticket_ttl_seconds' };
  }
  // 形状闸也把区间兑一下（与会话/保留天数两格同形：parse 与 validate 两道都过一遍区间）。
  // 下界 1 ⇒ `0` 在这一层就被拒（reason 归 `out_of_range`，不是 `not_a_...`：它是合法数字、只是不合法）。上界同。
  if (value < PREVIEW_TICKET_TTL_MIN_SECONDS || value > PREVIEW_TICKET_TTL_MAX_SECONDS) {
    return { ok: false, reason: 'ticket_ttl_out_of_range' };
  }
  return { ok: true, value };
}

/**
 * 管理台写入前的取值闸：返回 `true` 或一句给人看的中文原因。
 *
 * ⚠ `1e3` 的两侧之分（#709 unproven 裁定）：**写侧接受任何合法 JSON number**——JSON 把科学记数法
 * 在解析时就塌成了普通整数，`1e3` 与 `1000` 是同一个值 ⇒ 走下面的 safe-integer 支放行（区间内），
 * 库里落的是 `1000`。只有**字符串** `"1e3"`（以及 `' 60 '`/`'60s'` 那一族）才在这一层被拒。
 * 这与 **env 侧相反**：env 那档走 `parse` 的 `/^[0-9]+$/` 正则支，`1e3` 过不了 ⇒ 视为没给、回落默认（见
 * `parsePreviewTicketTtlSeconds` 与 RS-31b / RS-37 / env.md）。一句话：`1e3` 写进 body 被收（=1000），
 * 写进 env / 作为字符串都不算数。
 */
export function validatePreviewTicketTtlSeconds(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return `必须是 ${PREVIEW_TICKET_TTL_MIN_SECONDS}–${PREVIEW_TICKET_TTL_MAX_SECONDS}` +
      ' 的整数秒（不接受字符串、小数、布尔）';
  }
  if (value < PREVIEW_TICKET_TTL_MIN_SECONDS) {
    return `不能是 ${value}（预览票至少 ${PREVIEW_TICKET_TTL_MIN_SECONDS} 秒；0 秒签出来即过期）`;
  }
  if (value > PREVIEW_TICKET_TTL_MAX_SECONDS) {
    return `必须在 ${PREVIEW_TICKET_TTL_MIN_SECONDS}–${PREVIEW_TICKET_TTL_MAX_SECONDS} 秒之间` +
      `（1 秒 ~ 1 小时；再长请改用会话 cookie 而不是票）`;
  }
  return true;
}

// --- session.auto_title_min_new 专用闸（P3 第三批：自动标题防抖阈值进 DB） ----------------
// 语义：一次自动标题刷新要求「距上次自动更新至少 N 轮新用户消息」，是**每次评估标题时**用的
// 防抖阈值（消费者 `session-title.js` 的 `evaluateAutoTitle()`）。区间自己定 `1..100`，理由：
//   * 下界 1：`1` = 每轮新 user 消息都刷新（最敏感）；`0` 会绕过防抖、每拍都重算标题、白烧
//     token，且和 `shouldRefreshTitle` 里「首条（auto_title_seq 为 NULL）必生成」的语义叠成
//     歧义 ⇒ 与预览票的「0 = 签出来即过期」同理，这里的 0 只会造成困惑，不是有效值。
//   * 上界 100：这是「会话轮数」启发式的阈值，不是时长。**口径要说准（#710 LOW①）**：上界 100 =
//     「阈值可设到很高」，**不是硬关闭**——`shouldRefreshTitle()` 除「≥ N 轮」外还有一条**话题漂移
//     旁路**（≥1 轮新消息且与现标题关键词零重合 ⇒ 刷新），**旁路不吃 N** ⇒ `minNew=100` + 只 1 轮
//     + 零重合仍然 `refresh=true`（判据：`session-title.test.js`「零重合旁路不受 `minNew` 上界约束」
//     那一格）。真要关掉自动改名请用 `ERIX_SESSION_AUTO_TITLE=0`（总开关），本旋钮上界只抬阈值。
//     默认 3 与 `config.js:327` 的 `intEnv(..., 'ERIX_SESSION_AUTO_TITLE_MIN_NEW', 3)`
//     及 `session-title.js` 的 `AUTO_TITLE_DEFAULT_MIN_NEW` **三处同源**。
export const AUTO_TITLE_MIN_NEW_KEY = 'session.auto_title_min_new';
export const AUTO_TITLE_MIN_NEW_MIN = 1;
export const AUTO_TITLE_MIN_NEW_MAX = 100; // 见上：上界只是抬阈值，不是硬关闭（零重合旁路不吃 N）
// 默认与 config.js 的 `sessionAutoTitleMinNew`（intEnv 兜底 3）同源。
export const AUTO_TITLE_MIN_NEW_DEFAULT = 3;
export const AUTO_TITLE_MIN_NEW_HINT =
  '自动标题刷新的防抖阈值：距上次自动更新至少 N 轮新用户消息才刷新；1..100（默认 3）；' +
  '上界 100 只是抬阈值，不是硬关闭——新消息与现标题关键词零重合时 1 轮也刷（口径见契约 §4.21）';

/**
 * 严格十进制正整数（形状口径同上面三格：只认 `/^[0-9]+$/` 的非负整数字面，再要求区间内）。
 * 非法输入一律 `{ ok: false, reason }`，绝不返回 NaN，也绝不用 `Number()`/`parseInt()` 了事。
 */
export function parseAutoTitleMinNew(raw) {
  let text;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) {
      return { ok: false, reason: 'not_a_auto_title_min_new' };
    }
    text = String(raw);
  } else if (typeof raw === 'string') {
    text = raw;
  } else {
    return { ok: false, reason: 'not_a_auto_title_min_new' };
  }
  // 只认纯十进制数字：`'1e2'`、`' 3 '`、`'+2'`、`'3.0'`、空串、`'-1'` 全部在这一步挡掉。
  if (!/^[0-9]+$/.test(text)) {
    return { ok: false, reason: 'not_a_auto_title_min_new' };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    return { ok: false, reason: 'not_a_auto_title_min_new' };
  }
  // 形状闸也把区间兑一下（与前三格同形：parse 与 validate 两道都过一遍区间）。
  // 下界 1 ⇒ `0` 在这一层被拒（reason 归 `out_of_range`，不是 `not_a_...`）。上界同。
  if (value < AUTO_TITLE_MIN_NEW_MIN || value > AUTO_TITLE_MIN_NEW_MAX) {
    return { ok: false, reason: 'auto_title_min_new_out_of_range' };
  }
  return { ok: true, value };
}

/**
 * 管理台写入前的取值闸：返回 `true` 或一句给人看的中文原因。
 *
 * ⚠ `1e2` 的两侧之分（照 #709 裁定）：写侧接受任何合法 JSON number（`1e2` 塌成 `100` ⇒ 区间内
 * 放行、库里落 100）；只有字符串 `"1e2"` 走 parse 的正则支被拒 ⇒ env 侧 `1e2` 视为没给、回落默认。
 */
export function validateAutoTitleMinNew(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return `必须是 ${AUTO_TITLE_MIN_NEW_MIN}–${AUTO_TITLE_MIN_NEW_MAX}`
      + ' 的整数轮（不接受字符串、小数、布尔）';
  }
  if (value < AUTO_TITLE_MIN_NEW_MIN) {
    return `不能是 ${value}（防抖阈值至少 ${AUTO_TITLE_MIN_NEW_MIN} 轮；`
      + '0 轮 = 每拍重算标题、白烧 token）';
  }
  if (value > AUTO_TITLE_MIN_NEW_MAX) {
    return `必须在 ${AUTO_TITLE_MIN_NEW_MIN}–${AUTO_TITLE_MIN_NEW_MAX} 轮之间` +
      `（1 轮 ~ 100 轮；再大请直接用 ERIX_SESSION_AUTO_TITLE=0 关掉自动标题：` +
      '本旋钮的上界只是抬阈值，零重合旁路不吃它）';
  }
  return true;
}

// --- loop.*_idle_backoff_ms 三格专用闸（P3 第六批：三个循环的空闲退避上限一起迁） ----------
// 三个旋钮是同一类东西（「本轮没认领到活 ⇒ 退避阶梯封顶多少毫秒」），但**各自一格、各自一份
// 热读实例**：共用一份缓存槽就是「保存开户那格的上限，把对账那一格的缓存一起抹掉」（判据
// RS-52），而三格的默认值与上界本来就不一样。
//
// 值域**不自己发明**，逐条抄自循环侧既有的钳位逻辑（判据 RS-50 钉住同源）：
//   * 开户 / 销号：旧路径 `envInt(name, 30000, { max: MAX_BACKOFF_MS_SAFE })` ⇒ 区间 `1..60000`；
//     越界的 env 在旧路径是「回落默认 30000 + warn」，在新路径是「registry 拒 ⇒ 回落 registry
//     默认 30000」⇒ **生效值逐字相同**（env 侧的钳位既没被绕过也没被放宽）。
//   * 对账：`provisioner.js#resolveIdleBackoffMaxMs()` 在共享上限之后还要按**本循环的业务上限**
//     钳到 `IDLE_BACKOFF_MAX_MS_BUSINESS_CAP`（15000）。那一格的业务上限就是本格的 validate 上界；
//     又因为它的**默认值恰好等于业务上限**，「越界 ⇒ 回落默认」与「越界 ⇒ 钳到上限」落到同一个
//     数 ⇒ `env=60000 ⇒ 生效 15000` 这条既有行为（判据 `deploy-env-idle-backoff.test.js` G4）
//     原样保留，`resolveIdleBackoffMaxMs` 本体一字未动（env 单用那条路仍然 warn + 钳）。
export const ONBOARDING_IDLE_BACKOFF_MS_KEY = 'loop.onboarding_idle_backoff_ms';
export const OFFBOARDING_IDLE_BACKOFF_MS_KEY = 'loop.offboarding_idle_backoff_ms';
export const PROVISIONER_IDLE_BACKOFF_MS_KEY = 'loop.provisioner_idle_backoff_ms';

/** 三格共用的下界：`0` 毫秒 = 每拍空转（正是 #506 修掉的形状），所以它和非法值一样不进闸。 */
export const IDLE_BACKOFF_MS_MIN = 1;
/** 开户 / 销号的上界 = 共享的 `MAX_BACKOFF_MS_SAFE`（60s）；这两个循环的业务上限就是它。 */
export const IDLE_BACKOFF_MS_SHARED_MAX = MAX_BACKOFF_MS_SAFE;
/** 对账的上界 = 本循环的业务上限（与 `provisioner.js` 的 `IDLE_BACKOFF_MAX_MS_BUSINESS_CAP` 同源）。 */
export const PROVISIONER_IDLE_BACKOFF_MS_BUSINESS_CAP = 15_000;

/** 三格的默认值：与各自循环模块的 `IDLE_BACKOFF_MAX_MS_DEFAULT` 同源（判据 RS-50 钉住相等）。 */
export const ONBOARDING_IDLE_BACKOFF_MS_DEFAULT = 30_000;
export const OFFBOARDING_IDLE_BACKOFF_MS_DEFAULT = 30_000;
export const PROVISIONER_IDLE_BACKOFF_MS_DEFAULT = 15_000;

export const ONBOARDING_IDLE_BACKOFF_MS_HINT =
  '开户循环空闲退避的上限（毫秒）；1..60000（默认 30000）；认领到活立刻回 5000ms 基准，'
  + '下一拍生效（本进程最多 5 秒内、多副本最多 5 秒）';
export const OFFBOARDING_IDLE_BACKOFF_MS_HINT =
  '销号循环空闲退避的上限（毫秒）；1..60000（默认 30000）；认领到活立刻回 5000ms 基准；'
  + '1h 工作区清理闸门是每拍检查，会被拖后最多一个退避拍';
export const PROVISIONER_IDLE_BACKOFF_MS_HINT =
  '对账循环空闲退避的上限（毫秒）；1..15000（默认 15000）；上界 15000 是本循环的业务上限'
  + '（漂移发现延迟是业务承诺），配 5000 = 不退避（#520 之前的固定节拍）';

/**
 * 三格共用的形状闸（口径与 `parsePreviewTicketTtlSeconds` / `parseAutoTitleMinNew` 逐字同形）：
 * 只认 safe integer 的 JSON number，或**纯十进制数字串**（`'1e4'` / `' 30 '` / `'-1'` 一律拒），
 * 再把区间兑一遍。非法输入一律 `{ ok:false, reason }`，绝不抛、绝不 `Number()` 了事。
 * @param {unknown} raw @param {{max:number, notReason:string, rangeReason:string}} opts
 */
function parseIdleBackoffMs(raw, { max, notReason, rangeReason }) {
  let text;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) return { ok: false, reason: notReason };
    text = String(raw);
  } else if (typeof raw === 'string') {
    text = raw;
  } else {
    return { ok: false, reason: notReason };
  }
  if (!/^[0-9]+$/.test(text)) return { ok: false, reason: notReason };
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return { ok: false, reason: notReason };
  if (value < IDLE_BACKOFF_MS_MIN || value > max) return { ok: false, reason: rangeReason };
  return { ok: true, value };
}

/** 三格共用的写侧闸：区间内 ⇒ `true`，否则一句点名上界来历的中文原因。 */
function validateIdleBackoffMs(value, { max, overHint }) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return `必须是 ${IDLE_BACKOFF_MS_MIN}–${max} 的整数毫秒（不接受字符串、小数、布尔）`;
  }
  if (value < IDLE_BACKOFF_MS_MIN) {
    return `不能是 ${value}（至少 ${IDLE_BACKOFF_MS_MIN}ms；0ms = 每拍空转，正是 #506 修掉的形状）`;
  }
  if (value > max) {
    return `必须在 ${IDLE_BACKOFF_MS_MIN}–${max}ms 之间（${max}ms 是这条循环的上界；${overHint}）`;
  }
  return true;
}

/** 开户格的形状闸（reason 点名本格：日志里不许出现另一个循环的名字）。 */
export function parseOnboardingIdleBackoffMs(raw) {
  return parseIdleBackoffMs(raw, {
    max: IDLE_BACKOFF_MS_SHARED_MAX,
    notReason: 'not_an_onboarding_idle_backoff_ms',
    rangeReason: 'onboarding_idle_backoff_out_of_range',
  });
}

/** 开户格的取值闸。 */
export function validateOnboardingIdleBackoffMs(value) {
  return validateIdleBackoffMs(value, {
    max: IDLE_BACKOFF_MS_SHARED_MAX,
    overHint: '再大就越过 Node timer 的 32 位语义边界，退避会退化成 1ms 空转，见 loop-timing.js',
  });
}

/** 销号格的形状闸。 */
export function parseOffboardingIdleBackoffMs(raw) {
  return parseIdleBackoffMs(raw, {
    max: IDLE_BACKOFF_MS_SHARED_MAX,
    notReason: 'not_an_offboarding_idle_backoff_ms',
    rangeReason: 'offboarding_idle_backoff_out_of_range',
  });
}

/** 销号格的取值闸。 */
export function validateOffboardingIdleBackoffMs(value) {
  return validateIdleBackoffMs(value, {
    max: IDLE_BACKOFF_MS_SHARED_MAX,
    overHint: '再大就越过 Node timer 的 32 位语义边界，退避会退化成 1ms 空转，见 loop-timing.js',
  });
}

/** 对账格的形状闸：上界是**业务上限 15000**，不是共享的 60000（越界 ⇒ 回落默认 15000）。 */
export function parseProvisionerIdleBackoffMs(raw) {
  return parseIdleBackoffMs(raw, {
    max: PROVISIONER_IDLE_BACKOFF_MS_BUSINESS_CAP,
    notReason: 'not_a_provisioner_idle_backoff_ms',
    rangeReason: 'provisioner_idle_backoff_out_of_range',
  });
}

/** 对账格的取值闸：越界的原因必须说清「这是业务承诺，不是算术溢出」。 */
export function validateProvisionerIdleBackoffMs(value) {
  return validateIdleBackoffMs(value, {
    max: PROVISIONER_IDLE_BACKOFF_MS_BUSINESS_CAP,
    overHint: '对账的漂移发现延迟是业务承诺，不许被一个旋钮放宽到 4 倍；要更快发现漂移就调小'
      + '（5000 = #520 之前的固定节拍）',
  });
}

export const RUNTIME_SETTING_REGISTRY = Object.freeze({
  [SESSION_TTL_KEY]: Object.freeze({
    key: SESSION_TTL_KEY,
    label: '登录会话有效期（秒）',
    configPath: 'sessionTtlSeconds',
    envVar: 'SESSION_TTL_SECONDS',
    defaultValue: SESSION_TTL_DEFAULT_SECONDS,
    applyMode: 'hot',
    parse: parseSessionTtlSeconds,
    validate: validateSessionTtlSeconds,
  }),
  [WORKSPACE_RETENTION_KEY]: Object.freeze({
    key: WORKSPACE_RETENTION_KEY,
    label: '已离职工位目录保留天数（0 = 不自动清理）',
    configPath: 'workspaceRetentionDays',
    envVar: 'ERIX_WORKSPACE_RETENTION_DAYS',
    defaultValue: WORKSPACE_RETENTION_DEFAULT_DAYS,
    applyMode: 'hot',
    parse: parseWorkspaceRetentionDays,
    validate: validateWorkspaceRetentionDays,
    hint: WORKSPACE_RETENTION_HINT,
  }),
  [PREVIEW_TICKET_TTL_KEY]: Object.freeze({
    key: PREVIEW_TICKET_TTL_KEY,
    label: '预览票有效期（秒）',
    configPath: 'previewTicketTtlSeconds',
    envVar: 'PREVIEW_TICKET_TTL_SECONDS',
    defaultValue: PREVIEW_TICKET_TTL_DEFAULT_SECONDS,
    applyMode: 'hot',
    parse: parsePreviewTicketTtlSeconds,
    validate: validatePreviewTicketTtlSeconds,
    hint: PREVIEW_TICKET_TTL_HINT,
  }),
  [AUTO_TITLE_MIN_NEW_KEY]: Object.freeze({
    key: AUTO_TITLE_MIN_NEW_KEY,
    label: '自动标题刷新防抖阈值（轮）',
    configPath: 'sessionAutoTitleMinNew',
    envVar: 'ERIX_SESSION_AUTO_TITLE_MIN_NEW',
    defaultValue: AUTO_TITLE_MIN_NEW_DEFAULT,
    applyMode: 'hot',
    parse: parseAutoTitleMinNew,
    validate: validateAutoTitleMinNew,
    hint: AUTO_TITLE_MIN_NEW_HINT,
  }),
  [ONBOARDING_IDLE_BACKOFF_MS_KEY]: Object.freeze({
    key: ONBOARDING_IDLE_BACKOFF_MS_KEY,
    label: '开户循环空闲退避上限（毫秒）',
    // config 里没有这一档（`ONBOARDING_IDLE_BACKOFF_MAX_MS` 是循环直读 env、不经 `loadConfig`），
    // 所以 config 那一档永远「没给」⇒ 管理台报来源只会说 db / env / default，不假装是 config 配的。
    configPath: 'onboardingIdleBackoffMaxMs',
    envVar: 'ONBOARDING_IDLE_BACKOFF_MAX_MS',
    defaultValue: ONBOARDING_IDLE_BACKOFF_MS_DEFAULT,
    applyMode: 'hot',
    parse: parseOnboardingIdleBackoffMs,
    validate: validateOnboardingIdleBackoffMs,
    hint: ONBOARDING_IDLE_BACKOFF_MS_HINT,
  }),
  [OFFBOARDING_IDLE_BACKOFF_MS_KEY]: Object.freeze({
    key: OFFBOARDING_IDLE_BACKOFF_MS_KEY,
    label: '销号循环空闲退避上限（毫秒）',
    configPath: 'offboardingIdleBackoffMaxMs',
    envVar: 'OFFBOARDING_IDLE_BACKOFF_MAX_MS',
    defaultValue: OFFBOARDING_IDLE_BACKOFF_MS_DEFAULT,
    applyMode: 'hot',
    parse: parseOffboardingIdleBackoffMs,
    validate: validateOffboardingIdleBackoffMs,
    hint: OFFBOARDING_IDLE_BACKOFF_MS_HINT,
  }),
  [PROVISIONER_IDLE_BACKOFF_MS_KEY]: Object.freeze({
    key: PROVISIONER_IDLE_BACKOFF_MS_KEY,
    label: '对账循环空闲退避上限（毫秒）',
    configPath: 'provisionerIdleBackoffMaxMs',
    envVar: 'PROVISIONER_IDLE_BACKOFF_MAX_MS',
    defaultValue: PROVISIONER_IDLE_BACKOFF_MS_DEFAULT,
    applyMode: 'hot',
    parse: parseProvisionerIdleBackoffMs,
    validate: validateProvisionerIdleBackoffMs,
    hint: PROVISIONER_IDLE_BACKOFF_MS_HINT,
  }),
});

/** 校验/状态类错误：`httpStatus` + `code` + `details.field`（HTTP 层按此映射 400）。 */
export class RuntimeSettingsError extends Error {
  constructor(code, message, { httpStatus = 400, details } = {}) {
    super(message);
    this.name = 'RuntimeSettingsError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

function fail(field, message, details) {
  throw new RuntimeSettingsError('validation_failed', message, {
    httpStatus: 400,
    details: { field, ...details },
  });
}

/**
 * 每次调用都现读 env（测试能在运行中改；也让超时档位可单独单测）。
 * 只接受**严格十进制正整数**：`1e3` / `' 800 '` / `+5` / `0` / `-5` 一律算非法 ⇒ 默认 + 一条
 * 点名本旋钮的 warn（口径照 `platform-prompts.js`；`Number('1e3') === 1000` 是台账 §8.126 那族）。
 */
export function readTimeoutMs({ env = process.env, log = console } = {}) {
  const raw = env?.[READ_TIMEOUT_ENV_VAR];
  if (raw === undefined || raw === '') return DEFAULT_READ_TIMEOUT_MS;
  const text = typeof raw === 'string' ? raw : String(raw);
  const parsed = /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    log?.warn?.(
      `[runtime-settings] ${READ_TIMEOUT_ENV_VAR}=${JSON.stringify(raw)} 不是正整数 ⇒ `
      + `用默认 ${DEFAULT_READ_TIMEOUT_MS}ms（只决定「等多久算读不到」，不改优先级 DB > env > 默认）`,
    );
    return DEFAULT_READ_TIMEOUT_MS;
  }
  return parsed;
}

/** 超时哨兵：与「驱动抛错」**分开**（`reason` 不同 ⇒ 要不要 warn 也不同，见口径 5）。 */
const READ_TIMEOUT = Symbol('runtime-settings-read-timeout');

/**
 * 给一次查询套上截止时间。**只有 race，没有取消**：node-pg 没有「中断一条已发出的查询」的
 * API（真中断要另开连接发 `pg_cancel_backend`），所以超时后那条查询继续挂着，我们不再等它。
 * 定时器**不 `unref()`**：它是「读不到也要按时给答案」的唯一保证（`unref` 过的定时器在事件
 * 循环空了之后不会响 ⇒ promise 永远挂在那儿，测试会挂而不是红）。必 `clearTimeout`。
 */
function withReadTimeout(queryPromise, timeoutMs) {
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(READ_TIMEOUT), timeoutMs);
  });
  // 传进来的 promise 先包一层：`pool.query` **同步**抛错（连接池已关）也要走 catch。
  return Promise.race([Promise.resolve(queryPromise), deadline])
    .finally(() => { if (timer) clearTimeout(timer); });
}

/** 取 config 里点分路径的值（缺段 ⇒ `undefined`，不抛）。 */
function getPath(source, dottedPath) {
  let cursor = source;
  for (const seg of String(dottedPath).split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = cursor[seg];
  }
  return cursor;
}

/** 写点分路径：沿途每一层浅拷贝（不改调用方那个对象），缺段补空对象。 */
function setPath(target, dottedPath, value) {
  const segs = String(dottedPath).split('.');
  let cursor = target;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const prev = Object.prototype.hasOwnProperty.call(cursor, segs[i]) ? cursor[segs[i]] : {};
    cursor[segs[i]] = prev !== null && typeof prev === 'object' ? { ...prev } : {};
    cursor = cursor[segs[i]];
  }
  cursor[segs[segs.length - 1]] = value;
  return target;
}

/**
 * 只认 registry 里的 key。`Object.hasOwn` 而不是 `key in registry`：
 * `registry` 是普通对象，`'constructor' in {}` 为真 ⇒ 未登记的保留名会混进读侧。
 */
export function isKnownSetting(key, registry = RUNTIME_SETTING_REGISTRY) {
  return typeof key === 'string' && Object.hasOwn(registry, key);
}

/** 孤儿行上报时一条 warn 里最多列几个 key（剩下的只报总数，不刷屏）。 */
const MAX_ORPHAN_KEYS_IN_WARN = 5;

/**
 * 读侧的一条 SELECT：**整表一次读**，不是 per-key 一次。
 * `value` 是 `jsonb` ⇒ node-pg 直接给 JS 值（对象/字符串/数字/布尔都可能是它）。
 * 整表而不是 `WHERE key = ANY($1)`：读侧要能看见「库里有一行但 registry 不认」这件事
 * （P3 逐批迁时，一行孤儿配置是必须能说出口的形态），而表只装旋钮、行数个位数。
 * ⚠ 既然整表读，**读到了就必须说话**（#677 P1 返修 MED①）：registry 不认的行走
 * `unknown_key`（见下面孤儿行那一段），不许只存进 `rowByKey` 然后从不遭提到。
 */
const SELECT_SQL = 'SELECT key, value FROM runtime_settings ORDER BY key';

/**
 * 保存 = **一个显式事务**（口径 6）：`BEGIN` → `PREVIOUS_SQL`（单独一条，带行锁）→ `UPSERT_SQL`
 * → `AUDIT_SQL` → **在事务内检查审计行数** → `COMMIT`。下面三个常量就是事务里的三条语句，
 * **顺序不可改**（形状照 #698 返修后的 `upload-settings.js`，不再照 0036 的单语句 CTE）。
 *
 * 为什么不是以前那条单语句 CTE（两个洞都是实测出来的，不是推想）：
 *   * **审计行数检查只能在语句返回之后做，而那一刻已经提交** ⇒ trigger `RETURN NULL` 把审计
 *     吃掉时，调用方拿到 500 但**设置已生效**（“报错但已生效”）。放进事务后检查在 `COMMIT`
 *     之前 ⇒ 不满足就 `ROLLBACK`，两边一起不落（真库判据：RS-11 的 trigger 那一段）。
 *   * **旧值取不到锁**：一条**含 data-modifying CTE** 的语句里所有 sub-statement 共用同一个
 *     语句级快照 ⇒ `FOR UPDATE` **看不见本语句要改的那一行**。2026-11-19 在 postgres:16.15 上
 *     实测（一次性容器，探针记录见工单报告与 RS-11）：带 `FOR UPDATE` 的 `prev` 恒为**空集**
 *     （有旧行、无旧行都是空）⇒ `previous_value` 恒 `null`。⇒ 单语句里「拿行锁」与「写这一行」
 *     **不可兼得**，只能拆事务：`FOR UPDATE` **单独一条**才既拿得到最新已提交值又拿得到行锁。
 *
 * 四个刻意的细节：
 *   1. `FOR UPDATE` **只能出现在 `PREVIOUS_SQL` 这一条独立语句里**（挪进 `UPSERT_SQL` 就是退回
 *      那个 `previous_value` 恒 `null` 的 500 形状）。它是并发口径的唯一支点：READ COMMITTED 下
 *      它读到的是**最新已提交**的值，并把行锁一直拿到 `COMMIT` ⇒ 并发第二条保存卡在这一句上，
 *      等到的就是前一个写完之后的值（真库判据：RS-11 的「拦路连接」那一段）。
 *   2. `previous_value` **现在由 JS 从 `PREVIOUS_SQL` 那一行取**（不再由 SQL 里的 CTE 算）：
 *      审计里写的与接口返回的是**同一个值**，不存在第二份派生逻辑可漂。
 *   3. `details` 的三个键（`key` / `value` / `previous_value`）与旧 CTE 版逐字相同 ⇒ 已有的审计
 *      查询不受影响；只是不再由 SQL 算出来。`value` 取 `RETURNING` 里那一个（不信输入）。
 *   4. `$2::jsonb`：值由 JS `JSON.stringify(标量)` 送来，SQL 侧不猜类型（口径 3 的另一半）。
 *
 * 已知残留（说在明处）：**同一 key 的首次并发写**（库里还没有那一行）锁不到任何行 ⇒ 两条都可能
 * 把 `previous_value` 记成 `null`（生效值仍由 `ON CONFLICT` 的行锁串行化，不丢）。0046 的头注释里
 * 也记着同一条残留 —— ⚠ 那一段写的是旧 `prev` CTE 的形状，而**已应用的迁移按 sha256 不可改**
 * （`deploy/migrations/README.md`：连注释都不能改）⇒ 它的措辞停在旧形状，**以这里为准**。
 * 要收它得给 key 加 advisory lock，别拿 `FOR UPDATE` 收（见上面第二条）。
 */

/** 事务第 1 条：单独一条锁定读写旧值（无旧行 ⇒ 空集，首写的 `previous_value` 就是 `null`）。 */
const PREVIOUS_SQL = 'SELECT value FROM runtime_settings WHERE key = $1 FOR UPDATE';

/** 事务第 2 条：单行 upsert（口径 4）。响应 DTO 一律来自 `RETURNING`（不信输入）。 */
const UPSERT_SQL = `INSERT INTO runtime_settings (key, value, updated_at, updated_by)
   VALUES ($1, $2::jsonb, now(), $3)
   ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
   RETURNING key, value, updated_at, updated_by`;

/** 事务第 3 条：审计。与 upsert 同一个事务 ⇒ 审计写不进去就**设置也没改**（口径 6）。 */
const AUDIT_SQL = 'INSERT INTO audit_log (actor_id, action, target, details)'
  + ' VALUES ($1, $2, $3, $4)';

/**
 * 读全部登记项：**永不抛、永不挂**（口径 1 + 5）。
 *
 * @param {object} opts `{ pool, registry, timeoutMs?, env?, log? }`
 *   `timeoutMs` 缺省时由 `readTimeoutMs()` 现算（读 `RUNTIME_SETTINGS_READ_TIMEOUT_MS`）。
 * @returns {Promise<{values:Record<string,unknown>, problems:Array<{key:string,reason:string}>}>}
 *   `values` 只放**可用**的 DB 值；不可用的 key 一条都不在 `values` 里，
 *   只在 `problems` 里点名（`read_failed` / `read_timeout` / `no_row` / `invalid_db_value` /
 *   `unknown_key`，五种理由分开：运维的处理动作不一样，报错了就不能互捣）。
 *   `unknown_key` = 库里有这一行但 registry 不认（孤儿行）：它不是某个登记项的回落理由，
 *   而是一行永不生效的配置 ⇒ 单独一个 reason，且只聚合 warn 一次（不逐行刷屏）。
 */
export async function readRuntimeSettings({
  pool, registry = RUNTIME_SETTING_REGISTRY, timeoutMs, env = process.env, log = console,
} = {}) {
  const keys = Object.keys(registry);
  const problems = [];
  const values = {};
  if (keys.length === 0) return { values, problems };
  if (!pool || typeof pool.query !== 'function') {
    // 没有池子 = 「读不到」而不是「抛出去」：口径 1，启动路径不许被配置面锁死。
    for (const key of keys) problems.push({ key, reason: 'no_pool' });
    log?.warn?.(`[runtime-settings] 没有可用的 pool ⇒ ${keys.length} 个旋钮全走 env/默认`);
    return { values, problems };
  }
  const budget = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs
    : readTimeoutMs({ env, log });

  let result;
  try {
    result = await withReadTimeout(pool.query(SELECT_SQL), budget);
  } catch (err) {
    // 点名是哪几个 key：值班的人要能一眼看出「现在生效的是哪个来源的值、去哪里改」。
    const detail = [err?.code, err?.message].filter(Boolean).join(' ') || '未知错误';
    log?.warn?.(
      `[runtime-settings] 读 runtime_settings 失败（${detail}）⇒ `
      + `${keys.join(', ')} 回落 env/默认（服务照常起，配置面不承重）`,
    );
    for (const key of keys) problems.push({ key, reason: 'read_failed' });
    return { values, problems };
  }
  if (result === READ_TIMEOUT) {
    // 不 warn：超时是这条路径的常态兜底（服务照常起），一个慢 DB 不该把日志刷满（#520 同族）。
    log?.debug?.(
      `[runtime-settings] 读 runtime_settings 超过 ${budget}ms 未返回 ⇒ `
      + `${keys.join(', ')} 按读不到处理（回落 env/默认）`,
    );
    for (const key of keys) problems.push({ key, reason: 'read_timeout' });
    return { values, problems };
  }

  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const rowByKey = new Map();
  const orphans = new Set();
  for (const row of rows) {
    if (row && typeof row.key === 'string') {
      rowByKey.set(row.key, row);
      // 孤儿行：registry 不认的 key。必须**看得见**（P3 逐批往 registry 加/删条目 ⇒ 删完库里
      // 就剩孤儿行；一行永不生效的配置不说话就是运维的考古题）。
      if (!Object.hasOwn(registry, row.key)) orphans.add(row.key);
    }
    // 其余额外形状（`key` 不是字符串）刻意不当孤儿报：0046 里 `key` 是 `text PRIMARY KEY`（非空），
    // 真表里出不来这种行；拿不准的名字写进 problems 只会污染那份「能按 key 行动」的名单。
  }
  // 孤儿行：进 `problems`（reason=`unknown_key`，逐 key 点名），但**只 warn 一次**（聚合）。
  // 依旧不抛（口径 1）：一行孤儿配置不能把服务钉住；`values` 里也不出现它（不生效）。
  const orphanKeys = [...orphans].sort();
  for (const key of orphanKeys) problems.push({ key, reason: 'unknown_key' });
  if (orphanKeys.length > 0) {
    const shown = orphanKeys.slice(0, MAX_ORPHAN_KEYS_IN_WARN).join(', ');
    const rest = orphanKeys.length > MAX_ORPHAN_KEYS_IN_WARN
      ? `，其余 ${orphanKeys.length - MAX_ORPHAN_KEYS_IN_WARN} 个未列出` : '';
    log?.warn?.(
      `[runtime-settings] runtime_settings 里有 ${orphanKeys.length} 行 registry 不认的 key`
      + `（${shown}${rest}）⇒ 不进覆盖层、也不回落（它们压根没登记；`
      + 'P3 删 registry 条目后库里留下的就是这种行，要人清理）。',
    );
  }
  for (const key of keys) {
    if (!rowByKey.has(key)) {
      problems.push({ key, reason: 'no_row' }); // 未配置是常态：不 warn，只登记
      continue;
    }
    const entry = registry[key];
    const raw = rowByKey.get(key).value;
    let parsed;
    try {
      // 注册表的 `parse` 是第三方代码（P3 会写十几份）⇒ 它抛了也不许把读侧弄抛。
      parsed = entry?.parse ? entry.parse(raw) : { ok: false, reason: 'no_parse' };
    } catch (err) {
      parsed = { ok: false, reason: `parse_threw:${err?.message ?? err}` };
    }
    if (parsed?.ok) {
      values[key] = parsed.value;
      continue;
    }
    problems.push({ key, reason: parsed?.reason ?? 'invalid_db_value' });
    // 点名这个 key + 用了哪个值：「DB 有一行但值非法」是运维手工改库的标准后果。
    log?.warn?.(
      `[runtime-settings] runtime_settings 里 ${key} 的值不可用（${parsed?.reason ?? 'invalid_db_value'}）`
      + ` ⇒ 回落 env/默认（config.${String(entry?.configPath ?? '?')}）`,
    );
  }
  return { values, problems };
}

/**
 * 把 DB 侧的值盖到 config 上 ⇒ 返回**新对象**（不改入参：`loadConfig` 的返回值还要被
 * 其它子命令/日志当作「env 真相」看）。
 *
 * 只覆盖 registry 声明过的 config 字段（`configPath`），其余一格一格原样带过去。
 * 读不到（表不存在 / 抖 / 挂住 / 值非法）⇒ 那一格保留 config 里已有的值，
 * config 里也没有 ⇒ 用 registry 的 `defaultValue`。整次读取失败 ⇒ 结果与入参同值。
 *
 * @param {object} config `loadConfig()` 的返回值
 * @param {object} opts   `{ pool, registry?, timeoutMs?, env?, log? }`
 * @returns {Promise<object>} 新的 config（P1 的 registry 为空 ⇒ 内容与入参相同）
 */
export async function applyRuntimeOverrides(config, opts = {}) {
  const { registry = RUNTIME_SETTING_REGISTRY } = opts;
  // 先做一层**顶层**浅拷贝：即使一次覆盖都没发生，返回的也不是入参那个对象引用。
  const next = { ...(config ?? {}) };
  const keys = Object.keys(registry);
  if (keys.length === 0) return next;

  const { values, problems } = await readRuntimeSettings({ ...opts, registry });
  const logger = opts.log;
  const tierByKey = new Map();
  for (const key of keys) {
    const entry = registry[key];
    const path = entry?.configPath;
    if (!path) continue;
    let value;
    let fromDb = false;
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      value = values[key];
      fromDb = true;
      tierByKey.set(key, 'db');
    } else {
      // env 那一档 = `resolveEnvTier`（值来自 `env[envVar]` 原话或 `config[path]`，**且过了 registry
      // 的闸**）；它也没有 ⇒ registry 的 `defaultValue`（第三档）。回落的理由已在
      // `readRuntimeSettings` 里点过名。⚠ 必须走同一个 `resolveEnvTier`（#701 返修 LOW③）：
      // 启动这一路宽松、热读那一路严格，就是「同一个旋钮两套真相」（界面显示的值与实际用的漂）。
      const envTier = resolveEnvTier(entry, config, { env: opts.env ?? process.env, log: logger });
      value = envTier.value;
      tierByKey.set(key, envTier.source === 'default' ? 'default' : 'env');
    }
    if (value === undefined) continue; // 三档都给不出值 ⇒ 这一格不动，别发明 undefined
    setPath(next, path, value);
    // #709 MED①：把「这一格的值此刻来自哪一档」也标到新 config 上（`<path>Source`，与 `config.js`
    // 里 `sessionTtlSecondsSource` 那套先例同形）。DB 那一档必须标成 `db`——否则 `effectiveConfig`
    // 带着旧库值、却没有「它来自 DB」的标注，热读器在运行期 DB 读失败回落到它时，`configTierSource`
    // 只能凭值猜（env 变量在 ⇒ 谎报 `env`）。env/default 两支不盖标注：它们的 boot 值本就来自 env/默认
    // （热读回落时 `resolveEnvTier` 的 rawGiven 分支 / `configTierSource` 的默认收窄会各自报对），
    // 且读失败整档时若盖标注会破坏「覆盖层内容与 config 相同」这条既有口径（RS-1）。
    if (fromDb) next[`${path}Source`] = 'db';
  }
  // 「哪几格走了哪一档」要说得出口（口径 2：回落必须说清用的是哪个值）。`problems` 是回落的
  // 具体理由（表不存在 / 挂住 / 值非法），与档位一起进同一条 debug，排查时一条就够用。
  if (logger?.debug) {
    const why = problems.map((p) => `${p.key}=${p.reason}`).join(', ');
    logger.debug(
      `[runtime-settings] 覆盖层：${tierByKey.size}/${keys.length} 格定了档`
      + (why ? `，回落理由：${why}` : '，无回落'),
    );
  }
  return next;
}

/**
 * 写侧：校验 + **一个显式事务**（`BEGIN` → `SELECT … FOR UPDATE` 取旧值 → upsert → 审计 →
 * 事务内检查审计行数 → `COMMIT`，口径 6）。
 *
 * 三种情况一律**抛**（HTTP 层映射 400），且**一条 SQL 都不发、也不从池里借连接**：
 *   * `key` 不在 registry ⇒ `unknown_setting`（未登记的 key 写进去就是一行永不生效的配置）；
 *   * `value` 不是 JSON 标量 ⇒ `scalar_required`（口径 3）；
 *   * registry 的 `validate` 拒绝 ⇒ `validation_failed`。
 * 成功 ⇒ 返回**来自 `RETURNING`** 的那一行（`{ key, value, updatedAt, updatedBy, … }`）。
 *
 * 失败形状：事务里任何一步失败 ⇒ `ROLLBACK` ⇒ **设置一格没改**、审计零行（RS-6b 钉这一点）。
 * 审计被静默抑制（trigger `RETURN NULL` 那类）也算失败：审计行数在 `COMMIT` **之前**判，
 * 所以不存在「设置生效了而审计一行没有」那个窗口（真库判据：RS-11 的 trigger 那一段）。
 * `client.release()` 在 `finally`：报错也不许把连接漏在池外。
 *
 * ⚠ 事务里**不套**读侧超时（`withReadTimeout`）：那套服务的是「读侧永不抛、不许把启动挂住」；
 *   写侧失败本来就是 5xx，给它套超时只会把「已拿到行锁」的写挂成半途状态。
 *
 * @param {object} opts `{ pool, actorId?, key, value, registry?, log? }`
 */
export async function saveRuntimeSetting({
  pool, actorId = null, key, value, registry = RUNTIME_SETTING_REGISTRY, log: logger = console,
} = {}) {
  if (!isKnownSetting(key, registry)) {
    throw new RuntimeSettingsError('unknown_setting', `未知的运行时配置项：${String(key)}`, {
      httpStatus: 400,
      details: { field: 'key', known: Object.keys(registry) },
    });
  }
  const entry = registry[key];
  // 标量闸（口径 3）：先于 registry 的 `validate`，且**在发 SQL 之前**——未通过的写一条 SQL 都不发。
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new RuntimeSettingsError('scalar_required',
      `value 只接受 JSON 标量（number / boolean / string），收到 ${typeof value}`, {
      httpStatus: 400, details: { field: 'value' },
    });
  }
  if (value === null || value === undefined || typeof value === 'object') {
    throw new RuntimeSettingsError('scalar_required',
      'value 只接受 JSON 标量，不接受对象 / 数组 / null / undefined', {
      httpStatus: 400, details: { field: 'value' },
    });
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RuntimeSettingsError('scalar_required',
      `value 必须是有限数（收到 ${String(value)}；JSON 也装不下它）`, {
      httpStatus: 400, details: { field: 'value' },
    });
  }
  const why = typeof entry?.validate === 'function' ? entry.validate(value) : true;
  if (why !== true) {
    fail('value', `value 不合格：${String(why ?? '校验失败')}`);
  }

  // 事务必须钉在**同一条连接**上：`pool.query()` 每次另借一条连接，`FOR UPDATE` 拿到的行锁会随
  // 那条语句结束而放掉 ⇒ 并发第二条不必等 ⇒ 旧值又是「自己进来之前」的那个（#698 的病根）。
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // ① 单独一条锁定读：并发第二条卡在这一句上，等到的就是前一个写完之后的值（口径 6 的支点）。
    const previous = await client.query(PREVIOUS_SQL, [key]);
    const previousValue = previous?.rows?.[0]?.value ?? null;
    // ② 写这一行；`RETURNING` 是响应的唯一真相（口径 4）。
    const written = await client.query(UPSERT_SQL, [key, JSON.stringify(value), actorId]);
    const row = written?.rows?.[0] ?? null;
    if (!row) {
      // upsert 带了 `RETURNING` 却不给行 = SQL 形状漂了（审计也在同一个事务里 ⇒ 一起回滚）。
      throw new RuntimeSettingsError('internal', `写入 ${key} 成功却没有 RETURNING 行`, {
        httpStatus: 500,
      });
    }
    // ③ 审计：与 upsert 同生共死。`details` 的三个键与旧 CTE 版逐字相同；`previous_value` 与接口
    //    返回的是**同一个值**（都由上面那一行锁定读派生 ⇒ 不可能漂）。
    const audited = await client.query(AUDIT_SQL, [
      actorId,
      AUDIT_ACTION,
      `${AUDIT_TARGET_PREFIX}:${key}`,
      JSON.stringify({ key: row.key, value: row.value, previous_value: previousValue }),
    ]);
    // ④ **在 `COMMIT` 之前**检查（这一行就是 MED② 的全部内容）：审计被 trigger/rule 静默抑制时
    //    设置也必须跟着回滚 —— 挪到 `COMMIT` 之后就只能「报错但已生效」了（M-2 两刀点名的就是它）。
    const auditRows = Number(audited?.rowCount ?? 0);
    if (auditRows !== 1) {
      throw new RuntimeSettingsError('internal',
        `保存 ${key} 成功但审计写了 ${audited?.rowCount ?? 0} 行（已 ROLLBACK ⇒ 设置未生效）`,
        { httpStatus: 500 });
    }
    await client.query('COMMIT');
    // ⑤ **写完就失效热读缓存**（M-1 点名的就是这一行）。它在 `COMMIT` **之后**：事务 rolled back 时
    //    库里仍是旧值，先失效只会让下一次读再打一次 DB（无害），但会短暂把「写失败」说成
    //    「新值已生效」。查表而不是 `if (key === 'session.ttl_seconds')`：登记表在
    //    `HOT_READ_INVALIDATORS`，P3 加热读旋钮只改那一处。
    HOT_READ_INVALIDATORS.get(key)?.();
    logger?.debug?.(`[runtime-settings] ${key} 已写入（actor=${String(actorId)}）`);
    return {
      key: row.key,
      value: row.value,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      updatedBy: row.updated_by ?? null,
      previousValue: previousValue,
      auditRows,
    };
  } catch (error) {
    // `ROLLBACK` 自己失败（连接已断）不许盖掉真正的错误：要报给运维的是那一条。
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// 热读（P2a 第一格 `session.ttl_seconds` + P3 第一批第二格 `workspace.retention_days`）
// ---------------------------------------------------------------------------

/**
 * 热读缓存的存活时间（毫秒）。**5 秒是口径，不是性能参数**：
 * 它定义的是「管理台改了这一格之后，最坏多久全部进程都看到新值」这个上界。
 * 不做成 0（每请求现读）是刻意的：`/api/me` 是每个登录用户每个页面加载都要打的一次，
 * 让一次纯配置读挂在那条路径上 = 让 `runtime_settings` 成为登录面的依赖（#520 那一单的病根）。
 * ⚠ 所有热读旋钮**共用这一个数**（P2a 定下的口径），不要给第二格单独拍一个 3 秒/10 秒：
 *   「改完最多 5 秒生效」是对外的一句话，变成逐旋钮不同就是三句话。
 */
export const HOT_READ_CACHE_TTL_MS = 5000;

/** P2a 起就在对外的名字（单测引它钉口径）；值就是上面那一个，不留两份数。 */
export const SESSION_TTL_CACHE_TTL_MS = HOT_READ_CACHE_TTL_MS;

/**
 * 一格热读旋钮的全部机件 ⇒ `{ read, invalidate }`（**P3 抽的工厂**）。
 *
 * 为什么抽：P2a 那一格是 60 行缓存 + 40 行在飞合并 + 40 行回落，**没有一格是 TTL 特有的**
 *（特有的只有 key 名、人话名字、以及三档都给不出值时那个数）。拓到第二格就是 140 行副本，
 * 而副本意味着「同一个 bug 要修两次」（#485/#698/#701 在那两上付过账）。所以这里只把
 * **三件参数**（key / warnLabel / fallbackDefault）接进去，其余口径逐字搬过来：
 *   1. **缓存** `{ pool, at, resolved }` + **代际号**（键到 pool 身份，并防「在飞那趟撤销失效」）；
 *   2. **in-flight 合并**：同池并发冷读只发**一条** SQL；落定必清槽，**失败也清**；
 *   3. **一次热读最多一条 warn**（`hotReadWarnMerger`）+ **读侧永不抛** + env 那一档也过闸。
 *
 * ⚠ 每一格热读旋钮**自己一份缓存与一个槽**（工厂里的那三个局部量）：共用一份就是
 *   「保存 TTL 会把保留天数那一格的缓存一起抹掉」，然它们读的是同一张表但不同 key。
 *
 * @param {object} opts
 * @param {string} opts.key            registry 里的 key（= 取 `values[key]`、也是 problems 里那一格）
 * @param {string} opts.warnLabel      人话名字（只进日志/错误文案；**不是**第二份真相）
 * @param {number} opts.fallbackDefault 三档都给不出值时的绝对兵（绝不回 `undefined`）
 */
function createHotReader({ key, warnLabel, fallbackDefault, cacheTtlMs = HOT_READ_CACHE_TTL_MS }) {
  /**
   * 单格模块级缓存（形状照 `llm.js` 的 `dataPlaneNameCache`，连**代际号**一起照）：
   * `{ pool, at, resolved }`。键到 pool 是刻意的：测试与多池场景下不许 A 池的读数喂给 B 池。
   */
  const cache = { pool: null, at: 0, resolved: null };

  /**
   * 缓存代际号，只在下面那个 `invalidate()` 里自增。为什么必须有（`llm.js` 那一单已经付过账）：
   * 本函数会 `await` 一次 DB 读，await 期间可能有人保存并失效了缓存；等这趟回来，**旧快照**会被
   * 无条件写回缓存 ⇒ 「失效」被这趟在飞的读撤销。读侧在 await **之前**记下代际号，写回时只有
   * 代际没变才落盘；变了就只把结果给当前调用方（它拿到的仍是它自己那趟的真实读数）。
   */
  let generation = 0;

  /**
   * **in-flight 合并槽**（#701 返修 MED）：`{ pool, promise }`，形状照 `llm.js` 的 TTL 缓存那套
   * 「按 client 身份分槽」的思路 —— 槽键到 **pool 身份**，A 池的在飞读不许喂给 B 池。
   *
   * 为什么必须有（review 实测的形状）：这条读挂在**续期热路径**（`http.js` 的 `/api/me`）与
   * **每一拍 offboarding** 上，而缓存刚失效/刚过期那一刻是**并发**的：4 路同时打到冷缓存
   * ⇒ 4 条 SQL，DB 慢时每路各自可能等满读超时（默认 1500ms）⇒ 一次 DB 抖动把一整波登录/
   * 续期各挂 1.5 秒。合并后同一波只发**一条** SQL，其余各路复用同一趟的结果（等同一份时间，
   * 但不再各发一条、也不再各占一条连接）。
   *
   * ⚠ 两条容易漏的口径（判据 RS-18 / RS-19 / RS-20 各钉一条，第二格是同形的 RS-26/RS-27）：
   *   1. **落定必清槽，失败也要清**：不清槽 ⇒ 之后所有读都钉在同一个**已落定**的 promise 上
   *      （失败那趟尤其糟：它没有缓存可兜，每次都被拉回去重放同一个失败）。
   *   2. **写路径失效也要清槽**：只清缓存的话，「PUT 完的下一次读」可能命中 PUT **之前**就发起的
   *      那一趟 ⇒ 拿到旧值，且那次读**不发 SQL**（写进去了却看不见，是比慢更难查的形状）。
   */
  const inFlight = { pool: null, promise: null };

  /** 只有槽里还是**自己那一趟**时才清（在飞期间被失效过、或已被新趟接替 ⇒ 不许撤销别人的槽）。 */
  function releaseInFlight(task) {
    if (inFlight.promise === task) {
      inFlight.pool = null;
      inFlight.promise = null;
    }
  }

  /**
   * 丢弃这一格的缓存。**只在写路径调用**（`saveRuntimeSetting` 的 `COMMIT` 之后，经由
   * `HOT_READ_INVALIDATORS`）。
   *
   * ⚠ 失效只覆盖**本进程**：多副本时别的进程最坏还要吃 5 秒旧值（TTL 到点自己恢复）。
   *   所以口径是「下一次读、最多 5 秒内生效」，**不是**强一致，也不是「每个请求都现读 DB」。
   *
   * ⚠ 它同时清 **in-flight 槽**（#701 返修 MED 第二条）：在飞的那一趟是在写**之前**发起的，
   *   它的结果已经是旧世界；不清槽就是「保存成功而界面还显示旧值」那条路。
   */
  function invalidate() {
    generation += 1;
    cache.pool = null;
    cache.at = 0;
    cache.resolved = null;
    inFlight.pool = null;
    inFlight.promise = null;
  }

  /**
   * 一趟**真的发了 SQL** 的读（in-flight 合并的最小单位）：读整表 → 取 `key` 那一格
   * → 按代际号回填缓存。**口径 1 不变**：这一趟算不出值时照样给回落值。
   *
   * 它**会抛**一支「DB 读不可用」（唯一的抛点，在缓存回填**之后**）：
   *   * 抛给外层 ⇒ 外层按「读不到」回落（返回值与 debug 形状不变；warn 的形状见下面那个合并器）；
   *   * 更重要的是让 in-flight 槽知道「这一趟是**失败落定**」，从而在失败路径上也清槽。
   *     不抛的话「失败」与「成功」在槽看来同形 ⇒ 「失败必清槽」退化成「跑完了顺手清」，
   *     RS-19 那一格就红不了（变异会绿着过）。
   *
   * ⚠ #701 二审 LOW②：这一趟的 warn **最多一条**（`hotReadWarnMerger`），并且算好的回落值挂在
   *   抛出的错误的 `details.fallbackValue` 上 —— 外层与共享者**复用**它，不再自己重算一遍
   *   env 闸（重算一遍 = 同一条 env warn 的第二份，也正是那半条刷屏的来源）。
   */
  async function flight({ pool, config, now, log, env, registry, entry, timeoutMs }) {
    const generationAtStart = generation;
    const at = now();
    const warns = hotReadWarnMerger(log, warnLabel);
    const fallback = () => {
      // env 那一档也要过 registry 的闸（LOW③）：坏值 ⇒ 视为没给 ⇒ registry 默认 + 点名 warn。
      const value = resolveEnvTier(entry, config, { env, log: warns.log }).value;
      return value === undefined ? fallbackDefault : value;
    };
    let value;
    let readUnavailable = null;
    try {
      try {
        // 复用整表那一次读（同一份 SQL、同一份超时、同一份永不抛口径）——不另开 per-key 的 SELECT。
        const { values, problems } = await readRuntimeSettings({
          pool, registry, timeoutMs, env, log: warns.log,
        });
        const dbValue = values?.[key];
        if (Number.isSafeInteger(dbValue)) {
          value = dbValue;
        } else {
          // 故障（表不在 / 挂住 / 没有池子）与「有行但值坏」要分开：前者才是「这趟没读到东西」。
          const reason = (problems ?? []).find((p) => p?.key === key)?.reason;
          if (DB_READ_FAILURE_REASONS.has(reason)) readUnavailable = String(reason);
          value = fallback();
        }
      } catch (err) {
        // 双保险：`readRuntimeSettings` 自己永不抛，但它上面还套着 registry 注入这条缝
        //（假库/假 registry 传进来就是这里的形状）⇒ 热路径一行都不许抛。
        readUnavailable = `threw:${err?.message ?? err}`;
        value = fallback();
      }
      if (generationAtStart === generation) {
        cache.pool = pool;
        cache.at = at;
        cache.resolved = value;
      }
      if (readUnavailable) {
        throw new RuntimeSettingsError('read_unavailable',
          `${warnLabel} 的 DB 读不可用（${readUnavailable}）⇒ 已回落 env/默认`,
          // `fallbackValue`：这一趟算好的回落值。`read_unavailable` 只在本模块内部被接住（全仓
          // 调用方只有下面那个 `read`）⇒ 这些 `details` 不会泄漏到 HTTP 响应里。
          { httpStatus: 500, details: { fallbackValue: value } });
      }
      return value;
    } finally {
      // 成功与失败都只在这里播那**唯一一条** warn（放 `finally`：连意外抛出也不吞掉理由）。
      warns.emit();
    }
  }

  /**
   * 热读入口（口径与 `readRuntimeSettings` 逐字相同：DB 有效值 > env > registry 默认，读侧永不抛），
   * 差别只有三件：① 结果进 5s 缓存；② 同池的并发冷读**合并成一趟 SQL**；③ 只回一个数。
   *
   * ⚠ 注释里别写成「每请求现读 DB」：真实形状是**最多 5 秒一次**（同池内命中缓存不发 SQL），
   *   而同一波并发冷读只发**一条**（`inFlight`）。多副本时最坏 5 秒内各副本读到的值可以不同
   *  （本进程保存会立刻失效，别的进程靠 TTL 到点）。
   *
   * @param {object} opts `{ pool, config, now?, log?, env?, registry?, ttlMs?, timeoutMs? }`
   *   `now` / `ttlMs` 可注入 ⇒ 缓存的两端（命中 / 过期）能在假库里判定，不用真等 5 秒。
   *   ⚠ 共享在飞那趟的调用方拿到的是**发起方**那趟的 `timeoutMs`（生产里只有一个池、一份 config，
   *     所以这不是第二份真相；测试里并发那格必须用同一组参数）。
   * @returns {Promise<number>} 生效的值；三档都给不出 ⇒ `fallbackDefault`（绝不回 `undefined`）
   */
  async function read({
    pool, config, now = Date.now, log = console, env = process.env,
    registry = RUNTIME_SETTING_REGISTRY, ttlMs = cacheTtlMs, timeoutMs,
  } = {}) {
    const entry = registry?.[key] ?? RUNTIME_SETTING_REGISTRY[key];
    const at = now();
    if (ttlMs > 0 && cache.resolved !== null
      && cache.pool === pool && at - cache.at <= ttlMs) {
      return cache.resolved;
    }
    const fallbackOnly = () => {
      // 在飞那趟挂了/或压根没起：外层自己算一次回落值（同样是过闸的那一套，见 LOW③）。
      const value = resolveEnvTier(entry, config, { env, log }).value;
      return value === undefined ? fallbackDefault : value;
    };
    /**
     * 那一趟失败时怎么把答案交出去（#701 二审 LOW②的另一半）：**复用那一趟算好的回落值**，
     * 不再自己 `resolveEnvTier` 一遍。原本每接住一次 `read_unavailable` 就把同一条「env 兜底被拒」
     * 再 warn 一遍（发起方一遍 + 每个共享者各一遍）叠加 `readRuntimeSettings` 自己那条 DB 故障
     * warn ⇒ 一次热读三条、DB 抖动期刷屏。那一趟的 warn 已在 `flight` 的 `finally` 里播完
     *（那一趟只一条），这里**只留 debug**。
     *
     * ⚠ 共享者拿到的是**发起方**那趟算出的回落值：与它自己那趟共用 `timeoutMs` 是同一个口径
     *   （生产只有一份 config / env；测试里并发那格必须同参数）。
     */
    const answerOfFailedFlight = (err) => {
      const carried = err?.details?.fallbackValue;
      if (carried !== undefined) return carried;
      // 不是那一趟递上来的回落（罕见的注入形状）⇒ 自己算，允许它自己 warn 一条。
      return fallbackOnly();
    };
    // ② in-flight 合并：同池已有读在飞 ⇒ **复用那一趟**，不再发第二条 SQL（这就是 MED 的全部）。
    if (inFlight.promise && inFlight.pool === pool) {
      log?.debug?.(`[runtime-settings] 复用同池在飞的 ${warnLabel} 读（不重复发 SQL）`);
      try {
        return await inFlight.promise;
      } catch (err) {
        log?.debug?.(`[runtime-settings] 在飞那趟失败 ⇒ 本次读复用那一趟的回落值（${err?.message ?? err}）`);
        return answerOfFailedFlight(err);
      }
    }
    const task = flight({ pool, config, now, log, env, registry, entry, timeoutMs });
    inFlight.pool = pool;
    inFlight.promise = task;
    // **成功与失败都要清槽**：`.then(onOk, onErr)` 两支都挂 `release`，而不是只在成功分支挂 ——
    // 一次 DB 抖动把之后所有读钉在同一个已落定的 promise 上，比慢更难查。
    // 挂在这里而不是 `finally` 里：清槽是**槽的**责任，`flight` 只管读数与缓存回填。
    task.then(() => releaseInFlight(task), () => releaseInFlight(task));
    try {
      return await task;
    } catch (err) {
      // 口径 1：读侧永不抛。`flight` 里已经填过回落缓存、也已经播过那唯一一条 warn，
      // 这里只负责把那一趟算好的值交出去（不再重算 env 闸 = 不再多一条重复 warn，LOW②）。
      log?.debug?.(`[runtime-settings] ${key} 热读兜底 env/默认（${err?.message ?? err}）`);
      return answerOfFailedFlight(err);
    }
  }

  // `cache` / `inFlight` 跟着递出去只为单测能摸到槽（不要求它们存在，只用来钉「失败后槽是空的」）。
  return { read, invalidate, cache, inFlight };
}

const sessionTtlHotReader = createHotReader({
  key: SESSION_TTL_KEY,
  warnLabel: 'session TTL',
  fallbackDefault: SESSION_TTL_DEFAULT_SECONDS,
});

const workspaceRetentionHotReader = createHotReader({
  key: WORKSPACE_RETENTION_KEY,
  warnLabel: 'workspace 保留天数',
  fallbackDefault: WORKSPACE_RETENTION_DEFAULT_DAYS,
});

const previewTicketTtlHotReader = createHotReader({
  key: PREVIEW_TICKET_TTL_KEY,
  warnLabel: 'preview 票有效期',
  fallbackDefault: PREVIEW_TICKET_TTL_DEFAULT_SECONDS,
});

const autoTitleMinNewHotReader = createHotReader({
  key: AUTO_TITLE_MIN_NEW_KEY,
  warnLabel: '自动标题防抖阈值',
  fallbackDefault: AUTO_TITLE_MIN_NEW_DEFAULT,
});

// P3 第六批：三个退避旋钮 = **三份独立实例**（各自一份缓存 / 代际号 / 在飞槽）。
// 不要为了省三行代码把它们台成一个实例：同一条 SQL、但三个 key，共用槽就是互相抹缓存。
const onboardingIdleBackoffHotReader = createHotReader({
  key: ONBOARDING_IDLE_BACKOFF_MS_KEY,
  warnLabel: '开户循环空闲退避上限',
  fallbackDefault: ONBOARDING_IDLE_BACKOFF_MS_DEFAULT,
});

const offboardingIdleBackoffHotReader = createHotReader({
  key: OFFBOARDING_IDLE_BACKOFF_MS_KEY,
  warnLabel: '销号循环空闲退避上限',
  fallbackDefault: OFFBOARDING_IDLE_BACKOFF_MS_DEFAULT,
});

const provisionerIdleBackoffHotReader = createHotReader({
  key: PROVISIONER_IDLE_BACKOFF_MS_KEY,
  warnLabel: '对账循环空闲退避上限',
  fallbackDefault: PROVISIONER_IDLE_BACKOFF_MS_DEFAULT,
});

/**
 * 丢弃 TTL 缓存（P2a 对外的名字；实现是上面那个工厂里每一格自己的 `invalidate`）。
 * 它必须是 `HOT_READ_INVALIDATORS` 里登记的那一个（RS-7 钉住身份），P3 抽工厂后也不能换成间接层。
 */
export function invalidateSessionTtlCache() {
  sessionTtlHotReader.invalidate();
}

/** 丢弃 `workspace.retention_days` 的缓存与在飞槽（口径与上面逐字相同；写路径在 `COMMIT` 后调）。 */
export function invalidateWorkspaceRetentionCache() {
  workspaceRetentionHotReader.invalidate();
}

/** 丢弃 `preview.ticket_ttl_seconds` 的缓存与在飞槽（口径同上；签票路径现读，写后立即生效）。 */
export function invalidatePreviewTicketTtlCache() {
  previewTicketTtlHotReader.invalidate();
}

/** 丢弃 `session.auto_title_min_new` 的缓存与在飞槽（口径同上；每次评估标题现读，写后立即生效）。 */
export function invalidateAutoTitleMinNewCache() {
  autoTitleMinNewHotReader.invalidate();
}

/** 丢弃 `loop.onboarding_idle_backoff_ms` 的缓存与在飞槽（口径同上；开户循环每一拍现读）。 */
export function invalidateOnboardingIdleBackoffCache() {
  onboardingIdleBackoffHotReader.invalidate();
}

/** 丢弃 `loop.offboarding_idle_backoff_ms` 的缓存与在飞槽（口径同上；销号循环每一拍现读）。 */
export function invalidateOffboardingIdleBackoffCache() {
  offboardingIdleBackoffHotReader.invalidate();
}

/** 丢弃 `loop.provisioner_idle_backoff_ms` 的缓存与在飞槽（口径同上；对账循环每一拍现读）。 */
export function invalidateProvisionerIdleBackoffCache() {
  provisionerIdleBackoffHotReader.invalidate();
}

/**
 * `applyMode: 'hot'` 的旋钮 ⇒ 保存后要失效的缓存。一格一行；加新的热读旋钮就在这里多登记一行，
 * **不要**在 `saveRuntimeSetting` 里堆 `if`（那会把「谁需要失效」摊到两处）。
 * ⚠ **漏登记这一行是 P3 那族最典型的坑**：保存能写进库、界面也会回填 DTO，但本进程的
 *   热读还是旧值（最多 5 秒，而在飞那一趟是**不限时**的旧值）。
 */
export const HOT_READ_INVALIDATORS = new Map([
  [SESSION_TTL_KEY, invalidateSessionTtlCache],
  [WORKSPACE_RETENTION_KEY, invalidateWorkspaceRetentionCache],
  [PREVIEW_TICKET_TTL_KEY, invalidatePreviewTicketTtlCache],
  [AUTO_TITLE_MIN_NEW_KEY, invalidateAutoTitleMinNewCache],
  [ONBOARDING_IDLE_BACKOFF_MS_KEY, invalidateOnboardingIdleBackoffCache],
  [OFFBOARDING_IDLE_BACKOFF_MS_KEY, invalidateOffboardingIdleBackoffCache],
  [PROVISIONER_IDLE_BACKOFF_MS_KEY, invalidateProvisionerIdleBackoffCache],
]);

/**
 * #701 返修 LOW③：**env 兜底值也必须过 registry 的 `parse`/`validate`**（与 DB 值同一套闸）。
 *
 * 修的是「同一个旋钮两套真相」：`config.js` 的 `intEnv` 走的是 `Number()` 语义，它收 `30`、
 * `2592001`、`60.5`（都是有限正数），而 registry 的闸要求**整数且 60..2592000**。在那之前
 * DB 那一路严格、env 那一路宽松 —— 独立审计的实测（AUDIT-REPORT §4）：三个越界值都以
 * `source=env` 被采纳，而 DB 里写同样的值会被 400 拒掉。
 *
 * 口径（**不改通用 `intEnv`**，那会连带影响别的旋钮；闸落在 registry 驱动的这一层）：
 *   * env 值过不了闸 ⇒ **视为「env 没给」**⇒ 回落 registry 的 `defaultValue`，`source` 如实报
 *     `default`（不许再报 `env`：报 `env` 就是在指着一个根本不生效的数，#485 那格的口径）；
 *   * 一条**点名 key + env 名 + 原值 + 被拒理由**的 warn（读侧仍**不抛**，硬口径 1 不动）；
 *   * 条目没声明 `parse`/`validate`（P3 的新旋钮）⇒ 不加闸，原样通过（闸是条目自己声明的）。
 *
 * 判读顺序：**先看 env 原话**（`env[entry.envVar]`），没有原话才看 `config[configPath]`。
 * 为什么必须拿原话判：`loadConfig` 的 `Number()` 已经把坏值揉过一遍（`'abc'` → 默认值、
 * `' 86400 '` → 86400、`'1e5'` → 100000），揉完的形状在 config 里**看不出它是坏值**。
 *
 * @returns {{ ok: boolean, value?: unknown, reason?: string }}
 */
function gateRegistryValue(entry, candidate) {
  let value = candidate;
  if (entry.parse) {
    let parsed;
    try {
      parsed = entry.parse(candidate);   // 与 DB 值调用的是**同一个函数**，不是第二份实现
    } catch (err) {
      return { ok: false, reason: `parse_threw:${err?.message ?? err}` };
    }
    if (!parsed?.ok) return { ok: false, reason: parsed?.reason ?? 'rejected_by_parse' };
    value = parsed.value;
  }
  if (entry.validate) {
    let why;
    try {
      why = entry.validate(value);
    } catch (err) {
      return { ok: false, reason: `validate_threw:${err?.message ?? err}` };
    }
    if (why !== true) {
      return { ok: false, reason: typeof why === 'string' && why ? why : 'rejected_by_validate' };
    }
  }
  return { ok: true, value };
}

/**
 * env 那一档的**来源**（`'env' | 'default'`），给管理台如实显示「当前生效值从哪来」。
 * 只在「这一档的值来自 `config` 且过了闸」时被问到的那份旧口径：优先看 `config[<configPath>Source]`
 * （#485 为 `FILE_UPLOAD_MAX_BYTES` 立的那格：判据是「env 里有没有显式写这个键」，而不是
 * 「它是否等于默认值」——显式写了恰好等于默认值，来源是 env）。
 *
 * 没有这个标注字段（P3 的新条目可能没有）⇒ 原来的口径是「`config` 里有值就算 env」。那一条
 * 对**永远有值的旋钮**会抖：`workspace.retention_days` 的 `loadConfig` 默认就是 `0`，而 `0` 不是
 * 「没值」⇒ 运维压根没配过 `ERIX_WORKSPACE_RETENTION_DAYS`，管理台却会说「这一格是 env 配的」。
 * P3 第一批改成：值恰好等于 registry 默认 ⇒ 报 `default`（分不清的时候宁可**少声称**一次 env，
 * 「界面说 env 其实没配」是 #485/#701 一路在拆的那一类抖）；值与默认不同 ⇒ 才是真的有人给了。
 * ⚠ 不拿它当「显式写了默认值」的判据：那条路仍走 `config[...Source]`（或由 `resolveEnvTier` 里
 *   「env 原话在」那一支直接定成 `env`），这里的收窄只作用在**没有标注字段**的条目上。
 */
function configTierSource(entry, config) {
  const flagPath = `${entry?.configPath ?? ''}Source`;
  if (config && Object.hasOwn(config, flagPath)) {
    // #709 MED①：标注可以是三档 `env | default | db`。`applyRuntimeOverrides` 会把「启动时从
    // DB 覆盖进来的那一格」标成 `db`。旧口径把非 `env` 一律塌成 `default` ⇒「DB 读失败、手里
    // 只有启动时的 DB 快照」被谎报成 default/env（运维去改 env，其实值来自旧库）。如实透传三档。
    const annotated = config[flagPath];
    if (annotated === 'env' || annotated === 'default' || annotated === 'db') return annotated;
    return 'default';
  }
  const value = getPath(config, entry?.configPath);
  if (value === undefined) return 'default';
  return value === entry?.defaultValue ? 'default' : 'env';
}

/**
 * env 那一档的裁决：`{ value, source, gated }`。值是**过了闸**的那个（`'86400'` 这种数字串
 * 由 `parse` 搬成 number），过不了 ⇒ registry 默认 + `source='default'` + 一条点名 warn。
 *
 * @param {object} entry registry 条目
 * @param {object} config `loadConfig()` 的返回值（或测试手递的等价物）
 * @param {object} opts   `{ env, log }`（`env` 只用来取**原话**做裁决，不是第二份真相）
 */
function resolveEnvTier(entry, config, { env = process.env, log = console } = {}) {
  const fallbackValue = entry?.defaultValue;
  const envName = typeof entry?.envVar === 'string' ? entry.envVar : '';
  const raw = envName && env ? env[envName] : undefined;
  const rawGiven = raw !== undefined && raw !== null && String(raw).trim() !== '';
  const cfgValue = getPath(config, entry?.configPath ?? '');
  // 条目**没声明闸**（P3 的新旋钮可能还没写 `parse`）⇒ 这一层不做任何裁决，走旧口径：
  // 值就是 `config[path]`。为什么要退回旧路：没有 `parse` 就没人把 `'99'` 搬成 `99`，
  // 拿 env 原话当值等于把字符串塞进 config（对 P3 是白丢的一格行为变更）。
  if (!entry?.parse && !entry?.validate) {
    return {
      value: cfgValue === undefined ? fallbackValue : cfgValue,
      source: cfgValue === undefined ? 'default' : configTierSource(entry, config),
      gated: null,
    };
  }
  const candidate = rawGiven ? raw : cfgValue;
  if (candidate === undefined) return { value: fallbackValue, source: 'default', gated: null };
  const verdict = gateRegistryValue(entry, candidate);
  if (verdict.ok) {
    return {
      value: verdict.value,
      source: rawGiven ? 'env' : configTierSource(entry, config),
      gated: null,
    };
  }
  const whence = rawGiven
    ? `env ${envName}=${JSON.stringify(candidate)}`
    : `config.${entry?.configPath ?? '?'}=${JSON.stringify(candidate)}（env ${envName} 未显式给）`;
  // 点名 key + env 名 + 原值 + 理由：值班的人要能一眼看出「这个 env 值根本没生效，去哪改」。
  log?.warn?.(
    `[runtime-settings] ${entry?.key ?? '?'} 的 env 兜底被拒（${whence} 过不了写侧那套闸：`
    + `${verdict.reason}）⇒ 视为 env 没给，回落默认 ${JSON.stringify(fallbackValue)}`
    + '（DB / env / 默认三档共用同一套 parse/validate，不留两套真相）',
  );
  return { value: fallbackValue, source: 'default', gated: verdict.reason };
}

/**
 * DB 那一档「**压根没读到**」的理由族（与「读到了但值不可用」分开：前者是故障，后者是数据）。
 * 只有故障族会把在飞那一趟标成失败（见 `createHotReader` 里 `flight` 的那条 throw）。
 */
const DB_READ_FAILURE_REASONS = new Set(['read_failed', 'read_timeout', 'no_pool']);

/**
 * 一次**热读**的 warn 合并器（#701 二审 LOW②）：这一趟里下游想 warn 的东西先攒着，
 * 出去之前**最多播一条**。
 *
 * 为什么必须有（二审实测的形状）：DB 读失败（`read_failed`）**叠加** `SESSION_TTL_SECONDS`
 * 是坏值时，一次热读原本 warn **三条** —— `readRuntimeSettings` 一条「读 runtime_settings 失败」
 * + 那一趟的回落算一条「env 兜底被拒」+ 外层接住 `read_unavailable` 后又算一条
 *（同一条文案的第二份，内容逐字相同）。DB 抖动期间**每个请求**都走这条路（缓存里钉着的就是
 * 回落值，5s 到点又来一趟）⇒ 刷屏；而 `docs/api/portal.md` §4.21 与 `docs/env.md` 的口径是
 * 「坏 env 留**一条**点名 warn」。
 *
 * **选「合并成一条」而不是「把 env 那条降成 debug」**：要的那一条必须**同时**说清两件事
 *（DB 侧为什么没读到 + env 那个值为什么被拒）。降 debug 只会留下 DB 那条文案 ⇒ 运维看不见
 * env 那一档也坏了 = 少一半真相（#485 立的「回落要点名是哪一档没生效」口径）。
 *
 * ⚠ 只有一件事要说时**原文照播**（不改既有文案：RS-13 ② / RS-21 钉的就是那两条的原话）。
 * ⚠ 攒的范围只有**这一趟**：局部对象，不跨请求、不跨 pool，也不是进程级 once（下一趟该说还得说）。
 * ⚠ `warnLabel` 是拼那一条**汇总**文案用的人话名字（P3 抽工厂后逐格不同）；单件的原文文案
 *   一个字都不动 —— 那些原话是被单测钉住的。
 */
function hotReadWarnMerger(log, warnLabel = 'session TTL') {
  const pieces = [];
  return {
    /** 喂给下游（`readRuntimeSettings` / `resolveEnvTier`）：debug 原样转，warn 先攒着不直接落。 */
    log: {
      debug: (m) => log?.debug?.(m),
      warn: (m) => { pieces.push(String(m)); },
      error: (m) => { pieces.push(String(m)); },
    },
    /** 这一趟唯一的那条 warn：0 件不播；1 件原文播；≥2 件拼成一条（每件的原话都在）。 */
    emit() {
      if (pieces.length === 0) return;
      if (pieces.length === 1) { log?.warn?.(pieces[0]); return; }
      const body = pieces.map((m, i) => `${i + 1}) ${m.replace(/^\[runtime-settings\]\s*/, '')}`);
      log?.warn?.(
        `[runtime-settings] 这一次 ${warnLabel} 热读同时撞上有 ${pieces.length} 件事，合成一条`
        + '（逐条播就是刷屏：DB 抖动期每个请求都走这条路）⇒ ' + body.join(' ；'),
      );
    },
  };
}

/**
 * 会话 TTL 的**热读**入口（`http.js` 的建会话/续期路径调它）。P2a 的对外形状，实现已搬进
 * `createHotReader` —— **对外行为逐字不变**（RS-14~RS-22 那九格原样绿就是这件事的判据），
 * 差别只有两处纯文字：错误文案里 `fallbackSeconds` 改叫 `fallbackValue`（只在本模块内部流动），
 * 以及 debug 文案里的名字换成参数化的 `warnLabel`。
 *
 * @param {object} opts `{ pool, config, now?, log?, env?, registry?, ttlMs?, timeoutMs? }`
 * @returns {Promise<number>} 生效的 TTL 秒数；三档都给不出值 ⇒ `SESSION_TTL_DEFAULT_SECONDS`
 *   （绝不回 `undefined`：调用方把它交给 `createSession`，`undefined` 会变成「库里没有 TTL」）
 */
export function readSessionTtlSeconds(options = {}) {
  return sessionTtlHotReader.read(options);
}

/**
 * `workspace.retention_days` 的**热读**入口（P3 第一批；调用方是 `offboarding.js` 的循环）。
 *
 * 口径与 `readSessionTtlSeconds` 同一套（同一工厂）：DB 有效值 > env（过闸）> registry 默认，
 * 5s 缓存 + 同池在飞合并 + 写路径失效，**读侧永不抛**，一次热读最多一条 warn。
 *
 * ⚠ 与 TTL 那格**不共用缓存与槽**：共用一份就是「保存 TTL 把保留天数的缓存一起抹掉」，
 *   而两格读的是同一张表的不同 key（判据：RS-25 那格的两把失效）。
 *
 * @param {object} opts 同上
 * @returns {Promise<number>} 生效的保留天数；三档都给不出 ⇒ `0`（= **不自动清理**，安全侧）。
 *   绝不回 `undefined`：调用方拿它比 `=== 0` 决定这一拍要不要清理。
 */
export function readWorkspaceRetentionDays(options = {}) {
  return workspaceRetentionHotReader.read(options);
}

/**
 * `preview.ticket_ttl_seconds` 的**热读**入口（P3 第二批；调用方是 `http.js` 签发预览票那一次）。
 *
 * 口径与上面两格同一套（同一工厂）：DB 有效值 > env（过闸）> registry 默认（60），
 * 5s 缓存 + 同池在飞合并 + 写路径失效，**读侧永不抛**，一次热读最多一条 warn。
 *
 * @param {object} opts `{ pool, config, now?, log?, env? }`
 * @returns {Promise<number>} 生效的票有效期秒数；三档都给不出 ⇒ `60`（绝不回 `undefined`）。
 */
export function readPreviewTicketTtlSeconds(options = {}) {
  return previewTicketTtlHotReader.read(options);
}

/**
 * `session.auto_title_min_new` 的**热读**入口（P3 第三批；调用方是 `session-title.js` 的
 * `evaluateAutoTitle()`，每次评估自动标题那一次）。
 *
 * 口径与上面三格同一套（同一工厂）：DB 有效值 > env（过闸）> registry 默认（3），
 * 5s 缓存 + 同池在飞合并 + 写路径失效，**读侧永不抛**，一次热读最多一条 warn。评估自动标题
 * 本就是「一轮一次」的低频动作，5s 缓存下同进程不会为它多打 DB。
 *
 * @param {object} opts `{ pool, config, now?, log?, env? }`
 * @returns {Promise<number>} 生效的防抖阈值（轮）；三档都给不出 ⇒ `3`（绝不回 `undefined`）。
 */
export function readAutoTitleMinNew(options = {}) {
  return autoTitleMinNewHotReader.read(options);
}

/**
 * `loop.onboarding_idle_backoff_ms` 的**热读**入口（P3 第六批；调用方是 `onboarding.js` 的循环，
 * 位置是**每一拍决定 sleep 之前**，不是启动时算一次）。
 *
 * 口径与上面四格同一套（同一工厂、**这一格自己一份缓存**）：DB 有效值 > env（过闸）> 默认 30000，
 * 5s 缓存 + 同池在飞合并 + 写路径失效，**读侧永不抛**，一次热读最多一条 warn。
 *
 * @param {object} opts `{ pool, config, now?, log?, env? }`
 * @returns {Promise<number>} 生效的退避上限毫秒；三档都给不出 ⇒ 30000（绝不回 `undefined`）。
 */
export function readOnboardingIdleBackoffMaxMs(options = {}) {
  return onboardingIdleBackoffHotReader.read(options);
}

/** `loop.offboarding_idle_backoff_ms` 的热读入口（口径同上；默认 30000，自己一份缓存）。 */
export function readOffboardingIdleBackoffMaxMs(options = {}) {
  return offboardingIdleBackoffHotReader.read(options);
}

/**
 * `loop.provisioner_idle_backoff_ms` 的热读入口（口径同上，**默认 15000**，自己一份缓存）。
 *
 * ⚠ 这一格的值域上界是**对账的业务上限** 15000（不是共享的 60000）：越界的 env/DB 值会被闸拦下
 *   并落到默认 15000，与旧路径 `resolveIdleBackoffMaxMs` 的「warn + 钳到 15000」是同一个生效值。
 */
export function readProvisionerIdleBackoffMaxMs(options = {}) {
  return provisionerIdleBackoffHotReader.read(options);
}

// ---------------------------------------------------------------------------
// 管理台读/写（`GET /api/admin/runtime-settings`、`PUT /api/admin/runtime-settings/:key`）
// ---------------------------------------------------------------------------

/**
 * 管理台专用的一条读：比读侧那条多取 `updated_at` / `updated_by`。
 *
 * 为什么不复用上面那条 `SELECT_SQL`：它只有 `key, value`，而管理台要能说「谁在什么时候改的」
 * （#659 那套「一行配置要能说出自己从哪来、被谁改过」的口径）。改它就得动 P1 已审计通过的
 * 读侧 SQL 与它的判据（RS-11 直接钉那条语句的形状），而这条读只在管理台一次点击里发生
 * ⇒ 宁可多一条语句，也不在热路径上多带两个列。**共用的是超时、`parse`、永不抛口径**，
 * 只有列清单不同。
 */
const SELECT_ADMIN_SQL = 'SELECT key, value, updated_at, updated_by FROM runtime_settings ORDER BY key';

/** `Date` ⇒ ISO 字符串（与其它 DTO 的时间字段同形状；拿不到就 `null`，不发明值）。 */
function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' && value ? value : null;
}

/**
 * `hint` 是**可选键**：registry 那一格登记了才带，没登记就连键都不存（不是 `null`、不是空串）。
 * 为什么不是「人人一个 null」：RS-16 钉的是「一项的键就是那八个」，而前端也得自己判空才能
 * 不渲染一行空提示。带与不带都由 registry 说话，前端只照 DTO 渲染。
 */
function withHint(dto, entry) {
  const hint = entry?.hint;
  return typeof hint === 'string' && hint !== '' ? { ...dto, hint } : dto;
}

/**
 * 一条登记项 ⇒ 响应 DTO（`source` 三档 `db | env | default`，`reason` 只在回落时有点名理由）。
 *
 * `envTier` 是调用方算好的**过了闸的** env 那一档（`resolveEnvTier`）：管理台报的那个值必须与
 * 热读真正用的那个值是同一个数（#701 返修 LOW③：两边各算一套就是界面与行为分叉）。
 */
function toSettingItem(entry, row, envTier, fallbackReason = null) {
  const raw = row?.value;
  let parsed = { ok: false, reason: 'no_row' };
  if (row) {
    try {
      parsed = entry?.parse ? entry.parse(raw) : { ok: false, reason: 'no_parse' };
    } catch (err) {
      parsed = { ok: false, reason: `parse_threw:${err?.message ?? err}` };
    }
  }
  const base = {
    key: entry.key,
    label: entry.label ?? entry.key,
    applyMode: entry.applyMode === 'hot' ? 'hot' : 'restart',
    updatedAt: row ? toIso(row.updated_at) : null,
    updatedBy: row?.updated_by ?? null,
  };
  if (parsed?.ok) {
    return withHint({ ...base, value: parsed.value, source: 'db', reason: null }, entry);
  }
  // 回落：值来自 env 那一档（或 registry 默认），`reason` 说清为什么不是 db。
  // `row` 存在但值非法 ⇒ 保留库里那行的 updated_at/by（它们是真发生过的事），只是值不用它。
  // #709 MED①：若 `envTier.source==='db'` 且读不到行 ⇒ 这一档用的是「启动时从 DB 覆盖进来的
  // 快照」，`reason` 必须点明用的是启动时快照，而不是谎报 env/default（否则运维会去改一个
  // 根本不影响这个值的 env）。
  // #709b LOW①：但「启动时快照」那一档还要再分两种，**故障与没配不能共用一个理由**：
  //   · `fallbackReason` 是故障族（`read_failed` / `read_timeout` / `no_pool`）⇒ 真读不到
  //     ⇒ `db_read_failed_using_boot_snapshot`（运维该去看 DB）；
  //   · `fallbackReason==='no_row'`（SELECT 成功了、只是表里没有这一行）⇒ 那是**正常状态**
  //     ⇒ `no_row_using_boot_snapshot`（说成「读失败」会把运维支去查一根根本没坏的连接）。
  //   其余理由（如行在但值不可用）仍当故障族处理：不抵赖成「没配」。
  const bootSnapshot = envTier?.source === 'db' && !row;
  const bootSnapshotReason = fallbackReason === 'no_row'
    ? 'no_row_using_boot_snapshot'
    : 'db_read_failed_using_boot_snapshot';
  return withHint({
    ...base,
    value: envTier?.value,
    source: envTier?.source ?? 'default',
    reason: bootSnapshot
      ? bootSnapshotReason
      : (row ? (parsed?.reason ?? 'invalid_db_value') : (fallbackReason ?? 'no_row')),
  }, entry);
}

/**
 * `GET /api/admin/runtime-settings` 的全部内容：**永不抛**（口径 1）。
 *
 * 表不存在 / DB 挂了 / 读超时 ⇒ 仍然 200，每一项的 `source` 落在 `env`/`default` 上并带
 * `reason`（`read_failed` / `read_timeout` / `no_row` / `not_a_ttl_seconds` / `ttl_out_of_range`）。
 * 「管理页打不开」不是配置面坏了该有的后果 —— 打不开就看不到当前用的是哪一档，正是要看的时候。
 *
 * @returns {Promise<{items:Array<object>}>} 顺序 = registry 的声明顺序（稳定，界面不跳）
 */
export async function listRuntimeSettingsAdmin({
  pool, config, registry = RUNTIME_SETTING_REGISTRY, timeoutMs, env = process.env, log = console,
} = {}) {
  const keys = Object.keys(registry);
  const entries = keys.map((key) => registry[key]).filter((entry) => entry?.configPath);
  if (entries.length === 0) return { items: [] };

  let fallbackReason = 'no_pool';
  let rowByKey = new Map();
  if (pool && typeof pool.query === 'function') {
    // 读到东西了 ⇒ 回落的理由是「库里没这一行 / 这一行的值不可用」（`toSettingItem` 里逐 key 定），
    // 不再是「没有池子」。两个理由必须分开：一个是「没配」，一个是「读不到」。
    fallbackReason = 'no_row';
    const budget = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs
      : readTimeoutMs({ env, log });
    let result;
    try {
      result = await withReadTimeout(pool.query(SELECT_ADMIN_SQL), budget);
    } catch (err) {
      fallbackReason = 'read_failed';
      const detail = [err?.code, err?.message].filter(Boolean).join(' ') || '未知错误';
      // 管理页读失败要 warn（有人在屏幕前等答案，不像启动路径那样只能靠 debug）。
      log?.warn?.(`[runtime-settings] 管理台读 runtime_settings 失败（${detail}）`
        + ` ⇒ 各项回落 env/默认并如实标 source（响应仍是 200）`);
    }
    if (result === READ_TIMEOUT) {
      fallbackReason = 'read_timeout';
      log?.debug?.(`[runtime-settings] 管理台读 runtime_settings 超过 ${budget}ms 未返回`
        + ' ⇒ 各项回落 env/默认并如实标 source');
    } else if (result && Array.isArray(result.rows)) {
      for (const row of result.rows) {
        if (row && typeof row.key === 'string') rowByKey.set(row.key, row);
      }
    }
  } else {
    log?.warn?.('[runtime-settings] 管理台读没有可用的 pool ⇒ 各项回落 env/默认并如实标 source');
  }
  return {
    items: entries.map((entry) => {
      const item = toSettingItem(
        entry,
        rowByKey.get(entry.key),
        // env 那一档也要过 registry 的闸（#701 返修 LOW③）：坏 env 值 ⇒ 报 `default` + 点名 warn，
        // 不许报一个「界面显示 env 的 30、实际却不会用这个数」的假来源。
        resolveEnvTier(entry, config, { env, log }),
        fallbackReason,
      );
      // #709 MED①：报 `db` + boot snapshot 的那一档，必须在 warn 里说清手里那个数是启动时快照
      // ——运维看到 source=db 会去找库，而不是去改 env。
      // #709b LOW①：故障族与「没这一行」两条文案分开（后者不许说自已是读失败）。
      if (item.source === 'db' && item.reason === 'db_read_failed_using_boot_snapshot') {
        log?.warn?.(`[runtime-settings] ${item.key} 读不到 DB 行（${fallbackReason}）`
          + ` ⇒ 暂用启动时的 DB 快照 ${JSON.stringify(item.value)}，source 如实报 db`
          + '（不是 env；DB 恢复前改 env 不影响这个值）');
      } else if (item.source === 'db' && item.reason === 'no_row_using_boot_snapshot') {
        log?.warn?.(`[runtime-settings] ${item.key} 的 DB 查询成功、但表里没有这一行`
          + ` ⇒ 暂用启动时的 DB 快照 ${JSON.stringify(item.value)}，source 如实报 db`
          + '（不是 env；这一格还没人配过 = DB 没坏，要去改值请开管理台而不是查连接）');
      }
      return item;
    }),
  };
}

/** 保存后的 DTO：值/时间/人**只来自 `RETURNING`**（口径 4），`label`/`applyMode` 是 registry 的静态元数据。 */
function toSavedItem(entry, saved) {
  // `hint` 与 GET 同一口径（只在登记了的那格带）：保存后的那个 item 会直接替掉界面上的那一行，
  // 这里漏了它，保存完提示就消失（判据：RS-29 的 PUT 腿 + 前端视图 spec 的保存腿）。
  return withHint({
    key: saved.key,
    label: entry?.label ?? saved.key,
    value: saved.value,
    source: 'db',
    reason: null,
    applyMode: entry?.applyMode === 'hot' ? 'hot' : 'restart',
    updatedAt: saved.updatedAt ?? null,
    updatedBy: saved.updatedBy ?? null,
  }, entry);
}

/**
 * `PUT /api/admin/runtime-settings/:key` 的转发器（形状照 `platform-prompts.js#adminUpdatePrompt`：
 * **形状闸只有一份，全在这里，http 只是匹配 + 鉴权 + 转发**）。
 *
 * 返回 `{ item, previousValue }`：`item` 是给前端的 DTO，`previousValue` 只进 debug/日志，
 * 响应体里**刻意没有它**（前端不显示，而多一个字段就是多一个要维护的形状；库里与审计里都有）。
 *
 * 审计已由 `saveRuntimeSetting` 在同一个事务里写好 ⇒ **调用方不得再补 `auth.audit`**。
 */
export async function updateRuntimeSettingAdmin({
  pool, actorId = null, key, value, registry = RUNTIME_SETTING_REGISTRY, log = console,
} = {}) {
  const saved = await saveRuntimeSetting({ pool, actorId, key, value, registry, log });
  const entry = Object.hasOwn(registry, saved.key ?? key) ? registry[saved.key ?? key] : null;
  return { item: toSavedItem(entry, saved), previousValue: saved.previousValue };
}
