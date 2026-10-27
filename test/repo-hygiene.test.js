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
