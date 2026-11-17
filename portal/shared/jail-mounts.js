/**
 * issue #676：FDE jail 挂载点的**单一真值表**。
 *
 * 真值来源 = provisioner 给容器下的 bind mount（`docker inspect fde-<user>` 实测）：
 *   <userSpaceRoot>/<fde>/home          -> /home/<homeUser>
 *   <userSpaceRoot>/<fde>/projects      -> /home/<homeUser>/projects
 *   <userSpaceRoot>/<fde>/cache         -> /home/<homeUser>/cache
 *   <userSpaceRoot>/<fde>/platform/git  -> /run/erix/git（平台托管凭据，ro）
 *
 * ⚠ 这张表原先**散在两处**（`provisioner.js` 的 binds 字符串、`macro-dispatcher.js`
 * 的 `resolveOriginalRepoDir`），#676 的越界 cwd 校验是**第三个消费者**——收成一处，
 * 三处都从这里取，避免「第四处再抄一遍」的三本账。
 *
 * `runCwdAllowed`：只有 `home` / `projects` / `cache` 能当 run 的 cwd；
 * `platform/git` 是平台自己的挂载点，**不许**当 run 的 cwd（#676 ①）。
 */
import path from 'node:path';

/** 缺省家目录用户名（provisioner `homeUser` 的默认值，同一口径）。 */
export const DEFAULT_HOME_USER = 'erix';

/**
 * 挂载点清单。
 * - `hostSuffix`：相对 `<userSpaceRoot>/<fde>/` 的宿主子目录（jail 校验用它判「在不在 jail 内」）。
 * - `containerFromHome`：相对容器内家目录 `/home/<homeUser>` 的目标路径（`''` = 家目录本身）；
 *   `home` / `projects` / `cache` 三类从这里拼容器目标。
 * - `containerFixed`：与 homeUser 无关的固定容器目标（`platform/git` = `/run/erix/git`）。
 * - `runCwdAllowed`：能否作为 run 的 cwd。
 * - `readOnly`：bind 是否 `:ro`。
 */
export const JAIL_MOUNTS = Object.freeze([
  { key: 'home', hostSuffix: 'home', containerFromHome: '', runCwdAllowed: true, readOnly: false },
  { key: 'projects', hostSuffix: 'projects', containerFromHome: 'projects', runCwdAllowed: true, readOnly: false },
  { key: 'cache', hostSuffix: 'cache', containerFromHome: 'cache', runCwdAllowed: true, readOnly: false },
  { key: 'git', hostSuffix: 'platform/git', containerFixed: '/run/erix/git', runCwdAllowed: false, readOnly: true },
]);

/** 允许当 run cwd 的 jail 子目录名（`home` / `projects` / `cache`）。 */
export const JAIL_RUN_CWD_HOST_SUFFIXES = Object.freeze(
  JAIL_MOUNTS.filter((m) => m.runCwdAllowed).map((m) => m.hostSuffix),
);

/** 按 key 取一条挂载描述。 */
export function jailMountByKey(key) {
  return JAIL_MOUNTS.find((m) => m.key === key) ?? null;
}

/**
 * 拼某个 jail 挂载点的**宿主绝对路径**（已 `path.resolve` 规范化）。
 * @param {string} userSpaceRoot
 * @param {string} fdeName
 * @param {string} key 见 `JAIL_MOUNTS[].key`
 * @returns {string|null} 未知 key ⇒ null
 */
export function jailHostDir(userSpaceRoot, fdeName, key) {
  const mount = jailMountByKey(key);
  if (!mount) return null;
  return path.resolve(userSpaceRoot ?? '', String(fdeName ?? ''), mount.hostSuffix);
}

/** 容器内目标路径（相对家目录的三类现拼；固定目标原样返回）。 */
function containerTarget(mount, home) {
  if (mount.containerFixed != null) return mount.containerFixed;
  return mount.containerFromHome ? `${home}/${mount.containerFromHome}` : home;
}

/**
 * 生成 provisioner 用的 `Binds` 字符串数组（单一真值：改这里 = 改挂载）。
 * @param {{ hostRoot: string, homeUser?: string }} opts hostRoot = `path.resolve(userSpaceRoot)/<fde>`
 * @returns {string[]} 形如 `<host>/home:/home/erix`
 */
export function buildJailBinds({ hostRoot, homeUser = DEFAULT_HOME_USER } = {}) {
  const home = `/home/${homeUser}`;
  return JAIL_MOUNTS.map((m) => {
    const ro = m.readOnly ? ':ro' : '';
    return `${hostRoot}/${m.hostSuffix}:${containerTarget(m, home)}${ro}`;
  });
}
