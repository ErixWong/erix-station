-- ============================================================================
-- FDE Station · station-db 数据库 Schema
-- ----------------------------------------------------------------------------
-- 依据：
--   docs/design/fde-platform.md  §8 / §9 / §10（规格，下称「规格」）
--   docs/design/principles.md（原理，下称「原理」）
--   docs/api/portal.md（API 契约，字段口径对齐，下称「portal.md」）
-- 表语义、状态机、三份数据边界、归档策略、记账口径见 docs/data/model.md。
--
-- 环境事实（docs/env.md）：
--   目标版本 postgres:16（env §10）；数据目录 /docker/station-db/（env §7）。
--
-- DDL 约定：
--   - 枚举一律 text + CHECK（不用 ENUM 类型，便于 additive 演进）
--   - 时间一律 timestamptz
--   - 主键一律 uuid，默认 gen_random_uuid()（PG13+ 内建，无需扩展）
--   - 软删除/可回收资源用「部分唯一索引」保证活跃记录唯一，历史记录不挡复用
-- 验收：psql -f schema.sql 在空库可执行（单事务，任一语句失败整体回滚）。
-- ============================================================================

BEGIN;

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
  container_name text NOT NULL UNIQUE,           -- fde-<name>（docker 容器名，control 网络内 DNS 可达）
  runner_token   text NOT NULL,                  -- portal→runner Bearer（规格 §10.3）；portal 需持原文调用，故存原文，严禁入日志
  status         text NOT NULL DEFAULT 'creating'
                 CHECK (status IN ('creating', 'running', 'stopped', 'exited', 'removed')),
  image          text NOT NULL,                  -- 容器镜像（含 tag）
  agent_version  text NOT NULL,                  -- erix-agent 版本（pin/canary，规格 §14）
  last_heartbeat timestamptz,                    -- 容器→portal 只写 DB + 心跳（规格 §10.3）
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
                                                 -- judge_done / continuation_exhausted / aborted / failed（erix-agent v0.3.4 src/loop.js:622）。
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
  fde_id      uuid NOT NULL REFERENCES users (id),     -- FDE 用户；forward-auth 的 cookie.sub 比对对象（portal.md §2.7）
  scope       text NOT NULL CHECK (scope IN ('project', 'run')),
  project_id  uuid NOT NULL REFERENCES projects (id),
  run_id      uuid REFERENCES runs (id),
  port        int NOT NULL CHECK (port BETWEEN 4000 AND 4999),  -- 容器内 dev 端口块；3000/3001 为固定角色不入表（规格 §12.3）
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
-- 5. 引擎持久化（规格 §9.2 / §9.3：TranscriptStore 适配器落点）
-- ----------------------------------------------------------------------------

-- 第②层：canonical 消息（模型上下文 + resume 源）。只由 store 适配器写，UI 永不直接渲染
CREATE TABLE transcript_rounds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL REFERENCES runs (id),
  round          int NOT NULL CHECK (round >= 0),
  folded         boolean NOT NULL DEFAULT false, -- fold 只影响视图，档案完整（规格 §9.2）
  messages       jsonb NOT NULL,                 -- 该轮的 canonical 消息数组（含 judge 合成注入）
  folded_payload jsonb,                          -- fold 后的展示载荷
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, round)
);

-- checkpoint 必须成对（save + load），写失败 fail-closed → checkpoint_failed（规格 §9.3-1）
CREATE TABLE run_checkpoints (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid NOT NULL REFERENCES runs (id),
  seq        int NOT NULL,
  snapshot   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

-- 第③层：流式事件日志。只追加；seq 由宿主落库时分配，session 内单调递增（portal.md §5.1）
CREATE TABLE run_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid NOT NULL REFERENCES runs (id),
  session_id uuid NOT NULL REFERENCES chat_sessions (id),  -- 冗余列：SSE 按 session 补发（Last-Event-ID）
  seq        bigint NOT NULL,                -- 与 chat_sessions.last_seq 同事务分配
  ts         timestamptz NOT NULL DEFAULT now(),
  type       text NOT NULL,                  -- 类型清单见 portal.md §5.3；上游 additive 新类型原样透传
  payload    jsonb NOT NULL DEFAULT '{}' :: jsonb,
  UNIQUE (session_id, seq)
);
CREATE INDEX run_events_run_idx ON run_events (run_id, seq);

-- ----------------------------------------------------------------------------
-- 6. 工具调用、judge、审批、产物（规格 §9.1）
-- ----------------------------------------------------------------------------

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
CREATE TABLE approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES runs (id),
  tool_call_id uuid NOT NULL UNIQUE REFERENCES tool_calls (id),
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'denied')),
  decided_by   uuid REFERENCES users (id),
  decided_at   timestamptz,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pending') = (decided_at IS NULL))
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
-- 8. 任务队列（规格 §10.3 拉模型终态）
-- ----------------------------------------------------------------------------
-- ⚠️ 待决策者确认：任务下发单机可先用 push，pull（容器长轮询 / LISTEN 领任务）为终态
-- （规格 §10.3、portal.md §6.3）。push 模式下本表不启用，但表结构先行落地。

CREATE TABLE run_queue (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL UNIQUE REFERENCES runs (id),  -- 一个 run 至多入队一次
  container_id uuid NOT NULL REFERENCES containers (id),
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'claimed', 'done', 'cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  claimed_at   timestamptz,
  CHECK (status <> 'claimed' OR claimed_at IS NOT NULL)
);
CREATE INDEX run_queue_pending_idx
  ON run_queue (container_id, created_at) WHERE status = 'pending';

COMMIT;
