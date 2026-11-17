// JS 源码的**注释**、**字符串**与**正则字面量**处理（**唯一定义处**）。issue #557 返工：这份状态机原本住在
// `test/repo-hygiene.test.js:135`，现在提出来给两处判据共用：
//   · `test/repo-hygiene.test.js`（H3：前端 spec 里「取走 `emitted()`」的三种形状）
//   · `portal/test/deploy-env-delegate.test.js`（活二：runner 侧 env 枚举必须**排除注释/字符串**）
//
// 为什么必须共用而不是各写一份：两处判据都要求「先剥注释再匹配」。复制一份「逐行 `startsWith('//')`」
// 的弱货会分叉成两本账 —— 同一个形状一边算注释、另一边算代码。而 H3 已经实测过弱做法的三个坑：
// 行注释里写 glob（那个「斜杠星」会让「先剥块」一路吃到下一个闭合，中间**真代码**被抹掉）、
// 块注释正文里写 URL（`https:` 的两斜杠会被「后剥行」砍掉）、注释里夹反引号会带偏「先认字符串」的写法。
//
// `stripComments()` 语义（与提出来的那份**逐字相同**，H3 判据①② 钉着它）：
//   · 块注释（含 JSDoc，可跨行）与行注释（`//` 到行尾）换成**等长空格**，**换行与列位保留**
//     ⇒ 匹配仍是逐行的，报出来的 `path:16` 依然能在编辑器里跳到位；
//   · 一趟字符扫描定死优先级：块注释里不认行注释起点，行注释里不认块注释起点，
//     字符串/模板字面量里两者都不认 ⇒ URL 串里的两斜杠不是注释；
//   · 两处刻意保守：块注释到文件尾都没闭合 ⇒ 判它是假的（多半是正则字面量里的「斜杠星」），
//     那一段**原样退回**不剥；普通单/双引号串不跨行，撞见换行就地收尾；
//   · **正则字面量是 `/` 的第四种身份**（issue #587 族 A② 补的）：JS 里 `/` 有四种身份 —— 注释起点、
//     正则定界符、除法、串里的普通字符。旧状态机只认第一与第三种，于是 `const cls = /[/*]/;` 那个坐在
//     **正则字符类**里的「斜杠星」被当成块注释起点：`stripComments()` 靠「未闭合 ⇒ 原样退回」侥幸活下来，
//     `structuralMask()` **没有那条退路** ⇒ 其后所有真代码被一路抹到文件尾（现网实测同族：
//     `runner/lib/final-text-toolcall.js:194` 的 `` /```[\s\S]*?```/g `` 把 `:195` 的 `}` 都抹平了）。
//     现在两把尺共用 `regexLiteralSpan()`：`/` 的身份由**前一个有效 token** 定（运算符 / `,` / `;` / `=` /
//     `=>` / `return` 等关键字 ⇒ 正则；标识符、数字、`)`、`]`、串尾 ⇒ 除法），且必须**在同一行内**找到闭合
//     的 `/`，否则退回除法继续按注释判 ⇒ 认不准时的方向是保守的（宁可少认一个正则，也不许把真代码掩掉）。
//     已知边界：`)` 之后一律按除法 ⇒ `if (x) /re/.test(y)` 这种「`)` 后紧跟正则」仍需写 `\/`；
//     正则里写 `//` 必须 `\/\/`（同旧口径）。
//     `stripComments()` 里正则**原样保留**（那是代码），`structuralMask()` 里正则**正文抹成空格**
//     （定界符与 flags 留着）⇒ 正则里的括号/花括号/引号不再骗过括号配平，而「串里提到的形状不算读取」
//     那条判据顺带也覆盖了**正则里提到的** `process.env.X`（它同样不是读取）。
//
// `structuralMask()` 是**另一个**问题：注释 + 字符串/模板**正文**一起抹成空格（定界符与换行留着）。
// 两件要说清楚的：
//   · **模板插值 `${…}` 里的代码原样保留** —— 那是真代码。`runner/worker.js:774` 的
//     `msg: `${ + 'name' + `}=${process.env[name]}`` 就是活在模板里的读取，抹掉它 = 又一处静默；
//   · 它服务两个问题：**括号配平**（找对象/数组字面量的配对括号），以及**「这个位置是不是字符串正文」**
//     （扫描器据此放过「串里提到的形状」）。做**内容匹配**要当心：env 名的字面量就活在字符串里
//     （`const FOO_ENV = 'ERIX_X'`、provisioner 的 `` `ERIX_X=${v}` ``），拿掩码文本去匹配字面量会什么都认不到。
// 它只服务于**结构配平**（找对象/数组字面量的配对括号）。**不能**拿它做内容匹配 ——
// env 名的字面量就活在字符串里（`const FOO_ENV = 'ERIX_X'`、provisioner 的 `` `ERIX_X=${v}` ``），
// 抹掉正文就没东西可认了。

/** 标识符字符（`$` 与 `_` 也算；`/` **不是**）。 */
const IDENT_CH = /[\w$]/;

/**
 * 这些**整词**关键字之后出现的 `/` 才是正则起点（必须整词比对：`doner` 里的 `do`、`typeof` 式的
 * 子串都不算，否则标识符之后的除法会被误判成正则 = 新引入一种假遮蔽）。
 */
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await', 'default',
]);

/** 前一个有效 token 处「这里可以是正则」吗？`prevCh === ''` = 文本起点（语句开头 ⇒ 可以是正则）。 */
function canStartRegex(prevCh, prevWord) {
  if (prevCh === '') return true;
  if (/[\w$]/.test(prevCh)) return REGEX_KEYWORDS.has(prevWord);   // 标识符/数字之后 = 除法
  // `)` `]` 与串尾之后按除法（保守那条）；其余标点（`,` `=` `(` `[` `;` `{` `}` `=>` `:` `?` `!` …）之后 = 正则
  return prevCh !== ')' && prevCh !== ']' && prevCh !== "'" && prevCh !== '"' && prevCh !== '`';
}

/**
 * 从 `text[i] === '/'` 起判断这是不是一段**正则字面量**：是 ⇒ 返回结束下标（不含，flags 已吃掉）；
 * 否 ⇒ -1。判假的三种情形：`//` 与 `/*`（JS 的正则不许为空，这两个永远是注释）、同一行内找不到闭合的
 * `/`（正则不许跨行 ⇒ 那是除法）、字符类 `[...]` 没闭合。转义 `\\` 跳两字符，字符类里的 `/` 不算定界符。
 * @param {string} text
 * @param {number} i `text[i] === '/'`
 * @returns {number}
 */
function regexLiteralSpan(text, i) {
  const n = text.length;
  const next = i + 1 < n ? text[i + 1] : '';
  if (next === '/' || next === '*') return -1;
  let inClass = false;
  for (let k = i + 1; k < n; k += 1) {
    const c = text[k];
    if (c === '\n' || c === '\r') return -1;
    if (c === '\\') { k += 1; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '/') {
      let j = k + 1;
      while (j < n && /[a-z]/.test(text[j])) j += 1;   // flags（g i m s u v y d）
      return j;
    }
  }
  return -1;
}

/** 「最近一个非空白代码 token」的追踪器（定 `/` 的身份用；注释与空白不参与）。 */
function makeTokenTracker() {
  const state = {
    prevCh: '', prevWord: '',
    /** 追加一段代码文本，顺带更新「前一个 token」。 */
    note(s) {
      for (const c of s) {
        if (c === '\n' || c === ' ' || c === '\t' || c === '\r') continue;
        this.prevWord = IDENT_CH.test(c) ? (IDENT_CH.test(this.prevCh) ? this.prevWord : '') + c : '';
        this.prevCh = c;
      }
      return s;
    },
    /** 一段**值**（正则字面量）刚刚结束：其后的 `/` 只能是除法 —— 显式钉成 `)`，不靠「最后一个字符碰巧是什么」 */
    endValue() { this.prevCh = ')'; this.prevWord = ''; },
  };
  return state;
}

/**
 * 剥注释：块/行注释 → 等长空格；字符串、模板字面量**与正则字面量**原样保留；行数与列位不变。
 * @param {string} text
 * @returns {string}
 */
export function stripComments(text) {
  const out = [];
  const n = text.length;
  const tk = makeTokenTracker();
  let i = 0;
  let quote = '';    // 当前字符串定界符：' " ` ；空串 = 不在字符串里
  let blockOut = -1; // 块注释起点在 out 里的下标；-1 = 不在块注释里
  let blockSrc = -1; // 块注释起点在 text 里的下标（未闭合时要原样退回）
  while (i < n) {
    const c = text[i];
    const d = i + 1 < n ? text[i + 1] : '';
    if (blockOut >= 0) {                    // 块注释里：只找闭合，`//` 与引号都不认
      if (c === '*' && d === '/') { blockOut = -1; out.push('  '); i += 2; continue; }
      out.push(c === '\n' ? '\n' : ' ');
      i += 1;
      continue;
    }
    if (quote) {                            // 字符串里：`//` 与 `/*` 都不是注释
      if (c === '\\') { tk.note(c + d); out.push(c, d); i += 2; continue; }  // 转义掉的引号不算闭合
      if (c === quote) { quote = ''; tk.note(c); out.push(c); i += 1; continue; }
      if (c === '\n' && quote !== '`') { quote = ''; out.push('\n'); i += 1; continue; }
      tk.note(c);
      out.push(c);
      i += 1;
      continue;
    }
    if (c === '/' && canStartRegex(tk.prevCh, tk.prevWord)) {   // 正则字面量：整段原样保留
      const end = regexLiteralSpan(text, i);
      if (end > 0) { out.push(text.slice(i, end)); tk.endValue(); i = end; continue; }
    }
    if (c === '/' && d === '*') { blockOut = out.length; blockSrc = i; out.push('  '); i += 2; continue; }
    if (c === '/' && d === '/') {                                          // 行注释：只抹到行尾
      while (i < n && text[i] !== '\n') { out.push(' '); i += 1; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; tk.note(c); out.push(c); i += 1; continue; }
    tk.note(c);
    out.push(c);
    i += 1;
  }
  if (blockOut >= 0) {                      // 块注释没闭合 ⇒ 假的，原样退回（见上方「刻意保守」）
    out.length = blockOut;
    out.push(text.slice(blockSrc));
  }
  return out.join('');
}

/**
 * 结构掩码：注释与字符串**正文**都抹成空格，定界符与换行留着 ⇒ 行列位不变。
 * 正则字面量的**正文**同样抹成空格（定界符与 flags 留着）—— 正则里的 `[` `]` `{` `}` `'` 是**字符**，
 * 让它们参与配平就是拿内容骗结构（#587 族 A②）。
 * 只用来做括号配平；**别**拿它匹配内容（字面量会被抹掉）。
 * @param {string} text
 * @returns {string}
 */
export function structuralMask(text) {
  const out = [];
  const n = text.length;
  const tk = makeTokenTracker();
  let i = 0;
  let quote = '';      // ' " ` ；空串 = 在代码里
  let inBlock = false;
  const stack = [];    // 模板插值嵌套栈（每项 { depth } = 该层插值里的花括号深度）
  while (i < n) {
    const c = text[i];
    const d = i + 1 < n ? text[i + 1] : '';
    const interp = stack.length ? stack[stack.length - 1] : null;
    if (inBlock) {                                   // 块注释：整段抹平，只认闭合
      if (c === '*' && d === '/') { inBlock = false; out.push('  '); i += 2; continue; }
      out.push(c === '\n' ? '\n' : ' ');
      i += 1;
      continue;
    }
    if (quote === '`') {                             // 模板正文：` 结束；`${` 开一段**真代码**
      if (c === '\\') { out.push(' ', ' '); i += 2; continue; }
      if (c === '`') { quote = ''; tk.note(c); out.push(c); i += 1; continue; }
      if (c === '$' && d === '{') { stack.push({ depth: 0 }); out.push(tk.note('${')); i += 2; quote = ''; continue; }
      out.push(c === '\n' ? '\n' : ' ');
      i += 1;
      continue;
    }
    if (quote) {                                     // 普通串：正文抹平（同 stripComments 的「不跨行」保守规则）
      if (c === '\\') { out.push(' ', ' '); i += 2; continue; }
      if (c === quote) { quote = ''; tk.note(c); out.push(c); i += 1; continue; }
      if (c === '\n') { quote = ''; out.push('\n'); i += 1; continue; }
      out.push(' ');
      i += 1;
      continue;
    }
    if (c === '/' && canStartRegex(tk.prevCh, tk.prevWord)) {   // 正则：定界符与 flags 留着，正文**等长**抹平
      const end = regexLiteralSpan(text, i);
      if (end > 0) {
        const lit = text.slice(i, end);
        const fm = /^\/[\s\S]*\/([a-z]*)$/.exec(lit);
        const flags = fm ? fm[1] : '';
        const body = lit.slice(1, lit.length - 1 - flags.length);
        out.push('/', body.replace(/[^\n]/g, ' '), '/', flags);
        tk.endValue();                    // 正则是个**值** ⇒ 其后的 `/` 按除法
        i = end;
        continue;
      }
    }
    if (c === '/' && d === '*') { inBlock = true; out.push('  '); i += 2; continue; }
    if (c === '/' && d === '/') {                    // 行注释：抹到行尾
      while (i < n && text[i] !== '\n') { out.push(' '); i += 1; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; tk.note(c); out.push(c); i += 1; continue; }
    if (interp && c === '{') { interp.depth += 1; tk.note(c); out.push(c); i += 1; continue; }
    if (interp && c === '}') {                       // 深度 0 的那个 `}` 才是插值收尾
      if (interp.depth === 0) { stack.pop(); quote = '`'; out.push(c); i += 1; continue; }
      interp.depth -= 1; tk.note(c); out.push(c); i += 1; continue;
    }
    tk.note(c);
    out.push(c);
    i += 1;
  }
  return out.join('');
}
