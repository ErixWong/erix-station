// agentd 冷启动竞态修复单测（issue #79）：首次心跳 gate 先于 claimLoop。
// 隔离约定：node:test + 注入 heartbeat/sleep/now/log 桩（initialHeartbeatGate 全 deps 可注入）；
// agentd 经 direct-run 守卫被 import（不启动主循环）。断言：
//   ①首 claim 发生在首心跳成功之后（models 下行写入 state.llmModels 才放行）；
//   ②心跳持续失败时按兜底超时放行，且带 warn「llmModels 未就绪」。
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ERIX_STATION_TOKEN = 'test-token';
const { initialHeartbeatGate, state } = await import('../agentd.js');

const MODELS = { models: { main: { model: 'deepseek-flash', type: 'text' } } };

/**
 * 造一套可注入 deps：虚拟时钟 vt（now/sleep 共享），heartbeatOnce 按队列吐结果
 * （Error → 抛，否则视为成功返回）；events 记录 hb/claim 顺序，warnings 捕获 warn 日志。
 * hbResults 用函数时每次调用取下一发（持续失败场景永不耗尽）。
 */
function makeDeps({ hbResults, maxWaitMs = 30000 }) {
  const events = [];
  const warnings = [];
  let vt = 0;
  let n = 0;
  const next = () => (typeof hbResults === 'function' ? hbResults() : hbResults[n++]);
  const deps = {
    maxWaitMs,
    now: () => vt,
    sleep: async (ms) => { vt += ms; },
    log: (level, msg, extra) => { warnings.push({ level, msg, extra }); },
    heartbeatOnce: async () => {
      const r = next();
      if (r instanceof Error) {
        events.push('hb-fail');
        throw r;
      }
      events.push('hb-ok');
      return r;
    },
  };
  return { deps, events, warnings, vt: () => vt };
}

test('首跳成功：gate 放行前 models 已下行写入 state.llmModels，claim 晚于首跳', async () => {
  state.llmModels = null;
  const { deps, events } = makeDeps({ hbResults: [MODELS] });
  await initialHeartbeatGate(deps);
  // claim 放行点 = gate 返回；在其后记录 claim，断言顺序即「首 claim 在首心跳成功后」。
  events.push('claim');
  assert.deepEqual(events, ['hb-ok', 'claim']);
  assert.equal(state.llmModels?.main?.model, 'deepseek-flash', '下行模型名就位，run 不再回退占位');
});

test('心跳先失败后成功：claim 仍严格晚于首次成功心跳', async () => {
  state.llmModels = null;
  const { deps, events } = makeDeps({ hbResults: [new Error('conn refused'), new Error('conn refused'), MODELS] });
  await initialHeartbeatGate(deps);
  events.push('claim');
  assert.deepEqual(events, ['hb-fail', 'hb-fail', 'hb-ok', 'claim']);
  assert.equal(state.llmModels?.main?.model, 'deepseek-flash');
});

test('心跳持续失败：按兜底超时放行（虚拟时钟不超 deadline）且 warn「llmModels 未就绪」', async () => {
  state.llmModels = null;
  const maxWaitMs = 30000; // = 2 个心跳周期（拍板兜底）
  const { deps, events, warnings, vt } = makeDeps({
    hbResults: () => new Error('portal unreachable'),
    maxWaitMs,
  });
  await initialHeartbeatGate(deps);
  events.push('claim');
  assert.ok(events.filter((e) => e === 'hb-fail').length >= 2, '至少重试两次心跳');
  assert.equal(events[events.length - 1], 'claim', '超时后放行 claim（不永久卡死）');
  assert.ok(vt() <= maxWaitMs, `等待不超兜底上限（vt=${vt()}）`);
  assert.equal(state.llmModels, null, '超时放行时 models 未就绪 → run 将回退 config 占位模型');
  const warn = warnings.find((w) => w.level === 'warn' && w.msg.includes('llmModels 未就绪'));
  assert.ok(warn, '超时放行必须带 warn 说明回退占位模型');
  assert.equal(warn.extra?.waited_ms, maxWaitMs);
});
