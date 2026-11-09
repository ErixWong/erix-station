// issue #474 S3 一期补充：**记账锁存**（主 agent 复审发现的缺陷：持续漂移会每 60s 刷一行审计 + 一条 warn）。
// 这一组只盯一件事：**变化才记**——同一形状连跑 N 轮 = 1 行；形状变了 = 再加 1 行；恢复 = 1 行 cleared；
// 不传 state = 每轮都记（锁住「单次调用语义」，防止有人把跨轮记忆塞进纯函数 checkDynamicFileDrift）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUDIT_DRIFT,
  AUDIT_DRIFT_CLEARED,
  MANAGED_MODES,
  computeDesiredDynamicFiles,
  createDriftLatch,
  driftSignature,
  runDriftRound,
  startRouteDriftMonitor,
} from '../src/routesdrift.js';

const CANARY = 'sk-CANARY-latch-4f0a11';

const CFG = {
  baseDomain: 'fde.test',
  portalHost: 'station.fde.test',
  adminHost: 'admin.fde.test',
  llmHost: 'llm.fde.test',
  portalBackendUrl: 'http://127.0.0.1:18080',
  llmGatewayUrl: 'http://station-litellm:4000',
  traefikEntryPoint: 'web',
  traefikAdminEntryPoint: 'adminsecure',
  traefikDynamicFile: 'routes.yml',
  traefikLlmDynamicFile: 'llm-routes.yml',
};

const ALLOC_ROW = { id: 'pa1', fde_id: 'u1', hostname: 'alice-p-22000.fde.test', port: 22000, subnet: '10.200.1.0/29', fde_name: 'alice' };
const BINDING = { fde_id: 'u1', api_key: CANARY, fde_name: 'alice', subnet: '10.200.1.0/29' };

function mkPool({ bindings = [], allocations = [], networks = [{ fde_id: 'u1', subnet: '10.200.1.0/29', fde_name: 'alice' }] } = {}) {
  return {
    sqlLog: [],
    async query(sql, params = []) {
      this.sqlLog.push({ sql, params });
      if (sql.includes('FROM fde_networks')) return { rows: networks };
      if (sql.includes('FROM fde_llm_bindings b')) return { rows: bindings };
      if (sql.includes('FROM port_allocations')) return { rows: allocations };
      return { rows: [] };
    },
  };
}

function mkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'driftlatch-'));
}

function captureLog() {
  const lines = [];
  return { lines, log: { warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) } };
}

/** 审计行数（按 action 分），并且顺手证明：任何一条都不含正文里的 canary。 */
function audits(pool, action = null) {
  const rows = pool.sqlLog
    .filter((e) => String(e.sql).includes('INSERT INTO audit_log'))
    .map((e) => ({ action: e.params[1], target: e.params[2], details: JSON.parse(e.params[3]), raw: e.params[3] }));
  const all = rows.map((r) => r.raw).join('|');
  assert.ok(!all.includes(CANARY), `审计 details 里出现了 key 明文：${all.slice(0, 200)}`);
  return action === null ? rows : rows.filter((r) => r.action === action);
}

/** 把期望态原样落盘（算不出来就抛——「零 finding」不能是假的绿）。 */
async function publishExpected(dir, pool, config) {
  const { expected } = await computeDesiredDynamicFiles({ pool, config: { ...config, traefikDynamicDir: dir } });
  for (const [name, exp] of Object.entries(expected)) {
    const target = path.join(dir, name);
    if (exp.bytes === null) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      continue;
    }
    fs.writeFileSync(target, exp.bytes, { mode: exp.mode });
    fs.chmodSync(target, exp.mode);
  }
  return expected;
}

test('锁存：同一份漂移连跑 3 轮 ⇒ 审计 1 行、warn 1 条（不是一行一轮）', async () => {
  const dir = mkDir();
  const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  await publishExpected(dir, pool, CFG);
  fs.writeFileSync(path.join(dir, 'routes.yml'), 'http:\n  routers:\n    hijack: {rule: Host(`x.fde.test`)}\n', { mode: 0o644 });
  const state = createDriftLatch();
  const { lines, log } = captureLog();
  for (let i = 0; i < 3; i += 1) {
    const out = await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log, state });
    assert.equal(out.skipped, false);
    assert.equal(out.findings.length, 1, `第 ${i + 1} 轮本该仍报这一条漂移`);
  }
  assert.equal(audits(pool).length, 1, '同一形状 ⇒ 只有第一轮写审计');
  assert.equal(lines.filter((m) => m.includes('routes.yml')).length, 1, lines.join(' | '));
  assert.equal(audits(pool, AUDIT_DRIFT).length, 1);
  assert.equal(audits(pool, AUDIT_DRIFT_CLEARED).length, 0);
  assert.deepEqual(audits(pool)[0].details, {
    file: 'routes.yml',
    kind: 'bytes',
    stage: 'bytes',
    sha_before8: audits(pool)[0].details.sha_before8,
    sha_after8: audits(pool)[0].details.sha_after8,
    bytes: audits(pool)[0].details.bytes,
  }, 'detected 的 details 字段集合不变（锁存不改字段口径）');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('锁存：漂移形状变了（字节再变一次 / mode 再变一次）⇒ 各新增 1 行', async () => {
  const dir = mkDir();
  const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  await publishExpected(dir, pool, CFG);
  const target = path.join(dir, 'routes.yml');
  const state = createDriftLatch();
  const { lines, log } = captureLog();

  fs.writeFileSync(target, 'http:\n  routers:\n    a: 1\n', { mode: 0o644 });
  await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log, state });
  assert.equal(audits(pool).length, 1);
  await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log, state });
  assert.equal(audits(pool).length, 1, '没变 ⇒ 不加行');

  fs.writeFileSync(target, 'http:\n  routers:\n    b: 2\n', { mode: 0o644 });
  await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log, state });
  assert.equal(audits(pool).length, 2, '字节又变了一次 ⇒ 新签名 ⇒ 新行');

  fs.chmodSync(target, 0o600);
  await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log, state });
  assert.equal(audits(pool).length, 3, 'mode 从 644 变 600 是另一种形状（modeActual 在签名里）');
  assert.equal(audits(pool)[2].details.stage, 'mode');
  assert.equal(audits(pool)[2].details.mode_actual, '600');
  assert.equal(lines.length, 3, `3 条 warn：${lines.join(' | ')}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('恢复：上一轮有、本轮干净 ⇒ 一条 cleared + 一条 warn；再跑一轮零新增', async () => {
  const dir = mkDir();
  const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  const expected = await publishExpected(dir, pool, CFG);
  const target = path.join(dir, 'llm-routes.yml');
  const state = createDriftLatch();
  const { lines, log } = captureLog();

  fs.appendFileSync(target, '\n# touched\n');
  await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log, state });
  assert.equal(audits(pool, AUDIT_DRIFT).length, 1);
  assert.deepEqual(audits(pool, AUDIT_DRIFT_CLEARED), [], '还没恢复，不该有 cleared');

  fs.writeFileSync(target, expected['llm-routes.yml'].bytes, { mode: MANAGED_MODES['llm-routes.yml'] });
  const clearedLines = lines.length;
  await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log, state });
  const cleared = audits(pool, AUDIT_DRIFT_CLEARED);
  assert.equal(cleared.length, 1, '恢复只记一行');
  assert.deepEqual(cleared[0].details, {
    file: 'llm-routes.yml',
    stage: 'recovered',
    previous: { kind: 'bytes', sha_after8: cleared[0].details.previous.sha_after8 },
  }, 'cleared 的 details 只允许这三个键（previous 里也只有 kind + sha，没有正文）');
  assert.equal(cleared[0].details.previous.kind, 'bytes');
  assert.equal(cleared[0].target, 'llm-routes.yml');
  assert.equal(lines.length, clearedLines + 1, `恢复只多说一条 warn：${lines.slice(clearedLines).join(' | ')}`);
  assert.ok(lines[clearedLines].includes('已消失') && !lines[clearedLines].includes(CANARY), lines[clearedLines]);
  assert.ok(!lines[clearedLines].includes('# touched'), '恢复的 warn 里也不许出现正文片段');

  const before = audits(pool).length;
  await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log, state });
  assert.equal(audits(pool).length, before, '仍干净 ⇒ 零新增（cleared 不能每轮刷）');
  assert.equal(lines.length, clearedLines + 1, '干净轮不再说话');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('未纳管 yml：集合不变只 warn 一次；集合变了再 warn；全消失再 warn 一次', async () => {
  const dir = mkDir();
  const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  await publishExpected(dir, pool, CFG);
  const state = createDriftLatch();
  const { lines, log } = captureLog();
  const cfg = { ...CFG, traefikDynamicDir: dir };

  fs.writeFileSync(path.join(dir, 'routes-lan.yml'), 'http:\n  routers: {}\n', { mode: 0o644 });
  for (let i = 0; i < 3; i += 1) await runDriftRound({ pool, config: cfg, log, state });
  assert.equal(lines.filter((m) => m.includes('未纳管')).length, 1, `集合没变只该说一句：${lines.join(' | ')}`);
  assert.equal(audits(pool).length, 0, '未知 yml 不写审计（一期它不是受管对象）');

  fs.writeFileSync(path.join(dir, 'extra.yml'), 'http:\n  routers: {}\n', { mode: 0o644 });
  await runDriftRound({ pool, config: cfg, log, state });
  assert.equal(lines.filter((m) => m.includes('未纳管')).length, 2, '集合变了要再说一次');
  assert.ok(lines.some((m) => m.includes('extra.yml')));

  fs.rmSync(path.join(dir, 'routes-lan.yml'));
  fs.rmSync(path.join(dir, 'extra.yml'));
  await runDriftRound({ pool, config: cfg, log, state });
  assert.ok(lines.some((m) => m.includes('已全部消失')), `消失也要报一次：${lines.join(' | ')}`);
  const after = lines.length;
  await runDriftRound({ pool, config: cfg, log, state });
  assert.equal(lines.length, after, '消失只报一次，不每轮刷');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('不传 state ⇒ 单次调用语义（每轮都 warn、每轮都审计）', async () => {
  const dir = mkDir();
  const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  await publishExpected(dir, pool, CFG);
  fs.appendFileSync(path.join(dir, 'routes.yml'), '\n# hand edit\n');
  const { lines, log } = captureLog();
  for (let i = 0; i < 3; i += 1) {
    const out = await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log });
    assert.equal(out.findings.length, 1);
  }
  assert.equal(audits(pool).length, 3, '不传 state 就是「这次调用报一次」，不许偷偷锁存');
  assert.equal(lines.filter((m) => m.includes('routes.yml')).length, 3);
  // 纯函数侧也锁一遍：跨轮记忆只能在调用方手里。
  const src = fs.readFileSync(new URL('../src/routesdrift.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function checkDynamicFileDrift'), src.indexOf('export function driftSignature'));
  assert.ok(!/\bcreateDriftLatch\(\)|let last|const last|module\.exports\./.test(body),
    'checkDynamicFileDrift 里不得出现跨轮状态（必须是纯函数）');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('monitor 端到端：同一个 monitor 跑 3 拍 ⇒ 1 行审计；改回干净 ⇒ 1 行 cleared', async () => {
  const dir = mkDir();
  const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  const expected = await publishExpected(dir, pool, CFG);
  const { lines, log } = captureLog();
  const monitor = startRouteDriftMonitor(pool, { ...CFG, traefikDynamicDir: dir }, { log, intervalMs: 10_000 });
  try {
    fs.appendFileSync(path.join(dir, 'routes.yml'), '\n# hand edit\n');
    await monitor.tick();
    await monitor.tick();
    await monitor.tick();
    assert.equal(audits(pool, AUDIT_DRIFT).length, 1, lines.join(' | '));
    assert.equal(audits(pool, AUDIT_DRIFT_CLEARED).length, 0);
    fs.writeFileSync(path.join(dir, 'routes.yml'), expected['routes.yml'].bytes, { mode: MANAGED_MODES['routes.yml'] });
    await monitor.tick();
    assert.equal(audits(pool, AUDIT_DRIFT_CLEARED).length, 1);
  } finally {
    monitor.stop();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('签名口径：字段固定且不含正文；同一形状在两台机器上也得是同一个串', () => {
  const f = {
    file: 'llm-routes.yml',
    kind: 'metadata',
    stage: 'mode',
    sha_before8: 'aaaaaaaa',
    sha_after8: 'bbbbbbbb',
    bytes: 412,
    modeExpected: '600',
    modeActual: '644',
  };
  assert.equal(driftSignature(f), 'metadata|mode|aaaaaaaa|bbbbbbbb|644|');
  assert.ok(!driftSignature({ ...f, peek: `${CANARY}\ntls: {}` }).includes(CANARY), '多余字段不许混进签名');
  assert.notEqual(driftSignature({ ...f, modeActual: '600' }), driftSignature(f), 'modeActual 必须在签名里（否则 mode 变了会被当成同一条）');
  assert.notEqual(driftSignature({ ...f, sha_after8: 'cccccccc' }), driftSignature(f), 'sha_after8 必须在签名里');
});
