// 单测：portalloc.js —— 开户预分配 10 条 FDE 级预览域名（issue #240）。
//
// 覆盖工单第 4 节的四条判据：
//   ① provision 时写入 10 行，端口 4000–4009、hostname `<fde>-p-<port>.<base>`、url 非空且等于
//      previewUrl(...)、state='allocated'、scope='fde'、role='spare'    → 走**真实 onboardFde**
//      （fake pool + fake docker），不是「等价调用」的替身断言；
//   ② ensureFdePreviewPorts 幂等：二次调用零插入（连 outbox 都不写），缺 3 条只补 3 条；
//   ③ 同一事务内 route outbox 与 materialize revision 的入队**顺序与存在性**（逐序 deepEqual，
//      照 provisioner.test.js「事务内顺序：BEGIN → revision head → outbox → COMMIT」的写法）；
//   ④ 迁移 0018 放开 scope CHECK：见 portal/test/migrations.test.js。
//
// 幂等判据的实现是「部分唯一索引 + ON CONFLICT DO NOTHING」（不是先查后插），所以这里的 fake
// 必须**照真库的索引语义**模拟冲突：`UNIQUE (fde_id, port) WHERE state <> 'released'`——
// 已 released 的行不在索引内，重分配要插新行。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PREVIEW_PORTS,
  PREVIEW_PORT_START,
  PREVIEW_PORT_COUNT,
  previewAllocationPlan,
  ensureFdePreviewPorts,
  provisionFdePreviewPorts,
} from '../src/portalloc.js';
import { buildHostname, previewUrl } from '../src/projects.js';
import { onboardFde } from '../src/provisioner.js';
import { hashToken } from '../src/auth.js';

const SELF_UID = process.getuid?.() ?? 1000;
const SELF_GID = process.getgid?.() ?? 1000;
const BASE = 'fde.erix.vip';
const PUBLIC_BASE = 'http://station.fde.erix.vip:8090';

// ---------------------------------------------------------------------------
// fake：port_allocations 内存表 + 两张部分唯一索引（真库同名同谓词）
// ---------------------------------------------------------------------------
function makeStore(initialRows = []) {
  const state = {
    rows: initialRows.map((r, i) => ({ run_id: null, released_at: null, id: `seed-${i + 1}`, ...r })),
    inserted: [],
    updated: [],
    deleted: [],
    seq: 0,
  };
  return state;
}

/**
 * 事务内 fake client：按 SQL 派发，逐条记序（供顺序断言）。
 * @param store makeStore() 的内存表
 * @param hooks { failOn?: (sql)=>boolean } 注入失败，验证回滚
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
      if (s.startsWith('INSERT INTO port_allocations')) {
        // 必须是「带谓词的冲突目标」——漏写 WHERE 真库会直接报 no unique or exclusion constraint。
        assert.match(s, /ON CONFLICT \(fde_id, port\) WHERE state <> 'released' DO NOTHING/,
          'INSERT 必须以部分唯一索引 (fde_id, port) WHERE state <> \'released\' 为冲突目标');
        const [fdeId, scope, port, role, hostname, url, exposure] = params;
        assert.equal(scope, 'fde', "scope 必须写 'fde'（迁移 0018 放开的第三个值）");
        assert.equal(role, 'spare', "role 用既有的 'spare'，不新造枚举");
        assert.equal(exposure, 'private');
        // 部分唯一索引语义：只与 state <> 'released' 的行冲突。
        const clash = store.rows.find((r) => r.fde_id === fdeId && r.port === port && r.state !== 'released');
        if (clash) return { rows: [], rowCount: 0 };
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

// ---------------------------------------------------------------------------
// 纯函数：期望态与读侧同源（hostname/url 一律走 projects.js 的唯一生成入口）
// ---------------------------------------------------------------------------
test('previewAllocationPlan：10 条、端口 4000–4009、hostname/url 与读侧同一生成入口', () => {
  const plan = previewAllocationPlan({ fdeName: 'alice', baseDomain: BASE, publicBaseUrl: PUBLIC_BASE });
  assert.equal(plan.length, 10);
  assert.deepEqual(plan.map((p) => p.port), PREVIEW_PORTS);
  assert.deepEqual(PREVIEW_PORTS, Array.from({ length: 10 }, (_, i) => 4000 + i));
  assert.equal(PREVIEW_PORT_START, 4000);
  assert.equal(PREVIEW_PORT_COUNT, 10);
  for (const p of plan) {
    assert.equal(p.hostname, buildHostname({ fdeName: 'alice', port: p.port, baseDomain: BASE }));
    assert.equal(p.hostname, `alice-p-${p.port}.${BASE}`, 'port4 恒 4 位（4000..4009 天然 4 位）');
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
// ① 真实 provision 链路：onboardFde 一次开户写满 10 行
// ---------------------------------------------------------------------------
test('① onboardFde（真实函数）开户即写 10 行 scope=fde 预览域名，逐字段符合裁决', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portalloc-onboard-'));
  const store = makeStore();
  // onboardFde 全流程共用一个 fake client：withFdeLock / allocateNetwork / 预览域名事务 /
  // syncFdeLlmBindingOnOnboard 都走 pool.connect()。extra 只补「非预览域名」那几条 SQL。
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

    assert.deepEqual(out.previewPorts, { requested: 10, created: 10, skipped: 0 }, '返回值必须带上本次新写条数（CLI 输出与验收都看它）');
    const mine = store.rows.filter((r) => r.fde_id === 'u-alice');
    assert.equal(mine.length, 10, 'provision 必须一次写满 10 行');
    assert.deepEqual(mine.map((r) => r.port), PREVIEW_PORTS);
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

    // ③ 同事务：派生链必须与写库同事务，且顺序是「route 在前、materialize 在后」（与 offboarding.js 同范式）。
    //    本用例的 fde_networks 走「已有活跃网络」早退分支 ⇒ 唯一的 route/materialize 来源就是预览域名。
    const seq = client.seq;
    const firstRouteRev = seq.findIndex((x) => x.startsWith('INSERT INTO route_revisions'));
    const firstRouteOutbox = seq.findIndex((x) => x.startsWith('INSERT INTO route_outbox'));
    const firstMatRev = seq.findIndex((x) => x.startsWith('INSERT INTO materialize_revisions'));
    const firstMatOutbox = seq.findIndex((x) => x.startsWith('INSERT INTO materialize_outbox'));
    const insertCount = seq.filter((x) => x.startsWith('INSERT INTO port_allocations')).length;
    const commitIdx = seq.lastIndexOf('COMMIT');
    assert.equal(insertCount, 10, '事务内 10 条 INSERT');
    assert.ok(firstRouteRev > 0 && firstRouteOutbox > firstRouteRev, 'route revision head 必须先于 route outbox 行');
    assert.ok(firstMatRev > firstRouteOutbox, 'route outbox 必须先于 materialize revision head');
    assert.ok(firstMatOutbox > firstMatRev, 'materialize revision head 必须先于 materialize outbox 行');
    assert.ok(firstMatOutbox < commitIdx, '派生链入队必须在 COMMIT 之前（同事务，禁止 COMMIT 后补入队）');
    assert.equal(seq.filter((x) => x.startsWith('INSERT INTO route_revisions')).length, 10, '每条新 allocation 一条 route outbox');
    assert.equal(seq.filter((x) => x.startsWith('INSERT INTO materialize_revisions')).length, 1, 'materialize 聚合是每 FDE 一条');

    assert.equal(client.outbox.route.length, 10);
    assert.deepEqual(client.outbox.route.map((r) => r.aggregate), Array(10).fill('port_allocation'));
    assert.deepEqual(client.outbox.route.map((r) => r.op), Array(10).fill('upsert'));
    assert.deepEqual(client.outbox.route.map((r) => r.aggregateId), store.inserted.map((r) => r.id),
      'aggregate_id = port_allocations.id（schema.sql §9 对该聚合的口径）');
    assert.deepEqual(client.outbox.route[0].payload, { fde_name: 'alice', hostname: 'alice-p-4000.fde.erix.vip', port: 4000, scope: 'fde' });
    assert.equal(client.outbox.materialize.length, 1);
    assert.equal(client.outbox.materialize[0].fdeId, 'u-alice');
    assert.equal(client.outbox.materialize[0].op, 'upsert');
    assert.deepEqual(client.outbox.materialize[0].payload.ports, PREVIEW_PORTS);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ② 幂等
// ---------------------------------------------------------------------------
test('② 幂等：10 条已齐备时二次调用零插入，且一个 outbox 字节都不写', async () => {
  const store = makeStore();
  const seq = [];
  const first = makeClient(store, { seq });
  const out1 = await ensureFdePreviewPorts(first, { fdeId: 'u1', fdeName: 'alice', baseDomain: BASE, publicBaseUrl: PUBLIC_BASE });
  assert.equal(out1.inserted.length, 10);
  assert.equal(out1.materializeRevision, 1);

  const secondSeq = [];
  const second = makeClient(store, { seq: secondSeq });
  const out2 = await ensureFdePreviewPorts(second, { fdeId: 'u1', fdeName: 'alice', baseDomain: BASE, publicBaseUrl: PUBLIC_BASE });
  assert.equal(out2.inserted.length, 0, '二次调用必须零插入（幂等判据 = 部分唯一索引 + DO NOTHING）');
  assert.equal(out2.skipped, 10);
  assert.equal(out2.materializeRevision, null, '零插入时不得空转 materialize revision（否则每轮开户都重写一遍派生文件）');
  assert.deepEqual(second.outbox.route, [], '零插入时不得写 route outbox');
  assert.deepEqual(second.outbox.materialize, [], '零插入时不得写 materialize outbox');
  assert.equal(secondSeq.filter((x) => x.startsWith('INSERT INTO port_allocations')).length, 10, '仍然逐条 INSERT（靠 DO NOTHING 判重，不是先查后插）');
  assert.equal(store.rows.length, 10, '总行数不变');
});

test('② 缺口补齐：缺 3 条只补 3 条（含「窗口内已有遗留 project 行也算已存在」）', async () => {
  // 真机形态：eric 有 4000/4008（P5 之前手工插的 scope='project' + role='frontend'）、
  // tetris 另有 4100（窗口外）。遗留行既不改也不删，窗口内的端口算已存在。
  const store = makeStore([
    { fde_id: 'u1', scope: 'project', port: 4000, role: 'frontend', hostname: 'alice-p-4000.fde.erix.vip', url: 'http://alice-p-4000.fde.erix.vip:8090', exposure: 'private', state: 'active' },
    { fde_id: 'u1', scope: 'project', port: 4005, role: 'frontend', hostname: 'alice-p-4005.fde.erix.vip', url: 'http://alice-p-4005.fde.erix.vip:8090', exposure: 'private', state: 'active' },
    { fde_id: 'u1', scope: 'project', port: 4009, role: 'backend', hostname: 'alice-p-4009.fde.erix.vip', url: 'http://alice-p-4009.fde.erix.vip:8090', exposure: 'private', state: 'active' },
    { fde_id: 'u1', scope: 'project', port: 4100, role: 'backend', hostname: 'alice-p-4100.fde.erix.vip', url: 'http://alice-p-4100.fde.erix.vip:8090', exposure: 'private', state: 'active' },
  ]);
  const seq = [];
  const client = makeClient(store, { seq });
  const out = await ensureFdePreviewPorts(client, { fdeId: 'u1', fdeName: 'alice', baseDomain: BASE, publicBaseUrl: PUBLIC_BASE });

  assert.equal(out.inserted.length, 7, '窗口内 3 个端口已有行 ⇒ 只补 4001/4002/4003/4004/4006/4007/4008');
  assert.deepEqual(out.inserted.map((r) => r.port), [4001, 4002, 4003, 4004, 4006, 4007, 4008]);
  assert.equal(out.skipped, 3);
  // 新写的行一律 scope='fde'（遗留行保持 scope='project'）
  assert.deepEqual([...new Set(store.inserted.map((r) => r.scope))], ['fde']);
  // 遗留行：不改、不删、不回填（routes.js:382 只看 state 与 hostname，遗留行继续有效）
  assert.deepEqual(store.updated, [], '不得 UPDATE 任何既有 allocation');
  assert.deepEqual(store.deleted, [], '不得 DELETE 任何既有 allocation');
  const legacy = store.rows.filter((r) => r.scope === 'project');
  assert.deepEqual(legacy.map((r) => r.port).sort((a, b) => a - b), [4000, 4005, 4009, 4100], '4 条遗留行原样在库（含窗口外的 4100）');
  assert.deepEqual([...new Set(legacy.map((r) => r.state))], ['active']);
  assert.equal(store.rows.length, 11, '4 条遗留 + 7 条新写');
  assert.equal(client.outbox.route.length, 7, '只为真正新增的行入队路由');
  assert.equal(client.outbox.materialize.length, 1);
});

test('② released 行不算「已存在」：部分唯一索引只覆盖 state <> released ⇒ 释放后重分配插新行', async () => {
  const store = makeStore([
    { fde_id: 'u1', scope: 'fde', port: 4003, role: 'spare', hostname: 'alice-p-4003.fde.erix.vip', url: 'http://alice-p-4003.fde.erix.vip:8090', exposure: 'private', state: 'released', released_at: new Date('2026-10-01T00:00:00Z') },
  ]);
  const client = makeClient(store);
  const out = await ensureFdePreviewPorts(client, { fdeId: 'u1', fdeName: 'alice', baseDomain: BASE, publicBaseUrl: PUBLIC_BASE });
  assert.deepEqual(out.inserted.map((r) => r.port), PREVIEW_PORTS, '4003 的 released 行不占位，10 条全插');
  assert.equal(store.rows.filter((r) => r.port === 4003).length, 2, '软删除留档 + 新行并存');
});

// ---------------------------------------------------------------------------
// ③ 独立事务包装：顺序 / 原子性
// ---------------------------------------------------------------------------
test('③ provisionFdePreviewPorts：BEGIN → 10×(route head + outbox) → materialize head + outbox → COMMIT 逐序', async () => {
  const store = makeStore();
  const seq = [];
  const client = makeClient(store, { seq });
  await provisionFdePreviewPorts(makePool(client), CONFIG, { fdeId: 'u1', fdeName: 'alice', log: { log() {}, warn() {} } });
  assert.deepEqual(seq, [
    'BEGIN',
    'INSERT INTO port_allocations',
    'INSERT INTO port_allocations',
    'INSERT INTO port_allocations',
    'INSERT INTO port_allocations',
    'INSERT INTO port_allocations',
    'INSERT INTO port_allocations',
    'INSERT INTO port_allocations',
    'INSERT INTO port_allocations',
    'INSERT INTO port_allocations',
    'INSERT INTO port_allocations',
    ...Array.from({ length: 10 }, (_, i) => [
      `INSERT INTO route_revisions`,
      `INSERT INTO route_outbox`,
    ]).flat(),
    'INSERT INTO materialize_revisions',
    'INSERT INTO materialize_outbox',
    'COMMIT',
  ], '事务内顺序必须逐条一致（派生链与写库同事务，且 route 先、materialize 后）');
});

test('③ 入队失败 → ROLLBACK：不留「行已写、派生链永不重算」的半截状态', async () => {
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

// ---------------------------------------------------------------------------
// 边界：FDE 名超长 / 缺参
// ---------------------------------------------------------------------------
test('FDE 名超预览域名预算（#202）→ preview_hostname_invalid，一条都不写', async () => {
  const store = makeStore();
  const client = makeClient(store);
  const long = 'a'.repeat(57); // 57 + "-p-" + 4 = 64 > 63
  await assert.rejects(
    () => ensureFdePreviewPorts(client, { fdeId: 'u1', fdeName: long, baseDomain: BASE, publicBaseUrl: PUBLIC_BASE }),
    (err) => err.code === 'preview_hostname_invalid' && /56/.test(err.message),
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
  await ensureFdePreviewPorts(client, { fdeId: 'u1', fdeName: 'alice', baseDomain: BASE });
  assert.equal(store.rows[0].url, 'https://alice-p-4000.fde.erix.vip');
});
