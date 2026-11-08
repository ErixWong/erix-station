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

/** 造一棵最小 /proc fixture。ports: [{port, inode, pid?, owner=true, uid?=1000, addr?='00000000'}] */
function makeProc(t, { entries, home = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-fix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'net'));
  fs.writeFileSync(path.join(root, 'stat'), `cpu  1 2 3\nbtime ${BTIME}\n`);

  const lines = { tcp: ['  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'], tcp6: ['  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'] };
  for (const e of entries) {
    const hex = e.port.toString(16).toUpperCase().padStart(4, '0');
    // 其余列全填占位，字段位次与真 /proc/net/tcp 一致（inode 是第 10 列）。
    // local_address 的**地址段**可注入（#468 D5：Docker 内嵌 DNS 的判据就在这一段），family 默认 v4。
    const addr = e.addr ?? '00000000';
    const uid = e.uid ?? 1000;
    lines[e.family === 'tcp6' ? 'tcp6' : 'tcp'].push(`   0: ${addr}:${hex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${String(uid).padStart(5)}        0   ${e.inode} 1 0000 100 0 0 10 0`);
  }
  fs.writeFileSync(path.join(root, 'net', 'tcp'), lines.tcp.join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'net', 'tcp6'), lines.tcp6.join('\n') + '\n');

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
  // ⚠ fixture 的 socket owner uid **必须 ≠ 跑测试者自己的 uid**：`lib/listeners.js` 的 `ownerKeys` 故意把
  // `u !== selfUid` 那一组过滤掉（扫自己的身份不必切，且省一次切进/切出）。写死 1000 的后果：在 uid=1000
  // 的开发机上「切过去」这一步根本不会发生 ⇒ 本用例必然红，而 uid≠1000 的主机与 CI runner 绿——即「只有
  // 部分机器能跑」的形状（红了不是产品回归，绿了也不代表在 uid=1000 的生产容器里验过切换）。
  const OTHER_UID = (process.getuid?.() ?? 0) === 1000 ? 1001 : 1000;
  const { root, homeDir } = makeProc(t, {
    entries: [{ port: 22000, inode: 111, pid: 412, uid: OTHER_UID, cwd: 'projects/x', cmd: 'node a' }],
  });
  const seen = [];
  collectListeners({
    procPath: root, home: homeDir,
    setuid: (uid) => { seen.push(uid); },
  });
  assert.ok(seen.includes(OTHER_UID), '以 owner uid（≠ 自身 uid）扫过');
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

// ---------------------------------------------------------------------------
// #468 D5：Docker 内嵌 DNS（127.0.0.11）不是用户的服务 ⇒ 采样侧就不收它。
// 现网取证：4 台 FDE 各有一条 cwd IS NULL 的观测（eric 39677 / tetris 37765 / todo 41251 / blind 40097），
// 在容器内逐条核对 /proc/net/tcp 第 2 列全是 `0B00007F:<port>`（uid 0，Yama 下 cwd 永远读不到）。
// 后端 #468 D4 放宽「池外行合成」判据后，这条会变成每台 FDE 一条永久的「未知项目」噪音 ⇒ 必须挡在这里。
// ---------------------------------------------------------------------------
test('#468 D5 R1：127.0.0.11（/proc/net/tcp 地址段 0B00007F）的 LISTEN 不进采样结果', (t) => {
  const { root, homeDir } = makeProc(t, {
    entries: [
      { port: 22000, inode: 111, pid: 412, cwd: 'projects/shop', cmd: 'node vite.js' },
      { port: 39677, inode: 900, uid: 0, addr: '0B00007F' },  // Docker 内嵌 DNS（现网实测端口形状）
    ],
  });
  const out = collectListeners({ procPath: root, home: homeDir, setuid: NOOP_SETUID });
  assert.deepEqual(out.map((e) => e.port), [22000], 'docker DNS 端口不出现在结果里（连「端口在听」都不报）');
  assert.ok(!out.some((e) => e.port === 39677), '不许留下一条 cwd=null 的噪音条目');
});

test('#468 D5 R2：排除只针对 docker DNS，不是「排除 loopback」——0.0.0.0 与 127.0.0.1 上的服务照采', (t) => {
  const { root, homeDir } = makeProc(t, {
    entries: [
      { port: 22000, inode: 111, pid: 412, cwd: 'projects/shop', cmd: 'node vite.js', addr: '00000000' },
      { port: 5173, inode: 222, pid: 413, cwd: 'projects/vite', cmd: 'node vite', addr: '0100007F' }, // 127.0.0.1
      { port: 39677, inode: 900, uid: 0, addr: '0B00007F' },                                          // 127.0.0.11
      // v6 表里同样带 0B00007F 尾段（v4-mapped 形）的行**不得**被误排除：判据只对 net/tcp 生效。
      { port: 8080, inode: 333, pid: 414, cwd: 'projects/api', cmd: 'uvicorn', family: 'tcp6', addr: '0000000000000000FFFF00000B00007F' },
    ],
  });
  const out = collectListeners({ procPath: root, home: homeDir, setuid: NOOP_SETUID });
  assert.deepEqual(out.map((e) => e.port), [5173, 8080, 22000], 'v4 loopback、v6 行都仍在（只是 docker DNS 被摘掉）');
  assert.equal(out.find((e) => e.port === 5173).cwd, '~/projects/vite', 'loopback 服务的细节也照常富化');
});
