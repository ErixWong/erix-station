// issue #338 P4：session transcript 分页游标的**源码级护栏**（三个方向都钉）。
//
// 为什么行为用例不够：这条缺陷的三种回退形态都能让「只看条数/只看集合」的用例假绿，而且
// 三种回退分散在三个文件里（SQL 谓词 / http 透传 / agentd 回传）——改任何一处都只有**跨文件**
// 的端到端用例才红，本地跑单文件时看不见。所以照 `transcript-fold-wiring.test.js` 的先例，
// 对源码本身下断言：
//   ① `internal.js#getSessionTranscript`：SQL 必须是 `(round, append_seq)` 真 keyset（谓词两列），
//      `next_cursor` 必须由 **两段** 拼成（`<round>:<append_seq>`），且 `append_seq` 不得漏进返回集；
//   ② `http.js`：游标必须**原样字符串透传** + 形态校验（`Number(...)` = NaN = 第二页从头重读 = 死循环）；
//   ③ `agentd.js`：回传必须 `encodeURIComponent`，且分页循环不能被改成单页。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '../src');
const readSrc = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const readRunner = (rel) => fs.readFileSync(path.join(HERE, '../../runner', rel), 'utf8');

/** 取出某个顶层声明的函数体（到下一个顶层 `export` 为止）；取不到就红，避免护栏空转。 */
function functionBody(src, header, file) {
  const index = src.indexOf(header);
  assert.ok(index >= 0, `${file} 应包含「${header}」`);
  const rest = src.slice(index + header.length);
  const nextExport = rest.search(/\nexport /);
  return nextExport < 0 ? rest : rest.slice(0, nextExport);
}

test('#338 ①：`getSessionTranscript` 的 SQL 是 (round, append_seq) 真 keyset（零 DDL，吃既有索引）', () => {
  const body = functionBody(readSrc('internal.js'), 'export async function getSessionTranscript(', 'internal.js');

  assert.match(body, /SELECT round, record, append_seq FROM transcript_rounds/,
    '读 SQL 必须把 append_seq 取出来（游标第二段 + 保序都靠它）');
  assert.match(body, /WHERE transcript_key = \$1 AND \(round, append_seq\) > \(\$2::int, \$3::bigint\)/,
    '谓词必须是行值比较 `(round, append_seq) > ($2,$3)`——退回 `AND round > $2` 就会丢同 round 的后继行');
  assert.match(body, /ORDER BY round ASC, append_seq ASC/,
    '行序仍须 append_seq 保序（0.16.0 契约）');
  assert.match(body, /LIMIT \$4/, 'LIMIT 的量纲是**行**（参数位随 append_seq 列后移一位）');
  // 反方向：不许出现「只比 round」的旧谓词。
  assert.doesNotMatch(body, /AND round > \$2\b/,
    '旧谓词 `AND round > $2` 已退役（严格大于 ⇒ 页边界切在一轮肚子里时丢行）');
});

test('#338 ①：`next_cursor` 由 round 与 append_seq 两段拼成，且 append_seq 不进返回集', () => {
  const body = functionBody(readSrc('internal.js'), 'export async function getSessionTranscript(', 'internal.js');

  // 两段拼接：模板串里 `${…round…}:${…append_seq…}`（形态 `<round>:<append_seq>`）。
  assert.match(body, /`\$\{[^`]*round[^`]*\}:\$\{[^`]*append_seq[^`]*\}`/,
    'next_cursor 必须由 (round, append_seq) 两段拼成——只回 round 会让同 round 行被重读');
  // 终止性：只有「本页没取到行」才 null。
  assert.match(body, /[Nn]ext_?[Cc]ursor\s*=\s*last\s*\?/, '取到行就必须给游标（末页非空也要给），空页才 null');
  // 0.23 契约：append_seq 是分页内部列，绝不进 record。
  assert.doesNotMatch(body, /\.\.\.r\.append_seq/, 'records 不得展开 append_seq（宿主/引擎可见形状不能变）');
  assert.doesNotMatch(body, /append_seq:.*record/, 'records 不得附 append_seq 字段');
});

test('#338 ②：`http.js` 原样透传游标 + 形态校验（绝不 Number()）', () => {
  const src = readSrc('http.js');
  const idx = src.indexOf('internal.getSessionTranscript(ctx.pool');
  assert.ok(idx >= 0, 'http.js 应仍调用 internal.getSessionTranscript');
  const window = src.slice(Math.max(0, idx - 900), idx + 200);

  assert.match(window, /\/\^\[0-9\]\+:\[0-9\]\+\$\//,
    '游标形态校验 `^[0-9]+:[0-9]+$` 必须在（非法 ⇒ 400 validation_failed + details.field=cursor）');
  assert.match(window, /details:\s*\{\s*field:\s*'cursor'\s*\}/, '400 必须带 details.field=cursor');
  assert.doesNotMatch(window, /Number\([^)]*cursor[^)]*\)/,
    '绝不 Number(cursor)——`"1:1070"` → NaN ⇒ 第二页从头重读 ⇒ agentd 死循环');
  assert.doesNotMatch(window, /cursor\s*\?\s*Number/, '同上：旧的 `cursor ? Number(cursor) : null` 已退役');
});

test('#338 ③：`agentd.js` 的 load 回传 encodeURIComponent，且分页循环仍在（不是单页）', () => {
  const src = readRunner('agentd.js');
  const idx = src.indexOf("case 'load': {");
  assert.ok(idx >= 0, "agentd.js 应仍有 `case 'load': {`");
  const body = src.slice(idx, idx + 2400);

  assert.match(body, /cursor=\$\{encodeURIComponent\(cursor\)\}/,
    '回传游标必须 encodeURIComponent（`:` 在 query 里要编码成 %3A）');
  assert.doesNotMatch(body, /cursor=\$\{cursor\}/, '裸插值已退役（encodeURIComponent 是契约的一部分）');
  assert.doesNotMatch(body, /Number\(cursor\)/, '绝不 Number(cursor)');
  assert.match(body, /for \(;;\)/, '分页循环必须还在（只取一页 ⇒ 大账本丢页）');
  assert.match(body, /if \(cursor == null\) break;/, '循环的终止条件仍是 next_cursor == null');
  // 纯可观测日志：分页真的发生过才记一条（不是 run event）。
  assert.match(body, /log\('warn', 'transcript load paged'/, 'pages > 1 的 warn 日志（纯可观测，零新事件类型）');
});
