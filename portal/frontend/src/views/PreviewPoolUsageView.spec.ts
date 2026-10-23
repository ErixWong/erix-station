// issue #350 管理台「预览号池占用总览」单测。装配风格照 AdminPreviewPorts.spec.ts：
// 真实 i18n 单例 + App + createAppRouter(createMemoryHistory()) + 按 URL 分派的 fetch 桩。
//
// 逐条对应工单判据（每个 describe/it 名都点明判据号，报告里直接引用这些名字）：
//   ① 懒挂载（进管理台 0 次，切到该 tab 恰好 1 次）
//   ② 前端零端口/号池字面量（源码级，按**数值**判；含扫描器自测 22_000 / 0x5618 / 2.2e4 / 800）
//   ③ 不猜数（缺失/脏值 → 「—」；「还没请求」≠「一个都没有」；has_more 必须说清「还有更多」+ limit）
//   ④ 与改块流程接上（引用式 + 只读提示；**红线**：绝不自动改 block_start_input / 自动提交）
//   ⑤ partial > 0 独立呈现（不并进 free/occupied）
//   ⑥ 错误面可见（.syserr 一行 + 服务端 message 原文，只加本地化前缀）
// 另加：§4.7a 三条自洽关系的「对不上就明说」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import App from '../App.vue';
import { createAppRouter } from '../router';
import { useAdminStore } from '../stores/admin';
import { i18n, setLocale } from '../i18n';
import {
  blockEnd,
  classifyBlock,
  formatBlockLabel,
  normalizeUsage,
  previewUsagePath,
  usageConsistencyIssues,
  usageErrorText,
  PREVIEW_USAGE_PATH,
} from '../lib/previewPoolUsage';
// 判据②：源码级断言读**源码文本**（vite 的 `?raw`；前端 spec 跑在 jsdom，
// **不能** `import 'node:fs'`——#349 刚踩的坑）。扫的是新加的这两个源文件。
import viewSource from './PreviewPoolUsageView.vue?raw';
import libSource from '../lib/previewPoolUsage.ts?raw';

const ADMIN_USER = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local',
};

const USERS = {
  items: [
    {
      id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alpha-fde',
      status: 'active', totp_enabled: false, last_login_at: null,
      onboarding: { state: 'done', step: null, error: null },
    },
  ],
};

const PORTS = {
  items: [
    {
      id: 'aaaaaaaa-0000-4000-8000-000000002200', port: 31000,
      hostname: 'alpha-fde-p-31000.fde.erix.vip', url: 'http://alpha-fde-p-31000.fde.erix.vip:8090',
      state: 'allocated', scope: 'fde', role: 'spare', exposure: 'private',
    },
  ],
};

// ⚠ 夹具故意用**非真机**的号池（31000 起、100 段）：页面若把真机数字写死（22000/29999/800）
// 就会在这里露馅（判据②的行为面）。
const POOL = { start: 31000, end: 31999, block_size: 10, total_blocks: 100 };

const USAGE = {
  pool: POOL,
  // §4.7a 自洽：free 97 + partial 2 + occupied 1 = 100；len(occupied_blocks)=3 = partial + occupied
  summary: { total_blocks: 100, free: 97, partial: 2, occupied: 1 },
  occupied_blocks: [
    { start: 31000, end: 31009, occupied_count: 10, fde_names: ['eric'] },
    { start: 31020, end: 31029, occupied_count: 3, fde_names: ['bob', 'dana'] },
    { start: 31050, end: 31059, occupied_count: 1, fde_names: ['dana'] },
  ],
  free_blocks: { items: [31010, 31030, 31040], limit: 3, has_more: true },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Handler = (url: string, init?: RequestInit) => Response | undefined | Promise<Response | undefined>;

function defaultHandler(url: string): Response | undefined {
  if (url === '/api/me') return jsonResponse(200, { user: ADMIN_USER });
  if (url === '/api/admin/users') return jsonResponse(200, USERS);
  if (url === '/api/admin/git-hosts') return jsonResponse(200, { items: [] });
  if (url === '/api/admin/llm/providers') return jsonResponse(200, { items: [] });
  if (url === '/api/admin/fdes/alpha-fde/ports') return jsonResponse(200, PORTS);
  return undefined;
}

async function mountAdmin(handler: Handler = () => undefined, path = '/admin/users') {
  const pinia = createPinia();
  setActivePinia(pinia);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return (await handler(url, init)) ?? defaultHandler(url)
      ?? jsonResponse(404, { error: { code: 'not_found', message: 'not found' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [pinia, router, i18n] }, attachTo: document.body });
  await flushPromises();
  return { wrapper, fetchMock, router, pinia };
}

/** 号池占用总览的请求（判据①：数它）。 */
function usageCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith(PREVIEW_USAGE_PATH));
}

/** 点管理台 tab（tab 是 AdminLayout 的 router-link，按名字找）。
 * 路由级组件是 `() => import(...)`：点完要等动态 import 解析完、视图真的挂上（
 * 用目标视图自己的锚点等，而不是数固定轮次的 flushPromises）。 */
async function clickTab(wrapper: VueWrapper, label: string, awaitSelector?: string) {
  const tab = wrapper.findAll('nav a').find((item) => item.text() === label);
  if (!tab) throw new Error(`管理台 tab「${label}」不存在`);
  await tab.trigger('click');
  await flushPromises();
  if (awaitSelector) {
    await vi.waitFor(() => {
      expect(wrapper.find(awaitSelector).exists()).toBe(true);
    });
    await flushPromises();
  }
}

/** 打开某个 FDE 的「预览端口」tab（照 AdminPreviewPorts.spec 的既有流程）。 */
async function openPortsTab(wrapper: VueWrapper, login: string) {
  const row = wrapper.findAll('[data-test="user-row"]').find((item) => item.text().includes(login));
  if (!row) throw new Error(`${login} 行不存在`);
  await row.get('[data-test="edit-user"]').trigger('click');
  await flushPromises();
  const editor = wrapper.get('[data-test="user-edit-modal"]');
  await editor.get('[data-test="edit-tab-ports"]').trigger('click');
  await flushPromises();
  return editor;
}

function postCalls(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  return fetchMock.mock.calls.filter(
    ([url, init]) => String(url) === path && (init as RequestInit | undefined)?.method === 'POST',
  );
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

// ─────────────────────────────────────────────────────────────────────────────
describe('issue #350 判据①：懒挂载 —— 进管理台不请求，切到该 tab 恰好 1 次', () => {
  it('判据①：/admin/users 落地时号池占用 0 次请求；点「号池占用」tab 后恰好 1 次 GET /api/admin/preview-ports/usage', async () => {
    const { wrapper, fetchMock } = await mountAdmin((url) => (url.startsWith(PREVIEW_USAGE_PATH) ? jsonResponse(200, USAGE) : undefined));
    try {
      expect(usageCalls(fetchMock)).toHaveLength(0);
      expect(wrapper.find('[data-test="preview-pool-usage"]').exists()).toBe(false);

      await clickTab(wrapper, '号池占用', '[data-test="preview-pool-usage"]');
      expect(usageCalls(fetchMock)).toHaveLength(1);
      // 无 query（缺省 limit 由服务端定，前端不复制默认值）
      expect(String(usageCalls(fetchMock)[0]![0])).toBe(PREVIEW_USAGE_PATH);
      expect(wrapper.find('[data-test="preview-pool-usage"]').exists()).toBe(true);
    } finally {
      wrapper.unmount();
    }
  });

  it('判据①：每次进入该 tab 恰好 1 次（离开再回来 = 第 2 次，且不会重复叠发）', async () => {
    const { wrapper, fetchMock } = await mountAdmin((url) => (url.startsWith(PREVIEW_USAGE_PATH) ? jsonResponse(200, USAGE) : undefined));
    try {
      await clickTab(wrapper, '号池占用', '[data-test="preview-pool-usage"]');
      expect(usageCalls(fetchMock)).toHaveLength(1);
      await clickTab(wrapper, '用户管理', '[data-test="user-list"]');
      expect(usageCalls(fetchMock)).toHaveLength(1);
      await clickTab(wrapper, '号池占用', '[data-test="preview-pool-usage"]');
      expect(usageCalls(fetchMock)).toHaveLength(2);
    } finally {
      wrapper.unmount();
    }
  });

  it('判据①：深链直接进 /admin/preview-pool 也只发 1 次（挂载即唯一触发点）', async () => {
    const { wrapper, fetchMock } = await mountAdmin(
      (url) => (url.startsWith(PREVIEW_USAGE_PATH) ? jsonResponse(200, USAGE) : undefined),
      '/admin/preview-pool',
    );
    try {
      expect(usageCalls(fetchMock)).toHaveLength(1);
      expect(wrapper.find('[data-test="preview-pool-usage"]').exists()).toBe(true);
    } finally {
      wrapper.unmount();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('issue #350 判据②：前端零端口/号池字面量（源码级，按数值判）', () => {
  // 号池/端口的「形状」：≥ 每段端口数下限、≤ 端口上限的整数字面量都不该出现在新源码里。
  // 用数值区间而不是 `grep '22000'`：`22_000`、`0x55f0`、`2.2e4`、`800` 都要被抓到。
  const LITERAL_MIN = 800; // 总段数的最小可信量级（真机 800）；再小的数字是普通计数/下标
  const LITERAL_MAX = 65535; // TCP 端口上限：任何落在这里的整数字面量都可能是端口的手抄副本

  /** 从源码文本里抽出所有**数值字面量**（十进制/下划线/十六进制/二进制/八进制/科学计数），按数值判区间。 */
  function poolishLiterals(source: string): Array<{ text: string; value: number }> {
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    // 前面那个 `[^\w$.\-]` 是边界：`amber-900` / `grid-cols-4` 这类标识符尾巴上的数字不算字面量
    // （它们不是代码里的数）；`22_000`、`0x55f0`、`2.2e4` 照样抓得到。
    const pattern = /(^|[^\w$.\-])(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    const hits: Array<{ text: string; value: number }> = [];
    for (const match of withoutComments.matchAll(pattern)) {
      const text = match[2]!;
      const value = Number(text.replace(/_/g, ''));
      if (!Number.isFinite(value)) continue;
      if (value >= LITERAL_MIN && value <= LITERAL_MAX) hits.push({ text, value });
    }
    return hits;
  }

  it('判据②：扫描器自测——22_000 / 0x55f0 / 2.2e4 / 800 / 29999 都被抓到，普通小数字与 class 名不误报', () => {
    // 反证锚：这几种写法都必须红，否则「零字面量」那条是空断言。
    expect(poolishLiterals('const a = 22_000;').map((hit) => hit.value)).toEqual([22000]);
    expect(poolishLiterals('const a = 0x55f0;').map((hit) => hit.value)).toEqual([22000]);
    expect(poolishLiterals('const a = 2.2e4;').map((hit) => hit.value)).toEqual([22000]);
    expect(poolishLiterals('total: 800').map((hit) => hit.value)).toEqual([800]);
    expect(poolishLiterals('const end = 29999;').map((hit) => hit.value)).toEqual([29999]);
    expect(poolishLiterals('const n = 30000;').map((hit) => hit.value)).toEqual([30000]);
    // 不该误报的形状：0/1/10/50 这类普通计数、注释里的数字、Tailwind 颜色/类名尾巴上的数字
    expect(poolishLiterals('const limit = 50; const i = 0; const step = 1;')).toEqual([]);
    expect(poolishLiterals('// 号池 22000–29999 的说明\nconst ok = 1;')).toEqual([]);
    expect(poolishLiterals('<p class="text-amber-900 bg-amber-50">x</p>')).toEqual([]);
  });

  it('判据②：PreviewPoolUsageView.vue 与 lib/previewPoolUsage.ts 里没有端口/号池字面量（22_000/0x…/2.2e4 同罪）', () => {
    for (const [name, source] of [['views/PreviewPoolUsageView.vue', viewSource], ['lib/previewPoolUsage.ts', libSource]] as const) {
      expect(poolishLiterals(source), `${name} 里出现了端口/号池字面量`).toEqual([]);
    }
  });

  it('判据②：段边界/块大小/总段数全部来自响应 pool（换一套池子页面就换一套数）', async () => {
    const { wrapper } = await mountAdmin(
      (url) => (url.startsWith(PREVIEW_USAGE_PATH) ? jsonResponse(200, USAGE) : undefined),
      '/admin/preview-pool',
    );
    try {
      const poolText = wrapper.get('[data-test="usage-pool"]').text();
      expect(poolText).toContain('31000');
      expect(poolText).toContain('31999');
      expect(poolText).toContain('100'); // total_blocks 来自响应，不是写死的 800
      expect(wrapper.get('[data-test="summary-total"]').text()).toBe('100');
      // 空闲段末端由 pool.block_size 推导（响应只给起点 31010 → 31010–31019）
      expect(wrapper.get('[data-test="free-block"]').text()).toBe('31010–31019');
      // 反证：真机号池的数字一个都不许出现
      const html = wrapper.html();
      expect(html).not.toContain('22000');
      expect(html).not.toContain('29999');
      expect(html).not.toContain('>800<');
    } finally {
      wrapper.unmount();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('issue #350 判据③：不猜数（缺失/脏值不渲染成 0；「还没请求」≠「一个都没有」）', () => {
  it('判据③：还没请求时显示「尚未加载」，不显示「没有空闲段」/「0」', async () => {
    // 让请求永远挂着：加载态是「还没请求完」，页面不得据此断言「号池没有空闲段」。
    const { wrapper } = await mountAdmin(
      (url) => (url.startsWith(PREVIEW_USAGE_PATH) ? new Promise<Response>(() => {}) : undefined),
      '/admin/preview-pool',
    );
    try {
      expect(wrapper.find('[data-test="usage-loading"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="free-empty"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="usage-summary"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  it('判据③：summary 里缺失/脏值（缺 free、partial 是字符串、occupied 是 NaN）⇒ 显示「—」，绝不显示 0', async () => {
    const dirty = {
      pool: POOL,
      summary: { total_blocks: 100, partial: '2', occupied: Number.NaN },
      occupied_blocks: USAGE.occupied_blocks,
      free_blocks: USAGE.free_blocks,
    };
    const { wrapper } = await mountAdmin(
      (url) => (url.startsWith(PREVIEW_USAGE_PATH) ? jsonResponse(200, dirty) : undefined),
      '/admin/preview-pool',
    );
    try {
      expect(wrapper.get('[data-test="summary-free"]').text()).toBe('—');
      expect(wrapper.get('[data-test="summary-partial"]').text()).toBe('—');
      expect(wrapper.get('[data-test="summary-occupied"]').text()).toBe('—');
      expect(wrapper.get('[data-test="summary-total"]').text()).toBe('100');
      for (const test of ['summary-free', 'summary-partial', 'summary-occupied']) {
        expect(wrapper.get(`[data-test="${test}"]`).text()).not.toBe('0');
      }
      // partial 未知 ⇒ 不弹「部分占用」警报（不猜成 0，也不猜成有）
      expect(wrapper.find('[data-test="usage-partial"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  it('判据③：free_blocks 整段缺失 ⇒ 说「服务端没给这一段」，而不是「没有空闲段」', async () => {
    const missing = { pool: POOL, summary: USAGE.summary, occupied_blocks: USAGE.occupied_blocks };
    const { wrapper } = await mountAdmin(
      (url) => (url.startsWith(PREVIEW_USAGE_PATH) ? jsonResponse(200, missing) : undefined),
      '/admin/preview-pool',
    );
    try {
      expect(wrapper.find('[data-test="free-missing"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="free-empty"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="free-block"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  it('判据③：free_blocks.items 真的为空（服务端明说）⇒ 才显示「没有整段空闲的段」', async () => {
    const emptyFree = {
      ...USAGE,
      summary: { total_blocks: 100, free: 0, partial: 3, occupied: 1 },
      free_blocks: { items: [], limit: 3, has_more: false },
    };
    const { wrapper } = await mountAdmin(
      (url) => (url.startsWith(PREVIEW_USAGE_PATH) ? jsonResponse(200, emptyFree) : undefined),
      '/admin/preview-pool',
    );
    try {
      expect(wrapper.get('[data-test="free-empty"]').text()).toContain('没有整段空闲的段');
      expect(wrapper.find('[data-test="free-missing"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="free-more"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  it('判据③：has_more=true ⇒ 明说「只显示前 N 段，还有更多」并把 limit 显示出来', async () => {
    const { wrapper } = await mountAdmin(
      (url) => (url.startsWith(PREVIEW_USAGE_PATH) ? jsonResponse(200, USAGE) : undefined),
      '/admin/preview-pool',
    );
    try {
      const more = wrapper.get('[data-test="free-more"]').text();
      expect(more).toContain('只显示前 3 段');
      expect(more).toContain('还有更多');
      expect(more).toContain('limit=3'); // 服务端给的 limit 原样显示
      expect(more).toContain('别以为号池只剩这些');
    } finally {
      wrapper.unmount();
    }
  });

  it('判据③：pool 缺失 ⇒ 说「服务端没给号池边界」，不推断段边界（也不显示 0 段）', async () => {
    const noPool = { summary: USAGE.summary, occupied_blocks: USAGE.occupied_blocks, free_blocks: USAGE.free_blocks };
    const { wrapper } = await mountAdmin(
      (url) => (url.startsWith(PREVIEW_USAGE_PATH) ? jsonResponse(200, noPool) : undefined),
      '/admin/preview-pool',
    );
    try {
      expect(wrapper.get('[data-test="usage-pool"]').text()).toContain('没有给出号池边界');
      // 块大小未知 ⇒ 空闲段只给起点，不编造末端
      expect(wrapper.get('[data-test="free-block"]').text()).toBe('31010');
    } finally {
      wrapper.unmount();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('issue #350 判据⑤：partial > 0 独立呈现（不并进 free/occupied）', () => {
  it('判据⑤：partial=2 时出现独立警报块，文案说清「同段被多个 FDE 部分占用，选段时要避开」', async () => {
    const { wrapper } = await mountAdmin(
      (url) => (url.startsWith(PREVIEW_USAGE_PATH) ? jsonResponse(200, USAGE) : undefined),
      '/admin/preview-pool',
    );
    try {
      const partial = wrapper.get('[data-test="usage-partial"]');
      expect(partial.attributes('role')).toBe('alert');
      expect(partial.text()).toContain('2 个段被「部分占用」');
      expect(partial.text()).toContain('选段时要避开');
      expect(partial.text()).toContain('不是空闲段');
      // 部分占用的段（31020 / 31050）不得出现在空闲列表里
      const freeText = wrapper.get('[data-test="usage-free"]').text();
      expect(freeText).not.toContain('31020');
      expect(freeText).not.toContain('31050');
      // 也不许被并进「整段占满」那一栏：summary-occupied 只报 1
      expect(wrapper.get('[data-test="summary-occupied"]').text()).toBe('1');
    } finally {
      wrapper.unmount();
    }
  });

  it('判据⑤：partial=0 时不出现该警报块（不占屏、也不假装有）', async () => {
    const noPartial = {
      ...USAGE,
      summary: { total_blocks: 100, free: 99, partial: 0, occupied: 1 },
      occupied_blocks: [USAGE.occupied_blocks[0]!],
    };
    const { wrapper } = await mountAdmin(
      (url) => (url.startsWith(PREVIEW_USAGE_PATH) ? jsonResponse(200, noPartial) : undefined),
      '/admin/preview-pool',
    );
    try {
      expect(wrapper.find('[data-test="usage-partial"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('issue #350 判据⑥：错误面可见（.syserr 一行 + 服务端 message 原文）', () => {
  it('判据⑥：403 时给出 .syserr 错误行，含本地化前缀「错误：」与服务端 message 原文（不翻译）', async () => {
    const serverMessage = 'forbidden: admin role required';
    const { wrapper } = await mountAdmin(
      (url) => (url.startsWith(PREVIEW_USAGE_PATH)
        ? jsonResponse(403, { error: { code: 'forbidden', message: serverMessage } })
        : undefined),
      '/admin/preview-pool',
    );
    try {
      const error = wrapper.get('[data-test="usage-error"]');
      expect(error.classes()).toContain('syserr');
      expect(error.attributes('role')).toBe('alert');
      expect(error.text()).toBe(`错误：${serverMessage}`);
      // 失败时不许把「没数据」画成「全池空闲」
      expect(wrapper.find('[data-test="usage-summary"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="free-empty"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('issue #350 自洽关系（§4.7a 三条）：对不上就明说，不照画', () => {
  it('自洽夹具不报矛盾；total ≠ free+partial+occupied 时报 usage-inconsistent 并点名', async () => {
    const ok = await mountAdmin(
      (url) => (url.startsWith(PREVIEW_USAGE_PATH) ? jsonResponse(200, USAGE) : undefined),
      '/admin/preview-pool',
    );
    try {
      expect(ok.wrapper.find('[data-test="usage-inconsistent"]').exists()).toBe(false);
    } finally {
      ok.wrapper.unmount();
    }

    const broken = {
      ...USAGE,
      summary: { total_blocks: 100, free: 90, partial: 2, occupied: 1 }, // 90+2+1 ≠ 100
    };
    const bad = await mountAdmin(
      (url) => (url.startsWith(PREVIEW_USAGE_PATH) ? jsonResponse(200, broken) : undefined),
      '/admin/preview-pool',
    );
    try {
      const line = bad.wrapper.get('[data-test="usage-inconsistent"]').text();
      expect(line).toContain('自相矛盾');
      expect(line).toContain('总段数 ≠ 空闲 + 部分占用 + 整段占满');
      // 原文数字照显示（不偷偷修正），只是加警告
      expect(bad.wrapper.get('[data-test="summary-free"]').text()).toBe('90');
    } finally {
      bad.wrapper.unmount();
    }
  });

  it('lib 级：三条关系逐条可判（total / occupiedList=partial+occupied / freeList / hasMore）', () => {
    const usage = normalizeUsage(USAGE);
    expect(usageConsistencyIssues(usage)).toEqual([]);
    expect(usageConsistencyIssues(normalizeUsage({
      ...USAGE, summary: { ...USAGE.summary, free: 96 },
    }))).toEqual(['total']);
    // occupied_blocks 列的是「全部被占段」⇒ 它必须等于 partial + occupied（不是 ≤ occupied）
    expect(usageConsistencyIssues(normalizeUsage({
      ...USAGE, summary: { ...USAGE.summary, partial: 1, occupied: 1, free: 98 },
    }))).toEqual(['occupiedList']);
    expect(usageConsistencyIssues(normalizeUsage({
      ...USAGE,
      summary: { ...USAGE.summary, free: 2 },
      free_blocks: { items: [31010, 31030, 31040], limit: 3, has_more: false },
    }))).toEqual(['total', 'freeList']);
    expect(usageConsistencyIssues(normalizeUsage({
      ...USAGE, free_blocks: { items: [31010, 31030, 31040], limit: 3, has_more: true },
    }))).toEqual([]);
    expect(usageConsistencyIssues(normalizeUsage({
      ...USAGE,
      summary: { ...USAGE.summary, free: 3 },
      free_blocks: { items: [31010, 31030, 31040], limit: 3, has_more: true },
    }))).toContain('hasMore');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('issue #350 判据④：与改块流程接上（引用式 + 只读提示，红线：绝不自动改值/自动提交）', () => {
  const BLOCK_PATH = '/api/admin/fdes/alpha-fde/ports/block';

  it('判据④：改块区给出「打开号池占用总览」入口（不新增 data-test 冲突、不动既有确认流程）', async () => {
    const { wrapper } = await mountAdmin();
    try {
      await openPortsTab(wrapper, 'alice');
      const link = wrapper.get('[data-test="open-preview-pool-usage"]');
      expect(link.attributes('href') ?? '').toContain('preview-pool');
      // 既有 data-test 全在（没被改动）
      expect(wrapper.find('[data-test="block-start-input"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="open-block-move"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="fde-ports-pane"]').exists()).toBe(true);
    } finally {
      wrapper.unmount();
    }
  });

  it('判据④：看过总览后，改块输入框下方显示「这一段被谁占 / 整段空闲 / 不知道」', async () => {
    const { wrapper, pinia } = await mountAdmin(
      (url) => (url.startsWith(PREVIEW_USAGE_PATH) ? jsonResponse(200, USAGE) : undefined),
      '/admin/preview-pool',
    );
    try {
      // 先真的看一次总览（缓存进 admin store），再回用户页开改块面板
      await flushPromises();
      expect(useAdminStore(pinia).previewUsageLoaded).toBe(true);
      await clickTab(wrapper, '用户管理', '[data-test="user-list"]');
      await openPortsTab(wrapper, 'alice');

      const input = wrapper.get('[data-test="block-start-input"]');
      // 被占的段：点名占用者
      await input.setValue('31020');
      await flushPromises();
      const occupiedHint = wrapper.get('[data-test="block-occupancy-hint"]').text();
      expect(occupiedHint).toContain('被占用');
      expect(occupiedHint).toContain('bob, dana');
      expect(occupiedHint).toContain('3 个活行');
      expect(occupiedHint).toContain('409');

      // 空闲段
      await input.setValue('31030');
      await flushPromises();
      expect(wrapper.get('[data-test="block-occupancy-hint"]').text()).toContain('整段空闲');

      // 不在空闲列表里的段：说「不知道」，不猜成空闲（列表是截断的）
      await input.setValue('31100');
      await flushPromises();
      const unknownHint = wrapper.get('[data-test="block-occupancy-hint"]').text();
      expect(unknownHint).toContain('不知道');
      expect(unknownHint).not.toContain('整段空闲');
    } finally {
      wrapper.unmount();
    }
  });

  it('判据④红线：看到空闲段**绝不**自动改写 block_start_input 的值，也绝不自动提交（零 POST）', async () => {
    const { wrapper, fetchMock } = await mountAdmin(
      (url) => {
        if (url.startsWith(PREVIEW_USAGE_PATH)) return jsonResponse(200, USAGE);
        if (url === BLOCK_PATH) return jsonResponse(200, { changed: false });
        return undefined;
      },
      '/admin/preview-pool',
    );
    try {
      await clickTab(wrapper, '用户管理', '[data-test="user-list"]');
      await openPortsTab(wrapper, 'alice');
      const input = wrapper.get('[data-test="block-start-input"]');
      expect((input.element as HTMLInputElement).value).toBe('');

      // ① 只是打开面板 / 看过总览：输入框必须还是空的（没有「帮你填上第一个空闲段」）
      expect((input.element as HTMLInputElement).value).toBe('');

      // ② 填一个被占的段：提示说被占，但**值不被改**、也不发 POST
      await input.setValue('31020');
      await flushPromises();
      expect((input.element as HTMLInputElement).value).toBe('31020');
      expect(postCalls(fetchMock, BLOCK_PATH)).toHaveLength(0);

      // ③ 填一个空闲段：同样只提示，不改值、不提交（管理员显式指定的段才算数）
      await input.setValue('31030');
      await flushPromises();
      expect((input.element as HTMLInputElement).value).toBe('31030');
      expect(postCalls(fetchMock, BLOCK_PATH)).toHaveLength(0);
      // 确认条仍要显式点「改块…」才出现，且出现时仍未 POST（既有流程没被绕过）
      expect(wrapper.find('[data-test="block-move-confirm"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('issue #350 lib 纯函数（归一化 / 段标签 / 块归属 / 错误面）', () => {
  it('previewUsagePath：缺省不带 query；正整数才拼 limit；脏值按不指定处理', () => {
    expect(previewUsagePath()).toBe('/api/admin/preview-ports/usage');
    expect(previewUsagePath(null)).toBe('/api/admin/preview-ports/usage');
    expect(previewUsagePath(3)).toBe('/api/admin/preview-ports/usage?limit=3');
    expect(previewUsagePath(0)).toBe('/api/admin/preview-ports/usage');
    expect(previewUsagePath(-1)).toBe('/api/admin/preview-ports/usage');
    expect(previewUsagePath(1.5)).toBe('/api/admin/preview-ports/usage');
  });

  it('normalizeUsage：字符串数字/NaN/缺字段一律 null（不 Number() 硬转、不当 0）', () => {
    const usage = normalizeUsage({
      pool: { start: '31000', end: 31999, block_size: 10, total_blocks: 100 },
      summary: { total_blocks: 100, free: '97', partial: null },
      occupied_blocks: [{ start: 31000, fde_names: ['eric', '', 42] }, { end: 1 }, 'junk'],
      free_blocks: { items: [31010, '31030', null], limit: '3', has_more: 'yes' },
    });
    expect(usage.pool).toBeNull(); // start 是字符串 ⇒ 整段不可信
    expect(usage.summary).toEqual({ totalBlocks: 100, free: null, partial: null, occupied: null });
    expect(usage.occupiedBlocks).toEqual([{ start: 31000, end: null, occupiedCount: null, fdeNames: ['eric'] }]);
    expect(usage.freeBlocks).toEqual({ items: [31010], limit: null, hasMore: null });
    expect(usage.occupiedPresent).toBe(true);
    expect(usage.freePresent).toBe(true);
  });

  it('normalizeUsage：整份响应不是对象也不炸，且 Present 旗标说「没给」', () => {
    for (const raw of [null, undefined, 'oops', 42, []]) {
      const usage = normalizeUsage(raw);
      expect(usage.pool).toBeNull();
      expect(usage.occupiedPresent).toBe(false);
      expect(usage.freePresent).toBe(false);
      expect(usage.freeBlocks).toEqual({ items: [], limit: null, hasMore: null });
    }
  });

  it('blockEnd/formatBlockLabel：末端由 block_size 推导；块大小未知就不编末端', () => {
    expect(blockEnd(31010, 10)).toBe(31019);
    expect(blockEnd(31010, null)).toBeNull();
    expect(blockEnd(31010, 0)).toBeNull();
    expect(formatBlockLabel(31010, 31019)).toBe('31010–31019');
    expect(formatBlockLabel(31010, null)).toBe('31010');
  });

  it('classifyBlock：占用的段点名 FDE；只有真在空闲列表里才算 free；其余一律 unknown', () => {
    const usage = normalizeUsage(USAGE);
    expect(classifyBlock(usage, 31000)).toEqual({ kind: 'occupied', fdeNames: ['eric'], occupiedCount: 10 });
    expect(classifyBlock(usage, 31030)).toEqual({ kind: 'free', fdeNames: [], occupiedCount: null });
    // 31100 既不在 occupied_blocks 也不在（截断的）空闲列表里 ⇒ 不知道，不许说「空闲」
    expect(classifyBlock(usage, 31100).kind).toBe('unknown');
    expect(classifyBlock(null, 31000).kind).toBe('unknown');
    expect(classifyBlock(usage, null).kind).toBe('unknown');
  });

  it('usageErrorText：ApiError 取 code+message 原文；非 Error 也不炸', () => {
    const error = Object.assign(new Error('forbidden: admin role required'), { status: 403, code: 'forbidden' });
    expect(usageErrorText(error)).toEqual({ code: 'forbidden', message: 'forbidden: admin role required' });
    expect(usageErrorText(new Error('boom'))).toEqual({ code: 'unknown', message: 'boom' });
    expect(usageErrorText('plain')).toEqual({ code: 'unknown', message: 'plain' });
  });
});
