-- ============================================================================
-- FDE Station · station-db 数据库 Schema
-- ----------------------------------------------------------------------------
-- 依据：
--   docs/design/fde-platform.md  §8 / §9 / §10（规格，下称「规格」）
--   docs/design/principles.md（原理，下称「原理」）
--   docs/api/portal.md（API 契约，字段口径对齐，下称「portal.md」）
--   docs/design/runner-integration.md（runner 集成设计：internal 端点、租约、幂等键，下称「runner-integration」）
-- 表语义、状态机、三份数据边界、归档策略、记账口径见 docs/data/model.md。
--
-- 环境事实（docs/env.md）：
--   目标版本 postgres:16（env §10）；数据目录 /docker/station-db/（env §6）。
--
-- DDL 约定：
--   - 枚举一律 text + CHECK（不用 ENUM 类型，便于 additive 演进）
--   - 时间一律 timestamptz
--   - 主键一律 uuid，默认 gen_random_uuid()（PG13+ 内建，无需扩展）
--   - 软删除/可回收资源用「部分唯一索引」保证活跃记录唯一，历史记录不挡复用
--
-- 可单独执行（自包含）：本文件所需的 station_platform / station_portal 两个角色
--   在本文件开头（§0）幂等创建（IF NOT EXISTS，已存在则跳过），**不依赖** bootstrap.sql。
--
-- 执行顺序（deploy-contract.md §3；角色与运行身份分离）：
--   ① 本文件（schema.sql = baseline）可直接以超级用户（POSTGRES_USER）执行：
--      开头幂等创建两个角色 → 建表 → 落 schema_migrations 台账（§10）→ 末尾向
--      station_portal 授最小 DML GRANT。空库 `psql -f` 端到端可执行。
--   ② 生产环境可随后（或按需）执行 docs/data/bootstrap.sql（可重复执行）：口令、
--      ownership、扩展/权限微调等环境特有设置（不进仓库），与 schema.sql 无顺序冲突。
-- 本文件必须整体作为单个事务执行（BEGIN…COMMIT），任一语句失败整体回滚。
-- 验收：psql -f schema.sql 在空库可执行（单事务，任一语句失败整体回滚）。
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. 角色幂等创建（自包含；deploy-contract.md §2.4/§3）
-- ----------------------------------------------------------------------------
-- 本文件必须可单独执行，故所需角色在此幂等创建，不依赖 bootstrap.sql。
--   station_platform：DDL/迁移专用（生产上由迁移 runner 以该身份执行本文件，即表 owner）。
--   station_portal：运行时 DML 专用（末尾授最小 DML GRANT）。
-- 属性与 bootstrap.sql 一致（LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE）；
--   bootstrap.sql 可重复执行、不改属性，仅补环境特有设置（口令/ownership 等）。
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'station_platform') THEN
    CREATE ROLE station_platform LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'station_portal') THEN
    CREATE ROLE station_portal LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1. 账号与认证（规格 §7）
-- ----------------------------------------------------------------------------

-- 用户：OIDC JIT 建档（email + oidc_sub）或本地账号（password_hash + 强制 TOTP）
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login         text NOT NULL UNIQUE,              -- 登录名；OIDC 用户取 IdP 首选名
  email         text UNIQUE,                       -- OIDC JIT 建档依据（规格 §7.1）；本地账号可空
  display_name  text NOT NULL DEFAULT '',
  role          text NOT NULL DEFAULT 'fde'
                CHECK (role IN ('fde', 'admin')),  -- OIDC 后来自 group claim，不在 UI 手点（规格 §7.1）
  fde_name      text UNIQUE,                       -- 容器名 fde-<name> 的 <name>、预览域名首段；未建容器时 NULL
  auth_source   text NOT NULL DEFAULT 'local'
                CHECK (auth_source IN ('local', 'oidc')),
  oidc_sub      text UNIQUE,                       -- OIDC subject；auth_source='oidc' 时必填（应用层校验）
  password_hash text,                              -- argon2id；oidc 账号为 NULL
  totp_secret   text,                              -- 本地账号强制 TOTP（规格 §7.1）；种子只经 bootstrap 下发
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz                        -- offboarding 停用时间（规格 §7.3）
);

-- 登录会话：cookie 令牌只存哈希，可单条吊销（portal.md §2.5；offboarding 依赖）
CREATE TABLE login_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id),
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,             -- 7 天滚动续期（portal.md §2.5）
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  ip           inet,
  user_agent   text
);
CREATE INDEX login_sessions_user_idx
  ON login_sessions (user_id) WHERE revoked_at IS NULL;

-- API token：非浏览器客户端用（basic auth 兜底场景之外的程序化访问，规格 §6.2）
CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id),
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  scopes       text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  UNIQUE (user_id, name)
);

-- ----------------------------------------------------------------------------
-- 2. 容器与项目（规格 §4 / §7.2 / §12）
-- ----------------------------------------------------------------------------

-- FDE 容器：每 FDE 一行（onboarding「建/复用」，规格 §7.2 第 2 步）
CREATE TABLE containers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id),
  fde_name       text NOT NULL UNIQUE,           -- = users.fde_name
  container_name text NOT NULL UNIQUE,           -- fde-<name>（docker 容器名；H-B：与 portal 无共享网络，portal 经宿主路由可达——topology.md §2/§4）
  runner_token_hash text NOT NULL,               -- per-container token 仅存哈希（issue #12 / topology.md §6 第 9 条）：建容器时生成原文、注入容器 env ERIX_STATION_TOKEN；
                                                 -- 容器→portal 单向出示原文，portal 只校验哈希、不再向容器出示；严禁明文入 DB/日志/镜像/仓库（原理 §5）
  token_generation int NOT NULL DEFAULT 1,       -- token 代次：轮换/容器重建时 +1；旧代次哈希失配 → 401 token_revoked（原子吊销）
  status         text NOT NULL DEFAULT 'creating'
                 CHECK (status IN ('creating', 'running', 'stopped', 'exited', 'removed')),
  image          text NOT NULL,                  -- 容器镜像（含 tag）
  agent_version  text NOT NULL,                  -- erix-agent 版本（pin/canary，规格 §14）
  last_heartbeat timestamptz,                    -- agentd 心跳（15s ⚠️，POST /api/internal/heartbeat）由 portal 落库；3 次丢失判容器死（runner-integration §4.2）
  revoked_at     timestamptz,                    -- token 吊销时刻（offboarding / 容器重建）；非 NULL = 已吊销
  rotated_at     timestamptz,                    -- token 上次轮换时刻（token_generation +1 时写）
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- 项目：容器内一个仓库目录 ~/projects/<name>（规格 §2 术语）
CREATE TABLE projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id),
  name       text NOT NULL
             CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),  -- 同时是容器内目录名（portal.md §3.1）
  repo_url   text NOT NULL,
  root_path  text NOT NULL,                      -- ~/projects/<name>
  slot       int NOT NULL CHECK (slot >= 0),     -- 项目端口块序号：起始端口 4000 + slot*8（规格 §8.2）
  template   text NOT NULL DEFAULT 'default',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz                         -- 删除 = 归档 + 回收端口（portal.md §3.6）
);
-- 软删除后 name / slot 可复用，活跃记录保持唯一
CREATE UNIQUE INDEX projects_live_name_key
  ON projects (user_id, name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX projects_live_slot_key
  ON projects (user_id, slot) WHERE deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- 3. 会话、run、消息（规格 §9；事件流 §10）
-- ----------------------------------------------------------------------------

-- 对话会话（UI 概念）：一个 session 串起多次 run（规格 §2）
CREATE TABLE chat_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL REFERENCES projects (id),
  title      text NOT NULL DEFAULT '',
  model      text,                               -- 会话级模型覆盖；NULL = 平台默认
  status     text NOT NULL DEFAULT 'active'
             CHECK (status IN ('active', 'archived')),
  last_seq   bigint NOT NULL DEFAULT 0,          -- 事件/消息 seq 分配器：与 run_events、messages 同事务递增
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_sessions_user_idx ON chat_sessions (user_id, updated_at DESC);

-- run：一次 runToolLoop 生命周期（规格 §2）；id 由 portal 生成 UUID，禁止 cwd 派生（规格 §9.3-3）
CREATE TABLE runs (
  id                  uuid PRIMARY KEY,          -- 不设默认值：必须由 portal 显式生成并下发给容器
  session_id          uuid NOT NULL REFERENCES chat_sessions (id),
  status              text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'cancelling', 'finished', 'failed')),
  termination         jsonb,                     -- runToolLoop 返回值透传，对象 {reason, detail?}（model.md §1.7；portal.md §4.1/§5.3）：
                                                 -- reason ∈ end_turn / no_tool / stall / max_rounds_cap / reflection_stop /
                                                 -- judge_done / continuation_exhausted / aborted / failed（erix-agent v0.3.5 src/loop.js:622）。
                                                 -- UI 的「已取消」是宿主展示态：由 cancel_requested_at + reason='aborted' 推导（model.md §2.1），非引擎取值
  rounds              int NOT NULL DEFAULT 0,
  usage               jsonb NOT NULL DEFAULT '{"input_tokens": 0, "output_tokens": 0}' :: jsonb,
  cost                numeric(12, 6),            -- ⚠️ 待决策者确认：记账口径依赖 Q1/Q4，P1 可空（portal.md §4.1）
  error               jsonb,                     -- {code, message, retryable}；run 级错误码见 portal.md §6.4
  cancel_requested_at timestamptz,               -- 停止标记：portal 写，runner 轮询（规格 §10.3）
  queued_at           timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  ended_at            timestamptz
);
-- 一个 session 同一时刻最多一个进行中的 run（portal.md §4）
CREATE UNIQUE INDEX runs_one_active_per_session
  ON runs (session_id) WHERE status IN ('queued', 'running', 'cancelling');
CREATE INDEX runs_session_idx ON runs (session_id, queued_at DESC);

-- 第①层：人看的对话（规格 §9.2）。UI 唯一读取的对话来源；synthetic 必须参与渲染（红线）
CREATE TABLE messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES chat_sessions (id),
  run_id      uuid REFERENCES runs (id),         -- 关联的 run：用户消息 = 它触发的 run；assistant 消息 = 产生它的 run
  seq         bigint NOT NULL,                   -- session 内单调递增，与 run_events 共用 chat_sessions.last_seq 分配器
  role        text NOT NULL CHECK (role IN ('user', 'assistant')),
  content     text NOT NULL,
  synthetic   boolean NOT NULL DEFAULT false,    -- judge/wrapup 注入的合成消息（规格 §9.2）
  attachments jsonb NOT NULL DEFAULT '[]' :: jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

-- ----------------------------------------------------------------------------
-- 4. 端口分配（规格 §8：DB 是真相，ports.json 与 Traefik 路由是派生）
-- ----------------------------------------------------------------------------

CREATE TABLE port_allocations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fde_id      uuid NOT NULL REFERENCES users (id),     -- FDE 用户；forward-auth 按预览凭证哈希查 preview_grants 解析 user_id 后与此列比对（portal.md §2.7；不解析 cookie.sub，旧口径作废）
  scope       text NOT NULL CHECK (scope IN ('project', 'run')),
  project_id  uuid NOT NULL REFERENCES projects (id),
  run_id      uuid REFERENCES runs (id),
  port        int NOT NULL CHECK (port BETWEEN 4000 AND 4999),  -- 容器内 dev 端口块；3001 code-server 为固定角色不入表（规格 §12.3；原 3000 runner 角色已取消）
  role        text NOT NULL CHECK (role IN ('frontend', 'backend', 'debug', 'spare')),
  hostname    text NOT NULL,                           -- 与 Traefik 路由同源生成（规格 §8.1），portal 唯一写入口
  url         text NOT NULL,                           -- 前端只展示/跳转此字段，永不自行拼接（portal.md §8-4）
  exposure    text NOT NULL DEFAULT 'private'
              CHECK (exposure IN ('private', 'org-visible', 'public')),  -- 规格 §6.5
  state       text NOT NULL DEFAULT 'allocated'
              CHECK (state IN ('allocated', 'active', 'released')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CHECK ((scope = 'run') = (run_id IS NOT NULL)),      -- run 级必带 run_id；项目级必为空
  CHECK ((state = 'released') = (released_at IS NOT NULL))
);
-- 端口唯一性（本表核心约束）：同一 FDE 容器内，一个端口同一时刻至多一条未释放分配；
-- 并发申请靠此部分唯一索引 + 事务兜底（规格 §8.1）
CREATE UNIQUE INDEX port_allocations_live_port_key
  ON port_allocations (fde_id, port) WHERE state <> 'released';
-- hostname 全局唯一：forward-auth 按 hostname 精确查（portal.md §2.7 第 1 步）
CREATE UNIQUE INDEX port_allocations_live_hostname_key
  ON port_allocations (hostname) WHERE state <> 'released';
CREATE INDEX port_allocations_project_idx
  ON port_allocations (project_id) WHERE state <> 'released';
-- reaper 回收已过期 released 记录（规格 §8.2）
CREATE INDEX port_allocations_reaper_idx
  ON port_allocations (released_at) WHERE state = 'released';

-- ----------------------------------------------------------------------------
-- 预览授权凭证（portal.md §2.7/§2.8）：一次性 ticket 与 host-only 预览 cookie 两种凭证，均只存哈希。
-- forwardAuth 按「预览 token 的哈希」查本表解析 user_id 后做 exposure 判定，不解析 cookie.sub（旧口径作废）；
-- portal 自身会话的登录态才查 login_sessions（§2.5），与本表互不相干。
-- 身份两列（B4）：user_id = 主体（被授权访问的身份，exposure 判定用）；issuer_id = ticket 的签发者（登录用户，
--   session 为系统派生、可空）。parent_ticket_id = ticket→session 关联（session 行指向派生它的 ticket，供安全重放，portal.md §2.7 第 6 步）。
--
-- 与 port_allocations 释放的联动：allocation 为软删除（state → released），不物理删行；释放事务由 portal 应用层
-- 同事务把该 allocation 的 active 凭证置 revoked（revoked_at=now()），forwardAuth 第 2 步始终重查 allocation.state 双保险（portal.md §2.8）。
-- 外键为普通引用（不设 ON DELETE CASCADE）：物理删除 allocation（reaper 定期硬删 released 过期行，model.md §4）前必须先清空
-- 引用它的本表行（grant reaper 先删过期/已吊销/已消耗行，或显式 DELETE ... WHERE allocation_id = ...）；DB 外键兜底防悬挂引用。
-- state 是权威生命周期列；expires_at 是 TTL 截止时刻。expired 由 reaper 周期性懒打标（state → expired），forwardAuth 的有效性
-- 判定同时查 state 与 expires_at > now()（reaper 打标前的窗口内，过期行仍会被拒绝，双保险）。
CREATE TABLE preview_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,             -- sha256(token)；与 login_sessions.token_hash 同口径，不存明文（portal.md §2.8）
  user_id       uuid NOT NULL REFERENCES users (id),   -- 主体（被授权访问的身份）；exposure 判定用此列（portal.md §2.7/§2.8；不解析 cookie.sub）
  issuer_id     uuid REFERENCES users (id),            -- ticket 的签发者（登录用户）；session 为系统派生、可空（portal.md §2.8/B4）
  allocation_id uuid NOT NULL REFERENCES port_allocations (id),
  parent_ticket_id uuid REFERENCES preview_grants (id),-- ticket→session 关联：session 行指向其派生自的 ticket；ticket 行 NULL（portal.md §2.7 第 6 步/B4）
  kind          text NOT NULL
                CHECK (kind IN ('ticket', 'session')),   -- ticket=一次性预览 ticket；session=host-only 预览 cookie（portal.md §2.7）
  state         text NOT NULL DEFAULT 'active'
                CHECK (state IN ('active', 'used', 'revoked', 'expired')),
  expires_at    timestamptz NOT NULL,             -- ticket TTL 60s ⚠️；session 15min 滚动续期 ⚠️（portal.md §2.8）
  used_at       timestamptz,                      -- ticket 一次性消耗时刻（forwardAuth 同事务原子置位，portal.md §2.7 第 4 步）
  revoked_at    timestamptz,                      -- 显式吊销 / allocation released / 用户 disabled（portal.md §2.8/§2.9.3）
  last_seen_at  timestamptz,                      -- session 最近一次校验通过（滚动续期刷新）
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_ip    inet,
  created_ua    text,
  CHECK (kind <> 'session' OR used_at IS NULL),        -- 只有一次性 ticket 有 used 语义；session 永不 used
  CHECK (kind <> 'ticket' OR issuer_id IS NOT NULL),   -- ticket 必有签发者；session 系统派生、issuer 可空（B4）
  CHECK ((kind = 'session') = (parent_ticket_id IS NOT NULL)),  -- session 必指向派生 ticket；ticket 无父（B3/B4）
  CHECK ((state = 'used') = (used_at IS NOT NULL)),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX preview_grants_user_idx ON preview_grants (user_id);
CREATE INDEX preview_grants_issuer_idx ON preview_grants (issuer_id);   -- admin 代签 / 按签发者吊销与审计
CREATE INDEX preview_grants_allocation_idx ON preview_grants (allocation_id);
CREATE INDEX preview_grants_parent_ticket_idx ON preview_grants (parent_ticket_id);  -- 安全重放：按 parent_ticket_id 查派生 session（portal.md §2.7 第 6 步）
-- reaper：清理过期（expires_at 已过）/ 已消耗 / 已吊销的行（portal.md §2.8「定期清理过期行」）
CREATE INDEX preview_grants_reaper_idx
  ON preview_grants (expires_at) WHERE state IN ('active', 'used', 'revoked');

-- ----------------------------------------------------------------------------
-- 5. 引擎持久化（规格 §9.2 / §9.3：TranscriptStore 适配器落点）
-- ----------------------------------------------------------------------------

-- 第②层：canonical 消息（模型上下文 + resume 源）。只由 store 适配器（portal internal 端点，runner 经 HTTP adapter 调用，不直连 DB——D1'/D2'）写，UI 永不直接渲染
CREATE TABLE transcript_rounds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL REFERENCES runs (id),
  round          int NOT NULL CHECK (round >= 0),
  record         jsonb NOT NULL,                 -- 上游 RoundRecord 全量原样（全量真相，load() 原样返回；决策者 2026-09 D2' 对齐）
  folded         boolean NOT NULL DEFAULT false, -- fold 只影响视图，档案完整（规格 §9.2）
  messages       jsonb NOT NULL,                 -- 派生/加速列：该轮的 canonical 消息数组（含 judge 合成注入），供查询与 UI
  folded_payload jsonb,                          -- 派生/加速列：fold 后的展示载荷
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, round)
);

-- checkpoint 必须成对（save + load），写失败 fail-closed → checkpoint_failed（规格 §9.3-1）
-- 每 run 单行：上游 saveCheckpoint 是覆盖写单份（tmp+rename 原子覆盖）、loadLatestCheckpoint 无参数
-- （依据：erix-agent v0.3.5 src/store/file.js:279-297；决策者 2026-09 D2' 对齐）。
-- 写入语义：INSERT ... ON CONFLICT (run_id) DO UPDATE
--   SET snapshot = EXCLUDED.snapshot, revision = EXCLUDED.revision, updated_at = now()
--   WHERE run_checkpoints.revision < EXCLUDED.revision
-- （单行覆盖 + revision CAS：旧/乱序快照被 WHERE 子句拒绝 → portal 返回 409 checkpoint_stale；
--   重试同一 revision 安全）。revision = worker 每 run 从 0 递增的单调版本，resume 时经 U9 读回继续 +1
-- （runner-integration §9.5）。portal internal 端点 PUT .../checkpoint（U8/U9 已同步 revision，portal.md §9.8）。
CREATE TABLE run_checkpoints (
  run_id     uuid PRIMARY KEY REFERENCES runs (id),
  snapshot   jsonb NOT NULL,
  revision   bigint NOT NULL DEFAULT 0,          -- 单调 CAS 版本（旧快照被拒；seq 仅为调用方本地元数据、不落库）
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 第③层：流式事件日志。只追加；seq 由 portal 落库时分配，session 内单调递增（portal.md §5.1）
CREATE TABLE run_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES runs (id),
  session_id      uuid NOT NULL REFERENCES chat_sessions (id),  -- 冗余列：SSE 按 session 补发（Last-Event-ID）
  seq             bigint NOT NULL,             -- 与 chat_sessions.last_seq 同事务分配（portal 唯一分配方）
  client_event_id text NOT NULL,               -- 客户端幂等键：worker 事件 = run_id:attempt:单调计数；run_end 由 portal 合成 = run_id:final:run_end；agentd 批量上报 at-least-once 去重（runner-integration §7.3/§7.6）
  ts              timestamptz NOT NULL DEFAULT now(),
  type            text NOT NULL,               -- 类型清单见 portal.md §5.3；上游 additive 新类型原样透传
  payload         jsonb NOT NULL DEFAULT '{}' :: jsonb,
  UNIQUE (session_id, seq),
  UNIQUE (run_id, client_event_id)             -- ON CONFLICT DO NOTHING：重复批次安全（runner-integration §7.3）
);
CREATE INDEX run_events_run_idx ON run_events (run_id, seq);
-- run_end 唯一性（A4）：每个 run 至多一条 run_end。portal 在 U2 终态事务内合成
-- （type='run_end'、client_event_id='run_id:final:run_end'，runner-integration §7.6）；
-- 部分唯一索引兑底「即使 client_event_id 不同也无法插入第二条 run_end」。
CREATE UNIQUE INDEX run_events_run_end_key
  ON run_events (run_id) WHERE type = 'run_end';

-- spool（事件通道应急缓冲）不是 DB 表：它是容器内 `~/.cache/station/spool/<run_id>.jsonl` 的
-- append-only 本地文件（runner-integration §7.5），只缓冲「尚未被 portal 200 确认」的事件批，
-- 不是 transcript 副本（D2' 纯 DB）。ack 游标、损坏检测与修复、配额/写满、重启扫描、删除时机
-- 见 runner-integration §7.5；真相仍在 run_events（第③层），spool 只是投递缓冲，故不入库。

-- ----------------------------------------------------------------------------
-- 6. 工具调用、judge、审批、产物（规格 §9.1）
-- ----------------------------------------------------------------------------

-- tool_calls 行由 portal 在 U3 事件上报时幂等 upsert：对 type='tool_use' 事件 INSERT ... ON CONFLICT (run_id, call_id) DO NOTHING
-- （后续 tool_result / tool_call_delta 按 (run_id, call_id) 更新 result_digest/duration_ms/judged 等派生字段，portal.md §9.10）。
-- 因此 U10 建审批单时 tool_calls 行必已存在，approvals / tool_outputs 的复合外键 (run_id, call_id) 得以满足。
CREATE TABLE tool_calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES runs (id),
  call_id       text NOT NULL,                 -- 事件流中的 tool_call_id（portal.md §5.3）
  round         int NOT NULL,
  name          text NOT NULL,
  input         jsonb NOT NULL DEFAULT '{}' :: jsonb,
  result_digest text,                          -- 结果摘要（完整结果可能很大）
  duration_ms   int,
  judged        boolean NOT NULL DEFAULT false,
  approved      boolean,                       -- NULL = 未涉及审批
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, call_id)
);

CREATE TABLE judge_decisions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid NOT NULL REFERENCES runs (id),
  kind       text NOT NULL,
  action     text NOT NULL,
  decision   jsonb NOT NULL DEFAULT '{}' :: jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX judge_decisions_run_idx ON judge_decisions (run_id, created_at);

-- 审批：一个工具调用至多一条审批单；FDE 决定后 runner 轮询继续/终止（portal.md §4.8）
-- tool_call_id 为「外部 call_id」字符串（对齐 tool_calls.call_id，非 tool_calls.id 内部主键；canonical 规则见 model.md §1.19）。
-- ⚠️ 审批契约由 issue #10 定稿确认；若 #10 改判为 UUID，则以 #10 为准并同步本表（先消除 uuid↔text 三口径矛盾）。
CREATE TABLE approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES runs (id),
  tool_call_id text NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  decided_by   uuid REFERENCES users (id),
  decided_at   timestamptz,
  expired_at   timestamptz,                      -- #10（topology.md §4-L6）：超时 10min 由 portal 打 expired（修审计失真）；迟到决定被拒（portal.md §9.10）
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('pending', 'expired')) = (decided_at IS NULL)),
  CHECK ((status = 'expired') = (expired_at IS NOT NULL)),
  UNIQUE (run_id, tool_call_id),                                   -- 一个工具调用至多一条审批单（run 内 call_id 唯一）
  FOREIGN KEY (run_id, tool_call_id) REFERENCES tool_calls (run_id, call_id)
);
CREATE INDEX approvals_pending_idx ON approvals (created_at) WHERE status = 'pending';
CREATE INDEX approvals_run_idx ON approvals (run_id);

CREATE TABLE artifacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid NOT NULL REFERENCES runs (id),
  kind       text NOT NULL,
  path       text NOT NULL,                    -- 容器内路径
  size       bigint,
  sha        text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_run_idx ON artifacts (run_id);

-- ----------------------------------------------------------------------------
-- 7. 用量与审计（规格 §11.4 / §14）
-- ----------------------------------------------------------------------------

-- 用量台账：双源记账（规格 §11.4「网关 usage 与 erix onUsage 两套数都要记」）
-- ⚠️ 待决策者确认（Q1/Q4）：粒度与 cost 口径，见 model.md §5
CREATE TABLE usage_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id),
  project_id    uuid REFERENCES projects (id),   -- 成本归属维度；gateway 行可能为 NULL
  run_id        uuid REFERENCES runs (id),       -- erix 行：一 run 一条；gateway 行：NULL（key 粒度到不了 run）
  source        text NOT NULL DEFAULT 'erix'
                CHECK (source IN ('erix', 'gateway')),
  key_alias     text,                            -- gateway 行的虚拟 key 别名（如 alice@client-x，规格 §11.3）
  input_tokens  bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cost          numeric(12, 6),                  -- ⚠️ P1 可空；P3 接网关价格表后回填
  day           date NOT NULL,                   -- UTC 日，聚合冗余维度（写入时计算）
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX usage_ledger_run_source_key
  ON usage_ledger (run_id, source) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX usage_ledger_gateway_day_key
  ON usage_ledger (key_alias, day) WHERE source = 'gateway';
CREATE INDEX usage_ledger_user_day_idx ON usage_ledger (user_id, day);
CREATE INDEX usage_ledger_project_day_idx ON usage_ledger (project_id, day);

-- 审计：只追加。forward-auth 每次判定（无论通过与否）都写（portal.md §2.7）
CREATE TABLE audit_log (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id  uuid REFERENCES users (id),          -- NULL = 系统动作或未认证请求
  action    text NOT NULL,                       -- 如 auth.forward_auth / port.allocate / container.create
  target    text NOT NULL DEFAULT '',            -- 目标标识（hostname / 资源 id）
  details   jsonb NOT NULL DEFAULT '{}' :: jsonb,
  ts        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_ts_idx ON audit_log (ts);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, ts);

-- ----------------------------------------------------------------------------
-- 8. 任务队列（拉模型：agentd claim 长轮询领取，runner-integration §4.2/§6）
-- ----------------------------------------------------------------------------
-- 派单 = 拉取（长轮询 hold + portal 侧 NOTIFY/事件唤醒）为推荐倾向（⚠️ 待决策者确认，
-- runner-integration §15-3）；push 优化 P2 后置。容器不直连 DB：claim/续租/回收
-- 全部由 portal 经 internal API 执行（D1'）。
--
-- 租约字段（lease_until / owner_container_id / claim_token / attempts / max_attempts）支撑
-- 「原子认领 + 租约过期可重领 + 双写防护 + 崩溃循环上限」（runner-integration §4.2/§6.4/§6.5）。
--
-- 领取资格以「稳定 FDE 身份」为准（run → session → user），容器实例只作租约持有者标记：
--   container_id      = 入队时的派单目标容器实例（历史路由快照，审计/对账用；重建后不改写）
--   owner_container_id = 当前租约持有者容器实例（claim 时写，release/回收时清；fencing 用它 + claim_token）
--   领取资格          = 认领容器的 user_id == run 归属 user_id（容器重建后新容器同 user，天然可领旧队列行）
--
-- 认领 SQL（portal 在 POST /api/internal/claim 内执行，单语句原子；A1/A2 定稿）。
-- $1=认领容器 id、$2=claim_token、$3=认领容器 user_id（由 token 解出）。
-- 计数语义（A1 定稿）：attempts = 成功 claim 的次数，只在 claim 成功时 +1；
--   reaper 回 pending / U12 release 回 pending 均**不**递增 attempts（递增已发生在 claim）。
-- 领取资格（A2 定稿）：只认领 runs.status IN ('queued','running') 的 run——
--   'cancelling'（用户已 stop）/ 终态（finished/failed）绝不进入认领结果。
--
--   UPDATE run_queue q
--   SET status = 'claimed',
--       claimed_at = now(),
--       lease_until = now() + interval '90 seconds',   -- lease 90s ⚠️
--       owner_container_id = $1,                        -- 当前租约持有者（认领容器）
--       claim_token = $2,                               -- 本次认领凭证（随机生成）
--       attempts = attempts + 1                         -- 仅 claim 成功时递增
--   WHERE q.id = (
--     SELECT q2.id FROM run_queue q2
--     JOIN runs r          ON r.id = q2.run_id
--     JOIN chat_sessions s ON s.id = r.session_id
--     WHERE s.user_id = $3                             -- 稳定路由：同 FDE 用户（跨容器重建）
--       AND r.status IN ('queued', 'running')          -- A2：cancelling/终态不可领
--       AND q2.attempts < q2.max_attempts              -- 未达崩溃循环上限（第 max_attempts 次 claim 后 attempts=max_attempts）
--       AND (q2.status = 'pending'
--            OR (q2.status = 'claimed' AND q2.lease_until < now()))  -- 租约过期可重领
--     ORDER BY q2.created_at
--     FOR UPDATE SKIP LOCKED
--     LIMIT 1
--   )
--   RETURNING *;
--
-- 续租：随心跳 UPDATE ... SET lease_until = now() + interval '90 seconds'
--   WHERE id = $1 AND claim_token = $2（claim_token 不匹配 = 租约已易主 → 响应 run 级 lease_lost，runner-integration §4.2 U4）。
--
-- reaper（portal 定时任务，同一事务联动 runs；A1/A2 定稿）。三条分支互斥且不产生卡死态：
--   分支1（cancelling 收敛，A2）：容器已死 + 用户已 stop → 绝不回 pending 续跑，由 portal 收敛终态。
--     UPDATE run_queue q SET status='cancelled', claim_token=NULL, owner_container_id=NULL, lease_until=NULL, claimed_at=NULL
--       FROM runs r WHERE q.run_id=r.id AND q.status='claimed' AND q.lease_until<now() AND r.status='cancelling'
--       RETURNING q.run_id;   -- 应用层同事务置 runs → finished（termination.reason='aborted'；容器已死，portal 是唯一收敛方）
--   分支2（耗尽，A1）：最后一次允许的 attempt 也崩溃（claim 后 attempts=max_attempts 仍租约过期）→ 终态。
--     UPDATE run_queue q SET status='done', claim_token=NULL, owner_container_id=NULL, lease_until=NULL, claimed_at=NULL
--       FROM runs r WHERE q.run_id=r.id AND q.status='claimed' AND q.lease_until<now()
--         AND r.status IN ('queued','running') AND q.attempts >= q.max_attempts
--       RETURNING q.run_id;   -- 应用层同事务置 runs → failed（error.code='max_attempts_exceeded'）
--   分支3（未耗尽，回 pending，A1）：清租约字段回 pending，attempts **不变**（claim 时已 +1）。
--     UPDATE run_queue q SET status='pending', claim_token=NULL, owner_container_id=NULL, lease_until=NULL, claimed_at=NULL
--       FROM runs r WHERE q.run_id=r.id AND q.status='claimed' AND q.lease_until<now()
--         AND r.status IN ('queued','running') AND q.attempts < q.max_attempts
--       RETURNING q.run_id;
--
-- release（U12，A1/A2 对齐）：cancelling → 收敛 cancelled（不 requeue）；
--   attempts < max_attempts → 回 pending（attempts 不变）；attempts >= max_attempts → done + runs failed(max_attempts_exceeded)。

CREATE TABLE run_queue (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             uuid NOT NULL UNIQUE REFERENCES runs (id),  -- 一个 run 至多入队一次
  container_id       uuid NOT NULL REFERENCES containers (id),   -- 入队时的派单目标容器实例（历史路由快照，审计/对账）；领取资格不再按它过滤（重建后实例 id 会变）
  owner_container_id uuid REFERENCES containers (id),            -- 当前租约持有者容器实例（claim 时写，release/回收时清）；fencing 用 owner_container_id + claim_token
  claim_token        text,                                       -- 本次认领凭证；X-Claim-Token 头携带（心跳 U4 逐 run 携带），防 re-claim 后旧 agentd 双写（runner-integration §4.2）
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'claimed', 'done', 'cancelled')),
  attempts           int NOT NULL DEFAULT 0,                     -- 已发起的（re-）start 次数（claim 成功 +1）；崩溃循环上限见 max_attempts
  max_attempts       int NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),  -- 崩溃循环上限：attempts >= max_attempts 且再失败 → runs failed(max_attempts_exceeded)
  lease_until        timestamptz,                                -- 租约到期时刻；过期允许 re-claim（lease 90s ⚠️）
  created_at         timestamptz NOT NULL DEFAULT now(),
  claimed_at         timestamptz,
  CHECK (status <> 'claimed' OR (claimed_at IS NOT NULL
                                 AND lease_until IS NOT NULL
                                 AND owner_container_id IS NOT NULL
                                 AND claim_token IS NOT NULL)),
  CHECK (attempts <= max_attempts)                               -- 认领 SQL 已按 attempts < max_attempts 过滤，此处兜底防越界
);
CREATE INDEX run_queue_pending_idx
  ON run_queue (created_at) WHERE status = 'pending';
-- reaper / 认领 SQL 的过期租约扫描
CREATE INDEX run_queue_lease_idx
  ON run_queue (lease_until) WHERE status = 'claimed';

-- ----------------------------------------------------------------------------
-- 9. H-B 补齐（issue #5 定稿 / topology.md）：网络 IPAM / 路由 outbox / 工具产物 / LLM 绑定
-- ----------------------------------------------------------------------------

-- FDE 网络注册表（IPAM 真相，H-B D-10，topology.md §3）：每 FDE 一行，portal 管。
-- 系统推荐下一块空闲 /29（默认池 10.200.0.0/16），管理员可显式改为 /28（大 FDE 段 10.201.0.0/16）；
-- docker 用 --subnet 显式创建（reconciler 建网络前先经 Docker API 校验子网重叠，topology.md §8）。
-- state 流转见 model.md §2.6：allocated → active → released（released 后可复用 subnet；已建网络子网不可改 →
-- 扩容 = 重建网络）。
CREATE TABLE fde_networks (
  fde_id       uuid PRIMARY KEY REFERENCES users (id),   -- 每 FDE 一行（fde_id = users.id）
  network_name text NOT NULL UNIQUE,                     -- docker 网络名 fde-<name>
  subnet       cidr NOT NULL UNIQUE,                     -- 10.200.<n>.0/29 或 10.201.<n>.0/28
  prefix_len   int NOT NULL CHECK (prefix_len IN (29, 28)),  -- /29 默认池；/28 大 FDE 段
  gateway      inet NOT NULL,                            -- 该网络 .1（宿主网关端点）
  pool         text NOT NULL CHECK (pool IN ('default', 'large')),  -- default=10.200/16；large=10.201/16
  state        text NOT NULL DEFAULT 'allocated'
               CHECK (state IN ('allocated', 'active', 'released')),
  revision     bigint NOT NULL DEFAULT 0,                -- 预留的网络聚合版本号（暂无 network 聚合 outbox 行；若将来引入网络相关派生发布，按 route_revisions 的 head 模式成对使用）；与 route_revisions.revision 不可混用
  created_at   timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz,
  -- 字段间一致性约束（P7）：masklen 与 prefix_len 一致；gateway 为该子网 .1；
  -- pool 必须落在对应保留段且 prefix_len 匹配（default→10.200/16 且 /29；large→10.201/16 且 /28）。
  -- 应用层仍需做 Docker 现存网络重叠检查（reconciler 建网络前经 Docker API 校验，topology.md §8），DB CHECK 只保证字段自洽。
  CHECK (masklen(subnet) = prefix_len),
  CHECK (host(gateway) = host(set_masklen(subnet::inet, prefix_len) + 1)),
  CHECK (
    (pool = 'default' AND prefix_len = 29 AND subnet::inet << inet '10.200.0.0/16')
    OR
    (pool = 'large'   AND prefix_len = 28 AND subnet::inet << inet '10.201.0.0/16')
  ),
  CHECK ((state = 'released') = (released_at IS NOT NULL))
);

-- 路由发布 outbox（issue #9 / topology.md §4-L8/§5/§8）：portal 在 DB 事务里写 desired state
-- （port_allocations / fde_llm_bindings 等）+ 本表一行（revision 递增）；reconciler 异步幂等消费 →
-- 生成 Traefik file provider 动态配置。语义：
--   - DB 事务写 desired state + outbox；Traefik file provider 是异步幂等派生状态（PG 事务无法含文件写入）
--   - op='delete' 用 tombstone（revision 递增 + op=delete，不物理删行，供 offboarding/重建收敛）
--   - 启动时（portal/Traefik）从 DB 全量重建路由（幂等，topology.md §8）
--   - UNIQUE(aggregate, aggregate_id, revision)：同一聚合同一版本至多一条（重试/重复投递安全）
--   - revision 单调性由 route_revisions（每聚合版本 head）保证（P5，见下）；reconciler 只发布 revision = 当前 head 的行
--     （`revision < head` 的晚到旧事件 / 旧 tombstone 一律丢弃 → latest-wins，model.md §2.5）。
--
-- 租约与重试（P6）：reconciler 领取时把 state='pending' → 'processing'（原子，FOR UPDATE SKIP LOCKED）并写
--   claimed_at / lease_until / worker_id；发布成功 → 'published'；失败 → attempts+1 且退回 'pending' 退避重试
--   （1s→2s→5s→10s→30s 封顶，⚠️ 参数待确认）；attempts 耗尽（≥5 ⚠️）→ 'failed' + 告警（保留上一版文件，topology.md §8）。
--   崩溃恢复：reconciler 启动时 + 定时任务把 `state='processing' AND lease_until < now()` 回收为 'pending'（attempts+1），防孤儿锁死。

-- 每路由聚合的版本 head（P5）：desired state 写事务里与 outbox 行同事务 `SELECT ... FOR UPDATE` 递增 revision。
-- 聚合标识 (aggregate, aggregate_id) 与 route_outbox 对齐；revision 单调递增、每聚合一行（当前最大版本）。
-- 消费语义：reconciler 消费 outbox 前先 `SELECT revision FROM route_revisions WHERE aggregate=$1 AND aggregate_id=$2 FOR UPDATE`，
--   仅 outbox.revision = head.revision 才发布；`revision < head` → 晚到旧事件丢弃、不发布。
CREATE TABLE route_revisions (
  aggregate    text NOT NULL,
  aggregate_id uuid NOT NULL,
  revision     bigint NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (aggregate, aggregate_id)
);

CREATE TABLE route_outbox (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate    text NOT NULL,                            -- 聚合类型：'port_allocation' / 'llm_binding' 等
  aggregate_id uuid NOT NULL,                            -- 聚合实例 id（如 port_allocations.id / fde_llm_bindings.fde_id）
  op           text NOT NULL CHECK (op IN ('upsert', 'delete')),
  revision     bigint NOT NULL,                          -- 聚合内单调递增版本（与 route_revisions.head 对齐；同聚合同 revision 唯一）
  payload      jsonb NOT NULL DEFAULT '{}' :: jsonb,     -- 生成该路由所需的全部事实（hostname/url/backend IP 等），随 revision 快照
  state        text NOT NULL DEFAULT 'pending'
               CHECK (state IN ('pending', 'processing', 'published', 'failed')),
  attempts     int NOT NULL DEFAULT 0,                   -- 发布尝试次数（reconciler 退避重试；耗尽 → failed + 告警）
  last_error   text,                                     -- 最近一次失败原因（published 后清空）
  claimed_at   timestamptz,                              -- reconciler 领取时刻（state → processing 时写）
  lease_until  timestamptz,                              -- 处理租约到期时刻（lease 60s ⚠️）；到期未完成由 reaper 回收为 pending，attempts+1
  worker_id    text,                                     -- 领取该行的 reconciler worker 标识（崩溃恢复归属）
  published_at timestamptz,                              -- 最近一次成功发布时刻
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (aggregate, aggregate_id, revision),
  CHECK (state <> 'processing' OR (claimed_at IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX route_outbox_pending_idx
  ON route_outbox (state) WHERE state IN ('pending', 'processing');
-- reaper：回收 `state='processing' AND lease_until < now()` 的孤儿行（reconciler 启动时 + 定时任务）
CREATE INDEX route_outbox_lease_idx
  ON route_outbox (lease_until) WHERE state = 'processing';

-- 用户空间物化 outbox（issue #7 / user-space.md §7.1；A7 定稿：独立表，不复用 route_outbox）。
-- 与 route_outbox 同构但独立，避免与路由 reconciler 争抢同一行/同一租约/同一键空间。
-- 聚合键 = FDE（fde_id = users.id）；portal 在 DB 事务里写 desired state（projects / port_allocations 等）
--   + 本表一行（revision 递增）+ 同事务递增 materialize_revisions.revision；materializer 异步幂等消费 →
--   直写宿主 bind mount（D-6）。语义：
--   - revision 单调性由 materialize_revisions（每 FDE 版本 head）保证；materializer 只领取 revision = head 的行
--     （revision < head 的晚到旧事件/旧 tombstone 一律丢弃 → latest-wins）。
--   - op='delete' 用 tombstone（revision 递增 + op=delete，不物理删行）：删除的文件（项目删除 → 该项目
--     ports.json/AGENTS.md/.gitignore 等）由 materializer 落盘清理。
--   - 快照隔离 + 同 FDE 并发物化串行化：materializer 渲染时重读 DB desired state 为唯一输入（纯函数），
--     且每个 FDE 同时只有一个 revision = head 被领取（FOR UPDATE SKIP LOCKED）→ 同 FDE 天然串行。
--   - 租约/重试：领取 state='pending'→'processing'（写 claimed_at/lease_until/worker_id）；成功→'published'；
--     失败→attempts+1 退回 'pending' 退避重试（1s→2s→5s→10s→30s 封顶，⚠️）；耗尽→'failed'+告警（保留上一版文件）。
--   - 崩溃恢复：materializer 启动时+定时任务把 `state='processing' AND lease_until<now()` 回收为 'pending'（attempts+1）。
CREATE TABLE materialize_revisions (
  fde_id     uuid PRIMARY KEY REFERENCES users (id),   -- 每 FDE 一行 revision head
  revision   bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE materialize_outbox (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fde_id       uuid NOT NULL REFERENCES users (id),     -- 聚合键（per-FDE）
  op           text NOT NULL CHECK (op IN ('upsert', 'delete')),
  revision     bigint NOT NULL,                         -- FDE 内单调递增；与 materialize_revisions.head 对齐
  payload      jsonb NOT NULL DEFAULT '{}' :: jsonb,    -- 物化触发事实快照（变更项目/端口等提示；权威内容以 DB desired state 为准）
  state        text NOT NULL DEFAULT 'pending'
               CHECK (state IN ('pending', 'processing', 'published', 'failed')),
  attempts     int NOT NULL DEFAULT 0,                  -- 物化尝试次数（回收/失败退回时 +1；耗尽→failed+告警）
  last_error   text,
  claimed_at   timestamptz,                             -- materializer 领取时刻（state→processing 时写）
  lease_until  timestamptz,                             -- 处理租约到期（lease 60s ⚠️）；到期未完成由 reaper 回收 pending，attempts+1
  worker_id    text,                                    -- 领取该行的 materializer worker 标识
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fde_id, revision),
  CHECK (state <> 'processing' OR (claimed_at IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX materialize_outbox_pending_idx
  ON materialize_outbox (state) WHERE state IN ('pending', 'processing');
-- reaper：回收 `state='processing' AND lease_until < now()` 的孤儿行（materializer 启动时+定时任务）
CREATE INDEX materialize_outbox_lease_idx
  ON materialize_outbox (lease_until) WHERE state = 'processing';

-- 工具结果全文另存（topology.md §9 / issue #5 评论 1 §5）：工具结果超过阈值才另存——
-- 事件里只放 digest + 引用（tool_outputs.id），完整 body 落本表，避免打爆 run_events。
-- tool_call_id 为「外部 call_id」（对齐 tool_calls.call_id，非 tool_calls.id 内部主键）；canonical 规则见 model.md §1.19。
-- ⚠️ 审批契约由 issue #10 定稿确认；若 #10 改判为 UUID，则以 #10 为准并同步本表（先消除 uuid↔text 三口径矛盾）。
CREATE TABLE tool_outputs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES runs (id),
  tool_call_id text NOT NULL,                            -- 与 tool_calls.call_id 对齐（事件流 tool_call_id）
  bytes        int NOT NULL,                             -- body 字节数（阈值判定与配额依据）
  sha256       text NOT NULL,                            -- body 的 sha256（digest 校验/去重）
  body         text NOT NULL,                            -- 工具结果全文（jsonb/文本，TOAST 压缩吸收）
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, tool_call_id),
  FOREIGN KEY (run_id, tool_call_id) REFERENCES tool_calls (run_id, call_id)
);
CREATE INDEX tool_outputs_run_idx ON tool_outputs (run_id, created_at);

-- FDE ↔ LLM 网关虚拟 key 绑定（规格 §11.3 模式 C / topology.md §4-L7）：portal 调网关 admin API 建 key，
-- key 真实值只写宿主 Traefik 动态配置（600，portal 可写、Traefik 只读），**绝不存明文 secret**——
-- 本表只存 key_id / 别名 / 代次（供轮换、吊销、用量对账）。
CREATE TABLE fde_llm_bindings (
  fde_id      uuid PRIMARY KEY REFERENCES users (id),
  gateway     text NOT NULL,                             -- 网关标识（如 'litellm'，供 portal 调对应 admin API）
  key_id      text,                                      -- 网关侧 key id（创建成功后回填；未建前 NULL）
  key_alias   text NOT NULL,                             -- 业务别名（如 alice@client-x，规格 §11.3）
  state       text NOT NULL DEFAULT 'active'
              CHECK (state IN ('active', 'revoked')),
  generation  int NOT NULL DEFAULT 1,                    -- 虚拟 key 代次（轮换 +1；旧代次在网关吊销）
  revoked_at  timestamptz,                               -- 吊销时刻（offboarding / 轮换旧代次）
  rotated_at  timestamptz,                               -- 上次轮换时刻
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 10. 迁移台账 + 运行身份最小 GRANT（deploy-contract.md §3；A6 定稿）
-- ----------------------------------------------------------------------------
-- schema_migrations：迁移 runner 记录已应用迁移（deploy-contract §3.1）。
--   version 主键；checksum 为迁移文件的 sha256（防改历史，deploy-contract §3.2）；applied_at 应用时刻。
--   本文件（schema.sql）即 baseline（version='0000_baseline'）。文件无法包含自身的 sha256（自指），
--   因此 baseline 的 checksum 由迁移 runner 在应用后写入真实 sha256 覆盖下面的哨兵值；
--   哨兵值仅保证空库 psql -f 可执行。
CREATE TABLE schema_migrations (
  version    text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version, checksum)
VALUES ('0000_baseline', 'sha256:<computed-by-migration-runner>');

-- 运行身份最小 GRANT（deploy-contract §2.4/§3）：station_portal 只授 DML，不授 DDL；
-- DDL 归 station_platform（生产上由迁移 runner 以 station_platform 身份执行本文件，
--   该角色即表 owner；单独以超级用户执行时表 owner 为超级用户，bootstrap.sql 可按需归正 ownership）。
-- 注意：两个角色已在本文件开头（§0）幂等创建；schema 级的 CREATE/USAGE 授权（如需）以
--   bootstrap.sql（超级用户）为准，本文件只授对象级 DML。
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO station_portal;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO station_portal;
-- schema_migrations 对运行身份只读（readiness 判据：迁移是否到 head，deploy-contract §3.3）
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM station_portal;

-- 默认权限：将来由 station_platform 新建的表/序列自动授 station_portal DML。
ALTER DEFAULT PRIVILEGES FOR ROLE station_platform IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO station_portal;
ALTER DEFAULT PRIVILEGES FOR ROLE station_platform IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO station_portal;

COMMIT;
