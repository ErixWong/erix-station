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

/** 在文件里找**第一处**含 needle 的行号（1 起）。判据引用产品行号时必须走它，不硬编码。 */
function lineOf(rel, needle) {
  const lines = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').split('\n');
  // ⚠ 跳过**注释行**：注释里提到这个名字不算（261117 实测：`lineOf` 找到了 `:361` 的注释，
  // 而坐标校验剥注释后自然判它「不含该 key」⇒ 判据自己误杀真登记）。
  const isComment = (l) => /^\s*(\/\/|\/\*|\*)/.test(l);
  const i = lines.findIndex((l) => l.includes(needle) && !isComment(l));
  assert.ok(i >= 0, `${rel} 里找不到 ${JSON.stringify(needle)} ⇒ 产品代码改名/搬走了，判据要跟着改`);
  return i + 1;
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
 * 同上，但**也认 `(`**（解构里的 `(…)` 当成分组用，见 `paramBindingsIn`）。
 * 单独一个函数而不是放宽 `matchBrackets`：那边是数据表扫描，`const T = (x)` 那种根本不该当表。
 */
function matchGroup(masked, from) {
  const open = masked[from];
  const close = { '{': '}', '[': ']', '(': ')' }[open];
  if (!close) return null;
  let depth = 0;
  for (let i = from; i < masked.length; i += 1) {
    if (masked[i] === open) depth += 1;
    else if (masked[i] === close) { depth -= 1; if (depth === 0) return i + 1; }
  }
  return null;
}

/** 这些词之后的 `(...)` 是**控制流头部**，不是参数表（`for (const [k, v] of [[…]])` 那一形最容易误判）。 */
const CONTROL_WORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'with', 'do', 'else', 'return', 'typeof',
  'void', 'delete', 'new', 'case', 'await', 'yield', 'in', 'of',
]);

/** 全量括号配对（在 structuralMask 上跑）：`open → close`（不含）。串正文/注释/正则正文已抹平 ⇒ 内容骗不到结构。 */
function bracketPairs(masked) {
  const OPEN = { '(': ')', '[': ']', '{': '}' };
  const CLOSE = { ')': '(', ']': '[', '}': '{' };
  const pairs = new Map();
  const stack = [];
  for (let i = 0; i < masked.length; i += 1) {
    const c = masked[i];
    if (OPEN[c]) stack.push([c, i]);
    else if (CLOSE[c]) {
      const top = stack.pop();
      if (top && top[0] === CLOSE[c]) pairs.set(top[1], i + 1);
    }
  }
  return pairs;
}

/** 「最内层 `{}` 作用域」查询（= 那一层的**语句区**）。顶层 ⇒ `{whole:true, start:0, end:len}`。 */
function braceScopes(masked, pairs) {
  const braces = [...pairs].filter(([o]) => masked[o] === '{').sort((a, b) => a[0] - b[0]);
  return (offset) => {
    let best = null;
    for (const [o, c] of braces) {
      if (o >= offset) break;
      if (offset < c) best = [o, c];        // 升序 ⇒ 最后命中的那对就是最内层
    }
    return best ? { start: best[0], end: best[1], whole: false } : { start: 0, end: masked.length, whole: true };
  };
}

/** 顶层逗号切分（`masked` 上深度 0 的 `,` 才算分隔 ⇒ `f(a, {b: 1}, [c, d])` 切得对）。 */
function splitTop(masked, from, to) {
  const parts = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) { parts.push([start, i]); start = i + 1; }
  }
  parts.push([start, to]);
  return parts.filter(([a, b]) => masked.slice(a, b).trim() !== '');
}

/** 从 `from` 起第一个**非空白**字符的下标；没有 ⇒ `null`。 */
function nextNonSpace(text, from) {
  const m = /\S/.exec(text.slice(from));
  return m ? from + m.index : null;
}

/** `[from, to)` 里第一个**非空白**下标（**不越过 `to`**：解构切出来的片段是空的就要如实返回 `null`）。 */
function firstNonSpaceIn(text, from, to) {
  const m = /\S/.exec(text.slice(from, to));
  return m ? from + m.index : null;
}

/** 在 `[from, to)` 里找第一个**括号深度 0** 且满足 `want` 的字符；没有 ⇒ `-1`。 */
function firstTopChar(masked, from, to, want) {
  let depth = 0;
  for (let i = from; i < to; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (depth === 0 && want(c, i)) return i;
  }
  return -1;
}

/**
 * 绑定模式片段里第一个**顶层默认值分界 `=`**；没有 ⇒ `-1`。
 * 括号内的不算（`{ a: [1, 2] }` 里没默认值）；`=>`（默认值是个箭头）、`==` / `!=` / `<=` / `>=`
 * 那些比较号也不算（认错了会把半个表达式当成绑定名）。
 */
function firstDefaultEq(masked, from, to) {
  return firstTopChar(masked, from, to, (c, i) => c === '='
    && !'>='.includes(masked[i + 1] ?? '') && !'=!<>'.includes(masked[i - 1] ?? ''));
}

/** 对象成员「`键 : 绑定目标`」的分界（同样只认深度 0；`{ 'a:b': x }` 那个冒号在串正文里，已被抹平）。 */
function firstMemberColon(masked, from, to) {
  return firstTopChar(masked, from, to, (c) => c === ':');
}

/**
 * 一段**认不出**的绑定片段里出现过哪些名字 —— fail loudly 的记账面（#587 族 A 三轮①）。
 * 认不出的形状不能静默返回「没绑定」：那等于让外层同名常量继续生效 = 幻影 key。这里把片段里
 * 像名字的都算作「被绑定但解析不出值」，宁可是**假红**（读形进 `unsupported`）也不要静默放行。
 * 排掉两类明显不是绑定的位置：`.` / `?.` 之后的属性名，以及紧跟 `:` 的**键名**（`{ k: x }` 里的 `k`）。
 */
function opaqueBindingNames(masked, from, to) {
  const names = new Set();
  const slice = masked.slice(from, to);
  for (const m of slice.matchAll(new RegExp(IDENT_RE, 'g'))) {
    const i = m.index;
    const prev = slice[i - 1];
    if (prev === '.' || prev === '?') continue;                       // `b.c` / `b?.c` 的 `c`
    const after = slice.slice(i + m[0].length);
    if (/^\s*:/.test(after)) continue;                                // `{ k: x }` 的键名 `k`
    names.add(m[0]);
  }
  return [...names];
}


/** 能**结束**一个表达式的字符（ASI 判定用：`x\n const y` 才断，`(\n x` / `x +\n y` 那种没成形的不断）。 */
const EXPRESSION_ENDS_RE = /[\w$)\]}'"`]/;

/**
 * 换行之后**能**接着上一行表达式的开头（⇒ ASI **不**插分号 ⇒ 表达式体还要往下延伸）：
 * 运算符 / 成员访问 `.` `?.` / 调用 `(` / 下标 `[` / 模板续写（反引号），以及 `in` / `of` /
 * `instanceof` 这三个「看着像新语句、其实接在上一行」的词（把它们当边界会把遮蔽算窄 = 错记，静默）。
 *
 * **反过来才是主方向**（#587 族 A 三轮②）：下一行以普通标识符 / 数字 / 声明关键字开头 ⇒ 那个换行
 * 必然插分号 ⇒ 体到此为止。旧口径**只列了「哪些词算边界」**（`STATEMENT_HEAD_RE`），于是
 * `const f = (KEY) => env[KEY]\nprocess.env[KEY];` 里下一行以 `process` 开头不算边界 ⇒ 遮蔽拉到文件尾
 * ⇒ 箭头**之后**那条读外层常量的静态读形被误判成动态 = **假红**（那个 key 从三腿判据里隐形）。
 * 两头都要成立：只把「不可能续行」的开头当边界，`a\n .b(K)` / 跨行三元 / 跨行 `??` 必须仍全覆盖
 * （区间算窄过头 = 体后半段那些动态读又会被错记成外层静态名 = 回到假绿）。
 */
const EXPRESSION_CONTINUATION_RE = /^(?:[.?([+*/%<>=!&|^,;:~`-]|\*\*|=>|\?\?|in\b|of\b|instanceof\b)/;

/**
 * **无花括号箭头**（表达式体）的区间结尾，从 `=>` 之后第一个下标起算：扫到第一个「深度 0 的结束符」
 * （`;` `,` `)` `]` `}`）或 ASI 语句边界为止。
 *
 * 旧口径取「最内层**外围块**的结尾」（`{` 都没写，没配对 ⇒ 保守拉宽），后果是实测的**假红**：
 * `const g = (KEY) => env[KEY]; … process.env[KEY]` —— 箭头**之后**那次读的是外层常量，却被算进
 * 箭头参数的遮蔽区间 ⇒ 静态读形被判成动态 ⇒ 进 `unsupported`（三腿判据看不见这个 key，另一种静默）。
 * 拉窄的边界必须**仍覆盖整个表达式体**：体内不可能出现深度 0 的 `;` `,` `)` `]` `}`（那些符号一出现
 * 就说明表达式已经结束），所以这一趟扫描只会停在真正的体尾。
 *
 * ASI 那一跳要看**原文**（`code`）而不是掩码：串正文被抹成空格后，`a\n 'x'` 那种「下一行以串开头」
 * 会被 `nextNonSpace(masked, …)` 跳到串后面去，误认成续行。`code` 与 `masked` 等长、坐标同一套。
 */
function expressionBodyEnd(code, masked, from) {
  let depth = 0;
  let last = '';
  for (let i = from; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') { depth += 1; last = c; continue; }
    if (c === ')' || c === ']' || c === '}') { if (depth === 0) return i; depth -= 1; last = c; continue; }
    if (depth === 0 && (c === ';' || c === ',')) return i;
    if (depth === 0 && c === '\n' && EXPRESSION_ENDS_RE.test(last)) {
      const nx = nextNonSpace(code, i + 1);
      // 下一行没东西了（文件尾）也算边界；否则只有「能续行」的开头才让体继续下去。
      if (nx == null || !EXPRESSION_CONTINUATION_RE.test(code.slice(nx))) return i;
    }
    if (!/\s/.test(c)) last = c;
  }
  return masked.length;
}


/** 无括号的单参数箭头 `KEY => …`：`KEY` 之前不许是标识符字符或闭合括号（挡掉 `(KEY) =>` 那种已有括号的形）。 */
const BARE_ARROW_PARAM_RE = new RegExp(`(?<![\\w$)\\]}])(${IDENT_RE})\\s*=>`, 'g');

/**
 * 一段**参数位 / 解构成员位**里有哪几个绑定：`{ bindings: [{ name, at, def|null }], unparsed: [{ at, to }] }`。
 * 逐层递归，要覆盖合法 JS 的全部绑定形状（#587 族 A 三轮①：旧口径只解一层，`{ a: { b: KEY } }` /
 * `{ a: [KEY] }` 这类「冒号右边还是解构」的成员**整个漏收** ⇒ `KEY` 不进遮蔽表 ⇒ 外层同名常量把
 * 动态读错记成静态 key、`unsupported` 为空 = 假绿）：
 *   · 简单名 `a`、带默认值 `a = 'ERIX_X'`、rest `...rest`（rest 的目标继续递归：`...[b, c]`）
 *   · 数组解构 `[a, , b]`（洞不是绑定）、嵌套 `[{ x: Y }]`、`[a, ...[b, c]]`
 *   · 对象解构 `{ k }` / `{ k = X }` / `{ old: alias = X }` / `{ 'a b': alias }` / `{ [k]: alias }`
 *     ⇒ 冒号**右边**才是绑定；右边还是解构（`{ a: { b: X } }`）就继续往里钻
 *   · 模式自带的默认值 `{ a: b } = {}`：那个默认值属于**整个模式**而不是 `b` 的绑定值
 *     ⇒ 往里钻时不带上它（带上去就把「整个对象」当成了 `b` 的值，解析方向不对）
 * **认不出的形状一律进 `unparsed`**（调用方据此 fail loudly），不许静默返回「这里没绑定」：
 * 静默 = 外层同名常量继续生效 = 幻影 key（与上面那个假绿同形）。
 * `memberIsObject` 只在**对象解构的成员位**为真（那里才有 `键:` 前缀可剥）；数组成员与参数位本身不是。
 */
function paramBindingsIn(masked, code, from, to, memberIsObject = false) {
  const bindings = [];
  const unparsed = [];
  const walk = (a, b, isObjectMember) => {
    const s = firstNonSpaceIn(masked, a, b);
    if (s == null) return;                                  // 空片段（数组的洞 `,`）⇒ 没有绑定
    if (masked.startsWith('...', s)) { walk(s + 3, b, false); return; }   // rest：剩下的就是绑定目标
    const eq = firstDefaultEq(masked, s, b);
    const patEnd = eq < 0 ? b : eq;                         // 默认值分界**之前**才是模式
    const def = eq < 0 ? null : code.slice(eq + 1, b).trim();
    const p = firstNonSpaceIn(masked, s, patEnd);
    const open = p == null ? '' : masked[p];
    if (open === '{' || open === '[' || open === '(') {
      const bc = matchGroup(masked, p);
      // 括号不配对，或那个闭括号已经**越过**默认值分界 ⇒ 这段形状认不出，不许猜
      if (bc == null || bc - 1 > patEnd) { unparsed.push({ at: s, to: b }); return; }
      for (const [ma, mb] of splitTop(masked, p + 1, bc - 1)) walk(ma, mb, open === '{');
      return;
    }
    if (isObjectMember) {
      // 只在模式部分里找冒号：`{ k = c ? 'A' : 'B' }` 那个三元冒号坐在默认值里，不算成员分隔
      const colon = firstMemberColon(masked, s, patEnd);
      if (colon >= 0) { walk(colon + 1, b, false); return; }   // `{ k: 目标 = 默认值 }` ⇒ 目标在冒号右边
    }
    const name = new RegExp(`^(${IDENT_RE})$`).exec(masked.slice(s, patEnd).trim());
    if (name) { bindings.push({ name: name[1], at: s, def }); return; }
    unparsed.push({ at: s, to: b });
  };
  walk(from, to, memberIsObject);
  return { bindings, unparsed };
}

/**
 * **参数遮蔽表**：每个参数名 → `{ start, end, lits|null }`，`end` = 那个函数体的结尾。
 * 参数表怎么认：括号对之后紧跟 `=>` 或 `{`；`{` 形还要求括号前不是 `if`/`for`/… 这类控制词（⇒ 定义，不是调用）。
 * `=>` 形**不许**用控制词挡：`return (KEY) => env[KEY]` 也是定义（旧口径一律挡掉 ⇒ `return`/`typeof` 后面的
 * 箭头参数整个不进遮蔽表 = 动态 key 被错记成文件级静态名的又一处假绿）。
 *
 * 两处必须同时成立，否则会各红一边：
 *   · **所有参数位都要进来**（含**末位**）：`pairs` 里的 `close` 是「右括号**之后**」的 exclusive 下标 ⇒
 *     参数位是 `[open + 1, close - 1)`。旧代码写 `splitTop(masked, open + 1, close)` ⇒ 末位参数的片段
 *     里带着那个 `)` ⇒ `KEY)` 匹配不上任何绑定形状 ⇒ **末位参数整个漏收**（`function f(KEY){}`、
 *     `read(KEY){}`、`(KEY)=>` 实测 `shadows=[]`），动态 key 于是沿用文件级常量 = 幻影 key 进枚举、
 *     `unsupported` 为空 = 闸门放行。带默认值的末位参数同理受害，只是方向相反：默认值文本尾随一个 `)`
 *     ⇒ `litsOf` 解析不出 ⇒ 可解析的 `function f(X = OUTER)` 被丢进 `unsupported`（假红）。
 *   · **遮蔽区间要算窄**（见 `expressionBodyEnd`）：表达式体只覆盖体本身，不延伸到外围块尾。
 */
function collectParamBindings(code, masked, pairs, scopes, litsOf) {
  const out = [];
  /**
   * 函数体尾，从**体的第一个下标** `from` 起算：体是 `{` 开头 ⇒ 那对花括号的尾；否则（表达式体）⇒
   * `expressionBodyEnd`。两者都再 `Math.min(外围块尾)`：箭头不可能比包住它的那个 `{}` 还长，
   * 这条上限既把表达式体扫描的代价钉在局部（大文件里不会一路扫到文件尾），也保证新口径
   * **只会比旧口径窄，不会更宽**（旧口径就是这个上限）。
   */
  const bodyEnd = (from, ceiling) => {
    const b = nextNonSpace(masked, from);
    const raw = b != null && masked[b] === '{'
      ? (pairs.get(b) ?? scopes(b).end)
      : expressionBodyEnd(code, masked, from);
    return Math.min(raw, ceiling);
  };
  const sites = [];
  for (const [open, close] of [...pairs].filter(([o]) => masked[o] === '(').sort((a, b) => a[0] - b[0])) {
    const tail = /^\s*(=>|\{)/.exec(masked.slice(close, close + 64));
    if (!tail) continue;
    if (tail[1] === '{') {
      const head = masked.slice(Math.max(0, open - 96), open);
      const hw = new RegExp(`(${IDENT_RE})\\s*$`).exec(head);
      if (hw && CONTROL_WORDS.has(hw[1])) continue;      // `if (x) {` / `for (const [k, v] of …) {` 不是定义
    }
    // 参数位 = `(` 与 `)` 之间（`close` 已经**越过**右括号 ⇒ 必须 -1，否则末位参数片段里带着 `)`）。
    // 体首：`{` 形从那个花括号**本身**起算（`tail[0]` 末尾就是它）；`=>` 形从箭头之后起算。
    const bodyFrom = tail[1] === '{' ? close + tail[0].length - 1 : close + tail[0].length;
    sites.push({ from: open + 1, to: close - 1, end: bodyEnd(bodyFrom, scopes(close).end) });
  }
  // **无括号**的单参数箭头 `KEY => env[KEY]`：没有 `(` 可配 ⇒ 单独一趟，否则这一形的参数永远漏收
  for (const m of masked.matchAll(BARE_ARROW_PARAM_RE)) {
    const name = m[1];
    sites.push({ from: m.index, to: m.index + name.length, end: bodyEnd(m.index + m[0].length, scopes(m.index).end) });
  }
  for (const site of sites) {
    if (site.to < site.from) continue;
    for (const [a, b] of splitTop(masked, site.from, site.to)) {
      const { bindings, unparsed } = paramBindingsIn(masked, code, a, b);
      for (const p of bindings) {
        out.push({ name: p.name, start: p.at, end: Math.max(site.end, p.at + p.name.length), lits: litsOf(p.def) });
      }
      // **解析不出的嵌套形状 ⇒ fail loudly**（#587 族 A 三轮①）：把那个片段里出现过的名字全部按
      // 「被遮蔽但解析不出」记账 ⇒ 它在函数体内任何读形都进 `unsupported`（宁可假红）；反过来若静默
      // 当「这里没绑定」，外层同名常量会被错记成静态 key（假绿），闸门那一层全绿。
      for (const u of unparsed) {
        for (const name of opaqueBindingNames(masked, u.at, u.to)) {
          out.push({ name, start: u.at, end: Math.max(site.end, u.to), lits: null, opaque: true });
        }
      }
    }
  }
  return out;
}

/** 读取点上有没有**遮蔽**？`{hit:false}` = 没有（照旧查文件级名字表）；`{hit:true, lits:null}` = 被遮蔽且名字解析不出 ⇒ fail loudly。 */
function shadowAt(shadows, name, at) {
  const list = shadows?.get(name);
  if (!list || list.length === 0) return { hit: false };
  const covering = list.filter((s) => at >= s.start && at < s.end);
  if (covering.length === 0) return { hit: false };
  const width = (s) => s.end - s.start;
  const min = Math.min(...covering.map(width));
  const cands = covering.filter((s) => width(s) === min);        // 最内层那一个（词法作用域赢）
  if (cands.some((s) => s.lits == null)) return { hit: true, lits: null };
  if (cands.length > 1) {
    const key = (s) => [...s.lits].sort().join('\u0000');
    if (new Set(cands.map(key)).size > 1) return { hit: true, lits: null };   // 同层两个不同绑定 ⇒ 不许猜
  }
  return { hit: true, lits: new Set(cands[0].lits) };
}

// ─────────────────────────────────────────────────────────────────────────────
// #587 折中方案**第 2 步**（261123）：三种「在 env 上取名字」的漏形 + fail-closed 兜底。
//
// 审计（`/tmp/audit-587/AUDIT-REPORT.md` 第 1 节）第 5/6/7 行那三形的读数都是
// `keys=[]` **且** `unsupported=[]`：既不登记也不报错 ⇒ 「`unsupported` 为空」被当成「没有动态读」
// = 假绿。本段补的是**形状识别**（`Object.assign` 的 env 别名 / `Reflect.get` / 解构），
// 外加一条兜底口径：**认得出「在 env 上取名字」却解析不出静态 key ⇒ 必须进 `unsupported`**。
// 允许误报（宁可假红），**不许静默**；而「完全没有 env 语义的普通对象操作」不许进来（判据带负例）。
// ─────────────────────────────────────────────────────────────────────────────

/** env 对象表达式的**文本**口径（去空白后比对）：`process.env` / `process?.env`。 */
const ENV_OBJECT_TEXT = /^process\??\.env$/;
/** `Reflect.<op>(env, key)` 里算「读」的 op —— `set` / `deleteProperty` 是**写**形 ⇒ 不是读站点。 */
const REFLECT_READ_OPS = new Set(['get', 'has']);
/** `Object.<op>(env)` 一次取走**全部**名字 ⇒ 永远没有静态 key，只能 fail closed。 */
const ENV_ENUM_OPS = new Set(['keys', 'values', 'entries']);

/**
 * 表达式（从 `from` 起）的**结束**下标：括号深度 0 上遇到 `,` `;` 换行，或一个**没有配对**的右括号就停。
 * 两个状态机都保留行列位 ⇒ 停下来的位置仍是同一份文本的下标。
 */
function exprEndAt(masked, from) {
  let depth = 0;
  for (let i = from; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0 && (c === ',' || c === ';' || c === '\n')) return i;
  }
  return masked.length;
}

/**
 * `[from, to)` 这段表达式**是不是 env 对象**（第 2 步的唯一口径，三形共用）。
 * 认四种：① `process.env` / `process?.env`；② 已登记的别名（`env = process.env` 那一路）；
 * ③ 拷贝形 `Object.assign(…, <env>, …)` —— 任一实参是 env 对象 ⇒ 结果带着 env 的属性；
 * ④ 展开形 `{ …<env> }`。括号配平在 `masked` 上做 ⇒ 串正文里的括号骗不到它，名字比较在 `code` 上做。
 */
function isEnvSourceAt(code, masked, envObjs, from, to, depth = 0) {
  if (from == null || to == null || from >= to || depth > 4) return false;
  const flat = code.slice(from, to).replace(/\s+/g, '');
  if (ENV_OBJECT_TEXT.test(flat)) return true;
  if (/^[A-Za-z_$][\w$]*$/.test(flat) && envObjs.has(flat)) return true;
  // `env ?? {}` / `process.env || {}`：兜底一个空对象不改「取的就是 env」这件事。
  // 真树同形：`portal/src/version-info.js` 入口里的 `… = env ?? {}`（审计 #7 提过那一行）。
  const fb = lastTopChar(masked, from, to,
    (c, i) => (c === '?' && masked[i + 1] === '?') || (c === '|' && masked[i + 1] === '|'));
  if (fb > from) {
    const after = nextNonSpace(masked, fb + 2);
    if (after != null && after < to && masked[after] === '{'
      && isEnvSourceAt(code, masked, envObjs, from, fb, depth + 1)) return true;
  }
  const open = nextNonSpace(masked, from);
  if (open == null || open >= to || depth >= 4) return false;
  if (masked[open] === '{') {                      // ④ 展开形：`{ ...process.env }`
    const close = matchBrackets(masked, open);
    if (close == null || close > to) return false;
    return splitTop(masked, open + 1, close - 1).some(([a, b]) => {
      const dot = code.slice(a, b).indexOf('...');
      return dot >= 0 && isEnvSourceAt(code, masked, envObjs, a + dot + 3, b, depth + 1);
    });
  }
  if (masked.indexOf('(', from) < 0 || masked.indexOf('(', from) >= to) return false;
  const paren = masked.indexOf('(', from);
  if (!/^\s*Object\s*\.\s*assign\s*$/.test(code.slice(from, paren))) return false;   // ③ 拷贝形
  const close = matchGroup(masked, paren);
  if (close == null || close > to) return false;
  return splitTop(masked, paren + 1, close - 1)
    .some(([a, b]) => isEnvSourceAt(code, masked, envObjs, a, b, depth + 1));
}

/**
 * env 的**拷贝 / 再别名**（审计 #5）：`const e = Object.assign({}, process.env)`、
 * `const e = { ...process.env }`，以及「再别名」`const f = e` ⇒ 之后 `e.KEY` / `e['KEY']` 都是真读站点。
 * 两条边界：① 解构成员绑的是**值**不是 env 对象（`const { A } = process.env` 里的 `A` 由
 * `scanDestructureReads` 收成读站点，不许在这里变成「A 是 env 对象」）；② `x.y = Object.assign(…)`
 * 这种「成员位当目标」认不出 ⇒ 那次的整表拷贝由 `scanEnvCopyReads` fail closed，不静默。
 * 别名可以套别名 ⇒ 迭代到不动点。
 * @returns {string[]} 新增的 env 对象别名（同时就地写进 `envObjs`）
 */
function envCopyAliases(code, masked, envObjs) {
  const added = [];
  // 「`{…} =`」= 解构模式的括号对：里面的标识符是**被解构出来的值**，不是 env 对象
  const patterns = [];
  for (const [o, c] of bracketPairs(masked)) {
    if (masked[o] !== '{') continue;
    const eq = nextNonSpace(masked, c);
    const ok = eq != null && masked[eq] === '=' && !'=><'.includes(masked[eq + 1] ?? '');
    if (ok) patterns.push([o, c]);
  }
  const inPattern = (idx) => patterns.some(([o, c]) => idx > o && idx < c);
  const re = new RegExp(`(?<![\\w$.])(${IDENT_RE})\\s*=(?![=>])`, 'g');
  for (let pass = 0; pass < 4; pass += 1) {
    const before = added.length;
    for (const m of code.matchAll(re)) {
      const id = m[1];
      if (envObjs.has(id) || inPattern(m.index)) continue;
      if (masked[m.index] === ' ' && code[m.index] !== ' ') continue;   // 串正文里的「x = …」不是代码
      const from = nextNonSpace(masked, m.index + m[0].length);
      if (from == null) continue;
      const to = exprEndAt(masked, from);
      if (!isEnvSourceAt(code, masked, envObjs, from, to)) continue;
      if (ENV_OBJECT_TEXT.test(code.slice(from, to).replace(/\s+/g, ''))) continue;  // 直形旧正则已收
      envObjs.add(id);
      added.push(id);
    }
    if (added.length === before) break;
  }
  return added;
}

/**
 * 解构成员 → 「读了哪个名字」：`{ A }` / `{ A: alias }` / `{ 'A': v }` 是**静态名**（A 被读），
 * `{ [e]: v }` 是**计算名**（要解析），`{ ...rest }` 与认不出的成员一律记成「解析不出」⇒ fail closed。
 */
function destructMember(code, masked, from, to) {
  const seg = code.slice(from, to);
  const start = from + (seg.length - seg.trimStart().length);
  const text = seg.trim();
  if (text.startsWith('...')) return { kind: 'rest', start };
  if (masked[start] === '[') {
    const close = matchBrackets(masked, start);
    const inner = close == null ? null : firstNonSpaceIn(masked, start + 1, close - 1);
    if (inner == null) return { kind: 'rest', start };
    return { kind: 'computed', start, exprStart: inner, exprEnd: close - 1 };
  }
  const m = /^(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$]*))/.exec(text);
  return m ? { kind: 'static', name: m[1] ?? m[2], start } : { kind: 'rest', start };
}

/**
 * 形⑥ `Reflect.get(env, 'KEY')` / `Reflect.has(env, 'KEY')`（审计 #6）：成员名在**第二个实参**上。
 * 解析得出（字面量 / 已知名 / `TABLE[...]`）⇒ 读站点；解析不出（`Reflect.get(env, name)`）⇒ unsupported。
 * 第一个实参不是 env 对象（`Reflect.get(other, 'ERIX_X')`）⇒ 与这把闸门**无关**，不许进 unsupported。
 */
function scanReflectReads(code, masked, ctx, sink) {
  const re = new RegExp(`(?<![\\w$.])Reflect\\s*\\.\\s*(${IDENT_RE})\\s*\\(`, 'g');
  for (const m of code.matchAll(re)) {
    if (!REFLECT_READ_OPS.has(m[1])) continue;                                  // `Reflect.set` 是写
    if (!isCodePosition(code, masked, m.index, m[0].length)) continue;           // 串/正则正文
    const open = m.index + m[0].length - 1;
    const close = matchGroup(masked, open);
    if (close == null) continue;
    const args = splitTop(masked, open + 1, close - 1);
    if (args.length === 0) continue;
    if (!isEnvSourceAt(code, masked, ctx.envObjs, args[0][0], args[0][1])) continue;
    const line = sink.lineOf(m.index);
    const shape = code.slice(m.index, close).replace(/\s+/g, ' ').trim();
    if (args.length < 2) { sink.fail(line, shape, ''); continue; }               // 连名字位都没有
    const [ka, kb] = args[1];
    const expr = code.slice(ka, kb).trim();
    const lit = resolveExpr(expr, ctx, firstNonSpaceIn(masked, ka, kb) ?? ka);
    if (lit) { for (const n of lit) sink.add(n, line, `reflect:${m[1]}`); continue; }
    sink.fail(line, shape, expr);
  }
}

/**
 * 形⑦ 解构（审计 #7）：`const { KEY } = process.env` / `const { KEY: alias } = process?.env`
 * / `const { [K_ENV]: v } = env`（别名与表驱动同权）。计算名解析不出 ⇒ unsupported；
 * `...rest` 一次取走**剩下全部**名字 ⇒ 也 unsupported（它没有静态 key，静默就是第二个假绿）。
 * RHS 不是 env 对象（`const { a } = other`）⇒ 与这把闸门无关，整条形都不许进。
 */
function scanDestructureReads(code, masked, ctx, sink) {
  const re = /\b(?:const|let|var)\s*\{/g;
  for (const m of code.matchAll(re)) {
    if (!isCodePosition(code, masked, m.index, m[0].length)) continue;
    const brace = m.index + m[0].length - 1;
    const close = matchBrackets(masked, brace);
    if (close == null) continue;
    const eq = nextNonSpace(masked, close);
    if (eq == null || masked[eq] !== '=' || '=><'.includes(masked[eq + 1] ?? '')) continue;
    const rhs = nextNonSpace(masked, eq + 1);
    if (rhs == null) continue;
    const rhsEnd = exprEndAt(masked, rhs);
    if (!isEnvSourceAt(code, masked, ctx.envObjs, rhs, rhsEnd)) continue;
    sink.consumed.add(rhs);                 // 这条拷贝形已按成员逐条记账 ⇒ 别再算成整表拷贝
    const pattern = code.slice(brace, rhsEnd).replace(/\s+/g, ' ').trim();
    for (const [a, b] of splitTop(masked, brace + 1, close - 1)) {
      const mem = destructMember(code, masked, a, b);
      const line = sink.lineOf(mem.start);
      if (mem.kind === 'static') { sink.add(mem.name, line, 'destructure'); continue; }
      if (mem.kind === 'computed') {
        const expr = code.slice(mem.exprStart, mem.exprEnd).trim();
        const lit = resolveExpr(expr, ctx, mem.exprStart);
        if (lit) { for (const n of lit) sink.add(n, line, `destructure:[${expr}]`); continue; }
        sink.fail(line, pattern, expr);
        continue;
      }
      sink.fail(line, pattern, code.slice(mem.start, b).trim());      // `...rest` / 认不出的成员
    }
  }
}

/**
 * 形⑧ **fail-closed 兜底**（本步的灵魂）：认得出「在 env 上取名字」却永远给不出静态 key 的形 ⇒
 * `unsupported`。三形：① `Object.assign(…, env, …)` / `{ …env }` 的整表拷贝而结果**没**被绑成 env
 * 别名（`Object.assign(cfg, process.env)`：之后谁读 `cfg.KEY` 静态看不出来）；
 * ② `Object.keys|values|entries(env)`；③ `for (const k in env)`。
 * 负例（一条都不许进）：`Object.assign(a, b)`、`Object.keys(other)`、`for (const k in other)`、
 * 以及**已绑成别名**的拷贝（那条形由点号/下标读形逐条记账，再报一次就是双记）。
 */
function scanEnvCopyReads(code, masked, ctx, sink) {
  const envObjs = ctx.envObjs;
  // 没有展开位就没有对象字面量拷贝可查 ⇒ 不为这一形白跑一趟括号配对（全仓每文件一次）
  const pairs = masked.includes('...') ? bracketPairs(masked) : new Map();
  /** `X = <拷贝形>` 且 `X` 已经是 env 对象别名 ⇒ 这条拷贝已被别名跟踪。 */
  const boundToAlias = (from) => {
    let i = from - 1;
    while (i >= 0 && /\s/.test(masked[i])) i -= 1;
    if (i < 0 || masked[i] !== '=' || '=!<>'.includes(masked[i - 1] ?? '')) return false;
    let j = i - 1;
    while (j >= 0 && /\s/.test(masked[j])) j -= 1;
    const end = j + 1;
    while (j >= 0 && /[\w$]/.test(masked[j])) j -= 1;
    const id = masked.slice(j + 1, end);
    return id !== '' && envObjs.has(id);
  };
  /** 那个 `{` 处在**对象字面量**位吗（`=` `(` `[` `,` `:` `;` `{` 之后，或 `return` 之后）。 */
  const objectLiteralAt = (i) => {
    let p = i - 1;
    while (p >= 0 && /\s/.test(masked[p])) p -= 1;
    if (p < 0) return false;
    if ('=([{,:;'.includes(masked[p])) return true;
    return /\breturn$/.test(code.slice(Math.max(0, p - 8), p + 1));
  };
  const report = (from, to, at = from) => sink.fail(sink.lineOf(at),
    code.slice(from, to).replace(/\s+/g, ' ').trim(), '');
  // ① `Object.assign` 与 ② `Object.keys|values|entries`
  for (const m of code.matchAll(/(?<![\w$.])Object\s*\.\s*(assign|keys|values|entries)\s*\(/g)) {
    if (!isCodePosition(code, masked, m.index, m[0].length)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchGroup(masked, open);
    if (close == null) continue;
    const args = splitTop(masked, open + 1, close - 1);
    if (!args.some(([a, b]) => isEnvSourceAt(code, masked, envObjs, a, b))) continue;
    if (m[1] !== 'assign' && !ENV_ENUM_OPS.has(m[1])) continue;      // 只认三枚举形 + assign
    if (m[1] === 'assign' && (boundToAlias(m.index) || sink.consumed.has(m.index))) continue;
    report(m.index, close);
  }
  // ①b 展开形 `{ …process.env }`：从**展开位**反查它所在的那个对象字面量（比逐个 `{` 配平便宜）
  const seenLiteral = new Set();
  for (const m of masked.matchAll(/\.\.\./g)) {
    const wrap = enclosingPairs(masked, pairs, m.index).find((w) => w.kind === '{');
    if (!wrap || !objectLiteralAt(wrap.open) || seenLiteral.has(wrap.open)) continue;
    const operand = nextNonSpace(masked, m.index + 3);
    if (operand == null) continue;
    const segEnd = firstTopChar(masked, operand, wrap.close, (c) => c === ',');
    const to = segEnd < 0 ? wrap.close - 1 : segEnd;
    if (!isEnvSourceAt(code, masked, envObjs, operand, to, 2)) continue;
    seenLiteral.add(wrap.open);
    if (boundToAlias(wrap.open) || sink.consumed.has(wrap.open)) continue;
    // 坐标指到**展开位**那一行（对象字面量可能跨好几行；指到开括号行会让人找不到是哪一份拷贝）
    report(wrap.open, wrap.close, m.index);
  }
  // ③ `for (const k in process.env)`
  const forIn = /\bfor\s*\(\s*(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s+in\s+/g;
  for (const m of code.matchAll(forIn)) {
    if (!isCodePosition(code, masked, m.index, m[0].length)) continue;
    const from = m.index + m[0].length;
    const rp = masked.indexOf(')', from);
    if (rp < 0) continue;
    if (!isEnvSourceAt(code, masked, envObjs, nextNonSpace(masked, from) ?? from, rp)) continue;
    report(m.index, rp + 1);
  }
}

/**
 * 建「这个名字能解析出哪些 env 名」的表 + **词法作用域遮蔽表**。**必须按形状分优先级多趟建**，因为绑定会互相引用
 * （`{ key = TOOLCALL_MARKERS_ENV }` 里的 `key` 依赖常量表，`const envName = LLM_TIMEOUT_ENV[field]`
 * 里的 `envName` 依赖数据表）：先收字面量与数据表，再收「别名 = 已知名」与「别名 = 已知名[...]」，
 * 最后迭代到不动点。解析不出的名字**不在表里**（调用方据此判 unsupported，不许静默放过）。
 *
 * `names` 是**文件级**的（同名只有一本账），所以另发一张 `shadows`：参数位与块内重绑定各占一段区间，
 * 读取点落在区间里就用区间里那份绑定（#587 族 A⑤：`function f(SHADOWED_ENV, env)` 里 `env[SHADOWED_ENV]`
 * 读的是**参数**，不是顶层那个 `const SHADOWED_ENV = 'ERIX_X'` —— 旧扫描器把动态 key **错记**成那个静态名，
 * 于是枚举里凭空多出一个没人读的 key，而真的动态读没进 `unsupported`（fail-closed 被绕过）。
 * @returns {{ envObjs: Set<string>, names: Map<string, Set<string>>, shadows: Map<string, Array> }}
 */
function analyzeEnvReads(code, rawText = null) {
  // 掩码**从原文算**（#587 族 B 实测：`structuralMask(stripComments(x))` 与 `structuralMask(x)` 不等价 —
  // 模板里嵌模板那种行会让两者在其后分叉，把**真代码**整行抹成「串正文」= 又一处静默漏扫）。
  // `code` 仍必须是剥过注释的那一份：所有**内容匹配**都在它上面跑（env 名活在串正文里）。
  const masked = structuralMask(rawText ?? code);
  const envObjs = new Set();
  const names = new Map();
  const addName = (id, lits) => {
    if (!/^[A-Za-z_$]/.test(id)) return;
    if (!names.has(id)) names.set(id, new Set());
    for (const l of lits) names.get(id).add(l);
  };
  // env 对象别名：`env = process.env`（参数默认值或 `const env = process.env`，两种写法同一条正则）。
  // `env = process?.env` 同样是别名（#587 族 A③）：不认就把它的读形整条扫不到 = 静默。
  // 但 `x = process?.env?.ERIX_X` 取的是**值**而不是 env 对象 ⇒ 后面紧跟 `?.` 的那一种要排掉。
  for (const m of code.matchAll(new RegExp(`(${IDENT_RE})\\s*=\\s*process\\s*\\??\\.\\s*env(?!\\?\\.)(?!\\.)(?!\\s*=[^=])`, 'g'))) envObjs.add(m[1]);
  // env 的**拷贝别名**（#587 第 2 步①，审计 #5）：`const e = Object.assign({}, process.env)` 与
  // `const e = { ...process.env }` 也得进 `envObjs` —— 不认，之后 `e.ERIX_X` 既不进 keys 也不进
  // unsupported = 静默漏过（审计当时的读数就是两个空集合）。
  for (const id of envCopyAliases(code, masked, envObjs)) envObjs.add(id);

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

  // ⑤ **作用域遮蔽**（#587 族 A⑤）：参数位与块内重绑定各自占一段区间，区间里的读取不许再用外层同名常量。
  //    `litsOf` 与 `resolveExpr` 同口径（字面量 / 已知名 / `TABLE[...]`），解析不出 ⇒ `null` = 动态。
  const pairs = bracketPairs(masked);
  const scopes = braceScopes(masked, pairs);
  const litsOf = (exprText) => {
    if (typeof exprText !== 'string' || exprText.trim() === '') return null;
    const lit = /^\s*['"]([^'"]+)['"]\s*$/.exec(exprText);
    if (lit) return new Set([lit[1]]);
    const id = new RegExp(`^\\s*(${IDENT_RE})\\s*$`).exec(exprText);
    if (id && names.get(id[1])?.size) return new Set(names.get(id[1]));
    const tbl = new RegExp(`^\\s*(${IDENT_RE})\\s*\\[[\\s\\S]*\\]\\s*$`).exec(exprText);
    if (tbl && names.get(tbl[1])?.size) return new Set(names.get(tbl[1]));
    return null;
  };
  const shadowList = [];
  // ⑤a 参数遮蔽（含箭头函数、解构参数、`{ key = KNOWN }` 那种带默认值的参数）
  shadowList.push(...collectParamBindings(code, masked, pairs, scopes, litsOf));
  // ⑤b 块内 `const`/`let`/`var` 重绑定：顶层那些归 `names` 管（不算遮蔽），**块内**的才算遮蔽
  const DECL_RE = new RegExp(`\\b(?:const|let|var)\\s+(${IDENT_RE})\\s*(?:=([^;\\n]*))?`, 'g');
  for (const m of code.matchAll(DECL_RE)) {
    if (masked[m.index] === ' ' && code[m.index] !== ' ') continue;   // 串正文里的「const …」不算声明
    const scope = scopes(m.index);
    if (scope.whole) continue;
    shadowList.push({ name: m[1], start: m.index, end: scope.end, lits: litsOf(m[2]) });
  }
  const shadows = new Map();
  for (const s of shadowList) {
    if (!shadows.has(s.name)) shadows.set(s.name, []);
    shadows.get(s.name).push(s);
  }
  return { envObjs, names, shadows };
}

/**
 * 下标表达式 → 名字集合；`null` = 解析不出字面量名（调用方必须进 unsupported 清单，不许静默放过）。
 * `at` = 表达式在**本篇代码**里的偏移 ⇒ 先查词法作用域遮蔽（#587 族 A⑤：被参数/块内声明遮蔽的名字，
 * 外层那张文件级表**不再算数**；解析不出就 `null`，由调用方 fail loudly，**不许错记**）。
 */
function resolveExpr(expr, ctx, at = 0) {
  const lit = /^\s*['"]([^'"]+)['"]\s*$/.exec(expr);
  if (lit) return new Set([lit[1]]);
  const id = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(expr);
  if (id) {
    const sh = shadowAt(ctx.shadows, id[1], at);
    if (sh.hit) return sh.lits ? new Set(sh.lits) : null;
    return ctx.names.has(id[1]) ? new Set(ctx.names.get(id[1])) : null;
  }
  const tbl = /^\s*([A-Za-z_$][\w$]*)\s*\[[\s\S]*\]\s*$/.exec(expr); // `T[field]` 直接写在读形里
  if (tbl) {
    const sh = shadowAt(ctx.shadows, tbl[1], at);
    const lits = sh.hit ? sh.lits : (ctx.names.get(tbl[1]) ?? null);
    return lits && lits.size > 0 ? new Set(lits) : null;
  }
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
    const masked = structuralMask(text);         // 原文的「结构掩码」⇒ 判「这个位置是不是串/正则正文」用**原文**那份
    const ctx = analyzeEnvReads(code, text);
    // env **对象**那一跳也可能带可选链（`process?.env?.X`，#587 族 A③）⇒ 前缀写成 `process\s*\??\.\s*env`。
    const objs = ['process\\s*\\??\\.\\s*env', ...[...ctx.envObjs].map(escRe)];
    const OBJ = `(?:${objs.join('|')})`;
    // 读形：`对象 . 名字` 或 `对象 [ 表达式 ]`。**成员那一跳的可选链必须单独认**：点号那支写成
    // `(?:\?\.|\.)` 而不是 `(?:\?\.)?\.` —— `process.env?.X` 里 `?.` 之后**没有**第二个点，旧写法两支都不匹配
    // ⇒ 整形扫不到（#587 族 A③：扫不到 = 静默漏过，等于这道闸门对这个旋钮不存在）。
    // 前视 `(?<![\w$.])` 挡住 `childEnv.X` / `foo?.BAR` 这类「别的对象也叫 env 结尾」的假别名。
    const readRe = new RegExp(
      `(?<![\\w$.])${OBJ}(?:\\?\\.|\\.)\\s*(${IDENT_RE})`
      + `|(?<![\\w$.])${OBJ}(?:\\?\\.)?\\s*\\[\\s*([^\\]\\n]*?)\\s*\\]`, 'g');
    // 写形态整段抹成空格（`process.env.X = v` 是给子进程传值，不是「这个 env 名有配置面」）；
    // 只抹「对象 + 成员 + 等号」这一段，赋值**右侧**照旧参与匹配。
    // 整个「对象+成员」段必须**包在一个分组里**再尾随 `=`：否则 `|` 会把 `\s*=` 只挂到第二支上，
    // 第一支（点号读形）就变成「凡点号读形都抹掉」= 读形自己把自己抹了。
    const writeRe = new RegExp(
      `((?<![\\w$.])${OBJ}(?:\\?\\.|\\.)\\s*${IDENT_RE}|(?<![\\w$.])${OBJ}(?:\\?\\.)?\\s*\\[[^\\]]*\\])\\s*=(?!=)`, 'g');
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
      // 表达式在**本篇代码**里的偏移：从 `[` 之后第一个非空白起算。遮蔽表按偏移开区间记账，
      // 不传这个数就等于**永远查不到遮蔽**（#587 族 A⑤ 的机件会退化成死代码，而闸门照样全绿）。
      const lb = m[0].indexOf('[');
      const after = lb < 0 ? '' : m[0].slice(lb + 1);
      const at = lb < 0 ? m.index : m.index + lb + 1 + (after.length - after.replace(/^\s+/, '').length);
      const lit = resolveExpr(expr, ctx, at);
      if (lit) { for (const n of lit) add(n, rel, line, `index:${expr.trim()}`); continue; }
      // 读形认得、名字解析不出（运行期拼名那类）⇒ **fail closed**：进 unsupported 清单，
      // 必须逐条登记进 `deploy/env-legs-exceptions.json` 的 `unsupported` 段并写理由，否则判据红。
      unsupported.push({ at: `${rel}:${line}`, shape: m[0].trim(), expr: expr.trim() });
    }
    // 三种「成员名不在点号/下标位置上」的取名字形（#587 第 2 步，审计 #5/#6/#7）+ fail-closed 兜底。
    // 同一个 sink ⇒ 同一个 `keys` / `unsupported`，**不弄第二本账**；`consumed` 用来告知兜底尺
    // 「这条整表拷贝已按成员/别名逐条记过账」，免得同一行双记。
    // 行号用 `lineAt()`（上面那个 `lineUpTo` 是**单调**状态机，新形的偏移不保证递增）。
    const sink = {
      consumed: new Set(),
      lineOf: (idx) => lineAt(code, idx),
      add: (name, ln, shape) => add(name, rel, ln, shape),
      fail: (ln, shapeText, exprText) => unsupported.push({
        at: `${rel}:${ln}`, shape: shapeText, expr: exprText,
      }),
    };
    scanReflectReads(code, masked, ctx, sink);
    scanDestructureReads(code, masked, ctx, sink);
    scanEnvCopyReads(code, masked, ctx, sink);
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

/**
 * #587 折中方案第 1 步：**key 关联的站点索引**（issue #587 的分析报告 §2.2「结构白名单」的地基）。
 *
 * 闸门现在的事实是「这一行**看起来**提到 key」（`whereProblems()` → `lineMentionsKey()` 的文本启发式），
 * 而它手上其实有**结构事实**：`scanEnvReadsFromFiles()` 产出的读站点 `keys`。
 * 本函数只做一件事：把那份产出**改成可查的形状**——**不重扫、不再写一套解析**
 * （第二套遍历/正则 = 第二本账，正是 #557/#587 反复付账的形状）。所以：
 *   · 站点集合与 `scanEnvReads(root).keys` **一字不差**（「影子①」拿双向集合相等钉住这一点）；
 *   · 索引里**不会**出现扫描器没登记的站点 ⇒ 日志模板 / 数据对象的 `reason` / 注释都进不来。
 *
 * 形状（`Map` 三层，键都是**扫描器给的原值**，不做任何加工）：
 *   `readSites`   `Map(key → Map(rel → Map(line → [shape, ...])))`
 *     —— 三层里最后那层是**数组**：同一行读两次（`env.A || env.A`）留两条，不许折叠成一条。
 *   `injections`  同形状，**第 3 步的位置**（见下面 `addInjectionSite` 的注释），现在恒空。
 *
 * 能回答的问题（`siteIndexProblems()` 只用这几个口子，别的都不认）：
 *   `hasReadSite(key, rel, line)` 这个坐标**是不是**该 key 的读站点（行级）
 *   `hasReadInFile(key, rel)`     该 key 在这个文件里有没有读站点（文件级引用）
 *   `sitesOf(key)` / `linesOf(key, rel)` / `filesOf(key)`  取证用（报错文案要能指着真站点改）
 * @param {string} root 扫描根（仓库根 ⇒ `rel` 与例外清单的 `where` 同一个口径）
 */
function buildEnvSiteIndex(root, opts = {}) {
  const { keys, unsupported } = scanEnvReads(root, opts);
  const readSites = new Map();
  const bucketOf = (store, key, rel) => {
    if (!store.has(key)) store.set(key, new Map());
    const perFile = store.get(key);
    if (!perFile.has(rel)) perFile.set(rel, new Map());
    return perFile.get(rel);
  };
  for (const [key, perFile] of keys) {
    for (const [rel, list] of perFile) {
      for (const site of list) {
        const byLine = bucketOf(readSites, key, rel);
        if (!byLine.has(site.line)) byLine.set(site.line, []);
        byLine.get(site.line).push(site.shape);      // 同一行多次读 ⇒ 一条一个 shape，不许折叠
      }
    }
  }
  /**
   * **第 3 步往这里加**（#587 折中方案，分析报告 §2.2 的 `kind = injection`）：
   *   只从 `portal/src/provisioner.js` 的 `buildContainerConfig()` 里 Docker `body.Env` **数组元素**
   *   与 `body.Env.push()` 产出站点（审计当时的读数是 `:224-253` 与 `:277`，行号会漂，要现跑取），
   *   `:410`（`ensureFdeContainer()` 传进来的 `env`）只有在证明它流入 `body.Env` 之后才算来源。
   *   登记方式：`index.addInjectionSite(key, rel, line)`；`hasSite()` 会同时认两类站点，
   *   所以**判定结构不用再改**——第 3 步只填这张表。日志里的 `` `KEY=${v}` `` 不是注入站点：
   *   它进不了 `body.Env`，因此第 3 步也不会进这张表（「影子②」钉的就是这个形状）。
   */
  const injections = new Map();
  let hostSourcesDerived = null;
  /**
   * **第三张表：portal/宿主侧的 helper 间接读站点**（MED②）。与 `injections` 的差别：它不是「留好的
   * 空槽」，而是 `deriveHostSourceSites()` 从扫描器自己的 `unsupported` + 调用点字符串实参**推出来**的
   * （坐标不手抄）。故意**不**进 `hasSite()` —— 影子的口径是「runner 读站点」，portal 侧那条读是
   * **另一个来源**；把它当读站点放行 = 把 MED② 的误杀抹平后谎称两边口径已经一致（第 4 步要的是
   * 「分类清楚」，不是「读数好看」）。它存在的意义：`shadowGapSemantic()` 的 `host-source` 判据有事实可问。
   */
  const hostSources = new Map();
  const shapesAt = (store, key, rel, line) => store.get(key)?.get(rel)?.get(line) ?? null;
  const linesOf = (store, key, rel) => {
    const byLine = store.get(key)?.get(rel);
    return byLine ? [...byLine.keys()].sort((a, b) => a - b) : [];
  };
  const dumpOf = (store, key) => {
    const out = [];
    for (const [rel, byLine] of store.get(key) ?? []) {
      for (const [line, shapes] of byLine) {
        for (const shape of shapes) out.push({ rel, line, shape });
      }
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
  };
  return {
    root,
    keys,                       // 扫描器原样产出（「影子①」据此核对索引没加工）
    unsupported,                // 同上：动态读形留给第 2 步做 provenance，本步只透传
    readSites,
    injections,
    /** 【第 3 步的入口】登记一个注入站点；现在没人调 ⇒ `injections` 恒空。 */
    addInjectionSite(key, rel, line, shape = 'body.Env') {
      const byLine = bucketOf(injections, key, rel);
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line).push(shape);
      return this;
    },
    /** 登记一个 **host-source** 站点（MED②）；`meta` 是推导过程的事实（helper 坐标等），报错时要能指着。 */
    addHostSourceSite(key, rel, line, meta = {}) {
      const byLine = bucketOf(hostSources, key, rel);
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line).push(meta);
      return this;
    },
    /**
     * 【MED② 的入口】**由代码推出** helper 间接读站点并登记（幂等：按 root 缓存，只推一次）。
     * 调它不是为了把影子洗绿（那些坐标仍然判红），而是为了让差异分类能回答「这条红到底是什么来源」。
     */
    deriveHostSourceSites() {
      if (hostSourcesDerived === null) {
        hostSourcesDerived = deriveHostSourceSites(root, unsupported);
        for (const s of hostSourcesDerived) this.addHostSourceSite(s.key, s.rel, s.line, s);
      }
      return hostSourcesDerived;
    },
    hostSources,
    /** 该 key 的全部 host-source 站点 `[{rel, line, …推导事实}]`。 */
    hostSourceSitesOf: (key) => {
      const out = [];
      for (const [rel, byLine] of hostSources.get(key) ?? []) {
        for (const [line, metas] of byLine) {
          for (const meta of metas) out.push({ rel, line, ...meta });
        }
      }
      return out.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
    },
    hasHostSourceSite: (key, rel, line) => shapesAt(hostSources, key, rel, line) !== null,
    /** 该 key 的全部读站点 `[{rel, line, shape}]`（报错文案与「影子①」的取证都读它）。 */
    sitesOf: (key) => dumpOf(readSites, key),
    injectionSitesOf: (key) => dumpOf(injections, key),
    linesOf: (key, rel) => linesOf(readSites, key, rel),
    injectionLinesOf: (key, rel) => linesOf(injections, key, rel),
    filesOf: (key) => [...(readSites.get(key)?.keys() ?? [])].sort(),
    hasReadSite: (key, rel, line) => shapesAt(readSites, key, rel, line) !== null,
    hasInjectionSite: (key, rel, line) => shapesAt(injections, key, rel, line) !== null,
    hasReadInFile: (key, rel) => readSites.get(key)?.has(rel) === true,
    hasInjectionInFile: (key, rel) => injections.get(key)?.has(rel) === true,
    /** 第 4 步的判定入口：读站点**或**注入站点都算结构证据（现在等价于只有读站点）。
     *  ⚠ 这一支带行号是**判据的牙**：去掉 line（只剩文件级）就是变异 M-2 的靶子。 */
    hasSite: (key, rel, line) => shapesAt(readSites, key, rel, line) !== null
      || shapesAt(injections, key, rel, line) !== null,   // ← M-2 变异点：索引去掉行号
    hasSiteInFile: (key, rel) => readSites.get(key)?.has(rel) === true
      || injections.get(key)?.has(rel) === true,
    keyCount: () => keys.size,
    siteCount: () => [...keys.values()].reduce((n, perFile) => n
      + [...perFile.values()].reduce((m, list) => m + list.length, 0), 0),
  };
}

/** 真树的站点索引（影子对照用；建一次 ~2s，别在每格里重扫）。 */
const REPO_SITE_INDEX = buildEnvSiteIndex(REPO_ROOT);

/**
 * 例外清单：读 + 判**理由字段** + 现跑咬合。返回 `{ entries, unsupported, problems }`。
 * `unsupported` 的核对**必须带扫描器现在的结果**（族 B②：登记要绑定到真读站点，不许自由散文）。
 */
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
    problems: [...validateEntries(entries), ...validateUnsupported(unsupported, REPO_ROOT, RUNNER_SCAN.unsupported)],
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

// ===========================================================================
// 族 B（issue #587）：**可核对坐标**的唯一一把尺
//
// `where`、`unsupported[].at`、以及 `unsupported[].reason` 里引用的坐标**全部走这里**，
// 否则「理由里的引用」与「坐标字段」会分叉成两本账（族 B②要的正是「同一个引用换个位置写也得住」）。
// ===========================================================================

/**
 * 坐标引用形状。**故意**比「合法坐标」更宽：认 `.json`/绝对路径/行范围。
 * 写歪了要能点名并给出**能照着改**的文案，而不是「一个引用都没扫到」再报一句「这是说明文字」。
 * 后缀后面钉 `(?![A-Za-z0-9_])`：否则 `env-legs-exceptions.json` 会被匹配成 `env-legs-exceptions.js`
 * （前缀巧合），报出「文件不存在」这种**看着合理但不对**的文案。
 * —— 那句话对 `deploy/env-legs-exceptions.json:12` 是误导（它当然是坐标，只是不是 JS 坐标）。
 */
const COORD_REF = /(?<abs>\/)?(?<path>[A-Za-z0-9_.+-]+(?:\/[A-Za-z0-9_.+-]+)*)\.(?<ext>js|mjs|cjs|json|ya?ml|yml|md|ts|sh|lock|env)(?![A-Za-z0-9_])(?::\s*(?<from>\d+)(?:\s*-\s*(?<to>\d+))?)?/g;
/** 可核对的代码坐标只认 JS 源文件（`.json`/`.yml` 是**数据**，判据不替它核对内容）。 */
const JS_SOURCE_EXT = new Set(['js', 'mjs', 'cjs']);
/** 测试面（族 B①.1）：这些目录里的 env 名字多半是**断言字符串**，不是「产品代码在这儿读了它」。 */
const TEST_FACE_DIRS = new Set(['test', 'tests', '__tests__', 'node_modules', 'fixtures', 'probes', 'integration']);

/** `portal/test/provisioner.test.js`、`test/lib/js-source.mjs`、`**\/*.test.js` ⇒ 测试面。 */
function isTestFace(rel) {
  const segs = String(rel ?? '').split('/');
  const base = segs[segs.length - 1] ?? '';
  // #587 族 B 返工①：旧口径只认 `.test.js`，`.spec.mjs` / `.spec.ts` 这类**测试面漏网**
  // （审计实测：`x.spec.mjs` 里的裸串坐标被当成有效坐标）。
  return segs.some((s) => TEST_FACE_DIRS.has(s)) || /\.(test|spec)\.[cm]?[jt]s$/.test(base);
}

/** 从一段文本里取坐标引用（`where`、`unsupported.reason` 共用）。 */
function parseCoordRefs(text) {
  return [...String(text ?? '').matchAll(COORD_REF)].map((m) => ({
    raw: m[0],
    abs: m.groups.abs === '/',
    ext: m.groups.ext,
    rel: `${m.groups.path}.${m.groups.ext}`,
    from: m.groups.from ? Number(m.groups.from) : null,
    to: m.groups.to ? Number(m.groups.to) : null,
    // #587 族 B 返工③：行号从 1 起；`:10-`（缺右端点）在正则里被当成 `:10` 静默接受 ⇒ 显式标坏。
    // ⚠ 那个 `-` **不在** `m[0]` 里（COORD_REF 只吃到 `:10`）⇒ 必须看匹配**之后**的文本。
    badRange: /^\s*-/.test(String(text ?? '').slice(m.index + m[0].length))
      || (m.groups.from != null && Number(m.groups.from) < 1)
      || (m.groups.to != null && Number(m.groups.to) < 1),
  }));
}

function splitCoord(at) {
  const m = /^(.*):(\d+)$/.exec(String(at ?? '').trim());
  return m ? { rel: m[1], line: Number(m[2]) } : { rel: String(at ?? '').trim(), line: null };
}

const normRead = (t) => String(t ?? '').replace(/\s+/g, '');

/** 第 `n` 行（1 起）在文本里的 `[start, end)`；没有那一行 ⇒ null。 */
function lineRange(text, n) {
  let start = 0;
  for (let i = 1; i < n; i += 1) {
    const nl = text.indexOf('\n', start);
    if (nl < 0) return null;
    start = nl + 1;
  }
  const nl = text.indexOf('\n', start);
  return [start, nl < 0 ? text.length : nl];
}

/** `code`（已剥注释）与 `masked`（再把串/正则正文抹平）**不相等**的位置 = 串正文/正则正文 ⇒ 不是代码位。 */
function isCodePosition(code, masked, start, len) {
  for (let i = start; i < start + len; i += 1) {
    if (i >= code.length || masked[i] !== code[i]) return false;
  }
  return true;
}

/** 包住 `pos` 的那段**被抹平的正文**（从 `code` 取原文）；`pos` 自己在代码位 ⇒ null。 */
function maskedBodyAround(code, masked, pos) {
  const blank = (i) => i >= 0 && i < code.length && code[i] !== '\n' && masked[i] === ' ';
  if (!blank(pos) || code[pos] === ' ') return null;
  let a = pos;
  let b = pos;
  while (blank(a - 1)) a -= 1;
  while (blank(b + 1)) b += 1;
  return code.slice(a, b + 1);
}

/**
 * `key` 在 `code[start, end)` 里有没有**结构性**出现（族 B①.2「字符串正文不算坐标」的可执行口径）：
 *   ① 代码位：`process.env.KEY` / `env.KEY` / 裸标识符 `KEY`；
 *   ② 字符串正文**就是这个 env 名**：`{ a: 'KEY' }` 数据表、`'KEY'` 白名单成员、`key = 'KEY'` 默认值；
 *   ③ 串正文是**注入形** `KEY=…`：provisioner 的 `` `ERIX_X=${v}` ``。
 * 反例（都不算坐标）：散文串里顺带提到（`'KEY 已经接好'`）、注释正文、正则正文。
 * 为什么 ②③ 必须放过：真读取坐标里 env 名**本来就活在串里**（数据表 / 白名单 / 注入模板），
 * 一律抹平会把 8 条真登记一起误杀 —— 那是「判据围着样本转」的反面。
 */
function mentionsKeyIn(code, masked, start, end, key, opts = {}) {
  // #587 族 B 返工①：**测试面豁免**下不许再拿「裸串恰好等于 key」当坐标——
  // 审计实测：`where` 指向 `*.spec.mjs` + 任意非空 `whereTest` 理由 ⇒ 一个只在断言串里
  // 出现的假坐标就能过。数据表那种裸串坐标（`{ a: 'ERIX_X' }`）在**非测试面**仍然放行。
  const allowBareString = opts.allowBareString !== false;
  let i = start;
  while (i < end) {
    i = code.indexOf(key, i);
    if (i < 0 || i >= end) return false;
    if (isCodePosition(code, masked, i, key.length)) return true;
    const body = maskedBodyAround(code, masked, i);
    if (body !== null) {
      const t = body.trim();
      // #587 族 B 返工②：**正则正文不算坐标**（正则不是代码）。掩码保留定界符 ⇒ 回退到
      // 被抹平区段的起点，看它的定界符：`/` ⇒ 正则，`'`/`"`/`` ` `` ⇒ 字符串（数据表那种裸串才算坐标）。
      let rs = i;
      while (rs > 0 && code[rs - 1] !== '\n' && masked[rs - 1] === ' ') rs -= 1;
      const delim = code[rs - 1];
      if (delim !== '/') {
        if (t.startsWith(`${key}=`)) return true;   // 注入形 `KEY=…` 恒算
        if (allowBareString && t === key) {
          // #587 族 B 三轮②：**对象键位**的串不是数据证据（`{'ERIX_X': 1}` 里 key 只是属性名）。
          // 只有**值位**串算（`a: 'ERIX_X'`、`['ERIX_X']`、`key = 'ERIX_X'`）⇒ 看闭引号之后的第一个非空字符。
          let re2 = i;
          while (re2 < masked.length && code[re2] !== '\n' && masked[re2] === ' ') re2 += 1;
          // 跳过**闭引号**（掩码把引号留下了，但它在串正文之外 ⇒ 停在引号上会看不见后面的 `:`）
          if (code[re2] === "'" || code[re2] === '"' || code[re2] === '`') re2 += 1;
          // #587 族 B 四轮：**计算键** `{ ['ERIX_X']: 1 }` —— 闭引号之后先跟 `]`，再才是 `:`
          while (code[re2] === ' ' || code[re2] === '\t') re2 += 1;
          if (code[re2] === ']') { re2 += 1; }
          let k = re2;
          while (k < code.length && (code[k] === ' ' || code[k] === '\t')) k += 1;
          if (code[k] !== ':') {
            // #587 族 B 四轮：**裸标量声明不算数据证据**（`const MSG = 'ERIX_X'` 只是文案）。
            // 真坐标的裸串都在**容器内**：对象值 `a: 'ERIX_X'`、数组元素 `['ERIX_X', v]`、
            // 调用实参 `intEnv(env, 'ERIX_X', 1002)` ⇒ 该行必须出现 `(`/`{`/`[`。
            // 判据看**串前面那个符号**：`:`/`(`/`[`/`,` ⇒ 容器内的值（对象值、数组元素、调用实参）；
            // `=` ⇒ 标量声明（`const MSG = 'ERIX_X'` 只是文案，不算数据证据）。
            let pv = rs - 2;   // `rs-1` 是**开引号**，要看它前面那个符号
            while (pv >= 0 && (code[pv] === ' ' || code[pv] === '\t')) pv -= 1;
            if ([':', '(', '[', ','].includes(code[pv])) return true;
            // `=` 也有一类合法：**形参默认值**（`key = 'ERIX_X'` 在参数表里）⇒ 该行前面出现过 `(`
            if (code[pv] === '=') {
              const ls2 = code.lastIndexOf('\n', pv - 1) + 1;
              return code.slice(ls2, pv).includes('(');
            }
            return false;
          }
        }
      }
    }
    i += 1;
  }
  return false;
}

/** 那一行含该 key 的字面量，或含一个能解析到它的常量名（表驱动那种真坐标必须算通过）。 */
function lineMentionsKey(code, masked, ctx, key, start, end, opts = {}) {
  if (mentionsKeyIn(code, masked, start, end, key, opts)) return true;
  for (const m of code.slice(start, end).matchAll(new RegExp(IDENT_RE, 'g'))) {
    const at = start + m.index;
    if (!isCodePosition(code, masked, at, m[0].length)) continue;   // 串正文里「长得像标识符」的文字不算名字引用
    // #587 族 B 三轮②（续）：**声明目标本身不是读取**。`const item = { 'ERIX_X': 1 }` 里 `item`
    // 会被名字表解析成那个 key，于是「对象键位」的假坐标从这条路绕回来了（父 agent 实测）。
    {
      let t2 = at + m[0].length;
      while (t2 < code.length && (code[t2] === ' ' || code[t2] === '\t')) t2 += 1;
      const isAssign = code[t2] === '=' && code[t2 + 1] !== '=' && code[t2 + 1] !== '>';
      if (isAssign) {
        let t3 = at - 1;
        while (t3 >= 0 && (code[t3] === ' ' || code[t3] === '\t')) t3 -= 1;
        const before = code.slice(Math.max(0, t3 - 5), t3 + 1);
        if (/[;{}(,]\s*(const|let|var)?$/.test(before) || /\b(const|let|var)\s*$/.test(before)) continue;
      }
    }
    const lits = resolveExpr(m[0], ctx, at);
    if (lits && lits.has(key)) return true;
  }
  return false;
}

/** 那一行有没有「某个 env 名」的结构化证据（`unsupported` 的理由引用没有 key 上下文，用这个口径）。 */
function lineHasEnvEvidence(code, masked, start, end) {
  for (const m of code.slice(start, end).matchAll(new RegExp(IDENT_RE, 'g'))) {
    if (!ENV_LITERAL.test(m[0]) || m[0].length < 5) continue;
    const at = start + m.index;
    if (isCodePosition(code, masked, at, m[0].length)) return true;
    const body = maskedBodyAround(code, masked, at);
    if (body !== null) {
      const t = body.trim();
      if (t === m[0] || t.startsWith(`${m[0]}=`)) return true;
    }
  }
  return false;
}

/** 测试面坐标的**显式豁免**（默认拒）：`whereTest: '<非空理由>'`，或 `whereTest: true` + `whereTestReason`。 */
function testFaceWaiver(e) {
  if (typeof e?.whereTest === 'string' && e.whereTest.trim() !== '') return e.whereTest.trim();
  if (e?.whereTest === true && typeof e?.whereTestReason === 'string' && e.whereTestReason.trim() !== '') {
    return e.whereTestReason.trim();
  }
  return null;
}

/**
 * 一把尺（按 root 建，带文件缓存）。`problemsFor(ref, { key, sources, tag, waiverDeclared })`：
 *   · 绝对路径 / 非 JS 后缀 / **测试面** ⇒ 红（文案要能照着改）；
 *   · 文件不存在 / 行号越界 ⇒ 红；
 *   · 给了行 ⇒ **逐行**验（行范围 `f.js:10-12` 不许静默只验首行）；
 *   · `key` 给了 ⇒ 那一行必须含该 key（①②③ 之一）或能解析到它的常量名；`key` 为 null ⇒ 只要该行有 env 名的结构化证据。
 */
function makeCoordChecker(root) {
  const cache = new Map();
  const read = (rel) => {
    if (!cache.has(rel)) {
      const raw = fs.readFileSync(path.join(root, rel), 'utf8');
      const code = stripComments(raw);
      // 族 B①.2：**坐标判定必须看 structuralMask**（串正文 + 正则正文 + 注释一起抹平）。
      // `stripComments` 只剥注释 ⇒ 「测试文件把 env 名当字符串写了 7 次」也能当坐标（#587 族 B 的复现本体）。
      // 族 B①.2：坐标判定必须看 `structuralMask`（串正文 + 正则正文 + 注释一起抹平）——
      // `stripComments` 只剥注释 ⇒「测试文件把 env 名当字符串写了 7 次」也能当坐标（#587 族 B 的复现本体）。
      // 掩码**必须从原文算**：`structuralMask(stripComments(x))` 与 `structuralMask(x)` **不等价**（实测
      // `portal/src/provisioner.js`：`:229` 那个「模板里嵌模板」的行之后两者就分叉，`:366` 整行被误抹成
      // 串正文 ⇒ 真坐标 `portal/src/provisioner.js:366` 会被判「不含该 key」）。两者都保留行列位 ⇒ 同下标可比。
      cache.set(rel, { code, masked: structuralMask(raw), ctx: analyzeEnvReads(code) });
    }
    return cache.get(rel);
  };

  return function problemsFor(ref, opts) {
    const { key, sources, tag, waiverDeclared = false } = opts;
    const problems = [];
    const range = ref.from == null ? '' : `:${ref.from}${ref.to != null && ref.to !== ref.from ? `-${ref.to}` : ''}`;
    const shown = `${ref.rel}${range}`;
    if (ref.badRange) {
      problems.push(`${tag} 的行范围\`${ref.raw}\`**语法不合法**：行号从 1 起，右端点不许省（\`:10-\` 要写成 \`:10-10\` 或直接 \`:10\`）⇒ 旧口径把 \`:10-\` 当成 \`:10\` 静默接受，等于放过一个写坏了的坐标`);
      return problems;
    }
    if (ref.abs) {
      problems.push(`${tag} 是**绝对路径**（\`${ref.raw}\`）⇒ 坐标必须是**仓库根相对**路径，改成 \`${ref.rel}${range}\` 这种写法`
        + '（判据要在别人的机器、CI 的临时目录里也能跑；绝对路径把机器写进了登记）');
      return problems;
    }
    if (!JS_SOURCE_EXT.has(ref.ext)) {
      problems.push(`${tag}（\`${ref.raw}\`）不是 JS 源文件 ⇒ 判据只核对 \`.js\`/\`.mjs\`/\`.cjs\` 的行内容`
        + `（\`.${ref.ext}\` 是数据/文档，它的行号会随格式化漂移）。把这条事实写进 \`reason\`，`
        + `\`where\` 改成真正读这个 env 的那一行（例：\`runner/lib/<模块>.js:<行>\`）`);
      return problems;
    }
    if (isTestFace(ref.rel)) {
      if (!waiverDeclared) {
        problems.push(`${tag} **坐标指向测试代码**（\`${shown}\` 在 \`test\`/\`*.test.js\` 面）⇒ 测试里出现这个 env 名`
          + '（通常只是断言用的**字符串**）不等于产品代码在那里读它。改成 runner/portal 里的真读站点坐标；'
          + "确有例外就显式声明 \`\"whereTest\": \"<为什么只能指测试面>\"\`（默认拒，不是默认放行）");
        return problems;
      }
    }
    const abs = path.join(root, ref.rel);
    if (!fs.existsSync(abs)) {
      problems.push(`${tag} **文件不存在**（坐标指向不存在的文件 ${ref.rel}）⇒ 等于没取证`);
      return problems;
    }
    const { code, masked, ctx } = read(ref.rel);
    const total = code.split('\n').length;
    if (ref.from == null) {
      const underRunner = path.resolve(abs).startsWith(RUNNER_ROOT + path.sep);
      if (underRunner) {
        const relToCheck = path.relative(RUNNER_ROOT, abs).split(path.sep).join('/');
        if (sources?.get(key)?.has(relToCheck)) return problems;
        problems.push(`${tag} 只给了文件没给行，而扫描器在 \`${relToCheck}\` 里**没发现对 ${key} 的活读**`
          + ' —— 坐标是**注释背书**的（#557 那条 `ERIX_AGENT_VERSION` 就栽在这一点上，见它的 reason）');
        return problems;
      }
      // #587 族 B 三轮①：**文件级**引用也必须带豁免选项（旧代码在这里漏传 ⇒ 豁免下
      // 文件级引用照样吃裸串，审计实测可绕过）
      if (key != null && mentionsKeyIn(code, masked, 0, code.length, key, { allowBareString: !opts.waiverDeclared })) return problems;
      if (key == null) return problems;
      problems.push(`${tag} 只给了文件，而整个文件的**代码**（剥掉注释、抹掉串正文后）里没有 ${key} ⇒ 坐标过期`);
      return problems;
    }
    if (ref.to != null && ref.to < ref.from) {
      problems.push(`${tag} 的行范围是反的（:${ref.from}-${ref.to}）⇒ 写成 \`${ref.rel}:${ref.to}-${ref.from}\``);
      return problems;
    }
    if (ref.to != null && ref.to - ref.from > 30) {
      problems.push(`${tag} 的行范围宽 ${ref.to - ref.from + 1} 行（>30）⇒ 「整段」不是在给一行证据：`
        + '收窄成真读取那一行，或用 `；` 分别引用');
      return problems;
    }
    for (let ln = ref.from; ln <= (ref.to ?? ref.from); ln += 1) {
      const span = lineRange(code, ln);
      if (span == null) {
        problems.push(`${tag} 指到第 ${ln} 行，但那个文件只有 ${total} 行 ⇒ 坐标过期`);
        continue;
      }
      const ok = typeof opts.lineOk === 'function'
        ? opts.lineOk(ln, code.slice(span[0], span[1]))
        : (key == null ? lineHasEnvEvidence(code, masked, span[0], span[1])
          : lineMentionsKey(code, masked, ctx, key, span[0], span[1], { allowBareString: !opts.waiverDeclared }));
      if (ok) continue;
      const text = code.slice(span[0], span[1]).trim().slice(0, 90);
      const why = typeof opts.lineOk === 'function'
        ? opts.lineWhy
        : (key == null
          ? '那一行**没有任何 env 名的结构化证据**（既不是代码位的 env 名，也不是值位串里的 env 名）'
          : '那一行**不含该 key**（也没有能解析到它的常量名）');
      problems.push(`${tag} ${why}。实际内容：\`${text}\` ⇒ 坐标是编的或已漂移：`
        + '**行号看着合理不等于它对**（注释里出现过、串里顺带提到过都不算，要代码位或值位串）'
        + (ref.to != null && ref.to !== ref.from
            ? `\n  行范围 \`${range}\` 是**逐行**判的：第 ${ln} 行没过就红，不许静默只验首行`
            : ''));
    }
    return problems;
  };
}

/**
 * `where` 是**可校验坐标**（活二 + 族 B①）：每个引用都必须存在、必须是 JS 源文件、必须不在测试面，
 * 带行的那**几行**必须含该 key 的字面量（代码位 / 值位串 / 注入形）或能解析到它的常量名；
 * 只给文件不给行 ⇒ 扫描器必须在那个文件里发现对该 key 的**活读**。`sources` 传 `RUNNER_ENV_KEYS`。
 */

/**
 * `unsupported` 段的「不许免证」（族 B②）：
 *   · `at` 必须是**扫描器现在真的认得出的动态读站点**（`detected` 传 `scanEnvReads(...).unsupported`；
 *     不传 ⇒ 只跑坐标卫生检验，给不需要咬合的夹具用）；文件不存在 / 行号不含该读形 ⇒ 红；
 *   · 理由必须含至少一个可核对的 `路径.js:行` 引用，而且那个引用过**同一把尺**（同不在测试面、
 *     不许绝对路径、不许 `.json`）—— 自由散文不接受；
 *   · `read` / `reason` / 重复登记 的旧口径全部保留（只加不减）。
 * @param {Array} items 登记的 `unsupported` 条目
 * @param {string} root 坐标解析的根（盘上那份 = 仓库根；夹具 = 临时目录）
 * @param {Array<{at:string, shape:string}>|null} detected 扫描器现在扫到的动态读形（带 rootLabel 的坐标）
 */
function validateUnsupported(items, root = REPO_ROOT, detected = null) {
  const problems = [];
  const seen = new Set();
  const coord = makeCoordChecker(root);
  items.forEach((u, i) => {
    const at = `unsupported[${i}]`;
    if (u === null || typeof u !== 'object' || Array.isArray(u)) { problems.push(`${at} 不是对象`); return; }
    const refs = parseCoordRefs(u.at);
    if (refs.length !== 1 || refs[0].from == null || refs[0].to != null) {
      problems.push(`${at} 的 \`at\` 必须是 \`路径.js:行\` 坐标（实际 ${JSON.stringify(u.at)}）`);
    } else {
      const ref = refs[0];
      const sameShape = detected?.find((d) => splitCoord(d.at).rel === ref.rel && normRead(d.shape) === normRead(u.read)) ?? null;
      problems.push(...coord(ref, {
        key: null,
        sources: null,
        tag: `${at} 的 \`at\`（${u.at}）`,
        lineOk: detected === null ? () => true : (ln) => detected.some((d) => {
          const c = splitCoord(d.at);
          return c.rel === ref.rel && c.line === ln && normRead(d.shape) === normRead(u.read);
        }),
        lineWhy: sameShape
          ? `那一行**不是这个读形所在的行**：同一个读形现在在 \`${sameShape.at}\` ⇒ 坐标必须指到那一行（别把动态读登在旁边那行）`
          : `扫描器在 \`${ref.rel}\` 里**根本没看到这个读形**（登记的 \`${u.read}\` 是虚构的或已改形）`
            + ' ⇒ 现跑一次扫描器、照抄它给出的形状与行号',
      }));
    }
    if (typeof u.read !== 'string' || u.read.trim() === '') problems.push(`${at} 缺 \`read\`（要登记的是那个**读形**本身）`);
    if (typeof u.reason !== 'string' || u.reason.trim() === '') {
      problems.push(`${at}（read=${u.read}）**缺理由字段 reason**：没有理由的例外不算例外`);
      return;
    }
    // 理由必须引事实（族 B②）：至少一个 JS 坐标引用，且**每一个**引用都过同一把尺
    const reasonRefs = parseCoordRefs(u.reason);
    const usable = reasonRefs.filter((r) => !r.abs && JS_SOURCE_EXT.has(r.ext) && !isTestFace(r.rel));
    if (usable.length === 0) {
      problems.push(`${at}（read=${u.read}）的理由是**自由散文**：里面没有一个可核对的 \`路径.js:行\` 引用`
        + ' ⇒ 「扫不出来」这件事必须能被重新核对（名字从哪里来？给我那行坐标）：写不成坐标的理由不算理由');
    }
    // #587 族 B 返工④：理由里的引用必须**指到这条动态读自己**（覆盖 `at` 那一行），
    // 或指到它的**数据表声明行**（那一行含 `read` 里那个动态 key 的标识符，如 `process.env[name]` 的 `name`）。
    // 审计实测：只要求「引用一个含任意 env 名的合法行」⇒ 堆一行无关代码就能豁免。
    const atRef = splitCoord(u.at);
    const keyIdent = /\[\s*([A-Za-z_$][\w$]*)\s*\]/.exec(String(u.read ?? ''))?.[1] ?? null;
    // ⚠ 这里**没有** `read` 可用（`validateUnsupported` 只建了 `coord`）——自建一个读器，
    // 否则 `try/catch` 会把 ReferenceError 吞掉、`existing` 恒空、相关性检查静默失效。
    const readSrc = (rel) => {
      const raw = fs.readFileSync(path.join(root, rel), 'utf8');
      return { code: stripComments(raw), masked: structuralMask(raw) };
    };
    /** 该行是**声明/数据表**行吗？判据：有 env 名字面量（代码位或值位串），且**它自己不是 env 读行**。
     *  #587 族 B 三轮④：审计实测「第 3 行 `const unrelated = process.env.ERIX_UNRELATED + name;`」
     *  曾被当成数据表声明给第 5 行的动态读背书 —— env 读行不是声明行，这条把它挡掉。 */
    const isDeclLike = (rel, from, to) => {
      const { code, masked } = readSrc(rel);
      const totalLines = code.split('\n').length;
      const clampLn = (n) => Math.min(Math.max(1, n), totalLines);
      const a = lineRange(code, clampLn(from));
      if (a == null) return false;
      const b = to == null || to === from ? a : (lineRange(code, clampLn(to)) ?? a);
      const seg = code.slice(a[0], b[1]);
      if (/\bprocess\s*\.\s*env\b|\benv\s*[.[]/.test(seg)) return false;   // 自己就是 env 读行
      // #587 族 B 四轮：**裸标量声明不算数据表**（`const MSG = 'ERIX_X'` 只是文案，审计实测能背书动态读）。
      // 数据表的形状是「容器内的值」⇒ 该行必须出现 `{` 或 `[`。
      if (!/[\[{]/.test(seg)) return false;
      return lineHasEnvEvidence(code, masked, a[0], b[1]);
    };
    const existingUsable = usable.filter((r) => { try { readSrc(r.rel); return true; } catch { return false; } });
    const relatedOk = existingUsable.length === 0 || existingUsable.some((r) => {
      if (r.rel !== atRef.rel) return false;
      if (r.from == null) return true;                       // 文件级引用：至少同一文件
      const lo = r.from;
      const hi = r.to ?? r.from;
      if (atRef.line != null && lo <= atRef.line && atRef.line <= hi) return true;   // 覆盖读站点
      // 能力边界（写进注释，不藏）：**模板拼名**算不出单一标识符 ⇒ 只能要求「同一文件」。
      // 代价：模板形状下同文件里拿无关行充数仍可能过；但 `env[name]` 这类**算得出标识符**的形状
      // 已被下面那条「必须是声明行」堵死（审计实测的两条绕过都属于这一类）。
      if (keyIdent == null) return true;
      return isDeclLike(r.rel, lo, hi);                                              // 声明/数据表行
    });
    if (!relatedOk) {
      problems.push(`${at}（read=${u.read}）的理由里**没有一个引用指到这条动态读**：要么覆盖 \`${u.at}\` 那一行，`
        + `要么指到它的数据表声明行（那一行得含 \`${keyIdent ?? '<动态 key 的标识符>'}\`）⇒ `
        + '拿「同一文件里另一行含某个 env 名」充数不算证据（#587 族 B 返工④，审计实测可绕过）');
    }
    reasonRefs.forEach((r, j) => {
      // #587 族 B 四轮返工（261117 实测）：理由里**提到测试文件**是**背景说明**（「某某 test 有反向判据钉住」），
      // 不是坐标 ⇒ 不按坐标校验，否则真登记会被自己的散文误杀（这是假红，不是漏放）。
      if (isTestFace(r.rel)) return;
      const range = r.from == null ? '' : `:${r.from}${r.to != null && r.to !== r.from ? `-${r.to}` : ''}`;
      problems.push(...coord(r, { key: null, sources: null, tag: `${at} 的理由里的第 ${j + 1} 个引用 ${r.rel}${range}` }));
    });
    const k = `${splitCoord(u.at).rel}::${normRead(u.read)}`;
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
  const coord = makeCoordChecker(root);
  entries.forEach((e, i) => {
    const at = `exceptions[${i}]`;
    const where = typeof e?.where === 'string' ? e.where.trim() : '';
    if (where === '') { problems.push(`${at}（key=${e?.key}）**缺 where**：没有可校验坐标的例外等于没取证`); return; }
    const refs = parseCoordRefs(where);
    if (refs.length === 0) {
      problems.push(`${at}（key=${e.key}）的 where 里没有任何 \`路径.js[:行]\` 引用 ⇒ 「${where}」是**说明文字**，`
        + '不是坐标：判据扫不到它，它会随改动自己变成假的');
      return;
    }
    const waiver = testFaceWaiver(e);
    if (e?.whereTest !== undefined && waiver === null) {
      problems.push(`${at}（key=${e.key}）的 \`whereTest\` 豁免**不合法**：要么写 \`whereTest: "<非空理由>"\`，`
        + '要么 `whereTest: true` + `whereTestReason: "<非空理由>"`（光 `whereTest: true` 就是开了个没理由的口子）');
    }
    let usedWaiver = false;
    refs.forEach((ref, j) => {
      const range = ref.from == null ? '' : `:${ref.from}${ref.to != null && ref.to !== ref.from ? `-${ref.to}` : ''}`;
      const tag = `${at}（key=${e.key}）where 的第 ${j + 1} 个引用 ${ref.rel}${range}`;
      if (isTestFace(ref.rel) && waiver !== null) usedWaiver = true;
      problems.push(...coord(ref, { key: e.key, sources, tag, waiverDeclared: waiver !== null }));
    });
    if (waiver !== null && !usedWaiver) {
      problems.push(`${at}（key=${e.key}）声明了 \`whereTest\` 豁免，但坐标里没有一个在测试面 ⇒ **死豁免**（第二本账），删掉它`);
    }
  });
  return problems;
}

/** 索引里该 key 的读站点清单（写成 `rel:line(shape)`，只取前 6 条，报错时能照着改）。 */
function describeSites(index, key, limit = 6) {
  const inj = index.injectionSitesOf(key).map((s) => ({ ...s, shape: `injection:${s.shape}` }));
  const all = [...index.sitesOf(key), ...inj];
  if (all.length === 0) return '（索引里这个 key 一个读站点都没有 ⇒ 它要么没被真读，要么扫描器认不出那个读形）';
  const rest = all.length > limit ? `…（共 ${all.length} 条）` : '';
  return all.slice(0, limit).map((s) => `${s.rel}:${s.line}(${s.shape})`).join('、') + rest;
}

/**
 * **影子**版的 `where` 校验（#587 折中方案第 1 步）：**只被下面的测试调用，没接进闸门**。
 * 与 `whereProblems()` 的差别只有一处：那一行内容不再用「文本命中」判，而是问索引
 * 「这个坐标**是不是该 key 的读站点**」（`index.hasSite()`）。其余尺子（绝对路径 / 非 JS 后缀 /
 * 测试面 / 文件不存在 / 行范围语法 / 越界）**故意走同一把尺**（`makeCoordChecker` 的 `lineOk` 入口），
 * 否则两边的差异就混进了「卫生检验」的噪声，影子对照也就读不出东西。
 *   · 多引用（`a.js:12；b.js:34`）⇒ **每个**都要成立；
 *   · 文件级引用（`rel` 不带行号）⇒ 要求该 key 在该文件**有读站点**；
 *   · 返回与 `whereProblems()` **同形**的 `string[]`（文案前缀一致 ⇒ 能按坐标对齐做对照）。
 * @param {Array} entries 例外清单的 `exceptions`
 * @param {object} index `buildEnvSiteIndex(root)` 的产出（root 必须与下面的 root 同一个）
 * @param {string} root 坐标解析的根（盘上那份 = 仓库根；夹具 = 临时目录）
 */
function siteIndexProblems(entries, index, root = REPO_ROOT) {
  const problems = [];
  const coord = makeCoordChecker(root);
  entries.forEach((e, i) => {
    const at = `exceptions[${i}]`;
    const where = typeof e?.where === 'string' ? e.where.trim() : '';
    if (where === '') { problems.push(`${at}（key=${e?.key}）**缺 where**：没有可校验坐标的例外等于没取证`); return; }
    const refs = parseCoordRefs(where);
    if (refs.length === 0) {
      problems.push(`${at}（key=${e.key}）的 where 里没有任何 \`路径.js[:行]\` 引用 ⇒ 「${where}」是**说明文字**，`
        + '不是坐标：判据扫不到它，它会随改动自己变成假的');
      return;
    }
    const waiver = testFaceWaiver(e);
    if (e?.whereTest !== undefined && waiver === null) {
      problems.push(`${at}（key=${e.key}）的 \`whereTest\` 豁免**不合法**：要么写 \`whereTest: "<非空理由>"\`，`
        + '要么 `whereTest: true` + `whereTestReason: "<非空理由>"`（光 `whereTest: true` 就是开了个没理由的口子）');
    }
    let usedWaiver = false;
    refs.forEach((ref, j) => {
      const to = ref.to != null && ref.to !== ref.from ? `-${ref.to}` : '';
      const range = ref.from == null ? '' : `:${ref.from}${to}`;
      const tag = `${at}（key=${e.key}）where 的第 ${j + 1} 个引用 ${ref.rel}${range}`;
      if (isTestFace(ref.rel) && waiver !== null) usedWaiver = true;
      // 尺子在「文件级 + runner 下」那一支只认 `sources.get(key).has(rel)`，而本函数把内容判定
      // 接过来了 ⇒ 把**这一个** rel 当钥匙递进去，让那支闭嘴（否则它会报「对 null 的活读」）。
      const relKey = path.relative(RUNNER_ROOT, path.join(root, ref.rel)).split(path.sep).join('/');
      const lineOk = (ln) => index.hasSite(e.key, ref.rel, ln);   // ← M-1 变异点：行级 → 文件级
      const lineWhy = `那一行**不是 ${e.key} 的读站点**（索引里没有 \`${ref.rel}:${ref.from}\` 这条站点；`
        + `该 key 在索引里的真站点是：${describeSites(index, e.key)}）`;
      problems.push(...coord(ref, {
        key: null, sources: new Map([[null, new Set([relKey])]]), tag,
        waiverDeclared: waiver !== null, lineOk, lineWhy,
      }));
      if (ref.from == null && !index.hasSiteInFile(e.key, ref.rel)) {
        problems.push(`${tag} 只给了文件没给行，而索引里 \`${ref.rel}\` **没有对 ${e.key} 的读站点**`
          + `（文件级引用要求这个文件真的读了它，提到过它的散文 / 数据表行 / 注释都不算）。`
          + `该 key 的真站点：${describeSites(index, e.key)}`);
      }
    });
    if (waiver !== null && !usedWaiver) {
      problems.push(`${at}（key=${e.key}）声明了 \`whereTest\` 豁免，但坐标里没有一个在测试面 ⇒ **死豁免**（第二本账），删掉它`);
    }
  });
  return problems;
}

/**
 * 把「问题列表」压成**坐标身份**集合（两边的文案必然不同，但「哪个坐标被判红」必须能对齐）。
 * 取的是 `whereProblems` / `siteIndexProblems` **共用**的那个 `tag` 前缀（同一条登记、同一个引用序号、
 * 同一个坐标），非坐标级的问题（缺 where / 说明文字 / 死豁免）折成 `key@整条`。
 */
function coordIds(problems) {
  const ids = new Set();
  for (const p of problems) {
    const ref = /^exceptions\[(\d+)\]（key=([^）]+)）where 的第 (\d+) 个引用 (\S+?)(?=[\s（]|$)/.exec(p);
    if (ref) { ids.add(`${ref[2]}@${ref[4]}#${ref[3]}`); continue; }
    const head = /^exceptions\[(\d+)\]（key=([^）]+)）/.exec(p);
    ids.add(head ? `${head[2]}@整条登记#${head[1]}` : `其他@${p.slice(0, 40)}`);
  }
  return [...ids].sort();
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
    // ③ 登记带理由 ⇒ 绿（同一把尺，共用 validateUnsupported；理由必须带可核对的 `路径:行`，族 B②）
    const reg = [{ at: 'dyn.js:1', read: unsupported[0].shape, reason: '拼名来自调用方；同名旋钮的值域见 dyn.js:2' }];
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

// ===========================================================================
// 族 A（issue #587）：闸门的**语言事实**——正则字面量 / 可选链 / 词法作用域
//
// 这一段的判据口径只认两种：**该被扫到的名字必须在枚举里** / **不该被错记的名字必须不在**。
// 不写「某函数被调用了」「某分支被执行了」这类形状断言：那种格子在机件被拆掉后照样会绿。
// 每格都带一个**方向相反的对照组**，所以「把机件拆掉」与「把机件做得过宽」都会红。
// ===========================================================================

/**
 * 写一个临时夹具并扫它：`src` 给字符串 = 单文件 `fx.js`；给对象 = 多个文件（**别名表是按文件建的**，
 * 想让某个形状「只有它自己」时必须单独放一个文件，否则隔壁文件的别名会替它背书）。
 * @returns {{ keys: string[], unsupported: Array }}
 */
function scanFixture(name, src) {
  const files = typeof src === 'string' ? { 'fx.js': src } : src;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `env-lang-${name}-`));
  try {
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
    const { keys, unsupported } = scanEnvReads(dir);
    return { keys: [...keys.keys()].sort(), unsupported };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('活二⑨ 正则字面量不是注释：字符类里的「斜杠星」之后，真读取必须仍在枚举里（六种形状）', () => {
  // 旧状态机按 `/*` `//` 文本切，不认正则定界符 ⇒ `/[/*]/` 里那个坐在**字符类**里的「斜杠星」被当成块注释
  // 起点：`stripComments()` 靠「未闭合 ⇒ 原样退回」侥幸活下来，`structuralMask()` **没有那条退路**
  // ⇒ 其后所有真读取被当成串正文放过 = 静默漏扫（现网同形：`runner/lib/file-tools.js:67`）。
  // 所以夹具里故意放一个**其后的真块注释**：谁把 `stripComments()` 那条正则识别拆掉，这里就会被
  // 「假 `/*` 一路吃到真 `*/`」吞掉中间的读取，两把尺少任一把都红。
  const src = [
    'const cls = /[/*]/;                                  // 字符类里坐着 /*',
    'export const a = process.env.ERIX_A2_AFTER_CLASS;',
    'const clsU = /[*?]/u;',
    'export const b = process.env.ERIX_A2_AFTER_CLASS_U;',
    'const sep = /a\\/b/; const sep2 = /\\/\\//;         // 正则里的转义斜杠',
    'export const c = process.env.ERIX_A2_AFTER_ESCAPED;',
    'const x = a / b; const re = /[/*]/; const y = c / d; // 正则夹在两次除法中间',
    'export const d = process.env.ERIX_A2_BETWEEN_DIV;',
    'const cls2 = /[/]*/; const e2 = process.env.ERIX_A2_AFTER_CLASS_SLASH; const w = 1 / 2;',
    'export function f(e) { return /[*?]/u.test(e); }',
    'export const g = process.env.ERIX_A2_AFTER_RETURN;',
    '/* 真块注释里提到 process.env.ERIX_A2_GHOST_BLOCK */',
    'export const h = process.env.ERIX_A2_AFTER_BLOCK;',
    '// 行注释里提到 process.env.ERIX_A2_GHOST_LINE',
  ].join('\n');
  const { keys } = scanFixture('regex', src);
  assert.deepEqual(keys, [
    'ERIX_A2_AFTER_BLOCK', 'ERIX_A2_AFTER_CLASS', 'ERIX_A2_AFTER_CLASS_SLASH', 'ERIX_A2_AFTER_CLASS_U',
    'ERIX_A2_AFTER_ESCAPED', 'ERIX_A2_AFTER_RETURN', 'ERIX_A2_BETWEEN_DIV',
  ].sort(), `正则识别漏了形状 ⇒ 它后面的真读取被整段吞掉（实际只扫到 ${JSON.stringify(keys)}）。`
    + '缺哪几个名字 = 哪一段代码被当成注释/串正文抹平了');
  // 反向自证：正则识别**不许**把真注释重新当代码（注释里那两个假名字必须仍然不存在）
  for (const ghost of ['ERIX_A2_GHOST_BLOCK', 'ERIX_A2_GHOST_LINE']) {
    assert.ok(!keys.includes(ghost), `${ghost} 只活在注释里却进了枚举 ⇒ 「正则 vs 注释」的判定被改坏了`);
  }
});

test('活二⑩ 正则**正文里提到的**读形不算读取（掩码那把尺也必须认正则，否则正则里的文字会造假 key）', () => {
  // 与上一格方向相反：`structuralMask()` 把正则正文抹平之后，`/process.env.ERIX_X/` 里那段文字
  // 才不会被当成读取点。谁只在 `stripComments()` 里认正则、`structuralMask()` 里不认，这一格当场红。
  const src = [
    'const re = /process.env.ERIX_A2_IN_REGEX_DOT/;',
    'const re2 = /env.ERIX_A2_IN_REGEX_ALIAS/;',
    'export const ok = process.env.ERIX_A2_OUTSIDE_REGEX;',
  ].join('\n');
  const { keys } = scanFixture('regex-body', src);
  assert.deepEqual(keys, ['ERIX_A2_OUTSIDE_REGEX'],
    `正则正文里的文字被当成读取了（实际 ${JSON.stringify(keys)}）⇒ 掩码不认正则字面量：`
    + '假 key 会带着「三腿缺」的帽子红在闸门里，而真值一个也看不见');
});

test('活二⑪ 可选链读形五种都要进枚举（`process.env?.X` / `env?.X` / `process?.env?.X` / `process.env?.[\'X\']` / `env?.[表名]`）', () => {
  // 旧 `readRe` 只有 `(?:\?\.)?(?:\. NAME | \[…\])`：`process.env?.X` 里 `?.` 之后**没有**第二个点，
  // 两支都不匹配 ⇒ 整形扫不到 0 次；`process?.env` 更是连**对象别名**都匹配不上（别名表与读形两处都要改）。
  // 别名那一支必须单独放一个文件：别名是**按文件**建的，隔壁文件的 `env = process.env` 会替它背书。
  const { keys, unsupported } = scanFixture('optchain', {
    'shapes.js': [
      "const T = Object.freeze({ a: 'ERIX_A3_TABLE_KEY' });",
      'export function pick(which, env = process.env) {',
      '  const name = T[which];',
      '  return [',
      '    process.env.ERIX_A3_DOT,',
      '    env.ERIX_A3_ALIAS_DOT,',
      '    process.env["ERIX_A3_BRACKET"],',
      '    process.env?.ERIX_A3_OPTCHAIN,',
      '    env?.ERIX_A3_ALIAS_OPT,',
      '    process?.env?.ERIX_A3_OPTPROC,',
      "    process.env?.['ERIX_A3_OPT_BRACKET'],",
      '    env?.[name],',
      '    env?.[which],',
      '  ];',
      '}',
      'export const falseAlias = (childEnv) => childEnv.ERIX_A3_FALSE_ALIAS;',
      'export const nestedEnv = (spec) => spec.env.ERIX_A3_NESTED_ALIAS;',
      'export const notEnv = (foo) => foo?.ERIX_A3_NOT_ENV_OBJECT;',
    ].join('\n'),
    'alias-only.js': 'export function viaAlias(env = process?.env) { return env.ERIX_A3_ALIAS_FROM_OPTCHAIN; }\n',
  });
  assert.deepEqual(keys, [
    'ERIX_A3_ALIAS_DOT', 'ERIX_A3_ALIAS_FROM_OPTCHAIN', 'ERIX_A3_ALIAS_OPT', 'ERIX_A3_BRACKET',
    'ERIX_A3_DOT', 'ERIX_A3_OPTPROC', 'ERIX_A3_OPT_BRACKET', 'ERIX_A3_OPTCHAIN', 'ERIX_A3_TABLE_KEY',
  ].sort(), `可选链那一支没进枚举（实际 ${JSON.stringify(keys)}）⇒ 读形扫不到 = 那个旋钮在闸门里不存在`);
  // 读形认得、名字来自调用方 ⇒ 不许静默放过，必须进 `unsupported`（fail loudly）
  assert.deepEqual(unsupported.map((u) => `${u.at} ${u.shape}`), ['shapes.js:13 env?.[which]'],
    `解析不出名字的动态读形没进 unsupported（实际 ${JSON.stringify(unsupported)}）`);
  // 对象前缀那条前视不许被放宽：`childEnv.X` / `foo?.X` 都不是 env 对象
  for (const phantom of ['ERIX_A3_FALSE_ALIAS', 'ERIX_A3_NESTED_ALIAS', 'ERIX_A3_NOT_ENV_OBJECT']) {
    assert.ok(!keys.includes(phantom),
      `${phantom} 来自**别的对象**（名字以 env 结尾 / 只是碰巧写了可选链）却进了枚举 ⇒ 前缀被放宽了`);
  }
});

test('活二⑫ 参数遮蔽：`function f(OUTER_ENV, env)` 里 `env[OUTER_ENV]` 是动态读，不许错记成外层常量的名字', () => {
  // #587 族 A⑤：`names` 那张表是**文件级**的，旧扫描器据此把动态 key **错记**成外层常量值
  // ⇒ 枚举里凭空多出一个没人读的 key（还看起来是对的），而真的动态读没进 `unsupported`
  // ⇒ fail-closed 被绕过。两个方向都要判：phantom 必须不在、unsupported 必须有那一条。
  const src = [
    "const OUTER_ENV = 'ERIX_A5_PHANTOM_WHEN_MISATTRIBUTED';",
    "const PLAIN_ENV = 'ERIX_A5_STATIC_OK';",
    'export function shadowed(OUTER_ENV, env = process.env) { return env[OUTER_ENV]; }',
    'export function plain(env = process.env) { return env[PLAIN_ENV]; }',
    "export function defaulted(KEY = 'ERIX_A5_PARAM_LITERAL', env = process.env) { return env[KEY]; }",
  ].join('\n');
  const { keys, unsupported } = scanFixture('shadow-param', src);
  assert.ok(!keys.includes('ERIX_A5_PHANTOM_WHEN_MISATTRIBUTED'),
    `被参数遮蔽的动态读形被**错记**成外层常量的名字了（枚举 ${JSON.stringify(keys)}）：`
    + '错记比漏记更坏 —— 枚举里那个 key 看起来是对的，真的动态读却隐形了');
  assert.deepEqual(unsupported.map((u) => `${u.at} ${u.shape}`), ['fx.js:3 env[OUTER_ENV]'],
    `参数遮蔽下的动态读形没进 unsupported（实际 ${JSON.stringify(unsupported)}）⇒ fail-closed 被绕过`);
  // 两个对照组：遮蔽**不许**宽到把静态读形与「参数自带字面量」也吞掉
  assert.deepEqual(keys, ['ERIX_A5_PARAM_LITERAL', 'ERIX_A5_STATIC_OK'],
    `静态读形被遮蔽误伤（实际 ${JSON.stringify(keys)}）：遮蔽算宽了同样是漏扫`);
});

test('活二⑬ 块内重绑定遮蔽：`const` / `let` / `var` 三种重声明都要断开外层同名常量（三形各一条）', () => {
  // 工单要求「至少做到同一函数/块内 const/参数 遮蔽后不再认外层同名常量」——`var` 也一起判：
  // 它同样在读取点之前重新绑定了那个名字（静态上判不准它到底指谁 ⇒ 宁可进 unsupported）。
  const src = [
    "const C_ENV = 'ERIX_A5_PHANTOM_CONST';",
    "const L_ENV = 'ERIX_A5_PHANTOM_LET';",
    "const V_ENV = 'ERIX_A5_PHANTOM_VAR';",
    'export function useConst(env = process.env) { const C_ENV = globalThis.zz?.a; return env[C_ENV]; }',
    'export function useLet(env = process.env) { let L_ENV = globalThis.zz?.b; return env[L_ENV]; }',
    'export function useVar(env = process.env) { var V_ENV = globalThis.zz?.c; return env[V_ENV]; }',
  ].join('\n');
  const { keys, unsupported } = scanFixture('shadow-block', src);
  for (const phantom of ['ERIX_A5_PHANTOM_CONST', 'ERIX_A5_PHANTOM_LET', 'ERIX_A5_PHANTOM_VAR']) {
    assert.ok(!keys.includes(phantom),
      `${phantom} 来自一个被块内重声明遮蔽的动态读形，却进了枚举（实际 ${JSON.stringify(keys)}）`);
  }
  assert.deepEqual(unsupported.map((u) => u.shape), ['env[C_ENV]', 'env[L_ENV]', 'env[V_ENV]'],
    `块内重声明的动态读形没逐条进 unsupported（实际 ${JSON.stringify(unsupported.map((u) => u.shape))}）`
    + ' ⇒ 三形里少一形就是那一形在闸门里隐形');
});

test('活二⑭ 遮蔽不许外溢：同名常量在遮蔽区间**之外**照常解析（遮蔽算宽 = 另一种静默漏扫）', () => {
  const src = [
    "const SH_ENV = 'ERIX_A5_SCOPE_OUTSIDE_OK';",
    'export function shadowed(SH_ENV, env = process.env) { return env[SH_ENV]; }',
    'export function outerUse(env = process.env) { return env[SH_ENV]; }',
    'export const topUse = process.env[SH_ENV];',
  ].join('\n');
  const { keys, unsupported } = scanFixture('shadow-scope', src);
  assert.deepEqual(keys, ['ERIX_A5_SCOPE_OUTSIDE_OK'],
    `遮蔽算到了整个文件（枚举 ${JSON.stringify(keys)}）：遮蔽区间 = 那个函数体，不是全文件`
    + ' —— 把动态与静态一起判成动态 = 三腿判据看不见这个 key，照样静默');
  assert.deepEqual(unsupported.map((u) => `${u.at} ${u.shape}`), ['fx.js:2 env[SH_ENV]'],
    `只有被遮蔽的那一条该进 unsupported（实际 ${JSON.stringify(unsupported)}）`);
});

test('活二⑮ `)` 之后：控制流头部接正则、调用接除法（两种都不许吞掉后面的真读取）', () => {
  // `if (x) /re/.test(y)` 与 `f(1) / 2` 都以 `)` 结尾，静态上单看前一个字符判不出。
  // 旧口径一律按除法 ⇒ `if (flag) /[/*]/.test(name);` 之后又被「假 `/*`」整段吞掉（同一族的静默）。
  // 现在靠括号栈回查那个 `(` 前面是不是控制流关键字。两向都要有牙：
  //   把 `)` 一律按除法 → `ERIX_A2_AFTER_IFREGEX` 消失；一律按正则 → 两个除法行被当正则抹平。
  const src = [
    'if (flag) /[/*]/.test(name);',
    'export const a = process.env.ERIX_A2_AFTER_IFREGEX;',
    'const half = compute(1) / 2; const other = process.env.ERIX_A2_AFTER_CALLDIV; const t = 3 / 4;',
    'const ratio = (width) / (height); const more = process.env.ERIX_A2_AFTER_GROUPDIV; const u = 5 / 6;',
  ].join('\n');
  const { keys } = scanFixture('paren-slash', src);
  assert.deepEqual(keys, ['ERIX_A2_AFTER_CALLDIV', 'ERIX_A2_AFTER_GROUPDIV', 'ERIX_A2_AFTER_IFREGEX'],
    '`if (x) /re/` 与 `f(1) / 2` 的判定判错了（实际 ' + JSON.stringify(keys) + '）：'
    + '一律按除法会吞掉正则后面的读取，一律按正则会把除法当正则抹平');
});

test('活二⑯ 斜杠认不准时必须退回除法：同一行内找不到闭合斜杠就不许跨行去找（三形都不许吞掉后面的真读取）', () => {
  // `regexLiteralSpan()` 的「必须同行闭合」那条是**方向守卫**：正则本来就不许跨行，所以
  // 「这一行没有第二个斜杠」就意味着它不是正则 ⇒ 退回除法、继续按注释判。
  // 守卫拆掉后它会一路叓到下一行的 `/`：`stripComments()` 里原样留、`structuralMask()` 里整段抹平
  // ⇒ 又一个「真读取被当成串正文」的静默形状。（下面三形的共同点：斜杠坐在正则位上、本行没闭合。）
  const shapes = {
    'bare-slash-then-regex': ['export const junk = [\n  1,\n  /2,\n];', 'export const re = /[*?]/u;'],
    'unclosed-class': ['if (flag) /[a/;', 'export const re = /[*?]/u;'],
    'wrapped-division': ['export const per = a ==\n  / 2;', 'export const re = /[*?]/u;'],
  };
  for (const [name, [head, tail]] of Object.entries(shapes)) {
    // 真读取**夹在中间**：那才是会被跨行正则抹平的位置（放在尾行后面就并判不到这个方向）
    const src = `${head}\nexport const v = process.env.ERIX_A2_AFTER_UNSAFE_SLASH;\n${tail}\n`;
    const { keys } = scanFixture(`slash-${name}`, src);
    assert.ok(keys.includes('ERIX_A2_AFTER_UNSAFE_SLASH'),
      `形状「${name}」之后那个真读取不见了（实际 ${JSON.stringify(keys)}）：认不准的斜杠被当成了正则，`
      + '跨行抹平了后面的代码 = 静默漏扫（认不准就得按除法，不许猜它是正则）');
  }
});

test('活二⑰ 参数遮蔽表要收全**每一个**参数位：末位参数漏收 = 幻影 key 进枚举、unsupported 为空（假绿）', () => {
  // #587 族 A 返工。`bracketPairs()` 给的 `close` 是「右括号**之后**」的 exclusive 下标，旧代码把参数位
  // 写成 `[open + 1, close)` ⇒ 末位参数的片段尾随一个 `)` ⇒ `LAST_ENV)` 匹配不上任何绑定形状
  // ⇒ **末位参数整个漏收**。后果是假绿：被遮蔽的动态读沿用文件级同名常量 ⇒ 枚举里多出一个**没人读**的
  // key（还看起来是对的），`unsupported` 却空着 ⇒ fail-closed 被绕过（`gate.sh` 那一层全绿）。
  // 所以每种参数位都要**逐行点名**：普通函数 / 对象方法 / 类方法 / 类字段箭头 / 顶层箭头 / 无括号单参数
  // 箭头，少收任何一形，那一行的读形既不进 unsupported、又把幻影 key 送进枚举。
  const src = [
    "const LAST_ENV = 'ERIX_A5_LASTPHANTOM';",
    "const CTRL_ENV = 'ERIX_A5_LASTCTRL_OK';",
    'export function plain(SH_ENV, LAST_ENV) { return process.env[LAST_ENV]; }',
    'export const obj = { read(SH_ENV, LAST_ENV) { return process.env[LAST_ENV]; } };',
    'export class C { read(SH_ENV, LAST_ENV) { return process.env[LAST_ENV]; } }',
    'export class D { fld = (SH_ENV, LAST_ENV) => process.env[LAST_ENV]; }',
    'export const topArrow = (SH_ENV, LAST_ENV) => process.env[LAST_ENV];',
    'export const bareArrow = LAST_ENV => process.env[LAST_ENV];',
    'export const ctrl = process.env[CTRL_ENV];',      // 对照组：没被遮蔽的静态读要照常进枚举
  ].join('\n');
  const { keys, unsupported } = scanFixture('shadow-last-param', src);
  assert.ok(!keys.includes('ERIX_A5_LASTPHANTOM'),
    'ERIX_A5_LASTPHANTOM 只在**被参数遮蔽**的读形里出现过，却进了枚举（实际 ' + JSON.stringify(keys) + '）：'
    + '那个参数没进遮蔽表 ⇒ 动态读沿用了文件级同名常量 = 幻影 key。错记比漏记更坏 —— 它看起来是对的，'
    + '而真的动态读在 unsupported 里隐形');
  assert.deepEqual(unsupported.map((u) => `${u.at} ${u.shape}`),
    [3, 4, 5, 6, 7, 8].map((n) => `fx.js:${n} process.env[LAST_ENV]`),
    `六形末位参数的动态读没**逐条**进 unsupported（实际 ${JSON.stringify(unsupported.map((u) => `${u.at} ${u.shape}`))}）：`
    + '少一条就是那一形（普通函数 / 对象方法 / 类方法 / 类字段箭头 / 顶层箭头 / 无括号箭头）的参数没进遮蔽表');
  assert.deepEqual(keys, ['ERIX_A5_LASTCTRL_OK'],
    `枚举里出现了不该有的 key（实际 ${JSON.stringify(keys)}）：末位参数的遮蔽既不许错记成静态、也不许把` 
    + '没被遮蔽的静态读一起吞掉（对照组 `CTRL_ENV` 必须照常在里面）');
});

test('活二⑱ 表达式体箭头的遮蔽区间只覆盖体本身：箭头**之后**的静态读必须照常解析（不许拉回外围块尾）', () => {
  // `=>` 的表达式体没有 `{` 可配。旧口径保守取「最内层**外围块**的结尾」，宁宽不窄；代价是**假红**：
  // `const g = (KEY) => env[KEY]; … process.env[KEY]` —— 箭头**之后**那次读的是外层常量，却被算进箭头
  // 参数的遮蔽区间 ⇒ 静态读形被判成动态 ⇒ 掉进 `unsupported`：那个 key 从此在三腿判据里隐形（又是静默）。
  // 所以区间必须算窄到**体本身**，三个层级各钉一条（模块顶层 / 类体 / 函数体），每条形如
  // 「遮蔽一条 + 紧跟一条静态读」：区间拉回外围块尾 ⇒ 那条静态读从枚举里消失、unsupported 多出一条。
  const src = [
    "const AW_ENV = 'ERIX_A5_ARROW_AFTER_OK';",
    'export const top = (AW_ENV) => process.env[AW_ENV];',        // 遮蔽在体内
    'export const afterTop = process.env[AW_ENV];',                // 顶层：区间拉宽就认不出它
    'export class K { fld = (AW_ENV) => process.env[AW_ENV]; after = process.env[AW_ENV]; }',   // 类体同一层
    'export function wrap() { const f = (AW_ENV) => process.env[AW_ENV]; return process.env[AW_ENV]; }',  // 函数体
  ].join('\n');
  const { keys, unsupported } = scanFixture('arrow-expression-body', src);
  assert.deepEqual(keys, ['ERIX_A5_ARROW_AFTER_OK'],
    `箭头之后的静态读没进枚举（实际 ${JSON.stringify(keys)}）：表达式体的遮蔽区间拉到了外围块尾，`
    + '把后面那些**读外层常量**的静态读形也算成动态 ⇒ 静态 key 隐形，三腿判据从此不再看它');
  assert.deepEqual(unsupported.map((u) => `${u.at} ${u.shape}`), ['fx.js:2 process.env[AW_ENV]', 'fx.js:4 process.env[AW_ENV]', 'fx.js:5 process.env[AW_ENV]'],
    `只有**体内**那三条该进 unsupported（实际 ${JSON.stringify(unsupported.map((u) => `${u.at} ${u.shape}`))}` 
    + '）：多出一条就是箭头后面那条静态读被误判了（区间过宽 = 假红，与幻影 key 相反的静默方向）');
});

test('活二⑲ 解析得出的参数默认值不许白丢：默认值必须被**解析成那个常量**（外层同名常量不许顶上来）', () => {
  // 与⑰同一块地基、方向相反的两面：默认值文本里多一个 `)` 就解析不出 ⇒ 能解析的被丢进 `unsupported`
  // （假红）；而 `{ k: NAME = 'ERIX_X' }` 这一支旧代码写死 `def: null` ⇒ 同样把解析得出的默认值白丢。
  //
  // **三轮审计点名的盲区**（判据质量问题，不是机件问题）：本格原先只断言「枚举里有那两个名字 +
  // `unsupported` 为空」，而 `analyzeEnvReads()` 的**文件级字面量收集器**（那一趟 `const|let|var` 写成
  // 可选的正则）也会把参数默认值文本里的 `DEF_PLAIN = 'ERIX_…'` 当成文件级常量收下 ⇒ 把「参数默认值
  // 绑定解析」整块拆掉，那两个名字仍然在枚举里、`unsupported` 仍然为空 ⇒ 本格照样绿 = 没牙。
  // 现在夹具里放**同名但值不同**的外层常量，并且**直接断言遮蔽表本身**：
  //   · 枚举里必须是**默认值**那两个名字：外层同名值一旦出现 = 默认值绑定没进遮蔽表（幻影 key）
  //   · `unsupported` 必须为空：可解析的名字不许被丢进 fail-closed 清单（丢一个 = 那个旋钮消失）
  //   · 遮蔽表里必须有「那个名字 → 那个字面量」的绑定：钉的是**解析结果**，不是下游侥幸
  const src = [
    "const DEF_PLAIN = 'ERIX_A5_DEF_OUTER_PLAIN';",        // 同名外层常量：默认值解析没接上就会被它顶替
    "const DEF_ALIAS = 'ERIX_A5_DEF_OUTER_ALIAS';",
    "export function plainDefault(DEF_PLAIN = 'ERIX_A5_DEF_PLAIN_OK') { return process.env[DEF_PLAIN]; }",
    "export function aliasedDefault({ k: DEF_ALIAS = 'ERIX_A5_DEF_ALIAS_OK' } = {}) { return process.env[DEF_ALIAS]; }",
  ].join('\n');
  const { keys, unsupported } = scanFixture('param-default-resolvable', src);
  assert.deepEqual(keys, ['ERIX_A5_DEF_ALIAS_OK', 'ERIX_A5_DEF_PLAIN_OK'],
    `两个可解析的参数默认值没全**按默认值**进枚举（实际 ${JSON.stringify(keys)}）：默认值解析不出就被当成`
    + '动态名（那个旋钮从三腿判据里消失），或被外层同名常量顶替（枚举里是个没人读的幻影 key）');
  for (const phantom of ['ERIX_A5_DEF_OUTER_PLAIN', 'ERIX_A5_DEF_OUTER_ALIAS']) {
    assert.ok(!keys.includes(phantom),
      `${phantom} 进了枚举：那是**外层同名常量**的值，读取点坐在参数默认值的遮蔽区间里，读的是默认值。`
      + '它出现就说明默认值绑定没进遮蔽表（默认值解析被拆掉）');
  }
  assert.deepEqual(unsupported, [],
    `可解析的默认值被丢进 unsupported 了（实际 ${JSON.stringify(unsupported.map((u) => u.shape))}）：`
    + '两形（末位 `X = \'ERIX_X\'` / 解构别名 `{ k: NAME = \'ERIX_X\' }`）少解析一形 = 那一形白丢');
  // 直接钉遮蔽表：默认值必须成为那个名字的区间绑定（不看下游收集器的侥幸）
  const shadows = analyzeEnvReads(stripComments(src)).shadows;
  for (const [name, lit] of [['DEF_PLAIN', 'ERIX_A5_DEF_PLAIN_OK'], ['DEF_ALIAS', 'ERIX_A5_DEF_ALIAS_OK']]) {
    const got = (shadows.get(name) ?? []).map((s) => (s.lits ? [...s.lits] : null));
    assert.ok(got.some((l) => l != null && l.length === 1 && l[0] === lit),
      `参数默认值没被解析成遮蔽绑定（要求 ${name} → [${JSON.stringify(lit)}]，实际 ${JSON.stringify(got)}）：`
      + '默认值解析被移除时，文件级字面量收集器仍会把那个名字**顺带**收进静态表 ⇒ 只看枚举与 unsupported '
      + '两本账看不出机件被拆（审计点名的假绿形状），所以这里钉的是解析结果本身');
  }
});

test('活二⑳ 「不许猜」的边界仍在：rest 参数 / 无默认值的解构成员 / 解析不出的默认值都得进 unsupported', () => {
  // ⑲说「解析得出的不许白丢」，这一格钉它的反面：**解析不出的一律不许猜成外层同名常量**。
  // 三形都是「名字确实被绑定了，但绑的是什么值静态上看不出来」：
  //   · `...REST_ENV` 收到的是变长实参数组；
  //   · `{ k: DESTRUCT_ENV }` 的值来自调用方传的对象；
  //   · `DEF_DYN = globalThis.zz?.a` 的默认值不是字面量、也不是已知名。
  // 三形都必须断开外层同名常量（幻影不许进枚举）、逐条进 unsupported。
  const src = [
    "const REST_ENV = 'ERIX_A5_REST_PHANTOM';",
    "const DESTRUCT_ENV = 'ERIX_A5_DESTRUCT_PHANTOM';",
    'export function restParam(A, ...REST_ENV) { return process.env[REST_ENV]; }',
    'export function destructParam({ k: DESTRUCT_ENV }) { return process.env[DESTRUCT_ENV]; }',
    'export function unresolvableDef(DEF_DYN = globalThis.zz?.a) { return process.env[DEF_DYN]; }',
  ].join('\n');
  const { keys, unsupported } = scanFixture('shadow-no-guess', src);
  assert.deepEqual(keys, [],
    `三个静态上判不出的读形里出现了具体 env 名（实际 ${JSON.stringify(keys)}）：那一格在**猜**——`
    + '猜中幻影（外层同名常量）就把动态读错记成静态 key，猜错方向就把该登记的旋钮从三腿判据里抽掉');
  assert.deepEqual(unsupported.map((u) => `${u.at} ${u.shape}`), [
    'fx.js:3 process.env[REST_ENV]',
    'fx.js:4 process.env[DESTRUCT_ENV]',
    'fx.js:5 process.env[DEF_DYN]',
  ],
    `三形逐条登记的动态读不对（实际 ${JSON.stringify(unsupported.map((u) => `${u.at} ${u.shape}`))}）：`
    + '少一条就是那一形被猜成了某个名字（rest / 解构成员 / 不可解析默认值）');
});

test('活二㉑ 嵌套解构要**逐层**进遮蔽表：`{ a: { b: X } }` 漏一层 = 幻影 key 进枚举而 unsupported 为空', () => {
  // 三轮审计的假绿：`function f({ a: { b: KEY } }) { return process.env[KEY] }` 里 `KEY` **没进遮蔽表**
  // ⇒ 外层同名常量把那条动态读错记成静态 key（实测 keys=["ERIX_AUDIT_PHANTOM"]、unsupported=[]）。
  // 旧 `paramBindingsIn()` 只把「冒号右边是个简单标识符」当绑定；冒号右边还是解构时，递归进去的那个片段
  // 以 `a:` 开头 ⇒ 既不是名字也不是 `{`/`[` ⇒ **静默返回空**（= 这里没遮蔽），于是闸门全绿。
  // 每一层都要有名字进来：对象套对象 / 对象套数组 / 数组套对象 / 数组套数组（带洞）/ rest 的目标是解构 /
  // 箭头参数的嵌套解构。带默认值的那一形方向相反（**必须解析成那个常量**，见⑲同一口径）。
  const src = [
    "const NEST_ENV = 'ERIX_A5_NESTED_PHANTOM';",
    "const CTRL_ENV = 'ERIX_A5_NESTED_CTRL_OK';",
    'export function objInObj({ a: { b: NEST_ENV } }) { return process.env[NEST_ENV]; }',       // 审计原形
    'export function objInArr({ a: [NEST_ENV] }) { return process.env[NEST_ENV]; }',
    'export function arrInObj([{ x: NEST_ENV }]) { return process.env[NEST_ENV]; }',
    'export function arrInArr([, { x: [NEST_ENV] }]) { return process.env[NEST_ENV]; }',         // 洞 + 嵌套
    'export function arrRest([first, ...[NEST_ENV]]) { return process.env[NEST_ENV]; }',         // rest 的目标
    "export function nestedDefault({ a: { b: DEF_NEST = 'ERIX_A5_NESTED_DEF_OK' } }) { return process.env[DEF_NEST]; }",
    'export const arrowNested = ({ a: { b: NEST_ENV } }) => process.env[NEST_ENV];',             // 箭头那一形
    'export const ctrl = process.env[CTRL_ENV];',                                                 // 对照组
  ].join('\n');
  const { keys, unsupported } = scanFixture('nested-destructuring', src);
  assert.ok(!keys.includes('ERIX_A5_NESTED_PHANTOM'),
    'ERIX_A5_NESTED_PHANTOM 只出现在**被参数遮蔽**的读形里却进了枚举（实际 ' + JSON.stringify(keys) + '）：'
    + '那一层的解构成员没进遮蔽表 ⇒ 动态读沿用了文件级同名常量 = 幻影 key，而真的动态读在 unsupported 里隐形');
  assert.deepEqual(unsupported.map((u) => `${u.at} ${u.shape}`),
    [3, 4, 5, 6, 7, 9].map((n) => `fx.js:${n} process.env[NEST_ENV]`),
    `六形嵌套解构的动态读没**逐条**进 unsupported（实际 ${JSON.stringify(unsupported.map((u) => `${u.at} ${u.shape}`))}）：`
    + '少一条就是那一形（对象套对象 / 对象套数组 / 数组套对象 / 数组套数组带洞 / rest 目标 / 箭头参数）没被递归到');
  assert.deepEqual(keys, ['ERIX_A5_NESTED_CTRL_OK', 'ERIX_A5_NESTED_DEF_OK'],
    `枚举不对（实际 ${JSON.stringify(keys)}）：嵌套里**解析得出的默认值**（ERIX_A5_NESTED_DEF_OK）必须在，`
    + '没被遮蔽的静态对照（ERIX_A5_NESTED_CTRL_OK）也必须在 —— 少任何一个都是把「遮蔽」与「解析」算错方向');
});

test('活二㉒ ASI 箭头（省略分号）：表达式体必须在行尾结束，但**续行形状**不许跟着一起算窄', () => {
  // 三轮审计的假红：`const f = (KEY) => process.env[KEY]` 换行后接 `process.env[KEY];` ⇒ **两条**读取都进
  // `unsupported`、`keys=[]`。`expressionBodyEnd()` 原先只列「哪些开头算边界」（关键词清单），下一行以普通
  // 标识符 `process` 开头不算边界 ⇒ 遮蔽拉到文件尾，箭头**之后**那条读外层常量的静态读被误判成动态。
  // 反向判据（只有「能接在上一行」的开头才算续行）有两个方向，两个都要钉：
  //   · 过宽（旧口径）：ASI 之后那条静态读从枚举里消失、unsupported 多一条
  //   · 过窄（矫枉过正）：`.concat()` / `??` / 跨行三元那些**还在体内**的读形被当成体外 ⇒ 它们会错记成
  //     外层同名常量（幻影 key）并少几条 unsupported
  const src = [
    "const ASI_ENV = 'ERIX_A5_ASI_AFTER_OK';",
    'export const asi = (ASI_ENV) => process.env[ASI_ENV]',   // 省略分号：体只能到本行为止
    'process.env[ASI_ENV];',                                   // 外层作用域的静态读 ⇒ 必须进枚举
    "const CHAIN_ENV = 'ERIX_A5_CHAIN_PHANTOM';",
    'export const chain = (CHAIN_ENV) => process.env[CHAIN_ENV]',
    '  ?? process.env[CHAIN_ENV];',                            // 续行：仍在体内
    'export const dot = (CHAIN_ENV) => process.env[CHAIN_ENV]',
    '  .concat(process.env[CHAIN_ENV]);',                      // 续行：`(K) => a\n  .b(K)` 同一形
    "const TERN_ENV = 'ERIX_A5_TERN_PHANTOM';",
    'export const tern = (TERN_ENV) => flag',
    '  ? process.env[TERN_ENV]',
    '  : process.env[TERN_ENV];',                              // 跨行三元：两支都在体内
    "const SEMI_ENV = 'ERIX_A5_SEMI_AFTER_OK';",
    'export const semi = (SEMI_ENV) => process.env[SEMI_ENV];',  // 分号收尾：体到此为止
    'process.env[SEMI_ENV];',
  ].join('\n');
  const { keys, unsupported } = scanFixture('asi-arrow-body-end', src);
  assert.deepEqual(keys, ['ERIX_A5_ASI_AFTER_OK', 'ERIX_A5_SEMI_AFTER_OK'],
    `箭头**之后**那两条外层静态读没进枚举（实际 ${JSON.stringify(keys)}）：表达式体的边界算宽了 —— `
    + '省略分号时体必须在行尾（ASI）结束，不许把下一行吞进遮蔽区间（吞了就是一条静态 key 从三腿判据里隐形）');
  assert.deepEqual(unsupported.map((u) => `${u.at} ${u.shape}`), [
    'fx.js:2 process.env[ASI_ENV]',
    'fx.js:5 process.env[CHAIN_ENV]',
    'fx.js:6 process.env[CHAIN_ENV]',
    'fx.js:7 process.env[CHAIN_ENV]',
    'fx.js:8 process.env[CHAIN_ENV]',
    'fx.js:11 process.env[TERN_ENV]',
    'fx.js:12 process.env[TERN_ENV]',
    'fx.js:14 process.env[SEMI_ENV]',
  ],
    `体内动态读该逐条登记的清单不对（实际 ${JSON.stringify(unsupported.map((u) => `${u.at} ${u.shape}`))}）：`
    + '少一条就是体被算窄了（`??` / `.concat()` / 跨行三元那些续行还在体内，把它们当体外就会错记成外层同名常量）；'
    + '多一条就是体被算宽了（把 ASI 之后的外层读也圈了进来）');
  for (const phantom of ['ERIX_A5_CHAIN_PHANTOM', 'ERIX_A5_TERN_PHANTOM']) {
    assert.ok(!keys.includes(phantom),
      `${phantom} 进了枚举：体内（含续行那几行）的读形被算到了体**外面**，于是沿用文件级同名常量 = 幻影 key`);
  }
});

test('活二㉓ 解构形状解析不出 ⇒ fail loudly 进 unsupported，不许静默当成「这里没遮蔽」', () => {
  // ㉑把能认的形状收全了；这一格钉**认不出**的那些：不许静默返回「没绑定」（那等于外层同名常量继续生效，
  // 与㉑那个假绿同形），必须把名字按「遮蔽但解析不出」记账 ⇒ 读形逐条进 `unsupported`。
  // 三形都不是合法解构（`键: 成员表达式` / `键: 调用` / 括号不配对），共同点是**静态上认不出绑定目标**。
  const shapes = {
    'member-expression-target': 'export function weird({ a: LEAK_ENV.c }) { return process.env[LEAK_ENV]; }',
    'call-target': 'export function callish({ a: LEAK_ENV() }) { return process.env[LEAK_ENV]; }',
    'unbalanced-brackets': 'export function broken({ a: [LEAK_ENV } }) { return process.env[LEAK_ENV]; }',
  };
  for (const [name, line] of Object.entries(shapes)) {
    const src = ["const LEAK_ENV = 'ERIX_A5_OPAQUE_PHANTOM';", line].join('\n');
    const { keys, unsupported } = scanFixture(`opaque-${name}`, src);
    assert.deepEqual(keys, [],
      `形状「${name}」的扫描结果里有具体 env 名（实际 ${JSON.stringify(keys)}）：认不出的解构被当成`
      + '「这里没绑定」⇒ 外层同名常量被错记成静态 key。错记比漏记更坏：枚举里那个 key 看起来是对的，'
      + '而真的动态读在 unsupported 里隐形（fail-closed 被绕过）');
    assert.deepEqual(unsupported.map((u) => `${u.at} ${u.shape}`), ['fx.js:2 process.env[LEAK_ENV]'],
      `形状「${name}」那条动态读没进 unsupported（实际 ${JSON.stringify(unsupported.map((u) => u.shape))}）：`
      + '解析不出就必须点名，不许静默放行（不设「记为已知边界」）');
  }
});
// ===========================================================================
// 族 B（issue #587）：登记册的**坐标**与**豁免理由**能不能被糊弄
//
// 这一段的判据口径也只认事实：坐标**在不在树上、那一行到底写了什么、是不是测试面**。
// 三格各自都带方向相反的对照组（真坐标必须绿），因为「把串正文一律抹掉」这种修法
// 会顺手误杀 8 条真登记 —— 误杀真数据同样是判据坏了。
// ===========================================================================

/** 写一个临时**根目录**（`whereProblems` / `validateUnsupported` 都吃 `root` ⇒ 与真树共用同一把尺）。 */
function fixtureRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-coord-'));
  for (const [f, text] of Object.entries(files)) {
    const abs = path.join(dir, f);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return dir;
}

test('活二㉔ B-①.1 `where` 不许指向测试面：默认拒，显式 whereTest 豁免才放行（主 agent 的复现必须红）', () => {
  const { entries } = loadEnvLegExceptions();
  const token = entries.find((e) => e.key === 'ERIX_STATION_TOKEN');
  assert.ok(token, 'ERIX_STATION_TOKEN 还在例外清单里（不许为了让判据变绿删条目）');
  const prob = (patch) => whereProblems([{ ...token, ...patch }], RUNNER_ENV_KEYS).join('\n');
  // ① 复现本体：`where` 指到「把这个名字当字符串写了 7 次」的测试文件 ⇒ 必须红并点名测试代码
  const fake = prob({ where: 'portal/test/provisioner.test.js' });
  assert.match(fake, /坐标指向测试代码/, '把 where 指到测试文件却没人报 ⇒ 「文本命中」又被当成坐标');
  assert.match(fake, /ERIX_STATION_TOKEN/, '红得没有信息 = 没人能修（必须点名是哪个键）');
  // ② 带行也拒：那一行确实是 `'ERIX_STATION_TOKEN='`，但它是**测试断言里的字符串**
  assert.match(prob({ where: 'portal/test/provisioner.test.js:262' }), /坐标指向测试代码/);
  // ③ 仓库根的 `test/**` 与任意 `*.test.js` 同口径
  assert.match(prob({ where: 'test/lib/js-source.mjs:1' }), /坐标指向测试代码/);
  // ④ 反向自证：盘上 27 条真登记的坐标一条都不在测试面，而且全都绿
  assert.deepEqual(whereProblems(entries, RUNNER_ENV_KEYS), [], '盘上那份被测试面守卫误杀了');
  assert.ok(!entries.some((e) => parseCoordRefs(e.where).some((r) => isTestFace(r.rel))),
    '真登记里出现了测试面坐标（那要连带复核这条守卫是不是形同虚设）');
  // ⑤ 豁免必须带理由；配不上坐标的豁免（死豁免）也红
  assert.deepEqual(prob2(token, { where: 'portal/test/provisioner.test.js:262', whereTest: '注入面没有对应文件，只有夹具能核对' }), [],
    '带理由的显式豁免应当放行（否则默认拒就变成了「测试面一律不可用」）');
  assert.deepEqual(prob2(token, { where: 'portal/test/provisioner.test.js:262', whereTest: true, whereTestReason: '同上' }), [],
    '`whereTest: true` + `whereTestReason` 是同一种豁免的另一种写法');
  assert.match(prob({ where: 'portal/test/provisioner.test.js:262', whereTest: true }), /不合法/,
    '光 `whereTest: true`（没理由）就放行 ⇒ 豁免本身成了免证');
  assert.match(prob({ where: 'portal/test/provisioner.test.js:262', whereTest: '   ' }), /不合法/);
  assert.match(prob({ where: 'runner/agentd.js:48', whereTest: '没坐标配的豁免' }), /死豁免/,
    '声明了豁免但坐标不在测试面 ⇒ 留着就是第二本账');
});

/** 单条登记的坐标问题（数组，绿就是空数组）。 */
function prob2(entry, patch) {
  return whereProblems([{ ...entry, ...patch }], RUNNER_ENV_KEYS);
}

test('活二㉕ B-①.2 字符串正文不算坐标：散文串/正则正文/注释红，代码位 + 值位串 + 注入形绿', () => {
  const dir = fixtureRoot({
    'prose.js': "export const note = 'ERIX_B1_PROSE_ONLY 已经在 compose 里接好了';\n",
    'read.js': 'export const v = process.env.ERIX_B1_DOT_READ;\n',
    'table.js': "const T = Object.freeze({ a: 'ERIX_B1_TABLE_NAME' });\nexport const t = T;\n",
    'inject.js': 'export function f(t) { return [`ERIX_B1_INJECT=${t}`]; }\n',
    'regexy.js': 'export const re = /env.ERIX_B1_IN_REGEX/;\n',
    'commented.js': '// export const v = process.env.ERIX_B1_IN_COMMENT;\nexport const w = 1;\n',
  });
  try {
    const probs = (file, key) => whereProblems([{ key, reason: 'r', where: `${file}:1` }], new Map(), dir);
    const prob = (file, key) => probs(file, key).join('\n');
    for (const [file, key] of [
      ['prose.js', 'ERIX_B1_PROSE_ONLY'],   // 散文串里顺带提到
      ['regexy.js', 'ERIX_B1_IN_REGEX'],    // 正则正文里顺带提到
      ['commented.js', 'ERIX_B1_IN_COMMENT'], // 注释正文
    ]) {
      assert.match(prob(file, key), /不含该 key/, `${file}:1 的名字只活在散文/正则/注释里，却还能当坐标 ⇒ 掩码那把尺没生效`);
    }
    for (const [file, key] of [
      ['read.js', 'ERIX_B1_DOT_READ'],       // 代码位
      ['table.js', 'ERIX_B1_TABLE_NAME'],    // 值位串：数据表里挑名字
      ['inject.js', 'ERIX_B1_INJECT'],       // 注入形：`KEY=${v}`
    ]) {
      assert.deepEqual(probs(file, key), [], `${file}:1 是**真坐标**（env 名本来就以这种形状存在）却被误杀`);
    }
    // 真树反向自证：盘上真登记的 env 名**就活在串里**（参数默认值 / 注入模板 / 调用实参 / 数据表）
    const inString = [
      // ⚠ 行号**动态解析**，不硬编码：产品代码一改行号（261117 rebase 实测漂过），硬编码的判据就变成
      // 「断言产品行号」而不是「断言坐标可核对」——那种判据每合一次别人的 PR 就红一次。
      ['ERIX_STATION_TOKEN', `portal/src/provisioner.js:${lineOf('portal/src/provisioner.js', "key = 'ERIX_STATION_TOKEN'")}`],
      ['ERIX_STATION_TOKEN', `portal/src/provisioner.js:${lineOf('portal/src/provisioner.js', 'ERIX_STATION_TOKEN=${token}')}`],
      ['FDE_WORKER_UID', `portal/src/config.js:${lineOf('portal/src/config.js', 'FDE_WORKER_UID')}`],
      [TIMEOUT_KEYS[0], `runner/lib/llm-timeouts.js:${lineOf('runner/lib/llm-timeouts.js', `'${TIMEOUT_KEYS[0]}'`)}`],
    ];
    for (const [key, coord] of inString) {
      const [rel, line] = coord.split(':');
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').split('\n')[Number(line) - 1];
      assert.ok(text.includes(key), `夹具前提破了：${coord} 那一行应当含 ${key}，实际 ${JSON.stringify(text)}`);
      assert.deepEqual(whereProblems([{ key, reason: 'r', where: coord }], RUNNER_ENV_KEYS), [],
        `${coord} 被误杀 ⇒ 「串正文不算坐标」被做成了「串正文一律不认」，那是误杀真登记`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('活二㉖ B-①.3 行范围逐行验（不许静默只验首行）+ `.json`/绝对路径的文案要能照着改', () => {
  const dir = fixtureRoot({
    'range.js': [
      'export const a = process.env.ERIX_B1_RANGE_KEY;',
      'const pad = 1;',
      'export const b = process.env.ERIX_B1_RANGE_KEY;',
    ].join('\n'),
  });
  try {
    const probs = (where) => whereProblems([{ key: 'ERIX_B1_RANGE_KEY', reason: 'r', where }], new Map(), dir);
    const prob = (where) => probs(where).join('\n');
    assert.deepEqual(probs('range.js:1'), []);
    assert.deepEqual(probs('range.js:3'), []);
    assert.deepEqual(probs('range.js:3-3'), [], '`N-N` 就是单行，不该红');
    const wide = prob('range.js:1-3');
    assert.match(wide, /不含该 key/, '第 2 行不含该 key 却没人报 ⇒ 行范围只验了首行（静默放过）');
    assert.match(wide, /第 2 行/, '必须点名是哪一行没过');
    assert.match(wide, /逐行/);
    assert.match(prob('range.js:3-9'), /只有 3 行/);
    assert.match(prob('range.js:3-1'), /行范围是反的/);
    assert.match(prob('range.js:1-40'), />30/, '「整段」不是「一行证据」，要收窄');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // `.json` / 绝对路径：单独出现时红，但文案要能照着改（旧文案报「这是说明文字」是误导）
  const jsonCase = whereProblems(
    [{ key: 'ERIX_STATION_TOKEN', reason: 'r', where: 'deploy/env-legs-exceptions.json:110' }], new Map()).join('\n');
  assert.match(jsonCase, /不是 JS 源文件/);
  assert.match(jsonCase, /reason/, '要告诉人「这条事实写进 reason，where 换成 JS 行」');
  assert.doesNotMatch(jsonCase, /说明文字/, '对 `.json:行` 报「这是说明文字」会把人带偏（它当然是坐标，只是不是 JS 坐标）');
  const absCase = whereProblems(
    [{ key: 'ERIX_STATION_TOKEN', reason: 'r', where: `${path.join(RUNNER_ROOT, 'agentd.js')}:48` }], new Map()).join('\n');
  assert.match(absCase, /绝对路径/);
  assert.match(absCase, /仓库根相对/, '文案要给出具体的改法');
});

test('活二㉗ B-② `unsupported` 不许免证：绑定扫描器确认的读站点 + 理由必须含可核对坐标（虚构读形与乱写理由两条都红）', () => {
  const dir = fixtureRoot({
    'dyn.js': [
      "const T = Object.freeze({ a: 'ERIX_B2_TABLE_NAME' });",
      'export function pick(which, env = process.env) { return env[which]; }',
      'export const lit = process.env.ERIX_B2_STATIC;',
    ].join('\n'),
    'test/probe.js': 'export const x = 1;\nconst T = Object.freeze({ a: ' + "'ERIX_B2_TABLE_NAME'" + ' });\n',
  });
  try {
    const detected = scanEnvReads(dir).unsupported;
    assert.deepEqual(detected.map((d) => `${d.at} ${d.shape}`), ['dyn.js:2 env[which]'],
      `夹具必须先给出真动态读站点（实际 ${JSON.stringify(detected)}）`);
    const ok = [{ at: 'dyn.js:2', read: 'env[which]', reason: '`which` 由调用方传入；同名旋钮的值域见 dyn.js:1' }];   // 三轮④后：引用必须指到读站点或数据表声明行
    assert.deepEqual(validateUnsupported(ok, dir, detected), [], '真读形 + 可核对引用应当绿');
    // ① 虚构读形（扫描器在那个文件里根本没见过这个形状）⇒ 红
    assert.match(validateUnsupported([{ ...ok[0], read: 'globalThis.__env__[which]' }], dir, detected).join('\n'),
      /根本没看到这个读形/);
    // ② 真读形、坐标却不是那一行 ⇒ 红（点名读形真正在哪一行）
    const drift = validateUnsupported([{ ...ok[0], at: 'dyn.js:1' }], dir, detected).join('\n');
    assert.match(drift, /不是这个读形所在的行/);
    assert.match(drift, /dyn\.js:2/, '文案要给出真坐标');
    // ③ 真读形、理由是自由散文 ⇒ 红
    assert.match(validateUnsupported([{ ...ok[0], reason: '扫描器解析不出名字，反正这里没有配置面。' }], dir, detected).join('\n'),
      /自由散文/);
    // ④ 理由里的引用也要过同一把尺
    assert.match(validateUnsupported([{ ...ok[0], reason: '值域见 nope.js:1' }], dir, detected).join('\n'), /文件不存在/);
    assert.match(validateUnsupported([{ ...ok[0], reason: '值域见 dyn.js:2' }], dir, detected).join('\n'),
      /没有任何 env 名的结构化证据/, '引用的那一行必须真的有 env 名（不然就是编的）');
    assert.match(validateUnsupported([{ ...ok[0], reason: '值域见 dyn.js:1-2' }], dir, detected).join('\n'),
      /第 2 行/, '理由里的行范围同样逐行判');
    // 四轮返工后：理由里指向**测试面**的引用不算坐标（当背景说明跳过）⇒ 只剩它一条时退化成「自由散文」。
    // 两种文案都是红，断言接受任一（**行为**是「不给过」，不是「必须说某一句话」）。
    assert.match(validateUnsupported([{ ...ok[0], reason: '值域见 test/probe.js:2' }], dir, detected).join('\n'),
      /坐标指向测试代码|自由散文/);
    assert.match(validateUnsupported([{ ...ok[0], at: 'test/probe.js:2' }], dir, detected).join('\n'), /坐标指向测试代码/);
    // ⑤ 真树：登记必须与扫描器**现在**的读数咬合，理由里必须有带行号的 JS 坐标
    const { unsupported: registered, problems } = loadEnvLegExceptions();
    assert.deepEqual(problems, [], '真树的 `unsupported` 段没过「绑定读站点 + 理由含可核对坐标」这一关');
    assert.deepEqual(registered.map((u) => u.at), RUNNER_SCAN.unsupported.map((d) => d.at),
      '登记的坐标必须就是扫描器现在扫到的那些动态读站点（一条不多、一条不少）');
    for (const u of registered) {
      assert.ok(parseCoordRefs(u.reason).some((r) => JS_SOURCE_EXT.has(r.ext) && r.from != null),
        `${u.at} 的理由里没有带行号的 JS 坐标引用 ⇒ 自由散文豁免：${u.reason}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('活二㉘ 追加腿：文件**首字符**是正则字面量（字符类里含真 //）⇒ 同一行的真读取必须进枚举', () => {
  // `canStartRegex()` 的 `if (prevCh === '') return true;`（文本/文件首字符处 `/` 是正则位）原先**没有判据**。
  // 直调实验（父 agent）：`'/[//]/.test(process.env.ERIX_P3_LINE);'` 的掩码是 `/    /.test(…读取保留)`；
  // 把那条分支改成 `false` 之后掩码变成 `/[                    ` ⇒ 同一行其后全是「行注释」，读取静默消失。
  const src = '/[//]/.test(s); export const v = process.env.ERIX_A2_AT_FILE_START; const half = 1 / 2;';
  const { keys } = scanFixture('file-start-regex', src);
  assert.deepEqual(keys, ['ERIX_A2_AT_FILE_START'],
    `文件首字符那个正则把同一行后面的代码吞了（实际 ${JSON.stringify(keys)}）`
    + ' ⇒ 「首字符处可以是正则」这条分支没判据：认不出它 = 静默漏扫');
  // 反向自证 A：同一形状**不在**首字符时也必须活（判据不许只押首字符那一格）
  const notFirst = scanFixture('not-file-start-regex', `const x = 1;\n${src}`);
  assert.deepEqual(notFirst.keys, ['ERIX_A2_AT_FILE_START']);
  // 反向自证 B：首字符正则**正文里**提到的名字不算读取（同一条分支反过来也不许放宽）
  const body = scanFixture('file-start-regex-body', '/[env.ERIX_A2_PHANTOM]s/.test(s); export const w = process.env.ERIX_A2_REAL_AFTER_BODY;');
  assert.deepEqual(body.keys, ['ERIX_A2_REAL_AFTER_BODY'],
    `首字符正则的正文被当成代码了（实际 ${JSON.stringify(body.keys)}）`);
});

test('活二㉙ 判据数地板：本文件格数 >= 43（族 A 合并后的读数）—— 只增不减，删格要留账', () => {
  const cells = (SELF_TEXT.match(/^test\(/gm) ?? []).length;
  assert.ok(cells >= 43,
    `本文件只剩 ${cells} 格，低于族 A 合并后的地板 30 ⇒ 有人为了让闸门变绿直接删了判据：`
    + '减格必须同时改写判据并留下说明，不许静默减');
});


test('活二㉚ B-①.1 返工：`.spec.*` 也是测试面；豁免面**不许**拿「裸串恰好等于 key」当坐标', () => {
  // #587 族 B 返工（审计 cp-2611171142 第 1 条，10/10）：旧口径只认 `.test.js`，
  // `x.spec.mjs` 漏网；而 `whereTest` 只要理由非空就放行 ⇒ 「只在断言串里出现的假坐标」能过。
  const { entries } = loadEnvLegExceptions();
  const token = entries.find((e) => e.key === 'ERIX_STATION_TOKEN');
  assert.ok(token, 'ERIX_STATION_TOKEN 还在例外清单里（不许为了让判据变绿删条目）');
  // ① 文件名规则本身：**不带** `test/` 目录段的路径也必须被认出（否则这条判据是被目录规则顺带满足的，
  //    把 `.spec` 从正则里删掉它照样绿 —— 父 agent 变异 M-C1 就是这么暴露出来的空刀）
  assert.ok(isTestFace('runner/zz.spec.mjs'), '`.spec.mjs` 必须是测试面（不带 test/ 目录段时也要认）');
  assert.ok(isTestFace('runner/zz.spec.ts'), '`.spec.ts` 同上');
  assert.ok(isTestFace('runner/zz.test.mjs'), '`.test.mjs` 同上');
  assert.ok(!isTestFace('runner/lib/real-module.js'), '产品代码不许被误判成测试面（否则真坐标全被杀）');
  // ② 豁免面：拿**只含裸串**的测试行当坐标 ⇒ 必须仍红（豁免只放宽「测试面」，不放宽「真读取」）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-gate-waiver-'));
  try {
    fs.mkdirSync(path.join(tmp, 'test'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'test/probe.js'), "assert.ok('ERIX_STATION_TOKEN');\n");
    const bare = whereProblems(
      [{ ...token, where: 'test/probe.js:1', whereTest: '这是真站点' }], RUNNER_ENV_KEYS, tmp).join('\n');
    assert.match(bare, /不含该 key/, '`whereTest` 豁免下拿裸串当坐标必须仍红（审计实测可绕过的那条）');
    // ③ 反向自证：**注入形** `KEY=…` 在豁免下仍算（真站点不许被杀）
    fs.writeFileSync(path.join(tmp, 'test/inject.js'), "const e = `ERIX_STATION_TOKEN=${tok}`;\n");
    assert.deepEqual(
      whereProblems([{ ...token, where: 'test/inject.js:1', whereTest: '注入面' }], RUNNER_ENV_KEYS, tmp), [],
      '注入形 `ERIX_X=…` 是真站点，豁免下必须仍能过');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  // ④ 盘上 27 条真登记的坐标一条都不在测试面，而且全都绿
  assert.deepEqual(whereProblems(entries, RUNNER_ENV_KEYS), [], '盘上那份被测试面守卫误杀了');
});

test('活二㉛ B-①.2 返工：**正则正文**不算坐标（数据表裸串仍算）', () => {
  // #587 族 B 返工（审计第 2 条）：`const re = /ERIX_X/;` 里那一行被当成有效坐标。
  const { entries } = loadEnvLegExceptions();
  const token = entries.find((e) => e.key === 'ERIX_STATION_TOKEN');
  // 造一个**真存在**的临时 root：正则正文里有 key，另一行是数据表裸串
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-gate-regex-'));
  try {
    fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'lib/re.js'),
      "const re = /ERIX_STATION_TOKEN/;\nexport const TABLE = { a: 'ERIX_STATION_TOKEN' };\n");
    const prob = (where) => whereProblems([{ ...token, where }], RUNNER_ENV_KEYS, tmp).join('\n');
    assert.match(prob('lib/re.js:1'), /不含该 key/,
      '正则正文里出现 key 不算坐标（正则不是代码）');
    assert.deepEqual(whereProblems([{ ...token, where: 'lib/re.js:2' }], RUNNER_ENV_KEYS, tmp), [],
      '数据表裸串那一行必须仍算坐标（否则 27 条真登记里会误杀）');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  // 反向自证（真仓库）：盘上那条靠裸串坐标的登记必须仍绿
  assert.deepEqual(whereProblems(entries, RUNNER_ENV_KEYS), [],
    '盘上那份被这条守卫误杀了');
});

test('活二㉜ B-①.3 返工：行范围语法严格（`:10-` / `0-x` / 倒序 一律拒）', () => {
  // #587 族 B 返工（审计第 3 条）：`:10-` 被当成 `:10` 静默接受；`0-3` 也能过（行 0 映射到首行）。
  const refs = parseCoordRefs('a.js:10- b.js:0-3 c.js:12-10 d.js:414 e.js:10-12');
  const by = (f) => refs.find((r) => r.rel === f);
  assert.equal(by('a.js').badRange, true, '`:10-`（缺右端点）必须标坏 —— 审计实测被当成 `:10` 接受');
  assert.equal(by('b.js').badRange, true, '`:0-3` 必须标坏（行号从 1 起）');
  assert.equal(by('d.js').badRange, false, '`:414` 是合法单行坐标，不许误杀');
  assert.equal(by('e.js').badRange, false, '`:10-12` 是合法区间');
  const { entries } = loadEnvLegExceptions();
  const token = entries.find((e) => e.key === 'ERIX_STATION_TOKEN');
  const prob = (where) => whereProblems([{ ...token, where }], RUNNER_ENV_KEYS).join('\n');
  assert.match(prob('portal/src/provisioner.js:414-'), /语法不合法/, '`:414-` 必须红');
  assert.match(prob('portal/src/provisioner.js:0-3'), /语法不合法/, '`:0-3` 必须红');
  assert.match(prob('portal/src/provisioner.js:414-390'), /行范围是反的/, '倒序必须红');
});

test('活二㉝ B-② 返工：`unsupported` 的理由必须指到**这条动态读**或它的数据表声明行', () => {
  // #587 族 B 返工（审计第 4 条）：旧口径只要理由里有一个「含任意 env 名的合法行」就算过
  // ⇒ 堆一行无关代码就能豁免。
  // 行号动态解析（同上）：`process.env[name]` 的读站点 / 字面量对数组 / 一条无关的 env 读行，都按内容找。
  const dynLine = lineOf('runner/worker.js', 'process.env[name]');
  const tableLine = lineOf('runner/worker.js', "['ERIX_DELEGATE_MAX'");
  const unrelated = lineOf('runner/worker.js', 'process.env.ERIX_DELEGATE_ENABLED');
  const real = { at: `runner/worker.js:${dynLine}`, read: 'process.env[name]', reason: '' };
  const withReason = (reason) => validateUnsupported([{ ...real, reason }], REPO_ROOT, null).join('\n');
  // ① 指到无关行（那行有 env 名、但跟 `process.env[name]` 无关）⇒ 红
  // ① 无关行：`runner/worker.js:800` 是**合法代码位**的 env 读（`process.env.ERIX_DELEGATE_ENABLED`），
  //    但它跟 `runner/worker.js:819` 的 `process.env[name]` 毫无关系 ⇒ 必须红
  assert.match(withReason(`随便一句，见 \`runner/worker.js:${unrelated}\``),
    /没有一个引用指到这条动态读/, '拿无关行充数必须红');
  // ② 指到读站点本身 ⇒ 绿
  // ② 指到读站点本身 ⇒ **不因「相关性」被拒**（那行是动态读、没有字面 env 名，
  //    会撞上既有的「行证据」那把尺 —— 那是另一条判据，不是相关性判据的锅）
  assert.doesNotMatch(withReason(`读站点见 \`runner/worker.js:${dynLine}\``), /没有一个引用指到这条动态读/,
    '覆盖读站点那一行必须算「相关」，不许被相关性判据拒');
  // ③ 指到数据表声明行（含动态 key 的标识符 `name`）⇒ 绿（盘上那条真登记就是这形）
  assert.deepEqual(validateUnsupported([{ ...real, reason: `名字来自 \`runner/worker.js:${tableLine}-${tableLine + 2}\` 的字面量对数组` }], REPO_ROOT, null), [],
    '数据表声明行必须放行（否则真登记被杀）');
  // ④ 盘上那条真登记必须仍绿
  const doc = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'deploy/env-legs-exceptions.json'), 'utf8'));
  assert.deepEqual(validateUnsupported(doc.unsupported ?? [], REPO_ROOT, null), [], '盘上真登记被误杀了');
});


test('活二㉞ B-①②④ 三轮返工：对象键位不算坐标 / 文件级豁免同样不许裸串 / env 读行不是数据表声明', () => {
  // 三条都是审计 cp-2611171231 实测出来的绕过，各给一个决定性夹具。
  const { entries } = loadEnvLegExceptions();
  const token = entries.find((e) => e.key === 'ERIX_STATION_TOKEN');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-gate-r3-'));
  try {
    fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'test'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'lib/objkey.js'), "const item = { 'ERIX_STATION_TOKEN': 1 };\n");
    fs.writeFileSync(path.join(tmp, 'test/waive.js'), "assert.ok('ERIX_STATION_TOKEN');\n");
    const prob = (where, extra = {}) => whereProblems([{ ...token, where, ...extra }], RUNNER_ENV_KEYS, tmp).join('\n');
    // ① 对象**键位**串不算坐标（审计：`{'ERIX_X': 1}` 曾被接受）
    assert.match(prob('lib/objkey.js:1'), /不含该 key/,
      '对象键位（属性名）不是数据证据，必须红');
    // ①b **计算键** `{ ['ERIX_X']: 1 }`：闭引号后跟 `]` 再跟 `:`（审计四轮实测可绕过）
    fs.writeFileSync(path.join(tmp, 'lib/computed.js'), "const item = { ['ERIX_STATION_TOKEN']: 1 };\n");
    assert.match(prob('lib/computed.js:1'), /不含该 key/, '计算键位也不是数据证据，必须红');
    // ①c **裸标量声明**不算数据表：`const MSG = 'ERIX_X'` 只是文案（审计四轮实测能背书动态读）
    fs.writeFileSync(path.join(tmp, 'lib/scalar.js'), "const MSG = 'ERIX_STATION_TOKEN';\n");
    assert.match(prob('lib/scalar.js:1'), /不含该 key/, '裸标量声明不是数据表，必须红');
    // ①d 反向自证：**容器内**的值位裸串仍算（真数据 `config.js:391` 那种）
    fs.writeFileSync(path.join(tmp, 'lib/table.js'), "export const T = { a: 'ERIX_STATION_TOKEN' };\n");
    assert.deepEqual(whereProblems([{ ...token, where: 'lib/table.js:1' }], RUNNER_ENV_KEYS, tmp), [],
      '容器内的值位裸串必须仍算坐标（否则真数据里的数据表登记会被误杀）');
    // ② 文件级引用（不带行号）在**豁免**下也不许吃裸串（旧代码在这里漏传豁免选项）
    const waived = prob('test/waive.js', { whereTest: '这是真站点' });
    assert.match(waived, /只给了文件|不含该 key|注释背书|没发现对/,
      '文件级 + 豁免 也不许拿裸串当坐标（实际：' + waived.slice(0, 160) + '）');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  // ③ `unsupported.reason` 的 ±3 邻域不许拿**另一条 env 读行**当数据表声明背书
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-gate-r3b-'));
  try {
    fs.writeFileSync(path.join(dir, 'near.js'), [
      'const TABLE = { a: 1 };',                                   // 1
      'export const stat = process.env.ERIX_R3_STATIC;',            // 2
      'export function pick(name, env = process.env) {',            // 3
      '  const unrelated = process.env.ERIX_R3_UNRELATED + name;',  // 4 ← 无关的 env 读行，含 name
      '  return env[name];',                                        // 5 ← 真动态读
      '}',                                                          // 6
    ].join('\n'));
    const at = 'near.js:5';
    const bad = validateUnsupported([{ at, read: 'env[name]', reason: '见 near.js:4' }], dir, null).join('\n');
    assert.match(bad, /没有一个引用指到这条动态读/,
      '把「另一条 env 读行」当数据表声明背书必须红（审计实测可绕过）');
    const good = validateUnsupported([{ at, read: 'env[name]', reason: '读站点见 near.js:5' }], dir, null);
    assert.ok(!good.some((x) => /没有一个引用指到这条动态读/.test(x)),
      '覆盖读站点本身必须算「相关」（那行没字面 env 名，会被另一把尺拦，不是相关性判据的锅）');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/**
 * #587 第 1 步的夹具（**内联临时目录**，不是盘上的 `portal/test/fixtures/`）。理由三条：
 *   ① 本文件已有的夹具都是 `fixtureRoot()` 现搭临时目录（活二㉕㉖㉗ 同一口径），新开一棵盘上
 *      夹具树 = 两套夹具约定；
 *   ② `scanTargets` 的 `SCAN_SKIP_DIRS` 与 `isTestFace` 都认 `fixtures` / `test` ⇒ 盘上夹具会被
 *      真树扫描跳过、被坐标尺当测试面拒，索引口径反而要多一层解释；
 *   ③ 内联夹具的源码就在断言旁边 ⇒ 报告里能直接指「第几行是什么形状」，不用再去读一个文件。
 * ⚠ 行号是**约定**（`SI_L` 就是行号表）：夹具改一行内容要跟着改 `SI_L`，这一格的价就在这儿。
 */
const SI_FILES = {
  'lib/read.js': [
    'export const v = process.env.ERIX_SI_FIX_KEY;',   // SI_L.dot      真读站点（点号形）
    'export const msg = `ERIX_SI_FIX_KEY=${v}`;',   // SI_L.log      日志模板（形似注入的假坐标）
    "export const rows = [{ key: 'OTHER', reason: 'ERIX_SI_FIX_KEY' }];",   // SI_L.reason 数据对象的值位串
    'export const pad = 1;',   // SI_L.pad      同文件里没读这个 key 的另一行
    // SI_L.twice：同一行读两次（索引不许折叠成一条）
    'export const twice = process.env.ERIX_SI_FIX_KEY || process.env.ERIX_SI_FIX_KEY;',
    "const OTHER_ENV = 'ERIX_SI_FIX_OTHER';",   // SI_L.otherDecl  常量名（不是读形）
    'export const alias = process.env[OTHER_ENV];',   // SI_L.otherRead 常量名下标读
  ].join('\n'),
  'lib/table.js': [
    "const LLM_TABLE = Object.freeze({ a: 'ERIX_SI_FIX_TABLE' });",   // SI_L.table 数据表声明行（不是读站点）
    // SI_L.tableRead：真读站点（行内没有 env 名字面量，名字从表里来）
    'export function pick(f, env = process.env) { const name = LLM_TABLE[f]; return env?.[name]; }',
  ].join('\n'),
  'lib/only-string.js': "export const note = 'ERIX_SI_FIX_STRAY 只是文案';\n",   // SI_L.stray
};
const SI_L = {
  dot: 1, log: 2, reason: 3, pad: 4, twice: 5, otherDecl: 6, otherRead: 7,
  table: 1, tableRead: 2, stray: 1,
};
const SI_KEY = 'ERIX_SI_FIX_KEY';
const siEntry = (where, key = SI_KEY) => ({ key, reason: '夹具：影子判定的靶子', where });

/** 建夹具 + 索引（每格自己搭自己拆，不共享临时目录）。 */
function siFixture() {
  const dir = fixtureRoot(SI_FILES);
  return { dir, index: buildEnvSiteIndex(dir) };
}

/** 影子尺对单条夹具登记的问题（数组，绿就是空数组）。 */
function siProblems(dir, index, where, key = SI_KEY) {
  return siteIndexProblems([siEntry(where, key)], index, dir);
}

test('#587-S1-① 索引形状：一比一转自扫描器产出（同文件多行 / 同一行两次读都分得开），注入位是空槽', () => {
  const { dir, index } = siFixture();
  try {
    // ① 索引必须是 `scanEnvReads()` 产出的一比一转置 —— **不许第二套解析**：站点逐条比。
    const fromScan = [];
    for (const [key, perFile] of index.keys) {
      for (const [rel, list] of perFile) {
        for (const s of list) fromScan.push(`${rel}:${s.line} ${key} ${s.shape}`);
      }
    }
    const fromIndex = [];
    for (const key of index.keys.keys()) {
      for (const s of index.sitesOf(key)) fromIndex.push(`${s.rel}:${s.line} ${key} ${s.shape}`);
    }
    assert.deepEqual(fromIndex.sort(), fromScan.sort(), '索引与扫描器产出不一致 ⇒ 索引自己加了货或掉了货');
    assert.ok(index.keyCount() >= 3 && index.siteCount() >= 4,
      `夹具前提破了：${index.keyCount()} keys / ${index.siteCount()} 站点`);
    // ② 同文件**多行**分得开
    assert.deepEqual(index.linesOf(SI_KEY, 'lib/read.js'), [SI_L.dot, SI_L.twice],
      '同文件两处真读站点必须逐行登记（折叠成文件级 = M-2 那把刀要抓的东西）');
    // ③ 同一行**读两次**不许折叠成一条
    assert.equal(index.readSites.get(SI_KEY).get('lib/read.js').get(SI_L.twice).length, 2,
      '同一行两次读取被折叠 ⇒ 索引丢信息（`env.A || env.A` 那种读形就看不见了）');
    // ④ 常量名 / 数据表那两形也要有站点（真登记里就有：`runner/lib/llm-timeouts.js:103`）
    assert.deepEqual(index.linesOf('ERIX_SI_FIX_OTHER', 'lib/read.js'), [SI_L.otherRead]);
    assert.deepEqual(index.linesOf('ERIX_SI_FIX_TABLE', 'lib/table.js'), [SI_L.tableRead]);
    // ⑤ 注入站点是**留好的空槽**：现在恒空，但 `addInjectionSite` 一填 `hasSite` 就得认
    assert.equal(index.injections.size, 0, '第 1 步不许提前把注入站点接进来（那会改变影子口径）');
    assert.equal(index.hasSite(SI_KEY, 'lib/read.js', SI_L.log), false);
    index.addInjectionSite(SI_KEY, 'lib/read.js', SI_L.log);
    assert.equal(index.hasSite(SI_KEY, 'lib/read.js', SI_L.log), true,
      '注入站点的入口失效了 ⇒ 第 3 步往这张表里填东西会白填（那是空的洞，不是空的槽）');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#587-S1-② 夹具 1：where 指日志模板那一行 ⇒ 影子判红，而旧启发式放行（证明闸门行为没变）', () => {
  const { dir, index } = siFixture();
  try {
    const coord = `lib/read.js:${SI_L.log}`;
    const why = siProblems(dir, index, coord).join('\n');
    assert.match(why, /不是 ERIX_SI_FIX_KEY 的读站点/,
      '那一行是形似注入的日志模板（审计 #12 的形状：KEY=${v} 活在 console.log 的模板里），影子尺必须红');
    assert.match(why, /lib\/read\.js:1\(dot\)/, `红得没信息：文案要指出真读站点在第 ${SI_L.dot} 行`);
    // 反向自证：旧启发式**放行**它 ⇒ 本格杀的是影子尺的牙；闸门（旧尺）口径一个字都没动
    assert.deepEqual(whereProblems([siEntry(coord)], new Map(), dir), [],
      '旧启发式对日志模板的口径变了 ⇒ 本格的对照前提破了（产品形变了或闸门被动过）');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#587-S1-③ 夹具 2：where 指数据对象里 reason 值那一行 ⇒ 影子判红，旧启发式放行', () => {
  const { dir, index } = siFixture();
  try {
    const coord = `lib/read.js:${SI_L.reason}`;
    const why = siProblems(dir, index, coord).join('\n');
    assert.match(why, /不是 ERIX_SI_FIX_KEY 的读站点/, '那一行只是数据对象里的值位串（审计 #10 的形状）');
    assert.match(why, /reason|值位串|文案/, '文案要说清它是什么形状，不然人不知道怎么改');
    assert.deepEqual(whereProblems([siEntry(coord)], new Map(), dir), [], '旧启发式口径：值位串算坐标（本步不改它）');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#587-S1-④ 夹具 3：where 指真读站点 ⇒ 影子判绿（点号形 / 常量名下标形 / 表驱动形都不许误杀）', () => {
  const { dir, index } = siFixture();
  try {
    const green = [
      [`lib/read.js:${SI_L.dot}`, SI_KEY],
      [`lib/read.js:${SI_L.twice}`, SI_KEY],
      [`lib/read.js:${SI_L.otherRead}`, 'ERIX_SI_FIX_OTHER'],
      [`lib/table.js:${SI_L.tableRead}`, 'ERIX_SI_FIX_TABLE'],   // 行内没字面量，名字从数据表来
    ];
    for (const [coord, key] of green) {
      assert.deepEqual(siProblems(dir, index, coord, key), [],
        `${coord} 是扫描器登记的**真读站点**却被影子判红 ⇒ 切换后会误杀真登记（#557 那一族）`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#587-S1-⑤ 夹具 4：where 指同文件里没读这个 key 的另一行 ⇒ 影子判红（M-2 的靶子）', () => {
  const { dir, index } = siFixture();
  try {
    const coord = `lib/read.js:${SI_L.pad}`;
    const why = siProblems(dir, index, coord).join('\n');
    assert.match(why, /不是 ERIX_SI_FIX_KEY 的读站点/, `${coord} 那一行什么都没读，只因同文件别处读了它`);
    assert.match(why, /lib\/read\.js:1\(dot\)/, '必须指出真站点在哪几行（照着改才有方向）');
    assert.match(why, /lib\/read\.js:5\(dot\)/, '两处真读站点都要列出来（同文件多行不许被折叠）');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#587-S1-⑥ 文件级引用与多引用：每个引用都要成立，文件级要求那个文件真的读了它', () => {
  const { dir, index } = siFixture();
  try {
    // 文件级：那个文件真读了这个 key ⇒ 绿
    assert.deepEqual(siProblems(dir, index, 'lib/read.js'), [], '文件级引用：那个文件确实读了它却被判红 = 误杀');
    // 文件级：key 只在文案里出现 ⇒ 红
    const stray = siProblems(dir, index, 'lib/only-string.js', 'ERIX_SI_FIX_STRAY').join('\n');
    assert.match(stray, /没有对 ERIX_SI_FIX_STRAY 的读站点/, '只有串里提到的文件不能当文件级坐标');
    // 多引用：一真一假 ⇒ 必须红，并且**点名是第二个**（旧尺也是每条都验，口径对齐）
    const two = `lib/read.js:${SI_L.dot}；lib/read.js:${SI_L.pad}`;
    const multi = siProblems(dir, index, two).join('\n');
    assert.match(multi, /第 2 个引用 lib\/read\.js:4/, '多引用只验第一条就放行 ⇒ `a.js:1；b.js:2` 会漏验');
    assert.doesNotMatch(multi, /第 1 个引用 lib\/read\.js:1/, '第 1 个是真站点，不该被报');
    // 行范围逐行：范围里夹一行没读 ⇒ 红并点名那一行
    const range = siProblems(dir, index, `lib/read.js:${SI_L.dot}-${SI_L.pad}`).join('\n');
    assert.match(range, /第 2 行|第 3 行|第 4 行/, '行范围不许静默只验首行');
    // 卫生检验走**同一把尺**（否则对照噪声分不清「不是站点」还是「坐标写坏了」）
    const badExt = [{ key: SI_KEY, reason: 'r', where: 'lib/x.json:1' }];
    const strayJson = siteIndexProblems(badExt, index, dir).join('\n');
    assert.match(strayJson, /不是 JS 源文件/);
    assert.match(siProblems(dir, index, 'lib/nope.js:1').join('\n'), /文件不存在/);
    assert.match(siProblems(dir, index, `${path.join(dir, 'lib/read.js')}:1`).join('\n'), /绝对路径/);
    assert.match(siteIndexProblems([{ key: SI_KEY, reason: 'r' }], index, dir).join('\n'),
      /缺 where/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#587-S1-⑦ 影子尺只认结构：注释行 / 散文串都红，真站点绿（索引不等于「文件里提过」）', () => {
  const dir = fixtureRoot({
    'a.js': [
      '// export const v = process.env.ERIX_SI_C_COMMENT;',   // 1 注释里的旧代码（#557 的翻车形状）
      "export const note = 'ERIX_SI_C_COMMENT 已接好';",   // 2 散文串
      'export const real = process.env.ERIX_SI_C_COMMENT;',   // 3 真读站点
    ].join('\n'),
  });
  try {
    const index = buildEnvSiteIndex(dir);
    assert.deepEqual(index.linesOf('ERIX_SI_C_COMMENT', 'a.js'), [3],
      '注释 / 串正文被算成了读站点 ⇒ 索引不再等于扫描器给的事实');
    for (const ln of [1, 2]) {
      assert.match(siProblems(dir, index, `a.js:${ln}`, 'ERIX_SI_C_COMMENT').join('\n'),
        /不是 ERIX_SI_C_COMMENT 的读站点/, `第 ${ln} 行不是读站点却被影子放行`);
    }
    assert.deepEqual(siProblems(dir, index, 'a.js:3', 'ERIX_SI_C_COMMENT'), []);
    // 旧尺对注释行同样红（这一维两边同向）⇒ 本格不是在重复旧尺，是在钉「索引=扫描器事实」
    const old = whereProblems([siEntry('a.js:1', 'ERIX_SI_C_COMMENT')], new Map(), dir).join('\n');
    assert.match(old, /不含该 key/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// #587 第 1 步返修（review 两条 MED）。**这段只做一件事**：把「差异属于哪一类」从
// *路径/文本形状* 换成 *可复核的语法与索引事实*，并把 portal 侧的 helper 间接读**推**出来。
//
// MED① 的病（原 `shadowGapClass()`）：`rel === 'portal/src/provisioner.js'` ⇒ `injection`、
// `rel === 'portal/src/config.js'` ⇒ `host-source`、行内含 key ⇒ `mention-only`。三条都是**拿文本
// 猜语义** —— 和被换掉的那把闸门是同一个病。第 4 步要拿这份分类决定「切换前补什么」，
// 分类错了就补错方向（同文件的任意同名注释/散文坐标都能被算进已知类）。现在的三条判据：
//   `injection`     该 key 的字面出现落在**容器 env 组装位**（`Env: […]` 数组 / `.Env.push(…)` 参数 /
//                   `buildContainerConfig({ env: […] })` 的选项数组；第三条由**现跑产品代码**证明流入）；
//   `host-source`   该坐标是 `deriveHostSourceSites()` 推出来的「helper 间接读」站点（见下面 F1–F3）；
//   `mention-only`  该 key 在这一行是**被声明的字符串值**（`const-init` / `table-member` /
//                   `default-param` 三形之一）**且**该 key 在索引里另有真读站点 —— 两个事实缺一不可；
//   `null`          三条都不成立 ⇒ **必须红**（`#587-S1-⑧` 的 `unexplained` + `#587-S1-⑨` 直接钉）。
// 形状尺（路径 + 行内含 key）只留作**兜底**，并且**计数**：`#587-S1-⑧` 断言真树 `fallbackCount === 0`。
//
// MED② 的病：`portal/src/config.js` 的 `intEnv(env, 'FDE_WORKER_UID', 1002)` 是**合法**的 portal 侧
// env 读取（helper 用 `env[key]` 取值），但那条读站点扫描器看不见（动态下标进 `unsupported`）⇒
// 影子判它「不是读站点」。这是**误杀**，不能叫「仅仅提到 key」（那是把真读取登记成文案），也不能
// 并进 runner 读站点（那是另一个来源）。所以：不手抄坐标，而是**从扫描器已有的 `unsupported` +
// 调用点的字符串实参把站点推出来**（`deriveHostSourceSites`），登记进第三张表 `hostSources`。
// `host-source` 的语义定义：**env 对象由调用方传入、key 由调用点以字符串实参给出、调用点在 runner
// 包外**（runner 是这把闸门的枚举根 ⇒ 包外的读天然不是「本站 runner 的读站点」，而是另一个来源）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 源码事实表：`剥注释码文 / 结构掩码 / 括号配对`。三件都来自**已有**的那两把尺
 * （`stripComments` / `structuralMask` / `bracketPairs`）—— 本函数不新增解析器
 * （第二套解析 = 第二本账，#557/#587 反复付账的那个形状）。
 * @returns {{text:string,code:string,masked:string,pairs:Map<number,number>}|null}
 */
function srcFacts(root, rel) {
  const id = `${root}\u0000${rel}`;
  if (SRC_FACTS.has(id)) return SRC_FACTS.get(id);
  let f = null;
  try {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const code = stripComments(text);          // 注释 → 空格（**串正文留着**）
    const masked = structuralMask(text);       // 再把串/正则正文抹平 ⇒ 括号配平用这份
    f = { text, code, masked, pairs: bracketPairs(masked) };
  } catch { f = null; }
  SRC_FACTS.set(id, f);
  return f;
}
const SRC_FACTS = new Map();

/** 偏移 → 行号（1 起）。那两把尺都保留行列位 ⇒ 数换行就是行号（扫描器同一口径）。 */
function lineAt(text, offset) {
  let n = 1;
  for (let i = 0; i < offset; i += 1) if (text[i] === '\n') n += 1;
  return n;
}

/** 包住 `offset` 的括号对，**由内到外**（`close` 不含）—— 判「这个位置在哪个语法壳里」用。 */
function enclosingPairs(masked, pairs, offset) {
  const out = [];
  for (const [open, close] of pairs) {
    if (open < offset && offset < close) out.push({ open, close, kind: masked[open] });
  }
  return out.sort((a, b) => b.open - a.open);
}

/** 容器 `[from, to)` 里 `to` 之前最后一个**深度 0** 的 `want` 字符（`{ a: 1, b: 2 }` 只看见顶层那些）。 */
function lastTopChar(masked, from, to, want) {
  let found = -1;
  let depth = 0;
  for (let i = from; i < to; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (depth === 0 && want(c, i)) found = i;
  }
  return found;
}

/** 该 key 在 `[from, to)` 里的**字面出现**位置（词边界；注释已被 `code` 抹平 ⇒ 注释里的不算）。 */
function keyOffsetsIn(code, from, to, key) {
  const out = [];
  const re = new RegExp(`(?<![\w$.])${escRe(key)}(?![\w$])`, 'g');
  for (const m of code.slice(from, to).matchAll(re)) out.push(from + m.index);
  return out;
}

/**
 * `[from, to)` 里**整串正文恰好等于这个 key** 的字符串字面量。认法：`masked` 抹平了正文而 `code` 没抹
 * ⇒ 那是串正文；两侧定界符是同款引号 ⇒ 那是个**独立**字符串字面量（`'ERIX_X'`）。
 * `` `ERIX_X=${v}` `` 进不来（右邻是 `$`）—— 注入形不是「被声明的名字」，正好交给 `injection` 判据。
 */
function exactStringLiterals(code, masked, from, to, key) {
  const out = [];
  const body = (k) => k < to && masked[k] === ' ' && code[k] !== ' ' && code[k] !== '\n';
  let i = from;
  while (i < to) {
    if (!body(i)) { i += 1; continue; }
    let j = i;
    while (body(j)) j += 1;
    const q = i > 0 ? code[i - 1] : '';
    if ((q === "'" || q === '"') && code[j] === q && code.slice(i, j) === key) {
      out.push({ bodyStart: i, bodyEnd: j, qStart: i - 1, qEnd: j + 1 });
    }
    i = j + 1;
  }
  return out;
}

/** `env` 选项 ⇒ `body.Env` 的**执行证明**（现跑产品代码，跑一次缓存）。证不出来 ⇒ 那条判据不放行。 */
const ENV_FLOW_OPTS = {
  fdeName: 'fde-flow-probe', containerName: 'c', image: 'i', cmd: ['-port', '4000'],
  networkName: 'n', ip: '1.2.3.4', gateway: '1.2.3.1', baseDomain: 'd.example',
  llmHost: 'llm.d.example', portalPublicBaseUrl: 'https://station.d.example',
};
const ENV_FLOW_PROBE = 'ERIX_SI_FLOW_PROBE_KEY=1';
const ENV_BUILDER_NAME = 'buildContainerConfig';
/** 「那个 `(` 是 `buildContainerConfig(…)` 的实参括号」的形状（在结构掩码上看 ⇒ 串正文里的名字不算）。 */
const BUILDER_HEAD_RE = new RegExp(`${ENV_BUILDER_NAME}\\s*$`);
const { buildContainerConfig } = await import('../src/provisioner.js');
let envFlowProof = null;
function envOptionFlowsIntoEnvArray() {
  if (envFlowProof === null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-flow-'));
    try {
      const body = buildContainerConfig(
        { ...ENV_FLOW_OPTS, userSpaceRoot: dir, env: [ENV_FLOW_PROBE] });
      envFlowProof = { holds: Array.isArray(body?.Env) && body.Env.includes(ENV_FLOW_PROBE) };
    } catch (e) {
      envFlowProof = { holds: false, error: e.message };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  return envFlowProof.holds;
}

/**
 * 「**容器 env 的组装位**」= 三个**语法位置**（`rel` 只用来读文件，**不参与判断** —— MED① 的牙）：
 *   `Env[]`        对象字面量里名为 `Env` 的**数组**成员值（Docker create body；`Env` 是 Docker API 字段名）
 *   `Env.push()`   `x.Env.push( … )` 的参数区
 *   `env-opt[]`    名为 `env` 的数组成员值，且它处在 `buildContainerConfig( … )` 的**实参**里
 *                  ——「这个选项会流进 `body.Env`」由 `envOptionFlowsIntoEnvArray()` 现跑产品代码证明，
 *                  不是注释说的。审计当时把 `:410` 记成「只有在证明它流入 `body.Env` 之后才算来源」。
 * @returns {Array<{kind:string,from:number,to:number,fromLine:number,toLine:number,at:string}>}
 */
function envAssemblySpans(root, rel) {
  const id = `${root}\u0000${rel}`;
  if (ENV_SPANS.has(id)) return ENV_SPANS.get(id);
  const f = srcFacts(root, rel);
  const out = [];
  const push = (kind, from, to, at) => out.push({
    kind, from, to, at,
    fromLine: lineAt(f.code, from), toLine: lineAt(f.code, Math.max(from, to - 1)),
  });
  const arrayValueOf = (propRe) => {
    const found = [];
    if (!f) return found;
    for (const m of f.code.matchAll(propRe)) {
      if (!isCodePosition(f.code, f.masked, m.index, m[0].length)) continue;   // 串正文里的「Env:」不算
      const lb = nextNonSpace(f.masked, m.index + m[0].length);
      if (lb == null || f.masked[lb] !== '[') continue;                        // 值不是数组 ⇒ 不是注入位
      const end = matchBrackets(f.masked, lb);
      if (end != null) found.push({ lb, end, at: lineAt(f.code, m.index) });
    }
    return found;
  };
  if (f) {
    for (const x of arrayValueOf(/\bEnv\s*:\s*/g)) {
      push('Env[] 数组字面量', x.lb, x.end, `第 ${x.at} 行的 \`Env:\``);
    }
    for (const m of f.code.matchAll(/\.\s*Env\s*\.\s*push\s*\(/g)) {
      if (!isCodePosition(f.code, f.masked, m.index, m[0].length)) continue;
      const open = m.index + m[0].length - 1;
      const close = matchGroup(f.masked, open);
      if (close == null) continue;
      push('Env.push() 参数位', open + 1, close - 1, `第 ${lineAt(f.code, m.index)} 行的 \`.Env.push(\``);
    }
    if (envOptionFlowsIntoEnvArray()) {
      for (const x of arrayValueOf(/\benv\s*:\s*/g)) {
        const builderCall = enclosingPairs(f.masked, f.pairs, x.lb).some((w) => w.kind === '(' &&
          BUILDER_HEAD_RE.test(f.masked.slice(Math.max(0, w.open - 40), w.open)));
        if (!builderCall) continue;
        push('env-opt[] 选项数组（已执行证明流入 body.Env）', x.lb, x.end,
          `${ENV_BUILDER_NAME}({ env: … }) 的第 ${x.at} 行`);
      }
    }
  }
  ENV_SPANS.set(id, out);
  return out;
}
const ENV_SPANS = new Map();

/**
 * 这一行上的 env 名是**被声明**还是在干别的 —— 三个语法形（都要求「整串正文就是这个 key」）：
 *   `const-init`    `const X = 'ERIX_X'`（常量声明的右值）
 *   `table-member`  `{ field: 'ERIX_X' }`（对象字面量成员的值位，且那个字面量**绑在名字上**）
 *   `default-param` `function f(x, key = 'ERIX_X')`（参数默认值）
 * 三形都不是「对 env 对象取值」⇒ 这一行**不可能**是读站点。返回 `null` = 不像声明位（不猜）。
 */
function keyDeclFormAt(f, lit) {
  const { masked, pairs } = f;
  const back = (n) => masked.slice(Math.max(0, lit.bodyStart - n), lit.bodyStart);
  if (/(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*['"]$/.test(back(80))) return 'const-init';
  const wrap = enclosingPairs(masked, pairs, lit.bodyStart);
  const inner = wrap[0];
  if (!inner) return null;
  if (inner.kind === '{') {
    const colon = lastTopChar(masked, inner.open + 1, lit.qStart, (c) => c === ':');
    if (colon < 0 || masked.slice(colon + 1, lit.qStart).trim() !== '') return null;  // 冒号后还有代码
    const DECL_HEAD = /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:Object\.\w+\(\s*)?$/;
    const bound = wrap.find((w) => DECL_HEAD.test(masked.slice(Math.max(0, w.open - 80), w.open)));
    return bound ? 'table-member' : null;
  }
  if (inner.kind === '(') {
    const head = masked.slice(Math.max(0, inner.open - 60), inner.open);
    const isParams = /\bfunction\s+[A-Za-z_$][\w$]*\s*$/.test(head) || /=>\s*$/.test(head);
    // 默认值分界那个 `=`：比较号 / `=>` 不算（同 `firstDefaultEq` 的口径，只是这里要「最后一个」）
    const eq = lastTopChar(masked, inner.open + 1, lit.qStart, (c, i) => c === '='
      && !'=><'.includes(masked[i + 1] ?? '') && !'=!<>'.includes(masked[i - 1] ?? ''));
    if (isParams && eq >= 0 && masked.slice(eq + 1, lit.qStart).trim() === '') {
      return 'default-param';
    }
  }
  return null;
}

/** 一个文件里的**具名函数**清单：`{ name, params, declLine, bodyFrom, bodyTo }`（解构参数位记 `null`）。 */
function functionInventory(root, rel) {
  const id = `${root}\u0000${rel}`;
  if (FN_INV.has(id)) return FN_INV.get(id);
  const f = srcFacts(root, rel);
  const out = [];
  if (f) {
    for (const m of f.code.matchAll(new RegExp(`\\bfunction\\s+(${IDENT_RE})\\s*\\(`, 'g'))) {
      if (!isCodePosition(f.code, f.masked, m.index, m[0].length)) continue;
      const open = m.index + m[0].length - 1;
      const close = matchGroup(f.masked, open);
      if (close == null) continue;
      const params = splitTop(f.masked, open + 1, close - 1).map(([a, b]) => {
        const eq = firstDefaultEq(f.masked, a, b);
        const m2 = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(f.masked.slice(a, eq < 0 ? b : eq));
        return m2 ? m2[1] : null;
      });
      const braceAt = nextNonSpace(f.masked, close);
      const bodyFrom = braceAt ?? close;
      const bodyTo = braceAt != null && f.masked[braceAt] === '{'
        ? (matchBrackets(f.masked, braceAt) ?? f.code.length) : f.code.length;
      out.push({ name: m[1], params, declLine: lineAt(f.code, m.index), bodyFrom, bodyTo });
    }
  }
  FN_INV.set(id, out);
  return out;
}
const FN_INV = new Map();

/** 调用点在 **runner 包外** ⇒ 它是「另一个来源」。口径是**枚举根归属**，不是文件名猜语义。 */
function isHostSideSite(rel) {
  const posix = String(rel ?? '').split(path.sep).join('/');
  return posix !== 'runner' && !posix.startsWith('runner/');
}

/** helper 形：`对象[下标]` 且**两边都是裸标识符**（`process.env[name]` 不匹配：那不是间接读） */
const HELPER_READ_SHAPE = /^\s*([A-Za-z_$][\w$]*)\s*(?:\?\.)?\s*\[\s*([A-Za-z_$][\w$]*)\s*\]\s*$/;

/**
 * 从扫描器已有的 `unsupported` **推出**「portal helper 间接读」站点（MED②）。四个事实，缺一不可：
 *   F1 有一条**动态下标读**且名字解析不出（`unsupported` 条目），且读形是 `对象[下标]`——**两边都是裸
 *      标识符**：`process.env[name]` 不算（那是直接读宿主 env，不是「env 由调用方传进来」）；
 *   F2 那条读所在的函数把 **env 对象**与 **key 名**都当**参数**收 ⇒ 它是 helper，值由调用方给；
 *   F3 调用点把该 env 名当**字符串字面量实参**传进那个参数位（⇒ key 在调用点静态可知），且 env 实参是
 *      扫描器认得的 env 对象（`process.env` 或 `env = process.env` 那类别名）；
 *   F4 调用点在 runner 包外（`isHostSideSite`）⇒ 它记成 `host-source`，不冒充 runner 读站点。
 * 名字解析是**文本级**的：同文件同名函数才算它自己（跨文件撞名不许串账）；helper 的声明行不算调用点。
 * ⚠ 只认 `function NAME(…)` 声明形（箭头 helper 不在现网形状里）—— 认不出就归不出来 ⇒ 红，不静默。
 */
function deriveHostSourceSites(root, unsupported) {
  if (HOST_SITES.has(root)) return HOST_SITES.get(root);
  const facts = new Map();
  const ofRel = (rel) => {
    if (!facts.has(rel)) facts.set(rel, { f: srcFacts(root, rel), ctx: null });
    return facts.get(rel);
  };
  const ctxOf = (rel) => {
    const box = ofRel(rel);
    if (box.f && box.ctx === null) box.ctx = analyzeEnvReads(box.f.code, box.f.text);
    return box.ctx;
  };
  const out = [];
  const seen = new Set();
  const helpers = [];
  for (const u of unsupported ?? []) {
    const dyn = HELPER_READ_SHAPE.exec(u.shape ?? '');
    if (!dyn) continue;                        // F1：不是「裸对象[裸名字]」⇒ 不是 helper 间接读
    const { rel, line } = splitCoord(u.at);
    const box = ofRel(rel);
    if (!box.f || line == null) continue;
    const span = lineRange(box.f.code, line);
    if (!span) continue;
    const fn = functionInventory(root, rel)
      .filter((x) => span[0] >= x.bodyFrom && span[0] < x.bodyTo)
      .sort((a, b) => a.bodyFrom - b.bodyFrom).pop();      // 最内层那个函数
    if (!fn) continue;
    const keyIdx = fn.params.indexOf(dyn[2]);
    const envIdx = fn.params.indexOf(dyn[1]);
    if (keyIdx < 0 || envIdx < 0) continue;                // F2：key/env 不都是参数 ⇒ 值不是调用方给的
    const id = `${fn.name}\u0000${rel}\u0000${fn.declLine}`;
    if (seen.has(id)) continue;                            // 同一个 helper 里多条动态读 ⇒ 只推一次
    seen.add(id);
    helpers.push({ name: fn.name, rel, declLine: fn.declLine, readLine: line, keyIdx, envIdx,
      shape: `${dyn[1]}[${dyn[2]}]` });
  }
  for (const h of helpers) {
    for (const file of scanTargets(root)) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      const box = ofRel(rel);
      if (!box.f) continue;
      const own = functionInventory(root, rel).some((x) => x.name === h.name);
      if (own && rel !== h.rel) continue;                  // 跨文件撞名 ⇒ 那是另一个同名函数
      const ctx = ctxOf(rel);
      for (const m of box.f.code.matchAll(new RegExp(`(?<![\\w$.])${escRe(h.name)}\\s*\\(`, 'g'))) {
        if (!isCodePosition(box.f.code, box.f.masked, m.index, m[0].length)) continue;
        const open = m.index + m[0].length - 1;
        const close = matchGroup(box.f.masked, open);
        if (close == null || (own && lineAt(box.f.code, m.index) === h.declLine)) continue;
        const args = splitTop(box.f.masked, open + 1, close - 1);
        if (args.length <= h.keyIdx) continue;
        const rawKey = box.f.code.slice(args[h.keyIdx][0], args[h.keyIdx][1]).trim();
        const lit = /^['"]([^'"]+)['"]$/.exec(rawKey);
        if (!lit || !NAMESPACED_ENV_NAME.test(lit[1])) continue;   // F3：key 不是 env 名形状的串 ⇒ 不推
        const envSpan = args[h.envIdx] ?? [0, 0];
        const envArg = box.f.code.slice(envSpan[0], envSpan[1]).trim();
        if (!/^process\s*\??\.\s*env$/.test(envArg) && !ctx?.envObjs.has(envArg)) continue;
        out.push({ key: lit[1], rel, line: lineAt(box.f.code, m.index), helperName: h.name,
          helperRel: h.rel, helperDeclLine: h.declLine, helperReadLine: h.readLine,
          helperShape: h.shape, keyArg: rawKey, envArg, keyParam: h.keyIdx + 1,
          hostSide: isHostSideSite(rel) });
      }
    }
  }
  HOST_SITES.set(root, out);
  return out;
}
const HOST_SITES = new Map();

/** 索引里那个 key 的 host-source 站点（先确保推过；`deriveHostSourceSites` 按 root 缓存 ⇒ 只跑一次）。 */
function hostSourceSitesOf(index, key) {
  if (typeof index?.deriveHostSourceSites !== 'function') return [];
  index.deriveHostSourceSites();
  return index.hostSourceSitesOf(key);
}

/**
 * **语义**判据：只问可复核事实。返回 `{ kind, why, via }`；三条都不成立 ⇒ `kind: null` +
 * `why` 写清「每条判据为什么不成立」（调用方必须红，**不许默认塞进某一类**）。
 * 顺序 = 由特指到宽泛：同一行可能同时像两样（`config.js:406` 既是对象成员、又是 helper 调用点），
 * 越具体的越先判 ⇒ `host-source` 必须排在 `mention-only` 前面（变异 M-2 就换这条顺序）。
 */
function shadowGapSemantic(key, coord, { root = REPO_ROOT, index = REPO_SITE_INDEX } = {}) {
  const { rel, line } = splitCoord(coord);
  if (line == null) return { kind: null, via: 'none', why: '坐标没有行号 ⇒ 没有语法位置可查' };
  const f = srcFacts(root, rel);
  if (!f) return { kind: null, via: 'none', why: `${rel} 读不到 ⇒ 没有源码事实可查` };
  const span = lineRange(f.code, line);
  if (!span) return { kind: null, via: 'none', why: `${rel} 没有第 ${line} 行` };
  const offs = keyOffsetsIn(f.code, span[0], span[1], key);
  if (offs.length === 0) {
    return { kind: null, via: 'none', why: `第 ${line} 行**没有** ${key} 这个字面量（注释已抹平）` };
  }
  const misses = [];
  // ① injection：该 key 的字面出现**落在容器 env 组装位里**（语法位置，与文件名无关）
  const spans = envAssemblySpans(root, rel);
  for (const off of offs) {
    for (const s of spans) {
      if (off < s.from || off >= s.to) continue;
      return { kind: 'injection', via: 'semantic',
        why: `第 ${line} 行的 ${key} 处在 ${rel} 的**${s.kind}**语法位置里（${s.at}，`
          + `区间第 ${s.fromLine}-${s.toLine} 行）⇒ 它是「组装进容器 env」的位置，不是 env 读站点` };
    }
  }
  misses.push(`injection：那一行不在任何 Env 组装位（该文件里那些位是 ${
    spans.map((s) => `${s.kind}@${s.fromLine}-${s.toLine}`).join('、') || '空'}）`);
  // ② host-source：坐标是**由代码推出**的 helper 间接读站点
  const atCoord = (s) => s.rel === rel && s.line === line;
  const hs = hostSourceSitesOf(index, key).find((s) => atCoord(s) && s.hostSide);
  if (hs) {
    const at = `${hs.helperRel}:${hs.helperDeclLine}`;
    const readAt = `${hs.helperRel}:${hs.helperReadLine}`;
    return { kind: 'host-source', via: 'semantic',
      why: `调用点 ${rel}:${line} 把 ${hs.keyArg} 当**字符串实参**传给 helper ${at}`
        + `（第 ${hs.keyParam} 个参数位），helper 在 ${readAt} 用 ${hs.helperShape}`
        + ` 动态下标取值 ⇒ 这条读站点扫描器看不见（它就在 unsupported 清单里）；`
        + `env 实参是 ${hs.envArg}（扫描器认得的 env 对象），而调用点在 **runner 包外**`
        + ' ⇒ 这是 portal/宿主侧的**间接读**，与 runner 的直接读站点是两个来源'
        + '（不是「仅仅提到 key」，也不是注入位）' };
  }
  misses.push('host-source：推导出的 helper 间接读站点里没有这个坐标');
  // ③ mention-only：本行是**被声明的字符串值** + 该 key 在索引里**另有真读站点**（两个事实都要）
  const decls = exactStringLiterals(f.code, f.masked, span[0], span[1], key)
    .map((lit) => ({ lit, form: keyDeclFormAt(f, lit) })).filter((x) => x.form !== null);
  const elsewhere = index.sitesOf(key).filter((s) => !(s.rel === rel && s.line === line));
  if (decls.length > 0 && elsewhere.length > 0) {
    return { kind: 'mention-only', via: 'semantic',
      why: `第 ${line} 行的 ${key} 是**${decls[0].form}**（整串正文就是这个 key 的字符串字面量被绑成数据/`
        + `默认值 ⇒ 本行不对 env 取值），且该 key 的真读站点在别处：${describeSites(index, key, 4)}` };
  }
  misses.push(decls.length === 0
    ? `mention-only：第 ${line} 行那个 ${key} 不是「被声明的字符串值」（const-init / table-member / `
      + 'default-param 三形都不像）'
    : 'mention-only：索引里这个 key 在别处**没有**真读站点 ⇒ 「只有声明、没人读」不许算文案');
  return { kind: null, via: 'none', why: misses.join('；') };
}

/**
 * **兜底**（故意保留的旧形状尺：路径 + 行内含 key）。只允许在语义判据决定不了时被调用，
 * 而且必须计数 —— `#587-S1-⑧` 断言真树 `fallbackCount === 0`：「靠形状猜」一旦出现就必须显式红，
 * 不许悄悄把新差异吸进老类别（那正是 MED① 的失效形状）。
 */
function shadowGapByShape(key, coord, root = REPO_ROOT) {
  const { rel, line } = splitCoord(coord);
  if (rel === 'portal/src/provisioner.js') return 'injection';
  if (rel === 'portal/src/config.js') return 'host-source';
  if (line == null) return null;
  const f = srcFacts(root, rel);
  if (!f || line == null) return null;
  const span = lineRange(f.code, line);
  if (!span) return null;
  return f.code.slice(span[0], span[1]).includes(key) ? 'mention-only' : null;
}

/**
 * 影子差异的类别（= 第 4 步切换前必须先修的三件事）+ 走了哪条路。写成了**判据**而不是坐标清单：
 * 清单会把「现在长这样」抄成第二本账（产品行号一漂就红一次，而红得没有信息）。
 * @param {{stats?:{fallbackCount:number,fallbackHits:string[]}}} [opts] 兜底计数（调用方断言它为 0）
 */
function shadowGapClass(key, coord, opts = {}) {
  const r = shadowGapSemantic(key, coord, opts);
  if (r.kind !== null) return r;
  const stats = opts.stats ?? { fallbackCount: 0, fallbackHits: [] };
  const kind = shadowGapByShape(key, coord, opts.root ?? REPO_ROOT);
  stats.fallbackCount += 1;
  stats.fallbackHits.push(`${key}@${coord} ⇒ ${String(kind)}（语义判据：${r.why}）`);
  return { kind, via: 'fallback', why: `形状兜底（路径/行内含 key）；语义判据：${r.why}` };
}

test('#587-S1-⑧ 影子对照真树：影子尺只会更严，多杀的必须逐条归进已知三类（第 4 步能不能切就看它）', () => {
  const { entries } = loadEnvLegExceptions();
  assert.ok(entries.length > 0, '例外清单读不到 ⇒ 对照没意义');
  const gate = whereProblems(entries, RUNNER_ENV_KEYS);
  const shadow = siteIndexProblems(entries, REPO_SITE_INDEX);
  const gateIds = coordIds(gate);
  const shadowIds = coordIds(shadow);
  const onlyShadow = shadowIds.filter((x) => !gateIds.includes(x));
  const onlyGate = gateIds.filter((x) => !shadowIds.includes(x));
  // 差异按类归堆（`key@coord#第几个引用`）；归类走**语义判据**，兜底必须计数
  const buckets = new Map();
  const unexplained = [];
  const stats = { fallbackCount: 0, fallbackHits: [] };
  for (const id of onlyShadow) {
    const [key, rest] = id.split('@');
    const coord = rest.replace(/#\d+$/, '');
    const { kind, why, via } = shadowGapClass(key, coord, { stats });
    if (kind === null) { unexplained.push(`${id} —— ${why}`); continue; }
    if (!buckets.has(kind)) buckets.set(kind, []);
    buckets.get(kind).push(id);
    console.log(`# SHADOW-CLASS ${id} ⇒ ${kind}（${via}）：${why.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  const counts = Object.fromEntries([...buckets].map(([k, v]) => [k, v.length]).sort());
  console.log(`# SHADOW 真树对照：登记 ${entries.length} 条 / 旧尺 ${gate.length} / 影子 ${shadow.length} 条`);
  console.log(`# SHADOW 分类计数 ${JSON.stringify(counts)}（未归类 ${unexplained.length} 条`
    + ` / 兜底 ${stats.fallbackCount} 条）`);
  console.log(`# SHADOW 旧尺红而影子绿（切换会放宽的）：${JSON.stringify(onlyGate)}`);
  for (const p of shadow) console.log(`# SHADOW-DIFF ${p.replace(/\s+/g, ' ').slice(0, 240)}`);
  // 方向：结构成员判定只会**更严**。旧尺报的问题影子尺没报 ⇒ 索引有洞（漏读形或语法尺没共用）。
  assert.deepEqual(onlyGate, [],
    '旧尺判红而影子尺判绿 ⇒ 索引比文本尺还松（要么漏了读形，要么坐标语法没走同一把尺）');
  assert.deepEqual(unexplained, [],
    '影子多杀的坐标归不进已知三类 ⇒ 要么是新造的假坐标（好事，登记该改），要么索引漏了真读形（坏事）：'
    + '逐条看上面的 SHADOW-CLASS / SHADOW-DIFF 定性后再动，不许为了让这格变绿去改登记');
  // 兜底必须是 **0**（MED①）：真树这 14 条全部由语义判据决定 ⇒ 「靠路径/文本形状猜」不许发生。
  // 非 0 的含义：出现了新形状（语义判据认不出）⇒ 要么补判据（带夹具），要么登记该改；
  // **不许**放着兜底当答案（那正好把 MED① 的病重新养回来）。
  assert.equal(stats.fallbackCount, 0,
    `差异分类里有 ${stats.fallbackCount} 条走了**形状兜底**（语义判据决定不了）⇒ 必须显式处理：`
    + `\n${stats.fallbackHits.join('\n')}`);
  // 三类的**现值**（第 2/3 步落地后这里必须跟着变，变的时候就是「可以切了」的信号）
  // ⚙ 语义判据落地后从 `{1,5,8}` 改成 `{1,4,9}`：`portal/src/provisioner.js:362` 的
  //   `readContainerEnv(inspectData, key = 'ERIX_STATION_TOKEN')` 按**语法位置**不在任何 Env 组装位里
  //   —— 它是「把 env 名声明成默认参数」的读侧 helper（审计 §3 自己写了「不是注入也不是 process.env 读」，
  //   例外清单那条 reason 也写了「不是注入点」）。旧形状闸把它算成 injection ⇒ 第 3 步会去补错方向。
  const want = { 'host-source': 1, injection: 4, 'mention-only': TIMEOUT_KEYS.length * 2 + 1 };
  assert.deepEqual(counts, want,
    `影子差异的分布变了（现在 ${JSON.stringify(counts)}）⇒ 有人动了例外清单/产品代码，或索引判定漂了`
    + '：按 SHADOW-DIFF 逐条定性，然后把这里的期望值改成新现实（并更新工单报告），不许反着改登记');
  // 差异还在 ⇒ 现在**不能**切闸门（第 4 步的前提是这三类清零）
  assert.ok(onlyShadow.length > 0,
    '影子尺与旧尺读数已经一致 ⇒ 三类差异都清了，可以走第 4 步切换（把这格换成「两边必须完全相等」）');
  // 盘上那份的**旧尺**读数必须还是全绿 —— 影子没被接进闸门
  assert.deepEqual(gate, [], '闸门行为变了：盘上那份被判红了（本步红线：闸门一个字不许变）');
});

/**
 * MED① 的夹具：**路径故意也叫 `portal/src/provisioner.js`** —— 旧形状闸会把它里而每一行都算
 * injection（那正是 MED① 的病）。行号是约定（`SI_MED_L`）：改文本要跟着改行号表。
 */
const SI_MED_FILES = {
  'portal/src/provisioner.js': [
    'export function buildContainerConfig({ env = [], fdeName, log }) {',   // 1  入参默认值不是 `env:` 属性位
    '  const body = {',                                                     // 2
    '    Env: [',                                                           // 3
    '      ...(env ?? []),',                                                // 4
    '      `ERIX_SI_MED_INJECT=${fdeName}`,',                               // 5  ← 真注入位（Env 数组元素）
    '    ],',                                                               // 6
    '  };',                                                                 // 7
    '  if (fdeName) body.Env.push(`ERIX_SI_MED_PUSH=${fdeName}`);',  // 8  ← 真注入位（.Env.push 参数）
    '  log(`ERIX_SI_MED_LOGTPL=${fdeName}`);',                       // 9  ← 形状像注入但不是注入位
    '  const TABLE = Object.freeze({ a: \'ERIX_SI_MED_TABLE\' });',     // 10 ← 声明位（另有真读站点）
    '  const ORPHAN = Object.freeze({ a: \'ERIX_SI_MED_ORPHAN\' });',   // 11 ← 只有声明，没人读
    '  return body;',                                                // 12
    '}',                                                             // 13
  ].join('\n'),
  'lib/reader.js': 'export const v = process.env.ERIX_SI_MED_TABLE;\n',  // 1  ← 真读站点（在别的文件）
};
const SI_MED_L = {
  envElem: 5, pushArg: 8, logTpl: 9, tableDecl: 10, orphanDecl: 11,
};
const SI_MED_PROV = 'portal/src/provisioner.js';

test('#587-S1-⑨ 差异分类只认**语法位置与索引事实**：路径像 provisioner 又不是注入位（MED①）', () => {
  const dir = fixtureRoot(SI_MED_FILES);
  try {
    const index = buildEnvSiteIndex(dir);
    const cls = (key, coord) => shadowGapSemantic(key, coord, { root: dir, index });
    const at = (n) => `${SI_MED_PROV}:${n}`;
    // ① 变异 M-1 的靶子：**同一个文件**里的日志模板行（`KEY=${v}` 住在 `log()` 里）——路径与文本
    //    形状都和注入位一模一样，但**语法位置**不是注入位 ⇒ 必须不是 injection；也不是声明位
    //    ⇒ 必须归不出来（红）。先判它：变异时红得能看见病名。
    const tpl = cls('ERIX_SI_MED_LOGTPL', at(SI_MED_L.logTpl));
    assert.notEqual(tpl.kind, 'injection',
      `语义判据吃了路径 ⇒ 「文件叫 provisioner.js 就一律 injection」（MED① 的病，实际：${tpl.why}）`);
    assert.equal(tpl.kind, null,
      `三条判据都不成立就必须归不出来（实际 ${tpl.kind}：${tpl.why}）—— 不许默认塞一类`);
    assert.match(tpl.why, /injection：/, '归不出来时要说清每条判据为什么不过');
    assert.match(tpl.why, /mention-only：/);
    // 反向自证：**形状兜底**对同一行会说 injection ⇒ 上面那格杀的不是运气，是语义判据在换答案
    assert.equal(shadowGapByShape('ERIX_SI_MED_LOGTPL', at(SI_MED_L.logTpl), dir), 'injection',
      '兜底尺对这一行应该仍然判错（否则本格的对照前提破了）');
    // ② 两个**语法位置**：`Env: […]` 数组元素 / `body.Env.push(…)` 参数位 ⇒ injection
    const inj = cls('ERIX_SI_MED_INJECT', at(SI_MED_L.envElem));
    assert.equal(inj.kind, 'injection', `Env 数组元素位应判 injection（实际 ${inj.kind}：${inj.why}）`);
    assert.match(inj.why, /Env\[\] 数组字面量/, '理由要点名是哪个语法位（第 3 步才知道要登记什么）');
    const push = cls('ERIX_SI_MED_PUSH', at(SI_MED_L.pushArg));
    assert.equal(push.kind, 'injection', `.Env.push 参数位应判 injection（实际 ${push.kind}：${push.why}）`);
    assert.match(push.why, /Env\.push\(\) 参数位/);
    // ③ 声明位 + 索引里另有真读站点 ⇒ mention-only（两个事实缺一不可）
    const tbl = cls('ERIX_SI_MED_TABLE', at(SI_MED_L.tableDecl));
    assert.equal(tbl.kind, 'mention-only', `数据表声明位应判 mention-only（实际 ${tbl.kind}：${tbl.why}）`);
    assert.match(tbl.why, /table-member/);
    assert.match(tbl.why, /lib\/reader\.js:1\(dot\)/, '理由要点名「真读站点在别的文件」');
    // ④ 只有声明位、索引里**没有**任何真读站点 ⇒ 不许算 mention-only（「没人读的死名字」是第 4 步要抓的）
    const orphan = cls('ERIX_SI_MED_ORPHAN', at(SI_MED_L.orphanDecl));
    assert.equal(orphan.kind, null, `只有声明、没人读 ⇒ 不许归 mention-only（实际 ${orphan.kind}）`);
    assert.match(orphan.why, /没有.*真读站点|没有真读站点/, '要说清第二根事实不过：索引里没读到过这个 key');
    // ⑤ 兜底**必须计数**（否则它会悄悄把新差异吸进老类别）：同一行走 `shadowGapClass` 就要报 1 次
    const stats = { fallbackCount: 0, fallbackHits: [] };
    const viaFallback = shadowGapClass('ERIX_SI_MED_LOGTPL', at(SI_MED_L.logTpl),
      { root: dir, index, stats });
    assert.equal(viaFallback.via, 'fallback', '语义判据不行才轮得到兜底');
    assert.equal(viaFallback.kind, 'injection', '兜底就是那把旧形状尺 ⇒ 对这一行它判 injection');
    assert.equal(stats.fallbackCount, 1, '走了兜底却没记账 ⇒ 「兜底为 0」那条断言是空的（MED①）');
    assert.match(stats.fallbackHits.join('\n'), /ERIX_SI_MED_LOGTPL@/);
    // ⑥ 同一批语义判据在真树上对 `provisioner.js:362` 换答案：旧尺说 injection，语义说声明位
    const rbCoord = `${SI_MED_PROV}:${lineOf(SI_MED_PROV, "key = 'ERIX_STATION_TOKEN'")}`;
    const readBack = shadowGapSemantic('ERIX_STATION_TOKEN', rbCoord);
    assert.equal(readBack.kind, 'mention-only',
      `${rbCoord} 是读侧 helper 的默认参数声明位，不许算注入位（实际 ${readBack.kind}：${readBack.why}）`);
    assert.match(readBack.why, /default-param/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/**
 * MED② 的夹具：helper 与调用点同文件（真树 `portal/src/config.js` 就是这个形状）。
 * 故意再加一份**同名 helper 在 runner 包里**的副本：同一条推导事实（F1–F3）都成立，但调用点
 * 在枚举根**内** ⇒ 不许叫 `host-source`（那一类只装「另一个来源」）。
 */
const SI_HOST_FILES = {
  'portal/src/hostconfig.js': [
    'function intEnv(env, key, fallback) {',                          // 1  helper：env 与 key 都是参数
    '  const v = Number(env[key] ?? fallback);',                      // 2  动态下标 ⇒ 扫描器进 unsupported
    '  return Number.isFinite(v) && v > 0 ? v : fallback;',            // 3
    '}',                                                              // 4
    'export function loadCfg(env = process.env) {',                   // 5  env 别名（扫描器认这文件有 env）
    "  return { workerUid: intEnv(env, 'ERIX_SI_MED_UID', 1002) };",  // 6  调用点：key 是字符串实参
    '}',                                                              // 7
  ].join('\n'),
  'runner/lib/inner.js': [
    'function intEnv(env, key, fallback) {',                          // 1  同名 helper，但在 runner 包里
    '  const v = Number(env[key] ?? fallback);',                      // 2
    '  return v ?? 0;',                                               // 3
    '}',                                                              // 4
    'export function loadCfg(env = process.env) {',                   // 5
    "  return { uid: intEnv(env, 'ERIX_SI_MED_RUNNER', 1) };",       // 6  调用点在枚举根内
    '}',                                                              // 7
  ].join('\n'),
};

test('#587-S1-⑩ portal helper 间接读由**代码推出**并归 host-source：不是 mention-only（MED②）', () => {
  const dir = fixtureRoot(SI_HOST_FILES);
  try {
    const index = buildEnvSiteIndex(dir);
    // 推导的**输入**必须是扫描器自己的 unsupported 清单（不是手抄坐标）
    const unsupportedAt = 'portal/src/hostconfig.js:2';
    assert.ok(index.unsupported.some((u) => u.at === unsupportedAt && /env\[key\]/.test(u.shape)),
      `夹具前提破了：扫描器没把动态下标报进 unsupported（实际 ${JSON.stringify(index.unsupported)}）`);
    const derived = index.deriveHostSourceSites();
    const uid = derived.find((s) => s.key === 'ERIX_SI_MED_UID');
    const derivedIds = derived.map((s) => `${s.key}@${s.rel}:${s.line}`).join('、');
    assert.ok(uid, `没推出 ERIX_SI_MED_UID（推出的是：${derivedIds}）`);
    assert.deepEqual([uid.rel, uid.line], ['portal/src/hostconfig.js', 6], '调用点坐标推错了');
    assert.deepEqual([uid.helperRel, uid.helperDeclLine, uid.helperReadLine],
      ['portal/src/hostconfig.js', 1, 2], 'helper 坐标推错了（理由要能指着它）');
    assert.equal(index.hasSite('ERIX_SI_MED_UID', uid.rel, uid.line), false,
      'host-source 站点不许冒充读站点（那会把影子口径静默放宽）');
    assert.equal(index.hasHostSourceSite('ERIX_SI_MED_UID', uid.rel, uid.line), true, '第三张表没落进去');
    const r = shadowGapSemantic('ERIX_SI_MED_UID', `${uid.rel}:${uid.line}`, { root: dir, index });
    assert.equal(r.kind, 'host-source', `应判 host-source（实际 ${r.kind}：${r.why}）`);
    assert.match(r.why, /hostconfig\.js:6/, '理由必须点名调用点坐标');
    assert.match(r.why, /hostconfig\.js:1/, '理由必须点名 helper 声明坐标');
    assert.match(r.why, /hostconfig\.js:2/);                   // 动态下标那一行也在理由里
    // 反向：同名 helper 但调用点在 **runner 包里** ⇒ 同一条推导事实成立，却不是「另一个来源」
    const inRunner = derived.find((s) => s.key === 'ERIX_SI_MED_RUNNER');
    assert.ok(inRunner && inRunner.hostSide === false,
      `runner 包内的那条应推出但标 hostSide=false（实际 ${JSON.stringify(inRunner)}）`);
    const nrCoord = `${inRunner.rel}:${inRunner.line}`;
    const nr = shadowGapSemantic('ERIX_SI_MED_RUNNER', nrCoord, { root: dir, index });
    assert.notEqual(nr.kind, 'host-source',
      `runner 自己包里的 helper 读形不该被叫成「另一个来源」（实际 ${nr.kind}）`);
    assert.equal(nr.kind, null, '既不是注入位也不是声明位 ⇒ 必须红，不许靠同名规则撑一个类别');
    // 推导是幂等的（同一个 root 只扫一次，两次调用给同一批事实）
    assert.equal(index.deriveHostSourceSites(), derived, 'derive 不幂等 ⇒ 第二张表会被重复登记');
    // 真树：`FDE_WORKER_UID` 那条差异必须归 host-source，理由点名调用点与 helper 两头坐标
    // 真树的推导读数：只装**带命名空间前缀**的 env 名（`NAMESPACED_ENV_NAME` 与扫描器给读站点的
    // 准入规则同一条）⇒ `PREVIEW_*` / `SESSION_TTL_SECONDS` 这些 helper 调用点被推出但不算 env 站点。
    const realDerived = REPO_SITE_INDEX.deriveHostSourceSites();
    const siteTag = (s) => `${s.rel}:${s.line}←helper ${s.helperRel}:${s.helperDeclLine}`;
    const uidSites = realDerived.filter((s) => s.key === 'FDE_WORKER_UID').map(siteTag).join('、');
    console.log(`# HOST-SITES 真树推出 ${realDerived.length} 条 helper 间接读站点（由 unsupported 反推，`
      + `非手抄）；FDE_WORKER_UID ⇒ ${uidSites || '没推出'}`);
    const real = shadowGapSemantic('FDE_WORKER_UID', 'portal/src/config.js:406');
    assert.equal(real.kind, 'host-source',
      `config.js:406 是合法的 portal 间接读，不是「仅仅提到 key」（实际 ${real.kind}：${real.why}）`);
    assert.match(real.why, /config\.js:406/, '理由要点名调用点（review 要的那一句）');
    assert.match(real.why, /config\.js:12\b/, '理由要点名 helper `intEnv` 的声明行 :12');
    assert.match(real.why, /config\.js:13\b/, '还要点名真正取值的 `env[key]` 那一行');
    assert.equal(real.why.includes('mention-only'), false, '理由里不许同时出现另一个类别名');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/**
 * #587 折中方案**第 2 步**的夹具（三形 + fail-closed）。行号是约定（`S2_L`）：改文本要跟着改行号表。
 * 一个文件只装一种形状 ⇒ 删掉对应的识别分支时只有那一格会红（变异表要能逐刀点名）。
 */
const S2_FILES = {
  'lib/alias.js': [
    'const e = Object.assign({}, process.env);',                       // 1 拷贝别名（审计 #5 那一形）
    'export const dot = e.ERIX_S2_ASSIGN_DOT;',                        // 2 点号读
    "export const idx = e['ERIX_S2_ASSIGN_INDEX'];",                     // 3 下标读
    'const opt = Object.assign({}, process?.env);',                    // 4 可选链同权
    'export const viaOpt = opt.ERIX_S2_ASSIGN_OPT;',                   // 5
    'const again = e;',                                                // 6 再别名
    'export const viaAgain = again.ERIX_S2_REALIAS;',                  // 7
    'const plain = Object.assign({}, defaults);',                      // 8 负例：普通拷贝不是 env
    'export const notEnv = plain.ERIX_S2_NOT_ENV;',                    // 9
  ].join('\n'),
  'lib/reflect.js': [
    "export const a = Reflect.get(process.env, 'ERIX_S2_REFLECT_LIT');",   // 1 字面量名
    'const K_ENV = \'ERIX_S2_REFLECT_NAME\';',                            // 2 常量名（读形里没有字面量）
    'export const b = Reflect.get(process.env, K_ENV);',                  // 3
    "export const c = Reflect.has(process.env, 'ERIX_S2_REFLECT_HAS');",  // 4 has 也算读
    'const e = Object.assign({}, process.env);',                          // 5
    "export const d = Reflect.get(e, 'ERIX_S2_REFLECT_ALIAS');",          // 6 别名上的 Reflect
    "export const n = Reflect.get(other, 'ERIX_S2_REFLECT_NEG');",        // 7 负例：普通对象
    "Reflect.set(process.env, 'ERIX_S2_REFLECT_WRITE', '1');",            // 8 写形不是读站点
  ].join('\n'),
  'lib/destructure.js': [
    'const { ERIX_S2_DES_SHORT } = process.env;',                    // 1 简写
    'const { ERIX_S2_DES_RENAMED: alias } = process?.env;',          // 2 重命名 + 可选链
    'const {',                                                        // 3 多行解构：每个成员自己一行
    '  ERIX_S2_DES_LINE_A,',                                          // 4
    '  ERIX_S2_DES_LINE_B: b,',                                        // 5
    '} = process.env;',                                                // 6
    "const T = Object.freeze({ a: 'ERIX_S2_DES_TABLE' });",            // 7 数据表（不是读站点）
    'const { [T]: fromTable } = process.env;',                         // 8 计算名从表里来
    'const { cfg } = opts;',                                          // 9 负例：普通解构的成员不是 env 对象
    'export const viaCfg = cfg.ERIX_S2_DES_NOT_ENV;',                 // 10
    "const { 'ERIX_S2_DES_QUOTED': q } = process.env;",              // 11 引号键名
    "const { ERIX_S2_DES_DEFAULT = 'x' } = process.env;",              // 12 带默认值
  ].join('\n'),
  'lib/failclosed.js': [
    // 1 名字来源的数据表（登记的理由要引它那一行：族 B② 要求理由引到可核对的声明位）
    "export const KNOB_TABLE = Object.freeze({ a: 'ERIX_S2_TABLE_NAMES' });",
    'export const a = Reflect.get(process.env, name);',              // 2 动态 Reflect ⇒ unsupported
    'export const b = Reflect.get(process.env);',                    // 3 连名字位都没有 ⇒ unsupported
    'const { [name]: v } = process.env;',                            // 4 计算解构名 ⇒ unsupported
    'const { ERIX_S2_KEPT, ...rest } = process.env;',                // 5 静态名是站点，rest 不是
    'Object.assign(cfg, process.env);',                              // 6 整表拷贝没绑别名 ⇒ unsupported
    'export const ks = Object.keys(process.env);',                    // 7 枚举 ⇒ unsupported
    'for (const k in process.env) { use(k); }',                       // 8 for-in ⇒ unsupported
    'const ok = Object.assign({}, process.env);',                    // 9 负例：绑成别名 ⇒ 不双记
    'export const viaOk = ok.ERIX_S2_BOUND;',                        // 10
    'const spreadOk = { ...process.env };',                          // 11 负例：展开形绑成别名
    'export const viaSpread = spreadOk.ERIX_S2_SPREAD_BOUND;',       // 12
    "export const neg = [Reflect.get(other, name), Object.keys(opts)];", // 13 负例：普通对象
    'for (const k in other) { use(k); }',                            // 14 负例
    'const { [name]: n2 } = other;',                                 // 15 负例
    'const q = Object.assign({}, process?.env);',                    // 16 可选链的拷贝形也是别名
    'export const viaQ = q.ERIX_S2_OPT_ALIAS;',                      // 17
  ].join('\n'),
};
const S2_L = {
  assignDot: 2, assignIdx: 3, assignOpt: 5, realias: 7, notEnv: 9,
  reflectLit: 1, reflectName: 3, reflectHas: 4, reflectAlias: 6, reflectNeg: 7, reflectWrite: 8,
  desShort: 1, desRenamed: 2, desLineA: 4, desLineB: 5, desTable: 8, desNotEnv: 10,
  desQuoted: 11, desDefault: 12,
  fcTable: 1,
  fcReflectDyn: 2, fcReflectNoArg: 3, fcComputed: 4, fcRest: 5, fcCopy: 6, fcKeys: 7, fcForIn: 8,
  fcBound: 9, fcSpread: 11, fcNeg: 13, fcNegForIn: 14, fcNegComputed: 15, fcOptAlias: 17,
};

/** 夹具 + 扫描产出（每格自己搭自己拆）。 */
function s2Fixture() {
  const dir = fixtureRoot(S2_FILES);
  return { dir, index: buildEnvSiteIndex(dir), scan: scanEnvReads(dir) };
}

/** 站点坐标清单 `rel:line`（按 key 取），报错时能照着改。 */
const s2Coords = (index, key) => index.sitesOf(key).map((s) => `${s.rel}:${s.line}(${s.shape})`);

function s2At(key, rel, line) {
  return { key, reason: '夹具：第 2 步三形的靶子', where: `${rel}:${line}` };
}

test('#587-S2-① 拷贝别名（`Object.assign({}, process.env)` / `{ ...process.env }`）之后的点号与下标都是读站点', () => {
  const { dir, index } = s2Fixture();
  try {
    const want = [
      ['ERIX_S2_ASSIGN_DOT', S2_L.assignDot, 'dot'],
      [`ERIX_S2_ASSIGN_INDEX`, S2_L.assignIdx, `index:'ERIX_S2_ASSIGN_INDEX'`],
      ['ERIX_S2_ASSIGN_OPT', S2_L.assignOpt, 'dot'],
      ['ERIX_S2_REALIAS', S2_L.realias, 'dot'],
    ];
    for (const [key, line, shape] of want) {
      assert.deepEqual(s2Coords(index, key), [`lib/alias.js:${line}(${shape})`],
        `${key} 必须认成「env 拷贝别名上的读站点」（实际 ${JSON.stringify(s2Coords(index, key))}）`
        + ' ⇒ 审计 #5 的读数就是 keys=[] 且 unsupported=[]：既不登记也不报错');
      // 影子尺（第 1 步那张索引）必须吃到它：指到真站点 ⇒ 判绿
      assert.deepEqual(siteIndexProblems([s2At(key, 'lib/alias.js', line)], index, dir), [],
        `${key} 的真站点被影子尺判红 ⇒ 索引没吃到拷贝别名`);
    }
    // 负例：`Object.assign({}, defaults)` 不是 env ⇒ 那一形一条都不许进
    assert.deepEqual(s2Coords(index, 'ERIX_S2_NOT_ENV'), [],
      '普通对象上的 `Object.assign` 拷贝被当成 env 别名了 ⇒ 会把无关读形灌进枚举');
    assert.deepEqual(index.linesOf('ERIX_S2_ASSIGN_DOT', 'lib/reflect.js'), [],
      '别名表是**按文件**建的 ⇒ 隔壁文件的 `e.` 不许跟着背书');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#587-S2-② `Reflect.get(env, \'KEY\')` / `Reflect.has` 是读站点（字面量名 / 常量名 / 别名都算）', () => {
  const { dir, index } = s2Fixture();
  try {
    const want = [
      ['ERIX_S2_REFLECT_LIT', S2_L.reflectLit, 'get'],
      ['ERIX_S2_REFLECT_NAME', S2_L.reflectName, 'get'],   // 那一行里没有 env 名字面量，名字从常量表来
      ['ERIX_S2_REFLECT_HAS', S2_L.reflectHas, 'has'],
      ['ERIX_S2_REFLECT_ALIAS', S2_L.reflectAlias, 'get'], // 第一个实参是拷贝别名
    ];
    for (const [key, line, op] of want) {
      assert.deepEqual(s2Coords(index, key), [`lib/reflect.js:${line}(reflect:${op})`],
        `${key} 必须认成 Reflect 读站点（实际 ${JSON.stringify(s2Coords(index, key))}）`);
      assert.deepEqual(siteIndexProblems([s2At(key, 'lib/reflect.js', line)], index, dir), [],
        `${key} 的真站点被影子尺判红 ⇒ 索引没吃到 Reflect 形`);
    }
    // 两个负例：普通对象上的 Reflect.get、以及 `Reflect.set` 写形
    assert.deepEqual(s2Coords(index, 'ERIX_S2_REFLECT_NEG'), [],
      '`Reflect.get(other, …)` 被算成了 env 读取 ⇒ 闸门枚举会被无关对象污染');
    assert.deepEqual(s2Coords(index, 'ERIX_S2_REFLECT_WRITE'), [],
      '`Reflect.set` 是**写**形 ⇒ 不许当读站点（与 `env.X = v` 同一条旧口径）');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#587-S2-③ 解构 env：简写 / 重命名 / 多行 / 表驱动计算名都要成读站点（普通解构不算）', () => {
  const { dir, index } = s2Fixture();
  try {
    const want = [
      ['ERIX_S2_DES_SHORT', S2_L.desShort],
      ['ERIX_S2_DES_RENAMED', S2_L.desRenamed],
      ['ERIX_S2_DES_LINE_A', S2_L.desLineA],
      ['ERIX_S2_DES_LINE_B', S2_L.desLineB],
      ['ERIX_S2_DES_QUOTED', S2_L.desQuoted],
      ['ERIX_S2_DES_DEFAULT', S2_L.desDefault],
    ];
    for (const [key, line] of want) {
      assert.deepEqual(s2Coords(index, key), [`lib/destructure.js:${line}(destructure)`],
        `${key} 必须认成解构读站点，且**行号是它自己那一行**（实际 ${JSON.stringify(s2Coords(index, key))}）`);
    }
    // 表驱动那种计算名：那一行里没有 env 名字面量，名字从 `T` 那张表来
    const tableSites = s2Coords(index, 'ERIX_S2_DES_TABLE');
    assert.deepEqual(tableSites, ['lib/destructure.js:8(destructure:[T])'],
      `表驱动的计算解构名没解析出来（实际 ${JSON.stringify(tableSites)}）`);
    const tableCoord = s2At('ERIX_S2_DES_TABLE', 'lib/destructure.js', S2_L.desTable);
    assert.deepEqual(siteIndexProblems([tableCoord], index, dir), [], '表驱动解构被影子尺判红 ⇒ 索引没吃到');
    // 负例：普通解构的成员不是 env 对象，之后 `cfg.KEY` 也不许算读取
    assert.deepEqual(s2Coords(index, 'ERIX_S2_DES_NOT_ENV'), [],
      '`const { cfg } = opts` 的成员被当成了 env 对象 ⇒ 解构那一形会把无关读形灌进枚举');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#587-S2-④ fail-closed：在 env 上取名字却解析不出静态 key ⇒ 必须进 unsupported（带 at + shape）', () => {
  const { dir, index } = s2Fixture();
  try {
    const at = index.unsupported.filter((u) => u.at.startsWith('lib/failclosed.js'))
      .map((u) => u.at).sort();
    const wantAt = [S2_L.fcReflectDyn, S2_L.fcReflectNoArg, S2_L.fcComputed, S2_L.fcRest,
      S2_L.fcCopy, S2_L.fcKeys, S2_L.fcForIn].map((n) => `lib/failclosed.js:${n}`).sort();
    assert.deepEqual(at, wantAt,
      `fail-closed 的读数不对（实际 ${JSON.stringify(at)}，应为 ${JSON.stringify(wantAt)}）`);
    const atKey = `lib/failclosed.js:`;
    const shapeAt = (n) => String(
      index.unsupported.find((u) => u.at === `${atKey}${n}`)?.shape ?? '');
    assert.match(shapeAt(S2_L.fcReflectDyn), /Reflect\.get\(\s*process\.env\s*,\s*name\s*\)/);
    assert.match(shapeAt(S2_L.fcComputed), /\{\s*\[name\]:v\s*\}\s*=\s*process\.env|\[name\]/);
    assert.match(shapeAt(S2_L.fcRest), /\.\.\./, 'rest 那一形没有静态 key ⇒ 也要登记，不许静默');
    assert.match(shapeAt(S2_L.fcCopy), /Object\.assign\(\s*cfg\s*,\s*process\.env\s*\)/);
    assert.match(shapeAt(S2_L.fcKeys), /Object\.keys\(\s*process\.env\s*\)/);
    assert.match(shapeAt(S2_L.fcForIn), /for \(const k in process\.env\)/);
    // 动态那一形**只**进 unsupported，不许同时被当成读站点（否则「登记了」这件事会被读站点掩盖）
    assert.equal(index.keys.has('name'), false, '动态名的占位符被当成 env 名进了枚举');
    // 静态那半个成员仍要是读站点（rest 不许把同一条解构里的静态名也拖下水）
    assert.deepEqual(s2Coords(index, 'ERIX_S2_KEPT'), ['lib/failclosed.js:5(destructure)'],
      `同一条解构里的静态名丢了（实际 ${JSON.stringify(s2Coords(index, 'ERIX_S2_KEPT'))}）`);
    // 兜底条目过**同一把登记尺**（族 B②）：理由必须引到那条动态读的名字来源（这里 = 数据表声明行）
    const why = `名字由调用方拼，值域见 lib/failclosed.js:${S2_L.fcTable}`;
    const reg = index.unsupported.filter((u) => u.at.startsWith('lib/failclosed.js'))
      .map((u) => ({ at: u.at, read: u.shape, reason: why }));
    const regProblems = validateUnsupported(reg, dir, index.unsupported);
    assert.deepEqual(regProblems, [],
      `扫出来的兜底条目写不成合法登记（尺子不认自己的产出）：\n${regProblems.join('\n')}`);
    // 不登记 ⇒ 咬合尺必须红（fail closed 的另一半）
    assert.ok(unsupportedProblems(index.unsupported, []).length >= wantAt.length,
      '扫出来却没登记 ⇒ 咬合尺必须逐条报');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#587-S2-⑤ fail-closed 的负例：普通对象那一形 / 已绑别名的拷贝 一条都不许进 unsupported', () => {
  const { dir, index } = s2Fixture();
  try {
    const negLines = [S2_L.fcNeg, S2_L.fcNegForIn, S2_L.fcNegComputed, S2_L.fcBound, S2_L.fcSpread];
    const hit = index.unsupported.filter((u) => u.at.startsWith('lib/failclosed.js')
      && negLines.includes(splitCoord(u.at).line));
    assert.deepEqual(hit, [],
      `普通对象的 Reflect.get / for-in / 解构，或**已绑成别名**的拷贝被报成了动态读（实际 `
      + `${JSON.stringify(hit.map((u) => u.at))}）⇒ unsupported 会被噪音撑满，登记就变成橡皮章`);
    // 已绑别名那条仍然要能读到值（不是「不报」就等于「没看见」）
    assert.deepEqual(s2Coords(index, 'ERIX_S2_BOUND'), ['lib/failclosed.js:10(dot)'],
      '已绑别名的拷贝没被跟踪 ⇒ 为了降噪把真读取也丢了');
    assert.deepEqual(s2Coords(index, 'ERIX_S2_SPREAD_BOUND'), ['lib/failclosed.js:12(dot)'],
      '展开形绑成别名后没被跟踪');
    assert.deepEqual(s2Coords(index, 'ERIX_S2_OPT_ALIAS'), ['lib/failclosed.js:17(dot)'],
      '`Object.assign({}, process?.env)` 的可选链拷贝形没被跟踪');
    // 同一形但**没**绑别名 ⇒ 必须报（③ 与⑤ 的唯一区分就是「有没有人接着读」）
    assert.ok(index.unsupported.some((u) => u.at === `lib/failclosed.js:${S2_L.fcCopy}`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#587-S2-⑥ 影子尺口径：新形状的站点判绿，形似站点（注释 / 日志模板 / 数据值）照旧判红', () => {
  const dir = fixtureRoot({
    'lib/shadow.js': [
      "// const { ERIX_S2_SH } = process.env;                 // 1 注释里的旧代码（#557 的翻车形状）",
      'export const note = \'ERIX_S2_SH 已接好\';',   // 2 散文串
      "export const real = Reflect.get(process.env, 'ERIX_S2_SH');",   // 3 真读站点
      'const { ERIX_S2_DC } = process.env;',                       // 4 真解构站点
      'export const log = `ERIX_S2_DC=${ERIX_S2_DC}`;',            // 5 日志模板（不是站点）
    ].join('\n'),
  });
  try {
    const index = buildEnvSiteIndex(dir);
    assert.deepEqual(s2Coords(index, 'ERIX_S2_SH'), ['lib/shadow.js:3(reflect:get)'],
      '注释行 / 散文串被算成了新形状站点 ⇒ 索引不再是扫描器给的事实');
    assert.deepEqual(s2Coords(index, 'ERIX_S2_DC'), ['lib/shadow.js:4(destructure)'],
      `解构站点行号漂了（实际 ${JSON.stringify(s2Coords(index, 'ERIX_S2_DC'))}）`);
    for (const [key, line] of [['ERIX_S2_SH', 1], ['ERIX_S2_SH', 2], ['ERIX_S2_DC', 5]]) {
      const why = siteIndexProblems([s2At(key, 'lib/shadow.js', line)], index, dir).join('\n');
      assert.match(why, new RegExp(`不是 ${key} 的读站点`), `lib/shadow.js:${line} 不是站点却被放行`);
    }
    assert.deepEqual(siteIndexProblems([s2At('ERIX_S2_SH', 'lib/shadow.js', 3)], index, dir), []);
    assert.deepEqual(siteIndexProblems([s2At('ERIX_S2_DC', 'lib/shadow.js', 4)], index, dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#587-S2-⑦ 真树不许静默：扫描面里每一处三形（含拷贝形）都必须留下站点、unsupported，或绑成别名', () => {
  // 粗文本尺（故意与扫描器**不同实现**，只用来问「这一形出现过吗」）：允许多报，多报了只是要求
  // 扫描器给出交代，不会少报 ⇒ 「静默漏过」一定会被抓住。
  const index = REPO_SITE_INDEX;
  const scanned = scanEnvReads(REPO_ROOT);
  const linesWithRecord = new Map();     // rel → Set(line)
  const addLine = (rel, ln) => {
    if (!linesWithRecord.has(rel)) linesWithRecord.set(rel, new Set());
    linesWithRecord.get(rel).add(ln);
  };
  for (const [, perFile] of scanned.keys) {
    for (const [rel, list] of perFile) for (const s of list) addLine(rel, s.line);
  }
  for (const u of scanned.unsupported) {
    const { rel, line } = splitCoord(u.at);
    if (line != null) addLine(rel, line);
  }
  const silent = [];
  const hits = [];
  for (const file of scanTargets(REPO_ROOT)) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    const code = stripComments(text);
    const ctx = analyzeEnvReads(code, text);
    const alts = ['process\\s*\\??\\.\\s*env', ...[...ctx.envObjs].map(escRe)];
    const OBJ = `(?:${alts.join('|')})`;
    const shapeRe = new RegExp(
      `(?<![\\w$.])Reflect\\s*\\.\\s*(?:get|has)\\s*\\(\\s*${OBJ}`
      + `|\\b(?:const|let|var)\\s*\\{[\\s\\S]{0,400}?\\}\\s*=\\s*${OBJ}`
      + `|(?<![\\w$.])Object\\s*\\.\\s*assign\\s*\\([\\s\\S]{0,200}?${OBJ}`
      + `|\\.\\.\\.\\s*${OBJ}`
      + `|\\bObject\\s*\\.\\s*(?:keys|values|entries)\\s*\\(\\s*${OBJ}`
      + `|\\bfor\\s*\\(\\s*(?:const\\s+|let\\s+|var\\s+)?[A-Za-z_$][\\w$]*\\s+in\\s+${OBJ}`, 'g');
    for (const m of code.matchAll(shapeRe)) {
      const startLine = lineAt(code, m.index);
      const endLine = lineAt(code, m.index + m[0].length);
      hits.push(`${rel}:${startLine}`);
      let covered = false;
      for (let ln = startLine; ln <= endLine + 2 && !covered; ln += 1) {
        if (linesWithRecord.get(rel)?.has(ln)) covered = true;
      }
      // 拷贝形绑成了 env 别名 ⇒ 它的读取在**点号/下标**那一头逐条记账，这一行本身不算读站点
      const before = code.slice(Math.max(0, m.index - 60), m.index + 1);
      for (const id of ctx.envObjs) {
        if (new RegExp(`\\b${escRe(id)}\\s*=[^=]`).test(`${before} `)) covered = true;
      }
      if (!covered) silent.push(`${rel}:${startLine} ${m[0].replace(/\s+/g, ' ').slice(0, 70)}`);
    }
  }
  const fam = { reflect: 0, destructure: 0, copy: 0 };
  for (const [, perFile] of scanned.keys) {
    for (const [, list] of perFile) {
      for (const s of list) {
        if (s.shape.startsWith('reflect:')) fam.reflect += 1;
        else if (s.shape.startsWith('destructure')) fam.destructure += 1;
      }
    }
  }
  const copyShape = /Object\.assign|Object\.(?:keys|values|entries)|for \(|\.\.\./;
  fam.copy = scanned.unsupported.filter((u) => copyShape.test(u.shape)).length;
  console.log(`# S2 真树现读：keys=${scanned.keys.size} 读站点=${index.siteCount()} `
    + `unsupported=${scanned.unsupported.length}；新形状归因：reflect=${fam.reflect} `
    + `destructure=${fam.destructure} 兜底条目=${fam.copy}；粗尺命中 ${hits.length} 处（`
    + `${JSON.stringify(hits.slice(0, 12))}）`);
  assert.deepEqual(silent, [],
    `扫描面里有「这一形出现过、但扫描器一个字没说」的静默位：\n${silent.join('\n')}`);
  // 真树的**具体**收益（行号现取，不手抄）：env 拷贝别名之后的 `delete childEnv.ERIX_STATION_TOKEN`
  const delLine = lineOf('runner/agentd.js', 'delete childEnv.ERIX_STATION_TOKEN');
  assert.ok(index.hasReadSite('ERIX_STATION_TOKEN', 'runner/agentd.js', delLine),
    `runner/agentd.js:${delLine} 在 env 拷贝（{ ...baseEnv }）上取这个名字，索引里却没有站点`);
  // `delete <env拷贝>.KEY` 与 `delete process.env.KEY` 必须是同一条口径（旧尺本来就把 delete 形算读）
  const delDir = fixtureRoot({ 'a.js': 'delete process.env.ERIX_S2_DEL_DIRECT;\n' });
  try {
    assert.deepEqual(s2Coords(buildEnvSiteIndex(delDir), 'ERIX_S2_DEL_DIRECT'), ['a.js:1(dot)'],
      '`delete process.env.KEY` 的旧口径变了 ⇒ 本步只该加别名识别，不该改读写判定');
  } finally { fs.rmSync(delDir, { recursive: true, force: true }); }
});

export { scanEnvReads, scanEnvKeys, analyzeEnvReads, scanTargets };
