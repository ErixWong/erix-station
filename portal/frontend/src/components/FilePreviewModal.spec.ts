// FilePreviewModal 单测（issue #84 P6 预览第一版）：三种渲染分支（Markdown 复用 markdown.ts /
// 文本 <pre> / 图片 <img>）、三态（加载中/失败含 413 超限/成功）、dialog 语义与 Esc 关闭、
// 请求参数（cwd/path 编码，路径牢笼由后端 portal/test/file-preview.test.js 覆盖）。
// 事件断言用父级 onClose 回调（script-setup 组件 emitted() 不记录，仓库先例亦不用）。
// 注意：需 NODE_ENV=development 运行（仓库既有约定：NODE_ENV=development npm install && npm test）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import FilePreviewModal from './FilePreviewModal.vue';
import { i18n, setLocale } from '../i18n';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okFile(kind: 'text' | 'image', data: string, name = 'note.txt') {
  return jsonResponse(200, { name, path: `sub/${name}`, kind, data });
}

/** 真实推进 macrotask（jsdom Response.json）后再冲刷微任务。 */
const tick = async (ms = 30) => {
  await new Promise((r) => setTimeout(r, ms));
  await flushPromises();
};

function mountModal(handlers: { onClose?: () => void } = {}) {
  return mount(FilePreviewModal, {
    props: { cwd: '~/projects/demo', path: 'sub/note.txt', ...handlers },
    global: { plugins: [i18n] }, // issue #101 P2：装配真实 i18n 单例（组件内 useI18n()）
    attachTo: document.body, // 焦点断言需要真实挂载
  });
}

/** 最后一次 /api/file 请求的 URL（参数编码断言用）。 */
function lastFetchUrl() {
  return String(vi.mocked(fetch).mock.calls.at(-1)![0]);
}

beforeEach(() => {
  vi.unstubAllGlobals();
  // 每例重置语言为 zh-CN（既有中文断言逐字不变）。
  localStorage.clear();
  setLocale('zh-CN');
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

describe('FilePreviewModal（issue #84 P6 文件预览）', () => {
  it('dialog 语义：role=dialog + aria-modal + 预览路径标签，打开焦点进 dialog 容器', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okFile('text', 'hi')));
    const wrapper = mountModal();
    await tick();
    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.attributes('aria-modal')).toBe('true');
    expect(dialog.attributes('aria-label')).toBe('预览 sub/note.txt');
    expect(document.activeElement).toBe(dialog.element);
    // 背景滚动锁定 + 头部信息（文件名 + 相对路径）
    expect(document.body.style.overflow).toBe('hidden');
    expect(wrapper.text()).toContain('note.txt');
    expect(wrapper.text()).toContain('sub/note.txt');
    wrapper.unmount();
    expect(document.body.style.overflow).toBe(''); // 卸载归还
  });

  it('请求参数：GET /api/file?cwd=&path=（URL 编码），一次且仅一次', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okFile('text', 'hi')));
    const wrapper = mountModal();
    await tick();
    expect(lastFetchUrl()).toMatch(/^\/api\/file\?cwd=/);
    const u = new URL(lastFetchUrl(), 'http://localhost');
    expect(u.searchParams.get('cwd')).toBe('~/projects/demo');
    expect(u.searchParams.get('path')).toBe('sub/note.txt');
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    wrapper.unmount();
  });

  it('文本分支：kind=text 且非 .md → <pre> 原样展示，无 markdown 渲染', async () => {
    const src = 'const a = 1;\nconsole.log(a);';
    vi.stubGlobal('fetch', vi.fn(async () => okFile('text', src, 'index.ts')));
    const wrapper = mount(FilePreviewModal, {
      props: { cwd: '~/projects/demo', path: 'src/index.ts', onClose: () => {} },
      global: { plugins: [i18n] }, // issue #101 P2
      attachTo: document.body,
    });
    await tick();
    const pre = wrapper.find('pre');
    expect(pre.exists()).toBe(true);
    expect(pre.text()).toBe(src);
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('.md').exists()).toBe(false); // 非 Markdown 不走渲染器
    wrapper.unmount();
  });

  it('Markdown 分支：.md/.markdown → 复用 lib/markdown.ts 渲染（v-html 出标题标签）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okFile('text', '# 标题\n\n正文 **粗体**', 'README.md')));
    const wrapper = mount(FilePreviewModal, {
      props: { cwd: '~/projects/demo', path: 'README.md', onClose: () => {} },
      global: { plugins: [i18n] }, // issue #101 P2
      attachTo: document.body,
    });
    await tick();
    expect(wrapper.find('pre').exists()).toBe(false);
    const md = wrapper.find('.md');
    expect(md.exists()).toBe(true);
    expect(md.html()).toContain('<h1>标题</h1>');
    expect(md.html()).toContain('<strong>粗体</strong>');
    wrapper.unmount();
  });

  it('图片分支：kind=image → <img> 直出 data URL', async () => {
    const dataUrl = 'data:image/png;base64,QUJD';
    vi.stubGlobal('fetch', vi.fn(async () => okFile('image', dataUrl, 'logo.png')));
    const wrapper = mount(FilePreviewModal, {
      props: { cwd: '~/projects/demo', path: 'logo.png', onClose: () => {} },
      global: { plugins: [i18n] }, // issue #101 P2
      attachTo: document.body,
    });
    await tick();
    const img = wrapper.find('img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe(dataUrl);
    expect(img.attributes('alt')).toBe('logo.png');
    wrapper.unmount();
  });

  it('加载中 → 成功：先显式加载态，请求完成后切换为内容（三态其一）', async () => {
    let resolveFetch: ((r: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { resolveFetch = r; })));
    const wrapper = mountModal();
    await flushPromises();
    expect(wrapper.text()).toContain('加载中…'); // 悬挂期显式加载态
    resolveFetch!(okFile('text', 'done'));
    await tick();
    expect(wrapper.text()).toContain('done');
    expect(wrapper.text()).not.toContain('加载中…');
    wrapper.unmount();
  });

  it('失败态：413 超限 / 415 二进制等错误 message 直显（role=alert），无内容区', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse(413, { error: { code: 'file_too_large', message: '文件超过预览上限（2MB）' } })));
    const wrapper = mountModal();
    await tick();
    const alert = wrapper.find('[role="alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain('文件超过预览上限（2MB）');
    expect(wrapper.find('pre').exists()).toBe(false);
    expect(wrapper.find('img').exists()).toBe(false);
    wrapper.unmount();

    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse(415, { error: { code: 'unsupported_file_type', message: '二进制文件不支持预览' } })));
    const w2 = mountModal();
    await tick();
    expect(w2.find('[role="alert"]').text()).toContain('二进制文件不支持预览');
    w2.unmount();
  });

  it('Esc 关闭（emit close 由父级 onClose 承接），遮罩点击同语义', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okFile('text', 'hi')));
    const onClose = vi.fn();
    const wrapper = mountModal({ onClose });
    await tick();
    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    await wrapper.find('.bg-black\\/40').trigger('click');
    expect(onClose).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
});
