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

/** 确保目录存在（不 follow symlink），并尝试 chmod/chown（非 root 时 chown best-effort）。 */
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
  } catch {
    // 某些平台/目录 fsync 不可用：忽略（rename 本身已原子）。
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * 单文件原子写（user-space §5.1）：同目录 temp（O_EXCL + O_NOFOLLOW，0600）→ 写 → fsync → chmod 最终模式 → rename → fsync 目录。
 * 失败清理 temp 并抛错，保留旧文件（绝不写半截）。
 */
export function atomicWriteFile(target, content, { mode = 0o644, root = null } = {}) {
  if (root) assertSafePath(root, target);
  const dir = path.dirname(target);
  const tmp = path.join(dir, `${path.basename(target)}.${randomHex(4)}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
    fsyncDir(dir);
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

/** 读文件内容（不存在返回 null）。 */
export function readFileIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
