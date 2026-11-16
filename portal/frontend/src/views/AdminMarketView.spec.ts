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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import AdminMarketView from './AdminMarketView.vue';
import { i18n, setLocale } from '../i18n';
import { zhCN } from '../i18n/locales/zh-CN';
import { en } from '../i18n/locales/en';
import { ADMIN_MARKET_ITEMS_PATH, adminMarketItemPath } from '../lib/market';

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

describe('⑧ 编辑（PUT）', () => {
  it('不选新文件 ⇒ PUT 不带 bundle；带了才带', async () => {
    const { wrapper, calls } = await mountWith((call) => {
      const base = listHandler(call);
      if (base) return base;
      if (call.method === 'PUT' && call.url === adminMarketItemPath('p1')) {
        return json(200, { item: item('p1', { version: '1.0.1' }) });
      }
      return undefined;
    });
    await wrapper.get('[data-test="market-edit-p1"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="field-slug"]').element).toHaveProperty('value', 'p1');
    await wrapper.get('[data-test="field-version"]').setValue('1.0.1');
    await wrapper.get('[data-test="market-submit"]').trigger('submit');
    await flushPromises();

    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe(adminMarketItemPath('p1'));
    expect(put?.body?.version).toBe('1.0.1');
    expect('bundle' in (put?.body as Record<string, unknown>)).toBe(false);

    await wrapper.get('[data-test="market-edit-p1"]').trigger('click');
    await flushPromises();
    await pickFiles(wrapper, [{ path: 'p1/skill.mjs', content: 'x' }]);
    await wrapper.get('[data-test="market-submit"]').trigger('submit');
    await flushPromises();
    const secondPut = calls.filter((c) => c.method === 'PUT').at(-1);
    expect(secondPut?.body?.bundle).toBeDefined();
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
