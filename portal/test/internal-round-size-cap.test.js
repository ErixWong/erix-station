// issue #371-B：单轮 transcript 记录上限（portal.md §9.7）从硬常量改成 env `MAX_ROUND_BYTES`，
// 并钉住它与**上游折叠归档上限的算术余量**——这两个数是配套的：erix-agent#461（0.25.0）把折叠归档
// 夹到 256 KiB（`ERIX_FOLD_ARCHIVE_MAX_BYTES`），本站把闸调小到那个数以下，正常折叠记录就会天天碰闸。
// 真机复现法（#371 验收判据 1）就是靠把本值调到 300 KB 逼出「宿主拒 → 引擎剥归档重试一次」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveMaxRoundBytes } from '../src/internal.js';

const CONTRACT_DEFAULT = 1024 * 1024; // portal.md §9.7

test('默认值 = 契约值 1 MiB；env 覆盖生效（真机复现要把闸调小到几百 KB）', () => {
  assert.equal(resolveMaxRoundBytes(undefined), CONTRACT_DEFAULT, '没配 env 必须是契约值');
  assert.equal(resolveMaxRoundBytes(''), CONTRACT_DEFAULT);
  assert.equal(resolveMaxRoundBytes('307200'), 307200, '复现用：300 KB');
  assert.equal(resolveMaxRoundBytes(' 4194304 '), 4 * 1024 * 1024, '两侧空白要能吃掉');
});

test('配错不拒启动：非法值一律退回契约值（本值只是防护上限）', () => {
  for (const bad of ['abc', '0', '-1', '1.5', '9999999999999999999999', {}, null, []]) {
    assert.equal(resolveMaxRoundBytes(bad), CONTRACT_DEFAULT, `非法值 ${String(bad)} 必须退回默认`);
  }
});

test('算术余量：上游默认归档上限 + 非归档部分 + 满预算 messages 必须仍在契约闸之内', () => {
  const FOLD_ARCHIVE_MAX_BYTES = 262_144; // erix-agent src/compact/fold-archive.js 默认（ERIX_FOLD_ARCHIVE_MAX_BYTES 可覆盖）
  const NON_ARCHIVE_BYTES = 20_425;       // 真机三行折叠记录的稳定值（erix-agent#460 标本）
  const FULL_BUDGET_MESSAGES_BYTES = 565_000; // 满预算 messages：203 161 估算 token × 实测 2.78 B/估算 token
  const peak = FOLD_ARCHIVE_MAX_BYTES + NON_ARCHIVE_BYTES + FULL_BUDGET_MESSAGES_BYTES;
  assert.ok(peak < CONTRACT_DEFAULT, `单条记录峰值 ${peak} 必须 < 契约闸 ${CONTRACT_DEFAULT}（余量 ${(CONTRACT_DEFAULT - peak)} 字节）`);
});

test('源码级哨兵：两处校验都走同一个可解析常量，且文案报真值不再写死「1MB」', () => {
  const src = readFileSync(new URL('../src/internal.js', import.meta.url), 'utf8');
  assert.equal(src.match(/if \(bytes > MAX_ROUND_BYTES\)/g).length, 2, 'run 版与 session 版两处校验必须同闸');
  assert.ok(!src.includes("'round 请求体超过 1MB 上限'"), '闸可调之后，写死「1MB」的文案就是说假话');
  assert.match(src.match(/`round 请求体超过 \$\{MAX_ROUND_BYTES\} 字节上限`/g).length === 2 ? 'ok' : '', /ok/);
});
