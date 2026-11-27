// issue #575②：容器侧「用户自己的目录写得进吗」的**真机**判据面（驱动 `portal/integration/fde-userspace-write.mjs`）。
//
// 为什么这张文件必须存在（而不是在 `test/integration-e2e-preflight.test.js` 里加一格注入用例就收工）：
// 宿主预飞的 `present` 只承诺「当前**宿主**用户可穿越祖先 + 可读这个已知路径」，**不承诺可写**；而容器侧
// materializer 用的是**另一套 UID/GID**。于是「宿主全绿」与「容器里那个用户写得进」是两件事，后者只能
// 用真 `docker exec --user <真 uid>` 量出来。
//
// ⚠ 本文件的红线（#570 的教训，别再犯一次）：**这里不许用注入版冒充真机版**。
//   · 没有任何 `fsImpl` / 假 docker 桩：每一条读数都来自真 `docker` 子进程；
//   · 跑不了就 `t.skip` 并写出**实测到的那一条**（例：`docker info 退出码 1`），**不许**悄悄换成夹具；
//   · 「跑得了就必须真跑」= 前置满足时一条断言都不许跳（下面每条断言都直接读脚本的真读数）。
//
// 判据形状（与脚本头注释同一套口径）：正向腿 rc=0 且读数里有 uid/gid 与路径；反向腿（一个不属于该目录
// 属主的 uid）rc≠0 且 stderr 里能看到那个错 uid 与目标路径。反向腿还有**常驻自证**（U2）：把反向 uid
// 换成 root（写得进）⇒ 脚本必须红，否则「反向腿绿」只是「谁都能写」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'portal/integration/fde-userspace-write.mjs');

/**
 * 跑一条真命令并拿回退出码 + **两个流**。
 * 用 `spawnSync` 而不是 `execFileSync`：后者只把 stdout 返回（`stdio` 显式给了 pipe 之后，**成功路径上的
 * stderr 会整块丢掉**）——而本判据有一半（反向腿的 `Permission denied`）就长在 stderr 里，拿不到就等于
 * 判据自己闭了一只眼。退出码仍然只取自子进程，不拿文本当结论。
 */
function run(cmd, args, { input = null, env = null } = {}) {
  const opts = { encoding: 'utf8', timeout: 180_000, maxBuffer: 32 << 20 };
  if (input !== null) opts.input = input;
  if (env !== null) opts.env = env;
  const r = spawnSync(cmd, args, opts);
  const stderr = String(r.stderr ?? '');
  if (r.error) return { rc: 1, stdout: String(r.stdout ?? ''), stderr: `${stderr}\n${String(r.error.message ?? r.error)}` };
  const rc = typeof r.status === 'number' ? r.status : (r.signal ? 124 : 1);
  return { rc, stdout: String(r.stdout ?? ''), stderr: rc === 0 ? stderr : `${stderr}${r.signal ? `\n(信号 ${r.signal})` : ''}` };
}

const CONTAINER = (process.env.FDE_CONTAINER
  || (/^--container=(.+)$/.exec(process.argv.slice(2).join(' '))?.[1] ?? '')).trim();

/**
 * 前置：**先实测**再决定跑不跑（措辞与 `rootSkipIfReallyUnblocked` 同一口径：skip 必须带上实测到的那一条，
 * 不许写「本机大概没有 docker」）。
 * @returns {string|null} 可以跑 ⇒ 容器名；跑不了 ⇒ null（调用方必须已经 `t.skip` 并 return）
 */
function containerOrSkip(t, { needRunning = true } = {}) {
  const info = run('docker', ['info']);
  if (info.rc !== 0) {
    t.skip(`实测 docker info 退出码 ${info.rc}（${(info.stderr.split('\n').find((l) => l.trim() !== '') ?? '无 stderr').slice(0, 120)}）`
      + ' ⇒ 本机没有可用的 docker daemon，真机腿不可达（本文件不许拿注入版顶替，见文件头）');
    return null;
  }
  if (!CONTAINER) {
    t.skip('实测 FDE_CONTAINER 未设、命令行里也没有 `--container=<name>` ⇒ 无法选容器（本文件只认这两种写法：'
      + '分开两段的 `--container <name>` 是脚本的用法，别当这里也认）。容器清单以 DB 为真相，本判据不按 ^fde- 前缀猜容器（AGENTS §5「容器清单只从 DB 取」）');
    return null;
  }
  const inspect = run('docker', ['inspect', CONTAINER, '-f', '{{.State.Running}}']);
  if (inspect.rc !== 0) {
    t.skip(`实测 docker inspect ${CONTAINER} 退出码 ${inspect.rc}（${(inspect.stderr.split('\n').find((l) => l.trim() !== '') ?? '无 stderr').slice(0, 120)}）`
      + ' ⇒ 容器不存在，真机腿不可达');
    return null;
  }
  if (needRunning && inspect.stdout.trim() !== 'true') {
    t.skip(`实测 docker inspect ${CONTAINER} -> State.Running=${JSON.stringify(inspect.stdout.trim())} ⇒ 容器没在跑，真机腿不可达`);
    return null;
  }
  return CONTAINER;
}

test('#575② U1 真机腿：以容器内真 uid 往 /home/<user> 写探针 + 同 uid 回读 + 反向错 uid 必须失败', (t) => {
  const container = containerOrSkip(t);
  if (!container) return;
  const runScript = run('node', [SCRIPT, '--container', container]);
  const outAll = `${runScript.stdout}\n${runScript.stderr}`;
  // 判定只认退出码（摘要行只是给人看的）
  assert.equal(runScript.rc, 0, `正向腿必须 rc=0，实测 rc=${runScript.rc}\n${outAll.slice(-2500)}`);

  // ① uid/gid 是**现读**的，而且必须是 userspace（root 跑出来的「写得进」不是本单要的东西）
  const identity = /step=identity uid=(\d+) gid=(\d+) user=(\S+)/.exec(outAll);
  assert.ok(identity, `读数里必须有 step=identity 的 uid/gid/user：\n${outAll.slice(-2000)}`);
  const [, uid, gid, user] = identity;
  assert.notEqual(uid, '0', `正向腿的 uid 不许是 0（root）——那等于没测 userspace 写入：${identity[0]}`);
  assert.notEqual(user, 'root', `容器内用户不许是 root：${identity[0]}`);

  // ② 路径：探针必须落在**该用户自己的目录**里，且真的写了字节
  const target = /step=target dir=(\S+) probe=(\S+) bytes=(\d+)/.exec(outAll);
  assert.ok(target, `读数里必须有 step=target 的 dir/probe/bytes：\n${outAll.slice(-2000)}`);
  const [, dir, probe, bytes] = target;
  assert.equal(dir, `/home/${user}`, `默认目录必须是用户自己的 /home/<user>（实测 dir=${dir} user=${user}）`);
  assert.ok(probe.startsWith(`${dir}/`), `探针必须在目标目录里：probe=${probe} dir=${dir}`);
  assert.ok(Number(bytes) > 0, `探针正文必须非空（空文件会让「写得进」变成假绿）：bytes=${bytes}`);

  // ③ 正向腿三步：写、同 uid 回读逐字一致、属主就是那个 uid
  const write = /step=write rc=(\d+) uid=(\d+) gid=(\d+)/.exec(outAll);
  assert.ok(write && write[1] === '0' && write[2] === uid && write[3] === gid, `正向腿必须以 ${uid}:${gid} 真写进去：${write?.[0] ?? '缺 step=write'}`);
  const readback = new RegExp(`step=readback rc=0 uid=${uid} gid=${gid} match=(\\d+) bytes=(\\d+) want=(\\d+)`).exec(outAll);
  assert.ok(readback, `必须有同 uid 的回读读数（match/bytes/want）：\n${outAll.slice(-2000)}`);
  assert.equal(readback[1], '1', `同 uid 回读必须逐字一致（match=0 就是写得进读不回）：${readback[0]}`);
  assert.equal(readback[2], readback[3], `回读字节数必须等于写入字节数：${readback[0]}`);
  const stat = /step=stat rc=0 out="(\d+):(\d+) (\d+) \S+"/.exec(outAll);
  assert.ok(stat, `必须有 stat 读数（属主/模式/路径）：\n${outAll.slice(-2000)}`);
  assert.deepEqual([stat[1], stat[2]], [uid, gid], `探针属主必须是 ${uid}:${gid}，出现 0:0 就说明这条腿其实是 root 写的：${stat[0]}`);

  // ④ 反向腿：不属于该目录属主的 uid 必须**写不进去**，且失败读数点名错 uid 与目标路径
  const neg = /step=negative rc=(\d+) uid=(\d+) gid=(\d+) user=(\S+) target=(\S+) wrote=(\d+) stderr=(.*)/.exec(outAll);
  assert.ok(neg, `必须有 step=negative 的反向腿读数：\n${outAll.slice(-2000)}`);
  const [, negRc, negUid, negGid, , negTarget, negWrote] = neg;
  assert.notEqual(negRc, '0', `反向腿（uid=${negUid}:${negGid}）必须写不进去，实测 rc=${negRc}——反向腿是摆设`);
  assert.equal(negWrote, '0', `反向腿写了却 rc≠0 说不通：${neg[0]}`);
  assert.notEqual(negUid, uid, `反向腿的 uid 必须与正向腿不同（${negUid} vs ${uid}），否则两腿在测同一件事`);
  assert.ok(negTarget.startsWith(`${dir}/`), `反向腿必须打同一个目录（换目录就是换判据）：${negTarget}`);
  assert.ok(runScript.stderr.includes(negUid), `脚本的 **stderr** 里必须能看到那个错 uid（${negUid}）：${runScript.stderr.slice(-800)}`);
  assert.match(outAll, /Permission denied/, `反向腿的失败文案必须是权限被挡（别把 docker 起不动当成判据成立）：${neg[0]}`);
  assert.ok(outAll.includes(`step=negative_ok uid_gid=${negUid}:${negGid} target=${negTarget}`), '反向腿必须被脚本自己判成「按预期写不进去」');

  // ⑤ 清理：写了就得真删掉（`residue=gone` 是 `test -e` 复核过的，不是「我以为删了」）
  const cleanup = new RegExp(`step=cleanup rc=0 path=${probe.replace(/[.]/g, '\\.')} residue=(\\w+)`).exec(outAll);
  assert.ok(cleanup, `必须有正向腿探针的清理读数（residue 由容器内 test -e 复核）：\n${outAll.slice(-2000)}`);
  assert.equal(cleanup[1], 'gone', `探针必须真被删掉（residue=${cleanup[1]}）：${cleanup[0]}`);
  assert.match(outAll, /verdict=PASS container=\S+ user=\S+ uid=\d+ gid=\d+ dir=\S+ probe=\S+ bytes=\d+/, '脚本自己必须判 PASS');
});

test('#575② U2 反向腿不是摆设（常驻自证）：--neg-user 0:0（root，写得进）⇒ 脚本必须红', (t) => {
  // 这是 #575② 2c「反向腿自证」的固化形态：把反向 uid 换成 root ⇒ 那一腿真写得进 ⇒ 脚本必须喊
  // `reason=negative_leg_wrote` 并非零退出。若哪天有人把反向腿的判据改成恒真（或整棵目录 0o777），
  // 本格当场红——不用等人手工改脚本再改回来。
  const container = containerOrSkip(t);
  if (!container) return;
  const runScript = run('node', [SCRIPT, '--container', container, '--neg-user', '0:0', '--prefix', 'fde-userspace-write-selfproof']);
  const outAll = `${runScript.stdout}\n${runScript.stderr}`;
  assert.notEqual(runScript.rc, 0, `反向 uid 换成 root 后脚本必须红，实测 rc=${runScript.rc} ⇒ 反向腿是摆设\n${outAll.slice(-2000)}`);
  assert.match(outAll, /reason=negative_leg_wrote uid=0 gid=0/, `红的文案必须点名 root 写成事了（uid/gid + 路径）：${outAll.slice(-1500)}`);
  assert.match(outAll, /step=negative rc=0 uid=0 gid=0 .*wrote=1/, '必须能看到「root 那腿真写成了」的读数');
  // 自证自己也要清干净：root 写成的那个探针必须由脚本删掉
  const cleanup = /step=cleanup rc=0 path=(\S+) residue=(\w+)/g;
  const cleaned = [...outAll.matchAll(cleanup)].map((m) => [m[1], m[2]]);
  assert.ok(cleaned.length >= 2, `两条腿写了就得各有清理读数：${JSON.stringify(cleaned)}`);
  assert.ok(cleaned.every(([, residue]) => residue === 'gone'), `自证探针必须都删掉：${JSON.stringify(cleaned)}`);
  assert.ok(cleaned.some(([p]) => p.includes('fde-userspace-write-selfproof') && p.includes('-0-0')),
    `必须包含 root 那一腿写成的探针：${JSON.stringify(cleaned)}`);
});

test('#575② U3 没给容器名 ⇒ 退出码 3 并说出为什么不猜（这条不碰 docker，任何机器都必须跑）', (t) => {
  const env = { ...process.env, FDE_CONTAINER: '', FDE_USERSPACE_USER: '' };
  const bare = run('node', [SCRIPT], { env });
  assert.equal(bare.rc, 3, `未指定容器必须是退出码 3（与「判据不成立」的 1、「环境没起」的 4 分开），实测 ${bare.rc}\n${bare.stdout}\n${bare.stderr}`);
  assert.match(`${bare.stdout}${bare.stderr}`, /未指定 FDE_CONTAINER/, '必须给出那句话');
  assert.match(`${bare.stdout}${bare.stderr}`, /\^fde-/, '那句话必须说清「不按 ^fde- 前缀猜容器」（容器清单以 DB 为真相）');
  // 反向自证：它真的没去猜——脚本里一条列容器的 `docker ps` 都不许有（猜出来的容器会把判据打到别人身上）
  const src = readFileSync(SCRIPT, 'utf8');
  const guessing = src.split('\n').filter((l) => /\bdocker\b/.test(l) && (/'ps'|"ps"|\bdocker ps\b|--filter/.test(l)));
  assert.deepEqual(guessing, [], `脚本不许列容器（「挑第一个 fde- 容器」就是猜）：${guessing.join(' | ').slice(0, 300)}`);
  assert.match(src, /reason=no_container/, '未指定容器那条出口必须真的存在');
});
