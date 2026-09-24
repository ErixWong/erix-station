# Portal API 契约

> 状态：**契约基线（供前端/后端/mock 并行开发）**
> 依据：[`../design/fde-platform.md`](../design/fde-platform.md)（规格，下称「规格 §x」）、[`../design/principles.md`](../design/principles.md)（原理）、[`../env.md`](../env.md)（环境事实，下称「env §x」）。
>
> **本文只定义「契约形状」**（端点、schema、错误语义、事件信封），不定义实现。前端可只依据本文 + mock 数据开发；后端实现与本文冲突时以规格为准并提 issue。
>
✅ **Q7 已定稿**（零依赖 `node:http` + 原生前端，principles §4；fde-platform 附录 A）：不影响本文任何契约形状；文中实现注记按定稿口径给出。

---

## 0. 总览

> **环境取值纪律**：契约形状只由规格 + principles 决定，**与环境无关**。文中一切域名/URL 以 env.md §10 的部署变量（`BASE_DOMAIN` / `PORTAL_HOST` / `FDE_WILDCARD_HOST`）为准；JSON 示例中出现的具体域名（`station.erix.vip`、`*.fde.erix.vip` 等）均假设 `BASE_DOMAIN=erix.vip`（env §1 ⚠️ 待决策者确认），仅作 mock 示例，不构成设计约束。部署目标环境不一定是任何已实测的机器。

| 项 | 取值 | 来源 |
|---|---|---|
| Base URL | `https://<PORTAL_HOST>`（`PORTAL_HOST = station.<BASE_DOMAIN>`，如 `https://station.erix.vip`） | env §1/§10 ⚠️ 待决策者确认 |
| 服务监听 | portal 容器内 `:8080`，publish **仅 `127.0.0.1:8080`（宿主回环）**，由 Traefik（host 网络）反代与 forwardAuth；不暴露 LAN | 规格 §5.3 / §6.4 / topology.md §2.2 |
| 字符集 / 格式 | 全部 `application/json; charset=utf-8`（SSE 端点除外） | — |
| 时间格式 | ISO 8601 UTC（如 `2026-09-12T08:30:00.000Z`） | — |
| ID 约定 | `run_id` 用 **UUID**（规格 §9.3：不要 cwd 派生）；其余 ID 为不透明字符串，前端不得解析其结构 | 规格 §9.3 |
| 鉴权 | session cookie（见 §2）；`/api/forward-auth` 由 Traefik 内部调用，不对浏览器暴露语义 | 规格 §6 |

### 0.1 端点清单

| 分类 | 方法 + 路径 | 说明 |
|---|---|---|
| 认证 | `POST /api/auth/login` | 第一步：口令校验 |
| 认证 | `POST /api/auth/login/totp` | 第二步：TOTP 校验，发 cookie |
| 认证 | `POST /api/auth/logout` | 登出 |
| 认证 | `GET /api/me` | 当前用户信息 |
| 边缘授权 | `GET /api/forward-auth` | Traefik forwardAuth 回调（非浏览器 API） |
| 项目 | `GET /api/projects` | 项目列表 |
| 项目 | `POST /api/projects` | 创建项目（同事务分配项目级端口） |
| 项目 | `GET /api/projects/:id` | 项目详情（含端口） |
| 项目 | `PATCH /api/projects/:id` | 改名等 |
| 项目 | `DELETE /api/projects/:id` | 删除项目（回收端口） |
| 会话 | `GET /api/sessions` | 会话列表 |
| 会话 | `POST /api/sessions` | 创建会话 |
| 会话 | `GET /api/sessions/:id` | 会话详情（含消息历史 + `last_seq`） |
| 会话 | `PATCH /api/sessions/:id` | 改标题 |
| 会话 | `DELETE /api/sessions/:id` | 归档会话 |
| 对话 | `POST /api/sessions/:id/messages` | 发消息（创建 run） |
| 对话 | `GET /api/sessions/:id/events` | **SSE 事件流**（§5） |
| 对话 | `POST /api/sessions/:id/stop` | 停止当前 run |
| 对话 | `GET /api/runs/:id` | run 详情（状态 / termination / usage / error） |
| 端口 | `GET /api/projects/:id/ports` | 端口分配列表 |
| 端口 | `PATCH /api/ports/:id` | 改可见级别（exposure） |
| 端口 | `POST /api/ports/:id/preview-ticket` | 签发一次性预览 ticket（§2.8） |
| 审批 | `GET /api/approvals` | 待审批工具调用列表 |
| 审批 | `POST /api/approvals/:id` | 审批决定 |

> 所有端点（除 `/api/forward-auth` 与登录两端点外）要求有效 session cookie，否则 `401 unauthorized`。
>
> 容器 → portal 的内部端点（`/api/internal/*`）见 §9（经 Traefik：`https://station.<base>/api/internal/*` + 来源 ipAllowList，H-B 定稿 D-5），不属上表。

---

## 1. 通用约定

### 1.1 错误信封

所有非 2xx 响应统一为：

```json
{
  "error": {
    "code": "validation_failed",
    "message": "name 为必填字段",
    "retryable": false,
    "details": { "field": "name" }
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | string | 机器可读错误码（见 §1.2 与 §6），前端分支只能用 `code`，不得匹配 `message` |
| `message` | string | 人可读描述（中文），可直接展示 |
| `retryable` | boolean | 是否可安全重试（语义见 §6） |
| `details` | object? | 附加结构（字段名、run_id 等） |

### 1.2 通用错误码

| HTTP | code | 含义 | retryable |
|---|---|---|---|
| 400 | `validation_failed` | 请求体/参数不合法 | 否 |
| 401 | `unauthorized` | 无 cookie / 会话失效 / 登录凭据错误 | 否 |
| 403 | `forbidden` | 已认证但无权访问该资源（含他人资源、越级操作） | 否 |
| 404 | `not_found` | 资源不存在（**他人资源也返回 404**，不泄露存在性） | 否 |
| 409 | `name_conflict` / `run_in_progress` / `no_active_run` / `active_runs` / `already_decided` / `approval_expired` / `port_quota_exceeded` / `idempotency_key_reuse` | 状态冲突，各端点分别列出 | 否 |
| 409 | `idempotency_conflict` | 同一 `Idempotency-Key` 的并发请求未收敛（先到先得）——该 key 的首次执行仍在进行中（`in_progress` 占位 < 5 分钟），或本请求的占位已被其它 owner 接管（`claim_token` fencing 失配，§1.4）；稍后重试即可拿到首次结果 | 是 |
| 413 | `payload_too_large` | 请求体超过大小上限（`Content-Length` 或实际流式字节超限） | 否 |
| 429 | `rate_limited` | 限流（登录爆破、LLM 配额，见 §6.1） | 是（遵循 `Retry-After`） |
| 503 | `container_unreachable` | ⚠️ 仅 push 下发模式（待决策者确认）FDE 容器不可达（见 §6.3）；拉模型（终态）不返回此码 | 是 |
| 500 | `internal` | 未分类服务端错误 | 否 |

> 资源归属一律以「当前登录用户」过滤：**越权访问与他人资源一律表现为 404**（`not_found`），只有「本人资源上的越级操作」（如普通 FDE 开 `public` 端口）才返回 403。

### 1.3 分页

列表端点统一 cursor 分页：

- 请求：`?cursor=<opaque>&limit=<1..100，默认 20>`
- 响应：`{ "items": [...], "next_cursor": "<opaque|null>" }`（`next_cursor` 为 `null` 表示到底）

### 1.4 写操作幂等

`POST` 端点接受可选 `Idempotency-Key` 请求头；同 key 重复提交返回首次结果（尤其 `POST .../messages`，防断网重发产生两条用户消息）。

**当前生效范围**：本轮仅 `POST /api/sessions/:id/messages` 实现幂等（也是 `idempotency_keys` 台账的**唯一写入方**）；其余 `POST` 端点收到 `Idempotency-Key` 时**忽略**该头（无幂等语义、不落台账）——后续端点复用时沿用本节语义（尤其「先占位后执行」与 409 码）。

**实现口径**（本轮实现，P1）：

- **台账落库**：`idempotency_keys`（`PRIMARY KEY (user_id, endpoint, key)`；由增量迁移 `deploy/migrations/0001-idempotency-keys.sql` 提供，baseline `schema.sql` 自 P1 冻结、不含本表）。`endpoint` 为**具体端点含路径参数**（如 `POST /api/sessions/<id>/messages`）——同 key 跨 session 不串号；`request_hash` = 规范化请求体（`content` + `attachments` 的 `{kind,path,name}` 子集）的 `sha256`；`claim_token` = 占位持有者标识（`crypto.randomUUID()`，占位/抢回时写入，`done` 行保留最后一次的值）。
- **先占位后执行 + 记账并入业务事务**（`state` 列）：① `state='done'` 且未过期（TTL 24h）→ 直接回放；② 否则先 `INSERT ... state='in_progress'` **占位**（并发同 key 只有一个请求能占到，故副作用**至多执行一次**）；③ 占到占位 → 执行 `fn(record)`：fn **在自己的业务事务内**调 `record(client, statusCode, response)` 把台账行转 `done`（**同 client 同事务**）——业务写入（user 消息 + run + 队列）与记账**同一次 COMMIT**，故**同 key 至多一次副作用（记账与业务写入同事务）**；执行抛错 → **删除占位行**后原样报错（释放 key，客户端可原样重试，不把瞬时错误钉成永久结果）。
- **owner fencing（`claim_token`）**：`record` / 补记 / 释占位一律带 `AND claim_token = $` 条件。占位持有者崩溃超 5 分钟被后续请求抢回时会**改写 token**，故迟到的旧持有者的记账/释放全部 0 行——旧持有者 `record` 命中 0 行即抛 `409 idempotency_conflict`（`retryable: true`），其业务事务随之回滚，**不会提交第二次副作用**。
- **不绝对化的残余窗口**：若 `fn` **未**调用 `record`（未接入同事务记账的调用方），退回「业务提交后由幂等层补记」的旧路径，该路径仍存在「业务已提交、记账未提交」的极窄崩溃窗口（补记命中 0 行时告警但不报错）。**当前唯一使用者 `POST /api/sessions/<id>/messages` 已接入 `record`，故该端点无此窗口**——后续端点接入幂等时必须一并接入 `record`，否则退回有窗口的路径。
- **TTL 24h**：只有 `created_at > now() - interval '24 hours'` 的完成行参与命中；过期行语义上等同不存在（重发时由占位语句的条件 upsert 原子覆盖），物理清理由 portal reaper 低频（≈1h）`DELETE`（`idempotency.js` `purgeExpired`）。
- **命中回放**：`request_hash` 一致 → 按首次 `status_code`（`POST .../messages` = `202`）与首次响应体**原样返回**，且**不重复副作用**（不重复唤醒 runner、不产生第二条 user 消息/第二个 run）。
- **同 key 不同载荷**：`request_hash` 不一致 → `409 idempotency_key_reuse`（不执行首次副作用的第二遍）。
- **并发同 key**：先到先得——占位期间的后续请求 → `409 idempotency_conflict`（`retryable: true`，**不执行** fn）；首执行完成后的重发 → 正常回放。占位持有者崩溃（`in_progress` ≥ 5 分钟）→ 视同可覆盖：后续请求抢回后执行（否则一次崩溃会把该 key 永久钉死）。
- **请求体校验前置**：非法请求体先返回 `400 validation_failed`，**不占用**占位行（否则一次笔误会让同 key 的合法重试撞 409 reuse）。
- **非法 key**：非字符串 / 长度 > 128 / 含控制字符（**含仅出现在两侧**的 CR/LF 等，trim 前判定）→ `400 validation_failed`；无该头或纯空白 = 无幂等语义（直通）。

---

## 2. 认证

### 2.1 登录方式（P1）

**P1 用本地账号**：口令哈希 + **强制 TOTP**，两步登录（规格 §7.1 本地通道的同一套机制；P1 骨架暂用 Node 内置 `crypto.scrypt`，目标 argon2id 按 §2.9.4 平滑迁移；env §4 ⚠️ 待决策者确认：OIDC provider 事实缺失，OIDC 接入延后到 P2，届时按规格 §7.1 走 JIT provisioning，角色来自 group claim）。

- 第一个 admin 由部署 bootstrap 在本地建（规格 §7.1）；**TOTP 种子由 bootstrap 流程生成下发，不走公开 API**（P1 契约不含注册/自助找回端点）。
- OIDC 接入后登录入口变化（跳转 SSO），但 **cookie、session 语义、本文其余端点全部不变**——前端无需感知。

### 2.2 `POST /api/auth/login`

第一步：校验口令。

请求：

```json
{ "login": "alice", "password": "••••••••" }
```

响应 `200`（口令正确，进入第二步；**此时尚未登录**）：

```json
{ "status": "totp_required", "pending_token": "pt_9f2c...", "expires_in": 120 }
```

| 字段 | 说明 |
|---|---|
| `pending_token` | 一次性、短期（默认 120s，`PENDING_TOKEN_TTL_SECONDS` 可配）有效的待决令牌，仅可用于 `/api/auth/login/totp`；服务端只存其 `sha256` |

请求约束（S3）：`Content-Type` 必须为 `application/json`（否则 `400 validation_failed`）；`login` ≤ 128、`password` ≤ 256 字符（否则 `400 validation_failed`）；请求体超过上限（默认 64KiB，`Content-Length` 或流式字节）→ `413 payload_too_large`（标准错误信封）。

错误：

| HTTP | code | 场景 |
|---|---|---|
| 401 | `invalid_credentials` | 用户名或口令错误（**不区分是哪种**，防用户枚举） |
| 429 | `rate_limited` | 同一 login / IP 连续失败触发限流；响应带 `Retry-After` 头（秒） |

### 2.3 `POST /api/auth/login/totp`

第二步：校验 TOTP，成功后建立会话。

请求：

```json
{ "pending_token": "pt_9f2c...", "code": "123456" }
```

响应 `200`：

```json
{
  "user": {
    "id": "u_alice",
    "login": "alice",
    "display_name": "Alice",
    "role": "fde",
    "fde_name": "alice"
  }
}
```

同时下发 session cookie（属性见 §2.5）。

错误：

| HTTP | code | 场景 |
|---|---|---|
| 401 | `totp_invalid` | TOTP 码错误 |
| 401 | `pending_expired` | `pending_token` 过期/不存在/已使用 → 重新走第一步 |
| 429 | `rate_limited` | TOTP 连续失败限流（带 `Retry-After`） |

### 2.4 `POST /api/auth/logout`

- 响应 `204`，删除服务端 `login_sessions` 记录，并下发过期 cookie 清除客户端副本。
- 未登录调用返回 `401 unauthorized`。

### 2.5 session cookie 属性

**P1 本地登录下发的是 host-only 会话 cookie**——只对 `station.<BASE_DOMAIN>` 发送，**绝不覆盖预览泛域名**（issue #6：旧设计用父域 `Domain=.erix.vip` 会让预览域名也收到 portal 会话 cookie，属安全缺陷，已作废）。

| 属性 | 取值（生产 / HTTPS） | 理由 / 来源 |
|---|---|---|
| 名称 | `__Host-fde_session` | `__Host-` 前缀强制浏览器要求 cookie 具备 `Secure` + `Path=/` + 无 `Domain`（host-only），防止子域继承与覆盖 |
| `Domain` | **不设**（host-only） | 只发往 `station.<BASE_DOMAIN>`；预览 host 与任意子域都不会收到（issue #6） |
| `Path` | `/` | `__Host-` 前缀要求 |
| `HttpOnly` | 是 | 防 XSS 窃取 |
| `Secure` | 是 | `__Host-` 前缀要求；生产/自签 HTTPS 恒为 `Secure` |
| `SameSite` | `Lax` | 门户为顶级站点，`Lax` 覆盖顶级导航与同站子资源；**预览访问不再依赖本 cookie**（见 §2.8：预览走一次性 ticket + host-only 预览 cookie），故不再受 iframe 约束，也不得再以「预览需要」为由放宽为父域 cookie |
| `Max-Age` | 7 天，滚动续期（每次活跃请求刷新服务端 `expires_at` 并重发 cookie） | 与 `login_sessions.expires_at` 对应 |

cookie 值为**不透明会话令牌**（无 `sub`/无结构）：服务端只存 `login_sessions.token_hash`（如 `sha256(token)`），可单条吊销——offboarding「失效登录会话」依赖此性质（规格 §7.3）。**任何代码都不得把 cookie 值当作带字段的对象解析**（旧 `cookie.sub` 口径作废，见 §2.7）。

**开发期 `Secure` 处理**（对应审计矛盾清单第 9 条：env.md §0 允许 HTTP/自签 HTTPS 直联，而 cookie 固定 `Secure=true`）：

| 开发形态 | cookie 名称 | `Secure` | 说明 |
|---|---|---|---|
| 自签 HTTPS（`https://station.localhost:…` 或自签根） | `__Host-fde_session`（不变） | 是 | 走 HTTPS 时 `Secure` 照常生效，仅需浏览器信任自签/内部 CA（env §2）；**无需改 cookie** |
| 纯 HTTP（`http://station.localhost:8090`） | `fde_session_dev`（去 `__Host-` 前缀） | **否** | `__Host-` 前缀在无 `Secure` 时会被浏览器**拒绝**，故 HTTP 联调必须切到无前缀名称并关 `Secure`；由 portal 配置项 `COOKIE_PROFILE`（`prod` \| `dev-http`）切换，`dev-http` **仅限本机联调、禁止进入部署配置**（否则破坏 host-only/secure 不变式） |

> env.md 已落地（env §10 deploy 变量）：单一 `COOKIE_PROFILE=prod|dev-http`（`prod` → `__Host-fde_session` + `Secure=true`；`dev-http` → `fde_session_dev` + `Secure=false`，**仅限本机 HTTP 联调、禁止进部署配置**）。生产必须恒为 `__Host-fde_session` + `Secure=true`。

### 2.6 `GET /api/me`

响应 `200`：

```json
{
  "user": {
    "id": "u_alice",
    "login": "alice",
    "display_name": "Alice",
    "role": "fde",
    "fde_name": "alice",
    "auth_source": "local"
  }
}
```

| 字段 | 说明 |
|---|---|
| `role` | `fde` \| `admin`。P1 本地账号在本地表维护；OIDC 接入后来自 group claim（规格 §7.1，⚠️ 待决策者确认） |
| `fde_name` | 该用户的 FDE 标识（= 容器名 `fde-<name>` 的 `<name>`、预览域名首段），无容器时为 `null` |
| `auth_source` | `local` \| `oidc`（P1 恒为 `local`） |

### 2.7 `GET /api/forward-auth`（Traefik 回调，非浏览器 API）

Traefik 对 `<FDE_WILDCARD_HOST>`（`*.fde.<BASE_DOMAIN>`）的每个请求先调本端点（规格 §6.4）。**这是状态化授权：按「预览 token 的哈希」查 `preview_grants` 库，解析身份，再做 exposure 判定——不得解析 cookie 的 `sub`**（旧 `cookie.sub` 口径作废；session token 是不透明令牌，见 §2.5）。注意：**本端点不查 `login_sessions`**——portal 自身会话的哈希校验（登录态）才查 `login_sessions`，而 portal session cookie 是 host-only、不会到预览域（见下）。

**预览访问分两种凭证（互斥，按优先级取其一）**：

1. **一次性 ticket**（bootstrap）：portal 打开预览时经 §2.8 签发，随预览 URL 的 `?preview_ticket=<t>` 传入，**单次有效**，用于换取 host-only 预览 cookie。
2. **host-only 预览 cookie**（steady-state）：`__Host-fde_preview`，仅对当前预览 host 发送，iframe 内子资源复用。

**portal session cookie（`__Host-fde_session`）与本端点无关**：它是 host-only，浏览器**不会**把它发到 `*.fde.<BASE_DOMAIN>`；forwardAuth **一律忽略**任何碰巧出现的 portal session cookie，也**不把任何 cookie 透传给预览上游**（上游 dev server 永不接收 portal session cookie）。

请求头（**由 Traefik 覆盖生成，不得信任客户端自报**，见 topology.md §5.2 / `X-Forwarded-*` 信任边界）：

| 头 | 用途 |
|---|---|
| `X-Forwarded-Host` | 形如 `<fde>-<token>-<port>.fde.<BASE_DOMAIN>`（示例：`alice-r3a7fq-4001.fde.erix.vip`）；Traefik 以真实 `Host` 覆盖 |
| `X-Forwarded-Uri` / `X-Forwarded-Method` | 从 `X-Forwarded-Uri` 解析 `preview_ticket` 查询参数；方法用于审计 |
| `Cookie` | 只看 `__Host-fde_preview`（本 host 的预览 cookie） |

授权逻辑（顺序，任一失败即短路）：

1. **取 `X-Forwarded-Host` → 精确查 `port_allocations.hostname`**（活跃唯一索引）。查不到 → `404 not_found`（「路由表里没有 = 不可达」，原理二；正常不该发生，发生说明路由与 DB 失同步）。
2. allocation `state` 必须 ∈ {`allocated`,`active`}；`released` → `403 forbidden`（`allocation_released`）。
3. **取凭证**：先查 `X-Forwarded-Uri` 的 `preview_ticket` 参数；无 ticket 再查 `__Host-fde_preview` cookie；两者皆无 → `403 forbidden`（`preview_ticket_required`）。ticket 签发 / 预览 cookie 校验 / `allocated→active` 升级已由 WP2b 实现。
4. **校验凭证（按哈希查库，不解析 `sub`；所有凭证查询显式带 `state='active'`）**：
   - ticket（bootstrap）：`h = sha256(ticket)` → 查 `preview_grants`（`kind='ticket'`）。必须满足：存在、`state='active'`、未 `revoked_at`、未过期（`expires_at > now()`）、`allocation_id` == 第 1 步的 allocation。任一不满足 → 失败分支（见下）。
   - 预览 cookie（steady-state）：`h = sha256(cookie)` → 查 `preview_grants`（`kind='session'`）。必须满足：存在、`state='active'`、未 `revoked_at`、未过期、`allocation_id` 匹配；否则 `401 unauthorized`（`preview_session_invalid` / `preview_session_expired`）。校验通过则滚动续期（刷新 `expires_at`/`last_seen_at` 并重发 cookie）。
   - ticket 失败分支：
     - 不存在 / 已过期 / 格式非法 → `401 unauthorized`（`preview_ticket_invalid` / `preview_ticket_expired`）
     - 已撤销（`state='revoked'`）→ `403 forbidden`（`preview_ticket_revoked`）
     - `allocation_id` 不匹配 → `403 forbidden`（`preview_ticket_mismatch`）
     - 已消费（`state='used'`）→ 走第 6 步的**安全重放**分支（非必然 403，见下）
5. **按 `exposure` 判定**（用凭证解出的**主体身份 `user_id`**，规格 §6.5）：
   - `private`：`user_id == allocation.fde_id` **或** `users(user_id).role == 'admin'`（**显式 admin 例外，写审计 + 告警**）；否则 `403 forbidden`
   - `org-visible`：任意**有效且 `users.status='active'`** 的已认证用户 → 通过
   - `public`：不要求凭证（跳过第 3/4 步的凭证校验，但仍须过第 1/2 步 allocation 校验）；**默认不给**（规格 §6.5，仅 admin 可开）
   - 额外：`users.status='disabled'` 的用户一律拒绝（`403 forbidden`）。
6. **ticket 通过（bootstrap）→ 换取预览 cookie（crash-safe，单事务）**：
   - **同一 DB 事务**内完成：① 原子消费 ticket（`UPDATE preview_grants SET state='used', used_at=now() WHERE id=$id AND state='active' AND used_at IS NULL`，影响 0 行 = 已被消费，走重放分支）；② 派生 session token（**确定性**：`session_token = "s_" + base64url(HMAC-SHA256(session_signing_key, "preview-session:" + ticket))`，**不存明文**；`session_signing_key` 为 portal 服务端密钥、永不下发）；③ 幂等创建 session grant（`INSERT ... (token_hash=sha256(session_token), kind='session', user_id, allocation_id, issuer_id, parent_ticket_id, expires_at=now()+15min) ON CONFLICT (token_hash) DO NOTHING`）并记录 **ticket→session 关联**（`parent_ticket_id`）。
   - **响应丢失后的安全重放**：ticket 已被消费（第①步 0 行）但浏览器未收到 cookie 时，同一 ticket 再次到来 → 查 `parent_ticket_id=$id` 的 session 行：若存在且 `state='active'` 未过期 → **返回同一 bootstrap 结果**（同样的 `Set-Cookie` + `Location`，因 token 确定性派生）——**不产生第二个 session token、不改状态、不 403**；若该 session 已 `revoked`/`expired`（真·重放）→ `403 preview_ticket_used`。
   - 返回 `302 Found` + `Set-Cookie: __Host-fde_preview=<session_token>; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=<TTL>`（**不设 `Domain`**，host-only 于当前预览 host）+ `Location: <原 URL 的绝对形式，剔除 preview_ticket 参数与 fragment>`。浏览器跟随重定向后带预览 cookie 再请求，命中第 2 种凭证。
7. **预览 cookie 通过（steady-state）→ 放行**：`200` + 响应头 `X-Auth-User: <fde_name>`（Traefik `authResponseHeaders` 透传给上游；`public` 放行同样带 `X-Auth-User: <fde_name>`，取自 allocation）。

| 响应 | 含义 |
|---|---|
| `200` + `X-Auth-User` | 预览 cookie 有效（或 `public`），放行到上游 |
| `302` + `Set-Cookie` + `Location` | ticket 有效，换取预览 cookie 并跳回干净 URL（ticket 从地址栏消失） |
| `401` | ticket 无效 / 过期 / 格式非法（`preview_ticket_invalid`/`preview_ticket_expired`）· 预览 cookie 无效 / 过期（`preview_session_invalid`/`preview_session_expired`）——触发登录跳转 |
| `403` | 无凭证（`preview_ticket_required`）· 已认证但无权（exposure 越权，`forbidden`）/ 端口已释放（`allocation_released`）/ ticket 真·重放（已消费且无活跃派生 session，`preview_ticket_used`）· 已撤销（`preview_ticket_revoked`）· 不匹配（`preview_ticket_mismatch`）/ 用户已禁用 |
| `404` | hostname 无对应 allocation |

失败响应体统一用 §1.1 错误信封（`code` 见上各分支；Traefik 对 401 触发登录跳转、对 4xx/5xx 原样回传，`X-Auth-User` 缺失即不放行）。

每次判定（无论通过与否、无论 ticket/session/public）写 `audit_log`（`action='auth.forward_auth'`，`actor_id` = 凭证**主体** `user_id`（`public`/无凭证时 `NULL`），`target` = hostname，`details` = {uri, method, exposure, result, grant_kind, subject_id, issuer_id}）——「谁在什么时候看了哪个端口」（原理二）。**`details` 不得记录 ticket / cookie 明文**（只记 `grant_id` 与 token 哈希前 8 位）。**forwardAuth 故障（portal 5xx / 连接失败 / 超时）→ Traefik 侧 deny-all**（默认拒绝，绝不放行；可叠加 basic-auth 兜底，规格 §6.2 / topology.md §5.2）。

### 2.8 `POST /api/ports/:id/preview-ticket` + 预览 ticket / 预览 cookie 语义

#### 签发（`POST /api/ports/:id/preview-ticket`）

浏览器 API，要求有效 session cookie（§2.5）。用于「portal 打开预览」：portal 校验当前用户对该 allocation 的可见性后，签发一次性 ticket 并返回带 ticket 的预览 URL。

请求：无体（空 JSON `{}`）。

响应 `201`：

```json
{
  "ticket": "pt_<随机 256-bit base64url>",
  "url": "https://alice-r3a7fq-4001.fde.erix.vip/?preview_ticket=pt_…",
  "expires_in": 60
}
```

| 字段 | 说明 |
|---|---|
| `ticket` | 一次性、短 TTL 的不透明 token；只可经 `?preview_ticket=` 使用一次 |
| `url` | allocation.url + `?preview_ticket=`，前端**直接跳转/作为 iframe src**，不得自行拼接（规格 §8.1 同源） |
| `expires_in` | TTL 秒数（**60s ⚠️ 待决策者确认**） |

签发规则：
- 当前用户对该 allocation 的可见性必须成立：`private` → 仅 owner **或 admin**（admin 例外，写审计 + 告警）；`org-visible` → 任意已认证用户；`public` → 真公开免凭证（**默认不给，仅 admin 可开**）——签发侧同样仅 admin 可为 `public` allocation 签发 bootstrap ticket。不成立 → `404 not_found`（他人资源不泄露存在性，§1.2）。
- allocation 必须 `state ∈ {allocated,active}`；已 `released` 视同不存在 → `404`。
- portal 生成随机 token，只存 `preview_grants`（`kind='ticket'`，`token_hash=sha256(ticket)`，**`issuer_id` = 当前登录用户（签发者）**、`user_id` = **主体（被授权访问的身份：普通 FDE 自签 = issuer = subject；admin 代签他人 private = subject 为 admin）**、`allocation_id`、`expires_at=now+60s`、`created_ip/created_ua`）。**不存 ticket 明文**（与 `login_sessions.token_hash` 同口径）。

#### ticket 语义（`preview_grants.kind='ticket'`）

| 项 | 取值 / 语义 |
|---|---|
| 签名 / 存储 | **不透明随机 token + 服务端哈希查找**（`sha256`）；选**有状态**而非「无状态 HMAC 签名」——一次性（single-use）与撤销必须有服务端状态支撑，纯签名 ticket 无法可靠地「用一次即失效」或「显式撤销」 |
| TTL | **60s ⚠️ 待决策者确认**（覆盖人工点击/iframe 首帧的间隙，又不至于可被长期重放） |
| 一次性（crash-safe） | 首次校验在**同一 DB 事务**内消费 ticket + 派生 session + 记 `ticket→session` 关联（§2.7 第 6 步）；响应丢失后**同一 ticket 安全重放**（返回同一 bootstrap 结果、不产生第二个 session token）；仅当已消费且派生的 session 已 `revoked`/`expired` 才 `403 preview_ticket_used` |
| 撤销 | `state='active' → 'revoked'`（同事务置 `revoked_at`）即失效；portal 关闭预览页 / 用户登出 / admin 吊销时可选显式撤销未使用的 ticket |
| 与 allocation 释放联动 | allocation `state → released`（项目删除 / run 结束 / reaper）时，**同一事务**将该 allocation 的 `active` ticket 全部置 `state='revoked'`（同事务写 `revoked_at`）；且 forwardAuth 第 2 步始终重查 allocation `state`，双保险 |

#### 预览 cookie 语义（`preview_grants.kind='session'`）

| 项 | 取值 / 语义 |
|---|---|
| 生成 | ticket 首次校验通过后，forwardAuth 在**同一事务**内消费 ticket 并**确定性派生** session token（`HMAC-SHA256(session_signing_key, "preview-session:" + ticket)`，不存明文），存 `preview_grants`（`kind='session'`，记 `parent_ticket_id`），并 `302` 下发 `Set-Cookie`（§2.7 第 6 步） |
| 名称 / 属性 | `__Host-fde_preview`；`Secure`/`HttpOnly`/`SameSite=Lax`/`Path=/`、**不设 `Domain`（host-only 于当前预览 host）**；开发期纯 HTTP 按 §2.5 同法去 `__Host-` 前缀并关 `Secure` |
| TTL | `Max-Age` 与 `expires_at` 一致：**15 分钟 ⚠️ 待决策者确认**，滚动续期（每次 forwardAuth 成功刷新） |
| 撤销 | `revoked_at` 置位 / TTL 过期 / allocation `released` / 用户 `disabled` 均失效（forwardAuth 每请求重查） |
| 上游可见性 | **预览 cookie 与 portal session cookie 都绝不到达预览上游**：二者 host-only、只在各自 host 发送；Traefik `strip-cookie` 中间件在放行后删除 `Cookie`（fde-platform §6.4）——上游 dev server 收到的请求头里**没有 `Cookie`** |

> DDL 已落地（schema.sql §4 / model.md §1.21）：`preview_grants` 表（`token_hash UNIQUE`、`kind ∈ {ticket,session}`、`state ∈ {active,used,revoked,expired}`、`user_id`→`users`（主体）、`issuer_id`→`users`（ticket 签发者，session 系统派生可空）、`allocation_id`→`port_allocations`、`parent_ticket_id`→`preview_grants.id`（ticket→session 关联，可空）、`expires_at`、`used_at`、`revoked_at`、`last_seen_at`、`created_at`、`created_ip`、`created_ua`），并加 reaper 定期清理过期行。
>
> **DDL/契约（B3/B4/B11）**：`issuer_id`（ticket 的签发者；session 为系统派生、可空）与 `parent_ticket_id`（ticket→session 关联，可空）已落 `preview_grants`；`user_id` 语义 = **主体（被授权访问的身份）**。reaper 语义：`active` 且 `expires_at <= now()` → `state='expired'`（懒打标）；allocation 释放 / 显式吊销 → `state='revoked'`（同事务写 `revoked_at`）；ticket 消费 → `state='used'`（同事务写 `used_at`）。**所有凭证查询显式带 `state='active'`**（B11）。
>
> **URL ticket 脱敏（B3）**：`preview_ticket` 是 URL 中的凭证，必须脱敏——① **审计**：`audit_log.details` 只记 `grant_kind='ticket'` + `grant_id` + token 哈希前缀，**不记 ticket 明文**；② **access log**：Traefik 原始 access log 对 `*.fde.<base>` 的 `preview_ticket` 查询参数**脱敏/不记录**（accessLog fields 排除 query，或 reconciler 对 `*.fde.<base>` 不记 query string）；③ **浏览器 history/地址栏**：第 6 步 `302 Location` 剔除 `preview_ticket`，地址栏/历史不留 ticket；④ **Referer**：预览响应统一 **`Referrer-Policy: no-referrer`**（fde-platform §6.3），ticket URL 不会经 Referer 泄漏给子资源/外链。

### 2.9 P1 本地账号生命周期（bootstrap / 建第二个 FDE / 禁用恢复 / 密码与 TOTP）

> 原则对齐（principles §4 Q3 倾向 (a)）：P1 本地账号**仅作 break-glass + bootstrap**，数量极少（admin 1~2、FDE 视 onboarding 需要），因此**不开放用户管理公开 API**，改走 **portal 侧 CLI**（跑在 portal 容器内，经 portal 唯一 DB 写方 + 审计），避免 P1 把账号管理面暴露给浏览器攻击面。OIDC 接入（P2）后日常账号走 JIT provisioning，本节 CLI 仍保留作破窗通道。

#### 2.9.1 第一个 admin（bootstrap）

```
docker compose exec portal station-portal bootstrap-admin \
  --login <login> --display-name <name> [--email <email>] [--fde-name <name>]
```

- 先迁移 DB 再执行；命令幂等：`users` 已有 active admin 时默认拒绝并提示，`--allow-extra` 才可加第 2 个（规格 §7.1：本地 admin 1~2 个）。
- 建 `users`（`role='admin'`、`auth_source='local'`、`status='active'`、`fde_name` 缺省为 NULL）、生成随机初始口令 → argon2id 哈希入 `password_hash`、生成 TOTP 种子 → 入 `totp_secret`。
- **输出**：一次性 `otpauth://totp/…` URI + 二维码（终端）+ 初始口令；**强制**首次登录后立即改口令（portal 对 `password_hash` 标记 `must_change` 或等价，见 §2.9.4）。TOTP 种子只在此处下发一次，之后不显示。
- 每步写 `audit_log`（`auth.bootstrap_admin`）。

**SQL 兜底**（仅 portal 无法启动时的恢复路径，⚠️ 危险）：直接 `INSERT` `users` 行——必须用与 portal 相同的 argon2id 参数生成 `password_hash`、以 base32 正确编码 `totp_secret`；此路径绕过审计与哈希一致性检查，**用完即弃、事后必须补齐审计**。

#### 2.9.2 第二个及后续 FDE 用户（P1 用 CLI）

```
docker compose exec portal station-portal user create \
  --login <login> --role fde --fde-name <name> [--display-name ...] [--email ...]
```

- 建 `users`（`role='fde'`、`auth_source='local'`、`status='active'`、`fde_name=<name>`，`fde_name` 全局唯一）；生成初始口令 + TOTP 种子，同上输出。
- **只建账号，不建容器**：容器的子网/网络/端口/模板由 onboarding workflow（规格 §7.2）作为**单独的 admin 动作**触发（H-B D-1/D-6/D-10）。P1 需第二个 FDE 用户 = 先本命令建账号，再跑 onboarding。
- 每步写 `audit_log`（`user.create`）。

> 选型说明（⚠️ 已按 principles §4 倾向并写死，供决策者确认）：P1 **不新增公开用户管理端点**（`POST /api/users` 等），避免把「建账号 + 下发 TOTP 种子」这类高敏操作放进浏览器攻击面；P2 接入 OIDC 后由 IdP 承担 provisioning，本地 CLI 仅作破窗。若决策者要求「管理员在 UI 里建第二个 FDE」，再补 `POST /api/users`（admin-only）+ 复核 TOTP 下发通道——本期不做。

#### 2.9.3 禁用 / 恢复

```
station-portal user disable --login <login> [--reason "..."]
station-portal user enable  --login <login>
```

- `disable`：`users.status → disabled` + `disabled_at=now()`；**同事务**吊销该用户全部 `login_sessions`（`revoked_at`）、`preview_grants`、`api_tokens`。此后登录（§2.2）、forwardAuth（§2.7 第 5 步 `users.status='disabled'`）、internal 归属均拒绝。**容器停止/runner token/LLM 虚拟 key 吊销属 offboarding（规格 §7.3），是独立命令**，不在本命令内。
- `enable`：`status → active`、清 `disabled_at`；**无自动恢复路径**（model.md §1.1 状态机）。恢复后用户需重新登录、重新签发预览 ticket。
- 审计：`user.disable` / `user.enable`（actor = 执行 admin）。

#### 2.9.4 密码 / TOTP 策略

| 项 | 策略 |
|---|---|
| 口令哈希 | **argon2id**；参数（⚠️ 待决策者确认，倾向 OWASP 2026）：`m=19 MiB, t=2, p=1`；本地账号与 OIDC 账号分离（OIDC 无 `password_hash`） |
| 口令强度 | 长度下限 **12**（⚠️ 待决策者确认）；不做复杂组合规则，但拒绝「与 login 相同 / 常见弱口令」；初始口令必须 `must_change`（首次登录强制改密） |
| 口令重置 | `station-portal user set-password --login <login>`（admin 本地执行）：重置为新随机口令 + `must_change`，并**吊销该用户全部会话**（防旧会话续用）；不通过公开 API 暴露自助找回 |
| TOTP | **强制**（规格 §7.1）：RFC 6238 `SHA-1 / 6 位 / 30s`，校验窗口 ±1 步 + 单码防重放（同 30s 窗口内同码只接受一次）；种子 base32，仅 bootstrap/`user create` 时下发 |
| TOTP 重置 | `station-portal user reset-totp --login <login>`：重生成种子并输出 otpauth URI/二维码；**强制该用户重新走两步登录** |
| 限流 | 登录爆破与 TOTP 连续失败走 §2.2/§2.3 的 `429 rate_limited`（`Retry-After`） |

> **口令哈希实现注（P1 skeleton）**：⚠️ P1 骨架实现暂用 Node 内置 `crypto.scrypt`（零依赖，满足「运行时依赖仅 `pg`」）；argon2id 的参数本身仍待决策者确认，切换时按自描述哈希（`algo$…$salt$hash`）平滑迁移，登录成功时对旧格式自动 rehash。
>
> ⚠️ 待决策者确认：TOTP 本身是否保留为**强制**（规格 §7.1 已写「强制 TOTP」，此处按已决处理，仅算法参数留待确认）；admin 数量上限是否收紧为 1。

### 2.10 授权矩阵（P1）

四类主体：`admin`（本地破窗 admin）、`普通 FDE`（本人资源）、`同租户已认证`（`org-visible` 的观者）、`公开`（未认证 / `public` 观者）。资源归属默认按「当前登录用户」过滤，他人资源一律 `404`（§1.2）。

| 主体 | 自己的项目 | 自己的会话/run | 自己的审批 | 预览访问（exposure） | 用户管理 / 全局 |
|---|---|---|---|---|---|
| `admin` | 读/写/删；运维视角可**读全部 FDE 项目**（每次读他人资源写审计 + 告警） | 读/写/stop；运维视角可读全部会话/run | 决定自己的审批单；运维视角可读全部审批单 | 可对任意 allocation 签发 ticket（含 `private` 他人；`issuer_id`=admin、主体 `user_id`=admin，forwardAuth 按主体 + **admin 例外**放行并写审计）与开 `public` | 建/禁用/恢复用户、重置口令/TOTP、吊销会话/ticket、offboarding（§2.9） |
| `普通 FDE` | 仅本人项目（他人 → `404`） | 仅本人 session/run | 仅本人审批单（他人 → `404`） | 本人 `private` + 任意 `org-visible` + `public`；**不得开 `public`**（`403 forbidden`，§4.7） | 无 |
| `同租户已认证` | ✗（`404`） | ✗（`404`） | ✗（`404`） | 仅 `org-visible` allocation 的预览（ticket 绑定其 `user_id`） | 无 |
| `公开`（未认证） | ✗（`401`/`404`） | ✗ | ✗ | 仅 `public` allocation 的预览（无凭证，审计 `actor_id=NULL`） | 无 |

> 口径补充：`org-visible`/`public` 的预览仍需经 portal（§2.8 签发 ticket / 直接跳转），且 forwardAuth 每请求重查 `users.status` 与 allocation `state`（§2.7）；「同租户可见」只是 exposure 的放宽，不等于可读他人项目/会话/run 数据。
>
> **ticket 的 `issuer_id` 与主体 `user_id`（B4，三处口径一致）**：签发（§2.8）记录两者——`issuer_id` = 谁签的（登录用户），`user_id` = 主体（被授权访问的身份）；forwardAuth 的 `private` 判定（§2.7 第 5 步）用**主体** + **admin 例外**；审计（§2.7）同时记 `subject_id`/`issuer_id`。普通 FDE 自签 = issuer = subject = owner；admin 代签他人 private = issuer = subject = admin。

---

## 3. 项目（Projects）

项目 = FDE 容器内的一个工作目录 `~/projects/<project>`（若关联仓库则可作为仓库目录；规格 §2 术语）。所有项目端点只返回/操作**当前登录用户**的项目。

### 3.1 Project 对象

```json
{
  "id": "p_8h2k",
  "name": "proj1",
  "repo_url": "https://git.<BASE_DOMAIN>/client-x/proj1.git",
  "root_path": "~/projects/proj1",
  "slot": 2,
  "template": "node",
  "created_at": "2026-09-12T08:30:00.000Z"
}
```

| 字段 | 说明 |
|---|---|
| `name` | 用户内唯一；同时是容器内目录名，故只允许 `[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?`（同 schema.sql CHECK，不允许尾随 `-`） |
| `repo_url` | 可选仓库地址，**仅作记录/展示元数据**；不填时为 `null`。平台不 clone、不物化该目录、不下发 git 凭据；clone 与 git 凭据由 FDE 在容器内自行配置（规格 §7.2/§12.2，决策者 2026-09，issue #3 评论） |
| `slot` | 项目端口块序号（决定 `4000 + slot*8` 起始端口，规格 §8.2） |
| `template` | 项目模板（onboarding 第 5 步生成 AGENTS.md 等，规格 §7.2） |

> 项目目录 = 容器内 `/home/<FDE_CONTAINER_USER>/projects/<name>`；当前容器用户为 `erix`。

### 3.2 `GET /api/projects`

分页列表（§1.3）。响应 `200`：`{ "items": [Project...], "next_cursor": null }`。

### 3.3 `POST /api/projects`

请求：

```json
{ "name": "proj1", "repo_url": "https://git.<BASE_DOMAIN>/client-x/proj1.git", "template": "node" }
```

`repo_url` 可省略（或传空串，服务端按 `null` 落库）；`template` 也可省略（默认模板）。不填仓库时，项目就是容器内 `~/projects/<name>` 下的空工作目录，FDE 无需预先了解仓库概念。

响应 `201`：Project 对象 + 本次分配的端口（**创建项目与分配项目级端口是同一事务**，规格 §7.2 第 3 步 / §8.2）：

```json
{
  "project": { "id": "p_8h2k", "name": "proj1", "...": "..." },
  "ports": [
    {
      "id": "pa_1",
      "scope": "project",
      "port": 4016,
      "role": "frontend",
      "run_id": null,
      "hostname": "alice-p-proj1-4016.fde.erix.vip",
      "url": "https://alice-p-proj1-4016.fde.erix.vip",
      "exposure": "private",
      "state": "allocated"
    }
  ]
}
```

错误：

| HTTP | code | 场景 |
|---|---|---|
| 400 | `validation_failed` | name 非法 / 提供了 repo_url 但其地址非法 |
| 409 | `name_conflict` | 同名项目已存在 |
| 409 | `port_quota_exceeded` | 用户端口总配额超限（规格 §8.2：**明确报错**而非静默漂移） |

> **边界（决策者 2026-09，issue #3 评论；issue #52 方案 A）**：创建项目 = 建 DB 记录 + 分配端口 + 生成项目模板；`repo_url` 是可选登记元数据。**平台不负责 clone，也不下发 git 凭据**——提供地址时仓库目录由 FDE 在容器内自行 `git clone` 并配置凭据；不提供地址时项目就是 `~/projects/<name>` 下的空工作目录，FDE 不需要知道仓库概念（等同他自己的开发机，规格 §7.2/§12.2）。

### 3.4 `GET /api/projects/:id`

响应 `200`：`{ "project": {...}, "ports": [PortAllocation...] }`（ports 结构同 §4.7，示例见上文 §3.3）。

### 3.5 `PATCH /api/projects/:id`

请求（全部可选）：`{ "name": "proj2" }`。
响应 `200`：更新后的 Project。
错误：`409 name_conflict`；**改名不重生成**已有 allocation 的 `hostname`/`url`——hostname 里的 `<project-name>` 是**分配时的项目名快照**，改名只更新 `projects.name`（容器内目录名）与**后续新建** run/端口的 hostname，旧 hostname 保持可访问（书签不破，规格 §8.5 不可变性）。改名不写 route outbox（无 hostname/url 变化）；`ports.json` 与 Traefik 路由的更新时机 = **只有新建/释放 allocation** 才触发（规格 §8.1，DB 为真相）。

### 3.6 `DELETE /api/projects/:id`

响应 `204`。删除 = 回收该项目全部端口（`state → released`）+ 写 route outbox tombstone（同一 DB 事务，规格 §8.2）+ 项目归档；Traefik 路由由 file provider **异步、幂等**发布删除（「路由表里没有 = 不可达」）。
错误：`409 active_runs` —— 项目下有进行中的 run，须先停止。

---

## 4. 会话与对话（Sessions / Messages / Runs）

- `session` = 对话会话（UI 概念），一个 session 串起多次 `run`（规格 §2）。
- 一个 session **同一时刻最多一个进行中的 run**（由「一个 session 串起多次 run」的串行语义推导）。

### 4.1 ChatSession / Message / Run 对象

```json
// ChatSession
{
  "id": "s_3kd9",
  "project_id": "p_8h2k",
  "title": "修登录页样式",
  "model": "claude-sonnet",
  "status": "active",
  "last_seq": 128,
  "active_run_id": "9d3b2f1e-....",
  "created_at": "2026-09-12T08:30:00.000Z",
  "updated_at": "2026-09-12T09:10:00.000Z"
}
```

| 字段 | 说明 |
|---|---|
| `status` | `active` \| `archived` |
| `last_seq` | 该 session 已分配的最大 `seq`（messages 与 run_events **共用同一分配器**，schema.sql §3；SSE 断线补发的基准，规格 §10.2） |
| `active_run_id` | 进行中 run 的 id，无则 `null` |

```json
// Message（§9.2 第①层：人看的对话）
{
  "id": "m_552",
  "session_id": "s_3kd9",
  "seq": 41,
  "role": "user",
  "content": "把登录按钮改成品牌色",
  "synthetic": false,
  "attachments": [],
  "created_at": "2026-09-12T09:00:00.000Z"
}
```

> **`synthetic` 必须参与渲染**（规格 §9.2）：`role` 为 `user` 但 `synthetic: true` 的消息是 judge/wrapup 注入的合成消息，UI 必须显著标记（如「系统注入」徽标），不得渲染成用户自己说的话。

```json
// Run
{
  "id": "9d3b2f1e-7c4a-4e2b-9f0a-1c2d3e4f5a6b",
  "session_id": "s_3kd9",
  "status": "running",
  "termination": null,
  "rounds": 3,
  "usage": { "input_tokens": 15230, "output_tokens": 2104 },
  "cost": null,
  "error": null,
  "started_at": "2026-09-12T09:00:01.000Z",
  "ended_at": null
}
```

| 字段 | 说明 |
|---|---|
| `status` | `queued` \| `running` \| `cancelling` \| `finished` \| `failed` |
| `termination` | run 结束时由 `runToolLoop` 返回值透传（见 §5.3 `run_end`），运行中为 `null`。类型为**对象** `{ "reason": string, "detail"?: string }`；`reason` 取值集合：`end_turn` \| `no_tool` \| `stall` \| `max_rounds_cap` \| `reflection_stop` \| `judge_done` \| `continuation_exhausted` \| `aborted` \| `failed`（依据：erix-agent v0.3.5 `src/loop.js:622`） |
| `error` | 失败时为 `{ "code": "checkpoint_failed", "message": "...", "retryable": true }`，结构同 §1.1 错误信封内层；成功为 `null`。run 级错误码见 §6 |
| `cost` | 记账口径依赖 Q1/Q4 ⚠️ 待决策者确认；P1 可为 `null` |

### 4.2 会话 CRUD

| 端点 | 请求 | 响应 |
|---|---|---|
| `GET /api/sessions?project_id=<id>` | 可选按项目过滤，分页 | `200 {items, next_cursor}` |
| `POST /api/sessions` | `{ "project_id": "p_8h2k", "title": "可选", "model": "可选" }` | `201 ChatSession` |
| `GET /api/sessions/:id` | — | `200 { "session": ChatSession, "messages": [Message...]（按 seq 升序、分页参数同 §1.3）, "last_seq": 128 }` |
| `PATCH /api/sessions/:id` | `{ "title": "新标题" }` | `200 ChatSession` |
| `DELETE /api/sessions/:id` | — | `204`（归档，`status → archived`；有进行中 run 时 `409 run_in_progress`） |

### 4.3 `POST /api/sessions/:id/messages`

发送用户消息并启动一次 run。**多轮对话宿主侧必须显式把本轮用户输入作为 `task` 传给引擎**（规格 §13.2-4），前端无需关心。

请求：

```json
{
  "content": "把登录按钮改成品牌色",
  "attachments": []
}
```

| 字段 | 说明 |
|---|---|
| `content` | 必填，非空字符串 |
| `attachments` | 可选，数组，元素 `{ "kind": "file\|image", "path": "<容器内路径>", "name": "..." }`；P1 仅支持引用容器内已存在路径 |

响应 `202`（已受理；run 异步执行，进展走 SSE）：

```json
{
  "message": { "id": "m_552", "seq": 41, "role": "user", "...": "..." },
  "run": { "id": "9d3b2f1e-...", "status": "queued", "...": "..." }
}
```

错误：

| HTTP | code | 场景 |
|---|---|---|
| 400 | `validation_failed` | content 为空 |
| 404 | `not_found` | session 不存在/不属本人 |
| 409 | `run_in_progress` | 该 session 已有进行中 run |
| 409 | `no_active_container` | 拉模型补充分支：该用户**从未有过任何容器记录**（containers 无非 removed 行，无法确定 run 归属与入队目标）——落库即 202 前提是存在容器行（runs.container_id 非空）；已有但离线的容器不受此码影响（§6.3） |
| 429 | `rate_limited` | 已知该用户 LLM 配额耗尽（上次 run 已确认），直接拒绝避免再烧配额（§6.1） |
| 503 | `container_unreachable` | ⚠️ 仅 push 下发模式（待决策者确认）：FDE 容器不在线/不可达且**不产生** message/run 记录；拉模型（终态）落库即 202、不返回此码（§6.3） |

> 支持 `Idempotency-Key`（§1.4）：断网重发同 key 返回首次的 `message`/`run`，不产生重复消息。实现口径：TTL 24h；**先占位后执行 + 记账并入业务事务**（`in_progress` 占位 → 业务事务内 `record()` 转 `done`，同一次 COMMIT，故「同 key 至多一次副作用（记账与业务写入同事务）」）；`claim_token` owner fencing 使被抢回的旧持有者的迟到记账/释放失效（§1.4）；同 key 不同载荷 → `409 idempotency_key_reuse`；并发同 key 未收敛（占位 < 5 分钟）→ `409 idempotency_conflict`（`retryable: true`，稍后重试拿首次结果）；重放路径不重复副作用（不重复唤醒 runner）。

### 4.4 `GET /api/sessions/:id/events`（SSE）

实时事件流，详见 §5。

### 4.5 `POST /api/sessions/:id/stop`

停止当前 run。`AbortController` 跨不了进程（规格 §10.3）——portal 写 DB `cancel_requested_at` 标记（+ 单机 push 模式下同步通知 runner ⚠️ 见 §6.3 注），runner 侧终止。

请求体：无（空 JSON `{}`）。

响应 `200`：

```json
{ "run": { "id": "9d3b2f1e-...", "status": "cancelling", "...": "..." } }
```

最终终止结果通过 SSE 的 `run_end` 事件（`termination: { "reason": "aborted" }`，依据：erix-agent v0.3.5 `src/loop.js:712`）与 run 状态收敛体现；前端调本端点后应继续听 SSE，不要轮询。

错误：`404 not_found`；`409 no_active_run`（无进行中 run）。

### 4.6 `GET /api/runs/:id`

run 详情（Run 对象，§4.1）。用于查看已结束 run 的 `termination` / `usage` / `error`（如 `checkpoint_failed`），以及审批卡片跳转。

### 4.6a `GET /api/runs/:id/artifact`（issue #64 R1）

run 终态产物 bundle 取回（runner §6.6）。鉴权：**admin 或 run 属主**（session cookie；非属主 404，不泄露存在性——与 §4.6 同口径）。

- 该 run 有产物（agentd 终态清场前经 U13 上传）→ `200`，`Content-Type: application/gzip` 流式返回 tar.gz（`Content-Disposition: attachment; filename="<runId>.tar.gz"`；`X-Artifact-Truncated` 标记是否被 20MB 上限截断）。包内结构：`diff.patch`（git diff HEAD，含 staged）+ `files/NNNNNN`（新文件快照，真实路径见 manifest）+ `manifest.json`。
- 无产物（空变更未上传 / run 不存在 / 非属主）→ `404 not_found`。

### 4.7 端口列表

#### `GET /api/projects/:id/ports`

响应 `200`：

```json
{
  "items": [
    {
      "id": "pa_1",
      "scope": "project",
      "port": 4016,
      "role": "frontend",
      "run_id": null,
      "hostname": "alice-p-proj1-4016.fde.erix.vip",
      "url": "https://alice-p-proj1-4016.fde.erix.vip",
      "exposure": "private",
      "state": "active",
      "released_at": null
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `scope` | `project` \| `run`。⚠️ 待决策者确认（Q5）：P1 先只做项目级，响应模型保留 `scope`/`run_id` 字段以兼容 P2 的 run 级端口（principles §4 Q5 倾向 (b) 起步） |
| `role` | `frontend` \| `backend` \| `debug` \| `spare`（规格 §8.2 端口块用途） |
| `url` | 由 portal 与 Traefik 路由同源生成（规格 §8.1）；前端**只展示/跳转此 url，永不自行拼接** |
| `exposure` | `private`（默认）\| `org-visible` \| `public`（规格 §6.5） |
| `state` | `allocated` \| `active` \| `released` |

#### `PATCH /api/ports/:id`

请求：`{ "exposure": "org-visible" }`。
响应 `200`：更新后的 PortAllocation。
错误：

| HTTP | code | 场景 |
|---|---|---|
| 403 | `forbidden` | 非 admin 申请 `public`（规格 §6.5：public 默认不给） |
| 400 | `validation_failed` | 请求体非法（如 `exposure` 不在枚举内） |
| 404 | `not_found` | allocation 不存在；已 `released` 的 allocation 视同不存在 |

### 4.8 工具审批（Approvals）

judge/工具拦截产生的待审批项（规格 §9.1 `approvals` / `tool_calls`）。

#### Approval 对象

```json
{
  "id": "ap_77",
  "run_id": "9d3b2f1e-...",
  "session_id": "s_3kd9",
  "tool_call": {
    "id": "tc_301",
    "round": 4,
    "name": "bash",
    "input_digest": "rm -rf node_modules && pnpm install",
    "judged": true
  },
  "status": "pending",
  "decided_by": null,
  "decided_at": null,
  "created_at": "2026-09-12T09:05:00.000Z"
}
```

| 字段 | 说明 |
|---|---|
| `tool_call.input_digest` | 工具入参的展示摘要（完整入参可能很大；详情经 `GET /api/runs/:id` 关联查询） |
| `status` | `pending` \| `approved` \| `denied` |

> `tool_call.id` / 审批请求里的 `tool_call_id` 是**外部 `call_id`**（事件流 `tool_use`/`tool_result` 的 `tool_call_id`，字符串），**不是** `tool_calls.id` 内部主键（后者为 uuid、不外露）。canonical 规则见 model.md §1.19。⚠️ 审批契约由 issue #10 定稿确认，若改判为 UUID 则以 #10 为准。

#### `GET /api/approvals?status=pending`

分页列表，只返回本人 run 的审批项。响应 `200 {items, next_cursor}`。

#### `POST /api/approvals/:id`

请求：`{ "decision": "approve", "note": "可选备注" }`（`decision`: `approve` \| `deny`）。
响应 `200`：更新后的 Approval；runner 轮询到决定后继续/终止该工具调用。
错误：`404 not_found`；`409 already_decided`（已 `approved`/`denied`）；`409 approval_expired`（审批已超时 `expired`，迟到决定被拒，§9.10）。

---

## 5. SSE 事件流（`GET /api/sessions/:id/events`）

### 5.1 传输语义

- **SSE 而非 WebSocket**（规格 §10.2）：事件单向，输入走 `POST .../messages`。
- **事件先落 DB，portal 从 DB 读并推流**（规格 §10.2 / D7）：portal 重启不杀正在跑的 run；`seq` 由宿主在落库事务内**逐事件原子 +1 分配**（`UPDATE chat_sessions SET last_seq = last_seq + 1 ... RETURNING`，`UNIQUE(session_id, seq)` 兜底），**每个 session 内严格单调递增、无空洞**——不存在「并发落库产生合法间隙」的情况（runner §7.3）。
  > **实现注记（issue #25 裁决）**：「无空洞」只对 **`messages ∪ run_events` 联合序列**成立（两表共用 `chat_sessions.last_seq` 分配器，schema.sql §3）；SSE 只推 `run_events`，故**事件流单独看存在合法空洞**（user 消息、assistant 回写各占一个 seq）。因此客户端**不得**以「seq 跳号」作为重连触发条件（会把合法空洞误判为丢事件，重放后仍跳号 → 无限重连风暴，实测复现）。丢失恢复路径：① 服务端 `resync` 控制帧（缓冲溢出，见下）；② 浏览器 `EventSource` 自动重连天然携带 `Last-Event-ID`（§5.2 补发 `seq > lastEventId`）。前端仅在收到 `resync` 时主动 `close()` + 以 `?last_event_id=<本地已知最大 seq>` 重连。
- 响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`X-Accel-Buffering: no`。
- 每 15s 发送注释行心跳（`: ping\n\n`），防止中间层断连。心跳不是事件，不占 seq。
- 响应建议携带 `retry: 3000`，指导浏览器断线重连间隔。
- **`resync` 控制帧**（宿主侧帧，**不属** §5.3 事件类型清单、不带 `seq`/`id`）：服务端补发前的缓冲溢出（上限 1000 条）时，portal 不再静默丢事件——向该连接写 `event: resync` + `data: {"reason":"buffer_overflow"}` 后 `res.end()`。该帧**不带** `last_seq`：重连游标由客户端用自己的本地水位线（已收到的最大 `seq`，含 `messages` 与 `run_events` 共用分配器造成的跳号）维护，服务端缓冲区里的最大 seq 不构成可靠游标（补发/写回窗口内可能漏）。客户端应立刻 `close()` 并以 `?last_event_id=<本地已知最大 seq>` 重连，由补发路径收敛（§5.2）。这是客户端唯一的主动重连触发条件（未知类型忽略原则仍适用于 §5.3 之外的其它扩展类型）。

每条事件的 wire 格式：

```
id: 129
event: assistant_delta
data: {"seq":129,"ts":"2026-09-12T09:00:02.130Z","session_id":"s_3kd9","run_id":"9d3b2f1e-...","type":"assistant_delta","text":"好的"}

```

`id` 字段恒等于 envelope 的 `seq`——这是 `Last-Event-ID` 的依据。

### 5.2 `Last-Event-ID` 断线续传语义

1. 客户端（浏览器 `EventSource` 自动）重连时带 `Last-Event-ID: <seq>` 头。
2. portal 从 DB 补发该 session 中 **`seq` 大于该值**的全部历史事件，再切到实时流。
3. 无 `Last-Event-ID`（首次连接）：**不补发历史**，只推连接之后的新事件——历史消息/状态由 `GET /api/sessions/:id`（含 `last_seq` 与消息列表）获取；前端如需从某点重放，可显式带 `Last-Event-ID` 或查询参数 `?last_event_id=<seq>`（两者等价，查询参数供非 `EventSource` 客户端使用）。
4. `Last-Event-ID` 大于当前 `last_seq`（如 session 已删）→ `404 not_found`；小于最小保留 seq（事件归档后）→ `410 Gone` + `{"error":{"code":"replay_unavailable", ...}}`，前端应回退到 `GET /api/sessions/:id` 全量拉取。

> ⚠️ 与归档策略的对应（model.md §4，决策者 2026-09，issue #3 评论）：**事件冷存导出暂不实施（P1/P2 不删除事件）**，因此 `410 replay_unavailable` **保留定义但当前不会触发**；前端仍应实现该回退分支以兼容将来启用归档。

> 也可用该端点做**事件重放**（P2 验收「断线重连不漏事件」即依赖本节语义）。

### 5.3 事件信封完整类型清单（对应规格 §10.1；LoopEvent 部分与 erix-agent v0.3.5 `src/loop.js:533` 的 LoopEvent union 一一对应，共 8 类）

所有事件共享信封：

| 字段 | 类型 | 说明 |
|---|---|---|
| `seq` | number | 宿主落库时分配，session 内单调递增 |
| `ts` | string | ISO 8601 UTC，宿主落库时间 |
| `session_id` | string | — |
| `run_id` | string | 产生该事件的 run |
| `type` | string | 见下表 |

**类型清单**（前端 `switch` 必须覆盖全部；未知类型一律忽略并记日志，保证上游 additive 扩展向后兼容）：

| # | `type` | 来源回调 | 类型特有字段 |
|---|---|---|---|
| 1 | `round_start` | `onEvent`（LoopEvent 透传） | `round: number`（依据：`src/loop.js:1916`） |
| 2 | `attempt` | 同上 | `round: number`，`attempt: number`（1-based），`maxAttempts: number`（依据：`src/loop.js:1346-1351`） |
| 3 | `recovering` | 同上 | `round: number`，`attempt: number`，`maxAttempts: number`（provider 重试前发出，依据：`src/loop.js:1447-1452`） |
| 4 | `recovered` | 同上 | `round: number`，`attempt: number`（重试成功，依据：`src/loop.js:1413`/`1424`） |
| 5 | `usage` | 同上 | `round: number`，`usage: object`（嵌套 usage 对象，形如 `{input_tokens, output_tokens}`；依据：`src/loop.js:1355`/`1928`/`1960`。宿主若拍平为顶层 `input_tokens`/`output_tokens`，属宿主侧改写，须显式注明） |
| 6 | `tool_use` | 同上 | `tool_call_id: string`，`name: string`，`input: object` |
| 7 | `tool_result` | 同上 | `tool_call_id: string`，`name: string`，`result_digest: string`，`duration_ms: number`，`ok: boolean` |
| 8 | `round_end` | 同上 | `round: number` |
| 9 | `assistant_delta` | `onDelta` | `text: string`（增量文本片段） |
| 10 | `reasoning_delta` | `onReasoningDelta` | `text: string`（推理增量片段） |
| 11 | `tool_call_delta` | `onToolCall`（参数增量） | `tool_call_id: string`，`name?: string`（仅首帧），`arguments_delta: string`（JSON 文本片段，前端按序拼接得完整入参） |
| 12 | `judge` | `onJudge` | `kind: "round"\|"intercept"`，`action: "judge_done"\|"nudge"\|"continue"\|"executed"\|"blocked"\|"degraded"`，`decision: {done, confidence, reason, evidence} \| null`，可选 `error: "timeout"\|"error"\|"parse"`，可选 `tool: {id?, name?, input?}`（依据：erix-agent v0.3.5 `src/loop.js:545-552` JudgeEvent typedef；对应 `judge_decisions` 表） |
| 13 | `run_end` | portal 由 U2 终态**合成**（数据源 = `runToolLoop` 返回值经 U2 终态载荷上报，worker 不再经 U3 发 `run_end`，runner §7.6） | `termination: { reason, detail? }`（**对象**，`reason` 取值集合见 §4.1；依据：`src/loop.js:622`），`usage: { input_tokens, output_tokens }`（整 run 汇总），`compaction_stats: array`（宿主侧字段名：值为引擎返回值 `compactionStats` **数组**原样透传，元素 `{compacted, foldedRounds, tokensBefore, tokensAfter}`，依据：erix-agent v0.3.5 `src/loop.js:624`；snake_case 命名为宿主约定），`attempt`（第几次尝试，runner §7.6）；失败时附加 `error: { code, message, retryable }`（见 §6） |

> 说明与边界：
> - 第 1~8 类是 **erix `LoopEvent` 的原样透传**（规格 §10.1：「`type: 同 LoopEvent`」），与 erix-agent v0.3.5 `src/loop.js:533` 的 LoopEvent union 一一对应（8 类，契约锚点见 principles §6）。**上游 additive 新增 LoopEvent 子类型时宿主原样透传**，前端按「未知类型忽略」规则处理即兼容（规格 §13.2-3 additive 原则）。
> - 第 9/10/11/13 类的字段形状在规格 §10.1 已锚定（`{text}` / `{termination, usage, compaction_stats}`——`compaction_stats` 为引擎返回值 `compactionStats`（`src/loop.js:624`）经 U2 载荷透传，runner §7.6 同字段；第 11 类规格写作 `{type:"tool_call_delta", ...}`，上表字段为宿主侧补全）。
> - `termination` 是**对象** `{reason, detail?}`，`reason` 取值集合以 erix-agent v0.3.5 `runToolLoop` 返回值契约为准（`src/loop.js:622`）：`end_turn` / `no_tool` / `stall` / `max_rounds_cap` / `reflection_stop` / `judge_done` / `continuation_exhausted` / `aborted` / `failed`。宿主映射：用户主动停止 → `aborted`（`src/loop.js:712`）；引擎失败 → `failed`；正常结束 → `end_turn`（或 `no_tool` / `judge_done` 等）。**若宿主需额外区分「cancelled」这类 UI 语义，那是宿主从 `cancel_requested_at` + `termination.reason` 推导的展示态，不得冒充引擎取值**。
> - **assistant 完整消息不单独发事件**：前端拼接 `assistant_delta` 流渲染气泡；run 结束后的持久对话内容以 `GET /api/sessions/:id` 的 `messages` 为准（`run_events` 是流式日志，`messages` 是人看的对话，两层不混，规格 §9.2）。
> - 审批请求的出现通过 `judge` 事件（`action` 指示需审批）+ `GET /api/approvals` 列表体现，不单独设事件类型。

---

## 6. 错误语义专题

### 6.1 LLM 配额耗尽 → `rate_limited`（429）

链路（规格 §11.4）：LLM 网关 429 → erix 分类 `KitError(rate_limited, retryable)` → 宿主侧**友好提示，且不做会继续烧配额的自动重试**。

契约表现分两处：

| 场景 | 表现 |
|---|---|
| **run 执行中**配额耗尽 | run 失败：`run_end` 事件带 `error: { "code": "rate_limited", "retryable": true }`，run `status → failed`，`GET /api/runs/:id` 的 `error` 同步可查。前端提示「LLM 配额已用尽，请联系管理员充值或明日再试」，**不自动重试** |
| **配额已知耗尽时**调 `POST .../messages` | portal 直接 `429 rate_limited` 拒绝（不创建 run），响应带 `Retry-After`（若网关提供了重置时间） |

portal 自身限流（登录爆破等，§2）也用 `429 rate_limited`，统一 `Retry-After` 语义。

### 6.2 `checkpoint_failed`

规格 §9.3 fail-closed 语义：checkpoint 必须成对（save + load），工具执行前写 checkpoint 失败 → 引擎抛 `checkpoint_failed`，**任务直接失败**（不是 HTTP 错误）。

契约表现：

- run `status → failed`，`run.error = { "code": "checkpoint_failed", "retryable": true, ... }`；`run_end` 事件带同样 `error`。
- **宿主 store adapter 必须把 `checkpoint_failed` 识别为可重试并包 retry**（规格 §9.3-2，erix ≤0.3.5 无内建重试，3 次退避见 runner-integration §9.2）；重试耗尽后透传 → run 终态 `failed`。
- **`checkpoint_failed` 是终态、不自动 re-claim**（A3 定稿，model.md §2.9 / runner-integration R20）：它是引擎在工具执行前/后 checkpoint 写失败时的 fail-closed 判定（**不是**进程崩溃），存储故障持续时 re-claim 只会原地重演，故直接终态 `failed`；终态后不可 resume。
- **恢复口径（前端提示）**：「任务因平台存储故障中止，已持久化的进度（checkpoint/transcript）未丢失，请稍后重新发送」——**重发消息 = 新 run**（`POST /messages` 产生新 run，本期无跨 run resume）；**同 run 的恢复 = re-claim**（仅进程崩溃场景：租约到期后 re-claim 领同一 run，`resume:true`、`attempt > 1`，从最新 checkpoint 续跑，runner-integration §6.4）。
- ~~⚠️ 待决策者确认~~ **已定稿（D2'）**：存储为纯 DB（Postgres），不采纳「本地 file 优先 + DB 异步复制」装饰器；中心 DB 抖动风险由 adapter 重试包装补偿（runner-integration §9.2），抖动超过重试窗口会使在跑任务 `checkpoint_failed` 失败（§6.2 恢复口径）。

### 6.3 容器不可达 → `container_unreachable`（503）

平台通道**全出站**（H-B D-5，issue #5）：portal **不主动连接容器**；容器「在线」以 agentd 心跳为证明（15s 心跳，连续 3 次丢失 ≈45s 判 `exited`，runner §4.2）。容器下线/崩溃/网络不通时：

| 端点 | 表现 |
|---|---|
| `POST /api/sessions/:id/messages` | 拉模型为终态（runner §4）：消息落库即 `202`，不依赖容器在线（容器恢复后自行 claim）；仅 push 下发（⚠️ 待决策者确认）时同步依赖可达，失败返回 `503 container_unreachable`（`retryable: true`）且**不产生** message/run 记录 |
| `POST /api/sessions/:id/stop` | 仍返回 `200`：`cancel_requested_at` 是 DB 标记（规格 §10.3），容器恢复后 runner 轮询到即终止；不因此报错 |
| `POST /api/projects`（写 `ports.json`） | **不依赖容器网络**：portal 直写宿主 bind mount（H-B D-6，issue #7），不受容器在线影响 |
| SSE / GET 类 | 不受影响——事件与状态都在 DB（原理三），容器死了历史照样可看 |

⚠️ 待决策者确认：任务下发单机可先用 push、拉模型（长轮询领 `run_queue`）为终态（规格 §10.3）。本表第一行按**拉模型（终态）**描述——消息落库即 `202`、不依赖容器在线；仅在实现为 push 下发时 `POST .../messages` 才同步依赖容器可达（上表「仅 push 下发」分支）。契约的响应 schema 不变，仅错误出现条件变化。

### 6.4 run 级错误码汇总（`run.error.code` / `run_end.error.code`）

| code | retryable | 含义 | 用户提示口径 |
|---|---|---|---|
| `rate_limited` | 是（人工/延迟后） | LLM 配额耗尽（§6.1） | 配额用尽，勿自动重试 |
| `checkpoint_failed` | 是 | checkpoint 写失败，fail-closed 中止，终态（§6.2） | 存储故障，重发产生新 run |
| `container_exited` | 是 | 容器在 run 进行中退出，且 `attempts >= max_attempts`（耗尽）后由 portal 置终态（否则走租约到期 re-claim，不直接终态，runner §6.4） | 容器异常，平台正在恢复 |
| `max_attempts_exceeded` | 否 | attempts 耗尽（默认 3，schema.sql `run_queue.max_attempts`），U12 release / reaper 置终态（§9.11） | 多次尝试失败，请手动重新提交 |
| `spool_full` | 是 | 事件 spool 写满且内存队列也满，worker 主动失败（runner §7.5） | 事件通道拥塞，可重发继续 |
| `cancelled` | 否 | 用户主动停止（此时 `termination.reason` 为 `"aborted"`，`error` 通常为 `null`，本码仅兜底） | — |
| `internal` | 否 | 未分类引擎/宿主错误 | 联系管理员，附 run_id |

---

## 7. ⚠️ 待决策者确认汇总（本文出现的全部标注）

| # | 事项 | 当前倾向（principles §4） | 影响 |
|---|---|---|---|
| 1 | ~~Q7 portal 技术栈~~ ✅ 已定稿：(a) 零依赖 `node:http` + 原生前端（principles §4；WP1 落地） | — | 仅实现注记，**契约形状无关** |
| 2 | `BASE_DOMAIN`（影响示例 URL 与 cookie 生效 host；当前倾向 `erix.vip`） | env §1 ⚠️ | §0 / §2.5 |
| 3 | P1 认证 = 本地账号 + 强制 TOTP（OIDC 延后 P2） | env §4 / Q3 倾向 (a) | §2.1 |
| 4 | Q5 端口分级：先只做项目级 | 倾向 (b) 起步 | §4.7（`scope`/`run_id` 字段保留） |
| 5 | 任务下发 push→pull 演进 | **拉模型为终态**；push 仅作 P2 优化后置（⚠️ 待决策者确认，不作默认契约） | §6.3（`container_unreachable` 出现条件） |
| 6 | `run.cost` 记账口径 | 依赖 Q1/Q4 | §4.1（P1 可为 `null`） |
| 7 | 预览 ticket TTL 秒数 | **60s** | §2.8 |
| 8 | 预览 cookie TTL（是否滚动续期） | **15min，滚动** | §2.7 / §2.8 |
| 9 | 开发期 cookie 切换方式 | `COOKIE_PROFILE=prod\|dev-http` | §2.5（已落地 env §10） |
| 10 | argon2id 参数 / 口令长度下限 | `m=19MiB,t=2,p=1` / 长度 ≥ 12 | §2.9.4 |
| 11 | 本地 admin 数量上限 | 1~2（或收紧为 1） | §2.9.1 |

---

## 8. 前端 mock 指引（验收锚点）

前端只依据本文开发时：

1. 所有响应按本文 schema 生成 mock；错误分支按 §1.2 / §6 的 `code` 表逐一覆盖（至少：`unauthorized` / `not_found` / `run_in_progress` / `rate_limited` / `container_unreachable` / `checkpoint_failed` 经 run 详情）。
2. SSE mock：按 §5.3 清单逐类型发事件，`id` 递增；模拟断线后带 `Last-Event-ID` 重连，验证补发不漏（P2 验收的前端半边）。
3. `messages.synthetic: true` 的消息必须有独立视觉标记（规格 §9.2 红线）。
4. 预览 URL 一律取 `PortAllocation.url` 字段，禁止拼接域名（规格 §8.1 同源原则）。

---

## 9. 内部端点（internal）：容器 → portal

> **实现状态（WP3a，2026-09）**：本节 U1–U12 + `GET /stream` 已由 `portal/src/internal.js` 实现（纯 DB 逻辑）+ `portal/src/http.js` 路由（Bearer token 鉴权 + `X-Claim-Token` 租约校验），并经 `portal/integration/wp3a-e2e.mjs` 真机实测（claim/状态机/事件 seq/re-claim/并发 claim/SSE 下行/mock 网关注入链）。**U13（run 终态产物上传，issue #64 R1）已随 `portal/src/artifacts.js` 实现**：body = tar.gz 字节流 + `X-Sha-256`，终态后租约已释放故**不校验 X-Claim-Token**（鉴权 = per-container token + run 属主校验），大小上限 `ERIX_ARTIFACT_MAX_BYTES`（默认 20MB），落盘 `ERIX_ARTIFACTS_ROOT/<runId>.tar.gz` + 写 `artifacts` 表（`manifest` jsonb，迁移 0005）。与契约的两处实现口径：① U7 recall 已实现为最小子串扫描（不返回 501）；② 读端点（U6/U7/U9/U11）在 **run 终态后放宽租约校验**（终态仍可读，与 §9.7/§9.8「终态 run 仍可读」一致）——非终态 run 仍严格校验 `X-Claim-Token`。U5 的 fold 更新（同 dedupKey、`folded` false→true）视为合法 UPDATE（runner §9.3）。

> 本节的唯一事实来源是 [`../design/runner-integration.md`](../design/runner-integration.md)（下称「runner §x」）§4（portal ↔ agentd 协议）、§7（事件批量与 seq）、§9（store adapter 契约）、§11（凭据模型）；配套数据表见 [`../data/schema.sql`](../data/schema.sql)（`run_events.client_event_id`、`run_queue` 租约字段、`run_checkpoints` 单行、`transcript_rounds.record`）与[规格](../design/fde-platform.md) §10.3。端点编号 U1–U12 与 runner §4.2 一一对应。

三条要点：

- **经 Traefik 暴露给容器（H-B D-5，issue #5）**：本节端点经 `https://station.<base>/api/internal/*` 可达——容器内把 `station.<base>` 解析到本 FDE 的 bridge 网关 IP（`--add-host`），Traefik(host:443) 以 `ipAllowList`（由 `fde_networks` 精确派生，每 `subnet` 一条 `/29` 或 `/28`，topology.md §5.1）限源后回环到 portal `127.0.0.1:8080`（topology.md §4-L3/§5）。portal 对 `/api/internal` 前缀不做 forwardAuth（鉴权靠 per-container token，审计由端点自身写 `audit_log` 关键动作）。调用方只有 FDE 容器内的 `station-agentd`（runner §4.1）。
- **认证**：每个请求 `Authorization: Bearer <per-container token>`。完整生命周期（schema.sql `containers` / model.md §1.4）：portal 在建容器或轮换时**生成原文**，原文**仅用于注入容器 env `ERIX_STATION_TOKEN`**、**仅 agentd 持有**（fork worker 时从 env 剔除，runner §3）；DB **只存哈希**（`runner_token_hash`）+ 代次（`token_generation`），并记录吊销/轮换时刻（`revoked_at` / `rotated_at`）——portal **永不从 DB 取回原文**。轮换（新代次 `token_generation + 1`）或吊销（`revoked_at` 置位 / `state` 停用）后，旧 token 立即失效（校验时按代次比对哈希，失配 → `401 token_revoked`）。portal 由 token 解出 `container_id` / `user_id`，后续所有 `:id` 资源校验归属该容器——**token 只能操作本 FDE 的资源，越权一律 404/403**（与 §1.2 同口径：不泄露存在性）。
- **背景**：容器**不直连 DB**——所有平台状态写入（事件 / transcript / checkpoint / 用量 / 审批 / 状态收敛）都经本节端点由 portal 落库，Postgres 的业务写方只有 portal（决策者 2026-09，issue #3 评论，D1'/D2'）。本设计取代原「容器写 DB + portal 推容器 :3000」方案（runner §11.2：容器零监听、零入站）。

**与公开端点章节的关系**：§0.1 清单的公开端点面向**浏览器 + session cookie**（§2.5）；本节 internal 端点面向**容器 + per-container token**——两套认证不互通，session cookie 不能调 internal 端点，per-container token 也不能调公开端点。

### 9.1 总览

| 项 | 取值 |
|---|---|
| Base URL | `https://station.<base>/api/internal`（容器内 `--add-host station.<base>:<本 FDE 网关 IP>`，经 Traefik host:443，H-B D-5） |
| 认证头 | `Authorization: Bearer <per-container token>`（每请求） |
| 租约凭证头 | `X-Claim-Token: <claim_token>`——claim 之后的 run 级端点（U2/U3/U5–U12，含读端点 U6/U7/U9）携带；portal 校验「该 run 当前有效租约 = 此 token」，不匹配 → `409 lease_lost`（防 re-claim 后旧 agentd 双写，runner §4.2/§6.4） |
| 长驻连接 | `GET .../stream`（SSE 下行，§9.12）+ 循环 `POST .../claim`（长轮询，§9.3）；其余为短请求 |
| 语义基调 | **at-least-once + 幂等**：所有写端点携带客户端幂等键，portal 端 DB 唯一约束兜底；agentd 对所有 5xx/网络错误无限指数退避重试（§9.13） |

### 9.2 端点清单

| # | 方法 + 路径 | 用途 | 幂等 |
|---|---|---|---|
| U1 | `POST /api/internal/claim` | 领任务（长轮询，§9.3） | lease + `claim_token` |
| U2 | `PUT /api/internal/runs/:id/state` | run 状态收敛（markRunState + 终态，§9.6） | 终态不可变，重复提交返回首次结果 |
| U3 | `POST /api/internal/runs/:id/events` | 事件批量上报（§9.4） | `client_event_id` 唯一 |
| U4 | `POST /api/internal/heartbeat` | 心跳 + 租约续期 + stop 兜底轮询（§9.5） | 天然幂等（覆盖写） |
| U5 | `PUT /api/internal/runs/:id/transcript/rounds/:round` | store：`appendRound`（§9.7） | `UNIQUE(run_id, round)` + `dedupKey` |
| U6 | `GET /api/internal/runs/:id/transcript` | store：`load`（§9.7） | 只读 |
| U7 | `GET /api/internal/runs/:id/transcript/recall` | store：`recall`（§9.7；P1 可 501） | 只读 |
| U8 | `PUT /api/internal/runs/:id/checkpoint` | store：`saveCheckpoint` / `appendCheckpoint`（§9.8） | 单行覆盖写 + revision CAS |
| U9 | `GET /api/internal/runs/:id/checkpoint/latest` | store：`loadLatestCheckpoint`（§9.8） | 只读 |
| — | `PUT /api/internal/runs/:id/runstate` | store：`saveRunState` / markRunState 终态标记（§9.8a，0.9.0 八方法契约，issue #43） | `runs.run_state` jsonb 合并写 |
| — | `GET /api/internal/runs/:id/runstate` | store：`loadRunState`（§9.8a） | 只读；无 → 204 |
| U10 | `POST /api/internal/runs/:id/approvals` | 创建审批单（§9.10） | 一个工具调用至多一单 |
| U11 | `GET /api/internal/approvals/:id` | 审批决定轮询兜底（§9.10） | 只读 |
| U12 | `POST /api/internal/runs/:id/release` | 主动放弃已领任务（§9.11） | 重复 release 返回首次结果 |
| U13 | `PUT /api/internal/runs/:id/artifact` | **run 终态产物 bundle 上传**（issue #64 R1，runner §6.6） | `UNIQUE(run_id, kind)`；重复上传 409 `artifact_exists`（不覆盖） |
| — | `GET /api/internal/stream` | SSE 下行通道（§9.12） | — |

> usage **不单设端点**：随 U2 终态载荷上报（§9.9）。

### 9.3 `POST /api/internal/claim`（U1：领任务，长轮询）

请求：

```json
{ "capacity": 2, "hold_ms": 30000 }
```

| 字段 | 类型/边界 | 说明 |
|---|---|---|
| `capacity` | integer，`1 ≤ capacity ≤ 64`，可省略（默认 1） | agentd 当前可再接收的 run 数（单容器并发上限默认 4 ⚠️，runner §13）。**咨询性**：portal 仅据此做防超发记账，**不因 `capacity` 改变响应条数**；越界 → `400 validation_failed` |
| `hold_ms` | integer，`1 ≤ hold_ms ≤ 30000`，必填 | 长轮询挂起时长（**上限 30s ⚠️**，runner §4.2）；越界/非整数 → `400 validation_failed` |

**响应形状（union，写死）**：本端点仅两种结果，`capacity` 不改变形状——

- `200`：领到 **一条** 任务（单 ticket 对象，扁平结构如下）。**每次至多派发 1 条**；「一次派发多条」的数组形式（`{ "tickets": [...] }`）是 P2 兼容扩展，本期不启用。
- `204`：hold 超时仍无任务（无响应体）；agentd 立即发起下一次 claim。

响应 `200`（领到任务，返回 ticket）：

```json
{
  "queue_id": "q_91",
  "claim_token": "ct_3f8a...",
  "lease_expires_at": "2026-09-12T09:01:31.000Z",
  "run": {
    "id": "9d3b2f1e-7c4a-4e2b-9f0a-1c2d3e4f5a6b",
    "session_id": "s_3kd9",
    "attempt": 1,
    "project": { "name": "proj1", "root_path": "~/projects/proj1" },
    "task": "把登录按钮改成品牌色",
    "message_id": "m_552",
    "model": "claude-sonnet",
    "resume": false,
    "attachments": []
  }
}
```

| 字段 | 说明 |
|---|---|
| `claim_token` | 本次认领的凭证；后续该 run 的写/读端点经 `X-Claim-Token` 头携带（§9.1）。re-claim 后旧 token 失效 |
| `lease_expires_at` | 租约到期时刻（lease 90s ⚠️）；对应 `run_queue.lease_until` 列（schema.sql） |
| `run.attempt` | **本次 claim 后的 `run_queue.attempts`**（1-based）。worker 用它生成 `client_event_id` 的 attempt 前缀（§9.4）与审计；`resume = attempt > 1`（runner §4.2/§16.2-R16） |
| `run.task` | 本轮用户输入，worker 必须显式传给引擎（runner §6.3） |
| `run.resume` | `true` = re-claim 场景（`attempt > 1`），引擎从 checkpoint 恢复（runner §6.3-5） |

派单与挂起语义（runner §4.2）：

- 有可领行：`SELECT ... FOR UPDATE SKIP LOCKED` → `status='claimed'`、`claimed_at=now`、`lease_until=now+90s`、`attempts++`、写 `owner_container_id`/`claim_token`，发 ticket。
- 无可领行：挂起连接（**不持有事务/锁**）；portal 在 `POST /messages` 入队后 `NOTIFY run_queue`（或单节点进程内事件）唤醒挂起的 claim 再查一次；到 `hold_ms` 仍无 → `204`。
- SSE `run_assigned` 只是**唤醒 hint**，不携带权威载荷——hint 到达时任务可能已被其他 capacity 领走，载荷以 claim 响应为准（§9.12）。

**领取资格（归属过滤，user_id 路由，issue #8）**：portal 按「认领容器的 `user_id`（由 token 解出）== run 归属 `user_id`（run → session → user 推导）」判定领取资格，**不以 `run_queue.container_id`（容器实例）过滤**——容器重建后新容器（同 user）天然可领取入队时派给旧容器的队列行；`container_id` 仅作入队目标快照、`owner_container_id` 记当前持有者（schema.sql §8 / model.md §1.16）。**终态 run（`finished`/`failed`；`cancelling` 中间态亦不可领，schema.sql §4）永不进入认领结果**。

**重领条件（re-claim）**：满足下面**全部**条件的队列行才可被认领（含首次）：① `status='pending'`，或 `status='claimed' AND lease_until < now()`（租约到期）；② `attempts < max_attempts`（未达崩溃循环上限）；③ `run → session → user == 认领 user_id`。`attempts >= max_attempts` 的过期 claimed 行由 reaper 直接终态（§9.11/§6.4），不再进入 claim。

> ⚠️ 命名对齐：API 载荷字段名 `lease_expires_at` 与 schema 列 `run_queue.lease_until` **一一对应**（同一时刻）；runner §4.2 已统一以 schema 列名 `lease_until` 描述 DB 写，仅 API 载荷保留 `lease_expires_at`（列名差异见 runner §16.2-R5，✅ 已落地）。

错误：`400 validation_failed`（`capacity`/`hold_ms` 越界）；`401 token_invalid / token_revoked`；`429 rate_limited`；5xx 无限退避重试（§9.13）。

### 9.4 `POST /api/internal/runs/:id/events`（U3：事件批量上报）

请求：

```json
{
  "batch_id": "b_20260912-0007",
  "events": [
    {
      "client_event_id": "9d3b2f1e-...:1:42",
      "type": "assistant_delta",
      "ts": "2026-09-12T09:00:02.130Z",
      "payload": { "text": "好的" }
    },
    {
      "client_event_id": "9d3b2f1e-...:1:43",
      "type": "tool_use",
      "ts": "2026-09-12T09:00:02.410Z",
      "payload": { "tool_call_id": "tc_301", "name": "bash", "input": { "command": "pnpm test" } }
    }
  ]
}
```

| 字段 | 类型/边界 | 说明 |
|---|---|---|
| `batch_id` | string，≤ 128 字符，可省略 | 批次标识（agentd 生成，供日志/排障关联）；**幂等键是逐事件的 `client_event_id`，不是 `batch_id`** |
| `events` | array，`0 ≤ length ≤ 200` | 事件数组；**空数组合法**（portal 按 no-op 处理，见下）。单批总字节上限 **256KB** ⚠️（runner §7.2）；条数或字节超限 → `400 validation_failed`，agentd 切多批顺序重发 |
| `events[].client_event_id` | string，格式 `run_id + ":" + attempt + ":" + 计数` | 客户端幂等键（worker 生成，**带 attempt 前缀**，runner §7.3）；`attempt` = claim ticket 的 `run.attempt`（§9.3），`计数` = 该 attempt 内从 0 单调递增。portal 端 `INSERT ... ON CONFLICT (run_id, client_event_id) DO NOTHING` |
| `events[].type` | string | 事件类型，清单同 §5.3（portal 原样透传落 `run_events`）；未知类型（上游 additive）原样透传、不报错 |
| `events[].ts` | string（ISO 8601 UTC） | **宿主落库时间**（与 §5.3 信封、schema `DEFAULT now()` 同口径；worker 上报的产生时刻仅作展示参考，不参与 seq 排序/对账，env §11.3） |
| `events[].payload` | **object（必为 JSON 对象）** | 类型特有字段（对应 §5.3 信封内层）。portal 不校验内部字段语义，但要求 `payload` 为对象——非对象 → `400 validation_failed`。**payload union**：已知类型按 §5.3 字段形状填充，未知类型原样透传 |

**`client_event_id` 重启/重领不碰撞（attempt 前缀）**：`client_event_id` 中的 `attempt` 来自 claim ticket（`run_queue.attempts`）；re-claim 后 `attempt++`，新 worker 的 `计数` 归零也不会与旧 attempt 的 `run_id:attempt:计数` 碰撞——否则旧 attempt 的 `:0`/`:1` 会被新 attempt 当重复丢弃（runner §7.3）。**worker 在未发生 re-claim 的同 attempt 内重启**（如进程被 agentd 重拉但 claim 未变）必须沿用原 `attempt` 并继续计数，否则会产生撞键。

批量参数（runner §7.2）：**250ms 或 2KB 先到者触发** ⚠️；单批上限 200 条 / 256KB，超出切多批顺序发送；单 run 内严格按 `client_event_id` 递增，批量不重排。

响应 `200`：

```json
{ "stored": 98, "seq_first": 1001, "seq_last": 1098 }
```

| 字段 | 说明 |
|---|---|
| `stored` | **实际插入**条数。批次中已存在（重复）的 `client_event_id` 被跳过、不计入——**部分重复时响应仍为 `200`，`stored` 小于请求条数属正常幂等命中，不是错误**；agentd 收到 `200` 即确认整批、从缓冲删除 |
| `seq_first` / `seq_last` | 本批**新插入**事件分配到的 seq 区间（`seq_first ≤ seq_last`）。**当 `stored == 0`（空批次 或 全重复批次）时两者均为 `null`**——这是「没有新事件落库」的明确信号，agentd 不应据此推进任何游标（本来也没有新 seq）。seq 由 portal 在**同一事务**内 `chat_sessions.last_seq` 逐条 +1 分配（`UNIQUE(session_id, seq)` 兜底）；**seq 只在 portal 产生，worker/agentd 永不自造** |

幂等与重试（runner §7.3）：**at-least-once**——agentd 只有收到 `200` 才确认删除；任何失败重试**整批**，重复批次安全。

错误：`400 validation_failed`（条数/字节超限、`payload` 非对象、`client_event_id` 格式非法）；`401 token_invalid / token_revoked`；`403 run_ownership_mismatch`；`404 run_not_found`；`409 lease_lost`；`409 run_terminal`（终态 run 不再接受事件——终态 barrier，runner §7.6）；`429 rate_limited`；5xx 无限退避重试（§9.13）。

### 9.5 `POST /api/internal/heartbeat`（U4：心跳 + 租约续期）

请求（间隔 **15s** ⚠️）：

```json
{
  "agent_version": "0.1.0",
  "runs": [
    { "run_id": "9d3b2f1e-...", "status": "running", "worker_pid": 1234, "claim_token": "ct_3f8a..." }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `agent_version` | agentd 版本号字符串（供审计/排障） |
| `runs[].run_id` | 当前活跃 run 的 id |
| `runs[].status` | `running`（agentd 只上报在跑的 run；终态 run 在 U2 后即从列表移除）。其余值保留、portal 忽略 |
| `runs[].worker_pid` | 该 run 的 worker 进程 pid（观测用） |
| `runs[].claim_token` | **逐 run 携带**：本次认领的 `claim_token`（§9.3）。portal 对每个 run 校验「当前有效租约的 claim_token == 请求携带值」后决定是否续租（runner §4.2） |

响应 `200`（**部分失败**：单个 run 的租约丢失不使整次心跳失败）：

```json
{
  "now": "2026-09-12T09:00:15.000Z",
  "stop_run_ids": ["9d3b2f1e-..."],
  "revoked": false,
  "runs": [
    { "run_id": "9d3b2f1e-...", "lease": "renewed", "lease_until": "2026-09-12T09:01:45.000Z" },
    { "run_id": "a1b2c3d4-...", "lease": "lease_lost", "reason": "reclaimed" }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `now` | 服务端时间（供 agentd 校时） |
| `stop_run_ids` | portal 侧 `cancel_requested_at` 已置位但 SSE `stop_request` 可能未达的 run——**停止指令的兜底通道**（SSE 为主、心跳为备）；agentd 对列出的 run 执行 abort |
| `revoked` | 保留字段，**当前恒为 `false`**：吊销不走 200——`authenticateContainer` 对 `revoked_at` 非空的行在鉴权阶段直接 `401 token_revoked`（审计 #34 F-C；agentd 的 200 分支仅作同径兜底） |
| `runs[]` | **逐 run 续租结果**。未出现在请求 `runs[]` 里的 run 不产生结果行 |
| `runs[].lease` | `renewed`（claim_token 匹配，已续租 `lease_until = now + 90s` ⚠️）或 `lease_lost`（claim_token 不匹配——该 run 已被 re-claim / 租约易主） |
| `runs[].lease_until` | 仅 `lease: renewed` 时返回（续租后的到期时刻） |
| `runs[].reason` | 仅 `lease: lease_lost` 时返回：`reclaimed`（已 re-claim）/ `released`（已被 U12 释放）/ `terminal`（已终态） |

语义（与 runner §4.2 U4 一致）：

- **续租**：portal 对每个 run 校验 `claim_token` 匹配当前有效租约 → 续租（`lease_until = now + 90s` ⚠️）；不匹配 → `lease: lease_lost`。
- **`lease_lost` vs `revoked`**：`lease_lost` 是 **run 级**（单个 run 的租约被取代）→ agentd **本地 abort 该 run 的 worker、丢弃其缓冲与 spool**，不再续传该 run 的任何写；`revoked` 是 **容器级**（token 吊销 / offboard）→ agentd 停领新任务、drain（abort 全部在跑 run → 等 worker 退出 → 清理 worktree）后退出。`revoked` **不在 `200` 内表达**：吊销由鉴权阶段 `401 token_revoked` 给出（SSE revoke / claim 401 / heartbeat 401 三径同源，issue #22）；`401/5xx` 对非吊销原因才是整次心跳失败（指数退避重试）。
- **停止兑底**：`stop_run_ids` 是 portal 侧 `cancel_requested_at` 已置位但 SSE `stop_request` 可能未达的 run 的兑底通道（SSE 为主、心跳为备）。

幂等：天然幂等（覆盖写 `last_heartbeat`、续 lease）。portal 侧判定：**连续 3 次心跳丢失（45s ⚠️）判容器死**；run 级处置走租约到期 re-claim（runner §6.4）。

错误：`400 validation_failed`（`runs[].claim_token` 缺失/格式非法）；`401 token_invalid / token_revoked`；`429 rate_limited`；5xx 无限退避重试（§9.13）。

### 9.6 `PUT /api/internal/runs/:id/state`（U2：run 状态收敛）

同一端点覆盖 store `markRunState`（非终态）与 run 终态收敛（runner §4.2 / §9.1）。**所有转换都要求 `X-Claim-Token` 匹配当前有效租约**（不匹配 → `409 lease_lost`）；转换用**条件更新（CAS）**实现——`UPDATE runs SET ... WHERE id=$1 AND status = <期望当前状态>`，0 行受影响即按非法转换处理。

**合法状态转换表（U2 可执行的转换）**：

| 当前 `runs.status` | 目标状态 | 载荷要求 | 结果 |
|---|---|---|---|
| `queued` | `running` | `{state: "running"}` | `200`（写 `started_at`，若尚未写） |
| `running` | `running` | `{state: "running"}` | `200`（幂等重放，无变化） |
| `running` | `finished` | 终态载荷（见下） | `200`（终态事务） |
| `running` | `failed` | 终态载荷（见下） | `200`（终态事务） |
| `cancelling` | `finished` | 终态载荷（`termination.reason` 通常为 `aborted`） | `200`（终态事务） |
| `cancelling` | `failed` | 终态载荷 | `200`（终态事务） |

**非法转换 → `409 invalid_transition`**（details 附 `{from, to}`）：`running/queued → queued`（回退）；`queued → finished/failed`（跳过 running，须走 U12 release + re-claim）；`cancelling → running`（停止后不得回 running）。**终态 run 的任何写（非终态/终态）统一走 `409 run_terminal`，不归 `invalid_transition`**（见下「重复终态」）。

**非终态（markRunState）**——请求：

```json
{ "state": "running" }
```

响应 `200`。幂等：重复 `{state:"running"}` 在 `queued`/`running` 下均为 `200`（覆盖写/无变化）。

**终态收敛**——请求：

```json
{
  "state": "finished",
  "termination": { "reason": "end_turn" },
  "usage": { "input_tokens": 15230, "output_tokens": 2104 },
  "rounds": 3,
  "final_text": "已完成：登录按钮已改为品牌色……",
  "compaction_stats": [ { "compacted": true, "foldedRounds": 2, "tokensBefore": 41200, "tokensAfter": 9800 } ],
  "error": null
}
```

| 字段 | 说明 |
|---|---|
| `state` | `finished` \| `failed`（终态值） |
| `termination` | 引擎 `runToolLoop` 返回值透传，对象 `{reason, detail?}`，`reason` 取值集合见 §4.1 |
| `usage` | 整 run 用量汇总；portal 同事务写 `runs.usage` + `usage_ledger`（`source='erix'`，一 run 一条，`UNIQUE(run_id, source)`）——见 §9.9 |
| `rounds` / `final_text` | 轮数与 assistant 最终文本；portal 同事务回写 `messages` assistant 行 |
| `compaction_stats` | 引擎返回值 `compactionStats`（erix-agent v0.3.5 `src/loop.js:624`）**原样透传**（数组，元素 `{compacted, foldedRounds, tokensBefore, tokensAfter}`；snake_case 为宿主约定）；portal 写入 `run_end` 事件（§5.3 第 13 类） |
| `error` | 失败时 `{code, message, retryable}`（run 级错误码见 §6.4）；成功为 `null` |

响应 `200`（portal 终态事务：runs 置终态 + `run_queue → done/cancelled` + messages 回写 + usage_ledger，runner §6.1）。

**重复终态语义（同载荷 vs 不同载荷）**：portal 以 `(termination, usage, rounds, final_text, compaction_stats, error)` 的**规范化 JSON 哈希**判定是否同载荷。

| 情形 | 响应 | 语义 |
|---|---|---|
| 首次终态（`running`/`cancelling` → 终态） | `200` | 落库、不可再变 |
| 重复提交，**同载荷** | `200`（返回首次存储结果，可带 `"idempotent": true`） | 幂等命中，无变化 |
| 重复提交，**不同载荷** | `409 run_terminal`（details 附首次存储结果） | 终态不可变，新载荷**被拒、不落库** |
| 非终态写（`{state:"running"}`）落在终态 run | `409 run_terminal` | 终态不可回退 |

> **顺序约束（runner §7.4/§7.6）**：终态收敛**必须在该 run 全部事件批被 `200` 确认后才发送**；portal 在终态事务内**合成** `run_end` 事件（worker 不再经 U3 发 `run_end`，runner §7.6），payload 带 `attempt`。终态 barrier：此后 U3/U5/U8/U10 及 state 写一律 `409 run_terminal`（读端点 U6/U7/U9/U11 不受限；runner-integration §7.6 同口径）。

错误：`400 validation_failed`（终态载荷缺 `termination`/`usage`/`rounds` 等）；`401 token_invalid / token_revoked`；`403 run_ownership_mismatch`；`404 run_not_found`；`409 lease_lost`；`409 invalid_transition`（非法状态转换）；`409 run_terminal`（终态 run 的写/不同载荷重复终态）；`429 rate_limited`；5xx 无限退避重试（§9.13）。

### 9.7 transcript rounds（U5/U6/U7）

store adapter 契约（runner §9.1）的落库端点；`transcript_rounds.record` 存上游 RoundRecord 全量原样，`messages` / `folded` / `folded_payload` 为派生/加速列（schema.sql）。U5 写要求 `X-Claim-Token` 有效 + run 非终态；U6/U7 读要求 `X-Claim-Token` 有效（终态 run 仍可读，见下）。

#### `PUT /api/internal/runs/:id/transcript/rounds/:round`（U5：appendRound）

请求体为 RoundRecord（完整 JSON schema；`record` 列原样全量存储，上游 additive 新字段透传不丢）：

```json
{
  "dedupKey": "9d3b2f1e-...:r3",
  "folded": false,
  "messages": [
    { "role": "user", "content": "把登录按钮改成品牌色" },
    { "role": "assistant", "content": "好的……" }
  ],
  "foldedPayload": null
}
```

| 字段 | 类型/边界 | 说明 |
|---|---|---|
| `dedupKey` | string，必填，非空，≤ 256 字符 | 本轮唯一键（上游 recordKey）；与 `(run_id, round)` 双保险的幂等键 |
| `folded` | boolean，默认 `false` | fold 只影响视图，档案完整（runner §9.3） |
| `messages` | array（可空），元素 `{role, content, ...}` | 该轮 canonical 消息数组；`role` ∈ `user`/`assistant`（judge 注入为 user role 合成消息） |
| `foldedPayload` | object \| `null` | `folded: true` 时必填；fold 后的展示载荷 |

**大小限制**：单轮请求体 ≤ **1MB** ⚠️，越界 → `400 validation_failed`。

响应 `200`：

```json
{ "inserted": true }
```

**幂等与冲突（body hash）**：portal 落库用 `UNIQUE(run_id, round)` + `dedupKey` 双保险；命中 `(run_id, round)` 冲突时，portal 计算**入参与已存 `record` 的规范化 JSON 哈希**并比较：

| 情形 | 响应 |
|---|---|
| 新 round（无冲突） | `200 {inserted: true}` |
| 同 round + 同 `dedupKey` + **同 body（哈希相等）** | `200 {inserted: false}`（幂等命中，对齐上游 dedupKey 语义） |
| 同 round + 同 `dedupKey` + **不同 body** | `409 round_conflict`（details 附已存 round 摘要；新 body 被拒） |
| 同 round + **不同 `dedupKey`** | `409 round_conflict`（该 round 已存在，无论 body 是否相同） |

fold 语义（runner §9.3）：`folded` 行与原始行共享 `(run_id, round)` 键空间——fold 后原轮走 `UPDATE`（`folded=true` + `folded_payload`），**不插新行**，档案完整不删。fold 更新同样按上述冲突规则（同 round 同 body → 幂等，不同 body → `409 round_conflict`）。

#### `GET /api/internal/runs/:id/transcript`（U6：load）

query（均可选）：`?limit=<1..10000，默认 10000 ⚠️>`、`?cursor=<round>`（返回 `round > cursor` 的记录）。

响应 `200`：

```json
{ "records": [ { "round": 0, "dedupKey": "...", "folded": false, "messages": [ ... ], "foldedPayload": null, "...": "record 列全量原样" } ], "next_cursor": 99 }
```

| 字段 | 说明 |
|---|---|
| `records` | 按 `round` **升序**，`record` 列原样返回（每项含 `round`） |
| `next_cursor` | 本页最后一条的 `round`；无更多记录时为 `null` |

**分页/大小约束**：`limit` 限定单响应对数（默认 10000 ⚠️）；上游 `load(runId)` 语义 = 不带 query 拉全量（run 的 round 数超出 10000 时由 adapter 用 `cursor` 循环拉取）；portal 对单响应序列化体设 **8MB** ⚠️ 上限，单条 record 超限 → `400 response_too_large`（details 附 `round`）。

**404/终态/lease 语义**：run 不存在 → `404 run_not_found`；不属本容器 → `403 run_ownership_mismatch`；`X-Claim-Token` 失配 → `409 lease_lost`；**终态 run 仍可读**（transcript 是 resume/审计源，不可变但不拒绝读）→ `200`。

#### `GET /api/internal/runs/:id/transcript/recall`（U7：recall）

query：`from_round`（含，默认 0）/ `to_round`（含，默认最大）/ `pattern`（必填）。

| 字段 | 语义 |
|---|---|
| `pattern` | string，必填，非空，≤ 256 字符。**子串匹配**（大小写敏感），作用域 = 搜索范围内每轮的 `messages[*].content` 与 `folded_payload` 文本（折叠原文同属档案，runner §9.1） |
| `from_round` / `to_round` | 搜索范围 `[from_round, to_round]`（含两端），默认全范围；`from_round > to_round` → `400 validation_failed` |

响应 `200`：

```json
{ "text": "……命中的档案原文（含 folded_payload，折叠原文同属档案）……", "truncated": false, "matched_rounds": 3 }
```

| 字段 | 说明 |
|---|---|
| `text` | 命中轮次的原文拼接（按 round 升序） |
| `truncated` | `true` = 因上限/超时截断（未穷尽匹配） |
| `matched_rounds` | 命中的轮次数 |

**上限与超时**：扫描上限 **2000 轮** / 结果文本上限 **1MB** / 扫描超时 **200ms** ⚠️（先到者触发）→ 返回已命中部分并置 `truncated: true`。只读；lease/404/终态语义同 U6。

> ⚠️ **P1 可暂未实现本端点**：此时返回 `501`，错误码 `not_implemented`（`retryable: false`）。**worker 降级行为**：adapter 把 `501 not_implemented` 映射为 recall 工具「不可用」，引擎本轮**不带 recall 能力继续**（judge 可能记 `degraded`，§5.3 类型 12）——**不因 recall 缺失中断 run**；契约形状保留，后续分期补齐。

### 9.8 checkpoint（U8/U9）

#### `PUT /api/internal/runs/:id/checkpoint`（U8：saveCheckpoint / appendCheckpoint）

请求：

```json
{
  "revision": 7,
  "snapshot": { "round": 3, "executedToolIds": [ "..." ], "...": "上游 checkpoint 快照原样" }
}
```

| 字段 | 说明 |
|---|---|
| `revision` | **每 run 单调版本号**（worker 每 run 从 0 递增），CAS 依据（runner §9.5） |
| `snapshot` | 上游 checkpoint 快照，原样落 `run_checkpoints.snapshot` |

> **`seq` 已作废为本地元数据**：`seq` 仅为 worker 本地计数（其值在实现上可等于 `revision`），**不进请求、不落库**（`run_checkpoints` 无 `seq` 列）；权威单调性由 DB 的 `revision` 列保证（runner §9.5）。

响应 `200`（写入成功，或同一 `revision` 的幂等重放）。

**幂等与 revision CAS**（对齐 runner §9.5，与 schema.sql `run_checkpoints` 一致）：

```sql
INSERT INTO run_checkpoints (run_id, snapshot, revision, updated_at)
VALUES ($1, $2, $3, now())
ON CONFLICT (run_id) DO UPDATE
  SET snapshot = EXCLUDED.snapshot, revision = EXCLUDED.revision, updated_at = now()
  WHERE run_checkpoints.revision < EXCLUDED.revision;
```

| 情形 | 响应 | 语义 |
|---|---|---|
| 无现存行（首次） | `200` | 插入 |
| `revision > 现存 revision` | `200` | 覆盖写（前进） |
| `revision <= 现存 revision`（旧/乱序/同值重试） | `409 checkpoint_stale` | CAS 拒绝；worker 侧视为「本快照已过期」，**不重试**（继续以最新为准）。**同 `revision` 重试语义等价于幂等命中**——agentd 对 `checkpoint_stale` 不重试（runner §9.5 / §4.5） |

**resume 续计**：re-claim 后新 worker 先经 U9 读回当前 `revision`，本地计数从 `revision+1` 续起（§6.3-5 / runner §9.5）；无 checkpoint（U9 `204`）→ 从 0 起计。`revision` 是**跨 attempt 连续单调版本**，不因 attempt 重置而回落。

**重试要求**（runner §9.2，fail-closed 语义下的补偿，adapter 必须包 retry）：

| 项 | 策略（⚠️ 参数待确认） |
|---|---|
| 重试次数 | 3 次（不含首次） |
| 退避 | 1s → 2s → 5s（指数，±20% 抖动） |
| 可重试错误 | 网络错误、5xx、429 |
| 不可重试 | 4xx → 直接抛（`checkpoint_stale` 除外：视为已过期、不重试） |
| 耗尽 | 错误透传引擎 → `checkpoint_failed` → run 终态 `failed`（用户口径见 §6.2：重发产生新 run，不自动 re-claim） |

错误：`400 validation_failed`（缺 `revision`/`snapshot` 或 `revision` 非非负整数）；`401 token_invalid / token_revoked`；`403 run_ownership_mismatch`；`404 run_not_found`；`409 lease_lost`；`409 run_terminal`（终态 run 不再接受 checkpoint——终态 barrier）；`409 checkpoint_stale`；`429 rate_limited`；5xx 无限退避重试（§9.13）。

#### `GET /api/internal/runs/:id/checkpoint/latest`（U9：loadLatestCheckpoint）

响应 `200`：

```json
{ "checkpoint": { "snapshot": { "...": "..." }, "revision": 7, "updated_at": "2026-09-12T09:00:10.000Z" } }
```

无 checkpoint → `204`（adapter 返回 `undefined`；revision 供 resume 从 0 续计，runner §9.5）。只读。

**404/无权限/lease/终态语义**：run 不存在 → `404 run_not_found`；不属本容器 → `403 run_ownership_mismatch`；`X-Claim-Token` 失配 → `409 lease_lost`；**终态 run 仍可读**（checkpoint 不可变、作为审计/resume 记录可查）→ `200`（有则返回）/`204`（无则空）。

错误：`401 token_invalid / token_revoked`；`403 run_ownership_mismatch`；`404 run_not_found`；`409 lease_lost`；`429 rate_limited`；5xx 无限退避重试（§9.13）。

### 9.8a runstate（saveRunState / loadRunState，0.9.0 八方法契约，issue #43）

0.6.0 起引擎 `TranscriptStore` 契约要求 8 方法（run 前 fail-closed 校验，缺即 TypeError，host-upgrade-guide §2）；`saveRunState`/`loadRunState` 持久化/恢复引擎确定性 run state（resume 依赖），落 `runs.run_state jsonb`（schema.sql；不变式 3「DB 是状态真相」）。

#### `PUT /api/internal/runs/:id/runstate`（saveRunState / markRunState 终态标记）

请求两种形态（合并写语义，`run_state = COALESCE(run_state,'{}') || patch`，并并入 `runId`）：

```json
{ "run_state": { "stateVersion": 3, "deterministic": { "rounds": 2 }, "semantic": { "text": "…", "version": 1 } } }
{ "state": "succeeded" }
```

- `{run_state}`：引擎 saveRunState 全量合并（deterministic + semantic）。
- `{state}`：**引擎终态标记**（succeeded / unverified_error / guard_error / failed / aborted，0.9.0 `termination.js finish()`）——只合并 `state` 字段，**不触碰 `runs.status`**（宿主终态唯一权威仍是 §9.6 U2，runner §6.3-9）。

响应 `200 {ok:true}`。错误：`400 validation_failed`（run_state 非对象 / 两种形态都缺）；`401/403/404` 同 U8；`409 lease_lost`；`409 run_terminal`（终态 barrier，写不再接受）；`429`；5xx 退避重试（§9.13）。

#### `GET /api/internal/runs/:id/runstate`（loadRunState）

响应 `200 { "run_state": { ... } }`；从未写入 → `204`（adapter 返回 `undefined`，resume 按「无状态」正常继续）。**终态 run 仍可读**（读语义同 U9）。错误：`401/403/404`；非终态时 `409 lease_lost`；`429`；5xx 退避重试（§9.13）。

### 9.9 usage 上报

**不单设端点**（runner §4.2）：run 用量随 §9.6 终态载荷（`usage`）上报，portal 同事务写 `runs.usage` + `usage_ledger`（`source='erix'`，一 run 一条，`UNIQUE(run_id, source)`，model.md §1.14）。网关侧用量由 portal 定期从 LLM 网关拉取落 `usage_ledger`（`source='gateway'`，规格 §11.4），不经过容器。

### 9.10 审批（U10/U11）

#### `POST /api/internal/runs/:id/approvals`（U10：创建审批单）

请求：

```json
{
  "tool_call_id": "tc_301",
  "round": 4,
  "name": "bash",
  "input_digest": "rm -rf node_modules && pnpm install"
}
```

响应 `201`：

```json
{ "approval_id": "ap_77" }
```

**`tool_calls` 行由谁何时创建（issue #10）**：`tool_calls` 行**不由 U10 创建**，而是由 portal 在 **U3 事件上报**时对 `type:"tool_use"` 事件**幂等 upsert**——`INSERT ... ON CONFLICT (run_id, call_id) DO NOTHING`（后续 `tool_result`/`tool_call_delta` 按 `call_id` 更新 `result_digest`/`duration_ms`/`judged` 等派生字段）。因此 U10 建审批单时 `tool_calls` 行必然已存在，`approvals` 的复合外键 `(run_id, tool_call_id) REFERENCES tool_calls (run_id, call_id)` 得以满足。

幂等：**一个工具调用至多一单**（`approvals` `UNIQUE(run_id, tool_call_id)`，schema.sql）；同 `tool_call_id` 重复创建 → portal 返回原单 `200 { "approval_id": "ap_77" }`（agentd 重启 re-claim + resume 后再次执行到同一工具的场景，runner §10.2）。

`tool_call_id` 为**外部 `call_id`**（事件流 `tool_use`/`tool_result` 的 `tool_call_id`，字符串如 `tc_301`），**不是** `tool_calls.id` 内部主键（uuid、不外露）；canonical 规则见 model.md §1.19。⚠️ 若 #10 改判 `tool_call_id` 为 UUID，则以 #10 为准并同步 `approvals` / `tool_outputs` / `tool_calls`（schema.sql / model.md §1.19）。

错误：`400 validation_failed`（缺 `tool_call_id`/`name` 或 `tool_call_id` 无对应 `tool_calls` 行）；`401 token_invalid / token_revoked`；`403 run_ownership_mismatch`；`404 run_not_found`；`409 lease_lost`；`409 run_terminal`（终态 run 不再接受审批单）；`429 rate_limited`；5xx 无限退避重试（§9.13）。

#### `GET /api/internal/approvals/:id`（U11：结果轮询兜底）

响应 `200`：

```json
{
  "status": "approved",
  "decided_by": "u_alice",
  "decided_at": "2026-09-12T09:06:00.000Z",
  "note": "可选备注"
}
```

```json
{
  "status": "expired",
  "expired_at": "2026-09-12T09:15:00.000Z"
}
```

| 字段 | 说明 |
|---|---|
| `status` | `pending` \| `approved` \| `denied` \| `expired`。`pending`/`expired` 时 `decided_by`/`decided_at`/`note` 缺省；`expired` 时附 `expired_at` |
| `decided_by` / `decided_at` / `note` | 仅 `approved`/`denied` 时返回 |
| `expired_at` | 仅 `expired` 时返回（portal 打 `expired` 的时刻） |

取决定与挂起语义（runner §10.1/§10.2）：

- **双通道**：SSE `approval_decision` 为主（实时，§9.12）；worker 挂起期间 agentd 每 **5s** ⚠️ 轮询本端点兜底（SSE 断线时审批不卡死）。先到者生效。
- **超时语义（issue #10，已按 topology.md §4-L6 结论写死）**：挂起 **10 分钟** ⚠️ 无决定 → **portal 的审批 reaper 把 `pending → expired`**（写 `expired_at`，修 #10 的「审批单停在 pending 导致审计失真」）；worker 侧同步本地超时按 **denied** 继续。两端收敛：worker 不等 portal 打标（本地 10min 先到者按 denied 处理），portal 的 `expired` 是**权威审计态**（「超时未决」）。
- **迟到决定处理（`expired` 后的决定）**：FDE 在审批单已 `expired` 后再点决定（公开 `POST /api/approvals/:id`，§4.8）→ **`409 approval_expired`**（决定**不被接受、不改状态**），portal 写审计（`approval.decision_late`）；U11 轮询到 `expired` 时 agentd 按 denied 收敛（run 早已继续，§10.2「run 已终态后 FDE 才点审批」同构）。
- **拒绝语义**：denied 时 worker **不抛错**——把「该工具调用被 FDE 拒绝」作为 tool_result 文本返回引擎，由模型决定改道或收尾，避免一次拒绝炸掉整个 run。
- 挂起期间心跳照常续租，run 不会被 re-claim。

### 9.11 `POST /api/internal/runs/:id/release`（U12：主动放弃已领任务）

claim 后准备工作（worktree 创建 / worker fork）失败或 worker 崩溃时使用（runner §6.2/§6.4）。

请求：

```json
{ "reason": "worktree_failed" }
```

| 字段 | 说明 |
|---|---|
| `reason` | string，必填，非空，≤ 64 字符。开放值（便于扩新场景），常用：`worktree_failed`（worktree 创建失败）/ `worker_crashed`（worker 非预期退出）/ `fork_failed` / `prep_failed` / `agent_shutdown` |

响应 `200`（返回对象）：

```json
{
  "run_id": "9d3b2f1e-...",
  "run_status": "queued",
  "queue_status": "pending",
  "attempts": 1,
  "max_attempts": 3,
  "outcome": "requeued"
}
```

| 字段 | 说明 |
|---|---|
| `outcome` | `requeued`（回 `pending` 待重领）\| `failed_max_attempts`（耗尽，run 终态 `failed`）\| `cancelled`（run 已停） |

**状态转换（与 `max_attempts` 对齐，默认 3，schema.sql `run_queue.max_attempts`）**：

| 前置条件 | portal 动作 | `outcome` |
|---|---|---|
| `X-Claim-Token` 失配（run 已被 re-claim） | 拒绝，不产生任何状态变化 | —（`409 lease_lost`） |
| `run_queue.status = 'cancelled'` 或 `runs.status = 'cancelling'`（用户已 stop） | queue → `cancelled`；runs → `finished`（`termination.reason='aborted'`） | `cancelled` |
| `attempts < max_attempts` | queue → `pending`（清 `claim_token`/`owner_container_id`/`lease_until`）；`runs.status` **不变**（attempt 级失败不写 runs，同 run re-claim 后 `attempt > 1` 续跑，model.md §2.8 A1/runner-integration U12） | `requeued` |
| `attempts >= max_attempts` | queue → `done`；runs → `failed`（`max_attempts_exceeded`） | `failed_max_attempts` |

**组合语义**：

- **`attempts < 3` 且 cancelled**：cancelled 分支优先（用户 stop 优先于 re-queue）——stop 语义不可被 release 反转。
- **lease_lost**：release 的前提是「agentd 仍持有有效租约」；若 run 已被 re-claim（旧 `claim_token` 失效），release 一律 `409 lease_lost`（防旧 agentd 释放他人已领的 run）。
- **重复 release**：同 `claim_token` 下、run 尚未被重领时，第二次 release 返回首次结果（幂等，无二次状态迁移）；若首次 release 后 run 已被重领，则旧 `claim_token` → `409 lease_lost`。

错误：`400 validation_failed`（`reason` 缺失/超长）；`401 token_invalid / token_revoked`；`403 run_ownership_mismatch`；`404 run_not_found`；`409 lease_lost`；`409 run_terminal`（run 已终态，release 无意义）；`429 rate_limited`；5xx 无限退避重试（§9.13）。

### 9.12 `GET /api/internal/stream`（SSE 下行通道）

常连；断线指数退避重连（1s→2s→5s→10s→30s 封顶）。事件类型表（runner §4.3）：

| `event:` | 字段 | 语义 | agentd 动作 |
|---|---|---|---|
| `run_assigned` | `{run_id, queue_id}` | **唤醒 hint**：有新任务可领；**不携带权威载荷**（载荷以 claim 响应为准） | 若当前 claim 处于 hold 间隙则立即发起 claim |
| `approval_decision` | `{approval_id, run_id, decision, note, decided_at}` | 审批结果**快通道** | resolve 对应 worker 的 await（§9.10） |
| `stop_request` | `{run_id, reason}` | portal 已写 `cancel_requested_at`（§4.5），要求终止 | IPC `abort` → worker；若无此 run（已结束）忽略 |
| `revoke` | `{reason}` | token 吊销 / 容器停用 | 停领新任务；在跑 run 继续到终态后退出 |
| `ping` | `{ts}` | 15s 保活 | 更新「下行健康」标记；连续丢失触发重连 |

### 9.13 错误码与重试策略（internal 通道）

错误信封沿用 §1.1；下表为本通道特有 code（runner §4.5）：

| HTTP | code | 含义 | agentd 处理 |
|---|---|---|---|
| 400 | `validation_failed` | 载荷不合法（与 §1.2 公开端点**统一 400**，非 422） | **不重试**，记错误日志（视为 bug） |
| 401 | `token_invalid` / `token_revoked` | token 错 / 吊销 | 停领新任务；`token_revoked` 时按 `revoke` 流程退出 |
| 403 | `run_ownership_mismatch` | run 不属本容器 | 记日志告警（视为 bug/攻击），**不重试** |
| 404 | `run_not_found` | run 不存在（已清理） | 停止相关上报，收敛本地状态 |
| 409 | `run_terminal` | 向终态 run 写事件 / checkpoint / state / 审批；或不同载荷重复终态 | 幂等命中：**视为成功**（`stored` 语义），不再重试；不同载荷重复终态**不重试**（首次结果为准） |
| 409 | `lease_lost` | `X-Claim-Token` 失效（run 已被 re-claim）；心跳 U4 则以 run 级 `lease: lease_lost` 表达（非 HTTP 错误，§9.5） | 本地 abort 该 run 的 worker（若还在跑），丢弃缓冲与 spool |
| 409 | `checkpoint_stale` | checkpoint 的 `revision` 不大于当前（旧/乱序/同值重试被 CAS 拒绝，§9.8） | 视为「本快照已过期」，**不重试**（以最新为准） |
| 409 | `invalid_transition` | 非法状态转换（§9.6 转换表之外） | 视为 bug，**不重试** |
| 409 | `round_conflict` | transcript 同 round 不同 body / 不同 dedupKey（§9.7 U5） | 视为 bug，**不重试** |
| 429 | `rate_limited` | portal 自我保护 | 遵循 `Retry-After` 退避 |
| 5xx（含 503）/ 网络错误 | — | portal/DB 抖动 | **无限指数退避重试**（1s→2s→5s→10s→30s 封顶，抖动 ±20%）；事件缓冲走背压与 spool（runner §7.4） |

> ✅ 已统一：internal 通道的 `validation_failed` **与公开端点一致为 `400`**（原 422 已作废）；runner §4.5 也已同步为 400。
