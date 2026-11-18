-- 0044-macro-skipped-reason-review-unavailable.sql —— issue #676（丙=止血）
--
-- 背景：M9「完成审查」降级为「只出事实、不下判决」——审查暂不可用时落
--   `macro_runs.status='skipped'` + `skipped_reason='review_unavailable'`（`verdict` 保持 NULL，
--   绝不冒充 `done|unclassified` 假绿）。`SKIPPED_REASON`（`shared/macro-kinds.js`）已加这一档，
--   但 `macro_runs.skipped_reason` 的 CHECK（迁移 0035 建表时内联，八种穷举）不认这个新值
--   ⇒ 写入被 DB 约束拒（`status` 被迫落 failed）。
--
-- 为什么新迁移、而不是回改 0035：
--   * migrate.js 按 sha256 记 checksum，**改既有迁移字节 = 现存库全部拒启**（migrate.js 头部红线）；
--   * 0035 自己的语义闸禁止文件内出现 `ALTER TABLE macro_`（「删/改既有东西要另开一支迁移」）。
--   ⇒ 只能追加这一支，DROP + ADD 把 CHECK 拓宽到九种。
--
-- 幂等：`DROP CONSTRAINT IF EXISTS` 先清旧约束、再 ADD 新的（含 `review_unavailable`）；
--   重放（同库第二次）DROP 命中旧约束再 ADD，语义不变。保留 `cancelled_by_user` ⇒
--   0035 的「八种门禁不全」守卫（`NOT LIKE '%cancelled_by_user%'`）依旧满足。
ALTER TABLE macro_runs DROP CONSTRAINT IF EXISTS macro_runs_skipped_reason_check;
ALTER TABLE macro_runs ADD CONSTRAINT macro_runs_skipped_reason_check CHECK (
  skipped_reason IN (
    'budget_exhausted', 'quiet_hours', 'human_present', 'run_in_progress',
    'deferred', 'deferred_timeout', 'active_run_in_cwd', 'cancelled_by_user',
    'review_unavailable'
  )
);
