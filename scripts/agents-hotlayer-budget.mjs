#!/usr/bin/env node
// @ts-check
// 热层预算闸（issue 无：261110 热层清退 S3）。
// 只管三件事：① 热层字节预算（预算是派生量，只有 --sync 能写）；② 逐单台账不许长在热层；
// ③ 手抄的「当下状态」断言（pin / tag / version / 测试条数）——这类数一旦写下就腐烂，
//    今天已经抓到三处失效断言，见 docs/maintenance/task-ledger.md §8.115。
// 另外现算 `§8.N` 引用面作为**只升不降的地板**：掉了说明有人改号或删了引用 = 坐标断链。
//
// ⚠ **引用口径 = 只数 git 跟踪的 `.md`**（PR #498 的 CI 红就是这条口径缺失造成的）：
//   早先用 `grep -r --include=*.md .` 从仓库根数 ⇒ 把 `.gitignore` 掉的本地过程产物
//   （`.work-orders/`、`tasks/`）一起数进来，本地脏树 610 处 / 53 个文件 vs 干净 checkout
//   528 / 31（差 82 处 / 22 个文件全是脏文件白送的）。地板又是 `--sync` 在脏树上写的 ⇒
//   **本地永远假绿、CI 永远红**，闸自己变成了假绿发生器。跟踪态天然排除脏文件，
//   所以**不 hardcode 目录名**（今天屏蔽 `.work-orders/`，明天冒出别的目录照样骗过去）。
//   地板**降**必须走 `--rebaseline="<理由>"`（显式、留原因与测量口径），`--sync` 只抬不降。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = path.join(ROOT, 'AGENTS.md');
const LEDGER = path.join(ROOT, 'docs/maintenance/task-ledger.md');
const REG = path.join(ROOT, 'scripts/agents-hotlayer-budget.json');
const args = new Set(process.argv.slice(2));

const BANNED = [
  {
    name: 'hand-copied-pin',
    re: /(当前|现状|最新)[^\n]{0,24}(pin|版本|version|tag)[^\n]{0,24}\d+\.\d+\.\d+/i,
    hint: '别在 AGENTS.md 里写死版本号；写现读命令（`node -p "require(\'./package.json\').version"`）',
  },
  {
    name: 'hand-copied-suite-count',
    re: /(2\d{3}\s*\/\s*2\d{3}|项数\s*[:=]\s*\d{3,}|测试\s*\d{3,}\s*(项|条|个))/,
    hint: '门禁现价由 docs/ops/ci-release.md §1 单独持有，热层只放指针',
  },
  {
    name: 'hand-copied-tool-count',
    re: /\b\d+\s*(个|条)?\s*(工具|tools)\b/i,
    hint: '工具条数让网关现报（`mcp({ server })`），别抄',
  },
];

function read(f) {
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

// 热层 = `## 8.` 标题之前的全部字节（§8 起是逐单台账的指针与引言）
function splitHot(text) {
  const i = text.search(/^## 8\. erix-agent 依赖与升级$/m);
  assert(i >= 0, '找不到 §8 标题，热层边界无法确定');
  return { hot: text.slice(0, i), hotBytes: Buffer.byteLength(text.slice(0, i), 'utf8') };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** 读 `--flag=值`（也支持 `--flag 值`）；没给这个 flag 时返回 undefined。 */
function readArgValue(flag) {
  const argv = process.argv.slice(2);
  const hit = argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (hit === undefined) return undefined;
  if (hit.startsWith(`${flag}=`)) return hit.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  return argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
}

/** git 输出（拿不到就当空，不影响判定：它只用于**登记现场**）。 */
function gitOutput(gitArgs) {
  try {
    return execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 << 20 }).trimEnd();
  } catch {
    return '';
  }
}

/** 引用面的测量口径（写进登记表，让「地板是怎么量出来的」可追溯）。 */
const REF_INSTRUMENT = `git ls-files '*.md' + /§8\\.[0-9]+/g 现算（只数 git 跟踪的 .md）`;

/**
 * **只数 git 跟踪的 `.md`**。
 * 为什么不能 `grep -r --include=*.md .`：那会把被 `.gitignore` 忽略的本地过程产物也数进去，
 * 本地脏树因此比 CI 干净 checkout 多出一截（见文件头 ⚠），地板一旦被脏树 `--sync` 写高就再也追不上。
 * `git ls-files` 是**跟踪态**，天然排除未跟踪与被忽略的文件；工作区里被改过的跟踪文件
 * 仍按工作区内容读（改号/删引用当场可见，不用先提交）。
 * @returns {string[]} 相对 ROOT 的路径（已滤掉工作区里删掉的）
 */
function trackedMarkdown() {
  let out = '';
  try {
    out = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z', '--', '*.md'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 8 << 20,
    });
  } catch (/** @type {any} */ e) {
    assert(false, `git ls-files 跑不动（本闸的引用口径依赖 git）：${e && e.message ? e.message : e}`);
  }
  return out.split('\0').filter(Boolean).filter((rel) => existsSync(path.join(ROOT, rel)));
}

/** 一次扫描同时给出「引用处数」与「含引用的文件数」，两个读数不可能来自两套口径。 */
function scanRefs() {
  if (scanRefs._cache) return scanRefs._cache;
  let refs = 0;
  let files = 0;
  for (const rel of trackedMarkdown()) {
    const hits = readFileSync(path.join(ROOT, rel), 'utf8').match(/§8\.[0-9]+/g) || [];
    if (hits.length > 0) files++;
    refs += hits.length;
  }
  // 脏树遮丑必须当场看得见：把「被排除的那些 md 本来会白送多少处引用」也数出来。
  // CI 干净 checkout 上这里是 0 ⇒ 那一行不带尾巴，本地脏树才会多出一截（就是 PR #498 那 82 处）。
  const others = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', '*.md'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 8 << 20,
  }).split('\0').filter(Boolean);
  let ignoredFiles = 0;
  let ignoredRefs = 0;
  for (const rel of others) {
    const hits = readFileSync(path.join(ROOT, rel), 'utf8').match(/§8\.[0-9]+/g) || [];
    if (hits.length > 0) {
      ignoredFiles++;
      ignoredRefs += hits.length;
    }
  }
  scanRefs._cache = { refs, files, ignoredFiles, ignoredRefs };
  return scanRefs._cache;
}

function countRefs() {
  return scanRefs().refs;
}

function refFiles() {
  return scanRefs().files;
}

/** 派生预算：向上取整到 512 再加 1024 余量 */
const budgetFor = (n) => Math.ceil(n / 512) * 512 + 1024;

function selfTest() {
  const cases = [
    ['当前 pin：0.29.0', 'hand-copied-pin'],
    ['现状：tag `v0.1.1` vs `package.json` 0.1.0', 'hand-copied-pin'],
    ['门禁现价 2136 / 2132 / 0 / 4', 'hand-copied-suite-count'],
    ['本仓 mysql 28 tools', 'hand-copied-tool-count'],
    // 反向：这些必须**不**被抓（§8 指针里合法出现版本号与编号）
    ['写侧预写改走引擎 `appendUserTurn`，见 §8.4；0.16.0 见 §8.5', null],
    ['- pin 以 `package.json` 的 `erix-agent` 字段现读为准，本页不写死版本号', null],
  ];
  let red = 0;
  for (const [line, want] of cases) {
    const hit = BANNED.find((b) => b.re.test(line));
    const got = hit ? hit.name : null;
    const ok = got === want;
    if (!ok) red++;
    console.log(`${ok ? 'ok  ' : 'RED '} self-test ${JSON.stringify(line).slice(0, 46)} => ${got} (want ${want})`);
  }
  console.log(`self-test: ${cases.length - red}/${cases.length} ok`);
  return red === 0 ? 0 : 1;
}

function main() {
  if (args.has('--self-test')) return selfTest();
  const agents = read(AGENTS);
  assert(agents.length > 0, '读不到 AGENTS.md');
  const { hotBytes } = splitHot(agents);
  const total = Buffer.byteLength(agents, 'utf8');
  const reg = existsSync(REG) ? JSON.parse(read(REG)) : null;
  let reds = 0;
  const say = (ok, name, detail, hint) => {
    if (!ok) reds++;
    console.log(`${ok ? 'ok  ' : 'RED '} ${name}: ${detail}${ok || !hint ? '' : `\n      ↳ ${hint}`}`);
  };

  // ① 台账不许长在热层
  const ledgerHeads = (agents.match(/^#{3,4} 8\.\d+ /gm) || []).length;
  say(ledgerHeads === 0, 'ledger-stays-out-of-hot',
    `AGENTS.md 里 ` + '`### 8.N`' + ` 标题 ${ledgerHeads} 个（应为 0）`,
    '新账写 docs/maintenance/task-ledger.md，见 §6');

  // ② 手抄的当下断言
  for (const b of BANNED) {
    const lines = agents.split('\n');
    const hits = [];
    lines.forEach((l, i) => { if (b.re.test(l)) hits.push(`${i + 1}: ${l.trim().slice(0, 88)}`); });
    say(hits.length === 0, b.name, hits.length ? hits.join('\n      ') : '无手抄的当下断言', b.hint);
  }

  // ③ 字节预算（预算是派生量）
  const budget = reg ? reg.hotBytesBudget : budgetFor(hotBytes);
  say(hotBytes <= budget, 'hot-byte-budget',
    `热层（§8 之前）${hotBytes} 字节，预算 ${budget}；全文 ${total} 字节`,
    `超预算就搬去 docs/maintenance/；确属每轮判据才可 \`npm run check:agents-hotlayer -- --sync\` 抬预算`);

  // ④ §8.N 引用地板（只升不降）
  const { refs, ignoredFiles, ignoredRefs } = scanRefs();
  const floor = reg ? reg.refFloor : refs;
  say(refs >= floor, 'ledger-ref-floor',
    `§8.N 引用 ${refs} 处 / ${refFiles()} 个文件，地板 ${floor}`
    + `（口径：只数 git 跟踪的 .md${ignoredFiles > 0
      ? `；未跟踪/被忽略的 .md 里还有 ${ignoredFiles} 个含引用、本来会白送 ${ignoredRefs} 处，**没算进来**`
      : ''}）`,
    '引用变少 = 有人改号或删了引用；编号是解析坐标，不许重排。'
    + '确实要**降**地板：`npm run check:agents-hotlayer -- --rebaseline="<理由>"`（显式重基线，会写原因）。');

  // ⑤ 台账必须存在且条目唯一
  const led = read(LEDGER);
  const heads = led.match(/^### 8\.\d+ /gm) || [];
  const nums = heads.map((h) => h.match(/8\.\d+/)[0]);
  const dupes = [...new Set(nums.filter((n, i) => nums.indexOf(n) !== i))];
  assert(nums.includes('8.1'), '台账里找不到 `### 8.1`');
  assert(nums.includes('8.114') && nums.includes('8.115'), '台账里找不到新约定之后的 8.114 / 8.115');
  say(nums.length >= 113 && dupes.length === 0, 'ledger-integrity',
    `台账条目 ${nums.length} 个${dupes.length ? `，重复编号：${dupes.join(' ')}` : '，无重复编号'}`,
    '重复编号会让数百处引用指到两个地方');

  const REBASELINE_NOTE = '派生量：只有 `--sync`（抬预算/抬地板）或 `--rebaseline="<理由>"`（显式重基线地板）能写；手改视为伪造读数';

  if (args.has('--sync')) {
    const next = {
      // 保住登记表里已有的可追溯字段（尤其重基线的原因与测量口径）——只覆盖派生数本身。
      ...(reg ?? {}),
      hotBytesBudget: budgetFor(hotBytes),
      // **只升不降**：sync 从不降地板（PR #498 的教训之一就是把降地板的希望寄托在 sync 上，
      // 而 `Math.max` 会把旧的高地板原样保住，看上去像「sync 修不好这条红」）。
      refFloor: Math.max(refs, reg ? reg.refFloor : 0),
      measuredHotBytes: hotBytes,
      measuredTotalBytes: total,
      measuredRefs: refs,
      note: REBASELINE_NOTE,
    };
    writeFileSync(REG, JSON.stringify(next, null, 2) + '\n');
    console.log(`sync: 写入 ${path.relative(ROOT, REG)} 预算 ${next.hotBytesBudget} 地板 ${next.refFloor}`);
    return 0;
  }

  // 显式重基线：**降地板必须有理由、有口径、有现场**，不许静默改数。
  // 引用面「只升不降」这条纪律本身没废：重基线之后 sync 依旧只抬不降。
  const rebaselineReason = readArgValue('--rebaseline');
  if (rebaselineReason !== undefined) {
    const reason = rebaselineReason.trim();
    if (reason.length < 10) {
      console.log('RED  --rebaseline 必须带理由（`--rebaseline="<为什么降>"`，至少 10 字）：'
        + '地板降下来是一次可见的决策，不是改数');
      return 1;
    }
    const next = {
      ...(reg ?? {}),
      // 字节预算**不动**：`--rebaseline` 只管引用地板这一件事（其余检查项的行为不许顺带改）。
      // 不这么写的话，地板重基线会连带把 hotBytesBudget 按当前热层重算——热层缩了就会**悄悄降预算**，
      // 那是另一个闸的地板被这条顺手改了，越界。
      hotBytesBudget: reg && reg.hotBytesBudget ? reg.hotBytesBudget : budgetFor(hotBytes),
      refFloor: refs,            // ← 这里**就是**与 sync 的唯一区别：按现值重置，不取 max
      measuredHotBytes: hotBytes,
      measuredTotalBytes: total,
      measuredRefs: refs,
      refFloorMeasuredWith: REF_INSTRUMENT,
      refFloorReason: reason,
      refFloorTreeHead: gitOutput(['rev-parse', '--short', 'HEAD']) || '(无提交)',
      refFloorTreeDirty: gitOutput(['status', '--porcelain']).length > 0,
      note: REBASELINE_NOTE,
    };
    writeFileSync(REG, JSON.stringify(next, null, 2) + '\n');
    const was = reg ? reg.refFloor : '(无登记表)';
    console.log(`rebaseline: 地板 ${was} → ${next.refFloor}（口径 ${REF_INSTRUMENT}；`
      + `HEAD ${next.refFloorTreeHead}，工作区${next.refFloorTreeDirty ? '脏' : '干净'}）`);
    console.log(`            理由：${reason}`);
    return 0;
  }
  if (!reg) {
    console.log('RED  登记表缺失：先跑 `npm run check:agents-hotlayer -- --sync`');
    return 1;
  }
  console.log(reds === 0 ? `VERDICT ok（热层 ${hotBytes} / 预算 ${budget}）` : `VERDICT red（${reds} 条）`);
  return reds === 0 ? 0 : 1;
}

process.exit(main());
