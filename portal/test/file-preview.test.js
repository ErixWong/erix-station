// 单测：dirs.js readFilePreview（P6 文件面板点击预览第一版，issue #84）——
// 牢笼逃逸防护（../ / 绝对路径 / symlink 段与 symlink 文件）、大小上限、文本/图片正常路径、
// 二进制拒绝。隔离约定（docs/testing.md §2.1）：tmp 目录注入 userSpaceRoot，不碰真实环境。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFilePreview, FILE_PREVIEW_MAX_BYTES, DirError } from '../src/dirs.js';

function tmpUserspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-file-'));
  const projects = path.join(root, 'alice', 'projects');
  const proj = path.join(projects, 'proj1');
  fs.mkdirSync(path.join(proj, 'sub'), { recursive: true });
  return { root, projects, proj };
}

const ARGS = { userSpaceRoot: '', fdeName: 'alice', cwd: '~/projects/proj1' };

test('readFilePreview：正常文本文件 → kind=text + utf8 内容 + 名字/相对路径', async () => {
  const { root, proj } = tmpUserspace();
  try {
    fs.writeFileSync(path.join(proj, 'sub', 'note.txt'), '你好，erix\n第二行');
    const r = await readFilePreview({ ...ARGS, userSpaceRoot: root, relPath: 'sub/note.txt' });
    assert.equal(r.kind, 'text');
    assert.equal(r.name, 'note.txt');
    assert.equal(r.path, `sub${path.sep}note.txt`);
    assert.equal(r.data, '你好，erix\n第二行');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readFilePreview：Markdown 按文本返回（前端复用 markdown.ts 渲染，后端不区分）', async () => {
  const { root, proj } = tmpUserspace();
  try {
    fs.writeFileSync(path.join(proj, 'README.md'), '# 标题\n\n正文 **粗体**');
    const r = await readFilePreview({ ...ARGS, userSpaceRoot: root, relPath: 'README.md' });
    assert.equal(r.kind, 'text');
    assert.equal(r.data, '# 标题\n\n正文 **粗体**');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readFilePreview：图片 → kind=image + data URL（base64，MIME 按扩展名）', async () => {
  const { root, proj } = tmpUserspace();
  try {
    // 最小合法 PNG 头即可（本测试只验证封装，不验证像素）。
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    fs.writeFileSync(path.join(proj, 'logo.png'), png);
    const r = await readFilePreview({ ...ARGS, userSpaceRoot: root, relPath: 'logo.png' });
    assert.equal(r.kind, 'image');
    assert.equal(r.data, `data:image/png;base64,${png.toString('base64')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readFilePreview：大小上限——超限 413 file_too_large（报错而非截断），边界内可读', async () => {
  const { root, proj } = tmpUserspace();
  try {
    fs.writeFileSync(path.join(proj, 'big.txt'), 'x'.repeat(FILE_PREVIEW_MAX_BYTES + 1));
    await assert.rejects(
      () => readFilePreview({ ...ARGS, userSpaceRoot: root, relPath: 'big.txt' }),
      (e) => e instanceof DirError && e.code === 'file_too_large' && e.httpStatus === 413,
    );
    fs.writeFileSync(path.join(proj, 'edge.txt'), 'x'.repeat(FILE_PREVIEW_MAX_BYTES));
    const r = await readFilePreview({ ...ARGS, userSpaceRoot: root, relPath: 'edge.txt' });
    assert.equal(r.data.length, FILE_PREVIEW_MAX_BYTES); // 恰好上限 = 可读
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readFilePreview：二进制（非图片，含 NUL）→ 415 unsupported_file_type 明确拒绝', async () => {
  const { root, proj } = tmpUserspace();
  try {
    const bin = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03]); // ELF 头
    fs.writeFileSync(path.join(proj, 'app'), bin);
    await assert.rejects(
      () => readFilePreview({ ...ARGS, userSpaceRoot: root, relPath: 'app' }),
      (e) => e.code === 'unsupported_file_type' && e.httpStatus === 415,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readFilePreview：牢笼逃逸——.. / 绝对路径 / 空 path → 400 validation_failed', async () => {
  const { root, proj } = tmpUserspace();
  try {
    fs.writeFileSync(path.join(proj, 'note.txt'), 'n');
    fs.writeFileSync(path.join(root, 'alice', 'secret.txt'), 'out-of-jail'); // jail 外文件
    for (const bad of ['..', '../secret.txt', 'sub/../../alice/secret.txt', '/etc/passwd', '', '.', 123]) {
      await assert.rejects(
        () => readFilePreview({ ...ARGS, userSpaceRoot: root, relPath: bad }),
        (e) => e instanceof DirError && e.code === 'validation_failed' && e.httpStatus === 400,
        `应拒绝 path=${JSON.stringify(bad)}`,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readFilePreview：symlink 文件与 symlink 段 → 400（防 bind mount 内自建链接泄漏 jail 外）', async () => {
  const { root, proj, projects } = tmpUserspace();
  try {
    fs.writeFileSync(path.join(proj, 'note.txt'), 'n');
    fs.writeFileSync(path.join(projects, 'outside.txt'), 'out');
    // symlink 文件（指向 jail 外）→ 拒绝。
    fs.symlinkSync(path.join(projects, 'outside.txt'), path.join(proj, 'link-file'));
    await assert.rejects(
      () => readFilePreview({ ...ARGS, userSpaceRoot: root, relPath: 'link-file' }),
      (e) => e.code === 'validation_failed' && e.httpStatus === 400,
    );
    // symlink 目录段（路径中间）→ 拒绝。
    fs.symlinkSync(projects, path.join(proj, 'sub', 'escape'));
    await assert.rejects(
      () => readFilePreview({ ...ARGS, userSpaceRoot: root, relPath: 'sub/escape/outside.txt' }),
      (e) => e.code === 'validation_failed' && e.httpStatus === 400,
    );
    // 普通文件仍可读（误伤检查）。
    const r = await readFilePreview({ ...ARGS, userSpaceRoot: root, relPath: 'note.txt' });
    assert.equal(r.data, 'n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readFilePreview：目标不存在 → 404；目录/不存在项目 → 明确错误', async () => {
  const { root, proj } = tmpUserspace();
  try {
    await assert.rejects(
      () => readFilePreview({ ...ARGS, userSpaceRoot: root, relPath: 'nope.txt' }),
      (e) => e.code === 'not_found' && e.httpStatus === 404,
    );
    await assert.rejects(
      () => readFilePreview({ ...ARGS, userSpaceRoot: root, relPath: 'sub' }), // 目录不是文件
      (e) => e.code === 'validation_failed' && e.httpStatus === 400,
    );
    await assert.rejects(
      () => readFilePreview({ userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/ghost', relPath: 'a.txt' }),
      (e) => e.code === 'not_found' && e.httpStatus === 404,
    );
    await assert.rejects(
      () => readFilePreview({ userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/../x', relPath: 'a.txt' }),
      (e) => e.code === 'validation_failed' && e.httpStatus === 400,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
