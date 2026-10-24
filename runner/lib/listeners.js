// 容器内真实监听采样（端口呈现优化·观测层 MVP；迁移 0022 port_observations）。
// 依据：agentd U4 heartbeat（runner-integration §4.2）捎带 `listeners`，portal 落 port_observations。
// 定位口径：**只读观测用于展示**——平台依旧不做容器侧端口管控/ reconcile（#246 不变式），
// 本模块不 kill、不限制、不判定对错，只回答「哪个端口上有没有进程、是哪个目录/分支/起了多久」。
//
// 数据来源全部是 /proc：
//   - <proc>/net/tcp{,6}  → LISTEN 端口 + socket inode + **socket owner uid**（第 8 列）；
//   - <proc>/<pid>/fd/*   → readlink "socket:[inode]" 反查属主进程；
//   - <proc>/<pid>/{cwd,cmdline,stat} → 目录 / 命令行摘要 / 启动时刻（stat 第 22 字段，CLK_TCK=100）；
//   - <cwd>/.git/HEAD（或 gitdir: 链接文件）→ 分支名（尽力而为，detached/非仓库 ⇒ null）。
//
// ⚠ **UID 现实（真机实证，fde-eric）**：FDE 容器不授 CAP_SYS_PTRACE（topology §6 禁 ptrace，有意设计），
// 且 Yama ptrace_scope=1 下 `socket fd / cwd 的 readlink 需要 ptrace_may_access(PTRACE_MODE_READ_FSCREDS)`
// ⇒ **只有 socket owner 本人（或同 euid）读得动**。agentd（uid 1001）对 1000/1002 的进程只能报
// 「端口在听」，拿不到进程细节。这不是 bug，是安全裁决的必然代价：
//   - agent spawn 的 dev server（worker uid 1002 的子进程，主路径）⇒ 细节完整；
//   - 用户经 docker exec（erix 1000）手起的进程 ⇒ 端口可见、细节缺（有 uid 可用）。
// 为此采样走两步：① root 面拿 inode→uid（/proc/net/tcp 任何人可读）；② **setuid 成每个 owner 重扫**
// （agentd 持有 CAP_SETUID），一次采齐所有相关 uid。worker(1002) 起的进程与 agent 同 uid，
// 正是 issue 现场的形状。
//
// 设计红线：
//   - **任何一步失败都不许 throw**——这是心跳的捎带数据，采样炸了只报空数组，绝不能拖死心跳链路；
//   - procPath/home 可注入（单测用 fixture 目录，不碰真实 /proc，AGENTS.md §4 测试隔离约定）；
//   - 条目数封顶（防 /proc 异常形状灌爆心跳体）。
import fs from 'node:fs';
import path from 'node:path';

const LISTEN_STATE = '0A';            // /proc/net/tcp 的 st 列（十六进制）：0A = TCP_LISTEN
const CLK_TCK = 100;                  // Linux USER_HZ；/proc/<pid>/stat 的 starttime 以此为单位
export const MAX_LISTENERS = 64;      // 心跳载荷封顶（超出按端口升序截断）
const CMD_MAX = 200;                  // cmdline 摘要截断长度
const CWD_MAX = 512;

function readOrNull(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
function readDirOrEmpty(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}
function readlinkOrNull(p) {
  try { return fs.readlinkSync(p); } catch { return null; }
}

/** <proc>/stat 的 btime（epoch 秒）；拿不到 ⇒ null（started_at 退化为 null，其余照常）。 */
function bootTimeSec(procPath) {
  const stat = readOrNull(path.join(procPath, 'stat'));
  if (!stat) return null;
  const m = /^btime\s+(\d+)/m.exec(stat);
  return m ? Number(m[1]) : null;
}

/**
 * 解析 net/tcp{,6} 的 LISTEN 行 → [{port, inode, uid}]。
 * uid（第 8 列）同时充当**跨 UID 可读性判据**：fd/cwd readlink 只有 owner 的 euid 读得动
 *（无 CAP_SYS_PTRACE + Yama 下），后续按 uid 分组 setuid 重扫。
 */
function listenSockets(procPath) {
  const out = [];
  for (const f of ['net/tcp', 'net/tcp6']) {
    const text = readOrNull(path.join(procPath, f));
    if (!text) continue;
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[3] !== LISTEN_STATE) continue;
      const portHex = (cols[1] || '').split(':')[1];
      const port = portHex ? parseInt(portHex, 16) : NaN;
      const inode = Number(cols[9]);
      const uid = Number(cols[7]);
      if (!Number.isFinite(port) || port <= 0 || !Number.isFinite(inode) || inode === 0) continue;
      out.push({ port, inode, uid: Number.isFinite(uid) ? uid : null });
    }
  }
  return out;
}

/** inode → pid 反查（以「当前 euid」执行——owner 本人时 readlink 才通）。 */
function inodeOwners(procPath, wantInodes) {
  const want = new Set(wantInodes.map((x) => x.inode));
  const owners = new Map();
  const pids = readDirOrEmpty(procPath)
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .sort((a, b) => a - b);
  for (const pid of pids) {
    const fdDir = path.join(procPath, String(pid), 'fd');
    for (const fd of readDirOrEmpty(fdDir)) {
      const link = readlinkOrNull(path.join(fdDir, fd));
      if (!link) continue;
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m && want.has(Number(m[1])) && !owners.has(Number(m[1]))) owners.set(Number(m[1]), pid);
    }
  }
  return owners;
}

/** /proc/<pid>/stat → 启动时刻（epoch ms）。comm 可能含空格/括号：从最后一个 ')' 之后继续切列。 */
function procStartedAtMs(procPath, pid, btimeSec) {
  if (btimeSec === null) return null;
  const stat = readOrNull(path.join(procPath, String(pid), 'stat'));
  if (!stat) return null;
  const closeIdx = stat.lastIndexOf(')');
  if (closeIdx === -1) return null;
  const fields = stat.slice(closeIdx + 1).trim().split(/\s+/);
  // stat 全行第 22 列 starttime；')' 之后从第 3 列起算 ⇒ 本地索引 22-3 = 19。
  const starttimeTicks = Number(fields[19]);
  if (!Number.isFinite(starttimeTicks)) return null;
  return Math.round(btimeSec * 1000 + (starttimeTicks / CLK_TCK) * 1000);
}

/** cwd 处的 git 分支（尽力而为）：.git 目录 → HEAD；.git 文件（worktree/submodule）→ gitdir: 目标。 */
function gitBranchOf(cwdAbs) {
  if (!cwdAbs) return null;
  let dotGit = path.join(cwdAbs, '.git');
  const asFile = readOrNull(dotGit);
  if (asFile !== null) {
    const m = /^gitdir:\s*(\S+)/m.exec(asFile);
    if (!m) return null;
    dotGit = path.isAbsolute(m[1]) ? m[1] : path.resolve(cwdAbs, m[1]);
  }
  const head = readOrNull(path.join(dotGit, 'HEAD'));
  if (!head) return null;
  const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
  if (ref) return ref[1].trim().slice(0, 128) || null;
  return null; // detached HEAD（裸 sha）：分支语义不成立，宁缺毋滥
}

function normalizeCwd(cwdAbs, home) {
  if (!cwdAbs) return null;
  if (home && (cwdAbs === home || cwdAbs.startsWith(home + '/'))) {
    return '~' + cwdAbs.slice(home.length).replace(/\/+$/, '');
  }
  return cwdAbs.slice(0, CWD_MAX);
}

/** 对「当前 euid 读得动」的这批 socket 做完整富化（owner 本人的视角）。 */
function enrich(procPath, sockets, owners, btime, home) {
  const out = [];
  // 同一端口多 inode（v4+v6）⇒ 按 port 归并；uid 取组内首个非空 owner。
  const byPort = new Map();
  for (const s of sockets) {
    if (!byPort.has(s.port)) byPort.set(s.port, { port: s.port, inodes: [], uid: null });
    const g = byPort.get(s.port);
    g.inodes.push(s.inode);
    if (g.uid === null && s.uid !== null) g.uid = s.uid;
  }
  for (const { port, inodes, uid } of byPort.values()) {
    let pid = null;
    for (const ino of inodes) {
      const found = owners.get(ino);
      if (found !== undefined) { pid = found; break; }
    }
    const entry = { port, pid: null, uid, cwd: null, cmd: null, branch: null, started_at: null };
    if (pid !== null) {
      entry.pid = pid;
      const cwdAbs = readlinkOrNull(path.join(procPath, String(pid), 'cwd'));
      entry.cwd = normalizeCwd(cwdAbs, home);
      const cmdline = readOrNull(path.join(procPath, String(pid), 'cmdline'));
      if (cmdline) {
        const cmd = cmdline.split('\0').filter(Boolean).join(' ');
        entry.cmd = (cmd || null)?.slice(0, CMD_MAX) ?? null;
      }
      entry.branch = gitBranchOf(cwdAbs);
      const startedMs = procStartedAtMs(procPath, pid, btime);
      entry.started_at = startedMs === null ? null : new Date(startedMs).toISOString();
    }
    out.push(entry);
  }
  return out;
}

/**
 * 采样一次。「绝不 throw」是契约：任何异常吞掉、返回已有部分（最差空数组）。
 *
 * ⚠ **setuid 窗口是同步的**：切 uid → 扫描 → 恢复全程无 await（Node 单线程 ⇒ 窗口内不会有其它 JS
 * 以临时身份跑）；libuv 线程池里在途的异步 fs 可能落进窗口，采样毫秒级、代价可忽略。
 * node 的 process.setuid(setresuid) 会把 saved uid 一并改掉——恢复自己靠的是 agentd 常驻的
 * ambient CAP_SETUID（entrypoint 授 setuid/setgid/kill，runner §11.3），真机已验证来回切换 OK。
 *
 * @param procPath   注入点（单测 fixture；生产 '/proc'）
 * @param home       容器用户家目录（~/projects/... 归一前缀；容器外进程保留绝对路径）
 * @param setuid     注入点：单测不降权（缺省 node:process.setuid，生产按 owner 切换）
 * @returns {{port,pid,uid,cwd,cmd,branch,started_at}[]} 按端口升序，封顶 maxEntries
 */
export function collectListeners({ procPath = '/proc', home = null, maxEntries = MAX_LISTENERS, setuid = null } = {}) {
  try {
    const sockets = listenSockets(procPath);
    if (sockets.length === 0) return [];
    const btime = bootTimeSec(procPath);
    const selfUid = (() => { try { return process.getuid(); } catch { return null; } })();
    // ⚠ **只能用原生 process.setuid，绝不能用返回 uid 的封装**：libuv 的 uv_setuid 在 setresuid 失败时
    // 会退化成 setuid()——非 root 下 saved uid 被踩成目标 uid，**再也切不回来**（真机实证：
    // 探针里 setuid(0) 成功降级成 root、随后 setuid(1000) EPERM）。原生 setuid(2) 是 setresuid(r,e,s)
    // 三写，ambient CAP_SETUID 下可往返（runner §11.3 / entrypoint 的 setuid/setgid/kill 正是这条能力）。
    const nativeSetuid = (() => {
      try { return globalThis.process.setuid.bind(globalThis.process); } catch { return null; }
    })();
    const applyUid = setuid ?? ((uid) => {
      if (!nativeSetuid) throw new Error('setuid unavailable');
      nativeSetuid(uid);
    });
    const restoreUid = () => { if (selfUid !== null) { try { applyUid(selfUid); } catch { /* 尽力恢复 */ } } };

    const merged = new Map(); // port → entry（先到先得；同端口跨 uid 罕见，v4/v6 已在 enrich 内归并）
    const byOwner = new Map(); // 读 fd 需要的身份：socket owner uid；-1 = 拿不到 uid 的兜底组（当前身份试一次）
    for (const s of sockets) {
      const key = s.uid === null ? -1 : s.uid;
      if (!byOwner.has(key)) byOwner.set(key, []);
      byOwner.get(key).push(s);
    }
    // 自己的 uid 排最后扫：扫完直接恢复，省一次无谓的切进/切出（且中途抛错也不会把自己留在别人身份上）。
    // ⚠ uid 0 只在自身就是 root 时才切：root→非 root 的 setuid 会把 permitted/effective 能力**清空**
    //   （无 KEEPCAPS），碰一次 root 就永久失去切回去的资本——真机实证：setuid(0) 后再切 1000 直接 EPERM。
    //   非 root 的 agentd 对 uid-0 socket 只报「端口在听 + owner=0」（容器内 root 监听本就不是 agent 的 dev server）。
    const canSwitch = selfUid !== null;
    const ownerKeys = [...byOwner.keys()].filter((u) => u >= 0 && u !== selfUid && (u !== 0 || selfUid === 0));
    ownerKeys.sort((a, b) => (a === selfUid ? 1 : 0) - (b === selfUid ? 1 : 0));
    if (selfUid === null) ownerKeys.push(-1); // 拿不到自身 uid（非 POSIX）⇒ 用当前身份全扫一次

    const minimal = (group, uidKey) => group.map((s) => ({
      port: s.port, pid: null, uid: uidKey < 0 ? null : uidKey, cwd: null, cmd: null, branch: null, started_at: null,
    }));

    // 切换链一旦断掉（恢复自身失败 ⇒ 后续 applyUid 全 EPERM）就不再切，余下组只报端口可见。
    let broken = false;
    for (const uidKey of ownerKeys) {
      const group = byOwner.get(uidKey) ?? [];
      let entries = [];
      try {
        if (broken) throw new Error('uid switch chain broken');
        if (uidKey >= 0 && uidKey !== selfUid) applyUid(uidKey);
        const owners = inodeOwners(procPath, group);
        entries = enrich(procPath, group, owners, btime, home);
      } catch {
        entries = minimal(group, uidKey);
      } finally {
        if (uidKey >= 0 && uidKey !== selfUid) {
          try { applyUid(selfUid); } catch { broken = true; }
        }
      }
      // 兜底：这组里仍没拿到 pid 的（身份不对/进程已退）⇒ 至少报「端口在听 + owner uid」。
      for (const e of entries) {
        if (!merged.has(e.port)) merged.set(e.port, e);
      }
    }
    // 未扫的组（uid-0 且自身非 root / 拿不到 uid 的 -1 组）：用当前身份扫一次不切 uid，
    // 读得动多少算多少（同 uid 进程读自己的 fd 永远没问题）。
    for (const [uidKey, group] of byOwner.entries()) {
      const skipped = !ownerKeys.includes(uidKey) || (uidKey === 0 && selfUid !== 0 && canSwitch);
      if (!skipped || group.every((s) => merged.has(s.port))) continue;
      try {
        for (const e of enrich(procPath, group, inodeOwners(procPath, group), btime, home)) {
          if (!merged.has(e.port)) merged.set(e.port, e);
        }
      } catch { /* 维持端口可见 */ }
    }

    const out = [...merged.values()].sort((a, b) => a.port - b.port);
    return out.slice(0, maxEntries);
  } catch {
    return [];
  }
}
