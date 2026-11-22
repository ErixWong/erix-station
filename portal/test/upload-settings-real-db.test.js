// issue #698：**真库**判据 —— `SAVE_SQL` 的形状只有在真库里才是事实。
//
// 现场（issue #698 正文的 V0/V1/V2/V4 对照，本文件是它的判据化）：
//   `prev` CTE 带 `FOR UPDATE` ⇒ 在**含 data-modifying CTE 的同一条语句**里看不见本语句要改的那行
//   ⇒ `prev` 恒空集；`aud` 与主查询又是 `FROM upd, prev_eff` **内连接** ⇒ 首写时主查询 0 行、审计不写。
//   后果：保存恒 500（`resolveFromRow(null).source !== 'db'`），而**值已经写进库、审计一行没有**。
//
// 为什么必须真库：`portal/test/upload-settings.test.js` 全走 fake pool，而 fake 是按 **SQL 文本**裁决的
// 模拟 —— 它不会因为「同语句内 data-modifying CTE 看不见旧行」或「内连接遇到空 `prev_eff`」就少给一行。
// ⇒ 那条 SQL 改坏了它照样 21 格全绿。**判据类型选错**不是"测得不细"，所以补的是真库判据而不是 fake 分支。
//
// 环境门（口径照 `portal/test/migrate-fresh-db.test.js`，文案由 `pg-fixture.js` 的 `SKIP_WITHOUT_PG` 单点持有）：
//   有 PG（**一次性**实例，绝不指向真库 station-db，docs/testing.md §2.2.1 / §2.2.4）：
//     docker run -d --rm --name pg698 -p 127.0.0.1:55440:5432 \
//       -e POSTGRES_USER=p -e POSTGRES_PASSWORD=p -e POSTGRES_DB=p postgres:16
//     docker exec pg698 pg_isready -U p -d p -t 15
//     TEST_DATABASE_URL=postgres://p:p@127.0.0.1:55440/p \
//       node --test portal/test/upload-settings-real-db.test.js
//   无 PG：`TEST_DATABASE_URL` 未设置 ⇒ **整个文件 skip**（不是假通过：计入 `# skipped`；
//   下面那条「环境门自证」用例不设 skip，专门盯这个门有没有把真库用例静默放行）。
//
// 隔离：只连注入的那台，每条用例 `CREATE DATABASE` 自建自删（`withFreshDatabase`，内含跨进程文件锁）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';
import {
  DEFAULT_MAX_FILE_BYTES, AUDIT_ACTION, AUDIT_TARGET, updateUploadSettings,
} from '../src/upload-settings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
const SKIP = URL_VALUE ? false : SKIP_WITHOUT_PG;
const MIB = 1024 * 1024;
// env 显式给了值（`fileUploadMaxBytesSource: 'env'` 是 `loadConfig` 的产出形状）⇒ 回落位是 `env`。
const ENV32 = { fileUploadMaxBytes: DEFAULT_MAX_FILE_BYTES, fileUploadMaxBytesSource: 'env' };
const ACTOR = 'd0000000-0000-4000-8000-0000000000a1';

// 表形**不自己发明**：库由夹具按 baseline + bootstrap + 全部增量建出来，`upload_settings` 来自
// 迁移 0036、`audit_log` 来自 baseline（0026 线）。下面只是把两边读回来的形状摆在一起对账。
const fixture = URL_VALUE ? createPgFixture(URL_VALUE, { prefix: 'u698' }) : null;

/** 每条用例一个全新库；`seed` 里的 SQL 按顺序跑（用来造「库里已有一行」的现场）。 */
const withFreshDb = (fn) => fixture.withFreshDatabase(({ pool }) => fn(pool), { log: () => {} });

const save = (pool, maxFileBytes) => updateUploadSettings({
  pool, config: ENV32, actorId: ACTOR, fields: { maxFileBytes },
});
const auditRows = (pool) => pool.query(
  `SELECT details ->> 'previous_max_bytes' AS previous_max_bytes,
          details ->> 'previous_source'     AS previous_source,
          details -> 'max_file_bytes'       AS max_file_bytes,
          actor_id
     FROM audit_log WHERE action = $1 AND target = $2 ORDER BY id`,
  [AUDIT_ACTION, AUDIT_TARGET],
);
const dbValue = (pool) => pool.query('SELECT max_file_bytes::text AS v FROM upload_settings WHERE id = 1');

// ---------------------------------------------------------------------------
test('#698 首写（表里没行）：保存不抛、值落库、审计恰好 1 行且 previous_max_bytes 是 null', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    await pool.query(`INSERT INTO users (id, login, password_hash, status) VALUES ($1, 'u698', 'x', 'active')`,
      [ACTOR]);
    const res = await save(pool, 20 * MIB); // 旧形状在这里抛 500（rowCount=0 ⇒ 读回不可用）
    assert.equal(res.settings.maxFileBytes, 20 * MIB, '响应里的生效值必须来自 RETURNING（= 落库值）');
    assert.equal((await dbValue(pool)).rows[0].v, String(20 * MIB), '库里必须真是这个值');
    const rows = (await auditRows(pool)).rows;
    assert.equal(rows.length, 1, `首写必须写 1 行审计（旧形状这里是 0 行 = 设置生效而审计无痕）`);
    assert.equal(rows[0].previous_max_bytes, null, '首写没有旧值 ⇒ 审计里 previous_max_bytes 必须是 null');
    assert.equal(rows[0].previous_source, null, '同理 previous_source 也是 null（LEFT JOIN 出来的空位）');
    assert.equal(String(rows[0].max_file_bytes), String(20 * MIB), '新值记的是落库值');
    assert.equal(String(rows[0].actor_id), ACTOR, '审计必须记是谁改的');
  });
});

test('#698 二写：previous_max_bytes 是首写那个值、审计 2 行（串成一条链）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    await pool.query(`INSERT INTO users (id, login, password_hash, status) VALUES ($1, 'u698', 'x', 'active')`,
      [ACTOR]);
    await save(pool, 20 * MIB);
    const res = await save(pool, 40 * MIB);
    assert.equal(res.previous.maxFileBytes, 20 * MIB, '接口返回的 previous 必须是紧邻的前一个值');
    const rows = (await auditRows(pool)).rows;
    assert.equal(rows.length, 2, `两次保存必须各写 1 行审计，实得 ${rows.length} 行`);
    assert.equal(rows[1].previous_max_bytes, String(20 * MIB),
      '第二条审计的 previous_max_bytes 必须是首写落的那个值（旧形状在这里是 null：FOR UPDATE 让 prev 空）');
    assert.equal(rows[1].previous_source, 'db', '旧值可用 ⇒ 来源必须写 db（不许谎报 env）');
    assert.equal(rows[0].previous_max_bytes, null, '第一条仍是首写（无旧值）');
    assert.equal((await dbValue(pool)).rows[0].v, String(40 * MIB), '终值是第二次写的值');
  });
});

test('#698 区间外旧值那一档不被 LEFT JOIN 破坏：previous_source 回落 env/default（不是 db）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    await pool.query(`INSERT INTO users (id, login, password_hash, status) VALUES ($1, 'u698', 'x', 'active')`,
      [ACTOR]);
    await save(pool, 20 * MIB);
    // 手工造一个「绕过写侧进来」的旧值：8 TiB，远超管理台天花板 1 GiB（DB 只有 CHECK > 0，挡不住它）。
    await pool.query('UPDATE upload_settings SET max_file_bytes = 8::bigint * 1024 * 1024 * 1024 * 1024 WHERE id = 1');
    assert.equal((await dbValue(pool)).rows[0].v, String(8192 * 1024 * MIB), '现场必须是区间外的值（8 TiB）');
    const res = await save(pool, 30 * MIB);
    assert.equal(res.previous.maxFileBytes, DEFAULT_MAX_FILE_BYTES, '区间外 ⇒ 接口说 previous 是兜底值');
    assert.equal(res.previous.source, 'env', '兜底位来自显式 env（loadConfig 的来源标注），不许猜');
    const rows = (await auditRows(pool)).rows;
    assert.equal(rows.length, 2, '保存本身必须成功并写下第二条审计');
    assert.equal(rows[1].previous_source, 'env',
      `审计里的 previous_source 必须是回落位（env/default），不能是 db，实得 ${rows[1].previous_source}`);
    assert.equal(rows[1].previous_max_bytes, String(DEFAULT_MAX_FILE_BYTES),
      'previous_max_bytes 必须是真正在用的那个兜底值，不是库里那个 8 TiB');
    assert.equal((await dbValue(pool)).rows[0].v, String(30 * MIB), '区间外的旧值不许把新值顶回去');
  });
});

// ---------------------------------------------------------------------------
// 环境门自证（不设 skip）：无 PG 时上面三格必须是 **skip**，不是 pass。
// 少了这条，"文件里全是 skip" 与 "文件里全是假通过" 在门禁报告上长得一样。
const GUARDED = [
  '#698 首写（表里没行）：保存不抛、值落库、审计恰好 1 行且 previous_max_bytes 是 null',
  '#698 二写：previous_max_bytes 是首写那个值、审计 2 行（串成一条链）',
  '#698 区间外旧值那一档不被 LEFT JOIN 破坏：previous_source 回落 env/default（不是 db）',
];

test('#698 环境门自证：三格真库用例的名字必须与本文件用例一一对应，且门的形状正确', () => {
  const selfSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.equal(GUARDED.length, 3, '真库判据至少 3 格（首写 / 二写 / 区间外回落）');
  for (const name of GUARDED) {
    assert.ok(selfSrc.includes(`test('${name}'`), `环境门名单与本文件用例名漂移：${name}`);
  }
  if (!URL_VALUE) {
    assert.match(SKIP, /TEST_DATABASE_URL 未设置/, '无 PG 时必须整体 skip（skip 文案点名一次性实例的起法）');
  } else {
    assert.equal(SKIP, false, '有 PG 时 skip 标志必须是 false（否则三格被静默跳过 = 假通过）');
  }
  // 反向自证：产品侧的 SQL 形状必须真的是「无 FOR UPDATE + 两处 LEFT JOIN」，否则上面三格测的就不是它。
  const src = fs.readFileSync(path.join(HERE, '../src/upload-settings.js'), 'utf8');
  const saveSql = /const SAVE_SQL = `([\s\S]*?)`;/.exec(src)?.[1] ?? '';
  assert.ok(saveSql, 'upload-settings.js 里必须能读到 SAVE_SQL 原文');
  assert.doesNotMatch(saveSql, /\bFOR UPDATE\b/, 'prev 不许带回 FOR UPDATE（#698：同语句内看不见旧行）');
  assert.equal((saveSql.match(/LEFT JOIN prev_eff ON true/g) || []).length, 2,
    'aud 与主查询两处都必须是 LEFT JOIN prev_eff ON true');
});
