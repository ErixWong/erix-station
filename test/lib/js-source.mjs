// JS 源码的**注释**与**字符串**处理（**唯一定义处**）。issue #557 返工：这份状态机原本住在
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
//   · 已知边界：不认**正则字面量** ⇒ `/a/*b/` 后面碰得上真块闭合时中间代码会被误剥（假绿方向）；
//     正则里写 `//` 必须 `\/\/`。
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

/**
 * 剥注释：块/行注释 → 等长空格；字符串与模板字面量原样保留；行数与列位不变。
 * @param {string} text
 * @returns {string}
 */
export function stripComments(text) {
  const out = [];
  const n = text.length;
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
      if (c === '\\') { out.push(c, d); i += 2; continue; }           // 转义掉的引号不算闭合
      if (c === quote) { quote = ''; out.push(c); i += 1; continue; }
      if (c === '\n' && quote !== '`') { quote = ''; out.push('\n'); i += 1; continue; }
      out.push(c);
      i += 1;
      continue;
    }
    if (c === '/' && d === '*') { blockOut = out.length; blockSrc = i; out.push('  '); i += 2; continue; }
    if (c === '/' && d === '/') {                                          // 行注释：只抹到行尾
      while (i < n && text[i] !== '\n') { out.push(' '); i += 1; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out.push(c); i += 1; continue; }
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
 * 只用来做括号配平；**别**拿它匹配内容（字面量会被抹掉）。
 * @param {string} text
 * @returns {string}
 */
export function structuralMask(text) {
  const out = [];
  const n = text.length;
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
      if (c === '`') { quote = ''; out.push(c); i += 1; continue; }
      if (c === '$' && d === '{') { stack.push({ depth: 0 }); out.push('${'); i += 2; quote = ''; continue; }
      out.push(c === '\n' ? '\n' : ' ');
      i += 1;
      continue;
    }
    if (quote) {                                     // 普通串：正文抹平（同 stripComments 的「不跨行」保守规则）
      if (c === '\\') { out.push(' ', ' '); i += 2; continue; }
      if (c === quote) { quote = ''; out.push(c); i += 1; continue; }
      if (c === '\n') { quote = ''; out.push('\n'); i += 1; continue; }
      out.push(' ');
      i += 1;
      continue;
    }
    if (c === '/' && d === '*') { inBlock = true; out.push('  '); i += 2; continue; }
    if (c === '/' && d === '/') {                    // 行注释：抹到行尾
      while (i < n && text[i] !== '\n') { out.push(' '); i += 1; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out.push(c); i += 1; continue; }
    if (interp && c === '{') { interp.depth += 1; out.push(c); i += 1; continue; }
    if (interp && c === '}') {                       // 深度 0 的那个 `}` 才是插值收尾
      if (interp.depth === 0) { stack.pop(); quote = '`'; out.push(c); i += 1; continue; }
      interp.depth -= 1; out.push(c); i += 1; continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join('');
}
