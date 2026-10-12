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
  SHARED_STACK, assertIsolatedEnvironment, removeDbDir, resolveDbDir,
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
    FDE_IPAM_POOLS: '10.201.0.0/16',
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

// --- 单一来源断言（钉住「护栏只有一份定义」；复制一份出来就会红）---------------------------
// 只钉 #226 收编的公共实现：护栏本体、缺省陷阱解析、Traefik 静态配置生成、端口预探。
// `removeDbDir` 在 wp2b/wp3b/wp4 仍有历史局部副本（共享栈跑法 + 自带缺省库目，本工单未收编，见交付报告）。
const SINGLE_SOURCE_DEFS = ['assertIsolatedEnvironment', 'resolveDbDir', 'writeTraefikStatic', 'assertHostPortsAvailable'];
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
console.error(`[isolation-negative] verdict=${ok ? 'TRAPS_FIRED' : 'TRAP_SILENT'}（两个缺省陷阱=${trapsFired ? '均硬失败' : '有失灵'}；单一来源=${singleSourceProblems.length === 0 ? '一份定义' : `${singleSourceProblems.length} 处异常`}${STRICT ? '；--strict 模式' : ''}）`);
if (!ok) console.error('[isolation-negative] TRAP_SILENT = 护栏被改坏（或本夹具过期）：缺省跑法会重新对共享 dev 栈动手。');

// 缺省（负例证据模式）：陷阱如期硬失败是**期望结果**，但工单要求以非零码退出留下证据 ⇒ rc=1；
// 陷阱失灵是**真故障** ⇒ rc=2（与"期望的非零"区分开）。--strict 用常规 0/1 口径。
process.exitCode = STRICT ? (ok ? 0 : 1) : (ok ? 1 : 2);
