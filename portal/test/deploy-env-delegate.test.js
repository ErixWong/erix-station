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
function analyzeEnvReads(code) {
  const masked = structuralMask(code);
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
    const masked = structuralMask(code);         // 再把字符串正文抹平 ⇒ 用来判「这个位置是不是串里的文字」
    const ctx = analyzeEnvReads(code);
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
 * 写歪了要能点名并给出**能照着改**的文案，而不是「一个引用都没扫到」再报一句「这是说明文字」
 * —— 那句话对 `deploy/env-legs-exceptions.json:12` 是误导（它当然是坐标，只是不是 JS 坐标）。
 */
const COORD_REF = /(?<abs>\/)?(?<path>[A-Za-z0-9_.+-]+(?:\/[A-Za-z0-9_.+-]+)*)\.(?<ext>js|mjs|cjs|json|ya?ml|yml|md|ts|sh|lock|env)(?::\s*(?<from>\d+)(?:\s*-\s*(?<to>\d+))?)?/g;
/** 可核对的代码坐标只认 JS 源文件（`.json`/`.yml` 是**数据**，判据不替它核对内容）。 */
const JS_SOURCE_EXT = new Set(['js', 'mjs', 'cjs']);
/** 测试面（族 B①.1）：这些目录里的 env 名字多半是**断言字符串**，不是「产品代码在这儿读了它」。 */
const TEST_FACE_DIRS = new Set(['test', 'tests', '__tests__', 'node_modules', 'fixtures', 'probes', 'integration']);

/** `portal/test/provisioner.test.js`、`test/lib/js-source.mjs`、`**\/*.test.js` ⇒ 测试面。 */
function isTestFace(rel) {
  const segs = String(rel ?? '').split('/');
  return segs.some((s) => TEST_FACE_DIRS.has(s)) || /\.test\.[cm]?js$/.test(segs[segs.length - 1]);
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
function mentionsKeyIn(code, masked, start, end, key) {
  let i = start;
  while (i < end) {
    i = code.indexOf(key, i);
    if (i < 0 || i >= end) return false;
    if (isCodePosition(code, masked, i, key.length)) return true;
    const body = maskedBodyAround(code, masked, i);
    if (body !== null) {
      const t = body.trim();
      if (t === key || t.startsWith(`${key}=`)) return true;
    }
    i += 1;
  }
  return false;
}

/** 那一行含该 key 的字面量，或含一个能解析到它的常量名（表驱动那种真坐标必须算通过）。 */
function lineMentionsKey(code, masked, ctx, key, start, end) {
  if (mentionsKeyIn(code, masked, start, end, key)) return true;
  for (const m of code.slice(start, end).matchAll(new RegExp(IDENT_RE, 'g'))) {
    const at = start + m.index;
    if (!isCodePosition(code, masked, at, m[0].length)) continue;   // 串正文里「长得像标识符」的文字不算名字引用
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
      if (key != null && mentionsKeyIn(code, masked, 0, code.length, key)) return problems;
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
          : lineMentionsKey(code, masked, ctx, key, span[0], span[1]));
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
    reasonRefs.forEach((r, j) => {
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

export { scanEnvReads, scanEnvKeys, analyzeEnvReads, scanTargets };
