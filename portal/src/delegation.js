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

function assertShape(value, re, field, label) {
  if (typeof value !== 'string' || !re.test(value)) {
    throw new DelegationError('validation_failed', `${label} 形态非法`, { details: { field } });
  }
  return value;
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
 * `GET /api/sessions/:id/delegates?runId=<parentRunId>` —— 某个父 run 的子 run 名册。
 *
 * 名册目录不存在 ⇒ `{ items: [], skipped: 0 }`（**不是 404**：还没派过子 run 是正常态，
 * 而抽屉/工具卡每 2s 轮询一次，404 会让「刚点下 delegate、文件还没落」看起来像错误）。
 * 坏文件（JSON 解析失败、runId 与文件名不符、非对象）跳过并计数，**不 500**。
 */
export async function listDelegates({
  pool, sessionId, userId, parentRunId, userSpaceRoot, fsImpl = nodeFs,
} = {}) {
  const scope = await resolveScope({ pool, sessionId, userId, parentRunId, userSpaceRoot });
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
    items.push(rosterItem(record, childRunId, fsImpl.existsSync(file) === true));
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

  const projected = projectTranscriptForDisplay(foldLedgerRecords(records));
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
