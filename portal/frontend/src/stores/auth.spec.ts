// auth store 单测：mock fetch 覆盖 /api/me、login 直通、TOTP 两步、401/403 分支、登出。
// 语义对照 portal/static/index.html renderLogin()/boot()。
// issue #449：新增邮箱验证码通道（factor='email'，portal.md §2.2/§2.3a/§2.3b）的用例。
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAuthStore, afterLoginRoute } from './auth';
// issue #431：登出/会话过期必须触发「本轮用户结束」信号（收口三颗登出按钮）
import { setUserScopeResetListener } from '../lib/userScope';
// #449：断言文案时直接引用 locale（不手抄中文），并在每个用例前固定 zh-CN。
import { setLocale } from '../i18n';
import { zhCN } from '../i18n/locales/zh-CN';
// #449：换账号复位要跨到 workbench store（`resetForUserSwitch` 必须连带清 auth 的待决凭证）。
import { useWorkbenchStore } from './workbench';

const FDE_USER = {
  id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local',
};
const ADMIN_USER = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local',
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function fetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  // #449 的错误文案走 i18n（errors.*）⇒ 固定 zh-CN（jsdom 的 navigator.language 是 en-US，默认会被检测成 en）。
  setLocale('zh-CN');
});
afterEach(() => vi.unstubAllGlobals());

describe('ensureMe（boot 等价）', () => {
  it('已登录：200 user → 写入 user', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(200, { user: FDE_USER })));
    const auth = useAuthStore();
    await auth.ensureMe();
    expect(auth.user?.login).toBe('alice');
    expect(auth.ready).toBe(true);
  });

  it('未登录：401 → user 保持 null，ready 置位（守卫跳 /login）', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(401, { error: { code: 'unauthorized', message: 'unauthorized' } })));
    const auth = useAuthStore();
    await auth.ensureMe();
    expect(auth.user).toBeNull();
    expect(auth.ready).toBe(true);
  });

  it('403 同样视为未登录', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(403, { error: { code: 'forbidden', message: 'forbidden' } })));
    const auth = useAuthStore();
    await auth.ensureMe();
    expect(auth.user).toBeNull();
  });

  it('重复调用只打一次 /api/me', async () => {
    const fetchFn = fetchMock(() => jsonResponse(200, { user: FDE_USER }));
    vi.stubGlobal('fetch', fetchFn);
    const auth = useAuthStore();
    await auth.ensureMe();
    await auth.ensureMe();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('login 第一步', () => {
  it('未注册 TOTP：直通 user（trim login），pendingToken 为空', async () => {
    const fetchFn = fetchMock((url, init) => {
      expect(url).toBe('/api/auth/login');
      expect(JSON.parse(String(init?.body))).toEqual({ login: 'alice', password: 'secret' });
      return jsonResponse(200, { status: 'authenticated', user: FDE_USER });
    });
    vi.stubGlobal('fetch', fetchFn);
    const auth = useAuthStore();
    await auth.login('  alice  ', 'secret');
    expect(auth.user?.login).toBe('alice');
    expect(auth.pendingToken).toBeNull();
    expect(auth.error).toBeNull();
  });

  it('已注册 TOTP：pending_token 进入第二步', async () => {
    vi.stubGlobal('fetch', fetchMock(() =>
      jsonResponse(200, { status: 'totp_required', pending_token: 'ptok', expires_in: 120 })));
    const auth = useAuthStore();
    await auth.login('alice', 'secret');
    expect(auth.user).toBeNull();
    expect(auth.pendingToken).toBe('ptok');
  });

  it('401 invalid_credentials：展示服务端 message', async () => {
    vi.stubGlobal('fetch', fetchMock(() =>
      jsonResponse(401, { error: { code: 'invalid_credentials', message: '用户名或口令错误' } })));
    const auth = useAuthStore();
    await auth.login('alice', 'wrong');
    expect(auth.user).toBeNull();
    expect(auth.error).toBe('用户名或口令错误');
  });

  it('429 rate_limited：同样落 error', async () => {
    vi.stubGlobal('fetch', fetchMock(() =>
      jsonResponse(429, { error: { code: 'rate_limited', message: '尝试过于频繁，请稍后再试' } })));
    const auth = useAuthStore();
    await auth.login('alice', 'secret');
    expect(auth.error).toBe('尝试过于频繁，请稍后再试');
  });
});

describe('submitTotp 第二步', () => {
  it('成功：pending_token + code（trim）→ user，清 pendingToken', async () => {
    const fetchFn = fetchMock((url, init) => {
      expect(url).toBe('/api/auth/login/totp');
      expect(JSON.parse(String(init?.body))).toEqual({ pending_token: 'ptok', code: '123456' });
      return jsonResponse(200, { user: FDE_USER });
    });
    vi.stubGlobal('fetch', fetchFn);
    const auth = useAuthStore();
    auth.pendingToken = 'ptok';
    await auth.submitTotp(' 123456 ');
    expect(auth.user?.login).toBe('alice');
    expect(auth.pendingToken).toBeNull();
  });

  it('401 totp_invalid：错误落 error，pendingToken 保留（可重试，旧版语义）', async () => {
    vi.stubGlobal('fetch', fetchMock(() =>
      jsonResponse(401, { error: { code: 'totp_invalid', message: 'TOTP 校验失败' } })));
    const auth = useAuthStore();
    auth.pendingToken = 'ptok';
    await auth.submitTotp('000000');
    expect(auth.user).toBeNull();
    expect(auth.error).toBe('TOTP 校验失败');
    expect(auth.pendingToken).toBe('ptok');
  });

  it('401 pending_expired：提示重新登录', async () => {
    vi.stubGlobal('fetch', fetchMock(() =>
      jsonResponse(401, { error: { code: 'pending_expired', message: 'pending_token 过期或已使用，请重新登录' } })));
    const auth = useAuthStore();
    auth.pendingToken = 'ptok';
    await auth.submitTotp('123456');
    expect(auth.error).toBe('pending_token 过期或已使用，请重新登录');
  });
});

describe('backToLogin / logout', () => {
  it('backToLogin：清 pendingToken 与错误（第二步返回第一步）', async () => {
    const auth = useAuthStore();
    auth.pendingToken = 'ptok';
    auth.error = 'x';
    auth.backToLogin();
    expect(auth.pendingToken).toBeNull();
    expect(auth.error).toBeNull();
  });

  it('logout：POST /api/auth/logout 并清本地态', async () => {
    const fetchFn = fetchMock((url, init) => {
      expect(url).toBe('/api/auth/logout');
      expect(init?.method).toBe('POST');
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchFn);
    const auth = useAuthStore();
    auth.user = FDE_USER;
    await auth.logout();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(auth.user).toBeNull();
  });

  it('logout 失败（会话已失效）也清本地态', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(401, { error: { code: 'unauthorized', message: 'unauthorized' } })));
    const auth = useAuthStore();
    auth.user = FDE_USER;
    await auth.logout();
    expect(auth.user).toBeNull();
  });
});

describe('afterLoginRoute（旧版语义）', () => {
  it('admin 且无 fde_name → /admin', () => {
    expect(afterLoginRoute(ADMIN_USER)).toBe('/admin');
  });
  it('普通 FDE → /', () => {
    expect(afterLoginRoute(FDE_USER)).toBe('/');
  });
  it('带 fde_name 的 admin（FDE 兼管理员）→ /', () => {
    expect(afterLoginRoute({ ...ADMIN_USER, fde_name: 'root' })).toBe('/');
  });
});

// ---- issue #431：登出收口——「本轮用户结束」只有 auth 知道，由它统一通知 ----
// 为什么不在三颗登出按钮里各自认领：`WorkbenchView` 只是其中一颗（另外两颗是管理台顶栏与强制改密
// 屏），漏一颗的代价是上一个账号的 EventSource 带着死会话无限重连（`useEventStream.ts:467` 的
// 「自动重连」在这里不是特性而是漏点）。
describe('#431 auth 触发用户 scope 复位', () => {
  afterEach(() => setUserScopeResetListener(null));

  it('logout：**在发请求之前**就通知（SSE 不能等服务端回包）', async () => {
    const order: string[] = [];
    setUserScopeResetListener(() => order.push('reset'));
    vi.stubGlobal('fetch', fetchMock(() => {
      order.push('fetch');
      return new Response(null, { status: 204 });
    }));
    const auth = useAuthStore();
    auth.user = FDE_USER;
    await auth.logout();
    expect(order).toEqual(['reset', 'fetch']);
  });

  it('logout 失败（会话已死）同样通知——收摊不依赖服务端是否撤销成功', async () => {
    let notified = 0;
    setUserScopeResetListener(() => { notified += 1; });
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(401, { error: { code: 'unauthorized', message: 'unauthorized' } })));
    const auth = useAuthStore();
    auth.user = FDE_USER;
    await auth.logout();
    expect(notified).toBe(1);
  });

  it('forgetExpiredSession（改密时撞 401 ⇒ 回登录页重登）也通知', () => {
    let notified = 0;
    setUserScopeResetListener(() => { notified += 1; });
    const auth = useAuthStore();
    auth.user = FDE_USER;
    auth.forgetExpiredSession();
    expect(notified).toBe(1);
    expect(auth.user).toBeNull();
  });

  it('没有接线时静默（没进过工作台就没有要收的摊）', async () => {
    setUserScopeResetListener(null);
    vi.stubGlobal('fetch', fetchMock(() => new Response(null, { status: 204 })));
    const auth = useAuthStore();
    auth.user = FDE_USER;
    await expect(auth.logout()).resolves.toBeUndefined();
  });
});

// ---- issue #449：登录第二步的另一条通道——邮箱验证码（portal.md §2.2/§2.3a/§2.3b）----
// 断言口径：只碰**对外可观察的状态**（factor / pendingToken / emailHint / sendFailed / cooldownSeconds /
// error 文案 / 发出去的请求体），不碰内部实现细节。
describe('#449 第一步的四种响应', () => {
  it('totp_required → factor=totp（既有通道的判据，一字不改）', async () => {
    vi.stubGlobal('fetch', fetchMock(() =>
      jsonResponse(200, { status: 'totp_required', pending_token: 'ptok', expires_in: 120 })));
    const auth = useAuthStore();
    await auth.login('alice', 'secret');
    expect(auth.factor).toBe('totp');
    expect(auth.pendingToken).toBe('ptok');
    expect(auth.emailHint).toBeNull();
    expect(auth.sendFailed).toBe(false);
  });

  it('email_code_required → factor=email + 待决令牌 + 脱敏收件人（仍未登录）', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(200, {
      status: 'email_code_required', pending_token: 'ptok-mail', expires_in: 600, email_hint: 'a***@e***.com',
    })));
    const auth = useAuthStore();
    await auth.login('alice', 'secret');
    expect(auth.user).toBeNull();
    expect(auth.factor).toBe('email');
    expect(auth.pendingToken).toBe('ptok-mail');
    expect(auth.emailHint).toBe('a***@e***.com');
    expect(auth.sendFailed).toBe(false);
    expect(auth.cooldownSeconds).toBe(0);
    expect(auth.error).toBeNull();
  });

  it('authenticated → 直通登录，第二步状态清空', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(200, { status: 'authenticated', user: FDE_USER })));
    const auth = useAuthStore();
    await auth.login('alice', 'secret');
    expect(auth.user?.login).toBe('alice');
    expect(auth.factor).toBeNull();
    expect(auth.pendingToken).toBeNull();
  });

  it('409 email_not_registered → 本地化文案，停在第一步（factor 仍为 null）', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(409, {
      error: { code: 'email_not_registered', message: '当前账号未登记邮箱，无法接收登录验证码；请联系管理员补录邮箱后再登录' },
    })));
    const auth = useAuthStore();
    await auth.login('alice', 'secret');
    expect(auth.factor).toBeNull();
    expect(auth.pendingToken).toBeNull();
    expect(auth.user).toBeNull();
    expect(auth.error).toBe(zhCN.errors.emailNotRegistered);
  });

  it('503 email_send_failed → 收下 details.pending_token 直接进第二步（不把用户踢回口令）', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(503, {
      error: {
        code: 'email_send_failed',
        message: '验证码邮件发送失败，请稍后重试',
        retryable: true,
        details: { pending_token: 'ptok-503', expires_in: 600, email_hint: 'a***@e***.com' },
      },
    }, { 'Retry-After': '5' })));
    const auth = useAuthStore();
    await auth.login('alice', 'secret');
    // 这是客户端**唯一**能拿到令牌的时机（服务端已经把 pending 建好了，只是信没发出去）
    expect(auth.pendingToken).toBe('ptok-503');
    expect(auth.factor).toBe('email');
    expect(auth.emailHint).toBe('a***@e***.com');
    expect(auth.sendFailed).toBe(true); // UI 直接把按钮换成「重新发送」
    expect(auth.cooldownSeconds).toBe(0); // 服务端此时一条码行都没有 ⇒ 重发不该被冷却卡住
    expect(auth.user).toBeNull();
    expect(auth.error).toBe(zhCN.errors.emailSendFailed);
  });

  it('503 但 details 里没有 pending_token → 进不了第二步，按普通错误展示', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(503, {
      error: { code: 'email_send_failed', message: '验证码邮件发送失败，请稍后重试', retryable: true },
    })));
    const auth = useAuthStore();
    await auth.login('alice', 'secret');
    expect(auth.pendingToken).toBeNull();
    expect(auth.factor).toBeNull();
    expect(auth.sendFailed).toBe(false);
    expect(auth.error).toBe(zhCN.errors.emailSendFailed);
  });

  it('重新提交口令时清掉上一轮的第二步残留（含 503 收下的 pending）', async () => {
    const fetchFn = fetchMock(() => jsonResponse(401, { error: { code: 'invalid_credentials', message: '用户名或口令错误' } }));
    vi.stubGlobal('fetch', fetchFn);
    const auth = useAuthStore();
    auth.pendingToken = 'ptok-old';
    auth.factor = 'email';
    auth.sendFailed = true;
    await auth.login('alice', 'wrong');
    expect(auth.pendingToken).toBeNull();
    expect(auth.factor).toBeNull();
    expect(auth.sendFailed).toBe(false);
  });
});

describe('#449 submitEmailCode（§2.3a）', () => {
  /** 把 store 置成「第二步待校验」的样子。 */
  function pendingEmailAuth() {
    const auth = useAuthStore();
    auth.pendingToken = 'ptok-mail';
    auth.factor = 'email';
    auth.emailHint = 'a***@e***.com';
    return auth;
  }

  it('成功：pending_token + code（trim）→ 写入 user，第二步状态全清', async () => {
    const fetchFn = fetchMock((url, init) => {
      expect(url).toBe('/api/auth/login/email-code');
      expect(JSON.parse(String(init?.body))).toEqual({ pending_token: 'ptok-mail', code: '123456' });
      return jsonResponse(200, { password_change_required: false, user: FDE_USER });
    });
    vi.stubGlobal('fetch', fetchFn);
    const auth = pendingEmailAuth();
    auth.cooldownSeconds = 30;
    await auth.submitEmailCode(' 123456 ');
    expect(auth.user?.login).toBe('alice');
    expect(auth.pendingToken).toBeNull();
    expect(auth.factor).toBeNull();
    expect(auth.emailHint).toBeNull();
    expect(auth.cooldownSeconds).toBe(0);
    expect(auth.error).toBeNull();
  });

  it('成功且受限会话：password_change_required 落旗标（与 §2.3 同口径）', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(200, { password_change_required: true, user: FDE_USER })));
    const auth = pendingEmailAuth();
    await auth.submitEmailCode('123456');
    expect(auth.passwordChangeRequired).toBe(true);
  });

  it('401 email_code_invalid：留在第二步可重发（pending 保留）+ 本地化文案', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(401, {
      error: { code: 'email_code_invalid', message: '验证码错误或已失效' },
    })));
    const auth = pendingEmailAuth();
    await auth.submitEmailCode('000000');
    expect(auth.user).toBeNull();
    expect(auth.pendingToken).toBe('ptok-mail');
    expect(auth.factor).toBe('email');
    expect(auth.error).toBe(zhCN.errors.emailCodeInvalid);
  });

  it('401 pending_expired：清 pending/factor 回第一步 + 一条提示', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(401, {
      error: { code: 'pending_expired', message: 'pending_token 过期或已使用，请重新登录' },
    })));
    const auth = pendingEmailAuth();
    await auth.submitEmailCode('123456');
    expect(auth.pendingToken).toBeNull();
    expect(auth.factor).toBeNull();
    expect(auth.emailHint).toBeNull();
    expect(auth.user).toBeNull();
    expect(auth.error).toBe(zhCN.errors.pendingExpired);
  });

  it('429 rate_limited：Retry-After 变成可显示的秒数', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(429, {
      error: { code: 'rate_limited', message: '尝试过于频繁，请稍后再试', retryable: true },
    }, { 'Retry-After': '42' })));
    const auth = pendingEmailAuth();
    await auth.submitEmailCode('123456');
    expect(auth.cooldownSeconds).toBe(42);
    expect(auth.pendingToken).toBe('ptok-mail'); // 限流不清 pending
  });
});

describe('#449 resendEmailCode（§2.3b）', () => {
  function pendingEmailAuth() {
    const auth = useAuthStore();
    auth.pendingToken = 'ptok-mail';
    auth.factor = 'email';
    auth.emailHint = 'a***@e***.com';
    return auth;
  }

  it('成功：resend_after → 冷却秒数，并清掉 sendFailed', async () => {
    const fetchFn = fetchMock((url, init) => {
      expect(url).toBe('/api/auth/login/email-code/resend');
      expect(JSON.parse(String(init?.body))).toEqual({ pending_token: 'ptok-mail' });
      return jsonResponse(200, { expires_in: 600, resend_after: 60 });
    });
    vi.stubGlobal('fetch', fetchFn);
    const auth = pendingEmailAuth();
    auth.sendFailed = true;
    await auth.resendEmailCode();
    expect(auth.cooldownSeconds).toBe(60);
    expect(auth.sendFailed).toBe(false);
    expect(auth.error).toBeNull();
    expect(auth.pendingToken).toBe('ptok-mail');
  });

  it('429 冷却中：Retry-After → 冷却秒数', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(429, {
      error: { code: 'rate_limited', message: '请稍后再试', retryable: true },
    }, { 'Retry-After': '37' })));
    const auth = pendingEmailAuth();
    await auth.resendEmailCode();
    expect(auth.cooldownSeconds).toBe(37);
    expect(auth.pendingToken).toBe('ptok-mail');
  });

  it('503 email_send_failed：标记 sendFailed 且不设冷却（按钮回「重新发送」，§2.3b 评审返修 ①）', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(503, {
      error: { code: 'email_send_failed', message: '验证码邮件发送失败，请稍后重试', retryable: true },
    }, { 'Retry-After': '5' })));
    const auth = pendingEmailAuth();
    await auth.resendEmailCode();
    expect(auth.sendFailed).toBe(true);
    expect(auth.cooldownSeconds).toBe(0);
    expect(auth.pendingToken).toBe('ptok-mail'); // 令牌不作废，可立刻再点
    expect(auth.error).toBe(zhCN.errors.emailSendFailed);
  });

  it('401 pending_expired：回第一步', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(401, {
      error: { code: 'pending_expired', message: 'pending_token 过期或已使用，请重新登录' },
    })));
    const auth = pendingEmailAuth();
    await auth.resendEmailCode();
    expect(auth.pendingToken).toBeNull();
    expect(auth.factor).toBeNull();
    expect(auth.error).toBe(zhCN.errors.pendingExpired);
  });

  it('tickCooldown：每秒递减，到 0 停住（不为负）', () => {
    const auth = useAuthStore();
    auth.cooldownSeconds = 2;
    auth.tickCooldown();
    expect(auth.cooldownSeconds).toBe(1);
    auth.tickCooldown();
    expect(auth.cooldownSeconds).toBe(0);
    auth.tickCooldown();
    expect(auth.cooldownSeconds).toBe(0);
  });
});

// #428/#431 的纪律：pending 是**上一个人**的凭证——留着就会被下一个人拿去撞第二步端点。
describe('#449 换账号复位清第二步状态', () => {
  it('logout：pendingToken/factor/sendFailed/冷却/emailHint 一并清', async () => {
    vi.stubGlobal('fetch', fetchMock(() => new Response(null, { status: 204 })));
    const auth = useAuthStore();
    auth.user = FDE_USER;
    auth.pendingToken = 'ptok';
    auth.factor = 'email';
    auth.emailHint = 'a***@e***.com';
    auth.sendFailed = true;
    auth.cooldownSeconds = 60;
    await auth.logout();
    expect(auth.pendingToken).toBeNull();
    expect(auth.factor).toBeNull();
    expect(auth.emailHint).toBeNull();
    expect(auth.sendFailed).toBe(false);
    expect(auth.cooldownSeconds).toBe(0);
  });

  it('forgetExpiredSession（会话已死）同样清', () => {
    const auth = useAuthStore();
    auth.pendingToken = 'ptok';
    auth.factor = 'email';
    auth.sendFailed = true;
    auth.cooldownSeconds = 60;
    auth.forgetExpiredSession();
    expect(auth.pendingToken).toBeNull();
    expect(auth.factor).toBeNull();
    expect(auth.sendFailed).toBe(false);
    expect(auth.cooldownSeconds).toBe(0);
  });

  it('工作台换账号复位（resetForUserSwitch）连带清掉 auth 的第二步状态', () => {
    const auth = useAuthStore();
    auth.pendingToken = 'ptok';
    auth.factor = 'email';
    auth.emailHint = 'a***@e***.com';
    auth.sendFailed = true;
    auth.cooldownSeconds = 60;
    useWorkbenchStore().resetForUserSwitch();
    expect(auth.pendingToken).toBeNull();
    expect(auth.factor).toBeNull();
    expect(auth.emailHint).toBeNull();
    expect(auth.sendFailed).toBe(false);
    expect(auth.cooldownSeconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #449 二选一（`second_factor_choice`）：store 侧的通道解析与切换
// ---------------------------------------------------------------------------

describe('#449 second_factor_choice（二选一）', () => {
  const CHOICE = {
    status: 'second_factor_choice',
    pending_token: 'ptok-choice',
    expires_in: 600,
    methods: ['totp', 'email_code'],
    email_hint: 'e***@i***.com',
    email_sent: true,
  };

  it('methods 两条 ⇒ factor=totp（默认走较强的那条）、choiceMethods 两条、hint 收下', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(200, CHOICE)));
    const auth = useAuthStore();
    await auth.login('alice', 'secret');
    expect(auth.pendingToken).toBe('ptok-choice');
    expect(auth.factor).toBe('totp');
    expect(auth.choiceMethods).toEqual(['totp', 'email']);
    expect(auth.emailUnavailable).toBe(false);
    expect(auth.emailHint).toBe('e***@i***.com');
  });

  it('email_sent:false ⇒ 剥掉邮箱通道（前端不许自己补一个收不到信的入口）', async () => {
    vi.stubGlobal('fetch', fetchMock(() =>
      jsonResponse(200, { ...CHOICE, methods: ['totp'], email_sent: false, email_unavailable: true })));
    const auth = useAuthStore();
    await auth.login('alice', 'secret');
    expect(auth.emailUnavailable).toBe(true);
    expect(auth.choiceMethods).toEqual(['totp']);
  });

  it('methods 缺失或含未知值 ⇒ 退回只认 totp（一切以服务端为准，不猜）', async () => {
    vi.stubGlobal('fetch', fetchMock(() =>
      jsonResponse(200, { status: 'second_factor_choice', pending_token: 'ptok-choice', email_sent: true })));
    const a = useAuthStore();
    await a.login('alice', 'secret');
    expect(a.choiceMethods).toEqual(['totp']);

    vi.stubGlobal('fetch', fetchMock(() =>
      jsonResponse(200, { ...CHOICE, methods: ['sms', 'email_code'] })));
    const b = useAuthStore();
    await b.login('alice', 'secret');
    expect(b.choiceMethods, '未知值 sms 被丢弃，邮箱仍在').toEqual(['email']);
  });

  it('switchFactor：只改 factor；pendingToken / emailHint / 冷却一律不动（切换不重新登录、不重新发码）', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(200, CHOICE)));
    const auth = useAuthStore();
    await auth.login('alice', 'secret');
    auth.cooldownSeconds = 42;

    auth.switchFactor('email');
    expect(auth.factor).toBe('email');
    expect(auth.pendingToken).toBe('ptok-choice');
    expect(auth.emailHint).toBe('e***@i***.com');
    expect(auth.cooldownSeconds, '切换不该重置或触发冷却').toBe(42);
    expect(auth.error).toBeNull();

    auth.switchFactor('totp'); // 可逆
    expect(auth.factor).toBe('totp');
    expect(auth.pendingToken).toBe('ptok-choice');
  });

  it('单一通道（totp_required / email_code_required）⇒ switchFactor 空操作（不把用户切进一条进不了的路）', async () => {
    vi.stubGlobal('fetch', fetchMock(() =>
      jsonResponse(200, { status: 'totp_required', pending_token: 'ptok', expires_in: 120 })));
    const auth = useAuthStore();
    await auth.login('alice', 'secret');
    expect(auth.choiceMethods).toEqual([]);
    auth.switchFactor('email');
    expect(auth.factor).toBe('totp');

    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(200,
      { status: 'email_code_required', pending_token: 'ptok', expires_in: 600, email_hint: 'a***@e***.com' })));
    const mail = useAuthStore();
    await mail.login('alice', 'secret');
    expect(mail.choiceMethods).toEqual([]);
    mail.switchFactor('totp');
    expect(mail.factor).toBe('email');
  });

  it('回第一步（backToLogin）把可选通道一并作废：choiceMethods/emailUnavailable 归零', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(200, CHOICE)));
    const auth = useAuthStore();
    await auth.login('alice', 'secret');
    auth.switchFactor('email');
    auth.backToLogin();
    expect(auth.factor).toBeNull();
    expect(auth.choiceMethods).toEqual([]);
    expect(auth.emailUnavailable).toBe(false);
  });
});

describe('#449 二选一：email_sent 是邮箱通道的最终裁决', () => {
  it('methods 仍给两条但 email_sent:false ⇒ choiceMethods 只剩 totp（前端不靠 methods 单独放行）', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(200, {
      status: 'second_factor_choice',
      pending_token: 'ptok-choice',
      expires_in: 600,
      methods: ['totp', 'email_code'],
      email_hint: 'e***@i***.com',
      email_sent: false,
      email_unavailable: true,
    })));
    const auth = useAuthStore();
    await auth.login('alice', 'secret');
    expect(auth.emailUnavailable).toBe(true);
    expect(auth.choiceMethods).toEqual(['totp']);
    auth.switchFactor('email');
    expect(auth.factor, '切不进一条没有码的路').toBe('totp');
  });
});
