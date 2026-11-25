// @ts-check
// issue #758：scripts/lib/leg-output.mjs 的纯函数单测——
// 「从 TAP 切 not ok 块」「无 not ok 退化尾部」「超限截断」三条口径。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDiagnosis,
  extractNotOkBlocks,
  tailLines,
  capLines,
} from '../scripts/lib/leg-output.mjs';

/** 构造一段含 2 个 `not ok` 的 TAP（每个都带 expected/actual/stack）。 */
function tapTwoFailures() {
  return [
    'TAP version 13',
    '# Subtest: token revoked 谓词',
    'not ok 1 - token revoked 谓词',
    '  ---',
    '  duration_ms: 5',
    "  failureType: 'testCodeFailure'",
    "  error: 'expected true to equal false'",
    "  name: 'AssertionError'",
    '  expected: false',
    '  actual: true',
    "  operator: 'strictEqual'",
    '  stack: |-',
    '    TestContext.<anonymous> (portal/test/api-tokens-db.test.js:10:5)',
    '  ...',
    '# Subtest: last_used_at 窗',
    '    not ok 1 - last_used_at 窗',
    '      ---',
    "      name: 'AssertionError'",
    '      expected: 7',
    '      actual: 8',
    '      stack: |-',
    '        TestContext.<anonymous> (portal/test/api-tokens-db.test.js:22:5)',
    '      ...',
    '1..2',
    '# fail 2',
  ].join('\n');
}

test('extractNotOkBlocks：2 个 not ok ⇒ 切出 2 段，每段含 expected', () => {
  const blocks = extractNotOkBlocks(tapTwoFailures());
  assert.equal(blocks.length, 2, '应恰好切出 2 段');
  for (const [i, block] of blocks.entries()) {
    assert.match(block[0], /^\s*not ok\b/, `第 ${i + 1} 段首行应是 not ok`);
    assert.ok(
      block.some((l) => /expected:/.test(l)),
      `第 ${i + 1} 段应含 expected 断言原文`,
    );
    assert.ok(
      block.some((l) => /AssertionError/.test(l)),
      `第 ${i + 1} 段应含 AssertionError`,
    );
  }
});

test('extractNotOkBlocks：not ok 块尾随行数受 contextLines 约束', () => {
  const text = ['not ok 1 - x', ...Array.from({ length: 40 }, (_, i) => `x${i}`)].join('\n');
  assert.equal(extractNotOkBlocks(text, 5).length, 1);
  // 只带命中行 + 其后 5 行 = 6 行。
  assert.equal(extractNotOkBlocks(text, 5)[0].length, 6);
});

test('extractNotOkBlocks：无 not ok ⇒ 空数组', () => {
  assert.deepEqual(extractNotOkBlocks('ok 1 - a\n# pass 1'), []);
});

test('tailLines：取尾部 N 行，忽略末尾换行的空尾行', () => {
  const text = Array.from({ length: 200 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
  const tail = tailLines(text, 60);
  assert.equal(tail.length, 60);
  assert.equal(tail[0], 'L141');
  assert.equal(tail[tail.length - 1], 'L200');
});

test('buildDiagnosis：有 not ok ⇒ 只打切片（带定位头）', () => {
  const out = buildDiagnosis(tapTwoFailures(), { legId: 'api-tokens-db' });
  assert.equal(out[0], '---- api-tokens-db 输出 ----');
  assert.ok(out.some((l) => /^not ok\b/.test(l) || /^\s*not ok\b/.test(l)));
  assert.ok(out.some((l) => /expected: false/.test(l)));
  assert.ok(out.some((l) => /expected: 7/.test(l)));
  // 未超限 ⇒ 不该出现截断标记。
  assert.ok(!out.some((l) => l.includes('已截断')));
});

test('buildDiagnosis：无 not ok ⇒ 退化为尾部 N 行', () => {
  const text = Array.from({ length: 200 }, (_, i) => `L${i + 1}`).join('\n');
  const out = buildDiagnosis(text, { legId: 'x', tailFallback: 60 });
  assert.equal(out[0], '---- x 输出 ----');
  assert.equal(out.length, 61); // 1 头 + 60 尾
  assert.equal(out[1], 'L141');
  assert.equal(out[out.length - 1], 'L200');
});

test('buildDiagnosis：500 行输入 ⇒ 输出 ≤ 120 行且含「已截断」', () => {
  // 无 not ok，tailFallback 取满，逼出截断路径（tailFallback 是纯函数入参，
  // 生产默认 60；这里为把「上限」这条独立测出来而显式放大）。
  const text = Array.from({ length: 500 }, (_, i) => `L${i + 1}`).join('\n');
  const out = buildDiagnosis(text, { legId: 'x', maxTotalLines: 120, tailFallback: 500 });
  assert.ok(out.length <= 120, `输出 ${out.length} 行应 ≤ 120`);
  assert.equal(out.length, 120);
  assert.equal(out[0], '---- x 输出 ----');
  assert.equal(out[out.length - 1], '…（已截断）');
});

test('buildDiagnosis：not ok 过多时也按上限截断', () => {
  // 每 25 行一个 not ok，块不重叠；6 段 × 21 行 = 126 行 body > 118 ⇒ 截断。
  const lines = [];
  for (let i = 0; i < 150; i++) {
    lines.push(i % 25 === 0 ? 'not ok 1 - f' : `filler ${i}`);
  }
  const out = buildDiagnosis(lines.join('\n'), { legId: 'x', maxTotalLines: 120 });
  assert.ok(out.length <= 120);
  assert.ok(out.some((l) => l.includes('已截断')), 'not ok 路径也应能触发截断');
});

test('capLines：未超限原样返回、超限截断并标记', () => {
  const small = capLines(['a', 'b', 'c'], 5);
  assert.deepEqual(small, { lines: ['a', 'b', 'c'], truncated: false });
  const big = capLines(['a', 'b', 'c'], 2);
  assert.deepEqual(big, { lines: ['a', 'b'], truncated: true });
});
