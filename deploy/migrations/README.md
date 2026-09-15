# deploy/migrations/ — 增量 DB 迁移目录

> 依据：`docs/design/deploy-contract.md` §3。P1 walking skeleton **尚无增量迁移文件**，
> 本目录只约定命名/顺序/幂等规则，供迁移 runner（`portal/src/migrate.js` 读取）与后续轮次使用。

## 目录职责

- 本目录存放**增量 DDL 迁移**（`baseline = docs/data/schema.sql` 之后的 schema 演进）。
- baseline（`schema.sql`）与 `bootstrap.sql` **不放在这里**：前者是自包含 baseline，后者是
  超级用户附加初始化（角色属性/授权/ownership 归正），均由部署侧 superuser bootstrap 处理。
- 迁移 runner 按文件名升序应用本目录下所有 `*.sql`，并以 `version = 文件名去 .sql` 落
  `schema_migrations` 台账。

## 命名与顺序

- 文件名：`NNNN-<slug>.sql`，`NNNN` 为四位递增序号（`0001`、`0002`、…），`<slug>` 为
  小写 kebab-case 简短描述。
- 顺序 = 文件名升序（`sort`）。**已应用的迁移文件不得再修改**：修改会改变 checksum，
  runner 检测失配后拒绝启动（防改历史，deploy-contract §3.2）。
- 每次新增 DDL 都写成新编号迁移文件，**不修改已应用的迁移**。

## 单文件约定

- 每个迁移文件在 **Postgres 单事务内**执行（runner 会 `BEGIN` → 执行 → `INSERT INTO
  schema_migrations` → `COMMIT`），失败整体回滚、不写台账行。
- 数据迁移（有损 / 大表 rewrite）必须显式 `SET lock_timeout` / `SET statement_timeout`
  并保持幂等（`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` 等），见 deploy-contract §3.2。

## 示例（后续轮次再添加，勿在本轮放实际迁移文件）

```sql
-- 0001-add-users-display-name-index.sql
CREATE INDEX IF NOT EXISTS users_display_name_idx ON users (display_name);
```

> 迁移身份 = `station_platform`（DDL，表 owner）；运行时身份 = `station_portal`（最小 DML）。
> 见 `docs/design/deploy-contract.md` §2.4/§3 与 `docs/env.md` §10。
