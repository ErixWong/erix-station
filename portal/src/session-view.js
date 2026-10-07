// 会话读侧展示投影（P3 PR②b，docs/design/conversation-state.md §6，上游 issue #95）。
//
// 「文本 / blocks / reasoning / 折叠」的推导**全部交给上游官方纯函数**
// `projectTranscriptForDisplay(records)`（erix-agent 0.15.0，
// erix-llm-kit `docs/host-consumer-contract.md` → "Host display projection"）：
//   - `reasoning` 与 `text` 分离，推理文本不再混进正文；
//   - 折叠轮只给「摘要 + 范围 + 导航指针」（`meta.foldedRoundRange` / `meta.navigationRecord`），
//     `foldedPayload` 原文不进对话流；
//   - 注入消息（judge 方向提示、审计拦截、system、wrapup）由 `meta.synthetic` / `meta.source` 标注；
//   - 记录的 dedupKey 经 `meta.dedupKey` 带出 → 宿主可把输入行**精确**映射到 messages 锚点。
//   输出形状（role/text/blocks/toolCalls/reasoning/folded/round/ts/meta）是稳定契约面；
//   `RoundRecord` 内部字段不是，本模块不读它。
//
// 官方投影**不承担**、仍由本模块承担的部分（都是宿主/UI 概念，契约面里没有）：
//   1. **锚点元数据**：DTO 的 `id`/`seq`/`run_id`/`attachments`/`synthetic`/`created_at` 一律取自
//      `messages` 锚点行——引擎没有「消息行」概念，`seq`/附件是本平台的分配器与外键。
//   2. **助手文本的 run 归属**：投影输出不带 `run_id`（引擎只认 transcript key 与 dedupKey 命名空间），
//      而 UI 的助手气泡必须落到某个 run。故保留三条归组规则：显式 `run_id` 列 → 该 run；
//      session-scoped 行沿用 transcript 分段（遇到 user 输入/键名 run 才切换）；单 run 会话兜底。
//   3. **非 `:input:` 行的锚点认领**：引擎轮记录（`<key>:engine:round:<n>`）、run 历史快照与 seed 行
//      带的是**轮级** dedupKey，没有 messageId，映射不到 `messages.id`；崩溃 run 的用户文本又常常
//      只存在于后续 run 的历史快照里（迁移 0015 之前入档的行甚至两者皆无）。这类行只能继续按
//      「内容精确相等」认领尚未认领的 user 锚点（seq 升序、单调游标、一条锚点只被认领一次）。
//      带 `<sessionId>:input:<messageId>` 的行**一律走 meta.dedupKey 精确映射**，不再参与内容匹配。
import { projectTranscriptForDisplay } from 'erix-agent';

// 归属用的键名：DB `dedup_key` 列（宿主自有的幂等键）+ 投影带出的 `meta.dedupKey`。
// 展示不读 RoundRecord 内部字段；只有「补齐 dedupKey」时会看一眼 dedupKey/roundKey（见 recordForProjection）。
function attributionKeys(row, metaDedupKey) {
  return [row.dedup_key, metaDedupKey]
    .filter((key) => typeof key === 'string' && key.length > 0);
}

/**
 * DB 行 → 引擎 record（附合成的 dedupKey）。与 `transcript-store.js` 的 `load()` 同一套补齐规则：
 * 官方投影只从 `record.dedupKey` 产出 `meta.dedupKey`，而老行的幂等键可能**只在 `dedup_key` 列上**，
 * 因此把列值合成进 record，避免这类行退化成「无稳定 id」走内容匹配。
 * 这里读 `base.dedupKey`/`base.roundKey` 只为补齐这个键（与 store.load 同口径），不是展示数据源。
 */
function recordForProjection(row) {
  const base = row.record && typeof row.record === 'object' ? row.record : {};
  const dedupKey = row.dedup_key ?? base.dedupKey ?? base.roundKey ?? null;
  return {
    record: {
      ...base,
      round: Number(row.round),
      ...(dedupKey === null ? {} : { dedupKey: String(dedupKey) }),
    },
    dedupKey: dedupKey === null ? null : String(dedupKey),
  };
}

/** 投影带出的 `meta.dedupKey`（同一 record 展开出的各 turn 共享同一个键）。 */
function projectionDedupKey(turns) {
  const turn = turns.find((candidate) => typeof candidate?.meta?.dedupKey === 'string'
    && candidate.meta.dedupKey !== '');
  return turn?.meta?.dedupKey ?? null;
}

function inputMessageId(dedupKey, sessionId) {
  const prefix = `${sessionId}:input:`;
  return typeof dedupKey === 'string' && dedupKey.startsWith(prefix)
    ? dedupKey.slice(prefix.length)
    : null;
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

function compareTranscriptRows(a, b) {
  const roundDiff = Number(a.round) - Number(b.round);
  if (Number.isFinite(roundDiff) && roundDiff !== 0) return roundDiff;
  const aTime = timestamp(a.created_at);
  const bTime = timestamp(b.created_at);
  if (aTime !== null && bTime !== null && aTime !== bTime) return aTime - bTime;
  return 0;
}

/** 该行的真实用户文本（排除引擎注入的合成消息，避免注入文本抢认锚点）。 */
function userTurnTexts(turns) {
  return turns
    .filter((turn) => turn.role === 'user' && turn.meta?.synthetic !== true && turn.folded !== true)
    .map((turn) => turn.text)
    .filter((value) => typeof value === 'string' && value !== '');
}

/** 该行的助手正文：投影已把 reasoning 与 tool-only 轮次分离，取最后一条非空文本（= 最终答复）。 */
function assistantTurnText(turns) {
  const text = turns
    .filter((turn) => turn.role === 'assistant' && turn.folded !== true)
    .map((turn) => turn.text)
    .filter((value) => typeof value === 'string' && value !== '')
    .at(-1);
  return text ?? null;
}

/**
 * 折叠轮的官方展示文本（摘要 + 范围 + 导航指针，`foldedPayload` 原文已被投影排除）。
 * DTO 是锚点驱动的，没有可承载官方 system 折叠行的锚点，故只在「该 run 没有自身助手正文」时顶上
 * （取舍见执行报告：契约 ③「折叠的是上下文，显示的是历史消息」——历史消息优先，折叠摘要兜底）。
 */
function foldedTurnText(turns) {
  const text = turns
    .filter((turn) => turn.folded === true)
    .map((turn) => turn.text)
    .filter((value) => typeof value === 'string' && value !== '')
    .at(-1);
  return text ?? null;
}

/**
 * Build the existing message DTO from the official display projection plus message anchor metadata.
 * Synthetic rows (for example judge/wrapup injections) have no required transcript
 * text match yet, so their content intentionally remains sourced from the anchor.
 */
export function projectSessionMessages({ sessionId, anchors, userAnchors, transcriptRows }) {
  const users = [...userAnchors].sort((a, b) => Number(a.seq) - Number(b.seq));
  const userById = new Map(users.map((anchor) => [String(anchor.id), anchor]));
  const userAnchorsByText = new Map();
  // 非 `:input:` 行的内容匹配用：文本桶按 seq 升序 + 单调游标，避免每条候选反复扫描全部锚点
  // （历史快照一行可含十几条 user 文本，反复全量扫描会退化成 O(行数 × 锚点数)）。
  for (const anchor of users) {
    if (anchor.synthetic === true || typeof anchor.anchor_text !== 'string') continue;
    let queue = userAnchorsByText.get(anchor.anchor_text);
    if (!queue) {
      queue = { anchors: [], cursor: 0 };
      userAnchorsByText.set(anchor.anchor_text, queue);
    }
    queue.anchors.push(anchor);
  }
  const claimedUserAnchors = new Set();
  const claimUserAnchorByExactText = (text) => {
    const queue = userAnchorsByText.get(text);
    if (!queue) return null;
    while (queue.cursor < queue.anchors.length) {
      const anchor = queue.anchors[queue.cursor++];
      if (!claimedUserAnchors.has(String(anchor.id))) return anchor;
    }
    return null;
  };

  const runIds = new Set([
    ...users.map((anchor) => anchor.run_id),
    ...anchors.map((anchor) => anchor.run_id),
  ].filter((runId) => typeof runId === 'string' && runId.length > 0));
  const soleRunId = runIds.size === 1 ? runIds.values().next().value : null;
  const userContent = new Map();
  const assistantContent = new Map();
  const foldContent = new Map();
  let currentRunId = null;

  const setRunText = (runId, assistantText, foldText) => {
    if (assistantText !== null) assistantContent.set(runId, assistantText);
    if (foldText !== null) foldContent.set(runId, foldText);
  };

  for (const row of [...transcriptRows].sort(compareTranscriptRows)) {
    // 逐行调用官方投影：它是按记录独立展开的纯函数（整表调用只做「按 round 排序 + flatMap」），
    // 而本模块要把每个 turn 对应回它的 DB 行（`run_id` 归属、键名分段），行级调用是唯一稳定映射。
    const { record, dedupKey } = recordForProjection(row);
    const turns = projectTranscriptForDisplay([record]);
    // 注意：即使本行没产出可展示 turn（tool-only / 纯 tool_result 轮）也不能提前跳过——
    // 它的 dedupKey 仍参与 run 分段（否则后面的 session-scoped 行会失去归属）。
    const metaDedupKey = projectionDedupKey(turns) ?? dedupKey;
    const keys = attributionKeys(row, metaDedupKey);
    const messageId = inputMessageId(metaDedupKey, sessionId);
    const candidateUserTexts = userTurnTexts(turns);
    const lastUserText = candidateUserTexts.at(-1) ?? null;
    let matchedUserAnchor = null;

    if (messageId !== null) {
      // meta.dedupKey 精确映射（取代内容匹配启发式）：一个输入行只喂它自己的锚点。
      matchedUserAnchor = userById.get(messageId) ?? null;
      if (
        matchedUserAnchor
        && matchedUserAnchor.synthetic !== true
        && lastUserText !== null
        && !claimedUserAnchors.has(String(matchedUserAnchor.id))
      ) {
        const anchorId = String(matchedUserAnchor.id);
        claimedUserAnchors.add(anchorId);
        userContent.set(anchorId, lastUserText);
      }
    } else {
      // 无 messageId 的行（引擎轮/历史快照/seed）：按内容精确相等认领未认领锚点（seq 升序、认领一次）。
      for (const userText of candidateUserTexts) {
        const candidate = claimUserAnchorByExactText(userText);
        if (candidate) {
          matchedUserAnchor = candidate;
          const anchorId = String(candidate.id);
          claimedUserAnchors.add(anchorId);
          userContent.set(anchorId, userText);
        }
      }
    }

    const assistantText = assistantTurnText(turns);
    const foldText = foldedTurnText(turns);

    if (typeof row.run_id === 'string' && row.run_id.length > 0) {
      if (lastUserText !== null) currentRunId = row.run_id;
      setRunText(row.run_id, assistantText, foldText);
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

    const sessionRound = keyedRunId === null && isSessionRound(keys, sessionId);
    if (keyedRunId === null && !sessionRound) {
      continue;
    }

    // Real sessions showed migration-0015 input rows sorting after session rounds
    // by both round and created_at, leaving currentRunId unset. A sole anchored run
    // makes attribution of otherwise-unassigned session rounds unambiguous.
    if (!currentRunId && sessionRound && soleRunId !== null) {
      currentRunId = soleRunId;
    }
    if (!currentRunId) continue;
    setRunText(currentRunId, assistantText, foldText);
  }

  const messages = anchors.map((anchor) => {
    let content = '';
    if (anchor.synthetic === true) {
      content = anchor.content;
    } else if (anchor.role === 'user') {
      const anchorId = String(anchor.id);
      if (userContent.has(anchorId)) {
        content = userContent.get(anchorId);
      }
    } else if (anchor.role === 'assistant') {
      if (assistantContent.has(anchor.run_id)) {
        content = assistantContent.get(anchor.run_id);
      } else if (foldContent.has(anchor.run_id)) {
        content = foldContent.get(anchor.run_id);
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

  return messages;
}
