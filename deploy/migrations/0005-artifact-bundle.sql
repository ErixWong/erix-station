-- 0005-artifact-bundle.sql — issue #64 R1：run 终态 worktree 产物回收（bundle 登记）
--
-- v1 语义：一个 run 的终态产物打包为单个 tar.gz（diff.patch + 新文件快照 + manifest.json），
-- 经 internal API 上传 portal 落持久卷，artifacts 表登记一行（kind='worktree_bundle'）。
-- 幂等：同 run 同 kind 至多一行（UNIQUE 兜底，重复上传 409 artifact_exists，不覆盖）。
-- manifest 记录文件清单/大小/sha256/truncated（agentd 生成，portal 从 tar 内 manifest.json 抽出落 jsonb）。

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS manifest jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS artifacts_run_kind_key ON artifacts (run_id, kind);
