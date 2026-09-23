// workbench store 单测：草稿三路径、addMessage 去重/渲染规则、发送失败回填、
// 会话加载守卫、深链解析（列表内/跨项目/404 静默回退）。语义锚点：旧 index.html 内联 JS。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { setWorkbenchHooks, useWorkbenchStore } from './workbench';

/** EventSource 桩（openSession 会 connect；本套件只验证 URL 与状态，不驱动事件帧）。 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener() {}
  close() { this.closed = true; }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init);
    return jsonResponse(status, body);
  }));
}

beforeEach(() => {
  setActivePinia(createPinia());
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('alert', vi.fn());
  setWorkbenchHooks({});
});

const USER = { role: 'fde', fde_name: 'alice' };

describe('workbench store', () => {
  it('initWorkspace：无项目 → noProject 禁用态；有项目 → 加载会话列表', async () => {
    mockFetch(() => ({ status: 200, body: { items: [] } }));
    const store = useWorkbenchStore();
    await store.initWorkspace(USER);
    expect(store.noProject).toBe(true);
    expect(store.inputPlaceholder).toBe('先创建项目');
    expect(store.sessions).toEqual([]);

    mockFetch((url) => url.startsWith('/api/projects')
      ? { status: 200, body: { items: [{ id: 'p1', name: 'demo' }] } }
      : { status: 200, body: { items: [{ id: 's1', title: 't' }] } });
    const store2 = useWorkbenchStore();
    await store2.initWorkspace(USER);
    expect(store2.noProject).toBe(false);
    expect(store2.projectId).toBe('p1');
    expect(store2.sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('平台管理员空态：newProj 禁用 + 管理台引导 placeholder', async () => {
    mockFetch(() => ({ status: 200, body: { items: [] } }));
    const store = useWorkbenchStore();
    await store.initWorkspace({ role: 'admin', fde_name: null });
    expect(store.isPlatformAdmin).toBe(true);
    expect(store.newProjDisabled).toBe(true);
    expect(store.inputPlaceholder).toBe('平台管理员：请到管理台创建 FDE 用户与分配资源');
  });

  it('addMessage：renderedIds 去重；助手终稿走 markdown，user/synthetic 纯文本', async () => {
    mockFetch(() => ({ status: 200, body: { items: [] } }));
    const store = useWorkbenchStore();
    store.renderedIds = new Set();
    store.addMessage({ id: 'm1', role: 'assistant', content: '# 标题\n**粗体**' });
    store.addMessage({ id: 'm1', role: 'assistant', content: '重复应被忽略' });
    store.addMessage({ id: 'm2', role: 'user', content: '<b>不渲染</b>' });
    store.addMessage({ id: 'm3', role: 'assistant', content: '系统内容', synthetic: true });
    const msgs = store.entries.filter((e) => e.kind === 'msg');
    expect(msgs.length).toBe(3); // m1 去重
    const [a, u, syn] = msgs as Extract<typeof msgs[number], { kind: 'msg' }>[];
    expect(a.html).toContain('<h1>标题</h1>');
    expect(a.html).toContain('<strong>粗体</strong>');
    expect(u.html).toBeNull();
    expect(u.text).toBe('<b>不渲染</b>'); // 纯文本，未转义渲染
    expect(syn.html).toBeNull();
    expect(syn.text).toBe('〔系统注入〕系统内容');
  });

  it('草稿：saveDraft 有值 set / 空值 delete；openSession 切回恢复草稿', async () => {
    mockFetch((url) => url.includes('/api/sessions/s1')
      ? { status: 200, body: { session: { id: 's1' }, messages: [], last_seq: 0 } }
      : { status: 200, body: { items: [] } });
    const store = useWorkbenchStore();
    store.sessionId = 's1';
    store.inputValue = '半截任务';
    store.saveDraft();
    expect(store.drafts.get('s1')).toBe('半截任务');
    store.inputValue = '';
    store.saveDraft(); // 空值清除
    expect(store.drafts.has('s1')).toBe(false);

    // 真实流程：切走（saveDraft 存草稿）→ 切回恢复
    store.sessionId = 's1';
    store.inputValue = '半截任务';
    store.sessionId = null; // 切走（旧 openSession/switchProject 先 saveDraft）
    store.sessionId = 's1';
    store.saveDraft();
    store.sessionId = null;
    store.inputValue = '';
    await store.openSession('s1'); // saveDraft 对 null sessionId 是 no-op，然后恢复草稿
    expect(store.inputValue).toBe('半截任务');
  });

  it('发送成功：清草稿、追加 user 消息、置运行态；发送失败：回填输入 + syserr 指引', async () => {
    let calls = 0;
    mockFetch((url, init) => {
      if (url.endsWith('/messages') && init?.method === 'POST') {
        calls++;
        if (calls === 1) return { status: 200, body: { message: { id: 'm9', content: '任务' }, run: { id: 'r1' } } };
        return { status: 409, body: { error: { code: 'llm_not_configured', message: 'llm not configured' } } };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    store.sessionId = 's1';
    store.renderedIds = new Set();
    store.inputValue = '  任务  ';
    await store.send();
    expect(store.inputValue).toBe(''); // 成功后清空
    expect(store.drafts.has('s1')).toBe(false);
    expect(store.entries.some((e) => e.kind === 'msg' && e.text === '任务')).toBe(true);
    expect(store.es.activeRunId).toBe('r1');

    // 运行中再发送被忽略（旧守卫：!content || !sid || S.activeRunId）
    const lenBefore = store.entries.length;
    store.inputValue = '第二条';
    await store.send();
    expect(store.entries.length).toBe(lenBefore);

    // 失败路径：llm_not_configured 409 友好指引 + 回填输入 + 草稿写回
    store.es.activeRunId = null;
    store.inputValue = '再次尝试';
    await store.send();
    expect(store.inputValue).toBe('再次尝试');
    expect(store.drafts.get('s1')).toBe('再次尝试');
    const err = store.entries.find((e) => e.kind === 'syserr');
    expect(err && 'text' in err ? err.text : '').toContain('发送失败：该 FDE 未配置 LLM 上游');
  });

  it('run_in_progress 409 错误带「（已有进行中任务）」后缀', async () => {
    mockFetch((url) => url.endsWith('/messages')
      ? { status: 409, body: { error: { code: 'run_in_progress', message: 'run in progress' } } }
      : { status: 200, body: { items: [] } });
    const store = useWorkbenchStore();
    store.sessionId = 's1';
    store.renderedIds = new Set();
    store.inputValue = 'x';
    await store.send();
    const err = store.entries.find((e) => e.kind === 'syserr');
    expect(err && 'text' in err ? err.text : '').toContain('（已有进行中任务）');
  });

  it('openSession 404 → 静默 resetSessionView + onClearRoute 清深链；其他错误保留 + syserr', async () => {
    let mode: 'not_found' | 'boom' = 'not_found';
    mockFetch((url) => {
      if (url.includes('/api/sessions/ghost')) {
        return mode === 'not_found'
          ? { status: 404, body: { error: { code: 'not_found', message: 'not found' } } }
          : { status: 500, body: { error: { code: 'internal', message: 'boom' } } };
      }
      return { status: 200, body: { items: [] } };
    });
    const clearRoute = vi.fn();
    setWorkbenchHooks({ onClearRoute: clearRoute });
    const store = useWorkbenchStore();
    await store.openSession('ghost');
    expect(store.sessionId).toBeNull();
    expect(clearRoute).toHaveBeenCalled();
    expect(store.entries.length).toBe(0); // 静默（无 syserr）

    mode = 'boom';
    const store2 = useWorkbenchStore();
    await store2.openSession('ghost');
    expect(store2.sessionId).toBe('ghost'); // 其他错误：保留（可刷新重试）
    expect(store2.entries.some((e) => e.kind === 'syserr' && e.text === '会话加载失败，可刷新重试')).toBe(true);
    expect(clearRoute).toHaveBeenCalledTimes(1); // 不再清路由
  });

  it('深链解析：列表内直开；跨项目切项目后打开并写回深链；404 静默回退', async () => {
    mockFetch((url) => {
      if (url.startsWith('/api/projects')) return { status: 200, body: { items: [{ id: 'p1', name: 'a' }] } };
      if (url.includes('/api/sessions/deep')) return { status: 200, body: { session: { id: 'deep', project_id: 'p2' }, messages: [], last_seq: 0 } };
      if (url.includes('/api/sessions/in-list')) return { status: 200, body: { session: { id: 'in-list', project_id: 'p1' }, messages: [], last_seq: 0 } };
      if (url.includes('project_id=p2')) return { status: 200, body: { items: [] } };
      return { status: 200, body: { items: [{ id: 'in-list', title: 't' }] } };
    });
    const restored: string[] = [];
    setWorkbenchHooks({ onDeepLinkRestored: (sid) => restored.push(sid) });
    const store = useWorkbenchStore();
    await store.initWorkspace(USER);
    expect(store.projectId).toBe('p1');
    expect(store.sessions.map((s) => s.id)).toEqual(['in-list']);

    // 列表内深链：直开（当前项目列表命中）
    await store.resolveRouteSession('in-list');
    expect(store.sessionId).toBe('in-list');

    // 跨项目深链：detail → 切项目 → 打开 → 写回深链
    await store.resolveRouteSession('deep');
    expect(store.projectId).toBe('p2');
    expect(store.sessionId).toBe('deep');
    expect(restored).toEqual(['deep']);

    // 404 深链：静默回退（sessionId 清空，不抛错）
    mockFetch((url) => url.includes('/api/sessions/nope')
      ? { status: 404, body: { error: { code: 'not_found', message: 'not found' } } }
      : { status: 200, body: { items: [] } });
    await store.resolveRouteSession('nope');
    expect(store.sessionId).toBeNull();
  });

  it('switchProject：保存并清空草稿、复位协议状态、重载会话（序号守卫丢弃迟到响应）', async () => {
    const responses: Record<string, unknown> = {
      p1: [{ id: 's-old', title: '旧' }],
      p2: [{ id: 's-new', title: '新' }],
    };
    mockFetch((url) => {
      if (url.startsWith('/api/projects')) return { status: 200, body: { items: [{ id: 'p1' }, { id: 'p2' }] } };
      const m = url.match(/project_id=(p\d)/);
      return { status: 200, body: { items: responses[m?.[1] ?? ''] ?? [] } };
    });
    const store = useWorkbenchStore();
    await store.initWorkspace(USER);
    store.sessionId = 's1';
    store.inputValue = '项目 A 的草稿';
    store.es.activeRunId = 'r1';
    await store.switchProject('p2');
    expect(store.projectId).toBe('p2');
    expect(store.sessionId).toBeNull();
    expect(store.inputValue).toBe('');
    expect(store.drafts.get('s1')).toBe('项目 A 的草稿'); // 离开会话已保存
    expect(store.es.activeRunId).toBeNull();
    expect(store.sessions.map((s) => s.id)).toEqual(['s-new']);
  });
});
