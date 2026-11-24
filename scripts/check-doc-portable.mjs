#!/usr/bin/env node
// @ts-check
// 仓库文档可公开闸（issue docs-261124-31）。
// 仓库要能公开 ⇒ 两样东西不许留在仓库里：
//   ① 本机/内网**坐标**（内网 IP、tailnet IP、内网主机名、凭据文件路径、宿主端口占用、dev 账号名）
//   ② 能认出「**用户本人身份**」的字面量（真实邮箱域、雇主名、宿主用户名、真实项目/DB 名、真实人名）
// 坐标一律搬去冷层 `~/projects/docs/`，身份一律换成中性占位（见 AGENTS.md §6）。
//
// ⚠ DENY 是精确字面量匹配（不用正则，避免 `.` 误配）：
//   - `10.200.*` / `10.201.*` 是设计里的规划网段（IPAM / 规格 §8.2），**不在 DENY**——别拿「一切 RFC1918」当判据。
//   - `100.64.0.0/10` 是 tailnet 用的 CGNAT 段，属坐标，在 DENY_INFRA。
//
// 三级口径（本轮的关键，上一轮漏的口子就在这）：
//   DENY_INFRA    = 机器坐标。**可被 EXEMPT 豁免**。
//   DENY_IDENTITY = 身份。**永不被 EXEMPT 豁免**。
//
//   为什么身份级不可豁免：EXEMPT 那五篇是运维交接/历史取证账，其价值恰在于「当场记下当时的机器坐标」，
//   改写会毁掉证据链——这豁免的是「坐标」这一类，其正当性来自「坐标当时是事实的一部分」。
//   但「谁在这台机器上工作」不属于坐标：坐标暴露的是「哪台机器」，身份暴露的是「哪个人 / 哪家雇主」。
//   公共仓库里的真实邮箱域 / 雇主名 / 宿主用户名 / 真实项目名能把仓库反查到具体的人，进而指向其邮箱、
//   日历、履历；这层泄露即便写进「历史账」也照样对公众成立，所以「这是历史记录」根本不构成保留身份的理由。
//   一句话：历史账可以留坐标，但不能留身份。
//
// 扫描面：git 跟踪的 `*.md`（整行）+ `deploy/.env.example`（整行）+ `*.js`/`*.ts`/`*.vue` 的**注释行**
//   （只扫注释行：trim 后以 `//`、`#`、`*`、`<!--` 开头者；不扫整段代码，避免误报测试夹具里作为样本值
//    出现的真实项目名——那些是夹具、由人工逐条把关，见本轮台账）。命中即打印 `file:line: <命中词>` 并 exit 1。
//   注：`.mjs`（本脚本自身）不匹配 `*.js`，故脚本里的 DENY 词字面量不会自伤。
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// DENY_INFRA：命中即机器坐标 / 本机 quirk。受 EXEMPT 豁免。
const DENY_INFRA = [
  '10.56.16.16',
  '172.20.0.35',
  '10.41.24.146',
  '100.100.0.3',
  '192.168.',
  '100.64.0.0/10',
  '~/.config/mcp/creds',
  'sg docker',
  'git.erix.vip',
  '.inteva.vip',
  'api.ai.erix.vip',
  'nginx_reverse_proxy',
  'gitea_act_runner',
  'station-dev.password',
];

// DENY_IDENTITY：命中即「认得出是谁」。永不被 EXEMPT 豁免。
const DENY_IDENTITY = [
  'intevaproducts',
  'inteva.vip',
  'hp.inteva',
  'adminwange',
  '/home/eric',
  '/home/adminwange',
  'ewang2',
  'ghpat@erix.vip',
  '@erix.vip',
  'lingolens',
  'voiceprint',
  'meeting_asr_app',
  'eric/cmms',
  'fde-workshop',
  'Alice Wong',
];

// EXEMPT：运维交接 / 历史取证账，允许保留**机器坐标**（DENY_INFRA）；对身份（DENY_IDENTITY）无效。
// 新增 EXEMPT 必须是同类历史账，且写明理由。
const EXEMPT = new Set([
  'docs/maintenance/task-ledger.md',
  'docs/ops/handoff-2026-10-14.md',
  'docs/ops/handoff-2026-10-15.md',
  'docs/ops/deployment-2026-10-10.md',
  'docs/ops/drill-2026-10-11.md',
]);

function gitLsFiles(patterns) {
  let out = '';
  try {
    out = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z', '--', ...patterns], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 8 << 20,
    });
  } catch (/** @type {any} */ e) {
    console.error(`git ls-files 跑不动（本闸口径依赖 git）：${e && e.message ? e.message : e}`);
    process.exit(2);
  }
  return out.split('\0').filter(Boolean)
    .filter((rel) => !rel.startsWith('node_modules/') && !rel.includes('/node_modules/'))
    .filter((rel) => existsSync(path.join(ROOT, rel)));
}

// 只认注释行：trim 后以 //、#、*、<!-- 开头（覆盖 // 行注释、块注释的 ` * 续行`、shell `#`、HTML/Markdown 注释）。
function isCommentLine(line) {
  const t = line.replace(/^\uFEFF/, '').trimStart();
  return t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('<!--');
}

function scanFile(rel, wholeFile, hits) {
  const exempt = EXEMPT.has(rel);
  const lines = readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!wholeFile && !isCommentLine(line)) return;
    // 身份：无条件扫（EXEMPT 不豁免）。
    for (const tok of DENY_IDENTITY) {
      if (line.includes(tok)) hits.push(`${rel}:${i + 1}: ${tok}`);
    }
    // 坐标：EXEMPT 历史账豁免。
    if (!exempt) {
      for (const tok of DENY_INFRA) {
        if (line.includes(tok)) hits.push(`${rel}:${i + 1}: ${tok}`);
      }
    }
  });
}

function main() {
  /** @type {string[]} */
  const hits = [];
  let files = 0;
  for (const rel of gitLsFiles(['*.md', 'deploy/.env.example'])) { files++; scanFile(rel, true, hits); }
  for (const rel of gitLsFiles(['*.js', '*.ts', '*.vue'])) { files++; scanFile(rel, false, hits); }
  if (hits.length > 0) {
    console.error(`check:doc-portable RED：仓库里含本机/内网坐标或身份 ${hits.length} 处（已扫 ${files} 个文件：*.md + deploy/.env.example 整行、js/ts/vue 注释行）`);
    for (const h of hits) console.error(`  ${h}`);
    console.error('  ↳ 坐标搬去冷层 `~/projects/docs/`；身份换中性占位（见 AGENTS.md §6）。EXEMPT 只豁免坐标，不豁免身份。');
    process.exit(1);
  }
  console.log(`check:doc-portable ok：${files} 个文件（*.md + deploy/.env.example 整行、js/ts/vue 注释行）无坐标 / 身份泄露`);
  process.exit(0);
}

main();
