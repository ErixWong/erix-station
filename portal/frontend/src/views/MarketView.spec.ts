// 能力市场用户面单测（issue #595 M1，`MarketView.vue`；契约 §7 用户面 + §8 工作台）。
//
// 装配照 `AdminMacrosView.spec.ts`：直接挂视图 + 真实 i18n 单例 + 按 URL/方法分派的 fetch 桩。
// 红线（工单 §10）：**不用 `w.emitted()`**——本页不 emit 任何东西，全部判据走 DOM 与请求桩。
//
// 用例编号就是交付报告里引用的编号：
//   ① 列表渲染：name/summary/tags/工具数/安全分/已装态，缺键显示「—」而不是 0
//   ② 中性口径：已装未启用是**中性灰字**（class 里不许出现 red/amber/yellow/warn/danger）
//   ③ 安装：POST `…/install` + 成功后重读列表 + 卡片变「已安装 · 已启用」
//   ④ 预算超额：409 `capability_budget_exceeded` ⇒ 文案点名「单个 FDE」「12」，且**不**假装装好了
//   ⑤ 启停：POST `…/enabled` 的请求体是 `{enabled:false}`（布尔，不是字符串）
//   ⑥ 卸载：POST `…/uninstall` + 卡片退回未安装
//   ⑦ 详情：GET `…/items/<slug>` ⇒ when_to_use / SKILL.md 正文 / 工具与参数
//   ⑧ `kind='mcp'`（§9）：没有安装按钮，只有「P0 不消费 MCP」
//   ⑨ 返回工作台的链接存在（`#/`）
//   ⑩ 双语成对：`market.*` 的叶子键两边一致（zh 真中文、en 真英文）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createRouter, createWebHashHistory } from 'vue-router';
import MarketView from './MarketView.vue';
import { i18n, setLocale } from '../i18n';
import { zhCN } from '../i18n/locales/zh-CN';
import { en } from '../i18n/locales/en';
import {
  MARKET_ITEMS_PATH,
  marketUserItemPath,
  MAX_ENABLED_SKILLS,
} from '../lib/market';

interface Recorded { url: string; method: string; body: unknown }
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
    const call: Recorded = { url, method, body: raw === null ? null : JSON.parse(raw) };
    calls.push(call);
    const response = handler(call);
    if (!response) throw new Error(`fetch 桩没有处理 ${method} ${url}`);
    return response;
  }));
  return calls;
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────

/** 一个「装了但没启用」的条目：§8 的中性灰字判据就靠它。 */
function disabledItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'pdf-tools', kind: 'skill', name: 'PDF 工具', summary: '抽取 PDF 文本与表格',
    version: '1.2.0', tags: ['pdf', 'docs'], tool_count: 3, security_score: 90,
    installed: true, enabled: false, installed_version: '1.2.0',
    ...over,
  };
}

/** 一个什么都没装过的条目；`{}` 可以把它变成「没给数字」的形状（缺键判据）。 */
function freshItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'github', kind: 'skill', name: 'GitHub', summary: '查 PR / issue / 提交',
    version: '0.4.1', tags: ['git'], tool_count: 5, security_score: 100,
    installed: false, enabled: false,
    ...over,
  };
}

function listResponse(items: unknown[], status = 200): Response {
  return json(status, { items });
}

async function mountWith(handler: Handler): Promise<{ wrapper: VueWrapper; calls: Recorded[] }> {
  const calls = stubFetch(handler);
  const wrapper = mount(MarketView, { global: { plugins: [i18n, makeRouter()] } });
  await flushPromises();
  return { wrapper, calls };
}

/**
 * 本页只用了两个东西：`<router-link :to="{name:'workbench'}">` 与路由表里的 `market` 名字。
 * ⚠ 这里用 **hash 历史**（= 应用真实的历史模式）：拿 memory 历史的话 `href` 会是 `/`，
 *   「返回工作台指向 `#/`」那条判据就假红了（hash 模式才是 portal 的事实，见 router.ts 顶部）。
 */
function makeRouter() {
  return createRouter({
    history: createWebHashHistory(),
    routes: [
      { path: '/', name: 'workbench', component: { template: '<div />' } },
      { path: '/market', name: 'market', component: MarketView },
    ],
  });
}

/** 列表 + 动作的分派桩：动作回 `onAction`，随后组件会重读列表（回 `items`）。 */
function actionStub(
  items: unknown[],
  onAction: (call: Recorded) => Response | undefined,
): Handler {
  return (call) => {
    if (call.method === 'GET' && call.url === MARKET_ITEMS_PATH) return listResponse(items);
    return onAction(call);
  };
}

const text = (w: VueWrapper, testId: string): string => w.get(`[data-test="${testId}"]`).text();
const exists = (w: VueWrapper, testId: string): boolean => w.find(`[data-test="${testId}"]`).exists();
const posts = (calls: Recorded[], suffix: string): Recorded[] =>
  calls.filter((c) => c.method === 'POST' && c.url.endsWith(suffix));

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('① 列表渲染', () => {
  it('打开恰好一次 GET；卡片渲染 name/summary/tags/工具数/安全分/已装态', async () => {
    const { wrapper, calls } = await mountWith((c) =>
      (c.url === MARKET_ITEMS_PATH ? listResponse([disabledItem(), freshItem()]) : undefined));
    expect(calls.filter((c) => c.url === MARKET_ITEMS_PATH && c.method === 'GET')).toHaveLength(1);

    expect(text(wrapper, 'market-card-pdf-tools')).toContain('PDF 工具');
    expect(text(wrapper, 'market-card-pdf-tools')).toContain('抽取 PDF 文本与表格');
    expect(text(wrapper, 'market-card-pdf-tools')).toContain('pdf'); // tag
    expect(text(wrapper, 'market-tools-pdf-tools')).toContain('3');
    expect(text(wrapper, 'market-score-pdf-tools')).toContain('90');
    expect(text(wrapper, 'market-state-pdf-tools')).toContain('已安装');
    expect(text(wrapper, 'market-state-github')).toContain('未安装');
  });

  it('缺键 ⇒ 「—」，不是 0（工具数 / 安全分 / 安装数同一条纪律）', async () => {
    const bare = { slug: 'bare', name: '裸条目', summary: '服务端没给数字', version: '1' };
    const { wrapper } = await mountWith((c) => (c.url === MARKET_ITEMS_PATH ? listResponse([bare]) : undefined));
    expect(text(wrapper, 'market-tools-bare')).toBe('工具：—');
    expect(text(wrapper, 'market-score-bare')).toBe('安全分：—');
    // 没有数字也**没有**出现 "0"
    expect(text(wrapper, 'market-card-bare')).not.toMatch(/：0/);
  });

  it('空目录给空态文案（不是空白页）', async () => {
    const { wrapper } = await mountWith((c) => (c.url === MARKET_ITEMS_PATH ? listResponse([]) : undefined));
    expect(exists(wrapper, 'market-empty')).toBe(true);
  });

  it('列表读失败 ⇒ 可见错误行（失败不伪装成空态）', async () => {
    const { wrapper } = await mountWith((c) =>
      (c.url === MARKET_ITEMS_PATH ? fail(500, 'internal', 'db down') : undefined));
    expect(exists(wrapper, 'market-load-error')).toBe(true);
    expect(exists(wrapper, 'market-empty')).toBe(false);
  });
});

describe('② 中性口径（§8：已装未启用不用告警色）', () => {
  it('已装未启用 ⇒ 中性灰字 class，不含 red/amber/yellow/warn/danger', async () => {
    const { wrapper } = await mountWith((c) => (c.url === MARKET_ITEMS_PATH
      ? listResponse([disabledItem()])
      : undefined));
    const el = wrapper.get('[data-test="market-state-pdf-tools"]');
    expect(el.text()).toBe('已安装 · 未启用');
    expect(el.classes().join(' ')).toContain('text-black/45');
    expect(el.classes().join(' ').toLowerCase()).not.toMatch(/red|amber|yellow|warn|danger|emerald/);
  });

  it('整页不引入红黄绿灯语汇（错误行以外的可见状态）', async () => {
    const { wrapper } = await mountWith((c) => (c.url === MARKET_ITEMS_PATH
      ? listResponse([disabledItem(), freshItem()])
      : undefined));
    for (const state of ['pdf-tools', 'github']) {
      expect(wrapper.get(`[data-test="market-state-${state}"]`).text()).not.toMatch(/警告|告警|异常/);
    }
  });
});

describe('③ 安装', () => {
  it('点「安装」⇒ POST `…/install`，成功后重读列表并显示成功文案', async () => {
    let installed = false;
    const { wrapper, calls } = await mountWith(actionStub([freshItem()], () => {
      installed = true;
      return json(200, { installed: true, enabled: true, version: '0.4.1' });
    }));
    // 第一次列表里 github 未安装
    expect(text(wrapper, 'market-state-github')).toContain('未安装');
    await wrapper.get('[data-test="market-install-github"]').trigger('click');
    await flushPromises();

    expect(installed).toBe(true);
    const hit = posts(calls, '/install');
    expect(hit).toHaveLength(1);
    expect(hit[0].url).toBe(`${marketUserItemPath('github')}/install`);
    // 动作之后必然重读列表（屏上显示的是服务端事实）
    expect(calls.filter((c) => c.url === MARKET_ITEMS_PATH && c.method === 'GET')).toHaveLength(2);
    expect(text(wrapper, 'market-result')).toContain('已安装');
  });

  it('已装条目的按钮写「重新安装」（§4 漂移：手改过文件要能盖回去）', async () => {
    const { wrapper } = await mountWith((c) => (c.url === MARKET_ITEMS_PATH
      ? listResponse([disabledItem()])
      : undefined));
    expect(wrapper.get('[data-test="market-install-pdf-tools"]').text()).toBe('重新安装');
    // 漂移提示：已装版本 ≠ 市场版本时点名两个版本号
    const drift = await mountWith((c) => (c.url === MARKET_ITEMS_PATH
      ? listResponse([disabledItem({ installed_version: '1.1.0' })])
      : undefined));
    expect(drift.wrapper.get('[data-test="market-drift-pdf-tools"]').text()).toContain('1.1.0');
    expect(drift.wrapper.get('[data-test="market-drift-pdf-tools"]').text()).toContain('1.2.0');
  });
});

describe('④ 预算超额（§4 的 policy 闸）', () => {
  it('启用第 13 个 ⇒ 409 capability_budget_exceeded ⇒ 文案说清「单个 FDE 最多同时启用 12 个」', async () => {
    const { wrapper } = await mountWith(actionStub([disabledItem()], () =>
      fail(409, 'capability_budget_exceeded', 'enabled skills exceed budget')));
    await wrapper.get('[data-test="market-toggle-pdf-tools"]').trigger('click');
    await flushPromises();

    const line = text(wrapper, 'market-error');
    expect(line).toContain('FDE');
    expect(line).toContain(String(MAX_ENABLED_SKILLS));
    expect(line).toContain('上限');
    // 拒绝的可见形态：状态行仍是「未启用」，成功行不出现
    expect(text(wrapper, 'market-state-pdf-tools')).toContain('未启用');
    expect(exists(wrapper, 'market-result')).toBe(false);
  });

  it('服务端在 details 里给了别的数字 ⇒ 用服务端的数字，不用前端常量', async () => {
    const { wrapper } = await mountWith(actionStub([disabledItem()], () =>
      fail(409, 'capability_budget_exceeded', 'over budget', { max: 8 })));
    await wrapper.get('[data-test="market-toggle-pdf-tools"]').trigger('click');
    await flushPromises();
    expect(text(wrapper, 'market-error')).toContain('8');
  });

  it('其它码各有各的文案（未知码兜住服务端原文）', async () => {
    const cases: Array<[string, number, string, RegExp]> = [
      ['capability_not_found', 404, 'gone', /不在市场里/],
      ['capability_not_published', 409, 'draft', /不是已发布态/],
      ['capability_kind_unsupported', 409, 'mcp', /MCP/],
    ];
    for (const [code, status, message, expected] of cases) {
      const { wrapper } = await mountWith(actionStub([freshItem()], () =>
        fail(status, code, message)));
      await wrapper.get('[data-test="market-install-github"]').trigger('click');
      await flushPromises();
      expect(text(wrapper, 'market-error'), code).toMatch(expected);
    }
    const bad = await mountWith(actionStub([freshItem()], () =>
      fail(500, 'capability_install_failed', 'EACCES', { reason: 'EACCES: permission denied' })));
    await bad.wrapper.get('[data-test="market-install-github"]').trigger('click');
    await flushPromises();
    expect(text(bad.wrapper, 'market-error')).toContain('EACCES: permission denied');
  });
});

describe('⑤ 启停（不删文件）', () => {
  it('点「禁用」⇒ POST `…/enabled`，body 是 {enabled:false}', async () => {
    const { wrapper, calls } = await mountWith(actionStub([disabledItem({ enabled: true })], () =>
      json(200, { installed: true, enabled: false })));
    await wrapper.get('[data-test="market-toggle-pdf-tools"]').trigger('click');
    await flushPromises();

    const hit = posts(calls, '/enabled');
    expect(hit).toHaveLength(1);
    expect(hit[0].url).toBe(`${marketUserItemPath('pdf-tools')}/enabled`);
    expect(hit[0].body).toEqual({ enabled: false }); // 布尔，不是字符串 "false"
    expect(text(wrapper, 'market-result')).toContain('已停用');
  });

  it('已装的启用条目给「禁用」按钮；未装的不给启停/卸载', async () => {
    const { wrapper } = await mountWith((c) => (c.url === MARKET_ITEMS_PATH
      ? listResponse([disabledItem({ enabled: true }), freshItem()])
      : undefined));
    expect(wrapper.get('[data-test="market-toggle-pdf-tools"]').text()).toBe('禁用');
    expect(exists(wrapper, 'market-toggle-github')).toBe(false);
    expect(exists(wrapper, 'market-uninstall-github')).toBe(false);
  });
});

describe('⑥ 卸载', () => {
  it('点「卸载」⇒ POST `…/uninstall`，重读后卡片退回未安装', async () => {
    let listReads = 0;
    const { wrapper, calls } = await mountWith((call) => {
      if (call.method === 'GET' && call.url === MARKET_ITEMS_PATH) {
        listReads += 1;
        // 首读 = 已装；卸载后的重读 = 未装（屏上永远是服务端事实）。
        return listResponse(listReads === 1
          ? [disabledItem()]
          : [disabledItem({ installed: false, enabled: false, installed_version: null })]);
      }
      return json(200, { installed: false });
    });
    await wrapper.get('[data-test="market-uninstall-pdf-tools"]').trigger('click');
    await flushPromises();

    expect(posts(calls, '/uninstall')[0].url).toBe(`${marketUserItemPath('pdf-tools')}/uninstall`);
    expect(text(wrapper, 'market-state-pdf-tools')).toContain('未安装');
    expect(text(wrapper, 'market-result')).toContain('已卸载');
  });
});

describe('⑦ 详情', () => {
  it('点「详情」⇒ GET `…/items/<slug>`，渲染 when_to_use / SKILL.md 正文 / 工具与参数', async () => {
    const detail = {
      slug: 'pdf-tools', name: 'PDF 工具', version: '1.2.0',
      when_to_use: '读、转、检查 PDF 时',
      readme_md: '## 用法\n\n先跑 `pdf_extract`。',
      tools: [{ name: 'pdf_extract', description: '抽出文本', parameters: [{ name: 'path', type: 'string', required: true }] }],
      files: [{ path: 'skill.mjs', bytes: 2048 }, { path: 'SKILL.md', bytes: 512 }],
      security_score: 90,
    };
    const { wrapper, calls } = await mountWith((call) => {
      if (call.method === 'GET' && call.url === marketUserItemPath('pdf-tools')) return json(200, detail);
      if (call.method === 'GET' && call.url === MARKET_ITEMS_PATH) return listResponse([disabledItem()]);
      return undefined;
    });
    await wrapper.get('[data-test="market-detail-pdf-tools"]').trigger('click');
    await flushPromises();

    expect(calls.filter((c) => c.url === marketUserItemPath('pdf-tools'))).toHaveLength(1);
    expect(text(wrapper, 'market-detail-when')).toContain('读、转、检查 PDF 时');
    expect(text(wrapper, 'market-detail-readme')).toContain('先跑');
    expect(text(wrapper, 'market-tool-pdf_extract')).toContain('pdf_extract');
    expect(text(wrapper, 'market-tool-params-pdf_extract')).toContain('path');
    expect(text(wrapper, 'market-detail-files')).toContain('skill.mjs');
  });

  it('服务端没给 SKILL.md ⇒ 明说「没附带」，不拿 description_md 冒充', async () => {
    const { wrapper } = await mountWith((call) => {
      if (call.method === 'GET' && call.url === marketUserItemPath('pdf-tools')) {
        return json(200, { slug: 'pdf-tools', name: 'PDF 工具', description_md: '详情页正文' });
      }
      if (call.method === 'GET' && call.url === MARKET_ITEMS_PATH) return listResponse([disabledItem()]);
      return undefined;
    });
    await wrapper.get('[data-test="market-detail-pdf-tools"]').trigger('click');
    await flushPromises();
    expect(text(wrapper, 'market-detail-readme')).toContain('没附带 SKILL.md');
    expect(text(wrapper, 'market-detail-readme')).not.toContain('详情页正文');
  });

  it('详情读失败 ⇒ 可见错误行（不静默留空面板）', async () => {
    const { wrapper } = await mountWith((call) => {
      if (call.method === 'GET' && call.url === marketUserItemPath('pdf-tools')) {
        return fail(404, 'capability_not_found', 'gone');
      }
      return listResponse([disabledItem()]);
    });
    await wrapper.get('[data-test="market-detail-pdf-tools"]').trigger('click');
    await flushPromises();
    expect(exists(wrapper, 'market-detail-error')).toBe(true);
  });
});

describe('⑧ MCP 条目（§9：P0 不做消费者）', () => {
  it('kind=mcp ⇒ 标出「MCP 条目」，没有安装按钮', async () => {
    const { wrapper } = await mountWith((c) => (c.url === MARKET_ITEMS_PATH
      ? listResponse([freshItem({ slug: 'mcp-thing', kind: 'mcp' })])
      : undefined));
    expect(exists(wrapper, 'market-kind-mcp')).toBe(true);
    expect(exists(wrapper, 'market-install-mcp-thing')).toBe(false);
  });
});

describe('⑨ 返回工作台', () => {
  it('页面顶部有「← 返回工作台」，指向 #/', async () => {
    const { wrapper } = await mountWith((c) => (c.url === MARKET_ITEMS_PATH ? listResponse([]) : undefined));
    const back = wrapper.get('[data-test="market-back"]');
    expect(back.text()).toContain('返回工作台');
    expect(back.attributes('href')).toBe('#/');
  });
});

describe('⑩ 双语成对（market.*）', () => {
  function leaves(value: unknown, prefix = ''): string[] {
    if (value !== null && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>)
        .flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key));
    }
    return [prefix];
  }

  it('zh 与 en 的 market.* 叶子键集合完全一致，且各自是真语言', () => {
    const zh = leaves(zhCN.market, 'market').sort();
    const enLeaves = leaves(en.market, 'market').sort();
    expect(zh.length).toBeGreaterThan(30);
    expect(enLeaves).toEqual(zh);
    for (const key of zh) {
      const zhValue = key.split('.').reduce<unknown>(
        (node, segment) => (node as Record<string, unknown>)[segment], zhCN,
      ) as string;
      const enValue = key.split('.').reduce<unknown>(
        (node, segment) => (node as Record<string, unknown>)[segment], en,
      ) as string;
      expect(zhValue, key).toMatch(/[\u4e00-\u9fff]/);
      expect(enValue, key).not.toMatch(/[\u4e00-\u9fff]/);
      expect(enValue, key).not.toBe(zhValue);
    }
  });

  it('预算文案两边都点名 FDE 与上限（不许漏掉数字）', () => {
    expect(zhCN.market.errors.budgetExceeded).toContain('{max}');
    expect(en.market.errors.budgetExceeded).toContain('{max}');
    expect(zhCN.market.budgetHint).toContain('{max}');
    expect(en.market.budgetHint).toContain('{max}');
  });

  it('切到 English 后列表文案即时变英文', async () => {
    setLocale('en');
    const { wrapper } = await mountWith((c) => (c.url === MARKET_ITEMS_PATH
      ? listResponse([freshItem()])
      : undefined));
    expect(wrapper.get('[data-test="market-state-github"]').text()).toBe('Not installed');
    expect(wrapper.get('[data-test="market-install-github"]').text()).toBe('Install');
  });
});
