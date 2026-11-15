// issue #495（= #412 遗留 ①②）：e2e 起跑前预检 + 「等宿主侧物化文件」的失败分类。
//
// 为什么这组测试住在根 `npm test` 里，而不是只在 `portal/integration/isolation-negative.mjs`：
// 那两个坑的代价不是「测试红了」，而是**红得没有信息**——① 缺 `deploy/.env` 要烧完整轮镜像构建（实测
// 10.7 分钟）才报一句 `couldn't find env file`；② `fs.existsSync` 把 EACCES 吞成 false，于是「portal
// 已经写出 config.json」与「materializer 从没跑」共用同一句 `timeout waiting for ...`，#412 当年靠手工
// 把四个 uid/gid 指给自己才绕开。本文件把「失败必须分得开」钉成**行为面**判据（无 docker、纯夹具），
// 因此它能在任何机器上跑，也能在改动分类逻辑时当场变红。
//
// 真机 EACCES 形态（uid ≠ FDE_USER_UID）本机复现不了：eric 就是 uid 1000 = 目录属主，`chmod 0700`
// 对自己照样可读。所以「读不到」分支用注入的 fsImpl 复现（假 accessSync 抛 EACCES），并在交付报告里
// 另附一次 **docker 里以 uid 1001 真跑**的取证（同一棵树，真 EACCES，不是夹具）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPOSE_ENV_FILE, PORTAL_USERSPACE_CONTAINER_ROOT, assertComposeEnvFile, formatAncestorLinkLines,
  formatLastSegmentLinkLine, inspectHostPathChain, materializeSnapshot, observeHostPath, observeLastSegmentLink,
  observeSegmentLink, toContainerPath, waitForHostFile,
} from '../portal/integration/lib/e2e-preflight.mjs';
// PR #554 复审 BLOCKER（E1–E5）：隔离预检读的就是这份 env，解析口径漂了判据就在危险方向上恒真。
import { execFileSync } from 'node:child_process';
import {
  assertHostWritePathsIsolated, parseComposeEnvFile, parseComposeEnvLine,
} from '../portal/integration/lib/isolated-env.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 真实 EACCES 复现不了（属主就是自己）⇒ 用注入的 fsImpl 造 EACCES。 */
const EACCES = () => Object.assign(new Error('permission denied'), { code: 'EACCES' });
const noSleep = async () => {};

/** 一个临时的「userspace 子树」夹具：`<root>/<fde>/home/.erix/config.json`（权限照抄真机 0770/0644）。 */
function fixtureUserspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-495-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'alice', 'home', '.erix');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{"slots":{"default":{"apiKey":"erix-placeholder"}}}');
  fs.chmodSync(path.join(root, 'alice'), 0o770);
  fs.chmodSync(dir, 0o770);
  return { root, dir, file };
}

/** 捕获一次调用里的 stdout/stderr 写入（「成功时零输出」是 #495 ① 的验收判据，只能这么判）。 */
function captureOutput(fn) {
  const writes = [];
  const originals = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk, ...rest) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk, ...rest) => { writes.push(String(chunk)); return true; };
  let value;
  try {
    value = fn();
  } finally {
    process.stdout.write = originals.out;
    process.stderr.write = originals.err;
  }
  return { value, output: writes.join('') };
}

// ---------------------------------------------------------------------------
// ① assertComposeEnvFile
// ---------------------------------------------------------------------------

test('#495① P1 正例：env 文件在场 ⇒ 返回事实且**零输出**（反向自证判据）', (t) => {
  const { root } = fixtureUserspace(t);
  const envFile = path.join(root, 'deploy', '.env');
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, 'PORTAL_HOST_PORT=18080\n');
  const { value, output } = captureOutput(() => assertComposeEnvFile({ envFile, label: 'wpX' }));
  assert.equal(output, '', `预检成功不许打印任何东西（噪音会让「预检通过」看起来像失败原因）：${JSON.stringify(output)}`);
  assert.equal(value.file, envFile, '返回绝对路径');
  assert.equal(value.bytes, fs.statSync(envFile).size, '返回字节数（诊断用，不打印）');
});

test('#495① P2 负例：文件不存在 ⇒ 当场抛，并点名要复制哪个文件', (t) => {
  const { root } = fixtureUserspace(t);
  const missing = path.join(root, 'deploy', '.env');
  assert.throws(() => assertComposeEnvFile({ envFile: missing, label: 'wp3b-e2e' }), (error) => {
    const m = String(error.message);
    for (const needle of ['wp3b-e2e', missing, '不存在', '复制', COMPOSE_ENV_FILE, '.env.example']) {
      assert.ok(m.includes(needle), `文案缺少点名「${needle}」：${m}`);
    }
    assert.ok(/镜像构建|10\.7/.test(m), '文案要说清代价（为什么必须提前判）');
    return true;
  });
});

test('#495① P3 缺省判的就是 compose 命令串里那个相对路径（deploy/.env）', (t) => {
  const { root } = fixtureUserspace(t);
  fs.mkdirSync(path.join(root, 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(root, 'deploy', '.env'), 'A=1\n');
  // 只给 cwd ⇒ 必须解析到 <cwd>/deploy/.env（与 `--env-file deploy/.env` 同口径，判错路径 = 假绿）
  assert.equal(assertComposeEnvFile({ cwd: root, label: 'wpX' }).file, path.join(root, 'deploy', '.env'));
  assert.equal(COMPOSE_ENV_FILE, 'deploy/.env', '缺省值必须与 compose 命令串里写死的一致');
  assert.throws(() => assertComposeEnvFile({ cwd: path.join(root, 'alice', 'home'), label: 'wpX' }), /不存在/);
});

test('#495① P4 负例：不是普通文件 / 存在但读不到（两种都不能放过）', (t) => {
  const { root, file } = fixtureUserspace(t);
  assert.throws(() => assertComposeEnvFile({ envFile: path.dirname(file), label: 'wpX' }),
    /不是普通文件/, '目录不能当 env-file 用');
  // statSync 成功、accessSync(R_OK) 抛 ⇒ 「存在但读不到」（真机形态：cp 过来属主是别人）
  assert.throws(() => assertComposeEnvFile({
    envFile: 'deploy/.env', cwd: root, label: 'wpX',
    fsImpl: { statSync: () => ({ mode: 0o100600, uid: 0, gid: 0, size: 10, isFile: () => true }), accessSync: () => { throw EACCES(); } },
  }), (error) => {
    const m = String(error.message);
    assert.match(m, /读不到/, '必须点名「读不到」而不是「不存在」');
    assert.match(m, /mode=0o600 owner=0:0/, '权限与属主要写进文案（这是能一眼定案的信息）');
    return true;
  });
  // 连 stat 都进不去（父目录属主是别人）
  assert.throws(() => assertComposeEnvFile({
    envFile: 'deploy/.env', cwd: root, label: 'wpX',
    fsImpl: { statSync: () => { throw EACCES(); }, accessSync: () => {} },
  }), /存在但读不到|EACCES/);
});

// ---------------------------------------------------------------------------
// ② observeHostPath / waitForHostFile：三态必须分得开
// ---------------------------------------------------------------------------

test('#495② P5 三态分开：present / missing（缺的是中间段）/ unreadable（不是不存在）', (t) => {
  const { root, file } = fixtureUserspace(t);
  assert.equal(observeHostPath(file).state, 'present', '文件在 ⇒ present');
  assert.equal(observeHostPath(file).content.includes('erix-placeholder'), true, 'present 顺带给正文');

  const missing = observeHostPath(path.join(root, 'bob', 'home', '.erix', 'config.json'));
  assert.equal(missing.state, 'missing');
  assert.equal(missing.missingPrefix, path.join(root, 'bob'),
    '必须点名**第一个不存在的段**（只报叶子 = 看不出 materializer 走到哪一步）');

  // 真机形态：链上某段是 0770 root:node，当前用户不在组里 ⇒ accessSync 抛 EACCES
  const blocked = observeHostPath(file, {
    fsImpl: {
      ...fs,
      statSync: (p) => (p === path.join(root, 'alice')
        ? { mode: 0o40770, uid: 0, gid: 1000, isDirectory: () => true }
        : fs.statSync(p)),
      accessSync: (p, mode) => { if (p === path.join(root, 'alice')) throw EACCES(); fs.accessSync(p, mode); },
    },
  });
  assert.equal(blocked.state, 'unreadable');
  assert.equal(blocked.blocker.path, path.join(root, 'alice'),
    'blocker 必须指向**被挡住的那一段**，不是叶子（叶子在 4 层之下）');
  assert.equal(blocked.blocker.mode, '0o770');
  assert.equal(blocked.blocker.owner, '0:1000', '属主写出来才能一眼对上 FDE_USER_UID/GID=1000/1000');
  assert.notEqual(blocked.state, missing.state, '「读不到」与「没物化」必须是两个状态（合成一个就是 #412 的坑）');

  // 链上某段是普通文件 ⇒ 不是目录（等下去也没用）
  const aFile = path.join(root, 'afile');
  fs.writeFileSync(aFile, 'x');
  const chain = inspectHostPathChain(path.join(aFile, 'sub', 'config.json'));
  assert.equal(chain.blocker?.reason, 'not-a-directory', '祖先段是文件 ⇒ 点名它不是目录');
  assert.equal(chain.blocker.path, aFile);
});

test('#495② P5b 文件本身不可读（链能进，但 readFileSync 抛 EACCES）⇒ 还是 unreadable', (t) => {
  const { file } = fixtureUserspace(t);
  // 真机另一形状：目录能进（比如组内用户），但 config.json 本身属主不对 / mode 0600
  const fake = {
    ...fs,
    readFileSync: (p, enc) => {
      if (p === file) throw EACCES();
      return fs.readFileSync(p, enc);
    },
  };
  const blocked = observeHostPath(file, { fsImpl: fake });
  assert.equal(blocked.state, 'unreadable', '文件级 EACCES 不许被归成 missing（那会被读成「没物化」）');
  assert.equal(blocked.blocker.path, file, '文件级挡住 ⇒ blocker 就是叶子本身');
  assert.match(blocked.blocker.mode, /^0o6/, 'mode 从真 stat 拿（给用户看一眼权限）');
  assert.equal(inspectHostPathChain(file).blocker, null, '链本身能进 ⇒ 链上没有 blocker（区分层级）');
});

test('#495② P6 等待：读不到 ⇒ 不等满超时（权限不是时间问题），文案点名 uid 不一致', async (t) => {
  const { root, file } = fixtureUserspace(t);
  const fake = {
    ...fs,
    statSync: (p) => (p === path.join(root, 'alice')
      ? { mode: 0o40770, uid: 0, gid: 1000, isDirectory: () => true }
      : fs.statSync(p)),
    accessSync: (p, mode) => { if (p === path.join(root, 'alice')) throw EACCES(); fs.accessSync(p, mode); },
  };
  const timeoutMs = 60_000;
  const started = Date.now();
  await assert.rejects(
    waitForHostFile(file, { fsImpl: fake, timeoutMs, intervalMs: 5, sleepImpl: noSleep, label: 'alice config.json materialized' }),
    (error) => {
      const m = String(error.message);
      assert.match(m, /读不到/, '报的是「读不到」，不是「没物化」（#495 ② 的验收判据）');
      assert.doesNotMatch(m, /timeout waiting for/, '不是超时——等下去本来也没结果');
      assert.match(m, /alice config\.json materialized/);
      assert.match(m, /FDE_USER_UID/, '文案要给最可能的原因（uid/gid 与 1000 不一致）');
      assert.match(m, /0:1000/);
      return true;
    },
  );
  assert.ok(Date.now() - started < timeoutMs / 2, '读不到必须**提前**放弃（改成一直等满就红）');
});

test('#495② P7 等待：真的没物化 ⇒ 等满超时，且文案不喊「读不到」', async (t) => {
  const { root } = fixtureUserspace(t);
  const never = path.join(root, 'nobody', 'home', '.erix', 'config.json');
  const timeoutMs = 40;
  const started = Date.now();
  await assert.rejects(
    waitForHostFile(never, {
      timeoutMs, intervalMs: 5, sleepImpl: async (ms) => { await new Promise((r) => { setTimeout(r, ms); }); },
      label: 'nobody config.json materialized',
      describe: () => 'ls: cannot access /srv/erix/users/nobody: No such file or directory',
    }),
    (error) => {
      const m = String(error.message);
      assert.match(m, /timeout waiting for nobody config\.json materialized/, '旧文案的形状保留（历史 grep 仍有效）');
      assert.match(m, /不存在/, '点名「路径上第一段不存在」= 真没物化');
      assert.ok(m.includes(path.join(root, 'nobody')), '要点名缺的是哪一段');
      assert.doesNotMatch(m, /读不到|FDE_USER_UID/, '真没物化时不许喊权限（那会把人带去改 uid）');
      assert.match(m, /No such file or directory/, '现场快照要附在文案里（#495 ② 判据 2 的形态）');
      return true;
    },
  );
  assert.ok(Date.now() - started >= timeoutMs, '没物化必须真的等满（提前放弃 = 把慢物化误报成失败）');
});

test('#495② P8 等待：文件延迟出现 ⇒ 返回正文；describe 只在失败时调用', async (t) => {
  const { root, file } = fixtureUserspace(t);
  let probes = 0;
  const fake = {
    ...fs,
    readFileSync: (p, enc) => {
      probes += 1;
      if (probes < 3) { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }); }
      return fs.readFileSync(p, enc);
    },
  };
  let described = 0;
  const content = await waitForHostFile(file, {
    fsImpl: fake, timeoutMs: 5_000, intervalMs: 1, sleepImpl: noSleep, describe: () => { described += 1; return 'x'; },
  });
  assert.match(content, /erix-placeholder/, '返回正文（调用方不必再读一次，避免与 materializer 抢）');
  assert.equal(probes, 3, '前两次必须真的在等（不轮询 = 把慢物化当失败）');
  assert.equal(described, 0, '成功路径不许取现场快照（那是失败附件，不是常规日志）');
});

test('#495② P9 describe 自己炸 ⇒ 写进文案而不是换一种失败形状', async (t) => {
  const { root } = fixtureUserspace(t);
  await assert.rejects(
    waitForHostFile(path.join(root, 'ghost', 'config.json'), {
      timeoutMs: 1, intervalMs: 1, sleepImpl: noSleep, label: 'ghost config.json',
      describe: () => { throw new Error('docker: No such container: station-portal-x'); },
    }),
    (error) => {
      const m = String(error.message);
      assert.match(m, /ghost config\.json/);
      assert.match(m, /No such container/, '取不到快照这件事也要写在文案里');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 现场快照的两件小工具（宿主路径 ↔ 容器路径、ls 命令形状）
// ---------------------------------------------------------------------------

test('#495② P10 宿主路径 → portal 容器内路径（同路径 bind mount）', (t) => {
  const { root, file } = fixtureUserspace(t);
  assert.equal(toContainerPath(file, { hostRoot: root }),
    `${PORTAL_USERSPACE_CONTAINER_ROOT}/alice/home/.erix/config.json`);
  assert.equal(toContainerPath(root, { hostRoot: root }), PORTAL_USERSPACE_CONTAINER_ROOT, '根自身映射到容器根');
  assert.throws(() => toContainerPath('/some/other/tree/config.json', { hostRoot: root }),
    /不在宿主挂载根/, '换算不出来要抛（拼错根目录 = 快照指到别处，白看）');
});

test('#495② P11 现场快照 = 一条不抛错的 ls（父目录 + 目标一起看）', () => {
  const calls = [];
  const out = materializeSnapshot({
    docker: (args) => { calls.push(args); return 'drwxrws--- 3 root node ... /srv/erix/users/alice/home/.erix\n'; },
    container: 'station-portal-e2e1',
    containerPath: '/srv/erix/users/alice/home/.erix/config.json',
  });
  assert.equal(calls.length, 1, '一次 docker 调用就够（成本敏感的判据不能查三次）');
  assert.ok(
    calls[0].startsWith('exec station-portal-e2e1 sh -c "ls -ld /srv/erix/users/alice/home/.erix /srv/erix/users/alice/home/.erix/config.json'),
    `快照命令的形状不对（父目录 + 目标一起看）：${calls[0]}`,
  );
  assert.match(calls[0], /2>&1 \|\| true/, '远端 stderr 合并 + 不吃退出码（ls 对缺失段返回 2，那句话正是要的）');
  assert.match(out, /drwxrws---/, '快照正文原样进文案');
  // docker 本身炸（容器不在）也不能把主失败换一种形状
  const broken = materializeSnapshot({
    docker: () => { throw new Error('Command failed: docker exec ...'); },
    container: 'station-portal-x',
    containerPath: '/srv/erix/users/alice/home/.erix/config.json',
  });
  assert.match(broken, /快照取不到/, '取不到时返回说明文本，不抛');
});

// ---------------------------------------------------------------------------
// 末段是符号链接：要**可区分**，但不改三态归属（主 agent 裁决：只诊断，不改策略；bind 源做成链接是合法配置）
// ---------------------------------------------------------------------------

test('#495② L1 ① 末段是符号链接且目标可读 ⇒ 仍是 present，但链接事实为真、诊断行点名目标', (t) => {
  const { dir, file } = fixtureUserspace(t);
  const link = path.join(dir, 'config-link.json');
  fs.symlinkSync(path.relative(dir, file), link); // 故意用**相对**链接：顺带验解析
  const observed = observeHostPath(link);
  assert.equal(observed.state, 'present', '链接指向可读文件 ⇒ 状态照旧 present（不新增第四态、不因此判失败）');
  assert.equal(observed.content.includes('erix-placeholder'), true, 'present 照旧给正文');
  assert.equal(observed.link.isSymlink, true, '链接事实必须为真（statSync 跟随链接看不出来 ⇒ 本格靠 lstatSync）');
  assert.equal(observed.link.targetExists, true, '目标存在要说出来');
  assert.equal(observed.link.resolvedTarget, file, `相对目标要解析成绝对：${JSON.stringify(observed.link)}`);
  const line = formatLastSegmentLinkLine(observed.link);
  assert.match(line, /符号链接/, '① 文案必须含「符号链接」');
  assert.ok(line.includes(link), `诊断行要带是哪条路径：${line}`);
  assert.ok(line.includes(path.relative(dir, file)), `诊断行要带链接目标（readlink 的原样）：${line}`);
  assert.ok(line.includes(file), `相对链接还要给出解析后的绝对目标：${line}`);
  assert.match(line, /portal 容器里看到的是\*\*链接目标那一侧\*\*/, 'bind 源是链接时的关键提示必须在（不写出来就是拿状态猜挂载）');
  // 不注入也能直接拿事实（给调用方自己拼日志用）
  assert.equal(observeLastSegmentLink(link, { fsImpl: {} }).isSymlink, null, '注入的 fsImpl 没有 lstatSync ⇒ 只能说「无从判定」，不许假装不是链接');
});

test('#495② L2 ② 末段是真文件 ⇒ 链接事实为假、文案里根本不出现「符号链接」（反向自证）', async (t) => {
  const { root, file } = fixtureUserspace(t);
  const observed = observeHostPath(file);
  assert.equal(observed.state, 'present');
  assert.equal(observed.link.isSymlink, false, '真文件不许被写成链接（把判定写死成恒真 ⇒ 本格红）');
  assert.equal(observed.link.detectable, true, '真 fs 有 lstatSync ⇒ 必须给结论，不许拿「无从判定」糊过去');
  assert.equal(formatLastSegmentLinkLine(observed.link), '', '非链接要渲染成空串（而不是来一句「不是链接」）');
  // 失败文案里也不许出现：等一个不存在的叶子（链能进、叶子没物化）
  const err = await waitForHostFile(path.join(root, 'alice', 'home', '.erix', 'ghost.json'), {
    timeoutMs: 5, intervalMs: 1, sleepImpl: noSleep, label: 'ghost config.json',
  }).then(() => null, (error) => error);
  assert.ok(err, '不存在 ⇒ 最终必须拒绝');
  assert.doesNotMatch(err.message, /符号链接/, '真没物化的文案里不该冒出链接（那会把人带去查挂载）');
});

test('#495② L3 悬空链接 ⇒ 状态仍归 missing（不改归属），但文案说清「是链接、缺的是目标」', async (t) => {
  const { dir } = fixtureUserspace(t);
  const dangling = path.join(dir, 'dangling.json');
  const goneTarget = path.join(dir, 'never-written-by-materializer.json');
  fs.symlinkSync(path.relative(dir, goneTarget), dangling);
  const observed = observeHostPath(dangling);
  assert.equal(observed.state, 'missing', '悬空链接**归属不变**（改成第四态会连锁打崩 P7/P8 的时间判据）');
  assert.equal(observed.missingPrefix, dangling);
  assert.equal(observed.link.isSymlink, true, 'lstat 看得见悬空链接本体（statSync 只会看到 ENOENT ⇒ 链接事实就丢了）');
  assert.equal(observed.link.targetExists, false);
  const err = await waitForHostFile(dangling, {
    timeoutMs: 5, intervalMs: 1, sleepImpl: noSleep, label: 'dangling config.json',
  }).then(() => null, (error) => error);
  assert.ok(err);
  assert.match(err.message, /timeout waiting for dangling config\.json/, '仍走 missing 那条形状（旧 grep 不坏）');
  assert.match(err.message, /符号链接/, '要顺带说出它是链接');
  assert.ok(err.message.includes(goneTarget), `要点名缺的是链接目标：${err.message}`);
  assert.match(err.message, /缺的是\*\*链接目标\*\*/);
  assert.doesNotMatch(err.message, /读不到|FDE_USER_UID/, '悬空链接不是权限问题');
});

test('#495② L4 叶子级不存在（stat 能进、叶子没物化）⇒ 与权限失败分得开（#227/§8.128 盲区补格）', (t) => {
  const { dir, file } = fixtureUserspace(t);
  const leaf = path.join(dir, 'late.json');
  assert.equal(observeHostPath(leaf).state, 'missing', '链能进但叶子不存在 ⇒ 还是 missing');
  // 真 fs 里单次调用造不出「stat 在、read 不在」（中间有竞态窗口），所以这一格用注入：
  // statSync/accessSync 走真 fs（链确认可进），只把 readFileSync 换成 ENOENT ⇒ 这就是叶子级不存在。
  const leafGone = { ...fs, readFileSync: () => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }); } };
  const observed = observeHostPath(file, { fsImpl: leafGone });
  assert.equal(observed.state, 'missing', '叶子在 stat 与 read 之间消失 ⇒ 归 missing（归进 unreadable = 把没物化当成权限，#495 ② 反向坑）');
  assert.equal(observed.blocker, null, '不许进 unreadable 分支（进了就有 blocker，而这里根本没权限问题）');
});

// ---------------------------------------------------------------------------
// 链上**更早**的段是链接（`mount -> real`，即「bind 源本身就是符号链接」的真实摆法）
// ---------------------------------------------------------------------------

test('#495② L5 ① ancestor 是链接（mount -> real）⇒ links 里有那一段、文案点名它与目标', async (t) => {
  // 真实部署里这是 `/srv/erix -> /data/erix` 那种：bind 源自己是个链接，而**末段根本不像链接**
  // ⇒ 只看末段等于完全看不见它（上一轮自报的边界，本轮就补这一条）。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-495-anc-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const real = path.join(base, 'real');
  const home = path.join(real, 'alice', 'home', '.erix');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), '{"ok":1}');
  const mount = path.join(base, 'mount');
  fs.symlinkSync(path.relative(base, real), mount); // 相对链接：顺带验解析
  const target = path.join(mount, 'alice', 'home', '.erix', 'config.json');

  const observed = observeHostPath(target);
  assert.equal(observed.state, 'present', '祖先段是链接 ⇒ 三态归属一个字不改（仍 present）');
  const ancestorLinks = observed.links.filter((entry) => entry.isSymlink === true && entry.isLastSegment === false);
  assert.equal(ancestorLinks.length, 1, `links 里必须有 mount 那一段：${JSON.stringify(observed.links.map((e) => [e.segment, e.isSymlink, e.isLastSegment]))}`);
  assert.equal(ancestorLinks[0].segment, mount, '点名的是那一段的路径（不是叶子）');
  assert.equal(ancestorLinks[0].resolvedTarget, real, '还要给出解析后的目标');
  assert.equal(ancestorLinks[0].targetExists, true);
  assert.equal(observed.links.at(-1).segment, target, '末段那条继续保留（不破坏已合并的形状）');
  assert.equal(ancestorLinks[0].isLastSegment, false);
  // 逐段 API 单独用也得诚实：没有 lstatSync ⇒ 无从判定，不许假装「不是链接」
  assert.equal(observeSegmentLink(mount, { fsImpl: {} }).isSymlink, null);

  const line = formatAncestorLinkLines(observed.links);
  assert.match(line, /符号链接/, '① 文案必须点名链上的链接');
  assert.ok(line.includes(mount), `要点名那一段：${line}`);
  assert.ok(line.includes(real), `要点名它指向哪里：${line}`);
  assert.match(line, /不是同一个 inode/);
  assert.match(line, /要改的是宿主侧这条链接指向/, '要说清「宿主侧改哪里才有效」（不然会去改容器里那一侧）');

  // 真到失败路径时这行必须在场（诊断行不是只给单测看的）
  const err = await waitForHostFile(path.join(mount, 'alice', 'home', '.erix', 'ghost.json'), {
    timeoutMs: 5, intervalMs: 1, sleepImpl: noSleep, label: 'ghost under mount config.json',
  }).then(() => null, (error) => error);
  assert.ok(err, '叶子没物化 ⇒ 仍按 missing 拒绝（归属没动）');
  assert.match(err.message, /timeout waiting for ghost under mount config\.json/);
  assert.match(err.message, /链上第一段符号链接（不是末段）：/, '失败文案要带上链上那一段');
  assert.ok(err.message.includes(mount) && err.message.includes(real), `失败文案要点名链接与目标：${err.message}`);
});

test('#495② L6 ② 全链都是真目录 ⇒ links 里没有任何链接、诊断行零输出（反向自证）', async (t) => {
  const { root, dir, file } = fixtureUserspace(t);
  const observed = observeHostPath(file);
  assert.equal(observed.state, 'present');
  const mine = observed.links.filter((entry) => entry.segment === root || entry.segment.startsWith(root + path.sep));
  assert.ok(mine.length >= 3, `夹具里至少该走查过三段（alice/home/.erix）：${JSON.stringify(observed.links.map((e) => e.segment))}`);
  assert.deepEqual(mine.filter((entry) => entry.isSymlink === true), [], '全真目录 ⇒ 一条链接都不许报（把那行改成恒输出 ⇒ 本格红）');
  assert.equal(mine.every((entry) => entry.isSymlink === false && entry.detectable === true), true,
    '真 fs 有 lstatSync ⇒ 每段都要给出结论，不许拿「无从判定」糊过去');
  assert.equal(formatAncestorLinkLines(observed.links), '', '零输出（不是来一句「链上没有链接」）');
  assert.equal(formatAncestorLinkLines([]), '');
  assert.equal(formatAncestorLinkLines(null), '');
  // 失败文案里也不许出现链接（全真目录的没物化就是没物化）
  const err = await waitForHostFile(path.join(dir, 'ghost.json'), {
    timeoutMs: 5, intervalMs: 1, sleepImpl: noSleep, label: 'plain ghost config.json',
  }).then(() => null, (error) => error);
  assert.ok(err);
  assert.doesNotMatch(err.message, /符号链接/, '真目录链上的没物化文案里不该冒出链接');
});

test('#495 接线静态自检：脚本必须在**任何 docker 之前**做预检（源码级）', () => {
  const dir = path.join(REPO_ROOT, 'portal/integration');
  const scripts = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  const withEnvFile = scripts.filter((f) => /--env-file\s+deploy\/\.env/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.ok(withEnvFile.length >= 6, `夹具过期：带 --env-file deploy/.env 的脚本只剩 ${withEnvFile.length} 个`);
  for (const script of withEnvFile) {
    const text = fs.readFileSync(path.join(dir, script), 'utf8');
    assert.match(text, /assertComposeEnvFile\(\{/, `${script} 带 --env-file 却没做预检`);
    const lines = text.split('\n');
    const callLine = lines.findIndex((l) => /^\s*assertComposeEnvFile\(\{/.test(l));
    const composeCallLine = lines.findIndex((l) => /\bcompose\(['"]/.test(l));
    const dockerCallLine = lines.findIndex((l) => /\bdocker\(['"]/.test(l));
    assert.ok(callLine !== -1, `${script}: 预检调用找不到`);
    if (composeCallLine !== -1) assert.ok(callLine < composeCallLine, `${script}:${callLine + 1} 预检晚于第一次 compose（:${composeCallLine + 1}）= 白跑一趟 docker`);
    if (dockerCallLine !== -1) assert.ok(callLine < dockerCallLine, `${script}:${callLine + 1} 预检晚于第一次 docker`);
  }
  // ② 的接线：config.json 的等待不许回到「existsSync 一把梭」
  for (const script of ['wp3b-e2e.mjs', 'wp5-e2e.mjs', 'wp6-llm-e2e.mjs']) {
    const text = fs.readFileSync(path.join(dir, script), 'utf8');
    assert.match(text, /waitForHostFile\(/, `${script} 没有用 waitForHostFile 等物化文件`);
    assert.doesNotMatch(text, /fs\.existsSync\(config(?:Json)?Path\)/,
      `${script}: 又用 fs.existsSync(configPath) 等物化（EACCES 会被吞成「没物化」，#495 ②）`);
  }
});

// ---------------------------------------------------------------------------
// #227① E1–E5：`deploy/.env` 的值解析 ⇔「与共享路径不同」这条隔离判据（PR #554 复审 BLOCKER）
//
// 坑的形状：旧 `readEnvFile` 的正则在**未加引号**的值上把 ` # …` 整段留在值里 ⇒
// `TRAEFIK_DYNAMIC_DIR_HOST=/docker/station-edge/dynamic # shared` 解析成
// `"/docker/station-edge/dynamic # shared"`，**不等于**真路径 `/docker/station-edge/dynamic`
// ⇒ `assertHostWritePathsIsolated` 那条「与共享 `.env` 的值不相等」在**危险方向上恒真**：
// 隔离栈照旧往生产边缘的目录写（#227① 现场：8090 全线 502 而容器全绿），预检却报绿。
//
// 取舍（主 agent 给的 A 案）：预检**拒**「我们无从复现 compose 真值」的键值行（点名 文件:行号:键名 + 原文），
// 而不是让解析器去猜 compose 会怎么读。代价 = 真 `.env` 若在这四个比对键上写了未加引号注释，起跑前会红一次
// （文案直接给改法），所以只盯那四个键 ⇒ E2 就是「不误杀」那一格。
// E3/E4 是**外部基准**（不许同源自证）：E3 的表照抄真 compose 2.40.3 的输出（命令与原文读数见交付报告），
// E4 在有 docker 的机器上现场再跑一次 compose 对账；没有 docker 就 skip 并说明退回 E3 的记录读数。
// ---------------------------------------------------------------------------

/** compose 2.40.3 对这些写法的实际读数（基准命令：`docker compose --env-file <env> -f <yml> config --format json`）。 */
const COMPOSE_PARSE_CASES = [
  ['V1=/a/b # shared', '/a/b'],                       // 本单 BLOCKER 那一形
  ['V2="/c/d" # after quoted', '/c/d'],               // 引号闭合后的注释同样剥
  ['V3=/g/h#nospace', '/g/h#nospace'],                // `#` 前不是空格 ⇒ 不是注释
  ['V4="/i/j # inside"', '/i/j # inside'],            // 引号内的 `#` 是正文
  ["V5='#k/l # single'", '#k/l # single'],
  ['V6=a  b   #   deep', 'a  b'],
  ['V7=/m/n\t#tab', '/m/n\t#tab'],                    // tab 不算注释起始（实测：只有空格算）
  ['V8=  spaced value  # tail', 'spaced value'],
  ['V9=#hash first', '#hash first'],                  // 值首的 `#` 是字面量
  ['V10=/p/q   ', '/p/q'],
  ['V11=/r/s "" # quoted empty after', '/r/s ""'],
  ['V12=/t/u"q" # quoted inside', '/t/u"q"'],
  ['V13="" # empty then comment', ''],
];
/** 一套「四个宿主写路径键都隔离干净」的 env 值。 */
const ISOLATED_FOUR = Object.freeze({
  TRAEFIK_DYNAMIC_DIR_HOST: '/erix-e2e/dynamic',
  ERIX_USERSPACE_ROOT_HOST: '/erix-e2e/users',
  ERIX_ARTIFACTS_ROOT_HOST: '/erix-e2e/artifacts',
  STATION_DB_DIR: '/erix-e2e/db',
});

/** 写一份「共享 deploy/.env」夹具（根目录先 realpath 归一：`$TMPDIR` 本身是链接时也不受牵连）。 */
function envFileFixture(t, sharedLines) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'erix-554-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envFile = path.join(root, 'shared.env');
  fs.writeFileSync(envFile, sharedLines.join('\n') + '\n');
  return { root, envFile };
}

test('#227① E1 共享路径带未加引号的行内注释 ⇒ 预检必须红并点名 文件:行号:键名（危险方向不再恒真）', (t) => {
  const { root, envFile } = envFileFixture(t, [
    '# 共享栈（生产边缘读的就是这一份）',
    '',
    'TRAEFIK_DYNAMIC_DIR_HOST=/docker/station-edge/dynamic # shared',
  ]);
  const mine = { ...ISOLATED_FOUR, TRAEFIK_DYNAMIC_DIR_HOST: '/docker/station-edge/dynamic' };
  assert.throws(() => assertHostWritePathsIsolated({ env: mine, envFile, label: 'wp3b-e2e' }), (error) => {
    const text = String(error.message);
    assert.match(text, /shared\.env:3 TRAEFIK_DYNAMIC_DIR_HOST/, `必须点名 文件:行号:键名，实际：${text}`);
    assert.ok(text.includes('未加引号'), `要说清拒的是哪一形，实际：${text}`);
    assert.ok(text.includes('TRAEFIK_DYNAMIC_DIR_HOST=/docker/station-edge/dynamic # shared'),
      `必须带上原文（不给人看原文，人就看不出这行为什么危险）：${text}`);
    return true;
  });
  // 同一行去掉注释 ⇒ 碰撞判据照常工作。别让它变成「只有拒」活着、真碰撞反倒没人管。
  const clean = path.join(root, 'clean.env');
  fs.writeFileSync(clean, 'TRAEFIK_DYNAMIC_DIR_HOST=/docker/station-edge/dynamic\n');
  assert.throws(() => assertHostWritePathsIsolated({ env: mine, envFile: clean, label: 'wp3b-e2e' }), /与共享栈共用同一份/);
  // 机器事实：compose 对那一行读到的**就是**那条真路径（旧解析留下的字符串与真值不等 ⇒ E1 的红有依据，不是文案红）
  assert.equal(parseComposeEnvFile(envFile).values.TRAEFIK_DYNAMIC_DIR_HOST, '/docker/station-edge/dynamic');
});

test('#227① E2 合法 env 不误杀：注释行 / 空行 / 缩进注释 / 引号内含 # / # 前无空格 / 非比对键带行内注释', (t) => {
  const { envFile } = envFileFixture(t, [
    '# 说明', '', '   # 缩进注释',
    'TRAEFIK_DYNAMIC_DIR_HOST="/docker/station-edge/dynamic # odd"',
    'ERIX_USERSPACE_ROOT_HOST=/erix/users#nospace',
    'ERIX_ARTIFACTS_ROOT_HOST=/erix/artifacts',
    'STATION_DB_DIR=/docker/station-db',
    'POSTGRES_PASSWORD=Sup3r#cret # 生产库密码',
    'PLATFORM_DB_PASSWORD=p1 # 平台库',
  ]);
  assert.doesNotThrow(() => assertHostWritePathsIsolated({ env: ISOLATED_FOUR, envFile, label: 'wp3b-e2e' }));
  const values = parseComposeEnvFile(envFile).values;
  assert.equal(values.TRAEFIK_DYNAMIC_DIR_HOST, '/docker/station-edge/dynamic # odd',
    '引号内的 `#` 必须是正文（误剥就是把一条合法路径改短 ⇒ 又在危险方向上漂）');
  assert.equal(values.ERIX_USERSPACE_ROOT_HOST, '/erix/users#nospace', '`#` 前不是空格就不是注释（compose 实测同口径）');
  assert.equal(values.POSTGRES_PASSWORD, 'Sup3r#cret',
    '非比对键：注释照剥（compose 口径）但不因此拒 —— 真 `deploy/.env` 里三行密码就是这个写法，一律拒就是把 e2e 关在门外');
});

test('#227① E3 外部基准（记录读数）：compose 2.40.3 对 13 种写法的读数，我们的解析必须逐字相等', () => {
  const problems = [];
  for (const [line, want] of COMPOSE_PARSE_CASES) {
    const key = /^([A-Z0-9_]+)=/.exec(line)[1];
    const parsed = parseComposeEnvLine(line);
    if (parsed.kind !== 'pair') problems.push(`${key}: 我们解析成 ${parsed.kind}，compose 读到的是 ${JSON.stringify(want)}`);
    else if (parsed.value !== want) {
      problems.push(`${key}: 我们 ${JSON.stringify(parsed.value)} ≠ compose ${JSON.stringify(want)}（原文 ${JSON.stringify(line)}）`);
    }
  }
  assert.deepEqual(problems, [],
    `解析口径与 compose 漂了（隔离判据比的是字符串，往哪个方向漂就是哪个方向的错）：\n  ${problems.join('\n  ')}`);
  // compose 自己会硬报错的两种写法：我们复现不了 ⇒ 必须标 unparsable（交给预检拒），不许默默给个值
  assert.equal(parseComposeEnvLine('V14="/a/b # x').kind, 'unparsable', '未闭合引号');
  assert.equal(parseComposeEnvLine('V15="/a/b"junk # c').kind, 'unparsable', '引号闭合后带垃圾');
  // 纯注释行与空行不算键值行（误算就是把 `# 说明` 当成一个键）
  assert.equal(parseComposeEnvLine('   # 说明').kind, 'blank', '缩进的注释行也是注释');
  assert.equal(parseComposeEnvLine('   ').kind, 'blank', '空行');
});

test('#227① E4 外部基准（现场复核）：现场再跑一次真 compose 与我们的解析对账（无 docker ⇒ skip 并说明）', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'erix-554-oracle-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envFile = path.join(root, '.env');
  fs.writeFileSync(envFile, COMPOSE_PARSE_CASES.map(([line]) => line).join('\n') + '\n');
  const composeFile = path.join(root, 'probe.yml');
  fs.writeFileSync(composeFile, ['services:', '  probe:', '    image: alpine', '    environment:']
    .concat(COMPOSE_PARSE_CASES.map(([line]) => {
      const key = /^([A-Z0-9_]+)=/.exec(line)[1];
      return `      ${key}: "\${${key}:-UNSET}"`;
    }))
    .join('\n') + '\n');
  let json;
  try {
    json = execFileSync('docker', ['compose', '--env-file', envFile, '-f', composeFile, 'config', '--format', 'json'],
      { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const why = String(error?.stderr ?? error?.message ?? error).split('\n')[0];
    t.skip(`现场没有可用的 docker compose（${why.slice(0, 100)}）⇒ 外部基准退回 E3 的记录读数（那张表也是从真 compose 抄的）`);
    return;
  }
  const got = JSON.parse(json).services.probe.environment ?? {};
  const problems = [];
  for (const [line, want] of COMPOSE_PARSE_CASES) {
    const key = /^([A-Z0-9_]+)=/.exec(line)[1];
    const expect = want === '' ? 'UNSET' : want;   // `${K:-UNSET}`：空值走默认分支（compose 实测）
    // 三方对账：现场 compose ⇔ 记录表（E3）⇔ 我们的解析器。只比前两样只能发现「表过期」，
    // 发现不了「解析器漂了」——而漂了的解析器正是本单 BLOCKER 的病根。
    if (got[key] !== expect) problems.push(`${key}: compose 现场读 ${JSON.stringify(got[key])} ≠ 记录表 ${JSON.stringify(want)}（原文 ${JSON.stringify(line)}）⇒ 表过期了`);
    const mine = parseComposeEnvLine(line);
    if (mine.kind !== 'pair' || mine.value !== want) problems.push(`${key}: 我们的解析读 ${JSON.stringify(mine.value ?? mine.kind)} ≠ compose 现场 ${JSON.stringify(got[key])}（原文 ${JSON.stringify(line)}）⇒ 解析口径漂了`);
  }
  assert.deepEqual(problems, [], `现场 compose ⇔ 记录表 ⇔ 我们的解析三方对不上：\n  ${problems.join('\n  ')}`);
});

test('#227① E5 同族拒：比对键的值带 $ 插值 / 未闭合引号 / 引号后带垃圾 ⇒ 点名到行（非比对键不误杀）', (t) => {
  for (const [line, key, wantName] of [
    ['STATION_DB_DIR=/docker/${STACK}/db', 'STATION_DB_DIR', '$ 插值'],
    ['ERIX_ARTIFACTS_ROOT_HOST="/a/b # x', 'ERIX_ARTIFACTS_ROOT_HOST', '未闭合'],
    ['ERIX_USERSPACE_ROOT_HOST="/a/b"junk # c', 'ERIX_USERSPACE_ROOT_HOST', '垃圾'],
  ]) {
    const { envFile } = envFileFixture(t, [line]);
    assert.throws(() => assertHostWritePathsIsolated({ env: ISOLATED_FOUR, envFile, label: 'wp3b-e2e' }), (error) => {
      assert.ok(String(error.message).includes(`shared.env:1 ${key}`), `${key} 必须被点名到行，实际：${error.message}`);
      assert.ok(String(error.message).includes(wantName), `文案要说清是哪一形（${wantName}），实际：${error.message}`);
      return true;
    });
  }
  // 反向自证：`$` 出现在**非比对键**上不误杀（密码里带 `$` 很常见，一律拒就是把 e2e 关在门外）
  const { envFile } = envFileFixture(t, [
    'TRAEFIK_DYNAMIC_DIR_HOST=/docker/station-edge/dynamic',
    'ERIX_USERSPACE_ROOT_HOST=/docker/erix/users',
    'ERIX_ARTIFACTS_ROOT_HOST=/docker/erix/artifacts',
    'STATION_DB_DIR=/docker/station-db',
    'POSTGRES_PASSWORD=p$a$sw0rd # 生产库密码',
  ]);
  assert.doesNotThrow(() => assertHostWritePathsIsolated({ env: ISOLATED_FOUR, envFile, label: 'wp3b-e2e' }));
});
