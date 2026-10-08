# new-api API 源码级分析（选型支撑材料 · 待验证项核实）

> **分析对象**：`QuantumNous/new-api`，commit `69a50029819a26c53e6babd276d49cfe2f8880ad`（`main` 分支，提交时间 2026-09-15 14:00:05 +0800，`feat(channel): per-route pass-through for advanced custom channels (#7386)`）
> **版本状态**：仓库**尚无 v1.0.0 正式版**；最新 tag / GitHub release 为 `v1.0.0-rc.37`（2026-09-11），首个 rc 为 `v1.0.0-rc.1`（2026-04-29），累计 65 个 rc tag。HEAD 在 rc.37 之后又累积 25 个 commit（2026-09-12 ~ 09-15）。
> **分析日期**：2026-09-16
> **分析方式**：只读源码分析（Go 后端 + TypeScript 前端 + `docs/`）。clone 到仓外研究目录 `~/projects/.research/new-api`（`--depth 50`），**未改动 erix-station 及其它任何仓库**。因分析环境无 Go 工具链、docker daemon 不可访问，**未做运行时实测**；下文所有结论均给出「文件:行号/函数名」来源，可复核。
> **用途**：核实选型文档 [`llm-gateway-selection.md`](./llm-gateway-selection.md) §5.2 列为「选择 new-api 前必须实测」的三项，以及 §1 硬需求 #2/#3/#4/#5 在 new-api 侧的可行性。

---

## 结论速览

| 问题 | 结论 | 一句话 |
|---|---|---|
| Q1 key 生命周期 admin API | ⚠️ 可脚本化，但**不是一等公民** | 令牌 CRUD 齐全（`POST/PUT/DELETE/GET /api/token/*`），但有 3 个自动化摩擦点：bootstrap 强依赖密码型会话（PAT 不能签发 PAT）、创建接口不返回 id/key（需 search + `/{id}/key` 两段式）、接口全为 user-scoped（无 admin 代建他人令牌） |
| Q2 额度超限 HTTP 状态码 | ❌ **不是 429** | 令牌额度已耗尽/过期 → **401** `{"error":{"message":"Invalid token",...}}`；本次预扣不足 → **403** `code=pre_consume_token_quota_failed`；用户钱包/订阅不足 → **403** `code=insufficient_user_quota`。429 只属于「请求次数限流」与「上游透传」，与配额无关 |
| Q3 凭据接受通道 | ❌ 硬编码多通道，**无配置可收紧** | `Authorization`（Bearer 前缀可省）、`x-api-key`、`x-goog-api-key`、query `key`、`mj-api-secret`、WebSocket 子协议 `openai-insecure-api-key.*` 全部硬编码在 `middleware/auth.go` 的 `TokenAuth`，`setting/` 与环境变量中都没有开关 |
| Q4 用量查询 API | ✅ 有，可用于对账 | 管理面 `GET /api/log/`（时间范围 + token_name/username/model 过滤 + `request_id`）、`GET /api/log/stat`、`GET /api/data/` 日聚合；令牌侧 `GET /api/usage/token/`、`GET /api/log/token`。注意明细筛选**只认 `token_name`（非唯一）**，不支持 `token_id` |

---

## Q1 令牌（key）生命周期的程序化 admin API

**结论：⚠️ 有完整的 REST CRUD，能被 portal 全自动调用，但与 LiteLLM 的「一等公民 admin API」相比存在三处结构性摩擦；OpenAPI 文档已落后于实现。**

### 证据

**(1) 令牌 CRUD 路由齐全，鉴权是 `UserAuth`（非管理员）**

`router/api-router.go:271-284`：

```go
tokenRoute := apiRouter.Group("/token")
tokenRoute.Use(middleware.UserAuth())
tokenRoute.Use(middleware.TokenOperationAudit())
    tokenRoute.GET("/", controller.GetAllTokens)          // 列表（key 打码）
    tokenRoute.GET("/search", ..., controller.SearchTokens)
    tokenRoute.GET("/:id", controller.GetToken)
    tokenRoute.POST("/:id/key", ..., controller.GetTokenKey)   // 取明文 key
    tokenRoute.POST("/", controller.AddToken)             // 创建
    tokenRoute.PUT("/", controller.UpdateToken)           // 整体更新；?status_only=true 仅改状态
    tokenRoute.DELETE("/:id", controller.DeleteToken)
    tokenRoute.POST("/batch", controller.DeleteTokenBatch)
    tokenRoute.POST("/batch/keys", ..., controller.GetTokenKeysBatch)  // 批量取明文 key（≤100）
```

创建/更新/删除/批量删除/查询/取 key 全部具备程序化接口；所有令牌写操作经 `middleware.TokenOperationAudit()` 留审计（`middleware/audit.go:210-256`，动作 `token.create/token.update/token.delete/token.key_view`）。

**(2) 管理端鉴权方式：`Authorization` 头 + JWT 或 PAT（无 session cookie、无 system token）**

`middleware/auth.go:158-187` `classifyDashboardCredential`：**只读 `Authorization` 头**，先按内部 JWT（`service.ParseDashboardAccessToken`）解析，失败再按 PAT（`model.ValidateAccessToken`，即 `users.access_token` 字段）解析；`middleware/auth.go:189-200` `authorizationToken` 允许 `Bearer <x>` 或**裸露** `<x>`。

- `docs/authentication.md`「PAT 调用契约」："`User.AccessToken`（面板 PAT）继续支持 `Authorization: Bearer <pat>`，也兼容原有的单值 `Authorization: <pat>`。`New-Api-User` 不再参与鉴权"。
- `docs/openapi/api.json` `components.securitySchemes`：`AccessToken1` = "面板短期 JWT 或 User.AccessToken PAT；不再要求 New-Api-User"；`SessionAuth1`（cookie `session`）标注"已废弃：Gin session 不再用于面板鉴权"；`NewApiUser1` 标注"已废弃且不再参与鉴权"。
- **不存在** system/admin token 之类的旁路：`common/init.go:90-230` 的环境变量清单中没有此类凭据。

**(3) 但 PAT 无法自举（关键摩擦点）**

`controller/access_token.go:24-49` `GenerateAccessToken`（`GET|POST /api/user/token`）第一行即：

```go
if middleware.RequireSecurityProof(c, service.VerificationOperation{Scope: service.VerificationScopeAccessTokenGenerate}) == nil {
    return   // 安全验证不通过（PAT 调用者必然不通过）——RequireSecurityProof 已写出 403 SECURITY_PROOF_INVALID
}
```

`middleware/secure_verification.go:39-49` 中 `RequireSecurityProof` 先要 `GetSessionAuthIdentity`（必须有 SID/版本，`middleware/auth.go:131-146` 注释明确"PAT-authenticated requests intentionally fail this check"），再校验 `X-Security-Proof`。`docs/authentication.md` 亦明文："PAT 不是浏览器登录会话……也不能签发绑定具体登录会话的 Security Proof"。

→ **portal 不能"用已有 PAT 换一个新 PAT"**，必须先建立真实登录会话。可用路径（全部为 HTTP，无人工 UI 步骤）：

1. `POST /api/user/login`（用户名+密码；若开启 Turnstile/2FA 则需相应处理）→ 返回 15 分钟 JWT `access_token` + refresh cookie（`docs/authentication.md`「浏览器接口」）。
2. `POST /api/verify`，body `{"method":"password","scope":"access_token.generate","password":"..."}`（`controller/secure_verification.go:137-155`；`service/security_verification.go:404-438`，无 2FA/Passkey 的用户允许 `password` 作为验证方式，见 `service/security_verification.go:195-205`）→ 返回 `proof_token`。
3. `POST /api/user/token`，带 `Authorization: Bearer <JWT>` + `X-Security-Proof: <proof_token>` → 返回 PAT（长度 29~32 随机串）。

即：**需要长期保存一个账号口令（或长期保存 PAT 并在吊销后重新执行上述流程）**；`POST /api/user/token` 另受 `UserCriticalRateLimit("access-token")` 约束（默认 20 次/20 分钟，按用户，`middleware/rate-limit.go:181-190` + `common/init.go:131-133`）。

**(4) 创建接口不返回 id / key → 必须两段式**

`controller/token.go:278-359` `AddToken`：服务端自行 `common.GenerateKey()` 生成 48 位随机串（`common/utils.go:231-257`，字符集 `0-9a-zA-Z`，**不含 `sk-` 前缀、不含 `-`**），最终响应只有：

```go
c.JSON(http.StatusOK, gin.H{"success": true, "message": ""})   // controller/token.go:355-358
```

→ 拿到 key 需要：`GET /api/token/search?keyword=<name>`（或 `GET /api/token/`）取回 `id`（`controller/token.go:144-158`，返回打码 key + id），再 `POST /api/token/:id/key`（`controller/token.go:188-206`，返回 `{"key":"<48位明文>"}`，客户端需自行加 `sk-` 前缀，见 `web/src/features/keys/components/api-keys-provider.tsx:125-140`）。批量可 `POST /api/token/batch/keys`，body `{"ids":[...]}`，上限 100（`controller/token.go:532-535`）。注意 `POST /api/token/:id/key` 挂的是 `CriticalRateLimit()`（**按 IP** 20 次/20 分钟，`router/api-router.go:279` + `middleware/rate-limit.go:174-179`）——逐个取 key 会被限流，portal 应走 batch 接口。

**(5) 请求/响应字段（额度 / 模型限制 / 过期 / 分组 / 别名）**

`model/token.go:14-30`（`Token` 结构，请求与响应共用同一 schema，`controller/token.go:34-38`）：

| 字段 | 含义与来源 |
|---|---|
| `name` | 别名（本场景的 `alice@client-x`）。≤50 字符（`controller/token.go:286-289`）；**无唯一约束**（`model/token.go:17` 仅 `index`）——唯一性需 portal 自建命名约定 |
| `remain_quota` / `unlimited_quota` | 额度与"不计额"。`remain_quota` 有上下界校验（`maxTokenQuota()`，`controller/token.go:45-53`） |
| `expired_time` | Unix 秒，`-1` = 永不过期（`model/token.go:21`）；已过期令牌无法被重新启用（`controller/token.go:419-427`） |
| `model_limits_enabled` + `model_limits` | 模型白名单。**格式是逗号分隔字符串，不是 JSON**（`model/token.go:338-343` `strings.Split(token.ModelLimits, ",")`）；前端即按 `,` 切分（`web/src/features/keys/components/api-keys-cells.tsx:145-146`）。命中白名单外模型由 `middleware/distributor.go:87-96` 返回 403 |
| `group` | 令牌分组，需属于该用户可用分组，否则 403（`middleware/auth.go:455-472`） |
| `allow_ips` | 令牌级 IP/CIDR 白名单（换行/逗号分隔，`model/token.go:84-104`），不在列表返回 403（`middleware/auth.go:433-435`） |
| `status` | 1/2/3/4 = enabled/disabled/expired/exhausted（`common/constants.go:242-245`） |

**(6) 令牌归属：全部 user-scoped，没有"admin 代建他人令牌"的接口**

`controller/token.go:333`：`UserId: c.GetInt("id")` —— 只能给自己建令牌；`/api/token/*` 整体挂 `middleware.UserAuth()`（普通用户即可）。管理员侧只有用户管理与加额度：`POST /api/user/`（建用户，可指定初始密码，`controller/user.go:969-1024`）、`PUT /api/user/`（改用户密码，`controller/user.go:647-715`）、`POST /api/user/manage`（`{"action":"add_quota","id":N,"mode":"add","value":X}`，`router/api-router.go:157` + `controller/user_quota.go:14-47`）。

→ 落地形态二选一：(a) 所有 FDE key 挂同一技术账号、用 `name` 承载 `alice@client-x` 别名（最简单，但失去用户级额度/用量分层）；(b) 每 FDE 一个用户 + 各自的 PAT（需要为每个用户执行一次「登录 + password proof + 领 PAT」，且受 `USER_SESSION_ACTIVE_LIMIT=50` / `USER_SESSION_ISSUANCE_LIMIT=100/24h` 约束，见 `docs/authentication.md`）。

**(7) 钱包额度是 relay 的硬前置**

`service/billing_session.go:388-400`：`userQuota <= 0` → 403 `insufficient_user_quota`；`userQuota - preConsumedQuota < 0` 同样 403。**只给令牌额度、不给用户钱包充值是不够的**，onboarding 必须同时调 `/api/user/manage` 加额度。

**(8) 文档漂移（"一等公民"成色不足）**

`docs/openapi/api.json`（标题「后台管理接口」）虽存在且定义了 `AccessToken1` 安全方案，但**与实际路由不同步**。以 token/log/data 三组实测比对（脚本比对我人工解析的路由表）：

- 路由存在、文档缺失：`GET /api/token/auto-groups`、`POST /api/token/{id}/key`、`POST /api/token/batch/keys`、`GET /api/data/users`、`GET /api/data/flow`、`GET /api/data/flow/self`、`GET /api/log/channel_affinity_usage_cache`（共 7 条，其中取 key 的那条正是自动化必需）；
- 文档仍在描述、实现已废弃：`GET /api/log/search`、`GET /api/log/self/search`（`controller/log.go:64-77` 直接返回 `{"success":false,"message":"该接口已废弃"}`）；
- 请求/响应 schema 粒度粗：`POST /api/token/` 只有"200 成功"、无响应 schema（`docs/openapi/api.json` → `paths["/api/token/"].post.responses`），无法从文档得知"创建不返回 key"这一关键事实。
- CI 未校验文档：`.github/workflows/` 只做 go vet/build/test 与前端构建，无 OpenAPI 一致性检查。

### 对本场景的含义（需求 #2）

- **可行性：可以全自动**，但 portal 需要编排「登录 → 取 security proof → 领 PAT → 建令牌 → search 取 id → 取 key」这条 5~6 步链路，并长期持有一个账号口令作为自举凭据（口令轮换会打断自动化）。
- **不建议**把 `fde_llm_bindings` 的 key 生命周期完全交给 new-api 的 user 层：用户层模型（user → token）与本场景层级（FDE / 客户项目）不同构，且跨用户建 key 没有 admin 接口。推荐"单技术账号 + `name` 承载别名 + portal 侧维护 `token_id ↔ binding` 映射表"。
- 与选型文档判断一致：**存在 API，但以 Web UI 为中心**（前端 `web/src/features/keys/api.ts` 才是接口的事实文档），接口虽在 rc 期间已明显收敛（见 Q1 证据 (2)），仍不应视为稳定契约。

---

## Q2 额度超限时返回的 HTTP 状态码

**结论：❌ 不是 429。** 配额相关的拒绝只出现在两处：**401**（令牌已耗尽/过期/禁用，在鉴权中间件拦截）与 **403**（本次预扣额度不足 / 用户钱包或订阅不足，在计费预扣阶段拒绝）。429 仅用于请求次数限流与上游状态码透传。这直接违反选型文档 §1 需求 #3，也影响 agent 侧 `rate_limited, retryable` 分类。

### 证据

**(1) 令牌额度已耗尽 / 已过期 → 401 Unauthorized（且文案与"key 无效"完全相同）**

`model/token.go:220-251` `ValidateUserToken`：

```go
if token.Status == common.TokenStatusExhausted ||
    token.Status == common.TokenStatusExpired ||
    token.Status != common.TokenStatusEnabled {
    return token, ErrTokenInvalid
}
if token.ExpiredTime != -1 && token.ExpiredTime < common.GetTimestamp() { ...; return token, ErrTokenInvalid }
if !token.UnlimitedQuota && token.RemainQuota <= 0 { ...; return token, ErrTokenInvalid }
```

`middleware/auth.go:410-421` `TokenAuth`：

```go
} else {
    abortWithOpenAiMessage(c, http.StatusUnauthorized,
        common.TranslateMessage(c, i18n.MsgTokenInvalid))
}
```

响应体（`middleware/utils.go:14-32` `abortWithOpenAiMessage`）：

```json
{"error":{"message":"Invalid token (request id: ...)","type":"new_api_error","code":""}}
```

文案来源 `i18n/locales/en.yaml:47` `token.invalid: "Invalid token"` —— **与"key 不存在/被吊销/拼错"完全同一状态码、同一 `code`（空）、同一 message**。仓库里 `token.exhausted` / `token.expired` 两个 i18n key（`i18n/keys.go:56-57`）**没有任何调用点，是死键**（全仓 grep 仅有定义），说明实现上并不打算区分。

补充：令牌预扣/结算并不把 `status` 改成 exhausted（`model/token.go:408-434` `DecreaseTokenQuota` 只改 `remain_quota`/`used_quota`），落到 0 或负数后，**下一次请求走 (1) → 401**。

**(2) 剩余额度不足以本次预扣 → 403 Forbidden，`code=pre_consume_token_quota_failed`**

链路：`controller/relay.go:128` `relay.PrepareRequestBilling` → `relay/request_billing.go:64` `service.PreConsumeBilling` → `service/billing.go:37` `NewBillingSession` → `service/billing_session.go:207-211`：

```go
if err := PreConsumeTokenQuota(s.relayInfo, effectiveQuota); err != nil {
    return types.NewErrorWithStatusCode(err, types.ErrorCodePreConsumeTokenQuotaFailed, http.StatusForbidden,
        types.ErrOptionWithSkipRetry(), types.ErrOptionWithNoRecordErrorLog())
}
```

错误原文来自 `service/quota.go:396-411` `PreConsumeTokenQuota`：`"token quota is not enough, token remain quota: %s, need quota: %s"`（原子预扣失败，`model.TryReserveTokenQuota`）。响应由 `controller/relay.go:104-106` 输出：

```json
{"error":{"message":"token quota is not enough, ... (request id: ...)","type":"new_api_error","param":"","code":"pre_consume_token_quota_failed"}}
```

（`relaykit/types/error.go:180-203` `ToOpenAIError` 的 default 分支给出 `type:"new_api_error"`，`code` 取自 `errorCode`；`relaykit/types/error.go:299-315` 构造该错误。）

**(3) 用户钱包 / 订阅额度不足 → 403，`code=insufficient_user_quota`**

`service/billing_session.go:228-240`（预扣资金失败）与 `:388-400`（`NewBillingSession` 钱包前置检查，**先于**令牌预扣执行），错误码定义 `relaykit/types/error.go:86`。

**(4) 429 的真实归属**

全仓非测试代码中 `http.StatusTooManyRequests` 的出现点：

| 位置 | 语义 |
|---|---|
| `middleware/rate-limit.go:135-144`（+ `:109-133` 各 `*RateLimit`） | IP / 用户维度的接口调用频次限流（含 `CriticalRateLimit`，带 `Retry-After`） |
| `middleware/model-rate-limit.go:95,119,144,153` | 用户的**模型请求次数**限制（成功数 / 总数，窗口内计数） |
| `middleware/email-verification-rate-limit.go:39,50`、`middleware/task_artifact_access.go:238`、`controller/plugin_protocol.go:214`、`controller/responses_websocket.go:110`、`service/auth_session.go:451` | 邮件/任务/会话签发等其它限流 |
| `controller/relay.go:324`（Midjourney 分组饱和 code=30）、`controller/video_proxy.go:305`、`service/task_polling.go:713` | 上游 429 的语义映射/透传 |

**没有任何配额路径使用 429**；`setting/` 与环境变量中也没有"配额超限返回码"这类开关（全仓 `grep '"429"' setting/ common/ relaykit/` 无命中）。

**(5) 渠道级 `status_code_mapping` 也救不了**

`service/error.go:140-164` `ResetStatusCode` 可以把状态码映射成别的值（例如 429），但它只在 relay handler 内部、针对**上游/转发失败**调用（`relay/compatible_handler.go:166`、`relay/claude_handler.go:143` 等）。配额错误在 `PrepareRequestBilling` 阶段就返回（`controller/relay.go:128-130`），**早于** handler，不经 `ResetStatusCode`；鉴权 401 更是中间件直接 `Abort`。

**(6) 附带坑：信任额度旁路（会让"越界"延后一次请求才暴露）**

`common/quota.go:3-5` `GetTrustQuota()` 硬编码返回 `10 * QuotaPerUnit`（**无环境变量开关**）；`service/billing_session.go:316-340` `shouldTrust`：当令牌剩余额度与用户余额都大于该阈值时，**完全跳过预扣**（`effectiveQuota = 0`），请求照常发出，结算阶段 `DecreaseTokenQuota`/`DecreaseUserQuota` 不做钳制（`service/quota.go` `PostConsumeQuota` 路径，余额可为负）。结果：大额令牌超限时**当次请求不会报错**，而是把余额扣成负数，**下一次**请求才因 `RemainQuota <= 0` 拿到 401。

### 对本场景的含义（需求 #3）

- agent 侧基于 429 的 `rate_limited, retryable` 分类**不会被触发**；配额耗尽会被 agent 当作「凭据错误」（401 + "Invalid token"）。
- 更危险的是语义混淆：**401 无法区分"key 被吊销/不存在"与"配额耗尽"**，403 无法区分"模型白名单拒绝/分组不许可"（`middleware/distributor.go:87-118` 也是 403）与"额度不足"（只能靠 `error.code` 字符串区分：`insufficient_user_quota` / `pre_consume_token_quota_failed`）。
- 若坚持 new-api，必须在 agent 侧显式改写错误分类规则（把「401 + `Invalid token`」与「403 + 上述两个 code」都归入"配额/凭据终止，不重试"），并且要接受"自动重试不会触发限流退避"这一与需求 #3 意图相反的行为；另一种做法是在网关前再加一层状态码改写组件——这会新增一个安全链路组件，与 §1 需求 #6 的"轻量"取向冲突。

---

## Q3 凭据接受通道（能否收紧到只接受 `Authorization`）

**结论：❌ 不能。** 网关硬编码了至少 6 类凭据通道（7 种取值写法），全部在 `middleware/auth.go` 的 `TokenAuth` 内，`setting/`、环境变量、插件系统都没有可用于关闭它们的开关。选型文档 §1 需求 #5 在 new-api 侧**无法满足**。

### 证据

`middleware/auth.go:361-406` `TokenAuth`（relay 全部路由的第一道鉴权，见 `router/relay-router.go:21-23` 与 `:71-74`）：

| # | 通道 | 位置 | 生效条件 |
|---|---|---|---|
| 1 | `Authorization: Bearer <key>` | `middleware/auth.go:387-391` | 通用 |
| 2 | `Authorization: <key>`（**无 Bearer 前缀也接受**） | `middleware/auth.go:389-391` + `:400-404`（只有匹配到 `Bearer `/`bearer ` 才剥前缀，否则整串当 key） | 通用 |
| 3 | `Sec-WebSocket-Protocol: openai-insecure-api-key.<key>` | `middleware/auth.go:363-364` → `:482-501` | 通用（`TokenAuth` 第一行就把该子协议写进 `Authorization`） |
| 4 | `x-api-key: <key>` | `middleware/auth.go:365-371` | 路径含 `/v1/messages` 或 `/v1/models` |
| 5 | query `?key=<key>` | `middleware/auth.go:372-379` | 路径为 `/v1/models`、`/v1beta/models*`、`/v1beta/openai/models`、`/v1/models/*` |
| 6 | `x-goog-api-key: <key>` | `middleware/auth.go:381-385` | 同 5 |
| 7 | `mj-api-secret: <key>`（`Authorization` 为空或等于字面量 `midjourney-proxy` 时回退） | `middleware/auth.go:392-399` | 通用 |

这些通道还被用于**协议判定**，进一步固化：`router/relay-router.go:27-30` 根据 `x-api-key`+`anthropic-version`、`x-goog-api-key`、query `key` 决定 `/v1/models` 返回 Anthropic / Gemini / OpenAI 三种不同响应格式。

**没有开关**：

- `setting/` 全部子目录中不存在凭据来源相关选项（令牌相关配置只有 `MaxUserTokens`，`setting/operation_setting/token_setting.go`）；
- `common/init.go:90-230` 的环境变量全量清单中无相关项；
- 插件系统**不能**作为救济：JS 插件只注册固定的 host 协议路由（`router/task-plugin-protocol-router.go:14-22`，`openai_responses.create` / `openai_video.create` 等），是"独占路径"的扩展点，不是通用请求前置钩子；`middleware/task_plugin.go` 仅在已匹配插件路由时参与。

**额外的收紧缺口（本场景应视为风险面）**：

- `middleware/auth.go:288-296` `TokenAuthReadOnly`（`/api/usage/token/`、`/api/log/token`）只要 `Authorization` 非空即可，且**不校验令牌状态、过期与额度**（注释第 284-287 行明确说明），仅拒绝 `status == disabled`；
- `middleware/auth.go:397-403` 查表用的是 `parts[0]`：`Authorization: <合法key>-anything` 会被截断到首个 `-` 之前的片段再查表（该机制本意是 `<key>-<channelId>` 指定渠道，仅管理员生效，见 `middleware/auth.go:506,536-552`），因此凭据匹配并不要求整串精确一致。

### 对本场景的含义（需求 #5）

- 无法让网关"显式拒绝其它凭据通道"。要满足 topology §4-L7，只能在 Traefik（或新增的侧车/插件）侧做「删除/拒绝 `x-api-key`、`x-goog-api-key`、`mj-api-secret`、`Sec-WebSocket-Protocol` 子协议，并拒绝带 `?key=` 的请求」这类前置策略；Traefik 标准中间件可做请求头删除，但**没有原生能力拒绝特定 query 参数**（需要插件/自定义中间件）。
- 若只做"删除非 Authorization 头"而不拒绝，攻击面并未完全关闭：容器内进程仍可通过 query `key` 或 WS 子协议出示凭据。→ 结论是：**选 new-api 会把需求 #5 的强制点从网关外移到我们自己的 L7 组件，并引入一个新的自研过滤层**（与选型文档"#5 是所有候选都不能开箱满足"的判断方向一致；本文只对 new-api 下结论，不对其它候选的可收紧程度做判断）。
- 另需注意：即便只走 `Authorization`，new-api 也接受**无 Bearer 前缀**的裸值，必要时在 Traefik 侧一并做格式校验（`^Bearer ` 前缀强制）。

---

## Q4 用量/消费记录的程序化查询

**结论：✅ 有，且足够做"网关侧用量 ↔ 业务侧记账"对账。** 管理面可按时间范围拉明细与聚合；令牌侧也能自查。唯一结构性限制：**明细筛选只支持 `token_name`（非唯一）**，不支持 `token_id`。

### 证据

**(1) 管理面明细：`GET /api/log/`（AdminAuth）**

`router/api-router.go:312` + `controller/log.go:13-38` `GetAllLogs`，查询参数：

```
p / page_size（common.GetPageQuery，common/page_info.go:41-70，兼容 ps / size）
type              日志类型：2=消费、1=充值、6=退款 …（model/log.go:85-92）
start_timestamp / end_timestamp   （Unix 秒）
username / token_name / model_name / channel / group / request_id / upstream_request_id
```

返回 `Log` 明细分页（`model/log.go:59-83`）：`created_at, type, quota, prompt_tokens, completion_tokens, model_name, token_name, token_id, channel, group, request_id, upstream_request_id, use_time, is_stream, other`。→ **`request_id` 可用于与 agent 侧 `onUsage` 逐条对齐**。

聚合：`GET /api/log/stat`（`router/api-router.go:313` + `controller/log.go:103-128`）在相同筛选下返回 `{quota, rpm, tpm}`。

**(2) 管理面日聚合：`GET /api/data/`、`/api/data/users`（AdminAuth）**

`router/api-router.go:336-341` + `controller/usedata.go:31-58`，落在 `quota_data` 表，按 `model_name, created_at` 分组并 `sum(quota)/sum(count)/sum(token_used)`（`model/usedata.go:173-183`）。注意用户自助版本 `GET /api/data/self` 有 **1 个月跨度上限**（`controller/usedata.go:63-76`），管理面 `/api/data/` 无此限制。

**(3) 令牌侧自查（无需管理凭据）**

- `GET /api/usage/token/`（`router/api-router.go:287-293`，`TokenAuthReadOnly`）→ `controller/token.go:229-276` `GetTokenUsage`：返回 `object=token_usage, total_granted, total_used, total_available, unlimited_quota, model_limits, model_limits_enabled, expires_at`。**是累计值，无时间范围**。该 handler 自己另解析 `Authorization`，要求严格的 `Bearer <x>` 两段式（`controller/token.go:230-240`），比 `TokenAuth` 更严。
- `GET /api/log/token`（`router/api-router.go:343-345`，`TokenAuthReadOnly`）→ `controller/log.go:79-101` `GetLogByKey`：返回该令牌**最近 1000 条**日志（`model/log.go:140-148`，`common/constants.go:60 MaxRecentItems = 1000`），按 id 倒序，**无时间范围/分页参数**。

**(4) 限制与注意事项**

- 明细筛选**只认 `token_name`**（`controller/log.go:19`；`model/log.go:478-480` `logs.token_name = ?`），`Log` 表有 `token_id` 列与索引（`model/log.go:71`）但**没有对应的查询参数**（`model/log.go:464` `GetAllLogs` 签名中无 tokenId）。→ 对账方案：portal 强制 `token_name` 唯一（如 `fde@client/project`），或在客户端按响应里的 `token_id` 二次过滤。
- `/api/log/search`、`/api/log/self/search` 已废弃（`controller/log.go:64-77`，直接返回 `该接口已废弃`），不要使用。
- 日志存储可分离：主库支持 SQLite/MySQL/PostgreSQL，日志库可另配 ClickHouse（`AGENTS.md`「Tech Stack」），`common.UsingLogDatabase(common.DatabaseTypeClickHouse)` 影响分页/排序实现（`model/log.go:140-145,466-470`）。

### 对本场景的含义（需求 #4）

- 对账可行：portal 用 PAT 调 `GET /api/log/?type=2&start_timestamp=..&end_timestamp=..&token_name=..&page_size=..` 拉明细，按 `request_id` 与 agent `onUsage` 对齐；用 `GET /api/log/stat` 或 `/api/data/` 做日粒度费用核对。
- 差异来源仍如选型文档所述（judge/fold 额外调用），且**免费模型跳过计费**（`relay/request_billing.go:61-63`）与"信任旁路不预扣但最终结算"会让"实时余额"与"已消费"存在窗口差；对账应以日志明细为准，而不是读 `remain_quota` 快照。
- 需要 portal 侧维护 `token_name → binding` 唯一映射；这是新增的少量约定成本。

---

## 对照选型文档的验证清单（§5.2 三项待实测项的源码层判定）

选型文档 §5.2 要求"选择 new-api 之前必须实测"三项。本次为源码级判定（未运行时实测），判定如下：

| §5.2 待实测项 | 源码层判定 | 依据与结论 |
|---|---|---|
| **① 额度超限的 HTTP 状态码是否 429** | ❌ **不达标（源码层已可定论，无需实测）** | 令牌已耗尽/过期 → `401` + `{"error":{"message":"Invalid token","type":"new_api_error","code":""}}`（`model/token.go:220-251` + `middleware/auth.go:410-421` + `middleware/utils.go:14-32` + `i18n/locales/en.yaml:47`）；本次预扣不足 → `403` `code=pre_consume_token_quota_failed`（`service/billing_session.go:207-211`、`service/quota.go:396-411`）；用户余额/订阅不足 → `403` `code=insufficient_user_quota`（`service/billing_session.go:388-400`、`relaykit/types/error.go:86`）。429 只用于请求次数限流与上游透传，配额路径无 429，且无配置可改（`service/error.go:140-164` 的 `status_code_mapping` 只作用于 handler 内错误）。→ **agent 侧 `rate_limited, retryable` 无法按设计触发**；按选型文档 §6-2 回退规则「任一不达标即回退 LiteLLM」，此项即触发回退条件。 |
| **② admin API 建/吊销 key 的脚本化可行性** | ⚠️ **可行但不是一等公民**（自动化需要绕过 3 个摩擦点） | 建：`POST /api/token/`（`router/api-router.go:280`），但**响应不含 id/key**（`controller/token.go:355-358`），需 `GET /api/token/search` + `POST /api/token/:id/key`（或 `POST /api/token/batch/keys`，≤100）两段式；吊销：`DELETE /api/token/:id`、批量 `POST /api/token/batch`；鉴权：PAT（`Authorization: Bearer <PAT>`），但 **PAT 不能自举**——`POST /api/user/token` 需要登录会话 + 密码型 `X-Security-Proof`（`controller/access_token.go:24-49`、`middleware/secure_verification.go:39-49`、`docs/authentication.md`「PAT 调用契约」），portal 必须长期持有账号口令；令牌接口全部 user-scoped、无 admin 代建他人令牌（`controller/token.go:333`）；额度还需另调 `POST /api/user/manage` 给用户充值（`service/billing_session.go:388-400`）。→ **可以脚本化，但编排步骤多、依赖口令、且没有"参数即业务概念"的 admin 契约**；对比 LiteLLM `/key/generate`（返回 key、admin 可代建、`budget`/`models`/`alias` 直给）差距明显。 |
| **③ v1.0 定稿时间 / 接口漂移风险** | ❌ **风险已被证实为现实**（rc 期间接口仍在变，且文档已落后） | 仍无 v1.0.0 正式版：最新 `v1.0.0-rc.37`（2026-09-11），rc 起点 `v1.0.0-rc.1`（2026-04-29），累计 **65 个 rc tag**，最近 6 周发了 **15 个 rc**（rc.23 08-01 → rc.37 09-11，约 2~3 个/周）；HEAD 在 rc.37 之后 **4 天内又有 25 个 commit**。漂移实例：**rc.1 的 `docs/openapi/api.json` 要求 `New-Api-User` 头且以 session cookie 为主鉴权**（`securitySchemes.NewApiUser1.description` = "必须提供"），**HEAD 已改为 PAT、不再要求 `New-Api-User`、并新增 `docs/authentication.md`**（rc.1 中该文件不存在），文档里明写"升级注意事项：旧 session Cookie 不再使用；升级后现有面板登录会失效"——**正是 portal 依赖的那层接口**。此外当前 OpenAPI 文档已落后实现：token/log/data 三组中 7 条在册路由缺失（含必需的 `POST /api/token/{id}/key`、`POST /api/token/batch/keys`），并仍描述 2 条已废弃接口（`controller/log.go:64-77`）；CI 无文档一致性校验。→ **选择 new-api 意味着把接口漂移成本转嫁到我们的 onboarding/offboarding 编排上**，每次升级都要回归这条 5~6 步的鉴权+令牌链路。 |

### 汇总判断（供选型文档 §5 参考，本文不代改）

- 三项中 **①（429）与 ③（v1.0 定稿风险）为不达标/已证实风险**，② 为"可行但摩擦大"。
- 按选型文档 §6-2（建议第 2 条）的规则「任一不达标即回退 LiteLLM」，**源码层证据已经构成回退理由**，无需先做实测；若仍要保留 new-api 作为轻量替代，需要同时接受：(a) agent 侧自定义错误分类，(b) 自建/外置 L7 凭据通道过滤（需求 #5），(c) 每次升级回归鉴权与令牌编排。

---

## 未确认项与线索（不做无证据推断）

1. **运行时行为未实测**：分析环境无 Go 工具链（`go` 不存在）、docker daemon 无权限（`permission denied ... /var/run/docker.sock`），因此 401/403 的实际线上表现、以及 Redis 开启/关闭两种拓扑下的一致性未做验证。线索：Redis 与非 Redis 下 `ValidateUserToken` 的判定条件相同（`model/token.go:220-251`，仅状态回写分支不同），预扣路径有降级与补偿逻辑（`model/quota_reserve.go:203-240`）。
2. **是否存在第三方/环境变量可强制"配额 429"**：未发现。线索：非测试代码中全部 `http.StatusTooManyRequests` 出现点已逐条归类（见 Q2 证据 (4)）；`grep '"429"' setting/ common/ relaykit/` 无命中。
3. **是否存在"系统 token / 静态管理凭据"旁路**：未发现。线索：`common/init.go:90-230` 环境变量清单与 `docs/authentication.md` 的鉴权模型（JWT / PAT / Refresh Cookie / Security Proof）均无此项。
4. **插件系统能否充当凭据过滤钩子**：判断为不能。线索：插件路由由 host 协议表驱动、按独占路径注册（`router/task-plugin-protocol-router.go:14-22` + `pkg/jsplugin/routing.go`），未见通用请求前置钩子；如需最终确认需在启用 `TASK_PLUGIN_ENABLED=true` 的环境做一次实测。
5. **跨版本细节**：本文只针对 commit `69a5002`。若 P3 采纳 new-api，建议钉住 tag 并在升级前重复本报告的 Q1/Q2 检查项（尤其 `POST /api/token/` 的响应体与 `TokenAuth` 的凭据通道列表）。

## 附：证据复核指引

```bash
# 复现本文分析对象
git clone --depth 50 https://github.com/QuantumNous/new-api.git ~/projects/.research/new-api
git -C ~/projects/.research/new-api rev-parse HEAD   # 69a50029819a26c53e6babd276d49cfe2f8880ad
```

- 令牌路由：`router/api-router.go:271-284`
- 凭据通道：`middleware/auth.go:361-406`（+ `:288-296` 只读版；WS 子协议入口 `:363-364,482-501`）
- 401 判定：`model/token.go:220-251`、`middleware/auth.go:410-421`、`i18n/locales/en.yaml:47`
- 403 判定：`service/billing_session.go:207-211,228-240,388-400`、`service/quota.go:396-411`
- 429 归属：`middleware/rate-limit.go:135-144`、`middleware/model-rate-limit.go:95,119`
- 令牌字段：`model/token.go:14-30,338-352`；创建响应：`controller/token.go:278-359`
- PAT 自举：`controller/access_token.go:24-49`、`middleware/secure_verification.go:39-49`、`docs/authentication.md`
- 用量接口：`controller/log.go:13-38,79-101,103-128`、`controller/token.go:229-276`、`controller/usedata.go:31-58`
- 文档漂移：`docs/openapi/api.json`（对比 `router/api-router.go:271-345`）
