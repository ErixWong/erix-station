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

function assistantText(record) {
  const responseText = textFromContent(record?.response?.content);
  if (responseText) return responseText;

  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const lastAssistant = messages.findLast((message) => message?.role === 'assistant');
  const messageText = textFromContent(lastAssistant?.content);
  return messageText || null;
}

function userTexts(record) {
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  return messages
    .filter((message) => message?.role === 'user')
    .map((message) => textFromContent(message?.content));
}

function claimUserAnchor(text, anchorsByText, claimedUserAnchors) {
  const queue = anchorsByText.get(text);
  if (!queue) return null;

  while (queue.cursor < queue.anchors.length) {
    const anchor = queue.anchors[queue.cursor++];
    if (!claimedUserAnchors.has(String(anchor.id))) return anchor;
  }
  return null;
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
  const userAnchorsByText = new Map();
  // Text buckets stay seq-ordered; monotone cursors make each candidate O(1) amortized
  // instead of rescanning all user anchors for every message in historical snapshots.
  for (const anchor of users) {
    if (anchor.synthetic === true || typeof anchor.anchor_text !== 'string') continue;
    let queue = userAnchorsByText.get(anchor.anchor_text);
    if (!queue) {
      queue = { anchors: [], cursor: 0 };
      userAnchorsByText.set(anchor.anchor_text, queue);
    }
    queue.anchors.push(anchor);
  }
  const runIds = new Set([
    ...users.map((anchor) => anchor.run_id),
    ...anchors.map((anchor) => anchor.run_id),
  ].filter((runId) => typeof runId === 'string' && runId.length > 0));
  const userContent = new Map();
  const claimedUserAnchors = new Set();
  const assistantContent = new Map();
  let currentRunId = null;

  for (const row of [...transcriptRows].sort(compareTranscriptRows)) {
    const record = row.record;
    const keys = recordKeys(row, record);
    const messageId = inputMessageId(keys, sessionId);
    const candidateUserTexts = userTexts(record);
    const lastUserText = candidateUserTexts.at(-1) ?? null;
    let matchedUserAnchor = null;

    // Snapshot rows can end at an earlier turn; run_id alone does not establish user ownership.
    if (messageId !== null) {
      matchedUserAnchor = userById.get(messageId) ?? null;
      if (
        matchedUserAnchor
        && matchedUserAnchor.synthetic !== true
        && lastUserText !== null
        && lastUserText !== ''
        && !claimedUserAnchors.has(String(matchedUserAnchor.id))
      ) {
        const anchorId = String(matchedUserAnchor.id);
        claimedUserAnchors.add(anchorId);
        userContent.set(anchorId, lastUserText);
      }
    } else {
      for (const userText of candidateUserTexts) {
        if (userText === null || userText === '') continue;
        const candidate = claimUserAnchor(userText, userAnchorsByText, claimedUserAnchors);
        if (candidate) {
          matchedUserAnchor = candidate;
          const anchorId = String(candidate.id);
          claimedUserAnchors.add(anchorId);
          userContent.set(anchorId, userText);
        }
      }
    }

    if (typeof row.run_id === 'string' && row.run_id.length > 0) {
      if (lastUserText !== null) currentRunId = row.run_id;
      const text = assistantText(record);
      if (text) assistantContent.set(row.run_id, text);
      continue;
    }

    if (messageId !== null) {
      currentRunId = matchedUserAnchor?.run_id ?? null;
      continue;
    }

    const keyedRunId = recordRunId(keys, runIds);
    if (keyedRunId !== null) {
      currentRunId = keyedRunId;
    }

    const isSeed = keys.some((key) => key.endsWith(':seed'));
    if (isSeed) {
      if (matchedUserAnchor) currentRunId = matchedUserAnchor.run_id ?? null;
      continue;
    }

    if (keyedRunId === null && !isSessionRound(keys, sessionId)) {
      continue;
    }

    if (!currentRunId) continue;
    const text = assistantText(record);
    if (text) assistantContent.set(currentRunId, text);
  }

  let fallbackCount = 0;
  const messages = anchors.map((anchor) => {
    let content = '';
    if (anchor.synthetic === true) {
      content = anchor.content;
    } else if (anchor.role === 'user') {
      const anchorId = String(anchor.id);
      if (userContent.has(anchorId)) {
        content = userContent.get(anchorId);
      } else {
        content = userById.get(anchorId)?.anchor_text ?? '';
        fallbackCount += 1;
      }
    } else if (anchor.role === 'assistant') {
      if (assistantContent.has(anchor.run_id)) {
        content = assistantContent.get(anchor.run_id);
      } else {
        content = anchor.content ?? '';
        fallbackCount += 1;
      }
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

  // PR① 的过渡兜底唯一原因是写路径尚未把用户输入落进 transcript（由 PR② 修复）。
  // PR② 必须删除此兜底，并把 fallbackCount === 0 作为验收断言。
  return { messages, fallbackCount };
}
