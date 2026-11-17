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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { assertSafePath, ensureDirSafe, randomHex } from './fsutil.js';
import { validateFdeName } from './projects.js';
import { enqueueMaterializeChange } from './outbox.js';
import { encryptValue, resolveSlots } from './secrets.js';

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
      // ⚠ 契约：`skipString` 返回**闭合引号的下标**，跨过闭合引号由这里的 `continue` + for 的 `i += 1` 负责。
      // 曾经 `skipString` 返回的是「闭合引号后一位」，两者叠加 = **多跳一个字符** ⇒ 紧跟字符串的 `]` / `}`
      // 不被计数（`required: ['msg']`、`enum: ['a','b']` 这种形状到处都有）⇒ 闭合点算错 ⇒ `tools: []`。
      // 回归锁：test/market.test.js MK-19（真机 e2e 实测：同一份包把 `['msg']` 改成 `['msg',]` 就发布成功）。
      i = skipString(src, i);
      continue;
    }
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { i = skipComment(src, i); continue; }
    if (c === open) depth += 1;
    else if (c === close) { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * 从**开引号下标**走到 `src[i]` 处引号的**闭合引号下标**（处理反斜杠转义）；未闭合返回 `src.length`。
 *
 * ⚠ 返回的是闭合引号**本身**的下标，不是它后面那个字符的下标——调用方 `findMatchingBracket` 写的是
 * `i = skipString(src, i); continue;`，「跨过闭合引号」这件事交给 for 的 `i += 1` 兑现。
 * 两边必须同源：任何一侧「+1」都会变成多跳一个字符，而差一位的后果是**吞掉紧跟字符串的 `]` / `}`**
 * （见 `findMatchingBracket` 里的 ⚠ 与 MK-19）。未闭合返回 `src.length`（越界 ⇒ 主循环自然结束）。
 */
function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j += 1) {
    const c = src[j];
    if (c === '\\') { j += 1; continue; }
    if (c === q) return j;
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
 * 取 `skill.id` 的锚点：§3 的导出形状是 `export const SKILL = { id, name, tools }`，
 * 兼容 `const skill = {` 与对象字面量里的 `skill: {`。
 * 只拿**第一个**锚点（一个 `skill.mjs` 只导出一个技能定义；多于一个是写错了）。
 */
const SKILL_OBJECT_RE = /\b(?:SKILL|skill)\s*[:=]\s*\{/;

/** 技能对象体的文本（`{` 与 `}` 之间）；认不出锚点返回 null（调用方退回全文扫描）。 */
function skillObjectSpan(source) {
  const m = SKILL_OBJECT_RE.exec(source);
  if (!m) return null;
  const open = source.indexOf('{', m.index);
  const close = findMatchingBracket(source, open);
  return close > open ? source.slice(open + 1, close) : source.slice(open + 1);
}

/**
 * 静态取 `{skillId, tools}`。
 * 为什么必须静态：§7 的发布体**没有** tools 字段，而 `capability_items.manifest` 与
 * `capabilities.json` 的 `tools[]` 都要用到它——平台不能为了拿清单就去 `import` 外部件（§1.1）。
 * 取不到就算发布失败：宁缺毋滥（工具面为空 = 装了也调不到任何东西）。
 *
 * `id` 的取值范围：**先限定到技能对象体内**再抓第一个 `id:`。旧写法直接对全文抓
 * `/\bid\s*:\s*(['"])…\1/`，会先命中排在 `SKILL` 前面的无关对象（`const CFG = { id: 'other' }`）、
 * 甚至注释里的 `id: xxx`，拿到错id 后 validateBundle 的「id 必须等于 slug」闸会把**合法包**拒掉。
 * 认不出锚点时退回全文扫描（兼容不守 §3 导出形状的源，至少不比旧行为差）。
 * 回归锁：test/market.test.js MK-20。
 * @returns {{skillId: string|null, tools: Array<{name: string, description: string}>}}
 */
export function extractSkillMeta(source) {
  const ID_RE = /\bid\s*:\s*(['"])([^'"]+)\1/;
  const span = skillObjectSpan(source);
  const idMatch = (span ? ID_RE.exec(span) : null) ?? ID_RE.exec(source);
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
  // §4.5 红色形状：这类包在 skill 里几乎必然是错的（常驻/监听/PTY/写持久目录）⇒ 硬拒，不是 warn。
  const shapeHits = scanPackageShape(files);
  if (shapeHits.length > 0) {
    throw new MarketError(
      `包里有 ${shapeHits.length} 处「常驻/服务」形状（应做成 MCP，见 docs/design/skill-authoring.md §5）`,
      { code: 'capability_package_shape', httpStatus: 400, details: { hits: shapeHits } });
  }
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

/** manifest.tools 的条数（列表 DTO 用）：取不到就算 0，绝不让列表里出现 undefined。 */
const toolCountOf = (manifest) => {
  const m = asJson(manifest, {});
  return Array.isArray(m?.tools) ? m.tools.length : 0;
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
    // `tool_count` 从 manifest 现算：它是列表上唯一能解释「这个技能会带来几个工具」的数字，
    // 而 manifest 已是它的唯一来源（不让调用方自己数 files[]，那是另一份真相）。
    tool_count: toolCountOf(row.manifest),
    installs: row.installs === undefined ? undefined : Number(row.installs),
    exposure: asJson(row.manifest, {}).exposure ?? null,
    reason: asJson(row.manifest, {}).reason ?? null,
    transport: asJson(row.manifest, {}).transport ?? null,
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
    tool_count: toolCountOf(row.manifest),
    // 真布尔（不是 't'/'f' 也不是 0/1）：前端按 `installed === true` 判，字符串会被判成未安装。
    installed: row.installed_version !== null && row.installed_version !== undefined,
    installed_version: row.installed_version ?? null,
    enabled: row.enabled === true,
    updated_at: row.updated_at,
    // §8.2：MCP 卡片要显示「为什么它是 MCP」与曝光档；skill 条目这三格为 null。
    exposure: asJson(row.manifest, {}).exposure ?? null,
    reason: asJson(row.manifest, {}).reason ?? null,
    transport: asJson(row.manifest, {}).transport ?? null,
    // §7.2：缺必填槽 ⇒ 前端禁用「启用」并提示等管理员配置（**不**告诉用户缺哪个槽）。
    secrets_ready: row.secrets_ready === undefined ? null : row.secrets_ready === true,
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

// ---------------------------------------------------------------------------
// 降权子进程（评审 MEDIUM/8）：落盘/删除**全部**交给 `market-write.js`
// ---------------------------------------------------------------------------

/**
 * ⚠ 安全边界在哪里（请把这句当真，别只当注释）：
 * `assertSafePath` **不是**安全边界——它是 check-then-use，而真正的写/删发生在检查之后；
 * `~/.erix/skills/` 的每一级祖先属主都是 FDE（uid 1000），所以 FDE 能在两者之间把某一级换成 symlink，
 * 让 root 身份的 portal 写到/删到用户空间外（`skills/<slug>` → `/etc/cron.d/x` ⇒ 容器逃逸到宿主 root）。
 * **安全来自降权**：所有会改盘的动作都在 `spawn(..., { uid: fdeUid, gid: fdeGid })` 的子进程里发生，
 * 于是竞态被赢下也只是「写到 uid 1000 本来就写得进的地方」。`assertSafePath` 仍然保留（纵深防御：
 * 它把「路径不合法」在父进程就拦住，不让子进程白跑一趟），但它只能让错误更早、更好看。
 * 残留面（已记录，未关）：`writeSkillDir` 里的 `ensureDirSafe`（建目录 + chmod/chown）仍在 root 手里，
 * 理由与后果写在那段注释里——它是「改属主/模式」面，不是「写内容/删内容」面。
 */
const DISK_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'market-write.js');
const DISK_SPAWN_TIMEOUT_MS = 30_000;
/** payload 上限（与 helper 同源）：超过它直接失败，不拿管道去试（§3 的包天花板是 2 MiB）。 */
const DISK_PAYLOAD_MAX_BYTES = 16 * 1024 * 1024;

/** 当前进程能不能 setuid 到别人（= 是不是 root）。非 root 传 uid/gid 会 EPERM，只能原样跑。 */
function canDropPrivileges() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** 真件：与 `spawnSync` 同签名（单测的可注入假件必须看到同样的 argv/opts，否则钉不住 uid/gid）。 */
const defaultDiskSpawn = (file, argv, opts) => spawnSync(file, argv, opts);

/**
 * 把一串磁盘指令交给降权子进程跑（一次 spawn 一串 = 一次安装的原子序列）。
 * @param {{config: object, ops: Array<object>, log?: object, spawnImpl?: Function}} p
 * @returns {{results: Array<object>}} helper 的逐条回执（`remove` 带 `existed`）
 * @throws {MarketError} `capability_install_failed` 500，`details.reason` 带子进程的退出码/信号/spawn errno
 */
function diskOps({ config, ops, log = console, spawnImpl = null }) {
  const payload = JSON.stringify({ ops });
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > DISK_PAYLOAD_MAX_BYTES) {
    throw new MarketError(`落盘指令体积超限：${bytes} > ${DISK_PAYLOAD_MAX_BYTES}`
      + '（不把 payload 塑进管道之前先拦，免得子进程白跑）', {
      code: 'capability_install_failed', httpStatus: 500,
      details: { reason: 'payload_too_large', bytes, max_bytes: DISK_PAYLOAD_MAX_BYTES },
    });
  }
  const spawn = spawnImpl ?? config?.spawnImpl ?? defaultDiskSpawn;
  const opts = {
    input: payload,            // payload 走 stdin：argv 单串超 128 KiB 就 E2BIG，而包上限是 2 MiB
    // encoding 缺省 null ⇒ stdout/stderr 是 Buffer（写 'buffer' 会直接 ERR_UNKNOWN_ENCODING）。
    maxBuffer: 1024 * 1024,    // 回执只有一行 JSON；stdout 肥大 = helper 写了不该写的东西，当场失败
    timeout: DISK_SPAWN_TIMEOUT_MS,
    env: {},                   // 子进程不需要环境（也不该拿到 DB 密码之类的）
    cwd: '/',                  // 不继承 cwd（父进程 cwd 被删过就 ENOENT）
  };
  if (canDropPrivileges()) {
    opts.uid = config?.fdeUid ?? 1000;
    opts.gid = config?.fdeGid ?? 1000;
  }
  const r = spawn(process.execPath, [DISK_HELPER], opts);
  const stderr = r?.stderr == null ? '' : String(r.stderr);
  if (r?.error) {
    throw new MarketError(`落盘子进程拉起失败：${r.error.message}`, {
      code: 'capability_install_failed', httpStatus: 500,
      details: { reason: `spawn_failed_${r.error.code || r.error.name || 'unknown'}`, dropped: Boolean(opts.uid) },
    });
  }
  if (r?.status !== 0) {
    // 非 0（或超时/信号）⇒ 就是失败，不强行「部分成功」。details.reason **带子进程的码**（要求）。
    const code = r?.signal ? `helper_signal_${r.signal}` : `helper_exit_${r?.status}`;
    const details = { reason: code, exit_code: r?.status ?? null, signal: r?.signal ?? null,
      dropped: Boolean(opts.uid), stderr: stderr.slice(0, 500) };
    try {
      const parsed = JSON.parse(stderr);
      if (parsed && parsed.ok === false) Object.assign(details, { child_error: parsed.error, child_code: parsed.code, child_op: parsed.op, child_path: parsed.path, child_index: parsed.index });
    } catch { /* stderr 不是 JSON（helper 自己炸了/没跑起来）：原文已在 details.stderr */ }
    throw new MarketError(`落盘子进程失败：${code}${stderr ? ` ${stderr.slice(0, 300)}` : ''}`, {
      code: 'capability_install_failed', httpStatus: 500, details,
    });
  }
  if (stderr) log.warn?.(`[market] 落盘子进程 stderr（退出 0，不阻断）：${stderr.slice(0, 300)}`);
  let parsed;
  try {
    parsed = JSON.parse(String(r.stdout ?? ''));
  } catch (e) {
    throw new MarketError(`落盘子进程回执不是 JSON：${String(r.stdout ?? '').slice(0, 200)}`, {
      code: 'capability_install_failed', httpStatus: 500, details: { reason: 'helper_reply_unparsable', child_error: e.message },
    });
  }
  if (!parsed || parsed.ok !== true || !Array.isArray(parsed.results)) {
    throw new MarketError('落盘子进程回执形状不对', {
      code: 'capability_install_failed', httpStatus: 500, details: { reason: 'helper_reply_malformed' },
    });
  }
  return parsed;
}

/**
 * 落盘（§4）：先写 `<slug>.tmp-<rand>`，再把旧目录挪开、rename 就位、最后清旧目录。
 * 为什么不是「直接 rm -rf 再写」：rm 与写完之间崩了，用户看到的是「装了一半」；
 * 而 rename 是原子的，中间任意时刻目录里都是**完整的一版**（旧版或新版）。
 * 直接 rename 覆盖非空目录在 POSIX 会 ENOTEMPTY，所以旧目录必须先挪开（不是先删）。
 *
 * 谁在写盘：**不是本进程**。下面只算路径、建目录、排指令，真正的 write/rename/remove 全部在
 * `diskOps()` 的降权子进程里发生（评审 MEDIUM/8）——原因见上面那段「安全边界」注释。
 * 父进程只留两类**不改盘**的动作：`existsSync`（决定要不要插一条 stash rename）与 `assertSafePath`。
 * 一次 spawn 装整串指令（写完 + 两次 rename），所以「一次安装 = 一次子进程」；
 * 旧目录的清理是 best-effort，单独一次 spawn（它失败不能拖垮刚成功的安装）。
 * ⚠ 本函数里出现 `fs.writeFileSync` / `fs.rmSync` 就是回归（单测 MK-21 钉了这条结构判据）。
 * @param {{userSpaceRoot: string, fdeUid?: number, fdeGid?: number, spawnImpl?: Function}} config
 * @param {Array<{path: string, content: Buffer}>} files
 */
export function writeSkillDir({ config, fdeName, slug, files, log = console, spawnImpl = null }) {
  const root = config.userSpaceRoot;
  const skillsRoot = skillsRootDir(config, fdeName);
  const target = skillDirFor(config, fdeName, slug);
  assertSafePath(root, target);
  ensureDirSafe(root, skillsRoot, { mode: 0o755, uid: config.fdeUid ?? null, gid: config.fdeGid ?? null, log });

  const tmp = path.join(skillsRoot, `${slug}.tmp-${randomHex(4)}`);
  assertSafePath(root, tmp);
  const ops = [];
  try {
    for (const f of files) {
      const dest = path.join(tmp, f.path);
      assertSafePath(root, dest);
      // 包内路径已过 `..` / 绝对路径 / 空段校验，这里再走一次宿主边界：判据不同源，任一侧漏了都不越界。
      // 目录仍由**父进程**建（本节唯一留在 root 手里的改盘动作）。为什么不搬进子进程：
      // 「全新 FDE、`.erix` 还不存在」时子进程（uid 1000）建不出 `home/.erix` 这一串——那需要它的
      // 祖先就可写，而平台侧（materializer/provisioner）的口径是 root 建目录 + chown 1000（§6.2）。
      // ⚠ 于是这里残留一个**更窄的** check-then-use 面：`ensureDirSafe` 的 chmod/chown 会跟随 symlink，
      //   若 FDE 在 `assertSafePath` 之后把某一级换成指向外部的 symlink，root 会去 chmod/chown 那个外部目录
      //   （改属主/模式，不是写内容，也不是提权；真正的写入与删除已经全在子进程里）。
      //   要关这扇门的条件是：先确认生产上 `home/.erix` 整串的属主允许 uid 1000 自己 mkdir。
      ensureDirSafe(root, path.dirname(dest), { mode: 0o755, uid: config.fdeUid ?? null, gid: config.fdeGid ?? null, log });
      // 内容走 payload（base64）而不是「先落临时文件再让子进程读」：后者会引入一条新的 check-then-use 路径。
      ops.push({ op: 'write', path: dest, contentBase64: Buffer.from(f.content).toString('base64'), mode: 0o644 });
    }
    let stashed = null;
    if (fs.existsSync(target)) {   // 只 stat，不动盘
      stashed = path.join(skillsRoot, `${slug}.old-${randomHex(4)}`);
      ops.push({ op: 'rename', from: target, to: stashed });
    }
    ops.push({ op: 'rename', from: tmp, to: target });
    diskOps({ config, ops, log, spawnImpl });
    if (stashed) {
      try {
        diskOps({ config, ops: [{ op: 'remove', path: stashed }], log, spawnImpl });
      } catch (e) { log.warn?.(`[market] 清理旧版本目录失败（不阻断）：${stashed}: ${e.message}`); }
    }
  } catch (e) {
    // tmp 清理同样是 best-effort（而且也得走子进程：本进程不该再亲手删盘）。
    try { diskOps({ config, ops: [{ op: 'remove', path: tmp }], log, spawnImpl }); } catch { /* tmp 可能压根没建起来 */ }
    if (e instanceof MarketError) throw e;   // diskOps 已经把退出码/spawn errno 封好了，不再重包一层
    throw new MarketError(`技能落盘失败：${e.message}`, {
      code: 'capability_install_failed', httpStatus: 500,
      details: { reason: e.code || e.name || 'write_failed', slug, path: target },
    });
  }
  return { dir: target, files: ops.filter((o) => o.op === 'write').length };
}

/**
 * §4 卸载：只删 slug 目录本身。目录不存在 ⇒ 幂等成功（用户手删了也算已卸）。
 * 删也是降权子进程做的（同上）；「删之前存不存在」由 helper 的回执回答，父进程不再自己 stat
 * （自己 stat 又是一次 check-then-use，虽然降权后已不是安全判据，但同源的事实更好用）。
 * ⚠ 本函数里出现 `fs.rmSync` 就是回归（单测 MK-21）。
 */
export function removeSkillDir({ config, fdeName, slug, log = console, spawnImpl = null }) {
  const target = skillDirFor(config, fdeName, slug);
  assertSafePath(config.userSpaceRoot, target);
  try {
    const { results } = diskOps({ config, ops: [{ op: 'remove', path: target }], log, spawnImpl });
    const existed = results.some((r) => r.op === 'remove' && r.existed === true);
    return { removed: existed, dir: target };
  } catch (e) {
    if (e instanceof MarketError) throw e;
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

async function countEnabled(pool, fdeId, kind = 'skill') {
  // §4：技能与 MCP 分开算预算——技能的账是「每轮铺多少 schema」，MCP 的账是「网关 + direct 工具」，
  // 合成一个计数器会让「装了 12 个技能」把 MCP 也一起锁死。
  const r = await pool.query(
    `SELECT count(*)::int AS n
       FROM fde_capability_installs inst JOIN capability_items i ON i.id = inst.item_id
      WHERE inst.fde_id = $1 AND inst.enabled AND i.kind = $2`, [fdeId, kind]);
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
  // §4 MCP 条目：没有包，只有配置（transport/command|url/exposure/lifecycle/reason/slots）。
  if (meta.kind === 'mcp') return publishMcpItem({ pool, actorId, meta, fields });
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

  // §4 MCP 条目：配置面编辑（没有 bundle）。transport 变了要 bump version（runner 侧的连接方式变了）。
  if (cur.kind === 'mcp') {
    const { manifest: mcpManifest, slots } = validateMcpFields(fields, { requireAll: false });
    const merged = { ...manifest, ...mcpManifest };
    if (fields.transport !== undefined && fields.transport !== asJson(cur.manifest, {}).transport
        && !meta.version) {
      throw bad('改 transport 必须同时 bump version', { field: 'version', current: cur.version });
    }
    return withTransaction(pool, async (client) => {
      const r = await client.query(
        `UPDATE capability_items
            SET name = $2, summary = $3, when_to_use = $4, description_md = $5, version = $6, author = $7,
                tags = $8, license = $9, manifest = $10::jsonb, updated_at = now()
          WHERE id = $1 RETURNING ${ITEM_COLUMNS}`,
        [itemId, next.name, next.summary, next.when_to_use, next.description_md ?? '', next.version,
          next.author ?? null, next.tags ?? [], next.license ?? null, JSON.stringify(merged)]);
      if (fields.slots !== undefined) await replaceParams(client, { itemId, slots });
      return toAdminItemDto(r.rows[0]);
    });
  }

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

/**
 * §7 的 URL 动词 → 状态机取值（`capability_items.state` 的域）。
 *
 * 为什么映射放在数据层导出而不是内联在 http.js：「动词」是 HTTP 契约面（§7 只开了 publish/retire
 * 两个口），「状态」是库里的列域（draft/published/retired）——两者词表不同、生命周期也不同
 * （加个 `/unretire` 只该动映射，不该动状态机）。把它做成可导出的单一真相，单测才能钉住它
 * （http 层测试需要登录态 + 整套 FakePool，为两个字符串不值得）。
 * 旧写法 `state: adminMarketStateMatch[2]` 把动词直接当状态使 ⇒ `state='publish'` 被下面
 * `setItemState` 的域校验拒掉 ⇒ 真机 publish/retire 一律 400 `validation_failed`（发布卡死）。
 * 回归锁：test/market.test.js MK-23。
 */
export const STATE_VERBS = Object.freeze({ publish: 'published', retire: 'retired' });

/** 动词 → 状态；未知动词抛 405（路由正则本已只放 publish|retire 进来，这里是纵深防御）。 */
export function stateForVerb(verb) {
  const state = STATE_VERBS[String(verb ?? '')];
  if (!state) {
    throw new MarketError(`未知的状态动词：${verb}`, {
      code: 'capability_state_verb_unknown', httpStatus: 405,
      details: { verb, allowed: Object.keys(STATE_VERBS) },
    });
  }
  return state;
}

/** §7 publish / retire：状态机只有 `draft → published → retired` 三个点，跳迁交给调用方决定语义。 */
export async function setItemState({ pool, itemId, state }) {
  if (!['draft', 'published', 'retired'].includes(state)) throw bad("state 只允许 draft/published/retired", { field: 'state' });
  if (state === 'published') {
    const cur = (await pool.query('SELECT kind, manifest FROM capability_items WHERE id = $1', [itemId])).rows[0];
    if (!cur) throw notFound(itemId);
    if (cur.kind === 'mcp') {
      // §4 MCP 的发布闸门不是「有包」而是「配置完整」：transport 必须有 command 或 url，
      // 否则 runner 拿到一条什么都起不来的配置（症状是「装了但 list 里什么都没有」）。
      const m = asJson(cur.manifest, {});
      const ok = (m.transport === 'stdio' && typeof m.command === 'string' && m.command !== '')
        || (m.transport === 'http' && typeof m.url === 'string' && m.url !== '');
      if (!ok) {
        throw new MarketError('MCP 条目缺 transport/command/url，不能发布',
          { code: 'capability_not_published', httpStatus: 409, details: { reason: 'mcp_config_incomplete' } });
      }
    } else {
      // 发布闸门：当前版本必须真的**有包**。否则装上去是个空目录，而 capabilities.json 会告诉模型「有」。
      const n = (await pool.query(
        `SELECT count(*)::int AS n FROM capability_files
          WHERE item_id = $1 AND version = (SELECT version FROM capability_items WHERE id = $1)`, [itemId])).rows[0]?.n ?? 0;
      if (Number(n) === 0) {
        throw new MarketError('当前版本没有包内容，不能发布',
          { code: 'capability_not_published', httpStatus: 409, details: { reason: 'no_files_for_current_version' } });
      }
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
  const manifest = asJson(row.manifest, {});
  return toAdminItemDto(row, {
    description_md: row.description_md ?? '',
    when_to_use: row.when_to_use,
    // `tools` 从 manifest 提到顶层：前端详情页直接渲这张表，不该去摸 manifest 的内部形状。
    tools: Array.isArray(manifest.tools) ? manifest.tools : [],
    manifest,
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
  // §7.2：MCP 条目要带 `secrets_ready`（缺必填槽 ⇒ 前端禁用启用）。一次查完，别 N+1。
  const mcpIds = r.rows.filter((row) => row.kind === 'mcp').map((row) => row.id);
  const missingByItem = await mcpSecretsReadyMap(pool, fdeId, mcpIds);
  return {
    items: r.rows.map((row) => toUserItemDto({
      ...row,
      secrets_ready: row.kind === 'mcp' ? !missingByItem.has(row.id) : null,
    })),
    budget: {
      max_enabled: LIMITS.maxEnabledSkills,
      enabled_now: await countEnabled(pool, fdeId, 'skill'),
      max_enabled_mcp: MCP_LIMITS.maxEnabledMcp,
      enabled_now_mcp: await countEnabled(pool, fdeId, 'mcp'),
    },
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
  const missingByItem = row.kind === 'mcp' ? await mcpSecretsReadyMap(pool, fdeId, [row.id]) : new Map();
  return {
    ...toUserItemDto({ ...row, secrets_ready: row.kind === 'mcp' ? !missingByItem.has(row.id) : null }),
    description_md: row.description_md ?? '',
    // 缺 SKILL.md ⇒ 空串（**不是 null**）：前端把它直接塞进 markdown 渲染器，null 会渲染成 "null"。
    readme_md: readme ? Buffer.from(readme.content).toString('utf8') : '',
    tools: Array.isArray(asJson(row.manifest, {}).tools) ? asJson(row.manifest, {}).tools : [],
    manifest: asJson(row.manifest, {}),
    security_warnings: asJson(row.security_warnings, []),
    files: rows.map((f) => ({ path: f.path, bytes: f.bytes })),
    // §8.1/§8.2：MCP 条目把槽位**声明**给用户看（「需要管理员配置凭据」的说明），但**没有值**。
    slots: row.kind === 'mcp'
      ? (await listSlots({ pool, itemId: row.id })).map((s) => ({
        name: s.name, kind: s.kind, inject: s.inject, required: s.required, description: s.description,
      }))
      : [],
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
  if (item.state !== 'published') {
    throw new MarketError(`条目状态是 ${item.state}，只有 published 可安装`,
      { code: 'capability_not_published', httpStatus: 409, details: { slug, state: item.state } });
  }
  const existing = await selectInstall(pool, fde.id, slug);
  const wantEnabled = enabled === undefined ? (existing ? existing.enabled : true) : Boolean(enabled);
  // 预算闸必须排在幂等判定**之前**：同版本但这次要求「从停用变启用」的请求，走的是下面那条
  // 只改账的分支——排在后面就会绕过预算（§4 的上限管的是 enabled 计数，与有没有写盘无关）。
  const isMcp = item.kind === 'mcp';
  const budget = isMcp
    ? { limit: MCP_LIMITS.maxEnabledMcp, kind: 'mcp' }
    : { limit: LIMITS.maxEnabledSkills, kind: 'skill' };
  if (wantEnabled && !(existing && existing.enabled)) {
    const n = await countEnabled(pool, fde.id, budget.kind);
    if (n >= budget.limit) {
      throw new MarketError(`启用的${isMcp ? ' MCP server' : '技能'}已达上限 ${budget.limit} 个`,
        { code: 'capability_budget_exceeded', httpStatus: 409,
          details: { max_enabled: budget.limit, enabled_now: n, kind: budget.kind } });
    }
  }
  // §4 MCP：**不落盘**（没有包内容），只落账 + 排物化。
  if (isMcp) {
    await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO fde_capability_installs (fde_id, item_id, version, enabled)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (fde_id, item_id) DO UPDATE
           SET version = EXCLUDED.version, enabled = EXCLUDED.enabled, updated_at = now()`,
        [fde.id, item.id, item.version, wantEnabled]);
      await enqueueMaterializeChange(client, { fdeId: fde.id, op: 'upsert' });
    });
    return { changed: true, slug, version: item.version, enabled: wantEnabled, disk: 'none' };
  }
  if (existing && existing.version === item.version && !force) {
    // 同版本 ⇒ **一个字节都不写盘**。但 `enabled` 是账本字段，请求里明确要变就得变：
    // 页面上那个开关点下去是「装好了但先关着」→「打开」，不能被幂等吞掉。
    if (wantEnabled !== existing.enabled) {
      await withTransaction(pool, async (client) => {
        await client.query(
          `UPDATE fde_capability_installs SET enabled = $3, updated_at = now()
            WHERE fde_id = $1 AND item_id = $2`, [fde.id, item.id, wantEnabled]);
        await enqueueMaterializeChange(client, { fdeId: fde.id, op: 'upsert' });
      });
      return { changed: true, slug, version: item.version, enabled: wantEnabled, disk: 'untouched' };
    }
    return { changed: false, slug, version: item.version, enabled: existing.enabled, idempotent: true };
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
  // MCP 条目没有磁盘产物：卸载 = 删一行账（§4）。
  const removed = item.kind === 'mcp' ? { removed: false } : removeSkillDir({ config, fdeName: fde.name, slug, log });
  await withTransaction(pool, async (client) => {
    await client.query('DELETE FROM fde_capability_installs WHERE fde_id = $1 AND item_id = $2', [fde.id, item.id]);
    if (existing) await enqueueMaterializeChange(client, { fdeId: fde.id, op: 'upsert' });
  });
  // 目录本来就不存在（用户手删过）也是 200：幂等的定义是「结果状态一致」，不是「一定做了动作」。
  return { changed: Boolean(existing) || removed.removed, slug, dir_removed: removed.removed };
}

/** §4 启停：只改 DB 一行，磁盘一律不动（停用后目录仍在，重新启用不必重下）。 */
export async function setCapabilityEnabled({ pool, fde, slug, enabled, config = null }) {
  if (typeof enabled !== 'boolean') throw bad('enabled 必须是布尔值', { field: 'enabled', actual: enabled });
  const item = await selectItemBySlug(pool, slug);
  if (!item) throw notFound(slug);
  const existing = await selectInstall(pool, fde.id, slug);
  if (!existing) {
    // 「没装却要点启用」不是「条目不存在」：资源是那条安装记录，但它对调用方来说就是「你还没装」。
    throw new MarketError('该条目尚未安装，无法启停',
      { code: 'capability_not_found', httpStatus: 404, details: { slug, reason: 'not_installed' } });
  }
  const isMcp = item.kind === 'mcp';
  const budget = isMcp
    ? { limit: MCP_LIMITS.maxEnabledMcp, kind: 'mcp' }
    : { limit: LIMITS.maxEnabledSkills, kind: 'skill' };
  if (enabled && !existing.enabled) {
    const n = await countEnabled(pool, fde.id, budget.kind);
    if (n >= budget.limit) {
      throw new MarketError(`启用的${isMcp ? ' MCP server' : '技能'}已达上限 ${budget.limit} 个`,
        { code: 'capability_budget_exceeded', httpStatus: 409,
          details: { max_enabled: budget.limit, enabled_now: n, kind: budget.kind } });
    }
    // §4：MCP 启用前必须所有必填槽有值（fail-closed，别让用户看到一个装好却连不上的工具）。
    if (isMcp) {
      const { missing } = await resolveSlots({ pool, itemId: item.id, fdeId: fde.id, key: config?.mcpSecretKey });
      if (missing.length > 0) {
        throw new MarketError('还有必填凭据没配置，无法启用（等管理员配置）', {
          code: 'capability_secret_missing', httpStatus: 409, details: { slug, missing } });
      }
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

// ---------------------------------------------------------------------------
// §4/§5 MCP 通道（issue #608）：槽位声明、准入、安装面、物化读面
// ---------------------------------------------------------------------------

/** §4.1：槽位名同时是 env / header 名，字符集必须对两者都安全。 */
export const SLOT_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MCP_TRANSPORTS = Object.freeze(['stdio', 'http']);
export const MCP_EXPOSURES = Object.freeze(['direct', 'deferred', 'hidden']);
export const MCP_LIFECYCLES = Object.freeze(['run', 'run-keep-alive']);
export const MCP_REASONS = Object.freeze(['stateful', 'tool_surface_gt_12', 'shared_quota', 'credential_boundary']);

/**
 * §4.1 保留名：照 touwaka `buildSkillEnvironment` 的思路——参数名不许把安全关键变量顶掉。
 * 前缀族（`ERIX_*` 等）用 `startsWith` 判，见 `isReservedSlotName`。
 */
export const RESERVED_SLOT_NAMES = Object.freeze([
  'PATH', 'HOME', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH', 'PYTHONSTARTUP',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
]);
const RESERVED_SLOT_PREFIXES = Object.freeze(['ERIX_', 'STATION_', 'SKILL_', 'MCP_']);

export function isReservedSlotName(name) {
  if (RESERVED_SLOT_NAMES.includes(name)) return true;
  return RESERVED_SLOT_PREFIXES.some((p) => name.startsWith(p));
}

/** §4.3 的硬数字。`maxDirectTools` 与技能预算分账：direct 工具每轮都付上下文。 */
export const MCP_LIMITS = Object.freeze({
  maxEnabledMcp: 12,
  maxDirectTools: 8,
  maxServerSchemaBytes: 64 * 1024,
  maxArgs: 32,
  maxTimeoutMs: 300_000,
  defaultTimeoutMs: 60_000,
  maxSlots: 16,
});

/**
 * §4.5 skill 包的**红色形状**：这些形状在包里几乎必然是错的（它们属于形态②/③的服务）。
 * 命中即 `400 capability_package_shape`——不是 warning：这类包一旦装上就是「没有生命周期管理的常驻进程」。
 * 判据是**源码文本**（平台不执行技能代码），所以只认能静态看见的写法。
 */
const PACKAGE_SHAPE_PATTERNS = Object.freeze([
  { code: 'detached_spawn', re: /\bdetached\s*:\s*true\b/g, note: '自建常驻进程（应做成 MCP，见 mcp-integration.md §2）' },
  { code: 'module_level_timer', re: /^(?!\s*(?:\/\/|\*)).*?\bsetInterval\s*\(/m, note: '模块级定时器会活过 run' },
  { code: 'listens', re: /\b(?:\.listen\s*\(|createServer\s*\()/g, note: '监听端口绕过 ingress，且没人回收' },
  { code: 'pty', re: /\bnode-pty\b|\bpty\.spawn\b/g, note: 'PTY 会话属于形态②/③' },
  { code: 'writes_persistent_dir', re: /(?:writeFileSync|writeFile|appendFileSync|mkdirSync|createWriteStream)\s*\([^)]*(?:~\/\.erix|\/var\/|\/srv\/)/g, note: '写包外持久目录：状态该由平台持有' },
  { code: 'declares_resident', re: /\bis_resident\b|\bresident\s*:\s*true\b/g, note: '声明常驻（P1 只支持形态①）' },
]);

/** @returns {Array<{code:string, path:string, note:string}>} */
export function scanPackageShape(files) {
  const hits = [];
  for (const f of files) {
    if (!f || !/\.(?:mjs|js|cjs|ts|py)$/.test(f.path)) continue;
    const src = f.content.toString('utf8');
    for (const p of PACKAGE_SHAPE_PATTERNS) {
      p.re.lastIndex = 0;
      if (p.re.test(src)) hits.push({ code: p.code, path: f.path, note: p.note });
    }
  }
  return hits;
}

/**
 * §4.2 组合矩阵：skill → context；mcp stdio → env；mcp http → header。
 * `secret` 另加一条：不许 `context`（那是技能进程内面）。
 * @param {Array<object>} slots 原始输入（未校验）
 * @param {{kind: 'skill'|'mcp', transport?: string}} ctx
 */
export function validateSlots(slots, { kind, transport }) {
  if (slots === undefined || slots === null) return [];
  if (!Array.isArray(slots)) throw bad('slots 必须是数组', { field: 'slots' });
  if (slots.length > MCP_LIMITS.maxSlots) {
    throw bad(`slots 条数超过 ${MCP_LIMITS.maxSlots}`, { field: 'slots', actual: slots.length });
  }
  const allowedInject = kind === 'skill' ? ['context'] : transport === 'stdio' ? ['env'] : ['header'];
  const out = [];
  const seen = new Set();
  for (const s of slots) {
    if (s === null || typeof s !== 'object') throw bad('slots[] 必须是对象', { field: 'slots[]' });
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    if (!SLOT_NAME_RE.test(name)) {
      throw new MarketError(`槽位名必须匹配 ${SLOT_NAME_RE.source}`, {
        code: 'capability_slot_invalid', httpStatus: 400, details: { field: 'slots.name', name },
      });
    }
    if (isReservedSlotName(name)) {
      throw new MarketError(`槽位名 "${name}" 是保留名（不许覆盖安全关键变量）`, {
        code: 'capability_slot_invalid', httpStatus: 400, details: { field: 'slots.name', name, reason: 'reserved' },
      });
    }
    if (seen.has(name)) {
      throw new MarketError(`槽位名重复：${name}`, {
        code: 'capability_slot_invalid', httpStatus: 400, details: { field: 'slots.name', name, reason: 'duplicate' },
      });
    }
    seen.add(name);
    const slotKind = s.kind;
    if (slotKind !== 'config' && slotKind !== 'secret') {
      throw new MarketError("槽位 kind 只允许 'config' | 'secret'", {
        code: 'capability_slot_invalid', httpStatus: 400, details: { field: 'slots.kind', name },
      });
    }
    const inject = s.inject;
    if (!allowedInject.includes(inject)) {
      throw new MarketError(`transport=${transport ?? '-'} / kind=${kind} 只允许 inject ∈ ${allowedInject.join('|')}`, {
        code: 'capability_slot_invalid', httpStatus: 400,
        details: { field: 'slots.inject', name, inject, allowed: allowedInject },
      });
    }
    if (slotKind === 'secret' && inject === 'context') {
      throw new MarketError('secret 槽不许 inject="context"（那等于把密钥交给技能代码）', {
        code: 'capability_slot_invalid', httpStatus: 400, details: { field: 'slots.inject', name },
      });
    }
    const description = typeof s.description === 'string' ? s.description.trim() : '';
    if (description === '' || description.length > 200) {
      throw new MarketError('槽位 description 必填且 ≤200 字符（管理员要知道这是什么）', {
        code: 'capability_slot_invalid', httpStatus: 400, details: { field: 'slots.description', name },
      });
    }
    out.push({ name, kind: slotKind, inject, required: s.required !== false, description });
  }
  return out;
}

/**
 * §4.1/§4.3/§4.4：MCP 条目的字段面校验。
 * 与 skill 的 `validateBundle` 互补：这里只校验**配置**，不碰包内容（MCP 没有包）。
 * @returns {{meta: object, manifest: object, slots: Array<object>}}
 */
export function validateMcpFields(fields, { requireAll = false } = {}) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw bad('请求体必须是 JSON 对象', { field: 'body' });
  const pick = (k) => fields[k];
  const need = (k, msg) => {
    const v = pick(k);
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      if (requireAll) throw bad(msg ?? `${k} 必填`, { field: k });
      return undefined;
    }
    return v;
  };
  const transport = need('transport', 'transport 必填（stdio | http）');
  if (transport !== undefined && !MCP_TRANSPORTS.includes(transport)) {
    throw bad("transport 只允许 'stdio' | 'http'", { field: 'transport', transport });
  }
  const exposure = pick('exposure') ?? 'deferred';
  if (!MCP_EXPOSURES.includes(exposure)) throw bad(`exposure 只允许 ${MCP_EXPOSURES.join('|')}`, { field: 'exposure', exposure });
  const lifecycle = pick('lifecycle') ?? 'run';
  if (!MCP_LIFECYCLES.includes(lifecycle)) throw bad(`lifecycle 只允许 ${MCP_LIFECYCLES.join('|')}`, { field: 'lifecycle', lifecycle });
  if (pick('resident') !== undefined && pick('resident') !== false) {
    throw new MarketError('resident 在 P1 只支持 false（形态②/③ 未实现）', {
      code: 'capability_kind_unsupported', httpStatus: 409, details: { field: 'resident', resident: pick('resident') },
    });
  }
  const reason = need('reason', 'MCP 条目必须给准入理由（stateful / tool_surface_gt_12 / shared_quota / credential_boundary）');
  if (reason !== undefined && !MCP_REASONS.includes(reason)) {
    throw new MarketError(`reason 只允许 ${MCP_REASONS.join('|')}`, {
      code: 'capability_reason_required', httpStatus: 400, details: { field: 'reason', reason },
    });
  }
  const timeoutRaw = pick('timeout_ms');
  let timeoutMs = MCP_LIMITS.defaultTimeoutMs;
  if (timeoutRaw !== undefined && timeoutRaw !== null) {
    if (!Number.isInteger(timeoutRaw) || timeoutRaw < 1000 || timeoutRaw > MCP_LIMITS.maxTimeoutMs) {
      throw bad(`timeout_ms 必须是 1000..${MCP_LIMITS.maxTimeoutMs} 的整数`, { field: 'timeout_ms', actual: timeoutRaw });
    }
    timeoutMs = timeoutRaw;
  }

  // transport 必须进 manifest（它是 runner 侧选传输的唯一依据；只放 meta 会让物化出来没有传输方式）
  const manifest = { transport, exposure, lifecycle, resident: false, timeout_ms: timeoutMs };
  if (reason !== undefined) manifest.reason = reason;
  if (transport === 'stdio') {
    const command = need('command', 'stdio 必须给 command');
    if (command !== undefined) {
      if (typeof command !== 'string' || /\s/.test(command.trim())) {
        throw bad('command 必须是**一个**可执行文件（不含空格；参数放 args）', { field: 'command', command });
      }
      manifest.command = command.trim();
    }
    const args = pick('args');
    if (args !== undefined) {
      if (!Array.isArray(args) || args.length > MCP_LIMITS.maxArgs || args.some((a) => typeof a !== 'string' || a.length > 500)) {
        throw bad(`args 必须是最多 ${MCP_LIMITS.maxArgs} 条、每条 ≤500 字符的字符串数组`, { field: 'args' });
      }
      manifest.args = args;
    }
    if (pick('url') !== undefined) throw bad('stdio 条目不许给 url', { field: 'url' });
  } else if (transport === 'http') {
    const url = need('url', 'http 必须给 url');
    if (url !== undefined) {
      let u;
      try { u = new URL(url); } catch { throw bad('url 不是合法 URL', { field: 'url', url }); }
      if (!['http:', 'https:'].includes(u.protocol)) {
        throw bad('url 只允许 http / https（file:/gopher:/data: 一律拒）', { field: 'url', protocol: u.protocol });
      }
      manifest.url = u.toString();
    }
    if (pick('command') !== undefined) throw bad('http 条目不许给 command', { field: 'command' });
  }
  const slots = validateSlots(pick('slots'), { kind: 'mcp', transport });
  return { meta: { kind: 'mcp', transport }, manifest, slots };
}

/** 用给定 slots 覆盖条目的槽位声明（发布/编辑时用；同一事务内调用）。 */
export async function replaceParams(client, { itemId, slots }) {
  await client.query('DELETE FROM capability_params WHERE item_id = $1', [itemId]);
  for (const s of slots ?? []) {
    await client.query(
      `INSERT INTO capability_params (item_id, name, kind, inject, required, description)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [itemId, s.name, s.kind, s.inject, s.required, s.description]);
  }
}

/** §8.1 管理面「凭据」区：只回元数据，**永不含值**（连密文都不出库）。 */
export async function listSlots({ pool, itemId }) {
  const r = await pool.query(
    `SELECT p.name, p.kind, p.inject, p.required, p.description,
            v.scope, v.fde_id, v.updated_at, v.updated_by,
            (v.id IS NOT NULL) AS has_value
       FROM capability_params p
       LEFT JOIN capability_param_values v
         ON v.item_id = p.item_id AND v.name = p.name AND v.scope = 'global'
      WHERE p.item_id = $1
      ORDER BY p.name`, [itemId]);
  const fdeRows = (await pool.query(
    `SELECT name, fde_id, updated_at FROM capability_param_values WHERE item_id = $1 AND scope = 'fde'`,
    [itemId])).rows;
  const fdeMap = new Map(fdeRows.map((r2) => [`${r2.name}:${r2.fde_id}`, r2]));
  return r.rows.map((row) => ({
    name: row.name,
    kind: row.kind,
    inject: row.inject,
    required: row.required === true,
    description: row.description ?? '',
    has_value: row.has_value === true,
    updated_at: row.has_value ? row.updated_at : null,
    updated_by: row.has_value ? (row.updated_by ?? null) : null,
    fde_overrides: [...fdeMap.entries()]
      .filter(([k]) => k.startsWith(`${row.name}:`))
      .map(([, v]) => ({ fde_id: v.fde_id, updated_at: v.updated_at })),
  }));
}

/**
 * §7.2 `PUT /api/admin/market/items/:id/secrets`：写值（`null` = 删除该值）。
 * 只写不读；值走 `encryptValue`（AAD 含 fde_id）。
 */
export async function setSlotValues({ pool, itemId, actorId = null, scope = 'global', fdeId = null, values = {}, key }) {
  if (scope !== 'global' && scope !== 'fde') throw bad("scope 只允许 'global' | 'fde'", { field: 'scope', scope });
  if (scope === 'fde' && (typeof fdeId !== 'string' || fdeId === '')) throw bad('scope=fde 时必须给 fde_id', { field: 'fde_id' });
  if (values === null || typeof values !== 'object' || Array.isArray(values)) throw bad('values 必须是对象', { field: 'values' });
  const declared = new Map((await pool.query(
    'SELECT name, kind FROM capability_params WHERE item_id = $1', [itemId])).rows.map((r) => [r.name, r.kind]));
  const writes = [];
  for (const [name, raw] of Object.entries(values)) {
    if (!declared.has(name)) {
      throw new MarketError(`条目没有声明槽位 "${name}"`, {
        code: 'capability_slot_invalid', httpStatus: 400, details: { field: 'values', name, reason: 'undeclared' },
      });
    }
    if (raw === null) { writes.push({ name, del: true }); continue; }
    if (typeof raw !== 'string') {
      throw new MarketError(`槽位 ${name} 的值必须是字符串或 null（null = 删除）`, {
        code: 'capability_slot_invalid', httpStatus: 400, details: { field: 'values', name },
      });
    }
    writes.push({ name, blob: encryptValue({ itemId, name, scope, fdeId, plaintext: raw, key }) });
  }
  await withTransaction(pool, async (client) => {
    for (const w of writes) {
      if (w.del) {
        await client.query(
          `DELETE FROM capability_param_values WHERE item_id = $1 AND name = $2 AND scope = $3
             AND ${scope === 'fde' ? 'fde_id = $4' : 'fde_id IS NULL'}`,
          scope === 'fde' ? [itemId, w.name, scope, fdeId] : [itemId, w.name, scope]);
      } else {
        await client.query(
          `INSERT INTO capability_param_values (item_id, name, scope, fde_id, value_encrypted, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT ${scope === 'fde'
            ? '(item_id, name, fde_id) WHERE scope = \'fde\''
            : '(item_id, name) WHERE scope = \'global\''}
           DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [itemId, w.name, scope, scope === 'fde' ? fdeId : null, w.blob, actorId]);
      }
    }
  });
  return { changed: writes.length, scope, fde_id: scope === 'fde' ? fdeId : null };
}

/**
 * §5.1 物化读面：一个 FDE 的 MCP server 清单（**只取 published && enabled && 非 hidden**）。
 * 返回的形状就是 `renderMcpJson` 的输入（槽位只带声明，**不带值**）。
 */
export async function listMcpServersForFde(pool, fdeId) {
  const r = await pool.query(
    `SELECT i.slug, i.name, i.summary, i.manifest
       FROM fde_capability_installs inst
       JOIN capability_items i ON i.id = inst.item_id
      WHERE inst.fde_id = $1 AND inst.enabled AND i.state = 'published' AND i.kind = 'mcp'
      ORDER BY i.slug`, [fdeId]);
  const out = [];
  for (const row of r.rows) {
    const m = asJson(row.manifest, {});
    if (m.exposure === 'hidden') continue;                 // §5.1：hidden 整条不物化
    const slots = (await pool.query(
      `SELECT name, inject, required FROM capability_params WHERE item_id = $1 ORDER BY name`,
      [(await pool.query('SELECT id FROM capability_items WHERE slug = $1', [row.slug])).rows[0]?.id])).rows;
    out.push({
      name: row.slug,
      description: row.summary ?? '',
      transport: m.transport,
      command: m.command ?? null,
      args: Array.isArray(m.args) ? m.args : [],
      url: m.url ?? null,
      exposure: m.exposure ?? 'deferred',
      lifecycle: m.lifecycle ?? 'run',
      timeout_ms: m.timeout_ms ?? MCP_LIMITS.defaultTimeoutMs,
      slots: slots.map((s) => ({ name: s.name, inject: s.inject, required: s.required === true })),
      tools: Array.isArray(m.tools_cache) ? m.tools_cache : [],
    });
  }
  return out;
}

/**
 * §6.1 内部通道的读面：给 agentd 的「已解析」清单（**含明文值**）。
 * 只给 `published && enabled && 非 hidden`；缺必填槽 ⇒ 进 `missing` 且**不进 servers**（fail-closed）。
 */
export async function resolveMcpServersForFde({ pool, fde, key }) {
  const servers = await listMcpServersForFde(pool, fde.id);
  const ids = new Map((await pool.query(
    `SELECT id, slug FROM capability_items WHERE slug = ANY($1::text[])`, [servers.map((s) => s.name)])).rows
    .map((r) => [r.slug, r.id]));
  const resolved = [];
  const missing = [];
  for (const s of servers) {
    const itemId = ids.get(s.name);
    const { values, missing: miss } = await resolveSlots({ pool, itemId, fdeId: fde.id, key });
    if (miss.length > 0) { missing.push({ name: s.name, slots: miss }); continue; }
    resolved.push({ ...s, values });
  }
  return { servers: resolved, missing };
}

/** 用户面 `secrets_ready`：按「必填槽是否有值」算（不解密，只看有没有行）。 */
export async function mcpSecretsReadyMap(pool, fdeId, itemIds) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) return new Map();
  const r = await pool.query(
    `SELECT p.item_id, p.name,
            EXISTS (SELECT 1 FROM capability_param_values v
                     WHERE v.item_id = p.item_id AND v.name = p.name
                       AND (v.scope = 'global' OR v.fde_id = $1)) AS has_value
       FROM capability_params p
      WHERE p.item_id = ANY($2::uuid[]) AND p.required`, [fdeId, itemIds]);
  const bad = new Map();
  for (const row of r.rows) {
    if (row.has_value === true) continue;
    const list = bad.get(row.item_id) ?? [];
    list.push(row.name);
    bad.set(row.item_id, list);
  }
  return bad;   // item_id → 缺的槽位名（空 = ready）
}

/** §6.6 元数据回填：runner 连上某个 server 后把 tools 报回来。 */
export async function recordToolsCache({ pool, slug, tools }) {
  if (!Array.isArray(tools) || tools.length > 200) throw bad('tools 必须是 ≤200 条的数组', { field: 'tools' });
  const clean = tools
    .filter((t) => t && typeof t.name === 'string' && t.name !== '')
    .map((t) => ({
      name: t.name.slice(0, 200),
      description: typeof t.description === 'string' ? t.description.slice(0, 500) : '',
      ...(t.inputSchema && typeof t.inputSchema === 'object' ? { inputSchema: t.inputSchema } : {}),
    }));
  const r = await pool.query(
    `UPDATE capability_items
        SET manifest = jsonb_set(jsonb_set(manifest, '{tools_cache}', $2::jsonb), '{tools_cache_at}', to_jsonb(now()::text)),
            updated_at = now()
      WHERE slug = $1 AND kind = 'mcp'
      RETURNING id, slug`, [slug, JSON.stringify(clean)]);
  if (!r.rows[0]) throw notFound(slug);
  return { slug, tools: clean.length };
}

/**
 * §4 MCP 条目的发布（`publishItem` 的 mcp 分支）：不写 `capability_files`，只写条目 + 槽位声明。
 * 为什么单独一个函数而不是塞进 `publishItem`：两条路径的**字段面完全不同**（一个吃 bundle，
 * 一个吃 transport/command/url/slots），塞在一起会让「bundle 必填」这类判据变成条件分支迷宫。
 */
async function publishMcpItem({ pool, actorId, meta, fields }) {
  const { manifest: mcpManifest, slots } = validateMcpFields(fields, { requireAll: true });
  const manifest = { ...mcpManifest };
  const state = meta.state ?? 'draft';
  return withTransaction(pool, async (client) => {
    // 参数顺序与 skill 那条**逐字相同**（kind 也走 $1）：测试里的 FakePool 是按位置认列的，
    // 两条 INSERT 用不同布局会让 fake 分叉成两套（fake 越像真 SQL，判据才越可信）。
    const r = await client.query(
      `INSERT INTO capability_items
         (kind, slug, name, summary, when_to_use, description_md, version, author, tags, license,
          state, manifest, security_score, security_warnings, created_by, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15,
               CASE WHEN $11 = 'published' THEN now() ELSE NULL END)
       RETURNING ${ITEM_COLUMNS}`,
      ['mcp', meta.slug, meta.name, meta.summary, meta.when_to_use, meta.description_md ?? '', meta.version,
        meta.author ?? null, meta.tags ?? [], meta.license ?? null, state, JSON.stringify(manifest),
        100, '[]', actorId]);
    const item = r.rows[0];
    await replaceParams(client, { itemId: item.id, slots });
    return toAdminItemDto(item);
  });
}
