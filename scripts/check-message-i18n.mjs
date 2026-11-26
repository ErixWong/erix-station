#!/usr/bin/env node
// 服务端下发文案的双语**反退化闸**（issue #803 S1）。仿 `scripts/check-doc-impl.mjs` 的
// 写法与退出码风格：命中即打印 `RED …`，全绿打印 `VERDICT ok`，`process.exit(main())`（0/1）。
//
// 扫 `portal/src/**/*.js`（排除 `locale.js` 本身），做两道独立检查：
//
//  ① 抛出点分类 + **floor 语义**（“只许减不许增”）：
//     对每一处 `throw new HttpError(…)`：
//       · 该抛出语句（跨行、按括号平衡取全，字符串/注释内的括号不误算）里出现真实标识符 `en:`
//         （`\ben\s*:`，且已剔除字符串字面量，`token:` 之类不误判）⇒ **已双语**；
//       · 否则该语句任一行带 `// i18n-exempt: <具体理由>（#803）` ⇒ **豁免**；理由要具体
//         （空话 / 不含 `（#803）` ⇒ 红，防拿它当万能挡箭牌）；
//       · 否则 ⇒ **未双语**。
//     未双语计数 **>** `UNBILINGUAL_FLOOR` ⇒ 红（不许增）。**<** 也绿（渐进覆盖是好事），
//     但降了要顺手把 `UNBILINGUAL_FLOOR` 调小（见下）。
//
//  ② **parity**：`runtime-settings.js` 的 `RUNTIME_SETTING_REGISTRY` 里 `label` 有 ⇒ `labelEn` 必有、
//     `hint` 有 ⇒ `hintEn` 必有、没 `hint` ⇒ 不许凭空 `hintEn`（漏一条即红）。
//
// UNBILINGUAL_FLOOR 是什么 / 怎么随覆盖下降 / 降了要同步改这里：
//   这个数字 = 「`portal/src` 里 `throw new HttpError` 抛出点中，既没给 `en:`、也没标 `i18n-exempt` 的条数」。
//   S1 起点：全部来自 `http.js` 的 154 处（S1 只铺机制、没翻译任何抛出点；`auth.js` 等各自抛自己的
//   `*Error`、不经 `HttpError`，故不计入本账；`runtime-settings.js` 抛 `RuntimeSettingsError`，也不计）。
//   怎么下降：S2/S3 每把一个抛出点补上 `en:`，未双语 -1；把某条确证「不该出英文」并标 `i18n-exempt` 也 -1；
//   补满 / 标完后归零。**每降一批就同步把下面的 UNBILINGUAL_FLOOR 改成新的更小实测值**（闸本身不因为「降了没记账」
//   变红，但留着虚高的上界就等于没记账）。**增加**（新加一处没 `en:` 的 `throw new HttpError`）⇒ 一定红。
//
// ⚠ 本地自测：`node scripts/check-message-i18n.mjs --count` 只打印当前实测值（便于降档时取新数）。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'portal/src');
const RUNTIME_SETTINGS_SRC = path.join(ROOT, 'portal/src/runtime-settings.js');
const THROW_MARKER = 'throw new HttpError';

// 未双语地板（见文件头）。降覆盖后要同步改这里。
const UNBILINGUAL_FLOOR = 154;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** 递归收集 `portal/src` 下的 `.js`（排除 `locale.js` 本身）。 */
function collectSourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      collectSourceFiles(full, out);
    } else if (name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 从 `openIdx`（一个 `(`）起，返回与之配对的 `)` 的下标；**跳过字符串与注释里的括号**，
 * 找不到配对就返回文本末尾（有界，绝不越界）。
 */
function matchingClose(text, openIdx) {
  let depth = 0;
  let i = openIdx;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(text, i);
      continue;
    }
    if (c === '/' && text[i + 1] === '/') { i = skipLineComment(text, i); continue; }
    if (c === '/' && text[i + 1] === '*') { i = skipBlockComment(text, i); continue; }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return n - 1;
}

function skipString(text, i) {
  const quote = text[i];
  i += 1;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  return text.length;
}
function skipLineComment(text, i) {
  const nl = text.indexOf('\n', i);
  return nl === -1 ? text.length : nl;
}
function skipBlockComment(text, i) {
  const end = text.indexOf('*/', i + 2);
  return end === -1 ? text.length : end + 2;
}

/** 把字符串与注释替换成空白（保长度可省，这里直接返回去掉字符串后的代码文本）；`// i18n-exempt` 之类注释也去掉。 */
function codeOnly(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const j = skipString(text, i);
      out += ' '; // 字符串整体压成一个空格，避免把内容里的 `token:` 当成标识符 `en:`
      i = j;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') { i = skipLineComment(text, i); continue; }
    if (c === '/' && text[i + 1] === '*') { i = skipBlockComment(text, i); continue; }
    out += c;
    i += 1;
  }
  return out;
}

/** 一行 `// i18n-exempt: <理由>（#803）` 里，理由必须具体：非空、含 `（#803）`、不是几个空话词。 */
const VAGUE_EXEMPT = new Set(['', '略', 'todo', '待补', 'n/a', 'na', '无', '不需要', '不用翻译', '不需英文']);
function exemptReasonOk(stmtRaw) {
  const m = stmtRaw.match(/i18n-exempt:\s*([\s\S]*?)（\s*#803\s*）/);
  if (!m) return false; // 标了 i18n-exempt 却没写全 `（#803）` ⇒ 不算有效豁免（会被当未双语）
  const reason = m[1].trim().replace(/\s+/g, ' ');
  if (VAGUE_EXEMPT.has(reason.toLowerCase())) return false;
  return reason.length >= 4; // 太短当空话
}

/** 数一遍未双语抛出点，并返回明细（`--count` 与红判都靠它）。 */
function measureThrowSites() {
  const files = collectSourceFiles(SRC_DIR)
    .filter((f) => path.basename(f) !== 'locale.js')
    .sort();
  let unbilingual = 0;
  let bilingual = 0;
  let exempt = 0;
  const badExempt = [];
  const firstUnbilingual = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    let from = 0;
    for (;;) {
      const hit = text.indexOf(THROW_MARKER, from);
      if (hit === -1) break;
      from = hit + THROW_MARKER.length;
      const openParen = text.indexOf('(', hit);
      if (openParen === -1) { unbilingual += 1; continue; }
      const close = matchingClose(text, openParen);
      const lineEnd = text.indexOf('\n', close);
      const sliceEnd = lineEnd === -1 ? text.length : lineEnd;
      const raw = text.slice(hit, sliceEnd); // 含语句与其尾随注释
      if (/\ben\s*:/.test(codeOnly(raw))) { bilingual += 1; continue; }
      if (/i18n-exempt/.test(raw)) {
        if (exemptReasonOk(raw)) { exempt += 1; }
        else { exempt += 1; badExempt.push(`${path.relative(ROOT, file)}:${lineNo(text, hit)}`); }
        continue;
      }
      unbilingual += 1;
      if (firstUnbilingual.length < 5) {
        firstUnbilingual.push(`${path.relative(ROOT, file)}:${lineNo(text, hit)}`);
      }
    }
  }
  return { unbilingual, bilingual, exempt, badExempt, firstUnbilingual };
}

function lineNo(text, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/** parity：从真模块读出 `RUNTIME_SETTING_REGISTRY`，逐条比对 label/labelEn、hint/hintEn。 */
async function checkParity() {
  assert(existsSync(RUNTIME_SETTINGS_SRC), `读不到运行时设置源：${RUNTIME_SETTINGS_SRC}`);
  const mod = await import(pathToFileURL(RUNTIME_SETTINGS_SRC).href);
  const registry = mod.RUNTIME_SETTING_REGISTRY;
  assert(registry && typeof registry === 'object', 'RUNTIME_SETTING_REGISTRY 没导出或不是对象');
  const reds = [];
  for (const [key, entry] of Object.entries(registry)) {
    const hasLabel = typeof entry?.label === 'string' && entry.label !== '';
    const hasLabelEn = typeof entry?.labelEn === 'string' && entry.labelEn !== '';
    const hasHint = typeof entry?.hint === 'string' && entry.hint !== '';
    const hasHintEn = typeof entry?.hintEn === 'string' && entry.hintEn !== '';
    if (hasLabel && !hasLabelEn) {
      reds.push(`runtime-settings.js[${key}]: 有 label 但缺非空 labelEn（parity）`);
    }
    if (hasHint && !hasHintEn) {
      reds.push(`runtime-settings.js[${key}]: 有 hint 但缺非空 hintEn（parity）`);
    }
    if (!hasHint && hasHintEn) {
      reds.push(`runtime-settings.js[${key}]: 没有 hint 却有 hintEn（界面会凭空多一行提示）`);
    }
  }
  return reds;
}

async function main() {
  const argv = process.argv.slice(2);
  const say = (line) => console.log(line);

  if (argv.includes('--count')) {
    const m = measureThrowSites();
    say(String(m.unbilingual));
    return 0;
  }

  let reds = 0;
  const m = measureThrowSites();

  // ① floor：只许减不许增。
  if (m.unbilingual > UNBILINGUAL_FLOOR) {
    reds += 1;
    say(`RED  [floor] unbilingual: 未双语抛出点 ${m.unbilingual} > UNBILINGUAL_FLOOR ${UNBILINGUAL_FLOOR}（只许减不许增）`);
    say(`      ↳ 样例：${m.firstUnbilingual.join(' / ')}`);
    say('      ↳ 补 `en:` 或标 `// i18n-exempt: <具体理由>（#803）`；确属覆盖提升则把 UNBILINGUAL_FLOOR 同步调小。');
  }
  for (const where of m.badExempt) {
    reds += 1;
    say(`RED  [floor] bad-exempt: ${where} — i18n-exempt 理由缺失/空话/未写全（#803）`);
  }

  // ② parity：runtime-settings.js 的 label/hint 双语成对。
  const parityReds = await checkParity();
  for (const r of parityReds) {
    reds += 1;
    say(`RED  [parity] ${r}`);
  }

  if (reds === 0) {
    say(`VERDICT ok（未双语 ${m.unbilingual} ≤ 地板 ${UNBILINGUAL_FLOOR}；已双语 ${m.bilingual}、豁免 ${m.exempt}；parity 全绿）`);
    return 0;
  }
  say(`VERDICT red（${reds} 条）`);
  return 1;
}

// `main()` 是 async（parity 要动态 import 真模块）：ESM 顶层 await 取回退出码后再 `process.exit`。
process.exit(await main());
