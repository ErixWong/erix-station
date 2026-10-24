-- 0022-port-observations.sql —— 容器内真实监听的观测表（issue：端口呈现优化，方案 A 观测层 MVP）
-- 背景：平台对「容器里到底起了几个进程、占了哪几口」完全失明——port_allocations 只是**预分配**
--   （#246「不做容器侧端口管控：不检查、不限制、不 reconcile 容器实际监听什么」），LLM 在聊天里
--   口播 URL 不是结构化上报，agentd heartbeat（U4）载荷只有 runs。实机后果：同一项目两个分支的
--   dev server 各占 22000/22001，面板上两行长相相同，用户分不清点哪个、哪个是旧会话的僵尸。
-- 决策：agentd 采样 /proc（LISTEN 端口 + pid + cwd + cmdline + 进程启动时刻 + git 分支），随
--   U4 heartbeat（15s）捎带 `listeners`；portal 落本表。这是「只读观测用于展示」，不是管控/
--   reconcile——不破 #246 不变式。
-- 陈旧性：每次心跳对该容器**整批替换**（先删后插）；读侧再按 observed_at 新鲜度窗口过滤——
--   「连续几个心跳没观测到 ⇒ 自动消失」，僵尸端口的注解无需任何显式释放动作。
-- 授权：station_portal 的 DML 由 baseline 的 ALTER DEFAULT PRIVILEGES 自动覆盖（migrations/README
--   「单文件约定」），本文件不写 GRANT。baseline（docs/data/schema.sql）冻结，零字节不动。
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS port_observations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fde_id          uuid NOT NULL REFERENCES users (id),        -- = containers.user_id，冗余存一份供读端点按 FDE 直查
  container_id    uuid NOT NULL REFERENCES containers (id) ON DELETE CASCADE,  -- 观测来自哪台容器（重建后旧观测随新心跳自然过期/级联清除）
  port            int NOT NULL CHECK (port BETWEEN 1 AND 65535),
  pid             int,
  cwd             text,                                        -- 进程工作目录；~/projects/<name> 之下的相对形（agentd 归一），容器外进程保留原绝对路径
  cmd             text,                                        -- cmdline 摘要（截断），用于人眼分辨「是哪个 dev server」
  branch          text,                                        -- cwd 处 .git/HEAD 指向的分支（尽力而为，detached/非仓库为 NULL）
  proc_started_at timestamptz,                                 -- 进程启动时刻（/proc/<pid>/stat 换算）——比「分支」诚实：进程可能比切分支更老
  observed_at     timestamptz NOT NULL DEFAULT now(),          -- 最后一次采样到它的时刻（新鲜度窗口读侧判定）
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 每容器每端口至多一条活观测（心跳整批替换的幂等落点，也是 upsert 冲突目标）。
CREATE UNIQUE INDEX IF NOT EXISTS port_observations_container_port_key
  ON port_observations (container_id, port);
-- 读端点：列某 FDE 的观测（LEFT JOIN 进 /api/me/ports 的 DTO）。
CREATE INDEX IF NOT EXISTS port_observations_fde_idx
  ON port_observations (fde_id);
