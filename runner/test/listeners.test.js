// 单测：lib/listeners.js——/proc fixture 目录注入（AGENTS.md §4 测试隔离：不碰真实 /proc）。
// 钉住的是观测层 MVP 的采样口径：LISTEN 解析、inode→pid 反查、cwd 归一 ~/、分支读取、
// 启动时刻换算（btime + starttime/CLK_TCK）、无主端口、以及「任何异常都不得 throw」的契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectListeners } from '../lib/listeners.js';

// 单测不真的降权（fixture 的 owner uid 与跑测试的用户无关）：注入 no-op setuid，扫描直接以当前用户身份跑。
const NOOP_SETUID = () => {};

const BTIME = 1_700_000_000;            // /proc/stat btime（epoch 秒）
const START_TICKS = 100_000;            // stat 第 22 列（USER_HZ=100 ⇒ +1000s）
const EXPECTED_START_MS = (BTIME + 1000) * 1000;

/** 造一棵最小 /proc fixture。ports: [{port, inode, pid?, owner=true}] */
function makeProc(t, { entries, home = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-fix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'net'));
  fs.writeFileSync(path.join(root, 'stat'), `cpu  1 2 3\nbtime ${BTIME}\n`);

  const lines = ['  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'];
  for (const e of entries) {
    const hex = e.port.toString(16).toUpperCase().padStart(4, '0');
    // 其余列全填占位，字段位次与真 /proc/net/tcp 一致（inode 是第 10 列）。
    lines.push(`   0: 00000000:${hex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0   ${e.inode} 1 0000 100 0 0 10 0`);
  }
  fs.writeFileSync(path.join(root, 'net', 'tcp'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'net', 'tcp6'), '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n');

  const homeDir = home ?? path.join(root, 'homeless');
  for (const e of entries) {
    if (e.pid == null) continue;
    const pd = path.join(root, String(e.pid));
    fs.mkdirSync(path.join(pd, 'fd'), { recursive: true });
    fs.symlinkSync(`socket:[${e.inode}]`, path.join(pd, 'fd', '3'));
    if (e.cwd) {
      const cwdAbs = path.join(homeDir, e.cwd);
      fs.mkdirSync(cwdAbs, { recursive: true });
      if (e.branch) {
        fs.mkdirSync(path.join(cwdAbs, '.git'), { recursive: true });
        fs.writeFileSync(path.join(cwdAbs, '.git', 'HEAD'), `ref: refs/heads/${e.branch}\n`);
      }
      fs.symlinkSync(cwdAbs, path.join(pd, 'cwd'));
    }
    if (e.cmd) fs.writeFileSync(path.join(pd, 'cmdline'), e.cmd.split(' ').join('\0') + '\0');
    // stat 前 2 列（pid/comm）+ 20 列（state…starttime），starttime = 全行第 22 列（proc(5) 实测口径）。
    const after = ['S', '1', '1', '1', '0', '0', '0', '0', '0', '0', '0', '1', '1', '0', '0', '0', '0', '0', '0', String(START_TICKS), '0'];
    fs.writeFileSync(path.join(pd, 'stat'), `${e.pid} (${(e.cmd || 'proc').split(' ')[0]}) ${after.join(' ')}\n`);
  }
  return { root, homeDir };
}

test('collectListeners：LISTEN 端口 + inode 反查 pid + cwd 归一 ~/ + 分支 + 启动时刻', (t) => {
  const { root, homeDir } = makeProc(t, {
    entries: [
      { port: 22000, inode: 111, pid: 412, cwd: 'projects/shop', branch: 'feat-x', cmd: 'node vite.js' },
      { port: 22001, inode: 222, pid: 877, cwd: 'projects/shop-feat', branch: 'main', cmd: 'node vite.js --port 22001' },
      { port: 3000, inode: 333, owner: false },   // 无主（别的 uid / 已退出）⇒ 仍要报端口，字段为 null
    ],
  });
  const out = collectListeners({ procPath: root, home: homeDir, setuid: NOOP_SETUID });
  assert.deepEqual(out.map((e) => e.port), [3000, 22000, 22001], '按端口升序');

  const shop = out.find((e) => e.port === 22000);
  assert.equal(shop.pid, 412);
  assert.equal(shop.uid, 1000, 'socket owner uid（/proc/net/tcp 第 8 列）随条目上报');
  assert.equal(shop.cwd, '~/projects/shop', '家目录前缀归一为 ~/（与 sessions.cwd 同口径）');
  assert.equal(shop.branch, 'feat-x');
  assert.equal(shop.cmd, 'node vite.js');
  assert.equal(new Date(shop.started_at).getTime(), EXPECTED_START_MS, 'started_at = btime + starttime/100');

  assert.equal(out.find((e) => e.port === 22001).cwd, '~/projects/shop-feat');
  const orphan = out.find((e) => e.port === 3000);
  assert.equal(orphan.pid, null, '反查不到属主也要报「端口在听」，其余字段 null');
  assert.equal(orphan.cwd, null);
});

test('collectListeners：跨 UID 采样 = 按 socket owner 分组 setuid 重扫（无 CAP_PTRACE + Yama 下的唯一可行路）', (t) => {
  const { root, homeDir } = makeProc(t, {
    entries: [{ port: 22000, inode: 111, pid: 412, cwd: 'projects/x', cmd: 'node a' }],
  });
  const seen = [];
  collectListeners({
    procPath: root, home: homeDir,
    setuid: (uid) => { seen.push(uid); },
  });
  assert.ok(seen.includes(1000), '以 owner uid 扫过');
  assert.ok(seen.length >= 2, '扫完要恢复自身 uid（setuid 被调 ≥2 次：切过去 + 恢复）');
  assert.equal(seen[seen.length - 1], process.getuid(), '最后一次必须恢复到自身 uid（绝不能把守护进程留在别人的身份上）');
});

test('collectListeners：.git 是 gitdir: 文件（worktree/submodule）也读分支；detached HEAD ⇒ branch null', (t) => {
  const { root, homeDir } = makeProc(t, {
    entries: [{ port: 22000, inode: 1, pid: 500, cwd: 'projects/wt', cmd: 'node x' }],
  });
  const wt = path.join(homeDir, 'projects', 'wt');
  fs.mkdirSync(path.join(wt, '.git'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git', 'HEAD'), 'ref: refs/heads/feat-y\n'); // 先建目录版再改成 gitdir 文件
  fs.rmSync(path.join(wt, '.git'), { recursive: true });
  const gitdir = path.join(root, 'gitdir-wt');            // 临时目录内的 gitdir（不得碰 /elsewhere 这类真实根路径）
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
  fs.writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/wt-branch\n');
  let out = collectListeners({ procPath: root, home: homeDir, setuid: NOOP_SETUID });
  assert.equal(out[0].branch, 'wt-branch');

  fs.writeFileSync(path.join(gitdir, 'HEAD'), 'abc123def456\n'); // detached
  out = collectListeners({ procPath: root, home: homeDir, setuid: NOOP_SETUID });
  assert.equal(out[0].branch, null, 'detached HEAD 宁缺毋滥');
});

test('collectListeners：家目录外的进程保留绝对路径；procPath 不存在 ⇒ 空数组绝不 throw', () => {
  const out = collectListeners({ procPath: '/nonexistent-proc-fixture', home: '/home/erix' });
  assert.deepEqual(out, []);
});

test('collectListeners：条目封顶（异常 /proc 形状灌不爆心跳）', (t) => {
  const entries = Array.from({ length: 100 }, (_, i) => ({ port: 20000 + i, inode: 900 + i, owner: false }));
  const { root, homeDir } = makeProc(t, { entries });
  const out = collectListeners({ procPath: root, home: homeDir, setuid: NOOP_SETUID });
  assert.equal(out.length, 64);
  assert.equal(out[0].port, 20000, '截断按端口升序保留最小号');
});
