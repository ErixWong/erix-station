// station 自带 file 工具 + jail 路径边界（erix-agent 0.6.0 起库不再提供沙箱，ADR-009：
// 「库不提供沙箱，牢笼由宿主提供」——不变式 1「容器是信任边界」的落地）。
// 本文件移植自 erix-agent 0.3.5 的 src/tools/jail.js + src/tools/file-tools.js（上游 #101 删除），
// 工具 schema/executor 结构与旧 createFileTools 返回的 {executors, schemas} 完全对齐。
// 语义不变式：worker 无平台凭据、cwd（项目目录，D8 修订 2026-09-24 起）内可写；越界路径抛 JailError。
//
// ⚠ issue #228 现状说明：本文件下方 `createFileTools` 那份 0.3.5 fork executor（readFile/rg/tree/
// writeFile）正在被上游 erix-agent 0.18.0 的 `createFileTools` 取代（见文末 `createStationFileTools`
// 薄装配）。jail 与 JailError 不是 fork 的一部分（它们是宿主边界，ADR-009 下合法），逐字保留。
import fs from 'node:fs';
import path from 'node:path';
import { createFileTools as createUpstreamFileTools } from 'erix-agent/tools';
import { throwIfAborted, yieldToEventLoop } from './abort.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TREE_ENTRIES = 500;
// issue #211：rg / tree 是纯同步遍历——同步跑起来时 event loop 转不动，agentd 下行的
// MSG.ABORT 处理器根本执行不了，光检查 signal.aborted 是「永远为 false」的空检查。
// 所以每 N 次目录/文件操作让出一次事件循环（setImmediate）+ 查一次中止，把「不可中断的
// 整趟遍历」切成「最多 N 个条目不可中断」的有限块（单文件读本身仍不可抢，上限 1MiB）。
// 32 = 取响应性与开销的折中；无 signal 时完全不插入让出，非中止路径行为与开销零变化。
const ABORT_CHECKPOINT_EVERY = 32;

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== '..'
      && !path.isAbsolute(relative));
}

function realpathWithMissing(absolutePath) {
  let current = absolutePath;
  const missing = [];

  for (;;) {
    try {
      const existing = fs.realpathSync(current);
      return path.join(existing, ...missing.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export class JailError extends Error {
  constructor(code = 'jail_violation', message = code) {
    super(message);
    this.name = 'JailError';
    this.code = code;
  }
}

/**
 * 创建文件系统路径 jail（0.3.5 createJail 同名同语义移植）。
 * @param {{root:string, writable?:string[], maskedPaths?:string[]}} options
 * @returns {{root:string, resolve:(p:string)=>string, resolveForWrite:(p:string)=>string, assertReadable:(p:string)=>string}}
 *   root 为已 realpath 的绝对根路径，供调用方做「解析结果 == 根」判定。
 */
export function createJail({ root, writable = [], maskedPaths = [] }) {
  const rootPath = fs.realpathSync(path.resolve(root));

  const resolve = (value) => {
    const lexicalPath = path.resolve(rootPath, value);
    const resolvedPath = realpathWithMissing(lexicalPath);
    if (!isWithin(rootPath, resolvedPath)) {
      throw new JailError('path_escapes_root', `Path escapes jail root: ${value}`);
    }
    return resolvedPath;
  };

  const writableRoots = (Array.isArray(writable) ? writable : [])
    .map((entry) => resolve(entry));
  const maskedRoots = (Array.isArray(maskedPaths) ? maskedPaths : [])
    .map((entry) => resolve(entry));

  const resolveForWrite = (value) => {
    const resolvedPath = resolve(value);
    if (!writableRoots.some((writableRoot) => isWithin(writableRoot, resolvedPath))) {
      throw new JailError('path_not_writable', `Path is not writable: ${value}`);
    }
    return resolvedPath;
  };

  const assertReadable = (value) => {
    const resolvedPath = resolve(value);
    if (maskedRoots.some((maskedRoot) => isWithin(maskedRoot, resolvedPath))) {
      throw new JailError('path_masked', `Path is masked: ${value}`);
    }
    return resolvedPath;
  };

  return { root: rootPath, resolve, resolveForWrite, assertReadable };
}

function normalizeNonNegativeInteger(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function splitLines(text) {
  if (text === '') return [];
  const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function isMasked(error) {
  return error?.code === 'path_masked';
}

function readablePath(jail, value) {
  try {
    jail.assertReadable(value);
  } catch (error) {
    if (isMasked(error)) return null;
    throw error;
  }
  return jail.resolve(value);
}

function normalizeSchema(schema) {
  const result = { ...schema };
  if (result.inputSchema === undefined && result.input_schema !== undefined) {
    result.inputSchema = result.input_schema;
    delete result.input_schema;
  }
  return result;
}

const schemas = [
  {
    name: 'readFile',
    description: 'Read a text file by line range.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'rg',
    description: 'Recursively search text files with a regular expression.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        maxResults: { type: 'integer' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'tree',
    description: 'List a directory tree.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        depth: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'writeFile',
    description: 'Write UTF-8 text inside a writable jail subtree.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
].map(normalizeSchema);

/**
 * 创建受 jail 约束的文件系统工具（0.3.5 createFileTools 同名同语义移植）。
 * @param {{resolve:Function, resolveForWrite:Function, assertReadable:Function}} jail
 * @returns {{schemas:object[], executors:Record<string, Function>}}
 */
export function createFileTools(jail) {
  // issue #211：四个 executor 都接第二参 context（引擎经 registry.js:143 executor(input, context)
  // 原样下传，run 的 abort signal 由 worker.js executeTool 包装注入 context.signal）。
  // 语义分级（代价已写进 issue 报告）：
  //   - rg / tree：可真中断——遍历内每 ABORT_CHECKPOINT_EVERY 次操作让出 + 检查，抛 AbortError。
  //   - readFile / writeFile：单次同步 syscall，syscall 本身不可抢，只能在入口检查（已中止则
  //     不开工）；在途那次读/写跑完才可能观察到中止（单文件 ≤ MAX_FILE_BYTES，毫秒量级）。
  // 不传 context / 未中止时，四个工具行为与修前逐字一致。
  async function readFile({ path: filePath, offset = 0, limit = 200 }, context = {}) {
    throwIfAborted(context?.signal);
    jail.assertReadable(filePath);
    const resolvedPath = jail.resolve(filePath);
    const text = fs.readFileSync(resolvedPath, 'utf8');
    const lines = splitLines(text);
    const start = normalizeNonNegativeInteger(offset, 0);
    const count = normalizeNonNegativeInteger(limit, 200);
    const selected = lines
      .slice(start, start + count)
      .map((line, index) => `${start + index + 1}: ${line}`);

    if (start + count < lines.length) {
      selected.push(`[共 ${lines.length} 行，offset=${start + count} 继续]`);
    }
    return selected.join('\n');
  }

  async function rg({ pattern, path: searchPath = '.', maxResults = 50 }, context = {}) {
    const signal = context?.signal;
    throwIfAborted(signal);
    // 无 signal = 不插让出点（保持旧同步行为与吞吐）。
    const interruptible = signal != null;
    let checkpointOps = 0;
    const checkpoint = async () => {
      if (!interruptible) return;
      checkpointOps += 1;
      if (checkpointOps % ABORT_CHECKPOINT_EVERY !== 0) return;
      await yieldToEventLoop();
      throwIfAborted(signal);
    };
    const expression = new RegExp(String(pattern));
    const resultLimit = normalizeNonNegativeInteger(maxResults, 50);
    const resolvedSearchPath = readablePath(jail, searchPath);
    if (resolvedSearchPath === null) return '';
    const displayBase = jail.resolve('.');
    const results = [];
    const visitedDirectories = new Set();

    const displayName = (filePath) => {
      const relative = path.relative(displayBase, filePath);
      return (relative || path.basename(filePath)).split(path.sep).join('/');
    };

    const searchFile = (filePath, stat) => {
      if (results.length >= resultLimit || stat.size > MAX_FILE_BYTES) return;
      const bytes = fs.readFileSync(filePath);
      if (bytes.includes(0)) return;
      const lines = splitLines(bytes.toString('utf8'));
      for (let index = 0; index < lines.length; index += 1) {
        if (!expression.test(lines[index])) continue;
        results.push(`${displayName(filePath)}:${index + 1}:${lines[index]}`);
        if (results.length >= resultLimit) return;
      }
    };

    const visit = async (lexicalPath) => {
      if (results.length >= resultLimit) return;
      await checkpoint();
      const currentPath = readablePath(jail, lexicalPath);
      if (currentPath === null) return;
      const stat = fs.statSync(currentPath);
      if (stat.isFile()) {
        searchFile(currentPath, stat);
        return;
      }
      if (!stat.isDirectory() || visitedDirectories.has(currentPath)) return;
      visitedDirectories.add(currentPath);

      const entries = fs.readdirSync(currentPath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (results.length >= resultLimit) return;
        await visit(path.join(currentPath, entry.name));
      }
    };

    await visit(resolvedSearchPath);
    return results.join('\n');
  }

  async function tree({ path: treePath = '.', depth = 3 }, context = {}) {
    const signal = context?.signal;
    throwIfAborted(signal);
    const interruptible = signal != null;
    let checkpointOps = 0;
    const checkpoint = async () => {
      if (!interruptible) return;
      checkpointOps += 1;
      if (checkpointOps % ABORT_CHECKPOINT_EVERY !== 0) return;
      await yieldToEventLoop();
      throwIfAborted(signal);
    };
    const resolvedTreePath = readablePath(jail, treePath);
    if (resolvedTreePath === null) return '';
    const maxDepth = normalizeNonNegativeInteger(depth, 3);
    const rootStat = fs.statSync(resolvedTreePath);
    // 根标签固定 './'：''/'./' 此前会显示 worktree 的 basename，被模型误读为同名子目录 → ENOENT 循环（issue #64 排查发现）
    const rootLabel = resolvedTreePath === jail.root ? './' : path.basename(resolvedTreePath);
    const lines = [rootStat.isDirectory() && !rootLabel.endsWith('/') ? rootLabel + '/' : rootLabel];
    const visitedDirectories = new Set();
    let entries = 1;

    const visit = async (currentPath, currentDepth) => {
      if (entries >= MAX_TREE_ENTRIES || currentDepth >= maxDepth) return;
      await checkpoint();
      if (!fs.statSync(currentPath).isDirectory()) return;
      if (visitedDirectories.has(currentPath)) return;
      visitedDirectories.add(currentPath);

      const children = fs.readdirSync(currentPath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (entries >= MAX_TREE_ENTRIES) return;
        await checkpoint(); // 宽目录（单目录上千条目）也要能中断：checkpoint 落在条目循环里，不只落在目录递归上
        const childPath = path.join(currentPath, child.name);
        const readable = readablePath(jail, childPath);
        if (readable === null) continue;
        const childStat = fs.statSync(readable);
        lines.push(`${'  '.repeat(currentDepth + 1)}${child.name}${childStat.isDirectory() ? '/' : ''}`);
        entries += 1;
        if (childStat.isDirectory()) await visit(readable, currentDepth + 1);
      }
    };

    if (rootStat.isDirectory()) {
      await visit(resolvedTreePath, 0);
    }
    return lines.join('\n');
  }

  async function writeFile({ path: filePath, content }, context = {}) {
    throwIfAborted(context?.signal);
    if (typeof content !== 'string') {
      throw new TypeError('writeFile content must be a string');
    }
    const target = jail.resolveForWrite(filePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const finalTarget = jail.resolveForWrite(filePath);
    fs.writeFileSync(finalTarget, content, 'utf8');
    return Buffer.byteLength(content, 'utf8');
  }

  return {
    schemas: schemas.map((schema) => structuredClone(schema)),
    executors: { readFile, rg, tree, writeFile },
  };
}

// ---------------------------------------------------------------------------
// issue #228：上游 erix-agent 文件工具的薄装配（station 侧唯一的文件工具实现方向）
//
// 为什么要装配而不是继续在 fork 上演进（工单 D3 §1）：0.18.0 已把 fork 的两个已知缺陷面在上游
// 实现好——readFile 有界读（默认 max_bytes=262144 + 流式行窗口，82.9MB 取第 100 万行 349ms）与
// 搜索的无效正则返回错误文本（fork 的 `new RegExp(...)` 会抛）；遍历类工具还带真中断（每 32 项
// 让出 + 查中止）。fork 侧不再演进，只保留 jail。
//
// 三条不可让的接线（工单 D3 §2/§3）：
//   1. **谓词相与，不是替换**：上游 allowRead/allowWrite 收到的必须是「调用方谓词 ∧ jail 谓词
//      ∧ ¬遮蔽」，替换会让宿主注入的谓词静默失效（上游契约有用例钉这条）。
//   2. **maskedPaths 继续生效**：密钥文件遮蔽是 station 的安全能力，上游契约不覆盖它，必须自己
//      钉测试（runner/test/file-tools-contract.test.js）。遮蔽口径与 createJail.assertReadable
//      逐字对齐：只挡读，不挡写。
//   3. **工具面白名单**：station 只暴露 5 个（readFile/searchText/tree/edit/writeFile），不吃上游
//      两个弃用别名 rg/grep（§3.1）；白名单只列名字，工具清单本身仍取自上游 definitions，不复制。
// ---------------------------------------------------------------------------

/** station 注册面暴露的文件工具名（工单 D3 §3.1：不含弃用别名 rg / grep）。 */
export const STATION_FILE_TOOL_NAMES = Object.freeze([
  'readFile', 'searchText', 'tree', 'edit', 'writeFile',
]);

/** 结构化调用形态（引擎 run-snapshot-executor 传 {id,name,input,context,signal}）。 */
function isStructuredCall(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof value.name === 'string';
}

/** 遮蔽前缀表：相对路径按 root 解析，能 realpath 就 realpath（防用 symlink 绕过遮蔽）。 */
function maskedPrefixes(root, maskedPaths) {
  return (Array.isArray(maskedPaths) ? maskedPaths : [])
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
    .map((entry) => {
      const lexical = path.resolve(root, entry);
      try {
        return fs.realpathSync(lexical);
      } catch {
        return lexical;
      }
    });
}

/**
 * 装配上游 `erix-agent/tools` 的 createFileTools，边界走本站 jail（issue #228）。
 *
 * @param {object} [options]
 * @param {{root:string, assertReadable:Function, resolveForWrite:Function}} [options.jail]
 *   宿主边界（createJail 的返回值）。jail.root 是 realpath 过的根，未显式传 cwd 时用它做上游的解析根。
 * @param {string} [options.cwd] 上游相对路径解析根；缺省依次取 jail.root / process.cwd()
 * @param {string[]} [options.maskedPaths] 密钥遮蔽前缀（相对 cwd 或绝对）；只挡读，不挡写
 * @param {(absolutePath:string)=>boolean} [options.allowRead] 调用方读谓词（绝对路径），与 jail 谓词**相与**
 * @param {(absolutePath:string)=>boolean} [options.allowWrite] 调用方写谓词（绝对路径），与 jail 谓词**相与**
 * @returns {{
 *   definitions: object[],   // 上游全量 definitions（含 rg/grep 别名）——executeTool 能执行的全集
 *   schemas: object[],       // station 注册面（STATION_FILE_TOOL_NAMES 白名单过滤后的 5 个）
 *   executors: Record<string, Function>, // 与 schemas 同集的 name→executor 映射，直接喂 createToolRegistry
 *   executeTool: Function,   // (name,input,context) 与 {name,input,context,signal} 两种形态
 *   exposedToolNames: readonly string[],
 * }}
 */
export function createStationFileTools({ jail, cwd, maskedPaths = [], allowRead, allowWrite } = {}) {
  const root = path.resolve(cwd ?? jail?.root ?? process.cwd());
  const hostAllowRead = typeof allowRead === 'function' ? allowRead : () => true;
  const hostAllowWrite = typeof allowWrite === 'function' ? allowWrite : () => true;
  const maskedRoots = maskedPrefixes(root, maskedPaths);

  const withinMasked = (target) => maskedRoots.some((maskedRoot) => isWithin(maskedRoot, target));
  // jail 的越界/非可写/遮蔽都是 JailError → 谓词返回 false（上游据此回「错误：…被宿主边界拒绝」文本，
  // 不再像 fork 那样抛）。非 JailError（例如 realpath 撞 EACCES）照旧上抛，不静默吞。
  const jailAllows = (resolver, target) => {
    if (typeof resolver !== 'function') return true;
    try {
      resolver(target);
      return true;
    } catch (error) {
      if (error instanceof JailError) return false;
      throw error;
    }
  };

  const canRead = (target) => Boolean(hostAllowRead(target))
    && !withinMasked(target)
    && jailAllows(jail?.assertReadable, target);
  const canWrite = (target) => Boolean(hostAllowWrite(target))
    && jailAllows(jail?.resolveForWrite, target);

  const upstream = createUpstreamFileTools({ cwd: root, allowRead: canRead, allowWrite: canWrite });

  const upstreamByName = new Map(upstream.definitions.map((definition) => [definition.name, definition]));
  const missing = STATION_FILE_TOOL_NAMES.filter((name) => !upstreamByName.has(name));
  if (missing.length > 0) {
    // 上游把白名单里的工具改名/删掉时，宁可在装配期炸掉，也不要静默少暴露一个工具跑半天才发现。
    throw new Error(`上游 erix-agent definitions 缺少 station 需要暴露的工具：${missing.join(', ')}`);
  }

  const executeTool = async (firstArg, input, context) => {
    // issue #211 的「已中止就别开工」在上游只覆盖遍历类工具（tree / searchText 走 checkpoint）；
    // readFile / writeFile / edit 是单次同步 syscall、上游不看 signal。装配层在入口统一补一次检查，
    // 保住 station 既有保证。遍历内的**真中断**（同步跑起来时 MSG.ABORT 处理器才有机会执行）由上游
    // checkpoint 负责：每 32 项让出事件循环 + 查中止，比 fork 的入口检查更强。
    const signal = isStructuredCall(firstArg)
      ? (firstArg.signal ?? firstArg.context?.signal)
      : context?.signal;
    throwIfAborted(signal);
    return isStructuredCall(firstArg)
      ? upstream.executeTool(firstArg)
      : upstream.executeTool(firstArg, input, context);
  };

  return {
    definitions: upstream.definitions,
    schemas: STATION_FILE_TOOL_NAMES.map((name) => structuredClone(upstreamByName.get(name))),
    executors: Object.fromEntries(STATION_FILE_TOOL_NAMES.map((name) => [
      name,
      async (toolInput, context) => executeTool(name, toolInput, context),
    ])),
    executeTool,
    exposedToolNames: STATION_FILE_TOOL_NAMES,
  };
}
