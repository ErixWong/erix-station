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
  name: string;
  type: string; // text | embedding | vision | rerank | audio-tts | audio-stt | image-gen
  tool_calling: boolean;
  context_window: number | null;
  enabled: boolean;
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
}

export interface GitHost {
  id: string;
  name: string;
  provider: 'gitea' | 'github' | 'gitlab';
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

interface CreateUserResponse {
  user: AdminUser;
  totp_secret: string;
  totp_uri: string;
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
        this.users = this.users.filter((user) => user.id !== id);
        return null;
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
      fields: { model_id: string; model: string; name: string; type: string; tool_calling: boolean; context_window: number | null },
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
      fields: { name: string; type?: string; tool_calling: boolean; context_window?: number; model?: string },
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

    /** 旧 addUserForm 提交：POST /api/admin/users → 一次性 TOTP 盒（qrcode data URL）。 */
    async addUser(fields: { login: string; display_name: string; password: string; fde_name?: string }): Promise<string | null> {
      this.fdeErr = null;
      try {
        const body: Record<string, string> = {
          login: fields.login,
          display_name: fields.display_name,
          password: fields.password,
        };
        if (fields.fde_name) body.fde_name = fields.fde_name;
        const r = await api<CreateUserResponse>('/api/admin/users', { method: 'POST', body: JSON.stringify(body) });
        // TOTP 种子仅此一次显示（红线）：旧版 qrcode(0,'M') + createDataURL(4,8) → toDataURL({M, scale:4, margin:8})。
        const qr = await QRCode.toDataURL(r.totp_uri, { errorCorrectionLevel: 'M', scale: 4, margin: 8 });
        this.totpOnce = { login: r.user.login, uri: r.totp_uri, secret: r.totp_secret, qr };
        await this.loadUsers();
        return null;
      } catch (e) {
        this.fdeErr = t('admin.errorPrefix') + this.errText(e);
        return this.fdeErr;
      }
    },
  },
});
