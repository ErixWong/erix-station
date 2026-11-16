// `stores/macro.ts` 的单测（issue #528）。形状照 `stores/admin.spec.ts`：
// 请求桩 + `setActivePinia`，**不用 `w.emitted()`**（`NODE_ENV=production` 下恒空）。
//
// 钉的是 store 那一层：路径/方法/请求体、DTO 归一化（含「用户看不到的字段必须被丢掉」）、
// 空态判定、水位线、轮询的终态即停。组件的渲染面在两个 `.spec.ts` 里。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  MACRO_TEMPLATES_PATH,
  NOTIFICATIONS_PATH,
  NOTIFICATIONS_UNREAD_PATH,
  macroAssignmentsPath,
  macroAssignmentPath,
  macroRunsPath,
  useMacroStore,
} from './macro';
import { setLocale } from '../i18n';

const SESSION = '11111111-1111-4111-8111-111111111111';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(handler: (call: RecordedCall) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = typeof init?.body === 'string' ? init.body : null;
    const call: RecordedCall = { url, method, body: raw === null ? null : JSON.parse(raw) };
    calls.push(call);
    return handler(call);
  }));
  return calls;
}

/** 后端 `toMacroRunSnapshot` 的原样形状（snake_case，含用户面**不许看**的两列）。 */
function runRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-1',
    assignment_id: 'a-1',
    anchor: 'run 9f3a',
    bucket: null,
    status: 'done',
    criterion: 'terminal',
    verdict: 'pass',
    verdict_raw: '通过',
    reason: null,
    remediation_text: null,
    skipped_reason: null,
    started_at: '2026-11-16T06:03:12.000Z',
    finished_at: '2026-11-16T06:07:24.000Z',
    child_session_id: null,
    child_run_id: null,
    depth: 0,
    parent_macro_run_id: null,
    snapshot_id: 'snap-should-not-be-shown',
    worktree_path: '/wt/should-not-be-shown',
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('请求面（W3 的真实路径）', () => {
  it('模板 / 订阅 / 流水 / 未读数各自打对路径与方法', async () => {
    const calls = stubFetch((call) => {
      if (call.url.startsWith(MACRO_TEMPLATES_PATH)) {
        return jsonResponse(200, { items: [{ id: 't-1', kind: 'run-review', name: '完成审查', params: {}, scope: 'session', audience: 'all' }] });
      }
      if (call.url.startsWith(macroAssignmentsPath(SESSION))) {
        return jsonResponse(200, { items: [{ id: 'a-1', template_id: 't-1', user_id: 'u', session_id: SESSION, enabled: true, expired: false, effective_enabled: true, last_evaluated_at: '2026-11-16T06:03:12.000Z', created_at: '2026-11-16T05:00:00.000Z' }] });
      }
      if (call.url.startsWith(macroRunsPath(SESSION))) {
        return jsonResponse(200, { items: [runRow()], nextCursor: null });
      }
      if (call.url === NOTIFICATIONS_UNREAD_PATH) return jsonResponse(200, { count: 3 });
      if (call.url.startsWith(NOTIFICATIONS_PATH)) return jsonResponse(200, { items: [], nextCursor: null });
      return jsonResponse(404, { error: { code: 'not_found', message: 'nope' } });
    });

    const macro = useMacroStore();
    await macro.loadTemplates();
    await macro.loadAssignments(SESSION);
    await macro.loadRuns(SESSION);
    await macro.refreshUnreadCount();

    expect(calls.map((c) => `${c.method} ${c.url.split('?')[0]}`)).toEqual([
      `GET ${MACRO_TEMPLATES_PATH}`,
      `GET ${macroAssignmentsPath(SESSION)}`,
      `GET ${macroRunsPath(SESSION)}`,
      `GET ${NOTIFICATIONS_UNREAD_PATH}`,
    ]);
    expect(macro.templates).toHaveLength(1);
    expect(macro.unreadCount).toBe(3);
  });

  it('PUT 订阅带 templateId/until；DELETE 取消带 assignmentId 路径', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'PUT') {
        return jsonResponse(200, { assignment: { id: 'a-9', template_id: (call.body as { templateId: string }).templateId, session_id: SESSION, enabled: true, expired: false, effective_enabled: true, last_evaluated_at: null, created_at: '2026-11-16T07:00:00.000Z' } });
      }
      return jsonResponse(200, { deleted: true });
    });

    const macro = useMacroStore();
    expect(await macro.assign(SESSION, 't-1')).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'PUT', url: macroAssignmentsPath(SESSION), body: { templateId: 't-1', until: null } });
    expect(macro.enabledAssignments).toHaveLength(1);

    expect(await macro.unassign(SESSION, 'a-9')).toBe(true);
    expect(calls[1]).toMatchObject({ method: 'DELETE', url: macroAssignmentPath(SESSION, 'a-9') });
    expect(macro.enabledAssignments).toHaveLength(0);
  });

  it('判决筛选走服务端参数；模板筛选在本地（会话流水端点没有 templateId 参数）', async () => {
    const calls = stubFetch(() => jsonResponse(200, { items: [], nextCursor: null }));
    const macro = useMacroStore();
    macro.setVerdictFilter('red', SESSION);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[0].url).toContain(`${macroRunsPath(SESSION)}?`);
    expect(calls[0].url).toContain('verdict=red');
    expect(macro.filterActive).toBe(true);
  });

  it('markRead 打 POST 并把未读数减一（本地立即反映，不等下一次读）', async () => {
    const calls = stubFetch((call) => {
      if (call.url.startsWith(NOTIFICATIONS_PATH)) {
        return jsonResponse(200, { items: [{ id: 'n-1', severity: 'warn', title: '审查需人工', body: '', read_at: null, created_at: '2026-11-16T06:03:12.000Z' }], nextCursor: null });
      }
      return jsonResponse(200, { count: 1 });
    });
    const macro = useMacroStore();
    await macro.loadNotifications();
    await macro.refreshUnreadCount();
    expect(calls[0].url).toBe(`${NOTIFICATIONS_PATH}?limit=30`);
    expect(await macro.markRead('n-1')).toBe(true);
    expect(calls[2].method).toBe('POST');
    expect(calls[2].url).toBe(`${NOTIFICATIONS_PATH}/n-1/read`);
    expect(macro.unreadCount).toBe(0);
    expect(macro.notifications[0].readAt).not.toBeNull();
  });
});

describe('DTO 归一化（用户面看不到的字段必须在归一层就丢掉）', () => {
  it('snapshot_id / worktree_path 不进状态；usage 缺失是 null 而不是 0', async () => {
    stubFetch(() => jsonResponse(200, { items: [runRow()], nextCursor: null }));
    const macro = useMacroStore();
    await macro.loadRuns(SESSION);
    const run = macro.runs[0];
    expect(run).toBeTruthy();
    expect(Object.keys(run)).not.toContain('snapshot_id');
    expect(Object.keys(run)).not.toContain('worktree_path');
    expect(JSON.stringify(run)).not.toContain('snap-should-not-be-shown');
    expect(JSON.stringify(run)).not.toContain('/wt/should-not-be-shown');
    expect(run.usage).toBeNull();
    expect(run.pending).toBe(false);
  });

  it('有 usage 才归一成实测数字；未完成（finished_at 为空）判 pending 以便轮询', async () => {
    stubFetch(() => jsonResponse(200, {
      items: [runRow({ id: 'run-2', usage: { input_tokens: 82000, output_tokens: 3100 }, finished_at: null, status: 'running' })],
      nextCursor: null,
    }));
    const macro = useMacroStore();
    await macro.loadRuns(SESSION);
    expect(macro.runs[0].usage).toEqual({ inputTokens: 82000, outputTokens: 3100 });
    expect(macro.hasPending).toBe(true);
  });
});

describe('空态四选一（判据①的技术面）', () => {
  it('首次加载中 = loading，不是空态', async () => {
    stubFetch(() => jsonResponse(200, { items: [], nextCursor: null }));
    const macro = useMacroStore();
    macro.runsLoading = true;
    await Promise.resolve();
    expect(macro.panelStateValue).toBe('loading');
  });

  it('加载失败 = failed，并且带错误原文', async () => {
    stubFetch(() => jsonResponse(500, { error: { code: 'internal', message: '数据库炸了' } }));
    const macro = useMacroStore();
    await macro.loadRuns(SESSION);
    expect(macro.panelStateValue).toBe('failed');
    expect(macro.runsErrorText).toContain('数据库炸了');
  });

  it('无订阅 = noSubscription；有订阅未触发 = neverTriggered；筛选后空 = filteredEmpty', async () => {
    stubFetch(() => jsonResponse(200, { items: [], nextCursor: null }));
    const macro = useMacroStore();
    expect(macro.panelStateValue).toBe('noSubscription');

    macro.assignments = [{
      id: 'a-1', templateId: 't-1', sessionId: SESSION, until: null,
      enabled: true, expired: false, effectiveEnabled: true,
      lastEvaluatedAt: '2026-11-16T06:03:12.000Z', createdAt: null,
    }];
    expect(macro.panelStateValue).toBe('neverTriggered');

    macro.setVerdictFilter('red');
    expect(macro.panelStateValue).toBe('filteredEmpty');
  });
});

describe('水位线（判据⑤的数据面）', () => {
  const FIXED = Date.parse('2026-11-16T06:40:00.000Z');

  it('新鲜阈值 3 × 60s：内 = 不告警，外 = 告警', () => {
    const macro = useMacroStore();
    macro.assignments = [{
      id: 'a-1', templateId: 't-1', sessionId: SESSION, until: null,
      enabled: true, expired: false, effectiveEnabled: true,
      lastEvaluatedAt: '2026-11-16T06:39:00.000Z', createdAt: null,
    }];
    expect(macro.watermark(FIXED).stale).toBe(false);

    macro.assignments = [{
      ...macro.assignments[0],
      lastEvaluatedAt: '2026-11-16T05:53:00.000Z',
    }];
    expect(macro.watermark(FIXED).stale).toBe(true);
  });

  it('首次订阅（水位线为 null）= 陈旧且标记「尚未评估」', () => {
    const macro = useMacroStore();
    macro.assignments = [{
      id: 'a-1', templateId: 't-1', sessionId: SESSION, until: null,
      enabled: true, expired: false, effectiveEnabled: true,
      lastEvaluatedAt: null, createdAt: null,
    }];
    const state = macro.watermark(FIXED);
    expect(state.stale).toBe(true);
    expect(state.neverEvaluated).toBe(true);
  });

  it('没有生效订阅 ⇒ 不报平台健康问题（没东西可评估）', () => {
    const macro = useMacroStore();
    expect(macro.watermark(FIXED)).toEqual({ last: null, stale: false, neverEvaluated: false });
  });

  it('setClock 注入后组件读到的是固定时刻', () => {
    const macro = useMacroStore();
    macro.setClock(() => FIXED);
    expect(macro.now()).toBe(FIXED);
  });
});

describe('轮询（`07` §16：有未完成才轮询，终态即停，关面板一个请求都不发）', () => {
  it('打开抽屉拉一次；有 pending 就按 2s 继续；全完成就停', async () => {
    vi.useFakeTimers();
    let pending = true;
    const calls = stubFetch(() => jsonResponse(200, {
      items: [runRow({ status: pending ? 'running' : 'done', finished_at: pending ? null : '2026-11-16T06:07:24.000Z' })],
      nextCursor: null,
    }));
    const macro = useMacroStore();
    await macro.openDrawer(SESSION);
    const before = calls.length;
    expect(macro.hasPending).toBe(true);

    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.length).toBeGreaterThan(before);

    pending = false;
    await vi.advanceTimersByTimeAsync(2000);
    const afterSettled = calls.length;
    expect(macro.hasPending).toBe(false);
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls.length).toBe(afterSettled);
  });

  it('关抽屉后停轮询：不再发请求', async () => {
    vi.useFakeTimers();
    const calls = stubFetch(() => jsonResponse(200, { items: [runRow({ status: 'running', finished_at: null })], nextCursor: null }));
    const macro = useMacroStore();
    await macro.openDrawer(SESSION);
    macro.closeDrawer();
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls.length).toBe(before);
  });
});
