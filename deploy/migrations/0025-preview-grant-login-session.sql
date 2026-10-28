-- 0025-preview-grant-login-session.sql —— 预览凭证血缘（issue #429，方案 B：登出回收预览平面）
--
-- 要解决的问题：登出（`POST /api/auth/logout`）只吊销 `login_sessions`，**从不触碰 `preview_grants`**
--   （portal.md §2.4 旧口径只删登录会话；§2.8 的「登出时可选撤销」写的是「可选」且只覆盖未消费的
--   ticket，派生的 session 根本不在清单里）。于是同一浏览器换账号后，上一账号的预览 URL 照常打开
--   ——forwardAuth 只认 grant（`state='active'` + 滚动续期，preview.js `handleSessionCookie`），
--   exposure 判定用 grant 上冻结的 `user_id`，「当前浏览器登录着谁」它既不知道、也不需要知道。
--   共享终端上这意味着 B 登录后继续以 A 的身份看/操作 A 的应用，且 `audit_log` 把 B 的点击全记在 A 名下。
--
-- 为什么是「血缘 + 登出时撤销」而不是「forwardAuth 改查 login_sessions」：
--   登录 cookie 是 host-only 于 `station.<base>` 的（issue #6），**物理上到不了预览 host**，
--   forwardAuth 请求里根本没有可判的登录主体（portal.md §2.11a 把这条写成了原则：
--   「门在它身上没有可判的主体」）。所以回收只能发生在**登出时刻**（portal 同时握着两枚凭证的语境），
--   forwardAuth 保持无状态差、每请求零新增查表。
--
-- 语义：`login_session_id` = **签发该凭证的登录会话**。ticket 行在签发时写入（签发者当时的会话）；
--   forwardAuth 兑换 ticket 派生 session 行时**继承** ticket 的该值。登出撤销按此列命中，
--   天然满足多设备语义：A 在设备 1 登出只回收设备 1 那次登录会话派生的凭证，设备 2 各自的会话不受连坐。
--   可空（additive，不回填）：迁移前的存量活跃凭证无血缘，登出救不了它们——最迟 15min 滚动 TTL
--   自然到期（TTL 语义 portal.md §2.8），发布窗口一次性、无需数据修复。
--
-- FK 用 `ON DELETE SET NULL`：offboarding / 管理员停用会 `DELETE FROM login_sessions WHERE user_id = …`
--   （admin.js / offboarding.js），那两处**本就先撤全部 grant**（#252 口径），血缘置空只是保历史行不撞 FK。
--
-- 幂等可重放（deploy/migrations/README.md 单文件约定）：全部 IF NOT EXISTS，第二遍是零 DDL 空操作。

ALTER TABLE preview_grants
  ADD COLUMN IF NOT EXISTS login_session_id uuid REFERENCES login_sessions (id) ON DELETE SET NULL;

-- 登出撤销走这条谓词（auth.js revokeSession 的 CTE）：只数 active 行，部分索引够用。
CREATE INDEX IF NOT EXISTS preview_grants_login_session_idx
  ON preview_grants (login_session_id) WHERE state = 'active';
