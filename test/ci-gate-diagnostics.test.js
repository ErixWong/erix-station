// 单测：scripts/check-required-legs.mjs 的失败可诊断性（issue #719 收尾时实测踩到）
//
// 背景：这道闸（#665）的立身之本是「skip 不算绿」。但它原来**只打汇总**（pass/fail/skipped），
// 子进程的 TAP 细节被丢掉 ⇒ CI 上红了只能看到 `# fail=1`，既定位不到是哪条子测试，
// 也分不清「真回归」和「偶发」。2026-11-24 实测：同一 commit 同一腿，一红一绿（重跑就绿）。
// 本文件钉住「红了要能点名到具体子测试」这条能力。
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickFailureLines } from '../scripts/check-required-legs.mjs';

const TAP = `ok 1 - 甲
not ok 2 - 迁移 0047 head 断言
  ---
  error: |
    expected: '0047-fde-budget'
    actual: '0046-runtime-settings'
  ...
ok 3 - 丙
not ok 4 - 另一条红的
  error: boom
# tests 4
# pass 2
# fail 2
`;

test('pickFailureLines：只挑红的那几条，并带上紧随其后的缩进诊断行', () => {
  const lines = pickFailureLines(TAP);
  assert.ok(lines.some((l) => l.startsWith('not ok 2 - 迁移 0047 head 断言')), '必须点名第一条红的');
  assert.ok(lines.some((l) => l.includes("expected: '0047-fde-budget'")), '必须带上诊断行（expected/actual）');
  assert.ok(lines.some((l) => l.startsWith('not ok 4 - 另一条红的')), '第二条红的也要点名');
  assert.equal(lines.some((l) => l.startsWith('ok 1 -') || l.startsWith('ok 3 -')), false, '绿的不许混进来');
});

test('pickFailureLines：没有 TAP 细节（进程直接崩）⇒ 回退成尾部若干行，不返回空', () => {
  const lines = pickFailureLines('Error: connect ECONNREFUSED\n    at foo (bar.js:1:1)\n');
  assert.ok(lines.length > 0, '崩溃时也要给东西看，不能空');
  assert.ok(lines.join('\n').includes('ECONNREFUSED'));
});

test('pickFailureLines：有上限（默认 40 行），不会把整份日志灌进 CI', () => {
  const many = Array.from({ length: 50 }, (_, i) => `not ok ${i + 1} - 红${i}\n  error: x`).join('\n');
  assert.ok(pickFailureLines(many).length <= 40);
});

test('pickFailureLines：全绿时返回空数组（不制造噪音）', () => {
  assert.deepEqual(pickFailureLines('ok 1 - 甲\nok 2 - 乙\n# fail 0\n'), []);
});
