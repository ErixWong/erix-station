// runner/lib/file-tools.js 单测：jail 路径边界（不变式：worker 无平台凭据、cwd 内可写）+ 文件工具行为。
//
// issue #228 迁移说明：本文件原有 15 个用例一条没删，全部按**新语义等价改写**（工具面与返回形态的
// 变化见 AGENTS.md §8.9 的「语义变更清单」）。三条主线：
//   * `rg` 退役 → 规范入口 `searchText`（`mode` 必填、无默认），返回 `{content, metadata}`；
//   * 越界 / 非可写 / 遮蔽路径：旧形态是 **抛 JailError**，新形态是上游统一的
//     「错误：读取|写入被宿主边界拒绝：…」**文本结果**（jail 仍在内部抛，被谓词转成布尔）；
//   * 遍历内中止：旧形态靠本仓库自己的让出点，新形态靠上游 checkpoint——用例相应升级为
//     「真 signal 在遍历中途抛出真 AbortError」（issue #211 的意图不变、保证更强）。
// jail 自身的 4 条用例（#1/#4/#9/#10/#11 的 jail 断言面）逐字不动：createJail / JailError 没迁。
// 隔离约定：tmp 目录作 jail root，不碰真实环境。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJail, createStationFileTools, JailError } from '../lib/file-tools.js';

/** 用 tmp 目录做 jail root，工具面走 station 装配（issue #228 后的唯一实现）。 */
async function withTools(fn, { writable } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-jail-test-'));
  const root = fs.realpathSync(dir);
  try {
    const jail = createJail({ root, writable: writable ?? [root] });
    return await fn(createStationFileTools({ jail, cwd: root }), root);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 只建 jail（不装配工具）的用例用。 */
async function withJail(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-jail-test-'));
  const root = fs.realpathSync(dir);
  try {
    return await fn(createJail({ root, writable: [root] }), root);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
  withTools(async (tools) => {
    const bytes = await tools.executors.writeFile({ path: 'sub/a.txt', content: 'l1\nl2\nl3\n' });
    assert.equal(bytes, 9);
    const text = await tools.executors.readFile({ path: 'sub/a.txt' });
    assert.equal(text, '1: l1\n2: l2\n3: l3');
    // offset/limit 窗口 + 续读提示：行号与「共 N 行」口径不变（erix-agent #196 R1.1 把纯状态文本
    // 升级成「剩余行数 + 下一步参数」，所以 marker 字面量比 fork 时代长——刻意，不是回归）。
    const win = await tools.executors.readFile({ path: 'sub/a.txt', offset: 1, limit: 1 });
    assert.equal(win, '2: l2\n[共 3 行，剩余 1 行；下一步：readFile 传 offset=2 继续]');
  }));

test('tree：目录树带深度限制', () =>
  withTools(async (tools, root) => {
    fs.mkdirSync(path.join(root, 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    fs.writeFileSync(path.join(root, 'b', 'c.txt'), 'y');
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

test('tree：根标签 ./（空目录）——issue #228 语义变更：只有 "." 与缺省给 ./，""/"./" 给目录名', () =>
  withTools(async (tools, root) => {
    // fork 时代 ''/'./'/'' 三者都归一成 './'（issue #64 的修复）。上游 createFileTools 只对
    // treePath === "." 给 "."，其它写法回落到 path.basename(解析结果)——即 '' 与 './' 现在显示
    // 工作目录名。语义变更已单列清单交主 agent 裁决；这里保留原用例的意图（根标签稳定）并钉住新口径。
    const fromDefault = await tools.executors.tree({});
    const fromDot = await tools.executors.tree({ path: '.' });
    assert.equal(fromDot, './');
    assert.equal(fromDefault, './');
    assert.equal(await tools.executors.tree({ path: '' }), `${path.basename(root)}/`);
    assert.equal(await tools.executors.tree({ path: './' }), `${path.basename(root)}/`);
  }));

test('tree：根标签 ./（含文件目录）——三者输出一致的旧断言改为按新口径分别钉', () =>
  withTools(async (tools, root) => {
    fs.mkdirSync(path.join(root, 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    fs.writeFileSync(path.join(root, 'b', 'c.txt'), 'y');
    const expected = './\n  a.txt\n  b/\n    c.txt';
    assert.equal(await tools.executors.tree({ path: '.' }), expected);
    assert.equal(await tools.executors.tree({}), expected);
    const labeled = `${path.basename(root)}/\n  a.txt\n  b/\n    c.txt`;
    assert.equal(await tools.executors.tree({ path: '' }), labeled);
    assert.equal(await tools.executors.tree({ path: './' }), labeled);
  }));

test('searchText（原 rg 用例）：正则命中——mode 显式 + 返回 {content, metadata}', () =>
  withTools(async (tools, root) => {
    fs.writeFileSync(path.join(root, 'x.txt'), 'foo bar\nbaz\nfoo twice\n');
    const result = await tools.executors.searchText({ pattern: 'foo', path: '.', mode: 'regex' });
    // 返回形态从 string 变成 {content, metadata}：模型可见文本在 content 里，逐条命中格式不变。
    assert.match(result.content, /x\.txt:1:foo bar/);
    assert.match(result.content, /x\.txt:3:foo twice/);
    assert.doesNotMatch(result.content, /baz/);
    assert.equal(result.metadata.searchHits, 2);
    assert.equal(result.metadata.searchTruncated, false);
  }));

test('readFile 越界：读 jail 外文件被挡（不泄露宿主机内容）——issue #228 后是错误文本而非抛', async () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'erix-jail-outside-')));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top-secret-outside');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-jail-test-'));
  try {
    const root = fs.realpathSync(dir);
    const tools = createStationFileTools({ jail: createJail({ root, writable: [root] }), cwd: root });
    const read = await tools.executors.readFile({ path: `../${path.basename(outside)}/secret.txt` });
    // 旧断言：assert.rejects(..., JailError)。新语义：谓词把 jail 拒绝转成布尔，上游回错误文本
    // （引擎把它当正常结果喂回模型，模型能自证并改路径；抛异常反而会变成一轮 is_error 噪声）。
    assert.match(String(read), /^错误：读取被宿主边界拒绝/u);
    assert.doesNotMatch(String(read), /top-secret-outside/u, '被挡的同时不得读穿一个字节');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('jail 边界（F7）：root 外 symlink 读写被拒——realpath 逃逸不泄露宿主机内容', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-jail-outside-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-jail-test-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top-secret');
    // root 内 symlink 指向 root 外文件
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link-out'));
    const jail = createJail({ root: dir, writable: [dir] });
    // ① jail 谓词本身仍抛 JailError（createJail 行为逐字未动）
    assert.throws(() => jail.assertReadable('link-out'), (e) => e instanceof JailError && e.code === 'path_escapes_root');
    assert.throws(() => jail.resolveForWrite('link-out'), (e) => e instanceof JailError && e.code === 'path_escapes_root');
    // ② 工具面拿到的是错误文本结果（issue #228 语义变更：文本而非 reject）
    const tools = createStationFileTools({ jail, cwd: fs.realpathSync(dir) });
    assert.match(String(await tools.executors.readFile({ path: 'link-out' })),
      /^错误：读取被宿主边界拒绝/u);
    assert.match(String(await tools.executors.writeFile({ path: 'link-out', content: 'pwned' })),
      /^错误：写入被宿主边界拒绝/u);
    // 拒绝的同时不得读穿：外部文件内容未被改写
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'top-secret');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jail 边界（F7）：root 内非 writable 子树写入被拒（path_not_writable），writable 子树正常', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-jail-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'w'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'ro'), { recursive: true });
    const jail = createJail({ root: dir, writable: [path.join(dir, 'w')] });
    const tools = createStationFileTools({ jail, cwd: fs.realpathSync(dir) });
    // writable 子树内写成功
    const ok = await tools.executors.writeFile({ path: 'w/a.txt', content: 'hi' });
    assert.equal(ok, 2);
    // root 内但不在 writable 子树 → 拒（jail 仍抛，工具面回错误文本；旧断言是 assert.rejects）
    assert.throws(() => jail.resolveForWrite('ro/b.txt'), (e) => e instanceof JailError && e.code === 'path_not_writable');
    assert.match(String(await tools.executors.writeFile({ path: 'ro/b.txt', content: 'nope' })),
      /^错误：写入被宿主边界拒绝/u);
    assert.ok(!fs.existsSync(path.join(dir, 'ro', 'b.txt')), '被拒写不得落盘');
    // 非 writable 子树仍可读（读边界不受 writable 限制）
    fs.writeFileSync(path.join(dir, 'ro', 'c.txt'), 'readable');
    assert.match(await tools.executors.readFile({ path: 'ro/c.txt' }), /1: readable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jail 边界（F7）：root 内 symlink 正常访问（realpath 仍在笼内）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-jail-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub', 'real.txt'), 'inside');
    fs.symlinkSync(path.join(dir, 'sub', 'real.txt'), path.join(dir, 'alias.txt'));
    const tools = createStationFileTools({ jail: createJail({ root: dir, writable: [dir] }), cwd: fs.realpathSync(dir) });
    assert.match(await tools.executors.readFile({ path: 'alias.txt' }), /1: inside/);
    // 经 symlink 写：realpath 解析回 root 内 → 允许
    await tools.executors.writeFile({ path: 'alias.txt', content: 'updated' });
    assert.equal(fs.readFileSync(path.join(dir, 'sub', 'real.txt'), 'utf8'), 'updated');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// issue #211：file 工具接 abort signal。
// 两层判据都要保住：
//   * 「假 signal + 读 aborted 计数」的确定性用例——把「真中断」与「只是入口查了一下」区分开
//     （计时在 CI 上不稳，「走到第几个条目停住」是确定量）；
//   * issue #228 之后新增的真 signal 用例——上游遍历内每 32 项让出 + 查中止，所以拿真实
//     AbortController 也能在**遍历中途**抛出真 AbortError（fork 时代这条只对 tree/rg 成立，
//     且靠的是本仓库自己的让出点）。
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

test('file 工具：已中止的 signal 一律不开工（readFile/writeFile/edit/tree/searchText 全入口拦截）', () =>
  withTools(async (tools, root) => {
    await tools.executors.writeFile({ path: 'a.txt', content: 'x\n' }); // 先备一份可读文件
    const marker = path.join(root, 'created-by-write.txt');
    const controller = new AbortController();
    controller.abort();
    const calls = [
      ['readFile', { path: 'a.txt' }],
      ['writeFile', { path: 'created-by-write.txt', content: 'y' }],
      ['edit', { path: 'a.txt', edits: [{ oldText: 'x', newText: 'z' }] }],
      ['tree', { path: '.' }],
      ['searchText', { pattern: 'x', mode: 'literal' }],
    ];
    for (const [name, input] of calls) {
      await assert.rejects(() => tools.executors[name](input, { signal: controller.signal }),
        { name: 'AbortError' }, `${name} 已中止时必须抛 AbortError`);
    }
    assert.equal(fs.existsSync(marker), false, '已中止的 writeFile 不该落盘');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'x\n', '已中止的 edit 不该落盘');
  }));

test('file 工具 searchText：遍历中途真中断（假 signal 确定量：不是只在入口查一次）', () =>
  withTools(async (tools, root) => {
    // 200 个文件、pattern 一条都不命中：既不会「因命中上限而停」（默认 50 条会伪装成中断），
    // 也不会因空目录而秒回——唯一能让它早停的就是中止检查点。
    for (let i = 0; i < 200; i += 1) {
      fs.writeFileSync(path.join(root, `f${String(i).padStart(3, '0')}.txt`), `filler-${i}\n`);
    }
    const signal = scriptedSignal(2); // 第 3 次读 aborted 起为真
    await assert.rejects(
      () => tools.executors.searchText({ pattern: 'no-such-needle', mode: 'literal' }, { signal }),
      { name: 'AbortError' },
    );
    // 入口那一查永远为 false（signal 此时未中止），所以「能 reject」本身就证明遍历中有检查点；
    // reads 小则证明它在中止点 immediate 收手，而不是把 200 个文件扫完才报（扫完约 7 个检查点）。
    assert.ok(signal.reads <= 5,
      `searchText 应在中止点立刻收手（reads=${signal.reads}）；若扫完全场会是 ~7 次检查点`);
  }));

test('file 工具 searchText：真 AbortController 能在遍历中途打断（issue #211 意图 + issue #228 升级）', () =>
  withTools(async (tools, root) => {
    // 3000 个条目的遍历在上游口径里是几十毫秒量级（实测 24k 条目 ≈ 485ms），足够让一个
    // 2ms 的定时器在两轮 checkpoint 让出之间落地——这就是「同步遍历期间 MSG.ABORT 处理器
    // 真的有机会执行」这条 issue #211 的核心不变式。
    for (let i = 0; i < 3000; i += 1) {
      fs.writeFileSync(path.join(root, `g${String(i).padStart(4, '0')}.txt`), 'filler\n');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2);
    const startedAt = Date.now();
    try {
      await assert.rejects(
        () => tools.executors.searchText({ pattern: 'no-such-needle', mode: 'literal' }, { signal: controller.signal }),
        { name: 'AbortError' },
      );
    } finally {
      clearTimeout(timer);
    }
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 2000, `遍历应在中止点收手，实测耗时 ${elapsed}ms`);
    // 对照组：同一棵树不传 signal 必然跑完（否则上面的「中断」毫无意义）
    const full = await tools.executors.searchText({ pattern: 'no-such-needle', mode: 'literal' }, {});
    assert.equal(full.metadata.searchHits, 0);
  }));

test('file 工具 tree：宽目录遍历中途真中断', () =>
  withTools(async (tools, root) => {
    for (let i = 0; i < 200; i += 1) fs.mkdirSync(path.join(root, `d${String(i).padStart(3, '0')}`));
    const signal = scriptedSignal(2);
    await assert.rejects(
      () => tools.executors.tree({ depth: 3 }, { signal }),
      { name: 'AbortError' },
    );
    assert.ok(signal.reads <= 5, `tree 应在中止点立刻收手（reads=${signal.reads}）`);
  }));

test('file 工具：不传 context / signal 未中止 → 行为逐字一致（searchText 命中、tree 结构、读写照旧）', () =>
  withTools(async (tools, root) => {
    fs.mkdirSync(path.join(root, 'pkg', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pkg', 'src', 'a.js'), 'const NEEDLE = 1;\n');
    for (const ctx of [undefined, {}, { round: 2 }, { signal: new AbortController().signal }]) {
      const hit = await tools.executors.searchText({ pattern: 'NEEDLE', mode: 'regex' }, ctx);
      assert.match(hit.content, /pkg\/src\/a\.js:1:const NEEDLE = 1;/, `context=${JSON.stringify(ctx)} searchText 行为变了`);
      const tree = await tools.executors.tree({ path: 'pkg' }, ctx);
      assert.match(tree, /src\//, `context=${JSON.stringify(ctx)} tree 行为变了`);
      assert.match(await tools.executors.readFile({ path: 'pkg/src/a.js' }, ctx), /1: const NEEDLE = 1;/);
    }
    assert.equal(await tools.executors.writeFile({ path: 'pkg/b.txt', content: 'zz' }, {}), 2);
    assert.equal(fs.readFileSync(path.join(root, 'pkg', 'b.txt'), 'utf8'), 'zz');
  }));

// ---------------------------------------------------------------------------
// issue #228 新增面：edit（station 工具面里的第二个写工具）必须吃同一个 jail 写边界。
// 上游契约（file-tools-contract.test.js）已经钉过 edit 的匹配语义与 allowWrite 谓词，这里只补
// jail 侧那半边：非 writable 子树里的 edit 必须被挡且不得落盘。
// ---------------------------------------------------------------------------

test('edit 吃 jail 写边界：非 writable 子树被拒且不改文件，writable 子树正常', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-jail-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'w'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'ro'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'w', 'a.txt'), 'alpha\n');
    fs.writeFileSync(path.join(dir, 'ro', 'b.txt'), 'beta\n');
    const tools = createStationFileTools({
      jail: createJail({ root: dir, writable: [path.join(dir, 'w')] }),
      cwd: fs.realpathSync(dir),
    });
    assert.match(String(await tools.executors.edit({ path: 'ro/b.txt', edits: [{ oldText: 'beta', newText: 'gamma' }] })),
      /^错误：写入被宿主边界拒绝/u);
    assert.equal(fs.readFileSync(path.join(dir, 'ro', 'b.txt'), 'utf8'), 'beta\n', '被拒的 edit 不得改文件');
    assert.match(String(await tools.executors.edit({ path: 'w/a.txt', edits: [{ oldText: 'alpha', newText: 'gamma' }] })),
      /已编辑/u);
    assert.equal(fs.readFileSync(path.join(dir, 'w', 'a.txt'), 'utf8'), 'gamma\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
