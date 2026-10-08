import test from 'node:test';
import assert from 'node:assert/strict';
import { getSession } from '../src/sessions.js';
import { projectSessionMessages } from '../src/session-view.js';
import { projectTranscriptForDisplay } from 'erix-agent';

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
  constructor({ sessionId = SESSION_ID, anchors, transcriptRows }) {
    this.sessionId = sessionId;
    this.anchors = anchors;
    this.transcriptRows = transcriptRows;
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
  const anchorQuery = pool.queries.find((query) => query.sql.includes('FROM messages') && !query.sql.includes("role = 'user'"));
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
  assert.equal(pool.queries.some((query) => query.sql.includes('FROM messages')), false);
  assert.equal(pool.queries.some((query) => query.sql.includes('FROM transcript_rounds')), false);
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
    name: 'read',
    id: 'call-1',
    argsSummary: 'path=src/a.js',
    resultPreview: 'FILE BODY',
    isError: false,
    executionStatus: 'succeeded',
  }], 'toolCalls 逐字透传（含上游预览字段，不裁剪）');
  assert.deepEqual(dto.blocks, assistantBlocks, 'blocks 逐字透传（原始 content blocks）');
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
});

test('issue #188: assistant DTO omits projection keys when the projection has none', () => {
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
