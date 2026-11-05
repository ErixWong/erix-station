// issue #451（工单 feat-261105-01）AGENTS.md 链注入：采集器单测 + 两条接线源码级锁。
//
// 隔离口径（AGENTS.md §4）：**不碰真实 `$HOME`**——所有用例用 `fs.mkdtempSync(os.tmpdir())` 造树，
// 或注入一个 fs 门面（EACCES 那一格必须注入，真实环境里造不出「读不动」）。
//
// 判据来源：docs/design/agents-md-layering-2026-11-05.md §6.1（13 格）+ 工单 §3.3（源码级锁 2 条）。
// 每条用例的注释写清「这条红了意味着什么」，避免下一个人把锁当成可选项删掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENTS_MD_BASENAME,
  AGENTS_MD_MAX_FILE_BYTES,
  AGENTS_MD_MAX_TOTAL_BYTES,
  AGENTS_MD_MAX_SUBDIR_HINTS,
  resolveAgentsMdChain,
  collectAgentsMd,
  renderAgentsMdSection,
} from '../lib/agents-md.js';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 造一棵 `<tmp>/home` 树并在用完后整棵删掉。
 * `files` 的键是相对 `<tmp>` 的路径（如 `'home/projects/AGENTS.md'`），值是要写入的内容
 * （字符串或 `Buffer`；`null` 表示「建同名目录」——非普通文件那一格要用）。
 */
async function withTree(files, fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'erix-agents-md-')));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'projects', 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  try {
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (content === null) fs.mkdirSync(target, { recursive: true });
      else fs.writeFileSync(target, content);
    }
    await fn({ root, home, cwd });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const PLATFORM = '# 平台约定\n- 规则 A：端口从清单取\n';
const WORKSPACE = '# 跨项目约定\n- 规则 B：提交前跑测试\n';
const PROJECT = '# 项目约定\n- 规则 C：本仓用 ESM\n';

test('链由外到内：home → home/projects → 项目根，且 blocks 的顺序就是注入顺序', async () => {
  await withTree({
    'home/AGENTS.md': PLATFORM,
    'home/projects/AGENTS.md': WORKSPACE,
    'home/projects/proj/AGENTS.md': PROJECT,
  }, ({ home, cwd }) => {
    const { blocks, totalBytes } = collectAgentsMd({ cwd, home });
    assert.deepEqual(blocks.map((b) => b.scope), ['platform', 'workspace', 'project'],
      '顺序必须是**由外到内**（平台 → 跨项目 → 项目）：反了就等于让最内层的事实被最外层的话覆盖');
    assert.deepEqual(blocks.map((b) => b.text), [PLATFORM, WORKSPACE, PROJECT],
      '注入内容必须逐字节等于文件原文（不解析、不改写、不摘录）');
    assert.equal(totalBytes, blocks.reduce((n, b) => n + b.bytes, 0), 'totalBytes 必须是各节字节之和');
    // 渲染里三节的先后也要一致（blocks 顺序对、渲染顺序错同样是漂移）
    const rendered = renderAgentsMdSection({ blocks });
    const at = [PLATFORM, WORKSPACE, PROJECT].map((t) => rendered.indexOf(t));
    assert.deepEqual(at.slice().sort((a, b) => a - b), at, '渲染顺序必须与 blocks 顺序一致（由外到内）');
  });
});

test('scope 标注：home = platform，home/projects = workspace，其余 = project', async () => {
  await withTree({
    'home/AGENTS.md': PLATFORM,
    'home/projects/AGENTS.md': WORKSPACE,
    'home/projects/proj/AGENTS.md': PROJECT,
  }, ({ home, cwd }) => {
    const chain = resolveAgentsMdChain({ cwd, home });
    assert.deepEqual(chain.map((e) => e.scope), ['platform', 'workspace', 'project']);
    assert.equal(chain[0].dir, home, '链的第一项必须是 home 自身（平台节不可少）');
    assert.equal(chain[chain.length - 1].dir, cwd, '链的最后一项必须是 cwd');
    for (const entry of chain) {
      assert.equal(entry.path, path.join(entry.dir, AGENTS_MD_BASENAME), '每项的 path 必须是 <dir>/AGENTS.md');
    }
    // 平台节「不可覆盖」的**事实依据**：materializer 以 root:root 物化它（本模块只认 scope 标签）
    assert.equal(blocksScope(collectAgentsMd({ cwd, home })), 'platform,workspace,project');
  });
});

function blocksScope(collected) {
  return collected.blocks.map((b) => b.scope).join(',');
}

test('缺失的层直接跳过，不产生空节（只有 home 存在时输出只有一节）', async () => {
  await withTree({ 'home/AGENTS.md': PLATFORM }, ({ home, cwd }) => {
    const { blocks } = collectAgentsMd({ cwd, home });
    assert.equal(blocks.length, 1, '不存在的文件不得产出空块（空块会让渲染出空标题，模型会以为那份是空的）');
    const rendered = renderAgentsMdSection({ blocks });
    assert.equal((rendered.match(/^### /gm) ?? []).length, 1, '渲染里也只能有一个节标题');
    assert.doesNotMatch(rendered, /projects\/AGENTS\.md/, '不存在的文件不该在渲染里留下任何痕迹');
  });
});

test('内容相同的两份只注入靠外那份（sha256 去重）+ 一条 note', async () => {
  await withTree({
    'home/AGENTS.md': PLATFORM,
    'home/projects/proj/AGENTS.md': PLATFORM, // 用户把平台那份抄了一份
  }, ({ home, cwd }) => {
    const { blocks, notes } = collectAgentsMd({ cwd, home });
    assert.equal(blocks.length, 1, '重复内容只留一份（否则同一段规则在 system 里出现两次，白烧 token 且可能自相矛盾）');
    assert.equal(blocks[0].scope, 'platform', '保留的必须是**靠外**那份（平台节优先）');
    assert.ok(notes.some((n) => n.includes('去重')), `去重要记账，实际 notes=${JSON.stringify(notes)}`);
  });
});

test('单文件超上限：截断并留 marker（含原字节数 + 可直接照抄的 cat <path>）', async () => {
  const big = `# 大文件\n${'x'.repeat(AGENTS_MD_MAX_FILE_BYTES + 2048)}`;
  await withTree({ 'home/AGENTS.md': big }, ({ home, cwd }) => {
    const { blocks } = collectAgentsMd({ cwd, home });
    assert.equal(blocks.length, 1);
    const block = blocks[0];
    assert.equal(block.truncated, true, '超过单文件上限必须标 truncated');
    assert.ok(block.bytes < Buffer.byteLength(big), '截断后注入的字节数必须真的变小');
    assert.match(block.text, new RegExp(`\\[已截断：原 ${Buffer.byteLength(big)} 字节，仅注入前 \\d+ 字节`),
      'marker 必须报**原文件字节数**（模型据此判断自己少看了多少）');
    assert.match(block.text, /看全文：cat ~\/AGENTS\.md/,
      'marker 必须给可直接照抄的命令（不给命令，模型只会自己猜 head -N，那正是今天的病）');
    assert.ok(block.text.startsWith('# 大文件'), '截断只砍尾部，开头必须保留');
  });
});

// #451 评审 B1（blocker）判据：上限必须在**读之前**生效。旧形状（先整文件 readFileSync 再比长度）
// 在这两格上全红：它读满了整个文件，`stat.size` 从没用过。
test('B1：单文件 maxFileBytes×40（≈640 KiB）⇒ 只读定长前缀，readFileSync 对该路径一次都没调', async () => {
  const maxFileBytes = AGENTS_MD_MAX_FILE_BYTES;
  const bigBytes = maxFileBytes * 40; // 655360 B：足够证明「不是靠 readFileSync 拿全文」
  await withTree({ 'home/AGENTS.md': 'x'.repeat(bigBytes) }, ({ home, cwd }) => {
    const readFileSyncCalls = [];
    const readSyncLengths = [];
    const facade = {
      ...fs,
      readFileSync: (target, ...rest) => {
        readFileSyncCalls.push(String(target));
        return fs.readFileSync(target, ...rest);
      },
      readSync: (fd, buffer, offset, length, position) => {
        readSyncLengths.push(length);
        return fs.readSync(fd, buffer, offset, length, position);
      },
    };
    const { blocks } = collectAgentsMd({ cwd, home, fs: facade });
    assert.equal(blocks.length, 1);
    const block = blocks[0];
    assert.equal(block.truncated, true, 'maxFileBytes×40 必须标 truncated');
    assert.ok(readSyncLengths.length > 0, '超限文件必须走定长前缀读（openSync + readSync + closeSync）');
    assert.ok(readSyncLengths.every((n) => n <= maxFileBytes + 4),
      `readSync 每次读的字节数必须 ≤ maxFileBytes+4（实际 ${JSON.stringify(readSyncLengths)}）`);
    assert.equal(readFileSyncCalls.filter((p) => p.endsWith('/AGENTS.md')).length, 0,
      `超限的文件不许整文件 readFileSync（实际调了 ${JSON.stringify(readFileSyncCalls)}）：` +
      '这是本条 finding 的核心——旧写法在这里会把 600 MiB 拉进内存再抛 ERR_STRING_TOO_LONG');
    assert.ok(block.bytes > maxFileBytes && block.bytes < bigBytes / 4,
      `注入字节数必须合理（实际 ${block.bytes}，文件 ${bigBytes}）`);
    assert.match(block.text, new RegExp(`\\[已截断：原 ${bigBytes} 字节，仅注入前 ${maxFileBytes} 字节`),
      'marker 必须报**原文件**字节数（前缀读之后 buf.length 只是前缀长度，报它会骗模型）');
  });
});

test('B1：16 KiB 边界不变形——16384 不截断 / 16385 截断（上限口径仍是「正文」）', async () => {
  const maxFileBytes = AGENTS_MD_MAX_FILE_BYTES;
  assert.equal(maxFileBytes, 16384, '本用例的 16384/16385 字面量跟常量绑死');
  await withTree({
    'home/AGENTS.md': 'x'.repeat(maxFileBytes), // 正好卡在上限：一个字节都不许多读
    'home/projects/proj/AGENTS.md': 'y'.repeat(maxFileBytes + 1), // 多 1 字节就该截
  }, ({ home, cwd }) => {
    const { blocks } = collectAgentsMd({ cwd, home });
    assert.deepEqual(blocks.map((b) => b.scope), ['platform', 'project']);
    const [exact, over] = blocks;
    assert.equal(exact.truncated, false, '正好 16384 字节不得截断（边界上多切一个字节就是改写约定）');
    assert.equal(exact.bytes, maxFileBytes, '不截断时注入字节数必须逐字节等于文件字节数');
    assert.equal(over.truncated, true, '16385 字节必须截断（上限是硬口径，没有“差一个字节就放过”）');
    assert.match(over.text, new RegExp(`\\[已截断：原 ${maxFileBytes + 1} 字节`),
      'marker 必须报真实原字节数（16385，不是前缀长度）');
  });
});

// #451 评审 M1（major）：设计稿 §4.1 规则 6 承诺「解码失败 ⇒ 跳过 + note」，但旧实现的
// `buf.toString('utf8')` 是 lossy 解码、永不失败 ⇒ 那条降级是死光纤。
test('M1：非 UTF-8（FF FE 00 41）⇒ 不注入 + note 点名「UTF-8」并给出前 16 字节 hex', async () => {
  await withTree({
    'home/AGENTS.md': PLATFORM,
    'home/projects/AGENTS.md': Buffer.from([0xff, 0xfe, 0x00, 0x41]), // 看着像 UTF-16LE BOM + 'A'
  }, ({ home, cwd }) => {
    const { blocks, notes } = collectAgentsMd({ cwd, home });
    assert.deepEqual(blocks.map((b) => b.scope), ['platform'],
      '非 UTF-8 的一份一个字节都不许注入（旧 lossy 解码会把 U+FFFD 与 \\u0000 当正文塞进 prompt 缓存前缀）');
    assert.ok(notes.some((n) => n.includes('UTF-8')), `必须记账「不是 UTF-8」（旧实现 notes 恒为空）：${JSON.stringify(notes)}`);
    assert.ok(notes.some((n) => n.includes('fffe0041')),
      `note 必须带前 16 字节 hex（运维拿着就能定编码）：${JSON.stringify(notes)}`);
    const rendered = renderAgentsMdSection({ blocks, notes });
    assert.doesNotMatch(rendered, /\uFFFD/, '渲染结果里不得出现 U+FFFD');
  });
});

test('M1：合法中文 UTF-8 仍逐字节注入（fatal 解码不得误伤）', async () => {
  const cjk = '# 中文约定\n- 规则：提交前跑测试，口径见 §6.1\n';
  await withTree({ 'home/AGENTS.md': cjk }, ({ home, cwd }) => {
    const { blocks, notes } = collectAgentsMd({ cwd, home });
    assert.equal(blocks.length, 1, '合法 UTF-8 不得被 fatal 解码误删');
    assert.equal(blocks[0].text, cjk, '中文原文必须逐字节不变（展示用原文，不做任何规范化）');
    assert.deepEqual(notes, [], `合法文件不得产生任何记账：${JSON.stringify(notes)}`);
  });
});

test('M1+B1：超大中文文件被前缀切在字符中间 ⇒ 仍正常截断注入（不误判成非 UTF-8）', async () => {
  // 6000 × '中' = 18000 字节 > 16384 ⇒ 走前缀读；16388 字节 = 5462 个完整字符 + 2 个残留字节
  // ⇒ 尾部正好是个没读完的字符：那是**读法**造成的不完整，不是文件不是 UTF-8。
  await withTree({ 'home/AGENTS.md': '中'.repeat(6000) }, ({ home, cwd }) => {
    const { blocks, notes } = collectAgentsMd({ cwd, home });
    assert.equal(blocks.length, 1, `前缀切断不得误伤合法 UTF-8（notes=${JSON.stringify(notes)}）`);
    assert.equal(blocks[0].truncated, true);
    assert.doesNotMatch(blocks[0].text, /\uFFFD/, '截断点必须落在字符边界（出现 U+FFFD 就是改写了原文）');
    assert.ok(blocks[0].text.startsWith('中'), '截断只砍尾部');
    assert.deepEqual(notes, []);
  });
});

test('全链超上限：从内层开始截，平台节保持完整', async () => {
  const body = (tag) => `# ${tag}\n${'y'.repeat(80)}`;
  await withTree({
    'home/AGENTS.md': body('platform'),
    'home/projects/AGENTS.md': body('workspace'),
    'home/projects/proj/AGENTS.md': body('project'),
  }, ({ home, cwd }) => {
    const limits = { maxFileBytes: 200, maxTotalBytes: 150 };
    const { blocks, notes } = collectAgentsMd({ cwd, home, limits });
    assert.deepEqual(blocks.map((b) => b.scope), ['platform'],
      '全链超限必须**从内层开始丢**：平台节装的是运行期硬约束，丢了它等于把注入的意义丢掉');
    assert.equal(blocks[0].truncated, false, '平台节必须完整（不是截断，而是把内层整份挤掉）');
    assert.equal(notes.filter((n) => n.includes('全链上限')).length, 2, '被挤掉的每一份都要记账');
    assert.ok(notes.some((n) => n.includes('~/projects/AGENTS.md')), '记账必须点名被挤掉的是哪一份');
  });
});

test('symlink 越界（~/projects/AGENTS.md -> home 之外）⇒ 跳过 + note', async () => {
  await withTree({
    'home/AGENTS.md': PLATFORM,
    'outside/secret.md': '# 不该被注入\n',
  }, ({ root, home, cwd }) => {
    fs.symlinkSync(path.join(root, 'outside', 'secret.md'), path.join(home, 'projects', 'AGENTS.md'));
    const { blocks, notes } = collectAgentsMd({ cwd, home });
    assert.deepEqual(blocks.map((b) => b.scope), ['platform'], 'symlink 逃出 home 的内容一个字节都不许注入');
    assert.ok(notes.some((n) => n.includes('越出')), `越界要记账，实际 notes=${JSON.stringify(notes)}`);
  });
});

test('EACCES（读不动）⇒ 跳过 + note，绝不抛（run 不能因为约定文件读不到而失败）', async () => {
  await withTree({
    'home/AGENTS.md': PLATFORM,
    'home/projects/AGENTS.md': WORKSPACE,
  }, ({ home, cwd }) => {
    const blocked = path.join(home, 'projects', 'AGENTS.md');
    // 注入一个 fs 门面：只有那一份读不动（真实环境里造 EACCES 要动权限且受 umask/属主影响）
    const facade = {
      ...fs,
      readFileSync: (target, ...rest) => {
        if (target === blocked) {
          const err = new Error(`EACCES: permission denied, open '${target}'`);
          err.code = 'EACCES';
          throw err;
        }
        return fs.readFileSync(target, ...rest);
      },
    };
    let collected;
    assert.doesNotThrow(() => { collected = collectAgentsMd({ cwd, home, fs: facade }); },
      '任何读取失败都必须降级为跳过——抛出去就是整条 run 失败');
    assert.deepEqual(collected.blocks.map((b) => b.scope), ['platform']);
    assert.ok(collected.notes.some((n) => n.includes('EACCES')), `读失败要记账，实际 notes=${JSON.stringify(collected.notes)}`);
  });
});

test('非普通文件（同名目录）⇒ 跳过 + note', async () => {
  await withTree({
    'home/AGENTS.md': PLATFORM,
    'home/projects/AGENTS.md': null, // 目录，不是文件
  }, ({ home, cwd }) => {
    const { blocks, notes } = collectAgentsMd({ cwd, home });
    assert.deepEqual(blocks.map((b) => b.scope), ['platform']);
    assert.ok(notes.some((n) => n.includes('不是普通文件')), `要记账，实际 notes=${JSON.stringify(notes)}`);
  });
});

test('空文件 / 全空白文件 ⇒ 跳过（不产生空节）', async () => {
  await withTree({
    'home/AGENTS.md': PLATFORM,
    'home/projects/AGENTS.md': '   \n\t\n  \n',
  }, ({ home, cwd }) => {
    const { blocks } = collectAgentsMd({ cwd, home });
    assert.deepEqual(blocks.map((b) => b.scope), ['platform'], '全空白等于没写，注入它只会让模型以为「这里本来就没规矩」');
  });
});

test('子目录索引：≤ 上限条、只列路径、不含正文', async () => {
  const files = { 'home/AGENTS.md': PLATFORM };
  for (let i = 0; i < AGENTS_MD_MAX_SUBDIR_HINTS + 2; i += 1) {
    files[`home/projects/proj/repo${i}/AGENTS.md`] = `# 子仓 ${i}\n- 秘密正文 ${i}\n`;
  }
  await withTree(files, ({ home, cwd }) => {
    const { blocks, subdirHints } = collectAgentsMd({ cwd, home });
    assert.equal(blocks.length, 1, '子目录里的约定**不进 blocks**（只列索引，不注入正文）');
    assert.equal(subdirHints.length, AGENTS_MD_MAX_SUBDIR_HINTS, `索引条数上限是 ${AGENTS_MD_MAX_SUBDIR_HINTS}`);
    assert.deepEqual(subdirHints, subdirHints.slice().sort(), '索引必须排序（readdir 顺序不保证 ⇒ 不排序就不确定）');
    for (const hint of subdirHints) assert.match(hint, /^~\/projects\/proj\/repo\d\/AGENTS\.md$/);
    const rendered = renderAgentsMdSection({ blocks, subdirHints });
    assert.doesNotMatch(rendered, /秘密正文/, '索引里绝不能夹带正文');
    for (const hint of subdirHints) assert.ok(rendered.includes(hint), '索引路径必须出现在渲染里');
  });
});

test('确定性：同一输入两次调用，输出逐字节相同（禁时间戳 / run id / 随机量）', async () => {
  await withTree({
    'home/AGENTS.md': PLATFORM,
    'home/projects/AGENTS.md': WORKSPACE,
    'home/projects/proj/AGENTS.md': PROJECT,
    'home/projects/proj/repo/AGENTS.md': '# 子仓\n',
    'home/projects/proj/repo2/AGENTS.md': '# 子仓 2\n',
  }, ({ home, cwd }) => {
    const a = renderAgentsMdSection(collectAgentsMd({ cwd, home }));
    const b = renderAgentsMdSection(collectAgentsMd({ cwd, home }));
    assert.equal(a, b, 'system 是 prompt 缓存的稳定前缀：同一输入必须逐字节相同');
    // 显式反向自证：常见的三种「每次都不一样」的东西一个都不许出现
    assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, '渲染里不得出现时间戳（会让整条前缀缓存失效）');
    assert.doesNotMatch(a, /\b(run|attempt)[ _-]?id\b/i, '渲染里不得出现 run id / attempt id');
    assert.doesNotMatch(a, /\bgeneration\b/i, '渲染里不得出现 manifest generation');
  });
});

test('抬头必须写清四句语义：由外到内 / 平台节不可覆盖且冲突要告知用户 / 已在上下文别重复 cat / 本 run 改动下次生效', async () => {
  await withTree({ 'home/AGENTS.md': PLATFORM }, ({ home, cwd }) => {
    const rendered = renderAgentsMdSection(collectAgentsMd({ cwd, home }));
    assert.match(rendered, /由外到内/, '① 顺序语义（越靠后越具体）');
    assert.match(rendered, /不可被下层覆盖/, '② 平台节不可覆盖');
    assert.match(rendered, /按平台节执行/, '② 冲突时按平台节执行（裁决 ①）');
    assert.match(rendered, /告知用户/, '② 冲突必须在回复里告知用户（否则用户不知道自己那份被无视了）');
    assert.match(rendered, /不要重复 `cat`/, '③ 已在上下文里，别重复 cat');
    assert.match(rendered, /不会立刻生效/, '④ 本 run 内改动不立刻生效');
    assert.match(rendered, /下一次 run/, '④ 下次 run 才生效');
  });
});

test('cwd 不在 home 之下 ⇒ 只读 cwd 那份 + 一条 note', async () => {
  await withTree({
    'home/AGENTS.md': PLATFORM,
    'elsewhere/AGENTS.md': PROJECT,
  }, ({ root, home }) => {
    const outsideCwd = path.join(root, 'elsewhere');
    const { blocks, notes } = collectAgentsMd({ cwd: outsideCwd, home });
    assert.deepEqual(blocks.map((b) => b.scope), ['project'], 'home 不是祖先 ⇒ 祖先链不成立，只取 cwd 那份');
    assert.equal(blocks[0].dir, outsideCwd);
    assert.ok(notes.some((n) => n.includes('不在 home')), `要记账，实际 notes=${JSON.stringify(notes)}`);
  });
});

test('无 blocks ⇒ renderAgentsMdSection 返回空串（system 必须逐字节等于原值）', () => {
  assert.equal(renderAgentsMdSection({ blocks: [] }), '', '没有约定文件的 run 不能因为本功能改变 system 一个字节');
  assert.equal(renderAgentsMdSection({}), '', '缺参也必须是空串，不许抛');
  // notes 非空但 blocks 为空 ⇒ 仍然是空串（记账不能把空节变成有内容）
  assert.equal(renderAgentsMdSection({ blocks: [], notes: ['跳过 ~/projects/AGENTS.md：EACCES'] }), '');
  // #451 评审 M2 的取舍（口径 8「无注入 ⇒ system 逐字节不变」压过口径 7「子目录索引」）：
  // 产品行为维持现状，但口径必须写死在这里（设计稿 §4.1 规则 7 / user-space.md / AGENTS.md §8.91 同一口径）。
  assert.equal(renderAgentsMdSection({ blocks: [], subdirHints: ['~/repo-a/AGENTS.md'] }), '',
    'blocks 为空时子目录索引也不单独出现（索引不能把空段变成有内容）');
});

// M2 的可观测性补偿：`blocks=[]` 时 notes / subdirHints 都进不了 prompt ⇒ 日志是唯一通道。
test('#451 M2：worker 的 info 记账必须拼上前 2 条 note 摘要（仍是 MSG.LOG，不新增事件类型）', () => {
  const src = fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8');
  const at = src.indexOf('agents-md injected:');
  assert.notEqual(at, -1, 'info 记账必须在：§6.2 D4 靠它量注入成本');
  const block = src.slice(Math.max(0, at - 1600), at + 500);
  assert.match(block, /type: MSG\.LOG,[^\n]*level: 'info'/, '必须复用现成 MSG.LOG（不新增事件类型）');
  assert.match(block, /notes=\$\{agentsMd\.notes\.length\}\$\{[A-Za-z_$][\w$]*\}/,
    'notes=N 后面必须紧跟 note 摘要：blocks=[] 时 notes 根本不会出现在 prompt 里，没这条就只能猜');
  assert.match(block, /agentsMd\.notes\.slice\(0, *2\)/, '摘要只取前 2 条（日志长度不能没上限地长）');
  assert.match(block, /\.join\('; '\)/, '多条 note 用 "; " 分隔');
  assert.match(block, /notes\.length > 2 \? '…'/, '超过 2 条必须以 … 收尾（让人知道还有）');
  assert.doesNotMatch(src, /MSG\.AGENTS/i, '不得为此新增事件类型（模块抬头：不新增事件类型 / 错误码）');
});

test('常量与名字是接口的一部分（下游 worker 与文档都按这些名字说话）', () => {
  assert.equal(AGENTS_MD_BASENAME, 'AGENTS.md');
  assert.equal(AGENTS_MD_MAX_FILE_BYTES, 16 * 1024);
  assert.equal(AGENTS_MD_MAX_TOTAL_BYTES, 48 * 1024);
  assert.equal(AGENTS_MD_MAX_SUBDIR_HINTS, 5);
});

// ---------------------------------------------------------------------------
// 返修 F1：**采集器绝不抛**。主 agent 亲审实测：`collectAgentsMd({})` / `{cwd}` / `{home}` 全抛
// `The "paths[0]" argument must be of type string`（`path.resolve(undefined)` 在 `realpathOr` 的 try 外）。
// 为什么这是真缺口而不是洁癖：这次采集在 `worker.js` 的 `startRun` 里、`runToolLoop` **之前**，
// 抛出去 = worker 进程死 ⇒ agentd 当崩溃处理 → requeue → 3 次 attempt 耗尽，用户只看到
// 「attempts exhausted」，而根因只是一个参数形态不对（工单 §4.5「失败一律降级」）。
// ---------------------------------------------------------------------------

/** 返回值的形状必须永远合法（下游 renderAgentsMdSection 直接拆这些字段）。 */
function assertCollectedShape(result, label) {
  assert.equal(typeof result, 'object', `${label}：必须返回对象`);
  assert.ok(Array.isArray(result.blocks), `${label}：blocks 必须是数组`);
  assert.equal(typeof result.totalBytes, 'number', `${label}：totalBytes 必须是数字`);
  assert.ok(Array.isArray(result.notes), `${label}：notes 必须是数组`);
  assert.ok(Array.isArray(result.subdirHints), `${label}：subdirHints 必须是数组`);
  assert.ok(result.notes.length > 0, `${label}：降级必须记账（否则宿主日志里什么都看不见）`);
}

test('F1：参数缺失 / 非字符串 / 空串时 collectAgentsMd 绝不抛，降级为空结果 + note', () => {
  // 主 agent 实测过的三格 + 三个额外形态（null 整体、空串、非字符串）
  const cases = [
    ['{}', {}],
    ['{ cwd }', { cwd: '/tmp' }],
    ['{ home }', { home: '/tmp' }],
    ['null', null],
    ['{ cwd: "" }', { cwd: '' }],
    ['{ cwd: 42 }', { cwd: 42 }],
  ];
  for (const [label, args] of cases) {
    let result;
    assert.doesNotThrow(() => { result = collectAgentsMd(args); },
      `collectAgentsMd(${label}) 必须降级不得抛：抛出去就是 worker 进程死 → requeue → attempts exhausted`);
    assertCollectedShape(result, label);
  }
  // 口径：cwd 不可用 ⇒ 不采集（不能凭空造一个工作目录）
  assert.deepEqual(collectAgentsMd({}).blocks, [], 'cwd 不可用时不得注入任何文件');
  assert.equal(collectAgentsMd({}).totalBytes, 0);
  assert.deepEqual(collectAgentsMd({}).subdirHints, []);
});

test('F1：home 不可用时只按 cwd 采集（平台节/跨项目节不注入）+ 一条 note', async () => {
  await withTree({ 'home/AGENTS.md': PLATFORM }, ({ home, cwd }) => {
    // 控制组：home 正常 ⇒ 平台节在
    assert.deepEqual(collectAgentsMd({ cwd, home }).blocks.map((b) => b.scope), ['platform']);
    // home 不可用 ⇒ 仍然能跑，只是少一节（boundary 退回 cwd，不得把所有文件都判成「越界」）
    const degraded = collectAgentsMd({ cwd, home: '' });
    assertCollectedShape(degraded, 'home 不可用');
    assert.ok(degraded.notes.some((n) => n.includes('home 不可用')), `要记账，实际 notes=${JSON.stringify(degraded.notes)}`);
    assert.equal(degraded.blocks.every((b) => b.scope === 'project'), true,
      'home 不可用 ⇒ 没有平台/跨项目节可言，任何节的 scope 都不得冒充 platform');
  });
});

test('F1：resolveAgentsMdChain 对不可用输入返回空数组（口径：没有 cwd 就没有候选链）', () => {
  for (const args of [{}, null, { home: '/tmp' }, { cwd: '' }, { cwd: 42 }]) {
    let chain;
    assert.doesNotThrow(() => { chain = resolveAgentsMdChain(args); },
      `resolveAgentsMdChain(${JSON.stringify(args)}) 必须不抛`);
    assert.deepEqual(chain, [], `${JSON.stringify(args)}：cwd 不可用 ⇒ 空链（不凭空造 process.cwd()）`);
  }
  // home 不可用但 cwd 可用 ⇒ 只给 cwd 一项，scope = project
  const onlyCwd = resolveAgentsMdChain({ cwd: '/tmp' });
  assert.deepEqual(onlyCwd.map((e) => e.dir), ['/tmp']);
  assert.equal(onlyCwd[0].scope, 'project');
});

// ---------------------------------------------------------------------------
// 接线源码级锁（与 system-prompt.test.js 里那两条并列的第三条）：**采集与渲染都在 startRun 函数体内，
// 且被同一个 try/catch 包住**。
// 变异（评审 M3 / m1 的判据，主 agent 验收会做）：
//   ① 把采集整段（含 try/catch）移到模块顶层 ⇒ 这条与 system-prompt 锁① 必须红（旧锁看不见：它 `slice` 到**文件末尾**）；
//   ② 只把 `renderAgentsMdSection(...)` 移出 try ⇒ 这条必须红（m1：旧锁 20/20 全绿，而注释承诺的是「采集与渲染各包一层」）。
// ---------------------------------------------------------------------------

/**
 * #451 评审 M3：`startRun` 的**函数体边界**。定界口径：`startRun` 是 2 空格缩进的 `async function startRun(`，
 * 函数体以**行首** `}` 收尾 ⇒ 从 `startRunAt` 找第一个 `\n}`。⚠ **不要用括号计数**：worker.js 里有模板字符串
 * 与正则字面量，`(` `)` 数不干净。（与 system-prompt.test.js 的同名 helper 故意各留一份。）
 */
function startRunBodyRange(src) {
  const startRunAt = src.indexOf('async function startRun(');
  assert.notEqual(startRunAt, -1, 'worker.js 必须仍有 `async function startRun(`');
  const rel = src.slice(startRunAt).search(/\n\}/);
  assert.notEqual(rel, -1, 'startRun 必须以行首 `}` 收尾（找不到 = 缩进形态变了，这条锁要跟着改而不是放宽）');
  return { startRunAt, endAt: startRunAt + rel };
}

function inStartRunBody(name, at, { startRunAt, endAt }) {
  assert.ok(at > startRunAt && at < endAt,
    `「${name}」必须落在 startRun **函数体内**（实际 index=${at}，体内区间=[${startRunAt}, ${endAt}]）：` +
    'worker 进程会被 agentd 复用给下一个 run，搬到模块顶层 = 第二个 run 沿用第一个 run 的内容（或启动时的空快照）');
}

test('接线锁③：采集与渲染都在 startRun **函数体内**、且落在同一个 try 块里（catch 置空注入段 + 发 warn）', () => {
  const src = fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8');
  const range = startRunBodyRange(src);
  const collectAt = src.indexOf('collectAgentsMd(');
  const renderAt = src.indexOf('renderAgentsMdSection(');
  const systemAt = src.indexOf('system: SYSTEM_PROMPT + agentsMdSection');
  assert.notEqual(collectAt, -1, '必须仍有采集调用');
  assert.notEqual(renderAt, -1, '必须仍有渲染调用');
  inStartRunBody('collectAgentsMd(', collectAt, range);
  inStartRunBody('renderAgentsMdSection(', renderAt, range);
  inStartRunBody('system: SYSTEM_PROMPT + agentsMdSection', systemAt, range);
  // 语义锁（M3）：采集用的是本 run 的 cwd ⇒ 必须在解构 msg 之后
  const msgAt = src.indexOf('const { task, cwd } = msg;');
  assert.notEqual(msgAt, -1, 'startRun 必须仍从 msg 解构 `{ task, cwd }`：采集的 cwd 就来自这里');
  assert.ok(collectAt > msgAt,
    '采集必须在 `const { task, cwd } = msg;` **之后**：抢在解构之前就不可能拿到本 run 的 cwd（= 不是 per-run 的）');
  // 采集与渲染必须在同一个 try 里（m1）
  const tryAt = src.lastIndexOf('try {', collectAt);
  assert.notEqual(tryAt, -1,
    '采集前必须有 `try {`：本段在 runToolLoop 之前，抛出去就是 worker 进程死 → requeue → attempts exhausted');
  assert.ok(tryAt > range.startRunAt, 'try 本身也必须在 startRun 体内（函数外的 try 兜不到函数内的局部变量）');
  const catchAt = src.indexOf('catch', collectAt);
  assert.notEqual(catchAt, -1, '采集之后必须有 catch（只有 try 没有 catch 等于没兜）');
  assert.ok(catchAt < range.endAt, 'catch 必须在 startRun 体内');
  assert.ok(catchAt - collectAt < 800, 'catch 必须紧跟着这段采集，不是文件后面某个无关的 catch');
  assert.ok(tryAt < renderAt && renderAt < catchAt,
    '渲染必须落在**同一个 try 块内**（try < render < catch）：renderAgentsMdSection 抛出去没人兜就是 worker 进程死，' +
    '而 worker.js 那段注释承诺的是「采集/渲染整段再包一层 try/catch」');
  const catchBlock = src.slice(catchAt, Math.min(catchAt + 600, range.endAt));
  assert.match(catchBlock, /agentsMdSection = ''/,
    'catch 里必须把注入段置空（否则可能带着半成品拼进 system）');
  assert.match(catchBlock, /MSG\.LOG[\s\S]{0,160}level: 'warn'/, 'catch 里必须发一条 MSG.LOG warn（不新增事件类型）');
  // catch 里不得再抛：出现 throw 就是「降级」变成「换一种死法」
  assert.doesNotMatch(catchBlock, /\bthrow\b/, 'catch 里再抛是禁止的：那只是把同一个死法往后挪几行');
});
