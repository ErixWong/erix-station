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

test('#337 预写幂等面**不折**：`transcript-store.js` 的 load / 两个点查探针（反方向）', () => {
  const src = read('transcript-store.js');
  // 三个承重方法仍在（改名/删掉时这条护栏不能变成空转）。
  assert.match(src, /async load\(key\)/, 'transcript-store 的 load 必须还在');
  assert.match(src, /async loadByDedupKey\(key, dedupKey\)/, '点查探针①必须还在');
  assert.match(src, /async loadMaxRound\(key\)/, '点查探针②必须还在');

  assert.doesNotMatch(src, /transcript-fold/, 'transcript-store 不得引用折叠模块');
  assert.doesNotMatch(src, FOLD_CALL,
    '预写面不得折叠：引擎 `appendUserTurn` 的幂等判据是「load/点查能看见自己那条 :input: 行」');
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

test('#337 折叠模块只有一个消费点（`session-view.js`），别处引用即红', () => {
  const files = fs.readdirSync(SRC).filter((name) => name.endsWith('.js'));
  // #351：模块自己的文件头现在要点名镜像 `runner/lib/transcript-fold.js`（两份尺的漂移说明），
  // 那是**注释**不是消费点 ⇒ 排除自身；否则「改一句注释」就把这条护栏咬红，护栏就变成了打字员。
  const importers = files
    .filter((name) => name !== 'transcript-fold.js')
    .filter((name) => read(name).includes('transcript-fold.js'));
  assert.deepEqual(importers, ['session-view.js'],
    `只允许咽喉点引用 transcript-fold.js，实际：${importers.join(', ')}`);
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
