// 子 run（delegation）读侧（设计 `docs/design/delegation-2026-11-08.md` §5、工单 `P2-WORKORDER.md`）。
// **只读**：本模块一个写盘动作都没有。
//
// 数据源是 **FDE 家目录里的两份文件**，不是 DB（设计 §1：子 run 不是本站 `runs` 表的一行——
// `runs.session_id NOT NULL` + `runs_one_active_per_session` 唯一索引两条 DDL 硬约束挡死了
// 「子 = 真 run」；而名册的归档/清理本来就是宿主责任，`removeRecord` 已从引擎删除）：
//
//   <userSpaceRoot>/<fde>/home/delegation/roster/<parentRunId>/<childRunId>.json    引擎写（P1 宿主给目录）
//   <userSpaceRoot>/<fde>/home/delegation/transcripts/<childRunId>.jsonl            引擎文件 store 写
//
// （容器内同一棵树挂在 `/home/erix/delegation/`，`provisioner.js` 把 `<userSpaceRoot>/<fde>/home` bind 过去。）
//
// 三条红线，全部有判据（`portal/test/delegation.test.js`）：
//   1. **路径只能由两个 id 拼**：`parentRunId` 必须是 uuid、`childRunId` 必须是 `sub-<uuid>`，
//      两个 id 用正则锁死后再 `path.resolve` + 前缀断言。**绝不接受**调用方传路径片段。
//      ⚠ 不复用 `dirs.js#resolveJailedFile`：它的 jail 根是 `<userSpaceRoot>/<fde>/projects/<name>`，
//      与本单的 `home/delegation/` **不是同一棵树**，借它等于把「文件必须落在项目目录里」这条
//      不属于本单的约束塞进来，而本单真正要的那条（必须落在 `delegation/` 之下）它反而不校。
//   2. **归属**：`sessionId` 属主、`parentRunId` 属于该会话、`childRunId` 必须**出现在该 parent 的
//      名册里**——形状合法不等于存在，不查名册就读账本等于把「猜一个 id」变成一次磁盘读。
//   3. **成本**：`hasTranscript` 只用 `existsSync`（不读内容）；名册目录不存在 ⇒ 零 transcript 读；
//      账本先 `stat` 判大小（> 8 MiB ⇒ 413）再读，不许无上限 `readFileSync`；切尾必须在**投影之后**。
//
// 投影与主对话同形（§5.1）：`portal/src/transcript-fold.js#foldLedgerRecords`（0.23「一条消息一落盘」
// 的读侧折叠，`runner/lib/store.js#load` 用的同一份口径）→ `erix-agent` 包根导出的
// `projectTranscriptForDisplay`（`session-view.js` 同一个函数）→ 最后才 `slice(-tail)`。
// ⚠ `foldLedgerMessages` / `foldMessageRows` **不在 `erix-agent` 的导出面**（实测 `undefined`，
// 深引被 `exports` 挡）⇒ 只能用本站镜像；那正好也是 AGENTS §8.52 那份「两份 SHARED-FOLD-CORE 逐字节
// 对拍」的既有保证在本入口的复验。顺序反过来（先切原始行再折）会把一轮切成半轮：`:msg:` 分片行与
// 它的载体行分散在切界两侧，折叠拿到缺片的一轮。
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { projectTranscriptForDisplay } from 'erix-agent';
import { foldLedgerRecords } from './transcript-fold.js';
import { fetchSession } from './sessions.js';
import { validateFdeName } from './projects.js';

/** 与 `SessionError` / `DirError` 同形的错误载体（`http.js` 顶层统一映射到标准错误信封）。 */
export class DelegationError extends Error {
  constructor(code, message, { httpStatus = 400, details } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/**
 * 父 run id：本站 `runs.id`（uuid）。**小写**——路径参数与 query 参数在 `http.js` 里一律经
 * `decodeUuid` 归一化（UUID 大小写等价，而名册目录名是引擎写的小写值，用大写串去拼目录会恒 miss）。
 */
export const PARENT_RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 子 run id：引擎 `createDelegateTool` 用 `randomUUID` 生成并加 `sub-` 前缀（`tool.js`），故形状封闭。 */
export const CHILD_RUN_ID_RE = /^sub-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 账本大小上限（设计 §5.1「超过 8MB 直接 413 并提示」，与 `session-partial-output` 的成本口径同族）。 */
export const DELEGATE_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;
export const DELEGATE_TAIL_DEFAULT = 100;
export const DELEGATE_TAIL_MAX = 500;

/** 名册 `state` 的封闭 7 值（引擎 `roster.js#ROSTER_STATES` 同值；文档 §4.4c 写的是同一份词汇）。 */
export const ROSTER_STATES = Object.freeze([
  'queued', 'running', 'completed', 'failed', 'aborted', 'timeout', 'interrupted',
]);

/**
 * `#593`：**活态**名册 state —— 只有这两个 state 的子才允许读它的账本（设计
 * `delegation-activity-2026-11-16.md` §4.1 纪律 1）。与前端 `portal/frontend/src/lib/delegate.ts#DELEGATE_LIVE_STATES`
 * 逐值同尺（那边是 TS，本模块是 Node 侧，两边各存一份由判据 `J2`/前端的对拍钉住）。
 * ⚠ **在 7 值之外的 state 一律按非活态**（不读盘）：词汇表封闭性是写侧（引擎）的不变量，读侧只拿它
 * 决定「要不要多花一次磁盘读」，不拿它过滤条目（`B11` 钉住「未知 state 照原样下发」）。代价：引擎
 * 哪天新增一个*活态*，这边会先给一版 `activity.kind:'none'`（不是错数据，只是没有摘要）。
 */
export const LIVE_ROSTER_STATES = Object.freeze(new Set(['queued', 'running']));

/**
 * `#593`：`runs.status` 的**终态**集（`docs/data/schema.sql:206` 的 CHECK 六值减去
 * `sessions.js#ACTIVE_RUN_STATES` 那三个活态值）。只用来算 `activity.stale`（§4.4 ③），
 * **不**用来判子 run 死活（门户在宿主、名册 `pid` 在容器，两个 PID namespace）。
 */
export const TERMINAL_RUN_STATUSES = Object.freeze(new Set(['finished', 'failed']));

/** `#593`：`activity.args` / `activity.text` 的**正文**上限（码点数；被截断时另加末位 `…` ⇒ 总长最多 121）。 */
export const ACTIVITY_SNIPPET_MAX_CHARS = 120;

/** 会话 id 的形状（与 `sessions.js#UUID_RE` 同一条尺，那边没导出 ⇒ 这里第二份，由 `J5` 钉行为）。 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertShape(value, re, field, label) {
  if (typeof value !== 'string' || !re.test(value)) {
    throw new DelegationError('validation_failed', `${label} 形态非法`, { details: { field } });
  }
  return value;
}

/**
 * `#593`：`activity.args` / `activity.text` 的截断口径（**说清楚，别让人猜**）：
 *   · **正文**最多 `ACTIVITY_SNIPPET_MAX_CHARS` = **120 个码点**（与上游 `projection.js#MAX_ARGS_PREVIEW` 同值）；
 *   · 被截断时**末尾补一个 `…`** ⇒ 返回串的**总长最多 121 个码点**（120 正文 + 1 省略号），
 *     与上游 `truncated()` 完全同形；没超限 ⇒ 原样返回（不 trim 掉用户自己的空白之外的东西，只去首尾空白）。
 *   · 上游给的 `argsSummary` 本身已是「≤120 + `…`」的形状 ⇒ 这里再过一道是幂等的。
 * ⚠ 按**码点**数截（`Array.from`）而不是 `.length`：`.length` 数 UTF-16 单元，一个 emoji / 生僻字
 * 算两个 ⇒ 同样标称 120 的上游 `argsSummary` 会被我们再切短一截，还可能把代理对切成半个（乱码）。
 */
function clipSnippet(value, max = ACTIVITY_SNIPPET_MAX_CHARS) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const chars = Array.from(text.trim());
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, max).join('')}…`;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** 一个投影 turn 上「能定性为动作」的东西（上游 `projectTranscriptForDisplay` 的输出面）。 */
function hasToolResult(turn) {
  const blocks = Array.isArray(turn?.blocks) ? turn.blocks : [];
  if (blocks.some((b) => b?.type === 'tool_result')) return true;
  return (Array.isArray(turn?.toolCalls) ? turn.toolCalls : [])
    .some((c) => nonEmptyString(c?.resultPreview));
}

/**
 * `#593`（设计 §4.1「最近一个动作」）：**纯函数**，输入 = `foldLedgerRecords` → `projectTranscriptForDisplay`
 * 之后的展示消息（与抽屉同源），输出 = `activity` 里除 `at` / `stale` 以外的部分。
 *
 * 从后往前扫，**第一条**能定性为动作的消息就是结果（顺序即优先级，不许重排）：
 *   1. 有带 `argsSummary` 的 `toolCalls` ⇒ `kind:'tool'`（`tool` = 该 call 的 `name`，`args` = `argsSummary`）；
 *   2. `role === 'assistant'` 且有正文 ⇒ `kind:'text'`；
 *   3. 只有工具结果 ⇒ `kind:'tool_result'`（`text` = 结果预览）；
 *   4. 一条都没有 ⇒ `kind:'none'`（只回 `{turns, kind}`，**拿不到的键不写**）。
 *
 * ⚠ **不许**从原始 JSONL 行里自己拼（判据 8：用带 `partOf` 分片行的夹具钉住）——折叠口径的唯一来源
 * 是 `foldLedgerRecords` → `projectTranscriptForDisplay`，与 `getDelegateTranscript` 同一条链。
 * ⚠ 一个都没定性成功 ⇒ `kind:'none'` 而不是猜一个（「不给的字段不写」是本站既有纪律）。
 */
export function summarizeActivity(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = { turns: list.length, kind: 'none' };
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const turn = list[i];
    if (turn === null || typeof turn !== 'object') continue;
    const calls = (Array.isArray(turn.toolCalls) ? turn.toolCalls : [])
      .filter((c) => c !== null && typeof c === 'object' && nonEmptyString(c.argsSummary));
    if (calls.length > 0) {
      const last = calls[calls.length - 1];
      out.kind = 'tool';
      out.tool = clipSnippet(last.name ?? '', 60);
      out.args = clipSnippet(last.argsSummary);
      return out;
    }
    if (turn.role === 'assistant' && nonEmptyString(turn.text)) {
      out.kind = 'text';
      out.text = clipSnippet(turn.text);
      return out;
    }
    if (hasToolResult(turn)) {
      const preview = (Array.isArray(turn.toolCalls) ? turn.toolCalls : [])
        .filter((c) => c !== null && typeof c === 'object' && nonEmptyString(c.resultPreview))
        .map((c) => c.resultPreview);
      out.kind = 'tool_result';
      out.text = clipSnippet(preview.length > 0 ? preview[preview.length - 1] : '');
      if (out.text === '') delete out.text; // 拿不到就不写，不给空串当摘要
      return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// `#593` 进程级 activity 缓存（设计 §4.1 纪律 2：子 run 逐消息追加 ⇒ 2s 一轮里绝大多数轮次没变）
// ---------------------------------------------------------------------------

/**
 * 键 = `childRunId|size|mtimeMs`（设计口径），值 = **不含 `at` / `stale`** 的摘要核心：
 * `at` 每次现取（它就是这条键的一部分，重取零成本），`stale` 来自 DB 的父 run 状态，
 * **不能**进缓存（父终态那一瞬间要立刻反映，缓存里没有）。
 *
 * 为什么必须有上限（不写成永不清的 Map）：键里带 `(size,mtime)` ⇒ 子每写一行就多一个新键，
 * 一个长 run 能造出上百条，而**旧键永远不会再命中**（mtime 只往前走）。两道闸：
 *   · LRU 上限 `ACTIVITY_CACHE_MAX_ENTRIES`（Map 保留插入序 ⇒ 淘汰第一个就是最久未用）；
 *   · TTL `ACTIVITY_CACHE_TTL_MS`：子 run 终态后再没人轮它，靠 TTL 把那些死键收掉。
 * 缓存丢失只意味着「多读一次盘」，不改变任何返回值 ⇒ 测试用 `clearActivityCache()` 保证隔离。
 */
export const ACTIVITY_CACHE_MAX_ENTRIES = 256;
export const ACTIVITY_CACHE_TTL_MS = 5 * 60 * 1000;
const activityCache = new Map(); // key -> { expiresAt, core }

/** 测试缝（也是将来接指标的口）：清空进程级 activity 缓存。 */
export function clearActivityCache() {
  activityCache.clear();
}

/** 测试缝：当前缓存条数（用来钉「不会无限涨」）。 */
export function activityCacheSize() {
  return activityCache.size;
}

function activityCacheGet(key) {
  const hit = activityCache.get(key);
  if (hit === undefined) return undefined;
  if (hit.expiresAt <= Date.now()) {
    activityCache.delete(key);
    return undefined;
  }
  // 命中就重新插入 ⇒ Map 的插入序退化成「最近使用序」，淘汰头部即 LRU。
  activityCache.delete(key);
  activityCache.set(key, hit);
  return hit.core;
}

function activityCacheSet(key, core) {
  activityCache.set(key, { expiresAt: Date.now() + ACTIVITY_CACHE_TTL_MS, core });
  while (activityCache.size > ACTIVITY_CACHE_MAX_ENTRIES) {
    activityCache.delete(activityCache.keys().next().value);
  }
}

/** 第二道防线：两个 id 已被正则锁死，`..` 进不来；仍断言拼出来的路径没跑出 `delegation/` 之外。 */
function assertUnderRoot(root, target, field) {
  const rel = path.relative(root, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new DelegationError('validation_failed', '路径逃逸 delegation 根', { details: { field } });
  }
  return target;
}

/**
 * `<userSpaceRoot>/<fde>/home/delegation`（设计 §3「门户侧对应宿主路径」）。
 * `fdeName` 取会话属主的 `users.fde_name`（`sessions.js#createSession` 的既有取法与既有错误口径）。
 */
export function delegationRoot({ userSpaceRoot, fdeName } = {}) {
  if (typeof userSpaceRoot !== 'string' || userSpaceRoot === '') {
    throw new DelegationError('internal', 'userSpaceRoot 未配置', { httpStatus: 500 });
  }
  if (typeof fdeName !== 'string' || fdeName === '' || !validateFdeName(fdeName).ok) {
    // 与 sessions.js:217-224 逐字同口径（同一个 field、同一句话），不另造词汇。
    throw new DelegationError('validation_failed', '当前用户未配置 fde_name，无法确定家目录', {
      details: { field: 'fde_name' },
    });
  }
  return path.resolve(userSpaceRoot, fdeName, 'home', 'delegation');
}

/** `<delegation>/roster/<parentRunId>`（名册按**父 run** 分片 ⇒ 一个 run 看不见别的 run 的子）。 */
export function rosterDir({ parentRunId, ...root } = {}) {
  const base = delegationRoot(root);
  assertShape(parentRunId, PARENT_RUN_ID_RE, 'runId', 'runId');
  return assertUnderRoot(base, path.resolve(base, 'roster', parentRunId), 'runId');
}

/**
 * `<delegation>/transcripts/<childRunId>.jsonl`。
 * 自己拼而不引引擎的 `transcriptPath`：那个 helper 在 `erix-agent` 的 `./src/store/file.js` 里，
 * 深引被包 `exports` 挡（设计 §2 已实测 `ERR_PACKAGE_PATH_NOT_EXPORTED`），而 `sub-<uuid>` 过
 * `safeRunId` 恒等 ⇒ 手拼在这里是**与引擎同形**的，不是近似。
 */
export function transcriptPath({ childRunId, ...root } = {}) {
  const base = delegationRoot(root);
  assertShape(childRunId, CHILD_RUN_ID_RE, 'childRunId', 'childRunId');
  return assertUnderRoot(base, path.resolve(base, 'transcripts', `${childRunId}.jsonl`), 'childRunId');
}

// ---------------------------------------------------------------------------
// 依赖注入缝：判据要数「有没有读盘」，所以 fs 必须可换（默认 = node:fs）。
// 只暴露本模块真正用到的四个动作，测试里的 spy 因此能穷举读面。
// ---------------------------------------------------------------------------
export const nodeFs = {
  readdir: (dir) => fsp.readdir(dir),
  readFile: (file) => fsp.readFile(file, 'utf8'),
  stat: (file) => fsp.stat(file),
  existsSync: (file) => fsSync.existsSync(file),
  /**
   * `#593`：**有界读** —— 至多取 `maxBytes + 1` 个字节，读满了就不继续。
   * 返回 `{ text, tooLarge }`：`tooLarge === true` ⇒ 文件比 `maxBytes` 大（此时 `text` 无意义，丢弃）。
   *
   * 为什么不是 `stat` 判完再 `readFile`：子 run 的账本是**正在被引擎追加写**的文件，`stat` 与
   * `readFile` 之间它可以涨过上限，而无上限 `readFile` 会把**实际字节数**全部拉进内存
   * ⇒ 那个 8 MiB 闸在并发追加下只是建议（#593 独立验收 BLOCK 里那条竞态）。本方法把上限从
   * 「事后断言语」变成「读取本身的约束」：无论文件多大，进内存的不超过 `maxBytes + 1`。
   * ⚠ 有意的口径差异：`getDelegateTranscript`（抽屉）**不用**它 —— 那边契约是 413 带 `details.size`，
   *   尺寸语义要给用户看，不属本单范围（一字未动）。
   */
  readBounded: async (file, maxBytes) => {
    const handle = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buf, 0, maxBytes + 1, 0);
      if (bytesRead > maxBytes) return { text: '', tooLarge: true };
      return { text: buf.toString('utf8', 0, bytesRead), tooLarge: false };
    } finally {
      await handle.close();
    }
  },
};

/** 名册目录里一个候选文件（其它名字一律不算候选：引擎原子写的临时件叫 `<id>.json.tmp-<pid>-<n>`）。 */
const ROSTER_FILE_RE = /^(.+)\.json$/;

function toMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 名册记录 → 下发 DTO（**逐字段白名单**，不许把整条 record 原样下发：里面还有 `resultText`
 * 一整段子 run 终稿、`pid`、`statusPath`、`verification`、`taskDigest` 这些内部字段，
 * 下发它们等于把 UI 没要的东西变成契约）。
 * `childRunId` 取**文件名**而不是 `record.runId`（引擎自己的 `parseRosterFile` 也这么裁定：
 * 记录里的 runId 与文件名不符 = 损坏件），调用方已校验过文件名形状。
 */
function rosterItem(record, childRunId, hasTranscript) {
  return {
    childRunId,
    state: record.state,
    cwd: typeof record.cwd === 'string' ? record.cwd : null,
    model: typeof record.model === 'string' ? record.model : null,
    createdAt: toMs(record.createdAt),
    endedAt: toMs(record.endedAt),
    updatedAt: toMs(record.updatedAt),
    // 引擎 reason 的**字符串**（P1 已把 `no_tool` / `continuation_exhausted` 归一成 `end_turn`
    // ⇒ 名册 `completed`）。对象形态的 termination 一律 null：那是 P1 判据 2 要挡的缺陷形状。
    termination: typeof record.termination === 'string' ? record.termination : null,
    errorMessage: typeof record.errorMessage === 'string' ? record.errorMessage : null,
    resultTruncated: record.resultTruncated === true,
    hasTranscript,
  };
}

/** 账本 JSONL → 能解析的记录数组（坏行/空行跳过）。两个入口共用（`#593` 抽出的共享段）。 */
function parseLedgerRecords(raw) {
  const records = [];
  for (const line of String(raw).split('\n')) {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (text.trim() === '') continue; // 空行/末行残缺：跳过，不 500（与引擎 file store 的尾碎片口径一致）
    try {
      const record = JSON.parse(text);
      if (record !== null && typeof record === 'object') records.push(record);
    } catch {
      // 坏行跳过：账本是**追加写**的文件，崩溃留下的最后一行残缺是常态而不是异常。
    }
  }
  return records;
}

/**
 * 账本记录 → 展示消息（**唯一**一条链：`foldLedgerRecords` → `projectTranscriptForDisplay`）。
 * 名册列表的 `activity` 与账本抽屉都走它 ⇒ 「最近一个动作」与抽屉看到的不会漂移。
 */
function projectLedgerRecords(records) {
  return projectTranscriptForDisplay(foldLedgerRecords(records));
}

/**
 * 会话属主 + `fde_name` + 父 run 归属（三个入口共用的一条前置）。
 * 属主校验直接复用 `sessions.js#fetchSession`：非属主与不存在**抛的就是同一个 404**，
 * 响应体因此与 `GET /api/sessions/:id` 的「session 不存在」逐字相同（判据 1）。
 */
async function resolveScope({ pool, sessionId, userId, parentRunId, userSpaceRoot }) {
  assertShape(parentRunId, PARENT_RUN_ID_RE, 'runId', 'runId');
  await fetchSession(pool, sessionId, userId);
  const fde = await pool.query(
    `SELECT fde_name FROM users WHERE id = $1 AND status = 'active'`,
    [userId],
  );
  const fdeName = fde.rows?.[0]?.fde_name;
  const root = { userSpaceRoot, fdeName };
  // 先 validate 过 fdeName 再拼路径（delegationRoot 会拒非法形状），但**归属查询必须先跑完**：
  // 越权的人不该从错误码里读出「这个 session 存在」——所以 404 永远先于 400 抛出。
  delegationRoot(root);
  const owned = await pool.query(
    `SELECT 1 FROM runs WHERE id = $1 AND session_id = $2`,
    [parentRunId, sessionId],
  );
  if (!owned.rows?.length) {
    throw new DelegationError('not_found', 'delegate not found', { httpStatus: 404 });
  }
  return { fdeName, parentRunId, userSpaceRoot };
}

/**
 * `#593`：`activity=1` 专属的前置——与 `resolveScope` **同语义**但**只一条 SQL**（设计 §4.1 纪律 4）。
 *
 * 为什么不是「复用 `resolveScope` 再加一条查父状态」：那是 4 条 SQL，而抽屉 2s 一轮。
 * `chat_sessions` × `users` × `runs` 一条 join，顺带取回父 run 的 `status`（算 `stale`）。
 *
 * 两个 LEFT JOIN 而不是 INNER：`users` 行缺失/非 active 要退到与今天同一句 400 `fde_name`
 * （不是被 join 兼平成 404）；`runs` 行缺失要退到 `delegate not found` 404。
 * 顺序（判据 5）：会话 404 → `runId` 形状 400 → `fde_name` 400 → 父 run 404。
 * ⚠ `parentRunId` 形状**先判再送进 SQL**：uuid 列与一个非 uuid 串比较会让 PG 直接 22P02（= 500），
 *   而那是客户端输入；形状合法才作为参数传，否则送 `null`（join 不命中，下一步立刻 400）。
 */
async function resolveScopeWithRunStatus({ pool, sessionId, userId, parentRunId, userSpaceRoot }) {
  // sessionId 的形状只能 404（与 `fetchSession` 逐字同口径）：形状不对也**不能**泄存在性。
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    throw new DelegationError('not_found', 'session not found', { httpStatus: 404 });
  }
  const shapeOk = typeof parentRunId === 'string' && PARENT_RUN_ID_RE.test(parentRunId);
  const res = await pool.query(
    `SELECT s.id, s.user_id, s.status, u.fde_name, r.id AS run_id, r.status AS run_status
       FROM chat_sessions s
       LEFT JOIN users u ON u.id = s.user_id AND u.status = 'active'
       LEFT JOIN runs r ON r.session_id = s.id AND r.id = $2
      WHERE s.id = $1`,
    [sessionId, shapeOk ? parentRunId : null],
  );
  const row = res.rows?.[0];
  if (!row || row.user_id !== userId || row.status !== 'active') {
    throw new DelegationError('not_found', 'session not found', { httpStatus: 404 });
  }
  assertShape(parentRunId, PARENT_RUN_ID_RE, 'runId', 'runId');
  const fdeName = row.fde_name;
  const scope = { fdeName, parentRunId, userSpaceRoot };
  delegationRoot(scope); // 同上：fde_name 非法 ⇒ 与 sessions.js 同一句 400（在会话 404 之后）
  if (row.run_id == null) {
    throw new DelegationError('not_found', 'delegate not found', { httpStatus: 404 });
  }
  return { ...scope, parentRunStatus: typeof row.run_status === 'string' ? row.run_status : null };
}

/**
 * `#593`：一个子的 `activity` 对象（设计 §4.1 + §4.4 ③）。**本函数是本模块唯一的账本内容读点**（除抽屉）。
 *
 * 三道成本闸（全部有判据）：
 *   1. **非活态 ⇒ 零文件动作**（连 `stat` 都不发）：终子的终稿在名册 `resultText` 里，抽屉已能看全文。
 *      所以它的 `activity` 只有 `{ kind:'none', turns:null, stale:false }`（**不写 `at`**：没 `stat` 就没写盘证据）。
 *   2. `stat` 说没变 ⇒ 用缓存，**零内容读**（稳态成本 ≈ N 次 `stat`）。
 *   3. `size > 8 MiB` ⇒ 不读，`{ at, turns:null, kind:'none', stale }`——**不 413 也不 500**：
 *      面板不是正文读取面，降级比报错合理（与抽屉的 413 口径故意不同，那边用户主动要看正文）。
 *      ⚠ 上限由**两道**闸兑现：`stat` 那条只是省一次读的便宜路径，**真闸是 `fsImpl.readBounded`**：
 *      账本正被引擎追加写，stat-then-read 之间它可以涨过上限（#593 独立验收 BLOCK 的竞态），
 *      所以进内存的字节数只能由「读」本身限制，不能由「之前那次 stat」保证。
 */
async function buildActivity({ scope, childRunId, state, parentRunStatus, fsImpl }) {
  // 设计 §4.4 ③：父 run 已终态**而**子仍写着活态 ⇒ stale。后台子的真实形状：父跑完 ⇒ worker 200ms
  // 后 process.exit(0)（runner/worker.js:1287）⇒ 嵌套的子 runLoop 随进程消失 ⇒ 引擎的 finishRun
  // 永不执行 ⇒ 名册**永久**停在 running。门户不判死、不改写名册，也不拿名册 `pid` 判活（那是容器内 PID）。
  const live = LIVE_ROSTER_STATES.has(state);
  const stale = live === true && TERMINAL_RUN_STATUSES.has(parentRunStatus) === true;
  if (!live) return { kind: 'none', turns: null, stale };

  const file = transcriptPath({ ...scope, childRunId });
  let st;
  try {
    st = await fsImpl.stat(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return { kind: 'none', turns: null, stale }; // 账本还没落盘：没得读
    throw err;
  }
  const at = Number.isFinite(st?.mtimeMs) ? Math.floor(st.mtimeMs) : null;
  if (!Number.isFinite(st?.size) || st.size > DELEGATE_TRANSCRIPT_MAX_BYTES) {
    return { at, kind: 'none', turns: null, stale };
  }
  // 缓存键里放**绝对路径**而不是裸 childRunId：路径 = fde_name + childRunId，比设计里那条 (childRunId,size,mtime)
  // 更严（不同 FDE 的同名账本不会互相打脏），而「(size,mtime) 变 ⇒ 换键」一条不少。
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  let core = activityCacheGet(key);
  if (core === undefined) {
    // 有界读：进内存的字节数本身就被 `maxBytes` 锁住，不依赖 stat 那一瞬间的准确性。
    // ENOENT（stat 后被人扫掉）与 tooLarge（stat 后长过了上限）走同一支降级。
    let read;
    try {
      read = await fsImpl.readBounded(file, DELEGATE_TRANSCRIPT_MAX_BYTES);
    } catch (err) {
      if (err?.code === 'ENOENT') return { at, kind: 'none', turns: null, stale };
      throw err;
    }
    if (read?.tooLarge === true) return { at, kind: 'none', turns: null, stale };
    core = summarizeActivity(projectLedgerRecords(parseLedgerRecords(read?.text ?? '')));
    activityCacheSet(key, core);
  }
  // 键序 = 契约序；`stale` **必须**每次现算（它在 DB 里，不在缓存里）。
  return {
    at,
    turns: core.turns,
    kind: core.kind,
    ...(core.tool === undefined ? {} : { tool: core.tool }),
    ...(core.args === undefined ? {} : { args: core.args }),
    ...(core.text === undefined ? {} : { text: core.text }),
    stale,
  };
}

/**
 * `GET /api/sessions/:id/delegates?runId=<parentRunId>[&activity=1]` —— 某个父 run 的子 run 名册。
 *
 * 名册目录不存在 ⇒ `{ items: [], skipped: 0 }`（**不是 404**：还没派过子 run 是正常态，
 * 而抽屉/工具卡每 2s 轮询一次，404 会让「刚点下 delegate、文件还没落」看起来像错误）。
 * 坏文件（JSON 解析失败、runId 与文件名不符、非对象）跳过并计数，**不 500**。
 *
 * `activity: true`（`#593`，上游 query 只认字符串 `1`）：给每条 item 追加一个 `activity` 对象，
 * 并改走一条 join。**不带（或带 `activity=0`/`activity=xyz`）时响应与今天逐字段相同**：一个键不多、
 * 一个键不少，也不读任何账本（判据 1）。DTO 白名单不变：`transcriptPath`/`pid`/`statusPath`/
 * `verification` 仍不下发，`activity` 是**新加的一个键**，不是把 record 摊开。
 */
export async function listDelegates({
  pool, sessionId, userId, parentRunId, userSpaceRoot, fsImpl = nodeFs, activity = false,
} = {}) {
  const wantActivity = activity === true;
  const scope = wantActivity
    // eslint-disable-next-line no-await-in-loop
    ? await resolveScopeWithRunStatus({ pool, sessionId, userId, parentRunId, userSpaceRoot })
    : await resolveScope({ pool, sessionId, userId, parentRunId, userSpaceRoot });
  const dir = rosterDir({ ...scope });

  let names;
  try {
    names = await fsImpl.readdir(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return { items: [], skipped: 0 }; // 从未派生子 run：正常空态
    throw err;
  }

  const items = [];
  let skipped = 0;
  for (const name of names) {
    const m = ROSTER_FILE_RE.exec(name);
    if (!m) continue; // 不是候选文件（原子写的临时件等）⇒ 不计入 skipped，它本来就不该被读
    const childRunId = m[1];
    if (!CHILD_RUN_ID_RE.test(childRunId)) {
      skipped += 1; // 名字就不是子 run id ⇒ 损坏件，与引擎 `assertSafeRunId` 同一条路
      continue;
    }
    let record;
    try {
      const raw = await fsImpl.readFile(path.join(dir, name));
      record = JSON.parse(raw);
    } catch {
      skipped += 1; // 解析失败：跳过并计数，不让一个坏文件把整个列表打成 500
      continue;
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      skipped += 1;
      continue;
    }
    // **文件名是身份**（引擎 roster.js:200 的同一判据）：两者不符 ⇒ 损坏件。这条同时挡掉
    // 「记录里的 runId 是 `../../x` 之类，被拿去拼 transcript 路径」那类越界。
    if (record.runId !== childRunId) {
      skipped += 1;
      continue;
    }
    // `state` 非字符串 ⇒ 损坏件（引擎 `roster.js:205-208` 同一条判据）。但在 7 值**之外**的字符串
    // 照原样下发：词汇表的封闭性是写侧（引擎 `writeRecord`）的不变量，读侧不拿它当过滤器 ——
    // 否则引擎哪天加一个状态，就会把真子 run 静默藏掉。`S1` 钉住「非字符串 ⇒ skipped」。
    if (typeof record.state !== 'string') {
      skipped += 1;
      continue;
    }
    const file = transcriptPath({ ...scope, childRunId });
    // 成本红线：填这个字段只许 `existsSync`，**不许**为了它读文件内容（判据 10）。
    const item = rosterItem(record, childRunId, fsImpl.existsSync(file) === true);
    if (wantActivity) {
      // 串行而不是 `Promise.all`：子 run 个位数（并发缺省 2），而串行让「最多读几个账本」可人数
      // （判据 2/3 靠 spy 计数），并发会把读面搅成不可断言。
      // eslint-disable-next-line no-await-in-loop
      item.activity = await buildActivity({
        scope, childRunId, state: record.state, parentRunStatus: scope.parentRunStatus, fsImpl,
      });
    }
    items.push(item);
  }

  items.sort((a, b) => (a.createdAt ?? Number.POSITIVE_INFINITY) - (b.createdAt ?? Number.POSITIVE_INFINITY));
  return { items, skipped };
}

/**
 * `GET /api/sessions/:id/delegates/:childRunId?runId=<parentRunId>&tail=N` —— 子 run 账本的只读投影。
 *
 * 顺序（判据 5/6 的红线，写死在这里）：读全量行 → `foldLedgerRecords` → `projectTranscriptForDisplay`
 * → **才** `slice(-tail)`。切尾在投影前 ⇒ 半条逻辑消息 + 缺片的一轮。
 * `totalTurns` 是**投影后全量**的逻辑消息数（切尾前），`truncated = totalTurns > tail`；
 * 消息的 `seq`/`id` 用全量下标 ⇒ 向前翻页时同一条消息的 id 不漂移。
 */
export async function getDelegateTranscript({
  pool, sessionId, userId, parentRunId, childRunId, tail = DELEGATE_TAIL_DEFAULT,
  userSpaceRoot, fsImpl = nodeFs,
} = {}) {
  const scope = await resolveScope({ pool, sessionId, userId, parentRunId, userSpaceRoot });
  assertShape(childRunId, CHILD_RUN_ID_RE, 'childRunId', 'childRunId');
  if (!Number.isInteger(tail) || tail < 1 || tail > DELEGATE_TAIL_MAX) {
    throw new DelegationError('validation_failed', `tail 必须是 1..${DELEGATE_TAIL_MAX} 的整数`, {
      details: { field: 'tail' },
    });
  }

  // 名册存在性（判据 3）：形状合法**不等于**这个子 run 属于这个父 run。不查名册就读账本，
  // 等于任何拿到会话的人都能用 id 猜着读别人家目录里的文件。
  let state = null;
  try {
    const raw = await fsImpl.readFile(path.join(rosterDir({ ...scope }), `${childRunId}.json`));
    const record = JSON.parse(raw);
    state = typeof record?.state === 'string' ? record.state : null;
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new DelegationError('not_found', 'delegate not found', {
        httpStatus: 404, details: { reason: 'not_in_roster' },
      });
    }
    // 名册在但读不出 state（脏 JSON）：不给 state 也不 500——账本才是正文来源。
  }

  const file = transcriptPath({ ...scope, childRunId });
  let st;
  try {
    st = await fsImpl.stat(file);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      // 账本还没落盘（子 run 刚起、或 TTL 清理过）。与「没有这个子 run」区分开，
      // 前端的空态文案要靠它（设计 §6.2：`starting` / `no_transcript` / 错误三态）。
      throw new DelegationError('not_found', 'delegate transcript not found', {
        httpStatus: 404, details: { reason: 'no_transcript' },
      });
    }
    throw err;
  }
  if (st.size > DELEGATE_TRANSCRIPT_MAX_BYTES) {
    throw new DelegationError('payload_too_large', '子 run 账本超过读取上限', {
      httpStatus: 413, details: { size: st.size, max_bytes: DELEGATE_TRANSCRIPT_MAX_BYTES },
    });
  }

  const raw = await fsImpl.readFile(file);
  const projected = projectLedgerRecords(parseLedgerRecords(raw));
  const totalTurns = projected.length;
  const start = Math.max(0, totalTurns - tail);
  const messages = projected.slice(start).map((turn, offset) => {
    const index = start + offset;
    const ts = typeof turn?.ts === 'string' ? Date.parse(turn.ts) : Number.NaN;
    // 宿主字段在前、上游字段在后 ⇒ 上游同名字段赢（#95 红线：宿主不往投影里塞东西）。
    return {
      id: `${childRunId}:${index}`,
      seq: index,
      run_id: childRunId,
      created_at: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
      ...turn,
    };
  });

  return { childRunId, state, messages, truncated: totalTurns > tail, totalTurns };
}
