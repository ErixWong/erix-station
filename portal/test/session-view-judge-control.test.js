// issue #333：erix-agent 0.22 引擎控制文本（`meta.source === 'judge-control'`）不进文本取数面。
//
// 两条实测换来的事实（主 agent 亲手探针，不是照抄工单）：
// ① **界面正文本来就不漏**——对话正文来自 `messages` 锚点 + run 文本表；而且投影会给带 `meta.source`
//    的 **user 角色**消息另外打 `synthetic: true`，既有过滤早已拦住它。所以本文件既钉「性质成立」，
//    也钉「宿主那道守卫只能在直接喂 turn 时被测到」（不假装它是唯一防线）。
// ② 投影对 **assistant 角色**消息会**连 `meta.source` 一起抹掉** ⇒ 宿主侧对 assistant 角色的控制文本
//    结构上无从判据（所以下面钉的是「今天它会当成助手正文」这一现状，而不是一个接不住的守卫）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { projectTranscriptForDisplay } from 'erix-agent';

import {
  projectSessionMessages,
  userTurnTexts,
  assistantTurnText,
} from '../src/session-view.js';

const SESSION_ID = 'sess-jc-1';
const RUN_ID = 'run-jc-1';

const controlMsg = (text, role = 'user') => ({
  role,
  meta: { source: 'judge-control' },
  content: [{ type: 'text', text }],
});
const plainMsg = (role, text) => ({ role, content: [{ type: 'text', text }] });

const row = (round, dedupKey, messages, extra = {}) => ({
  run_id: RUN_ID,
  transcript_key: SESSION_ID,
  dedup_key: dedupKey,
  round,
  created_at: round,
  record: { dedupKey, round, ts: `2026-10-21T00:0${round}:00.000Z`, messages, ...extra },
});

// ---------------------------------------------------------------------------
// ① 宿主守卫本身：只有直接喂 turn 才测得到（拆掉 `!isEngineControlTurn(turn)` 这一条必须变红）
// ---------------------------------------------------------------------------

test('#333 userTurnTexts 认得 meta.source=judge-control（不依赖上游的 synthetic 标记）', () => {
  assert.deepEqual(
    userTurnTexts([
      { role: 'user', text: '真用户问题', meta: { synthetic: false } },
      { role: 'user', text: '评审意见：还差回归用例', meta: { source: 'judge-control' } },
    ]),
    ['真用户问题'],
    '带 marker 的用户侧消息不得算用户原话（它会进标题素材 / 锚点认领）',
  );
});

test('#333 同一行的真消息不被牵连（守卫是逐条判，不是逐行判）', () => {
  const turns = [{
    role: 'user',
    text: '真用户问题',
    meta: { synthetic: false, source: undefined },
  }];
  assert.deepEqual(userTurnTexts(turns), ['真用户问题']);
});

// ---------------------------------------------------------------------------
// ② 走真投影的性质：控制行在场时取数面干净，且 forced-final 的终稿不被吞
// ---------------------------------------------------------------------------

test('#333 真投影：forced-final 行「注入指令 + 真终稿」各归各位', () => {
  const turns = projectTranscriptForDisplay([{
    dedupKey: `${RUN_ID}:engine:round:2:control:forced-final`,
    round: 2,
    ts: '2026-10-21T00:02:00.000Z',
    messages: [
      plainMsg('user', '真用户问题'),
      controlMsg('【强制收尾】请立即给出终稿'),
      plainMsg('assistant', '这是强制收尾的终稿正文'),
    ],
  }]);

  assert.deepEqual(userTurnTexts(turns), ['真用户问题'],
    '注入指令不得冒充用户原话（按行过滤会连真用户文本一起吞掉）');
  assert.equal(assistantTurnText(turns), '这是强制收尾的终稿正文',
    '同一行的真终稿必须留下——它是该 run 唯一的正文来源（#300 的判据就是「零助手锚点」）');
});

test('#333 真投影：纯控制行（judge-nudge）两侧都取不到文本，且上游确实打了 synthetic', () => {
  const turns = projectTranscriptForDisplay([{
    dedupKey: `${RUN_ID}:engine:round:1:control:judge-nudge`,
    round: 1,
    ts: '2026-10-21T00:01:00.000Z',
    messages: [controlMsg('评审意见：方向不对，请回到交付物')],
  }]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].meta.synthetic, true,
    '上游口径：带 meta.source 的 user 消息被投影标成 synthetic（这条红了 = 上游改了标记方式，需重评守卫）');
  assert.deepEqual(userTurnTexts(turns), [], '控制文本不得成为标题素材 / 锚点候选');
  assert.equal(assistantTurnText(turns), null);
});

test('#333 上游口径现状：assistant 角色的控制文本，其 meta.source 会被投影抹掉（宿主接不住）', () => {
  const turns = projectTranscriptForDisplay([{
    dedupKey: `${RUN_ID}:engine:round:5:control:guard-revise`,
    round: 5,
    ts: '2026-10-21T00:05:00.000Z',
    messages: [controlMsg('假设上游改用 assistant 角色注入', 'assistant')],
  }]);

  assert.equal(turns[0].meta?.source, undefined,
    '投影抹掉了 meta.source（这条红了 = 上游开始保留该字段 ⇒ 届时才轮到宿主侧加守卫）');
  assert.equal(assistantTurnText(turns), '假设上游改用 assistant 角色注入',
    '现状：它会被当成助手正文 —— 不在宿主侧假装能拦住');
});

// ---------------------------------------------------------------------------
// ③ 端到端 DTO：控制行不污染对话正文，也不让终稿消失
// ---------------------------------------------------------------------------

test('#333 端到端投影：正文不含控制文本，终稿不丢，中途答复被终稿覆盖', () => {
  const projection = projectSessionMessages({
    sessionId: SESSION_ID,
    anchors: [
      { id: 'm1', seq: 1, role: 'user', content: '真用户问题', run_id: RUN_ID, synthetic: false },
      { id: 'm2', seq: 2, role: 'assistant', content: '', run_id: RUN_ID, synthetic: false },
    ],
    userAnchors: [{ id: 'm1', run_id: RUN_ID, seq: 1, anchor_text: '真用户问题', synthetic: false }],
    transcriptRows: [
      row(1, `${RUN_ID}:round:1`, [plainMsg('user', '真用户问题'), plainMsg('assistant', '真答复一')]),
      row(1, `${RUN_ID}:engine:round:1:control:judge-nudge`, [controlMsg('评审意见：方向不对，请回到交付物')]),
      row(2, `${RUN_ID}:engine:round:2:fold:abc`, [], { foldedSummary: { text: '摘要' } }),
      row(2, `${RUN_ID}:engine:round:2:control:forced-final`, [
        controlMsg('【强制收尾】请立即给出终稿'),
        plainMsg('assistant', '这是强制收尾的终稿正文'),
      ]),
    ],
  });

  const body = projection.map((item) => item.content ?? '').join('\n');
  assert.ok(!/方向不对|强制收尾】/.test(body), `控制文本漏进对话正文：${body}`);
  assert.match(body, /这是强制收尾的终稿正文/);
  assert.ok(!/真答复一/.test(body), '同一 run 取最后一条正文（终稿覆盖中途答复）');
});
