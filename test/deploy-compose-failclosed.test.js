/**
 * 行为锁（issue #643 A）：对**仓库里真实的** `deploy/docker-compose.yml` 跑真 `docker compose
 * config`，钉「三根自构建镜像的引用缺值即报错」这件事在 compose 的真实读数里确实发生。
 *
 * 这单要治什么（不是「顺手加个校验」，是一次静默换镜像的事故面）：
 * `deploy/.env` 是 gitignore 的（`.env` / `.env.*`）⇒ 新 worktree / 新机器**根本没有它**；
 * 而改之前的 compose 写的是 `${VAR:-回落值}` ⇒ 缺文件时**静默**用回落值 ⇒ 任何一次
 * `docker compose up -d` 都能把**共享 dev 栈**（本机只有一套 station-portal / proxy）的镜像
 * 换成 `erix-station/portal:local` / `traefik/whoami`，**一声不响、rc=0、站起来了**：
 * 运维以为栈在跑发布 pin 的那个镜像，实际在跑本机现构建的 `:local`（或占位的 whoami）。
 * 症状出现在「别人那台机器/另一棵 worktree 起栈之后」，离成因（少了个没入库的文件）很远。
 * 改成 `${VAR:?}` 之后缺值即拒。本文件钉的就是「拒」真的发生，以及「给了值就不许改写」。
 *
 * 为什么行为锁与静态锁（`portal/test/deploy-env-defaults.test.js`）都要，不是留一个：
 *   · 静态锁读 compose **文本**：不依赖 docker，任何机器都跑；但它钉不到 compose **自己怎么读**
 *     ——「空值算不算缺失」是 compose 的行为而不是文本，「报错文案真打出来没有」也是；
 *   · 行为锁（本文件）钉真 compose 的读数（rc、stderr 形状、解析出来的镜像引用逐字等于传入值），
 *     但没 docker 的机器上只能 skip ⇒ 只靠它就存在「换台机器就形同不存在」的窗口，
 *     而那个窗口正是 `:-` 回落值能悄悄溜回来的缝（本单之前的形状就是这么活的）。
 *   ⇒ 一个钉文本形状、一个钉外部工具的真实读数，缺一个就少一侧。
 *
 * compose 2.40.3 的实测形状（判据照它钉；将来换版本这几条会红，那是**对的**）：
 *   · 缺值：rc=1，stderr = `error while interpolating <服务路径>: required variable <VAR> is
 *     missing a value: <:? 后面那段文案>`，stdout **空**（整份 config 不产出，不是给个半成品）；
 *   · 一次只报**第一处**插值错误 ⇒ 同一根变量出现在两处（`FDE_IMAGE` 在 proxy 的
 *     `IMAGE_ALLOWLIST` 与 portal 的 `FDE_IMAGE`）时，先报错的那处**不固定**（本仓实测两种顺序
 *     都出现过，比例随进程变）⇒ 「点名被剔的那根」按**变量名**断言、「报在声明的坐标里」按
 *     **两处之一**断言；两处是否都采到只当诊断信息报出（见下面那条用例的注释——把它当断言会
 *     造出偶发的假红，而 compose 的插值语义与报错顺序无关）；
 *   · `config` 是**只读**的：把 `DOCKER_HOST` 指到死端口照样 rc=0 ⇒ 不碰 daemon，
 *     更不碰本机共享 dev 栈（本文件里不许出现 up/down/build/stop/rm）。
 *
 * 可复现性：一律带 `--env-file <临时空文件>`。compose 会**自动加载**同目录的 `.env`，而
 * `deploy/.env` 在主检出里有、在别的 worktree 里没有 ⇒ 不覆盖它，同一份代码在两棵树上结论
 * 就不同（本机主检出的 `deploy/.env` 恰好把三根都填了 ⇒ 全缺用例假绿）。这个「空文件压得住
 * 自动加载」不是假设，由 `V-夹具` 那条用例自己在临时目录里复现，不读写 `deploy/.env`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_REL = 'deploy/docker-compose.yml';
const COMPOSE_ABS = path.join(ROOT, COMPOSE_REL);

/** 三根自构建镜像的引用变量（`FDE_IMAGE` 一根喂两处）。 */
const THREE = ['STATION_PORTAL_IMAGE', 'STATION_DOCKER_PROXY_IMAGE', 'FDE_IMAGE'];

/** 形态①（scratch 本地构建）的合法值：单独剔一根时，其余两根用它补齐。 */
const SCRATCH = {
  STATION_PORTAL_IMAGE: 'erix-station/portal:local',
  STATION_DOCKER_PROXY_IMAGE: 'erix-station/fde-proxy:local',
  FDE_IMAGE: 'traefik/whoami',
};

/** 形态②（部署 / 发布 pin 不可变引用）：V-全给 用它证明 pin 形态也逐字透传。 */
const PINNED = {
  STATION_PORTAL_IMAGE: 'ghcr.io/erixwong/erix-station-portal@sha256:' + 'a'.repeat(64),
  STATION_DOCKER_PROXY_IMAGE: 'ghcr.io/erixwong/erix-station-fde-proxy@sha256:' + 'b'.repeat(64),
  FDE_IMAGE: 'ghcr.io/erixwong/erix-station-fde@sha256:' + 'c'.repeat(64),
};

/**
 * 逐根剔除的用例表：`at` 是 compose 报错时会点名的服务路径（`FDE_IMAGE` 有两处 ⇒ 数组，
 * 命中任一即算点名；多处时先报错的那处不固定，见文件头）。
 */
const REMOVAL_CASES = [
  { name: 'STATION_PORTAL_IMAGE', at: ['services.station-portal.image'] },
  { name: 'STATION_DOCKER_PROXY_IMAGE', at: ['services.station-docker-proxy.image'] },
  {
    name: 'FDE_IMAGE',
    at: [
      'services.station-docker-proxy.environment.IMAGE_ALLOWLIST',
      'services.station-portal.environment.FDE_IMAGE',
    ],
  },
];

/** 插值错误的实测形状（compose 2.40.3）：拼出「这处、这根变量」应当出现的字面前缀。 */
const missingAt = (at, varName) => `error while interpolating ${at}: required variable `
  + `${varName} is missing a value`;
const INTERP_RE = /error while interpolating (\S+): required variable ([A-Z0-9_]+)/g;

/**
 * 构造子进程 env：**先删后加**（显式剔掉三根，再叠上这次要给的）。
 * 为什么不用 `env -u VAR VAR=x`：后面那个赋值会盖掉前面的 `-u`（实测踩过一次），
 * 于是「剔掉 STATION_PORTAL_IMAGE」的用例其实一直在带着值跑 ⇒ 判据恒真。
 */
function buildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of THREE) delete env[key];
  return { ...env, ...overrides };
}

/** 跑一次真 compose（cwd = 仓库根）；`docker` 不存在时回 `{ unavailable, reason }`。 */
function dockerCompose(args, { env, cwd = ROOT }) {
  const r = spawnSync('docker', ['compose', ...args],
    { cwd, env, encoding: 'utf8', timeout: 120_000 });
  if (r.error) {
    return { unavailable: true, reason: `${r.error.code ?? r.error.name}: ${r.error.message}` };
  }
  return { rc: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

let probe; // 一次性的 docker compose 可用性读数（skip 与断言共用同一份，别各测各的）

/** `docker compose version` 能不能跑起来（先例：`test/integration-e2e-preflight.test.js` E4）。 */
function composeAvailable() {
  probe ??= (() => {
    const r = spawnSync('docker', ['compose', 'version'],
      { cwd: ROOT, env: buildEnv(), encoding: 'utf8', timeout: 60_000 });
    if (r.error) {
      return { ok: false, reason: `${r.error.code ?? r.error.name}: ${r.error.message}` };
    }
    if (r.status !== 0) {
      return { ok: false, reason: `rc=${r.status} ${String(r.stderr ?? '').trim().slice(0, 160)}` };
    }
    return { ok: true, version: String(r.stdout ?? '').trim() };
  })();
  return probe;
}

/**
 * 没有 docker ⇒ **skip 并打印原因**：不许把「这台机器没环境」报成产品坏了，
 * 也不许静默当通过（skip 在 TAP 里是看得见的一条，`npm test` 的 skipped 计数会加一）。
 * @returns {null | { version: string }} 可用时返回读数，不可用时已 skip 并返回 null
 */
function requireCompose(t) {
  const p = composeAvailable();
  if (p.ok) return p;
  t.skip(`本机没有可用的 docker compose（${p.reason}）⇒ 行为锁退回静态锁 `
    + '`portal/test/deploy-env-defaults.test.js`（那条不依赖 docker）；'
    + '这是环境问题不是产品坏了，所以是 skip 不是 fail');
  return null;
}

/** 临时空 env 文件（`--env-file` 用它压掉 compose 自动加载的 `deploy/.env`）；`t.after` 清理。 */
function emptyEnvFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-643-compose-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'empty.env');
  fs.writeFileSync(file, '');
  // 红线自查：临时文件绝不能是 `deploy/.env`（那个文件本单既不读也不写）
  assert.notEqual(path.resolve(file), path.join(ROOT, 'deploy', '.env'));
  return file;
}

/** 对仓库里那份真 compose 跑 `config`（默认 `--format json` 由调用方决定）。 */
function configRun(t, env, extra = []) {
  const envFile = emptyEnvFile(t);
  const r = dockerCompose(
    ['--env-file', envFile, '-f', COMPOSE_REL, 'config', ...extra], { env: buildEnv(env) });
  assert.equal(r.unavailable, undefined, `docker 不可用却走到了断言里：${r.reason}`);
  return r;
}

// ── V-无 docker：可用性探针自己也要能「报出原因」，skip 不是安慰剂 ────────────────

test('#643 A V-无 docker：compose 不可用就 skip 并说明（探针带反向自证，不许静默当通过）', (t) => {
  // 反向自证：探针的「不可用」分支确实会亮 —— 拿一个不存在的可执行文件走同一条判定路径。
  // 没有这一条，探针可能被写成「永远 ok」，那 skip 分支就是死代码，无 docker 的机器上
  // 整个文件会**静默全绿**（正是本文件要防的「形同不存在」）。
  const fake = spawnSync('erix-643-definitely-not-a-real-binary', ['compose', 'version'],
    { cwd: ROOT, env: buildEnv(), encoding: 'utf8', timeout: 10_000 });
  assert.ok(fake.error, '不存在的可执行文件必须让 spawnSync 给 error（探针靠它认「没环境」）');
  assert.ok(String(fake.error.code ?? fake.error.message).length > 0,
    '「没环境」的读数必须带原因（skip 文案里要印出来）');

  const p = requireCompose(t);
  if (!p) return; // 已 skip：上面那条反向自证仍然跑过，不受影响
  assert.match(p.version, /Docker Compose version/, `读数不像 compose 版本：${p.version}`);
  t.diagnostic(`docker compose 可用性：${p.version}`);
});

// ── V-夹具：`--env-file` 空文件必须压掉 compose 自动加载的同目录 .env ─────────────

test('#643 A V-夹具：--env-file 空文件压得住 compose 自动加载的同目录 .env（可复现性地基）',
  (t) => {
    if (!requireCompose(t)) return;
    // 在临时目录里造「同目录有 .env」这件事：真 deploy/.env 不入库，别的 worktree 里没有它，
    // 所以只能在夹具里复现，也不许去读写仓库里那个（它属于本机运维）。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-643-shield-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, '.env'), 'ERIX643_SENTINEL=from-auto-dot-env\n');
    const probeFile = path.join(dir, 'probe.yml');
    fs.writeFileSync(probeFile,
      'services:\n  probe:\n    image: ${ERIX643_SENTINEL:?must be set}\n');

    const auto = dockerCompose(['-f', probeFile, 'config', '--format', 'json'],
      { env: buildEnv(), cwd: dir });
    assert.equal(auto.rc, 0, `夹具本身要能复现「同目录 .env 被自动加载」：${auto.stderr}`);
    assert.equal(JSON.parse(auto.stdout).services.probe.image, 'from-auto-dot-env',
      'compose 自动加载的就是同目录那个 .env（不覆盖它 ⇒ 两棵 worktree 结论不同，判据不可复现）');

    const shielded = dockerCompose(
      ['--env-file', emptyEnvFile(t), '-f', probeFile, 'config', '--format', 'json'],
      { env: buildEnv(), cwd: dir });
    assert.notEqual(shielded.rc, 0, '带空 --env-file 时那个值必须认不到（否则 V-全缺 是假绿）');
    assert.match(shielded.stderr, /required variable ERIX643_SENTINEL is missing a value/);
  });

// ── V-全缺：三根都不给 ⇒ 必须报错，不是站起来了 ──────────────────────────────────

test('#643 A V-全缺：三根都不给 ⇒ rc≠0 且 stderr 说 required variable + 点名某根', (t) => {
  if (!requireCompose(t)) return;
  const r = configRun(t, {}); // buildEnv 已显式剔掉三根
  assert.notEqual(r.rc, 0,
    '三根全缺必须非 0。rc=0 就意味着回落值回来了 —— 那正是「`up -d` 静默把共享 dev 栈换成 '
    + ':local / traefik/whoami」的原始形状（本单要治的就是它）\nstderr: ' + r.stderr);
  assert.equal(r.stdout.trim(), '',
    '缺值时整份 config 不产出：给个半份解析结果就是「看起来配好了」的第二个版本');
  assert.match(r.stderr, /required variable/, `报错要落在「缺值」这个原因上：${r.stderr}`);
  // compose 一次只报**第一处**插值错误，所以这里不要求三根全点名；但报出来的那根必须是
  // 这三根之一，且文案按实测形状点名它（静态锁钉文案，这条钉它真被印到了 stderr 上）。
  const hits = [...r.stderr.matchAll(INTERP_RE)];
  assert.ok(hits.length > 0, `stderr 必须点名是哪根旋钮缺了：${r.stderr}`);
  const strays = [...new Set(hits.map(([, , v]) => v))].filter((v) => !THREE.includes(v));
  assert.deepEqual(strays, [], `报错点名了不在本单范围内的变量：${strays.join(', ')}：${r.stderr}`);
});

// ── V-逐个单独剔：每根各自都得拦得住，且要点名被剔的那一根 ────────────────────────

test('#643 A V-逐个单独剔：任一根缺值都拦得住，并点名被剔的那根与它的服务路径', (t) => {
  if (!requireCompose(t)) return;
  for (const { name, at } of REMOVAL_CASES) {
    const env = { ...SCRATCH };
    delete env[name]; // 其余两根给 scratch 形态的合法值，只留这一根缺
    const problems = [];
    const seen = new Set();
    // 一根变量喂两处时，compose 先报哪处不固定（Go map 遍历顺序随机）⇒ 多次采样只为把两处都
    // 采到一次；**采不齐不算红**（判据必须是「每次报错都点名被剔的那根、且报在声明的坐标里」，
    // 那才是 fail-closed 的语义）。为什么不能把「两处都采到」当断言：那是拿一个不承重的外部
    // 实现细节（报错顺序）当闸门，会造出偶发假红。两处本身的**文本形态**由静态锁钉死
    // （`portal/test/deploy-env-defaults.test.js`）， enforcement 形状由 proxy 那处证明（同为 environment 映射值）。
    const tries = at.length > 1 ? 12 : 1;
    for (let i = 0; i < tries && seen.size < at.length; i++) {
      const r = configRun(t, env);
      if (r.rc === 0) problems.push(`第 ${i + 1} 次 rc=0（缺 ${name} 却配通了）：回落值回来了？`);
      if (!r.stderr.includes(`required variable ${name} is missing a value`)) {
        problems.push(`第 ${i + 1} 次没点名被剔的 ${name}：${r.stderr.trim().slice(0, 200)}`);
      }
      const hits = [...r.stderr.matchAll(INTERP_RE)];
      for (const [, where, varName] of hits) {
        if (varName !== name) problems.push(`第 ${i + 1} 次报的是 ${varName}，不是被剔的 ${name}`);
        else if (at.includes(where)) seen.add(where);
        else problems.push(`第 ${i + 1} 次报在 ${where}，不在声明的坐标 ${at.join(' / ')} 里`);
      }
    }
    assert.deepEqual(problems, [], `${name} 单独缺值时的读数不对：\n  ${problems.join('\n  ')}`);
    assert.ok(seen.size > 0, `${name} 缺值时 stderr 必须点名 compose 里的服务路径（一处都没有）`);
    if (at.length > 1 && seen.size < at.length) {
      // 只报不拦：采到几处随 compose 的报错顺序变，不是产品缺陷（上面注释）。
      t.diagnostic(`${name} 两处只采到 ${[...seen].join(' / ')}（另一处本次没先报错；` +
        '文本形态由静态锁钉，enforcement 形状由已采到的那处证明）');
    }
    t.diagnostic(`${name} 单独缺值：拦下，命中路径 ${[...seen].sort().join(' / ')}`);
  }
});

// ── V-全给：给了值就别改写（fail-closed 不许顺手加工值）──────────────────────────

test('#643 A V-全给：rc=0 且四处镜像引用逐字等于传入值（scratch 与 digest 两种形态）', (t) => {
  if (!requireCompose(t)) return;
  // 四处 = 两根镜像引用 + `FDE_IMAGE` 喂到的两处（proxy 的 IMAGE_ALLOWLIST、portal 的 FDE_IMAGE）
  const SITES = [
    ['station-portal', 'image'],
    ['station-docker-proxy', 'image'],
    ['station-docker-proxy', 'environment', 'IMAGE_ALLOWLIST'],
    ['station-portal', 'environment', 'FDE_IMAGE'],
  ];
  const VAR_AT = {
    'station-portal/image': 'STATION_PORTAL_IMAGE',
    'station-docker-proxy/image': 'STATION_DOCKER_PROXY_IMAGE',
    'station-docker-proxy/environment/IMAGE_ALLOWLIST': 'FDE_IMAGE',
    'station-portal/environment/FDE_IMAGE': 'FDE_IMAGE',
  };
  for (const [shapeName, values] of [['形态① scratch', SCRATCH], ['形态② pin digest', PINNED]]) {
    const r = configRun(t, values, ['--format', 'json']);
    assert.equal(r.rc, 0, `${shapeName}：三根都给了还报错 ⇒ 判据把合法形态也拦了：${r.stderr}`);
    assert.doesNotMatch(r.stderr, /required variable/, `${shapeName}：不该再报缺值：${r.stderr}`);
    const doc = JSON.parse(r.stdout);
    const problems = [];
    for (const site of SITES) {
      const key = site.join('/');
      let node = doc.services;
      for (const k of site) node = node?.[k];
      const want = values[VAR_AT[key]];
      if (node !== want) {
        problems.push(`${key}: 解析出 ${JSON.stringify(node)} ≠ 传入 ${JSON.stringify(want)}`);
      }
    }
    assert.deepEqual(problems, [],
      `${shapeName}：镜像引用必须逐字透传（改写 / 加前缀 / 补 tag 都是「运维填的和实际跑的不一样」）`
      + '：\n  ' + problems.join('\n  '));
  }
});

// ── V-空值：`VAR=` 也算缺（钉住「.env.example 留空仍然被拒」这个语义）──────────────

test('#643 A V-空值：STATION_PORTAL_IMAGE= 空串照样被拒（.env.example 留空 ≠ 已声明）', (t) => {
  if (!requireCompose(t)) return;
  const env = { ...SCRATCH, STATION_PORTAL_IMAGE: '' };
  const r = configRun(t, env);
  assert.notEqual(r.rc, 0,
    '空串必须算缺失。`deploy/.env.example` 里这三根登记着但**值留空** ⇒ 运维照抄模板起栈时要的'
    + '就是「仍然被拒」。空值被当成有值 = 复制模板就等于声明要动共享 dev 栈，本单的语义就空转了');
  assert.match(r.stderr, /required variable STATION_PORTAL_IMAGE is missing a value/,
    `要点名被剔的那根，不许报成别的原因：${r.stderr}`);
});
