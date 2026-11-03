// issue #442（erix-agent 0.29.0 → 0.30.0）M4：`finalTextFallback` 的透传判据。
//
// 上游事实（`erix-agent` 0.30.0，`src/loop/termination.js`）：
//   · `:675` `finalText: forcedFinalFallbackApplies() ? FORCED_FINAL_FALLBACK_TEXT : ctx.finalText`；
//   · `:832` 常量本体；`:700` 附近 `...(forcedFinalFallbackApplies() ? { finalTextFallback: true } : {})`；
//   · 判据 `forcedFinalFallbackApplies()` = `ctx.forcedFinal === true && ctx.finalText.trim() === ""`
//     ——**两个条件缺一不可**，且只在 `makeResult` 里判一次（收尾那一发之后正文还可能被改写）。
//   · 那条兜底文案**只落在 `result.finalText` 这一面**：账本/messages 里那条 assistant 仍是模型真产出的
//     那一条（空就是空）——引擎自己的注释写得明明白白（`:820` 一带的硬约束 ②）。
//
// 本站要证三件事（工单 §M4）：
//   ① `runner/lib/termination.js#finalTextFallbackField`：**只在 `=== true` 时给键**（缺席 = 不是兜底，
//      绝不写 false —— 否则「旧 worker 没这个字段」与「明确不是兜底」在 DTO 上分不开）；
//   ② `worker.js` 成功路径真的把它展开进 IPC 信封（源码级接线判据，删掉那行就红）；
//   ③ `agentd.js` 逐字透传到 U2（真跑 `onWorkerFinished`，用 stub fetch 抓 U2 的 body）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { finalTextFallbackField } from '../lib/termination.js';

process.env.ERIX_STATION_TOKEN = 'test-token';
const agentd = await import('../agentd.js');

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(RUNNER_DIR, rel), 'utf8');

test('F1 finalTextFallbackField：只在 `=== true` 时给键；缺席/false/脏值一个键都不给', () => {
  assert.deepEqual(finalTextFallbackField({ finalTextFallback: true }), { final_text_fallback: true });
  // **缺席 = 不是兜底**（引擎从不写 false；写了 false 也不该被我们当兜底）
  assert.deepEqual(finalTextFallbackField({ finalText: '正文' }), {});
  assert.deepEqual(finalTextFallbackField({ finalTextFallback: false }), {});
  // 脏值一律不算兜底（additive 字段面的老规矩：#261 的 typeof 守卫）
  for (const dirty of [1, 'true', {}, [], null, undefined, 0]) {
    assert.deepEqual(finalTextFallbackField({ finalTextFallback: dirty }), {},
      `finalTextFallback=${JSON.stringify(dirty)} 不该被当成兜底`);
  }
  assert.deepEqual(finalTextFallbackField(null), {});
  assert.deepEqual(finalTextFallbackField(undefined), {});
});

test('F2 worker.js 成功路径真的展开它（删掉那一行 ⇒ 兜底标记永远到不了 U2）', () => {
  const src = read('worker.js');
  const at = src.indexOf('final_text: result.finalText ??');
  assert.ok(at > 0, 'worker.js 的成功路径信封结构变了（找不到 final_text 那一行），本判据的正则需要重看');
  const around = src.slice(at, at + 700);
  assert.match(around, /\.\.\.finalTextFallbackField\(result\)/,
    'worker 的成功路径没有展开 finalTextFallbackField(result) ⇒ 引擎的 finalTextFallback 被丢在容器里');
  // 红线：不许写成恒给 `false`（那是三态冒充两态）
  assert.doesNotMatch(around, /final_text_fallback:\s*(false|result\.finalTextFallback)/,
    '不许无条件写 final_text_fallback（缺席 = 不是兜底；写 false 会让两种「不是兜底」分不开）');
});

/** agentd 的 `onWorkerFinished` 走 U2（PUT /state），用 stub fetch 抓住真实 body。 */
function stubFetch() {
  const bodies = [];
  return {
    bodies,
    impl: async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      if (method === 'PUT' && String(url).endsWith('/state')) {
        bodies.push(typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body);
        return { ok: true, status: 200, text: async () => JSON.stringify({ state: 'finished', run_end_seq: 1 }) };
      }
      if (method === 'PUT' && String(url).endsWith('/artifact')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ artifact_id: 'a1', size: 1 }) };
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    },
  };
}

function makeCtx(projectDir) {
  return {
    runId: '11111111-2222-3333-4444-555555555555',
    claimToken: 'ct-test',
    attempt: 1,
    resume: false,
    worker: null,
    workerPid: null,
    exited: null,
    events: [],
    eventBytes: 0,
    flushTimer: null,
    inflight: false,
    finishing: false,
    dropped: false,
    dropReason: null,
    lastIpcAt: Date.now(),
    projectDir,
  };
}

async function finishedBody(msg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-fallback-'));
  const { bodies, impl } = stubFetch();
  const saved = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await agentd.onWorkerFinished(makeCtx(root), {
      ok: true, termination: { reason: 'end_turn' },
      usage: { input_tokens: 1, output_tokens: 2 }, rounds: 1, final_text: '正文', ...msg,
    });
  } finally {
    globalThis.fetch = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(bodies.length, 1, 'U2 终态应当上报恰好一次');
  return bodies[0];
}

test('F3 agentd 逐字透传：worker 带了 `final_text_fallback: true` ⇒ U2 body 里有；不带 ⇒ 一个字节都不多', async () => {
  const withFlag = await finishedBody({ final_text_fallback: true });
  assert.equal(withFlag.final_text_fallback, true, 'agentd 把兜底标记吞了 ⇒ 界面永远不知道这是兜底文案');
  // 反向：不带这个键 ⇒ body 里**没有这个键**（不是 false、不是 null）
  const without = await finishedBody({});
  assert.equal(Object.hasOwn(without, 'final_text_fallback'), false,
    '没兜底时 U2 body 里多出了 final_text_fallback 键（缺席才是「不是兜底」）');
  // 脏值不许被透传成 true（agentd 只认 `=== true`）
  for (const dirty of [1, 'true', {}, []]) {
    const body = await finishedBody({ final_text_fallback: dirty });
    assert.equal(Object.hasOwn(body, 'final_text_fallback'), false,
      `final_text_fallback=${JSON.stringify(dirty)} 不该被 agentd 当成 true 透传`);
  }
});
