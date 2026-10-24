# 会话账本巡检与修数据口径（`transcript_rounds`）

> 适用版本：erix-agent **0.23.x**（「一条消息一落盘」写侧）。归属：erix-station **#341** / 上游 **erix-agent #415**。
> 本文只讲**读**（巡检 SQL）与**修数据**（可重放的 UPDATE）口径；**本文不含任何在本次交付里执行过的 SQL**。

---

## 0. 为什么会有这篇

0.23.0 起，一轮的正文不再写在轮记录上，而是**一条消息一成型就落一行** `kind: "message"`
（`dedupKey = <key>:msg:<round>:<seq>`，`seq` 轮内从 0 递增）。一轮里的多个 `tool_result` 本该是
**同一条** user 消息的多个 content block，现在各写一行，靠 `partOf` 指认「我是哪条逻辑消息的分片」。

写侧（`erix-agent/src/loop/orchestrator.js`）落分片时是**覆盖式**的：

```js
// 每落一片就覆盖一次 ⇒ 第 3 个并行工具调用起，partOf 指向的是**前一片分片行**
const persistedRowKey = await appendMessageRowToTranscript(
  { role: "user", content: [toolResult] },
  round,
  toolResultRowKey === undefined ? {} : { partOf: toolResultRowKey },
);
if (persistedRowKey !== undefined) toolResultRowKey = persistedRowKey;
```

于是账本里出现**链式** `partOf`：`msg:1:3 → msg:1:2 → msg:1:1`（而不是都指 `msg:1:1`）。

**后果分两面**：

| 面 | 现状 |
|---|---|
| 站内展示投影（`portal/src/session-view.js#projectSessionMessages`） | **自 #341 起已解链**（`portal/src/transcript-fold.js#planFold` 让分片行也登记自己的 key）⇒ 折叠回 1 条聚合 `tool_result`，与 0.22 形状一致 |
| **引擎 resume**（`foldLedgerMessages` + `validateMessages`） | **仍会坏**：上游 `foldMessageRows` / `foldLedgerMessages` 只认「一跳」，链上第 2 片起查不到目标 ⇒ 一条聚合 `tool_result` 被劈成多条 user 消息 ⇒ `invalid_messages`，会话永久卡死。⚠ **「本站修不了，只能修数据」2026-10-24 作废**：本站 `transcript-fold.js` 是上游读侧的**超集**（链式也解），差的只是把它接到**引擎面向的** `store.load()`（§5 + [#351](https://github.com/ErixWong/erix-station/issues/351)，**尚未实现**） |

> **⚠ 口径更正（2026-10-24，#351）**：旧版那句「引擎 resume 侧本站修不了，只能修数据（等上游 #415）」**作废**。
> 同一份链式 `partOf` 夹具实测：上游 `foldMessageRows` **FAIL**（`tool_result ids do not match…`，user 消息被劈成 2 条）、
> 本站 `transcript-fold` **OK**（1 条）⇒ 本站那份折叠是上游读侧的**超集**。引擎 resume 读的是 `store.load()`，
> 而本站 `runner/lib/store.js` 直通 portal 原始行 ⇒ **引擎从来没经过任何折叠**。
> 契约依据：`host-consumer-contract.md:2405-2409`（`foldMessageRows` 由内置 store 的 `load()` 调用）与 `:2442`（宿主读账本必须经 `load()`）；
> `src/loop/resume-manager.js:239-241` 的 `seq` 播种本就为**折叠后的** `load()` 输出设计。
> 修法与要钉的回归锁在 #351；上线后 §2 的修数据降级为兜底、已砖会话读侧自愈。上游同题 [#458](https://github.com/ErixWong/erix-agent/issues/458)。

> ⚠ 另一个已实测的边界（别拿它当「没坏」的证据）：站内投影对链式 `partOf` **不显症状** ——
> 上游 `src/display/projection.js#toolResultsOf(messages)` 扫整条 record 的全部 messages 并按
> `tool_use_id` 建 Map，被劈出去那条 user 消息里的 `tool_result` 照样配得上对。所以**「页面看起来正常」
> 不代表账本没链**；判断只能靠下面的巡检 SQL。

---

## 1. 巡检（只读）

### 1.1 计数：有多少行「`partOf` 指向的行本身也带 `partOf`」

```sql
SELECT count(*) AS chained_partof_rows
  FROM transcript_rounds a
 WHERE a.record ? 'partOf'
   AND EXISTS (SELECT 1 FROM transcript_rounds b
               WHERE b.transcript_key = a.transcript_key
                 AND b.record->>'dedupKey' = a.record->>'partOf'
                 AND b.record ? 'partOf');
```

**期望值：`0`。**
`> 0` ⇒ 这些会话在**引擎侧 resume 会坏**（`invalid_messages`）。站内投影自 #341 起能解链（刷新后正文/工具
卡片都正常），但**引擎 resume 仍需修数据**（§2）。

### 1.2 定位：是哪些会话、哪些轮

```sql
SELECT a.transcript_key,
       a.round,
       a.record->>'dedupKey' AS dedup_key,
       a.record->>'partOf'   AS part_of,
       a.append_seq,
       a.created_at
  FROM transcript_rounds a
 WHERE a.record ? 'partOf'
   AND EXISTS (SELECT 1 FROM transcript_rounds b
               WHERE b.transcript_key = a.transcript_key
                 AND b.record->>'dedupKey' = a.record->>'partOf'
                 AND b.record ? 'partOf')
 ORDER BY a.transcript_key, a.round, a.append_seq;
```

按会话汇总（给「影响面」用；`transcript_key` 就是 session id 的文本形态，见迁移 `0015`）：

```sql
SELECT a.transcript_key,
       count(*)      AS chained_rows,
       min(a.round)  AS first_round,
       max(a.round)  AS last_round,
       max(a.created_at) AS last_seen
  FROM transcript_rounds a
 WHERE a.record ? 'partOf'
   AND EXISTS (SELECT 1 FROM transcript_rounds b
               WHERE b.transcript_key = a.transcript_key
                 AND b.record->>'dedupKey' = a.record->>'partOf'
                 AND b.record ? 'partOf')
 GROUP BY a.transcript_key
 ORDER BY chained_rows DESC;
```

要人话（会话标题 / 归属 FDE）就再 join 一次（`transcript_key` 是 text，`chat_sessions.id` 是 uuid）：

```sql
SELECT s.id AS session_id, s.title, s.user_id, agg.chained_rows, agg.first_round, agg.last_round
  FROM (/* 上面那条按会话汇总 */) agg
  LEFT JOIN chat_sessions s ON s.id::text = agg.transcript_key
 ORDER BY agg.chained_rows DESC;
```

### 1.3 单轮形状自检（修完复验 / 抽样看「一条聚合消息」）

```sql
-- 该轮的分片行有几条、它们的 partOf 指向谁（修好后应当全部指向**同一条**首片的 dedupKey）
SELECT a.round,
       a.record->>'dedupKey' AS dedup_key,
       a.record->>'partOf'   AS part_of
  FROM transcript_rounds a
 WHERE a.transcript_key = $1
   AND a.record ? 'partOf'
 ORDER BY a.round, a.append_seq;
```

---

## 2. 修数据口径（递归解链到链头）

> **2026-10-24 定位**：本节是**兜底手段**（只治链式 `partOf` 一类）。#351 的折叠接线上线后新会话不再需要修数据、
> 已砖会话读侧自愈；在那之前它仍是引擎侧唯一可用的修法。今天真机那次修数据见 §5。

**要改的只有一件事**：把每个**分片行**的 `record.partOf` 改成**链头**的 `dedupKey`
（= 该轮那条「自己不带 `partOf`」的首片行）。改完链就退化成「一跳」，上游 `foldMessageRows` /
`foldLedgerMessages` 立刻能折回一条聚合消息。**不新增行、不删行、不动 `messages` 派生列、零 DDL。**

### 2.0 先做这三件事（顺序不能变）

1. **备份**（就地快照；只快照带 `partOf` 的行，够回滚）：
   ```sql
   CREATE TABLE transcript_rounds_partof_backup_20261023 AS
   SELECT id, transcript_key, round, record
     FROM transcript_rounds
    WHERE record ? 'partOf';
   ```
2. **在临时库演练一遍**（`createdb station_rehearsal` → `psql -f docs/data/schema.sql` + `deploy/migrations/*`
   或直接从备份库 `pg_dump | pg_restore` 一份），确认 §2.1 的 `SELECT` 与 §2.2 的 `UPDATE` 行数一致、
   第二遍 `UPDATE` 影响 **0 行**。
3. **先看 diff 再动手**：§2.1 是同一份逻辑的只读版本，输出就是「哪一行从哪个 key 改成哪个 key」。

> 本文**不在本次交付里对任何真库执行 SQL**（dev 库由主 agent 管）。

### 2.1 预演（只读）：解链后的目标值

```sql
WITH RECURSIVE hop AS (
  -- 起点：每个带 partOf 的分片行
  SELECT a.id            AS start_id,
         a.transcript_key,
         a.record->>'partOf' AS target_key,
         1               AS depth
    FROM transcript_rounds a
   WHERE a.record ? 'partOf'
  UNION ALL
  -- 一跳一跳往下走：目标行自己还带 partOf ⇒ 继续追它的 partOf
  SELECT hop.start_id,
         hop.transcript_key,
         b.record->>'partOf',
         hop.depth + 1
    FROM hop
    JOIN transcript_rounds b
      ON b.transcript_key = hop.transcript_key
     AND b.record->>'dedupKey' = hop.target_key
   WHERE b.record ? 'partOf'
     AND hop.depth < 32          -- 防环（真链最长 = 该轮并行工具数，32 足够）
),
resolved AS (
  SELECT DISTINCT ON (start_id)
         start_id,
         target_key AS head_key,   -- 最后一跳的 target = 链头（自己不带 partOf 的那条）的 dedupKey
         depth
    FROM hop
   ORDER BY start_id, depth DESC
)
SELECT t.transcript_key,
       t.round,
       t.record->>'dedupKey' AS dedup_key,
       t.record->>'partOf'   AS part_of_now,
       r.head_key            AS part_of_after,
       r.depth               AS chain_depth
  FROM transcript_rounds t
  JOIN resolved r ON r.start_id = t.id
 WHERE t.record->>'partOf' IS DISTINCT FROM r.head_key
 ORDER BY t.transcript_key, t.round, t.append_seq;
```

**幂等自证**：已经指向链头的行，最后一跳的 `target_key` 就是它当前的 `partOf` ⇒ 被
`IS DISTINCT FROM` 过滤掉，不出现在结果里（重放 = 0 行）。

### 2.2 修数据（可重放、幂等）

```sql
WITH RECURSIVE hop AS (
  SELECT a.id AS start_id, a.transcript_key, a.record->>'partOf' AS target_key, 1 AS depth
    FROM transcript_rounds a
   WHERE a.record ? 'partOf'
  UNION ALL
  SELECT hop.start_id, hop.transcript_key, b.record->>'partOf', hop.depth + 1
    FROM hop
    JOIN transcript_rounds b
      ON b.transcript_key = hop.transcript_key
     AND b.record->>'dedupKey' = hop.target_key
   WHERE b.record ? 'partOf'
     AND hop.depth < 32
),
resolved AS (
  SELECT DISTINCT ON (start_id) start_id, target_key AS head_key
    FROM hop
   ORDER BY start_id, depth DESC
)
UPDATE transcript_rounds t
   SET record = jsonb_set(t.record, '{partOf}', to_jsonb(r.head_key))
  FROM resolved r
 WHERE t.id = r.start_id
   AND t.record->>'partOf' IS DISTINCT FROM r.head_key;
```

要点：

- **只改 `record.partOf`**（`jsonb_set` 单键），record 里其他字段与 `messages` / `folded` / `folded_payload`
  派生列一个字节不动。
- **幂等**：第二遍跑 `UPDATE 0`。**不会**把已经正确的行改坏，也不依赖跑几次。
- **悬空 `partOf`**（目标行不在命中集里，比如分页切在轮中间）**不会被动**：`hop` 只有深度 1 那一跳，
  `head_key` 就是它原来的 `partOf` ⇒ 被 `IS DISTINCT FROM` 排除。
- **`record->>'dedupKey'` 与 `dedup_key` 列等价**（写侧派生：`dedup_key = record.dedupKey ?? record.roundKey`，
  迁移 `0006` 的部分唯一索引 `(transcript_key, dedup_key)` 保证同 key 单行）。巡检 SQL 沿用
  `record->>'dedupKey'`（与 §1 一致，也是引擎 `foldMessageRows` 的判据口径）。

### 2.3 复验

1. 重跑 §1.1 ⇒ **必须是 `0`**。
2. 重跑 §2.2 ⇒ **`UPDATE 0`**（幂等自证）。
3. 抽查 §1.3：某一轮的所有分片行 `part_of` 全部等于同一条首片的 `dedupKey`。
4. 真机：挑一个修过的会话发一条消息（触发 resume 读上下文）⇒ 不再 `invalid_messages`。
   **已经因 `invalid_messages` 失败的 run 需要重发**（修数据只修账本，不会自动重跑）。

### 2.4 回滚

```sql
UPDATE transcript_rounds t
   SET record = b.record
  FROM transcript_rounds_partof_backup_20261023 b
 WHERE t.id = b.id;
```

⚠ 回滚是**整条 record 覆盖**，只有在备份之后这些行没被别的东西写过时才安全（演练库上无所谓，真库上
先确认 `created_at`/`append_seq` 没长出新行）。回滚完把备份表 `DROP TABLE` 掉，别留着当第二真相源。

---

## 3. 别做的事

- **不要**在巡检阶段跑任何写语句（本文 §1 全是只读）。
- **不要**新增迁移文件或改 `docs/data/schema.sql`：这次修数据是**运维动作**，不是 schema 变更（零 DDL）。
- **不要**顺手「重写整条 record」或「把分片行合并成一行」：那会破坏 `dedup_key` 幂等与 `append_seq` 保序，
  而 `partOf` 改指链头已经足够让读侧折回一条聚合消息。
- **不要**把「页面看起来正常」当作账本没问题的证据（§0 的边界说明）。

---

## 4. 与代码侧的关系（谁负责什么）

| 环节 | 责任方 | 状态 |
|---|---|---|
| 写侧把 `partOf` 写成链 | erix-agent（`orchestrator.js`） | 0.23.x 现状 |
| 读侧折叠只认一跳 | erix-agent（`store/message-rows.js#foldMessageRows` / `#foldLedgerMessages`） | 上游 **#415** 未修 |
| 站内展示投影解链 | erix-station（`portal/src/transcript-fold.js#planFold`，**临时闸**） | **#341 已交付**；上游落地并升 pin 后撤闸（源码级哨兵会变红提示） |
| **引擎 resume 面解链** | erix-station（把同一份折叠接到 `runner/lib/store.js#load`，agentd 游标聚合之后） | **待做 = #351**（本单从「只能修数据」改判为「站内可修」） |
| 引擎 resume 的账本修数据 | 运维（本文 §2） | 每次升级/巡检后按 §1 判、按 §2 修 |

---

## 5. 第二种砖化形状：`:input:` 行插队（2026-10-24 真机记录，#351）

**§1 的巡检 SQL 测不到这一类**（当天全库链式 `partOf` = **0 行**，手册判「干净」的会话照样砖了 4 个 run）。

真因不是链：被**手动停止**那一轮的 `tool_result` 要到**下一次 run resume** 才补落盘，而宿主 `:input:` 行是发消息**当场**写的（#162 顺序红线）⇒ 同一轮内 `append_seq` 顺序反了，`tool_use` 与它的结果之间夹了一条 user text：

```text
1122  msg:28:0                assistant + tool_use#…964e9a6c
1123  input:092e8586-…        user text（发消息时预写）       ← 插在中队
1124  msg:28:1                user tool_result → …964e9a6c   ← resume 时才补落盘
1125  engine:round:28:resume  崩溃轮载体行（messages: []）
```

上游 `host-consumer-contract.md:2432-2437` **逐字**描述的就是这个形状，并说它「由折叠消化」——前提是宿主 `load()` 做了折叠（§0 更正）。

### 5.1 新增巡检项（与 §1.1 并列，两条都要跑）

```sql
-- 被同轮引擎消息行「超车」的 :input: 行 = 会砖化的插队；期望 0 行
SELECT t.transcript_key, t.round, t.dedup_key, t.append_seq
  FROM transcript_rounds t
 WHERE t.dedup_key LIKE '%:input:%'
   AND EXISTS (SELECT 1 FROM transcript_rounds y
                WHERE y.transcript_key = t.transcript_key AND y.round = t.round
                  AND y.record ? 'seq' AND y.append_seq > t.append_seq);
```

> **两条谓词是一套，必须一起跑**（§1.1 查链、§5.1 查插队）——它们是同一类后果的两种形状。
> 清掉一种，另一种就会在下一次 resume 显形：2026-10-24 实测，`index 56`（插队）用 §5.2 清掉后同会话
> **成功跑了一轮**（rounds 37–43；其间 3 个并行工具调用又被上游写成链），**8 分钟**后下一次 resume 报
> `index 81`（链，只有 §2.2 能清）。⇒ **修一条 ≠ 这个会话干净**，修完必须两条谓词都归 0。
> 想一次性免疫两类：把折叠接到引擎面向的 `store.load()`（#351）；根治在上游 #415（别再写链）。

### 5.2 修数据（只动排序键；`record` 逐字节不变、零增删行、零 DDL、幂等）

`append_seq` 走 `nextval` ⇒ 后续新行仍排在被改行之后（**不要**手填一个中间值，会撞既有行）。

```sql
BEGIN;
CREATE TABLE IF NOT EXISTS transcript_rounds_input_seq_bak_20261024 (
  id uuid PRIMARY KEY, transcript_key text, round int, dedup_key text, append_seq bigint);
INSERT INTO transcript_rounds_input_seq_bak_20261024
SELECT t.id, t.transcript_key, t.round, t.dedup_key, t.append_seq FROM transcript_rounds t
 WHERE t.dedup_key LIKE '%:input:%'
   AND EXISTS (SELECT 1 FROM transcript_rounds y
                WHERE y.transcript_key = t.transcript_key AND y.round = t.round
                  AND y.record ? 'seq' AND y.append_seq > t.append_seq)
   AND NOT EXISTS (SELECT 1 FROM transcript_rounds_input_seq_bak_20261024 b WHERE b.id = t.id);

WITH need AS (
  SELECT t.id FROM transcript_rounds t
   WHERE t.dedup_key LIKE '%:input:%'
     AND EXISTS (SELECT 1 FROM transcript_rounds y
                  WHERE y.transcript_key = t.transcript_key AND y.round = t.round
                    AND y.record ? 'seq' AND y.append_seq > t.append_seq))
UPDATE transcript_rounds t SET append_seq = nextval('transcript_rounds_append_seq_seq')
  FROM need WHERE t.id = need.id;
COMMIT;
```

### 5.3 当天取证与复验（手法值得复用：**把真账本行喂进引擎自己的折叠/校验**）

| 步骤 | 结果 |
|---|---|
| 修前：真 124 行按生产读序（`round, append_seq`）喂 `foldLedgerMessages` + `validateMessages` | **FAIL `index 56`**，与界面文案逐字一致 |
| 同一批行先过上游 `foldMessageRows` | **OK**（76 条逻辑消息，124 行 → 44 行）⇒ **同一账本装进上游内置 store 不砖** = 「宿主侧修、不等上游」的定案依据 |
| 修后：dev 库 14 个账本会话逐个跑 | **0 失败** |
| 谓词复验 | **0 行**（幂等自证）；被改的行恰 1 行（`1123 → 1159`） |

- 回滚（比 §2.4 的整条 record 覆盖更窄，只回滚排序键）：
  `UPDATE transcript_rounds t SET append_seq = b.append_seq FROM transcript_rounds_input_seq_bak_20261024 b WHERE t.id = b.id;`
- ⚠ 修数据**不会**重跑已失败的 run（当天 4 次 `failed` 需用户重发一次消息）。
- ⚠ 失败的每次发消息都在账本里留下一条**没被回答的 `:input:` 行**（当天 3 条），下一次 resume 会把它们一起喂给模型——既有口径，不是新缺陷。
