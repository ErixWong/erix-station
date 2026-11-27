#!/usr/bin/env node
// 「本轮新增的临时目录必须为 0」的机闸（issue #875）。
//
// 只做机械判定，不审语义：前缀清单**从源码现取**（扫 `portal runner test scripts` 里的
// mkdtempSync(path.join(os.tmpdir(), '<前缀>' 调用），拿跑测试**之前**的 /tmp 清单当基线，
// 跑完之后只数「基线里没有、现在出现了」的那些目录。存量不算账（本机 /tmp 是已知的脏盘，
// 工单明确不清存量），新增才是本轮泄漏。
//
// 三条设计约束（都是踩过的坑）：
//   1. 脚本里**不许出现任何字面前缀**（一个真实前缀字面量都不写）：硬编码 = 源码改了闸不变宽，
//      而它照样报绿。清单必须每次现取，扫不到就是扫不到。
//   2. 前缀清单为空 ⇒ 退出码 **2**（不是 0）。扫不到前缀 = 扫描面变了 = 闸瞎了，
//      瞎了必须报，不许静默绿。
//   3. 只报不删：闸里没有任何 rm。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 扫描面：会建 /tmp 夹具的源码目录（工单指定）。 */
const DEFAULT_ROOTS = ['portal', 'runner', 'test', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);
/** mkdtempSync(path.join(os.tmpdir(), '<前缀>' —— 两种引号、多余空白都认。 */
const MKDTEMP_RE = /mkdtempSync\(\s*path\.join\(\s*os\.tmpdir\(\)\s*,\s*(['"])([^'"]+)\1/g;
const MKDTEMP_LOOSE_RE = /mkdtempSync\s*\(/g;

export function collectPrefixes({ roots = DEFAULT_ROOTS, repoRoot = REPO_ROOT } = {}) {
  const hits = new Map(); // prefix -> [{ file, line }]
  let callSites = 0; // mkdtempSync( 出现次数（含认不出字面前缀的）
  let filesScanned = 0;
  const missingRoots = [];
  for (const root of roots) {
    const abs = path.resolve(repoRoot, root);
    let st = null;
    try {
      st = fs.statSync(abs);
    } catch {
      missingRoots.push(root);
      continue;
    }
    if (!st.isDirectory()) {
      // 根指到一个文件（扫描面被人改窄了）：当单个文件扫，不炸。空清单自有 rc=2 接手。
      if (/\.(c|m)?js$/.test(abs)) {
        filesScanned++;
        scanFile(abs, repoRoot, hits, (n) => (callSites += n));
      }
      continue;
    }
    for (const file of walkJs(abs)) {
      filesScanned++;
      scanFile(file, repoRoot, hits, (n) => (callSites += n));
    }
  }
  return {
    prefixes: [...hits.keys()].sort(),
    occurrences: hits,
    callSites,
    filesScanned,
    missingRoots,
    roots: [...roots],
  };
}

function scanFile(file, repoRoot, hits, countCallSites) {
  const source = fs.readFileSync(file, 'utf8');
  countCallSites([...source.matchAll(MKDTEMP_LOOSE_RE)].length);
  for (const m of source.matchAll(MKDTEMP_RE)) {
    const prefix = m[2];
    if (!prefix) continue;
    const line = source.slice(0, m.index).split('\n').length;
    const rel = path.relative(repoRoot, file).split(path.sep).join('/');
    if (!hits.has(prefix)) hits.set(prefix, []);
    hits.get(prefix).push({ file: rel, line });
  }
}

function* walkJs(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.pipeline') {
      if (entry.isDirectory()) continue; // .git / .next 之类
    }
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkJs(abs);
    } else if (/\.(c|m)?js$/.test(entry.name)) {
      yield abs;
    }
  }
}

/** /tmp 顶层的**目录**名（只报不删，这里也不碰非目录）。 */
export function scanTmpDirs(tmpDir = os.tmpdir()) {
  const names = [];
  for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
    if (entry.isDirectory()) names.push(entry.name);
  }
  return names;
}

export function writeBaseline(file, tmpDir = os.tmpdir()) {
  const names = scanTmpDirs(tmpDir);
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), tmpDir, names }));
  return names;
}

export function readBaseline(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.names) ? parsed : null;
  } catch {
    return null;
  }
}

export function countByPrefix({ names, prefixes }) {
  const out = [];
  for (const prefix of prefixes) {
    const matched = names.filter((n) => n.startsWith(prefix));
    if (matched.length > 0) out.push({ prefix, count: matched.length, names: matched });
  }
  return out;
}

/** 跑完之后调用：新增（基线里没有的名字）里有多少落在现取前缀上。 */
export function checkTmpHygiene({
  tmpDir = os.tmpdir(),
  roots = DEFAULT_ROOTS,
  repoRoot = REPO_ROOT,
  baselineFile = null,
  sinceMs = null,
} = {}) {
  const scan = collectPrefixes({ roots, repoRoot });
  const result = {
    tmpDir,
    roots: scan.roots,
    missingRoots: scan.missingRoots,
    prefixes: scan.prefixes,
    occurrences: scan.occurrences,
    prefixCount: scan.prefixes.length,
    callSites: scan.callSites,
    filesScanned: scan.filesScanned,
    baselineFile,
    baselineCount: null,
    baselineMissing: false,
    sinceMs,
    currentCount: 0,
    newCount: 0,
    offenders: [],
    code: 0,
  };
  if (result.prefixCount === 0) {
    result.code = 2; // 扫描面变了 ⇒ 闸瞎了，不许静默 0
    return result;
  }
  let current;
  try {
    current = scanTmpDirs(tmpDir);
  } catch (e) {
    result.error = `打不开 ${tmpDir}：${e.code || e.message}`;
    result.code = 2;
    return result;
  }
  result.currentCount = current.length;

  let newNames;
  const baseline = baselineFile ? readBaseline(baselineFile) : null;
  if (baseline) {
    result.baselineCount = baseline.names.length;
    const seen = new Set(baseline.names);
    newNames = current.filter((n) => !seen.has(n));
  } else if (sinceMs != null) {
    result.baselineMissing = true; // 无基线，改用 mtime 窗口
    newNames = current.filter((n) => {
      try {
        return fs.statSync(path.join(tmpDir, n)).mtimeMs >= sinceMs;
      } catch {
        return false;
      }
    });
  } else {
    result.baselineMissing = true; // 无基线也无窗口 ⇒ 无法界定"本轮"，如实报，不假装 0
    newNames = null;
    result.code = 1;
    return result;
  }
  result.newCount = newNames.length;
  result.offenders = countByPrefix({ names: newNames, prefixes: result.prefixes }).sort((a, b) => b.count - a.count);
  result.code = result.offenders.length > 0 ? 1 : 0;
  return result;
}

const DEFAULT_BASELINE_NAME = '.check-tmp-hygiene.baseline'; // 不匹配任何现取前缀

function parseArgs(argv) {
  const opts = { snapshot: false, verbose: false, maxNames: 5, rootArgs: null, tmp: null, baseline: null, since: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'snapshot') opts.snapshot = true;
    else if (a === 'check') opts.snapshot = false;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--tmp') opts.tmp = argv[++i];
    else if (a === '--baseline') opts.baseline = argv[++i];
    else if (a === '--roots') opts.rootArgs = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--since') opts.since = Number(argv[++i]);
    else if (a === '--max-names') opts.maxNames = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

export function runCli(argv) {
  const opts = parseArgs(argv);
  const tmpDir = opts.tmp ?? os.tmpdir();
  const baselineFile = opts.baseline ?? path.join(tmpDir, DEFAULT_BASELINE_NAME);
  if (opts.snapshot) {
    const scan = collectPrefixes({ roots: opts.rootArgs ?? DEFAULT_ROOTS });
    if (scan.prefixes.length === 0) {
      console.log(`现取前缀清单为空（扫描面 ${scan.roots.join(', ')}）⇒ 闸瞎了，不写基线，退出码 2`);
      return 2;
    }
    const names = writeBaseline(baselineFile, tmpDir);
    console.log(`基线已写入 ${baselineFile}：${names.length} 个 /tmp 顶层目录（现取前缀 ${scan.prefixes.length} 个）`);
    return 0;
  }
  const r = checkTmpHygiene({
    tmpDir,
    roots: opts.rootArgs ?? DEFAULT_ROOTS,
    baselineFile,
    sinceMs: opts.since,
  });
  const scanNote = r.prefixCount === 0 ? '未扫（清单为空就不必去看 /tmp）' : `${r.tmpDir} 现有 ${r.currentCount} 个顶层目录`;
  const head = `tmp 卫生闸（issue #875）｜扫描面 ${r.roots.join(', ')}｜现取前缀 ${r.prefixCount} 个（扫 ${r.filesScanned} 个 js/mjs、${r.callSites} 处 mkdtempSync）｜${scanNote}`;
  if (r.prefixCount === 0) {
    console.log(`${head}\n前缀清单为空：扫描面变了（扫不到 mkdtempSync 的字面前缀），闸无法判定，不许静默绿 ⇒ rc=2`);
    if (r.missingRoots.length) console.log(`扫描目录不存在：${r.missingRoots.join(', ')}`);
    return 2;
  }
  if (r.error) {
    console.log(`${head}\nBLOCKED: ${r.error} ⇒ rc=2`);
    return 2;
  }
  if (r.baselineMissing) {
    console.log(`${head}\n没有可用基线（${r.baselineFile}）：无法界定「本轮」，不许假装 0 —— 先跑 \`node scripts/check-tmp-hygiene.mjs snapshot\` 再跑测试 ⇒ rc=1`);
    return 1;
  }
  if (r.offenders.length === 0) {
    console.log(`${head}\n本轮新增落在现取前缀上的临时目录：0 个（基线 ${r.baselineCount} → 现 ${r.currentCount}）⇒ 干净，rc=0`);
    return 0;
  }
  const total = r.offenders.reduce((s, o) => s + o.count, 0);
  console.log(`${head}\n本轮新增 ${total} 个残留，按前缀：`);
  for (const o of r.offenders) {
    const shown = o.names.slice(0, opts.maxNames).join(', ');
    const more = o.count > opts.maxNames ? ` …（另 ${o.count - opts.maxNames} 个）` : '';
    console.log(`  ${o.prefix}：积了 ${o.count} 个 —— ${shown}${more}`);
    if (opts.verbose) {
      const where = (r.occurrences?.get?.(o.prefix) || []).map((h) => `${h.file}:${h.line}`).join(', ');
      if (where) console.log(`    建它的地方：${where}`);
    }
  }
  console.log('谁建谁收尾：mkdtempSync 之后必须在**同一条用例**里注册 rm（afterEach / t.after），不许靠进程退出，也不许在闸里 rm。');
  return 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (e) {
    // 任何意外都不许以 stack trace + rc=1 收场（和「有残留」撞码）：闸自己不可用 = 瞎了 = 2。
    console.log(`tmp 卫生闸自己挂了（不是“没残留”也不是“有残留”，是没法判）：${e && e.stack ? e.stack.split('\n')[0] : e} ⇒ rc=2`);
    process.exitCode = 2;
  }
}
