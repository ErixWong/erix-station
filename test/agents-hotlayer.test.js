// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 热层预算闸的落地覆盖（与 scripts/agents-hotlayer-budget.mjs 同源，这里只保证它在 npm test /
// CI 里真的被跑到，并且反向自证成立）。规矩本身见 AGENTS.md §6 与台账 §8.116。
// PR #498 之后再加两条**引用口径**的牙（脏文件不得遮丑、地板真拦得住），台账见 §8.121。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'agents-hotlayer-budget.mjs');

function run(cliArgs) {
  return execFileSync(process.execPath, [CLI, ...cliArgs], {
    cwd: ROOT, encoding: 'utf8',
  });
}

/**
 * 在**夹具**里跑一次并留住退出码与输出（闸红是我们要的读数，不能让它把测试炸成 error）。
 * ⚠ 必须跑夹具里那份副本：脚本的 ROOT 是**从它自己的文件位置**推出来的（`scripts/..`），
 *    跑仓库那份再改 `cwd` 也没用——它会继续数真仓库的文件（我第一版就是这么错的：
 *    夹具读数变成真仓库的 528，两条夹具断言一起红）。
 */
function runCapture(dir, cliArgs) {
  const cli = path.join(dir, 'scripts', 'agents-hotlayer-budget.mjs');
  try {
    return { rc: 0, out: execFileSync(process.execPath, [cli, ...cliArgs], { cwd: dir, encoding: 'utf8' }) };
  } catch (/** @type {any} */ e) {
    return { rc: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

/** 从 `ledger-ref-floor` 那一行里取 (状态, 引用处数, 含引用的文件数, 地板)。 */
function readFloorLine(out) {
  // 取**整行**（不是正则命中的那一段）：口径与被排除的来源都写在行尾，测试要连它一起断言。
  const line = out.split('\n').find((l) => l.includes('ledger-ref-floor:')) ?? '';
  const m = /^(ok|RED)\s+ledger-ref-floor: §8\.N 引用 (\d+) 处 \/ (\d+) 个文件，地板 (\d+)/.exec(line);
  assert.ok(m, `没在输出里找到 ledger-ref-floor 那一行：\n${out}`);
  return { state: m[1], refs: Number(m[2]), files: Number(m[3]), floor: Number(m[4]), line };
}

/**
 * 造一个**独立的小 git 仓库**当夹具（不在本仓里面，也不动真实工作区）：
 * 只有把 CLI 复制进 `<夹具>/scripts/`，它的 ROOT 才会指到夹具，计数口径才可复现。
 * @param {{ refsByFile?: Record<string, string[]> }} [spec]
 */
function makeFixture(spec = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hotlayer-gate-'));
  const g = (/** @type {string[]} */ a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']);
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  mkdirSync(path.join(dir, 'docs/maintenance'), { recursive: true });
  copyFileSync(CLI, path.join(dir, 'scripts', 'agents-hotlayer-budget.mjs'));
  // AGENTS.md：只放热层 + §8 标题，**一个 §8.N 引用都不带**（让期望值只由夹具的 md 决定）
  writeFileSync(path.join(dir, 'AGENTS.md'), '# 夹具热层\n\n判据若干，不写死当下数字。\n\n## 8. erix-agent 依赖与升级\n\n指针：逐单台账在 docs/maintenance/。\n');
  // 台账：造 120 条 `### 8.N` 标题（满足 ledger-integrity 的 113 条下限与 8.1/8.114/8.115 存在性）
  const heads = [];
  for (let i = 1; i <= 120; i++) heads.push(`### 8.${i} 夹具条目\n\n内容。\n`);
  writeFileSync(path.join(dir, 'docs/maintenance/task-ledger.md'), '# 夹具台账\n\n' + heads.join('\n'));
  for (const [rel, refs] of Object.entries(spec.refsByFile ?? {})) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, refs.map((r) => `见 ${r} 的口径。`).join('\n') + '\n');
  }
  g(['add', '-A']);   // 进**索引** = 被跟踪；不再 commit（无提交也能跑，读的是索引 + 工作区内容）
  return dir;
}

/** 夹具里的登记表（地板手动写死，用来验「地板真拦得住」）。 */
function writeFixtureReg(dir, /** @type {number} */ refFloor) {
  writeFileSync(path.join(dir, 'scripts', 'agents-hotlayer-budget.json'), JSON.stringify({
    hotBytesBudget: 19456, refFloor, measuredHotBytes: 0, measuredTotalBytes: 0, measuredRefs: refFloor,
    note: '夹具登记表',
  }, null, 2) + '\n');
}

function readFixtureReg(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'scripts', 'agents-hotlayer-budget.json'), 'utf8'));
}

test('热层预算闸：在最终树上必须全绿（预算/台账/手抄当下数字/引用地板）', () => {
  let out = '';
  try {
    out = run([]);
  } catch (/** @type {any} */ e) {
    assert.fail(`闸门红：\n${e.stdout || ''}${e.stderr || ''}`);
  }
  assert.match(out, /VERDICT ok/);
  assert.doesNotMatch(out, /^RED /m);
});

test('热层预算闸：反向自证——四类手抄当下断言必须被抓，合法写法必须放过', () => {
  const out = run(['--self-test']);
  assert.doesNotMatch(out, /^RED /m, `自证失败：\n${out}`);
  const n = out.split('\n').filter((l) => l.startsWith('ok   self-test')).length;
  assert.ok(n >= 6, `自证用例太少（${n}）：\n${out}`);
});


test('引用口径：只数 git 跟踪的 .md（未跟踪与被忽略的脏文件不得进读数）', (t) => {
  const dir = makeFixture({ refsByFile: {
    'docs/a.md': ['§8.1', '§8.12', '§8.119'],
    'docs/b.md': ['§8.4'],
  } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFixtureReg(dir, 4);

  const base = readFloorLine(runCapture(dir, []).out);
  assert.deepEqual(
    { refs: base.refs, files: base.files, state: base.state },
    { refs: 4, files: 2, state: 'ok' },
    '夹具基线读数不对 ⇒ 计数没照着「git 跟踪的 .md」来');

  // 反向自证①（PR #498 的现场形状）：塞两个脏 md 进来——一个未跟踪、一个被 .gitignore 忽略，
  // 一共 8 处 `§8.N`。**读数必须一字不变**，否则本地脏树会替仓库遮丑（本地绿 / CI 红）。
  writeFileSync(path.join(dir, 'scratch-notes.md'), '§8.1 §8.2 §8.3 §8.4 §8.5\n');
  writeFileSync(path.join(dir, '.gitignore'), 'ignored-docs/\n');
  mkdirSync(path.join(dir, 'ignored-docs'), { recursive: true });
  writeFileSync(path.join(dir, 'ignored-docs/x.md'), '§8.9 §8.10 §8.11\n');

  const dirty = readFloorLine(runCapture(dir, []).out);
  assert.equal(dirty.refs, base.refs, `脏文件进了读数（${base.refs} → ${dirty.refs}）：闸又是假绿发生器`);
  assert.equal(dirty.files, base.files, '含引用的文件数同样不许算脏文件');
  // 而且要把「排除了多少」说出来——不说的话，下一个人根本不知道自己在看哪个口径。
  assert.match(dirty.line, /只数 git 跟踪的 \.md/, '读数必须自带测量口径');
  assert.match(dirty.line, /1 个含引用、本来会白送 3 处/, `被忽略那部分没说出来：\n${dirty.line}`);
});

test('地板有牙：删引用必须掉到地板下；--sync 只抬不降，降地板必须走 --rebaseline 且带理由', (t) => {
  const dir = makeFixture({ refsByFile: {
    'docs/a.md': ['§8.1', '§8.2', '§8.3'],
    'docs/b.md': ['§8.4'],
  } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFixtureReg(dir, 4);
  assert.equal(readFloorLine(runCapture(dir, []).out).state, 'ok', '夹具基线就该是绿的');

  // 反向自证②：删掉**跟踪文件**里的一处引用 ⇒ 读数必须变小，并且**被地板拦住**（改号/删引用就是这个形状）。
  writeFileSync(path.join(dir, 'docs/a.md'), '见 §8.1 的口径。\n见 §8.2 的口径。\n');
  const dropped = runCapture(dir, []);
  const line = readFloorLine(dropped.out);
  assert.equal(line.refs, 3, '删了一处引用而读数没变小 ⇒ 计数没有读工作区里的跟踪文件');
  assert.equal(line.state, 'RED', '掉到地板以下必须报红');
  assert.notEqual(dropped.rc, 0, '地板拦不住 ⇒ 这条闸是装饰品');

  // `--sync` 从不降地板（PR #498 的教训：把希望寄托在 sync 上，`Math.max` 会把旧的高地板原样保住）
  runCapture(dir, ['--sync']);
  assert.equal(readFixtureReg(dir).refFloor, 4, '--sync 把地板降了 ⇒ 「引用面只升不降」这条纪律被绕开');

  // 降地板必须是**看得见、有理由**的重基线：没理由 ⇒ 拒绝，并且一个字都不许改登记表
  const regPath = path.join(dir, 'scripts', 'agents-hotlayer-budget.json');
  const before = readFileSync(regPath, 'utf8');
  assert.notEqual(runCapture(dir, ['--rebaseline=']).rc, 0, '空理由的重基线必须被拒');
  assert.notEqual(runCapture(dir, ['--rebaseline=短']).rc, 0, '一句话打发的理由也必须被拒');
  assert.equal(readFileSync(regPath, 'utf8'), before, '被拒的重基线不许碰登记表');

  const ok = runCapture(dir, ['--rebaseline=旧地板是脏树上量的，含未跟踪 md 白送的引用；按 git 跟踪口径重设']);
  assert.equal(ok.rc, 0, ok.out);
  const reg = readFixtureReg(dir);
  assert.equal(reg.refFloor, 3, '重基线必须按当前真值重置地板（不是取 max）');
  assert.equal(reg.measuredRefs, 3);
  assert.match(reg.refFloorReason, /脏树/, '理由要登记进文件，让下一个人知道为什么降');
  assert.match(reg.refFloorMeasuredWith, /git ls-files/, '测量口径要登记（否则下次又量成别的）');
  assert.ok(typeof reg.refFloorTreeHead === 'string' && reg.refFloorTreeHead.length > 0, '现场 HEAD 要登记');
  assert.equal(typeof reg.refFloorTreeDirty, 'boolean', '现场工作区脏/干净要登记');

  // 重基线之后纪律仍在：sync 只抬不降，且不许把原因与口径抹掉
  runCapture(dir, ['--sync']);
  const after = readFixtureReg(dir);
  assert.equal(after.refFloor, 3, '重基线之后 sync 必须继续只抬不降');
  assert.match(after.refFloorReason, /脏树/, 'sync 不许把重基线的原因抹掉');
  assert.match(after.refFloorMeasuredWith, /git ls-files/);
});

test('真实仓库对账：闸的读数必须等于「git ls-files 独立重算」的值', () => {
  const line = readFloorLine(run([]));
  const tracked = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z', '--', '*.md'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 8 << 20,
  }).split('\0').filter(Boolean).filter((rel) => existsSync(path.join(ROOT, rel)));
  let refs = 0;
  let files = 0;
  for (const rel of tracked) {
    const hits = readFileSync(path.join(ROOT, rel), 'utf8').match(/§8\.[0-9]+/g) || [];
    if (hits.length > 0) files++;
    refs += hits.length;
  }
  assert.equal(line.refs, refs, `闸数到 ${line.refs}，独立重算 ${refs} ⇒ 口径又漂了（脏文件混进来了？）`);
  assert.equal(line.files, files, '含引用的文件数与独立重算不一致');
  assert.match(line.line, /只数 git 跟踪的 \.md/);
});
