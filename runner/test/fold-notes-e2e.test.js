// issue #392（E 片）：**端到端**验「折叠 → 写注 → 注回到模型可见输入」这条链，一环不许靠声称。
//
// 为什么单独立一片：A/B/C 三片各自的单测只证明自己那一段（选对策略 / 绑对作用域 / 投得出去）。
// 三片接起来有一个**任何一片都证不了**的命题：
//
//     引擎折掉 N 轮 → 宿主写下一条会话笔记 → 下一次喂给模型的请求里，这条笔记在不在？
//
// 本文件落地当天就抓到两件事，都是只有"跑一遍真引擎"才可能看见的：
//   ① **C 片原本是死光纤**：`onFoldSummary` 被塞进 `context`，而引擎从**顶层 options** 解构它
//      （`option-normalization.js` 的 `RUN_TOOL_LOOP_OPTION_NAMES`）。折叠照跑、`record.foldedFacts`
//      照落账、注**一条也不写**、且不报错。C 片自己的 13 条判据全绿——因为它们喂的是手工 payload。
//   ② 探针不能拿注的**正文第二句**去请求里找：引擎的 semantic 段渲染的是**小抄目录**
//      （`[notes 小抄目录]（note_read key=... 取全文）` + 每条一行 `key (@agent): 首行`），不是注全文
//      （全文塞回去等于把刚省下的预算再烧掉）。拿正文当探针会得出"注没回去"的**假红**。
//
// 现场构成：真 `runToolLoop` + 桩 provider（录下每一份请求）+ 内存 store + **真** notes 工厂与
// **真**投递器（落真临时目录）+ 引擎元数据从 `worker.js` 的 `#309:engine-model-params` 标记里抠出来
// 求值（与生产同一条装配式，技法同 `model-metadata.test.js`）。
// ⚠ 预算下界不是自由参数：引擎算 `budget = cw - maxOutput - max(2000, ⌈cw×比例⌉)`
//   （`src/compact/budget.js:23-25`），预留硬底 2000 ⇒ `cw: 900` 直接 `Computed context budget must be
//   positive (got -1300)`，四格空转。`cw: 6000` 是"够小所以必然折叠、又不至于被硬底打死"的取值。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runToolLoop, createMemoryTranscriptStore } from 'erix-agent';

import { createNotesTools } from '../lib/notes-tools.js';
import { createFoldNoteSink } from '../lib/fold-notes.js';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(RUNNER_DIR, rel), 'utf8');
const PARAMS_MARKERS = /\/\* #309:engine-model-params:start \*\/([\s\S]*?)\/\* #309:engine-model-params:end \*\//;

/** 生产同一条元数据装配式（与 model-metadata.test.js 同款技法，不另抄字面量）。 */
function workerEngineModelParams(engineModelMetadata) {
  const block = read('worker.js').match(PARAMS_MARKERS);
  assert.ok(block, 'worker.js 的 #309:engine-model-params 标记没了，本片失去被测对象');
  return new Function('engineModelMetadata', `return {${block[1]}}`)(engineModelMetadata);
}

/** 造 n 轮真形态历史（user → tool_use → tool_result），文本足够长以便真折得动。 */
function historyRounds(n) {
  const messages = [];
  for (let i = 1; i <= n; i += 1) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `第 ${i} 轮任务 ${'u'.repeat(500)}` }] });
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `h-t${i}`, name: 'noop', input: { round: i } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `h-t${i}`, content: `第 ${i} 轮结果 ${'r'.repeat(700)}` }] });
  }
  return messages;
}

/** 桩 provider：录下每一份真实发出去的请求；前 toolCalls 次走工具轮，之后 end_turn。 */
function recordingProvider({ toolCalls = 5 } = {}) {
  const requests = [];
  return {
    requests,
    async chat(request) {
      requests.push(request);
      return requests.length <= toolCalls
        ? { content: [{ type: 'tool_use', id: `c${requests.length}`, name: 'noop', input: {} }], stopReason: 'tool_use' }
        : { content: [{ type: 'text', text: '收尾：无新工具调用' }], stopReason: 'end_turn' };
    },
  };
}

/**
 * 一次完整现场。`semanticEnabled: false` 用来做 E5 的对照组（不接 semanticStateProvider）。
 * 返回里带 `semantic`（provider 被调次数与返回值）——归因要靠它，不能只看"请求里有注"。
 */
async function runFoldingScene({ semanticEnabled = true } = {}) {
  const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-e2e-'));
  const sessionId = 'sess-e2e-1';
  const noteTools = await createNotesTools({ scopeRef: sessionId, notesDir });
  const deliveries = [];
  const sink = createFoldNoteSink({ noteTools, runId: 'run-e2e', onDeliveryError: (e) => deliveries.push(e) });
  const provider = recordingProvider();
  const store = createMemoryTranscriptStore();
  const semantic = { calls: 0, returns: [] };
  const semanticStateProvider = async (arg) => {
    semantic.calls += 1;
    const r = await noteTools.semanticStateProvider(arg);
    semantic.returns.push(r);
    return r;
  };

  const result = await runToolLoop({
    provider,
    store,
    runId: sessionId,
    maxRounds: 8,
    completion: false,
    initialMessages: historyRounds(14),
    initialUserMessage: '继续收尾',
    executeTool: async () => 'noop 结果',
    ...(semanticEnabled ? { semanticStateProvider } : {}),
    // ⚠ **顶层**选项：引擎从 options 解构 `onFoldSummary`，`context` 里只认 `strategy`。
    // 塞错一层就是本文件头注释里那条死光纤。
    onFoldSummary: sink.onFoldSummary,
    ...workerEngineModelParams({ context_window: 6000, max_output_tokens: 200 }),
    context: { strategy: 'fold-statistical' },
  });

  const requestsText = provider.requests.map((r) => JSON.stringify(r ?? {}));
  const notesFiles = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.json')) notesFiles.push(p);
    }
  };
  walk(notesDir);
  const records = await store.load(sessionId);
  return { result, requestsText, notesFiles, deliveries, sink, notesDir, records, sessionId, semantic };
}

const foldNoteFile = (files) => files.find((p) => /\/fold-[^/]+\.json$/.test(p));

// ── E1 前置：折叠在这个 run 里**真的发生了**（否则下游全是空断言） ──────────────────
test('E1 小预算 + fold-statistical：run 里真发生了折叠，模型看见的是带替代物的消息流', async () => {
  const { requestsText } = await runFoldingScene();
  assert.ok(requestsText.length >= 2, `桩 run 至少要有两次请求（实得 ${requestsText.length}）`);
  const foldedAt = requestsText.findIndex((t, i) => i >= 1 && /已折叠/.test(t));
  assert.ok(foldedAt >= 0,
    '从第 2 份请求起没有任何「已折叠」替代物 ⇒ 折叠没发生或策略没生效，下游断言全部失去对象');
  assert.match(requestsText[foldedAt], /工具足迹/, '替代物必须带工具足迹，否则模型无从判断去哪找原文');
});

// ── E2 折一次记一次：注由**真折叠**写出，落在会话作用域，形态对 ────────────────────
test('E2 真折叠真的写出了注（不是手工喂 payload），落会话作用域，key 可排时间线', async () => {
  const { notesFiles, sessionId, sink } = await runFoldingScene();
  assert.ok(sink.seq() >= 1, `引擎必须真调用过 onFoldSummary（实得 seq=${sink.seq()}）——`
    + '这一格就是当初那条死光纤：折叠照跑、回调零次、不报错');
  assert.ok(notesFiles.length >= 1, `notes 目录里应至少有一条注（实得 0）`);
  const file = foldNoteFile(notesFiles);
  assert.ok(file && file.includes(sessionId),
    `注必须落在 <notesDir>/run/<sessionId>/fold-*.json：${notesFiles.join(', ')}`);
  assert.match(path.basename(file), /^fold-\d{8}T\d{6}Z-r[^-]+-s\d+\.json$/,
    'key 必须可读、可排序，且过 store 的 SAFE_KEY（不过就被哈希成 h<digest>，顺序读不出来）');

  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rec.scopeRef, sessionId, '作用域是会话——run 作用域下下一个 run 一行也读不到（B 片病根）');
  assert.deepEqual(rec.tags, ['fold', 'src:statistical']);
  assert.equal(rec.pinned, false);
  assert.match(rec.current.content, /折走存档/);
});

// ── E3 投递失败不打死 run（真折叠路径下同样成立） ────────────────────────────────
test('E3 真折叠路径下不该有投递失败，且 run 正常跑完', async () => {
  const { result, deliveries, notesFiles } = await runFoldingScene();
  assert.equal(deliveries.length, 0, `不该有投递失败：${JSON.stringify(deliveries)}`);
  assert.ok(notesFiles.length >= 1);
  assert.ok(result, 'run 必须正常返回（注是台账，失败也不该把 run 打死——见 fold-notes.test.js C8）');
});

// ── E4 闭环：注回到模型可见输入 ─────────────────────────────────────────────────
test('E4 【闭环】折叠写出的注必须出现在喂给模型的请求里（以引擎的 notes 小抄形态）', async () => {
  const { requestsText, notesFiles, semantic } = await runFoldingScene();
  const note = JSON.parse(fs.readFileSync(foldNoteFile(notesFiles), 'utf8'));
  assert.match(note.current.content, /折走存档/);

  // 探针只取**小抄行里有的东西**（`折走存档` 是注的首行，会进小抄；正文第二句不会）。
  assert.ok(requestsText.some((t) => t.includes('折走存档')),
    '注写出来了，但没有任何一份喂给模型的请求里有它 ⇒ 折叠丢的东西只有人能捡回、模型捡不回，'
    + '那就只是台账，不是闭环');
  assert.ok(requestsText.some((t) => t.includes('note_read')),
    '请求里必须带 `note_read key=…` 的取全文指引，否则模型只知道有注、拿不到注内容');
  assert.ok(semantic.calls >= 1, 'semanticStateProvider 必须真被引擎调用过（没调用 = 闭环根本没启动）');
  assert.ok(semantic.returns.some((r) => typeof r?.text === 'string' && r.text.includes('折走存档')),
    '宿主侧 provider 必须把那条折叠注渲染进小抄');
});

// ── E5 对照组：证明 E4 不是白绿 ─────────────────────────────────────────────────
test('E5 不接 semanticStateProvider 时注仍在盘上、但进不了模型输入（E4 的归因靠本格兜住）', async () => {
  const { requestsText, notesFiles } = await runFoldingScene({ semanticEnabled: false });
  assert.ok(foldNoteFile(notesFiles), '关掉 semantic 不该影响写注：投递与注入是两件事');
  assert.ok(!requestsText.some((t) => t.includes('折走存档')),
    '不接 provider 却还能在请求里看到注 ⇒ 注是从别的渠道进来的（例如折叠消息本身），E4 的归因就错了');
});

// ── E6 折叠事实同时进轮记录（引擎 #470-B/#470-D 两路都得在） ──────────────────────
test('E6 同一份替代物既投给了宿主回调，也进了轮记录的 foldedFacts（两条路不是二选一）', async () => {
  const { records } = await runFoldingScene();
  const withFacts = records.filter((r) => r?.foldedFacts?.text);
  assert.ok(withFacts.length >= 1,
    '轮记录里没有任何 foldedFacts ⇒ 账本又变回"折了但说不出折了什么"（#470-B 的回退）');
  assert.match(withFacts[0].foldedFacts.text, /已折叠|工具足迹/);
});
