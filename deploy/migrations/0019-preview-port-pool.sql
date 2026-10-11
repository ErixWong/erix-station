-- 0019-preview-port-pool.sql —— 预览端口全局号池 22000–29999 + 块分配落库（issue #246 交付①）
-- 背景：#240 的实现是「每个 FDE 都发同一段 4000–4009」（`portal/src/portalloc.js` 的固定常量
--   `PREVIEW_PORT_START=4000` + `PREVIEW_PORT_COUNT=10`），而既有唯一索引只按 FDE 判重
--   （`port_allocations_live_port_key UNIQUE (fde_id, port) WHERE state <> 'released'`）⇒ **跨 FDE
--   重叠完全不受约束**。真机后果（实测）：`eric` 与 `tetris` 同时持有 4000–4009 = 10 组重叠。
-- 决策（决策者 2026-10-11，issue #246）：全局唯一一个号池 **22000–29999**（8000 个号 = 800 段），
--   开户发「池内最小的未占用对齐块」（默认 10 个一段），**重叠 = 硬不变式，由 DB 保证**——应用层
--   因此不做「先查后插」的查重循环，只算候选块 + 把 23505 翻成可操作错误码后由调用方重试。
--
-- 四件事，**顺序不可换**（本文件的正确性完全建立在这个顺序上）：
--   ⓪ 先按名 DROP 旧 `port` CHECK → ① 重排存量活行进池 → ② `port` CHECK 换新口径 → ③ 建全局部分唯一索引
--   ⓪ 是 ① 的**前置条件**（TEMP 真库克隆实测出来的——issue #246 正文只列了三步，漏了这一条）：旧 CHECK 是
--     `port BETWEEN 4000 AND 4999`，与新池 **22000–29999 不相交** ⇒ 带着旧 CHECK 根本 UPDATE 不进池内，
--     ① 自己就会当场 23514（实测失败行正是 tetris 挪到 22010 的那条）。DROP 到 ② 之间 `port` 暂时无 CHECK，
--     但整个过程跑在迁移 runner 的**单个显式事务**里，而 `DROP CONSTRAINT` 持 ACCESS EXCLUSIVE 直到 COMMIT
--     ⇒ 并发事务既看不到无 CHECK 的中间态、也写不进脏端口；baseline 冻结 ⇒ 也不能靠回写 schema.sql 绕过。
--   * 先 ③ 后 ① ⇒ 建索引当场 `23505`：eric / tetris 各有 4000–4009 的活行；真机 PG **16.15** 的唯一
--     索引不支持 `NOT VALID`（PG 17 才有），建索引时**必须已经没有重复**。
--   * 先 ② 后 ① ⇒ `ADD CONSTRAINT` 当场 `23514`：新 CHECK 要校验存量，而存量活行还在 4000–4100。
--   * 不用 `CREATE INDEX CONCURRENTLY`：迁移 runner 在**显式事务**里执行本文件
--     （`portal/src/migrate.js` `BEGIN` → 执行整个文件 → 落 `schema_migrations` → `COMMIT`），
--     CONCURRENTLY 禁止在事务块内跑；本表实测 31 行，普通 `CREATE UNIQUE INDEX` 的持锁可忽略
--     （先例：`0016` 用普通 `CREATE INDEX IF NOT EXISTS`）。
--
-- `released` 历史行怎么保住：**CHECK 写成按状态分支**（照主 agent 定的解法）——活行必须落在池内，
--   已释放行保留历史号码。真机 `portsprobe` 有 10 行 `state='released'`、端口 4000–4009，若把 CHECK
--   收窄成「只能 22000–29999」，这些历史行会让 `ADD CONSTRAINT` 当场失败；① 的重排同样**只动活行**
--   （`released` 行既不重排也不改 hostname）。released 行不进新索引 ⇒ **号码可回收**（model.md §4：
--   reaper 硬删前留档，与「号码可复用」两不耽误）。
--
-- hostname / url 重写**不硬编码伞域**：base 域来自 `deploy/.env` 的 `BASE_DOMAIN`（#57 伞域语义，
--   现取 `fde.erix.vip`），迁移里写死域名会在别的部署上炸 ⇒ 只替换**首标签尾部的端口数字段**，
--   FDE 名与第一段之后的 base 全部原样保留；`url` 只替换 `://` 之后到第一个 `/` 或 `:` 之前的 host 段，
--   scheme 与非默认端口原样保留（与 `projects.previewUrl` 的生成口径一致）。
--
-- 块装不下的活行（真机只有 `tetris`：11 条活行 4000–4009 + 窗口外的 4100，块只有 10 个槽位）：
--   按 `(port, id)` 稠密顺序填前 10 个槽位，**第 11 条起置 `released`**（`released_at = now()`，满足
--   `CHECK ((state = 'released') = (released_at IS NOT NULL))`）——issue #246 给的两种处置是「并回块内
--   或置 released」，并回块内会侵吞下一个 FDE 的整块 ⇒ 取置 released。该行端口原样保留（released 分支
--   的 CHECK 允许 4000–29999），派生链由 portal 侧下次物化自动移除其路由（`routes.js` 只看活行）。
--
-- 幂等（README「单文件约定」，本文件可整体重放）：⓪ 与 ② 是同一头 CHECK 的 `DROP CONSTRAINT IF EXISTS`
--   → `ADD`（照 0017/0018 的幂等形状，只是被 ① 隔成两半）；① 的 UPDATE 只命中「活行且端口在池外」的行，
--   重放时待重排 FDE 集合为空 ⇒ 零改写；③ `IF NOT EXISTS`。
-- 冻结 baseline：`docs/data/schema.sql` **一个字节不改**（sha256 冻结，`migrate.js:138` 对整文件文本
--   含注释算哈希，失配即 refusing to start；同 0017/0018 的手法）。
-- 已接受的代价（issue #246）：eric / tetris 现有预览 URL 全部改写——`routes.yml` 与容器内
--   `~/.erix/ports.json` 由派生链自动跟上，但**容器内应用要改监听端口**，已发出去的旧链接失效。
SET lock_timeout = '5s';

-- ⓪ 摘掉旧的 `port` CHECK（理由见顶部「⓪ 是 ① 的前置条件」）。从这条语句起 `port` 没有 CHECK，直到 ② 补回；
--   单事务 + ACCESS EXCLUSIVE 持到 COMMIT ⇒ 没有第三方能在这个窗口里写入。表 31 行，锁窗口可忽略。
ALTER TABLE port_allocations DROP CONSTRAINT IF EXISTS port_allocations_port_check;

-- ① 重排存量**活行**进新池。确定顺序 = `users.fde_name`（无对应用户时回落 `fde_id` 文本，保证可复现）：
--   第 1 个待重排的 FDE 拿池内最小的空闲对齐块（22000–22009），下一个拿 22010–22019 …
--   「空闲」的判据是**整块**：块内只要有任何一条活行（哪怕端口本身没对齐，例如遗留行 22015）就整块跳过，
--   这样每段号始终属于唯一一个 FDE，与「块分配」的语义一致。
WITH live AS (
  SELECT id, fde_id, port, hostname, url
    FROM port_allocations
   WHERE state <> 'released'
),
mover AS (                                   -- 仍持有「池外活行」的 FDE，按 fde_name 定序
  SELECT l.fde_id,
         row_number() OVER (ORDER BY COALESCE(u.fde_name, l.fde_id::text)) - 1 AS rn
    FROM (SELECT DISTINCT fde_id FROM live WHERE port NOT BETWEEN 22000 AND 29999) AS l
    LEFT JOIN users AS u ON u.id = l.fde_id
),
occupied_block AS (                          -- 池内已被活行占住的对齐块（整块排除）
  SELECT DISTINCT port - port % 10 AS block_start
    FROM live
   WHERE port BETWEEN 22000 AND 29999
),
free_block AS (                              -- 池内空闲对齐块升序：22000 / 22010 / … / 29990
  SELECT gs AS block_start,
         row_number() OVER (ORDER BY gs) - 1 AS rn
    FROM generate_series(22000, 29999, 10) AS gs
   WHERE NOT EXISTS (SELECT 1 FROM occupied_block ob WHERE ob.block_start = gs)
),
slot AS (                                    -- 待重排的活行 → 该 FDE 的块 + 块内槽位号（1 起）
  SELECT l.id,
         l.port AS old_port,
         l.hostname,
         fb.block_start,
         row_number() OVER (PARTITION BY l.fde_id ORDER BY l.port, l.id) AS slot_no
    FROM live AS l
    JOIN mover AS m ON m.fde_id = l.fde_id
    JOIN free_block AS fb ON fb.rn = m.rn
   WHERE l.port NOT BETWEEN 22000 AND 29999
),
pieces AS (                                  -- 把 hostname 拆成「前缀 + 旧端口段 + base（第一段之后）」
  SELECT s.id,
         s.old_port,
         s.hostname,
         s.block_start,
         s.slot_no,
         substring(split_part(s.hostname, '.', 1) FROM '[0-9]+$')       AS old_port_digits,
         substr(s.hostname, length(split_part(s.hostname, '.', 1)) + 1)  AS base_suffix
    FROM slot AS s
),
renumbered AS (                              -- 新端口 + 新 hostname（只换首标签尾部端口段）
  SELECT id,
         CASE WHEN slot_no <= 10 THEN block_start + slot_no - 1 ELSE old_port END AS new_port,
         slot_no,
         (CASE WHEN slot_no <= 10 THEN block_start + slot_no - 1 ELSE old_port END)
           <> old_port AS port_changes,
         -- ⚠ **不要用 `lpad` 拼端口段**：PG 的 `lpad(text, width, fc)` 对**比 width 长的串会截断**
         --   （实测 `lpad('22010', 4, '0') = '2201'`），而写侧 `projects.buildHostname` 的
         --   `String(port).padStart(4, '0')` **不截断**。本单恰好把端口推到 5 位，用 lpad 会把
         --   `tetris-p-22010` 写成 `tetris-p-2201`（同块 10 行会塑成同一 hostname，当场 23505）。
         --   ⇒ 拼法：截到旧端口段之前 + 新端口原样十进制 + base 后缀。宽度自然增长，
         --     不依赖任何宽度常量，也**不硬编码伞域**（base 段从头到尾没动）。
         --   `old_port_digits IS NULL`（首标签不以数字结尾的历史形）时 hostname 不挪，
         --   由下面 ①' 守卫的第 2 条兜住（fail-closed，不留「域名指旧端口」的半截状态）。
         CASE WHEN slot_no <= 10 AND old_port_digits IS NOT NULL
              THEN left(hostname,
                        length(hostname) - length(base_suffix) - length(old_port_digits))
                   || (block_start + slot_no - 1)::text || base_suffix
              ELSE hostname END AS new_hostname
    FROM pieces
)
UPDATE port_allocations AS pa
   SET port        = r.new_port,
       hostname    = CASE WHEN r.port_changes THEN r.new_hostname ELSE pa.hostname END,
       url         = CASE WHEN r.port_changes
                          THEN regexp_replace(pa.url, '://[^/:]+', '://' || r.new_hostname)
                          ELSE pa.url END,
       state       = CASE WHEN r.slot_no <= 10 THEN pa.state      ELSE 'released' END,
       released_at = CASE WHEN r.slot_no <= 10 THEN pa.released_at ELSE now() END
  FROM renumbered AS r
 WHERE pa.id = r.id
   AND (r.slot_no > 10 OR pa.port <> r.new_port);

-- ①' 守卫（顺序依赖的自证）：重排之后仍有任何池外活行，就用可操作文案炸掉，而不是让下一条
--   `ADD CONSTRAINT` 抛裸 23514、或让 ③ 去撞 23505。触发条件只可能是「800 段号池已用尽」。
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM port_allocations
     WHERE state <> 'released' AND port NOT BETWEEN 22000 AND 29999
  ) THEN
    RAISE EXCEPTION '0019: 仍有 state <> released 的 port_allocations 行落在号池 22000-29999 之外（重排未完成或号池 800 段已用尽）；port CHECK 随即收窄，禁止带池外活行提交';
  END IF;
  IF EXISTS (
    SELECT 1 FROM port_allocations
     WHERE state <> 'released'
       AND split_part(hostname, '.', 1) !~ ('-' || port::text || '$')
  ) THEN
    RAISE EXCEPTION '0019: 存在活行的 hostname 首标签尾部端口段与 port 列不一致（重排漏改 hostname）；预览域名与路由会指到旧端口';
  END IF;
END
$do$;

-- ② `port` CHECK 补回号池口径（与 ⓪ 的 DROP 成对），**按状态分支**（见顶部「released 历史行怎么保住」）。
--   建成 VALID 而非 NOT VALID（与 0017 相反）：本迁移的正解就是「全部活行已在池内」，必须真校验
--   一遍存量（真校验才能证明 ① 的重排完整）；表 31 行，`ADD CONSTRAINT` 短暂持 ACCESS EXCLUSIVE +
--   全表扫描可忽略（0018 同一判断）。
--   只动这一条 CHECK：`port_allocations_check`（scope/run 条件）与 `port_allocations_check1`
--   （state/released_at 条件）原样保留，`0017` 的 hostname CHECK、0018 的 scope CHECK 也不动。
ALTER TABLE port_allocations ADD CONSTRAINT port_allocations_port_check CHECK (
  (state =  'released' AND port BETWEEN 4000  AND 29999)
  OR
  (state <> 'released' AND port BETWEEN 22000 AND 29999)
);

-- ③ 全局部分唯一索引：**跨 FDE 不重叠从此由 DB 保证**（活行内 `port` 全局唯一）。
--   * 部分谓词 `WHERE state <> 'released'` ⇒ `released` 的号码可以被后来的 FDE 复用。
--   * 与既有 `port_allocations_live_port_key (fde_id, port)` **并存**：写侧 `ON CONFLICT
--     (fde_id, port) WHERE state <> 'released' DO NOTHING` 的幂等语义不变（同 FDE 重跑零插入）；
--     跨 FDE 撞号时该冲突目标**不匹配**、`DO NOTHING` 不吞 ⇒ `23505` 冒到应用层，由
--     `portalloc.js` 翻成 `preview_port_block_taken`（文案含重试提示），调用方重取下一段。
--     ⇒ 并发安全由本索引提供，不需要 advisory lock，也不需要「先查后插」。
--   * 名字与语义对齐既有命名（`port_allocations_live_*`），`IF NOT EXISTS` 保重放。
CREATE UNIQUE INDEX IF NOT EXISTS port_allocations_live_global_port_key
  ON port_allocations (port) WHERE state <> 'released';
