// 单测：portal/static/markdown.js —— 零依赖 Markdown 子集渲染器（issue #40）。
// 核心用例：标题 / 围栏代码块（语言标注 + 转义）/ 行内代码 / 粗斜体 / 列表 / 表格 /
// 链接白名单（仅 http(s)）/ XSS 转义 / 未闭合围栏容错 / 与 index.html addMessage 集成。
// 前端无构建步骤，故用 node:vm 进程内加载脚本（零额外依赖，不起浏览器）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../static');

/** 加载 markdown.js（+ 可选 index.html 内联脚本）到独立 sandbox，返回可调用绑定。 */
function loadClient({ withIndex = false, dropRenderer = false, fetchImpl = null } = {}) {
  const els = new Map();
  const document = {
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); },
    createElement() { return makeEl(); },
    // issue #55：前端用到 document.body.classList（抽屉）与 document.hidden（通知）
    body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    hidden: false,
  };
  const sandbox = {
    document,
    fetch: fetchImpl ?? (async () => { throw new Error('fetch 在单测中禁用'); }),
    // issue #55：前端用到 window（popstate）/history（hash 深链）/location.hash 等浏览器 API
    window: { addEventListener() {}, focus() {} },
    history: { pushState() {}, replaceState() {} },
    location: { reload() {}, hash: '', pathname: '/', search: '' },
    alert() {}, prompt() { return null; },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  const ctx = vm.createContext(sandbox);
  if (!dropRenderer) {
    vm.runInContext(fs.readFileSync(path.join(STATIC_DIR, 'markdown.js'), 'utf8'), ctx);
  }
  if (withIndex) {
    const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'index.html 应含内联脚本');
    vm.runInContext(m[1] + '\n;globalThis.__client = { S, addMessage, loadSessions };', ctx);
  }
  return { render: ctx.renderMarkdown ?? sandbox.renderMarkdown, client: ctx.__client, elements: els };
}

function makeEl() {
  return {
    style: {}, dataset: {}, textContent: '', innerHTML: '', value: '', disabled: false,
    scrollTop: 0, scrollHeight: 0,
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild() {}, remove() {},
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    addEventListener() {},
  };
}

/** 危险信号：输出里存在「带 on* 事件的 HTML 标签」（XSS 判据）。 */
const hasScriptableTag = (html) => /<[a-zA-Z][^>]*\son[a-zA-Z]+\s*=/i.test(html);

// ---------------------------------------------------------------------------
// 块级元素
// ---------------------------------------------------------------------------

test('标题：#~###### 渲染对应级别，支持闭合 #', () => {
  const { render } = loadClient();
  assert.equal(render('# 一级'), '<h1>一级</h1>');
  assert.equal(render('###### 六级'), '<h6>六级</h6>');
  assert.equal(render('## 标题 ##'), '<h2>标题</h2>');
  assert.equal(render('#nospace 不渲染'), '<p>#nospace 不渲染</p>', '无空格非标题');
});

test('围栏代码块：语言标注 + 内容转义 + 未闭合容错', () => {
  const { render } = loadClient();
  const out = render('```js\nconst a = 1 < 2 && "x";\n```');
  assert.ok(out.includes('<div class="md-code">'));
  assert.ok(out.includes('<div class="md-lang">js</div>'));
  assert.ok(out.includes('const a = 1 &lt; 2 &amp;&amp; &quot;x&quot;;'), '代码内容必须转义');
  // 流式降级：半截围栏吞到文末收尾，产出闭合结构
  const half = render('```js\nunclosed');
  assert.ok(half.includes('md-lang">js<'));
  assert.ok(half.includes('unclosed</code></pre></div>'), '未闭合围栏也要有闭合标签');
  assert.ok(!hasScriptableTag(half));
});

test('行内代码：内部不做格式替换（防代码里的 * 被格式化）', () => {
  const { render } = loadClient();
  const out = render('前缀 `a * b ** c` 后缀');
  assert.ok(out.includes('<code>a * b ** c</code>'));
  assert.ok(!out.includes('<em>a'), '代码内部不得格式化');
});

test('粗体 / 斜体 / 粗斜体', () => {
  const { render } = loadClient();
  assert.equal(render('**粗**'), '<p><strong>粗</strong></p>');
  assert.equal(render('*斜*'), '<p><em>斜</em></p>');
  assert.equal(render('***既粗又斜***'), '<p><strong><em>既粗又斜</em></strong></p>');
  assert.equal(render('__粗__ 与 _斜_'), '<p><strong>粗</strong> 与 <em>斜</em></p>');
});

test('无序 / 有序列表', () => {
  const { render } = loadClient();
  assert.equal(render('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(render('* a\n+ b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(render('1. 一\n2. 二'), '<ol><li>一</li><li>二</li></ol>');
});

test('表格：表头 / 分隔行对齐 / 单元格', () => {
  const { render } = loadClient();
  const out = render('| 名称 | 数量 | 单价 |\n| :--- | :---: | ---: |\n| 苹果 | 2 | 3 |');
  assert.ok(out.startsWith('<table><thead><tr>'));
  assert.ok(out.includes('<th style="text-align:left">名称</th>'));
  assert.ok(out.includes('<th style="text-align:center">数量</th>'));
  assert.ok(out.includes('<th style="text-align:right">单价</th>'));
  assert.ok(out.includes('<td style="text-align:left">苹果</td>'), '数据行继承列对齐');
});

test('引用：多行合并 + 嵌套递归', () => {
  const { render } = loadClient();
  assert.equal(render('> a\n> b'), '<blockquote><p>a b</p></blockquote>');
  assert.equal(render('> # 标题'), '<blockquote><h1>标题</h1></blockquote>');
});

// ---------------------------------------------------------------------------
// 链接白名单与 XSS 红线
// ---------------------------------------------------------------------------

test('链接：仅放行 http(s)，带 target=_blank rel=noopener noreferrer', () => {
  const { render } = loadClient();
  const ok = render('[站点](https://example.com/a?x=1&y=2)');
  assert.ok(ok.includes('<a href="https://example.com/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">站点</a>'));
  // javascript: 协议 → 退化为纯文本，不产生 <a>
  const bad = render('[点我](javascript:alert(1))');
  assert.ok(!bad.includes('<a '), '非 http(s) 不得产生链接');
  assert.ok(!bad.includes('javascript:alert'), '协议串不得原样出现在输出');
  const dataUri = render('[x](data:text/html;base64,PHNjcmlwdD4=)');
  assert.ok(!dataUri.includes('<a '), 'data: 协议同样拒绝');
});

test("XSS：'<img src=x onerror=alert(1)>' 不得产生 onerror 属性", () => {
  const { render } = loadClient();
  const out = render('<img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<img'), '不得产生 img 标签');
  assert.ok(out.includes('&lt;img'), '必须转义为文本');
  assert.ok(!hasScriptableTag(out), '任何标签都不得携带 on* 事件属性');
  // 组合拳：链接文本 + 属性逃逸尝试
  const combo = render('["><svg onload=alert(1)>](https://ok.example)');
  assert.ok(!hasScriptableTag(combo));
  assert.ok(!combo.includes('<svg'));
});

test('XSS：围栏代码块内的 HTML 同样只作文本', () => {
  const { render } = loadClient();
  const out = render('```\n<script>alert(1)</script>\n```');
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(!hasScriptableTag(out));
});

// ---------------------------------------------------------------------------
// 与 index.html 集成：addMessage 渲染助手终稿，用户/系统注入保持纯文本
// ---------------------------------------------------------------------------

test('集成：addMessage 对助手消息渲染 Markdown，用户与 synthetic 消息保持 textContent', () => {
  const { client } = loadClient({ withIndex: true });
  const { addMessage } = client;
  const a = addMessage({ id: 'm1', role: 'assistant', synthetic: false, content: '# 你好' });
  assert.ok(a.innerHTML.includes('<h1>你好</h1>'), '助手终稿渲染 Markdown');
  assert.equal(a.textContent, '');
  const u = addMessage({ id: 'm2', role: 'user', synthetic: false, content: '# 不渲染' });
  assert.equal(u.textContent, '# 不渲染', '用户消息纯文本');
  assert.equal(u.innerHTML, '');
  const s = addMessage({ id: 'm3', role: 'assistant', synthetic: true, content: '<b>x</b>' });
  assert.equal(s.textContent, '〔系统注入〕<b>x</b>', '系统注入纯文本');
  assert.equal(s.innerHTML, '');
  const x = addMessage({ id: 'm4', role: 'assistant', synthetic: false, content: '<img src=x onerror=alert(1)>' });
  assert.ok(!hasScriptableTag(x.innerHTML), '助手消息 XSS 也被转义');
});

test('集成：renderMarkdown 未加载时 addMessage 退化为纯文本（脚本 404/未就绪兜底）', () => {
  const { client } = loadClient({ withIndex: true, dropRenderer: true });
  const a = client.addMessage({ id: 'm9', role: 'assistant', synthetic: false, content: '# 标题' });
  assert.equal(a.textContent, '# 标题');
  assert.equal(a.innerHTML, '');
});
// ---------------------------------------------------------------------------
// 评审 LOW-2 回归：私用区字符占位符防碰撞
// ---------------------------------------------------------------------------

test('评审 LOW-2：输入中的 \uE000<数字>\uE000 不被误还原为行内代码', () => {
  const { render } = loadClient();
  const PUA = String.fromCharCode(0xE000);
  // 私用区字符 → 数字实体（&#57344;），占位符不可能来自用户输入
  assert.equal(render(PUA + '0' + PUA), '<p>&#' + 0xE000 + ';0&#' + 0xE000 + ';</p>');
  // 与真行内代码共存时不误还原
  assert.equal(render('`x` and ' + PUA + '0' + PUA), '<p><code>x</code> and &#' + 0xE000 + ';0&#' + 0xE000 + ';</p>');
  // 私用区字符不得从任何出口漏出原始形态
  const out = render(PUA + '0' + PUA);
  assert.ok(!out.includes(PUA), '输出不得含原始私用区字符');
});

// ---------------------------------------------------------------------------
// 评审 LOW-3 回归：项目切换竞态守卫（loadSessions 请求序号）
// ---------------------------------------------------------------------------

test('评审 LOW-3：快速 A→B 切换时 A 的迟到响应不得覆盖 B 的会话列表', async () => {
  let releaseA;
  const gateA = new Promise((r) => { releaseA = r; });
  const fetchImpl = async (url) => {
    if (!url.startsWith('/api/sessions?')) throw new Error('fetch 在单测中仅允许 loadSessions'); // boot() 的 /api/me 走 renderLogin 分支
    if (url.includes('project_id=proj-A')) {
      await gateA; // A 的响应迟到
      return { ok: true, json: async () => ({ items: [{ id: 'sa', title: 'A会话' }] }) };
    }
    return { ok: true, json: async () => ({ items: [{ id: 'sb', title: 'B会话' }] }) };
  };
  const { client, elements } = loadClient({ withIndex: true, fetchImpl });
  const { S, loadSessions } = client;

  S.projectId = 'proj-A';
  const pA = loadSessions();
  S.projectId = 'proj-B'; // 用户迅速切到 B
  const pB = loadSessions();
  await pB;
  assert.ok(elements.get('sessList').innerHTML.includes('B会话'), 'B 的响应先到，列表为 B');

  releaseA(); // A 的迟到响应现在才到
  await pA;
  assert.ok(elements.get('sessList').innerHTML.includes('B会话'), '迟到响应被序号守卫丢弃');
  assert.ok(!elements.get('sessList').innerHTML.includes('A会话'), 'A 不得覆盖 B');
});
