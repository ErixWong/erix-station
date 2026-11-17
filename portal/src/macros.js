// 事件平台 W1 数据层（issue #524，迁移 `deploy/migrations/0035-macro-platform.sql`）。
//
// 一句话：把「机器事件 ⇒ 自动跑一次宏」拆成三张表的读写通路——
//   `macro_templates`（做什么）/ `macro_assignments`（给谁做、在哪个范围、到什么时候）
//   / `macro_runs`（做没做、结果如何）。
// W1 **只有数据层**：没有定时器、没有调度器、没有面板路由。到期翻转是「读写时顺手算」，
// 到点主动执行是 W2；通知落地面是 W3。
//
// 三条硬语义（本单的验收重点，改动前先读）：
//   ① **认领是 `INSERT … ON CONFLICT DO NOTHING RETURNING id`**（`claimMacroRun`）——
//      不是「先 SELECT 再 INSERT」。后者在两个调度器并发时都会 SELECT 到「还没有」，
//      然后各插一行、各跑一遍：幂等键 `(assignment_id, anchor, criterion, bucket)` 就成了装饰。
//      返回 `null` 就是「这一枪别人已经开过了」，调用方必须当**正常情况**处理（不是异常）。
//      ⚠ **幂等键里不许出现生命周期列（`status`）**：一条账 `pending → running → done` 之后
//      键位就空出来，同一个触发能被再次 claim ⇒ 幂等失效。所以「哪条判据叫起来的」（`criterion`，
//      写完不变）与「这一次跑到哪了」（`status`，会推进）必须是两列、各司其职。
//   ② **模板删除是三分支**（`07-surfaces-and-panel.md` §2.3，实现见 `deleteTemplate`）：
//      零引用 ⇒ 物理删；只有订阅、无执行记录 ⇒ 物理删 + 级联删订阅；
//      有 `macro_runs` 或 `notifications` ⇒ **只能软删**（写 `deleted_at`）。
//      「能不能物理删」是**引用计数**决定的，不是请求方决定的 ⇒ 判定必须贴着写、在同一事务里，
//      否则「刚被跑了一次」和「管理员点了删除」会互相吃掉。
//   ③ **`until` 到期 ⇒ `enabled = false`**，判定一律按**时刻**比（`timestamptz` 与 JS `Date`
//      都是瞬时值，不受会话时区影响；见 `isAssignmentExpired`）。本单**不做定时器**：
//      到期在读写两侧顺手收敛（`applyExpiredAssignments`），W2 的 tick 只是把它变成主动。
//
// 依赖方向：本文件只依赖 `pg`（经 `db.js` 的池）——不 import `sessions.js` / `internal.js`，
// 所以 W2 的调度器与 W3 的面板都能直接用它而不会绕出循环依赖。
// 风格照 `portal/src/queued-inputs.js`：导出函数 + 参数对象 + 明确错误类 + `deps` 注入缝。

// ── 枚举单一真源（issue #528 / 契约 `10` 篇 §1）────────────────────────────────
// 取值住在 `portal/shared/macro-kinds.js`（前后端共用，纯 ESM 零依赖），本文件只做
// **re-export**：导出名一个不改（W2 调度器 / W3 面板 / W4b / W7 都在 import 它们）。
// ⚠ 本文件里**不许再出现枚举字面量数组**——防漂移测试
// `portal/test/macro-kinds-single-source.test.js` 会红。
import {
  KINDS, AUDIENCES, SCOPES, KIND_SCOPE, KIND_SCHEMA,
  STATUS, TERMINAL_STATUSES, CRITERION, SKIPPED_REASON, VERDICT,
  DURATION_RE, TIME_RE, QUIET_WINDOW_RE,
} from '../shared/macro-kinds.js';

/** 模板 kinds（单一真源：`shared/macro-kinds.js` 的 `KINDS`）。 */
export const MACRO_KINDS = KINDS;
/** 可见范围：`all` 全员可订阅，`admin` 仅管理员（鉴权在调用方，本模块只做形状校验）。 */
export const MACRO_AUDIENCES = AUDIENCES;
/** 订阅范围：`session` 必须带 `session_id`，`user` 必须不带（口径见 `assignTemplate`）。 */
export const MACRO_SCOPES = SCOPES;

export { KIND_SCOPE, KIND_SCHEMA };

/**
 * 按 kind 的 schema 校验 params 的形状。不合法一律 `MacroError`。
 *
 * ⚠ **返回值是「补完默认值后的 params」**（issue #625），不是 `true`：
 *   - `required` 且缺 ⇒ `MacroError('validation_failed')`（以前是 `continue` ⇒
 *     能建出没有 `at` 的 `scheduled-task`：永不触发、静默死）；
 *   - `default` 且缺 ⇒ **在这里补上**（服务端补，不只前端补 ⇒ API 直连也拿到默认值），
 *     补完的值**一并校验**（防契约里的默认值自己越界）。
 *   ⇒ **调用点必须把返回值写库**（`createTemplate` / `updateTemplate`），否则补了也丢。
 * @returns {Record<string, unknown>} 原字段 + 补齐的默认值（不原地改传入对象）
 */
export function validateKindParams(kind, params) {
  const schema = KIND_SCHEMA[kind];
  if (!schema) throw new MacroError('validation_failed', `未知 kind: ${kind}`, { details: { field: 'kind' } });
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new MacroError('validation_failed', 'params 必须是对象', { details: { field: 'params' } });
  }
  for (const key of Object.keys(params)) {
    if (!(key in schema)) {
      throw new MacroError('validation_failed', `${kind} 不认识参数 ${key}`, { details: { field: `params.${key}` } });
    }
  }
  const filled = { ...params };
  for (const [key, rule] of Object.entries(schema)) {
    let value = filled[key];
    if (value === undefined) {
      if (rule.required) {
        throw new MacroError('validation_failed', `${kind} 缺少必填参数 ${key}`, { details: { field: `params.${key}` } });
      }
      if (!('default' in rule)) continue;
      // 数组默认值必须**拷一份**：否则调用方一 `push`/`sort` 就改到了共享的 schema 常量上。
      value = Array.isArray(rule.default) ? [...rule.default] : rule.default;
      filled[key] = value;
    }
    const where = { field: `params.${key}` };
    if (rule.type === 'enum') {
      if (!rule.values.includes(value)) {
        throw new MacroError('validation_failed', `${key} 取值必须是 ${rule.values.join('/')}`, { details: where });
      }
    } else if (rule.type === 'enum[]') {
      if (!Array.isArray(value) || value.some((v) => !rule.values.includes(v))) {
        throw new MacroError('validation_failed', `${key} 必须是 ${rule.values.join('/')} 的子集`, { details: where });
      }
    } else if (rule.type === 'int') {
      if (!Number.isInteger(value)) throw new MacroError('validation_failed', `${key} 必须是整数`, { details: where });
      if (rule.values && !rule.values.includes(value)) {
        throw new MacroError('validation_failed', `${key} 只能是 ${rule.values.join('/')}`, { details: where });
      }
      if (rule.min !== undefined && value < rule.min) throw new MacroError('validation_failed', `${key} < ${rule.min}`, { details: where });
      if (rule.max !== undefined && value > rule.max) throw new MacroError('validation_failed', `${key} > ${rule.max}`, { details: where });
    } else if (rule.type === 'duration') {
      if (typeof value !== 'string' || !DURATION_RE.test(value)) {
        throw new MacroError('validation_failed', `${key} 必须是 Ns/Nm/Nh 形态`, { details: where });
      }
    } else if (rule.type === 'time') {
      if (typeof value !== 'string' || !TIME_RE.test(value)) {
        throw new MacroError('validation_failed', `${key} 必须是 HH:MM（UTC+8）`, { details: where });
      }
    } else if (rule.type === 'quiet_window') {
      // 形态：`"HH:MM-HH:MM"`（UTC+8）或 `"off"`；语义（跨午夜/默认）在 `macro-eval.js`。
      if (typeof value !== 'string' || !QUIET_WINDOW_RE.test(value)) {
        throw new MacroError('validation_failed', `${key} 必须是 HH:MM-HH:MM（UTC+8）或 'off'`, { details: where });
      }
    } else if (rule.type === 'path') {
      if (typeof value !== 'string' || value.length === 0 || value.includes('..')) {
        throw new MacroError('validation_failed', `${key} 必须是非空路径且不许含 ..`, { details: where });
      }
    } else if (rule.type === 'text') {
      if (typeof value !== 'string' || value.length === 0) {
        throw new MacroError('validation_failed', `${key} 必须是非空字符串`, { details: where });
      }
      if (rule.max !== undefined && value.length > rule.max) {
        throw new MacroError('validation_failed', `${key} 超过 ${rule.max} 字`, { details: where });
      }
    }
  }
  return filled;
}
// 执行账枚举同样来自 shared 真源（生命周期/终态/判据/门禁/判决的注释在 `shared/macro-kinds.js`）。
/** 执行账的生命周期（单一真源：`shared/macro-kinds.js` 的 `STATUS`）。 */
export const MACRO_RUN_STATUSES = STATUS;
/** 终态集合（单一真源：`shared/macro-kinds.js` 的 `TERMINAL_STATUSES`）。 */
export const MACRO_RUN_TERMINAL_STATUSES = TERMINAL_STATUSES;
/** 触发判据（单一真源：`shared/macro-kinds.js` 的 `CRITERION`）。 */
export const MACRO_RUN_CRITERIA = CRITERION;
/** 八种门禁（单一真源：`shared/macro-kinds.js` 的 `SKIPPED_REASON`）。 */
export const MACRO_SKIPPED_REASONS = SKIPPED_REASON;
/** 归一化后的结果判定（单一真源：`shared/macro-kinds.js` 的 `VERDICT`）。 */
export const MACRO_VERDICTS = VERDICT;

/** `listMacroRuns` 的默认页长与上限（keyset 分页，见函数注释）。 */
export const MACRO_RUNS_DEFAULT_LIMIT = 50;
export const MACRO_RUNS_MAX_LIMIT = 200;

/** `notifications` 里可能引用模板的列名（W3 已建表，0036 用的是间接引用，见下）。列名不确定 ⇒ 探测而不是猜死一种。 */
const NOTIFICATION_REF_COLUMNS = Object.freeze(['macro_template_id', 'template_id', 'macro_id']);
/** W3（0036）落地列：`notifications.macro_run_id` —— 没有直连模板列时经执行账间接数。 */
const NOTIFICATION_RUN_REF_COLUMN = 'macro_run_id';

/** 与 `SessionError` / `DelegationError` 同形的错误载体（`http.js` 顶层统一映射到标准错误信封）。 */
export class MacroError extends Error {
  constructor(code, message, { httpStatus = 400, details } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/** 枚举白名单（纯函数）：非法值当场 `validation_failed`，别让「写进去才发现」成为唯一防线。 */
export function validateMacroEnum(field, value, allowed, { nullable = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new MacroError('validation_failed', `${field} 必填`, { details: { field } });
  }
  if (!allowed.includes(value)) {
    throw new MacroError('validation_failed',
      `${field} 必须是 ${allowed.map((v) => `'${v}'`).join(' / ')}，收到 ${JSON.stringify(value)}`,
      { details: { field, allowed, received: value } });
  }
  return value;
}

export const validateMacroKind = (kind) => validateMacroEnum('kind', kind, MACRO_KINDS);
export const validateMacroRunStatus = (status) => validateMacroEnum('status', status, MACRO_RUN_STATUSES);
export const validateMacroCriterion = (criterion) => validateMacroEnum('criterion', criterion, MACRO_RUN_CRITERIA);

/** 非空字符串（`name` / `anchor` / `bucket` 都用它：空串进幂等键会让整桶塌成一行）。 */
function requireText(field, value, { max = 512 } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MacroError('validation_failed', `${field} 必须是非空字符串`, { details: { field } });
  }
  if (value.length > max) {
    throw new MacroError('validation_failed', `${field} 超长（>${max}）`, { details: { field } });
  }
  return value.trim();
}

/** 时刻归一化（`until` / `now` 都收 Date / ISO 串 / epoch 毫秒）。**返回 Date，按瞬时比较**。 */
export function toInstant(field, value) {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : (typeof value === 'number' ? new Date(value) : new Date(String(value)));
  if (Number.isNaN(d.getTime())) {
    throw new MacroError('validation_failed', `${field} 不是合法时刻`, { details: { field, received: value } });
  }
  return d;
}

/**
 * 「这条订阅是不是已经到期」——纯函数，**只比瞬时值**（红线 ③）。
 * 本站 DB 列是 `timestamptz`、JS 侧是 `Date`，两者都是时刻而非「本地某天」，
 * 所以这里**不许**出现 `toISOString().slice(0,10)` 之类的按日截断：那会让
 * `until = 23:30Z` 在 UTC+8 的机器上提前一天生效（也提前一天到期）。
 */
export function isAssignmentExpired(until, now = new Date()) {
  const deadline = toInstant('until', until);
  if (!deadline) return false;
  const at = toInstant('now', now) ?? new Date();
  return deadline.getTime() <= at.getTime();
}

/** 模板行 → 对外形状（纯函数：`params` 统一成对象，`deleted_at` 原样带出供面板灰显）。 */
export function toTemplateSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    params: row.params ?? {},
    audience: row.audience,
    scope: row.scope,
    enabled: row.enabled,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at ?? null,
  };
}

/** 订阅行 → 对外形状（`expired` 是**算出来的展示态**，不是第四种状态：口径同 run 的「已取消」推导）。 */
export function toAssignmentSnapshot(row, now = new Date()) {
  if (!row) return null;
  const expired = isAssignmentExpired(row.until, now);
  return {
    id: row.id,
    template_id: row.template_id,
    user_id: row.user_id,
    session_id: row.session_id ?? null,
    cwd: row.cwd ?? null,
    until: row.until ?? null,
    enabled: row.enabled,
    expired,
    effective_enabled: row.enabled === true && !expired,
    last_evaluated_at: row.last_evaluated_at ?? null,
    created_at: row.created_at,
  };
}

/** 执行账行 → 对外形状（列名即 DB 列名，W3 面板直接吃这个形状）。 */
export function toMacroRunSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    assignment_id: row.assignment_id,
    anchor: row.anchor,
    bucket: row.bucket,
    status: row.status,
    criterion: row.criterion,
    verdict: row.verdict ?? null,
    verdict_raw: row.verdict_raw ?? null,
    reason: row.reason ?? null,
    remediation_text: row.remediation_text ?? null,
    skipped_reason: row.skipped_reason ?? null,
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    child_session_id: row.child_session_id ?? null,
    child_run_id: row.child_run_id ?? null,
    depth: row.depth,
    parent_macro_run_id: row.parent_macro_run_id ?? null,
    snapshot_id: row.snapshot_id ?? null,
    worktree_path: row.worktree_path ?? null,
  };
}

/** `pool` 可以是池也可以是 client（事务内复用同一条连接，口径同 `queued-inputs.js`）。 */
const runner = (db) => ({ query: (sql, params) => db.query(sql, params) });

// ── 模板 ──────────────────────────────────────────────────────────────────────

/**
 * 模板列表。默认**排除软删**；`isAdmin` 才看得见 `audience='admin'` 的模板
 * （鉴权本身在 http/面板侧，这里只是别把管理员专属模板漏给普通用户的订阅页）。
 */
export async function listTemplates(pool, { kinds, audience, isAdmin = false, includeDeleted = false, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (!includeDeleted) where.push('deleted_at IS NULL');
  if (kinds?.length) {
    kinds.forEach((k) => validateMacroKind(k));
    params.push(kinds);
    where.push(`kind = ANY($${params.length}::text[])`);
  }
  if (audience) {
    validateMacroEnum('audience', audience, MACRO_AUDIENCES);
    params.push(audience);
    where.push(`audience = $${params.length}`);
  } else if (!isAdmin) {
    where.push("audience = 'all'");
  }
  params.push(Math.max(1, Math.min(Number(limit) || 200, 500)));
  const res = await runner(pool).query(
    `SELECT * FROM macro_templates${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY kind, name LIMIT $${params.length}`,
    params,
  );
  return res.rows.map(toTemplateSnapshot);
}

/** 取单个模板（软删的默认当作不存在：订阅页不该看见「已下架」的东西还能订）。 */
export async function getTemplate(pool, { templateId, includeDeleted = false } = {}) {
  const res = await runner(pool).query(
    `SELECT * FROM macro_templates WHERE id = $1${includeDeleted ? '' : ' AND deleted_at IS NULL'} LIMIT 1`,
    [templateId],
  );
  const row = res.rows[0];
  if (!row) throw new MacroError('not_found', '模板不存在', { httpStatus: 404, details: { templateId } });
  return toTemplateSnapshot(row);
}

/** 建模板。`params` 必须是对象（形状校验在这里，语义校验在各宏的实现里——DB 侧只存 jsonb）。 */
export async function createTemplate(pool, {
  kind, name, params = {}, audience = 'all', scope, enabled = true, createdBy = null,
} = {}) {
  const safeKind = validateMacroKind(kind);
  // `07` §1.3：name ≤ 40（用户下拉里看到的字，不是标题）
  const safeName = requireText('name', name, { max: 40 });
  const safeAudience = validateMacroEnum('audience', audience, MACRO_AUDIENCES, { nullable: true }) ?? 'all';
  const safeScope = validateMacroEnum('scope', scope, MACRO_SCOPES);
  // `07` §1.3：scope 与 kind 的配对是固定的，不许自由组合
  if (KIND_SCOPE[safeKind] !== safeScope) {
    throw new MacroError('validation_failed',
      `${safeKind} 的 scope 必须是 ${KIND_SCOPE[safeKind]}`, { details: { field: 'scope' } });
  }
  // ⚠ 必须用**返回值**入库（#625）：`validateKindParams` 会把 schema 的 `default` 补进来，
  //   只调用不接返回值 = 默认值补了又丢，库里仍是 `{}`。
  const safeParams = validateKindParams(safeKind, params);
  const safeCreatedBy = createdBy ?? null;
  const res = await runner(pool).query(
    `INSERT INTO macro_templates (kind, name, params, audience, scope, enabled, created_by)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
     RETURNING *`,
    [safeKind, safeName, JSON.stringify(safeParams), safeAudience, safeScope, enabled === true, safeCreatedBy],
  );
  return toTemplateSnapshot(res.rows[0]);
}

/** 改模板（只允许这些列；软删过的模板不许改——要改就显式先「恢复」，W2 再说）。 */
export async function updateTemplate(pool, { templateId, patch = {}, now = new Date() } = {}) {
  // ⚠ `kind` / `scope` **不在白名单**（`07` §1.3：建完不可改）。
  // 改 kind 等于换一种语义却留着旧 params；改 scope 会让「它盯什么」静默变掉。
  const allowed = { name: 'name', params: 'params', audience: 'audience', enabled: 'enabled' };
  // params 要按**现有 kind** 校验 ⇒ 先取一次 kind（同一事务里读，避免改到别的行）
  const kindRow = await runner(pool).query(
    `SELECT kind FROM macro_templates WHERE id = $1 AND deleted_at IS NULL`, [templateId]);
  const existingKind = kindRow.rows[0]?.kind ?? null;
  const sets = [];
  const params = [templateId];
  for (const [key, column] of Object.entries(allowed)) {
    if (!(key in patch) || patch[key] === undefined) continue;
    let value = patch[key];
    if (key === 'name') value = requireText('name', value, { max: 40 });
    else if (key === 'audience') value = validateMacroEnum('audience', value, MACRO_AUDIENCES);
    else if (key === 'enabled') value = value === true;
    else if (key === 'params') {
      // 同上：补完的默认值要写库 ⇒ 接返回值。旧模板的 params 本来就带齐了默认值，
      // 所以下面补齐的只是「本次 patch 没写的可缺字段」，不会静默改掉用户显式写的值。
      if (existingKind) value = validateKindParams(existingKind, value);
      else if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new MacroError('validation_failed', 'params 必须是对象', { details: { field: 'params' } });
      }
      params.push(JSON.stringify(value));
      sets.push(`params = $${params.length}::jsonb`);
      continue;
    }
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (!sets.length) throw new MacroError('validation_failed', 'patch 里没有任何可改字段', { details: { patch } });
  params.push(toInstant('now', now) ?? new Date());
  const res = await pool.query(
    `UPDATE macro_templates SET ${sets.join(', ')}, updated_at = $${params.length}
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *`,
    params,
  );
  const row = res.rows[0];
  if (!row) throw new MacroError('not_found', '模板不存在或已删除', { httpStatus: 404, details: { templateId } });
  return toTemplateSnapshot(row);
}

/**
 * `notifications` 里指向本模板的行数（**W3 才建表** ⇒ 表不存在就跳过这一支）。
 *
 * 列名不写死：W3 可能叫 `macro_template_id`，也可能复用 `template_id`，
 * 所以先探一下 `information_schema`，用第一个存在的列去数。
 * 表存在但一个引用列都没有 ⇒ 数不到 ⇒ 视为 0（此时物理删是安全的：通知里根本不记模板）。
 */
async function countTemplateNotifications(client, templateId) {
  const cols = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'notifications'
        AND column_name = ANY($1::text[])`,
    // ⚠ 探测集必须**含** `macro_run_id`：探测只拉直连列时，间接列判定永远拿不到候选
    // ⇒ 软删计数永远是 0（本行就是那条 bug 的回归位）。
    [[...NOTIFICATION_REF_COLUMNS, NOTIFICATION_RUN_REF_COLUMN]], // 外层是 pg params 位，内层是 SQL 里的 text[]
  );
  const column = cols.rows.map((r) => r.column_name)
    .find((c) => NOTIFICATION_REF_COLUMNS.includes(c));
  if (!column) {
    // **W3 接点（10 篇 §4 第 1 条）**：0036 建的 `notifications` 没有直连模板列，
    // 引用经执行账间接成立：notifications.macro_run_id → macro_runs.assignment_id
    // → macro_assignments.template_id。有 `macro_run_id` 列就走这条 JOIN 数；
    // 两条腿都没有 ⇒ 表里根本不记模板 ⇒ 视为 0（物理删安全，旧语义不变）。
    const hasRunRef = cols.rows.some((r) => r.column_name === NOTIFICATION_RUN_REF_COLUMN);
    if (!hasRunRef) return { present: cols.rowCount > 0 || cols.rows.length > 0, count: 0, column: null };
    const viaRun = await client.query(
      `SELECT COUNT(*)::bigint AS n
         FROM notifications n
         JOIN macro_runs r ON r.id = n.macro_run_id
         JOIN macro_assignments a ON a.id = r.assignment_id
        WHERE a.template_id = $1`, [templateId],
    );
    return { present: true, count: Number(viaRun.rows[0]?.n ?? 0), column: NOTIFICATION_RUN_REF_COLUMN };
  }
  const cnt = await client.query(
    `SELECT COUNT(*)::bigint AS n FROM notifications WHERE ${column} = $1`, [templateId],
  );
  return { present: true, count: Number(cnt.rows[0]?.n ?? 0), column };
}

/**
 * **删模板（三分支，07 篇 §2.3）——本单验收重点。**
 *
 * | 引用状况 | 处置 | 为什么 |
 * |---|---|---|
 * | 无订阅、无执行账、无通知 | **物理删** | 没有任何东西指向它，留着只是垃圾 |
 * | 只有订阅、无执行账、无通知 | **物理删 + 级联删订阅** | 订阅是「想做什么」，可以后悔；没人执行过 ⇒ 无历史可留 |
 * | 有 `macro_runs` **或** `notifications` | **只能软删**（写 `deleted_at`） | 执行账与已发出的通知是**既成事实**，删了定义就没人能解释它们 |
 *
 * 判定与删除**同事务**：分开两次提交时，「刚被调度器跑了一次」能插在执行账检查与 DELETE 之间，
 * 于是 `DELETE` 靠 FK 报错（更糟的是配了 CASCADE 时直接静默抹掉历史）。
 * `notifications` 表还不存在（W3 才建）⇒ 表在则数、不在则跳过。
 *
 * 返回 `{ mode: 'deleted' | 'deleted_with_assignments' | 'soft', assignmentsRemoved, notifications, macroRuns }`。
 */
export async function deleteTemplate(pool, { templateId, now = new Date() } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 行锁：同一模板上的并发删除/订阅/执行必须串行（两个 DELETE 都过检查是经典的双删窗口）。
    const t = await client.query('SELECT id, deleted_at FROM macro_templates WHERE id = $1 FOR UPDATE', [templateId]);
    const row = t.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      throw new MacroError('not_found', '模板不存在', { httpStatus: 404, details: { templateId } });
    }
    if (row.deleted_at) {
      await client.query('COMMIT');
      return { mode: 'soft', alreadyDeleted: true, assignmentsRemoved: 0, notifications: 0, macroRuns: 0 };
    }

    const refs = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM macro_assignments a WHERE a.template_id = $1)::bigint        AS assignments,
         (SELECT COUNT(*) FROM macro_runs r JOIN macro_assignments a ON a.id = r.assignment_id
           WHERE a.template_id = $1)::bigint                                                  AS macro_runs`,
      [templateId],
    );
    const assignments = Number(refs.rows[0]?.assignments ?? 0);
    const macroRuns = Number(refs.rows[0]?.macro_runs ?? 0);
    const notifs = await countTemplateNotifications(client, templateId);

    if (macroRuns > 0 || notifs.count > 0) {
      // 分支三：有既成事实 ⇒ 只软删。
      const upd = await client.query(
        `UPDATE macro_templates SET deleted_at = $2, updated_at = $2
          WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
        [templateId, toInstant('now', now) ?? new Date()],
      );
      await client.query('COMMIT');
      return {
        mode: 'soft', assignmentsRemoved: 0,
        notifications: notifs.count, macroRuns, template: toTemplateSnapshot(upd.rows[0]),
      };
    }
    if (assignments > 0) {
      // 分支二：只有订阅 ⇒ 物理删 + 级联删订阅（`macro_assignments.template_id` 是 ON DELETE CASCADE）。
      await client.query('DELETE FROM macro_assignments WHERE template_id = $1', [templateId]);
      await client.query('DELETE FROM macro_templates WHERE id = $1', [templateId]);
      await client.query('COMMIT');
      return { mode: 'deleted_with_assignments', assignmentsRemoved: assignments, notifications: 0, macroRuns: 0 };
    }
    // 分支一：零引用 ⇒ 物理删。
    await client.query('DELETE FROM macro_templates WHERE id = $1', [templateId]);
    await client.query('COMMIT');
    return { mode: 'deleted', assignmentsRemoved: 0, notifications: 0, macroRuns: 0 };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* 连接已断：抛原错 */ }
    throw e;
  } finally {
    client.release();
  }
}

// ── 订阅 ──────────────────────────────────────────────────────────────────────

/**
 * 到期收敛（红线 ③）：把 `until` 已过但仍 `enabled` 的订阅一律关掉。
 * 纯 DB 侧一条 UPDATE，**按瞬时值**比较（`$1::timestamptz` 与 `timestamptz` 列都是时刻）。
 * 本单没有定时器（W2 的事），所以这条被 `listAssignments` / `claimMacroRun` 顺手调用，
 * 保证「读出来的 enabled」与「真的还能跑」不会出现两种说法。
 */
export async function applyExpiredAssignments(pool, { now = new Date(), userId = null } = {}) {
  const at = toInstant('now', now) ?? new Date();
  const params = [at];
  let filter = "enabled AND until IS NOT NULL AND until <= $1";
  if (userId) { params.push(userId); filter += ` AND user_id = $${params.length}`; }
  const res = await runner(pool).query(
    `UPDATE macro_assignments SET enabled = false WHERE ${filter} RETURNING id`, params,
  );
  return { disabledIds: res.rows.map((r) => r.id), disabled: res.rowCount };
}

/**
 * 每个模板的**在用订阅数**（issue #613：管理台「订阅数」列，`07` §2「不是装饰：停用前要知道影响谁」）。
 *
 * ⚠ 口径（定死，改动前先想清楚这条列是给谁看的）：
 * **只数 `enabled = true` 的订阅**。管理员点「Disable」时想知道的是「停用会掐掉谁**正在用**的」——
 * 已取消订阅（`enabled = false`，即 `unassignTemplate` 的停用支 / `applyExpiredAssignments` 的到期支）
 * 的人本来就不会再跑，停用不影响他们，计入就会虚高、反而误导。
 * 注意**不**叠加「到期」推导（`isAssignmentExpired`）：到期只是还没被关账，行上的事实口径以
 * `enabled` 为准，且本列要能一条 SQL 走完（不能在 JS 里逐行判过期，那会逼出 N+1 式的后处理）。
 *
 * 全表一次 `GROUP BY template_id`（**禁止**逐模板查 ⇒ 无 N+1）。
 * 返回 `Map<templateId, number>`；没有任何**启用**订阅的模板**不出现在 Map 里**，
 * 落 `0` 由调用方负责（区分「没人订」= `0` 与「后端没下发」= `undefined` 是前端的职责）。
 */
export async function subscriberCountsByTemplate(pool) {
  // `::int` 不是顺手：`COUNT(*)` 是 bigint，node-pg 会回传字符串，直接塞进 JSON 就成 `"2"`。
  const res = await runner(pool).query(
    `SELECT template_id, COUNT(*)::int AS count
       FROM macro_assignments
      WHERE enabled
      GROUP BY template_id`,
  );
  return new Map(res.rows.map((r) => [r.template_id, Number(r.count)]));
}

/** 订阅列表（默认关掉到期的那些 ⇒ `effective_enabled` 与 `enabled` 在这里天然一致）。 */
export async function listAssignments(pool, {
  userId = null, templateId = null, sessionId = null, includeDisabled = true, now = new Date(),
} = {}) {
  await applyExpiredAssignments(pool, { now, userId });
  const where = [];
  const params = [];
  if (userId) { params.push(userId); where.push(`user_id = $${params.length}`); }
  if (templateId) { params.push(templateId); where.push(`template_id = $${params.length}`); }
  if (sessionId) { params.push(sessionId); where.push(`session_id = $${params.length}`); }
  if (!includeDisabled) where.push('enabled');
  const at = toInstant('now', now) ?? new Date();
  const res = await runner(pool).query(
    `SELECT * FROM macro_assignments${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at, id LIMIT 500`,
    params,
  );
  return res.rows.map((r) => toAssignmentSnapshot(r, at));
}

/**
 * 订阅（幂等）：命中订阅键 `UNIQUE NULLS NOT DISTINCT (template_id, user_id, session_id, cwd)`
 * 时**不报错**，而是把已有那一行「重新点亮」并更新 `until`——重复点「订阅」不该产生第二条订阅，
 * 也不该因为 23505 给用户一个红色错误（`NULLS NOT DISTINCT` 就是为了让 `scope='user'`
 * 的 NULL 列也能参与去重）。
 *
 * `scope` 决定 `session_id` 的形状（迁移里没上跨表 CHECK，正确性就在这条函数里）：
 * `session` ⇒ 必须给；`user` ⇒ 必须不给（给了就意味着「只在这个会话里跑」，那是 `session` 的语义）。
 */
export async function assignTemplate(pool, {
  templateId, userId, sessionId = null, cwd = null, until = null, enabled = true, isAdmin = false, now = new Date(),
} = {}) {
  const template = await getTemplate(pool, { templateId });
  if (template.audience === 'admin' && !isAdmin) {
    throw new MacroError('forbidden', '该模板仅管理员可订阅', { httpStatus: 403, details: { templateId } });
  }
  const safeSessionId = sessionId ?? null;
  if (template.scope === 'session' && !safeSessionId) {
    throw new MacroError('validation_failed', '该模板的 scope=session，必须给 session_id',
      { details: { field: 'sessionId', scope: template.scope } });
  }
  if (template.scope === 'user' && safeSessionId) {
    throw new MacroError('validation_failed', '该模板的 scope=user，不能给 session_id',
      { details: { field: 'sessionId', scope: template.scope } });
  }
  if (!template.enabled) {
    throw new MacroError('conflict', '模板已停用，不能订阅', { httpStatus: 409, details: { templateId } });
  }
  const safeCwd = cwd === null || cwd === undefined ? null : requireText('cwd', cwd, { max: 1024 });
  const safeUntil = toInstant('until', until);
  const at = toInstant('now', now) ?? new Date();
  const res = await pool.query(
    `INSERT INTO macro_assignments (template_id, user_id, session_id, cwd, until, enabled)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (template_id, user_id, session_id, cwd)
       DO UPDATE SET enabled = EXCLUDED.enabled, until = EXCLUDED.until, cwd = EXCLUDED.cwd
     RETURNING *`,
    [templateId, userId, safeSessionId, safeCwd, safeUntil, enabled === true],
  );
  await applyExpiredAssignments(pool, { now: at, userId });
  const row = res.rows[0];
  return { ...toAssignmentSnapshot(row, at), reused: res.rowCount === 1 && row.created_at < at };
}

/**
 * 取消订阅（**两分支**，与模板的三分支同一个道理）：
 * 没有执行账 ⇒ 物理删；有执行账 ⇒ 只停用（`enabled = false`）。
 * 后者是迁移里 `macro_runs.assignment_id` **不带 ON DELETE** 的直接后果——
 * 历史不能被「不想再跑了」顺手抹掉（想抹是 W2 的归档任务，要有显式入口）。
 */
export async function unassignTemplate(pool, { assignmentId, userId = null, now = new Date() } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = await client.query('SELECT * FROM macro_assignments WHERE id = $1 FOR UPDATE', [assignmentId]);
    const row = a.rows[0];
    if (!row || (userId && row.user_id !== userId)) {
      await client.query('ROLLBACK');
      throw new MacroError('not_found', '订阅不存在', { httpStatus: 404, details: { assignmentId } });
    }
    const cnt = await client.query(
      'SELECT COUNT(*)::bigint AS n FROM macro_runs WHERE assignment_id = $1', [assignmentId],
    );
    const macroRuns = Number(cnt.rows[0]?.n ?? 0);
    if (macroRuns > 0) {
      const upd = await client.query(
        'UPDATE macro_assignments SET enabled = false WHERE id = $1 RETURNING *', [assignmentId],
      );
      await client.query('COMMIT');
      return { mode: 'disabled', macroRuns, assignment: toAssignmentSnapshot(upd.rows[0], now) };
    }
    await client.query('DELETE FROM macro_assignments WHERE id = $1', [assignmentId]);
    await client.query('COMMIT');
    return { mode: 'deleted', macroRuns: 0 };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* 连接已断：抛原错 */ }
    throw e;
  } finally {
    client.release();
  }
}

// ── 执行账 ────────────────────────────────────────────────────────────────────

/**
 * **认领一次执行（红线 ①）**：`INSERT … ON CONFLICT (assignment_id, anchor, criterion, bucket)
 * DO NOTHING RETURNING id` —— 插到了返回 `{ id, …}`，**没插到返回 `null`**（幂等命中）。
 *
 * 为什么不能写成「先 SELECT 再 INSERT」：两条腿之间没有锁，两个调度器（或一次重试）
 * 会同时看到「还没有」，于是同一个事件跑两遍、通知发两条。`ON CONFLICT` 让唯一索引
 * 替我们做那个「只让一个人赢」的决定，这是**数据库层**的裁决，进程重启/多副本都成立。
 *
 * **`criterion` 参与幂等键，`status` 不参与**（本单最容易写错的一处）：
 *  - `criterion`（哪条判据叫起来的）与 `anchor`/`bucket` 都写完不变 ⇒ 键稳定；同一个
 *    `(assignment, anchor, criterion, bucket)` 第二次认领必须拿到 `null`——**包括第一条已经
 *    被 `finishMacroRun` 推到 `done` 之后**（键里没有状态列，所以状态迁移不动键位）。
 *  - `status` 只是认领时写下的初始生命周期（默认 `pending`），之后由 `finishMacroRun` 推进；
 *    同一个 anchor 在**不同判据**下可以各留一条账（例如 `terminal` 跑完、`silent` 又告警一次），
 *    那是两次不同的触发，不是重复。
 *
 * ⚠ 订阅**不存在**或**已停用/已过期** ⇒ 也返回 `null`（上面那个 `WHERE EXISTS` 不成立）。
 *   这三种对调用方的处置动作完全一样——“这一枪不用开”——所以不拆成两种返回；
 *   要区分“订订阅在不在”去查 `macro_assignments`，不要拿认领当存在性探针。
 */
export async function claimMacroRun(pool, {
  assignmentId, anchor, criterion, bucket, status = 'pending', depth = 0, parentMacroRunId = null,
  snapshotId = null, worktreePath = null, startedAt = null, now = new Date(),
} = {}) {
  const safeCriterion = validateMacroCriterion(criterion);
  const safeStatus = validateMacroRunStatus(status);
  const safeAnchor = requireText('anchor', anchor, { max: 512 });
  const safeBucket = requireText('bucket', bucket, { max: 256 });
  const safeDepth = Number.isInteger(depth) ? depth : 0;
  if (safeDepth < 0) throw new MacroError('validation_failed', 'depth 不能为负', { details: { field: 'depth' } });
  const safeWorktree = worktreePath === null || worktreePath === undefined
    ? null : requireText('worktree_path', worktreePath, { max: 1024 });
  const at = toInstant('now', now) ?? new Date();

  await applyExpiredAssignments(pool, { now: at });
  const started = toInstant('startedAt', startedAt) ?? at;
  let res;
  try {
    // `INSERT … SELECT … WHERE EXISTS (订阅还启用)`：资格判定与幂等插入**同一条语句**，
    // 不拆成「先查订阅再插账」（那会多一个「查完就被停用/过期」的窗口）。
    // `ON CONFLICT DO NOTHING` 是幂等那半，`WHERE EXISTS` 是资格那半，都不经过应用层。
    res = await runner(pool).query(
      `INSERT INTO macro_runs
         (assignment_id, anchor, criterion, status, bucket, depth, parent_macro_run_id, snapshot_id, worktree_path, started_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        WHERE EXISTS (
                SELECT 1
                  FROM macro_assignments a
                  JOIN macro_templates t ON t.id = a.template_id
                 WHERE a.id = $1
                   AND a.enabled
                   -- 到期：until 未设 或 还没到。与 applyExpiredAssignments 双保险：
                   -- 那个 UPDATE 与本 INSERT 是两条语句，并发下会有「扫完就被改成过期」的窗口。
                   AND (a.until IS NULL OR a.until > $11)
                   -- 模板总开关（07 §1.4：关掉 ⇒ 所有订阅一起失效）与软删
                   AND t.enabled
                   AND t.deleted_at IS NULL
              )
       ON CONFLICT (assignment_id, anchor, criterion, bucket) DO NOTHING
       RETURNING id`,
      [assignmentId, safeAnchor, safeCriterion, safeStatus, safeBucket, safeDepth,
        parentMacroRunId ?? null, snapshotId ?? null, safeWorktree, started, at],
    );
  } catch (e) {
    // 23503 = 订阅不存在（FK）；23514 = CHECK 漂了。都翻成可读错误，别让 W2 看到裸 pg 码。
    if (e?.code === '23503') {
      throw new MacroError('not_found', '订阅不存在，无法记账', { httpStatus: 404, details: { assignmentId } });
    }
    throw e;
  }
  const id = res.rows[0]?.id;
  if (!id) return null;
  // 认领顺手记一次「评估过」——W2 的 tick 靠它做「这条订阅多久没被看过」的判据。
  await runner(pool).query('UPDATE macro_assignments SET last_evaluated_at = $2 WHERE id = $1', [assignmentId, at]);
  return { id, assignmentId, anchor: safeAnchor, bucket: safeBucket, criterion: safeCriterion, status: safeStatus };
}

/**
 * 收口一次执行。**只推进 `status`**（生命周期）与填结果列；幂等键的三列
 * （`anchor` / `criterion` / `bucket`）一律不动——推进之后同一个触发再认领仍然是 `null`。
 *
 * 语义闸（都在代码里，DB 只管形状）：
 *  - 进终态（`done`/`skipped`/`failed`/`superseded`）⇒ 必带 `finished_at`（没给就用 `now` 补）；
 *  - `status='skipped'` ⇒ 必带 `skipped_reason`（「为什么没跑」是必须可统计的维度，不许空）；
 *  - `status='done'` ⇒ `verdict` 缺省补 `'unclassified'`：宁可显式承认没分类，也不要留 NULL
 *    让面板把「没判过」和「判不了」混成一个数。
 */
export async function finishMacroRun(pool, {
  macroRunId, status, verdict, verdictRaw = null, reason = null, remediationText = null,
  // ⚠ **不给 `= null` 默认值**：本函数里 `undefined`（没提这个字段）与 `null`（显式「不动/清空」）
  // 是两件事，而 `status='skipped'` 必带 `skipped_reason` 这条闸靠的就是这个区分。
  skippedReason, childSessionId = null, childRunId = null, finishedAt = null, now = new Date(),
} = {}) {
  const safeStatus = validateMacroRunStatus(status);
  const safeVerdict = verdict === undefined ? null : validateMacroEnum('verdict', verdict, MACRO_VERDICTS, { nullable: true });
  const safeSkipped = skippedReason === undefined
    ? null : validateMacroEnum('skipped_reason', skippedReason, MACRO_SKIPPED_REASONS, { nullable: true });
  const at = toInstant('now', now) ?? new Date();
  // ⚠ 判据是 `!safeSkipped`，**不额外放行 `null`** —— 早先写成 `&& skippedReason !== null`
  // 会让「显式传 null」绕过这道闸，把空原因的 skipped 落库（DB CHECK 允许 NULL）。
  if (safeStatus === 'skipped' && !safeSkipped) {
    throw new MacroError('validation_failed', "status='skipped' 必须给 skipped_reason",
      { details: { field: 'skipped_reason', allowed: MACRO_SKIPPED_REASONS } });
  }
  const terminal = MACRO_RUN_TERMINAL_STATUSES.includes(safeStatus);
  const params = [macroRunId, safeStatus];
  const sets = ['status = $2'];
  const push = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };
  const finalVerdict = safeStatus === 'done' && safeVerdict === null ? 'unclassified' : safeVerdict;
  push('verdict', finalVerdict);
  if (verdictRaw !== undefined) push('verdict_raw', verdictRaw);
  if (reason !== undefined) push('reason', reason);
  if (remediationText !== undefined) push('remediation_text', remediationText);
  if (safeSkipped !== null) push('skipped_reason', safeSkipped);
  if (childSessionId !== undefined) push('child_session_id', childSessionId);
  if (childRunId !== undefined) push('child_run_id', childRunId);
  if (terminal) push('finished_at', toInstant('finishedAt', finishedAt) ?? at);

  // ⚠ **终态不许回退**：早先 `WHERE id = $1` 能把一条 `done` 改回 `running`，
  // 于是「终态不再推进」只是注释。这里把闸写进 SQL：已是终态的行只接受终态写入
  // （重试同一终态是幂等的，允许；terminal → 非 terminal 一律拒绝）。
  const res = await pool.query(
    `UPDATE macro_runs SET ${sets.join(', ')}
      WHERE id = $1
        AND (status <> ALL($${params.length + 1}::text[]) OR $2 = ANY($${params.length + 1}::text[]))
      RETURNING *`,
    [...params, MACRO_RUN_TERMINAL_STATUSES],
  );
  const row = res.rows[0];
  if (!row) {
    // 分清「没有这行」与「这行已是终态、不许回退」——两者对调用方的处置完全不同
    const exists = await pool.query('SELECT status FROM macro_runs WHERE id = $1', [macroRunId]);
    if (exists.rows[0]) {
      throw new MacroError('conflict',
        `执行记录已是终态 ${exists.rows[0].status}，不许回退成 ${safeStatus}`,
        { httpStatus: 409, details: { macroRunId, current: exists.rows[0].status, attempted: safeStatus } });
    }
    throw new MacroError('not_found', '执行记录不存在', { httpStatus: 404, details: { macroRunId } });
  }
  return toMacroRunSnapshot(row);
}

/** keyset 游标（不透明串）：`base64url(JSON({t: ISO, i: id}))`。**不用 OFFSET**——
 *  执行账是只追加的，OFFSET 分页在有新行插入时会重复/漏行；keyset 按 `(started_at, id)`
 *  这个全序走，翻页与写入并发也不重不漏。 */
export function encodeMacroRunCursor(row) {
  if (!row) return null;
  const t = row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at);
  return Buffer.from(JSON.stringify({ t, i: row.id }), 'utf8').toString('base64url');
}

export function decodeMacroRunCursor(cursor) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw new MacroError('validation_failed', 'cursor 无法解析', { details: { field: 'cursor' } });
  }
  const at = toInstant('cursor.t', parsed?.t);
  if (!at || typeof parsed.i !== 'string') {
    throw new MacroError('validation_failed', 'cursor 形状非法', { details: { field: 'cursor' } });
  }
  return { startedAt: at, id: parsed.i };
}

/**
 * 执行账列表（keyset 倒序翻页）。
 * 按 `templateId` 筛选走 **JOIN `macro_assignments`**（索引选型：不给只追加的账表复制一份
 * 可变的 `template_id`，见迁移 0035 的索引注释）。筛选列全部落在索引列上（09 篇 §7）。
 */
export async function listMacroRuns(pool, {
  assignmentId = null, templateId = null, status = null, criterion = null, userId = null,
  limit = MACRO_RUNS_DEFAULT_LIMIT, cursor = null,
} = {}) {
  const where = [];
  const params = [];
  if (assignmentId) { params.push(assignmentId); where.push(`r.assignment_id = $${params.length}`); }
  if (userId) { params.push(userId); where.push(`a.user_id = $${params.length}`); }
  if (templateId) { params.push(templateId); where.push(`a.template_id = $${params.length}`); }
  // 筛选走 `status`（生命周期，面板的默认筛法）与 `criterion`（判据）——两列各有索引/谓词可用；
  // **幂等**用的是 `criterion` 那一支，与这里的筛选无关。
  if (status) { validateMacroRunStatus(status); params.push(status); where.push(`r.status = $${params.length}`); }
  if (criterion) { validateMacroCriterion(criterion); params.push(criterion); where.push(`r.criterion = $${params.length}`); }
  if (cursor) {
    const c = decodeMacroRunCursor(cursor);
    params.push(c.startedAt, c.id);
    // 行值比较 = `(started_at, id) < (…)` 与 `ORDER BY started_at DESC, id DESC` 同序。
    where.push(`(r.started_at, r.id) < ($${params.length - 1}, $${params.length})`);
  }
  const safeLimit = Math.max(1, Math.min(Number(limit) || MACRO_RUNS_DEFAULT_LIMIT, MACRO_RUNS_MAX_LIMIT));
  params.push(safeLimit + 1);
  const res = await runner(pool).query(
    `SELECT r.* FROM macro_runs r
      JOIN macro_assignments a ON a.id = r.assignment_id
     ${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.started_at DESC, r.id DESC LIMIT $${params.length}`,
    params,
  );
  const rows = res.rows.map(toMacroRunSnapshot);
  const hasMore = rows.length > safeLimit;
  const page = hasMore ? rows.slice(0, safeLimit) : rows;
  return { runs: page, nextCursor: hasMore ? encodeMacroRunCursor(page[page.length - 1]) : null };
}
