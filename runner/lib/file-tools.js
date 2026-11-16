// station 文件工具层 = jail 路径边界 + 上游文件工具的薄装配。
//
// jail（本文件前半）：erix-agent 0.6.0 起库不再提供沙箱（ADR-009：「库不提供沙箱，牢笼由宿主
// 提供」——不变式 1「容器是信任边界」的落地）；移植自 erix-agent 0.3.5 的 src/tools/jail.js（上游
// #101 删除），**行为与导出逐字保留**：worker 无平台凭据、cwd（项目目录，D8 修订 2026-09-24 起）内
// 可写；越界/遮蔽/非可写路径抛 JailError。
//
// ⚠ station 的两处扩展（issue #231 与 #259，**互不相干、都在本文件**）：
// 【#231】`maskedPaths` 的条目从「只有前缀」扩成「前缀 ∪ 名字模式」（含 `*`/`?` 的条目按相对根的
//   **路径段**匹配，见 `splitMaskedEntries`）。**前缀条目语义逐字未动**，0.3.5 移植面也没动。
//   为什么必须扩：station 的遮蔽口径是 `.env*` / `*.pem` / `id_*` 这类**名字模式**，前缀表达不了。
//   不对称（只挡文件工具、不挡 shell ⇒ **不是安全加固**）见 `STATION_MASKED_PATHS` 注记与
//   `docs/design/runner-integration.md` §17.1。
// 【#259】**只读例外**（`readExceptions`）：家目录里平台自己生成的文档（`~/AGENTS.md`、`~/.erix/*`）
//   在文件工具里从「二等公民」变成一等公民。**写边界与 0.3.5 逐字相同**（仍只认项目根），例外也不由
//   模型传参决定，而是装配方的平台侧白名单。带测试：`runner/test/file-tools.test.js` 的 #259 一节
//   + `file-tools-contract.test.js` 的谓词相与面。
// 【两处相交的地方】**遮蔽条目的解析走读侧口径**（见下方 `maskedRoots`）：#259 之后「在例外里遮蔽一个
//   密钥子目录」成为**有生产者的用法**；名字模式那一路仍是词法 + realpath **双向**比（建个软链拆不掉遮蔽）。
//
// 文件工具（本文件后半，issue #228）：曾经的 0.3.5 fork executor（readFile/rg/tree/writeFile）已于
// issue #228 退役，改为装配上游 erix-agent 0.18.0 的 `createFileTools`（`createStationFileTools`）。
// jail 不是 fork 的一部分，它是宿主边界；fork 演进的终点见 AGENTS.md §8.9 与 docs/design/runner-integration.md。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileTools as createUpstreamFileTools, classifyFileToolResult } from 'erix-agent/tools';
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

/** 含 `*` / `?` 的遮蔽条目是**名字模式**；其余是**前缀**（一个目录或一个文件，含其子树）。 */
function isMaskPattern(entry) {
  return /[*?]/u.test(entry);
}

/** glob → RegExp：`*` / `?` 只在**一段内**匹配（不跨 `/`），其它字符逐字（`.env*` 不会把 `xenv` 算进来）。 */
function maskPatternToRegExp(pattern) {
  let source = '^';
  for (const char of pattern) {
    if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`${source}$`, 'u');
}

/**
 * 把 maskedPaths 拆成前缀条目与名字模式两组。
 * 非字符串 / 空串条目**丢掉而不是炸装配**：遮蔽是防御性的额外闸，一条脏条目不该让 run 起不来。
 */
function splitMaskedEntries(maskedPaths) {
  const prefixes = [];
  const patterns = [];
  for (const entry of Array.isArray(maskedPaths) ? maskedPaths : []) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (isMaskPattern(entry)) patterns.push(maskPatternToRegExp(entry));
    else prefixes.push(entry);
  }
  return { prefixes, patterns };
}

/** 目标相对 mask 根的路径段（根外 / 就是根本身 → 空数组，模式自然不命中）。 */
function relativeSegments(root, target) {
  const relative = path.relative(root, target);
  if (relative === '' || path.isAbsolute(relative)) return [];
  return relative.split(path.sep).filter((segment) => segment !== '');
}

/**
 * 名字模式命中判定。`*` 不跨 `/` ⇒ 不带斜杠的模式按**每一段**匹配（`*.pem` 命中任意深度的 `server.pem`，
 * 也命中名为 `certs.pem` 的目录整棵子树）；带斜杠的模式额外按**整条相对路径**匹配
 * （`.github/workflows/*.yml` 这类）。
 */
function matchesMaskPattern(patterns, root, target) {
  if (patterns.length === 0) return false;
  const segments = relativeSegments(root, target);
  if (segments.length === 0) return false;
  return patterns.some((pattern) => segments.some((segment) => pattern.test(segment))
    || pattern.test(segments.join('/')));
}

/** 遮蔽判定（前缀 ∪ 名字模式）；名字模式对**词法路径与 realpath 结果都查**，见下方两处调用点注记。 */
function maskedViolation({ prefixes = [], patterns = [] }, root, lexicalPath, resolvedPath) {
  if (patterns.length > 0
    && (matchesMaskPattern(patterns, root, lexicalPath) || matchesMaskPattern(patterns, root, resolvedPath))) {
    return true;
  }
  return prefixes.some((prefix) => isWithin(prefix, resolvedPath));
}

export class JailError extends Error {
  constructor(code = 'jail_violation', message = code) {
    super(message);
    this.name = 'JailError';
    this.code = code;
  }
}

/**
 * jail 缺省告警出口（261116 返工）：与 `lib/llm-timeouts.js:66-73` 同一先例——worker 的 stdout
 * 由 agentd 逐行接管并加 `[worker <run>]` 前缀（`runner/agentd.js:1040`），所以库里一句
 * `console.warn` 在现网是**运维看得见**的，不必把 logger 注入进来。
 * 测试注入自己的 sink（见 `file-tools.test.js` 的 `warn: (m) => warnings.push(m)`）。
 */
function defaultJailWarn(message) {
  console.warn(`[station-runner] ${message}`);
}

/**
 * 只读例外条目的解析 + **归属检查**（issue #259 返工，第三方审计 LOW-1）。
 *
 * 为什么必须有这条检查：例外条目自己会被 realpath（`~/.erix` 是 symlink 时 realpath 给出的是
 * **目标**目录），于是「agent 用 shell 把 `~/.erix` 换成指向 `/etc` 的链接」= 例外静默扩张成
 * `/etc/**`。清单是平台给的，但**目录是 agent 能改的**，所以解析完必须回查归属。
 *
 * 归属锚 = **声明这条例外的目录**（`path.dirname(declared)` 的 realpath），对
 * `platformReadExceptions()` 的两项（`$HOME/AGENTS.md`、`$HOME/.erix`）就是 `$HOME` 本身。
 * 取父目录而不是在 jail 里硬取 `os.homedir()`：① jail 是纯参数驱动的库（测试与将来别的调用方
 * 都用夹具家目录，环境里的 HOME 与它们无关）；② 父目录恒**不会比声明更宽**，所以「例外不得被
 * symlink 放宽」这条不变式对任意条目都成立，而不是只对平台那两项成立。
 * 锚自己也要 realpath：`$HOME` 本身是 symlink 的机器上，拿词法父目录比会把合法重排误判成越界。
 *
 * 不满足 ⇒ **丢弃该条形同不存在**（读边界退化成没这条例外的样子）+ `warn` 点名两个路径。
 * ⚠ **绝不在这里抛**：那会让整个 jail 构造失败 = worker 起不来，而「agent 换掉 `~/.erix`」是它
 * 自己做得到的动作，那种情况该有的形状是「这条例外没生效」，不是「工位起不来」。
 *
 * @returns {[string[], Readonly<Array<{declared:string, resolved:string, anchor:string}>>]}
 *   [保留下来的例外根（realpath 后）, 被丢弃条目的事实（供 jail 复核/日志）]
 */
function resolveReadExceptionRoots(readExceptions, rootPath, warn) {
  const kept = [];
  const dropped = [];
  for (const entry of (Array.isArray(readExceptions) ? readExceptions : [])) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    const declared = path.resolve(rootPath, entry);
    // realpathWithMissing 对**还不存在**的路径不抛（只把缺失尾段拼回去），所以「平台文件尚未物化」
    // 不会在装配期炸掉 jail，也不会被归属检查误杀（不存在 ⇒ 解析结果仍在声明它的目录之内）。
    const resolved = realpathWithMissing(declared);
    const anchor = realpathWithMissing(path.dirname(declared));
    if (isWithin(anchor, resolved)) {
      kept.push(resolved);
      continue;
    }
    dropped.push(Object.freeze({ declared, resolved, anchor }));
    warn(`read-only exception dropped: ${declared} resolves to ${resolved}, which is NOT inside the `
      + `directory that declares it (${anchor}) — treating it as if absent (issue #259: a read exception `
      + 'must not be widened into another tree by a symlink; the write boundary is unchanged either way)');
  }
  return [kept, Object.freeze(dropped)];
}

/**
 * 创建文件系统路径 jail（0.3.5 createJail 同名同语义移植）。
 *
 * **读边界与写边界是两条线**（issue #259 起）：
 *   * 写边界 = `root`（+ `writable` 子集），**没有例外**——`resolve` 的语义与 0.3.5 逐字一致；
 *     `resolveForWrite` 的**三条拒因分得很开**（issue #259 验收：不许把「只读例外」与「越界」糊成
 *     一句）：`path_read_only`（落在例外清单里）/ `path_not_writable`（根内非可写，同 0.3.5）/
 *     `path_escapes_root`（根外，同 0.3.5）。三条都是拒，**写判定一点没放宽**。
 *   * 读边界 = `root` ∪ `readExceptions`（只放宽读）。例外**不经过模型**：它是装配方（worker）
 *     传进来的平台侧白名单，模型既不能传参放宽、也不能靠 `..` / symlink 走出例外清单
 *     （realpath 之后再做前缀判定，所以 `<例外>/../<别处>` 与指向清单外的 symlink 都仍然越界）。
 *   * **例外根自己也不许借 symlink 搬走**（261116 返工 / 审计 LOW-1）：条目 realpath 之后必须仍在
 *     「声明它的那个目录」之内（平台那两项 = `$HOME`），否则**丢弃该条形同不存在 + warn 点名**，
 *     但**绝不因此让 jail 构造失败**（见 `resolveReadExceptionRoots` 的注释）。丢弃的事实挂在
 *     `droppedReadExceptions` 上，供装配方与测试复核。
 *   * `maskedPaths` 在例外之内**继续生效**（遮蔽是收窄读，与例外正交）；因此遮蔽条目允许落在
 *     例外子树里（此前会被当成越界而在装配期抛 `JailError`）。
 *
 * @param {{root:string, writable?:string[], maskedPaths?:string[], readExceptions?:string[], warn?:(message:string)=>void}} options
 * @returns {{root:string, readExceptions:readonly string[], droppedReadExceptions:readonly object[], resolve:(p:string)=>string, resolveForWrite:(p:string)=>string, assertReadable:(p:string)=>string}}
 *   root 为已 realpath 的绝对根路径，供调用方做「解析结果 == 根」判定；readExceptions 为**通过归属检查**的
 *   例外清单（realpath 后，只读事实，供日志/测试复核）；droppedReadExceptions 为被归属检查丢弃的条目。
 */
export function createJail({ root, writable = [], maskedPaths = [], readExceptions = [], warn = defaultJailWarn }) {
  const rootPath = fs.realpathSync(path.resolve(root));

  // 严格解析：只认根之内（写侧与历史 `resolve` 语义的唯一实现，#259 一个字节都没动它）。
  const resolve = (value) => {
    const lexicalPath = path.resolve(rootPath, value);
    const resolvedPath = realpathWithMissing(lexicalPath);
    if (!isWithin(rootPath, resolvedPath)) {
      throw new JailError('path_escapes_root', `Path escapes jail root: ${value}`);
    }
    return resolvedPath;
  };

  // 只读例外（issue #259）：装配方的白名单，相对写法按根解析、能 realpath 就 realpath
  // （例外自身是指向别处的目录时，前缀判定跟着 realpath 走，不给「指出去的第二道门」留缝），
  // 但 realpath 之后必须仍在声明它的目录之内——归属检查与丢弃见 `resolveReadExceptionRoots`。
  const [exceptionRoots, droppedReadExceptions] = resolveReadExceptionRoots(readExceptions, rootPath, warn);

  const withinReadableRoots = (target) => isWithin(rootPath, target)
    || exceptionRoots.some((exceptionRoot) => isWithin(exceptionRoot, target));

  // 读侧解析：根之内 ∪ 例外之内。越界错误码/文案与严格解析逐字相同（工具面拿到的是同一句
  // 「错误：读取被宿主边界拒绝」，模型看不出「越界」与「不在例外清单」的差别）。
  const resolveReadable = (value) => {
    const resolvedPath = realpathWithMissing(path.resolve(rootPath, value));
    if (!withinReadableRoots(resolvedPath)) {
      throw new JailError('path_escapes_root', `Path escapes jail root: ${value}`);
    }
    return resolvedPath;
  };

  const writableRoots = (Array.isArray(writable) ? writable : [])
    .map((entry) => resolve(entry));
  const maskedEntries = splitMaskedEntries(maskedPaths);
  // 前缀条目走**读侧口径**（根之内 ∪ 例外之内，见 `resolveReadable`）：#259 开了家目录只读例外之后，
  // 「在例外子树里继续挡某个密钥路径」是有生产者的用法。落在两者之外的条目仍照旧在装配期抛
  // `JailError`（不静默吞掉一条写歪的遮蔽规则）。
  const maskedRoots = [];
  for (const entry of maskedEntries.prefixes) {
    const declared = path.resolve(rootPath, entry);
    try {
      maskedRoots.push(resolveReadable(declared));
    } catch (error) {
      const owner = droppedReadExceptions.find((dropped) => isWithin(dropped.declared, declared));
      if (!owner) throw error; // 根与例外都之外 ⇒ 照旧装配期抛，不静默吞掉一条写歪的遮蔽规则
      warn(`masked entry skipped: ${declared} sits under the dropped read-only exception `
        + `${owner.declared} (that whole subtree is unreadable anyway, so masking it is a no-op)`);
    }
  }
  const maskedPatterns = maskedEntries.patterns;

  const resolveForWrite = (value) => {
    // 写侧用**严格解析**（与 `resolve` 同一口径），但拒因要分得开（issue #259 验收：「只读例外」与
    // 「越界」不得糊成同一个说法）：
    //   * 落在例外清单里 → `path_read_only`（能读不能写，这是 #259 故意留的口子）
    //   * 根之内但不在 writable 子树 → `path_not_writable`（逐字同 0.3.5）
    //   * 其余根外 → `path_escapes_root`（逐字同 0.3.5）
    // **写判定本身一点没放宽**：三条都是拒，例外只是把其中一条说得准一点。
    const resolvedPath = realpathWithMissing(path.resolve(rootPath, value));
    if (!isWithin(rootPath, resolvedPath)) {
      if (exceptionRoots.some((exceptionRoot) => isWithin(exceptionRoot, resolvedPath))) {
        throw new JailError('path_read_only', `Path is a read-only exception (readable, never writable): ${value}`);
      }
      throw new JailError('path_escapes_root', `Path escapes jail root: ${value}`);
    }
    if (!writableRoots.some((writableRoot) => isWithin(writableRoot, resolvedPath))) {
      throw new JailError('path_not_writable', `Path is not writable: ${value}`);
    }
    return resolvedPath;
  };

  const assertReadable = (value) => {
    const resolvedPath = resolveReadable(value);
    // 名字模式额外拿**词法路径**比一次：`.env` 若是指向 `db-creds.txt` 的软链，realpath 之后段名里
    // 再没有 `.env`，只查 realpath 会让「建个软链」就把遮蔽拆掉。反方向（`link.txt -> .env`）由
    // resolvedPath 那一路命中 ⇒ 两个方向都是 fail-closed。
    const masked = maskedViolation(
      { prefixes: maskedRoots, patterns: maskedPatterns },
      rootPath, path.resolve(rootPath, value), resolvedPath,
    );
    if (masked) {
      throw new JailError('path_masked', `Path is masked: ${value}`);
    }
    return resolvedPath;
  };

  return {
    root: rootPath,
    readExceptions: Object.freeze([...exceptionRoots]),
    droppedReadExceptions,
    resolve,
    resolveForWrite,
    assertReadable,
  };
}

/**
 * 平台侧的**只读例外清单**（issue #259；jail 的 `readExceptions` 入参）。
 *
 * 只放**平台自己生成、且模型本该像读普通文档一样读它**的东西：
 *   * `~/AGENTS.md` —— 平台约束的单一真相（#258 定稿：提示词只做指针，规则住在这个文件里）；
 *   * `~/.erix/`    —— 平台下发的派生视图（`ports.json` 端口清单、`config.json` provider 配置等）。
 *     家目录是**本 FDE 自己的**家目录（userspace 每 FDE 一棵，user-space §2.4），清单里没有
 *     跨 FDE 的数据；`config.json` 里只有占位 key（H-B D-4 容器内零真实凭据，runner-integration §11）。
 *
 * 两条纪律：① **不含运行期事实**（端口号、伞域、FDE 名一个都不出现——同 #246/#257 口径）；
 * ② **fail-closed**：拿不到家目录就返回空清单 ⇒ 退化成 #259 之前的行为，绝不是「放宽成整个 /」。
 *
 * @param {{home?:string}} [options] 注入家目录（测试用）；缺省 `os.homedir()`
 * @returns {readonly string[]}
 */
export function platformReadExceptions({ home = os.homedir() } = {}) {
  if (typeof home !== 'string' || home === '') return Object.freeze([]);
  return Object.freeze([path.join(home, 'AGENTS.md'), path.join(home, '.erix')]);
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
//     ABORT_CHECKPOINT_EVERY = 32），`lib/abort.js` 继续给自己与 shell 工具用；
//   * **`tree` 根标签在装配层收口成 `./`**（issue #64 语义保住，见下文 `TREE_ROOT_LABEL` 注记）：
//     上游只对 `path === "."` 给 `"./"`，`''` / `'./'` / 缺省会给出**工作目录 basename**，真机上模型
//     拷这个输出再查一次就 ENOENT（#228 真机验收踩到，浪费一轮）。上游侧已提单（erix-agent #215），上游修好后
//     这条收口可以撤。
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

// ---------------------------------------------------------------------------
// `tree` 根标签收口（issue #64 语义保住；#228 真机验收后的修复）
//
// 上游 `createFileTools` 的 tree 里 `path` 只用在三处：解析目标、根标签（
// `rootLabel = treePath === "." ? "." : path.basename(…)`）、以及拼出首行——**条目、截断
// marker、排除账一律不引用 `path`**。所以把「根写法」的入参换成 `"."` 只会影响根标签一处，
// 条目与 marker 逐字节不变（也不需要本站重算目录树）。
//
// 真机证据（#228，共享 dev 栈 / fde-eric）：模型 `tree {path:"./"}` 拿到首行 `hello-station/`，
// 照着再调 `tree {path:"hello-station/"}` → `ENOENT …/hello-station/hello-station`、ok:false，
// 真的失败一次并浪费一轮——不是「上游语义、我不动」能交差的量级。
//
// 两道措施：
//   1. 入口：根写法（`''` / `'.'` / `'./'` 及尾斜杠变体 / 缺省 / null）归一成 `path: "."`，
//      让上游走它自己的 `"."` 分支直接输出 `./`（顺带挡掉 `path: null` 会被 `path.resolve`
//      抛 TypeError 这个隐性坑）；
//   2. 出口：结果首行如果仍是工作目录 basename（`hello-station` 或 `hello-station/`）就换成 `./`。
//      这一道同时接管「绝对根路径 / `sub/..` 这类解析后就是根的写法」，并在上游改了 `"."` 分支时兜住。
// 两者都只动首行根标签；不认的写法（真实子目录名、子树里的文件）一字不动，不过度归一。
/** `tree` 根标签的归一目标（与上游 `path === "."` 分支的输出逐字一致）。 */
const TREE_ROOT_LABEL = './';

/** 上游写拒结果的固定前缀（本站只在这之后追加拒因，不改它）。 */
const WRITE_DENIED_PREFIX = '错误：写入被宿主边界拒绝：';

/** 「根写法」的入参：缺省 / null / `''` / `'.'` / `'./'`（含 `.//`、`./.`、`././` 等尾斜杠变体）。 */
function isRootFormPath(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return true;
  // ⚠ erix-agent 0.25.0 起这条必须**逐段判**，不能写 `startsWith('./')`：`./nested/sub` 是**子目录**
  // 写法，上游 0.25 的契约（`test/contract/file-tools.js` 的 #358 那组）要求它的首行是
  // `nested/sub/`；旧写法把它当根 ⇒ 整棵树退化成根目录、首行 `./`（模型看到的是**错目录的树**，
  // 0.23 时代上游自己把子目录标签也归一掉了，所以这条一直没炸——它是被上游的修正**揭出来**的）。
  // 判据：剥掉空段与 `.` 段之后什么都不剩，才是根写法（`''` / `'.'` / `'./'` / `.//` / `././`）。
  return trimmed.split('/').filter((segment) => segment !== '' && segment !== '.').length === 0;
}

/** 解析后就是根的其他写法（绝对根路径、`sub/..`）：也归一根标签，但不改上游入参。 */
function resolvesToRoot(root, value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    return path.resolve(root, value) === root;
  } catch {
    return false;
  }
}

/**
 * 装配层的遮蔽表（jail 之外的那一份，服务「没有 jail / jail 根与 cwd 不同」的调用方）。
 * 前缀条目：相对路径按 root 解析，能 realpath 就 realpath（防用 symlink 绕过遮蔽）——**逐字沿用 #228 的
 * `maskedPrefixes`**，只是拆成「先分类再编表」，前缀语义零改动。
 * 名字模式条目（issue #231）：只编译成 RegExp，判定发生在**每次谓词调用**上——所以 run 中途新建的
 * `.env.local` 一样被挡；换成「启动时扫目录把模式展成具体路径」就给遮蔽加了一条它本没有的失效条件。
 *
 * 已知边界（#228 既有，本单不扩）：本表按**调用方给的 root** 编，所以 root 是目录的符号链接写法时，
 * 前缀条目会被 realpath 到真目录、与 target 的链接写法比不中 ⇒ 装配层这关对前缀条目 miss。
 * 生产链路不因此漏：worker 同时传了 jail，`createJail` 的根是 realpath 过的（名字模式还额外比词法段），
 * 两个方向都在那里兜住（用例已钉）。要消掉本边界就得同时编两张表（realpath 根 + 词法根），
 * 而生产里它不改变任何结论 ⇒ #231 不做（已核）。
 */
function compileMaskedTable(root, maskedPaths) {
  const { prefixes, patterns } = splitMaskedEntries(maskedPaths);
  return {
    patterns,
    prefixes: prefixes.map((entry) => {
      const lexical = path.resolve(root, entry);
      try {
        return fs.realpathSync(lexical);
      } catch {
        return lexical;
      }
    }),
  };
}

/**
 * station 生产链路的遮蔽集合（**单一真相**：`runner/worker.js` 直接 import 它，不另抄一份名单）。
 *
 * 口径（issue #231，工单 fix-261115-02）：**只针对项目目录以内**。FDE home 下的 `~/.ssh`、
 * `~/.git-credentials`、`~/.erix/*` 本来就在 jail 根之外，文件工具一直读不到它们——那不是「漏了」，
 * 不需要在这里再遮一遍。
 *
 * ⚠ **它不是安全加固，是防误读**（口径不对称，必须连理由一起读）：
 *   - 遮蔽只作用于**文件工具**（readFile / searchText / tree 的读谓词）；`shell` 按设计越过文件牢笼
 *     （`lib/shell-tools.js` 头注 + 不变式 1「容器是信任边界」），所以 `shell` 里 `cat .env` 依旧拿得到
 *     全文，`runner/test/masked-paths.test.js` 把这条现状钉着（**不许当 bug 修**）。
 *   - 因此本集合拦的是「模型**主动**用 readFile 把密钥拽进 transcript / 上下文」这条最常见路径，
 *     而不是「容器里的人拿不到密钥」——后者归容器边界（不变式 1）与网络层，不归这里。
 *   - 写侧不挡（与 `createJail.assertReadable` 逐字对齐的旧口径：**只挡读不挡写**），`writeFile` / `edit`
 *     仍能写 `.env`。
 *
 * 误伤是已知代价（都是「多绕一步 shell」，不是死路）：`.env.example` / `.env.sample` 这类签入仓库的
 * 模板同样被 `.env*` 命中，`id_mapping.csv`、`idea.txt` 这类名字会被 `id_*` 命中，测试用的 `*.pem`
 * 夹具同理——SYSTEM_PROMPT 已给出口（「被宿主边界拒绝」时用 shell 定点看那一个文件）。
 *
 * **两种条目的深度语义不同（有用例各自钉住，别当同一个东西改）**：
 *   - 名字模式（`.env*` / `*.pem` / `id_*`）按路径段匹配 ⇒ **任意深度**都挡（`deploy/tls/server.pem`、
 *     `deploy/keys/id_ed25519` 都在集合内）；
 *   - 前缀条目（`.git/config` / `.npmrc`）只挡那一个路径及其子树 ⇒ `sub/.npmrc`、`.git/HEAD` 不挡。
 *     嵌套的 `.npmrc`（monorepo 包内）目前不在集合里，取内容走 shell。
 *
 * 两个方向的 symlink 都是 fail-closed（#231）：`.env` 是指向别处的软链仍被挡（比**词法段**），
 * 普通名字指向 `.env` 也被挡（比 **realpath 结果**）。
 * 口径登记：`docs/design/runner-integration.md` §6.3-3 与 §17.1。
 */
export const STATION_MASKED_PATHS = Object.freeze([
  '.env*',        // .env / .env.local / .env.production …（含签入的 .env.example 模板，见上「误伤」）
  '.git/config',  // remote url 里可能嵌 user:password（`.git` 其余条目不挡：HEAD / packed-refs 不是密钥）
  '.npmrc',       // _authToken / //registry.npmjs.org/:_authToken（前缀条目 = 只挡**项目根**那一个，见上「两种条目」）
  '*.pem',        // 证书 / 私钥；任意深度（`deploy/tls/server.pem` 这类）
  'id_*',         // OpenSSH 私钥命名习惯（id_rsa / id_ed25519）；家目录 `~/.ssh` 在 jail 外，不在本集合职责内
]);

/**
 * 装配上游 `erix-agent/tools` 的 createFileTools，边界走本站 jail（issue #228）。
 *
 * @param {object} [options]
 * @param {{root:string, assertReadable:Function, resolveForWrite:Function}} [options.jail]
 *   宿主边界（createJail 的返回值）。jail.root 是 realpath 过的根，未显式传 cwd 时用它做上游的解析根。
 *   ⚠ **只读例外不在本层加**（issue #259）：例外住在 jail 里（`readExceptions` → `assertReadable`），
 *   本层只负责把它折成布尔喂给上游。写侧照旧只认 jail 的 `resolveForWrite`（根之内）。
 *   上游 `createFileTools` 自己不做任何包含判定（ADR-009，它只把 `path.resolve` 后的绝对路径喂谓词，
 *   并展开 `~/x`），所以 `readFile {path:"~/.erix/ports.json"}` 能否读全看 jail 谓词——本单要的正是这里。
 * @param {string} [options.cwd] 上游相对路径解析根；缺省依次取 jail.root / process.cwd()
 * @param {string[]} [options.maskedPaths] 遮蔽条目：前缀（目录/文件，相对 cwd 或绝对）**或名字模式**
 *   （含 `*` / `?`，按相对路径逐段匹配，issue #231）；只挡读，不挡写
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
  const maskedTable = compileMaskedTable(root, maskedPaths);

  // ⚠ 无 jail 时这里是**单向**检查：同一个 `target` 既当词法路径、又当 realpath 结果交进去（上游给的
  //   是词法解析后的绝对路径）⇒ 「普通名字指向被遮名」（`alias.txt -> .env`）这一面会漏；生产不受影响，
  //   `worker.js:559-560` 供了 jail，两个方向由 `assertReadable` 那一路补齐（它拿的是两个不同的值）。
  //   口径登记：`docs/design/runner-integration.md` §17.1——已知事实，**不**为此改装配语义或加参数。
  const withinMasked = (target) => maskedViolation(maskedTable, root, target, target);
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

  // 写拒因的分诊（issue #259 验收：「只读例外」与「越界」不得糊成一句）。上游把谓词的 false 排成
  // 一句固定文案（`错误：写入被宿主边界拒绝：<相对路径>`），它看不到 jail 的错误码 ⇒ 本站在谓词里
  // 把拒因记下来，出口给那句文案**追一句原因**。只追加、不改上游前缀（契约只钉前缀，不钉全文）。
  // ⚠ 上游对一次写**只调一次** `allowWrite`（`src/tools/file-tools.js` 里 writeFile / edit 各一处），
  // 所以这个「最后一次调用」的备注是确定量；将来上游改成多次调用，备注会变糊但不会变错。
  const WRITE_DENY_NOTES = Object.freeze({
    // ⚠ 两条拒因的**用词必须不重叠**（`只读例外` 这四个字只能出现在第一条）：否则「拒因分得开」
    // 这类断言只能靠 `doesNotMatch` 逆推，而逆推会被无关文案里的同一个词误兵。见 file-tools.test.js
    // 的「红线」用例（它钉的是：例外写拒含 `只读例外`、越界写拒含 `越出` 且不含 `只读例外`）。
    path_read_only: '这是平台开的**只读例外**（家目录的 `~/AGENTS.md` 与 `~/.erix/`）：读得到、写不进去，平台文件下一轮对账也会覆盖回去',
    path_not_writable: '这在项目目录之内，但不在本次 run 的可写范围内',
    path_escapes_root: '这条路径越出了项目目录（家目录里只有清单内的那几个路径能读，其余一概不碰）',
    host_predicate: '宿主（worker）的写谓词拒了它',
  });
  let lastWriteDenyNote = '';

  const canRead = (target) => Boolean(hostAllowRead(target))
    && !withinMasked(target)
    && jailAllows(jail?.assertReadable, target);
  const canWrite = (target) => {
    lastWriteDenyNote = '';
    if (!hostAllowWrite(target)) {
      lastWriteDenyNote = WRITE_DENY_NOTES.host_predicate;
      return false;
    }
    if (typeof jail?.resolveForWrite !== 'function') return true;
    try {
      jail.resolveForWrite(target);
      return true;
    } catch (error) {
      if (!(error instanceof JailError)) throw error;
      lastWriteDenyNote = WRITE_DENY_NOTES[error.code] ?? '';
      return false;
    }
  };

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
    const structured = isStructuredCall(firstArg);
    const signal = structured
      ? (firstArg.signal ?? firstArg.context?.signal)
      : context?.signal;
    throwIfAborted(signal);

    // tree 根标签收口（issue #64 / #228，详见文件头 TREE_ROOT_LABEL 注记）：只改根标签一处。
    const isTreeCall = structured ? firstArg.name === 'tree' : firstArg === 'tree';
    const treePath = structured ? firstArg.input?.path : input?.path;
    const rootForm = isTreeCall && isRootFormPath(treePath);
    if (rootForm) {
      if (structured) firstArg = { ...firstArg, input: { ...(firstArg.input ?? {}), path: '.' } };
      else input = { ...(input ?? {}), path: '.' };
    }
    const treeTargetIsRoot = isTreeCall && (rootForm || resolvesToRoot(root, treePath));
    // 写拒因备注上一次调用重置（见上面 `canWrite` 的注记），并且只给写工具用。
    const toolName = structured ? firstArg.name : firstArg;
    const isWriteCall = toolName === 'writeFile' || toolName === 'edit';
    if (isWriteCall) lastWriteDenyNote = '';

    const result = structured
      ? await upstream.executeTool(firstArg)
      : await upstream.executeTool(firstArg, input, context);
    // 形态判别用**上游导出的 `classifyFileToolResult`**（erix-agent 0.20.0 / #220，从 `erix-agent/tools`
    // 子路径导出，**不在包根**）。四种成功形态（guide-0.20.0 §6，随包契约套件现在钉着它们）：
    //   readFile / edit → string（kind='text'）· writeFile → number 字节数（kind='bytes'，**0 是成功**）
    //   · searchText → { content, metadata }（kind='content-metadata'）· 其它 → kind='unknown'。
    // ⚠ 两个旧坑：`if (!result)` 把「写了 0 字节」当成失败；`typeof result === 'string'` 也不是成败
    // 判据（**错误结果也是字符串**，顶层形态与 readFile 一致）。根标签收口只对文本生效，故取 kind。
    const fact = classifyFileToolResult(result);
    // 写被拒时追一句**拒因**（issue #259：「只读例外」与「越界」必须分得开——只说「被拒」会让模型
    // 去重试一条根本改不动的路径）。只**追加**，不改上游那句前缀。
    if (isWriteCall && lastWriteDenyNote
      && fact.kind === 'text' && fact.text.startsWith(WRITE_DENIED_PREFIX)) {
      return `${fact.text}（${lastWriteDenyNote}）`;
    }
    if (!treeTargetIsRoot || fact.kind !== 'text' || fact.text === '') return result;
    const treeText = fact.text;

    // 出口兜底：首行仍是工作目录 basename → 换回 `./`；已是 `./` 或认不出的文本（错误结果等）一律不动。
    const cut = treeText.indexOf('\n');
    const firstLine = cut === -1 ? treeText : treeText.slice(0, cut);
    if (firstLine === TREE_ROOT_LABEL) return result;
    const baseName = path.basename(root);
    if (firstLine !== baseName && firstLine !== `${baseName}/`) return result;
    return `${TREE_ROOT_LABEL}${cut === -1 ? '' : treeText.slice(cut)}`;
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
