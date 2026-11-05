// issue #449 管理台切片：`stores/admin.ts` 三个邮件 action 的单测（契约 `docs/api/portal.md` §4.12）。
//
// 只钉 store 的那一层（视图的渲染面在 `views/AdminMailView.spec.ts`）：
//   • `loadMailSettings`：成功归一化（DTO 白名单，口令永不进状态）／失败透传（本地化前缀 + 服务端 message 原文）；
//   • `saveMailSettings`：成功用响应 DTO 刷新 + 成功旗标／400 `details.field` 落到 `mailSaveField`；
//   • `sendTestMail`：成功拿 `{to, at}`／409・502・429 各自前缀（429 带 Retry-After 秒数）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAdminStore, testMailErrorText } from './admin';
import { normalizeTlsStatus } from '../lib/tlsSettings';
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

// ---------------------------------------------------------------------------
// issue #456 M2：证书页的五个 action（§4.13 / §4.13-2a）。
// 只钉 store 的那一层（渲染面在 `views/AdminTlsView.spec.ts`）：
//   • `loadTls`：DTO 白名单（状态里没有任何 PEM 字段）／失败透传；
//   • `inspectTls`：请求体原样透传、结果归一化、**不动** tlsStatus（零副作用端点）；
//   • `saveTls`：成功刷新状态 + 清掉解析草稿／400 `details.field` 原文落到 `tlsSaveField`；
//   • `verifyTls` / `rollbackTls`：状态刷新与 404 `tls_no_previous` 文案。
// ---------------------------------------------------------------------------

const TLS_STATUS = {
  configured: true,
  active: {
    subjectCN: '*.fde.erix.vip',
    sans: ['*.fde.erix.vip', 'fde.erix.vip'],
    issuerCN: '*.fde.erix.vip',
    notBefore: '2026-11-05T00:00:00.000Z',
    notAfter: '2027-02-03T00:00:00.000Z',
    fingerprintSha256: 'AB:CD:EF',
  },
  coverage: { adminHost: 'admin.fde.erix.vip', covered: true },
  live: { status: 'unknown', checkedAt: null },
  previous: null,
};

describe('loadTls（GET /api/admin/tls §4.13-2）', () => {
  it('成功：归一化 DTO、SAN 是数组、状态里没有任何 PEM 字段', async () => {
    const calls = stubFetch(() => jsonResponse(200, TLS_STATUS));
    const admin = useAdminStore();

    const err = await admin.loadTls();

    expect(err).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: '/api/admin/tls', method: 'GET' });
    expect(admin.tlsStatus).toMatchObject({
      configured: true,
      active: { subjectCN: '*.fde.erix.vip', sans: ['*.fde.erix.vip', 'fde.erix.vip'] },
      coverage: { adminHost: 'admin.fde.erix.vip', covered: true },
      live: { status: 'unknown', checkedAt: null },
      previous: null,
    });
    expect(admin.tlsLoading).toBe(false);
    expect(admin.tlsError).toBeNull();
    // 红线：状态里的键没有一个像 PEM
    expect(Object.keys(admin.$state).filter((key) => /pem|privatekey/i.test(key))).toEqual([]);
  });

  it('失败：本地化前缀 + 服务端 message 原文（不吞、不翻译）', async () => {
    stubFetch(() => errorResponse(403, 'forbidden', '需要管理员权限'));
    const admin = useAdminStore();

    const err = await admin.loadTls();

    expect(err).toBe('错误：需要管理员权限');
    expect(admin.tlsError).toBe('错误：需要管理员权限');
    expect(admin.tlsStatus).toBeNull();
    expect(admin.tlsLoading).toBe(false);
  });
});

describe('inspectTls（POST /api/admin/tls/inspect §4.13-2a）', () => {
  it('成功：请求体原样透传、结果归一化，且**不动** tlsStatus（零副作用端点）', async () => {
    const calls = stubFetch(() => jsonResponse(200, {
      cert: TLS_STATUS.active,
      keyMatches: true,
      coverage: { adminHost: 'admin.fde.erix.vip', covered: true },
      warnings: [],
    }));
    const admin = useAdminStore();
    admin.tlsStatus = normalizeTlsStatus(TLS_STATUS);

    const err = await admin.inspectTls({ certPem: 'CERT', keyPem: 'KEY' });

    expect(err).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: '/api/admin/tls/inspect',
      method: 'POST',
      body: { certPem: 'CERT', keyPem: 'KEY' },
    });
    expect(admin.tlsInspect).toMatchObject({ keyMatches: true, warnings: [] });
    expect(admin.tlsInspect?.cert.sans).toEqual(['*.fde.erix.vip', 'fde.erix.vip']);
    expect(admin.tlsInspecting).toBe(false);
    // 盘上什么都没变 ⇒ 状态卡不该被 inspect 改写
    expect(admin.tlsStatus?.active?.fingerprintSha256).toBe('AB:CD:EF');
  });

  it('400 tls_cert_invalid ⇒ 文案带码 + 服务端 message；tlsInspect 保持 null', async () => {
    stubFetch(() => errorResponse(400, 'tls_cert_invalid', '证书 PEM 无法解析'));
    const admin = useAdminStore();

    const err = await admin.inspectTls({ certPem: 'garbage' });

    expect(err).toContain('tls_cert_invalid');
    expect(err).toContain('证书 PEM 无法解析');
    expect(admin.tlsInspect).toBeNull();
    expect(admin.tlsInspecting).toBe(false);
  });
});

describe('saveTls（PUT /api/admin/tls §4.13-3）', () => {
  it('成功：状态用响应 DTO 刷新、置 tlsSaveOk，并丢掉解析草稿', async () => {
    stubFetch(() => jsonResponse(200, { ...TLS_STATUS, live: { status: 'unknown', checkedAt: null } }));
    const admin = useAdminStore();
    admin.tlsInspect = {
      cert: normalizeTlsStatus(TLS_STATUS).active!,
      keyMatches: true,
      coverage: { adminHost: 'admin.fde.erix.vip', covered: true },
      warnings: [],
    };

    const err = await admin.saveTls({ certPem: 'CERT', keyPem: 'KEY', confirmDomains: ['admin.fde.erix.vip'] });

    expect(err).toBeNull();
    expect(admin.tlsSaveOk).toBe(true);
    expect(admin.tlsSaving).toBe(false);
    expect(admin.tlsStatus?.configured).toBe(true);
    expect(admin.tlsInspect, '装上了就不该留着那份草稿').toBeNull();
  });

  it('400 + details.field=confirmDomains ⇒ `tlsSaveField` 收原文（视图负责映射到输入框）', async () => {
    stubFetch(() => errorResponse(400, 'tls_cert_domain_mismatch', 'confirmDomains 里有证书覆盖不到的名字', {
      missing: ['nope.example'],
      field: 'confirmDomains',
    }));
    const admin = useAdminStore();

    const err = await admin.saveTls({ certPem: 'CERT', keyPem: 'KEY', confirmDomains: ['nope.example'] });

    expect(err).toContain('tls_cert_domain_mismatch');
    expect(err).toContain('nope.example');
    expect(admin.tlsSaveField).toBe('confirmDomains');
    expect(admin.tlsSaveOk).toBe(false);
    expect(admin.tlsSaving).toBe(false);
  });
});

describe('verifyTls / rollbackTls（§4.13-4 / §4.13-5）', () => {
  it('verify 成功：live 三态之一刷新进状态（unreachable 也是成功路径，不是错误）', async () => {
    stubFetch(() => jsonResponse(200, {
      ...TLS_STATUS,
      live: { status: 'unreachable', checkedAt: '2026-11-05T09:12:31.004Z', error: 'ECONNREFUSED' },
    }));
    const admin = useAdminStore();

    const err = await admin.verifyTls();

    expect(err).toBeNull();
    expect(admin.tlsStatus?.live).toMatchObject({ status: 'unreachable', error: 'ECONNREFUSED' });
    expect(admin.tlsVerifying).toBe(false);
    expect(admin.tlsVerifyErr).toBeNull();
  });

  it('rollback 成功 ⇒ 状态刷新 + tlsRollbackOk；404 tls_no_previous ⇒ 专属文案', async () => {
    stubFetch(() => jsonResponse(200, { ...TLS_STATUS, previous: null }));
    const admin = useAdminStore();
    expect(await admin.rollbackTls()).toBeNull();
    expect(admin.tlsRollbackOk).toBe(true);
    expect(admin.tlsRollingBack).toBe(false);

    stubFetch(() => errorResponse(404, 'tls_no_previous', '没有可回滚的上一代证书'));
    const err = await admin.rollbackTls();
    expect(err).toContain('tls_no_previous');
    expect(err).toContain('没有可回滚的上一代');
    expect(admin.tlsRollbackOk).toBe(false);
  });
});
