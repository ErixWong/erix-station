#!/usr/bin/env node
// @ts-check
// 热层预算闸（issue 无：261110 热层清退 S3）。
// 只管三件事：① 热层字节预算（预算是派生量，只有 --sync 能写）；② 逐单台账不许长在热层；
// ③ 手抄的「当下状态」断言（pin / tag / version / 测试条数）——这类数一旦写下就腐烂，
//    今天已经抓到三处失效断言，见 docs/maintenance/task-ledger.md §8.115。
// 另外现算 `§8.N` 引用面作为**只升不降的地板**：掉了说明有人改号或删了引用 = 坐标断链。

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

function countRefs() {
  const out = execFileSync('grep', ['-rho', '§8\\.[0-9]\\+', '--include=*.md', '.'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20,
  });
  return out.split('\n').filter(Boolean).length;
}

function refFiles() {
  const out = execFileSync('grep', ['-rl', '§8\\.', '--include=*.md', '.'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20,
  });
  return out.split('\n').filter(Boolean).length;
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
  const refs = countRefs();
  const floor = reg ? reg.refFloor : refs;
  say(refs >= floor, 'ledger-ref-floor',
    `§8.N 引用 ${refs} 处 / ${refFiles()} 个文件，地板 ${floor}`,
    '引用变少 = 有人改号或删了引用；编号是解析坐标，不许重排');

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

  if (args.has('--sync')) {
    const next = {
      hotBytesBudget: budgetFor(hotBytes),
      refFloor: Math.max(refs, reg ? reg.refFloor : 0),
      measuredHotBytes: hotBytes,
      measuredTotalBytes: total,
      measuredRefs: refs,
      note: '派生量：只有 `npm run check:agents-hotlayer -- --sync` 能写；手改视为伪造读数',
    };
    writeFileSync(REG, JSON.stringify(next, null, 2) + '\n');
    console.log(`sync: 写入 ${path.relative(ROOT, REG)} 预算 ${next.hotBytesBudget} 地板 ${next.refFloor}`);
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
