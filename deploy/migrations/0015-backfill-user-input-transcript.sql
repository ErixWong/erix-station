-- 0015-backfill-user-input-transcript.sql —— 为旧会话补齐 session transcript 中缺失的用户输入。
-- 动机：旧 POST 写路径只在 messages 表保存用户文本，未在同一事务写 transcript；真机抽查发现
--   64 个会话仅 2 个有 :input:<messageId> 行，且抽查会话的用户文本在 transcript 中 0 命中。
-- 选择回填而非删除老会话：保留已有对话数据，使旧会话可正常从 transcript 投影渲染，并安全移除
--   读路径的 messages 内容兜底。
-- 只增不改：仅 INSERT 缺少全文本证据的非合成 user 消息，绝不 UPDATE/DELETE 既有数据。
-- 幂等：查找时排除 transcript 中已存在的 JSON 字符串文本，唯一索引冲突再 DO NOTHING；
--   重复执行不会新增或改变已存在的行。round 使用每条消息所属 session 当前 transcript 的 max(round)，
--   ts 使用消息 created_at。迁移 runner 在单事务中执行。
WITH missing_user_messages AS (
  SELECT
    m.session_id,
    m.id,
    m.content,
    m.created_at,
    COALESCE((
      SELECT MAX(existing.round)
        FROM transcript_rounds AS existing
       WHERE existing.transcript_key = m.session_id::text
    ), 0) AS round
  FROM messages AS m
  WHERE m.role = 'user'
    AND m.synthetic = false
    AND NOT EXISTS (
      SELECT 1
        FROM transcript_rounds AS existing
       WHERE existing.transcript_key = m.session_id::text
         AND position(to_jsonb(m.content)::text IN existing.record::text) > 0
    )
),
rows_to_insert AS (
  SELECT
    session_id::text AS transcript_key,
    session_id::text || ':input:' || id::text AS dedup_key,
    round,
    created_at,
    jsonb_build_array(jsonb_build_object(
      'role', 'user',
      'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', content))
    )) AS transcript_messages
  FROM missing_user_messages
)
INSERT INTO transcript_rounds
  (run_id, transcript_key, dedup_key, round, record, folded, messages, folded_payload)
SELECT
  NULL,
  rows_to_insert.transcript_key,
  rows_to_insert.dedup_key,
  rows_to_insert.round,
  jsonb_build_object(
    'round', rows_to_insert.round,
    'roundKey', rows_to_insert.dedup_key,
    'dedupKey', rows_to_insert.dedup_key,
    'messages', rows_to_insert.transcript_messages,
    'ts', rows_to_insert.created_at
  ),
  false,
  rows_to_insert.transcript_messages,
  NULL
FROM rows_to_insert
ON CONFLICT (transcript_key, dedup_key) WHERE transcript_key IS NOT NULL DO NOTHING;
