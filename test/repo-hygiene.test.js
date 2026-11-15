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
//     但写成上面三种形状（哪怕在注释里）仍然拦得住 —— 宁可拦得难看，不可漏。
//   · 只管 devtools 这一族：不钉 `fire()` / `vm.$emit` 等其它读事件方式（issue #496 的范围）。
const FRONTEND_DIR = 'portal/frontend';

/** 「取走 emitted」的形状。每条一支正则，反向自证按 `name` 逐形状注入并核对是**哪一支**认出来的。 */
const EMITTED_SHAPES = [
  { name: '点号', re: /\.emitted\b/ },
  { name: '方括号', re: /\[\s*['"]emitted['"]\s*\]/ },
  // 解构成员：`{` 或 `,` 后面紧跟 `emitted`（可带 `: 别名`）直到 `}` / `,`；
  // 第二条支管跨行解构里单独占一行的成员（`emitted,` / `emitted: x,`）。
  { name: '解构', re: /[{,]\s*emitted\s*(?::[^,}\n]+)?\s*[,}]|^[ \t]*emitted\s*[,:]/ },
];

/** 扫描面：git 跟踪的、名字以 `.spec.ts` 结尾的前端文件（相对仓库根的路径）。 */
function trackedFrontendSpecs() {
  const nul = git(['-c', 'core.quotePath=false', 'ls-files', '-z', '--', FRONTEND_DIR]);
  return nul.split('\0').filter((p) => p.endsWith('.spec.ts')).sort();
}

/**
 * 判据本体：给定 [{ path, text }]，返回每一处「取走 emitted」的**行**（同行多支命中算一条，
 * 标注是哪几支认出来的）。生产调用与反向自证共用同一个函数。
 */
function findEmittedCalls(files) {
  const hits = [];
  for (const f of files) {
    f.text.split('\n').forEach((line, i) => {
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
