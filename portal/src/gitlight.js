// issue #359 P0a：目录 git「收工灯」判定（决策见 AGENTS.md §7 D9，规格与实测记录见 issue #359）。
//
// 语义（D9）：灯 = **收工进度**，判据一句话「每天忙完之后要保证它是绿的」。
//   🔴 未落地：有东西没进基线（已跟踪被改 ∪ 未跟踪文件 ∪ 0 提交但有内容）
//   🟡 未推送：干净，但提交还留在这台机器里（有提交未推 / 没有远端 / 没有 upstream / 从未 fetch / detached）
//   🟢 已收工：干净且 HEAD 与远端跟踪 ref 一致
//   ⚪ 未检查：无仓库 / `.git` 读不动 / `index.lock` 正忙 / 判定未完成（超时、预算耗尽、无 git 二进制）
// **⚪ 不得渲染成绿**（绿是承诺）⇒ 聚合里灰压绿，且 `partial` 直接落灰。这条是本模块的硬口径，别"优化"掉。
//
// 通道：与 `/api/dirs`、`/api/files/tree` 同一条宿主 bind mount 直读（`<userSpaceRoot>/<fde>/projects/<name>`），
// 零容器参与。**对 git 目录零写**：`status` 带 `--no-optional-locks`（不写 `index.lock`，不能反过来挡住
// 正在干活的 agent），其余全是 `fs` 只读。测试钉这条（跑完断言没新增 index.lock）。
//
// 三条判据的代价各不相同（#359 §2）：
//   未提交 + 未跟踪 = 一条 `git status --porcelain -uall`（一次 spawn 同时给两位。**不用 `-uno`**：实测它让
//     0 提交的根仓库对三个脏子仓库报空输出 rc=0、自认干净 ⇒ 直接撒谎，会把最危险的那一位抹掉）；
//   未推送 = 纯文本读 HEAD / refs / packed-refs / config（零子进程）；
//   0 提交 = 纯文本（HEAD 指向的 ref 解析不出来）。
// 成本上界三道：仓库数封顶 + 扫描预算（时间/目录数）+ status 超时与 stdout 流式早停（数到条数上限即 kill）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CWD_RE, validateSessionCwd } from './sessions.js';
import { DirError } from './dirs.js';

// ---- 预算与上限（口径来自 #359 §2.1 / §2.4）----
/** 参与聚合的仓库数上限；超出不判色、计入 `truncated_repos`（保守：不猜）。 */
export const GIT_LIGHT_MAX_REPOS = 20;
/** 目录发现预算：先到先停。耗尽 ⇒ `partial`（绝不因"没扫完"而显绿）。 */
export const GIT_LIGHT_SCAN_BUDGET_MS = 300;
export const GIT_LIGHT_SCAN_MAX_DIRS = 1500;
/** 一次请求的总预算（仓库多时逐个 2s 会把请求拖到几十秒，总预算是闸）。 */
export const GIT_LIGHT_TOTAL_BUDGET_MS = 6000;
/** 单条 status 的超时与流式早停条数（脏的时候只想知道"有没有 + 前几个"）。 */
export const GIT_STATUS_TIMEOUT_MS = 2000;
export const GIT_STATUS_MAX_ENTRIES = 50;
/** 名单与 `runner/lib/artifacts.js:32 EXCLUDE_DIRS` 同步（跨包不可 import，测试钉同步）。 */
export const SCAN_EXCLUDE_DIRS = new Set(['.git', 'node_modules', '.notes']);
/** 聚合排序键的唯一来源：问题优先，非字典序（前端展开态与聚合共用，不各写一份）。 */
export const LIGHT_ORDER = ['red', 'yellow', 'grey', 'green'];
/** 根目录没有 `.git` 时向上探「被上层仓库覆盖」的层数上限。 */
const OUTER_PROBE_MAX_HOPS = 4;
/** 「判定未完成」的原因集合——这些一律压绿（绿是承诺）。 */
const UNCHECKED_REASONS = new Set(['unchecked_partial', 'unchecked_failed', 'git_unavailable', 'busy', 'unreadable']);

const SHA_RE = /^[0-9a-f]{40}$/;

function isSafeName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..'
    && !name.includes('/') && !/[\x00-\x1f\x7f]/.test(name);
}

function readOrNull(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/**
 * `.git` 解析：目录 ⇒ 自身；文件 ⇒ `gitdir:`（相对路径以仓库目录为基准，worktree/submodule 常见）。
 * symlink 不跟随（与 `dirs.js` 逐段拒 symlink 同口径）。
 * ⚠ linked worktree 的 `refs/` 与 `packed-refs`、`config` 都在 **common dir**，per-worktree 目录只有
 * HEAD/index 等——所以必须再读一层 `commondir`。`runner/lib/listeners.js:112-126` 只解到 `gitdir`
 * 这一层、没做这一步，照抄它会把 worktree 误判成「从未同步」。
 */
function resolveGitDirs(repoAbs) {
  const dotGit = path.join(repoAbs, '.git');
  let st;
  try { st = fs.lstatSync(dotGit); } catch { return null; }
  if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) return null;
  if (st.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
  const m = /^gitdir:\s*(\S+)/m.exec(readOrNull(dotGit) ?? '');
  if (!m) return null;
  const dir = path.isAbsolute(m[1]) ? m[1] : path.resolve(repoAbs, m[1]);
  const commonRel = readOrNull(path.join(dir, 'commondir'));
  const commonDir = commonRel?.trim() ? path.resolve(dir, commonRel.trim()) : dir;
  return { gitDir: dir, commonDir };
}

/** 纯文本取 ref → sha：松散 ref 文件优先，回退 `packed-refs`（**只看 `refs/` 目录必误判**）。 */
function readRefSha(commonDir, ref, depth = 0) {
  if (!ref || !ref.startsWith('refs/') || depth > 3) return null;
  const loose = readOrNull(path.join(commonDir, ...ref.split('/')));
  if (loose !== null) {
    const v = loose.trim();
    if (SHA_RE.test(v)) return v;
    const sym = /^ref:\s*(refs\/.+)$/m.exec(v); // symbolic ref（如 HEAD → refs/heads/main）
    return sym ? readRefSha(commonDir, sym[1].trim(), depth + 1) : null;
  }
  const packed = readOrNull(path.join(commonDir, 'packed-refs'));
  if (packed === null) return null;
  for (const line of packed.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('^')) continue;
    const [sha, name] = t.split(/\s+/);
    if (name === ref && SHA_RE.test(sha ?? '')) return sha;
  }
  return null;
}

/**
 * `config` 的最小 INI 读取：只取「当前分支的 upstream」与「有没有远端」两件事。
 * ⚠ **绝不把 config 原文或 remote URL 透传前端**（URL 可能内嵌 `user:token@`，#359 §4.2）。
 * @returns {{remote:?string, merge:?string, hasAnyRemote:boolean}}
 */
function readBranchConfig(commonDir, branch) {
  const text = readOrNull(path.join(commonDir, 'config'));
  const out = { remote: null, merge: null, hasAnyRemote: false };
  if (text === null) return out;
  let kind = ''; // '' | 'remote' | 'branch-other' | 'branch-target'
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(\w+)(?:\s+"([^"]*)")?\]$/.exec(line);
    if (sec) {
      const [, name, arg] = sec;
      if (name === 'remote') { kind = 'remote'; out.hasAnyRemote = true; continue; }
      if (name === 'branch') { kind = arg && arg === branch ? 'branch-target' : 'branch-other'; continue; }
      kind = name;
      continue;
    }
    if (kind !== 'branch-target') continue;
    const kv = /^(\w+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    if (kv[1] === 'remote') out.remote = kv[2].trim();
    else if (kv[1] === 'merge') out.merge = kv[2].trim();
  }
  return out;
}

/**
 * 一次 `git status`（一条命令同时给「未提交」与「未跟踪」，另送「嵌套仓库边界」= 尾斜杠条目）。
 * 超时/失败/无 git 一律如实上报（`ok:false` + 原因），上层据此落 ⚪，**不得落红或绿**。
 */
function runGitStatus(repoAbs, { gitBin, timeoutMs, maxEntries }) {
  return new Promise((resolve) => {
    const state = { ok: false, available: true, reason: null, tracked: [], untracked: [], nested: [], truncated: false };
    let child;
    try {
      // ⚠ `--no-optional-locks` 是 **git 级**选项，必须放在子命令**之前**（写成 `status --no-optional-locks`
      // 会 `unknown option` 直接退出 ⇒ 全部仓库变成「未检查」灰灯。单测「跑完不得新增 index.lock」钉它存在，
      // 位置靠这条注释 + 上面的实测报错过。
      child = spawn(gitBin, ['-c', 'safe.directory=*', '--no-optional-locks', '-C', repoAbs, 'status', '--porcelain', '-uall'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ...state, available: false, reason: err?.code === 'ENOENT' ? 'git_unavailable' : 'unchecked_failed' });
      return;
    }
    let buf = '';
    let settled = false;
    const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(state); } };
    const timer = setTimeout(() => {
      state.reason = 'unchecked_partial';
      state.truncated = true;
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      finish();
    }, Math.max(1, timeoutMs));
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line) pushEntry(state, line);
        if (state.tracked.length + state.untracked.length + state.nested.length >= maxEntries) {
          state.truncated = true;
          try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
          finish();
          return;
        }
      }
    });
    child.on('error', (err) => {
      state.available = err?.code !== 'ENOENT';
      state.reason = err?.code === 'ENOENT' ? 'git_unavailable' : 'unchecked_failed';
      finish();
    });
    child.on('close', (code) => {
      if (code !== 0) { state.reason = 'unchecked_failed'; finish(); return; }
      const tail = buf.trim();
      if (tail) pushEntry(state, tail); // 无换行尾的残段也要计入，否则最后一行被吞
      state.ok = true;
      finish();
    });
  });
}

/** porcelain 行归类。`?? path/`（尾斜杠）= git 拒绝进入的目录 = 嵌套仓库边界（#359 §2.1 实测）。 */
function pushEntry(state, line) {
  if (!line.startsWith('?? ')) { state.tracked.push(line); return; }
  const p = line.slice(3);
  if (p.endsWith('/')) state.nested.push(p.slice(0, -1));
  else state.untracked.push(p);
}

/** 目录是否"有内容"：0 提交时用来区分「空仓库」与「有东西完全没落地」。点开头目录与排除名单不算。 */
function dirHasContent(repoAbs) {
  let entries;
  try { entries = fs.readdirSync(repoAbs, { withFileTypes: true }); } catch { return false; }
  return entries.some((e) => !SCAN_EXCLUDE_DIRS.has(e.name) && !e.name.startsWith('.') && isSafeName(e.name));
}

/** 单仓库判定：返回 `{rel, light, reason, ...}`。「读不动」与「判定未完成」一律灰。 */
async function inspectRepo({ rel, abs, remainingMs, gitBin, now }) {
  const repo = {
    rel, branch: null, no_commits: false, detached: false, shell: false,
    tracked_count: 0, untracked_count: 0, truncated: false, push_state: 'unknown',
    light: 'grey', reason: 'unreadable',
  };
  const dirs = resolveGitDirs(abs);
  if (!dirs) return repo;
  if (fs.existsSync(path.join(dirs.gitDir, 'index.lock'))) { repo.reason = 'busy'; return repo; }

  // HEAD → 分支 / detached / 0 提交（全纯文本）
  const head = (readOrNull(path.join(dirs.gitDir, 'HEAD')) ?? '').trim();
  const refM = /^ref:\s*(refs\/\S+)$/.exec(head);
  let headSha = null;
  if (refM) {
    repo.branch = refM[1].replace(/^refs\/heads\//, '');
    headSha = readRefSha(dirs.commonDir, refM[1]);
    if (headSha === null) repo.no_commits = true;
  } else if (SHA_RE.test(head)) {
    repo.detached = true;
    headSha = head;
  } else {
    return repo; // HEAD 读不动/形态不认识 ⇒ 灰，不猜
  }

  if (remainingMs <= 0) { repo.reason = 'unchecked_partial'; return repo; }
  const st = await runGitStatus(abs, {
    gitBin,
    timeoutMs: Math.min(GIT_STATUS_TIMEOUT_MS, remainingMs),
    maxEntries: GIT_STATUS_MAX_ENTRIES,
  });
  if (!st.ok) { repo.reason = st.reason ?? 'unchecked_failed'; return repo; }
  repo.tracked_count = st.tracked.length;
  repo.untracked_count = st.untracked.length;
  repo.truncated = st.truncated;

  if (repo.no_commits) {
    // 空壳根仓库（#359 §4.0/§4.3）：0 提交 + 无已跟踪改动 + 里面看得见的东西**全是别的仓库**
    // ⇒ 它没资格拉高灯色（恒为红会把一切染红），只在展开态出那一行解释。
    if (st.tracked.length === 0 && st.untracked.length === 0 && st.nested.length > 0) {
      repo.shell = true;
      repo.reason = 'shell';
      return repo;
    }
    if (dirHasContent(abs)) { repo.light = 'red'; repo.reason = 'no_commits'; return repo; }
    repo.reason = 'empty';
    return repo;
  }
  if (repo.tracked_count > 0) { repo.light = 'red'; repo.reason = 'uncommitted'; return repo; }
  // 未跟踪与未提交同罪（都是零兜底）。
  if (repo.untracked_count > 0) { repo.light = 'red'; repo.reason = 'untracked'; return repo; }
  // 早停/截断：一条都没读到但被剔了 ⇒ 不知道全貌 ⇒ 灰（“有东西”已上面红掉了，这里只会是“没判完”）。
  if (repo.truncated) { repo.reason = 'unchecked_partial'; return repo; }

  // 未推送：纯文本四步（#359 §2.2）
  if (repo.detached) { repo.push_state = 'detached'; repo.light = 'yellow'; repo.reason = 'detached'; return repo; }
  const cfg = readBranchConfig(dirs.commonDir, repo.branch);
  if (!cfg.remote || !cfg.merge) {
    repo.push_state = cfg.hasAnyRemote ? 'no_upstream' : 'no_remote';
    repo.light = 'yellow';
    repo.reason = repo.push_state;
    return repo;
  }
  // upstream 映射按 git 语义：`merge = refs/heads/<br>` 指的是**远端上的那条分支**，
  // 本地对应的远端跟踪 ref 是 `refs/remotes/<remote>/<br>`——直接拿 `refs/heads/<br>` 去比 = 拿 HEAD 跟
  // 自己比，未推送会误判绿（单测「有提交未推送」钉的就是这里）。
  const headBranch = /^refs\/heads\/(.+)$/.exec(cfg.merge);
  const upRef = headBranch ? `refs/remotes/${cfg.remote}/${headBranch[1]}` : cfg.merge;
  // 只比一个东西：本地 HEAD vs 远端跟踪 ref。**不能再回退到 cfg.merge**——它通常是 `refs/heads/main`
  // （本地分支）⇒ 拿 HEAD 跟自己比，永远“已同步”，未推送会误判绿（单测「有提交未推送」钉的就是这个）。
  const upSha = readRefSha(dirs.commonDir, upRef);
  if (upSha === null) { repo.push_state = 'never_fetched'; repo.light = 'yellow'; repo.reason = 'never_fetched'; return repo; }
  const synced = upSha === headSha;
  repo.push_state = synced ? 'synced' : 'unpushed_or_diverged';
  repo.light = synced ? 'green' : 'yellow';
  repo.reason = repo.push_state;
  return repo;
}

/**
 * 找仓库：预算式 BFS。**命中 `.git` 即为一个仓库且不再下钻**（唯一例外：有 `.gitmodules` 的仓库要再往里看——
 * 子模块是被声明的，不是野生的）。跳过 `SCAN_EXCLUDE_DIRS` 与 symlink。预算耗尽 ⇒ `partial`。
 * 为什么不是固定深度：固定 2 层会**无声无息**漏掉 `apps/svc-a`（深度 3）这类容器形状，用户看到的是绿；
 * 预算式 + `partial` 把"漏"变成"明说的漏"（#359 §4.2）。
 */
function discoverRepos(rootAbs, { budgetMs, maxDirs, now }) {
  const deadline = now() + budgetMs;
  const found = hasDotGit(rootAbs) ? [{ abs: rootAbs, rel: '' }] : [];
  const queue = [{ abs: rootAbs, rel: '' }];
  let visited = 1;
  let partial = false;
  while (queue.length > 0) {
    const { abs, rel } = queue.shift();
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    // 命中仓库的目录默认不下钻（里面是它的内部结构，不是平级仓库）；声明了子模块的例外。
    const descendInsideRepo = rel === '' || fs.existsSync(path.join(abs, '.gitmodules'));
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || !isSafeName(e.name)) continue;
      if (SCAN_EXCLUDE_DIRS.has(e.name)) continue;
      if (!descendInsideRepo && hasDotGit(abs)) continue;
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (hasDotGit(childAbs)) found.push({ abs: childAbs, rel: childRel });
      if (now() > deadline || visited >= maxDirs) { partial = true; break; }
      visited++;
      queue.push({ abs: childAbs, rel: childRel });
    }
  }
  return { repos: found, partial, visited };
}

function hasDotGit(abs) {
  try {
    const st = fs.lstatSync(path.join(abs, '.git'));
    return !st.isSymbolicLink() && (st.isDirectory() || st.isFile());
  } catch { return false; }
}

/** 根目录没有 `.git` 时向上探「被上层仓库覆盖」（#359 §4.1 的形状：界面上必须如实说，不给红/绿）。 */
function outerRepoCovered({ rootAbs, stopAt }) {
  let cur = path.dirname(rootAbs);
  for (let i = 0; i < OUTER_PROBE_MAX_HOPS; i++) {
    if (!cur.startsWith(stopAt) || cur === stopAt || cur === path.dirname(cur)) break;
    if (hasDotGit(cur)) return true;
    cur = path.dirname(cur);
  }
  return false;
}

/**
 * `GET /api/git-light?cwd=` → 一颗灯的完整判定（多仓库**取最差**，绿 = 所有仓库都干净且都已推送）。
 * @param {object} opts
 * @param {string} opts.userSpaceRoot 与 `dirs.js` 同一份配置（容器内视角的用户空间根）
 * @param {string} opts.fdeName 工位名（取自会话用户 ⇒ 作用域天然按工位隔离，不会扫全平台）
 * @param {string} opts.cwd `~/projects/<name>` 相对形式（与 `sessions.js#validateSessionCwd` 同校验）
 * @param {string} [opts.gitBin='git'] git 可执行文件（测试用假路径钉「无 git ⇒ 灰，不显绿」）
 * @param {() => number} [opts.now=Date.now]
 */
export async function getGitLight({ userSpaceRoot, fdeName, cwd, gitBin = 'git', now = Date.now } = {}) {
  if (!userSpaceRoot || !fdeName) throw new DirError('internal', 'userSpaceRoot/fde_name 缺失', { httpStatus: 500 });
  let safeCwd;
  try {
    safeCwd = validateSessionCwd(cwd);
  } catch (err) {
    if (err instanceof DirError) throw err;
    throw new DirError(err?.code ?? 'validation_failed', err?.message ?? 'cwd 非法', {
      httpStatus: err?.httpStatus ?? 400, details: err?.details,
    });
  }
  const name = CWD_RE.exec(safeCwd)[1];
  const root = path.resolve(userSpaceRoot, fdeName, 'projects', name);
  let rootSt;
  try {
    rootSt = fs.lstatSync(root);
  } catch (err) {
    if (err?.code === 'ENOENT') throw new DirError('not_found', 'directory not found', { httpStatus: 404 });
    throw err;
  }
  if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) throw new DirError('not_found', 'directory not found', { httpStatus: 404 });

  const startedAt = now();
  const { repos: found, partial } = discoverRepos(root, { budgetMs: GIT_LIGHT_SCAN_BUDGET_MS, maxDirs: GIT_LIGHT_SCAN_MAX_DIRS, now });

  if (found.length === 0) {
    const outer = outerRepoCovered({ rootAbs: root, stopAt: path.resolve(userSpaceRoot) });
    return {
      light: 'grey',
      reason: outer ? 'covered_by_outer_repo' : 'no_repo',
      primary: null,
      cwd: safeCwd,
      outer_repo: outer,
      repos: [],
      counts: { red: 0, yellow: 0, grey: 0, green: 0 },
      partial: false,
      git_available: true,
      truncated_repos: 0,
      checked_at: new Date(now()).toISOString(),
    };
  }

  const probed = found.slice(0, GIT_LIGHT_MAX_REPOS);
  const truncatedRepos = Math.max(0, found.length - probed.length);
  const repos = [];
  for (const r of probed) {
    const remainingMs = startedAt + GIT_LIGHT_TOTAL_BUDGET_MS - now();
    repos.push(await inspectRepo({ rel: r.rel, abs: r.abs, remainingMs, gitBin, now }));
  }

  const counts = { red: 0, yellow: 0, grey: 0, green: 0 };
  for (const r of repos) if (!r.shell) counts[r.light] += 1;
  const gitAvailable = !repos.some((r) => r.reason === 'git_unavailable');
  const unchecked = repos.some((r) => UNCHECKED_REASONS.has(r.reason));
  const notFullyScanned = partial || truncatedRepos > 0;

  let light = 'green';
  let primary = null;
  for (const want of LIGHT_ORDER) {
    const hit = repos.find((r) => !r.shell && r.light === want);
    if (hit) { light = want; primary = hit; break; }
  }
  let reason = primary?.reason ?? light;
  if (notFullyScanned) { light = 'grey'; primary = null; reason = 'unchecked_partial'; }
  else if (light === 'green' && unchecked) { light = 'grey'; primary = null; reason = 'unchecked_partial'; }

  return {
    light,
    reason,
    primary: primary ? { rel: primary.rel, repo: primary.rel === '' ? name : path.basename(primary.rel) } : null,
    cwd: safeCwd,
    outer_repo: false,
    repos: repos.map((r) => ({
      rel: r.rel,
      repo: r.rel === '' ? name : path.basename(r.rel),
      light: r.light,
      reason: r.reason,
      shell: r.shell,
      branch: r.branch,
      no_commits: r.no_commits,
      tracked_count: r.tracked_count,
      untracked_count: r.untracked_count,
      truncated: r.truncated,
      push_state: r.push_state,
    })),
    counts,
    // `partial` 的语义 = 「这不是一个完整结论」（扫描没走完 / 仓库数封顶 / 任一仓库没判完），
    // 具体差在哪由 `reason` 说；前端拿它当「不得显绿 + 得给 ↻」的总开关。
    partial: notFullyScanned || unchecked,
    git_available: gitAvailable,
    truncated_repos: truncatedRepos,
    checked_at: new Date(now()).toISOString(),
  };
}
