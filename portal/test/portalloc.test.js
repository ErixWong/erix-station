// 单测：portalloc.js + previewpool.js —— 开户预分配 FDE 级预览域名，**全局号池 + 块分配**
// （issue #240 引入写入口，issue #246 交付①把分配规则换成号池块）。
//
// 覆盖工单第「测试（至少这些）」一节：
//   ① 块分配：第 1 / 2 / N 个 FDE 各得正确对齐段（22000 / 22010 / 22020）；
//   ② 已有部分活行时只补缺口（且块起点从自己的已有行反推，不会另开一段）；
//   ③ `released` 号码可复用（占用只看 state <> 'released'）；
//   ④ 跨 FDE 同端口被 0019 的全局部分唯一索引拒 → 翻成可操作错误码 `preview_port_block_taken`；
//   ⑤ 同一事务内 route outbox 与 materialize revision 的入队**顺序与存在性**（逐序 deepEqual）；
//   ⑥ 幂等：二次调用零插入（连 outbox 都不写）；
//   ⑦ 池外端口 / 非对齐块起点 / 号池用尽 三类可操作错误码；
//   ⑧ 迁移 0019 的三步顺序与 CHECK 分支：见 portal/test/migrations.test.js（静态断言 SQL 文本顺序）
//      + 交付报告里的 TEMP 克隆真库验证（整事务 ROLLBACK）。
//
// fake 必须**照真库的两条部分唯一索引 + port CHECK**模拟，否则「应用层不做先查后插」这件事就没人验：
//   A. `port_allocations_live_port_key UNIQUE (fde_id, port) WHERE state <> 'released'`
//      —— INSERT 的 ON CONFLICT 目标，命中即 DO NOTHING（同 FDE 重跑零插入）；
//   B. `port_allocations_live_global_port_key UNIQUE (port) WHERE state <> 'released'`（迁移 0019 新建）
//      —— **不在**冲突目标里，命中即抛 23505（真库语义：冲突目标不匹配 ⇒ 约束照常生效）；
//   C. `port_allocations_port_check`（0019 的按状态分支）——活行必须在池内，released 行保留 4000–29999。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import {
  PREVIEW_PORTS,
  PREVIEW_PORT_POOL_START,
  PREVIEW_PORT_POOL_END,
  PREVIEW_PORT_COUNT,
  PREVIEW_PORT_BLOCK_COUNT,
  previewBlockPorts,
  previewBlockLabel,
  previewAllocationPlan,
  ensureFdePreviewPorts,
  provisionFdePreviewPorts,
  choosePreviewBlockStart,
  listOccupiedPreviewPorts,
} from '../src/portalloc.js';
import {
  MAX_FDE_NAME_LEN_FOR_HOSTNAME,
  PREVIEW_PORT_SEGMENT_LEN,
  alignedPreviewBlockStart,
  assertAlignedPreviewBlockStart,
  firstFreePreviewBlockStart,
  isAlignedPreviewBlockStart,
  isPreviewPortInPool,
} from '../src/previewpool.js';
import { buildHostname, previewUrl } from '../src/projects.js';
import { onboardFde } from '../src/provisioner.js';
import { hashToken } from '../src/auth.js';

const SELF_UID = process.getuid?.() ?? 1000;
const SELF_GID = process.getgid?.() ?? 1000;
const BASE = 'fde.erix.vip';
const PUBLIC_BASE = 'http://station.fde.erix.vip:8090';
const FIRST_BLOCK = previewBlockPorts(PREVIEW_PORT_POOL_START);

// ---------------------------------------------------------------------------
// fake：port_allocations 内存表 + 两条部分唯一索引 + 按状态分支的 port CHECK（真库同名同谓词）
// ---------------------------------------------------------------------------
function makeStore(initialRows = []) {
  const state = {
    rows: initialRows.map((r, i) => ({ run_id: null, released_at: null, id: `seed-${i + 1}`, ...r })),
    inserted: [],
    updated: [],
    deleted: [],
    seq: 0,
    // 占用查询返回的端口可以被测试改写（模拟「算候选与真正 INSERT 之间别人抢先落库」的并发窗口）
    occupiedOverride: null,
  };
  return state;
}

function sqlError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * 事务内 fake client：按 SQL 派发，逐条记序（供顺序断言）。
 * @param store makeStore() 的内存表
 * @param hooks { failOn?: (sql)=>boolean, extra?: (sql,params)=>result|null }
 */
function makeClient(store, { seq = [], failOn = null, extra = null } = {}) {
  const outbox = { route: [], materialize: [] };
  let revSeq = 0;
  let matSeq = 0;
  const client = {
    outbox,
    seq,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      seq.push(s.split(' ').slice(0, 3).join(' '));
      if (failOn?.(s)) throw new Error(`injected failure: ${s.slice(0, 40)}`);
      if (extra) {
        const hit = extra(s, params);
        if (hit) return hit;
      }
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
      // 候选块的占用取数：全局活行端口；带 fde_id 谓词时只返回该 FDE 的活行端口。
      if (s.startsWith('SELECT DISTINCT port FROM port_allocations')) {
        if (store.occupiedOverride) return { rows: store.occupiedOverride.map((port) => ({ port })) };
        const [start, end, fdeId] = params;
        const rows = store.rows
          .filter((r) => r.state !== 'released' && r.port >= start && r.port <= end)
          .filter((r) => (fdeId === undefined || fdeId === null || r.fde_id === fdeId))
          .map((r) => ({ port: r.port }));
        return { rows, rowCount: rows.length };
      }
      if (s.startsWith('INSERT INTO port_allocations')) {
        // 必须是「带谓词的冲突目标」——漏写 WHERE 真库会直接报 no unique or exclusion constraint。
        assert.match(s, /ON CONFLICT \(fde_id, port\) WHERE state <> 'released' DO NOTHING/,
          'INSERT 必须以部分唯一索引 (fde_id, port) WHERE state <> \'released\' 为冲突目标');
        const [fdeId, scope, port, role, hostname, url, exposure] = params;
        assert.equal(scope, 'fde', "scope 必须写 'fde'（迁移 0018 放开的第三个值）");
        assert.equal(role, 'spare', "role 用既有的 'spare'，不新造枚举");
        assert.equal(exposure, 'private');
        // C. 0019 的按状态分支 CHECK（新行一律是活行 ⇒ 必须落在池内）。
        if (!isPreviewPortInPool(port)) {
          throw sqlError('23514', `new row violates check constraint "port_allocations_port_check": port ${port}`);
        }
        // A. 同 FDE 的活行 ⇒ 冲突目标命中 ⇒ DO NOTHING。
        const sameFde = store.rows.find((r) => r.fde_id === fdeId && r.port === port && r.state !== 'released');
        if (sameFde) return { rows: [], rowCount: 0 };
        // B. 跨 FDE 抢同一个号 ⇒ 冲突目标不匹配 ⇒ 全局索引抛 23505（这正是 #246 的硬不变式）。
        const foreign = store.rows.find((r) => r.port === port && r.state !== 'released');
        if (foreign) {
          throw sqlError('23505', `duplicate key value violates unique constraint "port_allocations_live_global_port_key": port ${port}`);
        }
        const row = {
          id: `pa-${++store.seq}`, fde_id: fdeId, scope, port, role, hostname, url, exposure,
          state: 'allocated', run_id: null, released_at: null,
        };
        store.rows.push(row);
        store.inserted.push({ ...row });
        return { rows: [{ id: row.id, port }], rowCount: 1 };
      }
      if (s.startsWith('UPDATE port_allocations')) { store.updated.push(params); return { rows: [] }; }
      if (s.startsWith('DELETE FROM port_allocations')) { store.deleted.push(params); return { rows: [] }; }
      if (s.includes('INSERT INTO route_revisions')) {
        outbox.route.push({ aggregate: params[0], aggregateId: params[1], revision: ++revSeq });
        return { rows: [{ revision: revSeq }] };
      }
      if (s.includes('INSERT INTO route_outbox')) {
        outbox.route.at(-1).op = params[2];
        outbox.route.at(-1).payload = JSON.parse(params[4]);
        return { rows: [] };
      }
      if (s.includes('INSERT INTO materialize_revisions')) {
        outbox.materialize.push({ fdeId: params[0], revision: ++matSeq });
        return { rows: [{ revision: matSeq }] };
      }
      if (s.includes('INSERT INTO materialize_outbox')) {
        outbox.materialize.at(-1).op = params[1];
        outbox.materialize.at(-1).payload = JSON.parse(params[3]);
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return client;
}

function makePool(client) {
  return {
    async connect() { return client; },
    async query() { return { rows: [] }; },
  };
}

const CONFIG = { baseDomain: BASE, portalPublicBaseUrl: PUBLIC_BASE };

/** 生成一条已存在的行（默认落在号池第一个对齐块上，与 0019 重排后的真机形态一致）。 */
function liveRow(fdeId, port, over = {}) {
  return {
    fde_id: fdeId, scope: 'fde', port, role: 'spare',
    hostname: `${'x'.repeat(0)}fde${fdeId}-p-${port}.${BASE}`, url: `http://fde${fdeId}-p-${port}.${BASE}:8090`,
    exposure: 'private', state: 'allocated', ...over,
  };
}

// ---------------------------------------------------------------------------
// 纯函数：号池几何与预算（previewpool.js）
// ---------------------------------------------------------------------------
test('号池常量与块几何（#246）：22000–29999 / 每段 10 个 / 800 段 / 首标签固定段 8 字符', () => {
  assert.equal(PREVIEW_PORT_POOL_START, 22000);
  assert.equal(PREVIEW_PORT_POOL_END, 29999);
  assert.equal(PREVIEW_PORT_COUNT, 10);
  assert.equal(PREVIEW_PORT_BLOCK_COUNT, 800, '容量给到 800 段（决策者裁决）');
  assert.equal(MAX_FDE_NAME_LEN_FOR_HOSTNAME, 63 - PREVIEW_PORT_SEGMENT_LEN, '预算由池上界宽度推导');
  assert.equal(PREVIEW_PORT_SEGMENT_LEN, 8, '5 位端口 ⇒ 首标签固定段 8 字符（#240 时代是 7）');
  assert.deepEqual(PREVIEW_PORTS, FIRST_BLOCK);
  assert.deepEqual(FIRST_BLOCK, [22000, 22001, 22002, 22003, 22004, 22005, 22006, 22007, 22008, 22009]);
  assert.equal(previewBlockLabel(PREVIEW_PORT_POOL_START), '22000-22009');
  // 对齐判据：起点必须是 10 的倍数且整块在池内。
  assert.equal(isAlignedPreviewBlockStart(22000), true);
  assert.equal(isAlignedPreviewBlockStart(29990), true);
  assert.equal(isAlignedPreviewBlockStart(22005), false, '非 10 倍数起点不合法');
  assert.equal(isAlignedPreviewBlockStart(29995), false, '越界（块尾 > 池上界）不合法');
  assert.equal(isAlignedPreviewBlockStart(21990), false, '池外起点不合法');
  assert.equal(alignedPreviewBlockStart(22017), 22010, '端口 → 所在对齐块');
  assert.equal([...previewBlockPorts(29990)].at(-1), 29999, '最后一块正好贴到池上界');
  assert.throws(() => previewBlockPorts(22005), (err) => err.code === 'preview_port_block_invalid');
  assert.throws(() => assertAlignedPreviewBlockStart(22005), (err) => err.code === 'preview_port_block_invalid');
});

test('firstFreePreviewBlockStart：占用只看整块，released 号码由调用方过滤后自然可复用', () => {
  assert.equal(firstFreePreviewBlockStart([]), 22000);
  assert.equal(firstFreePreviewBlockStart([22003]), 22010, '块内任一号被占 ⇒ 整块跳过');
  assert.equal(firstFreePreviewBlockStart([22000, 22015]), 22020);
  assert.equal(firstFreePreviewBlockStart([22009, 22010]), 22020, '贴边占用也要跳过两块');
  assert.equal(firstFreePreviewBlockStart([22000], { skipBlocks: [22010] }), 22020, 'skipBlocks 也参与整块排除');
  // 池尾：最后一段全空时返回 29990；再占一个就耗尽。
  const allButLast = Array.from({ length: 7990 }, (_, i) => 22000 + i);   // 22000..29989（前 799 段全满）
  assert.equal(firstFreePreviewBlockStart(allButLast), 29990);
  assert.equal(firstFreePreviewBlockStart([...allButLast, 29995]), null,
    '池用尽必须显式返回 null（不许静默给池外号）');
});

// ---------------------------------------------------------------------------
// 纯函数：期望态与读侧同源（hostname/url 一律走 projects.js 的唯一生成入口）
// ---------------------------------------------------------------------------
test('previewAllocationPlan：一整块 10 条、端口 22000–22009、hostname/url 与读侧同一生成入口', () => {
  const plan = previewAllocationPlan({ fdeName: 'alice', baseDomain: BASE, publicBaseUrl: PUBLIC_BASE });
  assert.equal(plan.length, PREVIEW_PORT_COUNT);
  assert.deepEqual(plan.map((p) => p.port), FIRST_BLOCK);
  for (const p of plan) {
    assert.equal(p.hostname, buildHostname({ fdeName: 'alice', port: p.port, baseDomain: BASE }));
    assert.equal(p.hostname, `alice-p-${p.port}.${BASE}`, '5 位端口原样进 hostname（padStart 不截断）');
    assert.equal(p.url, previewUrl(p.hostname, { publicBaseUrl: PUBLIC_BASE }));
    assert.equal(p.url, `http://alice-p-${p.port}.${BASE}:8090`, 'url 的 scheme/端口从公开入口派生（#57 阶段2）');
    assert.ok(p.url, 'url 必须非空（前端只展示该字段，portal.md §8-4）');
    assert.equal(p.scope, 'fde');
    assert.equal(p.role, 'spare');
    assert.equal(p.exposure, 'private');
    assert.equal(p.state, 'allocated');
  }
});

// ---------------------------------------------------------------------------
// ① 块分配：第 1 / 2 / N 个 FDE 各得正确对齐段
// ---------------------------------------------------------------------------
test('① 块分配：三个 FDE 依次拿到 22000 / 22010 / 22020，跨 FDE 不重叠', async () => {
  const store = makeStore();
  const client = makeClient(store);
  const got = {};
  for (const [i, fdeId] of ['u1', 'u2', 'u3'].entries()) {
    const out = await ensureFdePreviewPorts(client, {
      fdeId, fdeName: `fde${i + 1}`, baseDomain: BASE, publicBaseUrl: PUBLIC_BASE, log: { log() {} },
    });
    got[fdeId] = out;
    const expected = PREVIEW_PORT_POOL_START + i * PREVIEW_PORT_COUNT;
    assert.equal(out.blockStart, expected, `第 ${i + 1} 个 FDE 必须拿第 ${i + 1} 段`);
    assert.equal(out.blockEnd, expected + 9);
    assert.deepEqual(out.inserted.map((r) => r.port), previewBlockPorts(expected));
    assert.equal(out.requested, PREVIEW_PORT_COUNT);
  }
  assert.equal(previewBlockLabel(got.u2.blockStart), '22010-22019');
  assert.equal(previewBlockLabel(got.u3.blockStart), '22020-22029');
  // hostname 跟着块里的号走（不是旧的 4000 段）
  assert.equal(store.rows.find((r) => r.fde_id === 'u2').hostname, 'fde2-p-22010.fde.erix.vip');
  // 全局唯一：10×3 个号互不相同
  assert.equal(new Set(store.rows.map((r) => r.port)).size, 30);
});

test('① 占用判据：只看 state <> released 的**全局**活行（不分 FDE），released 号码可复用', async () => {
  const store = makeStore([
    // 别的 FDE 的活行占了第一段
    liveRow('other', 22000), liveRow('other', 22007),
    // 再一个 FDE 的 released 历史行占了第二段（released 不占位 ⇒ 号可复用）
    liveRow('gone', 22010, { state: 'released', released_at: new Date('2026-10-01T00:00:00Z') }),
    liveRow('gone', 22019, { state: 'released', released_at: new Date('2026-10-01T00:00:00Z') }),
  ]);
  const client = makeClient(store);
  assert.deepEqual((await listOccupiedPreviewPorts(client)).sort((a, b) => a - b), [22000, 22007]);
  const out = await ensureFdePreviewPorts(client, {
    fdeId: 'u9', fdeName: 'newbie', baseDomain: BASE, publicBaseUrl: PUBLIC_BASE, log: { log() {} },
  });
  assert.equal(out.blockStart, 22010, '第一段被活行占住 ⇒ 跳过；第二段的 released 行不算占用');
  assert.deepEqual(out.inserted.map((r) => r.port), previewBlockPorts(22010));
});

test('② 已有部分活行时只补缺口，且块起点从自己的已有行反推（不会另开一段）', async () => {
  const store = makeStore([
    liveRow('u1', 22010), liveRow('u1', 22015), liveRow('u1', 22019),
    // 别的 FDE 已经拿了第二段的前几个号（与 u1 无冲突，但不能把 u1 拽到 22000 去）
    liveRow('u2', 22000),
  ]);
  const client = makeClient(store);
  const out = await ensureFdePreviewPorts(client, {
    fdeId: 'u1', fdeName: 'alice', baseDomain: BASE, publicBaseUrl: PUBLIC_BASE, log: { log() {} },
  });
  assert.equal(out.blockStart, 22010, '本 FDE 已占的号决定块起点');
  assert.deepEqual(out.inserted.map((r) => r.port), [22011, 22012, 22013, 22014, 22016, 22017, 22018]);
  assert.equal(out.skipped, 3);
  assert.equal(client.outbox.route.length, 7, '只为真正新增的行入队路由');
  assert.equal(client.outbox.materialize.length, 1);
  assert.deepEqual(store.updated, [], '不得 UPDATE 任何既有 allocation');
  assert.deepEqual(store.deleted, [], '不得 DELETE 任何既有 allocation');
});

test('② 自己的块里有**外来**活行（号被侵吞过）⇒ 整段换掉，不在残缺段里硬补', async () => {
  const store = makeStore([
    liveRow('u1', 22000),
    liveRow('u2', 22003),           // 外来行落在 u1 的第一段内
    liveRow('u3', 22010),           // 第二段也被占
  ]);
  const client = makeClient(store);
  const out = await ensureFdePreviewPorts(client, {
    fdeId: 'u1', fdeName: 'alice', baseDomain: BASE, publicBaseUrl: PUBLIC_BASE, log: { log() {} },
  });
  assert.equal(out.blockStart, 22020, '第一、二段都不完整/被占 ⇒ 取下一个整块空闲段');
  assert.equal(out.inserted.length, PREVIEW_PORT_COUNT, '新段内 10 条全插（残缺段里的旧行保持原样）');
});

test('② released 行不算「已存在」：部分唯一索引只覆盖 state <> released ⇒ 释放后重分配插新行', async () => {
  const store = makeStore([
    liveRow('u1', 22003, { state: 'released', released_at: new Date('2026-10-01T00:00:00Z') }),
  ]);
  const client = makeClient(store);
  const out = await ensureFdePreviewPorts(client, {
    fdeId: 'u1', fdeName: 'alice', baseDomain: BASE, publicBaseUrl: PUBLIC_BASE, log: { log() {} },
  });
  assert.equal(out.blockStart, 22000, 'released 的 22003 既不占块也不定块起点');
  assert.deepEqual(out.inserted.map((r) => r.port), FIRST_BLOCK, '10 条全插');
  assert.equal(store.rows.filter((r) => r.port === 22003).length, 2, '软删除留档 + 新行并存');
});

// ---------------------------------------------------------------------------
// ④ 重叠不变式：并发/抢号由 DB 索引兜底，应用层只翻错误码
// ---------------------------------------------------------------------------
test('④ 跨 FDE 抢同一个号 → 全局唯一索引抛 23505 → preview_port_block_taken（可操作、带重试指引）', async () => {
  const store = makeStore();
  const client = makeClient(store);
  // 并发窗口：算候选时块是空的（occupied 查询返回空），INSERT 时别人已经把 22003 落了库。
  store.occupiedOverride = [];
  store.rows.push(liveRow('racer', 22003));
  await assert.rejects(
    () => ensureFdePreviewPorts(client, {
      fdeId: 'u1', fdeName: 'alice', baseDomain: BASE, publicBaseUrl: PUBLIC_BASE, log: { log() {} },
    }),
    (err) => {
      assert.equal(err.code, 'preview_port_block_taken');
      assert.equal(err.cause?.code, '23505', '原始 23505 必须留在 cause 里（排障要看真错）');
      assert.match(err.message, /22000-22009/, '文案要指名是哪一段被抢');
      assert.match(err.message, /port_allocations_live_global_port_key/, '要指认是哪条索引（0019）');
      assert.match(err.message, /重叠/, '要说清是「重叠」这个硬不变式被拒');
      assert.match(err.message, /重试/, '必须给出下一步动作（重试会自动取下一段）');
      return true;
    },
  );
});

test('④ 应用层不做「先查后插」查重循环：逐条 INSERT 靠 DO NOTHING 判重', async () => {
  const store = makeStore([liveRow('u1', 22001), liveRow('u1', 22002)]);
  const seq = [];
  const client = makeClient(store, { seq });
  await ensureFdePreviewPorts(client, {
    fdeId: 'u1', fdeName: 'alice', baseDomain: BASE, publicBaseUrl: PUBLIC_BASE, log: { log() {} },
  });
  assert.equal(seq.filter((x) => x.startsWith('INSERT INTO port_allocations')).length, PREVIEW_PORT_COUNT,
    '一整块 = 一整轮逐条 INSERT（判重交给索引）');
  assert.equal(seq.filter((x) => x.startsWith('SELECT DISTINCT port')).length, 2,
    '取数只有「全局占用 + 本 FDE 占用」两条候选块查询，没有额外的存在性查重');
});

test('⑦ 端口/块起点不合法与号池耗尽都是可操作错误码（不落到裸 23514 / 23505）', async () => {
  const store = makeStore();
  const client = makeClient(store);
  // 管理员指定块起点但没对齐
  await assert.rejects(
    () => ensureFdePreviewPorts(client, { fdeId: 'u1', fdeName: 'alice', baseDomain: BASE, blockStart: 22005 }),
    (err) => err.code === 'preview_port_block_invalid' && /22000、22010/.test(err.message),
  );
  // 显式端口清单里有池外号（例如还按 #240 的旧窗口传 4005）
  await assert.rejects(
    () => ensureFdePreviewPorts(client, { fdeId: 'u1', fdeName: 'alice', baseDomain: BASE, ports: [22000, 4005] }),
    (err) => err.code === 'preview_port_out_of_pool' && /4005/.test(err.message) && /22000–29999/.test(err.message),
  );
  // 块起点覆盖：合法值整块生效
  const out = await ensureFdePreviewPorts(client, {
    fdeId: 'u1', fdeName: 'alice', baseDomain: BASE, publicBaseUrl: PUBLIC_BASE, blockStart: 29990, log: { log() {} },
  });
  assert.deepEqual(out.inserted.map((r) => r.port), previewBlockPorts(29990));
  assert.equal(out.blockEnd, 29999);
  // 号池耗尽
  const full = makeStore(Array.from({ length: PREVIEW_PORT_BLOCK_COUNT * PREVIEW_PORT_COUNT },
    (_, i) => liveRow('everyone', PREVIEW_PORT_POOL_START + i)));
  await assert.rejects(
    () => choosePreviewBlockStart(makeClient(full), { fdeId: 'nobody' }),
    (err) => err.code === 'preview_port_pool_exhausted' && /800 段/.test(err.message),
  );
  assert.equal(store.rows.length, PREVIEW_PORT_COUNT, '上面失败的调用一条都不写');
});

// ---------------------------------------------------------------------------
// ⑤ 同一事务：派生链顺序 / 原子性
// ---------------------------------------------------------------------------
test('⑤ provisionFdePreviewPorts：BEGIN → 占用取数×2 → 10×INSERT → 10×(route head + outbox) → materialize → COMMIT 逐序', async () => {
  const store = makeStore();
  const seq = [];
  const client = makeClient(store, { seq });
  await provisionFdePreviewPorts(makePool(client), CONFIG, { fdeId: 'u1', fdeName: 'alice', log: { log() {}, warn() {} } });
  assert.deepEqual(seq, [
    'BEGIN',
    'SELECT DISTINCT port',
    'SELECT DISTINCT port',
    ...Array.from({ length: PREVIEW_PORT_COUNT }, () => 'INSERT INTO port_allocations'),
    ...Array.from({ length: PREVIEW_PORT_COUNT }, () => ['INSERT INTO route_revisions', 'INSERT INTO route_outbox']).flat(),
    'INSERT INTO materialize_revisions',
    'INSERT INTO materialize_outbox',
    'COMMIT',
  ], '事务内顺序必须逐条一致（派生链与写库同事务，route 先、materialize 后）');
});

test('⑤ 入队失败 → ROLLBACK：不留「行已写、派生链永不重算」的半截状态', async () => {
  const store = makeStore();
  const seq = [];
  const client = makeClient(store, { seq, failOn: (s) => s.startsWith('INSERT INTO materialize_outbox') });
  await assert.rejects(
    () => provisionFdePreviewPorts(makePool(client), CONFIG, { fdeId: 'u1', fdeName: 'alice', log: { log() {}, warn() {} } }),
    /injected failure/,
  );
  assert.ok(seq.includes('ROLLBACK'), '必须回滚');
  assert.ok(!seq.includes('COMMIT'), '不得提交');
});

test('⑤ 抢号失败也走 ROLLBACK（preview_port_block_taken 冒到独立事务包装层）', async () => {
  // occupiedOverride=[] 模拟并发窗口：算候选时块是空的，但 INSERT 时别人已经把 22000 落了库。
  // （PG 在事务块里遇错即整笔 aborted ⇒ 不能就地换号，只能整笔回滚由调用方重试。）
  const store = makeStore([liveRow('racer', 22000)]);
  store.occupiedOverride = [];
  const seq = [];
  const client = makeClient(store, { seq });
  await assert.rejects(
    () => provisionFdePreviewPorts(makePool(client), CONFIG, { fdeId: 'u1', fdeName: 'alice', log: { log() {}, warn() {} } }),
    (err) => err.code === 'preview_port_block_taken',
  );
  assert.ok(seq.includes('ROLLBACK') && !seq.includes('COMMIT'));
});

// ---------------------------------------------------------------------------
// ①/⑥ 真实 provision 链路 + 幂等
// ---------------------------------------------------------------------------
test('① onboardFde（真实函数）开户即写一整块 10 行 scope=fde 预览域名，并回报分到的块', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portalloc-onboard-'));
  const store = makeStore();
  const extra = (s) => {
    if (s.includes('pg_advisory')) return { rows: [] };
    if (s.includes('FROM fde_networks WHERE fde_id')) {
      return { rows: [{ fde_id: 'u-alice', network_name: 'fde-alice', subnet: '10.200.9.0/29', prefix_len: 29, gateway: '10.200.9.1', pool: 'default', state: 'allocated' }] };
    }
    if (s.includes('FROM fde_llm_bindings')) return { rows: [] };
    return null;
  };
  const client = makeClient(store, { extra });
  const pool = {
    async connect() { return client; },
    async query(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      client.seq.push(s.split(' ').slice(0, 3).join(' '));
      if (s.includes('FROM users WHERE fde_name')) return { rows: [{ id: 'u-alice', fde_name: 'alice', login: 'alice', status: 'active' }] };
      if (s.includes('FROM containers WHERE user_id')) {
        return { rows: [{ id: 'c-1', runner_token_hash: hashToken('tok-alice'), revoked_at: null }] };
      }
      return { rows: [] };
    },
  };
  const docker = {
    async inspectContainer() {
      return { status: 200, data: { State: { Status: 'running' }, Config: { Env: ['ERIX_STATION_TOKEN=tok-alice'] } } };
    },
    async inspectNetwork() {
      return {
        status: 200,
        data: {
          Id: 'net-1',
          Labels: { 'station.managed': 'true', 'fde.name': 'alice' },
          IPAM: { Config: [{ Subnet: '10.200.9.0/29', Gateway: '10.200.9.1' }] },
        },
      };
    },
    async createContainer() { return { status: 201, data: { Id: 'ctr-1' } }; },
    async startContainer() { return { status: 204 }; },
    async stopContainer() { return { status: 204 }; },
    async removeContainer() { return { status: 404 }; },
    async createNetwork() { return { status: 201, data: { Id: 'net-1' } }; },
  };
  const config = {
    ...CONFIG,
    userSpaceRoot: root,
    userSpaceRootHost: root,
    fdeUid: SELF_UID,
    fdeGid: SELF_GID,
    fdeImage: 'erix/fde:test',
    llmHost: 'llm.fde.erix.vip',
  };
  try {
    const out = await onboardFde(pool, config, { fdeName: 'alice', docker, log: { log() {}, warn() {} } });

    assert.deepEqual(out.previewPorts, {
      requested: PREVIEW_PORT_COUNT, created: PREVIEW_PORT_COUNT, skipped: 0,
      blockStart: 22000, blockEnd: 22009, ports: FIRST_BLOCK,
    }, '返回值必须带上条数与**分到的块**（CLI 输出与验收都看它）');
    const mine = store.rows.filter((r) => r.fde_id === 'u-alice');
    assert.equal(mine.length, PREVIEW_PORT_COUNT, 'provision 必须一次写满一整块');
    assert.deepEqual(mine.map((r) => r.port), FIRST_BLOCK);
    for (const row of mine) {
      assert.equal(row.scope, 'fde');
      assert.equal(row.role, 'spare');
      assert.equal(row.exposure, 'private');
      assert.equal(row.state, 'allocated', 'state 恒 allocated（首次 forward-auth 才升 active，§8.6）');
      assert.equal(row.run_id, null, "scope<>'run' ⇒ run_id 必须 NULL（CHECK ((scope='run') = (run_id IS NOT NULL))）");
      assert.equal(row.hostname, `alice-p-${row.port}.${BASE}`);
      assert.equal(row.url, previewUrl(row.hostname, { publicBaseUrl: PUBLIC_BASE }));
      assert.ok(row.url.length > 0);
    }

    const seq = client.seq;
    const firstPortInsert = seq.findIndex((x) => x.startsWith('INSERT INTO port_allocations'));
    const firstSelect = seq.findIndex((x) => x.startsWith('SELECT DISTINCT port'));
    const firstRouteRev = seq.findIndex((x) => x.startsWith('INSERT INTO route_revisions'));
    const firstRouteOutbox = seq.findIndex((x) => x.startsWith('INSERT INTO route_outbox'));
    const firstMatRev = seq.findIndex((x) => x.startsWith('INSERT INTO materialize_revisions'));
    const firstMatOutbox = seq.findIndex((x) => x.startsWith('INSERT INTO materialize_outbox'));
    const commitIdx = seq.lastIndexOf('COMMIT');
    assert.ok(firstSelect > 0 && firstSelect < firstPortInsert, '候选块取数必须先于 INSERT（占用判据 = 全局活行）');
    assert.ok(firstRouteRev > firstPortInsert && firstRouteOutbox > firstRouteRev, 'route revision head 先于 route outbox 行');
    assert.ok(firstMatRev > firstRouteOutbox, 'route outbox 先于 materialize revision head');
    assert.ok(firstMatOutbox > firstMatRev, 'materialize revision head 先于 materialize outbox 行');
    assert.ok(firstMatOutbox < commitIdx, '派生链入队必须在 COMMIT 之前（同事务，禁止 COMMIT 后补入队）');
    assert.equal(seq.filter((x) => x.startsWith('INSERT INTO port_allocations')).length, PREVIEW_PORT_COUNT);
    assert.equal(seq.filter((x) => x.startsWith('INSERT INTO route_revisions')).length, PREVIEW_PORT_COUNT, '每条新 allocation 一条 route outbox');
    assert.equal(seq.filter((x) => x.startsWith('INSERT INTO materialize_revisions')).length, 1, 'materialize 聚合是每 FDE 一条');

    assert.equal(client.outbox.route.length, PREVIEW_PORT_COUNT);
    assert.deepEqual(client.outbox.route.map((r) => r.aggregate), Array(PREVIEW_PORT_COUNT).fill('port_allocation'));
    assert.deepEqual(client.outbox.route.map((r) => r.op), Array(PREVIEW_PORT_COUNT).fill('upsert'));
    assert.deepEqual(client.outbox.route.map((r) => r.aggregateId), store.inserted.map((r) => r.id),
      'aggregate_id = port_allocations.id（schema.sql §9 对该聚合的口径）');
    assert.deepEqual(client.outbox.route[0].payload, { fde_name: 'alice', hostname: 'alice-p-22000.fde.erix.vip', port: 22000, scope: 'fde' });
    assert.equal(client.outbox.materialize.length, 1);
    assert.equal(client.outbox.materialize[0].fdeId, 'u-alice');
    assert.equal(client.outbox.materialize[0].op, 'upsert');
    assert.deepEqual(client.outbox.materialize[0].payload.ports, FIRST_BLOCK);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('⑥ 幂等：整块已齐备时二次调用零插入，块起点不变，且一个 outbox 字节都不写', async () => {
  const store = makeStore();
  const first = makeClient(store);
  const out1 = await ensureFdePreviewPorts(first, { fdeId: 'u1', fdeName: 'alice', baseDomain: BASE, publicBaseUrl: PUBLIC_BASE, log: { log() {} } });
  assert.equal(out1.inserted.length, PREVIEW_PORT_COUNT);
  assert.equal(out1.materializeRevision, 1);

  const secondSeq = [];
  const second = makeClient(store, { seq: secondSeq });
  const out2 = await ensureFdePreviewPorts(second, { fdeId: 'u1', fdeName: 'alice', baseDomain: BASE, publicBaseUrl: PUBLIC_BASE, log: { log() {} } });
  assert.equal(out2.inserted.length, 0, '二次调用必须零插入（幂等判据 = 部分唯一索引 + DO NOTHING）');
  assert.equal(out2.skipped, PREVIEW_PORT_COUNT);
  assert.equal(out2.blockStart, out1.blockStart, '重跑必须落在同一段（不能又开一段新的）');
  assert.equal(out2.materializeRevision, null, '零插入时不得空转 materialize revision');
  assert.deepEqual(second.outbox.route, [], '零插入时不得写 route outbox');
  assert.deepEqual(second.outbox.materialize, [], '零插入时不得写 materialize outbox');
  assert.equal(secondSeq.filter((x) => x.startsWith('INSERT INTO port_allocations')).length, PREVIEW_PORT_COUNT,
    '仍然逐条 INSERT（靠 DO NOTHING 判重，不是先查后插）');
  assert.equal(store.rows.length, PREVIEW_PORT_COUNT, '总行数不变');
});

// ---------------------------------------------------------------------------
// 边界：FDE 名超预算 / 缺参 / url 退化 / CLI 输出带块
// ---------------------------------------------------------------------------
test('FDE 名超预览域名预算（#202/#246 预算 55）→ preview_hostname_invalid，一条都不写', async () => {
  const store = makeStore();
  const client = makeClient(store);
  const long = 'a'.repeat(56);   // 56 + 固定段 8 = 64 > 63（#246 前这条会放行）
  assert.equal(MAX_FDE_NAME_LEN_FOR_HOSTNAME, 55);
  await assert.rejects(
    () => ensureFdePreviewPorts(client, { fdeId: 'u1', fdeName: long, baseDomain: BASE, publicBaseUrl: PUBLIC_BASE }),
    (err) => err.code === 'preview_hostname_invalid' && /55/.test(err.message),
  );
  assert.equal(store.rows.length, 0, '前置校验必须在任何 INSERT 之前（否则 0017 的 DB CHECK 会在事务中途炸掉开户）');
});

test('缺 baseDomain / fdeId → 直接抛错（不静默写空 hostname）', async () => {
  const store = makeStore();
  const client = makeClient(store);
  await assert.rejects(() => ensureFdePreviewPorts(client, { fdeId: 'u1', fdeName: 'alice', baseDomain: null }), /baseDomain required/);
  await assert.rejects(() => ensureFdePreviewPorts(client, { fdeId: null, fdeName: 'alice', baseDomain: BASE }), /fdeId\/fdeName required/);
  assert.equal(store.rows.length, 0);
});

test('publicBaseUrl 缺省 → url 退化为 https 无端口（与 projects.previewUrl 同口径，不猜端口）', async () => {
  const store = makeStore();
  const client = makeClient(store);
  await ensureFdePreviewPorts(client, { fdeId: 'u1', fdeName: 'alice', baseDomain: BASE, log: { log() {} } });
  assert.equal(store.rows[0].url, 'https://alice-p-22000.fde.erix.vip');
});

// CLI 的运维可见面：`provision-fde` 必须把分到的块打在输出行里（工单第 2 节最后一条）。
test('cli.js provision-fde 输出行带 block=<起>-<止>', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.js'), 'utf8');
  assert.match(src, /block=\$\{out\.previewPorts\.blockStart\}-\$\{out\.previewPorts\.blockEnd\}/,
    '输出行必须带块（运维一眼看到号段）');
  assert.match(src, /preview_ports=\$\{out\.previewPorts\.created\}\/\$\{out\.previewPorts\.requested\}/,
    '条数口径保持不变（#240 的验收锚点）');
});
