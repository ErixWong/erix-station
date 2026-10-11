# deploy/migrations/ — 增量 DB 迁移目录

> 依据：`docs/design/deploy-contract.md` §3。本目录自 **0001** 起已有实际增量迁移
> （`0001-idempotency-keys.sql`，portal.md §1.4 幂等台账）；命名/顺序/幂等规则供迁移 runner
> （`portal/src/migrate.js` 读取）与后续轮次使用。
>
> **baseline 已冻结**：`docs/data/schema.sql`（`version='0000_baseline'`）自 P1 起不可再改——
> 改它会让 `00-init.sh`/runner 记录的真实 `sha256` 失配，runner 直接拒绝启动（§3.2 防改历史）。
> 新增 DDL 一律写成新编号迁移文件（本目录），**不**回写 baseline。
>
> **已应用的迁移文件同样不可再改（2026-10-08 实测确认）**：runner 对**每个**已应用迁移记录 `sha256`
> （`schema_migrations.checksum`），失配即拒绝启动——**连注释都不能改**。因此「补一句说明/修一个 typo」
> 的正确做法是写进本文档或新迁移，**绝不回改历史迁移文件**；排查线索也写在这里（见文末「排障」）。

## 目录职责

- 本目录存放**增量 DDL 迁移**（`baseline = docs/data/schema.sql` 之后的 schema 演进）。
- baseline（`schema.sql`）与 `bootstrap.sql` **不放在这里**：前者是自包含 baseline，后者是
  超级用户附加初始化（角色属性/授权/ownership 归正），均由部署侧 superuser bootstrap 处理。
- 迁移 runner 按文件名升序应用本目录下所有 `*.sql`，并以 `version = 文件名去 .sql` 落
  `schema_migrations` 台账。

## 命名与顺序

- 文件名：`NNNN-<slug>.sql`，`NNNN` 为四位递增序号（`0001`、`0002`、…），`<slug>` 为
  小写 kebab-case 简短描述。
- 顺序 = 文件名升序（`sort`）。**已应用的迁移文件不得再修改**（见下「单文件约定」）。

## 单文件约定

- 每个迁移文件在 **Postgres 单事务内**执行（runner 会 `BEGIN` → 执行 → `INSERT INTO
  schema_migrations` → `COMMIT`），失败整体回滚、不写台账行。
- 数据迁移（有损 / 大表 rewrite）必须显式 `SET lock_timeout` / `SET statement_timeout`
  并保持幂等（`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` 等），见 deploy-contract §3.2。
- **已应用的迁移不得再修改**：runner 记录每个迁移文件的 `sha256`，改动即失配、拒绝启动。
  未发布（未进入任何已部署库）的迁移可以在同一个 PR 内迭代，但发布后只能追加新编号。
- 迁移内新建的表/序列自动获得 `station_portal` 的最小 DML 授权——baseline 已设
  `ALTER DEFAULT PRIVILEGES FOR ROLE station_platform`（schema.sql §10），无需在迁移里重复 `GRANT`。

## 镜像与执行

- portal 镜像（`portal/Dockerfile`）`COPY deploy/migrations/`，容器内路径 `/app/deploy/migrations`
  （= `migrate.js` 的 `defaultMigrationsDir()`）。
- 执行方：`node portal/src/cli.js migrate`（或 `MIGRATE_ON_START=1`，portal 在**监听端口前**应用），
  身份 `station_platform`（`MIGRATE_DATABASE_URL`，DDL），见 deploy-contract §3.1。
- 现状：增量迁移已包含 `0001-idempotency-keys.sql`（写操作幂等台账）至
  `0019-preview-port-pool.sql`（**#246 交付①：预览端口全局号池 `22000–29999` 与块分配**——四条语句的
  **顺序不可换**：⓪ 按名 `DROP CONSTRAINT IF EXISTS port_allocations_port_check` → ① 重排存量**活行**
  进号池（按 `fde_name` 定序，一人一个 10 个的对齐块；`hostname`/`url` 的端口段**同事务**重写，base 域从旧
  hostname 反推、**不硬编码伞域**；装不下的溢出活行置 `released`；`released` 行一律不动⇒ 历史号码保留）
  → ①′ 守卫 DO 块（池外活行 / hostname 与端口不同步 ⇒ 带表名与例外的 RAISE，换掉裸 23514）
  → ② `port` CHECK 换为**按状态分支**（活行 `BETWEEN 22000 AND 29999`；`released` 行 `BETWEEN 4000 AND 29999`
  保留历史号码），建成 **VALID**（正解就是「活行全在池内」，要真校存量）→ ③ 新建全局部分唯一索引
  **`port_allocations_live_global_port_key UNIQUE (port) WHERE state <> 'released'`**（跨 FDE 不重叠由 DB
  保证；`released` 不占位 ⇒ 号码可复用；普通 `CREATE UNIQUE INDEX`，**`CONCURRENTLY` 在显式事务里不可用**）。
  旧 CHECK 的 4000–4999 与新池**不相交** ⇒ 不先摘它，① 自己的 UPDATE 就当场 23514（这就是必须多一步 ⓪ 的原因）。
  ⚠ PG 的 `lpad(text,n)` 会**截断**超过 n 的串（实测 `lpad('22010',4,'0')='2201'`）⇒ 重写端口段不得用 lpad。
  `docs/data/schema.sql` 冻结 baseline **一个字节未改**（§8.7/§8.8）；静态断言见 `portal/test/migrations.test.js`。
  前一道 `0018-port-allocations-scope-fde.sql`（#240 开户预分配 10 条 FDE 级预览域名：`port_allocations.scope`
  的 CHECK 由 `('project','run')` 放开为 `('project','run','fde')`，按名 DROP→ADD 可重放；**只改这一条
  CHECK**——`CHECK ((scope='run') = (run_id IS NOT NULL))` 原样保留（`scope='fde'` 的行 `run_id` 恒 NULL），
  且**不新建索引**（幂等靠 baseline 既有的部分唯一索引 `port_allocations_live_port_key (fde_id, port)
  WHERE state <> 'released'`，写侧 `ON CONFLICT` 必须带上该谓词才能推断冲突目标；#246 后它与新的全局索引**并存**）；前一道
  `0017-port-allocations-hostname-check.sql` 为 #202 预览域名 hostname 的 DB 兜底 CHECK（整域名正则
  逐标签 ≤63 + 总长 ≤253，NOT VALID，存量收敛动作见迁移头注释）；再前一道 `0016-transcript-append-seq.sql`
  为 transcript 同 round 保序：新增 `append_seq` + 存量按 `created_at, id` 确定性回填 + 部分索引）。
  **P1 compose 显式设
  `MIGRATE_ON_START: "1"`**——单实例平台起栈即自动补增量，不再需要人工补跑（deploy-contract §3.1）；
  多实例部署必须置 `0` 并外部跑迁移。

> 迁移身份 = `station_platform`（DDL，表 owner）；运行时身份 = `station_portal`（最小 DML）。
> 见 `docs/design/deploy-contract.md` §2.4/§3 与 `docs/env.md` §10。

## 排障

- **`column "claim_token" does not exist`（或其他基线列缺失）**：说明目标库**不是由 0001 建的表**
  （典型：手工建库 / 导入了不匹配的 dump）。runner 不会自愈——请**重建库**后重跑迁移，不要靠改迁移文件绕过。
- **`checksum mismatch` / runner 拒启**：有人改过已应用迁移或 baseline。从 `git log` 取回原文件内容即可，
  **不要**删 `schema_migrations` 行去「重放」（那会跳过 DDL，留下半成品 schema）。
