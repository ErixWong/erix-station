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
];

// DENY_IDENTITY：命中即「认得出是谁」。永不被 EXEMPT 豁免。
const DENY_IDENTITY = [
  j('inteva', 'products'),
  j('ewang', '2'),
  j('ghpat', '@erix.vip'),
  j('@erix', '.vip'),
  j('admin', 'wange'),
  j('/home/', 'eric'), // 宿主用户名；/home/erix 是产品容器内用户名，不拦
  j('lingo', 'lens'),
  j('voice', 'print'),
  j('meeting', '_asr'),
  j('eric', '/cmms'),
  j('fde-', 'workshop'),
  j('Alice', ' Wong'),
  // dev 栈的**脚本账号名**（#777 D6）：它以前不在任何 DENY 清单里 ⇒ 闸查不到自家违例
  //   （AGENTS §4.1 与 docs/testing.md §1.3 自己就写了它，而 AGENTS §6 又规定 dev 账号名不进仓库）。
  // 为什么放**身份**而不是坐标：AGENTS §6 把它列在「本机/内网坐标」那一串里，但本闸的坐标级**可被 EXEMPT
  //   豁免**，而 EXEMPT 那四篇是交接/取证历史账——拿「历史账」给一个**脚本账号名**开永久豁免没有取证价值
  //   （它不是当时的事实，是「谁在这台机器上跑脚本」的别名），所以刻意取严的一边。
  // 扫描面提醒：本闸扫 `*.mjs` 的**注释行** ⇒ 同一个名字写在集成脚本的注释里也被拦（#777 D6 实测抓到 5 处，
  //   已在 `portal/integration/user-usage-e2e.mjs` 中性化）；代码行的默认值不在扫描面（合法藏身处）。
  j('agent', '01'),
];

// ⚠ 下面这条是**测量通道**，不是闸（889 第一步）：它命中**不参与退出码**。
//   为什么单独一条：上面 DENY_IDENTITY 全部走子串匹配（`line.includes`），宿主用户名那条还是组合词
//   （要配家目录前缀才命中）⇒「裸登录名当业务前缀」的形态（例：`<登录名>-p-<port>` 预览域名）整个漏掉，
//   而按 AGENTS §6 登录名属身份。先把面量出来，等文档把形态搬完再翻成拦（下一步）。
//   为什么必须词边界而不是子串：本词根会与前缀字母连成子串（`gen` + 本词根构成的通用词），
//   子串匹配会把通用词误报成身份 ⇒ 翻拦之前必须先有边界，否则下一步一开就满屏假阳性。
//   形状：{ tok, boundary } —— boundary:true 走词边界；boundary 省略/false 退化成子串（与 DENY_* 同语义）。
//   词本身照旧纪律拆片拼接（本文件不在扫描面，拆片不自伤）。
const MEASURE_IDENTITY = [
  { tok: j('er', 'ic'), boundary: true }, // dev 登录名（裸词形态）
];

// 编译一次：词边界用 \b（ASCII \w 语义），不带 g ⇒ 每行每词最多一条，与子串通道的命中粒度一致。
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MEASURE_COMPILED = MEASURE_IDENTITY.map((e) => ({
  tok: e.tok,
  re: e.boundary ? new RegExp(`\\b${reEscape(e.tok)}\\b`) : null,
}));

// EXEMPT：运维交接 / 历史取证账，允许保留**机器坐标**（DENY_INFRA）；对身份（DENY_IDENTITY）无效。
// 新增 EXEMPT 必须是同类历史账，且写明理由。
const EXEMPT = new Set([
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

// 命中判定：字符串元素保持 `line.includes(tok)` 一字不变（旧行为不许退化）；
// 对象元素按 boundary 选词边界或子串。
function matchToken(line, entry) {
  if (typeof entry === 'string') return line.includes(entry);
  if (entry.re) return entry.re.test(line);
  return line.includes(entry.tok);
}

// measureHits 传进来时顺带跑测量通道（只收集，不影响调用方的退出码）。
function scanFile(rel, wholeFile, hits, measureHits) {
  const exempt = EXEMPT.has(rel);
  const lines = readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!wholeFile && !isCommentLine(line)) return;
    // 身份：无条件扫（EXEMPT 不豁免）。
    for (const tok of DENY_IDENTITY) {
      if (matchToken(line, tok)) hits.push(`${rel}:${i + 1}: ${tok}`);
    }
    // 坐标：EXEMPT 历史账豁免。
    if (!exempt) {
      for (const tok of DENY_INFRA) {
        if (matchToken(line, tok)) hits.push(`${rel}:${i + 1}: ${tok}`);
      }
    }
    // 测量通道：输出形状沿用 hits 的 `rel:line: 词`，不自创格式。
    if (measureHits) {
      for (const e of MEASURE_COMPILED) {
        if (matchToken(line, e)) measureHits.push(`${rel}:${i + 1}: ${e.tok}`);
      }
    }
  });
}

function main() {
  // 测量开关：只决定**要不要打印**命中清单，不碰退出码（本轮只量面，不翻拦）。
  const measureOn = process.argv.includes('--identity-words') || process.env.DOC_PORTABLE_IDENTITY_WORDS === '1';
  /** @type {string[]} */
  const hits = [];
  /** @type {string[] | null} */
  const measureHits = measureOn ? [] : null;
  let files = 0;
  for (const rel of gitLsFiles(['*.md', 'deploy/.env.example'])) { files++; scanFile(rel, true, hits, measureHits); }
  // ⚠ `*.mjs` 必须在内：261124 的发布镜像里就漏着 `integration/lib/fde-image.mjs` 的代理 IP 注释——
  //    扫面只写 `*.js` 时它永远不会被拦（.mjs 不是 .js）。
  const SELF = 'scripts/check-doc-portable.mjs'; // 本文件就是 DENY 定义处，扫它会自伤
  for (const rel of gitLsFiles(['*.js', '*.mjs', '*.cjs', '*.ts', '*.vue'])) {
    if (rel === SELF) continue;
    files++; scanFile(rel, false, hits, measureHits);
  }
  if (measureHits) {
    // 打在 stdout：它是量面读数，不是错误；位置在拦截判定之前，故对 rc 零影响。
    console.log(`check:doc-portable 身份词测量（--identity-words，只报不拦，不影响退出码）：${measureHits.length} 处（已扫 ${files} 个文件：*.md + deploy/.env.example 整行、js/mjs/cjs/ts/vue 注释行）`);
    for (const h of measureHits) console.log(`  ${h}`);
  }
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
