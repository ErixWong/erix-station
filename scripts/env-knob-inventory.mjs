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
export function parseComposeEnv(text) {
  const lines = text.split(/\r?\n/);
  const services = {};
  let inServices = false;
  let service = null;
  let envIndent = -1;
  let cur = null;
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (/^services:\s*$/.test(line)) { inServices = true; service = null; envIndent = -1; continue; }
    if (!inServices) continue;
    if (/^[A-Za-z0-9_-]+:/.test(line)) break; // services 之外的顶层段 ⇒ 结束
    const svc = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (svc) { service = svc[1]; services[service] = []; envIndent = -1; cur = null; continue; }
    const top = line.match(/^ {2}(\S.*)$/);
    if (top) { envIndent = -1; cur = null; } // 换到该服务的另一个字段
    const env = line.match(/^(\s+)environment:\s*$/);
    if (env && service) { envIndent = env[1].length; cur = null; continue; }
    if (envIndent < 0 || !service) continue;
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= envIndent) { envIndent = -1; cur = null; continue; }
    const kv = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*(.*)$/);
    if (kv) {
      cur = { name: kv[1], raw: kv[2].trim(), line: idx + 1, form: classifyComposeValue(kv[2].trim()) };
      services[service].push(cur);
    } else if (cur && indent > envIndent + 2) {
      cur.raw += ' ' + line.trim(); // 多行值（例如 `${VAR:?多行说明}`）的续行
      cur.form = classifyComposeValue(cur.raw);
    }
  }
  return services;
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
 * 扫一个源码树，返回每个 env 名的读取位置与读取形态。四种形态（写在这里，便于复核）：
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
 */
export function scanEnvReads(root, relDir) {
  const reads = new Map();
  const add = (name, file, line, kind) => {
    if (!NAME_RE.test(name)) return;
    if (!reads.has(name)) reads.set(name, []);
    const list = reads.get(name);
    const ref = `${file}:${line}`;
    const hit = list.find((r) => r.ref === ref);
    if (hit) { if (!hit.kinds.includes(kind)) hit.kinds.push(kind); }
    else list.push({ ref, file, line, kinds: [kind] });
  };
  const files = listJsFiles(root, relDir);
  const tables = []; // 待定性：{ table, names, file, line }
  const tableVars = new Map(); // 表名 → 绑到它上的局部变量名（`const envName = LLM_TIMEOUT_ENV[field]`）
  const dynamicVars = new Set(); // 出现在 `env[VAR]` / `baseEnv[VAR]` 里的变量名
  for (const abs of files) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const src = stripJsComments(fs.readFileSync(abs, 'utf8'));
    const lines = src.split(/\r?\n/);
    // 动态下标的变量（`out[field] = parseTimeoutMs(env?.[envName], ...)` 里的 `envName`）。
    let d;
    const reDyn = /\b(?:process\s*\.\s*env|(?:(?:[A-Za-z_$][\w$]*)?[Ee]nv))\s*(?:\?\.)?\s*\[\s*([A-Za-z_$][\w$]*)\s*(?:\]|\[)/g;
    while ((d = reDyn.exec(src)) !== null) dynamicVars.add(d[1]);
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
      while ((m = reMember.exec(line)) !== null) add(m[1], rel, i + 1, 'member');
      const reBracket = /process\.env\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g;
      while ((m = reBracket.exec(line)) !== null) add(m[1], rel, i + 1, 'bracket');
      // 组一：裸 `env` 或任何以 env/Env 结尾的标识符（`baseEnv`、`childEnv`…）。
      const reAlias = /\b((?:[A-Za-z_$][A-Za-z0-9_$]*)?[Ee]nv)\s*(?:\?\.|\.)([A-Z][A-Z0-9_]{2,})\b/g;
      while ((m = reAlias.exec(line)) !== null) {
        const after = line.slice(m.index + m[0].length);
        if (/^\s*delete\s/.test(line.slice(Math.max(0, m.index - 7), m.index))) continue;
        if (/^\s*(\+\+|--|=)(?!=)/.test(after)) continue; // 赋值目标 ⇒ 写，不是读
        add(m[2], rel, i + 1, 'alias');
      }
      const reAliasConst = /\b([A-Z0-9_]*ENV[A-Z0-9_]*)\s*=\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g;
      while ((m = reAliasConst.exec(line)) !== null) {
        tables.push({ table: m[1], names: [m[2]], file: rel, line: i + 1 });
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
        if (names.length > 0) tables.push({ table: t[1], names, file: rel, line: i + 1 });
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
    for (const name of t.names) add(name, t.file, t.line, 'table');
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

// ───────────────────────────────── 判定

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
export function findBreaks({ name, composeEntry, portalComposeOnly, injected, allowlisted, runnerReads, passThrough = PASS_THROUGH_KEYS }) {
  const breaks = [];
  const chain = injected.length > 0 || allowlisted.length > 0 || runnerReads.length > 0;
  if (!chain) return breaks;
  if (injected.length > 0 && allowlisted.length === 0 && !passThrough.has(name)) {
    breaks.push('断在 proxy 白名单（注入但没进 `ENV_KEY_ALLOW` ⇒ 现网 `create_policy_denied`）');
  }
  if (runnerReads.length > 0 && injected.length === 0 && !passThrough.has(name)) {
    breaks.push('断在注入（runner 读，但 portal 不往 FDE 容器注 ⇒ compose/env 面改不动它，要改只能重建镜像或由 agentd 每 run 下发）');
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
export function classifyPile({ bootWhy, injected, allowlisted, runnerReads, portalReadFiles, composeEntry, passThrough }) {
  const legsComplete = injected.length > 0 && allowlisted.length > 0 && runnerReads.length > 0;
  if (passThrough) return 'non';
  if (bootWhy.length > 0) return 'no';
  if (legsComplete && portalReadFiles.length === 0) return 'db';
  if (legsComplete) return 'human'; // 三腿齐但 portal 也读 ⇒ 两处消费，要人裁定以谁为准
  if (!composeEntry && injected.length === 0 && runnerReads.length === 0 && allowlisted.length === 0) return 'human';
  return 'human';
}

// ───────────────────────────────── 组表

/** 清点整仓库，返回 { knobs, subtotals, piles, opened, missing }。 */
export function buildInventory(root = DEFAULT_ROOT) {
  const compose = readIfExists(root, COMPOSE_FILE);
  const proxy = readIfExists(root, PROXY_FILE);
  const provisioner = readIfExists(root, PROVISIONER_FILE);
  const missing = [];
  for (const f of [compose, proxy, provisioner]) if (f.missing) missing.push(relOf(root, f.abs));

  const services = parseComposeEnv(compose.text);
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
  // 子进程基线环境（镜像自带）与硬登记的例外：都不算旋钮。
  const passThrough = new Set([...PASS_THROUGH_KEYS, ...scanChildEnvAllowlists(root, RUNNER_DIR)]);

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
    const composeOnly = Boolean(portalEntry) && pReads.length > 0 && rReads.length === 0 && inj.length === 0;
    const bootWhy = bootReasons({ name, portalReadFiles: pFiles, composeEntry: portalEntry, composeService: otherService?.service, injected: inj });
    const breaks = findBreaks({
      name,
      composeEntry: portalEntry,
      portalComposeOnly: composeOnly,
      injected: inj,
      allowlisted: allow,
      runnerReads: rReads,
      passThrough,
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
      runnerReads: rReads.map((r) => ({ ref: r.ref, kinds: r.kinds })),
      portalReads: pReads.map((r) => ({ ref: r.ref, kinds: r.kinds })),
      bootWhy,
      breaks,
      pile: classifyPile({ bootWhy, injected: inj, allowlisted: allow, runnerReads: rReads, portalReadFiles: pFiles, composeEntry: portalEntry, passThrough: passThrough.has(name) }),
      passThrough: passThrough.has(name),
    });
  }
  knobs.sort((a, b) => a.name.localeCompare(b.name));

  const injectedNoAllow = knobs.filter((k) => k.injected.length > 0 && k.allowlisted.length === 0 && !k.passThrough);
  const readNotInjected = knobs.filter((k) => k.runnerReads.length > 0 && k.injected.length === 0 && !k.passThrough);
  const deadFiber = knobs.filter((k) => k.allowlisted.length > 0 && k.runnerReads.length === 0 && !k.passThrough);
  return {
    root,
    knobs,
    opened: [
      COMPOSE_FILE, PROXY_FILE, PROVISIONER_FILE,
      `${PORTAL_SRC_DIR}/（全部 *.js，剥注释后扫四种读取形态）`,
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
      allowlistedNobodyRead: deadFiber.map((k) => k.name),
    },
    piles: {
      db: knobs.filter((k) => k.pile === 'db').map((k) => k.name),
      no: knobs.filter((k) => k.pile === 'no').map((k) => k.name),
      human: knobs.filter((k) => k.pile === 'human').map((k) => k.name),
      nonKnob: knobs.filter((k) => k.pile === 'non').map((k) => k.name),
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
  out.push(`在白名单但没人读（死光纤）=${s.allowlistedNobodyRead.length} ${fmt(s.allowlistedNobodyRead)}`);
  out.push('');
  out.push('=== 能不能搬进 DB（判据见文件头）===');
  out.push(`能搬（三腿齐 + 非启动前必知 + portal 不读）=${inv.piles.db.length} ${fmt(inv.piles.db)}`);
  out.push(`不能搬（容器起来之前就得知道）=${inv.piles.no.length} ${fmt(inv.piles.no)}`);
  out.push(`需人判=${inv.piles.human.length} ${fmt(inv.piles.human)}`);
  out.push(`（不计入三堆）非旋钮、子进程/容器基线环境=${inv.piles.nonKnob.length} ${fmt(inv.piles.nonKnob)}`);
  out.push('');
  out.push('=== 逐键判据（只列判「不能搬」与「断链」的）===');
  for (const k of inv.knobs) {
    if (k.bootWhy.length === 0 && k.breaks.length === 0) continue;
    out.push(`- ${k.name}：boot=${k.bootWhy.join('+') || '—'} 断=${k.breaks.join(' + ') || '—'}`);
  }
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
