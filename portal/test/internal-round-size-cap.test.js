// issue #371-B：单轮 transcript 记录上限（portal.md §9.7）——**契约常量 1 MiB**（env `MAX_ROUND_BYTES`
// 覆盖**已删**，见 issue #677：该 env 从未接进 `deploy/docker-compose.yml` 的 station-portal
// environment 列表，生产设了不生效——假旋钮，同台账 8.184 删 `MAX_BODY_BYTES` 的判据）。
// 真机复现法（#371 验收判据 1，逼出「宿主拒 → 引擎剥归档重试一次」）：直接改
// `src/transcript-limits.js` 的 `MAX_ROUND_BYTES`（要几百 KB 量级）并重跑，不要再引入 env。
// 本文件钉住它与**上游折叠归档上限的算术余量**——这两个数是配套的：erix-agent#461（0.25.0）把折叠归档
// 夹到 256 KiB（`ERIX_FOLD_ARCHIVE_MAX_BYTES`），本站把闸调到那个数以下，正常折叠记录就会天天碰闸。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_ROUND_BYTES } from '../src/transcript-limits.js';

test('算术余量：上游默认归档上限 + 非归档部分 + 满预算 messages 必须仍在契约闸之内', () => {
  const FOLD_ARCHIVE_MAX_BYTES = 262_144; // erix-agent src/compact/fold-archive.js 默认（ERIX_FOLD_ARCHIVE_MAX_BYTES 可覆盖）
  const NON_ARCHIVE_BYTES = 20_425;       // 真机三行折叠记录的稳定值（erix-agent#460 标本）
  const FULL_BUDGET_MESSAGES_BYTES = 565_000; // 满预算 messages：203 161 估算 token × 实测 2.78 B/估算 token
  const peak = FOLD_ARCHIVE_MAX_BYTES + NON_ARCHIVE_BYTES + FULL_BUDGET_MESSAGES_BYTES;
  assert.ok(peak < MAX_ROUND_BYTES, `单条记录峰值 ${peak} 必须 < 契约闸 ${MAX_ROUND_BYTES}（余量 ${MAX_ROUND_BYTES - peak} 字节）`);
});

test('源码级哨兵：两处校验都走同一个常量，且文案报真值不再写死「1MB」', () => {
  const src = readFileSync(new URL('../src/internal.js', import.meta.url), 'utf8');
  assert.equal(src.match(/if \(bytes > MAX_ROUND_BYTES\)/g).length, 2, 'run 版与 session 版两处校验必须同闸');
  assert.ok(!src.includes("'round 请求体超过 1MB 上限'"), '写死「1MB」的文案就是说假话（真值在 `transcript-limits.js`，文案必须插值）');
  assert.match(src.match(/`round 请求体超过 \$\{MAX_ROUND_BYTES\} 字节上限`/g).length === 2 ? 'ok' : '', /ok/);
});
