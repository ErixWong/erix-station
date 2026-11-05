// issue #449 管理台切片：`stores/admin.ts` 三个邮件 action 的单测（契约 `docs/api/portal.md` §4.12）。
//
// 只钉 store 的那一层（视图的渲染面在 `views/AdminMailView.spec.ts`）：
//   • `loadMailSettings`：成功归一化（DTO 白名单，口令永不进状态）／失败透传（本地化前缀 + 服务端 message 原文）；
//   • `saveMailSettings`：成功用响应 DTO 刷新 + 成功旗标／400 `details.field` 落到 `mailSaveField`；
//   • `sendTestMail`：成功拿 `{to, at}`／409・502・429 各自前缀（429 带 Retry-After 秒数）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAdminStore, testMailErrorText } from './admin';
import { setLocale } from '../i18n';

const SETTINGS = {
  transport: 'smtp',
  smtp: {
    host: 'relay.internal',
    port: 25,
    secure: false,
    user: 'svc',
    from: 'noreply@example.com',
    timeouts: { connectionMs: 10000, greetingMs: 10000, socketMs: 20000 },
  },
  hasPassword: true,
  updatedAt: '2026-11-05T08:12:31.004Z',
  updatedBy: '3f2c0000-0000-4000-8000-000000000000',
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(status, { error: { code, message, retryable: false, ...(details ? { details } : {}) } }, headers);
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(handler: (call: RecordedCall) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = typeof init?.body === 'string' ? init.body : null;
    const call: RecordedCall = { url, method, body: raw === null ? null : JSON.parse(raw) };
    calls.push(call);
    return handler(call);
  }));
  return calls;
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadMailSettings（GET §4.12-2）', () => {
  it('成功：归一化 DTO、置 loaded、清 loading，且状态里没有口令键', async () => {
    const calls = stubFetch(() => jsonResponse(200, SETTINGS));
    const admin = useAdminStore();

    const err = await admin.loadMailSettings();

    expect(err).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: '/api/admin/mail/settings', method: 'GET' });
    expect(admin.mailSettings).toMatchObject({
      transport: 'smtp',
      hasPassword: true,
      smtp: { host: 'relay.internal', port: 25, secure: false, from: 'noreply@example.com' },
    });
    expect(admin.mailSettingsLoaded).toBe(true);
    expect(admin.mailSettingsLoading).toBe(false);
    expect(admin.mailSettingsErr).toBeNull();
    expect(Object.hasOwn(admin.mailSettings as object, 'password')).toBe(false);
  });

  it('失败：错误串 = 本地化前缀 + 服务端 message 原文（不翻译、不吞），loaded 不置位', async () => {
    stubFetch(() => errorResponse(403, 'forbidden', '需要管理员权限'));
    const admin = useAdminStore();

    const err = await admin.loadMailSettings();

    expect(err).toBe('错误：需要管理员权限');
    expect(admin.mailSettingsErr).toBe('错误：需要管理员权限');
    expect(admin.mailSettingsLoaded).toBe(false);
    expect(admin.mailSettingsLoading).toBe(false);
  });
});

describe('saveMailSettings（PUT §4.12-3）', () => {
  it('成功：用响应 DTO 刷新状态、置 mailSaveOk、清掉旧的字段错误', async () => {
    stubFetch(() => jsonResponse(200, { ...SETTINGS, smtp: { ...SETTINGS.smtp, host: 'relay2.internal' } }));
    const admin = useAdminStore();
    admin.mailSaveField = 'host';
    admin.mailSaveErr = '旧错误';

    const err = await admin.saveMailSettings({
      transport: 'smtp',
      smtp: {
        host: 'relay2.internal', port: 25, secure: false, user: 'svc', from: 'noreply@example.com',
        timeouts: { connectionMs: 10000, greetingMs: 10000, socketMs: 20000 },
      },
    });

    expect(err).toBeNull();
    expect(admin.mailSaveOk).toBe(true);
    expect(admin.mailSaveErr).toBeNull();
    expect(admin.mailSaveField).toBeNull();
    expect(admin.mailSettings?.smtp.host).toBe('relay2.internal');
    expect(admin.mailSaving).toBe(false);
  });

  it('400 validation_failed + details.field=smtp.from ⇒ 落到 mailSaveField（视图据此标红那个框）', async () => {
    stubFetch(() => errorResponse(400, 'validation_failed', 'smtp.from 必须是有效邮箱地址', { field: 'smtp.from' }));
    const admin = useAdminStore();

    const err = await admin.saveMailSettings({
      transport: 'smtp',
      smtp: {
        host: 'relay.internal', port: 25, secure: false, user: '', from: 'nope',
        timeouts: { connectionMs: 10000, greetingMs: 10000, socketMs: 20000 },
      },
    });

    expect(err).toBe('错误：smtp.from 必须是有效邮箱地址');
    expect(admin.mailSaveField).toBe('from');
    expect(admin.mailSaveOk).toBe(false);
    expect(admin.mailSaving).toBe(false);
  });

  it('非 400 的失败不指字段（认不出是哪个框就不猜）⇒ mailSaveField=null', async () => {
    stubFetch(() => errorResponse(500, 'internal', '服务端出错'));
    const admin = useAdminStore();

    const err = await admin.saveMailSettings({ transport: 'disabled', smtp: {
      host: '', port: null, secure: true, user: '', from: '',
      timeouts: { connectionMs: null, greetingMs: null, socketMs: null },
    } });

    expect(err).toBe('错误：服务端出错');
    expect(admin.mailSaveField).toBeNull();
  });
});

describe('sendTestMail（POST §4.12-4）', () => {
  const send = () => useAdminStore().sendTestMail('ops@example.com');

  it('成功：拿 {ok,to,at}，错误面清空', async () => {
    const calls = stubFetch(() => jsonResponse(200, { ok: true, to: 'ops@example.com', at: '2026-11-05T08:20:11.220Z' }));
    const admin = useAdminStore();

    const err = await send();

    expect(err).toBeNull();
    expect(calls[0]).toMatchObject({ url: '/api/admin/mail/test', method: 'POST' });
    expect(calls[0].body).toEqual({ to: 'ops@example.com' });
    expect(admin.mailTestOk).toEqual({ to: 'ops@example.com', at: '2026-11-05T08:20:11.220Z' });
    expect(admin.mailTestErr).toBeNull();
    expect(admin.mailTestReason).toBeNull();
    expect(admin.mailTesting).toBe(false);
  });

  it('409 mail_not_configured ⇒ 本地化前缀 + 服务端 message', async () => {
    stubFetch(() => errorResponse(409, 'mail_not_configured', '邮件通道未启用：请先到管理台配置 SMTP'));
    const admin = useAdminStore();

    const err = await send();

    expect(err).toBe('邮件通道未启用（409 mail_not_configured）：邮件通道未启用：请先到管理台配置 SMTP');
    expect(admin.mailTestOk).toBeNull();
    expect(admin.mailTesting).toBe(false);
  });

  it('502 email_send_failed ⇒ 前缀 + message，并把 details.reason 单独收起来', async () => {
    stubFetch(() => errorResponse(502, 'email_send_failed', '测试信发送失败', { reason: 'ECONNREFUSED relay.internal:25' }));
    const admin = useAdminStore();

    const err = await send();

    expect(err).toContain('502 email_send_failed');
    expect(err).toContain('测试信发送失败');
    expect(admin.mailTestReason).toBe('ECONNREFUSED relay.internal:25');
  });

  it('429 rate_limited + Retry-After=120 ⇒ 文案里是 120 秒', async () => {
    stubFetch(() => errorResponse(429, 'rate_limited', '太频繁', undefined, { 'Retry-After': '120' }));

    const err = await send();

    expect(err).toContain('120 秒');
    expect(err).not.toContain('undefined');
  });

  it('details.reason 是非字符串（对象）也不渲染成 [object Object]', async () => {
    stubFetch(() => errorResponse(502, 'email_send_failed', '测试信发送失败', { reason: { code: 'ETIMEDOUT' } }));
    const admin = useAdminStore();

    await send();

    expect(admin.mailTestReason).toContain('ETIMEDOUT');
    expect(admin.mailTestReason).not.toContain('[object Object]');
  });
});

describe('testMailErrorText（按 code 分支，不匹配 message）', () => {
  it('认不出的 code ⇒ 通用前缀 + message（不吞错误）', () => {
    expect(testMailErrorText({ code: 'forbidden', message: '无权访问' })).toBe('错误：无权访问');
  });

  it('429 但 Retry-After 不可解 ⇒ 退到不带秒数的版本', () => {
    expect(testMailErrorText({ code: 'rate_limited', message: '太频繁', retryAfter: null }))
      .toContain('请稍后再试');
  });

  it('非 Error 的抛出值也不出现 [object Object]', () => {
    expect(testMailErrorText({ message: { nested: true } })).toContain('nested');
    expect(testMailErrorText({ message: { nested: true } })).not.toContain('[object Object]');
  });
});
