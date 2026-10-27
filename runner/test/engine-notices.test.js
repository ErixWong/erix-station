// issue #421 判据（runner 侧）：`lib/engine-notices.js` 的五条运维嘴。
//
// 这一族测要防的是两件事，分开钉：
//   ① 嘴漏（引擎发了、本站没接）⇒ E1/E2 逐条要求出文案；
//   ② **推测键**（本站按记忆造形状）⇒ E5 拿已安装引擎源码做对账，口径同 `compact-knobs.test.js`
//      的 K12 与 `fold-notes.test.js` 的 C18。前例两条：`payload.chars`、`foldSummary.unshrinkable`
//      ——推测键的后果不是报错，是**永不触发**（AGENTS §8.72）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { engineDiagnosticNotice } from '../lib/engine-notices.js';

const RUNNER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 定位**装在本 worktree 里的**引擎根目录（与 `fold-notes.test.js` 的 C18 同一手法：不信注释、不信夹具）。 */
function engineRootOrNull() {
  let dir;
  try { dir = path.dirname(createRequire(import.meta.url).resolve('erix-agent')); }
  catch { return null; }
  while (dir !== path.dirname(dir)) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).name === 'erix-agent') return dir;
    dir = path.dirname(dir);
  }
  return null;
}

test('E1 四类诊断事件各出一条 warn，且关键字段进文案（不许静默）', () => {
  const cases = [
    // 载荷逐条对着引擎发射点写：orchestrator.js:3193 / :1040 / :1011 / :2525
    { event: { type: 'compaction_strategy_fallback', round: 7, detail: 'engine compaction fallback in effect' },
      must: ['sliding-window', 'round 7'] },
    { event: { type: 'model_metadata_missing', detail: 'contextWindowTokens/maxOutputTokens unavailable' },
      must: ['model metadata missing', 'disabled for this run'] },
    { event: { type: 'persistence_capability_degraded', method: 'saveRunSnapshot', detail: 'store does not implement' },
      must: ['saveRunSnapshot', 'skipped for this run'] },
    { event: { type: 'resume_journal_skipped', round: 4, count: 3, reason: 'crash_round_assistant_not_in_ledger' },
      must: ['3 tool result(s)', 'round 4', 'crash_round_assistant_not_in_ledger'] },
  ];
  for (const { event, must } of cases) {
    const n = engineDiagnosticNotice(event);
    assert.ok(n, `${event.type} 必须接出一条（接不出就等于运维看不见）`);
    assert.equal(n.level, 'warn', `${event.type} 是告警，不是 info`);
    for (const m of must) assert.ok(n.msg.includes(m), `${event.type} 文案里必须有「${m}」，实得：${n.msg}`);
  }
});

test('E2 run_outcome 每轮都有 ⇒ 走 info，不许刷成 warn（否则 warn 面被淹）', () => {
  const n = engineDiagnosticNotice({
    type: 'run_outcome', rounds: 12, judgeRecordCount: 3,
    termination: { reason: 'end_turn' }, verification: { done: true },
  });
  assert.ok(n);
  assert.equal(n.level, 'info');
  assert.match(n.msg, /reason=end_turn/);
  assert.match(n.msg, /rounds=12/);
  assert.match(n.msg, /judgeRecords=3/);
});

test('E3 数字没给就写 ?，绝不拿 0 冒充（#283 口径）', () => {
  const a = engineDiagnosticNotice({ type: 'resume_journal_skipped' });
  assert.ok(a);
  assert.match(a.msg, /\? tool result\(s\)/);
  assert.match(a.msg, /crash round \?/);
  assert.doesNotMatch(a.msg, /0 tool result|round 0\b/, '缺失必须显式成 ?，写成 0 就是编数据');
  const b = engineDiagnosticNotice({ type: 'compaction_strategy_fallback' });
  assert.match(b.msg, /round \?/);
  const c = engineDiagnosticNotice({ type: 'run_outcome' });
  assert.match(c.msg, /reason=\? rounds=\? judgeRecords=\?/);
});

test('E4 外来标识符过形状闸：不给字符串就退 ?，绝不 [object Object]（#261 口径）', () => {
  const dirty = [{ method: { toString: () => 'x' } }, { method: 'a b;rm -rf' }, { method: '' }, { method: null }];
  for (const event of dirty) {
    const n = engineDiagnosticNotice({ type: 'persistence_capability_degraded', ...event });
    assert.ok(n);
    assert.match(n.msg, /does not implement "\?"/, `脏 method ${JSON.stringify(event.method)} 必须退成 ?`);
    assert.doesNotMatch(n.msg, /\[object Object\]/);
  }
  // 合法形状（含下划线/点号）照原样保留——闸不能把真值也刷掉
  const ok = engineDiagnosticNotice({ type: 'persistence_capability_degraded', method: 'append_checkpoint' });
  assert.match(ok.msg, /"append_checkpoint"/);
});

test('E5 非诊断类型返回 null（本模块不许什么都接，否则每轮多一条噪声）', () => {
  for (const event of [
    { type: 'round_start', round: 1 }, { type: 'compaction', foldedRounds: 2 },
    { type: 'tool_result' }, { type: 'usage' }, undefined, null, 'compaction_strategy_fallback',
  ]) {
    assert.equal(engineDiagnosticNotice(event), null, `${JSON.stringify(event)} 不该出文案`);
  }
});

test('E6 【防推测键】本模块接的 5 类，已安装引擎必须真发（源码对账）', (t) => {
  const root = engineRootOrNull();
  if (!root) return t.skip('未安装 erix-agent，无从对账');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const loop = read('src/loop/orchestrator.js');
  const records = read('src/loop/judge-record.js');
  // 发射点逐条对：上游哪天不发这类事件，本站这条嘴就该跟着删（留着 = 永不触发的死支）。
  for (const kind of ['compaction_strategy_fallback', 'model_metadata_missing',
    'persistence_capability_degraded', 'resume_journal_skipped']) {
    assert.match(loop, new RegExp(`type: "${kind}"`),
      `引擎源码里已找不到 type: "${kind}" 的发射点：本站这条嘴该删`);
  }
  // `run_outcome` 的记录体在 judge-record.js（orchestrator 里那处只是观察者报错标签），
  // 本模块读的 `judgeRecordCount` 也必须在那儿真存在。
  assert.match(records, /type: "run_outcome"/, '引擎不再造 run_outcome 记录 ⇒ 本站那条 info 是死支');
  assert.match(records, /judgeRecordCount/, '引擎不再给 judgeRecordCount ⇒ 文案里的 judgeRecords 会永远成 ?');
  // 反向：本模块**代码面**不许出现历史上栽过的推测键名（注释里提到它们是允许的，所以先剖注释）。
  const mine = fs.readFileSync(path.join(RUNNER_DIR, 'lib/engine-notices.js'), 'utf8')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const fake of ['unshrinkable', 'chars']) {
    assert.equal(mine.includes(fake), false, `本站代码面又引入了「${fake}」这类推测键`);
  }
});
