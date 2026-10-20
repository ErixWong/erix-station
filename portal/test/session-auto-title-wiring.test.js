// issue #322 收尾：自动改名的**接线**判据（真机取证换来的）。
//
// 真机上跑出来的缺陷（v0.1.20，会话 `981c8739…` / run `e11dc9ce…`）：自动改名**从来没真的调过模型**，
// 标题落的是降级链第二级「首条用户消息截断」——界面上标题照样会变，所以看不出来。
// A/B 直接打在 portal 容器里：
//   A 不带 config（当时生产的接线）⇒ null | 79ms，日志 `[auto-title] LLM 生成失败，退到降级链`
//   B 带 LLM_GATEWAY_ADMIN_URL      ⇒ "助手能力与交付说明" | 1472ms
// 根因：网关地址只有 `config.llmGatewayAdminUrl`（容器内 `http://station-litellm:4000`）可达，
// 而 `internal.js` 没把 config 传下去 ⇒ 退回默认 `http://127.0.0.1:4100` ⇒ 容器内 ECONNREFUSED（实测）。
// 与 AGENTS §8.25「必须传 `ctx.llmGateway` 单例」同族：**单测全都自己注入 config，看不见这两跳接线**。
//
// 因此这里钉三件事：① `http.js` 把 `ctx.config` 交给 `setRunState`；② `finishRun` 把 config 交给
// `scheduleAutoTitle`；③ 「config 缺 gateway 键 ⇒ 退回那个容器内不可达的地址」这个后果本身（防止有人
// 只改默认值就当接线修好了）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { generateAutoTitle } from '../src/session-title.js';
import { createSessionTextHandler, engineTranscriptRow } from './fake-session-text.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('#322 接线跳①：http.js 必须把 ctx.config 交给 setRunState（漏了就等于没网关地址）', () => {
  const src = read('../src/http.js');
  const call = src.match(/internal\.setRunState\(\s*ctx\.pool,\s*\{[^}]*\}\s*\)/);
  assert.ok(call, '找不到 internal.setRunState(ctx.pool, {…}) 这一跳（换了形态请同步本判据）');
  assert.match(call[0], /\bconfig:\s*ctx\.config\b/,
    'U2 的调用必须下传 ctx.config —— 自动改名要在 portal 侧调网关，只有 llmGatewayAdminUrl 在容器里可达');
});

test('#322 接线跳②：finishRun 必须把 config 透传给 scheduleAutoTitle', () => {
  const src = read('../src/internal.js');
  assert.match(src, /export async function setRunState\(pool, \{[^}]*\bconfig\b[^}]*\}\)/,
    'setRunState 的入参必须有 config（第一跳的接住点）');
  assert.match(src, /finishRun\(pool, \{[^}]*\bconfig\b[^}]*\}\)/,
    'finishRun 必须收到 config（中间那一跳别断）');
  const call = src.match(/scheduleAutoTitle\(\s*pool,\s*\{[^}]*\}/);
  assert.ok(call, '找不到 scheduleAutoTitle(pool, {…}) 这一跳');
  assert.match(call[0], /[, {]\s*config\s*[},]/,
    'scheduleAutoTitle 必须拿到 config；漏传 ⇒ title-llm.js 退回 127.0.0.1:4100 ⇒ 容器内 ECONNREFUSED ⇒ 静默降级');
});

// —— 后果本身：config 里没有网关键时会退到哪个地址（这就是 A/B 里那个 A）——

const AUTO_KEY = 'sk-wire-secret-123';
const bindingRow = {
  fde_id: 'u1', api_key: AUTO_KEY, state: 'active', gateway: 'litellm',
  provider_id: 'deepseek', main_model_id: 'mi-a', main_model_name: 'model-a',
  embedding_model_id: null, embedding_model_name: null, vision_model_id: null, vision_model_name: null,
};

/** 只喂 `generateAutoTitle` 需要的两类查询：该 run 的助手正文（transcript 投影）+ 该 FDE 的活绑定。 */
function wirePool() {
  const sessionText = createSessionTextHandler({
    sessionId: 's1',
    messages: [
      { id: 'm1', role: 'user', content: '帮我修登录页白屏', seq: 1, run_id: 'r1', synthetic: false, session_id: 's1', attachments: [] },
      { id: 'm2', role: 'assistant', content: '锚点侧收尾旧文', seq: 2, run_id: 'r1', synthetic: false, session_id: 's1', attachments: [] },
    ],
    transcriptRows: [engineTranscriptRow({
      sessionId: 's1', runId: 'r1', round: 1, userText: '帮我修登录页白屏', assistantText: '已完成：白屏已修好并补了用例',
    })],
  });
  return {
    async query(sql, params = []) {
      const hit = sessionText(sql, params);
      if (hit) return hit;
      if (sql.includes('FROM fde_llm_bindings')) return { rows: [bindingRow] };
      return { rows: [] };
    },
  };
}

function fakeChatFetch(content = '白屏修复完成') {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url, body: (() => { try { return JSON.parse(init.body); } catch { return null; } })() });
    return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) });
  };
  return { calls, fetchImpl };
}

test('#322 后果：config 缺网关键 ⇒ 退回 127.0.0.1:4100（容器内不可达 = 真机那个 A）；带 admin 地址 ⇒ 用它（真机那个 B）', async () => {
  const base = { sessionId: 's1', runId: 'r1', userId: 'u1', log: { warn() {}, info() {} } };

  const a = fakeChatFetch();
  const tA = await generateAutoTitle(wirePool(), { ...base, config: {}, fetchImpl: a.fetchImpl });
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].url, 'http://127.0.0.1:4100/v1/chat/completions',
    '没 config 就退到 config.js 里那个宿主回环地址——它在 portal 容器里 ECONNREFUSED（真机实测），所以这就是静默降级的形状');
  assert.equal(tA, '白屏修复完成', '本用例只钉地址选择，生成本身仍要成功（假 fetch 顶上网络）');

  const b = fakeChatFetch();
  const tB = await generateAutoTitle(wirePool(), {
    ...base, config: { llmGatewayAdminUrl: 'http://station-litellm:4000' }, fetchImpl: b.fetchImpl,
  });
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].url, 'http://station-litellm:4000/v1/chat/completions',
    '带 config ⇒ 走容器内可达的数据面（与手工改名同一个 admin/backend 地址，http.js:1506 同口径）');
  assert.equal(tB, '白屏修复完成');
});
