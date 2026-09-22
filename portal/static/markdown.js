// portal/static/markdown.js —— 零依赖 Markdown 子集渲染器（issue #40）。
//
// 安全红线：**先整体 HTML 转义，再做格式替换**（输出白名单仅含下列标签），任何输入都
// 不可能生成未转义的 < > " ' & → 无属性注入 / 脚本注入面。仅助手终稿使用；用户消息与
// 系统注入（synthetic）在 index.html 里保持 textContent 纯文本，不经过本渲染器。
//
// 支持子集：ATX 标题（#~######，支持闭合 #）、围栏代码块（```/~~~ + 语言标注）、
// 行内代码、粗体/斜体（** __ * _ 及 *** ___）、无序/有序列表（平铺）、表格（含 : 对齐）、
// 链接（仅 http/https，target=_blank rel=noopener noreferrer，其余协议退化为纯文本）、
// 引用（>，递归支持嵌套）。
//
// 流式容错：未闭合围栏按「吞到文本末尾」收尾——半截 ``` 不会产出未闭合标签 / 炸布局
// （delta 期间前端仍用 textContent 追加，run_end 终稿才整体渲染，双保险）。
(function () {
  'use strict';

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  // 占位符用私用区字符（\uE000），与用户文本撞车概率忽略不记（碰撞后果也只是文本轻微错位）。
  const PLACEHOLDER = (n) => '\uE000' + n + '\uE000';

  // ---- 行内格式（输入为原始文本，内部先转义） ----
  // 评审 LOW-2：先把输入里的私用区字符（U+E000–U+F8FF）转成数字实体——占位符才可能
  // 不可能来自用户输入（否则 '\uE0000\uE000' 会被误还原成 <code>undefined</code>）。
  const sanitizePua = (s) => s.replace(/[\uE000-\uF8FF]/g, (c) => '&#' + c.charCodeAt(0) + ';');

  function inline(text) {
    const codes = [];
    let s = sanitizePua(esc(text));
    // 1) 行内代码最先占位：其内部不再做任何格式替换（防 `*` 等在代码里被格式化）
    s = s.replace(/`([^`]+)`/g, (_m, c) => {
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
    // 3) 链接：仅放行 http(s)；href 保持转义形态（&amp;），引号已转义 → 无属性逃逸面。
    //    非 http(s) 协议（javascript: data: 等）退化为链接文本纯文本。
    s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)\s*\)/g, (_m, t, u) => {
      const href = u.replace(/&amp;/g, '&');
      if (!/^https?:\/\//i.test(href)) return t;
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
    });
    // 4) 还原行内代码占位
    s = s.replace(/\uE000(\d+)\uE000/g, (_m, n) => '<code>' + codes[Number(n)] + '</code>');
    return s;
  }

  // ---- 块级解析 ----
  const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+.#-]*)\s*$/;
  const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
  const QUOTE_RE = /^>[ \t]?/;
  const UL_RE = /^\s*[-*+][ \t]+/;
  const OL_RE = /^\s*\d+[.)][ \t]+/;
  const LI_RE = /^\s*(?:[-*+]|\d+[.)])[ \t]+/;
  const TABLE_SEP_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  }

  function isBlockStart(lines, i) {
    const line = lines[i];
    return FENCE_RE.test(line) || HEADING_RE.test(line) || QUOTE_RE.test(line) || LI_RE.test(line)
      || (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]));
  }

  function render(src) {
    const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // 围栏代码块（``` / ~~~ + 语言标注；未闭合 → 吞到文末收尾，流式半截不炸）
      const fence = line.match(FENCE_RE);
      if (fence) {
        const marker = fence[1][0];
        const closeRe = new RegExp('^\\s*' + marker + '{3,}\\s*$');
        const buf = [];
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
        const buf = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) {
          buf.push(lines[i].replace(QUOTE_RE, ''));
          i += 1;
        }
        out.push('<blockquote>' + render(buf.join('\n')) + '</blockquote>');
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
        const rows = [];
        while (i < lines.length && /\S/.test(lines[i]) && lines[i].includes('|')) {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        const alignAttr = (k) => (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '');
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
        const buf = [];
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

  globalThis.renderMarkdown = render;
})();
