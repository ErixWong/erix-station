-- 0018-port-allocations-scope-fde.sql —— port_allocations.scope 放开第三个值 'fde'（#240）
-- 背景：开户预分配 10 条**FDE 级**预览域名（决策者 2026-10-11 裁决，fde-platform.md §7.2 第 3 步 /
--   §8.2 修订）。粒度既不是项目级（P5「目录即项目」已把项目注册制退役，迁移 0008 顺手 DROP 了
--   port_allocations.project_id）也不是 run 级（run 级端口块仍是 P2），而是「一个 FDE 工位一组固定的
--   预览域名」⇒ 需要新的 scope 值。baseline（docs/data/schema.sql §4）里 scope CHECK 只有
--   ('project','run')，而 baseline 是 sha256 冻结的（migrate.js:138 对整文件文本含注释算哈希，
--   改一个字节就 refusing to start）⇒ DDL 只能走本增量文件。
-- 只改这一条 CHECK：
--   * `CHECK ((scope = 'run') = (run_id IS NOT NULL))`（conname `port_allocations_check`）**原样保留**
--     ——scope='fde' 的行 run_id 恒为 NULL，与该条件约束自洽（scope<>'run' ⇒ run_id 必须为 NULL）。
--   * `port` CHECK（4000–4999）、`role` CHECK（含 'spare'）、`exposure`/`state` CHECK 天然满足，不动。
--   * **不新建任何索引**：幂等靠 baseline 既有的部分唯一索引
--     `port_allocations_live_port_key UNIQUE (fde_id, port) WHERE state <> 'released'`
--     （portal/src/portalloc.js 的 INSERT 用 ON CONFLICT + 同谓词做冲突目标推断）。
--     注意该索引**不能**改成全表 UNIQUE(fde_id,port)：released 历史行要留档（model.md §4 reaper 前不硬删）。
-- 存量数据一律不迁移：真机现存 4 行全是 P5 之前手工插的 scope='project'（含 tetris 的 4100，在
--   4000–4009 窗口之外）；routes.js:382 生成路由时只看 state<>'released' 与 hostname、不看 scope，
--   所以遗留行继续有效，新写的行才用 scope='fde'（不改、不删、不回填）。
-- 为什么不是 NOT VALID（与 0017 不同）：新集合是旧集合的**超集**，存量行必然仍然满足，校验不可能
--   失败；ADD CONSTRAINT 会短暂持 ACCESS EXCLUSIVE 并全表扫描，本表规模 = FDE 数 × 10（每 FDE 固定
--   10 条），扫描可忽略，故直接建成 VALID，省掉「事后人工 VALIDATE」这一步运维欠账。
-- 幂等：DROP CONSTRAINT IF EXISTS → ADD，可整体重放（README「单文件约定」；已应用后不再回改）。
SET lock_timeout = '5s';

ALTER TABLE port_allocations DROP CONSTRAINT IF EXISTS port_allocations_scope_check;
ALTER TABLE port_allocations ADD CONSTRAINT port_allocations_scope_check
  CHECK (scope IN ('project', 'run', 'fde'));
