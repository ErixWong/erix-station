# 文档地图与待补齐清单

> 本文件是**给实现者（人或 agent）的入口**：现有文档在哪、还缺什么、每份缺的文档必须包含什么。
>
> 补齐原则：**规格与原理已定，补齐的是「契约细节」和「环境事实」，不是重新设计。**
> 推导未覆盖场景时读 [`design/principles.md`](design/principles.md)；与其冲突时以规格为准并提 issue。

---

## 一、现有文档

| 文档 | 内容 | 状态 |
|---|---|---|
| [`../README.md`](../README.md) | 项目定位、三条不变式 | ✅ |
| [`../AGENTS.md`](../AGENTS.md) | 项目特有规则（边界/结构/端口/流程/已定决策） | ✅ |
| [`design/fde-platform.md`](design/fde-platform.md) | **主规格**：拓扑、网络与隔离、访问控制、账号生命周期、端口分配、数据模型、事件流、LLM 接入、容器模板、部署、分期、决策 D1~D10 | ✅ |
| [`design/topology.md`](design/topology.md) | **H-B 网络与访问拓扑定稿（单一事实来源）**：拓扑、IPAM、链路 L1–L10、路由模型、加固清单、连通矩阵、reconciler 职责、实测证据（决策者 2026-09，issue #5） | ✅ |
| [`design/principles.md`](design/principles.md) | **设计原理**：五条核心原理、规则对照、被否决方案、未决问题决策框架、实现者硬约束 | ✅ |
| [`design/runner-integration.md`](design/runner-integration.md) | **runner 集成契约（WP3b）**：agentd/worker 职责、IPC 信封、租约/心跳/事件批、终态收敛、erix-agent `runToolLoop`/`TranscriptStore` 锚点（v0.9.0，§9.1 八方法） | ✅ |
| [`design/conversation-state.md`](design/conversation-state.md) | **会话状态模型（issue #77）**：三层生命周期（执行/会话/工作区）、session-scoped transcript 目标态、引擎现状源码核对、pi 参照系、P0–P3 分阶段实施、红线与验收口径 | ✅（设计定稿待实施） |
| [`design/directory-as-project.md`](design/directory-as-project.md) | **去项目化：目录即项目（P5）+ 文件面板（P6）**：sessions.cwd 化、端口去项目化（`eric-p-<port>`）、同项目并行放行（pi 对齐不锁）、UI 定稿布局、materializer 退役、迁移与部署序 | ✅（设计定稿待实施） |
| [`design/audit-2026-09-16.md`](design/audit-2026-09-16.md) | **设计文档集一致性审计（2026-09-16）**：58 条发现 + 修复处置记录（issue #21） | ✅ |
| [`design/user-space.md`](design/user-space.md) | **用户空间物化契约（阻塞 P1 开工，issue #7）**：宿主↔portal↔FDE 容器路径映射、文件清单与 JSON schema、原子写 + manifest 多文件一致性、UID/权限、失败重试状态机、变更感知、重建幂等、项目目录归属 | ✅ |
| [`design/deploy-contract.md`](design/deploy-contract.md) | **P1 部署契约**：服务清单与镜像 pin、compose 字段（网络/publish/volume/healthcheck/env_file）、DB 迁移机制、Traefik 静态/动态配置、防火墙应用方式（iptables-nft 幂等 + fail-closed）、socket-proxy 白名单策略、FDE 容器创建参数、P1 范围声明、readiness 语义 | ✅ |
| [`design/llm-gateway/llm-gateway-selection.md`](design/llm-gateway/llm-gateway-selection.md) | **LLM 网关选型支撑（Q1/Q7 决策材料）**：本场景硬需求准绳、候选活跃度核查（one-api / one-hub 因停更淘汰）、LiteLLM vs new-api 源码级对比；**结论：LiteLLM 默认且唯一推荐（new-api 源码级验证出局），Q1（公司是否已有网关）待定**，剩 P3 实测项 | ✅（选型材料定稿；Q1 待公司确认） |
| [`design/llm-gateway/new-api-api-analysis.md`](design/llm-gateway/new-api-api-analysis.md) | **new-api 源码分析（选型证据）**：new-api 的路由/凭据/转发实现与 LiteLLM 对比要点（出局原因佐证） | ✅ |
| [`data/bootstrap.sql`](data/bootstrap.sql) | **生产附加初始化**：角色幂等声明 + 库/schema 级授权 + ownership 归正（schema.sql **之后**执行，可重复；自包含不建业务表，不含 admin/LLM 种子） | ✅ |
| [`charts.zh.md`](charts.zh.md) / [`charts.en.md`](charts.en.md) | **架构总览图表（中/英，可直接外发评审）**：拓扑图、请求链路、信任边界与凭据红线一页图；另附**宿主收紧原理**（容器为何摸不到宿主服务：INPUT + DOCKER-USER 两层、fail-closed、不锁管理通道）与**网络与安全评审说明**（常见追问逐条作答；含两条提请评审拍板的开放项）。两份均为自包含文件，不含任何内部引用 | ✅ |
| [`env.md`](env.md) | **部署参数清单**：参数定义 + 参考实例 A + 目标环境探测 checklist（非单机环境事实） | ✅ |
| [`api/portal.md`](api/portal.md) | **portal API 契约**：认证、端点请求/响应 schema、SSE 事件信封类型清单、错误语义 | ✅ |
| [`data/schema.sql`](data/schema.sql) | **可执行建表 DDL**：约束/索引/外键齐全，postgres:16 空库实测 `psql -f` 可执行 | ✅ |
| [`data/model.md`](data/model.md) | **数据模型说明**：表用途、字段语义、状态机、三份数据边界、归档与记账口径 | ✅ |
| [`testing.md`](testing.md) | **测试与验收契约（D5）**：测试分层与命令表、隔离约定（路径注入/临时栈/伪造 FDE 容器）、必测清单（网络隔离/认证/文件物化/崩溃恢复/路由发布/API 契约/浏览器验证）、验收判定与门禁、已知不可测项 | ✅ |
| [`ops/deployment-2026-10-10.md`](ops/deployment-2026-10-10.md) | **实际部署成了什么样**（与 `design/deploy-contract.md` 的「应该是什么样」对照）：服务/镜像/端口/凭据与已接受偏差 | ✅ |
| [`ops/ci-release.md`](ops/ci-release.md) | **CI 与 GHCR 发布 runbook（#235）**：质量门禁口径、分钟预算语义、发布→部署的 digest pin、测试基线数字的同步义务 | ✅ |
| [`ops/drill-2026-10-12.md`](ops/drill-2026-10-12.md) | **平台演练记录 ②（2026-10-12 夜班）**：v0.1.3 发布与按 digest 部署（imageId/repoDigest 双校）、新工位 `todo` 开户全链、平台 agent 交付前后端分离 to-do 的浏览器真机结论，**预览域名下跑通一个普通前后端分离应用的 6 条要求链（3 条未告知 → #257/#258）**，单 B 预览端口 UI 真机验收，新一批操作坑 | ✅ |
| [`ops/drill-2026-10-11.md`](ops/drill-2026-10-11.md) | **平台演练记录（#235/#240/#241/#242/#246/#249/#250/#252 的汇流）**：开户→登录→平台自己的 agent 写前后端分离应用→预览域名跑通的全链路与断点定性；CORS 预检误诊链、号池与改块口径的三次认知纠正、可复制操作手册、踩坑清单、issue 台账 | ✅ |

---

## 二、待补齐文档

> 每项给出「必须包含」与「验收标准」。**未决问题未定时，先按 `principles.md §4` 的当前倾向写，并显式标注 `⚠️ 待决策者确认`**——不要留空，也不要自行改变设计。

### D1. `docs/env.md` —— 部署参数清单（原「环境事实清单」）✅ 已完成

> **状态**：✅ 已完成，交付于 [`env.md`](env.md)。实际定位为「参数清单 + 参考实例 A + 目标环境探测 checklist」，**不是单机环境事实**。以下「必须包含 / 验收 / 依赖」保留作验收依据。

**为什么**：规格全文用 `<base>` 等占位符；没有环境事实就写不出能跑的 Traefik / compose 配置。

**必须包含**：
- base domain；portal 域名（`station.<base>`）与预览域名（`*.fde.<base>`）
- DNS 泛解析能力；证书方式（Let's Encrypt DNS-01 / 内部 CA / 自签）
- 网络可达性：是否 VPN-only；公司出口是否有正向代理（会影响安全团队出口策略的落地方式，issue #3）
- 宿主机：CPU / 内存 / 磁盘；Docker 版本；是否已有 Portainer（是）
- SSO：OIDC provider 的 issuer / client 注册方式 / group claim 名称；或「先用本地账号」
- 端口占用现状（80/443/8080/5432 是否可用）
- 已有的命名约定（容器前缀、卷目录）

**验收**：`deploy/` 下的配置只需替换少量变量即可 `up -d`；文中不含任何形如 `<待定>` 的占位。

**依赖**：无（但需要用户/运维提供事实）

---

### D2. `docs/api/portal.md` —— portal API 契约 ✅ 已完成

> **状态**：✅ 已完成，交付于 [`api/portal.md`](api/portal.md)。以下「必须包含 / 验收 / 依赖」保留作验收依据。

**为什么**：没有契约，前端与后端并行必然打架。

**必须包含**：
- 认证方式（登录、session cookie 属性、forwardAuth 端点）
- 每个端点：方法、路径、请求体 schema、响应 schema、错误码
- 至少覆盖：`/api/forward-auth`、登录/登出、用户信息、项目 CRUD、会话 CRUD、`POST /api/sessions/:id/messages`、`GET /api/sessions/:id/events`（SSE，含 `Last-Event-ID` 语义）、`POST /api/sessions/:id/stop`、端口列表、工具审批
- **事件信封的完整类型清单**（对应规格 §10.1），含每种类型的字段
- 错误语义：LLM 配额耗尽（429 → `rate_limited`）、`checkpoint_failed`、容器不可达

**验收**：前端可只依据本文 + mock 数据开发；SSE 的类型清单与 spec 一致，无缺漏。

**依赖**：Q7（技术栈，影响实现但不影响契约形状）

---

### D3. `docs/data/schema.sql` + `docs/data/model.md` —— 数据模型 ✅ 已完成

> **状态**：✅ 已完成，交付于 [`data/schema.sql`](data/schema.sql) + [`data/model.md`](data/model.md)；`psql -f` 已在 postgres:16 空库实测可执行。以下「必须包含 / 验收 / 依赖」保留作验收依据。

**为什么**：规格 §9.1 是表名 + 字段草图，不是可执行 DDL。

**必须包含**：
- `schema.sql`：可执行建表语句，含主键、唯一约束（尤其 `port_allocations` 的端口唯一性）、索引、外键
- `model.md`：每张表的用途、关键字段语义、状态机（`runs.status` / `port_allocations.state` / `approvals.status`）
- **三份数据的边界说明**（messages / transcript_rounds / run_events）与「不混」的落地方式
- 归档与膨胀策略（transcript payload 很大）
- `usage_ledger` 的记账口径

**验收**：`psql -f schema.sql` 在空库可执行；状态机的每个状态都有产生与消费方。

**依赖**：Q1/Q4（影响 `usage_ledger` 粒度）

---

### D4. `docs/decisions/00N-*.md` —— ADR 拆分（中优先）

**为什么**：`principles.md §3` 已有「被否决方案」，但决策本身缺正式记录；erix 仓库有 `docs/decisions/` 惯例。

**必须包含**：把规格附录 A 的 **D1~D10** 拆成独立 ADR，每条含四段：**背景 / 决策 / 被否决的方案 / 后果**。

**验收**：D1~D10 一一对应；「被否决的方案」与 `principles.md §3` 一致。

**依赖**：无

---

### D5. `docs/testing.md` —— 测试与验收 ✅ 已完成

> **状态**：✅ 已完成，交付于 [`testing.md`](testing.md)。以下「必须包含 / 验收 / 依赖」保留作验收依据。

**为什么**：全局约定要求「语法保底 → 单测全绿 → 浏览器验证」；规格只有一行验收。

**必须包含**：
- 每个阶段的**可执行验收命令**（P1 / P2 / P3）
- 单测范围与隔离约定（涉及用户配置、容器网络的测试必须注入路径参数，不碰真实环境）
- 集成测试：如何在本地起栈、如何伪造 FDE 容器
- 浏览器验证流程（playwright 截图 → vision 读图确认），按全局 §3.2
- **安全回归用例**（必须真机验证，不能只写单测）：
  - FDE A 无法访问 FDE B 的任何端口（容器内 `curl`）
  - 未认证访问任意 `*.fde.<base>` → 403
  - 端口未分配 → 不可达
  - FDE 容器无法访问宿主机 docker（无 socket）
- `erix-agent/contract-tests` 接入方式

**验收**：每条安全回归用例都有对应命令与期望输出。

**依赖**：D1（环境事实）

---

### D6. `docs/ops/runbook.md` —— 运维手册（P2 前置）

**必须包含**：启停顺序、健康检查、DB 备份与恢复（**引用系统级备份方案，不在本项目范围**——runbook 只记录平台数据卷位置与对接点，不自行交付备份机制；决策者 2026-09，issue #3 评论）、容器升级流程（含 erix-agent 版本 pin 与 canary）、孤儿容器/端口回收、日志位置、常见故障排查（502 / 401 / 容器起不来 / 任务卡住）

**验收**：新人可照着手册完成一次「升级 erix-agent 版本并回滚」。

**依赖**：D1

---

### D7. `docs/design/discussion-archive.md` —— 讨论过程归档（低优先，可选）

**为什么**：六轮讨论的完整过程目前只在 [erix-llm-kit#24](https://git.erix.vip/eric/erix-llm-kit/issues/24)（内网）。`principles.md` 已覆盖其中的**结论与取舍**，本文只补**过程**。

**必须包含**：讨论的演进路径（每个问题是怎么被提出和收敛的）、各轮中被放弃的中间方案。

**验收**：核心结论与取舍**不重复**（已在 `principles.md`）；仅补充过程。

---

## 三、建议补齐顺序

```
✅ D1 (env) ─┬─ ✅ D5 (testing)
             └─ D6 (runbook，P2 前置)
✅ D2 (API 契约)
✅ D3 (schema)
D4 (ADR，无依赖，可随时补)
```

**最小可开工集** = **D1 + D2 + D3 + D5** —— 已就绪 ✅（P1 可开工，测试与验收契约已补齐）。下一步：D4/D6 可在 P1 期间并行补。

---

## 四、写作纪律（给 agent 的三条）

1. **不要重新设计**：规格与原理已定；未覆盖的场景按 `principles.md` 推导，推导结果与规格冲突时提 issue。
2. **不要留空**：未决问题按 `principles.md §4` 的当前倾向写，标注 `⚠️ 待决策者确认`。
3. **不要引入隐性假设**：任何环境相关的事实（域名、路径、版本、端口）必须来自 `docs/env.md`；`env.md` 没有的，先补 `env.md`。
