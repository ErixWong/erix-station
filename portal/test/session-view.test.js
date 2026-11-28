import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getSession } from '../src/sessions.js';
import { projectSessionMessages, recordForProjection } from '../src/session-view.js';
import { projectTranscriptForDisplay } from '../src/display-projection.js';

const SESSION_ID = '10000000-0000-4000-8000-000000000001';
const LEGACY_SESSION_ID = '10000000-0000-4000-8000-000000000002';
const NEW_SESSION_ID = '10000000-0000-4000-8000-000000000003';
const MIXED_SESSION_ID = '10000000-0000-4000-8000-000000000004';
const RUN_1 = '20000000-0000-4000-8000-000000000001';
const RUN_2 = '20000000-0000-4000-8000-000000000002';
const LEGACY_RUN = '20000000-0000-4000-8000-000000000003';
const RUN_4 = '20000000-0000-4000-8000-000000000004';
const USER_ID = '30000000-0000-4000-8000-000000000001';

const at = (second) => new Date(Date.UTC(2026, 9, 7, 0, 0, second));
const text = (value) => [{ type: 'text', text: value }];

function transcriptTexts(transcriptRows) {
  const values = new Set();
  const addContent = (content) => {
    const value = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
        : null;
    if (value !== null) values.add(value);
  };

  for (const { record } of transcriptRows) {
    const messages = Array.isArray(record?.messages) ? record.messages : [];
    for (const transcriptMessage of messages) {
      if (transcriptMessage?.role === 'user' || transcriptMessage?.role === 'assistant') {
        addContent(transcriptMessage.content);
      }
    }
    addContent(record?.response?.content);
  }
  return values;
}

function assertTranscriptBacked(result, transcriptRows) {
  const sourceTexts = transcriptTexts(transcriptRows);
  for (const projected of result.messages) {
    if (projected.synthetic !== true && projected.content !== '') {
      assert.ok(
        sourceTexts.has(projected.content),
        `non-synthetic ${projected.role} ${projected.id} must come from transcript`,
      );
    }
  }
}

function message(id, seq, role, content, runId, {
  synthetic = false,
  attachments = [],
  createdAt = at(seq),
} = {}) {
  return {
    id,
    run_id: runId,
    seq,
    role,
    content,
    synthetic,
    attachments,
    created_at: createdAt,
  };
}

function transcript(round, dedupKey, record, createdAt, runId = null) {
  return { run_id: runId, round, dedup_key: dedupKey, record, created_at: createdAt };
}

class SessionViewPool {
  constructor({ sessionId = SESSION_ID, anchors, transcriptRows, textualizedRunIds = [] }) {
    this.sessionId = sessionId;
    this.anchors = anchors;
    this.transcriptRows = transcriptRows;
    // issue #243：库里带 `textualized_tool_call` 诊断事件的 run_id（默认空 = 没命中）。
    this.textualizedRunIds = textualizedRunIds;
    this.queries = [];
  }

  async query(sql, params = []) {
    this.queries.push({ sql, params });
    if (sql.includes('FROM chat_sessions s')) {
      return {
        rows: [{
          id: this.sessionId,
          user_id: USER_ID,
          project_id: null,
          cwd: '~/projects/demo',
          title: 'transcript projection',
          title_source: 'auto',
          model: null,
          status: 'active',
          last_seq: 8,
          // #197： getSession 的 fetchSession SQL 内嵌子查询列（真库为 COUNT 结果，可能是 bigint 字符串）。
          message_count: 23,
        }],
      };
    }
    if (sql.includes('FROM messages') && sql.includes("role = 'user'")) {
      return {
        rows: this.anchors
          .filter((anchor) => anchor.role === 'user')
          .sort((a, b) => a.seq - b.seq)
          .map(({ id, run_id, seq, synthetic, content, created_at }) => ({
            id, run_id, seq, synthetic, anchor_text: content, created_at,
          })),
      };
    }
    if (sql.includes('FROM messages')) {
      let rows = this.anchors.filter((anchor) => anchor.seq < (params[2] ?? Infinity));
      const limit = Number(params[1]);
      rows = rows.sort((a, b) => b.seq - a.seq).slice(0, limit);
      return { rows };
    }
    if (sql.includes('FROM transcript_rounds')) {
      assert.equal(params[0], this.sessionId, 'transcript lookup is scoped to this session key');
      return { rows: [...this.transcriptRows].sort((a, b) => a.round - b.round || a.created_at - b.created_at) };
    }
    if (sql.includes('FROM runs')) return { rows: [] };
    // issue #283：宿主自有的时长取数面（`getSession` 为 DTO 的 toolCalls[].durationMs 而查）。
    // 不写死行为：按 SQL 里的 `run_id = ANY($1)` 与 `duration_ms IS NOT NULL` 真筛。
    // #303：DTO 的工具时长只来自引擎投影，`getSession` **不再**为它查自家 `tool_calls`。
    // 这里不返回空行而是**当场炸**：谁把那条取数加回来（或别的代码路过这里），测试会指名报错，
    // 而不是静默拿到空集合让断言假绿。
    if (sql.includes('FROM tool_calls')) {
      throw new Error('#303 已退役：session-view 不该再查 tool_calls 取时长（SQL='
        + String(sql).replace(/\s+/g, ' ').trim().slice(0, 120) + '）');
    }
    // issue #243：宿主为助手气泡取「哪些 run 有 `textualized_tool_call` 诊断」（同 tool_calls：按 run 集合限定，不拿全表）。
    if (sql.includes('FROM run_events')) {
      assert.ok(sql.includes("type = 'textualized_tool_call'"), 'run_events 取数必须按诊断类型限定');
      assert.ok(sql.includes('run_id = ANY'), 'run_events 取数必须按 run 集合限定（不拿全表）');
      const runIds = new Set(params[0] ?? []);
      return { rows: this.textualizedRunIds.filter((runId) => runIds.has(runId)).map((run_id) => ({ run_id })) };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

function fixture() {
  const attachments = [{ kind: 'file', path: '/workspace/report.txt', name: 'report.txt' }];
  const anchors = [
    message('m1', 1, 'user', 'first question', RUN_1, { attachments, createdAt: at(1) }),
    message('a1', 2, 'assistant', 'first final answer', RUN_1, { createdAt: at(4) }),
    message('m2', 3, 'user', 'second question', RUN_2, { createdAt: at(5) }),
    message('a2', 4, 'assistant', 'second final answer', RUN_2, { createdAt: at(9) }),
    message('judge-1', 5, 'user', 'anchor: judge injection', RUN_2, { synthetic: true, createdAt: at(10) }),
    message('old-user', 6, 'user', 'legacy user anchor text', LEGACY_RUN, { createdAt: at(11) }),
  ];

  const transcriptRows = [
    // Round-0 seed has no message ID: current station records use the session key,
    // so it is associated with the user anchor that existed when this seed was stored.
    transcript(0, `${SESSION_ID}:engine:round:0:seed`, {
      round: 0,
      roundKey: `${SESSION_ID}:round:0`,
      dedupKey: `${SESSION_ID}:engine:round:0:seed`,
      messages: [{ role: 'user', content: text('first question') }],
    }, at(2)),
    transcript(1, `${SESSION_ID}:engine:round:1`, {
      round: 1,
      roundKey: `${SESSION_ID}:round:1`,
      dedupKey: `${SESSION_ID}:engine:round:1`,
      messages: [{ role: 'assistant', content: text('intermediate answer') }],
      response: { content: text('intermediate answer'), stopReason: 'tool_use' },
      folded: true,
      foldedPayload: { summary: 'must not replace displayed full record' },
    }, at(3)),
    transcript(2, `${SESSION_ID}:engine:round:2`, {
      round: 2,
      roundKey: `${SESSION_ID}:round:2`,
      dedupKey: `${SESSION_ID}:engine:round:2`,
      messages: [{ role: 'assistant', content: text('first final answer') }],
      response: { content: text('first final answer'), stopReason: 'end_turn' },
      folded: true,
      foldedPayload: { summary: 'must not replace displayed full record' },
    }, at(4)),
    transcript(2, `${SESSION_ID}:input:m2`, {
      round: 2,
      roundKey: `${SESSION_ID}:input:m2`,
      dedupKey: `${SESSION_ID}:input:m2`,
      messages: [{ role: 'user', content: text('second question') }],
    }, at(6)),
    transcript(3, `${SESSION_ID}:engine:round:3`, {
      round: 3,
      roundKey: `${SESSION_ID}:round:3`,
      dedupKey: `${SESSION_ID}:engine:round:3`,
      messages: [{ role: 'assistant', content: text('second intermediate') }],
      response: { content: text('second intermediate'), stopReason: 'tool_use' },
    }, at(7)),
    transcript(4, `${SESSION_ID}:engine:round:4`, {
      round: 4,
      roundKey: `${SESSION_ID}:round:4`,
      dedupKey: `${SESSION_ID}:engine:round:4`,
      messages: [{ role: 'assistant', content: text('second final answer') }],
      response: { content: text('second final answer'), stopReason: 'end_turn' },
    }, at(8)),
  ];
  return { anchors, transcriptRows, attachments };
}

test('GET session projects user and final assistant text while preserving anchor DTO metadata', async () => {
  const { anchors, transcriptRows, attachments } = fixture();
  const pool = new SessionViewPool({ anchors, transcriptRows });

  const result = await getSession(pool, { userId: USER_ID, sessionId: SESSION_ID, limit: 100 });

  assert.deepEqual(
    result.messages.map(({ id, seq, role, content, synthetic, attachments: files }) => ({
      id, seq, role, content, synthetic, attachments: files,
    })),
    [
      { id: 'm1', seq: 1, role: 'user', content: 'first question', synthetic: false, attachments },
      { id: 'a1', seq: 2, role: 'assistant', content: 'first final answer', synthetic: false, attachments: [] },
      { id: 'm2', seq: 3, role: 'user', content: 'second question', synthetic: false, attachments: [] },
      { id: 'a2', seq: 4, role: 'assistant', content: 'second final answer', synthetic: false, attachments: [] },
      { id: 'judge-1', seq: 5, role: 'user', content: 'anchor: judge injection', synthetic: true, attachments: [] },
      { id: 'old-user', seq: 6, role: 'user', content: '', synthetic: false, attachments: [] },
    ],
  );
  for (const id of ['m1', 'a1', 'm2', 'a2', 'judge-1']) {
    const projected = result.messages.find((message) => message.id === id);
    const anchor = anchors.find((message) => message.id === id);
    assert.equal(projected.id, anchor.id);
    assert.equal(projected.seq, anchor.seq);
    assert.equal(projected.role, anchor.role);
    assert.equal(projected.content, anchor.content);
    assert.equal(projected.synthetic, anchor.synthetic);
    assert.deepEqual(projected.attachments, anchor.attachments);
  }
  assert.equal(result.messages[0].run_id, RUN_1);
  assert.equal(result.messages[0].created_at, at(1).toISOString());
  assert.equal(result.last_seq, 8);
  assert.equal(result.next_cursor, null);
  assertTranscriptBacked(result, transcriptRows);
  assert.ok(pool.queries.some((query) => query.sql.includes('FROM transcript_rounds')));
  assert.ok(pool.queries.some((query) => query.sql.includes('ORDER BY seq DESC LIMIT $2')));
  // 契约 ④：锚点侧只读合成行的内容（助手/用户正文无证据则留空，不取 messages.content 兜底）。
  assert.match(
    pool.queries.find((query) => query.sql.includes('ORDER BY seq DESC LIMIT $2')).sql,
    /CASE WHEN synthetic THEN content END AS content/,
  );
  assert.match(
    pool.queries.find((query) => query.sql.includes('FROM transcript_rounds')).sql,
    /SELECT run_id, round, dedup_key, record, created_at/,
  );
});

test('projection prefers transcript evidence and leaves missing user content empty', async () => {
  const assistant = message('a1', 1, 'assistant', 'stale anchor text', RUN_1);
  const legacy = message('legacy', 2, 'user', 'legacy-only text', LEGACY_RUN);
  const pool = new SessionViewPool({
    anchors: [assistant, legacy],
    transcriptRows: [
      transcript(7, `${RUN_1}:engine:round:7`, {
        roundKey: `${RUN_1}:round:7`,
        dedupKey: `${RUN_1}:engine:round:7`,
        messages: [{ role: 'assistant', content: text('from final assistant message') }],
      }, at(3)),
    ],
  });

  const result = await getSession(pool, { userId: USER_ID, sessionId: SESSION_ID, limit: 20 });
  assert.equal(result.messages[0].content, 'from final assistant message');
  assert.equal(result.messages[1].content, '');
});

test('run-id legacy rows, session-key rows, and mixed rows project identically to their anchors', async () => {
  const legacyAnchors = [
    message('legacy-m1', 1, 'user', 'legacy first request', RUN_1),
    message('legacy-a1', 2, 'assistant', 'legacy first final', RUN_1),
    message('legacy-m2', 3, 'user', 'legacy second request', RUN_2),
    message('legacy-a2', 4, 'assistant', 'legacy second final', RUN_2),
  ];
  const legacyRows = [
    transcript(0, null, {
      messages: [{ role: 'user', content: text('legacy first request') }],
    }, at(1), RUN_1),
    transcript(0, null, {
      messages: [{ role: 'user', content: text('legacy second request') }],
    }, at(2), RUN_2),
    transcript(1, null, {
      response: { content: text('legacy first intermediate') },
      messages: [{ role: 'assistant', content: text('legacy first intermediate') }],
    }, at(3), RUN_1),
    transcript(1, null, {
      response: { content: text('legacy first final') },
      messages: [{ role: 'assistant', content: text('legacy first final') }],
    }, at(4), RUN_1),
    transcript(1, null, {
      response: { content: text('legacy second final') },
      messages: [{ role: 'assistant', content: text('legacy second final') }],
    }, at(5), RUN_2),
  ];

  const newAnchors = [
    message('new-m1', 1, 'user', 'new first request', RUN_1),
    message('new-a1', 2, 'assistant', 'new first final', RUN_1),
    message('new-m2', 3, 'user', 'new second request', RUN_2),
    message('new-a2', 4, 'assistant', 'new second final', RUN_2),
  ];
  const newRows = [
    transcript(0, `${NEW_SESSION_ID}:input:new-m1`, {
      roundKey: `${NEW_SESSION_ID}:input:new-m1`,
      dedupKey: `${NEW_SESSION_ID}:input:new-m1`,
      messages: [{ role: 'user', content: text('new first request') }],
    }, at(1)),
    transcript(1, `${NEW_SESSION_ID}:engine:round:1`, {
      roundKey: `${NEW_SESSION_ID}:round:1`,
      dedupKey: `${NEW_SESSION_ID}:engine:round:1`,
      response: { content: text('new first final') },
    }, at(2)),
    transcript(1, `${NEW_SESSION_ID}:input:new-m2`, {
      roundKey: `${NEW_SESSION_ID}:input:new-m2`,
      dedupKey: `${NEW_SESSION_ID}:input:new-m2`,
      messages: [{ role: 'user', content: text('new second request') }],
    }, at(3)),
    transcript(2, `${NEW_SESSION_ID}:engine:round:2`, {
      roundKey: `${NEW_SESSION_ID}:round:2`,
      dedupKey: `${NEW_SESSION_ID}:engine:round:2`,
      response: { content: text('new second final') },
    }, at(4)),
  ];

  const mixedAnchors = [
    message('mixed-old-m', 1, 'user', 'mixed legacy request', RUN_1),
    message('mixed-old-a', 2, 'assistant', 'mixed legacy final', RUN_1),
    message('mixed-new-m', 3, 'user', 'mixed new request', RUN_2),
    message('mixed-judge', 4, 'user', 'synthetic anchor text', RUN_2, { synthetic: true }),
    message('mixed-new-a', 5, 'assistant', 'mixed new final', RUN_2),
  ];
  const mixedRows = [
    transcript(0, null, {
      messages: [{ role: 'user', content: text('mixed legacy request') }],
    }, at(1), RUN_1),
    transcript(0, `${MIXED_SESSION_ID}:input:mixed-new-m`, {
      roundKey: `${MIXED_SESSION_ID}:input:mixed-new-m`,
      dedupKey: `${MIXED_SESSION_ID}:input:mixed-new-m`,
      messages: [{ role: 'user', content: text('mixed new request') }],
    }, at(2)),
    transcript(1, null, {
      response: { content: text('mixed legacy final') },
    }, at(3), RUN_1),
    transcript(1, `${MIXED_SESSION_ID}:engine:round:1`, {
      roundKey: `${MIXED_SESSION_ID}:round:1`,
      dedupKey: `${MIXED_SESSION_ID}:engine:round:1`,
      response: { content: text('mixed new final') },
    }, at(4)),
  ];

  const cases = [
    { sessionId: LEGACY_SESSION_ID, anchors: legacyAnchors, transcriptRows: legacyRows },
    { sessionId: NEW_SESSION_ID, anchors: newAnchors, transcriptRows: newRows },
    { sessionId: MIXED_SESSION_ID, anchors: mixedAnchors, transcriptRows: mixedRows },
  ];
  assert.ok(legacyRows.every((row) => (
    row.run_id !== null
    && row.dedup_key === null
    && !('dedupKey' in row.record)
    && !('roundKey' in row.record)
  )));
  assert.ok(
    new Set(legacyRows.map((row) => row.round)).size < legacyRows.length,
    'legacy rows include duplicate rounds',
  );
  assert.ok(newRows.every((row) => row.run_id === null && row.dedup_key !== null));
  assert.ok(mixedRows.some((row) => row.run_id !== null && row.dedup_key === null));
  assert.ok(mixedRows.some((row) => row.run_id === null && row.dedup_key !== null));
  for (const { sessionId, anchors, transcriptRows } of cases) {
    const pool = new SessionViewPool({ sessionId, anchors, transcriptRows });
    const result = await getSession(pool, { userId: USER_ID, sessionId, limit: 100 });
    const projected = new Map(result.messages.map((row) => [row.id, row]));
    for (const anchor of anchors.filter((candidate) => candidate.synthetic !== true)) {
      assert.equal(
        projected.get(anchor.id).content,
        anchor.content,
        `projection for ${sessionId}/${anchor.id} matches transcript-backed anchor`,
      );
    }
    for (const anchor of anchors.filter((candidate) => candidate.synthetic === true)) {
      assert.equal(projected.get(anchor.id).content, anchor.content);
    }
  }
});

test('legacy run snapshot claims its previous-turn user and leaves current unmatched anchor empty', async () => {
  const previousText = 'the previous turn user message';
  const currentText = 'the current turn is missing from the snapshot';
  const snapshotMessages = [
    { role: 'user', content: text('session opening task') },
    ...Array.from({ length: 17 }, (_, index) => ({
      role: 'assistant',
      content: text(`recovered history message ${index + 1}`),
    })),
    { role: 'user', content: text(previousText) },
  ];
  const anchors = [
    message('previous-user', 1, 'user', previousText, RUN_1),
    message('current-user', 3, 'user', currentText, RUN_2),
  ];
  const transcriptRows = [
    transcript(0, null, { messages: snapshotMessages }, at(4), RUN_2),
  ];
  const pool = new SessionViewPool({ anchors, transcriptRows });

  const result = await getSession(pool, {
    userId: USER_ID,
    sessionId: SESSION_ID,
    limit: 20,
  });
  const projected = new Map(result.messages.map((row) => [row.id, row]));

  assert.equal(snapshotMessages.length, 19);
  assert.equal(snapshotMessages[0].content[0].text, 'session opening task');
  assert.equal(snapshotMessages.at(-1).content[0].text, previousText);
  assert.equal(transcriptRows.some((row) => row.run_id === RUN_1), false);
  assert.equal(projected.get('previous-user').content, previousText);
  assert.equal(projected.get('current-user').content, '');
});

test('users missing their own rows are recovered from later run snapshots by exact text', async () => {
  const anchors = [
    message('crashed-a', 1, 'user', 'crashed turn alpha', RUN_1),
    message('crashed-b', 2, 'user', 'crashed turn beta', RUN_2),
    message('crashed-c', 3, 'user', 'crashed turn gamma', RUN_4),
    message('current-d', 4, 'user', 'unpersisted current turn', LEGACY_RUN),
  ];
  const snapshotRunIds = [
    '40000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000003',
  ];
  const transcriptRows = [
    transcript(0, null, {
      messages: [
        { role: 'user', content: text('session opening task') },
        { role: 'user', content: text('crashed turn alpha') },
      ],
    }, at(1), snapshotRunIds[0]),
    transcript(0, null, {
      messages: [
        { role: 'user', content: text('crashed turn alpha') },
        { role: 'user', content: text('crashed turn beta') },
      ],
    }, at(2), snapshotRunIds[1]),
    transcript(0, null, {
      messages: [
        { role: 'user', content: text('crashed turn beta') },
        { role: 'user', content: text('crashed turn gamma') },
      ],
    }, at(3), snapshotRunIds[2]),
  ];
  const pool = new SessionViewPool({ anchors, transcriptRows });

  const result = await getSession(pool, {
    userId: USER_ID,
    sessionId: SESSION_ID,
    limit: 20,
  });
  const projected = new Map(result.messages.map((row) => [row.id, row]));

  for (const anchor of anchors) {
    assert.equal(
      transcriptRows.some((row) => row.run_id === anchor.run_id),
      false,
      `${anchor.id} has no transcript row for its own run`,
    );
  }
  assert.equal(projected.get('crashed-a').content, 'crashed turn alpha');
  assert.equal(projected.get('crashed-b').content, 'crashed turn beta');
  assert.equal(projected.get('crashed-c').content, 'crashed turn gamma');
  assert.equal(projected.get('current-d').content, '');
});

test('a historical snapshot claims every matching user message in record order without guessing', async () => {
  const anchors = [
    message('intro-user', 1, 'user', '用一句话介绍你自己。', RUN_1),
    message('ok-user', 2, 'user', '你好，请回复 ok', RUN_2),
    message('verify-user', 3, 'user', '做个最简单的验证：回复 done', RUN_4),
    message('fourth-user', 4, 'user', 'another recovered turn', LEGACY_RUN),
    message('missing-user', 5, 'user', 'this text is absent from the snapshot', RUN_1),
  ];
  const transcriptRows = [
    transcript(19, null, {
      messages: [
        { role: 'user', content: text('session opening turn with no anchor') },
        { role: 'assistant', content: text('earlier assistant response') },
        { role: 'user', content: text('你好，请回复 ok') },
        { role: 'user', content: text('做个最简单的验证：回复 done') },
        { role: 'assistant', content: text('verification recorded') },
        { role: 'user', content: text('用一句话介绍你自己。') },
        { role: 'user', content: text('another recovered turn') },
      ],
    }, at(5), '40000000-0000-4000-8000-000000000009'),
  ];
  const pool = new SessionViewPool({ anchors, transcriptRows });

  const result = await getSession(pool, {
    userId: USER_ID,
    sessionId: SESSION_ID,
    limit: 20,
  });
  const projected = new Map(result.messages.map((row) => [row.id, row]));

  assert.equal(transcriptRows.length, 1, 'these user turns have no individual transcript rows');
  assert.deepEqual(
    anchors.map((anchor) => projected.get(anchor.id).content),
    [
      '用一句话介绍你自己。',
      '你好，请回复 ok',
      '做个最简单的验证：回复 done',
      'another recovered turn',
      '',
    ],
  );
  assertTranscriptBacked(result, transcriptRows);
});

test('input message IDs take precedence over content matching', async () => {
  const anchors = [
    message('input-target', 1, 'user', 'stale anchor text', RUN_1),
    message('text-collision', 2, 'user', 'authoritative input text', RUN_2),
  ];
  const transcriptRows = [
    transcript(0, `${SESSION_ID}:input:input-target`, {
      dedupKey: `${SESSION_ID}:input:input-target`,
      messages: [{ role: 'user', content: text('authoritative input text') }],
    }, at(1)),
  ];
  const pool = new SessionViewPool({ anchors, transcriptRows });

  const result = await getSession(pool, {
    userId: USER_ID,
    sessionId: SESSION_ID,
    limit: 20,
  });
  const projected = new Map(result.messages.map((row) => [row.id, row]));

  assert.equal(projected.get('input-target').content, 'authoritative input text');
  assert.equal(projected.get('text-collision').content, '', 'an input ID does not lend its text to another anchor');
  assertTranscriptBacked(result, transcriptRows);
});

test('content matching takes duplicate texts in seq order and claims each anchor once across snapshots', async () => {
  const anchors = [
    message('first-repeat', 1, 'user', 'repeated request', RUN_1),
    message('second-repeat', 2, 'user', 'repeated request', RUN_2),
  ];
  const transcriptRows = [
    transcript(0, null, {
      messages: [{ role: 'user', content: text('repeated request') }],
    }, at(1)),
    transcript(1, null, {
      messages: [
        { role: 'user', content: text('repeated request') },
        { role: 'user', content: text('repeated request') },
      ],
    }, at(2), RUN_4),
    transcript(2, null, {
      messages: [{ role: 'user', content: text('repeated request') }],
    }, at(3), LEGACY_RUN),
  ];
  const pool = new SessionViewPool({ anchors, transcriptRows });

  const result = await getSession(pool, {
    userId: USER_ID,
    sessionId: SESSION_ID,
    limit: 20,
  });
  const projected = new Map(result.messages.map((row) => [row.id, row]));

  assert.equal(projected.get('first-repeat').content, 'repeated request');
  assert.equal(projected.get('second-repeat').content, 'repeated request');
});

test('legacy row, seed, input row, and a transcript-less crashed run map without time guessing', async () => {
  const crashRun = RUN_2;
  const anchors = [
    message('first-user', 1, 'user', 'first task', RUN_1, { createdAt: at(1) }),
    message('first-assistant', 2, 'assistant', 'first answer', RUN_1, { createdAt: at(2) }),
    message('crashed-user', 3, 'user', 'please answer me in English.', crashRun, { createdAt: at(2) }),
    message('input-user', 4, 'user', 'hello', RUN_4, { createdAt: at(6) }),
    message('input-assistant', 5, 'assistant', 'hello response', RUN_4, { createdAt: at(7) }),
  ];
  const transcriptRows = [
    transcript(0, null, {
      messages: [{ role: 'user', content: text('first task') }],
    }, at(1), RUN_1),
    transcript(0, `${MIXED_SESSION_ID}:engine:round:0:seed`, {
      roundKey: `${MIXED_SESSION_ID}:round:0`,
      dedupKey: `${MIXED_SESSION_ID}:engine:round:0:seed`,
      messages: [{ role: 'user', content: text('first task') }],
    }, at(3)),
    transcript(1, null, {
      response: { content: text('first answer') },
    }, at(4), RUN_1),
    transcript(8, `${MIXED_SESSION_ID}:input:input-user`, {
      roundKey: `${MIXED_SESSION_ID}:input:input-user`,
      dedupKey: `${MIXED_SESSION_ID}:input:input-user`,
      messages: [{ role: 'user', content: text('hello') }],
    }, at(5)),
    transcript(9, `${MIXED_SESSION_ID}:engine:round:9`, {
      roundKey: `${MIXED_SESSION_ID}:round:9`,
      dedupKey: `${MIXED_SESSION_ID}:engine:round:9`,
      response: { content: text('hello response') },
    }, at(6)),
  ];
  const pool = new SessionViewPool({
    sessionId: MIXED_SESSION_ID,
    anchors,
    transcriptRows,
  });

  const result = await getSession(pool, {
    userId: USER_ID,
    sessionId: MIXED_SESSION_ID,
    limit: 100,
  });
  const projected = new Map(result.messages.map((row) => [row.id, row]));

  assert.equal(transcriptRows.some((row) => row.run_id === crashRun), false, 'crashed run has no transcript rows');
  assert.equal(projected.get('first-user').content, 'first task', 'legacy run row owns the first anchor');
  assert.equal(projected.get('crashed-user').content, '', 'transcript-less non-synthetic anchor stays empty');
  assert.equal(projected.get('input-user').content, 'hello', 'input key maps by message ID');
  for (const anchor of anchors.filter((candidate) => candidate.id !== 'crashed-user')) {
    assert.equal(
      projected.get(anchor.id).content,
      anchor.content,
      `projection for ${anchor.id} matches its anchor text`,
    );
  }
});

test('seed claims the first unmatched exact-text anchor only once', async () => {
  const anchors = [
    message('first-match', 1, 'user', 'repeated request', RUN_1, { createdAt: at(1) }),
    message('second-match', 2, 'user', 'repeated request', RUN_2, { createdAt: at(2) }),
  ];
  const transcriptRows = [
    transcript(0, `${NEW_SESSION_ID}:engine:round:0:seed`, {
      dedupKey: `${NEW_SESSION_ID}:engine:round:0:seed`,
      messages: [{ role: 'user', content: text('repeated request') }],
    }, at(3)),
    transcript(1, `${NEW_SESSION_ID}:input:first-match`, {
      dedupKey: `${NEW_SESSION_ID}:input:first-match`,
      messages: [{ role: 'user', content: text('duplicate input must not overwrite') }],
    }, at(4)),
  ];
  const pool = new SessionViewPool({
    sessionId: NEW_SESSION_ID,
    anchors,
    transcriptRows,
  });

  const result = await getSession(pool, {
    userId: USER_ID,
    sessionId: NEW_SESSION_ID,
    limit: 20,
  });
  const projected = new Map(result.messages.map((row) => [row.id, row]));

  assert.equal(projected.get('first-match').content, 'repeated request');
  assert.equal(projected.get('second-match').content, '', 'only one matching user text exists in the transcript');
});

test('single-run session rounds project assistant text before a backfilled input row', async () => {
  const anchors = [
    message('backfilled-user', 1, 'user', 'the request', RUN_1),
    message('backfilled-assistant', 2, 'assistant', 'stale assistant anchor', RUN_1),
  ];
  const transcriptRows = [
    transcript(1, `${SESSION_ID}:engine:round:1`, {
      response: { content: text('intermediate answer') },
    }, at(1)),
    transcript(16, `${SESSION_ID}:engine:round:16`, {
      response: { content: text('final assistant answer') },
    }, at(2)),
    transcript(17, `${SESSION_ID}:input:backfilled-user`, {
      dedupKey: `${SESSION_ID}:input:backfilled-user`,
      messages: [{ role: 'user', content: text('the request') }],
    }, at(50)),
  ];
  const pool = new SessionViewPool({ anchors, transcriptRows });

  const result = await getSession(pool, { userId: USER_ID, sessionId: SESSION_ID, limit: 20 });
  const projected = new Map(result.messages.map((row) => [row.id, row]));

  assert.ok(transcriptRows[2].round > transcriptRows[1].round);
  assert.ok(transcriptRows[2].created_at > transcriptRows[1].created_at);
  assert.equal(projected.get('backfilled-assistant').content, 'final assistant answer');
});

test('session-scoped rounds remain unattributed when multiple runs have no input rows', async () => {
  const anchors = [
    message('run-one-assistant', 1, 'assistant', 'stale run one text', RUN_1),
    message('run-two-assistant', 2, 'assistant', 'stale run two text', RUN_2),
  ];
  const pool = new SessionViewPool({
    anchors,
    transcriptRows: [
      transcript(1, `${SESSION_ID}:engine:round:1`, {
        response: { content: text('unassigned answer one') },
      }, at(1)),
      transcript(2, `${SESSION_ID}:engine:round:2`, {
        response: { content: text('unassigned answer two') },
      }, at(2)),
    ],
  });

  const result = await getSession(pool, { userId: USER_ID, sessionId: SESSION_ID, limit: 20 });

  assert.deepEqual(result.messages.map((row) => row.content), ['', '']);
});

test('transcript rows without a run ID or key remain unattributed; unmatched anchors stay empty', async () => {
  const anchors = [
    message('unattributed-user', 1, 'user', 'user anchor fallback', RUN_4),
    message('unattributed-assistant', 2, 'assistant', 'assistant anchor fallback', RUN_4),
  ];
  const pool = new SessionViewPool({
    anchors,
    transcriptRows: [
      transcript(0, null, {
        messages: [{ role: 'user', content: text('guessed user text') }],
      }, at(1)),
      transcript(1, null, {
        response: { content: text('guessed assistant text') },
      }, at(2)),
    ],
  });

  const result = await getSession(pool, { userId: USER_ID, sessionId: SESSION_ID, limit: 20 });
  assert.deepEqual(result.messages.map((row) => row.content), [
    '',
    '',
  ]);
});

test('session without transcript rows leaves non-synthetic message content empty', async () => {
  const anchors = [
    message('unprojected-user', 1, 'user', 'user anchor content', RUN_4),
    message('unprojected-assistant', 2, 'assistant', 'assistant anchor content', RUN_4),
    message('synthetic-user', 3, 'user', 'synthetic content', RUN_4, { synthetic: true }),
  ];
  const pool = new SessionViewPool({ anchors, transcriptRows: [] });

  const result = await getSession(pool, { userId: USER_ID, sessionId: SESSION_ID, limit: 20 });

  assert.deepEqual(result.messages.map((row) => row.content), [
    '',
    '',
    'synthetic content',
  ]);
});

test('projection uses transcript content when available', () => {
  const anchors = [
    message('evidenced-user', 1, 'user', 'stale user anchor', RUN_1),
    message('evidenced-assistant', 2, 'assistant', 'stale assistant anchor', RUN_1),
  ];
  const userAnchors = [{
    id: 'evidenced-user',
    run_id: RUN_1,
    seq: 1,
    synthetic: false,
    anchor_text: 'stale user anchor',
  }];
  const transcriptRows = [
    transcript(0, `${SESSION_ID}:input:evidenced-user`, {
      dedupKey: `${SESSION_ID}:input:evidenced-user`,
      messages: [{ role: 'user', content: text('authoritative transcript user') }],
    }, at(1)),
    transcript(1, `${RUN_1}:engine:round:1`, {
      roundKey: `${RUN_1}:round:1`,
      dedupKey: `${RUN_1}:engine:round:1`,
      messages: [{ role: 'assistant', content: text('authoritative transcript assistant') }],
    }, at(2)),
  ];

  const projection = projectSessionMessages({ sessionId: SESSION_ID, anchors, userAnchors, transcriptRows });

  assert.deepEqual(projection.map((row) => row.content), [
    'authoritative transcript user',
    'authoritative transcript assistant',
  ]);
});

test('projection leaves unmatched user and assistant anchors empty while retaining synthetic content', () => {
  const anchors = [
    message('missing-user', 1, 'user', 'user anchor fallback', RUN_1),
    message('missing-assistant', 2, 'assistant', 'assistant anchor fallback', RUN_1),
    message('synthetic-user', 3, 'user', 'synthetic anchor content', RUN_1, { synthetic: true }),
  ];
  const userAnchors = [{
    id: 'missing-user',
    run_id: RUN_1,
    seq: 1,
    synthetic: false,
    anchor_text: 'user anchor fallback',
  }, {
    id: 'synthetic-user',
    run_id: RUN_1,
    seq: 3,
    synthetic: true,
    anchor_text: 'synthetic anchor content',
  }];

  const projection = projectSessionMessages({
    sessionId: SESSION_ID,
    anchors,
    userAnchors,
    transcriptRows: [],
  });

  assert.deepEqual(projection.map((row) => row.content), [
    '',
    '',
    'synthetic anchor content',
  ]);
});

test('message cursor still filters anchor rows before transcript projection', async () => {
  const { anchors, transcriptRows } = fixture();
  const pool = new SessionViewPool({ anchors, transcriptRows });

  const result = await getSession(pool, {
    userId: USER_ID,
    sessionId: SESSION_ID,
    limit: 2,
    messagesCursor: 5,
  });

  assert.deepEqual(result.messages.map((message) => message.seq), [3, 4]);
  // 锚点批次查询（排除 chat_sessions 主查询：#197 后它的内嵌子查询也含 "FROM messages"）。
  const anchorQuery = pool.queries.find((query) => query.sql.includes('FROM messages')
    && !query.sql.includes("role = 'user'")
    && !query.sql.includes('FROM chat_sessions s'));
  assert.deepEqual(anchorQuery.params, [SESSION_ID, 2, 5]);
  assert.equal(result.last_seq, 8);
});

test('metadata-only session read skips messages and transcript queries', async () => {
  const { anchors, transcriptRows } = fixture();
  const pool = new SessionViewPool({ anchors, transcriptRows });

  const result = await getSession(pool, {
    userId: USER_ID,
    sessionId: SESSION_ID,
    includeMessages: false,
  });

  assert.deepEqual(result.messages, []);
  assert.equal(result.last_seq, 8);
  // 排除 chat_sessions 主查询（#197 内嵌子查询字面含 FROM messages，但它不是独立的消息表往返）。
  assert.equal(pool.queries.some((query) => query.sql.includes('FROM messages')
    && !query.sql.includes('FROM chat_sessions s')), false);
  assert.equal(pool.queries.some((query) => query.sql.includes('FROM transcript_rounds')), false);
});

// ---------------------------------------------------------------------------
// issue #197（二）：会话 DTO 的 message_count（头部状态行消息数口径与列表 API 同源）。
// 断言写法照抄 sessions-list.test.js 同款：子查询内嵌在同一 SQL、无独立 COUNT 往返、Number 归一。
// ---------------------------------------------------------------------------

test('#197 getSession DTO：session.message_count 来自会话主查询内嵌子查询，零独立 COUNT 往返', async () => {
  const { anchors, transcriptRows } = fixture();
  const pool = new SessionViewPool({ anchors, transcriptRows });

  const result = await getSession(pool, { userId: USER_ID, sessionId: SESSION_ID, limit: 2 });

  const sessionQuery = pool.queries.find((query) => query.sql.includes('FROM chat_sessions s'));
  // 子查询与会话属主校验同一条 SQL（口径：messages 全量行数含 synthetic，与 listSessions.message_count 同源）
  assert.match(
    sessionQuery.sql,
    /\(SELECT COUNT\(\*\) FROM messages m WHERE m\.session_id = s\.id\) AS message_count/,
  );
  assert.equal(
    pool.queries.some((query) => /^\s*SELECT\s+COUNT/i.test(query.sql.trim())), false,
    '无独立 COUNT 往返查询（#197：message_count 为内嵌相关子查询，不是另发的 COUNT）',
  );
  // DTO 透传：主查询子查询列 → session.message_count（整数；分页窗口 limit=2 不影响总数）。
  assert.equal(result.session.message_count, 23);
  assert.equal(Number.isInteger(result.session.message_count), true,
    '整数（真实 pg 下 COUNT 为 bigint，映射层 Number() 归一）');
  assert.equal(result.messages.length, 2, 'messages 仍是分页窗口（本单不动分页行为）');
});

// ---------------------------------------------------------------------------
// P3 PR②b：读侧已换用上游官方投影 `projectTranscriptForDisplay`（erix-agent 0.15.0，上游 #95）。
// 以下用例断言的是**官方投影的展示规则在我们 DTO 上的可观测结果**——自研推导若被重新引入就会失败。
// ---------------------------------------------------------------------------

test('official projection keeps reasoning out of the displayed answer text', () => {
  const anchors = [
    message('reasoning-assistant', 1, 'assistant', 'stale anchor text', RUN_1),
  ];
  const transcriptRows = [
    transcript(1, `${RUN_1}:engine:round:1`, {
      dedupKey: `${RUN_1}:engine:round:1`,
      response: {
        content: [
          { type: 'reasoning', text: 'PRIVATE CHAIN OF THOUGHT' },
          { type: 'text', text: 'public answer' },
        ],
        stopReason: 'end_turn',
      },
    }, at(1)),
  ];

  const projection = projectSessionMessages({
    sessionId: SESSION_ID,
    anchors,
    userAnchors: [],
    transcriptRows,
  });

  assert.equal(projection[0].content, 'public answer');
  assert.equal(projection[0].content.includes('PRIVATE CHAIN OF THOUGHT'), false);
});

test('folded rounds render the official summary and range, never foldedPayload raw content', () => {
  const anchors = [
    message('folded-assistant', 1, 'assistant', 'stale anchor text', RUN_1),
  ];
  const transcriptRows = [
    transcript(9, `${RUN_1}:engine:round:9`, {
      dedupKey: `${RUN_1}:engine:round:9`,
      round: 9,
      folded: true,
      foldedRoundRange: { from: 1, to: 5 },
      summary: { action: '调研代码', note: '定位到 store 层' },
      navigationRecord: { roundFrom: 1, roundTo: 5, artifacts: [{ path: 'a.txt' }, { path: 'b.txt' }] },
      foldedPayload: [{ role: 'user', content: text('RAW FOLDED PAYLOAD MUST NOT BE RENDERED') }],
    }, at(1)),
  ];

  const projection = projectSessionMessages({
    sessionId: SESSION_ID,
    anchors,
    userAnchors: [],
    transcriptRows,
  });

  const content = projection[0].content;
  assert.match(content, /早期第 1–5 轮已折叠/);
  assert.match(content, /调研代码/);
  assert.match(content, /2 个归档产物/);
  assert.equal(content.includes('RAW FOLDED PAYLOAD MUST NOT BE RENDERED'), false);
});

test('a folded round still shows its own historical answer in preference to the fold summary', () => {
  const anchors = [
    message('folded-final-assistant', 1, 'assistant', 'stale anchor text', RUN_1),
  ];
  const transcriptRows = [
    transcript(4, `${RUN_1}:engine:round:4`, {
      dedupKey: `${RUN_1}:engine:round:4`,
      folded: true,
      foldedRoundRange: { from: 1, to: 3 },
      foldedPayload: [{ role: 'user', content: text('RAW FOLDED PAYLOAD MUST NOT BE RENDERED') }],
      response: { content: text('historical answer of the folded round'), stopReason: 'end_turn' },
    }, at(1)),
  ];

  const projection = projectSessionMessages({
    sessionId: SESSION_ID,
    anchors,
    userAnchors: [],
    transcriptRows,
  });

  assert.equal(projection[0].content, 'historical answer of the folded round');
});

test('user anchors map by meta.dedupKey even when the DB dedup_key column is null', () => {
  const anchors = [
    message('record-keyed', 1, 'user', 'stale anchor text', RUN_1),
    message('text-twin', 2, 'user', 'transcript input text', RUN_2),
  ];
  const transcriptRows = [
    // dedup_key 列为 NULL，但 record.dedupKey 带着 `<sessionId>:input:<messageId>` → 仍走精确映射。
    transcript(3, null, {
      dedupKey: `${SESSION_ID}:input:record-keyed`,
      messages: [{ role: 'user', content: text('transcript input text') }],
    }, at(1)),
  ];

  const projection = projectSessionMessages({
    sessionId: SESSION_ID,
    anchors,
    userAnchors: anchors.map(({ id, run_id, seq, synthetic, content }) => ({
      id, run_id, seq, synthetic, anchor_text: content,
    })),
    transcriptRows,
  });

  assert.equal(projection[0].content, 'transcript input text', 'mapped by meta.dedupKey');
  assert.equal(projection[1].content, '', 'content matching is not consulted once meta.dedupKey resolves');
});

test('engine-injected synthetic turns never claim a real user anchor', () => {
  const anchors = [
    message('real-user', 1, 'user', 'same injected text', RUN_1),
  ];
  const transcriptRows = [
    transcript(2, `${SESSION_ID}:engine:round:2`, {
      dedupKey: `${SESSION_ID}:engine:round:2`,
      messages: [{
        role: 'user',
        content: text('same injected text'),
        meta: { source: 'judge-control' },
      }],
    }, at(1)),
  ];

  const projection = projectSessionMessages({
    sessionId: SESSION_ID,
    anchors,
    userAnchors: [{
      id: 'real-user', run_id: RUN_1, seq: 1, synthetic: false, anchor_text: 'same injected text',
    }],
    transcriptRows,
  });

  assert.equal(projection[0].content, '', 'meta.synthetic turns are labelled by the projection and excluded');
});

test('tool-call rounds contribute no answer text and leave the anchor empty', () => {
  const anchors = [
    message('tool-only-assistant', 1, 'assistant', 'stale anchor text', RUN_1),
  ];
  const transcriptRows = [
    transcript(1, `${SESSION_ID}:engine:round:1`, {
      dedupKey: `${SESSION_ID}:engine:round:1`,
      response: {
        content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'src/a.js' } }],
        stopReason: 'tool_use',
      },
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'RAW TOOL OUTPUT' }],
      }],
    }, at(1)),
  ];

  const projection = projectSessionMessages({
    sessionId: SESSION_ID,
    anchors,
    userAnchors: [],
    transcriptRows,
  });

  assert.deepEqual(projection.map((row) => row.content), ['']);
});

test('a resumed seed record keeps the engine fold summary out of the user bubble', () => {
  const FOLD_MARK = '【上下文折叠·v1·erix-9f6e2c】';
  const anchors = [
    message('seed-user', 1, 'user', '我的问题是：帮我修一下登录。', RUN_1),
  ];
  const transcriptRows = [
    transcript(0, `${SESSION_ID}:input:seed-user`, {
      dedupKey: `${SESSION_ID}:input:seed-user`,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `${FOLD_MARK}早期第 1–3 轮（共 3 轮）已折叠。工具足迹：read×2。` },
          { type: 'text', text: '我的问题是：帮我修一下登录。' },
        ],
      }],
    }, at(1)),
  ];

  const projection = projectSessionMessages({
    sessionId: SESSION_ID,
    anchors,
    userAnchors: [{ id: 'seed-user', run_id: RUN_1, seq: 1, synthetic: false, anchor_text: '我的问题是：帮我修一下登录。' }],
    transcriptRows,
  });

  assert.equal(
    projection[0].content,
    '我的问题是：帮我修一下登录。',
    'the projection splits the fold summary into its own system turn instead of the user text',
  );
});

test('the projection is fed records in (round, created_at) order — per-row calls match the whole-store call', () => {
  const { transcriptRows } = fixture();
  const ordered = [...transcriptRows].sort((a, b) => (a.round - b.round) || (a.created_at - b.created_at));
  const whole = projectTranscriptForDisplay(ordered.map((row) => row.record));
  const perRow = ordered.flatMap((row) => projectTranscriptForDisplay([row.record]));

  assert.deepEqual(perRow.map(({ role, text, round }) => ({ role, text, round })),
    whole.map(({ role, text, round }) => ({ role, text, round })),
    '行级调用与整表调用产出同一展示序列（投影是逐记录展开的纯函数）');
});

// ---------------------------------------------------------------------------
// issue #188：投影的展示字段（toolCalls/reasoning/blocks）随助手锚点透传进对话流 DTO。
// 只透传、不重推导/不裁剪/不改名（#95 红线）；有则出现、无则不写该键。
// ---------------------------------------------------------------------------

test('issue #188: projection toolCalls/reasoning/blocks ride along the assistant DTO verbatim', () => {
  const anchors = [
    message('tool-assistant', 2, 'assistant', 'stale anchor text', RUN_1),
  ];
  const assistantBlocks = [
    { type: 'reasoning', text: 'think about it' },
    { type: 'text', text: 'public answer' },
    { type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'src/a.js' } },
  ];
  const transcriptRows = [
    transcript(1, `${RUN_1}:engine:round:1`, {
      dedupKey: `${RUN_1}:engine:round:1`,
      response: { content: assistantBlocks, stopReason: 'tool_use' },
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: 'call-1', content: 'FILE BODY',
          is_error: false, executionStatus: 'succeeded',
        }],
      }],
    }, at(1), RUN_1),
  ];

  const projection = projectSessionMessages({
    sessionId: SESSION_ID,
    anchors,
    userAnchors: [],
    transcriptRows,
  });
  const dto = projection[0];

  assert.equal(dto.content, 'public answer');
  assert.equal(dto.reasoning, 'think about it');
  assert.deepEqual(dto.toolCalls, [{
    key: '1#0:0:t0',
    name: 'read',
    id: 'call-1',
    argsSummary: 'path=src/a.js',
    resultPreview: 'FILE BODY',
    isError: false,
    executionStatus: 'succeeded',
  }], 'toolCalls 逐字透传（含 0.16.0 视图键 key 与上游预览字段，不裁剪）');
  assert.deepEqual(dto.blocks, assistantBlocks, 'blocks 逐字透传（原始 content blocks）');
  assert.deepEqual(dto.turnKeys, ['1#0:0'], '0.16.0 轮级视图键 turn.key 逐字透传');
});

test('issue #188: a run aggregates toolCalls across its rounds in projection order', () => {
  const anchors = [message('multi-assistant', 2, 'assistant', 'stale anchor text', RUN_1)];
  const transcriptRows = [
    transcript(1, `${RUN_1}:engine:round:1`, {
      dedupKey: `${RUN_1}:engine:round:1`,
      response: {
        content: [{ type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a' } }],
        stopReason: 'tool_use',
      },
    }, at(1), RUN_1),
    transcript(2, `${RUN_1}:engine:round:2`, {
      dedupKey: `${RUN_1}:engine:round:2`,
      response: {
        content: [
          { type: 'tool_use', id: 'c2', name: 'bash', input: { command: 'ls' } },
          { type: 'text', text: 'done' },
        ],
        stopReason: 'end_turn',
      },
    }, at(2), RUN_1),
  ];

  const projection = projectSessionMessages({
    sessionId: SESSION_ID,
    anchors,
    userAnchors: [],
    transcriptRows,
  });
  const dto = projection[0];

  assert.equal(dto.content, 'done');
  assert.deepEqual(dto.toolCalls.map((call) => [call.name, call.id]), [['read', 'c1'], ['bash', 'c2']]);
  assert.deepEqual(dto.toolCalls.map((call) => call.key), ['1#0:0:t0', '2#0:0:t0'],
    'toolCalls[].key 按投影顺序（0.16.0 视图键）');
  assert.deepEqual(dto.turnKeys, ['1#0:0', '2#0:0'], 'turnKeys 聚合该 run 各轮的 turn.key');
});

test('issue #188: assistant DTO omits toolCalls/reasoning when the projection has none (0.16.0 turnKeys 恒在)', () => {
  const anchors = [message('plain-assistant', 2, 'assistant', 'stale anchor text', RUN_1)];
  const transcriptRows = [
    transcript(1, `${RUN_1}:engine:round:1`, {
      dedupKey: `${RUN_1}:engine:round:1`,
      response: { content: text('plain answer'), stopReason: 'end_turn' },
    }, at(1), RUN_1),
  ];

  const projection = projectSessionMessages({
    sessionId: SESSION_ID,
    anchors,
    userAnchors: [],
    transcriptRows,
  });
  const dto = projection[0];

  assert.equal(dto.content, 'plain answer');
  assert.equal('toolCalls' in dto, false, '无 toolCalls 时不出现该键（不塞 undefined/null 占位）');
  assert.equal('reasoning' in dto, false, '无 reasoning 时不出现该键');
  // 0.16.0：每条助手轮都有视图键 turn.key → turnKeys 恒在（逐字透传，非宿主自造）。
  assert.deepEqual(dto.turnKeys, ['1#0:0']);
  // blocks 是上游对每条带 content 的助手轮都会给的字段（这里是文本块）——有则原样透传。
  assert.deepEqual(dto.blocks, [{ type: 'text', text: 'plain answer' }]);
});

test('issue #188: textPreview-only assistant turns carry no blocks key (upstream gives none)', () => {
  const anchors = [message('preview-assistant', 2, 'assistant', 'stale anchor text', RUN_1)];
  const transcriptRows = [
    transcript(1, `${RUN_1}:engine:round:1`, {
      dedupKey: `${RUN_1}:engine:round:1`,
      textPreview: 'preview only',
    }, at(1), RUN_1),
  ];

  const projection = projectSessionMessages({
    sessionId: SESSION_ID,
    anchors,
    userAnchors: [],
    transcriptRows,
  });
  const dto = projection[0];

  assert.equal(dto.content, 'preview only');
  assert.equal('blocks' in dto, false, '上游 textPreview 兜底轮 blocks 为空数组 → 不写该键');
  assert.equal('toolCalls' in dto, false);
  assert.equal('reasoning' in dto, false);
});

test('issue #188: host-owned anchor metadata is untouched and user anchors carry no projection keys', async () => {
  const attachments = [{ kind: 'file', path: '/workspace/report.txt', name: 'report.txt' }];
  const anchors = [
    message('u1', 1, 'user', 'ask', RUN_1, { attachments, createdAt: at(1) }),
    message('a1', 2, 'assistant', 'stale anchor text', RUN_1, { createdAt: at(4) }),
  ];
  const transcriptRows = [
    transcript(0, `${SESSION_ID}:input:u1`, {
      dedupKey: `${SESSION_ID}:input:u1`,
      messages: [{ role: 'user', content: text('ask') }],
    }, at(2), RUN_1),
    transcript(1, `${RUN_1}:engine:round:1`, {
      dedupKey: `${RUN_1}:engine:round:1`,
      response: { content: text('answer'), stopReason: 'end_turn' },
    }, at(3), RUN_1),
  ];
  const pool = new SessionViewPool({ anchors, transcriptRows });

  const result = await getSession(pool, { userId: USER_ID, sessionId: SESSION_ID, limit: 100 });
  const [user, assistant] = result.messages;

  assert.deepEqual(user.attachments, attachments, 'attachments 语义不变');
  assert.equal(user.run_id, RUN_1);
  assert.equal(user.seq, 1);
  assert.equal('toolCalls' in user, false, 'user 锚点不透传投影字段');
  assert.equal(assistant.content, 'answer');
  assert.equal(assistant.run_id, RUN_1);
  assert.equal(assistant.seq, 2);
  assert.equal(assistant.synthetic, false);
  assert.equal(assistant.created_at, at(4).toISOString());
  assert.deepEqual(assistant.attachments, []);
});

// ---------------------------------------------------------------------------
// issue #189：折叠轮的 DTO 折叠标记（上游三元组逐字透传；正文行为不变）。
// ---------------------------------------------------------------------------

test('#189 折叠轮正文走折叠摘要兜底时，DTO 带 folded（foldedRoundRange/navigationRecord/foldedPayloadMessages 原名透传）', () => {
  const anchors = [
    message('folded-flag-assistant', 1, 'assistant', 'stale anchor text', RUN_1),
  ];
  const navigation = { roundFrom: 1, roundTo: 5, artifacts: [{ path: 'a.txt' }, { path: 'b.txt' }] };
  const transcriptRows = [
    transcript(9, `${RUN_1}:engine:round:9`, {
      dedupKey: `${RUN_1}:engine:round:9`,
      round: 9,
      folded: true,
      foldedRoundRange: { from: 1, to: 5 },
      summary: { action: '调研代码', note: '定位到 store 层' },
      navigationRecord: navigation,
      foldedPayload: [
        { role: 'user', content: text('raw one') },
        { role: 'assistant', content: text('raw two') },
      ],
    }, at(1)),
  ];

  const projection = projectSessionMessages({ sessionId: SESSION_ID, anchors, userAnchors: [], transcriptRows });

  assert.match(projection[0].content, /早期第 1–5 轮已折叠/, '正文行为不变：仍是官方折叠摘要');
  assert.deepEqual(projection[0].folded, {
    text: projection[0].content, // 折叠摘要原文（与 foldedTurnText 同源：即该折叠 turn 自己的 text）
    foldedRoundRange: { from: 1, to: 5 },
    navigationRecord: navigation,
    foldedPayloadMessages: 2,
    round: 9, // #189 收尾：该折叠行自己的 round（上游 turn.round 原名透传）
    // #390-A 新增键：本夹具的 `record.summary` 是 `{action,note}` 形态 ⇒ 有真摘要。这是**向后兼容的
    // 加键**（旧前端不读它照跑），但 deepEqual 要跟着走。
    hasSummary: true,
  }, 'text + 三元组 + round 逐字透传（上游原名、不改名、不重推导）');
  // 「查看原文」端点的 :round 是折叠行自己的 round，不是被折叠的轮范围：两者必须不同（本单存在的理由）。
  assert.equal(projection[0].folded.round, 9);
  assert.notEqual(projection[0].folded.round, projection[0].folded.foldedRoundRange.to, 'round ≠ range.to');
  assert.notEqual(projection[0].folded.round, projection[0].folded.foldedRoundRange.from, 'round ≠ range.from');
});

test('#189 修正：有折叠轮且该 run 有自己的助手正文 → DTO 仍带 folded（text + 三元组）；无折叠轮不带该键', () => {
  const anchors = [
    message('folded-own-answer', 1, 'assistant', 'stale anchor text', RUN_1),
    message('plain-answer', 2, 'assistant', 'stale anchor text', RUN_2),
  ];
  const transcriptRows = [
    transcript(4, `${RUN_1}:engine:round:4`, {
      dedupKey: `${RUN_1}:engine:round:4`,
      folded: true,
      foldedRoundRange: { from: 1, to: 3 },
      foldedPayload: [{ role: 'user', content: text('raw') }],
      response: { content: text('historical answer of the folded round'), stopReason: 'end_turn' },
    }, at(1), RUN_1),
    transcript(5, `${RUN_2}:engine:round:5`, {
      dedupKey: `${RUN_2}:engine:round:5`,
      response: { content: text('plain answer'), stopReason: 'end_turn' },
    }, at(2), RUN_2),
  ];

  const projection = projectSessionMessages({ sessionId: SESSION_ID, anchors, userAnchors: [], transcriptRows });

  assert.equal(projection[0].content, 'historical answer of the folded round', '正文仍优先自身历史答复（兜底行为不变）');
  const folded = projection[0].folded;
  assert.ok(folded, '只要有折叠轮就挂 folded（正文是该 run 自身助手正文时也必须出现）');
  assert.deepEqual(folded.foldedRoundRange, { from: 1, to: 3 }, '三元组原名透传');
  // #189 收尾：行号 = 该折叠 transcript 行自己的 round（该行 row.round=4），不是被折叠范围 1–3 的任何一端。
  assert.equal(folded.round, 4, 'round = 折叠行自己的 round（上游 turn.round）');
  assert.notEqual(folded.round, folded.foldedRoundRange.to);
  assert.notEqual(folded.round, folded.foldedRoundRange.from);
  assert.equal(typeof folded.text, 'string');
  assert.ok(folded.text !== '', 'text = 折叠 turn 的摘要原文（与 foldedTurnText 同源）');
  assert.notEqual(folded.text, projection[0].content, '标记里的原文不顶替正文');
  assert.equal(projection[1].content, 'plain answer');
  assert.equal('folded' in projection[1], false, '无折叠轮的 run 不带 folded 键');
});

// ---------------------------------------------------------------------------
// issue #283 → #299 → #303：对话流 DTO 的 `toolCalls[].durationMs`（**只有一个来源 = 引擎投影**；
// #299 时期的宿主回落已在 #303 退役，下面的用例都按新契约钉）。
// erix-agent 0.20.0（#284）起官方投影 `toolCalls[]` **自己就带** `durationMs`/`toolCallKey`
// （`erix.*` 的投影，见 `src/display/projection.js:167-181`），但 **T1 之前落盘的记录上两者直接
// 缺省、不被合成**。#299 定稿时投影缺省可回落**宿主**自家 `tool_calls`（按 `(run_id, call_id)` join）；
// ** #303 起该回落已退役**（引擎 0.34.0 不再写旧键 `duration`，宿主列不再是 DTO 的时长来源）
// ⇒ 现在**只有一个来源**：投影带的 `durationMs`；缺省 ⇒ **键不存在**（0.20.0 把「缺失」定义为
// 「不知道」，**绝不写 0**）。这段处理仍在投影**之后**做，但只剩「非有限脏值剥键」这一件
// 防御性收尾，不再补任何宿主值（#95 红线：宿主字段不得伪装成引擎给的）。
// ---------------------------------------------------------------------------

/** 一个 run、一个工具调用（provider call id = 'call-1'）的最小 transcript 现场。 */
/**
 * @param {number} [engineDurationMs] 给定时 = **T1 之后的新记录**（结果块带 `erix.durationMs`，
 *   引擎投影会把它带进 `toolCalls[].durationMs`）；不给 = T1 之前的老记录（只有顶层形状，投影不带时长）。
 */
function toolCallFixture(runId = RUN_1, callId = 'call-1', engineDurationMs = undefined) {
  const anchors = [message(`dur-assistant-${runId}`, 2, 'assistant', 'stale anchor text', runId)];
  const transcriptRows = [
    transcript(1, `${runId}:engine:round:1`, {
      dedupKey: `${runId}:engine:round:1`,
      response: {
        content: [{ type: 'tool_use', id: callId, name: 'shell', input: { command: 'sleep 5' } }],
        stopReason: 'tool_use',
      },
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: callId,
          content: 'exit_code: 0',
          is_error: false,
          // 0.20.0 的新记录：引擎事实住 `erix.*`（顶层 `duration` 已退役、不再写）
          ...(engineDurationMs === undefined ? {} : { erix: { toolCallKey: 'tc_000000000001', round: 1, durationMs: engineDurationMs, success: true } }),
        }],
      }],
    }, at(1), runId),
  ];
  return { anchors, transcriptRows };
}

const withoutDurationKey = (calls) => calls.map((call) => {
  const { durationMs, ...rest } = call;
  return rest;
});

test('issue #283/#303：时长只来自引擎投影的 erix.durationMs；投影缺省 ⇒ 键不出现（宿主 tool_calls 行不再参与、绝不写 0）', () => {
  // 新记录（引擎投影带 erix.durationMs）⇒ DTO 直接带该值，与宿主库无关。
  const fresh = toolCallFixture(RUN_1, 'call-1', 4321); // erix.durationMs = 4321
  const withValue = projectSessionMessages({
    sessionId: SESSION_ID, anchors: fresh.anchors, userAnchors: [], transcriptRows: fresh.transcriptRows,
  })[0];
  assert.equal(withValue.toolCalls[0].durationMs, 4321,
    '新记录：引擎投影带 erix.durationMs ⇒ DTO 直接带该值（时长只此一份来源）');

  // 老记录（无 erix ⇒ 投影直接缺省）⇒ 键不出现，无论宿主 tool_calls 行有没有值都不参与（#303）。
  const legacy = toolCallFixture(RUN_1, 'call-1');
  const project = (toolCallRows) => projectSessionMessages({
    sessionId: SESSION_ID, anchors: legacy.anchors, userAnchors: [], transcriptRows: legacy.transcriptRows, toolCallRows,
  })[0];
  const noRows = project(undefined);
  assert.equal('durationMs' in noRows.toolCalls[0], false, '投影缺省 ⇒ 键不出现');
  for (const rows of [
    undefined,
    [],
    [{ run_id: RUN_1, call_id: 'call-1', duration_ms: 4321 }], // 宿主有值也不再参与
    [{ run_id: RUN_1, call_id: 'call-1', duration_ms: null }],
    [{ run_id: RUN_1, call_id: 'other-call', duration_ms: 4321 }],
  ]) {
    const dto = project(rows);
    assert.equal('durationMs' in dto.toolCalls[0], false,
      `#303：投影缺省时宿主值不再参与 ⇒ 键不出现，实际=${JSON.stringify(dto.toolCalls[0])}`);
    assert.notEqual(dto.toolCalls[0].durationMs, 0, '把未知塌成 0 = #283 的「恒显 0s」复发');
    assert.deepEqual(withoutDurationKey(dto.toolCalls), noRows.toolCalls,
      '除投影自带的 durationMs 外，引擎投影字段一字不变');
  }
});

test('issue #283/#299/#303：时长只来自引擎投影——宿主 join 已退役，也不再就地改引擎对象', () => {
  const { transcriptRows } = toolCallFixture();
  // 直接问引擎：官方投影自己给出的形状（宿主未加工）里必须没有时长这个键。
  // 与产品代码同一口径逐行调用官方投影（`recordForProjection` 补 dedupKey → 纯函数展开）。
  const engineTurns = transcriptRows
    .flatMap((row) => projectTranscriptForDisplay([recordForProjection(row).record]));
  const engineCalls = engineTurns.flatMap((turn) => (Array.isArray(turn.toolCalls) ? turn.toolCalls : []));
  assert.ok(engineCalls.length > 0, '夹具必须让引擎投影产出 toolCalls');
  for (const call of engineCalls) {
    assert.equal('durationMs' in call, false,
      '投影只在结果块带 `erix.durationMs` 时才给时长，老记录（无 erix）上直接缺省（不合成）。'
      + '#303：宿主回落已删 ⇒ 投影缺省就是未知，不再从宿主 `tool_calls` 补值。');
  }

  const { anchors } = toolCallFixture();
  const dto = projectSessionMessages({
    sessionId: SESSION_ID,
    anchors,
    userAnchors: [],
    transcriptRows,
    toolCallRows: [{ run_id: RUN_1, call_id: 'call-1', duration_ms: 999 }], // 宿主行：#303 后不再参与
  })[0];
  assert.equal('durationMs' in dto.toolCalls[0], false, '#303：投影缺省时即使宿主行有值也不参与 ⇒ DTO 无该键');
  assert.deepEqual(dto.toolCalls, engineCalls,
    '宿主行不参与 ⇒ DTO 的 toolCalls 与引擎投影逐字相同（不裁剪、不改名、不重推导、不添键）');
  for (const call of engineCalls) {
    assert.equal('durationMs' in call, false, '引擎产出的对象不带 durationMs（#303 后宿主不参与，键的有无只由引擎投影决定）')
  }
});

// ---- #299 (d) → #303：投影自带 durationMs 之后只剩两格（投影带值 / 投影缺省 ⇒ 键不存在），
//      宿主值不再参与 ----

test('#299 ①/#303：投影有值 ⇒ 时长即投影值（#303 后宿主值完全不再参与）', () => {
  const { anchors, transcriptRows } = toolCallFixture(RUN_1, 'call-1', 111); // 引擎 erix.durationMs=111
  const dto = projectSessionMessages({
    sessionId: SESSION_ID,
    anchors,
    userAnchors: [],
    transcriptRows,
    toolCallRows: [{ run_id: RUN_1, call_id: 'call-1', duration_ms: 999 }], // 宿主库里另一份，#303 后不参与
  })[0];
  assert.equal(dto.toolCalls[0].durationMs, 111,
    '时长只来自引擎投影（erix.durationMs）；宿主那一份不再参与，无论传什么都不影响结果');
  // 反向自证：把宿主值当判据的话这条会红（不是空操作）
  assert.notEqual(dto.toolCalls[0].durationMs, 999);
});

test('#303 清账（原 #299 ②）：投影缺省 ⇒ DTO 无 durationMs 键，宿主值不再参与（旧回落已退役，不是回归）', () => {
  const { anchors, transcriptRows } = toolCallFixture(RUN_1, 'call-1'); // 无 erix = 老记录
  const engineCalls = projectTranscriptForDisplay([recordForProjection(transcriptRows[0]).record])
    .flatMap((turn) => turn.toolCalls ?? []);
  assert.equal('durationMs' in engineCalls[0], false,
    '老记录上引擎投影**直接缺省**该键（不合成、不给 0）——这条红了就是上游改成「合成 0」，按 §2 报上游');
  const dto = projectSessionMessages({
    sessionId: SESSION_ID, anchors, userAnchors: [], transcriptRows,
    toolCallRows: [{ run_id: RUN_1, call_id: 'call-1', duration_ms: 777 }], // 宿主旧回落路径的值
  })[0];
  assert.equal('durationMs' in dto.toolCalls[0], false,
    '#303 清账：投影缺省 ⇒ DTO 无 durationMs 键（宿主 tool_calls 值不再参与）。'
    + '这条就是 #303 预告「红了才是对的信号」那一条：引擎侧旧键 duration 已退役'
    + '（tool-fact.js 旧键映射、orchestrator.js 落盘前 delete、run-snapshot-executor.js 注释明写），'
    + '宿主不再为老记录补时长 ⇒ 老对话的工具耗时渲染为「未知」（空白，不是报错）。若这条变红，说明有人把宿主 join 加回来了。');
  assert.notEqual(dto.toolCalls[0].durationMs, 0, '未知不能塌成 0');
});

test('#299 ③：投影与宿主**都缺** ⇒ DTO 里没有 durationMs 这个键（禁止写 0）', () => {
  const { anchors, transcriptRows } = toolCallFixture(RUN_1, 'call-1');
  for (const rows of [
    undefined,
    [],
    [{ run_id: RUN_1, call_id: 'call-1', duration_ms: null }],
    // 这些宿主行现在**应当被完全忽略**（join 已在 #303 退役）。本用例直接调 `projectSessionMessages`、
    // 不经 `SessionViewPool`，所以它们不是运行期绊线（真正的绊线是端点级那条守卫，下面单独有用例：
    // 谁再查 `tool_calls` 就当场 throw 指名报错）；这里留着只是**入参面**的哨兵：传不传、值还是 null
    // 都不许影响 DTO。
    [{ run_id: RUN_1, call_id: 'ghost-call', duration_ms: 42 }],
  ]) {
    const dto = projectSessionMessages({
      sessionId: SESSION_ID, anchors, userAnchors: [], transcriptRows, toolCallRows: rows,
    })[0];
    assert.equal('durationMs' in dto.toolCalls[0], false,
      `都缺时必须无键（0.20.0：缺失 = 不知道）；实际=${JSON.stringify(dto.toolCalls[0])}`);
    assert.notEqual(dto.toolCalls[0].durationMs, 0, '把未知塌成 0 = issue #283 的「恒显 0s」复发');
  }
});

test('#299 (c)：executionStatus 只在特殊状态存在 ⇒ 普通块的 DTO 不带该键、也不被当成异常', () => {
  const { anchors, transcriptRows } = toolCallFixture(RUN_1, 'call-1', 12);
  const dto = projectSessionMessages({
    sessionId: SESSION_ID, anchors, userAnchors: [], transcriptRows,
  })[0];
  assert.equal('executionStatus' in dto.toolCalls[0], false,
    '普通成功结果块上引擎**不写** executionStatus（guide-0.20.0 §7）⇒ DTO 也不许多造一个键');
  assert.equal(dto.toolCalls[0].isError, false, '普通块仍按 isError 正常判成成功（不是「值得关注」）');
  assert.equal(dto.toolCalls[0].toolCallKey, 'tc_000000000001',
    '0.20.0 投影新增的 toolCallKey 原样透传（本单不接进卡片身份，见 session-view.js 注释）');
});

test('issue #283/#303：宿主 join 已退役 ⇒ 同 call_id 跨 run 不再有 join 概念，时长只看各自投影', () => {
  const first = toolCallFixture(RUN_1);
  const second = toolCallFixture(RUN_2);
  const anchors = [...first.anchors, ...second.anchors];
  const transcriptRows = [...first.transcriptRows, ...second.transcriptRows];
  const projection = projectSessionMessages({
    sessionId: SESSION_ID,
    anchors,
    userAnchors: [],
    transcriptRows,
    // 以前靠 (run_id, call_id) 复合键 join 才不串号；#303 后宿主行完全不再参与。
    toolCallRows: [{ run_id: RUN_2, call_id: 'call-1', duration_ms: 777 }],
  });
  const byRun = new Map(projection.map((dto) => [dto.run_id, dto]));
  // 两个 run 的夹具都是老记录（无 erix）⇒ 两边都无键，宿主行不参与。
  assert.equal('durationMs' in byRun.get(RUN_2).toolCalls[0], false,
    '#303：宿主行有值也不再参与 ⇒ RUN_2 无 durationMs 键');
  assert.equal('durationMs' in byRun.get(RUN_1).toolCalls[0], false,
    'RUN_1 同样无键（不存在 join，也就不存在串号）');
});

test('issue #283/#303：GET /api/sessions/:id 端到端的 durationMs 只来自投影（不再取 tool_calls）', async () => {
  // 新记录：引擎投影带 erix.durationMs ⇒ getSession 产出的 DTO 直接带该值（全程不碰 tool_calls）。
  const fresh = toolCallFixture(RUN_1, 'call-1', 5021);
  const pool = new SessionViewPool({ anchors: fresh.anchors, transcriptRows: fresh.transcriptRows });
  const result = await getSession(pool, { userId: USER_ID, sessionId: SESSION_ID, limit: 100 });
  const dto = result.messages.find((row) => row.role === 'assistant');
  assert.equal(dto.toolCalls[0].durationMs, 5021, '新记录：时长从投影一路带到 DTO（数据源 = 引擎 erix.durationMs）');
  // #303：时长不再从宿主 tool_calls 取 ⇒ getSession 不应再发 FROM tool_calls 查询。
  assert.equal(pool.queries.some((query) => query.sql.includes('FROM tool_calls')), false,
    '#303：getSession 不再为时长去取 tool_calls（旧回落查询已删）');

  // 老记录（无 erix）⇒ 投影缺省 ⇒ 键不出现（也不写 0）；这是跨实例升级后的「未知」形态。
  const legacy = toolCallFixture(RUN_1, 'call-1');
  const legacyPool = new SessionViewPool({ anchors: legacy.anchors, transcriptRows: legacy.transcriptRows });
  const legacyResult = await getSession(legacyPool, { userId: USER_ID, sessionId: SESSION_ID, limit: 100 });
  const legacyDto = legacyResult.messages.find((row) => row.role === 'assistant');
  assert.equal('durationMs' in legacyDto.toolCalls[0], false, '老记录无 erix ⇒ 键不出现（#303：不回落宿主值）');
});

test('issue #283/#303：getSession 无论 includeMessages 与否都不取 tool_calls（旧回落查询已删）', async () => {
  const { anchors, transcriptRows } = toolCallFixture(RUN_1, 'call-1', 5);
  const poolWith = new SessionViewPool({ anchors, transcriptRows });
  await getSession(poolWith, { userId: USER_ID, sessionId: SESSION_ID, includeMessages: true });
  assert.equal(poolWith.queries.some((query) => query.sql.includes('FROM tool_calls')), false,
    '#303：有消息也不取 tool_calls（时长只来自投影）');
  const poolWithout = new SessionViewPool({ anchors, transcriptRows });
  await getSession(poolWithout, { userId: USER_ID, sessionId: SESSION_ID, includeMessages: false });
  assert.equal(poolWithout.queries.some((query) => query.sql.includes('FROM tool_calls')), false,
    'includeMessages=false 同样不取');
});

// ============================================================================
// issue #390-A：`folded.hasSummary`——「这次折叠到底有没有真摘要」的机器判据
//
// 为什么必须有：现网全站 17 条折叠行的 `record.summary` 都是字符串字面量 `"missing"`（上游契约
// `src/store/file.js:25`：`summary?:{action:string,note:string}|"missing"`），而上游投影在摘要缺失时
// 把 `text` 兜底成「早期第 1–94 轮已折叠。」——与横幅标题换句话重复。前端因此需要一位判据，
// 且**不许**用字符串比对去猜（那条红线写在 #390 里）。
// ============================================================================

const foldProjectionWithSummary = (summary) => {
  const record = {
    dedupKey: `${RUN_1}:engine:round:9`,
    folded: true,
    foldedRoundRange: { from: 1, to: 5 },
    foldedPayload: [{ role: 'user', content: text('RAW') }],
  };
  if (summary !== undefined) record.summary = summary;
  return projectSessionMessages({
    sessionId: SESSION_ID,
    anchors: [message('folded-has-summary', 1, 'assistant', 'stale anchor text', RUN_1)],
    userAnchors: [],
    transcriptRows: [transcript(9, `${RUN_1}:engine:round:9`, record, at(1))],
  })[0]?.folded;
};

test('#390-A `hasSummary`：只有 `{action,note}` 形态算有摘要；`"missing"` / 缺键 / 空壳都算没有', () => {
  // 现网真实形状（17/17 条折叠行都是这个值）⇒ false，前端据此不该画展开控件
  assert.equal(foldProjectionWithSummary('missing').hasSummary, false,
    '字面量 "missing" 是上游契约里的「没有摘要」标记，不是摘要文本');
  assert.equal(foldProjectionWithSummary(undefined).hasSummary, false, '缺 `summary` 键 = 没有摘要');
  assert.equal(foldProjectionWithSummary({}).hasSummary, false, '空对象不算');
  assert.equal(foldProjectionWithSummary({ action: '', note: '' }).hasSummary, false, '两项都空不算');
  assert.equal(foldProjectionWithSummary({ note: null }).hasSummary, false, '非字符串不算');
  assert.equal(foldProjectionWithSummary(['a', 'b']).hasSummary, false, '数组不算');
  // 真有摘要的三种形态
  assert.equal(foldProjectionWithSummary({ action: '调研代码', note: '定位到 store 层' }).hasSummary, true);
  assert.equal(foldProjectionWithSummary({ action: '调研代码', note: '' }).hasSummary, true,
    '上游只承诺形状、没承诺两项都填 ⇒ 任一项非空就算有（宁可多画展开，别把真摘要判没）');
  assert.equal(foldProjectionWithSummary({ action: '', note: '只有 note' }).hasSummary, true);
});

test('#390-A `hasSummary` 与 `round` 同生同灭：轮号取不到就不带这个键（缺席 ≠ false）', () => {
  const withRound = foldProjectionWithSummary('missing');
  assert.ok('hasSummary' in withRound, '轮号可定时必须带这个键（前端把「缺席」当「不知道」）');
  // 判据的另一半在源码里：`recordForProjection` 恒把 round 列合成进 record ⇒ 现实数据永远带得上。
  const src = fs.readFileSync(new URL('../src/session-view.js', import.meta.url), 'utf8');
  assert.ok(src.includes('...(round === undefined ? {} : { hasSummary:'),
    '加键必须挂在 round 的同一个守卫上；改成无条件写 `false` 会让旧数据凭空丢掉展开控件');
});

test('#390-A 上游契约哨兵：`summary` 的缺失标记仍是字面量 "missing"（变了就该重核判据）', () => {
  const upstream = fs.readFileSync(
    new URL('../../node_modules/erix-agent/src/store/file.js', import.meta.url), 'utf8');
  assert.ok(/summary\?:\{action:string,note:string\}\|"missing"/.test(upstream),
    'erix-agent 的 `summary` 契约形态变了 ⇒ `hasRealSummary()` 的判据要跟着重核（别只改这里不查上游）');
});

// issue #243：终局正文是被文本化的工具调用时，该轮助手气泡要带中性状态标记。
// 后端投影侧只负责「有诊断 ⇒ 挂标记 / 无诊断 ⇒ 不写键（缺席 ≠ false）」；渲染在中性文案的前端。
test('#243 诊断进 DTO：终态带 textualized_tool_call 诊断的 run ⇒ 对应助手气泡写 true，未命中的不写键', async () => {
  const { anchors, transcriptRows } = fixture();
  const byId = (messages, id) => messages.find((m) => m.id === id);

  // 库里没有该诊断事件 ⇒ 两条助手气泡都**不带** textualized_tool_call 键（不得写成 false）
  const plain = await getSession(new SessionViewPool({ anchors, transcriptRows }),
    { userId: USER_ID, sessionId: SESSION_ID, limit: 100 });
  for (const id of ['a1', 'a2']) {
    const dto = byId(plain.messages, id);
    assert.ok(dto, `assistant anchor ${id} present`);
    assert.equal('textualized_tool_call' in dto, false, `${id} 无诊断 ⇒ 键缺席`);
  }

  // 只有 RUN_1 命中 ⇒ 只有它那条助手气泡带 true，RUN_2 那条仍无键
  const hitPool = new SessionViewPool({ anchors, transcriptRows, textualizedRunIds: [RUN_1] });
  const hit = await getSession(hitPool, { userId: USER_ID, sessionId: SESSION_ID, limit: 100 });
  assert.equal(byId(hit.messages, 'a1').textualized_tool_call, true, '命中 run 的助手气泡写 true');
  assert.equal('textualized_tool_call' in byId(hit.messages, 'a2'), false, '未命中 run 不写键');

  // 取数按 run 集合限定（不拿全表），且按诊断类型过滤
  assert.ok(hitPool.queries.some((q) => q.sql.includes('FROM run_events')
    && q.sql.includes('run_id = ANY') && q.sql.includes("type = 'textualized_tool_call'")),
  'run_events 取数必须按 run 集合 + 诊断类型限定');
});

test('#243 projectSessionMessages 直调：诊断参数缺省/非 Set ⇒ 不写键；Set 命中 ⇒ 写 true（additive 不外溢既有形状）', () => {
  const { anchors, transcriptRows } = fixture();
  const base = {
    sessionId: SESSION_ID, anchors, transcriptRows,
    userAnchors: anchors.filter((a) => a.role === 'user'),
  };
  const findAssistant = (msgs, id) => msgs.find((m) => m.id === id);

  assert.equal('textualized_tool_call' in findAssistant(projectSessionMessages(base), 'a1'), false,
    '缺省（undefined）⇒ 不写键，不得透成 false 之外的形状');
  assert.equal('textualized_tool_call' in findAssistant(
    projectSessionMessages({ ...base, textualizedRunIds: 'not-a-set' }), 'a1'), false,
  '非 Set 入参 ⇒ 视为空集，不写键');

  const withSet = projectSessionMessages({ ...base, textualizedRunIds: new Set([RUN_1]) });
  assert.equal(findAssistant(withSet, 'a1').textualized_tool_call, true);
  assert.equal('textualized_tool_call' in findAssistant(withSet, 'a2'), false);
});
