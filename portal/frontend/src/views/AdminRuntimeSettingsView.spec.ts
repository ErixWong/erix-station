// issue #677 P2b：管理台「运行时设置」列表页的单测（`AdminRuntimeSettingsView.vue`，契约
// `docs/api/portal.md` §4.21）。
//
// 装配照 `AdminUploadView.spec.ts` / `AdminPromptsView.spec.ts`：直接挂视图（本页不依赖路由）+
// 真实 i18n 单例 + pinia + 按 URL/方法分派的 fetch 桩（判据要读**请求体**，所以桩必须记下 body）。
// ⚠ 断言一律走 DOM / 请求桩，**不用 `w.emitted()`**（本机 `NODE_ENV=production` 下恒空 ⇒ 假红）。
//
// 用例名 R1–R8 就是工单 §2⑤ 的判据编号（R1–R5 是必做的那五格）：
//   R1 挂载只发 1 次 GET（懒挂载：进管理台不请求，切到这一 tab 才恰好 1 次）
//   R2 列表按 DTO 渲染两行：label / key / 值 / 来源 / 生效方式 / 更新时间一起出
//   R3 `value: null` 显示「未知」，**不是 0**（#390-A：键缺席不是 0）
//   R4 输入 7200 点保存 ⇒ `PUT /api/admin/runtime-settings/{key}`，body 是 `{"value":7200}`
//   R5 服务端 400 ⇒ 错误**只出现在一处**：`details.field='value'` 只标被尝试那一行；
//      `'key'` / `'body'` / 认不出 field ⇒ 只走整页一行，**任何一行都没有行内错误**（#702 的 LOW）
//   R6 越界照发（服务端才是闸）+ 解析不出整数 ⇒ 零请求
//   R7 空列表 / GET 失败 / 未加载 三态各自独立（错误不冒充空态，也不白屏）
//   R8 保存成功那一行显示「已保存」并回填服务端回读的生效值（不是用户敲的那一串）
//   R10 `hint`（#706）：服务端只在登记了的那一格带 `hint` 键 ⇒ 那一行下方出小字；
//       没登记的那一行**不存在** `runtime-hint-*` 元素（断言查询为空，不是断言文案为空）
//   R11 页尾通用尾注（P3 评审返修）：不许替各行代宣「重启 station-portal」——要重启什么以那一行
//       下方的小字为准，且必须点名「重建 FDE 容器」（zh/en 两份 locale 都断）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import AdminRuntimeSettingsView from './AdminRuntimeSettingsView.vue';
import { i18n, setLocale } from '../i18n';
import { useAdminStore } from '../stores/admin';

const GET_PATH = '/api/admin/runtime-settings';
const TTL_KEY = 'session.ttl_seconds';
const TTL_PATH = `${GET_PATH}/${TTL_KEY}`;
const SECOND_KEY = 'runner.max_concurrent_runs';

/** 后端 P2a 钉住的 DTO 形状（§4.21）：值 + 来源 + 生效方式 + 更新时间，一格一条。 */
const DTO = {
  items: [
    {
      key: TTL_KEY, label: '会话有效期（秒）', value: 86400,
      source: 'db', applyMode: 'hot',
      updatedAt: '2026-11-19T02:11:04.000Z', updatedBy: '3f2c0000-0000-4000-8000-0000000000a1',
    },
    {
      key: SECOND_KEY, label: '单工位并发 run 上限', value: 4,
      source: 'env', applyMode: 'restart',
      updatedAt: null, updatedBy: null,
    },
  ],
};

interface Recorded { url: string; method: string; body: unknown }
type Handler = (call: Recorded) => Response | undefined | Promise<Response | undefined>;

function stubFetch(handler: Handler): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = typeof init?.body === 'string' ? init.body : null;
    const call: Recorded = { url, method, body: raw === null ? null : JSON.parse(raw) };
    calls.push(call);
    const response = await handler(call);
    if (!response) throw new Error(`fetch 桩没有处理 ${method} ${url}`);
    return response;
  }));
  return calls;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response {
  const error = { code, message, retryable: false, ...(details ? { details } : {}) };
  return json(status, { error });
}

/** 默认桩：GET 回 `get`；PUT 回 `put`（缺省 200 + 把那一格的值换成请求体里的数，其余照旧）。 */
function stubDefault(get: unknown = DTO, put?: (call: Recorded) => Response): Recorded[] {
  return stubFetch((call) => {
    if (call.url === GET_PATH && call.method === 'GET') return json(200, get);
    if (call.url.startsWith(`${GET_PATH}/`) && call.method === 'PUT') {
      const key = decodeURIComponent(call.url.slice(GET_PATH.length + 1));
      const value = (call.body as { value: unknown }).value;
      return put
        ? put(call)
        : json(200, {
          item: {
            key, label: key, value, source: 'db', applyMode: 'hot',
            updatedAt: '2026-11-23T00:00:00.000Z', updatedBy: 'u-root',
          },
        });
    }
    return undefined;
  });
}

async function mountView(): Promise<VueWrapper> {
  const wrapper = mount(AdminRuntimeSettingsView, { global: { plugins: [i18n] } });
  await flushPromises();
  return wrapper;
}

const text = (w: VueWrapper, testId: string) => w.get(`[data-test="${testId}"]`).text();
const exists = (w: VueWrapper, testId: string) => w.find(`[data-test="${testId}"]`).exists();
const inputEl = (w: VueWrapper, key: string) =>
  w.get(`[data-test="runtime-input-${key}"]`).element as HTMLInputElement;
const puts = (calls: Recorded[]) => calls.filter((c) => c.method === 'PUT');
const gets = (calls: Recorded[]) => calls.filter((c) => c.method === 'GET');

async function setDraft(w: VueWrapper, key: string, value: string) {
  await w.get(`[data-test="runtime-input-${key}"]`).setValue(value);
  await flushPromises();
}

async function clickSave(w: VueWrapper, key: string) {
  await w.get(`[data-test="runtime-save-${key}"]`).trigger('click');
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

describe('R1 挂载恰好一次 GET', () => {
  it('进页面 ⇒ 只发 1 次 GET，且打的是 §4.21 那个路径', async () => {
    const calls = stubDefault();
    await mountView();

    expect(gets(calls)).toHaveLength(1);
    expect(gets(calls)[0].url).toBe(GET_PATH);
    expect(puts(calls)).toHaveLength(0);
  });

  it('store 侧：loaded=true 且 err=null（区分「没请求」与「服务端说 registry 是空的」）', async () => {
    stubDefault();
    await mountView();
    const store = useAdminStore();
    expect(store.runtimeSettingsLoaded).toBe(true);
    expect(store.runtimeSettingsErr).toBeNull();
    expect(store.runtimeSettings.map((row) => row.key)).toEqual([TTL_KEY, SECOND_KEY]);
  });
});

describe('R2 两行按 DTO 渲染：值 + 来源 + 生效方式一起出', () => {
  it('两行都有 label / key / 值 / 来源 / 生效方式 / 更新时间（只显示数字不算过关）', async () => {
    stubDefault();
    const w = await mountView();

    expect(exists(w, `runtime-row-${TTL_KEY}`)).toBe(true);
    expect(exists(w, `runtime-row-${SECOND_KEY}`)).toBe(true);

    expect(text(w, `runtime-label-${TTL_KEY}`)).toBe('会话有效期（秒）');
    expect(text(w, `runtime-key-${TTL_KEY}`)).toBe(TTL_KEY);
    expect(text(w, `runtime-value-${TTL_KEY}`)).toBe('86400');
    expect(text(w, `runtime-source-${TTL_KEY}`)).toContain('管理台');
    expect(text(w, `runtime-apply-${TTL_KEY}`)).toContain('立即生效');
    expect(text(w, `runtime-updated-${TTL_KEY}`)).toContain('2026-11-19T02:11:04.000Z');

    // 第二行：env + restart 两档各自的文案与 db + hot 不同（共用一句就等于把声明丢了）
    expect(text(w, `runtime-value-${SECOND_KEY}`)).toBe('4');
    expect(text(w, `runtime-source-${SECOND_KEY}`)).toContain('环境变量');
    expect(text(w, `runtime-apply-${SECOND_KEY}`)).toContain('需重启');
    // 从没被管理台存过 ⇒ 说「从未」，不显示空串或假时间
    expect(text(w, `runtime-updated-${SECOND_KEY}`)).toContain('从未');
  });

  it('表头五列都在（配置项 / 当前值 / 来源 / 生效方式 / 更新时间）', async () => {
    stubDefault();
    const w = await mountView();
    const head = w.get('table thead').text();
    for (const label of ['配置项', '当前值', '来源', '生效方式', '更新时间']) {
      expect(head).toContain(label);
    }
  });

  it('英文 locale 下同一页是英文（双语都真的写了）', async () => {
    setLocale('en');
    stubDefault();
    const w = await mountView();
    expect(text(w, `runtime-source-${TTL_KEY}`)).toContain('Admin console');
    expect(text(w, `runtime-apply-${SECOND_KEY}`)).toContain('restart');
  });
});

describe('R3 value=null 显示「未知」，不是 0', () => {
  it('服务端没给 value ⇒ 那一格「未知」、输入框留空（不预填 0）', async () => {
    const noValue = {
      items: [{ key: TTL_KEY, label: '会话有效期（秒）', source: 'default', applyMode: 'hot' }],
    };
    stubFetch((call) => (call.method === 'GET' ? json(200, noValue) : undefined));
    const w = await mountView();

    expect(text(w, `runtime-value-${TTL_KEY}`)).toBe('未知');
    expect(inputEl(w, TTL_KEY).value).toBe('');
    // 值没给不影响保存：前端不拿「未知」当校验失败（服务端才是闸）
    const save = w.get(`[data-test="runtime-save-${TTL_KEY}"]`);
    await setDraft(w, TTL_KEY, '7200');
    expect((save.element as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('R4 保存：PUT /{key} + body {"value":7200}', () => {
  it('输入 7200 点保存 ⇒ PUT 到该 key，body 逐字节是 {"value":7200}（number 不是字符串）', async () => {
    const calls = stubDefault();
    const w = await mountView();
    await setDraft(w, TTL_KEY, '7200');
    await clickSave(w, TTL_KEY);

    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0].url).toBe(TTL_PATH);
    expect(JSON.stringify(puts(calls)[0].body)).toBe('{"value":7200}');
    expect(typeof (puts(calls)[0].body as { value: unknown }).value).toBe('number');
  });

  it('保存第二行 ⇒ 打到第二行的 key（一列表不是只有一个旋钮）', async () => {
    const calls = stubDefault();
    const w = await mountView();
    await setDraft(w, SECOND_KEY, '9');
    await clickSave(w, SECOND_KEY);

    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0].url).toBe(`${GET_PATH}/${SECOND_KEY}`);
  });
});

describe('R5 400 按行标红（别行不跟着抖）', () => {
  it('details.field=value ⇒ 只有那一行 aria-invalid + 服务端文案可见', async () => {
    const tooSmall = errorResponse(
      400, 'validation_failed', 'session.ttl_seconds 必须在 60–2592000 之间',
      { field: 'value', min: 60, max: 2592000 },
    );
    stubDefault(DTO, () => tooSmall);
    const w = await mountView();
    await setDraft(w, TTL_KEY, '5');
    await clickSave(w, TTL_KEY);

    expect(inputEl(w, TTL_KEY).getAttribute('aria-invalid')).toBe('true');
    expect(text(w, `runtime-error-${TTL_KEY}`)).toContain('60–2592000');
    expect(exists(w, `runtime-saved-${TTL_KEY}`)).toBe(false);
    // 另一行什么都没做过 ⇒ 不许被同一次失败标红
    expect(inputEl(w, SECOND_KEY).getAttribute('aria-invalid')).not.toBe('true');
    expect(exists(w, `runtime-error-${SECOND_KEY}`)).toBe(false);
    // 同一句错只许出在一处：归了那一行，整页那行就不许再重复一遍
    expect(exists(w, 'runtime-field-error')).toBe(false);
    expect(useAdminStore().runtimeSaveField).toBe('value');
  });

  // #702 review 的 LOW：以前 `key`/`body` 会**同时**出现在被尝试那一行与整页一行 ⇒ 同一句错两遍。
  // 口径（§4.21 + `AdminUploadView`）：只有 `field='value'` 才挂到行上，其余一律只走整页那一行。
  it.each([
    { field: 'key', pointed: '配置项名字', message: '未知的运行时配置项' },
    { field: 'body', pointed: '请求体', message: '请求体形状不对' },
  ] as const)(
    'details.field=$field ⇒ 整页一行点名是哪一处，且**任何一行**都没有行内错误也不标红',
    async ({ field, pointed, message }) => {
      stubDefault(DTO, () => errorResponse(400, 'validation_failed', message, { field }));
      const w = await mountView();
      await setDraft(w, TTL_KEY, '7200');
      await clickSave(w, TTL_KEY);

      // 整页那一行：有服务端那句话，也点名了是哪一处
      expect(exists(w, 'runtime-field-error')).toBe(true);
      expect(text(w, 'runtime-field-error')).toContain(message);
      expect(text(w, 'runtime-field-error')).toContain(pointed);
      // 被尝试那一行与另一行：既没有行内文案，输入框也不红
      for (const key of [TTL_KEY, SECOND_KEY]) {
        expect(exists(w, `runtime-error-${key}`), `field=${field} 时 ${key} 不该有行内文案`).toBe(false);
        expect(inputEl(w, key).getAttribute('aria-invalid'),
          `field=${field} 时 ${key} 的框不该红`).not.toBe('true');
      }
      expect(exists(w, `runtime-saved-${TTL_KEY}`)).toBe(false);
      expect(useAdminStore().runtimeSaveField).toBe(field);
    },
  );

  // 认不出 field（非 §4.21 点名的三档，例如 500）⇒ 这句话**不许丢**：从行内改到整页一行，
  // 而不是两处都写（也不能两处都没）。以前它落在行内、整页一行是空的。
  it('details.field 认不出（如 500）⇒ 整页一行说这句话，任何一行都没有行内错误', async () => {
    stubDefault(DTO, () => errorResponse(500, 'internal', 'station-portal 暂时不可用'));
    const w = await mountView();
    await setDraft(w, TTL_KEY, '7200');
    await clickSave(w, TTL_KEY);

    expect(useAdminStore().runtimeSaveField).toBeNull();
    expect(text(w, 'runtime-field-error')).toContain('station-portal 暂时不可用');
    for (const key of [TTL_KEY, SECOND_KEY]) {
      expect(exists(w, `runtime-error-${key}`), `${key} 不该有行内文案`).toBe(false);
      expect(inputEl(w, key).getAttribute('aria-invalid'), `${key} 的框不该红`).not.toBe('true');
    }
  });

  it('details.field=key/body ⇒ 那一行不标红，改为整页一行点名是哪一处', async () => {
    stubDefault(DTO, () => errorResponse(400, 'validation_failed', '未知的运行时配置项', {
      field: 'key', known: [TTL_KEY],
    }));
    const w = await mountView();
    await setDraft(w, TTL_KEY, '7200');
    await clickSave(w, TTL_KEY);

    expect(inputEl(w, TTL_KEY).getAttribute('aria-invalid')).not.toBe('true');
    expect(text(w, 'runtime-field-error')).toContain('配置项名字');
  });
});

describe('R6 前端不做区间校验；解析不出整数就一个请求都不发', () => {
  it('越界的整数照发（1 秒 / 一亿秒都不在前端拦）', async () => {
    const calls = stubDefault();
    const w = await mountView();
    await setDraft(w, TTL_KEY, '1');
    await clickSave(w, TTL_KEY);
    await setDraft(w, TTL_KEY, '99999999');
    await clickSave(w, TTL_KEY);
    expect(puts(calls).map((c) => (c.body as { value: number }).value)).toEqual([1, 99999999]);
  });

  it('空 / 小数 / 负数草稿 ⇒ 按钮禁用、点下去零 PUT', async () => {
    const calls = stubDefault();
    const w = await mountView();
    for (const draft of ['', '1.5', '-1']) {
      await setDraft(w, TTL_KEY, draft);
      const save = w.get(`[data-test="runtime-save-${TTL_KEY}"]`);
      expect((save.element as HTMLButtonElement).disabled, `草稿「${draft}」`).toBe(true);
      await save.trigger('click');
      await flushPromises();
    }
    expect(puts(calls)).toHaveLength(0);
  });

  it('store 侧：草稿解析不出整数 ⇒ 零请求 + field=value + 「不是整数」这句话', async () => {
    const calls = stubDefault();
    await mountView();
    const store = useAdminStore();
    const err = await store.saveRuntimeSetting(TTL_KEY, '1e4');
    expect(err).toContain('不是整数');
    expect(store.runtimeSaveField).toBe('value');
    expect(puts(calls)).toHaveLength(0);
  });
});

describe('R7 三态互不冒充', () => {
  it('GET 500 ⇒ 有错误条、没有列表、也没有「空态」', async () => {
    const down = errorResponse(500, 'internal', 'db down');
    stubFetch((call) => (call.method === 'GET' ? down : undefined));
    const w = await mountView();
    const store = useAdminStore();
    expect(exists(w, 'runtime-load-error')).toBe(true);
    expect(text(w, 'runtime-load-error')).toContain('db down');
    expect(exists(w, 'runtime-empty')).toBe(false);
    expect(exists(w, `runtime-row-${TTL_KEY}`)).toBe(false);
    expect(store.runtimeSettingsLoaded).toBe(false);
  });

  it('200 但 items 为空 ⇒ 是空态，不是错误条', async () => {
    stubDefault({ items: [] });
    const w = await mountView();
    expect(exists(w, 'runtime-empty')).toBe(true);
    expect(exists(w, 'runtime-load-error')).toBe(false);
  });

  it('请求从未发生 ⇒ 显示「尚未加载」，不是空态也不是加载中（三态不互名）', async () => {
    stubDefault();
    const store = useAdminStore();
    // 把唯一触发点拆掉 ⇒ 本页今天就是「什么都没请求」的状态
    vi.spyOn(store, 'loadRuntimeSettings').mockResolvedValue(null);
    const w = mount(AdminRuntimeSettingsView, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(exists(w, 'runtime-not-loaded')).toBe(true);
    expect(exists(w, 'runtime-empty')).toBe(false);
    expect(exists(w, 'runtime-load-error')).toBe(false);
    expect(store.runtimeSettingsLoaded).toBe(false);
  });

  it('请求还在飞 ⇒ 是「加载中」，不提前拿空态充数；飞完才出列表', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    stubFetch(async (call) => {
      if (call.method === 'GET') { await gate; return json(200, DTO); }
      return undefined;
    });
    const w = mount(AdminRuntimeSettingsView, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(exists(w, 'runtime-loading')).toBe(true);
    expect(exists(w, 'runtime-empty')).toBe(false);
    expect(exists(w, `runtime-row-${TTL_KEY}`)).toBe(false);

    release();
    await flushPromises();
    expect(exists(w, 'runtime-loading')).toBe(false);
    expect(exists(w, `runtime-row-${TTL_KEY}`)).toBe(true);
  });

  it('点「重新读取」⇒ 再发恰好一次 GET（本页不缓存）', async () => {
    const calls = stubDefault();
    const w = await mountView();
    await w.get('[data-test="runtime-reload"]').trigger('click');
    await flushPromises();
    expect(gets(calls)).toHaveLength(2);
  });
});

describe('R8 保存成功：回填服务端回读的生效值 + 只在那一行说「已保存」', () => {
  it('敲 7200 而服务端回读 43200 ⇒ 输入框与当前值都是 43200，且「已保存」只在那一行', async () => {
    stubDefault(DTO, (call) => {
      const key = decodeURIComponent(call.url.slice(GET_PATH.length + 1));
      return json(200, {
        item: {
          key, label: '会话有效期（秒）', value: 43200, source: 'db', applyMode: 'hot',
          updatedAt: '2026-11-23T01:00:00.000Z', updatedBy: 'u-root',
        },
      });
    });
    const w = await mountView();
    await setDraft(w, TTL_KEY, '7200');
    await clickSave(w, TTL_KEY);

    expect(inputEl(w, TTL_KEY).value).toBe('43200');
    expect(text(w, `runtime-value-${TTL_KEY}`)).toBe('43200');
    expect(text(w, `runtime-saved-${TTL_KEY}`)).toContain('已保存');
    expect(exists(w, `runtime-saved-${SECOND_KEY}`)).toBe(false);
  });

  it('200 但响应里没有 item ⇒ 不说「已保存」，也不把输入当成已落库', async () => {
    stubDefault(DTO, () => json(200, {}));
    const w = await mountView();
    await setDraft(w, TTL_KEY, '7200');
    await clickSave(w, TTL_KEY);

    expect(exists(w, `runtime-saved-${TTL_KEY}`)).toBe(false);
    expect(text(w, `runtime-value-${TTL_KEY}`)).toBe('86400');
    expect(useAdminStore().runtimeSaveField).toBe('body');
    // 本层自判的 `body`（不是服务端 400 回来的）同样只走整页一行，不挂到行上
    expect(text(w, 'runtime-field-error')).toContain('请求体');
    expect(exists(w, `runtime-error-${TTL_KEY}`)).toBe(false);
    expect(inputEl(w, TTL_KEY).getAttribute('aria-invalid')).not.toBe('true');
  });
});

describe('R9 在写的那一行说「正在保存」，并锁住整页的写', () => {
  it('PUT 未归 ⇒ 那一行出「正在保存…」、两行的保存按钮全禁；归了才说「已保存」', async () => {
    let release!: (r: Response) => void;
    const gate = new Promise<Response>((resolve) => { release = resolve; });
    stubFetch((call) => (call.method === 'GET' ? json(200, DTO) : gate));
    const w = await mountView();

    await setDraft(w, TTL_KEY, '7200');
    await w.get(`[data-test="runtime-save-${TTL_KEY}"]`).trigger('click');
    await flushPromises();

    expect(text(w, `runtime-saving-${TTL_KEY}`)).toContain('正在保存');
    const disabled = (key: string) =>
      (w.get(`[data-test="runtime-save-${key}"]`).element as HTMLButtonElement).disabled;
    expect(disabled(TTL_KEY)).toBe(true);
    expect(disabled(SECOND_KEY)).toBe(true);
    expect(exists(w, `runtime-saved-${TTL_KEY}`)).toBe(false);

    release(json(200, {
      item: {
        key: TTL_KEY, label: '会话有效期（秒）', value: 7200, source: 'db', applyMode: 'hot',
        updatedAt: '2026-11-23T02:00:00.000Z', updatedBy: 'u-root',
      },
    }));
    await flushPromises();

    expect(exists(w, `runtime-saving-${TTL_KEY}`)).toBe(false);
    expect(text(w, `runtime-saved-${TTL_KEY}`)).toContain('已保存');
    expect(disabled(SECOND_KEY)).toBe(false);
  });
});

// ── R10（#706 收尾）：`hint` 的渲染 ─────────────────────────────────────────────
// 后端只在 registry 登记了 hint 的那一格带上 `hint` 键（`portal/src/runtime-settings.js` 的
// `withHint`，契约 §4.21）：没登记就**连键都没有**。所以这一页的口径是「有就在那一行下方渲染
// 一行小字，没有就整个元素不存在」—— 判据是 DOM 里那个元素在不在，不是文案空不空：留一个
// 空 `<p>` 既撑高度，又让「后端没给提示」与「提示是一句空话」在页面上长得一模一样。
describe('R10 hint：有就在那一行下方渲染，没有就不存在那个元素', () => {
  const RETENTION_KEY = 'workspace.retention_days';
  const HINT = '0 = 关掉自动清理，但不会取消已排定的删除：'
    + '改回正数后，已过期的工位会在下一次清理被删除；'
    + '而 0 期间完成离职的工位不会被补上期限（也不会被追删）。';

  /** 第一行是「登记了 hint 的那一格」；第二行照旧（后端没登记 ⇒ DTO 里连 `hint` 键都没有）。 */
  const withHintDto = () => ({
    items: [
      {
        key: RETENTION_KEY, label: '已离职工位目录保留天数（0 = 不自动清理）', value: 0,
        source: 'db', applyMode: 'hot',
        updatedAt: '2026-11-23T03:00:00.000Z', updatedBy: 'u-root',
        hint: HINT,
      },
      DTO.items[1],
    ],
  });

  it('DTO 给了 hint ⇒ 那一行下方原文显示；没给的那一行查不到 runtime-hint-* 元素', async () => {
    stubDefault(withHintDto());
    const w = await mountView();

    expect(text(w, `runtime-hint-${RETENTION_KEY}`)).toBe(HINT);
    // 没有 hint 的那一行：**该 data-test 查询为空**（不是「元素在、只是文案为空」）
    expect(exists(w, `runtime-hint-${SECOND_KEY}`), '第二行不该有提示元素').toBe(false);
    expect(w.find(`[data-test="runtime-hint-${SECOND_KEY}"]`).exists()).toBe(false);
    // 整页只许有这一个提示元素 ⇒ 「一律渲染空 <p>」当场红（会变成 2 个）
    expect(w.findAll('[data-test^="runtime-hint-"]')).toHaveLength(1);
  });

  it('保存后提示不许消失：PUT 响应的 item 也带 hint ⇒ 回填那一行仍是那句话', async () => {
    stubDefault(withHintDto(), () => json(200, {
      item: {
        key: RETENTION_KEY, label: '已离职工位目录保留天数（0 = 不自动清理）', value: 30,
        source: 'db', applyMode: 'hot',
        updatedAt: '2026-11-23T04:00:00.000Z', updatedBy: 'u-root',
        hint: HINT,
      },
    }));
    const w = await mountView();
    await setDraft(w, RETENTION_KEY, '30');
    await clickSave(w, RETENTION_KEY);

    expect(text(w, `runtime-value-${RETENTION_KEY}`)).toBe('30');
    expect(text(w, `runtime-hint-${RETENTION_KEY}`)).toBe(HINT);
    expect(w.findAll('[data-test^="runtime-hint-"]')).toHaveLength(1);
  });
});

// ── R11（#677 P3 评审返修）：页尾那条通用尾注不许「代各行宣布」生效方式 ────────────
// delegate 那三格（`applyMode: 'restart'`）的生效路径是**重建 FDE 容器**，不是重启 station-portal：
// portal 只在建容器那一刻把生效值写进容器 env，重启 portal 不会改动任何已存在容器的 env，
// 而新建容器本来也不需要重启 portal。旧尾注那句「改完要重启 station-portal 才生效」对这三格是
// 假话，且和每行下方的 hint 小字在同一屏自相矛盾 ⇒ 尾注只许把「要重启什么」指回那一行的小字，
// 并点名「重建 FDE 容器会打断该工位正在跑的 run」；旧那句覆盖式断言不许复活。
// locale 两份都要红得下来：旧文案只改中文的话，英文那半句同样在说谎。
describe('R11 尾注：生效方式以每行小字为准，不写「一律重启 station-portal」', () => {
  it.each([
    {
      locale: 'zh-CN' as const,
      must: ['以这一行下方的说明为准', '重建 FDE 容器'],
      mustNot: ['改完要重启 station-portal 才生效'],
    },
    {
      locale: 'en' as const,
      must: ['small print under that row', 'FDE container recreated'],
      mustNot: ['needs a restart only applies after station-portal restarts'],
    },
  ])('$locale ⇒ 尾注指向行内小字并点名 FDE 容器重建，旧句式不在 DOM 里', async ({
    locale, must, mustNot,
  }) => {
    setLocale(locale);
    stubDefault();
    const w = await mountView();

    // 可断言性本身：这一页其它可断言元素都有 data-test，尾注曾经只有样式没有锚点，
    // 断言只能退化成「全文本搜索」⇒ 整页任何一处出现同样的字都算绿（假绿）。
    expect(exists(w, 'runtime-footnote'), '尾注必须有 data-test="runtime-footnote"').toBe(true);

    const note = text(w, 'runtime-footnote');
    for (const s of must) expect(note, `${locale} 尾注少了「${s}」`).toContain(s);
    for (const s of mustNot) expect(note, `${locale} 尾注复活了旧句式「${s}」`).not.toContain(s);
  });
});
