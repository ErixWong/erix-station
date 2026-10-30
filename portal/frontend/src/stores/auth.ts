// auth store（pinia）：/api/me、/api/auth/login、/api/auth/login/totp、/api/auth/logout。
// 语义逐字段对照旧 portal/static/index.html 的 renderLogin()/boot()：
//   ① 未注册 TOTP → 密码直通建会话（响应含 user）；② 已注册 → pending_token 切第二步；
//   ③ 错误展示取服务端 error.message；④ 登出后回到未登录态。
import { defineStore } from 'pinia';
import { api, ApiError, toDisplayText } from '../api';
import { seatAwareLanding } from '../lib/workbenchGate';
// issue #431：「本轮用户结束」的应用级信号（接回工作台认领，详见 lib/userScope.ts）。
import { notifyUserScopeReset } from '../lib/userScope';

export interface AuthUser {
  id: string;
  login: string;
  display_name: string | null;
  role: string;
  fde_name: string | null;
  auth_source: string;
  /**
   * #255（portal.md §2.6）：当前会话是否**受限**（`users.must_change_password=true`，口令由管理员代设）。
   * 纯 additive：旧响应缺这个键按 `false` 处理（`=== true` 判定），存量部署与既有测试桩不因此改行为。
   */
  must_change_password?: boolean;
}

interface MeResponse {
  user: AuthUser;
}

interface LoginResponse {
  status?: string;
  user?: AuthUser;
  pending_token?: string;
  expires_in?: number;
  /**
   * #255（§2.2/§2.3）：本次下发的会话是否受限。**两个发会话的分支都带**（直通与 TOTP 第二步），
   * `totp_required` 中间响应与 401 失败响应都不带。后端保证「恒为布尔」，前端仍用 `=== true` 收口：
   * 缺字段 ⇒ false ⇒ 不会把所有人误挡在门外（前后端缺省同为「不受限」）。
   */
  password_change_required?: boolean;
}

/** 自助改密响应（§2.6a）。`password_change_required` 固定 false，但本单**不拿它做放行依据**（见 changeOwnPassword）。 */
interface ChangePasswordResponse {
  ok?: boolean;
  password_change_required?: boolean;
  sessions_revoked?: number;
}

/**
 * 受限会话改密失败态（前端 ② 的形状）：除了 `code`/`message`（① 口径：原样成字符串），
 * 还带 `status` / `details` / `retryAfter` ⇒ 文案映射表能把「下一步做什么」说完整
 * （哪个框不对、等多少秒、要不要重登），见 lib/forcePasswordErrors.ts。
 */
export interface ChangePasswordError {
  code: string;
  message: string;
  /** HTTP 状态码（0 = 非 HTTP 失败，如网络层报错）。 */
  status: number;
  /** 服务端 `error.details`（`validation_failed` 靠 `details.field` 指到输入框）。 */
  details?: Record<string, unknown>;
  /** `Retry-After` 秒数（429 / 503 带）。 */
  retryAfter?: number | null;
}

// afterLoginRoute：admin 且无 fde_name（平台管理员）→ /admin（默认重定向至 /admin/users）；其余回工作台。
// issue #332：判据与落点**不在这里抄第二份**——工作台准入闸（lib/workbenchGate.workbenchGateDecision）
// 与共用的 `seatAwareLanding` 是同一个函数 ⇒「登录后去哪」与「工作台放不放人」不可能漂移；
// 第 ② 类人（role=admin 但 fde_name 有值）两边都回 `/`（他能进工作台，也保留管理台入口）。
export function afterLoginRoute(user: AuthUser | null | undefined): string {
  return seatAwareLanding(user);
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null as AuthUser | null,
    pendingToken: null as string | null,
    // me 探测是否已完成（全局守卫据此决定跳不跳 /login，避免每次导航都打 /api/me）。
    ready: false,
    loading: false,
    error: null as string | null,
    /**
     * #255 受限会话旗标（唯一落点：App.vue 的闸门与路由守卫都只读它）。
     * ⚠ **只允许出在两个服务端回答上**：登录/ TOTP 响应的 `password_change_required`，或
     * `GET /api/me` 的 `user.must_change_password`。自助改密成功后必须重新拉 `GET /api/me` 才能翻回
     * false（见 `changeOwnPassword`）——本地直接置 false 会把一个仍然受限的会话放进工作台。
     */
    passwordChangeRequired: false,
    changePasswordError: null as ChangePasswordError | null,
  }),
  actions: {
    /** boot() 等价：GET /api/me；401/403 → 保持未登录（守卫跳 /login）。 */
    async ensureMe() {
      if (this.ready) return;
      try {
        const me = await api<MeResponse>('/api/me');
        this.user = me.user;
        // §2.6/§2.11a：本端点在受限会话门的放行清单里 ⇒ 它是**刷新后重建改密屏的唯一数据源**。
        this.passwordChangeRequired = me.user?.must_change_password === true;
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          this.user = null; // 未登录：守卫负责跳转
          this.passwordChangeRequired = false; // 没有会话就谈不上受限
        } else {
          this.ready = true;
          throw err;
        }
      } finally {
        this.ready = true;
      }
    },

    /**
     * 不受 `ready` 门禁的 `GET /api/me`：#255 改密成功后用它取**真实**旗标。
     * 这是「禁止本地把旗标改 false 就放行」的落点：放行的唯一依据是服务端此刻的回答。
     */
    async refreshMe() {
      const me = await api<MeResponse>('/api/me');
      this.user = me.user;
      this.passwordChangeRequired = me.user?.must_change_password === true;
      this.ready = true;
      return me.user;
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
          // #255：cookie 落下的这一刻就知道受限（§2.2），不等「先碰一个 403 再猜」。
          this.passwordChangeRequired = data.password_change_required === true;
        } else {
          // totp_required：进入第二步（旧版切 totpForm 显示）。本响应**不带**受限旗标（还没会话）。
          this.pendingToken = data.pending_token ?? null;
          this.passwordChangeRequired = false;
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
        const body = await api<MeResponse & LoginResponse>('/api/auth/login/totp', {
          method: 'POST',
          body: JSON.stringify({ pending_token: this.pendingToken, code: code.trim() }),
        });
        this.user = body.user;
        this.pendingToken = null;
        // §2.3：第二步才是本分支真正发会话的地方 ⇒ 受限旗标在这里带出去（口径与 §2.2 一致）。
        this.passwordChangeRequired = body.password_change_required === true;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.loading = false;
      }
    },

    /**
     * #255 自助改密（§2.6a `POST /api/me/password`）：body 三字段（旧/新/确认），
     * `Content-Type: application/json` 由 api() 的默认头给出（缺了它服务端直接 400 validation_failed）。
     *
     * 成功后**必须** `GET /api/me` 取真实旗标再放行：响应体里的 `password_change_required:false`
     * 只说明这一次调用成功，「现在到底还限不限」的真相只认 `GET /api/me`（与刷新后同一个数据源）。
     * 当前会话**保留**（服务端只吊销其它会话）⇒ 这里绝不跳登录页、绝不清 user。
     *
     * @returns 是否已解除限制（true ⇒ 闸门/守卫放行；false ⇒ 留在改密屏继续改）
     */
    async changeOwnPassword(payload: {
      current_password: string;
      new_password: string;
      confirm_password: string;
    }): Promise<boolean> {
      this.loading = true;
      this.error = null;
      this.changePasswordError = null;
      try {
        await api<ChangePasswordResponse>('/api/me/password', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        await this.refreshMe();
        return !this.passwordChangeRequired;
      } catch (err) {
        const apiErr = err instanceof ApiError ? err : null;
        this.changePasswordError = {
          code: apiErr ? toDisplayText(apiErr.code) : '',
          message: toDisplayText(err instanceof Error ? err.message : err),
          // 非 ApiError（fetch 抛 TypeError 等）没有状态码 ⇒ 0，文案侧退到 unknown_code 带「HTTP 0」。
          status: apiErr?.status ?? 0,
          details: apiErr?.details,
          retryAfter: apiErr?.retryAfter ?? null,
        };
        this.error = this.changePasswordError.message;
        return false;
      } finally {
        this.loading = false;
      }
    },

    /**
     * #255 全局兜底的**唯一旗标写点**（§2.11a）：任意请求返回 `403 password_change_required`
     * ⇒ 说明服务端认为这个会话欠一次改密（即便登录响应与上一轮 `GET /api/me` 都没这么说）。
     *
     * 调用方：`router.ts` 里注册的全局监听器（接线在 lib/restrictedSession.ts）。**视图不得直接调**：
     * 判码散进视图 ⇒ 第二个视图接入必漏。这里不改 `user`（会话仍然有效，§2.11a 的判据是「已认证」）。
     */
    markRestrictedSession() {
      this.passwordChangeRequired = true;
    },

    /**
     * #255：会话已死（改密时收到 401 `unauthorized`）⇒ 本地收摊，回登录页重登。
     * 不调服务端 logout（会话本来就没了），也**不能**留在改密屏反复撞 401。
     * 无会话 ⇒ 受限态一并清掉（否则 App 闸门会把登录页也挡死，与 `logout()` 同口径）。
     */
    forgetExpiredSession() {
      // issue #431：会话已死 ⇒ 同样先收摊（断 SSE + 清工作台的上一个账号可见面），再清 auth 态。
      notifyUserScopeReset();
      this.user = null;
      this.pendingToken = null;
      this.ready = true;
      this.passwordChangeRequired = false;
      this.error = null;
      // 保留 changePasswordError：改密屏已卸载，但下一轮进屏时 onSubmit 会重置它。
    },

    /** 返回重新登录：清 pendingToken/错误（旧版 location.reload() 的等价重置）。 */
    backToLogin() {
      this.pendingToken = null;
      this.error = null;
    },

    /** 登出：撤销服务端会话 + 清本地态（旧版 reload 走渲染未登录，SPA 改为跳 /login）。 */
    async logout() {
      // issue #431：**在 `await` 之前**先收摊——三颗登出按钮（工作台 / 管理台顶栏 / 强制改密屏）
      // 都只调本函数 ⇒ 它是唯一的汇合点；而工作台那条 SSE 不能等服务端回包（会话本来就可能已经死了，
      // 下面也 catch 了失败），晚一步就是一个带死会话的无限重连。具体后果见 lib/userScope.ts。
      notifyUserScopeReset();
      try {
        await api('/api/auth/logout', { method: 'POST' });
      } catch {
        // 会话已失效也按登出处理（旧版对 logout 失败不敏感，reload 后同样未登录态）。
      }
      this.user = null;
      this.pendingToken = null;
      this.error = null;
      // 登出后没有会话 ⇒ 受限态一并清掉（否则 App 的闸门会把登录页也挡死）。
      this.passwordChangeRequired = false;
      this.changePasswordError = null;
    },
  },
});
