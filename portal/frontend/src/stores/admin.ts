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
  role: string;
  fde_name: string | null;
  status: string;
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

interface CreateUserResponse {
  user: AdminUser;
  totp_secret: string;
  totp_uri: string;
}

export const useAdminStore = defineStore('admin', {
  state: () => ({
    providers: [] as LlmProvider[],
    users: [] as AdminUser[],
    providersLoaded: false, // 「加载中…」空态用（旧 #providerList 初始文案）
    usersLoaded: false,
    llmErr: null as string | null, // 旧 showErr('llmErr', e)
    fdeErr: null as string | null,
    expandedProviders: [] as string[], // 旧 S.expanded（Set<string>，provider id）
    expandedUsers: [] as string[], // 旧 S.userExpanded
    totpOnce: null as TotpOnce | null, // 旧 #totpOnce 内联盒
  }),

  actions: {
    errText(err: unknown): string {
      return err instanceof Error ? err.message : String(err);
    },

    dismissTotpOnce() {
      this.totpOnce = null;
    },

    toggleExpandedProvider(id: string) {
      const i = this.expandedProviders.indexOf(id);
      if (i >= 0) this.expandedProviders.splice(i, 1);
      else this.expandedProviders.push(id);
    },

    toggleExpandedUser(id: string) {
      const i = this.expandedUsers.indexOf(id);
      if (i >= 0) this.expandedUsers.splice(i, 1);
      else this.expandedUsers.push(id);
    },

    /** 旧 loadProviders：GET /api/admin/llm/providers。 */
    async loadProviders() {
      this.llmErr = null;
      try {
        const data = await api<ProvidersResponse>('/api/admin/llm/providers');
        this.providers = data.items ?? [];
        this.providersLoaded = true;
      } catch (e) {
        this.llmErr = t('admin.errorPrefix') + this.errText(e);
      }
    },

    /** 旧 loadUsers：GET /api/admin/users。 */
    async loadUsers() {
      this.fdeErr = null;
      try {
        const data = await api<UsersResponse>('/api/admin/users');
        this.users = data.items ?? [];
        this.usersLoaded = true;
      } catch (e) {
        this.fdeErr = t('admin.errorPrefix') + this.errText(e);
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
      fields: { model_id: string; name: string; type: string; tool_calling: boolean; context_window: number | null },
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
      fields: { name: string; tool_calling: boolean; context_window?: number },
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
