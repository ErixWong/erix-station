// issue #538（W4b）：判决解析 / 回灌 / 失败出口 / `until` 到期 的判据用例。
//
// 环境门（口径与 `delta-not-persisted-db.test.js` 一致）：`TEST_DATABASE_URL` 未设 ⇒ 整文件 skip；
// 真库自起（docs 纪律）：
//   docker run -d --name w4b-pg -e POSTGRES_USER=station -e POSTGRES_PASSWORD=station \
//     -e POSTGRES_DB=station_test -p 127.0.0.1:15493:5432 postgres:16
//   TEST_DATABASE_URL=postgres://station:station@127.0.0.1:15493/station_test \
//     node --test portal/test/macro-review.test.js
//
// 审查 runner 全部走**桩**（不真调模型）；投影正文经 `getSession`（sessions.js）——
// ⚠ 普通用户消息 `messages.content` 恒写空串（P3 PR②b B2），正文真相在 `transcript_rounds`，
// 只查 `messages.content` 会把「回灌成功」看成「回灌丢了」。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { hashToken } from '../src/auth.js';
import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';
import { claimMacroRun } from '../src/macros.js';
import { getSession, postMessage } from '../src/sessions.js';
import {
  MAX_BRIEF_BYTES, VERDICT_FORMAT_BLOCK, buildReviewBrief, extractVerificationCommands, parseVerdictLine, runMacroReview,
} from '../src/macro-review.js';

const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
const SKIP = URL_VALUE ? false : SKIP_WITHOUT_PG;
const fixture = URL_VALUE ? createPgFixture(URL_VALUE, { prefix: 'w4br' }) : null;
// 退出纪律见文件末尾的「退出收台」用例（必须**最后注册**才能最后跑）。

const withFreshDb = (fn) => fixture.withFreshDatabase(({ pool }) => fn(pool), {
  poolMax: 2, log: () => {},
});

const ids = (tag) => ({
  userId: crypto.randomUUID(), projectId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
  runId: crypto.randomUUID(), containerId: crypto.randomUUID(),
  templateId: crypto.randomUUID(), assignmentId: crypto.randomUUID(),
  login: `a${tag.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30),
});

/** 一套可回灌的现场：用户/项目/容器/会话 + 原任务与原 run（终态）+ run-review 订阅。 */
async function seedScene(pool, scene, { until = null } = {}) {
  await pool.query(`INSERT INTO users (id, login, password_hash, status) VALUES ($1,$2,'x','active')`,
    [scene.userId, scene.login]);
  await pool.query(
    `INSERT INTO projects (id, user_id, name, repo_url, root_path, slot)
     VALUES ($1,$2,$3,'git@x:y/z.git','~/projects/x',0)`,
    [scene.projectId, scene.userId, `p${scene.login}`]);
  await pool.query(
    `INSERT INTO containers (id, user_id, runner_token_hash, image, agent_version, status, fde_name, container_name)
     VALUES ($1,$2,$3,'img','0.32.0','running',$4,$5)`,
    [scene.containerId, scene.userId, hashToken('tok-w4b'), scene.login, `fde-${scene.login}`]);
  await pool.query(
    `INSERT INTO chat_sessions (id, user_id, project_id, title, model, cwd, status, last_seq)
     VALUES ($1,$2,$3,'被审会话','mock-model','~/projects/x','active',2)`,
    [scene.sessionId, scene.userId, scene.projectId]);
  await pool.query(
    `INSERT INTO runs (id, session_id, status, termination, rounds, usage, error)
     VALUES ($1,$2,'finished','{"reason":"end_turn"}',4,'{"input_tokens":10,"output_tokens":5}','{"code":"none"}')`,
    [scene.runId, scene.sessionId]);
  // 原任务（首条 user）与执行者最后说法（assistant，legacy 正文兜底口径）
  await pool.query(
    `INSERT INTO messages (id, session_id, run_id, seq, role, content)
     VALUES ($1,$2,$3,1,'user','把登录修好')`,
    [crypto.randomUUID(), scene.sessionId, scene.runId]);
  await pool.query(
    `INSERT INTO messages (id, session_id, run_id, seq, role, content)
     VALUES ($1,$2,$3,2,'assistant','我修好了，测试全过')`,
    [crypto.randomUUID(), scene.sessionId, scene.runId]);
  await pool.query(
    `INSERT INTO macro_templates (id, kind, name, params, audience, scope)
     VALUES ($1,'run-review',$2,'{}','all','session')`,
    [scene.templateId, `rv-${scene.login}`]);
  await pool.query(
    `INSERT INTO macro_assignments (id, template_id, user_id, session_id, until, enabled)
     VALUES ($1,$2,$3,$4,$5,true)`,
    [scene.assignmentId, scene.templateId, scene.userId, scene.sessionId, until]);
  return scene;
}

/** W2 的认领（幂等键归它管，W4b 只 finish）；返回已占位的 macroRunId。 */
async function claim(pool, scene) {
  const claimed = await claimMacroRun(pool, {
    assignmentId: scene.assignmentId, anchor: scene.runId, criterion: 'terminal', bucket: scene.runId,
  });
  assert.ok(claimed?.id, 'claimMacroRun 应占位成功');
  return claimed.id;
}

const runRow = (pool, macroRunId) => pool.query(
  'SELECT status, verdict, verdict_raw, reason, remediation_text, skipped_reason, child_run_id FROM macro_runs WHERE id = $1',
  [macroRunId],
).then((r) => r.rows[0]);

const messageContents = async (pool, scene) => {
  const view = await getSession(pool, { userId: scene.userId, sessionId: scene.sessionId, limit: 50 });
  return view.messages.map((m) => `${m.role}:${m.content ?? ''}`);
};

// —— 判据 1：桩返回 `结论：整改` ⇒ 原会话**投影正文**含 `[系统]` ——
test('red ⇒ 回灌进原会话投影正文（[系统] 前缀），账上 done/red', { skip: SKIP }, async (t) => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T1'));
    const macroRunId = await claim(pool, scene);
    const out = await runMacroReview(pool, {
      macroRunId,
      reviewSessionId: scene.sessionId,
      originalRunId: scene.runId,
      reviewRunner: ({ brief }) => {
        assert.ok(brief.includes('原任务'), '工作包应含原任务段');
        assert.ok(brief.includes('本次审查未独立复验'), '工作包应含不声称复验的固定文案');
        return '结论：整改\n有 3 个未跟踪文件';
      },
    });
    assert.equal(out.status, 'done');
    assert.equal(out.verdict, 'red');
    assert.equal(out.remediated, true);
    const row = await runRow(pool, macroRunId);
    assert.equal(row.status, 'done');
    assert.equal(row.verdict, 'red');
    assert.ok(row.remediation_text.startsWith('[系统] '), '回灌正文以 [系统] 开头');
    const contents = await messageContents(pool, scene);
    assert.ok(
      contents.some((c) => c.startsWith('user:') && c.includes('[系统]') && c.includes('结论：整改')),
      `投影正文应含回灌内容，实得：${JSON.stringify(contents)}`,
    );
  });
});

// —— 判据 2：没有首行的话 ⇒ unclassified 且不回灌 ——
test('无判决首行 ⇒ done + unclassified + verdict_raw，不回灌', { skip: SKIP }, async (t) => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T2'));
    const macroRunId = await claim(pool, scene);
    const before = (await messageContents(pool, scene)).length;
    const out = await runMacroReview(pool, {
      macroRunId,
      reviewSessionId: scene.sessionId,
      originalRunId: scene.runId,
      reviewRunner: () => '这个 run 看起来还行，结论在正文里飘：结论：通过',
    });
    assert.equal(out.status, 'done');
    assert.equal(out.verdict, 'unclassified');
    assert.equal(out.remediated, false);
    const row = await runRow(pool, macroRunId);
    assert.equal(row.verdict, 'unclassified');
    assert.ok(row.verdict_raw.includes('结论：通过'), '原话应存进 verdict_raw');
    assert.equal(row.remediation_text, null);
    const after = (await messageContents(pool, scene)).length;
    assert.equal(after, before, 'unclassified 不得回灌（消息数不变）');
  });
});

// —— 判据 3：原会话有活跃 run ⇒ skipped/deferred，**verdict 保留原值** ——
test('回灌撞 409 ⇒ skipped + deferred + verdict 保留 red，不重试', { skip: SKIP }, async (t) => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T3'));
    await pool.query(`INSERT INTO runs (id, session_id, status) VALUES ($1,$2,'running')`,
      [crypto.randomUUID(), scene.sessionId]);
    const macroRunId = await claim(pool, scene);
    let calls = 0;
    const out = await runMacroReview(pool, {
      macroRunId,
      reviewSessionId: scene.sessionId,
      originalRunId: scene.runId,
      reviewRunner: () => { calls += 1; return '结论：整改\n正文'; },
    });
    assert.equal(out.status, 'skipped');
    assert.equal(out.verdict, 'red', '409 分支必须保留原判决（不是清空、不是 unclassified）');
    const row = await runRow(pool, macroRunId);
    assert.equal(row.status, 'skipped');
    assert.equal(row.skipped_reason, 'deferred');
    assert.equal(row.verdict, 'red');
    assert.equal(calls, 1, '不重试：审查 runner 只跑一次');
  });
});

// —— 判据 4：`until` 到期后桩返回 red ⇒ 不回灌，但判决照常入账 ——
test('until 到期 ⇒ 判决入账（done/red）但不触发回灌', { skip: SKIP }, async (t) => {
  await withFreshDb(async (pool) => {
    const until = new Date(Date.now() + 60_000);
    const scene = await seedScene(pool, ids('T4'), { until });
    const macroRunId = await claim(pool, scene);
    const before = (await messageContents(pool, scene)).length;
    const out = await runMacroReview(pool, {
      macroRunId,
      reviewSessionId: scene.sessionId,
      originalRunId: scene.runId,
      now: new Date(until.getTime() + 60_000), // 审查在到期后收尾
      reviewRunner: () => '结论：整改\n到期后的整改',
    });
    assert.equal(out.status, 'done');
    assert.equal(out.verdict, 'red', '到期前已启动的审查允许收尾，结果正常入流水');
    assert.equal(out.remediated, false);
    const row = await runRow(pool, macroRunId);
    assert.equal(row.remediation_text, null);
    const after = (await messageContents(pool, scene)).length;
    assert.equal(after, before, '到期后不得由它再触发整改 run');
  });
});

// —— ④ 失败出口：超时 / LLM 失败 ⇒ failed + unclassified，不回灌（#690：无快照失败出口）——
test('失败出口：timeout / llm 失败都记 failed+unclassified', { skip: SKIP }, async (t) => {
  await withFreshDb(async (pool) => {
    const cases = [
      ['timeout', { reviewRunner: () => { const e = new Error('slow'); e.kind = 'timeout'; throw e; } }],
      ['llm', { reviewRunner: () => { throw Object.assign(new Error('api down'), { kind: 'llm_error' }); } }],
    ];
    for (const [tag, extra] of cases) {
      const scene = await seedScene(pool, ids(`F${tag}`));
      const macroRunId = await claim(pool, scene);
      const out = await runMacroReview(pool, {
        macroRunId,
        reviewSessionId: scene.sessionId,
        originalRunId: scene.runId,
        reviewRunner: () => '结论：整改\n不该被用到',
        ...extra,
      });
      const row = await runRow(pool, macroRunId);
      assert.equal(row.status, 'failed', `${tag}: 失败出口必须是 failed（不是 red/needs-human）`);
      assert.equal(row.verdict, 'unclassified', `${tag}: 「没判成」≠「判成没过」`);
      assert.equal(row.remediation_text, null);
      const contents = await messageContents(pool, scene);
      assert.ok(!contents.some((c) => c.includes('[系统]')), `${tag}: 不回灌`);
    }
  });
});

// —— needs-human 直接转人工，不回灌 ——
test('needs-human ⇒ done + needs-human + 通知，不回灌', { skip: SKIP }, async (t) => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T5'));
    const macroRunId = await claim(pool, scene);
    const notices = [];
    const out = await runMacroReview(pool, {
      macroRunId,
      reviewSessionId: scene.sessionId,
      originalRunId: scene.runId,
      notify: (msg) => notices.push(msg),
      reviewRunner: () => '结论：需人工\n证据不足以裁决',
    });
    assert.equal(out.status, 'done');
    assert.equal(out.verdict, 'needs-human');
    assert.equal(out.remediated, false);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, 'review_needs_human');
  });
});

// —— depth ≤ 1：depth=1 的审查判 red 也不回灌 ——
test('depth=1 ⇒ 不回灌（递归闸）', { skip: SKIP }, async (t) => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T6'));
    const parent = await claimMacroRun(pool, {
      assignmentId: scene.assignmentId, anchor: `parent:${scene.runId}`,
      criterion: 'terminal', bucket: `parent:${scene.runId}`,
    });
    await pool.query('UPDATE macro_assignments SET enabled = true WHERE id = $1', [scene.assignmentId]);
    const child = await claimMacroRun(pool, {
      assignmentId: scene.assignmentId, anchor: `child:${scene.runId}`,
      criterion: 'terminal', bucket: `child:${scene.runId}`, depth: 1, parentMacroRunId: parent.id,
    });
    const before = (await messageContents(pool, scene)).length;
    const out = await runMacroReview(pool, {
      macroRunId: child.id,
      reviewSessionId: scene.sessionId,
      originalRunId: scene.runId,
      reviewRunner: () => '结论：整改\n第二层整改',
    });
    assert.equal(out.status, 'done');
    assert.equal(out.verdict, 'red');
    assert.equal(out.remediated, false);
    const after = (await messageContents(pool, scene)).length;
    assert.equal(after, before);
  });
});

// —— 纯函数（无库）：首行解析 fail closed 全谱 ——
test('parseVerdictLine：只认锚定的完整首行', () => {
  assert.equal(parseVerdictLine('结论：整改\n正文').verdict, 'red');
  assert.equal(parseVerdictLine('结论：通过\r\n正文（CRLF）').verdict, 'pass');
  assert.equal(parseVerdictLine('结论：需人工   \t').verdict, 'needs-human', '只 trim 右端空白');
  assert.equal(parseVerdictLine('结论：未证实有改动').verdict, 'no-op-claim');
  // 以下全部 fail closed ⇒ unclassified
  assert.equal(parseVerdictLine('## 结论：通过').verdict, 'unclassified', 'Markdown');
  assert.equal(parseVerdictLine('\uFEFF结论：通过').verdict, 'unclassified', 'BOM');
  assert.equal(parseVerdictLine(' 结论：通过').verdict, 'unclassified', '左端空格是非法首行');
  assert.equal(parseVerdictLine('正文里偶然有一句：\n结论：通过').verdict, 'unclassified', '非首行不算');
  assert.equal(parseVerdictLine('结论：通过通过').verdict, 'unclassified', '未知值');
  assert.equal(parseVerdictLine('结论：通').verdict, 'unclassified', '截断');
  assert.equal(parseVerdictLine('').verdict, 'unclassified', '缺行');
  assert.equal(parseVerdictLine('结论:通过').verdict, 'unclassified', '半角冒号');
  assert.equal(parseVerdictLine(null).verdict, 'unclassified');
});

test('extractVerificationCommands：防御式提取命令与退出码', () => {
  const rows = [{
    record: { turns: [
      { role: 'assistant', toolCalls: [
        { name: 'exec', input: { command: 'node --test x.test.js' },
          toolResult: { exit_code: 1, ok: false } },
        { name: 'readFile', input: { path: 'a' } },
      ] },
    ] },
  }];
  const got = extractVerificationCommands(rows);
  assert.deepEqual(got, [{ command: 'node --test x.test.js', exitCode: 1 }]);
});

test('buildReviewBrief：8KB 上限，超出截断并标注', async () => {
  const fakePool = { query: async () => ({ rows: [] }) };
  const huge = 'x'.repeat(MAX_BRIEF_BYTES * 2);
  const brief = await buildReviewBrief(fakePool, {
    gitFacts: { statusPorcelain: huge, logOneline: null, diffStat: null, head: 'h', detached: false, branch: 'b', hasRemote: true, ignoredFiles: [] },
  });
  // #692 ①：brief 末尾现在固定带一段「任务与回答格式」块（不参与截断预算——砍掉它审查就判不出来）。
  // 所以上限 = 事实部分的 maxBytes + 可见截断标注 + 尾块长度。
  const budget = MAX_BRIEF_BYTES + 128 + Buffer.byteLength(VERDICT_FORMAT_BLOCK, 'utf8');
  assert.ok(Buffer.byteLength(brief, 'utf8') <= budget,
    `超出上限要截断（只允许可见的截断标注尾巴 + 必留的格式块）：实际 ${Buffer.byteLength(brief, 'utf8')} > ${budget}`);
  assert.ok(brief.includes('已截断'));
});

// —— issue #692 ①：brief 必须把「结论：」判决格式说清楚 ——
//
// 真机事故：brief 只拼事实、没有一句任务要求 ⇒ 模型写了一份交付报告（首行「本次交付完成并
// 已闭环验证。」）⇒ `VERDICT_LINE_RE` 是**锚定首行**的 ⇒ 永远 `unclassified`。
// 为什么测不出来：所有用例都用桩 runner，桩直接返回 `'结论：通过'`。桩永远按契约回答，
// 真模型没人告诉它契约。
//
// 这两条钉的是**契约的两端**：brief 里必须有格式要求，且四种判决词一个不少。
test('#692-1 buildReviewBrief 含判决格式要求（四种判决词 + 「首行」字样）', async () => {
  const fakePool = { query: async () => ({ rows: [] }) };
  const brief = await buildReviewBrief(fakePool, {
    gitFacts: { statusPorcelain: '', logOneline: null, diffStat: null, head: 'h', detached: false, branch: 'b', hasRemote: true, ignoredFiles: [] },
  });
  for (const w of ['结论：通过', '结论：整改', '结论：未证实有改动', '结论：需人工']) {
    assert.ok(brief.includes(w), `brief 必须点明判决词「${w}」（否则模型不会输出，判决永远 unclassified）`);
  }
  assert.ok(brief.includes('首行'), '必须强调「首行」——VERDICT_LINE_RE 是锚定首行的');
  // 三种非法形状也要写清（真模型最容易在这三处跑偏）。
  assert.ok(brief.includes('前导空格'), '要写清前导空格不算');
  assert.ok(brief.includes('半角冒号'), '要写清半角冒号不算');
});

test('#692-2 brief 被截断时，判决格式块**仍然保留**（砍事实不能砍格式）', async () => {
  const fakePool = { query: async () => ({ rows: [] }) };
  const huge = 'x'.repeat(MAX_BRIEF_BYTES * 2);
  const brief = await buildReviewBrief(fakePool, {
    gitFacts: { statusPorcelain: huge, logOneline: null, diffStat: null, head: 'h', detached: false, branch: 'b', hasRemote: true, ignoredFiles: [] },
  });
  assert.ok(brief.includes('已截断'), '前提：这条 brief 确实被截断了');
  assert.ok(brief.includes('结论：通过'), '截断后格式要求必须补回尾巴——砍掉它等于让审查判不出来');
  // 格式块必须在**末尾**（模型最后读到的是指令，不是被截断的事实）。
  assert.ok(brief.lastIndexOf('结论：通过') > brief.lastIndexOf('已截断'), '格式块要排在截断标注之后');
});

// 退出收台（必须**最后注册**才能最后跑；实测教训，勿搬回文件头）：夹具的 adminPool 与
// `migrate` 用完的 pg 连接会留下仍 ref 着的 Socket（探针输出 `AFTER-HOOK handles: Socket:,Socket:`），
// 把 `node --test` 子进程钉住不退；而全局 `test.after` 实测会在尾部用例跑完前就触发
// （在它里面 process.exit 会砍掉未跑用例：实跑只剩 6/10）。这里关夹具池并把残余 Socket
// unref，事件循环自然排空——rc 仍完全由测试结果决定，不强杀。
test('退出收台：夹具池与残余 socket 不钉住进程', { skip: SKIP }, async () => {
  if (fixture?.adminPool) await fixture.adminPool.end();
  for (const h of process._getActiveHandles()) {
    if (h?.constructor?.name === 'Socket' && typeof h.unref === 'function') h.unref();
  }
  // 兜底：收台后若事件循环仍被残余连接钉住（实测 unref 后仍有晚到的重连），给它 3s 自然排空，
  // 到点强退——本用例是**最后注册的**，此刻全部结果已落 TAP，exit 只会剪尾不会砍用例。
  setTimeout(() => process.exit(process.exitCode ?? 0), 3000).ref();
  assert.ok(true);
});
