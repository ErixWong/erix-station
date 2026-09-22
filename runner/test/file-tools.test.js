// runner/lib/file-tools.js 单测：jail 路径边界（不变式：worker 无平台凭据、cwd 内可写）+ 四工具行为。
// 隔离约定：tmp 目录作 jail root，不碰真实环境。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileTools, createJail, JailError } from '../lib/file-tools.js';

async function withJail(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-jail-test-'));
  try {
    return await fn(createJail({ root, writable: [root] }), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('jail：cwd 内可读可写，越界路径（../、绝对路径）抛 JailError', () =>
  withJail((jail, root) => {
    assert.equal(jail.resolve('.'), fs.realpathSync(root));
    assert.throws(() => jail.resolve('../escape'), JailError);
    assert.throws(() => jail.resolve('/etc/passwd'), JailError);
    assert.throws(() => jail.resolveForWrite('../escape'), JailError);
  }));

test('writeFile/readFile：往返保真 + 行号输出 + 目录自动创建', () =>
  withJail(async (jail) => {
    const tools = createFileTools(jail);
    const bytes = await tools.executors.writeFile({ path: 'sub/a.txt', content: 'l1\nl2\nl3\n' });
    assert.equal(bytes, 9);
    const text = await tools.executors.readFile({ path: 'sub/a.txt' });
    assert.equal(text, '1: l1\n2: l2\n3: l3');
    // offset/limit 窗口 + 续读提示
    const win = await tools.executors.readFile({ path: 'sub/a.txt', offset: 1, limit: 1 });
    assert.equal(win, '2: l2\n[共 3 行，offset=2 继续]');
  }));

test('tree：目录树带深度限制', () =>
  withJail(async (jail, root) => {
    fs.mkdirSync(path.join(root, 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    fs.writeFileSync(path.join(root, 'b', 'c.txt'), 'y');
    const tools = createFileTools(jail);
    const out = await tools.executors.tree({ path: '.', depth: 3 });
    assert.match(out, /a\.txt/);
    assert.match(out, /b\//);
    assert.match(out, /c\.txt/);
  }));

test('rg：正则命中', () =>
  withJail(async (jail, root) => {
    fs.writeFileSync(path.join(root, 'x.txt'), 'foo bar\nbaz\nfoo twice\n');
    const tools = createFileTools(jail);
    const out = await tools.executors.rg({ pattern: 'foo', path: '.' });
    assert.match(out, /x\.txt:1:foo bar/);
    assert.match(out, /x\.txt:3:foo twice/);
    assert.doesNotMatch(out, /baz/);
  }));

test('readFile 越界：读 jail 外文件 reject JailError（不泄露宿主机内容）', () =>
  withJail(async (jail) => {
    const tools = createFileTools(jail);
    await assert.rejects(
      () => tools.executors.readFile({ path: '../../etc/passwd' }),
      (e) => e instanceof JailError,
    );
  }));

test('jail 边界（F7）：root 外 symlink 读写被拒——realpath 逃逸不泄露宿主机内容', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-jail-outside-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-jail-test-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top-secret');
    // root 内 symlink 指向 root 外文件
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link-out'));
    const jail = createJail({ root, writable: [root] });
    const tools = createFileTools(jail);
    await assert.rejects(
      () => tools.executors.readFile({ path: 'link-out' }),
      (e) => e instanceof JailError && e.code === 'path_escapes_root',
    );
    await assert.rejects(
      () => tools.executors.writeFile({ path: 'link-out', content: 'pwned' }),
      (e) => e instanceof JailError && e.code === 'path_escapes_root',
    );
    // 拒绝的同时不得读穿：外部文件内容未被改写
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'top-secret');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('jail 边界（F7）：root 内非 writable 子树写入被拒（path_not_writable），writable 子树正常', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-jail-test-'));
  try {
    fs.mkdirSync(path.join(root, 'w'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ro'), { recursive: true });
    const jail = createJail({ root, writable: [path.join(root, 'w')] });
    const tools = createFileTools(jail);
    // writable 子树内写成功
    const ok = await tools.executors.writeFile({ path: 'w/a.txt', content: 'hi' });
    assert.equal(ok, 2);
    // root 内但不在 writable 子树 → 拒
    await assert.rejects(
      () => tools.executors.writeFile({ path: 'ro/b.txt', content: 'nope' }),
      (e) => e instanceof JailError && e.code === 'path_not_writable',
    );
    assert.ok(!fs.existsSync(path.join(root, 'ro', 'b.txt')), '被拒写不得落盘');
    // 非 writable 子树仍可读（读边界不受 writable 限制）
    fs.writeFileSync(path.join(root, 'ro', 'c.txt'), 'readable');
    assert.match(await tools.executors.readFile({ path: 'ro/c.txt' }), /1: readable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('jail 边界（F7）：root 内 symlink 正常访问（realpath 仍在笼内）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-jail-test-'));
  try {
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub', 'real.txt'), 'inside');
    fs.symlinkSync(path.join(root, 'sub', 'real.txt'), path.join(root, 'alias.txt'));
    const jail = createJail({ root, writable: [root] });
    const tools = createFileTools(jail);
    assert.match(await tools.executors.readFile({ path: 'alias.txt' }), /1: inside/);
    // 经 symlink 写：realpath 解析回 root 内 → 允许
    await tools.executors.writeFile({ path: 'alias.txt', content: 'updated' });
    assert.equal(fs.readFileSync(path.join(root, 'sub', 'real.txt'), 'utf8'), 'updated');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
