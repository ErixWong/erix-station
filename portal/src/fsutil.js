// 文件原子写 + 目录安全（同目录 tmp + fsync 文件与目录 + rename）。
// 依据：docs/design/user-space.md §5.1/§6.3、docs/design/topology.md §8（route 原子替换）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function randomHex(bytes = 4) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** 校验 target 位于 root 内，且路径中每个已存在段都不是符号链接（user-space §6.3）。 */
export function assertSafePath(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '') return;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error(`path escapes root: ${target}`);
    err.code = 'materialize_path_tampered';
    throw err;
  }
  // 逐段 lstat：任何一段为 symlink → 拒写。
  let cur = path.resolve(root);
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      break; // 尚不存在，后续 mkdir 创建
    }
    if (st.isSymbolicLink()) {
      const err = new Error(`symlink in path: ${cur}`);
      err.code = 'materialize_path_tampered';
      throw err;
    }
  }
}

/** 确保目录存在（不 follow symlink），并尝试 chmod/chown（非 root 时 chown best-effort）。
 *
 * ⚠ mode 的 setgid 位（0o2770 里的 2000）是**历史遗留，不会落盘**——口径已定 **0770**（issue #273）：
 *   · mkdir(2) 传 0o2770 本身从不交出 setgid（umask 022 → 0750、0002 → 0770）；
 *   · 真正能落下 setgid 的只有 chmod，且仅在「目录属组 == 本进程 egid」时；portal 是 uid0/gid0 且
 *     cap_drop ALL + cap_add 无 CAP_FSETID（容器内 CapEff=0xcb），chown(1000,1000) 之后的下一轮 chmod
 *     会被内核**静默清掉 setgid**（770 原样保留、不抛错）⇒ reconcile 从第 2 轮起稳定 0770。
 *   · 这**不是缺陷**：GID 继承由写入进程主组（1000）达成，组写位由 umask 与属组 1000 达成，setgid 不承载任何行为。
 * ⚠ 上面那句有一个**前提**：调用方必须**同时传 uid 与 gid**（=1000）。本函数 `gid` 缺省是 `null`，而下面
 *   `chownSync(dir, uid ?? -1, gid ?? -1)` 把 `null` 当「不改组」——**只传 uid** 的调用点会留下 `gid=0`（root 组）
 *   的对象，那时 setgid 就**真的开始承重**，“别补 CAP_FSETID”的结论随之失效。现有调用点已全部同传 uid+gid
 *   （2026-10-24 逐个核：materializer/provisioner/sessions/git-credential/git-cli-config），新增调用点请跟着做。
 * 别为了「把 mode 兑现成 2770」去补 CAP_FSETID（只改一个看不见的数字，不改任何访问语义，违背最小权限）。
 * 别把字面量改成 0o0770（行为等价，但会让 docs/user-space §6.2 与 wp2a §④ 断言面重新变得可疑）。
 * 将来真要「组协作」要动的是 umask / 组成员关系，不是 setgid。详见 docs/design/user-space.md §6.2 / issue #273。
 */
export function ensureDirSafe(root, dir, { mode = 0o750, uid = null, gid = null, log = console } = {}) {
  assertSafePath(root, dir);
  fs.mkdirSync(dir, { recursive: true, mode });
  try {
    fs.chmodSync(dir, mode);
  } catch (e) {
    log.warn?.(`[fsutil] chmod ${dir} failed: ${e.message}`);
  }
  if (uid !== null || gid !== null) {
    try {
      fs.chownSync(dir, uid ?? -1, gid ?? -1);
    } catch (e) {
      // 非 root 单测/开发环境无 chown 权限：仅告警，不阻断（生产 root 必成功）。
      log.warn?.(`[fsutil] chown ${dir} failed: ${e.message}`);
    }
  }
}

function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
    return true;
  } catch (e) {
    // F12：至少 console.error。不向上抛——rename 已提交，抛错会把「已提交」误报为失败、
    // 破坏调用方（materialize/route）重试语义；以 false 返回失败语义，调用方可选告警。
    console.error(`[fsutil] fsyncDir ${dir} failed: ${e.message}`);
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * 写同目录 temp（O_EXCL + O_NOFOLLOW，0600）→ 写内容 → 设置属主/模式 → fsync。
 * 只落 temp、不 rename；返回 temp 路径，供两阶段提交（user-space §5.3 提交点 / F5）。
 * 失败清理 temp 并抛错。
 */
export function writeTempFile(target, content, { mode = 0o644, uid = null, gid = null, root = null } = {}) {
  if (root) assertSafePath(root, target);
  const dir = path.dirname(target);
  const tmp = path.join(dir, `${path.basename(target)}.${randomHex(4)}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, content);
    if (uid !== null || gid !== null) fs.fchownSync(fd, uid ?? -1, gid ?? -1);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    return tmp;
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

/**
 * 提交 temp → target（rename 原子替换 + fsync 目录）。调用方负责失败时清理 temp。
 * 返回 boolean：rename 成功但目录 fsync 失败时返回 false（已提交但持久性未确认）；
 * 不抛错（rename 已提交，抛错会把「已提交」误报为失败，破坏调用方重试语义）。
 */
export function commitTempFile(tmp, target, { root = null } = {}) {
  if (root) assertSafePath(root, target);
  fs.renameSync(tmp, target);
  return fsyncDir(path.dirname(target));
}

/**
 * 单文件原子写（user-space §5.1）：writeTempFile + commitTempFile 一步完成。
 * 失败清理 temp 并抛错，保留旧文件（绝不写半截）。
 * rename 已提交但目录 fsync 失败时抛 `materialize_fsync_failed`（持久性未确认，调用方须走失败语义）。
 */
export function atomicWriteFile(target, content, { mode = 0o644, uid = null, gid = null, root = null } = {}) {
  const tmp = writeTempFile(target, content, { mode, uid, gid, root });
  try {
    const ok = commitTempFile(tmp, target, { root });
    if (!ok) {
      const err = new Error(`fsync directory failed after rename: ${target}`);
      err.code = 'materialize_fsync_failed';
      throw err;
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

/** 读文件内容（不存在返回 null）。 */
export function readFileIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
