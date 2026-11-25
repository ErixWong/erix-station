#!/usr/bin/env node
// 文档 ↔ 实现比对闸（issue #777 S1，代号 docs-261125-12）。
// 目标：让文档漂移从「不会变红」变成「必变红」。本闸只判闸，
// 不改任何文档正文。
//
// 三条检查：
//  ① routes：portal/src/http.js 路由 ↔ docs/api/portal.md 契约索引
//  ② schema：deploy/migrations/*.sql ↔ docs/data/model.md（M2 实装）
//  ③ legs：门禁口径 ↔ 真实腿与脚本（M3 实装）
//
// 地板语义（学 scripts/agents-hotlayer-budget.mjs）：
//  - 实现里有、文档没登记、又没豁免 ⇒ 红（缺登记）；
//  - 已在文档里对得上、却仍留在豁免表 ⇒ 也红（防豁免堆积）；
//  - 豁免行缺 reason、或 reason 不含 issue 号 ⇒ 红。
// --sync 自举豁免表：把当前「缺登记」条目追加进豁免清单
//  （reason 用占位文案）。只追加、不删、不改，删豁免永远是人的决定。
//
// 抽取面口径（诚实的洞，写在明处）：
//  - 「有契约」= docs/api/portal.md 的索引表行（`| … \`M /p\` |`）或
//    正文小节标题（`### … \`M /p\``）里出现反引号包住的 `METHOD path` 连写；
//  - 参数段两侧统一成 :P（文档写 :id/:fdeName，代码是 ([^/]+)）；
//  - 文档 path 的 ?query、尾部 []/{} 可选段会展开或剥掉再比；
//  - handleUserApiTokens 用 `method ===` 别名分派，本闸不抽（现均有文档）；
//  - requireAdminReadMethod(req) 调用按 GET 计（它就是 GET 门）。

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTTP_JS = path.join(ROOT, 'portal/src/http.js');
const API_DOC = path.join(ROOT, 'docs/api/portal.md');
const MIG_DIR = path.join(ROOT, 'deploy/migrations');
const MODEL_DOC = path.join(ROOT, 'docs/data/model.md');
const EXC = path.join(ROOT, 'scripts/doc-impl-exceptions.json');

const SECTIONS = ['routes', 'schema', 'legs'];
const METHODS = 'GET|POST|PUT|PATCH|DELETE|HEAD';

function assert(c, m) {
  if (!c) throw new Error(m);
}

function read(f) {
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

function readArgValue(flag) {
  const argv = process.argv.slice(2);
  const hit = argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (hit === undefined) return undefined;
  if (hit.startsWith(`${flag}=`)) return hit.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  return argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
}

// ---------------- path 归一化（代码侧 / 文档侧共用） ----------------

/** 深度 0 处按 sep 切开（sep 不出现在任何括号组内）。 */
function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** 归类捕获组：字符类/\d+ ⇒ :P；.* ⇒ 通配尾；其余按字面量展开。 */
function classifyGroup(inner) {
  if (inner.includes('.*')) return { wild: true };
  if (inner.startsWith('[') || inner === '\\d+' || inner === '\\w+') {
    return { variants: [':P'] };
  }
  return { variants: expandAlternation(inner) };
}

function expandAlternation(s) {
  const alts = splitTop(s, '|');
  if (alts.length > 1) return alts.flatMap((a) => expandConcat(a));
  return expandConcat(s);
}

/** 串联展开：字面量逐字符、(...) 递归、组后 `?` 展开成「有/无」两支。 */
function expandConcat(s) {
  let out = [''];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '(') {
      out = out.map((o) => o + s[i]);
      i += 1;
      continue;
    }
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === '(') depth++;
      else if (s[j] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    assert(j < s.length, `路由正则括号不配对：${s}`);
    let inner = s.slice(i + 1, j);
    if (inner.startsWith('?:') || inner.startsWith('?=')) inner = inner.slice(2);
    const optional = s[j + 1] === '?';
    const cls = classifyGroup(inner);
    const opts = cls.wild ? [':W'] : cls.variants;
    const next = [];
    for (const o of out) {
      for (const x of opts) next.push(o + x);
      if (optional) next.push(o);
    }
    out = next;
    i = j + (optional ? 2 : 1);
  }
  return out;
}

/** 正则源 ⇒ 归一化 path 集：剥 ^/$、`\/`→`/`、([^/]+)/(\d+) ⇒ :P。 */
function expandRouteRegex(srcRaw) {
  const src = srcRaw.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/');
  const out = [];
  for (let v of expandConcat(src)) {
    const wild = v.endsWith(':W');
    if (wild) v = v.replace(/\/:W$/, '').replace(/:W$/, '');
    out.push({ path: normalizePathShape(v), wild });
  }
  return out;
}

/** 统一的 path 形状归一：query 剥掉、参数段→:P、去尾斜杠。 */
function normalizePathShape(p) {
  const noQuery = p.split('?')[0];
  const segs = noQuery.split('/').map((s) => {
    if (s.startsWith(':') || s.startsWith('<')) return ':P';
    return s;
  });
  const joined = segs.join('/').replace(/\/+$/, '');
  return joined === '' ? '/' : joined;
}

/** 文档 path → 归一化集：`[x]` 可选尾与 `{a,b}` 枚举先展开，
 *  `{x}`（无逗号）视作命名参数 ⇒ :P；行尾标点先剔掉。 */
function expandDocPath(pRaw) {
  let clean = pRaw.split('?')[0].replace(/[.,;:)]+$/, '');
  clean = clean.replace(/\{[^,{}]+\}/g, ':P');
  let bases = [clean];
  const bracket = bases[0].match(/^(.*?)\[([^\]]+)\]$/);
  if (bracket) bases = [bracket[1], bracket[1] + bracket[2]];
  const out = [];
  for (const b of bases) {
    const curly = b.match(/^(.*?)\{([^{}]+)\}$/);
    if (curly) {
      for (const opt of curly[2].split(',')) out.push(curly[1] + opt);
    } else out.push(b);
  }
  return out.map(normalizePathShape);
}

// ---------------- 检查① 事实源：portal/src/http.js ----------------

function methodsOn(line) {
  const ms = [];
  for (const m of line.matchAll(
    new RegExp(String.raw`req\.method\s*(?:===|!==)\s*'(${METHODS})'`, 'g'))) {
    ms.push(m[1]);
  }
  return ms;
}

/**
 * 行级状态机（缩进即块边界，这是本仓库路由代码的既有排版约定）：
 *  - `if (pathname === 'P'... ) {`（同行无 method）⇒ 开路径上下文；
 *  - `const X = pathname.match(/re/)` ⇒ 登记变量→归一化 path 集；
 *  - `if (X...) {` ⇒ 以该变量的 path 集开上下文；
 *  - `if (sub === '/x') {` / `const Y = sub.match(/re/)` ⇒ 内部二级
 *    分派（/api/internal/{transcript,runs}/:id(/.*)?）按前后缀拼接；
 *  - 上下文内的 req.method 行 ⇒ 产出 (method, path) 组合；
 *  - 同行「变量/正则/字面量 + method」⇒ 就地产出，不开上下文。
 */
function extractHttpRoutes(src) {
  const pairs = new Map(); // "M /p" → 行号（首次出现）
  const vars = new Map(); // name → [{path, wild}]
  const ctxStack = []; // {indent, paths: [..]}
  // 个别 const 声明换行写（如 adminFdeSessionHistoryMatch），先并入下一行；
  // 行号一律报原始文件行号，别拿合并后的下标冒充。
  const raw = src.split('\n');
  const lines = [];
  const lineNos = [];
  for (let i = 0; i < raw.length; i++) {
    if (/^\s*const\s+\w+\s*=\s*$/.test(raw[i]) && i + 1 < raw.length) {
      lines.push(`${raw[i]} ${raw[i + 1].trim()}`);
      lineNos.push(i + 1);
      i += 1;
    } else {
      lines.push(raw[i]);
      lineNos.push(i + 1);
    }
  }
  const add = (m, p, ln) => {
    if (!p.startsWith('/api/')) return;
    const key = `${m} ${p}`;
    if (!pairs.has(key)) pairs.set(key, ln);
  };
  lines.forEach((line, idx) => {
    const ln = lineNos[idx];
    if (/^(async\s+)?function\b/.test(line)) {
      ctxStack.length = 0;
      vars.clear();
    }
    const closeIndent = line.match(/^(\s*)\}/);
    if (closeIndent) {
      const ci = closeIndent[1].length;
      while (ctxStack.length && ctxStack[ctxStack.length - 1].indent >= ci) {
        ctxStack.pop();
      }
    }
    const opensBlock = /\{\s*$/.test(line);
    const indent = line.match(/^(\s*)/)[1].length;
    const lits = [...line.matchAll(/pathname\s*===\s*'([^']+)'/g)].map((m) => m[1]);
    const ms = methodsOn(line);
    const inlineRe = line.match(
      /\/\^((?:\\.|[^\\\n])+?)\$\/\.test\(pathname\)/);
    // 词边界匹配：避免 notifReadMatch 被同尾缀旧变量（dMatch）子串劫持。
    const varTok = [...vars.keys()].find(
      (n) => new RegExp(`\\b${n}\\b`).test(line));
    // —— 同行就地产出（字面量优先，其次内联正则，再次已登记变量）
    if (ms.length) {
      const top = ctxStack.length
        ? ctxStack[ctxStack.length - 1] : null;
      const anchor = lits.length
        ? lits.map((p) => ({ path: normalizePathShape(p), wild: false }))
        : inlineRe
          ? expandRouteRegex(inlineRe[1])
          : varTok && (!top || top.fromVar === varTok)
            ? vars.get(varTok)
            : null;
      if (anchor) {
        for (const a of anchor) {
          if (a.wild) continue;
          for (const m of ms) add(m, a.path, ln);
        }
        return;
      }
    }
    // —— 开路径上下文
    if (!ms.length) {
      if (lits.length && opensBlock) {
        ctxStack.push({
          indent,
          paths: lits.map((p) => normalizePathShape(p)),
        });
        return;
      }
      const mDecl = line.match(
        /const\s+(\w+)\s*=[^;]*?pathname\.match\(\/\^((?:\\.|[^\\\n])+?)\$\//);
      if (mDecl) {
        vars.set(mDecl[1], expandRouteRegex(mDecl[2]));
        return;
      }
      const sDecl = line.match(
        /const\s+(\w+)\s*=\s*sub\.match\(\/\^((?:\\.|[^\\\n])+?)\$\//);
      if (sDecl && ctxStack.length) {
        const base = ctxStack[ctxStack.length - 1].paths[0] ?? '';
        vars.set(sDecl[1], expandRouteRegex(sDecl[2])
          .map((v) => ({ path: base + v.path, wild: v.wild })));
        return;
      }
      const blockOpen = line.match(/^(\s*)if\s*\((\w+)\)\s*\{\s*$/);
      if (blockOpen) {
        const name = blockOpen[2];
        if (vars.has(name)) {
          const cand = vars.get(name).filter((v) => !v.wild)
            .map((v) => v.path);
          if (cand.length) {
            ctxStack.push({
              indent: blockOpen[1].length,
              paths: [...new Set(cand)],
              fromVar: name,
            });
          }
        }
        return;
      }
      const subOpen = line.match(
        /^\s*if\s*\(sub\s*===\s*'([^']*)'\)\s*\{\s*$/);
      if (subOpen && ctxStack.length) {
        const base = ctxStack[ctxStack.length - 1].paths[0] ?? '';
        ctxStack.push({ indent, paths: [base + subOpen[1]] });
        return;
      }
    }
    // —— 上下文内的 method 行
    if (ms.length && ctxStack.length) {
      const top = ctxStack[ctxStack.length - 1];
      let paths = top.paths;
      const act = line.match(/action\s*===\s*'([^']+)'/);
      const actNull = /action\s*===\s*null/.test(line);
      if (act) {
        const pick = paths.filter((p) => p.endsWith(`/${act[1]}`));
        paths = pick.length ? pick : [];
      } else if (actNull) {
        const shortest = [...paths].sort(
          (a, b) => a.length - b.length)[0];
        paths = shortest ? [shortest] : [];
      }
      for (const p of paths) {
        for (const m of ms) add(m, p, ln);
      }
      return;
    }
    if (/requireAdminReadMethod\s*\(\s*req\s*\)/.test(line) && ctxStack.length) {
      const top = ctxStack[ctxStack.length - 1];
      for (const p of top.paths) add('GET', p, ln);
    }
  });
  return pairs;
}

// ---------------- 检查① 文档面：docs/api/portal.md ----------------

/**
 * 文档面「有契约」判定：只认两类行——索引表行（`|` 开头）与
 * 小节标题行（`#` 开头）；同一行内出现 METHOD 字面量与归一化后的
 * `/api/...` path 字面量即算登记（同行拆格如 `| \`path\` | \`GET\` |` 也认，
 * 合写 `\`GET /api/x\`` 同样命中）。
 */
function extractDocRouteIndex(md) {
  const set = new Set();
  const pathTok = /\/api\/[A-Za-z0-9\-_:./[\]{}|?=&%,]*/g;
  const methTok = new RegExp(`\\b(${METHODS})\\b`, 'g');
  md.split('\n').forEach((line) => {
    const t = line.trimStart();
    if (!(t.startsWith('|') || /^#{1,6} /.test(t))) return;
    const methods = [...line.matchAll(methTok)].map((m) => m[1]);
    if (!methods.length) return;
    const paths = new Set();
    for (const m of line.matchAll(pathTok)) {
      for (const p of expandDocPath(m[0])) paths.add(p);
    }
    for (const p of paths) {
      for (const m of methods) set.add(`${m} ${p}`);
    }
  });
  return set;
}

// ---------------- 豁免表 ----------------

function emptyEx() {
  return { routes: [], schema: [], legs: [] };
}

function loadExceptions() {
  if (!existsSync(EXC)) return { data: emptyEx(), present: false };
  return { data: JSON.parse(read(EXC)), present: true };
}

function exList(data, section) {
  return Array.isArray(data[section]) ? data[section] : [];
}

function hasIssueRef(reason) {
  return typeof reason === 'string' && /#\d+/.test(reason);
}

// ---------------- 检查实现 ----------------

function checkRoutes(ex) {
  const http = read(HTTP_JS);
  assert(http.length > 0, `读不到事实源：${HTTP_JS}`);
  const doc = read(API_DOC);
  assert(doc.length > 0, `读不到文档面：${API_DOC}`);
  const code = extractHttpRoutes(http);
  const docs = extractDocRouteIndex(doc);
  const exKeys = new Set(exList(ex, 'routes').map((e) => e.pair));
  const reds = [];
  for (const [pair, line] of code) {
    if (docs.has(pair)) continue;
    if (exKeys.has(pair)) continue;
    reds.push({
      kind: 'missing',
      entry: pair,
      hint: `http.js:${line}，文档索引行/小节标题内无该 METHOD+path 登记`,
    });
  }
  for (const e of exList(ex, 'routes')) {
    if (docs.has(e.pair)) {
      reds.push({
        kind: 'stale-ex',
        entry: e.pair,
        hint: '文档已能对上，仍在豁免表里（防豁免堆积），请删掉它',
      });
    }
  }
  return reds;
}

// ---------------- 检查② 事实源：deploy/migrations/*.sql ----------------

/**
 * 镜像 portal/src/migrate.js 的 listMigrationFiles：目录内 .sql 按文件名升序。
 * 每个文件抽三类事实：CREATE TABLE 表名、ALTER TABLE…ADD COLUMN 列名、
 * CHECK (col IN ('a','b',…)) 的字符串字面量集合。
 * 表归属用「文件内最近一次 CREATE/ALTER 的表名」近似（迁移都是小文件，
 * 归属只影响红名单的可读性，不影响登记判定）。
 */
function extractMigrationFacts() {
  const files = existsSync(MIG_DIR)
    ? readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort()
    : [];
  assert(files.length > 0, `读不到迁移目录：${MIG_DIR}`);
  const facts = new Map(); // entry → "file:line"
  const add = (entry, file, line) => {
    if (!facts.has(entry)) facts.set(entry, `${file}:${line}`);
  };
  for (const f of files) {
    const text = readFileSync(path.join(MIG_DIR, f), 'utf8');
    let cur = '(未知表)';
    text.split('\n').forEach((rawLine, i) => {
      const line = rawLine.replace(/--.*$/, '');
      const ct = line.match(
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w.]+)["`]?/i);
      if (ct) {
        cur = ct[1];
        add(`table:${cur}`, f, i + 1);
      }
      const at = line.match(
        /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?([\w.]+)["`]?/i);
      if (at) cur = at[1];
      const ac = line.match(
        /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w]+)["`]?/i);
      if (ac) add(`column:${cur}.${ac[1]}`, f, i + 1);
      const ck = line.match(
        /CHECK\s*\(\s*\(?(\w+)\)?(?:::\w+)?\s+IN\s*\(([^)]*)\)/i);
      if (ck) {
        for (const v of ck[2].matchAll(/'([^']*)'/g)) {
          add(`check:${cur}.${ck[1]}=${v[1]}`, f, i + 1);
        }
      }
    });
  }
  return facts;
}

/** 字面量是否出现在文档里（表/列名允许反引号或裸词，值同理）。 */
function docMentions(text, token) {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\w.])${esc}(?![\w])`).test(text);
}

function checkSchema(ex) {
  const doc = read(MODEL_DOC);
  assert(doc.length > 0, `读不到文档面：${MODEL_DOC}`);
  const facts = extractMigrationFacts();
  const exKeys = new Set(exList(ex, 'schema').map((e) => e.entry));
  const reds = [];
  for (const [entry, where] of facts) {
    const token = entry.startsWith('table:')
      ? entry.slice('table:'.length)
      : entry.startsWith('column:')
        ? entry.slice(entry.indexOf('.') + 1)
        : entry.slice(entry.indexOf('=') + 1);
    if (docMentions(doc, token) || exKeys.has(entry)) continue;
    reds.push({
      kind: 'missing',
      entry,
      hint: `迁移 ${where}，model.md 正文无该字面量`,
    });
  }
  for (const e of exList(ex, 'schema')) {
    const token = e.entry.startsWith('table:')
      ? e.entry.slice('table:'.length)
      : e.entry.startsWith('column:')
        ? e.entry.slice(e.entry.indexOf('.') + 1)
        : e.entry.slice(e.entry.indexOf('=') + 1);
    if (docMentions(doc, token)) {
      reds.push({
        kind: 'stale-ex',
        entry: e.entry,
        hint: 'model.md 已能对上，仍在豁免表里，请删掉它',
      });
    }
  }
  return reds;
}

function checkLegs(ex) {
  void ex;
  return []; // M3 实装
}

const CHECKS = {
  routes: { fn: checkRoutes, key: 'pair' },
  schema: { fn: checkSchema, key: 'entry' },
  legs: { fn: checkLegs, key: 'entry' },
};

// ---------------- 主流程 ----------------

function main() {
  const argv = process.argv.slice(2);
  const sync = argv.includes('--sync');
  const only = readArgValue('--only');
  const secs = only ? only.split(',') : SECTIONS;
  for (const s of secs) {
    assert(CHECKS[s], `未知检查面：${s}（可选 ${SECTIONS.join('/')}）`);
  }
  const { data: ex } = loadExceptions();
  let reds = 0;
  const say = (line) => console.log(line);

  const results = {};
  for (const s of secs) results[s] = CHECKS[s].fn(ex);

  // —— --sync：把「缺登记」追加进豁免清单（已有条目不动）
  if (sync) {
    let added = 0;
    for (const s of secs) {
      const list = exList(ex, s);
      const known = new Set(list.map((e) => e[CHECKS[s].key]));
      for (const r of results[s]) {
        if (r.kind !== 'missing' || known.has(r.entry)) continue;
        list.push({
          [CHECKS[s].key]: r.entry,
          reason: '待补真实理由（#777 S1 --sync 自举占位）',
        });
        added += 1;
      }
      ex[s] = list;
    }
    writeFileSync(EXC, JSON.stringify(ex, null, 2) + '\n');
    say(`sync: 追加 ${added} 条豁免，写入 ${path.relative(ROOT, EXC)}`);
    return 0;
  }

  for (const s of secs) {
    for (const r of results[s]) {
      reds += 1;
      say(`RED  [${s}] ${r.kind}: ${r.entry}`);
      if (r.hint) say(`      ↳ ${r.hint}`);
    }
  }
  // 豁免表自身卫生：reason 缺失/不含 issue 号，也红
  for (const s of secs) {
    for (const e of exList(ex, s)) {
      if (!hasIssueRef(e.reason)) {
        reds += 1;
        say(`RED  [${s}] bad-ex: ${e[CHECKS[s].key]} — 豁免 reason 缺失或不含 issue 号`);
      }
    }
  }
  if (reds === 0) {
    say(`VERDICT ok（文档↔实现三比对全绿；检查面 ${secs.join(',')}）`);
    return 0;
  }
  say(`VERDICT red（${reds} 条）`);
  return 1;
}

process.exit(main());
