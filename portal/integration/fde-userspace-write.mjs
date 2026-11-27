#!/usr/bin/env node
// 容器侧「用户自己的目录写得进吗」——erix-station issue #575② 的**真机判据**（手工复跑工具）。
//
// 用途（一句话）：在**真容器**里以**该容器内用户的真 uid/gid**（**现读**，不是假设 1000）往他自己的目录写一个探针文件、
// 再以**同一个 uid 回读**并逐字比对，最后拿一个**不属于该目录属主的 uid** 走**反向腿**，确认「写不进去时真的会失败」。
//
// 为什么需要它（宿主 `present` 全绿证不了这件事）：宿主侧预飞 `observeHostPath()`/`waitForHostFile()` 的
// `present` 只承诺「当前**宿主**用户能穿越祖先各段（`X_OK`）并读到这个已知路径（叶子 `R_OK`）」——
// 它**不承诺可写**（`W_OK`），而容器侧 materializer 用的是**另一套 UID/GID**（口径见 #575① 写进
// `portal/integration/lib/e2e-preflight.mjs` 的注释与 `docs/testing.md` §2.2.5）。于是「宿主全绿」与
// 「容器里那个用户写得进」是两件事，必须各有判据，不许拿前者冒充后者。
//
// ⚠ 本文件是 #570 那条教训的反面：**不许拿 `fsImpl` 注入版冒充真机版**。这里没有注入面，每一条读数都来自
//   真 `docker exec`（命令原文与退出码都打进输出）。注入版只属于 `test/integration-e2e-preflight.test.js`，
//   别把「注入也能过」当成「容器写得进」。
//
// 怎么跑：
//   FDE_CONTAINER=<容器名> node portal/integration/fde-userspace-write.mjs
//   node portal/integration/fde-userspace-write.mjs --container <容器名> [--dir <容器内目录>] [--user <容器内用户名>]
//     [--neg-user <uid:gid>] [--prefix <探针文件名前缀>]
//   环境变量：`FDE_CONTAINER` / `FDE_USERSPACE_DIR` / `FDE_USERSPACE_USER` / `FDE_USERSPACE_NEG_USER`（命令行优先）。
//   默认目录是 `/home/<容器内用户>`（**不是** `.erix` 那棵：那是 portal/materializer 的地盘，往里写探针会
//   把别人的工作区当靶子）。⚠ **容器清单以 DB 为真相**（AGENTS §2「DB 是状态真相」）⇒ 本脚本**不按
//   `^fde-` 前缀猜容器**：没给容器名就直接退出码 3，别在这儿加「挑第一个 fde- 容器」的聪明逻辑。
//
// ⚠ **本脚本不拒绝 root**：取不到 `/home/<name>` 时退回容器默认用户（可能就是 root），而属主检查比的是
//   「现读的那对 uid/gid」⇒ root 跑也会绿。拒绝 root 的是**测试面** `U1`（`assert.notEqual(uid, '0')` 与
//   `assert.notEqual(user, 'root')`）⇒ 手工复跑请自己看清 `step=identity` 那一行报的是谁。
//
// 读数（每步一条 `UW575 …`，命令原文 + 退出码都在；判定只认退出码，别 grep 摘要行下结论）：
//   UW575 step=identity uid=<n> gid=<n> user=<name>            uid/gid 是**现读**的（`docker exec <c> id <user>`），不是假设 1000
//   UW575 step=target dir=<容器内目录> probe=<探针路径> bytes=<n>
//   UW575 step=write rc=<n> uid=<n> gid=<n>                     正向腿：以真 uid 写（`docker exec -i … tee`，非 root）
//   UW575 step=readback rc=<n> match=<0|1> bytes=<n>            同 uid 回读并逐字比对
//   UW575 step=stat rc=<n> out='1000:1000 644 <探针路径>'       属主与模式；属主不是那个 uid 就是 BUG（说明其实是 root 写的）
//   UW575 step=negative rc=<n> uid=<n> gid=<n> target=<路径> stderr='…'  反向腿：错 uid 必须**写不进去**（rc≠0）
//   UW575 step=cleanup rc=<n> residue=<gone|still_there>
//   UW575 verdict=PASS|BUG|FAIL …
// 退出码：`0` = 判据成立；`1` = 判据不成立（正向腿写不进 / 回读不符 / 反向腿没红 / 探针没清掉）；
//   `2` = 参数或现场读不出可信的 uid/gid；`3` = 未指定容器（见上）；`4` = 容器不可达或没在跑。
//   **1 与 4 必须分开**：「环境没起」不是「代码坏了」，混成一个码就把判据变成噪音。
//
// 为什么不进 `npm test` 的判定面：口径同 `docs/ops/ci-release.md`「e2e 不进 CI」——它要真容器。
// 测试面是 `test/integration-fde-userspace-write.test.js`：它**先实测** docker 与容器在不在，再决定跑还是跳
// （跳必须写实测到的那一条），跑得了就必须真跑本脚本。
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const OUT_TAG = 'UW575';
const out = (line) => console.log(`${OUT_TAG} ${line}`);
const firstLine = (text) => String(text ?? '').split('\n').find((l) => l.trim() !== '') ?? '';

/** 参数：`--k v` 与 `--k=v` 都收；未知参数当用法错（拼错一个字母就少一条判据，别静默吞掉）。 */
function parseArgs(argv) {
  const got = {};
  const known = new Set(['container', 'dir', 'user', 'neg-user', 'prefix']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`多余的位置参数 ${JSON.stringify(arg)}（只认 --container/--dir/--user/--neg-user/--prefix）`);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!known.has(name)) throw new Error(`未知参数 --${name}（可用：${[...known].join('/')}）`);
    if (eq !== -1) { got[name] = arg.slice(eq + 1); continue; }
    i += 1;
    if (i >= argv.length) throw new Error(`--${name} 缺值`);
    got[name] = argv[i];
  }
  return got;
}

/** 跑一条 docker：命令原文与退出码**都**打进输出（读数要能被别人复算，不能只给个结论）。 */
let cmdSeq = 0;
function docker(args, { input = null, label = '' } = {}) {
  cmdSeq += 1;
  const id = cmdSeq;
  let rc = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 << 20, input });
  } catch (error) {
    rc = typeof error.status === 'number' ? error.status : 1;
    stdout = typeof error.stdout === 'string' ? error.stdout : '';
    stderr = typeof error.stderr === 'string' ? error.stderr : String(error?.message ?? error);
  }
  out(`cmd#${id}${label ? ` step=${label}` : ''} rc=${rc} argv=${JSON.stringify(['docker', ...args])}`);
  const err = firstLine(stderr);
  if (err) out(`cmd#${id} stderr=${err.slice(0, 400)}`);
  return { rc, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  out(`verdict=FAIL reason=bad_args detail=${String(error.message).slice(0, 200)}`);
  process.exit(2);
}

const container = (parsed.container || process.env.FDE_CONTAINER || '').trim();
if (!container) {
  out('verdict=FAIL reason=no_container 未指定 FDE_CONTAINER：容器清单以 DB 为真相，本判据不按 `^fde-` 前缀猜容器（AGENTS §5）');
  process.exit(3);
}
const negUser = (parsed['neg-user'] || process.env.FDE_USERSPACE_NEG_USER || '4242:4242').trim();
const probePrefix = parsed.prefix || 'fde-userspace-write';
const probeToken = `${probePrefix}-${Date.now()}-${randomBytes(6).toString('hex')}`;

// ---------------------------------------------------------------------------
// 0. 容器在不在、在不在跑（「环境没起」与「判据不成立」是两个不同的退出码）
// ---------------------------------------------------------------------------
const inspect = docker(['inspect', container, '-f', '{{.State.Running}}'], { label: 'inspect' });
if (inspect.rc !== 0) {
  out(`verdict=FAIL reason=container_unreachable container=${container} rc=${inspect.rc}`);
  process.exit(4);
}
if (inspect.stdout.trim() !== 'true') {
  out(`verdict=FAIL reason=container_not_running container=${container} State.Running=${JSON.stringify(inspect.stdout.trim())}`);
  process.exit(4);
}

// ---------------------------------------------------------------------------
// 1. **现读**容器内用户的 uid/gid（别假设 1000：本机恰好是 1000，别的栈不保证）。
//    用户名来源按序：`--user` → `docker exec <c> env` 里出现的 `/home/<name>` → 都取不到就用
//    `docker exec <c> id` 的默认当前用户（root 也照样打印出来，让读的人一眼看见「这跑的是 root」）。
// ---------------------------------------------------------------------------
let user = (parsed.user || process.env.FDE_USERSPACE_USER || '').trim();
let userFrom = '--user/FDE_USERSPACE_USER';
if (!user) {
  const envRun = docker(['exec', container, 'env'], { label: 'env' });
  if (envRun.rc === 0) {
    const hit = /\/home\/([A-Za-z0-9._-]+)/.exec(envRun.stdout);
    if (hit) { user = hit[1]; userFrom = 'docker exec env 里的 /home/<name>'; }
  }
}
if (!user) {
  const idDefault = docker(['exec', container, 'id'], { label: 'id-default-user' });
  if (idDefault.rc !== 0) {
    out(`verdict=FAIL reason=cannot_read_container_user rc=${idDefault.rc} 既没有 --user，env 里也没有 /home/<name>，id 也跑不动`);
    process.exit(2);
  }
  const hit = /^uid=\d+\(([^)]+)\)/.exec(idDefault.stdout.trim());
  user = hit ? hit[1] : 'root';
  userFrom = '取不到 /home/<name> ⇒ 用 docker exec id 的默认当前用户';
  out(`note=user_fallback ${JSON.stringify(userFrom)} user=${user}`);
}
const idRun = docker(['exec', container, 'id', user], { label: 'identity' });
const idHit = /^uid=(\d+)\(([^)]+)\)\s+gid=(\d+)\(([^)]+)\)/.exec(idRun.stdout.trim());
if (idRun.rc !== 0 || !idHit) {
  out(`verdict=FAIL reason=cannot_read_uid_gid user=${user} rc=${idRun.rc} out=${JSON.stringify(idRun.stdout.trim().slice(0, 200))}`);
  process.exit(2);
}
const uid = Number(idHit[1]);
const gid = Number(idHit[3]);
out(`step=identity uid=${uid} gid=${gid} user=${user} user_from=${JSON.stringify(userFrom)} raw=${JSON.stringify(idRun.stdout.trim())}`);

// ---------------------------------------------------------------------------
// 2. 目标 = **用户自己的目录**（默认 `/home/<user>`，`--dir` 可覆盖）；探针文件名带随机串，
//    两次并跑不会互相踩（被踩了就会出现「一条腿写了、另一条腿删掉了」的假清理）。
// ---------------------------------------------------------------------------
const dir = (parsed.dir || process.env.FDE_USERSPACE_DIR || `/home/${user}`).trim();
const dirTrimmed = dir.replace(/\/+$/, '');
const probePath = `${dirTrimmed}/${probeToken}.txt`;
const negPath = `${dirTrimmed}/${probeToken}-${negUser.replace(/:/g, '-')}.txt`;
const content = `#575 userspace-write probe container=${container} user=${user} uid=${uid} gid=${gid} token=${probeToken}\n`;
const wantBytes = Buffer.byteLength(content);
out(`step=target dir=${dir} probe=${probePath} bytes=${wantBytes}`);

let wroteProbe = false;
let negWrote = false;
let negRc = null;
let exitCode = 1;
let stop = false;
const bail = (line) => { out(line); exitCode = 1; stop = true; };

// 目标目录先以**同一个 uid** 量一次属主与模式：正向腿绿而这一步红 = 目录本身对这个 uid 就不透明，
// 后面「写不进去」的归因就没法只落在「写权限」这一件事上。
if (!stop) {
  const dirCheck = docker(['exec', '--user', `${uid}:${gid}`, container, 'stat', '-c', '%u:%g %a %n', dir], { label: 'target-dir' });
  if (dirCheck.rc !== 0) {
    bail(`verdict=FAIL reason=cannot_stat_dir dir=${dir} uid=${uid} gid=${gid} rc=${dirCheck.rc}`);
  } else {
    out(`step=target_dir_stat rc=0 out=${JSON.stringify(dirCheck.stdout.trim())}`);
  }
}

// 正向腿 ①：以**现读的那对 uid/gid**写进去（通常是容器里的普通用户；真是 root 时这条腿仍然会绿 —— 见文件头那条警告）。
// ⚠ 必须带 `-i`：`docker exec` 不带 `-i` 就**不接 stdin**，`tee` 会立刻看到 EOF 并**写出一个空文件然后 rc=0**
// ——于是正向腿会「写成功」而其实什么都没写（本机实测到过：readback 报 `bytes=0 want=130`）。
// 下面那条逐字回读就是抱这个假绿的：只比对在不在，就抱不住。
if (!stop) {
  const write = docker(['exec', '-i', '--user', `${uid}:${gid}`, container, 'tee', probePath], { input: content, label: 'write' });
  wroteProbe = write.rc === 0;
  out(`step=write rc=${write.rc} uid=${uid} gid=${gid} target=${probePath} wrote=${wroteProbe ? 1 : 0}`);
  if (!wroteProbe) bail(`verdict=FAIL reason=userspace_write_blocked uid=${uid} gid=${gid} target=${probePath}`);
}

// 正向腿 ②：同 uid 回读，逐字比对（「写得进」与「读得回」在 userspace 里是两回事）
if (!stop) {
  const readback = docker(['exec', '--user', `${uid}:${gid}`, container, 'cat', probePath], { label: 'readback' });
  const gotBytes = Buffer.byteLength(readback.stdout);
  const match = readback.rc === 0 && readback.stdout === content ? 1 : 0;
  out(`step=readback rc=${readback.rc} uid=${uid} gid=${gid} match=${match} bytes=${gotBytes} want=${wantBytes}`);
  if (match !== 1) {
    bail(`verdict=FAIL reason=readback_mismatch uid=${uid} gid=${gid} target=${probePath} got=${JSON.stringify(readback.stdout.slice(0, 200))}`);
  }
}

// 正向腿 ③：属主与模式进读数；**属主必须就是那个 uid**（出现 `0:0` 就说明这条腿其实是 root 写的）
if (!stop) {
  const statRun = docker(['exec', '--user', `${uid}:${gid}`, container, 'stat', '-c', '%u:%g %a %n', probePath], { label: 'stat' });
  out(`step=stat rc=${statRun.rc} out=${JSON.stringify(statRun.stdout.trim())}`);
  if (statRun.rc !== 0) {
    bail(`verdict=FAIL reason=cannot_stat_probe target=${probePath} uid=${uid} gid=${gid}`);
  } else {
    const owner = /^(\d+):(\d+)\s/.exec(statRun.stdout.trim());
    if (!owner || Number(owner[1]) !== uid || Number(owner[2]) !== gid) {
      bail(`verdict=BUG reason=probe_owner_not_userspace expect=${uid}:${gid} got=${JSON.stringify(statRun.stdout.trim())} target=${probePath}`);
    } else {
      out(`step=owner_ok expect=${uid}:${gid} got=${owner[1]}:${owner[2]}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. 反向腿：换一个**不属于该目录属主**的 uid 往同一位置写 ⇒ **必须失败**，且失败文案点名 uid/gid 与目标
//    路径。这条是整张判据的牙：没有它，「正向腿绿」可能只是「谁都能写」（比如整条腿其实是 root）。
// ---------------------------------------------------------------------------
if (!stop) {
  const neg = docker(['exec', '-i', '--user', negUser, container, 'tee', negPath], { input: content, label: 'negative' });
  negRc = neg.rc;
  negWrote = neg.rc === 0;
  const [negUid, negGid] = negUser.split(':');
  const negLine = `step=negative rc=${neg.rc} uid=${negUid} gid=${negGid ?? ''} user=${negUser} target=${negPath} wrote=${negWrote ? 1 : 0}`
    + ` stderr=${JSON.stringify(firstLine(neg.stderr).slice(0, 300))}`;
  out(negLine);
  // 反向腿的读数**同时进 stderr**：#575② 2b 的口径是「反向腿 rc≠0 且失败读数里能看到那个错 uid」，
  // 而调用方（测试面 / 人手复跑）常常只留 stderr——只写 stdout 就等于让人翻两个流才能下结论。
  console.error(`${OUT_TAG} ${negLine}`);
  if (negWrote) {
    out(`verdict=BUG reason=negative_leg_wrote uid=${negUid} gid=${negGid ?? ''} uid_gid=${negUser} target=${negPath} dir=${dir}`);
    out('  ⇒ 反向腿没红：要么这个目录谁都能写（那正向腿的绿就不证明 userspace 有写权限），要么 --neg-user 选错了（比如 0:0 = root）。');
    exitCode = 1;
  } else if (!neg.stderr.includes(negPath)) {
    // 失败必须是「写这个路径」被挡，而不是 docker 自己起不动 / 目录不存在之类（那等于根本没测到本单）
    bail(`verdict=FAIL reason=negative_leg_wrong_failure uid=${negUid} gid=${negGid ?? ''} target=${negPath} rc=${neg.rc} stderr_not_naming_target=1`);
  } else {
    out(`step=negative_ok uid_gid=${negUser} target=${negPath} 反向腿按预期写不进去（rc=${neg.rc}）`);
    exitCode = 0;
  }
}

// ---------------------------------------------------------------------------
// 5. 清理：**正向腿写了才删**（反向腿没写成就不用删；它真写成了就必须删，那是异常形态的残留）。
//    清理结果打进输出，并用 `test -e` 复核——「我以为删了」与「真的没了」是两件事。
// ---------------------------------------------------------------------------
for (const [path, owned] of [[probePath, wroteProbe], [negPath, negWrote]]) {
  if (!owned) { out(`step=cleanup skipped path=${path} wrote=0`); continue; }
  const rm = docker(['exec', '--user', `${uid}:${gid}`, container, 'rm', '-f', path], { label: 'cleanup' });
  const check = docker(['exec', container, 'sh', '-c', `test -e ${path} && echo STILL_THERE || echo GONE`], { label: 'residue' });
  const residue = check.stdout.trim() === 'GONE' ? 'gone' : 'still_there';
  out(`step=cleanup rc=${rm.rc} path=${path} residue=${residue} check=${JSON.stringify(check.stdout.trim())}`);
  if (residue !== 'gone' && exitCode === 0) {
    out(`verdict=BUG reason=probe_left_behind path=${path} uid=${uid} gid=${gid}`);
    exitCode = 1;
  }
}

if (exitCode === 0) {
  out(`verdict=PASS container=${container} user=${user} uid=${uid} gid=${gid} dir=${dir} probe=${probePath} bytes=${wantBytes}`
    + ` neg_user=${negUser} neg_rc=${negRc}`);
} else {
  out(`verdict=FAIL_OR_BUG exit=${exitCode} container=${container} uid=${uid} gid=${gid} dir=${dir} neg_rc=${negRc ?? 'not-run'}`);
}
process.exit(exitCode);
