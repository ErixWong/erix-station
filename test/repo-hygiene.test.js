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
// H3（issue #496）：前端 spec 里不许出现 `emitted()` 的**带点调用形状** `.emitted(`。
// 机制与后果见文件头；这里只钉一句话：**判据不许依赖 Vue devtools 事件**。
// 口径（都是有意选的，改动要连带改反向自证）：
//   · 只扫 **git 跟踪的** spec（与 `npm run check:agents-hotlayer` 的引用面同口径：未入库的文件不是交付）；
//   · 清单 = `portal/frontend` 下名字以 `.spec.ts` 结尾的跟踪文件 = vitest 的运行时表面（`vite.config.ts`
//     的 `include: ['src/**/*.spec.ts']`）；注意**不能**拿 `src/**/*.spec.ts` 当 git pathspec，
//     它匹配不到顶层的 `src/router.spec.ts`（实测少一个）⇒ 反向自证就钉在这个文件上；
//   · 匹配 `\.emitted\b`（带点）而不是单词 `emitted` ⇒ 注释里写「不要用 emitted()」不会被误伤，
//     但写成调用（哪怕在注释里）仍然拦得住 —— 宁可拦得难看，不可漏。
const FRONTEND_DIR = 'portal/frontend';
const EMITTED_CALL = /\.emitted\b/;

/** 扫描面：git 跟踪的、名字以 `.spec.ts` 结尾的前端文件（相对仓库根的路径）。 */
function trackedFrontendSpecs() {
  const nul = git(['-c', 'core.quotePath=false', 'ls-files', '-z', '--', FRONTEND_DIR]);
  return nul.split('\0').filter((p) => p.endsWith('.spec.ts')).sort();
}

/** 判据本体：给定 [{ path, text }]，返回每一处带点调用。生产调用与反向自证共用同一个函数。 */
function findEmittedCalls(files) {
  const hits = [];
  for (const f of files) {
    f.text.split('\n').forEach((line, i) => {
      if (EMITTED_CALL.test(line)) hits.push(`${f.path}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

test('H3 前端 spec 里不许出现 `.emitted(`——那是 `NODE_ENV=production` 假红的地板（issue #496）', () => {
  const files = trackedFrontendSpecs();
  // 不先钉「清单不空」，下面的「零命中」就可能是扫了个空集合（同 H2 的反向自证同理）。
  assert.ok(files.length >= 40, `只扫到 ${files.length} 个前端 spec ⇒ 清单本身漏了，本判据在空转`);
  assert.ok(files.includes(`${FRONTEND_DIR}/src/router.spec.ts`),
    '顶层 spec（src/router.spec.ts）必须在清单里：`src/**/*.spec.ts` 这种写法会漏它，判据会假绿');

  const read = (p) => ({ path: p, text: fs.readFileSync(path.join(REPO_ROOT, p), 'utf8') });
  const hits = findEmittedCalls(files.map(read));
  assert.deepEqual(hits, [],
    '前端 spec 里又出现了带点的 emitted(...) 调用：它在 NODE_ENV=production 下恒空（Vue 不发 devtools 事件）'
    + '⇒ 要么假红、要么假绿。改成 DOM 断言或请求桩断言（先例：GitLightBadge.spec.ts 的 mountBadgeHost、'
    + 'SidebarPanel.spec.ts 的 mountPanelInHost）。命中：\n  ' + hits.join('\n  '));

  // 反向自证 A：拿清单里**真的顶层那份**注入一行调用形状 ⇒ 同一次扫必须只多这一处可见。
  // （它同时证明：① 匹配姿势对；② 清单真的盖到了顶层 spec。）
  const probe = `${FRONTEND_DIR}/src/router.spec.ts`;
  const mutant = files.map((p) => {
    const f = read(p);
    return p === probe ? { ...f, text: `${f.text}\nconst _mutant = wrapper.emitted('files-changed');\n` } : f;
  });
  const injected = findEmittedCalls(mutant);
  assert.equal(injected.length, 1, `注入一处带点调用后只应命中 1 处，实际 ${injected.length} 处：${injected.join(' | ')}`);
  assert.match(injected[0], new RegExp(probe.replace(/[/\\^$.*+?()[\]{}|]/g, '\\$&')), `命中的不是被改的那份：${injected[0]}`);

  // 反向自证 B：只写不带点的散文 ⇒ 必须**看不见**（否则判据钉的是单词，不是调用形状）。
  const prose = findEmittedCalls(files.map((p) => {
    const f = read(p);
    return p === probe ? { ...f, text: `${f.text}\n// 别再写 emitted() 这种调用（#496）\n` } : f;
  }));
  assert.deepEqual(prose, [], `不带点的散文不该被拦：${prose.join(' | ')}`);
});
