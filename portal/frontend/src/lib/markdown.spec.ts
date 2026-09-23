// markdown.ts 单测（issue #61 P4）：旧 portal/test/markdown.test.js（测 static/markdown.js）
// 的关键用例移植——HTML 转义/防 XSS 红线 + 基础块级/行内渲染。
// 直接 import 导出（vitest），不再走 node:vm 沙箱；旧文件的 index.html addMessage 集成用例
// 已由 workbench store / StreamPanel 侧的 SPA 测试承接，不在此重复。
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

/** 危险信号：输出里存在「带 on* 事件的 HTML 标签」（XSS 判据）。 */
const hasScriptableTag = (html: string): boolean => /<[a-zA-Z][^>]*\son[a-zA-Z]+\s*=/i.test(html);

describe('块级元素', () => {
  it('标题：#~###### 渲染对应级别，支持闭合 #', () => {
    expect(renderMarkdown('# 一级')).toBe('<h1>一级</h1>');
    expect(renderMarkdown('###### 六级')).toBe('<h6>六级</h6>');
    expect(renderMarkdown('## 标题 ##')).toBe('<h2>标题</h2>');
    expect(renderMarkdown('#nospace 不渲染')).toBe('<p>#nospace 不渲染</p>');
  });

  it('围栏代码块：语言标注 + 内容转义 + 未闭合容错', () => {
    const out = renderMarkdown('```js\nconst a = 1 < 2 && "x";\n```');
    expect(out).toContain('<div class="md-code">');
    expect(out).toContain('<div class="md-lang">js</div>');
    expect(out).toContain('const a = 1 &lt; 2 &amp;&amp; &quot;x&quot;;');
    // 流式降级：半截围栏吞到文末收尾，产出闭合结构
    const half = renderMarkdown('```js\nunclosed');
    expect(half).toContain('md-lang">js<');
    expect(half).toContain('unclosed</code></pre></div>');
    expect(hasScriptableTag(half)).toBe(false);
  });

  it('无序 / 有序列表', () => {
    expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderMarkdown('* a\n+ b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderMarkdown('1. 一\n2. 二')).toBe('<ol><li>一</li><li>二</li></ol>');
  });

  it('表格：表头 / 分隔行对齐 / 数据行继承列对齐', () => {
    const out = renderMarkdown('| 名称 | 数量 | 单价 |\n| :--- | :---: | ---: |\n| 苹果 | 2 | 3 |');
    expect(out.startsWith('<table><thead><tr>')).toBe(true);
    expect(out).toContain('<th style="text-align:left">名称</th>');
    expect(out).toContain('<th style="text-align:center">数量</th>');
    expect(out).toContain('<th style="text-align:right">单价</th>');
    expect(out).toContain('<td style="text-align:left">苹果</td>');
  });

  it('引用：多行合并 + 嵌套递归', () => {
    expect(renderMarkdown('> a\n> b')).toBe('<blockquote><p>a b</p></blockquote>');
    expect(renderMarkdown('> # 标题')).toBe('<blockquote><h1>标题</h1></blockquote>');
  });
});

describe('行内格式', () => {
  it('行内代码：内部不做格式替换（防代码里的 * 被格式化）', () => {
    const out = renderMarkdown('前缀 `a * b ** c` 后缀');
    expect(out).toContain('<code>a * b ** c</code>');
    expect(out).not.toContain('<em>a');
  });

  it('粗体 / 斜体 / 粗斜体', () => {
    expect(renderMarkdown('**粗**')).toBe('<p><strong>粗</strong></p>');
    expect(renderMarkdown('*斜*')).toBe('<p><em>斜</em></p>');
    expect(renderMarkdown('***既粗又斜***')).toBe('<p><strong><em>既粗又斜</em></strong></p>');
    expect(renderMarkdown('__粗__ 与 _斜_')).toBe('<p><strong>粗</strong> 与 <em>斜</em></p>');
  });

  it('链接：仅放行 http(s)，带 target=_blank rel=noopener noreferrer', () => {
    const ok = renderMarkdown('[站点](https://example.com/a?x=1&y=2)');
    expect(ok).toContain('<a href="https://example.com/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">站点</a>');
    // javascript: 协议 → 退化为纯文本，不产生 <a>
    const bad = renderMarkdown('[点我](javascript:alert(1))');
    expect(bad).not.toContain('<a ');
    expect(bad).not.toContain('javascript:alert');
    const dataUri = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)');
    expect(dataUri).not.toContain('<a ');
  });
});

describe('XSS 红线（先整体转义再格式替换）', () => {
  it("'<img src=x onerror=alert(1)>' 不得产生 img 标签或 on* 属性", () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    expect(hasScriptableTag(out)).toBe(false);
    // 组合拳：链接文本 + 属性逃逸尝试
    const combo = renderMarkdown('["><svg onload=alert(1)>](https://ok.example)');
    expect(hasScriptableTag(combo)).toBe(false);
    expect(combo).not.toContain('<svg');
  });

  it('围栏代码块内的 HTML 同样只作文本', () => {
    const out = renderMarkdown('```\n<script>alert(1)</script>\n```');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(hasScriptableTag(out)).toBe(false);
  });

  it('私用区字符占位符防碰撞：输入中的 <数字> 不被误还原为行内代码', () => {
    const PUA = String.fromCharCode(0xE000);
    // 私用区字符 → 数字实体（&#57344;），占位符不可能来自用户输入
    expect(renderMarkdown(PUA + '0' + PUA)).toBe('<p>&#' + 0xE000 + ';0&#' + 0xE000 + ';</p>');
    // 与真行内代码共存时不误还原
    expect(renderMarkdown('`x` and ' + PUA + '0' + PUA))
      .toBe('<p><code>x</code> and &#' + 0xE000 + ';0&#' + 0xE000 + ';</p>');
    // 私用区字符不得从任何出口漏出原始形态
    expect(renderMarkdown(PUA + '0' + PUA)).not.toContain(PUA);
  });
});
