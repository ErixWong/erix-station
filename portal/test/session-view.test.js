import test from 'node:test';
import assert from 'node:assert/strict';
import { getSession } from '../src/sessions.js';

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
          .map(({ id, run_id, seq, synthetic, created_at }) => ({
            id, run_id, seq, synthetic, created_at,
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
    message('old-user', 6, 'user', 'legacy content must not be used', LEGACY_RUN, { createdAt: at(11) }),
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
  assert.ok(pool.queries.some((query) => query.sql.includes('FROM transcript_rounds')));
  assert.ok(pool.queries.some((query) => query.sql.includes('ORDER BY seq DESC LIMIT $2')));
  assert.match(
    pool.queries.find((query) => query.sql.includes('FROM transcript_rounds')).sql,
    /SELECT run_id, round, dedup_key, record, created_at/,
  );
});

test('projection resolves explicit run-id keys and never falls back for non-synthetic legacy anchors', async () => {
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

test('transcript rows without a run ID or any key remain unattributed', async () => {
  const anchors = [
    message('unattributed-user', 1, 'user', 'anchor must not be read', RUN_4),
    message('unattributed-assistant', 2, 'assistant', 'anchor must not be read', RUN_4),
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
  assert.deepEqual(result.messages.map((row) => row.content), ['', '']);
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
