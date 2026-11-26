// issue #808：useMyUsage 的可测逻辑。轮询/visibility 行为省略（照 useGitLight，形状一致）；
// 重点钉三件：no_binding 是空态**不是**错误、失败保留旧值、reqSeq 竞态守卫。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useMyUsage } from './useMyUsage';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const QUOTA1 = { quota: { spend: 1, spend_scope: 'period', max_budget: 10, budget_duration: '1mo', budget_period: null, budget_usd: 10, budget_reset_at: null, remaining: 9 }, reason: null };
const QUOTA2 = { quota: { spend: 2, spend_scope: 'period', max_budget: 10, budget_duration: '1mo', budget_period: null, budget_usd: 10, budget_reset_at: null, remaining: 8 }, reason: null };

function makeUsage() {
  const scope = effectScope();
  let usage!: ReturnType<typeof useMyUsage>;
  scope.run(() => { usage = useMyUsage(); });
  return { scope, usage };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useMyUsage', () => {
  it('no_binding：空态，不是错误（error 保持 null、loaded=true）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ quota: null, reason: 'no_binding' })));
    const { scope, usage } = makeUsage();
    await usage.load();
    expect(usage.quota.value).toBeNull();
    expect(usage.reason.value).toBe('no_binding');
    expect(usage.error.value).toBeNull();
    expect(usage.loaded.value).toBe(true);
    scope.stop();
  });

  it('成功：quota/reason 落地', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(QUOTA1)));
    const { scope, usage } = makeUsage();
    await usage.load();
    expect(usage.quota.value?.spend).toBe(1);
    expect(usage.reason.value).toBeNull();
    expect(usage.error.value).toBeNull();
    scope.stop();
  });

  it('失败：记一句可显示的 error，且**保留旧 quota**', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++call === 1 ? json(QUOTA1) : json({ error: { code: 'llm_gateway_error', message: '网关不可达' } }, 502))));
    const { scope, usage } = makeUsage();
    await usage.load();
    expect(usage.quota.value?.spend).toBe(1);
    await usage.load();
    expect(usage.error.value).toContain('网关不可达');
    expect(usage.quota.value?.spend).toBe(1); // 旧值仍在，不闪成「没有」
    scope.stop();
  });

  it('竞态守卫：迟到的旧响应不得覆盖新响应（最终认最新一轮）', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      if (call === 1) {
        await new Promise((r) => setTimeout(r, 30)); // 慢
        return json(QUOTA1);
      }
      return json(QUOTA2); // 快
    }));
    const { scope, usage } = makeUsage();
    await Promise.all([usage.load(), usage.load()]);
    expect(usage.quota.value?.spend).toBe(2); // 不是被慢的 1 覆盖
    scope.stop();
  });

  it('loadUsage：成功填 days；失败记 usageError 且保留旧 days', async () => {
    const days = [{ date: '2026-11-01', spend: 0.5, prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, api_requests: 1 }];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++call === 1 ? json({ days, totals: { spend: 0.5, total_tokens: 2 } }) : json({ error: { code: 'not_found' } }, 404))));
    const { scope, usage } = makeUsage();
    await usage.loadUsage();
    expect(usage.days.value).toHaveLength(1);
    expect(usage.usageError.value).toBeNull();
    await usage.loadUsage();
    expect(usage.usageError.value).toBeTruthy();
    expect(usage.days.value).toHaveLength(1); // 旧 days 保留
    scope.stop();
  });

  it('reset：作废在途并清读数', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(QUOTA1)));
    const { scope, usage } = makeUsage();
    await usage.load();
    usage.reset();
    expect(usage.quota.value).toBeNull();
    expect(usage.loaded.value).toBe(false);
    expect(usage.error.value).toBeNull();
    scope.stop();
  });
});
