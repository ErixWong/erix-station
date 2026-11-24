#!/usr/bin/env node
// @ts-check
// 仓库文档可公开闸（issue docs-261124-31）。
// 仓库要能公开、可移植 ⇒ 本机/内网坐标（内网 IP、tailnet IP、内网主机名、凭据文件路径、
// 宿主端口占用、dev 账号名）不许写进仓库，一律放冷层 `~/projects/docs/`，仓库里只留指针与现验判据。
// 口径：**只扫 git 跟踪的 `*.md`**（同 agents-hotlayer 的引用口径，跟踪态天然排除脏文件/未跟踪产物）。
// 命中即打印 `file:line: <命中词>` 并 exit 1。
//
// ⚠ DENY 是精确字面量匹配（不用正则，避免 `.` 误配）：
//   - `10.200.*` / `10.201.*` 是设计里的规划网段（IPAM / 规格 §8.2），**不在 DENY**——别拿「一切 RFC1918」当判据。
//   - `100.64.0.0/10` 是 tailnet 用的 CGNAT 段，属坐标，在 DENY。
//
// EXEMPT（历史/取证账，理由）：这五篇是**运维交接与历史取证记录**，其价值恰在于「当场记下当时的
//   机器坐标」，改写会毁掉证据链，故允许保留机器坐标；它们不是可移植的规格/契约，不参与公开口径。
//   新增 EXEMPT 必须是同类历史账，且写明理由。
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// DENY 照抄：命中即机器坐标/本机 quirk，不许出现在仓库文档里
const DENY = [
  'dns.internal',
  'proxy.internal',
  '10.41.24.146',
  'tailnet-host',
  '192.168.',
  '100.64.0.0/10',
  '~/.config/creds',
  'sg docker',
  'gitea.internal',
  '.example.vip',
  'llm-gateway.internal',
  'nginx_reverse_proxy',
  'gitea_act_runner',
  'station-dev-password-file',
];

const EXEMPT = new Set([
  'docs/maintenance/task-ledger.md',
  'docs/ops/handoff-2026-10-14.md',
  'docs/ops/handoff-2026-10-15.md',
  'docs/ops/deployment-2026-10-10.md',
  'docs/ops/drill-2026-10-11.md',
]);

function trackedMarkdown() {
  let out = '';
  try {
    out = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z', '--', '*.md'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 8 << 20,
    });
  } catch (/** @type {any} */ e) {
    console.error(`git ls-files 跑不动（本闸口径依赖 git）：${e && e.message ? e.message : e}`);
    process.exit(2);
  }
  return out.split('\0').filter(Boolean)
    .filter((rel) => !rel.startsWith('node_modules/') && !rel.includes('/node_modules/'))
    .filter((rel) => !EXEMPT.has(rel))
    .filter((rel) => existsSync(path.join(ROOT, rel)));
}

function main() {
  /** @type {string[]} */
  const hits = [];
  let files = 0;
  for (const rel of trackedMarkdown()) {
    files++;
    const lines = readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const tok of DENY) {
        if (line.includes(tok)) hits.push(`${rel}:${i + 1}: ${tok}`);
      }
    });
  }
  if (hits.length > 0) {
    console.error(`check:doc-portable RED：仓库文档含本机/内网坐标 ${hits.length} 处（已扫 ${files} 个 git 跟踪的 .md）`);
    for (const h of hits) console.error(`  ${h}`);
    console.error('  ↳ 本机/内网坐标不写进仓库，搬去冷层 `~/projects/docs/`，仓库里只留指针与现验判据（见 AGENTS.md §6）。');
    process.exit(1);
  }
  console.log(`check:doc-portable ok：${files} 个 git 跟踪的 .md 无本机/内网坐标`);
  process.exit(0);
}

main();
