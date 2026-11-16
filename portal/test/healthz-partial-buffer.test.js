// issue #515（工单 fix-261115-11）：**缓冲逐出活跃 run 从「静默」变成「对外读数 + 文档显式接受」**。
//
// 为什么单开一个文件：本单的东西横跨两层 —— 缓冲自己（`run-partial-buffer.js` 的 LRU 逐出）与
// 对外可观测面（`http.js` 的 `/healthz`），而两侧各自的既有测试文件都只 Own 自己那一层
// （`run-partial-buffer.test.js` 管缓冲语义，`http.test.js` 管 HTTP 契约）。把「逐出 ⇒ 对外读数」
// 这条跨层链塞进任一边，都会在另一边留下没人钉的接缝。这里钉的就是那条接缝。
//
// 裁决口径（#515 的三选一，主 agent 裁决 = ② 轻量版 + ③ 同做）：
//   ② **已有**的 `stats()` 挂到既有 `/healthz`（不新增端点、不新增鉴权面、不新增宿主诊断事件、
//      不动 SSE 白名单与前端）。⚠ 刻意**不**借用 `persistence_capability_degraded` 那个事件名：
//      它是**引擎发射**的类型（`orchestrator.js`），portal 借它说自己的事 = 谎报发射方。
//   ③ 文档显式接受（`docs/api/portal.md` §5.1 的已接受损失条目 + `docs/design/deploy-contract.md` §2.3）。
//   ①（把容量与 portal 级 active-run 硬上限绑定）**本单不做**：portal 今天没有那种硬上限。
//
// ⚠ 本文件有一条用例**钉的是「今天的真实行为」，不是「我们想要的行为」**（`尾巴冒充整段` 那条）：
//   逐出后该 run 继续吐字 ⇒ 终态写出的是一段从中间起笔的**尾巴**、且轮号掉到 0、`roundSeq` 掉到
//   `null`。那是独立的正确性问题（主 agent 另开单跟），**本单不修**，所以这里不许把它改成期望值。
//
// 隔离（docs/testing.md §2.1）：注入内存 fake pool，不碰真实 DB；进程内单例 `partialOutputs`
// 每条用例前后都 `clear()`（node --test 每文件一进程，但同文件内多条用例共用那一份单例）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer, checkReady, partialBufferHealth } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as migrate from '../src/migrate.js';
import {
  createPartialBuffer, partialOutputs, PARTIAL_MAX_ENTRIES_DEFAULT,
} from '../src/run-partial-buffer.js';
import { runEndPartialKeys } from '../src/internal.js';
import { FakePool } from './fake-pool.js';

const ev = (type, payload = {}, extra = {}) => ({ type, payload, session_id: 's-515', ...extra });

/** 把 `deploy/migrations` 的全部版本号当成「已应用」⇒ `/healthz` 走 200 分支（真判据，不 stub 布尔）。 */
class ReadyPool extends FakePool {
  constructor({ migrationsDir = migrate.defaultMigrationsDir(), ready = true } = {}) {
    super();
    this.versions = ready ? migrate.computeExpectedVersions(migrationsDir) : [];
  }

  async query(sql, params = []) {
    if (String(sql).includes('FROM schema_migrations')) {
      return { rows: this.versions.map((version) => ({ version })) };
    }
    return super.query(sql, params);
  }
}

async function startServer(pool = new ReadyPool()) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-515-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800, sessionRenewIntervalSeconds: 3600, pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 5, maxEntries: 100 },
    kdfConcurrency: 2, kdfQueueLimit: 10, kdfQueueTimeoutMs: 5000,
    maxBodyBytes: 64 * 1024, maxLoginLength: 128, maxPasswordLength: 256, staticDir,
  };
  const server = createServer({ pool, config });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      await new Promise((res) => server.close(res));
      fs.rmSync(staticDir, { recursive: true, force: true });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 判据 b：`/healthz` 那个块能读到逐出增量（跨层的那条链）
// ─────────────────────────────────────────────────────────────────────────────
test('#515②：逐出一个活跃 run ⇒ `/healthz` 的 `partialBuffer.evictedActive` 能读到这次逐出（对外可见，不再只有日志）', async () => {
  partialOutputs.clear();
  const s = await startServer();
  try {
    const before = await (await fetch(`${s.base}/healthz`)).json();
    assert.deepEqual(Object.keys(before.partialBuffer).sort(), ['entries', 'evictedActive', 'maxEntries'],
      '空闲时的形状（三个整数；不断绝对值 ⇒ 同文件里多条用例共用单例、逐出计数会累加）');

    // 灌到超上限：默认 32 槽 ⇒ 第 33 个活跃 run 挤掉最早那一个（全程无终态条目可逐）
    for (let i = 1; i <= 33; i += 1) {
      partialOutputs.observe(`r-${i}`, ev('assistant_delta', { text: `x${i}` }));
    }
    const after = await (await fetch(`${s.base}/healthz`)).json();
    assert.equal(after.partialBuffer.evictedActive, before.partialBuffer.evictedActive + 1,
      '判据是严格 +1（不是「大于 0」这种钝断言）：逐出活跃 run 的次数必须从端点读到'
      + '（此前只有 `log.warn`，对外零读数 = 静默）');
    assert.equal(after.partialBuffer.entries, 32, '槽位被占满 = 上界是硬的');
    assert.equal(after.status, 'ok', '`status` 的语义一字未动（就绪判据还是它）');
  } finally {
    partialOutputs.clear();
    await s.close();
  }
});

test('#515②：`/api/health` 是同一条 handler ⇒ 同一份读数（两个路径不许长成两个样子）', async () => {
  partialOutputs.clear();
  const s = await startServer();
  try {
    partialOutputs.observe('r-a', ev('assistant_delta', { text: 'a' }));
    const a = await (await fetch(`${s.base}/healthz`)).json();
    const b = await (await fetch(`${s.base}/api/health`)).json();
    assert.deepEqual(a, b);
    assert.deepEqual(Object.keys(a.partialBuffer).sort(), ['entries', 'evictedActive', 'maxEntries']);
    assert.equal(a.partialBuffer.entries, 1, '刚观测一条 ⇒ 占一个槽（读的是真单例，不是常数）');
    assert.equal(a.partialBuffer.maxEntries, 32);
  } finally {
    partialOutputs.clear();
    await s.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 形状红线：只多一块、且观测面不得把 readiness 端点打挂
// ─────────────────────────────────────────────────────────────────────────────
test('#515②：块里只有三个整数（无 run id / 无 sessionId / 无正文片段）——响应会被人贴进日志', () => {
  const b = createPartialBuffer({ maxEntries: 2 });
  b.observe('run-with-a-long-uuid-like-id', ev('assistant_delta', { text: '正文片段不许进健康端点' }));
  const block = partialBufferHealth(b);
  assert.deepEqual(Object.keys(block).sort(), ['entries', 'evictedActive', 'maxEntries']);
  assert.ok(Object.values(block).every((v) => Number.isInteger(v)), `必须全是整数：${JSON.stringify(block)}`);
  assert.equal(block.entries, 1);
  assert.equal(block.maxEntries, 2, '上界取自缓冲自己（`maxEntries`），不另算第二把尺');
  const json = JSON.stringify(block);
  assert.ok(!json.includes('run-with-a-long-uuid-like-id'), 'run id 不许出现在块里');
  assert.ok(!json.includes('正文片段'), '正文内容不许出现在块里（那是用户数据）');
});

test('#515②：观测面不承重——`stats()` 抛异常 ⇒ 省略该键，`/healthz` 仍 200 且 `status: ok`', async () => {
  const s = await startServer();
  try {
    // 直接打 helper：抛异常 ⇒ null（调用方据此省略键）
    const boom = { stats: () => { throw new Error('buffer 坏了'); } };
    assert.equal(partialBufferHealth(boom), null);
    assert.equal(partialBufferHealth({}), null, '拿不到 stats ⇒ null，不猜默认值');
    // 端到端那条（真单例坏不掉）：证明「省略键」这条分支在 handler 里也走得通
    const ok = await fetch(`${s.base}/healthz`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).status, 'ok');
  } finally {
    await s.close();
  }
});

test('#515②：既有语义不许被我改动 —— 503 形状逐字不变、非 GET 仍 405、未就绪时不带新块', async () => {
  const s = await startServer(new ReadyPool({ ready: false }));
  try {
    const notReady = await fetch(`${s.base}/healthz`);
    assert.equal(notReady.status, 503);
    assert.deepEqual(await notReady.json(),
      { error: { code: 'migration_failed', message: 'not ready', retryable: false } },
      '503 的 body 逐字不变（本单只动 200 分支；容器健康检查判的是状态码，形状变了也算我改坏了）');
    const post = await fetch(`${s.base}/healthz`, { method: 'POST' });
    assert.equal(post.status, 405, '非 GET 的 405 口径不变（不新增错误码）');
  } finally {
    await s.close();
  }
});

test('#515②：`checkReady` 本身没被我碰（判据仍是「迁移全到 head」，与本块无关）', async () => {
  assert.equal(await checkReady(new ReadyPool({ ready: true })), true);
  assert.equal(await checkReady(new ReadyPool({ ready: false })), false,
    '一把尺：期望迁移缺一个 ⇒ false（本单只加读数，没改就绪判据）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 判据 c：反向自证核心 —— 上界没被顺手改掉
// ─────────────────────────────────────────────────────────────────────────────
test('#515：`maxEntries` 缺省仍是 32（本单是加读数，不是调容量 ⇒ 改前改后逐字相同）', async () => {
  assert.equal(PARTIAL_MAX_ENTRIES_DEFAULT, 32,
    '常量本身（`PARTIAL_MAX_ENTRIES_DEFAULT`）：本单没动容量，动它要另开单并算内存账（32 × 64 KB ≈ 2 MB）');
  assert.equal(createPartialBuffer().stats().maxEntries, 32, '不传参时的生效值');
  const src = fs.readFileSync(new URL('../src/run-partial-buffer.js', import.meta.url), 'utf8');
  assert.match(src, /export const PARTIAL_MAX_ENTRIES_DEFAULT = 32;/,
    '连**字面量写法**一起钉：改成 env 注入 / 改成别的数字，这条都会红 ⇒ 逼改动者回来写理由');
  partialOutputs.clear();
  const s = await startServer();
  try {
    const body = await (await fetch(`${s.base}/healthz`)).json();
    assert.equal(body.partialBuffer.maxEntries, 32, '对外读数与常量同源（不是第二把尺）');
  } finally {
    partialOutputs.clear();
    await s.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 判据 a + 那条「钉今天行为」的复现（主 agent 追加要求）
// ─────────────────────────────────────────────────────────────────────────────
test('#515a：默认上界下逐出一个活跃 run ⇒ `evictedActive` 严格 +1，且优先逐活跃之前先榨干终态条目', () => {
  const warns = [];
  const b = createPartialBuffer({ log: { warn: (m) => warns.push(m) } });
  // 31 个活跃 + 1 个终态 = 正好填满 32 槽：下一条进来时先逐**终态**那条 ⇒ 一条活跃都没被逐
  //（为什么是 31 不是 32：灌第 32 条活跃时表还没满 ⇒ 不逐；灌**终态**那条时才触发逐出，
  //  而那时表里全是活跃的 ⇒ 会先咬掉一条活跃的，把想钉的反例搞混。）
  for (let i = 1; i <= 31; i += 1) b.observe(`a-${i}`, ev('assistant_delta', { text: '还在流' }));
  b.observe('t-1', ev('assistant_delta', { text: '已终态' }));
  b.markTerminal('t-1');
  assert.equal(b.stats().evictedActive, 0);
  b.observe('new-1', ev('assistant_delta', { text: 'N' }));
  assert.equal(b.snapshot('t-1'), null, '终态条目优先让位');
  assert.equal(b.stats().evictedActive, 0, '榨得动终态条目 ⇒ 不许逐活跃的');
  assert.deepEqual(warns, [], '没逐活跃 ⇒ 不该出声');

  // 全表都是活跃 run ⇒ 只能逐活跃的，计数严格 +1
  const before = b.stats().evictedActive;
  b.observe('new-2', ev('assistant_delta', { text: 'N2' }));
  assert.equal(b.stats().evictedActive, before + 1, '判据是 +1，不是「变大了」');
  assert.equal(b.snapshot('a-1'), null, '逐的是最老那条活跃 run');
  assert.equal(warns.length, 1);
});

test('#515 复现（钉**今天的真实行为**，不是期望行为）：逐出后继续吐字 ⇒ 终态写出的是**从中间起笔的尾巴**，`roundSeq` 掉成 `null`、轮号掉到 0', () => {
  const b = createPartialBuffer({ log: { warn: () => {} } }); // **默认 32**，不用玩具上界
  // 33 个活跃 run 同时在流；每个都进了第 1 轮（`round_start` 带 seq）并吐了正文
  for (let i = 1; i <= 33; i += 1) {
    b.observe(`r-${i}`, ev('round_start', { round: 1 }, { seq: 100 + i }));
    b.observe(`r-${i}`, ev('assistant_delta', { text: `第${i}个run的前半段正文` }));
  }
  assert.equal(b.stats().evictedActive, 1, '第 33 个挤掉最老那条活跃的（`r-1`）');

  // 情形①（工单原文只覆盖这一种）：逐出后**不再吐字** ⇒ 空槽 ⇒ 终态**没有** `partial_text`
  assert.equal(b.snapshot('r-1'), null);
  assert.deepEqual(runEndPartialKeys('r-1', { hasAssistantAnchor: false, buffer: b }), {},
    '空槽 ⇒ 一个键都不加 ⇒ 界面走 §4.4a-1 判据 3 的占位项（「那段没了」+ 中性提示）');

  // 情形②（工单原文**漏掉**的那一种，也是更坑的一种）：逐出后**继续吐字** ⇒ 槽位重建
  b.observe('r-1', ev('assistant_delta', { text: '后半段' }));
  const snap = b.snapshot('r-1');
  assert.ok(snap, '槽位被后续碎片重建（不是永远没槽）');
  assert.equal(snap.text, '后半段',
    '**只剩尾巴**：逐出之前那段（「第1个run的前半段正文」）永久丢，尾巴却看起来像一段完整正文');
  assert.ok(!snap.text.includes('前半段'), '前半段确实回不来了（内存里没有它，也没有 DB 回落）');
  assert.equal(snap.round, null, '轮号也丢了（重建的是 blank entry）');
  assert.equal(snap.roundSeq, null,
    '⚠ `roundSeq` 掉成 `null` ⇒ 补发帧按 §4.4a「两端都匹配才覆盖气泡」的口径被**整帧丢弃**');
  assert.equal(snap.chunks, 1, '碎片计数从 0 重开（旧段 1 片 + 新段 1 片 ⇒ 对不上账）');
  assert.equal(snap.textSegment, 0,
    '代际号回落到 0 < 前端已记录的 ⇒ 按「过期一代」忽略 ⇒ 水位线不会倒退，但也补不回正文');

  // 终态写库的那一份：尾巴冒充整段，且轮号谎报成 0
  assert.deepEqual(runEndPartialKeys('r-1', { hasAssistantAnchor: false, buffer: b }), {
    partial_text: '后半段', partial_round: 0, partial_truncated: false,
  }, '有 `partial_text` ⇒ 历史投影**不会**出占位项，用户看到的是一段从中间起笔、没有任何标记的正文');

  // 对照：有 assistant 锚点时仍不写（这条口径没被本单动过）
  assert.deepEqual(runEndPartialKeys('r-1', { hasAssistantAnchor: true, buffer: b }), {},
    '有锚点 ⇒ 一份正文就够（#300 的重复正文红线，本单没碰）');
});
