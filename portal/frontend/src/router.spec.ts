// 全局守卫单测：/api/me 401 → /login；已登录访问 /login → /；非 admin 访问 /admin → /。
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import { createAppRouter } from './router';
import type { AuthUser } from './stores/auth';

const FDE_USER = {
  id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local',
} as AuthUser;
const ADMIN_USER = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local',
} as AuthUser;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetchMe(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(status, body)));
}

async function freshRouter() {
  setActivePinia(createPinia());
  // createAppRouter 注册了全局守卫；push 会 await 守卫（含 ensureMe 的 /api/me）完成。
  return createAppRouter(createMemoryHistory());
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('全局路由守卫', () => {
  it('未登录（/api/me 401）访问 / → 重定向 /login', async () => {
    fetchMe(401, { error: { code: 'unauthorized', message: 'unauthorized' } });
    const router = await freshRouter();
    await router.push('/');
    expect(router.currentRoute.value.path).toBe('/login');
  });

  it('已登录访问受保护路由 → 放行', async () => {
    fetchMe(200, { user: FDE_USER });
    const router = await freshRouter();
    await router.push('/');
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('已登录访问 /login → 回工作台 /', async () => {
    fetchMe(200, { user: FDE_USER });
    const router = await freshRouter();
    await router.push('/login');
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('非 admin 访问 /admin → 回工作台 /', async () => {
    fetchMe(200, { user: FDE_USER });
    const router = await freshRouter();
    await router.push('/admin');
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('admin 访问 /admin → 放行', async () => {
    fetchMe(200, { user: ADMIN_USER });
    const router = await freshRouter();
    await router.push('/admin');
    expect(router.currentRoute.value.path).toBe('/admin');
  });

  it('无 session cookie（无响应体 401）也能落到 /login', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    const router = await freshRouter();
    await router.push('/');
    expect(router.currentRoute.value.path).toBe('/login');
  });
});
