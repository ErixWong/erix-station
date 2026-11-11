// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 热层预算闸的落地覆盖（与 scripts/agents-hotlayer-budget.mjs 同源，这里只保证它在 npm test /
// CI 里真的被跑到，并且反向自证成立）。规矩本身见 AGENTS.md §6 与台账 §8.116。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'agents-hotlayer-budget.mjs');

function run(cliArgs) {
  return execFileSync(process.execPath, [CLI, ...cliArgs], {
    cwd: ROOT, encoding: 'utf8',
  });
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
