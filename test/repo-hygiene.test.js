// 仓库卫生：`node_modules` 必须**既不入库、也进不了库**（#261025-05 / PR #396）。
//
// 为什么要有这个测，而不是一次 `git rm --cached` 就算完：这个仓库曾经把 `node_modules` **当文件
// 提交过**（`1655d7a`，模式 120000 的符号链接，内容是一个绝对路径
// `/home/<user>/projects/fde_station/erix-station/node_modules`，而那次提交的信息压根没提它 ——
// 就是 `git add -A` 顺手扫进来的）。后果不是难看，是**行为**：
//   · 一棵依赖树被 13 个 worktree 共享，任何一个 worktree 里跑 `npm install` 都会顺着的链接
//     把别的 worktree 的依赖剪掉（实测：一次 `npm install --omit=dev` 把共享树清成空目录，
//     另一个 worktree 的测试当场变红）；
//   · 各分支钉的引擎版本不同（main 与特性分支的 `erix-agent` 版本就不一样），共享树没法同时服务；
//   · 链接内容是绝对路径 ⇒ 换机器/换目录即悬空，而它在版本库里，新克隆的人拿到的就是悬空链接。
//
// `.gitignore` 第 1 行原本只有 `node_modules/`——**带斜杠的规则只匹配目录**，符号链接不是目录，
// 所以 `git add -A` 照样把它扫进来。本文件钉两条：① 跟踪状态必须为空；② 规则必须真盖得住
// **链接形态**（真造一个符号链接复现，不做文本匹配）。
//
// 第二条家族（H3，issue #496）同样是一次性修不掉的**环境地板**：`@vue/test-utils@2.5.1` 的
// `emitted()` 靠 Vue devtools hook 取事件，而 Vue 只在非生产构建里发 devtools 事件 ⇒ 本机 shell
// 默认 `NODE_ENV=production` 时它**恒空**，断言假红（且 `toBeUndefined()` 那一半会假绿）。
// 光在 `AGENTS.md` §4 写「新用例别用」拦不住：那句话写于 11-11，11-14 的 `2e40214` 又带进来一处
// ⇒ 现在改成静态判据（带反向自证，与 H2 同形）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args, cwd = REPO_ROOT) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

test('H1 `node_modules` 不得再被 git 跟踪（含 worktree 里的符号链接形态）', () => {
  const tracked = git(['ls-files', '--', 'node_modules', 'node_modules/*']);
  assert.equal(tracked, '',
    '`node_modules` 又回到版本库了。它一旦被跟踪，所有 worktree 会共享同一棵依赖树：'
    + '任一处 `npm install` 都会顺链接剪掉别处的依赖（#261025-05 的实害）。修法：`git rm --cached node_modules`');
  // 顺带证明"这次不是靠人肉守"：跟踪列表里也不该有绝对路径的链接对象
  const modes = git(['ls-files', '-s', '--', 'node_modules']);
  assert.equal(modes, '', '出现 mode 120000 之类的链接对象 = 1655d7a 那个形状复发');
});

test('H2 `.gitignore` 必须挡住**符号链接**形态（带斜杠的 `node_modules/` 挡不住）', (t) => {
  const rules = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
  const lines = rules.split('\n').map((l) => l.trim());
  assert.ok(lines.includes('node_modules'),
    '缺少**不带斜杠**的 `node_modules` 规则：`node_modules/` 只匹配目录，链接形态照样能被 `git add -A` 扫进来');

  // 真复现一次，而不是只做文本匹配：临时仓库 + 本仓库的 .gitignore + 一个**符号链接**
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'station-hygiene-'));
  try {
    fs.copyFileSync(path.join(REPO_ROOT, '.gitignore'), path.join(tmp, '.gitignore'));
    git(['init', '-q'], tmp);
    fs.writeFileSync(path.join(tmp, 'README.md'), 'x\n');
    fs.symlinkSync('/some/absolute/path/node_modules', path.join(tmp, 'node_modules'), 'dir');
    const status = git(['status', '--porcelain'], tmp);
    assert.doesNotMatch(status, /node_modules/,
      `.gitignore 没挡住符号链接形态，git 看见的是：\n${status}`);
    // 反向自证：把那条规则删掉，同一次扫描必须**看得见**它（否则上面的断言是空转）
    fs.writeFileSync(path.join(tmp, '.gitignore'),
      rules.split('\n').filter((l) => l.trim() !== 'node_modules').join('\n'));
    const without = git(['status', '--porcelain'], tmp);
    assert.match(without, /node_modules/,
      '把无斜杠规则拿掉 git 还是看不见 ⇒ 本测失去意义（说明匹配姿势错了，不是在证明规则有效）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// H3（issue #496）：前端 spec 里不许**取走** test-utils 的 `emitted()`（点号 / 方括号 / 解构三种形状）。
// 机制与后果见文件头；这里只钉一句话：**判据不许依赖 Vue devtools 事件**。
// 口径（都是有意选的，改动要连带改反向自证）：
//   · 只扫 **git 跟踪的** spec（与 `npm run check:agents-hotlayer` 的引用面同口径：未入库的文件不是交付）；
//   · 清单 = `portal/frontend` 下名字以 `.spec.ts` 结尾的跟踪文件 = vitest 的运行时表面（`vite.config.ts`
//     的 `include: ['src/**/*.spec.ts']`）；注意**不能**拿 `src/**/*.spec.ts` 当 git pathspec，
//     它匹配不到顶层的 `src/router.spec.ts`（实测少一个）⇒ 反向自证就钉在这个文件上；
//   · 匹配三种「取走 emitted」的形状（copilot 二次审计指出：**只拦点号可被绕过** ——
//     `wrapper['emitted'](...)` 与 `const { emitted } = wrapper` 一样依赖 devtools，却躲得过点号）：
//       ① 点号 `.emitted`（含属性读 `wrapper.emitted`）
//       ② 方括号取属性 `['emitted']` / `["emitted"]`
//       ③ 解构取走 `{ emitted }` / `{ emitted: 别名 }` / `{ a, emitted }`，以及跨行解构里
//          独占一行的成员 `emitted,`。拦的是**取走这件事本身**：取走之后怎么调都追不住，
//          所以不追调用点，直接把取走钉死。
//     仍然**不拦**单词 `emitted` ⇒ 注释里写「不要用 emitted()」不会被误伤（现存 14 处这样的散文，
//     分布在 8 个 spec 里，全是注释正文，一处调用都没有）；
//   · **注释先剥掉再匹配**（#496 返工）：#555 的 spec 在文件头注释里写了一句真话「本文件不用
//     `w.emitted()`」，扫原文行会把这句说明当**点号形状**命中 ⇒ 假阳性，而且它惩罚的是「在文件里
//     写明这条口径」这个好习惯（反向教育）。所以豁免的边界是**注释**，不是这条规矩：
//     `const e = w.emitted(); // 说明` 这种「行尾还有代码」的行照抓（见 stripComments 与判据①②）。
//   · 只管 devtools 这一族：不钉 `fire()` / `vm.$emit` 等其它读事件方式（issue #496 的范围）。
const FRONTEND_DIR = 'portal/frontend';

/** 「取走 emitted」的形状。每条一支正则，反向自证按 `name` 逐形状注入并核对是**哪一支**认出来的。 */
const EMITTED_SHAPES = [
  { name: '点号', re: /\.emitted\b/ },
  { name: '方括号', re: /\[\s*['"]emitted['"]\s*\]/ },
  // 解构成员：`{` 或 `,` 后面紧跟 `emitted`（可带 `: 别名`）直到 `}` / `,`；后两条支管跨行解构里
  // 单独占一行的成员 —— 带尾逗号的（`emitted,`）与**最后一个成员没尾逗号**的（整行就一个 `emitted`，
  // 实测漏了它 `const {⏎ find,⏎ emitted⏎} = wrapper` 会 rc=0 混过去）。
  // 已知仍未覆盖：`const K = 'emitted'; wrapper[K]()`（字符串提到别的行再取，行级判据追不住）。
  { name: '解构', re: /[{,]\s*emitted\s*(?::[^,}\n]+)?\s*[,}]|^[ \t]*emitted\s*[,:]|^[ \t]*emitted[ \t]*$/ },
];

/** 扫描面：git 跟踪的、名字以 `.spec.ts` 结尾的前端文件（相对仓库根的路径）。 */
function trackedFrontendSpecs() {
  const nul = git(['-c', 'core.quotePath=false', 'ls-files', '-z', '--', FRONTEND_DIR]);
  return nul.split('\0').filter((p) => p.endsWith('.spec.ts')).sort();
}

// 扫描前剥注释（#496 返工）：把**块注释**（含 JSDoc，可跨行）与**行注释**（`//` 到行尾）的内容换成
// 等长空格，**换行与列位一概保留** ⇒ 匹配还是逐行的，命中报告里的 `path:16` 依然能在编辑器里跳到位。
//
// 为什么是一趟字符扫描，而不是「先正则剥块、再正则剥行」两条 pass（两条 pass 都会**吞掉真代码**，
// 那是假绿的方向，比假阳性更贵）：
//   · 行注释里写 glob（`// 见 portal/` + 星号 + `/x.spec.ts`）时，那个「斜杠星」会让「先剥块」一路吃到
//     下一个块闭合才收口 ⇒ 中间那几行**真代码**被整段抹掉；
//   · 块注释正文里写 URL（`https:` 加两斜杠）时，「后剥行」会把那一行剩下的部分砍掉；
//   · 真实误报那句注释里夹着**反引号**（`w.emitted()`）⇒ 任何「先认字符串再认注释」的写法会被它带偏。
// 一趟扫描一次定死三种优先级：块注释里不再认行注释起点，行注释里不再认块注释起点，
// 字符串/模板字面量里两者都不认 ⇒ URL 串里的两斜杠不是注释，它后面紧跟的代码照扫
// （这正是判据②的第三条探针）。
//
// 两处刻意保守（宁可拦得难看，不可悄悄放过）：
//   · 块注释直到文件尾都没闭合 ⇒ 判它是假的（多半是正则字面量里的「斜杠星」），那一段**原样退回**不剥；
//   · 普通单/双引号串不跨行：撞见换行就地收尾 ⇒ 一个游离的撇号不会把后半篇都当字符串而漏扫。
// 已知边界：状态机只认「引号串」与「注释」，不认**正则字面量** ⇒ 形如 `/a/*b/` 后面又碰得上一个真
// 块闭合时，中间那段代码会被误剥（假绿方向，与本文件其它行级判据同口径）；正则里写 `//` 必须是
// `\/\/`（转义后两斜杠不相邻），实测不误伤。
function stripComments(text) {
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
 * 判据本体：给定 [{ path, text }]，返回每一处「取走 emitted」的**行**（同行多支命中算一条，
 * 标注是哪几支认出来的）。生产调用与反向自证共用同一个函数、共用同一套剥注释前置。
 */
function findEmittedCalls(files) {
  const hits = [];
  for (const f of files) {
    // 先剥注释（块 → 行），**然后**才跑那三种形状的匹配器。
    // 不许换成「整行含 `//` 或 `*` 就放过」：那样 `const e = w.emitted(); // 说明` 会被整行放过，
    // 而那正是这条闸要抓的形状 ⇒ 判据②专门钉住它。
    stripComments(f.text).split('\n').forEach((line, i) => {
      const shapes = EMITTED_SHAPES.filter((s) => s.re.test(line)).map((s) => s.name);
      if (shapes.length) hits.push(`${f.path}:${i + 1} [${shapes.join('+')}] ${line.trim()}`);
    });
  }
  return hits;
}

/** 把路径当正则字面量用之前的转义。 */
const reEscape = (s) => s.replace(/[/\\^$.*+?()[\]{}|]/g, '\\$&');

test('H3 前端 spec 里不许取走 emitted()（点号/方括号/解构三种形状）——那是 `NODE_ENV=production` 假红的地板（issue #496）', () => {
  const files = trackedFrontendSpecs();
  // 不先钉「清单不空」，下面的「零命中」就可能是扫了个空集合（同 H2 的反向自证同理）。
  assert.ok(files.length >= 40, `只扫到 ${files.length} 个前端 spec ⇒ 清单本身漏了，本判据在空转`);
  assert.ok(files.includes(`${FRONTEND_DIR}/src/router.spec.ts`),
    '顶层 spec（src/router.spec.ts）必须在清单里：`src/**/*.spec.ts` 这种写法会漏它，判据会假绿');

  const read = (p) => ({ path: p, text: fs.readFileSync(path.join(REPO_ROOT, p), 'utf8') });
  const hits = findEmittedCalls(files.map(read));
  assert.deepEqual(hits, [],
    '前端 spec 里又出现了「取走 emitted」的写法（点号 / 方括号 / 解构三种形状之一）：'
    + '它在 NODE_ENV=production 下恒空（Vue 不发 devtools 事件）⇒ 要么假红、要么假绿。'
    + '改成 DOM 断言或请求桩断言（先例：GitLightBadge.spec.ts 的 mountBadgeHost、'
    + 'SidebarPanel.spec.ts 的 mountPanelInHost）。命中：\n  ' + hits.join('\n  '));

  // 反向自证 A：**逐形状**注入。每种形状各注一次，每次必须 ①恰好命中 1 处 ②命中在被改的那份上
  // ③命中要标注是**哪一支**认出来的 —— 只验点号就证明不了方括号那支（copilot 二次审计的正中）。
  // 注在被跟踪的那份顶层 spec 上，它同时证明清单真的盖到了顶层。
  const probe = `${FRONTEND_DIR}/src/router.spec.ts`;
  const INJECTIONS = [
    { shape: '点号', code: `const _m = wrapper.emitted('files-changed');` },
    { shape: '点号', code: `const _m = wrapper.emitted;` },
    { shape: '方括号', code: `const _m = wrapper['emitted']('files-changed');` },
    { shape: '方括号', code: `const _m = wrapper["emitted"]("refresh");` },
    { shape: '解构', code: `const { emitted } = wrapper;` },
    { shape: '解构', code: `const { emitted: fired, find } = wrapper;` },
    { shape: '解构', code: `const {\n  emitted,\n} = wrapper;` }, // 跨行解构（审计没提，但同样是取走）
    { shape: '解构', code: `const {\n  find,\n  emitted\n} = wrapper;` }, // 跨行 + 末位成员无尾逗号
  ];
  for (const { shape, code } of INJECTIONS) {
    const mutant = files.map((p) => {
      const f = read(p);
      return p === probe ? { ...f, text: `${f.text}\n${code}\n` } : f;
    });
    const injected = findEmittedCalls(mutant);
    assert.equal(injected.length, 1,
      `注入 ${shape} 形状 ${JSON.stringify(code)} 后只应命中 1 处，实际 ${injected.length} 处：${injected.join(' | ')}`);
    assert.match(injected[0], new RegExp(reEscape(probe)), `命中的不是被改的那份：${injected[0]}`);
    const hitShapes = (injected[0].match(/\[([^\]]+)\]/)?.[1] ?? '').split('+');
    assert.ok(hitShapes.includes(shape), `命中不是 ${shape} 这一支认出来的（等于没验这个形状）：${injected[0]}`);
  }
  // 防新形状变成空支：每个声明的形状都必须有至少一条注入探针。
  const covered = new Set(INJECTIONS.map((i) => i.shape));
  assert.deepEqual(EMITTED_SHAPES.map((s) => s.name).filter((n) => !covered.has(n)), [],
    '有形状没有对应的注入探针 ⇒ 那支正则坏了也不会红');

  // 反向自证 B：不带点、不带方括号、不在解构成员位上的散文 ⇒ 必须**看不见**（否则判据钉的是
  // 单词本身，会把仓库现存那 14 处「别用 emitted()」的说明注释全钉成红）。用全角标点写注释正文，
  // 免得 ASCII 逗号把散文变成「解构成员位」。
  const prose = findEmittedCalls(files.map((p) => {
    const f = read(p);
    return p === probe
      ? { ...f, text: `${f.text}\n// 别再写 emitted() 这种调用（#496）\n// 也不要在解构里取走 emitted（#496）\n` }
      : f;
  }));
  assert.deepEqual(prose, [], `不带点/不括/不解构的散文不该被拦：${prose.join(' | ')}`);
});

// ---------------------------------------------------------------------------
// 判据①②（issue #496 **返工**）：H3 豁免的边界是**注释**，不是这条规矩。
// 现场：#555 的 `StreamPanelTextualizedNotice.spec.ts:16` 在 JSDoc 头里写了一句**真话**
// 「本文件不用 `w.emitted()`」（那份 spec 自己只用 DOM 断言，写得完全正确），而闸扫的是原文行
// ⇒ 把这句说明当成**点号形状**的调用命中 ⇒ 假阳性。
// 为什么改的是闸、不许改那句注释：靠改措辞绕过，下一个想在文件头写「本文件不用 emitted()」的人会
// 再被撞一次，得到的仍是一条**指着一句真话**的红 ⇒ 久而久之学会「文件里别写这条口径」= 反向教育。
// 两格必须**成对**读：只过① 什么也证明不了（可能整条规矩被废了）；② 才证明代码那一半还咬得住。

/** 真实误报那一行的**原句**，形状必须同款：在 JSDoc 块注释里、行首是 `*`、正文夹反引号、里面写着 `w.emitted()`。 */
const H3_NOTICE = ' * ⚠ 口径：本文件**不用 `w.emitted()`**（本机 `NODE_ENV=production` 会让它恒空 ⇒ 假绿），一律 DOM 文本断言。';
/** 夹具路径只是报告用的名字：判据吃的是 [{ path, text }]，不落盘（不动 `portal/frontend/**` 一个字节）。 */
const H3_FIXTURE = `${FRONTEND_DIR}/src/H3CommentFixture.spec.ts`;

/**
 * ①② 共用**同一份**夹具。`notice=true` 是 #555 的现状（那句口径留在 JSDoc 里、代码位空着）；
 * `notice=false` 就是派单说的「把那句换成真代码」：注释位不再是那句口径，真代码坐到代码位上。
 * 两种写法都带一条**同款口径的行注释**（`// 也不要用 w.emitted()`），于是块注释与行注释各剥各的。
 */
function h3Fixture({ notice = true, code = '' } = {}) {
  return [
    '/**',
    ' * StreamPanel 文案回归（#555）：只断言渲染出来的 DOM 文本。',
    notice ? H3_NOTICE : ' * 口径见下面的代码位。',
    ' */',
    "import { describe, it, expect } from 'vitest';",
    '',
    '// 也不要用 w.emitted()：本机 NODE_ENV=production 下它恒空（同款口径的行注释写法）',
    code,
    '',
  ].join('\n');
}

test('H3-① 注释里出现 `w.emitted()` 必须放过（#496 返工：那句解释这条规矩的真话不该被当成代码）', () => {
  const text = h3Fixture({ notice: true, code: '' });
  // 防空转：夹具必须**真的**带着那句被误报的注释，而且它确实坐在**块注释内部**（真实误报就是这个形状）
  assert.ok(text.includes('w.emitted()'), '夹具里根本没有 `w.emitted()` ⇒ 本判据在空转');
  const lines = text.split('\n');
  const at = lines.indexOf(H3_NOTICE);
  assert.ok(at > 0, `那句注释没进夹具（或形状变了，对不上 ${H3_FIXTURE}:16 的原句）`);
  assert.equal(lines[0], '/**', '夹具头部必须是 JSDoc 块注释的开始');
  assert.ok(lines.findIndex((l, i) => i > at && l.trim() === '*/') > at,
    '那句注释必须落在 /** … */ **内部**（换成行注释就是另一种形状，白测）');
  // 剥注释不许改行数：命中报告里的 `path:行号` 要还能在编辑器里跳到位
  assert.equal(stripComments(text).split('\n').length, lines.length,
    '剥注释改变了行数 ⇒ 以后报出来的行号对不上原文');

  const hits = findEmittedCalls([{ path: H3_FIXTURE, text }]);
  assert.deepEqual(hits, [],
    '注释里的 `w.emitted()` 又被当成取走了（今天的假阳性复发）：豁免的该是注释，不是这条规矩。命中：'
    + hits.join(' | '));
});

test('H3-② 同一份夹具把那一句换成真代码必须报、形状标签仍是 [点号]（#496 返工：豁免的是注释，不是规矩）', () => {
  const CODES = [
    { why: '派单原句：那句注释原地换成真代码', notice: false, code: `const e = w.emitted('x');` },
    // 派地点名的偷懒法：「整行含 // 或 * 就放过」会把这一行整行放过 ⇒ 这一条专杀它
    { why: '真代码后面还跟着行尾注释', notice: false, code: `const e = w.emitted('x'); // 行尾还有一句说明` },
    // 两斜杠出现在**字符串**里（URL）不是注释起点 ⇒ 它后面的代码照扫
    { why: '行首是 URL 串，真代码在它后面', notice: false, code: `const u = 'https://x.test/a'; const e = w.emitted('x');` },
    // 注释位与代码位同时存在 ⇒ 只许报代码那一处（注释一处都不许多算）
    { why: 'JSDoc 里留着那句口径，代码位放真代码', notice: true, code: `const e = w.emitted('x');` },
  ];
  for (const { why, notice, code } of CODES) {
    const text = h3Fixture({ notice, code });
    const hits = findEmittedCalls([{ path: H3_FIXTURE, text }]);
    assert.equal(hits.length, 1, `${why} ⇒ 应恰好命中 1 处，实际 ${hits.length} 处：${hits.join(' | ')}`);
    const wantLine = text.split('\n').indexOf(code) + 1;
    assert.ok(wantLine > 0, `${why} ⇒ 代码位没进夹具`);
    assert.ok(hits[0].startsWith(`${H3_FIXTURE}:${wantLine} [点号] `),
      `${why} ⇒ 命中不在代码那一行、或形状标签变了（要求 [点号]）：${hits[0]}`);
    assert.match(hits[0], /emitted\('x'\)/, `${why} ⇒ 报出来的不是那行代码：${hits[0]}`);
  }
});
