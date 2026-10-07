function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const blocks = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text);
  return blocks.length > 0 ? blocks.join('') : null;
}

function recordKeys(row, record) {
  return [row.dedup_key, record?.dedupKey, record?.roundKey]
    .filter((key) => typeof key === 'string' && key.length > 0);
}

function inputMessageId(keys, sessionId) {
  const prefix = `${sessionId}:input:`;
  const key = keys.find((candidate) => candidate.startsWith(prefix));
  return key === undefined ? null : key.slice(prefix.length);
}

function recordRunId(keys, runIds) {
  for (const runId of runIds) {
    if (keys.some((key) => key.startsWith(`${runId}:round:`) || key.startsWith(`${runId}:engine:round:`))) {
      return runId;
    }
  }
  return null;
}

function isSessionRound(keys, sessionId) {
  return keys.some((key) => (
    key.startsWith(`${sessionId}:round:`) || key.startsWith(`${sessionId}:engine:round:`)
  ));
}

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function latestUserAnchorAt(userAnchors, time, runId = null) {
  if (time === null) return null;
  let latest = null;
  for (const anchor of userAnchors) {
    const createdAt = timestamp(anchor.created_at);
    if (
      anchor.run_id
      && (runId === null || anchor.run_id === runId)
      && createdAt !== null
      && createdAt <= time
    ) latest = anchor;
  }
  return latest;
}

function assistantText(record) {
  const responseText = textFromContent(record?.response?.content);
  if (responseText) return responseText;

  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const lastAssistant = messages.findLast((message) => message?.role === 'assistant');
  const messageText = textFromContent(lastAssistant?.content);
  return messageText || null;
}

function compareTranscriptRows(a, b) {
  const roundDiff = Number(a.round) - Number(b.round);
  if (Number.isFinite(roundDiff) && roundDiff !== 0) return roundDiff;
  const aTime = timestamp(a.created_at);
  const bTime = timestamp(b.created_at);
  if (aTime !== null && bTime !== null && aTime !== bTime) return aTime - bTime;
  return 0;
}

/**
 * Build the existing message DTO from transcript text and message anchor metadata.
 * Synthetic rows (for example judge/wrapup injections) have no required transcript
 * text match yet, so their content intentionally remains sourced from the anchor.
 */
export function projectSessionMessages({ sessionId, anchors, userAnchors, transcriptRows }) {
  const users = [...userAnchors].sort((a, b) => Number(a.seq) - Number(b.seq));
  const userById = new Map(users.map((anchor) => [String(anchor.id), anchor]));
  const userByRunId = new Map();
  for (const anchor of users) {
    if (anchor.synthetic !== true && anchor.run_id && !userByRunId.has(anchor.run_id)) {
      userByRunId.set(anchor.run_id, anchor);
    }
  }
  const runIds = new Set([
    ...users.map((anchor) => anchor.run_id),
    ...anchors.map((anchor) => anchor.run_id),
  ].filter((runId) => typeof runId === 'string' && runId.length > 0));
  const userContent = new Map();
  const assistantContent = new Map();
  let currentRunId = null;

  // Explicit legacy run IDs are authoritative; session-scoped keys segment newer rows.
  for (const row of [...transcriptRows].sort(compareTranscriptRows)) {
    const record = row.record;
    if (typeof row.run_id === 'string' && row.run_id.length > 0) {
      const lastUser = Array.isArray(record?.messages)
        ? record.messages.findLast((message) => message?.role === 'user')
        : null;
      const userText = textFromContent(lastUser?.content);
      const userAnchor = userByRunId.get(row.run_id);
      if (userAnchor && userText) userContent.set(String(userAnchor.id), userText);

      const text = assistantText(record);
      if (text) assistantContent.set(row.run_id, text);
      continue;
    }

    const keys = recordKeys(row, record);
    if (keys.length === 0) continue;
    const isSeed = keys.some((key) => key.endsWith(':seed'));
    const messageId = inputMessageId(keys, sessionId);
    if (messageId !== null) {
      const anchor = userById.get(messageId);
      currentRunId = anchor?.run_id ?? null;
      const messages = Array.isArray(record?.messages) ? record.messages : [];
      const lastUser = messages.findLast((message) => message?.role === 'user');
      const text = textFromContent(lastUser?.content);
      if (anchor && text !== null) userContent.set(String(anchor.id), text);
      continue;
    }

    const keyedRunId = recordRunId(keys, runIds);
    if (keyedRunId !== null) {
      currentRunId = keyedRunId;
    } else if (isSeed && isSessionRound(keys, sessionId) && currentRunId === null) {
      currentRunId = latestUserAnchorAt(users, timestamp(row.created_at))?.run_id ?? null;
    } else if (!isSessionRound(keys, sessionId)) {
      continue;
    }

    if (isSeed) {
      const seedUser = latestUserAnchorAt(users, timestamp(row.created_at), currentRunId);
      const messages = Array.isArray(record?.messages) ? record.messages : [];
      const lastUser = messages.findLast((message) => message?.role === 'user');
      const text = textFromContent(lastUser?.content);
      if (seedUser && text !== null) userContent.set(String(seedUser.id), text);
      continue;
    }

    if (!currentRunId) continue;
    const text = assistantText(record);
    if (text) assistantContent.set(currentRunId, text);
  }

  return anchors.map((anchor) => {
    let content = '';
    if (anchor.synthetic === true) {
      content = anchor.content;
    } else if (anchor.role === 'user') {
      content = userContent.get(String(anchor.id)) ?? '';
    } else if (anchor.role === 'assistant') {
      content = assistantContent.get(anchor.run_id) ?? '';
    }
    return {
      id: anchor.id,
      run_id: anchor.run_id,
      seq: Number(anchor.seq),
      role: anchor.role,
      content,
      synthetic: anchor.synthetic,
      attachments: anchor.attachments ?? [],
      created_at: anchor.created_at?.toISOString?.() ?? anchor.created_at,
    };
  });
}
