// auth store（pinia）：/api/me、/api/auth/login、/api/auth/login/totp、/api/auth/logout。
// 语义逐字段对照旧 portal/static/index.html 的 renderLogin()/boot()：
//   ① 未注册 TOTP → 密码直通建会话（响应含 user）；② 已注册 → pending_token 切第二步；
//   ③ 错误展示取服务端 error.message；④ 登出后回到未登录态。
import { defineStore } from 'pinia';
import { api, ApiError } from '../api';

export interface AuthUser {
  id: string;
  login: string;
  display_name: string | null;
  role: string;
  fde_name: string | null;
  auth_source: string;
}

interface MeResponse {
  user: AuthUser;
}

interface LoginResponse {
  status?: string;
  user?: AuthUser;
  pending_token?: string;
  expires_in?: number;
}

// afterLoginRoute：admin 且无 fde_name（平台管理员）→ /admin（默认重定向至 /admin/users）；其余回工作台。
export function afterLoginRoute(user: AuthUser): string {
  if (user && user.role === 'admin' && !user.fde_name) return '/admin';
  return '/';
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null as AuthUser | null,
    pendingToken: null as string | null,
    // me 探测是否已完成（全局守卫据此决定跳不跳 /login，避免每次导航都打 /api/me）。
    ready: false,
    loading: false,
    error: null as string | null,
  }),
  actions: {
    /** boot() 等价：GET /api/me；401/403 → 保持未登录（守卫跳 /login）。 */
    async ensureMe() {
      if (this.ready) return;
      try {
        const me = await api<MeResponse>('/api/me');
        this.user = me.user;
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          this.user = null; // 未登录：守卫负责跳转
        } else {
          this.ready = true;
          throw err;
        }
      } finally {
        this.ready = true;
      }
    },

    /** 第一步：login + password。直通 → user；TOTP 用户 → 切第二步（pendingToken）。 */
    async login(login: string, password: string) {
      this.loading = true;
      this.error = null;
      try {
        const data = await api<LoginResponse>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ login: login.trim(), password }),
        });
        if (data.user) {
          this.user = data.user;
          this.pendingToken = null;
        } else {
          // totp_required：进入第二步（旧版切 totpForm 显示）。
          this.pendingToken = data.pending_token ?? null;
        }
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.loading = false;
      }
    },

    /** 第二步：pending_token + TOTP code → 建会话。 */
    async submitTotp(code: string) {
      this.loading = true;
      this.error = null;
      try {
        const body = await api<MeResponse>('/api/auth/login/totp', {
          method: 'POST',
          body: JSON.stringify({ pending_token: this.pendingToken, code: code.trim() }),
        });
        this.user = body.user;
        this.pendingToken = null;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.loading = false;
      }
    },

    /** 返回重新登录：清 pendingToken/错误（旧版 location.reload() 的等价重置）。 */
    backToLogin() {
      this.pendingToken = null;
      this.error = null;
    },

    /** 登出：撤销服务端会话 + 清本地态（旧版 reload 走渲染未登录，SPA 改为跳 /login）。 */
    async logout() {
      try {
        await api('/api/auth/logout', { method: 'POST' });
      } catch {
        // 会话已失效也按登出处理（旧版对 logout 失败不敏感，reload 后同样未登录态）。
      }
      this.user = null;
      this.pendingToken = null;
      this.error = null;
    },
  },
});
