#!/usr/bin/env node
// issue #677 第一步：env 旋钮**清点工具**（注意：这是工具，不是闸 —— 它只报事实、不判红，
// 也不注册成 `check:*`；注册名是 `inventory:env-knobs`）。
//
// 它把一根旋钮要穿过才能从「运维写在 `deploy/.env`」走到「runner 里真的生效」的
// **四处落点**摊平成一张表：
//
//   ① compose：`deploy/docker-compose.yml` 的 `services.station-portal.environment`
//      （以及 `services.station-docker-proxy.environment` —— 那是 FDE 侧的策略面，单独标记）
//   ② portal 注入：`portal/src/provisioner.js` 往 FDE 容器 `Env` 里塞了哪些键
//   ③ proxy 放行：`deploy/fde-proxy/server.js` 的 `ENV_KEY_ALLOW`（漏一条 ⇒ 现网
//      `create_policy_denied`，这是历史事故 `ERIX_AGENT_VERSION` 的形状）
//   ④ runner 真读：`runner/`（含 `runner/lib/`）里实际读该 env 名的位置
//
// 之所以要有这个工具：四处落点之间**没有任何同步机制**，历史上真出过两次事故——
// 一次是白名单没跟着加（现网拒），一次是代码默认与 compose 默认不一致（「默认关」
// 在 compose 部署里根本没生效）。人手对账对不动（compose 里几十个键、白名单十几条、
// runner 里三十来个名字，还散在数据表与别名点号写法里）。
//
// ─────────────────────────────────────────────────────────────────────────────
// 「容器起来之前就得知道」（= 不能搬进配置界面 + DB）的**判据**（不是拍脑袋，逐条给依据）：
//
//   P1 连接自身所需：值是 portal 连数据库/建连接之前就要用的（`DATABASE_URL` 一族）。
//      机器判据：被 `portal/src/config.js` 读到，且名字命中 DB/URL/PASSWORD 形态。
//   P2 容器与进程怎么起：镜像、uid/gid、bind 根目录、socket、端口、host、网络段、
//      entrypoint。这些是 `docker compose up` 与 `docker create` 的**输入**，
//      读到它们的时候 DB 还没连上。机器判据：名字命中下面 `INFRA_NAME_PATTERNS`，
//      或出现在 compose 的 proxy 服务 env 里（proxy 在收到 create 请求之前就要它们）。
//   P3 启动快照：被 `portal/src/config.js` 读到的键——该模块是 portal 的启动期快照，
//      改值必须重启容器，DB 里的新值追不上已经跑起来的进程。
//   P4 每实例身份 / 派生量：容器自己的 token、名字、版本钉，以及「值由代码从别的东西
//      算出来」的派生键（例如 base URL 由域名拼）。它们不是一根独立旋钮，
//      搬进 DB 只是把派生搬到另一处，还得先解决派生源 ⇒ 判「是」。
//      机器判据：名字命中 TOKEN/SECRET/PASSWORD/KEY/VERSION/NAME，或「portal 注入
//      但 compose 里没有对应键」（值不可能来自运维的 env，只能是代码里造的）。
//
//   反之，「能搬进 DB」要求三件同时成立（缺一件就不许判能搬）：
//     · 三腿齐：portal 注入 ∧ proxy 放行 ∧ runner 真读 —— 缺任何一条，DB 值投不进容器；
//     · 不是 P1–P4（不是启动前必知）；
//     · 消费点在 FDE 容器内、每次现读（runner 侧读 env），而不是 portal 的启动快照。
//   剩下的全部进「需人判」：语义与其它旋钮耦合、钳位上限、改名遗留、或要先补腿。
//
// ─────────────────────────────────────────────────────────────────────────────
// **第二个维度：消费时机**（「搬进 DB 后改值要不要重启」）——不是新信息，吃的仍是上面已扫到的
// 三件事（per-run 写点 / 读点在不在顶层初始化区 / 有没有 runner 读点）：
//
//   per-run：portal 每起一个 run 重写一次子环境（`runner/agentd.js` 函数体内的
//            `childEnv.NAME =`），或 runner 在函数体里读（`runner/worker.js` 里处理工具调用的
//            函数、`runner/lib/llm-timeouts.js` 每 run 拼 LLM 请求头）⇒ 改 DB 下个 run 就生效。
//   启动快照：读点全在模块顶层初始化区（`runner/lib/shell-tools.js` 那组 `const *_MS`、
//            `runner/lib/artifacts.js` 的 `export const`、`runner/agentd.js` 的 `const CFG`）
//            ⇒ 模块首次 import 就值定了，改 DB 得重启/重建容器。
//   未知：runner 侧根本没有读点 ⇒ 不敢断言（进「需人判」）。
//
//   为什么要这一维：同样是「能搬」，上面两组对运维的含义完全不同（一组改完立刻生效，
//   一组改完默默不改行为）；compose 自己就记了这件事（`deploy/docker-compose.yml` 里
//   station-litellm 那一段写明某些键「per-run 生效，与容器 Env 那个同名变量是两个东西」）。
//   保守方向：时机只影响「搬后怎么生效」的描述，不影响能不能搬；函数体读点会附注函数名，
//   因为如果它的调用方全在启动路径上，代码形态上是 per-run、运行时其实仍是启动快照。
//
// 三堆归位的机器形态（`--json` 里的 `piles`）：`dbPerRun`（能搬、不用重启）/
// `dbRestart`（能搬、但要重启）/ `no`（不能搬）/ `human`（需人判）/ `non`（非旋钮：
// 子进程与容器的基线环境，proxy 必须放行否则任何 `docker create` 都会被拒）。
// `pilesAll.db` = 前两堆的并集，用来跟上一轮结果对账。
//
// 用法：
//   node scripts/env-knob-inventory.mjs              # 人读表格 + 小计 + 三堆
//   node scripts/env-knob-inventory.mjs --json       # 同一份数据的机器形态
//   node scripts/env-knob-inventory.mjs --root DIR   # 指向别的仓库根（单测用假目录）
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');

// 四处落点的相对路径（清点对象固定，不随环境变）。
const COMPOSE_FILE = 'deploy/docker-compose.yml';
const PROXY_FILE = 'deploy/fde-proxy/server.js';
const PROVISIONER_FILE = 'portal/src/provisioner.js';
const PORTAL_SRC_DIR = 'portal/src';
const RUNNER_DIR = 'runner';
// 登记表（#557 活二的例外清单）：工具**真的读它**做交叉对账，不再只在交棒里口头提。
const LEGS_EXCEPTIONS_FILE = 'deploy/env-legs-exceptions.json';

// 扫描时跳过的目录名：依赖、构建产物、测试与探针（测试读 env 是为了造场景，不是消费者）。
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'test', 'probes', 'skills', 'fixtures']);

// P2：「容器/进程怎么起」的名字形态。逐条都是 compose 里能一眼对上号的基础设施项。
const INFRA_NAME_PATTERNS = [
  /(^|_)DATABASE_URL$/, // 连库
  /(^|_)DB_/, // 连库
  /(^|_)PASSWORD$/, // 凭据
  /(^|_)IMAGE$/, // 镜像
  /IMAGE_ALLOWLIST$/, // 镜像放行面
  /(^|_)SOCKET_PATH$/, // 挂载的 socket
  /(^|_)DOCKER_HOST$/, // 连哪个 docker
  /(^|_)(UID|GID)$/, // 容器身份
  /(^|_)USERSPACE_ROOT/, // bind 根目录
  /(^|_)(ROOT|DIR|PATH)$/, // 容器内路径
  /(^|_)(PORT|HOST|HOSTS)$/, // 监听与寻址
  /(^|_)ENTRYPOINT$/, // traefik 入口
  /(^|_)(FILE|DYNAMIC_FILE)$/, // 写死在容器内的文件名
  /(^|_)IPAM_/, // 网络段
  /(^|_)NETWORK/, // 网络
  /(^|_)POOL$/, // 池
  /(^|_)TICKET_/, // 预览 ticket 的签名/时效（与 signing key 同族）
];

// P1/P4 的名字形态。
const DB_URL_PATTERN = /DATABASE_URL|(^|_)DB_|(_URL)$|PASSWORD/;
const IDENTITY_PATTERN = /TOKEN|SECRET|PASSWORD|(^|_)KEY($|_)|VERSION|(^|_)NAME$/;

// 明确**不是旋钮**的白名单条目：proxy 必须放行容器进程的基线环境，否则任何
// `docker create` 都会被拒；runner 侧不显式读它（node/子进程继承）。登记它才不会
// 被「白名单里但没人读」的判据误报成死光纤。
const PASS_THROUGH_KEYS = new Set(['PATH']);

const NAME_RE = /^[A-Z][A-Z0-9_]{2,}$/;

// ───────────────────────────────── 源码文本处理

/** 剥掉 JS 源码里的注释（含模板串内的 `${}` 嵌套），保留行号（注释行替换为空行）。 */
export function stripJsComments(src) {
  const out = [];
  let i = 0;
  let state = 'code'; // code | line | block | sq | dq | tpl
  let tplDepth = 0;
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out.push(' '); i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; out.push(' '); i += 2; continue; }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') { state = 'tpl'; tplDepth = 0; }
      out.push(c); i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out.push('\n'); i += 1; continue; }
      out.push(' '); i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out.push('  '); i += 2; continue; }
      out.push(c === '\n' ? '\n' : ' '); i += 1; continue;
    }
    // 字符串内部
    if (c === '\\') { out.push(c, c2 ?? ''); i += 2; continue; }
    if (state === 'sq' && c === "'") state = 'code';
    else if (state === 'dq' && c === '"') state = 'code';
    else if (state === 'tpl') {
      if (c === '`') { state = tplDepth === 0 ? 'code' : 'code'; tplDepth = 0; }
      else if (c === '$' && c2 === '{') { tplDepth += 1; out.push(c); i += 1; continue; }
      else if (c === '}' && tplDepth > 0) { tplDepth -= 1; out.push(c); i += 1; continue; }
    }
    out.push(c); i += 1; continue;
  }
  return out.join('');
}

function readIfExists(root, rel) {
  const abs = path.join(root, rel);
  try {
    if (!fs.statSync(abs).isFile()) return { text: '', missing: true, abs };
    return { text: fs.readFileSync(abs, 'utf8'), missing: false, abs };
  } catch {
    return { text: '', missing: true, abs };
  }
}

/** 递归列出目录下的 *.js（跳过 SKIP_DIRS 与 *.test.js）。 */
export function listJsFiles(root, relDir) {
  const out = [];
  const stack = [path.join(root, relDir)];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在 ⇒ 什么都不扫
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(abs);
      } else if (e.isFile() && e.name.endsWith('.js') && !e.name.endsWith('.test.js')) {
        out.push(abs);
      }
    }
  }
  return out.sort();
}

// ───────────────────────────────── ① compose

/**
 * 解析 compose 里各服务的 `environment:` 显式列表。
 * 行式解析（不引第三方 YAML）：本文件的写法固定为「2 空格服务名 / 4 空格字段 / 6 空格键」，
 * 单测里的假 compose 也照这个形状给。
 * @returns {Record<string, Array<{name:string, raw:string, line:number, form:string}>>}
 */
/**
 * 解析 compose 里各服务的 `environment:` 显式列表（薄壳：只给 envByService）。
 * 需要知道“哪些形状我们认不出”时用 {@link parseComposeEnvWithWarnings}。
 * @returns {Record<string, Array<{name:string, raw:string, line:number, form:string}>>}
 */
export function parseComposeEnv(text) {
  return parseComposeEnvWithWarnings(text).envByService;
}

/**
 * 行式解析 + **形状告警**：认不出的 YAML 形状必须**喊出来**，不许静默空表。
 * 返回 `{ envByService, warnings }`：envByService 与 {@link parseComposeEnv} 逐字节一致（收集逻辑没改），
 * warnings 逐条 `{ service, line, kind, raw }`，kind 覆盖：
 *   · list-form              environment 块内的 `- KEY=VAL`（列表式 environment，我们不解析）
 *   · anchor-on-environment  `environment: &x`（带锚/引用/行内流 ⇒ 整块被我们跳过）
 *   · merge-key              `<<:` YAML 合并键（全文件扫描）
 *   · dup-environment        同一服务第二个 `environment:`
 *   · unparsed-line          environment 块内既非 `KEY: value`、也非 `- KEY=VAL`/注释/空行
 *   · extends               `extends:`（不解析语义，只喊）
 *   · include               顶层 `include:`（不解析语义，只喊）
 * @returns {{ envByService: Record<string, any[]>, warnings: Array<{service:string|null, line:number, kind:string, raw:string}> }}
 */
export function parseComposeEnvWithWarnings(text) {
  const lines = text.split(/\r?\n/);
  const services = {};
  const warnings = [];
  let inServices = false;
  let service = null;
  let envIndent = -1;
  let cur = null;
  const envSeen = new Set(); // service 名 ⇒ 已出现过 environment:
  const pushWarn = (kind, line, raw, svc = service) => warnings.push({ service: svc ?? null, line, kind, raw });
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    // 全文件形状告警（与进不进 services 段无关；include/extends/merge-key 在任何位置都要喊）。
    if (/^include\s*:/.test(line)) pushWarn('include', idx + 1, line.replace(/^\s*include\s*:/, '').trim(), null);
    const ext = line.match(/^\s+extends\s*:(.*)$/);
    if (ext) pushWarn('extends', idx + 1, ext[1].trim());
    const mkTop = line.match(/^\s*<<\s*:(.*)$/);
    if (mkTop) pushWarn('merge-key', idx + 1, mkTop[1].trim());
    if (/^services:\s*$/.test(line)) { inServices = true; service = null; envIndent = -1; continue; }
    if (!inServices) continue;
    if (/^[A-Za-z0-9_-]+:/.test(line)) break; // services 之外的顶层段 ⇒ 结束
    const svc = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (svc) { service = svc[1]; services[service] = []; envIndent = -1; cur = null; continue; }
    const top = line.match(/^ {2}(\S.*)$/);
    if (top) { envIndent = -1; cur = null; } // 换到该服务的另一个字段
    const env = line.match(/^(\s+)environment\s*:(.*)$/);
    if (env && service) {
      if (envSeen.has(service)) pushWarn('dup-environment', idx + 1, env[2].trim());
      envSeen.add(service);
      const trailing = env[2].trim();
      if (trailing === '') { envIndent = env[1].length; cur = null; }
      else { pushWarn('anchor-on-environment', idx + 1, trailing); envIndent = -1; cur = null; } // 带锚/引用 ⇒ 不开块（键会“静默消失”，已由本告警兑现）
      continue;
    }
    if (envIndent < 0 || !service) continue;
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= envIndent) { envIndent = -1; cur = null; continue; }
    const kv = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*(.*)$/);
    if (kv) {
      cur = { name: kv[1], raw: kv[2].trim(), line: idx + 1, form: classifyComposeValue(kv[2].trim()) };
      services[service].push(cur);
    } else if (/^\s*-\s/.test(line)) {
      pushWarn('list-form', idx + 1, line.trim()); // 列表式 environment 的一项，我们不解析
    } else if (/^\s*<<\s*:/.test(line)) {
      // merge-key 已在全文件扫描里报过，这里不再计 unparsed-line
    } else if (cur && indent > envIndent + 2) {
      cur.raw += ' ' + line.trim(); // 多行值（例如 `${VAR:?多行说明}`）的续行
      cur.form = classifyComposeValue(cur.raw);
    } else {
      pushWarn('unparsed-line', idx + 1, line.trim()); // environment 块内认不出的行
    }
  }
  return { envByService: services, warnings };
}

/** compose 一个值的写法归类：字面 / `${VAR:-默认}` / `${VAR:-}`（默认空）/ `${VAR-默认}` / `${VAR:?必填}` / 复合插值。 */
export function classifyComposeValue(raw) {
  if (raw === '' || raw === '""' || raw === "''") return '空值';
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*:-\}/.test(raw)) return '${VAR:-}（默认空）';
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*:-/.test(raw)) return '${VAR:-默认}';
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*:\?/.test(raw)) return '${VAR:?必填}';
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*-/.test(raw)) return '${VAR-默认}（单横线）';
  if (raw.includes('${')) return '复合插值';
  return '字面';
}

// ───────────────────────────────── ② portal 注入 / ③ proxy 白名单

/**
 * portal 往 FDE 容器 `Env` 里注入的键：形如 `` `NAME=...` `` 的字符串字面量。
 * 覆盖 Env 数组、后面的 `.push(...)`、以及调用方递进来的 token/名字。
 * @returns {Array<{name:string, line:number}>}
 */
export function parseInjectedEnv(text) {
  const src = stripJsComments(text);
  const out = [];
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const re = /[`'"]([A-Z][A-Z0-9_]{2,})=/g;
    let m;
    while ((m = re.exec(lines[i])) !== null) {
      if (NAME_RE.test(m[1])) out.push({ name: m[1], line: i + 1 });
    }
  }
  return out;
}

/** proxy 的 `ENV_KEY_ALLOW` 集合内容（含每条的行号）。 */
export function parseProxyAllowlist(text) {
  const src = stripJsComments(text);
  const m = src.match(/ENV_KEY_ALLOW\s*=\s*new Set\(\[/);
  if (!m) return [];
  const start = m.index + m[0].length;
  let depth = 1;
  let end = -1;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '[') depth += 1;
    else if (src[i] === ']') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return [];
  const head = src.slice(0, start);
  const baseLine = head.split(/\r?\n/).length; // Set 起始行（1-based）
  const body = src.slice(start, end);
  const out = [];
  const re = /['"]([A-Z][A-Z0-9_]{2,})['"]/g;
  let mm;
  while ((mm = re.exec(body)) !== null) {
    if (!NAME_RE.test(mm[1])) continue;
    const line = baseLine + body.slice(0, mm.index).split(/\r?\n/).length - 1;
    out.push({ name: mm[1], line });
  }
  return out;
}

// ───────────────────────────────── ④ 真读它的地方

/**
 * 顶层初始化区间（1-based，含头含尾）：`const X = …` / `export const X = …` 起，
 * 到配对括号归零且下一行不再是缩进延续行为止。落在区间里的 env 读
 * ⇒ **模块加载期就读完了**（启动快照）。两条扩展规则缺一不可：
 *   · 括号平衡：`const A = Math.min(` 这种跳行括号靠深度归零判定；
 *   · 缩进延续：`export const B = Number(...)` 后面跟 `  && ...` / `  ? ... : ...` 时括号已平，
 *     但语句还没完（真例：`runner/lib/artifacts.js:27-29`）。
 * 偏保守：扫的是剥注释后的源码，字符串里的括号可能让区间略超宽 ⇒ 宁误判成「要重启」，
 * 不宁误判成「per-run 生效」（后者是会假绿的方向）。
 */
export function topLevelInitRanges(lines) {
  const ranges = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^(?:export\s+)?(?:const|let|var)\s/.test(lines[i])) continue;
    let depth = 0;
    let j = i;
    do {
      for (const ch of lines[j]) {
        if (ch === '{' || ch === '(' || ch === '[') depth += 1;
        else if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
      }
      j += 1;
    } while (depth > 0 && j < lines.length);
    while (j < lines.length) {
      const next = lines[j];
      if (!/^[ \t]+\S/.test(next)) break;
      // 延续行：缩进 + 以运算符/闭合符开头（`&& …` / `? … : …` / `) …` / `.then(…`）。
      // 不能用上行的结尾判：`export const B = Number(isFinite(...))` 上行以 `))` 结尾但语句没完。
      if (!/^[ \t]*(?:&&|\|\||\?\?|\?|:|\.{3}|\.[A-Za-z_$]|\)|\]|\}|,|\+|\*|\/|=>)/.test(next)) break;
      j += 1;
    }
    ranges.push([i + 1, j]);
    i = j - 1;
  }
  return ranges;
}

/** 往上找包裹这一行的函数名（只认 `function name(` / `const name = (` 两形），拿不到返回 null。 */
export function enclosingFunctionName(lines, line) {
  for (let i = line - 1; i >= 0; i -= 1) {
    let m = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(lines[i]);
    if (m) return m[1];
    m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

const insideRanges = (ranges, line) => ranges.some(([a, b]) => line >= a && line <= b);

/**
 * 扫一个源码树，返回每个 env 名的读取位置与读取形态。五种形态（写在这里，便于复核）：
 *   member   `process.env.NAME` / `process.env?.NAME`
 *   bracket  `process.env['NAME']` / `process.env["NAME"]`
 *   alias    以 env/Env 结尾的局部变量上的点号读（`env.NAME`、`baseEnv.NAME`）——
 *            `ERIX_BUILD_INFO_PATH` 就是这一形，只 grep `process.env.` 会漏。
 *            **赋值目标与 `delete` 不算读**（`childEnv.HOME = ...` 是给子进程写环境，
 *            不是本站读自己的环境），否则 `RUN_REVIEW_ONLY` 这种「portal 侧写入名」会混进读侧。
 *   table    数据表 / 别名常量（`const LLM_TIMEOUT_ENV = {...}`、`const TOOLCALL_MARKERS_ENV = 'ERIX_...'`）：
 *            真读发生在 `env[TABLE[key]]` 这种动态下标里，只按字面名 grep 抓不到位置。
 *            **只有当同文件确实存在「以 env/Env 结尾的变量 + 动态下标」时才认表**——
 *            否则一张名字里带 ENV 的普通数组（例如 stdio 子进程环境的字面清单）会被当成读点，
 *            把 `POST`/`SIGTERM` 之类的字符串误登记成 env 名。
 *            认表时除了表本身的声明行，**还把动态下标那一行也登成读点**（kind
 *            `tableDynamic`）——时机判定要看真正读的那一刻在不在函数体里，表声明行常常在顶层。
 *   每个读点另带一个布尔 `atLoad`：是否落在 `topLevelInitRanges` 的顶层初始化区间里。
 */
export function scanEnvReads(root, relDir) {
  const reads = new Map();
  const add = (name, file, line, kind, atLoad = false, fn = null) => {
    if (!NAME_RE.test(name)) return;
    if (!reads.has(name)) reads.set(name, []);
    const list = reads.get(name);
    const ref = `${file}:${line}`;
    const hit = list.find((r) => r.ref === ref);
    if (hit) {
      if (!hit.kinds.includes(kind)) hit.kinds.push(kind);
      hit.atLoad = hit.atLoad || atLoad;
      hit.fn = hit.fn || fn;
    } else list.push({ ref, file, line, kinds: [kind], atLoad, fn });
  };
  const files = listJsFiles(root, relDir);
  const tables = []; // 待定性：{ table, names, file, line }
  const tableVars = new Map(); // 表名 → 绑到它上的局部变量名（`const envName = LLM_TIMEOUT_ENV[field]`）
  const dynamicVars = new Set(); // 出现在 `env[VAR]` / `baseEnv[VAR]` 里的变量名
  const dynSites = new Map(); // 变量名 → 动态下标所在处（{file, line, atLoad}）
  const rangesByFile = new Map();
  for (const abs of files) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const src = stripJsComments(fs.readFileSync(abs, 'utf8'));
    const lines = src.split(/\r?\n/);
    const ranges = topLevelInitRanges(lines);
    rangesByFile.set(rel, ranges);
    const fnCache = new Map();
    const fnAt = (ln) => { if (!fnCache.has(ln)) fnCache.set(ln, enclosingFunctionName(lines, ln)); return fnCache.get(ln); };
    // 动态下标的变量（`out[field] = parseTimeoutMs(env?.[envName], ...)` 里的 `envName`）。
    let d;
    const reDyn = /\b(?:process\s*\.\s*env|(?:(?:[A-Za-z_$][\w$]*)?[Ee]nv))\s*(?:\?\.)?\s*\[\s*([A-Za-z_$][\w$]*)\s*(?:\]|\[)/g;
    while ((d = reDyn.exec(src)) !== null) {
      dynamicVars.add(d[1]);
      const line = src.slice(0, d.index).split('\n').length;
      if (!dynSites.has(d[1])) dynSites.set(d[1], []);
      dynSites.get(d[1]).push({ file: rel, line, atLoad: insideRanges(ranges, line), fn: enclosingFunctionName(lines, line) });
    }
    // 变量↔表的绑定：`const envName = TABLE[...]`、`for (const key of TABLE)`、
    // 默认参数 `{ key = TOOLCALL_MARKERS_ENV }` —— 三种写法都是「这个变量装的是 env 名」。
    let b;
    const reBind = /\b([A-Za-z_$][\w$]*)\s*(?:=|of)\s*([A-Z0-9_]*ENV[A-Z0-9_]*)\b/g;
    while ((b = reBind.exec(src)) !== null) {
      if (!tableVars.has(b[2])) tableVars.set(b[2], new Set());
      tableVars.get(b[2]).add(b[1]);
    }
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      let m;
      const reMember = /process\.env\s*(?:\?\.|\.)([A-Z][A-Z0-9_]{2,})\b/g;
      const at = insideRanges(ranges, i + 1);
      const fn = fnAt(i + 1);
      while ((m = reMember.exec(line)) !== null) add(m[1], rel, i + 1, 'member', at, fn);
      const reBracket = /process\.env\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g;
      while ((m = reBracket.exec(line)) !== null) add(m[1], rel, i + 1, 'bracket', at, fn);
      // 组一：裸 `env` 或任何以 env/Env 结尾的标识符（`baseEnv`、`childEnv`…）。
      const reAlias = /\b((?:[A-Za-z_$][A-Za-z0-9_$]*)?[Ee]nv)\s*(?:\?\.|\.)([A-Z][A-Z0-9_]{2,})\b/g;
      while ((m = reAlias.exec(line)) !== null) {
        const after = line.slice(m.index + m[0].length);
        if (/^\s*delete\s/.test(line.slice(Math.max(0, m.index - 7), m.index))) continue;
        if (/^\s*(\+\+|--|=)(?!=)/.test(after)) continue; // 赋值目标 ⇒ 写，不是读
        add(m[2], rel, i + 1, 'alias', at, fn);
      }
      // helper 首参形：`intEnv(env, 'NAME', 默认)` / `parseIntEnv(process.env, 'NAME', …)`。
      // 不补这一形就会**假绿**：portal/src/config.js 里的 `intEnv(env, 'ERIX_ARTIFACT_MAX_BYTES', …)`
      // 会让 portal 这个读者隐身 ⇒ 启动快照旋钮被误归「能搬」（评审 #677 第二轮 A）。
      const reHelper = /\(\s*(?:(?:process\s*\.\s*env)|(?:(?:[A-Za-z_$][\w$]*)?[Ee]nv))\s*,\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g;
      while ((m = reHelper.exec(line)) !== null) add(m[1], rel, i + 1, 'helperArg', at, fn);
      // 别名常量：`export const TOOLCALL_MARKERS_ENV = 'ERIX_...'`（名字在右边，待定表定性）。
      const reAliasConst = /\b([A-Z0-9_]*ENV[A-Z0-9_]*)\s*=\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g;
      while ((m = reAliasConst.exec(line)) !== null) {
        tables.push({ table: m[1], names: [m[2]], file: rel, line: i + 1, fn: fnAt(i + 1) });
      }
      const reTable = /\b([A-Z0-9_]*ENV[A-Z0-9_]*)\s*=\s*(?:Object\.freeze\(\s*)?([[{])/g;
      let t;
      while ((t = reTable.exec(line)) !== null) {
        const open = t[2];
        const close = open === '[' ? ']' : '}';
        let depth = 1;
        let j = i;
        // 先把**首行匹配之后的部分**算进深度（早先只数后续行，`Object.freeze([...]` 的收尾
        // 落在首行 ⇒ 深度永不归零，会一路吞到文件尾，把不相干的字符串都登记成 env 名）。
        let consumed = line.slice(t.index + t[0].length);
        for (const ch of consumed) {
          if (ch === open) depth += 1;
          else if (ch === close) depth -= 1;
        }
        while (depth > 0 && j + 1 < lines.length) {
          j += 1;
          consumed += '\n' + lines[j];
          for (const ch of lines[j]) {
            if (ch === open) depth += 1;
            else if (ch === close) depth -= 1;
          }
        }
        const names = [];
        const reName = /['"]([A-Z][A-Z0-9_]{2,})['"]/g;
        let n;
        while ((n = reName.exec(consumed)) !== null) names.push(n[1]);
        if (names.length > 0) tables.push({ table: t[1], names, file: rel, line: i + 1, fn: fnAt(i + 1) });
      }
    }
  }
  // 定性：只有真的被当作 env 名喂进动态下标的表才算读点。
  const isLive = (tableName) => {
    if (dynamicVars.has(tableName)) return true;
    for (const v of tableVars.get(tableName) ?? []) if (dynamicVars.has(v)) return true;
    return false;
  };
  for (const t of tables) {
    if (!isLive(t.table)) continue;
    // 动态下标那一行也登成读点：时机（是不是每 run 才读）要看真正读的那一刻，不是表声明行。
    const dynRefs = [];
    for (const v of tableVars.get(t.table) ?? []) {
      for (const s of dynSites.get(v) ?? []) if (s.file === t.file) dynRefs.push(s);
    }
    for (const name of t.names) {
      add(name, t.file, t.line, 'table', insideRanges(rangesByFile.get(t.file) ?? [], t.line), t.fn);
      for (const s of dynRefs) add(name, s.file, s.line, 'tableDynamic', s.atLoad, s.fn);
    }
  }
  return reads;
}

/**
 * 子进程环境的**放行面**（表名以 `_ALLOWLIST` 结尾且内容是大写 env 名）：
 * 这些名字是被递给子进程的基线环境，不是本站的旋钮，也不该被「runner 读了但 portal 没注入」
 * 报成断链（它们由镜像与容器基座提供）。返回名字集合。
 */
export function scanChildEnvAllowlists(root, relDir) {
  const out = new Set();
  for (const abs of listJsFiles(root, relDir)) {
    const src = stripJsComments(fs.readFileSync(abs, 'utf8'));
    const re = /\b([A-Z0-9_]*ENV[A-Z0-9_]*ALLOWLIST)\s*=\s*(?:Object\.freeze\(\s*)([[{][^\]}]*[\]}])/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      for (const n of m[2].matchAll(/['"]([A-Z][A-Z0-9_]{2,})['"]/g)) out.add(n[1]);
    }
  }
  return out;
}

/**
 * env 的**写点**（给子进程改环境），用于识别「per-run 下发」通路：
 * `childEnv.NAME = '1'` / `delete childEnv.NAME` / `childEnv['NAME'] = …`。
 * 写点行缩进 > 0（在函数体里）⇒ 算 per-run（例如 agentd 的 `buildWorkerEnv` 每起一个 run 写一次）；
 * 顶层写点只算「启动期改写」，不算 per-run。
 * @returns {Map<string, Array<{ref:string, perRun:boolean}>>}
 */
export function scanEnvWriteSites(root, relDir) {
  const out = new Map();
  const add = (name, file, line, perRun) => {
    if (!NAME_RE.test(name)) return;
    if (!out.has(name)) out.set(name, []);
    const ref = `${file}:${line}`;
    const hit = out.get(name).find((w) => w.ref === ref);
    if (hit) hit.perRun = hit.perRun || perRun;
    else out.get(name).push({ ref, perRun });
  };
  for (const abs of listJsFiles(root, relDir)) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const lines = stripJsComments(fs.readFileSync(abs, 'utf8')).split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const indent = line.match(/^\s*/)[0].length;
      let m;
      const reDot = /\b((?:[A-Za-z_$][\w$]*)?[Ee]nv)\s*(?:\?\.|\.)\s*([A-Z][A-Z0-9_]{2,})\s*(?:=|\+\+|--)(?!=)/g;
      while ((m = reDot.exec(line)) !== null) add(m[2], rel, i + 1, indent > 0);
      const reDel = /\bdelete\s+((?:[A-Za-z_$][\w$]*)?[Ee]nv)\s*(?:\?\.|\.)\s*([A-Z][A-Z0-9_]{2,})/g;
      while ((m = reDel.exec(line)) !== null) add(m[2], rel, i + 1, indent > 0);
      const reBrk = /\b((?:[A-Za-z_$][\w$]*)?[Ee]nv)\s*\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]\s*=(?!=)/g;
      while ((m = reBrk.exec(line)) !== null) add(m[2], rel, i + 1, indent > 0);
    }
  }
  return out;
}

// ───────────────────────────────── 判定

// ───────────────── 动态下标读取 + 登记表交叉对账（本轮新增）

/**
 * 扫“下标不是字符串字面量”的 env 读取（`process.env[name]` / `baseEnv[key]` / `env?.[key]`）。
 * 这类读取形态**无法从字面直接点名**某个旋钮（名字运行时才知道）；其中一部分会被
 * {@link scanEnvReads} 的“表启发式”间接解析，但读取点上看不出来 ⇒ 单独列进「已知未解析的读取形态」。
 * 只扫与 {@link scanEnvReads} 同一扫描面（listJsFiles：仅 *.js、跳过 SKIP_DIRS）；
 * 非 .js（如 .mjs）与被 SKIP_DIRS 排除的目录根本进不来 ⇒ 由调用方另以“扫描面口径”文字补齐。
 * @returns {Array<{ref:string, index:string, expr:string}>}
 */
export function scanDynamicEnvIndex(root, relDir) {
  const out = [];
  const re = /(?:(?:process\s*\.\s*env)|(?:(?:[A-Za-z_$][\w$]*)?[Ee]nv))\s*(?:\?\.)?\s*\[\s*([A-Za-z_$][\w$]*)\s*\]/g;
  for (const abs of listJsFiles(root, relDir)) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const src = stripJsComments(fs.readFileSync(abs, 'utf8'));
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      const line = src.slice(0, m.index).split('\n').length;
      out.push({ ref: `${rel}:${line}`, index: m[1], expr: m[0].trim() });
    }
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref));
}

/**
 * 读登记表（不崩）：文件不存在 ⇒ present:false；JSON 解析失败 ⇒ present:true + error。
 * 结构（现读一遍）：`{ exceptions: [{key,where,reason}], unsupported: [{at,read,reason}] }`。
 */
export function readLegsExceptions(root) {
  const f = readIfExists(root, LEGS_EXCEPTIONS_FILE);
  if (f.missing) return { present: false, exceptions: [], unsupported: [], error: null };
  try {
    const j = JSON.parse(f.text);
    return {
      present: true,
      exceptions: Array.isArray(j.exceptions) ? j.exceptions : [],
      unsupported: Array.isArray(j.unsupported) ? j.unsupported : [],
      error: null,
    };
  } catch (e) {
    return { present: true, exceptions: [], unsupported: [], error: String((e && e.message) || e) };
  }
}

/**
 * 与登记表的差集（三类）：
 *   A registeredButLegsComplete：登记了但工具现在判“三腿齐”（登记表规矩⑤⇒ 应删）。
 *   B brokenNotRegistered：工具判“runner 真读了但不在三腿链上”（非旋钮除外）但登记表里没这条。
 *   C unsupported：登记表登为“读形认得、名字解析不出”的形态，原样列出。
 */
export function computeLegsDiff(knobs, reg) {
  const legsComplete = (k) => k.injected.length > 0 && k.allowlisted.length > 0 && k.runnerReads.length > 0;
  const exceptionKeys = new Set((reg.exceptions || []).map((e) => e && e.key).filter(Boolean));
  const registeredButLegsComplete = [];
  const brokenNotRegistered = [];
  for (const k of knobs) {
    if (exceptionKeys.has(k.name) && legsComplete(k)) registeredButLegsComplete.push(k.name);
    if (!exceptionKeys.has(k.name) && !k.passThrough && k.runnerReads.length > 0 && !legsComplete(k)) brokenNotRegistered.push(k.name);
  }
  return {
    present: reg.present,
    error: reg.error ?? null,
    exceptionCount: (reg.exceptions || []).length,
    unsupportedCount: (reg.unsupported || []).length,
    registeredButLegsComplete,
    brokenNotRegistered,
    unsupported: (reg.unsupported || []).map((u) => ({ at: u.at, read: u.read })),
  };
}

/** 「容器起来之前就得知道」的判据（见文件头 P1–P4）；返回命中的判据编号，空数组 = 不属之。 */
export function bootReasons({ name, portalReadFiles, composeEntry, composeService, injected }) {
  const why = [];
  const inBootSnapshot = portalReadFiles.some((f) => f === 'portal/src/config.js');
  const infra = INFRA_NAME_PATTERNS.some((re) => re.test(name));
  if (inBootSnapshot && DB_URL_PATTERN.test(name)) why.push('P1连库');
  if (infra || composeService === 'station-docker-proxy') why.push('P2容器怎么起');
  if (inBootSnapshot) why.push('P3启动快照');
  if (IDENTITY_PATTERN.test(name)) why.push('P4身份/凭据');
  if (injected.length > 0 && !composeEntry) why.push('P4派生');
  return why;
}

/** 四处落点的断点判定（只判「链路上」的键：portal 注入 / proxy 放行 / runner 真读 三者之一）。 */
export function findBreaks({ name, composeEntry, portalComposeOnly, injected, allowlisted, runnerReads, passThrough = PASS_THROUGH_KEYS, perRunWrites = [] }) {
  const breaks = [];
  const chain = injected.length > 0 || allowlisted.length > 0 || runnerReads.length > 0;
  if (!chain) return breaks;
  const perRunRefs = perRunWrites.filter((w) => w.perRun).map((w) => w.ref);
  if (injected.length > 0 && allowlisted.length === 0 && !passThrough.has(name)) {
    breaks.push('断在 proxy 白名单（注入但没进 `ENV_KEY_ALLOW` ⇒ 现网 `create_policy_denied`）');
  }
  if (runnerReads.length > 0 && injected.length === 0 && !passThrough.has(name)) {
    if (perRunRefs.length > 0) {
      // 不是断链：这根本不走 compose→provisioner→proxy 那四处落点，而是 runner 自己每跑一个 run
      // 写一次子进程环境（例如 `RUN_REVIEW_ONLY`：portal 工单字段 → agentd 写 childEnv → worker 读）。
      // 把它算进「断在注入」会把通路正常的旋钮报成假阳性。
      breaks.push(`per-run 下发（不经容器 Env；写点 ${perRunRefs.join(',')}）`);
    } else {
      breaks.push('断在注入（runner 读，但 portal 不往 FDE 容器注 ⇒ compose/env 面改不动它，要改只能重建镜像）');
    }
  }
  if (allowlisted.length > 0 && injected.length === 0 && !passThrough.has(name)) {
    breaks.push('断在注入（白名单放行，但没人注 ⇒ 这条放行是空转）');
  }
  if (allowlisted.length > 0 && runnerReads.length === 0 && !passThrough.has(name)) {
    breaks.push('死光纤（在白名单但 runner 不读 ⇒ 投进去没人用）');
  }
  if (composeEntry && runnerReads.length > 0 && injected.length === 0) {
    breaks.push('断在第二环（compose 写了、portal 只把它当自己的 env，没往 FDE 注）');
  }
  if (composeEntry && injected.length > 0 && name.startsWith('ERIX_') && !portalComposeOnly) {
    // 只是提示，不是断点：值来自 compose 的插值默认，改它要重建容器
  }
  void name;
  return breaks;
}

/** 三堆归位：`db` 能搬 / `no` 不能搬 / `human` 需人判 / `non` 非旋钮（基线环境，不参与三堆）。 */
export function classifyPile({ bootWhy, injected, allowlisted, runnerReads, portalReadFiles, composeEntry, passThrough, timing }) {
  const legsComplete = injected.length > 0 && allowlisted.length > 0 && runnerReads.length > 0;
  if (passThrough) return 'non';
  if (bootWhy.length > 0) return 'no';
  if (legsComplete && portalReadFiles.length === 0) {
    // 能搬再分两堆：改 DB 后要不要重启看消费时机（consumeTiming）。
    if (timing === 'per-run') return 'dbPerRun';
    if (timing === '启动快照') return 'dbRestart';
    return 'human'; // 时机未知 ⇒ 不敢断言「改 DB 要不要重启」，交人判
  }
  if (legsComplete) return 'human'; // 三腿齐但 portal 也读 ⇒ 两处消费，要人裁定以谁为准
  if (!composeEntry && injected.length === 0 && runnerReads.length === 0 && allowlisted.length === 0) return 'human';
  return 'human';
}

/**
 * 消费时机（第二个维度）：「改 DB 后要不要重启」。不另加一堆新信息，吃的仍是已有三件事：
 *   1. portal 侧有 per-run 写点（函数体内 `childEnv.NAME =`）⇒ **per-run**（每次 run 新建 FDE 时重读）
 *   2. runner 侧读点有一条不在顶层初始化区间（在函数体里）⇒ **per-run**
 *   3. runner 侧读点全在顶层初始化区 ⇒ **启动快照**；根本没有 runner 读点 ⇒ **未知**
 * 为什么需要它：compose 自己就点破了两种消费时机不同（`deploy/docker-compose.yml:113`：
 * 「per-run 生效（同 ERIX_LLM_*），与容器 Env 那个同名变量是两个东西」）；
 * `runner/lib/llm-timeouts.js:103` 是每 run 构造 LLM 请求头时才读（名字走
 * `LLM_TIMEOUT_ENV` 表，动态下标行已被登成读点），而 `runner/lib/shell-tools.js:20` 是模块顶层
 * const——后者改了不重启不生效。
 */
export function consumeTiming({ runnerReads = [], writes = [] } = {}) {
  const perRunWrite = writes.find((w) => w.perRun);
  if (perRunWrite) {
    return { timing: 'per-run', why: `P1 portal 每 run 新建 FDE 时重写子环境（${perRunWrite.ref}）⇒ 改 DB 下个 run 就生效` };
  }
  const fnRead = runnerReads.find((r) => !r.atLoad);
  if (fnRead) {
    const caveat = fnRead.fn ? `（在函数 ${fnRead.fn} 内；若它的调用方全在启动路径上，实际仍是启动快照——拿这个 file:line 复核）` : '';
    return { timing: 'per-run', why: `P1 runner 在函数体里读（每次调用现取），${fnRead.ref}${caveat} ⇒ 改 DB 下个 run 就生效` };
  }
  if (runnerReads.length > 0) {
    return { timing: '启动快照', why: `P2 runner 读点全在模块顶层初始化区（${runnerReads.map((r) => r.ref).join(', ')}）⇒ 改了要重启/重建容器` };
  }
  return { timing: '未知', why: 'P4 runner 侧无读点，无法断言生效时机' };
}

// ───────────────────────────────── 组表

/** 清点整仓库，返回 { knobs, subtotals, piles, opened, missing }。 */
export function buildInventory(root = DEFAULT_ROOT) {
  const compose = readIfExists(root, COMPOSE_FILE);
  const proxy = readIfExists(root, PROXY_FILE);
  const provisioner = readIfExists(root, PROVISIONER_FILE);
  const missing = [];
  for (const f of [compose, proxy, provisioner]) if (f.missing) missing.push(relOf(root, f.abs));

  const { envByService: services, warnings: composeWarnings } = parseComposeEnvWithWarnings(compose.text);
  const portalEntries = services['station-portal'] ?? [];
  const proxyEntries = services['station-docker-proxy'] ?? [];
  const composeByService = {};
  for (const [svc, list] of Object.entries(services)) {
    for (const e of list) {
      if (!composeByService[e.name]) composeByService[e.name] = [];
      composeByService[e.name].push({ ...e, service: svc });
    }
  }

  const injected = groupBy(parseInjectedEnv(provisioner.text), (x) => x.name);
  const allowlisted = parseProxyAllowlist(proxy.text);
  const allowByName = groupBy(allowlisted, (x) => x.name);

  const runnerReads = scanEnvReads(root, RUNNER_DIR);
  const portalReads = scanEnvReads(root, PORTAL_SRC_DIR);
  // per-run 下发通路（agentd 每起一个 run 重写一次子环境）：这类不算「断在注入」。
  const perRunWrites = scanEnvWriteSites(root, RUNNER_DIR);
  // 子进程基线环境（镜像自带）与硬登记的例外：都不算旋钮。
  const passThrough = new Set([...PASS_THROUGH_KEYS, ...scanChildEnvAllowlists(root, RUNNER_DIR)]);

  // 本轮新增：动态下标读取形态（扫描面内能扫到的）。只读，不改任何现有文件。
  const dynamicSites = [
    ...scanDynamicEnvIndex(root, RUNNER_DIR),
    ...scanDynamicEnvIndex(root, PORTAL_SRC_DIR),
  ].sort((a, b) => a.ref.localeCompare(b.ref));

  const names = new Set([
    ...Object.keys(composeByService),
    ...injected.keys(),
    ...allowByName.keys(),
    ...runnerReads.keys(),
    ...portalReads.keys(),
  ]);

  const knobs = [];
  for (const name of [...names].sort()) {
    const entries = composeByService[name] ?? [];
    const portalEntry = entries.find((e) => e.service === 'station-portal') ?? null;
    const otherService = entries.find((e) => e.service !== 'station-portal') ?? null;
    const inj = injected.get(name) ?? [];
    const allow = allowByName.get(name) ?? [];
    const rReads = runnerReads.get(name) ?? [];
    // 「读完就地注入」不算 portal 的**消费**（那是转发，不是第二个人读）：
    // 同一名字、同一 `file:line` 既是注入点又是读点 ⇒ 剔掉，否则所有转发旋钮都会被当成
    // 「portal 也在读」而进不了「能搬」那一堆。
    const injRefs = new Set(inj.map((x) => `${PROVISIONER_FILE}:${x.line}`));
    const pReads = (portalReads.get(name) ?? []).filter((r) => !injRefs.has(r.ref));
    const pFiles = [...new Set(pReads.map((r) => r.file))];
    const writes = perRunWrites.get(name) ?? [];
    const delivery = inj.length > 0
      ? 'container-Env'
      : (writes.some((w) => w.perRun) ? 'per-run' : (allow.length > 0 ? '仅放行未注入' : '未知（镜像/基座）'));
    const composeOnly = Boolean(portalEntry) && pReads.length > 0 && rReads.length === 0 && inj.length === 0;
    const bootWhy = bootReasons({ name, portalReadFiles: pFiles, composeEntry: portalEntry, composeService: otherService?.service, injected: inj });
    const { timing, why: timingWhy } = consumeTiming({ runnerReads: rReads, writes });
    const breaks = findBreaks({
      name,
      composeEntry: portalEntry,
      portalComposeOnly: composeOnly,
      injected: inj,
      allowlisted: allow,
      runnerReads: rReads,
      passThrough,
      perRunWrites: writes,
    });
    knobs.push({
      name,
      compose: portalEntry
        ? { form: portalEntry.form, line: portalEntry.line, service: 'station-portal', raw: portalEntry.raw }
        : otherService
          ? { form: otherService.form, line: otherService.line, service: otherService.service, raw: otherService.raw }
          : null,
      readers: [...pReads, ...rReads].map((r) => ({ ref: r.ref, side: pReads.includes(r) ? 'portal' : 'runner', kinds: r.kinds })),
      injected: inj.map((x) => `${PROVISIONER_FILE}:${x.line}`),
      allowlisted: allow.map((x) => `${PROXY_FILE}:${x.line}`),
      runnerReads: rReads.map((r) => ({ ref: r.ref, kinds: r.kinds, atLoad: r.atLoad, fn: r.fn })),
      portalReads: pReads.map((r) => ({ ref: r.ref, kinds: r.kinds, atLoad: r.atLoad, fn: r.fn })),
      writes: writes.map((w) => ({ ref: w.ref, perRun: w.perRun })),
      delivery, timing, timingWhy,
      bootWhy,
      breaks,
      pile: classifyPile({ bootWhy, injected: inj, allowlisted: allow, runnerReads: rReads, portalReadFiles: pFiles, composeEntry: portalEntry, passThrough: passThrough.has(name), timing }),
      passThrough: passThrough.has(name),
    });
  }
  knobs.sort((a, b) => a.name.localeCompare(b.name));

  const injectedNoAllow = knobs.filter((k) => k.injected.length > 0 && k.allowlisted.length === 0 && !k.passThrough);
  const readNotInjected = knobs.filter((k) => k.runnerReads.length > 0 && k.injected.length === 0 && !k.passThrough && k.delivery !== 'per-run');
  const perRunDelivered = knobs.filter((k) => k.runnerReads.length > 0 && k.injected.length === 0 && k.delivery === 'per-run' && !k.passThrough);
  const deadFiber = knobs.filter((k) => k.allowlisted.length > 0 && k.runnerReads.length === 0 && !k.passThrough);
  return {
    root,
    knobs,
    opened: [
      COMPOSE_FILE, PROXY_FILE, PROVISIONER_FILE,
      `${PORTAL_SRC_DIR}/（全部 *.js，剥注释后扫五种读取形态 + 顶层初始化区间）`,
      `${RUNNER_DIR}/（含 lib，跳过 test/probes/skills/node_modules）`,
    ],
    missing,
    counts: {
      composePortalKeys: portalEntries.length,
      composeProxyKeys: proxyEntries.length,
      allowlist: new Set(allowlisted.map((a) => a.name)).size,
      injected: new Set(parseInjectedEnv(provisioner.text).map((a) => a.name)).size,
      runnerReadNames: runnerReads.size,
      portalReadNames: portalReads.size,
      passThroughNames: passThrough.size,
    },
    subtotals: {
      injectedNotAllowlisted: injectedNoAllow.map((k) => k.name),
      runnerReadNotInjected: readNotInjected.map((k) => k.name),
      perRunDelivered: perRunDelivered.map((k) => k.name),
      allowlistedNobodyRead: deadFiber.map((k) => k.name),
    },
    piles: {
      dbPerRun: knobs.filter((k) => k.pile === 'dbPerRun').map((k) => k.name),
      dbRestart: knobs.filter((k) => k.pile === 'dbRestart').map((k) => k.name),
      no: knobs.filter((k) => k.pile === 'no').map((k) => k.name),
      human: knobs.filter((k) => k.pile === 'human').map((k) => k.name),
      nonKnob: knobs.filter((k) => k.pile === 'non').map((k) => k.name),
    },
    /** 全量「能搬」（不分时机），方便与上一轮结果对账 */
    pilesAll: {
      db: [...knobs.filter((k) => k.pile === 'dbPerRun' || k.pile === 'dbRestart').map((k) => k.name)],
    },
    /** ① compose 里认不出的 YAML 形状（静默空表现在会被喊出来）；真实 compose 上应为空。 */
    warnings: composeWarnings,
    /** ② 与登记表的差集（读不到登记表 ⇒ present:false，不崩）。 */
    legsDiff: computeLegsDiff(knobs, readLegsExceptions(root)),
    /** ③ 本工具不解析的读取形态：能扫的动态下标 + 扫描面口径（哪些目录/扩展名没进）。 */
    unparsedForms: {
      dynamicSites,
      surface: {
        scannedExtensions: ['*.js（不含 *.test.js）'],
        extensionsNotScanned: ['.mjs / .cjs / .ts 等非 .js（例：runner/skills/github/skill.mjs）'],
        skippedDirs: [...SKIP_DIRS],
        notNamedReads: [
          '`...process.env` / `{ ...baseEnv }` 整包展开（不点名某个键，不算具名读点）',
          '动态下标读取（下标不是字符串字面量，名字运行时才知道；见 dynamicSites）',
        ],
        realRepoExamples: [
          'runner/worker.js process.env[name]（下标来自数组，登记为 unsupported）',
          'runner/lib/mcp-client.js baseEnv[key]（key 来自 STDIO_ENV_ALLOWLIST，登记为 unsupported）',
          'runner/skills/github/skill.mjs `...process.env`（.mjs + skills 双重排除出扫描面）',
        ],
      },
    },
  };
}

function groupBy(list, keyOf) {
  const m = new Map();
  for (const it of list) {
    const k = keyOf(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

function relOf(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/') || abs;
}

// ───────────────────────────────── 输出

function shortRefs(list, n = 3) {
  if (list.length === 0) return '否';
  const refs = list.map((x) => (typeof x === 'string' ? x : x.ref));
  const shown = refs.slice(0, n);
  return shown.join(',') + (refs.length > n ? `(+${refs.length - n})` : '');
}

export function renderTable(inv) {
  const out = [];
  out.push('旋钮名 | compose 里怎么写 | 谁读它(file:line) | portal 注入 FDE(file:line/否) | 在 proxy 白名单 | runner 真读(file:line/否) | 断在哪一环 | 容器起来前就得知道');
  out.push('---|---|---|---|---|---|---|---');
  for (const k of inv.knobs) {
    const composeCell = k.compose
      ? `${k.compose.form}${k.compose.service === 'station-portal' ? '' : `@${k.compose.service}`}（compose:${k.compose.line}）`
      : '不在 compose';
    const bootCell = k.bootWhy.length > 0 ? `是 ${k.bootWhy.join('+')}` : '否';
    out.push([
      k.name,
      composeCell,
      shortRefs(k.readers),
      shortRefs(k.injected),
      k.allowlisted.length > 0 ? `是（${PROXY_FILE}）` : '否',
      shortRefs(k.runnerReads),
      k.breaks.length > 0 ? k.breaks.join(' + ') : '—',
      bootCell,
    ].join(' | '));
  }
  return out;
}

export function renderSummary(inv) {
  const out = [];
  const s = inv.subtotals;
  const c = inv.counts;
  out.push('');
  out.push('=== 计数（现读，非引用）===');
  out.push(`compose station-portal.environment 键数=${c.composePortalKeys}；` +
    `station-docker-proxy.environment 键数=${c.composeProxyKeys}；` +
    `proxy ENV_KEY_ALLOW=${c.allowlist}；portal 注入=${c.injected}；` +
    `runner 真读名=${c.runnerReadNames}；portal 读名=${c.portalReadNames}`);
  if (inv.missing.length > 0) out.push(`打不开（按「不存在」计）：${inv.missing.join(', ')}`);
  out.push('');
  out.push('=== 三腿不齐小计 ===');
  out.push(`注入但没进白名单=${s.injectedNotAllowlisted.length} ${fmt(s.injectedNotAllowlisted)}`);
  out.push(`runner 读了但 portal 没注入=${s.runnerReadNotInjected.length} ${fmt(s.runnerReadNotInjected)}`);
  out.push(`per-run 下发（不经容器 Env，不算断链）=${s.perRunDelivered.length} ${fmt(s.perRunDelivered)}`);
  out.push(`在白名单但没人读（死光纤）=${s.allowlistedNobodyRead.length} ${fmt(s.allowlistedNobodyRead)}`);
  out.push('');
  out.push('=== 能不能搬进 DB × 消费时机（判据见文件头）===');
  out.push(`能搬·不用重启（per-run 生效：三腿齐 + 非启动前必知 + portal 不读 + 函数体里读）=${inv.piles.dbPerRun.length} ${fmt(inv.piles.dbPerRun)}`);
  out.push(`能搬·但要重启（读点全在模块加载期，改 DB 后得重启/重建容器）=${inv.piles.dbRestart.length} ${fmt(inv.piles.dbRestart)}`);
  out.push(`不能搬（容器起来之前就得知道）=${inv.piles.no.length} ${fmt(inv.piles.no)}`);
  out.push(`需人判=${inv.piles.human.length} ${fmt(inv.piles.human)}`);
  out.push(`（不计入三堆）非旋钮、子进程/容器基线环境=${inv.piles.nonKnob.length} ${fmt(inv.piles.nonKnob)}`);
  out.push('');
  out.push('=== 逐键判据（判「不能搬」/「断链」/「能搬（看时机）」的每根都列）===');
  for (const k of inv.knobs) {
    const decided = k.pile === 'dbPerRun' || k.pile === 'dbRestart' || k.timing === '未知';
    if (k.bootWhy.length === 0 && k.breaks.length === 0 && !decided) continue;
    const t = `时机=${k.timing}${decided ? `（${k.timingWhy}）` : ''}`;
    out.push(`- ${k.name}：${t} boot=${k.bootWhy.join('+') || '—'} 断=${k.breaks.join(' + ') || '—'}`);
  }

  // ① 未解析/可疑的 YAML 形状（静默空表现在会被喊出来）
  out.push('');
  out.push('=== 未解析/可疑 YAML 形状 ===');
  const warns = inv.warnings ?? [];
  if (warns.length === 0) {
    out.push('无');
  } else {
    for (const w of warns) {
      out.push(`- [${w.kind}] ${w.service ?? '(顶层)'} compose:${w.line}  ${w.raw}`);
    }
  }

  // ② 与登记表的差集（读不到 ⇒ 明说不差，不崩）
  out.push('');
  out.push(`=== 与 ${LEGS_EXCEPTIONS_FILE} 的差集 ===`);
  const diff = inv.legsDiff;
  if (!diff || !diff.present) {
    out.push('登记表不存在 ⇒ 差集不在本工具面内');
  } else {
    if (diff.error) out.push(`登记表解析失败（不崩，按空登记处理）：${diff.error}`);
    out.push(`登记表：exceptions=${diff.exceptionCount} unsupported=${diff.unsupportedCount}`);
    out.push(`- 登记了但工具现在判「三腿齐」（应删条）=${diff.registeredButLegsComplete.length} ${fmt(diff.registeredButLegsComplete)}`);
    out.push(`- 工具判断链（runner 读了但不在三腿链）但没登记=${diff.brokenNotRegistered.length} ${fmt(diff.brokenNotRegistered)}`);
    out.push(`- 登记为 unsupported 的形态=${diff.unsupported.length}`);
    for (const u of diff.unsupported) out.push(`    · ${u.at}  ${u.read}`);
  }

  // ③ 已知未解析的读取形态：能扫的动态下标 + 扫描面口径
  out.push('');
  out.push('=== 已知未解析的读取形态 ===');
  const uf = inv.unparsedForms ?? { dynamicSites: [], surface: {} };
  const surf = uf.surface ?? {};
  out.push('动态下标（下标不是字符串字面量 ⇒ 从读取形态点不出名）：');
  if ((uf.dynamicSites ?? []).length === 0) {
    out.push('  无（扫描面内未发现动态下标）');
  } else {
    for (const d of uf.dynamicSites) out.push(`  - ${d.ref}  ${d.expr}  (下标=${d.index})`);
  }
  out.push('扫描面口径（下面这些没进扫描面，别当已覆盖）：');
  out.push(`  - 扫描扩展名：${(surf.scannedExtensions ?? []).join(', ')}；未扫：${(surf.extensionsNotScanned ?? []).join(' / ')}`);
  out.push(`  - 跳过目录（SKIP_DIRS）：${(surf.skippedDirs ?? []).join(', ')}`);
  for (const n of surf.notNamedReads ?? []) out.push(`  - 不算具名读点：${n}`);
  for (const e of surf.realRepoExamples ?? []) out.push(`  - 真实仓实例：${e}`);
  return out;
}

function fmt(list) {
  return list.length === 0 ? '（空）' : `[${list.join(', ')}]`;
}

function main(argv) {
  const root = argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : DEFAULT_ROOT;
  const inv = buildInventory(root);
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(inv, null, 2) + '\n');
    return 0;
  }
  for (const line of renderTable(inv)) process.stdout.write(line + '\n');
  for (const line of renderSummary(inv)) process.stdout.write(line + '\n');
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
