// 文档↔实现比对闸夹具（issue #777 S1，代号 docs-261125-12）。
// 把 scripts/check-doc-impl.mjs 纳入 npm test：直接跑闸，要求 rc=0。
// 闸红 ⇒ npm test 红 ⇒ 文档漂移必变红；豁免维护在
// scripts/doc-impl-exceptions.json（每条 reason 必须含 issue 号）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts/check-doc-impl.mjs');

test('doc-impl 闸：文档↔实现三比对全绿', () => {
  const r = spawnSync(process.execPath, [CLI], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert.equal(r.status, 0, `闸未绿：\n${out}`);
  assert.match(out, /VERDICT ok/);
});

test('doc-impl 闸：豁免表可解析且 reason 含 issue 号', () => {
  const f = path.join(ROOT, 'scripts/doc-impl-exceptions.json');
  const j = JSON.parse(readFileSync(f, 'utf8'));
  for (const sec of ['routes', 'schema', 'legs']) {
    const list = j[sec] ?? [];
    for (const e of list) {
      assert.match(
        e.reason ?? '',
        /#\d+/,
        `${sec}: ${JSON.stringify(e)} 的 reason 缺 issue 号`);
    }
  }
});
