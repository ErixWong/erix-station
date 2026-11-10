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

// issue #101 P3：前端自产文案（「错误：」前缀）走 i18n 单例——options store 非组件上下文，
// useI18n() 会抛 MUST_BE_CALL_SETUP_TOP，故统一走 i18n.global.t。
// 注意：服务端透传的 error.message（errText）不译，仅拼接前缀。
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
  role: 'fde' | 'admin';
  fde_name: string | null;
  status: 'active' | 'disabled' | 'awaiting_credential';
  totp_enabled: boolean;
  last_login_at: string | null;
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
  'display_name' | 'email' | 'mail_otp_enabled' | 'totp_login_enabled' | 'file_upload_enabled' | 'role' | 'fde_name'>> & {
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
    // issue #350：号池占用总览。`previewUsageLoaded` 与 `previewUsage` 分开：
    // 「还没请求」（loaded=false）与「服务端说一个被占段都没有」（loaded=true + 空数组）不是同一件事。
    previewUsage: null as PreviewPoolUsage | null,
    previewUsageLoaded: false,
    previewUsageLoading: false,
    previewUsageErr: null as string | null,
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
