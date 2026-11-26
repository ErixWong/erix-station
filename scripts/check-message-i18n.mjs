#!/usr/bin/env node
// 服务端下发文案的双语**反退化闸**（issue #803 S1）。仿 `scripts/check-doc-impl.mjs` 的
// 写法与退出码风格：命中即打印 `RED …`，全绿打印 `VERDICT ok`，`process.exit(main())`（0/1）。
//
// 扫 `portal/src/**/*.js`（排除 `locale.js` 本身），做两道独立检查：
//
//  ① 抛出点分类 + **floor 语义**（“只许减不许增”）：对每一处 `throw new *Error(…)`（**任何**
//    错误类，含裸 `Error`），只看语句里带**中文字面量**的（消息只拼变量 = 静态面没得翻，不入账）：
//       · 该抛出语句（跨行、按括号平衡取全，字符串/注释内的括号不误算）里带**真能用**的 `en:`
//         ⇒ **已双语**。判据不再是词面 `\ben\s*:`（#803 返修 M3 之前那样记的是**假账**），而是
//         `hasUsableEnLiteral`：`en` 是真实标识符（左邻非标识符字符）、紧跟 `:`、值是**非空字符串
//         字面量**，且位于**brace 深度 ≤ 1**。为什么这三条缺一不可：出口 `pickMessage` 读的是
//         **顶层** `err.en` 且**空串回退中文** ⇒ `en: ''` 其实一句英文也没下发；`details: { en: '…' }`
//         在深度 2、根本不会设 `err.en` ⇒ 同样「其实没有英文」，两者以前都被算成已双语。
//       · 否则该语句任一行带 `// i18n-exempt: <具体理由>（#803）` ⇒ **豁免**；理由要具体
//         （空话 / 不含 `（#803）` ⇒ 红，防拿它当万能挡箭牌）；
//       · 否则 ⇒ **未双语**。
//     未双语计数与 `UNBILINGUAL_FLOOR` **双向都红**（#803 返修 M2，为什么见下面那一节）。
//
//     ⚠ **已知边界（不修，那是另一本账）**：不经 `throw`、直接 `errorBody(code, '中文…')` 发出的
//       消息**不在这本账里**（例：`http.js` 里 `password_change_required` 那类直发点）——闸扫的是
//       `throw new *Error(`，那种出口连「一条抛出语句」都不占，既不记为未双语也不记为已双语。
//       S2/S3 清完这本账不等于那些也翻了（它们同样经 `pickMessage` 的同一族出口，但要逐条改）。
//
//  ② **parity**：`runtime-settings.js` 的 `RUNTIME_SETTING_REGISTRY` 里 `label` 有 ⇒ `labelEn` 必有、
//     `hint` 有 ⇒ `hintEn` 必有、没 `hint` ⇒ 不许凭空 `hintEn`（漏一条即红）。
//
// UNBILINGUAL_FLOOR 是什么 / 怎么随覆盖下降 / 降了要同步改这里：
//   这个数字 = 「`portal/src` 里**带中文字面量**的 `throw new *Error(…)` 抛出点中，既没给 `en:`、
//   也没标 `i18n-exempt` 的条数」。S1 收口时实测 407（按错误类：`HttpError` 82、`MacroError` 54、
//   `InternalError` 50、`AdminError` 45、`MarketError` 34、`DirError` 33、`LlmError` 31、`SessionError` 26、
//   裸 `Error` 16、`GitHostError` 9、`RuntimeSettingsError` 7、其余零头）。⚠ 为什么不是只盯 `HttpError`：
//   出口 `pickMessage` 是**通用读 `err.en`** 的，各错误类都能接英文；只盯一类等于「新增一条没翻的
//   `AdminError` 也不报错」，那就不是闸了。
//   （上面那串分解是 **S1 收口那一刻**的 407；当前地板是 406——#803 返修 m6 给 `http.js` 的
//   Content-Type 那处补了 `en:`，`HttpError` 82 → 81。分解仅供估量，**以 `--count` 为准）**。
//   怎么下降：S2/S3 每给一个抛出点补上**可用**的 `en:`，未双语 -1；把某条确证「不该出英文」并标 `i18n-exempt` 也 -1；
//   补满 / 标完后归零。**每降一批就同步把下面的 UNBILINGUAL_FLOOR 改成 `--count` 打出的新实测值。**
//   ⚠ **为什么两个方向都要红**（#803 返修 M2）：只挡「变差」的闸会把「变好」变成**没人再看的债**。
//     实测从 407 降到 406 而常量仍写 407 时，之后**新增一处**没翻的抛出点回到 407 照样绿——那次
//     覆盖提升的账白记了，而且没人会再去看（上界虚高多少，就能塞进去多少回归）。所以：
//     `实测 > 地板` ⇒ 红（回归，照旧）；`实测 < 地板` ⇒ **也红**（覆盖涨了不记账），修法只有一行：
//     把 `UNBILINGUAL_FLOOR` 改成实测值 N。**不记账等于没记账。**
//
// ⚠ 本地自测：`node scripts/check-message-i18n.mjs --count` 只打印当前实测值（便于降档时取新数）。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'portal/src');
const RUNTIME_SETTINGS_SRC = path.join(ROOT, 'portal/src/runtime-settings.js');
// 账本面：**任何**错误类的抛出点（`throw new HttpError` / `AdminError` / `MacroError` /
// `InternalError` / `DirError` / `SessionError` / `LlmError` / 裸 `Error` …），只要语句里带
// **中文字面量**。S1 最初只盯 `throw new HttpError`，实测那是**漏账**：`portal/src` 里硬编码
// 中文消息的抛出点共 407 处，`HttpError` 只占其中 82（`AdminError` 45 / `MacroError` 54 /
// `InternalError` 50 …各自成类），而出口 `pickMessage` 是**通用读 `err.en`** 的——只盯一类就等于
// 「新增一条没翻的 `AdminError` 也不报错」，闸不闸。⇒ 按类名以 `Error` 结尾统一扫。
const THROW_RE = /\bthrow\s+new\s+([A-Za-z0-9_]*Error)\s*\(/g;

// 中文字符（含 CJK 扩展 A 与中文标点）。只算**字符串字面量里**的中文：注释里的中文不是下发文案，
// 拼串里只拼变量的消息不是静态可翻面。
const CJK_RE = /[㐀-䶿一-鿿　-〿＀-￯]/;

/** 一条抛出语句里是否带中文字符串字面量（跳过注释；字符串逐个取内容试）。 */
function hasCjkStringLiteral(text, from, to) {
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { i = skipLineComment(text, i); continue; }
    if (c === '/' && text[i + 1] === '*') { i = skipBlockComment(text, i); continue; }
    if (c === '"' || c === "'" || c === '`') {
      const j = skipString(text, i);
      if (CJK_RE.test(text.slice(i, j))) return true;
      i = j;
      continue;
    }
    i += 1;
  }
  return false;
}

// 未双语地板（见文件头）：**双向记账**的基准——实测必须**恰好等于**它，高了低了都红。
// 降覆盖后把它改成新的更小实测值；新增未翻的抛出点则反过来把它改回去（那是要有人负责的回归）。
// 当前值 406：S1 收口实测 407，#803 返修 m6 给 `http.js` 的 Content-Type 那处补上了可用的 `en:`
// ⇒ 降 1（`HttpError` 那一档 82 → 81）。取新数：`node scripts/check-message-i18n.mjs --count`。
const UNBILINGUAL_FLOOR = 406;

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

/**
 * 抛出调用的实参表里是否有**真能用**的英文项（#803 返修 M3，取代原来的词面 `\ben\s*:` 判据）。
 * 三个条件缺一不可，每一条都对应一种「记了账、但英文其实一句也没下发」：
 *   · `en` 是**真实标识符**：左邻不是标识符字符（`token:` / `hidden:` 不误判），且不在字符串/注释里；
 *   · 值是**非空**字符串字面量：`en: ''` 在出口 `pickMessage` 里回退中文（等于没翻），
 *     `en: someVar` 静态面判不了非空 ⇒ 两种都不算已双语；
 *   · **brace 深度 ≤ 1**：`new X(msg, { en: '…' })` 算（出口读的就是顶层 `err.en`）；
 *     `details: { en: '…' }` 在深度 2 —— 它只会进 `err.details`，永远不会设 `err.en` ⇒ 不算。
 * `from`/`to` 传抛出调用那对圆括号（`matchingClose` 的结果），深度以实参表内为 0 起算。
 */
function hasUsableEnLiteral(text, from, to) {
  let depth = 0;
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(text, i); continue; }
    if (c === '/' && text[i + 1] === '/') { i = skipLineComment(text, i); continue; }
    if (c === '/' && text[i + 1] === '*') { i = skipBlockComment(text, i); continue; }
    if (c === '{') { depth += 1; i += 1; continue; }
    if (c === '}') { depth -= 1; i += 1; continue; }
    const leftOk = i === from || !/[\w$]/.test(text[i - 1]);
    if (depth <= 1 && leftOk && text.startsWith('en', i)) {
      let j = i + 2;
      while (j < to && /\s/.test(text[j])) j += 1;
      if (text[j] === ':') {
        j += 1;
        while (j < to && /\s/.test(text[j])) j += 1;
        const q = text[j];
        if (q === '"' || q === "'" || q === '`') {
          const body = text.slice(j + 1, Math.min(skipString(text, j) - 1, to));
          if (body.trim() !== '') return true;
        }
      }
    }
    i += 1;
  }
  return false;
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
    THROW_RE.lastIndex = 0;
    let m;
    while ((m = THROW_RE.exec(text)) !== null) {
      const hit = m.index;
      const openParen = m.index + m[0].length - 1;
      const close = matchingClose(text, openParen);
      const lineEnd = text.indexOf('\n', close);
      const sliceEnd = lineEnd === -1 ? text.length : lineEnd;
      const raw = text.slice(hit, sliceEnd); // 含语句与其尾随注释
      // 账本只收「硬编码中文消息」的抛出点：消息是拼变量 / 透传上游文案的，静态面没得翻。
      if (!hasCjkStringLiteral(text, openParen, close)) continue;
      if (hasUsableEnLiteral(text, openParen, close)) { bilingual += 1; continue; }
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

  // ① floor：**双向记账**（#803 返修 M2）——实测必须恰好等于地板，高了低了都红。
  if (m.unbilingual > UNBILINGUAL_FLOOR) {
    reds += 1;
    say(`RED  [floor] unbilingual: 未双语抛出点 ${m.unbilingual} > UNBILINGUAL_FLOOR ${UNBILINGUAL_FLOOR}（回归：多了一处没翻的抛出点）`);
    say(`      ↳ 样例：${m.firstUnbilingual.join(' / ')}`);
    say('      ↳ 补**能用**的 `en:`（非空字符串字面量、与 `details` 同层、不是嵌在 details 里的）');
    say('        或标 `// i18n-exempt: <具体理由>（#803）`。');
  } else if (m.unbilingual < UNBILINGUAL_FLOOR) {
    reds += 1;
    say(`RED  [floor] unbilingual: 未双语抛出点 ${m.unbilingual} < UNBILINGUAL_FLOOR ${UNBILINGUAL_FLOOR}（覆盖涨了，却没记账）`);
    say(`      ↳ 把本文件的 UNBILINGUAL_FLOOR 改成实测值 ${m.unbilingual}——不记账等于没记账：`);
    say('        上界留着虚高，之后新增一处没翻的抛出点照样绿，这一批覆盖提升就白记了（见文件头）。');
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
    say(`VERDICT ok（未双语 ${m.unbilingual} = 地板 ${UNBILINGUAL_FLOOR}，双向记账已对齐；已双语 ${m.bilingual}、豁免 ${m.exempt}；parity 全绿）`);
    return 0;
  }
  say(`VERDICT red（${reds} 条）`);
  return 1;
}

// `main()` 是 async（parity 要动态 import 真模块）：ESM 顶层 await 取回退出码后再 `process.exit`。
process.exit(await main());
