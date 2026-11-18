// 部署面 env 的**防回潮闸**（issue #677 P5，2026-11-17）。
//
// 一句话：`station-portal.environment` 的键集合必须 ⊆「**启动期必需的 10 条白名单** ∪ **历史存量基线**」，
// 而基线**只许变小**。新旋钮默认走 DB + 配置界面（`runtime_settings`），想走 env 必须**显式解释**。
//
// 为什么需要这道闸（#677 的背景，实测数字）：
//   `station-portal.environment` 现有 **70 条**，其中只有 10 条是「容器起来之前就必须知道」的
//   （连库 URL、密钥、域名、Traefik 三端口、管理台 allowlist、FDE 镜像 pin）。其余 60 条是**功能旋钮**
//   或**可从上面那些派生**的值。它们之所以做成 env，是因为消费者在 FDE 容器里的 runner，而 FDE 容器是
//   portal provision 时现造的 ⇒ 每加一个旋钮要改四处（compose → portal → provisioner → proxy 白名单），
//   四处之间没有任何同步机制。这个形状已经出过两次真事故：
//     · `ERIX_AGENT_VERSION`（#416）：provisioner 注入了、proxy 白名单没同步 ⇒ 现网 create_policy_denied，
//       两个 FDE 容器被删掉、短暂全停；
//     · `ERIX_SESSION_AUTO_TITLE`（#114 vs #88）：代码默认改「关」、compose 默认还是「开」⇒
//       「默认关」在任何 compose 部署的栈上从未生效，白烧几周 token。
//
// 为什么现在就要这道闸（而不是等 #677 P3 迁完再写）：迁移是分批的，**期间还会有人加 env**。
//   没有闸的话，「70 条」会在迁移过程中继续长大，最后没人说得清哪些是新长出来的。
//   所以本判据现在就上线：**存量冻结、只许减少**。
//
// 判据形状（三条，都可独立红）：
//   ① 出现「既不在白名单、也不在基线」的键 ⇒ 红（新旋钮默认走 DB；确实必须是启动期 env 就改白名单 + 写理由）；
//   ② 基线里 `keys.length > floor` ⇒ 红（地板只降不升：要加键必须显式抬 floor 并留 `floorReason`）；
//   ③ 白名单里删掉一条 ⇒ 红（那 10 条是「容器起来前必须知道」的硬约束，删了就是把启动顺序当儿戏）。
//
// ⚠ 本判据**不**检查值、只检查**键集合**。值的默认值一致性在 `deploy-env-delegate.test.js` 的腿③
//   （目前只覆盖 4 个 DELEGATE_KEYS，扩到全量是 #677 的另一片，别在这里重复造）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'yaml';

const COMPOSE = new URL('../../deploy/docker-compose.yml', import.meta.url);
const BASELINE = new URL('../../scripts/deploy-env-baseline.json', import.meta.url);

/**
 * 启动期必需的 env（issue #677 的 10 条）。**只有这些**允许长期留在 compose 里：
 *   · 连库（DB 里的配置要先连上库才读得到）⇒ DATABASE_URL / MIGRATE_DATABASE_URL
 *   · 密钥（不许进库）⇒ SESSION_SIGNING_KEY / LLM_GATEWAY_MASTER_KEY
 *   · 域名与边缘端口（与 `deploy/traefik/traefik.yml` **双写**，改端口必须两处同改）⇒ BASE_DOMAIN / TRAEFIK_*_PORT
 *   · 安全边界（存 DB 里配错就进不去管理台 ⇒ 留 env 是 break-glass）⇒ ADMIN_IP_ALLOWLIST
 *   · 部署 pin（用哪个镜像开 FDE）⇒ FDE_IMAGE
 */
export const BOOTSTRAP_ENV = Object.freeze([
  'DATABASE_URL',
  'MIGRATE_DATABASE_URL',
  'SESSION_SIGNING_KEY',
  'LLM_GATEWAY_MASTER_KEY',
  'BASE_DOMAIN',
  'TRAEFIK_WEB_PORT',
  'TRAEFIK_WEBSECURE_PORT',
  'TRAEFIK_ADMIN_PORT',
  'ADMIN_IP_ALLOWLIST',
  'FDE_IMAGE',
]);

function portalEnvKeys() {
  const doc = parse(fs.readFileSync(COMPOSE, 'utf8'));
  const env = doc?.services?.['station-portal']?.environment;
  assert.ok(env && typeof env === 'object', 'compose 里 station-portal.environment 必须是映射（yaml 解析得到对象）');
  return Object.keys(env).sort();
}

function readBaseline() {
  const raw = fs.readFileSync(BASELINE, 'utf8');
  const doc = JSON.parse(raw);
  assert.ok(Array.isArray(doc.keys), `基线文件必须有 keys 数组：${BASELINE.pathname}`);
  assert.ok(Number.isInteger(doc.floor), `基线文件必须有整数 floor：${BASELINE.pathname}`);
  return doc;
}

test('#677 P5①：compose 的 portal env 不许出现「既不在启动期白名单、也不在存量基线」的新键', () => {
  const keys = portalEnvKeys();
  const baseline = new Set(readBaseline().keys);
  const allow = new Set(BOOTSTRAP_ENV);
  const intruders = keys.filter((k) => !allow.has(k) && !baseline.has(k));
  assert.deepEqual(intruders, [],
    `新旋钮默认走 DB + 配置界面（runtime_settings，见 issue #677），不要加进 compose：${JSON.stringify(intruders)}\n`
    + '确实必须是「容器起来之前就得知道」的值（连库 / 密钥 / 域名 / 边缘端口 / 安全边界 / 镜像 pin）⇒\n'
    + '① 把它加进本文件顶部的 BOOTSTRAP_ENV 并**在注释里写清为什么它不能进 DB**；\n'
    + '② 同时更新 docs/env.md 的口径表。');
});

test('#677 P5②：存量基线只许变小（floor 是地板，不许抬）', () => {
  const baseline = readBaseline();
  assert.ok(baseline.keys.length <= baseline.floor,
    `基线 keys.length=${baseline.keys.length} 超过了 floor=${baseline.floor} ⇒ 有人在「冻结存量」的名义下又塞了新键。\n`
    + '要加键必须显式抬 floor 并写 floorReason（说明为什么这条不能进 DB），否则就该走配置界面。');
  // 反向自证：基线里不许出现**已经不在 compose** 的键（那说明基线过期了，闸门在守一个不存在的键）
  const keys = new Set(portalEnvKeys());
  const stale = baseline.keys.filter((k) => !keys.has(k));
  assert.deepEqual(stale, [],
    `基线里这些键在 compose 里已经不存在 ⇒ 基线过期（闸门在守幽灵）：${JSON.stringify(stale)}\n`
    + '把它们从 scripts/deploy-env-baseline.json 的 keys 里删掉（floor 保持不变 = 地板降低）。');
});

test('#677 P5③：启动期白名单那 10 条不许被删（删了就是把启动顺序当儿戏）', () => {
  const keys = new Set(portalEnvKeys());
  const missing = BOOTSTRAP_ENV.filter((k) => !keys.has(k));
  assert.deepEqual(missing, [],
    `启动期必需的 env 被删了：${JSON.stringify(missing)}\n`
    + '这 10 条是「容器起来之前就必须知道」的硬约束（连库 / 密钥 / 域名 / 边缘端口 / 安全边界 / 镜像 pin）。\n'
    + '真要退役某一条，必须同时改本文件的白名单**并**说明它凭什么不再是启动期必需。');
});

test('#677 P5④：白名单本身不许悄悄长大（10 条是 issue #677 的承诺）', () => {
  // 白名单条数是「承诺值」：它变大 = 又有人在 env 里加东西（而不是进配置界面）。
  // 允许变小（迁移完成后某些启动期键可能也能派生），但**每次变化都要人看见**。
  assert.ok(BOOTSTRAP_ENV.length <= 10,
    `启动期白名单 ${BOOTSTRAP_ENV.length} 条 > 10 ⇒ 又往 env 里加了东西。新旋钮请走 DB（issue #677）；\n`
    + '确实必须留 env 的，先想清楚「它为什么不能在容器起来之后再读」。');
});
