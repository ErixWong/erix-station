// P5 目录视图（docs/design/directory-as-project.md §4）：目录下拉 + 目录树的数据源。
// 依据：设计定稿 §2「项目列表 = DISTINCT cwd ∪ ~/projects/ 一级目录枚举」、§4（目录下拉带运行态
//       徽标、目录树懒展开单层）、§7 非目标（只读、不递归、不做任意路径手输）。
// 通道：portal 直读宿主机 bind mount <userSpaceRoot>/<fde>/projects/（零容器改动）；
//       running/queued_count 从 runs 聚合（cwd 匹配）。只读——本模块无任何写路径。

import fs from 'node:fs';
import path from 'node:path';
import { CWD_RE, validateSessionCwd } from './sessions.js';
import { commitTempFile, commitTempFileNoClobber, writeTempFileFromStream } from './fsutil.js';

export class DirError extends Error {
  constructor(code, message, { httpStatus = 400, details, retryable = false } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    // issue #472：**默认 false ⇒ 既有全部 DirError 的响应逐字节不变**，而 `upload_interrupted` 需要
    // 「重发即可」的语义。http.js 的 DirError 映射分支从硬编码 `false` 改成读这个字段（与 #261014
    // 的 LlmError 同一先例）——**没加新映射分支**，只是让已有的分支能读错误自带的值。
    this.retryable = retryable;
  }
}

/**
 * 目录名自身防护：readdir 不可能产出 /，但仍防御性拒绝 . / ..（路径穿越红线）。
 */
function isSafeDirName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..'
    && !name.includes('/') && !/[\x00-\x1f\x7f]/.test(name);
}

/**
 * 目录下拉是否列出该目录名：安全名 + 非隐藏（`.` 开头一律不列）。
 * 理由（design/directory-as-project.md §2 列表口径）：下拉是「项目选择器」而非文件管理器，
 * `~/projects/` 一级常出现工具自建目录——最典型是 pnpm 在无可写 HOME 时把内容寻址缓存
 * `.pnpm-store` 建到挂载根（数百 MB，码点还排在所有真实项目之前，直接顶掉第一项）。
 * 这类目录不可能被选为 cwd，列出来只是噪音。只影响**列表可见性**：已存在的
 * `~/projects/.xxx` 会话 cwd 仍可正常读写（validateSessionCwd / fileTree 不筛点开头）。
 */
function isListedDirName(name) {
  return isSafeDirName(name) && !name.startsWith('.');
}

/**
 * GET /api/dirs → { dirs: [{ name, cwd, running_count, queued_count }] }。
 * 枚举 ~/projects/ 一级目录（不存在则空列表，不 500——目录还没建过是正常态；
 * 隐藏目录不列，见 isListedDirName）；
 * 运行态聚合：runs JOIN chat_sessions 按 cwd 分组（queued = status 'queued'；
 * running = 'running' + 'cancelling'，与 sessions ACTIVE_RUN_STATES 同口径）。
 */
export async function listDirs(pool, { userId, userSpaceRoot, fdeName, log = console } = {}) {
  if (!userSpaceRoot || !fdeName) throw new DirError('internal', 'userSpaceRoot/fde_name 缺失', { httpStatus: 500 });
  const projectsRoot = path.join(path.resolve(userSpaceRoot), fdeName, 'projects');

  let names = [];
  try {
    names = fs.readdirSync(projectsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isListedDirName(d.name))
      .map((d) => d.name)
      .sort();
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { dirs: [] }; // 目录未创建 = 尚无项目，正常空态
    }
    throw err;
  }

  // 运行态徽标：该用户全部非终态 run 按会话 cwd 聚合（cwd 匹配的才是本目录的活跃）。
  const counts = new Map(); // cwd -> { running, queued }
  try {
    const res = await pool.query(
      `SELECT s.cwd,
              count(*) FILTER (WHERE r.status IN ('running', 'cancelling')) AS running,
              count(*) FILTER (WHERE r.status = 'queued') AS queued
         FROM runs r
         JOIN chat_sessions s ON s.id = r.session_id
        WHERE s.user_id = $1
          AND r.status IN ('queued', 'running', 'cancelling')
        GROUP BY s.cwd`,
      [userId],
    );
    for (const row of res.rows ?? []) {
      if (row.cwd) counts.set(row.cwd, { running: Number(row.running) || 0, queued: Number(row.queued) || 0 });
    }
  } catch (err) {
    // 徽标是增强物不是关键路径：聚合失败（如旧 DB 无 cwd 列的错位部署）退化为 0，不阻断目录列表。
    log.warn?.(`[dirs] run-state aggregation failed, badges default to 0: ${String(err?.message ?? err)}`);
  }

  return {
    dirs: names.map((name) => {
      const cwd = `~/projects/${name}`;
      const c = counts.get(cwd) ?? { running: 0, queued: 0 };
      return { name, cwd, running_count: c.running, queued_count: c.queued };
    }),
  };
}

/**
 * 牢笼根解析（issue #472 片 B：从 `fileTree` / `resolveJailedFile` **纯搬迁**出来的共用三段）：
 *   ① cwd 形态（`validateSessionCwd`）→ `root = <userSpaceRoot>/<fde>/projects/<name>`；
 *   ② 根必须真实存在且**不是 symlink、必须是目录**（否则 404 `not_found`）；
 *   ③ `path.resolve(root, relPath)` 之后的 containment（拒 `..` / 绝对路径逃逸）+ 逐段 `lstat`
 *      拒 symlink（防 bind mount 内用户自建 symlink 把 jail 外的内容泄漏进来，或把写入送出 jail）。
 *
 * 返回 `{ root, target, rel, project }`。⚠ **不保证 target 存在、也不保证类型**——那两件事由调用方
 * 按自己的语义决定（`fileTree` / `resolveJailedDir` 要目录，`resolveJailedFile` 要普通文件）。
 *
 * ⚠ 本函数是**评审 major 14 裁定「抽，不复制」**的产物，等价性的唯一判据：`portal/test/dirs.test.js`
 *   既有用例**一条不改**且全绿。为此两条既有路径各自的特判留在参数上（`requireConcreteRelPath`），
 *   而它们原本**不同的错误文案**用参数逐字保留（`notFoundHint` / `symlinkHint`）：
 *   不为了统一而改变既有行为（决策者红线）。
 */
function resolveJailedRoot({
  userSpaceRoot, fdeName, cwd, relPath,
  notFoundHint = 'path', symlinkHint = '列出', requireConcreteRelPath = false,
} = {}) {
  if (!userSpaceRoot || !fdeName) throw new DirError('internal', 'userSpaceRoot/fde_name 缺失', { httpStatus: 500 });
  let safeCwd;
  try {
    safeCwd = validateSessionCwd(cwd); // 400 validation_failed（形态不合法 / . / ..）
  } catch (err) {
    // 统一本模块错误类型（http.js 对两种类型同口径映射，此处为模块内契约一致性）。
    if (err instanceof DirError) throw err;
    throw new DirError(err.code ?? 'validation_failed', err.message, {
      httpStatus: err.httpStatus ?? 400,
      details: err.details,
    });
  }
  const name = CWD_RE.exec(safeCwd)[1];
  const root = path.resolve(userSpaceRoot, fdeName, 'projects', name);

  // 根必须真实存在且不是 symlink（目录树只浏览已存在的目录；不存在 = 404）。
  let rootSt;
  try {
    rootSt = fs.lstatSync(root);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new DirError('not_found', 'directory not found', { httpStatus: 404 });
    }
    throw err;
  }
  if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) {
    throw new DirError('not_found', 'directory not found', { httpStatus: 404 });
  }

  // `resolveJailedFile` 的特判（必须指向具体文件，不接受 '.' / 空）：位置与原实现逐字对齐（根校验之后）。
  if (requireConcreteRelPath && (typeof relPath !== 'string' || relPath.length === 0 || relPath === '.')) {
    throw new DirError('validation_failed', 'path 必须指向具体文件', { details: { field: 'path' } });
  }
  const target = path.resolve(root, String(relPath ?? '.'));
  if (target !== root) {
    const relToRoot = path.relative(root, target);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
      throw new DirError('validation_failed', 'path 不得逃逸目录根', { details: { field: 'path' } });
    }
  }

  // 逐段 lstat（不跟随 symlink）：已存在段任何一个是 symlink → 拒绝（**含最后一段**，同两侧既有口径）。
  const rel = path.relative(root, target);
  let cur = root;
  if (rel) {
    for (const seg of rel.split(path.sep)) {
      cur = path.join(cur, seg);
      let st;
      try {
        st = fs.lstatSync(cur);
      } catch (err) {
        if (err?.code === 'ENOENT') {
          throw new DirError('not_found', `${notFoundHint} not found`, { httpStatus: 404 });
        }
        throw err;
      }
      if (st.isSymbolicLink()) {
        throw new DirError('validation_failed', `path 含符号链接，拒绝${symlinkHint}`, { details: { field: 'path' } });
      }
    }
  }
  return { root, target, rel, project: name };
}

/**
 * GET /api/files/tree?cwd=<相对cwd>&path=<相对路径> → 单层目录列表 { entries: [{ name, type }] }。
 * 根 = cwd（必须解析后落在 ~/projects/<name> 内）；path 默认 '.'，只向下展开一级（懒加载，P6 前
 * 点击不处理）。路径穿越 / symlink 红线见 `resolveJailedRoot`（与 resolveJailedFile 同一条）；
 * 本函数只保留自己的语义：目标必须是目录，否则 400（文件点击是 P6 预览，不在树里）。
 */
export async function fileTree({ userSpaceRoot, fdeName, cwd, relPath = '.' } = {}) {
  const { target } = resolveJailedRoot({
    userSpaceRoot, fdeName, cwd, relPath: relPath ?? '.', notFoundHint: 'path', symlinkHint: '列出',
  });

  const st = fs.lstatSync(target);
  if (!st.isDirectory()) {
    // 文件节点：树面板懒展开只列目录；文件点击是 P6 预览（本端点只回目录）。
    throw new DirError('validation_failed', 'path 必须是目录', { details: { field: 'path' } });
  }

  const entries = [];
  for (const d of fs.readdirSync(target, { withFileTypes: true })) {
    if (!isSafeDirName(d.name)) continue;
    if (d.isDirectory()) entries.push({ name: d.name, type: 'dir' });
    else if (d.isFile()) entries.push({ name: d.name, type: 'file' });
    // 其余类型（symlink/socket 等）不列出：树面板只认 dir/file，symlink 既不显示也不跟随。
  }
  // 确定性输出：目录在前、各按名称码点字典序（与 locale 无关，同快照字节级相同）。
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return { entries };
}

/**
 * 牢笼解析（JSON 预览与流式通道共用）：三段红线见 `resolveJailedRoot`，本函数只保留自己的语义——
 * **目标必须是非 symlink 的普通文件**。命中即抛 DirError，成功返回 { target, rel, st, project }。
 */
export function resolveJailedFile({ userSpaceRoot, fdeName, cwd, relPath, notFoundHint = 'file' } = {}) {
  const { target, rel, project } = resolveJailedRoot({
    userSpaceRoot, fdeName, cwd, relPath, notFoundHint, symlinkHint: '读取', requireConcreteRelPath: true,
  });
  const st = fs.lstatSync(target);
  if (!st.isFile()) {
    throw new DirError('validation_failed', 'path 必须是文件', { details: { field: 'path' } });
  }
  return { target, rel, st, project };
}

/**
 * 上传目标目录（issue #472 片 B）：与 `resolveJailedFile` **同一条红线**（同一份 `resolveJailedRoot`），
 * 差别只有两点——目标**必须是目录**，且 `path` 允许 `'.'`（上传到项目根）。最终 symlink 一律拒：
 * 逐段 lstat 已覆盖最后一段，这里再 `lstatSync` 一次是为了「校验之后、打开 temp 之前」这段窗口里
 * 被 agent 换成 symlink 的竞态也能挡住（写入方向的红线比读取更硬）。
 * 返回 `{ dir, rel, root, project }`：`dir` 是可直接 `path.join(dir, name)` 的绝对目录。
 */
export function resolveJailedDir({ userSpaceRoot, fdeName, cwd, relPath = '.', notFoundHint = 'directory' } = {}) {
  const { root, target, rel, project } = resolveJailedRoot({
    userSpaceRoot, fdeName, cwd, relPath, notFoundHint, symlinkHint: '写入',
  });
  let st;
  try {
    st = fs.lstatSync(target);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new DirError('not_found', `${notFoundHint} not found`, { httpStatus: 404 });
    }
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new DirError('validation_failed', 'path 含符号链接，拒绝写入', { details: { field: 'path' } });
  }
  if (!st.isDirectory()) {
    throw new DirError('validation_failed', 'path 必须是目录', { details: { field: 'path' } });
  }
  return { dir: target, rel, root, project };
}

/**
 * 上传名形态（issue #472 片 B）：复用 `isSafeDirName` 的口径（拒空 / . / .. / `/` / 控制符含 NUL），
 * 再加一条 **UTF-8 字节数 ≤ 255**（不是字符数）：ext4 的单段上限是 255 **字节**，按字符数算会让
 * 中文名（3 字节/字）在 86 字就撞 ENAMETOOLONG，而 300 个 ASCII 字符本应合法。超限 / 形态非法
 * 一律 400 `validation_failed` + `details.field='name'`。
 */
function assertSafeUploadName(name) {
  if (!isSafeDirName(name)) {
    throw new DirError('validation_failed', 'name 不是合法文件名', { details: { field: 'name' } });
  }
  if (Buffer.byteLength(name, 'utf8') > UPLOAD_NAME_MAX_BYTES) {
    throw new DirError('validation_failed', `name 超过 ${UPLOAD_NAME_MAX_BYTES} 字节`, {
      details: { field: 'name', max_bytes: UPLOAD_NAME_MAX_BYTES },
    });
  }
}

/** 文件名单段字节上限（= ext4 的 NAME_MAX）。 */
export const UPLOAD_NAME_MAX_BYTES = 255;

/**
 * 上传落盘的文件 mode（issue #472）：0660 = 属主可写 + **同组可写**。
 * 口径来源：docs/design/user-space.md §6.2（组写位由属组 fdeGid + umask 达成，不靠 setgid）——
 * 上传的文件必须能被容器内的 agent（uid=fdeUid，主组=fdeGid）继续改，所以**组写位不能缺**。
 */
export const UPLOAD_FILE_MODE = 0o660;

/**
 * 把请求流写成 jail 内的一个文件（issue #472 片 B 的入向通道）。**不把 body 读进内存**
 * （评审 blocker 5：32MiB × 并发 = portal OOM = 全平台挂），也**不靠「先 lstat 再 rename」**
 * （评审 blocker 4：两步之间目标可被 agent 创建 ⇒ 静默覆盖）。
 *
 * 顺序即判据（a→f，a–c 全在打开 temp 之前 ⇒ 无效请求不必先把 body 收完）：
 *   a. `resolveJailedDir` → `dir`（目录不存在 404 / 越界 400 / symlink 段 400）
 *   b. `name` 形态（见 `assertSafeUploadName`）
 *   c. `target = dir/name` 的 `lstat`：symlink ⇒ 400（**无论 overwrite**，否则拿覆盖当借口改写
 *      jail 外的文件）；目录 ⇒ 400；存在且 `!overwrite` ⇒ 409 `file_exists`（**快速路径**，
 *      不是安全依据：真正的判据在 e）
 *   d. `writeTempFileFromStream`（逐 chunk 落 temp + 属主 + 0660 + fsync；超限/断流自己清 temp）
 *   e. 提交：`overwrite` ⇒ `commitTempFile`（rename，原子替换）；否则 `commitTempFileNoClobber`，
 *      返回 `false` ⇒ 409 `file_exists`（**这一条才是 no-clobber 的保证**）
 *   f. 返回 `{ path, bytes, overwritten }`（`path` 是相对 jail 根的路径，与 fileTree/预览同口径）
 *
 * 抛 `DirError`：`file_exists` 409 / `validation_failed` 400 / `not_found` 404 /
 * `file_too_large` 413 / `upload_interrupted` 400（retryable）。任何失败路径都不留 `.tmp` 残骸。
 * ⚠ `upload_disabled`（403）不在这里——那是能力位判定，属 handler（http.js）。
 *
 * @param uid/gid 落盘属主（portal 以 root 写，必须 chown 给 fdeUid/fdeGid，否则 agent 改不动）。
 *        **两者都要传**：`fchown(fd, uid, -1)` 会留下 gid=0（root 组），见 fsutil.ensureDirSafe 的长注。
 */
export async function receiveUpload({
  userSpaceRoot, fdeName, cwd, relPath = '.', name, stream, maxBytes, overwrite = false, uid = null, gid = null,
} = {}) {
  // a. 目录牢笼（先于一切：越界/不存在的目录不值得为此收 body）。
  const { dir, rel } = resolveJailedDir({ userSpaceRoot, fdeName, cwd, relPath });
  // b. 名字形态。
  assertSafeUploadName(name);
  const target = path.join(dir, name);
  const relPathOut = rel ? path.join(rel, name) : name;

  // c. 快速路径（**不是** no-clobber 的依据，见 e）。
  let existing = null;
  try {
    existing = fs.lstatSync(target);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  if (existing) {
    // 最终 symlink 一律拒，**与 overwrite 无关**：目标是 symlink 时 rename 换的是链接本身，
    // 而 lstat 之后到写入之前它还可能被换成指向 jail 外的东西 ⇒ 覆盖语义保不住 jail。
    if (existing.isSymbolicLink()) {
      throw new DirError('validation_failed', '目标是符号链接，拒绝写入', { details: { field: 'name' } });
    }
    if (existing.isDirectory()) {
      throw new DirError('validation_failed', '目标是一个目录，不能当文件写', { details: { field: 'name' } });
    }
    if (!overwrite) {
      throw new DirError('file_exists', '目标文件已存在', { httpStatus: 409, details: { path: relPathOut } });
    }
  }

  // d. 流式落 temp（属主/0660/fsync 全在 fsutil 里，与平台其余原子写同一口径）。
  let tmp;
  let bytes;
  try {
    ({ tmp, bytes } = await writeTempFileFromStream(target, stream, { maxBytes, mode: UPLOAD_FILE_MODE, uid, gid, root: dir }));
  } catch (err) {
    if (err?.code === 'upload_too_large') {
      throw new DirError('file_too_large', `上传超过上限（${err.maxBytes} 字节）`, {
        httpStatus: 413,
        details: { max_bytes: err.maxBytes, bytes: err.bytes },
      });
    }
    if (err?.code === 'upload_interrupted') {
      throw new DirError('upload_interrupted', '上传在传输完成前中断', {
        httpStatus: 400,
        retryable: true,
        details: { bytes: err.bytes },
      });
    }
    throw err;
  }

  // e. 提交点。
  let overwritten = false;
  if (overwrite) {
    // rename 原子替换（目标是 symlink 已在 c 拒掉，不会替换成链接本身而逃逸）。
    // fsyncDir 失败（返回 false）不改响应：内容已提交，报失败会让用户重传覆盖掉自己的新内容。
    commitTempFile(tmp, target, { root: dir });
    overwritten = true;
  } else if (!commitTempFileNoClobber(tmp, target, { root: dir })) {
    // d 与 e 之间目标被别人（agent / 另一个上传）创建了 ⇒ 与 c 同一个码，调用方不必区分。
    throw new DirError('file_exists', '目标文件已存在（提交点竞态）', { httpStatus: 409, details: { path: relPathOut } });
  }

  // f. DTO（docs/api/portal.md §4.14）。
  return { path: relPathOut, bytes, overwritten };
}

/**
 * GET /api/file?cwd=<相对cwd>&path=<相对路径> → 单文件只读预览 { name, path, kind, data }。
 * P6（issue #84）文件面板点击预览第一版：文本/Markdown/图片；git 变更标记与 run 终态
 * 刷新不在本版范围。
 * 牢笼校验见 resolveJailedFile（与 fileTree 同口径，安全红线）。
 * 大小上限 FILE_PREVIEW_MAX_BYTES（超限 413 报错不截断）；非图片按「前 8KB 嗅探 NUL 字节」
 * 判二进制，二进制明确拒绝（不猜测解码乱码）——415/413 同时被 #366 P0 埋点计数（http.js 接线）。
 */
export async function readFilePreview({ userSpaceRoot, fdeName, cwd, relPath } = {}) {
  const { target, rel, st } = resolveJailedFile({ userSpaceRoot, fdeName, cwd, relPath });
  if (st.size > FILE_PREVIEW_MAX_BYTES) {
    throw new DirError('file_too_large', `文件超过预览上限（${Math.floor(FILE_PREVIEW_MAX_BYTES / 1024 / 1024)}MB）`, {
      httpStatus: 413,
    });
  }

  const ext = path.extname(target).toLowerCase();
  const buf = fs.readFileSync(target);
  const mime = IMAGE_MIME[ext];
  if (mime) {
    // 图片：base64 data URL（SVG 经 <img> 加载不执行脚本，安全口径与浏览器一致）。
    return { name: path.basename(target), path: rel, kind: 'image', data: `data:${mime};base64,${buf.toString('base64')}` };
  }
  // 非图片：前 8KB NUL 嗅探判二进制（UTF-8 文本不可能含 NUL；二进制不猜测解码）。
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) {
    throw new DirError('unsupported_file_type', '二进制文件不支持预览', { httpStatus: 415 });
  }
  return { name: path.basename(target), path: rel, kind: 'text', data: buf.toString('utf8') };
}

/** 预览单文件大小上限（P6 issue #84）：超限报错而非截断，防误点大文件把 portal 内存打爆。 */
export const FILE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 流式通道单文件上限（#366 P0）：不读进内存（createReadStream），上限只是护栏
 * （防百 GB 级误点堵带宽）；比 JSON 预览的 2MB 宽两个量级——大 PDF/视频的合法体积。
 */
export const FILE_STREAM_MAX_BYTES = 512 * 1024 * 1024;

/** 图片扩展名 → data URL MIME（图片走 base64 data URL，前端 <img> 直接渲染，零新端点）。 */
const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};

/**
 * 流式通道响应 MIME（#366 P0，浏览器原生可渲集）。红线：没有 text/html——工作区里的
 * .html 若以 text/html 同源直出，脚本在 portal 源里执行（预览即 XSS）；一律降级为下载。
 * 未知扩展名 → application/octet-stream（浏览器存盘，不猜）。
 */
const STREAM_MIME = {
  ...IMAGE_MIME,
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
};

/** 流式通道取 MIME：图片/PDF/音视频命中白名单，其余 octet-stream（存盘不执行）。 */
export function streamMimeFor(target) {
  return STREAM_MIME[path.extname(String(target)).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 单 Range 解析（#366 P0，视频 seek / pdf.js 分段加载的硬前置）。
 * 支持 `bytes=a-b` / `bytes=a-` / `bytes=-N`（后缀长）；多 Range、非法格式一律当无 Range
 * （整身 200，宽容降级）。不可满足（起点 ≥ 大小）是 Range 语义错误 → 416，与「没发 Range」
 * 不同类，不可降级。
 * @returns {{status:'ok',start:number,end:number}|{status:'unsatisfiable'}|{status:'none'}|null}
 */
export function parseSingleRange(header, size) {
  if (typeof header !== 'string' || !header) return { status: 'none' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return { status: 'none' };
  if (size === 0) return { status: 'unsatisfiable' };
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n) || n <= 0) return { status: 'none' };
    return { status: 'ok', start: Math.max(size - n, 0), end: size - 1 };
  }
  const start = Number(m[1]);
  if (!Number.isSafeInteger(start) || start >= size) return { status: 'unsatisfiable' };
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return { status: 'ok', start, end };
}

/**
 * 流式打开通道（#366 P0）：牢笼同 JSON 预览，但不嗅探类型、不读进内存，返回
 * { name, path, rel, size, mime, status(200|206), headers, stream }（headers 给 http 层原样
 * writeHead；stream 为 null 时是 416，headers 带 Content-Range）。download=true →
 * attachment（「下载」按钮的出口）；否则媒体白名单内 inline、其余（octet-stream）强制
 * attachment（红线：同源未知字节流不给 inline）。无 Range ⇒ 整身 200。
 */
export async function openFileStream({
  userSpaceRoot, fdeName, cwd, relPath, range = null, disposition = 'inline',
} = {}) {
  const { target, rel, st } = resolveJailedFile({ userSpaceRoot, fdeName, cwd, relPath });
  if (st.size > FILE_STREAM_MAX_BYTES) {
    throw new DirError('file_too_large', `文件超过流式上限（${Math.floor(FILE_STREAM_MAX_BYTES / 1024 / 1024)}MB）`, {
      httpStatus: 413,
    });
  }
  const name = path.basename(target);
  const mime = streamMimeFor(target);
  // inline 资格：媒体白名单命中才 inline；octet-stream 未知型强制 attachment，
  // 除非调用方明确要求 attachment（disposition='attachment'）。
  const effective = disposition === 'download' || mime === 'application/octet-stream' ? 'attachment' : 'inline';
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${effective}; filename="${sanitizeFilename(name)}"`,
  };
  const parsed = parseSingleRange(range, st.size);
  if (parsed?.status === 'unsatisfiable') {
    return {
      name, path: rel, rel, size: st.size, mime, status: 416, stream: null,
      headers: { ...headers, 'Content-Range': `bytes */${st.size}` },
    };
  }
  const { start, end } = parsed?.status === 'ok' ? parsed : { start: 0, end: st.size - 1 };
  const length = st.size === 0 ? 0 : end - start + 1;
  if (parsed?.status === 'ok') {
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = String(length);
  return {
    name, path: rel, rel, size: st.size, mime, status: parsed?.status === 'ok' ? 206 : 200,
    headers, stream: fs.createReadStream(target, length === 0 ? { start: 0, end: -1 } : { start, end }),
  };
}

/** Content-Disposition filename 净化：去引号/反斜杠/控制符/分号，防头注入与断句。 */
function sanitizeFilename(name) {
  return String(name).replace(/["\\;\x00-\x1f\x7f]/g, '_').slice(0, 200);
}
