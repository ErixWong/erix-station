// issue #442（erix-agent 0.29.0 → 0.30.0）建起、issue #447（0.30.0 → 0.31.0）**翻向**的：
// **零消费者导出**的机器判据。
//
// 病灶（工单 §M1.1）：升级指南 `docs/host-upgrade-guide-0.30.0_cn.md` §2/§3 列了 16 个「零消费者导出」，
// 说它们在 0.30.0 被删除。0.29 → 0.30 的升级动作本身因此退化成「抬版本号」——**而这件事当时只有
// 人工 grep 撑腰**（主 agent 逐个查过，16 个全 0 命中）。人工 grep 的结论不会自己红：上游明天把这
// 16 个名字中的一个从本站的某个文件里「顺手用起来」，没有任何东西会响。
//
// 本文件把那份人工结论换成两条机器判据：
//   ① **零消费者**（真闸门，**永久**）：本站源码里一个名字都不许引用。它必须**现在就是绿的**，且能被变异
//      打红（把一个名字真的 import 进任意一个源码/测试文件 ⇒ 红）。注释不算引用（见 `stripComments`）：
//      「写进注释里提醒自己」是文档，不是依赖——本文件自己的注释里就写着 `createAnthropicProvider`。
//      ⚠ **上游删了也不许撤这一条**：将来上游把某个名字加回来时，Z1 是第一道（也是唯一一道）防线。
//   ② **导出面硬判据**（0.31.0 起）：这 16 个名字在 `.` 与 `./tools` 两个入口上**必须一个都不在**。
//      快照常量 `SURFACE_SNAPSHOT_0_31_0` 两个入口都是 `[]`（0.31.0 实测），现算结果与它逐名相等；
//      `ENGINE_VERSION_MEASURED` 给快照盖版本章，升 pin 时强制重新量一遍。
//
// ⚠ **② 在 0.30.0 上是「快照对账」而不是「必须不在」**，因为**已发布的 0.30.0 一个都没删**：
//   实测证据（2026-11-03，`/tmp/ea30/package` = `npm pack erix-agent@0.30.0` 解包，其 tarball 的
//   `sha1sum` 与 `npm view erix-agent@0.30.0 dist.shasum` = `9cb153da6216cecaf84ba3f2d1e51e31736a08a8`
//   逐字节一致 ⇒ 就是 registry 上那一份）：
//     · `src/index.js` 仍 `export { createAnthropicProvider } from "./providers/anthropic.js"`；
//     · `src/tools/index.js` 仍导出 4 个 provider 工厂 + `removeRecord` / `resolveFileReadMaxBytes` /
//       `setNotesClock` / `NOTE_VALUE_MAX_CHARS`；
//     · 运行时 `await import('erix-agent')` / `await import('erix-agent/tools')` 里 16 个名字**全在**。
//   上游已勘误那一页（issue #686）：0.30.0 只登记、没删；**删除落在 0.31.0**。
//   ⇒ #447 把 ② 翻成它一开始就该是的形状：**「这 16 个名字不许出现在导出面」是一条可执行断言**，
//   不是一句文档。
//
// 0.31.0 实测（2026-11-04，本 worktree 装好的包 + `/tmp/ea31/package` 解包两份互证）：
//   · 运行时 `import('erix-agent')` / `import('erix-agent/tools')` 里 16 个名字**一个都不在**
//     （两个入口的导出名总数分别是 85 / 46）；
//   · `src/index.js` 与 `src/tools/index.js` 的 diff 只有**删行**（再导出表里那 17 行）；
//   · 另外 9 个定义文件的 diff 只有 `@deprecated issue #429: removed in 0.30 → in 0.31` 这一行注释
//     ⇒ 删的是**导出**，不是实现（指南 §2 的承诺在 0.31.0 才成立）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/** 本站**源码**的扫描面（与工单 §M1.3 逐项一致；不含 node_modules / 构建产物）。 */
const SOURCE_ROOTS = [
  'portal/src',
  'portal/test',
  'runner/lib',
  'runner/test',
  'runner/worker.js',
  'runner/agentd.js',
  'portal/frontend/src',
];

/** 本文件自己（它的清单/注释里当然有这些名字）——扫描时跳过。 */
const SELF = fileURLToPath(import.meta.url);

/**
 * 0.30.0 的「零消费者导出」名单（来源：升级指南 §2 的 15 个 + §3 的 `createAnthropicProvider`）。
 * `entry` = 指南「入口」列，也就是它挂在哪个子路径的导出面上。
 */
const ZERO_CONSUMER_EXPORTS = [
  { name: 'createCompositeToolProvider', entries: ['./tools'] },
  { name: 'createEnvModelConfigProvider', entries: ['.'] },
  { name: 'createJsonFileToolProvider', entries: ['./tools'] },
  { name: 'createStaticToolProvider', entries: ['./tools'] },
  { name: 'estimateMessagesTokens', entries: ['.'] },
  { name: 'extractL0', entries: ['.'] },
  { name: 'extractL0Fact', entries: ['.'] },
  { name: 'MESSAGE_OVERHEAD_TOKENS', entries: ['.'] },
  // 指南「入口」列唯一一个写了两个的：`.` + `./tools`（`src/tools/index.js` 与 `src/index.js` 都再导出它）
  { name: 'NOTE_VALUE_MAX_CHARS', entries: ['.', './tools'] },
  { name: 'parseReflectionSummary', entries: ['.'] },
  { name: 'parseSummary', entries: ['.'] },
  { name: 'removeRecord', entries: ['./tools'] },
  { name: 'resolveFileReadMaxBytes', entries: ['./tools'] },
  { name: 'serializeFoldedMessages', entries: ['.'] },
  { name: 'setNotesClock', entries: ['./tools'] },
  { name: 'createAnthropicProvider', entries: ['.'] },
];

/** 快照盖的版本章：这一份「导出面上有谁」是在哪个引擎版本上量的。 */
const ENGINE_VERSION_MEASURED = '0.31.0';

/**
 * **0.31.0 实测快照**：这 16 个名字里，哪些真的出现在导出面上（按入口分组）。
 * 0.31.0 起**两个入口都是空数组**——删除真的落地了（见文件头「0.31.0 实测」）。
 * 现算结果与它不等 ⇒ 红：少了不可能（已经空了），所以红的只有一种情况——**上游把名字加回来了**，
 * 那时本站在这些名字上的「零消费者」结论要重新评估（Z1 是闸门）。
 * 改这一格 = 重新评估，不是「修测试」。
 */
const SURFACE_SNAPSHOT_0_31_0 = {
  '.': [],
  './tools': [],
};

// ---------------------------------------------------------------------------
// 已安装引擎：包根定位 + 导出面现算
// ---------------------------------------------------------------------------

/** 定位**装在本 worktree 里的**引擎根目录（与 `event-surface-contract.test.js` 同一手法）。 */
function engineRoot() {
  // 不用 `resolve('erix-agent/package.json')`：引擎 `exports` 没列 `./package.json`
  // ⇒ `ERR_PACKAGE_PATH_NOT_EXPORTED`（实测）。解析主入口再向上找包根。
  let dir = path.dirname(createRequire(import.meta.url).resolve('erix-agent'));
  while (dir !== path.dirname(dir)) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).name === 'erix-agent') return dir;
    dir = path.dirname(dir);
  }
  throw new Error('找不到已安装 erix-agent 的包根');
}

/**
 * 从一份**包内源文件**里解析它真正 `export` 出去的名字（`export { a, b as c } from "…"` 与
 * 本地 `export const/function/class`）。不做 AST：引擎的入口文件是一张扁平的再导出表，
 * 两种形态就够；解析不到（形态变了）⇒ 返回空集，由调用方按「现算面可疑」抛错。
 */
function exportedNames(file) {
  if (!fs.existsSync(file)) throw new Error(`引擎包结构变了，找不到 ${file}`);
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/g)) {
    for (const part of m[1].split(',')) {
      const token = part.trim();
      if (token === '') continue;
      const aliased = token.split(/\s+as\s+/);
      names.add((aliased[1] ?? aliased[0]).trim());
    }
  }
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  return names;
}

const engine = engineRoot();
const engineVersion = JSON.parse(fs.readFileSync(path.join(engine, 'package.json'), 'utf8')).version;
const surface = {
  '.': exportedNames(path.join(engine, 'src', 'index.js')),
  './tools': exportedNames(path.join(engine, 'src', 'tools', 'index.js')),
};

// ---------------------------------------------------------------------------
// 本站源码：注释剥离 + 逐名扫描
// ---------------------------------------------------------------------------

/**
 * 去掉 `//` 行注释与 `/* … *\/` 块注释，**保留字符串字面量里的同形片段**。
 * 注释不是引用（本文件自己的注释里就写着 `createAnthropicProvider`）；字符串里出现才是。
 * 不追求 JS 词法完备：只处理「引号字符串 / 模板串 / 注释」三种上下文切换，够判「引用 / 不引用」。
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote !== null) {
      out += ch;
      if (ch === '\\') { out += source[i + 1] ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.vue']);

/** 扫描面里的全部源文件（绝对路径）。 */
function sourceFiles() {
  const files = [];
  const walk = (target) => {
    const abs = path.join(ROOT, target);
    if (!fs.existsSync(abs)) return; // 目录被搬走 ⇒ 由下面「扫描面为空」的断言兜（不静默少扫）
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      if (SCAN_EXTENSIONS.has(path.extname(abs))) files.push(abs);
      return;
    }
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      walk(path.join(target, entry.name));
    }
  };
  for (const target of SOURCE_ROOTS) walk(target);
  return files;
}

const scan = sourceFiles().filter((file) => file !== SELF).map((file) => ({
  file: path.relative(ROOT, file),
  text: stripComments(fs.readFileSync(file, 'utf8')),
}));

// ---------------------------------------------------------------------------
// 判据 ①：零消费者（真闸门）
// ---------------------------------------------------------------------------

test('Z0 扫描面非空且覆盖工单点名的 7 个源码根（扫描面被搬走时先红在这里）', () => {
  assert.ok(scan.length >= 200, `只扫到 ${scan.length} 个源文件，扫描面可疑（应为数百）`);
  for (const target of SOURCE_ROOTS) {
    const abs = path.join(ROOT, target);
    assert.ok(fs.existsSync(abs), `扫描根不存在：${target}（搬走了就必须同步改本测，别静默少扫）`);
    assert.ok(
      scan.some((entry) => entry.file === target || entry.file.startsWith(`${target}${path.sep}`)),
      `扫描根 ${target} 一个文件都没进扫描面`,
    );
  }
  // 反向：确认剥注释真的在干活（否则 ① 会把注释里的名字也算成引用，判据变成假红）
  assert.equal(stripComments('// createAnthropicProvider\nconst x = 1;').includes('createAnthropicProvider'), false);
  assert.equal(stripComments('/* estimateMessagesTokens */ const y = 2;').includes('estimateMessagesTokens'), false);
  assert.equal(stripComments('const z = "parseSummary";').includes('parseSummary'), true);
});

test('Z1 这 16 个零消费者导出：本站源码里一个都不 import / 不引用（注释不算）', () => {
  const hits = [];
  for (const { name } of ZERO_CONSUMER_EXPORTS) {
    // 词边界：`extractL0` 不能命中 `extractL0Facts`（后者是 0.30 之后的**合法**替代品）。
    const re = new RegExp(`\\b${name}\\b`, 'g');
    for (const entry of scan) {
      const found = entry.text.match(re);
      if (found) hits.push(`${entry.file} ×${found.length} → ${name}`);
    }
  }
  assert.deepEqual(hits, [],
    '本站源码引用了上游登记的零消费者导出（它们的删除是 0.30 破坏包的一部分；'
    + '要么改用替代品，要么把这条依赖登记进 AGENTS.md 并重开这张工单）：\n' + hits.join('\n'));
});

// ---------------------------------------------------------------------------
// 判据 ②：导出面硬判据（版本章 + 「一个都不在」）
// ---------------------------------------------------------------------------

test('Z2 导出面快照盖的是**当前装着的**引擎版本（升 pin 后必须重新量一遍）', () => {
  assert.equal(engineVersion, ENGINE_VERSION_MEASURED,
    `引擎已从 ${ENGINE_VERSION_MEASURED} 升到 ${engineVersion}：`
    + '`SURFACE_SNAPSHOT_0_31_0` 与 `ENGINE_VERSION_MEASURED` 必须在新版本上**重新量**，'
    + '并重新决定这 16 个名字是「仍然已删（继续钉不在场）」还是「被加回来了（重评 Z1）」。');
});

test('Z3 这 16 个名字必须**一个都不在**导出面上（0.31.0 起是硬判据，不是快照对账）', () => {
  for (const entry of ['.', './tools']) {
    assert.ok(surface[entry].size >= 20,
      `从 ${entry} 入口只解析到 ${surface[entry].size} 个导出名，解析姿势可疑（入口文件形态变了？）`);
    const names = ZERO_CONSUMER_EXPORTS
      .filter((item) => item.entries.includes(entry))
      .map((item) => item.name);
    const measured = names.filter((name) => surface[entry].has(name)).sort();
    assert.deepEqual(measured, SURFACE_SNAPSHOT_0_31_0[entry],
      `${entry} 入口上这 16 个名字的**在场情况**与 0.31.0 实测快照（应为空）不一致：\n`
      + `  现算 = ${JSON.stringify(measured)}\n`
      + `  快照 = ${JSON.stringify(SURFACE_SNAPSHOT_0_31_0[entry])}\n`
      + '上游把名字加回来了 ⇒ 本站在这些名字上的「零消费者」结论要重新评估（Z1 是闸门）：\n'
      + '要么把新用途登记进 AGENTS.md 并重开一张工单，要么把调用点改掉；\n'
      + '⚠ 不许为了让它变绿把 Z3 改回去/删掉——它是「这 16 个名字不许出现在导出面」的唯一可执行断言。');
  }
});

test('Z4 名单自身自洽：16 个名字、无重复、入口只有 `.` / `./tools`', () => {
  assert.equal(ZERO_CONSUMER_EXPORTS.length, 16, '升级指南 §2 是 15 个 + §3 的 1 个 = 16');
  const names = ZERO_CONSUMER_EXPORTS.map((item) => item.name);
  assert.equal(new Set(names).size, names.length, `名单里有重复项：${names.join(', ')}`);
  for (const item of ZERO_CONSUMER_EXPORTS) {
    assert.ok(Array.isArray(item.entries) && item.entries.length > 0, `${item.name} 没写入口`);
    for (const entry of item.entries) {
      assert.ok(entry === '.' || entry === './tools', `${item.name} 的入口写成 ${entry}`);
    }
  }
  // `NOTE_VALUE_MAX_CHARS` 在指南里是**两个入口都有**的唯一一个（`.` + `./tools`）。
  // ⚠ 0.31.0 翻向时这两条从「快照里两边都有它」改成「**名单**里两边都挂着它 + 快照两边都有这一格
  //   （值均为空）」：同一个事实（它是唯一的两入口名字）从名单侧 + 快照结构侧**双向**钉，比原先只查
  //   快照内容更强（原先那两条在 `[]` 快照上恒假，不是「放宽」而是「换到不会随方向失效的那一侧」）。
  const twoEntry = ZERO_CONSUMER_EXPORTS.filter((item) => item.entries.length === 2);
  assert.deepEqual(twoEntry.map((item) => item.name), ['NOTE_VALUE_MAX_CHARS'],
    '两入口名字有且只有 NOTE_VALUE_MAX_CHARS 一个');
  assert.deepEqual(twoEntry[0].entries, ['.', './tools']);
  assert.deepEqual(Object.keys(SURFACE_SNAPSHOT_0_31_0).sort(), ['.', './tools']);
  assert.deepEqual(SURFACE_SNAPSHOT_0_31_0['.'], []);
  assert.deepEqual(SURFACE_SNAPSHOT_0_31_0['./tools'], []);
});
