# LLM 网关选型（选型支撑材料）

> 状态：**草案（Q1 决策支撑；选型未定稿）**
> 依据：2026-09-16 活跃度核查（GitHub API）+ searxng 调研。
> 上游规格：[`fde-platform.md`](../fde-platform.md) §11（模式 C 已定稿，Q1 选型待决）；安全硬约束以 [`topology.md`](../topology.md) §4-L7 为准。本文不改变任何规格，只承载选型分析。

---

## 1. 本场景的硬需求（选型准绳）

来自 `fde-platform.md` §11 与 `topology.md` §4-L7，任何候选必须全部满足或可验证满足：

| # | 需求 | 来源 |
|---|---|---|
| 1 | OpenAI 兼容 API（agent 侧只改 baseURL，零改造） | §11.2 |
| 2 | **admin API 可编程**：portal 在 onboarding/offboarding workflow 中自动建/吊销虚拟 key（额度 + 模型白名单 + 别名 `alice@client-x`）——人只看报表，不做手工 key 管理 | §11.3 |
| 3 | 额度控制，超限返回 **429**（agent 侧依赖 `rate_limited, retryable` 分类，且须避免自动重试继续烧配额） | §11.4 |
| 4 | 用量可编程拉取（与 agent `onUsage` 上报对账，差异来自 judge/fold 额外调用） | §11.4 |
| 5 | **只接受 Traefik 注入的 `Authorization` 头**，显式拒绝其它凭据通道（`X-API-Key` / HTTP Basic / cookie / query token）——否则容器可绕过「来源子网 → 身份」判定直接出示凭据 | topology §4-L7 |
| 6 | 部署形态：`backend` 网络容器（172.30.0.0/24），数据面经 Traefik 回环 `127.0.0.1:4000`，**admin 面不发布** | topology §2 |

> 注意 #5 是唯一一个**所有候选都不能开箱满足**的点，无论选谁都要逐个验证配置可行性，列入 P3 验收清单。

## 2. 本场景的两个特殊性（影响权重）

1. **portal 自动化是刚需，Web UI 是摆设**。key 的建/吊销全在 onboarding/offboarding workflow 里程序调用；因此「admin API 是否一等公民（独立文档、稳定语义）」权重最高，而「后台好不好用」权重接近零。
2. **本架构削弱了「分发」类卖点**。容器内零凭据，真实 key 只存在于宿主 Traefik 动态配置（600）——分发面极小，「key 二次分发 / 渠道运营」类能力价值不大；反而「按 FDE / 按客户项目归集成本」的记账层级是每天都要用的（`usage_ledger` 业务口径，网关不知道这层映射，§11.3）。

## 3. 候选活跃度核查（2026-09-16，GitHub API）

**维护活跃度是安全链路组件的准入条件，不是加分项。** 数据如下：

| 项目 | Stars | 最后 push | 最新 release | 判定 |
|---|---|---|---|---|
| [LiteLLM](https://github.com/BerriAI/litellm) (BerriAI) | 58.9k | 2026-09-16（当日） | v1.101.0（2026-09-15） | ✅ 活跃 |
| [new-api](https://github.com/QuantumNous/new-api) (QuantumNous) | 48.2k | 2026-09-15 | v1.0.0-rc.37（2026-09-11） | ✅ 活跃（v1.0 尚在 rc） |
| ~~[one-api](https://github.com/songquanpeng/one-api)~~ (songquanpeng) | 36.9k | **2026-01-09（8 个月前）** | v0.6.10（**2025-02-02，19 个月前**） | ❌ 实质停更，**淘汰** |
| ~~[one-hub](https://github.com/MartialBE/one-hub)~~ (MartialBE) | 2.9k | **2026-02-19（7 个月前）** | v0.14.27（**2025-12-06，9 个月前**） | ❌ 实质停更，**淘汰** |

淘汰理由：

- **one-api**：star 存量（36.9k）是一次性热度；代码 8 个月未动、release 断更 19 个月。网关的核心职责之一是对接上游模型 API 的持续变化（新模型适配、上游格式变更），停更意味着该能力归零。
- **one-hub**：本体即 one-api 的 fork，上游停更后自身也 7 个月未 push；社区规模小（2.9k），安全补丁响应能力存疑。作为凭据管理组件不可接受。

**候选集收敛为：LiteLLM vs new-api。**

## 4. LiteLLM vs new-api（两强对比）

| 维度 | **LiteLLM** | **new-api** |
|---|---|---|
| 语言/部署 | Python；**生产必须 Postgres**（SQLite 下 budget 扣减有并发竞态，官方亦不推荐） | Go 单二进制 + SQLite/MySQL，**部署更轻** |
| OpenAI 兼容 | ✅ 主卖点，140+ provider / 1800+ 模型，新模型 day-0 支持 | ✅ 且额外支持 Claude / Gemini 格式互转 |
| **key 生命周期 admin API** | ✅ **一等公民**：`/key/generate` 等完整 REST CRUD，独立文档，参数即业务概念（budget、models、alias），天然匹配 portal 自动化（需求 #2） | ⚠️ 有 API 但以 Web UI 为中心；**v1.0 未定稿（rc.37）**，接口漂移风险，自动化需实测（**已源码级验证：⚠️ 摩擦大，见 §5.1 Q1**） |
| 额度模型 | budget 体系（key / team / user 三级），超限返回 **429**——与需求 #3 直接对齐 | quota 预充值制（按 token 扣）；超限 HTTP 状态码**需实测**（**已源码级验证：❌ 非 429，见 §5.1 Q2**） |
| 记账层级 | spend 自动落 Postgres，按 key / user / team 归集——**正好匹配「按 FDE / 按客户项目归集成本」**（§11.3） | 内置计费，粒度可满足；差异化能力（阶梯定价、支付）面向对外售 key 场景，**本场景用不上** |
| key 级模型白名单 | ✅ key 上直接挂 `models` 列表 | ✅（令牌限模型） |
| 差异化卖点 | 企业网关（SSO、guardrails、MCP 接入） | 商业化运营（订阅套餐、支付、看板）——本场景不需要 |

## 5. new-api 源码级验证结论（2026-09-16）

> 对 [`new-api`](new-api-api-analysis.md) commit `69a5002`（main，2026-09-15）的只读源码分析；所有结论带文件:行号，可复核。完整报告见 [`new-api-api-analysis.md`](new-api-api-analysis.md)。

### 5.1 四个问题速览

| 问题 | 判定 | 结论 |
|---|---|---|
| Q1 key 生命周期 admin API | ⚠️ | 令牌 CRUD 齐全（`/api/token/*`，PAT 鉴权），但非一等公民：**PAT 不能自举**（签发需登录会话 + 密码型 Security Proof，portal 须长期持账号口令）；**创建接口不返回 id/key**（需 search + `/{id}/key` 两段式，逐个取 key 还撞 IP 限流）；**全部 user-scoped**（无 admin 代建他人令牌）；OpenAPI 文档落后实现（7 条路由缺失、2 条已废弃仍在线） |
| Q2 额度超限状态码 | ❌ | **不是 429**：令牌耗尽/过期 → **401** + `Invalid token`（与 key 吊销同响应，agent 会误判为凭据错误）；预扣不足 → **403** `pre_consume_token_quota_failed`；用户余额不足 → **403** `insufficient_user_quota`。429 只属于接口限流与上游透传，**配额路径无 429 且无配置可改**（`status_code_mapping` 不作用于预扣阶段） |
| Q3 凭据接受通道 | ❌ | **硬编码 6 类通道**（`Authorization` 裸值也收、`x-api-key`、query `?key=`、`x-goog-api-key`、`mj-api-secret`、WebSocket 子协议），`setting/` 与环境变量**均无开关可收紧**——需求 #5 在 new-api 侧无法满足，除非自建 L7 过滤层 |
| Q4 用量查询 API | ✅ | `GET /api/log/`（时间范围 + `request_id` 可与 `onUsage` 逐条对齐）+ `/api/log/stat` + `/api/data/`；注意明细筛选只认 `token_name`（非唯一），需 portal 强制命名唯一 |

### 5.2 对验证清单的判定

| 选型 §5 第 2 条待实测项 | 源码层判定 |
|---|---|
| ① 额度超限是否 429 | ❌ 不达标（源码已可定论，无需实测） |
| ② admin API 脚本化 | ⚠️ 可行但摩擦大（5~6 步编排 + 依赖口令 + 无稳定契约） |
| ③ v1.0 定稿风险 | ❌ **已证实为现实**：65 个 rc、近 6 周 15 个 rc；rc.1→HEAD **鉴权契约被重写**（session cookie → PAT）；HEAD 在 rc.37 后 4 天又 25 个 commit |

附带发现：**信任额度旁路**（`GetTrustQuota` 硬编码，余额充足时跳过预扣、结算可扣成负数）——大额令牌超限时当次请求不报错，越界延后一次请求才暴露。

### 5.3 裁决

按 §6 第 2 条「任一不达标即回退 LiteLLM」：①③双不达标，**new-api 出局**（见 §6 第 2 条修订）。若未来 v1.0.0 正式版变更配额状态码行为，凭完整报告的复核指引重评。

## 6. 建议

1. **默认 LiteLLM**。四项硬需求（#1/#2/#3/#4）原生命中、无改造；admin API 稳定性对 portal 自动化最友好；记账层级与 `usage_ledger` 业务口径天然衔接。Postgres 依赖在 backend 栈内不是新增运维模式。
2. ~~**new-api 保留为轻量替代**~~ → **2026-09-16 源码级核实后出局**（§5，报告：[`new-api-api-analysis.md`](new-api-api-analysis.md)，commit `69a5002`）。三项实测在源码层已可定论：**① 额度超限返回 401/403 而非 429**（配额路径无 429 且无配置可改，agent 侧 `rate_limited` 分类无法触发）；**③ rc 期间鉴权契约已被重写**（session→PAT，65 个 rc，OpenAPI 文档落后实现）——两项不达标，触发本条回退规则；另发现**凭据通道硬编码 6 类且无开关收紧**（需求 #5 无法满足，除非自建 L7 过滤层）。new-api 降级为「不推荐」；若未来 v1.0.0 正式版变更配额状态码行为，可凭该报告的复核指引重评。
3. **one-api / one-hub 从选型清单删除**（§3 依据），Q1 讨论不再列入。**候选收敛结果：默认且唯一推荐 LiteLLM**（待 Q1 确认公司是否已有网关）。

## 7. 与待决问题 Q1 的关系

- **Q1（公司是否已有统一 LLM 网关）有答复后本文才定稿**：
  - 已有 → 直接对接现有网关，本文仅作为「拒绝自研、拒绝停更项目」的依据存档；portal 侧租户绑定（建/吊销 key、拉用量）按现有网关的 admin API 实现
  - 没有 → 按本文 §5 选型（默认 LiteLLM），起网关容器进 `backend` 网络，仍走模式 C
- 选型落地时须同步：`fde-platform.md` §11.3（选型结论）、`topology.md` §2（网关行补容器名）、P3 里程碑验收清单（§1 需求 #5 的专项验证项）

## 附：调研来源

- LiteLLM：[Virtual Keys](https://docs.litellm.ai/docs/proxy/virtual_keys) · [Budgets, Rate Limits](https://docs.litellm.ai/docs/proxy/users) · [官网](https://www.litellm.ai/)
- 对比参考：[One API vs New API vs 自建（知乎，2026-06）](https://zhuanlan.zhihu.com/p/2045813049257350038) · [Open Source LLM Gateways Compared（2026-03）](https://blog.openziti.io/comparing-open-source-llm-gateways)
- 活跃度数据：GitHub REST API `GET /repos/{owner}/{repo}` 与 `/releases/latest`，查询日期 2026-09-16
