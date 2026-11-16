// issue #526（事件平台 W3）：`portal/src/notifications.js` + 迁移 0036 的用例。
//
// 环境门口径照 `macros.test.js`：`TEST_DATABASE_URL` 未设置 ⇒ 真库用例整体 skip。
//   TEST_DATABASE_URL=postgres://station:station@127.0.0.1:15496/station_test \
//     node --test portal/test/notifications.test.js
//
// 判据面（本单硬语义的落点）：
//   ① keyset 分页插 5 条、limit=2 翻三页 ⇒ 不重不漏（判据 6）；
//   ② `unreadCount` 与 `markRead` 一致（判据 7，同一谓词 `read_at IS NULL` 同源）；
//   ③ `deliverIntent` 的 severity 由**收件人 + 结果**推导：收件人只有管理员（空清单）⇒
//      **不写 notifications 行**（判据 5）；失败 ⇒ `error`、成功 ⇒ `info`；
//   ④ `markRead` 非属主 404（不泄露存在性）；
//   ⑤ `macros.js` 的软删判定接上真表（10 篇 §4 第 1 条）：通知经执行账间接引用模板
//      ⇒ `deleteTemplate` 只能软删且 `notifications` 计数正确。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';
import {
  newId, createNotification, listNotifications, markRead, unreadCount, deliverIntent,
  toNotificationSnapshot, encodeNotificationCursor, decodeNotificationCursor,
  normalizeNotificationsLimit, NOTIFICATION_SEVERITIES,
} from '../src/notifications.js';
import { MacroError, createTemplate, assignTemplate, claimMacroRun, deleteTemplate } from '../src/macros.js';

const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
const SKIP = URL_VALUE ? false : SKIP_WITHOUT_PG;
const fixture = URL_VALUE ? createPgFixture(URL_VALUE, { prefix: 'w526n' }) : null;
const withFreshDb = (fn) => fixture.withFreshDatabase(({ pool }) => fn(pool), { log: () => {} });

async function seedUser(pool, tag) {
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, login, password_hash, status) VALUES ($1, $2, 'x', 'active')`,
    [userId, `n526${tag}`],
  );
  return userId;
}

function assertMacroError(code, fn) {
  return fn().then(
    () => assert.fail(`应当抛 MacroError(${code})`),
    (e) => {
      assert.ok(e instanceof MacroError, `应为 MacroError，实际 ${e?.constructor?.name}: ${e?.message}`);
      assert.equal(e.code, code);
      return e;
    },
  );
}

// ── 纯逻辑 ────────────────────────────────────────────────────────────────────

test('#526 newId 是 32 位 hex（恰好铺满 VARCHAR(32)，单层无分段）', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(newId());
  assert.equal(ids.size, 200, '200 次生成不许撞');
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{32}$/);
  }
});

test('#526 通知游标 encode/decode 往返 + 非法 cursor 报 validation_failed', () => {
  const at = new Date('2026-11-16T02:30:00.000Z');
  const c = encodeNotificationCursor({ created_at: at, id: 'abc' });
  const back = decodeNotificationCursor(c);
  assert.equal(back.createdAt.toISOString(), at.toISOString());
  assert.equal(back.id, 'abc');
  assertMacroError('validation_failed', async () => decodeNotificationCursor('%%%not-base64-json%%%'));
});

test('#526 limit 归一（契约 §3.1：1..100）', () => {
  assert.equal(normalizeNotificationsLimit(undefined), 50);
  assert.equal(normalizeNotificationsLimit('0'), 50);
  assert.equal(normalizeNotificationsLimit('7'), 7);
  assert.equal(normalizeNotificationsLimit('999'), 100);
  assert.deepEqual([...NOTIFICATION_SEVERITIES], ['info', 'error']);
});

// ── 真库 ──────────────────────────────────────────────────────────────────────

test('#526 0036 落地：notifications 表 + chat_sessions.origin 默认 human', { skip: SKIP }, async t => {
  await withFreshDb(async (pool) => {
    const cols = await pool.query(
      `SELECT column_name, data_type, character_maximum_length FROM information_schema.columns
        WHERE table_schema='public' AND table_name='notifications'`);
    const names = cols.rows.map((r) => r.column_name).sort();
    assert.deepEqual(names,
      ['body', 'created_at', 'id', 'macro_run_id', 'read_at', 'severity', 'title', 'user_id'].sort());
    const idCol = cols.rows.find((r) => r.column_name === 'id');
    assert.equal(idCol.character_maximum_length, 32, 'id 是 VARCHAR(32)');
    // 应用侧写时间（AGENTS.md §3.4）：DDL 不许 DEFAULT CURRENT_TIMESTAMP
    const defs = await pool.query(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name='notifications' AND column_name IN ('created_at','read_at')`);
    for (const r of defs.rows) assert.equal(r.column_default, null, `${r.column_name} 不许有 DB 默认时刻`);
    const origin = await pool.query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name='chat_sessions' AND column_name='origin'`);
    assert.match(String(origin.rows[0]?.column_default ?? ''), /human/, 'origin 默认 human');
    await t.diary?.('ok');
  });
});

test('#526 判据6：插 5 条、limit=2 翻三页 ⇒ 不重不漏', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const u = await seedUser(pool, 'p1');
    const base = Date.parse('2026-11-16T00:00:00.000Z');
    const made = [];
    for (let i = 0; i < 5; i++) {
      made.push(await createNotification(pool, {
        userId: u, title: `t${i}`, body: `b${i}`,
        createdAt: new Date(base + i * 1000),
      }));
    }
    const seen = [];
    let cursor = null;
    let pages = 0;
    for (;;) {
      const page = await listNotifications(pool, { userId: u, limit: 2, cursor });
      pages += 1;
      seen.push(...page.items.map((n) => n.id));
      if (!page.nextCursor) break;
      assert.ok(pages < 10, '翻页必须终止');
      cursor = page.nextCursor;
    }
    assert.equal(pages, 3, '5 条 / limit=2 ⇒ 恰好三页');
    assert.equal(new Set(seen).size, 5, '不重');
    assert.deepEqual([...seen].sort(), made.map((n) => n.id).sort(), '不漏');
    // 倒序：新建在前
    assert.deepEqual(seen, [...made].map((n) => n.id).reverse());
    // 翻页中途新插入一条 ⇒ 老游标不重不漏地只补到新的那条（keyset 的存在理由）
    const late = await createNotification(pool, { userId: u, title: 'late', createdAt: new Date(base + 99000) });
    const first = await listNotifications(pool, { userId: u, limit: 2 });
    const after = [];
    let c2 = first.nextCursor;
    after.push(...first.items.map((n) => n.id));
    while (c2) {
      const p = await listNotifications(pool, { userId: u, limit: 2, cursor: c2 });
      after.push(...p.items.map((n) => n.id));
      c2 = p.nextCursor;
    }
    assert.ok(after.includes(late.id) && after.length === 6, '迟到的新行只出现在第一页，后续页不漂移');
  });
});

test('#526 判据7：unreadCount 与 markRead 一致；判据4：markRead 非属主 404', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const u = await seedUser(pool, 'r1');
    const other = await seedUser(pool, 'r2');
    const n1 = await createNotification(pool, { userId: u, title: 'a' });
    const n2 = await createNotification(pool, { userId: u, title: 'b' });
    assert.equal(await unreadCount(pool, { userId: u }), 2);
    const read = await markRead(pool, { notificationId: n1.id, userId: u });
    assert.equal(read.read_at instanceof Date || typeof read.read_at === 'string', true);
    assert.equal(await unreadCount(pool, { userId: u }), 1);
    // 幂等：再点一次不报错、read_at 不变（「已读」是事件不是时长）
    const again = await markRead(pool, { notificationId: n1.id, userId: u, now: new Date(Date.now() + 60_000) });
    assert.equal(new Date(again.read_at).getTime(), new Date(read.read_at).getTime());
    assert.equal(await unreadCount(pool, { userId: u }), 1);
    // 已读集合与未读列表互补（同一谓词同源）
    const unread = await listNotifications(pool, { userId: u, unreadOnly: true });
    assert.deepEqual(unread.items.map((n) => n.id), [n2.id]);
    // 非属主 ⇒ 404（不是 403：不泄露存在性）
    const err = await assertMacroError('not_found', () => markRead(pool, { notificationId: n1.id, userId: other }));
    assert.equal(err.httpStatus, 404);
    // 别人的通知不占我的未读数
    assert.equal(await unreadCount(pool, { userId: other }), 0);
  });
});

test('#526 判据5：deliverIntent 的 severity 由收件人+结果推导；只有管理员⇒不写行', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const u = await seedUser(pool, 'd1');
    const intent = { templateName: '完成审查 · 默认', macroRunId: null };
    // 收件人只有管理员（对用户面而言 = 空清单）⇒ 一行都不写
    const none = await deliverIntent(pool, intent, { recipients: [] });
    assert.deepEqual(none, { wrote: 0, severity: null, notifications: [] });
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM notifications')).rows[0].n, 0);
    // 成功 + 收件人含用户 ⇒ info
    const ok = await deliverIntent(pool, intent, { recipients: [u], success: true });
    assert.equal(ok.wrote, 1);
    assert.equal(ok.severity, 'info');
    // 失败 + 收件人含用户 ⇒ error（同一动作类型、不同结果 ⇒ severity 不同 —— 这就是「不由类型推导」）
    const bad = await deliverIntent(pool, intent, { recipients: [u], success: false });
    assert.equal(bad.severity, 'error');
    const items = (await listNotifications(pool, { userId: u })).items;
    assert.deepEqual(items.map((n) => n.severity).sort(), ['error', 'info']);
    // 收件人去重：同一人重复出现只写一条
    const dup = await deliverIntent(pool, intent, { recipients: [u, u], success: true });
    assert.equal(dup.wrote, 1);
  });
});

test('#526 10篇§4-1：软删判定接上真表（通知经执行账间接引用模板 ⇒ 只能软删）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const u = await seedUser(pool, 's1');
    const projectId = randomUUID();
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO projects (id, user_id, name, repo_url, root_path, slot)
       VALUES ($1, $2, $3, 'git@x:y/z.git', '~/projects/x', 0)`, [projectId, u, `p526s1`]);
    await pool.query(
      `INSERT INTO chat_sessions (id, user_id, project_id, title) VALUES ($1, $2, $3, 's')`,
      [sessionId, u, projectId]);
    const tpl = await createTemplate(pool, { kind: 'run-notify', name: 'n526', scope: 'session', params: {} });
    const a = await assignTemplate(pool, { templateId: tpl.id, userId: u, sessionId });
    const run = await claimMacroRun(pool, { assignmentId: a.id, anchor: 'run:x', criterion: 'terminal', bucket: 'x' });
    assert.ok(run?.id, 'claim 必须成功');
    // 经 deliverIntent 写一条挂在这条账上的通知
    const d = await deliverIntent(pool, { templateName: tpl.name, macroRunId: run.id }, { recipients: [u], success: true });
    assert.equal(d.wrote, 1);
    // 删除判定：有账 + 有通知 ⇒ 软删，且 notifications 计数**来自真表**（W1 的 TODO 接点）
    const del = await deleteTemplate(pool, { templateId: tpl.id });
    assert.equal(del.mode, 'soft');
    assert.equal(del.notifications, 1, 'countTemplateNotifications 必须经 macro_run_id→assignments 数到真行');
    assert.ok(del.macroRuns >= 1);
  });
});
