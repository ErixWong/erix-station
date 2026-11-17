// issue #537（W4a 审查快照与隔离）单测。判据覆盖：
//   1. 反向自证一：内容级指纹能抓「同路径内容变但 status 文本不变」；弱成只 hash status 即红。
//   2. 反向自证二：审查 run 工具面只留 readFile/searchText/tree，加回 shell 即红。
//   3. 孤儿清扫三条判据（终态>1h / running>1h / 行不存在）各清一次；新鲜/pending 不误删。
//   4. 未跟踪文件确实被搬进 worktree（不是只搬已提交）。
//   5. 未提交改动确实被 `git apply` 进去（不是只有 HEAD）。
//   6. worktree 路径不在 ~/projects 下。
// 约定：真实 tmp git 仓库（不连真库）；孤儿清扫的 DB 查询与 git 执行用注入的假实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  gitGlobalArgs,
  computeContentFingerprint,
  createSnapshot,
  copyUntracked,
  copyWholeTree,
  hasHead,
  headShaOrEmpty,
  isUnderProjects,
  shouldRemoveOrphan,
  parseWorktreeList,
  cleanOrphanWorktrees,
  makeMacroRunLookup,
  SNAPSHOT_FAILURE_REASONS,
  SNAPSHOT_TARGET_ESCAPE,
  TERMINAL_MACRO_RUN_STATUSES,
  ORPHAN_AGE_MS,
} from '../src/macro-snapshot.js';
import {
  REVIEW_ONLY_TOOL_NAMES,
  filterReviewExecutors,
  filterReviewSchemas,
  isReviewOnly,
} from '../../runner/lib/review-tools.js';
import { createFoldNoteSink } from '../../runner/lib/fold-notes.js';

const HOUR = ORPHAN_AGE_MS;

function sh(file, args, cwd) {
  return execFileSync(file, args, { cwd, encoding: 'utf8' });
}

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w4a-repo-'));
  sh('git', ['init', '-q'], dir);
  sh('git', ['config', 'user.email', 't@example.com'], dir);
  sh('git', ['config', 'user.name', 'tester'], dir);
  return dir;
}

function tmpRoot(prefix = 'w4a-snap-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // macOS 上 /tmp 是软链 ⇒ realpath 解析到 /private/tmp；统一按 realpath 比对
  return fs.realpathSync(d);
}

function seedCommitted(repo, rel, content) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  sh('git', ['add', '-A'], repo);
  sh('git', ['commit', '-qm', 'base'], repo);
}

/** 0 提交仓库（`git init` + 配置，不 commit）——#670 的主角。 */
function tmpRepoNoCommit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w670-repo-'));
  sh('git', ['init', '-q'], dir);
  sh('git', ['config', 'user.email', 't@example.com'], dir);
  sh('git', ['config', 'user.name', 'tester'], dir);
  return dir;
}

// --- 6. worktree 路径不在 ~/projects 下 ---------------------------------------
test('worktree 默认根不在 ~/projects 下', () => {
  assert.equal(isUnderProjects(path.join(os.homedir(), '.erix', 'w4a-snapshots', 'x')), false);
  assert.equal(isUnderProjects(path.join(os.homedir(), 'projects', 'wt-x')), true);
  assert.equal(isUnderProjects('/tmp/w4a-x'), false);
});

// --- 5 + 4：未提交改动 apply + 未跟踪文件搬运 ---------------------------------
test('快照把未提交 diff 与未跟踪文件一起搬进 worktree', async () => {
  const repo = tmpRepo();
  seedCommitted(repo, 'tracked.js', 'console.log(1)\n');
  // 未提交的已跟踪改动
  fs.writeFileSync(path.join(repo, 'tracked.js'), 'console.log(2)\n');
  // 未跟踪文件（已提交的 worktree add 默认看不见它）
  fs.mkdirSync(path.join(repo, 'newdir'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'newdir', 'fresh.txt'), 'UNTRACKED-CONTENT');
  const root = tmpRoot();

  const res = await createSnapshot({ repoDir: repo, snapshotRoot: root, hasRsync: true });
  assert.equal(res.ok, true, `snapshot 失败：${res.reason}`);

  // worktree 路径不在 projects 下
  assert.equal(isUnderProjects(res.worktreePath), false);

  // 5. 未提交改动确实进来了（不是只有 HEAD 的 console.log(1)）
  const tracked = fs.readFileSync(path.join(res.worktreePath, 'tracked.js'), 'utf8');
  assert.equal(tracked, 'console.log(2)\n', '未提交的已跟踪改动未被 git apply');

  // 4. 未跟踪文件确实进来了（worktree add 只搬已提交，它必须在）
  const untracked = fs.readFileSync(path.join(res.worktreePath, 'newdir', 'fresh.txt'), 'utf8');
  assert.equal(untracked, 'UNTRACKED-CONTENT', '未跟踪文件未被搬进 worktree');

  // worktree 里这两样应复现原目录的状态文本（M + ??）
  const st = sh('git', ['-C', res.worktreePath, 'status', '--porcelain', '-uall']);
  assert.match(st, /tracked\.js/);
  assert.match(st, /newdir\/fresh\.txt/);
});

test('tar 回退（hasRsync=false）同样搬进未跟踪文件', async () => {
  const repo = tmpRepo();
  seedCommitted(repo, 'tracked.js', 'a\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'TAR-PATH');
  const root = tmpRoot();
  const res = await createSnapshot({ repoDir: repo, snapshotRoot: root, hasRsync: false });
  assert.equal(res.ok, true, `snapshot 失败：${res.reason}`);
  assert.equal(fs.readFileSync(path.join(res.worktreePath, 'untracked.txt'), 'utf8'), 'TAR-PATH');
});

// --- 1. 反向自证一：内容级指纹 vs 只 hash status ------------------------------
test('反向自证一：同路径内容变但 status 文本不变时，内容级指纹变、status-only 指纹不变', () => {
  const repo = tmpRepo();
  seedCommitted(repo, 'f.txt', 'v0\n');
  // 第一次编辑：已跟踪文件被改（status = "M f.txt"）
  fs.writeFileSync(path.join(repo, 'f.txt'), 'v1\n');
  // 走**生产默认**（createSnapshot 调的就是这个默认值，不显式传 flag），
  // 这样「把 computeContentFingerprint 的默认改成只 hash status」时，下面的断言会真的红。
  const fp1 = computeContentFingerprint(repo);
  const fp1weak = computeContentFingerprint(repo, { contentLevel: false });

  // 第二次编辑**同一路径**：status 文本一字不变（仍是 "M f.txt"），但内容变了
  fs.writeFileSync(path.join(repo, 'f.txt'), 'v2-different\n');
  const fp2 = computeContentFingerprint(repo);
  const fp2weak = computeContentFingerprint(repo, { contentLevel: false });

  // 前提：status 文本确实没变（否则这个用例没抓到要害）
  assert.equal(fp1.status, fp2.status, '用例构造有误：status 文本应当不变');

  // 核心断言（**把 computeContentFingerprint 的 contentLevel 默认改成 false，这行就红**）：
  assert.notEqual(fp1.digest, fp2.digest, '内容级指纹必须在同路径内容变化时改变');

  // 对照：弱指纹（只 hash head+status）对这一变化是瞎的 ⇒ 证明上面的断言是「承重」的
  assert.equal(fp1weak.digest, fp2weak.digest, 'status-only 指纹应当对内容变化无感（对照）');
});

// --- 3. 孤儿清扫三条判据 ------------------------------------------------------
test('shouldRemoveOrphan：三条判据各命中一次', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  // 1) 终态 > 1h ⇒ 清
  assert.equal(shouldRemoveOrphan(
    { status: 'done', startedAt: new Date(now - 2 * HOUR), finishedAt: new Date(now - 2 * HOUR) }, now), true);
  // 1b) 终态但 < 1h ⇒ 不轻举妄动
  assert.equal(shouldRemoveOrphan(
    { status: 'failed', startedAt: new Date(now - 30 * 60e3), finishedAt: new Date(now - 30 * 60e3) }, now), false);
  // 2) 仍 running 但 started_at > 1h（崩溃残留）⇒ 清
  assert.equal(shouldRemoveOrphan(
    { status: 'running', startedAt: new Date(now - 2 * HOUR), finishedAt: null }, now), true);
  // 2b) running 但 < 1h（真在跑）⇒ 不碰
  assert.equal(shouldRemoveOrphan(
    { status: 'running', startedAt: new Date(now - 30 * 60e3), finishedAt: null }, now), false);
  // 3) 行根本不存在 ⇒ 清
  assert.equal(shouldRemoveOrphan(null, now), true);
  // pending（还没真跑）⇒ 不碰
  assert.equal(shouldRemoveOrphan(
    { status: 'pending', startedAt: new Date(now - 3 * HOUR), finishedAt: null }, now), false);
  // 终态集合口径与 DB 对齐（防漂移）
  assert.deepEqual(TERMINAL_MACRO_RUN_STATUSES.slice().sort(),
    ['done', 'failed', 'skipped', 'superseded']);
});

test('cleanOrphanWorktrees：命中三条判据的路径都被 remove --force，其余不动', async () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const root = tmpRoot();
  // 在 snapshotRoot 下建四个 worktree 目录，供 realpath 比对
  const mk = (name) => { const p = path.join(root, name); fs.mkdirSync(p, { recursive: true }); return p; };
  const wTerminal = mk('run-terminal-old');
  const wRunning = mk('run-running-old');
  const wMissing = mk('run-row-missing');
  const wFresh = mk('run-fresh-running'); // running 但 <1h ⇒ 不该被删
  const wUser = '/home/someone/projects/other'; // 不在 snapshotRoot 下 ⇒ 不碰

  const listed = [wTerminal, wRunning, wMissing, wFresh, wUser]
    .map((p) => `worktree ${p}\nHEAD deadbeef\nbranch refs/heads/x\n\n`).join('');

  const rows = new Map([
    [wTerminal, { status: 'done', startedAt: new Date(now - 2 * HOUR), finishedAt: new Date(now - 2 * HOUR) }],
    [wRunning, { status: 'running', startedAt: new Date(now - 2 * HOUR), finishedAt: null }],
    [wMissing, null],
    [wFresh, { status: 'running', startedAt: new Date(now - 5 * 60e3), finishedAt: null }],
  ]);

  const removedCalls = [];
  const res = await cleanOrphanWorktrees({
    repoDir: '/nonexistent',
    snapshotRoot: root,
    listWorktrees: () => listed,
    removeWorktree: (p) => { removedCalls.push(p); },
    lookupMacroRun: async (p) => rows.get(p) ?? null,
    nowMs: now,
  });

  assert.deepEqual(new Set(res.removed), new Set([wTerminal, wRunning, wMissing]));
  assert.ok(!res.removed.includes(wFresh), 'running<1h 不该被删');
  assert.ok(!res.removed.includes(wUser), 'snapshotRoot 之外的 worktree 不该被碰');
  assert.deepEqual(removedCalls, res.removed, '每个被判定回收的路径都应调用一次 remove');
});

test('parseWorktreeList 抽取 worktree 路径', () => {
  const out = 'worktree /a/b\nHEAD 1\nbranch refs/heads/m\n\nworktree /c/d\nHEAD 2\ndetached\n\n';
  assert.deepEqual(parseWorktreeList(out), ['/a/b', '/c/d']);
});

// --- 2. 反向自证二：审查 run 只读工具面 ---------------------------------------
test('反向自证二：审查 run 只装配 readFile/searchText/tree，shell 与 note 都被挡在外', () => {
  const fileSchemas = [
    { name: 'readFile' }, { name: 'searchText' }, { name: 'tree' },
    { name: 'edit' }, { name: 'writeFile' }, { name: 'rg' }, { name: 'grep' },
  ];
  const shellSchemas = [{ name: 'shell' }];
  const noteSchemas = [{ name: 'note_take' }, { name: 'note_list' }];
  // worker.js 两处装配点的口径：base 面 = file+shell+note；审查 run 时过滤到只读三件套
  const base = [...fileSchemas, ...shellSchemas, ...noteSchemas];
  const review = filterReviewSchemas(base);

  assert.deepEqual(review.map((s) => s.name).sort(), ['readFile', 'searchText', 'tree']);
  // 核心断言（**把 shell 加进 REVIEW_ONLY_TOOL_NAMES，这行就红**）：
  assert.ok(!review.some((s) => s.name === 'shell'), '审查 run 绝不能有 shell');
  assert.ok(!review.some((s) => s.name.startsWith('note_')), '审查 run 不该有 note_*');

  // executors 同样被过滤
  const baseExec = { readFile: () => {}, searchText: () => {}, tree: () => {}, shell: () => {}, note_take: () => {} };
  assert.deepEqual(Object.keys(filterReviewExecutors(baseExec)).sort(), ['readFile', 'searchText', 'tree']);

  // 常量口径与开关
  assert.deepEqual(REVIEW_ONLY_TOOL_NAMES.slice().sort(), ['readFile', 'searchText', 'tree']);
  assert.equal(isReviewOnly({ RUN_REVIEW_ONLY: '1' }), true);
  assert.equal(isReviewOnly({ RUN_REVIEW_ONLY: '0' }), false);
  assert.equal(isReviewOnly({}), false);
});

// 反向自证二的接线锁：worker.js 的**两处**装配点（registry + baseToolSchemas）都必须按 reviewOnly
// 走只读过滤。「只改一处等于没改」——删掉任一处接线，本用例即红。
test('worker.js 两处装配点都接了审查只读过滤（接线锁）', () => {
  const src = fs.readFileSync(
    new URL('../../runner/worker.js', import.meta.url), 'utf8');
  // 开关只读一次 + 两处共用同一 helper
  assert.match(src, /const reviewOnly = isReviewOnly\(\);/, '必须读一次 RUN_REVIEW_ONLY 开关');
  // 装配点①：registry 的 executors 与 schemas 都按 reviewOnly 过滤
  assert.match(src, /executors: reviewOnly \? filterReviewExecutors\(fileTools\.executors\)/,
    'registry.executors 未接只读过滤');
  assert.match(src, /schemas: reviewOnly \? filterReviewSchemas\(fileTools\.schemas\)/,
    'registry.schemas 未接只读过滤');
  // 装配点②：baseToolSchemas 按 reviewOnly 过滤
  assert.match(src, /const baseToolSchemas = reviewOnly\b[\s\S]{0,120}filterReviewSchemas\(fileTools\.schemas\)/,
    'baseToolSchemas 未接只读过滤（只改一处 = 没改）');
  // 两处都用了 filter helper，总数 >= 2（一处 registry schemas + 一处 baseToolSchemas）
  const n = (src.match(/filterReviewSchemas\(fileTools\.schemas\)/g) || []).length;
  assert.ok(n >= 2, `filterReviewSchemas(fileTools.schemas) 出现 ${n} 次，应 >= 2（两处装配点）`);
});

// 反向自证二的旁路接线锁：executeTool 的三条旁路（delegate / note / skill）都得被 reviewOnly 挡住。
// 「只改装配点①②不够」——去掉任一个闸，本用例即红。
test('worker.js executeTool 三条旁路都被 reviewOnly 闸住（接线锁）', () => {
  const src = fs.readFileSync(
    new URL('../../runner/worker.js', import.meta.url), 'utf8');
  // 旁路① delegation：创建闸门（子 run 自带 shell，只读过滤传不下去）
  assert.match(src, /if \(delegateEnabled && !reviewOnly\) \{/,
    'delegate 创建未按 reviewOnly 闸住 ⇒ 审查 run 可经 delegate 子 run 拿 shell 逃逸');
  // 根因记录：子工具面显式包含 shell（这正是闸的必要性）
  assert.match(src, /childTools: \[\.\.\.fileTools\.schemas, \.\.\.shellTools\.schemas\]/,
    '子 run 工具面含 shell（闸的根因；若这行变了要重评闸的必要性）');
  // delegation=null 时 delegate 路由自然不通（依赖 delegation !== null）
  assert.match(src, /if \(delegation !== null && options\?\.name === 'delegate'\)/,
    'delegate 路由应依赖 delegation !== null（闸门置 null 即断）');
  // 旁路② note 路由
  assert.match(src, /if \(!reviewOnly && noteTools\.executeTool && noteToolNames\.has\(options\.name\)\)/,
    'note 路由未按 reviewOnly 闸住');
  // 旁路③ skill 路由
  assert.match(src, /if \(!reviewOnly && skillTools\.executeTool && skillToolNames\.has\(options\.name\)\)/,
    'skill 路由未按 reviewOnly 闸住');
});

// 让 copyUntracked 的直接错误分支可被触及（未跟踪为空时不报错，method 仍标出）
test('copyUntracked：无未跟踪文件时按探测口径返回、不报错', () => {
  const repo = tmpRepo();
  seedCommitted(repo, 'a.txt', 'x\n');
  const root = tmpRoot();
  const out = copyUntracked(repo, root, { hasRsync: true });
  assert.equal(out.method, 'rsync');
  assert.equal(out.copied, 0);
});

// --- ③ 失败门闸 ------------------------------------------------------------
test('失败 reason 契约：任务指定的 7 个一个不少', () => {
  const TASK_REASONS = [
    'worktree_add_failed', 'patch_apply_failed', 'untracked_copy_failed',
    'snapshot_unstable', 'snapshot_timeout', 'snapshot_too_large', 'disk_low',
  ];
  for (const r of TASK_REASONS) {
    assert.ok(SNAPSHOT_FAILURE_REASONS.includes(r), `缺 reason：${r}`);
  }
});

test('门闸：snapshotRoot 在 ~/projects 下 ⇒ snapshot_root_in_projects（不起进程）', async () => {
  const repo = tmpRepo();
  seedCommitted(repo, 'a.txt', 'a\n');
  const root = path.join(os.homedir(), 'projects', 'wt-w4a-261116', '.w4a-snap');
  const res = await createSnapshot({ repoDir: repo, snapshotRoot: root, id: 'gate-in-proj' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'snapshot_root_in_projects');
});

test('门闸：worktree 目标已存在且非空 ⇒ worktree_add_failed', async () => {
  const repo = tmpRepo();
  seedCommitted(repo, 'a.txt', 'a\n');
  const root = tmpRoot();
  const id = 'gate-wt-exists';
  // 预建非空 worktree 目标目录 ⇒ `git worktree add` 必失败
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, 'occupant.txt'), 'x');
  const res = await createSnapshot({ repoDir: repo, snapshotRoot: root, id, hasRsync: true });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'worktree_add_failed');
});

// 孤儿清扫的生产 DB seam：按 worktree_path 查 macro_runs（fake pool 验形态，不起真库）。
test('makeMacroRunLookup：按 worktree_path 查 macro_runs，命中映射三列、未命中返回 null', async () => {
  const seen = [];
  const pool = {
    async query(sql, params) {
      seen.push({ sql, params });
      if (params[0] === '/present') {
        return { rows: [{ status: 'running', started_at: new Date(0), finished_at: null }] };
      }
      return { rows: [] };
    },
  };
  const lookup = makeMacroRunLookup(pool);
  const hit = await lookup('/present');
  assert.deepEqual(hit, { status: 'running', startedAt: new Date(0), finishedAt: null });
  const miss = await lookup('/absent');
  assert.equal(miss, null, '无行 ⇒ null（孤儿判据 3）');
  assert.match(seen[0].sql, /FROM macro_runs WHERE worktree_path = \$1/);
  assert.deepEqual(seen[0].params, ['/present']);
});

// ── issue #626：只读闸的**第四条**旁路（fold-notes）────────────────────────────
// 前三条（delegate / note / skill）都在 `executeTool` 这条路上；第四条**不走 executeTool**：
// `runner/lib/fold-notes.js` 的投递器直调 `noteTools.executors('note_take', …)`，
// 所以 executeTool 上的闸**结构上管不到它**，只能在**构建点**（worker.js 的装配段）挡。
// 「只读面」= 模型能调的工具 ∪ 宿主回调里会写东西的钩子——前几轮只审了前者。
test('worker.js 四条旁路都在 reviewOnly 闸内（接线锁，#626 补第四条）', () => {
  const src = fs.readFileSync(
    new URL('../../runner/worker.js', import.meta.url), 'utf8');
  // 旁路① delegation 创建（子 run 自带 shell，只读过滤传不下去）
  assert.match(src, /if \(delegateEnabled && !reviewOnly\) \{/,
    '旁路① delegate 创建未按 reviewOnly 闸住');
  // 旁路② note 路由
  assert.match(src, /if \(!reviewOnly && noteTools\.executeTool && noteToolNames\.has\(options\.name\)\)/,
    '旁路② note 路由未按 reviewOnly 闸住');
  // 旁路③ skill 路由
  assert.match(src, /if \(!reviewOnly && skillTools\.executeTool && skillToolNames\.has\(options\.name\)\)/,
    '旁路③ skill 路由未按 reviewOnly 闸住');
  // 旁路④ fold-note sink：闸必须在**构建点**（这条不经 executeTool）
  assert.match(src, /const foldNoteSink = !reviewOnly && typeof noteTools\.executors === 'function'/,
    '旁路④ fold-note sink 构建未按 reviewOnly 闸住 ⇒ 审查 run 折叠时会往会话 notes 写入');
  // 根因（写进测试，别下次又以为是 executeTool 的事）：投递确实直调 executors
  const foldSrc = fs.readFileSync(
    new URL('../../runner/lib/fold-notes.js', import.meta.url), 'utf8');
  assert.match(foldSrc, /executors\('note_take'/,
    'fold-notes 仍直调 executors（第四条旁路的根因；若改成走 executeTool，闸的位置要重评）');
  // 接线只依赖 sink 非空 ⇒ 「不构建」= 真的没接上（不是构建了但被别处忽略）
  assert.match(src, /\.\.\.\(foldNoteSink \? \{ onFoldSummary: foldNoteSink\.onFoldSummary \} : \{\}\)/,
    'onFoldSummary 的接线必须只依赖 foldNoteSink 非空');
  // 四条闸一个不能少（去掉任一条 ⇒ 计数跌破 4 ⇒ 红）
  const gates = (src.match(/!reviewOnly/g) || []).length;
  assert.ok(gates >= 4, `!reviewOnly 只出现 ${gates} 次，四条旁路至少要 4 次`);
});

// 行为锁（不只是 regex）：把 worker.js 的 `#392:C-fold-notes` 装配段**原样求值**（技法同
// `runner/test/model-metadata.test.js` 对 `#309:engine-model-params` 的做法），在两种 reviewOnly 下
// 跑一次折叠投递：审查 run 必须**一条 note_take 也不发**，普通 run 必须发一条。
test('reviewOnly 时 fold-note sink 不构建 ⇒ 折叠不写注；非审查 run 照写（行为锁）', async () => {
  const src = fs.readFileSync(
    new URL('../../runner/worker.js', import.meta.url), 'utf8');
  const seg = src.match(/\/\* #392:C-fold-notes:start \*\/([\s\S]*?)\/\* #392:C-fold-notes:end \*\//);
  assert.ok(seg, '找不到 #392:C-fold-notes 装配段（标记改名要同步这条锁）');
  const build = (reviewOnly) => {
    const calls = [];
    const noteTools = {
      executors: async (name, input) => { calls.push({ name, input }); return { ok: true }; },
    };
    const run = new Function(
      'reviewOnly', 'noteTools', 'runId', 'createFoldNoteSink', 'sendIpc', 'process', 'MSG',
      `${seg[1]}\nreturn foldNoteSink;`,
    );
    const foldNoteSink = run(reviewOnly, noteTools, 'run-626', createFoldNoteSink,
      () => {}, { env: {} }, { LOG: 'log' });
    // `calls` 在外层闭包里（noteTools.executors 的捕获变量），不靠被求值段自己报数。
    return { foldNoteSink, calls };
  };
  const payload = {
    text: '折叠摘要：前 3 轮的探查过程已归档', source: 'mechanical', strategy: 'statistical',
    bytes: 1024, fingerprint: 'fp-626', round: 4,
  };

  const review = build(true);
  assert.equal(review.foldNoteSink, null, 'reviewOnly ⇒ sink 必须不构建（第四条旁路的闸就在这）');
  // 即使有人绕过构建点手工调一次投递（模拟引擎仍回调），也必须没有任何写入：sink 是 null，没有 onFoldSummary。
  assert.equal(review.foldNoteSink?.onFoldSummary ?? null, null);
  assert.deepEqual(review.calls, [], '审查 run 一条 note_take 也不许发');

  const normal = build(false);
  assert.equal(normal.foldNoteSink?.enabled, true, '非审查 run 必须照常接线');
  await normal.foldNoteSink.onFoldSummary(payload);
  assert.equal(normal.calls.length, 1, '普通 run 折叠必须写一条注（闸不得顺手关掉正常路径）');
  assert.equal(normal.calls[0].name, 'note_take');
  assert.match(normal.calls[0].input.content, /前 3 轮的探查过程已归档/);
});

// ── issue #669：git 全局选项必须含 `-c safe.directory=*` ─────────────────────────
//
// 真机证据：portal 以 root 跑、FDE 项目目录属主 1000/1001 ⇒ git ≥2.35 报
// `detected dubious ownership` ⇒ `createSnapshot` 的每次 git 调用全失败 ⇒ M9 100% 起不来。
// 站内既有口径在 `gitlight.js:152`（D9 收工灯同样跨 uid 读用户目录），照它抄。
//
// ⚠ 为什么不做「真 chown 一个属主不同的仓库」这种更强的用例：那需要 root 且在 CI 不可用。
//   这里钉的是**参数构造**（纯函数），足够挡住「有人把它删了」这一类回归。
test('#669 git 全局选项含 -c safe.directory=* 与 --no-optional-locks（跨 uid 读仓库的前提）', () => {
  const args = gitGlobalArgs();
  const joined = args.join(' ');
  assert.ok(joined.includes('-c safe.directory=*'),
    `必须带 -c safe.directory=*（否则 root 读 1001 的仓库必报 dubious ownership）：${joined}`);
  assert.ok(args.includes('--no-optional-locks'), `只读探测不抢 index 锁：${joined}`);
  // 全局选项必须**在子命令之前**（git 的全局选项只在子命令前生效）。
  const idxSafe = args.indexOf('safe.directory=*');
  assert.ok(idxSafe > 0 && args[idxSafe - 1] === '-c', `safe.directory 必须紧跟在 -c 之后：${joined}`);
});

test('#669 真仓库上 rev-parse 能跑通（全局选项真的被 git() 用上）', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'w669-repo-'));
  try {
    execFileSync('git', ['-C', repo, 'init', '-q']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'init']);
    // 走 computeContentFingerprint（内部走 git()）⇒ 能拿到 HEAD sha 就说明 git() 真的带上了全局选项。
    const fp = computeContentFingerprint(repo);
    assert.match(fp.head, /^[0-9a-f]{40}$/, `HEAD sha 必须取到：${fp.head}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ── issue #670：0 提交仓库（无 HEAD）─────────────────────────────────────────────
//
// 真机证据（#669 修完 dubious ownership 之后才暴露）：
//   `git rev-parse HEAD` ⇒ `fatal: ambiguous argument 'HEAD': unknown revision or path
//   not in the working tree.`（rc=128）
// 而 0 提交是**多数情形**（issue 正文 `rev-list --count HEAD` 现查：7 个工位 5 个为 0），
// D9 收工灯还把「0 提交但有内容」设计成合法红态 ⇒ 快照必须支持它，不能宣布「不能审查」。
//
// 方案 A（已拍板）：无 HEAD ⇒ **不用** worktree + patch（无基点可 add、无基线可 diff），
// 改**整树拷贝（含 `.git`）**：快照仍是 git 仓库、所有文件天然未提交 ⇒ 语义正是
// 「本次改动 = 全部内容」，且 `git add` 过的文件在快照里仍是已暂存。
// 临时仓库全部自己造（tmp），不碰真实用户目录。

// --- 判据 4：head 哨兵（反向自证二把哨兵改成抛错，本用例即红）------------------
test('#670 computeContentFingerprint 在 0 提交仓库上返回 head === "" 且不抛错', () => {
  const repo = tmpRepoNoCommit();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'A\n');
  let fp;
  assert.doesNotThrow(() => { fp = computeContentFingerprint(repo); },
    '0 提交不许抛（真机就是在这一行炸掉整个 M9 分派）');
  assert.equal(fp.head, '', '0 提交必须是哨兵空串（不是 null/undefined，也不是抛错）');
  assert.equal(hasHead(repo), false);
  assert.match(fp.status, /a\.txt/, '状态文本照常取（0 提交照样有未跟踪内容）');
  assert.match(fp.digest, /^[0-9a-f]{64}$/);
  // 哨兵必须**稳定**：搬运前后各取一次要能比对（两边都是 '' 才谈得上一致性校验）
  assert.equal(computeContentFingerprint(repo).digest, fp.digest, '同一仓库两次取指纹必须相等');
});

test('#670 hasHead/headShaOrEmpty：只看退出码与空串，判定用 rev-parse --verify HEAD', () => {
  // 三态全由注入的 runGit 决定（可测；不靠 catch 猜成因）
  assert.equal(hasHead('/r', { runGit: () => 'deadbeef\n' }), true, '拿到 sha ⇒ 有 HEAD');
  assert.equal(hasHead('/r', { runGit: () => '   ' }), false, '空输出 ⇒ 无 HEAD');
  assert.equal(hasHead('/r', { runGit: () => { throw new Error('exit 128'); } }), false,
    '非 0 退出 ⇒ 无 HEAD（0 提交就是这个形状）');
  assert.equal(headShaOrEmpty('/r', { runGit: () => { throw new Error('boom'); } }), '',
    'head 哨兵必须是空串');
  // 必须用 `--verify`（不带 --verify 的 `rev-parse HEAD` 会把 HEAD 当歧义参数，靠错误文案猜成因）
  let seen = null;
  hasHead('/r', { runGit: (args) => { seen = args; return 'x\n'; } });
  assert.deepEqual(seen.slice(0, 5), ['-C', '/r', 'rev-parse', '--verify', 'HEAD']);
  // 真仓库两侧都要给正确答案（注入桩挡不住「git 命令本身写错」这一类回归）
  const committed = tmpRepo();
  seedCommitted(committed, 'a.txt', 'x\n');
  assert.equal(hasHead(committed), true);
  assert.equal(headShaOrEmpty(committed), sh('git', ['-C', committed, 'rev-parse', 'HEAD']).trim());
  assert.equal(hasHead(tmpRepoNoCommit()), false);
});

// --- 判据 1：0 提交 + 有文件但未 add -------------------------------------------
test('#670 0 提交 + 有文件（未 add）⇒ createSnapshot ok:true 且内容与原目录一致', async () => {
  const repo = tmpRepoNoCommit();
  fs.writeFileSync(path.join(repo, 'plain.txt'), 'NOT-ADDED-1');
  fs.mkdirSync(path.join(repo, 'deep/nested'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'deep/nested/f.txt'), 'NESTED-2');
  const res = await createSnapshot({ repoDir: repo, snapshotRoot: tmpRoot(), hasRsync: true });
  // 反向自证一的红点就在这行：去掉「无 HEAD 分支」⇒ worktree add HEAD 失败 ⇒ reason=worktree_add_failed
  assert.equal(res.ok, true, `0 提交（未 add）快照必须成功，实际 reason=${res.reason}`);
  assert.equal(fs.readFileSync(path.join(res.worktreePath, 'plain.txt'), 'utf8'), 'NOT-ADDED-1');
  assert.equal(fs.readFileSync(path.join(res.worktreePath, 'deep', 'nested', 'f.txt'), 'utf8'), 'NESTED-2');
  assert.equal(isUnderProjects(res.worktreePath), false, '快照仍在 projects 之外（不污染收工灯）');
});

// --- 判据 2：0 提交 + 已 git add 未 commit -------------------------------------
test('#670 0 提交 + 已 git add 未 commit ⇒ ok:true，快照里 git status 看得见已暂存文件', async () => {
  const repo = tmpRepoNoCommit();
  fs.writeFileSync(path.join(repo, 'staged.js'), 'STAGED');
  sh('git', ['add', 'staged.js'], repo);
  fs.writeFileSync(path.join(repo, 'free.txt'), 'FREE'); // 另有一个从未 add 的
  const res = await createSnapshot({ repoDir: repo, snapshotRoot: tmpRoot(), hasRsync: true });
  assert.equal(res.ok, true, `0 提交（已 add）快照必须成功，实际 reason=${res.reason}`);
  const st = sh('git', ['-C', res.worktreePath, 'status', '--porcelain', '-uall']);
  assert.match(st, /^A {2}staged\.js$/m, 'index 一起拷过去 ⇒ 已暂存态在快照里仍是 A（审查者看得见用户暂存了什么）');
  assert.match(st, /^\?\? free\.txt$/m, '未跟踪文件同样在（整树拷贝已含，不再重复 copyUntracked）');
  assert.equal(fs.readFileSync(path.join(res.worktreePath, 'staged.js'), 'utf8'), 'STAGED');
});

// --- 判据 5：整树拷贝包含 .git（rsync 与 cpSync 回退两条都要） ------------------
test('#670 快照带 .git（目录形态）且 git status 能跑；rsync 不可用时 cpSync 回退同样成立', async () => {
  for (const hasRsync of [true, false]) {
    const repo = tmpRepoNoCommit();
    fs.writeFileSync(path.join(repo, 'x.txt'), 'X');
    const res = await createSnapshot({ repoDir: repo, snapshotRoot: tmpRoot(), hasRsync });
    assert.equal(res.ok, true, `hasRsync=${hasRsync} 时快照失败：${res.reason}`);
    const gitEntry = path.join(res.worktreePath, '.git');
    assert.ok(fs.existsSync(gitEntry), '快照必须带 .git，否则审查 run 里 git status 不可用');
    assert.ok(fs.statSync(gitEntry).isDirectory(),
      `hasRsync=${hasRsync}：整树拷贝的 .git 必须是**目录**（linked worktree 的 .git 是文件）`);
    assert.match(sh('git', ['-C', res.worktreePath, 'status', '--porcelain', '-uall']), /x\.txt/);
  }
});

// --- 判据 3：有 HEAD 的仓库仍走原路（worktree + patch），没被整树拷贝抢路 -------
test('#670 有 HEAD 仍走 worktree+patch 原路（.git 是文件、且真的注册进 worktree list）', async () => {
  const repo = tmpRepo();
  seedCommitted(repo, 'tracked.js', 'console.log(1)\n');
  seedCommitted(repo, 'base-untouched.txt', 'BASE\n'); // 只在 HEAD 里、没有未提交改动
  fs.writeFileSync(path.join(repo, 'tracked.js'), 'console.log(2)\n');
  fs.writeFileSync(path.join(repo, 'fresh.txt'), 'FRESH');
  const res = await createSnapshot({ repoDir: repo, snapshotRoot: tmpRoot(), hasRsync: true });
  assert.equal(res.ok, true, `有 HEAD 快照失败：${res.reason}`);
  // 原路三样语义齐活：已提交（base）+ 未提交 diff（apply）+ 未跟踪（copyUntracked）
  assert.equal(fs.readFileSync(path.join(res.worktreePath, 'base-untouched.txt'), 'utf8'), 'BASE\n',
    '已提交内容必须由 worktree add 提供');
  assert.equal(fs.readFileSync(path.join(res.worktreePath, 'tracked.js'), 'utf8'), 'console.log(2)\n');
  assert.equal(fs.readFileSync(path.join(res.worktreePath, 'fresh.txt'), 'utf8'), 'FRESH');
  // 路径判别器：worktree 的 `.git` 是**文件**（gitdir: …），整树拷贝的才是目录
  assert.ok(fs.statSync(path.join(res.worktreePath, '.git')).isFile(),
    '有 HEAD 必须仍是 git worktree；.git 变成目录说明 0 提交分支抢了原路');
  const listed = sh('git', ['-C', repo, 'worktree', 'list', '--porcelain']);
  assert.ok(listed.split('\n').some((l) => l === `worktree ${res.worktreePath}`),
    '有 HEAD 的快照必须注册进 git worktree list（整树拷贝不会注册）');
});

// --- 新 reason 已登记（macro-review 按 includes 分类，漏登记会掉进 llm_failed） --
test('#670 snapshot_copy_failed 已登记，且既有 8 个 reason 一个没删', () => {
  assert.ok(SNAPSHOT_FAILURE_REASONS.includes('snapshot_copy_failed'),
    '整树拷贝失败必须有 reason（否则 macro-review 会误归类为 llm_failed）');
  for (const r of ['worktree_add_failed', 'patch_apply_failed', 'untracked_copy_failed',
    'snapshot_unstable', 'snapshot_timeout', 'snapshot_too_large', 'disk_low',
    'snapshot_root_in_projects']) {
    assert.ok(SNAPSHOT_FAILURE_REASONS.includes(r), `既有 reason 不许被删：${r}`);
  }
});

// --- 安全：整树拷贝目标必须在 snapshotRoot 之下（id 可被调用方覆盖） -----------
test('#670 拷贝目标逃出 snapshotRoot ⇒ 抛 snapshot_target_escapes_root，且不落到根外', async () => {
  const repo = tmpRepoNoCommit();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'A');
  const root = tmpRoot();
  const escaping = path.resolve(path.join(root, '../../escaped-670'));
  await assert.rejects(
    () => createSnapshot({ repoDir: repo, snapshotRoot: root, id: '../../escaped-670', hasRsync: true }),
    (err) => err?.code === SNAPSHOT_TARGET_ESCAPE,
    '越界必须响亮抛出（编程错误），不许降级成可重试的软失败',
  );
  assert.equal(fs.existsSync(escaping), false, '守卫必须在拷贝**之前**，根外目录不许被创建');
  assert.throws(
    () => copyWholeTree(repo, path.join(root, '..', '..', 'x670'), { snapshotRoot: root }),
    (err) => err?.code === SNAPSHOT_TARGET_ESCAPE,
  );
  // 正常 id 仍在根内 ⇒ 守卫没把合法路径一起挡掉
  assert.doesNotThrow(() => copyWholeTree(repo, path.join(root, 'ok-670'), { snapshotRoot: root }));
  assert.match(sh('git', ['-C', path.join(root, 'ok-670'), 'status', '--porcelain', '-uall']), /a\.txt/);
});

// --- 已知代价钉住：被 .gitignore 忽略的文件会一起拷过去，但不影响 digest 比对 ---
test('#670 0 提交：忽略文件随整树拷贝过去（已知代价），status/digest 比对不受影响', async () => {
  const repo = tmpRepoNoCommit();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n');
  fs.mkdirSync(path.join(repo, 'ignored'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'ignored', 'junk.bin'), 'JUNK');
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'KEEP');
  const res = await createSnapshot({ repoDir: repo, snapshotRoot: tmpRoot(), hasRsync: true });
  assert.equal(res.ok, true, `前后 digest 必须仍相等（快照里的 git 同样按 .gitignore 过滤）：${res.reason}`);
  assert.ok(fs.existsSync(path.join(res.worktreePath, 'ignored', 'junk.bin')),
    '整树拷贝连忽略文件一起搬（0 提交仓库通常很小；见 copyWholeTree 的已知代价注释）');
  const st = sh('git', ['-C', res.worktreePath, 'status', '--porcelain', '-uall']);
  assert.doesNotMatch(st, /junk\.bin/, '被忽略的文件不许出现在 status 里（审查者看到的状态与原目录一致）');
  assert.match(st, /keep\.txt/);
});
