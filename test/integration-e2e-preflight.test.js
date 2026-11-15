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
  COMPOSE_ENV_FILE, PORTAL_USERSPACE_CONTAINER_ROOT, assertComposeEnvFile, formatLastSegmentLinkLine, inspectHostPathChain,
  materializeSnapshot, observeHostPath, observeLastSegmentLink, toContainerPath, waitForHostFile,
} from '../portal/integration/lib/e2e-preflight.mjs';

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
