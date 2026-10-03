# deploy/migrations/ — 增量 DB 迁移目录

> 依据：`docs/design/deploy-contract.md` §3。本目录自 **0001** 起已有实际增量迁移
> （`0001-idempotency-keys.sql`，portal.md §1.4 幂等台账）；命名/顺序/幂等规则供迁移 runner
> （`portal/src/migrate.js` 读取）与后续轮次使用。
>
> **baseline 已冻结**：`docs/data/schema.sql`（`version='0000_baseline'`）自 P1 起不可再改——
> 改它会让 `00-init.sh`/runner 记录的真实 `sha256` 失配，runner 直接拒绝启动（§3.2 防改历史）。
> 新增 DDL 一律写成新编号迁移文件（本目录），**不**回写 baseline。

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
  `0011-git-hosts.sql`（Git host 注册与 FDE Git 账号绑定；`0010-litellm-bindings.sql`
  为 LiteLLM 单一网关迁移）。**P1 compose 显式设
  `MIGRATE_ON_START: "1"`**——单实例平台起栈即自动补增量，不再需要人工补跑（deploy-contract §3.1）；
  多实例部署必须置 `0` 并外部跑迁移。

> 迁移身份 = `station_platform`（DDL，表 owner）；运行时身份 = `station_portal`（最小 DML）。
> 见 `docs/design/deploy-contract.md` §2.4/§3 与 `docs/env.md` §10。
