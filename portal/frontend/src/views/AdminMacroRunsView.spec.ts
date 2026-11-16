// AdminMacroRunsView 单测（issue #529，事件平台 W6）。装配照 `AdminMailView.spec.ts`：
// 直接挂视图 + 真实 i18n + 按 URL 分派的 fetch 桩。红线：**不用 w.emitted()**。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import AdminMacroRunsView from './AdminMacroRunsView.vue';
import { i18n, setLocale } from '../i18n';

interface Recorded { url: string; method: string; params: URLSearchParams }
type Handler = (c: Recorded) => Response | undefined;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(handler: Handler): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const params = new URL(url, 'http://localhost').searchParams;
    const rec: Recorded = { url, method, params };
    calls.push(rec);
    const res = handler(rec);
    if (!res) throw new Error(`fetch 桩没处理 ${method} ${url}`);
    return res;
  }));
  return calls;
}

function run(id: string, templateId: string, templateName: string, status: string, verdict: string | null = null): Record<string, unknown> {
  return {
    id, startedAt: `2026-11-16T08:0${id}:00.000Z`, templateId, templateName,
    userId: 'u1', userName: 'alice', anchor: null, criterion: 'terminal',
    status, verdict, durationMs: 120, usage: null,
  };
}

// 模板表：tpl-deleted 已软删，tpl-live 正常。
const TEMPLATES = [
  { id: 'tpl-deleted', name: '旧告警', deleted_at: '2026-11-01T00:00:00.000Z' },
  { id: 'tpl-live', name: '失败告警', deleted_at: null },
];

async function mountView(): Promise<VueWrapper> {
  const w = mount(AdminMacroRunsView, { global: { plugins: [i18n] } });
  await flushPromises();
  return w;
}

function text(wrapper: VueWrapper, testId: string): string {
  return wrapper.get(`[data-test="${testId}"]`).text().trim();
}

beforeEach(() => setLocale('zh-CN'));
afterEach(() => vi.unstubAllGlobals());

describe('③ 百分比分母是 done 而不是 triggered', () => {
  it('done=3 / triggered=5 / pass=1 ⇒ 判决占比显示 33%（不是被 triggered 摊薄的 20%），且整块不出现 60%', async () => {
    stubFetch((c) => {
      if (c.url.startsWith('/api/admin/macro-templates')) return json(200, { items: TEMPLATES });
      if (c.url.startsWith('/api/admin/macro-runs/summary')) {
        return json(200, { triggered: 5, done: 3, skipped: 2, failed: 0,
          byVerdict: { pass: 1, red: 1, 'no-op-claim': 0, 'needs-human': 0, unclassified: 1 }, usage: null });
      }
      if (c.url.startsWith('/api/admin/macro-runs')) return json(200, { items: [], nextCursor: null });
      return undefined;
    });
    const wrapper = await mountView();

    // 1/3 = 33%（分母 done），绝不是 1/5 = 20%（分母 triggered）。
    const passLine = wrapper.get('[data-test="ratio-pass"]').text();
    expect(passLine).toContain('33%');
    expect(passLine).not.toContain('20%');
    // 也绝不把「完成率」按 triggered 摊成 60%（3/5）显示。
    expect(wrapper.get('[data-test="macro-runs-summary"]').text()).not.toContain('60%');
  });
});

describe('① 「跳过」单独成列（不并进「完成」）', () => {
  it('sum-done 只显示 done(3)、sum-skipped 单独显示 skipped(2)，互不掺和', async () => {
    stubFetch((c) => {
      if (c.url.startsWith('/api/admin/macro-templates')) return json(200, { items: TEMPLATES });
      if (c.url.startsWith('/api/admin/macro-runs/summary')) {
        return json(200, { triggered: 5, done: 3, skipped: 2, failed: 1,
          byVerdict: { pass: 3, red: 0, 'no-op-claim': 0, 'needs-human': 0, unclassified: 0 }, usage: null });
      }
      if (c.url.startsWith('/api/admin/macro-runs')) return json(200, { items: [], nextCursor: null });
      return undefined;
    });
    const wrapper = await mountView();

    expect(text(wrapper, 'sum-done')).toBe('3');
    expect(text(wrapper, 'sum-skipped')).toBe('2');
    expect(text(wrapper, 'sum-failed')).toBe('1');
    expect(text(wrapper, 'sum-triggered')).toBe('5');
    // 完成 ≠ 完成+跳过（若把跳过并进完成，sum-done 会显示 5）。
    expect(text(wrapper, 'sum-done')).not.toBe('5');
  });
});

describe('③ LEFT JOIN：软删模板显示「（已删除）」', () => {
  it('引用软删模板的行标「已删除」，引用正常模板的行不标', async () => {
    stubFetch((c) => {
      if (c.url.startsWith('/api/admin/macro-templates')) return json(200, { items: TEMPLATES });
      if (c.url.startsWith('/api/admin/macro-runs/summary')) {
        return json(200, { triggered: 2, done: 0, skipped: 0, failed: 0,
          byVerdict: { pass: 0, red: 0, 'no-op-claim': 0, 'needs-human': 0, unclassified: 0 }, usage: null });
      }
      if (c.url.startsWith('/api/admin/macro-runs')) {
        return json(200, { items: [run('1', 'tpl-deleted', '旧告警', 'done', 'pass'), run('2', 'tpl-live', '失败告警', 'done', 'red')], nextCursor: null });
      }
      return undefined;
    });
    const wrapper = await mountView();
    const rows = wrapper.findAll('[data-test="macro-run-row"]');
    expect(rows).toHaveLength(2);
    const deletedRow = rows.find((r) => r.attributes('data-template-id') === 'tpl-deleted');
    const liveRow = rows.find((r) => r.attributes('data-template-id') === 'tpl-live');
    expect(deletedRow!.get('[data-test="row-template"]').text()).toContain('已删除');
    expect(liveRow!.get('[data-test="row-template"]').text()).not.toContain('已删除');
    // 后端 admin 流水不下发 session 列 ⇒ 表里不该有「会话」列链接。
    expect(wrapper.text()).not.toContain('sessionId');
  });
});

describe('④ keyset 翻页不重不漏', () => {
  it('首页 2 条 + 带 cursor 翻出 1 条 ⇒ 共 3 条且 id 不重复；more 请求带 cursor；到底显示 noMore', async () => {
    const calls = stubFetch((c) => {
      if (c.url.startsWith('/api/admin/macro-templates')) return json(200, { items: TEMPLATES });
      if (c.url.startsWith('/api/admin/macro-runs/summary')) {
        return json(200, { triggered: 3, done: 3, skipped: 0, failed: 0,
          byVerdict: { pass: 3, red: 0, 'no-op-claim': 0, 'needs-human': 0, unclassified: 0 }, usage: null });
      }
      if (c.url.startsWith('/api/admin/macro-runs')) {
        const cursor = c.params.get('cursor');
        if (cursor === 'c1') return json(200, { items: [run('3', 'tpl-c', '记录三', 'done')], nextCursor: null });
        return json(200, { items: [run('1', 'tpl-a', '记录一', 'done'), run('2', 'tpl-b', '记录二', 'done')], nextCursor: 'c1' });
      }
      return undefined;
    });
    const wrapper = await mountView();
    expect(wrapper.findAll('[data-test="macro-run-row"]')).toHaveLength(2);

    await wrapper.get('[data-test="macro-runs-more"]').trigger('click');
    await flushPromises();

    const rows = wrapper.findAll('[data-test="macro-run-row"]');
    expect(rows).toHaveLength(3);
    const ids = rows.map((r) => r.attributes('data-template-id'));
    expect(new Set(ids).size).toBe(3); // 不漏不重（三条不同模板行都在）
    // 翻页请求必须带 cursor（keyset，而不是 offset）。
    expect(calls.some((c) => c.url.startsWith('/api/admin/macro-runs?') && c.params.get('cursor') === 'c1')).toBe(true);
    expect(wrapper.find('[data-test="macro-runs-no-more"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="macro-runs-more"]').exists()).toBe(false);
  });
});

describe('② 筛选后汇总跟着变', () => {
  it('改状态筛选 ⇒ 重新请求 summary 并带上新条件，DOM 汇总从 5 变 9', async () => {
    const calls = stubFetch((c) => {
      if (c.url.startsWith('/api/admin/macro-templates')) return json(200, { items: TEMPLATES });
      if (c.url.startsWith('/api/admin/macro-runs/summary')) {
        // 汇总跟着 status 变：failed ⇒ triggered=9，否则 5。
        const triggered = c.params.get('status') === 'failed' ? 9 : 5;
        return json(200, { triggered, done: 0, skipped: 0, failed: 0,
          byVerdict: { pass: 0, red: 0, 'no-op-claim': 0, 'needs-human': 0, unclassified: 0 }, usage: null });
      }
      if (c.url.startsWith('/api/admin/macro-runs')) return json(200, { items: [], nextCursor: null });
      return undefined;
    });
    const wrapper = await mountView();
    expect(text(wrapper, 'sum-triggered')).toBe('5');

    await wrapper.get('[data-test="filter-status"]').setValue('failed');
    await flushPromises();

    expect(calls.some((c) => c.url.startsWith('/api/admin/macro-runs/summary') && c.params.get('status') === 'failed')).toBe(true);
    expect(text(wrapper, 'sum-triggered')).toBe('9');
  });
});
