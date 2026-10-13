#!/usr/bin/env node
// issue #226 修法第 5 条：**反向测试**。故意把隔离 env 置空/设成共享栈路径，断言护栏**硬失败**——
// 而不是像 #226 之前那样默默对共享 dev 栈动手（假绿 + `rm -rf` 共享库数据目录）。
//
// 跑法与退出码口径（⚠️ 非零码是刻意的，别当失败看）：
//   node portal/integration/isolation-negative.mjs            → 陷阱都如期硬失败：**rc=1**（负例证据本体）
//                                                             → 有陷阱失灵（护栏被改坏/变异）：**rc=2**
//   node portal/integration/isolation-negative.mjs --strict    → 回归/CI 口径：陷阱都硬失败 ⇒ rc=0；
//                                                             有陷阱失灵 ⇒ rc=1
// 无论哪条路径，stderr 都会**逐条点名**被捕获的缺省陷阱文案（STATION_DB_DIR / COMPOSE_PROJECT_NAME）。
//
// ⚠️ 本文件不放 `portal/test/` 或 `runner/test/`，也不用 `.test.js` 结尾：`**/test/**/*.js` 与
// `**/*.test.js` 的发现规则会把它算成 node --test 用例，动测试基线（工单红线）。
// ⚠️ 本脚本**不碰 docker**：removeDbDir 的 docker 执行器是注入的假函数，只记录有没有被调用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHARED_STACK, assertIsolatedEnvironment, defaultFdeIpamPools, deriveFdeIpamPools, removeDbDir, resolveDbDir, writeDynamicStub,
  deriveIsolationComposeEnv, memoizeOnce,
} from './lib/isolated-env.mjs';
// 工单 F（wp2a 重建）：`ports.json ↔ port_allocations` 对账件是 wp2a 最重的断言；提到纯函数后，
// 本脚本可以用夹具**行为面**钉住它（无 docker 环境下也能验「不是恒真」）。
import { reconcilePortsJsonWithDb, PREVIEW_LIVE_STATES } from './lib/ports-reconcile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const STRICT = process.argv.includes('--strict');

/** 一份「合格的隔离栈 env」夹具：负例在它之上逐条抽掉/篡改。 */
function validIsolationEnv() {
  const stackId = 'e2e226';
  return {
    STATION_STACK_ID: stackId,
    COMPOSE_PROJECT_NAME: stackId,
    STATION_DB_DIR: path.join(os.tmpdir(), `station-db-${stackId}-${process.pid}-absent`),
    STATION_DB_NAME: `station-db-${stackId}`,
    STATION_PORTAL_NAME: `station-portal-${stackId}`,
    STATION_DOCKER_PROXY_NAME: `station-docker-proxy-${stackId}`,
    STATION_EDGE_NAME: `station-edge-${stackId}`,
    STATION_LITELLM_NAME: `station-litellm-${stackId}`,
    PORTAL_HOST_PORT: '28080',
    LITELLM_HOST_PORT: '24400',
    TRAEFIK_WEB_PORT: '18090',
    TRAEFIK_WEBSECURE_PORT: '18443',
    LLM_GATEWAY_HOST: 'http://127.0.0.1:24400',
    BACKEND_SUBNET: '172.33.0.0/24',
    FDE_POOL: 'large',
    // #227.3：缺省注入值 = 派生段 + portal large 池固定段（两函数都在 lib，这里不抄字面量）。
    FDE_IPAM_POOLS: defaultFdeIpamPools(stackId),
    FDE_DEV_MODE: '1',
    STATION_PORTAL_IMAGE: `erix-station/portal:${stackId}`,
    STATION_DOCKER_PROXY_IMAGE: `erix-station/fde-proxy:${stackId}`,
    FDE_IMAGE: `erix-station/fde:${stackId}`,
    FDE_NAME: `e2e226alice`,
  };
}

/** 收集「护栏如期抛错」的证据。 */
function expectThrow(label, fn, { namesMustInclude = [] } = {}) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (!thrown) return { label, fired: false, message: '（没抛错——护栏失效）', matched: false };
  const message = String(thrown.message ?? thrown);
  const matched = namesMustInclude.every((needle) => message.includes(needle));
  return { label, fired: true, message, matched };
}

// --- 负例清单（每条都必须硬失败，且文案点名到位）-------------------------------------------
const dockerCalls = [];
const fakeDocker = (args) => {
  dockerCalls.push(args);
  return '';
};

const cases = [];

// 1) STATION_DB_DIR 未设 ⇒ removeDbDir() 必须抛，且**一条 docker 命令都不许发出**
//    （发出去就等于 rm -rf 共享 dev 库数据目录——#226 的那颗定时炸弹）。
{
  const before = dockerCalls.length;
  const result = expectThrow('removeDbDir() 缺省 STATION_DB_DIR', () => removeDbDir(fakeDocker), {
    // 文案必须同时点名：哪个 env 没设 + 缺省路径是谁 + 后果是 rm -rf（“缺省即抛”而不是“缺省默默继续”）。
    namesMustInclude: ['STATION_DB_DIR', 'must be set', SHARED_STACK.dbDir, 'rm -rf'],
  });
  result.dockerSilent = dockerCalls.length === before;
  cases.push(result);
}

// 2) STATION_DB_DIR 未设 ⇒ assertIsolatedEnvironment() 也必须抛并点名 STATION_DB_DIR。
cases.push(expectThrow('assertIsolatedEnvironment() 缺省 STATION_DB_DIR',
  () => assertIsolatedEnvironment({ env: (() => { const e = validIsolationEnv(); delete e.STATION_DB_DIR; return e; })() }),
  { namesMustInclude: ['STATION_DB_DIR'] }));

// 3) COMPOSE_PROJECT_NAME 未设 ⇒ assertIsolatedEnvironment() 必须抛并点名 COMPOSE_PROJECT_NAME。
cases.push(expectThrow('assertIsolatedEnvironment() 缺省 COMPOSE_PROJECT_NAME',
  () => assertIsolatedEnvironment({ env: (() => { const e = validIsolationEnv(); delete e.COMPOSE_PROJECT_NAME; return e; })() }),
  { namesMustInclude: ['COMPOSE_PROJECT_NAME'] }));

// 4) COMPOSE_PROJECT_NAME=station（共享栈的 compose `name:`）⇒ 就算其余 env 齐全也不许放行。
cases.push(expectThrow('assertIsolatedEnvironment() COMPOSE_PROJECT_NAME=station',
  () => assertIsolatedEnvironment({ env: { ...validIsolationEnv(), COMPOSE_PROJECT_NAME: SHARED_STACK.composeProjectName } }),
  { namesMustInclude: ['COMPOSE_PROJECT_NAME'] }));

// 5) STATION_DB_DIR 显式指向共享 dev 库数据目录 ⇒ 不豁免就抛（点名 ERIX_E2E_ALLOW_DB_DIR）。
cases.push(expectThrow(`removeDbDir() STATION_DB_DIR=${SHARED_STACK.dbDir}（未豁免）`,
  () => removeDbDir(fakeDocker, { ...validIsolationEnv(), STATION_DB_DIR: SHARED_STACK.dbDir }),
  { namesMustInclude: [SHARED_STACK.dbDir, 'ERIX_E2E_ALLOW_DB_DIR'] }));

// 6) #227.1：FDE_IMAGE 是 image:tag 形态却没显式 FDE_DEV_MODE=1 ⇒ 必须拒（主 agent 真跑 #226 踩的坑：
//    tag 形态在 portal 非 dev 模式下被生产门拒 provision，护栏要在起栈前就拦下并点名）。
cases.push(expectThrow('assertIsolatedEnvironment() tag 形态 FDE_IMAGE 缺 FDE_DEV_MODE',
  () => assertIsolatedEnvironment({ env: (() => { const e = validIsolationEnv(); delete e.FDE_DEV_MODE; return e; })() }),
  { namesMustInclude: ['FDE_DEV_MODE'] }));

// 7) #227.1：allowSharedReset（wp2b 的共享重置声明）**只豁免共享路径本身**——非临时、非共享的路径
//    照旧要 ERIX_E2E_ALLOW_DB_DIR=1 豁免（防「加了个选项就变成任意路径都能 rm -rf」）。
cases.push(expectThrow('resolveDbDir({allowSharedReset:true}) 非共享非临时路径仍拒',
  () => resolveDbDir({ STATION_DB_DIR: '/var/lib/erix-not-temp-db' }, { allowSharedReset: true }),
  { namesMustInclude: ['/var/lib/erix-not-temp-db', 'ERIX_E2E_ALLOW_DB_DIR'] }));

// 8) #227.3：隔离栈把 IPAM 池设成共享段 10.200.0.0/16 ⇒ 必须拒（fail-closed 的红线本体）。
cases.push(expectThrow('assertIsolatedEnvironment() FDE_IPAM_POOLS=共享段 10.200.0.0/16',
  () => assertIsolatedEnvironment({ env: { ...validIsolationEnv(), FDE_IPAM_POOLS: SHARED_STACK.fdeIpamPool } }),
  { namesMustInclude: ['FDE_IPAM_POOLS', '10.200.0.0/16'] }));

// 9) #227.3：compose/--env-file 缺省的两段值（含共享段）也必须拒——「忘了传」偷跑时护栏拦得住。
cases.push(expectThrow('assertIsolatedEnvironment() FDE_IPAM_POOLS=缺省两段（含共享段）',
  () => assertIsolatedEnvironment({ env: { ...validIsolationEnv(), FDE_IPAM_POOLS: `${SHARED_STACK.fdeIpamPool},10.201.0.0/16` } }),
  { namesMustInclude: ['10.200.0.0/16'] }));

// 10) #227.3：族外段（10.99.0.0/16）也必须拒——显式覆盖只能在隔离族内选，fail-closed。
cases.push(expectThrow('assertIsolatedEnvironment() FDE_IPAM_POOLS=族外段 10.99.0.0/16',
  () => assertIsolatedEnvironment({ env: { ...validIsolationEnv(), FDE_IPAM_POOLS: '10.99.0.0/16' } }),
  { namesMustInclude: ['FDE_IPAM_POOLS', '10.99.0.0/16'] }));

// --- 正例（夹具 env 必须过护栏；否则上面的负例是「全都抛」的空洞通过）---------------------
let positiveOk = true;
let positiveError = '';
try {
  assertIsolatedEnvironment({ env: validIsolationEnv() });
  // 显式豁免分支也得可用：非临时目录 + ERIX_E2E_ALLOW_DB_DIR=1 ⇒ 允许，且真去调 docker。
  const callsBefore = dockerCalls.length;
  removeDbDir(fakeDocker, { ...validIsolationEnv(), STATION_DB_DIR: SHARED_STACK.dbDir, ERIX_E2E_ALLOW_DB_DIR: '1' });
  assert.ok(dockerCalls.length === callsBefore + 1, 'ERIX_E2E_ALLOW_DB_DIR=1 时 removeDbDir 应真的执行 docker');
  assert.ok(resolveDbDir({ STATION_DB_DIR: '/tmp/station-db-x/' }) === '/tmp/station-db-x',
    'resolveDbDir 应去掉尾斜杠');
} catch (error) {
  positiveOk = false;
  positiveError = String(error?.message ?? error);
}

// #227.1 的正例补充（独立一组：任一失败同样算正例不过）：
// • digest 形态 FDE_IMAGE 不要求 FDE_DEV_MODE（生产钉定）；
// • allowSharedReset 未设 STATION_DB_DIR 时解析到共享库目录并真去 docker 删（wp2b 共享重置语义）。
try {
  const digestEnv = { ...validIsolationEnv(), FDE_IMAGE: `erix-station/fde@sha256:${'a'.repeat(64)}` };
  delete digestEnv.FDE_DEV_MODE;
  assertIsolatedEnvironment({ env: digestEnv });
  const beforeReset = dockerCalls.length;
  const sharedResolved = resolveDbDir({}, { allowSharedReset: true });
  assert.equal(sharedResolved, SHARED_STACK.dbDir, 'allowSharedReset 下缺省应解析到共享库目录（wp2b 语义）');
  removeDbDir(fakeDocker, {}, { allowSharedReset: true });
  assert.ok(dockerCalls.length === beforeReset + 1, 'allowSharedReset 下 removeDbDir 应真的执行 docker');
  // #227.3：派生段的口径钉死（变异 c 的红条入口：把 deriveFdeIpamPools 改成恒返回固定段就红）。
  // e2e226 的全部数字拼接是 '2226'（e2e 里也有个 2）→ 2226 % 99 = 48 → 201+48 = 249。
  assert.equal(deriveFdeIpamPools('e2e226'), '10.249.0.0/16', '派生段口径：10.(201 + 全部数字拼接 mod 99).0.0/16');
  assert.equal(deriveFdeIpamPools('E2E-226-stack'), deriveFdeIpamPools('e2e226'), '同数字必同段（按段号可判定）');
  assert.notEqual(deriveFdeIpamPools('e2e226'), deriveFdeIpamPools('e2e227'), '不同数字（mod 99 不同余）必不同段');
  const hashed = deriveFdeIpamPools('solo-alpha');
  assert.match(hashed, /^10\.2(?:0[1-9]|[1-9][0-9])\.0\.0\/16$/, '无数字 id 走短哈希，仍限隔离族内');
  assert.equal(deriveFdeIpamPools('solo-alpha'), hashed, '哈希路径也幂等');
  for (let i = 1; i <= 300; i += 1) {
    const p = deriveFdeIpamPools(`stack${i}`);
    assert.match(p, /^10\.2(?:0[1-9]|[1-9][0-9])\.0\.0\/16$/, `stack${i} 派生越族：${p}`);
    assert.notEqual(p, `${SHARED_STACK.fdeIpamPool}`, `stack${i} 派生命中共享段：${p}`);
  }
  // #227.3：显式只传派生段（不含 large 池段）也是合法正规值。
  assertIsolatedEnvironment({ env: { ...validIsolationEnv(), FDE_IPAM_POOLS: deriveFdeIpamPools('e2e226') } });
} catch (error) {
  positiveOk = false;
  positiveError = `${positiveError}${positiveError ? ' | ' : ''}digest/allowSharedReset/IPAM 派生正例被拒：${String(error?.message ?? error)}`;
}

// #268 M1 的桩语义正例（独立一组，任一失败同样算正例不过）：writeDynamicStub 只在 routes.yml
// 不存在时写 `http: {}\n`，**已存在则一字不动**——这是 edge watch 坑修法的幂等红线：
// 变异入口：把 writeDynamicStub 改成无条件覆盖 routes.yml，下方「不覆盖 materializer 产物」即红
//（桩压掉真实路由 = 亲手制造全 404，比不修更坑）。
try {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-stub-trap-'));
  try {
    const materialized = 'http:\n  routers:\n    internal-alice:\n      rule: PathPrefix(`/api/internal`)\n';
    // 1) 已存在（模拟 materializer 产物）：不动、created=false，重复调用也幂等。
    fs.writeFileSync(path.join(stubDir, 'routes.yml'), materialized);
    const r1 = writeDynamicStub(stubDir);
    assert.equal(fs.readFileSync(path.join(stubDir, 'routes.yml'), 'utf8'), materialized,
      'writeDynamicStub 不得覆盖已存在的 routes.yml（materializer 产物不能被桩压掉）');
    assert.equal(r1.created, false, '已存在时 created=false（幂等信号）');
    // 2) 不存在：写入的正文必须是 `http: {}\n`（合法空配置：Traefik 能 watch，且不含任何路由）。
    fs.rmSync(path.join(stubDir, 'routes.yml'));
    const r2 = writeDynamicStub(stubDir);
    assert.equal(fs.readFileSync(path.join(stubDir, 'routes.yml'), 'utf8'), 'http: {}\n',
      '不存在时应预写 `http: {}\n` 桩');
    assert.equal(r2.created, true, '新写时 created=true');
    // 3) 对自己的桩再调一次也不重写（幂等）。
    assert.equal(writeDynamicStub(stubDir).created, false, '桩自身的二次调用不重写');
  } finally {
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
} catch (error) {
  positiveOk = false;
  positiveError = `${positiveError}${positiveError ? ' | ' : ''}writeDynamicStub 桩语义正例被破坏：${String(error?.message ?? error)}`;
}

// #268 M2 派生件正例（deriveIsolationComposeEnv / memoizeOnce，全程假 docker、不碰真 docker）：
// 扫非本栈 fde-* 网络子网 → IPAM_RESERVED_SUBNETS；排除 ownFdeNetwork；去重；skip 位不扫描；
// 网络消失（inspect 抛错）不致炸。变异入口：把扫描改成「含本栈网络」或「不去重」，本组即红。
try {
  const seen = [];
  const netFake = (args) => {
    seen.push(args);
    if (args.startsWith('network ls')) return 'bridge\nfde-e2e226alice\nfde-alice\nfde-bob\nfde-carol\nfde-gone\nbackend';
    if (args.includes('inspect fde-alice')) return '[{"Subnet":"10.200.0.0/29"}]';
    if (args.includes('inspect fde-bob')) return '[{"Subnet":"10.200.0.32/29"}]';
    if (args.includes('inspect fde-carol')) return '[{"Subnet":"10.200.0.0/29"}]'; // 与 alice 同段 → 去重
    if (args.includes('inspect fde-gone')) throw new Error('网络在 ls 与 inspect 之间消失（safe 包裹必须吞掉，不致整体炸）');
    if (args.includes('inspect fde-e2e226alice')) throw new Error('ownFdeNetwork 不该被 inspect（被扫到即测试红）');
    return null;
  };
  const derived = deriveIsolationComposeEnv({
    docker: netFake, ownFdeNetwork: 'fde-e2e226alice', baseEnv: { BASE_DOMAIN: 'localhost' },
  });
  assert.equal(derived.BASE_DOMAIN, 'localhost', 'baseEnv 原样保留');
  assert.equal(derived.IPAM_RESERVED_SUBNETS, '10.200.0.0/29,10.200.0.32/29',
    '非本栈 fde-* 子网按扫描顺序拼接、同段去重（carol 与 alice 同段只留一份）');
  assert.ok(!seen.some((a) => /^network inspect fde-e2e226alice\b/.test(a)),
    'ownFdeNetwork（本栈自己的网络）不得被 inspect');
  const beforeSkip = seen.length;
  const skipped = deriveIsolationComposeEnv({ docker: netFake, ownFdeNetwork: 'fde-x', skipIpamReserved: true });
  assert.ok(!('IPAM_RESERVED_SUBNETS' in skipped), 'skipIpamReserved=true ⇒ 不注入（显式传优先）');
  assert.equal(seen.length, beforeSkip, 'skip 时一条 docker 命令都不发（连扫描都不发生）');
  // 无可扫网络 ⇒ 不注入键（而不是注入空串）。
  const empty = deriveIsolationComposeEnv({ docker: () => '', ownFdeNetwork: 'fde-own' });
  assert.ok(!('IPAM_RESERVED_SUBNETS' in empty), '扫无子网时不注入 IPAM_RESERVED_SUBNETS');
  // memoizeOnce：只算一次（惰性 + 记忆化），后续调用不再碰 docker。
  let calls = 0;
  const memo = memoizeOnce(() => { calls += 1; return { n: calls }; });
  assert.deepEqual([memo(), memo(), memo()], [{ n: 1 }, { n: 1 }, { n: 1 }], 'memoizeOnce 只算一次');
  assert.equal(calls, 1, 'memoizeOnce 底层函数调用次数 = 1');
} catch (error) {
  positiveOk = false;
  positiveError = `${positiveError}${positiveError ? ' | ' : ''}#268 M2 派生件正例被破坏：${String(error?.message ?? error)}`;
}

// 工单 F（wp2a 重建）：`~/.erix/ports.json` ↔ DB `port_allocations` 对账件的**行为面**
//（全程夹具，不碰 docker）。这是 wp2a 里最重的一条断言，所以它的「不是恒真」必须能在本脚本里钉住：
// 变异入口 = 把 lib/ports-reconcile.mjs 的 reconcilePortsJsonWithDb 改成直接 `return { problems: [], summary }`
//（= 工单自检里的「对账改成恒真」）⇒ 下面「一致夹具零问题」仍绿，但每一类破坏都不再被抓 ⇒ 本组红。
try {
  const fdeName = 'e2e226alice';
  const baseDomain = 'fde.erix.test';
  const publicBaseUrl = 'http://station.fde.erix.test:18090';
  const hostOf = (port) => `${fdeName}-p-${port}.${baseDomain}`;
  const urlOf = (port) => `http://${hostOf(port)}:18090`;
  const ports = Array.from({ length: 10 }, (_, i) => 22000 + i);
  const entry = (port, over = {}) => ({ scope: 'fde', port, role: 'spare', run_id: null, url: urlOf(port), exposure: 'private', state: 'allocated', ...over });
  const row = (port, over = {}) => ({ port, hostname: hostOf(port), url: urlOf(port), scope: 'fde', role: 'spare', exposure: 'private', state: 'allocated', run_id: null, ...over });
  const jsonOf = (list, over = {}) => ({ schema: 1, fde: fdeName, generation: 7, allocations: list, ...over });
  const goodJson = jsonOf(ports.map((p) => entry(p)));
  const goodRows = ports.map((p) => row(p));
  const run = (portsJson, dbRows) => reconcilePortsJsonWithDb({ portsJson, dbRows, fdeName, baseDomain, publicBaseUrl }).problems;

  // 正例：完全一致的夹具必须零问题（否则下面的负例是「全都报」的空洞通过）。
  assert.deepEqual(run(goodJson, goodRows), [], '一致的 ports.json/DB 夹具不应报任何问题');
  assert.deepEqual([...PREVIEW_LIVE_STATES].sort(), ['active', 'allocated'], '活行状态口径 = allocated/active（§8.6）');

  const traps = [
    ['清单少一条（块没发满）', jsonOf(goodJson.allocations.slice(0, 9)), goodRows],
    ['generation 不是数值', jsonOf(goodJson.allocations, { generation: '7' }), goodRows],
    ['fde 字段指向别人', jsonOf(goodJson.allocations, { fde: 'someoneelse' }), goodRows],
    ['schema 不是 1', jsonOf(goodJson.allocations, { schema: 2 }), goodRows],
    ['scope 退回 run 级（0019 前的形态）', goodJson, goodRows.map((r, i) => (i === 0 ? { ...r, scope: 'run' } : r))],
    ['DB 活行里混进 released（清单没跟上）', goodJson, goodRows.map((r, i) => (i === 3 ? { ...r, state: 'released' } : r))],
    ['json 与 DB 状态不一致', jsonOf(goodJson.allocations.map((e, i) => (i === 1 ? { ...e, state: 'active' } : e))), goodRows],
    ['清单里的 url 端口不是公开入口的端口', goodJson, goodRows.map((r) => ({ ...r, url: r.url.replace(':18090', ':8090') }))],
    ['hostname 前缀不是该 FDE', goodJson, goodRows.map((r) => ({ ...r, hostname: r.hostname.replace(fdeName, 'otherfde') }))],
    ['端口在号池外（旧 4000–4009 时代）', jsonOf([4000, 4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009].map((p) => entry(p))),
      [4000, 4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009].map((p) => ({ ...row(p), port: p, hostname: hostOf(p), url: urlOf(p) }))],
    ['块起点未按 10 对齐', jsonOf([22005, 22006, 22007, 22008, 22009, 22010, 22011, 22012, 22013, 22014].map((p) => entry(p))),
      [22005, 22006, 22007, 22008, 22009, 22010, 22011, 22012, 22013, 22014].map((p) => row(p))],
    ['块内端口不连续（缺一条 + 多一条）', jsonOf([...goodJson.allocations.slice(0, 5), ...goodJson.allocations.slice(6), entry(22020)]), goodRows],
    ['DB 多一条没进清单', goodJson, [...goodRows, row(22030)]],
    ['FDE 级行带了 run_id（迁移 0019 的 CHECK 面）', goodJson, goodRows.map((r, i) => (i === 2 ? { ...r, run_id: 'x' } : r))],
    ['json 整体不是对象', null, goodRows],
    ['DB 行不是数组', goodJson, null],
  ];
  for (const [label, portsJson, dbRows] of traps) {
    const problems = run(portsJson, dbRows);
    assert.ok(problems.length > 0, `对账夹具负例未被抓：${label}（problems 为空 ⇒ 对账已退化成恒真）`);
  }
} catch (error) {
  positiveOk = false;
  positiveError = `${positiveError}${positiveError ? ' | ' : ''}ports.json↔DB 对账件正/负例被破坏：${String(error?.message ?? error)}`;
}

// 工单 F-6：**经 `sg docker -c ${JSON.stringify(cmd)}` 两层的命令不得含裸换行**（源码级静态钉）。
// 根因（真机 §⑤ 首失败）：JSON.stringify 把模板里的**真实换行**变成字面 `\n` 两个字符，而双引号内的
// POSIX shell **不还原**它 ⇒ 下游 psql 实收 `run_id\n FROM` ⇒ `ERROR: syntax error at or near "\"`。
// 判据只看「会被送进那一层的命令串」（函数第一个实参是模板字面量的位置）：
//   · 扫 SHELL_QUOTED_FNS（psql/docker/dockerStdin/compose/execSync）；
//   · **不**扫 psqlStdin：它的 SQL 走 `docker exec -i` 的 stdin，根本不碰这层引号，多行合法
//     （§③ insertUser 就是这个形状，从来没坏过）；
//   · `${…}` 表达式整段挖掉后才找换行 ⇒ 「源码为了折行把 ${…} 放在行尾」不算违规
//     （lib/llm-binding.mjs 正是那个形状，报它就是误伤；夹具里有这条正例）。
// 变异自证入口：把 wp2a §⑤ 那条已压单行的 SQL 拆回两行 ⇒ 本钉红（行为面夹具同时钉住本扫描不是恒真）。
const SHELL_QUOTED_FNS = ['psql', 'docker', 'dockerStdin', 'compose', 'execSync'];

/** 跳过引号串（含模板里的 `${…}` 嵌套），返回闭合引号之后的下标。 */
function skipQuotedSegment(src, i, quote) {
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === quote) return j + 1;
    if (quote === '`' && ch === '$' && src[j + 1] === '{') { j = skipExprSegment(src, j + 1); continue; }
    j += 1;
  }
  throw new Error(`未闭合的引号串（${quote}）`);
}

/** 跳过 `${…}`（花括号计数 + 内层引号/模板），返回 `}` 之后的下标。 */
function skipExprSegment(src, i) {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const ch = src[j];
    if (ch === "'" || ch === '"' || ch === '`') { j = skipQuotedSegment(src, j, ch); continue; }
    if (ch === '{') { depth += 1; j += 1; continue; }
    if (ch === '}') { depth -= 1; j += 1; if (depth === 0) return j; continue; }
    j += 1;
  }
  throw new Error('未闭合的 ${…}');
}

/** 拆模板字面量：只返回**字面片段**（`${…}` 整段挖掉）。每个片段带源文本偏移，且与源同宽
 *  （转义写成两个占位空格），所以片段内下标可以直接换算回行号。 */
function scanTemplateLiterals(src, i) {
  const literals = [];
  let lit = '';
  let start = i + 1;
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') { lit += '  '; j += 2; continue; }
    if (ch === '`') { literals.push({ text: lit, offset: start }); return { literals, end: j + 1 }; }
    if (ch === '$' && src[j + 1] === '{') {
      literals.push({ text: lit, offset: start });
      j = skipExprSegment(src, j + 1);
      lit = '';
      start = j;
      continue;
    }
    lit += ch;
    j += 1;
  }
  throw new Error('未闭合的模板字面量');
}

/** 找出「命令串里有裸换行」的调用点 → [{fn, line, sql}]（每个调用点最多报一次）。 */
function findNakedNewlineCommands(src, { fns = SHELL_QUOTED_FNS } = {}) {
  const re = new RegExp(`(?:^|[^\\w$.])(${fns.join('|')})\\s*\\(`, 'g');
  const hits = [];
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] !== '`') continue;
    let scanned;
    try {
      scanned = scanTemplateLiterals(src, i);
    } catch {
      continue; // 解不动的形状（奇异嵌套）不当钉的依据，宁漏不误伤
    }
    for (const literal of scanned.literals) {
      const nl = literal.text.search(/[\n\r]/);
      if (nl === -1) continue;
      hits.push({
        fn: m[1],
        line: src.slice(0, literal.offset + nl).split('\n').length,
        sql: /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b/i.test(literal.text),
      });
      break;
    }
    re.lastIndex = scanned.end;
  }
  return hits;
}

// 夹具：扫描件本身的行为面正/负例（不依赖 wp2a 内容，“扫不到”与“误伤”都能被发现）。
// 变异入口：把 findNakedNewlineCommands 改成直接 `return []` ⇒ 下面每一类负例都不再被抓 ⇒ 本组红。
try {
  const f = (s) => findNakedNewlineCommands(s);
  // 正例 1：单行命令串。
  assert.deepEqual(f('psql(`SELECT a FROM t`)'), [], '单行 SQL 不该报');
  // 正例 2（关键误伤面）：为了折行把 ${…} 放在行尾 —— 字面片段里没有真换行（llm-binding.mjs 的形状）。
  assert.deepEqual(f('docker(\n  `exec ${c} psql -tAc ${JSON.stringify(\n  `SELECT b FROM u WHERE x = 1`,\n)}`\n)'), [], '${…} 边界上的源码折行不该报');
  // 正例 3：psqlStdin 不在名单（SQL 走 stdin，多行合法）。
  assert.deepEqual(f('psqlStdin(`\n  INSERT INTO t (a) VALUES (1);\n`)'), [], 'psqlStdin 的多行 SQL 不该报');
  // 正例 4：写源码时就带的转义 `\n`（两字符）不是真换行。
  assert.deepEqual(f('docker(`echo a\\nb`)'), [], '转义 \\n（字面两字符）不该报');
  // 负例 1：真机那一条的形状——字面片段里 SELECT…run_id 与 FROM 之间折行。
  const broken = f('psql(`SELECT a, run_id\n       FROM t WHERE x=1`)');
  assert.equal(broken.length, 1, '拆成两行的 SQL 必须被抓（工单 F-6 的真机形状）');
  assert.equal(broken[0].fn, 'psql');
  assert.equal(broken[0].line, 1);
  assert.equal(broken[0].sql, true, 'SQL 站点要标出来（文案要指向 psql 的 syntax error）');
  // 负例 2：非 SQL 的命令串折行同样是 bug（这一层对任何命令都把换行变成字面 \n）。
  assert.equal(f('docker(`run -d --rm --name p\n  node:22-alpine node -e x`)').length, 1, '非 SQL 命令折行也要抓');
  // 负例 3：`${…}` **之后**的字面片段里折行（只盯模板开头会漏）。
  assert.equal(f('docker(`exec ${c} cat /p\n/f`)').length, 1, '${…} 之后的折行也要抓');
  // 负例 4：CR（CRLF 文件里也一样会坏）。
  assert.equal(f('psql(`SELECT a\r\nFROM t`)').length, 1, '裸 CR 也要抓');
  // 负例 5：dockerStdin/compose/execSync 同样在名单里（它们共用同一个包裹）。
  for (const [snippet, fn] of [['dockerStdin(`exec -i db psql\n-c x`, sql)', 'dockerStdin'], ['compose(`up -d\n--build`)', 'compose'], ['execSync(`sg docker -c x\n-y`)', 'execSync']]) {
    const got = f(snippet);
    assert.equal(got.length, 1, `名单漏了 ${fn}：${snippet}`);
    assert.equal(got[0].fn, fn);
  }
  // 正例 5：带参数的前缀不误判（`t.docker(` 是方法调用、`createDbDirCleaner({ docker })` 不是调用）。
  assert.deepEqual(f('x.docker(`a\nb`)'), [], '方法调用形态不在名单');
  assert.deepEqual(f('createDbDirCleaner({ docker })'), [], '传函数引用不是调用，不该报');
} catch (error) {
  positiveOk = false;
  positiveError = `${positiveError}${positiveError ? ' | ' : ''}引号层扫描件（工单 F-6）正/负例被破坏：${String(error?.message ?? error)}`;
}

// --- 单一来源断言（钉住「护栏只有一份定义」；复制一份出来就会红）---------------------------
// 只钉 #226 收编的公共实现：护栏本体、缺省陷阱解析、Traefik 静态配置生成、端口预探。
// removeDbDir 副本：#227.1 已收编 wp2b/wp3b（wp2b 走 allowSharedReset 显式声明共享重置，
// wp3b 隔离走严格面/共享走显式 env 豁免）；wp4 仍有历史局部副本（共享栈跑法，本工单未收编，见交付报告）。
const SINGLE_SOURCE_DEFS = ['assertIsolatedEnvironment', 'resolveDbDir', 'writeTraefikStatic', 'assertHostPortsAvailable',
  'deriveFdeIpamPools', 'defaultFdeIpamPools', 'writeDynamicStub', 'deriveIsolationComposeEnv', 'memoizeOnce'];
// 工单 F：`ports.json ↔ port_allocations` 对账件的唯一定义处是 lib/ports-reconcile.mjs（不在
// isolated-env.mjs 里），所以单一来源断言得按名字选归属文件，不能再默认「只有 isolated-env.mjs」。
const SINGLE_SOURCE_FILES = { reconcilePortsJsonWithDb: 'ports-reconcile.mjs' };
const ISOLATION_SCRIPTS = ['wp2a-e2e.mjs', 'wp3a-e2e.mjs', 'wp5-e2e.mjs', 'wp6-llm-e2e.mjs'];
const singleSourceProblems = [];
{
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.mjs') && full !== SELF) files.push(full);
    }
  };
  walk(HERE);
  for (const [name, ownerFile] of [...SINGLE_SOURCE_DEFS.map((n) => [n, 'isolated-env.mjs']), ...Object.entries(SINGLE_SOURCE_FILES)]) {
    const definers = files.filter((file) => new RegExp(`function\\s+${name}\\s*\\(`).test(fs.readFileSync(file, 'utf8')));
    if (definers.length !== 1 || path.basename(definers[0]) !== ownerFile) {
      singleSourceProblems.push(`${name}: 期望只在 lib/${ownerFile} 有 1 处定义，实际 ${definers.length} 处 → ${definers.map((f) => path.relative(path.resolve(HERE, '../..'), f)).join(', ') || '（无）'}`);
    }
  }
  for (const script of [...ISOLATION_SCRIPTS, 'wp3b-e2e.mjs']) {
    const text = fs.readFileSync(path.join(HERE, script), 'utf8');
    if (!/from\s+'\.\/lib\/isolated-env\.mjs'/.test(text)) {
      singleSourceProblems.push(`${script}: 没有 import ./lib/isolated-env.mjs（护栏/静态配置必须是共用那一份）`);
    }
    // 接线断言（仅 #226 收编的四支）：真的「起栈前跑护栏」+「用公共 cleaner 删库目」，而不是自己 rm -rf。
    // wp3b 不在本工单收编范围（它已有自己的 env 派生面），只查它共用 writeTraefikStatic 的那份 import。
    if (!ISOLATION_SCRIPTS.includes(script)) continue;
    if (!/assertIsolatedEnvironment\(/.test(text)) {
      singleSourceProblems.push(`${script}: 没调用 assertIsolatedEnvironment()（护栏又变成可选的了）`);
    }
    if (!/createDbDirCleaner\(/.test(text)) {
      singleSourceProblems.push(`${script}: 没使用 createDbDirCleaner()（缺省 DB 目录陷阱可能又回来了）`);
    }
  }
  // 硬编码入口断言（grep 门的脚本化版，#226 取证面）：入口常量必须是模板拼出来的，
  // 不接受把共享栈端口写进常量（变异自证 b：PORTAL 改回 'http://127.0.0.1:18080' 就红）。
  const HARDCODED_ENTRYPOINT = /(?:const|let|var)\s+(?:PORTAL|TRAEFIK_WEB|LLM_BASE|PORTAL_BASE)\s*=\s*[`'"]http:\/\/127\.0\.0\.1:(?:18080|8090|4100)/;
  for (const script of ISOLATION_SCRIPTS) {
    const lines = fs.readFileSync(path.join(HERE, script), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (HARDCODED_ENTRYPOINT.test(line)) {
        singleSourceProblems.push(`${script}:${i + 1} 入口 URL 又硬编码成共享栈端口：${line.trim()}`);
      }
    });
  }
  // 缺省陷阱本体：#226 收编的四支 + 公共模块里再出现 `STATION_DB_DIR || '/docker/station-db'`
  // 就是回到 #226 的坑。wp3b/wp2b/wp4 的共享栈缺省是**存量已知遗留**（不查它们，见交付报告「遗留问题」）。
  for (const file of [...ISOLATION_SCRIPTS.map((s) => path.join(HERE, s)), path.join(HERE, 'lib/isolated-env.mjs')]) {
    const text = fs.readFileSync(file, 'utf8');
    if (/STATION_DB_DIR\s*\|\|\s*['"]\/docker\/station-db/.test(text)) {
      singleSourceProblems.push(`${path.relative(path.resolve(HERE, '../..'), file)}: 重新给 STATION_DB_DIR 挂了共享栈缺省值 /docker/station-db`);
    }
  }
  // #224：wp6 cleanup 结构断言——清场失败必须红，不允许回到静默吞错。删掉任一零件（teardown 记录 /
  // 标签零残留复查 / 末尾断言）或把 `2>/dev/null || true` 请回来，本断言即红（变异自证入口）。
  {
    const wp6Text = fs.readFileSync(path.join(HERE, 'wp6-llm-e2e.mjs'), 'utf8');
    const wp6Required = [
      [/console\.warn\(`\[wp6\] teardown/, 'teardown 失败逐动作 console.warn 点名'],
      [/teardownFailures/, '清理失败记进 errors 清单（teardownFailures）'],
      [/filter label=station\.stack=/, '零残留复查：按 station.stack 标签查本栈容器/网络'],
      [/filter label=com\.docker\.compose\.project=/, '零残留复查：按 compose project 标签查本栈资源'],
      [/assert\.deepEqual\(problems, \[\],/, '清场末尾的零失败/零残留断言（有残留必须红）'],
    ];
    for (const [pattern, what] of wp6Required) {
      if (!pattern.test(wp6Text)) {
        singleSourceProblems.push(`wp6-llm-e2e.mjs: cleanup 缺 #224 零件「${what}」（清场又可能静默吞错了）`);
      }
    }
    if (/2>\/dev\/null \|\| true/.test(wp6Text)) {
      singleSourceProblems.push('wp6-llm-e2e.mjs: cleanup 里又出现 `2>/dev/null || true`（#224 的静默吞错形态）');
    }
  }
  // #268 M1（edge watch 桩）：四支隔离 e2e 必须 import 并在 **compose up 之前**调用 writeDynamicStub。
  // 顺序用源码文本判：首次调用行号 < 首次 `compose('up` 行号（桩晚于起栈 = watch 已经落空，白写）。
  // 变异自证入口：删掉/注释任一脚本的桩调用 ⇒ 本断言红；把调用搬到 compose up 之后 ⇒ 同样红。
  // 工单 F（wp2a 重建）后 wp2a 也走同一套桩，加入名单（删掉 wp2a 的桩调用即红）。
  const DYNAMIC_STUB_SCRIPTS = ['wp2a-e2e.mjs', 'wp3a-e2e.mjs', 'wp3b-e2e.mjs', 'wp5-e2e.mjs', 'wp6-llm-e2e.mjs'];
  for (const script of DYNAMIC_STUB_SCRIPTS) {
    const lines = fs.readFileSync(path.join(HERE, script), 'utf8').split('\n');
    const stubLine = lines.findIndex((l, i) => /\bwriteDynamicStub\s*\(/.test(l) && !/^\s*(import|\/\/|\*)/.test(l) && i > 0);
    const upLine = lines.findIndex((l) => /compose\('up\b/.test(l));
    if (!new RegExp(`writeDynamicStub[,\\s][\\s\\S]*?from\\s+'\\.\\/lib\\/isolated-env\\.mjs'`).test(fs.readFileSync(path.join(HERE, script), 'utf8'))) {
      singleSourceProblems.push(`${script}: 没有从 ./lib/isolated-env.mjs import writeDynamicStub（桩必须用公共那一份）`);
    }
    if (stubLine === -1) {
      singleSourceProblems.push(`${script}: 没调用 writeDynamicStub()（edge watch 桩没预写，materializer 原子替换会永不被 reload → internal 全 404，#268）`);
    } else if (upLine !== -1 && stubLine > upLine) {
      singleSourceProblems.push(`${script}:${stubLine + 1} writeDynamicStub() 在 compose up（:${upLine + 1}）之后才调——桩必须在起栈前预写，否则 watch 已落空（#268）`);
    }
  }
  // #268 M2（派生件提 lib）：wp3b 的 IPAM_RESERVED_SUBNETS 派生必须走 lib 那一份（扫其他栈 fde-*
  // 子网的扫描体不得再在脚本里内联复制；单一来源扫描已钉住定义，这里钉「wp3b 真的 import 了它」）。
  {
    const wp3bText = fs.readFileSync(path.join(HERE, 'wp3b-e2e.mjs'), 'utf8');
    if (!/deriveIsolationComposeEnv\s*[,\s][\s\S]*?from\s+'\.\/lib\/isolated-env\.mjs'/.test(wp3bText)) {
      singleSourceProblems.push('wp3b-e2e.mjs: 没有 import lib 的 deriveIsolationComposeEnv（IPAM 保留段派生又变成脚本私有副本了，#268 M2）');
    }
    if (!/isolationComposeEnv\s*=\s*memoizeOnce\(/.test(wp3bText)) {
      singleSourceProblems.push('wp3b-e2e.mjs: isolationComposeEnv 不再是 memoizeOnce(…) 包裹（惰性+记忆化语义被拆，每次 compose 都重查 docker）');
    }
    // #268 主 agent 验收变异逃逸补钉（把 wp3b 的 skip 实参改成恒 false 当时无断言红）：
    // compose env 的 spread 顺序里派生注入在 process.env **之后**——不按「显式传入」门控，
    // 扫描值会 spread-覆盖操作者传的 IPAM_RESERVED_SUBNETS，「显式传入优先」作废。
    if (!/skipIpamReserved:\s*Boolean\(process\.env\.IPAM_RESERVED_SUBNETS\)/.test(wp3bText)) {
      singleSourceProblems.push('wp3b-e2e.mjs: skipIpamReserved 实参不再是 Boolean(process.env.IPAM_RESERVED_SUBNETS)（显式传入时仍扫描注入会盖掉操作者的值，#268 M2）');
    }
    const wp3aCallerText = fs.readFileSync(path.join(HERE, 'wp3a-e2e.mjs'), 'utf8');
    if (!/process\.env\.IPAM_RESERVED_SUBNETS\s*\?\s*\{\}/.test(wp3aCallerText)) {
      singleSourceProblems.push('wp3a-e2e.mjs: IPAM_RESERVED_SUBNETS 的显式门控消失（三元为 {} 短路必须在派生前，否则派生值盖掉显式传入，#268 M2）');
    }
  }
  // #268 M3：wp3a 的 llm 段（LiteLLM mock_response 注入链）以「已配好 binding/虚拟 key」为前提——
  // ensureLlmBinding() 必须仍在流程里，且模型别名必须与 fake-agentd llm 段请求的 'mock-model' 对齐
  //（虚拟 key 的模型白名单只含被绑定模型，不对齐 ⇒ LiteLLM 403，即真机 {status:403,chunks:0} 的直接原因）。
  // 变异自证入口：删掉 binding 调用或改掉 modelName ⇒ 本断言红。
  {
    const wp3aText = fs.readFileSync(path.join(HERE, 'wp3a-e2e.mjs'), 'utf8');
    if (!/await\s+ensureLlmBinding\(\{/.test(wp3aText)) {
      singleSourceProblems.push('wp3a-e2e.mjs: ensureLlmBinding() 调用消失（LiteLLM binding/虚拟 key 是 llm 段 200 的前提，删掉即回到真机 403 chunks=0 的症状，#268 M3）');
    }
    if (!/modelName:\s*'mock-model'/.test(wp3aText)) {
      singleSourceProblems.push("wp3a-e2e.mjs: ensureLlmBinding 没有显式传 modelName: 'mock-model'（必须与 fake-agentd llm 段请求的模型名对齐；缺省 e2e-mock-model 不在白名单 → 403，#268 M3）");
    }
  }
  // 工单 F（wp2a 重建，#268 决策第 2 条）：wp2a 必须按 P5 + 迁移 0019 的现役语义跑，且最重的那条
  // 断言（ports.json ↔ port_allocations 对账）不许在脚本里被写软。变异自证入口：
  //   a) 删 wp2a 的 writeDynamicStub 调用 → 上方 DYNAMIC_STUB_SCRIPTS 红；
  //   b) 把对账改成恒真 → 上面「ports.json↔DB 对账件正/负例」那组红（行为面，无需 docker）；
  //   c) 删掉去置备的 404 断言 → 下方 wp2a-conv-404 锚点红。
  {
    const wp2aText = fs.readFileSync(path.join(HERE, 'wp2a-e2e.mjs'), 'utf8');
    const wp2aRequired = [
      [/from\s+'\.\/lib\/ports-reconcile\.mjs'/, "import './lib/ports-reconcile.mjs'（对账件必须是公共那一份）"],
      [/reconcilePortsJsonWithDb\(\{/, '调用 reconcilePortsJsonWithDb（ports.json ↔ port_allocations 逐条对账）'],
      [/assert\.deepEqual\(rec\.problems, \[\]/, '对账末尾的「问题清单 = []」断言（恒真化即被上面的夹具组抓）'],
      [/provision-fde --fde-name/, 'provision-fde（P5 唯一的 FDE 开户动作）'],
      [/deprovision-fde --fde-name/, 'deprovision-fde（去置备面）'],
      [/\/api\/me\/ports/, '#246 交付②：签票要用的 allocation UUID 从产品读侧取'],
      [/preview-ticket/, 'POST /api/ports/:id/preview-ticket（签票链路）'],
      [/buildFdeImage\(/, 'up 前自建 FDE 镜像（#268 M2 口径，见 lib/fde-image.mjs）'],
      [/teardownFailures/, 'teardown 失败逐动作记名（#224/#269：清场失败必须红）'],
      [/filter label=station\.stack=/, '零残留复查：按 station.stack 标签查本栈资源'],
      [/assert\.deepEqual\(problems, \[\],/, '清场末尾的零失败/零残留断言'],
      [/--network container:\$\{FDE_CONTAINER\}/, '探针必须共享 FDE 容器 netns（路由 backend 恒 = .2:<port>，在同一 /29 里另起一个容器不会被路由到）'],
      // 工单 F-5：userspace 权限口径按**真机现状**钉（工作区目录 permission 位 0770），
      // 不许改回「代码传了 2770 就断言 2770」——setgid 意图缺口的成因与出路写在 wp2a §④ 注释里。
      [/assert\.equal\(perm\(dir\), 0o0770/, '工作区目录钉真机现状 permission 位 0770（工单 F-5 返修口径）'],
    ];
    for (const [pattern, what] of wp2aRequired) {
      if (!pattern.test(wp2aText)) {
        singleSourceProblems.push(`wp2a-e2e.mjs: 缺工单 F 重建口径零件「${what}」（重建后的 wp2a 不允许回到旧形态）`);
      }
    }
    // 去置备收敛的 404 断言锚点：必须是**断言消息的开头**（`'wp2a-conv-404 …'`）且至少 2 条
    //（对该 host 直连 404 + 未用票据经边缘 404）。只销钉文字不算钉：label/注释里出现 token
    // 不算，删掉断言就少一条（工单自检 c 的入口：把 404 断言删掉 ⇒ 本项红）。
    const convAnchors = (wp2aText.match(/'wp2a-conv-404/g) || []).length;
    if (convAnchors < 2) {
      singleSourceProblems.push(`wp2a-e2e.mjs: 去置备收敛的 404 断言锚点 'wp2a-conv-404' 只剩 ${convAnchors} 处（要求 ≥2 处且必须是断言消息开头：直连 404 + 未用票据 404）`);
    }
    // 前 P5 形态不许回来：项目维度端点拼 id、读 POST /api/projects 的 201 返回体（该写口已 410）。
    for (const [pattern, what] of [
      [/\/api\/projects\/\$\{/, '项目维度端点又拼了 id（P5：/api/projects/:id 的 PATCH/DELETE 已 410）'],
      [/body\.ports\[0\]/, '又在读 POST /api/projects 的 201 返回体（该端点已 410）'],
      // 工单 F-5：把工作区目录重新按代码意图断言成 2770（真机拿不到 setgid）也算形态回来了。
      [/assert\.equal\(mode\(dir\), 0o2770/, '工作区目录又按代码意图断言 2770（真机稳定 0770；setgid 缺口见 wp2a §④）'],
    ]) {
      if (pattern.test(wp2aText)) {
        singleSourceProblems.push(`wp2a-e2e.mjs: 前 P5 形态回来了：${what}`);
      }
    }
  }
  // #227.1：allowSharedReset（wp2b 对「有意重置共享 dev 库」的显式声明）只能出现在 lib 定义与 wp2b
  // 调用处——别的脚本出现这个选项 = 有人开始打算删共享 dev 库，必须停下来先确认语义。
  const ALLOW_SHARED_RESET_FILES = new Set(['isolated-env.mjs', 'wp2b-e2e.mjs']);
  const sharedResetOutliers = files.filter((f) => !ALLOW_SHARED_RESET_FILES.has(path.basename(f))
    && fs.readFileSync(f, 'utf8').includes('allowSharedReset'));
  if (sharedResetOutliers.length) {
    singleSourceProblems.push(`allowSharedReset 出现在 lib/wp2b 之外（只有 wp2b 允许声明重置共享 dev 库）：${sharedResetOutliers.map((f) => path.relative(path.resolve(HERE, '../..'), f)).join(', ')}`);
  }
  // #227.2：脚本里的 compose 命令串必须显式带 `-p `（隔离系用 `${COMPOSE_PROJECT_NAME:?…}`、共享系用
  // `${COMPOSE_PROJECT_NAME:-station}`）——出现不带 -p 的 `docker compose ` 即红：回到「忘 export 就对
  // 共享 dev 栈 down -v」的隐式兜底（deploy/docker-compose.yml 的 `name: station`）。
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/docker compose\b/.test(line) && !/ -p /.test(line)) {
        singleSourceProblems.push(`${path.relative(path.resolve(HERE, '../..'), file)}:${i + 1} docker compose 命令没显式带 -p（#227.2：消灭 compose 文件 name: 的隐式兜底）：${line.trim()}`);
      }
    });
  }
  // #227.3：等值段字面量「10.201.0.0/16」只允许活在 lib/isolated-env.mjs（PORTAL_LARGE_POOL 定义处）；
  // 其它 integration 脚本/夹具再出现该字面量 = 有人把「等值 10.201」的旧口径请了回来（派生被绕过）。
  for (const file of files) {
    if (path.basename(file) === 'isolated-env.mjs') continue;
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('10.201.0.0/16')) {
      singleSourceProblems.push(`${path.relative(path.resolve(HERE, '../..'), file)}: 又出现等值段字面量 10.201.0.0/16（#227.3 应走 deriveFdeIpamPools/defaultFdeIpamPools 派生）`);
    }
  }
  // 工单 F-6：所有要过 `sg docker -c ${JSON.stringify(cmd)}` 那两层的命令串必须**单行**——真实换行会被
  // stringify 成字面 `\n`（双引号内 POSIX shell 不还原）⇒ psql 实收 `run_id\n FROM`，真机 §⑤ 就死在这。
  // 扫描面 = 本目录全部 .mjs（不只 wp2a：同一个包裹件在各脚本里都有副本，以后谁折行都拦）。
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const hit of findNakedNewlineCommands(text)) {
      singleSourceProblems.push(`${path.relative(path.resolve(HERE, '../..'), file)}:${hit.line} ${hit.fn}() 的命令串含裸换行——经 sg/JSON.stringify 会变成字面 \\n${hit.sql ? '（psql 实收即 syntax error at or near "\\"，工单 F-6；多行 SQL 请改走 psqlStdin/stdin）' : '（命令里任何换行都会原样抵达下游）'}`);
    }
  }
}

// --- 报告 --------------------------------------------------------------------------------
for (const testCase of cases) {
  const status = testCase.fired && testCase.matched && testCase.dockerSilent !== false ? 'TRAP OK' : 'TRAP FAIL';
  console.error(`[isolation-negative] ${status} · ${testCase.label}`);
  console.error(`    ↳ ${testCase.message.split('\n')[0]}`);
}
if (positiveOk) {
  console.error('[isolation-negative] 正例夹具（齐全隔离 env）通过护栏：负例不是因为「什么都抛」而空洞通过');
} else {
  console.error(`[isolation-negative] 正例夹具被抛错（护栏过严/夹具过期）：${positiveError}`);
}
for (const problem of singleSourceProblems) {
  console.error(`[isolation-negative] 单一来源断言 FAIL：${problem}`);
}

const trapsFired = cases.every((c) => c.fired && c.matched && c.dockerSilent !== false);
const ok = trapsFired && positiveOk && singleSourceProblems.length === 0;
console.error(`[isolation-negative] verdict=${ok ? 'TRAPS_FIRED' : 'TRAP_SILENT'}（全部 ${cases.length} 条陷阱=${trapsFired ? '均硬失败' : '有失灵'}；单一来源=${singleSourceProblems.length === 0 ? '一份定义' : `${singleSourceProblems.length} 处异常`}${STRICT ? '；--strict 模式' : ''}）`);
if (!ok) console.error('[isolation-negative] TRAP_SILENT = 护栏被改坏（或本夹具过期）：缺省跑法会重新对共享 dev 栈动手。');

// 缺省（负例证据模式）：陷阱如期硬失败是**期望结果**，但工单要求以非零码退出留下证据 ⇒ rc=1；
// 陷阱失灵是**真故障** ⇒ rc=2（与"期望的非零"区分开）。--strict 用常规 0/1 口径。
process.exitCode = STRICT ? (ok ? 0 : 1) : (ok ? 1 : 2);
