// portal/static/markdown.js 的 TS 平移（issue #61 P2：不换库，P3 再评估）——
// 零依赖 Markdown 子集渲染器（issue #40），逻辑逐行等价，仅做模块化和类型标注。
//
// 安全红线：**先整体 HTML 转义，再做格式替换**（输出白名单仅含下列标签），任何输入都
// 不可能生成未转义的 < > " ' & → 无属性注入 / 脚本注入面。仅助手终稿使用；用户消息与
// 系统注入（synthetic）保持纯文本，不经过本渲染器。
//
// 支持子集：ATX 标题（#~######，支持闭合 #）、围栏代码块（```/~~~ + 语言标注）、
// 行内代码、粗体/斜体（** __ * _ 及 *** ___）、无序/有序列表（平铺）、表格（含 : 对齐）、
// 链接（仅 http/https，target=_blank rel=noopener noreferrer，其余协议退化为纯文本）、
// 裸 URL 自动链接（issue #285 R-1：GFM 风格，同样只放行 http/https；行内代码与围栏代码
// 内不链、URL 尾部标点不并入 href；`www.` 无协议不链、email/mailto 刻意不做，见 inline()）、
// 引用（>，递归支持嵌套）。
//
// 流式容错：未闭合围栏按「吞到文本末尾」收尾——半截 ``` 不会产出未闭合标签 / 炸布局。

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

// 占位符用私用区字符（\uE000），与用户文本撞车概率忽略不记（碰撞后果也只是文本轻微错位）。
const PLACEHOLDER = (n: number): string => '\uE000' + n + '\uE000';
// 链接占位符另用 U+E001（同在 sanitizePua 的转义区间内）⇒ 与行内代码占位符互不串号。
const LINK_PLACEHOLDER = (n: number): string => '\uE001' + n + '\uE001';

// ---- 裸 URL 自动链接（GFM 风格，issue #285 R-1）----
// 协议白名单：只放行 http(s)（正则本身就是白名单，不匹配的一律保持纯文本）——
// `javascript:alert(1)` / `data:text/html,…` / `file:///etc/passwd` 无 `http(s)://` 开头不链，
// 裸的 `www.example.com`（无协议）也不链（GFM 同样不链）。email/`mailto:` **刻意不做**：
// 邮箱不是本次标本的失败形态，且自动包 mailto 会新开一条 href 协议面，属另一条 scope。
// URL 字符集：可打印 ASCII，再去掉裸 `<`、`>`、引号、反引号、空白与**一切非 ASCII**：
// · 裸 `<` 是我们自己插的标签边界（`**http://x**` 已被粗斜体换成 `<strong>http://x</strong>`
//   ⇒ 自动链接在 `</strong>` 前自然停下）；转义产物 `&lt;`/`&amp;` 里没有裸 `<`，不会误停。
// · 非 ASCII 不入围 ⇒ 中文与全角标点永远不会跟着进 href（`http://x，端口 8090` 只链到 `x`），
//   占位符字符（U+E000/E001）也落在这个排除区间里——它们不可能出现在真 URL 里。
//   cmark-gfm 与 linkify-it 同样把自动链接限定在 ASCII 内（未百分号编码的中文路径会截断）。
const BARE_URL_RE = /https?:\/\/[^\s<>"'`\u0000-\u001f\u007f-\uFFFF]+/gi;

// 尾部标点不算进 href（`见 http://x.` 的句号、`(http://x)` 的右括号、`http://x,` 的逗号、
// 以及 `;` `:` `!` `?` 与引号），剥下来留在正文。中文标点不会走到这里——它们在字符类
// 就被挡在 URL 外了（见上），所以这里只需 ASCII 集合。
const TRAILING_PUNCT = new Set(['.', ',', ';', ':', '!', '?', '>', ')', ']', '}', '"', "'"]);
// esc() 可能产生的实体（esc 是唯一转义出口 ⇒ 集合封闭）。尾部判定按「整只实体当一个
// 字符」做：这样 `http://x?a=1&b=2` 转义后的 `&amp;`（解码是 `&`，不是标点）连同它收尾的
// `;` 会整体留在 URL 里，**不会把 `amp;` 当成尾标点剥掉**；而引号实体 `&quot;`/`&#39;`
// 解码后是引号 ⇒ 整只剥掉（转义后的文本里根本没有裸引号，不这样做就剥不干净）。
const ESC_ENTITY: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const ESC_ENTITIES = Object.keys(ESC_ENTITY);

/** 从自动链接命中的串里剥掉尾部标点：返回 [进 href 的部分, 留在正文的部分]。 */
function splitTrailing(url: string): [string, string] {
  let end = url.length;
  for (;;) {
    const ent = ESC_ENTITIES.find((e) => url.startsWith(e, end - e.length));
    const token = ent ?? url.slice(end - 1, end);
    if (!token || !TRAILING_PUNCT.has(ESC_ENTITY[token] ?? token)) break;
    end -= token.length;
  }
  return [url.slice(0, end), url.slice(end)];
}

// ---- 行内格式（输入为原始文本，内部先转义） ----
// 先把输入里的私用区字符（U+E000–U+F8FF）转成数字实体——占位符才可能
// 不可能来自用户输入（否则 '\uE0000\uE000' 会被误还原成 <code>undefined</code>）。
const sanitizePua = (s: string): string => s.replace(/[\uE000-\uF8FF]/g, (c) => '&#' + c.charCodeAt(0) + ';');

function inline(text: string): string {
  const codes: string[] = [];
  const links: string[] = [];
  let s = sanitizePua(esc(text));
  // 1) 行内代码最先占位：其内部不再做任何格式替换（防 `*` 等在代码里被格式化）
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c);
    return PLACEHOLDER(codes.length - 1);
  });
  // 2) 粗斜体：先 *** 后 ** 再 *（下划线同理，星号与下划线互不越界替换）
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\s](?:[^*]*[^*\s])?)\*/g, '<em>$1</em>');
  s = s.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/_([^_\s](?:[^_]*[^_\s])?)_/g, '<em>$1</em>');
  // 3) markdown 链接：仅放行 http(s)；href 保持转义形态（&amp;），引号已转义 → 无属性逃逸面。
  //    非 http(s) 协议（javascript: data: 等）退化为链接文本纯文本。
  //    ⚠ 产出**先整体占位**、不在 s 里留下真 <a>：否则第 4 步会把已生成的
  //    `<a href="http://…">` 里那段裸 URL 再链一次，做出 <a> 套 <a>。
  s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)\s*\)/g, (_m, t: string, u: string) => {
    const href = u.replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(href)) return t;
    links.push('<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>');
    return LINK_PLACEHOLDER(links.length - 1);
  });
  // 4) 裸 URL 自动链接（issue #285 R-1）：必须排在 markdown 链接占位**之后**、行内代码还原
  //    **之前**——行内代码已占位 ⇒ 代码里的 URL 天然不链；围栏代码块走 esc(buf) 不进 inline，
  //    同样不链。流式容错取舍：末尾没有空格/换行的半截 URL 也允许先链上（下一帧变长后重链），
  //    代价是渲染中途可能闪一下链接，换来的是不必给渲染器引入任何跨帧状态。
  s = s.replace(BARE_URL_RE, (m: string) => {
    const [url, trail] = splitTrailing(m);
    return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>' + trail;
  });
  // 5) 还原链接占位（必须早于代码占位：`[`a`b`](url)` 的文本/href 里可能夹着代码占位符）
  s = s.replace(/\uE001(\d+)\uE001/g, (_m, n: string) => links[Number(n)]);
  // 6) 还原行内代码占位
  s = s.replace(/\uE000(\d+)\uE000/g, (_m, n: string) => '<code>' + codes[Number(n)] + '</code>');
  return s;
}

// ---- 块级解析 ----
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+.#-]*)\s*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const QUOTE_RE = /^>[ \t]?/;
const OL_RE = /^\s*\d+[.)][ \t]+/;
const LI_RE = /^\s*(?:[-*+]|\d+[.)])[ \t]+/;
const TABLE_SEP_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isBlockStart(lines: string[], i: number): boolean {
  const line = lines[i];
  return FENCE_RE.test(line) || HEADING_RE.test(line) || QUOTE_RE.test(line) || LI_RE.test(line)
    || (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]));
}

export function renderMarkdown(src: unknown): string {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块（``` / ~~~ + 语言标注；未闭合 → 吞到文末收尾，流式半截不炸）
    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[1][0];
      const closeRe = new RegExp('^\\s*' + marker + '{3,}\\s*$');
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !closeRe.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 吃掉闭合围栏（EOF 越界也无妨）
      const lang = fence[2] || '';
      out.push(
        '<div class="md-code">'
        + (lang ? '<div class="md-lang">' + esc(lang) + '</div>' : '')
        + '<pre><code>' + esc(buf.join('\n')) + '</code></pre></div>',
      );
      continue;
    }

    if (!/\S/.test(line)) { i += 1; continue; }

    // ATX 标题（剥离闭合 #）
    const h = line.match(HEADING_RE);
    if (h) {
      const lv = h[1].length;
      out.push('<h' + lv + '>' + inline(h[2].replace(/[ \t]+#+$/, '')) + '</h' + lv + '>');
      i += 1;
      continue;
    }

    // 引用（内部递归渲染，天然支持嵌套 >）
    if (QUOTE_RE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        buf.push(lines[i].replace(QUOTE_RE, ''));
        i += 1;
      }
      out.push('<blockquote>' + renderMarkdown(buf.join('\n')) + '</blockquote>');
      continue;
    }

    // 表格：当前行含 | 且下一行是 |---| 分隔行（支持 :---: 对齐标注）
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /\S/.test(lines[i]) && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      const alignAttr = (k: number) => (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '');
      const ths = header.map((c, k) => '<th' + alignAttr(k) + '>' + inline(c) + '</th>').join('');
      const trs = rows
        .map((r) => '<tr>' + r.map((c, k) => '<td' + alignAttr(k) + '>' + inline(c) + '</td>').join('') + '</tr>')
        .join('');
      out.push('<table><thead><tr>' + ths + '</tr></thead><tbody>' + trs + '</tbody></table>');
      continue;
    }

    // 无序 / 有序列表（连续列表行并入同一列表；数字起始 → <ol>）
    if (LI_RE.test(line)) {
      const ordered = OL_RE.test(line);
      const buf: string[] = [];
      while (i < lines.length && LI_RE.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*(?:[-*+]|\d+[.)])[ \t]+/, ''));
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push('<' + tag + '>' + buf.map((c) => '<li>' + inline(c) + '</li>').join('') + '</' + tag + '>');
      continue;
    }

    // 段落：吞到空行或下一个块起点
    const buf = [line];
    i += 1;
    while (i < lines.length && /\S/.test(lines[i]) && !isBlockStart(lines, i)) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push('<p>' + inline(buf.join(' ')) + '</p>');
  }
  return out.join('\n');
}
