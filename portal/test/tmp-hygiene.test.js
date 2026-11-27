// 单测：scripts/check-tmp-hygiene.mjs —— 「本轮新增临时目录必须为 0」的机闸（issue #875）。
// 这里测的是**闸本身**：清单是不是现取的、瞎了会不会报、有残留会不会红、文案点不点名、只报不删。
// 全部跑在假 /tmp + 假扫描根（fixture）上：不碰真 /tmp，也不依赖本机存量（本机 /tmp 有两万多个历史目录）。
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  collectPrefixes,
  scanTmpDirs,
  checkTmpHygiene,
  writeBaseline,
  readBaseline,
  runCli,
} from '../../scripts/check-tmp-hygiene.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'check-tmp-hygiene.mjs');

// 这条测试自己在查泄漏，自己更不许漏：夹具一律登记 + afterEach 删。
const bases = [];
function newBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-hygiene-test-'));
  bases.push(base);
  fs.mkdirSync(path.join(base, 'tmp'), { recursive: true });
  return base;
}
afterEach(() => {
  while (bases.length > 0) fs.rmSync(bases.pop(), { recursive: true, maxRetries: 3 });
});

/** 造一个「仓库 + /tmp」的最小现场：sources 写进扫描面，tmpDirs 当作 /tmp 里的目录。 */
function fixture(base, { sources = {}, tmpDirs = [] } = {}) {
  for (const [rel, text] of Object.entries(sources)) {
    const abs = path.join(base, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  for (const n of tmpDirs) fs.mkdirSync(path.join(base, 'tmp', n), { recursive: true });
  return { root: base, tmp: path.join(base, 'tmp'), baseline: path.join(base, 'bl.json') };
}

/** 只认退出码：真起子进程跑 CLI，绕过 runCli 的返回值。 */
function cli(args, cwd = REPO) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}
function captureLog(sink, fn) {
  const orig = console.log;
  console.log = (...a) => sink.push(a.join(' '));
  try {
    return fn();
  } finally {
    console.log = orig;
  }
}

test('①前缀清单是从源码现取的：闸里不许出现任何字面前缀（硬编码 = 源码改了闸不跟着变宽，还照样报绿）', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const literals = src.match(/['"`][A-Za-z0-9_.\-]*[Ee]rix[A-Za-z0-9_.\-]*['"`]/g) || [];
  assert.deepEqual(literals, [], `闸里出现了硬编码字面前缀：${literals.join(', ')}`);
  assert.match(src, /os\.tmpdir\(\)/, '清单必须来自对 os.tmpdir() 调用点的扫描');

  // 现取要真取到东西，并能指回建它的源码位置。
  const scan = collectPrefixes({ repoRoot: REPO });
  assert.ok(scan.prefixes.length > 0, '扫描面扫不出任何前缀 = 调用形状变了，闸已瞎');
  assert.ok(
    [...scan.occurrences.values()].flat().some((h) => h.file === 'portal/test/gitlight.test.js'),
    'gitlight 夹具的 mkdtemp 前缀必须被现取到（它就是本单钉的对象）',
  );

  // 换一份源码就换一份清单 —— 证明它不是把某张表背下来了。
  const f = fixture(newBase(), { sources: { 'portal/test/a.test.js': "fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-fixture-zz-'));\n" } });
  assert.deepEqual(collectPrefixes({ repoRoot: f.root }).prefixes, ['hygiene-fixture-zz-']);
  assert.equal(collectPrefixes({ repoRoot: f.root, roots: ['runner'] }).prefixes.length, 0, '换个扫描根就该换清单（扫描根是真的在扫，不是背表）');
  assert.ok(scan.prefixes.includes('hygiene-fixture-zz-'), '本文件自己写的 mkdtemp 字面量也该被现取到（现取无特权）');
});

test('②扫描面变了（清单为空）⇒ 退出码 2，不许静默 0；瞎了时连基线都不许写', () => {
  const f = fixture(newBase(), { sources: { 'portal/test/plain.test.js': 'const x = 1;\n' }, tmpDirs: ['anything-1'] });
  assert.equal(collectPrefixes({ repoRoot: f.root }).prefixes.length, 0);
  assert.equal(checkTmpHygiene({ tmpDir: f.tmp, repoRoot: f.root, baselineFile: f.baseline }).code, 2);
  assert.equal(checkTmpHygiene({ tmpDir: f.tmp, repoRoot: f.root, roots: ['nope'] }).code, 2, '扫描目录整个不存在 = 同一条腿');

  const lines = [];
  const code = captureLog(lines, () => runCli(['--roots', path.join(f.root, 'portal'), '--tmp', f.tmp, '--baseline', f.baseline]));
  assert.equal(code, 2);
  assert.match(lines.join('\n'), /前缀清单为空|闸瞎/, '瞎了必须说清自己瞎了');
  const snap = captureLog([], () => runCli(['snapshot', '--roots', path.join(f.root, 'portal'), '--tmp', f.tmp, '--baseline', f.baseline]));
  assert.equal(snap, 2);
  assert.equal(fs.existsSync(f.baseline), false, '瞎了写的基线是一张空账，不如不写');
});

test('③本轮新增前缀目录 ⇒ 必须红，文案点名「哪个前缀积了几个」', () => {
  const f = fixture(newBase(), {
    sources: {
      'portal/test/a.test.js': "fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-fixture-a-'));\n",
      'runner/test/b.test.js': "fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-fixture-b-'));\n",
    },
    tmpDirs: ['hygiene-fixture-a-1', 'hygiene-fixture-a-2', 'hygiene-fixture-b-1', 'unrelated-keepme'],
  });
  const r = checkTmpHygiene({ tmpDir: f.tmp, repoRoot: f.root });
  assert.equal(r.baselineMissing, true, '没有基线时不许假装数到了 0');
  assert.equal(r.code, 1, '没基线又没法界定本轮 ⇒ 如实报红，不许绿');

  // 存量不算账：同样这些目录全在基线里 ⇒ 绿。
  writeBaseline(f.baseline, f.tmp);
  assert.equal(checkTmpHygiene({ tmpDir: f.tmp, repoRoot: f.root, baselineFile: f.baseline }).code, 0);

  // 基线之后各新增一个 ⇒ 红，且逐前缀点名（存量那两个不许算进来）。
  fs.mkdirSync(path.join(f.tmp, 'hygiene-fixture-a-9'));
  fs.mkdirSync(path.join(f.tmp, 'hygiene-fixture-b-9'));
  const dirty = checkTmpHygiene({ tmpDir: f.tmp, repoRoot: f.root, baselineFile: f.baseline });
  assert.equal(dirty.code, 1);
  assert.deepEqual(dirty.offenders.map((o) => [o.prefix, o.count]), [['hygiene-fixture-a-', 1], ['hygiene-fixture-b-', 1]]);
  assert.deepEqual(dirty.offenders[0].names, ['hygiene-fixture-a-9'], '只许数基线之后新增的，存量不许混进来');

  const lines = [];
  const code = captureLog(lines, () => runCli(['--roots', path.join(f.root, 'portal') + ',' + path.join(f.root, 'runner'), '--tmp', f.tmp, '--baseline', f.baseline]));
  assert.equal(code, 1);
  const text = lines.join('\n');
  assert.match(text, /hygiene-fixture-a-：积了 1 个/, `失败文案必须点名前缀与数量：${text}`);
  assert.match(text, /hygiene-fixture-b-：积了 1 个/);
  assert.match(text, /谁建谁收尾/);
  assert.doesNotMatch(text, /unrelated-keepme/, '不在现取清单里的名字不许算账');
});

test('④只报不删：闸跑完目录一个不少（闸里没有任何 rm）', () => {
  const f = fixture(newBase(), {
    sources: { 'portal/test/a.test.js': "fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-fixture-a-'));\n" },
    tmpDirs: ['hygiene-fixture-a-1', 'hygiene-fixture-keep'],
  });
  writeBaseline(f.baseline, f.tmp);
  fs.mkdirSync(path.join(f.tmp, 'hygiene-fixture-a-2'));
  assert.equal(checkTmpHygiene({ tmpDir: f.tmp, repoRoot: f.root, baselineFile: f.baseline }).code, 1);
  assert.deepEqual(scanTmpDirs(f.tmp).sort(), ['hygiene-fixture-a-1', 'hygiene-fixture-a-2', 'hygiene-fixture-keep']);
  assert.equal(runCli(['--roots', path.join(f.root, 'portal'), '--tmp', f.tmp, '--baseline', f.baseline]), 1);
  assert.deepEqual(scanTmpDirs(f.tmp).sort(), ['hygiene-fixture-a-1', 'hygiene-fixture-a-2', 'hygiene-fixture-keep'], 'CLI 跑完也不许动盘');
});

test('⑤基线缺失/坏了不许假装 0；mtime 窗口是同一语义的替代腿', () => {
  const f = fixture(newBase(), { sources: { 'portal/test/a.test.js': "fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-fixture-a-'));\n" }, tmpDirs: ['hygiene-fixture-a-1'] });
  assert.equal(readBaseline(f.baseline), null);
  assert.equal(checkTmpHygiene({ tmpDir: f.tmp, repoRoot: f.root, baselineFile: f.baseline }).code, 1);
  assert.equal(runCli(['--roots', path.join(f.root, 'portal'), '--tmp', f.tmp, '--baseline', f.baseline]).status ?? runCli(['--roots', path.join(f.root, 'portal'), '--tmp', f.tmp, '--baseline', f.baseline]), 1);

  fs.writeFileSync(f.baseline, 'not json');
  assert.equal(checkTmpHygiene({ tmpDir: f.tmp, repoRoot: f.root, baselineFile: f.baseline }).code, 1, '基线坏了不许当没新增');
  fs.writeFileSync(f.baseline, JSON.stringify({ names: 42 }));
  assert.equal(checkTmpHygiene({ tmpDir: f.tmp, repoRoot: f.root, baselineFile: f.baseline }).code, 1, '形状不对同样不许绿');

  assert.equal(checkTmpHygiene({ tmpDir: f.tmp, repoRoot: f.root, sinceMs: Date.now() + 60_000 }).code, 0, '窗口比目录新 ⇒ 本轮没建过东西 ⇒ 0');
  assert.equal(checkTmpHygiene({ tmpDir: f.tmp, repoRoot: f.root, sinceMs: Date.now() - 60_000 }).code, 1);
});

test('⑥真 CLI：snapshot→check 的退出码 0/1/2 三条腿都走一遍', () => {
  const f = fixture(newBase(), { sources: { 'portal/test/a.test.js': "fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-fixture-a-'));\n" }, tmpDirs: ['hygiene-fixture-a-1'] });
  const roots = path.join(f.root, 'portal');
  const common = ['--roots', roots, '--tmp', f.tmp, '--baseline', f.baseline];
  assert.equal(cli(['snapshot', ...common]).status, 0);
  assert.ok(fs.existsSync(f.baseline), 'snapshot 必须真的落盘');
  assert.equal(cli(['check', ...common]).status, 0);
  fs.mkdirSync(path.join(f.tmp, 'hygiene-fixture-a-2'));
  assert.equal(cli(['check', ...common]).status, 1);
  fs.mkdirSync(path.join(f.root, 'empty'), { recursive: true });
  assert.equal(cli(['check', '--roots', path.join(f.root, 'empty'), '--tmp', f.tmp, '--baseline', f.baseline]).status, 2);
  assert.notEqual(cli(['bogus-arg', '--tmp', f.tmp]).status, 0, '未知参数不许当成功');
});

test('⑦默认扫描面在真仓库上现取得到清单；真 CLI 在本机存量下必须给出可读输出与非空文案', () => {
  const f = fixture(newBase(), { tmpDirs: [] });
  const r = cli(['--tmp', f.tmp, '--baseline', path.join(f.tmp, 'bl.json')]); // 无基线 ⇒ 1
  assert.equal(r.status, 1);
  assert.match(r.stdout, /现取前缀 \d+ 个/);
  assert.match(r.stdout, /没有可用基线|基线/, '不许静默，必须交代为什么报红');
  cli(['snapshot', '--tmp', f.tmp, '--baseline', path.join(f.tmp, 'bl.json')]);
  const clean = cli(['check', '--tmp', f.tmp, '--baseline', path.join(f.tmp, 'bl.json')]);
  assert.equal(clean.status, 0, `空 /tmp + 现取清单应当干净：${clean.stdout}`);
  assert.match(clean.stdout, /干净，rc=0/);
});

test('⑧增量口径必须自带基线年龄（#880：把增量当总账，差过三个数量级）', () => {
  const f = fixture(newBase(), {
    sources: { 'portal/test/a.test.js': "fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-fixture-a-'));\n" },
    tmpDirs: ['hygiene-fixture-a-1'],
  });
  writeBaseline(f.baseline, f.tmp);
  fs.mkdirSync(path.join(f.tmp, 'hygiene-fixture-a-2'));

  const r = checkTmpHygiene({ tmpDir: f.tmp, repoRoot: f.root, baselineFile: f.baseline });
  assert.equal(r.mode, 'baseline', '有基线就必须走增量支');
  assert.ok(typeof r.baselineAt === 'string' && !Number.isNaN(Date.parse(r.baselineAt)),
    `必须带回基线时间戳（writeBaseline 写进去的那个 at）：${JSON.stringify(r.baselineAt)}`);
  assert.equal(typeof r.baselineAgeMin, 'number', '必须算出基线年龄（分钟），否则读的人不知道基线多旧');

  const lines = [];
  const code = captureLog(lines, () => runCli(['check', '--tmp', f.tmp, '--baseline', f.baseline,
    '--roots', path.join(f.root, 'portal')]));
  assert.equal(code, 1);
  const out = lines.join('\n');
  assert.match(out, /基线写入于 \S+（距今 \d+ 分钟）/, `增量输出必须把基线年龄写在脸上：\n${out}`);
  assert.match(out, /不是存量/, '必须提醒这个数只是增量、不是总账（#880 现场：增量 604 / 存量 264163）');
});

test('⑨存量腿（--all）必须严格大于增量，且增量集合 ⊆ 存量集合', () => {
  const f = fixture(newBase(), {
    sources: { 'portal/test/a.test.js': "fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-fixture-a-'));\n" },
    tmpDirs: ['hygiene-fixture-a-1', 'hygiene-fixture-a-2', 'unrelated-keepme'],
  });
  writeBaseline(f.baseline, f.tmp);
  fs.mkdirSync(path.join(f.tmp, 'hygiene-fixture-a-3')); // 基线之后新增的那一个

  const inc = checkTmpHygiene({ tmpDir: f.tmp, repoRoot: f.root, baselineFile: f.baseline });
  const all = checkTmpHygiene({ tmpDir: f.tmp, repoRoot: f.root, baselineFile: f.baseline, all: true });
  assert.equal(all.mode, 'all', 'all=true 必须走存量支（不读基线）');
  assert.deepEqual(inc.offenders.map((o) => o.names).flat(), ['hygiene-fixture-a-3'],
    '增量只许看见基线之后新增的（基线里那两个存量不许混进来）');
  assert.deepEqual(all.offenders.map((o) => o.names).flat().sort(),
    ['hygiene-fixture-a-1', 'hygiene-fixture-a-2', 'hygiene-fixture-a-3'],
    '存量腿必须把基线里的存量也数进来；不匹配任何现取前缀的那个（unrelated-keepme）不算');

  const incNames = new Set(inc.offenders.map((o) => o.names).flat());
  const allNames = new Set(all.offenders.map((o) => o.names).flat());
  for (const n of incNames) assert.ok(allNames.has(n), `同一次现场下增量集合必须是存量集合的子集，存量腿漏了 ${n}`);
  assert.ok(allNames.size > incNames.size, '存量必须严格大于增量，否则这条腿没有意义');

  const lines = [];
  const code = captureLog(lines, () => runCli(['check', '--all', '--tmp', f.tmp, '--baseline', f.baseline,
    '--roots', path.join(f.root, 'portal')]));
  assert.equal(code, 1, '存量存在 ⇒ `--all` 必须红（哪怕增量是绿的）');
  assert.match(lines.join('\n'), /存量 3 个残留/, `必须说明这是存量口径并把三个都算进来：\n${lines.join('\n')}`);
});
