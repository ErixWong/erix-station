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

/** 间接常量表：`const FOO_ENV = 'ERIX_BAR'` ⇒ `Map(常量名 → Map(env 名 → 出处文件))`。 */
function indirectEnvConsts(src, file) {
  const out = new Map();
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([A-Za-z][A-Za-z0-9_]{2,})['"]/g)) {
    if (!out.has(m[1])) out.set(m[1], new Map());
    out.get(m[1]).set(m[2], file);
  }
  return out;
}

/**
 * 扫描 `root` 下对 env 的**读取**，返回 `Map(env 名 → Set(相对出处文件))`。四形（缺一形就会漏一个键）：
 *   形① `process.env.ERIX_X`                     —— 直接点号（写赋值 `process.env.X = v` 不算读）
 *   形② `process.env['ERIX_X']`                  —— 字面量下标
 *   形③ `process.env[SOME_ENV]`                  —— 间接常量下标（`const SOME_ENV = 'ERIX_X'`）
 *   形④ `f(env = process.env, { key = SOME_ENV }) { env?.[key] }` —— **参数默认值 + 动态下标**
 *        （#557 那个 key 在 `final-text-toolcall.js:188` 就是这一形，漏了它 = 复刻根因）
 * 只保留 `NAMESPACED_ENV_NAME` 命中的名字。
 */
function scanEnvKeys(root) {
  const files = scanTargets(root);
  const consts = new Map();
  const sources = new Map();
  const add = (name, file) => {
    if (!NAMESPACED_ENV_NAME.test(name)) return;
    if (!sources.has(name)) sources.set(name, new Set());
    sources.get(name).add(path.relative(root, file));
  };
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const [name, lits] of indirectEnvConsts(src, f)) {
      if (!consts.has(name)) consts.set(name, new Map());
      for (const [lit, where] of lits) consts.get(name).set(lit, where);
    }
  }
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    // 写形态先抹掉（`process.env.X = v` 是给子进程传值，不是「这个 env 名有配置面」）
    const src = raw.replace(/process\.env\.[A-Za-z_$][\w$]*\s*=(?!=)/g, 'process.env.__WRITE__ ');
    for (const m of src.matchAll(/process\.env\.([A-Za-z_$][\w$]*)/g)) add(m[1], f);
    for (const m of src.matchAll(/process\.env\[\s*['"]([^'"]+)['"]\s*\]/g)) add(m[1], f);
    for (const m of src.matchAll(/process\.env\[\s*([A-Za-z_$][\w$]*)\s*\]/g)) {
      for (const lit of consts.get(m[1])?.keys() ?? []) add(lit, f);
    }
    for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*(?:,\s*\}|\})/g)) {
      const [, local, alias] = m;
      const lits = consts.get(alias);
      if (!lits || lits.size === 0) continue;
      // 该局部名必须真的被当**下标**读过，否则只是「默认值恰好叫这个名」
      if (!new RegExp(`\\[\\s*${local}\\s*\\]`).test(src)) continue;
      for (const lit of lits.keys()) add(lit, f);
    }
  }
  return sources;
}

/** 扫描器自证：扫到 0 个就是扫描器坏了（不是「runner 不再读 env」）—— 这一条必须红。 */
function assertScannerFoundKeys(n, where) {
  assert.ok(n > 0, `env 枚举扫到 **0 个** key（${where}）⇒ 扫描器坏了：正则没命中任何读取形，`
    + '把「扫不到」当成「没有旋钮」就是让闸门静默失效（#557 的根因是覆盖不全，不能再叠一层）');
}

const RUNNER_ENV_KEYS = scanEnvKeys(RUNNER_ROOT);
assertScannerFoundKeys(RUNNER_ENV_KEYS.size, `扫描根 ${path.relative(process.cwd(), RUNNER_ROOT)}/`);

/** 例外清单：读 + 判**理由字段**（没有理由的例外不算例外）。返回 `{ entries, problems }`。 */
function loadEnvLegExceptions() {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(ENV_LEGS_EXCEPTIONS, 'utf8'));
  } catch (e) {
    return { entries: [], problems: [`deploy/env-legs-exceptions.json 读不到或不是合法 JSON：${e.message}`] };
  }
  const entries = Array.isArray(doc?.exceptions) ? doc.exceptions : null;
  if (!entries) return { entries: [], problems: ['deploy/env-legs-exceptions.json 缺 exceptions 数组'] };
  return { entries, problems: validateEntries(entries) };
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
