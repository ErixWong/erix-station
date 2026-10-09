// station 文件工具层 = jail 路径边界 + 上游文件工具的薄装配。
//
// jail（本文件前半）：erix-agent 0.6.0 起库不再提供沙箱（ADR-009：「库不提供沙箱，牢笼由宿主
// 提供」——不变式 1「容器是信任边界」的落地）；移植自 erix-agent 0.3.5 的 src/tools/jail.js（上游
// #101 删除），**行为与导出逐字保留**：worker 无平台凭据、cwd（项目目录，D8 修订 2026-09-24 起）内
// 可写；越界/遮蔽/非可写路径抛 JailError。
//
// 文件工具（本文件后半，issue #228）：曾经的 0.3.5 fork executor（readFile/rg/tree/writeFile）已于
// issue #228 退役，改为装配上游 erix-agent 0.18.0 的 `createFileTools`（`createStationFileTools`）。
// jail 不是 fork 的一部分，它是宿主边界；fork 演进的终点见 AGENTS.md §8.9 与 docs/design/runner-integration.md。
import fs from 'node:fs';
import path from 'node:path';
import { createFileTools as createUpstreamFileTools } from 'erix-agent/tools';
import { throwIfAborted } from './abort.js';

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
//
// 语义与原 fork 的两处刻意偏离（交付报告的「语义变更清单」同步登记）：
//   * 越界/非可写/遮蔽路径不再抛 JailError，而是上游统一的「错误：…被宿主边界拒绝：…」文本结果
//     （jail 仍在内部抛，只是被谓词转成布尔；引擎把文本结果喂回模型，比抛异常更可恢复）；
//   * 遍历内的中止从「每 32 项让出 + 查中止」换成上游同口径 checkpoint（erix-agent 源码里
//     ABORT_CHECKPOINT_EVERY = 32），`lib/abort.js` 继续给自己与 shell 工具用。
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
