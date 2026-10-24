// 单测：gitlight.js（issue #359 P0a「收工灯」判定，决策见 AGENTS.md §7 D9）。
// 隔离约定（docs/testing.md §2.1）：tmp 目录注入 userSpaceRoot；真实 git 建夹具（本机有 git，
// 与 portal 装了 git 后的运行前提一致）；不碰真实用户空间。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getGitLight, SCAN_EXCLUDE_DIRS, GIT_LIGHT_MAX_REPOS } from '../src/gitlight.js';
import { DirError } from '../src/dirs.js';

const GIT_ID = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];

/** GIT_ID 必须放在**子命令之前**（`-c` 是 git 级选项）——写成 `git init -c ...` 会直接报 unknown option。 */
function git(args, cwd) {
  return execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tmpUserspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-gitlight-'));
  const projects = path.join(root, 'alice', 'projects');
  fs.mkdirSync(projects, { recursive: true });
  return { root, projects };
}

/** 在 projects/<name> 建一个仓库；opts.commits>0 时写 N 个提交并干净收尾。 */
function makeRepo(projects, name, { commits = 0, remote = null } = {}) {
  const dir = path.join(projects, name);
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  for (let i = 0; i < commits; i++) {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), `${i}\n`);
    git(['add', '-A'], dir);
    git(['commit', '-q',  '-m', `c${i}`], dir);
  }
  if (remote) {
    git(['remote', 'add', 'origin', remote], dir);
    git(['config', 'branch.main.remote', 'origin'], dir);
    git(['config', 'branch.main.merge', 'refs/heads/main'], dir);
  }
  return dir;
}

/** 造一个"已推送且干净"的仓库：bare 当远端 + clone + commit + push。 */
function makeSyncedRepo(projects, name) {
  const bare = path.join(projects, `${name}-remote.git`);
  fs.mkdirSync(bare, { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main'], bare);
  const dir = path.join(projects, name);
  git(['clone', '-q', bare, dir], projects);
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
  git(['add', '-A'], dir);
  git(['commit', '-q',  '-m', 'init'], dir);
  git(['push', '-q', '-u', 'origin', 'main'], dir);
  return { dir, bare };
}

const light = (root, cwd = '~/projects/p1', extra = {}) =>
  getGitLight({ userSpaceRoot: root, fdeName: 'alice', cwd, ...extra });

// ---------------------------------------------------------------------------
// 四态判定（§1 判定表）
// ---------------------------------------------------------------------------

test('无仓库 ⇒ ⚪ no_repo（不是红，也不是绿）', async () => {
  const { root, projects } = tmpUserspace();
  fs.mkdirSync(path.join(projects, 'p1'), { recursive: true });
  const r = await light(root);
  assert.equal(r.light, 'grey');
  assert.equal(r.reason, 'no_repo');
  assert.equal(r.repos.length, 0);
});

test('根无 .git 但上层（~/projects）是仓库 ⇒ ⚪ covered_by_outer_repo，不给红/绿（§4.1）', async () => {
  const { root, projects } = tmpUserspace();
  git(['init', '-q', '-b', 'main'], projects); // 用户曾在 ~/projects 这一层 init 过
  fs.mkdirSync(path.join(projects, 'p1'), { recursive: true });
  fs.writeFileSync(path.join(projects, 'p1', 'loose.txt'), 'x');
  const r = await light(root);
  assert.equal(r.light, 'grey');
  assert.equal(r.reason, 'covered_by_outer_repo', '必须如实说"被上层仓库覆盖"，不能让 status 把整个用户空间算成红');
  assert.equal(r.outer_repo, true);
});

test('0 提交 + 有内容 ⇒ 🔴 no_commits（"一点兜底都没有"，不依赖 status 输出）', async () => {
  const { root, projects } = tmpUserspace();
  makeRepo(projects, 'p1', { commits: 0 });
  fs.writeFileSync(path.join(projects, 'p1', 'src.js'), 'x');
  const r = await light(root);
  assert.equal(r.light, 'red');
  assert.equal(r.reason, 'no_commits');
  assert.equal(r.repos[0].no_commits, true);
});

test('0 提交 + 空目录 ⇒ ⚪ empty（别把刚 init 的空目录染红）', async () => {
  const { root, projects } = tmpUserspace();
  makeRepo(projects, 'p1', { commits: 0 });
  const r = await light(root);
  assert.equal(r.light, 'grey');
  assert.equal(r.reason, 'empty');
});

test('已跟踪文件被改 ⇒ 🔴 uncommitted', async () => {
  const { root, projects } = tmpUserspace();
  const dir = makeRepo(projects, 'p1', { commits: 1 });
  fs.writeFileSync(path.join(dir, 'f0.txt'), 'dirty\n');
  const r = await light(root);
  assert.equal(r.light, 'red');
  assert.equal(r.reason, 'uncommitted');
  assert.equal(r.repos[0].tracked_count, 1);
});

test('只有未跟踪新文件 ⇒ 🔴 untracked（这正是 -uno 会抹掉、从而撒谎的那一位）', async () => {
  const { root, projects } = tmpUserspace();
  const dir = makeRepo(projects, 'p1', { commits: 1 });
  fs.writeFileSync(path.join(dir, 'new-from-agent.js'), 'work\n'); // 干净基线 + 一个未跟踪文件
  const r = await light(root);
  assert.equal(r.light, 'red');
  assert.equal(r.reason, 'untracked', '未跟踪与未提交同罪（都是零兜底）——若实现退回 -uno，这条会红成 uncommitted 或直接判绿');
  assert.equal(r.repos[0].tracked_count, 0);
  assert.equal(r.repos[0].untracked_count, 1);
});

test('未跟踪目录要展开计入（git 会把整目录折叠成 `?? dir/`，折叠条不是文件）', async () => {
  const { root, projects } = tmpUserspace();
  const dir = makeRepo(projects, 'p1', { commits: 1 });
  fs.mkdirSync(path.join(dir, 'newdir', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'newdir', 'deeper', 'x.txt'), 'x');
  const r = await light(root);
  assert.equal(r.light, 'red');
  assert.equal(r.reason, 'untracked');
  assert.ok(r.repos[0].untracked_count >= 1);
});

test('干净 + 无远端 ⇒ 🟡 no_remote（常驻黄是有意的：auto-init 的仓库默认没有远端）', async () => {
  const { root, projects } = tmpUserspace();
  makeRepo(projects, 'p1', { commits: 2 });
  const r = await light(root);
  assert.equal(r.light, 'yellow');
  assert.equal(r.reason, 'no_remote');
  assert.equal(r.repos[0].push_state, 'no_remote');
});

test('干净且与远端一致 ⇒ 🟢 synced（唯一能给绿的形状）', async () => {
  const { root, projects } = tmpUserspace();
  makeSyncedRepo(projects, 'p1');
  const r = await light(root);
  assert.equal(r.light, 'green');
  assert.equal(r.reason, 'synced');
  assert.equal(r.git_available, true);
});

test('有提交未推送 ⇒ 🟡 unpushed_or_diverged（不猜方向，方向交给"问 AI"）', async () => {
  const { root, projects } = tmpUserspace();
  const { dir } = makeSyncedRepo(projects, 'p1');
  fs.writeFileSync(path.join(dir, 'b.txt'), '2\n');
  git(['add', '-A'], dir);
  git(['commit', '-q',  '-m', 'local only'], dir);
  const r = await light(root);
  assert.equal(r.light, 'yellow');
  assert.equal(r.reason, 'unpushed_or_diverged');
});

test('配了 upstream 但从未 fetch（无远端跟踪 ref）⇒ 🟡 never_fetched', async () => {
  const { root, projects } = tmpUserspace();
  makeRepo(projects, 'p1', { commits: 1, remote: 'file:///nonexistent/remote.git' });
  const r = await light(root);
  assert.equal(r.light, 'yellow');
  assert.equal(r.reason, 'never_fetched');
});

test('分支没有 upstream（有 remote 但 branch 未配）⇒ 🟡 no_upstream', async () => {
  const { root, projects } = tmpUserspace();
  const dir = makeRepo(projects, 'p1', { commits: 1 });
  git(['remote', 'add', 'origin', 'file:///nonexistent/o.git'], dir); // 只加 remote，不配 branch.*.merge
  const r = await light(root);
  assert.equal(r.reason, 'no_upstream');
  assert.equal(r.light, 'yellow');
});

// ---------------------------------------------------------------------------
// 必须存在的第 4 态：⚪（读不到 / 正忙 / 判不完 / 没 git）——**绝不渲染成绿**
// ---------------------------------------------------------------------------

test('.git/index.lock 在 ⇒ ⚪ busy（run 期间常见，不是错误）', async () => {
  const { root, projects } = tmpUserspace();
  const { dir } = makeSyncedRepo(projects, 'p1'); // 本可判绿
  fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');
  try {
    const r = await light(root);
    assert.equal(r.light, 'grey');
    assert.equal(r.reason, 'busy');
  } finally {
    fs.rmSync(path.join(dir, '.git', 'index.lock'));
  }
});

test('我们只读不写：跑完判定后目标仓库不得新增 .git/index.lock（不能挡住 agent 的路）', async () => {
  const { root, projects } = tmpUserspace();
  const { dir } = makeSyncedRepo(projects, 'p1');
  const lock = path.join(dir, '.git', 'index.lock');
  await light(root);
  assert.equal(fs.existsSync(lock), false, '出现 index.lock 说明 status 没带 --no-optional-locks');

  // 位置哨兵：`--no-optional-locks` 是 **git 级**选项，排在 `status` 后面会 `unknown option` 直接退（实测）
  // ⇒ 所有仓库默默变成「未检查」灰灯，不报错。只靠上面那条断言抓不到（不写 lock 也可能是根本没跑成）。
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'gitlight.js'), 'utf8');
  const call = /spawn\(gitBin,\s*\[([^\]]+)\]/.exec(src);
  assert.ok(call, 'spawn(gitBin, [...]) 形态变了，请同步这条哨兵');
  // ⚠ 两个都要钉：只判「顺序」抓不到「整个参数被删」（indexOf 返回 -1 反而比 status 更小 ⇒ 假绿）。
  const flagIdx = call[1].indexOf("'--no-optional-locks'");
  assert.ok(flagIdx >= 0, '参数里根本没有 --no-optional-locks ⇒ 会写 index.lock 挡住 agent');
  assert.ok(flagIdx < call[1].indexOf("'status'"),
    'git 级选项必须排在子命令之前，否则 status 报 unknown option ⇒ 灯永远是灰');
});

test('没有 git 二进制 ⇒ 干净已推送的仓库也不得显绿（缺数据 = 没资格承诺）', async () => {
  const { root, projects } = tmpUserspace();
  makeSyncedRepo(projects, 'p1');
  const r = await light(root, '~/projects/p1', { gitBin: 'definitely-not-a-git-binary-xyz' });
  assert.equal(r.git_available, false);
  assert.equal(r.light, 'grey');
  assert.equal(r.reason, 'git_unavailable');
});

test('扫描预算耗尽 ⇒ partial 落灰，不显绿（"没扫完"必须是明说的漏）', async () => {
  const { root, projects } = tmpUserspace();
  makeSyncedRepo(projects, 'p1');
  const dir = path.join(projects, 'p1');
  fs.mkdirSync(path.join(dir, 'sub-a'), { recursive: true }); // 有待入队的子目录，预算判据才有东西可判
  fs.mkdirSync(path.join(dir, 'sub-b'), { recursive: true });
  // now()：第一次给起点（算 deadline），第二次起直接跳出预算 ⇒ 发现阶段当场 partial
  let calls = 0;
  const now = () => (calls++ === 0 ? 1_000_000 : 1_000_000 + 10 ** 9);
  const r = await light(root, '~/projects/p1', { now });
  assert.equal(r.partial, true);
  assert.equal(r.light, 'grey');
  assert.equal(r.reason, 'unchecked_partial', '得如实说"没查完"');
});

test('.git 是读不懂的东西 ⇒ ⚪ unreadable，不 404 也不猜绿', async () => {
  const { root, projects } = tmpUserspace();
  const dir = path.join(projects, 'p1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), 'not a gitdir line\n');
  const r = await light(root);
  assert.equal(r.light, 'grey');
  assert.equal(r.reason, 'unreadable');
});

// ---------------------------------------------------------------------------
// 纯文本判据的两个必修细节：packed-refs 与 worktree commondir
// ---------------------------------------------------------------------------

test('refs 被打包进 packed-refs 后仍判 🟢（只看 refs/ 目录会误判成"从未同步"）', async () => {
  const { root, projects } = tmpUserspace();
  const { dir } = makeSyncedRepo(projects, 'p1');
  git(['pack-refs', '--all'], dir); // 松散 ref 被打进 packed-refs 并从盘上撤走
  assert.equal(fs.existsSync(path.join(dir, '.git', 'refs', 'remotes', 'origin', 'main')), false, '夹具得真的没有松散 ref');
  assert.ok(fs.existsSync(path.join(dir, '.git', 'packed-refs')));
  const r = await light(root);
  assert.equal(r.light, 'green', '判绿必须走 packed-refs');
});

test('linked worktree：refs 在 commondir 而不是 .git 文件指向的目录（照抄 listeners.js 会误判）', async () => {
  const { root, projects } = tmpUserspace();
  const { dir } = makeSyncedRepo(projects, 'p1');
  const wt = path.join(projects, 'p1-wt');
  git(['-C', dir, 'worktree', 'add', '-q', wt, '-b', 'wt-branch'], dir);
  // 夹具自证：worktree 的 .git 是文件，其 gitdir 目录里没有 refs/，refs 在 common dir
  const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(wt, '.git'), 'utf8'))[1].trim();
  assert.equal(fs.existsSync(path.join(gitdir, 'refs')), false, 'worktree 目录不该有 refs/');
  assert.equal(fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim(), '../..');

  fs.writeFileSync(path.join(wt, 'wt.txt'), '1\n');
  git(['-C', wt, 'add', '-A'], wt);
  git(['-C', wt, 'commit', '-q',  '-m', 'wt commit'], wt);
  const r = await light(root, '~/projects/p1-wt');
  const row = r.repos.find((x) => x.rel === '');
  assert.equal(row.branch, 'wt-branch', 'HEAD 要能从 per-worktree 目录读到');
  assert.notEqual(row.push_state, 'never_fetched', 'refs 必须去 common dir 找，否则误判"从未同步"');
  assert.equal(row.push_state, 'no_upstream'); // 新分支没 upstream：黄，而不是"从未同步"
  assert.equal(r.light, 'yellow');
});

// ---------------------------------------------------------------------------
// 多仓库（§4.2 / §4.3）：发现、聚合取最差、点名、空壳不拉高
// ---------------------------------------------------------------------------

test('一个目录三个子仓库 + 根空壳：脏的那个点名，空壳只出解释不拉高灯色', async () => {
  const { root, projects } = tmpUserspace();
  const dir = path.join(projects, 'p1');
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir); // worker 自动 init 的"空壳根仓库"
  for (const n of ['backend', 'frontend', 'infra']) {
    const sub = path.join(dir, n);
    fs.mkdirSync(sub, { recursive: true });
    git(['init', '-q', '-b', 'main'], sub);
    fs.writeFileSync(path.join(sub, 'x.js'), '1\n');
    git(['add', '-A'], sub);
    git(['commit', '-q',  '-m', 'i'], sub);
  }
  fs.writeFileSync(path.join(dir, 'backend', 'dirty.js'), 'uncommitted work\n'); // 只有 backend 脏

  const r = await light(root);
  assert.equal(r.light, 'red');
  assert.equal(r.primary.rel, 'backend', '必须点名到脏的那个仓库（预填给 AI 的话要指名目标）');
  const rootRow = r.repos.find((x) => x.rel === '');
  assert.equal(rootRow.shell, true, '根空壳（0 提交且里面全是别的仓库）要标出来');
  assert.equal(rootRow.reason, 'shell');
  assert.equal(rootRow.light, 'grey', '空壳不参与拉高灯色（它恒为红会把一切染红）');
  assert.equal(r.repos.find((x) => x.rel === 'frontend').light, 'yellow', '干净但无远端 ⇒ 黄');
  assert.ok(r.repos.find((x) => x.rel === 'infra'));
});

test('嵌套仓库嵌在 3 层深也要被发现（固定深度 2 会无声漏掉 ⇒ 用户看到绿）', async () => {
  const { root, projects } = tmpUserspace();
  const dir = path.join(projects, 'p1');
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  const deep = path.join(dir, 'nest', 'deep', 'proj');
  fs.mkdirSync(deep, { recursive: true });
  git(['init', '-q', '-b', 'main'], deep);
  fs.writeFileSync(path.join(deep, 'a.js'), '1\n');
  git(['add', '-A'], deep);
  git(['commit', '-q',  '-m', 'i'], deep);
  fs.writeFileSync(path.join(deep, 'dirty.js'), 'x');

  const r = await light(root);
  const deepRow = r.repos.find((x) => x.rel === 'nest/deep/proj');
  assert.ok(deepRow, '发现规则必须走到任意深度（预算内），不靠固定深度常量');
  assert.equal(deepRow.light, 'red');
  assert.equal(r.light, 'red');
});

test('node_modules 里的仓库不参与（与 runner 侧 EXCLUDE_DIRS 同口径）', async () => {
  const { root, projects } = tmpUserspace();
  const { dir } = makeSyncedRepo(projects, 'p1'); // 干净已推送 ⇒ 本应绿
  const dep = path.join(dir, 'node_modules', 'left-pad');
  fs.mkdirSync(dep, { recursive: true });
  git(['init', '-q', '-b', 'main'], dep); // 脏仓库藏在依赖里
  fs.writeFileSync(path.join(dep, 'index.js'), 'x');
  const r = await light(root);
  assert.equal(r.light, 'green', '依赖树里的仓库不该把灯染红');
  assert.equal(r.repos.length, 1);
});

test('仓库数封顶：超过上限不判色、partial=true 且不得显绿', async () => {
  const { root, projects } = tmpUserspace();
  const dir = path.join(projects, 'p1');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < GIT_LIGHT_MAX_REPOS + 3; i++) {
    const sub = path.join(dir, `r${i}`);
    fs.mkdirSync(sub, { recursive: true });
    git(['init', '-q', '-b', 'main'], sub);
  }
  const r = await light(root);
  assert.equal(r.truncated_repos, 3);
  assert.equal(r.partial, true);
  assert.equal(r.light, 'grey', '没扫完就没资格承诺');
});

test('多仓库全干净且都已推送 ⇒ 🟢（绿 = 全部仓库都收工，不是"有一个收工了"）', async () => {
  const { root, projects } = tmpUserspace();
  const dir = path.join(projects, 'p1');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['a', 'b']) {
    const bare = path.join(projects, `${n}-remote.git`);
    fs.mkdirSync(bare, { recursive: true });
    git(['init', '-q', '--bare', '-b', 'main'], bare);
    const sub = path.join(dir, n);
    git(['clone', '-q', bare, sub], dir);
    fs.writeFileSync(path.join(sub, 'f.txt'), '1\n');
    git(['-C', sub, 'add', '-A'], sub);
    git(['-C', sub, 'commit', '-q',  '-m', 'i'], sub);
    git(['-C', sub, 'push', '-q', '-u', 'origin', 'main'], sub);
  }
  const r = await light(root);
  assert.equal(r.counts.green, 2);
  assert.equal(r.light, 'green');

  // 任一仓库脏 ⇒ 整灯红（取最差）
  fs.writeFileSync(path.join(dir, 'b', 'f.txt'), 'dirty\n');
  const r2 = await light(root);
  assert.equal(r2.light, 'red');
  assert.equal(r2.primary.rel, 'b');
});

// ---------------------------------------------------------------------------
// 边界与红线
// ---------------------------------------------------------------------------

test('不泄漏 remote URL（可能内嵌 user:token@）：响应体里搜不到 URL 与 token', async () => {
  const { root, projects } = tmpUserspace();
  const dir = makeRepo(projects, 'p1', { commits: 1, remote: 'https://user:ghp_SECRET123@github.com/acme/p1.git' });
  assert.ok(dir);
  const r = await light(root);
  const s = JSON.stringify(r);
  assert.ok(!s.includes('ghp_SECRET123'), '响应里出现凭据 = 泄漏');
  assert.ok(!s.includes('github.com'), '不输出远端主机名（只需要分支名与状态）');
});

test('非法 cwd ⇒ 400 validation_failed；目录不存在 ⇒ 404 not_found（与 dirs.js 同一套映射）', async () => {
  const { root, projects } = tmpUserspace();
  fs.mkdirSync(path.join(projects, 'p1'), { recursive: true });
  await assert.rejects(() => light(root, '~/projects/../p1'), (e) => e instanceof DirError && e.httpStatus === 400);
  await assert.rejects(() => light(root, '~/projects/nope'), (e) => e instanceof DirError && e.httpStatus === 404);
  await assert.rejects(() => light(root, '/etc'), (e) => e instanceof DirError && e.httpStatus === 400);
});

test('根目录本身是 symlink ⇒ 404（与 fileTree/readFilePreview 同口径，不放行 jail 外泄漏）', async () => {
  const { root, projects } = tmpUserspace();
  const real = path.join(root, 'elsewhere');
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(real, path.join(projects, 'p1'));
  await assert.rejects(() => light(root), (e) => e instanceof DirError && e.httpStatus === 404);
});

test('哨兵：排除名单必须与 runner 侧 artifacts.js 的 EXCLUDE_DIRS 同步（两份清单必然漂移，钉住）', async () => {
  const artifactsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'runner', 'lib', 'artifacts.js');
  const src = fs.readFileSync(artifactsPath, 'utf8');
  const m = /EXCLUDE_DIRS\s*=\s*new Set\(\[([^\]]+)\]\)/.exec(src);
  assert.ok(m, 'runner 侧 EXCLUDE_DIRS 形态变了，请同步这里的哨兵');
  const runnerSet = new Set(m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')));
  assert.deepEqual([...SCAN_EXCLUDE_DIRS].sort(), [...runnerSet].sort(), 'portal 侧与 runner 侧的排除名单漂移');
});
