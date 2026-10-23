// 单测：issue #256 交付①——号池**占用总览**读端点 `GET /api/admin/preview-ports/usage`。
//
// 工单第「新增测试必须覆盖」5 条：
//   ① `released` 行**不占位**（一段内只有一条 released ⇒ 该段仍进 `free_blocks`）
//   ② `partial` / `occupied` 分类正确，且一段里**两个 FDE** 时 `fde_names` 给出两个名字
//   ③ 端点实现里**零端口字面量**（源码级断言：新函数体 + HTTP handler 里都不含端口/块几何字面量；
//      断言按**数值**判定，`22_000` / `0x5618` 这类等价写法同样被拦，见 `numericLiterals()`）
//   ④ 非 admin ⇒ 403 且**不写审计**；admin ⇒ **恰好一行**审计且 `details` 不含整份响应体
//   ⑤ `has_more` 与 `limit` 语义（空闲段多于 limit ⇒ `has_more=true` 且 `items.length == limit`）
//
// 隔离约定（docs/testing.md §2.1）：内存 fake，不碰真库 / docker。fake 只按真 SQL 的**谓词**派发
// （`state <> 'released'` + `port BETWEEN $1 AND $2` + LEFT JOIN users 取 fde_name），
// 这样「released 不占位」这条断言测的是实现真的发出去的 SQL，而不是测试自己写的过滤条件。
// ⚠ 谓词是**解析后按行求值**的（`compileWhere()`），不是子串前缀匹配——见那段注释（#256 评审 B1）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { FakePool } from './fake-pool.js';
import {
  PREVIEW_PORT_BLOCK_COUNT,
  PREVIEW_PORT_COUNT,
  PREVIEW_PORT_POOL_END,
  PREVIEW_PORT_POOL_START,
  PREVIEW_USAGE_FREE_LIMIT_DEFAULT,
  previewPortPoolUsage,
} from '../src/portalloc.js';

const BASE = 'fde.erix.vip';
const PUBLIC_BASE = 'http://station.fde.erix.vip:8090';
const LOG = { log() {}, warn() {}, error() {} };
const SRC_DIR = path.dirname(fileURLToPath(new URL('../src/portalloc.js', import.meta.url)));

/** 第 n 段（n=0 ⇒ 池起点那一段）的起点。测试里**不用**端口字面量，避免自己变成第二套真相源。 */
function blockStart(nth) {
  return PREVIEW_PORT_POOL_START + nth * PREVIEW_PORT_COUNT;
}

/** 段内第 i 个端口。 */
function portIn(nth, i = 0) {
  return blockStart(nth) + i;
}

// ---------------------------------------------------------------------------
// fake：port_allocations（+ users 的 fde_name 用于 LEFT JOIN）
// ---------------------------------------------------------------------------

/** 把括号外层的多余括号剥掉（`(a OR b)` → `a OR b`；不剥 `(a) AND (b)` 里的内层）。 */
function stripOuterParens(expr) {
  let e = expr.trim();
  for (;;) {
    if (!e.startsWith('(') || !e.endsWith(')')) return e;
    let depth = 0;
    let wrapsAll = true;
    for (let i = 0; i < e.length; i++) {
      if (e[i] === '(') depth++;
      else if (e[i] === ')') {
        depth--;
        if (depth === 0 && i !== e.length - 1) { wrapsAll = false; break; }
      }
    }
    if (!wrapsAll) return e;
    e = e.slice(1, -1).trim();
  }
}

/** 在括号深度 0、引号外按 `op`（`AND` / `OR`）切分；`BETWEEN $n AND $m` 里的 `AND` 不算分隔符。 */
function splitTopLevel(expr, op) {
  const out = [];
  let depth = 0;
  let quoted = false;
  let last = 0;
  const upper = expr.toUpperCase();
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "'") quoted = !quoted;
    if (quoted) continue;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth !== 0 || upper.startsWith(op, i) === false) continue;
    const before = i === 0 ? ' ' : expr[i - 1];
    const after = expr[i + op.length] ?? ' ';
    if (/\w/.test(before) || /\w/.test(after)) continue;   // 词边界：`BRAND` / `ORDER` 不算
    const head = expr.slice(last, i);
    if (op === 'AND' && /BETWEEN\s+\$\d+\s*$/i.test(head)) continue;   // `BETWEEN $1 AND $2` 是一个原子
    out.push(head);
    last = i + op.length;
    i += op.length - 1;
  }
  out.push(expr.slice(last));
  return out.map((part) => part.trim());
}

/**
 * 把 `WHERE` 子句编译成「按行求值」的谓词函数 `(row, params) => boolean`（#256 评审 B1）。
 *
 * 为什么不能只做子串匹配：`/WHERE pa\.state <> 'released' AND/` 这种**前缀包含**判定下，把实现谓词放宽成
 * `WHERE (pa.state <> 'released' OR pa.state = 'released') AND …`（语义永真）时，fake 仍会命中「已过滤」分支
 * ⇒ 测试绿而实现错（假绿窗口）。这里按 SQL 的真实语义求值：**解析不了的形态直接抛错**，
 * fake 不许替实现兜底（AGENTS §8.14 的先例：`preview-grant-checks.js` 从 SQL 文本解析谓词、
 * `fake-internal-pool.js` 按 SQL 文本真筛）。
 *
 * 支持（本端点真实用到的形态）：`pa.state <>|= 'x'`、`pa.state IN (…)`、`pa.port BETWEEN $n AND $m`、
 * `pa.port <|<=|>|>=|= $n`、括号、`AND` / `OR`（`OR` 优先级低于 `AND`，与 SQL 一致）。
 */
function compileWhere(expr) {
  const e = stripOuterParens(expr);
  let m;

  // 原子子句（先于 AND 切分：`BETWEEN … AND …` 才不会被切坏）
  if ((m = e.match(/^(?:pa\.)?state\s*(<>|!=|=)\s*'([^']*)'$/i))) {
    const negated = m[1] !== '=';
    const wanted = m[2];
    return (row) => (row.state === wanted) !== negated;
  }
  if ((m = e.match(/^(?:pa\.)?state\s+IN\s*\(([^)]*)\)$/i))) {
    const list = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    return (row) => list.includes(row.state);
  }
  if ((m = e.match(/^(?:pa\.)?port\s+BETWEEN\s+\$(\d+)\s+AND\s+\$(\d+)$/i))) {
    const [, a, b] = m.map(Number);
    return (row, params) => Number(row.port) >= Number(params[a - 1]) && Number(row.port) <= Number(params[b - 1]);
  }
  if ((m = e.match(/^(?:pa\.)?port\s*(<=|>=|<|>|=)\s*\$(\d+)$/i))) {
    const opText = m[1];
    const idx = Number(m[2]) - 1;
    const cmp = {
      '<=': (x, y) => x <= y, '>=': (x, y) => x >= y,
      '<': (x, y) => x < y, '>': (x, y) => x > y, '=': (x, y) => x === y,
    }[opText];
    return (row, params) => cmp(Number(row.port), Number(params[idx]));
  }

  const ors = splitTopLevel(e, 'OR');
  if (ors.length > 1) {
    const fns = ors.map(compileWhere);
    return (row, params) => fns.some((fn) => fn(row, params));
  }
  const ands = splitTopLevel(e, 'AND');
  if (ands.length > 1) {
    const fns = ands.map(compileWhere);
    return (row, params) => fns.every((fn) => fn(row, params));
  }

  throw new Error(`fake 解析不了这个 WHERE 原子子句：「${e}」——请让 fake 跟上 SQL（或让实现回到已支持形态），`
    + '不要为了让测试变绿去放宽 fake（AGENTS §8.14）');
}

/** 从 SQL 文本里取 `WHERE` 子句（到 `ORDER BY` / `GROUP BY` / 结尾为止）；没有 WHERE ⇒ `null`。 */
function extractWhere(sql) {
  const m = sql.match(/\bWHERE\b([\s\S]*?)(?:\bORDER\s+BY\b|\bGROUP\s+BY\b|\bLIMIT\b|$)/i);
  return m ? m[1].trim() : null;
}

class UsageStore {
  /**
   * @param {{rows?: Array<{fde_id, port, state}>, users?: Array<{id, fde_name}>}} [seed]
   */
  constructor({ rows = [], users = [] } = {}) {
    this.rows = rows.map((row, i) => ({ id: `pa-${i + 1}`, state: 'allocated', ...row }));
    this.users = users;
    this.seq = [];
    this.writes = [];
    /** 每次总览取数看到的 `WHERE` 原文（断言「实现真的发了谓词」用）。 */
    this.whereSeen = [];
  }

  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.seq.push(s.split(' ').slice(0, 3).join(' '));

    // 总览取数：谓词由 SQL 决定（fake 不另写一套），LEFT JOIN users 取 fde_name。
    if (s.startsWith('SELECT pa.port AS port, u.fde_name AS fde_name')) {
      // **谓词由 SQL 决定**（fake 不另写一套，也不是子串匹配）：实现把 `state <> 'released'` 去掉/放宽时，
      // 编译出来的谓词就真的变了 ⇒「released 不占位」那条断言会红（本文件最重要一条判据的诚实性来源）。
      const where = extractWhere(s);
      this.whereSeen.push(where);
      const predicate = where === null ? () => true : compileWhere(where);
      const rows = this.rows
        .filter((row) => predicate(row, params))
        .sort((a, b) => a.port - b.port)
        .map((row) => ({
          port: row.port,
          fde_name: this.users.find((u) => u.id === row.fde_id)?.fde_name ?? null,
        }));
      return { rows, rowCount: rows.length };
    }

    // 审计行（`INSERT INTO audit_log`）交给 FakePool 记进 `pool.audit`，本 fake 不算作端口域写。
    if (s.startsWith('INSERT INTO audit_log')) return null;
    if (/^(INSERT|UPDATE|DELETE) /.test(s)) {
      this.writes.push(s);
      return { rows: [], rowCount: 0 };
    }
    return null;
  }

  pool() {
    return { query: (sql, params) => this.query(sql, params) };
  }
}

// ---------------------------------------------------------------------------
// ① released 不占位
// ---------------------------------------------------------------------------
test('#256① released 行不占位：只有一条 released 的段仍进 free_blocks；10 行里 1 条 released 的段算 partial(9)', async () => {
  const store = new UsageStore({
    users: [{ id: 'u-alice', fde_name: 'alice' }],
    rows: [
      // 第 0 段：唯一一条行是 released（历史行）⇒ 号码可回收 ⇒ 该段整段空闲。
      { fde_id: 'u-alice', port: portIn(0, 0), state: 'released' },
      // 第 1 段：10 条行，其中 1 条 released ⇒ 活行 9 条 ⇒ partial，且**不是** occupied。
      ...Array.from({ length: PREVIEW_PORT_COUNT }, (_, i) => ({
        fde_id: 'u-alice', port: portIn(1, i), state: i === 0 ? 'released' : 'allocated',
      })),
    ],
  });

  const usage = await previewPortPoolUsage(store.pool());

  assert.equal(usage.free_blocks.items[0], blockStart(0), 'released 不占位 ⇒ 第 0 段必须是第一个空闲段');
  assert.deepEqual(usage.occupied_blocks.map((b) => b.start), [blockStart(1)], '第 0 段不进 occupied_blocks');
  assert.equal(usage.occupied_blocks[0].occupied_count, PREVIEW_PORT_COUNT - 1, 'released 那条不计入 occupied_count');
  assert.equal(usage.summary.partial, 1);
  assert.equal(usage.summary.occupied, 0, 'released 的那一条不得把该段算成占满');
  assert.equal(usage.summary.free, PREVIEW_PORT_BLOCK_COUNT - 1);
  assert.equal(usage.summary.total_blocks, PREVIEW_PORT_BLOCK_COUNT);
  assert.equal(
    usage.summary.free + usage.summary.partial + usage.summary.occupied,
    PREVIEW_PORT_BLOCK_COUNT,
    '三类之和必须等于段总数（口径自洽）',
  );
  assert.equal(store.writes.length, 0, '总览是只读端点：一条写语句都不发');
});

// ---------------------------------------------------------------------------
// ② partial / occupied 分类 + 一段里两个 FDE
// ---------------------------------------------------------------------------
test('#256② partial 与 occupied 分类正确；一段里两个 FDE ⇒ fde_names 给出两个名字（升序、去重）', async () => {
  const store = new UsageStore({
    users: [
      { id: 'u-alice', fde_name: 'alice' },
      { id: 'u-bob', fde_name: 'bob' },
      { id: 'u-carol', fde_name: 'carol' },
    ],
    rows: [
      // 第 0 段：占满 10 个（两个 FDE 混住：单端口覆盖造出的 mixed 形状）。
      ...Array.from({ length: PREVIEW_PORT_COUNT }, (_, i) => ({
        fde_id: i % 2 === 0 ? 'u-bob' : 'u-alice', port: portIn(0, i),
      })),
      // 第 2 段：3 个活行（含一个 FDE 的 2 个 + 另一个 FDE 的 1 个）。
      { fde_id: 'u-carol', port: portIn(2, 0) },
      { fde_id: 'u-carol', port: portIn(2, 1) },
      { fde_id: 'u-bob', port: portIn(2, 2) },
    ],
  });

  const usage = await previewPortPoolUsage(store.pool());

  assert.equal(usage.summary.occupied, 1, '第 0 段占满 ⇒ occupied=1');
  assert.equal(usage.summary.partial, 1, '第 2 段占 3 个 ⇒ partial=1');
  assert.deepEqual(usage.occupied_blocks.map((b) => b.start), [blockStart(0), blockStart(2)], '只列有活行的段、升序');

  const [full, part] = usage.occupied_blocks;
  assert.deepEqual(full.fde_names, ['alice', 'bob'], '一段两个 FDE ⇒ 两个名字都在（不能只给第一个）');
  assert.equal(full.occupied_count, PREVIEW_PORT_COUNT);
  assert.equal(full.end, blockStart(0) + PREVIEW_PORT_COUNT - 1, 'end 用块几何算，不写死 +9');
  assert.deepEqual(part.fde_names, ['bob', 'carol'], '按名字升序、去重（carol 两行只出现一次）');
  assert.equal(part.occupied_count, 3);

  // 段边界用**整块**判定：占 1 个的段也不进 free_blocks（与 firstFreePreviewBlockStart 一致）。
  assert.equal(usage.free_blocks.items.includes(blockStart(2)), false, '有活行的段不得出现在空闲段里');
  assert.equal(usage.free_blocks.items[0], blockStart(1));
});

// ---------------------------------------------------------------------------
// ③ 源码级断言：新函数体内零端口字面量（+ HTTP handler 不做池算术）
// ---------------------------------------------------------------------------

/**
 * 取一个具名函数 / 方法的**函数体原文**（先配对参数表的圆括号，再按花括号配对；不靠「下一个 export」猜边界）。
 * 注释与字符串/模板里的花括号不算；正则字面量不支持（本断言扫的两个函数里没有）。
 */
function functionBodyOf(source, signature) {
  const at = source.indexOf(signature);
  assert.ok(at >= 0, `源码里必须找得到 ${signature}（名字变了就同步改本断言）`);

  /** 从 `from` 处的开括号开始配对，返回配对闭括号的下标。 */
  const matchBracket = (from, openCh, closeCh) => {
    let depth = 0;
    let quote = null;
    for (let i = from; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (ch === '\\') { i += 1; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i); if (i < 0) break; continue; }
      if (ch === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i + 2); if (i < 0) break; i += 1; continue; }
      if (ch === openCh) depth += 1;
      else if (ch === closeCh) {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    throw new Error(`找不到 ${signature} 的配对 ${openCh}${closeCh}`);
  };

  const paramsOpen = source.indexOf('(', at);
  assert.ok(paramsOpen > 0, `${signature} 后面找不到参数表的 (`);
  const paramsClose = matchBracket(paramsOpen, '(', ')');
  const bodyOpen = source.indexOf('{', paramsClose);
  assert.ok(bodyOpen > 0, `${signature} 后面找不到函数体的 {`);
  const bodyClose = matchBracket(bodyOpen, '{', '}');
  return source.slice(bodyOpen + 1, bodyClose);
}

/**
 * 函数体里的**全部数字字面量**（连同它们的数值）。
 * ⚠ 按数值判定，不按字面文本：`22_000`（数字分隔符）= 22000、`0x5618` = 22040，
 * 两种都能绕过 `body.includes('22000')`（#256 评审实测的逃逸形态）。
 */
function numericLiterals(body) {
  const re = /(?<![\w$])(?:0[xX][0-9a-fA-F][0-9a-fA-F_]*|0[bB][01][01_]*|0[oO][0-7][0-7_]*|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)/g;
  return [...body.matchAll(re)].map((m) => ({ raw: m[0], value: Number(m[0].replace(/_/g, '')) }));
}

/** 禁止在源码里出现的**数值**：端口区间 + 块几何（块大小 / 段总数 / 块内偏移上界）。 */
const FORBIDDEN_NUMBERS = [
  { value: PREVIEW_PORT_POOL_START, label: `池起点 ${PREVIEW_PORT_POOL_START}` },
  { value: PREVIEW_PORT_POOL_END, label: `池终点 ${PREVIEW_PORT_POOL_END}` },
  { value: PREVIEW_PORT_COUNT, label: `块大小 ${PREVIEW_PORT_COUNT}` },
  { value: PREVIEW_PORT_BLOCK_COUNT, label: `段总数 ${PREVIEW_PORT_BLOCK_COUNT}` },
];

/** 扫一段源码里的数字字面量：池区间内的任何数 / 块几何数都不许出现（含 `22_000`、`0x5618`）。 */
function assertNoPortLiterals(body, where) {
  for (const { raw, value } of numericLiterals(body)) {
    assert.equal(Number.isFinite(value), true, `${where} 里的数字字面量 ${raw} 解析不出数值（断言自己不完整）`);
    const hit = FORBIDDEN_NUMBERS.find((b) => b.value === value);
    assert.equal(hit, undefined, `${where} 不得出现字面量 ${raw}（= ${value} = ${hit?.label}；口径唯一来源是 previewpool.js）`);
    assert.equal(
      value >= PREVIEW_PORT_POOL_START && value <= PREVIEW_PORT_POOL_END,
      false,
      `${where} 不得出现池区间内的字面量 ${raw}（= ${value}；号池边界只能来自 previewpool.js）`,
    );
  }
}

test('#256③ 零端口字面量：previewPortPoolUsage 函数体 + HTTP handler 都不含端口/块几何字面量（`22_000`、`0x5618` 也算）', () => {
  const portallocSource = fs.readFileSync(path.join(SRC_DIR, 'portalloc.js'), 'utf8');
  const body = functionBodyOf(portallocSource, 'export async function previewPortPoolUsage');

  assertNoPortLiterals(body, 'previewPortPoolUsage 函数体');
  // 反证：体里确实用到了常量（否则上面几条「不含字面量」可以靠空函数通过）。
  for (const name of ['PREVIEW_PORT_POOL_START', 'PREVIEW_PORT_POOL_END', 'PREVIEW_PORT_COUNT', 'PREVIEW_PORT_BLOCK_COUNT']) {
    assert.ok(body.includes(name), `函数体必须引用 ${name}（口径唯一来源）`);
  }
});

test('#256③b HTTP handler 也不许自己算池：零字面量 + 不碰块几何常量 + 必须委派给 portalloc.previewPortPoolUsage', () => {
  const httpSource = fs.readFileSync(path.join(SRC_DIR, 'http.js'), 'utf8');
  const handler = functionBodyOf(httpSource, 'async function handleAdminPreviewPortsUsage(');

  // (a) handler 里也不许有端口 / 块几何字面量（它只该做参数校验 + 审计 + 序列化）。
  assertNoPortLiterals(handler, 'handleAdminPreviewPortsUsage');
  // (b) handler **不碰**块几何：段边界 / 块大小由 portalloc 算，handler 连常量名都不该出现。
  for (const name of ['PREVIEW_PORT_POOL_START', 'PREVIEW_PORT_POOL_END', 'PREVIEW_PORT_COUNT']) {
    assert.equal(handler.includes(name), false, `handler 不得直接使用 ${name}（池算术属于 portalloc.previewPortPoolUsage）`);
  }
  // (c) 正证：它确实把取数委派下去了（否则上面「不含字面量」可以靠空 handler 通过）。
  assert.ok(handler.includes('portalloc.previewPortPoolUsage('), 'handler 必须调用 portalloc.previewPortPoolUsage（数字在那一层算）');
  assert.ok(handler.includes('portalloc.PREVIEW_USAGE_FREE_LIMIT_DEFAULT'), '默认 limit 也必须取 portalloc 的常量（不在 handler 里写 50）');
});

// ---------------------------------------------------------------------------
// ⑤ has_more / limit
// ---------------------------------------------------------------------------
test('#256⑤ has_more 与 limit：空闲段多于 limit ⇒ has_more=true 且 items.length == limit；给够 ⇒ has_more=false', async () => {
  const store = new UsageStore();   // 全空号池：800 段全空闲
  const limited = await previewPortPoolUsage(store.pool(), { freeLimit: 3 });
  assert.equal(limited.free_blocks.limit, 3);
  assert.deepEqual(limited.free_blocks.items, [blockStart(0), blockStart(1), blockStart(2)], '空闲段起点升序');
  assert.equal(limited.free_blocks.has_more, true, '还有 797 段没列 ⇒ has_more=true');
  assert.equal(limited.summary.free, PREVIEW_PORT_BLOCK_COUNT, 'summary 数的是**全部**空闲段，不是列出来的那几条');

  const all = await previewPortPoolUsage(store.pool(), { freeLimit: PREVIEW_PORT_BLOCK_COUNT });
  assert.equal(all.free_blocks.items.length, PREVIEW_PORT_BLOCK_COUNT);
  assert.equal(all.free_blocks.has_more, false, '全给出来了 ⇒ has_more=false');

  const dflt = await previewPortPoolUsage(store.pool());
  assert.equal(dflt.free_blocks.limit, PREVIEW_USAGE_FREE_LIMIT_DEFAULT, '默认 limit = 50');
  assert.equal(dflt.free_blocks.items.length, PREVIEW_USAGE_FREE_LIMIT_DEFAULT);
  assert.equal(dflt.free_blocks.has_more, true);

  await assert.rejects(() => previewPortPoolUsage(store.pool(), { freeLimit: 0 }), /freeLimit/);
  await assert.rejects(() => previewPortPoolUsage(store.pool(), { freeLimit: 1.5 }), /freeLimit/);
});

test('#256 pool 信封：边界 / 块大小 / 段总数全部来自 previewpool.js（不是端点自己算的）', async () => {
  const usage = await previewPortPoolUsage(new UsageStore().pool());
  assert.deepEqual(usage.pool, {
    start: PREVIEW_PORT_POOL_START,
    end: PREVIEW_PORT_POOL_END,
    block_size: PREVIEW_PORT_COUNT,
    total_blocks: PREVIEW_PORT_BLOCK_COUNT,
  });
  assert.equal(usage.summary.total_blocks, PREVIEW_PORT_BLOCK_COUNT);
});

// ---------------------------------------------------------------------------
// ④ HTTP 层：403 / 恰好一行审计 / details 不含整份响应体
// ---------------------------------------------------------------------------
const ADMIN = {
  id: 'a0000000-0000-4000-8000-000000000001', login: 'root', display_name: 'root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
};
const ALICE = {
  id: 'u-alice', login: 'alice', display_name: 'Alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const ADMIN_TOKEN = 'tok-usage-admin';
const ALICE_TOKEN = 'tok-usage-alice';

class UsageHttpPool extends FakePool {
  constructor({ store, users }) {
    super({ users: users.map((u) => ({ ...u })) });
    this.store = store;
    this.sqlLog = [];
    for (const token of [
      { id: 'ls-admin', user_id: ADMIN.id, token: ADMIN_TOKEN },
      { id: 'ls-alice', user_id: ALICE.id, token: ALICE_TOKEN },
    ]) {
      this.sessions.push({
        id: token.id, user_id: token.user_id, token_hash: auth.hashToken(token.token),
        created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000),
        last_seen_at: new Date(), revoked_at: null,
      });
    }
  }

  async query(sql, params = []) {
    this.sqlLog.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    const hit = await this.store.query(sql, params);
    if (hit) return hit;
    return super.query(sql, params);
  }

  async connect() {
    const self = this;
    return { query: (sql, params) => self.query(sql, params), release() {} };
  }
}

async function startUsageServer({ store, users = [ADMIN, ALICE] } = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-usage-static-'));
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    loginRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 100, maxEntries: 10000 },
    kdfConcurrency: 2, kdfQueueLimit: 100, kdfQueueTimeoutMs: 30000,
    maxBodyBytes: 64 * 1024, maxLoginLength: 128, maxPasswordLength: 256,
    staticDir,
    baseDomain: BASE,
    portalPublicBaseUrl: PUBLIC_BASE,
  };
  const pool = new UsageHttpPool({ store, users });
  const server = createServer({ pool, config, llmGateway: { async listModels() { return { data: [] }; } }, log: LOG });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  return {
    pool,
    base: `http://127.0.0.1:${server.address().port}`,
    adminCookie: `${config.cookie.name}=${ADMIN_TOKEN}`,
    aliceCookie: `${config.cookie.name}=${ALICE_TOKEN}`,
    close: () => new Promise((res) => server.close(res)),
  };
}

test('#256④ GET /api/admin/preview-ports/usage：admin 200 + **恰好一行**审计（details 只放计数）；非 admin 403 且不写审计', async () => {
  const store = new UsageStore({
    users: [{ id: 'u-alice', fde_name: 'alice' }],
    rows: [
      ...Array.from({ length: PREVIEW_PORT_COUNT }, (_, i) => ({ fde_id: 'u-alice', port: portIn(0, i) })),
      { fde_id: 'u-alice', port: portIn(3, 0) },
    ],
  });
  const { base, adminCookie, aliceCookie, pool, close } = await startUsageServer({ store });
  try {
    const res = await fetch(`${base}/api/admin/preview-ports/usage`, { headers: { cookie: adminCookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['free_blocks', 'occupied_blocks', 'pool', 'summary']);
    assert.equal(body.summary.occupied, 1);
    assert.equal(body.summary.partial, 1);
    assert.equal(body.free_blocks.items[0], blockStart(1), '第 1 段是第一个空闲段');
    assert.equal(body.occupied_blocks.length, 2);

    assert.equal(store.writes.length, 0, '只读端点：零写库（也不入队 outbox / revision）');
    const listed = pool.audit.filter((e) => e.action === 'admin.preview_ports_usage_listed');
    assert.equal(listed.length, 1, '审计**恰好一行**（多写也算失败）');
    assert.equal(pool.audit.length, 1, '整个请求只产生这一行审计');
    assert.equal(listed[0].actor_id, ADMIN.id);
    assert.equal(listed[0].target, 'preview_port_pool');
    const details = JSON.parse(listed[0].details);
    assert.deepEqual(Object.keys(details).sort(),
      ['free_count', 'limit', 'occupied_block_count', 'total_blocks'],
      'details 只放计数：不放整份响应体（那是一张号池快照）');
    assert.equal(details.free_count, body.summary.free);
    assert.equal(details.occupied_block_count, body.occupied_blocks.length);
    assert.equal(details.total_blocks, PREVIEW_PORT_BLOCK_COUNT);
    for (const forbidden of ['occupied_blocks', 'free_blocks', 'fde_names', 'items', 'ticket']) {
      assert.equal(JSON.stringify(details).includes(forbidden), false, `details 不得含 ${forbidden}`);
    }

    // 第二次读 ⇒ 不多不少再多一行。
    await fetch(`${base}/api/admin/preview-ports/usage`, { headers: { cookie: adminCookie } });
    assert.equal(pool.audit.length, 2);

    // 非 admin ⇒ 403（既有 forbidden 路径，零新错误码）+ 不写审计。
    const forbidden = await fetch(`${base}/api/admin/preview-ports/usage`, { headers: { cookie: aliceCookie } });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error.code, 'forbidden');
    assert.equal(pool.audit.length, 2, '403 不写审计');

    // 未登录 ⇒ 401（既有口径）。
    const anon = await fetch(`${base}/api/admin/preview-ports/usage`);
    assert.equal(anon.status, 401);

    // 方法不对 ⇒ 405（与同族 admin 端点一致）。
    const wrongMethod = await fetch(`${base}/api/admin/preview-ports/usage`, {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(pool.audit.length, 2, '405 也不写审计');
  } finally {
    await close();
  }
});

test('#256④b ?limit= 合法时生效、非法时 400 validation_failed + details.field（复用既有错误码，不新造）', async () => {
  const store = new UsageStore();
  const { base, adminCookie, pool, close } = await startUsageServer({ store });
  try {
    const ok = await fetch(`${base}/api/admin/preview-ports/usage?limit=2`, { headers: { cookie: adminCookie } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.free_blocks.limit, 2);
    assert.equal(body.free_blocks.items.length, 2);
    assert.equal(body.free_blocks.has_more, true);
    assert.equal(pool.audit.length, 1);

    // #256 评审 B3：`?limit=`（**空串**）口径 = 「留空 = 不修改」⇒ 用默认值，**不是** 400 也不是 0。
    // （钉这条的理由：`Number('') === 0`、`parseInt('') === NaN`，两种写法会得到不同结果；口径必须被测试锁住，
    //  不能随实现随手挑一种。）
    const blank = await fetch(`${base}/api/admin/preview-ports/usage?limit=`, { headers: { cookie: adminCookie } });
    assert.equal(blank.status, 200, '空串不是非法值（留空 = 不修改）');
    const blankBody = await blank.json();
    assert.equal(blankBody.free_blocks.limit, PREVIEW_USAGE_FREE_LIMIT_DEFAULT, '空串 ⇒ 默认 limit');
    assert.equal(blankBody.free_blocks.items.length, PREVIEW_USAGE_FREE_LIMIT_DEFAULT);
    assert.equal(blankBody.free_blocks.has_more, true);
    assert.equal(pool.audit.length, 2, '空串走默认值 ⇒ 正常写一行审计（不是 400）');

    // 空白串（`?limit=%20`）**不是**空串 ⇒ 仍算非法值（口径边界不能模糊）。
    for (const raw of ['0', '-1', '1.5', 'abc', ' ', String(PREVIEW_PORT_BLOCK_COUNT + 1)]) {
      const bad = await fetch(`${base}/api/admin/preview-ports/usage?limit=${encodeURIComponent(raw)}`, {
        headers: { cookie: adminCookie },
      });
      assert.equal(bad.status, 400, `limit=${JSON.stringify(raw)} 必须 400`);
      const err = await bad.json();
      assert.equal(err.error.code, 'validation_failed');
      assert.equal(err.error.details.field, 'limit');
    }
    assert.equal(pool.audit.length, 2, '400 不写审计');
    assert.equal(store.writes.length, 0);
  } finally {
    await close();
  }
});
