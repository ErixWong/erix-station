// 单测：#366 P0/P1 文件预览流式通道 + 未命中埋点。
// 流式（dirs.openFileStream）：牢笼与 JSON 预览同口径（复用 resolveJailedFile，这里抽查不重跑全表）、
// MIME 白名单（html 必须掉 octet-stream 防同源 XSS）、Range 三形态与 416、attachment 出口、
// 尺寸上限（>2MB JSON 上限但 ≤512MB 流式放行——大 PDF 的合法体积）。
// 埋点（previewmiss）：类别映射、扩展名归一、UPSERT 参数、读端聚合参数。
// 隔离约定：tmp userspace 注入 + 内联 fake pool，不碰真实环境。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openFileStream, parseSingleRange, streamMimeFor, FILE_STREAM_MAX_BYTES, DirError } from '../src/dirs.js';
import { missKindFor, normalizeExt, recordPreviewMiss, summarizePreviewMisses } from '../src/previewmiss.js';

function tmpUserspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-stream-'));
  const proj = path.join(root, 'alice', 'projects', 'proj1');
  fs.mkdirSync(path.join(proj, 'sub'), { recursive: true });
  return { root, proj };
}
const ARGS = { userSpaceRoot: '', fdeName: 'alice', cwd: '~/projects/proj1' };

/** 把 stream 读成 Buffer（小文件）。 */
async function drain(stream) {
  if (!stream) return Buffer.alloc(0);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

test('openFileStream：PDF → 200 + application/pdf + inline + 全量字节 + Accept-Ranges', async () => {
  const { root, proj } = tmpUserspace();
  try {
    const pdf = Buffer.from('%PDF-1.4\n%âãÏÓ\n'.repeat(100));
    fs.writeFileSync(path.join(proj, 'spec.pdf'), pdf);
    const r = await openFileStream({ ...ARGS, userSpaceRoot: root, relPath: 'spec.pdf' });
    assert.equal(r.status, 200);
    assert.equal(r.mime, 'application/pdf');
    assert.match(r.headers['Content-Disposition'], /^inline; filename="spec\.pdf"$/);
    assert.equal(r.headers['Content-Length'], String(pdf.length));
    assert.equal(r.headers['Accept-Ranges'], 'bytes');
    assert.equal((await drain(r.stream)).equals(pdf), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('openFileStream：>2MB（JSON 上限）但 <512MB → 流式放行（大 PDF 的合法体积）', async () => {
  const { root, proj } = tmpUserspace();
  try {
    fs.writeFileSync(path.join(proj, 'big.pdf'), Buffer.alloc(3 * 1024 * 1024, 7));
    const r = await openFileStream({ ...ARGS, userSpaceRoot: root, relPath: 'big.pdf' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Length'], String(3 * 1024 * 1024));
    await drain(r.stream);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('openFileStream：>512MB → 413 file_too_large（护栏存在）', async () => {
  const { root, proj } = tmpUserspace();
  try {
    // 稀疏文件：truncate 到上限+1 不占真盘。
    const f = path.join(proj, 'huge.bin');
    fs.writeFileSync(f, 'x');
    fs.truncateSync(f, FILE_STREAM_MAX_BYTES + 1);
    await assert.rejects(
      () => openFileStream({ ...ARGS, userSpaceRoot: root, relPath: 'huge.bin' }),
      (e) => e instanceof DirError && e.code === 'file_too_large' && e.httpStatus === 413,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('openFileStream：MIME 白名单——媒体命中，html/text 一律 octet-stream（同源 XSS 红线）', () => {
  assert.equal(streamMimeFor('a.pdf'), 'application/pdf');
  assert.equal(streamMimeFor('a.mp4'), 'video/mp4');
  assert.equal(streamMimeFor('a.png'), 'image/png'); // 图片白名单复用
  assert.equal(streamMimeFor('index.HTML'), 'application/octet-stream'); // 大写也不给 text/html
  assert.equal(streamMimeFor('notes.txt'), 'application/octet-stream'); // 文本走 JSON 通道，流式不惯着
  assert.equal(streamMimeFor('noext'), 'application/octet-stream');
});

test('openFileStream：未知类型（octet-stream）即使要 inline 也强制 attachment', async () => {
  const { root, proj } = tmpUserspace();
  try {
    fs.writeFileSync(path.join(proj, 'page.html'), '<script>alert(1)</script>');
    const r = await openFileStream({ ...ARGS, userSpaceRoot: root, relPath: 'page.html', disposition: 'inline' });
    assert.equal(r.mime, 'application/octet-stream');
    assert.match(r.headers['Content-Disposition'], /^attachment;/);
    await drain(r.stream); // 排空再删盘：createReadStream 未结就 rmSync 会炸异步尾巴
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('openFileStream：mode=download → attachment + 文件名净化（引号/分号/控制符）', async () => {
  const { root, proj } = tmpUserspace();
  try {
    fs.writeFileSync(path.join(proj, 'we"ird;name.txt'), 'x');
    const r = await openFileStream({ ...ARGS, userSpaceRoot: root, relPath: 'we"ird;name.txt', disposition: 'download' });
    assert.match(r.headers['Content-Disposition'], /^attachment; filename="we_ird_name\.txt"$/);
    await drain(r.stream);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseSingleRange：三形态 / 无 Range / 多 Range / 不可满足 的判据表', () => {
  assert.deepEqual(parseSingleRange('bytes=0-99', 1000), { status: 'ok', start: 0, end: 99 });
  assert.deepEqual(parseSingleRange('bytes=900-', 1000), { status: 'ok', start: 900, end: 999 });
  assert.deepEqual(parseSingleRange('bytes=-200', 1000), { status: 'ok', start: 800, end: 999 });
  assert.deepEqual(parseSingleRange('bytes=900-5000', 1000), { status: 'ok', start: 900, end: 999 }); // end 夹到文件尾
  assert.deepEqual(parseSingleRange(null, 1000), { status: 'none' });
  assert.deepEqual(parseSingleRange('bytes=0-1,10-11', 1000), { status: 'none' }); // 多 Range 降级整身
  assert.deepEqual(parseSingleRange('items=0-1', 1000), { status: 'none' });
  assert.deepEqual(parseSingleRange('bytes=-', 1000), { status: 'none' });
  assert.deepEqual(parseSingleRange('bytes=1000-', 1000), { status: 'unsatisfiable' }); // 起点 ≥ 大小
  assert.deepEqual(parseSingleRange('bytes=0-10', 0), { status: 'unsatisfiable' }); // 空文件
});

test('openFileStream：Range 命中 → 206 + Content-Range + 只发该段字节；不可满足 → 416 + bytes */size', async () => {
  const { root, proj } = tmpUserspace();
  try {
    fs.writeFileSync(path.join(proj, 'v.mp4'), Buffer.from('ABCDEFGHIJ')); // 10 字节
    const r = await openFileStream({ ...ARGS, userSpaceRoot: root, relPath: 'v.mp4', range: 'bytes=2-4' });
    assert.equal(r.status, 206);
    assert.equal(r.headers['Content-Range'], 'bytes 2-4/10');
    assert.equal(r.headers['Content-Length'], '3');
    assert.equal((await drain(r.stream)).toString(), 'CDE');

    const bad = await openFileStream({ ...ARGS, userSpaceRoot: root, relPath: 'v.mp4', range: 'bytes=99-' });
    assert.equal(bad.status, 416);
    assert.equal(bad.stream, null);
    assert.equal(bad.headers['Content-Range'], 'bytes */10');

    const none = await openFileStream({ ...ARGS, userSpaceRoot: root, relPath: 'v.mp4', range: 'garbage' });
    assert.equal(none.status, 200); // 非法格式 = 没发 Range（宽容降级）
    assert.equal(none.headers['Content-Length'], '10');
    await drain(none.stream);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('openFileStream：牢笼抽查（同 resolveJailedFile 红线）——symlink 段与 .. 逃逸都拒', async () => {
  const { root, proj } = tmpUserspace();
  try {
    fs.writeFileSync(path.join(root, 'alice', 'secret.pdf'), 'x');
    fs.symlinkSync(path.join(root, 'alice', 'secret.pdf'), path.join(proj, 'link.pdf'));
    for (const bad of ['link.pdf', '../secret.pdf', '']) {
      await assert.rejects(
        () => openFileStream({ ...ARGS, userSpaceRoot: root, relPath: bad }),
        (e) => e instanceof DirError,
        `应拒绝 ${JSON.stringify(bad)}`,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- 埋点：previewmiss ----

test('missKindFor：415→binary / 413→too_large / 其他错误不记', () => {
  assert.equal(missKindFor({ code: 'unsupported_file_type' }), 'binary');
  assert.equal(missKindFor({ code: 'file_too_large' }), 'too_large');
  assert.equal(missKindFor({ code: 'not_found' }), null);
  assert.equal(missKindFor(null), null);
});

test('normalizeExt：大小写归一 / 无扩展名 / 点开头文件 / 非法字符 / 超长截断', () => {
  assert.equal(normalizeExt('docs/Report.DOCX'), 'docx');
  assert.equal(normalizeExt('archive.tar.GZ'), 'gz');
  assert.equal(normalizeExt('Makefile'), '');
  assert.equal(normalizeExt('.gitignore'), ''); // 点开头算无扩展名族
  assert.equal(normalizeExt('we ird.x!@#y'), 'xy');
  assert.equal(normalizeExt('a.1234567890abcdefghij'), '1234567890abcdef'); // 16 字符截断
  assert.equal(normalizeExt(undefined), '');
});

test('recordPreviewMiss：UPSERT 主键三件套参数正确；写失败只吞不炸', async () => {
  const calls = [];
  const pool = { async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; } };
  await recordPreviewMiss({ pool, userId: 'u1', kind: 'binary', relPath: 'a/B.xlsx' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ON CONFLICT \(kind, ext, day\) DO UPDATE/);
  assert.deepEqual(calls[0].params, ['binary', 'xlsx', 'u1']);

  const warns = [];
  const boom = { query() { throw new Error('db down'); } };
  await recordPreviewMiss({ pool: boom, userId: 'u1', kind: 'too_large', relPath: 'x.pptx', log: { warn: (m) => warns.push(m) } });
  assert.equal(warns.length, 1); // 增强物口径：失败只 warn
});

test('summarizePreviewMisses：days 夹取（非法退 14，>365 退 14），聚合行转 Number(hits)', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push(params);
      return { rows: [{ kind: 'binary', ext: 'docx', hits: '42', last_seen_at: 'now' }] };
    },
  };
  const r = await summarizePreviewMisses({ pool, days: 30 });
  assert.deepEqual(calls[0], ['30']);
  assert.equal(r.days, 30);
  assert.deepEqual(r.items, [{ kind: 'binary', ext: 'docx', hits: 42, last_seen_at: 'now' }]);

  await summarizePreviewMisses({ pool, days: 'nan' });
  assert.deepEqual(calls[1], ['14']);
  await summarizePreviewMisses({ pool, days: 9999 });
  assert.deepEqual(calls[2], ['14']);
});
