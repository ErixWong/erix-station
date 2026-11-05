// 邮件通道的**写侧**（issue #449 管理台切片，契约 docs/api/portal.md §4.12）：
// `GET /api/admin/mail/settings`（读） / `PUT /api/admin/mail/settings`（写） / 测试发信的消息体。
//
// 与读取侧（`portal/src/mail-provider.js`）的分工：`mail_settings` 单行表是**唯一真相**，本模块只负责
// 校验 + 写它；落库后由 `http.js` 调一次 `ctx.mailerProvider.invalidate()` 让 60s 缓存立刻失效
// （改配置**立刻**生效，不等 TTL——不然「配好了却要等一分钟」会被当成配置没生效）。
//
// 四条硬口径：
//   1. **口令只写不读**：GET/PUT 响应只有 `hasPassword` 布尔；审计 `details` 只有
//      `password_changed` 布尔与改动键名。任何路径都不回显 `smtp_password` 明文。
//   2. **缺席 = 不修改**（项目既有口径，见 #314 同族）：请求体里**没有** `password` 键 ⇒ 保留原口令
//      （编辑表单留空 = 不改）；`password: null` / `''` ⇒ 清除；字符串 ⇒ 覆盖。
//   3. **校验只在需要时严格**：`transport='smtp'` 时 host/from 必填、from 过邮箱正则、port 1–65535、
//      三档超时正整数；`transport='disabled'` 时**不校验** host/from——允许保留半套配置，
//      方便「先关掉再慢慢配」。
//   4. **单行 upsert**：`INSERT … ON CONFLICT (id) DO UPDATE`（id 恒 1）。不用「先查再决定 INSERT/UPDATE」，
//      并发两个管理员同时保存时不会撞主键（迁移 0026 的 `CHECK (id = 1)` 把单行写成 DB 事实）。

const TRANSPORTS = new Set(['disabled', 'smtp']);

// 与 `admin.js#createUser` 建号同一个正则口径（`^[^\s@]+@[^\s@]+\.[^\s@]+$`）。两处必须一字不差——
// 单测 `admin-mail-settings.test.js` 有一条源码级判据把这两处钉在一起（改一处不改另一处会红）。
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_PORT = 587;
const DEFAULT_SECURE = true;
const DEFAULT_TIMEOUTS = { connectionMs: 10000, greetingMs: 10000, socketMs: 20000 };
const MAX_TIMEOUT_MS = 600000;
const MAX_HOST_LENGTH = 255;
const MAX_USER_LENGTH = 255;
const MAX_PASSWORD_LENGTH = 8192;

const SETTINGS_COLUMNS = `transport, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, smtp_from,
       connection_timeout_ms, greeting_timeout_ms, socket_timeout_ms, updated_at, updated_by`;

const SELECT_SQL = `SELECT ${SETTINGS_COLUMNS} FROM mail_settings WHERE id = 1`;

// 单条 upsert：id 恒 1（迁移 0026 的 CHECK (id = 1)）。`updated_at`/`updated_by` 由本次写入决定。
const UPSERT_SQL = `INSERT INTO mail_settings (id, transport, smtp_host, smtp_port, smtp_secure, smtp_user,
                          smtp_password, smtp_from, connection_timeout_ms, greeting_timeout_ms,
                          socket_timeout_ms, updated_at, updated_by)
VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11)
ON CONFLICT (id) DO UPDATE
   SET transport = EXCLUDED.transport,
       smtp_host = EXCLUDED.smtp_host,
       smtp_port = EXCLUDED.smtp_port,
       smtp_secure = EXCLUDED.smtp_secure,
       smtp_user = EXCLUDED.smtp_user,
       smtp_password = EXCLUDED.smtp_password,
       smtp_from = EXCLUDED.smtp_from,
       connection_timeout_ms = EXCLUDED.connection_timeout_ms,
       greeting_timeout_ms = EXCLUDED.greeting_timeout_ms,
       socket_timeout_ms = EXCLUDED.socket_timeout_ms,
       updated_at = now(),
       updated_by = EXCLUDED.updated_by
RETURNING ${SETTINGS_COLUMNS}`;

/** 校验/状态类错误：`httpStatus` + `details.field`（http.js 的统一信封按此映射，见 createServer 的 catch）。 */
export class MailSettingsError extends Error {
  constructor(code, message, { httpStatus = 400, details } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

function fail(field, message) {
  throw new MailSettingsError('validation_failed', message, { httpStatus: 400, details: { field } });
}

/** 邮箱口径（测试发信的 `to` 与 PUT 的 `smtp.from` 共用）。 */
export function isEmail(value) {
  return typeof value === 'string' && EMAIL_RE.test(value.trim());
}

function isoOrNull(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function intOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 单行 → 响应 DTO。**永不返回口令**：只给 `hasPassword` 布尔。
 * 无行（未配置）时给默认 DTO——「未配置」是正常态，端点回 200 而不是 404。
 */
export function toMailSettingsDto(row) {
  if (!row) {
    return {
      transport: 'disabled',
      smtp: {
        host: '',
        port: DEFAULT_PORT,
        secure: DEFAULT_SECURE,
        user: '',
        from: '',
        timeouts: { ...DEFAULT_TIMEOUTS },
      },
      hasPassword: false,
      updatedAt: null,
      updatedBy: null,
    };
  }
  return {
    transport: row.transport === 'smtp' ? 'smtp' : 'disabled',
    smtp: {
      host: row.smtp_host ?? '',
      port: intOr(row.smtp_port, DEFAULT_PORT),
      secure: row.smtp_secure === true,
      user: row.smtp_user ?? '',
      from: row.smtp_from ?? '',
      timeouts: {
        connectionMs: intOr(row.connection_timeout_ms, DEFAULT_TIMEOUTS.connectionMs),
        greetingMs: intOr(row.greeting_timeout_ms, DEFAULT_TIMEOUTS.greetingMs),
        socketMs: intOr(row.socket_timeout_ms, DEFAULT_TIMEOUTS.socketMs),
      },
    },
    hasPassword: typeof row.smtp_password === 'string' && row.smtp_password !== '',
    updatedAt: isoOrNull(row.updated_at),
    updatedBy: row.updated_by ?? null,
  };
}

/** `GET /api/admin/mail/settings` 的取数：无行 ⇒ 默认 DTO（200，不是 404）。 */
export async function getMailSettings(pool) {
  const result = await pool.query(SELECT_SQL);
  return toMailSettingsDto(result.rows?.[0] ?? null);
}

function objectInput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('body', '请求体必须是对象');
  }
  return value;
}

function cleanTransport(value) {
  if (typeof value !== 'string' || !TRANSPORTS.has(value)) {
    fail('transport', 'transport 必须是 disabled 或 smtp');
  }
  return value;
}

/** 文本列（host / user / from）：缺席 ⇒ 空串；给了就必须是字符串（类型错是 500 的源头，必须拦）。 */
function cleanText(value, field, { maxLength }) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail(field, `${field} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) fail(field, `${field} 长度超过上限 ${maxLength}`);
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) fail(field, `${field} 不能包含控制字符`);
  return trimmed;
}

function cleanPort(value) {
  if (value === undefined || value === null) return DEFAULT_PORT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    fail('smtp.port', 'smtp.port 必须是 1–65535 的整数');
  }
  return value;
}

function cleanSecure(value) {
  if (value === undefined || value === null) return DEFAULT_SECURE;
  if (typeof value !== 'boolean') fail('smtp.secure', 'smtp.secure 必须是布尔值');
  return value;
}

function cleanTimeout(value, field) {
  if (value === undefined || value === null) return DEFAULT_TIMEOUTS[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    fail(`smtp.timeouts.${field}`, `smtp.timeouts.${field} 必须是 1–${MAX_TIMEOUT_MS} 的正整数`);
  }
  return value;
}

/**
 * 口令三态（口径 2）：
 *   * 键**缺席** ⇒ `{ value: <原值>, present: false }`（保留，不算改动）
 *   * `null` / `''` ⇒ `{ value: null, present: true }`（清除）
 *   * 字符串 ⇒ `{ value: <原样>, present: true }`（覆盖；**不 trim**，口令里的空格是内容）
 */
function resolvePassword(input, current) {
  const currentValue = typeof current?.smtp_password === 'string' ? current.smtp_password : null;
  if (!Object.hasOwn(input, 'password')) return { value: currentValue, present: false };
  const raw = input.password;
  if (raw === null || raw === '') return { value: null, present: true };
  if (typeof raw !== 'string') fail('password', 'password 必须是字符串、null 或空串');
  if (raw.length > MAX_PASSWORD_LENGTH) fail('password', `password 长度超过上限 ${MAX_PASSWORD_LENGTH}`);
  return { value: raw, present: true };
}

/** 扁平键值视图：只用于算「这次改了哪些键」（审计 details.changed）。 */
function flatten(dto) {
  return {
    transport: dto.transport,
    'smtp.host': dto.smtp.host,
    'smtp.port': dto.smtp.port,
    'smtp.secure': dto.smtp.secure,
    'smtp.user': dto.smtp.user,
    'smtp.from': dto.smtp.from,
    'smtp.timeouts.connectionMs': dto.smtp.timeouts.connectionMs,
    'smtp.timeouts.greetingMs': dto.smtp.timeouts.greetingMs,
    'smtp.timeouts.socketMs': dto.smtp.timeouts.socketMs,
  };
}

/**
 * `PUT /api/admin/mail/settings`：校验 + 单条 upsert。
 *
 * @returns {Promise<{settings: object, changed: string[], passwordChanged: boolean, transport: string}>}
 *   `changed` = 相对「上一次状态」（无行时基线 = GET 的默认 DTO）真正变了的键名；口令变化只体现为
 *   键名 `'password'` 与 `passwordChanged` 布尔，**永不带明文**。
 *   注意：本函数**不写审计、不失效缓存**——那是 http.js 成功路径的两步（顺序见 §4.12）。
 */
export async function updateMailSettings({ pool, actorId = null, fields } = {}) {
  const input = objectInput(fields);
  const transport = cleanTransport(input.transport);
  if (input.smtp === null || typeof input.smtp !== 'object' || Array.isArray(input.smtp)) {
    fail('smtp', 'smtp 必须是对象');
  }
  const smtp = input.smtp;
  const timeouts = smtp.timeouts === undefined || smtp.timeouts === null ? {} : smtp.timeouts;
  if (typeof timeouts !== 'object' || Array.isArray(timeouts)) {
    fail('smtp.timeouts', 'smtp.timeouts 必须是对象');
  }

  const host = cleanText(smtp.host, 'smtp.host', { maxLength: MAX_HOST_LENGTH });
  const user = cleanText(smtp.user, 'smtp.user', { maxLength: MAX_USER_LENGTH });
  const from = cleanText(smtp.from, 'smtp.from', { maxLength: MAX_HOST_LENGTH });
  const port = cleanPort(smtp.port);
  const secure = cleanSecure(smtp.secure);
  const connectionMs = cleanTimeout(timeouts.connectionMs, 'connectionMs');
  const greetingMs = cleanTimeout(timeouts.greetingMs, 'greetingMs');
  const socketMs = cleanTimeout(timeouts.socketMs, 'socketMs');

  // 只在真要发信时才要求「配全」：disabled 允许保留半套（先关后配）。
  if (transport === 'smtp') {
    if (host === '') fail('smtp.host', 'transport=smtp 时 smtp.host 为必填字段');
    if (from === '') fail('smtp.from', 'transport=smtp 时 smtp.from 为必填字段');
    if (!isEmail(from)) fail('smtp.from', 'smtp.from 必须是有效邮箱地址');
  }

  const current = (await pool.query(SELECT_SQL)).rows?.[0] ?? null;
  const password = resolvePassword(input, current);

  const written = await pool.query(UPSERT_SQL, [
    transport, host, port, secure, user, password.value, from, connectionMs, greetingMs, socketMs, actorId,
  ]);
  const row = written.rows?.[0] ?? null;
  const settings = toMailSettingsDto(row);
  // 以「DB 回读的行」为准（RETURNING），不信输入：这样 `changed` 描述的是**真落库的变化**。
  const nextFlat = flatten(settings);
  const prevFlat = flatten(toMailSettingsDto(current));
  const changed = Object.keys(nextFlat).filter((key) => nextFlat[key] !== prevFlat[key]);
  const passwordChanged = password.present
    && (password.value ?? null) !== (typeof current?.smtp_password === 'string' ? current.smtp_password : null);
  if (passwordChanged) changed.push('password');

  return { settings, changed, passwordChanged, transport: settings.transport };
}

/**
 * 测试发信的正文（**不含验证码**：这是运维手点的一封探活信，正文只有「这是测试信 + 时间戳」）。
 * 收件人/时间戳由调用方给，本函数保持纯函数（单测好钉）。
 */
export function buildTestMessage({ to, at }) {
  const stamp = at instanceof Date ? at.toISOString() : String(at ?? new Date().toISOString());
  return {
    to,
    subject: 'FDE Station 邮件通道测试',
    text: [
      '这是一封来自 FDE Station 管理台的测试邮件，用于确认邮件通道（SMTP）配置可用。',
      '',
      `发送时间：${stamp}`,
      '',
      '这不是登录验证码，无需任何操作。',
    ].join('\n'),
  };
}
