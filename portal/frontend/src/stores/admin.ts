// 管理台 store（pinia）：旧 portal/static/admin.html 内联状态/S/api 调用的逐行平移（issue #61 P3）。
// 后端零改动：全部走既有 /api/admin/* 端点（portal/src/http.js handleAdminApi）。
// 204 语义说明：DELETE 供应商/模型返回 204，现有 api() 的 r.json().catch(() => ({}))
// 已兼容（空体 → {}，调用方本就丢弃返回值），故 api.ts 无需改动（结论已核对 http.js）。
import { defineStore } from 'pinia';
import QRCode from 'qrcode';
import { api } from '../api';
import { i18n } from '../i18n';

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

export type AdminUserUpdate = Partial<Pick<AdminUser, 'display_name' | 'role' | 'fde_name'>> & {
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
  }),

  actions: {
    errText(err: unknown): string {
      return err instanceof Error ? err.message : String(err);
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
  },
});
