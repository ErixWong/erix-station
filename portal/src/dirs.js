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
 * 牢笼解析（JSON 预览与流式通道共用，同一条安全红线只写一遍）：
 * cwd 形态 → root 真实目录且非 symlink → 解析后 containment 检查（拒 .. / 绝对路径逃逸）
 * → 逐段 lstat 拒 symlink（防 bind mount 内用户自建 symlink 把文件内容泄漏到 jail 外）
 * → 目标必须是非 symlink 的普通文件。命中即抛 DirError，成功返回 { target, rel, st, project }。
 */
export function resolveJailedFile({ userSpaceRoot, fdeName, cwd, relPath, notFoundHint = 'file' } = {}) {
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
    const relToRoot = path.relative(root, target);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
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
        throw new DirError('not_found', `${notFoundHint} not found`, { httpStatus: 404 });
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
  return { target, rel, st, project: name };
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
