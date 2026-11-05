// auth store（pinia）：/api/me、/api/auth/login、/api/auth/login/totp、/api/auth/login/email-code、
// /api/auth/login/email-code/resend、/api/auth/logout。
// 语义逐字段对照旧 portal/static/index.html 的 renderLogin()/boot()：
//   ① 未注册 TOTP 且邮件通道未启用 → 密码直通建会话（响应含 user）；② 已注册 TOTP → pending_token 切第二步；
//   ③ 错误展示取服务端 error.message；④ 登出后回到未登录态。
// issue #449：② 的第二步现在有**两条通道**（`factor`）——`'totp'`（现状，一字不改）与 `'email'`（邮箱验证码，
// portal.md §2.2/§2.3a/§2.3b）。两条通道共用同一枚 `pending_token`，故它的生命周期只由本 store 决定。
import { defineStore } from 'pinia';
import { api, ApiError, toDisplayText } from '../api';
import { seatAwareLanding } from '../lib/workbenchGate';
// issue #431：「本轮用户结束」的应用级信号（接回工作台认领，详见 lib/userScope.ts）。
import { notifyUserScopeReset } from '../lib/userScope';
// #449：非组件上下文取词（与 workbench store 同一口径：i18n.global.t，随 locale 响应式取值）。
import { i18n } from '../i18n';

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

/** #449：登录第二步走哪条通道（`null` = 还在第一步 / 已登录）。 */
export type LoginSecondFactor = 'totp' | 'email';

interface LoginResponse {
  status?: string;
  user?: AuthUser;
  pending_token?: string;
  expires_in?: number;
  /** #449（§2.2）：`email_code_required` 带的脱敏收件人（`a***@e***.com`），只用于「发到哪个邮箱了」。 */
  email_hint?: string;
  /**
   * #255（§2.2/§2.3）：本次下发的会话是否受限。**两个发会话的分支都带**（直通与 TOTP 第二步），
   * `totp_required` 中间响应与 401 失败响应都不带。后端保证「恒为布尔」，前端仍用 `=== true` 收口：
   * 缺字段 ⇒ false ⇒ 不会把所有人误挡在门外（前后端缺省同为「不受限」）。
   */
  password_change_required?: boolean;
}

/** #449（§2.3b）重发响应：新码有效期 + 下一次允许重发的冷却秒数。 */
interface ResendEmailCodeResponse {
  expires_in?: number;
  resend_after?: number;
}

/**
 * #449：邮箱验证码这条链路上的错误码 → 本地化文案（`errors.*`）。
 * 只收录**本单新增**的码；其余（`invalid_credentials` / `rate_limited` / `totp_invalid` …）一律退回服务端
 * `error.message`（`toDisplayText` 收口）——TOTP 与口令直通两条既有路径的文案因此一字不改。
 */
const EMAIL_LOGIN_ERROR_KEYS = {
  email_code_invalid: 'errors.emailCodeInvalid',
  email_not_registered: 'errors.emailNotRegistered',
  email_send_failed: 'errors.emailSendFailed',
  pending_expired: 'errors.pendingExpired',
} as const;

type EmailLoginErrorCode = keyof typeof EMAIL_LOGIN_ERROR_KEYS;

function isEmailLoginErrorCode(code: string | undefined): code is EmailLoginErrorCode {
  return code !== undefined && Object.prototype.hasOwnProperty.call(EMAIL_LOGIN_ERROR_KEYS, code);
}

/**
 * 错误 → 可展示文案：本单新增的码走 i18n（`errors.*`），其余原样取服务端 message。
 * 服务端 message 仍是唯一真相的兜底（`toDisplayText`：非字符串/对象也不至于渲染成 `[object Object]`）。
 */
function loginErrorText(err: unknown): string {
  const apiErr = err instanceof ApiError ? err : null;
  if (isEmailLoginErrorCode(apiErr?.code)) {
    return i18n.global.t(EMAIL_LOGIN_ERROR_KEYS[apiErr.code]);
  }
  return toDisplayText(err instanceof Error ? err.message : err);
}

/** #449：`401 pending_expired`——pending 过期/不存在/已消费（§2.3a），第二步不可能再成功。 */
function isPendingExpired(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'pending_expired';
}

/** #449：`503 email_send_failed`（发信失败，`retryable: true`，pending 不作废）。 */
function isEmailSendFailed(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'email_send_failed';
}

/**
 * #449：第一步发信失败（§2.2 的 `503 email_send_failed`）——`details` 里带着 `pending_token`，
 * 那是客户端**唯一**能拿到这枚令牌的时机（服务端已经把 pending 建好了，只是信没发出去）。
 * 收下它 ⇒ 用户点「重新发送」即可，**不必回去重输口令**。
 *
 * 没有 `pending_token` 时返回 `null`：没有令牌就进不了第二步，只能按普通错误展示。
 */
function emailSendFailurePatch(err: unknown): { pendingToken: string; emailHint: string | null } | null {
  if (!isEmailSendFailed(err)) return null;
  const details = (err as ApiError).details ?? {};
  const token = typeof details.pending_token === 'string' ? details.pending_token : '';
  if (!token) return null;
  return {
    pendingToken: token,
    emailHint: typeof details.email_hint === 'string' ? details.email_hint : null,
  };
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
    /**
     * #449：第二步走哪条通道。**与 `pendingToken` 同生共死**——pending 只对签发它的那条通道有效
     * （`/login/totp` 与 `/login/email-code` 是两个端点），所以所有清 pending 的地方都走 `resetPendingLogin()`。
     */
    factor: null as LoginSecondFactor | null,
    /** #449：脱敏收件人（`email_hint`），只用于「验证码发到哪个邮箱了」。 */
    emailHint: null as string | null,
    /** #449：发信失败（503 `email_send_failed`）——UI 把按钮换成「重新发送」，且不受冷却限制（服务端此时还没有码行）。 */
    sendFailed: false,
    /**
     * #449：距下一次可以再试的**秒数**（`resend_after` 或 `Retry-After`，见 §2.3a/§2.3b）。
     * >0 时「重发验证码」按钮倒计时禁用；由视图的定时器每秒 `tickCooldown()` 递减。
     */
    cooldownSeconds: 0,
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

    /**
     * 第一步：login + password（§2.2 的四种响应）。
     * ① 直通 → user；② `totp_required` → 第二步（factor='totp'）；③ `email_code_required` → 第二步
     * （factor='email'）；④ `409 email_not_registered` / `503 email_send_failed` 走 catch。
     */
    async login(login: string, password: string) {
      this.loading = true;
      this.error = null;
      // 上一轮第二步的残留（含发信失败收下的 pending）先清干净：新的一次口令提交必须从干净的第一步开始。
      this.resetPendingLogin();
      try {
        const data = await api<LoginResponse>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ login: login.trim(), password }),
        });
        if (data.user) {
          this.user = data.user;
          this.resetPendingLogin();
          // #255：cookie 落下的这一刻就知道受限（§2.2），不等「先碰一个 403 再猜」。
          this.passwordChangeRequired = data.password_change_required === true;
        } else if (data.status === 'email_code_required') {
          // #449（§2.2）：邮箱验证码第二步。本响应**不带**受限旗标（还没会话，§2.3a 的成功响应才带）。
          this.pendingToken = data.pending_token ?? null;
          this.factor = 'email';
          this.emailHint = data.email_hint ?? null;
          this.passwordChangeRequired = false;
        } else {
          // totp_required：进入第二步（旧版切 totpForm 显示）。本响应**不带**受限旗标（还没会话）。
          this.pendingToken = data.pending_token ?? null;
          this.factor = 'totp';
          this.passwordChangeRequired = false;
        }
      } catch (err) {
        // #449：503 `email_send_failed` **不是致命错误**——服务端把 pending 建好了、只是信没发出去，
        // `details` 里带着令牌 ⇒ 收下它直接进第二步（「重新发送」），用户不必重输口令。
        const patch = emailSendFailurePatch(err);
        if (patch) {
          this.pendingToken = patch.pendingToken;
          this.emailHint = patch.emailHint;
          this.factor = 'email';
          this.sendFailed = true;
          // 服务端此时**一条码行都没有**（§2.3b 的评审返修 ①）⇒ 没有冷却可言，重发不该被卡。
          this.cooldownSeconds = 0;
          this.error = i18n.global.t('errors.emailSendFailed');
          return;
        }
        this.error = loginErrorText(err);
      } finally {
        this.loading = false;
      }
    },

    /** 第二步（TOTP，§2.3）：pending_token + code → 建会话。 */
    async submitTotp(code: string) {
      this.loading = true;
      this.error = null;
      try {
        const body = await api<MeResponse & LoginResponse>('/api/auth/login/totp', {
          method: 'POST',
          body: JSON.stringify({ pending_token: this.pendingToken, code: code.trim() }),
        });
        this.user = body.user;
        this.resetPendingLogin();
        // §2.3：第二步才是本分支真正发会话的地方 ⇒ 受限旗标在这里带出去（口径与 §2.2 一致）。
        this.passwordChangeRequired = body.password_change_required === true;
      } catch (err) {
        // #449：pending 过期/已用 ⇒ 第二步不可能再成功，回第一步（文案仍是服务端原文，TOTP 路径一字不改）。
        if (isPendingExpired(err)) this.resetPendingLogin();
        this.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.loading = false;
      }
    },

    /**
     * 第二步（邮箱验证码，#449 §2.3a）：`pending_token + code` → 建会话（成功响应与 §2.3 逐字同口径）。
     * 失败：`401 email_code_invalid`（码错/过期/次数用尽）⇒ **留在第二步**可重发；
     * `401 pending_expired` ⇒ 清干净回第一步；`429 rate_limited` ⇒ `Retry-After` 落成可显示的秒数。
     */
    async submitEmailCode(code: string) {
      this.loading = true;
      this.error = null;
      try {
        const body = await api<MeResponse & LoginResponse>('/api/auth/login/email-code', {
          method: 'POST',
          body: JSON.stringify({ pending_token: this.pendingToken, code: code.trim() }),
        });
        this.user = body.user;
        this.resetPendingLogin();
        // §2.3a：与 §2.3 同口径——第二步才是真正发会话的地方，受限旗标在这里带出去。
        this.passwordChangeRequired = body.password_change_required === true;
      } catch (err) {
        if (isPendingExpired(err)) {
          // pending 没了（过期/已消费）⇒ 第二步不可能再成功：清干净回第一步，并说清为什么。
          this.resetPendingLogin();
          this.error = i18n.global.t('errors.pendingExpired');
          return;
        }
        this.adoptRetryAfter(err);
        this.error = loginErrorText(err);
      } finally {
        this.loading = false;
      }
    },

    /**
     * 重发验证码（#449 §2.3b）：成功 ⇒ `resend_after` 落成冷却秒数；
     * `429 rate_limited`（冷却中/超次数/按 IP 的发信频率）⇒ 用 `Retry-After` 覆盖冷却；
     * `503 email_send_failed` ⇒ 标记 `sendFailed`（按钮回「重新发送」且**不受冷却限制**，§2.3b 评审返修 ①）。
     */
    async resendEmailCode() {
      this.loading = true;
      this.error = null;
      try {
        const body = await api<ResendEmailCodeResponse>('/api/auth/login/email-code/resend', {
          method: 'POST',
          body: JSON.stringify({ pending_token: this.pendingToken }),
        });
        this.sendFailed = false;
        this.cooldownSeconds = typeof body.resend_after === 'number' ? Math.max(0, body.resend_after) : 0;
      } catch (err) {
        if (isPendingExpired(err)) {
          this.resetPendingLogin();
          this.error = i18n.global.t('errors.pendingExpired');
          return;
        }
        if (isEmailSendFailed(err)) {
          // §2.3b 的 503 **不带** details（令牌本来就在手上）：不作废 pending、不设冷却，等用户再点。
          this.sendFailed = true;
          this.cooldownSeconds = 0;
        } else {
          this.sendFailed = false;
          this.adoptRetryAfter(err);
        }
        this.error = loginErrorText(err);
      } finally {
        this.loading = false;
      }
    },

    /**
     * #449：把 `Retry-After`（`ApiError.retryAfter`，秒）落成可显示的冷却秒数。
     * 校验被限流（429）与重发冷却（429）共用这一个字段：「等 N 秒再试」在两种情况下是同一句话，
     * 且校验被限流的这段时间里重发也没有意义。
     */
    adoptRetryAfter(err: unknown) {
      if (err instanceof ApiError && typeof err.retryAfter === 'number' && err.retryAfter > 0) {
        this.cooldownSeconds = err.retryAfter;
      }
    },

    /** #449：冷却倒计时的一秒（由视图的定时器驱动，到 0 即停）。 */
    tickCooldown() {
      if (this.cooldownSeconds > 0) this.cooldownSeconds -= 1;
    },

    /**
     * #449：清掉「第二步」的全部本地态。**pending 是一个人的凭证**（#428/#431 的纪律）——
     * 换账号 / 登出 / 会话过期 / 回第一步 / 登录成功，五条路径都只走这里，不各清各的。
     */
    resetPendingLogin() {
      this.pendingToken = null;
      this.factor = null;
      this.emailHint = null;
      this.sendFailed = false;
      this.cooldownSeconds = 0;
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
      // #449：登录第二步的待决凭证也属于「上一个人」，跟着一起清。
      this.resetPendingLogin();
      this.ready = true;
      this.passwordChangeRequired = false;
      this.error = null;
      // 保留 changePasswordError：改密屏已卸载，但下一轮进屏时 onSubmit 会重置它。
    },

    /** 返回重新登录：清 pendingToken/factor 与错误（旧版 location.reload() 的等价重置）。 */
    backToLogin() {
      this.resetPendingLogin();
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
      // #449：登出 = 换人的起点 ⇒ 第二步的待决凭证（pending/factor/sendFailed/冷却）一并清掉。
      this.resetPendingLogin();
      this.error = null;
      // 登出后没有会话 ⇒ 受限态一并清掉（否则 App 的闸门会把登录页也挡死）。
      this.passwordChangeRequired = false;
      this.changePasswordError = null;
    },
  },
});
