// 管理台 store（pinia）：旧 portal/static/admin.html 内联状态/S/api 调用的逐行平移（issue #61 P3）。
// 后端零改动：全部走既有 /api/admin/* 端点（portal/src/http.js handleAdminApi）。
// 204 语义说明：DELETE 供应商/模型返回 204，现有 api() 的 r.json().catch(() => ({}))
// 已兼容（空体 → {}，调用方本就丢弃返回值），故 api.ts 无需改动（结论已核对 http.js）。
import { defineStore } from 'pinia';
import QRCode from 'qrcode';
import { api, toDisplayText } from '../api';
import { i18n } from '../i18n';
// issue #350：号池占用总览（GET /api/admin/preview-ports/usage）的请求面与归一化都在 lib 里（纯函数可单测）。
import {
  PREVIEW_USAGE_PATH,
  normalizeUsage,
  usageErrorText,
  type PreviewPoolUsage,
} from '../lib/previewPoolUsage';
// issue #449 管理台切片：邮件通道配置（§4.12）。DTO 归一化 / 请求体构造 / 字段名映射都在 lib 里（纯函数可单测），
// 这里只负责「一次调用 = 一次请求」+ 错误透传（照本文件既有 action 的写法）。
import {
  MAIL_SETTINGS_PATH,
  MAIL_TEST_PATH,
  normalizeMailSettings,
  validationFieldOf,
  type MailFieldKey,
  type MailSettings,
  type MailSettingsPayload,
} from '../lib/mailSettings';
// issue #485 片 A：管理台上传上限（§4.15）。DTO 归一化 / 请求体构造 / 字段映射都在 lib（纯函数可单测）。
import {
  UPLOAD_SETTINGS_PATH,
  normalizeUploadSettings,
  uploadValidationFieldOf,
  type UploadFieldKey,
  type UploadSettings,
  type UploadSettingsPayload,
} from '../lib/uploadSettings';
// issue #596 片 B：管理台「提示词」面板（§4.19）。DTO 归一化 / 请求体构造 / 400 字段映射 /
// 物化通知语义全在 lib（纯函数可单测）；这里只负责「一次调用 = 一次请求」+ 错误透传。
import {
  PLATFORM_PROMPTS_PATH,
  buildPromptPayload,
  effectiveAgentsMdPath,
  materializeNoticeOf,
  normalizeEffectiveAgentsMd,
  normalizePlatformPrompts,
  platformPromptPath,
  promptValidationFieldOf,
  type EffectiveAgentsMd,
  type MaterializeNotice,
  type PlatformPrompts,
  type PromptFieldKey,
} from '../lib/platformPrompts';
// issue #677 P2b：管理台「运行时设置」页（§4.21）。DTO 归一化 / 请求体构造 / 400 字段映射全在 lib
// （纯函数可单测）；这里只负责「一次调用 = 一次请求」+ 错误透传。**不缓存**（后端读侧自己带 5s TTL
// 缓存，这一页要看的正是「现在生效的是哪一个」，重进本页就该看到新快照）。
import {
  RUNTIME_SETTINGS_PATH,
  buildRuntimeSettingPayload,
  normalizeRuntimeSettingSaved,
  normalizeRuntimeSettingsList,
  replaceRuntimeSetting,
  runtimeSettingFieldOf,
  type RuntimeSettingItem,
} from '../lib/runtimeSettings';
// issue #586 管理台「关于」面板（§4.16）。DTO 归一化全在 `lib/versionSurface`（纯函数可单测），
// 这里只负责「一次调用 = 一次请求」+ 错误透传。**前端一个字都不推算版本**：三格各自读自己的字段。
import {
  VERSION_PATH,
  normalizeVersionInfo,
  versionErrorText,
  type VersionInfo,
} from '../lib/versionSurface';
// issue #456 M2 管理台证书页（§4.13）。DTO 白名单 / 到期判定 / 错误文案全在 lib（纯函数可单测），
// 这里只负责「一次调用 = 一次请求」+ 错误透传。**请求体是不透明的 `TlsRequestBody`**：两个 PEM 的
// 字段名只活在视图里，本文件（与 lib）连字面量都不出现——私钥不进 store 的红线由此**结构上**成立。
import {
  TLS_INSPECT_PATH,
  TLS_ROLLBACK_PATH,
  TLS_STATUS_PATH,
  TLS_VERIFY_PATH,
  normalizeTlsInspect,
  normalizeTlsStatus,
  tlsErrorText,
  validationFieldOf as tlsValidationFieldOf,
  type TlsInspectResult,
  type TlsRequestBody,
  type TlsStatus,
} from '../lib/tlsSettings';

// issue #650 管理台「系统」面板（§4.20）。DTO 归一化与展示格式化全在 `lib/systemMetrics`（纯函数可单测），
// 这里只负责「一次调用 = 一次请求」+ 错误透传。**三态（enabled / latest / seriesError）在 lib 里各自收成独立字段**，
// store 不合并也不推——一个读数兼不了另外两个的说法。
import {
  metricsErrorText,
  normalizeSystemMetrics,
  systemMetricsPath,
  type SystemMetrics,
} from '../lib/systemMetrics';

// issue #101 P3：前端自产文案（「错误：」前缀）走 i18n 单例——options store 非组件上下文，
// useI18n() 会抛 MUST_BE_CALL_SETUP_TOP，故统一走 i18n.global.t。
// 注意：服务端透传的 error.message（errText）不译，仅拼接前缀。
// 400 的 `details.field` 只可能是 §4.21 点名的三档（`key`/`value`/`body`）。类型从 lib 的判据函数
// 反推，不在这里重抄一遍联合字面量（重抄就是第二份真相，lib 加一档这里就会静默漏一档）。
type RuntimeSettingField = NonNullable<ReturnType<typeof runtimeSettingFieldOf>>;

/**
 * `PUT /api/admin/runtime-settings/{key}`（§4.21）的路径。
 *
 * ⚠ lib 里没有这个函数（`runtimeSettings.ts` 已验收、不许改），而这个拼接只有本文件的写侧要用
 * ⇒ 就地一个 3 行小函数，不为它单开一个模块。`encodeURIComponent` 是必需而非装饰：key 的形状是
 * `^[a-z][a-z0-9_.]{2,63}$`（迁移 0046 的 CHECK），今天不含需要转义的字符，但一旦 registry 放进
 * 含 `%`/`?`/`#` 的 key，不编码就会把一条设置写成两条路由。
 */
const runtimeSettingSavePath = (key: string): string =>
  `${RUNTIME_SETTINGS_PATH}/${encodeURIComponent(key)}`;

const t = i18n.global.t;

export interface LlmModel {
  id: string;
  provider_id: string;
  model_id: string;
  /** #296：数据面调用名 = LiteLLM 顶层 `model_name`，即 **FDE 请求实际发的那个名字**（操作面）。 */
  model_name: string;
  /** #296：展示名 = `model_info.display_name`（后端缺省时回退成调用名，两者不再等价）。 */
  name: string;
  type: string; // text | embedding | vision | rerank | audio-tts | audio-stt | image-gen
  tool_calling: boolean;
  context_window: number | null;
  max_tokens: number | null;
  /**
   * issue #309 切片 1：单次响应**输出预算上限**（引擎侧把 `max_tokens` 当预算用）。
   * 权威位在 `model_info.max_output_tokens`，后端写侧与 `litellm_params.max_tokens` 绑死同值；
   * 读侧没有该值时回退到 `max_tokens`（所以存量模型不会显示成「没配」）。
   * 硬上限由服务端单一判定：**≤ floor(context_window / 4)**——前端不做本地数字校验。
   */
  max_output_tokens: number | null;
  enabled: boolean;
  // issue #164：每 token 单价（USD），由后端从 LiteLLM 读回。pricing_configured 为 false 时
  // 该模型用量金额会记 0，UI 必须显式提示而不是静默。pricing_source='cost_map' 表示价格来自
  // LiteLLM 内置价目表（不是本模型显式设定）。
  input_cost_per_token?: number | null;
  output_cost_per_token?: number | null;
  pricing_configured?: boolean;
  pricing_source?: 'override' | 'cost_map' | 'none';
  litellm_params?: { model?: string };
}

export interface LlmProvider {
  id: string;
  name: string;
  base_url: string;
  models: LlmModel[];
}

export interface AdminUser {
  id: string;
  login: string;
  display_name: string | null;
  /** 2026-11-06：管理员可维护（开户时必填、编辑时可改可清）。老响应没有这个键 ⇒ undefined。 */
  email?: string | null;
  /** 2026-11-06：per-user「邮件验证码」开关（迁移 0028）。默认 false；全局 transport=disabled 仍压过它。 */
  mail_otp_enabled?: boolean;
  /**
   * 工单 feat-261110-03（迁移 0030）：**允许用 TOTP 登录**，与 `totp_enabled`（= 绑过密钥）是两件事。
   * 关掉不清密钥 ⇒ `totp_enabled` 仍为 true，随时可以再打开。库里默认 true，所以
   * 「缺键」（旧后端 / 部分响应）与「管理员关掉了」在界面上得区分开：消费方一律 `=== true`。
   */
  totp_login_enabled?: boolean;
  /**
   * 2026-11-09（#472 片 A）：per-user「文件上传」开关（迁移 0029）。默认 false。
   * **可选是语义的一部分**：缺键 = 「这个账号的开关没能读取」（旧后端 / 部分响应），
   * 管理台因此**三态**而非两态：不得把缺键折叠成 false（评审 blocker 3）。
   * 消费方一律 `=== true`（未知与关都落在「不放开」那一侧，但界面要能说清是哪一种）。
   */
  file_upload_enabled?: boolean;
  /**
   * issue #828（portal.md §2.2）：这个用户的默认语言偏好。`'zh-CN'` / `'en'` 或 `null`（没设过）。
   * `null` = 「跟随浏览器」，**不是** 一个语言值——管理台表单与列表都据此渲染（`null` 显示「跟随浏览器」，
   * 不得退化成空选项或字符串 `"null"`）。可选：缺键（旧后端 / 部分响应）也当「跟随浏览器」处理。
   */
  locale?: string | null;
  role: 'fde' | 'admin';
  fde_name: string | null;
  status: 'active' | 'disabled' | 'awaiting_credential';
  totp_enabled: boolean;
  last_login_at: string | null;
  /**
   * issue #497（迁移 0031）：最近一次**用户输入**（按下发送那一刻）。与 `last_login_at`（最近一次登录）
   * 是**两条独立时间线**：后端只有两处写它（发送路 `postMessage` 与运行中入队 `enqueueQueuedInput`），
   * 登录本身、agent 跑完一个 run、改名、归档都不写 ⇒ 它**允许比 `last_login_at` 旧**
   * （登录了但一句话没说），那不是脏数据，别在界面上「修正」它。
   * `null` = 从未活动（新开户，或从没说过话）。
   * ⚠ 渲染红线：`null` 必须显示成「从未活动」——**绝不许**退化成「今天」或空字符串
   *（没扫到就没资格承诺，口径同收工灯的 ⚪ 不得渲染成绿）。
   */
  last_activity_at: string | null;
  git_host_id?: string | null;
  onboarding: {
    state: 'pending' | 'running' | 'awaiting_credential' | 'done' | 'failed';
    step?: string | null;
    error?: string | null;
    llm_binding?: {
      state: 'pending' | 'running' | 'done' | 'failed';
      error?: string | null;
    };
  } | null;
  offboarding?: {
    state: 'pending' | 'running' | 'done' | 'failed';
    step?: string | null;
    error?: string | null;
    workspace_purge_after: string | null;
  } | null;
}

// issue #800：用户列表「周期 / 用量」列的一行。字段与 projectQuota / listFdeKeyUsage 逐字对齐；
// spend_scope 是「本周期 vs 终身」标签的**唯一**判据（null = 无读数，不得渲染成 0）。
export interface KeyUsageRow {
  fde_name: string;
  budget_usd: number | null;
  budget_period: '1d' | '1mo' | null;
  max_budget: number | null;
  budget_duration: string | null;
  budget_reset_at: string | null;
  spend: number | null;
  remaining: number | null;
  spend_scope: 'period' | 'lifetime' | null;
}

export interface GitHost {
  id: string;
  name: string;
  provider: 'gitea' | 'github' | 'gitlab' | 'azure';
  base_url: string;
  admin_key: string | null;
  admin_key_configured: boolean;
  mode: 'minted' | 'per_fde_pat';
  enabled: boolean;
}

// 新增模型表单的类型下拉（旧版 7 类，逐字平移）。
export const MODEL_TYPES = ['text', 'embedding', 'vision', 'rerank', 'audio-tts', 'audio-stt', 'image-gen'] as const;

// 一次性 TOTP 展示盒内容（totp_secret 仅此一次下发，红线：刷新/重进不再可见）。
export interface TotpOnce {
  login: string;
  uri: string;
  secret: string;
  qr: string; // qrcode data URL（旧版 qrcode(0,'M') + createDataURL(4,8) 的等价物）
  purpose: 'created' | 'reactivated' | 'enrolled';
}

interface ProvidersResponse {
  items: LlmProvider[];
}

interface UsersResponse {
  items: AdminUser[];
}

interface GitHostsResponse {
  items: GitHost[];
}

interface TotpProvisionResponse {
  user: AdminUser;
  totp_secret?: string;
  totp_uri?: string;
  reactivated?: boolean;
}

interface TotpEnrollmentResponse extends TotpProvisionResponse {
  totp_secret: string;
  totp_uri: string;
}

async function makeTotpOnce(
  response: TotpEnrollmentResponse,
  purpose: TotpOnce['purpose'],
): Promise<TotpOnce> {
  const qr = await QRCode.toDataURL(response.totp_uri, { errorCorrectionLevel: 'M', scale: 4, margin: 8 });
  return {
    login: response.user.login,
    uri: response.totp_uri,
    secret: response.totp_secret,
    qr,
    purpose,
  };
}

function hasTotpProvision(response: TotpProvisionResponse): response is TotpEnrollmentResponse {
  return typeof response.totp_secret === 'string' && typeof response.totp_uri === 'string';
}

/**
 * issue #449：测试发信的四种失败面 → 人话（§4.12-4）。
 *
 * 按 `code` 分支，**不匹配 message**（§1.1：前端分支只能用 code）。
 * `mail_not_configured` / `email_send_failed` 用本地化前缀 + 服务端 message 原文（不翻译）；
 * `rate_limited` 用 `Retry-After` 秒数（`retryAfter` 不可解 ⇒ 退到不带秒数的版本，不显示 “undefined 秒”）。
 */
export function testMailErrorText(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  // 消息优先取 `message`（ApiError 是 Error；测试/桩里可能是同形状的普通对象），拿不到再退到整个抛出值。
  const rawMessage = err instanceof Error ? err.message : (err as { message?: unknown } | null)?.message;
  const message = toDisplayText(rawMessage === undefined ? err : rawMessage);
  const retryAfter = (err as { retryAfter?: unknown } | null)?.retryAfter;
  if (code === 'mail_not_configured') return t('admin.mail.testNotConfiguredPrefix') + message;
  if (code === 'email_send_failed') return t('admin.mail.testFailedPrefix') + message;
  if (code === 'rate_limited') {
    return typeof retryAfter === 'number' && Number.isFinite(retryAfter)
      ? t('admin.mail.testRateLimited', { seconds: retryAfter })
      : t('admin.mail.testRateLimitedNoRetry');
  }
  return t('admin.errorPrefix') + message;
}

export type AdminUserUpdate = Partial<Pick<AdminUser,
  'display_name' | 'email' | 'mail_otp_enabled' | 'totp_login_enabled' | 'file_upload_enabled' | 'locale' | 'role' | 'fde_name'>> & {
  status?: 'active' | 'disabled';
};

export const useAdminStore = defineStore('admin', {
  state: () => ({
    providers: [] as LlmProvider[],
    users: [] as AdminUser[],
    gitHosts: [] as GitHost[],
    providersLoaded: false, // 「加载中…」空态用（旧 #providerList 初始文案）
    usersLoaded: false,
    gitHostsLoaded: false,
    llmErr: null as string | null, // 旧 showErr('llmErr', e)
    fdeErr: null as string | null,
    gitHostsErr: null as string | null,
    expandedProviders: [] as string[], // 旧 S.expanded（Set<string>，provider id）
    expansionTouched: false,
    totpOnce: null as TotpOnce | null, // 旧 #totpOnce 内联盒
    lastReactivatedUserId: null as string | null,
    usersLoading: false,
    // issue #800：用户列表「周期 / 用量」列。与 users 的加载**分开**：网关挂了只让这一列空着。
    keyUsage: [] as KeyUsageRow[],
    keyUsageLoaded: false,
    keyUsageLoading: false,
    keyUsageErr: null as string | null,
    // issue #350：号池占用总览。`previewUsageLoaded` 与 `previewUsage` 分开：
    // 「还没请求」（loaded=false）与「服务端说一个被占段都没有」（loaded=true + 空数组）不是同一件事。
    previewUsage: null as PreviewPoolUsage | null,
    previewUsageLoaded: false,
    previewUsageLoading: false,
    previewUsageErr: null as string | null,
    // issue #586：「关于」面板的版本三格（§4.16）。与号池占用同构：`…Loaded` 与 `…info` 分开
    // （「还没请求」≠「服务端说没数据」），且不缓存——本页要的就是「现在跑的是哪份构建」。
    versionInfo: null as VersionInfo | null,
    versionInfoLoaded: false,
    versionInfoLoading: false,
    versionInfoErr: null as string | null,
    // issue #650：宿主资源快照（§4.20）。与版本三格同构：`…Loaded` 与 `…Metrics` 分开
    // （「还没请求」≠「服务端说没有这一拍」）。轮询**覆盖上一份**而不追历史：本页只要最新一拍
    // 与当前区间的分桶结果，历史真相在库里。
    systemMetrics: null as SystemMetrics | null,
    systemMetricsLoaded: false,
    systemMetricsLoading: false,
    systemMetricsErr: null as string | null,
    // issue #449：邮件通道配置（§4.12）。**口令永不进这里**：DTO 只有 `hasPassword`，
    // 归一化（lib/mailSettings.normalizeMailSettings）是显式白名单，连服务端误发的明文也会被丢掉。
    mailSettings: null as MailSettings | null,
    mailSettingsLoaded: false, // 「还没请求」与「服务端说默认 DTO」是两件事
    mailSettingsLoading: false,
    mailSettingsErr: null as string | null,
    mailSaving: false,
    mailSaveErr: null as string | null,
    // 400 `validation_failed` 的 `details.field`（§4.12-3）→ 页面字段；null = 整表错误（认不出字段名就不猜）。
    mailSaveField: null as MailFieldKey | null,
    mailSaveOk: false,
    mailTesting: false,
    mailTestErr: null as string | null,
    // 502 的 `details.reason`（§4.12-4：只有摘要，不含口令/正文）；单独放，便于页面加一行「原因：」。
    mailTestReason: null as string | null,
    mailTestOk: null as { to: string; at: string | null } | null,
    // issue #485 片 A：单文件上传上限（§4.15）。与邮件通道同构：DTO 归一化在 `lib/uploadSettings`，
    // 这里只管「一次调用 = 一次请求」+ 错误透传。**不缓存**（与后端同口径：这一页就是要看当前生效值）。
    uploadSettings: null as UploadSettings | null,
    uploadSettingsLoaded: false,
    uploadSettingsLoading: false,
    uploadSettingsErr: null as string | null,
    uploadSaving: false,
    uploadSaveErr: null as string | null,
    // 400 `validation_failed` 的 `details.field`（§4.15-2）→ 页面标红那个框；null = 整表错误。
    uploadSaveField: null as UploadFieldKey | null,
    uploadSaveOk: false,
    // issue #596 片 B：管理台「提示词」面板（§4.19）。与 upload 同构：归一化在 lib，这里只管
    // 「一次调用 = 一次请求」。**不缓存**（后端每次物化/改名都现读那一行 ⇒ 这一页要看的就是新快照）。
    platformPrompts: null as PlatformPrompts | null,
    platformPromptsLoaded: false,
    platformPromptsLoading: false,
    platformPromptsErr: null as string | null,
    promptSaving: false,
    promptSaveErr: null as string | null,
    // 400 的 `details.field`（`text`/`body`/`field`）映射出来的**要标红那张卡**；null = 整页错误。
    promptSaveField: null as PromptFieldKey | null,
    // 最近一次**成功**保存的卡（页面据此只在那一张卡上显示「已保存」+ 生效时机 + 物化通知状态）。
    promptSavedField: null as PromptFieldKey | null,
    // `materializeEnqueued` 的语义结论（`0` 与「没给」都是要显式说出口的事，不许静默）。
    promptNotice: null as MaterializeNotice | null,
    /** issue #801：「重新读取」成功那一刻（ISO 串）；`null` = 本页还没手动重读过。 */
    platformPromptsReloadedAt: null as string | null,
    /** issue #801：`GET /api/admin/prompts/effective-agents-md` 的归一化结果。 */
    effectiveAgentsMd: null as EffectiveAgentsMd | null,
    effectiveAgentsMdLoading: false,
    effectiveAgentsMdErr: null as string | null,
    effectiveAgentsMdFde: null as string | null,
    // issue #677 P2b：管理台「运行时设置」列表（§4.21）。与 upload 那段同构，但**是列表**（P3 会往
    // registry 里一格一格加旋钮），所以「正在保存」「刚保存」「被标红」三件事都必须带 **key**，
    // 布尔位做不到这件事（一个布尔位 = 一整页的按钮同时转圈）。
    runtimeSettings: [] as RuntimeSettingItem[],
    runtimeSettingsLoaded: false, // 「还没请求」与「服务端说 registry 里没东西」是两件事
    runtimeSettingsLoading: false,
    runtimeSettingsErr: null as string | null,
    // **最近一次在写 / 刚写完的 key**（不是布尔）：每行一颗保存按钮，转圈与「已保存」只落在被按下的
    // 那一行；禁用是**整页**的（`runtimeSaving !== null` ⇒ 所有行的按钮全禁，见视图 `saveDisabled`）。
    runtimeSaving: null as string | null,
    runtimeSaveErr: null as string | null,
    // 400 的 `details.field`（§4.21：`key`/`value`/`body`），本层只**如实转记**服务端说的那一处，
    // 不自己猜；null = 认不出是哪一处。**归属在渲染层分派**（`AdminRuntimeSettingsView` 的 `rowError`）：
    // `value` ⇒ 只标被尝试那一行；`key` / `body` / null ⇒ 只走整页一行，不重复出现在两处。
    runtimeSaveField: null as RuntimeSettingField | null,
    // 最近一次**成功**保存的 key（页面据此只在那一行显示「已保存」）。
    runtimeSavedKey: null as string | null,
    // issue #456 M2：管理台证书页（§4.13）。**私钥永不进这里**：状态只有 DTO 白名单
    // （`lib/tlsSettings.normalizeTlsStatus` / `normalizeTlsInspect`），连字段名字面量都不在本文件里。
    tlsStatus: null as TlsStatus | null,
    tlsLoading: false,
    tlsError: null as string | null,
    tlsInspecting: false,
    tlsInspect: null as TlsInspectResult | null,
    tlsInspectErr: null as string | null,
    tlsSaving: false,
    tlsSaveErr: null as string | null,
    // 400 `validation_failed` 的 `details.field` **原文**（服务端的字段名，本文件不认识它们）；
    // 视图把它映射到具体的输入框（映射表在视图里——所以 PEM 字段名不进本文件）。
    tlsSaveField: null as string | null,
    tlsSaveOk: false,
    tlsVerifying: false,
    tlsVerifyErr: null as string | null,
    tlsRollingBack: false,
    tlsRollbackErr: null as string | null,
    tlsRollbackOk: false,
  }),

  actions: {
    errText(err: unknown): string {
      // 非 Error 的抛出值（服务端信封被换成对象、fetch 桩抛字面量…）此前走 `String()` ⇒
      // `[object Object]`。改用 api.ts 的 toDisplayText（#255 的同一把尺子）：对象退化成 JSON 文本，
      // 宁可难看也不丢信息。字符串/Error.message 的行为一字不改。
      return toDisplayText(err instanceof Error ? err.message : err);
    },

    /**
     * issue #350：`GET /api/admin/preview-ports/usage`（号池占用总览，只读）。
     *
     * 懒加载的判据在**调用方**（`PreviewPoolUsageView` 的 `onMounted`）：进管理台不请求，
     * 切到该 tab 才发恰好 1 次。这里只负责「一次调用 = 一次请求」，不做缓存短路
     * （号池占用是会变的，重新进入该页应当看到新快照）。
     *
     * 失败面照本文件既有口径：`admin.errorPrefix` + 服务端 `error.message` **原文**（不翻译）。
     * 返回错误串便于调用方直接展示，同时写进 `previewUsageErr`。
     */
    async loadPreviewUsage(): Promise<string | null> {
      this.previewUsageLoading = true;
      this.previewUsageErr = null;
      try {
        const data = await api<unknown>(PREVIEW_USAGE_PATH);
        // 归一化在 lib：脏值/缺字段 ⇒ null 或空 + Present 旗标，页面据此显示「—」而不是 0。
        this.previewUsage = normalizeUsage(data);
        this.previewUsageLoaded = true;
        return null;
      } catch (e) {
        const { message } = usageErrorText(e);
        this.previewUsageErr = t('admin.errorPrefix') + message;
        return this.previewUsageErr;
      } finally {
        this.previewUsageLoading = false;
      }
    },

    dismissTotpOnce() {
      this.totpOnce = null;
    },

    /**
     * issue #586：`GET /api/admin/version`（管理台「关于」，§4.16）。
     *
     * 一次调用 = 一次请求（与 `loadPreviewUsage` 同口径）：版本是**构建产物**，本页存在的意义就是
     * 「看一眼现在跑的是哪份」，缓存它就等于把 v0.1.69/0.1.68 那种分裂重新藏起来。
     * 归一化在 lib：脏值 / 缺字段 ⇒ `null` + `fdesPresent` 旗标，页面据此说「未知 / 读不到」而不是 0。
     */
    async loadVersionInfo(): Promise<string | null> {
      this.versionInfoLoading = true;
      this.versionInfoErr = null;
      try {
        const data = await api<unknown>(VERSION_PATH);
        this.versionInfo = normalizeVersionInfo(data);
        this.versionInfoLoaded = true;
        return null;
      } catch (e) {
        this.versionInfoErr = t('admin.errorPrefix') + versionErrorText(e);
        return this.versionInfoErr;
      } finally {
        this.versionInfoLoading = false;
      }
    },

    /**
     * issue #650：`GET /api/admin/system/metrics?range=`（管理台「系统」，§4.20）。
     *
     * 一次调用 = 一次请求（与 `loadVersionInfo` / `loadPreviewUsage` 同口径）。非法 / 缺省 range
     * **不拼参数**：§4.20 说非法入参由服务端回落成 `1h` 并把生效值回在 `range` 里，前端再造一份缺省
     * 就是第二份口径（它会把页面选中态领看）。
     *
     * 返回 `null` = 成功，否则是已本地化的错误行（调用方直接上屏）。**轮询失败不抹旧读数**：
     * `systemMetrics` 只在成功时覆盖，于是「DB 抖一下」不会让四张卡闪成未知。
     */
    async fetchSystemMetrics(range?: string | null): Promise<string | null> {
      this.systemMetricsLoading = true;
      this.systemMetricsErr = null;
      try {
        const data = await api<unknown>(systemMetricsPath(range));
        this.systemMetrics = normalizeSystemMetrics(data);
        this.systemMetricsLoaded = true;
        return null;
      } catch (e) {
        this.systemMetricsErr = t('admin.errorPrefix') + metricsErrorText(e);
        return this.systemMetricsErr;
      } finally {
        this.systemMetricsLoading = false;
      }
    },

    toggleExpandedProvider(id: string) {
      this.expansionTouched = true;
      const i = this.expandedProviders.indexOf(id);
      if (i >= 0) this.expandedProviders.splice(i, 1);
      else this.expandedProviders.push(id);
    },

    /** 旧 loadProviders：GET /api/admin/llm/providers。 */
    async loadProviders() {
      this.llmErr = null;
      try {
        const data = await api<ProvidersResponse>('/api/admin/llm/providers');
        const providers = data.items ?? [];
        const providerIds = providers.map((provider) => String(provider.id));
        if (!this.expansionTouched) {
          this.expandedProviders = providerIds;
        } else {
          const previousProviderIds = new Set(this.providers.map((provider) => String(provider.id)));
          this.expandedProviders = this.expandedProviders.filter((id) => providerIds.includes(id));
          for (const id of providerIds) {
            if (!previousProviderIds.has(id) && !this.expandedProviders.includes(id)) {
              this.expandedProviders.push(id);
            }
          }
        }
        this.providers = providers;
        this.providersLoaded = true;
      } catch (e) {
        this.llmErr = t('admin.errorPrefix') + this.errText(e);
      }
    },

    /** 旧 loadUsers：GET /api/admin/users。 */
    async loadUsers(): Promise<string | null> {
      this.usersLoading = true;
      this.fdeErr = null;
      try {
        const data = await api<UsersResponse>('/api/admin/users');
        this.users = data.items ?? [];
        this.usersLoaded = true;
        return null;
      } catch (e) {
        this.fdeErr = t('admin.errorPrefix') + this.errText(e);
        return this.fdeErr;
      } finally {
        this.usersLoading = false;
      }
    },

    /** issue #800：GET /api/admin/llm/key-usage —— 整表一次取回每 FDE 的周期与已用金额。
     *  重拉**一开头就作废旧读数**（评审 BLOCKER）：Pinia 状态跨路由存活，不清就会在「本轮没拿到新数」时
     *  继续举着上一轮的钱给人看；钱这件事上「旧值」与「没读数」必须分得开 ⇒ 拿不到就回到「—」。 */
    async loadKeyUsage(): Promise<string | null> {
      this.keyUsageLoading = true;
      this.keyUsageErr = null;
      this.keyUsage = [];
      this.keyUsageLoaded = false;
      try {
        const data = await api<{ rows: KeyUsageRow[] }>('/api/admin/llm/key-usage');
        this.keyUsage = data.rows ?? [];
        this.keyUsageLoaded = true;
        return null;
      } catch (e) {
        // 失败 ⇒ 保持空（渲染成「—」），**不得回展示旧金额**。
        this.keyUsageErr = t('admin.errorPrefix') + this.errText(e);
        return this.keyUsageErr;
      } finally {
        this.keyUsageLoading = false;
      }
    },

    async updateUser(id: string, fields: AdminUserUpdate): Promise<string | null> {
      this.fdeErr = null;
      try {
        await api(`/api/admin/users/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(fields),
        });
        return await this.loadUsers();
      } catch (e) {
        return t('admin.errorPrefix') + this.errText(e);
      }
    },

    async deleteUser(id: string): Promise<string | null> {
      this.fdeErr = null;
      try {
        await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
        return await this.loadUsers();
      } catch (e) {
        return t('admin.errorPrefix') + this.errText(e);
      }
    },

    async resetPassword(id: string, password: string): Promise<string | null> {
      try {
        await api(`/api/admin/users/${encodeURIComponent(id)}/reset-password`, {
          method: 'POST',
          body: JSON.stringify({ password }),
        });
        return null;
      } catch (e) {
        return t('admin.errorPrefix') + this.errText(e);
      }
    },

    async resetTotp(id: string): Promise<string | null> {
      try {
        await api(`/api/admin/users/${encodeURIComponent(id)}/totp-reset`, { method: 'POST' });
        return await this.loadUsers();
      } catch (e) {
        return t('admin.errorPrefix') + this.errText(e);
      }
    },

    async enrollTotp(id: string): Promise<string | null> {
      this.fdeErr = null;
      try {
        const response = await api<TotpEnrollmentResponse>(
          `/api/admin/users/${encodeURIComponent(id)}/totp-enroll`,
          { method: 'POST' },
        );
        this.totpOnce = await makeTotpOnce(response, 'enrolled');
        await this.loadUsers();
        return null;
      } catch (e) {
        this.fdeErr = t('admin.errorPrefix') + this.errText(e);
        return this.fdeErr;
      }
    },

    async retryOnboarding(id: string): Promise<string | null> {
      try {
        await api(`/api/admin/users/${encodeURIComponent(id)}/onboard/retry`, { method: 'POST' });
        return await this.loadUsers();
      } catch (e) {
        this.fdeErr = t('admin.errorPrefix') + this.errText(e);
        return this.fdeErr;
      }
    },

    async retryOffboarding(id: string): Promise<string | null> {
      try {
        await api(`/api/admin/users/${encodeURIComponent(id)}/offboarding/retry`, { method: 'POST' });
        return await this.loadUsers();
      } catch (e) {
        this.fdeErr = t('admin.errorPrefix') + this.errText(e);
        return this.fdeErr;
      }
    },

    async loadGitHosts() {
      this.gitHostsErr = null;
      try {
        const data = await api<GitHostsResponse>('/api/admin/git-hosts');
        this.gitHosts = data.items ?? [];
        this.gitHostsLoaded = true;
      } catch (e) {
        this.gitHostsErr = t('admin.errorPrefix') + this.errText(e);
      }
    },

    async addGitHost(fields: {
      name: string;
      provider: GitHost['provider'];
      base_url: string;
      admin_key?: string;
      enabled?: boolean;
    }): Promise<string | null> {
      this.gitHostsErr = null;
      try {
        await api('/api/admin/git-hosts', { method: 'POST', body: JSON.stringify(fields) });
        await this.loadGitHosts();
        return this.gitHostsErr;
      } catch (e) {
        this.gitHostsErr = t('admin.errorPrefix') + this.errText(e);
        return this.gitHostsErr;
      }
    },

    async updateGitHost(host: GitHost, fields: Partial<{
      name: string;
      provider: GitHost['provider'];
      base_url: string;
      admin_key: string;
      clear_admin_key: boolean;
      enabled: boolean;
    }>): Promise<string | null> {
      this.gitHostsErr = null;
      try {
        await api(`/api/admin/git-hosts/${encodeURIComponent(host.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(fields),
        });
        await this.loadGitHosts();
        return this.gitHostsErr;
      } catch (e) {
        this.gitHostsErr = t('admin.errorPrefix') + this.errText(e);
        return this.gitHostsErr;
      }
    },

    async toggleGitHost(host: GitHost) {
      this.gitHostsErr = null;
      try {
        await api(`/api/admin/git-hosts/${encodeURIComponent(host.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !host.enabled }),
        });
        await this.loadGitHosts();
      } catch (e) {
        this.gitHostsErr = t('admin.errorPrefix') + this.errText(e);
      }
    },

    async removeGitHost(host: GitHost) {
      this.gitHostsErr = null;
      try {
        await api(`/api/admin/git-hosts/${encodeURIComponent(host.id)}`, { method: 'DELETE' });
        await this.loadGitHosts();
      } catch (e) {
        this.gitHostsErr = t('admin.errorPrefix') + this.errText(e);
      }
    },

    /** 旧 addProviderForm 提交：POST /api/admin/llm/providers。 */
    async addProvider(name: string, baseUrl: string, apiKey?: string): Promise<string | null> {
      this.llmErr = null;
      try {
        const body: Record<string, string> = { name, base_url: baseUrl };
        if (apiKey) body.api_key = apiKey;
        await api('/api/admin/llm/providers', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        await this.loadProviders();
        return null;
      } catch (e) {
        this.llmErr = t('admin.errorPrefix') + this.errText(e);
        return this.llmErr;
      }
    },

    /** 编辑供应商地址及可选上游 key：PATCH /api/admin/llm/providers/<id>。 */
    async updateProvider(p: LlmProvider, baseUrl: string, apiKey?: string): Promise<string | null> {
      this.llmErr = null;
      try {
        const body: Record<string, string> = { base_url: baseUrl };
        if (apiKey) body.api_key = apiKey;
        await api(`/api/admin/llm/providers/${encodeURIComponent(p.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        await this.loadProviders();
        return this.llmErr;
      } catch (e) {
        this.llmErr = t('admin.errorPrefix') + this.errText(e);
        return this.llmErr;
      }
    },

    /** 旧 provider del 按钮：DELETE（confirm 在视图层）。 */
    async removeProvider(p: LlmProvider) {
      this.llmErr = null;
      try {
        await api(`/api/admin/llm/providers/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
        this.expansionTouched = true;
        const i = this.expandedProviders.indexOf(p.id);
        if (i >= 0) this.expandedProviders.splice(i, 1);
        await this.loadProviders();
      } catch (e) {
        this.llmErr = t('admin.errorPrefix') + this.errText(e);
      }
    },

    /** 旧模型 toggle：PATCH /api/admin/llm/models/<id> { enabled: !m.enabled }。 */
    async toggleModel(m: LlmModel) {
      this.llmErr = null;
      try {
        await api(`/api/admin/llm/models/${encodeURIComponent(m.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !m.enabled }),
        });
        await this.loadProviders();
      } catch (e) {
        this.llmErr = t('admin.errorPrefix') + this.errText(e);
      }
    },

    /** 旧模型 del：DELETE（confirm 在视图层）。 */
    async removeModel(m: LlmModel) {
      this.llmErr = null;
      try {
        await api(`/api/admin/llm/models/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
        await this.loadProviders();
      } catch (e) {
        this.llmErr = t('admin.errorPrefix') + this.errText(e);
      }
    },

    /** 旧供应商下新增模型表单：POST /api/admin/llm/providers/<id>/models。 */
    async addModel(
      providerId: string,
      fields: { model_id: string; model: string; name: string; type: string; tool_calling: boolean; context_window: number | null; max_tokens: number | null; max_output_tokens?: number | null; input_cost_per_token?: number | null; output_cost_per_token?: number | null },
    ): Promise<string | null> {
      this.llmErr = null;
      try {
        await api(`/api/admin/llm/providers/${encodeURIComponent(providerId)}/models`, {
          method: 'POST',
          body: JSON.stringify(fields),
        });
        // 旧版成功后强制展开该供应商的模型明细
        if (!this.expandedProviders.includes(providerId)) this.expandedProviders.push(providerId);
        await this.loadProviders();
        return null;
      } catch (e) {
        this.llmErr = t('admin.errorPrefix') + this.errText(e);
        return this.llmErr;
      }
    },

    /** 编辑模型可变字段：PATCH /api/admin/llm/models/<id>。 */
    async updateModel(
      m: LlmModel,
      fields: { name: string; call_name?: string; type?: string; tool_calling: boolean; context_window?: number; max_tokens?: number | null; max_output_tokens?: number | null; model?: string; input_cost_per_token?: number | null; output_cost_per_token?: number | null },
    ): Promise<string | null> {
      this.llmErr = null;
      try {
        await api(`/api/admin/llm/models/${encodeURIComponent(m.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(fields),
        });
        await this.loadProviders();
        return this.llmErr;
      } catch (e) {
        this.llmErr = t('admin.errorPrefix') + this.errText(e);
        return this.llmErr;
      }
    },

    /** POST /api/admin/users；仅启用 TOTP 时创建一次性种子展示盒。 */
    async addUser(fields: {
      login: string;
      display_name: string;
      password: string;
      email: string;
      fde_name: string;
      git_host_id: string;
      llm: {
        provider_id: string;
        main_model_id: string;
        embedding_model_id?: string | null;
        vision_model_id?: string | null;
      };
      totpEnabled?: boolean;
    }): Promise<string | null> {
      this.fdeErr = null;
      this.lastReactivatedUserId = null;
      try {
        const body = {
          login: fields.login,
          display_name: fields.display_name,
          password: fields.password,
          email: fields.email,
          fde_name: fields.fde_name,
          git_host_id: fields.git_host_id,
          llm: fields.llm,
          totp_enabled: fields.totpEnabled === true,
        };
        const r = await api<TotpProvisionResponse>('/api/admin/users', { method: 'POST', body: JSON.stringify(body) });
        this.lastReactivatedUserId = r.reactivated === true ? r.user.id : null;
        // TOTP 种子仅此一次显示（红线）：只在服务端返回种子时构造展示盒。
        this.totpOnce = hasTotpProvision(r)
          ? await makeTotpOnce(r, r.reactivated === true ? 'reactivated' : 'created')
          : null;
        await this.loadUsers();
        return null;
      } catch (e) {
        this.fdeErr = t('admin.errorPrefix') + this.errText(e);
        return this.fdeErr;
      }
    },

    /**
     * issue #449：`GET /api/admin/mail/settings`（§4.12-2）。无行时服务端回 `200` + 默认 DTO（不是 404），
     * 所以「未配置」也走成功路径——页面据此显示默认形态而不是报错。
     *
     * 一次调用 = 一次请求（不做缓存短路：配置会被另一个管理员改，重进本页应当看到新快照）。
     * 失败面照本文件既有口径：`admin.errorPrefix` + 服务端 `error.message` **原文**（不翻译）。
     */
    async loadMailSettings(): Promise<string | null> {
      this.mailSettingsLoading = true;
      this.mailSettingsErr = null;
      try {
        const data = await api<unknown>(MAIL_SETTINGS_PATH);
        // 显式白名单归一化：DTO 里没有口令键，这里也不会带进来（§4.12-6 红线）。
        this.mailSettings = normalizeMailSettings(data);
        this.mailSettingsLoaded = true;
        return null;
      } catch (e) {
        this.mailSettingsErr = t('admin.errorPrefix') + this.errText(e);
        return this.mailSettingsErr;
      } finally {
        this.mailSettingsLoading = false;
      }
    },

    /**
     * issue #449：`PUT /api/admin/mail/settings`（§4.12-3）。成功 ⇒ 用响应 DTO 刷新状态（服务端已
     * `invalidate()`，改完立刻生效）。
     *
     * 400 时把 `details.field` 落到 `mailSaveField`（页面据此标红**那个**输入框并在其下显示 message），
     * 认不出字段名就不猜（`null` ⇒ 整表错误）。
     */
    async saveMailSettings(payload: MailSettingsPayload): Promise<string | null> {
      this.mailSaving = true;
      this.mailSaveErr = null;
      this.mailSaveField = null;
      this.mailSaveOk = false;
      try {
        const data = await api<unknown>(MAIL_SETTINGS_PATH, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        this.mailSettings = normalizeMailSettings(data);
        this.mailSettingsLoaded = true;
        this.mailSaveOk = true;
        return null;
      } catch (e) {
        this.mailSaveField = validationFieldOf(e);
        this.mailSaveErr = t('admin.errorPrefix') + this.errText(e);
        return this.mailSaveErr;
      } finally {
        this.mailSaving = false;
      }
    },

    /**
     * issue #485 片 A：`GET /api/admin/upload/settings`（§4.15-1）。
     *
     * 服务端在**表不存在 / 读失败**时也回 `200` + 兜底 DTO（`source` = `env`/`default`），所以这一页
     * 不需要处理「配置面挂了」的错路。一次调用 = 一次请求：生效值会被另一个管理员改，重进本页就该看到新快照。
     */
    async loadUploadSettings(): Promise<string | null> {
      this.uploadSettingsLoading = true;
      this.uploadSettingsErr = null;
      try {
        const data = await api<unknown>(UPLOAD_SETTINGS_PATH);
        this.uploadSettings = normalizeUploadSettings(data);
        this.uploadSettingsLoaded = true;
        return null;
      } catch (e) {
        this.uploadSettingsErr = t('admin.errorPrefix') + this.errText(e);
        return this.uploadSettingsErr;
      } finally {
        this.uploadSettingsLoading = false;
      }
    },

    /**
     * issue #485 片 A：`PUT /api/admin/upload/settings`（§4.15-2）。
     *
     * 成功 ⇒ 直接用响应 DTO 刷新状态：它出自 `RETURNING`，所以是**真落库的生效值**，不是回显输入
     * （本页要的就是“我以为的值 vs 实际生效的值”不分离）。后端无缓存 ⇒ 不需要重取，下一次上传就是新值。
     * 400 时把 `details.field` 落到 `uploadSaveField`（页面据此标红那个框）。
     */
    async saveUploadSettings(payload: UploadSettingsPayload): Promise<string | null> {
      this.uploadSaving = true;
      this.uploadSaveErr = null;
      this.uploadSaveField = null;
      this.uploadSaveOk = false;
      try {
        const data = await api<unknown>(UPLOAD_SETTINGS_PATH, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        this.uploadSettings = normalizeUploadSettings(data);
        this.uploadSettingsLoaded = true;
        this.uploadSaveOk = true;
        return null;
      } catch (e) {
        this.uploadSaveField = uploadValidationFieldOf(e);
        this.uploadSaveErr = t('admin.errorPrefix') + this.errText(e);
        return this.uploadSaveErr;
      } finally {
        this.uploadSaving = false;
      }
    },

    /**
     * issue #677 P2b：`GET /api/admin/runtime-settings`（§4.21）——每个旋钮的生效值 + 来源 + 生效方式。
     *
     * 服务端在**表不存在 / 读失败 / 读超时**时也回 `200`（回落 env/默认且 `source` 如实），所以这一页
     * 不需要处理「配置面挂了」那一条错路；一次调用 = 一次请求（不缓存，与后端同口径）。
     */
    async loadRuntimeSettings(): Promise<string | null> {
      this.runtimeSettingsLoading = true;
      this.runtimeSettingsErr = null;
      try {
        const data = await api<unknown>(RUNTIME_SETTINGS_PATH);
        this.runtimeSettings = normalizeRuntimeSettingsList(data);
        this.runtimeSettingsLoaded = true;
        return null;
      } catch (e) {
        // 读失败就是读失败：不把「拿不到列表」当成「registry 是空的」（空态与错误态是两句话）。
        this.runtimeSettings = [];
        this.runtimeSettingsErr = t('admin.errorPrefix') + this.errText(e);
        return this.runtimeSettingsErr;
      } finally {
        this.runtimeSettingsLoading = false;
      }
    },

    /**
     * issue #677 P2b：`PUT /api/admin/runtime-settings/{key}`（§4.21）——只改一个旋钮。
     *
     * 三条口径：
     *   · **解析不出整数就一个请求都不发**（`buildRuntimeSettingPayload` 返回 `null`）：发一个
     *     `null` 只是把「用户还没填」伪装成「用户填了个非法值」，还会洗一把服务端的写路。
     *     此时 `runtimeSaveField` 固定是 `'value'`（本层自己判的，不装成服务端回的）。
     *   · 解析得出整数就**照发**，越界不提前拦（服务端才是闸，§4.21 与 §4.15 / §4.19 同口径）。
     *   · 成功 ⇒ 用**响应 DTO** 回填那一行（它出自 `RETURNING` ⇒ 是真落库的值，不是回显输入）；
     *     响应里没有 `item` ⇒ 不回填不报成功，宁可说一句「没回数据」。
     *
     * 失败时本层只记下 `details.field`（哪一处），**不决定它显示在哪**：那一行还是整页一行，
     * 是渲染层按 field 分派的事（#702 review 的 LOW 就出在渲染层曾经两处同时渲染）。
     */
    async saveRuntimeSetting(key: string, draft: string): Promise<string | null> {
      // 已有旋钮在写 ⇒ 本次直接不做（**先判后清**：否则一次被丢弃的调用会把在写那一次的
      // err / saved 状态擦掉）。UI 侧 `runtimeSaving !== null` 就把每行的保存按钮都禁了，所以
      // 这条并发闸只能被直接调 store 的调用方碰到（本页把按钮禁了不等于后端禁了并发）。
      if (this.runtimeSaving !== null) return null;
      this.runtimeSavedKey = null;
      this.runtimeSaveErr = null;
      this.runtimeSaveField = null;
      const payload = buildRuntimeSettingPayload(draft);
      if (payload === null) {
        this.runtimeSaveField = 'value';
        this.runtimeSaveErr = t('admin.runtime.errNotInteger');
        return this.runtimeSaveErr;
      }
      this.runtimeSaving = key;
      try {
        const data = await api<unknown>(runtimeSettingSavePath(key), {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        const saved = normalizeRuntimeSettingSaved(data);
        if (saved === null) {
          this.runtimeSaveField = 'body';
          this.runtimeSaveErr = t('admin.runtime.errNoItem');
          return this.runtimeSaveErr;
        }
        this.runtimeSettings = replaceRuntimeSetting(this.runtimeSettings, saved);
        this.runtimeSettingsLoaded = true;
        this.runtimeSavedKey = saved.key;
        return null;
      } catch (e) {
        this.runtimeSaveField = runtimeSettingFieldOf(e);
        this.runtimeSaveErr = t('admin.errorPrefix') + this.errText(e);
        return this.runtimeSaveErr;
      } finally {
        this.runtimeSaving = null;
      }
    },

    /**
     * issue #596 片 B：`GET /api/admin/prompts`（§4.19-1）。
     *
     * 服务端在**表不存在 / 读失败 / 读超时**时也回 `200`（回落内置提示词），所以这一页不需要
     * 处理「配置面挂了」的错路；`reason` 会把「为什么现在用的是内置」说清（归一化在 lib）。
     * 一次调用 = 一次请求：另一个管理员随时可能改，重进本页就该看到新快照（与后端同口径：不缓存）。
     */
    async loadPlatformPrompts(): Promise<string | null> {
      this.platformPromptsLoading = true;
      this.platformPromptsErr = null;
      try {
        const data = await api<unknown>(PLATFORM_PROMPTS_PATH);
        this.platformPrompts = normalizePlatformPrompts(data);
        this.platformPromptsLoaded = true;
        this.platformPromptsReloadedAt = new Date().toISOString();
        return null;
      } catch (e) {
        this.platformPromptsErr = t('admin.errorPrefix') + this.errText(e);
        return this.platformPromptsErr;
      } finally {
        this.platformPromptsLoading = false;
      }
    },

    /**
     * issue #801：按工位取「实际生效的那一份」（§4.19-5）。**每次现读、不缓存**（口径同 `loadPlatformPrompts`）。
     * 读不到（工位没物化 / DB 回落）都是 200 + `disk.state` / `reason`，只有工位不存在与非法参数才是错。
     */
    async loadEffectiveAgentsMd(fdeName: string): Promise<string | null> {
      if (typeof fdeName !== 'string' || fdeName === '') {
        this.effectiveAgentsMd = null;
        this.effectiveAgentsMdErr = t('admin.prompts.effective.needFde');
        return this.effectiveAgentsMdErr;
      }
      this.effectiveAgentsMdLoading = true;
      this.effectiveAgentsMdErr = null;
      this.effectiveAgentsMdFde = fdeName;
      try {
        const data = await api<unknown>(effectiveAgentsMdPath(fdeName));
        this.effectiveAgentsMd = normalizeEffectiveAgentsMd(data);
        return null;
      } catch (e) {
        this.effectiveAgentsMd = null;
        this.effectiveAgentsMdErr = t('admin.errorPrefix') + this.errText(e);
        return this.effectiveAgentsMdErr;
      } finally {
        this.effectiveAgentsMdLoading = false;
      }
    },

    /**
     * issue #596 片 B：三个 `PUT /api/admin/prompts/{addendum,agents-md,title-prompt}`（§4.19-2）。
     *
     * 三个入口只决定 `field`（路径 slug 的映射在 lib，别处不抄字面量），其余同一套：
     *   · 成功 ⇒ **用响应 DTO 回填**（它出自 `RETURNING` ⇒ 是真落库的那一份，不是回显输入）；
     *   · 同时收下 `materializeEnqueued` 并折成语义结论 `promptNotice`（`0` / 缺键都是要显式
     *     说出口的事：「已保存，但物化未通知」，不许静默，§4.19-4）；
     *   · 失败 ⇒ `details.field` 落到 `promptSaveField`（页面据此标红那张卡的输入框）。
     *
     * 越界（字段上限 / **渲染后**整份 `~/AGENTS.md` 超注入上限）在前端**不拦**：服务端才是闸，
     * 它回 `400 validation_failed` 且**不落库**，前端只负责把那句话与那个框指出来。
     */
    async savePromptText(field: PromptFieldKey, text: unknown): Promise<string | null> {
      const payload = buildPromptPayload(text);
      if (payload === null) {
        // 连长度都算不出（不是字符串）⇒ 不发一个必然 400 的垃圾体。
        this.promptSaveField = field;
        this.promptSaveErr = t('admin.prompts.errNotText');
        this.promptSavedField = null;
        this.promptNotice = null;
        return this.promptSaveErr;
      }
      this.promptSaving = true;
      this.promptSaveErr = null;
      this.promptSaveField = null;
      this.promptSavedField = null;
      this.promptNotice = null;
      try {
        const data = await api<unknown>(platformPromptPath(field), {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        const next = normalizePlatformPrompts(data);
        this.platformPrompts = next;
        this.platformPromptsLoaded = true;
        this.promptSavedField = field;
        this.promptNotice = materializeNoticeOf(field, next.materializeEnqueued);
        return null;
      } catch (e) {
        this.promptSaveField = promptValidationFieldOf(e, field);
        this.promptSaveErr = t('admin.errorPrefix') + this.errText(e);
        return this.promptSaveErr;
      } finally {
        this.promptSaving = false;
      }
    },

    /** `PUT /api/admin/prompts/addendum`：`''` = 清空「平台补充约定」那一节。 */
    saveAddendumPrompt(text: unknown): Promise<string | null> {
      return this.savePromptText('addendum', text);
    },

    /** `PUT /api/admin/prompts/agents-md`：`''` = **恢复内置模板**（「恢复内置」按钮就是它）。 */
    saveAgentsMdPrompt(text: unknown): Promise<string | null> {
      return this.savePromptText('agentsMd', text);
    },

    /** `PUT /api/admin/prompts/title-prompt`：`''` = 用内置 `TITLE_SYSTEM_PROMPT`（不涉物化）。 */
    saveTitlePrompt(text: unknown): Promise<string | null> {
      return this.savePromptText('titlePrompt', text);
    },

    /**
     * issue #449：`POST /api/admin/mail/test`（§4.12-4）——用**已保存的**配置真发一封探活信。
     *
     * 四种失败面各自给人话（§4.12-4 的表）：`409 mail_not_configured` / `502 email_send_failed` /
     * `429 rate_limited`（带 `Retry-After` 秒数）各一个本地化前缀，其余走 `admin.errorPrefix`。
     * 服务端 `error.message` 一律**不翻译**（与本文件既有口径一致）；`details.reason` 走 `toDisplayText`，
     * 所以任何形状都不会渲染成 `[object Object]`。
     */
    async sendTestMail(to: string): Promise<string | null> {
      this.mailTesting = true;
      this.mailTestErr = null;
      this.mailTestReason = null;
      this.mailTestOk = null;
      try {
        const data = await api<{ ok?: unknown; to?: unknown; at?: unknown }>(MAIL_TEST_PATH, {
          method: 'POST',
          body: JSON.stringify({ to }),
        });
        this.mailTestOk = {
          to: typeof data?.to === 'string' ? data.to : to,
          at: typeof data?.at === 'string' ? data.at : null,
        };
        return null;
      } catch (e) {
        const reason = e instanceof Error
          ? toDisplayText((e as { details?: Record<string, unknown> }).details?.reason)
          : '';
        this.mailTestReason = reason === '' ? null : reason;
        this.mailTestErr = testMailErrorText(e);
        return this.mailTestErr;
      } finally {
        this.mailTesting = false;
      }
    },

    /**
     * issue #456 M2：`GET /api/admin/tls`（§4.13-2）——盘上证书现状 + 覆盖判定 + 真机校验缓存 + 备份。
     *
     * 无证书也是 `200` + `configured:false`（未配置是正常态，不是 404）⇒ 「未配置」走成功路径。
     * 一次调用 = 一次请求（不做缓存短路：证书会被另一个管理员换掉，重进本页应当看到新快照）。
     */
    async loadTls(): Promise<string | null> {
      this.tlsLoading = true;
      this.tlsError = null;
      try {
        const data = await api<unknown>(TLS_STATUS_PATH);
        this.tlsStatus = normalizeTlsStatus(data);
        return null;
      } catch (e) {
        this.tlsError = t('admin.errorPrefix') + this.errText(e);
        return this.tlsError;
      } finally {
        this.tlsLoading = false;
      }
    },

    /**
     * issue #456 M2：`POST /api/admin/tls/inspect`（§4.13-2a）——**解析但不落盘**。
     *
     * 请求体由视图构造（里面有 PEM，本文件不碰它的字段名）。零副作用端点 ⇒ 成功只更新 `tlsInspect`，
     * **不动** `tlsStatus`（盘上什么都没变，状态卡不该刷新）。
     */
    async inspectTls(body: TlsRequestBody): Promise<string | null> {
      this.tlsInspecting = true;
      this.tlsInspectErr = null;
      this.tlsInspect = null;
      // 新的一份草稿进场 ⇒ 上一次「已安装」的提示过期（否则它会一直挂在新一轮上传的表单旁边）。
      this.tlsSaveOk = false;
      try {
        const data = await api<unknown>(TLS_INSPECT_PATH, { method: 'POST', body: JSON.stringify(body) });
        const parsed = normalizeTlsInspect(data);
        if (parsed === null) {
          this.tlsInspectErr = t('admin.tls.inspectEmpty');
          return this.tlsInspectErr;
        }
        this.tlsInspect = parsed;
        return null;
      } catch (e) {
        this.tlsInspectErr = tlsErrorText(e);
        return this.tlsInspectErr;
      } finally {
        this.tlsInspecting = false;
      }
    },

    /**
     * issue #456 M2：`PUT /api/admin/tls`（§4.13-3）——确认安装。
     *
     * 成功 ⇒ 用响应 DTO 刷新状态卡、置 `tlsSaveOk`，并**丢掉解析结果**（那一份草稿已经装上了，
     * 留着只会让人以为还能再点一次）。失败 ⇒ `tlsSaveField` 收 `details.field` 原文（视图映射到输入框），
     * 文案走 `tlsErrorText`（按 code 分支 + 服务端 message 原文，**不翻译**）。
     */
    async saveTls(body: TlsRequestBody): Promise<string | null> {
      this.tlsSaving = true;
      this.tlsSaveErr = null;
      this.tlsSaveField = null;
      this.tlsSaveOk = false;
      try {
        const data = await api<unknown>(TLS_STATUS_PATH, { method: 'PUT', body: JSON.stringify(body) });
        this.tlsStatus = normalizeTlsStatus(data);
        this.tlsSaveOk = true;
        this.tlsInspect = null;
        return null;
      } catch (e) {
        this.tlsSaveField = tlsValidationFieldOf(e);
        this.tlsSaveErr = tlsErrorText(e);
        return this.tlsSaveErr;
      } finally {
        this.tlsSaving = false;
      }
    },

    /**
     * issue #456 M2：`POST /api/admin/tls/verify`（§4.13-4）——对管理台入口做一次真握手。
     *
     * 三种结果都在响应的 `live` 里（`live` / `mismatch` / `unreachable`）⇒ 成功路径刷新状态卡；
     * `unreachable` **不是** HTTP 错误，页面按灰态呈现（连不上不该锁住上传，工单 §2②）。
     */
    async verifyTls(): Promise<string | null> {
      this.tlsVerifying = true;
      this.tlsVerifyErr = null;
      try {
        const data = await api<unknown>(TLS_VERIFY_PATH, { method: 'POST', body: JSON.stringify({}) });
        this.tlsStatus = normalizeTlsStatus(data);
        return null;
      } catch (e) {
        this.tlsVerifyErr = tlsErrorText(e);
        return this.tlsVerifyErr;
      } finally {
        this.tlsVerifying = false;
      }
    },

    /**
     * issue #456 M2：`POST /api/admin/tls/rollback`（§4.13-5）——回滚到上一代。
     *
     * **调用方负责确认**（工单 §2④：确认前一个请求都不发）。无 prev ⇒ `404 tls_no_previous`，
     * 文案由 `tlsErrorText` 给「没有可回滚的上一代」。
     */
    async rollbackTls(): Promise<string | null> {
      this.tlsRollingBack = true;
      this.tlsRollbackErr = null;
      this.tlsRollbackOk = false;
      try {
        const data = await api<unknown>(TLS_ROLLBACK_PATH, { method: 'POST', body: JSON.stringify({}) });
        this.tlsStatus = normalizeTlsStatus(data);
        this.tlsRollbackOk = true;
        return null;
      } catch (e) {
        this.tlsRollbackErr = tlsErrorText(e);
        return this.tlsRollbackErr;
      } finally {
        this.tlsRollingBack = false;
      }
    },
  },
});
