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
 * 流式写同目录 temp（issue #472 片 B）：与 `writeTempFile` **同一套 temp 纪律**
 * （同目录命名 + `O_EXCL|O_NOFOLLOW` 独占创建 + `fchown` + `fchmod` + `fsync` + 失败清 temp），
 * 唯一区别是内容来自**流**而不是 Buffer。
 *
 * ⚠ 为什么不把 body 读进内存（评审 blocker 5）：上限默认 32MiB，而 portal 与全站所有服务
 * **共用同一个 Node 进程**（Traefik 单入口后面只有它）。并发十个上传各 buffer 一份就是 320MB 堆，
 * portal OOM ⇒ 登录/预览/LLM 网关/事件流一起挂（全平台故障，不是「上传功能不可用」）。
 * 逐 chunk `writeSync` 到 fd：内存占用只有一个 chunk，磁盘写不进得比网络快，天然背压。
 *
 * 失败路径一律「关 fd + unlink temp + 抛错」，**不留残骸**（评审 major 12：断流/超限必须可复用）。
 * 超限（累计字节 > maxBytes）⇒ 抛 `code='upload_too_large'`（带 `bytes`/`maxBytes`）；
 * 流的 `aborted` / `error` / 未 `end` 就 `close` ⇒ 抛 `code='upload_interrupted'`（带 `bytes`）。
 * ⚠ 超限时**不 `stream.destroy()`**：只摘掉自己的监听器 ⇒ 请求流停止被消费，Node 在响应发完后
 * 自己排空剩余 body。destroy 会 RST 掉连接，客户端可能连 413 响应都读不到。
 *
 * @returns {Promise<{tmp: string, bytes: number}>} 只落 temp，不提交（提交见 commitTempFile/NoClobber）
 */
export async function writeTempFileFromStream(target, stream, { maxBytes = null, mode = 0o660, uid = null, gid = null, root = null } = {}) {
  if (root) assertSafePath(root, target);
  const dir = path.dirname(target);
  // temp 名与 target 名**无关**（与 writeTempFile 的 `<name>.<hex>.tmp` 刻意不同）：目标名可以合法地长到
  // 255 字节（NAME_MAX，B-6 的边界用例），往后缀会变成 255+14 字节 ⇒ `ENAMETOOLONG`，一个合法文件反而传不上去。
  // `.upload-<hex>.tmp` 定长 20 字节，同时让「残留清扫」能用一个 glob 说清（判据里就按这个形状断）。
  const tmp = path.join(dir, `.upload-${randomHex(6)}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }

  let bytes = 0;
  try {
    await new Promise((resolve, reject) => {
      let ended = false;
      let settled = false;
      const onData = (chunk) => {
        bytes += chunk.length;
        if (maxBytes !== null && bytes > maxBytes) {
          // 先摘监听器（不再消费），再报错：不 destroy 的理由见函数头注释。
          cleanup();
          const err = new Error(`upload exceeds max bytes (${bytes} > ${maxBytes})`);
          err.code = 'upload_too_large';
          err.bytes = bytes;
          err.maxBytes = maxBytes;
          settled = true;
          reject(err);
          return;
        }
        try {
          fs.writeSync(fd, chunk);
        } catch (writeErr) {
          cleanup();
          settled = true;
          reject(writeErr);
        }
      };
      const onInterrupted = () => {
        if (ended || settled) return;
        cleanup();
        const err = new Error('upload stream interrupted before completion');
        err.code = 'upload_interrupted';
        err.bytes = bytes;
        settled = true;
        reject(err);
      };
      const onEnd = () => {
        ended = true;
        cleanup();
        settled = true;
        resolve();
      };
      function cleanup() {
        stream.off('data', onData);
        stream.off('end', onEnd);
        stream.off('aborted', onInterrupted);
        stream.off('error', onInterrupted);
        stream.off('close', onInterrupted);
      }
      stream.on('data', onData);
      stream.once('end', onEnd);
      // `aborted`：Node http 请求在客户端提前断开时发（deprecation 但仍是 http 的事实形状）；
      // `error`：socket 复位（ECONNRESET）；`close`：流被关闭 —— 未 `end` 的 close 就是断流（onEnd 之后到來的 close 被 ended 拦住）。
      stream.on('aborted', onInterrupted);
      stream.on('error', onInterrupted);
      stream.on('close', onInterrupted);
    });

    if (uid !== null || gid !== null) fs.fchownSync(fd, uid ?? -1, gid ?? -1);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    return { tmp, bytes };
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
 * 提交 temp → target，**仅当 target 不存在**（issue #472 片 B 的唯一 no-clobber 保证）。
 *
 * ⚠ 为什么是 `linkSync` 而不是 `renameSync`（评审 blocker 4）：POSIX `rename(2)` **必然替换**已存在
 * 目标，所以「先 lstat 再 rename」在两步之间被别的进程（FDE agent 就在同一个挂载目录里干活）创建出
 * 目标时会被静默覆盖。`link(2)` 在目标已存在时返回 `EEXIST` ⇒ 同目录内原子的「仅当不存在才创建」，
 * 零依赖零新 API。lstat 先查只是**快速路径**（省一次 temp 写入），不是安全依据。
 *
 * 返回 `false` 表示「目标已存在，没有提交」（**不抛错**，调用方转 409）；`true` 表示已提交。
 * 两条路径都不留 temp：成功 ⇒ unlink temp；EEXIST ⇒ 也 unlink（否则每次 409 都留一份残骸）。
 * ⚠ `true` 不复用 `fsyncDir` 的返回值：`fsyncDir` 的 `false` 意思是「已提交但目录持久性未确认」，
 * 与「未提交」是两件事，混用会让调用方把已写好的文件报成 409。
 */
export function commitTempFileNoClobber(tmp, target, { root = null } = {}) {
  if (root) assertSafePath(root, target);
  try {
    fs.linkSync(tmp, target);
  } catch (err) {
    if (err?.code === 'EEXIST') {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      return false;
    }
    throw err;
  }
  try {
    fs.unlinkSync(tmp);
  } catch {}
  fsyncDir(path.dirname(target));
  return true;
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
