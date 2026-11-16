// e2e 的「起跑前预检」与「等宿主侧物化文件」的失败分类（issue #495 = #412 遗留 ①②）。
//
// 两条都不是产品代码，而是**让 e2e 的失败长得像它真正的原因**：
//
// ① `assertComposeEnvFile`：各 e2e 的 compose 命令串固定带 `--env-file deploy/.env`，而该文件不入 git
//    （本机 pin 链 + 口令）⇒ 在 git worktree / 新 clone 里跑必然是 `couldn't find env file`。
//    docker compose 报这句话的时机在**整轮镜像构建之后**（#412 部署机实测：先烧掉 10.7 分钟），
//    所以「缺文件」这种一秒就能判的事实必须在脚本自己的第一步判掉，并点名要复制哪个文件。
//
// ② `observeHostPath` / `waitForHostFile`：等 portal 写到宿主 bind mount 里的文件时，旧写法是
//    `fs.existsSync(p) ? readFileSync(p) : null`。`existsSync` 对**没权限**的路径返回 `false`
//    （EACCES 被吞），而 portal 以 root 把 FDE 目录建成 `0770 node:node`（uid/gid 1000）——
//    跑测试的人 uid ≠ 1000 时文件其实早就写出来了，测试却等到超时，报的文案与「真的没物化」**逐字相同**
//    （#412 原工单自认「最费时间的一条」，当时靠手工把四个 uid/gid 指给自己才绕开）。
//    ⚠ 反向红线：修法**不是**「忽略读错误继续等」——那会把真的没物化也拖成一句超时。状态必须三分：
//    present / missing（链上第一段就不存在）/ unreadable（存在但进不去），三种状态给三种文案。
//    另加一条**独立事实**（不改成第四态）：链上**每一段**是符号链接时把链接与目标说出来
//    （逐段：`observeSegmentLink`；末段：`observeLastSegmentLink`）——bind 源做成链接是合法配置，但
//    「宿主上 `ls` 到的」与「portal 容器里读到的那一侧」不是同一个 inode，不说出来就是拿状态去猜挂载形态。
//    尤其要看**非末段**：`/srv/erix -> /data/erix` 这种「bind 源本身就是链接」的常见摆法里，末段根本不像链接，
//    只看末段就等于完全看不见它。
//
// ⚠️ 本文件是 assertComposeEnvFile / inspectHostPathChain / observeHostPath / observeSegmentLink /
// observeLastSegmentLink / formatLastSegmentLinkLine / formatAncestorLinkLines / waitForHostFile /
// toContainerPath / materializeSnapshot 的**唯一定义处**，
// 新增 e2e 一律 import，禁止在脚本里复制第二份
// （`portal/integration/isolation-negative.mjs` 的单一来源断言把定义处钉在这里）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（本文件位于 portal/integration/lib/）。 */
export const REPO_ROOT = path.resolve(LIB_DIR, '..', '..', '..');

/** 各 e2e 的 compose 命令串里写死的那份 env 文件（相对仓库根；不入 git）。 */
export const COMPOSE_ENV_FILE = 'deploy/.env';

/**
 * userspace 在 **portal 容器内**的路径（`deploy/docker-compose.yml` 里 portal 的 bind 右值，
 * 与宿主侧 `ERIX_USERSPACE_ROOT_HOST` 同路径挂载）——拉容器侧现场快照时要把宿主路径换算成它。
 * 写死在这里是单一来源：各 e2e 一律 import，不在脚本里抄字面量（isolation-negative 钉住）。
 */
export const PORTAL_USERSPACE_CONTAINER_ROOT = '/srv/erix/users';

const R_OK = fs.constants.R_OK;
const X_OK = fs.constants.X_OK;

/** 当前进程身份（Windows 无 getuid ⇒ '?'；它只是诊断线索，不参与判定）。 */
function selfIds() {
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : '?',
    gid: typeof process.getgid === 'function' ? process.getgid() : '?',
  };
}

/** `0o770` 形态的权限位（含 setgid 等高位——权限排查要看高位）。 */
function modeOf(stat) {
  return stat ? `0o${(stat.mode & 0o7777).toString(8)}` : '未知';
}

/** stat 的属主摘要 `uid:gid`；拿不到 ⇒ '未知'。 */
function ownerOf(stat) {
  return stat ? `${stat.uid}:${stat.gid}` : '未知';
}

/** 安全的 stat：不存在 / 进不去 ⇒ `null`（不抛）。只用于「拿个 mode/owner 当现场信息」这类**不参与归因**的旁证。 */
function statOrNull(target, fsImpl) {
  try {
    return fsImpl.statSync(target);
  } catch {
    return null;
  }
}

/**
 * 不吞错误的 stat：把 `{stat}` 或 `{error}` 一起交回调用方。
 *
 * 为什么需要它（issue #495 第二轮 MED）：`statOrNull` 把 `EACCES` 与 `ENOENT` 压成同一个 `null`，
 * 于是走查里「进不去」被归成 `missing` —— 失败文案会说「还没物化」，而真相是「进不去」，
 * 等待器还会干等到超时（与「真的没物化」逐字同形）。归因要用 errno，所以错误本身必须传出去。
 * 「同一个文件里 `observeHostPath()` 对末段的 `EACCES` 正确归 `unreadable`、走查处却不」——两处口径
 * 不一致就是这条 MED；本函数就是把口径收拢到一处。
 */
function statResult(target, fsImpl) {
  try {
    return { stat: fsImpl.statSync(target) };
  } catch (error) {
    return { error };
  }
}

/**
 * errno ⇒ 归因的**唯一一张表**（issue #495 第三轮 MED）。
 *
 * 为什么必须是一张表、而不是三个探测点各写一遍 if：各写一遍之后，「既不是权限也不是缺失」的 errno
 * （`EIO`/`ELOOP`/`ENAMETOOLONG`…）被**就近**塞进两个桶：走查里的 `statSync → EIO` 落 `missing`
 * （文案说「还没物化」），`accessSync → EIO` 落 `unreadable`+`no-permission`（文案说「读不到」）——
 * 两种都是凭空编的归因（而等待器一边会干等到超时、一边会提前放弃）。
 * 第三支走**已有的** `unknown` 出口：状态面仍是 `present`/`missing`/`unreadable` + `unknown`，**没有第五态**。
 */
const PROBE_ERRNO_CLASS = new Map([
  ['ENOENT', 'missing'],
  ['ENOTDIR', 'missing'],
  ['EACCES', 'unreadable'],
  ['EPERM', 'unreadable'],
]);

/** 一个 errno 落在哪个出口；**表里没有就是 `unknown`**（不许就近二选一）。 */
function classifyProbeErrno(code) {
  return PROBE_ERRNO_CLASS.get(code ?? null) ?? 'unknown';
}

/**
 * `unknown` 出口的载荷：把「哪一次探测、哪条路径、什么 errno」原样交回，不硬塞进两个桶。
 * `message` 里**不写**「读不到」/「没物化」——那两句只属于归因得了的两种状态。
 */
function probeUnknown(at, probe, error) {
  const code = typeof error?.code === 'string' ? error.code : null;
  return {
    path: at,
    probe,
    code,
    message: `${probe} ${at} 报 ${code ?? ''} ${error?.message ?? error ?? '未知错误'}`.replace(/\s+/g, ' ').trim()
      + '（既不是「不存在」也不是「进不去」⇒ 不下结论）',
    cause: error ?? null,
  };
}

/**
 * 链接目标的**旁证**三态：`true` 存在 / `false` **真** `ENOENT`、`ENOTDIR` / `null` **这次探不到**。
 *
 * 为什么不能是布尔（第三轮 MED）：旧写法 `Boolean(statOrNull(...))` 把 `EACCES` 与 `ENOENT` 压成同一个
 * `false`，于是「目标目录只是没 `x`（`0o444`）」也会让文案端出「缺的是**链接目标**」——把「探不到」
 * 说成「不存在」，人就去找一个根本没丢的文件。归因可以只拿 errno，但**旁证也不许把探不到编成结论**。
 */
function probeTargetExists(target, fsImpl) {
  const { stat, error } = statResult(target, fsImpl);
  if (stat) return true;
  return classifyProbeErrno(error?.code) === 'missing' ? false : null;
}

/**
 * `stat` 失败时 blocker 的 `mode`/`owner`：只能退到 **`lstat`**（不跟随，对悬空链接与「目标进不去」
 * 都还能看见本体）。拿不到就填 **`null`**（不是 `0o?` / 也不是「未知」这种当成事实的字面量）——
 * 文案会诚实说「这次探不到」；**不许**把探不到编成结论。
 */
function lstatFacts(target, fsImpl) {
  if (typeof fsImpl.lstatSync !== 'function') return { mode: null, owner: null };
  try {
    const stat = fsImpl.lstatSync(target);
    return { mode: modeOf(stat), owner: ownerOf(stat) };
  } catch {
    return { mode: null, owner: null };
  }
}

/** 复制一份 env 文件的修法文案（相对路径按调用方的 cwd 解析后给绝对路径，省得猜）。 */
function envFileFix(file) {
  const posix = file.split(path.sep).join('/');
  return `修复：从主 checkout 复制一份 —— cp <主 checkout>/${COMPOSE_ENV_FILE} ${file}`
    + `（模板 ${posix.replace(/\/[^/]*$/, '')}/.env.example；它不入 git，见 .gitignore 与 docs/env.md §0）。`;
}

/**
 * ① compose `--env-file` 的起跑前预检：**成功时零输出**（只返回事实，不打印）。
 *
 * 判的是「compose 会拿到的那个路径」：相对路径按 `cwd`（各脚本的 REPO_ROOT）解析，与命令串里
 * `--env-file deploy/.env` 同口径。三种失败各自点名，不给 compose 第二次机会：不存在 /
 * 不是普通文件 / 存在但读不到（属主不是你）。
 *
 * @param {object} [options]
 * @param {string} [options.envFile] env 文件路径（缺省 = compose 命令串里写死的 `deploy/.env`）
 * @param {string} [options.cwd] 相对路径的解析基准（各 e2e 传自己的 REPO_ROOT）
 * @param {string} [options.label] 出错文案里的脚本名
 * @param {typeof import('node:fs')} [options.fsImpl] 注入用（夹具 / 负例）
 * @returns {{file: string, bytes: number}} 绝对路径与字节数（调用方可不打）
 */
export function assertComposeEnvFile({
  envFile = COMPOSE_ENV_FILE,
  cwd = REPO_ROOT,
  label = 'e2e',
  fsImpl = fs,
} = {}) {
  const shown = String(envFile || COMPOSE_ENV_FILE);
  const file = path.isAbsolute(shown) ? shown : path.resolve(cwd, shown);
  const fix = envFileFix(file);
  const { uid, gid } = selfIds();
  let stat = null;
  let statError = null;
  try {
    stat = fsImpl.statSync(file);
  } catch (error) {
    statError = error;
  }
  if (!stat) {
    const code = statError?.code;
    const statClass = classifyProbeErrno(code);
    if (statClass === 'missing') {
      throw new Error(
        `${label} 起跑前预检失败：compose 的 --env-file ${file} 不存在。\n`
        + 'git worktree / 新 clone 里没有它是常态（.env 不入库），而 compose 要到**整轮镜像构建之后**\n'
        + '才报 couldn\'t find env file（#412 部署机实测：白烧 10.7 分钟）——所以这条预检必须在任何 docker 之前。\n'
        + `⇒ ${fix}`,
      );
    }
    if (statClass === 'unreadable') {
      throw new Error(
        `${label} 起跑前预检失败：--env-file ${file} 存在但读不到（${code}；当前 uid/gid=${uid}/${gid}，`
        + `多半是它本身或它的父目录属主不是你）。\n⇒ ${fix}`,
      );
    }
    // 表里查不到的 errno ⇒ 第三支（也是 `unknown` 的意思：不许拿「不存在」或「读不到」当默认值）。
    throw new Error(`${label} 起跑前预检失败：stat ${file} 报 ${code ?? statError?.message ?? '未知错误'}`
      + '（既不是「不存在」也不是「读不到」⇒ 不下结论）');
  }
  if (!stat.isFile()) {
    throw new Error(`${label} 起跑前预检失败：--env-file ${file} 不是普通文件（${modeOf(stat)}）。\n⇒ ${fix}`);
  }
  try {
    fsImpl.accessSync(file, R_OK);
  } catch (error) {
    // 同一张表（第三轮 MED）：`stat` 都成功了而 `access` 报的不是权限 ⇒ 别一律写成「读不到」。
    const accessClass = classifyProbeErrno(error?.code);
    if (accessClass !== 'unreadable') {
      throw new Error(`${label} 起跑前预检失败：stat ${file} 成功但 access(R_OK) 报 ${error?.code ?? '未知错误'}`
        + '（既不是「不存在」也不是「读不到」⇒ 不下结论）');
    }
    throw new Error(
      `${label} 起跑前预检失败：--env-file ${file} 存在但当前用户读不到（${error?.code ?? 'EACCES'}；`
      + `mode=${modeOf(stat)} owner=${ownerOf(stat)} 当前 uid/gid=${uid}/${gid}）。\n⇒ ${fix}`,
    );
  }
  return { file, bytes: stat.size };
}

/**
 * 沿路径链从根往下走，找出**第一个进不去的目录**或**第一个不存在的段**（issue #495 ② 的取证本体）。
 *
 * 为什么走链而不是只看叶子：`existsSync` / `readFileSync` 在「祖先目录没权限」与「文件没生成」两种
 * 情况下都只是返回 false / 抛 ENOENT，光看叶子分不开。走链才能给出**具体是哪一段**：
 *  · `blocker` —— 这一段存在但**够不到**：非叶子段缺的是**穿越**（`X_OK`）、叶子段缺的是**读**（`R_OK`），
 *    或它根本不是目录，或它的 `stat` 被权限挡了 ⇒ 再等也不会变，权限不是时间问题；
 *  · `missingPrefix` —— 前面的段都能进，但这一段自己还不存在 ⇒ 物化真的没发生（或还没轮到它）。
 *  · `unknown` —— 探测报了**既不是缺失也不是权限**的 errno（`EIO`/`ELOOP`/`ENAMETOOLONG`…）⇒ **不许二选一**，
 *    把 errno 原样交回已有的 `unknown` 出口（分流只过 `classifyProbeErrno` 那一张表，见它的注释）。
 *
 * ⚠ 可达性**掩码**口径（第三轮 BLOCKER，别再改回去）：走查里对**非叶子段**只要求 `X_OK`，**不要求** `R_OK`。
 *   理由：拿到**已知文件名**去读子文件，内核只要求祖先链上每段有 `x`（穿越）；`r` 只对「列目录」必要。
 *   一旦写成 `R_OK | X_OK`，`chmod 0o111` 的 bind 源（可穿越、不可枚举，真实摆法）就被判成「读不到」：
 *   真 `readFileSync` 读得到，观测却报 `unreadable`，等待器 12–53 ms 就假红判死（一个 100 ms 后才物化的
 *   正常场景直接被打死）——**假红比原缺陷贵**，所以这条是 BLOCKER。
 *
 * ⚠ 归因口径（第二轮 MED 修的正是这一条）：走查里的 `statSync` **失败**要按 **errno** 分流，**不能吞**——
 *  `ENOENT`/`ENOTDIR` ⇒ `missingPrefix`（真没物化）；`EACCES`/`EPERM` ⇒ `blocker{reason:'no-permission'}`
 *  且 `missingPrefix` 必为 `null`。典型形状 `link -> secret/inner` 且 `chmod 000 secret`：链上每一段
 *  字面上都进得去，但 `stat(link)` 要跟随链接 ⇒ 被 `secret` 挡住 ⇒ 这是「进不去」而不是「没物化」。
 *  状态面不变：仍是三态 + `unknown`，**没有第五态**（为什么不开第四态：见 `observeLastSegmentLink`）。
 *
 * @param {string} filePath 要观测的宿主路径（绝对或相对当前目录）
 * @param {{fsImpl?: typeof import('node:fs')}} [options]
 * @returns {{blocker: null | {path: string, reason: 'no-permission' | 'not-a-directory', mode: string | null, owner: string | null, missingAccess?: 'X_OK' | 'R_OK' | null}, missingPrefix: string | null, unknown: null | {path: string, probe: string, code: string | null, message: string, cause: object | null}, links: object[]}}
 *   `links` = 走查过的每一段的**链接事实**（`lstatSync`，不跟随）——只是多一条可诊断的账，
 *   不参与归属判断（为什么需要它：见 `observeSegmentLink`）。提前 return 时也把已走到的段带回去。
 *   `blocker.missingAccess` 说的是**这一次要而没拿到的那一位**（祖先 `X_OK` / 叶子 `R_OK`），文案据此出话。
 */
export function inspectHostPathChain(filePath, { fsImpl = fs } = {}) {
  const abs = path.resolve(filePath);
  const segments = abs.split(path.sep).filter(Boolean);
  const links = [];
  let current = path.parse(abs).root;
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]);
    const isLeaf = i === segments.length - 1;
    // 先记事实（`lstatSync`，**不跟随**），再做存在性/类型/可达性判断：顺序不能反过来——
    // `statSync` 对悬空链接报 ENOENT，先走它就永远看不到链接本体（那就是变异 M-A 的入口）。
    links.push(observeSegmentLink(current, { fsImpl, isLastSegment: isLeaf }));
    // ⚠ 不吞错误：errno 就是归因本身（吞掉 ⇒ EACCES 变 missing，第二轮 MED 的病灶）。
    // 分流只允许过 `classifyProbeErrno` 那一张表（第三轮 MED：别再在调用点写 if）。与下面两处同表：
    // 走查里的 `accessSync`、`observeHostPath` 的 `readFileSync`。
    const { stat, error: statError } = statResult(current, fsImpl);
    if (!stat) {
      const statClass = classifyProbeErrno(statError?.code);
      if (statClass === 'unreadable') {
        // stat 跟随了链接 / 要穿过目标目录 ⇒ 被权限挡住的是「这一段的可达性」，不是它存不存在。
        // mode/owner 从 lstat 取（stat 这次本来就失败了），取不到就是 null（文案会说「这次探不到」）。
        const facts = lstatFacts(current, fsImpl);
        return {
          // `factsFrom:'lstat'`：这组 mode/owner 说的是**这一段本体**（若它是链接，就是链接自己），
          // 不是它指向的那一侧——文案会把这层区别说出来，不让人拿 `0o777` 反推「怎么会读不到」。
          blocker: { path: current, reason: 'no-permission', mode: facts.mode, owner: facts.owner, factsFrom: 'lstat' },
          missingPrefix: null,
          unknown: null,
          links,
        };
      }
      if (statClass === 'missing') {
        // ENOENT / ENOTDIR ⇒ 仍按「没物化」报：第一轮那两格（悬空链接、链上第一段不存在）不许退回去。
        return { blocker: null, missingPrefix: current, unknown: null, links };
      }
      // 其它 errno（`EIO`/`ELOOP`/`ENAMETOOLONG`…）⇒ **既不许说「没物化」也不许说「没权限」**，
      // 把 errno 原样交回 `unknown` 出口（已有那一态，不是第五态）。
      return { blocker: null, missingPrefix: null, unknown: probeUnknown(current, 'statSync', statError), links };
    }
    if (!isLeaf && !stat.isDirectory()) {
      return {
        blocker: { path: current, reason: 'not-a-directory', mode: modeOf(stat), owner: ownerOf(stat) },
        missingPrefix: null,
        unknown: null,
        links,
      };
    }
    try {
      // ⚠ 掩码分两种（第三轮 BLOCKER）：祖先段只要**可穿越**（`X_OK`）就够得到已知文件名的子文件，
      // `R_OK` 只对「列目录」必要（要求它 ⇒ `0o111` 的 bind 源被误判「读不到」）；叶子段要的是**读**。
      fsImpl.accessSync(current, isLeaf ? R_OK : X_OK);
    } catch (error) {
      const accessClass = classifyProbeErrno(error?.code);
      if (accessClass === 'missing') return { blocker: null, missingPrefix: current, unknown: null, links };
      if (accessClass !== 'unreadable') {
        // 同一个道理：`accessSync` 报 `EIO` 不是权限问题，别拿「权限」当兼容默认值。
        return { blocker: null, missingPrefix: null, unknown: probeUnknown(current, 'accessSync', error), links };
      }
      return {
        blocker: {
          path: current, reason: 'no-permission', mode: modeOf(stat), owner: ownerOf(stat), factsFrom: 'stat',
          missingAccess: isLeaf ? 'R_OK' : 'X_OK',
        },
        missingPrefix: null,
        unknown: null,
        links,
      };
    }
  }
  return { blocker: null, missingPrefix: null, unknown: null, links };
}

/**
 * 链上**某一段**是不是符号链接、它指向哪（本体只说事实，不参与任何归属判断）。
 *
 * 为什么连**非末段**也要记（issue #495 本轮补的那一条）：真实部署里「bind 源本身是个链接」很常见
 * （`/srv/erix -> /data/erix`、home 整棵挂在另一块盘上）。这种形态下链上**每个段**用 `statSync` 看都是
 * 「正常的目录」，末段也不是链接 ⇒ 上一轮的末段事实完全看不见它，而容器里那一侧走的是链接目标，
 * 宿主侧改的可能是链接本体——两者不是同一个 inode，排查时会改错地方。
 *
 * ⚠ 必须 `lstatSync`（**不跟随**）+ `readlinkSync`：用 `statSync` 判链接永远判不出来（变异 M-A 的入口）。
 *
 * @param {string} segmentPath 绝对路径的某一段（累计到这一段的完整路径）
 * @param {{fsImpl?: typeof import('node:fs'), isLastSegment?: boolean}} [options]
 * @returns {{segment: string, path: string, isLastSegment: boolean, isSymlink: boolean | null, target: string | null, resolvedTarget: string | null, targetExists: boolean | null, detectable: boolean}}
 *   `path` 与 `segment` 同值（前者是已合并形状的兼容键）。`isSymlink: null` + `detectable: false`
 *   = 注入的 `fsImpl` 没有 `lstatSync`（或这一段的 `lstat` 自己就被权限挡了）⇒ **无从判定**，不假装「不是链接」。
 *   `targetExists` 是**三态**（第三轮 MED）：`true` 存在 / `false` **真** `ENOENT`、`ENOTDIR` / `null` **探不到**
 *   （被权限挡、或 `readlink` 根本没读出目标）——理由见 `probeTargetExists`；不是链接那一段固定 `false`（没目标这回事）。
 */
export function observeSegmentLink(segmentPath, { fsImpl = fs, isLastSegment = false } = {}) {
  const abs = path.resolve(segmentPath);
  const base = {
    segment: abs, path: abs, isLastSegment, isSymlink: false,
    target: null, resolvedTarget: null, targetExists: false, detectable: true,
  };
  if (typeof fsImpl.lstatSync !== 'function') return { ...base, isSymlink: null, detectable: false };
  let stat;
  try {
    // lstat：悬空链接也能看到本体（statSync 会当成 ENOENT ⇒ 链接事实就丢了）
    stat = fsImpl.lstatSync(abs);
  } catch (error) {
    // 同一张表：`lstat` 报「不存在」才等于「不是链接」（悬空链接的 `lstat` 是成功的）；
    // 其它 errno（权限、`EIO`…）都只能说「无从判定」，**不许**编成「不是链接」。
    if (classifyProbeErrno(error?.code) === 'missing') return base;
    return { ...base, isSymlink: null, detectable: false }; // 链上没权限/探不到 ⇒ 无从判定，不编结论
  }
  const isLink = typeof stat.isSymbolicLink === 'function'
    ? stat.isSymbolicLink()
    : (stat.mode & 0o170000) === 0o120000;
  if (!isLink) return base;
  let target = null;
  try {
    target = typeof fsImpl.readlinkSync === 'function' ? String(fsImpl.readlinkSync(abs)) : null;
  } catch {
    target = null;
  }
  const resolvedTarget = target === null ? null : path.resolve(path.dirname(abs), target);
  // `null` = 探不到（第三轮 MED）：`readlink` 没读出目标 ⇒ 「存不存在」无从判定，**不是**「不存在」。
  const targetExists = resolvedTarget === null ? null : probeTargetExists(resolvedTarget, fsImpl);
  return { ...base, isSymlink: true, target, resolvedTarget, targetExists, detectable: true };
}

/**
 * 末段是不是符号链接、它指向哪（issue #495 判据差项 ① 的返修；主 agent 拍板：**只诊断，不改策略**）。
 *
 * 为什么要单独报一条事实：`statSync` / `readFileSync` 都**跟随**链接，于是「末段是指向可读文件的链接」与
 * 「末段是真文件」在状态上**完全同形**（都是 `present` + `blocker: null`）。排查宿主 bind 源时这恰恰是
 * 决定性的区别：bind 源做成符号链接时，portal 容器里看到的是**链接目标那一侧**——宿主上 `ls` 到的与
 * 容器里读到的不是同一个 inode。
 *
 * 为什么**不**新增第四态（也不把 present 改成失败）：bind 源是链接是**合法配置**（别的操作机的机器就这么摆），
 * 预检/等待是**诊断面**不是策略闸门；而且 `waitForHostFile` 的「提前放弃 / 等满超时」两种形状已被判据钉住，
 * 加第四态会把那条时间判据搞崩。悬空链接也**保持**归 `missing`（`statSync` 对悬空链接抛 ENOENT，本来就
 * 读不出内容），只是文案要顺带说清「它是个链接，缺的是目标」。
 *
 * @param {string} filePath 宿主路径
 * @param {{fsImpl?: typeof import('node:fs')}} [options]
 * @returns {{segment: string, path: string, isLastSegment: boolean, isSymlink: boolean | null, target: string | null, resolvedTarget: string | null, targetExists: boolean | null, detectable: boolean}}
 */
export function observeLastSegmentLink(filePath, { fsImpl = fs } = {}) {
  return observeSegmentLink(filePath, { fsImpl, isLastSegment: true });
}

/**
 * 链接目标的出话那一句（末段与链上段共用，**一处定义**）。
 *
 * ⚠ 第三轮 MED 的那一刀：「缺的是**链接目标**」这句话**只许在真 `ENOENT`/`ENOTDIR`（`targetExists === false`）时
 * 出现。`targetExists === null` 是「这次探不到」（目标目录没 `x`、`readlink` 读不出…），把探不到写成「缺目标」
 * 会让人去找一个根本没丢的文件；而这句话自己不许沾「读不到」/「没物化」（那两句归另外两个文案，并且有判据钉着）。
 */
function targetExistenceLine(link) {
  if (!link || link.isSymlink !== true) return '';
  const shown = link.resolvedTarget ?? link.target ?? '?';
  if (link.targetExists === false) return `    缺的是**链接目标**（${shown}），不是链接本身。`;
  if (link.targetExists === null) {
    return `    链接目标（${shown}）**这次探不到**（探一次就报错 ⇒ 无从判定它在不在）——**不许**据此说它缺失。`;
  }
  return '';
}

/**
 * 把「末段是链接」这条事实渲染成诊断行（**不是链接 ⇒ 空串**，而不是来一句「不是链接」：
 * 反向自证要求真文件那条路径的文案里根本不出现 `符号链接` 这个词）。给失败文案与日志共用。
 *
 * @param {{isSymlink?: boolean | null, path?: string, target?: string | null, resolvedTarget?: string | null, targetExists?: boolean} | null} link
 * @returns {string}
 */
export function formatLastSegmentLinkLine(link) {
  if (!link || link.isSymlink !== true) return '';
  const target = link.target === null
    ? '目标读不出（readlink 失败？）'
    : (link.resolvedTarget && link.resolvedTarget !== link.target ? `${link.target}（解析后 ${link.resolvedTarget}）` : link.target);
  const lines = [
    `  末段是符号链接：${link.path ?? '?'} → ${target}`,
    '    若这是宿主 bind 源：portal 容器里看到的是**链接目标那一侧**，宿主 `ls` 到的与容器里读到的不是同一个 inode——'
    + '排查挂载先确认这一条。',
  ];
  const existence = targetExistenceLine(link);
  if (existence) lines.push(existence);
  return lines.join('\n');
}

/**
 * 链上**非末段**有符号链接时的诊断行；全链都是真目录 ⇒ **空串**（反向自证就靠这条：把这行改成恒输出，
 * 「全真目录」那格必须红）。只点名**第一个**这样的段——人真正要看的是「从哪一段开始两侧不再是同一个 inode」。
 *
 * @param {object[] | null | undefined} links `observeHostPath(...).links`（或 `inspectHostPathChain(...).links`）
 * @returns {string}
 */
export function formatAncestorLinkLines(links) {
  const ancestors = (Array.isArray(links) ? links : [])
    .filter((entry) => entry && entry.isSymlink === true && entry.isLastSegment === false);
  if (ancestors.length === 0) return '';
  const first = ancestors[0];
  const target = first.target === null
    ? '目标读不出（readlink 失败？）'
    : (first.resolvedTarget && first.resolvedTarget !== first.target ? `${first.target}（解析后 ${first.resolvedTarget}）` : first.target);
  const lines = [
    `  链上第一段符号链接（不是末段）：${first.segment ?? first.path ?? '?'} → ${target}`,
    '    portal 容器里看到的**容器内路径与宿主路径不是同一个 inode**：容器那一侧走的是链接目标，而宿主侧',
    '    `ls`/`stat` 看到的可能是链接本体。若这就是 bind 源：**要改的是宿主侧这条链接指向**（或整条 bind 源路径），',
    '    去改容器里看到的那一侧不会生效。',
  ];
  const existence = targetExistenceLine(first);
  if (existence) lines.push(existence);
  if (ancestors.length > 1) {
    lines.push(`    （链上还有 ${ancestors.length - 1} 段也是链接，全量在 links 数组里）`);
  }
  return lines.join('\n');
}

/**
 * 观测一个宿主路径的**真实**状态：`present` / `missing` / `unreadable`（+ 罕见的 `unknown`）。
 *
 * ⚠ 红线（issue #495 的验收判据）：不许把「读不到」与「不存在」压成同一个布尔（#412 那条
 * 「最费时间」的根因）；也不许「忽略读错误继续等」（真的没物化会被拖成一句无信息超时）。
 *
 * @param {string} filePath 宿主路径
 * @param {{fsImpl?: typeof import('node:fs')}} [options]
 * @returns {{state: 'present' | 'missing' | 'unreadable' | 'unknown', content?: string, blocker?: object | null, missingPrefix?: string | null, link: object, links: object[], error?: object}}
 *   `link` = 末段那条事实（已合并的形状，保留）；`links` = 链上走查过的**每一段**的事实（含末段）。
 */
export function observeHostPath(filePath, { fsImpl = fs } = {}) {
  const chain = inspectHostPathChain(filePath, { fsImpl });
  // 独立事实：不改变三态归属，只是多一条可诊断的账（为什么必须逐段说：见 observeSegmentLink 注释）
  const links = Array.isArray(chain.links) ? chain.links : [];
  // 链走到末段时直接复用走查里那条（同一次 lstat，不重复发 syscall）；提前 return（段不存在/进不去）时
  // 末段根本没走查过 ⇒ 补一次，保证 `link` 永远在（已合并的 L1/L2/L3 三格形状不能碎）。
  const link = links.find((entry) => entry && entry.isLastSegment) ?? observeLastSegmentLink(filePath, { fsImpl });
  if (chain.blocker) return { state: 'unreadable', blocker: chain.blocker, missingPrefix: null, link, links };
  if (chain.missingPrefix) return { state: 'missing', blocker: null, missingPrefix: chain.missingPrefix, link, links };
  // 走查里报了「既不是缺失也不是权限」的 errno ⇒ 走**已有的** `unknown` 出口（不是第五态）。
  // 顺序不能换：`blocker`/`missingPrefix` 与 `unknown` 理论上互斥，但就算注入端端出多个，也不能让
  // 「探不到」把前两者遮成「present」。`links` 逐段事实继续带上。
  if (chain.unknown) {
    return { state: 'unknown', error: chain.unknown, blocker: null, missingPrefix: null, link, links };
  }
  try {
    const content = fsImpl.readFileSync(filePath, 'utf8');
    return { state: 'present', content, blocker: null, missingPrefix: null, link, links };
  } catch (error) {
    // 同一张表（第三轮 MED：三个探测点共用，别再在调用点写 if）。
    const readClass = classifyProbeErrno(error?.code);
    if (readClass === 'missing') return { state: 'missing', blocker: null, missingPrefix: path.resolve(filePath), link, links };
    if (readClass === 'unreadable') {
      return {
        state: 'unreadable',
        missingPrefix: null,
        link,
        links,
        blocker: {
          path: path.resolve(filePath), reason: 'no-permission',
          mode: modeOf(statOrNull(filePath, fsImpl)), owner: ownerOf(statOrNull(filePath, fsImpl)),
          // 叶子级 EACCES：缺的就是**读**这一位（文案不许退成「缺 R_OK|X_OK」那种笼统口径）
          missingAccess: 'R_OK',
        },
      };
    }
    return { state: 'unknown', error, blocker: null, missingPrefix: null, link, links };
  }
}

/** 失败文案的尾部：调用方给的现场快照（例如 `docker exec <portal> ls -l <容器内路径>`）。 */
function diagnosticsTail(describe) {
  if (typeof describe !== 'function') return '';
  let out;
  try {
    out = String(describe() ?? '');
  } catch (error) {
    out = `（现场快照取不到：${error?.code ?? ''} ${error?.message ?? error}）`;
  }
  const trimmed = out.trim();
  return trimmed ? `\n—— 容器侧现场快照 ——\n${trimmed}` : '';
}

/**
 * `blocker` 的**人话归因**：要说清「缺的是哪一位」，不能一律写成「读不到」。
 *
 * 为什么不能笼统（第三轮 BLOCKER 的文案那一半）：祖先目录缺的是**穿越**（`X_OK`），叶子缺的是**读**（`R_OK`）。
 * 对祖先高喊「读不到」会把人推向查 uid/组（而真正要看的其实是挂载源的 mode 里那一格 `x`）；
 * 说清缺哪一位，才能一句定案该 `chmod +x` 还是该 `chown`。
 */
function blockerWhy(blocker) {
  if (blocker.reason === 'not-a-directory') return '链上这一段不是目录';
  if (blocker.missingAccess === 'X_OK') {
    return '这一段**不可穿越**（缺 `X_OK`）——它是祖先目录：不可穿越就根本够不到下面的文件'
      + '（列目录的 `R_OK` 不是必需的，不需要能 `ls` 它）';
  }
  if (blocker.missingAccess === 'R_OK') {
    return '这一段**不可读**（缺 `R_OK`）——路径本身能定位到，是**内容**读不出来';
  }
  // stat 自己就被挡（典型：要跟随链接穿过一个没 `x` 的目录）⇒ 缺的到底是哪一位探不出来，只说被挡这件事。
  return '缺可达性（`R_OK`/`X_OK` 这一类，但 `stat` 自己就被挡住 ⇒ 探不出具体是哪一位）';
}

/** 按「缺的是哪一位」给一句**可执行**的修法（笼统一句「查 uid/组」会把人带去改错东西）。 */
function blockerFixHint(blocker) {
  if (blocker.reason === 'not-a-directory') return '（链上这一段根本不是目录 ⇒ 把它换成目录，或把 bind 源指对）';
  if (blocker.missingAccess === 'X_OK') {
    return '    ⇒ 要修的是**穿越**：给这一段加 `x`（`chmod +x`）或把自己放进它的组；不需要能 `ls` 它'
      + '（`0o111` 这类的 bind 源是合法摆法，`R_OK` 与此无关）。';
  }
  if (blocker.missingAccess === 'R_OK') {
    return '    ⇒ 要修的是**读**：这一段自己的 mode/属主（上游目录的 `x` 已经过了，不必去改它）。';
  }
  return '    ⇒ `stat` 自己就被挡住 ⇒ 挡人的多半在**链接目标那一侧**的目录（先按下面那条 `resolvedTarget` 查）。';
}

/** 「存在但读不到」的文案：点名被挡的段 + 权限/属主 + 最可能的原因（FDE_USER_UID/GID）。 */
function unreadableMessage(name, observed, extra) {
  const { uid, gid } = selfIds();
  const blocker = observed.blocker ?? {};
  const why = blockerWhy(blocker);
  // 走查里的 stat 被权限挡住时，mode/owner 是退到 lstat 取的——说的是这一段本体，必须说出来。
  const factsFrom = blocker.factsFrom === 'lstat'
    ? '，取自 **lstat**（`stat` 这次被挡住了 ⇒ 这组数字是这一段本体；若它是链接，说的是链接自己而不是目标那一侧）'
    : '';
  return [
    `${name}：已经存在，但当前用户**够不到**它（不是「没物化」——文件很可能早就写出来了）。`,
    `  被挡住的一段：${blocker.path ?? '?'}`,
    `    缺的是哪一位：${why}`,
    `    mode=${blocker.mode ?? '这次探不到（lstat 也被挡）'} owner=${blocker.owner ?? '这次探不到（lstat 也被挡）'}${factsFrom} 当前 uid/gid=${uid}/${gid}`,
    '  ⇒ 多半是 FDE_USER_UID / FDE_USER_GID（deploy/.env，portal/src/config.js 缺省 1000/1000）与你自己的 uid/gid',
    '    不一致：portal 以 root 把 FDE 目录建成 0770 node:node，组外用户根本进不去（issue #495 ②）。',
    blockerFixHint(blocker),
    '  ⚠ 旧写法 fs.existsSync 在这种路径上返回 false ⇒「读不到」与「真的没物化」症状逐字相同，这条文案就是把两者分开。',
    formatAncestorLinkLines(observed.links),
    formatLastSegmentLinkLine(observed.link),
    extra ?? '',
  ].filter((line) => line !== '').join('\n');
}

/** 「真的没物化」的文案：点名链上第一段就不存在的那个路径（不是权限问题）。 */
function missingMessage(name, observed, extra) {
  return [
    `timeout waiting for ${name}：等到超时，且**路径上第一段就不存在**（缺：${observed.missingPrefix ?? '?'}）`,
    '  ⇒ 物化确实没发生（不是权限问题：链上能进去的段全都进得去，缺的是目录/文件本身）。',
    '  对照：config.json 由 portal 的 materializer 在启动全量重建时写出（user-space §8.1，本仓 restartPortal 就是触发它）。',
    formatAncestorLinkLines(observed.links),
    formatLastSegmentLinkLine(observed.link),
    extra ?? '',
  ].filter((line) => line !== '').join('\n');
}

/**
 * 等一个**由容器写进宿主 bind mount** 的文件出现，并返回它的正文（issue #495 ② 的接线口）。
 *
 * 与旧写法 `waitFor(() => fs.existsSync(p) ? readFileSync(p) : null)` 的唯一区别就是失败分类：
 *  · present ⇒ 返回正文；
 *  · unreadable ⇒ **连续两次**观测到就立刻抛（等下去没有意义：权限不是时间问题；要两次是为了不在
 *    portal 建目录 / chown 的瞬间窗口里误报）；
 *  · missing ⇒ 等满超时，文案点名「链上第一段不存在」= 真没物化。
 *
 * @param {string} filePath 宿主路径
 * @param {object} [options]
 * @param {number} [options.timeoutMs=120000] 等待上限（只对 missing 分支有意义）
 * @param {number} [options.intervalMs=500] 轮询间隔
 * @param {string} [options.label] 文案里的事物名（缺省用路径）
 * @param {typeof import('node:fs')} [options.fsImpl] 注入用
 * @param {(() => string) | null} [options.describe] 失败时的现场快照（只在失败路径调用，异常吞进文案）
 * @param {number} [options.unreadableConfirmations=2] 连续几次 unreadable 就提前放弃等待
 * @param {(ms: number) => Promise<void>} [options.sleepImpl] 注入用（夹具里省时间）
 * @returns {Promise<string>} 文件正文
 */
export async function waitForHostFile(filePath, {
  timeoutMs = 120000,
  intervalMs = 500,
  label,
  fsImpl = fs,
  describe = null,
  unreadableConfirmations = 2,
  sleepImpl = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
} = {}) {
  const name = label ?? `宿主文件 ${filePath}`;
  let unreadableStreak = 0;
  let last = null;
  const startedAt = Date.now();
  for (;;) {
    last = observeHostPath(filePath, { fsImpl });
    if (last.state === 'present') return last.content;
    if (last.state === 'unreadable') {
      unreadableStreak += 1;
      // 权限问题等不来结果：文件多半已经写出，只是测试看不见（#495 ② 的原症状就是等到超时）。
      if (unreadableStreak >= unreadableConfirmations) throw new Error(unreadableMessage(name, last, diagnosticsTail(describe)));
    } else {
      unreadableStreak = 0;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      if (last.state === 'unreadable') throw new Error(unreadableMessage(name, last, diagnosticsTail(describe)));
      if (last.state === 'unknown') {
        // 第三轮 MED：这一支现在是**真能走到**的（走查里的 `statSync`/`accessSync` 报 `EIO` 一类也到这里）。
        // 只说「无法归类 + errno + 哪一次探测」，不许把它推成「没物化」或「没权限」。
        const detail = [last.error?.code, last.error?.message].filter((s) => s).join(' ');
        throw new Error(`timeout waiting for ${name}：观测到无法归类的错误 `
          + `${detail || '未知'}${diagnosticsTail(describe)}`);
      }
      throw new Error(missingMessage(name, last, diagnosticsTail(describe)));
    }
    // eslint-disable-next-line no-await-in-loop -- 轮询必须串行：并发观测会把「哪一次看到了」说不清
    await sleepImpl(intervalMs);
  }
}

/**
 * 宿主路径 → portal 容器内路径（userspace 是**同路径** bind mount，见
 * {@link PORTAL_USERSPACE_CONTAINER_ROOT}）。换算不出来就抛——别静默拼一个不存在的路径去 `ls`。
 *
 * @param {string} hostPath 宿主绝对路径
 * @param {{hostRoot: string, containerRoot?: string}} opts hostRoot = 该栈的宿主 userspace 根
 * @returns {string} 容器内路径（posix 形态）
 */
export function toContainerPath(hostPath, { hostRoot, containerRoot = PORTAL_USERSPACE_CONTAINER_ROOT } = {}) {
  assert.ok(hostRoot, 'toContainerPath: hostRoot is required');
  const abs = path.resolve(hostPath);
  const root = path.resolve(hostRoot);
  const rel = path.relative(root, abs);
  if (rel === '') return containerRoot;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`toContainerPath: ${abs} 不在宿主挂载根 ${root} 下面，换算不出容器内路径（拼错根目录 = 快照指错地方）`);
  }
  return path.posix.join(containerRoot, rel.split(path.sep).join('/'));
}

/**
 * 容器侧现场快照（issue #495 ② 验收判据里的第 2 条形态：「一条命令的成本，直接排除两种可能的一种」）。
 * 把「父目录 + 目标」的 `ls -ld` 原文塞进失败文案——同一份文件在容器里看得见、在宿主读不到，
 * 一眼就能定案是权限还是没物化，不必再手工 `docker exec` 一次。
 *
 * 永远不抛：它是失败文案的**附件**，不该把失败换一种更难读的形状。
 *
 * @param {{docker: (args: string) => string, container: string, containerPath: string}} opts
 * @returns {string} 快照正文（取不到时是「取不到的原因」）
 */
export function materializeSnapshot({ docker, container, containerPath }) {
  assert.ok(typeof docker === 'function', 'materializeSnapshot: docker executor is required');
  assert.ok(container, 'materializeSnapshot: container is required');
  assert.ok(containerPath, 'materializeSnapshot: containerPath is required');
  const parent = containerPath.replace(/\/[^/]*$/, '') || '/';
  try {
    // `2>&1 || true` 在容器内的 sh 里就吃掉：ls 对不存在的段返回 2，而我们要的正是它那句话。
    return String(docker(`exec ${container} sh -c "ls -ld ${parent} ${containerPath} 2>&1 || true"`) ?? '').trim();
  } catch (error) {
    return `（容器侧现场快照取不到：${error?.code ?? ''} ${error?.message ?? error}）`;
  }
}
