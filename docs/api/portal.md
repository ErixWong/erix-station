# Portal API 契约

> 状态：**契约基线（供前端/后端/mock 并行开发）**
> 依据：[`../design/fde-platform.md`](../design/fde-platform.md)（规格，下称「规格 §x」）、[`../design/principles.md`](../design/principles.md)（原理）、[`../env.md`](../env.md)（环境事实，下称「env §x」）。
>
> **本文只定义「契约形状」**（端点、schema、错误语义、事件信封），不定义实现。前端可只依据本文 + mock 数据开发；后端实现与本文冲突时以规格为准并提 issue。
>
> ⚠️ **Q7（portal 技术栈）未决**：不影响本文任何契约形状；文中个别实现注记按 principles §4 Q7 倾向 (a)（零依赖 `node:http` + 原生前端）给出，标注「⚠️ 待决策者确认」。

---

## 0. 总览

> **环境取值纪律**：契约形状只由规格 + principles 决定，**与环境无关**。文中一切域名/URL 以 env.md §10 的部署变量（`BASE_DOMAIN` / `PORTAL_HOST` / `FDE_WILDCARD_HOST`）为准；JSON 示例中出现的具体域名（`station.erix.vip`、`*.fde.erix.vip` 等）均假设 `BASE_DOMAIN=erix.vip`（env §1 ⚠️ 待决策者确认），仅作 mock 示例，不构成设计约束。部署目标环境不一定是任何已实测的机器。

| 项 | 取值 | 来源 |
|---|---|---|
| Base URL | `https://<PORTAL_HOST>`（`PORTAL_HOST = station.<BASE_DOMAIN>`，如 `https://station.erix.vip`） | env §1/§10 ⚠️ 待决策者确认 |
| 服务监听 | `station-portal:8080`，仅 `edge`/`control` docker 网络内，不 publish 宿主机 | 规格 §5.3 / §6.4（规格自身取值，与环境无关） |
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
| 审批 | `GET /api/approvals` | 待审批工具调用列表 |
| 审批 | `POST /api/approvals/:id` | 审批决定 |

> 所有端点（除 `/api/forward-auth` 与登录两端点外）要求有效 session cookie，否则 `401 unauthorized`。

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
| 409 | `name_conflict` / `run_in_progress` / `no_active_run` / `active_runs` / `already_decided` / `port_quota_exceeded` | 状态冲突，各端点分别列出 | 否 |
| 429 | `rate_limited` | 限流（登录爆破、LLM 配额，见 §6.1） | 是（遵循 `Retry-After`） |
| 503 | `container_unreachable` | FDE 容器不可达（见 §6.3） | 是 |
| 500 | `internal` | 未分类服务端错误 | 否 |

> 资源归属一律以「当前登录用户」过滤：**越权访问与他人资源一律表现为 404**（`not_found`），只有「本人资源上的越级操作」（如普通 FDE 开 `public` 端口）才返回 403。

### 1.3 分页

列表端点统一 cursor 分页：

- 请求：`?cursor=<opaque>&limit=<1..100，默认 20>`
- 响应：`{ "items": [...], "next_cursor": "<opaque|null>" }`（`next_cursor` 为 `null` 表示到底）

### 1.4 写操作幂等

`POST` 端点接受可选 `Idempotency-Key` 请求头；同 key 重复提交返回首次结果（尤其 `POST .../messages`，防断网重发产生两条用户消息）。

---

## 2. 认证

### 2.1 登录方式（P1）

**P1 用本地账号**：argon2id 口令哈希 + **强制 TOTP**，两步登录（规格 §7.1 本地通道的同一套机制；env §8 ⚠️ 待决策者确认：OIDC provider 事实缺失，OIDC 接入延后到 P2，届时按规格 §7.1 走 JIT provisioning，角色来自 group claim）。

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
{ "status": "totp_required", "pending_token": "pt_9f2c...", "expires_in": 300 }
```

| 字段 | 说明 |
|---|---|
| `pending_token` | 一次性、5 分钟有效的待决令牌，仅可用于 `/api/auth/login/totp` |

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

| 属性 | 取值 | 理由 / 来源 |
|---|---|---|
| 名称 | `fde_session` | — |
| `Domain` | `.<BASE_DOMAIN>`（如 `.erix.vip`） | **必须覆盖 portal 与预览泛域名**：portal = `station.<BASE_DOMAIN>`，预览 = `*.fde.<BASE_DOMAIN>`（规格 §6.3；取值见 env §1 ⚠️ 待决策者确认） |
| `Path` | `/` | — |
| `HttpOnly` | 是 | 防 XSS 窃取 |
| `Secure` | 是 | 仅 HTTPS |
| `SameSite` | `Lax` | 规格 §6.3：portal 与预览同 registrable domain → iframe 内 Lax cookie 正常发送；**这是域名方案成立的前提，不得改为 `Strict`** |
| `Max-Age` | 7 天，滚动续期（每次活跃请求刷新服务端过期时间并重发 cookie） | — |

cookie 值为不透明会话令牌（服务端存 `login_sessions`，哈希存储，可单条吊销——offboarding「失效登录会话」依赖此性质，规格 §7.3）。

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

Traefik 对 `<FDE_WILDCARD_HOST>`（`*.fde.<BASE_DOMAIN>`）的每个请求先调本端点（规格 §6.4）。**这是纯函数式授权：「解析 host 中的 FDE 标识 → 与 cookie `sub` 比对 → 200 / 403」**（规格 §6.4 / 原理二）。

请求（Traefik 转发原始请求头）：

| 头 | 用途 |
|---|---|
| `X-Forwarded-Host` | 形如 `<fde>-<token>-<port>.fde.<BASE_DOMAIN>`（示例：`alice-r3a7f-4008.fde.erix.vip`） |
| `X-Forwarded-Uri` / `X-Forwarded-Method` | 审计记录 |
| `Cookie` | 原始请求的 session cookie |

授权逻辑（顺序，任一失败即短路）：

1. **取 hostname → 精确查 `port_allocations.hostname`**。查不到 → `404`（「路由表里没有 = 不可达」，原理二；正常不该发生，发生说明路由与 DB 失同步）。
2. allocation `state` 必须是 `allocated` / `active`；`released` → `403`。
3. 无有效 cookie → `401`（Traefik 配置为据此 302 到 `https://<PORTAL_HOST>` 登录页，登录后回跳）。
4. 按 `exposure` 判定（规格 §6.5）：
   - `private`：`cookie.sub === allocation.fde_id`，否则 `403`
   - `org-visible`：任意已认证用户 → 通过
   - `public`：跳过 cookie 检查（**默认不给**，规格 §6.5）
5. 全部通过 → `200`，响应头 `X-Auth-User: <fde_name>`（Traefik `authResponseHeaders` 透传给上游）。

| 响应 | 含义 |
|---|---|
| `200` + `X-Auth-User` | 放行 |
| `401` | 未认证（触发登录跳转） |
| `403` | 已认证但无权 / 端口已释放 |
| `404` | hostname 无对应 allocation |

每次判定（无论通过与否）写 `audit_log`（actor、hostname、uri、结果）——「谁在什么时候看了哪个端口」（原理二）。forwardAuth 故障时 Traefik 侧 deny-all（规格 §6.2 兜底）。

---

## 3. 项目（Projects）

项目 = FDE 容器内的一个仓库目录 `~/projects/<project>`（规格 §2 术语）。所有项目端点只返回/操作**当前登录用户**的项目。

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
| `name` | 用户内唯一；同时是容器内目录名，故只允许 `[a-z0-9][a-z0-9-]{0,62}` |
| `slot` | 项目端口块序号（决定 `4000 + slot*8` 起始端口，规格 §8.2） |
| `template` | 项目模板（onboarding 第 5 步生成 AGENTS.md 等，规格 §7.2） |

### 3.2 `GET /api/projects`

分页列表（§1.3）。响应 `200`：`{ "items": [Project...], "next_cursor": null }`。

### 3.3 `POST /api/projects`

请求：

```json
{ "name": "proj1", "repo_url": "https://git.<BASE_DOMAIN>/client-x/proj1.git", "template": "node" }
```

`template` 可省略（默认模板）。

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
| 400 | `validation_failed` | name 非法 / repo_url 非法 |
| 409 | `name_conflict` | 同名项目已存在 |
| 409 | `port_quota_exceeded` | 用户端口总配额超限（规格 §8.2：**明确报错**而非静默漂移） |
| 503 | `container_unreachable` | 需要落 `.erix/ports.json` 时容器不可达（§6.3） |

### 3.4 `GET /api/projects/:id`

响应 `200`：`{ "project": {...}, "ports": [PortAllocation...] }`（ports 结构同 §4.7，示例见上文 §3.3）。

### 3.5 `PATCH /api/projects/:id`

请求（全部可选）：`{ "name": "proj2" }`。
响应 `200`：更新后的 Project。
错误：`409 name_conflict`；改名会同步重生成端口 hostname/url（同一事务，规格 §8.1「URL 与路由同源」）。

### 3.6 `DELETE /api/projects/:id`

响应 `204`。删除 = 回收该项目全部端口 + 删除 Traefik 路由（同一事务，规格 §8.2）+ 项目归档。
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
| `last_seq` | 该 session 已落库事件的最大 `seq`（SSE 断线补发的基准，规格 §10.2） |
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
| `termination` | run 结束时由 `runToolLoop` 返回值透传（见 §5.3 `run_end`），运行中为 `null`。类型为**对象** `{ "reason": string, "detail"?: string }`；`reason` 取值集合：`end_turn` \| `no_tool` \| `stall` \| `max_rounds_cap` \| `reflection_stop` \| `judge_done` \| `continuation_exhausted` \| `aborted` \| `failed`（依据：erix-agent v0.3.4 `src/loop.js:622`） |
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
| 429 | `rate_limited` | 已知该用户 LLM 配额耗尽（上次 run 已确认），直接拒绝避免再烧配额（§6.1） |
| 503 | `container_unreachable` | FDE 容器不在线/不可达（§6.3） |

> 支持 `Idempotency-Key`（§1.4）：断网重发同 key 返回首次的 `message`/`run`，不产生重复消息。

### 4.4 `GET /api/sessions/:id/events`（SSE）

实时事件流，详见 §5。

### 4.5 `POST /api/sessions/:id/stop`

停止当前 run。`AbortController` 跨不了进程（规格 §10.3）——portal 写 DB `cancel_requested_at` 标记（+ 单机 push 模式下同步通知 runner ⚠️ 见 §6.3 注），runner 侧终止。

请求体：无（空 JSON `{}`）。

响应 `200`：

```json
{ "run": { "id": "9d3b2f1e-...", "status": "cancelling", "...": "..." } }
```

最终终止结果通过 SSE 的 `run_end` 事件（`termination: { "reason": "aborted" }`，依据：erix-agent v0.3.4 `src/loop.js:712`）与 run 状态收敛体现；前端调本端点后应继续听 SSE，不要轮询。

错误：`404 not_found`；`409 no_active_run`（无进行中 run）。

### 4.6 `GET /api/runs/:id`

run 详情（Run 对象，§4.1）。用于查看已结束 run 的 `termination` / `usage` / `error`（如 `checkpoint_failed`），以及审批卡片跳转。

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

#### `GET /api/approvals?status=pending`

分页列表，只返回本人 run 的审批项。响应 `200 {items, next_cursor}`。

#### `POST /api/approvals/:id`

请求：`{ "decision": "approve", "note": "可选备注" }`（`decision`: `approve` \| `deny`）。
响应 `200`：更新后的 Approval；runner 轮询到决定后继续/终止该工具调用。
错误：`404 not_found`；`409 already_decided`。

---

## 5. SSE 事件流（`GET /api/sessions/:id/events`）

### 5.1 传输语义

- **SSE 而非 WebSocket**（规格 §10.2）：事件单向，输入走 `POST .../messages`。
- **事件先落 DB，portal 从 DB 读并推流**（规格 §10.2 / D7）：portal 重启不杀正在跑的 run；`seq` 由宿主在落库时分配，**每个 session 内单调递增、无空洞保证**（允许因并发落库有间隙，但保证递增）。
- 响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`X-Accel-Buffering: no`。
- 每 15s 发送注释行心跳（`: ping\n\n`），防止中间层断连。心跳不是事件，不占 seq。
- 响应建议携带 `retry: 3000`，指导浏览器断线重连间隔。

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

> 也可用该端点做**事件重放**（P2 验收「断线重连不漏事件」即依赖本节语义）。

### 5.3 事件信封完整类型清单（对应规格 §10.1；LoopEvent 部分与 erix-agent v0.3.4 `src/loop.js:533` 的 LoopEvent union 一一对应，共 8 类）

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
| 12 | `judge` | `onJudge` | `kind: "round"\|"intercept"`，`action: "judge_done"\|"nudge"\|"continue"\|"executed"\|"blocked"\|"degraded"`，`decision: {done, confidence, reason, evidence} \| null`，可选 `error: "timeout"\|"error"\|"parse"`，可选 `tool: {id?, name?, input?}`（依据：erix-agent v0.3.4 `src/loop.js:545-552` JudgeEvent typedef；对应 `judge_decisions` 表） |
| 13 | `run_end` | `runToolLoop` 返回值 | `termination: { reason, detail? }`（**对象**，`reason` 取值集合见 §4.1；依据：`src/loop.js:622`），`usage: { input_tokens, output_tokens }`（整 run 汇总），`compaction_stats: array`（宿主侧字段名：值为引擎返回值 `compactionStats` **数组**原样，元素 `{compacted, foldedRounds, tokensBefore, tokensAfter}`，依据：`src/loop.js:624`；snake_case 命名为宿主约定）；失败时附加 `error: { code, message, retryable }`（见 §6） |

> 说明与边界：
> - 第 1~8 类是 **erix `LoopEvent` 的原样透传**（规格 §10.1：「`type: 同 LoopEvent`」），与 erix-agent v0.3.4 `src/loop.js:533` 的 LoopEvent union 一一对应（8 类，契约锚点见 principles §6）。**上游 additive 新增 LoopEvent 子类型时宿主原样透传**，前端按「未知类型忽略」规则处理即兼容（规格 §13.2-3 additive 原则）。
> - 第 9/10/11/13 类的字段形状在规格 §10.1 已锚定（`{text}` / `{termination, usage, compaction_stats}`）；第 11 类规格写作 `{type:"tool_call_delta", ...}`，上表字段为宿主侧补全。
> - `termination` 是**对象** `{reason, detail?}`，`reason` 取值集合以 erix-agent v0.3.4 `runToolLoop` 返回值契约为准（`src/loop.js:622`）：`end_turn` / `no_tool` / `stall` / `max_rounds_cap` / `reflection_stop` / `judge_done` / `continuation_exhausted` / `aborted` / `failed`。宿主映射：用户主动停止 → `aborted`（`src/loop.js:712`）；引擎失败 → `failed`；正常结束 → `end_turn`（或 `no_tool` / `judge_done` 等）。**若宿主需额外区分「cancelled」这类 UI 语义，那是宿主从 `cancel_requested_at` + `termination.reason` 推导的展示态，不得冒充引擎取值**。
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
- **宿主 store adapter 必须把 `checkpoint_failed` 识别为可重试并包 retry**（规格 §9.3-2，erix ≤0.3.4 无重试）；重试耗尽后才是用户可见的失败。
- 前端见到该错误码的提示口径：「任务因平台存储故障中止，进度未丢失，可重新发送继续」（重发消息走 §4.3，引擎 resume 依赖成对的 checkpoint）。
- ⚠️ 待决策者确认（Q7 之外的实现注记）：规格 §9.3 强烈建议「本地 file 优先 + DB 异步复制」的 store 装饰器以避免中心 DB 抖动杀光所有任务；该取舍影响此错误的出现频率，不影响契约形状。

### 6.3 容器不可达 → `container_unreachable`（503）

portal → FDE 容器走 `http://fde-<name>:3000`（control 网络，Bearer per-container token，规格 §5.3/§10.3）。容器下线/崩溃/网络不通时：

| 端点 | 表现 |
|---|---|
| `POST /api/sessions/:id/messages` | `503 container_unreachable`，`retryable: true`。**不产生** message/run 记录（fail-fast，避免「消息发出去了但没执行」的假象） |
| `POST /api/sessions/:id/stop` | 仍返回 `200`：`cancel_requested_at` 是 DB 标记（规格 §10.3），容器恢复后 runner 轮询到即终止；不因此报错 |
| `POST /api/projects`（需落 `ports.json`） | `503 container_unreachable`，整个事务回滚（端口分配与容器内 JSON 不脱节） |
| SSE / GET 类 | 不受影响——事件与状态都在 DB（原理三），容器死了历史照样可看 |

⚠️ 待决策者确认：任务下发单机可先用 push、拉模型（长轮询领 `run_queue`）为终态（规格 §10.3）。**pull 模型落地后**，`POST .../messages` 不再同步依赖容器可达——消息落库即 `202`，容器恢复后自行领取；上表第一行随之退化为「仅 push 模式适用」。契约的响应 schema 不变，仅错误出现条件变化。

### 6.4 run 级错误码汇总（`run.error.code` / `run_end.error.code`）

| code | retryable | 含义 | 用户提示口径 |
|---|---|---|---|
| `rate_limited` | 是（人工/延迟后） | LLM 配额耗尽（§6.1） | 配额用尽，勿自动重试 |
| `checkpoint_failed` | 是 | checkpoint 写失败，fail-closed 中止（§6.2） | 存储故障，可重发继续 |
| `container_exited` | 是 | run 进行中容器退出（心跳丢失/崩溃） | 容器异常，平台正在恢复 |
| `cancelled` | 否 | 用户主动停止（此时 `termination.reason` 为 `"aborted"`，`error` 通常为 `null`，本码仅兜底） | — |
| `internal` | 否 | 未分类引擎/宿主错误 | 联系管理员，附 run_id |

---

## 7. ⚠️ 待决策者确认汇总（本文出现的全部标注）

| # | 事项 | 当前倾向（principles §4） | 影响 |
|---|---|---|---|
| 1 | Q7 portal 技术栈 | (a) 零依赖 Node | 仅实现注记，**契约形状无关** |
| 2 | `BASE_DOMAIN`（影响 cookie `Domain`、所有示例 URL；当前倾向 `erix.vip`） | env §1 ⚠️ | §0 / §2.5 |
| 3 | P1 认证 = 本地账号 + 强制 TOTP（OIDC 延后 P2） | env §8 / Q3 倾向 (a) | §2.1 |
| 4 | Q5 端口分级：先只做项目级 | 倾向 (b) 起步 | §4.7（`scope`/`run_id` 字段保留） |
| 5 | 任务下发 push→pull 演进 | 规格 §10.3：单机可先 push | §6.3（`container_unreachable` 出现条件） |
| 6 | `run.cost` 记账口径 | 依赖 Q1/Q4 | §4.1（P1 可为 `null`） |

---

## 8. 前端 mock 指引（验收锚点）

前端只依据本文开发时：

1. 所有响应按本文 schema 生成 mock；错误分支按 §1.2 / §6 的 `code` 表逐一覆盖（至少：`unauthorized` / `not_found` / `run_in_progress` / `rate_limited` / `container_unreachable` / `checkpoint_failed` 经 run 详情）。
2. SSE mock：按 §5.3 清单逐类型发事件，`id` 递增；模拟断线后带 `Last-Event-ID` 重连，验证补发不漏（P2 验收的前端半边）。
3. `messages.synthetic: true` 的消息必须有独立视觉标记（规格 §9.2 红线）。
4. 预览 URL 一律取 `PortAllocation.url` 字段，禁止拼接域名（规格 §8.1 同源原则）。
