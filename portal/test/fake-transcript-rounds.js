// `transcript_rounds`（session 作用域那半边：`transcript_key` + 部分唯一索引）的**真库行为**仿真。
//
// 为什么要有这个文件（AGENTS §8.14 的教训，issue #333 第三张单）：#333 M2 把
// `portal/src/transcript-store.js` 的 `ON CONFLICT … DO NOTHING` 从「静默丢弃」降级成并发防线之后，
// 撞键路径变成「**读回既有 record → 比 payload 指纹**」。原先各处 fake 对这两条 SQL 的写法是
// 「`INSERT` 一律 `return { rows: [] }`、`SELECT record` 一律 `return { rows: [] }`」——
// 于是：① `INSERT` 不给行 ⇒ 产品读成「被跳过」；② 读回也不给行 ⇒ 产品走「既有正文取不到」的
// 最保守分支 ⇒ 每次预写都伪报冲突。更糟的是**就算给行也是假的**：读回若凭空造一条 record，
// 真库里「撞键读回来的正是先前存进去的那条」这件事在单测里就**结构上不可能被发现**（§8.14 的 #252）。
//
// ⇒ 本文件把这段 SQL 面收成一份实现，规矩是「按 SQL 说的做，不替产品兜底」：
//   · `INSERT … ON CONFLICT (transcript_key, dedup_key) … DO NOTHING RETURNING id`：
//     真插进去了才出行；被仲裁跳过 ⇒ **零行 + rowCount 0**；**没写 ON CONFLICT 而撞唯一键 ⇒ 照真库抛 23505**
//     （否则「幂等」在 fake 里永远假通过）；`RETURNING` 没写 ⇒ 不出行（真库语义，产品靠它区分两侧）。
//   · `SELECT record … WHERE transcript_key=$1 AND dedup_key=$2`：只回**真存着的那条** record；
//     没存过 ⇒ 零行。**绝不**把「想写的那条」回给调用方。
//   · `SELECT MAX(round)`：无行 ⇒ `max_round = null`（聚合语义，不是 0）。
//   · `SELECT round, dedup_key, record`（全量 load）：按 `(round, append_seq)` 出序（同 round 多行
//     的追加序是 0.16.0 的契约，迁移 0016）。
//
// 行形状用**真列名**（`transcript_key`/`dedup_key`/`round`/`record`/`messages`/`append_seq`），
// 与 `docs/data/schema.sql` + 迁移 0006/0016 一致；`run_id` 侧（U5 `putRound`）的
// `(run_id, round)` 半边也支持，供 run 作用域端点的 fake 复用。
//
// 用法：`const t = fakeTranscriptRounds({ rows }); ` 在 fake 的 query 派发里
// `const hit = t.query(sql, params); if (hit) return hit;`（不认的 SQL 返回 `null`，交回调用方）。

/** 把多空白压成单空格：SQL 匹配只看规范化后的文本（各 fake 的既有惯例）。 */
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

/**
 * @param {object} [options]
 * @param {Array<object>} [options.rows] 预先种子的行（真列名形状）；缺省空表
 * @param {() => number} [options.clock] append_seq/自增 id 的计数器（缺省内部自增）
 */
export function fakeTranscriptRounds({ rows = [], clock = null } = {}) {
  let seq = 0;
  const next = () => (clock ? clock() : (seq += 1));
  const state = {
    rows,
    /** `INSERT` 语句被执行的次数（含被 ON CONFLICT 跳过的）——「有没有发第二笔写」的断言面。 */
    insertAttempts: 0,
    /** 其中被 ON CONFLICT 仲裁跳过的次数。 */
    conflictSkips: 0,
    /** 撞键后真正发生的「读回既有 record」次数。 */
    readBacks: 0,
  };

  const rowKey = (row) => row;

  const findSessionRow = (transcriptKey, dedupKey) => state.rows.find(
    (r) => r.run_id == null && r.transcript_key === transcriptKey && r.dedupKey === dedupKey,
  ) ?? state.rows.find(
    (r) => r.run_id == null && r.transcript_key === transcriptKey && r.dedup_key === dedupKey,
  );

  const findRunRow = (runId, round) => state.rows.find(
    (r) => r.transcript_key == null && r.run_id === runId && Number(r.round) === Number(round),
  );

  /** 真库的部分唯一索引：`(transcript_key, dedup_key) WHERE transcript_key IS NOT NULL`（迁移 0006）。 */
  function assertSessionUnique(transcriptKey, dedupKey, sql) {
    if (transcriptKey == null || dedupKey == null) return;   // 部分索引不管 NULL 侧
    if (!findSessionRow(transcriptKey, dedupKey)) return;
    if (/ON CONFLICT \(transcript_key, dedup_key\)[\s\S]*DO NOTHING/i.test(sql)) return; // 已写仲裁 ⇒ 由调用侧走跳过分支
    // 没写仲裁而撞唯一键：照真库报错，让「删掉 ON CONFLICT」的回归在单测里红，而不是静默多一行。
    throw new Error('duplicate key value violates unique constraint "transcript_rounds_session_dedup_uidx"');
  }

  function query(sql, params = []) {
    const s = norm(sql);

    // ---- INSERT（session 作用域：带 transcript_key/dedup_key 列）----
    if (/^INSERT INTO transcript_rounds\b/i.test(s) && /\btranscript_key\b/i.test(s)) {
      state.insertAttempts += 1;
      const [transcriptKey, dedupKey, round, record, folded, messages, foldedPayload] = params;
      assertSessionUnique(transcriptKey, dedupKey, s);
      if (transcriptKey != null && dedupKey != null && findSessionRow(transcriptKey, dedupKey)) {
        // ON CONFLICT DO NOTHING：真库 rowCount 0 且 RETURNING 不出行。
        state.conflictSkips += 1;
        return { rows: [], rowCount: 0 };
      }
      state.rows.push({
        transcript_key: transcriptKey,
        dedup_key: dedupKey,
        run_id: null,
        round,
        record: JSON.parse(record),
        folded: folded === true,
        messages: messages == null ? [] : JSON.parse(messages),
        folded_payload: foldedPayload == null ? null : JSON.parse(foldedPayload),
        append_seq: next(),
        created_at: state.rows.length + 1,
      });
      if (!/RETURNING/i.test(s)) return { rows: [], rowCount: 1 };   // 没写 RETURNING ⇒ 真库不出行
      return { rows: [{ id: `tr-${state.rows.length}` }], rowCount: 1 };
    }

    // ---- INSERT（run 作用域：U5 putRound 的 (run_id, round) 半边）----
    if (/^INSERT INTO transcript_rounds\b/i.test(s)) {
      state.insertAttempts += 1;
      const [runId, round, record, folded, messages, foldedPayload] = params;
      if (findRunRow(runId, round)) {
        if (!/ON CONFLICT \(run_id, round\)[\s\S]*DO NOTHING/i.test(s)) {
          throw new Error('duplicate key value violates unique constraint "transcript_rounds_run_id_round_key"');
        }
        state.conflictSkips += 1;
        return { rows: [], rowCount: 0 };
      }
      state.rows.push({
        transcript_key: null,
        dedup_key: null,
        run_id: runId,
        round,
        record: JSON.parse(record),
        folded: folded === true,
        messages: messages == null ? [] : JSON.parse(messages),
        folded_payload: foldedPayload == null ? null : JSON.parse(foldedPayload),
        append_seq: next(),
        created_at: state.rows.length + 1,
      });
      if (!/RETURNING/i.test(s)) return { rows: [], rowCount: 1 };
      return { rows: [{ id: `tr-${state.rows.length}` }], rowCount: 1 };
    }

    // ---- 全量 load（0.16.0 起必须按 append_seq 出序）----
    if (/^SELECT round, dedup_key, record FROM transcript_rounds\b/i.test(s)
      && /WHERE transcript_key = \$1/i.test(s)) {
      const rows = state.rows
        .filter((r) => r.transcript_key === params[0])
        .sort((a, b) => (Number(a.round) - Number(b.round))
          || (Number(a.append_seq ?? a.created_at ?? 0) - Number(b.append_seq ?? b.created_at ?? 0)))
        .map((r) => ({ round: r.round, dedup_key: r.dedup_key, record: r.record }));
      return { rows, rowCount: rows.length };
    }

    // ---- 点查/撞键读回（loadByDedupKey 与 appendRound 的读面是同一条 SQL）----
    if (/^SELECT record\b/i.test(s) && /FROM transcript_rounds\b/i.test(s)
      && /WHERE transcript_key = \$1 AND dedup_key = \$2/i.test(s)) {
      const hit = findSessionRow(params[0], params[1]);
      if (!hit) return { rows: [], rowCount: 0 };   // 没存过 ⇒ 无行，绝不替产品造一条
      state.readBacks += 1;
      return { rows: [{ record: hit.record }], rowCount: 1 };
    }

    // ---- MAX(round)（成对快路径探针②）----
    if (/^SELECT MAX\(round\) AS max_round FROM transcript_rounds\b/i.test(s)) {
      const rounds = state.rows.filter((r) => r.transcript_key === params[0]).map((r) => Number(r.round));
      return { rows: [{ max_round: rounds.length === 0 ? null : Math.max(...rounds) }], rowCount: 1 };
    }

    return null;  // 不是本文件的 SQL 面，交回调用方派发
  }

  return { query, state, rowKey };
}

/** 0.22 引擎控制行的真实形状（`orchestrator.js:2123` `appendEngineMessagesToTranscript`）。 */
export function engineControlRow(key, {
  round = 3, slot = 'judge-nudge', ts = '2026-10-08T00:00:00.000Z',
  text = '评审意见：还差回归用例，继续。',
} = {}) {
  return {
    round,
    roundKey: `${key}:round:${round}`,
    dedupKey: `${key}:engine:round:${round}:control:${slot}`,
    messages: [{ role: 'user', meta: { source: 'judge-control' }, content: [{ type: 'text', text }] }],
    ts,
  };
}

/** 种子一条已存在的 session transcript 行（真列名形状，便于各 fake 直接塞进 rows）。 */
export function sessionTranscriptSeedRow(transcriptKey, {
  dedupKey, round, record, folded = false, messages = [], append_seq = 1,
}) {
  return {
    transcript_key: transcriptKey,
    dedup_key: dedupKey,
    run_id: null,
    round,
    record,
    folded,
    messages,
    folded_payload: null,
    append_seq,
    created_at: append_seq,
  };
}
