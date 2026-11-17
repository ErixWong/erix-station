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

// —— 用例 2：jail 内绝对路径被收（projects 与 home 都算，含更深子目录）——
test('#676-2 jail 内绝对路径被收：.../projects/x 与 .../home/.snapshots/x', () => {
  assert.equal(
    validateRunCwd(`${USR}/${FDE}/projects/x`, { userSpaceRoot: USR, fdeName: FDE }),
    `${USR}/${FDE}/projects/x`,
  );
  assert.equal(
    validateRunCwd(`${USR}/${FDE}/home/.snapshots/x`, { userSpaceRoot: USR, fdeName: FDE }),
    `${USR}/${FDE}/home/.snapshots/x`,
  );
  // cache 也允许。
  validateRunCwd(`${USR}/${FDE}/cache/tmp`, { userSpaceRoot: USR, fdeName: FDE });
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

// 兜底：validateSessionCwd 回归不受影响。
test('回归：validateSessionCwd 仍只认 ~/projects/<name>', () => {
  assert.equal(validateSessionCwd('~/projects/a'), '~/projects/a');
  assert.throws(() => validateSessionCwd('/abs'), SessionError);
});
