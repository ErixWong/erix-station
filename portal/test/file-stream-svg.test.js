// 单测：issue #771 —— .svg 不再走流式内联（管理台同源 XSS，MAJOR）。
// 判据两半：① SVG 是活动内容，流式通道必须 octet-stream + attachment
// （与 .html 同一条红线）；② 位图/PDF 不能被误伤（仍 inline），
// JSON 通道的 SVG 预览仍是 kind=image + data URL（前端 <img> 里脚本不执行）。
// 另断言 nosniff（#771 的纵深防御：防浏览器把 octet-stream 嗅探成可执行文档）。
// 隔离约定同 #366 那套：tmp userspace 注入，不碰真实环境。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openFileStream, readFilePreview, streamMimeFor } from '../src/dirs.js';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
const ARGS = { userSpaceRoot: '', fdeName: 'alice', cwd: '~/projects/proj1' };

function tmpUserspace(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-svg-'));
  const proj = path.join(root, 'alice', 'projects', 'proj1');
  fs.mkdirSync(proj, { recursive: true });
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(proj, name), data);
  return { root, proj };
}

/** 排空流：未结就 rmSync 会炸异步尾巴（同 file-stream-miss 的约定）。 */
async function drain(stream) {
  if (!stream) return;
  for await (const c of stream) void c;
}

const streamOf = (root, relPath, extra = {}) =>
  openFileStream({ ...ARGS, userSpaceRoot: root, relPath, ...extra });

test('#771 .svg stream → octet-stream + attachment + nosniff（不内联）', async () => {
  const { root } = tmpUserspace({ 'evil.svg': SVG });
  try {
    const r = await streamOf(root, 'evil.svg');
    assert.equal(r.status, 200);
    assert.equal(r.mime, 'application/octet-stream');
    assert.equal(r.headers['Content-Type'], 'application/octet-stream');
    assert.match(r.headers['Content-Disposition'], /^attachment; filename="evil\.svg"$/);
    assert.equal(r.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(streamMimeFor('evil.svg'), 'application/octet-stream');
    assert.equal(streamMimeFor('EVIL.SVG'), 'application/octet-stream'); // 大写同样不内联
    await drain(r.stream);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#771 .svg 即使被要求 inline 也强制 attachment（红线不看调用方）', async () => {
  const { root } = tmpUserspace({ 'x.svg': SVG });
  try {
    const r = await streamOf(root, 'x.svg', { disposition: 'inline' });
    assert.equal(r.headers['Content-Type'], 'application/octet-stream');
    assert.match(r.headers['Content-Disposition'], /^attachment;/);
    await drain(r.stream);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#771 位图仍 inline + 原 MIME（别一起降级）+ nosniff 全通道在', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const files = {
    'logo.png': png, 'a.jpg': 'j', 'a.jpeg': 'j', 'a.gif': 'g', 'a.webp': 'w', 'a.bmp': 'b',
  };
  const { root } = tmpUserspace(files);
  try {
    const r = await streamOf(root, 'logo.png');
    assert.equal(r.mime, 'image/png');
    assert.match(r.headers['Content-Disposition'], /^inline; filename="logo\.png"$/);
    assert.equal(r.headers['X-Content-Type-Options'], 'nosniff');
    await drain(r.stream);
    const table = [
      ['a.jpg', 'image/jpeg'], ['a.jpeg', 'image/jpeg'], ['a.gif', 'image/gif'],
      ['a.webp', 'image/webp'], ['a.bmp', 'image/bmp'],
    ];
    for (const [name, mime] of table) {
      const one = await streamOf(root, name);
      assert.equal(one.mime, mime, name);
      assert.match(one.headers['Content-Disposition'], /^inline;/, name);
      await drain(one.stream);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#771 .pdf 仍 inline + application/pdf（同样别误伤）', async () => {
  const { root } = tmpUserspace({ 'spec.pdf': '%PDF-1.4\n' });
  try {
    const r = await streamOf(root, 'spec.pdf');
    assert.equal(r.mime, 'application/pdf');
    assert.match(r.headers['Content-Disposition'], /^inline; filename="spec\.pdf"$/);
    await drain(r.stream);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#771 JSON 通道对 .svg 仍 kind=image + svg data URL（<img> 预览不坏）', async () => {
  const { root } = tmpUserspace({ 'logo.svg': SVG });
  try {
    const r = await readFilePreview({ ...ARGS, userSpaceRoot: root, relPath: 'logo.svg' });
    assert.equal(r.kind, 'image');
    assert.equal(r.name, 'logo.svg');
    assert.ok(r.data.startsWith('data:image/svg+xml;base64,'), r.data.slice(0, 40));
    const want = `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`;
    assert.equal(r.data, want);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
