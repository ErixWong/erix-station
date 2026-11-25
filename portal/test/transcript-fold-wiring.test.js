// issue #337 切片 A+B：0.23 读侧折叠的**源码级护栏**（两个方向都钉）。
//
// 为什么需要：折叠只有「折在咽喉点、且不折预写面」这一种正确接法，两个方向缺一边就会有人只改一半——
//   · 少折一处 ⇒ 那条读路径的工具卡片继续退化成 `…`（`session-view.js` 的守卫会把消息行整行丢掉）；
//   · 多折一处 ⇒ 引擎的 `appendUserTurn` 幂等判据失效（看不见自己那条 `:input:` 行 ⇒ 同一轮追问被
//     重复追加），或 resume 上下文被折两遍。
// 行为用例抓不到这两个方向（折叠是**纯读面**：折多了往往仍然绿），所以照 `append-seq-ordering.test.js`
// 的先例对源码本身下断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '../src');
const REPO_ROOT = path.join(HERE, '../..'); // #351：跨面包边——折叠归位在 runner 侧，护栏要能看见对面
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** 取出某个顶层声明的函数体（到下一个顶层 `export` 为止）；取不到就红，避免护栏空转。 */
function functionBody(src, header, file) {
  const index = src.indexOf(header);
  assert.ok(index >= 0, `${file} 应包含「${header}」`);
  const rest = src.slice(index + header.length);
  const nextExport = rest.search(/\nexport /);
  return nextExport < 0 ? rest : rest.slice(0, nextExport);
}

const FOLD_CALL = /\bfold(?:LedgerRecords|TranscriptRows)\s*\(/;

test('#337 咽喉点：`projectSessionMessages` 在喂投影**之前**折叠账本（正方向）', () => {
  const src = read('session-view.js');
  const body = functionBody(src, 'export function projectSessionMessages(', 'session-view.js');

  assert.match(body, FOLD_CALL,
    'projectSessionMessages 必须调用 transcript-fold（它是全站两个业务读点的咽喉点）');
  // 用 `foldTranscriptRows`（行级），不是自己再拼一遍 record 级折叠。
  assert.match(body, /\bfoldTranscriptRows\s*\(/,
    '咽喉点应调行级 `foldTranscriptRows`（与 `foldLedgerRecords` 同一份计划）');
  // 折叠必须真的作用在喂给投影的那批行上：`recordOf` 由 `recordForProjection` 提供（不复制 key 合成规则）。
  assert.match(body, /recordOf:\s*\(row\)\s*=>\s*recordForProjection\(row\)\.record/,
    '行级折叠的 `recordOf` 必须复用 `recordForProjection`（dedupKey/round 合成口径只此一份）');

  const foldAt = body.search(FOLD_CALL);
  const projectAt = body.search(/projectTranscriptForDisplay\s*\(/);
  assert.ok(foldAt >= 0 && projectAt >= 0 && foldAt < projectAt,
    '折叠必须发生在逐行投影之前（顺序反了等于没折）');
});

// 口径在 **erix-agent 0.25.0** 翻了一次向：上游 #458 把「宿主 `store.load()` 必须返回折叠后形状」
// 从散文变成**随包契约断言**（`test/contract/transcript-store.js` 的 #401 / #458 那四格），
// 不折 = 宿主违约（实测翻红四格）。所以本单从「load 也不许折」改成**「load 必须折、两个点查探针
// 照旧不许折」**——两个方向都得钉，单边钉住就会有人改一半。
// #337 当年的顾虑（`appendUserTurn` 要看得见自己那条 `:input:` 行）没有作废，是靠两条事实同时成立的：
//   ① 幂等判据实际走 `loadByDedupKey` 点查（0.17.0 #157 起），那条路仍然读原始行；
//   ② `:input:` 行不带 `kind:"message"` 也不带 `seq` ⇒ `isFoldableMessageRow` 判不通过，
//      折完它仍在数组里（行为判据在 `portal/test/transcript-store.test.js`）。
test('#337+#458 折叠方向：`transcript-store.js` 的 load **必须折**，两个点查探针**必须不折**', () => {
  const src = read('transcript-store.js');
  const at = (header) => {
    const index = src.indexOf(header);
    assert.ok(index >= 0, `transcript-store.js 应包含「${header}」（改名/删掉时这条护栏不能空转）`);
    return index;
  };
  const loadAt = at('async load(key)');
  const probe1At = at('async loadByDedupKey(key, dedupKey)');
  const probe2At = at('async loadMaxRound(key)');
  assert.ok(loadAt < probe1At && probe1At < probe2At, '三个方法的源码顺序与预期一致（否则下面的切片失效）');

  const loadBody = src.slice(loadAt, probe1At);
  const probe1Body = src.slice(probe1At, probe2At);
  const probe2Body = src.slice(probe2At);

  assert.match(loadBody, /\bfoldLedgerRecords\s*\(/,
    '0.25.0 契约判据：load() 必须返回**折叠后**形状（撤掉它 ⇒ 随包契约 #401/#458 那四格红）');
  assert.doesNotMatch(probe1Body, FOLD_CALL,
    '点查探针①必须读原始行：`appendUserTurn` 的幂等判据靠它，且这是上游「两个点查探针不折叠」的同口径');
  assert.doesNotMatch(probe2Body, FOLD_CALL, '点查探针②同理（成对探针只认原始行）');
});

test('#337 `fetchInputTextByMessageId` **不折**（点查单行 `:input:` 行，天生不需要折）', () => {
  const src = read('session-text.js');
  const body = functionBody(src, 'export async function fetchInputTextByMessageId(', 'session-text.js');
  assert.match(body, /:input:\$\{messageId\}/, '该函数必须仍是按 `<sessionId>:input:<messageId>` 点查单行');
  assert.doesNotMatch(body, FOLD_CALL, '单行点查不得折叠（它读的是 appendUserTurn 写的用户输入行）');
  assert.doesNotMatch(src, /transcript-fold/, 'session-text 不得引用折叠模块（文本读取走 projectSessionMessages 的咽喉点）');
});

test('#337 引擎取上下文与 run 作用域 legacy 端点**不折**（`internal.js`）', () => {
  const src = read('internal.js');
  for (const marker of ['getSessionTranscript', 'getTranscript', 'collectRoundText', 'recallTranscript']) {
    assert.ok(src.includes(marker), `internal.js 应仍包含「${marker}」（否则本条护栏空转）`);
  }
  assert.doesNotMatch(src, /transcript-fold/, 'internal.js 不得引用折叠模块');
  assert.doesNotMatch(src, FOLD_CALL,
    '#351 后口径：引擎只调 foldLedgerMessages（只接 partOf），载体折叠归 store——那是 runner/lib/store.js 的活；'
    + '端点再折一遍是页内折（跨页轮会漏），legacy run 作用域端点更不该动');
});

test('#337 折叠模块只有三个消费点（`session-view.js` / `transcript-store.js` / `delegation.js`），别处引用即红', () => {
  // 判据是「**真的 import 了本模块**」，不是「文本里出现过模块名」。护栏自己说过：注释不是消费点
  // （所以模块自己的文件早就是排除项）——但旧写法只排除了自身，别的文件在**注释里**提一下模块名
  // 就被咬红（#387 实测：`sessions.js` 重建路的注释点了「读侧折叠」的名字 ⇒ 假红）。
  // 那等于把护栏退化成打字员：想说不算消费，写了才算。因此改成只认 import/export from 语句。
  // PR #541 LOW #4 补的三块盲区（旧谓词都能被合法写法绕过 ⇒ 开了第二家折叠而护栏全绿）：
  //   · **动态 `import()`** 是合法 ESM：`await import('./transcript-fold.js')` 旧谓词全认不出；
  //     `require()` 在本仓是 CJS 遗留，在 ESM 里拼它就是走偏，同样算消费点；
  //   · **多行**具名 import（`import {\n a,\n} from '…'`）：旧谓词的 `[^\n]*` 卡在行尾，拼成多行就漏；
  //   · **嵌套目录**：旧扫描只看 `portal/src` 顶层，子目录里的文件根本没人看（今天没有子目录，
  //     但「没有」不等于「不许有」）⇒ 改成递归扫，允许清单口径不变。
  // 剩下的已知代价：剔注释是正则剔的，剔不掉「字符串里塞一整段
  // 带 `//` 的文本」这种写法（假红方向，不是假绿方向）；非相对路径写法（别名 `@/x`、裸包名）不认。
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // `http://` 里的 `//` 前面有冒号 ⇒ 不吞
  const CONSUMES = /(?:^|\n)[ \t]*(?:import|export)\b[^;'"()]*?\bfrom\s*['"][^'"]*transcript-fold\.js['"]|(?:^|\n)[ \t]*import\s+['"][^'"]*transcript-fold\.js['"]|\b(?:import|require)\s*\(\s*['"][^'"]*transcript-fold\.js['"]\s*\)/;
  const consumesFold = (src) => CONSUMES.test(stripComments(src));
  const files = fs.readdirSync(SRC, { recursive: true })
    .filter((name) => name.endsWith('.js'))
    .filter((name) => path.basename(name) !== 'transcript-fold.js');
  const importers = files.filter((name) => consumesFold(read(name)));
  // 允许清单在 0.25.0 从 1 个变 2 个：`transcript-store.js` 的 `load()` 现在也必须折
  //（上游 #458 的随包契约），口径必须与咽喉点**同一份** `planFold` —— 这正是「两处都用同一模块」
  // 的理由，不是「多一个消费点就违规」。名单外的新引用仍然红：折叠口径只许有一份。
  // delegation P2 把它从 2 个抬到 3 个：`delegation.js` 读的是**子 run 的账本文件**（不在 DB），
  // 入口不同、规则同一份：它调 `foldLedgerRecords(records)`（文件记录），而咽喉点调
  // `foldTranscriptRows(rows)`（DB 行），两者底下都是同一个 `planFold`。新增入口而不是另开一套
  // 折叠，正是本护栏要的方向：口径漂移只在 `transcript-fold.js` 一处可能发生。
  // ⚠ **#387 没有把名单抬到 4 个**：重建路（`sessions.js`）走的是「把 `tool_result` 挂回记录、
  //   配对交给上游投影」，**不折**（端点 SQL 只取 `round, messages`，拿不到 record 级形状，
  //   而放载体行进来会让投影走 `response.content` 回退分支⇒ 正文重复）。它不消费本模块，
  //   所以名单就该是三个——真加第四个消费点仍要改这里并写理由。
  assert.deepEqual(importers, ['delegation.js', 'session-view.js', 'transcript-store.js'],
    `只允许这三个消费点 import transcript-fold.js（口径只此一份），实际：${importers.join(', ') || '零个'}`);
  // 反向自证：把「注释里提一下」和「真的 import 了」分开——自己拼一句 import 喂给谓词必须判为消费。
  assert.ok(CONSUMES.test("\nimport { foldLedgerRecords } from './transcript-fold.js';\n"),
    '谓词本身必须能认出真 import（空转的谓词会把「谁都能引用」读成绿灯）');
  assert.ok(!CONSUMES.test(' * 口径与 `transcript-fold.js` 逐字同构。\n'),
    '纯注释不得算消费点（否则护栏只能逼人不写注释）');
  // LOW #4 的注入自证：绕过旧谓词的写法现在必须全部判为消费（只钉「真 import」等于没补盲区）。
  const INJECTIONS = [
    ["\nimport {\n  foldLedgerRecords,\n  foldTranscriptRows,\n} from './transcript-fold.js';\n", '多行具名 import'],
    ["\nconst m = await import('./transcript-fold.js');\n", '动态 import()'],
    ['\nconst m = await import("./transcript-fold.js");\n', '动态 import()（双引号）'],
    ["\nconst { foldLedgerRecords } = require('./transcript-fold.js');\n", 'require()'],
    ["\nexport { foldLedgerRecords } from './transcript-fold.js';\n", '具名再导出'],
    ["\nexport * from './transcript-fold.js';\n", '星号再导出'],
    ["\nimport './transcript-fold.js';\n", '无绑定的副作用 import'],
  ];
  for (const [snippet, label] of INJECTIONS) {
    assert.ok(consumesFold(snippet), `${label} 必须被认成消费点（拼上去就开了第二家折叠）：${JSON.stringify(snippet)}`);
  }
  // 反向：注释里拼出这些形状仍然不算消费；与本模块无关的 import / require 也不许误咬。
  for (const [snippet, label] of [
    [" * \u53e3\u5f84\u4e0e `transcript-fold.js` \u9010\u5b57\u540c\u6784\u3002\n", '纯注释（旧形状）'],
    ["\n// \u522b\u7528 await import('./transcript-fold.js') \u7ed5\u8fc7\u62a4\u680f\n", '注释里的动态 import()'],
    ["\n// require('./transcript-fold.js') \u662f\u65e7\u5199\u6cd5\n", '注释里的 require()'],
    ["\nimport { x } from './session-text.js';\n", '无关模块的 import'],
    ["\nconst y = await import('./transcript-store.js');\n", '无关模块的动态 import'],
  ]) {
    assert.ok(!consumesFold(snippet), `${label} 不算消费点：${JSON.stringify(snippet)}`);
  }
});

test('#351 引擎面的折叠在 runner 侧（`runner/lib/store.js`），portal 端点面**不得**再折一遍', () => {
  // 折叠口径归位后（#351）：引擎 `store.load()` 的输出由 `runner/lib/store.js` 折一次（在 agentd
  // 把游标翻页**全量**拉齐之后）。portal 的分页端点若也折，就会在**页内**折 ⇒ 一轮跨两页时漏折，
  // 正是 #338 的病根 ⇒ 这里钉住「端点仍返回原始行」。
  const src = read('internal.js');
  const body = /async function getSessionTranscript\(|export async function getSessionTranscript\(\([\s\S]*?\n\}/.exec(src)?.[0] ?? '';
  assert.ok(body.length > 0, 'getSessionTranscript 找不到了 ⇒ 本条护栏空转，先修测试再谈改动');
  assert.doesNotMatch(body, FOLD_CALL,
    '引擎面向的分页端点不得折叠：折叠在 runner 的 store.load()（全量聚合之后）做，页内折会漏折跨页的轮');
  const runnerStore = fs.readFileSync(path.join(REPO_ROOT, 'runner/lib/store.js'), 'utf8');
  assert.match(runnerStore, /foldLedgerRecords\(records\)/,
    '引擎面的折叠必须在 runner/lib/store.js#load（与上游「内置 store 在 load() 里折」同构）');
});
