// issue #456 M2 管理台证书页视图单测（`AdminTlsView.vue`，契约 `docs/api/portal.md` §4.13 / §4.13-2a）。
//
// 装配风格照 `AdminMailView.spec.ts`：直接挂载视图（本页不依赖路由）+ 真实 i18n 单例 + pinia +
// 按 URL/方法分派的 fetch 桩。不跑真浏览器、不连网络。
//
// 逐条对应工单 §4 的判据（报告里直接引用这些用例名）：
//   ① 未配置态文案 + 不出现空指纹/undefined
//   ② 已配置态逐字段渲染（含 SAN 列表）
//   ③ `coverage.covered:false` ⇒ 红字 + 禁用安装
//   ④ 到期 <30 天 ⇒ 黄条、已过期 ⇒ 红条、<1 天 ⇒「今天到期」（不出现「0 天」）
//   ⑤ inspect 成功 ⇒ 域名输入被预填成 SAN 条数
//   ⑥ 删掉 adminHost 那行 ⇒ 前端不拦（按钮仍可点），提交后按后端 400 显示 `details.missing`
//   ⑦ `keyMatches:false` ⇒ 红字且禁用安装
//   ⑧ 安装成功 ⇒ 两个 textarea 被清空 + 状态卡刷新
//   ⑨ 429 ⇒ 显示 Retry-After 秒数
//   ⑩ verify 三态渲染（含 `unreachable` 的 error 原文、`unknown` 写「还没检查过」）
//   ⑪ 回滚确认前零请求、确认后发一次 POST
//   ⑫ `tls_no_previous` 文案
//   ⑬ 私钥不进 store / localStorage（源码级 + 行为级）
//   ⑭ 双语键成对（`admin.tls.*` + `admin.tabs.tls`）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import AdminTlsView from './AdminTlsView.vue';
import { useAdminStore } from '../stores/admin';
import { normalizeTlsInspect, normalizeTlsStatus } from '../lib/tlsSettings';
import { i18n, setLocale } from '../i18n';
import { zhCN } from '../i18n/locales/zh-CN';
import { en } from '../i18n/locales/en';
// 源码级红线断言读**源码文本**（vite 的 `?raw`；jsdom 里不能 `import 'node:fs'`，见 #349 的坑）。
import viewSource from './AdminTlsView.vue?raw';
import libSource from '../lib/tlsSettings.ts?raw';
import storeSource from '../stores/admin.ts?raw';

const ADMIN_HOST = 'admin.fde.erix.vip';
const FP_A = 'AA:BB:CC:DD';
const FP_B = '11:22:33:44';
const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
/** 一份「真」私钥文本：只用来证明它**没有**离开组件（内容本身不重要）。 */
const FAKE_KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvFAKEKEYMATERIAL\n-----END PRIVATE KEY-----\n';

interface ActiveOverrides {
  subjectCN?: string | null;
  sans?: string[];
  issuerCN?: string | null;
  notBefore?: string | null;
  notAfter?: string | null;
  fingerprintSha256?: string | null;
}

function statusDto({
  configured = true,
  active = {},
  covered = true,
  live = { status: 'unknown', checkedAt: null },
  previous = null,
}: {
  configured?: boolean;
  active?: ActiveOverrides;
  covered?: boolean;
  live?: Record<string, unknown>;
  previous?: Record<string, unknown> | null;
} = {}) {
  return {
    configured,
    active: configured
      ? {
        subjectCN: '*.fde.erix.vip',
        sans: ['*.fde.erix.vip', 'fde.erix.vip'],
        issuerCN: 'R3',
        notBefore: iso(-2 * DAY),
        notAfter: iso(200 * DAY),
        fingerprintSha256: FP_A,
        ...active,
      }
      : null,
    coverage: { adminHost: ADMIN_HOST, covered },
    live,
    previous,
  };
}

function inspectDto({
  keyMatches = true as boolean | null,
  covered = true,
  sans = ['*.fde.erix.vip', 'fde.erix.vip'],
  warnings = [] as string[],
  notAfter = iso(200 * DAY),
} = {}) {
  return {
    cert: {
      subjectCN: '*.fde.erix.vip',
      sans,
      issuerCN: 'R3',
      notBefore: iso(-2 * DAY),
      notAfter,
      fingerprintSha256: FP_B,
    },
    keyMatches,
    coverage: { adminHost: ADMIN_HOST, covered },
    warnings,
  };
}

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

type Handler = (call: RecordedCall) => Response | undefined;

function stubFetch(handler: Handler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = typeof init?.body === 'string' ? init.body : null;
    const call: RecordedCall = { url, method, body: raw === null ? null : JSON.parse(raw) };
    calls.push(call);
    const response = handler(call);
    if (!response) throw new Error(`fetch 桩没有处理 ${method} ${url}`);
    return response;
  }));
  return calls;
}

async function mountView(): Promise<VueWrapper> {
  const wrapper = mount(AdminTlsView, { global: { plugins: [i18n] } });
  await flushPromises();
  return wrapper;
}

/** 默认桩：GET 回 `status`，inspect 回 `inspect`，PUT 回 `put`，verify/rollback 各自可覆盖。 */
function stubDefault(
  status: unknown,
  {
    inspect = () => jsonResponse(200, inspectDto()),
    put = () => jsonResponse(200, statusDto({ active: { fingerprintSha256: FP_B } })),
    verify,
    rollback,
  }: {
    inspect?: (call: RecordedCall) => Response;
    put?: (call: RecordedCall) => Response;
    verify?: (call: RecordedCall) => Response;
    rollback?: (call: RecordedCall) => Response;
  } = {},
) {
  return stubFetch((call) => {
    if (call.url === '/api/admin/tls' && call.method === 'GET') return jsonResponse(200, status);
    if (call.url === '/api/admin/tls/inspect' && call.method === 'POST') return inspect(call);
    if (call.url === '/api/admin/tls' && call.method === 'PUT') return put(call);
    if (call.url === '/api/admin/tls/verify' && call.method === 'POST' && verify) return verify(call);
    if (call.url === '/api/admin/tls/rollback' && call.method === 'POST' && rollback) return rollback(call);
    return undefined;
  });
}

function isDisabled(wrapper: VueWrapper, testId: string): boolean {
  return (wrapper.get(`[data-test="${testId}"]`).element as HTMLButtonElement).disabled;
}

/** 粘两格 + 点「解析证书」。 */
async function pasteAndInspect(wrapper: VueWrapper, { cert = 'CERT-PEM', key = FAKE_KEY } = {}) {
  await wrapper.get('[data-test="tls-cert-input"]').setValue(cert);
  await wrapper.get('[data-test="tls-key-input"]').setValue(key);
  await wrapper.get('[data-test="tls-inspect"]').trigger('click');
  await flushPromises();
}

function textOf(wrapper: VueWrapper, testId: string): string {
  return wrapper.get(`[data-test="${testId}"]`).text();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// ① 未配置态
// ---------------------------------------------------------------------------

describe('① 未配置态', () => {
  it('configured:false ⇒ 「未配置」徽标 + 回落到自签证书的说明，且不出现空指纹 / undefined', async () => {
    stubDefault(statusDto({ configured: false, covered: false }));
    const wrapper = await mountView();

    expect(textOf(wrapper, 'tls-status-configured')).toBe('未配置');
    expect(textOf(wrapper, 'tls-not-configured')).toContain('内建自签证书');
    // 没有生效证书 ⇒ 整段「已配置」字段都不出（不是渲染出一串空指纹）
    expect(wrapper.find('[data-test="tls-active"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="tls-fingerprint"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="tls-subject-cn"]').exists()).toBe(false);
    // 未配置 = 覆盖不到（后端也这么发）：红字给出原因，而不是静默
    expect(wrapper.find('[data-test="tls-coverage-bad"]').exists()).toBe(true);
    // 全页不许出现 undefined / null / [object Object]
    const text = wrapper.text();
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('[object Object]');
    expect(text).not.toContain('null');
  });
});

// ---------------------------------------------------------------------------
// ② 已配置态逐字段
// ---------------------------------------------------------------------------

describe('② 已配置态', () => {
  it('逐字段渲染：CN / Issuer / 生效与到期时间（本地化）/ SAN 列表 / 指纹', async () => {
    stubDefault(statusDto());
    const wrapper = await mountView();

    expect(textOf(wrapper, 'tls-status-configured')).toBe('已配置');
    expect(textOf(wrapper, 'tls-subject-cn')).toBe('*.fde.erix.vip');
    expect(textOf(wrapper, 'tls-issuer-cn')).toBe('R3');
    // 时间必须本地化（不是原样 ISO 串）
    expect(textOf(wrapper, 'tls-not-after')).not.toBe(iso(200 * DAY));
    expect(textOf(wrapper, 'tls-not-after').length).toBeGreaterThan(0);
    // SAN 列表逐项
    const sans = wrapper.findAll('[data-test="tls-san"]').map((node) => node.text());
    expect(sans).toEqual(['*.fde.erix.vip', 'fde.erix.vip']);
    // 指纹原样（可复制）
    expect(textOf(wrapper, 'tls-fingerprint')).toBe(FP_A);
    expect(wrapper.find('[data-test="tls-copy-fingerprint"]').exists()).toBe(true);
    // 覆盖徽标是绿的（文案里带 adminHost）
    expect(textOf(wrapper, 'tls-coverage')).toContain(ADMIN_HOST);
    expect(wrapper.find('[data-test="tls-coverage-bad"]').exists()).toBe(false);
  });

  it('SAN 为空 ⇒ 明确说「没有 DNS SAN」，不渲染空列表', async () => {
    stubDefault(statusDto({ active: { sans: [], subjectCN: 'admin.fde.erix.vip' } }));
    const wrapper = await mountView();

    expect(wrapper.find('[data-test="tls-sans"]').exists()).toBe(false);
    expect(textOf(wrapper, 'tls-sans-empty')).toContain('没有 DNS SAN');
  });
});

// ---------------------------------------------------------------------------
// ③ 覆盖不到 adminHost
// ---------------------------------------------------------------------------

describe('③ coverage.covered:false', () => {
  it('状态卡给红字（点名 adminHost）', async () => {
    stubDefault(statusDto({ covered: false }));
    const wrapper = await mountView();

    expect(textOf(wrapper, 'tls-coverage-bad')).toContain(ADMIN_HOST);
    expect(textOf(wrapper, 'tls-coverage-bad')).toContain('浏览器会报证书错误');
  });

  it('inspect 结果 covered:false ⇒ 红字 + 「确认安装」禁用', async () => {
    stubDefault(statusDto(), { inspect: () => jsonResponse(200, inspectDto({ covered: false })) });
    const wrapper = await mountView();

    await pasteAndInspect(wrapper);

    expect(textOf(wrapper, 'tls-coverage-blocks')).toContain(ADMIN_HOST);
    expect(isDisabled(wrapper, 'tls-install'), '不覆盖 adminHost 的证书不许装').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ④ 到期提醒
// ---------------------------------------------------------------------------

describe('④ 到期提醒', () => {
  it('< 30 天 ⇒ 黄条 + 剩余天数（不是红条）', async () => {
    stubDefault(statusDto({ active: { notAfter: iso(10 * DAY) } }));
    const wrapper = await mountView();

    const warn = wrapper.get('[data-test="tls-expiry-warn"]');
    expect(warn.text()).toContain('还有');
    expect(warn.text()).toContain('10');
    expect(wrapper.find('[data-test="tls-expiry-expired"]').exists()).toBe(false);
  });

  it('已过期 ⇒ 红条', async () => {
    stubDefault(statusDto({ active: { notAfter: iso(-2 * DAY) } }));
    const wrapper = await mountView();

    expect(textOf(wrapper, 'tls-expiry-expired')).toContain('已过期');
    expect(wrapper.find('[data-test="tls-expiry-warn"]').exists()).toBe(false);
  });

  it('不足一天 ⇒ 写「今天到期」，且不出现「0 天」这种假精确', async () => {
    stubDefault(statusDto({ active: { notAfter: iso(3 * 60 * 60 * 1000) } }));
    const wrapper = await mountView();

    const warn = textOf(wrapper, 'tls-expiry-warn');
    expect(warn).toContain('今天到期');
    expect(warn).not.toContain('0 天');
    expect(wrapper.text()).not.toContain('0 天');
  });

  it('≥ 30 天 ⇒ 不出提醒行', async () => {
    stubDefault(statusDto());
    const wrapper = await mountView();

    expect(wrapper.find('[data-test="tls-expiry-warn"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="tls-expiry-expired"]').exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ⑤ inspect 预填域名
// ---------------------------------------------------------------------------

describe('⑤ inspect 成功', () => {
  it('域名输入被预填成 SAN 条数，adminHost 那一行有高亮标记，私钥配对显示绿字', async () => {
    const calls = stubDefault(statusDto());
    const wrapper = await mountView();

    await pasteAndInspect(wrapper);

    const inspectCall = calls.find((call) => call.url === '/api/admin/tls/inspect')!;
    expect(inspectCall.body).toEqual({ certPem: 'CERT-PEM', keyPem: FAKE_KEY });

    const rows = wrapper.findAll('[data-test="tls-domain-input"]');
    expect(rows).toHaveLength(2);
    expect((rows[0].element as HTMLInputElement).value).toBe('*.fde.erix.vip');
    expect((rows[1].element as HTMLInputElement).value).toBe('fde.erix.vip');
    // `adminHost` 由通配符覆盖：它本身不在 SAN 里，所以这里先补一行再断言高亮
    await wrapper.get('[data-test="tls-domain-add"]').trigger('click');
    const after = wrapper.findAll('[data-test="tls-domain-input"]');
    await after[2].setValue(ADMIN_HOST);
    expect(wrapper.find('[data-test="tls-domain-admin-tag"]').exists()).toBe(true);
    // 解析结果展示（CN / 指纹 / 配对状态）
    expect(textOf(wrapper, 'tls-inspect-subject-cn')).toBe('*.fde.erix.vip');
    expect(textOf(wrapper, 'tls-inspect-fingerprint')).toBe(FP_B);
    expect(textOf(wrapper, 'tls-key-matches-ok')).toContain('配对');
    expect(isDisabled(wrapper, 'tls-install')).toBe(false);
  });

  it('没给私钥（空串）⇒ keyMatches:null：请求体不带私钥键、页面写「无法判断」、安装禁用', async () => {
    const calls = stubDefault(statusDto(), { inspect: () => jsonResponse(200, inspectDto({ keyMatches: null })) });
    const wrapper = await mountView();

    await pasteAndInspect(wrapper, { key: '' });

    const inspectCall = calls.find((call) => call.url === '/api/admin/tls/inspect')!;
    expect(Object.hasOwn(inspectCall.body as object, 'keyPem')).toBe(false);
    expect(textOf(wrapper, 'tls-key-not-provided')).toContain('无法判断');
    expect(isDisabled(wrapper, 'tls-install'), '没有私钥装不了（后端要用它做配对校验）').toBe(true);
  });

  it('inspect 的 warnings 机器码翻成人话（过期 / 未生效）', async () => {
    stubDefault(statusDto(), {
      inspect: () => jsonResponse(200, inspectDto({ warnings: ['cert_expired', 'not_yet_valid'] })),
    });
    const wrapper = await mountView();

    await pasteAndInspect(wrapper);

    const warnings = wrapper.findAll('[data-test="tls-warning"]').map((node) => node.text());
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('已过期');
    expect(warnings[1]).toContain('还没生效');
  });
});

// ---------------------------------------------------------------------------
// ⑥ 删掉 adminHost 那行：前端不拦，后端说了算
// ---------------------------------------------------------------------------

describe('⑥ 域名编辑不替后端做判定', () => {
  it('删掉 adminHost 那行 ⇒ 「确认安装」仍可点；提交后按后端 400 显示 details.missing', async () => {
    const calls = stubDefault(statusDto(), {
      inspect: () => jsonResponse(200, inspectDto({ sans: [ADMIN_HOST, 'fde.erix.vip'] })),
      put: () => errorResponse(400, 'tls_cert_domain_mismatch', 'confirmDomains 里有证书覆盖不到的名字', {
        adminHost: ADMIN_HOST,
        missing: ['nope.example'],
        certDomains: [ADMIN_HOST, 'fde.erix.vip'],
        field: 'confirmDomains',
      }),
    });
    const wrapper = await mountView();

    await pasteAndInspect(wrapper);
    expect(wrapper.findAll('[data-test="tls-domain-input"]')).toHaveLength(2);
    expect(wrapper.find('[data-test="tls-domain-admin-tag"]').exists()).toBe(true);

    // 删掉 adminHost 那一行（第一行）
    await wrapper.findAll('[data-test="tls-domain-remove"]')[0].trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-test="tls-domain-input"]')).toHaveLength(1);
    expect(isDisabled(wrapper, 'tls-install'), '前端不自己拦（服务端是唯一判据）').toBe(false);

    // 再加一个证书覆盖不到的名字，然后提交 ⇒ 后端 400，前端照实显示 details.missing
    await wrapper.get('[data-test="tls-domain-add"]').trigger('click');
    await wrapper.findAll('[data-test="tls-domain-input"]')[1].setValue('nope.example');
    await wrapper.get('[data-test="tls-install"]').trigger('click');
    await flushPromises();

    const put = calls.find((call) => call.method === 'PUT')!;
    expect((put.body as Record<string, unknown>).confirmDomains).toEqual(['fde.erix.vip', 'nope.example']);
    expect(textOf(wrapper, 'field-error-domains')).toContain('nope.example');
    expect(textOf(wrapper, 'field-error-domains')).toContain('tls_cert_domain_mismatch');
  });
});

// ---------------------------------------------------------------------------
// ⑦ keyMatches:false
// ---------------------------------------------------------------------------

describe('⑦ 私钥不配对', () => {
  it('keyMatches:false ⇒ 红字说明握手会失败，且「确认安装」禁用', async () => {
    stubDefault(statusDto(), { inspect: () => jsonResponse(200, inspectDto({ keyMatches: false })) });
    const wrapper = await mountView();

    await pasteAndInspect(wrapper);

    expect(textOf(wrapper, 'tls-key-mismatch')).toContain('不配对');
    expect(textOf(wrapper, 'tls-key-mismatch')).toContain('握手失败');
    expect(isDisabled(wrapper, 'tls-install')).toBe(true);
    expect(wrapper.find('[data-test="tls-key-matches-ok"]').exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ⑧ 安装成功
// ---------------------------------------------------------------------------

describe('⑧ 安装成功', () => {
  it('两个 textarea 被清空、状态卡换成响应里的新指纹、成功提示出现', async () => {
    const calls = stubDefault(statusDto());
    const wrapper = await mountView();

    await pasteAndInspect(wrapper);
    await wrapper.get('[data-test="tls-install"]').trigger('click');
    await flushPromises();

    const put = calls.find((call) => call.method === 'PUT')!;
    expect(put.url).toBe('/api/admin/tls');
    expect(put.body).toMatchObject({ certPem: 'CERT-PEM', keyPem: FAKE_KEY });
    expect((put.body as Record<string, unknown>).confirmDomains).toEqual(['*.fde.erix.vip', 'fde.erix.vip']);

    // 红线：私钥不许在页面里多留一秒
    expect((wrapper.get('[data-test="tls-cert-input"]').element as HTMLTextAreaElement).value).toBe('');
    expect((wrapper.get('[data-test="tls-key-input"]').element as HTMLTextAreaElement).value).toBe('');
    // 状态卡刷新（响应里的新指纹）+ 成功提示
    expect(textOf(wrapper, 'tls-fingerprint')).toBe(FP_B);
    expect(textOf(wrapper, 'tls-install-ok')).toContain('已安装');
    // 解析结果区块收起来了（草稿已被消费）
    expect(wrapper.find('[data-test="tls-inspect-result"]').exists()).toBe(false);

    // 再粘一份新草稿 ⇒ 上一次「已安装」的提示不再挂着（它说的是上一张证书）
    await pasteAndInspect(wrapper);
    expect(wrapper.find('[data-test="tls-install-ok"]').exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ⑨ 429
// ---------------------------------------------------------------------------

describe('⑨ 429 rate_limited', () => {
  it('显示 Retry-After 秒数（不显示 undefined 秒）', async () => {
    stubDefault(statusDto(), {
      put: () => errorResponse(429, 'rate_limited', '证书上传过于频繁', undefined, { 'Retry-After': '42' }),
    });
    const wrapper = await mountView();

    await pasteAndInspect(wrapper);
    await wrapper.get('[data-test="tls-install"]').trigger('click');
    await flushPromises();

    const error = textOf(wrapper, 'tls-save-error');
    expect(error).toContain('42 秒');
    expect(error).not.toContain('undefined');
    // 失败 ⇒ 输入框内容仍在（用户不该重粘一遍）
    expect((wrapper.get('[data-test="tls-key-input"]').element as HTMLTextAreaElement).value).toBe(FAKE_KEY);
  });
});

// ---------------------------------------------------------------------------
// ⑩ verify 三态 + unknown
// ---------------------------------------------------------------------------

describe('⑩ 真机校验', () => {
  it('unknown ⇒ 写「还没检查过」（不把「未知」当结论）', async () => {
    stubDefault(statusDto());
    const wrapper = await mountView();

    expect(textOf(wrapper, 'tls-live-unknown')).toBe('还没检查过');
    expect(wrapper.text()).not.toContain('未知');
  });

  it('live ⇒ 绿字（指纹一致）', async () => {
    const calls = stubDefault(statusDto(), {
      verify: () => jsonResponse(200, statusDto({
        live: { status: 'live', checkedAt: iso(0), fingerprintSha256: FP_A, subjectCN: '*.fde.erix.vip' },
      })),
    });
    const wrapper = await mountView();

    await wrapper.get('[data-test="tls-live-check"]').trigger('click');
    await flushPromises();

    expect(calls.filter((call) => call.url === '/api/admin/tls/verify')).toHaveLength(1);
    expect(textOf(wrapper, 'tls-live-live')).toContain('指纹一致');
    // 检查时间（本地化）
    expect(textOf(wrapper, 'tls-live-checked-at')).toContain('检查时间');
  });

  it('mismatch ⇒ 红字 + 两侧指纹都列出来', async () => {
    stubDefault(statusDto(), {
      verify: () => jsonResponse(200, statusDto({
        live: { status: 'mismatch', checkedAt: iso(0), fingerprintSha256: FP_B, subjectCN: 'other.example' },
      })),
    });
    const wrapper = await mountView();

    await wrapper.get('[data-test="tls-live-check"]').trigger('click');
    await flushPromises();

    expect(textOf(wrapper, 'tls-live-mismatch')).toContain('另一张');
    expect(textOf(wrapper, 'tls-live-expected')).toBe(FP_A);
    expect(textOf(wrapper, 'tls-live-actual')).toBe(FP_B);
  });

  it('unreachable ⇒ 灰态 + error 原文（如 ECONNREFUSED），且不锁住上传按钮', async () => {
    stubDefault(statusDto(), {
      verify: () => jsonResponse(200, statusDto({
        live: { status: 'unreachable', checkedAt: iso(0), error: 'ECONNREFUSED' },
      })),
    });
    const wrapper = await mountView();

    await wrapper.get('[data-test="tls-live-check"]').trigger('click');
    await flushPromises();

    expect(textOf(wrapper, 'tls-live-unreachable')).toContain('连不上');
    expect(textOf(wrapper, 'tls-live-error')).toContain('ECONNREFUSED');
    // 探针失败不是硬闸：解析按钮照样可用
    await wrapper.get('[data-test="tls-cert-input"]').setValue('CERT-PEM');
    expect(isDisabled(wrapper, 'tls-inspect')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ⑪ 回滚：确认前零请求
// ---------------------------------------------------------------------------

describe('⑪ 回滚', () => {
  it('`previous` 非空 ⇒ 显示上一代信息；确认前**一个请求都不发**，确认后恰好一次 POST', async () => {
    const calls = stubDefault(statusDto({
      previous: { fingerprintSha256: FP_B, subjectCN: '*.fde.erix.vip', notAfter: iso(100 * DAY), savedAt: iso(-DAY) },
    }), {
      rollback: () => jsonResponse(200, statusDto()),
    });
    const wrapper = await mountView();

    expect(wrapper.find('[data-test="tls-rollback"]').exists()).toBe(true);
    expect(textOf(wrapper, 'tls-previous-fingerprint')).toBe(FP_B);
    expect(textOf(wrapper, 'tls-previous-saved-at').length).toBeGreaterThan(0);

    const rollbackCalls = () => calls.filter((call) => call.url === '/api/admin/tls/rollback');
    await wrapper.get('[data-test="tls-rollback-ask"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="tls-rollback-dialog"]').exists()).toBe(true);
    expect(rollbackCalls(), '确认之前一个请求都不发').toHaveLength(0);

    // 取消：仍然一个请求都不发，对话框收起
    await wrapper.get('[data-test="tls-rollback-cancel"]').trigger('click');
    await flushPromises();
    expect(rollbackCalls()).toHaveLength(0);
    expect(wrapper.find('[data-test="tls-rollback-dialog"]').exists()).toBe(false);

    // 再点开 → 确认 ⇒ 恰好一次
    await wrapper.get('[data-test="tls-rollback-ask"]').trigger('click');
    await wrapper.get('[data-test="tls-rollback-confirm"]').trigger('click');
    await flushPromises();
    expect(rollbackCalls()).toHaveLength(1);
    expect(textOf(wrapper, 'tls-rollback-ok')).toContain('已回滚');
    // 回滚后没有上一代了 ⇒ 按钮收起（但「已回滚」必须看得见）
    expect(wrapper.find('[data-test="tls-rollback-ask"]').exists()).toBe(false);
  });

  it('没有 previous ⇒ 整段不出（不给一个点了必然 404 的按钮）', async () => {
    stubDefault(statusDto());
    const wrapper = await mountView();

    expect(wrapper.find('[data-test="tls-rollback"]').exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ⑫ tls_no_previous
// ---------------------------------------------------------------------------

describe('⑫ 404 tls_no_previous', () => {
  it('回滚失败 ⇒ 专属文案「没有可回滚的上一代」，并重新拉一次状态卡', async () => {
    const calls = stubDefault(statusDto({
      previous: { fingerprintSha256: FP_B, subjectCN: '*.fde.erix.vip', notAfter: iso(100 * DAY), savedAt: iso(-DAY) },
    }), {
      rollback: () => errorResponse(404, 'tls_no_previous', '没有可回滚的上一代证书（certs/prev/ 不存在或不完整）'),
    });
    const wrapper = await mountView();
    const getsBefore = calls.filter((call) => call.method === 'GET').length;

    await wrapper.get('[data-test="tls-rollback-ask"]').trigger('click');
    await wrapper.get('[data-test="tls-rollback-confirm"]').trigger('click');
    await flushPromises();

    const error = textOf(wrapper, 'tls-rollback-error');
    expect(error).toContain('tls_no_previous');
    expect(error).toContain('没有可回滚的上一代');
    // 失败也要刷新状态卡（不能停在旧快照）
    expect(calls.filter((call) => call.method === 'GET').length).toBe(getsBefore + 1);
  });
});

// ---------------------------------------------------------------------------
// ⑬ 私钥红线
// ---------------------------------------------------------------------------

describe('⑬ 私钥不进 store / 浏览器存储（源码级 + 行为级）', () => {
  it('lib/tlsSettings.ts 与 stores/admin.ts 里连 PEM 字段名的字面量都没有', () => {
    for (const [name, source] of [['lib/tlsSettings.ts', libSource], ['stores/admin.ts', storeSource]] as const) {
      expect(source, `${name} 不许出现 PEM 字段名`).not.toMatch(/keyPem|certPem|privateKey/i);
    }
  });

  it('服务端误发 PEM 字段 ⇒ DTO 白名单把它们丢掉（状态与解析结果都不带）', () => {
    const leakedStatus = normalizeTlsStatus({
      ...statusDto(),
      active: { ...statusDto().active, keyPem: 'LEAK-KEY', certPem: 'LEAK-CERT', publicKeyPem: 'LEAK-PUB' },
    });
    expect(Object.keys(leakedStatus.active ?? {})).toEqual([
      'subjectCN', 'sans', 'issuerCN', 'notBefore', 'notAfter', 'fingerprintSha256',
    ]);
    expect(JSON.stringify(leakedStatus)).not.toContain('LEAK');

    const leakedInspect = normalizeTlsInspect({
      ...inspectDto(),
      cert: { ...inspectDto().cert, keyPem: 'LEAK-KEY' },
      keyPem: 'LEAK-KEY',
    });
    expect(JSON.stringify(leakedInspect)).not.toContain('LEAK');
  });

  it('视图里也不许把 PEM 写进浏览器存储 / 控制台 / 地址栏（按**调用**判，注释不算）', () => {
    // 红线是「不外泄」的几条通道：真正的存储/日志/导航 API 调用一个都不许有。
    expect(viewSource).not.toMatch(/(?:local|session)Storage\s*[.[]/);
    expect(viewSource).not.toMatch(/console\s*\.\s*(?:log|warn|error|info|debug)/);
    expect(viewSource).not.toMatch(/location\s*\.\s*(?:href|search|hash|assign|replace)/);
    expect(viewSource).not.toMatch(/document\.cookie/);
  });

  it('粘贴 → 解析 → 安装全程：store 状态与浏览器存储里都没有私钥正文', async () => {
    stubDefault(statusDto());
    const wrapper = await mountView();
    const admin = useAdminStore();

    await pasteAndInspect(wrapper);
    await wrapper.get('[data-test="tls-install"]').trigger('click');
    await flushPromises();

    const state = JSON.stringify(admin.$state);
    expect(state).not.toContain('MIIEvFAKEKEYMATERIAL');
    expect(state).not.toContain('PRIVATE KEY');
    // 状态的键里没有任何像 PEM 的东西
    expect(Object.keys(admin.$state).filter((key) => /pem|privatekey/i.test(key))).toEqual([]);
    // 浏览器存储里也没有（localStorage 里只有 i18n 的语言偏好，别的都不许有）
    const stored = [...Object.values(localStorage), ...Object.values(sessionStorage)].join('\n');
    expect(stored).not.toContain('PRIVATE KEY');
    expect(stored).not.toContain('MIIEvFAKEKEYMATERIAL');
    expect(stored).not.toContain('CERT-PEM');
  });

  it('组件卸载即清空两格（私钥不留到下一个实例）', async () => {
    stubDefault(statusDto());
    const wrapper = await mountView();
    await pasteAndInspect(wrapper);

    const admin = useAdminStore();
    // 解析结果留在 store（那是证书元数据，不是私钥），但组件内的两格随卸载清空
    expect(admin.tlsInspect).not.toBeNull();
    wrapper.unmount();
    expect(JSON.stringify(admin.$state)).not.toContain('PRIVATE KEY');
  });
});

// ---------------------------------------------------------------------------
// ⑭ 双语键成对
// ---------------------------------------------------------------------------

describe('⑭ 双语键成对', () => {
  it('admin.tabs.tls 与 admin.tls.* 在 zh-CN / en 两边键集一致，且 en 不是中文', () => {
    expect(zhCN.admin.tabs.tls).toBe('证书');
    expect(en.admin.tabs.tls).toBe('Certificates');

    const zhKeys = Object.keys(zhCN.admin.tls).sort();
    const enKeys = Object.keys(en.admin.tls).sort();
    expect(enKeys).toEqual(zhKeys);
    expect(zhKeys.length).toBeGreaterThan(40);

    const CJK = /[\u4e00-\u9fff]/;
    for (const key of zhKeys) {
      const zh = (zhCN.admin.tls as Record<string, string>)[key];
      const english = (en.admin.tls as Record<string, string>)[key];
      expect(zh.length, key).toBeGreaterThan(0);
      expect(english.length, key).toBeGreaterThan(0);
      expect(english, key).not.toMatch(CJK);
    }
  });
});

// ---------------------------------------------------------------------------
// 附：加载时机
// ---------------------------------------------------------------------------

describe('附：加载时机', () => {
  it('挂载即恰好一次 GET（进管理台不请求，切到本 tab 才请求）', async () => {
    const calls = stubDefault(statusDto());
    await mountView();

    const gets = calls.filter((call) => call.method === 'GET');
    expect(gets).toHaveLength(1);
    expect(gets[0].url).toBe('/api/admin/tls');
  });

  it('GET 失败 ⇒ 显示错误，且不产生未捕获拒绝（AGENTS §4 的 rc=1 坑）', async () => {
    stubFetch(() => errorResponse(403, 'forbidden', '需要管理员权限'));
    const wrapper = await mountView();

    expect(textOf(wrapper, 'tls-load-error')).toContain('需要管理员权限');
  });
});

// ---------------------------------------------------------------------------
// ⑮ #462 链形态：inspect 的三条新告警码 + verify 的 reason 分句
// ---------------------------------------------------------------------------

describe('⑮ #462 链形态文案', () => {
  it('inspect 的链告警码各自翻成人话（leaf-only / 顺序可疑 / 断链），且不丢条数', async () => {
    stubDefault(statusDto(), {
      inspect: () => jsonResponse(200, inspectDto({
        warnings: ['chain_looks_leaf_only', 'chain_order_suspect', 'chain_broken'],
      })),
    });
    const wrapper = await mountView();

    await pasteAndInspect(wrapper);

    const warnings = wrapper.findAll('[data-test="tls-warning"]').map((node) => node.text());
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('只有叶子');
    expect(warnings[0]).toContain('unable to verify the first certificate');
    expect(warnings[1]).toContain('顺序可能是反的');
    expect(warnings[2]).toContain('接不上');
    // 未知码仍然被过滤掉（现状口径：不加登记 = 页面上看不见，所以后端每个新码都必须登记）
    expect(wrapper.text()).not.toContain('chain_looks_leaf_only');
  });

  it('mismatch/chain_incomplete ⇒ 说清「指纹一致但只发了 1 张」并带上链深', async () => {
    stubDefault(statusDto(), {
      verify: () => jsonResponse(200, statusDto({
        live: {
          status: 'mismatch', checkedAt: iso(0), fingerprintSha256: FP_A, subjectCN: 'admin.fde.erix.vip',
          reason: 'chain_incomplete', chainDepth: 1,
        },
      })),
    });
    const wrapper = await mountView();

    await wrapper.get('[data-test="tls-live-check"]').trigger('click');
    await flushPromises();

    const text = textOf(wrapper, 'tls-live-mismatch');
    expect(text).toContain('只发了 1 张证书');
    expect(text).toContain('链深 1');
    expect(text).toContain('unable to verify the first certificate');
    expect(text).not.toContain('另一张');
    // 指纹两侧照旧列出来（chain_incomplete 时它们**相等**，这正是要让人看见的事实）
    expect(textOf(wrapper, 'tls-live-expected')).toBe(FP_A);
    expect(textOf(wrapper, 'tls-live-actual')).toBe(FP_A);
  });

  it('mismatch/fingerprint_mismatch（以及老服务端没有 reason）⇒ 仍是「另一张证书」那句', async () => {
    for (const live of [
      { status: 'mismatch', checkedAt: iso(0), fingerprintSha256: FP_B, reason: 'fingerprint_mismatch' },
      { status: 'mismatch', checkedAt: iso(0), fingerprintSha256: FP_B }, // 老服务端：没有 reason
    ]) {
      vi.unstubAllGlobals();
      setActivePinia(createPinia());
      stubDefault(statusDto(), { verify: () => jsonResponse(200, statusDto({ live })) });
      const wrapper = await mountView();
      await wrapper.get('[data-test="tls-live-check"]').trigger('click');
      await flushPromises();
      expect(textOf(wrapper, 'tls-live-mismatch')).toContain('另一张');
      expect(textOf(wrapper, 'tls-live-mismatch')).not.toContain('链深');
      wrapper.unmount();
    }
  });
});
