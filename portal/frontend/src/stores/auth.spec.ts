// auth store 单测：mock fetch 覆盖 /api/me、login 直通、TOTP 两步、401/403 分支、登出。
// 语义对照 portal/static/index.html renderLogin()/boot()。
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAuthStore, afterLoginRoute } from './auth';

const FDE_USER = {
  id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local',
};
const ADMIN_USER = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  });
}

beforeEach(() => setActivePinia(createPinia()));
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
