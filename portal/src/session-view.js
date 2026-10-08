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
// issue #188：投影的 `toolCalls`/`reasoning`/`blocks` 随助手锚点**逐字透传**进对话流 DTO（原名、不裁剪、
// 不重推导；无则不写该键），供前端加载/刷新路径重建工具卡片与推理展示。宿主不向上游形状注入字段
//（#95 红线）。erix-agent 0.16.0 已提供稳定的投影视图键：`turn.key`（轮级）与 `toolCalls[].key`
// （单次投影内唯一、同输入确定性、由输入位置生成；**不是持久 ID、也不是 provider `tool_use.id`**）
// ——上游 erix-llm-kit#100（`toolCalls[].id` 可选/可重复）由此交付视图身份，前端不再自造 key。
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
export function recordForProjection(row) {
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
export function projectionDedupKey(turns) {
  const turn = turns.find((candidate) => typeof candidate?.meta?.dedupKey === 'string'
    && candidate.meta.dedupKey !== '');
  return turn?.meta?.dedupKey ?? null;
}

export function inputMessageId(dedupKey, sessionId) {
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

export function compareTranscriptRows(a, b) {
  const roundDiff = Number(a.round) - Number(b.round);
  if (Number.isFinite(roundDiff) && roundDiff !== 0) return roundDiff;
  const aTime = timestamp(a.created_at);
  const bTime = timestamp(b.created_at);
  if (aTime !== null && bTime !== null && aTime !== bTime) return aTime - bTime;
  return 0;
}

/** 该行的真实用户文本（排除引擎注入的合成消息，避免注入文本抢认锚点）。
 *  P3 PR②b：`session-text.js`（标题 / claim task / 历史上行等文本读取点）复用同一口径，勿另写一份。 */
export function userTurnTexts(turns) {
  return turns
    .filter((turn) => turn.role === 'user' && turn.meta?.synthetic !== true && turn.folded !== true)
    .map((turn) => turn.text)
    .filter((value) => typeof value === 'string' && value !== '');
}

/** 该行的助手正文：投影已把 reasoning 与 tool-only 轮次分离，取最后一条非空文本（= 最终答复）。
 *  P3 PR②b：同样供 `session-text.js` 复用（终态幂等比较的 final_text 取数）。 */
export function assistantTurnText(turns) {
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
 * issue #189：折叠轮的上游元数据（范围 / 导航指针 / 被折叠消息条数 + 折叠摘要原文），逐字透传
 * （#95 红线：上游原名、不改名、不重推导）。只从 `turn.folded === true` 的轮取；
 * 四项都缺 → null（调用方据此不写 `folded` 键，与 toolCalls 同规矩）。
 * 上游把三元组放在折叠 turn 的 meta 面上（erix-agent display/projection.js：meta.foldedRoundRange /
 * meta.navigationRecord / meta.foldedPayloadMessages），`text` 则与 `foldedTurnText()` 同源（折叠摘要原文）。
 */
function foldedTurnFields(turns) {
  for (const turn of [...turns].reverse()) {
    if (turn?.folded !== true) continue;
    const pick = (key) => (turn[key] !== undefined && turn[key] !== null
      ? turn[key]
      : (turn.meta?.[key] !== undefined && turn.meta?.[key] !== null ? turn.meta[key] : undefined));
    const range = pick('foldedRoundRange');
    const navigation = pick('navigationRecord');
    const payloadMessages = pick('foldedPayloadMessages');
    // 折叠摘要原文（与 foldedTurnText 同源：该折叠 turn 自己的 text，逐字透传）。
    const text = typeof turn.text === 'string' && turn.text !== '' ? turn.text : undefined;
    if (range === undefined && navigation === undefined && payloadMessages === undefined && text === undefined) continue;
    return {
      ...(text === undefined ? {} : { text }),
      ...(range === undefined ? {} : { foldedRoundRange: range }),
      ...(navigation === undefined ? {} : { navigationRecord: navigation }),
      ...(payloadMessages === undefined ? {} : { foldedPayloadMessages: payloadMessages }),
    };
  }
  return null;
}

/**
 * issue #188：单条 transcript 行里、官方投影助手轮上的展示字段（逐字透传，不裁剪/不改名/不重推导）。
 *
 * 投影的 `DisplayTurn` 契约面里，助手轮除 `text` 外还带 `blocks`（原始 content blocks 数组）、
 * `toolCalls?`（`{key, name, id?, argsSummary?, resultPreview?, isError?, executionStatus?}`，预览长度由上游
 * 定：args 120 / result 400）与 `reasoning?`（与正文分离的推理文本）。这三者此前没有进入对话流 DTO，
 * 导致前端刷新后丢失工具卡片与推理。本函数把它们从助手轮上取出（**只取字段值，不做任何加工**）。
 * `turn.key`（0.16.0 新增的轮级视图键）也原样取出（keys），供 DTO 透传（run 聚合轮 → 数组）。
 *
 * 全部为空时返回 null，调用方据此**不写该键**（契约：有则透传、无则 DTO 不出现该键）。
 */
function assistantTurnFields(turns) {
  const assistantTurns = turns.filter((turn) => turn.role === 'assistant');
  if (assistantTurns.length === 0) return null;
  const toolCalls = assistantTurns.flatMap((turn) => (Array.isArray(turn.toolCalls) ? turn.toolCalls : []));
  const reasonings = assistantTurns
    .map((turn) => turn.reasoning)
    .filter((value) => typeof value === 'string' && value !== '');
  const blocks = assistantTurns.flatMap((turn) => (Array.isArray(turn.blocks) ? turn.blocks : []));
  const keys = assistantTurns
    .map((turn) => turn.key)
    .filter((value) => typeof value === 'string' && value !== '');
  return {
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    // 一个 run 可含多条助手轮，推理文本按投影顺序以 '\n' 连接（与上游 joinBlocks 同一连接符）。
    reasoning: reasonings.length > 0 ? reasonings.join('\n') : null,
    blocks: blocks.length > 0 ? blocks : null,
    keys: keys.length > 0 ? keys : null,
  };
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
  // issue #188：DTO 是「一个 run 一条助手锚点」，而投影是「一轮一条助手 turn」——按 run 累积该 run
  // 全部助手轮的透传字段（toolCalls/blocks 逐元素拼接、reasoning 逐段收集，均在输出前保持上游原值）。
  const runToolCalls = new Map();
  const runReasoning = new Map();
  const runBlocks = new Map();
  // 0.16.0：轮级视图键（`turn.key`）逐字透传（与 toolCalls[].key 同源，后者是其前缀 + `:t<i>`）。
  const runTurnKeys = new Map();
  // issue #189：折叠轮元数据（按 run 收集，写法同 runToolCalls/runTurnKeys；后到行覆盖前行，与 foldContent 同语义）。
  const runFolded = new Map();
  let currentRunId = null;

  const setRunText = (runId, assistantText, foldText, turns) => {
    if (assistantText !== null) assistantContent.set(runId, assistantText);
    if (foldText !== null) foldContent.set(runId, foldText);
    const foldedFields = foldedTurnFields(turns);
    if (foldedFields !== null) runFolded.set(runId, foldedFields);
    const fields = assistantTurnFields(turns);
    if (fields === null) return;
    if (fields.toolCalls !== null) {
      runToolCalls.set(runId, [...(runToolCalls.get(runId) ?? []), ...fields.toolCalls]);
    }
    if (fields.keys !== null) {
      runTurnKeys.set(runId, [...(runTurnKeys.get(runId) ?? []), ...fields.keys]);
    }
    if (fields.reasoning !== null) {
      runReasoning.set(runId, [...(runReasoning.get(runId) ?? []), fields.reasoning]);
    }
    if (fields.blocks !== null) {
      runBlocks.set(runId, [...(runBlocks.get(runId) ?? []), ...fields.blocks]);
    }
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
      setRunText(row.run_id, assistantText, foldText, turns);
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
    setRunText(currentRunId, assistantText, foldText, turns);
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
        // issue #189：该 run 没有自身助手正文 → 折叠摘要兜底顶上（兜底行为不变；折叠标记见下方透传块）。
        content = foldContent.get(anchor.run_id);
      }
    }
    const dto = {
      id: anchor.id,
      run_id: anchor.run_id,
      seq: Number(anchor.seq),
      role: anchor.role,
      content,
      synthetic: anchor.synthetic,
      attachments: anchor.attachments ?? [],
      created_at: anchor.created_at?.toISOString?.() ?? anchor.created_at,
    };
    // issue #188：助手锚点透传上游投影字段（逐字、原名）。宿主独有的 UI 元数据（id/run_id/seq/
    // attachments/synthetic/created_at）保持 snake_case 且语义不变；这三项**有则出现、无则不写键**，
    // 不塞 undefined/null 占位。合成助手行（synthetic）正文来自锚点本身、不经 transcript 投影，故不透传。
    if (anchor.role === 'assistant' && anchor.synthetic !== true) {
      const toolCalls = runToolCalls.get(anchor.run_id);
      if (toolCalls !== undefined) dto.toolCalls = toolCalls;
      const reasoning = runReasoning.get(anchor.run_id);
      if (reasoning !== undefined) dto.reasoning = reasoning.join('\n');
      const blocks = runBlocks.get(anchor.run_id);
      if (blocks !== undefined) dto.blocks = blocks;
      // 0.16.0 轮级视图键（`turn.key`，逐字透传；run 可聚合多轮 → 数组，与 toolCalls 同为「有则出现」）。
      const turnKeys = runTurnKeys.get(anchor.run_id);
      if (turnKeys !== undefined) dto.turnKeys = turnKeys;
      // issue #189 修正：只要有折叠轮就挂（无论正文是该 run 自身助手正文还是折叠摘要兜底——
      // 此前只挂兜底分支，正常 run 有正文时前端永远收不到「已压缩」标记）。
      // 上游三元组 + 折叠摘要原文（text），逐字透传；有则出现、无则不写键，同 toolCalls 规矩。
      const folded = runFolded.get(anchor.run_id);
      if (folded !== undefined) dto.folded = folded;
    }
    return dto;
  });

  return messages;
}
