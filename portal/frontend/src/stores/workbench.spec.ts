// workbench store 单测（issue #84 P5 改版）：目录即项目——/api/dirs 数据源、cwd 过滤、
// createDir（POST /api/sessions {cwd}）、selectDir 复位语义、跨目录深链。
// 语义锚点：旧 index.html 内联 JS + 本 store 头注。消息/草稿/发送守卫用例不受 P5 影响，保留。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { setWorkbenchHooks, useWorkbenchStore } from './workbench';
import { setLocale } from '../i18n';

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

const USER = { role: 'fde', fde_name: 'alice' };
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
    await store.initWorkspace(USER);
    expect(store.noDir).toBe(true);
    expect(store.inputPlaceholder).toBe('先创建目录');
    expect(store.sessions).toEqual([]);

    mockFetch(dirsAwareHandler({ '~/projects/demo': [{ id: 's1', title: 't', cwd: '~/projects/demo' }] }));
    const store2 = useWorkbenchStore();
    await store2.initWorkspace(USER);
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
    await store.initWorkspace(USER);
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
    await store.initWorkspace(USER);
    expect(store.sessions.map((s) => s.message_count)).toEqual([42, undefined]);
  });

  it('平台管理员空态：newDir 禁用 + 管理台引导 placeholder', async () => {
    mockFetch(() => ({ status: 200, body: { dirs: [] } }));
    const store = useWorkbenchStore();
    await store.initWorkspace({ role: 'admin', fde_name: null });
    expect(store.isPlatformAdmin).toBe(true);
    expect(store.newDirDisabled).toBe(true);
    expect(store.inputPlaceholder).toBe('平台管理员：请到管理台创建 FDE 用户与分配资源');
  });

  it('createSession：POST /api/sessions 请求体为 {cwd}（project_id 已退役）', async () => {
    mockFetch(dirsAwareHandler({}));
    const store = useWorkbenchStore();
    await store.initWorkspace(USER);
    const s = await store.createSession();
    expect(s?.id).toBe('s-new');
    expect(lastSessionPostBody).toEqual({ cwd: '~/projects/demo' });
    expect(store.sessions[0]?.id).toBe('s-new'); // 列表置顶
  });

  it('createDir：非法名本地校验不发请求；合法名以该 cwd 建会话（服务端 mkdir），切目录并置顶', async () => {
    mockFetch(dirsAwareHandler({}));
    const store = useWorkbenchStore();
    await store.initWorkspace(USER);

    const bad = await store.createDir('Bad_Name');
    expect(bad.error).toContain('目录名必须符合');
    expect(lastSessionPostBody).toBeNull(); // 未发请求

    const ok = await store.createDir('my-app');
    expect(ok.error).toBeNull();
    expect(lastSessionPostBody).toEqual({ cwd: '~/projects/my-app' });
    expect(store.dirCwd).toBe('~/projects/my-app');
    expect(store.dirs.some((d) => d.cwd === '~/projects/my-app')).toBe(true);
    expect(store.sessions[0]?.id).toBe('s-new'); // 新会话置顶，视图可打开
    expect(store.noDir).toBe(false);
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
    await store.initWorkspace(USER); // 选中 demo
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
    await store.initWorkspace(USER);
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
    await store.initWorkspace(USER);
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
      expect(judgeSep.text).toBe('judge：不扩轮 — 够用了');
      expect(judgeSep.variant).toBe('judge'); // feat-260925-02 judge 面板高亮 sep
    }
    const card = store.es.toolCards.get('c1');
    expect(card?.ok).toBe(true);
    expect(card?.out).toBe('✓ ok（5ms）');
    expect(store.es.lastSeq).toBe(5);
    expect(store.es.activeRunId).toBeNull();
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
    expect(store.es.toolCards.has('c1')).toBe(true); // 展示事件正常重建
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
  it('zh-CN 基线：占位符三态 / 目录名校验错误 / synthetic 前缀 / 停止分隔行', async () => {
    mockFetch(dirsAwareHandler({}));
    const store = useWorkbenchStore();
    await store.initWorkspace(USER);
    expect(store.inputPlaceholder).toBe('输入任务，Enter 发送（Shift+Enter 换行）');

    store.noDir = true;
    expect(store.inputPlaceholder).toBe('先创建目录');
    store.isPlatformAdmin = true;
    expect(store.inputPlaceholder).toBe('平台管理员：请到管理台创建 FDE 用户与分配资源');

    const bad = await store.createDir('Bad_Name');
    expect(bad.error).toBe('目录名必须符合：小写字母/数字/连字符，且不能以连字符开头或结尾（最多 63 个字符）');

    store.renderedIds = new Set();
    store.addMessage({ id: 'm1', role: 'assistant', content: '内容', synthetic: true });
    const syn = store.entries.find((e) => e.kind === 'msg' && e.synthetic);
    expect(syn && 'text' in syn ? syn.text : '').toBe('〔系统注入〕内容');
  });

  it('切 English：占位符 / 校验错误 / synthetic 前缀即时变英文（computed 响应式）', async () => {
    mockFetch(dirsAwareHandler({}));
    const store = useWorkbenchStore();
    await store.initWorkspace(USER);
    setLocale('en');
    expect(store.inputPlaceholder).toBe('Type a task, Enter to send (Shift+Enter for a newline)');

    store.noDir = true;
    expect(store.inputPlaceholder).toBe('Create a directory first');
    store.isPlatformAdmin = true;
    expect(store.inputPlaceholder)
      .toBe('Platform admin: create FDE users and assign resources in the admin console');

    const bad = await store.createDir('Bad_Name');
    expect(bad.error).toContain('Directory name must be lowercase letters / digits / hyphens');

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

  it('同一 tool 调用（DTO 投影 + 历史事件）只渲染一张卡片（按 provider id 幂等归并）', async () => {
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
    // 事件流先建卡片：完整 args 保留，投影只补全缺失字段
    expect(store.es.toolCards.get('c1')?.args).toBe('{"path":"src/a.js"}');
    expect(store.es.toolCards.get('c1')?.argsSummary).toBe('path=src/a.js');
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
