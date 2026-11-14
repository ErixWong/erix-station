# Portal API 契约

> 状态：**契约基线（供前端/后端/mock 并行开发）**
> 依据：[`../design/fde-platform.md`](../design/fde-platform.md)（规格，下称「规格 §x」）、[`../design/principles.md`](../design/principles.md)（原理）、[`../env.md`](../env.md)（环境事实，下称「env §x」）。
>
> **本文只定义「契约形状」**（端点、schema、错误语义、事件信封），不定义实现。前端可只依据本文 + mock 数据开发；后端实现与本文冲突时以规格为准并提 issue。
>
✅ **Q7 已定稿**（原生 `node:http` + 原生前端、零 Web 框架，运行时依赖 `pg` 与 YAML 配置解析器，principles §4；fde-platform 附录 A）：不影响本文任何契约形状；文中实现注记按定稿口径给出。

---

## 0. 总览

> **环境取值纪律**：契约形状只由规格 + principles 决定，**与环境无关**。文中一切域名/URL 以 env.md §10 的部署变量（`BASE_DOMAIN` / `PORTAL_HOST` / `FDE_WILDCARD_HOST`）为准；JSON 示例中出现的具体域名（`station.fde.erix.vip`、`eric-p-8001.fde.erix.vip` 等）均假设 **`BASE_DOMAIN=fde.erix.vip`（#57 定稿：`BASE_DOMAIN` = **伞域** = `fde.<可注册域>`，不再是可注册域）**，仅作 mock 示例，不构成设计约束。**`*.localhost` 不是“开发期变通”**：它是 `BASE_DOMAIN` 的**代码默认兜底值（本地起服，env §0/§1）**，代码默认值为 `localhost`（即本地起服 `http://station.localhost:8090`，不套伞域前缀），代码路径与生产完全一致（dev `http://station.<BASE_DOMAIN>:8090`，生产 `https://station.<BASE_DOMAIN>`，scheme/端口从公开入口配置派生）。部署目标环境不一定是任何已实测的机器。

| 项 | 取值 | 来源 |
|---|---|---|
| Base URL | `https://<PORTAL_HOST>`（`PORTAL_HOST = station.<BASE_DOMAIN>`，BASE_DOMAIN 为伞域 ⇒ 如 `https://station.fde.erix.vip`）；本地起服默认兜底 `http://station.localhost:8090`（`BASE_DOMAIN` 代码缺省 = `localhost`） | env §1/§10（#57 定稿伞域口径） |
| 服务监听 | portal 容器内 `:8080`，publish **仅 `127.0.0.1:8080`（宿主回环）**，由 Traefik（host 网络）反代与 forwardAuth；不暴露 LAN | 规格 §5.3 / §6.4 / topology.md §2.2 |
| 字符集 / 格式 | 全部 `application/json; charset=utf-8`（SSE 端点除外） | — |
| 时间格式 | ISO 8601 UTC（如 `2026-09-12T08:30:00.000Z`） | — |
| ID 约定 | `run_id` 用 **UUID**（规格 §9.3：不要 cwd 派生）；其余 ID 为不透明字符串，前端不得解析其结构 | 规格 §9.3 |
| 鉴权 | session cookie（见 §2）；`/api/forward-auth` 由 Traefik 内部调用，不对浏览器暴露语义 | 规格 §6 |

### 0.1 端点清单

| 分类 | 方法 + 路径 | 说明 |
|---|---|---|
| 站点 | `GET /api/site` | **公开、零秘密**：两个入口的对外 URL（`userBaseUrl` / `adminBaseUrl`，§2.12；#450 A2）。无会话也 `200` |
| 认证 | `POST /api/auth/login` | 第一步：口令校验 |
| 认证 | `POST /api/auth/login/totp` | 第二步：TOTP 校验，发 cookie |
| 认证 | `POST /api/auth/login/email-code` | 第二步：**邮箱验证码**校验，发 cookie（#449，§2.3a）|
| 认证 | `POST /api/auth/login/email-code/resend` | 重发邮箱验证码（#449，§2.3b）|
| 认证 | `POST /api/auth/logout` | 登出 |
| 认证 | `GET /api/me` | 当前用户信息（含 `must_change_password` 与 `file_upload_enabled`，§2.6）|
| 认证 | `POST /api/me/password` | **本人自助改密**（#255 首登强制改密的唯一出口，§2.6a）|
| 边缘授权 | `GET /api/forward-auth` | Traefik forwardAuth 回调（非浏览器 API） |
| 项目 | `GET /api/projects` | 项目列表（**留档只读**，P5 后表内无新行 ⇒ 正常返回空 `items`，§3.2/§3.3） |
| 项目 | `POST /api/projects` | **已退役 `410 project_api_retired`**（目录即项目，§3.3） |
| 项目 | `GET /api/projects/:id` | 项目详情（留档只读；`ports` 恒空，§3.4） |
| 项目 | `PATCH /api/projects/:id` | **已退役 `410 project_api_retired`**（§3.5） |
| 项目 | `DELETE /api/projects/:id` | **已退役 `410 project_api_retired`**（§3.6） |
| 目录 | `GET /api/dirs` | 目录下拉：`~/projects/` 一级目录 + 非终态 run 徽标（P5「目录即项目」；**本表此前漏记，现补**） |
| 目录 | `GET /api/files/tree?cwd=&path=` | 目录树单层懒展开（只读、逐段拒 symlink；此前漏记，现补） |
| 目录 | `GET /api/file?cwd=&path=` | 单文件只读预览（≤ 2MB，超限报错不截断；此前漏记，现补） |
| 目录 | `GET /api/git-light?cwd=` | **收工灯**（issue #359，决策 D9）：`{light: red\|yellow\|green\|grey, reason, repos[], partial, …}`；只读零写，宿主直读 `.git`。**运行前提：镜像内需 `git`**（`portal/Dockerfile` apt 层），缺它时全报 `grey / git_unavailable` |
| 管理 | `GET /api/admin/fdes/:fdeName/git-credential` | 查询 Git 凭据主机、用户名与掩码 |
| 管理 | `PUT /api/admin/fdes/:fdeName/git-credential` | 配置一个 Git 主机凭据 |
| 管理 | `DELETE /api/admin/fdes/:fdeName/git-credential?host=<host>` | 删除一个 Git 主机凭据 |
| 管理 | `GET /api/admin/users` | 用户列表（不含密码哈希/TOTP 种子） |
| 管理 | `POST /api/admin/users` | 创建本地 FDE 用户 |
| 管理 | `PATCH /api/admin/users/:id` | 更新用户资料、角色、FDE 名称或状态 |
| 管理 | `DELETE /api/admin/users/:id` | 停用用户；有 FDE 资源时异步下线（用户行永久保留） |
| 管理 | `POST /api/admin/users/:id/offboarding/retry` | 重试失败的 FDE 下线任务 |
| 管理 | `POST /api/admin/users/:id/reset-password` | 重置口令并强制重新登录 |
| 管理 | `POST /api/admin/users/:id/totp-reset` | 清除 TOTP 绑定并强制重新登录 |
| 管理 | `POST /api/admin/users/:id/totp-enroll` | 补绑/重绑 TOTP；新种子只在本次响应下发并强制重新登录 |
| 管理 | `GET /api/admin/mail/settings` | **邮件通道配置：读**（#449，§4.12）。**永不返回口令**：只给 `hasPassword` 布尔；无行（未配置）也回 `200` + 默认 DTO |
| 管理 | `PUT /api/admin/mail/settings` | **邮件通道配置：写**（#449，§4.12）。口令**只写**：键缺席 = 不修改、`null`/`""` = 清除；落库后缓存**立刻**失效（不等 60s TTL） |
| 管理 | `POST /api/admin/mail/test` | **用已保存的配置发一封测试信**（#449，§4.12）。未启用 ⇒ `409 mail_not_configured`；每管理员 5 次/小时 |
| 管理 | `GET /api/admin/tls` | **证书现状：读**（#456，§4.13）。盘上证书元数据 + 覆盖判定 + 最近一次真机校验结果（**只读缓存，不主动连接**）+ 有无可回滚备份。无证书 ⇒ `200` + `configured:false` |
| 管理 | `PUT /api/admin/tls` | **证书上传/更新**（#456，§4.13）。校验（PEM/配对/未过期/覆盖 adminHost/confirmDomains）→ 备份上一代 → 写盘（key 0600）→ 重写 `tls.yml`（触发 reload）→ 台账 → 审计。每管理员 10 次/小时 |
| 管理 | `POST /api/admin/tls/inspect` | **解析但不落盘**（#456 M2，§4.13-3a）：`{certPem,keyPem?}` → 证书元数据 + `keyMatches` 三态 + 覆盖判定 + `warnings`。**零副作用**（不写盘/DB/审计、不动 `tlsLive`、不烧上传配额）；每管理员 120 次/小时 |
| 管理 | `POST /api/admin/tls/verify` | **真机校验**（#456，§4.13）：连默认网关的 `TRAEFIK_ADMIN_PORT` + `servername=adminHost`，比 `fingerprint256` ⇒ `live`/`mismatch`/`unreachable`。每管理员 30 次/小时 |
| 管理 | `POST /api/admin/tls/rollback` | **回滚到上一代**（#456，§4.13）。从 `certs/prev/` 还原 + 重写 `tls.yml` + 台账（`kind='rollback'`）+ 审计；无 prev ⇒ `404 tls_no_previous` |
| 会话 | `GET /api/sessions` | 会话列表 |
| 会话 | `POST /api/sessions` | 创建会话 |
| 会话 | `GET /api/sessions/:id` | 会话详情（含消息历史 + `last_seq`） |
| 会话 | `PATCH /api/sessions/:id` | 改标题 |
| 会话 | `POST /api/sessions/:id/ai-title` | AI 改名（按需调一次 LLM 生成标题，§4.5a） |
| 会话 | `DELETE /api/sessions/:id` | 归档会话 |
| 对话 | `POST /api/sessions/:id/messages` | 发消息（创建 run） |
| 对话 | `GET /api/sessions/:id/events` | **SSE 事件流**（§5） |
| 对话 | `GET /api/sessions/:id/folded/:round` | 折叠段「查看原文」（§4.4b，#189；**#375 改口径**：有 `foldedRoundRange` 就从账本重建） |
| 子 run | `GET /api/sessions/:id/delegates?runId=` | **子 run 名册**（§4.4c，delegation P2：读 FDE 家目录的名册文件，零 DDL） |
| 子 run | `GET /api/sessions/:id/delegates/:childRunId?runId=&tail=` | **子 run 账本投影**（§4.4c，与主对话同形的只读消息流） |
| 对话 | `GET /api/sessions/:id/events/history` | run_events 展示类事件历史（§4.4a，刷新后重建卡片/面板；另含两类**响应期合成项** `partial_output` §4.4a-1 / `run_termination` §4.4a-2） |
| 对话 | `POST /api/sessions/:id/stop` | 停止当前 run |
| 对话 | `GET /api/runs/:id` | run 详情（状态 / termination / usage / error） |
| 端口 | `GET /api/projects/:id/ports` | **已退役 `410`**：端口事实的读取面是 FDE 级 `~/.erix/ports.json`（§4.7 / 规格 §8.2） |
| 端口 | `GET /api/me/ports` | **本人预览端口列表**（#246 交付②，§4.7a：只列活行、含签票要的 `id`） |
| 端口 | `GET /api/admin/fdes/:fdeName/ports` | **管理员列他人预览端口**（#246 交付②，§4.7a；读他人资源**必写审计**） |
| 端口 | `POST /api/admin/fdes/:fdeName/ports/block` | **管理员改块 = 搬迁事务**（#246 交付②，§4.7a：同事务释放旧块 + 撤 grant + 插新块 + 入队两条派生链） |
| 端口 | `GET /api/admin/preview-ports/usage` | **号池占用总览（只读）**（#256 交付①，§4.7a：哪几段被占 / 哪几段整段空闲 + `fde_names`，让改块先选空闲段；读他人资源必写审计） |
| 端口 | `PATCH /api/ports/:id` | 改可见级别（exposure）——⚠ **未交付**（无路由，实测 `404`；口径已裁决：预览不对外分享，见 principles §3 / #250）|
| 端口 | `POST /api/ports/:id/preview-ticket` | 签发一次性预览 ticket（§2.8） |
| 端口 | `POST /api/me/ports/batch-tickets` | **一键放行整组：一次请求签 N 张预览票**（#247，§4.7a：上限 = 号池块大小、越界 `404`、审计逐张、零新错误码） |
| 文件 | `POST /api/files/upload?cwd=&path=&name=[&overwrite=1]` | **入向通道：上传一个文件**（#472 片 B，§4.14：**请求体是原始字节，不是 multipart**；per-user 能力位 `file_upload_enabled` 在**收 body 之前**判 ⇒ 未授权 `403 upload_disabled`；流式落盘不读进内存；同名 `409 file_exists`，`overwrite=1` 才替换）|
| 文件 | `GET /api/file?mode=json\|stream\|download` | 单文件预览（缺省 `json` 行为不变）；`stream` 带 Range/MIME/Disposition，`download` 附件（#366 P0，§4.11） |
| 文件 | `POST /api/preview-tickets` | 签一枚 `/pv/<code>` 预览能力码（#366 P2，§4.11） |
| 文件 | `GET /pv/<code>/**` | kkFileView 反代网关（非 JSON API，浏览器 iframe 入口；#366 P2，§4.11） |
| 文件 | `GET /api/admin/preview-misses` | 415/413 预览未命中日聚合（#366 P1，§4.11；管理员） |
| 审批 | `GET /api/approvals` | 待审批工具调用列表——⚠ **未交付**（无路由，实测 `404`；能力已裁决不交付，见 principles §3 / #249）|
| 审批 | `POST /api/approvals/:id` | 审批决定——⚠ **未交付**（同上；internal 面 U10/U11 保留作协议留档）|
| LLM 管理 | `GET /api/admin/llm/providers` | 供应商 + 模型列表（模型对象的两个名字见 §4.9） |
| LLM 管理 | `POST /api/admin/llm/providers/:id/models` | 新增模型 |
| LLM 管理 | `PATCH /api/admin/llm/models/:id` | **改模型：调用名 `call_name`（数据面）与显示名 `name` 是两个字段**（#296，§4.9） |
| LLM 管理 | `GET /api/admin/llm/models/:id/delete-impact` | 删除前算「会被打断的 run」 |
| LLM 管理 | `DELETE /api/admin/llm/models/:id` | 删模型（附虚拟 key 清理） |

> LLM 管理这条线**其余**端点（供应商增删、`GET/PUT /api/admin/fdes/:name/llm`、
> `POST /api/admin/fdes/:name/llm/heartbeat`、`GET /api/admin/llm/model-catalog`、
> `GET /api/admin/llm/usage`）此前同样不在索引里，本次不逐个补写契约（不在 #296 面上）；
> 行为以 `portal/src/llm.js` + `portal/test/llm*.test.js` 为准，改名这条线的契约见 §4.9，
> 心跳对账的口径见 `AGENTS.md` §8.25。登记这几行是为了「端点索引与文档自洽」（§7.13）。

> 所有端点（除 `/api/forward-auth` 与登录两端点外）要求有效 session cookie，否则 `401 unauthorized`。
>
> ⚠ **受限会话（#255，工单 `feat-261013-03`）**：`users.must_change_password = true`（口令由管理员代设/重置，还没经过本人之手）的会话，在改密前**只能**碰 §2.11a 的放行清单，其余本表端点一律 `403 password_change_required`（§1.2）。上表不因此改动：受限是「会话的状态」，不是端点的新属性。
>
> 容器 → portal 的内部端点（`/api/internal/*`）见 §9（经 Traefik：`https://station.<base>/api/internal/*` + 来源 ipAllowList，H-B 定稿 D-5），不属上表。

> ⚠ **`/api/admin/*` 在边缘就不可达（#450，工单 `feat-261105-01`）**：上表里所有 `管理` 端点**只能从管理台入口**
> （`https://admin.<伞域>:9443`，`ADMIN_PUBLIC_HOST` / `TRAEFIK_ADMIN_PORT`）访问。从用户入口
> （`station.<伞域>`，80/8090）打 `/api/admin/*` 得到的是**边缘返回的 `404`**（Traefik 的隔离 deny 路由，
> 优先级高于 portal 路由）——**不是 portal 的 `403 forbidden` / `404 not_found`**，也不会产生任何到 portal 的请求。
> 因此：① 看到 `403 forbidden` 说明请求已经到了 portal（即走的是管理台入口）；② 看到 `404` 且响应体是
> `Not Found`（无 JSON 错误信封）说明被边缘挡了。管理台 host 上除 `/api/admin/*`、`/api/auth/*`、`/api/me`、
> `/api/site`（§2.12）之外的 `/api/*`（如 `/api/sessions`）同样在边缘返回 `404`。矩阵与实现见
> [`../deploy/edge-routing.md`](../deploy/edge-routing.md) §2/§3。

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
| 401 | `email_code_invalid`（#449）| **登录第二步（邮箱验证码）校验失败**：码错、码不存在、码已过期、尝试次数用尽——四者**同一个码**（不区分，防探测「这枚 pending 到底走到哪一步」）。`retryable` 为否：解法是重发（§2.3b）或重走第一步（§2.2）。`too_many_attempts` 的 `message` 会额外说明「请重新登录获取新验证码」。详见 §2.3a | 否 |
| 403 | `forbidden` | 已认证但无权访问该资源（含他人资源、越级操作） | 否 |
| 403 | `cross_origin_forbidden`（#234，工单 `feat-261013-01`）| **跨站写请求被同源防线拒**（`Sec-Fetch-Site: cross-site` / `Origin` 的 authority 与请求自身不同，**含同注册域的 `same-site`**）。**与 `forbidden` 的关键差别：这是「没资格发这个请求」而不是「没权限做这件事」**，且**未认证也可能拿到**（防线先于 cookie 校验）。`details` = `{origin, sec_fetch_site, method}`（**不含 cookie**）；响应带 #241 那套 CORS deny 头（ACAO/ACAC/Vary）。判据、豁免端点、语义变化见 §2.11 | 否 |
| 403 | `password_change_required`（#255，工单 `feat-261013-03`）| **受限会话被拦**：已认证，但 `users.must_change_password=true` 且尚未改密 ⇒ 除 §2.11a 放行清单外的 `/api/*` 全部拒。**与 `forbidden` 的关键差别：不是「这件事你没权限」而是「这枚口令还没经过你的手」**；解法只有一个（`POST /api/me/password`），所以 `details` 直接给 `{action, endpoint}`。登录（新旧两条）、登出（新旧两条）、`GET /api/me`、`/api/me/password`、`/api/forward-auth`、`/api/internal/*` 不受限（逐条理由见 §2.11a）；**未认证的 401 语义不变**（门只管已认证的人）。**不写审计**（SPA 轮询会把它刷成噪声，理由见 §2.11a）| 否 |
| 404 | `not_found` | 资源不存在（**他人资源也返回 404**，不泄露存在性） | 否 |
| 409 | `name_conflict` / `run_in_progress` / `queue_full`（#370，§4.3a 待发送队列满）/ `no_active_run` / `active_runs` / `already_decided` / `approval_expired` / `idempotency_key_reuse` | 状态冲突，各端点分别列出。**`port_quota_exceeded` 已删除**（#240：预览域名一次性预分配 ⇒ 没有「配额超限」这回事，规格 §8.2；不新造替代码）。**#246 新增 `preview_port_block_taken`**（开户/补建预览段时全局唯一索引 `port_allocations_live_global_port_key` 报 `23505` ⇒ 候选块被并发占用，**可重试**，与上面「状态冲突不重试」的口径不同，见规格 §8.2。**#246 交付② 同一码也用在新端点 `POST /api/admin/fdes/:fdeName/ports/block`**：管理员显式指定的块被外来活行占住、或搬迁中途插入数 ≠ 10（并发抢号 ⇒ 整笔回滚）——**那里 `retryable` 是 `false`**（盲试同一段必败，要先换一个起点），口径见 §4.7a） | 是（仅此码；**例外**：§4.7a 的改块 409 为 `false`） |
| 409 | `model_name_conflict`（#296，工单 `feat-261015-03`）| **管理员改「调用名」时撞了另一个模型正在用的数据面名字**：`PATCH /api/admin/llm/models/:id` 带 `call_name`，而网关目录里**别的** deployment 的顶层 `model_name` 已经是它。`details` = `{field: 'call_name', call_name, conflicting_model_id}`。**为什么门户要拦**：真机实测 LiteLLM **不拦重名**（两条 deployment 都 200 建成），而 `GET /v1/models` 只列一个、按名字路由时请求在两个 deployment 之间**轮询** ⇒ 同名 = 静默的二义性，比报错更难查（§4.9）。同码也用于**调用名没变、但顺手把上游模型 `litellm_params.model` 改成另一个模型正在用的调用名**（网关路由表按顶层名选 deployment，那个新值落进去就是同一件事）。与 `name_conflict` 的差别：那是会话/仓库标题冲突，本码是**数据面路由名**冲突 | 否（换个名字才行）|
| 400 | `preview_hostname_invalid`（#246 交付① 引入、交付② 沿用）：FDE 名拼不出合法的预览域名（首标签超 DNS 上限 63 ⇒ **预算 55**，`details.field='fde_name'`）。落点：开户（`admin.js createUser`）与预分配前复检（`portalloc.js`）、以及**交付② 的管理员改块**（§4.7a）——**不降级为 warn**，否则到 INSERT 才被 0017 的 CHECK 以裸 23514 炸掉（#202 的病根） | 否 |
| 400 | `validation_failed` 之外，开户链路还可能返回 `preview_port_block_invalid`（管理员显式指定的块起点未对齐/越界/装不下 N 个端口，`field='preview_block_start'`）。号池用尽时返回 `preview_port_pool_exhausted`（500 类，带 `used`/`total` 计数）——800 段号池，实测极难触发。**交付② 的改块端点不透 `preview_port_block_invalid`**：同一种非法在浏览器侧一律是 `validation_failed`（`details.field='block_start'`，§4.7a） | 否 |
| 409 | `idempotency_conflict` | 同一 `Idempotency-Key` 的并发请求未收敛（先到先得）——该 key 的首次执行仍在进行中（`in_progress` 占位 < 5 分钟），或本请求的占位已被其它 owner 接管（`claim_token` fencing 失配，§1.4）；稍后重试即可拿到首次结果 | 是 |
| 409 | `email_not_registered`（#449）| **邮件通道已启用，但这个账号没有邮箱** ⇒ 第二因素做不成（`users.email` 为空）。`retryable: false`：重试一万次也不会长出邮箱，`message` 直接给出路「请联系管理员补录邮箱」。**关键语义：绝不静默退回纯口令**（否则「开了第二因素」只是控制台的错觉）。落点：§2.2 第一步与 §2.3b 重发 | 否 |
| 409 | `mail_not_configured`（#449，管理台切片）| **测试发信时邮件通道未启用**（`mail_settings` 无行 / `transport='disabled'` / `MAIL_TRANSPORT=disabled` 急停 / 配置只配了一半 ⇒ 读取侧一律 `enabled:false`）。`retryable: false`：重试一万次也发不出去，`message` 直接给出路「先去管理台配 SMTP」。落点只有 `POST /api/admin/mail/test`（§4.12）——登录路径同一种状态**不是错误**（它按「没有第二因素」正常退回纯口令，§2.2 第③分支）| 否 |
| 409 | `llm_model_not_found`（#261014 切片 B2，工单 `fix-261014-05b2`）| **发消息预检 fail-fast**：`POST /api/sessions/:id/messages` 在建 run 之前发现「会话属主 active LiteLLM binding 里某个**已配置槽位**的 `model_info.id` 在网关 `/model/info` 里查不到」（模型被删除/重建 ⇒ **id 变**）。**与 `llm_not_configured` 的关键差别：后者是「压根没配」，本码是「配过，但那个模型已经不存在了」**。`details` = `{slot, model_id}`（`slot` 取值 `main` / `embedding` / `vision`）。**选 409 而不是 424**：请求本身合法且已认证，失败原因是「绑定配置与网关目录的状态互相矛盾」，与同端点既有的 `409 llm_not_configured` / `409 run_in_progress` 同族（424 Failed Dependency 语义是「依赖的前置请求失败」，这里没有任何前置请求，且 §4.3 全表无 424 先例）。**只在发消息路径拦**：心跳路径同判据仍只 `warn`（§9.5，`reason: 'unknown_model_id'`）；**网关不可达一律放行**（fail-open，不让网关抖动演成用户发不出消息）| 是（管理员改配后原样重试可成功；本预检零副作用、不写幂等台账，同 `Idempotency-Key` 重试会重新占位，§1.4。**盲目立即重试仍是同一码**——解法只有一个：改配） |
| 400 | `tls_cert_invalid`（#456，§4.13）| **上传的证书 PEM 解析不出来**（`new X509Certificate()` 抛；空串/非 PEM/被截断都算）。`retryable:false`：同一份字节重试一万次也一样。`details` 不带任何 PEM 片段 | 否 |
| 400 | `tls_key_invalid`（#456，§4.13）| **上传的私钥 PEM 解析不出来**（`createPrivateKey()` 抛）。与 `tls_key_mismatch` 的区别：这是「这根本不是一把钥匙」，那是「是钥匙但不是这张证书的」| 否 |
| 400 | `tls_key_mismatch`（#456，§4.13）| **私钥与证书不配对**（两边导出的 SPKI DER 不一致）。装错私钥的后果是管理台入口握手直接失败（Traefik `Error while creating certificate store`），所以必须在写盘前拒 | 否 |
| 400 | `tls_cert_order_invalid`（#462，§4.13）| **证书顺序反了**：给了私钥、配对成功的那张（叶子）**不是第一个 `BEGIN CERTIFICATE` 段**。`details = {firstSubjectCN, leafSubjectCN}`。为什么是 400 而不是警告：这种形态 Traefik **直接拒加载这张证书**（`Unable to parse certificate … tls: private key does not match public key`），整条 `tls.certificates` 项失效、退回内置自签 ⇒ 管理台变成浏览器硬告警（2026-11-05 真机实测）。**注意**：本码必须排在 `tls_key_mismatch` **之前**报，否则用户的私钥是对的却被报成「不配对」 | 否 |
| 400 | `tls_cert_chain_broken`（#462，§4.13）| **链在段间接不上**：`checkIssued` 在某一对上是 false（典型：拼进来的中间证书不是签发这张叶子的那张）。`details = {index, subjectCN, issuerCN, nextSubjectCN}`，`index` 是**段号（从 1 起，与文案同数）**。与「只有叶子」的分界：后者是「我知道我只有叶子」（可接受的自担风险，`200` + `chain_looks_leaf_only`），前者是「我以为我给了链，其实接不上」——发出去客户端一定链校验失败，而用户没有任何别的信号 | 否 |
| 400 | `tls_cert_expired`（#456，§4.13）| **证书已过期**（`notAfter <= now`）。`retryable` 也是 `false`：重试还是同一张过期证书，出路只有换一张 | 否 |
| 400 | `tls_cert_domain_mismatch`（#456，§4.13）| **证书覆盖不到管理台域名**（`details = {adminHost, missing:[…], certDomains:[…]}`），或 `confirmDomains` 里有证书覆盖不到的名字（此时 `details.field='confirmDomains'`，`missing` 只列超出的那些）。**无 override**：不覆盖 `admin.<伞域>` 的证书装上去 = 刷新后进不了管理台，只能登服务器救 | 否 |
| 404 | `tls_no_previous`（#456，§4.13）| **没有可回滚的上一代证书**（`<dynamic>/certs/prev/` 不存在或不完整——首次上传后立刻点回滚就是这一格）。`retryable:false` | 否 |
| 413 | `payload_too_large` | 请求体超过大小上限（`Content-Length` 或实际流式字节超限） | 否 |
| 403 | `upload_disabled`（#472 片 B，§4.14）| **这个账号没有「往自己磁盘上传文件」的能力**：`users.file_upload_enabled` 不是 `true`（片 A 的 per-user 开关，管理台 Edit → Security 里开）。**与 `forbidden` 的关键差别：判定发生在读请求体之前**——上传端点的 body 是几十 MiB 的字节流，先收完 body 再拒 ⇒ 未授权的人能把 portal 的内存与带宽当成压力测试工具，所以这里「无权」连带「不必听完你说什么」。`details = {action: 'enable_in_admin_console'}`（解法只有一个：让管理员开启，重试本请求不变）。**判据是 `=== true`**：缺键 = 不知道 = 不授权（前端 `v-if` 同口径，见 §4.14）| 否 |
| 409 | `file_exists`（#472 片 B，§4.14）| **上传的目标文件已存在**且本次没带 `overwrite=1`。`details = {path}`（相对牢笼根的路径，与 `GET /api/files/tree` 同口径）。**三个落点同一个码**：进 body 前的快速检查（`lstat`）、提交点 `link` 失败的竞态判据、以及 `overwrite=1` 时目标在传输期间**变成了目录**（`rename` 抛 `EISDIR`/`ENOTEMPTY`，`details.reason='target_is_dir'`——不映射就会变成 500，把「目标被占」报成服务端故障）——调用方不必区分，前端拿到它就是「问用户要不要覆盖」的时机（第三种的答案是「换名」）。⚠ 快速检查**不是** no-clobber 的依据（两步之间目标可被别人创建），真正的依据是提交点，见 §4.14 的 `link` 说明 | 否（要么覆盖要么换名）|
| 400 | `upload_interrupted`（#472 片 B，§4.14）| **上传在传输完成前中断**（客户端 `destroy()`、网络断、页面被切走 ⇒ 请求流 `aborted`/`error`/提前 `close`）。`retryable: **是**`（本表里少数几个「重试就行」的 400：内容从头重传即可，且服务端已把半截 temp 删掉，不会留下半个文件）。`details = {bytes}`（已落盘的字节数，只用于排查，不代表任何已提交的内容）| 是 |
| 429 | `rate_limited` | 限流（登录爆破、LLM 配额，见 §6.1） | 是（遵循 `Retry-After`） |
| 503 | `container_unreachable` | ⚠️ 仅 push 下发模式（待决策者确认）FDE 容器不可达（见 §6.3）；拉模型（终态）不返回此码 | 是 |
| 503 | `email_send_failed`（#449）| **验证码邮件没发出去**（SMTP 超时/拒绝/未配置口令解不开等，`details` 不带正文）。`retryable: true`：**`pending_token` 不作废**，用户点「重发」（§2.3b）即可，不必重输口令。**管理台测试发信（§4.12）用同一个码但回 `502`**：那是管理员手点的一次探活请求，没有「待决登录」可保留，`details` 只有 `{reason}` 摘要 | 是 |
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

### 1.5 请求体与 `Content-Type`（issue #236 第 2 条）

所有**读 JSON 体**的写方法端点（`POST` / `PUT` / `DELETE`，实现里统一走 `requireJson` + `readJsonBody`）遵守同一张表：

| 请求 | `Content-Type` | 结果 |
|---|---|---|
| 无 body（`Content-Length: 0`，或既无 CL 也无 `Transfer-Encoding`） | **未带** | **放行**（体按 `{}` 处理） |
| 无 body | `application/json`（可带 `; charset=…`） | 放行 |
| 无 body | 其它类型（`text/plain` 等，含显式空串） | `400 validation_failed`（「`Content-Type` 必须为 `application/json`」） |
| **有** body | `application/json`（可带参数） | 放行 |
| **有** body | 未带 / 其它类型 | `400 validation_failed`（同上） |
| 有 body（`Transfer-Encoding: chunked`） | 未带 | `400 validation_failed`（体在读完前不可知 ⇒ fail-closed） |

- **为什么放宽第一行**：`curl -X POST .../stop` 这类**空 body 的 POST** 不带 `Content-Type`，此前一律 `400`（前端总发 `body:'{}'`，所以 UI 无感；手工客户端/脚本按 REST 常识发空 body 就踩）。口径与直觉一致：**只校验「有 body 时必须是 json」**（issue #236 决策者倾向的 ①）。
- **不放宽的两格**：「显式声明了非 json」与「带体但没声明」仍 `400`——前者是调用方有意声明的类型，后者可能是表单提交，都不是本次要放行的形状。
- **`GET` / `HEAD` 与 SSE 不经过本闸**；`/api/internal/*`（容器 → portal）与 `/api/forward-auth` 也是同一套判据（它们**总是**带 json 体，行为不变）。
- ⚠ 本闸是**纯请求体形状**校验，与 §2.11 的跨站写防线（`cross_origin_forbidden`）是**两件独立的事**，后者在鉴权与 handler 之前执行，不受本节影响。

---

## 2. 认证

### 2.1 登录方式（P1）

**P1 用本地账号**：口令哈希 + TOTP 第二因素（规格 §7.1 本地通道的同一套机制；P1 骨架暂用 Node 内置 `crypto.scrypt`，目标 argon2id 按 §2.9.4 平滑迁移；env §4 ⚠️ 待决策者确认：OIDC provider 事实缺失，OIDC 接入延后到 P2，届时按规格 §7.1 走 JIT provisioning，角色来自 group claim）。

- **两步登录的适用范围（现状）**：**已注册 TOTP**（`users.totp_secret` 非 NULL/空串）的本地账号走两步（§2.2 → §2.3）；**未注册 TOTP**（`totp_secret` 为 NULL 或空串）的本地账号——**邮件通道启用时走邮箱验证码**（§2.2 → §2.3a/§2.3b，issue #449），**邮件通道未启用时口令直通建会话**（§2.2 直接返回 `authenticated`，没有第二步）——用户决策 2026-09-22，实现 d605015。**TOTP 是 opt-in**：现网账号都没注册 TOTP，所以第二因素实际由邮箱码这一层承担（前提是管理台把 `mail_settings` 配成 `transport='smtp'`，§2.3a）。规格 §7.1「强制 TOTP」是**设计目标**，此处为已落地的偏离：CLI 建号（§2.9.1/§2.9.2）与 `reset-totp` 一律下发种子，故经 CLI 创建的账号仍是强制两步；偏离只对「种子为空」的账号生效（原语义下第二步必然失败 = 账号永久锁死）。
- 第一个 admin 由部署 bootstrap 在本地建（规格 §7.1）；**TOTP 种子由 bootstrap 流程生成下发，不走公开 API**（P1 契约不含注册/自助找回端点）。
- OIDC 接入后登录入口变化（跳转 SSO），但 **cookie、session 语义、本文其余端点全部不变**——前端无需感知。

### 2.2 `POST /api/auth/login`

第一步：校验口令。响应按「第二因素选择规则」（下表）分五种：`totp_required`（进入 §2.3）、`email_code_required`（进入 §2.3a）、**`second_factor_choice`（#449 二选一：§2.3 与 §2.3a 两条任选其一都能过）**、`authenticated`（口令直通，直接建会话发 cookie）、或直接 `409 email_not_registered`。

#### 第二因素选择规则（issue #449，实现为纯函数 `login-email-code.js#chooseSecondFactor`）

按顺序取第一条命中的分支（**顺序本身就是契约**，别调换）。共**五分支**。

判据里的「TOTP 走不走得通」= **绑过密钥**（`users.totp_secret IS NOT NULL`，DTO 里的 `totp_enabled`）**且**
**管理员没关掉「允许用 TOTP 登录」**（`users.totp_login_enabled`，迁移 `0030`，默认 `true`）。
⚠ 这两件事在 2026-11-10 之前是**同一位**，于是「密钥留着、但登录只走邮箱验证码」在界面上根本表达不出来
（要嘛重绑、要嘛删密钥）。现在拆开：**关掉 `totp_login_enabled` 不清密钥**，随时可以再打开。

| # | TOTP 走不走得通（绑过 **且** 允许） | `users.mail_otp_enabled`（per-user 开关，迁移 0028）| `users.email` 非空 | 结果 | 说明 |
|---|---|---|---|---|---|
| ① | 是 | 是 | 是 | `200 status='second_factor_choice'` | **#449 新增**：TOTP **或** 邮箱验证码任一通过。**第一步不发信**（懒发信，feat-261110-01）：码的第一封由客户端切到邮箱档时调 §2.3b 发出。响应见下 |
| ② | 是 | — | — | `200 status='totp_required'` | 进入 §2.3。**含「开关开但没邮箱」**——绝不因为缺邮箱把已绑 TOTP 的人挡在门外 |
| ③ | 否 | 非 `true` | — | `200 status='authenticated'` | 口令直通（审计 `method='password_direct_no_second_factor'`，§2.2 末）。**含「绑过 TOTP 但管理员把两条都关了」**——管理台会红字警告，见 §2.2 末 |
| ④ | 否 | 是 | 是 | `200 status='email_code_required'` | 发一枚邮箱验证码（§2.3a），**此时尚未登录**。**含「绑过 TOTP 但只允许邮件码」**（密钥原样保留，登录不碰它）|
| ⑤ | 否 | 是 | 否 | `409 email_not_registered` | **绝不静默退回纯口令**；`message` 给出路「请联系管理员补录邮箱」 |

- ⚠ **① 必须排在 ② 之前**（写反就是本单要修的死开关）：已绑 TOTP 的账号打开 `mail_otp_enabled` 后，界面显示「已启用」而实际一封码都不发、也没有任何提示。

- 两个「允许」都是**按用户**的：`users.mail_otp_enabled`（迁移 0028，默认 `false`）与 `users.totp_login_enabled`（迁移 `0030`，默认 `true`）。管理员在用户编辑 → **二次验证** tab 里是两个**独立勾选框**（可同时勾、也可都不勾；都不勾 = 只剩口令，界面上有红字警告）。全局 `mail_settings.transport` 只是 SMTP 连接配置，**不再是功能闸**（2026-11-06 口径：否则「管理员开了开关、界面显示已启用、实际永远走口令」是必然的死光纤）。它只决定**信发不发得出去**：④ 发不出去 ⇒ `503 email_channel_unavailable`（唯一第二因素发不出去就不能进）；① 在**未启用 / 发信限流**这两种可预判的情况下降级成仅 TOTP（**不报错**，见下方响应与 §1.2），而「配了但当下发不出去」在第一步看不出来（懒发信不试发），推迟到 §2.3b 发第一封时才暴成 `503`。「读取失败 / 急停」的 fail-open 口径见 §2.3a 末尾。
- 未启用时的口令直通**不是无声的**：启动日志会打一条 `level:'warn'`（`[auth] email verification code disabled (mail settings unavailable or MAIL_TRANSPORT=disabled); accounts without TOTP log in with password only`），且成功登录审计的 `method` 写的是 `password_direct_no_second_factor`（不是笼统的 `password_direct`）——「这一层没做第二因素」在日志与审计里都能被查到。
- `auth.login_success` 的 `details.method` 是个**四值枚举**（运维拿它区分「走的哪条第二因素」）：`password_direct_no_second_factor`（口令直通）/ `totp`（TOTP 通过）/ `email_code`（邮箱码通过且**该账号没有** TOTP）/ **`email_code_alt`**（#449 新增：邮箱码通过、但**该账号同时有 TOTP** ⇒ 用户主动走了两条里较弱的那一条）。OR 语义让「第二因素强度 = 两者中较弱的」，这不是 bug（是决策者的选择），但**必须可审计**。

请求：

```json
{ "login": "alice", "password": "••••••••" }
```

响应 `200`（口令正确**且已注册 TOTP**，进入第二步；**此时尚未登录**）：

```json
{ "status": "totp_required", "pending_token": "pt_9f2c...", "expires_in": 120 }
```

| 字段 | 说明 |
|---|---|
| `pending_token` | 一次性、短期（默认 120s，`PENDING_TOKEN_TTL_SECONDS` 可配）有效的待决令牌，仅可用于 `/api/auth/login/totp`；服务端只存其 `sha256` |

> 本响应**不带** `password_change_required`（#255）：`totp_required` 时尚未登录、不发 cookie，谈不上「受限会话」；这一位在第二步的成功响应里给（§2.3）。

响应 `200`（**未注册 TOTP 的账号**：口令直通，**此时已登录**）：

```json
{
  "status": "authenticated",
  "password_change_required": true,
  "user": { "id": "u_alice", "login": "alice", "display_name": "Alice", "role": "fde", "fde_name": "alice" }
}
```

同时下发 session cookie（属性见 §2.5）；**无 `pending_token`**，无需（也无法）再调 `/api/auth/login/totp`。

响应 `200`（**口令正确、未注册 TOTP、邮件通道已启用、账号有邮箱**：进入邮箱验证码第二步；**此时尚未登录**）：

```json
{ "status": "email_code_required", "pending_token": "pt_9f2c...", "expires_in": 600, "email_hint": "a***@e***.com", "email_code_ttl_seconds": 600 }
```

| 字段 | 说明 |
|---|---|
| `pending_token` | 一次性待决令牌，仅可用于 §2.3a/§2.3b；服务端只存其 `sha256`（`login_pending.token_hash`） |
| `expires_in` | 该令牌的实际有效期（秒）= `max(PENDING_TOKEN_TTL_SECONDS, EMAIL_CODE_TTL_SECONDS)`，默认 `600`。**为什么不直接用 120**：码的有效期是 600s，令牌 120s 就会让「码还没过期、令牌先死」成为常态，这个字段也就成了谎 |
| `email_hint` | 脱敏收件人：本地部分保留首字符 + `***`；域名首段保留首字符 + `***`，TLD 及后续标签原样 ⇒ `alice@example.com` → `a***@e***.com`。**只用于「发到哪个邮箱了」的确认**，不含完整地址 |
| `email_code_ttl_seconds` | **码**的有效期（秒）= `EMAIL_CODE_TTL_SECONDS`（默认 `600`）。登录页据此渲染「验证码 N 分钟内有效」——**客户端不得写死 10 分钟**，配置一改就是一句谎；与 `expires_in`（**令牌**有效期）不是同一个数，不要互相顶替 |

> 本响应同样**不带** `password_change_required`（#255）：还没发 cookie，谈不上受限会话；这一位在 §2.3a 的成功响应里给。

响应 `200`（**#449 二选一：已注册 TOTP + 开关开 + 有邮箱**，进入可选的第二步；**此时尚未登录**）：

```json
{
  "status": "second_factor_choice",
  "pending_token": "pt_9f2c...",
  "expires_in": 600,
  "methods": ["totp", "email_code"],
  "email_hint": "a***@e***.com",
  "email_deferred": true,
  "email_code_ttl_seconds": 600
}
```

> **懒发信（工单 feat-261110-01，2026-11-10）**：本分支**第一步一封邮件都不发**。
> 旧行为是「口令一通过就发信」，于是每次登录都寄一封没人要的验证码（用户两天收 7 封）。
> 现在码子的**第一封**由客户端**切到邮箱验证码那一档**时调 §2.3b 的 `resend` 端点发出 ——
> 该端点本来就支持「该 pending 下零码行 ⇒ 当首次发信、不套 60s 冷却」（§2.3b），
> 所以懒发信**没有新端点**，也不改 `login-email-code.js` 一个函数。
> 走 TOTP 的人（默认档）从此**一封也不收**。

| 字段 | 说明 |
|---|---|
| `methods` | 本次**真的能走**的通道。两条都可用 ⇒ `["totp", "email_code"]`；邮件不可用 ⇒ `["totp"]`。**客户端一律以本字段为准**，不要自己补邮箱入口 |
| `email_deferred` | `true` = 邮箱这条**可用，但码还没发**（懒发信的明示）。此时响应里**没有** `email_sent` 键：「还没发」用**缺席**表达，不许写成 `email_sent: false`——后者的含义是「**不可用**」（下一行），两者混成一个客户端就会把邮箱档在第一步剥掉（正是本单修的「二选一在界面上不存在」）。用户切到邮箱档时客户端调 §2.3b 发第一封 |
| `email_sent` | **仅在邮件通道不可用时出现**（`false`）：库里**没有**码行且当下也发不出去，本次只能走 TOTP。可用（懒发信）那条**不带**这个键 |
| `email_unavailable` | 仅在邮件通道不可用时出现（`true`），与 `email_sent:false` / `methods:["totp"]` 同时出现；可附 `notice`（人可读的一句说明）|
| `pending_token` / `expires_in` / `email_hint` / `email_code_ttl_seconds` | 与 §2.2 `email_code_required` 逐字同口径：`expires_in = max(PENDING_TOKEN_TTL_SECONDS, EMAIL_CODE_TTL_SECONDS)`（默认 600），`email_code_ttl_seconds` 是**码**的 TTL；两路共用这一枚令牌，取短的那头会让邮件码比 TOTP 窗口还短。降级响应（`methods:["totp"]`）也带 `email_code_ttl_seconds`（字段恒在，省得客户端两套形状） |

三条硬口径：

1. **邮件绝不能挡住 TOTP**。第一步不试发，只做两件**非消费型**预检：`mailer.enabled !== true`（SMTP 未配置 /
   急停 / 读配置失败）与 `email:<ip>` 的发信限流不允许（`check()` 不计数，真正计数仍在 §2.3b 的
   `recordFailure`）。两者任一命中 ⇒ 不是 `503`、不是 `500`，而是 `200` + `methods: ["totp"]` +
   `email_sent: false` + `email_unavailable: true`（+ `notice`）。TOTP 是离线可用的强因素，让它输于
   SMTP 抖动比本单之前更糟。
   ```json
   { "status": "second_factor_choice", "pending_token": "pt_9f2c...", "expires_in": 600,
     "methods": ["totp"], "email_hint": "a***@e***.com", "email_sent": false, "email_unavailable": true,
     "notice": "邮件通道当前不可用，本次仅可用验证器应用（TOTP）" }
   ```
   ⚠ **懒发信的已知代价**：「SMTP 配了但当下发不出去」（上游抖动、凭据失效）**在第一步看不出来**
   ——不试发就无从知道，所以那条照旧给两条通道 + `email_deferred`，失败推迟到用户切到邮箱档
   发第一封时，以 §2.3b 的 `503 email_send_failed` 暴露（`pending_token` 不作废，客户端切回
   「重新发送」路径即可，TOTP 全程不受影响）。这是把「每次登录都寄一封」换成「切过去才知道发不出去」
   的自觉取舍，不是回归。
2. **不造新的令牌类型**：这枚 `pending_token` 能被 §2.3（`/login/totp`）与 §2.3a（`/login/email-code`）**两边消费**。谁先成功谁建会话；`login_pending` 是单次消费，所以成功后另一条路自然失效（再调 ⇒ `401 pending_expired`）。
3. 审计能区分走了哪条：TOTP 成功 ⇒ `method='totp'`；邮箱码成功且**该账号有 TOTP** ⇒ `method='email_code_alt'`；邮箱码成功且无 TOTP（④ 分支）⇒ `method='email_code'`（§2.2 末的枚举）。**懒发信不新增任何审计动作**：第一步什么都没尝试过就**不写**发信审计（写失败审计是假账）；`auth.email_code_sent` / `auth.email_code_failed` 改由 §2.3a 与 §2.3b 产生（§2.3a 末尾的审计表）。

| 字段 | 说明 |
|---|---|
| `password_change_required`（#255，工单 `feat-261013-03`，纯 additive）| `true` ⇒ 本次下发的会话是**受限会话**（`users.must_change_password=true`：口令由管理员开户/重置时代设，还没经过本人之手），除 §2.11a 放行清单外的 `/api/*` 一律 `403 password_change_required`（§1.2）。**前端应在拿到 cookie 的那一刻就把用户弹到改密屏**，而不是先碰一个 403 再猜。`false` 也必须**出现**（恒为布尔，不靠缺省省掉）。两个**发会话**的分支都有（本分支与 §2.3 第二步）；`totp_required` 中间响应与所有失败响应（401）**都不带**——还没会话的人谈不上受限，发了反而泄露「这个账号欠一次改密」 |

请求约束（S3）：`Content-Type` 必须为 `application/json`（否则 `400 validation_failed`）；`login` ≤ 128、`password` ≤ 256 字符（否则 `400 validation_failed`）；请求体超过上限（默认 64KiB，`Content-Length` 或流式字节）→ `413 payload_too_large`（标准错误信封）。

错误：

| HTTP | code | 场景 |
|---|---|---|
| 401 | `invalid_credentials` | 用户名或口令错误（**不区分是哪种**，防用户枚举） |
| 409 | `email_not_registered` | 口令正确、未注册 TOTP、邮件通道启用，但该账号**没有邮箱**（§1.2 / §2.2 选择规则第⑤分支）。**不会退回纯口令** |
| 429 | `rate_limited` | 同一 login / IP 连续失败触发限流；响应带 `Retry-After` 头（秒） |
| 503 | `email_send_failed` | 第④分支发信失败（SMTP 超时/拒绝/配置读不到）。`retryable: true`，`error.details` = `{pending_token, expires_in, email_hint, email_code_ttl_seconds}`（第一次响应就失败，客户端还没拿到过令牌，不带它就无法「点重试」；`email_code_ttl_seconds` 让收下令牌直接进第二步的客户端仍能写出有效期）；`pending_token` 不作废，且**库里没有码行** ⇒ 立刻调 §2.3b 重发即可（不受 60s 冷却约束）。⚠ **#449 二选一（① 分支）不适用**：那里发信失败不是错，只降级成仅 TOTP（`200`）|
| 503 | `email_channel_unavailable` | 第④分支：`mail_otp_enabled` 开着但邮件通道整体不可用（未配置 / 急停 / 读不出）。**绝不静默降级到口令**（否则用户以为过了第二因素，其实只过了口令）。同样**不适用于 ① 分支**（那里降级成仅 TOTP，不报错）|

### 2.3 `POST /api/auth/login/totp`

第二步：校验 TOTP，成功后建立会话。

> **#449 二选一**：本端点同样接受 §2.2 ① `second_factor_choice` 签发的 `pending_token`（与 §2.3a/§2.3b 共用同一枚，单次消费）。走本端点成功一律记 `method='totp'`（现状值不改，不论令牌出自 ② 还是 ①）。

请求：

```json
{ "pending_token": "pt_9f2c...", "code": "123456" }
```

响应 `200`：

```json
{
  "password_change_required": true,
  "user": {
    "id": "u_alice",
    "login": "alice",
    "display_name": "Alice",
    "role": "fde",
    "fde_name": "alice"
  }
}
```

同时下发 session cookie（属性见 §2.5）。`password_change_required`（#255）与 §2.2 直通分支同一口径——**第二步才是本分支真正发会话的地方**，所以受限旗标必须在这里带出去（否则注册了 TOTP 的受限账号只能靠「第一个请求返 403」发现自己要改密）；`user` 的键集与 §2.2 逐字相同，**不因这次增字段而变**。

错误：

| HTTP | code | 场景 |
|---|---|---|
| 401 | `totp_invalid` | TOTP 码错误 |
| 401 | `pending_expired` | `pending_token` 过期/不存在/已使用 → 重新走第一步 |
| 429 | `rate_limited` | TOTP 连续失败限流（带 `Retry-After`） |

### 2.3a `POST /api/auth/login/email-code`（issue #449：邮箱验证码第二步）

第二步的另一条路：**未注册 TOTP 且开关打开**的账号（§2.2 第二因素选择规则第④分支）在这里交验证码，成功后建立会话。**本端点同样接受 ① `second_factor_choice` 签发的 `pending_token`**（#449 二选一：两路共用同一枚令牌、单次消费 ⇒ 谁先成功谁建会话，另一条自然失效）；走这条路且**该账号有 TOTP** 时，审计 `method` 记 `email_code_alt`。

请求：

```json
{ "pending_token": "pt_9f2c...", "code": "123456" }
```

响应 `200`（**与 §2.3 逐字同口径**）：

```json
{
  "password_change_required": true,
  "user": { "id": "u_alice", "login": "alice", "display_name": "Alice", "role": "fde", "fde_name": "alice" }
}
```

同时下发 session cookie（属性见 §2.5）。`password_change_required`（#255）**必须出现且恒为布尔**——与 §2.3 同一理由（第二步才是真正发会话的地方）；`user` 的键集与 §2.3 完全相同。

验证码与尝试上限（决策 6，全部可配）：

| 项 | 默认 | env |
|---|---|---|
| 码形态 | 6 位数字（`crypto.randomInt(0, 1_000_000)` 左补零） | — |
| 码有效期 | 600s | `EMAIL_CODE_TTL_SECONDS` |
| 单 `pending_token` 最多校验尝试 | 5 次 | `EMAIL_CODE_MAX_ATTEMPTS` |
| 重发冷却 | 60s | `EMAIL_CODE_RESEND_COOLDOWN_SECONDS` |
| 单 `pending_token` 最多重发 | 3 次 | `EMAIL_CODE_MAX_RESENDS` |

- **邮件本身是双语的**（2026-11-10 用户要求）：主题 `FDE Station 登录验证码 / Sign-in verification code`，
  正文中文一行 + 英文一行（两种语言各写一次同一个码与同一个有效期），末尾两句安全提示同样双语。
  理由：收件人未必读得懂中文，而验证码邮件是登录的**唯一**凭据来源——看不懂就等于收不到。
  有效期分钟数由 `EMAIL_CODE_TTL_SECONDS` 现算（默认 600s ⇒ 10 分钟），正文与响应字段 `email_code_ttl_seconds` 同源。
- **只存 `sha256(码)`**（`login_email_codes.code_hash`），绝不存明文；成功校验是一条原子 `UPDATE … WHERE consumed_at IS NULL AND expires_at > now AND code_hash = $h AND attempts < max_attempts … RETURNING id` ⇒ 并发/重放至多一次成功。
- **码错不烧 `pending_token`**：只把该码的 `attempts + 1`（达到上限时同时作废该码），用户还能接着试/重发；`pending_token` 本身只在成功时被消费。
- **码行在「发信成功之后」才落库**（评审返修 ①）：先 `send()`、`ok` 才 `INSERT login_email_codes`。发信失败时库里**一条码行都没有**，所以失败重试的冷却起算点不会由「一封用户没收到的信」产生（否则 503 之后立刻重发必撞 60s 冷却 ⇒ 429）。
- **限流（两把闸，各自独立）**：
  * **校验失败**按「账户 + IP」计（`emailcode:<userId>:<ip>`，默认 10 次 / 15 分钟窗口，超限 `429 rate_limited` + `Retry-After`）。换新 `pending_token` 不重置计数，防 6 位码爆破；
  * **发信频率**按 IP 计（`email:<ip>`，默认 **20 次 / 15 分钟**窗口，共享出口 IP 的误伤空间）——**§2.2 第④分支第一步的初次发信与 §2.3b 的重发（含 ① 懒发信的第一封）共用同一把闸**（每次成功发信记一次），否则持有效口令的人可以反复调第一步把邮箱刷爆。⚠ ① 分支的**第一步不再计入这把闸**（feat-261110-01：它已经不发信了），它只做一次**非消费型** `check()` 预检来决定要不要摆出邮箱那条 ⇒ 反复走第一步的① 账号既刷不爆邮箱，也烧不掉配额。

错误：

| HTTP | code | 场景 |
|---|---|---|
| 400 | `validation_failed` | `pending_token` / `code` 缺失 |
| 401 | `email_code_invalid` | 码错 / 码不存在 / 码已过期 / 尝试次数用尽——**同一个码**（不区分，防探测）。`too_many_attempts` 的 `message` 会说明「请重新登录获取新验证码」 |
| 401 | `pending_expired` | `pending_token` 过期/不存在/**已消费**（含「同一枚码重放」：成功那次已经把 pending 消费掉了）→ 重新走第一步 |
| 429 | `rate_limited` | 上述账户级失败限流（带 `Retry-After`） |

**SMTP 配置从哪来（决策者 2026-11-04/05 定稿）**：`mail_settings` 单行表（管理台维护，`GET/PUT` 留给下一片），运行时由 `portal/src/mail-provider.js` 读取并 60s 缓存。口令是**明文列** `smtp_password`——目标是内网 email relay，口令非高价值，与既有 `git_hosts.admin_key`（迁移 0011）同一口径；若将来换成公网 SMTP 再上加密列。**API / 审计 / 日志永不返回口令明文**（管理台只给 `hasPassword` 布尔，下一片）。

**fail-open 口径（D3b）**：`mail_settings` 读不到（迁移没跑 / DB 抖动）或配置不完整（配了一半）⇒ 邮件通道按**未启用**处理（`level:'warn'` 一条），登录退回 §2.2 第③分支（纯口令 + 审计 `password_direct_no_second_factor`）。**「未配置」「`transport='disabled'`」「运维急停」是正常状态，不告警**（评审返修 ④：否则 60s 缓存每过期一次就刷一行噪声）。**绝不 fail-closed 到「所有人登不进」**。运维急停用 `MAIL_TRANSPORT=disabled`：为真时无论 DB 怎么配都不发信（不读库、不看缓存）。

审计（`audit_log`）：

| action | 时机 | `details` |
|---|---|---|
| `auth.email_code_sent` | 码发出去了 | `{login, email_hint, code_hash_prefix, expires_at, resend_count?, at}`——`code_hash_prefix` 是 `sha256(码)` 的**前 12 位**；**绝无明文码** |
| `auth.email_code_failed` | 发信失败（§2.2 第④分支的 `503`；§2.3b 的重发失败；**或** ① 二选一分支的降级，此时不报错只 `200`，并额外带 `second_factor_choice: true`）| `{login, reason, at}`——`reason` 是 SMTP 错误的摘要（不含正文/口令）。① 分支的降级不是「发了一封没成功」而是**当下判定发不出去**，所以 `reason` 是通道事实：`email_channel_disabled`（SMTP 未启用 / 急停）或 `rate_limited`（`email:<ip>` 预检不允许）。懒发信的可用那条**不写任何发信审计** |
| `auth.email_code_verified` | 校验通过并发了会话 | `{login, method, at}`，`method` = `email_code`（该账号无 TOTP，§2.2 第④分支）或 **`email_code_alt`**（该账号**同时有 TOTP**，走的是 ① 分支里较弱的那一条，#449）；同时另有一条 `auth.login_success`，**两处 `method` 同值**（一次登录一个口径）|
| `auth.email_code_invalid` | ——**不写** | 码错不落审计：这是可重试的日常动作，写了只会被爆破尝试刷成噪声；失败次数由限流器持有 |

### 2.3b `POST /api/auth/login/email-code/resend`（issue #449：重发验证码）

**本端点同样接受 ① `second_factor_choice` 签发的 `pending_token`**（#449 二选一），并且从工单 feat-261110-01 起**兼任首次发信**：二选一分支第一步不发信，客户端在用户**切到邮箱验证码那一档**时调本端点发出第一封 —— 库里零码行 ⇒ `recordResend` 的「零行 = 首次发信」语义，**不套 60s 冷却**（懒发信不需要新端点，也不改 `login-email-code.js`）。已经发过就不因为反复切档而反复发信（客户端拿 `emailSent` 防重复）；用户主动点「重发」同样走本端点，那时才是语义上的重发（作废旧码 + 换新码 + 起 60s 冷却）。

请求：

```json
{ "pending_token": "pt_9f2c..." }
```

响应 `200`：

```json
{ "expires_in": 600, "resend_after": 60, "email_code_ttl_seconds": 600 }
```

| 字段 | 说明 |
|---|---|
| `expires_in` | 新码的有效期（秒，`EMAIL_CODE_TTL_SECONDS`） |
| `resend_after` | 下一次允许重发的冷却秒数（`EMAIL_CODE_RESEND_COOLDOWN_SECONDS`） |
| `email_code_ttl_seconds` | 与 `expires_in` **同值**，只是名字与 §2.2 两个登录响应统一：登录页的「验证码 N 分钟内有效」只认这一个字段名，不必按端点分两套读法 |

- **重发必须换新码并作废旧码**：先发信、成功后才插新行（`resend_count = 上一条 + 1`），再把同一 `pending_token` 下其余未消费行 `consumed_at = now`。校验只认「最新一条未消费」，所以旧码从这一刻起必然被拒。**发信失败时既不插新码、也不作废旧码**（用户手上的旧码仍然有效，且可立刻再试）。
- **按 IP 计发信频率**（`email:<ip>`，默认 20 次 / 15 分钟窗口，与 §2.3a 的初次发信**共用同一把闸**）：被当成邮件放大器时最先撞这条。
- **该 `pending_token` 下一条码行都没有 ⇒ 当「首次发信的重试」处理**：不查冷却、`resend_count` 从 0 起算，直接发新码（这是 §2.2 的 `503 email_send_failed` 之后「点重试」能立刻成功的机制）。`pending_token` 的有效性仍由 `findPendingUser` 判（无效 ⇒ `401 pending_expired`）。
- 发信失败与 §2.3a 同口径：`503 email_send_failed`（`retryable: true`），`pending_token` 不作废。

错误：

| HTTP | code | 场景 |
|---|---|---|
| 400 | `validation_failed` | `pending_token` 缺失 |
| 401 | `pending_expired` | `pending_token` 过期/不存在/已消费 |
| 409 | `email_not_registered` | 该账号没有邮箱（第二因素做不成，找管理员补录） |
| 429 | `rate_limited` | ① 冷却中（`Retry-After` = 剩余冷却秒数）；② 重发次数用尽（`Retry-After` 仍给出，但解法是重走第一步）；③ 按 IP 的发信频率超限（20 次 / 15 分钟，与初次发信共用） |
| 503 | `email_send_failed` | SMTP 发不出去（`retryable: true`，可原样再试） |

> §2.2 的 `503 email_send_failed` 是**第一次发信**就失败（此时客户端还没拿到过 `pending_token`），所以它的
> `error.details` 里带上 `{pending_token, expires_in, email_hint, email_code_ttl_seconds}`——否则「pending 不作废、
> 点重试即可」在协议上不成立（用户只能回去重输口令）。§2.3b 的 503 不带（客户端本来就有 token）。

### 2.4 `POST /api/auth/logout`

- 响应 `204`，删除服务端 `login_sessions` 记录，并下发过期 cookie 清除客户端副本。
- 未登录调用返回 `401 unauthorized`。
- **#429（方案 B「凭证血缘」）：登出同时回收本次登录会话签发的预览凭证。**同一事务形状的
  单语句 CTE：吊销 `login_sessions` 行 + 按 `preview_grants.login_session_id` 血缘把**仍
  `state='active'`** 的 ticket 与派生 session 一并置 `revoked`（只撤 `active`、`revoked_at` 用
  `COALESCE`——与 #252 撤 grant 口径同形；`used` 是历史事实不动）。登出后旧预览 cookie 打
  forwardAuth 得 `401 preview_session_invalid`，重新从 portal 签票即恢复。
  - **为什么回收落在登出时刻而不是 forwardAuth**：登录 cookie 是 host-only 于 `station.<base>` 的
    （§2.5 / issue #6），物理上到不了预览 host，forwardAuth 请求里没有可判的登录主体
    （§2.11a 原话「门在它身上没有可判的主体」）；回收只能发生在 portal 同时握着两套凭证语境的入口。
    forwardAuth 保持每请求零新增查表。
  - **多设备语义**：血缘按 `login_session_id` 命中，不按 `user_id` 连坐——A 在设备 1 登出，
    设备 2 的登录会话所签预览票不受影响。
  - **发布窗口**：`login_session_id` 可空（迁移 `0025`，不回填）。血缘缺失的存量活跃凭证登出救不了，
    最迟 `expires_at`（session ≤15min 滚动）自然到期，一次性窗口、无数据修复。
  - 其它回收路径不变：用户 `disabled` 撤销该用户**全部** active grant（§2.9.3，含代签），
    allocation `released` 撤销该 allocation 上全部 active（§2.8）；登出这条是**按血缘**的窄口径。

### 2.5 session cookie 属性

**P1 本地登录下发的是 host-only 会话 cookie**——只对 `station.<BASE_DOMAIN>` 发送，**绝不覆盖预览泛域名**（issue #6：旧设计用父域 `Domain=.erix.vip` 会让预览域名也收到 portal 会话 cookie，属安全缺陷，已作废）。

| 属性 | 取值（生产 / HTTPS） | 理由 / 来源 |
|---|---|---|
| 名称 | `__Host-fde_session` | `__Host-` 前缀强制浏览器要求 cookie 具备 `Secure` + `Path=/` + 无 `Domain`（host-only），防止子域继承与覆盖 |
| `Domain` | **不设**（host-only） | 只发往 `station.<BASE_DOMAIN>`；预览 host 与任意子域都不会收到（issue #6） |
| `Path` | `/` | `__Host-` 前缀要求 |
| `HttpOnly` | 是 | 防 XSS 窃取 |
| `Secure` | 是 | `__Host-` 前缀要求；生产/自签 HTTPS 恒为 `Secure` |
| `SameSite` | `Lax` | 门户为顶级站点，`Lax` 覆盖顶级导航与同站子资源；**预览访问不再依赖本 cookie**（见 §2.8：预览走一次性 ticket + host-only 预览 cookie），故不再受 iframe 约束，也不得再以「预览需要」为由放宽为父域 cookie。**注（#234）：`Lax` 不是本站唯一的跨站防线**，服务端另有一道 Origin / `Sec-Fetch-Site` 同源校验（§2.11），两者叠加才构成完整防线；cookie 属性本身本单未改。**注 2（#234 返修）：`SameSite` 与 `Sec-Fetch-Site` 判的都是注册域**，而 portal 与预览 host 同坐 `erix.vip` ⇒ 预览 host 的写请求**会带上本 cookie**（Lax 不挡同站）且 SFS 只报 `same-site`，因此 §2.11 的判据 b **不得因 `same-site` 直接放行**（否则本站最现实的 CSRF 形状会绕过防线）|
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
    "auth_source": "local",
    "must_change_password": true,
    "file_upload_enabled": false
  }
}
```

| 字段 | 说明 |
|---|---|
| `role` | `fde` \| `admin`。P1 本地账号在本地表维护；OIDC 接入后来自 group claim（规格 §7.1，⚠️ 待决策者确认） |
| `fde_name` | 该用户的 FDE 标识（= 容器名 `fde-<name>` 的 `<name>`、预览域名首段），无容器时为 `null` |
| `auth_source` | `local` \| `oidc`（P1 恒为 `local`） |
| `must_change_password`（#255，纯 additive）| 当前会话是否**受限**（与 §2.2 登录响应的 `password_change_required` 同源同值，只是载体不同）。本端点在 §2.11a 的放行清单里，因此它是 **SPA 刷新后重建改密屏的唯一数据源**——挡住它，前端就只能看到一片 403 而不知道该把用户送去哪儿 |
| `file_upload_enabled`（#472 片 A，纯 additive）| 该用户能不能用上传端点（`users.file_upload_enabled`，迁移 `0029`，`NOT NULL DEFAULT false`；**上传端点本体是片 B**，届时落在 §4.14）。服务端恒给**布尔**（库里给 `'f'` / `NULL` 等形状也收成 `false`），前端判据一律 `=== true`。**它只在这个 user DTO 里**，不在登录响应顶层（顶层那个位置是 `mail_otp_enabled`，属宿主判定输入）|

**四条 user DTO 路径键集一致（#472 片 A，不是巧合而是约定）**：`POST /api/auth/login`（口令直通）、`POST /api/auth/login/totp`、邮箱码第二步、以及本端点，四处下发的 `user` 对象由**同一个构造函数**产出（`portal/src/auth.js` 的 `toSessionUser`）。原因：SPA 的 `login()` / `submitEmailCode()` 把**登录响应里的 `user`** 直接存进 store，且**不重拉 `/api/me`** ⇒ 只给本端点补字段会让新键在「刚登录的那整个会话」里不存在（按钮不出现，直到整页刷新）。唯一允许的额外键是本端点的 `must_change_password`（**会话态**，不属用户态），由 §2.11a 的受限会话门消费。

### 2.6a `POST /api/me/password`（#255：本人自助改密，受限会话的出口）

受限会话（§2.11a）的唯一出口；但**不要求**先处于受限状态——任何已认证用户都能用它换口令。

请求：

```json
{ "current_password": "管理员代设的那一枚", "new_password": "本人自己选的", "confirm_password": "本人自己选的（可省）" }
```

| 请求字段 | 必填 | 说明 |
|---|---|---|
| `current_password` | 是 | 当前生效的那一枚；不对 ⇒ `401 invalid_credentials`（不新造码，理由见下「错误」）|
| `new_password` | 是 | 本人选的新口令；不合规或与当前相同 ⇒ `400 validation_failed` + `details.field='new_password'` |
| `confirm_password`（#255 收尾，纯 additive）| **否** | **客户端一致性校验**：服务端不拿它参与凭据判定，只做一件事——**带了就必须等于 `new_password`**，否则 `400 validation_failed` + `details.field='confirm_password'`。**为什么保留**：改密表单多一格「确认新口令」是防拼写错误把人锁在门外（设完自己登不上）的常规体验，服务端要能接住它，而不是继续当未知键忽略——忽略的后果是「两次是否一致」只在前端判，绕过前端的调用可以把两个不同的新口令发上去照样成功。**为什么不做成必填**：这一节此前只定义了两个字段，已经有绕过前端的调用方（脚本 / 集成测试）在发两个键，变成必填就是把它们当场打挂；⇒ **没带 ⇒ 行为与以前一字不差**（也不要求必填后补默认值） |
> **与前端 ①/② 的协调口径**：前端表单在提交前本地就拦掉「两格不一致」（`onSubmit()` 不发请求），所以**正常路径看不到这个 400**；真收到时前端按 `details.field='confirm_password'` 把红标落到「确认新口令」那一格（映射表 `portal/frontend/src/lib/forcePasswordErrors.ts`，用例 `forcePasswordErrors.spec.ts`）。

响应 `200`：

```json
{ "ok": true, "password_change_required": false, "sessions_revoked": 1 }
```

| 字段 | 说明 |
|---|---|
| `password_change_required` | 固定 `false`：改完即清 `users.must_change_password` ⇒ 受限门**当场解除**（无需重新登录）|
| `sessions_revoked` | 本次被吊销的**其它**会话条数（口径见下「会话语义」）|

**会话语义（与管理员重置的关键差别，本单最容易写错的一处）**：

| 动作 | `users.must_change_password` | `login_sessions` |
|---|---|---|
| `POST /api/me/password`（本人，本节）| → `false` | **保留当前会话**（SQL 里写死 `id <> 当前会话`），只吊销该用户**其它**活跃会话 |
| `POST /api/admin/users/:id/reset-password`（管理员，§12）| → `true` | **全量吊销**——管理员知道旧口令 ⇒ 不留任何旧会话 |

照抄管理员那条的全量吊销会把人当场踢下线：旗标刚清却要重新登录，而门此时已经放行 ⇒ 用户只看到「登录又过期了」，体感是「改密失败」。反向照抄（管理员重置也保留当前会话）会把管理员自己那个「拿着旧口令的会话」留在场上，是更糟的方向。

**实现口径**：验当前口令复用 `auth.verifyPassword`（校验 scrypt 自描述哈希的那把尺子，不再写第二套判据）；「换哈希 + 清旗标 + 吊销其它会话」在**单条 CTE 语句**里原子完成，不存在「哈希已换但会话没吊销」的中间态。

错误（**不新造码**）：

| HTTP | code | 场景 |
|---|---|---|
| 401 | `unauthorized` | 未登录 / 会话失效 |
| 401 | `invalid_credentials` | `current_password` 不对（与登录失败同一个码：同一主体、同一凭据、同一失败原因；新造一个码只会多一条前端分支，并额外泄露「会话有效但口令错」这个此前不存在的事实）|
| 400 | `validation_failed` | 新口令缺失 / 空 / 超上限，或**与当前口令相同**；或**带了 `confirm_password` 且它不等于 `new_password`**（没带就不参与这一条）；一律带 `details.field`（`new_password`、`current_password` 或 `confirm_password`）。**顺序**：旧口令校验**失败时一律 `401`**，不因带不带 / 对不对 `confirm_password` 而改变（否则一个还没通过旧口令校验的人就能拿这条新规则探出口令信息），一致性校验只在过了旧口令校验**之后**才报 |
| 405 | `method_not_allowed` | 非 `POST`。本端点在 §2.11a 清单里**不限方法**，正是为了让这个 405 不被门改写成 403 |
| 429 | `rate_limited` | 当前口令被连续猜错（复用登录限流器，key 前缀 `password:`，与 `login:` 命名空间互不污染；防「会话 cookie 被偷后爆破当前口令」），带 `Retry-After` |
| 503 | `kdf_busy` | scrypt 并发闸满（一次请求跑两次 scrypt：验旧 + 铸新），带 `Retry-After` |

其它口径：`Content-Type` 必须 `application/json`（否则 `400 validation_failed`）；形状校验在限流与 scrypt **之前**（畸形请求不消耗 KDF 配额）；口令策略沿用 §2.9.4 现状（**无最小长度**，本单不引入）。`confirm_password` 是例外：它比的是两个自报值，**不单独跑形状校验**（等于 `new_password` 就必然合法），且落在旧口令校验之后。审计恰一条 `audit_log.action='user.password_changed'`（`actor_id` = 本人、`target` = login、`details` = `{login, self_service: true, sessions_revoked}`）：**口令明文与哈希绝不入库**（`confirm_password` 也不入库，details 不因此新增字段）；失败路径不写这条（否则爆破会把审计刷成噪声）。

### 2.7 `GET /api/forward-auth`（Traefik 回调，非浏览器 API）

Traefik 对 `<FDE_WILDCARD_HOST>`（`*.fde.<BASE_DOMAIN>`）的每个请求先调本端点（规格 §6.4）。**这是状态化授权：按「预览 token 的哈希」查 `preview_grants` 库，解析身份，再做 exposure 判定——不得解析 cookie 的 `sub`**（旧 `cookie.sub` 口径作废；session token 是不透明令牌，见 §2.5）。注意：**本端点不查 `login_sessions`**——portal 自身会话的哈希校验（登录态）才查 `login_sessions`，而 portal session cookie 是 host-only、不会到预览域（见下）。

> **不受 #255 受限会话门管辖（必须放行，否则整片预览挂）**：本端点在 §2.11a 的放行清单里。两个独立理由：① `routes.js` 的 `authRequestHeaders` 白名单带 `Cookie`，浏览器侧的 cookie 会原样进这条回调——生产形态下进来的是 host-only 的**预览** cookie，而一旦 portal 与预览共享 cookie 作用域（同一 host 的部署形态、以及全部集成测试），进来的就是那枚**登录** cookie，门会看到一个看起来「已认证」的请求；② 它的语义是「这片预览该不该放行」，与「本人是否欠一次改密」毫无关系，被门挡成 `403 password_change_required` 时 **Traefik 只会把它当成一次认证失败** ⇒ 该用户名下 `*.fde.<base>` 的**全部**预览端口一起挂掉。另外本端点压根不查 `login_sessions`，门在它身上连可判的主体都没有。

**预览访问分两种凭证（互斥，按优先级取其一）**：

1. **一次性 ticket**（bootstrap）：portal 打开预览时经 §2.8 签发，随预览 URL 的 `?preview_ticket=<t>` 传入，**单次有效**，用于换取 host-only 预览 cookie。
2. **host-only 预览 cookie**（steady-state）：`__Host-fde_preview`，仅对当前预览 host 发送，iframe 内子资源复用。

**portal session cookie（`__Host-fde_session`）与本端点无关**：它是 host-only，浏览器**不会**把它发到 `*.fde.<BASE_DOMAIN>`；forwardAuth **一律忽略**任何碰巧出现的 portal session cookie，也**不把任何 cookie 透传给预览上游**（上游 dev server 永不接收 portal session cookie）。

请求头（**由 Traefik 覆盖生成，不得信任客户端自报**，见 topology.md §5.2 / `X-Forwarded-*` 信任边界）：

| 头 | 用途 |
|---|---|
| `X-Forwarded-Host` | 形如 `<fde>-p-<portLabel>.<BASE_DOMAIN>`（伞域口径，#57；#246 号池端口 5 位 ⇒ 示例 `eric-p-22000.fde.erix.vip`，dev 带端口后缀 `:8090`）；Traefik 以真实 `Host` 覆盖。portal 查表前**剥端口 + 小写**（唯一实现 `preview.normalizeHostHeader`），302 `Location` 仍保留原始 Host（含端口） |
| `X-Forwarded-Uri` / `X-Forwarded-Method` | 从 `X-Forwarded-Uri` 解析 `preview_ticket` 查询参数；方法用于审计 |
| `Cookie` | 只看 `__Host-fde_preview`（本 host 的预览 cookie） |
| `Origin` / `Access-Control-Request-Method` | CORS 用（#241）：前者是 deny 响应回显 `Access-Control-Allow-Origin` 的唯一来源，后者是识别预检的唯一依据。⚠ 两者必须在 Traefik `forwardAuth.authRequestHeaders` **白名单**内（该白名单外的头一律不进 auth 子请求）；白名单由路由生成器 `portal/src/routes.js` 产出，不得手改生成产物 `deploy/traefik/dynamic/routes.yml` |

授权逻辑（顺序，任一失败即短路）：

1. **取 `X-Forwarded-Host` → 精确查 `port_allocations.hostname`**（活跃唯一索引）。查不到 → `404 not_found`（「路由表里没有 = 不可达」，原理二；正常不该发生，发生说明路由与 DB 失同步）。⚠ **同名多行时以活行为准（#275）**：`port_allocations_live_hostname_key` 是**部分**唯一索引（谓词 `state <> 'released'`，与 0019 的 `port_allocations_live_global_port_key` 同源）⇒ `released` 行**不占位**，管理员把预览块搬回**曾用过的号段**（§4.7a 的搬迁事务，#246）后，同一 hostname 会「1 条活行 + N 条 released 历史行」共存，而 hostname 上没有全表索引⇒ 读侧**必须自带优先级与全序**：`ORDER BY (state <> 'released') DESC, released_at DESC NULLS LAST, id`（不得依赖行的偶然顺序）。
2. allocation `state` 必须 ∈ {`allocated`,`active`}；`released` → `403 forbidden`（`allocation_released`）。⚠ 该码**只在「本 hostname 只剩 released 历史行」时出现**；第 1 步已取到活行时不得被判成已释放（#275 的错误形状正是 released 历史行遮蔽活行 ⇒ 预览恒定 403，而面板显示 Allocated、签票返 201）。因此**不得把第 1 步改成 `WHERE … AND state <> 'released'` 的过滤**——那会把「只剩 released」的 host 从 403 改写成 404，并让本码变死代码。
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

> ⚠ **交付口径（#250 裁决，2026-10-11）**：上面第 5 步的三档里**只有 `private` 被交付**，而且**根本没有任何入口能把一条 allocation 改成别的档位**
> （全仓唯一写点 = 开户时写死 `private`，`portalloc.js:101`；真机 20 条活 allocation 全 `private`）。
> `org-visible` / `public` 的判定逻辑（包括 `public` 免票短路）**保留但休眠**——决策口径：**预览不对外分享**，
> 测试环境不应变成长期可访问的「类生产」入口（会被当成生产环境）；人对人临时分享一律走 §2.8 一次性 ticket。
> 要启用长期开放，必须先推翻 `principles.md` §3 里那一行否决理由。

**CORS 预检免凭证（#241）**：`OPTIONS` **且**带非空 `Access-Control-Request-Method`（Fetch 规范定义的预检，按规范**不携带任何凭据**）→ 跳过第 3/4/5 步的凭证与 exposure 判定，直接当放行处理（`200` + `X-Auth-User`，审计 `details.grant_kind='preflight'`）； Traefik 于是把预检转发给上游 dev server，由应用自己回 `Access-Control-Allow-*`（平台不代答、也不在边缘叠加 CORS 中间件——上游已自带 `Access-Control-Allow-Origin`，再叠一层会变成浏览器拒收的「multiple values」）。边界（fail-closed 不扩大）：第 1/2 步照旧（未知 host 仍 `404`、已释放仍 `403 allocation_released`）；不带 `Access-Control-Request-Method` 的裸 `OPTIONS` 仍 `403 preview_ticket_required`；预检无主体，故**不**触发 `allocated→active` 升级（升级语义仍是「首次凭证放行」，紧随其后的真身请求照常触发）。

**deny 响应必须带 CORS 头（#241）**：deny 分支（上表 401/403/404）在**保留原状态码与 §1.1 错误信封**的前提下额外带 `Access-Control-Allow-Origin: <回显请求 Origin>` + `Access-Control-Allow-Credentials: true` + `Vary: Origin`。不带时浏览器只报 `No 'Access-Control-Allow-Origin' header is present`，把「需要预览票据」伪装成「应用 CORS 配错」。口径：带凭据故**回显而非 `*`**；只接受 `scheme://host[:port]`（含 IPv6 字面量）或字面量 `null`，非法/多值/含 CR-LF 的 `Origin` 一律不回显（防响应头注入）；无 `Origin` 则不造 CORS 头（curl 等非浏览器调用响应体字节不变）。本回显在 portal 完成（实测 Traefik v3.7.13 会把 auth 子响应的状态码/响应体/响应头透给客户端）。

失败响应体统一用 §1.1 错误信封（`code` 见上各分支；Traefik 对 401 触发登录跳转、对 4xx/5xx 原样回传，`X-Auth-User` 缺失即不放行）。

每次判定（无论通过与否、无论 ticket/session/public/预检）写 `audit_log`（`action='auth.forward_auth'`，`actor_id` = 凭证**主体** `user_id`（`public`/无凭证/预检时 `NULL`），`target` = hostname，`details` = {uri, method, exposure, result, grant_kind, subject_id, issuer_id}；`grant_kind` ∈ `ticket`/`session`/`public`/`preflight`（#241））——「谁在什么时候看了哪个端口」（原理二）。**`details` 不得记录 ticket / cookie 明文**（只记 `grant_id` 与 token 哈希前 8 位）。**forwardAuth 故障（portal 5xx / 连接失败 / 超时）→ Traefik 侧 deny-all**（默认拒绝，绝不放行；可叠加 basic-auth 兜底，规格 §6.2 / topology.md §5.2）。

### 2.8 `POST /api/ports/:id/preview-ticket` + 预览 ticket / 预览 cookie 语义

#### 签发（`POST /api/ports/:id/preview-ticket`）

浏览器 API，要求有效 session cookie（§2.5）。用于「portal 打开预览」：portal 校验当前用户对该 allocation 的可见性后，签发一次性 ticket 并返回带 ticket 的预览 URL。

> 路径参数 `:id` = `port_allocations.id`（UUID）。它的**读取面**是 §4.7a 的 `GET /api/me/ports` 与
> `GET /api/admin/fdes/:fdeName/ports`（#246 交付② 补上的那条缺失的路；在那之前没有任何列端口的 API，
> 签票只能靠人查库）。

请求：无体（空 JSON `{}`）。

响应 `201`：

```json
{
  "ticket": "pt_<随机 256-bit base64url>",
  "url": "https://eric-p-8001.fde.erix.vip?preview_ticket=pt_…",
  "expires_in": 60
}
```

| 字段 | 说明 |
|---|---|
| `ticket` | 一次性、短 TTL 的不透明 token；只可经 `?preview_ticket=` 使用一次 |
| `url` | **预览完整域**（`<fde>-p-<portLabel>.<BASE_DOMAIN>`，fde-platform §8.5；#246 后端口段是号池里的 5 位号，**不是**固定的 `40XX`）+ `?preview_ticket=`，前端**直接跳转/作为 iframe src**，不得自行拼接（规格 §8-4）。scheme/端口按**公开入口**派生（#57：dev `http://…:8090`、生产 https 默认端口不进 URL；实现 `projects.previewUrl(hostname, { publicBaseUrl: portalPublicBaseUrl })`） |
| `expires_in` | TTL 秒数（**60s ⚠️ 待决策者确认**） |

签发规则：
- 当前用户对该 allocation 的可见性必须成立：`private` → 仅 owner **或 admin**（admin 例外，写审计 + 告警）；`org-visible` → 任意已认证用户；`public` → 真公开免凭证（**默认不给，仅 admin 可开**）——签发侧同样仅 admin 可为 `public` allocation 签发 bootstrap ticket。不成立 → `404 not_found`（他人资源不泄露存在性，§1.2）。
- allocation 必须 `state ∈ {allocated,active}`；已 `released` 视同不存在 → `404`。
- **每条预览 host 各自签票**（#240：一个 FDE 开户即有一整段 allocation；#246 交付①把端口来源换成
  **全局号池 `22000–29999` 里最小的未占用对齐块**（默认 10 个一段，管理员可改），所以**具体是哪几个号
  运行时才决定**，本文档不写死端口区间——唯一真相是 `~/.erix/ports.json` 与该 FDE 的 allocation 行）：
  ticket 与派生的预览 cookie 都**绑一条 allocation / 一个 host**——`preview_grants.allocation_id` 只指向
  签票时那一条，`__Host-fde_preview` 是 host-only cookie（本节末），所以 `…-p-22000.…` 上拿到的凭证
  **不会**让 `…-p-22001.…` 免凭证通过：一段里的每个域名都要逐个签票、逐个种 cookie——**#247 交付的批量端点**
  （§4.7a `POST /api/me/ports/batch-tickets`）把「逐个签」收成**一次请求签 N 张**，票仍是逐张 per-host；
  `forwardAuth` 第 1 步按请求的 hostname 精确查 `port_allocations`（§2.7），换个 host 就查不到那张票。
  反过来也成立：**给某条 allocation 签的票不会让它指向别的 host**（`url` 由该 allocation 自己的
  `hostname` 生成，规格 §8-4 前端不得自行拼接）。
- portal 生成随机 token，只存 `preview_grants`（`kind='ticket'`，`token_hash=sha256(ticket)`，**`issuer_id` = 当前登录用户（签发者）**、`user_id` = **主体（被授权访问的身份：普通 FDE 自签 = issuer = subject；admin 代签他人 private = subject 为 admin）**、`allocation_id`、`expires_at=now+60s`、`created_ip/created_ua`）。**不存 ticket 明文**（与 `login_sessions.token_hash` 同口径）。

#### ticket 语义（`preview_grants.kind='ticket'`）

| 项 | 取值 / 语义 |
|---|---|
| 签名 / 存储 | **不透明随机 token + 服务端哈希查找**（`sha256`）；选**有状态**而非「无状态 HMAC 签名」——一次性（single-use）与撤销必须有服务端状态支撑，纯签名 ticket 无法可靠地「用一次即失效」或「显式撤销」 |
| TTL | **60s ⚠️ 待决策者确认**（覆盖人工点击/iframe 首帧的间隙，又不至于可被长期重放） |
| 一次性（crash-safe） | 首次校验在**同一 DB 事务**内消费 ticket + 派生 session + 记 `ticket→session` 关联（§2.7 第 6 步）；响应丢失后**同一 ticket 安全重放**（返回同一 bootstrap 结果、不产生第二个 session token）；仅当已消费且派生的 session 已 `revoked`/`expired` 才 `403 preview_ticket_used` |
| 撤销 | `state='active' → 'revoked'`（同事务置 `revoked_at`）即失效；**用户登出时按 `login_session_id` 血缘撤销本次会话签发的未用 ticket（#429，必选非可选，见 §2.4）**；admin 吊销 / allocation 释放另走各自路径（下表与 §2.9.3） |
| 与 allocation 释放联动 | allocation `state → released`（项目删除 / run 结束 / reaper / offboarding / 管理员改块）时，**同一事务**把该 allocation 上**仍 `state='active'`** 的凭证全部置 `state='revoked'`（同事务写 `revoked_at`）；`used`/`expired`/`revoked` **一律不动**（口径见下方「撤 grant 的口径」）；且 forwardAuth 第 2 步始终重查 allocation `state`，双保险 |
| 血缘列 `login_session_id`（#429，迁移 `0025`） | 签发该凭证的**登录会话**（`→ login_sessions.id`，`ON DELETE SET NULL`，**可空不回填**）：ticket 行在签发时写入，session 行在 forwardAuth 兑换时**继承** ticket 的值。登出撤销按此列命中（§2.4）；血缘缺失（存量/无会话上下文签发）= 登出救不了，靠自身 TTL 到期 |

#### 预览 cookie 语义（`preview_grants.kind='session'`）

| 项 | 取值 / 语义 |
|---|---|
| 生成 | ticket 首次校验通过后，forwardAuth 在**同一事务**内消费 ticket 并**确定性派生** session token（`HMAC-SHA256(session_signing_key, "preview-session:" + ticket)`，不存明文），存 `preview_grants`（`kind='session'`，记 `parent_ticket_id`），并 `302` 下发 `Set-Cookie`（§2.7 第 6 步） |
| 名称 / 属性 | `__Host-fde_preview`；`Secure`/`HttpOnly`/`SameSite=Lax`/`Path=/`、**不设 `Domain`（host-only 于当前预览 host）**；开发期纯 HTTP 按 §2.5 同法去 `__Host-` 前缀并关 `Secure` |
| TTL | `Max-Age` 与 `expires_at` 一致：**15 分钟 ⚠️ 待决策者确认**，滚动续期（每次 forwardAuth 成功刷新） |
| 撤销 | `revoked_at` 置位 / TTL 过期 / allocation `released` / 用户 `disabled` / **签发会话登出（#429，按 `login_session_id` 血缘，见 §2.4）** 均失效（前三项 forwardAuth 每请求重查；登出撤销是写侧回收，forwardAuth 只看到 `state='revoked'`） |
| 上游可见性 | **预览 cookie 与 portal session cookie 都绝不到达预览上游**：二者 host-only、只在各自 host 发送；Traefik `strip-cookie` 中间件在放行后删除 `Cookie`（fde-platform §6.4）——上游 dev server 收到的请求头里**没有 `Cookie`** |

#### 撤 grant 的口径（`state → revoked`，issue #252）

三个写入口共用同一条 UPDATE 形状（`portal/src/offboarding.js` 的 `release-network-routes`、
`portal/src/portalloc.js` 的 `moveFdePreviewBlock`、`portal/src/admin.js` 的停用用户）；
登出撤销（#429，`auth.js revokeSession` 的 CTE）是第四个写入口——**命中列换成 `login_session_id` 血缘**，
但 SET 形状与谓词口径（只撤 `active`、`COALESCE` 写 `revoked_at`）与下面逐字同形：

```sql
UPDATE preview_grants SET state = 'revoked', revoked_at = COALESCE(revoked_at, now())
 WHERE allocation_id = ANY($1::uuid[]) AND state = 'active'      -- 只撤 active
```

| 点 | 口径 | 为什么 |
|---|---|---|
| 哪些状态会被撤 | **只有 `state='active'`** | forwardAuth 只认 `state='active'`（§2.7 第 2 步）⇒ 只有它还在授予访问 |
| `used` 为什么不撤 | 保留原状，连 `used_at` 都不碰 | 已消费的 ticket 是**历史事实**、本身不再授予访问；还活着的是它派生的 `session`（`parent_ticket_id` 指向它），而 session 是 active、同批被单独撤。把 `used` 塞进 `revoked` 会撞 baseline 的双向 CHECK `(state = 'used') = (used_at IS NOT NULL)`（= `preview_grants_check3`，真机即 500）；「顺手 `used_at = NULL`」虽过 CHECK，却抹掉「这张票何时被谁消费」的审计事实（**篡改历史**，禁止） |
| `expired` / `revoked` | 不动 | 已不授予访问，由 reaper 清理（本节 reaper 语义） |
| 幂等 | 撤 **0 行也算成功**，语句**无条件发** | offboarding 的撤权**不许**挂在「本次真的释放了行」上：重试路径上本 FDE 的 allocation 早已 `released` ⇒ 守卫为假 ⇒ 撤权整段被**静默跳过**（真机留下 21 条残渣、步骤却记 `done`、`last_error` 空）。因此 id 集合取本 FDE 的**全部** allocation（含历史已 `released` 的），两个计数分开写日志 |
| 存量残渣 | 一次性由迁移 `deploy/migrations/0020-preview-grant-revoke-repair.sql` 撤掉「已释放 allocation 上仍 `active`」的凭证；`used` 行按同一口径保留 | baseline 冻结（sha256）⇒ 数据修复只走增量迁移；迁移可重放（第二次零行变更），且**不碰任何约束** |
| 回归保护 | `portal/test/preview-ports.test.js` 与 `portal/test/offboarding.test.js` 的 fake **逐条同名**模拟 `preview_grants` 的 baseline CHECK（含双向的 `used ⇔ used_at`），违反 ⇒ **语句级**抛 `23514`（规则集中在 `portal/test/preview-grant-checks.js`） | 旧 fake 只模拟 `revoked ⇔ revoked_at` ⇒ 这类 bug 在单测里**结构上不可能**被发现（#252 能活到真机的根因） |

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

- `disable`：`users.status → disabled` + `disabled_at=now()`；**同事务**吊销该用户全部 `login_sessions`（`revoked_at`）、`preview_grants`（**只吊销 `state='active'` 的凭证**——`used` 是历史事实，保留原状，见 §2.8「撤 grant 的口径」/#252）、`api_tokens`。此后登录（§2.2）、forwardAuth（§2.7 第 5 步 `users.status='disabled'`）、internal 归属均拒绝。**容器停止/runner token/LLM 虚拟 key 吊销属 offboarding（规格 §7.3），是独立命令**，不在本命令内。
- `enable`：`status → active`、清 `disabled_at`；**无自动恢复路径**（model.md §1.1 状态机）。恢复后用户需重新登录、重新签发预览 ticket。
- 审计：`user.disable` / `user.enable`（actor = 执行 admin）。

#### 2.9.4 密码 / TOTP 策略

| 项 | 策略 |
|---|---|
| 口令哈希 | **argon2id**；参数（⚠️ 待决策者确认，倾向 OWASP 2026）：`m=19 MiB, t=2, p=1`；本地账号与 OIDC 账号分离（OIDC 无 `password_hash`） |
| 口令强度 | 长度下限 **12**（⚠️ 待决策者确认；**现状未实现**，`validatePassword` 只校验「非空 + ≤上限」，本单不引入最小长度——见 §2.6a）；不做复杂组合规则；自助改密要求**新口令不得与当前相同**（§2.6a）|
| 首登强制改密（#255，工单 `feat-261013-03`）| **已实现**：`users.must_change_password`（迁移 `0021`，`NOT NULL DEFAULT false`）+ 受限会话门（§2.11a）+ 出口 `POST /api/me/password`（§2.6a）。置 `true` 的只有两条**代设**路径：`admin.createUser`（新建与同名 disabled 行重新激活**两条分支都置**）与 `admin.resetUserPassword`；**`cli.js bootstrap-admin` 故意不置**（它打印的那枚口令就是本人第一次看到的那一枚，再要求改密是空转，且会把 dev/CI 的 bootstrap 账号锁进改密屏——不对称的理由写在代码注释里，由测试钉住）。存量行不回填（吃 `DEFAULT false`）⇒ 升级不会把已部署环境全员锁死 |
| 口令重置 | 管理员面 `POST /api/admin/users/:id/reset-password`（§12）：置 `must_change_password=true` 并**吊销该用户全部会话**（防旧会话续用）；CLI `station-portal user set-password --login <login>`（admin 本地执行）同口径。**自助**改密走 §2.6a（保留当前会话、只吊销其它会话），不通过公开 API 暴露「忘记密码找回」 |
| TOTP | **强制**（规格 §7.1；现状对未注册账号不成立，见下注）：RFC 6238 `SHA-1 / 6 位 / 30s`，校验窗口 ±1 步 + 单码防重放（同 30s 窗口内同码只接受一次）；种子 base32，仅 bootstrap/`user create` 时下发 |
| TOTP 重置 | `station-portal user reset-totp --login <login>`：重生成种子并输出 otpauth URI/二维码；**强制该用户重新走两步登录** |
| 限流 | 登录爆破与 TOTP 连续失败走 §2.2/§2.3 的 `429 rate_limited`（`Retry-After`） |

> **口令哈希实现注（P1 skeleton）**：⚠️ P1 骨架实现暂用 Node 内置 `crypto.scrypt`（不新增依赖）；argon2id 的参数本身仍待决策者确认，切换时按自描述哈希（`algo$…$salt$hash`）平滑迁移，登录成功时对旧格式自动 rehash。
>
> **TOTP 强制范围（现状，issue #50）**：未注册 TOTP（`totp_secret` 为 NULL 或空串）的本地账号登录**口令直通建会话**，不强制第二因素（用户决策 2026-09-22，实现 d605015）；经 CLI 建号（§2.9.1/§2.9.2）与 `reset-totp`（上）一律下发种子，故这些账号仍是强制两步。表格中的「**强制**」是规格 §7.1 的设计目标，现状按本注执行（详见 §2.1）。
>
> ⚠️ 待决策者确认：TOTP 本身是否保留为**强制**（规格 §7.1 已写「强制 TOTP」，此处按已决处理，仅算法参数留待确认；**现状**：未注册 TOTP 的账号已口令直通，故「强制」只对已注册 TOTP 的账号成立，见上注）；admin 数量上限是否收紧为 1。

### 2.10 授权矩阵（P1）

四类主体：`admin`（本地破窗 admin）、`普通 FDE`（本人资源）、`同租户已认证`（`org-visible` 的观者）、`公开`（未认证 / `public` 观者）。资源归属默认按「当前登录用户」过滤，他人资源一律 `404`（§1.2）。

| 主体 | 自己的项目 | 自己的会话/run | 自己的审批（**未交付**，§4.8）| 预览访问（exposure） | 用户管理 / 全局 |
|---|---|---|---|---|---|
| `admin` | 读/写/删；运维视角可**读全部 FDE 项目**（每次读他人资源写审计 + 告警） | 读/写/stop；运维视角可读全部会话/run | 决定自己的审批单；运维视角可读全部审批单 | 可对任意 allocation 签发 ticket（含 `private` 他人；`issuer_id`=admin、主体 `user_id`=admin，forwardAuth 按主体 + **admin 例外**放行并写审计）与开 `public` | 建/禁用/恢复用户、重置口令/TOTP、吊销会话/ticket、offboarding（§2.9） |
| `普通 FDE` | 仅本人项目（他人 → `404`） | 仅本人 session/run | 仅本人审批单（他人 → `404`） | 本人 `private` + 任意 `org-visible` + `public`；**不得开 `public`**（`403 forbidden`，§4.7） | 无 |
| `同租户已认证` | ✗（`404`） | ✗（`404`） | ✗（`404`） | 仅 `org-visible` allocation 的预览（ticket 绑定其 `user_id`） | 无 |
| `公开`（未认证） | ✗（`401`/`404`） | ✗ | ✗ | 仅 `public` allocation 的预览（无凭证，审计 `actor_id=NULL`） | 无 |

> 口径补充：`org-visible`/`public` 的预览仍需经 portal（§2.8 签发 ticket / 直接跳转），且 forwardAuth 每请求重查 `users.status` 与 allocation `state`（§2.7）；「同租户可见」只是 exposure 的放宽，不等于可读他人项目/会话/run 数据。
>
> **ticket 的 `issuer_id` 与主体 `user_id`（B4，三处口径一致）**：签发（§2.8）记录两者——`issuer_id` = 谁签的（登录用户），`user_id` = 主体（被授权访问的身份）；forwardAuth 的 `private` 判定（§2.7 第 5 步）用**主体** + **admin 例外**；审计（§2.7）同时记 `subject_id`/`issuer_id`。普通 FDE 自签 = issuer = subject = owner；admin 代签他人 private = issuer = subject = admin。

### 2.11 跨站请求防护（#234，工单 `feat-261013-01`）

**威胁模型**：session cookie 是 host-only 会话 cookie + `SameSite=Lax`（§2.5）。Lax 只挡「跨站子资源/XHR 携带 cookie」这一半；登录端点在拿到 cookie 前根本不需要 cookie，一发给 `POST /api/auth/login` 就能把用户种成攻击者的会话（登录 CSRF）。本部署又在 Traefik 后面、入口多个（`station.fde.erix.vip` 与 `100.100.0.3`），cookie 自身不区分发起方。故补一道**不读 cookie、不靠配置项**的服务端防线，并把拒绝写审计（可观测）。

**落点**：`portal/src/http.js` 的纯函数 `checkSameOrigin({method, originHeader, secFetchSiteHeader, hostHeader, forwardedHostHeader})` + 豁免包装 `csrfGateFor(req, pathname)`，在 `routeApi` 里、**分派到任何 handler 之前**统一执行（故拒绝一定发生在副作用之前；`POST /api/login` 的 307 兼容跳转也在这道防线之后）。测试：`portal/test/csrf-origin.test.js`。

**作范围**：只有写方法 `POST / PUT / PATCH / DELETE` 参与校验（方法名大小写不敏感）；`GET / HEAD / OPTIONS` 一律放行——SSE `GET /api/sessions/:id/events`（§5）与预览 ticket 的 302 兑换（§2.7/§2.8）都是 GET，不得被打断。

**豁免端点**（无 CSRF 语义，不进防线）：

| 端点 | 为什么豁免 |
|---|---|
| `/api/internal/*` | 容器 → portal（§9），per-container token 鉴权、**不带 cookie**，攻击者的页面伪造不了 Bearer token |
| `/api/forward-auth` | Traefik 回调（§2.7），它的 `Origin` 是**被代理预览页面**的 origin，天然不等于 portal host；不豁免则每个带凭据的预览请求都会被误杀 |

**判据**（按顺序，任一命中即定论）：

| # | 条件 | 结果 |
|---|---|---|
| a | `Sec-Fetch-Site` 为 `cross-site` 或 `cross-origin` | **拒**（fail-closed 优先：即使 `Origin` 缺失、即使用户看着同源）。先看 SFS 再看 Origin：它是浏览器给的、页面不可伪造，而 Origin 可被中间代理改写。`cross-origin` **不是 SFS 的规范取值**（合法只有 `same-origin` / `same-site` / `cross-site` / `none` 四个），这里是**防御性多接**：多接一个不存在的值不会漏、方向仍 fail-closed |
| b | `Sec-Fetch-Site` 为 `same-origin` | **放行**（真同源，即使 Origin 缺失或畸形——部分浏览器/隐私模式同源的 XHR 不带 Origin）。**`same-site` 不在本判据**（返修，理由见下方） |
| c | 否则若有 `Origin` | 解析出 **authority（`host[:port]`）**与「请求自身的 authority」比：**优先 `X-Forwarded-Host`**（本部署 Traefik `trustForwardHeader: false`，会按真实连接覆写），无则 `Host`。相等 ⇒ 放行，不等 ⇒ 拒。**`same-site` 就落在本判据** |
| d | 两者都没有 | **放行**（curl / CLI / 容器内脚本；否则现有 e2e 与运维脚本全挂）。`Sec-Fetch-Site` 的未知值（如 `none`）不算结论，继续走 c/d；`same-site` 且 `Origin` 缺失也走到这里 ⇒ 放行 |

**为何 `same-site` 不能直接放行（返修，2026-10-13）**：`same-site` 的规范语义是「**同注册域、不同 origin**」，而本站**整站坐在同一个注册域 `erix.vip` 下**：portal 在 `station.fde.erix.vip`、FDE 预览在 `eric-p-22000.fde.erix.vip`。于是从预览 host 发的 XHR，浏览器给的 `Sec-Fetch-Site` 正是 `same-site`；而 session cookie 是 **host-only + `SameSite=Lax`**（§2.5），`SameSite` 判的也是注册域 ⇒ **cookie 照样被带上**（Lax 不挡同站），CORS 只让它读不到响应、**写副作用已经发生** = 教科书意义上的 CSRF。拿旧判据（`same-site` 直接放行）这道防线会在**本站最现实的场景**（任意 FDE 预览 host 上跑的、agent 写的应用去 POST portal API）直接失效，根本走不到 Origin 比对。现口径：`same-site` 一律落到判据 c（同注册域但不同 origin ⇒ 不等 ⇒ 拒 `origin_mismatch`）；`same-site` 且 Origin 缺失 ⇒ 落 d 放行（与旧口径一致，**不新造严格性**）。回归门：`portal/test/csrf-origin.test.js`。

**归一化**：小写、剔首尾空白、剥掉**与该 scheme 相同**的默认端口（`http:80` / `https:443`）；**非默认端口必须保留**（现网 dev 栈就是 `station.fde.erix.vip:8090` 与 `100.100.0.3:8090`，把端口丢了就是拿 8090 与 80 当同源）。同源基线从请求自己的 Host 派生 ⇒ **零新增配置项**，两个入口天然各自成立（互不充当对方的基线）。

**只比 authority、不比 scheme（契约点，理由写进代码注释）**：本部署处在 http（dev `:8090` / `100.100.0.3:8090`）与 https 共存的过渡期，portal 又常在边缘卸载 TLS，`X-Forwarded-Proto` 与 Origin 的 scheme 不总是同形；拿 scheme 参战会把「同一个站点的 http/https 两面」误杀成跨站。CSRF 要防的是**别的站点**带本站 cookie 发写请求，同站不同 scheme 不构成这个威胁，所以 scheme 只用在上表的默认端口归一化。

**畸形一律拒（绝不「解析失败当同源」）**：`Origin` 不可解析 / 多值（重复头被 Node 拼成 `a, b`）/ 含空白或制表或 CR-LF / 带路径（与 #241 的 CORS 形状口径一致）/ opaque `null` ⇒ 拒；有 `Origin` 但请求自身 authority 缺失或不合法（无 Host、XFH 多值、带 scheme）⇒ 也拒。`Sec-Fetch-Site` 的多值同样按 token 展开：**跨站 token 只要出现过就算跨站**（同站 token 洗不白它，fail-closed）。

**拒绝响应**：`403` + 新错误码 `cross_origin_forbidden`（`retryable=false`，`details={origin, sec_fetch_site, method}`，**不含 cookie**），响应头带 #241 那套 CORS deny 头（`corsDenyHeaders(origin)`，§1.2）——否则浏览器只报 `No 'Access-Control-Allow-Origin'` 而看不到真实原因（AGENTS §8.11 踩过的坑）；无 Origin / 畸形 Origin 时不回显（防响应头注入），状态码不变。

**审计**：每次拒绝写一条 `auth.csrf_denied`，`actor_id=NULL`，`target=` 只有 path（F2：剔掉所有 query，§2.7 口径），`details` 同错误信封的 `details`。`.catch(()=>{})`：审计写失败不得影响响应。

> ⚠ **语义变化（调用方需知；本单只做到源码级判定，真机浏览器验收另跑）**：原先在**预览 host 的页面里**用 `fetch(portal API, {credentials:'include'})` 的调用方，会被这道防线拒。完整链（返修后口径）：预览 host 与 portal **同注册域不同 origin** ⇒ 浏览器给 `Sec-Fetch-Site: same-site`，而 host-only + `SameSite=Lax` 的 cookie **仍会随请求发出**（Lax 按注册域判，不挡同站），所以它是真 CSRF 而不是「只是 CORS 读不到」⇒ 防线在判据 **c**（Origin authority 比对）把它拒掉（写副作用已发生才拒 = 没有这层就拦不住）。只有在**真跳注册域**（如 `https://evil.example`）时才会命中判据 a。口径：预览应用**本来就不该调 portal API**（#212/#263：portal cookie 在预览 host 会被边缘剥除，**读路径早就断了**），所以这不是回归。要读平台数据请经 portal 自己的页面/路由，或由平台侧下发。
>
> 残余风险（不属本单）：① `X-Forwarded-Host` 优先意味着**绕过 Traefik 直连 portal 端口**的客户端可以自选 XFH 来凑成同源（在 docker 网络内才能直连，与「攻击者必须能诱导用户浏览器发请求」的 CSRF 前提不叠）；② 防线只防跨站写请求，**不替代** SameSite 与登录限流；③ http 入口上的 CSRF 仍受「明文信道可被直接 MITM」限制，scheme 不参与判定不会削弱也不会加强这一点（§2.5）。


### 2.11a 受限会话门（#255，工单 `feat-261013-03`：首登强制改密）

**要治的是什么**：管理员开户与重置口令都是**代设**——那枚口令由 admin 生成、由 admin 转交，中间任何人（转交渠道、聊天记录、工单）都可能看到它。此前只要把它输进登录框，就能拿它把平台**全用完**，「请首次登录后改口令」在契约里只是一句愿望（§2.9.4 旧行）。本门把它变成机制：**这枚口令还没经过本人的手 ⇒ 除了改它，哪儿也去不了**。

**判据**：会话有效（`login_sessions` 未吊销未过期、`users.status='active'`）且 `users.must_change_password = true` ⇒ 该会话**受限**。受限只改变「能碰哪些 `/api/*`」，不改变身份、不吊销会话、不影响预览（见放行清单最后一条）。

**落点**：`portal/src/http.js` 的常量 `RESTRICTED_SESSION_ALLOWLIST` + 纯判据 `restrictedSessionAllows(method, pathname)`，在 `routeApi` 里**紧跟 #234 CSRF 门之后、分派到任何 handler 之前**执行（与 #234 同一层 ⇒ 拒绝一定发生在副作用之前）。**两道门不共用豁免表**：#234 看「这个请求有没有 CSRF 语义」，本清单看「改密之前必需不必需」，只是恰好有几条重叠。测试：`portal/test/must-change-password.test.js` 第 ③ 段。

**放行清单**（与代码常量逐条一一对应，每条在代码里带 `reason`；用例逐条钉住「必需项一条不能少」）：

| 方法 + 路径 | 为什么必须放行 |
|---|---|
| `GET /api/me` | 受限会话的唯一数据源：前端靠它拿「我是谁 + 为什么被弹去改密」（§2.6 的 `must_change_password`）。挡掉它 = SPA 只看见一片 403，不知道该把用户送去哪儿 |
| `POST /api/me/password`（**不限方法**）| 受限状态的**唯一出口**（§2.6a），挡掉就是死锁。整条路径放行而不挑方法：非 `POST` 该由路由自己回 `405`，不能被门改写成 403——403 会让前端以为「连改密这条路也被锁了」 |
| `POST /api/auth/logout` | 登出永远可达：不想改密的人至少能换账号/退出；挡住它会把人钉在一个自己进不去的会话里 |
| `POST /api/auth/login`、`POST /api/auth/login/totp`、`POST /api/auth/login/email-code`、`POST /api/auth/login/email-code/resend` | 登录的三个第二步与重发不得被挡（§2.2/§2.3/§2.3a/§2.3b）：第一步此刻还没有会话，本门对无会话请求本就无效；列进来是防「受限用户重新登录」被自己的旧会话形状误伤（受限账号的旧 cookie 会跟着新登录请求一起发出），也让清单与 §0.1 端点表对齐 |
| `POST /api/login`、`POST /api/logout`（**旧路径**）| ⚠ **新旧两条都覆盖**：`POST /api/login → 307 → /api/auth/login`（§0.1）这对重写在本门**之后**，所以旧路径**确实会走到本门**（不是「到不了所以不用列」）。不列，一个还带着旧会话 cookie 的受限用户连「重新登录」「退出」这两个动作本身都会被 403 锁死 |
| `GET /api/site` | #450 A2 的 host 信息端点（§2.12）**本身就是公开端点**（无会话也 200、只回两个对外 base URL），拿「欠不欠改密」去挡它不自洽；而它被挡的后果不是 403 而是**静默降级**——前端路由守卫把「site 不可用」当成 fail-open（不跨 host 跳），于是受限会话在错的 host 上照样渲染出一片 404 的页面 |
| `* /api/forward-auth` | ⚠ **本单最大的雷**：Traefik forwardAuth 回调（§2.7）。`routes.js` 的 `authRequestHeaders` 白名单带 `Cookie` ⇒ 浏览器 cookie 会原样进这条回调；而它的语义是「这片预览该不该放行」，被门挡成 403 `password_change_required` 时 **Traefik 只把它当成认证失败** ⇒ 该用户 `*.fde.<base>` 名下**全部**预览端口一起挂，而他要改的只是口令 |
| `* /api/internal/*`（前缀）| 容器 → portal（§9）：per-container Bearer token 鉴权、**不带登录 cookie**，改密状态与它无关（与 #234 的豁免同一批理由）|

清单之外 ⇒ `403` + §1.2 的 `password_change_required`（`details = {action:"change_password", endpoint:"POST /api/me/password"}`）。

**四条边界（写死在实现与测试里）**：

1. **只管 `/api/*`**：静态资源与 SPA 外壳不在本门之下（`serveStatic` 在 `route()` 里另有一条路），`/api/health` 与 `/healthz` 在 `routeApi` **之前**就被 `route()` 接走。改密屏本身就是 SPA 页面，挡掉 JS/CSS 或挡掉探针会让人连「去改密」的界面都打不开 / 把「全员欠改密」误判成站点故障——那是自我锁死，不是防线。
2. **无会话 / 会话无效 ⇒ 不挡**：401 的语义完全归各 handler（§1.2 `unauthorized`）。本门只处理「已认证但欠一次改密」，所以它**不会**把任何既有 401 变成 403。
3. **`HEAD` 按 `GET` 判**（HEAD 是 GET 的子集，同一份放行理由同样成立）；清单里 `/api/me` 是**精确匹配**而非前缀，否则 `/api/me/ports` 会被误放。
4. **`admin` 也被挡**：判据只看那一列，与 `role` 无关——代设口令这个场景对 admin 同样成立。

**成本**：门只在**清单之外**才解析会话，并与 `requireSession` 共用**请求内缓存**（`resolveSession`，`Symbol` 键挂在 `req` 上）⇒ 全链路仍是**每请求一次** `login_sessions` 查表，不是两次（用例 `每请求恰查一次 login_sessions` 钉住放行与拦截两种形状）。`GET /api/me` 原本手写的查表也已收编进同一条路（两条 401 与旧写法逐字同义，响应体不变）。

**不写审计**（与 #234 的 `auth.csrf_denied` 刻意不同）：受限会话下 SPA 的每个轮询都会撞门，审计会被客户端重试刷成噪声；而「欠改密」这个状态本身已经由 `user.password_changed`（§2.6a）与管理员代设/重置那两条审计钉住，可观测性不缺。

**前端怎么知道（两个入口，同一份事实）**：登录响应顶层的 `password_change_required`（§2.2/§2.3，拿到 cookie 的那一刻就知道）与 `GET /api/me` 的 `user.must_change_password`（§2.6，刷新后还能拿到）。二者与门的判定同源（同一个 `users.must_change_password`），不允许各自维护一份。改完密（§2.6a）**当场解锁**：当前会话保留、旗标清零，同一 cookie 的下一个请求就恢复 2xx。

**⚠ 本单不含前端**：迁移默认值不回填 + `bootstrap-admin` 不置旗标 + `createUser`/`resetUserPassword` 才置 `true`，三件事合起来保证「已部署环境升级后不会有人被锁住」；但**被代设过口令的人一旦被门挡住，本单里唯一的出口是 `curl`/API 调用**（改密屏是后续前端工单）。残余风险见本条。

**残余风险**：① 前端未交付 ⇒ 被代设口令的用户目前只能靠 API 自己改密（§2.6a），若忘了这一步会以为自己被锁死；② 门只覆盖 `/api/*`，**不覆盖**已经签出去的预览 ticket / 预览 cookie（§2.8）——受限用户手上已有的预览 cookie 在 TTL 内照样能用，这与「预览归预览、门户归门户」的既有口径一致，本单不收紧。

### 2.12 `GET /api/site`（#450 A2：两个入口的对外 URL，**公开、零秘密**）

**要治的是什么**：#450 的 A1 把**边缘**隔离做实了（用户入口 `/api/admin/*` ⇒ 404、管理台入口除白名单外的 `/api/*` ⇒ 404，见 [`../deploy/edge-routing.md`](../deploy/edge-routing.md) §2），但**前端还不知道自己在哪个 host 上**：SPA 是同一份、hash 路由不变，两个 host 都把它发下去。于是「在用户 host 上打开 `#/admin/users`」的观感是「页面在、API 全 404」。A2 只做一件事：**发现自己在错的 host 上就跳到对的 host**——而跳转落点必须先知道「两个 host 各自的对外 URL」，本端点就是那个唯一来源。

**请求**：`GET /api/site`（无参数、无 body）。

**响应** `200 application/json`：

```json
{
  "userBaseUrl": "http://station.fde.erix.vip:8090",
  "adminBaseUrl": "https://admin.fde.erix.vip:9443"
}
```

| 字段 | 语义 | 来源（**不新增配置项**） |
|---|---|---|
| `userBaseUrl` | 用户面（`station.<伞域>`）的对外 base URL，`scheme://host[:port]` | `config.portalPublicBaseUrl`，即 `resolvePublicBaseUrl()` 的产物——**就是今天喂给 agentd 的 `ERIX_STATION_BASE_URL` 那一个**（§9），前端/容器/预览 URL 共用同一口径 |
| `adminBaseUrl` | 管理台（`admin.<伞域>:9443`）的对外 base URL | `config.adminPublicBaseUrl`（A1 的 `resolveAdminPublicBaseUrl`：`https://<adminHost>[:<adminPort>]`，**443 时不带端口**，与 websecure 分支同口径） |

**三条口径（都写进了单测）**：

1. **公开**：无 session cookie 也 `200`。登录页在**跳转之前**就要用它（否则「在管理台 host 上不知道自己是管理台」= 死锁），所以它不可能要求会话。同理它也在 #255 受限会话门的放行清单里（§2.11a）：公开端点拿「欠不欠改密」去挡，既不自洽，后果又只是**静默降级**（前端 host 闸 fail-open）。
2. **零秘密**：响应键集合**恰好两个**（`portal/test/http.test.js` 逐字钉住）。不回版本号、镜像、host 清单、`ADMIN_IP_ALLOWLIST` 或任何运维面信息——这个端点对匿名访问者可见，多一个字段就是多一条信息泄露面。
3. **两个入口都可达**：用户入口由 portal 的 catch-all 直接命中；管理台入口由 `routes.js` 的 `admin-auth` 允许面（`/api/auth`、`/api/me`、`/api/site`）命中，并在 `admin-deny-api` 的排除列表里**逐条互补**（deny 优先级 300 > 允许 200，漏一条就是「deny 把允许的那条吃掉」）。`portal/test/routes.test.js` 用**规则求值器**（不是字符串匹配）断言「管理台入口上 `/api/site` 的赢家是 `admin-auth` 而非 `admin-deny-api`」。

**错误**：非 `GET` ⇒ `405 method_not_allowed`（与 `/healthz` 同口径，**不新增错误码**）。其余情况下本端点不产生业务错误。

**客户端口径（前端 `stores/site.ts` + `lib/hostGate.ts`）**：拿不到（网络 / 5xx / 超时 / 缺字段）⇒ **fail-open，不跳**（跳错方向比不跳更糟：管理台不可达时会把用户踢到死地址）；失败后缓存 30s 再重试，并发导航只发一次请求（单飞）。判据与落点见 `portal/frontend/src/lib/hostGate.ts`（纯函数，六行矩阵逐条单测）。

---

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
| `name` | 用户内唯一；`PROJECT_NAME_RE` 限定 `[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?`（同 schema.sql CHECK，不允许尾随 `-`）。**该规则只服务这张已退役、只读的 `projects` 表**：P5 起 hostname 不含项目名（迁移 `0008-deprojectize.sql`），目录名也不再由它约束——目录名在服务端的唯一硬边界是「`~/projects/` 一级目录 + 无路径穿越」（见 §4.2 `POST /api/sessions` 的 cwd 校验真值） |
| `repo_url` | 可选仓库地址，**仅作记录/展示元数据**；不填时为 `null`。平台不 clone、不物化该目录；Git 凭据可由 FDE 自行配置，或由 admin 通过凭据端点投放（规格 §7.2/§12.2，user-space.md §4.1.1） |
| `slot` | 项目端口块序号（**P5 之前的旧机制**，当年决定 `4000 + slot*8` 起始端口；现在端口分配与它无关，见规格 §8.2） |
| `template` | 项目模板（onboarding 第 5 步生成 AGENTS.md 等，规格 §7.2） |

> 项目目录 = 容器内 `/home/<FDE_CONTAINER_USER>/projects/<name>`；当前容器用户为 `erix`。

### 3.2 `GET /api/projects`

分页列表（§1.3）。响应 `200`：`{ "items": [Project...], "next_cursor": null }`。

### 3.3 `POST /api/projects` —— 已退役（issue #242）

> **状态：`410 Gone`，`code='project_api_retired'`**（实现：`portal/src/http.js` 的 `routeApi`，
> P5「去项目化」按 [`directory-as-project.md`](../design/directory-as-project.md) 定稿执行）。
> 本节保留正文只作**退役说明与迁移指引**，不是可调用契约。

**退役原因**：项目注册制要解决的三件事（会话归属、run cwd、脚手架）都已由**目录本身**承担——
`projects` 表在应用层**没有任何写入口**（`projects.js` 的 `createProject/renameProject/deleteProject`
已整体删除），`port_allocations.project_id` 也已被迁移 `0008-deprojectize.sql` DROP，
「项目 → 端口」这层锚点随之消失。

**替代做法（目录即项目）**：

| 退役端点 | 现在的做法 |
|---|---|
| `POST /api/projects`（建项目 + 同事务分配项目级端口） | **不建项目**：`POST /api/sessions` 传 `project_id`（= 目录名，语义是 cwd），服务端按 `~/projects/<name>` 解析并 `mkdir` 目录；会话与 run 直接在该目录工作（D8 修订：隔离单元 = 项目目录）。**端口也不在这里分配**——预览域名已由平台在开户时预建**一整段**（`scope='fde'`；#246 起端口取自全局号池 `22000–29999` 里最小的未占用对齐块，默认 10 个一段，规格 §7.2 第 3 步 / §8.2），容器内从 `~/.erix/ports.json` 取（清单是唯一真相） |
| `GET /api/projects` | 仍然可调用，但属**留档只读**：只读 `projects` 表历史行，`deleted_at IS NULL` 过滤后**正常返回空 `items`**（新库/新用户本就无行）——这是预期行为，不是故障 |
| `PATCH` / `DELETE /api/projects/:id` | 一并 `410`：改名/删除项目由 FDE 在容器内对目录自行处置（`git`/`mv`/`rm`），平台不再介入 |
| `GET /api/projects/:id/ports` | `410`（§4.7）：FDE 级 `~/.erix/ports.json` 是唯一端口视图 |

错误响应：

| HTTP | code | 场景 |
|---|---|---|
| 410 | `project_api_retired` | 调用任何项目**写**端点（`POST` / `PATCH` / `DELETE`），或项目维度端口列表端点 |

> 原文（P5 之前）：请求 `{name, repo_url?, template?}` → `201` 返回 Project + 本次分配的 `ports[]`，
> 错误含 `400 validation_failed` / `409 name_conflict` / `409 port_quota_exceeded`。
> 其中 `port_quota_exceeded` 已随「一次性预分配一整段」的裁决删除（§1.2 / 规格 §8.2），
> `name_conflict` 与 `validation_failed` 随整个写端点一起退役。

### 3.4 `GET /api/projects/:id`

响应 `200`：`{ "project": {...}, "ports": [] }`。**留档只读**：`port_allocations.project_id` 已被迁移 0008 DROP，项目维度端口不可推导 ⇒ `ports` 恒为空数组（`http.js` 的 F10 口径）；实时分配见 FDE 级 `~/.erix/ports.json`（规格 §8.2，退役说明见 §3.3）。

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
| `termination` | run 结束时由 `runToolLoop` 返回值透传（见 §5.3 `run_end`），运行中为 `null`。类型为**对象** `{ "reason": string, "detail"?: string }`，`persistence_failed` 另带 `{ "operation": string, "phase": string, "sideEffect": string }`（erix-agent `src/loop/orchestrator.js:973-990`）；**0.18.0 起** `reason === "failed"` 的终局还可带 `{ "errorCode": string }`（引擎 additive 字段，上游 #176：值为错误上已有的分类码，无分类码时引擎给 `unknown`；值域由引擎定义，宿主原样透传、不解释语义）。<!-- DRIFT:termination-reason:begin -->`reason` 取值集合（erix-agent 0.18.0）：`reason ∈ {end_turn, no_tool, stall, max_rounds_cap, judge_done, continuation_exhausted, final_guard_unverified, aborted, failed, persistence_failed}`<!-- DRIFT:termination-reason:end -->（依据：`src/loop/orchestrator.js:511` typedef 的 9 值 + `:973-977` 的 `persistence_failed`；单一真相常量 `portal/frontend/src/lib/terminationReasons.ts`，与 §5.3 及 `docs/data/model.md` §1.7 由 `portal/test/termination-contract.test.js` 逐项对齐。旧文档里的 `reflection_stop` 已不是引擎取值，只可能出现在历史行。） |
| `error` | 失败时为 `{ "code": "checkpoint_failed", "message": "...", "retryable": true }`，结构同 §1.1 错误信封内层；成功为 `null`。run 级错误码见 §6 |
| `cost` | 记账口径依赖 Q1/Q4 ⚠️ 待决策者确认；P1 可为 `null` |

### 4.2 会话 CRUD

| 端点 | 请求 | 响应 |
|---|---|---|
| `GET /api/sessions?project_id=<id>` | 可选按项目过滤，分页 | `200 {items, next_cursor}` |
| `POST /api/sessions` | `{ "cwd": "~/projects/<目录名>", "title": "可选", "model": "可选" }`（`project_id` 为 P5 过渡别名，语义就是 cwd） | `201 { "session": ChatSession }` |
| `GET /api/sessions/:id` | — | `200 { "session": ChatSession, "messages": [Message...]（按 seq 升序、分页参数同 §1.3）, "last_seq": 128 }` |
| `PATCH /api/sessions/:id` | `{ "title": "新标题" }` | `200 ChatSession` |
| `DELETE /api/sessions/:id` | — | `204`（归档，`status → archived`；有进行中 run 时 `409 run_in_progress`） |

**`cwd` 校验真值（P5，issue #284 校正；实现 `portal/src/sessions.js` 的 `CWD_RE` + `validateSessionCwd`）**：

- 形态必须是 `~/projects/<name>`，`<name>` 为**一级目录**（不得含 `/`）——路径穿越就靠这一条拦；
- `<name>` 为 `.` / `..` / 含控制字符（`\x00-\x1f`、`\x7f`）⇒ `400 validation_failed`（`details.field='project_id'`）；
- **字符集与长度不限**：下划线、点、中文、空格、超过 63 字符都照收（容器内用户自建目录的自由命名权；
  真库存量如 `~/projects/meeting_asr_app`）。`chat_sessions.cwd` 列**没有任何 CHECK**，服务端不按
  「DNS label」收紧——P5 起目录名不进 hostname（迁移 `0008`），没有那个约束来源；
- 目录不存在时服务端 `mkdir`（权限口径同工作区目录；已存在则幂等复用，不重建）。
- **前端「＋ 新建目录」表单另有一层更严的规则**：`DIR_NAME_RE`（`portal/frontend/src/lib/constants.ts`，
  `^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$` = 小写字母/数字/下划线/连字符、首尾须为字母数字、≤63）。
  它**只约束新建**，不影响在目录下拉里选中容器内已有目录（哪怕目录名含其它字符）。

**`session.compaction`（#451：引擎 `compactionStats` 的读侧观测面，**键缺席而非零**）**

引擎 `runToolLoop` 的返回值带 `compactionStats`（typedef 在 erix-agent `src/loop/orchestrator.js`），
**每轮一条**并原样写进 `transcript_rounds.record.compactionStats`；本站此前从未消费它（`runner/worker.js`
只透传 `termination`/`usage`/`rounds`/`finalText`），于是「压缩到底有没有在工作」只能靠 SQL 猜——真库
2026-11 实测 82 条带 stats 的轮记录里 TTL 层 `triggered=75` / `tokensSaved=314518`，而两版台账都写着
「TTL 未触发」（判据用错了：TTL 层**不发** `compaction` 事件，只写 `compactionStats`）。

`GET /api/sessions/:id` 的 `session.compaction`（**零 DDL、读侧聚合**，与 `projectSessionMessages`
的折叠事实**共用那一次** `transcript_rounds` 扫描 ⇒ 查询次数不变）：

```json
{ "rounds": 82, "layers": { "ttl": { "triggered": 75, "tokensSaved": 314518 } },
  "tokensSaved": 326863, "lastRound": 57 }
```

| 键 | 口径 |
|---|---|
| `compaction`（整个键） | **缺席 = 本会话一次折叠都没有**（不是 0 次）：一条有效 `compactionStats` 都没有，或所有层 `triggered === 0` ⇒ 不给这个键 |
| `rounds` | 至少有一层 `triggered > 0` 的轮数（按轮号去重） |
| `layers.<id>` | **只列 `triggered > 0` 的层**（`foldLlm.triggered === 0` ⇒ 没有 `foldLlm` 键）；`id ∈ {ttl, slidingWindow, foldStatistical, foldLlm, anchors, enforceSize}`（= 引擎 `COMPACTION_PIPELINE` 顺序，白名单：新层要等宿主补 id + 文案才出现） |
| `tokensSaved` | 各**已列**层 `tokensSaved` 之和 |
| `lastRound` | 最后一次有折叠的轮号（无则键缺席） |

脏数据处置（**绝不让一个坏轮记录把整个会话 DTO 打成 500**）：`compactionStats` 不是数组 / `layers`
不是对象 / `triggered` 非「非负安全整数」/ `tokensSaved` 非有限非负数 ⇒ **该条跳过并计数**（跳过数
只在返回值里给调用方，**不进 DTO**），其余轮照常汇总。按**数组遍历**（不假设长度恒 1；今天是每轮 1 条，
那是实测事实不是契约）。

前端落点：会话头部既有那行状态（`StreamPanel.vue` 的 `.session-stats`）下追加一行
`本会话压缩：TTL 折叠 75 次（省 314.5k token）· …`——**不新造面板**、不进 `.syserr`（压缩是正常工作，
不是故障）、token 走既有 `formatTokenCount`（`lib/compactionSummary.ts` 收窄 DTO，模板不碰脏值）。

**对话流 DTO 的 `messages[]` 展示字段（`GET /api/sessions/:id`）**

助手锚点上除宿主元数据（`id`/`run_id`/`seq`/`role`/`content`/`synthetic`/`attachments`/`created_at`）外，
还挂上游官方投影 `projectTranscriptForDisplay` 的展示字段（issue #188/#189：**逐字、原名透传，有则出现、
无则不写该键**）：`toolCalls[]`、`reasoning`、`blocks`、`turnKeys`、`folded`。

| 字段 | 来源 | 口径 |
|---|---|---|
| `messages[].toolCalls[]` | 引擎投影 | `{key, name, id?, argsSummary?, resultPreview?, isError?, executionStatus?}`（预览长度由上游定） |
| `messages[].toolCalls[].durationMs` | **宿主 join**（issue #283） | 毫秒。⚠ **引擎投影不带这个字段**（`DisplayTurn.toolCalls[]` 的形状里没有时长），它由 `portal/src/session-view.js` 在投影**之后**按 `(run_id, call_id)` 从本站 `tool_calls.duration_ms` 补上（数据源 = §9.4 的 U3 `tool_result` UPDATE）。`call_id` 即事件里的 `tool_call_id` = `toolCalls[].id`。 |
| `messages[].folded.hasSummary` | **宿主判定**（issue #390-A） | boolean。**这个键不是上游字段**，是 `portal/src/session-view.js` 按折叠行自己的 `record.summary` 形态算出来的：上游契约（erix-agent `src/store/file.js:25`）是 `summary?:{action:string,note:string}|"missing"` ⇒ 只有 `{action,note}` 且至少一项非空才算“有真摘要”，字面量 `"missing"`（现网 17/17 条折叠行都是这个值）、缺键、空壳都算没有。存否口径与 `round` 绑定：**轮号取不到就整个不带这个键**（缺席 = 前端“不知道”，不得当成 `false` 把旧数据的展开控件抹掉）。存要的作用是：没有真摘要时，摘要区只是把横幅标题换个说法重说一遍（“已压缩第 1–94 轮” vs “早期第 1–94 轮已折叠。”），前端据此不画展开控件。 |

- **旧数据口径**：库里 `duration_ms` 为 `NULL`（引擎当年就没给时长的那批历史调用，见 §5.3 第 7 行与
  erix-agent #285）⇒ **DTO 不出现 `durationMs` 键**，不写 `0`、不塞 `null`、也不拿时间差造一个假时长；
  前端据此不渲染时长（而不是显示 `0ms`）。旧数据**不可回填**。
- **取数面**：`getSession` 额外一次 `SELECT run_id, call_id, duration_ms FROM tool_calls WHERE run_id = ANY($1::uuid[]) AND duration_ms IS NOT NULL`（只查本批锚点涉及的 run）；`includeMessages=false`（SSE 只校 `last_seq`）时不发这次查询。
- **前端归并规则**：实时路（`tool_result` 事件）已拿到的时长优先，投影值只在卡片现有 `dur` 为空时填——
  同一次调用不会因为刷新而改变显示。

**标题模型（issue #114 修订）**：

- **默认标题 = 首条用户消息截断**（零 LLM）：`POST /api/sessions/:id/messages` 建首条 `user` 消息时，若会话 `title` 为空且 `title_source='auto'`，取该消息前 30 字（被截断时尾加 `…`）落库，并推一条 `session_updated`（列表标题立即到位）。标题非空则幂等不动；与 `ERIX_SESSION_AUTO_TITLE` 开关**解耦**（开关关闭时照样生效）。
- **手工改名**（§4.2 `PATCH`）与 **AI 改名**（§4.5a）落 `title_source='manual'`：任何自动流程不得覆盖。
- **#88 自动起名默认关**：`ERIX_SESSION_AUTO_TITLE` 默认不生效（run 终态不再自动起名），env 显式设 `1` 开回；开关关闭不影响默认标题截断。

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
| 409 | `llm_model_not_found` | **绑定的模型在网关里已不存在**（#261014 切片 B2）：属主 active binding 的某个已配置槽位 `model_info.id` 不在网关 `/model/info` 里。`details` = `{slot, model_id}`；判据/选型理由见 §1.2。预检位置：体校验与幂等占位之后、**开业务事务与写 transcript 之前** ⇒ 失败时**不留用户消息、不入队 run、不把失败钉进幂等台账**（走 `release` 路径，同 key 可原样重试）。网关不可达时放行（消息照发）；无活绑定由下一条 `llm_not_configured` 负责 |
| 409 | `no_active_container` | 拉模型补充分支：该用户**从未有过任何容器记录**（containers 无非 removed 行，无法确定 run 归属与入队目标）——落库即 202 前提是存在容器行（runs.container_id 非空）；已有但离线的容器不受此码影响（§6.3） |
| 429 | `rate_limited` | 已知该用户 LLM 配额耗尽（上次 run 已确认），直接拒绝避免再烧配额（§6.1） |
| 503 | `container_unreachable` | ⚠️ 仅 push 下发模式（待决策者确认）：FDE 容器不在线/不可达且**不产生** message/run 记录；拉模型（终态）落库即 202、不返回此码（§6.3） |

> 支持 `Idempotency-Key`（§1.4）：断网重发同 key 返回首次的 `message`/`run`，不产生重复消息。实现口径：TTL 24h；**先占位后执行 + 记账并入业务事务**（`in_progress` 占位 → 业务事务内 `record()` 转 `done`，同一次 COMMIT，故「同 key 至多一次副作用（记账与业务写入同事务）」）；`claim_token` owner fencing 使被抢回的旧持有者的迟到记账/释放失效（§1.4）；同 key 不同载荷 → `409 idempotency_key_reuse`；并发同 key 未收敛（占位 < 5 分钟）→ `409 idempotency_conflict`（`retryable: true`，稍后重试拿首次结果）；重放路径不重复副作用（不重复唤醒 runner）。

### 4.3a `POST /api/sessions/:id/queued-inputs`（issue #370：运行中说话）

任务正在跑时把话交进来。**一个端点、服务端裁决**：同一事务里读「本会话有没有活跃 run」，有 ⇒ 入队，无 ⇒ 直接发送（复用 §4.3 的全部语义）。前端**不许**自己先看 `running` 再决定调哪个端点——那会在「点发送那一刻 run 刚好结束」时退化成 409，把消息丢在地上（pi 源码注释称之为 *strand a message in an idle queue*；本端点的原子分岔就是为堵它）。

请求：

```json
{ "content": "慢一点，先说方案再动手", "attachments": [], "kind": "steer" }
```

| 字段 | 说明 |
|---|---|
| `content` / `attachments` | 与 §4.3 逐字同规则（同一个 `validateMessageBody`） |
| `kind` | `"steer"`（**转向**：当前轮跑完就停下，用这句话继续）\| `"follow_up"`（**排队**：当前任务正常结束后按顺序发）。缺省 `steer`。其它值 → 400 |

响应 `202`（与 §4.3 同码：两条路都是「已受理，后续异步发生」——直发那路是等 runner 领，入队那路是等终态投），两种形状（**前端两种都必须认**）：

```json
{ "posted": { "message": { "…": "…" }, "run": { "id": "…", "status": "queued" } }, "queued": null }
{ "posted": null, "queued": { "id": "…", "kind": "steer", "content": "…", "position": 7 } }
```

错误：

| HTTP | code | 场景 |
|---|---|---|
| 400 | `validation_failed` | content 空 / `kind` 非白名单 |
| 404 | `not_found` | session 不存在、不属本人、或已归档 |
| 409 | `queue_full` | 未投递条数已达上限（`MAX_QUEUED_INPUTS_PER_SESSION` = 20）。`details.limit` 给具体数 |
| 409/429/… | 同 §4.3 | **直发分支**原样透传 §4.3 的错误面（LLM 未绑定、模型漂移、配额…），不重新包装 |

行为口径（改实现前必读）：

- **入队只写 `queued_inputs`**，绝不写 `messages` 锚点行、绝不提前 `appendUserInputTurn`。正文真相在 `transcript_rounds`（§4.7 / #77 P3 PR②b B2），提前落 transcript 等于让**还没说出口的话**进模型上下文并被渲染成已发送。投递时才走 §4.3 那条唯一发送路。
- `kind='steer'` 额外做两件事：记下 `interrupted_run_id` = 当时那个活跃 run，并给该 run 打 `cancel_requested_at`，**但 `runs.status` 保持 `running`（不进 `cancelling`）**。原因：`cancelling` 是「worker 立刻 SIGKILL 正在跑的工具」的开关（进程组杀，§4.5），而转向要的是「本轮跑完再停」。谁停、什么时候停，见 §9.12 的 `steer_request` 与 runner §「轮边界」。
- 上限只在真的要入队这条路上算，直发分支不吃这个数。
- 支持 `Idempotency-Key`（§1.4，同 §4.3 的台账），记账并入入队事务。

### 4.3b `DELETE /api/sessions/:id/queued-inputs`（整队取回）

把该会话**未投递**的话全部拿回给用户（= pi 的 `clear_queue`）。返回 `200`：

```json
{ "recalled": { "steering": ["慢一点"], "follow_up": ["跑完再改标题"] } }
```

- **只有整队，没有单条删除**：单条删要和投递方的领取竞态（pi 同样只给 `clear_queue` 一个动作）。
- 状态迁移是 `pending → recalled`，**不硬删**（留一行给人查「他说过什么没发出去」）。
- 已在 `delivering` 的**不动**——它已经变成一条正在建的 run，此时清它等于把已说出口的话再吐回输入框。
- 前端回填口径照 pi：取回的文在前、用户已打的草稿在后，中间空一行。

> 会话详情 `GET /api/sessions/:id` 的 `session.queued_messages` = `{steering:[{id,content}], follow_up:[{id,content}]}`，是刷新 / 多端 / 断线重连后队列的**唯一补齐来源**（在 DTO 出口挂载，不在 `sessions.getSession` 内部取——依赖方向与「只有详情需要它」两条理由见该处注释；快照取失败退化成空队列，不把详情拖成 5xx）（§5.3 第 17 类 `queue_update` 是 live-only、不落库）。additive：旧客户端不读它即可，旧后端不带它 ⇒ 前端退化成空队列。

### 4.4 `GET /api/sessions/:id/events`（SSE）

实时事件流，详见 §5。

### 4.4a `GET /api/sessions/:id/events/history`（issue #89：run_events 展示类事件历史）

刷新后前端重建工具卡片 / judge 面板的**只读历史通路**（对齐 pi-web「转录即真相」：历史与实时走同一渲染入口）。

- **与 SSE 的关系**：独立 REST 通路，不影响 §5.2.3 首连不补发 / 断线重连补发语义。
- **白名单**：只返回展示类事件（`tool_use` / `tool_result` / `judge` / `round*`（round_start/round_end/attempt/recovering/recovered）/ `compaction` / `final_guard` / `forced_final` / `model_metadata_missing`（erix-agent 0.18.0 新增的诊断事件，上游 #182；前端 `useEventStream.ts` 对未知/诊断类型走 `default` 中性忽略，不会渲染成错误）/ **`attempt_killed`**（#288：portal 自己合成的宿主事件——实时经 session SSE 推，不进白名单就会「实时有、刷新后没了」，正是本白名单要消灭的两种可见性不一致）/ **`tool_replay_decision_required`**（#288 缺陷 C：崩溃恢复时挂起工具**未被重放**，引擎 additive LoopEvent 经 runner U3 上报——它出现的时机正是用户刷新页面来看「我这条 run 怎么了」的时刻，不可回放比不推更坑） / **`persistence_error`**（#371-A：引擎落盘失败告警，走 `diagnostics.error` 而**不是** `onEvent`——本站此前没传 `diagnostics`，真机全库该类型 **0 行**，非致命降级因此彻底隐形；前端只把 `fatal === false` 刷成中性分隔行，致命那条仍由 `run_end` 的 `persistence_failed` 负责）；**第 18~21 类（issue #421）**`compaction_strategy_fallback` / `persistence_capability_degraded` / `resume_journal_skipped`（`model_metadata_missing` 早在 #182 时就已列入）——引擎承诺、本站以前订不到那一族，不进则又是「实时没有、刷新后也没有」；而 **`run_outcome`（第 22 类）是写明了理由的显式不进**（与 `run_end` 重叠且无读者，对账测：`portal/test/event-surface-contract.test.js`）；**第 28 类 `host_steer_injected`（erix-agent 0.32.0 唯一新增的 LoopEvent，#499）同样显式不进**——本站不传 `capabilities.hooks.nextUserTurn` ⇒ 结构上不产生该事件，订得到（水位线推进）但不刷行、不回放、不下发（理由同 `run_outcome`，钉在同一份对账测的豁免表，只加前端 `EVENT_TYPES` 不写决定会被它的 S2 判红）；运行态语义事件（`run_end` / `usage` / `checkpoint` / `assistant_delta` / `reasoning_delta` / `tool_call_delta` / `heartbeat` 等）一律不下发——历史回放不得驱动前端运行态状态机。**#502 的补充**：三个碎片型自本单起**根本不落库**，「不下发」对它们是双重成立（表里没有 + 白名单不列）；`tool_call_delta` 是本单唯一**从白名单里摘掉**的类型（它以前在，摘它的理由是「行没了」，成形参数在 `tool_use.input`），摘除理由必须写——前端 `HISTORY_REPLAY_TYPES` 与它逐项对齐，由 `portal/test/event-surface-contract.test.js` 对账。**#425 的消费侧补充（零后端变更）**：白名单里的 `round_end` 载荷带 `usage`（本 run 累计真值），前端动量状态机**只**吃它的 `usage` 与 `context_window` 两个展示量（并把登记的 run 直接标成已结束），其余字段与所有其它历史帧仍一律不驱动运行态 ⇒ 硬刷新后「上次 run 用了多少 token / 窗口多大」仍在，而轮号、时长、速率、相位照旧不重建。
- **分页**（§1.3 keyset）：默认取最新 `limit` 条（升序返回，`limit` 默认 500、上限 2000）；`before=<seq>` 取更早一批；`next_cursor` 非 null 表示还有更早批次。
- **大小防护**：payload 字符串叶值统一截 2000 字符（`tool_use.input` / `tool_call_delta.arguments_delta` 可能很大），JSON 形状保持合法。
- **鉴权**：同 `GET /api/sessions/:id`（session cookie；非属主 / 不存在 → `404 not_found`，不泄露存在性）。

#### 4.4a-1 合成项 `partial_output`（issue #300 / 形态 M #502：中止 / 失败 run 的部分正文）

缺陷：`runner/worker.js:1182` 的 catch 固定 `final_text: ''` ⇒ 被停止 / 失败的 run 在 `messages` 里**零助手
锚点**，而对话正文本来就从锚点渲染 ⇒ 界面上这次 run **正文区一片空白**（工具卡片在、正文没）。
它**已经说出口的话**必须从别处找回来，且**不许**为此新造一种落库行 —— 形态 M 的结论就是这一句。
纯宿主侧只读重建：不动 `runner/`、不消费 `err.finalText`、不写 `messages`。

**正文来源只有两处（都是已经存在的 durable 事实，形态 M 的核心）**：

| # | 来源 | 覆盖哪一段 | 谁写的 |
|---|---|---|---|
| 1 | `run_events` 里 `type='round_end'` 的 `payload.final_text` | **已经跑完的每一轮**的终稿，按 `seq` **升序**拼接 | 引擎事实档，写入侧一直在写（`internal.js` 的 U3 落库通路） |
| 2 | `run_events` 里 `type='run_end'` 的 `payload.partial_text` | **被停住的那半轮**（还没产出 `round_end` 的那段） | portal 在**合成 `run_end` 的同一条 INSERT** 里并键写入（`internal.js#runEndPartialKeys`，六个终态点共用；判据见 §5.4） |

两处都没有 ⇒ **不再退回**「去把碎片行捞回来聚合」（碎片已不落库，见 `docs/data/model.md` 的 #502 小节），
而是给一条**占位合成项**（下面「存在性判据」第 3 条）。

**存在性判据（一条 run 至多一条合成项）**：

| # | 条件 | 为什么 |
|---|---|---|
| 1 | 该 run 出现在**本次响应窗口**里（窗口行的 `run_id` 去重） | 窗口里没这个 run ⇒ 连候选判定查询都不发 |
| 2 | `runs.status IN ('finished','failed')` **且**该 run **零助手锚点**（`messages` 里 `role='assistant'` 的任意行，**含 `synthetic = true`**） | `queued`/`running`/`cancelling` 不是终态——「还在跑就标已中止」是新造的误导；**有锚点的 run 绝不能再渲染一遍**（重复正文就是这个坑，也正是 `partial_text` 只在**无锚点**时才写的原因，两处判据逐字同构） |
| 3 | 两处来源拼出**非空**文本 ⇒ 正文项；**都空** ⇒ **占位项**（`text: ''` + `placeholder: true`） | 占位是 #278「不许留空白」的落点：这次 run 一个字都没留住时，界面仍要有一行中性提示，而不是空气泡。**注意占位只在这里发**，SSE 补发通路**不发**占位帧 |

字段（与既有事件项**同形**，前端不需要分支去认「新形状」）：

| 字段 | 类型 | 口径 |
|---|---|---|
| `seq` | number | 该 run 的**全局** `MAX(e.seq)`（`SELECT MAX(e.seq) FROM run_events e WHERE e.run_id = r.id`，**不受 `before` 分页窗口约束**；**不新分配**、不占 `chat_sessions.last_seq`）⇒ 位置落在该 run 内容**末尾**，分页窗口外的行也算得进来。⚠ 副作用：一个跨好几页的 run，它的全局最大 seq 比任何更早页的 `before` 都大 ⇒ **合成项会在每一页重演一遍**，所以入口按 `seq < before` 只留「属于本页那一页」的那一份（`http.js#buildHistorySynthItems`，#502 审计 M-6④；只卡上界，不卡下界） |
| `run_id` | string | 所属 run |
| `type` | string | 固定 `partial_output`（**合成类型，`run_events` 表里查不到这一行**——表里只有 `round_end` / `run_end` 那些真实行） |
| `payload.text` | string | 来源 1 按 `seq` 升序拼接 + 来源 2 追加；脏值（`final_text` / `partial_text` 不是字符串）整条跳过，不拼成 `[object Object]` |
| `payload.chunks` | number | **拼进正文的已完成轮次数**（= 来源 1 的 `round_end` 条数，**不含**那半轮）。⚠ 口径在形态 M 变了：#502 之前是「拼进来的碎片行数」，碎片不落库之后那个数就没有来源了 |
| `payload.truncated` | boolean | **两个来源取或，任一侧为真即真**（#513 第 3 条把它从「只有投影自己切长度」改成两路）：① 本端点聚合后超 `PARTIAL_PROJECTION_TEXT_CAP = 65,536`（一直就有）；② 库里那份 `run_end.partial_text` **本身就已经是被夹过的**（`run_end.payload.partial_truncated`，见下面那张 additive 键表）。不取 ② 就是把一段被缓冲夹到 16,384 的正文说成「完整」（**谎报**，不是少报）。**载荷里不塞 `…（已截断）` 文本**，截断标记由前端出——与 §4.4 的「大小防护」刻意不同：合成项要给前端一个可判定的布尔） |
| `payload.placeholder` | boolean | 占位项才有（只认真字面量 `true`）；**这是 #278 不空白红线在形态 M 之后的唯一落点** |
| `payload.source` | string | 人工排障用：`round_end` / `run_end` / `round_end+run_end` / `none`（占位）。前端不读 |

**写入侧那三个 additive 键（`run_events` 里 `type='run_end'` 的 `payload`，`internal.js#runEndPartialKeys`）**
—— 与合成 `run_end` 的**同一条 INSERT** 落库（六个终态点共用一个 helper），**不开新事件行、不加 DDL**：

| 键 | 类型 | 口径 |
|---|---|---|
| `partial_text` | string | 被停住那半轮的正文，取自进程内缓冲**当前那一轮**的正文槽（`round_end` 落库成功后那一轮的槽已被 `closeRound` 关掉 ⇒ 这里**不会**重复已完成轮次，#502 审计第 2 条）。**只在零助手锚点时写**；缓冲里没有这个 run、或正文为空 ⇒ **三个键一个都不写**（也不写空键） |
| `partial_round` | number | 那段正文所属的轮号（缓冲槽里的 `round`；拿不到数就是 `0`） |
| `partial_truncated` | boolean | **#513 新增的键**：正文槽**自己**被缓冲上限 `textCap = 16,384` 夹过尾就是 `true`。取的是快照的 `textTruncated`（实现注记见下）。读侧**只认真字面量 `true`**：缺键（#513 之前落的 `run_end` 行本来就不可能有这个键）与脏值都当「没截」，不拿脏值谎报 |

> **实现注记（#513 审计第 3 条：为什么不用 `snap.truncated`）**：缓冲快照里那个 `truncated`
> （`run-partial-buffer.js` 的 `truncatedByCap`）是正文与**推理两路共用**的观测位——`reasoning` 累加超上限
> 同样会置它，而 `reasoning` 既不落库也不进本节投影 ⇒ 拿它写终态就会把「**推理**被截」谎报成「**正文**被截」。
> 所以缓冲另开了一个**只有正文那一路会置**的 `textTruncated`（`append()` 里两处 `field === 'text'` 分支），
> `partial_truncated` 写的就是它。⚠ **两处 `truncated` 不是一把尺**：§5.1 那个 SSE 补发快照帧里的
> `truncated` 仍是两路共用的观测位（它只是给人看「这一轮被夹过」，不落库、不进投影），**别拿它反推**
> `partial_truncated`，也别把两者合并成一个字段。

- **上限**：`PARTIAL_PROJECTION_TEXT_CAP = 65536`。#502 之前是 2000，**它咬掉了判据 3**：真库现查单轮
  `round_end.final_text` 最长 **31,707** 字符 ⇒ 一个输出正常长文的中止 run 会被截掉大半，
  「刷新后正文逐字完整」当场不成立。65536 是「现查最大值约两倍」向上取整到 2 的幂。
- **一次查询**：候选 run 确定后，**一条** `run_id = ANY($1) AND type IN ('round_end','run_end')` 的有界查询
  （走既有 `run_events_run_idx (run_id, seq)`）拿完两处来源。**零 DDL、零新索引**（形态 M 明确不新增
  也不删除任何索引，理由见 `docs/maintenance/task-ledger.md` §8.125）。
- **分页（形态 M 修的第四条审计）**：合成项**只在它 `seq` 所属的那一页出现**——`before` 已经切过它的
  `seq` 就不给（`buildHistorySynthItems(pool, rows, { before })`）。它 `seq = MAX(seq)` 不受窗口约束，
  不加这道闸就是「往上翻一页，同一段正文再重演一遍」。同一条闸同时管 `run_termination`（§4.4a-2），
  两类合成项共用。
- **排序 / limit**：合成项参与升序排序（按 `seq`），但**不占 `limit`、不参与 `next_cursor` / `hasOlder` 判定**
  （那两个仍只由白名单真实事件决定）。
- **`reasoning_delta` 不参与**（thinking 文本不在本单面上；内存快照里的 `reasoning` 也只给 SSE 帧，不落库）。
- **前端落点**：`StreamEntry` 的 `kind: 'partial'`（中性助手气泡 + 「已中止 · 部分输出」标签，**不是**红色
  错误行）；`placeholder` 条目渲染成一行中性提示（`stream.partialOutput.placeholder`，zh/en 成对）。
  `assistant_delta` 仍然**不得**进下发白名单。
- **已接受边界：刚停止的那一刻不会立刻出现**。合成项只在 `GET /events/history` 响应里存在，而该响应只在
  `openSession`（打开会话 / 刷新 / 重进会话）时拉；run 终态后的 `refreshSession` 只重取 `/api/sessions/:id`
  ⇒ 点「停止」当下界面只有 `run_end` 分隔行，**部分正文要刷新一次才出现**。不是 bug，是落点选择。
- **已接受边界：单副本**。`partial_text` 是**写侧进程内**累加器算出来的（§5.1），而 `round_end.final_text`
  是 durable 的 ⇒ 多副本部署时「那半轮」会丢（丢成什么样：正文只剩已完成轮次，**不是**脏数据）。

响应里多出来的那一项（与真实事件混在同一 `events` 数组里）：

```jsonc
{
  "seq": 168,               // = 该 run 在窗口行里的 MAX(seq)，不新分配
  "run_id": "9d3b2f1e-...",
  "type": "partial_output", // 合成项：不落库、不进 SSE
  "payload": {
    "text": "已经生成出来的正文",       // 已完成轮次的 round_end.final_text + run_end.partial_text
    "chunks": 3,                       // 拼进来的**已完成轮次数**（形态 M 口径）
    "truncated": false,
    "source": "round_end+run_end"
  }
}
```

一个字都没留住时（占位项，`#278` 底线）：

```jsonc
{ "seq": 168, "run_id": "9d3b2f1e-...", "type": "partial_output",
  "payload": { "text": "", "chunks": 0, "truncated": false, "placeholder": true, "source": "none" } }
```

响应 `200`：

```json
{
  "events": [
    { "seq": 12, "run_id": "9d3b2f1e-...", "type": "tool_use", "payload": { "tool_call_id": "c1", "name": "bash", "input": { "cmd": "ls" } } }
  ],
  "next_cursor": null
}
```

> `events` 里可能多出两类**响应期合成项**：`partial_output`（中止 / 失败 run 的部分正文，§4.4a-1）与
> `run_termination`（run 的**终态分隔条**，§4.4a-2）。两者都不是 `run_events` 的行，也不占 `limit`，
> 并且**都只在它 `seq` 所属的那一页出现**。

#### 4.4a-2 合成项 `run_termination`（issue #236：刷新后终态分隔条仍在）

缺陷：`run_end` **不在**下发白名单（§4.4a 首段，红线：历史回放不得驱动前端运行态状态机）⇒ 终止
分隔条只在**实时 SSE** 里出现过一次，刷新 / 重开会话后**完全消失**；#217 补的是「打开会话时对**活跃**
run 对账」，不覆盖终态的历史回放。修法**不碰白名单**：在本**只读**端点里从 `runs` 的终态字段
（`status` + `termination`）**投影**一条展示项。

**存在性判据（三条同时成立，一条 run 至多一条）**：① 该 run 出现在**本次响应窗口**里；
② `runs.status IN ('finished','failed')`（`queued`/`running`/`cancelling` 一律不合成——「还在跑就标已中止」
是新造的误导）；③ `termination.reason` 是**非空字符串**（缺 `termination` / 脏载荷 ⇒ 不合成：**绝不拿
`status` 编一个 reason**）。

| 字段 | 类型 | 口径 |
|---|---|---|
| `seq` | number | = 该 run 在 `run_events` 里的**最大 `seq`**（`run_end` 行本来就在表里 ⇒ 分隔条天然排在本次 run 内容之后；`MAX(seq)` 是**整 run** 口径，不受 `before` 窗口限制；**不新分配**，不推进 `chat_sessions.last_seq`） |
| `run_id` | string | 所属 run（前端幂等键 = `termination:<run_id>`） |
| `type` | string | 固定 `run_termination`（**合成类型，名字故意不叫 `run_end`**：`run_end` 永不进白名单） |
| `payload.status` | string | `runs.status`（`finished` / `failed`） |
| `payload.termination` | object | `runs.termination` **原样透传**（`reason` / `detail` / `operation` / `phase` / `sideEffect` / `errorCode`，字符串叶值截 2000）。分级与标签全由前端从它取 |

- **不落库 / 不进 SSE / 不进白名单**：`run_termination` **不进** `HISTORY_EVENT_TYPES`（后端下发白名单），
  也**不进**前端 `EVENT_TYPES` / `HISTORY_REPLAY_TYPES`——它只在**本端点的响应**里存在（与 §4.4a-1 同一种
  存在方式）。反方向也钉着：库里即使真有一行 `type='run_termination'` 也**不会**被下发。
- **呈现分级（前端）**：`aborted`（用户主动停止）⇒ **中性分隔条** + 母语标签；`failed` /
  `max_rounds_cap` / `persistence_failed` / `final_guard_unverified` ⇒ **红色 `.syserr`**（§5.3 同一张口径表）。
  实时 `run_end` 与历史合成项**共用同一个取词/分级函数**（`useEventStream#runEndLine`）——否则刷新一次颜色就变。
- **幂等**：前端用 `renderedIds` 的 `termination:<run_id>` 去重；实时 `run_end` 渲染后立即登记同一个
  id ⇒ 同一视图里「实时一条 + 历史一条」不会发生；硬刷新后 `renderedIds` 重建 ⇒ 历史项正常渲染。
- **成本**：与 §4.4a-1 **共用同一条** `runs` 查询（`r.id = ANY(...)` + 终态过滤 + `MAX(seq)` 相关子查询，
  走既有 `run_events_run_idx`）⇒ 本次窗口没有 run 时**一条查询都不发**，有 run 时**也只有那一条**（不重查）。
- **已接受边界**：① 只覆盖「该 run 真落在本次响应窗口里」的那一页（同 §4.4a-1 的窗口口径）；
  ② 合成项**不带 `usage`**（实时 `run_end` 的 `· tokens a+b` 后缀在历史里不重建——与 #282「刷新后运行态数字
  拿不回来」同一口径，不拿历史值假装实时）。

```jsonc
{
  "seq": 168,                 // = 该 run 的最大 run_events.seq
  "run_id": "9d3b2f1e-...",
  "type": "run_termination", // 合成项：不落库、不进 SSE
  "payload": { "status": "finished", "termination": { "reason": "aborted", "detail": "stopped by user" } }
}
```

错误：`401 unauthorized`；`404 not_found`；`400 validation_failed`（`limit` / `before` 非正整数）。

### 4.4b `GET /api/sessions/:id/folded/:round`（issue #189；口径于 #375 改版）

折叠横幅上「查看原文」的只读懒加载端点。鉴权同 `GET /api/sessions/:id`（非属主/不存在一律 `404 not_found`，不泄露存在性）；`:round` 是**折叠行自己的 round**（不是 `foldedRoundRange.to`）。

**200 响应**（`turns` 一律走同一个上游投影 `projectTranscriptForDisplay`，不另造折叠渲染，#95 红线）：

```json
{ "round": 137, "turns": [ … ], "source": "rebuilt", "truncated": true, "dropped_messages": 317 }
```

| 字段 | 口径 |
|---|---|
| `round` | 请求里的折叠行 round，原样回显 |
| `turns` | 原文投影结果，**形状与 #189 一版完全一致**（新字段只增不改，旧前端无需改） |
| `source` | `rebuilt` = 按 `foldedRoundRange` 从同会话已有轮行重建；`archive` = 只拿得到那一行的归档（无 range 的存量行 / range 内无正文） |
| `truncated` | 布尔位（**不塞省略号文本**，截断标记由前端出，先例同 §4.4a-1）。重建行数超 `FOLDED_REBUILD_MAX_ROWS = 2000`（与 U7 recall 同尺）**或**归档被上游夹断 ⇒ `true` |
| `dropped_messages` | 上游夹断丢掉的条数（取 `record.foldedPayloadMeta.droppedMessages`）；无则 `0` |

**口径为什么要改**（#375，背后可见上游 erix-agent#461）：erix-agent 0.25.0 之前 `record.foldedPayload` 是每次折叠从 `from:1` 重发的**全量副本**，所以“只读那一行归档”意外地等于“全部原文”；0.25.0 把它改成**本轮新增的有界差分**（会话级内容去重 + 默认 256 KiB 夹断）⇒ 只读归档只能给出残缺，去重全吸收时甚至是空，而旧口径一律 `404 folded_payload_not_found`、前端文案「原文已不可用（上游未保留折叠前载荷）」——那是假话，原文一直在各自的轮行里。上游契约也已写明：宿主不得把截断/缺失读成数据丢失，`foldedRoundRange` + `navigationRecord` 才是有界指针。

**`404` 语义收窄**：`folded_payload_not_found` 现在只在「range 与归档**两条路**都拿不出任何正文」时才发（旧口径：那一行归档为空就发）。行顺序按 `round ASC, append_seq ASC`（与账本保序口径一致，#338 教训：不得只在页内取行）。

### 4.4c `GET /api/sessions/:id/delegates[/:childRunId]`（delegation P2：子 run 名册与账本）

子 run 在界面上**不是会话**（`docs/design/delegation-2026-11-08.md` §1：`runs.session_id NOT NULL` + `runs_one_active_per_session` 两条 DDL 挡死了「子 = 真 run」），所以上下文靠这两个只读端点从**文件**里读。零 DDL、零新事件类型、零新错误码、零审计（与 `GET /api/sessions/:id` 同口径）。

数据源是 FDE 家目录里引擎自己写的两份文件（`<userSpaceRoot>/<fde>/home/delegation/`，容器内同一棵树挂在 `/home/erix/delegation/`）：名册 `roster/<parentRunId>/<childRunId>.json`（每父 run 一个目录）、账本 `transcripts/<childRunId>.jsonl`。⚠ **「每 run 一个账本文件」从 erix-agent 0.32.0 起不再是事实**（#499）：子账本用的就是引擎入口导出的 `createFileTranscriptStore`（`runner/lib/delegation.js:229`），而该 store 从 0.32.0（上游 #769）起**每 run 写两个文件**——`<runId>.jsonl`（轮记录，本站读的就是这一份）+ `<runId>.recovery.jsonl`（**恢复行通道**，`src/store/file.js:75` 的 `recoveryRowsPath()`，工具执行 / 部分正文落盘时由引擎 `appendRecoveryRow` 写，fresh start 时 `clearRecoveryRows` 直接删文件）。本站口径不变：**只读 `.jsonl` 那一份**（`portal/src/delegation.js` 的路径构造只拼 `<childRunId>.jsonl`，§4.4c 的 `hasTranscript` / 8 MiB 上限 / 坏行跳过全部只管它），恢复行文件**不认识也不读**（本站 #301 不开 `partialPersistence` ⇒ 今天子 run 写不写它都不影响界面）；但列目录 / 算磁盘空 / 写清理脚本的人要知道它存在，**一个子 run 不再只对应一个文件**。**路径只能由两个 id 拼**：`runId` 必须是 uuid、`childRunId` 必须是 `sub-<uuid>`，两个正则锁死后 `path.resolve` + 前缀断言；调用方传不了任何路径片段（`portal/src/delegation.js`，不复用 `dirs.js#resolveJailedFile`——它的 jail 根是 `projects/<name>`，与本单不是同一棵树）。

鉴权同 `GET /api/sessions/:id`（`fetchSession` 同一个 404，不泄露存在性），再叠两层：**`runId` 必须属于该会话**（查 `runs` 表）、**`childRunId` 必须出现在该 parent 的名册里**（形状合法不等于存在）。`runId` 是**必填** query 参数（名册按父 run 分片，没有父身份就不知道该读哪个目录）。

```
GET /api/sessions/:id/delegates?runId=<parentRunId>
  → { "items": [ <DelegateItem> … ], "skipped": 0 }          // createdAt 升序
GET /api/sessions/:id/delegates/:childRunId?runId=<parentRunId>&tail=100
  → { "childRunId": "sub-…", "state": "completed", "messages": [ … ], "truncated": false, "totalTurns": 3 }
```

**`items[]`（`DelegateItem`）是逐字段白名单**，不是名册记录原样下发（里面还有 `resultText` 整段子 run 终稿、`pid`、`statusPath`、`verification`、`taskDigest`、`budgetSource`，下发它们等于把 UI 没要的东西变成契约）：

| 字段 | 类型 | 口径 |
|---|---|---|
| `childRunId` | string | 名册**文件名**（引擎同裁定：记录里的 `runId` 与文件名不符 = 损坏件） |
| `state` | string | 名册七值枚举，见下；非字符串 ⇒ 该文件计进 `skipped` |
| `cwd` / `model` | string \| null | 子的 cwd（P1 沿用父的）与模型；缺位 `null` |
| `createdAt` / `endedAt` / `updatedAt` | number \| null | 毫秒 epoch（引擎 `updatedAt` 是单调水位） |
| `termination` | string \| null | **引擎 reason 字符串**（见下方红线）；对象形态一律 `null` |
| `errorMessage` | string \| null | 子 run 抛错时的错误文本（引擎侧截到 1000 字符） |
| `resultTruncated` | boolean | `resultText` 被截断过（不下发正文本身，只要它） |
| `hasTranscript` | boolean | 账本在不在——**只用 `existsSync` 填**，不为此读文件内容 |

`skipped` = 被跳过的坏名册件数（JSON 解析失败 / 非对象 / `runId` 与文件名不符 / `state` 非字符串）。**一个坏文件不打成 500**：名册是普通 JSON 文件，而抽屉每 2s 轮询一次。名册目录不存在 ⇒ `{ "items": [], "skipped": 0 }`（**不是 404**：「还没派过子 run」与「刚点下 delegate、文件还没落」都是正常态）。原子写的临时件 `<id>.json.tmp-<pid>-<n>` 不算候选，也不计进 `skipped`。

`messages[]` 是**与主对话同形**的 turn：上游 `projectTranscriptForDisplay` 的输出（`role`/`text`/`blocks`/`toolCalls`/`reasoning`/`round`/`ts`/`key`/`meta` 逐字透传，#95 红线）上叠四个宿主字段 `id`（`<childRunId>:<全量下标>`）/ `seq`（全量下标，所以向前翻页时同一条消息的 id 不漂移）/ `run_id`（= `childRunId`）/ `created_at`。⚠ `created_at` 是**轮行落盘时刻**（投影的 `ts` 读的是载体行），不是消息成型时刻，只当轮级时间戳用。

**折叠与切尾的顺序（不得改）**：读全量行 → `portal/src/transcript-fold.js#foldLedgerRecords` → `projectTranscriptForDisplay` → **才** `slice(-tail)`。在原始行上切会把一轮切成半轮（`:msg:<round>:<seq>` 分片行与它的载体行分散在切界两侧），折叠拿到缺片的一轮 ⇒ 工具结果配不上对（#337 的老病根）。⚠ `foldLedgerMessages` / `foldMessageRows` **不在 `erix-agent` 的导出面**（实测 `undefined`，深引被包 `exports` 挡），所以用的是本站镜像——它正是 `runner/lib/store.js#load` 用的同一份口径（两份 `SHARED-FOLD-CORE` 逐字节对拍，AGENTS §8.52），也是上游读侧的**超集**（多一道 `partOf` 解链闸）。本站两条入口共用同一份 `planFold`：`session-view.js` 走 `foldTranscriptRows`（DB 行）、这里走 `foldLedgerRecords`（文件记录），不是两套规则。

**参数与错误**

| 情况 | 结果 |
|---|---|
| `runId` 缺席/空串 | `400 validation_failed`，`details.field='runId'` |
| `runId` 不是 uuid（含 `runId=../../etc`） | `400 validation_failed`，`details.field='runId'`，**零文件读** |
| `childRunId` 不是 `sub-<uuid>` | `400 validation_failed`，`details.field='childRunId'`，零文件读 |
| `tail` 非 1..500 的整数（缺省 100） | `400 validation_failed`，`details.field='tail'` |
| 会话不存在 / 不属本人 / 已归档 | `404 not_found`（`session not found`，与 §4.2 逐字相同） |
| `runId` 不属于该会话 | `404 not_found`（`delegate not found`，不泄露 run 的存在性） |
| `childRunId` 不在该 parent 的名册里 | `404 not_found`，`details.reason='not_in_roster'`（**不碰账本文件**） |
| 账本文件不存在 | `404 not_found`，`details.reason='no_transcript'`（名册在、账本没落 ⇒ 前端给 `starting` / `no_transcript` 空态） |
| 账本 > 8 MiB | `413 payload_too_large`，`details={size,max_bytes}`（**先 `stat` 再读**，超限一个字节都不进内存） |

成本红线：`hasTranscript` 不读内容；名册目录不存在 ⇒ 零账本读；账本读取先 `stat` 判 8 MiB 上限（与 `session-partial-output` 的成本口径同族：单文件有上限，超了就 413 并提示）；账本里的坏行/空行（崩溃截断的最后一行是常态）跳过而不是 500。

> **红线：`state` 是名册词汇（7 值：`queued` / `running` / `completed` / `failed` / `aborted` / `timeout` / `interrupted`），`termination` 才是引擎 reason。**
> 引擎的 `TERMINATION_TO_STATE` 把未列出的一切判成 `failed`，而 P1 已把本站当正常收尾的 `no_tool` / `continuation_exhausted` 归一成 `end_turn` ⇒ 这类子在名册里是 `completed`。所以 **UI 分级以 `termination` 为准、过 `portal/frontend/src/lib/terminationReasons.ts`（`RUN_TERMINATION_SYSERR_REASONS`），不要只看 `state`**——只看 `state` 会把 `persistence_failed` / `final_guard_unverified` 这些该红的终态染成绿色。本模块只透传不归一（写侧的词汇封闭性是引擎的不变量，读侧拿它当过滤器只会藏掉真子 run）。

另两条已知边界（不是 bug，设计 §9）：名册与账本无 TTL，会累积（清理是后续期）；子共用父 cwd ⇒ 写并行会互踩，对外只说「上下文隔离 + 读密集并行」。

### 4.5 `POST /api/sessions/:id/stop`

停止当前 run。`AbortController` 跨不了进程（规格 §10.3）——portal 写 DB `cancel_requested_at` 标记 + 状态推进，按当前 `runs.status` 走**两条路径**（**#277** 定稿；实现：`sessions.js stopSession`，同事务内两步**条件更新（CAS）**，禁止先查后改）：

| 当前状态 | 结果 | 为什么 |
|---|---|---|
| `queued`（从未被 worker 领起） | **直接进终态** `finished`，`termination = {"reason":"aborted","detail":"cancelled_before_start"}`，写 `ended_at`，并**同事务从 `run_queue` 摘掉**（queue → `cancelled` + 清 `claim_token/owner_container_id/lease_until/claimed_at`，口径同 §9.11 release / reaper A2） | 没有任何执行体会去报它的终态：`cancelling` 被认领 SQL 排除（§9.3/A2）、终态又只能由 worker 经 U2 写、也不在 reaper 候选集（`q.status='claimed'` 且租约过期）——旧实现在此也写 `cancelling`，导致该 run 永久卡住、会话 `active_run_id` 恒非空 ⇒ UI 恒「运行中」+ 新消息恒 409 `run_in_progress` |
| `running` | → `cancelling`（**不等终态**） | 已执行过、正在等 worker 报终态：worker abort 后经 U2 收敛 `finished`（`termination.reason='aborted'`）或 `failed` |

请求体：无。**`Content-Type` 也不再强制**（issue #236 第 2 条）：无 body 且未带该头 ⇒ 直接按空体处理；
带 body 时仍必须是 `application/json`（逐格口径见 §1.5）。⚠ 前端仍发 `body:'{}'`（带 json 头），
这里放宽的是**手工客户端**那一侧：`curl -X POST .../stop` 不再 400。

响应 `200`（`run.status` = 本次写入的真实状态，不再是写死的 `cancelling`）：

```json
{ "run": { "id": "9d3b2f1e-...", "status": "finished" } }   // queued 分支
{ "run": { "id": "9d3b2f1e-...", "status": "cancelling" } } // running 分支
```

最终终止结果通过 SSE 的 `run_end` 事件（`termination: { "reason": "aborted" }`，依据：erix-agent v0.3.5 `src/loop.js:712`）与 run 状态收敛体现；前端调本端点后应继续听 SSE，不要轮询。**两条路径的 SSE 差别**：`running` 分支的 `run_end` 由 worker 的 U2 终态合成；`queued` 分支无 worker 参与，portal 已把行写终态（本端点不合成 `run_end` 事件行）——前端的「运行中」靠重取会话详情的 `active_run_id` 摘除。

幂等：重复停止仍 `200`（命中已在 `cancelling` 的行，或本端点已写入的 `termination.detail='cancelled_before_start'` 终态行），**零新增副作用**。

错误：`404 not_found`；`409 no_active_run`（无进行中 run）。

> ⚠ **未覆盖（#277 下一片）**：`running → cancelling` 后若容器死掉 / worker 再不报终态，`cancelling` 无人收敛（reaper 只看已领起且租约过期的行，认领 SQL 又排除 `cancelling`）。心跳 `stop_run_ids` 只把停止信号送给**还活着的** worker，不是通用兜底。

### 4.5a `POST /api/sessions/:id/ai-title`（issue #114：AI 改名）

按需（用户点按钮）调**一次** OpenAI 兼容 `chat/completions`，为会话生成 ≤30 字标题。属主鉴权同 §4.2 `PATCH`（非属主/不存在/已归档 → `404 not_found`）。

- **上下文**：该会话最早的 3 条 `user` 消息，各折叠空白并截断 200 字符；要求模型只输出标题本身。
- **provider 解析**：仅使用会话属主 FDE 的 active LiteLLM binding；Station 存储槽位 `model_info.id`，请求体使用配套 LiteLLM `model_name`。不回退已退役的 Station provider/model 目录；没有有效 binding → `409 llm_not_configured`。
- **调用**：`POST <llmGatewayUrl>[/v1]/chat/completions`（`llmGatewayUrl` 已含 `/v1` 则不重复拼接），使用 per-FDE virtual key，超时 15s。
  工单 261020-04（#315 追加）起，这条请求由 **`portal/src/llm-chat.js`** 代发（portal 侧**对话调用面**的唯一出口：
  URL 拼接 / `max_tokens` 必发 / 超时 / 错误映射 / key 只进 `Authorization` 头都在那里）；`sessions.js` 只做会话业务。
  `llm.js` 仍是**网关管理面**，不发对话请求。⇒ 本端点的 HTTP 面（状态码 / `error.code` / 文案）与收口前一致。
- **请求体固定带 `max_tokens: 512`（#315）**：不发时 LiteLLM 会注入该 deployment 的 `litellm_params.max_tokens`
  （#309 切片 1 起 = 模型级「单次输出预算上限」，现网 32768），那是给整个模型设的预算、不是给一行标题设的；
  `context_window` 被配得很小时（管理员笔误）上游会按「prompt + 预留 32768」判超限 ⇒ **这条请求被拒**，症状是
  「点了 AI 改名没反应」（不是 run 失败）。**#322 起这个数只有一个落点**：`portal/src/title-llm.js`
  的 `TITLE_LLM_MAX_TOKENS`，它等于 `llm-chat.js` 的缺省值 `LLM_CHAT_DEFAULT_MAX_TOKENS`（512）——
  不再是「两条路径各自写一遍、靠跨文件读源码的锁提醒对面」。`portal/test/session-ai-title.test.js` 因此改钉
  两个方向：值仍是 512（#315 的结论不变）+ **`runner/lib/session-title.js` 必须不存在**（存在 = 重复复活）。
- **落库**：响应经 `sanitizeTitle` 清洗（去引号/取首行/截 30 字）后写 `title` + `title_source='manual'` + `updated_at`；推一条 `session_updated`（同 #88/#107，不落 `run_events`）。
- **「例外」已消失（#322，2026-10-20）**：本端点过去被记成「portal 不持 LLM 客户端」这条原则的**例外**（用户拍板于
  2026-10-01，#114，仅限本端点）。两件事让它不再是例外：① **那条原则的出处本来就是我记错的**（#88 原文是「只动 portal +
  前端展示；runner/agentd 零改动（标题是 portal 会话元数据，不是引擎事务）」，方向相反）；② **#322 把标题统一到 portal 侧**
  ⇒ portal 是标题的**唯一实现点**，不存在「破例」。现在的分层：`sessions.js` / `session-title.js` = 会话业务，
  **`title-llm.js` = 标题业务**（prompt / 输入截断 / provider 解析 / 降级），**`llm-chat.js` = 对话调用面唯一出口**，
  `llm.js` = 网关管理面（不发对话）。**「自动改名」也在这里**：run 终态后由 portal 用会话最后一段助手文本生成，
  不经容器（§9.6 `title` 字段）。
- ⚠ **接线的硬要求（#322 真机取证；v0.1.20 曾因此静默降级整整一个版本）**：自动改名跑在 `internal.js` 的终态链里，
  那里没有现成的 config ⇒ **`http.js` 必须把 `ctx.config` 交给 `setRunState`，`finishRun` 再透传给 `scheduleAutoTitle`**。
  少任何一跳 ⇒ `title-llm.js` 退回默认网关 `http://127.0.0.1:4100`，而**该地址在 portal 容器内是 ECONNREFUSED**
  （数据面在容器内只能走 `LLM_GATEWAY_ADMIN_URL=http://station-litellm:4000`）⇒ **门槛命中后的每一次生成都静默失败**，退到「首条用户消息截断」，
  而界面**看不出异常**（标题照样会变，只是不是模型起的）。⚠ **别与另一条独立的静默路径混淆**：防抖门槛未命中时
  （已有标题且 `auto_title_seq IS NULL` ⇒ 需 ≥3 轮新 user 消息）整段直接 return，**连 warn 都不发**——
  「标题是首条消息」不等于接线坏了，两者靠日志区分（有 warn = 接线/网关，无日志 = 门槛没命中）。
- **key 纪律**：LiteLLM virtual key 只进 `Authorization` 头，**绝不进日志/错误信息/响应**（上游回显的 key 亦被脱敏）。

请求体：无（空 JSON `{}`）。

响应 `200`：

```json
{ "session": { "id": "s_1", "title": "登录页白屏修复", "title_source": "manual", "...": "..." } }
```

错误：

| HTTP | code | 场景 |
|---|---|---|
| 404 | `not_found` | session 不存在 / 不属本人 / 已归档（同 §4.2 PATCH） |
| 409 | `llm_not_configured` | 无 FDE binding 且无启用的 text provider+model |
| 409 | `no_user_messages` | 会话还没有用户消息（无可用上下文） |
| 502 | `llm_upstream_failed` | 上游超时 / 非 2xx / 响应无可用标题。`details` 给结构化原因（`{reason: 'timeout', timeoutMs}` / `{reason: 'network'}` / `{reason: 'upstream_status', status}`），**只放状态码与耗时上限，绝不含 key**（#255 起沿用的 `details` 附加结构，见 §2 错误体） |

### 4.6 `GET /api/runs/:id`

run 详情（Run 对象，§4.1）。用于查看已结束 run 的 `termination` / `usage` / `error`（如 `checkpoint_failed`），以及审批卡片跳转。

### 4.6a `GET /api/runs/:id/artifact`（issue #64 R1）

run 终态产物 bundle 取回（runner §6.6）。鉴权：**admin 或 run 属主**（session cookie；非属主 404，不泄露存在性——与 §4.6 同口径）。

- 该 run 有产物（agentd 终态清场前经 U13 上传）→ `200`，`Content-Type: application/gzip` 流式返回 tar.gz（`Content-Disposition: attachment; filename="<runId>.tar.gz"`；`X-Artifact-Truncated` 标记是否被 20MB 上限截断）。包内结构：`diff.patch`（git diff HEAD，含 staged）+ `files/NNNNNN`（新文件快照，真实路径见 manifest）+ `manifest.json`。
- 无产物（空变更未上传 / run 不存在 / 非属主）→ `404 not_found`。

### 4.7 端口列表

> 本节只覆盖**已退役的项目维度**列表与未交付的 `PATCH /api/ports/:id`。**现役的列端口端点（本人 / 管理员）与
> 管理员改块（= 搬迁）在 §4.7a**（issue #246 交付②）。

> ⚠ **实现状态（#242 端点全量自检，2026-10-11 实测）**：本节只描述 `GET /api/projects/:id/ports`（已退役 `410`，留档只读）与 `POST /api/ports/:id/preview-ticket`（活端点）。
> 而 **`PATCH /api/ports/:id` 没有实现**：`http.js` 用户面分派（401–583）无该分支，只有 `preview-ticket` 一条子路径正则；真机 `PATCH /api/ports/<真实 id>` → `404 not_found`。
> 下方的 `200 / 403 / 400 / 404` 契约属**未交付的写入口**（读侧 `exposure` 免票判定在 `preview.js` 已实现）——**已裁决不交付**（#250）。
> 理由：预览不对外分享（测试环境会被当成生产），而 `public` 的语义就是「拿链接就能打开」——补这个写入口等于主动开门。
> 真要把契约补上，口径是：**UPDATE + 一行审计 + materialize revision，同事务，不碰 route outbox**
> （实测：`routes.js` 零 `exposure` 分支，每条 router 一律挂 forwardAuth，可见性由 portal 每请求动态判——**不需要重建路由**；
> 要 materialize 只因 `materializer.js:109` 会把 `exposure` 带进容器内 `ports.json`，否则 FDE 自己看到的可见级别是过期的）。

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

### 4.7a 预览端口列表与管理员改块（issue #246 交付②）

> **为什么要这三条端点**：`GET /api/projects/:id/ports` 随 P5 退役后，**没有任何列端口的 API**，
> 而签票端点 `POST /api/ports/:id/preview-ticket`（§2.8）吃的是 allocation **UUID** ⇒ 普通 FDE 只能靠人
> 查库。#240/#241 的浏览器验收因此全部是主 agent 手工 curl 签票。本节的读端点就是那条缺失的路（单 B 面板拿 `id` 用它）。
> **实现**：`portal/src/http.js`（分派/校验/错误映射/审计）+ `portal/src/portalloc.js`（取数与搬迁事务）；
> 常量仍只来自 `portal/src/previewpool.js`（池 `22000–29999`、每段 10 个、预算 55）。

#### 共同 DTO（两个列端点同形同序）

响应 `200`（信封照既有列表端点 `{ "items": [...] }`，§1.3）：

```json
{
  "items": [
    {
      "id": "7b0a1f2e-9c3d-4e5f-8a6b-1c2d3e4f5a6b",
      "port": 22000,
      "hostname": "alice-p-22000.fde.erix.vip",
      "url": "http://alice-p-22000.fde.erix.vip:8090",
      "state": "allocated",
      "scope": "fde",
      "role": "spare",
      "exposure": "private",
      "observed": {
        "pid": 412,
        "cwd": "~/projects/shop",
        "cmd": "node vite.js",
        "branch": "feat-x",
        "started_at": "2026-10-24T09:00:00.000Z",
        "observed_at": "2026-10-24T12:00:15.000Z"
      }
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | `port_allocations.id`（UUID）——**签票端点的路径参数**，缺它本端点就没意义 |
| `port` / `hostname` / `url` | 号池里本 FDE 那个对齐块的成员；`url` 与路由同源生成（规格 §8.1/§8.5），前端只展示/跳转 |
| `state` | `allocated` \| `active`（首次 forward-auth 放行才升 `active`，规格 §8.6）；**已 `released` 的行不列** |
| `scope` / `role` / `exposure` | 恒 `fde` / `spare` / `private`（#250 裁决：`private` 是唯一交付档位） |
| `observed` | 观测层 MVP（迁移 `0022 port_observations`）：容器内该端口**此刻真有进程在听**的旁证——agentd 采样 `/proc`（LISTEN 端口 + pid + cwd + cmdline + git 分支 + 启动时刻）随 U4 heartbeat 捐带，portal 按新鲜度窗口（45s = 心跳 15s ⚠ × 3，同「连丢判死」口径）附进 DTO。**只读观测用于展示，不是管控**（#246「不检查不限制不 reconcile」不变式不动）。⚠ **`null` ≠ 空闲**：旧 agentd 不上报 / 未跑 0022 的部署也是 `null`；前端不得把 `null` 渲染成「没有应用」。同目录 ≥2 个监听（两个分支各占一口）是前端冲突警告的判据。采样失败整块降级（全 `null`），列表照常。**#468 补两句口径**：① 反推不出项目的观测（`cwd` 是 `~`/`/tmp` 这类非项目目录，或跨 uid 读不到 ⇒ `null`）**照常下发**，服务端不裁；② 「未知项目」的分组是**前端展示层**的裁定（`lib/previewPorts.unknownProjectItems`），**DTO 不新增字段**、不新增行类型 |
| 池外合成行 | 观测到的监听**不在号池里**（如 vite 默认 5173）时，列表额外合成一条**只读行**：`id="observed:<port>"`、`hostname`/`url` = `null`、`state="observed"`、`role="unrouted"`。无地址可开、无票可签（批量签票跳过它），但「这个目录起了服务」对人可见——否则面板会谎报「当前目录没有」。⚠ **#468 D4 放宽**：只排除**平台自己的代码目录**（`/opt/erix` 及其子目录 = agentd/worker 运行时，不是用户的任何项目），其余一律合成——**含 `cwd = null` 的跨 uid 观测与 `~`/`/tmp` 这类反推不出项目的观测**（旧口径「只合成 `~/projects/` 下、其余整条丢弃」会把用户真实的服务凭空抹掉）。Docker 内嵌 DNS `127.0.0.11` 不在这里挡，它在采样侧就被摘掉（#468 D5，`runner/lib/listeners.js` 按 `/proc/net/tcp` 地址段 `0B00007F` 排除） |

**只列活行**（`state <> 'released'`）、**按 `port ASC`**；不游标分页（一块 = 10 行，上限可预期）。

#### `GET /api/me/ports`

任何已登录用户可调用，返回**自己**的活行。未登录 → `401 unauthorized`（既有口径，本端点不自造）。
**admin 自己通常没有 FDE**（`users.fde_name IS NULL`）⇒ `200 {"items": []}`，**不是 404**。
本人读自己的资源**不写审计**（forward-auth 已经逐请求留痕，§2.7）。

#### `GET /api/admin/fdes/:fdeName/ports`

`requireAdmin`（同其它 `/api/admin/*`，非 admin → `403 forbidden`）。错误码：

| HTTP | code | 场景 |
|---|---|---|
| 400 | `validation_failed` | `:fdeName` 不符合 `FDE_NAME_RE`（`details.field='fde_name'`，同 `git-credential`/`provision` 端点） |
| 404 | `not_found` | **未知 `fdeName`**（复用 admin 面现有码，不新造）。停用中的 FDE 仍算「已知」⇒ 回 `200 {"items": []}`（offboarding 只停用不删号，它的行全已 `released`） |

**审计口径**：读他人资源**必须显式写一行** `audit_log`（不假定框架已自动写——评审已查实现有 admin GET 未一致落实审计）：
`action='admin.fde_ports_listed'`、`actor_id=` 管理员用户 id、`target=` 被读的 FDE 名、
`details={fde_name, item_count}`。**恰好一行**（多写也算噪声）；`400/403/404` **不写**审计。

#### `GET /api/admin/preview-ports/usage` —— 号池占用总览（issue #256 交付①）

`requireAdmin`（同其它 `/api/admin/*`，非 admin → `403 forbidden`，**零新错误码**）。**只读**：
一条 `SELECT` 取全局活行端口 + 所属 `fde_name`（`LEFT JOIN users`），不写库、不入队 outbox/revision、不开事务。

存在的理由：改块（上一条端点）原本只能填一个数字试错，撞 `409 preview_port_block_taken` 才知道那段被占。
本端点把「哪几段被占、哪几段整段空闲」一次算清楚 ⇒ 管理员**先选空闲段**再改块。

下面是 `GET /api/admin/preview-ports/usage?limit=3` 的响应（示例里每个数字都互相能推出来，见紧随其后的算术）：

```json
{
  "pool": { "start": 22000, "end": 29999, "block_size": 10, "total_blocks": 800 },
  "occupied_blocks": [
    { "start": 22000, "end": 22009, "occupied_count": 10, "fde_names": ["eric"] },
    { "start": 22010, "end": 22019, "occupied_count": 3, "fde_names": ["bob", "eric"] },
    { "start": 22050, "end": 22059, "occupied_count": 1, "fde_names": ["dana"] }
  ],
  "free_blocks": { "items": [22020, 22030, 22040], "has_more": true, "limit": 3 },
  "summary": { "total_blocks": 800, "free": 797, "partial": 2, "occupied": 1 }
}
```

示例自洽（逐字段可推）：`occupied_blocks.length` = 3 = `partial` 2（22010 占 3 个、22050 占 1 个）+ `occupied` 1（22000 占满 10 个）；
`free` = `total_blocks` 800 − 3 = 797；三类之和 797 + 2 + 1 = 800 = `total_blocks`；
`limit=3` ⇒ `items.length` = 3 且是**升序的前 3 个**空闲段（22000/22010 被占 ⇒ 从 22020 起；22050 被占 ⇒ 跳过它），
`has_more=true` 因为还有 797 − 3 = 794 段没列出来。

| 字段 | 口径 |
|---|---|
| `pool` | 号池边界 / 块大小 / 段总数，**全部从 `previewpool.js` 推导**（端点实现里零端口字面量，单测有源码级断言） |
| `occupied_blocks` | **只列有活行的段**，按 `start` 升序。占用判据 = **全局活行**（`state <> 'released'`，不分 FDE / scope / role），与迁移 0019 的 `port_allocations_live_global_port_key` **同口径**；`released` 行**不占位**（号码可回收是 #246 的硬判据） |
| `occupied_count` | 该段活行数（`released` 不计） |
| `fde_names` | **数组**（按名字升序、去重）。单端口覆盖可以造出「一段里多个 FDE」的 mixed 形状 ⇒ 只显示第一个会骗人 |
| `free_blocks.items` | **整段无人占用**的对齐块起点，升序，默认前 `50` 段（`?limit=` 可改）。段内有 1 个活行就整段不进这里（与 `firstFreePreviewBlockStart` 的整块跳过一致，避免把外来行侵吞进自己的段里） |
| `free_blocks.has_more` / `limit` | `has_more=true` ⇒ 还有更多空闲段没列出来（等价于 `summary.free > items.length`）；`limit` = 本次 `items` 的条数上限 |
| `summary` | `partial` = 该段被占 1–9 个；`occupied` = 占满整块。`free + partial + occupied == total_blocks`，且 `partial + occupied == occupied_blocks.length`（数的是**全部**段，不是列出来的那几条） |

`?limit=` 口径：**缺省 / 空串（`?limit=`）= 不修改 ⇒ 用默认值 50**（与门户「留空 = 不修改」的既有语义一致）；
给值则必须是 `1–800` 的整数，否则 `400 validation_failed` + `details.field='limit'`（复用既有码，**零新错误码**）。
空白串（`?limit=%20`）**不是**空串 ⇒ 按非法值 400（口径边界不含糊）。
**审计口径**：读他人资源**必须显式写一行**（照 `admin.fde_ports_listed` 的先例）——
`action='admin.preview_ports_usage_listed'`、`target='preview_port_pool'`、
`details={total_blocks, free_count, occupied_block_count, limit}`。**恰好一行**，且 `details` **不放整份响应体**
（那是一张号池快照，抄进审计表等于多一份会漂移的副本）；`400/403/405` **不写**审计。

#### `POST /api/admin/fdes/:fdeName/ports/block` —— 改块 = **搬迁**

请求：`{ "block_start": 22010 }`。语义是**整段搬到新块**，不是「再发一块」：
`ensureFdePreviewPorts` 是 insert-only（`portalloc.js` 全文件零 `UPDATE port_allocations`），
**只复用它补一段会留下 20 条活行**（旧 10 条继续占号、旧域名继续可访问）——所以旧行必须在本事务里释放。

校验顺序即判据（①② 在任何 SQL 之前，③ 零写，④ 零残留）：

| 序 | 条件 | HTTP / code |
|---|---|---|
| ① | `block_start` 不是整数 / 不在池 `22000–29999` 内 / 未按 10 对齐 | `400 validation_failed`（`details.field='block_start'`，文案给合法起点） |
| ② | FDE 名超预览域名预算（§1.2 的 `preview_hostname_invalid`，预算 55） | `400 preview_hostname_invalid`（**不降级为 warn**） |
| ③ | 目标块已经是本 FDE 的**整块**活行 | `200 {"changed": false, …}`，**零 SQL 写、零入队、零审计**（幂等） |
| ④ | 目标块内有**外来**活行（占用判据 = 全局活行 `state <> 'released'`；本 FDE 自己的活行不算冲突） | `409 preview_port_block_taken`（**禁止**「偷偷换成第一个空闲块」，文案要点名被占的号与下一步动作） |
| ⑤ | 事务内插入数 ≠ 10（并发抢号被 `ON CONFLICT … DO NOTHING` 吃掉） | `409 preview_port_block_taken` + 整笔回滚（**不许部分提交**） |

成功 `200`：

```json
{
  "changed": true,
  "fde_name": "alice",
  "block_start": 22010,
  "block_end": 22019,
  "ports": [22010, 22011, 22012, 22013, 22014, 22015, 22016, 22017, 22018, 22019],
  "released_allocations": 10,
  "revoked_grants": 0,
  "inserted_allocations": 10
}
```

**原子性（实现契约，测试逐序钉住 `portal/test/preview-ports.test.js`）**：单事务、固定顺序

```
BEGIN
 → SELECT 本 FDE 活行端口 → SELECT 全局活行端口        ← ③④ 在此判定，两者都不写库
 → UPDATE port_allocations SET state='released', released_at=COALESCE(released_at, now())
 → UPDATE preview_grants SET state='revoked', revoked_at=COALESCE(revoked_at, now())
                                       WHERE allocation_id = ANY(...) AND state='active'
                                                     ← 两句照 offboarding 的先例写法，**只动 state='active'**
                                                       （`used` 保留原状、撤权**无条件发**，#252；见 §2.8「撤 grant 的口径」）
 → 10× INSERT … ON CONFLICT (fde_id, port) WHERE state <> 'released' DO NOTHING RETURNING id
 → route_revisions → route_outbox（每条新 allocation 一条）
 → materialize_revisions → materialize_outbox（每 FDE 一条）
COMMIT
```

- 任一步失败 ⇒ 整笔 `ROLLBACK`，**零残留**（旧行仍活、无新行、两条 outbox 都没新行）。
- 派生链照旧同事务入队 ⇒ Traefik 路由与 `~/.erix/ports.json` 自动跟上（旧 host 的路由消失、新 host 出现），
  不需要人工 `enqueueFullRebuild` / `runMaterializerOnce`（规格 §8.2「派生必须自动」）。
- `released` 行**不占位** ⇒ 号码可回收：搬出去再搬回**同一块**必须能成功（测试钉住）。
- `released ⇔ released_at` / `revoked ⇔ revoked_at` 是 DB CHECK，两句 UPDATE 都写时间戳且不覆盖既有值（`COALESCE`）。

**审计口径**：真搬了才写一行 `action='admin.fde_ports_block_moved'`、`target=` 该 FDE 名、
`details={fde_name, from_block_start, to_block_start, released_allocations, inserted_allocations, revoked_grants}`；
`changed:false`（幂等空操作）按上表③ **不写审计**；`400/409` 不写。

#### `POST /api/me/ports/batch-tickets` —— 一键放行整组（issue #247）

> **为什么要它**：预览票是 **host 级**的（一张票只绑一条 allocation / 一个 host，§2.8），而一个 FDE 拿到的是
> **一整段** `PREVIEW_PORT_COUNT`（默认 10）个 host ⇒ 前后端分离的应用（前端 22000 + 后端 22001）
> 要逐个点「打开预览」，真机实测「跳 host 要点 2 次」。本端点把「一次点击 = 签 N 张票」变成**一次请求**，
> 前端一次点击开 N 个标签页。**票的语义一个字没变**（仍然一次性、60 秒、host 级、逐张落 `preview_grants`）。

请求体（可选字段）：

```json
{ "allocation_ids": ["7b0a1f2e-…", "8c1b2a3f-…"] }
```

- 不给 `allocation_ids`（或给 `null`）⇒ **本 FDE 全部活行**（`state <> 'released'`，含 P5 前的
  `scope='project'` 遗留行），按 `port ASC` —— 这就是「一键放行整组」。
- 给了 ⇒ 只签这些行，**响应顺序 = 请求顺序**（前端按序开标签页）；重复的 id 是 `400`（同一行签两张票只会浪费一张）。
- 上限 = **`PREVIEW_PORT_COUNT`**（`portal/src/previewpool.js`，与号池块大小同源 = 10，**不写死数字**）。
  隐含集合（不给 `allocation_ids`）同样受这个上限约束：活行超上限（历史遗留形态）⇒ `400`，请显式分批传 id。

响应 `201`（信封照既有列表端点 `{items:[...]}`，§1.3）：

```json
{
  "items": [
    {
      "id": "7b0a1f2e-9c3d-4e5f-8a6b-1c2d3e4f5a6b",
      "port": 22000,
      "url": "http://alice-p-22000.fde.erix.vip:8090/?preview_ticket=pt_…",
      "ticket": "pt_…",
      "expires_at": "2026-10-23T12:01:00.000Z"
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` / `port` | 这条票对应的 allocation 与端口（前端按 `id` 把票对回列表行；顺序已与请求一致） |
| `url` | **已带 `?preview_ticket=` 的完整地址**（与单据端点 §2.8 同形同口径：scheme/端口按公开入口派生，前端不得自行拼接） |
| `ticket` | 一次性短效 token（只存 `sha256`，§2.8） |
| `expires_at` | ISO 时间戳；**整批共用一个**（同一个签发时刻 + 同一份 `PREVIEW_TICKET_TTL_SECONDS`）⇒ 前端不需要为每张票各算一次 TTL。单据端点给的是 `expires_in`（秒），本端点给绝对时刻，理由：一次开 N 个标签页时「各自剩多少秒」没有意义，**必须立刻开**才是判据 |

校验顺序即判据（①② 在任何 SQL 之前）：

| 序 | 条件 | HTTP / code |
|---|---|---|
| ① | `allocation_ids` 不是数组 / 空数组 / 含非 UUID 串 / 含重复 / 超过 `PREVIEW_PORT_COUNT` 项 | `400 validation_failed`，`details.field='allocation_ids'`（**零 SQL**、零签发） |
| ② | 任一 id **不属于本人 FDE** / 不存在 / 对应行已 `released` | `404 not_found`（三种情况回**同一句**：否则就是存在性探针；与单据端点 §2.8 同码） |
| ③ | 隐含集合的活行数 > `PREVIEW_PORT_COUNT` | `400 validation_failed`，`details.field='allocation_ids'` |
| ④ | 限流（按「用户 + IP」，`PREVIEW_TICKET_RATE_LIMIT_*`）已满 | `429 rate_limited`（`retryable=true` + `Retry-After`，与单据端点同码） |

- **零新错误码**：上表四个码全部是既有码（`validation_failed` / `not_found` / `rate_limited`），本端点不新增任何 `error.code`。
- **`retryable` 语义**：只有 `429 rate_limited` 是 `retryable=true`（等 `Retry-After` 后重试同一请求是安全的——本端点
  不落任何业务状态）。`400`（形状/上限）与 `404`（归属）重试同一请求必败，`retryable=false`，要先改请求。
- **限流按张计数**：一次请求签 N 张就吃掉 N 个配额（`check` 一次 + 逐张 `recordFailure`）⇒ 批量**不会**把
  `20/60s` 放大 10 倍；被限流的那次**一张都不签**。
- **原子性（对外「要么全成、要么报错」）**：不开大事务（每张票是一次独立 INSERT，读者逐张独立消费，
  包进一个事务不会更原子，只会白占连接）。实现是「**先全量预检 → 再逐张签发 → 失败补偿**」：
  预检（①②③）在任何签发之前完成 ⇒ 越界/超限这类可预期失败**零写入**；签发途中的意外（并发下 allocation 被释放、
  DB 抖动）会用一条 `UPDATE preview_grants SET state='revoked', revoked_at=COALESCE(revoked_at, now())` 把本批
  **已签的票全部收回**再抛错（既有 `500` 口径）⇒ 既**不返回半截 `items`**，库里也不留 60 秒内还能换预览 cookie 的残票。
- **审计：逐张各写一行**（`action='auth.preview_ticket_issued'`、`actor_id`=签发者、`target`=该行的预览 host、
  `details={grant_kind:'ticket', allocation_id, port, token_hash_prefix, expires_at}`）。口径照 §2.8 B3：
  **绝不入 ticket 明文、也绝不入带票的 `url`**（与 forward-auth 审计的 `pathOnly` 同一条纪律）；
  `400/404/429` **不写**审计。
  ⚠ 单据端点 `POST /api/ports/:id/preview-ticket` 目前**写零行审计**（实现现状，见 §2.8），本端点是**新增**这条审计，
  不改单据端点（`preview.js` 的 `issuePreviewTicket` 一字未动，签发口径仍只有一份）。
- **实现**：`portal/src/http.js#handleBatchPreviewTickets`（分派/校验/限流/审计）+ 复用
  `portal/src/preview.js#issuePreviewTicket`（**不复制签发逻辑**：幂等/哈希/过期/TTL 只有一份）；
  测试 `portal/test/preview-ports.test.js` 的 `#247①~⑧`。

#### 自动选块的冲突重算（补交付① 的已知边界，无新契约但影响本端点的用法）

`provisionFdePreviewPorts`：**未**显式指定 `blockStart` 时遇 `preview_port_block_taken` ⇒ 开**新事务**重算
（重取全局占用 → 取下一个整块空闲对齐块），**总尝试上限 3 次**（首试 + 重算 2 次，`PREVIEW_BLOCK_MAX_ATTEMPTS`）；
用尽后抛同一码，文案把兜底动作指给本节的改块端点。**显式指定 `blockStart` ⇒ 不重算**（管理员指定的段被占就是要人看一眼）。

> ⚠ **重试只覆盖「端口分配」这一小段**（不是整笔开户回滚重来）：开户顺序是「网络与容器已落地之后、LLM 联动之前」
> 调端口分配（`provisioner.js` 已核实）⇒ 冲突时**已建的网络/容器不回滚**，LLM binding 尚未执行。
> 已有的 `withFdeLock` 锁键是 `fde:${fdeName}`，**串行化不了不同 FDE 抢同一个空闲块**，
> 所以「迁移 0019 的全局部分唯一索引 + 新事务重算」才是正解，不要指望加锁（规格 §8.2）。

> **前端已接入（#246 交付② 单 B）**；#247 的批量端点也已接入：工作台左侧栏的预览端口面板有「打开全部预览 / Open all previews」，一次点击 = 签 + 开 N 个标签页（**不做二次确认**——票 60 秒过期）；弹窗被拦时面板给出带票的可点链接列表兜底。批量签票**同样只在点击时发生**（挂载/折叠/刷新都不签）。

### 4.8 工具审批（Approvals）

> ⚠ **实现状态（#242 端点全量自检，2026-10-11 实测）**：**用户面审批 API 未实现**。
> 存在的是 **internal 面**（`POST /api/internal/runs/:id/approvals` 创建、`GET /api/internal/approvals/:id` 轮询，见 §9）；
> `GET /api/approvals` 与 `POST /api/approvals/:id` 在 `http.js` 用户面分派里**无分支**，真机均返回 `404 not_found`，
> 且工作台 SPA（`portal/frontend/src`）零 `approv` 引用 ⇒ **当前根本不会产生「待审批项」**：引擎 `erix-agent 0.18.0`
> 全文无审批钩子（`grep -rni approval src/` → 0 命中），工具循环不会问宿主；runner 侧只有**接收侧**（`pendingApproval` + `APPROVAL_DECISION`），
> **无发送方**，`agentd.js:871` 的 `APPROVAL_REQUEST` 分支直接回 `denied` 并注明「P1 留空」（`agentd.js:14`）。
> 工具审批在 `docs/design/fde-platform.md` 路线表里曾列为 P2，**现已裁决不交付**（#249 closed；理由与「什么条件下重新考虑」见 `docs/design/principles.md` §3）。
> 本节的 Approval 对象与「迟到决定 `409 approval_expired`」**不再是对外承诺的活契约**，只作两个用途：
> ① **internal 面（§9 U10/U11）与 `approvals` 表保留**作协议留档，将来真要重做不必重新设计；② 解释为何用户面这两行返回 `404`。
> 若将来重开：缺的第一块仍是**上游引擎的「暂停等宿主裁决」钩子**，不是页面按钮；工具风险面见 `runner-integration.md` §17。

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

### 4.9 管理台 LLM 模型管理（`/api/admin/llm/*`，#296）

整条线 **admin-only**（非 admin ⇒ `403 forbidden`，错误体见 §1.1）。本节只覆盖**模型**这条线，
重点是把「改名」拆成两个字段——其余（供应商增删、用户 LLM 配置、心跳、价目表）行为以代码与测试为准。

**一个模型有两个名字，不是一回事**（#296 的整件事就来自把它们当成同一个）：

| 模型对象字段 | 落在网关的哪里 | 语义 |
|---|---|---|
| `model_name`（**调用名**） | deployment **顶层** `model_name` | **操作面**：FDE 请求里实际发的那个名字。`fde_llm_bindings.main_model_id` / `main_model_name`（及 embedding/vision 同名列）与 per-FDE 虚拟 key 的白名单里存的**都是它** |
| `name`（**显示名**） | `model_info.display_name` | 只影响管理台列表与选择器展示；**缺省时等于调用名**（LiteLLM 的缺省行为，`toModel` 原样回读），改它不影响 FDE 发什么 |

`PATCH /api/admin/llm/models/:id` 请求体字段（全部可选，但至少给一个；`model_info.id` 由服务端按
路径参数回填，客户端塞了也不算）：

| 字段 | 类型 | 落点 / 校验 |
|---|---|---|
| `call_name` | string | **调用名** → 顶层 `model_name`（#296 新增）。必须是非空字符串，服务端 `trim` 后写入；trim 后为空 ⇒ `400 validation_failed` + `details.field='call_name'`；与**另一个**模型的调用名重名 ⇒ `409 model_name_conflict`（见 §1.2）。改它 = 改 FDE 手里正在用的名字 ⇒ 管理台**必须先点一次确认**（确认前零 PATCH，§2 末原则：确认框只准挂在按钮上）；成功后门户立刻对账（下一段） |
| `name` | string | 显示名 → `model_info.display_name`（**既有语义，一字未动**）。改它不触发任何数据面动作 |
| `model` | string | 上游模型 id → `litellm_params.model`（不可与别的调用名撞，见上） |
| `type` | `'text'\|'embedding'\|'rerank'\|'vision'` | 非法值 ⇒ `400 validation_failed`（`details.field='type'`） |
| `tool_calling` | boolean | 支持 function calling |
| `context_window` | number \| null | **写侧两条校验**（#318 下限 + #325 形态归一，下一段）：不带键 = 不改、`null` = 没配窗口、其它值必须**是正整数且 ≥ 65536**。落点是 `model_info.context_window`，并同步镜像 `model_info.metadata.context_window`（门户读侧两处都读，必须同源） |
| `max_tokens` | number | legacy 数据面参数 → `litellm_params.max_tokens`；只接受正整数或 `null`（`null` = 删键） |
| `max_output_tokens` | number \| null | **单次响应的输出预算上限**（#309 切片 1，下一段）。权威位 `model_info.max_output_tokens`，并**同值自动跟随**写 `litellm_params.max_tokens`；**传 `null` 当前清不掉**：门户会按「清空」发请求（`model_info.max_output_tokens: null` + `litellm_params` 不带 `max_tokens`），但真 LiteLLM v1.103.2 对 JSON `null` 是**忽略**语义（实测 200 而值一字未动，issue **#314**；原因：显式 `null` 只对网关那个 `CLEARABLE_LITELLM_PARAMS` 白名单字段生效，`max_tokens` 不在里面）⇒ 门户侧只能**设值**，要清空得走网关。**出路是 #314 的「按当前窗口 1/4 重设」**（管理台编辑弹窗里的一个按钮，把值填成 `floor(窗口/4)`，只填值不提交），而不是「清空」。硬上限 `≤ floor(context_window/4)` ⇒ 超限 `400 validation_failed`。**读侧读到的是生效值**：没手填过时它是 `floor(context_window/4)` 算出来的（切片 1.5，见下；`context_window` 的形态口径见上面 `context_window` 那两行与「第 3 级」那一条，#316/#325） |
| `input_cost_per_token` / `output_cost_per_token` | number \| null | 显式定价（§8.31）；管理台按 **USD/1M** 输入输出、原值回读 |

**`context_window` 的写侧校验：硬下限 65536（#318）+ 形态归一（#325）**

两条都在 `portal/src/llm.js` 的 `validateContextWindow()` 一处完成，**零新错误码**（§8.20：一律 `validation_failed`，细分靠 `details.reason`）：

| 校验 | 拒法 | `details` |
|---|---|---|
| **形态**：必须是正整数（唯一判据 `positiveIntOrNull()`，#316） | `400 validation_failed` | `{field:'context_window', reason:'not_positive_integer', min:65536, value:<原值>}` |
| **下限**：`CONTEXT_WINDOW_MIN = 65_536` | `400 validation_failed` | `{field:'context_window', reason:'too_small', min:65536, value:<原值>}` |

- **校验次序（写死了，不得互换）**：`context_window` 的**形态** → `context_window` 的**下限** → 「`max_output_tokens ≤ floor(窗口/4)`」。
  为什么：否则「窗口 1000 + 上限 500」会先报「上限 250、传入 500」，管理员去改预算，而真正的病因（窗口配错了）被藏起来。
  PATCH 里这两条还排在**任何网关请求之前**（连读目录那一次都不发）⇒ 窗口配错时**网关零请求、零部分写入**（与 `model_name_conflict` 同一个形状）。
- **两种 `reason` 的文案都是写给管理员看的**（带算式与出路）：`too_small` → 「上下文窗口不能低于 65536（传入 …）。低于此值平台算不出正的压缩预算（`窗口 − 输出上限 − max(2000, 10%×窗口)`），压缩会静默关闭」；
  `not_positive_integer` → 「上下文窗口必须是正整数（传入 …）」。前端**不翻译也不自己判**，`error.message` 原样透出（§8.31）。
- **不带键 / `null` 不设下限**（#318 正文第 3 条）：「没配窗口」是另一条既有口径（配预算时报 `max_output_tokens / context_window_missing`）；
  而**新建表单留空发的是显式 `null`**（下面「新建与编辑不对称」那一条）⇒ 拒 `null` 会把「建一个没配窗口的模型」（典型：embedding 位）在门户里堵死。
- **下限只管本次提交的值**：存量/带外配出来的小窗口（例：`context_window: 8000`）仍可以只改预算、只改名字，门户不会因为新下限而拒。
- ⚠ **落库的是归一后的 `number`，不是调用方原字符串**（#325）：网关 `model_info.context_window`、镜像的 `metadata.context_window`、以及双写的
  `model_info.max_output_tokens` / `litellm_params.max_tokens` 写的都是 `positiveIntOrNull()` 的结果。此前写侧**原样透传**
  （带外 `PATCH {"model_info":{"context_window":"262144"}}` 真网关就存成字符串 `'262144'`，2026-10-20 dev 实测）
  ⇒ 数字串会永久留在目录里。⚠ **读侧（列表 DTO / 心跳下行）仍然原样回读存量值**：写侧归一只保证**今后经门户写入的**永远干净，
  带外写进来的旧形态靠 #316 的读侧归一兜（runner 不受影响），不靠这里。
- **定性：产品约束，不是引擎安全必需**（与 1/4 上限同一条定性）；实测依据与「为什么是 64k 而不是 32k」见
  [`../design/fde-platform.md`](../design/fde-platform.md) §11.5。runner 那道上游闸（#309 切片 2b）**不动**：它兜的是带外配置。

**`max_output_tokens`：单次响应的输出预算上限（#309 切片 1 + 切片 1.5）**

背景（**主 agent 已在 pin 的 erix-agent 0.20.0 上实跑复现**，不是推论）：引擎侧算预算的公式是
`budgetTokens = contextWindow − maxOutputTokens − max(2000, ⌈10%·contextWindow⌉)`
（`src/compact/budget.js:23-25`，调用点 `src/loop/orchestrator.js:1141-1148`，**那段没有 try/catch**）。
所以这个数不是「填多少算多少」的旋钮：**一旦算出 `budgetTokens ≤ 0`，`runToolLoop` 在第 1 轮之前就抱
`KitError code=invalid_budget`（`retryable=false`，实测文案 `Computed context budget must be positive
(got -71)`）⇒ 每个 run 启动即死**，而错误现场只指向引擎，不指向门户里那个输入框
⇒ **门户必须写之前拦**。（另一件容易搞错的事：填了个「合法但荒谬」的绝对值（例：`ctx=262144` 填
`200000`）不会报错，但预算只剩 35929 ⇒ 几乎每轮都在压缩 —— 1/4 上限拦的就是这一类。）

- **写侧绑死双写**：`model_info.max_output_tokens`（权威位，门户列表与心跳下行读它）与
  `litellm_params.max_tokens`（**调用方没发 `max_tokens` 时由 LiteLLM 注入给上游的那个值** ——
  #309 事故里那个 131072 就是这么来的）**同值**；传 `null` 门户**按「两处一起清」的形状发请求**。
  ⚠ **但在真网关上当前清不掉**（#317 改对的原口径是「传 `null` 两处一起清」）：真 LiteLLM v1.103.2 对
  JSON `null` 是**忽略**语义（手工与门户两条路各实测一次：返 200 但值一字未动，issue **#314**）。
  单测（`portal/test/llm.test.js`）钉的是**发给网关的请求形状**（fake 会清），不是网关行为。
  ⇒ 管理台上这是一个「只能设值、不能清空」的字段；又因为编辑表单**留空 = 省略该字段**（下条，#314），
  管理员不会看到「清空失败」的报错，只会看到「那个数清不掉」。
  为什么必须双写——与上面 `call_name`/`name`「各写各的」**结论相反**：本字段是**数据面参数**
  而不是展示元数据，只写 `model_info` 就是「门户显示 2000、数据面仍是默认值」的第二套真相源
  （#296 拆的正是这类坑）；只写 `litellm_params` 则门户与心跳没有权威可读。
- **读侧 = 生效值的四级回退链**（`toModel`，`GET /api/admin/llm/models` 与 providers 内嵌的 models，
  以及心跳下行的 `models.main`——**同一个 `toModel()` 产物，不存在第二处算法**）：

  ```
  生效值 = model_info.max_output_tokens          -- 上游 LiteLLM 配了什么就是什么（权威位）
         ?? litellm_params.max_tokens            -- 同上（今天真正被网关注进请求体的那个）
         ?? floor(正整数 context_window / 4)        -- 都没配 ⇒ 按窗口的 1/4 假定（切片 1.5 新增；#316 把
         ?? null                                  --   「正数」收紧成「正整数」：真小数窗口也算不出来）
  ```

  - 第 2 级的回退是**刻意的**：存量模型只有后者，不回退就会把已经配好的显示成「没配」。
  - 第 3 级（**切片 1.5 的回退值**）：`context_window` 的取值口径与门户显示那一行**完全同源**
    （`model_info.context_window ?? metadata.context_window`），且必须是**正整数**才算（#316）：
    - **数字串**（`"128000"`）与**整值浮点**（`262144.0` / `"262144.0"` / `"1e3"`）⇒ **归一成正整数**后参与计算；
    - **真小数**（`262144.5`）/ `0` / 负数 / 非数字串 / `NaN` / `Infinity` ⇒ 一律「窗口不可得」⇒ 直接走
      第 4 级的 `null`，**绝不 floor（那是在替管理员编一个他没填的数）、绝不下发 0 或 NaN**。
    这条判据与 runner 是**同一条**（`runner/lib/llm-models.js` 的 `positiveIntOrNull()`，镜像测试在对面）：
    旧口径只要求「正数」，于是 `262144.5` 能在门户算出一个回退值而 runner 不认它 ⇒
    **门户显示着窗口、压缩静默关**（#316 的病症）。今天「窗口可得」与「runner 能算出预算」是同一件事。
  - **缺元数据不再等于关压缩**（本切片真正要买的性质）：引擎要 `contextWindowTokens` **和**
    `maxOutputTokens` 同时存在才推得出 `budgetTokens`（压缩总开关），而「从没在门户手填过这个数」
    才是存量模型的常态 ⇒ 门户总会算出一个生效值并下发，**引擎的压缩开关因此默认是开的**。
    ⚠ **压缩仍关着的情形是三种**（#317：原文写的「唯一还关着的情形是连 `context_window` 都没配」不对）：
    ① 连 `context_window` 都没配；② 窗口形态 runner 不认（真小数 / `≤0` / 非数字 ⇒ 门户与 runner 同一条
    `positiveIntOrNull()` 判不可得 ⇒ 回退也算不出、心跳也不带这两个键，见上面第 3 级与
    `runner/lib/llm-models.js`）；③ 窗口**小到** 1/4 兜底仍算不出正预算（`ctx ≤ 2666`：钳完仍是非正 ⇒
    runner 注入的上游闸 `computeBudget` 抛 ⇒ 整对不传，见 `AGENTS.md` §8.31）。
    ① ② 由上游的一次性 `model_metadata_missing` 诊断事件告警；③ 由 runner 的 `model metadata unusable`
    warn 点名（文案会同时说「下行未带」与「形态非法」两种成因，#316）。
  - **只有一列数字**：决策者明确否决了「区分配置值 vs 假定值」的字段拆分（原话：这有什么关系呢，
    不管怎么来的，有个数字就行）⇒ **没有** `effective_max_output_tokens` / `max_output_tokens_source`
    这类字段，DTO 里就是 `max_output_tokens` 一个键。
  - legacy `max_tokens` 字段与其语义**一字未改**（兼容面：只被读，不会被回退写）；
    同一次请求两者都传时以绑定字段为准。
- **硬上限（决策者定稿，服务端是唯一判据）**：`max_output_tokens ≤ floor(context_window / 4)`。
  有效窗口：本次提交的新值优先（同一条 PATCH 里两者都改时不能拿旧窗口判新预算），否则退到
  该模型现存的 `model_info.context_window`。两种拒绝都是 `400 validation_failed`（**零新错误码**，§8.20）：
  - 没窗口 ⇒ `details = {field: 'max_output_tokens', reason: 'context_window_missing'}`（不放行「只改一半」）；
  - 超限 ⇒ `details = {field: 'max_output_tokens', max_allowed, context_window}`，`message` 点名「上限 = context_window 的 1/4」与两个数字。
  1/4 **比引擎临界更严**（理由：1/4 是管理员能心算的数，不要求他们先翻一遍预算公式）；引擎侧那条
  作为绝对兜底保留 ⇒ **双保险，谁都不许拆**。不传该字段时行为与改前逐字节一致（两个键都不出现）。
  ⚠ **1/4 既是手填上限也是回退值**（切片 1.5）：两个数是同一个 `floor(context_window / 4)`
  ⇒ 平台自己永远不会造出一个被自己校验拒掉的值（回退算出来的数再提交回去也合法）。
  两处若要改数**必须一起改**（同一个 `Math.floor`、同一条窗口判据）。
- **POST 新建**（`POST /api/admin/llm/providers/:id/models`）接受同一字段，1/4 用**本次提交的** `context_window` 判；
  不传/传 `null` 时两个键都不写进网关 body。
- **前端不做本地数字校验**（否则就是第二套会过期的规则）：表单只加提示「上限 = 上下文窗口的 1/4」，
  超限一律由服务端拒且 `error.message` 原样透传（`stores/admin.ts` 的 `errText` 口径）。
  #314 加的那个「按当前窗口 1/4 重设」按钮也不破这条规矩：它只是 `floor(窗口/4)` 把值**填进输入框**
  （替人按一下计算器），不拦截、不提交、不判上下限，填出来的数照样过服务端。
- ⚠ **新建与编辑两个表单的「留空」不是同一个意思**（#317 补；这是看懂上面「清不掉」的前提）：
  **新建**时留空发的是**显式 `null`**（`portal/frontend/src/views/AdminView.vue` 的
  `max_output_tokens: modelForm.max_output_tokens ? Number(...) : null`），而**编辑**（PATCH）留空发的是
  **省略该字段**（`...(modelEditForm.max_output_tokens ? { max_output_tokens: ... } : {})`，
  即 PATCH 的「不动」语义，表单根本没提供「清空」按钮）。后果：真网关上 `null` 是忽略语义（#314）
  ⇒ **管理员永远看不到「清空失败」这个报错**（编辑表单不发 `null`），他只会看见「那个数清不掉」；
  而新建时留空确实不写该键，所以「新建一个没配预算的模型」是成立的（读侧退到 `floor(ctx/4)`）。
  **#314 的处置**（本版已做）：不动网关、不要求上游把 `max_tokens` 加进 `CLEARABLE_LITELLM_PARAMS`，而是
  ① 编辑弹窗里给一个**「按当前窗口 1/4 重设」**（把值填成 `floor(窗口/4)`，与门户读侧回退同一个算法；
  **只填值、不自动提交**，用户可继续编辑后自己点保存）；② 把「**留空 = 不修改**」写进该字段说明（两个表单的
  不对称同屏说清：新建 = 不写该字段，编辑 = 省略该字段）；③ 表单里不再出现「清空」字样（做不到的事不给错觉）。
  服务端零改动（重设只是前端的填值动作）。

**别名对照表：同一个东西在六层里有六个名字（#309 切片 1.5；runner 那一行是 #317 补的）**

这个概念穿过 LiteLLM 、门户、erix-agent 三个命名空间，**名字不一致但指的是同一件事**——历史上
#296（两个名字）与 #309（一个数被当两个）都是这类坑。对照表如下，**本项目自己的一侧（门户 DTO /
表单 / 心跳下行）一律叫 `max_output_tokens`**，不许出现第二个拼写（`maxOut`、`outputLimit`、
`outputBudget` 都算发散）：

| 层 | 名字 | 谁定义 |
|---|---|---|
| LiteLLM 权威位 | `model_info.max_output_tokens` | LiteLLM |
| LiteLLM 请求参数 | `litellm_params.max_tokens` | LiteLLM |
| 门户 DTO / 表单 / 心跳下行 | `max_output_tokens` | 本项目 |
| **runner 心跳解析与钳制（#317 补的一行）** | 心跳 snake_case 两键 `context_window` / `max_output_tokens` → **正整数归一**（`positiveIntOrNull`，#316）→ `floor(ctx/4)` 钳制（`resolveModelMetadata`）→ 上游闸抛则**整对不传** | 本项目 |
| erix-agent 算压缩预算用 | `runToolLoop({modelMetadata:{contextWindowTokens, maxOutputTokens}})` | 上游 |
| erix-agent 发给模型用 | `runToolLoop({maxTokens})` → 请求体 `max_tokens` | 上游 |

**`modelMetadata.maxOutputTokens`（算预算）与 `maxTokens`（真的发给模型）是上游的两个不同参数，
别当同一个**：前者只参与 `budgetTokens` 计算（缺它就等于压缩关了），后者真的进请求体。
本项目 **#309 切片 2** 会把门户算出的**同一个数**同时喂给这两处（心跳只下行一份，runner 接线时
一分二）——本节写的是「门户侧只有一列数字」，不是「上游只有一个参数」。

名字之外的两个容易漏的点：① 门户的**心跳下行**用 `max_output_tokens`（与 DTO 同名同值，
§9.5）；② 写侧的 `litellm_params.max_tokens` 自切片 2 起退化为「非平台调用方（FDE 自己 curl、
网关 UI 试跑）」的兜底——**保留它的理由是这个，不是「引擎读它」**。

**带 `call_name` 且调用名真的变了 ⇒ 网关改名成功后门户立刻做一次对账**（#296，判据与 §8.25 心跳完全同一条）：


```
SELECT fde_id FROM fde_llm_bindings
 WHERE main_model_id = $1 OR embedding_model_id = $1 OR vision_model_id = $1   -- $1 = model_info.id
   → 逐个绑定走 getFdeLlmHeartbeatModels（**复用**心跳那条，不另写第二份并集逻辑）
     → per-FDE 虚拟 key 白名单写成**新旧名并集**（先扩名字空间）
     → 再回写 *_model_name = 新调用名（*_model_id 不变 ⇒ LiteLLM 不重建、在途不断）
```

- N 个受影响 FDE 合计**只打一次** `GET /model/info`：改名前那份 60s TTL 映射必须绕开（拿旧映射会判成
  「没漂移」⇒ 空对账，管理员改了名 FDE 仍 403）。
- **只传 `ctx.llmGateway` 单例**：那份 TTL 缓存挂在 LlmClient 实例上、按 client 身份分槽，
  路由里另 `new LlmClient(...)` 等于换一份缓存（§8.25 缓存身份陷阱，单测用注入 gateway 盯不住）。
- 真机实测（dev 网关 v1.103.2）：改名时 LiteLLM 自己把 key 的 `models` 重写成「只有新名」
  ⇒ **这个并集是必须的那一手**，不是可选优化。
- 对账失败/网关不可达 ⇒ 只 `warn`（`[llm] model rename reconcile ...`）：**不改回 `model_name`**。
  改名已在网关落定，把 PATCH 拖成 500 只会诱导管理员重试第二次改名；不自动回滚的理由同 §8.25。
- 「门户内改名不是漂移源」这句话从此要打个补丁：**改名会把引用它的 FDE 变成漂移**（`*_model_name`
  暂时指向旧名），立即对账就是为了让这个窗口尽量短——就地注释见 `AGENTS.md` §8.25。

### 4.11 文件预览四通道与 kkFileView 网关（issue #366）

> 规格：issue #366（定稿）；实现：`portal/src/dirs.js`（`resolveJailedFile`/`openFileStream`）、
> `portal/src/previewmiss.js`、`portal/src/previewproxy.js`、`portal/frontend/src/lib/previewRoute.ts`。

前端按扩展名把每个文件路由到四个通道之一（`previewChannel()`，前后端扩展名单互相钉死）：

| 通道 | 格式 | 链路 |
|---|---|---|
| `native-json` | 文本/md/小图片 | `GET /api/file`（缺省 json，§P6 老行为一字不变） |
| `native-stream` | pdf/音视频/大图 | `GET /api/file?mode=stream`（Range/206，`<object>`/`<video>`/`<audio>`） |
| `kkfile` | Office/压缩包/老格式 | `POST /api/preview-tickets` → iframe `/pv/<code>/onlinePreview` |
| `other` | 未知 | 只给下载（`?mode=download`） |

**`GET /api/file` 的 `mode` 参数**：`json`（缺省，旧行为）/ `stream` / `download`。stream 通道：
单 Range → `206`（`Accept-Ranges: bytes`；不可满足 → `416`；多 Range/非法头当无 Range 降级整身 `200`）；
MIME 白名单（图片/pdf/mp4/webm/mov/mp3/wav/ogg/m4a），**白名单外一律 `application/octet-stream`
且强制 `attachment`**，`text/html` 永不直出（同源 XSS 红线）；上限 512MB（`413`），不读进内存。
JSON 通道的 415/413 同时写 `preview_miss_stats` 埋点（见下）。

**`POST /api/preview-tickets`** `{cwd, path}` → `{ url: "/pv/<code>/onlinePreview", expires_in: 600 }`。
`<code>` = `base64url(JSON 载荷) + "." + HMAC-SHA256`（载荷 `{u: user_id, p: userspace 相对路径, m: mtime 秒, e: 过期秒}`），
密钥 = `SESSION_SIGNING_KEY`（`previewSessionSigningKey`）。mtime 入码 = 文件被 agent 改写后旧码自然失效（`403 preview_code_expired`，`retryable` → 前端重签一次）。

**`GET/HEAD /pv/<code>/**`（反代闸门，非 JSON API）**：浏览器永远看不到 kk 真实地址。每请求依序过：
会话 cookie（401）→ 能力码验签（404）→ 子路径白名单（kk 已知路由 + `js/css/images` 静态目录，越界 404）
→ 归属（`payload.u` ≠ 会话用户 403）→ 时效（过期 403 `preview_code_expired`）→ 把 `onlinePreview` 的
`url` 参数**重写**为 portal 自产的 `file://<userSpaceRoot>/<p>`（base64，SSRF 根：用户的 URL 永远到不了 kk）。
响应头消毒（剥 kk 的 XFO/CSP/Set-Cookie，注入 portal 的 `SAMEORIGIN` + CSP + `no-store`）；链接回闸门
三条腿：① `X-Base-Url = <本站 origin>/pv/<码>/`（kk BaseUrlFilter 优先级 1 钩子，绝对产物链接如
`/xx.pdf`、pdf 图块目录直接生成成闸门内 URL）；② `X-Forwarded-Prefix`（kk 侧
`SERVER_FORWARD_HEADERS_STRATEGY=native`，Thymeleaf 根链接自产前缀）；③ portal 改写器接根相对链接。
产物透传白名单：转换产物挂 web 根（`/xx.pdf`、`/xx/1.png`），放 1–2 段安全字符+产物尾缀（同租户
登录态内可枚举，匿名探测被闸门排除）。**kk 侧两个硬前提**（真机实证）：镜像自建 5.0.3（官方 Hub 停在 4.1.0，无 `file://`）；`url` 必须带命名 authority `file://<KK_TRUST_HOST>/<abs>`（5.0.3 空 host 一律 403，`KK_TRUST_HOST` 与 portal `previewproxy.KK_TRUST_HOST` 同值），portal 与 kk 容器 userspace **同路径**挂载（`KK_LOCAL_PREVIEW_DIR` = portal `ERIX_USERSPACE_ROOT`）。kk 宕机 → `502 preview_backend_unavailable`（`retryable`）。

**`GET /api/admin/preview-misses?days=14`**（管理员）→ `{ days, items: [{day, kind, ext, hits, last_seen_at}] }`。
埋点表 `preview_miss_stats`（迁移 0023）按 日×`kind|ext` UPSERT 聚合，kind ∈ `unsupported`/`too_large`，
ext 来自 `path` 末段（无扩展名记 `(none)`，路径不入库）；写失败只 `warn` 不拖预览。
用途：看真实需求面再决定要不要把某格式提进原生白名单。

### 4.12 管理台邮件通道配置（`/api/admin/mail/*`，#449）

> 规格：issue #449（管理台切片；决策者 2026-11-04/05：**SMTP 参数存 DB**，不进 env）。
> 实现：`portal/src/mail-settings.js`（校验 + 单条 upsert）、`portal/src/mail-provider.js`（读侧：60s 缓存 + 急停硬闸）、
> `portal/src/http.js`（分派 / 缓存失效 / 审计）。表结构见 `docs/data/model.md` §1.31（迁移 0026）。
> 三个端点全部过 `requireAdmin`：非 admin ⇒ `403 forbidden`，未登录 ⇒ `401 unauthorized`。
> **这张表是登录第二因素「邮箱验证码」（§2.3a/§2.3b）的唯一真相**：管理台配好 `transport='smtp'` 且 `MAIL_TRANSPORT` 未设成 `disabled`，邮件通道才生效。

#### 4.12-1 配置 DTO（GET 与 PUT 同一个形状）

```json
{
  "transport": "smtp",
  "smtp": {
    "host": "relay.internal",
    "port": 25,
    "secure": false,
    "user": "svc",
    "from": "noreply@example.com",
    "timeouts": { "connectionMs": 10000, "greetingMs": 10000, "socketMs": 20000 }
  },
  "hasPassword": true,
  "updatedAt": "2026-11-05T08:12:31.004Z",
  "updatedBy": "3f2c…（admin 的 users.id，uuid）"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `transport` | `'disabled'` \| `'smtp'` | 唯一决定「发不发信」的应用层开关（`disabled` = 不发） |
| `smtp.host` / `smtp.from` | string | relay 地址与发件人；`transport='smtp'` 时两者都必填 |
| `smtp.port` | int 1–65535 | 缺省 `587` |
| `smtp.secure` | boolean | `true` = implicit TLS（465 形态），`false` = STARTTLS；缺省 `true` |
| `smtp.user` | string | **可空**（内网 relay 常按来源 IP 放行、不需要认证） |
| `smtp.timeouts.*` | 正整数（ms，≤ 600000） | 缺省 `10000 / 10000 / 20000`，直接映射 nodemailer 三档超时 |
| `hasPassword` | boolean | **只有布尔**：`smtp_password` 是非空字符串时为 `true`。**任何响应都不返回口令明文** |
| `updatedAt` | string\|null | 最后修改时刻（无行时 `null`） |
| `updatedBy` | string\|null | 最后修改的 admin `users.id`（无行时 `null`；不建 FK，删用户不拦配置行） |

#### 4.12-2 `GET /api/admin/mail/settings`

无请求参数。**无 `mail_settings` 行时回 `200` + 默认 DTO，不是 404**——「未配置」是正常态（本单上线时的默认形态）：

```json
{
  "transport": "disabled",
  "smtp": { "host": "", "port": 587, "secure": true, "user": "", "from": "",
            "timeouts": { "connectionMs": 10000, "greetingMs": 10000, "socketMs": 20000 } },
  "hasPassword": false,
  "updatedAt": null,
  "updatedBy": null
}
```

本端点**不写审计**（纯读、每次进管理页都会调）。

#### 4.12-3 `PUT /api/admin/mail/settings`

请求体 = DTO 的 `transport` + `smtp`（`hasPassword`/`updatedAt`/`updatedBy` 是**响应侧只读**字段，传了也忽略），
外加**只写**字段 `password`：

```json
{ "transport": "smtp",
  "smtp": { "host": "relay.internal", "port": 25, "secure": false, "user": "svc",
            "from": "noreply@example.com",
            "timeouts": { "connectionMs": 10000, "greetingMs": 10000, "socketMs": 20000 } },
  "password": "<明文口令，只在请求里出现>" }
```

**口令三态（`password` 只写不读）**：

| 请求里的 `password` | 语义 |
|---|---|
| **键缺席** | **保持原值**（编辑表单留空 = 不修改，项目既有口径，同 #314 一族）|
| `null` 或 `""` | **清除**（`smtp_password → NULL`，`hasPassword` 变 `false`）|
| 非空字符串 | **覆盖**（原样存，不 trim：口令里的空格是内容；上限 8192 字符）|

**校验矩阵**（失败一律 `400 validation_failed` + `details.field`；`retryable:false`）：

| `details.field` | 何时 |
|---|---|
| `body` | 请求体不是 JSON 对象 |
| `transport` | 不是 `'disabled'` / `'smtp'`（含缺席） |
| `smtp` | 不是对象 |
| `smtp.host` | `transport='smtp'` 时为空/全空白；或给了非字符串（**类型错一律拦**：否则会在 DB 层变成 500）|
| `smtp.from` | `transport='smtp'` 时为空；或不匹配邮箱正则 `^[^\s@]+@[^\s@]+\.[^\s@]+$`（**与 `admin.js` 建号同一个正则口径**，单测有源码级判据把两处钉在一起）|
| `smtp.port` | 非 `1–65535` 的整数（字符串 `"25"` 也拒：JSON 里它就该是数字）|
| `smtp.secure` | 非布尔 |
| `smtp.timeouts.connectionMs` / `greetingMs` / `socketMs` | 非 `1–600000` 的正整数 |
| `password` | 既不是字符串也不是 `null`/`""`；或超过 8192 字符 |

**`transport='disabled'` 时 `host`/`from` 一律不校验**（允许「先关掉再慢慢配」，也允许关掉时保留半套配置）——
**这是刻意的宽松**：只有真要发信（`smtp`）时才要求配全。迁移 0026 的
`CHECK (transport <> 'smtp' OR (smtp_host IS NOT NULL AND smtp_from IS NOT NULL))` 是最后一道兜底。

**落库**：单条 `INSERT … ON CONFLICT (id) DO UPDATE`（`id=1`、`updated_at=now()`、`updated_by=当前 admin`）。
不用「先查再决定 INSERT/UPDATE」：两个管理员同时保存不会撞主键。

**成功后的三步（顺序固定）**：

1. `ctx.mailerProvider.invalidate()` —— 改配置**立刻**生效，不等 60s TTL（否则「配好了却要等一分钟」会被当成配置没生效）；
2. 审计 `admin.mail_settings_updated`，`details` = `{ changed: [键名…], password_changed: bool, transport }`；
3. 回 `200` + 与 GET 相同的 DTO。

`changed` 的键名取值：`transport`、`smtp.host`、`smtp.port`、`smtp.secure`、`smtp.user`、`smtp.from`、
`smtp.timeouts.connectionMs`、`smtp.timeouts.greetingMs`、`smtp.timeouts.socketMs`、`password`（口令真的变了才出现）。
它是「相对上一次状态**真落库的变化**」（以 `RETURNING` 回读的行为准，不信输入；无行时基线 = GET 的默认 DTO）。
什么都没变 ⇒ `changed: []`（仍然是 `200` + 一条审计：幂等保存不是错误）。

#### 4.12-4 `POST /api/admin/mail/test`

用**已保存的配置**真发一封测试信（不是用请求体里的配置）。

```json
{ "to": "ops@example.com" }
```

成功：`200 { "ok": true, "to": "ops@example.com", "at": "2026-11-05T08:20:11.220Z" }`。

正文是「这是测试信 + 发送时间戳 + 无需操作」，**不含验证码**（运维手点的探活信不该带任何凭据）。

| 情形 | 响应 |
|---|---|
| `to` 缺席/空/不是邮箱（同一正则） | `400 validation_failed`，`details.field='to'`（**不发信、不烧配额**）|
| 超过限流（每管理员 **5 次/小时**，key `mailtest:<adminId>`）| `429 rate_limited` + `Retry-After`（秒）|
| 通道未启用（无行 / `transport='disabled'` / `MAIL_TRANSPORT=disabled` 急停 / 配置只配了一半）| **`409 mail_not_configured`**（`retryable:false`，message 指出「先去配置 SMTP」；**此时不烧配额**——还没配好就先把额度用光不合理）|
| 发信失败（超时/拒绝/认证失败） | `502 email_send_failed`（`retryable:true`，`details` **只有** `{reason}` 摘要，**不含口令/正文**）|

限流器是内存态（单实例，重启清空）：与登录限流同一套 `createRateLimiter`，**每次真会发信的尝试都计一次**
（含失败的那次——探活失败也是打了一次 relay）；`config.mailTestRateLimit` 可覆盖默认 `5 次 / 1 小时 / 封 1 小时`。

#### 4.12-5 审计口径

| action | 触发 | `details` |
|---|---|---|
| `admin.mail_settings_updated` | PUT 成功 | `{ changed: [键名…], password_changed: bool, transport }` |
| `admin.mail_test_sent` | 测试发信成功 | `{ to, at }` |
| `admin.mail_test_failed` | 测试发信失败（502）| `{ to, at, reason }`（`reason` 是底层错误的单行摘要，截断 120 字符）|

三条都带 `actor_id = 当前 admin`、`target = 'mail_settings'`。

#### 4.12-6 红线：口令只写不读

- **响应**：只有 `hasPassword` 布尔。DTO 里没有 `password` / `smtp_password` 键。
- **审计**：只有 `password_changed` 布尔与键名 `'password'`，**没有口令值**。
- **日志**：本切片不打日志（发信失败由 `mailer.js` 记一条脱敏收件人 + reason，与登录路径同口径）。
- 单测 `portal/test/admin-mail-settings.test.js` 有两条专门搜口令明文的判据（响应体 + 整条审计 `details` 序列化）。

---

### 4.13 管理台证书生命周期（`/api/admin/tls*`，#456 M1）

> 规格：issue #456（决策者 2026-11-05：**证书上传/更新/覆盖域名检查搬进管理台**，不手工登服务器放文件）。
> 实现：`portal/src/tls-cert.js`（解析 / 校验 / 写盘 / 备份 / 回滚 / 真机握手比对）、
> `portal/src/http.js`（分派 / 限流 / 审计）、`portal/src/tlsassets.js`（装载面，**只由它物化 `tls.yml`**）。
> 表结构见 `docs/data/model.md` §1.32（迁移 `0027`）。部署面见 `docs/deploy/edge-routing.md` §5。
> 四个端点全部过 `requireAdmin`：非 admin ⇒ `403 forbidden`，未登录 ⇒ `401 unauthorized`。
> **#462（2026-11-05）**：判定从「只看第一段证书」升级为「按**整条链**判」（叶子选取 / 顺序 / 链完整性），
> 新增 `tls_cert_order_invalid` / `tls_cert_chain_broken` 两个 400 码与三个 `warnings` 机器码；
> `verify` 增加可选 `reason` / `chainDepth`。真机实测四形态表见 `AGENTS.md` §8.100。
> **#456 M2 追加第五个：`POST /api/admin/tls/inspect`**（解析但不落盘，见 4.13-2a）——同样过 `requireAdmin`，
> 但它**不参与** 4.13-1 的响应 DTO（它回的是「这份 PEM 里有什么」，不是「盘上现在是什么」）。

#### 4.13-0 分工：盘是真相，DB 只是台账

| 面 | 谁是真相 | 说明 |
|---|---|---|
| 当前生效的证书 | **`<dynamic>/certs/tls.crt` + `tls.key`** | GET 一律**读盘**（不信 DB）：`configured` 的判据是「两文件都在且证书能解析」 |
| Traefik 用哪张证书 | **`<dynamic>/tls.yml`** | 由 `materializeTlsAssets()` 物化；**上传/回滚后必须重写它**才触发 reload（只换 `certs/*` 不会） |
| 「谁什么时候装了什么」 | `tls_certificates`（DB） | 审计/历史，**不是**真相源；与盘不一致时以盘为准 |

#### 4.13-1 响应 DTO（GET / PUT / verify / rollback **同一个形状**）

```json
{
  "configured": true,
  "active": {
    "subjectCN": "*.fde.erix.vip",
    "sans": ["*.fde.erix.vip", "fde.erix.vip"],
    "issuerCN": "*.fde.erix.vip",
    "notBefore": "2026-11-05T00:00:00.000Z",
    "notAfter": "2027-02-03T00:00:00.000Z",
    "fingerprintSha256": "AB:CD:…:EF"
  },
  "coverage": { "adminHost": "admin.fde.erix.vip", "covered": true },
  "live": { "status": "live", "checkedAt": "2026-11-05T09:12:31.004Z", "fingerprintSha256": "AB:CD:…:EF", "subjectCN": "*.fde.erix.vip" },
  "previous": { "fingerprintSha256": "12:34:…:99", "subjectCN": "*.fde.erix.vip", "notAfter": "2027-02-03T00:00:00.000Z", "savedAt": "2026-11-05T09:00:00.000Z" }
}
```

**键集是白名单，`portal/test/tls-api.test.js` ⑨ 逐键钉住**（顶层恰好五个键、`active` 恰好六个、`coverage` 两个、
`previous` 四个）。无证书时 `active` / `previous` 为 `null`、`coverage.covered` 为 `false`。

| 字段 | 说明 |
|---|---|
| `configured` | 盘上**两文件齐**且证书可解析。`false` 时管理台入口回落到 Traefik 内建自签证书 |
| `active.*` | 叶子证书的元数据。`fingerprintSha256` = `X509Certificate.fingerprint256`（**冒号分隔大写**，与 `getPeerCertificate().fingerprint256` 逐字符可比） |
| `coverage.covered` | 证书是否覆盖 `adminHost`（`ADMIN_PUBLIC_HOST`，默认 `admin.<伞域>`）。口径见 4.13-3 |
| `live.status` | `unknown`（还没验过 / 上传后已失效）/ `live` / `mismatch` / `unreachable`。**GET 只回缓存，绝不主动连** |
| `live.error` | 仅 `unreachable` 出现：`timeout` / `no_default_gateway` / `no_certificate` / socket 错误码（`ECONNREFUSED` 等） |
| `live.reason` | 仅 `mismatch` 出现（#462）：`fingerprint_mismatch`（端出来的是**另一张**）/ `chain_incomplete`（指纹一致但服务端**只发了 1 张**且非自签 ⇒ 客户端可能链校验失败）。**缺席 = 老服务端**，按指纹不一致说 |
| `live.chainDepth` | 可选（#462）：服务端实际发出的链层数（`getPeerCertificate(true)` 数 `issuerCertificate`，最多 6 层防环；自签算 1）。**缺席 = 不知道，不写 0** |
| `previous` | 可回滚的上一代（`certs/prev/`）。`null` = 没有备份 |

**响应里绝不含**：私钥正文、`certPem`/`keyPem` 原文、任何密钥派生值（连 `publicKeyPem` 都不在白名单里）。

#### 4.13-2 `GET /api/admin/tls`

无请求参数。纯读、**不写审计**（每次进管理页都会调）。无证书 ⇒ `200` + `configured:false`（**不是 404**）。

#### 4.13-2a `POST /api/admin/tls/inspect`（#456 M2：解析但不落盘）

> 为「粘贴 → 自动抽出证书里的域名 → 用户确认后才装」的两步交互而存在：`PUT` 会直接落盘，
> `GET` 只读盘上那张，都不回答「这份 PEM 里有什么」。这是 M2 唯一允许的后端追加。

```json
{ "certPem": "-----BEGIN CERTIFICATE-----\n…", "keyPem": "-----BEGIN PRIVATE KEY-----\n…" }
```

`keyPem` **可省略**（`undefined` / `null` / 空白串三种写法等价）⇒ `keyMatches: null`。

**`200` 响应**：

```json
{
  "cert": {"subjectCN": "*.fde.erix.vip", "sans": ["*.fde.erix.vip"], "issuerCN": "*.fde.erix.vip",
           "notBefore": "…", "notAfter": "…", "fingerprintSha256": "AB:…"},
  "keyMatches": true,
  "coverage": {"adminHost": "admin.fde.erix.vip", "covered": true},
  "warnings": []
}
```

| 字段 | 说明 |
|---|---|
| `cert` | **键集恰好六个**（与 §4.13-1 的 `active` 同一套字段，`portal/test/tls-api.test.js` ⑪ 逐键钉住）。`publicKeyPem` 不在里面 |
| `keyMatches` | `true` / `false` / `null`（未给 `keyPem`）。**不配对不是错误**：只回事实，UI 据此禁用「确认安装」 |
| `coverage` | 与 §4.13-1 同一口径。`covered:false` **不报错**（用户可能就是在传一张还没生效的证书） |
| `warnings` | 机器码数组（服务端只发码不发话）：`cert_expired`（`notAfter <= now`）/ `not_yet_valid`（`notBefore > now`）/ `no_sans`（一个 DNS SAN 都没有，覆盖判定退 CN）/ `admin_host_not_covered`（与 `coverage.covered:false` 同义）/ **#462 三条链形态**：`chain_looks_leaf_only`（只有一张且非自签）/ `chain_order_suspect`（顺序可能反了，**只在没给私钥时**出现）/ `chain_broken`（段间接不上）。**这些不是错误码**，不登记 §1.2、不改任何 HTTP 状态 |

**`cert` 一律是「叶子」**（#462）：给了 `keyPem` 时是**与私钥配对**的那一段，没给时按约定取第一段。
（旧实现取 `blocks[0]`，在「中间在前」的 bundle 上会把中间证书当叶子 ⇒ 报错/展示的对象都不对。）

**链形态判定表（#462，`inspect` 与 `PUT` 共用同一套判据，`portal/test/tls-cert.test.js` C1–C7 逐条钉住）**：

| # | 输入 | `inspect`（只读） | `PUT`（安装） |
|---|---|---|---|
| C1 | 叶子 + 中间（bundle，正确顺序） | 200，**无 warning**，`cert` = 叶子 | 200 落盘（**原样字节**，不重排、不裁剪） |
| C2 | 叶子 + 中间 + 根 | 200，**无 warning**（实测多发一张根无害） | 200 |
| C3 | 只有叶子且**非自签** | 200 + `chain_looks_leaf_only` | **200**（警告不拒）+ 审计 `details.chainWarnings` |
| C4 | 只有叶子且**自签** | 200，无 warning（自签的链就是 1 层） | 200 |
| C5 | **顺序反了**（配对段不是第一段） | **400 `tls_cert_order_invalid`** | **400 同码** |
| C6 | 顺序反了但**没给私钥**（拿不到配对证据） | 200 + `chain_order_suspect` | 400 `tls_cert_order_invalid`（`PUT` 一定带私钥 ⇒ 走 C5） |
| C7 | 段间接不上（`checkIssued` false） | 200 + `chain_broken` | **400 `tls_cert_chain_broken`** |

> C6 的判据（`inspect` 专用）：`blocks[0].subjectCN === blocks[1].issuerCN` **且** `blocks[0].issuerCN !== blocks[1].subjectCN`。
> 顺序可疑时**不再叠**一条 `chain_broken`：两条同时发只会让人猜（修法完全不同——把叶子挑到前面 vs 换成对的中间证书）。

**错误形态**（沿用 M1 的码 + #462 两个新码）：

| 判据 | 码 |
|---|---|
| `certPem`/`keyPem` 非字符串、或单份 > 64 KiB（体级闸同 `PUT`：256 KiB） | `400 validation_failed` + `details.field` |
| 证书 PEM 解析不出（含「一段都没有」） | `400 tls_cert_invalid` |
| 私钥 PEM 解析不出（**仅当给了非空 `keyPem`**） | `400 tls_key_invalid` |
| 顺序反了（给了私钥且配对段不是第一段，C5） | `400 tls_cert_order_invalid` + `details={firstSubjectCN, leafSubjectCN}` |

**零副作用（判据可红）**：不写盘、不写 `tls_certificates`、不写审计、不动 `tlsLive` 缓存、**不烧上传配额**。
限流单独一档 **120 次/小时**（key `tlsinspect:<adminId>`，每次请求计一次；`PUT`/`rollback` 的 10 次/小时不受影响）。
> 为什么单独一档：上传配额是留给「真会改线上握手」的操作；解析只是 CPU。120 次/小时够人手点几十次，
> 也拦得住脚本刷。超限 ⇒ `429 rate_limited` + `Retry-After`。

**审计**：不写（探针式读取，与 verify 同口径）。

#### 4.13-3 `PUT /api/admin/tls`

```json
{ "certPem": "-----BEGIN CERTIFICATE-----\n…", "keyPem": "-----BEGIN PRIVATE KEY-----\n…",
  "confirmDomains": ["admin.fde.erix.vip", "fde.erix.vip"] }
```

`certPem` = **整份 fullchain**（**叶子必须在前**；顺序反了会被 400 拒，见下表 4a/4b），
`keyPem` = 对应私钥。两份各 **≤ 64 KiB**（超 ⇒ `400 validation_failed` + `details.field`）。
**落盘字节 = 你提交的原样字节**（不重排、不裁剪、不重新序列化；`certs/tls.crt` 逐字节等于请求里的 `certPem`）。
> 体级闸：本端点的请求体整体上限 **256 KiB**（不是默认的 `MAX_BODY_BYTES` 64 KiB——两份 64 KiB 的 PEM
> 加上 JSON 转义放不进 64 KiB，那样会先撞 `413 payload_too_large` 而拿不到字段级错误）。超过 256 KiB 仍是
> `413 payload_too_large`（§1.2，全局语义不变）。
`confirmDomains` 可选：前端把证书里提取到的名字预填成可编辑 input，用户删/补后回传；**它不能超出证书能力**。

**校验顺序（每条都能被单测打红；全部在写盘之前 ⇒ 失败零副作用）**：

| # | 判据 | 失败码 |
|---|---|---|
| 1 | `certPem`/`keyPem` 是字符串且 ≤ 64 KiB | `400 validation_failed`（`details.field`）|
| 2 | 证书 PEM 可解析（**逐段**；一段都没有也算失败）| `400 tls_cert_invalid` |
| 3 | 私钥 PEM 可解析（`createPrivateKey()`）| `400 tls_key_invalid` |
| 4 | 公钥配对（两边 SPKI **DER** 逐字节比；**逐段**找配对的那张 = 选叶子）| `400 tls_key_mismatch`（一段都对不上）|
| 4a | **顺序**：配对段必须是**第一段**（#462 C5）| `400 tls_cert_order_invalid`（`details={firstSubjectCN, leafSubjectCN}`）|
| 4b | **链完整**：`blocks[i].checkIssued(blocks[i+1])` 逐对成立（#462 C7）| `400 tls_cert_chain_broken`（`details={index, subjectCN, issuerCN, nextSubjectCN}`）|
| 5 | 未过期（`notAfter > now`）| `400 tls_cert_expired` |
| 6 | **覆盖 `adminHost`** | `400 tls_cert_domain_mismatch`（`details={adminHost, missing:[adminHost], certDomains}`）|
| 7 | `confirmDomains` 每项都被覆盖（可选）| `400 tls_cert_domain_mismatch`（`details.missing` 只列超出的、`details.field='confirmDomains'`）|

> ⚠ **4a 必须排在 4 之前报**（实现顺序：解析 → 选叶子 → **顺序** → 配对失败/链完整 → …）。旧实现把
> 「顺序反了」报成 `tls_key_mismatch`——用户的私钥是对的，这个提示是误导（#462 的病根）。
> 只有叶子（C3）**不是**错误：`200` + 审计 `details.chainWarnings: ['chain_looks_leaf_only']`（可接受的自担风险）。

**域名覆盖口径（与浏览器一致，三条都是判据）**：

- **通配符只匹配一层**：`*.fde.erix.vip` 覆盖 `admin.fde.erix.vip`，**不**覆盖 `a.b.fde.erix.vip`；
- **大小写不敏感**、结尾点归一；
- **有 SAN 时忽略 CN**（SAN 是唯一权威）；**无 SAN 时** CN 兜底。只认 `DNS:` 项（IP/email SAN 与「覆盖哪个 host」无关）。

**成功后的顺序（固定）**：

1. **限流**（每管理员 **10 次/小时**，key `tlsupload:<adminId>`；**只在真会落盘时计次**——校验失败不烧配额）；
2. **备份上一代**到 `certs/prev/`（`tls.crt` 0644 / `tls.key` 0600 / `meta.json` = `{fingerprintSha256, subjectCN, notAfter, savedAt}`，**不含 PEM**；只保一代，覆盖式）；
3. 写 `certs/tls.crt`（0644）；
4. 写 `certs/tls.key`（**0600**，属主 = 进程 uid = root ⇒ 满足 Traefik 的读取前提）；
5. `materializeTlsAssets()` 重写 `tls.yml`（**唯一 reload 把手**；`fingerprint` 行含 `keymtime`，只换私钥也会变）；
6. 落 `tls_certificates` 一行（`kind='upload'`）；
7. 审计 `admin.tls_updated`；
8. 回 `200` + 4.13-1 的 DTO（`live` 重置为 `unknown`——上一张证书的校验结果对这张不成立）。

任一步失败 ⇒ `500 internal` + `details.step`（`mkdir`/`backup`/`cert`/`key`/`materialize`），**说清是哪一步**；
写 `key` 失败时会 best-effort 把 `crt` 还原成备份那一版（避免盘上留下「新 crt + 旧 key」的不配对组合）。
DB 写失败**不回滚已生效的证书**（盘是真相，回滚才是更坏的后果），只记一条 `error` 日志。

#### 4.13-4 `POST /api/admin/tls/verify`

无请求体（`{}` 也行）。对管理台入口做**一次真 TLS 握手**，比 `fingerprint256`：

- 连 **默认网关**（从 `/proc/net/route` 读 `Destination=00000000` 那行；`Gateway` 是小端 hex，
  现网 `010020AC` ⇒ `172.32.0.1`）+ **`port = config.adminPort`**（`TRAEFIK_ADMIN_PORT`，默认 9443）
  + **`servername = adminHost`**（SNI，让 Traefik 选中正确的证书）；
- `rejectUnauthorized: false`，**判据只看指纹**。⚠ **不要**顺手加 hostname 校验：证书 SAN 只覆盖
  `*.fde.erix.vip`，连 `127.0.0.1` 必然 `subjectAltName does not match`——那不是配置问题；
- 超时 **5s**；三种结果 `live` / `mismatch` / `unreachable`（`error` 给原因）；
- **#462：看链，不只比指纹**。用 `getPeerCertificate(true)` 数链深（`issuerCertificate` 存在、非空、
  指纹不重复才继续，最多 6 层防环）：
  | 情况 | 结果 |
  |---|---|
  | 指纹不一致 | `mismatch` + `reason:'fingerprint_mismatch'`（**现状语义不变**，只多一个 reason 字段） |
  | 指纹一致、链深 ≥ 2 | `live` |
  | 指纹一致、链深 < 2、**自签**（`subjectCN === issuerCN`） | `live`（自签的链就是 1 层） |
  | 指纹一致、链深 < 2、**非自签** | `mismatch` + `reason:'chain_incomplete'` + `chainDepth`（服务端只发了 1 张 ⇒ 客户端可能 `unable to verify the first certificate`，实测） |
  两个可选键**缺席 = 不知道**（不写 0、不写空串）。**绝不抛**：探针失败一律 `unreachable`；
- 盘上无证书 ⇒ `live.status='unreachable'` + `error='no_certificate'`（没有可比的基准）；
- 每管理员 **30 次/小时**（key `tlsverify:<adminId>`）；**不写审计**（探针不是变更）；
- 结果缓存在进程内存（单实例），随后的 `GET` 直接回放；**上传/回滚成功会把它重置为 `unknown`**。

#### 4.13-5 `POST /api/admin/tls/rollback`

把 `certs/prev/` 的两文件**拷回原位**（`fs.copyFile`，0644 / **0600**）+ `materializeTlsAssets()` + 台账（`kind='rollback'`）+ 审计。
> **#462 / 安全文档 S4**：回滚走 `copyFile` 而不是 `readFile` + `write` —— 私钥不需要进进程内存；
> 拷完显式 `chmod` 固定 644/600（`copyFile` 对**已存在**的目标不继承源模式）。
`certs/prev/` 不存在或不完整 ⇒ **`404 tls_no_previous`**。回滚**不改写 `prev` 本身**（重复回滚幂等）。
限流与上传共用同一个计数器（10 次/小时）。

#### 4.13-6 审计口径

| action | 触发 | `details` |
|---|---|---|
| `admin.tls_updated` | PUT 成功 | `{subjectCN, sans, fingerprintSha256, notAfter, backupCreated}` + 可选 `chainWarnings`（#462，**只有非空时才写**，例如只有叶子时的 `['chain_looks_leaf_only']`） |
| `admin.tls_rolled_back` | rollback 成功 | 同上（`backupCreated` 恒 `false`——回滚不产生新备份）|

两条都带 `actor_id = 当前 admin`、`target = 'tls_certificate'`。**`details` 里没有 PEM、没有私钥、没有密钥派生值**。

#### 4.13-7 红线：私钥只落盘

- **响应**：白名单键集（4.13-1），连 `publicKeyPem` 都不在里面。
- **审计**：只有元数据（4.13-6）。
- **日志**：只记「哪一步失败」（错误码 + 步骤名），不记 PEM 正文。
- **DB**：`tls_certificates` 里没有任何 PEM 列（迁移 0027 的列清单被单测钉住）。
- **读路径**（#462 / 安全文档 S4）：`readTlsAssets` 对 `certs/tls.key` **只 `stat`**（`size > 0` + `mtimeMs`），
  **不 `readFile`**；回滚用 `copyFile`。⇒ portal 的读路径**永不接触私钥字节**，只有上传那一刻必须接收管理员递来的。
- **盘上**：`certs/tls.key` **0600 且属主必须是 Traefik 进程的 uid**（`station-edge` 里 root 没有
  `CAP_DAC_OVERRIDE`，属主/模式不对 ⇒ 9443 握手直接失败）。portal 容器内也是 root ⇒
  `atomicWriteFile(path, pem, {mode: 0o600, root: dynamicDir})` 天然满足。**绝不**用 `chmod 644` 绕。
- **`tls.yml`**：私钥只以**路径**出现。
- 单测 `portal/test/tls-api.test.js` 的 ②⑧ 在响应体与审计 `details` 里搜 PEM/私钥片段；⑨ 钉住键集白名单。

---

### 4.14 文件上传（`POST /api/files/upload`，issue #472 片 B）

用户把本地文件放进自己的牢笼目录（`GET /api/files/tree` / `GET /api/file` 的**入向对偶**）。
能力位本身（谁能传）是片 A 的 `users.file_upload_enabled`，管理台 Edit → Security 里开；本节只写端点。

#### 4.14-1 请求

```
POST /api/files/upload?cwd=<项目cwd或%7E>&path=<相对目录，缺省 .>&name=<文件名>[&overwrite=1]
Content-Type: application/octet-stream
Cookie: <会话 cookie>

<原始文件字节>
```

| 位置 | 参数 | 语义 |
|---|---|---|
| query | `cwd` | 与 `GET /api/files/tree` **同一个值**（`~`、`~/projects/x`…）。缺省 = 牢笼根 |
| query | `path` | `cwd` 下的相对目录，缺省 `.`。逐段拒 symlink（同 §4.11 的 jail 口径）|
| query | `name` | **单段**文件名（含 `.` `..` `/` 控制符在内一律 `400 validation_failed` + `details.field='name'`）；上限 **255 字节**（UTF-8 字节数，不是字符数 —— ext4 的 `NAME_MAX` 是字节，按字符算会让中文名在 86 字就 `ENAMETOOLONG`）|
| query | `overwrite` | **只有字面量 `1`** 算覆盖；缺省/`0`/`true`/其它一律「不覆盖」|
| body | 原始字节 | ⚠ **不是 multipart**，也不是 JSON/base64：门户要传的就是磁盘上那份字节，multipart 的边界解析、内存缓冲、文件名编码问题全部不要 |

#### 4.14-2 闸门顺序（顺序本身是判据）

```
① requireSession                    → 401 unauthorized
② session.user.fde_name 为空        → 400 fde_name_required（没工位 ⇒ 没有落点）
③ file_upload_enabled !== true      → 403 upload_disabled      ← 必须在读 body 之前
④ receiveUpload(...)                → jail/名字/目标检查 → 流式落 temp → 提交
```

三条各自成立的理由：

1. **能力位在读 body 之前（③）**。②③ 都在打开 temp、消费请求流**之前**抛出。上传的 body 是几十 MiB，
   先收完再拒 ⇒ 没开权限的账号能用一个请求把 portal 的磁盘与带宽打一遍，而 portal 是全平台单点。
   单测的钉法不是「响应码对」而是**「答复那一刻 `req` 的 `data` 事件数为 0」**
   （`portal/test/http-upload.test.js`；⚠ 答复**之后** Node 会用 `_dump` 把没人读的 body 排空，
   所以累计计数必然 >0 —— 判据必须取答复前的快照，否则这条变异不死）。
2. **流式落盘，不把 body 读进内存**。逐 chunk 写 temp（`fsutil.writeTempFileFromStream`）+ `fsync` +
   超限时**主动 destroy 流**并删 temp。默认上限 `FILE_UPLOAD_MAX_BYTES=33554432`（32 MiB，`docs/env.md`）。
   反过来说：门户共用的 `MAX_BODY_BYTES`（64 KiB）**不适用**在这里 —— 那是 JSON 请求体的口径，
   拿它卡上传会把所有真实文件判成 413。
3. **no-clobber 用 `link`，不用 `rename`**。`rename(2)` **总是替换**目标，所以「先 `lstat` 看存在、
   再 rename」这两步之间 agent（或另一个上传）创建了同名文件时会被**静默覆盖**。提交点用
   `linkSync(temp, target)`：`EEXIST` ⇒ 清 temp + `409 file_exists`，这是唯一的硬判据；
   `lstat` 那条只是「早退」的快速路径（省掉一次几十 MiB 的传输），**不是**安全依据。
   `overwrite=1` 才走 `rename` 原子替换。目标是 symlink 时**无论 overwrite 一律 400**
   （`rename` 替换的是链接本身 ⇒ 覆盖语义保不住 jail）。覆盖分支还有一个用户可触发的边界：目标在
   传输期间被**换成目录** ⇒ `rename` 抛 `EISDIR`/`ENOTEMPTY`，服务端把它映射成 `409 file_exists`
   （`details.reason='target_is_dir'`）而不是让它变成 500。

#### 4.14-3 落盘属主与模式（不是可选项）

portal 容器以 **root** 写用户空间（`docs/design/user-space.md` §6.1），所以**必须**同时 chown 到
`ctx.config.fdeUid` **和** `fdeGid`（`0660`）：只 chown uid 会留下 `gid=0`（root 组），
容器内的 agent（uid=1000，主组=1000）就**改不动自己工位里刚传上来的文件** ——
上传成功但用户/agent 后续写不进去，是比报错更难查的那种坏。口径与 §6.2 一致（组写位靠属组 + umask，不靠 setgid）。

#### 4.14-4 响应

| HTTP | 体 | 何时 |
|---|---|---|
| `201` | `{path, bytes, overwritten: false}` | 新建成功 |
| `200` | `{path, bytes, overwritten: true}` | `overwrite=1` 且提交掉了旧内容 |
| `400` | `validation_failed` / `upload_interrupted` | 名字或 path 形态非法 / 目标（在**进 body 前**那一刻）是一个目录或是 symlink / 传输中断（可重试）。⚠ 目录这一格是**快速路径**的语义：如果是传输期间才变成目录，那是上面那行 409 |
| `403` | `upload_disabled` | 能力位不为 `true`（**未收 body**）|
| `404` | `not_found` | `cwd`/`path` 指向的目录不存在 |
| `409` | `file_exists` | 目标已存在且没带 `overwrite=1`（快速路径或提交点竞态，同一个码）；**或** `overwrite=1` 而目标在传输期间变成了目录（`details.reason='target_is_dir'`）|
| `413` | `file_too_large` | 超过 `FILE_UPLOAD_MAX_BYTES`，`details = {max_bytes, bytes}` |

`path` 是**相对牢笼根**的路径（与 `GET /api/files/tree`、预览端点同口径），不是绝对路径。
**任何失败路径都不留 `.tmp` 残骸**（超限、断流、提交失败都先 unlink temp）。

#### 4.14-5 前端契约（三态 + 409）

- 按钮渲染条件：`auth.user?.file_upload_enabled === true`。**不是 `!== false`**：缺键的含义是
  「这个 DTO 没告诉我」（旧服务端/旧会话形状），此时给一个点了必 403 的按钮比不给更坏。
- 409 ⇒ `window.confirm` 问「要不要覆盖」，**确认之前零请求**；确认了才**只对这一个文件**重发
  `overwrite=1`（批量里其余文件各自判自己的 409）。选「不覆盖」= 静默跳过，不算失败。
- 上传必须走 `api()`（`portal/frontend/src/api.ts`）而不是裸 `fetch`：裸 fetch 丢掉 `ApiError.code`、
  #255 受限会话跳转与 `details`，前端会把 403/413/409 全糊成「请求失败」。
- 成功后 `emit('files-changed')` ⇒ `WorkbenchView` 重判收工灯（新文件未跟踪 ⇒ 灯该变红，D9
  「红是进度不是警报」）。不重判 = 灯在骗人。

> 实现：`portal/src/http.js`（handler 与闸门）、`portal/src/dirs.js`（`receiveUpload`）、
> `portal/src/fsutil.js`（`writeTempFileFromStream` / `commitTempFileNoClobber`）。
> 单测：`portal/test/file-upload.test.js`（单元：jail/名字/属主/no-clobber/残骸）、
> `portal/test/http-upload.test.js`（HTTP 级：零读取判据、线上 DTO、上限、断流、受限会话门）。

---

## 5. SSE 事件流（`GET /api/sessions/:id/events`）

### 5.1 传输语义

- **SSE 而非 WebSocket**（规格 §10.2）：事件单向，输入走 `POST .../messages`。
- **事件先落 DB，portal 从 DB 读并推流**（规格 §10.2 / D7）：portal 重启不杀正在跑的 run；`seq` 由宿主在落库事务内**逐事件原子 +1 分配**（`UPDATE chat_sessions SET last_seq = last_seq + 1 ... RETURNING`，`UNIQUE(session_id, seq)` 兜底），**每个 session 内严格单调递增、无空洞**——不存在「并发落库产生合法间隙」的情况（runner §7.3）。
  （⚠ 本句写于 #502 之前：「**无空洞**」这一半已作废，跳号自 #502 起合法，口径见紧下面那条实现注记与
  `docs/data/model.md` §1.12；「严格单调递增」与「不是并发造成的间隙」两半仍然成立。）
  > **实现注记（issue #502，#25 裁决的续集）**：**「无空洞」自本单起彻底不成立**——① stream 档碎片
  > （`assistant_delta` / `reasoning_delta` / `tool_call_delta`）**不分配 `seq`**（只转发，见 §5.3 表里那三行），
  > ② U3 写循环去掉了「先 `SELECT` 查重」的预检，重复投递会先烧掉 `seq` 再由 `ON CONFLICT DO NOTHING` 丢掉。
  > 结论对客户端不变、但更强：**跳号不是丢事件**，`chat_sessions.last_seq` 仍单调、`UNIQUE(session_id, seq)` 仍兜底。
  > 下面 #25 那段关于「空洞」的措辞保留在原文里，但**它那句「无空洞只对 `messages ∪ run_events`
  > 联合序列成立」也自本单起作废**：D-8 去掉逐事件的 `SELECT 1` 预查后，重复投递会**先烧掉一个 `seq`**
  > 再由 `ON CONFLICT DO NOTHING` 丢掉，而那一号 **`messages` 与 `run_events` 两张表都不落行**
  > ⇒ **联合序列同样有洞**（依据：`portal/src/internal.js` 的 U3 写循环与
  > `portal/test/internal-delta-not-persisted.test.js` 里「seq 允许跳号」那条用例）。
  > 口径收敛成一句：**`seq` 只保证单调**（它是回放游标，不是无洞的序号），`UNIQUE(session_id, seq)` 仍兜底。
  > **补发不再只依赖 DB，但也只看内存（形态 M）**：断线重连时「已经流出去、但按定义不落库」的那段
  > **当前轮**正文由 portal **进程内累加器**（`portal/src/run-partial-buffer.js`）补出。
  > **没有 DB 回落**（#502 之前那层「退回库里那一行 `partial_output`」已随该种行一起删除）：
  > 已完成轮次的正文是 `round_end.final_text`、那半轮是 `run_end.payload.partial_text`，两者都在
  > §4.4a-1 的**历史投影**里；补发通路只负责**还在流的那一轮**，越界去库里拼一份「看起来像流式」的正文
  > 就是拿已完成轮次的终稿冒充未定稿。**内存没有 ⇒ 一帧都不发**（也不发空帧去清气泡）。
  > **也没有占位帧**：`source:'none'` 那类占位现在只在历史投影里出（§4.4a-1 判据 3）。
  > 补发顺序仍是**「库里已定稿的事件 → 未完稿快照」**，快照帧**不带 `id:`**（碎片没有 seq 坐标系，
  > 进了 `Last-Event-ID` 就等于下一次重连拿一个不存在的 seq 当游标）。
  > **形态 M 删掉了 `uptoSeq` 闸门**：碎片不落库 ⇒ 它没有 seq，而 `Last-Event-ID` 是 seq ⇒ 两套坐标硬比，
  > 比赢就漏发（少一段还没写完的正文，刷新即回）、比输就重发（把已有正文再盖一遍）。替代判据是
  > **两端对同一个事实**：快照帧带 `roundSeq` = 服务端那一轮 `round_start` 的 seq（事实档，本来就有 seq），
  > 前端记下**自己观测到的**该 run 当前轮起点 seq，**两个都匹配（run + roundSeq）才覆盖气泡，否则整帧丢弃**。
  > 服务端因此**不再猜水位线**（`lastEventId` 再大也照发，重复由前端丢弃兜住）。
  > 首次连接（无 `Last-Event-ID`）仍然一条历史都不补发（下面第 3 条不变）；已标终态的 run 也不再出快照
  > （它的内容已经在 DB 里，走历史投影）。
  > 快照帧的字段（`event: partial_output`，**无 `id:` 行**）：
  >
  > ```jsonc
  > { "session_id": "s_3kd9", "run_id": "9d3b2f1e-...",
  >   "roundSeq": 143,          // 服务端那一轮 round_start 的 seq；没观测到就是 null（前端据此整帧丢弃）
  >   "round": 2,               // 轮号（展示用，对账只用 roundSeq）
  >   "text": "还在流的那段正文", // 只含**当前这一轮**；换轮就重置（不跨轮拼成一句界面上没出现过的话）
  >   "reasoning": "…",         // 独立累加，不随轮重置；前端今天不展示，人工排障用
  >   "chunks": 42,             // 本轮正文片数（不是 reasoning 的片数）
  >   "truncated": false,        // 本轮正文超过缓冲上限 16384 才 true
  >   "textSegment": 3,         // **正文段代际号**（261115-01 复审 ② 的 additive 键，语义见下面那条注记）
  >   "source": "memory",        // 形态 M 之后恒为 memory：没有 'db' 回落，也没有 'none' 占位
  >   "ts": "2026-11-13T09:00:02.130Z", "type": "partial_output" }
  > ```
  > **`textSegment` = 正文段的代际号（261115-01 复审 ②，additive 键）**：上面 `chunks` / `roundSeq` /
  > `truncated` 三个键的语义**一字未动**，本键只是**多出来**的一个单调不减计数。
  > · **语义**（服务端侧，`portal/src/run-partial-buffer.js`）：只在**正文段边界** +1，两处——
  >   ① `round_start`（本轮正文槽位重置，与 `chunks` 归零同一处）；② durable `round_end` 插入成功后
  >   提交后的 `closeRound`（`internal.js` 的 COMMIT-后通道 ⇒ `closeRoundText`）。
  >   **其余任何路径都不加、不清零、不回退**（包括碎片累加、截断、重投去重）。
  >   为什么不能用 `chunks` 当代际信号：它在那两处同样**归零**，新段也从 0 起 ⇒ 旧段 5 片、新段 2 片
  >   会被当成「更旧的快照」丢掉。
  > · **前端用途**（`portal/frontend/src/composables/useEventStream.ts` 的 `case 'partial_output'`）：
  >   区分两种「快照比当前正文短」，而**文本形状分不出它们**——
  >   ① 「新的一段」（哪怕更短、哪怕恰好是旧那一段的前缀）⇒ **接受**；
  >   ② 「同一段被 `textCap`（16384）夹过的那一份」⇒ **忽略**（#513 E2 的截断保护，不许被本键改动）。
  >   规则三条：代际**大于**本连接已记录的 ⇒ 接受并推进记录；**等于**且快照是当前正文的严格前缀 ⇒ 忽略；
  >   **小于**已记录的 ⇒ 忽略（过期一代，不推进记录，否则水位线会倒退）。
  > · **兼容性**：纯 additive ⇒ **旧客户端不读它**（照旧只走上面那条前缀规则），多发一个键不破任何既有口径。
  >   帧里**缺** `textSegment`（旧后端）或本连接**从未**观测过该 run 的代际号（刚重连）⇒ 前端**退回前缀规则**
  >   （**不报错、不崩**）。⚠ 但这条兼容口径仍是**保守**的，「不报错不丢帧」是说过头了：旧后端下若同轮
  >   正文**合法地**变短、且恰是当前正文的**严格前缀**，那一帧会被**忽略**（宁可不覆盖，也不抹掉用户
  >   已经看到的那段后缀；实现见 `useEventStream.ts` 的「规则 2 / 两个兜底档」，有用例钉住）。刷新或下一帧
  >   变长就补得回来 ⇒ 代价是「一时少一段」，不是「丢一帧」。
  > · 本键**不进** `Last-Event-ID` 坐标、**不落库**（与快照帧本身同生命周期）、**不是**轮号（轮号是 `round`）。
  >
  > **单副本前提（形态 M 明确接受的限制）**：累加器与 SSE hub 都是 **per-process** 的 ⇒ 本节的补发能力
  > 假设 portal 单副本部署。多副本时「断在另一个副本上」必然看不到那段正文（表现 = 少一段未定稿，
  > 不是脏数据），要跨副本补发得先把累加器换成共享存储（登记在 §8.125 的后续里）。
  > **已接受损失（缓冲 LRU 逐掉活跃 run，issue #515；台账指针见 §8.126.4）—— 潜伏项**：
  > 缓冲的条目上限 `maxEntries = 32`（`run-partial-buffer.js` 的 `PARTIAL_MAX_ENTRIES_DEFAULT`，32 × 64 KB ≈ 2 MB），
  > `evictOne()` **优先逐已终态的 entry**（`markTerminal` 标过的那些）。但当**同时 >32 个活跃 run 且一条终态
  > 条目都没得逐**时，它必须逐一个**仍在流**的 run（该 run 从此在缓冲里没槽）。后果链：被逐的 run 若终态时
  > **零助手锚点** ⇒ `runEndPartialKeys` 读到空快照 ⇒ `run_end` 里**写不出 `partial_text`** ⇒ **那半轮正文
  > 永久丢**，已跑完的轮次仍在（`round_end.final_text`），两处都空则历史里只剩 §4.4a-1 判据 3 的**占位项**
  > （表现 = 「那段没了」+ 一行中性提示，不是脏数据）。今天**踩不到**：单 portal 副本 + 实际并发远小于 32
  > （认领 SQL 串行 + 会话租约 ⇒ 单进程同时跑的 run 是个位数）。可观测面只有一半：逐出活跃 run 会计
  > `stats().evictedActive` 并打一条 `log.warn`（**不静默**），但 `stats()` **没被挂到任何对外端点上**
  >（现查 `grep -rn metrics portal/src` = 0 命中，portal 今天没 `/metrics`）也没进事件流 ⇒ 只能翻日志对账。
  > ⇒ **已在 issue #515 开单要求显式裁决**（三选一：① 把 `maxEntries` 与 portal 级
  > active-run 硬上限绑定（结构上排除逐出）；② 逐出时发一条可观测信号（诊断事件 / 指标）；③ 显式接受并
  > 把本段当成交付）。**本节不拿「单副本前提」这条兼任它的豁免**：那一条说的是「跨副本不可见」，
  > 本条是「同副本内被自己的上限逐掉」，两个成因不同。
  > **实现注记（issue #25 裁决）**：「无空洞」只对 **`messages ∪ run_events` 联合序列**成立（两表共用 `chat_sessions.last_seq` 分配器，schema.sql §3）；SSE 只推 `run_events`，故**事件流单独看存在合法空洞**（user 消息、assistant 回写各占一个 seq）。因此客户端**不得**以「seq 跳号」作为重连触发条件（会把合法空洞误判为丢事件，重放后仍跳号 → 无限重连风暴，实测复现）。丢失恢复路径：① 服务端 `resync` 控制帧（缓冲溢出，见下）；② 浏览器 `EventSource` 自动重连天然携带 `Last-Event-ID`（§5.2 补发 `seq > lastEventId`）。前端仅在收到 `resync` 时主动 `close()` + 以 `?last_event_id=<本地已知最大 seq>` 重连。
  > ⚠ **时间边界（261114-04 审计补）**：上面那句「无空洞只对联合序列成立」**写于 #25，已被 #502 推翻**——
  > 重复投递先烧 `seq` 再被 `ON CONFLICT DO NOTHING` 丢掉 ⇒ 那一号两张表都不落行，**联合序列也不保证无洞**
  > （见上面那条 #502 注记与 `docs/data/model.md` §1.12）。原文留着是取证它当时的口径；本注记**仍然有效的部分**
  > 是后半句：客户端不得拿跳号当重连判据，丢失恢复只走 `resync` 与 `Last-Event-ID` 两条路。
- 响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`X-Accel-Buffering: no`。
- 每 15s 发送注释行心跳（`: ping\n\n`），防止中间层断连。心跳不是事件，不占 seq。
- 响应建议携带 `retry: 3000`，指导浏览器断线重连间隔。
- **`resync` 控制帧**（宿主侧帧，**不属** §5.3 事件类型清单、不带 `seq`/`id`）：服务端补发前的缓冲溢出（上限 1000 条）时，portal 不再静默丢事件——向该连接写 `event: resync` + `data: {"reason":"buffer_overflow"}` 后 `res.end()`。该帧**不带** `last_seq`：重连游标由客户端用自己的本地水位线（已收到的最大 `seq`，含 `messages` 与 `run_events` 共用分配器造成的跳号）维护，服务端缓冲区里的最大 seq 不构成可靠游标（补发/写回窗口内可能漏）。客户端应立刻 `close()` 并以 `?last_event_id=<本地已知最大 seq>` 重连，由补发路径收敛（§5.2）。这是客户端唯一的主动重连触发条件（未知类型忽略原则仍适用于 §5.3 之外的其它扩展类型）。

每条事件的 wire 格式（**两档两个形状**，#502）：

**durable 档（落库、占 `seq`）**——带 `id:`，`id` 恒等于 envelope 的 `seq`，这是 `Last-Event-ID` 的依据：

```
id: 129
event: round_end
data: {"seq":129,"ts":"2026-09-12T09:00:02.130Z","session_id":"s_3kd9","run_id":"9d3b2f1e-...","type":"round_end","round":2}

```

**stream 档（不落库、不占 `seq`）**——**不带 `id:` 行**，envelope 里的 `seq` 是 **`null`**（键在、值为 null，
不是 0，也不是「没这个键」——现查 `internal.js#writeSessionEvent` 直接序列化 `ev.seq`）：

```
event: assistant_delta
data: {"seq":null,"ts":"2026-09-12T09:00:02.130Z","session_id":"s_3kd9","run_id":"9d3b2f1e-...","type":"assistant_delta","text":"好的"}

```

为什么不写 `id:`（#502）：`assistant_delta` / `reasoning_delta` / `tool_call_delta` 三类碎片只转发不入库
⇒ 它们根本没有 `seq` 坐标系；给上 `id:` 就等于把浏览器 `Last-Event-ID` 推到一个不存在的 seq 上，
下次重连从错误游标补发（钉在 `portal/test/internal-delta-not-persisted.test.js` 判据 ④）。
同样不带 `id:` 的还有补发快照帧 `partial_output`（§5.1 注记）与宿主控制帧 `resync`（见下）。
**前端判据**：不得假定「帧都有可用的 `seq`」（`null` 不是 0），也不得拿「有没有 `id:`」当错误信号；
只有带 `id:` 的帧参与 `Last-Event-ID` 游标（§5.2）。

### 5.2 `Last-Event-ID` 断线续传语义

1. 客户端（浏览器 `EventSource` 自动）重连时带 `Last-Event-ID: <seq>` 头。
2. portal 从 DB 补发该 session 中 **`seq` 大于该值**的全部历史事件（重放 SQL 里带着
   `type <> 'partial_output'`——形态 M 之后新代码不再产生这种行，这句是**防御性保留**，
   防的是迁移还没跑、库里残留旧行的窗口），**然后**按 run 追加未完稿快照帧（`event: partial_output`，
   见 §5.1 那条注记：**只读进程内累加器**、每个「有正文且未终态」的 run 一帧、`source:'memory'` +
   `roundSeq`、**不带 `id:`**、**不与 `Last-Event-ID` 比较**），再切到实时流。
3. 无 `Last-Event-ID`（首次连接）：**不补发历史**，只推连接之后的新事件——历史消息/状态由 `GET /api/sessions/:id`（含 `last_seq` 与消息列表）获取；前端如需从某点重放，可显式带 `Last-Event-ID` 或查询参数 `?last_event_id=<seq>`（两者等价，查询参数供非 `EventSource` 客户端使用）。
4. `Last-Event-ID` 大于当前 `last_seq`（如 session 已删）→ `404 not_found`；小于最小保留 seq（事件归档后）→ `410 Gone` + `{"error":{"code":"replay_unavailable", ...}}`，前端应回退到 `GET /api/sessions/:id` 全量拉取。

> ⚠️ 与归档策略的对应（model.md §4，决策者 2026-09，issue #3 评论）：**事件冷存导出暂不实施（P1/P2 不删除事件）**，因此 `410 replay_unavailable` **保留定义但当前不会触发**；前端仍应实现该回退分支以兼容将来启用归档。

> 也可用该端点做**事件重放**（P2 验收「断线重连不漏事件」即依赖本节语义）。

### 5.3 事件信封完整类型清单（对应规格 §10.1；LoopEvent 部分与 erix-agent v0.3.5 `src/loop.js:533` 的 LoopEvent union 一一对应，共 8 类）

所有事件共享信封：

| 字段 | 类型 | 说明 |
|---|---|---|
| `seq` | number \| null | 宿主落库时分配，session 内**单调递增**（允许跳号，见 §5.1 注记）。**只有 durable 档才有值**：stream 档碎片不落库 ⇒ `seq` 为 **`null`**（帧也不带 `id:`）；portal 合成的状态类事件（如第 17 类 `queue_update`）同样是 `null`。**前端不得把 `null` 当 0** |
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
| 5 | `usage` | 同上 | `round: number`，`usage: object`（嵌套 usage 对象，形如 `{input_tokens, output_tokens}`；依据：`src/loop.js:1355`/`1928`/`1960`。宿主若拍平为顶层 `input_tokens`/`output_tokens`，属宿主侧改写，须显式注明）。**#425 起宿主侧 additive 字段 `context_window: number`**：值 = 本 run 下行的模型上下文窗口（与喂给引擎 `modelMetadata.contextWindowTokens` 同一个数，#309），**只在正整数时写键**，未配/脏值 ⇒ **整键缺席**（不写 0）；前端据此出「上下文占用 %」，没有就整段不出。引擎事件本身不带这个字段 ⇒ 不记为上游契约变更 |
| 6 | `tool_use` | 同上 | `tool_call_id: string`，`name: string`，`input: object` |
| 7 | `tool_result` | 同上 | `tool_call_id: string`，`name: string`，`result_digest: string`，`duration_ms: number \| null`，`ok: boolean`（**issue #283 → #299**：`duration_ms` 可为 `null`。erix-agent **0.20.0** 起引擎把时长写进 `tool_result.erix.durationMs`，**真执行过的四种返回形态（string / number / `{content,metadata}` / 抛异常）都会给值** ⇒ 本站 #283 那层装配期临时计时闸（`runner/lib/tool-duration.js`）已撤。仍没有值的只剩三种状态：judge 拦截、unsafe 重放被中止、executor 未 settle 就被中止（上游 `TOOL_RESULT_CONTRACT.engine.fields.durationMs`）。runner 映射读 `erix.durationMs`，**旧记录**（一代内）回退顶层 `duration`；两者都缺一律 `null`，**不伪装成 0**，前端据此不渲染时长） |
| 8 | `round_end` | 同上 | `round: number` |
| 9 | `assistant_delta` | `onDelta` | `text: string`（增量文本片段）。**#502：不落库、不占 `seq`**（SSE 帧不带 `id:`），dev 实测平均 2.09 字符/片 |
| 10 | `reasoning_delta` | `onReasoningDelta` | `text: string`（推理增量片段）。**#502：不落库、不占 `seq`**（前端 P1 本来就不展示推理增量） |
| 11 | `tool_call_delta` | `onToolCall`（参数增量）。**#502：不落库、不占 `seq`**，并已从 §4.4a 下发白名单摘掉（成形后的参数在 `tool_use.input` 里，历史侧本来就该看那条） | `tool_call_id: string`，`name?: string`（仅首帧），`arguments_delta: string`（JSON 文本片段，前端按序拼接得完整入参） |
| 12 | `judge` | `onJudge` | `kind: "round"\|"intercept"`，`action: "judge_done"\|"nudge"\|"continue"\|"executed"\|"blocked"\|"degraded"`，`decision: {done, confidence, reason, evidence} \| null`，可选 `error: "timeout"\|"error"\|"parse"`，可选 `tool: {id?, name?, input?}`（依据：erix-agent v0.3.5 `src/loop.js:545-552` JudgeEvent typedef；对应 `judge_decisions` 表） |
| 13 | `run_end` | portal 由 U2 终态**合成**（数据源 = `runToolLoop` 返回值经 U2 终态载荷上报，worker 不再经 U3 发 `run_end`，runner §7.6） | `termination: { reason, detail? }`（**对象**，`reason` 取值集合见 §4.1；`persistence_failed` 另带 `operation`/`phase`/`sideEffect`——runner 自 0.17.0 起原样透传引擎挂在错误上的 termination，见 §5.3 注与 issue #212；**0.18.0 起** `reason === "failed"` 的终局另带引擎 additive 字段 `errorCode`（上游 #176，值域由引擎定义，宿主不解释）），`usage: { input_tokens, output_tokens }`（整 run 汇总），`attempt`（第几次尝试，runner §7.6）；失败时附加 `error: { code, message, retryable }`（见 §6）；**attempts 耗尽那条**（`error.code = max_attempts_exceeded`，§9.11）**issue #288 起 additive 另带** `last_reason: string` / `last_silent_ms: number`（release 上报过 kill 信息时出现，没上报就**没有这两个键**） |
| 14 | `attempt_killed` | **portal 合成，两条产出路径**（不是引擎事件、不经 U3、不进 `run_queue`）：① **U12 release 的 requeue 分支**（`releaseRun`，issue #288 缺陷 B：agentd 还活着并 additive 上报 `killed_by`，§9.11）② **run 租约 reaper 的 requeue 分支**（`reapExpiredRuns`，issue #292：上报者自己已死、根本没有 release，由 portal 自己合成，§9.11 注记） | `attempt: number`（死掉的那次尝试，1-based = `run_queue.attempts`），`max_attempts: number`，`reason: string`（**开放值、无枚举白名单**：release 路径 = agentd 上报的 reason 原文，如 `watchdog_silent` / `worker_crashed`；**reaper 路径固定 `lease_expired`**），`killed_by: "watchdog" | "crash"`（`watchdog` = F6 执行期静默被判死；`crash` = worker 非预期退出；**reaper 路径固定 `crash`**——它无从区分看门狗与真崩，保守取值），可选 `silent_ms: number`（判死前的静默时长 = **最后一次 IPC 上报之后**算了多久，只有活着的 agentd 报得出来；**只在可信时出现，绝不写 0/null 冒充「有」⇒ reaper 形态固定不带**），可选 `next_retry_in_ms: number`（预留：portal 侧支持，当前 agentd 不发；reaper 也不发） |
| 15 | `tool_replay_decision_required` | `onEvent`（LoopEvent 透传，erix-agent 0.18.0 additive 类型；**仅在 `replayPolicy: "per-tool-declaration"` 下才会发**，本站自 issue #288 缺陷 C 起传该值） | `tool_call_id: string \| null`，`round: number`，`name: string \| null`（被中断的工具），`replay: string \| null`（引擎解析出的声明，当前只可能是 `"unsafe"`），`requires_host_decision: boolean`（引擎恒给 `true`），`partial_output_available: boolean`（快照里有没有已归档的部分输出）。语义：**该工具的上次执行被崩溃打断，引擎没有重放它**，模型同时收到一条 `is_error: true` + `executionStatus: "interrupted"` 的 `tool_result`（第 7 类），**是否重试由模型决定，引擎不自己重试**。⚠ 信封里的 `run_id` 是 station run id，而引擎事件自带的 `runId` 是 store key = `transcriptKey` = `session_id`（issue #81 P2）——runner 映射时落名 `engine_run_id` 以免同义不同（`runner/worker.js loopEventPayload`） |
| 16 | `persistence_error` | **引擎 `diagnostics.error` 通道**（**不是 `onEvent`**；本站接线在 `runner/worker.js` 的 `diagnostics: { error: … }`，映射在 `loopEventPayload` 的 `persistence_error` 分支）。erix-agent 0.23.0 起就有这条通道（`orchestrator.js:873`），`fatal: false` 一类也已存在（`:895` 宿主端口桥）；erix-agent#461 / 0.25.0 再加一类「剥掉折叠归档后重试一次」 | `port: string`（缺省 `"transcript"`），`phase: string \| null`，`operation: string`（缺省 `"unknown"`；实测致命那条 = 失败的 store 方法名，如 `appendRound`），`engine_run_id: string \| null`（**引擎 store key = transcriptKey = sessionId**，不是 station run id，#81 P2 老坑），`fatal: boolean`（**runner 归一：缺字段/脏值算 `true`**——宁可报重，不可把真失败刷成灰），`sideEffect`（引擎原样透传），`error: {name, message}`（**`stack` 刻意不透传**：那是宿主日志的东西，塞进 UI payload 只会淹没前端），`ts: string \| null`。**可见性口径**：`fatal === false` → 中性分隔行（不影响本次任务）；`fatal === true` → 界面交给 `run_end` 的 `persistence_failed` 红面，本事件只作可审计明细、不重复刷 |
| 17 | `queue_update` | **portal 合成（issue #370）**：入队 / 整队取回 / 终态出队（含被闸门挡下）三处推 |`steering: [{id, content}]`、`follow_up: [{id, content}]`（**恒为全量快照，不是增量**）、`blocked: string \| null`（暂停投递原因，当前值域 `container_not_running` / `deliver_failed` / `not_deliverable_at_terminal`；界面按它出本地化文案，**服务端只发码不发话**，#294）、`delivered_run_id: string \| null`（**本帧存在的原因是一条队列输入被投出去了** ⇒ 这个 run 刚被建起来；前端只有在「本机没有活跃 run」时接管它，见下）。**信封 `seq` 与 `run_id` 均为 `null`**：它不是历史事件而是**状态**，真相在 `queued_inputs`，可由会话详情全量重建 ⇒ **不落 `run_events`、不进历史白名单、不参与回放**（同第 16 类之外的 `session_updated` 那一支）。 |
| 18 | `compaction_strategy_fallback` | **引擎 `onEvent`**（additive `LoopEvent`，erix-agent 0.25.0 上游 #464-A；发射点 `orchestrator.js:3193`） | `round: number`、`detail: string`（首句是**固定原文**，宿主可直接断言）、`runId`（= 引擎 store key = transcriptKey = sessionId，**不是** station run id，#81 老坑）。语义：**你配在 `context.strategy` 上的折叠策略没生效，实跑的是引擎库层默认的 `sliding-window`**（整轮丢头、不摘要）。条件：仅当 `context.strategy` **未配置**时发，每 run 恰好一条 ⇒ 本站恒配 `fold-llm`（#438 切片 B 起），**这条一响就意味着本站的配置没送到引擎**（#392 那个回归的机读信号）。界面：中性分隔行（`stream.event.strategyFallback`）；runner 另落一条 `warn` LOG（`runner/lib/engine-notices.js`）。 |
| 19 | `model_metadata_missing` | **引擎 `onEvent`**（erix-agent 0.18.0 上游 #182；发射点 `orchestrator.js:1040`） | `runId`（同上口径）、`detail: string`。**注意：本事件没有 `round`**（引擎不给，文案也不许编）。语义：模型上下文元数据取不到 ⇒ **本 run 的压缩闸门与聚合输出预算整条关闭**。本站 #309/#316 的行为级测早拿它当判据（「压缩关掉必须是可观测的」），但今天只有测试看得见——#421 之后实时 / 刷新 / LOG 三条路都看得到。界面：中性分隔行（`stream.event.metadataMissing`）。 |
| 20 | `persistence_capability_degraded` | **引擎 `onEvent`**（erix-agent 0.20.0 上游 #173 PR-B；发射点 `orchestrator.js:1011`） | `runId`、`method: string`（缺的那个 store 能力名）、`detail: string`。语义：宿主 store 没实现某个持久化能力 ⇒ **那一步整个 run 跳过（中途崩溃不可恢复）**，每 run 每个方法最多一条。本站实现了 `saveRunSnapshot`（旧名 `saveCheckpoint`/`appendCheckpoint` 只是引擎兼容别名）⇒ 今天不响，一响就是 portal 侧 store 面回退了。界面：中性分隔行（`stream.event.capabilityDegraded`）。 |
| 21 | `resume_journal_skipped` | **引擎 `onEvent`**（erix-agent 0.24.0 上游 #420/#421；发射点 `orchestrator.js:2525`） | `runId`、`round: number`、`reason: string`（当前实测值 `crash_round_assistant_not_in_ledger`）、`count: number`。语义：**崩溃那一轮的助手消息不在账上 ⇒ 那批工具结果本次没入账**，下一次恢复仍靠快照兜住。本站天天在恢复会话 ⇒ 可达。界面：中性分隔行（`stream.event.resumeJournalSkipped`，`count` 缺 ⇒ 「若干」，`round` 缺 ⇒ `?`，绝不拿 0 冒充，#283）。 |
| 22 | `run_outcome` | **引擎 `onEvent`**（erix-agent 0.21.0 上游 #165；记录体 `judge-record.js:105`，正常终局走 `termination.js:700`、抛错终局走 `orchestrator.js:1197`） | `runId?`、`model?`、`judgeModel?`、`rounds?`、`judgeRecordCount?`、`termination?`、`verification?`（全是条件写入，没给就**没这个键**）。语义：**每 run 恰好一条**的 run 级终局汇总（`runOutcomeEmitted` 去重）。**本站今天不展示它**：它与第 10 类 `run_end` 语义重叠（rounds / 终局）且无读者，故**不进 §4.4a 历史白名单也不进 `HISTORY_REPLAY_TYPES`**（订得到：水位线与 `hooks.onEvent` 观察面拿得到；runner 落一条 `info` LOG）。豁免理由钉在 `portal/test/event-surface-contract.test.js`——等 §12 台账 / 结算面板真用它时再接。 |
| 23 | `compaction_deferred` | **引擎 `onEvent`**（erix-agent 0.29.0 的 `LoopEvent` 联合类型新增；发射点 `orchestrator.js:4884`） | `round: number`、`reason: string`（当前实测值 `pending_tool_use`）、`detail: string`。语义：**本轮没折**——请求尾部是「有 `tool_use`、没 `tool_result`」的未结清回合（`max_tokens` 续写还在飞），折了就会把半截工具调用写成摘要或破坏 `tool_use`/`tool_result` 配对；下一轮对完整回合再折。界面：中性分隔行（`stream.event.compactionDeferred`，`round`/`reason` 缺 ⇒ `?`，绝不拿 0 冒充）；runner 另落一条 **`info`** LOG（每轮最多一条的正常推迟，不占 warn 面）。 |
| 24 | `budget_below_working_set` | **引擎 `onEvent`**（erix-agent 0.29.0 新增；发射点 `orchestrator.js:4056`） | `round: number`、`budgetTokens: number`、`workingSetTokens: number`、`suggestedBudgetTokens: number`、`repeatStreak: number`、`foldLayersOverBudget: number`、`attempts: number`、`detail: string`。语义：连续几次折叠后**工作集本身**仍超预算且模型在反复重读同一输入 ⇒ 引擎判定「预算装不下模型手上的东西」并**提前终局**（不再空转到 `max_rounds_cap`）。这是「预算配小了」的机读信号，与 §5.3 第 1 类的 `stall` 不同：它带**该配多少**的建议值。界面：中性分隔行（`stream.event.budgetBelowWorkingSet`）；runner 另落一条 **`warn`** LOG。 |
| 25 | `config_override_conflict` | **引擎 `onEvent`**（erix-agent 0.29.0 新增；发射点 `orchestrator.js:1271`） | `conflicts: [{path: string, key: string}]`（冲突叶子的 schema 路径与顶层键名，**只带路径与键名**，值不进事件）、`detail: string`。语义：`config.*` 与同名扁平键（或调用级 `config` 与装配口 `policy.config`）同时给了**不同的值**。**本站显式豁免、不刷时间线也不回放**：本站只写 `config.<组>.<叶>`（切片 A 迁移后的唯一拼写）⇒ 结构上不可能出现；真响了就是宿主代码 bug，账在 runner 的 **`warn`** LOG 里（`runner/lib/engine-notices.js`），时间线上没有用户可行动的信息。豁免理由钉在 `portal/test/event-surface-contract.test.js`。 |
| 26 | `continuity_injection_skipped` | **引擎 `onEvent`**（erix-agent 0.29.0 引入；发射点 `orchestrator.js:3419`）。⚠ 0.29.0 时它「经 `onEvent` 真发但不在 `LoopEvent` 联合类型里」（上游漏登记）；**0.30.0 起上游把 `continuity_injection_skipped` / `continuity_written` / `continuity_write_failed` 三条全补进了联合类型**，那条「联合外真发」的豁免理由**已失效** | `round: number`、`reason: string`（如 `pending_tool_use`）、`detail: string`。语义：本轮**没有注入**续接块。**本站显式豁免、不刷行也不回放**：本站在 `config.continuity` 与 `capabilities.hooks.continuityProvider` 上**都不传**（`handoff` 默认 `off`）⇒ 引擎连注入分支都进不去，本事件在本站结构上不可能出现。同一族里 `continuity_written` / `continuity_write_failed`（写者那一半）0.30.0 起**订得到**（联合类型要求），但同样**豁免**（handoff=off ⇒ 引擎不写不发；`write_failed` 另有一条 runner `warn` LOG）。 |
| 27 | `user_turn_guard_unrecoverable` | **引擎 `onEvent`**（erix-agent 0.30.0 的 `LoopEvent` 联合类型新增 8 类之一；发射点 `orchestrator.js:2716`） | `round: number`、`channel: string`、`reason: string`、`detail: string`（首句是固定原文）、`runId?`、`parentRunId?`。语义：请求视图违反「必须有 user 轮」不变式、且**所有回补都失败** ⇒ 请求**原样发出**，上游多半以 400 拒掉它。它是在那次 400 **之前**发的，所以是唯一归因信号。界面：中性分隔行（`stream.event.userTurnGuardUnrecoverable`，`round`/`channel`/`reason` 缺 ⇒ `?`）；runner 另落一条 **`warn`** LOG。**0.30.0 的 8 个新类型里本站只把这一类放进时间线**：另外 5 个（`tool_output_aggregate` / `continuity_written` / `continuity_write_failed` / `final_guard_extend` / `context_unknown_option`）是**写明理由的豁免**（见 `portal/test/event-surface-contract.test.js` 的豁免表），`forced_final` 与 `continuity_injection_skipped` 早在册。 |
| 28 | `host_steer_injected` | **引擎 `onEvent`**（erix-agent 0.32.0 的 `LoopEvent` 联合类型新增——0.32.0 **27 类 → 28 类，只多这一个、删 0**；发射点 `orchestrator.js:3300`，级别 `fact`） | `round: number`、`chars: number`（注入那条 user 轮的正文字符数，上游 #753 C1 钉了它）。语义：宿主经 `capabilities.hooks.nextUserTurn` 递进来的那句话**真的被注成了这条 user 轮**。**本站显式豁免、不刷行也不回放**：引擎只在钩子是个函数时才走到发射点（`orchestrator.js:3253` 早退），而本站**不传那个钩子**（现查 `grep -rn "hooks\s*:" portal runner | grep -v node_modules` = 0 命中）⇒ 结构上不产生该事件；即使开了，用户可见的反馈也已在 `queue_update`（§4.3a）与注入后的正文里，再加一行是同一件事说两遍。订得到（水位线推进、`hooks.onEvent` 观察面可见），但**不进 §4.4a 历史白名单也不进 `HISTORY_REPLAY_TYPES`**，同 `run_outcome` / `continuity_injection_skipped` 先例；决定与理由钉在 `portal/test/event-surface-contract.test.js` 的豁免表（只加前端 `EVENT_TYPES` 不写决定会被 S2 判红）。 |

> 说明与边界：
> - **第 18~27 类是 issue #421 / #438 / #442 补接的「引擎承诺、宿主订不到」那一族**（#421 = 2026-10-27，#438 切片 B = 2026-11-02，#442 = erix-agent 0.30.0 升级片）：erix-agent 对宿主承诺 **28 类事件**（`src/loop/orchestrator.js` 里 `LoopEvent` 的 `@property` 联合类型；0.29.0 是 19 类，0.30.0 涨到 27 类，**0.32.0（#499）涨到 28 类——只多第 28 类 `host_steer_injected`，删 0**；**这份清单由 `portal/test/event-surface-contract.test.js` 从已安装引擎源码解析，不再手抄**），而本站三处白名单（前端 `EVENT_TYPES` / 前端 `HISTORY_REPLAY_TYPES` / 本文件 §4.4a 与 `http.js` 的 `HISTORY_EVENT_TYPES`）此前只认 11 类。写入侧不过白名单（`internal.js` 直接 `INSERT`）⇒ 这 5 类**每轮都在往 `run_events` 里写，而浏览器一条都收不到**（#371-A 同形状：库里存着、读不出来）。对账测：`portal/test/event-surface-contract.test.js`（从**已安装引擎源码**解析联合类型，上游改联合类型、本站删监听、豁免没写理由、联合外真发的事件没决定都会红）+ `portal/frontend/src/composables/engineEventSurface.spec.ts`（行为面：订得到 / 能回放 / 文案不编数据）+ `runner/test/engine-notices.test.js`（LOG 那一半）。**新增一类时三处必须同步，且 `run_outcome` 那种「订到但不展示」的决定必须写进豁免表。**
> - 第 1~8 类是 **erix `LoopEvent` 的原样透传**（规格 §10.1：「`type: 同 LoopEvent`」），与 erix-agent v0.3.5 `src/loop.js:533` 的 LoopEvent union 一一对应（8 类，契约锚点见 principles §6）。**上游 additive 新增 LoopEvent 子类型时宿主原样透传**，前端按「未知类型忽略」规则处理即兼容（规格 §13.2-3 additive 原则）。
> - 第 9/10/11/13 类的字段形状在规格 §10.1 已锚定（**第 14 类 `attempt_killed` 是规格之外的宿主新增事件，规格 §10.1 没有它，字段以本表为准**——additive 新类型不破坏上游契约，§13.2-3）（`{text}` / `{termination, usage, compaction_stats}`；第 11 类规格写作 `{type:"tool_call_delta", ...}`，上表字段为宿主侧补全）。**注（#21 审计决策 ②）**：规格 §10.1 曾写作 `compaction_stats`（本决策已一并删除），该字段在宿主全链路（`runner/`、`portal/src/`）无透传实现、U2 终态载荷不携带——本表与 §9.6 统一按**实际字段集** `termination` / `usage` / `rounds` / `final_text`（+ `attempt`，失败时 `error`）描述，不再引用 `compaction_stats`。
> - `termination` 是**对象** `{reason, detail?}`（`persistence_failed` 另带 `operation`/`phase`/`sideEffect`），`reason` 取值集合以 erix-agent 0.18.0 的 `runToolLoop` 返回值契约为准：<!-- DRIFT:termination-reason:begin -->`reason ∈ {end_turn, no_tool, stall, max_rounds_cap, judge_done, continuation_exhausted, final_guard_unverified, aborted, failed, persistence_failed}`<!-- DRIFT:termination-reason:end -->（依据：`src/loop/orchestrator.js:511` typedef 的 9 值 + `:973-990` 的 `persistence_failed`；单一真相常量在前端 `lib/terminationReasons.ts`，与 §4.1 及 `docs/data/model.md` §1.7 逐项对齐）。宿主映射（**issue #212 修正**：0.18.0 的失败/中止走 `fail()` **抛异常**，完整 termination 挂在错误上）：runner 一律**原样透传** `err.termination`，引擎没给才回退 `aborted`/`failed`（`runner/worker.js` catch + `runner/lib/termination.js`）——所以引擎失败可以是 `failed` **或** `persistence_failed`（快照没落盘，崩溃恢复可能重复副作用，语义最重），用户主动停止 → `aborted`；正常结束 → `end_turn`（或 `no_tool` / `judge_done` 等）。前端有**两个**集合，别再混用（issue #236）：① **功能面**的 `RUN_FAIL_REASONS` 含 `failed` / `max_rounds_cap` / `aborted` / `persistence_failed` / `final_guard_unverified`——它决定「重试上一条」（#261B）与「终态后补拉 history」（#306），**`aborted` 仍在其内**；② **界面分级**的 `RUN_TERMINATION_SYSERR_REASONS` = ① 减掉 `aborted`（由①**派生**，不手抄）——只有它决定终态行刷红：`failed` / `max_rounds_cap` / `persistence_failed` / `final_guard_unverified` 红，其余（含 `aborted`）中性。理由：用户按「停止」不是故障（#236 §1）。**实时 `run_end` 与历史合成项 `run_termination`（§4.4a-2）共用这一条分级规则与同一份母语标签表**（`RUN_END_LABEL_REASONS`，除 `end_turn` 外的每个 reason 都有 zh-CN/en 标签；未知 reason 回落原文）。**erix-agent 0.18.0 起（上游 #176）**，`reason === "failed"` 的终局另带 additive 字段 `errorCode`：引擎把错误上已有的分类码原样透出（`timeout` / `rate_limited` / `auth` / `server` / `checkpoint_failed` / …），无分类码则为 `unknown`，**值域由引擎定义**；station 原样透传引擎 termination，因此运行时零改动即已下发（依据：`src/loop/termination.js:43-57`，在 `orchestrator.js:981-984` 调用），前端不解释其语义、也不新增枚举。**若宿主需额外区分「cancelled」这类 UI 语义，那是宿主从 `cancel_requested_at` + `termination.reason` 推导的展示态，不得冒充引擎取值**。**erix-agent 0.30.0 起（上游 #661）新增一个错误码 `summarizer_failed`**：`fold-llm` 的 LLM 摘要器失败（reject / 抛错 / 超时 / 回空文本）**不再静默降级为统计摘要**，而是抛 `KitError("summarizer_failed")` ⇒ run 以 `termination.reason === "failed"` / `termination.errorCode === "summarizer_failed"` / `error.code === "summarizer_failed"` / `retryable: false` 收场（归因分类在**异常**的 `details.kind` 上：`timeout` / `context_window_exceeded` / `empty_summary` / `error`）。失败那一折**一个键都不留**：没有 `compaction` 事件、轮记录里没有该折的 `foldedFacts`、折叠水位线不前进。宿主侧三处口径：① 前端把它翻成人话（`lib/terminationReasons.ts` 的 `RUN_ERROR_CODE_LABELS` → `stream.event.runErrorCode.summarizerFailed`，**不新增 UI 结构**：仍是既有红色 `.syserr` + `code=summarizer_failed` 后缀）；② runner 打一条 warn（`lib/engine-notices.js#summarizerFailureNotice`，文案说清「这是失败，不是降级」）；③ 折叠横幅**不再有**「摘要已降级」后缀——`foldSummary.degradeKind` / `degradeReason` / `degraded` 在 0.30.0 已无任何生产路径，本站读它们的分支已删（判据：`runner/test/compact-knobs.test.js` 的 K9 + 前端 `useEventStream.spec.ts` 的反向断言）。
**issue #370 新增一个宿主 additive 字段**：`detail === 'steered'`（轮边界转向导致的 abort，`reason` 仍是 `aborted`、值域零改动；runner 只补 detail，且**不覆盖引擎已给的 detail**）。它的唯一用途是**功能面**：转向导致的 abort 不点亮「重试上一条」（用户刚说「用这句继续」，再给一个「把上一条原话重发」是倒退，还会挤掉他刚排的那条转向）。⚠ **不进红色集合、不改 `RUN_FAIL_REASONS`**（那个集合还管「终态后补拉 history」，#306）。
> - **assistant 完整消息不单独发事件**：前端拼接 `assistant_delta` 流渲染气泡；run 结束后的持久对话内容以 `GET /api/sessions/:id` 的 `messages` 为准（`run_events` 是流式日志，`messages` 是人看的对话，两层不混，规格 §9.2）。
> - 审批请求的出现通过 `judge` 事件（`action` 指示需审批）+ `GET /api/approvals` 列表体现，不单独设事件类型。
> - **第 14 类 `attempt_killed` 是宿主合成事件**（issue #288 缺陷 B + #292，实现 `portal/src/internal.js` 的 `releaseRun` 与 `reapExpiredRuns`）：「worker 被杀 → 重排」这件事此前对用户**零可见**（requeue 分支只改 `run_queue` + `audit_log`），用户只看到同一个工具卡片亮 3 次、最后拿一句没有原因的 `attempts exhausted`。口径：
>   - **两条产出路径，一个载荷形状**（前端不需要认识「来源」字段）：**① release 上报**——agentd 还活着，在 U12 release 上 additive 带 `killed_by` / `silent_ms`，portal 在 requeue 分支同事务合成（可带 `silent_ms`）；**② reaper 合成**——**上报者自己也死了**（agentd 被杀 / 容器 `docker kill` / OOM / 网络断 ⇒ 一次 release 都不会发生），只有租约（90s）过期后每 15s 一轮的 reaper 把 `claimed` 行收回 `pending`。**路径 ② 才是最常见的真崩溃形状**，#288 只做了 ① ⇒ 这类重排对用户仍然零可见（= issue #292 的缺陷本体）。**reaper 形态的固定字段**：`killed_by:'crash'`（无从区分看门狗与真崩，保守取 crash）、`reason:'lease_expired'`（开放值，**不新造错误码**）、**不带 `silent_ms`**（没有上报就没有那个数；写 0 或自造「距上次心跳的估算」都是伪装）、**不带 `next_retry_in_ms`**（reaper 之后靠即时重领，没有自己定的退避时长）。两条路径共用同一个幂等键 ⇒ 同一 attempt 即使「reaper 先写、迟到的 release 再报」也只会落一条。
>   - **只有 `requeued` 分支写**；`cancelled`（用户主动 stop）与 `failed_max_attempts`（耗尽）都不写——前者不是被杀，后者由 `run_end` 承载终态（避免同一事实两条展示）。两条路径同此口径（reaper 的 cancelling / 耗尽分支也不写）。
>   - **幂等键** `client_event_id = <run_id>:attempt-killed:<attempt>` + `ON CONFLICT (run_id, client_event_id) DO NOTHING`（照 §9.6/#277 合成 `run_end` 的 `<run_id>:final:run_end` 先例；U12 release 是 at-least-once，重试不得写第二条）。第二段用 `attempt-killed` 而非数字，故与 worker 上报的 `<run_id>:<attempt>:<计数>` 命名空间天然不撞（§9.4）。没真插入行（重放）**也不推 SSE**——界面上不会出现两条重试行；代价是重放那一次白烧一个 seq，属 §5.1 实现注记里已裁决的合法空洞（客户端不得拿跳号当重连判据）。
>   - **零事件面**：`killed_by` 缺省或不是 `{watchdog, crash}`（旧 agentd、以及 `fork_failed` / `prepare_cwd_failed` / `run_data_failed` 这类「压根没起 worker」的 release）⇒ **一条 `attempt_killed` 都不写**，且**不 400**（additive 字段不得弄坏旧 agentd）。`reason` 是自由字符串（§9.11，无枚举白名单），新值 `watchdog_silent` 天然可用。
>   - **可回放**：已进 §4.4a 历史回放白名单与前端 `HISTORY_REPLAY_TYPES`（实时 SSE 推、刷新后也必须在）。
> - **第 15 类 `tool_replay_decision_required` 是引擎 additive 事件，本站只是接线**（issue #288 缺陷 C，实现 `runner/worker.js` 传 `replayPolicy: 'per-tool-declaration'`）：
>   - **为什么需要它**：之前 resume 会把「有 `tool_use`、无 `tool_result`」的挂起工具**从头再执行一遍**（真机：同 `call_id` 在 `run_events` 里出现 3 条 `tool_use`）。`shell` 跑的是 `kill` 旧进程 / 重启 backend / 重跑测试这类**非幂等**命令，每轮真的再掀一次桌。现在挂起工具不重放，本事件就是「没重放」这件事对用户的唯一说明。
>   - **它总是与一条 `tool_result` 成对出现**（同一 `tool_call_id`，`ok: false`）：工具卡片会亮成失败 + 多一条中性分隔行。**不新增任何 UI 结构**（前端走既有 `onSep` 分隔行），且**不新增运行态语义**：它不改 run 状态、不进 `RUN_FAIL_REASONS`。
>   - **中性文案**（不是错误行）：引擎不重放不等于失败——模型拿到「没重放」的说明后可以自己决定重跑。所以前端不写 `.syserr`。
>   - **可回放**：已进 §4.4a 历史回放白名单与前端 `HISTORY_REPLAY_TYPES`；与前端实时具名监听 `EVENT_TYPES` 三处必须同时存在（**只加一边就是「实时收不到」或「刷新后消失」**，本分支已用变异证明过）。

> - **第 16 类 `persistence_error` 是「宿主没接线」型缺陷**（issue #371-A，2026-10-24）：引擎一直从
>   `diagnostics.error` 报落盘失败，而本站 `runToolLoop` 参数里**从来没有 `diagnostics`**，只有
>   `onPersistenceError`（只拿得到 `Error` 对象，且只落一条 IPC warn 日志）⇒ 真机 `run_events` 里该类型
>   **0 行**（2026-10-24 `SELECT count(*) … WHERE type='persistence_error'` 实测），非致命降级全隐形：
>   run 绿、有正文、界面上没有任何提示。**别把这条当成「引擎 0.25.0 才有」**——通道与 `fatal:false`
>   在 pin 的 0.23.0 里就存在（`orchestrator.js:873` / `:895`），只是本站没接。
>   回归锁分两个文件：`runner/test/persistence-error-channel.test.js`（① 真引擎跑一遍钉「通道与字段名
>   是真的」② `loopEventPayload` 映射 ③ 源码级「接线还在」哨兵——**① 自己传 diagnostics，所以摘掉本站
>   接线只有 ③ 会红**）与 `portal/test/persistence-error-visibility.test.js`（三处集合同步 + 本文档同源）。
---
> - **第 17 类 `queue_update` 是状态帧，不是历史事件**（issue #370，实现 `portal/src/internal.js` 的 `notifyQueueUpdate` / `notifyQueueUpdateForSession`）：
>   - **为什么不落 `run_events`**：信封要求 `run_id NOT NULL`，而**入队那一刻根本没有 run**（转向打断的那个 run 是另一个）。硬塞要造一个假 run id；把「队列」塞进「历史」也判错了性态——队列是**状态**（此刻还有什么没发出去），历史是**发生过什么**。状态要能重建，于是真相放 `queued_inputs` 表，快照由 §4.3a 尾注的 `session.queued_messages` 全量提供。
>   - **因此它不进 §4.4a 历史白名单，也不进前端 `HISTORY_REPLAY_TYPES`**，只进 `EVENT_TYPES`（实时具名监听）。刷新后队列条不消失靠详情快照补齐，不靠 SSE 回放。三处集合各漏一处的症状不同（#288 已证）：漏 `EVENT_TYPES` = 实时一条都收不到；误进回放 = 无 seq 帧污染水位线。
>   - **载荷恒为全量快照**（不是增量）⇒ 前端**整体覆盖**本地队列，天然消双发、天然多标签页一致。乐观入队只是消除「点了没反应」的空窗，权威值到达即被取代。
>   - **为什么必须带 `delivered_run_id`**（评审抓到的缺陷）：本站前端只有两条路知道「这个会话有活跃 run」——自己 POST 的响应，和会话详情里的 `active_run_id`。**队列投递两条都不走**（portal 自己调 `postMessage`）。不带这个字段就会得到：旧 run 的 `run_end` 到达 ⇒ 运行态清空 ⇒ 新 run 在跑但状态条显示空闲；更糟的是新 run 自己那条 `run_end` 因 `d.run_id !== activeRunId` 被判「不是当前 run」而**整条丢弃**（终稿不刷新、历史不补拉）。前端接管的判据是 `activeRunId == null`——**别把用户正在看的另一个 run 抢掉**（起跑时刻未知 ⇒ 动量 `startedAt=null`，口径与「中途打开会话」逐字一致，不出「从我看到它才起算」的假时长）。
>   - `blocked` 是**机器码**，前端 `queued.blocked.<code>` 出话（#294：服务端只发码不发话）。当前值：`container_not_running`（容器没起来，agentd 不在，没人 claim ⇒ 留在队列并说明原因）、`deliver_failed`（认领后 `postMessage` 失败，已退回 `pending`）、`not_deliverable_at_terminal`（队头是 follow_up 而这次终态不该投——用户按了停止 / run 是 failed）。**一个都不丢弃**。


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
| `POST /api/sessions/:id/stop` | 仍返回 `200`：`cancel_requested_at` 是 DB 标记（规格 §10.3），容器恢复后 runner 轮询到即终止；不因此报错。**#277 补**：`queued`（从未被领起）的停止不等容器——portal 同事务直接收敛 `finished`（`aborted` / `cancelled_before_start`）并出队；`running` 分支的容器死掉对账兜底仍未覆盖（下一片） |
| `POST /api/projects`（写 `ports.json`） | **不依赖容器网络**：portal 直写宿主 bind mount（H-B D-6，issue #7），不受容器在线影响 |
| SSE / GET 类 | 不受影响——事件与状态都在 DB（原理三），容器死了历史照样可看 |

⚠️ 待决策者确认：任务下发单机可先用 push、拉模型（长轮询领 `run_queue`）为终态（规格 §10.3）。本表第一行按**拉模型（终态）**描述——消息落库即 `202`、不依赖容器在线；仅在实现为 push 下发时 `POST .../messages` 才同步依赖容器可达（上表「仅 push 下发」分支）。契约的响应 schema 不变，仅错误出现条件变化。

### 6.4 run 级错误码汇总（`run.error.code` / `run_end.error.code`）

| code | retryable | 含义 | 用户提示口径 |
|---|---|---|---|
| `rate_limited` | 是（人工/延迟后） | LLM 配额耗尽（§6.1） | 配额用尽，勿自动重试 |
| `checkpoint_failed` | 是 | checkpoint 写失败，fail-closed 中止，终态（§6.2） | 存储故障，重发产生新 run |
| `container_exited` | 是 | 容器在 run 进行中退出，且 `attempts >= max_attempts`（耗尽）后由 portal 置终态（否则走租约到期 re-claim，不直接终态，runner §6.4） | 容器异常，平台正在恢复 |
| `max_attempts_exceeded` | 否 | attempts 耗尽（默认 3，schema.sql `run_queue.max_attempts`），U12 release / reaper 置终态（§9.11）。**#288 起**：由 release 合成时，`run_end` 可 additive 带 `last_reason` / `last_silent_ms`（最后一次 kill 的原因）；**#292 起**：由 reaper 合成时同样 additive 带 `last_reason`（固定 `lease_expired`），但**没有 `last_silent_ms`**（上报者已死，那个数不存在）。本码**逐字不变**，前端仍按本码渲染，不必认识这些新键 | 多次尝试失败，请手动重新提交 |
| `spool_full` | 是 | 事件 spool 写满且内存队列也满，worker 主动失败（runner §7.5） | 事件通道拥塞，可重发继续 |
| `cancelled` | 否 | 用户主动停止（此时 `termination.reason` 为 `"aborted"`，`error` 通常为 `null`，本码仅兜底） | — |
| `internal` | 否 | 未分类引擎/宿主错误 | 联系管理员，附 run_id |
| `timeout` | 是 | 上游 LLM 请求超时（erix-agent `KitError`，`src/providers/errors.js:1`） | 上游抖动，可重发 |
| `server` | 是 | 上游 LLM 5xx / 响应体不合法（同上） | 上游故障，可重发 |
| `disconnect` | 是 | 上游流式连接中断（同上） | 网络中断，可重发 |
| `aborted` | 否 | 用户主动停止（`termination.reason='aborted'`；worker 在 signal 已 abort 时固定以此码上报） | — |

> **`retryable` 判据（issue #212，与上游对齐）**：worker 的判据 = 上游错误对象显式 `retryable === true` **或** 错误码属上游可重试码集 <!-- DRIFT:run-retryable-error-code:begin -->`retryable ∈ {timeout, rate_limited, server, disconnect, checkpoint_failed}`<!-- DRIFT:run-retryable-error-code:end -->（= 上游 `erix-agent/src/providers/errors.js:1` `RETRYABLE_CODES` + 已文档化为可重试的 `checkpoint_failed`）。此前 worker 是手写半截清单（只认 `checkpoint_failed` / `rate_limited`），`timeout` / `server` / `disconnect` 会被误判为不可重试。码集单一真相常量在 `portal/frontend/src/lib/terminationReasons.ts`（`RUN_RETRYABLE_ERROR_CODES`），runner 侧运行时镜像在 `runner/lib/termination.js`（`RETRYABLE_ERROR_CODES`，FDE 镜像只 COPY `runner/*`），两者与上表由 `portal/test/termination-contract.test.js` 逐项对齐。

---

## 7. ⚠️ 待决策者确认汇总（本文出现的全部标注）

| # | 事项 | 当前倾向（principles §4） | 影响 |
|---|---|---|---|
| 1 | ~~Q7 portal 技术栈~~ ✅ 已定稿：(a) 零依赖 `node:http` + 原生前端（principles §4；WP1 落地） | — | 仅实现注记，**契约形状无关** |
| 2 | `BASE_DOMAIN`（影响示例 URL 与 cookie 生效 host；**#57 定稿：语义为伞域 `fde.<可注册域>`，现取 `fde.erix.vip`；代码默认兜底 `localhost`（本地起服，不套伞域前缀）**） | env §1 | §0 / §2.5 / fde-platform §8.5 |
| 3 | P1 认证 = 本地账号 + 强制 TOTP（OIDC 延后 P2；**现状**：未注册 TOTP 的账号口令直通，见 §2.1） | env §4 / Q3 倾向 (a) | §2.1 |
| 4 | Q5 端口分级：先只做项目级 | 倾向 (b) 起步 | §4.7（`scope`/`run_id` 字段保留） |
| 5 | 任务下发 push→pull 演进 | **拉模型为终态**；push 仅作 P2 优化后置（⚠️ 待决策者确认，不作默认契约） | §6.3（`container_unreachable` 出现条件） |
| 6 | `run.cost` 记账口径 | 依赖 Q1/Q4 | §4.1（P1 可为 `null`） |
| 7 | 预览 ticket TTL 秒数 | **60s** | §2.8 |
| 8 | 预览 cookie TTL（是否滚动续期） | **15min，滚动** | §2.7 / §2.8 |
| 9 | 开发期 cookie 切换方式 | `COOKIE_PROFILE=prod\|dev-http` | §2.5（已落地 env §10） |
| 10 | argon2id 参数 / 口令长度下限 | `m=19MiB,t=2,p=1` / 长度 ≥ 12 | §2.9.4 |
| 11 | 本地 admin 数量上限 | 1~2（或收紧为 1） | §2.9.1 |
| 12 | #234 跨站写请求防线的两个口径（**已定稿**，工单 `feat-261013-01`，口径修正见同分支返修）：① **只比 authority 不比 scheme**（http/https 混合部署期不得误杀，scheme 只用于默认端口归一化）；② **预览 host 的页面里调 portal API 会被拒**（返修后本条才真的成立：预览 host 与 portal 同注册域 ⇒ SFS 是 `same-site`，而 `same-site` **不直接放行**、落到 Origin 比对后拒；旧实现下它会在判据 b 被放行，第 ② 条名存实亡。口径：预览应用本来就不该调 portal API，#212/#263 下读路径早已断，故不是回归）——第 ② 条是**对外可见的语义变化**，已部署的预览应用如有旧调用需告知 | §1.2 / §2.5 / §2.11 |

---

## 8. 前端 mock 指引（验收锚点）

前端只依据本文开发时：

1. 所有响应按本文 schema 生成 mock；错误分支按 §1.2 / §6 的 `code` 表逐一覆盖（至少：`unauthorized` / `not_found` / `run_in_progress` / `rate_limited` / `container_unreachable` / `checkpoint_failed` 经 run 详情）。
2. SSE mock：按 §5.3 清单逐类型发事件，`id` 递增；模拟断线后带 `Last-Event-ID` 重连，验证补发不漏（P2 验收的前端半边）。
3. `messages.synthetic: true` 的消息必须有独立视觉标记（规格 §9.2 红线）。
4. 预览 URL 一律取 `PortAllocation.url` 字段，禁止拼接域名（规格 §8.1 同源原则）。
5. **能力位字段的 mock 基线（#472 片 A）**：mock `GET /api/me` 与两个登录端点的 `user` 时，**四处形状必须一致**（同一个构造点，见 §2.6 的「四条 user DTO 路径键集一致」）；`file_upload_enabled` 要能造出**三种**响应：`true` / `false` / **缺键**（三态 UI 与片 B 的按钮显隐判据都靠这三格，只 mock 两态就验不到「未知」那一格）。

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
| S1 | `GET /api/internal/transcript/:key` | store：`load`（session 维度，§9.8b，issue #81 P2） | 只读 |
| S2 | `PUT /api/internal/transcript/:key/rounds/:round` | store：`appendRound`（§9.8b） | `(transcript_key, dedup_key)` 部分唯一索引 |
| S3 | `PUT /api/internal/transcript/:key/checkpoint` | store：`saveCheckpoint` / `appendCheckpoint`（§9.8b） | 单行覆盖写 + revision CAS |
| S4 | `GET /api/internal/transcript/:key/checkpoint/latest` | store：`loadLatestCheckpoint`（§9.8b） | 只读；无 → 204 |
| S5 | `PUT /api/internal/transcript/:key/runstate` | store：`saveRunState` / markRunState 终态标记（§9.8b） | `chat_sessions.engine_run_state` jsonb 合并写 |
| S6 | `GET /api/internal/transcript/:key/runstate` | store：`loadRunState`（§9.8b） | 只读；无 → 204 |
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
| `run.history` | **已删除（P3 PR③，issue #69 下行退役）**：claim ticket 不再下发历史文本，worker 也永不传引擎 `initialMessages`——会话上下文唯一来源 = transcript（§9.8）；`run.task` 保留（空本子由引擎 round 0 种子入档，亦是 notes/标题的输入） |

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
| `events[].type` | string | 事件类型，清单同 §5.3（portal 原样透传落 `run_events`）；未知类型（上游 additive）原样透传、不报错。**两个例外**：① **stream 档碎片不落库**（`assistant_delta` / `reasoning_delta` / `tool_call_delta`，按引擎导出的 `EVENT_TIERS` / `eventTierOf` 判定而不是抄名单，见 §9.4a）；② **portal 自造的类型容器不许上报**：`run_end` / `partial_output` / `attempt_killed` 是 portal 在终态事务里自己合成的名字，容器发来就是「宿主写出来的事实被容器冒充了一遍」⇒ `400 validation_failed`（`details.field='events[i].type'`，`PORTAL_RESERVED_EVENT_TYPES`）。引擎**将来**新增的 additive 类型不在这一小撮里，照旧透传 |
| `events[].ts` | string（ISO 8601 UTC） | **宿主落库时间**（与 §5.3 信封、schema `DEFAULT now()` 同口径；worker 上报的产生时刻仅作展示参考，不参与 seq 排序/对账，env §11.3） |
| `events[].payload` | **object（必为 JSON 对象）** | 类型特有字段（对应 §5.3 信封内层）。portal 不校验内部字段语义，但要求 `payload` 为对象——非对象 → `400 validation_failed`。**payload union**：已知类型按 §5.3 字段形状填充，未知类型原样透传 |

**`client_event_id` 重启/重领不碰撞（attempt 前缀）**：`client_event_id` 中的 `attempt` 来自 claim ticket（`run_queue.attempts`）；re-claim 后 `attempt++`，新 worker 的 `计数` 归零也不会与旧 attempt 的 `run_id:attempt:计数` 碰撞——否则旧 attempt 的 `:0`/`:1` 会被新 attempt 当重复丢弃（runner §7.3）。**worker 在未发生 re-claim 的同 attempt 内重启**（如进程被 agentd 重拉但 claim 未变）必须沿用原 `attempt` 并继续计数，否则会产生撞键。

批量参数（runner §7.2）：**250ms 或 2KB 先到者触发** ⚠️；单批上限 200 条 / 256KB，超出切多批顺序发送；单 run 内严格按 `client_event_id` 递增，批量不重排。

响应 `200`：

```json
{ "stored": 98, "seq_first": 1001, "seq_last": 1098, "stream_forwarded": 41 }
```

| 字段 | 说明 |
|---|---|
| `stored` | **实际插入**条数（= 真落库行数）。批次中已存在（重复）的 `client_event_id` 被跳过、不计入——**部分重复时响应仍为 `200`，`stored` 小于请求条数属正常，不是错误**；agentd 收到 `200` 即确认整批、从缓冲删除。⚠ **#502 起 `stored < 条数` 有两种原因，不能只读成幂等命中**：① 真的重复投递（durable 档被 `ON CONFLICT DO NOTHING` 跳过）；② **本批里有 stream 档碎片**——它们**成功转发也不计入 `stored`**（根本不 INSERT），一个全是碎片的批可以 `stored: 0` 且完全正常。⇒ 单看 `stored` 分不出这两种，**要分开就读下面那个 additive 计数** |
| `seq_first` / `seq_last` | 本批**新插入**事件分配到的 seq 区间（`seq_first ≤ seq_last`）。**当 `stored == 0`（空批次 / 全重复批次 / 整批都是 stream 档）时两者均为 `null`**——这是「没有新事件落库」的明确信号，agentd 不应据此推进任何游标（本来也没有新 seq）。seq 由 portal 在**同一事务**内 `chat_sessions.last_seq` 逐条 +1 分配（`UNIQUE(session_id, seq)` 兜底）；**seq 只在 portal 产生，worker/agentd 永不自造**；**跳号合法**（§5.1 注记） |
| `stream_forwarded` | **#502 起 additive**：本批**真的被转发到浏览器**的 stream 档条数（没转发就不计：重复投递的碎片会被累加器的「首次观测才转发」挡掉 ⇒ 重投那一整批它是 `0`）。它是碎片不落库之后**唯一**剩下的碎片级去重信号（§9.4a）。**runner 今天不读它**（`runner/agentd.js:725` 那条 debug 日志只报 `stored` 与 `count`），旧 agentd 不读它也照旧工作 ⇒ **协议形状零改动**；写它只为把「为什么 `stored` 比条数小」在排障时能直接看出来 |

幂等与重试（runner §7.3）：**at-least-once**——agentd 只有收到 `200` 才确认删除；任何失败重试**整批**，重复批次安全。

#### 9.4a 写入侧的档位与事务边界（issue #502 形态 M）

**判定用引擎导出的档位，不在本站抄名单**：`erix-agent` 导出 `EVENT_TIERS` / `eventTierOf`，
portal 只问「这条事件是不是 stream 档」。现查（本机已安装引擎）：stream 档含 `assistant_delta`、
`reasoning_delta`、`tool_call_delta`、`delta`、`tool_call`；事实档含 `round_start`、`round_end`、
`tool_use`、`tool_result`。抄名单的坑是引擎 additive 加一类碎片时本站会**静默漏网**（又开始落库）。

- **stream 档**：**不 INSERT、不 `allocSeq`**（一个 seq 都不烧），只 ① 喂进程内累加器 ② 转发浏览器 SSE
  （帧**不带 `id:`**）。⇒ 判据「体积掉下来」的来源就在这里，不在任何索引上。
- **重复投递的转发去重（审计 M-6①）**：碎片不落库 ⇒ `ON CONFLICT` 那条 durable 幂等闸对它不存在，
  而 U3 是 at-least-once ⇒ 整批重投时若照旧「每条都推一次 SSE」，界面会把同一段正文**加两遍**。
  现在由累加器**首次观测才转发**：`bufferTx.observe(...)` 返回 `true` 才计入 `stored`/推 SSE，
  返回 `false`（重复）就整条跳过，`stream_forwarded` 因此是 0。这是**唯一**剩下的碎片级去重信号
  （`client_event_id` 计数器），所以累加器的 `counters` 必须有上界（`PARTIAL_MAX_COUNTERS_DEFAULT = 8`，
  按 attempt 保留、丢最老）。
- **缓冲变更只在 COMMIT 之后生效（审计 M-6②）**：写循环里对累加器的所有变更走 `stage()` 出来的事务视图，
  `COMMIT` 成功后才 `commit()`；回滚 ⇒ 直接丢弃。否则会出现「内存里有正文、库里那一轮根本没落」这种
  **只有内存知道**的假事实（它会经补发帧被当成已定稿正文渲染出去）。终态侧同理：
  `retirePartialBuffer` 只在真的写了 `run_end` 且 COMMIT 之后调（没写成就什么都别收，重试腿再来一次）。
- **`round_start` 是累加器的轮次边界**：它属于事实档、照常落库并占 `seq`；portal 顺手把它的 `seq`
  记进累加器当作**本轮的身份**（`roundSeq`）。**这就是 §5.1 那条「两端对同一个事实」的另一半**——
  前端在 `case 'round_start'` 里记同一个数，快照帧带同一个数，两边一比对才知道该不该覆盖气泡。

**派生写入：同一事务里的 `tool_calls`（issue #283）**

| 事件 | 写法 | 口径 |
|---|---|---|
| `tool_use` | `INSERT INTO tool_calls (run_id, call_id, round, name, input) … ON CONFLICT (run_id, call_id) DO NOTHING` | 行的唯一来源（round/name/input 只能从 tool_use 取） |
| `tool_result` | `UPDATE tool_calls SET duration_ms = $3, result_digest = $4 WHERE run_id = $1 AND call_id = $2 AND duration_ms IS NULL AND result_digest IS NULL` | 回填耗时与结果摘要（两列在 baseline schema 里早已存在 ⇒ **零 DDL**；此前 portal 从来没有这条 UPDATE，导致事件 payload 里有值、表里 741 行全 NULL） |

- **顺序是硬前置**：`tool_use` 循环必须跑在 `tool_result` 循环**之前**——两者可能同批（且批内 `tool_result` 可以排在 `tool_use` 前面）、也可能跨批，而 `tool_result` 只 UPDATE 不 INSERT，行不存在就一枪打空（防漂移用例：同批里把 `tool_result` 放前面仍须写入）。
- **UPDATE-only，不 INSERT**：`tool_calls` 行缺失（只见到 `tool_result`、没见到对应 `tool_use`）⇒ **更新 0 行、静默不补记**，不为此引入 INSERT（`round`/`name`/`input` 在 `tool_result` 里没有可靠来源）。同理 `payload.tool_call_id` 缺失的 `tool_result` 直接跳过（不猜键）。
- **幂等且不擦写**：守卫 `AND duration_ms IS NULL AND result_digest IS NULL` ⇒ 整批重发（at-least-once）与「后到的同 `call_id` 空值事件」都不会把已写的值改回 NULL（语义 = 首次观测即真相、先到先得）。两列用同一条 UPDATE 同一口径，不拆成两个逐列守卫：一次工具调用只有一个 `tool_result` 事件（两列同源同时到），拆列只翻倍查询。
- **取值口径**：`duration_ms` 非有限数（含 `null`）⇒ 写 `NULL`，**不写 0**（引擎未给时长与引擎测出 0ms 是两件事，后者照写 `0`）；`result_digest` 与事件 payload **逐字一致**（portal 不截不断不重排版；worker 侧已按 500 字截断，见 §5.3 第 7 行）。
- **旧数据不可回填**：历史 `run_events` 里本来就没带 duration（erix-agent 0.18.0 的缺口，上游 erix-agent #285 跟修），因此已存行仍是 NULL，**不跑数据修补、也不拿 `created_at` 之类造一个假时长**。
- 防漂移：`portal/test/internal.test.js` 的 `issue #283 U3：*` 用例集（同批写入 / 顺序陷阱 / 跨批 / 重复投递 / 空值不擦写 / 行缺失 0 行 / 逐字一致 / NULL 与无键跳过）。`portal/test/fake-internal-pool.js` 的 `tool_calls` 分支**从 SQL 文本里解析 `IS NULL` 谓词**并模拟 `UNIQUE(run_id, call_id)`（AGENTS §8.14：fake 必须模拟真库约束）；变异取证：删掉守卫 ⇒「后到的同 call_id 空值事件不得把已有值擦成 NULL」必须红。

错误：`400 validation_failed`（条数/字节超限、`payload` 非对象、`client_event_id` 格式非法）；`401 token_invalid / token_revoked`；`403 run_ownership_mismatch`；`404 run_not_found`；`409 lease_lost`；`409 run_terminal`（终态 run 不再接受事件——终态 barrier，runner §7.6）；`429 rate_limited`；5xx 无限退避重试（§9.13）。

### 9.5 `POST /api/internal/heartbeat`（U4：心跳 + 租约续期）

请求（间隔 **15s** ⚠️）：

```json
{
  "agent_version": "0.26.0",
  "runner_version": "0.1.41",
  "build_revision": "8e28cc1c2b0e4b0e1a2f3c4d5e6f7a8b9c0d1e2f",
  "runs": [
    { "run_id": "9d3b2f1e-...", "status": "running", "worker_pid": 1234, "claim_token": "ct_3f8a..." }
  ]
}
```

> **版本是构建产物，不是运维旋钮**（issue #404 结案）。三个版本字段一律来自 FDE 镜像构建期烘进去的
> `/opt/erix/build-info.json`（`runner/Dockerfile` 写、`runner/lib/build-info.js` 读）；读不到就报
> `unknown`，**不再有 `'0.1.0'` 这类兜底常量**——一个看起来合法的假值比空值更难发现。
> `ERIX_AGENT_VERSION` 只剩 override 身份（默认不设，portal 仅在显式钉值时注入）。

| 字段 | 说明 |
|---|---|
| `agent_version` | **erix-agent（引擎）版本**，构建产物；portal 会落账到 `containers.agent_version`（仅当与现值不同，见下）。空/缺 ⇒ 不写，**不会拿 `unknown` 去覆盖上一次的真值**（兼容旧 agentd） |
| `runner_version` | station runner 自身版本（`additive`，旧 portal 忽略） |
| `build_revision` | 构建所用 git commit（`additive`；本地/dev 构建为 `unknown`） |
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
| `models` | 下行 LLM 数据面配置（#117）：`{ main: {model, type}, embedding?, vision? }`，值为 LiteLLM 的 `model_name`（**不是** DB 槽位里的 `model_info.id`）；无 active LiteLLM binding → `null`。模型名的漂移对账见下「模型名对账（#289）」。#309 的下行形状：`{ main: { model, type, context_window?, max_output_tokens? }, embedding?, vision? }` —— `main` 可额外带 `context_window` 与 `max_output_tokens`（与门户模型列表**同一个 `toModel()` 生效值**，且**按对账后的新名**取同一个 deployment；回退口径与别名对照表见 §4.9），**只在非 null 时带键**（没值就整个键不出现，不是 `key: null`）。⚠ **#316：两个键的值是**归一后的正整数**（门户侧与 runner 同一条 `positiveIntOrNull()` 判据）：存成数字串的窗口（`"262144"`）会**以 number** 下行；真小数（`262144.5`）/ `≤0` / 非数字算「不可得」⇒ 那个键**不出现**（而不是把一个 runner 一定会丢掉的值发下去）。⚠ **切片 1.5 的行为变化（有意）**：`max_output_tokens` 现在是**生效值**（没手填过则是 `floor(context_window/4)`，§4.9 的四级回退链、同一份算法）⇒ **配了 `context_window` 但从未手填过预算的存量部署现在开始带这两个键**（不再与 #309 之前逐字节相同）——这正是本切片的卖点：缺元数据不再等于关压缩。「两键都不出现」现在只剩**连 `context_window` 都没配**（以及拿不到目录）那几种；而**不注入 gateway 的老调用形状仍逐字节不变**（兼容面，测试钉着）。名字就 `max_output_tokens` 一个拼写（与门户 DTO 同名同值，别名对照表见 §4.9）。embedding/vision 不带元数据。元数据**复用对账那一次 `GET /model/info`**（不新增网关调用），网关抖动/未注入 client 时退回无元数据且不抛错；runner 接线是 #309 切片 2 |

语义（与 runner §4.2 U4 一致）：

- **续租**：portal 对每个 run 校验 `claim_token` 匹配当前有效租约 → 续租（`lease_until = now + 90s` ⚠️）；不匹配 → `lease: lease_lost`。
- **`lease_lost` vs `revoked`**：`lease_lost` 是 **run 级**（单个 run 的租约被取代）→ agentd **本地 abort 该 run 的 worker、丢弃其缓冲与 spool**，不再续传该 run 的任何写；`revoked` 是 **容器级**（token 吊销 / offboard）→ agentd 停领新任务、drain（abort 全部在跑 run → 等 worker 退出 → 清理 worktree）后退出。`revoked` **不在 `200` 内表达**：吊销由鉴权阶段 `401 token_revoked` 给出（SSE revoke / claim 401 / heartbeat 401 三径同源，issue #22）；`401/5xx` 对非吊销原因才是整次心跳失败（指数退避重试）。
- **停止兑底**：`stop_run_ids` 是 portal 侧 `cancel_requested_at` 已置位但 SSE `stop_request` 可能未达的 run 的兑底通道（SSE 为主、心跳为备）。

幂等：天然幂等（覆盖写 `last_heartbeat`、续 lease）。portal 侧判定：**连续 3 次心跳丢失（45s ⚠️）判容器死**；run 级处置走租约到期 re-claim（runner §6.4）。

错误：`400 validation_failed`（`runs[].claim_token` 缺失/格式非法）；`401 token_invalid / token_revoked`；`429 rate_limited`；5xx 无限退避重试（§9.13）。

#### 模型名对账（#289）

LiteLLM 侧带外改名（管理员在网关 UI 改 `model_name`）后，`fde_llm_bindings.*_model_name` 与 per-FDE virtual key 的 `models` 白名单**两处快照同时过期** ⇒ 数据面按名字拒请求，用户看到的却是 auth 类 403。心跳路径上 portal 会自愈这个漂移。

- **触发点**：**只有 U4 心跳**（`internal.heartbeat` → `getFdeLlmHeartbeatModels(pool, user.id, { gateway: ctx.llmGateway })`）。**不是定时任务**——没有独立循环、没有 portal 启动扫描；FDE 不在跑（无心跳）就完全不产生写。
- **判据**：`model_info.id → model_name`。id 是稳定身份（Station 槽位存的就是它），名字是可改的别名 ⇒ 拿 id 反查到的名字与库里不同即漂移。
- **动作顺序（固定，反序会造出持续 403）**：
  1. 先 `POST /key/update` 把该 FDE virtual key 的 `models` 白名单扩成**新旧名并存**（旧名不摘：摘掉对修 403 无必要，且会打断仍带旧名在飞的流量）；
  2. 后 `UPDATE fde_llm_bindings SET <命中列>, updated_at = now() WHERE fde_id=$1 AND state='active'`（只 SET 漂移列，多槽位漂移合成一条 UPDATE）。

  反序（先回写 DB、后扩白名单）会留下「DB 已是新名 / key 仍只认旧名」的窗口——下行新名立刻被 key 白名单拒，且这个分叉**不会被下一次心跳自愈**（下一次心跳比对时两边已一致）。
- **三种保守放行（全部只 `console.warn`、不抛错，心跳照常返回 `200`，下行继续用旧名）**。运维按 `reason` 字面量 grep（前缀 `[llm] binding model name reconcile`）：

  | 情形 | 日志行 | `reason` 字面量 |
  |---|---|---|
  | 网关不可达 / `GET /model/info` 抖动 | `... reconcile skipped` | `model_list_unavailable` |
  | `model_info.id` 不在网关返回的映射里（模型已删/换 id） | `... reconcile skipped` | `unknown_model_id` |
  | `/key/update` 失败 | `... reconcile failed` | **无 `reason` 字段**（只有 `slots` / `error_status`） |
  | 白名单已扩但回写 `fde_llm_bindings` 抛错 | `... reconcile failed` | `binding_update_failed` |

  第四行是安全态而非半残态：key 已接受新旧两名 ⇒ 下行旧名照样可服务，绝不下行新名（否则出现「DB 旧名 / 下行新名」分叉）。
- **已接受代价**：
  - 带外改名到「下一次心跳 + 映射 TTL」之间仍发旧名，最坏 ≈ 心跳间隔 15s + `model_list` 缓存 60s ⇒ 这段时间的 403 不消除，只是**不再无限持续**；
  - `unknown_model_id` 在心跳路径**只 warn 不失败**——这条路径上抛错只会砸到 agentd，砸不到用户；用户可见的 fail-fast 在切片 B2（消息发送前预检）。
- **TTL 缓存按 client 对象身份分槽**（`llm.js` 模块内单槽缓存，`ttlMs` 缺省 60s）⇒ 接线**必须**传 serve 启动时的 `ctx.llmGateway` 单例；在心跳路径里 `createLlmGatewayClient(...)` 现造 client 会让身份比较恒不相等 ⇒ **每次心跳多打一次 `GET /model/info`**。此约束由 `portal/test/llm-reconcile.test.js` 的端到端用例钉住（两跳心跳断言 `listModels` 只被调一次）。
- **本切片不新增错误码**：`llm_model_not_found` 属切片 B2，尚未登记在 §错误码表，别按它 grep。

### 9.6 `PUT /api/internal/runs/:id/state`（U2：run 状态收敛）

同一端点覆盖 store `markRunState`（非终态）与 run 终态收敛（runner §4.2 / §9.1）。**所有转换都要求 `X-Claim-Token` 匹配当前有效租约**（不匹配 → `409 lease_lost`；**唯一例外**：`cancelling` 期间的 `{state:"running"}` 幂等 ack 不校验租约，见下「停止期间的 `running` 写入」）；转换用**条件更新（CAS）**实现——`UPDATE runs SET ... WHERE id=$1 AND status = <期望当前状态>`，0 行受影响即按非法转换处理。

**合法状态转换表（U2 可执行的转换）**：

| 当前 `runs.status` | 目标状态 | 载荷要求 | 结果 |
|---|---|---|---|
| `queued` | `running` | `{state: "running"}` | `200`（写 `started_at`，若尚未写） |
| `queued` | `finished` / `failed` | 终态载荷（见下） | `200`（终态事务）——**#277 新增边**：认领后来得及写 `running` 就结束的 worker 路径；同一条边也是 portal `stopSession` 的「未开始就被取消」转换（那条**不经 U2**、不要求租约，见 §4.5） |
| `running` | `running` | `{state: "running"}` | `200`（幂等重放，无变化） |
| `running` | `finished` | 终态载荷（见下） | `200`（终态事务） |
| `running` | `failed` | 终态载荷（见下） | `200`（终态事务） |
| `cancelling` | `running` | `{state: "running"}` | `200` **幂等 ack**（**不改 `runs.status`**、不校验租约，见下） |
| `cancelling` | `finished` | 终态载荷（`termination.reason` 通常为 `aborted`） | `200`（终态事务） |
| `cancelling` | `failed` | 终态载荷 | `200`（终态事务） |

**`cancelling` 的口径（#277 收紧）**：「**已执行过（被 worker 领起过）、正在等 worker 报终态**」。从未执行的 run（`queued`）被停止**不进 `cancelling`**，而是由 portal 直接收敛终态（§4.5）——因为 `cancelling` 的三个属性（不可被认领、终态只能由 worker 写、不在 reaper 候选集）对没有 worker 的 run 全是死路。

**非法转换 → `409 invalid_transition`**（details 附 `{from, to}`）：`running/queued → queued`（回退）；`queued → cancelling`（未开始不得进「等 worker 报终态」态，#277）；`cancelling → running`（停止后不得回 running；**例外：该情形返回幂等 ack，不归 `invalid_transition`，见下**）。**终态 run 的任何写（非终态/终态）统一走 `409 run_terminal`，不归 `invalid_transition`**（见下「重复终态」）。

**停止期间的 `running` 写入（issue #220）**：用户 `POST /sessions/:id/stop` 先把 `runs.status` 置 `cancelling`，而停止信号抵达 worker 有延迟；引擎那次**正常**的 `markRunState('running')` 落盘不得被拒（否则会被引擎渲染成 `reason=persistence_failed` 的落盘失败，掩盖真正的取消）。口径：

- `cancelling` + `{state:"running"}` → `200 {"state": "cancelling", "idempotent": true}`（**不伪造成 `running`**）；
- **`runs.status` 保持 `cancelling`**（§9.6/A2：停止后不回 running；`started_at` 不再前移），`run_queue` 行零改动、不合成 `run_events`——该分支**不改任何仓库状态**；
- **不校验 `X-Claim-Token`**：本分支**零写入**，没有需要 fence 的写（旧 agentd 重放只会得到同一个 ack）；反而若断言租约，就把一个无副作用的 ack 绑上了与它无关的租约竞态——停止/收敛路径会在**任意时刻**清空 `run_queue.claim_token`（#220 取证：停止后 0ms 租约仍在，终态收敛之后才为 NULL），写入稍晚一步就只是把 `409 invalid_transition` 换成 `409 lease_lost`；
- 终态之后的 `{state:"running"}` 写入语义**不变**（仍 `409 run_terminal`）；`queued` + `{state:"running"}` 仍走 CAS（租约失效 → `409 lease_lost`）。

**非终态（markRunState）**——请求：

```json
{ "state": "running" }
```

响应 `200`。幂等：重复 `{state:"running"}` 在 `queued`/`running` 下均为 `200`（覆盖写/无变化）；`cancelling` 下的 `{state:"running"}` 见上「停止期间的 `running` 写入」（`200` ack，状态不回退）。

**终态收敛**——请求：

```json
{
  "state": "finished",
  "termination": { "reason": "end_turn" },
  "usage": { "input_tokens": 15230, "output_tokens": 2104 },
  "rounds": 3,
  "final_text": "已完成：登录按钮已改为品牌色……",
  "error": null
}
```

| 字段 | 说明 |
|---|---|
| `state` | `finished` \| `failed`（终态值） |
| `termination` | 引擎 `runToolLoop` 返回值透传，对象 `{reason, detail?}`，`reason` 取值集合见 §4.1 |
| `usage` | 整 run 用量汇总；portal 同事务写 `runs.usage` + `usage_ledger`（`source='erix'`，一 run 一条，`UNIQUE(run_id, source)`）——见 §9.9 |
| `rounds` / `final_text` | 轮数与 assistant 最终文本；portal 同事务回写 `messages` assistant 行 |
| `error` | 失败时 `{code, message, retryable}`（run 级错误码见 §6.4）；成功为 `null` |
| `title`（**#322 起摄入退役**） | 旧容器（v0.1.18 及以前）随终态仍会带一个真标题 ⇒ U2 **照旧接受不报错**（非字符串仍 400 `validation_failed`，那是 #88 以来的既有契约，不是新增码），但**值不再进任何生成链**：不截断入库、不当降级链第一级、不参与终态幂等比对。v0.1.19 起的 worker **恒发空串**。标题改由 portal 在 run 终态后自己生成（§4.5a）。 |

响应 `200`（portal 终态事务：runs 置终态 + `run_queue → done/cancelled` + messages 回写 + usage_ledger，runner §6.1）。

**重复终态语义（同载荷 vs 不同载荷）**：portal 以 `(termination, usage, rounds, final_text, error)` 的**规范化 JSON 哈希**判定是否同载荷。

| 情形 | 响应 | 语义 |
|---|---|---|
| 首次终态（`running`/`cancelling` → 终态） | `200` | 落库、不可再变 |
| 重复提交，**同载荷** | `200`（返回首次存储结果，可带 `"idempotent": true`） | 幂等命中，无变化 |
| 重复提交，**不同载荷** | `409 run_terminal`（details 附首次存储结果） | 终态不可变，新载荷**被拒、不落库** |
| 非终态写（`{state:"running"}`）落在终态 run | `409 run_terminal` | 终态不可回退 |

> **顺序约束（runner §7.4/§7.6）**：终态收敛**必须在该 run 全部事件批被 `200` 确认后才发送**；portal 在终态事务内**合成** `run_end` 事件（worker 不再经 U3 发 `run_end`，runner §7.6），payload 带 `attempt`。终态 barrier：此后 U3/U5/U8/U10 及 state 写一律 `409 run_terminal`（读端点 U6/U7/U9/U11 不受限；runner-integration §7.6 同口径）。

错误：`400 validation_failed`（终态载荷缺 `termination`/`usage`/`rounds` 等）；`401 token_invalid / token_revoked`；`403 run_ownership_mismatch`；`404 run_not_found`；`409 lease_lost`；`409 invalid_transition`（非法状态转换；`cancelling → running` 除外，见上）；`409 run_terminal`（终态 run 的写/不同载荷重复终态）；`429 rate_limited`；5xx 无限退避重试（§9.13）。

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

**幂等与冲突（payload 指纹）**：portal 落库用 `UNIQUE` 约束 + `dedupKey` 双保险；撞键时 portal 比较**入参与已存 `record` 的稳定指纹**（`sha256:<24 hex>`）：

指纹口径（#333，与 erix-agent `src/store/transcript-dedup.js` 逐字对齐）：**只剔顶层**四个易变/身份键
`dedupKey` / `roundKey` / `round` / `ts`，其余字段（**含嵌套层的 `ts`** 与宿主自有未知字段）都算 payload；
顶层键顺序不影响指纹，数组顺序影响。本站实现 `portal/src/transcript-payload.js` 与上游真件按文件路径
**逐字对拍**（`portal/test/transcript-payload.test.js`）——上游改算法即红，不是口头承诺。

| 情形 | 响应 |
|---|---|
| 新 round（无冲突） | `200 {inserted: true}` |
| 同 key + **同 payload**（只漂顶层 `ts`/`round`） | `200 {inserted: false}`（幂等命中；既有行**一字不覆盖**） |
| 同 key + **不同 payload** | `409 round_conflict`（`details` = `existingFingerprint` / `incomingFingerprint` / `differingFields`，最多 8 项；新 body 被拒，既有行不变） |
| 同 round + **不同 `dedupKey`**（仅 U5 run 作用域） | `409 round_conflict`（该 round 已存在，无论 body 是否相同） |

⚠ **剔除顶层 `ts`/`round` 是 0.22 的硬需求**（#333）：引擎新增的控制行/事实行每次写都带 `ts: new Date()`
（`…:engine:round:<n>:control:<slot>` / `:fold:<fp>` / `:ttl:<fp>`），session 作用域下 `round` 也会漂（宿主取
`MAX(round)+1`）⇒ 旧判据把顶层墙钟也算进哈希 ⇒ resume 重放**伪报 409** ⇒ 引擎按持久化失败处理（终局
`persistence_failed`）。真冲突（换正文 / 数组换序）仍 `409 round_conflict`，**零新错误码**。

引擎补充行（0.22 新增，同一对写入口）：`…:control:judge-nudge` / `:extend` / `:guard-revise` /
`:forced-final`（治理注入）与 `:fold:<fp>` / `:ttl:<fp>`（事实行，`messages` 为空）。它们与轮记录同表同规则；
**对话正文不展示控制文本**（`meta.source === 'judge-control'`，见 §4.4a 注）。

fold 语义（runner §9.3）：`folded` 行与原始行共享同一键空间——fold 后原轮走 `UPDATE`（`folded=true` + `folded_payload`），**不插新行**，档案完整不删。fold 更新同样按上述冲突规则（同 payload → 幂等，不同 payload → `409 round_conflict`）。

#### `GET /api/internal/runs/:id/transcript`（U6：load）

query（均可选）：`?limit=<1..10000，默认 10000 ⚠️>`、`?cursor=<round>`（返回 `round > cursor` 的记录）。

> **游标口径（#338）**：本端点（run 作用域 legacy）的游标仍是**单个 round 号**，**故意不改**——它的行空间由
> `UNIQUE (run_id, round)` 约束（迁移 0006 保留至今）⇒ 一轮恒一行 ⇒ 「页边界切在一轮肚子里」在结构上不存在；
> 且 0.23+ 引擎只走 session 端点（§9.8b），本端点仅**版本错配**可达。session 端点的游标已换成
> `(round, append_seq)` 真 keyset（见 §9.8b S1）。

响应 `200`：

```json
{ "records": [ { "round": 0, "dedupKey": "...", "folded": false, "messages": [ ... ], "foldedPayload": null, "...": "record 列全量原样" } ], "next_cursor": 99 }
```

| 字段 | 说明 |
|---|---|
| `records` | 按 `round` **升序**，`record` 列原样返回（每项含 `round`） |
| `next_cursor` | 本页最后一条的 `round`；无更多记录时为 `null` |

**分页/大小约束**：`limit` 限定单响应**行数**（默认 10000 ⚠️）；上游 `load(runId)` 语义 = 不带 query 拉全量（行数超出 `limit` 时由 adapter 用 `cursor` 循环拉取，`next_cursor` 为 `null` 即到底）。

> ⚠ **读侧没有体积闸（2026-10-22 更正）**：本节旧文写着「portal 对单响应序列化体设 8MB 上限，单条 record 超限 → `400 response_too_large`」——
> `grep -rn response_too_large portal/src` **零命中**，该错误码与那道闸**不存在**（体积闸只在**写**侧：
> `INTERNAL_ROUND_LIMIT = 1.5MB`，`portal/src/http.js` 的 `PUT …/rounds/:round`；超限是 `413 payload_too_large`）。
> 读侧的实际上限是**行数** `limit`（≤10000），单条 record 再大也照发（`record` 列写入时已被 1.5MB 卡住）。

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

> ⚠ **时间边界（自迁移 `0034`，PR #509）：上面那句「终态 run 仍可读」现在只剩「不报错」这一半**——
> `0034` 的谓词 (a) 专清「run 作用域（`transcript_key IS NULL`）且那个 run 已终态」的快照行，所以**终态 run
> 的 run-keyed 快照读不到**：本端点对它们返 `204`（**是空，不是错**）。⇒ 调用方必须只对**未完成的 run**读它
> （它的唯一用途是接力一个没跑完的 run，上游契约钉成 latest-only + optional），**不得**拿它当终态 run 的审计面；
> 口径与取证见 `docs/data/model.md` §1.11。现役 runner 走的是下面 §9.8b 的 **session 作用域**端点（谓词 (b) 只清
> 已归档 / 14 天没动的会话 ⇒ 活跃会话每 key 那一行照留），**现役通路零变化**；受影响的只是旧 runner 的 U8/U9 兼容面。

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

### 9.8b session transcript（S1–S6，issue #81 P2）

> **实现状态（2026-09）**：已随 `portal/src/internal.js` + `portal/src/http.js` 实现，迁移 `0006-session-transcript.sql`。
> 依据 `docs/design/conversation-state.md` §4.1：transcript key 从 runId 切到 **sessionId**（= `:key`），
> 照抄 erix-agent CLI「预写入 + resume」模式（引擎零改动）。`runId` 退回纯运维身份。

**与 run 作用域端点（U5–U9/runstate）并存**：U 系列端点不动，旧 runner 继续可用（向后兼容）；
S 系列端点是 P2 起 runner 的默认路径。存储 = 既有表加列 + 部分唯一索引（评估记录见迁移文件头注释）：
`transcript_rounds.transcript_key/dedup_key`（生成列，`record->>'dedupKey'`）、
`run_checkpoints.transcript_key`、`chat_sessions.engine_run_state`。

**鉴权三层**（对齐 §9.1 per-container token）：① `Authorization: Bearer`；② session 属主校验
（`:key` = `chat_sessions.id`，须属于该容器用户，否则 404 `session_not_found` / 403
`session_ownership_mismatch`）；③ **writer run fencing**：所有 S 端点必带 `?run_id=<writer runId>`
query 参数 + `X-Claim-Token` 头——writer run 必须属于该 session（否则 400 `transcript_key_mismatch`）
且持当前有效租约（否则 409 `lease_lost`）。终态后 queue 释放 claim_token → 一切写自动
409 `lease_lost`（S 端点不提供终态后读；读写都发生在活跃租约窗口内）。

**行语义（与 U5 的关键差异）**：CLI 模式下宿主预写行与上一轮引擎记录**同行号**（round = latestRound），
故 S2 的行唯一性判据是 `(transcript_key, dedup_key)` 而非 `(key, round)`；`dedup_key` 幂等——
崩溃重跑同 dedupKey 重放返回 `{inserted:false}`（**绝不产生重复 user 消息**），同 dedupKey 不同 body
409 `round_conflict`（fold 更新 false→true 视为合法 UPDATE，同 U5 口径）。S1 行序
`round ASC, append_seq ASC`（迁移 0016 的持久化追加序：同 round 多行按入档**追加**序；`created_at` 会有
完全相同的行、不能确定性还原——与下面「S1 分页」同一条口径）。

| 端点 | 语义 |
|---|---|
| `GET /api/internal/transcript/:key` | load 全量（`limit`/`cursor` 分页；**cursor 是不透明串** `<round>:<append_seq>`，见下「S1 分页」） |
| `PUT /api/internal/transcript/:key/rounds/:round` | appendRound（body = RoundRecord 全量，dedupKey 必填 ≤256 字符，body ≤1MB） |
| `PUT /api/internal/transcript/:key/checkpoint` | saveCheckpoint / appendCheckpoint（revision CAS，旧 revision 409 `checkpoint_stale`） |
| `GET /api/internal/transcript/:key/checkpoint/latest` | loadLatestCheckpoint；无 → 204 |
| `PUT /api/internal/transcript/:key/runstate` | saveRunState `{run_state}` / markRunState 终态标记 `{state}`（合并写，blob 并入 `runId = :key`，引擎契约 `loadRunState(key).runId === key`）；不动 `runs.status` |
| `GET /api/internal/transcript/:key/runstate` | loadRunState；无 → 204 |

**S1 分页（`GET /api/internal/transcript/:key`，issue #338）**：

- `?limit=<1..10000，默认 10000>`：**按行**截断（量纲是**行**，不是轮——0.23 账本一轮是多行：
  1 条载体 `:engine:round:<n>` + 1 条 assistant `:msg:<n>:0` + 每个工具调用 1 条 `:msg:`，实测约
  2–3.3 行/轮 ⇒ 一页 10000 行 ≈ 3000–5000 轮）。
- `?cursor=<round>:<append_seq>`：**不透明串**，即 `(round, append_seq)` 的**全序断点**（游标值不要自己拼，
  只把上一页的 `next_cursor` 原样回传）。服务端按 `(round, append_seq) > (cursor_round, cursor_seq)` 取行，
  索引 `transcript_rounds_session_append_idx (transcript_key, round, append_seq)` 直接支撑（零 DDL）。
- 响应：`{ "records": [...], "next_cursor": "<round>:<append_seq>" | null }`。`records` 的字段集与
  **写入口的 record 逐字相同**（`append_seq` 是分页内部列，**不进**返回集）；`next_cursor` = 本页**最后一行**
  的断点，**本页 0 行时才为 `null`**（取到行就必须给游标，哪怕正好切在一轮中间）。
- **允许一轮跨页，绝不跳行**：旧实现只带 round 且过滤 `round > cursor`（严格大于）⇒ 页边界切在一轮肚子里时
  该轮剩余行被**永久跳过** ⇒ 引擎 `foldLedgerMessages` 建出的序列里 `tool_use` 没结清 ⇒ `validateMessages`
  抛 `invalid_messages`（切点稳定、重试无效）。故 `records` 里**同 round 可能分布在相邻两页**，调用方必须
  按 `next_cursor` 翻到底再拼，不得用「round 变了」当页边界。
- 游标形态非法（不匹配 `^[0-9]+:[0-9]+$`，含旧版纯数字游标）⇒ `400 validation_failed`（`details.field = 'cursor'`，
  **零新错误码**）。**故意不做**纯数字旧游标兼容：唯一消费者是 agentd，它只回传 portal 给的串。
- **同轮多行与「载体」**：`records` 里同一 `round` 可能有多个**载体候选行**（`…:engine:round:<n>`、
  `…:engine:round:<n>:resume`）——这是崩溃恢复的正常形状（0.23 的 `:resume` 行只带引擎控制文本，见
  `orchestrator.js` 的 `messages: cloneState(resumeEngineText)`）。宿主侧逐行投影**每轮取行序第一个载体**，
  口径与 #339 定性（已从「待修缺陷」改判为「已钉住的哨兵」）见
  `docs/design/conversation-state.md` §6「逐行投影的载体口径与 #339 定性更正」。
  **本端点只负责按 `(round, append_seq)` 原样给行**，不做任何折叠、合并或去重。

**runner 侧接线**：`markRunState('running')` 仍走 U2 真 runId（runs 表生命周期，sessionId 绝不进 U2）；
宿主预写 dedupKey = `<key>:input:<messageId>`（`messageId` 经 U1 ticket `run.message_id` 下行）；
resume=true 时不传 initialMessages/initialUserMessage（引擎恢复记录即完整上文）；**P3 PR③ 起两侧都永不传 `initialMessages`**
（issue #69 的「文本注入」链路已整体退役：ticket `run.history`、`RUN_START.history`、`runner/lib/history.js`
与 env `STATION_HISTORY_MAX_*` 全部删除；非 resume 只传 `initialUserMessage = run.task`，对齐上游 CLI 的
`...(resume ? {} : { initialUserMessage })`）。部署顺序：
**portal 先上（S 端点纯增量，旧 runner 无感），FDE 镜像（runner/agentd/worker）后上**。

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

worker 被杀后重排的上报形态（**issue #288 additive**；没有 kill 就一个额外字段都不发）：

```json
{ "reason": "watchdog_silent", "killed_by": "watchdog", "silent_ms": 301584 }
```

| 字段 | 说明 |
|---|---|
| `reason` | string，必填，非空，≤ 64 字符。开放值（便于扩新场景，**无枚举白名单** ⇒ 新值不需协同发版），常用：`worktree_failed`（worktree 创建失败）/ `worker_crashed`（worker 非预期退出）/ `fork_failed` / `prep_failed` / `agent_shutdown`；**#288 起新增 `watchdog_silent`**（F6 执行期静默看门狗判死，之前误报 `worker_crashed`） |
| `killed_by` | **issue #288 additive**，可选：`watchdog`（F6 执行期静默被判死，缺陷 A 的看门狗）\| `crash`（worker 非预期退出）。**只认这两个值**；缺省或非法值 ⇒ 视为「没有 kill 报告」，**不 400、不写事件**（旧 agentd 与「压根没起 worker」的 release 全走这条路）。它决定 portal 是否合成 `attempt_killed`（§5.3 第 14 类） |
| `silent_ms` | **issue #288 additive**，可选 number：判死前的静默时长。portal 只在 `Number.isFinite(v) && v >= 0` 时写入事件载荷（四舍五入取整），否则**整个键不出现**——绝不拿 `0` 冒充「有静默时长」（与 #283 的 `duration_ms` 同一口径） |
| `next_retry_in_ms` | **issue #288 additive**，可选 number：预留给「宿主侧退避」，portal 会原样写进事件载荷；**当前 agentd 不发这个字段**（不发就没有该键） |

**「无 kill ⇒ 零字段」口径（#288，agentd 侧已落实）**：agentd 只有在**真的**杀掉 worker 时才带 `killed_by`/`silent_ms`；`fork_failed` / `prepare_cwd_failed` / `run_data_failed` / `agent_shutdown` 这类 release 一个额外字段都不发，portal 因此一条 `attempt_killed` 都不写（零事件面），旧 agentd 与新版 portal 混跑同样成立。

响应 `200`（返回对象）：

```json
{
  "run_id": "9d3b2f1e-...",
  "run_status": "running",
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
| `attempts < max_attempts` | `run_queue` → `pending`（清 `owner_container_id`/`lease_until`/`claimed_at`，**保留 `claim_token`** 供重复 release 幂等重放，fencing 由清空 lease_until 保证）；**`runs.status` 不变**（attempt 级失败不回跳，A5 定稿；崩溃现场为 `running` 则重排后仍为 `running`，不回写 `queued`）。**带 `killed_by` 时同事务追加一条 `attempt_killed`（§5.3 第 14 类，幂等键 `<run_id>:attempt-killed:<attempt>` + `ON CONFLICT DO NOTHING`，seq 走 `allocSeq`，提交后推 session SSE）**；§9.6 U2 转换表的 `running→queued` 维持**非法**，release 不再绕过它；重领靠 `tryClaim` 的 `runs.status IN ('queued','running')` + 租约过期/`pending`（与 run 状态无关于消息安全，消息安全靠「同事务写 transcript + 插 `run_queue`」）。同 run re-claim 后 `attempt > 1` 续跑（model.md §2.8 A1/A5） | `requeued` |
| `attempts >= max_attempts` | queue → `done`；runs → `failed`（`max_attempts_exceeded`） | `failed_max_attempts` |

**组合语义**：

- **`attempts < 3` 且 cancelled**：cancelled 分支优先（用户 stop 优先于 re-queue）——stop 语义不可被 release 反转。
- **lease_lost**：release 的前提是「agentd 仍持有有效租约」；若 run 已被 re-claim（旧 `claim_token` 失效），release 一律 `409 lease_lost`（防旧 agentd 释放他人已领的 run）。
- **重复 release**：同 `claim_token` 下、run 尚未被重领时，第二次 release 返回首次结果（幂等，无二次状态迁移）；若首次 release 后 run 已被重领，则旧 `claim_token` → `409 lease_lost`。
- **kill 报告与事件（#288）**：`attempt_killed` 与队列改写**同一事务**（挪到 `COMMIT` 之后就是缺陷：提交成功但补写事件失败 ⇒ 用户永远看不到那次重排）；`COMMIT` 失败 ⇒ 事件与 seq 一起回滚，不留「说被杀但没重排」的孤儿事件。同一 attempt 的 at-least-once 重复上报 ⇒ 仍恰一条，且第二次不推 SSE。
- **终态 additive（#288）**：`attempts >= max_attempts` 分支合成 `run_end` 的 `error.code` **仍是 `max_attempts_exceeded`**（既有契约不得改，§6.4）；带 kill 信息时 additive 挂 `last_reason` / `last_silent_ms`（无 kill ⇒ 两个键都不出现）。
- **reaper 的对称路径（issue #292）**：本端点的前提是「agentd 还活着并主动上报」。**上报者自己死了**（agentd 被杀 / 容器 `docker kill` / OOM / 网络断）⇒ 根本不会有 U12 调用，收敛改由 run 租约 reaper（`reapExpiredRuns`，每 15s 扫 `status='claimed' AND lease_until < now()`）完成，矩阵与上表一致。它同样在**`attempts < max_attempts`（回 pending）分支的同一事务内**合成一条 `attempt_killed`（§5.3 第 14 类：同一个幂等键 `<run_id>:attempt-killed:<attempt>`、`seq` 走 `allocSeq`、`ON CONFLICT (run_id, client_event_id) DO NOTHING RETURNING id`、**没真插入行不推 SSE**、`COMMIT` 之后才推）；固定 `killed_by:'crash'` / `reason:'lease_expired'`、**不带 `silent_ms`**。`attempts >= max_attempts` 分支同样 additive 挂 `last_reason:'lease_expired'`（`error.code` 仍是 `max_attempts_exceeded`，**不带 `last_silent_ms`**）；`cancelling` 分支仍只合成 `run_end(aborted)`、不写 `attempt_killed`。**不新增错误码、不改 `outcome` 取值**（reaper 不是 HTTP 端点，它的结果只在内部循环里）；已知边界：租约未过期而 worker 已死的窗口内（≤ 90s）仍然零事件——reaper 只能看见「没人续租」这个事实。
- **新 `reason` 值 `watchdog_silent`（#288）**：F6 执行期静默看门狗判死时用它在 `reapWorker` 的 `onWorkerExit` 里报 `reason`（缺陷 A 之前误报 `worker_crashed`）。`reason` 是自由字符串（无枚举白名单），旧 portal 遇到未知值照旧照常 requeue，**不需要协同发版**。

错误：`400 validation_failed`（`reason` 缺失/超长）；`401 token_invalid / token_revoked`；`403 run_ownership_mismatch`；`404 run_not_found`；`409 lease_lost`；`409 run_terminal`（run 已终态，release 无意义）；`429 rate_limited`；5xx 无限退避重试（§9.13）。

### 9.12 `GET /api/internal/stream`（SSE 下行通道）

常连；断线指数退避重连（1s→2s→5s→10s→30s 封顶）。事件类型表（runner §4.3）：

| `event:` | 字段 | 语义 | agentd 动作 |
|---|---|---|---|
| `run_assigned` | `{run_id, queue_id}` | **唤醒 hint**：有新任务可领；**不携带权威载荷**（载荷以 claim 响应为准） | 若当前 claim 处于 hold 间隙则立即发起 claim |
| `approval_decision` | `{approval_id, run_id, decision, note, decided_at}` | 审批结果**快通道** | resolve 对应 worker 的 await（§9.10） |
| `stop_request` | `{run_id, reason}` | portal 已写 `cancel_requested_at`（§4.5），要求终止 | IPC `abort` → worker；若无此 run（已结束）忽略 |
| `steer_request` | `{run_id}` | **用户要求转向**（issue #370，§4.3a）：portal 已把那句话写进 `queued_inputs` 并给该 run 打了 `cancel_requested_at`（**`status` 仍是 `running`**） | IPC `steer_arm` → worker **装标记**（**不是 abort！**）。worker 在 erix-agent 的 `onRound`（本轮 transcript 已落库、下一次 provider 调用之前）里自己 `abort()` ⇒ 正在执行的工具调用**会跑完**。找不到该 run（已结束/不在本容器）就忽略：队列不因此丢失，终态出队会把它投成新 run |
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

## 10. Admin Git credential endpoints

All three routes require the existing `requireAdmin` authorization (`401` without a session, `403` for a non-admin). `fdeName` uses the project FDE-name grammar; `host` must be a DNS hostname with an optional port. Invalid fields return `400 validation_failed`.

### `PUT /api/admin/fdes/:fdeName/git-credential`

Request:

```json
{ "host": "github.com", "username": "x-access-token", "token": "<secret>" }
```

`host`, `username`, and non-empty `token` are required. The token is URL-encoded and written through to the **platform-owned** credential file `<userSpaceRoot>/<fdeName>/platform/git/credentials` (bind-mounted read-only into the container at `/run/erix/git/credentials`, issue #399); it is not stored in the database or passed in container environment variables. The file is atomically replaced with mode `0644` owned by the portal process (the read-only bind, not the mode, is what prevents container-side writes; the image's `/etc/gitconfig` lists a fill-only helper for this file before the FDE's own `store`). The legacy `<fdeName>/home/.git-credentials` is left untouched for FDE-managed hosts (e.g. self-configured `github.com`). The audit entry records the FDE and host only.

Response `200` (the token is never returned):

```json
{ "host": "github.com", "username": "x-access-token", "configured": true }
```

If this host is the FDE's assigned `per_fde_pat` Git host, a successful write records the remote login and changes `users.status` from `awaiting_credential` to `active`. Deleting that credential moves the account back to `awaiting_credential`.

### `GET /api/admin/fdes/:fdeName/git-credential`

Response `200`:

```json
{ "hosts": [{ "host": "github.com", "username": "x-access-token", "token": "****last4" }] }
```

### `DELETE /api/admin/fdes/:fdeName/git-credential?host=<host>`

Removes all stored credential lines for the exact host from the platform credential file (and the legacy home file if the host still has a line there), leaving other hosts intact; the platform file remains present even when empty. Response `200` is `{ "host": "github.com", "deleted": true }`. Audit details contain the host and deletion result, never token text.

## 11. Admin Git host registry (issue #118)

All routes require the existing `requireAdmin` authorization. `git_hosts.mode` is derived by the server; clients must not set it. `admin_key` is accepted only on create or when replacing the key, and responses contain only a masked value plus `admin_key_configured`. The key is never included in audit details. `provider='azure'` remains reserved in the database constraint but is rejected when creating a host. GitHub is supported in `per_fde_pat` mode: the platform cannot mint credentials for it, so each FDE supplies its own PAT, and configuring an `admin_key` on a GitHub host returns `400 admin_key_unsupported`. Enterprise-internal deployments can still use Gitea or GitLab with platform-minted credentials.

### `GET /api/admin/git-hosts`

Returns `{ "items": [host, ...] }`, where each host contains `id`, `name`, `provider`, `base_url`, masked `admin_key`, `admin_key_configured`, derived `mode` (`minted` or `per_fde_pat`), and `enabled`.

### `POST /api/admin/git-hosts`

Request fields: `name`, `provider` (`gitea` / `github` / `gitlab`), `base_url`, optional `admin_key`, and optional `enabled`. A GitHub host always uses `per_fde_pat`; supplying `admin_key` for it returns `400 admin_key_unsupported` with `details.field='admin_key'`. `provider='azure'` returns `400 provider_unsupported` with `details.field='provider'`. A Gitea/GitLab admin key selects `minted`; no key selects `per_fde_pat`. Returns `201 { "host": ... }`.

### `PATCH /api/admin/git-hosts/:id`

Updates supplied host fields and returns `{ "host": ... }`. Omitting `admin_key` preserves it; `clear_admin_key: true` removes it and recomputes `mode`. `mode` is read-only. Switching a host to GitHub is allowed and forces `per_fde_pat`; supplying `admin_key` on a GitHub host (including switching a host that still carries one) returns `400 admin_key_unsupported`, so clear the key first. Changing provider or base URL is rejected with `409 host_in_use` while an FDE is bound.

### `DELETE /api/admin/git-hosts/:id`

Returns `204` when deleted; returns `409 host_in_use` while `fde_git_accounts` references the host.

### `POST /api/admin/fdes/:fdeName/provision`

The JSON body may contain `git_host_id`. The selected provider is recorded in `containers.git_provider`. `minted` hosts provision an account and scoped token; token plaintext is written to the FDE `.git-credentials` file and never stored in the database. `per_fde_pat` hosts finish with `users.status='awaiting_credential'` until the administrator writes the FDE's PAT through the Git credential endpoint. The response includes `status` and `git_provider`.

## 12. Admin user management (issues #128, #139)

All user-management routes require `requireAdmin`: no session returns `401 unauthorized`; a non-admin session returns `403 forbidden`. User IDs are UUIDs. User objects never contain `password_hash` or `totp_secret`.

### `GET /api/admin/users`

Returns `{ "items": [...] }`. Each item contains `id`, `login`, `display_name`, `role`, `fde_name`, `git_host_id`, `auth_source`, `status`, `created_at`, `totp_enabled` (boolean), `last_login_at` (the newest `login_sessions.created_at`, or `null`), `last_activity_at` (the newest real user input, or `null`; see the note below), and `offboarding` (`null` or `{ "state", "step", "error", "workspace_purge_after" }`). Offboarding `state` is `pending`, `running`, `done`, or `failed`; `step` identifies the current/failed workflow step and is `null` when complete. Revoked sessions remain part of login history.

**`last_activity_at`（issue #497，工单 `feat-261112-01`，迁移 `0031`）**：该用户**最近一次亲口说话**的时刻 = **按下发送那一刻**（`timestamptz`，DTO 里是 ISO 串）。它补的是一个**此前缺失**的维度：`last_login_at` 只回答「最近一次把门推开」，页面刷新、自动续期、以及一句话没说的天天登录都会写它，所以它答不出管理员真正想问的「**这个人还在用吗**」。

- **写入点只有两处**（刻意不加第三处）：`portal/src/sessions.js#postMessage`（本站唯一发送路，直发与队列投递都走它）与 `portal/src/queued-inputs.js#enqueueQueuedInput`（run 正在跑时按回车那一刻就是活动——那句话此刻已落进 `queued_inputs`，与「稍后被投递」无关；投递失败退回待投也不把它收回）。两处都在**既有事务内用同一个 `client`** 写 ⇒ 不会出现「消息回滚了而活动位前进了」。**无节流**：一次输入写一次。
- **不算活动**：agent 跑完一个 run（run 生命周期与终态）、页面刷新/重开、会话改名与归档、预览访问、程序化 `api_tokens` 调用，以及**登录本身**。⇒ 它与 `last_login_at` 是**两条独立时间线**，**允许比 `last_login_at` 旧**（登录了但一句话没说；dev 库现验 9 个用户里就有 2 个是这个形状）。读侧与界面都**不许**把这种「倒挂」当脏数据修正，也不许在登录路径「顺手」补写——那会把它退回成第二个 `last_login_at`。
- **可空 = 契约**：`null` = 从未活动（新开户，或从没说过话）。列**无默认值**（`DEFAULT now()` 会让每个新账号凭空得到一次活动，而那一刻它什么都还没说）、**无索引**（只作返回列，不参与过滤/排序，口径同 `last_login_at`）。DTO **恒带该键**：`null` 是「从未活动」，不是缺键。
- ⚠ **重新开户不清零**：同名 `disabled` 行被重新激活时本列**保留原值**，与本节 `file_upload_enabled` 的**显式清零相反**——权限清零是因为权限不继承任期，而这一列是**事实**，事实不需要被抹掉。
- 历史数据由迁移 `0031` 一次性回填：只动 `last_activity_at IS NULL` 的行，取 `messages` 里 `role='user' AND synthetic=false` 的 `MAX(created_at)`（`synthetic=false` 是口径的一部分——宿主注入的合成行不是人说的话），join `chat_sessions` 拿 `user_id`。回填后仍没有用户消息的账号**保持 `NULL`**，不拿 `last_login_at` / `created_at` 冒充。第二遍重放必为 0 行（dev 库现验 `UPDATE 0`）。
- **只在管理台这一侧**：本节 `GET /api/admin/users` 的 item，以及 `POST /api/admin/users`、`PATCH`、TOTP 重绑三条返回的 `<safe user>` 里恒有该键。`GET /api/me` 与两个登录端点的 user DTO（§2.6）**不带**它——别按「四条 user DTO 路径键集一致」去预期（那条纪律管的是 §2.6 那四条）。
- 消费面：管理台用户列表**第 8 格**（`AdminUsersView.vue`）——主行是最后活动，副行小字是 `登录于 …`（从未登录时副行整行不渲染，不拼成「登录于 从未登录」）；表头「最近登录」→「最后活动」，**列数不变**。空值渲染成「从未活动」，**绝不**渲染成「今天」或空串（没数据就没资格承诺）。

### `POST /api/admin/users`

⚠ **#255（工单 `feat-261013-03`）**：建用户（以及「同名 `disabled` 行重新激活」）**两条分支都置** `users.must_change_password = true`——两条都是往 `password_hash` 里塞一个**别人知道**的口令。`cli.js bootstrap-admin` **故意不置**（它打印的那枚口令就是本人第一次看到的那一枚），口径与理由见 §2.9.4。

Creates a local FDE user. Request fields: `login`, `password`, `email`, `fde_name`, and `git_host_id` are required; `display_name` is optional. `llm` is required and has the same model-slot shape as the per-FDE LLM endpoint:

```json
{
  "login": "alice",
  "password": "...",
  "email": "alice@example.test",
  "fde_name": "alice",
  "git_host_id": "...",
  "llm": {
    "provider_id": "mock-provider",
    "main_model_id": "model-info-id",
    "embedding_model_id": null,
    "vision_model_id": null
  }
}
```

`llm.provider_id` and `llm.main_model_id` must be non-empty. The selected provider and models must exist in the LiteLLM catalog; the main model must be enabled, text-capable, and support tool calling. Embedding and vision slots are optional and, when selected, must be enabled models of the matching type under that provider. Missing or invalid selections return `400 validation_failed` with `details.field`. If the optional LiteLLM profile's catalog cannot be read, creation fails closed with `503 llm_catalog_unavailable`; enable or repair LiteLLM before retrying.

The selected model configuration is persisted with the onboarding workflow. After provisioning and user-space materialization, Station creates a per-FDE virtual key restricted to those models. This LLM binding step is independent: key creation failures are recorded in `onboarding.llm_binding` and do not fail the user account or change its `done` / `awaiting_credential` onboarding state. An administrator can retry it with `POST /api/admin/users/:id/onboard/retry`; an existing binding is left untouched. The LLM tab can later change the model allowlist through its normal save path without rotating the key.

`totp_enabled` is an optional boolean defaulting to `false`. Only the boolean value `true` enables TOTP; other values are treated as `false`.

With the default `false`, `totp_secret` is stored as `NULL`, the response contains `{ "user": <safe user>, "onboarding": ... }`, and the user signs in with password only (the existing behavior for accounts without TOTP enrollment). This is the intentional deviation from the force-TOTP design target recorded in issue #139. With `totp_enabled: true`, the response also includes `totp_secret` and `totp_uri`; the seed is shown only in this creation response and must be saved and bound with an authenticator app.

If the requested `fde_name` belongs to a disabled user, this route reactivates that same `users` row instead of inserting another one and returns `"reactivated": true`; a normal insert returns `"reactivated": false`. Login, email, display name, password hash, and TOTP are updated from the request, `disabled_at` is cleared, and a login already owned by another row returns `409 login_conflict` with `details.field = "login"`. Old `login_sessions`, `login_pending`, and `api_tokens` are removed transactionally. The existing `fde_onboarding` workflow is reset to pending with all steps queued again, and `fde_git_accounts.remote_login` / `token_ref` are cleared so provisioning can reissue Git credentials. The historical `fde_offboarding` row remains. Reactivation is rejected with `409 user_offboarding` while an offboarding task is pending or running.

Reactivation starts a new provisioning pass for the retained identity, including container recreation, LLM binding/key restoration, and Git credential delivery. For a reused Gitea account, after resetting its password and setting `prohibit_login=false`, Station lists tokens with the new password and deletes only tokens named `erix-station-*` (or the token whose id matches the prior `token_ref`) before minting a replacement. This is required because Gitea 1.27.2 reactivates old tokens when login is unprohibited; the delete endpoint uses token name and Basic auth. Non-Station tokens are retained.

### `PATCH /api/admin/users/:id`

Accepts one or more of `display_name` (trimmed; blank falls back to `login`), `email`（可改可清，`null`/空串 = 清空）, `mail_otp_enabled`（布尔，打开前需已有邮箱且邮件通道可用）, `file_upload_enabled`（布尔，#472 片 A）, `role` (`fde` or `admin`), `fde_name` (valid FDE DNS label or `null`), and `status` (`active` or `disabled`). `login` is immutable. Empty updates, unknown fields, invalid values, or an invalid UUID return `400 validation_failed`; duplicate `fde_name` returns `409 fde_name_conflict`; a missing user returns `404 not_found`. Disabling sets `disabled_at` and atomically revokes every unrevoked login session; re-enabling clears `disabled_at`.

**`file_upload_enabled`（#472 片 A，issue #472）**：非布尔（`'true'` / `1` / `null`）⇒ `400 validation_failed` + `details.field: "file_upload_enabled"`。它**只能在这里打开**：`POST /api/admin/users`（开户）**不接受**该入参，开户一律 `false`（开户是批量/脚本路径，多一个可选参数就多一条「脚本写错把上传开给所有人」的路）。⚠ **重新开户 = 重新授权**：同名 disabled 行被重新开户时（§12 `POST /api/admin/users` 的 UPDATE 分支）本列被**显式清零**，不继承上一个任期的权限（否则「曾开过上传 → 停用 → 再开户」会静默保留写盘能力）。服务端下发的 user DTO 里该键恒为布尔；管理台对**缺键**（旧后端 / 读不到）显示「未知」并禁用保存，不折叠成「已关闭」。

### `DELETE /api/admin/users/:id`

This endpoint requests **disable/offboarding; it never deletes the platform account**. The `users` row is retained permanently with `status='disabled'`. For a user with FDE resources (including a workspace), the portal persists an offboarding task, immediately sets `users.status='disabled'`, revokes login sessions and pending login tokens, and returns `202`:

```json
{
  "offboarding": {
    "state": "pending",
    "step": "disable-user",
    "error": null,
    "workspace_purge_after": null
  }
}
```

The portal worker then stops active runs and the FDE container, revokes the runner token and LLM virtual key, removes local Git credentials, revokes access to a platform-minted Gitea account by setting `prohibit_login=true` (without deleting the upstream user or token), releases routes/network allocations, and records a workspace purge deadline only when retention is explicitly enabled. User-managed Git credentials are not used to disable the employee's upstream account; GitLab upstream revocation is deferred. The disable transaction also removes login sessions, pending login tokens, and API tokens. Failed steps are durable and can be retried; the account stays disabled. `ERIX_WORKSPACE_RETENTION_DAYS` defaults to `0`, which leaves `workspace_purge_after` NULL and disables sweeping. An explicit positive value enables a sweep that deletes only the workspace directory after its deadline; **all database rows remain**. A user without FDE resources or a workspace is disabled synchronously and returns `204`; the user row remains.

Deleting the current administrator returns `409 self_delete`. Resources with an invalid/missing `fde_name` return `409 user_fde_name_missing` rather than attempting unsafe cleanup.

### `POST /api/admin/users/:id/offboarding/retry`

Requeues a failed offboarding task and resets only its failed step to `pending`; completed steps are preserved. Returns `200 { "offboarding": ... }`. A missing user returns `404 not_found`; a user without an offboarding task or an already-running task returns `409`.

### `POST /api/admin/users/:id/reset-password`

Request: `{ "password": "..." }`; password length must be 1–256 characters (the configured portal limit applies). The password is stored as the existing self-describing scrypt hash. Returns `{ "ok": true }` and revokes every unrevoked login session; the plaintext and hash are never returned.

⚠ **#255（工单 `feat-261013-03`）**：本端点同时置 `users.must_change_password = true`（别人选的口令没经过本人之手），于是该用户**下一次拿到的会话是受限的**，直到他调 `POST /api/me/password`（§2.6a）为止——清单外的 `/api/*` 一律 `403 password_change_required`（§2.11a）。本端点**全量吊销**会话（与自助端点「保留当前会话」相反）正是这个限制能立刻生效的原因：手里还拿着旧口令副本的那些会话必须一起失效。

### `POST /api/admin/users/:id/totp-reset`

Clears `totp_secret` and `last_totp_step`, then revokes every unrevoked login session. Returns `{ "ok": true }`; the previous TOTP seed is never returned.

### `POST /api/admin/users/:id/totp-enroll`

Creates a new 20-byte TOTP seed for an existing user (replacing any previous binding), clears `last_totp_step`, and atomically revokes every unrevoked login session. Returns `{ "user": <safe user>, "totp_secret": "...", "totp_uri": "otpauth://..." }`; the seed is shown only in this response and never appears in user listings or later endpoints. A missing user returns `404 not_found`; a non-admin session returns `403 forbidden`.
