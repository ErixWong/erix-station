// AGENTS.md 链的宿主侧采集与渲染（issue #451，工单 feat-261105-01）。
//
// 为什么要有这个模块：平台约定（materializer 物化的 `~/AGENTS.md`，9 KB / 67 行）与项目约定今天**只靠
// 模型自觉去 `cat`**。真机 14 天实测（docs/design/agents-md-layering-2026-11-05.md §1.2）：35 个 run 里
// 只有 5 个跑过含 `AGENTS.md` 的命令（14%，其中 4 个还是验收探针），读过的 5 个里 4 个自带
// `head -50/60/80` 截断（「收工即提交」在 53–54 行，`head -50` 正好切掉）。**「下发了 ≠ 读了」在统计上
// 就是常态。** 改法不是再加一条提示词，而是把「告知面」从「让模型自己去读」改成「宿主在 run 启动时注入
// system prompt」：确定性（不依赖自觉）、零额外轮次、**不可折叠**（工具结果会随整轮被折走，system 不会）。
//
// 三条硬口径（改这个文件前先读）：
//   ① **注入内容只来自文件原文**：宿主不解析、不改写、不摘录。8 条应用侧规则仍然只有一份
//      （`portal/src/materializer.js` 的 `renderHomeAgentsMd()`），这里绝不抄第二份——抄一遍就是埋下一份
//      必然过期的真相（同 §8.10「工具名从注册面取、不手抄清单」）。
//   ② **渲染必须逐字节确定**：system 是引擎标记的 prompt 缓存稳定前缀（`markStablePrefix` 给 system 打
//      `cacheBoundary`），任何每次变化的东西（时间戳 / run id / generation / 随机量）都会让整条前缀缓存
//      失效。⇒ 文件不变 ⇒ 输出逐字节不变。**无 blocks ⇒ 返回空串**（否则没约定文件的 run 的 system 也变）。
//   ③ **失败一律降级**：读不到 / 不是普通文件 / 越界 symlink / 内容重复 ⇒ 跳过 + note，**绝不抛**
//      （run 不能因为一个约定文件读不到而失败）。
//
// 边界（本模块**不**做的事）：不改 jail 读写边界（`runner/lib/file-tools.js` 一个字节都不动，#259 独立单）；
// 不注入 `~/.erix/ports.json`（动态清单，按需 `cat`）；不认 `CLAUDE.md` / `.cursorrules` 等别名（多一个真相源
// 入口）；不递归扫全项目（只做祖先链 + 一层子目录索引）；不新增事件类型 / 错误码；不加 env 旋钮
// （§8.73：策略不是运维参数，回滚 = 删 worker.js 里的接线点）。
//
// 层级与顺序（由外到内，与 pi 一致）：
//   $HOME/AGENTS.md                平台节（materializer 生成，root:root ⇒ 「不可覆盖」是事实不是约定）
//   $HOME/projects/AGENTS.md       跨项目约定（用户自建，平台不物化）
//   …（cwd 之下的其余祖先，同规则继续向内）…
//   <cwd>/AGENTS.md                项目约定
//   子目录索引：`<cwd>/<dir>/AGENTS.md` 只列路径、不注入正文（仓库自带的约定不在 cwd 的祖先链上）。
//
// 纯函数 + 可注入 fs：本模块不 import worker，也不碰真实 `$HOME`（AGENTS.md §4 测试隔离约定），
// 单测用 `fs.mkdtempSync` 造临时树或注入一个 fs 门面。
import fsDefault from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const AGENTS_MD_BASENAME = 'AGENTS.md';
/**
 * 单文件**正文**注入上限。平台节今天 9 KB，留一倍余量；再大就说明有人在约定文件里塞别的东西。
 * ⚠ 口径（#451 评审 m3）：这是**正文**上限，**截断 marker 另计**（约 100 B：评审实测 16385 B 的源
 * ⇒ `blocks[].bytes = 16479`）；而全链 48 KiB 是按**含 marker** 的 `b.bytes` 累加 ⇒ 两个上限不同量纲，
 * 差的就是 marker。**不改判定逻辑**（改了会动「16384 不截断 / 16385 截断」那条用例，收益为零）。
 */
export const AGENTS_MD_MAX_FILE_BYTES = 16 * 1024;
/** 全链上限（= 3 份满载单文件）。超了**从内层开始截**：平台节必须完整（它装的是运行期硬约束）。 */
export const AGENTS_MD_MAX_TOTAL_BYTES = 48 * 1024;
/** 子目录索引条数上限（只列路径，不注入正文 ⇒ 条数只影响可读性）。 */
export const AGENTS_MD_MAX_SUBDIR_HINTS = 5;

/** 路径是否在 `root` 之内（`root` 自身也算「之内」）。用 `sep` 拼接比较，挡 `/a/bc` 冒充 `/a/b`。 */
function isInside(target, root) {
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix);
}

/**
 * realpath 失败时的降级：退回 `path.resolve` 的形态（不存在 / 无权限时仍要能算出候选链，
 * 至于那一份文件读不读得到是后面逐文件的判断）。
 *
 * ⚠ **不可用（非字符串 / 空串）返回 `null`，绝不抛**（issue #451 返修 F1）：`path.resolve(undefined)`
 * 会抛 `The "paths[0]" argument must be of type string`，而这次采集在 worker 的 `startRun` 里、
 * `runToolLoop` 之前 ⇒ 抛出去就是 worker 进程死 ⇒ agentd 当崩溃处理 → requeue → attempts exhausted，
 * 用户只看到「3 次耗尽」，根因只是一个路径参数形态不对。工单 §4.5「失败一律降级」包括**调用方传错**。
 */
function realpathOr(fsImpl, p) {
  if (typeof p !== 'string' || p.trim() === '') return null;
  let abs;
  try {
    abs = path.resolve(p);
  } catch {
    return null; // 理论上不可达（已保证是字符串），防御性兜底：降级不抛
  }
  try {
    return fsImpl.realpathSync(abs);
  } catch {
    return abs;
  }
}

/** 展示用路径：home 之下的写成 `~/…`（提示词里给的 `cat` 命令要能直接照抄）。 */
function displayPath(p, home) {
  return home && isInside(p, home) ? `~${p.slice(home.length)}` : p;
}

function errLabel(err) {
  return err?.code ?? err?.message ?? String(err);
}

function positiveIntOr(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** 按 UTF-8 字符边界取前缀：别把多字节字符切成半个（切了会出 U+FFFD，等于改写原文）。 */
function utf8Prefix(buf, maxBytes) {
  let end = Math.min(maxBytes, buf.length);
  while (end > 0 && end < buf.length && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * #451 评审 B1（blocker）：**只读文件前 `maxBytes + 4` 字节**，定长缓冲 ⇒ 超大文件不会整文件进内存。
 *
 * 为什么是 +4：一个 UTF-8 字符最长 4 字节，多读 4 个字节就必然能判定第 `maxBytes` 字节是不是字符边界
 * （`utf8Prefix` 要往回退到前导字节），也必然能在尾部判断末段字符是否完整（`trimIncompleteUtf8Tail`）。
 *
 * 逐次补读（`readSync` 对普通文件通常一次读满，但短读在语义上是合法的）；`closeSync` 放 finally，
 * 关不掉不影响已经读到的前缀。**不整文件 `readFileSync`** 就是这条的存在理由：600 MiB 的 `AGENTS.md`
 * 旧写法要 647 MB RSS + 抛 `ERR_STRING_TOO_LONG`（⇒ worker 兜住后整段注入置空，连平台节都没了）。
 */
function readPrefix(fsImpl, file, maxBytes) {
  const length = maxBytes + 4;
  const buf = Buffer.alloc(length); // 定长：内存占用与文件大小无关
  const fd = fsImpl.openSync(file, 'r');
  try {
    let got = 0;
    while (got < length) {
      const n = fsImpl.readSync(fd, buf, got, length - got, got) ?? 0;
      if (n <= 0) break; // EOF
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    try {
      fsImpl.closeSync(fd);
    } catch {
      // 关闭失败（EBADF 之类）不影响已经读进缓冲的前缀：降级口径，不记账也不抛。
    }
  }
}

function canPrefixRead(fsImpl) {
  return typeof fsImpl.openSync === 'function' && typeof fsImpl.readSync === 'function'
    && typeof fsImpl.closeSync === 'function';
}

/**
 * #451 评审 M1：「解码失败 ⇒ 跳过 + note」在旧实现里是**死光纤**——`buf.toString('utf8')` 是 lossy
 * 解码，**永不失败**，所以二进制 / GBK 的 `AGENTS.md` 会被当正文注入（带 U+FFFD 与 `\u0000`），而
 * `notes=[]` 看起来完全正常。改 `TextDecoder(..., { fatal: true })` 后失败才会真发生（设计稿 §4.1 规则 6）。
 * 统一定制成 `NotUtf8Error`：worker 侧的 catch 要能区分「读不动」与「不是 UTF-8」两种记账文案。
 */
class NotUtf8Error extends Error {}

function decodeUtf8Strict(buf) {
  try {
    // `ignoreBOM: true` 是必须的：TextDecoder 默认**会吞掉前导 BOM**，而口径是「展示用原文、一个字节都
    // 不改」（BOM 归展示，只在去重键里被剔掉，见 `dedupeKey`）。
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch (err) {
    throw new NotUtf8Error(err?.message ?? String(err));
  }
}

/** note 里给前 16 字节的 hex：运维拿着就能 `file`/`xxd` 定是什么编码，不用去猜。 */
function hexHead(buf, max = 16) {
  if (!buf) return '';
  return Buffer.from(buf.subarray(0, max)).toString('hex');
}

/**
 * 剔掉尾部一段**还没读完的**多字节序列（只在定长前缀读之后用）。
 *
 * 为什么必需：前缀切在字符中间是**读法**造成的不完整，不是文件本身不是 UTF-8；M1 之后 fatal 解码会
 * 把它当非法编码 ⇒ 合法的中文约定文件会被误删。`readPrefix` 多读 4 字节就是为了让这里能判定
 * （一个 UTF-8 字符最长 4 字节 ⇒ 尾部最多 3 个字节可能属于一个未完成的字符）。
 */
function trimIncompleteUtf8Tail(buf) {
  for (let back = 1; back <= Math.min(4, buf.length); back += 1) {
    const byte = buf[buf.length - back];
    if ((byte & 0x80) === 0) return buf; // ASCII：尾部完整
    if ((byte & 0xc0) === 0xc0) { // 前导字节：算它需要多少后续字节
      const need = byte >= 0xf0 ? 3 : byte >= 0xe0 ? 2 : 1;
      return back - 1 < need ? buf.subarray(0, buf.length - back) : buf;
    }
    // 10xxxxxx（continuation）：继续往回看找前导字节
  }
  return buf; // 回看 4 字节都是 continuation：本就是非法编码，交给 fatal 解码报错
}

/**
 * 去重键（#451 评审 m4）：用**规范化后的字节**，不拿原始字节做 `sha256`。
 *
 * 旧写法让去重在真实形态下失效：`~/AGENTS.md` 带 BOM、`~/projects/AGENTS.md` 是同内容的 CRLF
 * ⇒ 两份 sha 不同 ⇒ 同一段规则注两遍且 `notes=0`（看上去一切正常，就是多烧一份 token）。
 * 规范化只做三件事：去前导 BOM（`EF BB BF` 解码后就是 U+FEFF）+ `\r\n` → `\n` + 首尾空白裁剪。
 * ⚠ **只影响去重键，不影响展示**：`blocks[].text` 仍是文件原文，一个字节都不改（口径①）。
 * 不做的规范化：单独的 `\r` 行尾、内部空白折叠——过度归一会把「真的只差空白」的两份当成一份。
 * 超大文件走前缀读时键只能覆盖读到的前缀（尾部本来也不注入，同前缀 = 注入内容逐字节相同）。
 */
function dedupeKey(text) {
  let normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  normalized = normalized.replace(/\r\n/g, '\n').trim();
  return crypto.createHash('sha256').update(Buffer.from(normalized, 'utf8')).digest('hex');
}

function scopeOf(dir, realHome) {
  if (!realHome) return 'project'; // home 不可用 ⇒ 没有平台/跨项目节可言，全部按项目节标
  if (dir === realHome) return 'platform';
  if (dir === path.join(realHome, 'projects')) return 'workspace';
  return 'project';
}

/**
 * 由外到内的候选链（home → … → cwd），每项 `{ dir, path, scope }`。
 *
 * - `cwd` 在 `home` 之下 ⇒ `realpath(cwd)` 逐级上溯到 `realpath(home)`（**含 home**）。
 * - `cwd` 不在 `home` 之下（理论上不该发生）⇒ 只取 `cwd/AGENTS.md`（note 由 `collectAgentsMd` 补）。
 *
 * 只做路径算术：不 stat、不读文件。真实路径（realpath）在这里定死，后面所有越界判断都以它为基准。
 *
 * **不可用输入的降级口径**（返修 F1，**不抛**）：
 * - `cwd` 不可用（非字符串 / 空串 / 解析失败）⇒ 返回**空数组**（没有 cwd 就没有候选链；
 *   取「空数组」而不是「抛」或「造一个 `process.cwd()`」：后者会让宿主的工作目录变成默认值，
 *   在没有 cwd 的上下文里静默注入一份不该注入的文件）；note 由 `collectAgentsMd` 补。
 * - `home` 不可用 ⇒ 只返回 `[cwd]` 一项（scope = `project`）：仍按 cwd 采集，只是没有平台/跨项目节。
 */
export function resolveAgentsMdChain(options = {}) {
  const { cwd, home, fs: fsImpl = fsDefault } = options ?? {};
  const realCwd = realpathOr(fsImpl, cwd);
  const realHome = realpathOr(fsImpl, home);
  const dirs = [];
  if (realCwd === null) return [];
  if (realHome === null || !isInside(realCwd, realHome)) {
    dirs.push(realCwd);
  } else {
    let dir = realCwd;
    for (;;) {
      dirs.push(dir);
      if (dir === realHome) break;
      const parent = path.dirname(dir);
      if (parent === dir) break; // 不可达（isInside 保证先撞到 home），防御性兜底
      dir = parent;
    }
  }
  dirs.reverse(); // 由外到内
  return dirs.map((dir) => ({
    dir,
    path: path.join(dir, AGENTS_MD_BASENAME),
    scope: scopeOf(dir, realHome),
  }));
}

/**
 * 采集祖先链上的 AGENTS.md。
 *
 * 返回 `{ blocks, totalBytes, notes, subdirHints }`：
 * - `blocks: [{ dir, path, scope, display, text, bytes, truncated }]`（由外到内，已去重/截断）
 * - `totalBytes`：实际注入的正文字节数（含截断 marker）
 * - `notes: string[]`：跳过 / 截断 / 去重的记账（渲染进抬头的「采集记账」小节；全链无 blocks 时不渲染）
 * - `subdirHints: string[]`：`cwd` 直接子目录里带 AGENTS.md 的路径（≤ `AGENTS_MD_MAX_SUBDIR_HINTS`，
 *   **只列路径**，home 之下的写成 `~/…` 以便模型照抄）。它不塞进 `blocks` 是刻意的：索引不是正文，
 *   不该混进「注入了几份文件」的账，也不该被截断逻辑当成一份内容。
 *
 * `limits` 只给单测用（`{ maxFileBytes, maxTotalBytes, maxSubdirHints }`）；生产走上面的常量，
 * **没有 env 旋钮**（裁决 ④）。
 *
 * **绝不抛**（返修 F1）：`options` 为 `null` / `{}` / 只给一半、`cwd` 或 `home` 非字符串或空串，
 * 一律降级为「少注入 + note」，不是异常。
 */
export function collectAgentsMd(options = {}) {
  const { cwd, home, fs: fsImpl = fsDefault, limits = {} } = options ?? {};
  const maxFileBytes = positiveIntOr(limits?.maxFileBytes, AGENTS_MD_MAX_FILE_BYTES);
  const maxTotalBytes = positiveIntOr(limits?.maxTotalBytes, AGENTS_MD_MAX_TOTAL_BYTES);
  const maxSubdirHints = Number.isSafeInteger(limits?.maxSubdirHints) && limits.maxSubdirHints >= 0
    ? limits.maxSubdirHints
    : AGENTS_MD_MAX_SUBDIR_HINTS;

  const realCwd = realpathOr(fsImpl, cwd);
  const realHome = realpathOr(fsImpl, home);
  const notes = [];
  // 返修 F1：cwd 不可用 ⇒ **空结果 + 一条 note**，绝不抛（调用方在 startRun 里、runToolLoop 之前，
  // 抛出去就是 worker 进程死 → requeue → attempts exhausted，而根因只是一个参数形态不对）。
  if (realCwd === null) {
    return {
      blocks: [],
      totalBytes: 0,
      notes: [`cwd 不可用（非字符串 / 空串）：本次 run 不注入任何 ${AGENTS_MD_BASENAME}`],
      subdirHints: [],
    };
  }
  const chain = resolveAgentsMdChain({ cwd, home, fs: fsImpl });
  // 越界基准 = 链的最外层目录：home 是祖先时它就是 home（= 裁决里的 `realpath(HOME)`），
  // cwd 不在 home 之下时它是 cwd（否则那份项目文件按定义「越界」，会永远读不到）。
  const boundary = chain.length > 0 ? chain[0].dir : realCwd;
  if (realHome === null) {
    notes.push(`home 不可用（非字符串 / 空串）：只按 cwd 采集，平台节与跨项目节不会注入`);
  } else if (chain.length > 0 && chain[0].scope !== 'platform') {
    notes.push(`cwd（${realCwd}）不在 home（${realHome}）之下：只注入该目录的 ${AGENTS_MD_BASENAME}`);
  }

  const seen = new Map(); // sha256 -> 展示路径（去重时保留靠外那份）
  const blocks = [];
  for (const entry of chain) {
    const display = displayPath(entry.path, realHome);
    let stat;
    try {
      stat = fsImpl.statSync(entry.path);
    } catch (err) {
      // 不存在 = 正常形态（多数 run 只有平台那一份），静默跳过；其它（EACCES / ELOOP…）记账。
      if (err?.code !== 'ENOENT') notes.push(`跳过 ${display}：${errLabel(err)}`);
      continue;
    }
    if (typeof stat?.isFile !== 'function' || !stat.isFile()) {
      // 目录 / 管道 / 设备：不是约定文件。EISDIR 这一支在这里收口（stat 能过、read 会抛）。
      notes.push(`跳过 ${display}：不是普通文件`);
      continue;
    }
    let realFile;
    try {
      realFile = fsImpl.realpathSync(entry.path);
    } catch (err) {
      notes.push(`跳过 ${display}：realpath 失败（${errLabel(err)}）`);
      continue;
    }
    if (!isInside(realFile, boundary)) {
      // symlink 逃逸：文件真实路径跑出了 home（`~/projects/AGENTS.md -> /etc/passwd`）。
      // ⚠ 口径（#451 评审 m2）：以 **realpath 时刻**的形态为准。本行判定与后面的读取之间没有
      //   `O_NOFOLLOW` / `fstat` 比对 / 二次 `realpath` ⇒ **检查与读取之间的 symlink 变化不在防护范围**
      //   （同容器、用户自己的文件：要挡的是「就是指向 home 之外」这种稳定形态，不是抢在两次
      //   系统调用之间改指向的那个写入者）。选「把口径写准」而不是加系统调用：代价是 TOCTOU 窗口，
      //   收益是少两次 syscall 与一套需要真 fs 才能测的机制。
      notes.push(`跳过 ${display}：真实路径 ${realFile} 越出 ${boundary}`);
      continue;
    }
    // #451 评审 B1（blocker）：**上限必须在读之前生效**。旧形状是「整文件 `readFileSync` ⇒ 全量解码
    // ⇒ 才比 `buf.length > maxFileBytes`」：`stat.size` 拿到了却从没用过，实测 600 MiB 的 `AGENTS.md`
    // ⇒ 抛 `ERR_STRING_TOO_LONG`、RSS 647 MB、563 ms，抛出去被 worker 的 catch 接住 ⇒ **整段置空**
    // （连平台节都不注入）。现在 size 说超限就只定长读前缀，未超限才走原来的 `readFileSync`。
    // ⚠ `stat.size` 对某些特殊文件（/proc、部分 FUSE）可能是 0 ⇒ 只当**提示**用：不可信时仍走
    //   `readFileSync`，最终由下面的 `buf.length > maxFileBytes` 兜住截断（防御性，判定口径不变）。
    let buf;
    let text;
    const sourceBytes = Number.isSafeInteger(stat.size) && stat.size > 0 ? stat.size : 0;
    try {
      if (sourceBytes > maxFileBytes && canPrefixRead(fsImpl)) {
        const prefix = readPrefix(fsImpl, realFile, maxFileBytes);
        // 读满定长缓冲 ⇒ 文件在后面还有内容 ⇒ 尾部那段可能是个没读完的字符（剔掉，否则 M1 的
        // fatal 解码会把一份合法 UTF-8 误判成「不是 UTF-8」）。没读满 = 真 EOF，不剔。
        buf = prefix.length >= maxFileBytes + 4 ? trimIncompleteUtf8Tail(prefix) : prefix;
      } else {
        const raw = fsImpl.readFileSync(realFile);
        buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
      }
      // 归一与解码**必须在这一层 try 内**（#451 评审 B1 第 4 点）：解码失败也要走下面同一条降级路径，
      // 不许从 `collectAgentsMd` 里抛出去（抛 = worker 进程死 = run 被当崩溃 requeue）。
      // M1：旧写法 `buf.toString('utf8')` 是 lossy 解码、永不失败 ⇒ 那条承诺过的降级是死光纤。
      text = decodeUtf8Strict(buf);
    } catch (err) {
      if (err instanceof NotUtf8Error) {
        // 二进制 / GBK / UTF-16：注入进去就是往 prompt 缓存前缀里塞 U+FFFD，不如不注入。展示仍用**原文**（合法 UTF-8 一个字节不改）。
        notes.push(`跳过 ${display}：不是 UTF-8 文本（前 16 字节：${hexHead(buf)}）`);
        continue;
      }
      // EACCES 等：**绝不抛**。用户把某份写成 0600 且属主不是 worker 就会走到这里。
      notes.push(`跳过 ${display}：读取失败（${errLabel(err)}）`);
      continue;
    }
    if (text.trim() === '') continue; // 空 / 全空白：跳过（不产生空节）
    // 去重键已改成规范化字节（去 BOM / CRLF / 首尾空白），**展示用的 text 仍是原文**：口径见 `dedupeKey`。
    const sha = dedupeKey(text);
    if (seen.has(sha)) {
      notes.push(`跳过 ${display}：内容与 ${seen.get(sha)} 相同（去重，保留靠外那份）`);
      continue;
    }
    seen.set(sha, display);

    let body = text;
    let truncated = false;
    if (buf.length > maxFileBytes) {
      body = utf8Prefix(buf, maxFileBytes);
      truncated = true;
    }
    const bodyBytes = Buffer.byteLength(body);
    if (truncated) {
      // marker 里的数字是**原文件字节数**与**实际注入的字节数**，命令可直接照抄（模型据此才读得到全文）。
      // 原字节数取 `max(stat.size, buf.length)`：走前缀读时 `buf.length` 只是前缀长度，报它会骗模型（旧 L116 用例钉的就是真实大小）。
      body += `\n\n[已截断：原 ${Math.max(sourceBytes, buf.length)} 字节，仅注入前 ${bodyBytes} 字节；看全文：cat ${display}]`;
    }
    blocks.push({
      dir: entry.dir,
      path: entry.path,
      display,
      scope: entry.scope,
      text: body,
      bytes: Buffer.byteLength(body),
      truncated,
    });
  }

  // 全链上限：**从内层开始截**（平台节必须完整）。chain 由外到内 ⇒ 从尾部丢。
  let totalBytes = blocks.reduce((sum, b) => sum + b.bytes, 0);
  while (totalBytes > maxTotalBytes && blocks.length > 1) {
    const dropped = blocks.pop();
    totalBytes -= dropped.bytes;
    notes.push(`未注入 ${dropped.display}：全链上限 ${maxTotalBytes} 字节，从内层开始截（平台节保持完整）`);
  }
  if (totalBytes > maxTotalBytes && blocks.length === 1) {
    // 单块就超全链上限（只有 limits 被调小才会发生；默认 16K 单文件 < 48K 全链 ⇒ 不可达）。
    const only = blocks[0];
    const body = utf8Prefix(Buffer.from(only.text, 'utf8'), maxTotalBytes);
    only.text = `${body}\n\n[已截断：全链上限 ${maxTotalBytes} 字节，仅注入前 ${Buffer.byteLength(body)} 字节；看全文：cat ${only.display}]`;
    only.bytes = Buffer.byteLength(only.text);
    only.truncated = true;
    totalBytes = only.bytes;
    notes.push(`${only.display}：单份即超全链上限 ${maxTotalBytes} 字节，已截断`);
  }

  // 子目录索引：cwd 的**直接**子目录（不递归）。只读目录名与存在性，不读正文。
  const subdirHints = [];
  if (maxSubdirHints > 0) {
    let entries = [];
    try {
      entries = fsImpl.readdirSync(realCwd, { withFileTypes: true });
    } catch {
      entries = []; // 列不出目录 = 没有索引（静默降级，不记账：它不影响注入内容）
    }
    const names = [];
    for (const entry of entries) {
      if (typeof entry === 'string') {
        names.push(entry); // 注入的 fs 门面可能只给名字
      } else if (entry && typeof entry.isDirectory === 'function' && entry.isDirectory()) {
        names.push(entry.name);
      }
    }
    names.sort(); // readdir 顺序不保证 ⇒ 显式排序（确定性）
    for (const name of names) {
      if (subdirHints.length >= maxSubdirHints) break;
      const candidate = path.join(realCwd, name, AGENTS_MD_BASENAME);
      try {
        if (!fsImpl.statSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      subdirHints.push(displayPath(candidate, realHome));
    }
  }

  return { blocks, totalBytes, notes, subdirHints };
}

const SCOPE_LABEL = {
  platform: '（平台生成，不可覆盖）',
  workspace: '（跨项目约定）',
  project: '（项目约定）',
};

/**
 * 渲染注入段。**无 blocks ⇒ 返回 `''`**（硬要求：没有约定文件的 run，`system` 必须逐字节等于原值，
 * 否则那条 run 的 prompt 缓存前缀会平白失效）。
 *
 * 抬头四句语义（措辞可调，语义不可少，单测按语义断言）：
 *   ① 顺序由外到内（越靠后越具体）；
 *   ② 平台节不可被下层覆盖，冲突按平台节执行**并在回复里告知用户**；
 *   ③ 以下内容已在你上下文里，**不要重复 `cat`**；
 *   ④ 本 run 内改这些文件**不会立刻生效**，下一次 run 才生效。
 *
 * 抬头由**宿主**生成（不写进 `~/AGENTS.md` 正文）：正文归 materializer，抬头归 runner，两边不互相引用，
 * 避免第二份会漂的真相。返回值自带前导 `\n\n`（worker 侧是 `SYSTEM_PROMPT + agentsMdSection`）。
 */
export function renderAgentsMdSection({ blocks, notes = [], subdirHints = [] } = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) return '';
  const lines = [];
  lines.push(`## 本次 run 注入的约定文件（${AGENTS_MD_BASENAME} 链，宿主在 run 启动时读取）`);
  lines.push('');
  lines.push('> 顺序：**由外到内**（越靠后越具体）。第一节是平台节，由平台生成、**不可被下层覆盖**：'
    + '若下层内容与它冲突，按平台节执行，并在回复里告知用户这处冲突。');
  lines.push('> 以下内容**已经在本次 run 的上下文里**，不要重复 `cat` 它们'
    + '（只有要确认文件是否被改过时才需要 `cat` 复核）。');
  lines.push('> 你在本 run 里修改这些文件**不会立刻生效**：下一次 run 启动时才会重新读取。');
  lines.push('');
  blocks.forEach((block, index) => {
    const label = SCOPE_LABEL[block.scope] ?? '';
    lines.push(`### ${index + 1}. ${block.display ?? block.path}${label}`);
    lines.push('');
    lines.push(String(block.text ?? '')); // 原文，一个字节都不改
    lines.push('');
  });
  if (Array.isArray(subdirHints) && subdirHints.length > 0) {
    lines.push('### 子目录里另有约定文件（未注入正文；进那个目录工作时先读它）');
    lines.push('');
    for (const hint of subdirHints) lines.push(`- ${hint}`);
    lines.push('');
  }
  if (Array.isArray(notes) && notes.length > 0) {
    lines.push('### 采集记账（宿主侧提示，可忽略）');
    lines.push('');
    for (const note of notes) lines.push(`- ${note}`);
    lines.push('');
  }
  return `\n\n${lines.join('\n')}`;
}
