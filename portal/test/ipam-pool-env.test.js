// issue #270：portal IPAM **分配段**参数化（`IPAM_POOL_DEFAULT` / `IPAM_POOL_LARGE`，
// 宿主/compose 侧 `FDE_IPAM_POOL_DEFAULT` / `FDE_IPAM_POOL_LARGE`）的单测 + 与 fde-proxy
// 放行面（`IPAM_POOLS` / `FDE_IPAM_POOLS`）的交叉核对。
//
// 为什么这条单测必须存在（而不是「跑一下 e2e 看看」）：本单的失效形状全是**静默**的 ——
//   · 缺省值写歪一位 → 现网所有 FDE 网络换段，但没人报错（路由/防火墙按 subnet 派生，看起来还"对"）；
//   · 只改分配段没改放行面 → 分配得到、`network create` 被 proxy 拒（provision 期才炸）；
//   · 脏值被"半个生效"（`10.201.0.7/16` 静默压成 `10.201.0.0/16`）→  那族 `parseInt('1e4')===1`。
// 所以判据打到**字面值 + err.code + 文案点名的变量名**，而不是"有没有抛"。
//
// 四条判据（工单 §验收，每条都注明它治的是哪一种红）：
//   ① 不设 env ⇒ 两个池与 #270 之前逐字相同（反向自证，含**真子进程**的模块加载路径）
//   ② 注入 IPAM_POOL_LARGE ⇒ 分配段随之变，且该段在 proxy 放行面内能过 validateNetworkBody
//   ③ 坏 CIDR / 坏前缀 ⇒ 当场抛 ipam_pool_env_invalid 并点名是哪个旋钮
//   ④ 分配段不在放行面 ⇒ 明确失败，且文案同时点名两侧变量名（IPAM_POOLS/FDE_IPAM_POOLS 与 IPAM_POOL_*/FDE_IPAM_POOL_*）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

import {
  applyStackIpamPoolEnv,
  assertIsolatedEnvironment,
  deriveFdeIpamPools,
  deriveStackIpamPoolEnv,
  ipamPoolCongruenceClass,
} from '../integration/lib/isolated-env.mjs';

import {
  POOLS,
  DEFAULT_IPAM_POOLS,
  IPAM_POOL_ENV_KEYS,
  resolveIpamPools,
  nextAvailableSubnet,
} from '../src/ipam.js';
import { FDE_IPAM_POOLS } from '../src/routebackends.js';
import { validateNetworkBody } from '../../deploy/fde-proxy/server.js';

const COMPOSE = new URL('../../deploy/docker-compose.yml', import.meta.url);
const IPAM_MODULE = new URL('../src/ipam.js', import.meta.url);

/** #270 之前 `portal/src/ipam.js` 里硬编码的那两个字面量（逐字，不是"等价"）。 */
const PRE_270_LITERALS = {
  default: { cidr: '10.200.0.0/16', prefixLen: 29 },
  large: { cidr: '10.201.0.0/16', prefixLen: 28 },
};

/** 取 compose 里 `${VAR:-默认}` 的默认段（口径照 `deploy-env-defaults.test.js`，不另造一套）。 */
function interpolationDefault(value) {
  const m = /^\$\{([A-Z0-9_]+):-([^}]*)\}$/.exec(String(value));
  return m ? m[2] : String(value);
}

function composePortalEnv() {
  return parse(fs.readFileSync(COMPOSE, 'utf8')).services['station-portal'].environment;
}

/**
 * 真起一个 node 子进程去 import ipam.js —— 因为 `POOLS` 是**模块加载时**解析的，
 * 只在同进程里调 `resolveIpamPools({...})` 会漏掉「函数对但没接线到 POOLS」这种形状
 * （分配走 POOLS，provisioner 只认 `config.fdePool` 这个池名，接线断了表现为「env 没生效」）。
 */
function loadPoolsFromChildProcess(env = {}) {
  const childEnv = { ...process.env };
  for (const key of Object.values(IPAM_POOL_ENV_KEYS)) delete childEnv[key];
  Object.assign(childEnv, env);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { POOLS } from ${JSON.stringify(IPAM_MODULE.href)}; process.stdout.write(JSON.stringify(POOLS));`,
  ], { encoding: 'utf8', env: childEnv });
  assert.equal(r.status, 0, `子进程应成功加载 ipam.js（stderr=${r.stderr}）`);
  return JSON.parse(r.stdout);
}

/** 同理，但断言它**加载失败**（启动期就红，而不是留到 provision）。 */
function loadFailureFromChildProcess(env) {
  const childEnv = { ...process.env };
  for (const key of Object.values(IPAM_ENV_KEYS_FOR_CHILD)) delete childEnv[key];
  Object.assign(childEnv, env);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { POOLS } from ${JSON.stringify(IPAM_MODULE.href)}; void POOLS;`,
  ], { encoding: 'utf8', env: childEnv });
  return { status: r.status, stderr: String(r.stderr ?? '') + String(r.stdout ?? '') };
}
const IPAM_ENV_KEYS_FOR_CHILD = Object.values(IPAM_POOL_ENV_KEYS);

function networkBody(subnet, gateway = null) {
  return {
    Name: 'fde-e2e270',
    Driver: 'bridge',
    IPAM: { Driver: 'default', Config: [{ Subnet: subnet, ...(gateway ? { Gateway: gateway } : {}) }] },
    Labels: { 'station.managed': 'true', 'fde.name': 'e2e270' },
  };
}

// ---------------------------------------------------------------------------
// ① 不设 env ⇒ 与 #270 之前逐字相同
// ---------------------------------------------------------------------------

test('#270 ① 没设 env：resolveIpamPools({}) 与硬编码时代的两个字面量逐字相同', () => {
  assert.deepEqual(resolveIpamPools({}), PRE_270_LITERALS,
    '不设 env 必须逐字等于 #270 之前的 POOLS（任何一位不同 = 现网所有 FDE 网络换段，且没人会报错）');
  assert.deepEqual(DEFAULT_IPAM_POOLS, PRE_270_LITERALS,
    'DEFAULT_IPAM_POOLS 就是那段历史字面量的唯一真相源，它自己漂了 = 对照物失效');
  // 空串也按未设处理（compose 的 `${VAR:-默认}` 与 .env 里的显式空值都不该把池改成"半个值"）。
  assert.deepEqual(resolveIpamPools({ IPAM_POOL_DEFAULT: '', IPAM_POOL_LARGE: '   ' }), PRE_270_LITERALS);
});

test('#270 ① 没设 env：模块加载路径（真子进程）拿到的 POOLS 也是那两个字面量', () => {
  assert.deepEqual(loadPoolsFromChildProcess(), PRE_270_LITERALS,
    'env 未设时 `import { POOLS }` 必须给出 10.200.0.0/16:29 与 10.201.0.0/16:28（分配/路由白名单都从这份派生）');
  assert.deepEqual(POOLS, PRE_270_LITERALS, '本进程（npm test 未设这两个 env）里的 POOLS 同理');
});

test('#270 ① 三腿一致性：compose 下发两个旋钮 + 插值默认值喂进代码 == 代码默认', () => {
  const env = composePortalEnv();
  // 注入腿：compose 不下发 ⇒ 容器里根本没有这两个 env，旋钮形同不存在（§8.70 型事故）。
  assert.ok('IPAM_POOL_DEFAULT' in env && 'IPAM_POOL_LARGE' in env,
    'compose 的 station-portal.environment 必须显式下发 IPAM_POOL_DEFAULT / IPAM_POOL_LARGE');
  const defDefault = interpolationDefault(env.IPAM_POOL_DEFAULT);
  const defLarge = interpolationDefault(env.IPAM_POOL_LARGE);
  assert.deepEqual(
    resolveIpamPools({ IPAM_POOL_DEFAULT: defDefault, IPAM_POOL_LARGE: defLarge }),
    resolveIpamPools({}),
    `compose 默认值喂进代码得到 ${JSON.stringify(resolveIpamPools({ IPAM_POOL_DEFAULT: defDefault, IPAM_POOL_LARGE: defLarge }))}，`
    + '与代码默认不一致 ⇒ 部署面与代码两头各说各话（deploy-env-defaults 同款判据）',
  );
});

// ---------------------------------------------------------------------------
// ② 注入 ⇒ 分配段随之变，且放行面放行
// ---------------------------------------------------------------------------

test('#270 ② 注入 IPAM_POOL_LARGE：分配段变、prefixLen 仍是 28，分配出的 /28 落在新段内', () => {
  const pools = resolveIpamPools({ IPAM_POOL_LARGE: '10.201.37.0/24' });
  assert.deepEqual(pools.large, { cidr: '10.201.37.0/24', prefixLen: 28 });
  assert.deepEqual(pools.default, PRE_270_LITERALS.default, '没注入的那一格不许被顺手改掉');
  const cand = nextAvailableSubnet([], pools.large);
  assert.equal(cand.subnet, '10.201.37.0/28', '空库下这块隔离栈的首个 fde-* 网络 = 派生段的池头');
  assert.equal(cand.prefixLen, 28, '前缀长度不是旋钮：注入换段也不改前缀');
  // 模块加载路径同样跟着 env 走（"只有函数对、没接线" 的形状在这里红）。
  assert.deepEqual(loadPoolsFromChildProcess({ IPAM_POOL_LARGE: '10.201.37.0/24' }).large,
    { cidr: '10.201.37.0/24', prefixLen: 28 });
});

test('#270 ② 分配的 subnet 在放行面内 ⇒ proxy validateNetworkBody 放行（空 reasons）', () => {
  const pools = resolveIpamPools({ IPAM_POOL_LARGE: '10.201.37.0/24' });
  const cand = nextAvailableSubnet([], pools.large);
  // 单一派生的口径：放行面取分配段本身（e2e 就是这么同时喂两侧的）。
  const reasons = validateNetworkBody(networkBody(cand.subnet, cand.gateway), { ipamPools: [pools.large.cidr] });
  assert.deepEqual(reasons, [], `分配段已放行的场景不该被拒：${reasons.join(' | ')}`);
});

test('#270 ② 路由白名单是分配段的**派生视图**（不存在第二本账）', () => {
  assert.deepEqual(FDE_IPAM_POOLS, Object.values(POOLS),
    'routebackends 的 FDE_IPAM_POOLS 必须是 ipam.js 那一份对象（另抄一份 CIDR = 换段后路由与分配分叉）');
});

// ---------------------------------------------------------------------------
// ③ 坏值：当场红 + 点名旋钮
// ---------------------------------------------------------------------------

test('#270 ③ 坏 CIDR / 坏前缀 / 跑出保留段：抛 ipam_pool_env_invalid 且点名旋钮', () => {
  const bad = [
    ['10.201.0.0/16:28', '把前缀长度塞进字符串（前缀不是旋钮）'],
    ['10.201.0.7/16', '非规范网络地址：parseCidr 会静默 mask，正是"半个值生效"'],
    ['10.229.0.0/16', '跑出 large 的 DDL 保留段 10.201.0.0/16（DB CHECK 会拒）'],
    ['10.200.5.0/24', 'large 池拿了 default 的段（default/large 串了）'],
    ['10.201.0.0/30', '池前缀比分配前缀 /28 还长：池里切不出一块'],
    ['10.201.0.0/33', '前缀 >32'],
    ['10.201.0.256/24', '八位组 >255'],
    ['1e4', 'parseInt 那族脏值：整串严格校验必须拒掉'],
    ['10.201.0.0/24,10.202.0.0/24', '一格塞两段（分配器只有一个段）'],
  ];
  for (const [value, why] of bad) {
    let err = null;
    try {
      resolveIpamPools({ IPAM_POOL_LARGE: value });
    } catch (e) {
      err = e;
    }
    assert.ok(err, `${value}（${why}）必须被拒，不能静默生效`);
    assert.equal(err.code, 'ipam_pool_env_invalid', `${value} 的错误码必须是 ipam_pool_env_invalid（上游靠它分类）`);
    assert.match(err.message, /IPAM_POOL_LARGE/, `错误必须点名是哪个旋钮（值=${value}）`);
  }
  // 反向对照：同一个旋钮上的合法写法必须过（否则上面一族的红只能算「什么都拒」）。
  assert.deepEqual(resolveIpamPools({ IPAM_POOL_LARGE: '10.201.0.0/24 ' }).large,
    { cidr: '10.201.0.0/24', prefixLen: 28 }, '两侧空白吸收后合法（约宽不约紧的那一侧别做假严格）');
});

test('#270 ③ 坏值也走真子进程：portal 启动期就拒，不等 provision', () => {
  const r = loadFailureFromChildProcess({ IPAM_POOL_LARGE: '10.229.0.0/16' });
  assert.notEqual(r.status, 0, '模块加载必须失败（脏值活到运行时 = provision 期 INSERT 撞 23514）');
  assert.match(r.stderr, /ipam_pool_env_invalid|IPAM_POOL_LARGE/, `子进程 stderr 要点名旋钮：${r.stderr}`);
});

test('#270 ③ default 旋钮同样点名自己（不是只治 large 那一格）', () => {
  assert.throws(() => resolveIpamPools({ IPAM_POOL_DEFAULT: '10.201.0.0/16' }),
    (err) => err.code === 'ipam_pool_env_invalid' && /IPAM_POOL_DEFAULT/.test(err.message));
});

// ---------------------------------------------------------------------------
// ④ 负向：分配段不在放行面 ⇒ 文案点名两个变量
// ---------------------------------------------------------------------------

test('#270 ④ 分配段不在放行面 ⇒ proxy 拒绝，reason 同时点名放行面与分配器两侧的变量名', () => {
  const pools = resolveIpamPools({ IPAM_POOL_LARGE: '10.201.37.0/24' });
  const cand = nextAvailableSubnet([], pools.large);
  // 现场：portal 的分配段已经换到 10.201.37.0/24，proxy 的放行面还停在**另一套并行隔离栈**那一段。
  //（缺省的 10.201.0.0/16 包含任何 large 子段，拿它做反例永远绿 —— 那正是本单以前「看不出分叉」的原因。）
  const reasons = validateNetworkBody(networkBody(cand.subnet, cand.gateway), {
    ipamPools: ['10.200.0.0/16', '10.201.9.0/24'],
  });
  assert.equal(reasons.length, 1, `应恰有一条拒绝理由，实际：${reasons.join(' | ')}`);
  const text = reasons[0];
  assert.match(text, /not in allowed pools/, '仍要保住既有 reason 的锚点（历史文案/日志检索依赖它）');
  assert.match(text, /10\.201\.37\.0\/28/, '必须把被拒的 subnet 原样带出来');
  // 两条腿各点一次名（宿主侧与服务侧都点名，操作者在自己那一层能直接看懂改哪）。
  assert.match(text, /IPAM_POOLS/);
  assert.match(text, /FDE_IPAM_POOLS/);
  assert.match(text, /IPAM_POOL_LARGE/);
  assert.match(text, /FDE_IPAM_POOL_LARGE/);
});

test('#270 ④ 反向对照：同一 subnet 在同源派生下放行（证明上一条红在"两头分叉"而不是文案）', () => {
  const seg = '10.201.37.0/24';
  const cand = nextAvailableSubnet([], resolveIpamPools({ IPAM_POOL_LARGE: seg }).large);
  assert.deepEqual(validateNetworkBody(networkBody(cand.subnet, cand.gateway), { ipamPools: [seg] }), []);
});

// ---------------------------------------------------------------------------
// #550：派生段的 mod 99 **同余类**必须可被问出来，且缺变量的报错必须带栈上下文
// ---------------------------------------------------------------------------
//
// 两条缺口（issue #550 的 E / D，都不是缺陷而是「看不见的形状」）：
//   E 段号 = `1 + (栈 id 里的数字 mod 99)` ⇒ 同余类相同的两个栈 id **必派生同一段**。
//     `stack1` 与 `stack100` 就是今天真实存在的一对（数字段 `"1"` 与 `"100"` 模 99 都是 1）。
//     本单**不改派生算法**（`docs/data/schema.sql` 的 default↔/29、large↔/28 是启动期硬约束，
//     动算法要连 DB CHECK 一起动），选的是「把事实钉住 + 把同余类报出来」：下面第一格钉的是
//     **今天的碰撞事实**，不是「期望的行为」——将来真换算法时它会红，那是提示你去改判据，不是回归。
//   D 缺必需 env 的旧文案只有 `X must be set for isolated e2e` ⇒「忘传」与「派生算漂了」两种
//     完全不同的故障长得一模一样。现在文案带上栈 id 与它应有的派生段。
test('#550E 钉今天的碰撞事实：stack1 与 stack100 派生同一段 10.201.2.0/24（mod 99 同余，不是期望）', () => {
  const one = deriveFdeIpamPools('stack1');
  const hundred = deriveFdeIpamPools('stack100');
  assert.equal(one, hundred,
    `这是**碰撞事实**（mod 99 同余类都是 1 ⇒ 段号必相等），不是期望：stack1=${one} stack100=${hundred}；`
    + '红了说明派生算法换了模数（那要连 DB CHECK / docs/ops/ci-release.md §6 一起改判据）');
  // 字面段（不是"相等"就够：段号整体漂了也要红，例如第三段从 2 变成 1）。
  assert.equal(one, '10.201.2.0/24', `stack1 的派生段必须逐字是 10.201.2.0/24（实际 ${one}）`);
  assert.equal(hundred, '10.201.2.0/24', `stack100 撞进同一段（实际 ${hundred}）`);
  // 同余类本体也钉住（碰撞的**因**，段号只是它的像）。
  assert.equal(ipamPoolCongruenceClass('stack1'), 1, 'stack1 的同余类：数字段 "1" ⇒ 1');
  assert.equal(ipamPoolCongruenceClass('stack100'), 1, 'stack100 的同余类：数字段 "100" ⇒ 100 % 99 = 1（这就是碰撞的因）');
  // 反向对照：不同余的两个 id 必须不同段（否则上面三格只证明了「什么都返回同一段」）。
  assert.notEqual(deriveFdeIpamPools('stack2'), one, '不同余类必不同段（#270 既有口径）');
});

test('#550E 段号与同余类**同源**：段号 = 1 + ipamPoolCongruenceClass(id)（含无数字走 FNV 分支的 id）', () => {
  // 变异入口：把段号改成与同余类脱钩（如 `1 + (n * 2) % 99`）⇒ 本格红。留两份 `% 99` 就是下一次
  // 「段号与同余类各说各话」的产地，所以这里钉的是**关系**（两个函数必须给同一个答案）。
  for (const id of ['stack1', 'stack100', 'e2e226', 'solo-alpha', 'wp5-isolated']) {
    const segment = deriveFdeIpamPools(id);
    const cls = ipamPoolCongruenceClass(id);
    assert.ok(Number.isInteger(cls) && cls >= 0 && cls <= 98, `${id} 的同余类必须落在 0..98（实际 ${cls}）`);
    const thirdOctet = Number(segment.split('.')[2]);
    assert.equal(thirdOctet, 1 + cls,
      `${id}：段号必须等于 1 + 同余类（段 ${segment} vs 同余类 ${cls}）⇒ 两者已脱钩，有人又抄了一份 % 99`);
  }
  // 无数字的 id 确实走的是 FNV 那一支（不是"恰好没数字就恒 0"），且该支同样幂等、同样在保留段内。
  assert.ok(!/\d/.test('solo-alpha'), '夹具前提：solo-alpha 不含数字（走 FNV 分支）');
  assert.equal(ipamPoolCongruenceClass('solo-alpha'), ipamPoolCongruenceClass('solo-alpha'), 'FNV 分支幂等');
  assert.match(deriveFdeIpamPools('solo-alpha'), /^10\.201\.(?:[1-9][0-9]?)\.0\/24$/,
    'FNV 分支的段仍必须是保留段内第三段 1–99 的 /24（与数字分支同一条映射，不是第二套规则）');
});

test('#550E applyStackIpamPoolEnv 的 warn 同时报出同余类与「这是提示不是保证」（注入收集器）', () => {
  const lines = [];
  const env = { STATION_STACK_ID: 'stack1' };
  const applied = applyStackIpamPoolEnv(env, undefined, { warn: (m) => lines.push(String(m)) });
  assert.deepEqual(applied, { FDE_IPAM_POOLS: '10.201.2.0/24', FDE_IPAM_POOL_LARGE: '10.201.2.0/24' },
    '两腿仍必须一次注入同一个派生段（#270 口径不因本单变松）');
  assert.equal(lines.length, 1, `注入两腿必须恰报一行（实际 ${lines.length} 行：${JSON.stringify(lines)}）`);
  const text = lines.join('\n');
  // ① 同余类：数出来（操作者拿它能自己判「哪两个栈会撞」），文案里必须带类号与模数。
  assert.match(text, /同余类 n=1/, `文案必须报出同余类本体（实际：${text}）`);
  assert.match(text, /mod 99/, '必须点名模数（不写模数的"同余类"是没法复核的黑话）');
  // ② 派生段本身。
  assert.match(text, /10\.201\.2\.0\/24/, `文案必须带派生出的段（实际：${text}）`);
  // ③ 提示不是保证：同余类相同不必然撞（要两栈真并行），不同也可能撞（别的栈手工占段），
  //    而且本机只看得到本栈 env ⇒ 跨栈占用查不到。缺这句就会有人把 warn 当「安全证明」用。
  assert.match(text, /提示不是保证/, `文案必须写清「这是提示不是保证」（实际：${text}）`);
  assert.match(text, /stack100/, '要把真实碰撞对举例带出来（stack1 ↔ stack100），否则提示不可复核');
  // 反向对照：两腿都是操作者手传 ⇒ 不报（报了一个没在用的派生段 = 把人引向错方向）。
  const silent = [];
  const untouched = applyStackIpamPoolEnv(
    { STATION_STACK_ID: 'stack1', FDE_IPAM_POOLS: '10.201.60.0/24', FDE_IPAM_POOL_LARGE: '10.201.60.0/24' },
    undefined,
    { warn: (m) => silent.push(String(m)) },
  );
  assert.deepEqual(untouched, {}, '手传两腿时不该注入任何东西');
  assert.deepEqual(silent, [], '没写入派生值就不该报（warn 只在派生段真的进了 env 时响）');
});

test('#550D 缺 FDE_IPAM_POOL_LARGE 的报错同时带：变量名 / must be set / STATION_STACK_ID=<值> / 期望段', () => {
  // 夹具照 `portal/integration/isolation-negative.mjs` 的 `validIsolationEnv()` 构造法**复制**一份：
  // 那个文件是**脚本**（import 就会跑完整套负例并自设 process.exitCode），单测不能 import 它。
  // 段号这里故意写**字面量**：拿 deriveFdeIpamPools() 现算就是「用被测件验被测件」，换模数也红不了。
  const stackId = 'e2e226';
  const expectedSegment = '10.201.49.0/24'; // e2e226 的全部数字拼接 '2226' ⇒ 2226 % 99 = 48 ⇒ 1 + 48
  const valid = () => ({
    STATION_STACK_ID: stackId,
    COMPOSE_PROJECT_NAME: stackId,
    STATION_DB_DIR: `${os.tmpdir()}/station-db-${stackId}-${process.pid}-550d-absent`,
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
    ...deriveStackIpamPoolEnv(stackId),
    FDE_DEV_MODE: '1',
    STATION_PORTAL_IMAGE: `erix-station/portal:${stackId}`,
    STATION_DOCKER_PROXY_IMAGE: `erix-station/fde-proxy:${stackId}`,
    FDE_IMAGE: `erix-station/fde:${stackId}`,
  });
  // 正例先自证：夹具本身必须过护栏（否则下面的"抛错"可能只是夹具过期，与文案无关）。
  assertIsolatedEnvironment({ env: valid() });

  const missing = valid();
  delete missing.FDE_IPAM_POOL_LARGE;
  let err = null;
  try {
    assertIsolatedEnvironment({ env: missing });
  } catch (e) {
    err = e;
  }
  assert.ok(err, '缺分配段必须抛（不抛就会被 compose 缺省值抬成整个 10.201 保留段）');
  const text = String(err.message);
  for (const needle of [
    'FDE_IPAM_POOL_LARGE', // 缺的是哪一条
    'must be set', // 既有锚点（isolation-negative.mjs 的陷阱与历史日志检索都依赖它）
    `STATION_STACK_ID=${stackId}`, // ① 谁的栈
    expectedSegment, // ② 这个栈**应该**是哪一段 ⇒ 与「忘传」一眼可分
  ]) {
    assert.ok(text.includes(needle), `报错文案缺锚点「${needle}」（实际：${text}）`);
  }
  // 另一半事实：栈 id 自己也没设时，不许瞎猜一个段（猜出来的期望段会把人引向「派生算错了」）。
  const noStack = valid();
  delete noStack.STATION_STACK_ID;
  let err2 = null;
  try {
    assertIsolatedEnvironment({ env: noStack });
  } catch (e) {
    err2 = e;
  }
  assert.ok(err2 && String(err2.message).includes('<未设 STATION_STACK_ID>'),
    `没栈 id 时文案必须写 <未设 STATION_STACK_ID>（实际：${err2?.message ?? '（没抛）'}）`);
  assert.ok(!String(err2.message).includes(expectedSegment),
    '没栈 id 就不许报一个凭空派生的"期望段"（那是第二种故障的文案）');
});
