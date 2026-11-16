// issue #586：版本号的**唯一读面**（三格各自从哪儿取、取不到怎么表现）。
//
// 本单要治的真事故（发 v0.1.69）：`git pull` 抖动只 fetch 没 pull ⇒ `docker compose build station-portal`
// 用的是停在 0.1.68 的宿主工作树 ⇒ 真机上 **FDE 报 0.1.69、portal 报 0.1.68 分裂一小时**，而
// **没有任何机器判据能发现**（portal 镜像当时没有 `build-info.json`，`ci.yml` 的 ⑤′ tripwire 只查 FDE 镜像）。
// 根因不是「忘了同步」，是**版本有两个来源而其中一个没人负责**（`runner/lib/build-info.js` 顶部记的
// `0.1.0` / `0.1.32-088e41e` 是同一形状的事故）。所以本文件的职责不是「算一个版本号」，是**只有一条读法**：
//
// | 格 | 来源（唯一） | 取不到 |
// |---|---|---|
// | 服务端版本（portal 镜像） | portal 镜像内 `/app/build-info.json` 的 `station_version`（`portal/Dockerfile` 末尾烘进去） | `unknown` |
// | 平台侧引擎（portal 镜像里的 erix-agent） | 同一份的 `engine_version` | `unknown` |
// | 每台 FDE 的引擎 | `containers.agent_version`（**派生副本**，不是权威载体） | `unknown` |
//
// 三条红线（`portal/test/version-surface.test.js` 逐条钉）：
//   1. **不许互抄**：三格各有自己的来源。把 FDE 那格写成平台侧引擎版本、或把服务端那格从
//      `package.json` 现读，都是本单要消灭的形状（`package.json` 是**构建输入**，不是运行事实）。
//   2. **读版本只走 `readBuildInfo()`**（`./build-info.js`）：业务代码里出现 `require('../package.json')`
//      就是第二个真相源。dev 源码态由它自己退到仓库根 `package.json`（镜像里 `/app` 就是仓库根的对应物）。
//   3. **缺字段给 `unknown`，永不 `undefined`、永不抛**：一个看起来合法的假值比空值毒（同一份注释），
//      而这条读法挂在 `/api/health` 上——一个观测字段不许把 readiness 端点打挂（#515 同口径）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBuildInfo, UNKNOWN } from './build-info.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * portal 镜像里 build-info.json 的位置（`portal/Dockerfile` 末尾那一层写的）。
 * ⚠ 与 runner 的 `/opt/erix/build-info.json` **不是同一个文件**：一个镜像一份，各说各的版本。
 * 本地源码态没有这个文件 ⇒ `readBuildInfo()` 退到 `package.json`（`source: 'package'`）。
 */
export const BUILD_INFO_PATH = '/app/build-info.json';

/**
 * dev 退路读 `package.json` 的落点：`portal/src/` 的上两级。
 * 镜像内 = `/app`（`package.json` 与 `node_modules/erix-agent/package.json` 都在那儿），
 * 源码态 = 仓库根（同一形状）⇒ 两份布局同源，不需要按环境分支。
 */
export const PACKAGE_DIR = path.resolve(HERE, '..', '..');

/** 只认非空字符串，其余（`undefined` / 数字 / 空串 / 脏形状）一律 `unknown`。 */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : UNKNOWN;
}

/** 按优先级取第一个非空字符串；一个都没有 ⇒ 兜底值。 */
function firstString(candidates, fallback) {
  for (const item of candidates) {
    const v = text(item);
    if (v !== UNKNOWN) return v;
  }
  return fallback;
}

/**
 * 读 portal 这一侧的三格中前两格（服务端 + 平台侧引擎）。
 * @param {{env?: Record<string,string|undefined>, buildInfoPath?: string, packageDir?: string}} [opts]
 *   注入点：`buildInfoPath`（也可用 env `STATION_BUILD_INFO_PATH`）——契约测试拿它注入一份与
 *   `package.json` 版本不同的 build-info，**不真改仓库文件**（判据 D-1）。
 * @returns {{station:string,engine:string,revision:string,builtAt:string,source:string,buildInfoPath:string}} 六格全是字符串
 */
export function readStationVersion({ env = process.env, buildInfoPath, packageDir = PACKAGE_DIR } = {}) {
  const fallback = {
    station: UNKNOWN, engine: UNKNOWN, revision: UNKNOWN, builtAt: UNKNOWN, source: UNKNOWN,
    buildInfoPath: UNKNOWN,
  };
  try {
    // **在入口就挡掉 `ERIX_AGENT_VERSION`**（评审阻断，#586）。`readBuildInfo()` ① 那条 override 是
    // **FDE 容器侧**的正当需求：`provisioner.js:281` 往容器 env 里注它，声明「容器内跑的是哪个引擎」，
    // 那里它跟容器自己的 build-info.json **同源**，盖了不谎报。portal 不是那个场合：它的权威载体是
    // **自己镜像里的** `/app/build-info.json`，没有任何合法理由让一个环境变量冒充镜像里的构建产物。
    // 不挡会谎报来源：`aboutPanel()` 的 `provenance.platformEngine` 写的是 `'build-info.json'`（写死的），
    // 而 engine 那格会被 env 撑成另一个数 ⇒ 面板显示的值不来自它自称的那个来源，**正是本单要消灭的形状**。
    // 口径选择：env 冒充就在入口挡掉，而不是「让它盖过去再把 provenance 改成 `'env'`」——后者只是把
    // 谎话换成「来源=env」，而我们的口径是**镜像内 build-info 才是权威**。
    const { ERIX_AGENT_VERSION: _engineOverrideIgnored, ...envSansOverride } = env ?? {};
    // 解析完的路径要**带出去**（复验：面板新增 `buildInfoPath`）——下面三条旋钮都能把它换掉，
    // 而「路径被改过」如果不透出，界面就没法区分「读的是镜像里那份」与「读的是某处注入的那份」。
    const resolvedBuildInfoPath = firstString(
      [buildInfoPath, envSansOverride.STATION_BUILD_INFO_PATH, envSansOverride.ERIX_BUILD_INFO_PATH],
      BUILD_INFO_PATH,
    );
    const info = readBuildInfo({
      env: envSansOverride,
      // 优先级：显式入参 > `STATION_BUILD_INFO_PATH`（portal 自己的注入旋钮，契约测试用）>
      // `ERIX_BUILD_INFO_PATH`（runner 那份链里已有的那个旋钮，保留兼容）> portal 镜像内的默认位置。
      // ⚠ 必须**显式**传：`readBuildInfo()` 自己的兜底是 runner 的 `/opt/erix/build-info.json`，
      //   那是**另一个镜像**里的另一份版本，portal 拿它当默认就会读到 FDE 的账。
      buildInfoPath: resolvedBuildInfoPath,
      packageDir,
    });
    return {
      // `runnerVersion` 就是 build-info 里的 `station_version`（字段名是 runner 时代的历史包袱）。
      station: text(info.runnerVersion),
      engine: text(info.agentVersion),
      revision: text(info.revision),
      builtAt: text(info.builtAt),
      source: text(info.source),
      // 「去哪条路径读了」与「读到了没有」是两件事：前者就是这一格，后者看 `source`。
      buildInfoPath: text(resolvedBuildInfoPath),
    };
  } catch {
    // `readBuildInfo()` 自己不抛（它内部每级都 catch），这一层只兜「env 传了个脏东西」这类装配错。
    return fallback;
  }
}

/**
 * `/healthz` 与 `/api/health` 的 `version` 块（判据 B）。
 *
 * **只有三格**：`station` / `revision` / `builtAt`。刻意**不带引擎版本**：portal 侧引擎与每台 FDE 的
 * 引擎是两个不同的数，并排塞进一个**公开、零鉴权**的端点里就会被读错（「`version.engine` 是哪个引擎？」
 * 没有上下文可答）。引擎那格只在管理台「关于」面板里出现（那里有标签说明它是谁）。
 *
 * 观测面不承重：任何异常 ⇒ 三格 `unknown`，`status` 与 200/503 语义一字不动（#515 同口径）。
 * @param {() => {station?: unknown, revision?: unknown, builtAt?: unknown}} [read] 注入点（测试用）
 * @returns {{station:string,revision:string,builtAt:string}}
 */
export function healthVersionBlock(read = readStationVersion) {
  try {
    const v = read() ?? {};
    return { station: text(v.station), revision: text(v.revision), builtAt: text(v.builtAt) };
  } catch {
    return { station: UNKNOWN, revision: UNKNOWN, builtAt: UNKNOWN };
  }
}

/**
 * 第三格：每台 FDE 的引擎版本。⚠ 读的是 `containers.agent_version` —— **派生副本**，不是权威载体。
 * 写它的是 provision（`provisioner.js#upsertContainerRow`，那一刻从镜像/env 取）与容器心跳
 * （`internal.js#heartbeat`，agentd 从**自己镜像里**的 build-info.json 读出来上报）。
 * 所以它的口径是「这台机器上次被报告时跑的是什么」，**不是**「这个镜像现在是什么」；
 * 面板必须把它标成快照（判据 C），否则管理员会拿它当实时事实与 portal 那一格对比。
 */
export const FDE_VERSION_SQL = `
  SELECT fde_name, agent_version, image, created_at, rotated_at, last_heartbeat, revoked_at
    FROM containers
   ORDER BY fde_name`;

/** 一行 containers → 面板项。脏形状（缺列 / 非字符串版本）不猜：**整行不丢，版本落 `unknown`**。 */
export function normalizeFdeRow(row) {
  const name = typeof row?.fde_name === 'string' ? row.fde_name.trim() : '';
  return {
    name: name !== '' ? name : UNKNOWN,
    agentVersion: text(row?.agent_version),
    image: text(row?.image),
    provisionedAt: typeof row?.created_at === 'string' || row?.created_at instanceof Date
      ? (row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at)
      : null,
    lastHeartbeatAt: row?.last_heartbeat instanceof Date
      ? row.last_heartbeat.toISOString()
      : text(row?.last_heartbeat) === UNKNOWN ? null : text(row?.last_heartbeat),
    revoked: row?.revoked_at !== null && row?.revoked_at !== undefined,
    // 机器可读的来源标注（前端据此渲染本地化文案；**不许**前端自己再算一份版本）。
    versionSource: 'containers.agent_version',
    snapshot: 'provision',
  };
}

/**
 * `readBuildInfo()` 的 `source` → 面板上的**来源标注**（复验阻断：这里写死就会在旧镜像上谎报）。
 *
 * 为什么必须推导而不是常量：`readBuildInfo()` 的降级链里 `build-info.json` **读不到**时（本 PR 之前
 * 构建的旧 portal 镜像、烘失败、路径指错）会退到 `packageDir/node_modules/erix-agent/package.json`，
 * 此时 `source === 'package'`——而面板上那个引擎号**确实是**从那份 `package.json` 读的。写死
 * `'build-info.json'` 就说的是谎话：声称「镜像里的构建产物」，而旧镜像里根本没烘那个文件。
 * `'env'` 理论上已被入口屏蔽，但**出现就说 `'env'`**（不许静默说成 build-info）；认不出的取值
 * 一律 `'unknown'`（不猜）。
 *
 * ⚠ `source` 是**整次读取的共用来源**（`readBuildInfo()` 只出一个 `source`，不分格），所以
 * `server` 与 `platformEngine` 两格从此**必然同源**（同一个文件）。两格仍然各自输出，是为了
 * 让面板不必自己推；若将来某一格真的换了来源，这里必须显式改成按格推导。
 */
const PROVENANCE_BY_SOURCE = {
  'build-info': 'build-info.json',
  package: 'package.json',
  env: 'env',
};

/** 认不出的 `source` ⇒ `'unknown'`（不猜、也不默认成 build-info）。导出给面板与用例共用。 */
export function provenanceFor(source) {
  const key = typeof source === 'string' ? source.trim() : '';
  return PROVENANCE_BY_SOURCE[key] ?? UNKNOWN;
}

/**
 * **有值才谈来源**（第三轮评审 nit）：值为 `unknown` 时，来源也只能是 `'unknown'`。
 *
 * 要挡的形状：`readBuildInfo()` 只要**根** `package.json` 可读就置 `source: 'package'`，哪怕
 * `node_modules/erix-agent/package.json` 根本不存在、引擎那格其实是 `unknown` ⇒ 照 `source` 直推就会
 * 写成「来自 package.json」，而那一格**根本没有值**（标注在冒充来源）。所以标注只在「确有其值」时
 * 才说来源；值缺就不冒充。与上一轮同一取向：标注必须是**真话**，宁可说「未知」。
 */
export function provenanceForValue(value, source) {
  return text(value) === UNKNOWN ? UNKNOWN : provenanceFor(source);
}

/**
 * 管理台「关于」面板的三段（判据 C）。
 * @param {{pool: object, readVersion?: () => object, log?: {warn?: (m: string) => void}}} opts
 */
export async function aboutPanel({ pool, readVersion = readStationVersion, log = console }) {
  const v = readVersion();
  let fdes = [];
  let fdesPresent = false;
  try {
    const res = await pool.query(FDE_VERSION_SQL);
    fdesPresent = Array.isArray(res?.rows);
    fdes = (fdesPresent ? res.rows : []).map((row) => normalizeFdeRow(row));
  } catch (err) {
    // 读不到 ≠ 「一台 FDE 都没有」（#350 同口径）：`fdesPresent:false` 让页面说「读不到」而不是「空」。
    fdesPresent = false;
    log?.warn?.(`[version] containers.agent_version 读取失败：${err?.message ?? err}`);
  }
  return {
    server: {
      station: text(v.station),
      revision: text(v.revision),
      builtAt: text(v.builtAt),
      // 这一格到底从哪儿读的（`build-info` = 镜像里的构建产物；`package` = dev 源码态退路；
      // `env`/`unknown` 同理）。管理员据此知道「这个数是烘进来的还是现读的」，不许页面自己猜。
      source: text(v.source),
    },
    platformEngine: { version: text(v.engine) },
    // 实际去读的那条 build-info 路径（可被 `STATION_BUILD_INFO_PATH` / `ERIX_BUILD_INFO_PATH` / 入参改过）。
    // 复验要求的路径可见性：这三个旋钮本身是**测试注入点**（不删），但「路径被改过」在界面上必须看得出来
    // ——否则一份指向别处的文件就会顶着「镜像内 build-info.json」这个标签出现。它只能证明「读了这条路径」，
    // 证明不了「读到了」（`provenance.*` 非 `build-info.json` 时它就是没读到）。
    buildInfoPath: text(v.buildInfoPath),
    fdes,
    fdesPresent,
    provenance: {
      // **由实际来源推导**（`readStationVersion()` 返回的 `source`），不是常量：写死 `'build-info.json'`
      // 在「build-info 读不到 ⇒ 退 `package.json`」的旧 portal 镜像上就是谎报（声称镜像构建产物，而那个
      // 文件根本没烘）。推导链见 `provenanceFor()`；`server` 与 `platformEngine` 同源（一次读取一个 source）。
      // 但引擎那格多一道**有值才报来源**的闸门（见 `provenanceForValue`）：`source` 是整次读取共用的，
      // 而引擎值可能根本没读到（`node_modules/erix-agent/package.json` 缺失），那时它只能说 `'unknown'`。
      server: provenanceFor(v.source),
      platformEngine: provenanceForValue(v.engine, v.source),
      fdes: 'containers.agent_version',
      fdesSnapshot: 'provision',
    },
  };
}
