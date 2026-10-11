-- 0020-preview-grant-revoke-repair.sql —— 清掉「已释放 allocation 上仍 active」的预览凭证残渣（issue #252／工单 fix-261011-B）
--
-- 病灶（真机实测，别重复调研）：撤预览 grant 的谓词写的是 `state IN ('active','used')`，而 baseline
-- `preview_grants` 的 CHECK 是**双向**的（docs/data/schema.sql §4，冻结件）：
--     CHECK ((state = 'used')    = (used_at    IS NOT NULL))   -- = preview_grants_check3
--     CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
-- ⇒ 只要 FDE 签过票并跳转（ticket 被消费成 `used`，真机 45 条），「释放端口 = 同事务撤 grant」那条
--   UPDATE 必撞 23514：真机原文 `new row for relation "preview_grants" violates check constraint
--   "preview_grants_check3"`（`portal/src/portalloc.js` 的 `moveFdePreviewBlock`，PR #251 验收时 500）。
--   更隐蔽的是 `offboarding.js`：撤权当时包在「本次真的释放了行」的守卫里 ⇒ 撞 CHECK 的那笔事务整体回滚，
--   步骤却记成 `done`、`last_error` 为空；此后重试时本 FDE 已无活行 ⇒ 守卫为假、撤权整段**静默跳过**，
--   残渣永久留在**已释放**的 allocation 上（实测 21 条：`session|active` 10、`ticket|used` 10、`ticket|active` 1）。
--   代码侧同时修：谓词改 `state = 'active'`（`offboarding.js` 与 `portalloc.js:moveFdePreviewBlock`）、
--   撤权改为按 allocation ids **无条件幂等**发（不再挂在「本次释放了行」上）。本迁移负责清存量残渣。
--
-- 本文件只做一件事：把**仍然授予访问**的残渣（`state='active'` 且其 allocation 已 `released`）置 revoked。
--
-- 为什么只修 active：`forwardAuth` 只认 `state='active'`（portal.md §2.7 第 2 步）⇒ 只有 active 还在
--   「授予访问」。`expired` 由 reaper 清、`revoked` 已是终态，都不打扰。
--
-- 为什么不碰 used（**故意**，不是漏了）：`used` 是**历史事实**——ticket 已被消费、`used_at` 非空，
--   它本身早已不再授予访问；真正还活着的是它派生出的 `session` 行（`parent_ticket_id` 指向它），
--   而 session 是 active、会被上面那条谓词单独撤掉。把 used 也塞进 `revoked` 只有两种写法，都错：
--     ① 只改 `state` ⇒ 当场撞 `(state='used') = (used_at IS NOT NULL)`，即本迁移在修的那个 23514；
--     ② 顺手 `used_at = NULL` ⇒ 过 CHECK，但抹掉「这张票何时被谁消费」的审计事实（**篡改历史**，
--        也等于把同一条双向约束换个方式撞掉）。
--   ⇒ `used` 行保留原状；重放前后 `used` 的行数与 `used_at` 必须一字不变（单测与真机重放都钉住）。
--
-- 幂等（README「单文件约定」：本文件可整体重放）：UPDATE 只命中 `state='active'` 且 allocation 已 released
--   的行，跑完它们就成了 revoked ⇒ 第二次跑待修集合为空 ⇒ **零行变更、不报错**（前置的 NOTICE 会打印
--   待修条数，重放时是 0，这条可观测性就是重放证据）。`revoked_at` 用 `COALESCE` 不覆盖既有值，
--   以满足 `CHECK ((state='revoked') = (revoked_at IS NOT NULL))`；active 行按同一 CHECK 恒为 `revoked_at IS NULL`。
--   纯数据修复：**无 DDL、不新建索引**，因此 `docs/data/schema.sql` 一字节不改（sha256 冻结 baseline，
--   失配即 `refusing to start`，见 `portal/src/migrate.js` 与本目录 README）。
--
-- 量级：真机待修 21 条（其中 active 11 条）；`preview_grants_allocation_idx` 已存在，
--   `EXISTS` 走 `port_allocations` 主键 ⇒ 锁窗口可忽略，仍按纪律设 `lock_timeout`。
SET lock_timeout = '5s';

-- ① 观测：先报「本次要撤几条」。重放到第二遍时这条 NOTICE 必须写 0 条（幂等的可观测证据）。
DO $do$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
    FROM preview_grants AS pg
    JOIN port_allocations AS pa ON pa.id = pg.allocation_id
   WHERE pg.state = 'active'
     AND pa.state = 'released';
  RAISE NOTICE '0020: 待撤残渣（已释放 allocation 上仍 active）% 条；used/expired/revoked 一律不动（#252 口径）', n;
END
$do$;

-- ② 撤权：只撤 active，且只撤「allocation 已 released」的残渣（活 allocation 上的 active 凭证是正常状态，
--    它属于还没结束的预览，一条都不该被碰）。
UPDATE preview_grants AS pg
   SET state      = 'revoked',
       revoked_at = COALESCE(pg.revoked_at, now())
  WHERE pg.state = 'active'
    AND EXISTS (
      SELECT 1 FROM port_allocations AS pa
       WHERE pa.id = pg.allocation_id
         AND pa.state = 'released'
    );

-- ③ 守卫（自证）：撤完仍有任何 active 凭证挂在已释放 allocation 上，就说明 ② 的谓词被人改窄了——
--    带表名与例外的 RAISE 换掉「静默留下残渣」。单行 SELECT + RAISE，不写库、可重放。
DO $do$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
    FROM preview_grants AS pg
    JOIN port_allocations AS pa ON pa.id = pg.allocation_id
   WHERE pg.state = 'active'
     AND pa.state = 'released';
  IF n > 0 THEN
    RAISE EXCEPTION '0020: 仍有 % 条 state=active 的 preview_grants 挂在 state=released 的 port_allocations 上（② 的谓词漏了分支？），残渣会让已释放的预览域名继续可判定', n;
  END IF;
END
$do$;
