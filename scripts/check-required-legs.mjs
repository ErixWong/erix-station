#!/usr/bin/env node
// issue #665：常驻「skip 不算绿」闸。
//
// 根门禁只看 `# fail`，于是「本该真跑、却因为缺环境而静默 skip」的腿在红绿灯上
// 和一个通过的 job 长得一样（一个 skip 的 job 与一个通过的 job 同色）。本闸只给
// 「必须真跑的清单」负责，不搞全局禁止 skip：
//
//   · 有 TEST_DATABASE_URL ⇒ 逐条真跑清单里的腿，要求 `# fail == 0` 且
//     `# skipped == 0` 且 `# pass > 0`（pass=0 说明根本没跑起来，不算绿）。
//     任一不满足 ⇒ rc=1（红），并点名是哪条腿、skipped 多少。
//   · 没有 TEST_DATABASE_URL ⇒ 不跑，但**明确报**「这几条腿这次没跑」+ 清单，
//     rc=1（红，绝不静默）。本地没装 PG 时也能跑，照样点话。
//
// 本地：`npm run check:ci-legs`（无 PG ⇒ 红 + 点名；有 PG ⇒ 绿）。
// CI：质量门禁 job 在步骤 ② 之后注入 TEST_DATABASE_URL 跑同一支，绿才算过。
//
// 后续要把其余 test:integration:* 接进来，只往 REQUIRED_LEGS 里加一条即可。
import { spawnSync } from 'node:child_process';
import { buildDiagnosis } from './lib/leg-output.mjs';

const HAS_PG = (process.env.TEST_DATABASE_URL || '').trim() !== '';

// 必须真跑的清单。cmd 用 argv 数组（不经 shell，免转义/免 PATH 意外）。
// minPass：这条腿正常应跑出的最小 pass 数（低于它说明没真跑，判红）。
const REQUIRED_LEGS = [
  {
    id: 'portal/test/migrate-fresh-db.test.js',
    why: '空库 → baseline → bootstrap → 全部增量迁移，只有全新库能证（#280）',
    argv: ['node', '--test', 'portal/test/migrate-fresh-db.test.js'],
    minPass: 5,
    retryOnFailure: 1,
  },
  {
    id: 'npm run test:integration:prompts',
    why: 'platform_prompts 写侧真 SQL 执行 + 种行（FOR UPDATE 锁已存在行，#596）',
    argv: ['npm', 'run', 'test:integration:prompts'],
    minPass: 7,
    retryOnFailure: 1,
  },
  {
    id: 'portal/test/api-tokens-db.test.js',
    why: '#736 API 令牌真库腿：revoked 谓词 / last_used_at 窗 / ON CONFLICT / '
      + '折 user 列面，四条假库抓不到的 SQL 回归（变异实测全红）',
    argv: ['node', '--test', 'portal/test/api-tokens-db.test.js'],
    minPass: 6,
    retryOnFailure: 1,
  },
];

/** 从一段 TAP 文本里取最后出现的 `# <kind> <n>` 汇总数字。 */
function parseTapSummary(text) {
  const out = { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0 };
  const re = /^#\s+(tests|pass|fail|skipped|todo|cancelled)\s+(\d+)\s*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    out[m[1]] = Number(m[2]);
  }
  return out;
}

function runLeg(leg) {
  const [cmd, ...args] = leg.argv;
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  return { rc: res.status ?? -1, stdout, stderr, tap: parseTapSummary(stdout + '\n' + stderr) };
}

/**
 * 判定口径（与 #665 一字未动）：rc==0 && fail==0 && skipped==0 && pass>=minPass。
 * 返回问题清单（空数组即绿）。
 */
function evaluateLeg(r, minPass) {
  const t = r.tap;
  const problems = [];
  if (r.rc !== 0) problems.push(`进程 rc=${r.rc}`);
  if (t.fail > 0) problems.push(`# fail=${t.fail}`);
  if (t.skipped > 0) problems.push(`# skipped=${t.skipped}（本该真跑，skip≠绿）`);
  if (t.pass < minPass) {
    problems.push(`# pass=${t.pass} < 期望最小 ${minPass}（没真跑起来）`);
  }
  return problems;
}

/** 一条腿的汇总行（OK/红 同格式）。 */
function summaryLine(tag, leg, r) {
  const t = r.tap;
  return `SKIP-GATE [${tag}] ${leg.id}  rc=${r.rc} pass=${t.pass} fail=${t.fail}` +
    ` skipped=${t.skipped} tests=${t.tests}`;
}

/** 红腿：把捕获内容切成可诊断切片逐行打出（绿腿不打）。 */
function printDiagnosis(leg, label, r) {
  const text = (r.stdout || '') + '\n' + (r.stderr || '');
  for (const line of buildDiagnosis(text, { legId: leg.id, label })) {
    console.log(line);
  }
}

function main() {
  if (!HAS_PG) {
    // 无 PG：不许静默。明确点名这次没跑的清单，rc=1。
    console.log('SKIP-GATE: 未检测到 TEST_DATABASE_URL ⇒ 以下必须真跑的腿这次没跑：');
    for (const leg of REQUIRED_LEGS) {
      console.log(`  - ${leg.id}  （${leg.why}）`);
    }
    console.log('SKIP-GATE: 这不是通过，是「没跑」。要么注入 TEST_DATABASE_URL（见' +
      ' docs/testing.md §2.2.1）后重跑，要么按 docs/ops/ci-release.md §4 的口径人工复跑。');
    console.log('SKIP-GATE: rc=1');
    return 1;
  }

  let green = true;
  for (const leg of REQUIRED_LEGS) {
    const r1 = runLeg(leg);
    const problems1 = evaluateLeg(r1, leg.minPass);
    if (problems1.length === 0) {
      console.log(summaryLine('OK ', leg, r1));
      continue;
    }
    // 第 1 次红：无 retryOnFailure 的腿直接判红，真库腿走下面的显式重试。
    if ((leg.retryOnFailure || 0) < 1) {
      green = false;
      console.log(summaryLine('红 ', leg, r1));
      for (const p of problems1) console.log(`          ↳ ${p}`);
      printDiagnosis(leg, leg.id, r1);
      continue;
    }
    // 显式重试（不许静默）：先打出「要重试 + 第 1 次 rc」再跑第 2 次。
    console.log(`SKIP-GATE [重试] ${leg.id} 第 2 次（第 1 次 rc=${r1.rc}）`);
    const r2 = runLeg(leg);
    const problems2 = evaluateLeg(r2, leg.minPass);
    if (problems2.length === 0) {
      // 靠重试才过 ⇒ 判绿，但必须留痕（静默重试会把真 bug 一起吞掉）。
      console.log(summaryLine('OK ', leg, r2));
      console.log(`SKIP-GATE [OK ] ${leg.id}（第 2 次通过，第 1 次 rc=${r1.rc}）`);
      continue;
    }
    // 两次都红 ⇒ 仍判红，且把两次的 not ok 切片都打出来。
    green = false;
    console.log(summaryLine('红 ', leg, r2));
    for (const p of problems2) console.log(`          ↳ ${p}`);
    printDiagnosis(leg, `${leg.id} 第1次`, r1);
    printDiagnosis(leg, `${leg.id} 第2次`, r2);
  }

  if (!green) {
    console.log('SKIP-GATE: 有必须真跑的腿没绿 ⇒ rc=1');
    return 1;
  }
  const n = REQUIRED_LEGS.length;
  console.log(`SKIP-GATE: ${n} 条必须真跑的腿全部真跑且 0 skip ⇒ rc=0`);
  return 0;
}

process.exit(main());
