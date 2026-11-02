// erix-agent 0.28.0 起的**入参住址**判据（本站走直连 `runToolLoop`，写错住址 = 每个 run 起跑即抛）。
//
// 病根（上游 issue #498 S3 + #545）：0.28.0 把 44 个扁平配置键从顶层白名单里删了，**写成扁平在启动期
// 就抛**，判词形如
//   `unknown runToolLoop option: "maxRounds" (its canonical home is config.run.maxRounds;
//    the flat spelling is rejected)`。
// 本站 `runner/worker.js` 是**唯一**的 runToolLoop 装配点（一处调用、一棵选项对象），所以判据也只需钉
// 那一处。0.26.0 时代这种错是**静默**的（引擎忽略不认识的键），0.28.0 起是**起跑即死**——一条
// 「只在真机跑起来才发现」的错误必须有一条静态判据先红。
//
// 三条判据，全部**从已安装引擎的源码里取值**（不手抄名单，上游增删名字 ⇒ 本文件自动跟上）：
//   ① 顶层键（含 shorthand 与顶层 spread 里对象字面量的键）必须**全部**在引擎的
//      `RUN_TOOL_LOOP_OPTION_NAMES` 里（0.29.0 是 26 个：端口 / 观察者 / 两个容器 / `session`）；
//   ② `config` 的组名必须在引擎 `CONFIG_NAMESPACE_SCHEMA` 的组里；
//   ③ 每个组里的叶子名必须在**该组**的叶子表里（放错组同样红）。
// 判据强度：把 `config.run.maxRounds` 改回顶层扁平 `maxRounds` ⇒ ① 立刻红（`maxRounds` 不在顶层
// 白名单里）；把叶子挪错组 / 拼错 ⇒ ③ 红。
//
// ⚠ 不 import worker.js（顶层有 fork 期副作用：umask / process.on('message') / WORKER_READY），
//   只读源码；引擎侧用**深路径 file URL** 导入（包 `exports` 只放行 `.` / `./tools` /
//   `./contract-tests`，裸深路径 import 会 ERR_PACKAGE_PATH_NOT_EXPORTED —— 同 llm-timeouts 的先例）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_PATH = path.join(RUNNER_DIR, 'worker.js');

/** 已安装引擎的包根（按包入口解析，不猜目录；包结构搬家 ⇒ fail-closed 报错）。 */
function engineRoot() {
  const entry = import.meta.resolve('erix-agent');
  return path.resolve(path.dirname(fileURLToPath(entry)), '..');
}

async function loadEngineSchema() {
  const root = engineRoot();
  const deep = (rel) => {
    const file = path.join(root, rel);
    assert.ok(fs.existsSync(file), `引擎包结构变了，找不到 ${rel}（${file}）—— 本文件的取值点需重新定位`);
    return import(pathToFileURL(file).href);
  };
  const optionNormalization = await deep('src/loop/option-normalization.js');
  const configNamespace = await deep('src/loop/config-namespace.js');
  assert.ok(Array.isArray(optionNormalization.RUN_TOOL_LOOP_OPTION_NAMES),
    '引擎不再导出 RUN_TOOL_LOOP_OPTION_NAMES：顶层白名单的取值点要重新定位（别改成手抄名单）');
  assert.ok(configNamespace.CONFIG_NAMESPACE_SCHEMA
    && typeof configNamespace.CONFIG_NAMESPACE_SCHEMA === 'object',
  '引擎不再导出 CONFIG_NAMESPACE_SCHEMA：config 组/叶的取值点要重新定位');
  return {
    topLevelNames: optionNormalization.RUN_TOOL_LOOP_OPTION_NAMES,
    schema: configNamespace.CONFIG_NAMESPACE_SCHEMA,
  };
}

// ---------------------------------------------------------------------------
// 源码扫描小工具：掩掉注释与字符串（同长度），再按花括号深度切分顶层成员
// ---------------------------------------------------------------------------

/**
 * 把注释与字符串字面量的**内容**换成空格（长度不变 ⇒ 下标与原文对齐）。
 * 为什么必须掩：worker.js 的注释里满是 `orchestrator.js:425` 这类**带冒号的片段**，直接正则找
 * `ident:` 会把 `js:` 当成一个顶层键（假红），而字符串里的 `'per-tool-declaration'` 同理。
 */
function maskNonCode(text) {
  const out = [...text];
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === c) break;
        j += 1;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** `text` 里 `key:` 后面那个对象字面量的**内容**（不含首尾花括号）；找不到就 undefined。 */
function objectBodyOf(text, keyName) {
  const masked = maskNonCode(text);
  const at = masked.search(new RegExp(`(^|[{,\\s])${keyName}\\s*:\\s*\\{`, 'u'));
  if (at === -1) return undefined;
  const open = masked.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return undefined;
}

/** 一层对象里的键名（含 shorthand 与 spread 里对象字面量的键）；`segments` 用掩码后的文本切分。 */
function keysOfObjectBody(body) {
  const masked = maskNonCode(body);
  const keys = [];
  const segments = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '{' || c === '[' || c === '(') depth += 1;
    else if (c === '}' || c === ']' || c === ')') depth -= 1;
    else if (c === ',' && depth === 0) { segments.push([start, i]); start = i + 1; }
  }
  segments.push([start, masked.length]);
  for (const [from, to] of segments) {
    const segment = masked.slice(from, to).trim();
    if (segment === '') continue;
    if (segment.startsWith('...')) {
      // 顶层 spread：里面每一个对象字面量的键都等价于这一层的键
      for (const inner of objectLiteralsIn(segment)) keys.push(...keysOfObjectBody(inner));
      continue;
    }
    const named = /^([A-Za-z_$][\w$]*)\s*(?::|$)/u.exec(segment);
    if (named) keys.push(named[1]);
  }
  return keys;
}

/**
 * 一段表达式里所有「会贡献键」的 `{ … }` 内容（用于 spread 分支）。
 *
 * ⚠ 必须排除**函数调用的实参**：`...buildEngineSeedOptions({ resume, task })` 里那个对象字面量是
 * **被调用方的入参**，不是这一层的键（不排除就会把 `resume` / `task` 误算成 `config.input` 的叶子）。
 * 判据：字面量前面（跳过空白）是 `(`、且再往前（跳过空白）是标识符或 `)` ⇒ 它是调用实参，跳过。
 * 反面例子（必须保留）：`...(cond ? { onFoldSummary: … } : {})` —— 前面是 `?` / `:`，不是 `(`。
 */
function objectLiteralsIn(expr) {
  const masked = maskNonCode(expr);
  const bodies = [];
  const prevNonSpace = (from) => {
    for (let k = from; k >= 0; k -= 1) if (!/\s/u.test(masked[k])) return k;
    return -1;
  };
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] !== '{') continue;
    const beforeOpen = prevNonSpace(i - 1);
    if (beforeOpen >= 0 && masked[beforeOpen] === '(') {
      const beforeParen = prevNonSpace(beforeOpen - 1);
      if (beforeParen >= 0 && /[A-Za-z0-9_$)]/u.test(masked[beforeParen])) continue; // 调用实参
    }
    let depth = 0;
    for (let j = i; j < masked.length; j += 1) {
      if (masked[j] === '{') depth += 1;
      else if (masked[j] === '}') {
        depth -= 1;
        if (depth === 0) { bodies.push(expr.slice(i + 1, j)); i = j; break; }
      }
    }
  }
  return bodies;
}

/** worker.js 里 `await runToolLoop({ … })` 的实参对象**内容**（配平花括号）。 */
function workerRunToolLoopOptionsBody() {
  const src = fs.readFileSync(WORKER_PATH, 'utf8');
  const masked = maskNonCode(src);
  const marker = masked.indexOf('await runToolLoop({');
  assert.notEqual(marker, -1, 'worker.js 必须仍有一处 `await runToolLoop({`');
  assert.equal(masked.indexOf('await runToolLoop({', marker + 1), -1,
    'runToolLoop 只能有一处调用点（本文件的判据只钉那一处；多一处 = 两处要同步，判据得重写）');
  const open = masked.indexOf('{', marker);
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  assert.fail('runToolLoop 的实参对象花括号没配平——抠取器假设的形状变了，同步本文件');
}

// ---------------------------------------------------------------------------
// 判据
// ---------------------------------------------------------------------------

test('0.28 入参住址 ①：worker 传给 runToolLoop 的**顶层键**必须全在引擎白名单里（扁平写法启动期就抛）', async () => {
  const { topLevelNames } = await loadEngineSchema();
  const body = workerRunToolLoopOptionsBody();
  const keys = [...new Set(keysOfObjectBody(body))];
  assert.ok(keys.length >= 10,
    `从 worker 的 runToolLoop 实参里只抠到 ${keys.length} 个顶层键（${keys.join(', ')}）—— 抠取器坏了，先修它`);
  const allowed = new Set(topLevelNames);
  const rejected = keys.filter((key) => !allowed.has(key));
  assert.deepEqual(rejected, [],
    `worker 顶层出现了引擎不接受的键：${rejected.join(', ')}\n`
    + '0.28.0 起扁平配置键在**启动期**就抛（`unknown runToolLoop option: "maxRounds" (its canonical home is '
    + 'config.run.maxRounds; the flat spelling is rejected)`）⇒ 每个 run 第 1 轮之前就死。\n'
    + `数据要写进 \`config.<组>.<叶>\`；引擎接受的顶层名（${topLevelNames.length} 个）：${topLevelNames.join(', ')}`);
  // 反向：白名单里的**观察者/端口**必须真的还在顶层（别顺手把它们搬进 config —— config 只装数据，
  // 函数值在 intake 就被拒）。抽四个代表性的：端口、工厂、回调出口、诊断出口。
  for (const required of ['provider', 'executeTool', 'store', 'onEvent', 'diagnostics']) {
    assert.ok(keys.includes(required),
      `顶层少了 ${required}：它是**端口/观察者**，规范之家就是顶层（塞进 config 会被 intake 拒：config 只装数据）`);
  }
  assert.ok(keys.includes('config'), '顶层必须有 `config`（0.28 起所有数据叶子的唯一住址）');
});

test('0.28 入参住址 ②③：config 的组名与每个组的叶子名都必须落在引擎 schema 里（放错组同样红）', async () => {
  const { schema } = await loadEngineSchema();
  const body = workerRunToolLoopOptionsBody();
  const configBody = objectBodyOf(body, 'config');
  assert.ok(configBody !== undefined, 'worker 的 runToolLoop 实参里没有 `config: { … }` —— 数据住址被搬走了？');
  const groups = [...new Set(keysOfObjectBody(configBody))];
  assert.ok(groups.length >= 4,
    `只抠到 ${groups.length} 个 config 组（${groups.join(', ')}）—— 抠取器或装配式变了`);

  const schemaGroups = new Set(Object.keys(schema));
  for (const group of groups) {
    assert.ok(schemaGroups.has(group),
      `config.${group} 不是引擎承认的组（合法组：${[...schemaGroups].join(', ')}）`);
    const groupBody = objectBodyOf(configBody, group);
    if (groupBody === undefined) continue; // `...(cond ? {...} : {})` 形态：键在 spread 里，下面统一核
    const leaves = [...new Set(keysOfObjectBody(groupBody))];
    const allowed = new Set(schema[group]);
    const wrong = leaves.filter((leaf) => !allowed.has(leaf));
    assert.deepEqual(wrong, [],
      `config.${group} 里出现了该组不接受的叶子：${wrong.join(', ')}`
      + `（该组合法叶子：${schema[group].join(', ')}）—— 叶子名逐字等于引擎的扁平键名，放错组或拼错都会在启动期抛`);
    assert.ok(leaves.length > 0, `config.${group} 抠不出叶子名 —— 抠取器坏了`);
  }

  // 三个**住址本身**被点名过的键：它们的家必须真在 config 里（这一条钉的是本片迁移的方向，
  // 不是引擎的行为）——回退成顶层会先在 ① 红，这里再红一次，把「搬回哪儿」写死在判据里。
  const mustLive = [['run', 'maxRounds'], ['folding', 'context'], ['tuning', 'maxTokens'], ['metadata', 'modelMetadata']];
  for (const [group, leaf] of mustLive) {
    const groupBody = objectBodyOf(configBody, group);
    assert.ok(groupBody !== undefined, `config.${group} 不在 worker 的装配里`);
    assert.ok(keysOfObjectBody(groupBody).includes(leaf),
      `config.${group}.${leaf} 不在 worker 的装配里 —— 0.28 的规位住址就是这里`);
  }
});

test('0.28 入参住址 ④：`config` 里不许出现函数值（config 只装数据，函数在 intake 当场拒）', async () => {
  // 引擎的判据（`collectFunctionPaths`）：config 子树必须能过 JSON round-trip。本站最容易犯的错是
  // 把 `assertCompactContext(…)` 的**返回值**留在 config 里（这是对的：它是纯数据），或者把
  // `onFoldSummary` 之类回调塞进去（这是错的：那是顶层能力面）。本判据只钉「不许有箭头函数字面量」。
  const body = workerRunToolLoopOptionsBody();
  const configBody = objectBodyOf(body, 'config');
  assert.ok(configBody !== undefined, 'worker 的 runToolLoop 实参里没有 `config: { … }`');
  const masked = maskNonCode(configBody);
  assert.doesNotMatch(masked, /=>/u,
    'config 子树里出现了箭头函数 —— 函数值在 intake 就被拒（`config namespace holds data only`）；'
    + '宿主回调的规范之家是顶层（`onFoldSummary` 等）');
});
