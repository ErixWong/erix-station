// delegation P1 的**下发面三腿**交叉核对（2026-11-08）+ issue #557 的两条追加判据。
//
// 病根形状（§8.70 的同型事故，本仓已经付过一次账）：**注入方与放行方是两个模块，谁都没检查对方**
// —— `#416` 给 provisioner 加了 `ERIX_AGENT_VERSION` 注入却没同步 `fde-proxy` 的 `ENV_KEY_ALLOW`，
// 现网 `provision-fde` 直接 `create_policy_denied: Env key not allowed`，而两个 FDE 容器当时已被
// provision 流程删掉 ⇒ 短暂全停（判据先例：`portal/test/provisioner.test.js` 末尾那条交叉核对）。
//
// 本单是**三条腿**，少任何一条都等于没做：
//   ① `deploy/docker-compose.yml` 的 `station-portal.environment` —— portal 容器里没有这个 env，
//      `provisioner` 就读到 `undefined` ⇒ 下发 `0` ⇒ **FDE 容器永远不开 delegate**；
//   ② `portal/src/provisioner.js` 的 `buildContainerConfig` Env 注入 —— 不注入就没人往下传；
//   ③ `deploy/fde-proxy/server.js` 的 `ENV_KEY_ALLOW` —— 不放行就 `create_policy_denied`。
// 再加一条「compose 的默认值 == 代码默认值」（`deploy-env-defaults.test.js` 的同款口径：各钉各的
// 正是「两头各自都对」的失效形状，所以要比对而不是各写一遍字面量）。
//
// ── issue #557 追加的两件事（**第二条比第一条更要紧**）─────────────────────────
// **A. 又一个旋钮没接上三腿**：`ERIX_FINAL_TEXT_TOOLCALL_MARKERS`（#243 的终局文本化工具调用特征集）
// 配置面收得下、现场投不进 —— 三腿全缺。上面那段形状**复发**了。
// **B. 为什么五格全绿却没人发现**（#557 的根因）：本文件旧版的 runner 侧枚举取自**单个文件**
// `runner/lib/config.js`（旧 `RUNNER_CONFIG` + `runnerDefaults()` 那一路），而 #243 那个 env 读在
// `runner/lib/final-text-toolcall.js` ⇒ **闸门看不见它**，于是「五格全绿」与「现场投不进」同时为真。
// 现在 runner 侧的枚举改成**扫描 `runner/` 实际读过的 env 名全集**（含 `const FOO_ENV = 'ERIX_…'`
// 与「env 常量当参数默认值 + `env?.[key]`」这两类间接形状），不再手抄清单。旧口径留成一条**负例**
// （见「根因墓碑」那格）：谁把枚举源改回单文件，那格就红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
// 剥注释的状态机从 `test/lib/js-source.mjs` import（issue #557 返工：它原先内联在
// `test/repo-hygiene.test.js:135`，那边同样靠它剥注释）。此处**不**另写一份逐行 `startsWith('//')`
// 的弱货：两份实现会分叉成两本账（同一个形状一边算注释、另一边算代码）。
import { stripComments, structuralMask } from '../../test/lib/js-source.mjs';

const COMPOSE = new URL('../../deploy/docker-compose.yml', import.meta.url);
const PROVISIONER = new URL('../src/provisioner.js', import.meta.url);
const PROXY = new URL('../../deploy/fde-proxy/server.js', import.meta.url);
const RUNNER_CONFIG = new URL('../../runner/lib/config.js', import.meta.url);
/** #557 活二：runner 侧的枚举源 = **整棵 `runner/`**（旧口径是上面那一个文件，见根因墓碑那格）。 */
const RUNNER_ROOT = fileURLToPath(new URL('../../runner', import.meta.url));
/** 活二判据③ 的夹具：登记「缺腿的键」的例外清单（理由字段是判据的一部分，不是注释）。 */
const ENV_LEGS_EXCEPTIONS = new URL('../../deploy/env-legs-exceptions.json', import.meta.url);

const DELEGATE_KEYS = [
  'ERIX_DELEGATE_ENABLED',
  'ERIX_DELEGATE_MAX',
  'ERIX_DELEGATE_CHILD_ROUNDS',
  'ERIX_DELEGATE_CHILD_TIMEOUT_MS',
];

/** 取 compose 里 `${VAR:-默认}` 的默认段（照 `deploy-env-defaults.test.js` 的写法）。 */
function interpolationDefault(value) {
  const m = /^\$\{([A-Z0-9_]+):-([^}]*)\}$/.exec(String(value));
  return m ? m[2] : String(value);
}

function composePortalEnv() {
  return parse(fs.readFileSync(COMPOSE, 'utf8')).services['station-portal'].environment;
}

/** provisioner `buildContainerConfig` 的 Env 段里**可能**注入的键（正则口径照 provisioner.test.js）。 */
function provisionerInjectedKeys() {
  const src = fs.readFileSync(PROVISIONER, 'utf8');
  const start = src.indexOf('export function buildContainerConfig');
  const end = src.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start, 'buildContainerConfig 源码边界没定位到（判据不能空转）');
  return new Set([...src.slice(start, end).matchAll(/`([A-Z][A-Z0-9_]{2,})=/g)].map((m) => m[1]));
}

function proxyAllowedKeys() {
  const proxy = fs.readFileSync(PROXY, 'utf8');
  const m = /const ENV_KEY_ALLOW = new Set\(\[(.*?)\]\)/s.exec(proxy);
  assert.ok(m, 'fde-proxy 的 ENV_KEY_ALLOW 定义没找到（改名了？那这条判据得同步改）');
  return new Set([...m[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((x) => x[1]));
}

/** runner 侧的**代码默认值**（从 `runner/lib/config.js` 真函数取，不抄字面量）。 */
function runnerDefaults() {
  return {
    ERIX_DELEGATE_ENABLED: isDelegateEnabled(undefined) ? '1' : '0', // 从真函数取（2026-11-09 翻向：未设 ⇒ 开）
    ERIX_DELEGATE_MAX: String(parseDelegateMaxRef(undefined).value),
    ERIX_DELEGATE_CHILD_ROUNDS: String(parseDelegateChildRoundsRef(undefined).value),
    ERIX_DELEGATE_CHILD_TIMEOUT_MS: String(parseDelegateChildTimeoutMsRef(undefined).value),
  };
}

// 动态 import（runner 侧的解析器是本站 env 默认值的唯一真相）
const { isDelegateEnabled, parseDelegateMax, parseDelegateChildRounds, parseDelegateChildTimeoutMs }
  = await import(RUNNER_CONFIG.href);
const parseDelegateMaxRef = parseDelegateMax;
const parseDelegateChildRoundsRef = parseDelegateChildRounds;
const parseDelegateChildTimeoutMsRef = parseDelegateChildTimeoutMs;
// issue #557：那个旋钮的**名字与缺省值都从真模块现读**（本文件不抄 `deploy` 里那份字面量）
const { TOOLCALL_MARKERS_ENV, DEFAULT_TOOLCALL_MARKERS, parseToolCallMarkers }
  = await import(new URL('../../runner/lib/final-text-toolcall.js', import.meta.url).href);
const MARKER_KEY = TOOLCALL_MARKERS_ENV;

// ===========================================================================
// 活一：`ERIX_FINAL_TEXT_TOOLCALL_MARKERS` 的三腿判据（少一条就红，且红要点名）
// ===========================================================================

/** 三条腿的**名字**（点名用），顺序就是宿主 → 容器的方向。 */
const LEG_NAMES = [
  ['compose', 'deploy/docker-compose.yml 的 station-portal.environment（宿主没这个 env ⇒ portal 读不到）'],
  ['provisioner', 'portal/src/provisioner.js 的 buildContainerConfig Env 注入（不注入就没人往下传）'],
  ['proxy', 'deploy/fde-proxy/server.js 的 ENV_KEY_ALLOW（不放行 ⇒ create_policy_denied，是**投不进**不是没效果）'],
];

function legSets() {
  return new Map([
    ['compose', new Set(Object.keys(composePortalEnv()))],
    ['provisioner', provisionerInjectedKeys()],
    ['proxy', proxyAllowedKeys()],
  ]);
}

/** 这个 key 缺哪几条腿（返回腿名数组，**消息里要点名**）。 */
function missingLegsOf(key, legs) {
  return LEG_NAMES.filter(([name]) => !legs.get(name).has(key)).map(([name]) => name);
}

function describeMissing(key, missing) {
  return [`${key} 缺腿：[${missing.join(', ')}]`,
    ...missing.map((n) => `  - ${n}: ${LEG_NAMES.find(([name]) => name === n)[1]}`),
    '⇒ 配置面收得下、现场投不进（宿主设了也没用 = 配了不生效）'].join('\n');
}

/**
 * 三腿一致性**内核**（判据都走这里，所以「少一条腿」是真会红的，不是靠 `assert.ok(set.has)` 各写一遍）。
 * 返回违规清单：`{ key, missing }`；登记在例外清单里的键跳过（例外的合法性另有一格专门判）。
 */
function checkEnvLegs(keys, legs, exceptions = []) {
  const excepted = new Set(exceptions.map((e) => e.key));
  const violations = [];
  for (const key of [...keys].sort()) {
    const missing = missingLegsOf(key, legs);
    if (missing.length === 0 || excepted.has(key)) continue;
    violations.push({ key, missing });
  }
  return violations;
}

// ===========================================================================
// 活二：runner 侧 env 枚举 = **扫描出来的**，不是手抄的清单
// ===========================================================================

/** 只判本站命名的旋钮（`HOME` / `PATH` 这类继承来的不属于「宿主 → 容器下发面」，不参与三腿要求）。 */
const NAMESPACED_ENV_NAME = /^(?:ERIX|FDE|STATION)_[A-Z][A-Z0-9_]*$/;
/** 扫描要跳过的目录：`test/` 里的 env 读取是测试自造的，不是产品配置面。 */
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'probes', 'skills', 'fixtures', 'dist']);
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** root 可以是目录（递归）或**单个文件**（活二判据② 的旧口径负例要拿单文件跑同一个扫描器）。 */
function scanTargets(root) {
  const st = fs.statSync(root);
  if (st.isFile()) return [root];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      out.push(...scanTargets(p));
    } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out.sort();
}

const IDENT_RE = String.raw`[A-Za-z_$][\w$]*`;
/** env 名的字面量形状（数据表里挑名字时用；`{ timeout: 30 }` 这种数字项、`'erix-worker'` 这种小写值都不算）。 */
const ENV_LITERAL = /^[A-Z][A-Z0-9_]{2,}$/;
const ENV_LITERAL_QUOTED = /['"]([A-Z][A-Z0-9_]{2,})['"]/g;

function escRe(s) { return s.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&'); }

/** 从 `{` / `[` 起做**配对扫描**（在 structuralMask 上跑 ⇒ 字符串正文与注释已抹平，括号不会被内容骗到）。 */
function matchBrackets(masked, from) {
  const open = masked[from];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = from; i < masked.length; i += 1) {
    if (masked[i] === open) depth += 1;
    else if (masked[i] === close) { depth -= 1; if (depth === 0) return i + 1; }
  }
  return null;
}

/**
 * 建「这个名字能解析出哪些 env 名」的表。**必须按形状分优先级多趟建**，因为绑定会互相引用
 * （`{ key = TOOLCALL_MARKERS_ENV }` 里的 `key` 依赖常量表，`const envName = LLM_TIMEOUT_ENV[field]`
 * 里的 `envName` 依赖数据表）：先收字面量与数据表，再收「别名 = 已知名」与「别名 = 已知名[...]」，
 * 最后迭代到不动点。解析不出的名字**不在表里**（调用方据此判 unsupported，不许静默放过）。
 * @returns {{ envObjs: Set<string>, names: Map<string, Set<string>> }}
 */
function analyzeEnvReads(code) {
  const masked = structuralMask(code);
  const envObjs = new Set();
  const names = new Map();
  const addName = (id, lits) => {
    if (!/^[A-Za-z_$]/.test(id)) return;
    if (!names.has(id)) names.set(id, new Set());
    for (const l of lits) names.get(id).add(l);
  };
  // env 对象别名：`env = process.env`（参数默认值或 `const env = process.env`，两种写法同一条正则）
  for (const m of code.matchAll(new RegExp(`(${IDENT_RE})\\s*=\\s*process\\.env(?!\\.)(?!\\s*=[^=])`, 'g'))) envObjs.add(m[1]);

  // ① 字符串常量：`const FOO_ENV = 'ERIX_X'`
  for (const m of code.matchAll(new RegExp(`\\b(?:const|let|var)?\\s*(${IDENT_RE})\\s*=\\s*['"]([^'"]+)['"]`, 'g'))) {
    if (ENV_LITERAL.test(m[2])) addName(m[1], [m[2]]);
  }
  // ② 解构默认值：`function f(env = process.env, { key = TOOLCALL_MARKERS_ENV } = {})` ⇒ key 是候选名变量
  for (const m of code.matchAll(new RegExp(`[({,]\\s*(${IDENT_RE})\\s*=\\s*(${IDENT_RE})\\s*[,})]`, 'g'))) {
    if (!names.has(m[2])) continue;
    addName(m[1], names.get(m[2]));
    addName(m[2], names.get(m[2]));
  }
  // ③ 数据表：`const T = Object.freeze({ a: 'ERIX_A', ... })` / `= { ... }` / `= ['ERIX_A', ...]`
  //    （#557 返工新增：`runner/lib/llm-timeouts.js` 的 `LLM_TIMEOUT_ENV` 就是这一形，
  //     读它的那一行里**根本没有 env 名的字面量**，只认字面量的旧扫描器因此静默漏掉四个键）
  for (const m of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(${IDENT_RE})\\s*=\\s*(?:Object\\.freeze\\(\\s*)?([{[])`, 'g'))) {
    const start = masked.indexOf(m[2], m.index);
    const end = start < 0 ? null : matchBrackets(masked, start);
    if (end == null) continue;
    const lits = [...code.slice(start, end).matchAll(ENV_LITERAL_QUOTED)].map((x) => x[1]);
    if (lits.length) addName(m[1], lits);
  }
  // ④ 「名字变量」绑定：`const envName = TABLE[field]` / `const alias = KNOWN` ⇒ 迭代到不动点
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    const before = [...names].map(([k, v]) => [k, v.size]);
    for (const m of code.matchAll(new RegExp(`(?:const|let|var)\\s+(${IDENT_RE})\\s*=\\s*(${IDENT_RE})\\s*(?:\\[|;|\\n)`, 'g'))) {
      const lits = names.get(m[2]);
      if (!lits || lits.size === 0) continue;
      const sink = names.get(m[1]) ?? new Set();
      for (const l of lits) sink.add(l);
      names.set(m[1], sink);
    }
    const after = [...names].map(([k, v]) => [k, v.size]);
    changed = JSON.stringify(before) !== JSON.stringify(after);
    if (!changed) break;
  }
  return { envObjs, names };
}

/** 下标表达式 → 名字集合；`null` = 解析不出字面量名（调用方必须进 unsupported 清单，不许静默放过）。 */
function resolveExpr(expr, ctx) {
  const lit = /^\s*['"]([^'"]+)['"]\s*$/.exec(expr);
  if (lit) return new Set([lit[1]]);
  const id = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(expr);
  if (id && ctx.names.has(id[1])) return new Set(ctx.names.get(id[1]));
  const tbl = /^\s*([A-Za-z_$][\w$]*)\s*\[[\s\S]*\]\s*$/.exec(expr); // `T[field]` 直接写在读形里
  if (tbl && ctx.names.has(tbl[1]) && ctx.names.get(tbl[1]).size > 0) return new Set(ctx.names.get(tbl[1]));
  return null;
}

/**
 * 扫描**一批源码**对 env 的读取。返回 `{ keys, unsupported }`：
 *   `keys`        `Map(env 名 → Map(相对出处文件 → [行号]))`
 *   `unsupported` `[{ at, shape, expr }]` —— **读形认得、名字解析不出**的动态下标（运行期拼名那类），
 *                 必须逐条登记进例外清单的 `unsupported` 段并写明理由，否则判据红（fail closed）。
 * 认的形状（漏一形就漏一个键，#557 的根因就是漏形）：
 *   形① `process.env.ERIX_X` / 形①b 别名点号 `env.ERIX_X`（`{ env = process.env }` 参数默认值那一路，
 *        `runner/lib/build-info.js:84` 读 `ERIX_AGENT_VERSION` 就是它 —— 旧扫描器只认 `process.env.` 前缀，
 *        于是这个键的**唯一**出处只剩 `runner/agentd.js:52` 的**注释**，注释里的旧代码给它背了三天书）
 *   形② `process.env['ERIX_X']` / 别名字面量下标
 *   形③ `process.env[SOME_ENV]`（`const SOME_ENV = 'ERIX_X'`）
 *   形④ `f(env = process.env, { key = SOME_ENV }) { env?.[key] }`
 *   形⑤ 数据表驱动：`const n = TABLE[f]; env?.[n]` —— 名字从表里来，**不许把表里的名字抄进判据**
 * 前置：整篇先过 `stripComments()` ⇒ 注释里的 `process.env.X` **不算读取**（判据③ 反过来钉：
 * 把真读取注释掉，该键必须从枚举里消失）。写形态（`env.X = v`）不算读。
 */
function scanEnvReadsFromFiles(files, root) {
  const keys = new Map();
  const unsupported = [];
  const add = (name, rel, line, shape) => {
    if (!NAMESPACED_ENV_NAME.test(name)) return;
    if (!keys.has(name)) keys.set(name, new Map());
    const perFile = keys.get(name);
    if (!perFile.has(rel)) perFile.set(rel, []);
    perFile.get(rel).push({ line, shape });
  };
  for (const { file, text } of files) {
    const rel = path.relative(root, file);
    const code = stripComments(text);            // 注释 → 空格（行列位不变）⇒ 注释里的读形**不算读取**
    const masked = structuralMask(code);         // 再把字符串正文抹平 ⇒ 用来判「这个位置是不是串里的文字」
    const ctx = analyzeEnvReads(code);
    const objs = ['process\\.env', ...[...ctx.envObjs].map(escRe)];
    // 读形：`对象 . 名字` 或 `对象 [ 表达式 ]`（`?.` 两种位置都认）。前视 `(?<![\w$.])` 挡住 `childEnv.X`
    // 这类「别的对象也叫 env 结尾」的假别名。
    const readRe = new RegExp(
      `(?<![\\w$.])(?:${objs.join('|')})(?:\\?\\.)?(?:\\.(${IDENT_RE})|\\[\\s*([^\\]\\n]*?)\\s*\\])`, 'g');
    // 写形态整段抹成空格（`process.env.X = v` 是给子进程传值，不是「这个 env 名有配置面」）；
    // 只抹「对象 + 成员 + 等号」这一段，赋值**右侧**照旧参与匹配。
    const writeRe = new RegExp(
      `(?<![\\w$.])(?:${objs.join('|')})(?:\\?\\.)?(?:\\.${IDENT_RE}|\\[[^\\]]*\\])\\s*=(?!=)`, 'g');
    const writable = code.replace(writeRe, (m) => ' '.repeat(m.length));
    let line = 1;
    let scanFrom = 0;
    const lineUpTo = (idx) => {                   // 行列位被两个状态机一路保留 ⇒ 数换行就是行号
      for (let k = scanFrom; k < idx; k += 1) if (code[k] === '\n') line += 1;
      scanFrom = idx;
      return line;
    };
    for (const m of writable.matchAll(readRe)) {
      lineUpTo(m.index);
      // 位置落在字符串正文里（掩码那格是空格、原文不是）⇒ 那是**串里提到的形状**，不是读取。
      // 模板插值 `${…}` 里的代码不算串正文（`structuralMask` 特意留着），所以
      // `` msg: `${name}=${process.env[name]}` `` 这种活在模板里的读取不会被误杀。
      if (masked[m.index] === ' ' && code[m.index] !== ' ') continue;
      if (m[1] !== undefined) { add(m[1], rel, line, 'dot'); continue; }
      const expr = m[2] ?? '';
      const lit = resolveExpr(expr, ctx);
      if (lit) { for (const n of lit) add(n, rel, line, `index:${expr.trim()}`); continue; }
      // 读形认得、名字解析不出（运行期拼名那类）⇒ **fail closed**：进 unsupported 清单，
      // 必须逐条登记进 `deploy/env-legs-exceptions.json` 的 `unsupported` 段并写理由，否则判据红。
      unsupported.push({ at: `${rel}:${line}`, shape: m[0].trim(), expr: expr.trim() });
    }
  }
  return { keys, unsupported };
}

/**
 * 目录/单文件版入口。两个可选入口都是**判据自己要用的**：
 *   · `mutate(rel, text)` 改**内存里**的源码（不改盘）⇒ 「把这行注释掉 / 把表里的名字改掉」这类变异
 *     由判据自己带着跑，不依赖谁手工改过一次树；
 *   · `rootLabel` 给 `unsupported` 的坐标加前缀 ⇒ 真树扫出来的坐标写成**仓库根相对**
 *     （`runner/worker.js:774`），与例外清单里 `where` 同一个口径，判据不用维护两套路径。
 */
function scanEnvReads(root, { mutate, rootLabel = '' } = {}) {
  const files = scanTargets(root).map((f) => ({ file: f, text: fs.readFileSync(f, 'utf8') }));
  if (mutate) for (const f of files) f.text = mutate(path.relative(root, f.file), f.text);
  const out = scanEnvReadsFromFiles(files, root);
  if (rootLabel) for (const u of out.unsupported) u.at = `${rootLabel}/${u.at}`;
  return out;
}

/** 兼容旧口径：`Map(env 名 → Set(相对出处文件))`（活二②③ 与墓碑都在用它）。 */
function scanEnvKeys(root, opts) {
  const out = new Map();
  for (const [name, perFile] of scanEnvReads(root, opts).keys.entries()) out.set(name, new Set(perFile.keys()));
  return out;
}

/** 扫描器自证：扫到 0 个就是扫描器坏了（不是「runner 不再读 env」）—— 这一条必须红。 */
function assertScannerFoundKeys(n, where) {
  assert.ok(n > 0, `env 枚举扫到 **0 个** key（${where}）⇒ 扫描器坏了：正则没命中任何读取形，`
    + '把「扫不到」当成「没有旋钮」就是让闸门静默失效（#557 的根因是覆盖不全，不能再叠一层）');
}

const RUNNER_SCAN = scanEnvReads(RUNNER_ROOT, { rootLabel: 'runner' });
const RUNNER_ENV_KEYS = scanEnvKeys(RUNNER_ROOT);
assertScannerFoundKeys(RUNNER_ENV_KEYS.size, `扫描根 ${path.relative(process.cwd(), RUNNER_ROOT)}/`);

/** 例外清单：读 + 判**理由字段**（没有理由的例外不算例外）。返回 `{ entries, problems }`。 */
function loadEnvLegExceptions() {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(ENV_LEGS_EXCEPTIONS, 'utf8'));
  } catch (e) {
    return { entries: [], unsupported: [], problems: [`deploy/env-legs-exceptions.json 读不到或不是合法 JSON：${e.message}`] };
  }
  const entries = Array.isArray(doc?.exceptions) ? doc.exceptions : null;
  if (!entries) return { entries: [], unsupported: [], problems: ['deploy/env-legs-exceptions.json 缺 exceptions 数组'] };
  const unsupported = Array.isArray(doc?.unsupported) ? doc.unsupported : [];
  return {
    entries,
    unsupported,
    problems: [...validateEntries(entries), ...validateUnsupported(unsupported)],
  };
}

/** 与内存版夹具共用同一套规则（变异入口必须过同一把尺，否则「去掉理由就红」是假牙）。 */
function validateEntries(entries) {
  const problems = [];
  const seen = new Set();
  entries.forEach((e, i) => {
    const at = `exceptions[${i}]`;
    if (e === null || typeof e !== 'object' || Array.isArray(e)) { problems.push(`${at} 不是对象`); return; }
    if (typeof e.key !== 'string' || e.key.trim() === '') { problems.push(`${at} 缺 key（例外必须点名是哪个键）`); return; }
    if (typeof e.reason !== 'string' || e.reason.trim() === '') {
      problems.push(`${at}（key=${e.key}）**缺理由字段 reason**：没有理由的例外不算例外`);
    }
    if (seen.has(e.key)) problems.push(`${at}（key=${e.key}）重复登记：例外清单里一个键只能有一条`);
    seen.add(e.key);
  });
  return problems;
}

/** 例外清单的**防腐**：不许停泊已经三腿齐的键、不许登记枚举里根本不存在的键（过期 = 第二本账）。 */
function exceptionProblems(entries, keys, legs) {
  const problems = [];
  const enumerated = new Set(keys);
  for (const e of entries) {
    if (!enumerated.has(e.key)) problems.push(`例外清单里的 ${e.key} 不在 runner 的 env 枚举里 ⇒ 过期登记，删掉它`);
    else if (missingLegsOf(e.key, legs).length === 0) {
      problems.push(`例外清单里的 ${e.key} 其实**三腿已经齐了** ⇒ 它是停泊在例外里的死条目，删掉它`);
    }
  }
  return problems;
}

const LEGS = legSets();

test('腿①：compose 的 station-portal 必须显式下发这四个键（portal 读不到 env ⇒ 永远下发 0）', () => {
  const env = composePortalEnv();
  for (const key of DELEGATE_KEYS) {
    assert.ok(Object.hasOwn(env, key), `compose 里 station-portal 缺 ${key} ⇒ provisioner 读到 undefined`);
  }
});

test('腿②：provisioner 注入的键必须全在 fde-proxy 白名单里（§8.70 的同型事故：漏一个就是 create_policy_denied）', () => {
  const injected = provisionerInjectedKeys();
  const allowed = proxyAllowedKeys();
  for (const key of DELEGATE_KEYS) {
    assert.ok(injected.has(key), `provisioner 没注入 ${key} ⇒ 值到不了 FDE 容器`);
    assert.ok(allowed.has(key), `fde-proxy 没放行 ${key} ⇒ 现网 create_policy_denied，FDE 容器建不出来`);
  }
  const missing = [...injected].filter((k) => !allowed.has(k)).sort();
  assert.deepEqual(missing, [], `provisioner 会注入但 proxy 不放行的键：${missing.join(', ')}`);
});

test('腿③：compose 的默认值 == runner 代码默认值（两头不许各说各话）', () => {
  const env = composePortalEnv();
  const codeDefaults = runnerDefaults();
  for (const key of DELEGATE_KEYS) {
    assert.equal(interpolationDefault(env[key]), codeDefaults[key],
      `${key}：compose 默认 ${interpolationDefault(env[key])} ≠ 代码默认 ${codeDefaults[key]} ⇒ 部署面与代码分叉`);
  }
});

test('腿③b：子 run 的超时上限必须小于 agentd 的 300s watchdog（两侧写死同一个约束）', async () => {
  const { parseDelegateChildTimeoutMs: parse } = await import(RUNNER_CONFIG.href);
  assert.ok(parse('999999999').value < 300_000,
    `钳住的上限 ${parse('999999999').value} 必须 < 300000：否则子 run 能把父 worker 拖进 SIGKILL + 重放`);
  assert.ok(interpolationDefault(composePortalEnv().ERIX_DELEGATE_CHILD_TIMEOUT_MS) === '240000');
});

test('开关口径：未设 ⇒ 开；显式值只有字符串 1 算开（2026-11-09 决策者翻向）', () => {
  // 未设 / 空串 ⇒ 开（这一支撑是 2026-11-09 翻的）
  assert.equal(isDelegateEnabled(undefined), true);
  assert.equal(isDelegateEnabled(''), true);
  assert.equal(isDelegateEnabled('1'), true);
  // 显式值仍只认 '1'
  assert.equal(isDelegateEnabled('0'), false);
  assert.equal(isDelegateEnabled('true'), false);
  // provisioner 自己也得把显式非 '1' 折成 '0'，且未设时必须下发 '1'，别把垃圾值原样下发
  const src = fs.readFileSync(PROVISIONER, 'utf8');
  assert.match(src, /ERIX_DELEGATE_ENABLED=\$\{delegateEnvValue\(\)\}/,
    'provisioner 必须走 delegateEnvValue()（未设 ⇒ 1 / 显式非 1 ⇒ 0），不要内联三元');
  assert.match(src, /if \(raw === undefined \|\| raw === ''\) return '1';/,
    '未设/空串必须下发 1（默认关）');
  assert.match(src, /return raw === '1' \? '1' : '0';/,
    '显式值仍只认 1');
});

// ===========================================================================
// 活一（issue #557）：三腿齐 + 每条腿都有牙
// ===========================================================================

test(`活一①：${MARKER_KEY} 三腿齐（compose / provisioner Env / ENV_KEY_ALLOW 三处都得在）`, () => {
  const missing = missingLegsOf(MARKER_KEY, LEGS);
  assert.deepEqual(missing, [], describeMissing(MARKER_KEY, missing));
  // 腿① 必须是**宿主可覆盖**的插值形态（写死字面量 = 运维改不动，等于没接）
  const raw = composePortalEnv()[MARKER_KEY];
  assert.match(String(raw), new RegExp(`^\\$\\{${MARKER_KEY}:-.*\\}$`),
    `${MARKER_KEY} 在 compose 里必须是 \`\${${MARKER_KEY}:-…}\` 形态（实际 ${JSON.stringify(raw)}）`);
  // 腿③ 的语义说明（判据②要求点名）：白名单是**拒绝面**，不是「记录面」
  const proxy = fs.readFileSync(PROXY, 'utf8');
  assert.match(proxy, /if \(!ENV_KEY_ALLOW\.has\(key\)\)/,
    'fde-proxy 校验 Env 时是「不在白名单就 push 拒绝理由」（`if (!ENV_KEY_ALLOW.has(key))`）⇒ '
    + `白名单不加 ${MARKER_KEY}，现场就是 **投不进**（create_policy_denied），不是「投进去没效果」`);
});

test(`活一①b：compose 的默认段必须为空 ⇒ 默认值唯一真值留在 runner（不许把特征清单抄进部署面）`, () => {
  const composeDefault = interpolationDefault(composePortalEnv()[MARKER_KEY]);
  assert.equal(composeDefault, '',
    `${MARKER_KEY} 的 compose 默认段是 ${JSON.stringify(composeDefault)}：必须是**空**。`
    + '把缺省特征清单抄一份进 compose = 第二本账（runner 改了默认，compose 与容器还压着旧值）；'
    + '留空 ⇒ provisioner 连键都不带 ⇒ 容器吃 runner 的代码默认');
  // 行为级：把 compose 插值出来的值喂进**真解析器**，必须等于代码默认（「两头各说各话」的失效形状）
  const effective = parseToolCallMarkers(composeDefault);
  assert.deepEqual(effective.markers, [...DEFAULT_TOOLCALL_MARKERS],
    'compose 未设值时 Effective 特征集 ≠ runner 代码默认 ⇒ 部署面与代码分叉');
  assert.equal(effective.disabled, false);
});

test(`活一②：把 ${MARKER_KEY} 从 fde-proxy 白名单里删掉 ⇒ 三腿判据必须红并点名它（这条腿有牙）`, () => {
  // 现场口径先自证：白名单里确实有它（否则下面那条「有牙」断言是空操作）
  assert.ok(LEGS.get('proxy').has(MARKER_KEY), `${MARKER_KEY} 不在 ENV_KEY_ALLOW 里 —— 先活①②红，别空转`);
  const mutated = legSets();
  mutated.get('proxy').delete(MARKER_KEY); // ← 变异入口：删掉白名单里那一项
  const violations = checkEnvLegs([MARKER_KEY], mutated);
  assert.equal(violations.length, 1, '白名单少一条腿却没人报 ⇒ 这条腿是假的');
  assert.deepEqual(violations[0].missing, ['proxy'], '缺腿必须点名到 proxy 这条腿');
  assert.match(describeMissing(violations[0].key, violations[0].missing), /ENV_KEY_ALLOW/);
  assert.match(describeMissing(violations[0].key, violations[0].missing), new RegExp(MARKER_KEY),
    '失败消息必须点名是哪个键（红得没有信息 = 没人能修）');
});

test(`活一③：把 ${MARKER_KEY} 从 provisioner 的 Env 注入里删掉 ⇒ 三腿判据必须红并点名它`, () => {
  assert.ok(LEGS.get('provisioner').has(MARKER_KEY), `${MARKER_KEY} 不在 buildContainerConfig 的 Env 里 —— 先活①③红，别空转`);
  const mutated = legSets();
  mutated.get('provisioner').delete(MARKER_KEY); // ← 变异入口：删掉注入那一行
  const violations = checkEnvLegs([MARKER_KEY], mutated);
  assert.equal(violations.length, 1, 'provisioner 少一条腿却没人报 ⇒ 这条腿是假的');
  assert.deepEqual(violations[0].missing, ['provisioner']);
  assert.match(describeMissing(violations[0].key, violations[0].missing), /buildContainerConfig/);
});

test(`活一④：宿主未设 ⇒ 容器 env 里不带 ${MARKER_KEY}（不许把默认清单硬写进容器）`, async () => {
  const { buildContainerConfig } = await import(PROVISIONER.href);
  const args = {
    fdeName: 'alice', containerName: 'fde-alice', image: 'traefik/whoami', cmd: ['-port', '4000'],
    networkName: 'fde-alice', ip: '10.200.1.2', gateway: '10.200.1.1', baseDomain: 'localhost',
    llmHost: 'llm.localhost', portalPublicBaseUrl: 'https://station.localhost', userSpaceRoot: '/tmp/userspace',
  };
  const saved = process.env[MARKER_KEY];
  const has = (body) => body.Env.some((e) => e.startsWith(`${MARKER_KEY}=`));
  try {
    delete process.env[MARKER_KEY];
    assert.equal(has(buildContainerConfig(args)), false,
      '未设时 Env 里出现了这个键 —— 别把默认值硬写进容器 env');
    process.env[MARKER_KEY] = 'off';
    assert.ok(has(buildContainerConfig(args)), '宿主设了 off 却没下发 ⇒ 现场关不掉检测');
    assert.ok(buildContainerConfig(args).Env.includes(`${MARKER_KEY}=off`), '必须原样透传，不在 portal 侧改语义');
    process.env[MARKER_KEY] = '';
    assert.equal(has(buildContainerConfig(args)), false, '空串按未设处理（否则容器里是一根空光纤）');
  } finally {
    if (saved === undefined) delete process.env[MARKER_KEY];
    else process.env[MARKER_KEY] = saved;
  }
});

// ===========================================================================
// 活二（issue #557，**更要紧**）：枚举源必须是「runner 实际读过的 env 名全集」
// ===========================================================================

test('活二①：runner 扫出来的每个本站 env 名，三腿齐或在**带理由的**例外清单里', () => {
  const { entries, problems } = loadEnvLegExceptions();
  assert.deepEqual(problems, [], '例外清单本身不合法（理由字段是判据的一部分）');
  const rot = exceptionProblems(entries, RUNNER_ENV_KEYS.keys(), LEGS);
  assert.deepEqual(rot, [], '例外清单在腐烂（过期条目 / 停泊已齐腿的键）');
  assert.ok(!entries.some((e) => e.key === MARKER_KEY),
    `${MARKER_KEY} 被登记进了例外清单 —— 它是本单要接上三腿的那一个，**不许为了变绿把它塞进例外**`);
  const violations = checkEnvLegs(RUNNER_ENV_KEYS.keys(), LEGS, entries);
  assert.deepEqual(violations.map((v) => `${v.key} 缺 [${v.missing.join(',')}]`), [],
    `${violations.length} 个 runner 实际读的 env 名投不进现场（三腿缺哪条见括号）：`
    + '\n' + violations.map((v) => `  - ${describeMissing(v.key, v.missing)}`).join('\n'));
});

test(`活二②：扫描器自证 —— 枚举含 ${MARKER_KEY}，且它来自 final-text-toolcall.js（不是手抄进去的）`, () => {
  assert.ok(RUNNER_ENV_KEYS.has(MARKER_KEY),
    `扫描器没扫到 ${MARKER_KEY} ⇒ 它不认「env 常量当参数默认值 + env?.[key]」这一形，`
    + '而这正是 #557 那个 key 的真实形状（漏了它 = 复刻根因）');
  const where = [...RUNNER_ENV_KEYS.get(MARKER_KEY)].sort();
  assert.ok(where.some((f) => f.includes('final-text-toolcall.js')),
    `${MARKER_KEY} 的出处必须包含 lib/final-text-toolcall.js（实际 ${JSON.stringify(where)}）`);
  assert.ok(!where.some((f) => f === 'lib/config.js'),
    `${MARKER_KEY} 的出处里不该出现 lib/config.js（实际 ${JSON.stringify(where)}）——它就是不在那儿读的`);
  // 「不是手抄」的可执行证据：本文件的扫描源是整棵 runner/，扫到的文件数远大于一份清单
  assert.ok(RUNNER_ENV_KEYS.size > DELEGATE_KEYS.length + 5,
    `枚举只有 ${RUNNER_ENV_KEYS.size} 个 key，比手抄清单大不了多少 ⇒ 扫描面疑似被收窄`);
  assert.ok(scanTargets(RUNNER_ROOT).length > 10,
    `扫描只覆盖 ${scanTargets(RUNNER_ROOT).length} 个文件 ⇒ 枚举源又被缩回少数文件了`);
});

test(`活二②墓碑：旧口径（只扫 runner/lib/config.js）不含 ${MARKER_KEY} —— 枚举源改回单文件就红`, () => {
  // 旧口径 = 本文件 #557 之前的 runner 侧枚举源：`runner/lib/config.js` **这一个文件**
  // （旧代码是 `RUNNER_CONFIG` + `runnerDefaults()` 那一路，key 名还是测试里手抄的 DELEGATE_KEYS）。
  const legacyScan = scanEnvKeys(fileURLToPath(RUNNER_CONFIG));
  assert.ok(!legacyScan.has(MARKER_KEY),
    `旧口径竟然扫到了 ${MARKER_KEY} ⇒ config.js 开始读它了，这条墓碑该改写而不是留着骗人`);
  assert.ok(!DELEGATE_KEYS.includes(MARKER_KEY),
    '手抄的 DELEGATE_KEYS 清单里居然有了它 ⇒ 那份清单被当成第二本账补抄过，墓碑要改写');
  // 反向锁：新枚举必须是旧口径的**真超集**。谁把枚举源改回单文件，这一句当场红。
  const full = new Set(RUNNER_ENV_KEYS.keys());
  for (const k of legacyScan.keys()) assert.ok(full.has(k), `新枚举丢了旧口径也有的 ${k}`);
  assert.ok(full.size > legacyScan.size,
    `枚举源退化：新口径 ${full.size} 个 vs 单文件旧口径 ${legacyScan.size} 个 —— `
    + '#557 的根因就是「枚举面 = 一个文件」，改回去必须红');
  assert.ok(full.size - legacyScan.size >= 10,
    `新口径只比旧口径多 ${full.size - legacyScan.size} 个 key ⇒ 扫描面大概率又被收窄了（#557 复发的前兆）`);
});

test('活二③：只存在于 config.js 之外的假 env 名 ⇒ 闸门必须报它缺腿（夹具 + 全量扫两路）', () => {
  // ① 真源里造一个「只在 lib/ 某模块读、三腿全无」的键：临时改 runner 的一个小模块
  const ghost = 'ERIX_GHOST557_MISSING_LEGS';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-legs-fixture-'));
  const fixtureFile = path.join(dir, 'ghost.js');
  try {
    // 直接扫描夹具：直接形 + 间接常量形都要扫得出来（否则下面的断言是空操作）
    fs.writeFileSync(fixtureFile, [
      `const GHOST_ENV = '${ghost}_INDIRECT';`,
      'export function readGhost(env = process.env, { key = GHOST_ENV } = {}) { return env?.[key]; }',
      `export const direct = process.env.${ghost}_DIRECT || 0;`,
    ].join('\n'));
    const fixtureScan = scanEnvKeys(dir);
    assert.deepEqual([...fixtureScan.keys()].sort(), [`${ghost}_DIRECT`, `${ghost}_INDIRECT`],
      `夹具扫出来的是 ${JSON.stringify([...fixtureScan.keys()])} ⇒ 扫描器连夹具都读不出（判据空转）`);
    // 这些名字只存在于 `config.js` **之外**（夹具不在 runner 树里，也不在任何手抄清单里）
    for (const k of fixtureScan.keys()) assert.ok(!DELEGATE_KEYS.includes(k));
    // 闸门必须报它缺腿（三腿全无 ⇒ 不在例外清单里就是违规）
    const violations = checkEnvLegs([...fixtureScan.keys()], LEGS, loadEnvLegExceptions().entries);
    assert.deepEqual(violations.map((v) => v.key), [`${ghost}_DIRECT`, `${ghost}_INDIRECT`],
      '假的缺腿键没被报出来 ⇒ 闸门是绿的但没有牙');
    for (const v of violations) assert.deepEqual(v.missing, ['compose', 'provisioner', 'proxy']);
    assert.match(describeMissing(violations[0].key, violations[0].missing), new RegExp(ghost));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    assert.ok(!fs.existsSync(dir), '夹具目录必须清干净');
  }
});

test('活二③b：扫描器扫到 0 个 key ⇒ 必须红（扫到 0 个 = 扫描器坏了，不是「runner 不再读 env」）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-legs-empty-'));
  try {
    fs.writeFileSync(path.join(dir, 'quiet.js'), 'export const a = 1;\n');
    assert.equal(scanEnvKeys(dir).size, 0, '夹具本该扫不到东西（否则 0 这个自证不成立）');
    assert.throws(() => assertScannerFoundKeys(0, '空夹具'), /扫到 \*\*0 个\*\*/);
    assert.doesNotThrow(() => assertScannerFoundKeys(RUNNER_ENV_KEYS.size, '真 runner'),
      '真 runner 的自证必须过；它红了就说明枚举源被改坏了');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('活二④：例外清单机制 —— 登记（带理由）⇒ 放行；去掉理由字段 ⇒ 必须红', () => {
  const { entries, problems } = loadEnvLegExceptions();
  assert.deepEqual(problems, [], '例外清单当前不合法（先看上一格的措辞）');
  // 挑一条真实例外做夹具：登记它 ⇒ 三腿判据对它放行
  const sample = entries[0];
  assert.ok(sample, '例外清单是空的 ⇒ 这一格没有内容可判，去补一条再谈机制');
  const missing = missingLegsOf(sample.key, LEGS);
  assert.ok(missing.length > 0, `${sample.key} 登记在例外里但其实三腿已齐 ⇒ 换一条，或把它从清单里删掉`);
  assert.deepEqual(checkEnvLegs([sample.key], LEGS, [{ key: sample.key, reason: sample.reason }]), [],
    '登记了带理由的例外却被放行不了 ⇒ 例外机制根本没接上');
  // 去掉理由字段 ⇒ 必须红（这是「例外必须写明理由」的牙）
  const noReason = loadWithoutReason(entries, sample.key);
  assert.ok(noReason.some((p) => p.includes('缺理由字段 reason') && p.includes(sample.key)),
    `去掉 ${sample.key} 的 reason 后没人报 ⇒ 「理由」只是装饰：\n${JSON.stringify(noReason)}`);
  // 理由是空串/空白同样不算理由
  assert.ok(validateWith(entries, sample.key, { reason: '   ' }).some((p) => p.includes('缺理由字段 reason')),
    'reason 是空白串也算没理由');
  // 重复登记 ⇒ 红（同一个键两条 = 停泊位）
  const dup = JSON.parse(JSON.stringify(entries));
  dup.push({ key: sample.key, reason: '重复停泊' });
  assert.ok(dupProblems(dup).some((p) => p.includes('重复登记')), '同一个键登记两次必须红');
  // 并且盘上那份真的没有重复（否则上面那句是自我叉对）
  assert.deepEqual(dupProblems(entries), [], 'deploy/env-legs-exceptions.json 里有重复登记的键');
});

/** 与 `loadEnvLegExceptions` 同一把尺的**内存版**入口（共用 `validateEntries`，否则「去掉理由就红」是假牙）。 */
function loadWithoutReason(entries, key) {
  const cloned = JSON.parse(JSON.stringify(entries)).map((e) => (e.key === key ? { key: e.key } : e));
  return validateEntries(cloned);
}

function validateWith(entries, key, patch) {
  const cloned = JSON.parse(JSON.stringify(entries)).map((e) => (e.key === key ? { ...e, ...patch } : e));
  return validateEntries(cloned);
}

function dupProblems(entries) {
  return validateEntries(entries).filter((p) => p.includes('重复登记'));
}

// ===========================================================================
// 活一返工（PR #581）：形状覆盖有牙 + `where` 是**可校验坐标**
// ===========================================================================

// 相超时四项的名字**从真模块现读**：本文件的源码里一次都不出现 `ERIX_LLM_TIMEOUT_…` 这个字面量
// ⇒ 「名字是从数据表里读的，不是抄进判据的」有可执行证据（见活一⑤ 的自证格）。
const { LLM_TIMEOUT_ENV } = await import(new URL('../../runner/lib/llm-timeouts.js', import.meta.url).href);
const TIMEOUT_KEYS = [...new Set(Object.values(LLM_TIMEOUT_ENV))];
/** 本文件自己的源码（判据拿它自证「没有把 env 名抄进来」）。 */
const SELF_TEXT = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');

const WHERE_REF = /([A-Za-z0-9_./-]+\.(?:js|mjs|cjs))(?::(\d+))?/g;

function splitCoord(at) {
  const m = /^(.*):(\d+)$/.exec(String(at ?? '').trim());
  return m ? { rel: m[1], line: Number(m[2]) } : { rel: String(at ?? '').trim(), line: null };
}

const normRead = (t) => String(t ?? '').replace(/\s+/g, '');

/** 扫描器认得读形、但解析不出 env 名的那些（运行期拼名）—— 每一条都必须登记并带理由。 */
/** `root` 默认仓库根（盘上那份）；夹具把 `root` 换成临时目录，共用同一把尺。 */
function validateUnsupported(items, root = REPO_ROOT) {
  const problems = [];
  const seen = new Set();
  items.forEach((u, i) => {
    const at = `unsupported[${i}]`;
    if (u === null || typeof u !== 'object' || Array.isArray(u)) { problems.push(`${at} 不是对象`); return; }
    const { rel, line } = splitCoord(u.at);
    if (!rel || line == null) problems.push(`${at} 的 \`at\` 必须是 \`路径.js:行\` 坐标（实际 ${JSON.stringify(u.at)}）`);
    else if (!fs.existsSync(path.join(root, rel))) problems.push(`${at} 的 \`at\` 指向不存在的文件 ${rel}`);
    if (typeof u.read !== 'string' || u.read.trim() === '') problems.push(`${at} 缺 \`read\`（要登记的是那个**读形**本身）`);
    if (typeof u.reason !== 'string' || u.reason.trim() === '') {
      problems.push(`${at}（read=${u.read}）**缺理由字段 reason**：没有理由的例外不算例外`);
    }
    const k = `${rel}::${normRead(u.read)}`;
    if (seen.has(k)) problems.push(`${at}（read=${u.read}）重复登记：同一个读形只能有一条`);
    seen.add(k);
  });
  return problems;
}

/**
 * 扫描结果 ↔ `unsupported` 登记的咬合（**fail closed 的那半**）：
 *   · 扫出来没登记 ⇒ 红（「解析不出名字」不能是免费的）；
 *   · 登记了但扫描器现在认不出来 ⇒ 红（过期条目 = 第二本账）；
 *   · 读形对得上但行号漂了 ⇒ 红（坐标必须现跑核对，不许靠记忆）。
 */
function unsupportedProblems(detected, registered) {
  const problems = [];
  const matched = new Set();
  for (const r of registered) {
    const { rel, line } = splitCoord(r.at);
    const hit = detected.find((d) => splitCoord(d.at).rel === rel && normRead(d.shape) === normRead(r.read));
    if (!hit) {
      problems.push(`unsupported 登记的 ${r.at}（read=${r.read}）扫描器现在**认不出来** ⇒ 过期条目：那个读形已改形或已删，删掉这条登记`);
      continue;
    }
    const hitLine = splitCoord(hit.at);
    if (hitLine.line !== line) {
      problems.push(`unsupported 登记的坐标 ${r.at} **行号漂了**：同一个读形现在在 ${hit.at} ⇒ 现跑一次更新坐标（别删条目了事）`);
      continue;
    }
    matched.add(hit.at);
  }
  for (const d of detected) {
    if (matched.has(d.at)) continue;
    problems.push(`扫描器在 ${d.at} 发现一个**解析不出 env 名**的读取 ${d.shape}，但没登记在 deploy/env-legs-exceptions.json 的 \`unsupported\` 段`
      + ' ⇒ 动态读形静默漏过 = #557 的根因形状；登记它并写明理由（或把它改成字面量读形）');
  }
  return problems;
}

/**
 * `where` 是**可校验坐标**（活二）：每个 `路径.js[:行]` 引用都必须存在；带行的那一行（**剥掉注释后**）
 * 必须含该 key 的字面量、或含一个能解析到它的常量名；只给文件不给行 ⇒ 扫描器必须在那个文件里
 * 发现对该 key 的**活读**。`sources` 传 `RUNNER_ENV_KEYS`（key → Set(runner 相对出处)）。
 */
function whereProblems(entries, sources, root = REPO_ROOT) {
  const problems = [];
  const cache = new Map();
  const analyze = (rel) => {
    if (!cache.has(rel)) {
      const code = stripComments(fs.readFileSync(path.join(root, rel), 'utf8'));
      cache.set(rel, { code, ctx: analyzeEnvReads(code) });
    }
    return cache.get(rel);
  };
  entries.forEach((e, i) => {
    const at = `exceptions[${i}]`;
    const where = typeof e?.where === 'string' ? e.where.trim() : '';
    if (where === '') { problems.push(`${at}（key=${e?.key}）**缺 where**：没有可校验坐标的例外等于没取证`); return; }
    const refs = [...where.matchAll(WHERE_REF)].map((m) => ({ rel: m[1], line: m[2] ? Number(m[2]) : null }));
    if (refs.length === 0) {
      problems.push(`${at}（key=${e.key}）的 where 里没有任何 \`路径.js[:行]\` 引用 ⇒ 「${where}」是**说明文字**，`
        + '不是坐标：判据扫不到它，它会随改动自己变成假的');
      return;
    }
    refs.forEach((ref, j) => {
      const tag = `${at}（key=${e.key}）where 的第 ${j + 1} 个引用 ${ref.rel}${ref.line ? `:${ref.line}` : ''}`;
      const abs = path.join(root, ref.rel);
      if (!fs.existsSync(abs)) {
        problems.push(`${tag} **文件不存在** ⇒ 坐标指向不在树上的文件，等于没取证`);
        return;
      }
      if (ref.line == null) {
        const underRunner = path.resolve(abs).startsWith(RUNNER_ROOT + path.sep);
        if (underRunner) {
          const relToCheck = path.relative(RUNNER_ROOT, abs);
          if (sources.get(e.key)?.has(relToCheck)) return;
          problems.push(`${tag} 只给了文件没给行，而扫描器在 \`${relToCheck}\` 里**没发现对 ${e.key} 的活读**`
            + ' —— 坐标是**注释背书**的（#557 那条 `ERIX_AGENT_VERSION` 就栽在这一点上，见它的 reason）');
          return;
        }
        if (analyze(ref.rel).code.includes(e.key)) return;
        problems.push(`${tag} 只给了文件，而整个文件的**代码**（剥掉注释后）里没有 ${e.key} ⇒ 坐标过期`);
        return;
      }
      const { code, ctx } = analyze(ref.rel);
      const target = code.split('\n')[ref.line - 1];
      if (target === undefined) {
        problems.push(`${tag} 指到第 ${ref.line} 行，但那个文件只有 ${code.split('\n').length} 行 ⇒ 坐标过期`);
        return;
      }
      if (lineMentionsKey(target, ctx, e.key)) return;
      problems.push(`${tag} 那一行**不含该 key**（也没有能解析到它的常量名）。实际内容：`
        + `\`${target.trim().slice(0, 90)}\` ⇒ 坐标是编的或已漂移：**行号看着合理不等于它对**`
        + '（注释里出现过也不算，剥完注释才算）');
    });
  });
  return problems;
}

/** 那一行含该 key 的字面量，或含一个能解析到它的常量名（表驱动那种真坐标必须算通过）。 */
function lineMentionsKey(lineText, ctx, key) {
  if (lineText.includes(key)) return true;
  for (const m of lineText.matchAll(new RegExp(IDENT_RE, 'g'))) {
    const lits = resolveExpr(m[0], ctx);
    if (lits && lits.has(key)) return true;
  }
  return false;
}

test('活二⑤ `where` 是坐标不是说明文字：五种假坐标都要红，盘上那份要全绿', () => {
  const { entries } = loadEnvLegExceptions();
  // (a) 常驻闸门：盘上每条 where 的每个坐标都必须现跑核对得上
  assert.deepEqual(whereProblems(entries, RUNNER_ENV_KEYS), [], '例外清单里有对不上的坐标（见问题列表）');
  // (b) 文件不存在
  assert.match(whereProblems([{ key: 'ERIX_RUN_DATA_TTL_HOURS', reason: 'r', where: 'runner/nope.js:10' }], new Map()).join('\n'),
    /文件不存在/);
  // (c) 文件在、行在，但那行没有这个 key（「行号看着合理」正是假坐标能活下来的原因）
  assert.match(whereProblems([{ key: 'ERIX_RUN_DATA_TTL_HOURS', reason: 'r', where: 'runner/agentd.js:1' }], new Map()).join('\n'),
    /不含该 key/);
  // (d) **注释背书**：`agentd.js:52` 那行的 `process.env.ERIX_AGENT_VERSION` 是注释正文里引用的旧代码
  assert.match(whereProblems([{ key: 'ERIX_AGENT_VERSION', reason: 'r', where: 'runner/agentd.js:52' }], new Map()).join('\n'),
    /不含该 key/);
  // (e) 只给文件不给行，而那个文件里对这个 key 没有活读（扫描器剥完注释不认）⇒ 红
  assert.match(whereProblems([{ key: 'ERIX_RUN_DATA_TTL_HOURS', reason: 'r', where: 'runner/lib/build-info.js' }], new Map()).join('\n'),
    /没发现对 ERIX_RUN_DATA_TTL_HOURS 的活读/);
  // (f) 只剩说明文字 / 缺 where
  assert.match(whereProblems([{ key: 'ERIX_RUN_DATA_TTL_HOURS', reason: 'r', where: 'runner 里读，compose 没有' }], new Map()).join('\n'),
    /是\*\*说明文字\*\*/);
  assert.match(whereProblems([{ key: 'ERIX_RUN_DATA_TTL_HOURS', reason: 'r' }], new Map()).join('\n'), /缺 where/);
  // (g) 反向自证：表驱动那种真坐标（那一行只有 `envName`，没有字面量）必须**算通过**，
  //     否则这条判据是在误杀真坐标而不是在杀假坐标
  const tableEntry = entries.find((x) => x.key === TIMEOUT_KEYS[0]);
  assert.ok(tableEntry, '四相超时里至少这一条已登记（活一⑤）');
  assert.deepEqual(whereProblems([tableEntry], RUNNER_ENV_KEYS), [],
    `表驱动坐标（${tableEntry.where}）被误判 ⇒ 「可解析到它的常量名」这一支没接上`);
});

test('活二⑥ 那条被推翻的登记：现坐标 ⇒ 绿；退回登记时的旧坐标 ⇒ 必须红（证明这格真的在判坐标）', () => {
  const { entries } = loadEnvLegExceptions();
  const e = entries.find((x) => x.key === 'ERIX_AGENT_VERSION');
  assert.ok(e, 'ERIX_AGENT_VERSION 仍在例外清单里（不许为了让判据变绿删条目）');
  assert.deepEqual(whereProblems([e], RUNNER_ENV_KEYS), [], `现坐标应核对通过：${e.where}`);
  assert.match(e.where, /runner\/lib\/build-info\.js:84/, `读取点坐标必须是真读取那一行，实际 ${e.where}`);
  // 变异入口：退回**登记当时的坐标**（`runner/agentd.js` 不带行 + `provisioner.js:257`）。
  // 前者只被注释提到过，后者如今是 #581 新加的 `ERIX_FINAL_TEXT_TOOLCALL_MARKERS` 那一行。
  const stale = { ...e, where: 'runner/agentd.js；注入点 portal/src/provisioner.js:257（`agentVersion !== \'dev\'` 才 push）' };
  const problems = whereProblems([stale], RUNNER_ENV_KEYS).join('\n');
  assert.match(problems, /没发现对 ERIX_AGENT_VERSION 的活读/, `旧的第一坐标必须红，实际：\n${problems}`);
  assert.match(problems, /不含该 key/, `旧的第二个坐标必须红，实际：\n${problems}`);
});

test('活一⑤ 数据表驱动的 env 名必须进枚举；名字是从表里读的（本文件源码里不出现那几个字面量）', () => {
  assert.ok(TIMEOUT_KEYS.length >= 4, `相超时数据表只读出 ${TIMEOUT_KEYS.length} 个名字 ⇒ 变异入口失效了`);
  for (const key of TIMEOUT_KEYS) {
    const where = RUNNER_ENV_KEYS.get(key);
    assert.ok(where, `扫描器没把 ${key} 当读取（它活在 ${'`'}LLM_TIMEOUT_ENV${'`'} 数据表 + ${'`'}env?.[envName]${'`'} 那一形里）`
      + ' ⇒ 复刻 #557 的根因：读形认得、名字在表里，旧扫描器只认字面量就静默漏掉');
    assert.ok([...where.keys()].some((f) => f.includes('llm-timeouts.js')),
      `${key} 的出处必须是 lib/llm-timeouts.js（实际 ${JSON.stringify([...where.keys()])}）`);
  }
  // 「不是硬编码」的可执行证据：本文件源码里一次都不出现这些 env 名
  for (const key of TIMEOUT_KEYS) {
    assert.ok(!SELF_TEXT.includes(key), `判据源码里出现了字面量 ${key} ⇒ 名字被抄进判据了（应当从真模块/数据表现读）`);
  }
  // 表是活的：改名 ⇒ 枚举跟着改名（旧名消失、新名出现）。判据读的永远是**表**，不是四个手写名字。
  const renamed = scanEnvReads(RUNNER_ROOT, {
    rootLabel: 'runner',
    mutate: (rel, text) => (rel.includes('llm-timeouts.js')
      ? text.replace(/'(ERIX_LLM_TIMEOUT_[A-Z_]+)'/g, "'$1_RENAMED'")
      : text),
  });
  for (const key of TIMEOUT_KEYS) {
    assert.ok(!renamed.keys.has(key), `改了数据表里的名字，枚举里还留着 ${key} ⇒ 它是从别处（手抄）来的`);
    assert.ok(renamed.keys.has(`${key}_RENAMED`), `改名后的 ${key}_RENAMED 没进枚举 ⇒ 名字不是从表里读的`);
  }
  // 且这三条坐标（例外清单里的 where）指向的确实是那张表/那一行
  const { entries } = loadEnvLegExceptions();
  const regs = entries.filter((x) => TIMEOUT_KEYS.includes(x.key));
  assert.equal(regs.length, TIMEOUT_KEYS.length, '四项相超时必须在例外清单里逐条登记（三腿全无，不是漏抄）');
  assert.deepEqual(whereProblems(regs, RUNNER_ENV_KEYS), [], '相超时的 where 坐标对不上');
  for (const r of regs) assert.match(r.where, /runner\/lib\/llm-timeouts\.js/, `${r.key} 的坐标必须指向 lib/llm-timeouts.js（实际 ${r.where}）`);
});

test('活一⑥ 别名点号形（`env.ERIX_X`）必须算读取；注释里那个同名读形**不许**再背书', () => {
  const key = 'ERIX_AGENT_VERSION';
  const where = RUNNER_ENV_KEYS.get(key);
  assert.ok(where, `${key} 不在枚举里 ⇒ 别名点号形（readBuildInfo({ env = process.env }) 里的 env.ERIX_X）没接上`);
  const files = [...where.keys()];
  assert.ok(files.some((f) => f === 'lib/build-info.js'),
    `${key} 的读取点必须是 lib/build-info.js（实际 ${JSON.stringify(files)}）`);
  assert.ok(!files.some((f) => f === 'agentd.js'),
    `${key} 的出处里还有 agentd.js（实际 ${JSON.stringify(files)}）⇒ 注释又在给登记背书`);
  // 变异入口 A：把**注释里**那个名字改掉 ⇒ 枚举不动（证明它本来就没靠注释）
  const mutComment = scanEnvReads(RUNNER_ROOT, {
    mutate: (rel, text) => (rel === 'agentd.js'
      ? text.replace(/process\.env\.ERIX_AGENT_VERSION/g, 'process.env.ERIX_RENAMED_ONLY_IN_COMMENT')
      : text),
  });
  assert.deepEqual([...(mutComment.keys.get(key)?.keys() ?? [])], files,
    '改掉注释里的名字后出处变了 ⇒ 注释其实还在被当读取点计入（前一条断言是假的）');
  // 变异入口 B：把**真读取那一行**注释掉 ⇒ 该键必须从枚举里消失
  const mutCode = scanEnvReads(RUNNER_ROOT, {
    mutate: (rel, text) => (rel === 'lib/build-info.js'
      ? text.replace(/^(\s*)(const override = s\(env\.ERIX_AGENT_VERSION\);)/m, '$1// $2')
      : text),
  });
  assert.ok(!mutCode.keys.has(key),
    '把真读取注释掉之后该键还在枚举里 ⇒ 剥注释这一步没生效，或者还有另一处读取没被这条判据看到');
});

test('活一⑦ 注释与字符串：注释掉必消失、串里提到的不算读取、模板插值里的算读取（三向都自证）', () => {
  // 控制组（真树）：这些读取必须在
  assert.ok(RUNNER_ENV_KEYS.has('ERIX_SHELL_LIVENESS_MS'), '真树上的 shell-tools 读取不见了 ⇒ 剥注释剥过头了');
  for (const key of TIMEOUT_KEYS) assert.ok(RUNNER_ENV_KEYS.has(key), '控制组：真树的相超时读取不见了');
  // ① 把数据表那一行读取注释掉 ⇒ 四项必须全部消失（**且**没把别的键一起吞掉）
  const mutComment = scanEnvReads(RUNNER_ROOT, {
    mutate: (rel, text) => (rel === 'lib/llm-timeouts.js'
      ? text.replace(/^(\s*)(out\[field\] = parseTimeoutMs\()/m, '$1// $2')
      : text),
  });
  for (const key of TIMEOUT_KEYS) {
    assert.ok(!mutComment.keys.has(key), `${key} 被注释掉了却还在枚举里 ⇒ 排除逻辑是装饰`);
  }
  assert.ok(mutComment.keys.has('ERIX_SHELL_LIVENESS_MS'),
    '只注释了一处，别的键也不见了 ⇒ 剥注释吞掉了代码（那是假绿方向）');
  // ② 多出处键：只注释掉其中一处，另一处还在 ⇒ 不许误报消失
  const mutOne = scanEnvReads(RUNNER_ROOT, {
    mutate: (rel, text) => (rel === 'lib/shell-tools.js'
      ? text.replace(/^(\s*)(const live = .*ERIX_SHELL_LIVENESS_MS.*;)/m, '$1// $2')
      : text),
  });
  assert.ok(mutOne.keys.has('ERIX_SHELL_LIVENESS_MS'), '另一处读取还在却消失了 ⇒ 计数逻辑有问题');
  // ③ 串里**提到**的形状不算读取；模板插值 `${…}` 里的算（那是真代码，见 runner/worker.js:774）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-shape-'));
  try {
    fs.writeFileSync(path.join(dir, 'shapes.js'), [
      "export const note = 'process.env.ERIX_GHOST_MENTIONED 已废弃';",
      'export const t = `x=${process.env.ERIX_GHOST_INTERP} y`;',
      '// process.env.ERIX_GHOST_LINECOMMENT',
      '/* process.env.ERIX_GHOST_BLOCKCOMMENT */',
    ].join('\n'));
    const got = scanEnvKeys(dir);
    assert.deepEqual([...got.keys()].sort(), ['ERIX_GHOST_INTERP'],
      `形状判定错了（实际 ${JSON.stringify([...got.keys()])}）：串里提到/注释里的应当放过，模板插值里的应当算读取`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('活一⑧ 解析不出 env 名的读形 ⇒ 进 unsupported 清单；不登记红、无理由红、坐标漂了红、过期了红', () => {
  // ① 夹具：运行期拼名的读形必须被记成 unsupported（**不是**静默丢掉）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-unsupported-'));
  try {
    fs.writeFileSync(path.join(dir, 'dyn.js'), [
      'export function pick(suffix, env = process.env) { return env[`ERIX_DYN_${suffix}_X`]; }',
      'export const lit = process.env.ERIX_GHOST_STATIC;',
    ].join('\n'));
    const { keys, unsupported } = scanEnvReads(dir);
    assert.ok(keys.has('ERIX_GHOST_STATIC'), '字面量那读形必须还在（否则下面的判据是在判一个空集合）');
    assert.equal(unsupported.length, 1, `动态读形应当记 1 条，实际 ${JSON.stringify(unsupported)}`);
    assert.match(unsupported[0].at, /^dyn\.js:1$/);
    assert.match(unsupported[0].shape, /^env\[`ERIX_DYN_/);
    // ② 没登记 ⇒ 红
    assert.match(unsupportedProblems(unsupported, []).join('\n'), /没登记在 deploy\/env-legs-exceptions\.json/);
    // ③ 登记带理由 ⇒ 绿（同一把尺，共用 validateUnsupported）
    const reg = [{ at: 'dyn.js:1', read: unsupported[0].shape, reason: '拼名来自调用方，本站没有对应配置面' }];
    assert.deepEqual(unsupportedProblems(unsupported, reg), []);
    assert.deepEqual(validateUnsupported(reg, dir), []);
    // ④ 去掉理由 ⇒ 红（复用「无理由 ⇒ 红」那套机制的同一句措辞）
    assert.match(validateUnsupported([{ at: 'dyn.js:1', read: unsupported[0].shape }], dir).join('\n'), /缺理由字段 reason/);
    assert.match(validateUnsupported([{ at: 'dyn.js:1', read: unsupported[0].shape, reason: '  ' }], dir).join('\n'), /缺理由字段 reason/);
    // ⑤ 坐标漂移 / 过期条目 ⇒ 红
    assert.match(unsupportedProblems(unsupported, [{ ...reg[0], at: 'dyn.js:9' }]).join('\n'), /行号漂了/);
    assert.match(unsupportedProblems([], reg).join('\n'), /扫描器现在\*\*认不出来\*\*/);
    // ⑥ 登记的 `at` 指向不存在的文件 ⇒ 红（与 where 同一条口径）
    assert.match(validateUnsupported([{ ...reg[0], at: 'nope/dir/dyn.js:1' }]).join('\n'), /指向不存在的文件/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // ⑦ 真树的咬合：扫出来的动态读形必须全部登记，理由非空，坐标现跑对得上
  const { unsupported: registered, problems } = loadEnvLegExceptions();
  assert.deepEqual(problems, [], '例外清单（含 unsupported 段）本身不合法');
  assert.ok(RUNNER_SCAN.unsupported.length > 0,
    '真树里一个动态读形都没有了？那这条判据就成了空转 —— 去把 unsupported 段删掉并同步这里');
  assert.deepEqual(unsupportedProblems(RUNNER_SCAN.unsupported, registered), [],
    'runner 里的动态 env 读形与登记没咬合（未登记 / 过期 / 坐标漂移）');
});
