// issue #850：通知标题入库存「键 + 参数」，渲染时按读者当前语言拼；**存量行逐字不变**。
//
// 病：写入方常常是**调度器**（没有人、没有请求、没有语言）⇒「给写入方塞一个 locale」是把问题搬家。
// 正解：`notifications.title_key` + `title_params`（迁移 0049），`title` 继续写成品中文当**回退面**。
//
// 本文件的判据（钉具体字面，不钉「有没有翻译」）：
//   ① `createNotification` 传 `titleKey`/`titleParams` ⇒ INSERT 里两列都在、参数按 jsonb 落；
//      `toNotificationSnapshot` 返回 `title_key`/`title_params`（具体值）。
//   ② 不传 ⇒ 两列 `NULL`，snapshot 里**两个键都不出现**（不许给 `null` 壳），`title` 逐字不变。
//   ③ 真库（`TEST_DATABASE_URL`）：行里两列的**实际值** + 列表读侧的 snapshot 形状。
//   ④ 迁移 0049 的形状闸：文件在、两条 `ADD COLUMN IF NOT EXISTS`、不碰 `title` 的 NOT NULL。
//
// 环境门：①② 用**桩 pool**（不需要 PG ⇒ 变异自证在没有真库时也红）；③ 无 PG 时 skip（口径同
// `notifications.test.js`：`TEST_DATABASE_URL` 未设 ⇒ 真库用例整体 skip，不是假通过）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';
import { createNotification, listNotifications, toNotificationSnapshot } from '../src/notifications.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
const SKIP = URL_VALUE ? false : SKIP_WITHOUT_PG;
const fixture = URL_VALUE ? createPgFixture(URL_VALUE, { prefix: 'w850n' }) : null;
const withFreshDb = (fn) => fixture.withFreshDatabase(({ pool }) => fn(pool), { log: () => {} });

/**
 * 桩 pool：把 INSERT 的 SQL/参数留下来，并**照 pg 的行为**回一行（jsonb 参数回成**已解析对象**，
 * 这是读侧「snapshot 里拿到的是对象而不是字符串」那条判据的前提，不是偷懒）。
 */
function stubPool() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const at = new Date('2026-11-27T02:00:00.000Z');
      return {
        rows: [{
          id: 'n-1', user_id: params[1], macro_run_id: params[2], severity: params[3],
          title: params[4], body: params[5], created_at: at,
          title_key: params[7],
          title_params: typeof params[8] === 'string' ? JSON.parse(params[8]) : params[8],
        }],
      };
    },
  };
}

const INSERT_COLS = /INSERT INTO notifications\s*\(([^)]*)\)/i;

// ── ① 键 + 参数进库，snapshot 带两个键（桩 pool，无需 PG）────────────────────────
test('#850 createNotification 传 titleKey/titleParams ⇒ INSERT 两列都写、snapshot 给出具体值', async () => {
  const pool = stubPool();
  const snap = await createNotification(pool, {
    userId: 'u-1', severity: 'info',
    title: '宏「每日巡检」已到期',
    titleKey: 'notifications.macroExpired',
    titleParams: { name: '每日巡检' },
    body: '订阅已自动停用',
  });
  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0];
  const cols = sql.match(INSERT_COLS)[1].split(',').map((s) => s.trim());
  assert.ok(cols.includes('title_key'), `INSERT 列必须含 title_key：${cols.join(',')}`);
  assert.ok(cols.includes('title_params'), `INSERT 列必须含 title_params：${cols.join(',')}`);
  // 具体字面值（不是「非空」）
  assert.equal(params[7], 'notifications.macroExpired');
  assert.equal(params[8], '{"name":"每日巡检"}', 'jsonb 参数必须序列化后交给 pg');
  assert.equal(snap.title_key, 'notifications.macroExpired');
  assert.deepEqual(snap.title_params, { name: '每日巡检' });
  assert.equal(snap.title, '宏「每日巡检」已到期', 'title 是回退面，不许被键顶掉');
});

// ── ② 不传 ⇒ 两列 NULL、两个键都不出现、title 逐字不变（存量形状）──────────────────
test('#850 不传 titleKey/titleParams ⇒ 两列 NULL、snapshot 里两个键都不出现（不是 null 壳）、title 逐字不变', async () => {
  const pool = stubPool();
  const snap = await createNotification(pool, {
    userId: 'u-1', severity: 'error', title: '宏「每日巡检」执行失败', body: 'boom',
  });
  const { params } = pool.calls[0];
  assert.equal(params[7], null, '没给键 ⇒ 落库 NULL（=「照旧用 title」）');
  assert.equal(params[8], null, '没给参数 ⇒ 落库 NULL');
  assert.ok(!('title_key' in snap), `snapshot 不许出现 title_key 空壳：${JSON.stringify(snap)}`);
  assert.ok(!('title_params' in snap), `snapshot 不许出现 title_params 空壳：${JSON.stringify(snap)}`);
  assert.equal(snap.title, '宏「每日巡检」执行失败');
  // 存量行的读侧形状：与 #850 之前**逐字同一组键**（顺序无关，键集合必须一模一样）。
  assert.deepEqual(
    Object.keys(snap).sort(),
    ['body', 'created_at', 'id', 'read_at', 'severity', 'title'],
    '无键行的 snapshot 键集合不得变化（老读侧零感知）',
  );
});

test('#850 toNotificationSnapshot：脏值不造键（空串/空白键、非对象参数）', () => {
  const legacy = { id: 'x', severity: 'info', title: '老通知', body: '', read_at: null, created_at: null };
  assert.ok(!('title_key' in toNotificationSnapshot(legacy)), '存量行（无这两列）⇒ 不出键');
  assert.ok(!('title_key' in toNotificationSnapshot({ ...legacy, title_key: '   ' })), '空白键不是键');
  assert.ok(!('title_params' in toNotificationSnapshot({ ...legacy, title_params: 'null' })), '字符串不是参数对象');
  assert.ok(!('title_params' in toNotificationSnapshot({ ...legacy, title_params: null })), 'NULL 不是参数对象');
  const keyed = toNotificationSnapshot({ ...legacy, title_key: 'notifications.macroFailed', title_params: { name: 'x' } });
  assert.equal(keyed.title_key, 'notifications.macroFailed');
  assert.deepEqual(keyed.title_params, { name: 'x' });
  assert.equal(keyed.title, '老通知');
});

// ── ③ 真库：两列的实际值 + 列表读侧形状 ──────────────────────────────────────────
test('#850 真库：带键的行两列落库、无键的行两列 NULL，列表读侧 snapshot 形状一致', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const userId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, login, password_hash, status, role) VALUES ($1,$2,'x','active','fde')`,
      [userId, `n850${userId.slice(0, 6)}`],
    );
    await createNotification(pool, {
      userId, severity: 'info',
      title: '宏「每日巡检」',
      titleKey: 'notifications.macroTriggered',
      titleParams: { name: '每日巡检' },
      createdAt: new Date('2026-11-27T03:00:00.000Z'),
    });
    await createNotification(pool, {
      userId, severity: 'info', title: '完成审查暂未启用',
      createdAt: new Date('2026-11-27T03:00:01.000Z'),
    });
    const raw = (await pool.query(
      `SELECT title, title_key, title_params FROM notifications WHERE user_id=$1 ORDER BY created_at`, [userId],
    )).rows;
    assert.equal(raw.length, 2);
    assert.equal(raw[0].title_key, 'notifications.macroTriggered');
    assert.deepEqual(raw[0].title_params, { name: '每日巡检' }, 'jsonb ⇒ pg 回成对象');
    assert.equal(raw[0].title, '宏「每日巡检」', '回退面的中文仍在（存量兼容）');
    assert.equal(raw[1].title, '完成审查暂未启用');
    assert.equal(raw[1].title_key, null, '不传 ⇒ 真库里就是 NULL');
    assert.equal(raw[1].title_params, null);

    const { items } = await listNotifications(pool, { userId });
    assert.equal(items.length, 2);
    const keyed = items.find((n) => n.title === '宏「每日巡检」');
    assert.equal(keyed.title_key, 'notifications.macroTriggered');
    assert.deepEqual(keyed.title_params, { name: '每日巡检' });
    const legacy = items.find((n) => n.title === '完成审查暂未启用');
    assert.ok(!('title_key' in legacy) && !('title_params' in legacy),
      `存量形状的行不许出现空壳键：${JSON.stringify(legacy)}`);
  });
});

// ── ④ 迁移 0049 形状闸 ───────────────────────────────────────────────────────────
test('#850 迁移 0049：两条 ADD COLUMN IF NOT EXISTS（幂等）+ 不给 title 加 NOT NULL 变更', () => {
  const file = path.join(HERE, '../../deploy/migrations/0049-notifications-title-key.sql');
  assert.ok(fs.existsSync(file), '0049-notifications-title-key.sql 必须存在');
  const sql = fs.readFileSync(file, 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS title_key text/i, 'title_key 幂等可重放');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS title_params jsonb/i, 'title_params 是 jsonb 且幂等');
  assert.match(sql, /ALTER TABLE notifications/i, '改的是 notifications 表');
  assert.doesNotMatch(sql, /ADD COLUMN[^\n]*\btitle\s/i, '不许新增/重建成品 title 列');
  assert.doesNotMatch(sql, /DROP NOT NULL|ALTER COLUMN title TYPE/i, 'title 的 NOT NULL 不动（存量行逐字不变）');
  assert.doesNotMatch(sql, /^\s*(BEGIN|COMMIT)\s*;/im, '事务边界归 runner');
});

// ── 变异自证的锚：删掉 createNotification 的 title_key 写入 ⇒ 上面 ①③ 必红 ──────────
// （见工单「变异自证」第 2 条；桩 pool 那条不依赖 PG，所以没起真库也红。）
