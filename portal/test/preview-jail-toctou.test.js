// 单测：issue #726 —— 文件预览 jail 的 TOCTOU 修复。
// 缺陷：旧实现先 lstat 逐段校验字符串路径，再按【字符串路径】重开
// （createReadStream(target)/readFileSync(target)）；FDE 在两步之间用
// rename(2) 把已校验文件换成指向 jail 外的 symlink ⇒ portal（root）越狱读到
// 别人 ~/.git-credentials / 自己的 /proc/self/environ。
// 修复：校验对象与打开对象必须是同一个 fd —— open 后用 /proc/self/fd 反查
// fd 真实路径再做 containment。这些用例直接调 dirs.js 导出函数，不起 HTTP。
// 隔离约定：tmp userspace 注入，不碰真实环境。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openFileStream, readFilePreview, DirError } from '../src/dirs.js';

// /proc/self/fd 计数：readdirSync 会把自己那次打开的目录 fd 也数进去，但只要
// 每次调用都是「打开→同步关闭」，计数里这一项恒定；用「操作前后两次基线相等」
// 判有无泄漏，规避 fd 号复用导致的假阳（见各用例 warmup）。
function fdCount() {
  return fs.readdirSync('/proc/self/fd').length;
}

async function drain(stream) {
  if (!stream) return Buffer.alloc(0);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function jail(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-toctou-'));
  const projects = path.join(root, 'alice', 'projects');
  const proj = path.join(projects, 'proj1');
  fs.mkdirSync(proj, { recursive: true });
  return { root, projects, proj, opts };
}

// 越界判据：把 readlink 桩成 jail 外的绝对路径，模拟「open 跟随到的真实 inode
// 在 root 外」。containment 用 path.relative(root, real).startsWith('..') 拦下。
const OUTSIDE = '/etc/passwd'; // 绝对、在 root 外 ⇒ relative(root, OUTSIDE) 以 .. 开头

// 1) 越界拒读（核心判据）：openFileStream 抛 validation_failed，且没读任何字节。
test('#726 openFileStream：fd 真实路径越狱 ⇒ validation_failed，且未读任何字节', async (t) => {
  const { root, proj } = jail();
  try {
    fs.writeFileSync(path.join(proj, 'victim.bin'), 'ABCDEFGHIJ');
    // 桩：readlink 报「真实路径在 root 外」（rename→symlink 换出的后果）。
    const m = t.mock.method(fsp, 'readlink', async () => OUTSIDE);
    let returned;
    let err;
    try {
      returned = await openFileStream({
        userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1', relPath: 'victim.bin',
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof DirError, '应抛 DirError');
    assert.equal(err.code, 'validation_failed');
    assert.equal(err.httpStatus, 400);
    assert.equal(err.message, 'path 越出目录根，拒绝读取');
    assert.deepEqual(err.details, { field: 'path' });
    assert.ok(m.mock.callCount() >= 1, 'readlink 必须被调用（说明确实走了 fd 反查）');
    // 抛错前未创建 stream、未读任何字节：async 函数抛错 ⇒ 没有返回值。
    assert.equal(returned, undefined, '越狱被拒：不返回任何 stream（未读字节）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 2) 正常文件仍可流式：200 + 正确 Content-Length + 内容一致，读完后 fd 已关闭。
test('#726 openFileStream：真实文件仍可流式，读完后 fd 已关闭', async () => {
  const { root, proj } = jail();
  try {
    const pdf = Buffer.from('%PDF-1.4\n'.repeat(1000));
    fs.writeFileSync(path.join(proj, 'spec.pdf'), pdf);
    const ARGS = {
      userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1', relPath: 'spec.pdf',
    };
    // warmup：触发 libuv 线程池首次初始化（首个 async fs 会 +1 个常驻 fd），
    // 消除它对基线的干扰，使后面的「前后计数相等」判定干净。
    {
      const w = await openFileStream(ARGS);
      await drain(w.stream);
      await tick(40);
    }
    const base = fdCount();
    const r = await openFileStream(ARGS);
    assert.equal(r.status, 200);
    assert.equal(r.mime, 'application/pdf');
    assert.equal(r.headers['Content-Length'], String(pdf.length));
    const buf = await drain(r.stream);
    assert.equal(buf.equals(pdf), true, '读出内容与原文件逐字节一致');
    // autoClose 关掉 fd + 流 'close' 时 fh.close() 解除 FileHandle finalizer；
    // 排空并等待 'close' 落定后，进程内打开的 fd 数应回到基线（没泄漏）。
    await tick(60);
    assert.equal(fdCount(), base, '读完后 fd 已关闭（打开 fd 数回到基线）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 3) Range 仍工作：bytes=2-4 → 206 + Content-Range + 只发该段。
test('#726 openFileStream：Range 仍工作（206 + Content-Range + 只发该段字节）', async () => {
  const { root, proj } = jail();
  try {
    fs.writeFileSync(path.join(proj, 'v.mp4'), Buffer.from('ABCDEFGHIJ')); // 10 字节
    const r = await openFileStream({
      userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1',
      relPath: 'v.mp4', range: 'bytes=2-4',
    });
    assert.equal(r.status, 206);
    assert.equal(r.headers['Content-Range'], 'bytes 2-4/10');
    assert.equal(r.headers['Content-Length'], '3');
    assert.equal((await drain(r.stream)).toString(), 'CDE');
    // 不可满足仍是 416（不开流、不读）。
    const bad = await openFileStream({
      userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1',
      relPath: 'v.mp4', range: 'bytes=99-',
    });
    assert.equal(bad.status, 416);
    assert.equal(bad.stream, null);
    assert.equal(bad.headers['Content-Range'], 'bytes */10');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 4) .git 目录被拒（同单附带）：.git/config 400；同目录 .gitignore 仍可读。
test('#726 readFilePreview：.git 目录被拒 400；同名前缀 .gitignore 仍可读', async () => {
  const { root, proj } = jail();
  try {
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.git', 'config'), '[core]\n');
    fs.writeFileSync(path.join(proj, '.gitignore'), 'node_modules\n');
    const A = { userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1' };
    await assert.rejects(
      () => readFilePreview({ ...A, relPath: '.git/config' }),
      (e) => e instanceof DirError && e.code === 'validation_failed' && e.httpStatus === 400
        && e.message === 'path 不得进入 .git 目录' && e.details?.field === 'path',
    );
    const r = await readFilePreview({ ...A, relPath: '.gitignore' });
    assert.equal(r.kind, 'text');
    assert.equal(r.data, 'node_modules\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 5) readFilePreview 也走 fd 校验：readlink 越界 ⇒ 400 且未读到内容。
test('#726 readFilePreview：fd 真实路径越狱 ⇒ validation_failed，未读到内容', async (t) => {
  const { root, proj } = jail();
  try {
    fs.writeFileSync(path.join(proj, 'note.txt'), '你好，erix');
    const m = t.mock.method(fsp, 'readlink', async () => OUTSIDE);
    let returned;
    let err;
    try {
      returned = await readFilePreview({
        userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1', relPath: 'note.txt',
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof DirError, '应抛 DirError');
    assert.equal(err.code, 'validation_failed');
    assert.equal(err.httpStatus, 400);
    assert.equal(err.message, 'path 越出目录根，拒绝读取');
    assert.ok(m.mock.callCount() >= 1, 'readlink 被调用（readFilePreview 也经 openVerifiedFd）');
    assert.equal(returned?.data, undefined, '越狱被拒：未读到任何内容');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 6) rootKind:'projects'（管理台那条根）同样走 fd 校验：正常可读、越界被拒。
test('#726 rootKind:projects（管理台根）同样受 fd 校验保护：正常可读、越界被拒', async (t) => {
  const { root, proj } = jail();
  try {
    fs.writeFileSync(path.join(proj, 'a.bin'), 'ABCDEFGHIJ');
    const A = {
      userSpaceRoot: root, fdeName: 'alice', rootKind: 'projects', relPath: 'proj1/a.bin',
    };
    // 正常：projects 根下真实文件 → 200，内容一致。
    const ok = await openFileStream(A);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['Content-Length'], '10');
    assert.equal((await drain(ok.stream)).toString(), 'ABCDEFGHIJ');
    // 越界：桩 readlink 报 root 外 ⇒ 这条根也走 containment，被拒。
    const m = t.mock.method(fsp, 'readlink', async () => OUTSIDE);
    let err;
    let returned;
    try {
      returned = await openFileStream(A);
    } catch (e) {
      err = e;
    }
    assert.equal(err?.code, 'validation_failed');
    assert.equal(err?.message, 'path 越出目录根，拒绝读取');
    assert.ok(m.mock.callCount() >= 1, 'projects 根也经 openVerifiedFd 反查 fd');
    assert.equal(returned, undefined, '越狱被拒：未返回 stream');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
