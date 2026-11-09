// DirectoryTree 单测（issue #84 P5.4 + P6）：懒展开（点一级出一层）、默认收起、↻ 全折叠归位、
// 切 cwd 归位、文件/目录图标区分、文件点击 emit file-click（P6：零树请求，路径为相对路径）、
// 空目录标注。mock fetch，不碰真实后端。
// 注意：需 NODE_ENV=development 运行（本机 shell 默认 production 时 VTU emitted/DOM 部分行为失效，
// 仓库既有约定：NODE_ENV=development npm install && npm test）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import DirectoryTree from './DirectoryTree.vue';
import { useAuthStore, type AuthUser } from '../stores/auth';
import type { TreeEntry } from '../lib/tree';
import { i18n, setLocale } from '../i18n';

// issue #101 P2：装配真实 i18n 单例（组件内 useI18n() 需要），本文件多处 mount 统一经此助手。
// issue #472：组件现在读 auth store 的 `file_upload_enabled`（上传按钮的三态判据）⇒ 装配真实 pinia，
// 并把能力位从 mountTree 的第二参传进来（**默认不给 = 缺键**，正是 B-13 要的第三态基线）。
function mountTree(
  props: { cwd: string | null; onFileClick?: (p: string) => void; onFilesChanged?: () => void },
  opts: { uploadFlag?: boolean | undefined } = {},
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.ready = true;
  const user: AuthUser & Record<string, unknown> = {
    id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local',
  };
  if (opts.uploadFlag !== undefined) user.file_upload_enabled = opts.uploadFlag;
  auth.user = user;
  return mount(DirectoryTree, { props, global: { plugins: [pinia, i18n] } });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 目录数据：'' → src(dir) + README.md(file)；src → index.ts(file)；其余路径 → 空。 */
const TREE: Record<string, TreeEntry[]> = {
  '': [
    { name: 'src', type: 'dir' },
    { name: 'README.md', type: 'file' },
  ],
  src: [{ name: 'index.ts', type: 'file' }],
};

function mockTreeFetch(failPaths: string[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    expect(String(url)).toMatch(/^\/api\/files\/tree\?cwd=/);
    const u = new URL(String(url), 'http://localhost');
    const path = u.searchParams.get('path') ?? '';
    if (failPaths.includes(path)) return jsonResponse(500, { error: { message: 'boom' } });
    return jsonResponse(200, { entries: TREE[path] ?? [] });
  }));
}

/** 面板展开 + 等根层加载完成。 */
async function openPanel(wrapper: ReturnType<typeof mount>) {
  await wrapper.get('button').trigger('click'); // ▸ 目录树
  await vi.waitFor(() => {
    expect(wrapper.text()).toContain('src');
  });
}

/** 按文本找到节点行按钮。 */
function rowBtns(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('button').filter((b) => ['src', 'README.md', 'index.ts'].some((t) => b.text().includes(t)));
}

beforeEach(() => {
  vi.unstubAllGlobals();
  // 每例重置语言为 zh-CN（既有中文断言逐字不变）。
  localStorage.clear();
  setLocale('zh-CN');
});

describe('DirectoryTree（目录树面板）', () => {
  it('默认收起：零请求；展开后只拉根层单层（path 参数为空串）', async () => {
    mockTreeFetch();
    const wrapper = mountTree({ cwd: '~/projects/demo' });
    expect(wrapper.text()).toContain('▸ 目录树');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled(); // 懒：收起时不发请求

    await openPanel(wrapper);
    expect(wrapper.text()).toContain('▾ 目录树');
    expect(wrapper.text()).toContain('src');
    expect(wrapper.text()).toContain('README.md');
    // 图标区分：目录 📁 / 文件 📄
    const [src, readme] = rowBtns(wrapper);
    expect(src.text()).toContain('📁');
    expect(readme.text()).toContain('📄');
    // 单层 API：仅一次根层请求，无递归
    const calls = vi.mocked(fetch).mock.calls.map(([u]) => String(u));
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0], 'http://localhost');
    expect(u.searchParams.get('cwd')).toBe('~/projects/demo');
    expect(u.searchParams.get('path')).toBe(''); // 根层 = 空 path
  });

  it('懒展开：点目录项才拉下一层（path=src）；收起再展开用缓存不发请求；文件点击 emit file-click（零树请求）', async () => {
    mockTreeFetch();
    // 文件节点点击（P6）：emit file-click（相对路径），零树请求
    // （emitted() 对本环境 script-setup 组件不记录，用父级 onFileClick 回调断言，仓库先例同）
    const onFileClick = vi.fn();
    const wrapper = mountTree({ cwd: '~/projects/demo', onFileClick });
    await openPanel(wrapper);
    const callsAfterRoot = vi.mocked(fetch).mock.calls.length;
    const [, readme] = rowBtns(wrapper);
    await readme.trigger('click');
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsAfterRoot);
    expect(onFileClick).toHaveBeenCalledWith('README.md');

    // 点目录项 → 拉下一层，展开 icon 变为 📂，子文件出现
    const [src] = rowBtns(wrapper);
    await src.trigger('click');
    await vi.waitFor(() => expect(wrapper.text()).toContain('index.ts'));
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsAfterRoot + 1);
    expect(String(vi.mocked(fetch).mock.calls.at(-1)![0])).toContain('path=src');
    expect(src.text()).toContain('📂');

    // 嵌套文件点击：emit 完整相对路径 a/b/c（同样零树请求）
    const nested = rowBtns(wrapper).find((b) => b.text().includes('index.ts'))!;
    await nested.trigger('click');
    expect(onFileClick).toHaveBeenLastCalledWith('src/index.ts');
    expect(onFileClick).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsAfterRoot + 1); // 文件点击不发树请求

    // 收起子层再展开：缓存命中，零请求
    await src.trigger('click'); // 收起
    expect(wrapper.text()).not.toContain('index.ts');
    await src.trigger('click'); // 再展开
    expect(wrapper.text()).toContain('index.ts');
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsAfterRoot + 1);
  });

  it('reload（↻ 路径）：回到全折叠 + 清缓存，面板开着则重拉根层', async () => {
    mockTreeFetch();
    const wrapper = mountTree({ cwd: '~/projects/demo' });
    await openPanel(wrapper);
    const [src] = rowBtns(wrapper);
    await src.trigger('click');
    await vi.waitFor(() => expect(wrapper.text()).toContain('index.ts'));

    (wrapper.vm as unknown as { reload: () => void }).reload();
    await wrapper.vm.$nextTick(); // shallowReactive 集合清空后 DOM 异步刷新
    expect(wrapper.text()).not.toContain('index.ts');
    expect(wrapper.text()).not.toContain('📂'); // 全折叠
    // 面板仍开着 → 重拉根层
    await vi.waitFor(() => expect(wrapper.text()).toContain('src'));
    expect(vi.mocked(fetch).mock.calls.length).toBe(3); // root + src + root
  });

  it('切 cwd：树归位（全折叠 + 清缓存），重载新目录根层', async () => {
    mockTreeFetch();
    const wrapper = mountTree({ cwd: '~/projects/demo' });
    await openPanel(wrapper);
    const [src] = rowBtns(wrapper);
    await src.trigger('click');
    await vi.waitFor(() => expect(wrapper.text()).toContain('index.ts'));

    await wrapper.setProps({ cwd: '~/projects/other' });
    await vi.waitFor(() => {
      expect(wrapper.text()).not.toContain('index.ts'); // 旧目录子层清空
      expect(wrapper.text()).toContain('src'); // 新目录根层已加载
    });
    const calls = vi.mocked(fetch).mock.calls.map(([u]) => String(u));
    expect(calls.at(-1)).toContain('cwd=' + encodeURIComponent('~/projects/other'));
  });

  it('加载失败：错误行展示，节点展开态回滚（可重试点）', async () => {
    mockTreeFetch(['src']);
    const wrapper = mountTree({ cwd: '~/projects/demo' });
    await openPanel(wrapper);
    const [src] = rowBtns(wrapper);
    await src.trigger('click');
    await vi.waitFor(() => expect(wrapper.text()).toContain('目录树加载失败'));
    expect(wrapper.text()).toContain('boom');
    expect(wrapper.text()).not.toContain('index.ts'); // 展开态已回滚
  });

  it('空目录：根层零条目时显式标注（空目录）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { entries: [] })));
    const wrapper = mountTree({ cwd: '~/projects/empty' });
    await wrapper.get('button').trigger('click'); // 展开面板
    await vi.waitFor(() => expect(wrapper.text()).toContain('（空目录）'));
  });

  it('cwd 为空：面板展开显示引导文案，零请求', async () => {
    mockTreeFetch();
    const wrapper = mountTree({ cwd: null });
    await wrapper.get('button').trigger('click');
    expect(wrapper.text()).toContain('先选择目录');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// issue #112：目录树字号收敛（标题 11px/600/0.05em，行 12px，空态 11px）——懒展开交互不变
// ---------------------------------------------------------------------------
describe('DirectoryTree · 字号收敛（issue #112）', () => {
  it('面板标题 = 小节标题规格（11px/600/0.05em）；行内 12px；空目录文案 11px', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { entries: [] })));
    const wrapper = mountTree({ cwd: '~/projects/empty' });
    const title = wrapper.get('button');
    expect(title.classes()).toContain('text-[11px]');
    expect(title.classes()).toContain('font-semibold');
    expect(title.classes()).toContain('tracking-[0.05em]');

    mockTreeFetch();
    const w2 = mountTree({ cwd: '~/projects/demo' });
    await openPanel(w2);
    const [src] = rowBtns(w2);
    expect(src.classes()).toContain('text-[12px]');
    expect(src.classes()).toContain('py-[1px]'); // 行高收紧

    // 空目录提示 11px
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { entries: [] })));
    const w3 = mountTree({ cwd: '~/projects/empty' });
    await w3.get('button').trigger('click');
    await vi.waitFor(() => expect(w3.text()).toContain('（空目录）'));
    const emptyLine = w3.findAll('p').find((p) => p.text() === '（空目录）')!;
    expect(emptyLine.classes()).toContain('text-[11px]');
  });
});

// ---------------------------------------------------------------------------
// issue #101 P2：目录树用户可见文案走 i18n（zh-CN 基线逐字不变，切 en 即时生效）
// ---------------------------------------------------------------------------
describe('DirectoryTree · i18n（issue #101 P2）', () => {
  it('zh-CN 基线：面板标题 / 未选目录 / 空目录 / 加载失败文案', async () => {
    const noCwd = mountTree({ cwd: null });
    await noCwd.get('button').trigger('click'); // 面板默认收起：展开后才渲染空态
    expect(noCwd.text()).toContain('先选择目录');

    // 空目录：根层零条目（stub 恒返回空 entries）
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { entries: [] })));
    const empty = mountTree({ cwd: '~/projects/empty' });
    await empty.get('button').trigger('click');
    await vi.waitFor(() => expect(empty.text()).toContain('（空目录）'));
    expect(empty.text()).toContain('▾ 目录树');

    mockTreeFetch(['']);
    const failed = mountTree({ cwd: '~/projects/demo' });
    await failed.get('button').trigger('click');
    await vi.waitFor(() => expect(failed.text()).toContain('目录树加载失败'));
    expect(failed.text()).toContain('boom');
  });

  it('切 English：标题 / 未选目录 / 空目录 / 加载失败文案即时变英文', async () => {
    const noCwd = mountTree({ cwd: null });
    await noCwd.get('button').trigger('click');
    expect(noCwd.text()).toContain('先选择目录');
    setLocale('en');
    await flushPromises();
    expect(noCwd.text()).toContain('Directory tree');
    expect(noCwd.text()).toContain('Select a directory first');

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { entries: [] })));
    const empty = mountTree({ cwd: '~/projects/empty' });
    await empty.get('button').trigger('click');
    await vi.waitFor(() => expect(empty.text()).toContain('(empty directory)'));

    mockTreeFetch(['']);
    const failed = mountTree({ cwd: '~/projects/demo' });
    await failed.get('button').trigger('click');
    await vi.waitFor(() => expect(failed.text()).toContain('Failed to load the directory tree: boom'));
  });
});

// ---------------------------------------------------------------------------
// issue #472 片 B：上传按钮（B-13 三态 / B-14 覆盖确认 / B-15 emit files-changed）
// ---------------------------------------------------------------------------
describe('DirectoryTree · 上传（issue #472）', () => {
  /** 树 + 上传端点的 fetch 桩。`uploadResponder` 决定上传怎么答（默认 201 成功）。 */
  function mockFetchWithUpload(
    uploadResponder: (call: { url: string; init?: RequestInit }) => Response = () => jsonResponse(201, {
      path: 'new.txt', bytes: 3, overwritten: false,
    }),
  ) {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith('/api/files/upload')) return uploadResponder({ url, init });
      const path = new URL(url, 'http://localhost').searchParams.get('path') ?? '';
      return jsonResponse(200, { entries: TREE[path] ?? [] });
    }));
    return calls;
  }

  const file = (name: string) => new File([new Uint8Array([1, 2, 3])], name, {
    type: 'application/octet-stream',
  });

  /**
   * 触发隐藏 input 的 change（= 用户选完文件）并等这一轮**跑完**。
   * ⚠ 不能只等「结果行出现」：上传中也会先渲染一行『上传中…』，那样等于没等（实测连片假红）。
   * `settle: false` 用于「根本不该进入上传」的用例（那时永远不会有结果行）。
   */
  async function pick(wrapper: ReturnType<typeof mount>, files: File[], opts: { settle?: boolean } = {}) {
    const input = wrapper.get('[data-test="tree-upload-input"]').element as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await input.dispatchEvent(new Event('change'));
    if (opts.settle === false) { await flushPromises(); await new Promise((r) => setTimeout(r, 0)); await flushPromises(); return; }
    const busy = i18n.global.t('tree.upload.busy');
    await vi.waitFor(() => {
      const el = wrapper.find('[data-test="tree-upload-line"]');
      expect(el.exists()).toBe(true);
      expect(el.text()).not.toBe(busy);
    });
  }

  it('B-13 三态：true 显示 / false 隐藏 / **缺键隐藏**（且缺键时零请求）', async () => {
    mockFetchWithUpload();
    const on = mountTree({ cwd: '~/projects/demo' }, { uploadFlag: true });
    expect(on.find('[data-test="tree-upload"]').exists()).toBe(true);

    const off = mountTree({ cwd: '~/projects/demo' }, { uploadFlag: false });
    expect(off.find('[data-test="tree-upload"]').exists()).toBe(false);

    // 缺键 = 不知道 = 不显示（旧 /api/me 的形状；`!== false` 的写法会把按钮发给不知道的人）
    const unknown = mountTree({ cwd: '~/projects/demo' });
    expect(unknown.find('[data-test="tree-upload"]').exists()).toBe(false);
    expect(unknown.find('[data-test="tree-upload-input"]').exists()).toBe(false);
    // 面板展开（会发**树**请求），但一次**上传**请求都不该有
    await unknown.get('button').trigger('click');
    await vi.waitFor(() => expect(unknown.text()).toContain('src'));
    expect(vi.mocked(fetch).mock.calls.map(([u]) => String(u)).some((u) => u.startsWith('/api/files/upload'))).toBe(false);
  });

  it('B-15/B-2 上传成功：走 api() 的 POST（octet-stream + File 当 body）⇒ emit files-changed + 树重载', async () => {
    const calls = mockFetchWithUpload();
    const onFilesChanged = vi.fn();
    const wrapper = mountTree({ cwd: '~/projects/demo', onFilesChanged }, { uploadFlag: true });
    await wrapper.get('button').trigger('click'); // 展开面板（reload 只在面板开着时重拉根层）
    await vi.waitFor(() => expect(wrapper.text()).toContain('src'));
    const before = calls.length;

    await pick(wrapper, [file('new.txt')]);

    const up = calls.filter((c) => c.url.startsWith('/api/files/upload'));
    expect(up).toHaveLength(1);
    const u = new URL(up[0].url, 'http://localhost');
    expect(u.searchParams.get('cwd')).toBe('~/projects/demo');
    expect(u.searchParams.get('path')).toBe('.');
    expect(u.searchParams.get('name')).toBe('new.txt');
    expect(u.searchParams.has('overwrite')).toBe(false);
    expect(up[0].init?.method).toBe('POST');
    expect((up[0].init?.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
    // body 必须是**原文件**（不是 base64、不是 JSON、不是 FormData）——端点是原始字节体
    expect((up[0].init?.body as File).name).toBe('new.txt');

    // 成功后：emit + 树重载（reload ⇒ 再发一次根层树请求）
    expect(onFilesChanged).toHaveBeenCalledTimes(1);
    expect(calls.length).toBeGreaterThan(before);
    expect(wrapper.get('[data-test="tree-upload-line"]').text()).toContain('已上传 1 个文件');
  });

  it('B-14 409 ⇒ 先确认再重发：确认前请求数 1，确认后 2 且第二个带 overwrite=1', async () => {
    const calls = mockFetchWithUpload(({ url }) => {
      if (new URL(url, 'http://localhost').searchParams.get('overwrite') === '1') {
        return jsonResponse(200, { path: 'a.txt', bytes: 3, overwritten: true });
      }
      return jsonResponse(409, { error: { code: 'file_exists', message: '目标文件已存在', details: { path: 'a.txt' } } });
    });
    // ⚠ 判据形状（§8.47 M6）：在 **confirm 被调用的那一刻**记请求数 —— 事后再数会把「确认之后发的」
    // 也算进「确认之前」，而立刻断言又可能跑在异步链前面（两种都是假绿/假红的来源）。
    let requestsAtConfirm = -1;
    // 形参要写出来：`vi.fn(() => true)` 的调用签名是 `(...args: [])`，`mock.calls[0][0]` 会被
    // vue-tsc 判成「长度 0 的元组没有下标 0」（TS2493），判据本身没错。
    const confirm = vi.fn((message?: string) => {
      requestsAtConfirm = calls.filter((c) => c.url.startsWith('/api/files/upload')).length;
      return true;
    });
    vi.stubGlobal('confirm', confirm);
    const wrapper = mountTree({ cwd: '~/projects/demo' }, { uploadFlag: true });
    await pick(wrapper, [file('a.txt')]);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(requestsAtConfirm, '确认之前必须只有那 1 个原始请求').toBe(1);
    expect(String(confirm.mock.calls[0]?.[0] ?? '')).toContain('a.txt');
    const ups = calls.filter((c) => c.url.startsWith('/api/files/upload'));
    expect(ups).toHaveLength(2);
    expect(new URL(ups[1].url, 'http://localhost').searchParams.get('overwrite')).toBe('1');
    expect(new URL(ups[0].url, 'http://localhost').searchParams.has('overwrite')).toBe(false);
  });

  it('B-14 反向：确认里选「不覆盖」⇒ 只有 1 个请求，且不算失败也不 emit', async () => {
    const calls = mockFetchWithUpload(() => jsonResponse(409, {
      error: { code: 'file_exists', message: '目标文件已存在', details: { path: 'a.txt' } },
    }));
    vi.stubGlobal('confirm', vi.fn(() => false));
    const onFilesChanged = vi.fn();
    const wrapper = mountTree({ cwd: '~/projects/demo', onFilesChanged }, { uploadFlag: true });
    await pick(wrapper, [file('a.txt')]);
    expect(calls.filter((c) => c.url.startsWith('/api/files/upload'))).toHaveLength(1);
    expect(onFilesChanged).not.toHaveBeenCalled();
    expect(wrapper.get('[data-test="tree-upload-line"]').text()).toContain('未上传');
  });

  it('B-14 批量：409 只对**那一个**文件重发 overwrite=1，其余文件不受影响', async () => {
    const calls = mockFetchWithUpload(({ url }) => {
      const u = new URL(url, 'http://localhost');
      if (u.searchParams.get('name') !== 'a.txt') return jsonResponse(201, { path: 'x', bytes: 3, overwritten: false });
      return u.searchParams.get('overwrite') === '1'
        ? jsonResponse(200, { path: 'a.txt', bytes: 3, overwritten: true })
        : jsonResponse(409, { error: { code: 'file_exists', message: 'exists' } });
    });
    vi.stubGlobal('confirm', vi.fn(() => true));
    const wrapper = mountTree({ cwd: '~/projects/demo' }, { uploadFlag: true });
    await pick(wrapper, [file('a.txt'), file('b.txt')]);
    await vi.waitFor(() => expect(wrapper.get('[data-test="tree-upload-line"]').text()).toContain('已上传 2 个文件'));
    const ups = calls.filter((c) => c.url.startsWith('/api/files/upload')).map((c) => {
      const u = new URL(c.url, 'http://localhost');
      return `${u.searchParams.get('name')}${u.searchParams.get('overwrite') ? ':ov' : ''}`;
    });
    expect(ups).toEqual(['a.txt', 'a.txt:ov', 'b.txt']);
  });

  it('错误文案按服务端码分流：upload_disabled / file_too_large / upload_interrupted 各有各的话', async () => {
    const cases: [string, number, string, string][] = [
      ['upload_disabled', 403, '这个账号没有上传权限', ''],
      ['file_too_large', 413, '单文件大小上限', ''],
      ['upload_interrupted', 400, '上传中断', ''],
    ];
    for (const [code, status, expectText] of cases) {
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith('/api/files/upload')) {
          return jsonResponse(status, { error: { code, message: 'server says so' } });
        }
        return jsonResponse(200, { entries: [] });
      }));
      const wrapper = mountTree({ cwd: '~/projects/demo' }, { uploadFlag: true });
      await pick(wrapper, [file('a.txt')]);
      const line = wrapper.get('[data-test="tree-upload-line"]');
      expect(line.text(), code).toContain(expectText);
      expect(line.attributes('role')).toBe('alert');
    }
  });

  it('没选目录（cwd=null）⇒ 按钮在但不发请求；选空数组也不发请求', async () => {
    const calls = mockFetchWithUpload();
    const wrapper = mountTree({ cwd: null }, { uploadFlag: true });
    expect(wrapper.get('[data-test="tree-upload"]').attributes('disabled')).toBeDefined();
    await pick(wrapper, [file('a.txt')], { settle: false });
    expect(calls).toHaveLength(0);
    // 空数组（用户在文件对话框里按了取消）同样零请求
    await pick(wrapper, [], { settle: false });
    expect(calls).toHaveLength(0);
  });
});
