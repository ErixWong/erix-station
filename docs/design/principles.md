# 设计原理与取舍

> 本文回答 **「为什么这样设计」**，是 [`fde-platform.md`](fde-platform.md) 的推导基础。
>
> 分工：
> - `fde-platform.md` = **是什么**（规格：表、接口、拓扑、流程）
> - 本文 = **为什么**（原理、被否决方案、决策框架）
>
> 当规格没写到的场景出现时，**按本文的原理推导**，而不是自行发明。若推导结论与规格冲突，以规格为准并提 issue 修正本文。

---

## 1. 五条核心原理

### 原理一：容器是信任边界，不是协作单元

**陈述**：每个 FDE 一台容器，容器是安全隔离、故障隔离、资源限制、环境复现的**唯一粒度**。协作与并发的粒度则是 **worktree**，不是容器。

**为什么**：
- erix-agent 的 ADR-009 已裁决「agent 不内置安全，谁用谁负责」。因此平台**必须**提供牢笼，而能提供内核级隔离的最小单元就是容器。
- FDE 是可信员工，但**进入容器的代码与模型输出不可信**：客户仓库、npm 依赖、LLM 生成的 shell 命令。安全边界要挡的是这些，不是 FDE 本人。
- 一台容器同时承载多个仓库是常态（FDE 同时服务多个客户）。所以「一台容器 = 一个隔离域」，但「一个仓库 = 一个工作单元」。

**派生规则**：
- 每 FDE 容器**只接自己的 `/29` 网络**（`fde-<name>`），不与其他 FDE 共享任何网络（H-B：`control` 已取消，topology.md §2）
- FDE 容器不 publish 端口、不挂 `docker.sock`、不持有平台密钥
- 同一仓库的并发靠 **worktree + `agent/<runId>` 分支**，不靠多容器

**违反后果**：容器间可互访（横向越权）、FDE 可从容器内操作宿主机 Docker（逃逸）、同仓库并发互相覆盖。

---

### 原理二：认证在网络边缘，应用不感知

**陈述**：所有访问控制都在 ingress 做，被代理的应用（dev server、code-server、agent 浏览器）**不知道认证存在**。

**为什么**：
1. FDE 起的 dev server 千奇百怪（各类框架、各种端口、各种 HMR 实现），**逐个适配认证是不可能的**；而入口只有一个，在那里做一次就够了。
2. **安全设施必须对 agent 的工具链透明**：容器内的 agent 用 `127.0.0.1:4000` 访问自己的 dev server 时不该携带任何凭据。若认证做在应用里，agent 的浏览器自动化就必须持有密码 → 凭据进入 agent 配置 → 泄漏面扩大、工具面被污染。
3. 授权逻辑集中在一处，才可能审计（「谁在什么时候看了哪个端口」）。

**派生规则**：
- 授权规则是 `f(cookie.sub, host 中的 FDE 标识)` 的纯函数，在 `/api/forward-auth` 一处实现
- 路由由 portal 生成写入 Traefik file provider，与 DB 端口表**同源**（DB 事务写 `port_allocations` + route outbox；Traefik file provider 是异步、幂等、可重试的派生状态）
- **路由表里没有 = 不可达**（比 403 更干净）
- dev server 不改造；容器内 agent 走回环，不经 ingress

**违反后果**：agent 需要人工配置凭据；新增项目要改应用代码；授权逻辑分散后无法审计。

---

### 原理三：状态在中心，执行在边缘；容器是牲口

**陈述**：容器可以被随时销毁重建；**任何重要状态都必须落在中心 DB 或持久卷里**，并且有重建路径。

**为什么**：
- 容器会因升级镜像、迁移宿主机、崩溃、资源调整而重建。
- FDE 的期待是「关掉明天再打开，会话还在」；同时需要多端访问（笔记本 + 手机 + 平板）。
- 跨用户聚合（成本归属、审计、看板）只有在状态集中时才有可能。
- portal 必须是无状态的——它的重启不应杀死正在跑的任务。

**派生规则**：
- transcript / events / 端口分配 / 用量 / 审计 / 会话 → **全部在 DB**
- run loop 在容器里执行，但事件与快照**边跑边经 portal internal API 落库**（容器不直连 DB，D1'）；portal 重启后客户端按 `Last-Event-ID` 补发
- `.erix/ports.json` 是**派生视图**（为 agent 免 API 读取），**不是真相**
- 主机重启后，凭 DB 能重新生成全部端口 JSON 与 Traefik 路由（自愈）

**推论**：「只存在于容器里的重要状态」一律视为 bug。

**违反后果**：容器重建丢会话；portal 重启杀任务；成本无法归集。

---

### 原理四：唯一入口，网络是最终强制手段

**陈述**：强制力排序为 **网络 > 文件权限 > 纪律**。任何依赖「用户不会那么做」的设计都不成立。

**为什么**：
- **FDE 在自己容器里有 shell**。他能 kill 掉 runner 自己起进程、能改环境变量、能直接 `curl` 外部。
- 因此「FDE 不能改 LLM endpoint」这类需求，**不能**靠只读挂载、非 root、平台注入来保证——那些**只能防误改**。
- 唯一物理保证是「**到不了**」：目标地址 DNS 不解析 / IP 不可达 / 不在 allowlist。

**派生规则**：
- 所有外部访问**只有一条路**（ingress），FDE 端口一律不 publish
- LLM 走**唯一可达的网关出口**，其他 LLM 域名不在白名单（§11 模式 C；「到不了」的实施是安全团队网络层职责，平台不负实施责任，issue #3）
- 三条必须同时堵的洞：端口 publish、共享 bridge 网络、容器内自建隧道
- 判定「某访问控制是否有效」的标准动作：**先问「有没有第二条路」**

**违反后果**：防护变成装饰（比没有防护更糟，因为它制造了安全感）；客户代码可被外发。

---

### 原理五：平台做平台的事，引擎做引擎的事

**陈述**：`erix-station` 不实现 agent 逻辑；`erix-agent` 不 import `http` / `docker`。边界不可越。

**为什么**：
- 两边演进节奏不同：引擎受模型 API 变化驱动，平台受组织流程驱动。
- 边界清晰才有可验证的升级路径：`erix-agent/contract-tests` 就是为长期运行宿主准备的。
- ADR-009 教训：把安全混进 agent 会产生**虚假承诺**，分层后各层可独立替换。

**派生规则**：
- 平台**只使用** erix-agent 的公开 API（`runToolLoop` / `TranscriptStore` / `erix-agent/tools` / 未来的 `erix-agent/session`）
- 引擎缺口以 issue 形式回上游，**不在平台里 fork 一份**
- 多角色编排、重试调度、审批 → **平台职责**，不进引擎
- 引擎侧行为变化 → 平台跑 contract-tests 而非人工 checklist

**违反后果**：两份真相（每次升级改两处）；引擎被宿主需求绑架；契约测试失去意义。

---

## 2. 规则 → 原理对照表

| 设计规则（规格位置） | 来源原理 |
|---|---|
| 每 FDE 独立 `/29` 网络（§5.1） | 一 |
| 不 publish FDE 端口（§5.2） | 一、四 |
| 每 FDE 独立 bridge 网络（§5.2） | 一、四 |
| ingress 是唯一入口 + forwardAuth（§6） | 二、四 |
| dev server 不感知认证（§6.1） | 二 |
| 路由由 portal 生成、与 DB 同源（§6.4） | 二、三 |
| 端口分配 DB 为真相、JSON 为派生（§8.1） | 三 |
| agent 不自己挑端口（§8.1） | 三、四 |
| 事件落 DB、portal 发 SSE（§10.2） | 三 |
| 容器不挂 docker.sock、不持平台密钥（§4） | 一 |
| LLM 唯一出口网关（§11.3 模式 C） | 四 |
| 隔离单元 = worktree（§12.2） | 一 |
| 平台复用 erix 公开 API、缺口回上游（§13） | 五 |

---

## 3. 被否决的方案（不要重新提出，除非前提变了）

| 方案 | 否决原因 | 什么条件下可重新考虑 |
|---|---|---|
| **in-process 嵌入**（把 agent 直接跑在 Web 服务进程里，pi-web 那种） | 长任务随前端进程生死；工具副作用与 UI 生命周期耦合；无法多端 attach | 只做单人本地 demo、无长任务、不需要多端 |
| **中心 worker + `docker exec` 进容器执行工具** | erix 的工具就是「本地 fs + shell」，跨容器要把 file-tools/jail 按容器边界重写（工具面被劈成两半）；agent 与 dev server **不在同一网络命名空间**，`localhost` 语义失效 | erix 未来支持远程工具执行契约时 |
| **path-prefix 反代**（`station/alice/app/4000/...`） | SPA 绝对路径、HMR websocket、cookie path、redirect `Location`、CORS 全部会炸；无法为任意框架适配 | 只代理自研且路径已知的应用 |
| **IP 白名单作主机制** | VPN 池/DHCP 漂移；**公司出口 NAT 把所有人塌缩成同一源 IP**（要么人人可看，要么自己进不去）；多设备/手机/客户现场失效 | 平台整体就是 VPN-only（这时它是**网络层**措施，不是按人白名单） |
| **basic auth 作主机制** | 浏览器按 host+realm 自动重发凭据（共享浏览器/录屏泄漏）；每子域弹窗；静态密钥轮换与离职要逐容器改；无法分级可见性；无访问审计；不复用 SSO | forwardAuth 故障时的 deny-all 兜底；非浏览器客户端 |
| **每个端口一条手工/动态路由配置** | 控制面复杂度爆炸（N 用户 × M 端口） | 无——泛域名 + host 编码端口用一条规则解决 |
| **让 agent 自己挑端口** | 冲突；端口漂移导致 URL 变化（书签/预览/iframe 全断）；无法审计与回收 | 无 |
| **所有 FDE 容器共享一个 docker 网络** | 容器互访可绕过 ingress 直达（`curl alice:4000`） | 无 |
| **把工作区锁在「仓库」粒度（同一仓库串行）** | 白白串行化；FDE 常态就是同仓库多分支并行 | 无（用 worktree 解决） |
| **共享工作区做结对开发** | 需要协调锁与冲突；fork + PR 已经够用且更安全 | 需要真正的实时结对编辑时 |
| **portal 自持上游 key 并做流式代理（§11 模式 B）** | 要自己实现 SSE 透传、超时、错误码映射、usage 透传；而 LiteLLM 这类网关**原生具备**虚拟 key / 预算 / 模型白名单 / 限流 / 用量查询 | 公司明确不允许把网关暴露给容器时 |
| **LLM key 直发容器且无出口管控（§11 模式 A）** | 改 endpoint 即可把客户代码发往外部 LLM；「改不了」只能靠纪律，而原理四说纪律不算 | FDE 全员可信且客户数据泄漏风险被管理层显式接受 |
| **Gitea 仓库转 pull mirror 做同步** | 仓库变只读（不能再建 issue）；**只同步 git refs，issues/PR 不同步**；默认 prune 会删掉 Gitea 独有分支 | 该仓库不再需要承载 issue |
| **把设计文档只放在内网 issue 里** | 协作者依赖内网可达性；过程推理与结论分离 | 无（本文即为纠正） |

---

## 4. 未决问题的决策框架（Q1~Q7）

> 规格里 §0 只列了问题。这里给出**每项需要什么信息、候选是什么、影响面多大、当前倾向**，供决策者或 agent 收敛。

### Q1 公司是否已有统一 LLM 网关？

- **需要信息**：有没有 LiteLLM / one-api / one-hub 之类的集中网关？是否支持虚拟 key、预算、模型白名单、用量查询？
- **候选**：(a) 已有 → portal 只做租户绑定；(b) 没有 → 起一个 LiteLLM 容器，portal 仍只做租户绑定
- **影响面**：§11 的实现量（是否要自写流式代理）、成本归集口径
- **当前倾向**：(b)——**无论如何都不自写代理**，把网关当成熟件用

### Q2 出口管控（egress）职责归属 —— ✅ 已决策

> **已决策：出口管控归安全团队（网络层）**（决策者 2026-09，issue #3）。平台职责止于**凭据红线**（容器内**零 LLM 凭据**——H-B 定稿 D-4 后连虚拟 key 也不放容器，仅占位 key + `baseURL=https://llm.<base>/v1`，真实虚拟 key 由 Traefik 按来源子网注入；永不下放下游真实 key）与**审计**；若安全团队的出口策略未实施，「防外发」降级为审计 + 告警，须管理层书面知情。
>
> 决策者原话：「防火墙那是安全团队的事情，不用我们管。」技术事实：Docker 容器默认经宿主机 NAT 出网且无任何限制；出口策略只能在网络层实施（宿主机 iptables/nftables、强制 egress 代理按域名白名单、或网络设备对容器所在网段做策略），平台业务代码实现不了。

- **需向安全团队索要的事实**（不是平台待决策项）：容器使用哪个网段；策略如何标识容器（IP / 网络名 / label）；白名单内容与维护流程（npm/pypi/github/内部 git/镜像仓库）；LLM 域名是否不解析；变更/开通 SLA
- **影响面**：规格 §11 模式 C 的「唯一可达出口」成为**依赖外部网络策略的前提**；平台对安全团队的接口 = 容器网络名/命名规范 + 审计事件 + 「上游 LLM 只经网关」的架构事实

### Q3 本地 admin 账号的定位

- **候选**：(a) 仅破窗（推荐）；(b) FDE 也可用本地账号兜底
- **影响面**：§7.1 认证设计、审计告警阈值
- **当前倾向**：(a)

### Q4 LLM 虚拟 key 的粒度

- **候选**：(a) 每 FDE 一把 + 请求打客户端项目标（metadata/tags）；(b) 每客户项目一把
- **影响面**：§11.3 记账精度 vs key 管理复杂度
- **当前倾向**：(a)——(b) 的 key 数量会膨胀，而标签已能覆盖成本归属

### Q5 端口分级

- **候选**：(a) 项目级固定端口 + run 级临时端口（完整）；(b) 先只做项目级
- **影响面**：§8.2 复杂度、URL 稳定性
- **当前倾向**：(b) 起步，(a) 在 P2 补

### Q6 编排形态

- **候选**：(a) 裸 Linux + Docker（当前）；(b) 将来上 K8s
- **影响面**：§14 实现；原理一/三不变，只是驱动层替换
- **当前倾向**：(a)。**约束**：编排层要留抽象（`RunnerBackend`），别把 Docker API 撒满代码

### Q7 portal 技术栈与依赖政策

- **约束（来自原理，不是偏好）**：必须能长时间持有任务、能写 DB、能操作 Docker API、能被 Traefik forwardAuth 调用
- **候选**：(a) 零依赖 `node:http` + 原生前端；(b) 框架（Next.js 等）
- **影响面**：整体实现；也决定由谁来做前端
- **当前倾向**：(a)——与 erix 家族的零依赖传统一致，自托管场景不需要构建链；代价是 UI 要自己写

---

## 5. 给实现者的硬约束清单

新增任何东西前，逐条对照：

- [ ] 新增的**对外访问**是否走了 ingress？是否在 `/api/forward-auth` 有对应的授权规则？
- [ ] 新增的**端口**是否经 `port_allocations` 分配？URL 是否由 portal 生成？
- [ ] 新增的**重要状态**是否落 DB？容器重建后能否恢复？
- [ ] 新增的容器是否有 publish 端口 / 挂 `docker.sock` / 持有平台密钥？（三者皆禁止）
- [ ] 是否引入了「第二条路」（临时端口、临时网络、临时隧道）？
- [ ] 是否在依赖 erix 的**非公开** API？缺口应回上游 issue
- [ ] 是否需要在 `erix-agent/contract-tests` 增加用例？
- [ ] 是否碰了 `runToolLoop` 的行为？（平台侧不允许）
- [ ] 失败路径：DB 抖动、容器崩溃、ingress 重启、LLM 网关 429 —— 各自表现是什么？
- [ ] 是否泄漏密钥到日志/镜像/仓库？（提交前 `grep`）

---

## 6. 与 erix-agent 的契约锚点

平台实现者需要读的上游内容：

| 内容 | 位置 |
|---|---|
| 宿主接口契约（`runToolLoop` 参数与返回值、Store、Provider） | [`erix-agent/docs/architecture.md`](https://github.com/ErixWong/erix-agent/blob/main/docs/architecture.md) |
| 宿主升级应对（行为变化、fail-closed、多轮 `task` 语义） | [`erix-agent/docs/host-upgrade-guide-v030.md`](https://github.com/ErixWong/erix-agent/blob/main/docs/host-upgrade-guide-v030.md) |
| 契约测试（宿主 CI 应接入） | `erix-agent/contract-tests` 子路径导出（`test/contract/`） |
| 安全分层决策（为什么牢笼必须由平台提供） | [`erix-agent/docs/decisions/009-safety-layering.md`](https://github.com/ErixWong/erix-agent/blob/main/docs/decisions/009-safety-layering.md) |
| 消息与压缩模型（为什么 UI 消息 ≠ transcript） | [`erix-agent/docs/decisions/002-transcript-store.md`](https://github.com/ErixWong/erix-agent/blob/main/docs/decisions/002-transcript-store.md) |
| 前置重构（宿主组装逻辑下沉） | [erix-agent#49](https://github.com/ErixWong/erix-agent/issues/49) |
