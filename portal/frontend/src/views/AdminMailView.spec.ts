// issue #449 管理台切片「邮件通道配置」视图单测（`AdminMailView.vue`，契约 `docs/api/portal.md` §4.12）。
//
// 装配风格：直接挂载视图（本页不依赖路由）+ 真实 i18n 单例 + pinia + 按 URL 分派的 fetch 桩
// （与 `PreviewPoolUsageView.spec.ts` 同一套写法，少一层 App/router）。
//
// 逐条对应工单判据（报告里直接引用这些用例名）：
//   ① 打开即 GET 一次并回填，口令框必须为空 + hasPassword=true 时 placeholder 正确
//   ② 改 host 保存 ⇒ PUT 请求体里没有 `password` 键（键缺席 = 不修改）
//   ③ 勾「清除口令」⇒ 请求体 `password: null`
//   ④ 400 details.field='from' ⇒ 该字段被标记（aria-invalid + 红边）+ 文案可见（且不退化成整表一条错误）
//   ⑤ transport='disabled' ⇒ 测试发信按钮禁用 + 说明
//   ⑥ 测试发信成功 / 409 / 502 / 429 各一条人话
//   ⑦ 429 显示 Retry-After 秒数
// 另加：口令红线（响应里即使带明文也不进状态/不回填）+ 源码级红线（type=password / new-password / 无 localStorage）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import AdminMailView from './AdminMailView.vue';
import { useAdminStore } from '../stores/admin';
import { i18n, setLocale } from '../i18n';
// 源码级红线断言读**源码文本**（vite 的 `?raw`；jsdom 里不能 `import 'node:fs'`，见 #349 的坑）。
import viewSource from './AdminMailView.vue?raw';

const SMTP_SETTINGS = {
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

const DISABLED_SETTINGS = {
  transport: 'disabled',
  smtp: {
    host: '',
    port: 587,
    secure: true,
    user: '',
    from: '',
    timeouts: { connectionMs: 10000, greetingMs: 10000, socketMs: 20000 },
  },
  hasPassword: false,
  updatedAt: null,
  updatedBy: null,
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

type Handler = (call: RecordedCall) => Response | undefined | Promise<Response | undefined>;

/** 按 URL/方法分派的 fetch 桩；所有调用都被记下来（判据①②③ 都要读请求体）。 */
function stubFetch(handler: Handler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = typeof init?.body === 'string' ? init.body : null;
    const call: RecordedCall = { url, method, body: raw === null ? null : JSON.parse(raw) };
    calls.push(call);
    const response = await handler(call);
    if (!response) throw new Error(`fetch 桩没有处理 ${method} ${url}`);
    return response;
  }));
  return calls;
}

/** 默认桩：GET 回 `settings`，PUT 回 `put`，POST /test 回 `test`。 */
function stubDefault(
  settings: unknown,
  put: (call: RecordedCall) => Response,
  test?: (call: RecordedCall) => Response,
) {
  return stubFetch((call) => {
    if (call.url === '/api/admin/mail/settings' && call.method === 'GET') return jsonResponse(200, settings);
    if (call.url === '/api/admin/mail/settings' && call.method === 'PUT') return put(call);
    if (call.url === '/api/admin/mail/test' && call.method === 'POST' && test) return test(call);
    return undefined;
  });
}

async function mountView(): Promise<VueWrapper> {
  const wrapper = mount(AdminMailView, { global: { plugins: [i18n] } });
  await flushPromises();
  return wrapper;
}

function inputValue(wrapper: VueWrapper, testId: string): string {
  return (wrapper.get(`[data-test="${testId}"]`).element as HTMLInputElement).value;
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('① 打开即 GET 一次并回填（口令框必须为空）', () => {
  it('恰好一次 GET；host/port/from 回填；口令框空且 placeholder 说「已设置，留空不修改」', async () => {
    const calls = stubDefault(SMTP_SETTINGS, () => jsonResponse(200, SMTP_SETTINGS));
    const wrapper = await mountView();

    const gets = calls.filter((c) => c.method === 'GET');
    expect(gets).toHaveLength(1);
    expect(gets[0].url).toBe('/api/admin/mail/settings');

    expect(inputValue(wrapper, 'mail-host')).toBe('relay.internal');
    expect(inputValue(wrapper, 'mail-port')).toBe('25');
    expect(inputValue(wrapper, 'mail-from')).toBe('noreply@example.com');
    expect((wrapper.get('[data-test="mail-secure"]').element as HTMLInputElement).checked).toBe(false);

    // 红线：口令永不回填
    const password = wrapper.get('[data-test="mail-password"]').element as HTMLInputElement;
    expect(password.value).toBe('');
    expect(password.type).toBe('password');
    expect(password.autocomplete).toBe('new-password');
    expect(password.placeholder).toBe('已设置，留空不修改');

    // 顶部状态行
    expect(wrapper.get('[data-test="mail-status-transport"]').text()).toBe('smtp');
    expect(wrapper.get('[data-test="mail-status-password"]').text()).toBe('已设置');
    // updatedAt 本地化时间（不是原样 ISO 串）
    expect(wrapper.get('[data-test="mail-status-updated-at"]').text()).not.toBe('2026-11-05T08:12:31.004Z');
    expect(wrapper.get('[data-test="mail-status-updated-at"]').text().length).toBeGreaterThan(0);
  });

  it('hasPassword=false ⇒ placeholder 说「未设置」，状态行说「未设置」', async () => {
    stubDefault(DISABLED_SETTINGS, () => jsonResponse(200, DISABLED_SETTINGS));
    const wrapper = await mountView();

    expect((wrapper.get('[data-test="mail-password"]').element as HTMLInputElement).placeholder)
      .toBe('未设置（留空则保持未设置）');
    expect(wrapper.get('[data-test="mail-status-password"]').text()).toBe('未设置');
    expect(wrapper.get('[data-test="mail-status-transport"]').text()).toBe('disabled');
    expect(wrapper.get('[data-test="mail-status-updated-at"]').text()).toContain('从未修改');
  });
});

describe('② 改 host 保存 ⇒ 请求体里没有 password 键', () => {
  it('PUT 体只带 transport + smtp；`password` 键缺席（= 不修改）', async () => {
    const calls = stubDefault(SMTP_SETTINGS, () => jsonResponse(200, { ...SMTP_SETTINGS, smtp: { ...SMTP_SETTINGS.smtp, host: 'relay2.internal' } }));
    const wrapper = await mountView();

    await wrapper.get('[data-test="mail-host"]').setValue('relay2.internal');
    await wrapper.get('[data-test="mail-form"]').trigger('submit');
    await flushPromises();

    const put = calls.find((c) => c.method === 'PUT');
    expect(put, '保存必须发 PUT').toBeTruthy();
    expect(put!.url).toBe('/api/admin/mail/settings');
    const body = put!.body as Record<string, unknown>;
    expect(Object.hasOwn(body, 'password'), '口令键缺席 = 不修改（§4.12-3 三态的第一态）').toBe(false);
    expect(body.transport).toBe('smtp');
    expect((body.smtp as Record<string, unknown>).host).toBe('relay2.internal');
    expect((body.smtp as Record<string, unknown>).port).toBe(25);
    expect((body.smtp as Record<string, unknown>).secure).toBe(false);
    expect(((body.smtp as Record<string, unknown>).timeouts as Record<string, unknown>).socketMs).toBe(20000);

    // 成功提示 + 回填用响应 DTO（服务端已 invalidate()）
    expect(wrapper.find('[data-test="mail-save-ok"]').exists()).toBe(true);
    expect(inputValue(wrapper, 'mail-host')).toBe('relay2.internal');
  });
});

describe('③ 勾「清除口令」⇒ 请求体 password: null', () => {
  it('勾选后保存：password 键存在且为 null（清除，不是缺席）', async () => {
    const calls = stubDefault(SMTP_SETTINGS, () => jsonResponse(200, { ...SMTP_SETTINGS, hasPassword: false }));
    const wrapper = await mountView();

    await wrapper.get('[data-test="mail-clear-password"]').setValue(true);
    await wrapper.get('[data-test="mail-form"]').trigger('submit');
    await flushPromises();

    const put = calls.find((c) => c.method === 'PUT')!;
    const body = put.body as Record<string, unknown>;
    expect(Object.hasOwn(body, 'password')).toBe(true);
    expect(body.password).toBeNull();
    // 清除后状态行跟着响应变（hasPassword=false）
    expect(wrapper.get('[data-test="mail-status-password"]').text()).toBe('未设置');
    expect((wrapper.get('[data-test="mail-clear-password"]').element as HTMLInputElement).checked).toBe(false);
  });

  it('输入了新口令 ⇒ 请求体带原样明文（不 trim），且框里内容在保存后被清空', async () => {
    const calls = stubDefault(SMTP_SETTINGS, () => jsonResponse(200, SMTP_SETTINGS));
    const wrapper = await mountView();

    await wrapper.get('[data-test="mail-password"]').setValue(' s3cret ');
    await wrapper.get('[data-test="mail-form"]').trigger('submit');
    await flushPromises();

    const put = calls.find((c) => c.method === 'PUT')!;
    expect((put.body as Record<string, unknown>).password).toBe(' s3cret ');
    // 红线：保存成功后输入框被清空（口令不留在 DOM 里）
    expect(inputValue(wrapper, 'mail-password')).toBe('');
  });
});

describe('④ 400 details.field ⇒ 该字段标红 + 文案可见（不退化成一条整表错误）', () => {
  it('field=smtp.from：from 输入框 aria-invalid + 红边，字段下方显示服务端 message，无整表错误', async () => {
    const message = 'smtp.from 必须是有效邮箱地址';
    const calls = stubDefault(SMTP_SETTINGS, () => errorResponse(400, 'validation_failed', message, { field: 'smtp.from' }));
    const wrapper = await mountView();

    await wrapper.get('[data-test="mail-from"]').setValue('not-an-email');
    await wrapper.get('[data-test="mail-form"]').trigger('submit');
    await flushPromises();
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);

    const from = wrapper.get('[data-test="mail-from"]');
    expect(from.attributes('aria-invalid')).toBe('true');
    expect(from.classes()).toContain('border-red-600');
    const fieldError = wrapper.get('[data-test="field-error-from"]');
    expect(fieldError.text()).toContain(message);
    // 其它字段不背锅
    expect(wrapper.get('[data-test="mail-host"]').attributes('aria-invalid')).toBeUndefined();
    expect(wrapper.find('[data-test="field-error-host"]').exists()).toBe(false);
    // 关键：不是「只弹一个总错误」
    expect(wrapper.find('[data-test="mail-save-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="mail-save-ok"]').exists()).toBe(false);
  });

  it('认不出的字段名（details.field=body）⇒ 退到整表一条错误，不猜是哪个框', async () => {
    const message = '请求体必须是对象';
    stubDefault(SMTP_SETTINGS, () => errorResponse(400, 'validation_failed', message, { field: 'body' }));
    const wrapper = await mountView();

    await wrapper.get('[data-test="mail-form"]').trigger('submit');
    await flushPromises();

    expect(wrapper.get('[data-test="mail-save-error"]').text()).toContain(message);
    expect(wrapper.get('[data-test="mail-host"]').attributes('aria-invalid')).toBeUndefined();
  });

  it('超时字段报错 ⇒ 「高级」折叠区自动展开（否则红在看不见的地方）', async () => {
    stubDefault(SMTP_SETTINGS, () => errorResponse(400, 'validation_failed', 'smtp.timeouts.socketMs 必须是 1–600000 的正整数', {
      field: 'smtp.timeouts.socketMs',
    }));
    const wrapper = await mountView();

    await wrapper.get('[data-test="mail-timeout-socket"]').setValue('0');
    await wrapper.get('[data-test="mail-form"]').trigger('submit');
    await flushPromises();

    expect((wrapper.get('[data-test="mail-advanced"]').element as HTMLDetailsElement).open).toBe(true);
    expect(wrapper.get('[data-test="field-error-timeoutSocket"]').text()).toContain('socketMs');
  });
});

describe('⑤ transport !== smtp ⇒ 测试发信按钮禁用 + 说明', () => {
  it('已保存的通道是 disabled：按钮 disabled、给一句「未启用发不了」', async () => {
    const calls = stubDefault(DISABLED_SETTINGS, () => jsonResponse(200, DISABLED_SETTINGS));
    const wrapper = await mountView();

    const send = wrapper.get('[data-test="mail-test-send"]');
    expect(send.attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="mail-test-disabled-hint"]').text()).toContain('smtp');

    // 点了也不发请求（按钮禁用是硬闸，不是只改样式）
    await send.trigger('click');
    await flushPromises();
    expect(calls.filter((c) => c.url === '/api/admin/mail/test')).toHaveLength(0);
  });

  it('已保存 smtp 但表单草稿改成 disabled：按钮仍可用（测试发信用的是已保存的配置）+ 一句提醒', async () => {
    stubDefault(SMTP_SETTINGS, () => jsonResponse(200, SMTP_SETTINGS));
    const wrapper = await mountView();

    await wrapper.get('[data-test="mail-transport"]').setValue('disabled');
    expect(wrapper.get('[data-test="mail-test-send"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-test="mail-test-unsaved-hint"]').text()).toContain('已保存');
  });
});

describe('⑥⑦ 测试发信的四种结果各一条人话（429 带 Retry-After 秒数）', () => {
  async function sendWith(response: () => Response) {
    const calls = stubDefault(SMTP_SETTINGS, () => jsonResponse(200, SMTP_SETTINGS), response);
    const wrapper = await mountView();
    await wrapper.get('[data-test="mail-test-to"]').setValue('ops@example.com');
    await wrapper.get('[data-test="mail-test-send"]').trigger('click');
    await flushPromises();
    const post = calls.find((c) => c.url === '/api/admin/mail/test');
    expect(post, '点按钮必须发 POST /api/admin/mail/test').toBeTruthy();
    expect(post!.body).toEqual({ to: 'ops@example.com' });
    return wrapper;
  }

  it('200 ⇒ 成功提示点名收件人', async () => {
    const wrapper = await sendWith(() => jsonResponse(200, { ok: true, to: 'ops@example.com', at: '2026-11-05T08:20:11.220Z' }));
    expect(wrapper.get('[data-test="mail-test-ok"]').text()).toContain('ops@example.com');
    expect(wrapper.find('[data-test="mail-test-error"]').exists()).toBe(false);
  });

  it('409 mail_not_configured ⇒ 本地化前缀 + 服务端 message 原文', async () => {
    const message = '邮件通道未启用：请先到管理台配置 SMTP';
    const wrapper = await sendWith(() => errorResponse(409, 'mail_not_configured', message));
    const text = wrapper.get('[data-test="mail-test-error"]').text();
    expect(text).toContain('mail_not_configured');
    expect(text).toContain(message);
    expect(wrapper.find('[data-test="mail-test-ok"]').exists()).toBe(false);
  });

  it('502 email_send_failed ⇒ 本地化前缀 + message + 服务端 reason 单独一行', async () => {
    const message = '测试信发送失败';
    const wrapper = await sendWith(() => errorResponse(502, 'email_send_failed', message, {
      reason: 'ECONNREFUSED relay.internal:25',
    }));
    const text = wrapper.get('[data-test="mail-test-error"]').text();
    expect(text).toContain('email_send_failed');
    expect(text).toContain(message);
    expect(wrapper.get('[data-test="mail-test-reason"]').text()).toContain('ECONNREFUSED relay.internal:25');
  });

  it('⑦ 429 rate_limited ⇒ 文案里显示 Retry-After 的秒数', async () => {
    const wrapper = await sendWith(() => errorResponse(429, 'rate_limited', '太频繁', undefined, { 'Retry-After': '120' }));
    const text = wrapper.get('[data-test="mail-test-error"]').text();
    expect(text).toContain('rate_limited');
    expect(text).toContain('120 秒');
    expect(text).not.toContain('undefined');
  });

  it('429 但 Retry-After 不可解 ⇒ 退到不带秒数的版本（不显示「undefined 秒」）', async () => {
    const wrapper = await sendWith(() => errorResponse(429, 'rate_limited', '太频繁', undefined, { 'Retry-After': 'later' }));
    const text = wrapper.get('[data-test="mail-test-error"]').text();
    expect(text).toContain('rate_limited');
    expect(text).not.toMatch(/undefined|NaN/);
  });
});

describe('红线：口令不进前端状态 / 不回填 / 不进 URL（§4.12-6）', () => {
  it('响应里即使（违规）带了口令明文，也不会进 store、输入框或序列化状态', async () => {
    const leaky = {
      ...SMTP_SETTINGS,
      password: 'PLAINTEXT-LEAK',
      smtp: { ...SMTP_SETTINGS.smtp, password: 'PLAINTEXT-LEAK' },
    };
    stubDefault(leaky, () => jsonResponse(200, leaky));
    const wrapper = await mountView();

    const admin = useAdminStore();
    expect(JSON.stringify(admin.mailSettings)).not.toContain('PLAINTEXT-LEAK');
    expect(admin.mailSettings && Object.hasOwn(admin.mailSettings as object, 'password')).toBe(false);
    expect(inputValue(wrapper, 'mail-password')).toBe('');
    expect(wrapper.html()).not.toContain('PLAINTEXT-LEAK');
  });

  it('源码级：口令框是 type=password + autocomplete=new-password，且视图不碰 localStorage / console / URL', () => {
    expect(viewSource).toContain('type="password"');
    expect(viewSource).toContain('autocomplete="new-password"');
    expect(viewSource).not.toContain('localStorage');
    expect(viewSource).not.toContain('console.');
    // 口令只经表单值进请求体：视图里没有任何「把 password 塞进 URL/query」的痕迹
    expect(viewSource).not.toMatch(/password.*(query|location|history)/i);
  });
});
