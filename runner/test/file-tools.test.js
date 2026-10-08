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

test('createJail：返回对象含 root 且等于传入根的 realpath', () =>
  withJail((jail, root) => {
    assert.equal(jail.root, fs.realpathSync(root));
    assert.equal(typeof jail.root, 'string');
    assert.ok(path.isAbsolute(jail.root));
  }));

test('tree：根标签统一为 ./（空目录，. 与 "" 与 ./ 输出一致）', () =>
  withJail(async (jail) => {
    const tools = createFileTools(jail);
    const fromDot = await tools.executors.tree({ path: '.' });
    const fromEmpty = await tools.executors.tree({ path: '' });
    const fromSlash = await tools.executors.tree({ path: './' });
    assert.equal(fromDot, './');
    assert.equal(fromEmpty, fromDot);
    assert.equal(fromSlash, fromDot);
  }));

test('tree：根标签统一为 ./（含文件目录，三者输出一致）', () =>
  withJail(async (jail, root) => {
    fs.mkdirSync(path.join(root, 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    fs.writeFileSync(path.join(root, 'b', 'c.txt'), 'y');
    const tools = createFileTools(jail);
    const expected = './\n  a.txt\n  b/\n    c.txt';
    const fromDot = await tools.executors.tree({ path: '.' });
    const fromEmpty = await tools.executors.tree({ path: '' });
    const fromSlash = await tools.executors.tree({ path: './' });
    assert.equal(fromDot, expected);
    assert.equal(fromEmpty, fromDot);
    assert.equal(fromSlash, fromDot);
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

// ---------------------------------------------------------------------------
// issue #211：file 工具接 abort signal。
// 中止检查点用「读 aborted 次数」的假 signal 驱动，不靠计时——同步遍历 + setImmediate 的
// 真实时序在 CI 上不稳定，而「走到第几个条目停住」是确定量，能把「真中断」与「只是入口
// 检查了一下」区分开。
// ---------------------------------------------------------------------------

/** 假 signal：第 flipsAfter 次读 aborted 起返回 true；reads 计数用于断言「走到哪儿才停」。 */
function scriptedSignal(flipsAfter) {
  const state = { reads: 0 };
  return {
    get aborted() { state.reads += 1; return state.reads > flipsAfter; },
    get reads() { return state.reads; },
    addEventListener() {}, removeEventListener() {},
  };
}

test('file 工具：已中止的 signal 一律不开工（readFile/writeFile/tree/rg 全入口拦截）', () =>
  withJail(async (jail, root) => {
    const ctrl = new AbortController();
    ctrl.abort();
    const tools = createFileTools(jail);
    await tools.executors.writeFile({ path: 'a.txt', content: 'x\n' }); // 先备一份可读文件
    const marker = path.join(root, 'created-by-write.txt');
    for (const [name, call] of [
      ['readFile', () => tools.executors.readFile({ path: 'a.txt' }, { signal: ctrl.signal })],
      ['writeFile', () => tools.executors.writeFile({ path: 'created-by-write.txt', content: 'y' }, { signal: ctrl.signal })],
      ['tree', () => tools.executors.tree({}, { signal: ctrl.signal })],
      ['rg', () => tools.executors.rg({ pattern: 'x' }, { signal: ctrl.signal })],
    ]) {
      await assert.rejects(() => call(), { name: "AbortError" }, `${name} 已中止时必须抛 AbortError`);
    }
    assert.equal(fs.existsSync(marker), false, '已中止的 writeFile 不该落盘');
  }));

test('file 工具 rg：遍历中途真中断（不是只在入口查一次）', () =>
  withJail(async (jail, root) => {
    // 200 个文件，每个都含 pattern：不中断必然扫完全场；ABORT_CHECKPOINT_EVERY=32 → 不中断约 7 次检查点
    for (let i = 0; i < 200; i += 1) {
      fs.writeFileSync(path.join(root, `f${String(i).padStart(3, '0')}.txt`), `match-${i}\n`);
    }
    const tools = createFileTools(jail);
    const signal = scriptedSignal(2); // 第 3 次读 aborted 起为真
    // maxResults 开到超过文件数：否则默认 50 条命中会让 rg 「因限流而停」，伪装成「因中止而停」。
    await assert.rejects(
      () => tools.executors.rg({ pattern: 'match-', maxResults: 1000 }, { signal }),
      { name: 'AbortError' },
    );
    // 入口那一查永远为 false（signal 此时未中止），所以「能 reject」本身就证明遍历中有检查点；
    // reads 小则证明它在中止点 immediate 收手，而不是把 200 个文件扫完才报。
    assert.ok(signal.reads <= 5,
      `rg 应在中止点立刻收手（reads=${signal.reads}）；若扫完全场会是 ~7 次检查点`);
  }));

test('file 工具 tree：宽目录遍历中途真中断', () =>
  withJail(async (jail, root) => {
    for (let i = 0; i < 200; i += 1) fs.mkdirSync(path.join(root, `d${String(i).padStart(3, '0')}`));
    const tools = createFileTools(jail);
    const signal = scriptedSignal(2);
    await assert.rejects(
      () => tools.executors.tree({ depth: 3 }, { signal }),
      { name: 'AbortError' },
    );
    assert.ok(signal.reads <= 5, `tree 应在中止点立刻收手（reads=${signal.reads}）`);
  }));

test('file 工具：不传 context / signal 未中止 → 行为与修前逐字一致（rg 命中、tree 结构、读写照旧）', () =>
  withJail(async (jail, root) => {
    fs.mkdirSync(path.join(root, 'pkg', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pkg', 'src', 'a.js'), 'const NEEDLE = 1;\n');
    const tools = createFileTools(jail);
    for (const ctx of [undefined, {}, { round: 2 }, { signal: new AbortController().signal }]) {
      const hit = await tools.executors.rg({ pattern: 'NEEDLE' }, ctx);
      assert.match(hit, /pkg\/src\/a\.js:1:const NEEDLE = 1;/, `context=${JSON.stringify(ctx)} rg 行为变了`);
      const tree = await tools.executors.tree({ path: 'pkg' }, ctx);
      assert.match(tree, /src\//, `context=${JSON.stringify(ctx)} tree 行为变了`);
      assert.match(await tools.executors.readFile({ path: 'pkg/src/a.js' }, ctx), /1: const NEEDLE = 1;/);
    }
    assert.equal(await tools.executors.writeFile({ path: 'pkg/b.txt', content: 'zz' }, {}), 2);
    assert.equal(fs.readFileSync(path.join(root, 'pkg', 'b.txt'), 'utf8'), 'zz');
  }));
