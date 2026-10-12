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
  SHARED_STACK, assertIsolatedEnvironment, defaultFdeIpamPools, deriveFdeIpamPools, removeDbDir, resolveDbDir,
} from './lib/isolated-env.mjs';

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

// --- 单一来源断言（钉住「护栏只有一份定义」；复制一份出来就会红）---------------------------
// 只钉 #226 收编的公共实现：护栏本体、缺省陷阱解析、Traefik 静态配置生成、端口预探。
// removeDbDir 副本：#227.1 已收编 wp2b/wp3b（wp2b 走 allowSharedReset 显式声明共享重置，
// wp3b 隔离走严格面/共享走显式 env 豁免）；wp4 仍有历史局部副本（共享栈跑法，本工单未收编，见交付报告）。
const SINGLE_SOURCE_DEFS = ['assertIsolatedEnvironment', 'resolveDbDir', 'writeTraefikStatic', 'assertHostPortsAvailable',
  'deriveFdeIpamPools', 'defaultFdeIpamPools'];
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
  for (const name of SINGLE_SOURCE_DEFS) {
    const definers = files.filter((file) => new RegExp(`function\\s+${name}\\s*\\(`).test(fs.readFileSync(file, 'utf8')));
    if (definers.length !== 1 || path.basename(definers[0]) !== 'isolated-env.mjs') {
      singleSourceProblems.push(`${name}: 期望只在 lib/isolated-env.mjs 有 1 处定义，实际 ${definers.length} 处 → ${definers.map((f) => path.relative(path.resolve(HERE, '../..'), f)).join(', ') || '（无）'}`);
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
