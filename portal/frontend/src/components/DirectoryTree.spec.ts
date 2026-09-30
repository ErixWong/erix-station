// DirectoryTree 单测（issue #84 P5.4 + P6）：懒展开（点一级出一层）、默认收起、↻ 全折叠归位、
// 切 cwd 归位、文件/目录图标区分、文件点击 emit file-click（P6：零树请求，路径为相对路径）、
// 空目录标注。mock fetch，不碰真实后端。
// 注意：需 NODE_ENV=development 运行（本机 shell 默认 production 时 VTU emitted/DOM 部分行为失效，
// 仓库既有约定：NODE_ENV=development npm install && npm test）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import DirectoryTree from './DirectoryTree.vue';
import type { TreeEntry } from '../lib/tree';
import { i18n, setLocale } from '../i18n';

// issue #101 P2：装配真实 i18n 单例（组件内 useI18n() 需要），本文件多处 mount 统一经此助手。
function mountTree(props: { cwd: string | null; onFileClick?: (p: string) => void }) {
  return mount(DirectoryTree, { props, global: { plugins: [i18n] } });
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
