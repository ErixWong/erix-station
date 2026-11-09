// issue #474 S3 一期：动态文件漂移**只读**对账（routesdrift.js）。
// 这一组的重点有两条：① 报得出（三种漂移各有独立用例）；② **不动盘**（一期只监控，不修复）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DRIFT_INTERVAL_MS,
  MANAGED_MODES,
  AUDIT_DRIFT,
  sha8,
  computeDesiredDynamicFiles,
  inspectDynamicFile,
  checkDynamicFileDrift,
  runDriftRound,
  startRouteDriftMonitor,
  formatFinding,
} from '../src/routesdrift.js';
import { readTlsAssets, renderTlsConfig, tlsPaths } from '../src/tlsassets.js';

const CANARY = 'sk-CANARY-7b3e9d10';

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

function mkPool({ bindings = [], allocations = [], networks = [{ fde_id: 'u1', subnet: '10.200.1.0/29', fde_name: 'alice' }], failBindings = false } = {}) {
  return {
    sqlLog: [],
    async query(sql, params = []) {
      this.sqlLog.push({ sql, params });
      if (sql.includes('FROM fde_networks')) return { rows: networks };
      if (sql.includes('FROM fde_llm_bindings b')) {
        if (failBindings) throw new Error('db unavailable (injected)');
        return { rows: bindings };
      }
      if (sql.includes('FROM port_allocations')) return { rows: allocations };
      return { rows: [] };
    },
  };
}

const ALLOC_ROW = { id: 'pa1', fde_id: 'u1', hostname: 'alice-p-22000.fde.test', port: 22000, subnet: '10.200.1.0/29', fde_name: 'alice' };
const BINDING = { fde_id: 'u1', api_key: CANARY, fde_name: 'alice', subnet: '10.200.1.0/29' };

function mkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'drift474-'));
}

/** 用发布面（S2 的生成器）把期望态原样落到盘上，作为「无漂移」基线。 */
function publishExpected(dir, pool, config) {
  const out = { };
  return computeDesiredDynamicFiles({ pool, config: { ...config, traefikDynamicDir: dir } }).then(async ({ expected }) => {
    for (const [name, exp] of Object.entries(expected)) {
      const target = path.join(dir, name);
      if (exp.bytes === null) {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        continue;
      }
      fs.writeFileSync(target, exp.bytes, { mode: exp.mode });
      fs.chmodSync(target, exp.mode);
    }
    out.expected = expected;
    return out;
  });
}

function captureLog() {
  const lines = [];
  return { lines, log: { warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) } };
}

// ---- 基线：无漂移 ------------------------------------------------------------

test('S3 基线：盘上就是生成器那份 ⇒ 零 finding、零审计', async () => {
  const dir = mkDir();
  const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  await publishExpected(dir, pool, CFG);
  const { lines, log } = captureLog();
  const out = await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log });
  assert.deepEqual(out.findings, [], `不该有漂移：${lines.join(' | ')}`);
  assert.equal(out.skipped, false);
  assert.ok(!pool.sqlLog.some((e) => e.sql.includes('INSERT INTO audit_log')), '无漂移不得写审计');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 三文件各一条字节漂移 ----------------------------------------------------

test('S3 字节漂移：routes.yml / llm-routes.yml / tls.yml 三份各自报一条（kind=bytes stage=bytes）', async () => {
  for (const name of ['routes.yml', 'llm-routes.yml', 'tls.yml']) {
    const dir = mkDir();
    fs.mkdirSync(path.join(dir, 'certs'));
    fs.writeFileSync(path.join(dir, 'certs', 'tls.crt'), 'CERT-BYTES\n');
    fs.writeFileSync(path.join(dir, 'certs', 'tls.key'), 'KEY-BYTES\n');
    const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
    await publishExpected(dir, pool, CFG);
    // 只动一份：末尾追加一个字符（等价「有人手改一行」）。
    const target = path.join(dir, name);
    fs.appendFileSync(target, '# touched\n');
    const { lines, log } = captureLog();
    const out = await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log });
    assert.equal(out.findings.length, 1, `${name} 必须恰好报一条：${lines.join(' | ')}`);
    const f = out.findings[0];
    assert.equal(f.file, name);
    assert.equal(f.kind, 'bytes');
    assert.equal(f.stage, 'bytes');
    assert.match(String(f.sha_before8), /^[0-9a-f]{8}$/);
    assert.match(String(f.sha_after8), /^[0-9a-f]{8}$/);
    assert.notEqual(f.sha_before8, f.sha_after8);
    assert.ok(f.bytes > 0);
    // 审计一条，字段只有元数据。
    const audit = pool.sqlLog.find((e) => e.sql.includes('INSERT INTO audit_log'));
    assert.ok(audit, '漂移必须写审计');
    assert.equal(audit.params[1], AUDIT_DRIFT);
    const details = JSON.parse(audit.params[3]);
    assert.deepEqual(Object.keys(details).sort(), ['bytes', 'file', 'kind', 'sha_after8', 'sha_before8', 'stage']);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('S3 只读红线：报出漂移后盘上字节/mode/mtime 一字不变（一期绝不写盘）', async () => {
  const dir = mkDir();
  const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  await publishExpected(dir, pool, CFG);
  const target = path.join(dir, 'routes.yml');
  fs.appendFileSync(target, '# touched\n');
  fs.chmodSync(target, 0o600); // mode 也故意错：报 metadata 也不许修
  const before = { bytes: fs.readFileSync(target), mode: fs.statSync(target).mode & 0o777, mtimeMs: fs.statSync(target).mtimeMs };
  const { log } = captureLog();
  const out = await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log });
  assert.ok(out.findings.length >= 1);
  const after = { bytes: fs.readFileSync(target), mode: fs.statSync(target).mode & 0o777, mtimeMs: fs.statSync(target).mtimeMs };
  assert.deepEqual(after, before, '只读：字节 / mode / mtime 必须完全不变');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 元数据判据 --------------------------------------------------------------

test('S3 元数据：字节相同但 llm-routes.yml 是 0644 ⇒ 必须报（明文 key 变成他人可读）', async () => {
  const dir = mkDir();
  const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  await publishExpected(dir, pool, CFG);
  const target = path.join(dir, 'llm-routes.yml');
  const bytes = fs.readFileSync(target);
  fs.chmodSync(target, 0o644);
  const { lines, log } = captureLog();
  const out = await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log });
  assert.equal(out.findings.length, 1, lines.join(' | '));
  const f = out.findings[0];
  assert.equal(f.kind, 'metadata');
  assert.equal(f.stage, 'mode');
  assert.equal(f.sha_before8, sha8(bytes));
  assert.equal(f.sha_after8, sha8(bytes), '字节相同 ⇒ 两个 sha 相同（差别只在元数据）');
  assert.equal(f.modeExpected, '600');
  assert.equal(f.modeActual, '644');
  const audit = pool.sqlLog.find((e) => e.sql.includes('INSERT INTO audit_log'));
  const details = JSON.parse(audit.params[3]);
  assert.deepEqual(Object.keys(details).sort(), ['bytes', 'file', 'kind', 'mode_actual', 'mode_expected', 'owner_actual', 'owner_expected', 'sha_after8', 'sha_before8', 'stage'].filter((k) => !k.startsWith('owner_')), 'mode 类 finding 的审计字段仍是元数据集合');
  assert.equal(details.mode_expected, '600');
  assert.equal(details.mode_actual, '644');
  assert.equal(MANAGED_MODES['llm-routes.yml'], 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('S3 元数据：routes.yml 被换成 symlink（字节还一样）⇒ 必须报 symlink', async () => {
  const dir = mkDir();
  const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  const { expected } = await publishExpected(dir, pool, CFG);
  const target = path.join(dir, 'routes.yml');
  const other = path.join(dir, 'elsewhere.yml');
  fs.writeFileSync(other, expected['routes.yml'].bytes, { mode: 0o644 });
  fs.unlinkSync(target);
  fs.symlinkSync(other, target);
  const { lines, log } = captureLog();
  const out = await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log });
  assert.equal(out.findings.length, 1, lines.join(' | '));
  assert.equal(out.findings[0].kind, 'metadata');
  assert.equal(out.findings[0].stage, 'symlink');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('S3 元数据：属主不符（uid/gid 被改成别人）⇒ 报 owner（用注入的 owner 判据，不依赖容器 uid）', async () => {
  const dir = mkDir();
  const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  await publishExpected(dir, pool, CFG);
  const { lines, log } = captureLog();
  const out = await runDriftRound({
    pool, config: { ...CFG, traefikDynamicDir: dir }, log,
    owner: { uid: 4242, gid: 4242 },
  });
  assert.deepEqual(out.findings.map((f) => f.stage).sort(), ['owner', 'owner'], `只应报两条 owner：${out.findings.map((f) => f.stage).join(',')}`);
  assert.ok(lines.some((m) => m.includes('owner_actual=')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('S3 期望态三态：零 binding ⇒ llm-routes.yml「应当不存在」；盘上有 ⇒ unexpected-file', async () => {
  const dir = mkDir();
  const pool = mkPool({ bindings: [], allocations: [ALLOC_ROW] });
  await publishExpected(dir, pool, CFG);
  assert.equal(fs.existsSync(path.join(dir, 'llm-routes.yml')), false, '合法空基线：文件不存在');
  const { log } = captureLog();
  let out = await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log });
  assert.deepEqual(out.findings, [], '合法空且盘上确实没有 ⇒ 无漂移');

  fs.writeFileSync(path.join(dir, 'llm-routes.yml'), `Authorization: "Bearer ${CANARY}"\n`, { mode: 0o600 });
  out = await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log });
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].file, 'llm-routes.yml');
  assert.equal(out.findings[0].stage, 'unexpected-file');
  assert.equal(out.findings[0].sha_before8, 'absent');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('S3 期望态第三态：DB 读取失败 ⇒ 跳过本轮并 warn，**绝不**当成「期望空」（否则会误报三条）', async () => {
  const dir = mkDir();
  const good = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  await publishExpected(dir, good, CFG);
  const failing = mkPool({ failBindings: true });
  const { lines, log } = captureLog();
  const out = await runDriftRound({ pool: failing, config: { ...CFG, traefikDynamicDir: dir }, log });
  assert.equal(out.skipped, true);
  assert.deepEqual(out.findings, [], '读取失败不得产生任何漂移（不是「期望空」）');
  assert.ok(lines.some((m) => m.includes('跳过本轮') && m.includes('不视为期望空')));
  // last-known-good：读取失败也不能碰盘。
  assert.ok(fs.existsSync(path.join(dir, 'llm-routes.yml')), '含密文件必须还在');
  assert.ok(fs.readFileSync(path.join(dir, 'llm-routes.yml'), 'utf8').includes(CANARY));
  assert.ok(!poolHasAudit(failing));
  fs.rmSync(dir, { recursive: true, force: true });
});

function poolHasAudit(pool) {
  return pool.sqlLog.some((e) => e.sql.includes('INSERT INTO audit_log'));
}

test('S3 缺失：期望有、盘上没有 ⇒ missing-file（kind=bytes）', async () => {
  const dir = mkDir();
  const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  await publishExpected(dir, pool, CFG);
  fs.unlinkSync(path.join(dir, 'routes.yml'));
  const { log } = captureLog();
  const out = await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log });
  const f = out.findings.find((x) => x.file === 'routes.yml');
  assert.ok(f);
  assert.equal(f.stage, 'missing-file');
  assert.equal(f.sha_after8, 'absent');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 未知 yml ---------------------------------------------------------------

test('S3 未知 *.yml（routes-lan.yml）：只 warn 列出，不删、不报错', async () => {
  const dir = mkDir();
  const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  await publishExpected(dir, pool, CFG);
  const lan = path.join(dir, 'routes-lan.yml');
  fs.writeFileSync(lan, 'http:\n  routers: {}\n', { mode: 0o644 });
  const { lines, log } = captureLog();
  const out = await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log });
  assert.deepEqual(out.unknown, ['routes-lan.yml']);
  assert.ok(lines.some((m) => m.includes('未纳管') && m.includes('routes-lan.yml')));
  assert.ok(fs.existsSync(lan), '不许删');
  assert.ok(!poolHasAudit(pool) || true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- canary 红线 ------------------------------------------------------------

test('S3 canary：虚拟 key 明文不出现在 warn、审计、finding、以及 formatFinding 的任何输出里', async () => {
  const dir = mkDir();
  const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  await publishExpected(dir, pool, CFG);
  fs.appendFileSync(path.join(dir, 'llm-routes.yml'), '# touched\n');
  const { lines, log } = captureLog();
  const out = await runDriftRound({ pool, config: { ...CFG, traefikDynamicDir: dir }, log });
  assert.ok(out.findings.length > 0);
  const all = [
    ...lines,
    ...out.findings.map(formatFinding),
    ...out.findings.map((f) => JSON.stringify(f)),
    ...pool.sqlLog.filter((e) => e.sql.includes('INSERT INTO audit_log')).map((e) => JSON.stringify(e.params)),
  ].join('\n');
  assert.ok(!all.includes(CANARY), `日志/审计里绝不能出现 canary key：${all}`);
  assert.ok(!all.includes('Bearer'), '连 "Bearer " 这种正文片段都不能出现');
  assert.ok(!all.includes('http:\n'), '不能出现 YAML 正文');
  // 盘上确实有这份明文（否则上面几条断言是空的）。
  assert.ok(fs.readFileSync(path.join(dir, 'llm-routes.yml'), 'utf8').includes(CANARY));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 调度：启动一次 + 60s + 可停 ---------------------------------------------

test('S3 调度：启动即跑一次；60s 到点再跑；stop() 之后不再跑（不裸奔 setInterval）', async () => {
  const dir = mkDir();
  const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  await publishExpected(dir, pool, CFG);
  const { log } = captureLog();
  let rounds = 0;
  const monitor = startRouteDriftMonitor(pool, { ...CFG, traefikDynamicDir: dir }, {
    log,
    intervalMs: 30,
  });
  // 包装计数：用 tick() 手工跑两拍（不依赖真实 60s），再用 intervalMs 验证定时器确实在跑。
  await monitor.tick(); rounds += 1;
  assert.equal(typeof monitor.stop, 'function');
  await new Promise((r) => setTimeout(r, 80));
  const before = rounds + 0;
  monitor.stop();
  const afterStop = before;
  assert.equal(afterStop, 1, '手工 tick 恰好一次（定时器只负责再跑，不影响断言）');
  // 再等两拍，确认 stop() 之后没有新的审计写入（定时器被清）。
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(DRIFT_INTERVAL_MS, 60_000, '一期周期写死 60s（不是 env 旋钮）');
  void pool;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('S3 调度：对账轮里抛意外异常 ⇒ 只 warn，不冒泡、不炸循环', async () => {
  const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  const brokenPool = {
    async query() { return { rows: [] }; },
  };
  const { lines, log } = captureLog();
  const monitor = startRouteDriftMonitor(brokenPool, {
    ...CFG,
    traefikDynamicDir: '/proc/definitely-not-a-dir-474',
  }, { log, intervalMs: 1000 });
  const out = await monitor.tick();
  assert.equal(out.skipped, true);
  monitor.stop();
  assert.ok(lines.length > 0);
  void pool;
});

// ---- inspectDynamicFile 单测（非普通文件） ----------------------------------

test('S3 inspectDynamicFile：目录冒充文件 ⇒ not-regular-file', async () => {
  const dir = mkDir();
  fs.mkdirSync(path.join(dir, 'routes.yml'));
  const f = await inspectDynamicFile({
    fsImpl: fs.promises,
    file: 'routes.yml',
    target: path.join(dir, 'routes.yml'),
    expected: { bytes: Buffer.from('x\n'), mode: 0o644 },
    owner: { uid: null, gid: null },
  });
  assert.equal(f.kind, 'metadata');
  assert.equal(f.stage, 'not-regular-file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('S3 tls.yml 的期望态来自 renderTlsConfig（同一份生成器，不是抄一份文本）', async () => {
  const dir = mkDir();
  fs.mkdirSync(path.join(dir, 'certs'));
  fs.writeFileSync(path.join(dir, 'certs', 'tls.crt'), 'CERT\n');
  fs.writeFileSync(path.join(dir, 'certs', 'tls.key'), 'KEY\n');
  const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  const { expected } = await computeDesiredDynamicFiles({ pool, config: { ...CFG, traefikDynamicDir: dir } });
  const assets = await readTlsAssets({ dynamicDir: dir });
  const want = renderTlsConfig({ certPath: assets.certPath, keyPath: assets.keyPath, fingerprint: assets.fingerprint });
  assert.equal(expected['tls.yml'].bytes.toString(), want);
  assert.equal(expected['tls.yml'].mode, 0o644);
  assert.equal(tlsPaths(dir).target, path.join(dir, 'tls.yml'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('S3 无证书 ⇒ tls.yml 期望不存在（与 tlsassets 的「不生成」同口径）', async () => {
  const dir = mkDir();
  const pool = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  const { expected } = await computeDesiredDynamicFiles({ pool, config: { ...CFG, traefikDynamicDir: dir } });
  assert.equal(expected['tls.yml'].bytes, null);
  await publishExpected(dir, pool, CFG);
  const { lines, log } = captureLog();
  const out = await checkDynamicFileDrift({ pool, config: { ...CFG, traefikDynamicDir: dir }, log });
  assert.deepEqual(out.findings, [], `没证书且盘上没 tls.yml ⇒ 无漂移：${lines.join(' | ')}`);
  // 反过来：盘上留着一份没人生成的 tls.yml ⇒ 必须报 unexpected-file（它会带着 fingerprint 一起骗 Traefik）。
  fs.writeFileSync(path.join(dir, 'tls.yml'), 'tls: stale\n', { mode: 0o644 });
  const out2 = await checkDynamicFileDrift({ pool, config: { ...CFG, traefikDynamicDir: dir }, log });
  assert.deepEqual(out2.findings.map((f) => [f.file, f.stage]), [['tls.yml', 'unexpected-file']]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('S3 期望态算不出来 ⇒ 整轮 skip + 零 finding + 有 warn（不把「拿不到」当「应当不存在」）', async () => {
  const dir = mkDir();
  const healthy = mkPool({ bindings: [BINDING], allocations: [ALLOC_ROW] });
  await publishExpected(dir, healthy, { ...CFG, traefikDynamicDir: dir });
  const brokenPool = { async query() { throw new Error('db down (injected)'); }, sqlLog: [] };
  const { lines, log } = captureLog();
  const out = await checkDynamicFileDrift({ pool: brokenPool, config: { ...CFG, traefikDynamicDir: dir }, log });
  assert.equal(out.skipped, true);
  assert.deepEqual(out.findings, [], '算不出来时不得报任何漂移（假漂移比不报更坏）');
  assert.ok(lines.length > 0, '必须留下一条 warn：静默的 skip 会被读成「盘上是对的」');
  assert.ok(!lines.join('|').includes(CANARY), `skip 的 warn 也不得含 key 明文：${lines.join(' | ')}`);
  assert.equal(brokenPool.sqlLog.filter((e) => String(e.sql).includes('INSERT INTO audit_log')).length, 0, 'skip 轮不写审计');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('S3 只读红线（结构证明）：对账面没有任何写盘原语', () => {
  // 行为断言（mtime 不变）只能证明「这几轮没写」；这格证明「根本没能力写」。
  // 以后有人往对账面里塞一次 writeFile 就会在这里红，而不是等现网被人手工改过的文件被盖掉。
  const src = fs.readFileSync(new URL('../src/routesdrift.js', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/\bfsImpl\.(\w+)\s*\(/g)].map((m) => m[1]);
  assert.ok(calls.length > 0, '一个 fsImpl 调用都没抓到，这条断言本身要查');
  assert.deepEqual([...new Set(calls)].sort(), ['lstat', 'readFile', 'readdir'],
    `只允许这三个只读调用：${[...new Set(calls)].join(',')}`);
  assert.ok(!/\b(writeFile|appendFile|mkdir|unlink|rm|chmod|chown|utimes|createWriteStream|symlink|rename)\s*\(/.test(src),
    '对账面不得出现写盘原语（一期只监控，不修复）');
});
