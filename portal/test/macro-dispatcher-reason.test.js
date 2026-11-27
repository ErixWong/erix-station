// A2/#850：宏分派失败的 `reason` 落库口径单测（**不碰真实 DB**：注入 fake pool，始终执行）。
//
// 钉两件事：
//   1. templateKind 未知这条 ⇒ finishMacroRun 收到的 `reason` **逐字** = `dispatch_failed:unknown_template_kind`
//      （稳定机器码，不是中文成品句 ⇒ 宏 run 视图能按语言渲染）。
//   2. 其它异常（无机器码）⇒ 仍是 `dispatch_failed: <原 message>` 原样保留（运维要的调试信息）。
//   3. log.warn 那行**仍含中文原句**（`未知 templateKind：...`）⇒ 运维照旧看得到人话。
//
// 断言用逐字等值 + includes（本文件是自写的行为钉，不受 internal-locale.test.js 的「一律 assert.equal」约束）。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createIntentDispatcher } from '../src/macro-dispatcher.js';

/** 只记 UPDATE macro_runs 的参数；把 SET 子句里的 `reason = $N` 反解成实际入参。 */
class RecordingPool {
  constructor() { this.reasons = []; }
  async query(sql, params = []) {
    const m = /\breason\s*=\s*\$(\d+)/i.exec(sql);
    if (m) this.reasons.push(params[Number(m[1]) - 1]);
    return { rows: [{ id: params[0], status: 'failed' }] };
  }
}

function intent({ kind, macroRunId = crypto.randomUUID() }) {
  // 非到期意图（criterion≠tick）+ 未知 templateKind ⇒ dispatchOne 落到 default 抛错。
  return { macroRunId, templateKind: kind, criterion: 'date', bucket: '2026-11-16', userId: crypto.randomUUID() };
}

test('A2：未知 templateKind ⇒ reason 逐字是稳定机器码 dispatch_failed:unknown_template_kind，log.warn 仍是中文原句', async () => {
  const pool = new RecordingPool();
  const warns = [];
  const dispatcher = createIntentDispatcher({ pool, log: { warn: (m) => warns.push(String(m)), info() {} } });

  const out = await dispatcher.dispatch([intent({ kind: 'bogus-kind' })]);
  assert.equal(out.failed, 1);
  assert.equal(out.dispatched, 0);

  assert.equal(pool.reasons.length, 1, '应恰好写一次失败收尾');
  assert.equal(pool.reasons[0], 'dispatch_failed:unknown_template_kind'); // 逐字

  assert.equal(warns.length, 1, '应记一条分派异常日志');
  assert.ok(warns[0].includes('未知 templateKind：bogus-kind'), `log.warn 应含中文原句，实际：${warns[0]}`);
});

test('A2：其它异常（无机器码）⇒ reason 仍是 dispatch_failed: <原 message>，原样保留调试信息', async () => {
  const pool = new RecordingPool();
  const dispatcher = createIntentDispatcher({
    pool,
    log: { warn() {}, info() {} },
    // scheduled-task 走注入执行器，令其抛错：这条没有 dispatchReasonCode ⇒ 落回原 message。
    executeScheduledIntent: async () => { throw new Error('模型炸了'); },
  });

  const out = await dispatcher.dispatch([intent({ kind: 'scheduled-task' })]);
  assert.equal(out.failed, 1);

  assert.equal(pool.reasons.length, 1);
  assert.equal(pool.reasons[0], 'dispatch_failed: 模型炸了'); // 逐字：保留空格 + 原中文 message
});
