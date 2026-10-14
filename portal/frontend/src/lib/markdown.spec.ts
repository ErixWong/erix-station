// markdown.ts 单测（issue #61 P4）：旧 portal/test/markdown.test.js（测 static/markdown.js）
// 的关键用例移植——HTML 转义/防 XSS 红线 + 基础块级/行内渲染。
// 直接 import 导出（vitest），不再走 node:vm 沙箱；旧文件的 index.html addMessage 集成用例
// 已由 workbench store / StreamPanel 侧的 SPA 测试承接，不在此重复。
// issue #285 R-1 补：裸 URL 自动链接（「裸 URL 自动链接」describe）+ 它在 XSS 红线里的对应项。
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

/** 危险信号：输出里存在「带 on* 事件的 HTML 标签」（XSS 判据）。 */
const hasScriptableTag = (html: string): boolean => /<[a-zA-Z][^>]*\son[a-zA-Z]+\s*=/i.test(html);

/** 期望的 <a>：target / rel 逐字（markdown 链接与裸 URL 自动链接共用一套口径）。 */
const link = (href: string, text = href): string =>
  '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
const countAnchors = (html: string): number => (html.match(/<a\b/g) ?? []).length;
/** <a> 套 <a>：自动链接把已生成链接的 href / 文本再链一次的产物形状。 */
const hasNestedAnchor = (html: string): boolean => /<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/.test(html);

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

describe('裸 URL 自动链接（issue #285 R-1：助手回复里的裸 URL 在 SPA 里必须可点）', () => {
  it('裸 http / https 自动成链，target/rel 逐字', () => {
    expect(renderMarkdown('见 http://a.example/x 继续')).toBe('<p>见 ' + link('http://a.example/x') + ' 继续</p>');
    expect(renderMarkdown('https://example.com/a?x=1')).toBe('<p>' + link('https://example.com/a?x=1') + '</p>');
    // 大写协议照放行（与 markdown 链接的 /^https?:\/\//i 口径一致）
    expect(renderMarkdown('HTTP://X.EXAMPLE/P')).toBe('<p>' + link('HTTP://X.EXAMPLE/P') + '</p>');
    // 协议头后面必须是 `://`，`httpx://` / `httpexample` 不算
    expect(renderMarkdown('httpx://a.example/x')).toBe('<p>httpx://a.example/x</p>');
    expect(renderMarkdown('见 httpexample/x 继续')).toBe('<p>见 httpexample/x 继续</p>');
    expect(hasNestedAnchor(renderMarkdown('http://a.example/x http://b.example/y'))).toBe(false);
  });

  it('真机标本形状：列表项里的 `- **http://…**`，链接在 </strong> 前自然停下', () => {
    const url = 'http://acc019-p-22061.fde.erix.vip:8090';
    expect(renderMarkdown('- **' + url + '**'))
      .toBe('<ul><li><strong>' + link(url) + '</strong></li></ul>');
    expect(renderMarkdown('**' + url + '**')).toBe('<p><strong>' + link(url) + '</strong></p>');
    // 右边界靠「URL 字符类不吃裸 <」：粗体已把 ** 换成 <strong>…</strong>，自动链接到 < 就停；
    // 转义产物 &lt;/&amp; 里没有裸 <，不会误停（下一用例验证）。
    expect(renderMarkdown('- 预览：**' + url + '**（已起）'))
      .toBe('<ul><li>预览：<strong>' + link(url) + '</strong>（已起）</li></ul>');
    // 转义产物 `&lt;` 里没有裸 <：它跟着进 href，不会让链接提前截断；行尾的 `&gt;` 当尾标点剥掉
    expect(renderMarkdown('见 http://a.example/x?a=<b> 尾'))
      .toBe('<p>见 ' + link('http://a.example/x?a=&lt;b') + '&gt; 尾</p>');
  });

  it('行内代码与围栏代码块里的 URL 不链', () => {
    expect(renderMarkdown('跑 `http://x.example/y` 一下')).toBe('<p>跑 <code>http://x.example/y</code> 一下</p>');
    expect(renderMarkdown('`http://in.code` 和 http://out.code'))
      .toBe('<p><code>http://in.code</code> 和 ' + link('http://out.code') + '</p>');
    const fence = renderMarkdown('```\nhttp://x.example/y\n```');
    expect(fence).toBe('<div class="md-code"><pre><code>http://x.example/y</code></pre></div>');
    expect(countAnchors(fence)).toBe(0);
  });

  it('markdown 链接不被二次包裹：<a> 只出现 1 次、不嵌套', () => {
    const one = renderMarkdown('[http://a.example/x](http://a.example/x)');
    expect(one).toBe('<p>' + link('http://a.example/x') + '</p>');
    expect(countAnchors(one)).toBe(1);
    expect(hasNestedAnchor(one)).toBe(false);
    // 已生成的 <a href="http://…"> 里那段裸 URL 不会被再链一次
    const mixed = renderMarkdown('[站点](https://example.com/a?x=1&y=2) 旁见 http://b.example/z');
    expect(mixed).toBe('<p>' + link('https://example.com/a?x=1&amp;y=2', '站点') + ' 旁见 ' + link('http://b.example/z') + '</p>');
    expect(hasNestedAnchor(mixed)).toBe(false);
    // 紧贴 markdown 链接的裸 URL：链接占位符字符不进 URL 字符集
    const adj = renderMarkdown('http://a.example[链接](https://b.example)');
    expect(adj).toBe('<p>' + link('http://a.example') + link('https://b.example', '链接') + '</p>');
    expect(countAnchors(adj)).toBe(2);
    expect(hasNestedAnchor(adj)).toBe(false);
  });

  it('还原顺序：链接占位先还原、行内代码占位后还原（否则链接文本里的 <code> 会漏出乱码）', () => {
    expect(renderMarkdown('[`click`](http://x.example/a)')).toBe('<p>' + link('http://x.example/a', '<code>click</code>') + '</p>');
  });

  it('尾部英文标点不算进 href，剥下来留在正文', () => {
    const cases: [string, string][] = [
      ['见 http://a.example/x.', '见 ' + link('http://a.example/x') + '.'],
      ['(http://a.example/x)', '(' + link('http://a.example/x') + ')'],
      ['http://x.example/a,', link('http://x.example/a') + ','],
      ['http://x.example/a;', link('http://x.example/a') + ';'],
      ['http://x.example/b:', link('http://x.example/b') + ':'],
      ['http://x.example/c!', link('http://x.example/c') + '!'],
      ['http://x.example/d?', link('http://x.example/d') + '?'],
      ['他说"http://x.example/e"', '他说&quot;' + link('http://x.example/e') + '&quot;'],
      ["和 'http://x.example/f'", '和 &#39;' + link('http://x.example/f') + '&#39;'],
      ['http://x.example/g>', link('http://x.example/g') + '&gt;'],
      ['多个 http://a.example/x.，http://b.example/y!', '多个 ' + link('http://a.example/x') + '.，' + link('http://b.example/y') + '!'],
    ];
    for (const [src, want] of cases) {
      expect(renderMarkdown(src), src).toBe('<p>' + want + '</p>');
      expect(hasNestedAnchor(renderMarkdown(src)), src).toBe(false);
    }
  });

  it('中文 / 全角标点不进 href（URL 字符集限定 ASCII，与 cmark-gfm・linkify-it 同口径）', () => {
    expect(renderMarkdown('地址 http://x.example/g，端口 8090。'))
      .toBe('<p>地址 ' + link('http://x.example/g') + '，端口 8090。</p>');
    expect(renderMarkdown('http://x.example/h、http://x.example/i）】》'))
      .toBe('<p>' + link('http://x.example/h') + '、' + link('http://x.example/i') + '）】》</p>');
    expect(renderMarkdown('看 http://x.example/j。很好的'))
      .toBe('<p>看 ' + link('http://x.example/j') + '。很好的</p>');
  });

  it('&amp; 实体完整留在 href 与文本里（不把 amp; 当尾标点剥掉）', () => {
    const out = renderMarkdown('http://x.example/s?a=1&b=2');
    expect(out).toBe('<p>' + link('http://x.example/s?a=1&amp;b=2') + '</p>');
    expect(out.match(/&amp;/g)).toHaveLength(2); // href 一只 + 链文本一只
    expect(out).not.toContain('&amp;amp');       // 没有被重复转义
    // URL 以 `&` 收尾（转义成 &amp;）：那个 `;` 属于实体，不是句末分号
    expect(renderMarkdown('http://x.example/s?a=1&')).toBe('<p>' + link('http://x.example/s?a=1&amp;') + '</p>');
  });

  it('协议白名单：javascript: / data: / file: / 裸 www. / mailto: 一律保持纯文本', () => {
    for (const src of [
      'javascript:alert(1)', 'data:text/html,PHN2Zz4=', 'file:///etc/passwd',
      'www.example.com', 'mailto:a@b.example', 'ftp://h.example/f', '邮箱 a.b@c.example',
    ]) {
      const out = renderMarkdown(src);
      expect(out, src).toBe('<p>' + src + '</p>');
      expect(countAnchors(out), src).toBe(0);
    }
  });

  it('标题 / 表格单元格里的裸 URL 同样成链（它们走同一个 inline()）', () => {
    expect(renderMarkdown('## 预览 http://x.example:8090'))
      .toBe('<h2>预览 ' + link('http://x.example:8090') + '</h2>');
    expect(renderMarkdown('| 名称 | 地址 |\n|---|---|\n| 预览 | http://x.example:8090 |'))
      .toBe('<table><thead><tr><th>名称</th><th>地址</th></tr></thead><tbody><tr><td>预览</td><td>'
        + link('http://x.example:8090') + '</td></tr></tbody></table>');
  });

  it('流式容错：末尾半截 URL（无空格/换行）允许先链上，下一帧变长后重链', () => {
    expect(renderMarkdown('见 http://acc019-p-22061')).toBe('<p>见 ' + link('http://acc019-p-22061') + '</p>');
    // 只有协议头、后面什么都没有时不链（也不为此引入任何跳帧状态）
    expect(renderMarkdown('见 http://')).toBe('<p>见 http://</p>');
  });

  it('回归护栏：无裸 URL 的输入输出与改动前逐字相同', () => {
    const golden: [string, string][] = [
      ['纯文本一句话，带标点。', '<p>纯文本一句话，带标点。</p>'],
      ['段落 **粗** 与 *斜* 与 `代码`。', '<p>段落 <strong>粗</strong> 与 <em>斜</em> 与 <code>代码</code>。</p>'],
      ['- 项目一 **加粗**\n- 项目二', '<ul><li>项目一 <strong>加粗</strong></li><li>项目二</li></ul>'],
      ['> 引用 `x`', '<blockquote><p>引用 <code>x</code></p></blockquote>'],
      ['| a | b |\n| --- | :---: |\n| 1 | 2 |', '<table><thead><tr><th>a</th><th style="text-align:center">b</th></tr></thead><tbody><tr><td>1</td><td style="text-align:center">2</td></tr></tbody></table>'],
      ['[站点](https://example.com/a?x=1&y=2)', '<p>' + link('https://example.com/a?x=1&amp;y=2', '站点') + '</p>'],
      ['没有协议 www.example.com 不动', '<p>没有协议 www.example.com 不动</p>'],
      ['`http://inside.code/x`', '<p><code>http://inside.code/x</code></p>'],
      ['```\n# http://in.fence/x\n```', '<div class="md-code"><pre><code># http://in.fence/x</code></pre></div>'],
      ['<img src=x onerror=alert(1)>', '<p>&lt;img src=x onerror=alert(1)&gt;</p>'],
      ['## 标题里没有 URL', '<h2>标题里没有 URL</h2>'],
    ];
    for (const [src, want] of golden) expect(renderMarkdown(src), src).toBe(want);
    for (const src of ['没有协议 www.example.com 不动', '`http://inside.code/x`', '```\n# http://in.fence/x\n```']) {
      expect(countAnchors(renderMarkdown(src)), src).toBe(0);
    }
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

  it('裸 URL 自动链接不产出可执行属性 / 标签（href 沿用转义形态）', () => {
    const q = renderMarkdown('http://x/"onmouseover="alert(1)');
    expect(hasScriptableTag(q)).toBe(false);
    expect(q.match(/ href="/g)).toHaveLength(1); // 只有一只能控的 href
    expect(q).not.toContain('"onmouseover');      // 引号已转义 → 不可能出现裸引号 + on*=
    expect(q).toContain('&quot;onmouseover');

    const e = renderMarkdown('http://x/&#60;script&#62;');
    expect(hasScriptableTag(e)).toBe(false);
    expect(e).not.toContain('<script');
    expect(e).toContain('&amp;#60;script&amp;#62');

    const mix = renderMarkdown('http://x.example/<img src=y onerror=alert(1)>');
    expect(hasScriptableTag(mix)).toBe(false);
    expect(mix).not.toContain('<img');
    expect(mix).toBe('<p>' + link('http://x.example/&lt;img') + ' src=y onerror=alert(1)&gt;</p>');
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

// ---- 重烧单 fix-261014-04-md-autolink 的补充面（上面那个 describe 之外的形状与差分护栏）----
describe('裸 URL 自动链接：补充形状与已知边界', () => {
  it('斜体 / 引用 / 粗体包 markdown 链接 / 链文本里含裸 URL', () => {
    const url = 'http://acc019-p-22061.fde.erix.vip:8090';
    expect(renderMarkdown('*' + url + '*')).toBe('<p><em>' + link(url) + '</em></p>');
    expect(renderMarkdown('> ' + url)).toBe('<blockquote><p>' + link(url) + '</p></blockquote>');
    expect(renderMarkdown('**[站点](https://b.example)**'))
      .toBe('<p><strong>' + link('https://b.example', '站点') + '</strong></p>');
    // 链文本里本身就有一段裸 URL：整只 <a> 先占位 ⇒ 里面那段不会再被链一次
    const inner = renderMarkdown('[see http://a.example/x](http://b.example/y)');
    expect(inner).toBe('<p>' + link('http://b.example/y', 'see http://a.example/x') + '</p>');
    expect(countAnchors(inner)).toBe(1);
    expect(hasNestedAnchor(inner)).toBe(false);
    // 裸 URL 与 markdown 链接以空格相邻：各自成链、互不吸收
    const two = renderMarkdown('http://a.example [站点](https://b.example)');
    expect(two).toBe('<p>' + link('http://a.example') + ' ' + link('https://b.example', '站点') + '</p>');
    expect(countAnchors(two)).toBe(2);
    expect(hasNestedAnchor(two)).toBe(false);
  });

  it('尾部标点补充形状：引号实体与中文标点混排（剥下来的是转义形态）', () => {
    expect(renderMarkdown('它写着\'http://x.example/h\'。'))
      .toBe('<p>它写着&#39;' + link('http://x.example/h') + '&#39;。</p>');
    expect(renderMarkdown('【 http://x.example/l】')).toBe('<p>【 ' + link('http://x.example/l') + '】</p>');
    expect(renderMarkdown('跳 http://x.example/f: 后面')).toBe('<p>跳 ' + link('http://x.example/f') + ': 后面</p>');
    expect(renderMarkdown('地址 http://x.example/k：')).toBe('<p>地址 ' + link('http://x.example/k') + '：</p>');
    expect(renderMarkdown('两个 http://x.example/m、http://x.example/n'))
      .toBe('<p>两个 ' + link('http://x.example/m') + '、' + link('http://x.example/n') + '</p>');
  });

  it('剥尾标点不许留下断实体（&lt; / &amp; / &quot; 必须整只，要么整只剥走）', () => {
    for (const src of ['http://x.example/s?a=1&b=2', 'http://x.example/s?a=1&', 'http://x.example/s?a=1&b=2。',
      'http://x/?a=<b>', 'http://x/<script>alert(1)</script>', 'http://x/"onmouseover="alert(1)']) {
      expect(renderMarkdown(src), src).not.toMatch(/&(?:amp|lt|gt|quot|#39)(?!;)/);
    }
  });

  it('XSS 补充：整只 <script> 尾巴、以及被空格开断的「URL + on*= 文本」', () => {
    const s = renderMarkdown('http://x/<script>alert(1)</script>');
    expect(s).not.toContain('<script');
    expect(s).toContain('&lt;script&gt;');
    expect(hasScriptableTag(s)).toBe(false);
    expect(countAnchors(s)).toBe(1);
    // `"` 被转义成 &quot; 后仍算尾部标点 ⇒ 剥回正文，且没造出第二个标签
    const inj = renderMarkdown('http://x/" onMouseover="alert(1)');
    expect(hasScriptableTag(inj)).toBe(false);
    expect(inj).toBe('<p>' + link('http://x/') + '&quot; onMouseover=&quot;alert(1)</p>');
  });

  it('已知边界（故意保留的行为，动它之前先读 markdown.ts 的头注）', () => {
    // 非 ASCII 不进 URL ⇒ 未百分号编码的中文路径会截断（cmark-gfm / linkify-it 同口径）
    expect(renderMarkdown('http://x.example/中文')).toBe('<p>' + link('http://x.example/') + '中文</p>');
    // 只有协议头 + 一个标点：剥完连 host 都不剩，仍然链出去（无害的畸形链接，不为此加规则）
    expect(renderMarkdown('见 http://.')).toBe('<p>见 ' + link('http://') + '.</p>');
    // 流式：末尾半截 URL 先链上，下一帧变长后整段重链（不给渲染器引入跨帧状态）
    expect(renderMarkdown('见 http://acc019-p-22061')).toBe('<p>见 ' + link('http://acc019-p-22061') + '</p>');
  });
});

describe('回归护栏：HEAD（e61a035）语料逐字不变', () => {
  // 下面每一条 want 都是**用 HEAD 那份 markdown.ts 实跑出来的输出**（`git show e61a035:…` 复制成
  // 临时模块后跑新旧 diff 得到），不是新实现自己的输出 ⇒ 钉的是「不含裸 URL 的输入一个字都没抖」。
  const GOLDEN: [string, string][] = [
    ['', ''],
    ['   ', ''],
    ['纯文本一句话，带标点。', '<p>纯文本一句话，带标点。</p>'],
    ['# 标题 ##\n\n段落 **粗** 与 *斜* 与 `代码`。',
      '<h1>标题</h1>\n<p>段落 <strong>粗</strong> 与 <em>斜</em> 与 <code>代码</code>。</p>'],
    ['- 项目一\n- 项目二 **加粗**\n\n1. 甲\n2. 乙',
      '<ul><li>项目一</li><li>项目二 <strong>加粗</strong></li></ul>\n<ol><li>甲</li><li>乙</li></ol>'],
    ['| a | b |\n| --- | :-: |\n| 1 | 2 |',
      '<table><thead><tr><th>a</th><th style="text-align:center">b</th></tr></thead><tbody><tr><td>1</td><td style="text-align:center">2</td></tr></tbody></table>'],
    ['> 引用一层\n>> 两层 `x`',
      '<blockquote><p>引用一层</p>\n<blockquote><p>两层 <code>x</code></p></blockquote></blockquote>'],
    ['```js\nconst a = 1 < 2 && "x";\n```',
      '<div class="md-code"><div class="md-lang">js</div><pre><code>const a = 1 &lt; 2 &amp;&amp; &quot;x&quot;;</code></pre></div>'],
    ['行内 `http://inside.code/y` 不该动', '<p>行内 <code>http://inside.code/y</code> 不该动</p>'],
    ['[站点](https://example.com/a?x=1&y=2)', '<p>' + link('https://example.com/a?x=1&amp;y=2', '站点') + '</p>'],
    // 非 http(s) 协议退化成纯文本——旧行为连那个右括号都多留着，本单不改它（钉住现状）
    ['[点我](javascript:alert(1))', '<p>点我)</p>'],
    ['<img src=x onerror=alert(1)>', '<p>&lt;img src=x onerror=alert(1)&gt;</p>'],
    ['**粗** _斜_ *** both *** __u__ 尾',
      '<p><strong>粗</strong> <em>斜</em> <strong><em> both </em></strong> <strong>u</strong> 尾</p>'],
    ['邮箱 a.b@example.com 与 www.example.com 保持纯文本',
      '<p>邮箱 a.b@example.com 与 www.example.com 保持纯文本</p>'],
    ['未闭合围栏\n```\nraw <b> text',
      '<p>未闭合围栏</p>\n<div class="md-code"><pre><code>raw &lt;b&gt; text</code></pre></div>'],
  ];

  it('逐字相等', () => {
    for (const [src, want] of GOLDEN) {
      expect(renderMarkdown(src), src).toBe(want);
      // 附带 <a> 数量比对：旧输出里出现几只 <a>，新输出就必须还是几只
      expect(countAnchors(renderMarkdown(src)), src).toBe(countAnchors(want));
    }
  });
});
