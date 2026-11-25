// 管理台「提示词」面板的**读侧 + 写侧**（issue #596 片 A）。
// 契约：`docs/design/admin-prompts-panel-2026-11-16.md`（§3 读侧 / §4 写侧 / §5 渲染 / §6 API / §8 判据）；
// API 文档：`docs/api/portal.md` §4.19。表：迁移 `0043-platform-prompts.sql`（单行表，`''` = 跟随内置）。
//
// 一句话：平台对 agent 说的三句话（`~/AGENTS.md` 的补充约定、`~/AGENTS.md` 的整段覆写、会话标题的
// system）从「改代码 + 重建镜像」变成「管理台改一行，下一次 run / 下一次改名生效」。
//
// 形状照 `portal/src/upload-settings.js`（迁移 0036 那一套），不发明第二套：
//   1. **优先级 DB > 内置**，读侧**永不抛、永不 500**：表不存在 / 连接拒 / 到点不返回 ⇒ 回落内置 +
//      一个可区分的 `reason ∈ no_row | read_failed | read_timeout`。配置面坏了不能让物化与改名挂掉。
//   2. **那次读取带超时**（`PLATFORM_PROMPTS_READ_TIMEOUT_MS`，默认 1500ms ⇒ `docs/env.md` §10.1）。
//      只 `catch` 不覆盖「查询发出去而**不返回**」——不返回就永远进不了 catch，而这条读取在
//      **每次物化、每次改名**的路径上（0036 复 audit 活一同一条论证，那里是「每次上传」）。
//      超时按「读不到」处理：回落内置、照常物化/改名，只留 debug 不刷 warn。
//   3. **保存 = 一条 SQL 语句**（`SAVE_SQL`：prev `FOR UPDATE` → 渲染闸 → upsert → 写审计）。
//      审计与设置必须同生共死，旧值必须来自同一语句的快照 ⇒ 调用方（`http.js`）**不得**再补
//      `auth.audit`。判据 `P8` 钉的是「**写 `platform_prompts` 的语句恰好 1 条，且它与写
//      `audit_log` 那条是同一条**」（评审 F4 第 2 项的定稿口径，**不是**「整次保存只有一条
//      `pool.query`」）：涉物化那两格实测共 **7 条** query（JS 预闸预读 1 + 保存（设置与审计）1 +
//      列启用中的 FDE 1 + 每台 2 条入队），逐条点名见 `portal/test/platform-prompts.test.js` 的
//      `P8` 与设计稿 §8 第 11 条。
//      ⚠ 谁拿旧口径（「恰好一次 `pool.query`」）去「修回一次查询」，删的就是下面
//      `updatePlatformPrompts` 里那段 **JS 预闸**（那一段 `闸一（写之前）`）：预读多付的只是
//      1 条 SELECT，而删掉它就是拿「超限也先把正文写进库里」换的。
//   4. **响应一律来自 `RETURNING`**（不信输入）：「保存成功」说的是库里现在那份文本。
//   5. **产品上限不在 DB CHECK，在这里**（分层见 0040 头注释）。两条闸：字段自身上限 +
//      **渲染后**整份 `~/AGENTS.md` ≤ `AGENTS_MD_INJECT_MAX_BYTES`。第二条是必须的：注入侧
//      （`runner/lib/agents-md.js`）超过 16 KiB 会**静默截断**只留 marker —— 不拦就是「管理员写完
//      8 KiB 追加段什么也不会发生，直到某天发现约定被切了一半」。
//   6. **`AGENTS_MD_INJECT_MAX_BYTES` 不许手抄**：它必须与 `runner/lib/agents-md.js` 导出的
//      `AGENTS_MD_MAX_FILE_BYTES` 相等，由判据 `P9` 跨包 import 两个常量对账（跨包引用先例：
//      `runner/test/system-prompt.test.js` import `portal/src/previewpool.js`）。
//      ⚠ 这条对账**在测试里**，运行时**不 import** `runner/`：portal 镜像只 `COPY portal/ portal/`
//      （`portal/Dockerfile`），运行期引一个镜像里不存在的文件 = portal 起不来。
//
// 不做（第一期，理由见 issue #596）：per-FDE 覆盖、镜像内那 4 条提示词的在线覆写、版本历史。
// ⚠ **本模块与 `materializer.js` 双向引用**（它要渲染器，我们要它的模板常量）。
//   ESM 循环引用下「对面模块的绑定」在**本模块求值期**可能还没初始化 ⇒ 跨模块的名字
//   **一律只在函数体里用**（顶层读一次就是 `ReferenceError: ... before initialization`，
//   且凡 import 这条链的文件全部连坐）。判据 `P11` 用两个子进程正反两序各加载一次钉住这件事。
import {
  renderHomeAgentsMd,
  agentsMdRenderedBytes,
  agentsMdGateRenderBudget,
  AGENTS_MD_EXAMPLE_FDE_NAME,
} from './materializer.js';
import { enqueueMaterializeChange } from './outbox.js';
import { TITLE_SYSTEM_PROMPT } from './title-llm.js';

/**
 * 注入侧对**整份** `~/AGENTS.md` 的字节上限（`runner/lib/agents-md.js` 的 `AGENTS_MD_MAX_FILE_BYTES`）。
 * ⚠ 改这里必须同时改对面，且 `P9` 会红（它跨包比这两个常量，不靠注释声明）。
 */
export const AGENTS_MD_INJECT_MAX_BYTES = 16 * 1024;

/** 追加段（`agents_md_addendum`）的写侧上限：8 KiB。`''` = 清空 = 不追加那一节。 */
export const ADDENDUM_MAX_BYTES = 8192;

/** 整段覆写（`agents_md_override`）的写侧上限：16 KiB（与注入上限同数 ⇒ 覆写文自己先装得下）。 */
export const OVERRIDE_MAX_BYTES = 16 * 1024;

/** 标题提示词（`title_prompt`）的写侧上限：2000 字节（它是 system 提示，超这个数就该改代码不是改文案）。 */
export const TITLE_PROMPT_MAX_BYTES = 2000;

/**
 * 读超时默认值与旋钮名（`docs/env.md` §10.1 已登记）。
 *
 * ⚠ **只接受严格十进制正整数字面量**（`POSITIVE_INT_RE`），**不许** `Number(raw)` 了事：
 * `Number('1e3')` 是 1000、`Number(' 12 ')` 是 12、`Number('0x10')` 是 16 —— 那些写法在 YAML /
 * compose / shell 里都能混进门，于是「设了个东西，行为变了，但没人能说清它到底算出了多少」。
 *  那一族（env 解析把非严格写法静默半成功）在这里同样适用 ⇒ 不认的写法一律
 * **默认值 + 一条 warn**（不抛：配置面不许把服务弄挂），优先级 DB > 内置也不因此改变。
 */
export const DEFAULT_READ_TIMEOUT_MS = 1500;
export const READ_TIMEOUT_ENV_VAR = 'PLATFORM_PROMPTS_READ_TIMEOUT_MS';

/** env 里「正整数」的唯一可接受写法：十进制数字串（`''` 先前已当「没配」处理）。 */
const POSITIVE_INT_RE = /^[0-9]+$/;

/** 审计：`action` / `target` 与 `docs/api/portal.md` §4.19-4 登记的必须一致（改这里就要改文档）。 */
export const AUDIT_ACTION = 'admin.platform_prompts_updated';
export const AUDIT_TARGET = 'platform_prompts';

// 管理台展示与写侧渲染闸共用的固定示例工位名 **就是** `materializer.js` 的 `AGENTS_MD_EXAMPLE_FDE_NAME`。
// 本模块**不再建顶层别名**（旧写法 `export const EXAMPLE_FDE_NAME = AGENTS_MD_EXAMPLE_FDE_NAME` 在
// **本模块求值期**去读对面的绑定，而两边互相 import ⇒ TDZ，`ReferenceError: … before initialization`，
// 凡 import 这条链的测试文件全部连坐）。名字只有 materializer 一份 ⇒ 无第二份真相可漂；要用就在
// 函数体里直接引用 import 绑定（判据 `P11` 钉住「两种加载顺序都不许抛」）。

/**
 * 三块的字段表（**唯一一处**登记「列名 ↔ 上限 ↔ 是否参与渲染/物化」）。
 * `key` 是 DTO / 路由用的 camelCase 名，`column` 是 DB 列名（也进审计的 `details.field`）。
 */
export const PROMPT_FIELDS = {
  addendum: {
    key: 'addendum', column: 'agents_md_addendum', maxBytes: ADDENDUM_MAX_BYTES,
    renders: true, materialize: true,
  },
  agentsMd: {
    key: 'agentsMd', column: 'agents_md_override', maxBytes: OVERRIDE_MAX_BYTES,
    renders: true, materialize: true,
  },
  titlePrompt: {
    key: 'titlePrompt', column: 'title_prompt', maxBytes: TITLE_PROMPT_MAX_BYTES,
    renders: false, materialize: false,
  },
};

/** 只读清单（第一期不开放在线覆写的那 4 条，见契约 §1）。只给 `key`，中文说明在前端 i18n。 */
export const READONLY_PROMPT_KEYS = [
  'runnerSystemPrompt',
  'childSystemPrompt',
  'toolDescriptions',
  'engineNotices',
];

/** 校验/状态类错误：`httpStatus` + `details`（`http.js` 的映射按此透传；**不新增错误码**）。 */
export class PlatformPromptsError extends Error {
  constructor(code, message, { httpStatus = 400, details } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

function fail(field, message, details) {
  throw new PlatformPromptsError('validation_failed', message, {
    httpStatus: 400,
    details: { field, ...details },
  });
}

function isoOrNull(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function utf8Bytes(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/**
 * 每次调用都现读 env（测试要能在运行中改；也让 `readTimeoutMs` 可单独单测）。
 * 非法形状（`1e3` / `+5` / `' 800 '` / `0` / `-5` / `1500.5` / `Infinity` / `NaN`）⇒ 默认 + warn（判据 `P2b`）。
 */
export function readTimeoutMs({ env = process.env, log = console } = {}) {
  const raw = env?.[READ_TIMEOUT_ENV_VAR];
  if (raw === undefined || raw === '') return DEFAULT_READ_TIMEOUT_MS;
  // 先查写法再取值：`Number.isSafeInteger(Number('1e3'))` 是 true，所以上面那条正则**不能省**。
  const parsed = POSITIVE_INT_RE.test(String(raw)) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    log?.warn?.(
      `[platform-prompts] ${READ_TIMEOUT_ENV_VAR}=${JSON.stringify(raw)}`
      + ` 不是严格十进制正整数 ⇒ 用默认 ${DEFAULT_READ_TIMEOUT_MS}ms`
      + '（只影响等多久算「读不到」，不改优先级 DB > 内置）',
    );
    return DEFAULT_READ_TIMEOUT_MS;
  }
  return parsed;
}

/**
 * 超时哨兵：与「驱动抛错」**分开**（`reason` 不同：`read_timeout` / `read_failed`；要不要 warn 也不同：
 * 抛错是运维故障值得 warn，超时是这条路径的常态兜底，只留 debug —— 一个慢 DB 不该把日志刷满）。
 */
const READ_TIMEOUT = Symbol('platform-prompts-read-timeout');

/**
 * 给一次查询套上截止时间。**只有 race，没有 cancel**（node-pg 没有「中断一条已发出的查询」的 API，
 * 口径同 `upload-settings.js`）。定时器**不 `unref()`**：它是「读不到也要按时给答案」的唯一保证。
 */
function withReadTimeout(queryPromise, timeoutMs) {
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(READ_TIMEOUT), timeoutMs);
  });
  return Promise.race([Promise.resolve(queryPromise), deadline])
    .finally(() => { if (timer) clearTimeout(timer); });
}

const SELECT_SQL = 'SELECT agents_md_addendum, agents_md_override, title_prompt, updated_at, updated_by'
  + ' FROM platform_prompts WHERE id = 1';

/**
 * 「启用中的 FDE」= 会被物化的那一集（与 `materializer.js#rebuildAllFdes` **同一条谓词**：
 * `active` + `awaiting_credential`，`disabled`/已销号跳过）。两处不同口径就会长出「全量重建会覆盖它、
 * 而保存提示词不会」这种要人记住的差别，而人不记。
 */
const ACTIVE_FDE_SQL = `SELECT id FROM users
   WHERE fde_name IS NOT NULL AND status IN ('active', 'awaiting_credential')
   ORDER BY id`;

/**
 * 保存 = **一条**语句做完四件事：锁旧行 → 算下一份 → 渲染闸 + upsert → 写审计。
 *
 * 为什么必须是一条（照 0036 的 `SAVE_SQL`）：`SELECT` → `UPSERT` → `auth.audit()` 三个 await 之间谁都可能
 * 插进来 —— 并发保存会把审计的 `previous_*` 记成「自己进来之前」的数；审计 `INSERT` 失败就是
 * 「设置已生效而审计一行没有」。一条语句 = 语句级原子 + 旧值是本语句快照（带 `FOR UPDATE` 行锁）。
 *
 * 渲染闸**也在这条语句里**（`gate` 那个 CTE）：闸要看的「另一列的当前值」（存追加段时看覆写列，
 * 存覆写时看追加列）只有本语句的快照能给；先在 JS 里 `SELECT` 一次再写就变成两条语句，
 * 既退回并发窗口，也让 `P8`（恰好一次 `pool.query`）不成立。超限 ⇒ 喂给 `INSERT` 的 `SELECT` 出 0 行
 * ⇒ **一格没写、审计零行**（`aud` 从 `upd` 取行，`upd` 空就什么都不写），JS 侧据 `written = 0` 报 400。
 *
 * 算术与 `materializer.js` 的真渲染等价（判据 `P6b` 逐组钉住）：常量由 JS 当**参数**送进来
 * （`$4/$5/$6` ⇒ 上限常量仍然只有 JS 一处，SQL 里不抄数字，口径同 0036 的 `$5/$6`）。
 *
 * 参数：`$1` 列名 `$2` 新文本 `$3` actor `$4` 模板字节 `$5` 追加段开销 `$6` 标识行尾部
 * `$7` 渲染上限 `$8` 审计 action `$9` 审计 target。
 *
 * ⚠ `$4/$5/$6` 送的是**最坏情况预算**（`agentsMdGateRenderBudget()`，评审 F2）：标识行按最长合法
 *   工位名算，不是按示例名。导出来是给真库集成脚本直接跑一遍那段算术（`P6b` 的 SQL 那半边）。
 */
export const SAVE_SQL = `WITH snap AS (
   SELECT agents_md_addendum, agents_md_override, title_prompt
     FROM platform_prompts
    WHERE id = 1
      FOR UPDATE
 ), nxt AS (
   SELECT CASE WHEN $1 = 'agents_md_addendum' THEN $2::text
               ELSE COALESCE(s.agents_md_addendum, '') END AS addendum,
          CASE WHEN $1 = 'agents_md_override' THEN $2::text
               ELSE COALESCE(s.agents_md_override, '') END AS override,
          CASE WHEN $1 = 'title_prompt' THEN $2::text
               ELSE COALESCE(s.title_prompt, '') END AS title_prompt,
          CASE WHEN $1 = 'agents_md_addendum' THEN COALESCE(s.agents_md_addendum, '')
               WHEN $1 = 'agents_md_override' THEN COALESCE(s.agents_md_override, '')
               ELSE COALESCE(s.title_prompt, '') END AS prev_text
     FROM (SELECT 1 AS one) AS d LEFT JOIN snap AS s ON TRUE
 ), gate AS (
   SELECT nxt.*,
          CASE WHEN $1 = 'title_prompt' THEN 0::bigint
               ELSE (CASE WHEN nxt.override <> '' THEN octet_length(nxt.override) ELSE $4::bigint END)
                    + (CASE WHEN nxt.addendum <> '' THEN $5::bigint + octet_length(nxt.addendum) ELSE 0::bigint END)
                    + $6::bigint
          END AS rendered_bytes
     FROM nxt
 ), upd AS (
   INSERT INTO platform_prompts (id, agents_md_addendum, agents_md_override, title_prompt, updated_at, updated_by)
   SELECT 1, addendum, override, title_prompt, now(), $3::uuid
     FROM gate
    WHERE rendered_bytes <= $7::bigint
   ON CONFLICT (id) DO UPDATE
      SET agents_md_addendum = EXCLUDED.agents_md_addendum,
          agents_md_override = EXCLUDED.agents_md_override,
          title_prompt       = EXCLUDED.title_prompt,
          updated_at         = now(),
          updated_by         = EXCLUDED.updated_by
   RETURNING agents_md_addendum, agents_md_override, title_prompt, updated_at, updated_by
 ), aud AS (
   INSERT INTO audit_log (actor_id, action, target, details)
   SELECT $3::uuid, $8::text, $9::text, jsonb_build_object(
            'field', $1::text,
            'text_bytes', octet_length($2::text),
            'text_sha256', encode(sha256(convert_to($2::text, 'UTF8')), 'hex'),
            'previous_bytes', octet_length(gate.prev_text),
            'previous_sha256', encode(sha256(convert_to(gate.prev_text, 'UTF8')), 'hex'))
     FROM upd, gate
   RETURNING 1 AS audit_row
 )
SELECT (SELECT count(*) FROM upd)::int AS written,
       gate.rendered_bytes::int AS rendered_bytes,
       (SELECT count(*) FROM aud)::int AS audit_rows,
       gate.prev_text,
       upd.agents_md_addendum, upd.agents_md_override, upd.title_prompt,
       upd.updated_at, upd.updated_by
  FROM gate LEFT JOIN upd ON TRUE`;

/**
 * 从「已读到的行」算生效值（纯函数，不含 IO ⇒ 单测直接钉优先级，判据 `P1`/`P2`）。
 *
 * 读侧**不做长度校验**（与 0036 的 `parseDbMaxFileBytes` 刻意不同）：三列是自由文本，
 * 「手工 `UPDATE` 进来的超长值」必须**照常工作**（契约 §2），超长那一档的后果（注入侧截断）由
 * 写侧闸与文档负责，不是读侧偷偷把值换成内置 —— 那会让管理台显示的和实际生效的对不上。
 *
 * @returns {{addendum:string, override:string, titlePrompt:string, source:'db'|'builtin', reason:string|null}}
 */
export function resolveFromRow(row, { readError = null, timedOut = false } = {}) {
  if (row && !readError && !timedOut) {
    // `NOT NULL DEFAULT ''` ⇒ NULL 只可能是 schema 漂了；当「跟随内置」处理，不猜也不抛。
    const text = (v) => (typeof v === 'string' ? v : '');
    return {
      addendum: text(row.agents_md_addendum),
      override: text(row.agents_md_override),
      titlePrompt: text(row.title_prompt),
      source: 'db',
      reason: null,
    };
  }
  // 超时排在 `no_row` 前面：到点没回时 `row` 也是 `null`，报 `no_row` 就是把「DB 卡住」说成
  // 「管理台还没配过」（运维会去配一个值，而真故障在连接上）。
  const reason = timedOut ? 'read_timeout' : readError ? 'read_failed' : 'no_row';
  return { addendum: '', override: '', titlePrompt: '', source: 'builtin', reason };
}

/**
 * 读 DB 一行；**永不抛、永不挂**（两层兜底缺一不可：`catch` 管抛错，超时管不返回）。
 * @returns {Promise<{row: object|null, error: string|null, timedOut: boolean}>}
 */
export async function readRow({ pool, log = console, timeoutMs = readTimeoutMs({ log }) } = {}) {
  let result;
  try {
    result = await withReadTimeout(pool.query(SELECT_SQL), timeoutMs);
  } catch (err) {
    log?.warn?.(
      '[platform-prompts] 读 platform_prompts 失败，回落内置提示词（物化与改名照常，不会 500）：'
      + `${err?.message ?? err}`,
    );
    return { row: null, error: err?.code ?? err?.message ?? 'read_failed' };
  }
  if (result === READ_TIMEOUT) {
    log?.debug?.(
      `[platform-prompts] 读 platform_prompts 超过 ${timeoutMs}ms 未返回，按读不到处理`
      + '（回落内置提示词；物化与改名照常）',
    );
    return { row: null, error: 'read_timeout', timedOut: true };
  }
  return { row: result?.rows?.[0] ?? null };
}

/** 读一次并解析（三个入口共用；每次现读、无缓存 ⇒ 管理台改完下一次就生效）。 */
async function loadResolved({ pool, log, timeoutMs } = {}) {
  const { row, error, timedOut } = await readRow({ pool, log, timeoutMs });
  return { resolved: resolveFromRow(row, { readError: error, timedOut }), row };
}

/**
 * materializer 用：该工位这一份 `~/AGENTS.md` 的**生效文本**与它的两个输入。
 * 返回 `addendum` / `override` 是给 `buildFilePlan()` 传的（渲染本身由 `materializer.js` 做，
 * 它才是模板的真相源；`text` 是同一份渲染的结果，给 DTO / 单测 / 排障看）。
 */
export async function resolveEffectiveAgentsMd({
  pool, fdeName = AGENTS_MD_EXAMPLE_FDE_NAME, log, timeoutMs,
} = {}) {
  const { resolved } = await loadResolved({ pool, log, timeoutMs });
  return {
    ...resolved,
    fdeName,
    text: renderHomeAgentsMd({ fdeName, addendum: resolved.addendum, override: resolved.override }),
  };
}

/**
 * 改名链路用：**下一次改名**就吃到新值（每次现读、无缓存）。
 * `''` = 用内置 `TITLE_SYSTEM_PROMPT` ⇒ `text` 直接给成内置值，调用方只管把它当 system 发出去
 * （提示词**不是守卫**：落库前仍然 `sanitizeTitle`，那条口径在本单零改动）。
 */
export async function resolveEffectiveTitlePrompt({ pool, log, timeoutMs } = {}) {
  const { resolved } = await loadResolved({ pool, log, timeoutMs });
  const isDefault = resolved.titlePrompt === '';
  return {
    source: resolved.source,
    reason: resolved.reason,
    isDefault,
    text: isDefault ? TITLE_SYSTEM_PROMPT : resolved.titlePrompt,
  };
}

/** 管理台 DTO（契约 §6 那个形状；键名 camelCase）。`reason` 是 additive 的排障位。 */
export function toPlatformPromptsDto({ resolved, row = null }) {
  // ★ `__budget` 是**写侧闸要用那份**（标识行按最长合法工位名），不是下面预览那一份：
  //   单测要钉的是「送进 SQL 的常量是哪一份」，拿预览那份当 `__budget` 就把这件事自证了。
  const budget = agentsMdGateRenderBudget();
  // 下面三份文本/字节是**给人看的预览** ⇒ 用示例名 `example`（契约 §6）；与写侧闸用哪份预算是两件事。
  const effectiveText = renderHomeAgentsMd({
    fdeName: AGENTS_MD_EXAMPLE_FDE_NAME, addendum: resolved.addendum, override: resolved.override,
  });
  const templateText = renderHomeAgentsMd({ fdeName: AGENTS_MD_EXAMPLE_FDE_NAME });
  return {
    addendum: {
      text: resolved.addendum,
      isDefault: resolved.addendum === '',
      maxBytes: ADDENDUM_MAX_BYTES,
      bytes: utf8Bytes(resolved.addendum),
    },
    agentsMd: {
      override: resolved.override,
      isOverridden: resolved.override !== '',
      isDefault: resolved.override === '',
      // 两者都是「按固定示例名渲染的整份文件字节数」：默认态下逐数相同，覆写/追加后差值就是净变化。
      templateBytes: utf8Bytes(templateText),
      effectiveBytes: utf8Bytes(effectiveText),
      effectiveText,
      maxBytes: OVERRIDE_MAX_BYTES,
      renderedLimitBytes: AGENTS_MD_INJECT_MAX_BYTES,
    },
    titlePrompt: {
      text: resolved.titlePrompt,
      isDefault: resolved.titlePrompt === '',
      defaultText: TITLE_SYSTEM_PROMPT,
      maxBytes: TITLE_PROMPT_MAX_BYTES,
      bytes: utf8Bytes(resolved.titlePrompt),
    },
    readonly: READONLY_PROMPT_KEYS.map((key) => ({ key })),
    // ⚙ 「从未保存过」的定义是**没有写者**（`updated_by IS NULL`），不是「表里没有那一行」：
    //   0040 会 `INSERT … ON CONFLICT DO NOTHING` 种下 `id = 1`，而那一行的 `updated_at` 吃的是
    //   `timestamptz NOT NULL DEFAULT now()` ⇒ 全新库上它**永远非 null**（那个值是「迁移跑过的
    //   那一刻」）。只看 `updated_at` 就等于让界面宣称一个管理员从没做过的「最后保存」（评审 R3）。
    //   不在迁移里动 `updated_at`（那会牵动已部署库），只在 DTO 这一侧把两个字段归成同一个口径。
    //   判据 `P14`：有行但 `updated_by` 为 NULL ⇒ 两个字段都 `null`；`updated_by` 非空 ⇒ 都出真值。
    updatedAt: isoOrNull(row?.updated_by == null ? null : row.updated_at ?? null),
    updatedBy: row?.updated_by ?? null,
    reason: resolved.reason ?? null,
    __budget: budget, // 不参与响应（`buildDtoForResponse` 会剔掉）；就是写侧闸要送进 SQL 的那份算术
  };
}

/** 去掉内部键后的响应 DTO（`GET /api/admin/prompts` 的体；也是 `PUT` 响应里 `prompts` 那一份）。 */
export function toResponseDto(dto) {
  const { __budget, ...rest } = dto;
  return rest;
}

/** `GET /api/admin/prompts`。表不存在 / 读失败也回 200（配置面坏了不该让这一页白屏）。 */
export async function getPlatformPrompts({ pool, log = console } = {}) {
  const { resolved, row } = await loadResolved({ pool, log });
  return toResponseDto(toPlatformPromptsDto({ resolved, row }));
}

/**
 * 请求体必须是一个 JSON **对象**（`'"just a string"'` / `42` / `[]` / `null` 都不是一份配置）。
 * 导出来给 `http.js` 用：那里拿到的是解析后的原始 body，形状闸在这里才能只有一份
 * （判据 `P7b`：`details.field` 必须是 `body` 而不是 `text`——「你发的不是一份请求体」与
 * 「请求体里 `text` 那一格不对」是两件事，得在错误里分开）。
 */
export function assertJsonObjectBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    fail('body', '请求体必须是对象');
  }
  return body;
}

/** 校验：字段名 + `text` 必须是**字符串**（`''` 合法 = 清空 / 跟随内置）+ 自身字节上限。 */
function cleanTextField(fieldKey, body) {
  const spec = PROMPT_FIELDS[fieldKey];
  if (!spec) fail('field', `未知字段：${String(fieldKey)}（只支持 addendum / agentsMd / titlePrompt）`);
  assertJsonObjectBody(body);
  const value = body.text;
  if (value === undefined || value === null) {
    fail('text', 'text 是必填字段（字符串，`""` = 跟随内置）', { max_bytes: spec.maxBytes });
  }
  if (typeof value !== 'string') {
    fail('text', 'text 必须是字符串（不接受数字 / 对象 / null）', { max_bytes: spec.maxBytes });
  }
  const bytes = utf8Bytes(value);
  if (bytes > spec.maxBytes) {
    fail('text', `text 超过上限 ${spec.maxBytes} 字节（本次 ${bytes}）`, { max_bytes: spec.maxBytes });
  }
  return value;
}

/**
 * 渲染超限那一档的 `details`（**只有一处**拼这个形状：JS 预闸与 SQL 闸共用 ⇒ 两条路报出的错逐字同形）。
 * 契约 §6：`details = {field, max_bytes}`，渲染超限再带 `{rendered_bytes, render_limit_bytes}`。
 */
function renderLimitDetails(spec, renderedBytes) {
  return {
    max_bytes: spec.maxBytes,
    rendered_bytes: renderedBytes,
    render_limit_bytes: AGENTS_MD_INJECT_MAX_BYTES,
  };
}

/**
 * 落库**之前**的渲染硬闸（判据 `P6`）：先算「这一笔写下去之后整份 `~/AGENTS.md` 到底多大」，
 * 超限就当场 400，**一条写语句都不发**（fake pool 里 `INSERT INTO platform_prompts` 计数为 0）。
 *
 * 为什么 JS 里再来一次（SQL 里那道 `WHERE rendered_bytes <= $7` 已经拦得住）：
 *   * 语义上「拒了就是没写」——只靠 SQL 闸时客户端已经发了一条写语句（虽然 0 行），
 *     「超限不落库」这件事就变成要看事务脸色；JS 预闸把它变成**根本没动过库**。
 *   * 报错要能给出 `rendered_bytes` 这个**确定值**：预闸拿的是「本次新值 + 对面那一列的当前值」，
 *     与 `materializer` 真渲染逐字节同口径（判据 `P6b`）。
 *   * SQL 那道**仍然是真相**：预闸的读与写是两条语句，中间别人可以改对面那一列（TOCTOU），
 *     那时仍是 SQL 闸把住（返回 `written = 0` ⇒ 同一个 400）。⇒ 两道闸不是冗余，一道图「没动过库」，
 *     一道图「并发下也不越线」。
 * 读不到（表不存在 / 无行 / 超时）⇒ 两列都当 `''`，不拦也不抛 ⇒ 交给 SQL 闸与后面的保存流程。
 */
async function renderedBytesIfSaved({ pool, spec, value, budget, log }) {
  const { row } = await readRow({ pool, log });
  const text = (v) => (typeof v === 'string' ? v : '');
  const addendum = spec.column === 'agents_md_addendum' ? value : text(row?.agents_md_addendum);
  const override = spec.column === 'agents_md_override' ? value : text(row?.agents_md_override);
  return agentsMdRenderedBytes(budget, { addendum, override });
}

/**
 * 保存之后给**全部启用中的 FDE** 入队重物化（op `upsert`）。
 * 不做「设置 + 入队」的原子性：设置本身就是真相，入队失败只是「下一次 portal 重启的全量重建才收敛」
 * ⇒ 必须 catch + warn，把条数回给前端（`materializeEnqueued = 0` 时页面要说「已保存，但物化未通知」）。
 * @returns {Promise<number>} 实际入队条数（抛错的那条不计入，不向上抛）
 */
export async function enqueueMaterializeForAllFdes({ pool, log = console } = {}) {
  let ids = [];
  try {
    const r = await pool.query(ACTIVE_FDE_SQL);
    ids = (r?.rows ?? []).map((row) => row.id).filter((id) => id != null);
  } catch (err) {
    log?.warn?.(
      `[platform-prompts] 列出启用中的 FDE 失败 ⇒ 本次不通知物化（已保存，下一次 portal 重启的全量重建才收敛）：`
      + `${err?.message ?? err}`,
    );
    return 0;
  }
  let enqueued = 0;
  for (const id of ids) {
    try {
      await enqueueMaterializeChange(pool, { fdeId: id, op: 'upsert' });
      enqueued += 1;
    } catch (err) {
      log?.warn?.(
        `[platform-prompts] 入队重物化失败 fde=${id}（已保存，该工位要等全量重建才收敛）：${err?.message ?? err}`,
      );
    }
  }
  return enqueued;
}

/**
 * `PUT /api/admin/prompts/{addendum,agents-md,title-prompt}` 的写侧。
 *
 * @param {object} opts `{ pool, field, text, actorId, log }`（`field` = DTO 键名）
 * @returns {Promise<{prompts:object, materializeEnqueued:number, renderedBytes:number}>}
 * @throws {PlatformPromptsError} `400 validation_failed`（形状/越界/渲染超限，**都不落库**）
 *   / `500 internal`（写了却没审计 = 有人把 `aud` 改成可跳过的形状）。
 */
export async function updatePlatformPrompts({ pool, field, text, actorId = null, log = console } = {}) {
  const spec = PROMPT_FIELDS[field];
  if (!spec) fail('field', `未知字段：${String(field)}（只支持 addendum / agentsMd / titlePrompt）`);
  const value = cleanTextField(field, { text });
  // ★ 写侧闸按**最坏情况**算（评审 F2）：标识行取最长合法工位名（长度从 `FDE_NAME_RE` 导出），
  //   不是 DTO 预览那个 `example`——否则 8192 这个字段上限会放过「示例名装得下、真工位名装不下」
  //   那一档输入，而超那一档的后果是注入侧静默截断（写侧闸存在的全部理由）。
  //   DTO 的 `effectiveText`/`templateBytes` 仍然按 `example` 渲染（那是预览，契约 §6）。
  const budget = agentsMdGateRenderBudget();
  // 闸一（JS 预闸，**写之前**）：只有参与渲染的两格需要（`title_prompt` 不进 `AGENTS.md` ⇒ 不多一次读）。
  if (spec.renders) {
    const preRendered = await renderedBytesIfSaved({ pool, spec, value, budget, log });
    if (preRendered > AGENTS_MD_INJECT_MAX_BYTES) {
      fail('text',
        `渲染后的整份 ~/AGENTS.md 超过注入上限 ${AGENTS_MD_INJECT_MAX_BYTES} 字节`
        + `（本次 ${preRendered}）`
        + '——追加段/覆写文会与内置模板争这 16 KiB，超限会被注入侧静默截断'
        + '（已拒，**未写库**）',
        renderLimitDetails(spec, preRendered));
    }
  }
  let row;
  try {
    const written = await pool.query(SAVE_SQL, [
      spec.column, value, actorId,
      budget.templateBytes, budget.addendumOverheadBytes, budget.identityTailBytes,
      AGENTS_MD_INJECT_MAX_BYTES,
      AUDIT_ACTION, AUDIT_TARGET,
    ]);
    row = written?.rows?.[0] ?? null;
  } catch (err) {
    // 假 pool 的形状闸 / 真库的约束冲突都从这里出去：不静默当「保存成功」。
    // ⚠ 发给客户端的 message 一律是**静态串**（先例：`upload-settings.js` 那两条 `internal`）。
    //   `http.js` 把 `err.message` 原样 `sendJson` 出去，而驱动原文长这样：
    //   `insert or update on table "platform_prompts" violates check constraint "…"` ⇒ 拼进去
    //   就是把表名 / 列名 / 约束名直接送到浏览器（评审 R6）。细节只进服务端日志，且日志也
    //   **不打整条 SQL 与参数值** —— 参数里就是管理员写的正文，可能含用户内容。
    log?.warn?.('platform_prompts 保存失败（响应体是静态文案，原因只在日志）：%s',
      String(err?.message ?? err).slice(0, 300));
    throw new PlatformPromptsError('internal', '保存提示词失败（数据库拒了这条语句，原因见 portal 日志）', {
      httpStatus: 500,
    });
  }
  const renderedBytes = Number(row?.rendered_bytes ?? 0);
  if (Number(row?.written) !== 1) {
    // 闸二（SQL 闸）：预闸之后、写入之前对面那一列被人改了（TOCTOU）⇒ 那条语句**一格没写**
    // （喂给 INSERT 的 SELECT 出 0 行），审计也是 0 行。报的错误与预闸逐字同形。
    fail('text',
      `渲染后的整份 ~/AGENTS.md 超过注入上限 ${AGENTS_MD_INJECT_MAX_BYTES} 字节（本次 ${renderedBytes}）`
      + '——追加段/覆写文会与内置模板争这 16 KiB，超限会被注入侧静默截断',
      renderLimitDetails(spec, renderedBytes));
  }
  if (Number(row?.audit_rows) !== 1) {
    // 理论上到不了：`aud` 与 `upd` 在同一条语句里同生共死。留着是因为它正是这条语句存在的理由。
    throw new PlatformPromptsError('internal', `保存成功但审计写了 ${row?.audit_rows ?? 0} 行`, { httpStatus: 500 });
  }
  const resolved = resolveFromRow({
    agents_md_addendum: row.agents_md_addendum,
    agents_md_override: row.agents_md_override,
    title_prompt: row.title_prompt,
  }, {});
  const dto = toResponseDto(toPlatformPromptsDto({ resolved, row }));
  // `title-prompt` 不涉物化 ⇒ 不入队（`materializeEnqueued` 恒 0，键仍在：前端只有一套形状）。
  const materializeEnqueued = spec.materialize
    ? await enqueueMaterializeForAllFdes({ pool, log })
    : 0;
  return { prompts: dto, materializeEnqueued, renderedBytes };
}
