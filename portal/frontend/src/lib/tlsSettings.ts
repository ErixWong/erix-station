// 管理台「证书」页（issue #456 M2 前端切片）的纯逻辑：DTO 归一化 + 域名/到期/文案的派生。
// 契约唯一来源：`docs/api/portal.md` §4.13（GET/PUT/verify/rollback）与 §4.13-2a（inspect）。
//
// 三条硬口径（与后端 `portal/src/tls-cert.js` 逐条对齐，本文件只做**前端侧的形状**，不做校验）：
//   1. **DTO 逐键白名单**（照 `lib/mailSettings.ts` 的做法）：只挑 UI 要用的字段。请求体的两个 PEM
//      字段名**在这个文件里连字面量都不出现**（连注释也不写）——请求体由视图构造，store 只把那个对象
//      原样发出去（红线：私钥不进 store / 不进浏览器存储 / 不进日志 / 不进 URL）。
//      所以本文件导出的请求体类型是**不透明**的 `TlsRequestBody`，不是一份带 PEM 字段的接口。
//   2. **不编造默认值**：缺值/脏值一律退到 `null` / 空数组，页面据此显示「—」或整段不出。
//      默认值只有一个真相源：后端 `tls-cert.js`。
//   3. **服务端 message 不翻译**（只加本地化前缀，照 §1.1「前端分支只能用 code」）：
//      `tlsErrorText` 按 `code` 分支，`details` 只读 `missing` / `field` 这类具名键。
import { toDisplayText, type ApiError } from '../api';
import { i18n } from '../i18n';

const t = i18n.global.t;

/** 四个端点的路径（唯一拼法；视图与 store 共用）。 */
export const TLS_STATUS_PATH = '/api/admin/tls';
export const TLS_INSPECT_PATH = '/api/admin/tls/inspect';
export const TLS_VERIFY_PATH = '/api/admin/tls/verify';
export const TLS_ROLLBACK_PATH = '/api/admin/tls/rollback';

/**
 * 请求体（**不透明**）：`inspect` 与 `PUT` 的 body 都由**视图**构造——那里面有两格 PEM 的字段名，
 * 而本文件与 store 都不该出现它们（红线的前端半边，判据见 `AdminTlsView.spec.ts` ⑬）。
 */
export type TlsRequestBody = Record<string, string | string[]>;

/** 叶子证书元数据（§4.13-1 的 `active`，六个字段；`null` = 某一格服务端没给/给了脏值）。 */
export interface TlsCertInfo {
  subjectCN: string | null;
  sans: string[];
  issuerCN: string | null;
  notBefore: string | null;
  notAfter: string | null;
  fingerprintSha256: string | null;
}

export interface TlsCoverage {
  adminHost: string;
  covered: boolean;
}

/** `unknown` = 还没验过 / 上传或回滚后被后端重置（§4.13-1）。 */
export type TlsLiveStatus = 'unknown' | 'live' | 'mismatch' | 'unreachable';

export interface TlsLive {
  status: TlsLiveStatus;
  checkedAt: string | null;
  fingerprintSha256?: string;
  subjectCN?: string;
  /** 仅 `unreachable`：`timeout` / `no_default_gateway` / `no_certificate` / socket 错误码。 */
  error?: string;
}

export interface TlsPrevious {
  fingerprintSha256: string | null;
  subjectCN: string | null;
  notAfter: string | null;
  savedAt: string | null;
}

/** `GET` / `PUT` / `verify` / `rollback` 同一个形状（§4.13-1）。 */
export interface TlsStatus {
  configured: boolean;
  active: TlsCertInfo | null;
  coverage: TlsCoverage;
  live: TlsLive;
  previous: TlsPrevious | null;
}

/** `POST /api/admin/tls/inspect` 的响应（§4.13-2a）。 */
export interface TlsInspectResult {
  cert: TlsCertInfo;
  /** `true` / `false` / `null`（没给私钥）。**`false` 不是错误**：UI 自己禁用「确认安装」。 */
  keyMatches: boolean | null;
  coverage: TlsCoverage;
  /** 机器码：`cert_expired` / `not_yet_valid` / `no_sans` / `admin_host_not_covered`（服务端只发码不发话）。 */
  warnings: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** 只认字符串数组里的非空字符串（SAN 里混进 `null`/数字时丢掉那一项，不渲染 `undefined`）。 */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : [];
}

/**
 * 证书元数据 → DTO。**显式白名单**：不展开 `...data`，所以服务端即使某天误发了公钥/证书/私钥
 * 相关的键，它们也进不来（红线）。
 */
function normalizeCert(data: unknown): TlsCertInfo | null {
  if (data === null || typeof data !== 'object') return null;
  const cert = asRecord(data);
  return {
    subjectCN: asStringOrNull(cert.subjectCN),
    sans: asStringArray(cert.sans),
    issuerCN: asStringOrNull(cert.issuerCN),
    notBefore: asStringOrNull(cert.notBefore),
    notAfter: asStringOrNull(cert.notAfter),
    fingerprintSha256: asStringOrNull(cert.fingerprintSha256),
  };
}

function normalizeCoverage(data: unknown): TlsCoverage {
  const coverage = asRecord(data);
  return {
    adminHost: asString(coverage.adminHost),
    // 只有布尔 true 才算覆盖（字符串 "true" 不当真）。
    covered: coverage.covered === true,
  };
}

function normalizeLive(data: unknown): TlsLive {
  const live = asRecord(data);
  const status = live.status;
  const known: TlsLiveStatus[] = ['unknown', 'live', 'mismatch', 'unreachable'];
  const normalized: TlsLive = {
    status: known.includes(status as TlsLiveStatus) ? (status as TlsLiveStatus) : 'unknown',
    checkedAt: asStringOrNull(live.checkedAt),
  };
  // 三个可选键**只在服务端真的给了**时才写（缺键 ≠ 空串：页面据此决定整行出不出）。
  if (typeof live.fingerprintSha256 === 'string' && live.fingerprintSha256 !== '') {
    normalized.fingerprintSha256 = live.fingerprintSha256;
  }
  if (typeof live.subjectCN === 'string' && live.subjectCN !== '') normalized.subjectCN = live.subjectCN;
  if (typeof live.error === 'string' && live.error !== '') normalized.error = live.error;
  return normalized;
}

function normalizePrevious(data: unknown): TlsPrevious | null {
  if (data === null || typeof data !== 'object') return null;
  const previous = asRecord(data);
  return {
    fingerprintSha256: asStringOrNull(previous.fingerprintSha256),
    subjectCN: asStringOrNull(previous.subjectCN),
    notAfter: asStringOrNull(previous.notAfter),
    savedAt: asStringOrNull(previous.savedAt),
  };
}

/**
 * 状态 DTO 归一化（`GET` / `PUT` / `verify` / `rollback` 共用）。
 *
 * `configured:false` ⇒ `active` 一律 `null`（后端也这么发，这里再兜一次：没有生效证书就不该有
 * 「半张证书」的字段被渲染出来）。
 */
export function normalizeTlsStatus(data: unknown): TlsStatus {
  const root = asRecord(data);
  const configured = root.configured === true;
  const active = configured ? normalizeCert(root.active) : null;
  return {
    configured: configured && active !== null,
    active,
    coverage: normalizeCoverage(root.coverage),
    live: normalizeLive(root.live),
    previous: normalizePrevious(root.previous),
  };
}

/**
 * inspect 响应归一化。`cert` 缺失（服务端回了个空壳）⇒ `null`，由 store 记一条错误，
 * 页面**不**渲染一张「空证书」。
 */
export function normalizeTlsInspect(data: unknown): TlsInspectResult | null {
  const root = asRecord(data);
  const cert = normalizeCert(root.cert);
  if (cert === null) return null;
  const keyMatches = root.keyMatches;
  return {
    cert,
    keyMatches: typeof keyMatches === 'boolean' ? keyMatches : null,
    coverage: normalizeCoverage(root.coverage),
    warnings: asStringArray(root.warnings),
  };
}

/**
 * 「证书自称覆盖哪些名字」= 域名编辑器的**预填值**：有 SAN 用 SAN，否则退 CN（§4.13-3 的覆盖口径）。
 * 与后端 `certificateDomains()` 同一条规则——前端只是把同一个答案拿来当输入框初值，不做判定。
 */
export function certificateDomains(cert: TlsCertInfo | null): string[] {
  if (cert === null) return [];
  if (cert.sans.length > 0) return [...cert.sans];
  return cert.subjectCN === null ? [] : [cert.subjectCN];
}

/** 域名编辑器 → `confirmDomains`：去空白、去空行、去重（大小写不敏感，保留用户第一次写的形态）。 */
export function normalizeDomainRows(rows: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const value = String(row ?? '').trim();
    if (value === '') continue;
    const key = value.toLowerCase().replace(/\.$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** 某一行的值是否就是管理台域名（`adminHost` 那行要高亮标注：它是硬闸）。 */
export function isAdminHostRow(value: string, adminHost: string): boolean {
  const a = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
  const b = String(adminHost ?? '').trim().toLowerCase().replace(/\.$/, '');
  return a !== '' && a === b;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 到期提醒的阈值（工单：< 30 天给黄色提醒）。 */
export const TLS_EXPIRY_WARN_DAYS = 30;

/**
 * 到期状态（纯函数，`now` 可注入 ⇒ 三条分支都能单测）。
 *
 * - `expired`：`notAfter <= now`（红条）；
 * - `today`：**不足一天**（黄条，文案「今天到期」）——**不显示「0 天」**这种假精确；
 * - `soon`：剩余 `1..29` 天（黄条，文案「还剩 N 天」）；
 * - `ok`：≥ 30 天（不刷提醒行）；
 * - `unknown`：服务端没给 / 给了解析不出的值（整行不出，不猜）。
 */
export type TlsExpiry =
  | { kind: 'expired' }
  | { kind: 'today' }
  | { kind: 'soon'; days: number }
  | { kind: 'ok'; days: number }
  | { kind: 'unknown' };

export function expiryState(notAfter: string | null, now: number = Date.now()): TlsExpiry {
  if (typeof notAfter !== 'string' || notAfter === '') return { kind: 'unknown' };
  const at = Date.parse(notAfter);
  if (Number.isNaN(at)) return { kind: 'unknown' };
  const diff = at - now;
  if (diff <= 0) return { kind: 'expired' };
  if (diff < DAY_MS) return { kind: 'today' };
  const days = Math.ceil(diff / DAY_MS);
  return days < TLS_EXPIRY_WARN_DAYS ? { kind: 'soon', days } : { kind: 'ok', days };
}

/** ISO 时间 → 本地时区展示串（解析不出 ⇒ `null`，调用方显示「—」而不是 `Invalid Date`）。 */
export function formatLocalTime(value: string | null): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toLocaleString();
}

/** `details.field`（服务端字段名）——**只在 400 时**有意义，别的状态码带 field 也不指输入框。 */
export function validationFieldOf(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null;
  const { status, details } = error as Partial<ApiError>;
  if (status !== 400) return null;
  const field = (details as Record<string, unknown> | undefined)?.field;
  return typeof field === 'string' && field !== '' ? field : null;
}

/** `details.missing`（`tls_cert_domain_mismatch` 点名的域名）——认不出就 `[]`，不猜。 */
export function missingDomainsOf(error: unknown): string[] {
  if (error === null || typeof error !== 'object') return [];
  const details = (error as Partial<ApiError>).details as Record<string, unknown> | undefined;
  return asStringArray(details?.missing);
}

/**
 * 证书面的错误 → 人话（§4.13-3 / §1.2 的码表）。
 *
 * 按 `code` 分支，**不匹配 message**（§1.1：前端分支只能用 code）。服务端 `message` 原文一律**不翻译**，
 * 只拼一个本地化前缀；429 用 `Retry-After` 秒数（不可解 ⇒ 退到不带秒数的版本，不显示「undefined 秒」）。
 * `tls_cert_domain_mismatch` 额外把 `details.missing` 点出来——「缺哪个域名」才是用户要改的东西。
 */
export function tlsErrorText(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const rawMessage = err instanceof Error ? err.message : (err as { message?: unknown } | null)?.message;
  const message = toDisplayText(rawMessage === undefined ? err : rawMessage);
  const retryAfter = (err as { retryAfter?: unknown } | null)?.retryAfter;

  const prefix = (key: string): string => t(key) + message;

  switch (code) {
    case 'tls_cert_invalid':
      return prefix('admin.tls.errCertInvalid');
    case 'tls_key_invalid':
      return prefix('admin.tls.errKeyInvalid');
    case 'tls_key_mismatch':
      return prefix('admin.tls.errKeyMismatch');
    case 'tls_cert_expired':
      return prefix('admin.tls.errCertExpired');
    case 'tls_cert_domain_mismatch': {
      const missing = missingDomainsOf(err);
      const base = prefix('admin.tls.errDomainMismatch');
      return missing.length > 0 ? `${base} ${t('admin.tls.errDomainMissing', { missing: missing.join(', ') })}` : base;
    }
    case 'tls_no_previous':
      return prefix('admin.tls.errNoPrevious');
    case 'validation_failed':
      return prefix('admin.tls.errValidation');
    case 'rate_limited':
      return typeof retryAfter === 'number' && Number.isFinite(retryAfter)
        ? t('admin.tls.errRateLimited', { seconds: retryAfter })
        : t('admin.tls.errRateLimitedNoRetry');
    default:
      return t('admin.errorPrefix') + message;
  }
}
