// runner/lib/file-tools.js 单测：jail 路径边界（不变式：worker 无平台凭据、cwd 内可写）+ 文件工具行为。
//
// issue #228 迁移说明：本文件原有 15 个用例一条没删，全部按**新语义等价改写**（工具面与返回形态的
// 变化见 AGENTS.md §8.9 的「语义变更清单」）。三条主线：
//   * `rg` 退役 → 规范入口 `searchText`（`mode` 必填、无默认），返回 `{content, metadata}`；
//   * 越界 / 非可写 / 遮蔽路径：旧形态是 **抛 JailError**，新形态是上游统一的
//     「错误：读取|写入被宿主边界拒绝：…」**文本结果**（jail 仍在内部抛，被谓词转成布尔）；
//   * 遍历内中止：旧形态靠本仓库自己的让出点，新形态靠上游 checkpoint——用例相应升级为
//     「真 signal 在遍历中途抛出真 AbortError」（issue #211 的意图不变、保证更强）。
//   * `tree` 根标签：**在装配层收口回 `./`**（issue #64 语义保住；#228 真机验收后的修复）——
//     上游只对 `path === "."` 给 `./`，而真机上模型会把 basename 标签拷回去再查一次并 ENOENT。
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
    // 0.19.0 又往同一行提示里加了「（文件 9B）」（上游 2026-10-13 并入项：「文件读取工具描述带上
    // 实测额度事实」，见 host-upgrade-guide-0.19.0 §6）⇒ 按包真值改这里的期望（不放宽：仍逐字节相等）。
    const win = await tools.executors.readFile({ path: 'sub/a.txt', offset: 1, limit: 1 });
    assert.equal(win, '2: l2\n[共 3 行（文件 9B），剩余 1 行；下一步：readFile 传 offset=2 继续]');
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

test('tree：根标签 ./（空目录）——五种根写法全部归一（#64 在装配层保住，#228 真机修复）', () =>
  withTools(async (tools, root) => {
    // fork 时代 ''/'./'/'.' /缺省 都归一成 './'（issue #64 的修复）；上游 createFileTools 只覆盖
    // `path === "."` 那一半，其它写法回落到工作目录 basename——真机上模型拷这个标签再查一次就 ENOENT
    // （#228 真机验收：tree{"path":"./"} → `hello-station/` → tree{"path":"hello-station/"} → ENOENT）。
    // station 在装配层把根标签收口回 `./`（只改根标签；上游侧已另行提单，上游修好后本收口可撤）。
    for (const value of [undefined, null, '', '.', './', './/', './.']) {
      const out = await tools.executors.tree(value === undefined ? {} : { path: value });
      assert.equal(String(out).split('\n')[0], './', `根写法 ${JSON.stringify(value)} 的根标签必须是 ./，实际：${String(out).split('\n')[0]}`);
    }
    // 绝对根路径（不是根写法，但解析后就是根）也要拿到 ./：走的是出口兜底那一道
    assert.equal(String(await tools.executors.tree({ path: root })).split('\n')[0], './');
    // 结构化调用形态（引擎侧形态）同样收口
    const structured = await tools.executeTool({ id: 't1', name: 'tree', input: { path: './' } });
    assert.equal(String(structured).split('\n')[0], './');
  }));

test('tree：根标签 ./（含文件目录）——写法无关，条目与 marker 逐字相同', () =>
  withTools(async (tools, root) => {
    fs.mkdirSync(path.join(root, 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    fs.writeFileSync(path.join(root, 'b', 'c.txt'), 'y');
    const expected = './\n  a.txt\n  b/\n    c.txt';
    for (const value of [undefined, '', '.', './']) {
      assert.equal(await tools.executors.tree(value === undefined ? {} : { path: value }), expected,
        `根写法 ${JSON.stringify(value)} 的输出与预期逐字不一致`);
    }
  }));

test('tree：只改根标签——条目/截断与排除 marker 一字不动（两种收口路径输出逐字相等）', () =>
  withTools(async (tools, root) => {
    // fixture 同时触发排除账 marker（vendor + 点目录），用来证明收口只动了首行。
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'deep', 'deeper', 'deepest'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'i.js'), 'x');
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'x');
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');

    const fromRootForm = await tools.executors.tree({ path: './', depth: 2 });
    const fromAbsolutePath = await tools.executors.tree({ path: root, depth: 2 });
    assert.equal(fromAbsolutePath, fromRootForm, '两种收口路径（入口归一 / 出口兜底）必须逐字相等');
    assert.equal(fromRootForm.split('\n')[0], './');
    assert.ok(fromRootForm.includes('\n  a.txt'), '条目原样保留');
    assert.ok(fromRootForm.includes('未展开'), 'depth 截断 marker 原样保留');
    assert.ok(fromRootForm.includes('已跳过'), '排除账 marker 原样保留');
    assert.ok(fromRootForm.includes('include_vendor=true'), 'marker 里的下一步提示原样保留');
    assert.equal(fromRootForm.split('\n').slice(1).join('\n'), fromAbsolutePath.split('\n').slice(1).join('\n'));
  }));

test('tree：真实子目录名不过度归一（sub / sub/ / 子路径均保留自己的标签）', () =>
  withTools(async (tools, root) => {
    fs.mkdirSync(path.join(root, 'sub', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'y');
    fs.writeFileSync(path.join(root, 'sub', 'deeper', 'c.txt'), 'z');
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    assert.equal(await tools.executors.tree({ path: 'sub' }), 'sub/\n  b.txt\n  deeper/\n    c.txt');
    assert.equal(await tools.executors.tree({ path: 'sub/' }), 'sub/\n  b.txt\n  deeper/\n    c.txt');
    // ⚠ erix-agent 0.25.0（上游自己的 #358）把**非根目标**的首行也改成「相对根的完整路径」：
    // 旧值 `deeper/` 是 basename，`a/sub` 与 `b/sub` 的标签长得一样、且抄回 path 换个父目录就回放不了。
    // 随包契约套件（`test/contract/file-tools.js`）现在钉的就是这个新形状 ⇒ 这里跟着改，**不是放松**。
    assert.equal(String(await tools.executors.tree({ path: 'sub/deeper' })).split('\n')[0], 'sub/deeper/');
    // 工作目录名作为**相对路径**依旧按普通子目录看待（本目录里并没有这个子目录 → ENOENT），
    // 不被当成根写法强行归一——过度归一会把「真的不存在」洗成「根目录」，那是另一条谎。
    // 0.25.0 起不存在的路径抛的是**引擎自己的错误对象**（文案「错误：路径不存在：…」+ 下一步提示），
    // 不再带 `code === 'ENOENT'`（旧断言读的是 fs 层的 code）⇒ 判据换成「确实失败且说清了原因」，
    // 「真的不存在」这条语义没变，变的只是错误的形状。
    await assert.rejects(() => tools.executors.tree({ path: `${path.basename(root)}/` }),
      (error) => String(error?.message ?? error).includes('路径不存在'));
    // 真存在的同名子目录：标签就是它自己，不是 ./
    fs.mkdirSync(path.join(root, path.basename(root)), { recursive: true });
    fs.writeFileSync(path.join(root, path.basename(root), 'inner.txt'), 'x');
    assert.equal(String(await tools.executors.tree({ path: `${path.basename(root)}/` })).split('\n')[0],
      `${path.basename(root)}/`);
    assert.ok((await tools.executors.tree({ path: `${path.basename(root)}/` })).includes('inner.txt'));
  }));

test('回归（真机链路 #228 → #64）：第一次 tree 的首行拿去当第二次的 path，第二次必须成功', () =>
  withTools(async (tools, root) => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'index.js'), 'x');
    fs.writeFileSync(path.join(root, 'package.json'), '{}');

    // 真机上模型就是这么做的：把工具输出的根标签直接拷回去当下一次 path。
    const first = await tools.executors.tree({ path: './' });
    const label = first.split('\n')[0];
    assert.equal(label, './', '第一步就必须是 ./，否则回归用例测的不是修复后的行为');
    const second = await tools.executors.tree({ path: label });   // 修复前这里直接 ENOENT 抛异常
    assert.equal(second.split('\n')[0], './');
    assert.equal(second, first, '同一个目录两次查询结果逐字一致（模型不会看到新标签）');

    // 反证：这个收口确实在挡真实失败——拿 basename 当相对 path 就是真机那一次的结局。
    // 0.25.0 起抛的是引擎自己的「路径不存在」错误（不再有 fs 的 `code: 'ENOENT'`，见上一处注释），
    // 判据同向：失败 + 说清原因，**不许**被洗成「当成根目录了」。
    await assert.rejects(() => tools.executors.tree({ path: `${path.basename(root)}/` }),
      (error) => String(error?.message ?? error).includes('路径不存在'),
      'basename 当相对路径必须是真实失败（这正是必须在根标签上收口的原因）');
    // 而**首行抄回 path** 在 0.25 之后是官方契约（根标签 `./` 可回放），上面已钉逐字一致。
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

// ---------------------------------------------------------------------------
// issue #259（工单 fix-261116-05）：**只读例外**——家目录里平台自己生成的文档（`~/AGENTS.md`、
// `~/.erix/ports.json`）在文件工具里从二等公民变成一等公民。钉四条：
//   ① 正向：`readFile` / `tree` / `searchText` 都能进例外路径（不再需要 shell 绕路）；
//   ② **写边界不变**（红线）：例外路径能读不能写，被拒的写不得落盘；
//   ③ 例外是**平台侧白名单**：`..` / symlink 不得借它走出清单（也不许漏一个字节）；
//   ④ `maskedPaths` 在例外之内**继续生效**（遮蔽是收窄读，与例外正交；用**前缀形态**条目——
//      glob 遮蔽是 #231 / PR #540 的面，未合并，本单不依赖）。
// 另钉两条防漂移：不带 `readExceptions` 时行为逐字同旧（默认不放宽）、jail 的严格解析
// （`resolve` / `resolveForWrite`）一字未动（例外只进 `assertReadable`）。
// 隔离：家目录与项目目录都是 tmp 夹具，不碰真实家目录（末两条除外，见各自注释）。
// ---------------------------------------------------------------------------

/** #259 夹具：容器同形的家目录 `<base>/home` 与项目目录 `<base>/home/projects/<p>`（后者是 jail 根）。 */
async function withHomeFixture(fn, { readExceptions, maskedPaths, assemblyMaskedPaths } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'erix-259-')));
  const home = path.join(base, 'home');
  const project = path.join(home, 'projects', 'todo');
  fs.mkdirSync(path.join(home, '.erix', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(home, '.erix', 'secrets'), { recursive: true });
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  // 三个「兄弟」陷阱（#259 判据③）：名字前缀与例外相同的目录、普通兄弟目录、家目录之外
  fs.mkdirSync(path.join(home, '.erix-backup'), { recursive: true });
  fs.mkdirSync(path.join(home, 'other'), { recursive: true });
  fs.mkdirSync(path.join(base, 'etc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.erix-backup', 'secret.txt'), 'SIBLING-BACKUP\n');
  fs.writeFileSync(path.join(home, 'other', 'secret.txt'), 'SIBLING-OTHER\n');
  fs.writeFileSync(path.join(base, 'etc', 'passwd'), 'root:x:0:0\n');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(home, 'AGENTS.md'), '# 平台约束\n收工即提交\n');
  fs.writeFileSync(path.join(home, '.erix', 'ports.json'), '{"allocations":[{"port":22000}]}\n');
  fs.writeFileSync(path.join(home, '.erix', 'keep.txt'), 'needle keep\n');
  fs.writeFileSync(path.join(home, '.erix', 'sub', 'deep.txt'), 'needle deep\n');
  fs.writeFileSync(path.join(home, '.erix', 'secrets', 'token.txt'), 'needle secret\n');
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE-KEY-OUTSIDE-EXCEPTION\n');
  fs.writeFileSync(path.join(project, 'a.txt'), 'project file\n');
  // 例外目录内的 symlink 指向**清单外**的目录：跟链接走就漏（上游遍历不跟随 symlink，但
  // readFile / 谓词这一层必须自己挡——这才是「例外不变成第二道门」的判据）。
  fs.symlinkSync(path.join(home, '.ssh'), path.join(home, '.erix', 'link-to-ssh'));
  const jail = createJail({
    root: project,
    writable: [project],
    readExceptions: readExceptions ? readExceptions(home) : [],
    maskedPaths: maskedPaths ? maskedPaths(home) : [],
  });
  const tools = createStationFileTools({
    jail,
    cwd: project,
    maskedPaths: assemblyMaskedPaths ? assemblyMaskedPaths(home) : [],
  });
  try {
    return await fn({ tools, jail, home, project, base });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/** worker 实际传的那份清单的夹具形态（家目录文档 + `.erix` 目录）。 */
const homeExceptions = (home) => [path.join(home, 'AGENTS.md'), path.join(home, '.erix')];

test('#259 正向：例外路径 readFile / tree / searchText 全通（含例外目录的子目录）', () =>
  withHomeFixture(async ({ tools, home }) => {
    const agents = await tools.executors.readFile({ path: path.join(home, 'AGENTS.md') });
    assert.match(agents, /1: # 平台约束/u, 'readFile 必须直接读得到 ~/AGENTS.md（issue 的动机就是它）');
    assert.match(agents, /收工即提交/u);
    assert.match(await tools.executors.readFile({ path: path.join(home, '.erix', 'ports.json') }),
      /allocations/u, 'readFile 必须直接读得到 ~/.erix/ports.json（#246 的端口唯一真相）');
    // 例外是**目录**时，子目录内的文件也算命中前缀（不是只放行清单里的那一个文件）
    assert.match(await tools.executors.readFile({ path: path.join(home, '.erix', 'sub', 'deep.txt') }),
      /needle deep/u);

    const tree = await tools.executors.tree({ path: path.join(home, '.erix') });
    assert.match(String(tree), /ports\.json/u, 'tree 也要能列例外目录');
    assert.match(String(tree), /deep\.txt/u, '例外目录的子目录也要列出来');

    const search = await tools.executors.searchText({ pattern: 'needle', mode: 'literal', path: path.join(home, '.erix') });
    assert.match(search.content, /keep\.txt/u, 'searchText 也要能搜进例外目录');
    assert.match(search.content, /deep\.txt/u);

    // 项目目录（原来的读/写边界）不受影响
    assert.match(await tools.executors.readFile({ path: 'a.txt' }), /1: project file/u);
    assert.equal(await tools.executors.writeFile({ path: 'b.txt', content: 'ok' }), 2);
  }, { readExceptions: homeExceptions }));

test('#259 红线：写边界不变——例外路径能读不能写，被拒的写一个字节都不落盘', () =>
  withHomeFixture(async ({ tools, jail, home }) => {
    const agents = path.join(home, 'AGENTS.md');
    const ports = path.join(home, '.erix', 'ports.json');
    assert.match(await tools.executors.readFile({ path: agents }), /收工即提交/u, '先证明读得到（否则写被拒毫无意义）');

    const denyAgents = String(await tools.executors.writeFile({ path: agents, content: 'agent 自作主张' }));
    assert.match(denyAgents, /^错误：写入被宿主边界拒绝/u);
    assert.match(denyAgents, /只读例外/u, '拒因必须能说清是「只读例外」（issue 验收：别只断言被拒）');
    assert.equal(fs.readFileSync(agents, 'utf8'), '# 平台约束\n收工即提交\n',
      '被拒的写不得改到平台文件（否则下一轮对账覆盖回去 ⇒ 用户以为改掉了）');
    const denyEdit = String(await tools.executors.edit({ path: ports, edits: [{ oldText: '22000', newText: '12345' }] }));
    assert.match(denyEdit, /^错误：写入被宿主边界拒绝/u, 'edit 也要吃同一个写边界（本站第二个写工具）');
    assert.match(denyEdit, /只读例外/u, '第二个写工具的拒因同样要说得清');
    assert.equal(fs.readFileSync(ports, 'utf8'), '{"allocations":[{"port":22000}]}\n', '被拒的 edit 不得落盘');
    const denyNew = String(await tools.executors.writeFile({ path: path.join(home, '.erix', 'new.txt'), content: 'x' }));
    assert.match(denyNew, /^错误：写入被宿主边界拒绝/u, '例外目录内新建文件同样不许写');
    assert.match(denyNew, /只读例外/u);
    assert.ok(!fs.existsSync(path.join(home, '.erix', 'new.txt')), '被拒的写不得留下文件');
    // **拒因分诊**：清单外的写拒不得披上「只读例外」的文案（两种拒因糊在一起 = 本单最容易做假的地方）
    const denyOutside = String(await tools.executors.writeFile({ path: path.join(home, '..', 'elsewhere', 'x.txt'), content: 'x' }));
    assert.match(denyOutside, /^错误：写入被宿主边界拒绝/u);
    assert.doesNotMatch(denyOutside, /只读例外/u, '越界就是越界，不得被说成例外');
    assert.match(denyOutside, /越出/u);
    // jail 层：三条拒因的**错误码**也要分得开（写判定本身一点没放宽，只是说法更准）
    assert.throws(() => jail.resolveForWrite(agents), (e) => e instanceof JailError && e.code === 'path_read_only',
      '落在例外清单里 ⇒ path_read_only');
    assert.throws(() => jail.resolveForWrite(path.join(home, '.ssh', 'id_ed25519')),
      (e) => e instanceof JailError && e.code === 'path_escapes_root', '清单外的家目录文件 ⇒ 仍报越界');
    // 项目内照旧可写（拒因改造没伤到成功路径）
    assert.equal(jail.resolveForWrite(path.join(home, 'projects', 'todo', 'a.txt')),
      jail.resolve(path.join(home, 'projects', 'todo', 'a.txt')));
  }, { readExceptions: homeExceptions }));

test('#259 越界：`..` / symlink / 兄弟路径 / 清单外的家目录文件都不得借例外读出去（一字节不漏）', () =>
  withHomeFixture(async ({ tools, home }) => {
    const cases = [
      // lexical 前缀看着在例外里，realpath 之后在例外外（只按字符串前缀判定的实现会在这里漏）
      `${path.join(home, '.erix', 'secrets')}/../../.ssh/id_ed25519`,
      // 例外目录内的 symlink 指向清单外目录
      path.join(home, '.erix', 'link-to-ssh', 'id_ed25519'),
      // 例外**文件**再 `..` 一下（AGENTS.md 是文件，爬出去就是家目录别处）
      `${agentsDotDot(home)}/.ssh/id_ed25519`,
      // 清单外的家目录文件本身（例外只开了清单，没开整个家目录）
      path.join(home, '.ssh', 'id_ed25519'),
      // ⚠ 名字前缀与例外相同的**兄弟目录**（`<例外>`-backup）：按字符串 startsWith 判定的实现会把它
      // 当成例外命中（本仓用的 `isWithin` 走 `path.relative`，但这条得钉住，不然下次换实现就漏）
      path.join(home, '.erix-backup', 'secret.txt'),
      // 普通兄弟目录
      path.join(home, 'other', 'secret.txt'),
      // `$HOME/../etc/passwd` 一类：从例外目录一路往上爬出家目录
      path.join(home, '..', 'etc', 'passwd'),
      path.join(home, '.erix', '..', '..', 'etc', 'passwd'),
    ];
    for (const target of cases) {
      const read = await tools.executors.readFile({ path: target });
      assert.match(String(read), /^错误：读取被宿主边界拒绝/u, `这条应当被挡：${target}`);
      assert.doesNotMatch(String(read), /PRIVATE-KEY-OUTSIDE-EXCEPTION|SIBLING-BACKUP|SIBLING-OTHER|root:x:0:0/u,
        `被挡的同时不得漏内容：${target}`);
    }
    // 例外目录本身可以 tree，但**家目录整体**不在清单里（开的是白名单，不是「放宽到家目录」）
    assert.match(String(await tools.executors.tree({ path: path.join(home, '.erix') })), /ports\.json/u);
    assert.match(String(await tools.executors.tree({ path: home })), /^错误：读取被宿主边界拒绝/u,
      '家目录本身不在清单里——例外不是「家目录全部可读」');
    // 反向对照：同夹具下清单内的文件确实读得到（否则上面四条只是「全都挡」的假绿）
    assert.match(await tools.executors.readFile({ path: path.join(home, '.erix', 'keep.txt') }), /needle keep/u);
  }, { readExceptions: homeExceptions }));

/** `~/AGENTS.md` 再往上一层 = 家目录（拼字符串用，保留「lexical 在例外里」的形状）。 */
function agentsDotDot(home) {
  return `${path.join(home, 'AGENTS.md')}/..`;
}

test('#259 遮蔽继续生效：例外内的遮蔽项读不到、计入排除账、tree 不列（前缀形态条目）', () =>
  withHomeFixture(async ({ tools, home }) => {
    const secret = path.join(home, '.erix', 'secrets', 'token.txt');
    const read = await tools.executors.readFile({ path: secret });
    assert.match(String(read), /^错误：读取被宿主边界拒绝/u, '开了只读例外不得把遮蔽项放进来');
    assert.doesNotMatch(String(read), /needle secret/u, '被遮蔽的内容一字节不许回传');

    const search = await tools.executors.searchText({ pattern: 'needle', mode: 'literal', path: path.join(home, '.erix') });
    assert.match(search.content, /keep\.txt/u, '例外内未遮蔽的文件要能搜到');
    assert.doesNotMatch(search.content, /needle secret/u);
    assert.match(search.content, /宿主边界拒绝/u, '遮蔽条目必须进模型可见的排除账');
    assert.ok(search.metadata.searchSkipped.deniedPaths >= 1, '遮蔽条目必须计入结构化排除账');

    const tree = await tools.executors.tree({ path: path.join(home, '.erix') });
    assert.match(String(tree), /keep\.txt/u);
    assert.doesNotMatch(String(tree), /token\.txt/u, 'tree 不得列出例外内的遮蔽项');
  }, { readExceptions: homeExceptions, maskedPaths: (home) => [path.join(home, '.erix', 'secrets')] }));

test('#259 不与 glob 语义耦合：例外与遮蔽条目都是**字面前缀**（`*` 就是文件名叫 `*`）', () =>
  // 同批 PR #540（#231）给 `maskedPaths` 加了 glob 支持但**尚未合并**，main 上只有前缀语义。
  // 本单必须不依赖它：所以这里反着钉——把 glob 元字符写进入参，它必须**不**当模式用。
  // 将来 #540 合并了、这里变红了，就是提醒下次动这块时要重读一遍口径（不是“修测试”了事）。
  withHomeFixture(async ({ tools, home }) => {
    // ① 例外条目带 `*`：按字面路径处理 ⇒ 家目录里没有一个文件满得住它，全部依旧读不到
    const globJail = createJail({
      root: path.join(home, 'projects', 'todo'),
      writable: [path.join(home, 'projects', 'todo')],
      readExceptions: [path.join(home, '*')],
    });
    const globTools = createStationFileTools({ jail: globJail, cwd: path.join(home, 'projects', 'todo') });
    assert.match(String(await globTools.executors.readFile({ path: path.join(home, 'AGENTS.md') })),
      /^错误：读取被宿主边界拒绝/u, '`<home>/*` 不得被当成「家目录全部」的 glob');
    assert.deepEqual(globJail.readExceptions, [path.join(fs.realpathSync(home), '*')],
      '清单存的是解析后的字面路径（不是展开后的集合）');

    // ② 遮蔽条目带 `*`：同样按字面前缀 ⇒ 它遮不住 `token.txt`（前缀语义下本来就该遮不住）
    assert.match(await tools.executors.readFile({ path: path.join(home, '.erix', 'keep.txt') }), /needle keep/u,
      '夹具用的前缀条目 `<例外>/secrets` 没把整个例外目录遮掉');
    const starJail = createJail({
      root: path.join(home, 'projects', 'todo'),
      writable: [path.join(home, 'projects', 'todo')],
      readExceptions: homeExceptions(home),
      maskedPaths: [path.join(home, '.erix', '*.txt')],
    });
    const starTools = createStationFileTools({ jail: starJail, cwd: path.join(home, 'projects', 'todo') });
    assert.match(await starTools.executors.readFile({ path: path.join(home, '.erix', 'keep.txt') }), /needle keep/u,
      '`*.txt` 按字面前缀解析 ⇒ 遮不住任何东西（main 上只有前缀语义，本单不依赖 #540 的 glob）');
    // ③ 本单自己用的两份条目必须是前缀形态（不往参数里塞元字符，也就不会被上游将来的 glob 改版拖到）
    for (const entry of [...homeExceptions(home), path.join(home, '.erix', 'secrets')]) {
      assert.doesNotMatch(entry, /[*?\[\]]/, `本单用的条目必须是字面前缀：${entry}`);
    }
  }, { readExceptions: homeExceptions, maskedPaths: (home) => [path.join(home, '.erix', 'secrets')] }));

test('#259 遮蔽条目的落点：例外之内可以遮蔽（装配期不炸），两者之外照旧在装配期抛 JailError', () =>
  withHomeFixture(async ({ jail, home }) => {
    // ① 例外之内的遮蔽条目：#259 之前会被当成越界而**在装配期抛**（家目录里的密钥根本没法挡）；
    //    现在它要能建起来，并且真的在 jail 层就判掉（不只是「没报错」）。
    assert.throws(() => jail.assertReadable(path.join(home, '.erix', 'secrets', 'token.txt')),
      (error) => error instanceof JailError && error.code === 'path_masked',
      '例外内的遮蔽项必须在 jail 层就判掉（夹具已经带了这条遮蔽）');
    assert.doesNotThrow(() => jail.assertReadable(path.join(home, '.erix', 'keep.txt')),
      '同一例外目录里没被遮蔽的文件照旧读得到');
    // ② 两者之外的遮蔽条目仍要抛（不静默吞一条写歪的遮蔽规则——旧守卫原样保留）
    const project = path.join(home, 'projects', 'todo');
    assert.throws(() => createJail({
      root: project, writable: [project],
      maskedPaths: [path.join(home, '.ssh')],
      readExceptions: homeExceptions(home),
    }), (error) => error instanceof JailError && error.code === 'path_escapes_root');
    // ③ 项目内的遮蔽条目照旧（不受例外影响）
    assert.doesNotThrow(() => createJail({
      root: project, writable: [project],
      maskedPaths: [path.join(project, 'a.txt')],
      readExceptions: homeExceptions(home),
    }));
  }, { readExceptions: homeExceptions, maskedPaths: (home) => [path.join(home, '.erix', 'secrets')] }));

test('#259 默认不放宽：不传 readExceptions 时逐字同旧（家目录照旧读不到，清单是空数组）', () =>
  withHomeFixture(async ({ tools, jail, home }) => {
    assert.deepEqual(jail.readExceptions, [], '没传例外就是空清单，不是「默认放宽到家目录」');
    assert.match(String(await tools.executors.readFile({ path: path.join(home, 'AGENTS.md') })),
      /^错误：读取被宿主边界拒绝/u);
    assert.match(String(await tools.executors.tree({ path: path.join(home, '.erix') })),
      /^错误：读取被宿主边界拒绝/u);
  }));

test('#259 jail 严格语义一字未动：resolve 仍只认项目根，写判定也没放宽（例外只把拒因说准）', () =>
  withHomeFixture(async ({ jail, home }) => {
    const agents = path.join(home, 'AGENTS.md');
    assert.equal(jail.assertReadable(agents), agents, '读侧：例外放行');
    assert.throws(() => jail.resolve(agents), (e) => e instanceof JailError && e.code === 'path_escapes_root',
      'resolve 必须仍是「严格根内」（历史语义，也是写侧的唯一实现）');
    assert.throws(() => jail.resolveForWrite(agents), (e) => e instanceof JailError && e.code === 'path_read_only',
      '写侧不得看到例外——例外只把一个**已有的拒**换个说得准的说法（path_read_only），不是放开了');
    assert.throws(() => jail.resolveForWrite(path.join(home, '.ssh', 'id_ed25519')),
      (e) => e instanceof JailError && e.code === 'path_escapes_root',
      '清单外仍报 path_escapes_root（两条拒因不得糊同一条，也是上面那条文案断言的根）');
    assert.deepEqual(jail.readExceptions, homeExceptions(fs.realpathSync(home)), '清单是 realpath 后的事实（供装配方复核）');
    assert.ok(Object.isFrozen(jail.readExceptions), '清单不得被调用方就地改掉');
  }, { readExceptions: homeExceptions }));

test('#259 平台清单：就两项、不含运行期事实、拿不到家目录 fail-closed', async () => {
  const { platformReadExceptions } = await import('../lib/file-tools.js');
  assert.deepEqual(platformReadExceptions({ home: '/home/erix' }),
    ['/home/erix/AGENTS.md', '/home/erix/.erix'],
    '清单就两项，不做推测性扩张（「开一个目录」与「开一个文件」的失守面不一样）');
  const joined = platformReadExceptions({ home: '/home/erix' }).join('\n');
  assert.doesNotMatch(joined, /\d/u, `例外清单里不得出现数字（端口号是运行期事实；#246/#257 同口径）：${joined}`);
  assert.doesNotMatch(joined, /[a-z0-9-]+\.[a-z0-9-]+\.[a-z]{2,}/iu, `不得出现域名（伞域也是生成值）：${joined}`);
  assert.doesNotMatch(joined, /localhost|erix\.vip/iu, `不得出现现网域名字面量：${joined}`);
  // fail-closed：**传了**但拿不到可用家目录 ⇒ 空清单（退化成 #259 之前的行为），绝不是「放宽成整个 /」。
  // ⚠ `home: undefined` 不在表里：那是「没传」的同义（默认参数 → os.homedir()），不是「拿不到」。
  for (const bad of ['', null, 42, {}]) {
    assert.deepEqual(platformReadExceptions({ home: bad }), [], `home=${JSON.stringify(bad)} 必须退化成空清单`);
  }
  // 缺省真取自家目录（容器内是 erix，本机跑测试的人不是 ⇒ 不许写死 /home/erix）
  assert.deepEqual(platformReadExceptions(),
    [path.join(os.homedir(), 'AGENTS.md'), path.join(os.homedir(), '.erix')]);
});

test('#259 真机形状：readFile 传 `~/AGENTS.md` 不再撞宿主边界（上游 `~` 展开 + worker 缺省清单）', async () => {
  const { platformReadExceptions } = await import('../lib/file-tools.js');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'erix-259-home-')));
  const fakeHome = path.join(base, 'home');
  const project = path.join(fakeHome, 'projects', 'todo');
  fs.mkdirSync(path.join(fakeHome, '.erix'), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, '.ssh'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(fakeHome, 'AGENTS.md'), '# 平台约束\n收工即提交\n');
  fs.writeFileSync(path.join(fakeHome, '.erix', 'ports.json'), '{"allocations":[]}\n');
  fs.writeFileSync(path.join(fakeHome, '.ssh', 'id_ed25519'), 'OUTSIDE-OF-LIST\n');
  // 把 HOME 换到夹具家目录 ⇒ 本用例跑的是**真机那条链路**：模型传 `~/AGENTS.md` → 上游
  // `expandHomePath` 拿 `os.homedir()` 展开 → jail 谓词判定；而 `platformReadExceptions()` **不带参数**
  // 调用（= worker 里的写法），两边因此必然用同一个家目录。不依赖跑测试的人真正家里有什么文件。
  // ⚠ finally 必恢复：同一进程里后面的用例要看真的 HOME。
  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const jail = createJail({ root: project, writable: [project], readExceptions: platformReadExceptions() });
    assert.deepEqual(jail.readExceptions, [path.join(fakeHome, 'AGENTS.md'), path.join(fakeHome, '.erix')],
      '缺省清单必须真取自家目录（写死 `/home/erix` 会在本机假绿）');
    const tools = createStationFileTools({ jail, cwd: project });

    assert.match(await tools.executors.readFile({ path: '~/AGENTS.md' }), /收工即提交/u,
      'issue 的真机证据就是这一条：模型的自然习惯过去只能拿到「被宿主边界拒绝」，白烧一轮');
    assert.match(await tools.executors.readFile({ path: '~/.erix/ports.json' }), /allocations/u);
    assert.match(String(await tools.executors.tree({ path: '~/.erix' })), /ports\.json/u);

    // 清单外的家目录文件依旧挡（证明放宽的是清单，不是整个家目录）
    const outside = String(await tools.executors.readFile({ path: '~/.ssh/id_ed25519' }));
    assert.match(outside, /^错误：读取被宿主边界拒绝/u);
    assert.doesNotMatch(outside, /OUTSIDE-OF-LIST/u, '被挡的同时不得漏内容');
    // 写依旧被拒（真机形状再钉一次）
    assert.match(String(await tools.executors.writeFile({ path: '~/AGENTS.md', content: 'x' })),
      /^错误：写入被宿主边界拒绝/u);
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
