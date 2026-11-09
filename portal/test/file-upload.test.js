// 单测：文件上传的落盘侧（issue #472 片 B）——`dirs.receiveUpload` / `dirs.resolveJailedDir` /
// `fsutil.writeTempFileFromStream` / `fsutil.commitTempFileNoClobber`。
// 覆盖工单判据 B-2..B-10、B-12（HTTP 面的 B-1/B-3 与闸门顺序在 `http-upload.test.js`）。
// 隔离约定（docs/testing.md §2.1）：tmp 目录注入 userSpaceRoot，真流（node:stream）当 body，不碰真实环境。
//
// ⚠ 属主类断言的环境边界（AGENTS §8 的「别拿本机恰好成立当结论」）：
//   非特权进程**不能**把属主改成自己的 uid 之外（fchown(2) 硬约束，`fsutil-chown.test.js` 已把这条
//   钉成判据）。所以本文件里「属主 = 注入值」用**当前进程真能设的值**（uid = 自身，gid = `id -G` 里
//   另一个所属组），保证「忘了传 gid」在非 root 环境也会红；「uid 真的来自 ctx.config.fdeUid」那一半
//   由 `http-upload.test.js` 直接断 `fchownSync` 的实参（环境无关）。root 环境则两个值都真断。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Readable } from 'node:stream';

import {
  DirError, fileTree, receiveUpload, resolveJailedDir, resolveJailedFile,
  UPLOAD_FILE_MODE, UPLOAD_NAME_MAX_BYTES,
} from '../src/dirs.js';
import { commitTempFileNoClobber, writeTempFileFromStream } from '../src/fsutil.js';

const SELF_UID = process.getuid?.() ?? 1000;
const SELF_GID = process.getgid?.() ?? 1000;
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

/**
 * 本进程**真的能设**的目标属组：非 root 只能 chgrp 到自己所属的组 ⇒ 从 `id -G` 里挑一个 != egid 的。
 * 挑不到（如 CI 上只有主组）⇒ 回退 egid，此时「摘掉 gid」的判据强度下降，由 `t.diagnostic` 说明，
 * 不静默少跑（同一族的先例：fsutil-chown.test.js 的 canSetGid）。
 */
function pickGidProbe(dir) {
  if (IS_ROOT) return 4321;
  const groups = execSync('id -G', { encoding: 'utf8' }).trim().split(/\s+/).map(Number)
    .filter((g) => Number.isFinite(g) && g !== SELF_GID);
  for (const gid of groups) {
    const probe = path.join(dir, `gid-probe-${gid}`);
    fs.writeFileSync(probe, '');
    try {
      fs.chownSync(probe, -1, gid);
      return gid;
    } catch {
      // 本进程不属于这个组（或内核不让）：换下一个候选。
    } finally {
      fs.rmSync(probe, { force: true });
    }
  }
  return SELF_GID;
}

/** 夹具：<root>/alice/projects/proj1（含 sub/ 子目录与 sub/deep/ 两层）。 */
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-upload-'));
  fs.mkdirSync(path.join(root, 'alice', 'projects', 'proj1', 'sub', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'alice', 'projects', 'empty'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, proj: path.join(root, 'alice', 'projects', 'proj1'), sub: path.join(root, 'alice', 'projects', 'proj1', 'sub') };
}

const BASE = { fdeName: 'alice', cwd: '~/projects/proj1' };

/** 把 Buffer 切成固定大小的 chunk 喂进流（chunk 边界与 maxBytes 判据有关，不能整块一次性给）。 */
function streamOf(buf, chunkSize = 4096) {
  const chunks = [];
  for (let i = 0; i < buf.length; i += chunkSize) chunks.push(buf.subarray(i, i + chunkSize));
  return Readable.from(chunks);
}

/** 手工控制的流：用例自己 push / 自己结束，用来在「temp 已打开、尚未提交」的窗口里插别的写方。 */
function manualStream() {
  const chunks = [];
  let ended = null;
  const stream = new Readable({ read() {} });
  return {
    stream,
    push(buf) { chunks.push(buf); },
    /** 先把挂起的 chunk 灌进去，再结束流（await 一个 tick 让 data 监听器真的跑完）。 */
    async finish() {
      for (const c of chunks.length ? chunks.splice(0) : []) stream.push(c);
      stream.push(null);
      await new Promise((r) => setImmediate(r));
    },
    async pump() {
      for (const c of chunks.splice(0)) stream.push(c);
      await new Promise((r) => setImmediate(r));
    },
    /** 断流：发一半就走人（`err` 给 ⇒ error 事件；不给 ⇒ 提前 close）。 */
    async abort(err = null) {
      stream.destroy(err ?? undefined);
      await new Promise((r) => setImmediate(r));
    },
  };
}

/** temp 残骸（`writeTempFile*` 留的形状：`<name>.<hex>.tmp` 与 `.upload-<hex>.tmp`）。 */
const remnants = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));

/**
 * **立刻**给 promise 挂上 settled 捕获（返回 `{ok}` / `{err}` 的 promise）。
 * 为什么必需：竞态/断流用例要在「拒绝发生」与「用例开始 await」之间插入一段自己的动作，
 * 而 Node 会把这段时间里的拒绝报成 `unhandledRejection` ⇒ 直接把用例判红（与本单无关的假红）。
 */
function settle(promise) {
  return promise.then((value) => ({ ok: value }), (error) => ({ error }));
}

async function expectDirError(promise, { code, httpStatus, field }) {
  const err = await promise.then(() => null, (e) => e);
  assert.ok(err instanceof DirError, `必须抛 DirError，实际 ${err === null ? '没有抛错' : err?.constructor?.name}`);
  assert.equal(err.code, code, `code 应为 ${code}，实际 ${err.code}（${err.message}）`);
  assert.equal(err.httpStatus, httpStatus, `httpStatus 应为 ${httpStatus}，实际 ${err.httpStatus}`);
  if (field !== undefined) {
    assert.equal(err.details?.field, field, `details.field 应为 ${field}，实际 ${JSON.stringify(err.details)}`);
  }
  return err;
}

// ---------------------------------------------------------------------------
// B-2 / B-10：正常路径逐字节；0 字节是合法文件
// ---------------------------------------------------------------------------

test('B-2 上传落盘与请求体逐字节相同（含 0x00 / 0xFF / 多字节 UTF-8），DTO = { path, bytes, overwritten:false }', async (t) => {
  const { root, proj } = fixture(t);
  const payload = Buffer.concat([
    Buffer.from('头部 '),
    Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7f, 0x80]),
    Buffer.from(' 你好，erix 🚀 结尾\n', 'utf8'),
  ]);
  const r = await receiveUpload({ ...BASE, userSpaceRoot: root, name: 'payload.bin', stream: streamOf(payload, 7) });
  assert.deepEqual(r, { path: 'payload.bin', bytes: payload.length, overwritten: false });
  const onDisk = fs.readFileSync(path.join(proj, 'payload.bin'));
  assert.equal(onDisk.length, payload.length, '落盘字节数必须等于请求体字节数（不被 UTF-8 解码/换行改写）');
  assert.deepEqual(Buffer.from(onDisk), payload, '必须逐字节相同');
  assert.deepEqual(remnants(proj), [], '成功路径不留 .tmp');
});

test('B-2 相对路径口径：path=<子目录> 时 DTO 的 path 带上前缀（与 fileTree/预览同一口径）', async (t) => {
  const { root, sub } = fixture(t);
  const r = await receiveUpload({ ...BASE, userSpaceRoot: root, relPath: 'sub', name: 'a.txt', stream: streamOf(Buffer.from('x')) });
  assert.equal(r.path, `sub${path.sep}a.txt`);
  assert.equal(fs.readFileSync(path.join(sub, 'a.txt'), 'utf8'), 'x');
});

// 复审 F1：分 chunk 的字节完整性（`writeTempFileFromStream` 的写法语义）
// ⚠ 这条**不是**「短写」的直接判据 —— 普通文件 + ext4 上没法确定性地逼出一次短写
// （所以 F1 的修法是把 API 换成内部循环写完的 `fs.writeFileSync(fd, …)`，与既有 `writeTempFile` 同一条路，
// 见 fsutil 里的注释）。这里钉的是同一处代码的**另一半风险**：多个 chunk 必须**接在后面**，
// 谁要是把每个 chunk 写到固定位置（或改成整块覆盖写），落盘就只有最后一块 ⇒ 这条红。
// 内容用二进制（0x00/0xFF）+ 三段不等长，避免「恰好一样长所以看不出丢了几十字节」这种漏网。
test('F1 分 chunk 落盘：三段不等长的字节全部接上（chunk 边界不吞不重），DTO.bytes = 收到总量', async (t) => {
  const { root, proj } = fixture(t);
  const parts = [
    Buffer.from([0x00, 0x01, 0xfe, 0xff]),
    Buffer.from('中文-第二段-多字节 utf8 — ', 'utf8'),
    Buffer.from([0xff, 0x00, 0x7f]),
  ];
  const want = Buffer.concat(parts);
  const ms = manualStream();
  const settled = settle(receiveUpload({ ...BASE, userSpaceRoot: root, name: 'chunks.bin', stream: ms.stream }));
  for (const part of parts) { ms.push(part); await ms.pump(); }
  await ms.finish();

  const { ok, error } = await settled;
  assert.equal(error, undefined, `不该报错：${error?.code} ${error?.message}`);
  assert.equal(ok.bytes, want.length, 'bytes 是「收到的字节数」');
  const onDisk = fs.readFileSync(path.join(proj, 'chunks.bin'));
  assert.deepEqual(Buffer.from(onDisk), want, `三段的顺序与内容必须都在盘上（实际 ${onDisk.length} 字节：${onDisk.toString('hex')}）`);
  assert.equal(onDisk.length, want.length, '长度相等是「不截断」的最低要求，内容也必须逐字节对');
  assert.deepEqual(remnants(proj), []);
});

test('B-10 零字节上传是合法文件 ⇒ 落一个 0 字节文件（不是 400，也不是不落盘）', async (t) => {
  const { root, proj } = fixture(t);
  const r = await receiveUpload({ ...BASE, userSpaceRoot: root, name: 'empty', stream: streamOf(Buffer.alloc(0)) });
  assert.deepEqual(r, { path: 'empty', bytes: 0, overwritten: false });
  const st = fs.statSync(path.join(proj, 'empty'));
  assert.equal(st.size, 0, '0 字节文件必须真的落盘（size 0）');
  assert.equal(st.mode & 0o777, UPLOAD_FILE_MODE);
});

// ---------------------------------------------------------------------------
// B-3：属主与 mode
// ---------------------------------------------------------------------------

test('B-3 落盘属主/属组 = 注入的 uid/gid（不是 portal 进程自己写死的形状），mode 0660', async (t) => {
  const { root, proj } = fixture(t);
  const gid = pickGidProbe(proj);
  const uid = IS_ROOT ? 4321 : SELF_UID;
  assert.notEqual(gid, SELF_GID, 'gid 探针必须挑到与进程 egid 不同的组，否则「摘掉 gid」的变异测不出来');
  assert.notEqual(fs.statSync(proj).gid, gid, '夹具目录本身的属组要不同，否则断言没有区分力');

  await receiveUpload({ ...BASE, userSpaceRoot: root, name: 'owner.txt', stream: streamOf(Buffer.from('x')), uid, gid });
  const st = fs.statSync(path.join(proj, 'owner.txt'));
  assert.equal(st.uid, uid, `属主必须等于注入的 uid=${uid}（只传 uid 不传 gid、或干脆不传，都会在这里红）`);
  assert.equal(st.gid, gid, `属组必须等于注入的 gid=${gid}（只传 uid 会留下 gid=${SELF_GID}/root 组 ⇒ agent 改不动）`);
  assert.equal(st.mode & 0o777, 0o660, 'mode 必须是 0660：属主可写 + 同组可写（user-space §6.2），不能是 0644');
  assert.deepEqual(remnants(proj), []);
  t.diagnostic(`环境：${IS_ROOT ? 'root（uid/gid 两半都真断）' : `非 root（uid 半边由 http-upload.test.js 的 fchown 实参断言兜，见文件头边界说明）`} uid=${uid} gid=${gid}（egid=${SELF_GID}）`);
});

// ---------------------------------------------------------------------------
// B-4 / B-5：no-clobber 与覆盖
// ---------------------------------------------------------------------------

test('B-4 目标已存在且未要求覆盖 ⇒ 409 file_exists，且原文件内容逐字节未变', async (t) => {
  const { root, proj } = fixture(t);
  const old = Buffer.from('原始内容——绝不能被一次失败的上传改掉\n');
  fs.writeFileSync(path.join(proj, 'note.txt'), old);
  const before = fs.readdirSync(proj).sort();

  await expectDirError(
    receiveUpload({ ...BASE, userSpaceRoot: root, name: 'note.txt', stream: streamOf(Buffer.from('新内容')) }),
    { code: 'file_exists', httpStatus: 409 },
  );
  assert.deepEqual(Buffer.from(fs.readFileSync(path.join(proj, 'note.txt'))), old, '409 之后原内容必须逐字节不变');
  assert.deepEqual(remnants(proj), [], '409 之前写过的 temp 必须清掉');
  assert.deepEqual(fs.readdirSync(proj).sort(), before, '409 不得在目录里留下任何额外条目');
});

test('B-5 overwrite=1 ⇒ overwritten:true 且目标内容真的变成新内容（旧内容消失）', async (t) => {
  const { root, proj } = fixture(t);
  const old = Buffer.from('OLD-CONTENT-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  fs.writeFileSync(path.join(proj, 'note.txt'), old);

  const fresh = Buffer.from('NEW-CONTENT-bbbbbbbbbbbbbbbbb');
  const r = await receiveUpload({ ...BASE, userSpaceRoot: root, name: 'note.txt', stream: streamOf(fresh), overwrite: true });
  assert.equal(r.overwritten, true, '覆盖必须回报 overwritten:true（HTTP 层据此回 200）');
  assert.equal(r.bytes, fresh.length);
  const onDisk = fs.readFileSync(path.join(proj, 'note.txt'));
  assert.deepEqual(Buffer.from(onDisk), fresh, '目标内容必须真的换成新内容');
  assert.ok(!onDisk.includes('OLD-CONTENT'), '旧内容必须消失（只断状态码的判据会放过「根本没覆盖」的实现）');
  assert.deepEqual(remnants(proj), []);
});

test('B-3 参数链：receiveUpload 把注入的 uid/gid **原样**交到 fchown（环境无关的那一半证据）', async (t) => {
  // 为什么需要这条：非 root 进程**设不了**任意 uid（`fsutil-chown.test.js` 已钉成判据），
  // 于是「只传 uid 不传 gid」这种漏在真落盘断言上可能看不出来。这里直接问内核之前的一步：
  // `writeTempFileFromStream` 到底给 `fchown` 递了什么。**只记录不吞真调用 ⇒ 行为不变**。
  const { root, proj } = fixture(t);
  const calls = [];
  const real = fs.fchownSync;
  fs.fchownSync = (fd, uid, gid) => { calls.push([uid, gid]); return real(fd, uid, gid); };
  try {
    await receiveUpload({ ...BASE, userSpaceRoot: root, name: 'chain.txt', stream: streamOf(Buffer.from('x')), uid: 12345, gid: 54321 });
  } catch (err) {
    // 非 root 环境下真 fchown 会 EPERM（内核约束）——参数已经记到了，断言不依赖它成功。
    assert.equal(err.code, 'EPERM', `非 root 环境 chown 到外部 uid 只能 EPERM，实际 ${err.code}: ${err.message}`);
  } finally {
    fs.fchownSync = real;
  }
  assert.equal(calls.length, 1, `必须恰调用一次 fchown，实际 ${calls.length} 次`);
  assert.deepEqual(calls[0], [12345, 54321], '必须同时传 uid 与 gid（-1 = 没传，会留下 root 组属组）');
  assert.ok(proj);
});

test('B-3 参数链：不传 uid/gid 时不去改属主（两者都没给 ⇒ 不调 fchown）', async (t) => {
  const { root, proj } = fixture(t);
  const calls = [];
  const real = fs.fchownSync;
  fs.fchownSync = (fd, uid, gid) => { calls.push([uid, gid]); return real(fd, uid, gid); };
  try {
    await receiveUpload({ ...BASE, userSpaceRoot: root, name: 'noowner.txt', stream: streamOf(Buffer.from('x')) });
  } finally {
    fs.fchownSync = real;
  }
  assert.deepEqual(calls, [], '两个都没传 ⇒ 不碰属主（与 fsutil.writeTempFile 同口径）');
  assert.equal(fs.statSync(path.join(proj, 'noowner.txt')).mode & 0o777, 0o660, '不传属主也要上 0660');
});

test('B-12 竞态：检查之后、提交之前目标被别人创建 ⇒ 不覆盖就是 409，且别人的内容一个字没动', async (t) => {
  const { root, proj } = fixture(t);
  const ms = manualStream();
  const settled = settle(receiveUpload({ ...BASE, userSpaceRoot: root, name: 'race.txt', stream: ms.stream }));
  ms.push(Buffer.from('MINE'));
  await ms.pump();
  // 此刻 temp 已打开、还没提交 —— agent（另一个写方）把目标建出来。
  const foreign = Buffer.from('AGENT-WROTE-THIS');
  fs.writeFileSync(path.join(proj, 'race.txt'), foreign);
  await ms.finish();

  const { ok, error } = await settled;
  assert.equal(ok, undefined, `竞态下必须报错，实际成功返回 ${JSON.stringify(ok)}`);
  assert.equal(error?.code, 'file_exists', `必须是 409 file_exists，实际 ${error?.code}`);
  assert.equal(error?.httpStatus, 409);
  assert.deepEqual(Buffer.from(fs.readFileSync(path.join(proj, 'race.txt'))), foreign,
    '别人的内容被静默替换 = no-clobber 失效（评审 blocker 4 的现场）');
  assert.deepEqual(remnants(proj), [], '竞态失败的 temp 必须清掉');
});

test('B-12 竞态（overwrite 语义）：同样窗口里别人建了目标 ⇒ 覆盖语义兑现（替换掉，而不是报错）', async (t) => {
  const { root, proj } = fixture(t);
  const ms = manualStream();
  const settled = settle(receiveUpload({ ...BASE, userSpaceRoot: root, name: 'race.txt', stream: ms.stream, overwrite: true }));
  ms.push(Buffer.from('MINE'));
  await ms.pump();
  fs.writeFileSync(path.join(proj, 'race.txt'), Buffer.from('AGENT-WROTE-THIS'));
  await ms.finish();

  const { ok, error } = await settled;
  assert.equal(error, undefined, `overwrite 分支不该报错：${error?.code}`);
  assert.equal(ok.overwritten, true);
  assert.equal(fs.readFileSync(path.join(proj, 'race.txt'), 'utf8'), 'MINE',
    'overwrite=1 的语义就是「我要它变成我的」；这条与上一条一起构成「绝不静默替换」的两侧');
  assert.deepEqual(remnants(proj), []);
});

// 复审 F3：overwrite 分支的 rename 失败映射（目标在 await 期间变成**目录**）
// 用户可触发：上传 X 的同时 agent 建了目录 X。`rename` 把普通文件换到目录上抛 EISDIR/ENOTEMPTY，
// 不接住就是 500（把「目标被占了」报成服务端故障）。映射后与 c 的语义同一个码：409 file_exists。
test('F3 overwrite 撞上「目标在传输期间变成目录」⇒ 409 file_exists（不是 500）+ 无 temp 残骸 + 目录没被碰', async (t) => {
  const { root, proj } = fixture(t);
  fs.writeFileSync(path.join(proj, 'note.txt'), 'OLD');   // 检查点：是个普通文件 ⇒ 允许覆盖
  const ms = manualStream();
  const settled = settle(receiveUpload({ ...BASE, userSpaceRoot: root, name: 'note.txt', stream: ms.stream, overwrite: true }));
  ms.push(Buffer.from('MINE'));
  await ms.pump();
  // await 期间（整条 body 的传输时长）agent 把它换成了目录
  fs.unlinkSync(path.join(proj, 'note.txt'));
  fs.mkdirSync(path.join(proj, 'note.txt'));
  fs.writeFileSync(path.join(proj, 'note.txt', 'inner.txt'), 'AGENT-DIR-INNER');
  await ms.finish();

  const { ok, error } = await settled;
  assert.equal(ok, undefined, `必须报错而不是假装成功，实际 ${JSON.stringify(ok)}`);
  assert.ok(error instanceof DirError, `必须是 DirError，实际 ${error?.constructor?.name}（${error?.code}）`);
  assert.equal(error.code, 'file_exists', `必须是 file_exists，实际 ${error.code}：${error.message}`);
  assert.equal(error.httpStatus, 409, `必须是 409（500 会把「目标被占」报成服务端故障），实际 ${error.httpStatus}`);
  assert.equal(error.details?.reason, 'target_is_dir', `details 要说明为什么覆盖不了，实际 ${JSON.stringify(error.details)}`);
  assert.equal(fs.readFileSync(path.join(proj, 'note.txt', 'inner.txt'), 'utf8'), 'AGENT-DIR-INNER',
    '别人的目录及其内容必须一个字没动');
  assert.deepEqual(remnants(proj), [], 'rename 失败的 temp 必须清掉（全函数不变量：任何失败路径不留 .tmp）');
});

test('B-12 fsutil.commitTempFileNoClobber：目标已存在 ⇒ 返回 false 且不抛、不留 temp、目标不变', (t) => {
  const { root, proj } = fixture(t);
  fs.writeFileSync(path.join(proj, 'x'), 'TARGET');
  const tmp = path.join(proj, 'tmp-payload');
  fs.writeFileSync(tmp, 'TMP');
  assert.equal(commitTempFileNoClobber(tmp, path.join(proj, 'x'), { root: proj }), false, '已存在 ⇒ false（不抛）');
  assert.equal(fs.readFileSync(path.join(proj, 'x'), 'utf8'), 'TARGET', 'false 分支绝不能碰到目标');
  assert.equal(fs.existsSync(tmp), false, 'false 分支也要清 temp');

  const free = path.join(proj, 'y');
  fs.writeFileSync(tmp, 'TMP2');
  assert.equal(commitTempFileNoClobber(tmp, free, { root: proj }), true, '不存在 ⇒ true 并提交');
  assert.equal(fs.readFileSync(free, 'utf8'), 'TMP2');
  assert.equal(fs.existsSync(tmp), false);
  assert.ok(root);
});

// ---------------------------------------------------------------------------
// B-6：name 形态
// ---------------------------------------------------------------------------

test('B-6 name 越界一律 400 + details.field=name（.. / 含斜杠 / 空 / NUL / 字节数超限）', async (t) => {
  const { root } = fixture(t);
  const bad = [
    ['..', '穿越'],
    ['.', '当前目录'],
    ['a/b', '带斜杠'],
    ['', '空名'],
    ['has\x00nul', 'NUL'],
    ['has\ttab', '控制符'],
    ['x'.repeat(UPLOAD_NAME_MAX_BYTES + 1), 'ASCII 超限 1 字节'],
    ['中'.repeat(86), '258 字节的中文名（字符数 86 看着没事）'],
    [null, 'null'],
    [undefined, '缺参数'],
    [42, '非字符串'],
  ];
  for (const [name, why] of bad) {
    await expectDirError(
      receiveUpload({ ...BASE, userSpaceRoot: root, name, stream: streamOf(Buffer.from('x')) }),
      { code: 'validation_failed', httpStatus: 400, field: 'name' },
    ).catch((e) => { e.message = `${why}（name=${JSON.stringify(String(name))}）: ${e.message}`; throw e; });
  }
});

test('B-6 name 边界：恰好 255 字节合法（含中文名），超限的判定按**字节**不是字符数', async (t) => {
  const { root, proj } = fixture(t);
  const ascii = 'x'.repeat(UPLOAD_NAME_MAX_BYTES);
  const cn = '中'.repeat(85); // 255 字节
  assert.equal(Buffer.byteLength(cn, 'utf8'), 255);
  for (const name of [ascii, cn]) {
    const r = await receiveUpload({ ...BASE, userSpaceRoot: root, name, stream: streamOf(Buffer.from('ok')) });
    assert.equal(r.name ?? r.path.split(path.sep).pop(), name);
    assert.equal(fs.readFileSync(path.join(proj, name), 'utf8'), 'ok');
  }
});

// ---------------------------------------------------------------------------
// B-7：与 resolveJailedFile 同口径 + 最终 symlink
// ---------------------------------------------------------------------------

/** 同一组夹具喂两个函数：把抛错收成可比较的形状（码 / 状态 / details.field）。 */
function shape(fn) {
  try {
    fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err?.code, httpStatus: err?.httpStatus, field: err?.details?.field };
  }
}

test('B-7① resolveJailedDir 与 resolveJailedFile 在同一组夹具上同口径（逐项相等）', async (t) => {
  const { root, proj } = fixture(t);
  fs.symlinkSync(path.join(root, 'alice', 'projects'), path.join(proj, 'link-out'));
  fs.mkdirSync(path.join(proj, 'sub', 'real'), { recursive: true });
  fs.symlinkSync(path.join(root, 'etc'), path.join(proj, 'sub', 'deep', 'ghost-link'));

  const cases = [
    { name: '逃逸：..', cwd: '~/projects/proj1', relPath: '..' },
    { name: '逃逸：../../..', cwd: '~/projects/proj1', relPath: 'sub/../../..' },
    { name: '绝对路径', cwd: '~/projects/proj1', relPath: '/etc' },
    { name: 'symlink 段', cwd: '~/projects/proj1', relPath: 'link-out/x' },
    { name: '末段是 symlink', cwd: '~/projects/proj1', relPath: 'link-out' },
    { name: '深层 symlink 段', cwd: '~/projects/proj1', relPath: 'sub/deep/ghost-link/x' },
    { name: '根不存在', cwd: '~/projects/ghost', relPath: 'x' },
    { name: '路径不存在', cwd: '~/projects/proj1', relPath: 'nope/x' },
    { name: 'cwd 形态非法（..）', cwd: '~/projects/..', relPath: 'x' },
    { name: 'cwd 形态非法（绝对）', cwd: '/etc/passwd', relPath: 'x' },
    { name: 'cwd 形态非法（多级）', cwd: '~/projects/a/b', relPath: 'x' },
  ];
  for (const c of cases) {
    const args = { userSpaceRoot: root, fdeName: 'alice', cwd: c.cwd, relPath: c.relPath };
    const asFile = shape(() => resolveJailedFile({ ...args, notFoundHint: 'file' }));
    const asDir = shape(() => resolveJailedDir({ ...args, notFoundHint: 'directory' }));
    assert.deepEqual(asDir, asFile, `${c.name}：两个函数的裁决必须一致（同一条红线只该有一份）`);
  }

  // 正向：具体目录两边裁决不同是**语义**（一个要文件一个要目录），但都得给出各自的正确答案。
  const dir = resolveJailedDir({ userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1', relPath: 'sub' });
  assert.equal(dir.dir, path.join(proj, 'sub'));
  const rootDir = resolveJailedDir({ userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1' });
  assert.equal(rootDir.dir, proj, "relPath 缺省 '.' ⇒ 项目根（上传到根是主路径）");
  assert.equal(shape(() => resolveJailedDir({ userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1', relPath: 'sub/nope' })).ok, false,
    '不存在的目录 ⇒ 404（不能拿一个不存在的路径去开 temp）');
  assert.deepEqual(
    shape(() => resolveJailedDir({ userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1', relPath: 'sub/real' })),
    { ok: true }, '存在的目录（含两层）应该通过');
});

test('B-7② 最终目标是 symlink ⇒ 400（overwrite 与否都拒），且 symlink 指向的文件未被改写', async (t) => {
  const { root, proj } = fixture(t);
  for (const overwrite of [false, true]) {
    const victim = path.join(root, 'victim.txt'); // jail 外的文件
    fs.writeFileSync(victim, 'OUTSIDE-ORIGINAL');
    const link = path.join(proj, 'link.txt');
    if (fs.existsSync(link)) fs.unlinkSync(link);
    fs.symlinkSync(victim, link);

    await expectDirError(
      receiveUpload({ ...BASE, userSpaceRoot: root, name: 'link.txt', stream: streamOf(Buffer.from('INJECTED')), overwrite }),
      { code: 'validation_failed', httpStatus: 400, field: 'name' },
    );
    assert.equal(fs.readFileSync(victim, 'utf8'), 'OUTSIDE-ORIGINAL',
      `overwrite=${overwrite}：被改写的必须是链接本身而不是它的指向（指向在 jail 外，写出去就是逃逸）`);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'symlink 本身不得被替换成普通文件');
    assert.deepEqual(remnants(proj), []);
    fs.unlinkSync(victim);
  }
});

// ---------------------------------------------------------------------------
// B-8 / B-9 / B-11：超限、目标是目录、断流
// ---------------------------------------------------------------------------

test('B-8 超过 maxBytes ⇒ 413 file_too_large + details.max_bytes，不落盘且无 .tmp 残留', async (t) => {
  const { root, proj } = fixture(t);
  const maxBytes = 1024;
  const err = await expectDirError(
    receiveUpload({ ...BASE, userSpaceRoot: root, name: 'big.bin', stream: streamOf(Buffer.alloc(4096, 7), 512), maxBytes }),
    { code: 'file_too_large', httpStatus: 413 },
  );
  assert.equal(err.details?.max_bytes, maxBytes, '413 要带上限（前端文案要用）');
  assert.equal(fs.existsSync(path.join(proj, 'big.bin')), false, '超限不得留下 target');
  assert.deepEqual(remnants(proj), [], '超限不得留下 .tmp（下一次上传不能被残骸挤掉）');
});

test('B-8 恰好等于 maxBytes 是合法的（判据是「超过」而不是「达到」）', async (t) => {
  const { root, proj } = fixture(t);
  const r = await receiveUpload({ ...BASE, userSpaceRoot: root, name: 'edge.bin', stream: streamOf(Buffer.alloc(1024, 7), 512), maxBytes: 1024 });
  assert.equal(r.bytes, 1024);
  assert.equal(fs.statSync(path.join(proj, 'edge.bin')).size, 1024);
});

test('B-9 目标是一个目录 ⇒ 400 且目录内容未变（不许拿文件盖目录）', async (t) => {
  const { root, proj } = fixture(t);
  const before = fs.readdirSync(path.join(proj, 'sub')).sort();
  await expectDirError(
    receiveUpload({ ...BASE, userSpaceRoot: root, name: 'sub', stream: streamOf(Buffer.from('x')) }),
    { code: 'validation_failed', httpStatus: 400, field: 'name' },
  );
  assert.deepEqual(fs.readdirSync(path.join(proj, 'sub')).sort(), before, '目录内容必须未变');
  assert.deepEqual(remnants(proj), []);
});

test('B-9 上传目标目录是一个文件 ⇒ 400（resolveJailedDir 的目录判据）', async (t) => {
  const { root, proj } = fixture(t);
  fs.writeFileSync(path.join(proj, 'afile.txt'), 'x');
  await expectDirError(
    receiveUpload({ ...BASE, userSpaceRoot: root, relPath: 'afile.txt', name: 'n.txt', stream: streamOf(Buffer.from('x')) }),
    { code: 'validation_failed', httpStatus: 400, field: 'path' },
  );
});

test('B-11 断流（发一半就 destroy 带错）⇒ upload_interrupted 400 + retryable，不落盘、无 .tmp 残留', async (t) => {
  const { root, proj } = fixture(t);
  const ms = manualStream();
  const settled = settle(receiveUpload({ ...BASE, userSpaceRoot: root, name: 'half.bin', stream: ms.stream }));
  ms.push(Buffer.from('first-half'));
  await ms.pump();
  await ms.abort(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

  const { ok, error: err } = await settled;
  assert.equal(ok, undefined, '断流不得当成功');
  assert.equal(err?.code, 'upload_interrupted');
  assert.equal(err?.httpStatus, 400);
  assert.equal(err.retryable, true, '断流是可重发的（docs/api/portal.md §1.2 的 retryable 列）');
  assert.equal(fs.existsSync(path.join(proj, 'half.bin')), false, '断流不得留下 target');
  assert.deepEqual(remnants(proj), [], '断流不得留下 .tmp（评审 major 12）');
});

test('B-11 断流的另一种形状：未 end 就 close（没有 error 事件）也算中断', async (t) => {
  const { root, proj } = fixture(t);
  const ms = manualStream();
  const settled = settle(receiveUpload({ ...BASE, userSpaceRoot: root, name: 'half2.bin', stream: ms.stream }));
  ms.push(Buffer.from('some'));
  await ms.pump();
  await ms.abort(); // destroy() 无错 ⇒ 只有 close
  const { ok, error } = await settled;
  assert.equal(ok, undefined);
  assert.equal(error?.code, 'upload_interrupted');
  assert.equal(fs.existsSync(path.join(proj, 'half2.bin')), false);
  assert.deepEqual(remnants(proj), []);
});

test('B-11 fsutil 层：超限时抛 upload_too_large 并带 bytes/maxBytes，且断流时抛 upload_interrupted', async (t) => {
  const { root, proj } = fixture(t);
  const over = await writeTempFileFromStream(path.join(proj, 'a'), streamOf(Buffer.alloc(2048, 1), 512), { maxBytes: 1000, root: proj })
    .then(() => null, (e) => e);
  assert.equal(over?.code, 'upload_too_large');
  assert.ok(over.bytes > over.maxBytes && over.maxBytes === 1000, `要带上 bytes/maxBytes，实际 ${over?.bytes}/${over?.maxBytes}`);
  assert.deepEqual(remnants(proj), []);

  const ms = manualStream();
  const settled = settle(writeTempFileFromStream(path.join(proj, 'b'), ms.stream, { maxBytes: 10_000, root: proj }));
  ms.push(Buffer.from('x'));
  await ms.pump();
  await ms.abort(new Error('EPIPE'));
  const { ok, error } = await settled;
  assert.equal(ok, undefined);
  assert.equal(error?.code, 'upload_interrupted');
  assert.deepEqual(remnants(proj), []);
  assert.ok(root);
});

// ---------------------------------------------------------------------------
// 其它：目录侧的入向能力（新文件出现在树里 = 前端 reload 的前提）
// ---------------------------------------------------------------------------

test('上传成功的文件出现在 fileTree 的列表里（前端 reload() 的前提）', async (t) => {
  const { root, proj } = fixture(t);
  await receiveUpload({ ...BASE, userSpaceRoot: root, relPath: 'sub', name: 'up.txt', stream: streamOf(Buffer.from('up')) });
  const tree = await fileTree({ userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1', relPath: 'sub' });
  assert.deepEqual(tree.entries, [{ name: 'deep', type: 'dir' }, { name: 'up.txt', type: 'file' }]);
  assert.ok(proj);
});

test('目录不存在 ⇒ 404 not_found（不为此收 body，也不 mkdir）', async (t) => {
  const { root } = fixture(t);
  await expectDirError(
    receiveUpload({ ...BASE, userSpaceRoot: root, relPath: 'ghost', name: 'x.txt', stream: streamOf(Buffer.from('x')) }),
    { code: 'not_found', httpStatus: 404 },
  );
  assert.equal(fs.existsSync(path.join(root, 'alice', 'projects', 'proj1', 'ghost')), false, '上传不许顺手建目录');
});

test('cwd 缺 fde_name / userSpaceRoot ⇒ 500 internal（配置缺失是服务端问题，不是用户错误）', async (t) => {
  const { root } = fixture(t);
  await expectDirError(
    receiveUpload({ userSpaceRoot: root, fdeName: null, cwd: '~/projects/proj1', name: 'x', stream: streamOf(Buffer.from('x')) }),
    { code: 'internal', httpStatus: 500 },
  );
});
