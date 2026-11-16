/**
 * issue #538（W4b）：宏「审查 run」的判决解析、事实工作包、回灌与生命周期。
 *
 * 分工与红线：
 *  - W2 已 `claimMacroRun`（本模块拿到**已占位**的 `macroRunId`，只 `finishMacroRun`，不 claim；
 *    幂等 `(assignment, anchor, criterion, bucket)` 是 claim 的键，本模块不再造一套）。
 *  - W4a（`macro-snapshot.js`）负责快照构建；它的 7+1 个失败 reason 在这里是**失败出口**，
 *    不是「判成没过」。
 *  - `finishMacroRun` 有终态闸（terminal → 非 terminal 抛 409）：本模块每个 macro run
 *    只收口一次，且从不把终态行往回推。
 *
 * 失败出口口径（④）：超时 / LLM 失败 / 快照失败 ⇒ `failed` + `unclassified`（没判成）；
 * 首行非法 ⇒ `done` + `unclassified` + `verdict_raw`（判了但判不了）；
 * 回灌 409 ⇒ `skipped` + `deferred` + **保留原判决**（不重试）。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { finishMacroRun, isAssignmentExpired, MACRO_VERDICTS, MacroError } from './macros.js';
import { postMessage, SessionError } from './sessions.js';
import { SNAPSHOT_FAILURE_REASONS } from './macro-snapshot.js';
import { fetchRunAssistantText, fetchUserTextTurns } from './session-text.js';

const execFileAsync = promisify(execFile);

/** 回灌正文前缀（09 篇口径：系统注入的话要能和人话分开）。 */
export const REMEDIATION_PREFIX = '[系统] ';

/** 首行判决：完整匹配（锚定、不 includes、不 trim 左端——` 结论：通过` 是非法首行）。 */
export const VERDICT_LINE_RE = /^结论：(通过|整改|未证实有改动|需人工)$/;

/** 标签 → 归一化 verdict。枚举本身以 `macros.js` `MACRO_VERDICTS` 为准，这里只是映射。 */
export const VERDICT_BY_LABEL = Object.freeze({
  通过: 'pass',
  整改: 'red',
  未证实有改动: 'no-op-claim',
  需人工: 'needs-human',
});

/** 工作包总长上限（8 KB，超出截断并标注）。 */
export const MAX_BRIEF_BYTES = 8 * 1024;

/** 回灌递归上限：depth ≤ 1（0 的审查可回灌，1 的审查只判不回灌）。 */
export const MAX_REMEDIATION_DEPTH = 1;

/**
 * ② 首行判决解析（**fail closed**）。
 *
 * 口径：按 `\r?\n` 切首行，只 trim **右端**空白（`\r\n` 行尾的 `\r` 由分隔符吃掉，
 * 行尾空格允许；左端一个字符都不许动，BOM/缩进/Markdown `## ` 都留在串里 ⇒ 不匹配）。
 * 缺行 / BOM / Markdown / 大小写或空格变化 / 未知值 / 截断 ⇒ `'unclassified'`，
 * 原话由调用方存进 `verdict_raw`。正文里偶然出现的「结论：通过」**不是**首行，不算。
 */
export function parseVerdictLine(text) {
  const first = String(text ?? '').split(/\r?\n/)[0].replace(/\s+$/, '');
  const m = VERDICT_LINE_RE.exec(first);
  if (!m) return { verdict: 'unclassified', verdictRaw: first, matched: false };
  const verdict = VERDICT_BY_LABEL[m[1]];
  // 映射表与 MACRO_VERDICTS 漂移是配置错误，不许静默吞（宁可抛也不写脏枚举）。
  if (!MACRO_VERDICTS.includes(verdict)) {
    return { verdict: 'unclassified', verdictRaw: first, matched: false };
  }
  return { verdict, verdictRaw: first, matched: true };
}

/** UTF-8 安全截断：按字节切，半个多字节字符不留。 */
function clipUtf8(s, maxBytes) {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return { text: s, truncated: false };
  return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

/**
 * 从 transcript 轮记录里提取原 run 的验证命令与退出码（①）。
 * 形状是引擎透传的 JSONB，跨版本不保证稳定 ⇒ **防御式递归扫描**：
 * 任何带 `command`（或 `input.command`）且能找到退出码线索的对象都算一条。
 */
export function extractVerificationCommands(transcriptRows) {
  const candidates = [];
  const exitCodeOf = (node) => {
    for (const key of ['exit_code', 'exitCode', 'code']) {
      if (Number.isInteger(node?.[key])) return node[key];
    }
    return null;
  };
  const walk = (node) => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const command = typeof node.command === 'string' ? node.command
      : typeof node.input?.command === 'string' ? node.input.command : null;
    if (command) {
      const exitCode = exitCodeOf(node) ?? exitCodeOf(node.result) ?? exitCodeOf(node.toolResult);
      candidates.push({ command, exitCode });
    }
    for (const value of Object.values(node)) walk(value);
  };
  for (const row of transcriptRows ?? []) {
    walk(row?.record ?? row?.record_json ?? null);
    // run_events 形状（type=tool_result 的行若混进来）也接住，不假设来源只有轮记录
    if (row?.payload) walk(row.payload);
  }
  // 同一个命令会被嵌套形状（toolCall 本体与它的 `input` 子节点）各命中一次：
  // 按命令去重，**优先保留带退出码的那条**（退出码是这一节唯一要有事实价值的内容）。
  const byCmd = new Map();
  for (const c of candidates) {
    const cur = byCmd.get(c.command);
    if (!cur || (cur.exitCode === null && c.exitCode !== null)) byCmd.set(c.command, c);
  }
  return [...byCmd.values()];
}

/** `git` 默认执行器（execFile，不经 shell；失败也返回 stdout，porcelain 失败场景少）。 */
async function defaultGitRunner(repoDir, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoDir, ...args], {
      timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    });
    return String(stdout);
  } catch {
    return null;
  }
}

/**
 * ① git 现场采集（工作目录侧事实，可注入 runner 供测试/异机使用）。
 * 命令集合照单子：porcelain -uall / log --oneline -5 / diff --stat / HEAD / detached / 有无远端 /
 * 被排除的 ignored 清单（审查看不到 ignored 文件，清单本身要进工作包）。
 */
export async function collectGitFacts(repoDir, { runner = defaultGitRunner } = {}) {
  const [statusPorcelain, logOneline, diffStat, head, branch, remote] = await Promise.all([
    runner(repoDir, ['status', '--porcelain', '-uall']),
    runner(repoDir, ['log', '--oneline', '-5']),
    runner(repoDir, ['diff', '--stat']),
    runner(repoDir, ['rev-parse', 'HEAD']),
    runner(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runner(repoDir, ['remote']),
  ]);
  const detached = branch === 'HEAD';
  const ignoredRaw = await runner(repoDir, ['ls-files', '--others', '--ignored', '--exclude-standard']);
  return {
    repoDir,
    statusPorcelain,
    logOneline,
    diffStat,
    head: head?.trim() ?? null,
    detached,
    branch: detached ? null : (branch?.trim() ?? null),
    hasRemote: Boolean(remote && remote.trim() !== ''),
    ignoredFiles: ignoredRaw ? ignoredRaw.split('\n').filter((line) => line !== '') : null,
  };
}

/** 段落小工具：值缺失时写「（无）」而不是让审查误读成「没有这项事实」。 */
function section(title, body) {
  const text = body === null || body === undefined || body === '' ? '（无）' : String(body);
  return `## ${title}\n${text}`;
}

/**
 * ① 事实采集 → 工作包（拼进审查 run 的 task 文本；只跑在平台侧，**不跑测试**）。
 *
 * ⚠ 只读审查不许声称「测试通过」——验证命令的事实固定文案：
 * 「原 run 在指纹 X 上跑过这些命令，退出码 Y；本次审查未独立复验。」
 * 工作包总长上限 {@link MAX_BRIEF_BYTES}，超出截断并在尾部标注。
 */
export async function buildReviewBrief(pool, {
  reviewSessionId, originalRunId = null, gitFacts = null, snapshot = null,
  ignoredFiles = null, transcriptRows = null, maxBytes = MAX_BRIEF_BYTES,
} = {}) {
  const parts = [];

  // —— 会话事实（文本走 session-text 的投影口径，与对话流一致）——
  let taskText = null;
  let lastAssistant = null;
  let runRow = null;
  if (reviewSessionId) {
    try {
      const users = await fetchUserTextTurns(pool, { sessionId: reviewSessionId, limit: 1 });
      taskText = users[0]?.text ?? null;
    } catch { /* 缺证据不炸工作包 */ }
    if (originalRunId) {
      try {
        const a = await fetchRunAssistantText(pool, { sessionId: reviewSessionId, runId: originalRunId });
        lastAssistant = a?.text ?? null;
      } catch { /* 同上 */ }
      const runs = await pool.query(
        'SELECT termination, rounds, usage, error FROM runs WHERE id = $1', [originalRunId],
      ).catch(() => ({ rows: [] }));
      runRow = runs.rows?.[0] ?? null;
    }
    if (transcriptRows === null) {
      const t = await pool.query(
        `SELECT run_id, round, dedup_key, record, created_at
           FROM transcript_rounds WHERE transcript_key = $1
          ORDER BY round ASC, append_seq ASC`,
        [reviewSessionId],
      ).catch(() => ({ rows: [] }));
      transcriptRows = t.rows ?? [];
    }
  }
  parts.push(section('原任务（首条用户消息）', taskText));
  parts.push(section('执行者最后说法（终稿正文）', lastAssistant));

  // —— 验证命令与退出码：只报事实，不声称复验 ——
  const verifications = extractVerificationCommands(transcriptRows);
  const fingerprint = snapshot?.contentFingerprint ?? null;
  const verificationLines = verifications.length > 0
    ? verifications.map((v) => `- ${v.command} ⇒ 退出码 ${v.exitCode ?? '（未知）'}`)
    : ['（transcript 里没找到验证命令）'];
  verificationLines.push(`- 本次审查只读：原 run 在指纹 ${fingerprint ?? '（无指纹）'} 上跑过这些命令，退出码见上；本次审查未独立复验。`);
  parts.push(section('验证命令与退出码（未独立复验）', verificationLines.join('\n')));

  // —— 终止/用量事实 ——
  const runLines = [];
  if (runRow) {
    const term = runRow.termination ?? null;
    runLines.push(`termination.reason: ${term?.reason ?? '（无）'}`);
    if (term?.detail) runLines.push(`termination.detail: ${JSON.stringify(term.detail)}`);
    runLines.push(`error_code: ${runRow.error?.code ?? '（无）'}`);
    runLines.push(`rounds: ${runRow.rounds ?? 0}`);
    runLines.push(`usage: ${JSON.stringify(runRow.usage ?? {})}`);
  }
  parts.push(section('原 run 终止与用量', runLines.length > 0 ? runLines.join('\n') : null));

  // —— git 现场 ——
  if (gitFacts) {
    parts.push(section('git status --porcelain -uall', gitFacts.statusPorcelain));
    parts.push(section('git log --oneline -5', gitFacts.logOneline));
    parts.push(section('git diff --stat', gitFacts.diffStat));
    parts.push(section('HEAD / 分支', [
      `HEAD: ${gitFacts.head ?? '（未知）'}`,
      `detached: ${gitFacts.detached ? 'yes' : 'no'}`,
      `branch: ${gitFacts.branch ?? '（detached 或未知）'}`,
      `有远端: ${gitFacts.hasRemote ? 'yes' : 'no'}`,
    ].join('\n')));
  } else {
    parts.push(section('git 现场', null));
  }

  // —— 被排除的 ignored 清单（审查看不到这些文件，清单本身要可见）——
  const ignored = ignoredFiles ?? gitFacts?.ignoredFiles ?? null;
  parts.push(section('被排除的 ignored 文件',
    Array.isArray(ignored) ? (ignored.length > 0 ? ignored.join('\n') : '（无）') : null));

  // —— 快照身份（W4a 产物）——
  if (snapshot && snapshot.ok !== false) {
    parts.push(section('快照身份', [
      `snapshot_id: ${snapshot.snapshotId ?? '（无）'}`,
      `content_fingerprint: ${snapshot.contentFingerprint ?? '（无）'}`,
      `worktree_path: ${snapshot.worktreePath ?? '（无）'}`,
    ].join('\n')));
  } else {
    parts.push(section('快照身份', null));
  }

  const joined = parts.join('\n\n');
  const { text, truncated } = clipUtf8(joined, maxBytes);
  return truncated
    ? `${text}\n\n……（工作包超过 ${maxBytes} 字节，已截断）`
    : text;
}

/** 审查 runner 的失败分类：`kind` 显式优先，其次按常见形状猜，兜底 `llm_failed`。 */
function classifyReviewError(err) {
  const kind = err?.kind ?? err?.errorClass ?? null;
  if (kind === 'timeout' || err?.name === 'TimeoutError' || err?.code === 'ETIMEDOUT') return 'timeout';
  if (SNAPSHOT_FAILURE_REASONS.includes(kind)) return `snapshot_failed:${kind}`;
  return kind ?? 'llm_failed';
}

/** 带超时地跑审查 runner；超时抛 kind='timeout'。 */
function withTimeout(promiseFactory, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promiseFactory();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`review runner timed out after ${timeoutMs}ms`);
      err.kind = 'timeout';
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promiseFactory(), timeout]).finally(() => clearTimeout(timer));
}

/**
 * W4b 主编排：对**已认领**的 macro run 跑一次审查并收口。
 *
 * @param {object} pool
 * @param {object} opts
 * @param {string} opts.macroRunId            W2 `claimMacroRun` 拿到的行（本函数只 finish，不 claim）
 * @param {string} [opts.userId]              缺省取订阅的 user_id
 * @param {string} [opts.reviewSessionId]     被审查的原会话；缺省取订阅的 session_id
 * @param {string} [opts.originalRunId]       被审查的原 run（终止/用量/终稿事实源）
 * @param {object} [opts.snapshot]            W4a 产物 `{ok, snapshotId, contentFingerprint, worktreePath}`；
 *                                            `ok:false` 必带 `reason`（SNAPSHOT_FAILURE_REASONS 之一）⇒ 失败出口
 * @param {object} [opts.gitFacts]            `collectGitFacts` 产物；缺省 = 工作包里 git 段为（无）
 * @param {(ctx: {brief: string, macroRunId: string}) => Promise<string>|string} opts.reviewRunner
 *                                            审查 run 文本面（真机是 runner；测试是桩，不真调模型）
 * @param {number} [opts.reviewTimeoutMs]     审查预算（默认 10 分钟）
 * @param {boolean} [opts.remediate=true]     是否允许回灌（`red` 才回灌）
 * @param {(msg: object) => any} [opts.notify]  转人工/通知的 hook（默认 no-op）
 * @param {Date}   [opts.now]                 到期判定用（⑤：只比瞬时值）
 * @returns {Promise<{macroRunId: string, status: string, verdict: string|null, remediated: boolean, detail: object}>}
 */
export async function runMacroReview(pool, {
  macroRunId, userId = null, reviewSessionId = null, originalRunId = null,
  snapshot = null, gitFacts = null, reviewRunner, reviewTimeoutMs = 10 * 60 * 1000,
  remediate = true, notify = async () => {}, postMessageImpl = postMessage, now = new Date(),
} = {}) {
  if (!macroRunId) throw new MacroError('validation_failed', 'macroRunId 必填（W4b 只 finish 不 claim）');
  if (typeof reviewRunner !== 'function') throw new MacroError('validation_failed', 'reviewRunner 必填');

  // —— 账与订阅：一次读齐（depth / until / 缺省 user 与会话）——
  const acct = await pool.query(
    `SELECT r.id, r.status, r.depth, r.snapshot_id, a.user_id, a.session_id, a.until
       FROM macro_runs r JOIN macro_assignments a ON a.id = r.assignment_id
      WHERE r.id = $1`,
    [macroRunId],
  );
  const row = acct.rows?.[0];
  if (!row) throw new MacroError('not_found', '执行记录不存在', { httpStatus: 404, details: { macroRunId } });
  const depth = Number(row.depth ?? 0);
  const safeUserId = userId ?? row.user_id;
  const sessionId = reviewSessionId ?? row.session_id;

  const done = (status, extra = {}) => {
    const merged = { macroRunId, status, ...extra };
    return finishMacroRun(pool, merged).then((snap) => ({
      macroRunId, status,
      verdict: snap?.verdict ?? extra.verdict ?? null,
      remediated: Boolean(extra.childRunId),
      detail: snap,
    }));
  };

  // —— 快照失败（W4a 的 reason）：失败出口，不是 red ——
  if (snapshot && snapshot.ok === false) {
    const reason = SNAPSHOT_FAILURE_REASONS.includes(snapshot.reason)
      ? snapshot.reason : `snapshot_failed:${snapshot.reason ?? 'unknown'}`;
    return done('failed', { verdict: 'unclassified', reason: `快照构建失败：${reason}` });
  }

  // —— ① 工作包 ——
  let brief;
  try {
    brief = await buildReviewBrief(pool, {
      reviewSessionId: sessionId, originalRunId, gitFacts, snapshot,
    });
  } catch (err) {
    return done('failed', { verdict: 'unclassified', reason: `工作包构建失败：${err?.message ?? String(err)}` });
  }

  // —— 跑审查（预算内；超时/LLM 失败都是「没判成」）——
  let text;
  try {
    text = await withTimeout(() => Promise.resolve(reviewRunner({ brief, macroRunId })), reviewTimeoutMs);
  } catch (err) {
    return done('failed', { verdict: 'unclassified', reason: `审查失败：${classifyReviewError(err)}` });
  }

  // —— ② 首行判决（fail closed）——
  const parsed = parseVerdictLine(text);
  if (!parsed.matched) {
    // 存原话、不自动回灌、转人工 + 通知
    const out = await done('done', { verdict: 'unclassified', verdictRaw: String(text ?? '') });
    await notify({ kind: 'review_unclassified', macroRunId, sessionId, text: String(text ?? '') });
    return { ...out, remediated: false };
  }

  const verdict = parsed.verdict;
  if (verdict !== 'red') {
    // pass / no-op-claim / needs-human 都不回灌；needs-human 直接转人工
    if (verdict === 'needs-human') {
      await notify({ kind: 'review_needs_human', macroRunId, sessionId, text: String(text ?? '') });
    }
    return done('done', { verdict, verdictRaw: parsed.verdictRaw, reason: null });
  }

  // —— ③ 回灌（只在 red）——
  const body = REMEDIATION_PREFIX + String(text ?? '');
  if (!body.startsWith('[系统]')) {
    throw new MacroError('validation_failed', '回灌正文必须以 [系统] 开头');
  }

  // ⑤ 到期：审查结果照常入流水，但到点后**禁止再触发整改 run**（不强杀已启动的审查）。
  if (isAssignmentExpired(row.until, now)) {
    return done('done', { verdict, verdictRaw: parsed.verdictRaw, reason: '订阅已到期：判决入账，不再触发整改 run' });
  }
  // depth ≤ 1：已是 1 的审查只判不回灌（防整改链无限递归）。
  if (depth >= MAX_REMEDIATION_DEPTH) {
    return done('done', { verdict, verdictRaw: parsed.verdictRaw, reason: `回灌深度闸：depth=${depth} ≥ ${MAX_REMEDIATION_DEPTH}，不回灌` });
  }
  if (!remediate) {
    return done('done', { verdict, verdictRaw: parsed.verdictRaw, reason: '回灌关闭（remediate=false）' });
  }

  let posted;
  try {
    posted = await postMessageImpl(pool, {
      userId: safeUserId, sessionId, content: body, triggerKind: 'synthetic',
    });
  } catch (err) {
    if (err instanceof SessionError && err.httpStatus === 409) {
      // 原会话忙 ⇒ 推迟（skipped + deferred），**判决保留原值**，不重试、不清空
      const out = await finishMacroRun(pool, {
        macroRunId, status: 'skipped', skippedReason: 'deferred',
        verdict, verdictRaw: parsed.verdictRaw, reason: '回灌 409：原会话有活跃 run，已推迟',
      });
      return { macroRunId, status: 'skipped', verdict, remediated: false, detail: out };
    }
    throw err;
  }

  return done('done', {
    verdict, verdictRaw: parsed.verdictRaw,
    remediationText: body,
    childSessionId: sessionId,
    childRunId: posted?.run?.id ?? null,
  });
}
