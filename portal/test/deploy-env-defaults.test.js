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
