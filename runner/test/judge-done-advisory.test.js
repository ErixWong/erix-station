// issue #333：erix-agent 0.22 的 `reflection.judgeDoneAdvisory`（决策：默认开）接线锁。
//
// 事实面（逐项核过发布物源码，不是照抄 changelog）：
// - **上游缺省 false**：`orchestrator.js:1308` `judgeDoneAdvisoryEnabled = effectiveReflection?.judgeDoneAdvisory === true`
//   ⇒ 不显式传就是关；传非布尔 ⇒ `TypeError`（`:1304-1306`）。
// - 生效路径是**中途拦截审计**（`run-snapshot-executor.js:420` `offerJudgeDoneAdvisory`），
//   不是 end_turn 那条 `judge_done` 停止分支（`orchestrator.js:3524-3533` 无论开关都停）。
//   拦截门：`judgeInterceptEnabled`（`reflection.judgeIntercept !== false` ⇒ 本站默认就是开）
//   且 `judgeInterceptCount >= judgeIntervalRound`（缺省 10 ⇒ 本测试传 1 让它第一轮就审）。
// - 注入形态：`role: "user"` + `meta: { source: "judge-control" }` 的一条 text 消息
//   （`orchestrator.js:2634-2646`），文案固定包一层「（附评审意见：…）」（`reflection.js:44-52`）。
//   ⚠ 它是 **user 角色**——所以读侧不按 `meta.source` 排掉的话，界面上会显示成「用户说了这句话」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runToolLoop } from 'erix-agent';
import { createShellTools } from '../lib/shell-tools.js';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'sess-advisory-1';
const REASON = '回归用例已补齐，交付物齐全';

/** 从 worker.js 源码抠出**真传给 runToolLoop 的** reflection 对象里的 `judgeDoneAdvisory` 值。
 *  不在测试里另抄字面量：删掉 worker.js 那行 ⇒ 取到 undefined ⇒ 引擎按缺省 false ⇒ 行为用例红。 */
function workerAdvisoryFlag() {
  const src = fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8');
  const sites = src.match(/\breflection\s*:\s*\{[^}]*\}/g) ?? [];
  assert.equal(sites.length, 1, `worker.js 只应有一处 reflection 传参，实际 ${sites.length} 处`);
  const hit = sites[0].match(/\bjudgeDoneAdvisory\s*:\s*(true|false)/);
  return hit ? hit[1] === 'true' : undefined;
}

function makeStore(records) {
  return {
    async appendRound(key, record) { (records[key] ??= []).push(record); },
    async load(key) { return [...(records[key] ?? [])]; },
    async saveRunSnapshot() {},
    async loadLatestRunSnapshot() { return undefined; },
    async saveRunState() {},
    async loadRunState() { return undefined; },
    async markRunState() {},
  };
}

/** 主模型：先要一次 shell 工具（触发拦截审计），随后 end_turn。
 *  评审判官走同一个桩：按它的 system 文案分流（`orchestrator.js` callRoundJudge 的固定 system）。 */
function stubProvider({ toolRounds = 2 }) {
  const calls = { main: 0, judge: 0 };
  let toolGiven = 0;
  return {
    calls,
    async chat(request) {
      const isJudge = typeof request?.system === 'string' && request.system.includes('交付评审者');
      if (isJudge) {
        calls.judge += 1;
        return {
          content: [{ type: 'text', text: JSON.stringify({ done: true, confidence: 0.95, reason: REASON, evidence: '测试全绿' }) }],
          stopReason: 'end_turn',
        };
      }
      calls.main += 1;
      if (toolGiven < toolRounds) {
        toolGiven += 1;
        return {
          content: [{ type: 'tool_use', id: `call-${toolGiven}`, name: 'shell', input: { command: 'true' } }],
          stopReason: 'tool_use',
        };
      }
      return { content: [{ type: 'text', text: 'final answer' }], stopReason: 'end_turn' };
    },
  };
}

async function runOnce({ advisory }) {
  const records = {};
  const provider = stubProvider({ toolRounds: 2 }); // 见下 judgeIntervalRound 注释：必须真的走 2 次工具
  const reflection = {
    enabled: true,
    roundJudge: true,
    // 缺省 10（前 10 次工具执行只计数不审计）。门槛是 `judgeInterceptCount >= judgeIntervalRound`
    // 且计数器**从 0 起、不审计那次才 +1** ⇒ 传 1 意味着「第 2 次工具执行才审计」：
    // 本测试因此必须真的走 **2 次**工具调用（只走 1 次 ⇒ 走的是 end_turn 那条 judge 支路，
    // 它直接 judge_done 停止、永不调 `offerJudgeDoneAdvisory` ⇒ advisory 恒为 0，是假绿形状）。
    judgeIntervalRound: 1,
    ...(advisory === undefined ? {} : { judgeDoneAdvisory: advisory }),
  };
  const result = await runToolLoop({
    provider,
    initialUserMessage: '干活',
    completion: false,
    tools: createShellTools({ worktreeRoot: RUNNER_DIR }).schemas,
    executeTool: async () => 'ok',
    maxRounds: 16, // judge 需要 maxRounds >= DEFAULT_REFLECTION_MIN_ROUNDS(16) 才启用
    reflection,
    store: makeStore(records),
    runId: KEY,
  });
  const injected = [];
  for (const record of Object.values(records).flat()) {
    for (const message of record?.messages ?? []) {
      if (message?.meta?.source === 'judge-control') injected.push(message);
    }
  }
  return { result, provider, injected, records };
}

test('#333 worker.js 显式打开 judgeDoneAdvisory（上游缺省是关，不写就是没开）', () => {
  assert.equal(workerAdvisoryFlag(), true,
    'runner/worker.js 必须传 reflection.judgeDoneAdvisory: true（2026-10-21 决策：默认开，且故意不给 env 旋钮）');
});

test('#333 打开后：评审「已达成」的意见真的作为 user 消息注入下文（role=user + meta.source=judge-control）', async () => {
  const { provider, injected } = await runOnce({ advisory: workerAdvisoryFlag() });

  assert.ok(provider.calls.judge >= 1, '前置条件：评审判官必须被调到（否则「没注入」是假绿）');
  assert.ok(provider.calls.main >= 3, '前置条件：必须真的走到「审计之后的下一轮」（advisory 只在下一轮批发出）');
  assert.equal(injected.length, 1, `应恰好注入一条控制消息，实际 ${injected.length}`);
  const [msg] = injected;
  assert.equal(msg.role, 'user', '注入的是 user 角色 ⇒ 读侧不按 meta.source 排掉就会伪装成用户原话');
  const text = msg.content?.[0]?.text ?? '';
  assert.match(text, /附评审意见/);
  assert.ok(text.includes(REASON), '评审理由要带进去（不然模型拿不到信息）');
});

test('#333 对照组：关掉 / 不传（= 上游缺省）都不注入，且三种配置的终态一致（advisory 不硬断 run）', async () => {
  const on = await runOnce({ advisory: true });
  const off = await runOnce({ advisory: false });
  const omitted = await runOnce({ advisory: undefined });

  assert.ok(off.provider.calls.judge >= 1 && omitted.provider.calls.judge >= 1, '对照组评审判官也真的跑了');
  assert.equal(off.injected.length, 0, '显式 false ⇒ 一条都不注入');
  assert.equal(omitted.injected.length, 0, '不传 ⇒ 上游缺省 false ⇒ 一条都不注入（这条就是「开关是承重的」）');
  assert.equal(on.injected.length, 1);
  // 软提示不是停止机制：三种配置的终局理由必须一致
  assert.equal(off.result.termination?.reason, on.result.termination?.reason);
  assert.equal(omitted.result.termination?.reason, on.result.termination?.reason);
});

test('#333 传非布尔会被引擎拒（所以我们只能写字面量，不能接 env 字符串）', async () => {
  await assert.rejects(
    runToolLoop({
      provider: stubProvider({ toolRounds: 2 }),
      initialUserMessage: 'x',
      completion: false,
      tools: createShellTools({ worktreeRoot: RUNNER_DIR }).schemas,
      executeTool: async () => 'ok',
      maxRounds: 16,
      reflection: { enabled: true, roundJudge: true, judgeDoneAdvisory: 'true' },
      store: makeStore({}),
      runId: KEY,
    }),
    (err) => err instanceof TypeError && /judgeDoneAdvisory must be a boolean/.test(err.message),
  );
});
