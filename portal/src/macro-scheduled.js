// issue #536（W7 / M7）：定时任务执行器 —— 消费 W2 的 `tick` 意图，真正「起一个 run」。
//
// W2（`macro-eval.js` 的 `evalClock`）每轮求值只产出 `tick` 意图并 `claimMacroRun` 占位；
// W4 只管审查。整块「真正起 run」此前无人认领（契约 `10` 篇 §7 的遗漏），本模块补上。
//
// 生命周期（`10` 篇 §2.1：W7 **只 finish、不 claim**，claim 归 W2）：
//   tick 意图 → 取/建宏会话 → postMessage(triggerKind='synthetic') 入队 run
//   → 驱动 runTask（生产=真跑；测试=桩）一次 → 收口：
//     · 成功 ⇒ finishMacroRun(done) + 平台落产物 reportsRoot/<宏名>/<date>.md
//     · 失败 ⇒ finishMacroRun(failed) + deliverIntent 通知用户（**不补跑、不重试**）
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { postMessage } from './sessions.js';
import { finishMacroRun, MacroError } from './macros.js';
import { deliverIntent } from './notifications.js';

/** `chat_sessions.origin` 前缀：值形如 `macro:<template-name>`（契约 §4 第 4 条）。 */
export const MACRO_SESSION_ORIGIN_PREFIX = 'macro:';

/** 平台写死的宏会话标题后缀（用户可改标题，但 `origin` 不变，侧栏「自动化」分组靠 origin 过滤）。 */
export const MACRO_SESSION_TITLE_SUFFIX = '· 长期';

/**
 * 路径段清洗（issue #637 ③）：把「名字」压成一个**安全路径段**，并**保留 Unicode 字母/数字**
 * （汉字原样留下）。过去的 `[^\w.\-]+` 里 `\w` 只认 `[A-Za-z0-9_]` ⇒ 中文名整段被压成一个 `_`，
 * 所有中文宏挤进同一个 `_/` 目录、`<date>.md` 互相覆盖（真机实测目录就是 `_`）。
 *
 * 用 `/[^\p{L}\p{N}._-]+/gu`（`\p{L}` 含汉字、`\p{N}` 含各文种数字）后：
 *  - 控制字符（含 NUL）→ `_`（`\p{L}`/`\p{N}` 本就不含，但显式挡一遍更稳）；
 *  - 其余非「字母 / 数字 / `.` / `_` / `-`」（`/`、`\`、空格、emoji…）→ `_` ⇒ 挡掉 `/` 造成的目录穿越；
 *  - **前导点**（`.` / `..` / `.hidden`）→ `_` ⇒ 挡 `..` 这个「无斜杠也能逃一层」的特例
 *    （`path.join(root, '..')` 会逃到 root 之外）；
 *  - 截断 120，全被清空 ⇒ 兜底 `fallback`（保持过去 `'macro'` 的行为）。
 */
function safePathSegment(value, fallback = 'macro') {
  const out = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^\.+/, '_')
    .slice(0, 120);
  return out || fallback;
}

/**
 * 产物根默认落点（issue #637 ②）：**用户可见的 RW 挂载** `/srv/erix/users/<fde_name>/reports`。
 * 过去是 `os.homedir() + '/reports'` = 容器内 `/root/reports`，**没挂载** ⇒ 用户看不到、换镜像即丢。
 * 口径：`userSpaceRoot`（默认对齐 `config.userSpaceRoot` = `/srv/erix/users`，portal 对它是 RW 挂载）
 *   + `<fde_name>`（过 `safePathSegment` 挡穿越，空 ⇒ `'user'`）+ `reports`；`artifactPath` 再拼
 *   `<宏名>/<date>.md` ⇒ 最终 `/srv/erix/users/<fde_name>/reports/<宏名>/<date>.md`。
 * ⚠ 绝不落 `~/projects`（模型 jail 在项目 cwd，平台写到那儿会把用户收工灯弄红，W7 原本就避开）。
 */
export function defaultReportsRoot(fdeName, userSpaceRoot = '/srv/erix/users') {
  return path.join(userSpaceRoot, safePathSegment(fdeName, 'user'), 'reports');
}

/** 宏会话标题：`<宏名> · 长期`。 */
export function macroSessionTitle(templateName) {
  return `${String(templateName ?? '宏')} ${MACRO_SESSION_TITLE_SUFFIX}`;
}

/** 由模板名推 `origin` 值。 */
export function macroOrigin(templateName) {
  return MACRO_SESSION_ORIGIN_PREFIX + String(templateName ?? '');
}

/** 产物落点：`<reportsRoot>/<宏名>/<date>.md`（date 用意图 bucket = UTC+8 日期，不回查模板）。 */
export function artifactPath(reportsRoot, templateName, date) {
  return path.join(reportsRoot, safePathSegment(templateName, 'macro'), `${safePathSegment(date, 'macro')}.md`);
}

/**
 * 查 `users.fde_name`（产物根缺省口径用，#637 ②）。`intent.userId` = users.id。
 * 查不到（无 userId / 行不存在 / 列 NULL / 查询报错）⇒ 返回 null，交 `defaultReportsRoot` 兜底 'user'：
 * 产物仍落在挂载里，**不**能因取不到名字而退回不可见的容器内路径。
 */
async function lookupFdeName(pool, userId) {
  if (!userId) return null;
  try {
    const { rows } = await pool.query('SELECT fde_name FROM users WHERE id = $1', [userId]);
    return rows[0]?.fde_name ?? null;
  } catch {
    return null;
  }
}

/**
 * 取（或建）该 (user, template) 的长期宏会话。
 *
 * ⚠ **复用判据必须同时看 `origin` 与 `user_id`**：
 *  - 只看 origin ⇒ 两个用户订同一模板会共用一条会话（越权 + notes 串味）；
 *  - 只看 user_id ⇒ 同一用户的不同宏会挤进同一条会话。
 * origin 值形如 `macro:<模板名快照>`，已把「模板维度」编进 origin，故 `origin + user_id`
 * 就是 (user, template) 的唯一判据。
 *
 * ⚠ #627 ② 修正：上面的「唯一判据」并不完整——还必须比 `cwd`（否则改模板 cwd 不生效）。
 * 口径与理由写在下面查询旁的注释里。
 *
 * ⚠ **为什么复用而不是每次开新会话**：notes 是 `sessionId` 作用域
 *   （`runner/lib/run-data.js:70` 的 `<home>/sessions/<id>/notes`）。复用会话 ⇒
 *   昨天写的注今天还在 ⇒ 「跨会话记忆不存在」这条对宏会话**不成立**。
 *   代价：会话会变长（1 run/天 × 30 天 ≈ 150 轮），靠读侧折叠兜（transcript-fold）。
 */
export async function getOrCreateMacroSession(pool, { userId, templateName, cwd = null, now = new Date() }) {
  const origin = macroOrigin(templateName);
  // 先按 (user, origin, cwd) 找最早的活跃宏会话；命中即复用（这是 notes 跨 tick 累积的来源）。
  // issue #627 ②：cwd 进复用判据。run 的 cwd 是 claim 时从 `chat_sessions.cwd` 取的
  // （`internal.js` tryClaim 的 `SELECT … s.cwd`），所以**复用了旧会话 = 旧 cwd 又跑了一天**：
  // 用户把模板 cwd 从 `~/projects/a` 改到 `b`，任务仍在 `a` 跑，页面不报错——静默失效。
  // 拍板：cwd 变了就**新建一条宏会话**（origin 相同、cwd 不同），旧会话保留历史。
  //   为什么不就地改旧会话 cwd：宏会话是长期会话，它的 notes/历史全部是在旧目录下产生的，
  //   就地改会让旧账与新 run 指向不同目录（翻旧账时路径全错）；新建则旧账留在旧目录的会话里。
  //   代价：换 cwd 后 notes 不连续——本来也不该让两个目录的注串味。
  // 比较用 `IS NOT DISTINCT FROM`：cwd 允许 NULL（未指定目录），普通 `=` 对 NULL 恒不命中
  //   ⇒ 会把「两边都没 cwd」也当成变化，每拍新建一条会话（比原来的 bug 更糟）。
  const found = await pool.query(
    `SELECT id FROM chat_sessions
      WHERE user_id = $1 AND origin = $2 AND status = 'active'
        AND cwd IS NOT DISTINCT FROM $3
      ORDER BY created_at ASC
      LIMIT 1`,
    [userId, origin, cwd ?? null],
  );
  if (found.rows[0]?.id) return { sessionId: found.rows[0].id, created: false };

  // 未命中 ⇒ 建。不走 sessions.createSession：那条路要求 userSpaceRoot / fde_name 并建家目录，
  // 且**不写 origin**（宏会话的 origin 写入按 `10` 篇 §4 归本单）。title_source='manual'：
  // 标题平台写死，自动改名（session-title）不得覆盖。
  const res = await pool.query(
    `INSERT INTO chat_sessions (user_id, project_id, title, title_source, cwd, origin, status, last_seq)
     VALUES ($1, NULL, $2, 'manual', $3, $4, 'active', 0)
     RETURNING id`,
    [userId, macroSessionTitle(templateName), cwd, origin],
  );
  return { sessionId: res.rows[0].id, created: true };
}

/**
 * 执行一条 scheduled-task 的 `tick` 意图。
 *
 * @param {object} intent  W2 产出的意图（含已占位的 `macroRunId` 与参数快照 params.cwd/task/maxRounds）
 * @param {object} [opts]
 *   - `reportsRoot` 产物根（**注入优先**；缺省 ⇒ 现算 = `config.userSpaceRoot` + `users.fde_name`，#637 ②；
 *                   测试注入临时目录，别真写 `/srv/erix`）
 *   - `config`      仅用于读 `userSpaceRoot`（缺省产物根口径），其余字段忽略。
 *   - `runTask`     执行体（生产=真跑一次 run；测试注入桩 runner）。
 *                   `(ctx) => Promise<{ ok, text?, error? } | void>`；抛异常或 `ok===false` ⇒ 失败。
 *   - `sessionsHome` notes 根（`<home>/sessions/<id>/notes` 的 `<home>`），透传给 runTask。
 *   - `postMessageImpl` 注入点（默认 sessions.postMessage），便于隔离测试。
 *   - `notifyImpl`      注入点（默认 notifications.deliverIntent）。
 * @returns {{ status, verdict, sessionId, childRunId, artifactPath? , ... }}
 */
export async function executeScheduledIntent(pool, intent, {
  reportsRoot = null,
  runTask,
  sessionsHome = os.homedir(),
  postMessageImpl = postMessage,
  notifyImpl = deliverIntent,
  now = new Date(),
  log = console,
  config = {},
} = {}) {
  const macroRunId = intent?.macroRunId;
  if (!macroRunId) {
    throw new MacroError('validation_failed', 'macroRunId 必填（W7 只 finish 不 claim）',
      { details: { field: 'macroRunId' } });
  }
  if (typeof runTask !== 'function') {
    throw new MacroError('validation_failed', 'runTask 必填（生产=真跑，测试=桩 runner）');
  }
  const userId = intent.userId;
  const templateName = intent.templateName;
  // ⚠ 参数一律取意图快照，**不回查模板**（模板可能已被改，快照才是本次触发承诺的东西）。
  const params = intent.params ?? {};
  const cwd = intent.cwd ?? params.cwd ?? null;
  const task = params.task ?? '';
  const maxRounds = params.maxRounds;
  const date = intent.bucket; // tick 的 bucket = UTC+8 日期，产物按它命名

  // —— ① 宏会话（复用优先，见 getOrCreateMacroSession 注释）——
  const { sessionId } = await getOrCreateMacroSession(pool, { userId, templateName, cwd, now });

  // —— ② 起 run：postMessage 进该会话，triggerKind='synthetic' ——
  let childRunId = null;
  try {
    const posted = await postMessageImpl(pool, {
      userId, sessionId, content: task, triggerKind: 'synthetic',
      // issue #627 ②③：两个过去被读出来却没人用的参数现在真的下行。
      //  · `cwd`：会话已按 cwd 取/建，但「复用旧会话 + 模板改了 cwd」这一格靠 postMessage 自己
      //    刷会话 cwd 兑住：run 的 cwd = claim 时读的 `chat_sessions.cwd`，刷了会话行 = 新目录。
      //  · `maxRounds`：写进 run 行，再由 claim 下行给 runner（路线与理由见 sessions.js postMessage）。
      cwd, maxRounds,
    });
    childRunId = posted?.run?.id ?? null;
  } catch (err) {
    // 入队本身失败（无容器 / 会话忙）：视作执行失败，走统一失败收口（不补跑、只通知）。
    return await failRun({
      pool, intent, notifyImpl, log,
      sessionId, childRunId, reason: `起 run 失败：${err?.message ?? String(err)}`,
    });
  }

  // —— 驱动 runTask 一次（**不重试**：时间意图会过期，补跑只会重复烧钱，`06` §8 待拍项 4）——
  let result;
  try {
    result = await runTask({
      pool, intent, userId, sessionId, childRunId, cwd, task, maxRounds,
      sessionsHome, notesDir: path.join(sessionsHome, 'sessions', String(sessionId), 'notes'),
      log,
    });
  } catch (err) {
    return await failRun({
      pool, intent, notifyImpl, log,
      sessionId, childRunId, reason: `任务执行失败：${err?.message ?? String(err)}`,
    });
  }

  const ok = result && typeof result === 'object' ? result.ok !== false : true;
  if (!ok) {
    return await failRun({
      pool, intent, notifyImpl, log,
      sessionId, childRunId,
      reason: `任务返回失败：${(result && result.error) || 'runTask 报告 ok=false'}`,
    });
  }

  // —— 产物由**平台**落盘（模型被 jail 在项目 cwd，它写的文件会把用户收工灯弄红）——
  // 产物根：注入优先；缺省 ⇒ 按 `config.userSpaceRoot` + `users.fde_name` 现算（#637 ②）。
  // intent.userId 是 users.id，产物要落到用户可见的 RW 挂载 ⇒ 查 users.fde_name；查不到 ⇒ fde_name=null
  // ⇒ defaultReportsRoot 兜底 'user'（仍在挂载里，**不**退回 os.homedir()，否则又回到不可见的容器内路径）。
  let root = reportsRoot;
  if (root == null) {
    root = defaultReportsRoot(await lookupFdeName(pool, userId), config?.userSpaceRoot);
  }
  const artifact = artifactPath(root, templateName, date);
  const text = (result && typeof result.text === 'string') ? result.text : String(result ?? '');
  // —— **空正文的产物形态（issue #652 ② 拍板：选 (a) 不落盘）** ——
  // 理由（写死在此，免得后人又改回 0 字节文件）：
  //  · 设计 `05` §4.2 给 M7 的第一版判据是**机械的**「**产出非空** / 落盘文件存在 / 退出码 0」——
  //    它要的是「有输出 ⇒ 有产物」，**没有**「每次必有一份产物」这一条，所以不落盘不违约。
  //  · 0 字节文件是**假账**：用户打开是空白，分不出「本次真的无输出」还是「取数管道坏了」；
  //    #652 的现物正是后者（投影口径错 ⇒ 正文空）被 0 字节文件伪装成了前者。
  //  · 不落盘 + 账上 `macro_runs.reason='no_output'` ⇒ 界面能直接说出「本次无输出」，两态可分。
  const hasOutput = text.trim() !== '';
  if (hasOutput) {
    try {
      await fs.mkdir(path.dirname(artifact), { recursive: true });
      await fs.writeFile(artifact, text, 'utf8');
    } catch (err) {
      log.warn?.(`[macro-scheduled] 产物落盘失败（不影响 run 判定）：${err?.message ?? String(err)}`);
    }
  } else {
    log.info?.('[macro-scheduled] 本次无文本产出 ⇒ 不落盘（#652 ②：0 字节文件是假账），账上记 no_output');
  }

  // —— 收口：done。verdict 交给 finishMacroRun 缺省补 'unclassified'。——
  // 已是终态（重放）⇒ finishMacroRun 抛 409 conflict：幂等吞掉，不谎报失败。
  // `reason`：正常 done 仍为 null；只有「run 成功但没产出文本」记 `no_output`（上面选 (a) 的落点）。
  let snap;
  try {
    snap = await finishMacroRun(pool, {
      macroRunId, status: 'done',
      childSessionId: sessionId, childRunId, reason: hasOutput ? null : 'no_output',
    });
  } catch (err) {
    if (err instanceof MacroError && err.httpStatus === 409) {
      log.info?.(`[macro-scheduled] 账已终态（重放），跳过收口：${err.message}`);
      return { status: 'done', replayed: true, sessionId, childRunId, artifactPath: hasOutput ? artifact : null };
    }
    throw err;
  }
  return {
    status: 'done', verdict: snap?.verdict ?? 'unclassified',
    sessionId, childRunId, artifactPath: hasOutput ? artifact : null,
  };
}

/**
 * 失败收口：`finishMacroRun(failed, reason)` + **通知用户**。
 * 失败通知必须传给**普通用户**（不是只传 admin）——`deliverIntent` 自己查 role：
 * 收件人全 admin ⇒ 一行不写，所以这里放 `intent.userId`（任务订阅人本人），保证失败不落进
 * 没人看的会话里静默死。不重试、不补跑。
 */
async function failRun({ pool, intent, notifyImpl, log, sessionId, childRunId, reason }) {
  const macroRunId = intent.macroRunId;
  let snap = null;
  try {
    snap = await finishMacroRun(pool, {
      macroRunId, status: 'failed', verdict: 'unclassified', reason,
      childSessionId: sessionId ?? null, childRunId: childRunId ?? null,
    });
  } catch (err) {
    if (err instanceof MacroError && err.httpStatus === 409) {
      log.info?.(`[macro-scheduled] 账已终态（重放），跳过失败收口：${err.message}`);
    } else {
      throw err;
    }
  }
  // 通知：success=false ⇒ severity='error'。收件人 = 订阅人本人（普通用户），失败通知才看得见。
  try {
    await notifyImpl(pool, intent, {
      recipients: intent.userId ? [intent.userId] : [],
      success: false,
      title: `宏「${intent.templateName ?? '?'}」执行失败`,
      body: reason,
    });
  } catch (err) {
    log.warn?.(`[macro-scheduled] 失败通知投递异常（账已 failed）：${err?.message ?? String(err)}`);
  }
  return {
    status: 'failed', verdict: snap?.verdict ?? 'unclassified',
    reason, sessionId: sessionId ?? null, childRunId: childRunId ?? null,
  };
}
