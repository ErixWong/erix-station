// issue #351「引擎面向的 `store.load()` 未做读侧折叠」的回归锁。
//
// 缺陷本体（dev 真机两个标本，都是**同一条会话**在 8 分钟内先后撞上的）：
//   · `Invalid message at index 56: assistant tool_use has no immediately following user tool_result`
//     —— 被停止那轮的 `tool_result` 要等下一次 run resume 才补落盘，而宿主的 `:input:` 行是发消息
//     **当场**写的（#162 顺序红线）⇒ 同一轮内 `append_seq` 顺序反了，`tool_use` 与它的结果之间
//     夹了一条 user 文本；
//   · `Invalid message at index 81: tool_result ids do not match assistant tool_use ids`
//     —— 一轮 3 个并行工具调用，上游 0.23 写侧把 `partOf` 写成**链**（erix-agent #415 未修）。
// 两者在**上游自己的 file/memory store** 里都不砖（那两个 store 的 `load()` 会跑 `foldMessageRows`），
// 只有本站 store 直通原始行才砖 ⇒ 修点在 `runner/lib/store.js#load`。
//
// 判据为什么必须跑**引擎自己的函数**：`validateMessages`（`src/messages/rounds.js`）才是「砖不砖」的
// 定义。自己数条数只能证明「我理解的形状」，证明不了引擎认。
//
// ⚠ 本文件同时是**两份镜像的漂移锁**：
//   · `SHARED-FOLD-CORE` 区间源码逐字节相同（`runner/lib/transcript-fold.js` ↔
//     `portal/src/transcript-fold.js`）⇒ 单边改口径必红；
//   · 与**上游真件**（按文件路径 import，深路径不在 exports 面 = 故意的 tripwire）在无链账本上
//     逐字段对拍 ⇒ 上游改口径/挪文件红在这里，而不是两把尺各自漂移。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStore } from '../lib/store.js';
import { foldLedgerRecords } from '../lib/transcript-fold.js';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.join(RUNNER_DIR, '..');
const UPSTREAM_PATH = path.join(REPO_ROOT, 'node_modules/erix-agent/src/store/message-rows.js');
const READ_SIDE = path.join(RUNNER_DIR, 'lib/transcript-fold.js');
const DISPLAY_SIDE = path.join(REPO_ROOT, 'portal/src/transcript-fold.js');

// 上游件按**文件路径** import（深路径不在包 exports 面 = 故意的 tripwire，上游挪文件这边先红），
// 与 `portal/test/transcript-fold.test.js:20` 同一手法。
const ROUNDS_PATH = path.join(REPO_ROOT, 'node_modules/erix-agent/src/messages/rounds.js');
const upstreamModules = await Promise.all([import(UPSTREAM_PATH), import(ROUNDS_PATH)]);
const foldLedgerMessages = upstreamModules[0].foldLedgerMessages;
const validateMessages = upstreamModules[1].validateMessages;

const K = 'sess-351';
const text = (s) => ({ type: 'text', text: s });
const toolUse = (id, name = 'shell') => ({ type: 'tool_use', id, name, input: { command: 'sleep 240' } });
const toolResult = (id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' });
/** 消息行（`kind: "message"` + 轮内 `seq`）。 */
const msgRow = (round, seq, message, extra = {}) => ({
  round, kind: 'message', seq, dedupKey: `${K}:msg:${round}:${seq}`, roundKey: `${K}:round:${round}`,
  messages: [message], ...extra,
});
/** 轮记录（载体行）：0.23 起只有元数据，`messages` 为空。 */
const carrierRow = (round, suffix = '') => ({
  round, dedupKey: `${K}:engine:round:${round}${suffix}`, roundKey: `${K}:round:${round}`, messages: [],
});
/** 宿主 `appendUserTurn` 预写的用户输入行（**带正文但没有 `kind`/`seq`** ⇒ 天生不参与折叠）。 */
const inputRow = (round, messageId, body) => ({
  round, dedupKey: `${K}:input:${messageId}`, roundKey: `${K}:input:${messageId}`,
  messages: [{ role: 'user', content: [text(body)] }],
});

/** 引擎的读法：`foldLedgerMessages` 拼逻辑消息，`validateMessages` 判合法。 */
function engineValidate(records) {
  const entries = foldLedgerMessages(records);
  const messages = entries.map((entry) => entry.message);
  validateMessages(messages); // 抛错 = 会话砖化
  return messages;
}

/** 内存 IPC peer 桩：只模拟「agentd 把全量行拉齐后返回 `{records}`」这一段。 */
function peerReturning(records) {
  return {
    calls: [],
    async handle(method, args) {
      this.calls.push({ method, args });
      if (method !== 'load') throw new Error(`unexpected method ${method}`);
      return { records: structuredClone(records) };
    },
  };
}

const storeOver = (records) => makeStore(K, { request: (m, a) => peerReturning(records).handle(m, a) });

// ---------------------------------------------------------------------------
// 1. 两个真标本形状：不折必砖，接上折叠就活
// ---------------------------------------------------------------------------

test('#351 标本①（:input: 插队）：原样直通会砖，store.load() 的输出过引擎校验', async () => {
  const rows = [
    msgRow(28, 0, { role: 'assistant', content: [text('我去跑个长命令'), toolUse('call-28')] }),
    inputRow(28, 'm-next', '现在看看上游有没有更新'),                    // ← 插在中间（真机 append_seq 1123）
    msgRow(28, 1, { role: 'user', content: [toolResult('call-28')] }),   // ← resume 才补落盘（真机 1124）
    carrierRow(28, ':resume'),                                            // ← 崩溃轮载体（真机 1125）
    msgRow(29, 0, { role: 'assistant', content: [text('收到'), toolUse('call-29')] }),
    msgRow(29, 1, { role: 'user', content: [toolResult('call-29')] }),
    carrierRow(29),
  ];

  // 前提自证：这批行**不折**就是引擎那句原话（否则本用例是假的）
  assert.throws(() => engineValidate(structuredClone(rows)),
    (err) => err.code === 'invalid_messages'
      && /assistant tool_use has no immediately following user tool_result/.test(err.message),
    '前提塌了：这批夹具不折也能过引擎校验，那它测不出 #351');

  const messages = engineValidate(await storeOver(rows).load(K));
  assert.equal(messages.length, 5,
    '折完是 5 条逻辑消息：round 28 的 assistant + 聚合 tool_result 折回 `…:resume` 载体（2 条）'
    + ' + `:input:` 那条（1 条，它本来就该在上下文里）+ round 29 的 2 条');
  // 顺序也是契约面：折叠把正文放到**载体行的位置**，而载体行写在 `:input:` 行之后
  // ⇒ 崩溃轮的正文排在宿主追问**之后**（上游 host-consumer-contract.md:2432-2437 明写这个次序）。
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user'],
    '次序变了说明折叠落点或行序变了（引擎侧模型上下文对这个次序不敏感，但 validateMessages 敏感）');
  // 折叠不得吞内容：三件正文一件结果一件都不能少
  const flat = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  assert.equal(flat.filter((b) => b.type === 'tool_use').length, 2);
  assert.equal(flat.filter((b) => b.type === 'tool_result').length, 2);
  assert.ok(messages.some((m) => typeof m.content === 'string'
    || m.content?.some((b) => b.text === '现在看看上游有没有更新')), ':input: 正文必须还在');
});

test('#351 标本②（链式 partOf，erix-agent #415）：上游折不回，本站 store.load() 折得回', async () => {
  const rows = [
    msgRow(38, 0, { role: 'assistant', content: [toolUse('a'), toolUse('b'), toolUse('c')] }),
    msgRow(38, 1, { role: 'user', content: [toolResult('a')] }),
    msgRow(38, 2, { role: 'user', content: [toolResult('b')] }, { partOf: `${K}:msg:38:1` }),
    msgRow(38, 3, { role: 'user', content: [toolResult('c')] }, { partOf: `${K}:msg:38:2` }), // ← 链上第 2 跳
    carrierRow(38),
  ];

  // 上游读侧（file/memory store 的折叠件）对同一批行**也**给不出合法形状 ⇒ 这是 #415，不是本站发明的需求
  const upstream = await import(UPSTREAM_PATH);
  assert.throws(() => engineValidate(upstream.foldMessageRows(structuredClone(rows))),
    (err) => err.code === 'invalid_messages'
      && /tool_result ids do not match assistant tool_use ids/.test(err.message),
    '上游 foldMessageRows 现在能解链了 ⇒ erix-agent #415 已落地：**两份镜像的解链闸该一起撤**');

  const messages = engineValidate(await storeOver(rows).load(K));
  const users = messages.filter((m) => m.role === 'user');
  assert.equal(users.length, 1, '3 个分片必须折回**同一条**聚合 tool_result 消息');
  assert.deepEqual(users[0].content.map((b) => b.tool_use_id).sort(), ['a', 'b', 'c']);
});

// ---------------------------------------------------------------------------
// 2. 折叠不得改变的东西
// ---------------------------------------------------------------------------

test('#351 0.22 及更早的账本（轮行自带 messages、无消息行）：load() 逐字节不变', async () => {
  const legacy = [
    { round: 1, dedupKey: `${K}:engine:round:1`, messages: [{ role: 'assistant', content: [text('老正文')] }] },
  ];
  const peer = peerReturning(legacy);
  const out = await makeStore(K, { request: (m, a) => peer.handle(m, a) }).load(K);
  assert.deepEqual(out, legacy);
  assert.notEqual(out, undefined);
});

test('#351 载体行不在场（崩溃在轮行落盘前 / 分页切在轮中间）⇒ 消息行一条都不许丢', async () => {
  const rows = [
    msgRow(7, 0, { role: 'assistant', content: [toolUse('x')] }),
    msgRow(7, 1, { role: 'user', content: [toolResult('x')] }),
  ];
  const out = await storeOver(rows).load(K);
  assert.equal(out.length, 2, '没有载体时消息行原样留在数组里（这是崩溃恢复契约，不是 store bug）');
  assert.deepEqual(out.map((r) => r.dedupKey), [`${K}:msg:7:0`, `${K}:msg:7:1`]);
});

test('#351 `:input:` 行永远留在 load() 输出里（appendUserTurn 的幂等判据靠它）', async () => {
  const rows = [
    msgRow(3, 0, { role: 'assistant', content: [text('hi')] }),
    carrierRow(3),
    inputRow(3, 'm-1', '追问'),
  ];
  const out = await storeOver(rows).load(K);
  assert.ok(out.some((r) => r.dedupKey === `${K}:input:m-1`),
    '被折叠吸走就会重复追加同一轮追问（上游 message-rows.js 文件头同口径）');
});

test('#351 折叠是纯函数：不改写 peer 返回的行（agentd 复用同一批对象时不能看见被改过的正文）', async () => {
  const rows = [
    msgRow(9, 0, { role: 'assistant', content: [toolUse('p')] }),
    msgRow(9, 1, { role: 'user', content: [toolResult('p')] }),
    carrierRow(9),
  ];
  const before = structuredClone(rows);
  foldLedgerRecords(rows);
  assert.deepEqual(rows, before);
});

// ---------------------------------------------------------------------------
// 2b. 折叠后的 `load()` 输出喂给真引擎：续跑不得因 `seq` 看不见而重号（跳号地板分支）
// ---------------------------------------------------------------------------

test('#351 真 runToolLoop 贯通：崩溃→追问→resume→**再 resume**，第二趟 resume 才真正区分折没折', async () => {
  // 为什么这条必须跑真引擎、还必须跑到**第三趟**：
  //   · 崩溃现场那次 resume 引擎自己会把宿主的 `:input:` 行当尾巴延后拼（`resume-manager.js:196-215`），
  //     所以「不折」也能过第二趟 —— 真机 `07237084…` 就是崩溃后那次 resume 成功跑了 8 轮；
  //   · 砖发生在**下一次** resume（快照干净了，尾巴支路不再走）——真机 `4f857875…` / `400ef1a4…`；
  //   · 顺带覆盖 `seq` 播种的跳号地板（`resume-manager.js:236-246`：「折叠过的轮里 `seq` 看不见，
  //     宁可跳号也不能重号」）——本站把折叠挪进 `load()` 后引擎**总是**看到那种输出，
  //     地板没兜住的症状是同 `(round, seq)` 写不同正文 → portal 409 → 该 key 永久不可恢复。
  const { runToolLoop } = await import('erix-agent');
  const { createShellTools } = await import('../lib/shell-tools.js');
  const shellSchema = () => createShellTools({ worktreeRoot: RUNNER_DIR }).schemas[0];
  const KEY = 'sess-351-crash';

  // 真账本语义的行存储：同 dedupKey 不同正文 ⇒ 抛冲突（= portal 的 409 round_conflict）
  const rows = [];
  const seen = new Map();
  let conflicts = 0;
  const peer = {
    async handle(method, args = {}) {
      if (method === 'appendRound') {
        const record = structuredClone(args.record);
        const key = record.dedupKey ?? record.roundKey ?? `${KEY}:round:${record.round}`;
        const body = JSON.stringify(record.messages ?? null);
        if (seen.has(key) && seen.get(key) !== body) {
          conflicts += 1;
          throw Object.assign(new Error(`dedup_payload_conflict: ${key}`), { code: 'dedup_payload_conflict', retryable: false });
        }
        if (!seen.has(key)) rows.push(record);
        seen.set(key, body);
        return { inserted: true };
      }
      if (method === 'load') return { records: structuredClone(rows) }; // **原始行**，折叠由 adapter 做
      if (method === 'saveRunSnapshot') { peer.snapshot = structuredClone(args.snapshot); return {}; }
      if (method === 'loadLatestRunSnapshot') return peer.snapshot ? { checkpoint: { snapshot: peer.snapshot, revision: 1 } } : {};
      return {};
    },
  };
  const store = makeStore(KEY, { request: (m, a) => peer.handle(m, a) });

  // 第 1 趟：要一个 shell 调用，执行中被中止 ⇒ `msg:<r>:0` 已落盘、结果没落盘（= 现场）
  const abort = new AbortController();
  const toolCallId = 'call-crash-1';
  await runToolLoop({
    provider: { async chat() { return { content: [{ type: 'tool_use', id: toolCallId, name: 'shell', input: { command: 'sleep 240' } }], stopReason: 'tool_use' }; } },
    initialUserMessage: 'go', completion: false, tools: [shellSchema()], maxRounds: 6,
    replayPolicy: 'per-tool-declaration', store, runId: KEY,
    executeTool: async () => { abort.abort(); return 'outcome never recorded'; },
    signal: abort.signal,
  }).catch(() => {});

  const crashRound = Math.max(...rows.map((r) => r.round ?? 0));
  assert.ok(rows.some((r) => r.kind === 'message' && r.round === crashRound),
    '前提自证：崩溃轮的 assistant 正文必须已按「一条消息一落盘」入账（否则现场是假的）');

  // 用户再发一条：宿主 appendUserTurn 当场预写 `:input:` 行（排在迟到结果之前 = 真机那个插队形状）
  rows.push({ round: crashRound, dedupKey: `${KEY}:input:m2`, roundKey: `${KEY}:input:m2`,
    messages: [{ role: 'user', content: [{ type: 'text', text: '继续' }] }] });
  seen.set(`${KEY}:input:m2`, JSON.stringify(rows.at(-1).messages));

  // 第 2 趟：resume（不再要工具 ⇒ 直接收尾）
  const resumed = await runToolLoop({
    provider: { async chat() { return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }; } },
    completion: false, tools: [shellSchema()], maxRounds: 6,
    replayPolicy: 'per-tool-declaration', store, runId: KEY, resume: true,
    executeTool: async () => 'not used',
  }).catch((error) => ({ error }));

  assert.equal(resumed?.error?.code ?? resumed?.error, undefined,
    `resume 必须成功（拿到的是折叠后的 load 输出）：${resumed?.error?.message ?? resumed?.error}`);
  assert.equal(resumed?.finalText, 'done', '续跑要能正常收尾');
  assert.equal(conflicts, 0,
    '续跑期间一次去重冲突都不能有：冲突 = 同一 (round, seq) 被写了不同正文 ⇒ 该 transcript key 永久不可恢复');

  // 第 3 趟：**再 resume 一次**（此时快照已干净，崩溃现场的「延后接回」那条支路不再走）。
  // 真机就是这个形状：`07237084…`（崩溃后那次 resume）**成功**跑完 8 轮，紧接的下一次 run 才砖
  // ⇒ 只在崩溃现场测等于没测：崩溃现场引擎自己会把 `:input:` 行当尾巴延后拼（`resume-manager.js:196-215`）。
  const interleave = rows.findIndex((r) => r.dedupKey === `${KEY}:input:m2`);
  const resultIndex = rows.findIndex((r) => (r.messages ?? []).some((m) => (m.content ?? [])
    .some((b) => b?.type === 'tool_result' && b.tool_use_id === toolCallId)));
  assert.ok(interleave >= 0 && resultIndex > interleave,
    `前提自证：宿主的 :input: 行必须排在迟到的 tool_result **之前**（真机形状），实际 input=${interleave} result=${resultIndex}`);

  const third = await runToolLoop({
    provider: { async chat() { return { content: [{ type: 'text', text: 'again' }], stopReason: 'end_turn' }; } },
    completion: false, tools: [shellSchema()], maxRounds: 6,
    replayPolicy: 'per-tool-declaration', store, runId: KEY, resume: true,
    executeTool: async () => 'not used',
  }).catch((error) => ({ error }));
  assert.equal(third?.error?.code ?? third?.error, undefined,
    '第 3 趟 resume 必须成功——这一步才真正区分「折了」与「没折」：不折时引擎看到的序列里'
    + ' `tool_use` 与它的 `tool_result` 之间夹着宿主那条 user 文本 ⇒ invalid_messages（真机 index 56 同一条）');
  assert.equal(third?.finalText, 'again');
});

// ---------------------------------------------------------------------------
// 3. 接线本身与两份镜像的漂移锁（源码级）
// ---------------------------------------------------------------------------

test('#351 接线在 store.load()：有人把它摘掉就红（行为面已钉，这条钉「别退回注释/删掉」）', () => {
  const source = fs.readFileSync(path.join(RUNNER_DIR, 'lib/store.js'), 'utf8');
  const loadBody = /async load\(r\) \{([\s\S]*?)\n    \},/.exec(source)?.[1] ?? '';
  assert.ok(/foldLedgerRecords\(\s*records\s*\)/.test(loadBody),
    'runner/lib/store.js 的 load() 必须折一次再返回 —— 引擎只调 foldLedgerMessages，不做载体折叠');
});

test('#351 两份读侧折叠（runner ↔ portal）的 SHARED-FOLD-CORE 区间逐字节相同', () => {
  const region = (file) => {
    const src = fs.readFileSync(file, 'utf8');
    const m = /\/\/ ===== SHARED-FOLD-CORE BEGIN =====\n([\s\S]*?)\n\/\/ ===== SHARED-FOLD-CORE END =====/.exec(src);
    assert.ok(m, `${file} 里找不到 SHARED-FOLD-CORE 区间（改名/删标记 = 漂移锁失效）`);
    return m[1];
  };
  const runnerCore = region(READ_SIDE);
  const portalCore = region(DISPLAY_SIDE);
  assert.equal(runnerCore, portalCore,
    '折叠口径只能有一把尺：FDE 镜像里没有 portal 源码 ⇒ 只能镜像，但口径必须两边一起改');
  assert.ok(runnerCore.includes('parts.set(key, partTargetIndex)'),
    '#341 解链闸必须在（撤闸要两份同时撤，见 portal 侧源码级哨兵用例）');
});

test('#351 与上游真件对拍：无链账本两边输出逐字段相同（上游改了口径要看得见）', async () => {
  const upstream = await import(UPSTREAM_PATH);
  assert.ok(typeof upstream.foldMessageRows === 'function',
    `上游折叠件挪走了（${UPSTREAM_PATH}）⇒ 对拍失效，请同步本文件与 portal 侧对拍用例`);

  const fixtures = {
    '单轮单消息': [msgRow(1, 0, { role: 'assistant', content: [text('a')] }), carrierRow(1)],
    '单轮两工具（一跳 partOf）': [
      msgRow(2, 0, { role: 'assistant', content: [toolUse('u1'), toolUse('u2')] }),
      msgRow(2, 1, { role: 'user', content: [toolResult('u1')] }),
      msgRow(2, 2, { role: 'user', content: [toolResult('u2')] }, { partOf: `${K}:msg:2:1` }),
      carrierRow(2),
    ],
    '夹着 :input: 行': [carrierRow(4), inputRow(4, 'm', '追问')],
    '只有轮记录（老账本）': [carrierRow(5)],
  };
  for (const [name, rows] of Object.entries(fixtures)) {
    assert.deepEqual(foldLedgerRecords(structuredClone(rows)),
      upstream.foldMessageRows(structuredClone(rows)),
      `与上游折叠输出不一致：${name}`);
  }
});

test('#351 源码级哨兵：上游仍未在分片分支登记 key（**红了不是回归，是提示撤两份闸**）', () => {
  const source = fs.readFileSync(UPSTREAM_PATH, 'utf8');
  const body = /export function foldMessageRows\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';
  assert.ok(body.length > 0, '上游 foldMessageRows 函数体找不到了（改名/挪文件）⇒ 先修对拍，再判本条');
  const sets = body.match(/parts\.set\(/g) ?? [];
  assert.equal(sets.length, 1,
    '上游 `parts.set` 数量变了 ⇒ erix-agent #415 可能已落地：撤闸动作 = 同时删 runner/portal 两份镜像里'
    + ' `planFold` 的那行 `parts.set(key, partTargetIndex)` 与 portal/test、本文件的解链断言');
});
