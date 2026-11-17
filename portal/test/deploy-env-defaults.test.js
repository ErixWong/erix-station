// 部署面默认值 ↔ 代码默认值：不许两头各说各话（issue #114 vs #88 修订遗留的 compose 默认）。
//
// 病根（2026-10-21 决策者拍「关掉」换来的）：`portal/src/config.js` 按 **#114**（2026-10-01「run 终态不再
// 自动起名，省 token」）把 `sessionAutoTitle` 的**代码默认设成关**；而 `deploy/docker-compose.yml` 里那行
// `ERIX_SESSION_AUTO_TITLE: ${...:-1}` 出自 **#88 修订 `125eae9`（2026-09-25，那时标题生成还在 worker 侧）**，
// #114 改代码默认时没同步它 ⇒ **「默认关」在任何 compose 部署的栈上从未生效**（真机实测 portal 容器内 `=1`）。
// #322 把生成者统一成 portal 之后，compose 这一行就是全站唯一默认值 ⇒ 必须有机器判据，不能靠人记。
//
// 判据形状：不是各钉各的（那正是「两头各自都对」的失效形状），而是**双向一致性**——
// 把 compose 里插值出来的默认值喂给 `loadConfig`，结果必须等于不喂任何 env 的代码默认。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'yaml';

import { loadConfig } from '../src/config.js';

const COMPOSE = new URL('../../deploy/docker-compose.yml', import.meta.url);
const ENV_EXAMPLE = new URL('../../deploy/.env.example', import.meta.url);

/** 取 compose 里 `${VAR:-默认}` 的默认段；写成裸值（无插值）时原样返回。 */
function interpolationDefault(value) {
  const m = /^\$\{([A-Z0-9_]+):-([^}]*)\}$/.exec(String(value));
  return m ? m[2] : String(value);
}

test('#114 默认口径：compose 里自动改名开关的默认值必须是「关」', () => {
  const doc = parse(fs.readFileSync(COMPOSE, 'utf8'));
  const env = doc.services['station-portal'].environment;
  assert.ok('ERIX_SESSION_AUTO_TITLE' in env, 'compose 里 station-portal 必须显式下发 ERIX_SESSION_AUTO_TITLE（否则运维无从开关）');

  const def = interpolationDefault(env.ERIX_SESSION_AUTO_TITLE);
  assert.equal(def, '0',
    'compose 默认必须是 0：#114 定了「默认关，标题取首条用户消息截断，改名由用户点按钮」。'
    + '历史上这里是 1（出自 #88 修订），那段时间「默认关」从未在部署面生效过');
});

test('#114 双向一致性：compose 默认喂进 loadConfig ⇒ 必须等于代码默认（两头不许各说各话）', () => {
  const doc = parse(fs.readFileSync(COMPOSE, 'utf8'));
  const def = interpolationDefault(doc.services['station-portal'].environment.ERIX_SESSION_AUTO_TITLE);

  const codeDefault = loadConfig({}).sessionAutoTitle;
  const deployedDefault = loadConfig({ ERIX_SESSION_AUTO_TITLE: def }).sessionAutoTitle;
  assert.equal(codeDefault, false, '代码默认：没配 env ⇒ 关（config.js 里 #114 那条）');
  assert.equal(deployedDefault, codeDefault,
    `compose 默认 ${JSON.stringify(def)} 喂进代码后得到 ${deployedDefault}，与代码默认 ${codeDefault} 不一致`
    + ' ⇒ 部署面与文档又分叉了（本次修复的正是这种分叉）');

  // 开关仍然可用：显式 1 ⇒ 开；其它值 ⇒ 关（与 config.js 的 `=== '1'` 判据同源）
  assert.equal(loadConfig({ ERIX_SESSION_AUTO_TITLE: '1' }).sessionAutoTitle, true, '运维显式设 1 仍应开回来');
  assert.equal(loadConfig({ ERIX_SESSION_AUTO_TITLE: 'yes' }).sessionAutoTitle, false, '非 1 值不算开（避免「写了就算开」）');
});

// ---------------------------------------------------------------------------
// issue #450 / feat-261105-01：管理台入口端口是**三处一份真值**，而这单没法把它收成一处：
//   · Traefik 的 listen 端口只能在静态配置里（`deploy/traefik/traefik.yml`），且该文件**不做 `${VAR}` 插值**
//     （实测 traefik:v3.7.13 + `--configFile`：地址原样成字面量 → `listen tcp: lookup tcp/9443}: unknown port`）；
//   · station-edge 是 `network_mode: host` ⇒ 宿主端口 = 容器端口，没有 ports 映射可跟着 env 走；
//   · 部署面 env（compose 的 `TRAEFIK_ADMIN_PORT`）才是 portal 推导管理台 URL 的那一份。
// ⇒ 三处必须逐字一致。人记不住，所以让机器记：把「静态文件里的字面量」「compose 的插值默认值」
//   「代码默认值」三条都读出来对比，任一处单独改动都会红。
const TRAEFIK_YML = new URL('../../deploy/traefik/traefik.yml', import.meta.url);

function adminEntryPointAddress() {
  const text = fs.readFileSync(TRAEFIK_YML, 'utf8');
  const m = /^  adminsecure:\n(?:.*\n)*?    address: "([^"]+)"/m.exec(text);
  assert.ok(m, 'deploy/traefik/traefik.yml 里必须有 adminsecure entrypoint 的 address（#450 D0）');
  return m[1];
}

test('#450 管理台端口三处一致：静态文件 adminsecure.address / compose 插值默认 / 代码默认', () => {
  const address = adminEntryPointAddress();
  const m = /^:(\d+)$/.exec(address);
  assert.ok(m, `adminsecure.address 必须是写死的 ":<port>"（静态文件不插值，不能写 \${VAR}）：实际 ${address}`);
  const staticPort = Number(m[1]);

  const doc = parse(fs.readFileSync(COMPOSE, 'utf8'));
  const env = doc.services['station-portal'].environment;
  assert.ok('TRAEFIK_ADMIN_PORT' in env, 'compose 必须把 TRAEFIK_ADMIN_PORT 注入 portal（管理台 URL 要它）');
  const composePort = Number(interpolationDefault(env.TRAEFIK_ADMIN_PORT));

  assert.equal(composePort, staticPort,
    `compose 默认 ${composePort} ≠ 静态配置 listen ${staticPort}：Traefik 绑在 ${staticPort}，`
    + 'portal 却按另一个端口拼管理台 URL（症状：链接打不开）');
  assert.equal(loadConfig({}).adminPort, staticPort,
    `代码默认 ${loadConfig({}).adminPort} ≠ 静态配置 listen ${staticPort}`);
  // 端口不能撞既有入口/号池（#450 D0：9443，避开 80/443/8090/8443 与 22000–29999）
  assert.ok(![80, 443, 8090, 8443].includes(staticPort), `管理台端口 ${staticPort} 与既有入口撞车`);
  assert.ok(staticPort < 22000 || staticPort > 29999, `管理台端口 ${staticPort} 落在预览号池 22000–29999 内`);
});

test('#450 管理台 host 默认 = admin.<BASE_DOMAIN>，且 compose 把 ADMIN_PUBLIC_HOST / ADMIN_IP_ALLOWLIST 透传', () => {
  const doc = parse(fs.readFileSync(COMPOSE, 'utf8'));
  const env = doc.services['station-portal'].environment;
  assert.ok('ADMIN_PUBLIC_HOST' in env, 'compose 必须透传 ADMIN_PUBLIC_HOST（否则 deploy/.env 里设了也不生效）');
  assert.ok('ADMIN_IP_ALLOWLIST' in env, 'compose 必须透传 ADMIN_IP_ALLOWLIST（#450 D4 的唯一开关）');
  assert.equal(interpolationDefault(env.ADMIN_IP_ALLOWLIST), '', '默认必须是空 = 不挂 ipAllowList（不破坏现网）');
  assert.equal(interpolationDefault(env.ADMIN_PUBLIC_HOST), '', '默认必须是空 = 由 BASE_DOMAIN 推导');
  assert.equal(loadConfig({}).adminHost, 'admin.localhost');
});

// ---------------------------------------------------------------------------
// issue #643 A：三根自构建镜像的引用**不许有缺省值**（静态锁，行为锁在
// `test/deploy-compose-failclosed.test.js`，那边跑真 compose，这边钉「文本形态」）。
//
// 病根：`deploy/.env` 是 gitignore 的（`.gitignore` 里 `.env` / `.env.*`）⇒ 新 worktree / 新机器
// 根本没有它；而 `${VAR:-回落值}` 在缺文件时**静默**用回落值 ⇒ 任何一次 `up -d` 都能把**共享
// dev 栈**换成 `:local` / `traefik/whoami` 而一声不响。`:-` ⇒ `:?` 之后缺值即报错。
//
// 为什么静态锁与行为锁都要：行为锁能抓「回落值回来了」，但它跑不起来时就 skip（无 docker）；
// 而只靠文本判据又会漏「文案没点名变量 ⇒ 报错现场根本认不出是哪根旋钮」这一类（M4 的形态）。
// ---------------------------------------------------------------------------

/** 四处插值点（service 路径是 compose 报错时会点名的那一个，写进断言消息便于对现场）。 */
const FAIL_CLOSED_REFS = [
  {
    varName: 'STATION_DOCKER_PROXY_IMAGE', at: 'services.station-docker-proxy.image',
    path: ['station-docker-proxy', 'image'],
  },
  {
    varName: 'STATION_PORTAL_IMAGE', at: 'services.station-portal.image',
    path: ['station-portal', 'image'],
  },
  {
    varName: 'FDE_IMAGE', at: 'services.station-docker-proxy.environment.IMAGE_ALLOWLIST',
    path: ['station-docker-proxy', 'environment', 'IMAGE_ALLOWLIST'],
  },
  {
    varName: 'FDE_IMAGE', at: 'services.station-portal.environment.FDE_IMAGE',
    path: ['station-portal', 'environment', 'FDE_IMAGE'],
  },
];
/** `.env.example` 里必须登记（且留空）的三根变量。 */
const REGISTERED_REFS = ['STATION_PORTAL_IMAGE', 'STATION_DOCKER_PROXY_IMAGE', 'FDE_IMAGE'];

function composeValueAt(doc, path) {
  // path 的根是 `services`（上面的 `at` 写的是 compose 报错时点名的路径，含 services 前缀）
  let node = doc.services;
  for (const key of path) {
    node = node?.[key];
    assert.notEqual(node, undefined, `compose 里 ${path.join('.')} 不见了（判据的坐标先失效）`);
  }
  return String(node);
}

test('#643 A 四处镜像引用必须是 ${VAR:?…}，且不许残留 ${VAR:-回落} 形态', () => {
  const doc = parse(fs.readFileSync(COMPOSE, 'utf8'));
  const problems = [];
  for (const ref of FAIL_CLOSED_REFS) {
    const raw = composeValueAt(doc, ref.path);
    // `${VAR:?msg}`（消息里不许出现 `}`，compose 的插值文法到第一个 `}` 结束）
    const m = /^\$\{([A-Z0-9_]+):\?([^}]*)\}$/.exec(raw);
    if (!m) problems.push(`${ref.at} = ${JSON.stringify(raw)}：不是 ${ref.varName}:?… 形态（回落值回来了？）`);
    else if (m[1] !== ref.varName) problems.push(`${ref.at} 插的是 ${m[1]}，不是 ${ref.varName}`);
    if (raw.includes(':-')) problems.push(`${ref.at} = ${JSON.stringify(raw)}：残留 :- 回落段`);
  }
  assert.deepEqual(problems, [],
    '镜像引用必须缺值即拒：`deploy/.env` 不入库，带缺省值的那次 `up -d` 会静默换掉共享 dev 栈的镜像\n  '
    + problems.join('\n  '));
});

test('#643 A `:?` 的报错文案必须点名对应变量（缺值现场要认得出是哪根旋钮）', () => {
  const doc = parse(fs.readFileSync(COMPOSE, 'utf8'));
  const problems = [];
  for (const ref of FAIL_CLOSED_REFS) {
    const raw = composeValueAt(doc, ref.path);
    const msg = /^\$\{[A-Z0-9_]+:\?([^}]*)\}$/.exec(raw)?.[1] ?? '';
    if (!msg.includes(ref.varName)) {
      problems.push(`${ref.at}：文案 ${JSON.stringify(msg)} 里没有 ${ref.varName}`);
    }
    // 两种合法形态都要在文案里：scratch 的 tag 形态与部署的 digest 形态（只说一种 = 现场猜）
    if (!/\blocal\b|whoami/.test(msg)) {
      problems.push(`${ref.at}：文案没给 scratch 本地形态（:local / whoami）`);
    }
    if (!msg.includes('sha256:')) problems.push(`${ref.at}：文案没给部署 pin 形态（image@sha256:…）`);
  }
  assert.deepEqual(problems, [], 'compose 的缺值文案要点名变量并给两种合法形态：\n  ' + problems.join('\n  '));
});

test('#643 A deploy/.env.example 必须登记这三根，且值不许是「抄了就能起栈」的具体引用', () => {
  const text = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  const lines = text.split('\n');
  const problems = [];
  for (const key of REGISTERED_REFS) {
    // 只认**未被注释**的 `KEY=` 行：注释里的示例值是给人看的，不算运维的填写处。
    const active = lines.filter((l) => new RegExp(`^${key}\\s*=`).test(l));
    if (active.length !== 1) {
      problems.push(`${key}：.env.example 里未注释的登记行有 ${active.length} 行（要恰好 1 行；`
        + '0 行 = 运维找不到填写处，>1 行 = 后者静默覆盖前者）');
      continue;
    }
    const value = active[0].slice(active[0].indexOf('=') + 1).trim();
    if (value !== '') {
      problems.push(`${key}：模板给的是 ${JSON.stringify(value)} ⇒ 复制模板就等于声明要动共享 dev 栈`
        + '（这三根的口径是「留空 = 仍未声明」；空值也算缺失，compose 2.40 实测）');
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
