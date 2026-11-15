// issue #485 片 A「上传上限」管理台页的单测（`AdminUploadView.vue`，契约 `docs/api/portal.md` §4.15）。
//
// 装配风格照 `AdminMailView.spec.ts`：直接挂视图（本页不依赖路由）+ 真实 i18n 单例 + pinia +
// 按 URL/方法分派的 fetch 桩（判据要读**请求体**，所以桩必须把 body 记下来）。
//
// 逐条对应本页的硬口径（用例名就是报告里引用的编号）：
//   ① 打开恰好一次 GET；生效值与**来源**一起渲染（只显示数字不算过关）
//   ② 保存的请求体是 `{maxFileBytes: <number>}` —— **必须是 number**（服务端只收 JSON number，§4.15-2）
//   ③ 保存成功后输入框回填的是**服务端回读的生效值**，不是用户敲的那串字符
//   ④ `400 validation_failed` + `details.field='maxFileBytes'` ⇒ 那个框 aria-invalid + 文案可见
//   ⑤ 解析不出整数（空、`1.5`）⇒ 禁保存且**零请求**（不发一个必然 400 的垃圾体）
//   ⑥ 越界但仍是整数 ⇒ **照发**（前端不抢服务端的闸），同时给提前提示
//   ⑦ `source ≠ db` 时把原因说清楚（`no_row` / `invalid_db_value` / `read_failed` 三种各一条）
//   ⑧ 服务端给了缺键/不认识的形状 ⇒ 显示「未知」，**不是 0**（#390-A：键缺席不是 false/0）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import AdminUploadView from './AdminUploadView.vue';
import { i18n, setLocale } from '../i18n';
import { useAdminStore } from '../stores/admin';

const PATH = '/api/admin/upload/settings';

const DB_SETTINGS = {
  maxFileBytes: 8 * 1024 * 1024,
  source: 'db',
  reason: null,
  dbMaxFileBytes: 8 * 1024 * 1024,
  envMaxFileBytes: 32 * 1024 * 1024,
  envIsExplicit: true,
  defaultMaxFileBytes: 32 * 1024 * 1024,
  limits: { minBytes: 1024 * 1024, maxBytes: 1024 * 1024 * 1024 },
  updatedAt: '2026-11-16T02:00:00.000Z',
  updatedBy: '3f2c0000-0000-4000-8000-000000000000',
};

const ENV_SETTINGS = { ...DB_SETTINGS, source: 'env', reason: 'no_row', dbMaxFileBytes: null };

interface RecordedCall { url: string; method: string; body: unknown }
type Handler = (call: RecordedCall) => Response | undefined | Promise<Response | undefined>;

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string, details?: Record<string, unknown>): Response {
  return jsonResponse(status, { error: { code, message, retryable: false, ...(details ? { details } : {}) } });
}

/** 默认桩：GET 回 `get`；PUT 回 `put`（缺省 200 + 回读值）。 */
function stubDefault(get: unknown, put?: (call: RecordedCall) => Response) {
  return stubFetch((call) => {
    if (call.url === PATH && call.method === 'GET') return jsonResponse(200, get);
    if (call.url === PATH && call.method === 'PUT') {
      return put ? put(call) : jsonResponse(200, { ...DB_SETTINGS, maxFileBytes: (call.body as { maxFileBytes: number }).maxFileBytes, dbMaxFileBytes: (call.body as { maxFileBytes: number }).maxFileBytes, source: 'db', reason: null });
    }
    return undefined;
  });
}

async function mountView(): Promise<VueWrapper> {
  const wrapper = mount(AdminUploadView, { global: { plugins: [i18n] } });
  await flushPromises();
  return wrapper;
}

const text = (w: VueWrapper, testId: string) => w.get(`[data-test="${testId}"]`).text();
const exists = (w: VueWrapper, testId: string) => w.find(`[data-test="${testId}"]`).exists();
const inputEl = (w: VueWrapper) => w.get('[data-test="upload-input"]').element as HTMLInputElement;
const inputOf = (w: VueWrapper) => inputEl(w).value
  ;
const puts = (calls: RecordedCall[]) => calls.filter((c) => c.method === 'PUT');
const gets = (calls: RecordedCall[]) => calls.filter((c) => c.method === 'GET');

async function setDraft(w: VueWrapper, value: string) {
  await w.get('[data-test="upload-input"]').setValue(value);
  await flushPromises();
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('① 打开恰好一次 GET，生效值与来源一起渲染', () => {
  it('一次 GET；显示字节数与人话换算，并显示来源是「管理台（DB）」', async () => {
    const calls = stubDefault(DB_SETTINGS);
    const w = await mountView();

    expect(gets(calls)).toHaveLength(1);
    expect(gets(calls)[0].url).toBe(PATH);
    expect(text(w, 'upload-effective-value')).toContain('8 MiB');
    // 原始字节数就在它旁边的人话换算后面（同一个 dd）。
    expect(w.get('[data-test="upload-effective"]').text()).toContain('8388608');
    expect(text(w, 'upload-effective-source')).toContain('管理台');
    // `source='db'` ⇒ 不需要解释回落，所以原因行不该出现。
    expect(exists(w, 'upload-reason')).toBe(false);
    // 三个来源同时可见（排查时不用猜哪一边在说话）。
    expect(exists(w, 'upload-sources')).toBe(true);
  });

  it('store 侧：loadUploadSettings 成功返回 null 且 loaded=true（区分「没请求」与「服务端给了默认值」）', async () => {
    stubDefault(ENV_SETTINGS);
    await mountView();
    const store = useAdminStore();
    expect(store.uploadSettingsLoaded).toBe(true);
    expect(store.uploadSettingsErr).toBeNull();
    expect(store.uploadSettings?.source).toBe('env');
  });
});

describe('② 保存请求体必须是 {maxFileBytes: <number>}', () => {
  it('填 1048576 ⇒ 请求体是 {maxFileBytes: 1048576}，类型是 number 不是字符串', async () => {
    const calls = stubDefault(DB_SETTINGS);
    const w = await mountView();
    await setDraft(w, '1048576');
    await w.get('[data-test="upload-save"]').trigger('click');
    await flushPromises();

    expect(puts(calls)).toHaveLength(1);
    const body = puts(calls)[0].body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['maxFileBytes']);
    expect(typeof body.maxFileBytes).toBe('number');
    expect(body.maxFileBytes).toBe(1048576);
  });
});

describe('③ 保存成功后回填服务端回读的生效值（不是用户敲的那串）', () => {
  it('用户填 1048576，服务端回读成 2097152 ⇒ 输入框变成 2097152 并给出「已保存」', async () => {
    stubDefault(DB_SETTINGS, () => jsonResponse(200, {
      ...DB_SETTINGS, maxFileBytes: 2097152, dbMaxFileBytes: 2097152, source: 'db', reason: null,
    }));
    const w = await mountView();
    await setDraft(w, '1048576');
    await w.get('[data-test="upload-save"]').trigger('click');
    await flushPromises();

    expect(inputOf(w)).toBe('2097152');
    expect(text(w, 'upload-effective-value')).toContain('2 MiB');
    expect(exists(w, 'upload-save-ok')).toBe(true);
  });
});

describe('④ 400 按字段标红', () => {
  it('details.field=maxFileBytes ⇒ input aria-invalid=true 且服务端 message 可见，且没有「已保存」', async () => {
    stubDefault(DB_SETTINGS, () => errorResponse(400, 'validation_failed', 'maxFileBytes 必须在 1048576–1073741824 字节之间', {
      field: 'maxFileBytes', min_bytes: 1048576, max_bytes: 1073741824,
    }));
    const w = await mountView();
    await setDraft(w, '512');
    await w.get('[data-test="upload-save"]').trigger('click');
    await flushPromises();

    expect(inputEl(w).getAttribute('aria-invalid')).toBe('true');
    expect(text(w, 'field-error-maxFileBytes')).toContain('maxFileBytes 必须在');
    expect(exists(w, 'upload-save-ok')).toBe(false);
    expect(useAdminStore().uploadSaveField).toBe('maxFileBytes');
  });

  it('认不出的 details.field ⇒ 不猜是哪个框（退化成整表一条错误，input 不标红）', async () => {
    stubDefault(DB_SETTINGS, () => errorResponse(400, 'validation_failed', '请求体必须是对象', { field: 'body2' }));
    const w = await mountView();
    await setDraft(w, '2097152');
    await w.get('[data-test="upload-save"]').trigger('click');
    await flushPromises();

    expect(useAdminStore().uploadSaveField).toBeNull();
    expect(inputEl(w).getAttribute('aria-invalid')).not.toBe('true');
    expect(exists(w, 'upload-save-error')).toBe(true);
  });
});

describe('⑤ 解析不出整数 ⇒ 禁保存且零请求', () => {
  // ⚠ 这里只列「字符串里真的不是整数」的形状。`'1e7'` 不列：`<input type=number>` 会把它归一成
  // `10000000`（jsdom 与浏览器同行为，实测），于是它到得了 lib 的就已经是整数了——那一族的
  // 字符串形状由 `lib/uploadSettings.spec.ts` 直接测纯函数（视图层测不到它）。
  for (const draft of ['', '   ', '1.5', 'abc']) {
    it(`草稿「${draft}」⇒ 保存按钮禁用，点下去零 PUT`, async () => {
      const calls = stubDefault(DB_SETTINGS);
      const w = await mountView();
      await setDraft(w, draft);
      const save = w.get('[data-test="upload-save"]');
      expect((save.element as HTMLButtonElement).disabled).toBe(true);
      await save.trigger('click');
      await flushPromises();
      expect(puts(calls)).toHaveLength(0);
    });
  }

  it('空草稿时给出「还不是一个整数」这句话（而不是显示 0 B）', async () => {
    stubDefault(DB_SETTINGS);
    const w = await mountView();
    await setDraft(w, '');
    expect(text(w, 'upload-draft-readable')).toContain('还不是一个整数');
  });
});

describe('⑥ 越界但仍是整数 ⇒ 照发（服务端才是闸）', () => {
  it('填 12 GiB ⇒ 请求真的发出去了，同时页面上有越界的提前提示', async () => {
    const calls = stubDefault(DB_SETTINGS);
    const w = await mountView();
    await setDraft(w, String(12 * 1024 * 1024 * 1024));
    expect(exists(w, 'upload-range-hint')).toBe(true);
    await w.get('[data-test="upload-save"]').trigger('click');
    await flushPromises();
    expect(puts(calls)).toHaveLength(1);
    expect((puts(calls)[0].body as { maxFileBytes: number }).maxFileBytes).toBe(12 * 1024 * 1024 * 1024);
  });

  it('区间内的整数不该给出越界提示', async () => {
    stubDefault(DB_SETTINGS);
    const w = await mountView();
    await setDraft(w, '2097152');
    expect(exists(w, 'upload-range-hint')).toBe(false);
    expect(text(w, 'upload-draft-readable')).toContain('2 MiB');
  });
});

describe('⑦ source ≠ db 时把原因说清楚', () => {
  it('no_row：说「管理台还没存过值」，来源显示环境变量', async () => {
    stubDefault({ ...ENV_SETTINGS, reason: 'no_row' });
    const w = await mountView();
    expect(text(w, 'upload-effective-source')).toContain('FILE_UPLOAD_MAX_BYTES');
    expect(text(w, 'upload-reason')).toContain('还没存过值');
  });

  it('invalid_db_value：明说「DB 里那个值用不了，已回落」', async () => {
    stubDefault({ ...ENV_SETTINGS, reason: 'invalid_db_value', dbMaxFileBytes: null });
    const w = await mountView();
    expect(text(w, 'upload-reason')).toContain('用不了');
  });

  it('read_failed：明说「读不到表，上传本身不受影响」', async () => {
    stubDefault({ ...ENV_SETTINGS, reason: 'read_failed' });
    const w = await mountView();
    expect(text(w, 'upload-reason')).toContain('上传本身不受影响');
  });

  it('GET 失败（非 200）⇒ 页面给错误条，不白屏也不显示 0', async () => {
    stubFetch((call) => (call.method === 'GET'
      ? errorResponse(500, 'internal', 'db down')
      : undefined));
    const w = await mountView();
    expect(exists(w, 'upload-load-error')).toBe(true);
    expect(exists(w, 'upload-effective')).toBe(false);
  });
});

describe('⑧ 键缺席 = 未知，不是 0（#390-A 纪律）', () => {
  it('服务端只回 {source:"db"} 时生效值显示「未知」，输入框留空而不是 0', async () => {
    stubFetch((call) => (call.method === 'GET' ? jsonResponse(200, { source: 'db' }) : undefined));
    const w = await mountView();
    expect(text(w, 'upload-effective-value')).toBe('未知');
    expect(inputOf(w)).toBe('');
    // 区间也没给 ⇒ 不许显示一个编出来的区间，也不许因此拦下保存
    expect(exists(w, 'upload-limits')).toBe(false);
    await setDraft(w, '2097152');
    expect((w.get('[data-test="upload-save"]').element as HTMLButtonElement).disabled).toBe(false);
  });

  it('未知的 source 值不许被当成 db 或 default', async () => {
    stubFetch((call) => (call.method === 'GET'
      ? jsonResponse(200, { ...DB_SETTINGS, source: 'mysql' })
      : undefined));
    const w = await mountView();
    expect(text(w, 'upload-effective-source')).toBe('未知');
  });

  it('英文 locale 下同一页有英文文案（双语都真的写了）', async () => {
    setLocale('en');
    stubDefault(DB_SETTINGS);
    const w = await mountView();
    expect(text(w, 'upload-effective-source')).toContain('Admin console');
    expect(text(w, 'upload-effective-value')).toContain('8 MiB');
  });
});
