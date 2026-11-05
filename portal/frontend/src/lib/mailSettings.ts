// 管理台「邮件通道」配置页（issue #449 管理台切片）的纯逻辑：DTO 归一化 + 保存请求体构造 + 字段名映射。
// 契约唯一来源：`docs/api/portal.md` §4.12（`GET/PUT /api/admin/mail/settings`、`POST /api/admin/mail/test`）。
//
// 三条硬口径（与后端 `portal/src/mail-settings.js` 逐条对齐，本文件只做**前端侧的形状**，不做校验）：
//   1. **口令只写不读**：DTO 里根本没有口令键（只有 `hasPassword`）。`normalizeMailSettings` 显式丢弃
//      任何叫 `password` / `smtp_password` 的键——即使服务端某天误发了明文，它也不会进前端状态
//      （红线：口令不进状态 / localStorage / 日志 / URL）。
//   2. **口令三态**（§4.12-3）：键缺席 = 不修改（编辑表单留空就是这个语义）／`null` = 清除／字符串 = 覆盖。
//      构造请求体时**只有**非空口令或显式「清除」才会带上这个键。
//   3. **校验只在需要时严格**（§4.12-3）：`transport='disabled'` 时 host/from 后端不校验，前端也就不标必填。
//      数值字段（port / 三档超时）**不在前端做业务校验**：空/非整数一律发 `null`（= 用服务端默认值），
//      非法值由服务端回 `400 validation_failed` + `details.field`，页面按字段标红。
import type { ApiError } from '../api';

/** 端点路径（唯一拼法，视图与 store 共用）。 */
export const MAIL_SETTINGS_PATH = '/api/admin/mail/settings';
export const MAIL_TEST_PATH = '/api/admin/mail/test';

/** `transport` 的取值（§4.12-1：只有两个，`disabled` = 不发信）。 */
export const MAIL_TRANSPORTS = ['disabled', 'smtp'] as const;
export type MailTransport = (typeof MAIL_TRANSPORTS)[number];

export interface MailTimeouts {
  /** 连接超时（ms）。`null` = 服务端没给/给了脏值 ⇒ 表单留空、提交时也用服务端默认值。 */
  connectionMs: number | null;
  greetingMs: number | null;
  socketMs: number | null;
}

export interface MailSmtp {
  host: string;
  port: number | null;
  secure: boolean;
  user: string;
  from: string;
  timeouts: MailTimeouts;
}

/** 读侧 DTO（GET 与 PUT 响应同一个形状，§4.12-1）。**没有口令字段，这是契约不是遗漏。** */
export interface MailSettings {
  transport: MailTransport;
  smtp: MailSmtp;
  hasPassword: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * 写侧请求体（§4.12-3）。`password` 的**键缺席**是有语义的（= 不修改），所以这里用可选键而不是
 * `string | null | undefined`：构造方只能「不写这个键」或「写 null / 非空串」，写不出 `undefined`
 * （JSON.stringify 会把它丢掉，行为一样，但读代码的人看不出意图）。
 */
export interface MailSettingsPayload {
  transport: MailTransport;
  smtp: {
    host: string;
    port: number | null;
    secure: boolean;
    user: string;
    from: string;
    timeouts: MailTimeouts;
  };
  password?: string | null;
}

/** 表单里的一手值（数字框在 DOM 里天然是字符串）。 */
export interface MailFormValues {
  transport: MailTransport;
  host: string;
  port: string;
  secure: boolean;
  user: string;
  from: string;
  connectionMs: string;
  greetingMs: string;
  socketMs: string;
  /** 口令输入框的当前内容（永不回填；留空 = 不修改）。 */
  password: string;
  /** 「清除口令」复选框：勾选 ⇒ 请求体 `password: null`。 */
  clearPassword: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 只认有限的数字（`null` = 缺值/脏值 ⇒ 页面留空，不编造默认值）。 */
function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * GET/PUT 响应 → 页面要的 DTO。
 *
 * **显式白名单**（不是展开 `...data`）：口令相关的键（`password` / `smtp_password`）即使出现在响应里
 * 也进不来（§4.12-6 红线的前端半边）。缺值/脏值一律退到「空 / null / false」，页面据此显示「—」或留空，
 * 而不是拿前端抄的一份默认值冒充服务端状态（默认值只有一个真相源：`portal/src/mail-settings.js`）。
 */
export function normalizeMailSettings(data: unknown): MailSettings {
  const root = asRecord(data);
  const smtp = asRecord(root.smtp);
  const timeouts = asRecord(smtp.timeouts);
  return {
    transport: root.transport === 'smtp' ? 'smtp' : 'disabled',
    smtp: {
      host: asString(smtp.host),
      port: asNumberOrNull(smtp.port),
      // `secure` 缺省按契约是 true（§4.12-1）；但只有**布尔**才算数，字符串 "true" 不当真。
      secure: typeof smtp.secure === 'boolean' ? smtp.secure : true,
      user: asString(smtp.user),
      from: asString(smtp.from),
      timeouts: {
        connectionMs: asNumberOrNull(timeouts.connectionMs),
        greetingMs: asNumberOrNull(timeouts.greetingMs),
        socketMs: asNumberOrNull(timeouts.socketMs),
      },
    },
    hasPassword: root.hasPassword === true,
    updatedAt: typeof root.updatedAt === 'string' ? root.updatedAt : null,
    updatedBy: typeof root.updatedBy === 'string' ? root.updatedBy : null,
  };
}

/** 数字框文本 → `number | null`（空串/非整数/非有限值 ⇒ `null` = 让服务端用它自己的默认值）。 */
export function parseOptionalInt(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  const text = (value ?? '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isInteger(n) ? n : null;
}

/**
 * 表单值 → `PUT` 请求体（§4.12-3）。
 *
 * **口令三态的唯一实现点**：
 *   • 勾了「清除口令」 ⇒ `password: null`（清除）；
 *   • 输入框非空 ⇒ `password: <原样>`（覆盖；**不 trim**：口令里的空格是内容）；
 *   • 否则 ⇒ **不带这个键**（不修改）——编辑表单留空就是这个语义。
 * 除此之外口令不出现在请求体的任何其它位置（red line 的请求侧半边）。
 */
export function buildMailSettingsPayload(values: MailFormValues): MailSettingsPayload {
  const payload: MailSettingsPayload = {
    transport: values.transport,
    smtp: {
      host: values.host,
      port: parseOptionalInt(values.port),
      secure: values.secure,
      user: values.user,
      from: values.from,
      timeouts: {
        connectionMs: parseOptionalInt(values.connectionMs),
        greetingMs: parseOptionalInt(values.greetingMs),
        socketMs: parseOptionalInt(values.socketMs),
      },
    },
  };
  if (values.clearPassword) payload.password = null;
  else if (values.password !== '') payload.password = values.password;
  return payload;
}

/** 表单字段的稳定标识（`data-test` / `aria-invalid` / 错误落点用；与 i18n 键无关）。 */
export type MailFieldKey =
  | 'transport'
  | 'host'
  | 'port'
  | 'secure'
  | 'user'
  | 'password'
  | 'from'
  | 'timeoutConnection'
  | 'timeoutGreeting'
  | 'timeoutSocket';

/** `details.field`（服务端字段名，§4.12-3 的校验矩阵）→ 页面上的哪个框。 */
const FIELD_KEYS: Readonly<Record<string, MailFieldKey>> = {
  transport: 'transport',
  'smtp.host': 'host',
  'smtp.port': 'port',
  'smtp.secure': 'secure',
  'smtp.user': 'user',
  'smtp.from': 'from',
  password: 'password',
  'smtp.timeouts.connectionMs': 'timeoutConnection',
  'smtp.timeouts.greetingMs': 'timeoutGreeting',
  'smtp.timeouts.socketMs': 'timeoutSocket',
};

/**
 * `error.details.field` → 页面字段。认不出（`body` / `smtp` / 非字符串 / 缺席）⇒ `null`，
 * 由调用方把消息渲染成一条整表错误（**不猜**是哪个框——猜错比不猜更糟）。
 */
export function mailFieldKey(field: unknown): MailFieldKey | null {
  if (typeof field !== 'string') return null;
  return FIELD_KEYS[field] ?? null;
}

/**
 * `400 validation_failed` 的 `details.field`（**只在 400 时**有意义：别的状态码带 field 也不指输入框）。
 * 非 `ApiError` / 非 400 ⇒ `null`。
 */
export function validationFieldOf(error: unknown): MailFieldKey | null {
  if (error === null || typeof error !== 'object') return null;
  const { status, details } = error as Partial<ApiError>;
  if (status !== 400) return null;
  const field = (details as Record<string, unknown> | undefined)?.field;
  return mailFieldKey(field);
}
