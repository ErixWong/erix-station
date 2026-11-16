#!/usr/bin/env node
// @ts-check
// issue #586：镜像内 `build-info.json` 的四格判据（**唯一一份**，CI 与单测共用）。
//
// 为什么要有这个文件：FDE 镜像的 tripwire（`ci.yml` 步骤 ⑤′）是把四格断言**内联**在 workflow 的
// `node -e` 里的，于是「判据会不会红」在单测层面无法自证——只能靠人肉跑一次坏构建。portal 这一条
// （#586）把同一段逻辑抽到这里：CI 调它，单测也调它 ⇒ 判据本身有了机器判据（四种坏形状必须红、
// 好形状必须绿）。FDE 那条保持原样不动（本单不重构别人的判据）。
//
// 用法：`WANT_VERSION=… WANT_REVISION=… node scripts/check-build-info.mjs <build-info.json 路径>`
// 退出码：0 = 合格；1 = 不合格（逐条打印哪一格不对）；2 = 用法/读文件错。
//
// 四格判据（口径见 `docs/api/portal.md` §4.16 与 `runner/Dockerfile:155`）：
//   1. `station_version` == 仓库 `package.json` 的 `version`（不一致 = 烘错了树或 ARG 传错）
//   2. `revision` == 本次 commit（`unknown` = 没传 `STATION_REVISION`）
//   3. `engine_version` 非 `unknown`（引擎版本没烘进去）
//   4. `built_at` 非 `unknown`（没传 `STATION_BUILD_DATE`）

import { readFileSync, realpathSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * 四格逐条断言。**不抛**，返回不合格条目的数组（空数组 = 合格），让调用方自己决定是打日志还是 exit。
 * @param {unknown} info 解析后的 build-info 对象
 * @param {{wantVersion: string, wantRevision: string, surface?: string}} want
 * @returns {string[]} 不合格条目（人类可读）
 */
export function checkBuildInfo(info, { wantVersion, wantRevision, surface = 'build-info.json' }) {
  const bad = [];
  const j = /** @type {Record<string, unknown>} */ (info && typeof info === 'object' ? info : {});
  if (!info || typeof info !== 'object') {
    return [`${surface} 不是 JSON 对象（读不到 = 镜像里根本没烘这份文件）`];
  }
  if (j.station_version !== wantVersion) {
    bad.push(`station_version 期望 ${wantVersion}，实得 ${String(j.station_version)}（镜像烘的是哪份树？）`);
  }
  if (j.revision !== wantRevision) {
    bad.push(`revision 期望 ${wantRevision}，实得 ${String(j.revision)}（没传 STATION_REVISION？）`);
  }
  if (!j.engine_version || j.engine_version === 'unknown') {
    bad.push('engine_version 是 unknown —— 平台侧引擎版本没烘进去');
  }
  if (!j.built_at || j.built_at === 'unknown') {
    bad.push('built_at 是 unknown —— 没传 STATION_BUILD_DATE');
  }
  return bad;
}

/** 从 parse 后的 JSON 文本跑判据；解析失败本身也算一条不合格（不抛）。 */
export function checkBuildInfoText(text, want) {
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return [`build-info.json 解析失败：${err && err.message ? err.message : String(err)}`];
  }
  return checkBuildInfo(parsed, want);
}

// 直跑入口（`node scripts/check-build-info.mjs <file>`）；被 import 时不执行。
const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null;
if (entry !== null && entry === import.meta.url) {
  const file = process.argv[2];
  if (!file) {
    console.error('用法：WANT_VERSION=… WANT_REVISION=… node scripts/check-build-info.mjs <build-info.json>');
    process.exit(2);
  }
  const wantVersion = process.env.WANT_VERSION ?? '';
  const wantRevision = process.env.WANT_REVISION ?? '';
  if (wantVersion === '' || wantRevision === '') {
    console.error('WANT_VERSION / WANT_REVISION 必须都给出（否则四格判据自己就是软的）');
    process.exit(2);
  }
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`::error::读不到 ${file}：${err && err.message ? err.message : String(err)}`);
    process.exit(2);
  }
  const bad = checkBuildInfoText(text, { wantVersion, wantRevision, surface: file });
  if (bad.length) {
    console.error(`::error::${file} 不合格：${bad.join('；')}`);
    process.exit(1);
  }
  const j = JSON.parse(text);
  console.log(`${file} OK：${j.station_version} / engine ${j.engine_version} / ${String(j.revision).slice(0, 7)} / ${j.built_at}`);
}
