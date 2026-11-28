#!/usr/bin/env node
// @ts-check
// 仓库文档可公开闸（issue docs-261124-31）。
// 仓库要能公开 ⇒ 本机/内网**坐标**不许留在仓库里（内网 IP、tailnet IP、内网主机名、凭据文件路径、宿主端口占用）。
// 坐标一律搬去冷层 `~/projects/docs/`（见 AGENTS.md §6）。
// 注：**本闸只查坐标，不查账号名**——原先叠在其上的「身份词表」（把若干 dev 账号名当黑名单、给注释行也扫、
//   再加测量模式与词边界开关）已按用户裁决整体移除（维护成本高于收益、假阳性靠白名单兜）。
//
// ⚠ DENY 是精确字面量匹配（不用正则，避免 `.` 误配）：
//   - `10.200.*` / `10.201.*` 是设计里的规划网段（IPAM / 规格 §8.2），**不在 DENY**——别拿「一切 RFC1918」当判据。
//   - `100.64.0.0/10` 是 tailnet 用的 CGNAT 段，属坐标，在 DENY_INFRA。
//
// 口径：
//   DENY_INFRA = 机器坐标。**可被 EXEMPT 豁免**（EXEMPT 那几篇是运维交接 / 历史取证账，其价值恰在于「当场记下
//   当时的机器坐标」，改写会毁掉证据链——豁免的是坐标这一类，其正当性来自「坐标当时是事实的一部分」）。
//
// 扫描面：git 跟踪的 `*.md`（整行）+ `deploy/.env.example`（整行）+ `*.js`/`*.mjs`/`*.cjs`/`*.ts`/`*.vue` 的**注释行**
//   （注释行判定：trim 后以 `//`、`#`、`*`、`<!--` 开头者；整段代码不扫，避免误报测试夹具里作为样本值
//    出现的真实项目名——那些是夹具、由人工逐条把关，见本轮台账）。命中即打印 `file:line: <命中词>` 并 exit 1。
//   ⚠ 上面两句只描述坐标 DENY。**代码行有一处例外**（#897）：`scanCredsCoord()` 只扫
//    `portal/integration/**` 的代码行，且只认「同一行同时含两个凭据路径片段」，唯一豁免 = `CREDS_COORD_EXEMPT`。
//    两条规则别当成一条：注释行面 = 全部坐标；代码行面 = 只有凭据路径。
//   注：`.mjs`（本脚本自身）不匹配 `*.js`，故脚本里的 DENY 词字面量不会自伤。
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ⚠ 片段拼接：**禁止词本身也不许以明文写进本文件**——闸要是把要拦的东西抄一遍，它自己就成了
//   新的泄露源（261124 历史重写把明文 DENY 词一起改写了，闸当场失明；修法就是把词拆成片段）。
//   拼接发生在运行时；扫描面**含** `*.js/*.mjs/*.cjs/*.ts/*.vue` 的注释行（261124 实测：只写 `*.js`
//   就永远拦不住 `.mjs` 里的代理 IP 注释），本文件靠 `SELF` 跳过（见 main() 里那句 `continue`）
//   才不自伤——不是因为它是 `.mjs`。。
const j = (...parts) => parts.join('');

// DENY_INFRA：命中即机器坐标 / 本机 quirk。受 EXEMPT 豁免。
const DENY_INFRA = [
  j('10.56.', '16.16'), // 内网 DNS
  j('172.20.', '0.35'), // 出口代理
  j('100.100.', '0.3'), // tailnet
  j('10.41.', '24.146'), // 旧代理
  '192.168.',
  '100.64.0.0/10',
  j('~/.config/', 'mcp/creds'),
  j('sg', ' docker'),
  j('git.', 'erix.vip'),
  j('api.ai.', 'erix.vip'),
  j('.inteva', '.vip'),
  j('nginx_', 'reverse_proxy'),
  j('gitea_', 'act_runner'),
  j('station-dev', '.password'),
  // 宿主用户名的绝对路径（`/home/<宿主用户>`）。这不是账号名黑名单，是**路径前缀**：
  // 仓库里出现它就是「这台机器上的绝对路径」，换个机器读的人照着做会找不到。
  // 产品容器内的同名用户（`/home/erix`）**不拦**——那是镜像里的事实，不是本机坐标。
  j('/home/', 'eric'),
];

// EXEMPT：运维交接 / 历史取证账，允许保留**机器坐标**（DENY_INFRA）。
// 新增 EXEMPT 必须是同类历史账，且写明理由。
const EXEMPT = new Set([
  'docs/ops/handoff-2026-10-14.md',
  'docs/ops/handoff-2026-10-15.md',
  'docs/ops/deployment-2026-10-10.md',
  'docs/ops/drill-2026-10-11.md',
]);

// #897 窄判据（只管可机械判定的事实，不审文本语义）：宿主凭据坐标只许住在 `portal/integration/lib/dev-creds.mjs`。
//   为什么要单独一条而不并进 DENY_INFRA：现有扫描面只认**注释行**（见文件头 :24-25），而这类坐标历史上就藏在
//   集成脚本的**代码行**（口令文件候选数组，原 8 处），DENY_INFRA 永远看不见 ⇒ DENY 形同虚设。
//   坐标已收敛进 dev-creds.mjs 单一来源；这条把**代码行**纳入可见面，守住「别的地方不再长出新的凭据字面」。
//   判据只认「同一行同时出现两个坐标片段」——两个片段各自都不算泄露（拼起来的完整路径才是坐标），
//   且这条是纯机械的字符串共现判定，不解析语义。片段照上面纪律用 j() 拼接（本文件不在扫描面，拆片不自伤）。
const CREDS_FRAG_A = j('~/.config/', ''); // 家目录配置根
const CREDS_FRAG_B = j('mc', 'p/creds'); // 凭据子目录（与 A 同行共现才构成坐标）
// 唯一豁免：坐标的唯一来源（轮换凭据 / 换机器只改这一处）。豁免名写错 ⇒ 本文件代码行自己会被判红。
const CREDS_COORD_EXEMPT = 'portal/integration/lib/dev-creds.mjs';
const CREDS_LABEL = CREDS_FRAG_A + CREDS_FRAG_B; // 报告标签（拼起来的坐标，非新增 DENY 词）

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

// 命中判定：坐标一律子串匹配（`line.includes(tok)`，旧行为一字不变）。
function matchToken(line, tok) {
  return line.includes(tok);
}

function scanFile(rel, wholeFile, hits) {
  const exempt = EXEMPT.has(rel);
  const lines = readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!wholeFile && !isCommentLine(line)) return;
    // 坐标：EXEMPT 历史账豁免。
    if (!exempt) {
      for (const tok of DENY_INFRA) {
        if (matchToken(line, tok)) hits.push(`${rel}:${i + 1}: ${tok}`);
      }
    }
  });
}

// #897：只扫 git 跟踪的 `portal/integration/**` 源码文件的**代码行**（注释行交给上面的既有扫描面，
// 一字不动）；同行同时含两个坐标片段 ⇒ 命中；唯一豁免 = CREDS_COORD_EXEMPT（dev-creds.mjs）。
function scanCredsCoord(hits) {
  for (const rel of gitLsFiles(['portal/integration'])) {
    if (!/\.(?:mjs|cjs|js|ts)$/.test(rel)) continue;
    if (rel === CREDS_COORD_EXEMPT) continue;
    const lines = readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (line.includes(CREDS_FRAG_A) && line.includes(CREDS_FRAG_B)) {
        hits.push(`${rel}:${i + 1}: ${CREDS_LABEL}`);
      }
    });
  }
}

function main() {
  /** @type {string[]} */
  const hits = [];
  let files = 0;
  for (const rel of gitLsFiles(['*.md', 'deploy/.env.example'])) { files++; scanFile(rel, true, hits); }
  // ⚠ `*.mjs` 必须在内：261124 的发布镜像里就漏着 `integration/lib/fde-image.mjs` 的代理 IP 注释——
  //    扫面只写 `*.js` 时它永远不会被拦（.mjs 不是 .js）。
  const SELF = 'scripts/check-doc-portable.mjs'; // 本文件就是 DENY 定义处，扫它会自伤
  for (const rel of gitLsFiles(['*.js', '*.mjs', '*.cjs', '*.ts', '*.vue'])) {
    if (rel === SELF) continue;
    files++; scanFile(rel, false, hits);
  }
  // #897：把集成脚本**代码行**上的凭据坐标也纳入退出码（现有注释行扫描面一字未动；只对
  // `portal/integration/**` 生效，且只认「同一行同时含两个凭据坐标片段」这一条窄规则）。
  scanCredsCoord(hits);
  if (hits.length > 0) {
    // 「N 处」的语义 = **有 N 个位置要人改**，不是「规则匹配了几次」。同一行被两条坐标规则命中时，
    //   详情列两条（要知道是哪两条规则 fired），但头部按 `rel:line` 去重计数，免得一个位置报成两处。
    const locOf = (h) => { const m = h.match(/^(.*:\d+): /); return m ? m[1] : h; };
    const locations = new Set(hits.map(locOf));
    console.error(`check:doc-portable RED：仓库里含本机/内网坐标 ${locations.size} 处（规则命中 ${hits.length} 条；已扫 ${files} 个文件：*.md + deploy/.env.example 整行、js/ts/vue 注释行）`);
    for (const h of hits) console.error(`  ${h}`);
    console.error('  ↳ 坐标搬去冷层 `~/projects/docs/`（见 AGENTS.md §6）。EXEMPT 豁免历史账里的坐标。');
    process.exit(1);
  }
  console.log(`check:doc-portable ok：${files} 个文件（*.md + deploy/.env.example 整行、js/ts/vue 注释行；另对 portal/integration/** 的代码行查凭据坐标）无坐标泄露`);
  process.exit(0);
}

main();
