// P5 目录视图（docs/design/directory-as-project.md §4）：目录下拉 + 目录树的数据源。
// 依据：设计定稿 §2「项目列表 = DISTINCT cwd ∪ ~/projects/ 一级目录枚举」、§4（目录下拉带运行态
//       徽标、目录树懒展开单层）、§7 非目标（只读、不递归、不做任意路径手输）。
// 通道：portal 直读宿主机 bind mount <userSpaceRoot>/<fde>/projects/（零容器改动）；
//       running/queued_count 从 runs 聚合（cwd 匹配）。只读——本模块无任何写路径。

import fs from 'node:fs';
import path from 'node:path';
import { CWD_RE, validateSessionCwd } from './sessions.js';

export class DirError extends Error {
  constructor(code, message, { httpStatus = 400, details } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/** 目录名自身防护：readdir 不可能产出 /，但仍防御性拒绝 . / ..（路径穿越红线）。 */
function isSafeDirName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..'
    && !name.includes('/') && !/[\x00-\x1f\x7f]/.test(name);
}

/**
 * GET /api/dirs → { dirs: [{ name, cwd, running_count, queued_count }] }。
 * 枚举 ~/projects/ 一级目录（不存在则空列表，不 500——目录还没建过是正常态）；
 * 运行态聚合：runs JOIN chat_sessions 按 cwd 分组（queued = status 'queued'；
 * running = 'running' + 'cancelling'，与 sessions ACTIVE_RUN_STATES 同口径）。
 */
export async function listDirs(pool, { userId, userSpaceRoot, fdeName, log = console } = {}) {
  if (!userSpaceRoot || !fdeName) throw new DirError('internal', 'userSpaceRoot/fde_name 缺失', { httpStatus: 500 });
  const projectsRoot = path.join(path.resolve(userSpaceRoot), fdeName, 'projects');

  let names = [];
  try {
    names = fs.readdirSync(projectsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isSafeDirName(d.name))
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
 * GET /api/files/tree?cwd=<相对cwd>&path=<相对路径> → 单层目录列表 { entries: [{ name, type }] }。
 * 根 = cwd（必须解析后落在 ~/projects/<name> 内）；path 默认 '.'，只向下展开一级（懒加载，P6 前
 * 点击不处理）。路径穿越防护：解析后必须仍位于 cwd root 内；任何已存在段不得为 symlink
 * （防 bind mount 内用户自建的 symlink 把列表泄漏到 jail 外）；目标本身为 symlink 也拒绝。
 */
export async function fileTree({ userSpaceRoot, fdeName, cwd, relPath = '.' } = {}) {
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

  const target = path.resolve(root, String(relPath ?? '.'));
  if (target !== root) {
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new DirError('validation_failed', 'path 不得逃逸目录根', { details: { field: 'path' } });
    }
  }

  // 逐段 lstat（不跟随 symlink）：根以下的已存在段任何一个是 symlink → 拒绝（防 jail 外泄漏）。
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
          throw new DirError('not_found', 'path not found', { httpStatus: 404 });
        }
        throw err;
      }
      if (st.isSymbolicLink()) {
        throw new DirError('validation_failed', 'path 含符号链接，拒绝列出', { details: { field: 'path' } });
      }
    }
  }

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
 * GET /api/file?cwd=<相对cwd>&path=<相对路径> → 单文件只读预览 { name, path, kind, data }。
 * P6（issue #84）文件面板点击预览第一版：文本/Markdown/图片；git 变更标记与 run 终态
 * 刷新不在本版范围。
 * 牢笼校验与 fileTree 同口径（安全红线）：cwd 形态 → root 真实目录且非 symlink →
 * 解析后 containment 检查（拒 .. / 绝对路径逃逸）→ 逐段 lstat 拒 symlink（防 bind mount 内
 * 用户自建 symlink 把文件内容泄漏到 jail 外）→ 目标必须是非 symlink 的普通文件。
 * 大小上限 FILE_PREVIEW_MAX_BYTES（超限 413 报错不截断）；非图片按「前 8KB 嗅探 NUL 字节」
 * 判二进制，二进制明确拒绝（不猜测解码乱码）。
 */
export async function readFilePreview({ userSpaceRoot, fdeName, cwd, relPath } = {}) {
  if (!userSpaceRoot || !fdeName) throw new DirError('internal', 'userSpaceRoot/fde_name 缺失', { httpStatus: 500 });
  let safeCwd;
  try {
    safeCwd = validateSessionCwd(cwd); // 400 validation_failed（形态不合法 / . / ..）
  } catch (err) {
    if (err instanceof DirError) throw err;
    throw new DirError(err.code ?? 'validation_failed', err.message, {
      httpStatus: err.httpStatus ?? 400,
      details: err.details,
    });
  }
  const name = CWD_RE.exec(safeCwd)[1];
  const root = path.resolve(userSpaceRoot, fdeName, 'projects', name);

  // 根必须真实存在且不是 symlink（与 fileTree 同口径）。
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

  if (typeof relPath !== 'string' || relPath.length === 0 || relPath === '.') {
    throw new DirError('validation_failed', 'path 必须指向具体文件', { details: { field: 'path' } });
  }
  const target = path.resolve(root, relPath);
  if (target !== root) {
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new DirError('validation_failed', 'path 不得逃逸目录根', { details: { field: 'path' } });
    }
  }

  // 逐段 lstat（不跟随 symlink）：任何已存在段是 symlink → 拒绝（同 fileTree）。
  const rel = path.relative(root, target);
  let cur = root;
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        throw new DirError('not_found', 'file not found', { httpStatus: 404 });
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new DirError('validation_failed', 'path 含符号链接，拒绝读取', { details: { field: 'path' } });
    }
  }

  const st = fs.lstatSync(target);
  if (!st.isFile()) {
    throw new DirError('validation_failed', 'path 必须是文件', { details: { field: 'path' } });
  }
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

/** 图片扩展名 → data URL MIME（图片走 base64 data URL，前端 <img> 直接渲染，零新端点）。 */
const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};
