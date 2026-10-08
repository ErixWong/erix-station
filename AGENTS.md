# erix-station — 项目 AGENTS.md

> 项目特有规则；共享约定见 `~/projects/AGENTS.md`（全局）。本文件随仓库走。
> 主远程：`https://github.com/ErixWong/erix-station.git`（私有）。

## 1. 项目定位

**FDE Station** —— 给 FDE 用的开发工位平台（宿主平台）。

- **每 FDE 一台容器小电脑**：容器内 `~/projects/<project>` 一个项目，`~/worktrees/<project>-<runId>` 一个 agent 运行
- **erix-agent 是引擎**：本项目不实现 agent 逻辑，只做「谁在用 / 在哪跑 / 怎么访问 / 花多少」——即宿主侧
- **统一入口**：Traefik 单入口 + 泛域名，认证在边缘，应用不感知
- **边界**：agent 不内置安全（erix ADR-009），**牢笼由本项目提供**

与 erix-llm-kit 的关系：本项目**依赖** `erix-agent` 的公开 API（`runToolLoop` / `TranscriptStore` / `erix-agent/tools`），**不修改**它的行为；上游需要的能力缺口以 issue 形式提到 [erix-agent](https://github.com/ErixWong/erix-agent)。

## 2. 三条不变式（改代码前先读）

1. **容器是信任边界**：FDE 容器不 publish 端口、不挂 `docker.sock`、不持有平台密钥
2. **ingress 是唯一的路**：任何「绕过 Traefik 也能访问」的设计都是 bug
3. **DB 是状态真相**：容器是牲口，重建后必须能从 DB + 卷恢复

## 3. 代码与文档结构（规划）

```
portal/     # 管理平台服务：用户/项目/端口/容器生命周期/事件/LLM 网关
runner/     # 容器内 agent worker（接 erix-agent，跑 runToolLoop）
deploy/     # compose、traefik 配置模板、FDE 容器模板
docs/       # 文档地图（docs/README.md）+ design/ + api/ data/（已建）+ 待建 decisions/ ops/
```

**动手前先读三份文档**：
1. `docs/README.md` —— 文档地图与待补齐清单（实现者入口）
2. `docs/design/fde-platform.md` —— 主规格（是什么）
3. `docs/design/principles.md` —— 设计原理与被否决方案（为什么；未覆盖场景按它推导）

**文档纪律**：规格未覆盖时按原理推导，不与规格冲突就写进文档；冲突则提 issue，**不自行改设计**。

## 4. 开发命令（随实现补齐）

| 命令 | 用途 |
|---|---|
| `node --check <file>` | 语法保底（零依赖 Node ESM） |
| `npm test` | 单测（`node --test`） |
| `cd portal/frontend && npm run typecheck && npm test` | 前端 Vue SPA：vue-tsc 类型检查 + vitest 单测（devDependencies 需 `NODE_ENV=development npm install`，本机 NODE_ENV=production 会跳过） |
| `docker compose -f deploy/docker-compose.yml up -d` | 本地起平台栈 |

测试隔离约定：涉及用户配置/容器网络的测试必须注入路径参数，不碰真实环境。

### 4.1 dev 栈测试账号（仅本地 dev 环境，勿用于生产）

- 入口：`http://hp.inteva.vip:8090/`（deploy 栈 station-portal；代码更新后需 `docker compose build station-portal && docker compose up -d station-portal` 生效）
- 测试账号：`admin / admin123`（role=admin → 管理台）、`eric / admin123`（fde:eric → 工作台）——两账号均未注册 TOTP，密码直通（**2026-10-03 实测修正**：原写 `eric-admin`，实际 `users.login` 为 `admin`，用错名字登录会报「用户名或口令错误」）
- 密码重置：用 portal 自身 `hashPassword`（scrypt 自描述格式）生成后更新 `users.password_hash`（bootstrap-admin 不能重置已存在账号）

### 4.2 LLM 网关（LiteLLM，issue #117）

平台的 LLM 网关**外包给自托管 LiteLLM**：**模型目录与上游凭据的唯一真相源是 LiteLLM 的 DB**（`store_model_in_db: true`）。管理台的 LLM tab 只是它的**薄代理**（`portal/src/llm-gateway.js`），不再是我们的 `llm_providers`/`llm_models`（已迁 `*_retired`）。

**起栈与地址**
- `station-litellm` 是**可选 `litellm` profile**，需显式启用：`docker compose --profile litellm up -d`
- 数据面与管理面**同端口**：宿主回环 `http://127.0.0.1:4100`（Traefik host 网络用），容器内 `http://station-litellm:4000`（portal 用 `LLM_GATEWAY_ADMIN_URL`）

**数据面路由**
- LLM 段只发**单一 service `llm-gateway`**（上游 = LiteLLM）；per-FDE router 仍带 `ClientIP(<该 FDE 的 /29>)` 限定，middleware 注入该 FDE 的**虚拟 key**
- **per-FDE 虚拟 key**：开户/改配置时 portal 调 `/key/generate` 铸（models 白名单 = 该 FDE 选中的模型）；**明文只存 `fde_llm_bindings.api_key`**（Traefik 注入需要明文）。**改配置走 `/key/update` 原地更新白名单，不轮换 key**（同 alias 铸新 key 会撞 LiteLLM 的唯一约束）
- 旧 `api_key`（上游真 key）在迁移 `0010` 被清除并置 `revoked`——**上游真 key 现在只存在于 LiteLLM credential**

**管理台口径**
- **供应商 = LiteLLM Credential**（含上游 `api_key`，加密存 LiteLLM DB）；credential **没有启停语义**（模型启停映射到 `/model/block|unblock`）
- **上游模型 id 格式**：`<provider 前缀>/<上游模型>`，如 `openai/deepseek-flash`——管理台「Upstream model id」字段，**不会自动加前缀**（显式优于隐式）
- **不对外暴露 LiteLLM 自带 UI**（不在验收面上，其前端有已知缺陷）

**凭据**：`deploy/.env`（600，gitignore）→ `LITELLM_MASTER_KEY` / `LITELLM_SALT_KEY` / `LITELLM_DB_USER` / `LITELLM_DB_PASSWORD`。⚠️ **`LITELLM_SALT_KEY` 一旦写过凭据就不能再改**（旧密文将无法解密）

**已知遗留**（详见 #117）
- ~~LiteLLM 成本表不含自定义模型名 → 虚拟 key 的 `spend` 恒为 `0.0`~~（issue #164 已补：自定义模型定价写在 `litellm_params.input_cost_per_token/output_cost_per_token`，管理台可填并显式标注未设定价；口径见 `docs/design/fde-platform.md` §11.5。`max_budget` 仍未下发）
- 集成 e2e（`wp3a`/`wp3b`/`wp4`/`wp5`/`wp6`）通过管理台 API 建 LiteLLM credential/mock model 和 FDE binding，覆盖虚拟 key 白名单与注入链路；已不依赖旧架构
- `station-mock-llm` 与 `portal/mock-gateway/` 已删除；端到端 mock 响应由 LiteLLM 原生 `mock_response` 提供

## 5. 端口登记（本机，避让已有占用）

| 端口 | 用途 |
|---|---|
| 80 / 443 | Traefik ingress（唯一对外；**生产值**——开发期本机 80/443 被 nginx 占用，按 env.md §0 用 8090/8443） |
| 8080 | portal（backend 网络 + publish 仅 `127.0.0.1:8080` 回环，供 Traefik 反代/forwardAuth；开发期本机映射 `18080`，env.md §0） |
| 4100 | **LLM 网关数据面/管理面**：`station-litellm`（`litellm` profile），默认 publish 到 `127.0.0.1:4100` 回环（`LITELLM_HOST_PORT` 可覆盖），Traefik 经 `LLM_GATEWAY_HOST` 访问；portal 经 backend 网络访问管理 API。见 §4.2 |
| 5432 | DB（backend 网络内，不 publish） |

FDE 容器内的端口由平台分配（见设计文档 §8），不对宿主机 publish。

## 6. Git 与流程

- 大改动走分支 `feat-YYMMDD-NN-<描述>` / `fix-...` → PR 合并 main；小改/文档可直推
- 提交信息：conventional commits + 中文摘要
- **不提交任何密钥**；凭据一律环境变量 / 凭据文件注入

### 6.1 代码 PR 评审要求（2026-09-23 起简化：取消双模型评审门禁，省 premium 额度）

**代码 PR 合并前主 agent 必须亲自完成**（文档 PR 不强制；不再要求外部模型评审）：

1. **亲审 diff**：逐文件读改动，不照单全收 worker/评审员结论，属实才修，不属实记录裁决理由。
2. **亲自复跑全部验证**：单测全绿 + 相关 e2e 全绿 + 关键探针亲手复现（别人跑过不算）。
3. **每条修复带验证**；修复引入的回归用 e2e 抓（PR #20 实例：F4 修复曾劫持崩溃恢复路径）。
4. **合并后收尾**：merge-commit + 删分支。
5. **stacked PR 的 base 分支不要先删**（2026-10-05 实证）：上层 PR 的 base 指向下层分支时，下层 PR 合并**并删分支**会让 GitHub **直接关闭**上层 PR（不是自动 retarget），且 base 分支已删后 `reopen` 报错、`--base` 也改不动 → 只能同分支重开新 PR（实例：#144 被关，#145 重开）。做法二选一：① 下层合并后**先别删分支**，把上层 PR 的 base 改成 main 再删；② 上层 PR 一开始就 `--base main`（diff 里会含下层提交，下层合并后自动收敛）。

历史参考：双模型评审在 PR #16–#20 曾抓出 ~25 个实质问题（认证绕过、跨 FDE 删除、forward-auth 放行、事件重试风暴等），做法存档于 git 历史/issue #13；需要第二意见时按需调 copilot_cli 复核（用法一律按全局 `~/projects/AGENTS.md` §2.7，本项目无特殊定义）。

## 7. 已定架构决策（详见 docs/design/fde-platform.md 附录 A）

- D1 Traefik 作 ingress；D2 SSO + 本地 break-glass admin；D3 每 FDE 仅自己的 `/29` 独立网络（`control` 共享网络已取消，H-B 定稿 issue #5）
- D4 不 publish FDE 端口；D5 端口由平台分配（DB 为真相）；D6 LLM 走唯一出口网关（「改不了 endpoint」依赖安全团队网络层出口策略，非平台交付物——issue #3）
- D7 事件落 DB、portal 供 SSE；D8 隔离单元 = worktree

## 7. D8 修订（2026-09-24，决策者拍板）：cwd 直达项目目录，拆除 worktree

D8 原文「隔离单元 = worktree」修订为「**隔离单元 = 项目目录（cwd）**」：

- **理由**：FDE 是开发者本人的工位容器（非服务端牲口场），交付物应天然持久于 `~/projects/<project>`；
  worktree 的临时性（run 终态即焚）与神秘容器路径一直在泄漏复杂度给用户和模型（真机反复实证：
  俄罗斯方块手动抢救、hello.sh 报 worktree 路径）。隔离收益实际拿不到：agentd `capacity=1`
  串行执行 + 每 session 单活跃 run，并行碰撞在当前形态不存在。
- **新语义**：worker cwd = `~/projects/<project>`（jail 可写边界不变，就是这个目录）；
  `prepareWorktree`/`cleanupWorktree` 拆除；产物捕获（f402a11）目标改项目目录；
  run 数据目录归档（P1）不变；非 git 项目不再需要 mkdir 兜底。
- **代价与边界**：agent 弄脏项目由用户 git 自治（工位语义本就如此）；将来真要并行同项目，
  再按项目粒度加执行锁，不预支 worktree 复杂度。
- **实施**：见 #81 P2.5；参照系 pi（agent 直接在项目目录工作）。

## 8. erix-agent 依赖与升级（当前 pin：0.16.0）

- **源仓库**：`~/projects/erix-llm-kit`（npm 包名 `erix-agent`）。升级依据以该仓库 `docs/host-consumer-contract.md`、对应版本 host-upgrade-guide 和实际源码为准。
- runner 当前 pin：`0.16.0`；portal（根 package.json，运行时依赖）自 P3 前置起也 pin（写侧预写改走引擎 `appendUserTurn`，见 §8.4；0.16.0 见 §8.5）。升级仍走分支 + PR + §6.1 评审。

### 0.14.0 当前宿主契约

- `TranscriptStore` **必需仅** `appendRound` + `load`；`saveRunSnapshot` / `loadLatestRunSnapshot`（latest-only crash snapshot）及 `saveRunState` / `loadRunState` / `markRunState` 为可选能力。快照方法已由 `saveCheckpoint` / `loadLatestCheckpoint` 更名；不要再把旧名暴露给引擎。station 仍把内部 HTTP 路径 `/checkpoint` 保留作传输实现细节。
- `saveRunState` 保存 deterministic/semantic run-state 数据，不写顶层 `state`；`markRunState` 写独立状态通道。宿主读 `loadRunStateStatus` 不属于引擎能力校验；上游实际 store 契约返回状态字符串，portal 响应记录由 adapter 读取 `status?.status`。旧 JSONB 快照里的 `state` 仍可回退读取，不需要数据回填。
- portal 以 `runs.run_state` / `chat_sessions.engine_run_state` 保存快照数据，以 `runs.run_state_status` / `chat_sessions.engine_run_state_status` 保存状态记录；增量迁移 `0014-run-state-status.sql` 提供新列，baseline `docs/data/schema.sql` 保持冻结。
- notes 工厂生命周期只有 `onRunComplete()`：完成 active → done，返回 `{ completed: {status, completed}, errors }`；**不再有 `onRunStart`，也不在生命周期内 purge/janitor**。notes maintenance 改宿主调度属于 PR B（ADR-018 D7）。
- `NotesStore` 六方法（`write/read/list/complete/revoke/purge`）由 `createBuiltinNotesTools` 在工厂创建时 fail-closed 校验。`note_list` 仅接收 `tag` / `includeInactive`；不传 `cursor` / `limit` / `source` / `minRelevance`。
- `worker.js` 只从包根导入 `createJsonFileModelConfigProvider`、`createOpenAIProvider`、`runToolLoop`；`createToolRegistry` 只从 `erix-agent/tools` 导入。`erix-agent/tools` 不再公开凭据 helper；notes 写侧凭据检测也已退役。本项目没有深路径 `src/loop.js` 导入。
- 不实现 0.14.0 的 opt-in tool replay 声明与 `partialPersistence`；维持默认行为。后续启用 partial persistence 必须同时启用 `stream: true`。

### 8.4 0.15.0 迁移记录（P3 前置，portal 写侧接 `appendUserTurn`）

- [x] **依赖**：`runner/package.json` 0.14.0 → **0.15.0**（增量、无破坏性变更，见 host-upgrade-guide-0.15.0）；**根 `package.json` 新增运行时依赖 `erix-agent: 0.15.0`**（非 dev：portal POST 事务直写 `appendUserTurn`，`portal/Dockerfile` 的 `npm ci --omit=dev` 必须能装到；包体积 ~百 KB 量级，镜像增量可忽略，已验证 omit=dev 安装面含 `src/` 与 `test/contract/`）；两处 lockfile 同步。
- [x] **写侧换 API**：POST 消息事务内的用户输入预写不再手搋 record，改引擎 `appendUserTurn(store, { key: sessionId, text, messageId })`（上游 #97）：round 推导（复用现有最大 round，空 store=0）、dedupKey（`<sessionId>:input:<messageId>`）、record 形态、幂等判据全在引擎侧。station 只提供极小 store 适配器 `portal/src/transcript-store.js`（`load`/`appendRound` 复用调用方事务 client，落库列形态与原手搋逐列等价：`run_id=NULL`、`folded=false`、`messages=record.messages` 派生列、`ON CONFLICT … DO NOTHING` 保留作并发最后防线）。顺序红线不变：先写 transcript、后入队 run（测试断言 BEGIN < messages INSERT < store load < transcript INSERT < run_queue < COMMIT，同一 client 流水）。
- [x] **空白 text 语义**：`appendUserTurn` 对纯空白 text 抛 `TypeError`；HTTP 路径不可达（`validateMessageBody` 已先行 400 `validation_failed`），`sessions.js` 仍做兜底捕获转同一错误码，保证不升格 500。
- [x] **契约自检**：`portal/test/engine-api-contract.test.js` 接入上游 `engineApiContract`（`erix-agent/contract-tests`），锁包入口导出面与最小预写行为；runner 侧 `transcriptStoreContract` 套件不动。
- [ ] **未接线（PR②b 及后续范围）**：读侧 `projectTranscriptForDisplay`（#95，替换 `session-view.js` 自研投影）；`loadRunStateStatus` 终态比较复核（#96，host-upgrade-guide-0.15.0 §3：0.14.0 升级指南示例读 `status?.status` 有误，引擎解析为状态字符串；station 侧 `runner/lib/store.js` 读的是自家 IPC 信封后经 adapter 返回字符串，语义已对齐——PR②b 终态比较切 transcript 时一并复核）。

### 8.5 0.16.0 迁移记录（store 保序迁移 + 投影 key 采用）

依据：`erix-agent/docs/host-upgrade-guide-0.16.0.md`。0.16.0 无 API 删除、无调用点变更，只有两条 store 硬要求 + 投影增补字段。

- **变更①（store 保真）**：store 必须**原样往返**完整 `RoundRecord`/message（含宿主未知字段），不得按白名单重建；`messages[].meta.source` 是引擎保留标记（分类合成消息），宿主不得当自己的 source 标签。**station 状态：已合规**——`transcript_rounds.record` 整条走 JSONB（读侧 `{ round, ...record }` 原样返回），契约套件「RoundRecord 与 message 未知字段及 source 标记完整往返」通过。
- **变更②（同 round 保序）**：`load()` 必须按**持久化追加顺序**返回同 `round` 记录（引擎不再二次排序）；不得依赖 DB 执行计划、主键扫描顺序或偶然行布局。**station 本次修复**：真机 `transcript_rounds` 有 58 组重复 `(transcript_key, round)`、共 183 行，且存在 `created_at` 完全相同的同轮行 → 原 `ORDER BY round, created_at` 顺序不确定。新增迁移 `0016-transcript-append-seq.sql`（`append_seq` 单调列 + 存量按 `created_at, id` 确定性回填 + `(transcript_key, round, append_seq)` 索引）；`getSessionTranscript` / legacy `getTranscript` 改 `ORDER BY round ASC, append_seq ASC`。
- **变更③（投影增补）**：`projectTranscriptForDisplay` 新增轮级 `turn.key` 与 `toolCalls[].key`（单次投影内唯一、同输入确定性、由输入位置生成；**不是持久 ID、也不是 provider `tool_use.id`**），以及 `meta.sourceInferred`（仅按文本前缀分类合成消息时出现）。**station 采用**：对话流 DTO 逐字透传 `toolCalls[].key` 与 `turnKeys`（run 聚合各轮的 `turn.key`）；前端工具卡片在 provider `id` 缺失时用上游 `key`，不再自造 `proj:<锚点 id>:<序号>`（上游 #100 已由 0.16.0 交付）。
- **契约套件转绿**：上游 `test/contract/transcript-store.js` 新增「保真往返」「同轮保序」两条断言（指南明说：故意让不合规 store 失败——那是迁移信号，不是要放宽的测试）。runner 契约桩（`runner/test/store-contract.test.js` 内存 IPC peer）改为新语义：同 round 不同 dedupKey 共存、`load` 保追加序、dedupKey 幂等；`node --test runner/test/store-contract.test.js` 17/17 全绿。
- **依赖**：根 `package.json` 与 `runner/package.json` → `erix-agent: 0.16.0`，两处 lockfile 同步（无 API 变更，应用调用点不动）。
- **`UNIQUE (run_id, round)` 处置**：**保留不动**——session 维度行 `run_id IS NULL`（NULL 在唯一索引里互不相等）本就不受该约束限制（真机 58 组重复即 session 行）；legacy run 维度 `putRound` 仍以它做 ON CONFLICT 幂等，而 0.16.0 引擎 store 自 P2 起只走 session 端点，改它属「为改而改」（见迁移 0016 头注释）。

### 8.1 实施状态（feat-260922-01-erix-agent-090，2026-09-22）

> 历史记录：本小节记录 0.9.0 升级时的契约与验收，不代表当前 0.14.0 API。

- [x] **必改项 1**：`erix-agent/tools` 四导入断供 → runner 自带 jail + file 工具（`runner/lib/file-tools.js`，0.3.5 语义移植）；recall 工具删除，档案取回归 note 工作流（`runner/lib/notes-tools.js`，复用随包 notes 技能模块 + `createFileNotesStore`，落盘 `<worktree>/.notes`）。
- [x] **必改项 2**：store adapter 补 `saveRunState`/`loadRunState`（`runner/lib/store.js`，transport 可注入）→ agentd `handleStoreRequest` 两 case → portal `PUT/GET /runs/:id/runstate`（落 `runs.run_state jsonb`，迁移 `0003-run-state.sql`）。markRunState 双路：`'running'` → U2；引擎终态标记 → runstate 合并 `state`（不动 `runs.status`）。
- [x] **必改项 3**：store.recall 端点**保留**（引擎 0.8.0 起不调用；worker 不注册 recall 工具；非孤儿——既有断言面与只读兼容）。
- [x] **必改项 4**：worker 传参逐项核对在 `host-consumer-contract.md` 选项白名单内，未加契约外键。
- [x] **随动同步**：`runner/package.json` → 0.9.0 + lock；portal 事件白名单补 `compaction`/`final_guard`/`forced_final`（judge 事件 `extend`/`passThrough` 前端展示）；termination 枚举补 `final_guard_unverified` + `run_state` 列文档落 `docs/data/model.md`（**baseline 冻结规则优先**：`docs/data/schema.sql` 的修改已回滚——`migrate.js` 实时 sha256 校验，改 baseline 会让既有部署拒启；DDL 只走 `0003-run-state.sql`）；契约测试 `transcriptStoreContract` 对 station adapter 全绿（`runner/test/store-contract.test.js`）。
- [x] **wp3b-e2e 真机复跑全绿**（2026-09-22，隔离栈：`STATION_STACK_ID` + 端口/容器名/DB 目录 env 化；含 F3 sentinel 恢复断言）。配套修了两个真问题：F8 traefik 静态配置 `TRAEFIK_STATIC_HOST` env 化（CLI 覆盖被 `--configFile` 静态文件压制，实测证伪）；F9 orphan 清扫按 `station.stack` 标签过滤（同宿主双 portal 互删对方 FDE 的真缺陷，共享栈旧镜像需重建后才受保护）。
- [x] **judge（扩轮）已开**（2026-09-22 用户拍板）：`worker.js` `reflection: { enabled: true, roundJudge: true }`；F3 sentinel 断言可再加强为内容级（LOW，copilot 复审遗留）。

### 8.2 0.10.0 迁移记录（feat-260922-01-erix-agent-010-notes，issue #46，2026-09-22）

> 历史记录：其中 `onRunStart` / janitor 语义已在 0.12.0 删除；当前行为以本节及 8.3 为准。

- [x] **notes 装配迁工厂**：`runner/lib/notes-tools.js` 重写——`createBuiltinNotesTools`（包根公开导出，零深路径 import、零手写 `__erix`，宿主作用域工厂内部强制注入）；返回工厂全套（definitions/executors/executeTool 双视图 + lifecycle + semanticStateProvider）；降级逻辑保留（动态 import，失败 → warn + 无 note 工具，不中断 run）。
- [x] **worker 接生命周期**（上游 `bin/cli.js` try/finally 模式）：`onRunStart`（janitor）在 runToolLoop 前（失败仅告警）；`onRunComplete`（completeRun→janitor）在 finally；返回的 `errors[]` 逐条 IPC warn 记账，**不覆盖 run 主错误**。note_* 走工厂结构化 `executeTool`，file 工具维持自带 registry。
- [x] **resume 丢 notes 修复（选项 A，logical-run 作用域）**：notesDir 从 `<worktree>/.notes` 迁 **run 数据目录** `<CFG.home>/runs/<runId>/notes/`（agentd claim 后备好、RUN_START 下行 `notes_dir`；旧 agentd 无该字段 → worker 回退 worktree 内 `.notes` 并 warn）。`cleanupWorktree` 照旧只清 worktree、**不再连带 notes**；`releaseAndRequeue`（resume/崩溃重排队）与 lease_lost 路径**不删** run 数据目录——attempt 间 notes 必保留。
- [x] **run 数据目录终态清理**：仅 U2 确认终态（finishRun 成功或 409 run_terminal 幂等命中）后 `cleanupRunData`；stop 路径（dropReason=stop_request/stop_heartbeat 补报 aborted）同判终态。清理失败/异常退出遗留的兜底 = **下次 agentd 启动 sweep**（`sweepRunDataDir`，claimLoop 之前跑）——**sweep 只删 mtime 超过保留期的目录**（默认 24h，`ERIX_RUN_DATA_TTL_HOURS` 可调，0=禁用；评审 HIGH 修正：启动时活跃集为空，无 TTL 会把崩溃后待 resume re-claim 的 notes 当残留删光，race 推导与单测见 `runner/lib/run-data.js`）。权限坑：file store 写时 chmod 0700/0600（属主 worker UID 1002），agentd（1001）直删 EACCES → `cleanupRunData` 直删失败后以 fork worker 同款 uid/gid 起一次性 helper 删（agentd 持 SETUID/SETGID ambient caps）。
- [x] **依赖**：`runner/package.json` erix-agent 0.9.0 → **0.10.0** + lockfile 同步（`npm view` 确认 0.10.0 已发布，含上游 PR #54 装配工厂）。
- [x] **测试**：`runner/test/notes-tools.test.js` 按工厂 API 重写（4 用例：工厂装配闭环、lifecycle errors[] 语义、**resume 跨实例不断档**、scope 非 run）；`runner/test/run-data.test.js` 覆盖 run 数据目录生命周期（sweep 新鲜保留/过期清扫/TTL 边界/禁用清扫、终态清理幂等）；不断言 `__erix` 细节（工厂内部行为）。既有 store-contract/file-tools 套件不动，根 `npm test` 全绿。
- [x] **后续接线**：worker 已将工厂的 `semanticStateProvider` 传给 `runToolLoop`（`runner/worker.js`；contract shape 与降级路径见 `runner/test/notes-tools.test.js`）。
- [ ] **待办**：wp3b-e2e resume 用例的 notes 断言属主 agent 范围（本 PR 不跑 docker/e2e）。

### 8.3 0.14.0 迁移记录（issue #162，PR A）

- [x] 依赖与 lockfile 更新至 `0.14.0`；adapter 暴露新快照方法，契约测试使用上游 `transcriptStoreContract`。
- [x] run-state 快照与 `markRunState` status 拆分；新状态列走 migration `0014`，旧快照内嵌 `state` 由 status reader 兼容，无数据回填。
- [x] 删除 `onRunStart` 调用；completion 错误只记日志、不覆盖 run 主错误。
- [ ] PR B：为 notes retention/purge 与 active orphan cleanup 实现宿主自调度（ADR-018 D7/session clock）；本 PR 不实现 tool replay 或 partial persistence。
