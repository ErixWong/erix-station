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
import { pathToFileURL } from 'node:url';

const HAS_PG = (process.env.TEST_DATABASE_URL || '').trim() !== '';

// 必须真跑的清单。cmd 用 argv 数组（不经 shell，免转义/免 PATH 意外）。
// minPass：这条腿正常应跑出的最小 pass 数（低于它说明没真跑，判红）。
const REQUIRED_LEGS = [
  {
    id: 'portal/test/migrate-fresh-db.test.js',
    why: '空库 → baseline → bootstrap → 全部增量迁移，只有全新库能证（#280）',
    argv: ['node', '--test', 'portal/test/migrate-fresh-db.test.js'],
    minPass: 5,
  },
  {
    id: 'npm run test:integration:prompts',
    why: 'platform_prompts 写侧真 SQL 执行 + 种行（FOR UPDATE 锁已存在行，#596）',
    argv: ['npm', 'run', 'test:integration:prompts'],
    minPass: 7,
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

/** 从一段 TAP 里挑出「红的那几条」+ 紧随其后的诊断行，供失败时打印（原来只打汇总，红了也看不出是哪条）。 */
export function pickFailureLines(text, { maxLines = 40 } = {}) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^not ok\s/.test(lines[i])) continue;
    out.push(lines[i]);
    // TAP 的细节（error/expected/actual/stack）缩进跟在后面，取到下一个非缩进行为止
    for (let j = i + 1; j < lines.length && out.length < maxLines; j++) {
      const l = lines[j];
      if (!/^\s+\S/.test(l) || /^\s*$/.test(l)) break;
      out.push(l);
    }
    if (out.length >= maxLines) break;
  }
  if (out.length === 0) {
    // 全绿（有 TAP 但一条 not ok 都没有）⇒ 没什么可报的，别制造噪音。
    // 只有「压根不像 TAP」（进程直接崩/连不上库）才退回尾部若干行，总比什么都不给强。
    const looksLikeTap = /^(?:not )?ok\s+\d+\s+-/m.test(text) || /^#\s+tests\s+\d+\s*$/m.test(text);
    return looksLikeTap ? [] : lines.filter((l) => l.trim() !== '').slice(-maxLines);
  }
  return out.slice(0, maxLines);
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
  const rows = [];
  for (const leg of REQUIRED_LEGS) {
    const r = runLeg(leg);
    const t = r.tap;
    const problems = [];
    if (r.rc !== 0) problems.push(`进程 rc=${r.rc}`);
    if (t.fail > 0) problems.push(`# fail=${t.fail}`);
    if (t.skipped > 0) problems.push(`# skipped=${t.skipped}（本该真跑，skip≠绿）`);
    if (t.pass < leg.minPass) {
      problems.push(`# pass=${t.pass} < 期望最小 ${leg.minPass}（没真跑起来）`);
    }
    const ok = problems.length === 0;
    if (!ok) green = false;
    rows.push({ leg, r, t, problems, ok });
    const tag = ok ? 'OK ' : '红 ';
    console.log(`SKIP-GATE [${tag}] ${leg.id}  rc=${r.rc} pass=${t.pass} fail=${t.fail}` +
      ` skipped=${t.skipped} tests=${t.tests}`);
    for (const p of problems) console.log(`          ↳ ${p}`);
    if (!ok) {
      // 红的那几条子测试点名打出来：没有这一步，CI 上只能看到「fail=1」，
      // 既定位不了、也分不清「真回归」和「偶发」（2026-11-24 实测踩过：同一 commit 一红一绿）。
      const detail = pickFailureLines(`${r.stdout}\n${r.stderr}`);
      console.log(`          ↳ 红的子测试（最多 40 行）：`);
      for (const line of detail) console.log(`            ${line}`);
    }
  }

  if (!green) {
    console.log('SKIP-GATE: 有必须真跑的腿没绿 ⇒ rc=1');
    return 1;
  }
  console.log(`SKIP-GATE: ${rows.length} 条必须真跑的腿全部真跑且 0 skip ⇒ rc=0`);
  return 0;
}

// 只在「被直接执行」时跑主流程：被 import 时（单测要验 pickFailureLines）不许自己 exit。
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
