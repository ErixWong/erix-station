// mermaidEnhance 单测：DOM 后处理增强的形状（渲染器输出 → 图/源码切换/失败兜底）。
// mermaid 真库不在测试路径上（mermaidRender 整体 mock，只验增强逻辑与 DOM 形状）。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const renderMock = vi.fn<(code: string) => Promise<string>>();
vi.mock('./mermaidRender', () => ({
  renderMermaidSvg: (code: string) => renderMock(code),
}));

import { enhanceMermaid } from './mermaidEnhance';
import { renderMarkdown } from './markdown';

function mount(md: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = renderMarkdown(md);
  document.body.appendChild(root);
  return root;
}

beforeEach(() => {
  renderMock.mockReset();
  document.body.innerHTML = '';
});

describe('enhanceMermaid', () => {
  it('mermaid 块：渲染成功后插 SVG、默认预览态、头部有源码/预览切换按钮', async () => {
    renderMock.mockResolvedValue('<svg data-testid="diagram"></svg>');
    const root = mount('```mermaid\ngraph TD;A-->B;\n```');
    enhanceMermaid(root);
    expect(root.querySelector('.md-mermaid')).toBeTruthy(); // pending 态（源码仍可见）
    await vi.waitFor(() => expect(root.querySelector('.md-mermaid-svg')).toBeTruthy());
    expect(root.querySelector('.md-mermaid-svg')!.innerHTML).toContain('data-testid="diagram"');
    const block = root.querySelector<HTMLElement>('.md-code')!;
    expect(block.getAttribute('data-mermaid')).toBe('ready');
    expect(block.classList.contains('md-mermaid-preview')).toBe(true); // pi-web defaultPreview 口径
    expect(block.querySelector('.md-mermaid-toggle')).toBeTruthy();
  });

  it('切换按钮：点一下回源码（去 preview 类），再点回图', async () => {
    renderMock.mockResolvedValue('<svg></svg>');
    const root = mount('```mermaid\ngraph TD;A-->B;\n```');
    enhanceMermaid(root);
    await vi.waitFor(() => expect(root.querySelector('.md-mermaid-svg')).toBeTruthy());
    const block = root.querySelector<HTMLElement>('.md-code')!;
    const btn = block.querySelector<HTMLButtonElement>('.md-mermaid-toggle')!;
    btn.click();
    expect(block.classList.contains('md-mermaid-preview')).toBe(false);
    btn.click();
    expect(block.classList.contains('md-mermaid-preview')).toBe(true);
  });

  it('渲染失败：data-mermaid=error + 提示行，不插 SVG、不删源码（可读兜底）', async () => {
    renderMock.mockRejectedValue(new Error('invalid mermaid diagram'));
    const root = mount('```mermaid\nnot a diagram [[[\n```');
    enhanceMermaid(root);
    await vi.waitFor(() => expect(root.querySelector('.md-mermaid-error')).toBeTruthy());
    const block = root.querySelector<HTMLElement>('.md-code')!;
    expect(block.getAttribute('data-mermaid')).toBe('error');
    expect(block.querySelector('.md-mermaid-svg')).toBeNull();
    expect(block.querySelector('pre code')!.textContent).toContain('not a diagram');
    expect(block.querySelector('.md-mermaid-toggle')).toBeNull();
  });

  it('非 mermaid 代码块不增强；幂等：重复扫描不重复插按钮/SVG', async () => {
    renderMock.mockResolvedValue('<svg></svg>');
    const root = mount('```js\nconst a = 1;\n```\n\n```mermaid\ngraph TD;A-->B;\n```');
    enhanceMermaid(root);
    enhanceMermaid(root);
    await vi.waitFor(() => expect(root.querySelectorAll('.md-mermaid-svg').length).toBe(1));
    const blocks = root.querySelectorAll<HTMLElement>('.md-code');
    expect(blocks[0].hasAttribute('data-mermaid')).toBe(false); // js 块原样
    expect(blocks[1].querySelectorAll('.md-mermaid-toggle').length).toBe(1);
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it('语言标注大小写不敏感（Mermaid 也认）', () => {
    renderMock.mockResolvedValue('<svg></svg>');
    const root = mount('```Mermaid\ngraph TD;A-->B;\n```');
    enhanceMermaid(root);
    expect(root.querySelector('[data-mermaid]')).toBeTruthy();
  });
});
