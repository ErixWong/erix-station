// issue #693：per-run 旋钮（`max_rounds` / `review_only`）从 ticket 到 childEnv 的**整条链路**。
//
// 为什么必须有这个文件（事故现场）：
//   #627 ③ 与 #662 的用例都是**直接调 `buildWorkerEnv(fakeRunStart)`**，桩喂给它一个理想对象
//   （含 `max_rounds` / `review_only`）⇒ 函数本身通过。但 `agentd.js` 里组装 `runStart` 的那个
//   **字面量白名单**根本没把这两个字段放进去 ⇒ 真机上 `runStart.max_rounds` 永远是 `undefined`
//   ⇒ 两个旋钮从未生效，而且完全静默（审查 run 照样能 `shell`）。
//
//   ⇒ 判据必须落在**组装点**，不是被测函数本身。这里用两道：
//     ① 「ticket 形状 → childEnv」走 `perRunKnobs` + `buildWorkerEnv` 两个真函数；
//     ② 源码级守卫：断言 `runStart` 字面量**真的展开了 `perRunKnobs(run)`**。
//        ②是唯一能挡住「有人把那一行删了」的东西——而那一行正是当初缺失的东西。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ERIX_STATION_TOKEN = 'test-token';
process.env.FDE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-agentd-perrun-'));
const agentd = await import('../agentd.js');
const { perRunKnobs, buildWorkerEnv } = agentd;

test.after(() => {
  fs.rmSync(process.env.FDE_HOME, { recursive: true, force: true });
});

test('#693-1 ticket 带 max_rounds + review_only ⇒ childEnv 两个都到位（整条，不是被测函数单独）', () => {
  // 形状照 claim ticket 的 `run`（portal/src/internal.js:369）。
  const ticketRun = { id: 'r1', max_rounds: 8, review_only: true };
  const runStart = { run_id: 'r1', cwd: '/tmp/x', ...perRunKnobs(ticketRun) };
  const env = buildWorkerEnv(runStart, {});
  assert.equal(env.ERIX_MAX_ROUNDS, '8', 'per-run 轮数必须下行到 worker（#627 ③）');
  assert.equal(env.RUN_REVIEW_ONLY, '1', '只读审查标志必须下行到 worker（#662）');
});

test('#693-2 没给就不设：max_rounds=null / review_only 缺失 ⇒ childEnv 两个都不出现', () => {
  const runStart = { run_id: 'r1', cwd: '/tmp/x', ...perRunKnobs({ id: 'r1', max_rounds: null }) };
  const env = buildWorkerEnv(runStart, {});
  assert.equal('ERIX_MAX_ROUNDS' in env, false, 'null = 没给 ⇒ 不设，回落容器默认（别写成 0/NaN）');
  assert.equal('RUN_REVIEW_ONLY' in env, false, '没声明 ⇒ 不设（区分「没声明」与「声明关」）');
});

test('#693-3 review_only 严格布尔：只有 true 才带（false 视为「声明关」，同样不设 env）', () => {
  for (const v of [false, 'true', 1, '1', null, undefined]) {
    const knobs = perRunKnobs({ review_only: v });
    assert.equal('review_only' in knobs, false, `review_only=${JSON.stringify(v)} 不该带（严格 === true）`);
  }
  assert.deepEqual(perRunKnobs({ review_only: true }), { review_only: true });
});

test('#693-4 max_rounds 用 != null：0 会被带下去（由 worker 的 parseMaxRounds 兜非法值）', () => {
  assert.deepEqual(perRunKnobs({ max_rounds: 0 }), { max_rounds: 0 },
    '0 是「给了个非法值」，不是「没给」——别在这里静默吞掉，交给 worker 判');
  assert.deepEqual(perRunKnobs({ max_rounds: null }), {});
  assert.deepEqual(perRunKnobs({ max_rounds: undefined }), {});
});

// —— ② 源码级守卫：组装点必须真的展开 perRunKnobs ——
//
// 这一条看着土，但它挡的正是当初的 bug：字段不在字面量里。用例 ① 拿不到那个字面量
// （它在一个巨型函数内部），所以只能从源码断言「那一行还在」。
test('#693-5 组装点守卫：runStart 字面量里必须展开 perRunKnobs(run)', () => {
  const src = fs.readFileSync(new URL('../agentd.js', import.meta.url), 'utf8');
  const at = src.indexOf('const runStart = {');
  assert.ok(at > 0, '前提：找得到 runStart 字面量');
  const literal = src.slice(at, src.indexOf('\n  };', at));
  assert.match(literal, /\.\.\.perRunKnobs\(run\)/,
    'runStart 是白名单字面量 —— 漏了 `...perRunKnobs(run)` 就等于 per-run 旋钮全废（#627/#662 的真机事故）');
  // 也不许「自己再抄一遍」两个字段（那样 perRunKnobs 的用例就白测了）。
  assert.equal(/max_rounds:/.test(literal), false, '不许在字面量里手抄 max_rounds（唯一来源是 perRunKnobs）');
  assert.equal(/review_only:/.test(literal), false, '不许在字面量里手抄 review_only');
});
