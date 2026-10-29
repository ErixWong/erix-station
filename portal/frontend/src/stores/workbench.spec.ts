// workbench store 单测（issue #84 P5 改版）：目录即项目——/api/dirs 数据源、cwd 过滤、
// createDir（POST /api/sessions {cwd}）、selectDir 复位语义、跨目录深链。
// 语义锚点：旧 index.html 内联 JS + 本 store 头注。消息/草稿/发送守卫用例不受 P5 影响，保留。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { setWorkbenchHooks, useWorkbenchStore, type StreamEntry } from './workbench';
import type { RunHistoryEvent } from '../composables/useEventStream';
import { setLocale } from '../i18n';
// issue #431：断言复位连模块级展开记忆一起清（它不属于 store，只能从外部函数看）
import { isToolCallExpanded, setToolCallExpanded } from '../lib/toolCallExpansion';

/** EventSource 桩（openSession 会 connect；本套件只验证 URL 与状态，不驱动事件帧）。 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(fn);
    this.listeners.set(type, callbacks);
  }
  close() { this.closed = true; }
  emit(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
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

/** 捕获最近一次 POST /api/sessions 的请求体（createSession/createDir 断言用）。 */
let lastSessionPostBody: unknown = null;

beforeEach(() => {
  // issue #101 P2：store 文案走 i18n 单例（i18n.global.t），每例固定 zh-CN（既有中文断言逐字不变）。
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
  FakeEventSource.instances = [];
  lastSessionPostBody = null;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('alert', vi.fn());
  setWorkbenchHooks({});
});

const DIR_A = { name: 'demo', cwd: '~/projects/demo', running_count: 1, queued_count: 1 };
const DIR_B = { name: 'other', cwd: '~/projects/other', running_count: 0, queued_count: 0 };

/** 标准 handler：/api/dirs 返回 [DIR_A, DIR_B]；/api/sessions 按 cwd 参数分派。 */
function dirsAwareHandler(lists: Record<string, unknown[]>) {
  return (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/dirs')) return { status: 200, body: { dirs: [DIR_A, DIR_B] } };
    if (url.startsWith('/api/sessions') && init?.method === 'POST') {
      lastSessionPostBody = JSON.parse(String(init.body));
      return { status: 200, body: { session: { id: 's-new', cwd: (lastSessionPostBody as { cwd: string }).cwd } } };
    }
    const m = url.match(/[?&]cwd=([^&]*)/);
    const cwd = m ? decodeURIComponent(m[1]) : '';
    return { status: 200, body: { items: lists[cwd] ?? [] } };
  };
}

describe('workbench store（P5 目录即项目）', () => {
  it('initWorkspace：无目录 → noDir 禁用态；有目录 → 选中第一个目录并加载其会话', async () => {
    mockFetch(() => ({ status: 200, body: { dirs: [] } }));
    const store = useWorkbenchStore();
    await store.initWorkspace();
    expect(store.noDir).toBe(true);
    expect(store.inputPlaceholder).toBe('先创建目录');
    expect(store.sessions).toEqual([]);

    mockFetch(dirsAwareHandler({ '~/projects/demo': [{ id: 's1', title: 't', cwd: '~/projects/demo' }] }));
    const store2 = useWorkbenchStore();
    await store2.initWorkspace();
    expect(store2.noDir).toBe(false);
    expect(store2.dirCwd).toBe('~/projects/demo');
    expect(store2.currentDir?.name).toBe('demo');
    expect(store2.sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('loadSessions：带 ?cwd= 请求 + 响应 cwd 防御性过滤（契约差异期双保险）', async () => {
    mockFetch(dirsAwareHandler({
      // 后端未过滤干净的脏数据：混入别的目录的会话，前端须滤掉
      '~/projects/demo': [
        { id: 's1', cwd: '~/projects/demo' },
        { id: 's-x', cwd: '~/projects/other' },
      ],
    }));
    const store = useWorkbenchStore();
    await store.initWorkspace();
    expect(store.sessions.map((s) => s.id)).toEqual(['s1']); // s-x 被客户端过滤
    const fetchMock = vi.mocked(fetch);
    const url = new URL(String(fetchMock.mock.calls.find(([u]) => String(u).startsWith('/api/sessions'))?.[0]), 'http://x');
    expect(url.searchParams.get('cwd')).toBe('~/projects/demo');
    expect(url.searchParams.get('limit')).toBeNull(); // 评审裁决瘦身：回退后端默认（20）
  });

  it('loadSessions：message_count 透传与缺失容忍（#197 侧栏消息数，列表项原样携带后端计数）', async () => {
    mockFetch(dirsAwareHandler({
      '~/projects/demo': [
        { id: 's1', cwd: '~/projects/demo', message_count: 42 },
        { id: 's2', cwd: '~/projects/demo' }, // 旧后端无此字段 → 不得补 0/占位，保持 undefined
      ],
    }));
    const store = useWorkbenchStore();
    await store.initWorkspace();
    expect(store.sessions.map((s) => s.message_count)).toEqual([42, undefined]);
  });

  // issue #332：原本这里有一条「平台管理员空态：newDir 禁用 + 管理台引导 placeholder」。
  // 入口拦截（router 守卫的 workbenchGateDecision）落地后，`admin && !fde_name` 的人**进不到工作台**，
  // store 里的 isPlatformAdmin / newDirDisabled 与该文案一并拆除 ⇒ 本文件不再钉这类形状；
  // 新行为的守门人在 lib/workbenchGate.spec.ts（判据）+ views/SeatlessAdminGate.spec.ts（不挂载/不发请求）。

  it('createSession：POST /api/sessions 请求体为 {cwd}（project_id 已退役）', async () => {
    mockFetch(dirsAwareHandler({}));
    const store = useWorkbenchStore();
    await store.initWorkspace();
    const s = await store.createSession();
    expect(s?.id).toBe('s-new');
    expect(lastSessionPostBody).toEqual({ cwd: '~/projects/demo' });
    expect(store.sessions[0]?.id).toBe('s-new'); // 列表置顶
  });

  it('createDir：非法名本地校验不发请求；合法名以该 cwd 建会话（服务端 mkdir），切目录并置顶', async () => {
    mockFetch(dirsAwareHandler({}));
    const store = useWorkbenchStore();
    await store.initWorkspace();

    const bad = await store.createDir('Bad_Name');
    expect(bad.error).toContain('目录名只能用');
    expect(lastSessionPostBody).toBeNull(); // 未发请求

    const ok = await store.createDir('my-app');
    expect(ok.error).toBeNull();
    expect(lastSessionPostBody).toEqual({ cwd: '~/projects/my-app' });
    expect(store.dirCwd).toBe('~/projects/my-app');
    expect(store.dirs.some((d) => d.cwd === '~/projects/my-app')).toBe(true);
    expect(store.sessions[0]?.id).toBe('s-new'); // 新会话置顶，视图可打开
    expect(store.noDir).toBe(false);
  });

  // issue #284：前端表单原先比后端更严，把下划线目录名误拒（后端 validateSessionCwd 一直允许 `_`）。
  // 这里走 store 全链路（本地校验 → POST /api/sessions {cwd}）钉「下划线能建」。
  it('createDir（#284）：带下划线的目录名通过本地校验并以该 cwd 建会话', async () => {
    mockFetch(dirsAwareHandler({}));
    const store = useWorkbenchStore();
    await store.initWorkspace();

    const ok = await store.createDir('cmms_test');
    expect(ok.error).toBeNull();
    expect(lastSessionPostBody).toEqual({ cwd: '~/projects/cmms_test' });
    expect(store.dirCwd).toBe('~/projects/cmms_test');

    // 首尾下划线仍然拒（与 `-x` / `x-` 对称）：本地拦截，不发请求。
    lastSessionPostBody = null;
    for (const name of ['_cmms', 'cmms_']) {
      const bad = await store.createDir(name);
      expect(bad.error).toContain('目录名只能用');
      expect(lastSessionPostBody, `${name} 不应发请求`).toBeNull();
    }
  });

  it('refreshDirs：选中目录仍在 → 不动；已消失 → 回退第一个目录并重载会话', async () => {
    let dirs = [DIR_A, DIR_B];
    mockFetch((url) => {
      if (url.startsWith('/api/dirs')) return { status: 200, body: { dirs } };
      const m = url.match(/[?&]cwd=([^&]*)/);
      const cwd = m ? decodeURIComponent(m[1]) : '';
      const lists: Record<string, unknown[]> = {
        '~/projects/demo': [{ id: 's1', cwd: '~/projects/demo' }],
        '~/projects/other': [{ id: 's2', cwd: '~/projects/other' }],
      };
      return { status: 200, body: { items: lists[cwd] ?? [] } };
    });
    const store = useWorkbenchStore();
    await store.initWorkspace(); // 选中 demo
    await store.refreshDirs(); // 目录未变 → 会话列表不重载（dirCwd 不变）
    expect(store.dirCwd).toBe('~/projects/demo');

    dirs = [DIR_B]; // demo 从磁盘消失
    await store.refreshDirs();
    expect(store.dirCwd).toBe('~/projects/other');
    expect(store.sessions.map((s) => s.id)).toEqual(['s2']);
  });

  it('selectDir：保存并清空草稿、复位协议状态、按 cwd 重载会话（序号守卫丢弃迟到响应）', async () => {
    const lists: Record<string, unknown[]> = {
      '~/projects/demo': [{ id: 's-old', title: '旧', cwd: '~/projects/demo' }],
      '~/projects/other': [{ id: 's-new', title: '新', cwd: '~/projects/other' }],
    };
    mockFetch(dirsAwareHandler(lists));
    const store = useWorkbenchStore();
    await store.initWorkspace();
    store.sessionId = 's1';
    store.inputValue = '目录 A 的草稿';
    store.es.activeRunId = 'r1';
    await store.selectDir('~/projects/other');
    expect(store.dirCwd).toBe('~/projects/other');
    expect(store.sessionId).toBeNull();
    expect(store.inputValue).toBe('');
    expect(store.drafts.get('s1')).toBe('目录 A 的草稿'); // 离开会话已保存
    expect(store.es.activeRunId).toBeNull();
    expect(store.sessions.map((s) => s.id)).toEqual(['s-new']);
  });

  it('深链解析：列表内直开；跨目录切目录后打开并写回深链；404 静默回退', async () => {
    mockFetch((url) => {
      if (url.startsWith('/api/dirs')) return { status: 200, body: { dirs: [DIR_A] } };
      if (url.includes('/api/sessions/deep')) {
        return { status: 200, body: { session: { id: 'deep', cwd: '~/projects/other' }, messages: [], last_seq: 0 } };
      }
      if (url.includes('/api/sessions/in-list')) {
        return { status: 200, body: { session: { id: 'in-list', cwd: '~/projects/demo' }, messages: [], last_seq: 0 } };
      }
      if (url.includes('cwd=' + encodeURIComponent('~/projects/other'))) return { status: 200, body: { items: [] } };
      return { status: 200, body: { items: [{ id: 'in-list', title: 't', cwd: '~/projects/demo' }] } };
    });
    const restored: string[] = [];
    setWorkbenchHooks({ onDeepLinkRestored: (sid) => restored.push(sid) });
    const store = useWorkbenchStore();
    await store.initWorkspace();
    expect(store.dirCwd).toBe('~/projects/demo');
    expect(store.sessions.map((s) => s.id)).toEqual(['in-list']);

    // 列表内深链：直开（当前目录列表命中）
    await store.resolveRouteSession('in-list');
    expect(store.sessionId).toBe('in-list');

    // 跨目录深链：detail → 切目录 → 打开 → 写回深链（目录列表合成兜底项）
    await store.resolveRouteSession('deep');
    expect(store.dirCwd).toBe('~/projects/other');
    expect(store.dirs.some((d) => d.cwd === '~/projects/other')).toBe(true);
    expect(store.sessionId).toBe('deep');
    expect(restored).toEqual(['deep']);

    // 404 深链：静默回退（sessionId 清空，不抛错）
    mockFetch((url) => url.includes('/api/sessions/nope')
      ? { status: 404, body: { error: { code: 'not_found', message: 'not found' } } }
      : { status: 200, body: { items: [] } });
    await store.resolveRouteSession('nope');
    expect(store.sessionId).toBeNull();
  });
});

describe('workbench store（P5 前既有语义，回归保留）', () => {
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
    store.sessionId = null; // 切走（旧 openSession/selectDir 先 saveDraft）
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

  // issue #261014 切片 B2：绑定的 `model_info.id` 在网关里已不存在（模型被删/重建 ⇒ id 变）——
  // 服务端现在给 `409 llm_model_not_found` + `details={slot, model_id}`，用户要看到一句话说清
  // 「哪个槽位的哪个模型没了、去哪儿改」。旧的 `sendFailed` 兼容路径不能把这码演成「发送失败：nope」。
  it('llm_model_not_found 409：syserr 文案带槽位与模型 id，并回填输入', async () => {
    mockFetch((url, init) => (url.endsWith('/messages') && init?.method === 'POST'
      ? { status: 409, body: { error: { code: 'llm_model_not_found', message: 'nope', details: { slot: 'main', model_id: 'mid-42' } } } }
      : { status: 200, body: { items: [] } }));
    const store = useWorkbenchStore();
    store.sessionId = 's1';
    store.renderedIds = new Set();
    store.inputValue = '发一条';
    await store.send();
    const err = store.entries.filter((e) => e.kind === 'syserr').pop();
    const text = err && 'text' in err ? err.text : '';
    expect(text).toContain('本 FDE 绑定的模型在 LLM 网关里已不存在');
    expect(text).toContain('main');
    expect(text).toContain('mid-42');
    expect(text).toContain('管理台');
    expect(text).not.toContain('[object Object]');
    // 失败不吞内容（与 llm_not_configured 同口径）
    expect(store.inputValue).toBe('发一条');
    expect(store.drafts.get('s1')).toBe('发一条');
  });

  it('llm_model_not_found 脏 details（嵌套对象 / 数字）：经 toDisplayText 收口，不退化成 [object Object]', async () => {
    mockFetch((url, init) => (url.endsWith('/messages') && init?.method === 'POST'
      ? {
        status: 409,
        body: { error: { code: 'llm_model_not_found', message: 'nope', details: { slot: { deep: { a: 1 } }, model_id: 7 } } },
      }
      : { status: 200, body: { items: [] } }));
    const store = useWorkbenchStore();
    store.sessionId = 's1';
    store.renderedIds = new Set();
    store.inputValue = 'x';
    await store.send();
    const err = store.entries.filter((e) => e.kind === 'syserr').pop();
    const text = err && 'text' in err ? err.text : '';
    expect(text).not.toContain('[object Object]');
    expect(text).not.toContain('undefined');
    expect(text).toContain('{"deep":{"a":1}}'); // 脏值以 JSON 文本原样带出，不静默丢
    expect(text).toContain('7');
  });

  // 服务端现在随 details 带绑定里的**调用名**（model_name）：用户只认得这个名字，
  // 而 model_id 是 LiteLLM 主键 UUID，摊在聊天框里读不得。旧服务端没带时才退回 id。
  it('llm_model_not_found：details 带 model_name ⇒ 文案用调用名，不再摊 UUID', async () => {
    mockFetch((url, init) => (url.endsWith('/messages') && init?.method === 'POST'
      ? {
        status: 409,
        body: {
          error: {
            code: 'llm_model_not_found', message: 'nope',
            details: { slot: 'main', model_id: '920aa0c6-f336-4085-b6b1-607660883b35', model_name: 'deepseek-flash' },
          },
        },
      }
      : { status: 200, body: { items: [] } }));
    const store = useWorkbenchStore();
    store.sessionId = 's1';
    store.renderedIds = new Set();
    store.inputValue = 'x';
    await store.send();
    const text = store.entries.filter((e) => e.kind === 'syserr').pop() as { text: string };
    expect(text.text).toContain('deepseek-flash');
    expect(text.text).not.toContain('920aa0c6');
    expect(text.text).toContain('main');
  });

  it('切 English：llm_model_not_found 的发送失败文案是英文（双语成对，不拿中文交差）', async () => {
    mockFetch((url, init) => (url.endsWith('/messages') && init?.method === 'POST'
      ? { status: 409, body: { error: { code: 'llm_model_not_found', message: 'nope', details: { slot: 'vision', model_id: 'mid-9' } } } }
      : { status: 200, body: { items: [] } }));
    const store = useWorkbenchStore();
    store.sessionId = 's1';
    store.renderedIds = new Set();
    store.inputValue = 'x';
    setLocale('en');
    await store.send();
    const err = store.entries.filter((e) => e.kind === 'syserr').pop();
    const text = err && 'text' in err ? err.text : '';
    expect(text).toContain('the model this FDE is bound to no longer exists in the LLM gateway');
    expect(text).toContain('vision');
    expect(text).toContain('mid-9');
    expect(text).not.toMatch(/[\u4e00-\u9fff]/);
    setLocale('zh-CN');
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

  it('issue #89：openSession 并行拉 events/history，messages 与事件按 seq 归并穿插重建', async () => {
    mockFetch((url) => {
      if (url.includes('/api/sessions/s1/events/history')) {
        return {
          status: 200,
          body: {
            events: [
              { seq: 2, run_id: 'r1', type: 'tool_use', payload: { tool_call_id: 'c1', name: 'bash', input: { cmd: 'ls' } } },
              { seq: 3, run_id: 'r1', type: 'tool_result', payload: { tool_call_id: 'c1', ok: true, result_digest: 'ok', duration_ms: 5 } },
              { seq: 4, run_id: 'r1', type: 'judge', payload: { decision: { extend: false, extendReason: '够用了' } } },
            ],
            next_cursor: null,
          },
        };
      }
      if (url.includes('/api/sessions/s1')) {
        return {
          status: 200,
          body: {
            session: { id: 's1', active_run_id: null },
            messages: [
              { id: 'm1', role: 'user', content: '任务', seq: 1 },
              { id: 'm2', role: 'assistant', content: '完成', seq: 5 },
            ],
            last_seq: 5,
          },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    // 归并顺序：msg(1) → tool_use(2) 卡片 → tool_result(3) 回填 → judge(4) sep → msg(5)
    expect(store.entries.map((e) => e.kind)).toEqual(['msg', 'tool', 'sep', 'msg']);
    const judgeSep = store.entries[2];
    expect(judgeSep.kind).toBe('sep');
    if (judgeSep.kind === 'sep') {
      // issue #321 分轴文案：extend=false 单轴 → 「不建议扩轮 — {extendReason}」
      expect(judgeSep.text).toBe('judge：不建议扩轮 — 够用了');
      expect(judgeSep.variant).toBe('judge'); // feat-260925-02 judge 面板高亮 sep
    }
    // issue #279：历史事件带 run_id ⇒ 卡片身份键含 run（这批事件无 round_start ⇒ 轮号段不拼）。
    const card = store.es.toolCards.get('r1:c1');
    expect(card?.ok).toBe(true);
    expect(card?.out).toBe('✓ ok（5ms）');
    expect(store.es.lastSeq).toBe(5);
    expect(store.es.activeRunId).toBeNull();
  });

  // 试用台账 #10：后端一直 keyset 分页（默认只给最新 20 条），前端必须消费 next_cursor，
  // 否则长会话「开头从压缩横幅开始」、最早的对话永远看不见（消息并未被压缩删除）。
  it('台账 #10：openSession 首屏带 limit=100 并记下 next_cursor；loadOlderMessages 带 cursor 取更早批并**前插**；到底后 no-op', async () => {
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      if (url.includes('/api/sessions/s1/events/history')) {
        return { status: 200, body: { events: [], next_cursor: null } };
      }
      if (url.includes('/api/sessions/s1')) {
        if (url.includes('cursor=')) {
          return {
            status: 200,
            body: {
              session: { id: 's1' },
              messages: [
                { id: 'm1', role: 'user', content: '最早提问', seq: 1 },
                { id: 'm2', role: 'assistant', content: '最早回复', seq: 3 },
              ],
              last_seq: 11,
              next_cursor: null, // 这批已翻到第一条
            },
          };
        }
        return {
          status: 200,
          body: {
            session: { id: 's1' },
            messages: [
              { id: 'm10', role: 'user', content: '新提问', seq: 10 },
              { id: 'm11', role: 'assistant', content: '新回复', seq: 11 },
            ],
            last_seq: 11,
            next_cursor: 9,
          },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(urls.some((u) => u.includes('/api/sessions/s1?limit=100'))).toBe(true); // 首屏取满后端窗口上限
    expect(store.olderMessagesCursor).toBe(9); // next_cursor 被消费，入口存在
    expect(store.entries.map((e) => (e as { kind: string }).kind)).toEqual(['msg', 'msg']);

    expect(await store.loadOlderMessages()).toBe(true);
    expect(urls.some((u) => /\/api\/sessions\/s1\?limit=100&cursor=9$/.test(u))).toBe(true);
    // 更早批整段**前插**：按 seq 在已加载内容之前，而不是追加到尾部
    const texts = store.entries.filter((e) => e.kind === 'msg').map((e) => (e as { text: string }).text);
    expect(texts).toEqual(['最早提问', '最早回复', '新提问', '新回复']);
    expect(store.olderMessagesCursor).toBeNull(); // 到底 → 入口消失

    const callsBefore = urls.length;
    expect(await store.loadOlderMessages()).toBe(false); // 无游标 → no-op，不发请求
    expect(urls.length).toBe(callsBefore);
  });

  it('台账 #10：更早批同时带 events/history?before=<事件游标> 回放（judge 分隔行前插到旧正文区）', async () => {
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      if (url.includes('/api/sessions/s1/events/history')) {
        if (url.includes('before=')) {
          return {
            status: 200,
            body: {
              events: [{ seq: 2, run_id: 'r0', type: 'judge', payload: { decision: { extend: false, extendReason: '够了' } } }],
              next_cursor: null,
            },
          };
        }
        return { status: 200, body: { events: [], next_cursor: 6 } };
      }
      if (url.includes('/api/sessions/s1')) {
        if (url.includes('cursor=')) {
          return {
            status: 200,
            body: {
              session: { id: 's1' },
              messages: [
                { id: 'm1', role: 'user', content: '最早提问', seq: 1 },
                { id: 'm2', role: 'assistant', content: '最早回复', seq: 3 },
              ],
              last_seq: 11,
              next_cursor: null,
            },
          };
        }
        return {
          status: 200,
          body: {
            session: { id: 's1' },
            messages: [{ id: 'm10', role: 'user', content: '新提问', seq: 10 }],
            last_seq: 11,
            next_cursor: 9,
          },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(store.olderEventsCursor).toBe(6); // 事件端点的 next_cursor 也被消费

    expect(await store.loadOlderMessages()).toBe(true);
    expect(urls.some((u) => u.includes('/events/history?limit=2000&before=6'))).toBe(true);
    // 前插段内部按 seq 穿插：msg(1) → judge sep(2) → msg(3)，都在旧内容之前
    expect(store.entries.map((e) => e.kind)).toEqual(['msg', 'sep', 'msg', 'msg']);
    expect(store.entries[2]).toMatchObject({ kind: 'msg', text: '最早回复' });
  });

  it('台账 #10：更早批加载失败 → 返回 false、游标原地不动（入口保留可重试）', async () => {
    mockFetch((url) => {
      if (url.includes('/api/sessions/s1/events/history')) {
        return { status: 200, body: { events: [], next_cursor: null } };
      }
      if (url.includes('/api/sessions/s1')) {
        if (url.includes('cursor=')) return { status: 500, body: { error: { code: 'internal', message: 'boom' } } };
        return {
          status: 200,
          body: { session: { id: 's1' }, messages: [{ id: 'm10', role: 'user', content: 'q', seq: 10 }], last_seq: 10, next_cursor: 9 },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(await store.loadOlderMessages()).toBe(false);
    expect(store.olderMessagesCursor).toBe(9); // 失败不推进游标
    expect(store.olderLoading).toBe(false);
  });

  it('issue #89 红线：历史回放不驱动运行态状态机（run_end 误下发也不触发刷新/停按钮态）', async () => {
    mockFetch((url) => {
      if (url.includes('/api/sessions/s1/events/history')) {
        return {
          status: 200,
          body: {
            // 模拟异常：服务端误把 run_end 下发（白名单外，前端二次短路兜底）
            events: [
              { seq: 2, run_id: 'r1', type: 'run_end', payload: { termination: { reason: 'end_turn' } } },
              { seq: 3, run_id: 'r1', type: 'tool_use', payload: { tool_call_id: 'c1', name: 'bash', input: {} } },
            ],
            next_cursor: null,
          },
        };
      }
      if (url.includes('/api/sessions/s1')) {
        return {
          status: 200,
          body: {
            session: { id: 's1', active_run_id: 'r-active' }, // 有进行中 run
            messages: [{ id: 'm1', role: 'user', content: '任务', seq: 1 }],
            last_seq: 3,
          },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(store.es.activeRunId).toBe('r-active'); // 未被历史 run_end 清掉（停止按钮保持）
    expect(store.es.lastSeq).toBe(3); // 水位线仍按 detail.last_seq
    expect(store.entries.some((e) => e.kind === 'sep' && e.text.includes('run 结束'))).toBe(false);
    expect(store.es.toolCards.has('r1:c1')).toBe(true); // 展示事件正常重建（#279：身份键含 run_id）
    expect(store.running).toBe(true);
  });

  it('issue #89：events/history 拉取失败降级为纯文本视图（不影响详情加载，不报错）', async () => {
    mockFetch((url) => {
      if (url.includes('/api/sessions/s1/events/history')) {
        return { status: 500, body: { error: { code: 'internal', message: 'boom' } } };
      }
      if (url.includes('/api/sessions/s1')) {
        return {
          status: 200,
          body: {
            session: { id: 's1' },
            messages: [{ id: 'm1', role: 'user', content: '任务', seq: 1 }],
            last_seq: 1,
          },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(store.sessionId).toBe('s1');
    expect(store.entries.map((e) => e.kind)).toEqual(['msg']); // 仅消息，无 syserr
    expect(store.entries.some((e) => e.kind === 'syserr')).toBe(false);
  });

  it('issue #217：SSE 重连时 active_run_id=null 清运行态并只提示一次', async () => {
    mockFetch((url, init) => {
      if (url.endsWith('/events/history')) return { status: 200, body: { events: [] } };
      if (url.endsWith('/messages') && init?.method === 'POST') {
        return { status: 200, body: { message: { id: 'm1', content: '任务' }, run: { id: 'r1' } } };
      }
      if (url.split('?')[0] === '/api/sessions/s1') {
        return { status: 200, body: { session: { id: 's1', active_run_id: null }, messages: [], last_seq: 0 } };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    store.inputValue = '任务';
    await store.send(); // 用户消息成功入队后本地进入 run 状态
    expect(store.es.activeRunId).toBe('r1');
    // 断言被 issue #370 有意改掉：运行中**不再禁用发送**（那句话改走输入队列，而不是「等一会儿
    // 再说」）。这里从 `true` 改成 `false`，语义由「跑着就别说话」变成「随时能说，服务端决定入队」。
    expect(store.sendDisabled).toBe(false);

    const connection = FakeEventSource.instances.at(-1)!;
    connection.onerror?.(); // EventSource 断线，期间 run_end 丢失
    connection.onopen?.(); // 自动重连成功；detail 返回 active_run_id=null
    const interrupted = '连接中断期间该 run 已结束（详情见运行记录）';
    await vi.waitFor(() => {
      expect(store.es.activeRunId).toBeNull();
      expect(store.sendDisabled).toBe(false);
      expect(store.entries.filter((e) => e.kind === 'sep' && e.text === interrupted)).toHaveLength(1);
    });

    connection.onerror?.();
    connection.onopen?.(); // 后续重连仍为 null，不重复刷提示
    await vi.waitFor(() => {
      expect(store.entries.filter((e) => e.kind === 'sep' && e.text === interrupted)).toHaveLength(1);
    });
  });

  it('issue #217：重连时 active_run_id 非空保留运行态且不提示已结束', async () => {
    mockFetch((url, init) => {
      if (url.endsWith('/events/history')) return { status: 200, body: { events: [] } };
      if (url.endsWith('/messages') && init?.method === 'POST') {
        return { status: 200, body: { message: { id: 'm1', content: '任务' }, run: { id: 'r1' } } };
      }
      if (url.split('?')[0] === '/api/sessions/s1') {
        return { status: 200, body: { session: { id: 's1', active_run_id: 'r1' }, messages: [], last_seq: 0 } };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    store.inputValue = '任务';
    await store.send();

    const connection = FakeEventSource.instances.at(-1)!;
    connection.onerror?.();
    connection.onopen?.();
    await vi.waitFor(() => expect(store.es.activeRunId).toBe('r1'));
    expect(store.running).toBe(true);
    // 同上：issue #370 之后运行中仍可发送（走队列），故此断言由 true 改为 false。
    expect(store.sendDisabled).toBe(false);
    expect(store.entries.some((e) => e.kind === 'sep' && e.text.includes('连接中断期间'))).toBe(false);
  });

  it('issue #217：重开同一会话按 active_run_id 清状态并显示英文中性提示', async () => {
    setLocale('en');
    let activeRunId: string | null = 'r1';
    mockFetch((url) => {
      if (url.endsWith('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') {
        return { status: 200, body: { session: { id: 's1', active_run_id: activeRunId }, messages: [], last_seq: 0 } };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(store.running).toBe(true);

    activeRunId = null;
    await store.openSession('s1');
    expect(store.es.activeRunId).toBeNull();
    expect(store.sendDisabled).toBe(false);
    expect(store.entries.filter((e) => e.kind === 'sep')).toEqual([
      { kind: 'sep', text: 'This run ended while the connection was interrupted (see run history)' },
    ]);
    expect(store.entries.some((e) => e.kind === 'syserr')).toBe(false);
  });

  it('issue #217：在线收到当前 run_end 仍渲染原终态行，不显示断线提示', async () => {
    mockFetch((url) => {
      if (url.endsWith('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') {
        return { status: 200, body: { session: { id: 's1', active_run_id: 'r1' }, messages: [], last_seq: 0 } };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    FakeEventSource.instances.at(-1)!.emit('run_end', {
      seq: 1, run_id: 'r1', termination: { reason: 'end_turn' },
    });

    expect(store.es.activeRunId).toBeNull();
    expect(store.entries.some((e) => e.kind === 'sep' && e.text === 'run 结束：正常完成')).toBe(true);
    expect(store.entries.some((e) => e.kind === 'sep' && e.text.includes('连接中断期间'))).toBe(false);
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
});

// ---------------------------------------------------------------------------
// issue #101 P2：store 用户可见文案走 i18n（i18n.global.t；zh-CN 基线逐字不变，切 en 即时生效）
// ---------------------------------------------------------------------------
describe('workbench store · i18n（issue #101 P2）', () => {
  it('zh-CN 基线：占位符两态（有目录/无目录）+ 目录名校验错误 / synthetic 前缀 / 停止分隔行', async () => {
    mockFetch(dirsAwareHandler({}));
    const store = useWorkbenchStore();
    await store.initWorkspace();
    expect(store.inputPlaceholder).toBe('输入任务，Enter 发送（Shift+Enter 换行）');

    store.noDir = true;
    expect(store.inputPlaceholder).toBe('先创建目录');
    // issue #332：原先紧跟一行 `store.isPlatformAdmin = true` 把占位符改成「请到管理台…」——
    // 入口拦截后这类人进不到工作台，store 已没有 isPlatformAdmin 这个态（占位符恒为两态）。

    const bad = await store.createDir('Bad_Name');
    expect(bad.error).toBe('目录名只能用小写字母、数字、下划线、连字符；不能以连字符或下划线开头/结尾；最长 63 字符。容器里已存在的目录（哪怕含其它字符）可直接在目录下拉里选中使用。');

    store.renderedIds = new Set();
    store.addMessage({ id: 'm1', role: 'assistant', content: '内容', synthetic: true });
    const syn = store.entries.find((e) => e.kind === 'msg' && e.synthetic);
    expect(syn && 'text' in syn ? syn.text : '').toBe('〔系统注入〕内容');
  });

  it('切 English：占位符 / 校验错误 / synthetic 前缀即时变英文（computed 响应式）', async () => {
    mockFetch(dirsAwareHandler({}));
    const store = useWorkbenchStore();
    await store.initWorkspace();
    setLocale('en');
    expect(store.inputPlaceholder).toBe('Type a task, Enter to send (Shift+Enter for a newline)');

    store.noDir = true;
    expect(store.inputPlaceholder).toBe('Create a directory first');
    // issue #332：平台管理员占位符那三行已随入口拦截拆除（同上，zh 侧同口径）。

    const bad = await store.createDir('Bad_Name');
    expect(bad.error).toContain('Directory names may only use lowercase letters, digits, underscores and hyphens');

    store.renderedIds = new Set();
    store.addMessage({ id: 'm1', role: 'assistant', content: 'body', synthetic: true });
    const syn = store.entries.find((e) => e.kind === 'msg' && e.synthetic);
    expect(syn && 'text' in syn ? syn.text : '').toBe('[system] body');
  });

  it('切 English：发送失败 / llm_not_configured / 会话加载失败 / 停止失败文案变英文', async () => {
    mockFetch((url, init) => {
      if (url.endsWith('/messages') && init?.method === 'POST') {
        return { status: 409, body: { error: { code: 'llm_not_configured', message: 'llm not configured' } } };
      }
      if (url.includes('/api/sessions/ghost')) {
        return { status: 500, body: { error: { code: 'internal', message: 'boom' } } };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    store.sessionId = 's1';
    store.renderedIds = new Set();
    store.inputValue = 'x';
    setLocale('en');

    await store.send();
    const err = store.entries.find((e) => e.kind === 'syserr');
    expect(err && 'text' in err ? err.text : '').toContain('Send failed: this FDE has no LLM upstream configured');

    // 会话加载失败（非 404）保留路由 + syserr
    const store2 = useWorkbenchStore();
    await store2.openSession('ghost');
    const loadErr = store2.entries.find((e) => e.kind === 'syserr');
    expect(loadErr && 'text' in loadErr ? loadErr.text : '')
      .toBe('Failed to load the session; refresh to retry');
  });

  // issue #105 ③：会话列表 meta 行时间戳随 locale（原硬编码 toLocaleString('zh-CN')）。
  it('时间戳随 locale（issue #105 ③）：sessMeta 走当前 locale；运行中徽标优先', () => {
    const T = '2026-09-20T08:00:00.000Z';
    const store = useWorkbenchStore();
    const sess = { id: 's1', title: 'x', updated_at: T, active_run_id: null };
    const zh = new Date(T).toLocaleString('zh-CN');
    const en = new Date(T).toLocaleString('en');
    expect(store.sessMeta(sess)).toBe(zh); // zh-CN 基线逐字不变

    setLocale('en');
    expect(store.sessMeta(sess)).toBe(en);
    expect(store.sessMeta(sess)).not.toBe(zh); // 不再是中文格式（硬编码 zh-CN 会在此失败）
    expect(en).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/); // 英文短日期序：月/日/年（zh-CN 为年/月/日）

    // 有活跃 run 时仍走「运行中」徽标（时间不参与）；缺 updated_at 兜底 epoch 不抛错。
    expect(store.sessMeta({ ...sess, active_run_id: 'r1' })).toBe('● Running');
    expect(typeof store.sessMeta({ id: 's2' })).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// issue #107：会话手动重命名（renameSession → PATCH /api/sessions/:id）
// 语义：成功后**原地**更新列表项 title/title_source（不整表 loadSessions）；
//       空串/纯空白本地拦截不发请求（空串落 manual 会永久关掉自动命名）；
//       超长按 200 截断（与后端校验同口径）；失败不改 store，把错误文案交调用方展示。
// ---------------------------------------------------------------------------
describe('workbench store · renameSession（issue #107）', () => {
  let calls: Array<{ url: string; method: string; body: unknown }> = [];

  /** PATCH 返回给定结果；其余请求 200 空列表（同时记录全部请求，用于断言「不整表刷新」）。 */
  function renameHandler(result: { status: number; body: unknown }) {
    return (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (init?.method === 'PATCH') return result;
      return { status: 200, body: { items: [] } };
    };
  }

  beforeEach(() => {
    calls = [];
  });

  it('成功：PATCH {title}（trim）→ 原地更新 title/title_source，且不触发整表 loadSessions', async () => {
    mockFetch(renameHandler({ status: 200, body: { session: { id: 's1', title: '新名', title_source: 'manual' } } }));
    const store = useWorkbenchStore();
    store.sessions = [{ id: 's1', title: '旧名', title_source: 'auto' }, { id: 's2', title: '别的会话' }];

    const { error } = await store.renameSession('s1', '  新名  ');
    expect(error).toBeNull();
    expect(calls).toEqual([{ url: '/api/sessions/s1', method: 'PATCH', body: { title: '新名' } }]);
    expect(store.sessions[0].title).toBe('新名');
    expect(store.sessions[0].title_source).toBe('manual');
    expect(store.sessions[1].title).toBe('别的会话'); // 其它项不受影响
    expect(calls.some((c) => c.method === 'GET')).toBe(false); // 原地更新，无整表刷新
  });

  it('失败（401 ApiError）：返回错误文案、store 原样不动（调用方回退旧标题）', async () => {
    mockFetch(renameHandler({ status: 401, body: { error: { code: 'unauthorized', message: '未登录' } } }));
    const store = useWorkbenchStore();
    store.sessions = [{ id: 's1', title: '旧名', title_source: 'auto' }];

    const { error } = await store.renameSession('s1', '新名');
    expect(error).toBe('未登录');
    expect(store.sessions[0].title).toBe('旧名');
    expect(store.sessions[0].title_source).toBe('auto');
  });

  it('空串/纯空白：本地拦截不发请求（空串落 manual 会永久关掉自动命名）', async () => {
    mockFetch(renameHandler({ status: 200, body: { session: { id: 's1', title: 'x' } } }));
    const store = useWorkbenchStore();
    store.sessions = [{ id: 's1', title: '旧名' }];

    for (const blank of ['', '   ', '\t\n ']) {
      const { error } = await store.renameSession('s1', blank);
      expect(error).toBe('会话名称不能为空');
    }
    expect(calls).toEqual([]);
    expect(store.sessions[0].title).toBe('旧名');
    expect(store.sessions[0].title_source).toBeUndefined();
  });

  it('超长标题：截断到 200 字符再提交（与后端 ≤200 校验同口径）', async () => {
    mockFetch(renameHandler({ status: 200, body: { session: { id: 's1', title: '长'.repeat(200), title_source: 'manual' } } }));
    const store = useWorkbenchStore();
    store.sessions = [{ id: 's1', title: '旧名' }];

    const { error } = await store.renameSession('s1', '长'.repeat(250));
    expect(error).toBeNull();
    expect(calls[0].body).toEqual({ title: '长'.repeat(200) });
    expect(store.sessions[0].title).toBe('长'.repeat(200));
  });

  it('会话不在当前列表（跨目录/已归档）：请求照发，成功不抛错（无匹配项则跳过原地更新）', async () => {
    mockFetch(renameHandler({ status: 200, body: { session: { id: 'ghost', title: '新名', title_source: 'manual' } } }));
    const store = useWorkbenchStore();
    store.sessions = [{ id: 's1', title: '旧名' }];

    const { error } = await store.renameSession('ghost', '新名');
    expect(error).toBeNull();
    expect(store.sessions[0].title).toBe('旧名');
  });

  it('i18n：切 English 后空串拦截文案变英文', async () => {
    mockFetch(renameHandler({ status: 200, body: { session: { id: 's1', title: 'x' } } }));
    const store = useWorkbenchStore();
    setLocale('en');
    const { error } = await store.renameSession('s1', '  ');
    expect(error).toBe('Session title cannot be empty');
    expect(calls).toEqual([]);
  });
});

describe('issue #188：DTO 投影字段（toolCalls/reasoning/blocks）加载路径渲染', () => {
  it('仅凭 DTO（无事件）也能渲染工具卡片与推理块；toolCalls 排在正文气泡前', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [], next_cursor: null } };
      if (url.includes('/api/sessions/s1')) {
        return {
          status: 200,
          body: {
            session: { id: 's1', active_run_id: null },
            messages: [
              { id: 'm1', role: 'user', content: '任务', seq: 1 },
              {
                id: 'm2',
                role: 'assistant',
                content: '完成',
                seq: 2,
                reasoning: '先看文件\n再看结果',
                toolCalls: [{
                  name: 'read', id: 'c1', argsSummary: 'path=src/a.js',
                  resultPreview: 'FILE BODY', isError: false, executionStatus: 'succeeded',
                }],
                blocks: [{ type: 'tool_use', id: 'c1', name: 'read' }],
              },
            ],
            last_seq: 2,
          },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');

    expect(store.entries.map((e) => e.kind)).toEqual(['msg', 'reasoning', 'tool', 'msg']);
    const card = store.es.toolCards.get('c1');
    expect(card?.name).toBe('read');
    expect(card?.argsSummary).toBe('path=src/a.js');
    expect(card?.resultPreview).toBe('FILE BODY');
    expect(card?.executionStatus).toBe('succeeded');
    expect(card?.ok).toBe(true);
    const reasoning = store.entries.find((e) => e.kind === 'reasoning');
    expect(reasoning && 'text' in reasoning ? reasoning.text : '').toBe('先看文件\n再看结果');
  });

  it('同一 tool 调用（DTO 投影 + 历史事件）只渲染一张卡片（同一把尺 + provider id 关联归并）', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) {
        return {
          status: 200,
          body: {
            events: [
              { seq: 2, run_id: 'r1', type: 'tool_use', payload: { tool_call_id: 'c1', name: 'read', input: { path: 'src/a.js' } } },
              { seq: 3, run_id: 'r1', type: 'tool_result', payload: { tool_call_id: 'c1', ok: true, result_digest: 'ok', duration_ms: 5 } },
            ],
            next_cursor: null,
          },
        };
      }
      if (url.includes('/api/sessions/s1')) {
        return {
          status: 200,
          body: {
            session: { id: 's1', active_run_id: null },
            messages: [
              { id: 'm1', role: 'user', content: '任务', seq: 1 },
              {
                id: 'm2', role: 'assistant', content: '完成', seq: 4,
                toolCalls: [{ name: 'read', id: 'c1', argsSummary: 'path=src/a.js' }],
              },
            ],
            last_seq: 4,
          },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');

    expect(store.entries.filter((e) => e.kind === 'tool').length).toBe(1);
    // 事件流先建卡片：完整 args 保留，投影只补全缺失字段。
    // issue #279 顺带把这条钉成「两路轮号/run 对不上时仍只一张卡」的证据：事件侧那张的键是
    // `r1:c1`（有 run_id、无轮号），投影那条**既没 run_id 也没 call.key** ⇒ 精确键是裸 `c1`，
    // 命不中 ⇒ 走 provider id 的关联索引归并回 `r1:c1`（索引只用于找卡，不造身份）。
    expect(store.entries.some((e) => e.kind === 'tool' && 'callId' in e && e.callId === 'r1:c1')).toBe(true);
    expect(store.es.toolCards.get('c1')).toBeUndefined();
    expect(store.es.toolCards.get('r1:c1')?.args).toBe('{"path":"src/a.js"}');
    expect(store.es.toolCards.get('r1:c1')?.argsSummary).toBe('path=src/a.js');
  });

  it('provider id 缺失时用上游投影视图键 call.key（0.16.0 交付，替代自造 proj: 键）', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [], next_cursor: null } };
      if (url.includes('/api/sessions/s1')) {
        return {
          status: 200,
          body: {
            session: { id: 's1', active_run_id: null },
            messages: [
              { id: 'm1', role: 'user', content: '任务', seq: 1 },
              {
                id: 'm2', role: 'assistant', content: '完成', seq: 2,
                toolCalls: [
                  { key: '1#0:0:t0', name: 'a', argsSummary: 'x=1' },
                  { key: '1#0:0:t1', name: 'b', argsSummary: 'y=2' },
                ],
              },
            ],
            last_seq: 2,
          },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');

    expect(store.entries.filter((e) => e.kind === 'tool').length).toBe(2);
    expect(store.es.toolCards.has('1#0:0:t0')).toBe(true);
    expect(store.es.toolCards.has('1#0:0:t1')).toBe(true);
  });

  it('provider id 与上游 key 都缺失时保留「锚点消息 id + 投影内块序号」兜底键', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [], next_cursor: null } };
      if (url.includes('/api/sessions/s1')) {
        return {
          status: 200,
          body: {
            session: { id: 's1', active_run_id: null },
            messages: [
              { id: 'm1', role: 'user', content: '任务', seq: 1 },
              {
                id: 'm2', role: 'assistant', content: '完成', seq: 2,
                toolCalls: [{ name: 'a', argsSummary: 'x=1' }, { name: 'b', argsSummary: 'y=2' }],
              },
            ],
            last_seq: 2,
          },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');

    expect(store.entries.filter((e) => e.kind === 'tool').length).toBe(2);
    expect(store.es.toolCards.has('proj:m2:0')).toBe(true);
    expect(store.es.toolCards.has('proj:m2:1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// issue #189：折叠段（compaction）——DTO folded → 独立折叠 entry；原文懒加载（缓存/404/错误重试）。
// ---------------------------------------------------------------------------
describe('issue #189：折叠段 folded 字段与原文懒加载', () => {
  it('有 folded → 正文气泡前推独立 folded entry（绑定消息 id 与会话 id）；无 folded → 不推', async () => {
    mockFetch(() => ({ status: 200, body: { items: [] } }));
    const store = useWorkbenchStore();
    store.sessionId = 's1';
    store.renderedIds = new Set();
    store.addMessage({
      id: 'm1', role: 'assistant', content: '完成',
      folded: { text: '摘要全文', foldedRoundRange: { from: 2, to: 5 }, foldedPayloadMessages: 9 },
    });
    store.addMessage({ id: 'm2', role: 'assistant', content: '无折叠' });

    expect(store.entries.map((e) => e.kind)).toEqual(['folded', 'msg', 'msg']);
    const banner = store.entries[0];
    expect(banner.kind).toBe('folded');
    if (banner.kind === 'folded') {
      expect(banner.id).toBe('m1'); // 绑定该助手消息
      expect(banner.sessionId).toBe('s1');
      expect(banner.folded.text).toBe('摘要全文');
      expect(banner.folded.foldedRoundRange).toEqual({ from: 2, to: 5 });
      expect(banner.folded.foldedPayloadMessages).toBe(9);
    }
    expect(store.entries.filter((e) => e.kind === 'folded').length).toBe(1); // m2 无折叠不推
  });

  it('sessionStats：消息条数 + 折叠次数计数；无选中会话为 null（头部状态行数据源）', () => {
    mockFetch(() => ({ status: 200, body: { items: [] } }));
    const store = useWorkbenchStore();
    expect(store.sessionStats).toBeNull(); // 未打开会话 → 不渲染

    store.sessionId = 's1';
    store.renderedIds = new Set();
    store.addMessage({ id: 'm1', role: 'user', content: '任务' });
    store.addMessage({ id: 'm2', role: 'assistant', content: 'ok', folded: { text: 's' } });
    store.addMessage({ id: 'm3', role: 'assistant', content: 'ok2' });
    expect(store.sessionStats).toEqual({ messages: 3, folded: 1 });
  });

  it('#197 sessionStats：消息数优先 DTO 的 message_count（长会话 messages 是分页窗口会少报），实时新增不被旧快照吃掉', async () => {
    const window = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: 'x', seq: i + 1,
    }));
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [], next_cursor: null } };
      if (url.includes('/api/sessions/s1')) {
        // 真机场景（会话 e67eaef5）：DB 23 条，DTO messages 只有分页窗口 20 条。
        return { status: 200, body: { session: { id: 's1', active_run_id: null, message_count: 23 }, messages: window, last_seq: 20 } };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(store.entries.filter((e) => e.kind === 'msg').length).toBe(20); // 渲染窗口仍是 20（分页行为不动）
    expect(store.sessionStats).toEqual({ messages: 23, folded: 0 }); // 头部用后端总数，与侧栏同源

    // DTO 快照后实时新增消息：两数取大（21 entries < 23 仍报 23；超过后跟已加载数）。
    store.addMessage({ id: 'live-1', role: 'assistant', content: 'live' });
    expect(store.sessionStats?.messages).toBe(23);
  });

  it('#197 DTO 无 message_count（旧后端/createSession 等其他入口）→ sessionStats 回退已加载条数', async () => {
    const window = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: 'x', seq: i + 1,
    }));
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [], next_cursor: null } };
      if (url.includes('/api/sessions/s1')) {
        return { status: 200, body: { session: { id: 's1', active_run_id: null }, messages: window, last_seq: 20 } };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(store.sessionStats).toEqual({ messages: 20, folded: 0 }); // 缺失 → 回退 messages 长度口径
  });

  it('loadFoldedOriginal：200 → loaded(turns)；按 (sessionId, round) 缓存不重发；不同轮各自加载', async () => {
    let calls = 0;
    mockFetch((url) => {
      if (url.includes('/folded/')) {
        calls++;
        const round = url.split('/folded/')[1];
        return { status: 200, body: { round: Number(round), turns: [{ role: 'user', text: `原文-${round}` }] } };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    const first = await store.loadFoldedOriginal('s1', 3);
    expect(first).toEqual({ status: 'loaded', turns: [{ role: 'user', text: '原文-3' }] });
    const again = await store.loadFoldedOriginal('s1', 3); // 缓存命中：不再发请求
    expect(again.status).toBe('loaded');
    expect(calls).toBe(1);

    await store.loadFoldedOriginal('s1', 4); // 另一轮：独立键
    expect(calls).toBe(2);
    await store.loadFoldedOriginal('s2', 3); // 另一会话：独立键
    expect(calls).toBe(3);
    expect(store.getFoldedOriginal('s1', 3)?.status).toBe('loaded');
    expect(store.getFoldedOriginal('s1', 9)).toBeUndefined(); // 未加载 → undefined（组件按 idle）
    const url = String(vi.mocked(fetch).mock.calls.find(([u]) => String(u).includes('/folded/'))?.[0]);
    expect(url).toBe('/api/sessions/s1/folded/3');
  });

  it('loadFoldedOriginal：404 folded_payload_not_found → missing（友好「无原文」，不抛红不抛错）', async () => {
    mockFetch((url) => url.includes('/folded/')
      ? { status: 404, body: { error: { code: 'folded_payload_not_found', message: 'gone' } } }
      : { status: 200, body: { items: [] } });
    const store = useWorkbenchStore();
    const st = await store.loadFoldedOriginal('s1', 7);
    expect(st).toEqual({ status: 'missing' });
    // missing 也进缓存：重复调用不重发
    const callsBefore = vi.mocked(fetch).mock.calls.length;
    await store.loadFoldedOriginal('s1', 7);
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsBefore);
  });

  it('loadFoldedOriginal：5xx → error(message)，默认不重发；force 重试成功覆盖为 loaded', async () => {
    let fail = true;
    mockFetch((url) => {
      if (url.includes('/folded/')) {
        return fail
          ? { status: 500, body: { error: { code: 'internal', message: 'boom' } } }
          : { status: 200, body: { round: 2, turns: [{ text: '原文' }] } };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    const st = await store.loadFoldedOriginal('s1', 2);
    expect(st).toEqual({ status: 'error', message: 'boom' });
    await store.loadFoldedOriginal('s1', 2); // 非 force：不重发
    expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('/folded/')).length).toBe(1);

    fail = false;
    const retry = await store.loadFoldedOriginal('s1', 2, { force: true });
    expect(retry.status).toBe('loaded');
  });

  it('openSession：DTO 带 folded 的消息重建折叠 entry（历史加载路径）', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [], next_cursor: null } };
      if (url.includes('/api/sessions/s1')) {
        return {
          status: 200,
          body: {
            session: { id: 's1', active_run_id: null },
            messages: [
              { id: 'm1', role: 'user', content: '任务', seq: 1 },
              {
                id: 'm2', role: 'assistant', content: '完成', seq: 2,
                folded: { text: '摘要', foldedRoundRange: { from: 1, to: 3 }, foldedPayloadMessages: 4 },
              },
            ],
            last_seq: 2,
          },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(store.entries.map((e) => e.kind)).toEqual(['msg', 'folded', 'msg']);
    const banner = store.entries[1];
    if (banner.kind === 'folded') {
      expect(banner.id).toBe('m2');
      expect(banner.sessionId).toBe('s1');
    }
  });
});

// issue #261B：一键「重试上一条」——R-2 演练 8 次 provider 超时杀 run，用户全部手打重发长消息。
// 语义锚点（工单 #261B）：① 失败终局（与红色 syserr 同一个 RUN_FAIL_REASONS 判定集合）才点亮；
// ② 重试**复用同一条 send() 链路**（断言口径：POST 端点与首条完全相同、content 逐字相同）；
// ③ 前置守卫任一不满即 no-op；④ 切会话/关会话重置；⑤ 仅内存——本套件不校验持久化（本就不做）。
describe('issue #261B：一键「重试上一条」（retryAvailable / retryLast）', () => {
  /** POST /messages 的 content 流水（断言「同一条链路 + 同 content」的唯一真相）。 */
  let postBodies: string[] = [];

  /** 标准舞台：会话 s1/s2 可开（active_run_id 一律 null），POST /messages 依次回 r1、r2… */
  function retryStage() {
    mockFetch((url, init) => {
      if (url.startsWith('/api/dirs')) return { status: 200, body: { dirs: [DIR_A, DIR_B] } };
      if (url.endsWith('/events/history')) return { status: 200, body: { events: [] } };
      if (url.endsWith('/messages') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { content: string };
        postBodies.push(body.content);
        return {
          status: 200,
          body: { message: { id: `m${postBodies.length}`, content: body.content }, run: { id: `r${postBodies.length}` } },
        };
      }
      const sess = url.match(/^\/api\/sessions\/(s\d)(?:\?.*)?$/);
      if (sess) return { status: 200, body: { session: { id: sess[1], active_run_id: null }, messages: [], last_seq: 0 } };
      return { status: 200, body: { items: [] } };
    });
  }

  function lastES() {
    return FakeEventSource.instances.at(-1)!;
  }

  /** 走完「打开会话 → 发送 → run 失败」的标准前奏，返回 store（此时 retryAvailable 应为 true）。 */
  async function failedRunStore(content = '很长的任务描述，手打重发很痛') {
    const store = useWorkbenchStore();
    await store.openSession('s1');
    store.inputValue = content;
    await store.send();
    endCurrentRun(store, { reason: 'failed', errorCode: 'timeout' }, 9);
    return store;
  }

  /** 以「当前活跃 run」为 run_id 投递 run_end（run_id 不等于 activeRunId 的事件被 useEventStream 丢弃）。 */
  function endCurrentRun(store: ReturnType<typeof useWorkbenchStore>, termination: Record<string, unknown>, seq = 99) {
    lastES().emit('run_end', { seq, run_id: store.es.activeRunId, termination });
  }

  beforeEach(() => {
    postBodies = [];
  });

  it('失败终局（failed ∈ RUN_FAIL_REASONS）→ retryAvailable=true，lastSend 记录同会话同内容', async () => {
    retryStage();
    const store = await failedRunStore();
    expect(store.es.activeRunId).toBeNull(); // run 已结束（无活跃 run）
    expect(store.retryAvailable).toBe(true);
    expect(store.lastSend).toEqual({ sessionId: 's1', content: '很长的任务描述，手打重发很痛' });
  });

  it('红色横幅与重试面同源：非红色集合的终局（end_turn / no_tool）一律不点亮', async () => {
    retryStage();
    const store = await failedRunStore();
    expect(store.retryAvailable).toBe(true);
    // 正常终局把上一次失败点亮的面收回（下一次 run 是 end_turn，不该继续显示「重试上一条」）
    store.es.activeRunId = 'r2';
    endCurrentRun(store, { reason: 'end_turn' }, 10);
    expect(store.retryAvailable).toBe(false);
    // no_tool 属「截断但非故障」，不在红色集合 → 同样不点亮
    store.es.activeRunId = 'r3';
    endCurrentRun(store, { reason: 'no_tool' }, 11);
    expect(store.retryAvailable).toBe(false);
  });

  it('发送成功即记 lastSend，但失败路径不记（POST 没成功就没有可重试的「上一条」）', async () => {
    mockFetch((url, init) => {
      if (url.endsWith('/messages') && init?.method === 'POST') {
        return { status: 409, body: { error: { code: 'run_in_progress', message: 'run in progress' } } };
      }
      if (url.endsWith('/events/history')) return { status: 200, body: { events: [] } };
      return { status: 200, body: { session: { id: 's1', active_run_id: null }, messages: [], last_seq: 0 } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    store.inputValue = '没发出去的内容';
    await store.send();
    expect(store.lastSend).toBeNull();
    expect(store.retryAvailable).toBe(false);
    await store.retryLast();
    expect(postBodies).toEqual([]);
  });

  it('retryLast：复用同一条 send 链路重发同 content（同端点）+ 成功后清标志', async () => {
    retryStage();
    const store = await failedRunStore('重发这条');
    postBodies = [];
    await store.retryLast();
    expect(postBodies).toEqual(['重发这条']); // 新一次 POST、content 逐字相同
    expect(store.es.activeRunId).toBe('r1'); // 新 run 已置位
    expect(store.retryAvailable).toBe(false); // 成功即收回
    expect(store.es.esSessionId).toBe('s1'); // 同一会话，不是另起 api() 的野路子
  });

  it('retryLast 打到 messages 端点（与首条发送同一 URL，未另起 api() 调用）', async () => {
    const urls: string[] = [];
    mockFetch((url, init) => {
      if (url.endsWith('/messages') && init?.method === 'POST') {
        urls.push(url);
        const body = JSON.parse(String(init.body)) as { content: string };
        return { status: 200, body: { message: { id: 'm', content: body.content }, run: { id: `r${urls.length}` } } };
      }
      if (url.endsWith('/events/history')) return { status: 200, body: { events: [] } };
      return { status: 200, body: { session: { id: 's1', active_run_id: null }, messages: [], last_seq: 0 } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    store.inputValue = 'A';
    await store.send();
    endCurrentRun(store, { reason: 'failed' }, 1);
    await store.retryLast();
    expect(urls).toEqual(['/api/sessions/s1/messages', '/api/sessions/s1/messages']);
  });

  it('前置守卫：无活跃 run 之外任一不满 ⇒ no-op（有活跃 run / 无 lastSend / 输入框有草稿 / in-flight）', async () => {
    retryStage();
    const store = await failedRunStore();
    postBodies = [];
    // ① 有活跃 run（用户已抢先手动发了新的）
    store.es.activeRunId = 'rX';
    await store.retryLast();
    expect(postBodies).toEqual([]);
    store.es.activeRunId = null;
    // ② 输入框有草稿：不吞草稿、也不发（与按钮显隐条件同源）
    store.inputValue = '我刚打的草稿';
    await store.retryLast();
    expect(postBodies).toEqual([]);
    expect(store.inputValue).toBe('我刚打的草稿');
    store.inputValue = '';
    // ③ in-flight 期间（双击）
    store.retryInFlight = true;
    await store.retryLast();
    expect(postBodies).toEqual([]);
    store.retryInFlight = false;
    // ④ 无 lastSend（新 store）
    setActivePinia(createPinia());
    const fresh = useWorkbenchStore();
    await fresh.retryLast();
    expect(fresh.retryAvailable).toBe(false);
  });

  it('in-flight 期间 retryInFlight 置位、往返结束复位', async () => {
    retryStage();
    const store = await failedRunStore();
    const p = store.retryLast();
    expect(store.retryInFlight).toBe(true); // POST 往返窗口内（此时 activeRunId 尚未置位）
    await p;
    expect(store.retryInFlight).toBe(false);
  });

  it('重试 POST 失败：retryAvailable 保留（按钮可再点），且不写输入框', async () => {
    let calls = 0;
    mockFetch((url, init) => {
      if (url.endsWith('/messages') && init?.method === 'POST') {
        calls++;
        return calls === 1
          ? { status: 200, body: { message: { id: 'm1', content: 'x' }, run: { id: 'r1' } } }
          : { status: 409, body: { error: { code: 'run_in_progress', message: 'run in progress' } } };
      }
      if (url.endsWith('/events/history')) return { status: 200, body: { events: [] } };
      return { status: 200, body: { session: { id: 's1', active_run_id: null }, messages: [], last_seq: 0 } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    store.inputValue = 'x';
    await store.send();
    endCurrentRun(store, { reason: 'failed' }, 1);
    expect(store.retryAvailable).toBe(true);
    await store.retryLast();
    expect(store.retryAvailable).toBe(true);
    expect(store.inputValue).toBe(''); // 重试路径不回填输入框（回填是「用户自己打的那次」的语义）
  });

  it('切会话 / 关会话 / 切目录 ⇒ 重试面重置，跨会话的失败不误点亮', async () => {
    retryStage();
    const store = await failedRunStore();
    expect(store.retryAvailable).toBe(true);
    await store.openSession('s2'); // 切会话 ⇒ 重置
    expect(store.retryAvailable).toBe(false);
    // 旧会话（s1）的 run 终态不得把当前会话（s2）标成可重试：lastSend 归属核对
    store.es.activeRunId = 'r1';
    endCurrentRun(store, { reason: 'failed' }, 12);
    expect(store.retryAvailable).toBe(false);
    // 关会话（深链回退 / 会话不存在）⇒ 重置，且 sessionId 已空，随后的终态也不点亮
    store.resetSessionView();
    expect(store.retryAvailable).toBe(false);
    store.es.activeRunId = 'r1';
    endCurrentRun(store, { reason: 'failed' }, 13);
    expect(store.retryAvailable).toBe(false);
    // 切目录：重新走一次「发送 → 失败」再切目录
    await store.openSession('s1');
    store.inputValue = '再来一次';
    await store.send();
    endCurrentRun(store, { reason: 'failed' }, 14);
    expect(store.retryAvailable).toBe(true);
    await store.selectDir(DIR_B.cwd);
    expect(store.retryAvailable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// issue #300：中止/失败 run 的部分正文（历史合成项 partial_output → 中性 partial entry）
//
// 三条判据在前端的落点：① **不喂 replayEvent**（喂了就会「实时一条 + 历史一条」或冒出分隔行/卡片）；
// ② 有锚点的 run 不重复（后端已不下发，前端这一层再钉「DTO 有 assistant 消息时历史里就没有合成项」
//    的实际归并结果）；③ 脏载荷退化（不得渲染 undefined/[object Object]）。
// ---------------------------------------------------------------------------
describe('issue #300：partial_output 归并成 kind:partial', () => {
  /** 会话详情（一条 user 消息，零助手锚点 = 被停在半路的 run）+ 历史（含合成项）。 */
  function partialHandler(historyEvents: unknown[], messages: unknown[] = [{ id: 'm1', role: 'user', content: '任务', seq: 1 }]) {
    return (url: string) => {
      if (url.includes('/api/sessions/s1/events/history')) {
        return { status: 200, body: { events: historyEvents, next_cursor: null } };
      }
      if (url.includes('/api/sessions/s1')) {
        return { status: 200, body: { session: { id: 's1', active_run_id: null }, messages, last_seq: 9 } };
      }
      return { status: 200, body: { items: [] } };
    };
  }

  const partialEvent = (payload: Record<string, unknown>, runId = 'r-abort', seq = 7) => ({
    seq, run_id: runId, type: 'partial_output', payload,
  });

  it('历史带 partial_output ⇒ entries 出现 kind:partial，text/truncated 逐字对，**排在 seq 归并位上**', async () => {
    // 合成项 seq=7，夹在两条真实事件之间 ⇒ 「在循环里就地推」与「循环后补推」两种实现可分辨。
    mockFetch(partialHandler([
      { seq: 2, run_id: 'r-abort', type: 'tool_use', payload: { tool_call_id: 'c1', name: 'bash', input: {} } },
      partialEvent({ text: '已经做了一半', chunks: 35, truncated: false }),
      { seq: 8, run_id: 'r-abort', type: 'round_start', payload: { round: 2 } },
    ]));
    const store = useWorkbenchStore();
    await store.openSession('s1');
    // seq：user(1) → tool_use(2) → partial(7) → round_start(8)。「循环后补推」会把它排到最后 ⇒ 可分辨。
    expect(store.entries.map((e) => e.kind)).toEqual(['msg', 'tool', 'partial', 'sep']);
    const en = store.entries.find((e) => e.kind === 'partial') as Extract<StreamEntry, { kind: 'partial' }>;
    expect(en.id).toBe('partial:r-abort');
    expect(en.text).toBe('已经做了一半');
    expect(en.truncated).toBe(false);
    expect(en.sessionId).toBe('s1');
  });

  it('红线：partial_output 绝不喂 es.replayEvent（喂了就是「实时一条 + 历史一条」重复）', async () => {
    mockFetch(partialHandler([partialEvent({ text: '半截', chunks: 3, truncated: true })]));
    const store = useWorkbenchStore();
    const seen: string[] = [];
    const original = store.es.replayEvent;
    store.es.replayEvent = ((raw: RunHistoryEvent) => { seen.push(raw.type); return original(raw); }) as typeof original;
    await store.openSession('s1');
    expect(seen).toEqual([]); // 一条都没喂
    expect(store.entries.filter((e) => e.kind === 'partial')).toHaveLength(1);
    // 分流不影响真实事件：白名单事件照旧走 replayEvent
    store.es.replayEvent = original;
  });

  it('truncated=true 透传到 entry（文案由 StreamPanel 出，store 不拼字符串）', async () => {
    mockFetch(partialHandler([partialEvent({ text: '很长的半截', chunks: 900, truncated: true })]));
    const store = useWorkbenchStore();
    await store.openSession('s1');
    const [en] = store.entries.filter((e) => e.kind === 'partial');
    expect(en && en.kind === 'partial' && en.truncated).toBe(true);
    expect(en && en.kind === 'partial' && en.text).toBe('很长的半截'); // 没被塞进「…（已截断）」文案
  });

  it('同 run 有锚点（DTO 里已带 assistant 消息）⇒ 历史里就没有合成项，正文只出现一次', async () => {
    // 后端判据「有锚点 ⇒ 不合成」；前端这一例钉住后果：有锚点的会话里 partial entry 数为 0，
    // 正文只有 DTO 那一条（重复正文就是这个坑）。
    mockFetch(partialHandler(
      [{ seq: 8, run_id: 'r-done', type: 'tool_use', payload: { tool_call_id: 'c9', name: 'bash', input: {} } }],
      [
        { id: 'm1', role: 'user', content: '任务', seq: 1 },
        { id: 'm2', role: 'assistant', content: '完整终稿', seq: 9, run_id: 'r-done' },
      ],
    ));
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(store.entries.filter((e) => e.kind === 'partial')).toHaveLength(0);
    const texts = store.entries.filter((e) => e.kind === 'msg').map((e) => (e as { text: string }).text);
    expect(texts).toEqual(['任务', '完整终稿']);
  });

  it.each([
    ['缺 text 键', { chunks: 2, truncated: false }],
    ['text 是对象', { text: { a: 1 }, chunks: 2, truncated: false }],
    ['text 是数字', { text: 42, chunks: 2, truncated: false }],
    ['payload 整个是 null 形状', { text: null, truncated: null }],
  ])('脏载荷：%s ⇒ 不出现 undefined/[object Object]，也不产出空气泡', async (_label, payload) => {
    mockFetch(partialHandler([partialEvent(payload as Record<string, unknown>)]));
    const store = useWorkbenchStore();
    await store.openSession('s1');
    const dumped = JSON.stringify(store.entries.map((e) => ('text' in e ? e.text : e.kind)));
    expect(dumped).not.toContain('[object Object]');
    expect(dumped).not.toContain('undefined');
    for (const en of store.entries) {
      if (en.kind === 'partial') expect(en.text).not.toBe(''); // 脏到没正文 ⇒ 干脆不推 entry
    }
  });

  it('同一条合成项重进会话/重开只渲染一次（id=partial:<run_id> 走 renderedIds 幂等）', async () => {
    mockFetch(partialHandler([partialEvent({ text: '半截', chunks: 1, truncated: false })]));
    const store = useWorkbenchStore();
    await store.openSession('s1');
    await store.openSession('s1');
    expect(store.entries.filter((e) => e.kind === 'partial')).toHaveLength(1);
  });

  it('run_id 缺失的脏合成项 ⇒ 仍不炸，且正文正常（id 退化到 partial:unknown）', async () => {
    mockFetch(partialHandler([{ seq: 3, run_id: null, type: 'partial_output', payload: { text: '没有 run 归属' } }]));
    const store = useWorkbenchStore();
    await store.openSession('s1');
    const [en] = store.entries.filter((e) => e.kind === 'partial');
    expect(en && en.kind === 'partial' && en.text).toBe('没有 run 归属');
  });
});

// ===========================================================================
// issue #279（投影路径）：DTO 的 `toolCalls[]` 在**同一个 run 里跨轮复用 provider id** 时，
// 卡片身份必须靠「上游投影键自带的轮号段」分开（`call.key = "<round>#<record>:<entry>:t<i>"`）。
// 这里同时钉住本单最贵的回归：**实时/历史事件卡片与刷新后的投影卡片必须归并成同一张**
// （两路轮号同源：事件侧观测 round_start.round，投影侧取 call.key 前缀，都是引擎同一个轮计数器）。
// ===========================================================================
describe('issue #279：DTO 投影路径的卡片身份含轮号（刷新后不并卡、也不翻倍）', () => {
  /** 一个 run 两轮、同 provider id、不同工具名（真机 id 复用的形状）。 */
  const twoRoundMessage = {
    id: 'm2', role: 'assistant', content: '完成', seq: 6, run_id: 'r1',
    toolCalls: [
      { key: '1#0:0:t0', name: 'readFile', id: 'c1', argsSummary: 'path=a.txt', resultPreview: 'FILE A', durationMs: 12 },
      { key: '2#0:0:t0', name: 'edit', id: 'c1', argsSummary: 'path=a.txt oldText=x', resultPreview: 'conflict', isError: true, durationMs: 7 },
    ],
  };

  it('仅凭 DTO（无事件）：同一个 id 两轮 ⇒ **两张卡**、名字各自正确、结果各自独立', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [], next_cursor: null } };
      if (url.includes('/api/sessions/s1')) {
        return {
          status: 200,
          body: { session: { id: 's1', active_run_id: null }, messages: [twoRoundMessage], last_seq: 6 },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect([...store.es.toolCards.keys()]).toEqual(['r1:1:c1', 'r1:2:c1']);
    expect(store.es.toolCards.get('r1:1:c1')!.name).toBe('readFile');
    expect(store.es.toolCards.get('r1:2:c1')!.name).toBe('edit');
    expect(store.es.toolCards.get('r1:1:c1')!.ok).toBe(true);
    expect(store.es.toolCards.get('r1:2:c1')!.ok).toBe(false);
    expect(store.es.toolCards.get('r1:2:c1')!.resultPreview).toBe('conflict');
    expect(store.entries.filter((e) => e.kind === 'tool')).toHaveLength(2);
  });

  it('历史事件 + DTO 同场：两条路**归并成同样两张**（既不并成一张，也不演成四张）', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) {
        return {
          status: 200,
          body: {
            events: [
              { seq: 2, run_id: 'r1', type: 'round_start', payload: { round: 1 } },
              { seq: 3, run_id: 'r1', type: 'tool_use', payload: { tool_call_id: 'c1', name: 'readFile', input: { path: 'a.txt' } } },
              { seq: 4, run_id: 'r1', type: 'tool_result', payload: { tool_call_id: 'c1', ok: true, result_digest: 'file A', duration_ms: 12 } },
              { seq: 5, run_id: 'r1', type: 'round_start', payload: { round: 2 } },
              { seq: 6, run_id: 'r1', type: 'tool_use', payload: { tool_call_id: 'c1', name: 'edit', input: { path: 'a.txt', oldText: 'x' } } },
            ],
            next_cursor: null,
          },
        };
      }
      if (url.includes('/api/sessions/s1')) {
        return {
          status: 200,
          body: { session: { id: 's1', active_run_id: null }, messages: [twoRoundMessage], last_seq: 6 },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    // 身份两张（不是四张、也不是一张）；占位也只两次 ⇒ StreamPanel 只会画两张卡
    expect([...store.es.toolCards.keys()]).toEqual(['r1:1:c1', 'r1:2:c1']);
    expect(store.entries.filter((e) => e.kind === 'tool')).toHaveLength(2);
    // 事件侧字段（args/out/dur）保留，投影侧只补缺（#283「实时优先」口径不因本单改变）
    expect(store.es.toolCards.get('r1:1:c1')!.args).toBe('{"path":"a.txt"}');
    expect(store.es.toolCards.get('r1:1:c1')!.argsSummary).toBe('path=a.txt');
    expect(store.es.toolCards.get('r1:1:c1')!.dur).toBe(12);
    expect(store.es.toolCards.get('r1:2:c1')!.name).toBe('edit');
    expect(store.es.toolCards.get('r1:2:c1')!.args).toBe('{"path":"a.txt","oldText":"x"}');
    expect(store.es.toolCards.get('r1:2:c1')!.resultPreview).toBe('conflict');
    expect(store.es.toolCards.get('r1:2:c1')!.ok).toBe(false); // 第二轮的 isError 不得写进第一轮那张
  });

  it('provider id 缺失的两轮调用：上游 `call.key` 本身含轮号 ⇒ 仍各一张（§8.5 形状不回归）', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [], next_cursor: null } };
      if (url.includes('/api/sessions/s1')) {
        return {
          status: 200,
          body: {
            session: { id: 's1', active_run_id: null },
            last_seq: 6,
            messages: [{
              id: 'm2', role: 'assistant', content: '完成', seq: 6, run_id: 'r1',
              toolCalls: [{ key: '1#0:0:t0', name: 'readFile' }, { key: '2#0:0:t0', name: 'edit' }],
            }],
          },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect([...store.es.toolCards.keys()]).toEqual(['1#0:0:t0', '2#0:0:t0']);
    expect(store.es.toolCards.get('2#0:0:t0')!.name).toBe('edit');
  });

  it('id/key 都缺 ⇒ `proj:<消息 id>:<序号>` 兜底仍在（两条各一张，序号不同）', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [], next_cursor: null } };
      if (url.includes('/api/sessions/s1')) {
        return {
          status: 200,
          body: {
            session: { id: 's1', active_run_id: null },
            last_seq: 6,
            messages: [{
              id: 'm2', role: 'assistant', content: '完成', seq: 6, run_id: 'r1',
              toolCalls: [{ name: 'readFile' }, { name: 'edit' }],
            }],
          },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect([...store.es.toolCards.keys()]).toEqual(['proj:m2:0', 'proj:m2:1']);
    expect(store.es.toolCards.get('proj:m2:1')!.name).toBe('edit');
  });

  // 变异取证补的用例：把 mergeTargetByAlias 的「跨 run 不归并」守卫删掉时，原先 623 条**全绿**
  // （变异没红有两种成因：覆盖真有缺口 / 变异是空操作。这里实测它**会**改变行为 ⇒ 属覆盖缺口，补上）。
  it('归并兜底**不跨 run**：别的 run 留下的同 id 卡片不许接走本 run 的投影字段', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) {
        return {
          status: 200,
          body: {
            events: [
              // 上一个 run 的同名调用（provider id 复用，且这批事件没有 round_start ⇒ 键是 `rA:c1`）
              { seq: 2, run_id: 'rA', type: 'tool_use', payload: { tool_call_id: 'c1', name: 'readFile', input: {} } },
            ],
            next_cursor: null,
          },
        };
      }
      if (url.includes('/api/sessions/s1')) {
        return {
          status: 200,
          body: {
            session: { id: 's1', active_run_id: null },
            last_seq: 6,
            messages: [{
              id: 'm2', role: 'assistant', content: '完成', seq: 6, run_id: 'rB',
              toolCalls: [{ name: 'edit', id: 'c1', argsSummary: 'path=a.txt', resultPreview: 'B 的预览' }],
            }],
          },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect([...store.es.toolCards.keys()]).toEqual(['rA:c1', 'rB:c1']);
    // 投影字段只落在**本 run** 那张上；`rA:c1` 一个字都不许被隔壁 run 的投影改写
    expect(store.es.toolCards.get('rB:c1')!.resultPreview).toBe('B 的预览');
    expect(store.es.toolCards.get('rA:c1')!.resultPreview).toBeUndefined();
    expect(store.es.toolCards.get('rA:c1')!.name).toBe('readFile');
    expect(store.entries.filter((e) => e.kind === 'tool')).toHaveLength(2);
  });

  it('投影键缺轮号（上游写 `?` 或形状不符）⇒ 键退化成 `r1:c1`，**不伪造轮号**', async () => {
    mockFetch((url) => {
      if (url.includes('/events/history')) return { status: 200, body: { events: [], next_cursor: null } };
      if (url.includes('/api/sessions/s1')) {
        return {
          status: 200,
          body: {
            session: { id: 's1', active_run_id: null },
            last_seq: 6,
            messages: [{
              id: 'm2', role: 'assistant', content: '完成', seq: 6, run_id: 'r1',
              toolCalls: [{ key: '?#0:0:t0', name: 'readFile', id: 'c1' }],
            }],
          },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect([...store.es.toolCards.keys()]).toEqual(['r1:c1']);
  });
});

// ===========================================================================
// issue #306：点「停止」的那一刻就该看到部分正文，不必刷新一次。
// `partial_output` **只在 GET /events/history 的响应期合成**（docs/api/portal.md §4.4a-1：不落库、
// 不进 SSE），而此前只有 openSession 拉过 history ⇒ 终态后界面只有 run_end 分隔行。
// 这里钉三件事：①失败/中止终态补拉**恰好一次**且**不重复渲染**；②成功收尾**零重拉**（成本红线：
// dev 一个会话 14.4 万条事件）；③补拉失败**静默**（不许漏未捕获拒绝、不许弄坏终态 UI）。
// ===========================================================================
describe('issue #306：终态后补拉 history（partial_output 当场出现，成功收尾零重拉）', () => {
  /** 最近一个 FakeEventSource（本文件里 lastES 定义在 #261B 那组的 describe 内，作用域够不到这里）。 */
  function lastES() {
    return FakeEventSource.instances.at(-1)!;
  }

  const partialEv = (text: string, runId = 'r1', seq = 8) => ({
    seq, run_id: runId, type: 'partial_output', payload: { text, chunks: 3, truncated: false },
  });

  /** 二次以后才给出合成项（= 后端只在 run 终态后才合成，首次打开时确实拿不到）。 */
  function stage(opts: { laterEvents?: unknown[]; failRepull?: boolean } = {}) {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      if (url.includes('/api/sessions/s1/events/history')) {
        const n = calls.filter((u) => u.includes('/events/history')).length;
        if (n > 1 && opts.failRepull) return { status: 500, body: { code: 'internal', message: 'boom' } };
        return { status: 200, body: { events: n > 1 ? (opts.laterEvents ?? [partialEv('已经做了一半')]) : [], next_cursor: null } };
      }
      if (url.includes('/api/sessions/s1')) {
        return {
          status: 200,
          body: { session: { id: 's1', active_run_id: 'r1' }, messages: [], last_seq: 7 },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    return { calls, historyCalls: () => calls.filter((u) => u.includes('/events/history')).length };
  }

  const settle = async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  const partials = (store: ReturnType<typeof useWorkbenchStore>) => store.entries.filter((e) => e.kind === 'partial');

  it('run_end(aborted) ⇒ 补拉**恰好一次** history，合成项当场出现且**只有一条**', async () => {
    const stage_ = stage();
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(stage_.historyCalls()).toBe(1); // 打开会话只拉一次
    expect(partials(store)).toHaveLength(0); // 首拉时后端还没合成 ⇒ 界面确实没有（缺陷现场）

    lastES().emit('run_end', { seq: 9, run_id: 'r1', termination: { reason: 'aborted' } });
    await settle();
    expect(stage_.historyCalls()).toBe(2); // 恰一次补拉（窗口参数不变 ⇒ 同一个 URL，不加 limit）
    expect(partials(store)).toHaveLength(1);
    const [en] = partials(store);
    expect(en && en.kind === 'partial' && en.text).toBe('已经做了一半');
    expect(en && en.kind === 'partial' && en.id).toBe('partial:r1');
  });

  it('幂等：再来一次失败终态也不会出第二条（同一份 renderedIds）', async () => {
    const stage_ = stage();
    const store = useWorkbenchStore();
    await store.openSession('s1');
    lastES().emit('run_end', { seq: 9, run_id: 'r1', termination: { reason: 'aborted' } });
    await settle();
    expect(partials(store)).toHaveLength(1);
    store.es.activeRunId = 'r2';
    lastES().emit('run_end', { seq: 10, run_id: 'r2', termination: { reason: 'aborted' } });
    await settle();
    expect(stage_.historyCalls()).toBe(3); // 又补拉了一次（同一 run 的合成项不会因此重复）
    expect(partials(store)).toHaveLength(1);
  });

  it('集合驱动，不只认 aborted：failed / persistence_failed 也补拉', async () => {
    for (const reason of ['failed', 'persistence_failed', 'max_rounds_cap', 'final_guard_unverified']) {
      const stage_ = stage();
      const store = useWorkbenchStore();
      await store.openSession('s1');
      lastES().emit('run_end', { seq: 9, run_id: 'r1', termination: { reason } });
      await settle();
      expect(stage_.historyCalls(), `reason=${reason} 属 RUN_FAIL_REASONS ⇒ 必须补拉`).toBe(2);
      expect(partials(store).length, `reason=${reason}`).toBe(1);
    }
  });

  it('成本红线：成功收尾（end_turn / judge_done / no_tool）与集合外的截断态 ⇒ **零重拉**', async () => {
    for (const reason of ['end_turn', 'judge_done', 'no_tool', 'stall', 'continuation_exhausted']) {
      const stage_ = stage();
      const store = useWorkbenchStore();
      await store.openSession('s1');
      lastES().emit('run_end', { seq: 9, run_id: 'r1', termination: { reason } });
      await settle();
      expect(stage_.historyCalls(), `reason=${reason} 不在 RUN_FAIL_REASONS ⇒ 一次 history 都不许多打`).toBe(1);
      expect(partials(store)).toHaveLength(0);
    }
  });

  it('缺 termination（旧帧/脏载荷）⇒ 按「不是失败」处理，零重拉', async () => {
    const stage_ = stage();
    const store = useWorkbenchStore();
    await store.openSession('s1');
    lastES().emit('run_end', { seq: 9, run_id: 'r1' });
    await settle();
    expect(stage_.historyCalls()).toBe(1);
  });

  it('补拉失败 ⇒ 静默：漏不出未捕获拒绝，终态 UI（run_end 分隔行 / 停止按钮态）不受影响', async () => {
    const leaked: unknown[] = [];
    const hook = (reason: unknown) => { leaked.push(reason); };
    process.on('unhandledRejection', hook);
    try {
      const stage_ = stage({ failRepull: true });
      const store = useWorkbenchStore();
      await store.openSession('s1');
      lastES().emit('run_end', { seq: 9, run_id: 'r1', termination: { reason: 'aborted', detail: 'stopped by user' } });
      await settle();
      expect(stage_.historyCalls()).toBe(2); // 确实试过了
      expect(partials(store)).toHaveLength(0); // 没拿到就维持现状（不推空气泡）
      // 终态面照常：issue #236 起 `aborted` 走**中性分隔条**（母语「已中止」，用户按停止不是故障），
      // 不再是红色 syserr——分级口径在 `lib/terminationReasons.ts` 的 RUN_TERMINATION_SYSERR_REASONS。
      const termLines = store.entries.filter((e) => e.kind === 'sep' && e.text.includes('run 结束'));
      expect(termLines).toHaveLength(1);
      expect(termLines.map((e) => ('text' in e ? e.text : '')).join('\n')).toContain('已中止');
      expect(store.entries.filter((e) => e.kind === 'syserr')).toHaveLength(0);
      expect(store.es.activeRunId).toBeNull(); // 运行态状态机照常收尾（store 代理上 ref 已解包，不能 .value）
      expect(leaked.map(String), `漏出 ${leaked.length} 条未捕获拒绝`).toEqual([]);
    } finally {
      process.off('unhandledRejection', hook);
    }
  });

  it('没有幂等集（renderedIds=null）⇒ 不补拉：宁可不补，也不能重复渲染', async () => {
    const stage_ = stage();
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(stage_.historyCalls()).toBe(1);
    // 唯一变量就是幂等集：会话还在（sessionId 有值），但去重集被摘掉（selectDir/resetSessionView 的态）
    // ⇒ 少了这道闸，这里就会白打一次请求并**每次都新推一条** partial（没有去重集可用）。
    store.renderedIds = null;
    store.repullHistorySynthItems({ termination: { reason: 'aborted' } } as never);
    await settle();
    expect(stage_.historyCalls()).toBe(1);
    expect(partials(store)).toHaveLength(0);
  });

  it('补拉复用同一个 URL（**不为了拿合成项放大 limit**）', async () => {
    const stage_ = stage();
    const store = useWorkbenchStore();
    await store.openSession('s1');
    lastES().emit('run_end', { seq: 9, run_id: 'r1', termination: { reason: 'aborted' } });
    await settle();
    const urls = stage_.calls.filter((u) => u.includes('/events/history'));
    expect(urls[1]).toBe(urls[0]); // 窗口参数逐字相同
    expect(urls[0]).not.toMatch(/limit=|before=/);
  });

  it('迟到响应：补拉回来时已换会话 ⇒ 丢弃（不把上一个会话的部分正文推进当前流）', async () => {
    // ⚠ 不能用本文件的 mockFetch：它把 handler 的返回值**同步解构**成 {status, body}，给它一个
    // Promise 会被解成 {undefined, undefined} ⇒ 响应形同失败，守卫根本没被经过（变异试过，全绿）。
    // 所以这里自己 stub 一个可 await 的 fetch，让**补拉那一次**真的挂到换会话之后才回来。
    let fire: (() => void) | null = null;
    let s1HistoryCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/sessions/s1/events/history')) {
        s1HistoryCalls += 1;
        if (s1HistoryCalls === 2) {
          await new Promise<void>((r) => { fire = r; }); // 卡住：等用户切走之后再回来
          return jsonResponse(200, { events: [partialEv('上一个会话的半截', 'r1')], next_cursor: null });
        }
        return jsonResponse(200, { events: [], next_cursor: null }); // 首拉：还没有合成项
      }
      if (url.includes('/api/sessions/s2')) {
        return jsonResponse(200, { session: { id: 's2', active_run_id: null }, messages: [], last_seq: 1 });
      }
      if (url.includes('/api/sessions/s1')) {
        return jsonResponse(200, { session: { id: 's1', active_run_id: 'r1' }, messages: [], last_seq: 7 });
      }
      return jsonResponse(200, { items: [] });
    }));
    const store = useWorkbenchStore();
    await store.openSession('s1');
    lastES().emit('run_end', { seq: 9, run_id: 'r1', termination: { reason: 'aborted' } });
    await settle();
    expect(s1HistoryCalls, '补拉请求必须真的发出去过（否则这条用例什么都没测）').toBe(2);
    expect(fire, '补拉必须还挂在途上（已经回来就测不到代次守卫）').toBeTypeOf('function');
    // 顺序是关键：**先换会话**（s2 的幂等集是全新的，`partial:r1` 不在里面），再让补拉的响应回来。
    // 反过来做的话 openSession('s2') 自己就把 entries 清空了 ⇒ 迟到的那条被顺手抹掉，守卫没被经过。
    await store.openSession('s2');
    // 断言已经证明它是个函数；这里的一次显式收窄只是喂 vue-tsc —— `fire` 的赋值发生在 fetch 桩的
    // 闭包里，vue-tsc 不追踪跨闭包赋值，会在调用点把它窄成 `null`（TS2349 never）。**不是**放宽断言。
    (fire as (() => void) | null)?.();
    await settle();
    expect(store.sessionId).toBe('s2');
    expect(partials(store)).toHaveLength(0); // 守卫生效：不把 s1 的部分正文推进 s2 的流
  });
});

// ===========================================================================
// issue #236 §1 第 2 条：刷新 / 重开会话后，**终态分隔条**从 run 终态字段投影出来
//   （历史端点响应期合成项 `run_termination`；`run_end` 仍不进两个白名单集合）。
//   验收面：aborted ⇒ 一条**中性**分隔条写母语「已中止」；failed ⇒ 红色；硬刷新后仍在且不重复。
// ===========================================================================
describe('issue #236：历史投影的终态分隔条（run_termination）', () => {
  function lastES() {
    return FakeEventSource.instances.at(-1)!;
  }

  const termEv = (reason: string, runId = 'r1', seq = 9, extra: Record<string, unknown> = {}) => ({
    seq, run_id: runId, type: 'run_termination', payload: { status: 'finished', termination: { reason, ...extra } },
  });

  /** openSession 的 history 响应固定带某几条合成项（模拟「后端从 runs 终态投影」）。 */
  function stage(events: unknown[] = [], opts: { laterEvents?: unknown[]; activeRunId?: string | null } = {}) {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      if (url.includes('/api/sessions/s1/events/history')) {
        const n = calls.filter((u) => u.includes('/events/history')).length;
        return { status: 200, body: { events: n > 1 ? (opts.laterEvents ?? events) : events, next_cursor: null } };
      }
      if (url.includes('/api/sessions/s1')) {
        return {
          status: 200,
          body: { session: { id: 's1', active_run_id: opts.activeRunId ?? null }, messages: [], last_seq: 9 },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    return { calls, historyCalls: () => calls.filter((u) => u.includes('/events/history')).length };
  }

  const settle = async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  const textOf = (e: StreamEntry) => ('text' in e ? e.text : '');
  const sepTexts = (store: ReturnType<typeof useWorkbenchStore>) =>
    store.entries.filter((e) => e.kind === 'sep').map(textOf);
  const sysErrTexts = (store: ReturnType<typeof useWorkbenchStore>) =>
    store.entries.filter((e) => e.kind === 'syserr').map(textOf);

  it('aborted：重开会话 ⇒ **一条中性**分隔条写母语「已中止」（不是红色 syserr，不是裸英文）', async () => {
    stage([termEv('aborted')]);
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(sepTexts(store)).toEqual(['run 结束：aborted — 已中止']);
    expect(sysErrTexts(store)).toEqual([]); // 用户按停止不是故障
  });

  it('failed 类：仍走红色 syserr（**没有把红色降级成中性**，AGENTS §8.7 的判据）', async () => {
    for (const reason of ['failed', 'persistence_failed', 'final_guard_unverified', 'max_rounds_cap']) {
      stage([termEv(reason)]);
      const store = useWorkbenchStore();
      await store.openSession('s1');
      expect(sysErrTexts(store).length, `reason=${reason} 必须是红色`).toBe(1);
      expect(sepTexts(store)).toEqual([]);
    }
  });

  it('幂等：同一响应里同一 run 出现两次 / 重进会话 ⇒ 一条 run 至多一条分隔条', async () => {
    stage([termEv('aborted', 'r1', 9), termEv('aborted', 'r1', 10)]);
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(sepTexts(store)).toHaveLength(1);
    await store.openSession('s1'); // 重进会话：renderedIds 重建，仍是同一条
    expect(sepTexts(store)).toHaveLength(1);
  });

  it('实时与历史不给两张：先实时 run_end、再补拉 history（同一 run）⇒ 只有实时那一条', async () => {
    // 首拉没有合成项（run 还在跑），补拉时后端才给出同一 run 的终态项。
    const stage_ = stage([], { laterEvents: [termEv('aborted', 'r1')], activeRunId: 'r1' });
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(sepTexts(store)).toEqual([]);
    lastES().emit('run_end', { seq: 9, run_id: 'r1', termination: { reason: 'aborted' } });
    await settle();
    expect(stage_.historyCalls()).toBe(2); // #306 的补拉照旧（#236 没新增请求）
    expect(sepTexts(store)).toEqual(['run 结束：aborted — 已中止']); // 实时那一条，历史项被去重
  });

  it('脏载荷：无 run_id / 无 termination.reason / 非对象 ⇒ 一条都不出（不编 reason）', async () => {
    stage([
      { seq: 1, run_id: null, type: 'run_termination', payload: { termination: { reason: 'aborted' } } },
      { seq: 2, run_id: 'r2', type: 'run_termination', payload: { status: 'finished' } },
      { seq: 3, run_id: 'r3', type: 'run_termination', payload: { termination: { reason: 42 } } },
      { seq: 4, run_id: 'r4', type: 'run_termination', payload: { termination: null } },
    ]);
    const store = useWorkbenchStore();
    await store.openSession('s1');
    expect(sepTexts(store)).toEqual([]);
    expect(sysErrTexts(store)).toEqual([]);
  });

  it('合成项**不喂 replayEvent**：不会被当成实时 run_end 关掉运行态 / 也不推进水位线', async () => {
    stage([termEv('aborted', 'r1', 42)]);
    const store = useWorkbenchStore();
    await store.openSession('s1');
    // 合成项的 seq 不参与 lastSeq（那是 messages/last_seq 的口径，openSession 用详情里的 last_seq）
    // ⚠ store 代理上的 ref 已解包（见 #261B 那组的同一条注），不能写 `.value`
    expect(store.es.lastSeq).toBe(9);
    expect(store.es.activeRunId).toBeNull(); // 会话详情说没有活跃 run
    expect(store.es.toolCards.size).toBe(0);
  });
});

describe('流式增量气泡响应性（打字机效果回归）', () => {
  // bug 回归：deltaEntry 曾是 push 进响应式数组前的 raw 对象，watch 回调直接 mutate raw
  // 不触发渲染 → StreamPanel 不逐段更新，打字机效果丢失（文字等下一次 entries 结构变更
  // 才"顺带"出现）。修复 = push 后从数组取回 reactive proxy 再持有。
  // 断言方式：用 vue effect 订阅 delta 条目的 text，每收到一帧 assistant_delta 必须重跑一次。
  beforeEach(() => {
    mockFetch((url) => {
      if (url.endsWith('/events/history')) return { status: 200, body: { events: [] } };
      if (url.split('?')[0] === '/api/sessions/s1') {
        return { status: 200, body: { session: { id: 's1', active_run_id: null }, messages: [], last_seq: 0 } };
      }
      return { status: 200, body: { items: [] } };
    });
  });

  it('每帧 assistant_delta 都触发依赖 text 的 effect 重跑（raw mutate 不触发 → 本用例会红）', async () => {
    const { effect, nextTick } = await import('vue');
    const store = useWorkbenchStore();
    await store.openSession('s1');
    const es = FakeEventSource.instances.at(-1)!;

    es.emit('assistant_delta', { seq: 1, text: 'a' });
    await nextTick(); // 首帧建气泡（watch 回调）
    const bubble = store.entries.find((e) => e.kind === 'delta') as { kind: 'delta'; text: string } | undefined;
    expect(bubble).toBeTruthy();

    const texts: string[] = [];
    let runs = 0;
    const stop = effect(() => { texts.push(bubble!.text); runs++; });
    const baseline = runs; // effect 首次自跑一次

    es.emit('assistant_delta', { seq: 2, text: 'b' });
    await nextTick();
    es.emit('assistant_delta', { seq: 3, text: 'c' });
    await nextTick();

    expect(bubble!.text).toBe('abc');
    // 两帧增量 = 两次响应式更新（raw mutate 下 runs 会停在 baseline）
    expect(runs - baseline).toBeGreaterThanOrEqual(2);
    expect(texts.slice(-2)).toEqual(['ab', 'abc']);
    stop();
  });

  it('tool_call_delta 增量落到卡片并触发响应式更新（行为钉住；toolCards 同源 raw mutate 隐患修）', async () => {
    const { effect, nextTick } = await import('vue');
    const store = useWorkbenchStore();
    await store.openSession('s1');
    const es = FakeEventSource.instances.at(-1)!;

    es.emit('tool_use', { seq: 1, tool_call_id: 'c1', name: 'shell', input: {} });
    await nextTick();
    const card = store.es.toolCards.get('c1')!;
    let runs = 0;
    const stop = effect(() => { void card.args; runs++; });
    const baseline = runs;

    es.emit('tool_call_delta', { seq: 2, tool_call_id: 'c1', arguments_delta: '{"com' });
    await nextTick();
    es.emit('tool_call_delta', { seq: 3, tool_call_id: 'c1', arguments_delta: 'mand' });
    await nextTick();

    expect(card.args).toContain('{"com');
    expect(runs - baseline).toBeGreaterThanOrEqual(2);
    stop();
  });
});

// ---- issue #428：换账号的全量复位 ----
// 病根：登出只清 auth store + router.replace('/login')（SPA 不重载页面），本 store 是全局单例 ⇒
// 上一个账号的消息流 / 目录 / 会话 / 草稿 / SSE 原样活到下一个账号，「切换用户后首页对话窗口里
// 还是上一个账户的对话」。`resetSessionView()` 救不了：它唯一的自动触发点没有 immediate，重新登录
// 挂载时 route.params.id 恒为 undefined ⇒ 回调不跑。
describe('#428 换账号复位（claimOwnership / resetForUserSwitch）', () => {
  /** 目录 + 会话详情 + 历史的最小完整桩（openSession 需要三端点齐）。 */
  function userHandler(dirName: string) {
    return (url: string) => {
      if (url.startsWith('/api/dirs')) {
        return { status: 200, body: { dirs: [{ name: dirName, cwd: `~/projects/${dirName}`, running_count: 0, queued_count: 0 }] } };
      }
      if (url.includes('/events/history')) return { status: 200, body: { events: [], next_cursor: null } };
      if (url.includes('/api/sessions/s1')) {
        return {
          status: 200,
          body: {
            session: { id: 's1', active_run_id: null, message_count: 1 },
            messages: [{ id: 'm1', role: 'user', content: '上一个账号的对话', seq: 1 }],
            last_seq: 1,
          },
        };
      }
      return { status: 200, body: { items: [] } };
    };
  }

  /** 把 store 灌成「A 正在用」的样子（含挂载时的认领）：目录 + 会话 + 消息流 + SSE + 草稿 + 队列。 */
  async function seedAsUserA(store: ReturnType<typeof useWorkbenchStore>) {
    mockFetch(userHandler('alpha'));
    store.claimOwnership('u1'); // WorkbenchView.onMounted 的第一步（真实流程里恒发生在灌数据之前）
    await store.initWorkspace();
    await store.openSession('s1');
    store.inputValue = '打了一半的话';
    store.saveDraft();
    store.applyQueueSnapshot({ steering: [{ id: 'q1', content: '排队里的话' } as never], follow_up: [] });
  }

  it('身份变化：消息流/会话/目录/草稿/队列全清，SSE 关闭', async () => {
    const store = useWorkbenchStore();
    await seedAsUserA(store);
    // 前置自检：A 的状态确实建起来了（否则下面的断言是空对空）
    expect(store.entries.length).toBeGreaterThan(0);
    expect(store.sessionId).toBe('s1');
    expect(store.dirCwd).toBe('~/projects/alpha');
    expect(store.queuedCount).toBe(1);
    const connection = FakeEventSource.instances.at(-1)!;
    expect(connection.closed).toBe(false);

    expect(store.claimOwnership('u2')).toBe(true); // A → B：复位发生

    expect(store.entries).toEqual([]); // 对话窗口的内容不再属于下一个账号
    expect(store.sessionId).toBeNull();
    expect(store.sessionMessageCount).toBeNull();
    expect(store.dirs).toEqual([]);
    expect(store.dirCwd).toBeNull(); // 目录 cwd 是上一个账号家目录下的路径 ⇒ 同样跨账号
    expect(store.sessions).toEqual([]);
    expect(store.noDir).toBe(true);
    expect(store.inputValue).toBe('');
    expect(store.queuedCount).toBe(0);
    expect(store.lastSend).toBeNull();
    expect(store.retryAvailable).toBe(false);
    expect(store.olderMessagesCursor).toBeNull();
    expect(store.es.toolCards.size).toBe(0);
    expect(connection.closed).toBe(true); // 连接本身必须断：否则带着 A 的会话继续收帧
  });

  it('旁路面（#431 对账补钉）：动量状态机与工具卡片展开记忆（**模块级 Set**，最容易漏的一类）', async () => {
    const store = useWorkbenchStore();
    await seedAsUserA(store);
    store.momentum.beginRun('r-mom');
    setToolCallExpanded('c1', true);
    expect(store.momentum.state.runId).toBe('r-mom'); // 前置自检：真的灌进去了
    expect(isToolCallExpanded('c1')).toBe(true);

    store.resetForUserSwitch();

    expect(store.momentum.state.runId, '#282 的动量数字不得活到下一个账号').toBeNull();
    expect(isToolCallExpanded('c1'), '#85 的展开记忆是模块级 Set，跨 store 实例共享').toBe(false);
  });

  it('同一身份重复认领不清（同一个人重挂载不是换账号）', async () => {
    const store = useWorkbenchStore();
    await seedAsUserA(store);
    expect(store.claimOwnership('u1')).toBe(false); // seed 里已认领过 u1 ⇒ 同身份不再复位
    expect(store.entries.length).toBeGreaterThan(0);
    expect(store.sessionId).toBe('s1');
    expect(store.claimOwnership('u1')).toBe(false);
    expect(store.entries.length).toBeGreaterThan(0);
  });

  it('登出（claimOwnership(null)）后**同一账号**再登录也复位——草稿不得按会话 id 复活', async () => {
    const store = useWorkbenchStore();
    await seedAsUserA(store);
    expect(store.claimOwnership(null)).toBe(true); // onLogout
    // 同一个人重新登录：认领同 id 之前先经过 null，故这里必须是一次全新复位后的状态
    expect(store.claimOwnership('u1')).toBe(true);
    expect(store.entries).toEqual([]);
    mockFetch(userHandler('alpha'));
    // 关键用例：草稿按 sessionId 键 ⇒ 只有 `drafts.clear()` 能挡住「重开后恢复出上一个账号的半句话」
    await store.openSession('s1');
    expect(store.inputValue).toBe('');
  });

  it('复位后上一账号那次在途 /api/dirs 的迟到响应不得覆盖界面', async () => {
    const DIR_B = { name: 'beta', cwd: '~/projects/beta', running_count: 0, queued_count: 0 };
    let resolveLate: (r: Response) => void = () => {};
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      calls += 1;
      // 第一次（A 的在途请求）挂住，第二次（B 的）立刻返回
      if (calls === 1) return new Promise<Response>((res) => { resolveLate = res; });
      return Promise.resolve(jsonResponse(200, { dirs: [DIR_B] }));
    }));
    const store = useWorkbenchStore();
    const late = store.loadDirs(); // A 的请求在途
    store.resetForUserSwitch(); // 撞开 dirsReqSeq
    await store.loadDirs(); // B 的目录回来并落地
    expect(store.dirs.map((d) => d.name)).toEqual(['beta']);
    resolveLate(jsonResponse(200, { dirs: [{ name: 'alpha', cwd: '~/projects/alpha', running_count: 0, queued_count: 0 }] }));
    await late;
    expect(store.dirs.map((d) => d.name)).toEqual(['beta']); // A 的迟到响应被守卫丢弃
  });
});

// ---- issue #431：#428 声称「在途响应全部作废」，本片把漏掉的三条路径补上守卫 ----
// 病根形状都一样：`await` 之后不看代次就写界面。窗口 = 「A 的操作在途 → 登出 → B 秒登录 →
// A 的回包最后落地」。第四条（`loadFoldedOriginal`）**故意不加守卫**，理由写在源码注释里。
describe('#431 迟到写回的三条守卫（createDir / recallQueue / stop）', () => {
  const DIR_B = { name: 'beta', cwd: '~/projects/beta', running_count: 0, queued_count: 0 };

  /** 会话详情 + 历史（openSession 用）+ 目录（B 的）；POST/DELETE 由各用例自己接管。 */
  function sessionHandler(url: string, init?: RequestInit) {
    if (url.startsWith('/api/dirs')) return jsonResponse(200, { dirs: [DIR_B] });
    if (url.includes('/events/history')) return jsonResponse(200, { events: [], next_cursor: null });
    if (url.includes('/api/sessions/s1') && init?.method !== 'DELETE') {
      return jsonResponse(200, {
        session: { id: 's1', active_run_id: null, message_count: 1 },
        messages: [{ id: 'm1', role: 'user', content: '话', seq: 1 }],
        last_seq: 1,
      });
    }
    return jsonResponse(200, { items: [] });
  }

  /** 把某类请求挂起来的 fetch 桩：返回 resolve 句柄，其余 URL 走 `base`。 */
  function deferOnce(match: (url: string, init?: RequestInit) => boolean, base = sessionHandler) {
    let release: (r: Response) => void = () => {};
    let deferred = false;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!deferred && match(url, init)) {
        deferred = true;
        return new Promise<Response>((res) => { release = res; });
      }
      return Promise.resolve(base(url, init));
    }));
    return { release: (body: unknown) => release(jsonResponse(200, body)) };
  }

  it('createDir 在途时换账号：不把目录上下文抢回来，也不把上一账号的 session 递回视图', async () => {
    const { release } = deferOnce((url, init) => init?.method === 'POST' && url.startsWith('/api/sessions'));
    const store = useWorkbenchStore();
    store.claimOwnership('u1');
    const inflight = store.createDir('late-dir'); // POST 挂起
    store.claimOwnership('u2'); // 换账号（复位会撞 ctxSeq）
    await store.loadDirs(); // B 的目录已就位
    store.dirCwd = DIR_B.cwd;
    release({ session: { id: 's-a', cwd: '~/projects/late-dir' } });
    const out = await inflight;

    expect(out.error, '服务端确实建出来了 ⇒ 不算失败').toBeNull();
    expect(out.session, '不得把上一账号的会话递回视图（否则会被路由到一个不属于当前登录者的会话）').toBeUndefined();
    expect(store.dirCwd, 'B 刚加载好的目录上下文不得被盖掉').toBe(DIR_B.cwd);
    expect(store.sessions).toEqual([]);
    expect(store.dirs.map((d) => d.name)).toEqual(['beta']);
  });

  it('同一个人切目录（selectDir 会撞 ctxSeq）**不得**把新建成功的目录吞掉（评审实测的回归）', async () => {
    // 守卫比的是**用户代次**（scopeSeq），不是 ctxSeq：否则「点新建目录 → 在途中 ↻ / 切目录 →
    // 回包落地」会变成「服务端目录建了、modal 既不报错也不跳转、界面无声消失」。
    const { release } = deferOnce((url, init) => init?.method === 'POST' && url.startsWith('/api/sessions'));
    const store = useWorkbenchStore();
    store.claimOwnership('u1');
    const inflight = store.createDir('my-new');
    store.selectDir(DIR_B.cwd); // 同一个人切目录：撞 ctxSeq，不撞 scopeSeq
    release({ session: { id: 's-new', cwd: '~/projects/my-new' } });
    const out = await inflight;

    expect(out.session?.id, '同一个人的并发操作不得把新建结果判成作废').toBe('s-new');
    expect(store.dirCwd, '建目录的语义就是切进那个目录').toBe('~/projects/my-new');
    expect(store.dirs.map((d) => d.name)).toContain('my-new');
  });

  it('recallQueue 在途时换账号：文本存回**原会话草稿**，不写进新账号的输入框', async () => {
    const { release } = deferOnce((url, init) => init?.method === 'DELETE');
    const store = useWorkbenchStore();
    store.claimOwnership('u1');
    await store.openSession('s1');
    const inflight = store.recallQueue(); // DELETE 挂起
    store.claimOwnership('u2'); // 换账号：输入框、队列、会话全部归零
    release({ recalled: { steering: ['A 排的队'], follow_up: [] } });
    await inflight;

    expect(store.inputValue, 'A 排队的文本不得灌进 B 的输入框').toBe('');
    // 队列在服务端已被整队取走 ⇒ 直接丢弃 = 文本两头没。切回原会话必须还能拿回来。
    await store.openSession('s1');
    expect(store.inputValue, '取回的文本按原会话存进 drafts，切回去还在').toBe('A 排的队');
  });

  it('stop 在途时换账号：提示行不追进新账号的消息流', async () => {
    const { release } = deferOnce((url, init) => init?.method === 'POST' && url.endsWith('/stop'));
    const store = useWorkbenchStore();
    store.claimOwnership('u1');
    await store.openSession('s1');
    store.es.activeRunId = 'r1'; // stop 的前提
    const inflight = store.stop();
    store.claimOwnership('u2'); // 复位（entries 清空、会话归零）
    expect(store.entries).toEqual([]);
    release({ ok: true });
    await inflight;

    expect(store.entries, '「已请求停止」是上一账号那条流的事，不得插进新账号的消息流').toEqual([]);
  });
});
