#!/usr/bin/env node
// @ts-check
// 热层预算闸。
// 只管两件事：① AGENTS.md 的字节预算（本页每次 agent run 全额注入，写超了就是每轮都在烧 token）；
// ② 手抄的「当下状态」断言（pin / tag / version / 测试条数）——这类数一旦写下就腐烂。
// 另外现算余量：预算内但快满时打 WARN（绿只说明没越线，不说明还写得下东西）。
//
// ⚠ 逐单台账已退役（2026-11-25 用户裁定）：本闸不再数 `§8.N` 引用、不再维护引用地板。
//   一单做了什么写在 issue / PR 正文；以后还要遵守的判据写 AGENTS.md（须用户拍板）；
//   环境 / 参数 / 坐标事实写 `docs/`。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = path.join(ROOT, 'AGENTS.md');
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** 热层 = 整份 AGENTS.md（逐单台账退役后，全文都是每轮注入的 policy 层）。 */
function measure(text) {
  const bytes = Buffer.byteLength(text, 'utf8');
  return { hotBytes: bytes, total: bytes };
}

/** 预算 = **显式目标值**，不由实测派生（派生预算会跟着热层一起涨，等于没有预算）。 */
const HOT_BYTES_TARGET = 20480;
const budgetFor = () => HOT_BYTES_TARGET;

/** 余量告警带：实测进到「预算 − 1024」以内就报 WARN（绿但快满，不是红）。 */
const HEADROOM_WARN = 1024;

function selfTest() {
  const cases = [
    ['当前 pin：0.29.0', 'hand-copied-pin'],
    ['现状：tag `v0.1.1` vs `package.json` 0.1.0', 'hand-copied-pin'],
    ['门禁现价 2136 / 2132 / 0 / 4', 'hand-copied-suite-count'],
    ['本仓 mysql 28 tools', 'hand-copied-tool-count'],
    // 反向：这些必须**不**被抓
    ['- pin 以 `package.json` 的 `erix-agent` 字段现读为准，本页不写死版本号', null],
    ['门禁现价由 `docs/ops/ci-release.md` §1 单独持有', null],
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
  const { hotBytes, total } = measure(agents);
  const reg = existsSync(REG) ? JSON.parse(read(REG)) : null;
  let reds = 0;
  const say = (ok, name, detail, hint) => {
    if (!ok) reds++;
    console.log(`${ok ? 'ok  ' : 'RED '} ${name}: ${detail}${ok || !hint ? '' : `\n      ↳ ${hint}`}`);
  };

  // ① 手抄的当下断言
  for (const b of BANNED) {
    const lines = agents.split('\n');
    const hits = [];
    lines.forEach((l, i) => { if (b.re.test(l)) hits.push(`${i + 1}: ${l.trim().slice(0, 88)}`); });
    say(hits.length === 0, b.name, hits.length ? hits.join('\n      ') : '无手抄的当下断言', b.hint);
  }

  // ② 字节预算
  const budget = reg ? reg.hotBytesBudget : budgetFor(hotBytes);
  say(hotBytes <= budget, 'hot-byte-budget',
    `${hotBytes} 字节，预算 ${budget}`,
    '超预算就删行 / 搬去 docs/；确属每轮判据才可 `npm run check:agents-hotlayer -- --sync` 抬预算');
  if (hotBytes <= budget && hotBytes > budget - HEADROOM_WARN) {
    console.log(`WARN hot-byte-headroom: 余量只剩 ${budget - hotBytes} 字节（告警带 ${HEADROOM_WARN}）`
      + '\n      ↳ 要往热层加行先删行，或显式抬预算并写理由');
  }

  if (args.has('--sync')) {
    const next = {
      ...(reg ?? {}),
      hotBytesBudget: budgetFor(hotBytes),
      measuredHotBytes: hotBytes,
      measuredTotalBytes: total,
      note: '预算 = 显式目标值；只有 `--sync` 能写（手改视为伪造读数）',
    };
    writeFileSync(REG, JSON.stringify(next, null, 2) + '\n');
    console.log(`sync: 写入 ${path.relative(ROOT, REG)} 预算 ${next.hotBytesBudget} 实测 ${hotBytes}`);
    return 0;
  }
  if (!reg) {
    console.log('RED  登记表缺失：先跑 `npm run check:agents-hotlayer -- --sync`');
    return 1;
  }
  console.log(reds === 0 ? `VERDICT ok（AGENTS.md ${hotBytes} / 预算 ${budget}）` : `VERDICT red（${reds} 条）`);
  return reds === 0 ? 0 : 1;
}

process.exit(main());
