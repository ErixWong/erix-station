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
  computeContentFingerprint,
  createSnapshot,
  copyUntracked,
  isUnderProjects,
  shouldRemoveOrphan,
  parseWorktreeList,
  cleanOrphanWorktrees,
  makeMacroRunLookup,
  SNAPSHOT_FAILURE_REASONS,
  TERMINAL_MACRO_RUN_STATUSES,
  ORPHAN_AGE_MS,
} from '../src/macro-snapshot.js';
import {
  REVIEW_ONLY_TOOL_NAMES,
  filterReviewExecutors,
  filterReviewSchemas,
  isReviewOnly,
} from '../../runner/lib/review-tools.js';

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
