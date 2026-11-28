// issue #676 ①：越界 cwd 响亮失败。
//  - 纯函数 `validateRunCwd`（用例 2–5，无需 DB）。
//  - `postMessage` 收到越界 cwd ⇒ validation_failed、不刷会话 cwd、不入队 run（用例 1，真库）。
// 真库门：TEST_DATABASE_URL 未设 ⇒ DB 用例 skip；纯函数用例恒跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { validateRunCwd, validateSessionCwd, postMessage, SessionError } from '../src/sessions.js';
import { hashToken } from '../src/auth.js';
import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';

const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
const SKIP = URL_VALUE ? false : SKIP_WITHOUT_PG;
const fixture = URL_VALUE ? createPgFixture(URL_VALUE, { prefix: 'w676' }) : null;
const withFreshDb = (fn) => fixture.withFreshDatabase(({ pool }) => fn(pool), { poolMax: 2, log: () => {} });

const USR = '/srv/erix/users';
const FDE = 'erix';

// —— 用例 2（#890 收紧后的重写，取代旧 #676-2）：绝对 `<fde>/projects/<name>` ⇒ 归一 tilde；home/cache ⇒ 拒 ——
// 旧 #676 口径把 home/cache 当「jail 内合法」并原样返回**绝对路径**；#890 起 runner
// （`resolveRunCwd`）只认 `~/projects/<name>`，绝对形态下发后会被那条 warn 分支静默回退成
// `run.project.name`（三层不一致）。所以边界只认能被 runner 还原的形态：
//   ① 绝对 projects/<name> 折叠成 `~/projects/<name>`（不再原样返回绝对）；② home/cache 当场拒。
// 本改是**收紧**（断言更严）而非放宽：旧断言「home 返回绝对路径」在新口径下变成「抛错」。
test('#890-2 绝对 projects/<name> ⇒ 归一 tilde；绝对 home/cache ⇒ validation_failed', () => {
  // ① projects/<name>：归一为 tilde 形态（宿主绝对路径不再原样返回）。
  assert.equal(
    validateRunCwd(`${USR}/${FDE}/projects/x`, { userSpaceRoot: USR, fdeName: FDE }),
    '~/projects/x',
  );
  assert.equal(
    validateRunCwd(`${USR}/${FDE}/projects/app_a`, { userSpaceRoot: USR, fdeName: FDE }),
    '~/projects/app_a',
  );
  // ② home / cache 绝对路径：runner 还原不出等价目录 ⇒ 当场拒（旧口径在此返回绝对，现收紧为抛错）。
  for (const abs of [`${USR}/${FDE}/home/.snapshots/x`, `${USR}/${FDE}/cache/tmp`]) {
    assert.throws(
      () => validateRunCwd(abs, { userSpaceRoot: USR, fdeName: FDE }),
      (e) => e instanceof SessionError && e.code === 'validation_failed' && e.details?.field === 'cwd',
      `home/cache 绝对 cwd 必须拒：${abs}`,
    );
  }
});

// —— 用例 3：`~/projects/<name>` 形式仍通过（回归）——
test('#676-3 ~/projects/<name> 形式仍通过（回归）', () => {
  assert.equal(validateRunCwd('~/projects/app_a', {}), '~/projects/app_a');
  assert.equal(validateRunCwd('~/projects/app_a', { userSpaceRoot: USR, fdeName: FDE }), '~/projects/app_a');
  // 与 validateSessionCwd 同口径：非法形态仍拒。
  assert.throws(() => validateRunCwd('~/projects/a/b', {}), SessionError);
});

// —— 用例 4：`..` 穿越被拒（resolve 后越界）——
test('#676-4 .. 穿越被拒：<userSpaceRoot>/<fde>/projects/../../etc', () => {
  assert.throws(
    () => validateRunCwd(`${USR}/${FDE}/projects/../../etc`, { userSpaceRoot: USR, fdeName: FDE }),
    (e) => e instanceof SessionError && e.code === 'validation_failed' && e.details?.field === 'cwd',
  );
});

// —— 用例 5：platform/git 被拒（平台挂载点，不许当 run cwd）——
test('#676-5 platform/git 被拒（不是 run cwd）', () => {
  assert.throws(
    () => validateRunCwd(`${USR}/${FDE}/platform/git`, { userSpaceRoot: USR, fdeName: FDE }),
    (e) => e instanceof SessionError && e.code === 'validation_failed' && e.details?.field === 'cwd',
  );
});

// —— 附加：越界绝对路径 / 相对但非 ~/ 一律拒（响亮失败基线）——
test('#676-x 越界绝对路径（/root/.erix/...）与非 ~ 相对路径被拒', () => {
  for (const bad of ['/root/.erix/w4a-snapshots/x', '/etc/passwd', 'projects/a', 'foo/bar']) {
    assert.throws(
      () => validateRunCwd(bad, { userSpaceRoot: USR, fdeName: FDE }),
      (e) => e instanceof SessionError && e.details?.field === 'cwd',
      `应拒 ${bad}`,
    );
  }
  // 空 cwd 拒。
  assert.throws(() => validateRunCwd('', {}), SessionError);
  assert.throws(() => validateRunCwd(null, {}), SessionError);
});

// —— issue #919-A：绝对 cwd 不得整条 trim 后再折叠（首尾空白即拒）——
// Linux 目录名可合法含首尾空格；若先把绝对路径 trim 再折叠，`<jail>/projects/x ` 会被折成
// `~/projects/x`（指向另一个目录且不报错）。故绝对形态带首尾空白 ⇒ 直接拒（details.field='cwd' 且带 en）。
// 反面对照：`~/projects/x ` 这种 tilde 形态仍按既有 trim 行为通过（会话约定，不制造新行为）。
test('#919-A 绝对 cwd 带首尾空白 ⇒ validation_failed（details.field=cwd 且带 en）；尾空格', () => {
  // ① 尾部带一个空格
  assert.throws(
    () => validateRunCwd(`${USR}/${FDE}/projects/x `, { userSpaceRoot: USR, fdeName: FDE }),
    (e) => {
      assert.ok(e instanceof SessionError, '必须是 SessionError');
      assert.equal(e.code, 'validation_failed');
      assert.equal(e.details.field, 'cwd');
      assert.equal(typeof e.en, 'string');
      assert.ok(e.en.length > 0, '错误必须带 en（中英双语）');
      return true;
    },
  );
  // ② 头部带空白同理
  assert.throws(
    () => validateRunCwd(` ${USR}/${FDE}/projects/x`, { userSpaceRoot: USR, fdeName: FDE }),
    (e) => e instanceof SessionError && e.code === 'validation_failed' && e.details.field === 'cwd' && typeof e.en === 'string' && e.en.length > 0,
  );
  // 首尾都带空白
  assert.throws(
    () => validateRunCwd(`  ${USR}/${FDE}/projects/x\t`, { userSpaceRoot: USR, fdeName: FDE }),
    (e) => e instanceof SessionError && e.code === 'validation_failed' && e.details.field === 'cwd',
  );
  // ③ 反面对照：tilde 形态的尾部空格仍按既有行为通过（不能被一并拒）
  assert.equal(validateRunCwd('~/projects/x ', { userSpaceRoot: USR, fdeName: FDE }), '~/projects/x');
  assert.equal(validateRunCwd('  ~/projects/x', {}), '~/projects/x');
  // 反面对照：绝对且无首尾空白仍正常折叠
  assert.equal(validateRunCwd(`${USR}/${FDE}/projects/x`, { userSpaceRoot: USR, fdeName: FDE }), '~/projects/x');
});

// —— issue #919-C：恢复被 #890 误删的 details.allowed（API 契约回归）——
// 旧实现里「第一段子目录 ∉ JAIL_RUN_CWD_HOST_SUFFIXES」这一支（platform/git 等）本就带 details.allowed；
// #890 重写时把它误删（既有测试只钉 code+details.field 所以没红）。本格钉**完整 details 键集合**
// （不只 field）+ 钉 en 字面存在 + 钉 allowed 值。用 platform/git（旧就带 allowed 的那一支），
// 不用 home/cache（那是 #890 新增「非 projects/<name> 一级」拒支，只带 field）。
test('#919-C platform/git 那一支仍带 details.allowed（完整键集合 + en 字面 + allowed 值）', () => {
  let err;
  try {
    validateRunCwd(`${USR}/${FDE}/platform/git`, { userSpaceRoot: USR, fdeName: FDE });
    assert.fail('platform/git 必须被拒');
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof SessionError);
  assert.equal(err.code, 'validation_failed');
  // 完整 details 键集合：既有 field 也有 allowed（不只 field）。
  assert.deepStrictEqual(Object.keys(err.details).sort(), ['allowed', 'field']);
  assert.equal(err.details.field, 'cwd');
  assert.deepStrictEqual([...err.details.allowed], ['home', 'projects', 'cache']);
  // en 字面存在且照旧（“jail subdirectory ... allowed: ...”）。
  assert.equal(typeof err.en, 'string');
  assert.ok(err.en.includes('the jail subdirectory of cwd cannot be used as a run directory'), err.en);
  assert.ok(err.en.includes('allowed: home, projects, cache'), err.en);
});

// —— 用例 1：postMessage 越界 cwd ⇒ validation_failed、不刷会话 cwd、不入队 run（真库）——
test('#676-1 postMessage 越界 cwd ⇒ validation_failed、会话 cwd 不变、run_queue 无新行',
  { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const userId = crypto.randomUUID();
    const login = `w676${userId.slice(0, 6)}`;
    const sessionId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, login, password_hash, status, fde_name) VALUES ($1,$2,'x','active',$2)`,
      [userId, login],
    );
    await pool.query(
      `INSERT INTO containers (id, user_id, runner_token_hash, image, agent_version, status, fde_name, container_name)
       VALUES ($1,$2,$3,'img','0.32.0','running',$4,$5)`,
      [crypto.randomUUID(), userId, hashToken('tok-w676'), login, `fde-${login}`],
    );
    await pool.query(
      `INSERT INTO chat_sessions (id, user_id, project_id, title, model, cwd, status, last_seq)
       VALUES ($1,$2,NULL,'t','mock-model','~/projects/orig','active',0)`,
      [sessionId, userId],
    );
    const rqBefore = await pool.query(`SELECT count(*)::int AS c FROM run_queue`);

    await assert.rejects(
      () => postMessage(pool, {
        userId, sessionId, content: '跑一下审查', cwd: '/root/.erix/w4a-snapshots/x',
        config: { userSpaceRoot: USR },
      }),
      (e) => e instanceof SessionError && e.code === 'validation_failed' && e.details?.field === 'cwd',
      '越界 cwd 必须响亮失败',
    );

    const sess = await pool.query(`SELECT cwd FROM chat_sessions WHERE id=$1`, [sessionId]);
    assert.equal(sess.rows[0].cwd, '~/projects/orig', '越界 ⇒ 会话 cwd 不刷');
    const rqAfter = await pool.query(`SELECT count(*)::int AS c FROM run_queue`);
    assert.equal(rqAfter.rows[0].c, rqBefore.rows[0].c, '越界 ⇒ 不入队 run（run_queue 无新行）');
  });
});

// —— #890 调用点钉子（无需 DB）：postMessage 改了 cwd ⇒ 落库用的是**校验器返回的规范值** ——
// 假 pool 驱动真实 postMessage 事务（appendUserTurn 探针全回空 ⇒ round 派生 0），
// 只看 `UPDATE chat_sessions SET cwd` 的参数：传入绝对 `<userSpaceRoot>/<fde>/projects/<name>`
// ⇒ 落库必须是 `~/projects/<name>`（而不是原样绝对）。
// 反向自证（变异 ①）：把 sessions.js 里 `nextCwd = validateRunCwd(...)` 改回「只调用不接值」
// ⇒ nextCwd 仍是原始绝对形态 ⇒ 本断言当场红（证明调用点真的用了返回值，不是恒真）。
test('#890 调用点：postMessage 传绝对 projects/<name> ⇒ 落库 cwd 是归一的 ~/projects/<name>（非原样）', async () => {
  const userId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const sessionRow = {
    id: sessionId, user_id: userId, project_id: null, cwd: '~/projects/orig', title: 't',
    title_source: 'auto', model: 'mock-model', status: 'active', last_seq: 0, origin: null,
  };
  const queries = [];
  const dispatch = (sql, params = []) => {
    if (/FROM chat_sessions s/.test(sql)) return { rows: [sessionRow] };
    if (/fde_name FROM users/.test(sql)) return { rows: [{ fde_name: 'erix' }] };
    if (/FROM runs WHERE session_id/.test(sql)) return { rows: [] };
    if (/FROM containers/.test(sql)) return { rows: [{ id: 'c1' }] };
    if (/UPDATE chat_sessions SET last_seq/.test(sql)) return { rows: [{ last_seq: 1 }] };
    if (/INSERT INTO messages/.test(sql)) {
      return { rows: [{ id: crypto.randomUUID(), seq: 1, role: 'user', content: '', attachments: [], created_at: new Date('2026-01-01T00:00:00.000Z') }] };
    }
    if (/SELECT record\s+FROM transcript_rounds/.test(sql)) return { rows: [] };
    if (/SELECT MAX\(round\)/.test(sql)) return { rows: [{ max_round: null }] };
    if (/SELECT round, dedup_key, record\s+FROM transcript_rounds/.test(sql)) return { rows: [] };
    if (/INSERT INTO transcript_rounds/.test(sql)) return { rows: [{ id: 1 }] };
    if (/INSERT INTO runs /.test(sql)) return { rows: [{ id: crypto.randomUUID(), status: 'queued', trigger_kind: params[2] }] };
    return { rows: [] };
  };
  const client = { async query(sql, params = []) { queries.push({ sql, params }); return dispatch(sql, params); }, release() {} };
  const pool = {
    // issue #905 之后，`postMessage` 在建 run 前会先走一次 pool 级的 LLM 上游预检（不经过 `connect()`）。
    // 本单这格验的是 cwd 归一，不是预检本身 ⇒ 把「绑定已配好」回一行；**其余 SQL 不认就直接抛**，
    // 免得将来出口又长出一条新查询被这里的兵底默默放行（同 #905 在其他文件里的写法）。
    async query(sql) {
      const s = String(sql).replace(/\s+/g, ' ').trim(); // 那条预检 SQL 是多行字面，不归一匹配不上
      if (!/^SELECT 1 FROM fde_llm_bindings b\b/.test(s)) throw new Error(`unexpected pool SQL: ${sql}`);
      return { rows: [{ '?column?': 1 }] };
    },
    async connect() { return client; },
  };

  await postMessage(pool, {
    userId, sessionId, content: 'hi',
    cwd: '/srv/erix/users/erix/projects/demo_app',
    config: { userSpaceRoot: '/srv/erix/users' },
  });

  const cwdUpd = queries.find((q) => /UPDATE chat_sessions SET cwd/.test(q.sql));
  assert.ok(cwdUpd, 'cwd 与会话原值不同 ⇒ 必须发出 UPDATE chat_sessions SET cwd');
  assert.equal(cwdUpd.params[1], '~/projects/demo_app', '落库 cwd 必须是校验器归一的 tilde 形态');
  assert.notEqual(cwdUpd.params[1], '/srv/erix/users/erix/projects/demo_app', '宿主绝对路径绝不能原样落库');
});

// 兜底：validateSessionCwd 回归不受影响。
test('回归：validateSessionCwd 仍只认 ~/projects/<name>', () => {
  assert.equal(validateSessionCwd('~/projects/a'), '~/projects/a');
  assert.throws(() => validateSessionCwd('/abs'), SessionError);
});
