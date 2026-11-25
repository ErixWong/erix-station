// 隔离 e2e 的公共护栏（issue #226：把 wp5-e2e.mjs:35 的实现提到公共模块，wp2a/wp3a/wp5/wp6 共用一份）。
// 唯一职责：把「这条 e2e 会不会动到共享 dev 栈」变成**硬失败**断言——外部句柄（栈名/容器名/端口/
// DB 数据目录/入口 URL）必须由 env 显式派生，且每一个都不像共享栈的既定值。
//
// 判据口径（#215 立、#226 复核）：宁可拒绝起跑，也不能默默对共享栈动手——
// 缺省 STATION_DB_DIR = `/docker/station-db`，正是共享 dev 栈 station-db 的 bind 源（#226 取证：
// `docker inspect station-db` → `/docker/station-db -> /var/lib/postgresql/data`），
// 一旦按缺省跑 teardown，就是 `rm -rf` 真机 dev 库的数据目录。
//
// ⚠️ 本文件是 assertIsolatedEnvironment / resolveDbDir / writeTraefikStatic 的**唯一定义处**；
// 新增 e2e 一律 import，禁止再复制第二份（`node portal/integration/isolation-negative.mjs`
// 里的单一来源断言会把它钉住）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 分配段的判据直接用 portal 自己的解析器（护栏与容器启动期共用同一份代码，不会分叉）；纯函数，不连库。
import { IPAM_POOL_ENV_KEYS, parseCidr, resolveIpamPools } from '../../src/ipam.js';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（本文件位于 portal/integration/lib/）。 */
export const REPO_ROOT = path.resolve(LIB_DIR, '..', '..', '..');
export const TRAEFIK_DEFAULT_STATIC = path.join(REPO_ROOT, 'deploy/traefik/traefik.yml');

/** 共享 dev 栈的既定句柄（e2e 未派生就会命中的那些值，#226 取证行号即指向它们）。 */
export const SHARED_STACK = {
  dbDir: '/docker/station-db',
  composeProjectName: 'station',
  stackId: 'default',
  dbContainer: 'station-db',
  portalContainer: 'station-portal',
  dockerProxyContainer: 'station-docker-proxy',
  edgeContainer: 'station-edge',
  litellmContainer: 'station-litellm',
  portalHostPort: '18080',
  litellmHostPort: '4100',
  traefikWebPort: '8090',
  traefikWebSecurePort: '8443',
  backendSubnet: '172.32.0.0/24',
  // #227.3：共享栈在用的 FDE IPAM 段（portal 缺省池；隔离栈的池不得等于它）。
  fdeIpamPool: '10.200.0.0/16',
  // 宿主回环上占用的端口（含 LiteLLM 容器内 4000/4001 的惯例值）。
  forbiddenPorts: ['4000', '4001', '4100', '8090', '8443', '18080'],
};

/**
 * 大 FDE 池的**保留段**（baseline DDL 钉的：`docs/data/schema.sql` §9 `fde_networks` 的 CHECK
 * `pool='large' ⇒ prefix_len=28 AND subnet::inet << inet '10.201.0.0/16'`；default 同构钉 10.200.0.0/16）。
 * 它同时是三件事的边界：① portal 分配段的合法取值域（`portal/src/ipam.js#resolveIpamPools` 已把它
 * 做成启动期硬判据）；② topology §3「两段保留给 FDE 网络专用」；③ deploy-contract §4.4 的兜底 DROP
 * 只覆盖 `10.200.0.0/16` 与 `10.201.0.0/16` ⇒ 分配段跑出这两段 = 脱离兜底防线。
 *
 * ⇒ #270 之后隔离栈的正确做法不是换一段全新的 /16（那会被 DB CHECK 炸成 23514，#227.3 当初的
 * 「派生段 + 本段两段兜底」就是因为这个：派生段从来没法被真的分配），而是在这段**里面**切子段。
 */
export const PORTAL_LARGE_POOL = '10.201.0.0/16';

/**
 * 隔离栈在保留段里切的片宽（/24）：分配前缀 /28 ⇒ 一片 16 块，够一条 e2e 链路开几个 FDE。
 * 第三段取 1–99（**刻意跳过 0**：`10.201.0.0/24` 是共享栈如果也用 large 池时第一批会分到的位置）。
 */
export const FDE_STACK_SLICE_PREFIX = 24;

/**
 * 宿主/compose 侧的分配段变量名（去 `FDE_` 前缀就是 portal 侧的 `IPAM_POOL_*`；映射见
 * `deploy/docker-compose.yml` 的 station-portal.environment 与 `portal/src/ipam.js#IPAM_POOL_ENV_KEYS`）。
 */
export const FDE_IPAM_POOL_HOST_KEYS = Object.freeze({
  default: 'FDE_IPAM_POOL_DEFAULT',
  large: 'FDE_IPAM_POOL_LARGE',
});

/** 宿主 env → portal 侧 env（护栏拿 portal 那份**同一个解析器**判，不另写一份 CIDR 校验）。 */
export function portalIpamEnvFromHostEnv(env = {}) {
  const out = {};
  for (const [poolName, hostKey] of Object.entries(FDE_IPAM_POOL_HOST_KEYS)) {
    if (env[hostKey] !== undefined) out[IPAM_POOL_ENV_KEYS[poolName]] = env[hostKey];
  }
  return out;
}

/**
 * 由栈 id 确定性派生本隔离栈专用的 FDE IPAM 子段（#227.3 立题，#270 把它做成**真能分配的段**）。
 *
 * 规则：取栈 id 里全部数字拼接后 mod 99 ⇒ 段 = `10.201.(1 + n%99).0/24`（第三段 1–99）；无数字
 * 则用 FNV-1a 短哈希走同一条映射。同 id 永远同段（幂等）；不同余数必不同段。为何不是新的 /16：
 * 见 `PORTAL_LARGE_POOL` 定义处（baseline 的 CHECK 把 `pool='large'` 钉在 `10.201.0.0/16` 里面）。
 *
 * 派生值相同≠一定撞（只有两栈真的并行且同段才撞）；那时显式覆盖两腿即可，护栏允许保留段内的显式覆盖。
 *
 * @param {string} stackId STATION_STACK_ID
 * @returns {string} 形如 `10.201.49.0/24` 的单段 CIDR
 */
export function deriveFdeIpamPools(stackId) {
  const id = String(stackId ?? '');
  const digits = id.replace(/\D+/g, '');
  let n;
  if (digits) {
    // BigInt 防长数字精度丢失；前导零不影响十进制解析。
    n = Number(BigInt(digits) % 99n);
  } else {
    let h = 2166136261; // FNV-1a 32bit
    for (let i = 0; i < id.length; i += 1) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
    n = Math.abs(h) % 99;
  }
  // 保留段只活在上面那个常量里（不拆写第三/四段 ⇒ 改保留段不会漏改这里）。
  const family = PORTAL_LARGE_POOL.split('.');
  return `${family[0]}.${family[1]}.${1 + n}.0/${FDE_STACK_SLICE_PREFIX}`;
}

/**
 * 两腿一次派生（#270 的单一来源）：同一个段同时当
 *   · `FDE_IPAM_POOLS`（→ proxy `IPAM_POOLS`，`network create` 的放行面），与
 *   · `FDE_IPAM_POOL_LARGE`（→ portal `IPAM_POOL_LARGE`，分配器从哪切）。
 * 两腿同值 ⇒ 「分配出来就被 proxy 拒」不再靠人记对齐。
 *
 * @param {string} stackId STATION_STACK_ID
 * @returns {{ FDE_IPAM_POOLS: string, FDE_IPAM_POOL_LARGE: string }}
 */
export function deriveStackIpamPoolEnv(stackId) {
  const segment = deriveFdeIpamPools(stackId);
  return { FDE_IPAM_POOLS: segment, [FDE_IPAM_POOL_HOST_KEYS.large]: segment };
}

/**
 * 脚本缺省注入的 `FDE_IPAM_POOLS`（#270 收紧：**只注入派生段**，不再多送一段）。
 *
 * @param {string} stackId STATION_STACK_ID
 * @returns {string}
 */
export function defaultFdeIpamPools(stackId) {
  return deriveFdeIpamPools(stackId);
}

/**
 * 就地把两腿注入 env（显式传入优先；没栈 id 就不注入，共享栈跑法维持 compose 缺省）。
 * 各 e2e 入口调一次，取代旧「只注入 `FDE_IPAM_POOLS`」那三行（两腿只注入一腿 = 分叉的根源）。
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [stackId] 缺省取 env.STATION_STACK_ID
 * @returns {Record<string, string>} 实际注入了哪些键（供日志/断言；没注入则空对象）
 */
export function applyStackIpamPoolEnv(env = process.env, stackId = env.STATION_STACK_ID) {
  if (!stackId) return {};
  const derived = deriveStackIpamPoolEnv(stackId);
  const applied = {};
  for (const [key, value] of Object.entries(derived)) {
    if (env[key] === undefined || env[key] === '') {
      env[key] = value;
      applied[key] = value;
    }
  }
  return applied;
}

/**
 * `STATION_DB_DIR` 解析（issue #226 修法第 4 条：缺省即抛，不再回退 `/docker/station-db`）。
 *
 * 两条硬失败分支（同修于每一支用到 teardown 的 e2e）：
 *  1. 未设置 ⇒ 抛错，并点名「缺省会 rm -rf 共享 dev 库数据目录」；
 *  2. 设了但不在 OS 临时目录内 ⇒ 也抛（`ERIX_E2E_ALLOW_DB_DIR=1` 是显式豁免，用于真机有意复用某路径）。
 *
 * `allowSharedReset`（#227.1；#661 起 **wp2b 已退役 ⇒ 没有任何调用方**，仅作隔离护栏的夹具语义保留）：调用方**显式声明「我就是要重置共享 dev 库」**——
 * 未设置时不抛、直接解析为共享栈的 `/docker/station-db`；解析结果恰等于该路径时豁免临时目录检查，
 * 其余路径照旧严格（不把豁免面扩大成「任意非临时路径」）。确认这个重置语义前不要复制到别的脚本
 * （`isolation-negative.mjs` 的单一来源断言把出现处钉在 lib + wp2b）。
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{ allowSharedReset?: boolean }} [options]
 * @returns {string} 去掉尾斜杠后的 DB 数据目录（绝对路径）
 */
export function resolveDbDir(env = process.env, { allowSharedReset = false } = {}) {
  const raw = env.STATION_DB_DIR;
  if (!raw) {
    if (allowSharedReset) return SHARED_STACK.dbDir;
    throw new Error(
      `STATION_DB_DIR must be set for isolated e2e：缺省值 ${SHARED_STACK.dbDir} 是共享 dev 栈 station-db 的 `
      + 'bind 源，teardown 的 rm -rf 会直接清掉共享 dev 库的数据目录（issue #226）。'
      + '请显式传 STATION_DB_DIR=<临时目录>/station-db-<栈 id>。',
    );
  }
  const dbDir = String(raw).replace(/\/+$/, '');
  const relative = path.relative(os.tmpdir(), path.resolve(dbDir));
  const insideTempDir = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  const waived = env.ERIX_E2E_ALLOW_DB_DIR === '1' || (allowSharedReset && dbDir === SHARED_STACK.dbDir);
  if (!insideTempDir && !waived) {
    throw new Error(
      `STATION_DB_DIR=${dbDir} 不在临时目录（os.tmpdir()=${os.tmpdir()}）内：`
      + `非临时路径（例如共享栈的 ${SHARED_STACK.dbDir}）被 rm -rf 会带走真实数据。`
      + '确认该路径可以被删就显式设 ERIX_E2E_ALLOW_DB_DIR=1。',
    );
  }
  return dbDir;
}

/**
 * 删除 DB 数据目录：先解析路径（缺省/越界 ⇒ 抛，见 resolveDbDir），再经临时 root 容器删
 *（postgres 会把目录 chown 到 999，宿主用户删不动）。docker 调用失败**不**抛（teardown 语义），
 * 但 env 缺省错误一定抛（且在调用 docker **之前**抛——不会先把 rm -rf 发出去）。
 *
 * @param {(args: string) => unknown} docker 该脚本的 docker 执行器
 * @param {Record<string, string | undefined>} [env]
 * @param {{ allowSharedReset?: boolean }} [options] 见 resolveDbDir（只允许 wp2b 声明）
 */
export function removeDbDir(docker, env = process.env, options = {}) {
  assert.ok(typeof docker === 'function', 'removeDbDir: docker executor is required');
  const dbDir = resolveDbDir(env, options);
  const parent = path.posix.dirname(dbDir);
  const name = path.posix.basename(dbDir);
  try {
    docker(`run --rm -v ${JSON.stringify(parent)}:/host alpine rm -rf ${JSON.stringify(`/host/${name}`)}`);
  } catch {
    return null;
  }
  return undefined;
}

/**
 * 生成该脚本专用的 `removeDbDir()` 闭包（各 e2e 的 docker 执行器是本地函数，这样调用点保持零参数）。
 *
 * @param {{ docker: (args: string) => unknown, env?: Record<string, string | undefined>, allowSharedReset?: boolean }} opts
 *   allowSharedReset 原先只允许 wp2b（共享栈重置）传；wp2b 退役后无调用方，见 resolveDbDir 与单一来源断言。
 * @returns {{ removeDbDir: () => void, dbDir: () => string }}
 */
export function createDbDirCleaner({ docker, env = process.env, allowSharedReset = false }) {
  assert.ok(typeof docker === 'function', 'createDbDirCleaner: docker executor is required');
  const options = { allowSharedReset };
  return {
    dbDir: () => resolveDbDir(env, options),
    removeDbDir: () => removeDbDir(docker, env, options),
  };
}

/**
 * 硬隔离护栏。判据与 #215/#224 定稿的 wp5/wp6 版本逐条一致（在此放宽 = 退回假绿）。
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env] 默认 process.env
 * @param {boolean} [options.litellm=true] 该栈是否含 LiteLLM（wp2a 不带 litellm profile ⇒ false）
 * @param {{ env: string, value: string, sharedDefault?: string }[]} [options.fdeNames]
 *   该脚本使用的 FDE 名：env 名 + 实际取值 + 共享栈既定名（默认 alice）。必须含唯一栈 id，
 *   否则 `fde-<name>` 容器/网络会与共享栈同名互删。
 * @param {string[]} [options.extraRequiredEnv] 脚本专属必需 env
 * @param {[string, string][]} [options.extraForbiddenEnv] 脚本专属「不得等于共享栈值」对
 */
// ---------------------------------------------------------------------------
// issue #412 ④：宿主**写路径**必须逐条证明是隔离的，"没报错"不等于隔离。
//
// 事故现场（2026-10-26，部署机）：手工 `docker compose -p e2e40 --env-file deploy/.env up -d` 起了
// 一套隔离栈，四个隔离变量都设了，唯独没设 `TRAEFIK_DYNAMIC_DIR_HOST`。它**不是没值**——
// `--env-file` 把生产 `.env` 里的 `/docker/station-edge/dynamic` 带了进来，于是隔离 portal 把路由
// 写进了**生产边缘正在读的那份文件**，上游被改成 `http://127.0.0.1:28080`（隔离栈自己的 portal 端口，
// 宿主上没人监听）⇒ `http://station.vc.cn-ai.vip:8090/` 全线 502，而 `docker ps` 里全部 healthy。
//
// 所以这条判据的形状很重要：compose 里写 `${VAR:-默认}` **挡不住**这件事，因为默认值根本不缺,
// 缺的是"这个值是不是我这套栈的"。判据必须是"与共享 `.env` 里的值不相等"，而不是"有没有设"。
// ---------------------------------------------------------------------------
export const HOST_WRITE_PATH_ENVS = Object.freeze([
  'TRAEFIK_DYNAMIC_DIR_HOST', // 边缘网关动态配置目录：写错 = 直接改写生产路由（本次事故就是它）
  'ERIX_USERSPACE_ROOT_HOST', // FDE 用户空间：写错 = 隔离用户目录落进生产 userspace
  'ERIX_ARTIFACTS_ROOT_HOST', // run 产物卷：写错 = 产物混进生产
  'STATION_DB_DIR', // 库文件目录：写错 = 两个实例开同一份数据文件
]);

/**
 * 单行 env 的解析（口径对齐**真 compose**，不是自洽就行）。
 *
 * 下面的规则全部来自实测（Docker Compose 2.40.3，命令与输出拄在
 * `test/integration-e2e-preflight.test.js` 的 `COMPOSE_PARSE_CASES` 里，那一格直接拿 compose 自己当基准）：
 *
 * | 写法                              | compose 看到的        | 为什么重要 |
 * |-----------------------------------|-----------------------|------------|
 * | `K=/a/b # shared`                 | `/a/b`                | **本单 BLOCKER**：不剥就与真路径不等 ⇒ 「与共享路径不同」在危险方向上恒真 |
 * | `K="/c/d" # after quoted`         | `/c/d`                | 引号闭合后的注释也得剥 |
 * | `K=/g/h#nospace`                  | `/g/h#nospace`        | `#` 前面不是空格就**不是**注释 |
 * | `K=/a/b<TAB>#tab`                 | `/a/b<TAB>#tab`       | tab 也不算注释起始（只有空格算）|
 * | `K="#q# inside"`                  | `#q# inside`          | 引号内的 `#` 是正文 ⇒ 不能误剥（反向自证那格）|
 * | `K=  spaced value  # tail`        | `spaced value`        | 前导/尾随空白会去 |
 * | `K=#hash first`                   | `#hash first`         | 值首的 `#` 是字面量 |
 * | `K="` 未闭合 / `K="v"junk`      | **compose 直接报错**   | 我们复现不了 ⇒ 交给 `kind:'unparsable'` |
 *
 * 另外 compose 会展开 `$VAR` / `${VAR}`（实测 `/a/${QQ}b` ⇒ `/a/b`），我们**复现不了展开上下文**
 * ⇒ 只把这一类标 `interpolates`，由调用方决定要不要拒（同文件里 `$` 很常见，一律拒会误杀）。
 *
 * @param {string} line 单行原文（可以带 \r）
 * @returns {{kind: 'blank'|'pair'|'unparsable', key?: string, value?: string, inlineComment?: boolean,
 *   interpolates?: boolean, why?: string}}
 */
export function parseComposeEnvLine(line) {
  const raw = String(line ?? '').replace(/\r$/, '');
  const stripped = raw.trim();
  if (!stripped || stripped.startsWith('#')) return { kind: 'blank' };
  const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(raw);
  if (!m) return { kind: 'unparsable', raw, why: '不是 KEY=VALUE 形态' };
  const [, key] = m;
  const lead = m[2].replace(/^[ \t]+/, '');   // 前导空白会被 compose 去掉
  const quote = lead[0] === '"' || lead[0] === "'" ? lead[0] : null;
  if (quote) {
    const end = lead.indexOf(quote, 1);
    if (end === -1) return { kind: 'unparsable', key, raw, why: `未闭合的引号 ${quote}` };
    const inner = lead.slice(1, end);
    const tail = lead.slice(end + 1);
    if (/^[ \t]*$/.test(tail)) return { kind: 'pair', key, value: inner, quoted: true, inlineComment: false, interpolates: inner.includes('$') };
    if (/^[ \t]+(#|$)/.test(tail)) return { kind: 'pair', key, value: inner, quoted: true, inlineComment: true, interpolates: inner.includes('$') };
    return { kind: 'unparsable', key, raw, why: `引号闭合后还有垃圾：${tail}` };
  }
  // 未加引号：从**第一个「空格 + #」**处切开（tab 与值首的 # 都不是注释起始 —— 实测）
  let cut = -1;
  for (let i = 1; i < lead.length; i += 1) {
    if (lead[i] === '#' && lead[i - 1] === ' ') { cut = i; break; }
  }
  const value = (cut === -1 ? lead : lead.slice(0, cut)).replace(/[ \t]+$/, '');
  return { kind: 'pair', key, value, quoted: false, inlineComment: cut !== -1, interpolates: value.includes('$') };
}

/**
 * 整份 env 文件：返回 compose 会看到的值 + 每一行的解析账（要拒哪一行得能点名行号）。
 * 文件不存在 ⇒ `{ values: {}, lines: [], missing: true }`（CI 的 worktree 里就没有 `deploy/.env`）。
 *
 * @param {string} envFile
 * @returns {{values: Record<string,string>, lines: object[], missing: boolean}}
 */
export function parseComposeEnvFile(envFile) {
  let text;
  try {
    text = fs.readFileSync(envFile, 'utf8');
  } catch {
    return { values: {}, lines: [], missing: true };
  }
  const values = {};
  const lines = [];
  text.split('\n').forEach((raw, index) => {
    const parsed = parseComposeEnvLine(raw);
    if (parsed.kind === 'blank') return;
    const entry = { no: index + 1, raw: raw.replace(/\r$/, ''), ...parsed };
    lines.push(entry);
    if (parsed.kind === 'pair') values[parsed.key] = parsed.value;   // 后写的赢（与 compose 一致）
  });
  return { values, lines, missing: false };
}

/** 读 `deploy/.env`（只取 `KEY=VALUE`，按 compose 的口径处理注释/引号）。缺文件返回 {}。 */
export function readEnvFile(envFile) {
  return parseComposeEnvFile(envFile).values;
}

/**
 * 找出「我们**无从证明 compose 会拿到什么**」的键值行（PR #554 复审 BLOCKER，A 案）。
 *
 * 为什么要拒而不是猜：旧解析把未加引号值的行内注释**整段留在值里**，于是
 * `TRAEFIK_DYNAMIC_DIR_HOST=/docker/station-edge/dynamic # shared` 解析成
 * `"/docker/station-edge/dynamic # shared"` ⇒ 与真路径 `/docker/station-edge/dynamic` **不相等**
 * ⇒ 「与共享路径不同」这个隔离判据在**危险方向上恒真**（隔离栈照旧往生产目录写，而预检绿）。
 * 剥注释也能修这一格，但那就变成「我们的解析器认为 compose 会怎么读」——需要一条外部基准才能站住。
 * 预检的取向是宁可起跑前红，所以这里直接拒，并点名**文件 + 行号 + 键名 + 原文**。
 *
 * 只查隔离判据会用的那几个键（{@link HOST_WRITE_PATH_ENVS}）：全文件一律拒会误杀真 `.env` 里
 * `POSTGRES_PASSWORD=xxxx # 说明` 这种合法行（实测本仓库 `deploy/.env` 里就有三行）。
 *
 * @param {{lines: object[]}} parsed {@link parseComposeEnvFile} 的返回
 * @param {string[]} [keys] 要盯的键
 * @returns {Array<object>} 带 `why` 的行（空数组 = 全部可复现）
 */
export function findUnreproducibleEnvLines(parsed, keys = HOST_WRITE_PATH_ENVS) {
  const out = [];
  for (const line of parsed?.lines ?? []) {
    if (!keys.includes(line.key)) continue;
    if (line.kind === 'unparsable') {
      out.push({ ...line, why: `我们解析不了（${line.why}），compose 会看到什么无从证明` });
      continue;
    }
    if (line.kind !== 'pair') continue;
    if (!line.quoted && line.inlineComment) {
      out.push({
        ...line,
        why: `值里带**未加引号**的行内注释：原文 ${JSON.stringify(line.raw.trim())} 而 compose 读到的是 ${JSON.stringify(line.value)}`
          + ' ⇒ 两者不等，「与共享路径不同」会在危险方向上恒真',
      });
      continue;
    }
    if (line.interpolates) {
      out.push({ ...line, why: `值里有 $ 插值（compose 会展开，我们看不到它的展开上下文）⇒ 无从证明 compose 拿到的就是这个字符串` });
    }
  }
  return out;
}

/**
 * 断言"我这套栈要写的宿主目录，一个都不是共享栈的那一份"。
 * @param {{env?: Record<string,string|undefined>, envFile?: string|null, label?: string}} [options]
 */
export function assertHostWritePathsIsolated({
  env = process.env,
  envFile = 'deploy/.env',
  label = '隔离实例',
} = {}) {
  if (!envFile) return { checked: [], shared: {} };
  const parsed = parseComposeEnvFile(envFile);
  const shared = parsed.values;
  const risky = findUnreproducibleEnvLines(parsed);
  if (risky.length > 0) {
    const fixed = 'KEY="/docker/erix/users" # 想写注释就加引号，或直接挪到上一行';
    throw new Error(
      `${label} 的 env 文件 ${envFile} 里有 ${risky.length} 行我们无从证明 compose 会拿到什么（这些键是**宿主写路径**）：\n  `
      + `- ${risky.map((l) => `${envFile}:${l.no} ${l.key}（原文 ${JSON.stringify(l.raw.trim())}）：${l.why}`).join('\n  - ')}`
      + `\n⇒ 判错方向 = 隔离栈往**生产的目录**里写（现网实测过一次：边缘路由被覆写，8090 全线 502 而容器全绿）。`
      + `改法：${fixed}`,
    );
  }
  const collisions = [];
  for (const key of HOST_WRITE_PATH_ENVS) {
    const mine = env[key];
    const theirs = shared[key];
    if (!mine) {
      // 没设 ⇒ compose 会用默认值或 env-file 的值，两种都不是"我这套栈的目录"。
      collisions.push(`${key} 未设置（会落到 compose 默认值或 ${envFile} 里的 ${theirs ?? '默认值'}）`);
      continue;
    }
    if (!path.isAbsolute(mine)) collisions.push(`${key}=${mine} 不是绝对路径`);
    if (theirs && theirs.replace(/\/+$/, '') === String(mine).replace(/\/+$/, '')) {
      collisions.push(`${key}=${mine} 与共享栈共用同一份（${envFile}）`);
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      `${label} 的宿主写路径未被证明隔离：\n  - ${collisions.join('\n  - ')}\n`
      + '⇒ 这套栈会往**生产的目录**里写。现网实测过一次：隔离 portal 覆写边缘路由文件，8090 全线 502，而容器全绿。',
    );
  }
  return { checked: [...HOST_WRITE_PATH_ENVS], shared };
}

/**
 * ⚠ `assertHostWritePathsIsolated` **不在这里调**：它是"起栈那一刻"的判据，要判的是
 * **compose 真正拿到的那份 env**。各脚本只在 `compose('up', extraEnv)` 里传这三个 `ERIX_*` 路径，
 * `process.env` 里往往没有 ⇒ 放进总断言会误伤所有老脚本（判错方向比不判更糟）。
 * 谁 `up` 栈谁调，传 `{...process.env, ...extraEnv}`。
 */
export function assertIsolatedEnvironment(options = {}) {
  const {
    env = process.env,
    litellm = true,
    fdeNames = [],
    extraRequiredEnv = [],
    extraForbiddenEnv = [],
  } = options;

  const containerNames = ['STATION_DB_NAME', 'STATION_PORTAL_NAME', 'STATION_DOCKER_PROXY_NAME', 'STATION_EDGE_NAME'];
  const portEnvs = ['PORTAL_HOST_PORT', 'TRAEFIK_WEB_PORT', 'TRAEFIK_WEBSECURE_PORT'];
  if (litellm) {
    containerNames.push('STATION_LITELLM_NAME');
    portEnvs.unshift('LITELLM_HOST_PORT');
  }

  const required = [
    'STATION_DB_DIR', 'COMPOSE_PROJECT_NAME', 'STATION_STACK_ID',
    'STATION_DB_NAME', 'STATION_PORTAL_NAME', 'STATION_DOCKER_PROXY_NAME', 'STATION_EDGE_NAME',
    'PORTAL_HOST_PORT', 'TRAEFIK_WEB_PORT', 'TRAEFIK_WEBSECURE_PORT',
    'STATION_PORTAL_IMAGE', 'STATION_DOCKER_PROXY_IMAGE', 'FDE_IMAGE',
    'BACKEND_SUBNET', 'FDE_POOL', 'FDE_IPAM_POOLS', FDE_IPAM_POOL_HOST_KEYS.large,
    ...(litellm ? ['STATION_LITELLM_NAME', 'LITELLM_HOST_PORT'] : []),
    ...fdeNames.map((fde) => fde.env),
    ...extraRequiredEnv,
  ];
  for (const name of required) assert.ok(env[name], `${name} must be set for isolated e2e`);

  const dbRelativePath = path.relative(os.tmpdir(), path.resolve(env.STATION_DB_DIR));
  assert.ok(dbRelativePath && !dbRelativePath.startsWith('..') && !path.isAbsolute(dbRelativePath),
    'STATION_DB_DIR must be inside the OS temporary directory');
  assert.ok(!fs.existsSync(env.STATION_DB_DIR), 'STATION_DB_DIR must be a fresh, nonexistent directory');

  const forbidden = [
    ['COMPOSE_PROJECT_NAME', SHARED_STACK.composeProjectName],
    ['STATION_STACK_ID', SHARED_STACK.stackId],
    ['STATION_DB_NAME', SHARED_STACK.dbContainer],
    ['STATION_PORTAL_NAME', SHARED_STACK.portalContainer],
    ['STATION_DOCKER_PROXY_NAME', SHARED_STACK.dockerProxyContainer],
    ['STATION_EDGE_NAME', SHARED_STACK.edgeContainer],
    ['PORTAL_HOST_PORT', SHARED_STACK.portalHostPort],
    ['TRAEFIK_WEB_PORT', SHARED_STACK.traefikWebPort],
    ['TRAEFIK_WEBSECURE_PORT', SHARED_STACK.traefikWebSecurePort],
    ['BACKEND_SUBNET', SHARED_STACK.backendSubnet],
    ...(litellm ? [['STATION_LITELLM_NAME', SHARED_STACK.litellmContainer], ['LITELLM_HOST_PORT', SHARED_STACK.litellmHostPort]] : []),
    ...fdeNames.map((fde) => [fde.env, fde.sharedDefault ?? 'alice']),
    ...extraForbiddenEnv,
  ];
  for (const [name, sharedValue] of forbidden) {
    assert.notEqual(env[name], sharedValue, `${name} must not target the shared stack`);
  }

  assert.equal(env.FDE_POOL, 'large', 'isolated e2e must use the dedicated large FDE pool');
  // #227.3 → #270：从「等值 10.201.0.0/16」改成「按栈派生的保留段子段」，而且现在**两腿都要判**：
  //   腿 A（放行面 FDE_IPAM_POOLS）：每段必须落在隔离族 10.201.0.0/16–10.299.0.0/16 里；共享段
  //     10.200.0.0/16（portal 缺省池 / 共享栈 fde-* 网络所在地）一律拒 —— fail-closed。
  //   腿 B（分配段 FDE_IPAM_POOL_LARGE → portal IPAM_POOL_LARGE）：必须被 portal 自己的启动期校验
  //     接受（即落在 DDL 保留段 10.201.0.0/16 内）、必须是保留段的**真子段**（整段 = 并行必撞的
  //     旧口径）、且必须被腿 A 的放行面覆盖（不覆盖 = provision 建 fde-* 网络被 proxy 拒）。
  //     失败文案**同时点名两侧变量名**（工单判据④）。
  const fdeIpamPools = String(env.FDE_IPAM_POOLS).split(',').map((pool) => pool.trim()).filter(Boolean);
  assert.ok(fdeIpamPools.length > 0, `FDE_IPAM_POOLS=${env.FDE_IPAM_POOLS} 不含任何有效 CIDR`);
  const parsedWhitelist = [];
  for (const pool of fdeIpamPools) {
    assert.notEqual(pool, SHARED_STACK.fdeIpamPool,
      `FDE_IPAM_POOLS 含共享栈在用的段 ${pool}（portal 缺省池/共享栈 fde-* 网络在此，并行必撞）；本栈应用派生段 deriveFdeIpamPools(STATION_STACK_ID)=${deriveFdeIpamPools(env.STATION_STACK_ID)}`);
    let parsed;
    try {
      parsed = parseCidr(pool);
    } catch {
      assert.fail(`FDE_IPAM_POOLS=${pool} 不是合法 CIDR（正规值=派生段 ${deriveFdeIpamPools(env.STATION_STACK_ID)}）`);
    }
    if (parsed.base !== parsed.ipInt) {
      assert.fail(`FDE_IPAM_POOLS=${pool} 不是规范网络地址（主机位必须全 0；否则护栏与 portal 的口径会对不上）`);
    }
    const octets = pool.split('.');
    const secondOctet = Number(octets[1]);
    assert.ok(octets[0] === '10' && secondOctet >= 201 && secondOctet <= 299,
      `FDE_IPAM_POOLS=${pool} 必须留在隔离族 10.201.0.0/16–10.299.0.0/16 内（正规值=派生段 ${deriveFdeIpamPools(env.STATION_STACK_ID)}）`);
    parsedWhitelist.push(parsed);
  }
  // 腿 B：分配段（#270 的旋钮）。拿 portal 自己的解析器判 —— 护栏红 = 容器也会同样红。
  const allocHostKey = FDE_IPAM_POOL_HOST_KEYS[env.FDE_POOL];
  let resolvedPools;
  try {
    resolvedPools = resolveIpamPools(portalIpamEnvFromHostEnv(env));
  } catch (err) {
    assert.fail(`${allocHostKey}=${env[allocHostKey]} 被 portal 自己的启动期校验拒了（容器会以同样的原因起不来）：${err.message}`);
  }
  const allocSegment = resolvedPools[env.FDE_POOL].cidr;
  assert.equal(allocSegment, String(env[allocHostKey]).trim(),
    `${allocHostKey}=${env[allocHostKey]} 不是规范写法（portal 会把它压成 ${allocSegment}）；正规值=派生段 ${deriveFdeIpamPools(env.STATION_STACK_ID)}`);
  assert.notEqual(allocSegment, PORTAL_LARGE_POOL,
    `${allocHostKey}=${allocSegment} 是**整个**保留段 = #270 之前「两套隔离栈都从 10.201.0.0/16 池头分配」的必撞口径；`
    + `请切子段（正规值=派生段 ${deriveFdeIpamPools(env.STATION_STACK_ID)}）`);
  const parsedAlloc = parseCidr(allocSegment);
  assert.ok(
    parsedWhitelist.some((w) => w.base <= parsedAlloc.base && parsedAlloc.last <= w.last),
    `分配段 ${allocSegment}（portal 侧 ${IPAM_POOL_ENV_KEYS[env.FDE_POOL]} ← 宿主侧 ${allocHostKey}）没被本栈放行面 `
    + `FDE_IPAM_POOLS=${env.FDE_IPAM_POOLS} 覆盖 ⇒ provision 建 fde-* 网络会被 proxy 拒（IPAM.Subnet not in allowed pools）；`
    + '两头必须同源（正规跑法：deriveStackIpamPoolEnv(栈 id) 一次派生喂两腿）',
  );
  assert.equal(env.COMPOSE_PROJECT_NAME, env.STATION_STACK_ID,
    'compose project and stack label must use the same unique ID');
  for (const name of containerNames) {
    assert.ok(env[name].endsWith(`-${env.STATION_STACK_ID}`), `${name} must include the unique stack ID`);
  }
  for (const name of ['STATION_PORTAL_IMAGE', 'STATION_DOCKER_PROXY_IMAGE', 'FDE_IMAGE']) {
    // #227.1：digest 钉定的 FDE 镜像不适用唯一 tag 要求（内容寻址，天然不撞共享 tag）。
    if (name === 'FDE_IMAGE' && env[name].includes('@sha256:')) continue;
    assert.ok(env[name].endsWith(`:${env.STATION_STACK_ID}`), `${name} must use a unique image tag`);
  }
  // #227.1（主 agent 真跑 #226 踩的坑）：`image:tag` 形态的 FDE 镜像必须显式 FDE_DEV_MODE=1——
  // portal 在非 dev 模式只接受 digest 形态（portal/src/config.js:83-86/122），没显式声明 provision 直接拒；
  // digest（@sha256:）形态是生产铉定，不要求。
  if (!String(env.FDE_IMAGE).includes('@sha256:')) {
    assert.equal(env.FDE_DEV_MODE, '1',
      'FDE_DEV_MODE must be 1 when FDE_IMAGE is image:tag（tag 形态不显式声明 dev 模式会被 portal 生产门拒跑；digest 形态豁免）');
  }
  for (const fde of fdeNames) {
    assert.match(fde.value, /^[a-z0-9][a-z0-9-]{0,62}$/, `${fde.env} must be a safe FDE name`);
    assert.ok(fde.value.includes(env.STATION_STACK_ID), `${fde.env} must include the unique stack ID`);
  }
  assert.equal(new Set(fdeNames.map((fde) => fde.value)).size, fdeNames.length,
    'isolated FDE names must be distinct');

  const ports = portEnvs.map((name) => env[name]);
  assert.equal(new Set(ports).size, ports.length, 'isolated e2e ports must be distinct');
  for (const port of ports) {
    assert.match(port, /^\d{2,5}$/);
    assert.ok(Number(port) <= 65535);
    assert.ok(!SHARED_STACK.forbiddenPorts.includes(port),
      `isolated e2e must not use a shared-stack port (${port})`);
  }
  if (litellm) {
    assert.equal(env.LLM_GATEWAY_HOST, `http://127.0.0.1:${env.LITELLM_HOST_PORT}`,
      'LLM_GATEWAY_HOST must target the isolated LiteLLM publish port');
  }
}

/**
 * 宿主回环端口可用性预探（#224 带来，#226 一并提到公共模块，wp2a/wp3a/wp5/wp6 共用一份）：
 * 撞共享栈入口端口时 compose 只会报 EADDRINUSE 或——更坑——curl 打到**共享 edge** 上假绿。
 *
 * @param {string[]} ports 待验证的宿主端口
 * @param {{ host?: string }} [options]
 */
export async function assertHostPortsAvailable(ports, { host = '127.0.0.1' } = {}) {
  for (const port of ports) {
    const server = net.createServer();
    // eslint-disable-next-line no-await-in-loop -- 串行探测才能给出第一个被占的端口名
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(port), host, () => server.close(resolve));
    }).catch((error) => {
      throw new Error(`isolated e2e port ${port} is unavailable: ${error.message}`);
    });
  }
}

/**
 * 生成「只改入口端口」的临时 Traefik 静态配置并返回其宿主路径（F8：`--configFile` 在场时
 * CLI 覆盖不生效，必须整体替换静态文件，否则隔离栈的 edge 仍会去抢共享栈的 8090/8443）。
 *
 * @param {string} dir 目标目录（调用方的临时目录）
 * @param {{ repoRoot?: string, webPort: string, websecurePort: string }} opts
 * @returns {string} 生成的 traefik.yml 路径
 */
export function writeTraefikStatic(dir, { repoRoot = REPO_ROOT, webPort, websecurePort, adminPort = null }) {
  assert.ok(webPort, 'writeTraefikStatic: webPort is required');
  assert.ok(websecurePort, 'writeTraefikStatic: websecurePort is required');
  const source = fs.readFileSync(path.join(repoRoot, 'deploy/traefik/traefik.yml'), 'utf8');
  assert.ok(source.includes('address: ":8090"') && source.includes('address: ":8443"'),
    'Traefik static config has the expected entrypoint addresses');
  let output = source
    .replace('address: ":8090"', `address: ":${webPort}"`)
    .replace('address: ":8443"', `address: ":${websecurePort}"`);
  // #261117 实测：`traefik.yml` 里还有**第三个写死端口** `:9443`（管理台入口 adminsecure，
  // 见 AGENTS.md §5「端口在 traefik.yml 里写死」）。隔离栈的 edge 是 `network_mode: host`，
  // 不换它就会跟**共享栈**的 9443 撞端口 ⇒ 容器 `Restarting (1)` 崩循环、整个隔离栈的入口不监听，
  // 下游 e2e 全部连不上（wp2a 段⑥ curl 退出码 7 就是这么来的）。
  if (adminPort) output = output.replace('address: ":9443"', `address: ":${adminPort}"`);
  // ⚠ 硬闸（261117 实测的根因）：隔离栈的 web 端口一旦不是共享栈的 8090，就**必须**换掉管理口 9443——
  // 否则 edge 是 host 网络、与共享栈的 9443 撞端口 ⇒ 容器 `Restarting (1)` 崩循环 ⇒ 整个隔离栈**没有入口**
  // ⇒ 下游 agentd 连不上 SSE、所有直连/路由断言 curl 退出码 7，而症状看起来像「网络问题」。
  // 之前 wp3a/wp3b/wp5/wp6 四个调用点全都漏传 ⇒ 它们从来没在隔离模式跑通过。
  if (String(webPort) !== '8090') {
    if (!adminPort) {
      throw new Error('writeTraefikStatic: 隔离跑法必须传 adminPort（web 端口≠8090 时管理口 :9443 会与共享栈撞端口，'
        + 'edge 会崩循环、整个隔离栈没有入口）。传 process.env.TRAEFIK_ADMIN_PORT 或一个与共享栈不同的端口。');
    }
    if (output.includes('address: ":9443"')) {
      throw new Error(`writeTraefikStatic: 静态配置里仍有共享栈的管理口 :9443（adminPort=${adminPort}）⇒ 替换没生效`);
    }
  }
  const target = path.join(dir, 'traefik.yml');
  fs.writeFileSync(target, output);
  return target;
}

/**
 * compose up **之前**在 Traefik 动态目录预写 `routes.yml` 桩（issue #268 决策 4：edge watch 存量坑修法）。
 *
 * 为什么必须预写：Traefik v3 file provider 在**启动时刻**对目录内已存在的文件建立 watch；
 * 启动时动态目录里没有 `routes.yml`，watch 就落在那个「尚不存在的 inode」上，之后 materializer
 * 的原子替换（tmp 写 → rename，见 portal/src/routes.js 头部注释）产生的是**新 inode**，
 * inotify 永远不会把这次替换报给 watch → 整栈健康、DB 有路由、但 internal/预览全 404，
 * `docker restart <edge>` 立刻通（e2e262 实测复现，AGENTS §8.18「edge file-provider watch 坑」）。
 * 预写一份 `http: {}` 空桩让启动即有文件可 watch，之后 materializer 的替换就能被 reload 捕获。
 *
 * ⚠️ 幂等红线：`routes.yml` **已存在则一字不动**——桩绝不能覆盖 materializer 的产物（把真实路由
 * 压回 `http: {}` 就等于亲手制造 404）。「存在不覆盖」由 `isolation-negative.mjs` 的桩语义断言钉住
 * （改成无条件覆盖即红）。
 *
 * @param {string} dynamicDir 该脚本的 Traefik 动态临时目录（mkdtemp 之后、任何 compose up 之前调用）
 * @returns {{ file: string, created: boolean }} 桩路径 + 是否新写（存在而未动 ⇒ created=false）
 */
export function writeDynamicStub(dynamicDir) {
  assert.ok(dynamicDir, 'writeDynamicStub: dynamicDir is required');
  const target = path.join(dynamicDir, 'routes.yml');
  if (fs.existsSync(target)) return { file: target, created: false };
  fs.writeFileSync(target, 'http: {}\n');
  return { file: target, created: true };
}

/**
 * 隔离栈的 `IPAM_RESERVED_SUBNETS` 派生本体（#268 M2：从 wp3b 的 deriveIsolationEnv() 提出来，
 * wp3b/wp3a 共用；扫描行为与原实现逐字等价，「是否隔离模式 / 是否已显式传」的开关留给调用方）。
 *
 * 为什么要派生：portal 的 IPAM 池**硬编码**（portal/src/ipam.js:12-15，10.200.0.0/16，**非 env 可配**），
 * 隔离栈 DB 是空的 → 会从池头分配 10.200.0.0/29，与共享栈已占段**重叠**（实测 403 Pool overlaps）；
 * 故把**其他栈已用的 fde-* 网络子网**（排除本栈自己的 `ownFdeNetwork`）列进保留段。
 *
 * @param {object} opts
 * @param {(args: string) => string} opts.docker 该脚本的 docker 执行器（只读 network ls/inspect）
 * @param {string} opts.ownFdeNetwork 本栈自己的 fde 网络名（`fde-<FDE_NAME>`，扫描时排除）
 * @param {Record<string, string>} [opts.baseEnv] 要并入的基础 env（通常是 composeDomainEnv() 的产物；
 *   不需要就缺省 {}，此时返回值只含派生出的 IPAM_RESERVED_SUBNETS）
 * @param {boolean} [opts.skipIpamReserved] true = 不扫描不注入（调用方已显式传 IPAM_RESERVED_SUBNETS 的语义）
 * @returns {Record<string, string>} baseEnv 副本（+ 派生出的 IPAM_RESERVED_SUBNETS，若扫到）
 */
export function deriveIsolationComposeEnv({ docker, ownFdeNetwork, baseEnv = {}, skipIpamReserved = false }) {
  assert.ok(typeof docker === 'function', 'deriveIsolationComposeEnv: docker executor is required');
  assert.ok(ownFdeNetwork, 'deriveIsolationComposeEnv: ownFdeNetwork is required');
  const out = { ...baseEnv };
  if (skipIpamReserved) return out;
  const safe = (fn) => { try { return fn(); } catch { return null; } };
  const names = (safe(() => docker('network ls --format {{.Name}}')) || '')
    .split('\n').map((s) => s.trim())
    .filter((n) => n.startsWith('fde-') && n !== ownFdeNetwork);
  const subnets = [...new Set(names.map((n) => safe(() => {
    // format 含空格，必须单引号包裹（docker() 把整条命令包进包装层 "..."，
    // 内层 sh 会对未引用的 {{json .IPAM.Config}} 做词拆分 → Go 模板 unclosed action）。
    const cfg = JSON.parse(docker(`network inspect ${n} --format '{{json .IPAM.Config}}'`));
    return cfg?.[0]?.Subnet || null;
  })).filter(Boolean))];
  if (subnets.length > 0) out.IPAM_RESERVED_SUBNETS = subnets.join(',');
  return out;
}

/**
 * 惰性求值 + 记忆化（#268 M2，原 wp3b 的 isolationEnvCache 形态）：派生要查 docker，
 * 每次 compose() 都重跑太贵；首次调用算一次，之后永远返回同一结果。
 *
 * @param {() => unknown} fn 被记忆化的零参函数
 * @returns {() => unknown}
 */
export function memoizeOnce(fn) {
  assert.ok(typeof fn === 'function', 'memoizeOnce: function is required');
  let cache;
  return () => {
    if (cache === undefined) cache = fn();
    return cache;
  };
}
