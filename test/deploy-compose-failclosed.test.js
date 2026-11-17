// issue #643 A：**行为锁** —— 让真 `docker compose` 自己对 `deploy/docker-compose.yml` 作答，
// 钉「三根自构建镜像的引用缺值即报错」在 compose 的真实读数里成立。
//
// 病根不是「少一个校验」，是一次**静默换镜像**：`deploy/.env` 不入库（`.gitignore` 里
// `.env` / `.env.*`）⇒ 新 worktree / 新机器根本没有它；而改之前那四处写的是 `${VAR:-回落值}`
// ⇒ 缺文件时**静默**用回落值 ⇒ 任何一次 `docker compose up -d` 都能把**共享 dev 栈**
// （本机只有一套 station-portal / station-docker-proxy）换成 `erix-station/portal:local` 或
// 占位的 `traefik/whoami`：**rc=0、站起来了、一声不响**。运维以为在跑 digest pin 的那个镜像，
// 实际在跑另一棵树现构建的那份。症状离成因隔了一棵 worktree，人抓不到。
// 改成 `${VAR:?}` 之后缺值即拒 ⇒ 本文件钉「拒」真的发生，以及「给了值就不许改写值」。
//
// 为什么这里要一条、`portal/test/deploy-env-defaults.test.js` 那条静态锁也要留：
//   * 静态锁读 compose **文本**，不依赖 docker，任何机器都跑；但它钉不到 compose **自己怎么读**
//     ——「空值算不算缺失」「报错真打出来没有」「给了值会不会被改写」都是 compose 的行为。
//   * 行为锁（本文件）钉真读数；但没 docker 的机器上只能 skip ⇒ 只靠它就有「换台机器形同不存在」
//     的窗口，而那个窗口正是 `:-` 回落值能悄悄溜回来的缝（本单之前的形状就是这么活的）。
//
// compose 2.40.3 的实测形状（判据照它钉；将来换版本这几条会红，那是**对的**）：
//   * 缺值：rc=1、stdout 空（整份 config 不产出，不是给个半成品），stderr 形如
//     `error while interpolating <服务路径>: required variable <VAR> is missing a value: …`；
//   * 一次只报**第一处**插值错误 ⇒ `FDE_IMAGE` 一根喂两处时，先报哪处不固定（Go map 随机序）
//     ⇒ 「点名变量」按名断言、「报在声明的坐标里」按**其中一处**断言；两处是否都采到只当诊断
//     （拿报错顺序当闸门会造出偶发假红；两处的文本形态由静态锁钉，enforcement 形状同一）；
//   * `config` 是**只读**的：`DOCKER_HOST` 指到死端口照样 rc=0 ⇒ 不碰 daemon，也不碰共享栈。
//
// 可复现性：每次调用都带 `--env-file <临时空文件>`。compose 会自动加载同目录的 `.env`，而
// `deploy/.env` 在主检出里有、在别的 worktree 里没有 ⇒ 不压住它，同一份代码在两棵树上结论不同
// （本机那份恰好把三根都填了 ⇒ 「全缺」用例假绿）。这件事由 `V-夹具` 自己在临时目录里复现，
// 本文件**不读写** `deploy/.env`（那个文件属于本机运维）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_REL = 'deploy/docker-compose.yml';

/** 三根自构建镜像的引用变量（`FDE_IMAGE` 一根喂两处：proxy 白名单 + portal env）。 */
const THREE = ['STATION_PORTAL_IMAGE', 'STATION_DOCKER_PROXY_IMAGE', 'FDE_IMAGE'];

/** 合法形态①（scratch 本地构建）：逐个剔一根时，其余两根用它补齐。 */
const SCRATCH = {
  STATION_PORTAL_IMAGE: 'erix-station/portal:local',
  STATION_DOCKER_PROXY_IMAGE: 'erix-station/fde-proxy:local',
  FDE_IMAGE: 'traefik/whoami',
};

/** 合法形态②（部署 / 发布 pin 不可变引用）：证明 pin 形态也逐字透传，没被顺手加工。 */
const PINNED = {
  STATION_PORTAL_IMAGE: 'ghcr.io/erixwong/erix-station-portal@sha256:' + 'a'.repeat(64),
  STATION_DOCKER_PROXY_IMAGE: 'ghcr.io/erixwong/erix-station-fde-proxy@sha256:' + 'b'.repeat(64),
  FDE_IMAGE: 'ghcr.io/erixwong/erix-station-fde@sha256:' + 'c'.repeat(64),
};

/** 逐根剔除的坐标：`at` = compose 报错时点名的服务路径（`FDE_IMAGE` 有两处）。 */
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

/** 「给了值必须逐字透传」的四处落点（键 = `services.<svc>.<路径>`，值 = 该处插的变量）。 */
const PASS_THROUGH = [
  { site: ['station-portal', 'image'], varName: 'STATION_PORTAL_IMAGE' },
  { site: ['station-docker-proxy', 'image'], varName: 'STATION_DOCKER_PROXY_IMAGE' },
  {
    site: ['station-docker-proxy', 'environment', 'IMAGE_ALLOWLIST'],
    varName: 'FDE_IMAGE',
  },
  { site: ['station-portal', 'environment', 'FDE_IMAGE'], varName: 'FDE_IMAGE' },
];

/** 插值错误的实测形状（compose 2.40.3）：取「报在哪一处 + 哪根变量」。 */
function interpHits(text) {
  // 不共用一个全局 RegExp：`matchAll` 会拿 `lastIndex` 接着跑，跨用例串状态会吞掉第一条。
  const re = new RegExp('error while interpolating (\\S+): required variable ([A-Z0-9_]+)', 'g');
  return [...text.matchAll(re)];
}

/**
 * 构造子进程 env：**先删后加**（显式剔掉三根，再叠上这次要给的）。
 * 不用 `env -u VAR VAR=x`：后面那个赋值会盖掉前面的 `-u`（本机实测踩过），
 * 于是「剔掉这根」的用例其实一直带着值跑 ⇒ 判据恒真、谁都发现不了。
 */
function buildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of THREE) delete env[key];
  return { ...env, ...overrides };
}

function spawnCompose(args, { env, cwd = ROOT }) {
  const r = spawnSync('docker', ['compose', ...args],
    { cwd, env, encoding: 'utf8', timeout: 120_000 });
  if (r.error) {
    return { unavailable: true, reason: `${r.error.code ?? r.error.name}: ${r.error.message}` };
  }
  return { rc: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

let probe; // 一次性的可用性读数（skip 与断言共用同一份，不各测各的）

function composeAvailable() {
  probe ??= (() => {
    const r = spawnSync('docker', ['compose', 'version'],
      { cwd: ROOT, env: buildEnv(), encoding: 'utf8', timeout: 60_000 });
    if (r.error) return { ok: false, reason: `${r.error.code ?? r.error.name}: ${r.error.message}` };
    if (r.status !== 0) {
      return { ok: false, reason: `rc=${r.status} ${String(r.stderr ?? '').trim().slice(0, 160)}` };
    }
    return { ok: true, version: String(r.stdout ?? '').trim() };
  })();
  return probe;
}

/** 没 docker ⇒ skip 并打印原因（先例：`test/integration-e2e-preflight.test.js` 的 E4）。 */
function requireCompose(t) {
  const p = composeAvailable();
  if (p.ok) return p;
  t.skip(`本机没有可用的 docker compose（${p.reason}）⇒ 行为锁退回静态锁 `
    + '`portal/test/deploy-env-defaults.test.js`（那条不依赖 docker）；这是环境问题不是产品坏了');
  return null;
}

/** 临时空 env 文件：压掉 compose 自动加载的同目录 `.env`；`t.after` 清理。 */
function emptyEnvFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-643-compose-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'empty.env');
  fs.writeFileSync(file, '');
  // 红线自查：本单不读写 `deploy/.env`（它属于本机运维，且它的存在与否正是病根本身）。
  assert.notEqual(path.resolve(file), path.join(ROOT, 'deploy', '.env'));
  return file;
}

/** 对仓库里那份真 compose 跑 `config`（只读，不碰 daemon）。 */
function configRun(t, env, extra = []) {
  const r = spawnCompose(['--env-file', emptyEnvFile(t), '-f', COMPOSE_REL, 'config', ...extra],
    { env: buildEnv(env) });
  assert.equal(r.unavailable, undefined, `docker 不可用却走到了断言里：${r.reason}`);
  return r;
}

// ── V-可用性：skip 不是安慰剂，「没环境」那条分支自己得能亮 ────────────────────────

test('#643 A V-环境探针：没 docker 就 skip 并说明（反向自证：不存在的可执行文件必须被认出）',
  (t) => {
    // 没有这条反向自证，探针可能被写成「永远 ok」⇒ skip 分支是死代码 ⇒ 没 docker 的机器上
    // 整个文件**静默全绿**，那正是本文件要防的「换台机器形同不存在」。
    const fake = spawnSync('erix-643-not-a-real-binary', ['compose', 'version'],
      { cwd: ROOT, env: buildEnv(), encoding: 'utf8', timeout: 10_000 });
    assert.ok(fake.error, '不存在的可执行文件必须让 spawnSync 给 error（探针靠它认「没环境」）');
    assert.ok(String(fake.error.code ?? fake.error.message).length > 0,
      '「没环境」的读数必须带原因（skip 文案要印出来）');

    const p = requireCompose(t);
    if (!p) return; // 已 skip；上面那条反向自证与 skip 分支无关，仍然跑过
    assert.match(p.version, /Docker Compose version/, `读数不像 compose 版本：${p.version}`);
    t.diagnostic(`行为锁现场：${p.version}（cwd=${ROOT}，对真实 ${COMPOSE_REL} 作答）`);
  });

// ── V-夹具：`--env-file <空文件>` 必须压得住 compose 自动加载的同目录 .env ─────────

test('#643 A V-夹具：空 --env-file 压得住自动加载的同目录 .env（否则本文件在两棵树上结论不同）',
  (t) => {
    if (!requireCompose(t)) return;
    // 「同目录有 .env」只能在夹具里复现：真 `deploy/.env` 不入库（别的 worktree 没有），
    // 而主检出里那份恰好把三根都填了 ⇒ 压不住它，「V-全缺」就是假绿。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-643-shield-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, '.env'), 'ERIX643_SENTINEL=from-auto-dot-env\n');
    const probeFile = path.join(dir, 'probe.yml');
    fs.writeFileSync(probeFile, 'services:\n  probe:\n    image: ${ERIX643_SENTINEL:?must be set}\n');

    const auto = spawnCompose(['-f', probeFile, 'config', '--format', 'json'],
      { env: buildEnv(), cwd: dir });
    assert.equal(auto.rc, 0, `夹具要能复现「同目录 .env 被自动加载」：${auto.stderr}`);
    assert.equal(JSON.parse(auto.stdout).services.probe.image, 'from-auto-dot-env',
      'compose 自动加载的就是同目录那个 .env（不压住它 ⇒ 主检出全缺用例假绿）');

    const shielded = spawnCompose(
      ['--env-file', emptyEnvFile(t), '-f', probeFile, 'config', '--format', 'json'],
      { env: buildEnv(), cwd: dir });
    assert.notEqual(shielded.rc, 0, '带空 --env-file 时那个值必须认不到（否则 V-全缺 是假绿）');
    assert.match(shielded.stderr, /required variable ERIX643_SENTINEL is missing a value/);
  });

// ── V-全缺：三根都不给 ⇒ 必须报错，不是「站起来了」 ───────────────────────────────

test('#643 A V-全缺：三根都不给 ⇒ rc≠0、不产出半成品 config、且点名是哪根旋钮', (t) => {
  if (!requireCompose(t)) return;
  const r = configRun(t, {}); // buildEnv 已显式剔掉三根
  assert.notEqual(r.rc, 0,
    '三根全缺必须非 0。rc=0 就意味着回落值回来了 —— 那正是「`up -d` 静默把共享 dev 栈换成 '
    + ':local / traefik/whoami」的原始形状（本单要治的就是它）\nstderr: ' + r.stderr);
  assert.equal(r.stdout.trim(), '',
    '缺值时整份 config 不产出：给个半份解析结果就是「看起来配好了」的第二个版本');
  assert.match(r.stderr, /required variable/, `报错要落在「缺值」这个原因上：${r.stderr}`);
  // compose 一次只报第一处 ⇒ 这里不要求三根全点名，但报出来的那根必须是本单范围内的旋钮
  const named = interpHits(r.stderr).map((m) => m[2]);
  assert.ok(named.length > 0, `stderr 必须点名是哪根旋钮缺了：${r.stderr}`);
  const strays = [...new Set(named)].filter((v) => !THREE.includes(v));
  assert.deepEqual(strays, [], `报错点名了不在本单范围内的变量：${strays.join(', ')}：${r.stderr}`);
});

// ── V-逐个单独剔：任一根缺值都拦得住，并点名被剔的那根与它的服务路径 ──────────────

test('#643 A V-逐个单独剔：任一根缺值都拦得住，且点名被剔的那根与它声明的服务路径', (t) => {
  if (!requireCompose(t)) return;
  for (const { name, at } of REMOVAL_CASES) {
    const env = { ...SCRATCH };
    delete env[name]; // 其余两根给合法值，只留这一根缺 ⇒ 「单独缺」也被拦
    const problems = [];
    const seen = new Set();
    // 一根喂两处时先报哪处不固定（Go map 遍历随机）⇒ 多次采样只为多采几处；**采不齐不算红**
    // （承重的是「每次报错都点名被剔的那根、且报在声明的坐标里」，那才是 fail-closed 的语义）。
    // 两处各自的文本形态由静态锁钉死（`portal/test/deploy-env-defaults.test.js`）。
    const tries = at.length > 1 ? 12 : 1;
    for (let i = 0; i < tries && seen.size < at.length; i++) {
      const r = configRun(t, env);
      if (r.rc === 0) problems.push(`第 ${i + 1} 次 rc=0（缺 ${name} 却配通了）⇒ 回落值回来了`);
      if (!r.stderr.includes(`required variable ${name} is missing a value`)) {
        problems.push(`第 ${i + 1} 次没点名被剔的 ${name}：${r.stderr.trim().slice(0, 200)}`);
      }
      const hits = interpHits(r.stderr);
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
      t.diagnostic(`${name} 两处只采到 ${[...seen].join(' / ')}（另一处本次没先报错）`);
    } else {
      t.diagnostic(`${name} 单独缺值：拦下，命中路径 ${[...seen].sort().join(' / ')}`);
    }
  }
});

// ── V-全给：给了值就别改写（fail-closed 不许顺手加工值）──────────────────────────

test('#643 A V-全给：rc=0 且四处镜像引用逐字等于传入值（两种合法形态各判一次）', (t) => {
  if (!requireCompose(t)) return;
  for (const [shapeName, values] of [['形态① scratch tag', SCRATCH], ['形态② pin digest', PINNED]]) {
    const r = configRun(t, values);
    assert.equal(r.rc, 0, `${shapeName}：三根都给了还报错 ⇒ 判据把合法形态也拦了：${r.stderr}`);
    assert.doesNotMatch(r.stderr, /required variable/, `${shapeName}：不该再报缺值：${r.stderr}`);
    const doc = parse(r.stdout); // 读 compose **自己解析出来的**那份，不是我们塞进去的那份
    const problems = [];
    for (const { site, varName } of PASS_THROUGH) {
      let node = doc.services;
      for (const k of site) node = node?.[k];
      const want = values[varName];
      if (node !== want) {
        problems.push(`services.${site.join('.')} = ${JSON.stringify(node)} ≠ 传入的 `
          + `${varName}=${JSON.stringify(want)}`);
      }
    }
    assert.deepEqual(problems, [],
      `${shapeName}：镜像引用必须逐字透传（改写 / 补 tag / 加前缀都是「运维填的和实际跑的不一样」）`
      + '：\n  ' + problems.join('\n  '));
  }
});

// ── V-空值：`VAR=` 也算缺（钉住「.env.example 留空仍然被拒」这个语义）──────────────

test('#643 A V-空值：填了变量但值是空串 ⇒ 照样被拒（复制模板 ≠ 已声明要动共享栈）', (t) => {
  if (!requireCompose(t)) return;
  const env = { ...SCRATCH, STATION_PORTAL_IMAGE: '' };
  const r = configRun(t, env);
  assert.notEqual(r.rc, 0,
    '空串必须算缺失：`deploy/.env.example` 里这三根登记着但**值留空**，运维照抄模板起栈时'
    + '要的就是「仍然被拒」。空值被当成有值 = 复制模板就等于声明要动共享 dev 栈，本单语义空转');
  assert.match(r.stderr, /required variable STATION_PORTAL_IMAGE is missing a value/,
    `要点名被剔的那根，不许报成别的原因：${r.stderr}`);
});
