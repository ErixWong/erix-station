// 能力市场管理台单测（issue #595 M2，`AdminMarketView.vue`；契约 §7 管理面 + §8 管理台）。
//
// 装配照 `AdminMacrosView.spec.ts` / `AdminUploadView.spec.ts`：直接挂视图 + 真实 i18n 单例 +
// 按 URL/方法分派的 fetch 桩（判据要读**请求体**，所以桩必须记下 body）。
// 红线（工单 §10）：**不用 `w.emitted()`**，全部走 DOM 与请求桩。
//
// 用例编号就是交付报告里引用的编号：
//   ① 列表渲染：state/slug/版本/安装数/安全分；缺 `installs` ⇒ 「—」而不是 0
//   ② 过滤：选择 state ⇒ 请求带 `?state=`，「全部」⇒ 不带 query
//   ③ 发布：POST 的请求体是 `{slug,…,bundle:{files:[{path, content_base64}]}}`，base64 真是文件内容
//   ④ 非法 path 被挡：`../` / 绝对路径 ⇒ **零 POST**，页面上点名是哪一条（服务端才是真闸）
//   ⑤ 扫描结果：warnings 列表 + score 渲染（advisory，不拦发布）
//   ⑥ 状态迁移：发布/下线各打一次 `…/publish`、`…/retire`
//   ⑦ 400 `validation_failed` + `details.field` ⇒ 那一格 aria-invalid + 错误行点名字段
//   ⑧ 编辑不选文件 ⇒ PUT 不带 `bundle`（只改元数据）
//   ⑨ 双语成对：`admin.market.*` 与 `admin.tabs.market`
//   ⑩ MCP 发布面（#608 §8.1）：kind 切换与字段组、`reason` 缺失**不发请求**、slots 增删、
//      `inject` 随 transport 锁定、凭据面板只显示「已设置 / 未设置」+ 源码级「没有读值入口」
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import AdminMarketView from './AdminMarketView.vue';
// #608 §11 的「源码级断言不存在读值请求」：源码文本走 vite `?raw`（issue #349 的口径：
// jsdom 下 `node:fs` 会被 externalize 成浏览器桩，`new URL(…, import.meta.url)` 在 vitest 下又是 http: URL）。
import viewSource from './AdminMarketView.vue?raw';
import marketSource from '../lib/market.ts?raw';
import { i18n, setLocale } from '../i18n';
import { zhCN } from '../i18n/locales/zh-CN';
import { en } from '../i18n/locales/en';
import {
  ADMIN_MARKET_ITEMS_PATH,
  adminMarketItemPath,
  adminMarketSecretsPath,
  normalizeMcpSecrets,
} from '../lib/market';

interface Recorded { url: string; method: string; body: Record<string, unknown> | null }
type Handler = (call: Recorded) => Response | undefined;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function fail(status: number, code: string, message: string, details?: Record<string, unknown>): Response {
  return json(status, { error: { code, message, ...(details ? { details } : {}) } });
}

function stubFetch(handler: Handler): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = typeof init?.body === 'string' ? init.body : null;
    const call: Recorded = { url, method, body: raw === null ? null : (JSON.parse(raw) as Record<string, unknown>) };
    calls.push(call);
    const response = handler(call);
    if (!response) throw new Error(`fetch 桩没有处理 ${method} ${url}`);
    return response;
  }));
  return calls;
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────

function item(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, kind: 'skill', slug: id, name: `能力 ${id}`, summary: '一句话',
    when_to_use: '需要它的时候', version: '1.0.0', state: 'draft', tags: ['pdf'],
    installs: 3, security_score: 90, ...over,
  };
}

async function mountWith(handler: Handler): Promise<{ wrapper: VueWrapper; calls: Recorded[] }> {
  const calls = stubFetch(handler);
  const wrapper = mount(AdminMarketView, { global: { plugins: [i18n] } });
  await flushPromises();
  return { wrapper, calls };
}

/**
 * 列表桩。**只认列表地址**（`…/items` 或 `…/items?state=`）：详情地址是 `…/items/<id>`，
 * 用 `startsWith` 会把详情请求也吃掉（第一轮就踩过：详情拿到列表 ⇒ 分数渲染成「—」）。
 */
const listHandler: Handler = (call) =>
  (call.method === 'GET'
    && (call.url === ADMIN_MARKET_ITEMS_PATH || call.url.startsWith(`${ADMIN_MARKET_ITEMS_PATH}?`))
    ? json(200, { items: [item('d1'), item('p1', { state: 'published', installs: 0 })] })
    : undefined);

/** 打开「发布新条目」表单。 */
async function openForm(wrapper: VueWrapper): Promise<void> {
  await wrapper.get('[data-test="market-create-open"]').trigger('click');
  await flushPromises();
}

/** 往 `<input type=file multiple>` 里塞文件（jsdom 没有 DataTransfer，用 defineProperty，照 DirectoryTree.spec）。 */
async function pickFiles(wrapper: VueWrapper, entries: Array<{ path: string; content: string }>): Promise<void> {
  const input = wrapper.get('[data-test="field-bundle"]').element as HTMLInputElement;
  const files = entries.map(({ path, content }) => {
    const name = path.split('/').pop() as string;
    const file = new File([content], name, { type: 'text/plain' });
    // `webkitRelativePath` 在 jsdom 里是只读空串 ⇒ 只能这样打桩（目录选择时浏览器给的就是它）。
    Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true });
    return file;
  });
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await input.dispatchEvent(new Event('change'));
  await flushPromises();
}

async function fillMeta(wrapper: VueWrapper): Promise<void> {
  await wrapper.get('[data-test="field-slug"]').setValue('pdf-tools');
  await wrapper.get('[data-test="field-name"]').setValue('PDF 工具');
  await wrapper.get('[data-test="field-summary"]').setValue('抽取 PDF 文本与表格');
  await wrapper.get('[data-test="field-when_to_use"]').setValue('读、转、检查 PDF 时');
  await wrapper.get('[data-test="field-version"]').setValue('1.0.0');
  await wrapper.get('[data-test="field-tags"]').setValue('pdf, docs');
}

const text = (w: VueWrapper, testId: string): string => w.get(`[data-test="${testId}"]`).text();
const exists = (w: VueWrapper, testId: string): boolean => w.find(`[data-test="${testId}"]`).exists();
const posts = (calls: Recorded[], suffix = ''): Recorded[] =>
  calls.filter((c) => c.method === 'POST' && c.url.endsWith(suffix));

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('① 列表渲染', () => {
  it('打开恰好一次 GET；state/slug/版本/安装数/安全分逐列渲染', async () => {
    const { wrapper, calls } = await mountWith(listHandler);
    expect(calls.filter((c) => c.method === 'GET' && c.url.startsWith(ADMIN_MARKET_ITEMS_PATH))).toHaveLength(1);
    const row = wrapper.get('[data-test="market-row-p1"]');
    expect(row.text()).toContain('已发布');
    expect(row.text()).toContain('p1');
    expect(row.text()).toContain('1.0.0');
    expect(text(wrapper, 'market-row-d1')).toContain('草稿');
    // `installs: 0` 是**真 0**（与缺键的「—」区分开）
    expect(row.text()).toContain('0');
  });

  it('服务端没下发 installs ⇒ 「—」，不拿 0 冒充「没人装」', async () => {
    const { wrapper } = await mountWith((call) => {
      if (call.method === 'GET') return json(200, { items: [item('x1', { installs: undefined })] });
      return undefined;
    });
    const cells = wrapper.get('[data-test="market-row-x1"]').findAll('td');
    expect(cells[3].text()).toBe('—');
  });

  it('已发布条目给「下线」，草稿给「发布」（另一颗不出现）', async () => {
    const { wrapper } = await mountWith(listHandler);
    expect(exists(wrapper, 'market-publish-p1')).toBe(false);
    expect(exists(wrapper, 'market-retire-p1')).toBe(true);
    expect(exists(wrapper, 'market-publish-d1')).toBe(true);
    expect(exists(wrapper, 'market-retire-d1')).toBe(false);
  });
});

describe('② state 过滤（§7-3 的 `?state=`）', () => {
  it('选 published ⇒ 请求带 `?state=published`；选全部 ⇒ 不带 query', async () => {
    const { wrapper, calls } = await mountWith(listHandler);
    await wrapper.get('[data-test="market-filter"]').setValue('published');
    await flushPromises();
    expect(calls.some((c) => c.url === `${ADMIN_MARKET_ITEMS_PATH}?state=published`)).toBe(true);
    await wrapper.get('[data-test="market-filter"]').setValue('');
    await flushPromises();
    expect(calls.at(-1)!.url).toBe(ADMIN_MARKET_ITEMS_PATH);
  });
});

describe('③ 发布（浏览器侧打 base64 bundle）', () => {
  it('POST 的请求体是元数据 + `{files:[{path, content_base64}]}`', async () => {
    const { wrapper, calls } = await mountWith((call) => {
      const base = listHandler(call);
      if (base) return base;
      if (call.method === 'POST' && call.url === ADMIN_MARKET_ITEMS_PATH) {
        return json(200, { item: item('new1', { slug: 'pdf-tools', state: 'draft', security_score: 90 }) });
      }
      return undefined;
    });
    await openForm(wrapper);
    await fillMeta(wrapper);
    await pickFiles(wrapper, [
      { path: 'pdf-tools/skill.mjs', content: "export default { id: 'pdf-tools' };\n" },
      { path: 'pdf-tools/SKILL.md', content: '# PDF\n' },
    ]);

    await wrapper.get('[data-test="market-submit"]').trigger('submit');
    await flushPromises();

    const hit = posts(calls, ADMIN_MARKET_ITEMS_PATH);
    expect(hit).toHaveLength(1);
    const body = hit[0].body as Record<string, unknown>;
    expect(body.slug).toBe('pdf-tools');
    expect(body.when_to_use).toBe('读、转、检查 PDF 时');
    expect(body.tags).toEqual(['pdf', 'docs']);
    const bundle = body.bundle as { files: Array<{ path: string; content_base64: string }> };
    expect(bundle.files.map((f) => f.path)).toEqual(['pdf-tools/skill.mjs', 'pdf-tools/SKILL.md']);
    // base64 必须是**真内容**（用 node 的 Buffer 独立算一遍对拍）
    expect(Buffer.from(bundle.files[0].content_base64, 'base64').toString('utf8'))
      .toBe("export default { id: 'pdf-tools' };\n");
    expect(text(wrapper, 'market-result')).toContain('已发布条目');
  });

  it('没选文件也能提交（服务端会说缺 `skill.mjs`，前端不冒充校验）', async () => {
    const { wrapper, calls } = await mountWith((call) => {
      const base = listHandler(call);
      if (base) return base;
      if (call.method === 'POST') {
        return fail(400, 'validation_failed', 'bundle: missing skill.mjs', { field: 'bundle' });
      }
      return undefined;
    });
    await openForm(wrapper);
    await fillMeta(wrapper);
    await wrapper.get('[data-test="market-submit"]').trigger('submit');
    await flushPromises();
    expect(posts(calls, ADMIN_MARKET_ITEMS_PATH)).toHaveLength(1);
    const body = posts(calls, ADMIN_MARKET_ITEMS_PATH)[0].body as Record<string, unknown>;
    expect('bundle' in body).toBe(false); // 没选文件 ⇒ 连 bundle 键都不带
    expect(text(wrapper, 'form-error')).toContain('bundle');
  });
});

describe('④ 非法 path 前端先挡（服务端才是真闸）', () => {
  it('`../` 与绝对路径 ⇒ 零 POST，页面点名是哪一条', async () => {
    const { wrapper, calls } = await mountWith(listHandler);
    await openForm(wrapper);
    await fillMeta(wrapper);
    await pickFiles(wrapper, [
      { path: 'pdf-tools/skill.mjs', content: 'x' },
      { path: '../escape/skill.mjs', content: 'x' },
      { path: '/abs/skill.mjs', content: 'x' },
    ]);
    expect(text(wrapper, 'picked-summary')).toContain('3');

    await wrapper.get('[data-test="market-submit"]').trigger('submit');
    await flushPromises();

    expect(posts(calls, ADMIN_MARKET_ITEMS_PATH)).toHaveLength(0); // **没发请求**
    const issues = text(wrapper, 'path-issues');
    expect(issues).toContain('../escape/skill.mjs');
    expect(issues).toContain('/abs/skill.mjs');
    expect(issues).toContain('..');
    // 拦下之后表单还开着（不是静默失败）
    expect(exists(wrapper, 'market-form')).toBe(true);
  });

  it('合法 path 不会被误挡（含空格、多级目录）', async () => {
    const { wrapper, calls } = await mountWith((call) => {
      const base = listHandler(call);
      if (base) return base;
      if (call.method === 'POST') return json(200, { item: item('ok', { slug: 'pdf-tools' }) });
      return undefined;
    });
    await openForm(wrapper);
    await fillMeta(wrapper);
    await pickFiles(wrapper, [{ path: 'pdf-tools/references/long form.md', content: 'x' }]);
    await wrapper.get('[data-test="market-submit"]').trigger('submit');
    await flushPromises();
    expect(exists(wrapper, 'path-issues')).toBe(false);
    expect(posts(calls, ADMIN_MARKET_ITEMS_PATH)).toHaveLength(1);
  });
});

describe('⑤ 扫描结果（§3：advisory）', () => {
  it('详情里的文件清单 + warnings + score 都渲染出来', async () => {
    const detail = {
      id: 'p1', slug: 'cap-p1', name: '能力 p1', state: 'published', version: '1.0.0',
      installs: 0, security_score: 70,
      security_warnings: [
        { code: 'child_process', path: 'cap-p1/skill.mjs', line: 12, note: '用了 child_process' },
        { code: 'eval', path: 'cap-p1/scripts/x.mjs', line: null, note: '用了 eval(' },
      ],
      files: [{ path: 'cap-p1/skill.mjs', bytes: 2048 }, { path: 'cap-p1/SKILL.md', bytes: 300 }],
    };
    const { wrapper } = await mountWith((call) => {
      const base = listHandler(call);
      if (base) return base;
      if (call.method === 'GET' && call.url === adminMarketItemPath('p1')) return json(200, { item: detail });
      return undefined;
    });
    await wrapper.get('[data-test="market-detail-p1"]').trigger('click');
    await flushPromises();

    expect(text(wrapper, 'market-detail-scan')).toContain('70');
    expect(text(wrapper, 'market-detail-warnings')).toContain('child_process');
    expect(text(wrapper, 'market-detail-warnings')).toContain('cap-p1/skill.mjs');
    expect(text(wrapper, 'market-detail-warnings')).toContain('12');
    expect(text(wrapper, 'market-detail-warnings')).toContain('eval');
    expect(text(wrapper, 'market-detail-files')).toContain('cap-p1/skill.mjs');
    expect(text(wrapper, 'market-detail-files')).toContain('2 KiB');
  });

  it('服务端回空 warnings ⇒ 说「扫描没有提示」（不是空白）', async () => {
    const { wrapper } = await mountWith((call) => {
      const base = listHandler(call);
      if (base) return base;
      if (call.method === 'GET' && call.url === adminMarketItemPath('d1')) {
        return json(200, { item: { ...item('d1'), security_warnings: [], files: [] } });
      }
      return undefined;
    });
    await wrapper.get('[data-test="market-detail-d1"]').trigger('click');
    await flushPromises();
    expect(text(wrapper, 'market-detail-warnings-none')).toContain('没有提示');
    expect(text(wrapper, 'market-detail-files')).toContain('没拿到文件清单');
  });

  it('发布响应里带扫描结果 ⇒ 表单关掉后仍看得见分数', async () => {
    const { wrapper } = await mountWith((call) => {
      const base = listHandler(call);
      if (base) return base;
      if (call.method === 'POST' && call.url === ADMIN_MARKET_ITEMS_PATH) {
        return json(200, {
          item: { ...item('new1', { slug: 'pdf-tools' }), security_score: 80,
            security_warnings: [{ code: 'fetch', path: 'pdf-tools/skill.mjs', note: '有 fetch(' }] },
        });
      }
      return undefined;
    });
    await openForm(wrapper);
    await fillMeta(wrapper);
    await pickFiles(wrapper, [{ path: 'pdf-tools/skill.mjs', content: 'x' }]);
    await wrapper.get('[data-test="market-submit"]').trigger('submit');
    await flushPromises();
    expect(text(wrapper, 'market-scan-result')).toContain('80');
    expect(text(wrapper, 'market-scan-result')).toContain('fetch');
  });
});

describe('⑥ 状态迁移', () => {
  it('点「发布」⇒ POST `…/publish` 一次并重读列表', async () => {
    const { wrapper, calls } = await mountWith((call) => {
      const base = listHandler(call);
      if (base) return base;
      if (call.method === 'POST' && call.url === `${adminMarketItemPath('d1')}/publish`) {
        return json(200, { item: item('d1', { state: 'published' }) });
      }
      return undefined;
    });
    await wrapper.get('[data-test="market-publish-d1"]').trigger('click');
    await flushPromises();
    expect(posts(calls, '/publish')).toHaveLength(1);
    expect(text(wrapper, 'market-result')).toContain('已发布');
  });

  it('点「下线」⇒ POST `…/retire`；409 也说人话', async () => {
    const { wrapper, calls } = await mountWith((call) => {
      const base = listHandler(call);
      if (base) return base;
      if (call.method === 'POST' && call.url === `${adminMarketItemPath('p1')}/retire`) {
        return fail(409, 'capability_not_published', 'not published');
      }
      return undefined;
    });
    await wrapper.get('[data-test="market-retire-p1"]').trigger('click');
    await flushPromises();
    expect(posts(calls, '/retire')).toHaveLength(1);
    expect(text(wrapper, 'market-error')).toContain('已发布');
  });
});

describe('⑦ 服务端 400 的字段点名（details.field）', () => {
  it('`details.field=when_to_use` ⇒ 那一格 aria-invalid，错误行点名字段', async () => {
    const { wrapper } = await mountWith((call) => {
      const base = listHandler(call);
      if (base) return base;
      if (call.method === 'POST') {
        return fail(400, 'validation_failed', 'when_to_use too short', { field: 'when_to_use' });
      }
      return undefined;
    });
    await openForm(wrapper);
    await fillMeta(wrapper);
    await wrapper.get('[data-test="market-submit"]').trigger('submit');
    await flushPromises();

    const box = wrapper.get('[data-test="field-when_to_use"]').element as HTMLTextAreaElement;
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(wrapper.get('[data-test="field-slug"]').attributes('aria-invalid')).toBeUndefined();
    expect(text(wrapper, 'form-error')).toContain('when_to_use');
  });

  it('认不出的字段名 ⇒ 只给整表一条错误，不猜是哪个框', async () => {
    const { wrapper } = await mountWith((call) => {
      const base = listHandler(call);
      if (base) return base;
      if (call.method === 'POST') return fail(400, 'validation_failed', 'nope', { field: 'zzz' });
      return undefined;
    });
    await openForm(wrapper);
    await fillMeta(wrapper);
    await wrapper.get('[data-test="market-submit"]').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[aria-invalid="true"]').exists()).toBe(false);
    expect(exists(wrapper, 'form-error')).toBe(true);
  });
});

/** 编辑要读一次详情（§7-3 的列表不保证带 `when_to_use`，见视图里 `openEdit` 的注释）。 */
const detailOfP1 = {
  id: 'p1', slug: 'p1', name: '能力 p1', state: 'published', version: '1.0.0', installs: 0,
  security_score: 90, when_to_use: '原有的何时用', description_md: '原有正文',
  author: '平台', license: 'MIT',
};

describe('⑧ 编辑（PUT）', () => {
  it('不选新文件 ⇒ PUT 不带 bundle；带了才带', async () => {
    const { wrapper, calls } = await mountWith((call) => {
      const base = listHandler(call);
      if (base) return base;
      if (call.method === 'GET' && call.url === adminMarketItemPath('p1')) {
        return json(200, { item: detailOfP1 });
      }
      if (call.method === 'PUT' && call.url === adminMarketItemPath('p1')) {
        return json(200, { item: item('p1', { version: '1.0.1' }) });
      }
      return undefined;
    });
    await wrapper.get('[data-test="market-edit-p1"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="field-slug"]').element).toHaveProperty('value', 'p1');
    // 编辑**先回填详情**：只改版本号时不能把必填的 `when_to_use` 发成空串
    expect(wrapper.get('[data-test="field-when_to_use"]').element)
      .toHaveProperty('value', '原有的何时用');
    expect(wrapper.get('[data-test="field-license"]').element).toHaveProperty('value', 'MIT');
    await wrapper.get('[data-test="field-version"]').setValue('1.0.1');
    await wrapper.get('[data-test="market-submit"]').trigger('submit');
    await flushPromises();

    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe(adminMarketItemPath('p1'));
    expect(put?.body?.version).toBe('1.0.1');
    expect(put?.body?.when_to_use).toBe('原有的何时用');
    expect('bundle' in (put?.body as Record<string, unknown>)).toBe(false);

    await wrapper.get('[data-test="market-edit-p1"]').trigger('click');
    await flushPromises();
    await pickFiles(wrapper, [{ path: 'p1/skill.mjs', content: 'x' }]);
    await wrapper.get('[data-test="market-submit"]').trigger('submit');
    await flushPromises();
    const secondPut = calls.filter((c) => c.method === 'PUT').at(-1);
    expect(secondPut?.body?.bundle).toBeDefined();
  });

  it('回填详情读失败 ⇒ 页面明说「那几格可能是空的」（不假装表单是全的）', async () => {
    const { wrapper } = await mountWith((call) => {
      const base = listHandler(call);
      if (base) return base;
      if (call.method === 'GET' && call.url === adminMarketItemPath('p1')) {
        return fail(500, 'internal', 'db down');
      }
      return undefined;
    });
    await wrapper.get('[data-test="market-edit-p1"]').trigger('click');
    await flushPromises();
    expect(exists(wrapper, 'form-prefill-failed')).toBe(true);
    expect(text(wrapper, 'form-prefill-failed')).toContain('详情');
  });
});

describe('⑨ 双语成对（admin.market.* / admin.tabs.market）', () => {
  function leaves(value: unknown, prefix = ''): string[] {
    if (value !== null && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>)
        .flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key));
    }
    return [prefix];
  }

  it('zh 与 en 的 admin.market.* 叶子键完全一致，且各自是真语言', () => {
    const zh = leaves(zhCN.admin.market, 'admin.market').sort();
    const enKeys = leaves(en.admin.market, 'admin.market').sort();
    expect(zh.length).toBeGreaterThan(30);
    expect(enKeys).toEqual(zh);
    for (const key of zh) {
      const zhValue = key.split('.').reduce<unknown>(
        (node, segment) => (node as Record<string, unknown>)[segment], zhCN,
      ) as string;
      const enValue = key.split('.').reduce<unknown>(
        (node, segment) => (node as Record<string, unknown>)[segment], en,
      ) as string;
      expect(zhValue, key).toMatch(/[\u4e00-\u9fff]/);
      expect(enValue, key).not.toMatch(/[\u4e00-\u9fff]/);
    }
    expect(zhCN.admin.tabs.market).toBe('能力市场');
    expect(en.admin.tabs.market).toBe('Capability market');
  });

  it('path 问题的双语键集合 = lib 的判据枚举（加判据不补文案会在这里红）', () => {
    const zhCodes = Object.keys(zhCN.admin.market.pathIssue).sort();
    expect(zhCodes).toEqual(Object.keys(en.admin.market.pathIssue).sort());
    expect([...zhCodes].sort()).toEqual(['absolute', 'empty', 'parentRef', 'separator', 'tooLong']);
  });
});

// ── ⑩ MCP 发布面（#608 §8.1 / §11）─────────────────────────────────────

/** 一条 `kind='mcp'` 的管理台详情（字段面按 §4 给全；`tools_cache` 是 runner 回填的那份）。 */
function mcpDetailFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm1', kind: 'mcp', slug: 'srch', name: '检索服务', summary: '外部检索',
    when_to_use: '要查外部资料时', version: '1.0.0', state: 'published', tags: ['search'],
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-srch'], url: '',
    exposure: 'deferred', lifecycle: 'run', timeout_ms: 30000, reason: 'stateful', resident: false,
    slots: [{ name: 'SRCH_TOKEN', kind: 'secret', inject: 'env', required: true, description: '检索令牌' }],
    // §8.1：工具清单就住在 `manifest.tools_cache`（runner 回填），`tools_cache_at` 是回填时间
    manifest: {
      tools_cache: [{ name: 'search', description: '搜一下' }],
      tools_cache_at: '2026-11-17T08:00:00Z',
    },
    ...over,
  };
}

/** 凭据行夹具（§7.2 的形状：只有声明 + 有没有值）。 */
function secretSlotRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'A_TOKEN', kind: 'secret', inject: 'env', required: true,
    has_value: false, updated_at: null, updated_by: null, ...over,
  };
}

/** 列表 + 详情 + 凭据三个地址的分派桩（凭据回 `slotsFor()`；PUT 交给 `extra`）。 */
function mcpHandler(
  detail: Record<string, unknown>,
  slotsFor: () => unknown[],
  extra?: Handler,
): Handler {
  const slug = String(detail.slug ?? 'srch');
  return (call) => {
    if (call.method === 'GET'
      && (call.url === ADMIN_MARKET_ITEMS_PATH || call.url.startsWith(`${ADMIN_MARKET_ITEMS_PATH}?`))) {
      return json(200, { items: [item('m1', { kind: 'mcp', slug })] });
    }
    if (call.method === 'GET' && call.url === adminMarketItemPath('m1')) return json(200, { item: detail });
    if (call.method === 'GET' && call.url === adminMarketSecretsPath('m1')) {
      return json(200, { item: { slots: slotsFor() } });
    }
    return extra === undefined ? undefined : extra(call);
  };
}

/** 挂列表 ⇒ 点开 mcp 详情（详情之后组件会自己再去打凭据地址）。 */
async function openMcpFixture(
  detail: Record<string, unknown>,
  slotsFor: () => unknown[],
  extra?: Handler,
): Promise<{ wrapper: VueWrapper; calls: Recorded[] }> {
  const mounted = await mountWith(mcpHandler(detail, slotsFor, extra));
  await mounted.wrapper.get('[data-test="market-detail-srch"]').trigger('click');
  await flushPromises();
  return mounted;
}

/** 新建桩：列表 + `POST …/items` 回一条新条目。 */
const createHandler: Handler = (call) => {
  const base = listHandler(call);
  if (base) return base;
  if (call.method === 'POST' && call.url === ADMIN_MARKET_ITEMS_PATH) {
    return json(200, { item: item('new1', { slug: 'srch', kind: 'mcp', state: 'draft' }) });
  }
  return undefined;
};

/** 开表单并把种类切到 mcp（后面的 MCP 用例都从这里出发）。 */
async function openMcpForm(wrapper: VueWrapper): Promise<void> {
  await openForm(wrapper);
  await fillMeta(wrapper);
  await wrapper.get('[data-test="field-kind"]').setValue('mcp');
}

describe('⑩ MCP 发布面（#608 §8.1）', () => {
  it('详情：连接摘要 + reason/exposure 走 i18n + 工具清单（tools_cache 与回填时间）', async () => {
    const { wrapper } = await openMcpFixture(mcpDetailFixture(), () => [secretSlotRow()]);
    expect(exists(wrapper, 'market-detail-mcp')).toBe(true);
    expect(text(wrapper, 'detail-mcp-endpoint')).toContain('npx -y @modelcontextprotocol/server-srch');
    // 英文枚举不直接喷给人看（§8.2）
    expect(text(wrapper, 'detail-mcp-exposure')).toContain('经网关');
    expect(text(wrapper, 'detail-mcp-reason')).toContain('有状态');
    expect(text(wrapper, 'detail-mcp-reason')).not.toContain('stateful');
    expect(exists(wrapper, 'market-detail-toolscache-none')).toBe(false);
    expect(text(wrapper, 'market-detail-toolscache')).toContain('search');
    expect(text(wrapper, 'market-detail-toolscache-at')).toContain('2026-11-17T08:00:00Z');
  });

  it('工具清单未回填 ⇒ 「还没有 FDE 连过这个 server」（不拿空数组冒充「有工具」）', async () => {
    const { wrapper } = await openMcpFixture(
      mcpDetailFixture({ manifest: {} }),
      () => [secretSlotRow()],
    );
    expect(exists(wrapper, 'market-detail-toolscache-none')).toBe(true);
    expect(text(wrapper, 'market-detail-toolscache-none')).toContain('还没有 FDE 连过');
    expect(exists(wrapper, 'market-detail-toolscache-at')).toBe(false);
  });

  it('凭据区只说「已设置 / 未设置」：服务端多发的明文不落地（DOM + DTO + 地址三道锁）', async () => {
    const slots = [
      secretSlotRow({
        has_value: true, updated_at: '2026-11-17T07:00:00Z', updated_by: 'admin',
        // 服务端不应该发这些键（§7.2）；发了也不得被收进 DTO / 上屏（canary）
        value: 'CANARY-PLAIN', plaintext: 'CANARY-PLAIN-2', secret: 'CANARY-PLAIN-3',
      }),
      secretSlotRow({ name: 'B_CFG', kind: 'config', required: false }),
    ];
    const { wrapper, calls } = await openMcpFixture(mcpDetailFixture(), () => slots);
    expect(text(wrapper, 'secret-row-A_TOKEN')).toContain('已设置');
    expect(text(wrapper, 'secret-row-A_TOKEN')).toContain('2026-11-17T07:00:00Z');
    expect(text(wrapper, 'secret-row-B_CFG')).toContain('未设置');
    // canary：整页文本里不许出现任何明文（§10-3「不记录值」的 UI 面）
    expect(wrapper.text()).not.toContain('CANARY');
    // DTO 面：形状只有白名单那几格，值从结构上就溜不进来
    const rows = normalizeMcpSecrets({ item: { slots } });
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0] as unknown as Record<string, unknown>).sort())
      .toEqual(['hasValue', 'inject', 'kind', 'name', 'required', 'updatedAt', 'updatedBy']);
    expect(JSON.stringify(rows)).not.toContain('CANARY');
    // 地址面：读凭据只有那一个地址，没子路径也没 query（挂 `?reveal=1` 就是给读值留门）
    const secretCalls = calls.filter((c) => c.url.includes('/secrets'));
    expect(secretCalls.map((c) => c.url)).toEqual([adminMarketSecretsPath('m1')]);
    expect(secretCalls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('源码级：视图对凭据地址只有一种 GET 与一种 PUT，lib 不读值键（§8.1 硬约束）', () => {
    expect(viewSource.match(/adminMarketSecretsPath\(/g) ?? []).toHaveLength(2); // 一读一写
    expect(viewSource.match(/api\(adminMarketSecretsPath\([^)]*\)\)/g) ?? []).toHaveLength(1);
    expect(viewSource.match(/api\(adminMarketSecretsPath\([^)]*\),\s*\{\s*method:\s*'PUT'/g) ?? [])
      .toHaveLength(1);
    expect(viewSource).not.toMatch(/\?reveal|reveal=1|include_value|with_value|show_value|secrets\?/);
    const fn = marketSource.match(/export function normalizeMcpSecrets[\s\S]*?\n\}/);
    if (fn === null) throw new Error('normalizeMcpSecrets 必须能在 lib 源码里定位到（改名/换写法时本用例先红）');
    expect(fn[0]).toContain('has_value');
    expect(fn[0]).not.toMatch(/\brow\.(value|values|secret|plaintext)\b/);
    expect(fn[0]).not.toMatch(/\[['"]values?['"]\]/);
  });

  it('「设置」modal：输入框从不回填旧值；PUT 只发 values，写完只重读声明（不回显）', async () => {
    let stored = false;
    const { wrapper, calls } = await openMcpFixture(mcpDetailFixture(), () => [secretSlotRow({ has_value: stored })],
      (call) => (call.method === 'PUT' && call.url === adminMarketSecretsPath('m1')
        ? (stored = true, json(200, { item: { slots: [secretSlotRow({ has_value: true })] } }))
        : undefined));
    expect(text(wrapper, 'secret-has-value-A_TOKEN')).toContain('未设置');
    await wrapper.get('[data-test="secret-set-A_TOKEN"]').trigger('click');
    await flushPromises();
    const valueInput = wrapper.get('[data-test="secret-value"]');
    expect((valueInput.element as HTMLInputElement).value).toBe(''); // 只写不读 ⇒ 没有旧值可回填
    expect((valueInput.element as HTMLInputElement).type).toBe('password');
    expect(exists(wrapper, 'secret-fde-id')).toBe(false);             // 默认 global，不先摆一个没用的格子
    await valueInput.setValue('NEW-VALUE');
    await wrapper.get('[data-test="secret-submit"]').trigger('submit');
    await flushPromises();
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({ scope: 'global', values: { A_TOKEN: 'NEW-VALUE' } });
    expect(wrapper.text()).not.toContain('NEW-VALUE'); // 写完不回显，变的只有 `has_value` 那一格
    expect(text(wrapper, 'secrets-result')).toContain('已设置');
    expect(calls.filter((c) => c.method === 'GET' && c.url === adminMarketSecretsPath('m1'))).toHaveLength(2);
    expect(text(wrapper, 'secret-has-value-A_TOKEN')).toContain('已设置');
  });

  it('空串提交发 `null`（＝删除该值）；fde 作用域带 `fde_id`', async () => {
    const { wrapper, calls } = await openMcpFixture(mcpDetailFixture(), () => [secretSlotRow({ has_value: true })],
      (call) => (call.method === 'PUT' && call.url === adminMarketSecretsPath('m1')
        ? json(200, { item: { slots: [secretSlotRow()] } })
        : undefined));
    await wrapper.get('[data-test="secret-set-A_TOKEN"]').trigger('click');
    await wrapper.get('[data-test="secret-scope"]').setValue('fde');
    expect(exists(wrapper, 'secret-fde-id')).toBe(true);
    await wrapper.get('[data-test="secret-fde-id"]').setValue('fde-77');
    await wrapper.get('[data-test="secret-submit"]').trigger('submit');
    await flushPromises();
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({ scope: 'fde', fde_id: 'fde-77', values: { A_TOKEN: null } });
    expect(text(wrapper, 'secrets-result')).toContain('已删除');
  });

  it('表单：kind 切到 mcp ⇒ MCP 字段组出现、包体区消失；transport 换档 ⇒ command/args ↔ url 互斥', async () => {
    const { wrapper } = await mountWith(listHandler);
    await openForm(wrapper);
    expect(exists(wrapper, 'form-mcp')).toBe(false);
    expect(exists(wrapper, 'field-bundle')).toBe(true);
    await wrapper.get('[data-test="field-kind"]').setValue('mcp');
    expect(exists(wrapper, 'form-mcp')).toBe(true);
    expect(exists(wrapper, 'field-bundle')).toBe(false); // §7.2：`kind='mcp'` 不需要 bundle
    expect(exists(wrapper, 'field-command')).toBe(true);
    expect(exists(wrapper, 'field-url')).toBe(false);
    await wrapper.get('[data-test="field-transport"]').setValue('http');
    expect(exists(wrapper, 'field-url')).toBe(true);
    expect(exists(wrapper, 'field-command')).toBe(false);
    // exposure 三档各带一行可观察差异（§4.3）
    for (const [value, expected] of [
      ['direct', '模型可直接调'], ['deferred', '先 search 拿 schema 再 call'], ['hidden', '整条不物化'],
    ] as const) {
      await wrapper.get('[data-test="field-exposure"]').setValue(value);
      expect(text(wrapper, 'mcp-exposure-hint'), value).toContain(expected);
    }
    // reason 是**必选下拉**：默认那格空，四个枚举各有中文句子
    const options = wrapper.get('[data-test="field-reason"]').findAll('option');
    expect(options.map((o) => o.element.getAttribute('value')))
      .toEqual(['', 'stateful', 'tool_surface_gt_12', 'shared_quota', 'credential_boundary']);
    expect(options[1].text()).toContain('有状态');
  });

  it('reason 没选 ⇒ 一次 POST 都不发；补齐后发的就是 §4 的 MCP 字段面', async () => {
    const { wrapper, calls } = await mountWith(createHandler);
    await openMcpForm(wrapper);
    await wrapper.get('[data-test="field-command"]').setValue('npx');
    await wrapper.get('[data-test="field-args"]').setValue('-y\n@modelcontextprotocol/server-srch');
    await wrapper.get('[data-test="field-timeout_ms"]').setValue('45000');

    await wrapper.get('[data-test="market-submit"]').trigger('submit');
    await flushPromises();
    expect(posts(calls, ADMIN_MARKET_ITEMS_PATH)).toHaveLength(0);
    expect(text(wrapper, 'mcp-issues')).toContain('没选准入理由');
    expect(wrapper.get('[data-test="field-reason"]').attributes('aria-invalid')).toBe('true');

    // 超时超上限（§10-8：≤ 300 s）同属一眼假 ⇒ 照样不发
    await wrapper.get('[data-test="field-reason"]').setValue('stateful');
    await wrapper.get('[data-test="field-timeout_ms"]').setValue('900000');
    await wrapper.get('[data-test="market-submit"]').trigger('submit');
    await flushPromises();
    expect(posts(calls, ADMIN_MARKET_ITEMS_PATH)).toHaveLength(0);
    expect(text(wrapper, 'mcp-issues')).toContain('300000');

    await wrapper.get('[data-test="field-timeout_ms"]').setValue('45000');
    await wrapper.get('[data-test="market-submit"]').trigger('submit');
    await flushPromises();
    const hit = posts(calls, ADMIN_MARKET_ITEMS_PATH);
    expect(hit).toHaveLength(1);
    const body = hit[0].body as Record<string, unknown>;
    expect(body.kind).toBe('mcp');
    expect(body.transport).toBe('stdio');
    expect(body.command).toBe('npx');
    expect(body.args).toEqual(['-y', '@modelcontextprotocol/server-srch']);
    expect(body.reason).toBe('stateful');
    expect(body.exposure).toBe('deferred');
    expect(body.lifecycle).toBe('run');
    expect(body.timeout_ms).toBe(45000);
    expect(body.resident).toBe(false);
    expect(body.bundle).toBeUndefined(); // MCP 没有包体
    expect(body.manifest).toMatchObject({ transport: 'stdio', reason: 'stateful', slots: [] });
  });

  it('slots 增删行；`inject` 随 transport 锁死（只读说明，不是可选控件）；重名不发请求', async () => {
    const { wrapper, calls } = await mountWith(createHandler);
    await openMcpForm(wrapper);
    expect(exists(wrapper, 'mcp-slots-none')).toBe(true);
    await wrapper.get('[data-test="mcp-slot-add"]').trigger('click');
    await flushPromises();
    expect(exists(wrapper, 'mcp-slots-none')).toBe(false);
    const injectCell = wrapper.get('[data-test="mcp-slot-0-inject"]');
    // 锁：不是可选控件（§8.1 要的是只读说明，不是个默认选中的下拉）
    expect(['INPUT', 'SELECT', 'TEXTAREA']).not.toContain(injectCell.element.tagName);
    expect(injectCell.text()).toBe('env'); // mcp + stdio ⇒ `env` 是唯一合法档（§4.2）
    await wrapper.get('[data-test="field-transport"]').setValue('http');
    expect(wrapper.get('[data-test="mcp-slot-0-inject"]').text()).toBe('header');
    expect(text(wrapper, 'mcp-inject-locked')).toContain('http');
    expect(text(wrapper, 'mcp-inject-locked')).toContain('header');
    await wrapper.get('[data-test="field-transport"]').setValue('stdio');
    await wrapper.get('[data-test="mcp-slot-0-name"]').setValue('SRCH_TOKEN');
    await wrapper.get('[data-test="mcp-slot-0-kind"]').setValue('config');
    await wrapper.get('[data-test="mcp-slot-0-description"]').setValue('检索令牌');
    await wrapper.get('[data-test="mcp-slot-add"]').trigger('click');
    await wrapper.get('[data-test="mcp-slot-1-name"]').setValue('DROP_ME');
    await wrapper.get('[data-test="mcp-slot-1-remove"]').trigger('click');
    expect(exists(wrapper, 'mcp-slot-1')).toBe(false);

    // 重名 ⇒ 不发请求（§4.1「item 内唯一」）
    await wrapper.get('[data-test="mcp-slot-add"]').trigger('click');
    await wrapper.get('[data-test="mcp-slot-1-name"]').setValue('SRCH_TOKEN');
    await wrapper.get('[data-test="field-reason"]').setValue('stateful');
    await wrapper.get('[data-test="field-command"]').setValue('npx');
    await wrapper.get('[data-test="market-submit"]').trigger('submit');
    await flushPromises();
    expect(posts(calls, ADMIN_MARKET_ITEMS_PATH)).toHaveLength(0);
    expect(text(wrapper, 'mcp-issues')).toContain('重复');

    await wrapper.get('[data-test="mcp-slot-1-remove"]').trigger('click');
    await wrapper.get('[data-test="market-submit"]').trigger('submit');
    await flushPromises();
    const body = posts(calls, ADMIN_MARKET_ITEMS_PATH)[0].body as Record<string, unknown>;
    expect(body.slots).toEqual([{
      name: 'SRCH_TOKEN', kind: 'config', inject: 'env', required: true, description: '检索令牌',
    }]);
  });
});
