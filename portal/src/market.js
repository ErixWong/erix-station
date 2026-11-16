// portal/src/market.js —— 能力市场（技能市场）P0 的数据层与安装面（issue #595）
//
// 契约唯一真相：`docs/design/capability-market.md`。本文件负责 §3（校验）、§4（安装/卸载/启停）、
// §7 的 DTO 形状；HTTP 装配在 `src/http.js`，`capabilities.json` 的渲染在 `src/materializer.js`。
//
// 为什么这个模块**不执行**任何技能代码：§1.1 的不可信边界是「包内容来自平台自己的 git，但仍是外部件」。
// 平台只做静态校验（文件名/体积/源码正则），运行期由 runner 的 `buildSkillTools` 装配
// （`runner/worker.js`），引擎不 `import` 的技能目录连读都不读。校验判据因此必须能在**没有 node 上下文**
// 的地方跑（发布时只有 bundle），副作用只有「落库」与「落盘」。
//
// 为什么校验函数是纯函数、副作用函数只吃 `{pool, config, fde}`：单测（test/market.test.js）用
// tmp 目录当 userSpaceRoot + 注入 fake pool 跑完整安装流程，不碰真实 DB / 真实 `/srv/erix`
// （docs/testing.md §2.1 的隔离约定）。
//
// 事务边界（§4）：磁盘写在 DB 落账**之前**。tmp+rename 让写盘要么整体可见要么不留痕；
// 反过来的话「库里说装了、磁盘上没有」会长期存在（平台不做磁盘对账，§4 末段）。
import fs from 'node:fs';
import path from 'node:path';

import { assertSafePath, ensureDirSafe, randomHex } from './fsutil.js';
import { validateFdeName } from './projects.js';
import { enqueueMaterializeChange } from './outbox.js';

// ---------------------------------------------------------------------------
// 常量：§3 的天花板与 §4 的预算，全部集中在这里（HTTP 层与文档引用的必须是同一份）
// ---------------------------------------------------------------------------

/** §3 的硬数字。改一个就要同步 docs/api/portal.md §4.16 与 docs/design/capability-market.md。 */
export const LIMITS = {
  maxEnabledSkills: 12,        // §4：`enabled` 的安装数 ≤ 12（runner 每轮都拼 index，条数直接进上下文）
  maxFiles: 50,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
  maxPathLen: 200,
  whenToUseMin: 8,
  whenToUseMax: 500,
  maxTools: 12,
  toolDescMin: 20,
  maxWarnings: 50,             // 只截**列表**，分数按命中总数算（截断不许把风险算没了）
};

/** §4：slug 同时是目录名与 L3 索引里的 `id` 候选，字符集必须对 shell / URL / skill 都安全。 */
export const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** §3：工具名进 `buildSkillTools` 的 function name，形状与引擎侧一致（`[a-z][a-z0-9_]{1,63}`）。 */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
export const ENTRYPOINT = 'skill.mjs';
export const README_FILE = 'SKILL.md';
/** §3 布局白名单：根只允许这两个文件，子目录只允许这三个。 */
export const ALLOWED_ROOT_FILES = Object.freeze([ENTRYPOINT, README_FILE]);
export const ALLOWED_DIRS = Object.freeze(['scripts', 'references', 'assets']);

/**
 * 发布体的**请求体**上限（不是 bundle 上限）。
 * bundle 走 JSON + base64，2 MiB 原文 base64 后约 2.75 MiB，而 `config.maxBodyBytes` 默认只有 64 KiB
 * ——`docs/api/portal.md` §4.15 记的就是这个坑（「上传根本不走 readJsonBody」）。
 * 这里不走 multipart（P0 的 transport 是 JSON bundle，§1.1），所以必须显式抬高这一条路由的上限。
 */
export const BUNDLE_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** §3 静态扫描的 8 条模式（命中各记一条 warning，`security_score = max(0, 100 - 10n)`）。 */
export const SCAN_PATTERNS = Object.freeze([
  { code: 'uses_child_process', re: /\bchild_process\b/g, note: '起子进程 = 逃逸容器的最近路' },
  { code: 'uses_eval', re: /\beval\(/g, note: '动态求值，静态面看不出真正跑了什么' },
  { code: 'uses_new_function', re: /\bnew Function\b/g, note: '同上：动态构造代码' },
  { code: 'reads_process_env', re: /\bprocess\.env\b/g, note: '可能读到平台注入的密钥' },
  { code: 'uses_fetch', re: /\bfetch\(/g, note: '出网：数据可能离开容器' },
  { code: 'uses_https_request', re: /\bhttps\.request\b/g, note: '出网（低层写法）' },
  { code: 'uses_fs_remove', re: /\brmSync\s*\(|\brm\s*\(/g, note: '删文件：可能删掉用户内容' },
  { code: 'uses_chmod', re: /\bchmod\b/g, note: '改权限：可能把 0600 放宽' },
]);

// ---------------------------------------------------------------------------
// 错误：一条 `MarketError` 承载 `{code, httpStatus, details}`，由 http.js 直接映射
// ---------------------------------------------------------------------------

export class MarketError extends Error {
  constructor(message, { code = 'validation_failed', httpStatus = 400, details = {} } = {}) {
    super(message);
    this.name = 'MarketError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

const bad = (message, details) => new MarketError(message, { code: 'validation_failed', details });

// ---------------------------------------------------------------------------
// §3 之一：路径与 bundle 形状（纯函数，全部可单测）
// ---------------------------------------------------------------------------

/**
 * §3 的路径规则：相对、无 `\`、无绝对路径、**任何** `..` 段（子串不算：`a..b` 是合法文件名）、
 * 长度 ≤ 200、无空段/尾斜杠。zip-slip 的判据必须是**段**，不是子串——否则误杀合法名，
 * 而漏掉 `a/../../x` 这种「不在开头但逃逸」的写法。
 * @returns {string} 归一化后的相对路径（`/` 分隔）
 */
export function validateFilePath(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw bad('bundle.files[].path 必须是非空字符串', { field: 'bundle.files[].path' });
  if (raw.length > LIMITS.maxPathLen) {
    throw bad(`路径超过 ${LIMITS.maxPathLen} 字符`, { field: 'path', path: raw.slice(0, 80), max: LIMITS.maxPathLen });
  }
  if (raw.includes('\\')) throw bad('路径不得包含反斜杠（Windows 分隔符在容器里没有含义）', { field: 'path', path: raw });
  if (raw.startsWith('/')) throw bad('路径不得是绝对路径', { field: 'path', path: raw });
  if (raw.endsWith('/')) throw bad('路径不得以 / 结尾（bundle 里只有文件，没有目录项）', { field: 'path', path: raw });
  const segs = raw.split('/');
  for (const s of segs) {
    if (s === '' ) throw bad('路径不得有空段（连续斜杠 / 前导 ./）', { field: 'path', path: raw });
    if (s === '..') throw bad('路径不得包含 .. 段（zip-slip）', { field: 'path', path: raw });
    if (s === '.') throw bad('路径不得包含 . 段（请给规范化的相对路径）', { field: 'path', path: raw });
    if (s.startsWith('.')) throw bad('不允许隐藏文件（`.` 开头一律不在白名单内）', { field: 'path', path: raw });
  }
  return raw;
}

/**
 * 布局校验（§3）：根必须有 `skill.mjs`；根只允许 `skill.mjs` / `SKILL.md`；
 * 子目录只允许 `scripts/` `references/` `assets/`；子目录里不得再出现 `skill.mjs`
 * （入口声明只能有一份，否则「装进去的到底是哪个」没有答案）。
 * @param {Array<{path: string}>} files
 */
export function validateLayout(files) {
  const paths = files.map((f) => f.path);
  if (!paths.includes(ENTRYPOINT)) {
    throw bad(`包根必须有 ${ENTRYPOINT}`, { field: 'bundle', reason: 'missing_entrypoint', required: ENTRYPOINT });
  }
  for (const p of paths) {
    const segs = p.split('/');
    if (segs.length === 1) {
      if (!ALLOWED_ROOT_FILES.includes(segs[0])) {
        throw bad(`根目录只允许 ${ALLOWED_ROOT_FILES.join(' / ')}，出现 ${segs[0]}`,
          { field: 'bundle', reason: 'unexpected_root_file', path: p, allowed: ALLOWED_ROOT_FILES });
      }
    } else {
      if (!ALLOWED_DIRS.includes(segs[0])) {
        throw bad(`子目录只允许 ${ALLOWED_DIRS.join(' / ')}，出现 ${segs[0]}/`,
          { field: 'bundle', reason: 'unexpected_dir', path: p, allowed: ALLOWED_DIRS });
      }
      if (segs.at(-1) === ENTRYPOINT) {
        throw bad(`${ENTRYPOINT} 只能出现在包根（子目录里的那份不会被任何入口读到）`,
          { field: 'bundle', reason: 'entrypoint_in_subdir', path: p });
      }
    }
  }
}

/** base64 → Buffer：严格形状（Node 的 `Buffer.from(b64,'base64')` 会**静默丢掉**非法字符，半个值生效比报错难查）。 */
export function decodeBase64File(raw, p) {
  if (typeof raw !== 'string') throw bad('bundle.files[].content_base64 必须是字符串', { field: 'content_base64', path: p });
  if (raw.length > 0 && !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) {
    throw bad('content_base64 不是规范 base64（含空白 / 换行 / 非法字符一律拒绝）', { field: 'content_base64', path: p });
  }
  if (raw.length % 4 !== 0) throw bad('content_base64 长度不是 4 的倍数', { field: 'content_base64', path: p });
  const buf = Buffer.from(raw, 'base64');
  // P0 的技能包是**文本**（源码 / md）：非 UTF-8 一律拒绝，否则静态正则与 SKILL.md 渲染都在字节云上做。
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw bad('文件内容不是合法 UTF-8（P0 只分发文本文件）', { field: 'content_base64', path: p, reason: 'not_utf8' });
  }
  return buf;
}

// ---------------------------------------------------------------------------
// §3 之二：从 `skill.mjs` 源码静态取 `skill.id` 与 `tools[]`
// ---------------------------------------------------------------------------

/**
 * 跳过字符串字面量，返回 `src[from]` 处 `[` / `{` 对应闭合括号的**下标**（找不到返回 -1）。
 * 必须引号感知：描述里出现 `[` 会把朴素的括号计数带到错误的闭合点。
 */
function findMatchingBracket(src, from) {
  const open = src[from];
  const close = open === '[' ? ']' : open === '{' ? '}' : null;
  if (!close) return -1;
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i);
      continue;
    }
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { i = skipComment(src, i); continue; }
    if (c === open) depth += 1;
    else if (c === close) { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** 从引号下标走到引号结束的**下一个**下标（处理反斜杠转义）。 */
function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j += 1) {
    const c = src[j];
    if (c === '\\') { j += 1; continue; }
    if (c === q) return j + 1;
  }
  return src.length;
}

function skipComment(src, i) {
  if (src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl === -1 ? src.length : nl;   // 换行本身留给主循环（行号靠它）
  }
  const end = src.indexOf('*/', i + 2);
  return end === -1 ? src.length : end + 1;
}

/** 读 `i` 处的字符串字面量（`'` `"` `` ` `` 三种），返回 `{value, end}`；不是字符串字面量返回 null。 */
function readStringLiteral(src, i) {
  while (i < src.length && /\s/.test(src[i])) i += 1;
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  let out = '';
  for (let j = i + 1; j < src.length; j += 1) {
    const c = src[j];
    if (c === '\\') {
      const n = src[j + 1];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : (n ?? '');
      j += 1;
      continue;
    }
    if (c === q) return { value: out, end: j + 1 };
    out += c;
  }
  return null;
}

/**
 * 静态取 `{skillId, tools}`。
 * 为什么必须静态：§7 的发布体**没有** tools 字段，而 `capability_items.manifest` 与
 * `capabilities.json` 的 `tools[]` 都要用到它——平台不能为了拿清单就去 `import` 外部件（§1.1）。
 * 取不到就算发布失败：宁缺毋滥（工具面为空 = 装了也调不到任何东西）。
 * @returns {{skillId: string|null, tools: Array<{name: string, description: string}>}}
 */
export function extractSkillMeta(source) {
  const idMatch = /\bid\s*:\s*(['"])([^'"]+)\1/.exec(source);
  const skillId = idMatch ? idMatch[2] : null;

  const tools = [];
  const key = /\btools\s*:\s*\[/.exec(source);
  if (key) {
    const open = source.indexOf('[', key.index);
    const close = findMatchingBracket(source, open);
    if (close > open) {
      const body = source.slice(open + 1, close);
      const re = /\bname\s*:/g;
      let m;
      while ((m = re.exec(body)) !== null) {
        const named = readStringLiteral(body, m.index + m[0].length);
        if (!named) continue;
        const dKey = /\bdescription\s*:/.exec(body.slice(named.end));
        const desc = dKey ? readStringLiteral(body, named.end + dKey.index + dKey[0].length) : null;
        tools.push({ name: named.value, description: desc ? desc.value : '' });
        re.lastIndex = named.end;
      }
    }
  }
  return { skillId, tools };
}

// ---------------------------------------------------------------------------
// §3 之三：静态扫描（advisory，**不是**闸门）
// ---------------------------------------------------------------------------

/**
 * @param {Array<{path: string, content: Buffer}>} files
 * @returns {{score: number, warnings: Array<object>}} 分数 = `max(0, 100 - 10 × 命中数)`
 */
export function scanSecurity(files) {
  const warnings = [];
  let hits = 0;
  for (const f of files) {
    if (!f.path.endsWith('.mjs') && !f.path.endsWith('.js') && !f.path.endsWith('.md')) continue;
    const lines = f.content.toString('utf8').split('\n');
    lines.forEach((line, idx) => {
      for (const { code, re, note } of SCAN_PATTERNS) {
        const n = line.match(new RegExp(re.source, 'g'))?.length ?? 0;
        if (n === 0) continue;
        hits += n;
        if (warnings.length < LIMITS.maxWarnings) {
          warnings.push({ code, path: f.path, line: idx + 1, note });
        }
      }
    });
  }
  return { score: Math.max(0, 100 - hits * 10), warnings };
}

// ---------------------------------------------------------------------------
// §3 之四：bundle 校验的总入口
// ---------------------------------------------------------------------------

/**
 * §3 的全部 bundle 校验。**不写库不写盘**。
 * @param {object} input
 * @param {string} input.slug          条目 slug（用来交叉核对源码里的 `skill.id`）
 * @param {string} input.whenToUse     item 元数据里的「何时用」（§3 也管它的长度）
 * @param {object} input.bundle        `{files: [{path, content_base64}]}`
 * @returns {{files: Array<{path: string, content: Buffer, bytes: number}>,
 *            manifest: object, security: {score: number, warnings: Array<object>}}}
 */
export function validateBundle({ slug, whenToUse, bundle }) {
  if (!SKILL_SLUG_RE.test(String(slug ?? ''))) {
    throw bad(`slug 必须匹配 ${SKILL_SLUG_RE.source}`, { field: 'slug', slug });
  }
  const w = typeof whenToUse === 'string' ? whenToUse.trim() : '';
  if (w.length < LIMITS.whenToUseMin || w.length > LIMITS.whenToUseMax) {
    throw bad('when_to_use 必填且长度 8..500', {
      field: 'when_to_use', min: LIMITS.whenToUseMin, max: LIMITS.whenToUseMax, actual: w.length,
    });
  }
  if (bundle === null || typeof bundle !== 'object' || !Array.isArray(bundle.files)) {
    throw bad('bundle.files 必须是数组', { field: 'bundle.files' });
  }
  if (bundle.files.length === 0) throw bad('bundle.files 不能为空', { field: 'bundle.files', reason: 'empty_bundle' });
  if (bundle.files.length > LIMITS.maxFiles) {
    throw bad('文件数超过上限', { field: 'bundle.files', max: LIMITS.maxFiles, actual: bundle.files.length });
  }

  const files = [];
  const seen = new Set();
  let total = 0;
  for (const entry of bundle.files) {
    if (entry === null || typeof entry !== 'object') throw bad('bundle.files[] 必须是对象', { field: 'bundle.files[]' });
    const p = validateFilePath(entry.path);
    // 重复路径必须在**解码前**拒：后写的会静默盖掉前一个，落盘只有一份，而 manifest 记的是两条。
    if (seen.has(p)) throw bad('包内路径重复', { field: 'path', path: p, reason: 'duplicate_path' });
    seen.add(p);
    const buf = decodeBase64File(entry.content_base64, p);
    if (buf.length > LIMITS.maxFileBytes) {
      throw bad('单文件超过 512 KiB', { field: 'bytes', path: p, max: LIMITS.maxFileBytes, actual: buf.length });
    }
    total += buf.length;
    if (total > LIMITS.maxTotalBytes) {
      throw bad('包总大小超过 2 MiB', { field: 'bytes', max: LIMITS.maxTotalBytes, actual: total });
    }
    files.push({ path: p, content: buf, bytes: buf.length });
  }

  validateLayout(files);
  const entry = files.find((f) => f.path === ENTRYPOINT);
  const source = entry.content.toString('utf8');
  const { skillId, tools } = extractSkillMeta(source);
  if (skillId === null) {
    throw bad(`${ENTRYPOINT} 里静态取不到 id 字面量（平台不执行技能代码，取不到 = 无法交叉核对）`,
      { field: 'bundle', reason: 'skill_id_unreadable' });
  }
  if (skillId !== slug) {
    throw bad(`源码里的 skill.id="${skillId}" 与 slug="${slug}" 不一致`,
      { field: 'bundle', reason: 'skill_id_mismatch', skill_id: skillId, slug });
  }
  if (tools.length < 1 || tools.length > LIMITS.maxTools) {
    throw bad(`tools[] 条数必须 1..${LIMITS.maxTools}`, { field: 'bundle', reason: 'tools_count', actual: tools.length });
  }
  const names = new Set();
  for (const t of tools) {
    if (!TOOL_NAME_RE.test(t.name)) {
      throw bad(`工具名必须匹配 ${TOOL_NAME_RE.source}`, { field: 'bundle', reason: 'tool_name_invalid', name: t.name });
    }
    if (names.has(t.name)) throw bad('工具名重复', { field: 'bundle', reason: 'tool_name_duplicate', name: t.name });
    names.add(t.name);
    if (t.description.trim().length < LIMITS.toolDescMin) {
      throw bad('工具 description 太短（模型靠这句话决定调不调）', {
        field: 'bundle', reason: 'tool_description_short', name: t.name,
        min: LIMITS.toolDescMin, actual: t.description.trim().length,
      });
    }
  }

  const security = scanSecurity(files);
  const manifest = {
    skill_id: skillId,
    entrypoint: ENTRYPOINT,
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
    files: files.map((f) => ({ path: f.path, bytes: f.bytes })),
  };
  return { files, manifest, security };
}

/** item 元数据校验（§7 的字段面；§3 只点名了 slug/when_to_use，其余按「必填就拒空」的最小口径）。 */
export function validateMetadata(fields, { requireAll = false } = {}) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw bad('请求体必须是 JSON 对象', { field: 'body' });
  }
  const out = {};
  const needStr = (key, { max = 500, min = 1 } = {}) => {
    const v = fields[key];
    if (v === undefined) {
      if (requireAll) throw bad(`${key} 必填`, { field: key });
      return undefined;
    }
    if (typeof v !== 'string' || v.trim().length < min || v.length > max) {
      throw bad(`${key} 必须是 ${min}..${max} 字符的字符串`, { field: key, min, max });
    }
    return v.trim();
  };
  if (fields.slug !== undefined) {
    const s = needStr('slug', { max: 64 });
    if (!SKILL_SLUG_RE.test(s)) throw bad(`slug 必须匹配 ${SKILL_SLUG_RE.source}`, { field: 'slug', slug: s });
    out.slug = s;
  }
  const name = needStr('name', { max: 120 });
  if (name !== undefined) out.name = name;
  const summary = needStr('summary', { max: 200 });
  if (summary !== undefined) out.summary = summary;
  if (fields.when_to_use !== undefined || requireAll) {
    const w = needStr('when_to_use', { max: LIMITS.whenToUseMax });
    if (w === undefined) throw bad('when_to_use 必填（L3 索引的路由信号，缺了等于装了但模型不知道何时用）', { field: 'when_to_use' });
    if (w.length < LIMITS.whenToUseMin) {
      throw bad('when_to_use 长度 8..500', { field: 'when_to_use', min: LIMITS.whenToUseMin, max: LIMITS.whenToUseMax });
    }
    out.when_to_use = w;
  }
  if (fields.version !== undefined) {
    const v = needStr('version', { max: 40 });
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(v)) {
      throw bad('version 只允许 [A-Za-z0-9._-]（它进 capability_files 主键与目录侧账目）', { field: 'version', version: v });
    }
    out.version = v;
  }
  for (const k of ['author', 'license', 'description_md']) {
    if (fields[k] === undefined) continue;
    if (fields[k] === null) { out[k] = null; continue; }
    const s = needStr(k, { max: 20000 });
    if (s !== undefined) out[k] = s;
  }
  if (fields.tags !== undefined) {
    if (!Array.isArray(fields.tags) || fields.tags.length > 12 || fields.tags.some((t) => typeof t !== 'string' || !t || t.length > 40)) {
      throw bad('tags 必须是最多 12 条、每条 ≤ 40 字符的字符串数组', { field: 'tags', max: 12 });
    }
    out.tags = fields.tags;
  }
  if (fields.kind !== undefined) {
    if (!['skill', 'mcp'].includes(fields.kind)) throw bad("kind 只允许 'skill' | 'mcp'", { field: 'kind' });
    out.kind = fields.kind;
  }
  if (fields.state !== undefined) {
    if (!['draft', 'published', 'retired'].includes(fields.state)) {
      throw bad("state 只允许 'draft' | 'published' | 'retired'", { field: 'state' });
    }
    out.state = fields.state;
  }
  return out;
}

// ---------------------------------------------------------------------------
// §7 DTO
// ---------------------------------------------------------------------------

const ITEM_COLUMNS = `id, kind, slug, name, summary, when_to_use, description_md, version, author,
       tags, license, state, manifest, security_score, security_warnings,
       created_by, published_at, retired_at, created_at, updated_at`;

const asJson = (v, fallback) => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
  return v;
};

/** 管理端面的一条（列表与详情同源；详情多带 manifest / files / warnings）。 */
export function toAdminItemDto(row, extra = {}) {
  return {
    id: row.id,
    kind: row.kind,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    when_to_use: row.when_to_use,
    version: row.version,
    state: row.state,
    tags: row.tags ?? [],
    author: row.author ?? null,
    license: row.license ?? null,
    security_score: row.security_score,
    installs: row.installs === undefined ? undefined : Number(row.installs),
    created_at: row.created_at,
    published_at: row.published_at ?? null,
    retired_at: row.retired_at ?? null,
    updated_at: row.updated_at,
    ...extra,
  };
}

/** 用户面的一条：§7「每条带 installed / enabled / version」。 */
export function toUserItemDto(row) {
  return {
    slug: row.slug,
    kind: row.kind,
    name: row.name,
    summary: row.summary,
    when_to_use: row.when_to_use,
    version: row.version,
    tags: row.tags ?? [],
    author: row.author ?? null,
    license: row.license ?? null,
    security_score: row.security_score,
    installed: row.installed_version !== null && row.installed_version !== undefined,
    installed_version: row.installed_version ?? null,
    enabled: row.enabled === true,
    updated_at: row.updated_at,
  };
}

/** §5 的一条 `capabilities.json` 条目（materializer 的渲染输入，形状在 §5 的示例里钉死）。 */
export function toCapabilityIndexEntry(row) {
  const manifest = asJson(row.manifest, {});
  const slug = row.slug;
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const hasReadme = files.some((f) => f && f.path === README_FILE);
  return {
    // manifest.skill_id 与 slug 在发布时已交叉核对；取不到就退回 slug，绝不让 index 里出现 undefined id。
    id: typeof manifest.skill_id === 'string' && manifest.skill_id ? manifest.skill_id : slug,
    name: row.name,
    summary: row.summary ?? '',
    when_to_use: row.when_to_use ?? '',
    enabled: row.enabled === true,
    tools: (Array.isArray(manifest.tools) ? manifest.tools : []).map((t) => t?.name).filter((n) => typeof n === 'string'),
    readme: hasReadme ? `~/.erix/skills/${slug}/${README_FILE}` : null,
  };
}

// ---------------------------------------------------------------------------
// 磁盘侧（§4）：`<userSpaceRoot>/<fde>/home/.erix/skills/<slug>/`
// ---------------------------------------------------------------------------

/** 技能安装根目录（§4）。`fdeName` 必须过 `validateFdeName`：它是拼接进路径的第一段。 */
export function skillsRootDir(config, fdeName) {
  // `validateFdeName` 返回的是 `{ok}`，不抛异常：这一段名字来自 session，漂了就是平台自己的错（不是用户输入）。
  if (!validateFdeName(fdeName).ok) {
    throw new MarketError(`FDE 名不合法：${fdeName}`, {
      code: 'capability_install_failed', httpStatus: 500,
      details: { reason: 'invalid_fde_name', fde_name: fdeName },
    });
  }
  return path.join(config.userSpaceRoot, fdeName, 'home', '.erix', 'skills');
}

export function skillDirFor(config, fdeName, slug) {
  if (!SKILL_SLUG_RE.test(String(slug ?? ''))) throw new MarketError(`slug 不合法：${slug}`, { code: 'capability_not_found', httpStatus: 404, details: { slug } });
  return path.join(skillsRootDir(config, fdeName), slug);
}

/**
 * 落盘（§4）：先写 `<slug>.tmp-<rand>`，再把旧目录挪开、rename 就位、最后清旧目录。
 * 为什么不是「直接 rm -rf 再写」：rm 与写完之间崩了，用户看到的是「装了一半」；
 * 而 rename 是原子的，中间任意时刻目录里都是**完整的一版**（旧版或新版）。
 * 直接 rename 覆盖非空目录在 POSIX 会 ENOTEMPTY，所以旧目录必须先挪开（不是先删）。
 * @param {{userSpaceRoot: string, fdeUid?: number, fdeGid?: number}} config
 * @param {Array<{path: string, content: Buffer}>} files
 */
export function writeSkillDir({ config, fdeName, slug, files, log = console }) {
  const root = config.userSpaceRoot;
  const skillsRoot = skillsRootDir(config, fdeName);
  const target = skillDirFor(config, fdeName, slug);
  assertSafePath(root, target);
  ensureDirSafe(root, skillsRoot, { mode: 0o755, uid: config.fdeUid ?? null, gid: config.fdeGid ?? null, log });

  const tmp = path.join(skillsRoot, `${slug}.tmp-${randomHex(4)}`);
  assertSafePath(root, tmp);
  const written = [];
  try {
    for (const f of files) {
      const dest = path.join(tmp, f.path);
      assertSafePath(root, dest);
      // 包内路径已过 `..` / 绝对路径 / 空段校验，这里再走一次宿主边界：判据不同源，任一侧漏了都不越界。
      ensureDirSafe(root, path.dirname(dest), { mode: 0o755, uid: config.fdeUid ?? null, gid: config.fdeGid ?? null, log });
      fs.writeFileSync(dest, f.content, { mode: 0o644 });
      fs.chmodSync(dest, 0o644);   // writeFileSync 的 mode 受 umask 影响，显式 chmod 才是 §4 的 0644
      if (Number.isInteger(config.fdeUid) || Number.isInteger(config.fdeGid)) {
        try { fs.chownSync(dest, config.fdeUid ?? -1, config.fdeGid ?? -1); } catch { /* 非 root 测试环境：模式已对，属主留给生产 root */ }
      }
      written.push(dest);
    }
    let stashed = null;
    if (fs.existsSync(target)) {
      stashed = path.join(skillsRoot, `${slug}.old-${randomHex(4)}`);
      fs.renameSync(target, stashed);
    }
    fs.renameSync(tmp, target);
    if (stashed) {
      try { fs.rmSync(stashed, { recursive: true, force: true }); } catch (e) { log.warn?.(`[market] 清理旧版本目录失败（不阻断）：${stashed}: ${e.message}`); }
    }
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp 可能压根没建起来 */ }
    throw new MarketError(`技能落盘失败：${e.message}`, {
      code: 'capability_install_failed', httpStatus: 500,
      details: { reason: e.code || e.name || 'write_failed', slug, path: target },
    });
  }
  return { dir: target, files: written.length };
}

/** §4 卸载：只删 slug 目录本身。目录不存在 ⇒ 幂等成功（用户手删了也算已卸）。 */
export function removeSkillDir({ config, fdeName, slug, log = console }) {
  const target = skillDirFor(config, fdeName, slug);
  assertSafePath(config.userSpaceRoot, target);
  if (!fs.existsSync(target)) return { removed: false, dir: target };
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return { removed: true, dir: target };
  } catch (e) {
    throw new MarketError(`技能目录删除失败：${e.message}`, {
      code: 'capability_install_failed', httpStatus: 500,
      details: { reason: e.code || e.name || 'remove_failed', slug, path: target },
    });
  }
}

// ---------------------------------------------------------------------------
// 库侧
// ---------------------------------------------------------------------------

async function selectItemBySlug(pool, slug) {
  const r = await pool.query(`SELECT ${ITEM_COLUMNS} FROM capability_items WHERE slug = $1`, [slug]);
  return r.rows[0] ?? null;
}

async function selectInstall(pool, fdeId, slug) {
  const r = await pool.query(
    `SELECT inst.version, inst.enabled, inst.installed_at, inst.updated_at
       FROM fde_capability_installs inst JOIN capability_items i ON i.id = inst.item_id
      WHERE inst.fde_id = $1 AND i.slug = $2`, [fdeId, slug]);
  return r.rows[0] ?? null;
}

async function countEnabled(pool, fdeId) {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM fde_capability_installs WHERE fde_id = $1 AND enabled`, [fdeId]);
  return Number(r.rows[0]?.n ?? 0);
}

async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await work(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* 连接已断，回滚失败不改写原始错误 */ }
    throw e;
  } finally {
    client.release();
  }
}

/** 发布/改版的共同部分：把 bundle 写成 (item, version) 的不可变行。 */
async function insertFiles(pool, { itemId, version, files }) {
  for (const f of files) {
    await pool.query(
      `INSERT INTO capability_files (item_id, version, path, content, bytes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (item_id, version, path) DO UPDATE SET content = EXCLUDED.content, bytes = EXCLUDED.bytes`,
      [itemId, version, f.path, f.content, f.bytes]);
  }
}

/**
 * §7 `POST /api/admin/market/items`：新建条目 + bundle。
 * 默认落在 `draft`（§2：`state` 是发布态），显式 `state:"published"` 时一并写 `published_at`。
 * §9：`kind='mcp'` 今天没有消费者 ⇒ 409 `capability_kind_unsupported`。
 */
export async function publishItem({ pool, actorId = null, fields = {} }) {
  const meta = validateMetadata(fields, { requireAll: true });
  if (meta.kind === 'mcp') throw kindUnsupported(meta.slug);
  // bundle 不是元数据（它是字节），不进 `validateMetadata` 的白名单，从**原始体**里取。
  const bundle = fields.bundle;
  if (bundle === undefined || bundle === null) throw bad('bundle 必填（发布必须带包）', { field: 'bundle' });
  const { files, manifest, security } = validateBundle({
    slug: meta.slug, whenToUse: meta.when_to_use, bundle,
  });
  const state = meta.state ?? 'draft';
  const r = await pool.query(
    `INSERT INTO capability_items
       (kind, slug, name, summary, when_to_use, description_md, version, author, tags, license,
        state, manifest, security_score, security_warnings, created_by, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, CASE WHEN $11 = 'published' THEN now() ELSE NULL END)
     RETURNING ${ITEM_COLUMNS}`,
    [meta.kind ?? 'skill', meta.slug, meta.name, meta.summary, meta.when_to_use,
      meta.description_md ?? '', meta.version, meta.author ?? null, meta.tags ?? [], meta.license ?? null,
      state, JSON.stringify(manifest), security.score, JSON.stringify(security.warnings), actorId]);
  await insertFiles(pool, { itemId: r.rows[0].id, version: meta.version, files });
  return toAdminItemDto(r.rows[0]);
}

/**
 * §7 `PUT /api/admin/market/items/:id`：改元数据，或**带 bundle 出新版**。
 * 带 bundle 时 version 必须与当前不同（§2：包内容按 (item,version) 不可变；同版本覆盖会让已装
 * FDE 的磁盘与账面脱钩）。
 */
export async function updateItem({ pool, actorId = null, itemId, fields = {} }) {
  const cur = (await pool.query(`SELECT ${ITEM_COLUMNS} FROM capability_items WHERE id = $1`, [itemId])).rows[0];
  if (!cur) throw notFound(fields.slug ?? itemId);
  const meta = validateMetadata(fields);
  const next = { ...cur, ...meta };
  let manifest = asJson(cur.manifest, {});
  let security = { score: cur.security_score, warnings: asJson(cur.security_warnings, []) };

  if (fields.bundle !== undefined && fields.bundle !== null) {
    if (!meta.version) throw bad('带 bundle 时必须给新的 version', { field: 'version' });
    if (meta.version === cur.version) {
      throw bad('bundle 变了就必须换 version（包内容按 (item, version) 不可变）',
        { field: 'version', current: cur.version });
    }
    const v = validateBundle({ slug: next.slug, whenToUse: next.when_to_use, bundle: fields.bundle });
    ({ manifest, security } = v);
    await pool.query(
      `UPDATE capability_items
          SET name = $2, summary = $3, when_to_use = $4, description_md = $5, version = $6, author = $7,
              tags = $8, license = $9, manifest = $10::jsonb, security_score = $11,
              security_warnings = $12::jsonb, updated_at = now()
        WHERE id = $1`,
      [itemId, next.name, next.summary, next.when_to_use, next.description_md ?? '', next.version,
        next.author ?? null, next.tags ?? [], next.license ?? null, JSON.stringify(manifest),
        security.score, JSON.stringify(security.warnings)]);
    await insertFiles(pool, { itemId, version: next.version, files: v.files });
  } else {
    await pool.query(
      `UPDATE capability_items
          SET name = $2, summary = $3, when_to_use = $4, description_md = $5, version = $6, author = $7,
              tags = $8, license = $9, updated_at = now()
        WHERE id = $1`,
      [itemId, next.name, next.summary, next.when_to_use, next.description_md ?? '', next.version,
        next.author ?? null, next.tags ?? [], next.license ?? null]);
  }
  const row = (await pool.query(`SELECT ${ITEM_COLUMNS} FROM capability_items WHERE id = $1`, [itemId])).rows[0];
  return toAdminItemDto(row);
}

const kindUnsupported = (slug) => new MarketError('kind="mcp" 的条目本期待发布/安装（runner 侧 MCP 客户端是 P1）',
  { code: 'capability_kind_unsupported', httpStatus: 409, details: { slug } });
const notFound = (key) => new MarketError('条目不存在', { code: 'capability_not_found', httpStatus: 404, details: { item: key } });

/** §7 publish / retire：状态机只有 `draft → published → retired` 三个点，跳迁交给调用方决定语义。 */
export async function setItemState({ pool, itemId, state }) {
  if (!['draft', 'published', 'retired'].includes(state)) throw bad("state 只允许 draft/published/retired", { field: 'state' });
  if (state === 'published') {
    // 发布闸门：当前版本必须真的**有包**。否则装上去是个空目录，而 capabilities.json 会告诉模型「有」。
    const n = (await pool.query(
      `SELECT count(*)::int AS n FROM capability_files
        WHERE item_id = $1 AND version = (SELECT version FROM capability_items WHERE id = $1)`, [itemId])).rows[0]?.n ?? 0;
    if (Number(n) === 0) {
      throw new MarketError('当前版本没有包内容，不能发布',
        { code: 'capability_not_published', httpStatus: 409, details: { reason: 'no_files_for_current_version' } });
    }
  }
  const r = await pool.query(
    `UPDATE capability_items
        SET state = $2,
            published_at = CASE WHEN $2 = 'published' THEN COALESCE(published_at, now()) END,
            retired_at   = CASE WHEN $2 = 'retired'  THEN now() ELSE NULL END,
            updated_at   = now()
      WHERE id = $1
      RETURNING ${ITEM_COLUMNS}`, [itemId, state]);
  if (!r.rows[0]) throw notFound(itemId);
  return toAdminItemDto(r.rows[0]);
}

export async function listAdminItems({ pool, state = null } = {}) {
  const where = state ? 'WHERE i.state = $1' : '';
  const params = state ? [state] : [];
  const r = await pool.query(
    `SELECT i.*, (SELECT count(*) FROM fde_capability_installs f WHERE f.item_id = i.id) AS installs
       FROM capability_items i ${where} ORDER BY i.slug`, params);
  return { items: r.rows.map((row) => toAdminItemDto(row)) };
}

/** 管理端详情：不取 `content`（2 MiB 的包不该因为看一眼列表就进内存）。 */
export async function getAdminItem({ pool, itemId }) {
  const row = (await pool.query(`SELECT ${ITEM_COLUMNS} FROM capability_items WHERE id = $1`, [itemId])).rows[0];
  if (!row) throw notFound(itemId);
  const fs_ = (await pool.query(
    `SELECT path, bytes FROM capability_files WHERE item_id = $1 AND version = $2 ORDER BY path`,
    [itemId, row.version])).rows;
  return toAdminItemDto(row, {
    description_md: row.description_md ?? '',
    manifest: asJson(row.manifest, {}),
    security_warnings: asJson(row.security_warnings, []),
    files: fs_,
  });
}

export async function listUserItems({ pool, fdeId }) {
  const r = await pool.query(
    `SELECT i.*, inst.version AS installed_version, inst.enabled
       FROM capability_items i
       LEFT JOIN fde_capability_installs inst ON inst.item_id = i.id AND inst.fde_id = $1
      WHERE i.state = 'published'
      ORDER BY i.slug`, [fdeId]);
  return {
    items: r.rows.map(toUserItemDto),
    budget: { max_enabled: LIMITS.maxEnabledSkills, enabled_now: await countEnabled(pool, fdeId) },
  };
}

/** 用户面详情：列表 DTO + `description_md` + `readme_md`（§7「SKILL.md 正文」）+ 文件清单。
 * 取的是**已发布版本**的包；大字段只在这里出现（列表 DTO 故意不带，否则 50 条列表就是 100 MiB 内存）。 */
export async function getUserItem({ pool, fdeId, slug }) {
  const row = (await pool.query(
    `SELECT i.*, inst.version AS installed_version, inst.enabled
       FROM capability_items i
       LEFT JOIN fde_capability_installs inst ON inst.item_id = i.id AND inst.fde_id = $1
      WHERE i.slug = $2 AND i.state = 'published'`, [fdeId, slug])).rows[0];
  if (!row) throw notFound(slug);
  const rows = (await pool.query(
    `SELECT path, bytes, content FROM capability_files WHERE item_id = $1 AND version = $2 ORDER BY path`,
    [row.id, row.version])).rows;
  const readme = rows.find((f) => f.path === README_FILE);
  return {
    ...toUserItemDto(row),
    description_md: row.description_md ?? '',
    readme_md: readme ? Buffer.from(readme.content).toString('utf8') : null,
    manifest: asJson(row.manifest, {}),
    security_warnings: asJson(row.security_warnings, []),
    files: rows.map((f) => ({ path: f.path, bytes: f.bytes })),
  };
}

// ---------------------------------------------------------------------------
// §4 安装 / 卸载 / 启停
// ---------------------------------------------------------------------------

/**
 * §4 安装。三步的顺序是**判据顺序**，不是随意顺序：
 *   ① 条目存在 / kind 可消费 / state=published ⇒ 否则 404/409；
 *   ② 幂等：同版本且非 force ⇒ 直接返回，**一个字节都不写**（幂等必须无副作用，
 *      否则「用户手改过文件」与「页面多点了一下安装」会互相打架，§4 的重新安装按钮就是为此存在）；
 *   ③ 预算闸：只在「这次会让 enabled 计数 +1」时判（重复启停不该被预算挡住）。
 * 落盘成功后才在事务里落账 + 排一次物化（`capabilities.json` 要跟着变）。
 * @param {{pool: object, config: object, fde: {id: string, name: string}, slug: string,
 *          enabled?: boolean, force?: boolean}} p
 */
export async function installCapability({ pool, config, fde, slug, enabled, force = false, log = console }) {
  const item = await selectItemBySlug(pool, slug);
  if (!item) throw notFound(slug);
  if (item.kind === 'mcp') throw kindUnsupported(slug);
  if (item.state !== 'published') {
    throw new MarketError(`条目状态是 ${item.state}，只有 published 可安装`,
      { code: 'capability_not_published', httpStatus: 409, details: { slug, state: item.state } });
  }
  const existing = await selectInstall(pool, fde.id, slug);
  const wantEnabled = enabled === undefined ? (existing ? existing.enabled : true) : Boolean(enabled);
  if (existing && existing.version === item.version && !force) {
    return { changed: false, slug, version: item.version, enabled: existing.enabled, idempotent: true };
  }
  if (wantEnabled && !(existing && existing.enabled)) {
    const n = await countEnabled(pool, fde.id);
    if (n >= LIMITS.maxEnabledSkills) {
      throw new MarketError(`启用的技能已达上限 ${LIMITS.maxEnabledSkills} 个`,
        { code: 'capability_budget_exceeded', httpStatus: 409,
          details: { max_enabled: LIMITS.maxEnabledSkills, enabled_now: n } });
    }
  }
  const files = (await pool.query(
    `SELECT path, content, bytes FROM capability_files WHERE item_id = $1 AND version = $2 ORDER BY path`,
    [item.id, item.version])).rows.map((f) => ({ path: f.path, content: Buffer.from(f.content), bytes: f.bytes }));
  if (files.length === 0) {
    throw new MarketError(`版本 ${item.version} 在库里没有包内容`,
      { code: 'capability_not_published', httpStatus: 409, details: { slug, version: item.version, reason: 'no_files_for_current_version' } });
  }
  const dir = writeSkillDir({ config, fdeName: fde.name, slug, files, log });
  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO fde_capability_installs (fde_id, item_id, version, enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (fde_id, item_id) DO UPDATE
         SET version = EXCLUDED.version, enabled = EXCLUDED.enabled, updated_at = now()`,
      [fde.id, item.id, item.version, wantEnabled]);
    // 落账之后必须让物化面知道：`capabilities.json` 是市场与 runner 之间唯一的通道（§5）。
    await enqueueMaterializeChange(client, { fdeId: fde.id, op: 'upsert' });
  });
  return { changed: true, slug, version: item.version, enabled: wantEnabled, dir: dir.dir, files: files.length };
}

/** §4 卸载：先删目录再删账（顺序反了会留下「账没了、目录还在」且没人来清）。 */
export async function uninstallCapability({ pool, config, fde, slug, log = console }) {
  const item = await selectItemBySlug(pool, slug);
  if (!item) throw notFound(slug);
  const existing = await selectInstall(pool, fde.id, slug);
  const removed = removeSkillDir({ config, fdeName: fde.name, slug, log });
  await withTransaction(pool, async (client) => {
    await client.query('DELETE FROM fde_capability_installs WHERE fde_id = $1 AND item_id = $2', [fde.id, item.id]);
    if (existing) await enqueueMaterializeChange(client, { fdeId: fde.id, op: 'upsert' });
  });
  // 目录本来就不存在（用户手删过）也是 200：幂等的定义是「结果状态一致」，不是「一定做了动作」。
  return { changed: Boolean(existing) || removed.removed, slug, dir_removed: removed.removed };
}

/** §4 启停：只改 DB 一行，磁盘一律不动（停用后目录仍在，重新启用不必重下）。 */
export async function setCapabilityEnabled({ pool, fde, slug, enabled }) {
  if (typeof enabled !== 'boolean') throw bad('enabled 必须是布尔值', { field: 'enabled', actual: enabled });
  const item = await selectItemBySlug(pool, slug);
  if (!item) throw notFound(slug);
  const existing = await selectInstall(pool, fde.id, slug);
  if (!existing) {
    // 「没装却要点启用」不是「条目不存在」：资源是那条安装记录，但它对调用方来说就是「你还没装」。
    throw new MarketError('该条目尚未安装，无法启停',
      { code: 'capability_not_found', httpStatus: 404, details: { slug, reason: 'not_installed' } });
  }
  if (enabled && !existing.enabled) {
    const n = await countEnabled(pool, fde.id);
    if (n >= LIMITS.maxEnabledSkills) {
      throw new MarketError(`启用的技能已达上限 ${LIMITS.maxEnabledSkills} 个`,
        { code: 'capability_budget_exceeded', httpStatus: 409,
          details: { max_enabled: LIMITS.maxEnabledSkills, enabled_now: n } });
    }
  }
  const r = await withTransaction(pool, async (client) => {
    const up = await client.query(
      `UPDATE fde_capability_installs SET enabled = $3, updated_at = now()
        WHERE fde_id = $1 AND item_id = $2 RETURNING version, enabled`,
      [fde.id, item.id, enabled]);
    // 启停也要重新物化：`capabilities.json` 里的 `enabled` 是 runner 唯一的可见面（§5/§6）。
    await enqueueMaterializeChange(client, { fdeId: fde.id, op: 'upsert' });
    return up;
  });
  return { changed: existing.enabled !== enabled, slug, version: r.rows[0].version, enabled: r.rows[0].enabled };
}

// ---------------------------------------------------------------------------
// §5 物化侧读库（materializer 的 desired-state 输入）
// ---------------------------------------------------------------------------

/**
 * 一个 FDE 的 capabilities 条目（**含停用的**）。
 * 为什么不过滤 `enabled`：runner 要用停用项的 id 去填 `excludeSkillIds`（§6 L2）——
 * 磁盘目录还在，只在索引里消失拦不住装配。
 * 排序在 SQL 里做（`slug` 升序），渲染侧再兜一次：字节确定性的判据必须两处都站得住。
 */
export async function listCapabilitiesForFde(pool, fdeId) {
  const r = await pool.query(
    `SELECT i.slug, i.name, i.summary, i.when_to_use, i.manifest, inst.enabled
       FROM fde_capability_installs inst
       JOIN capability_items i ON i.id = inst.item_id
      WHERE inst.fde_id = $1 AND i.state = 'published'
      ORDER BY i.slug`, [fdeId]);
  return r.rows.map(toCapabilityIndexEntry);
}
