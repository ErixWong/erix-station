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
| `docker compose -f deploy/docker-compose.yml up -d` | 本地起平台栈 |

测试隔离约定：涉及用户配置/容器网络的测试必须注入路径参数，不碰真实环境。

## 5. 端口登记（本机，避让已有占用）

| 端口 | 用途 |
|---|---|
| 80 / 443 | Traefik ingress（唯一对外；**生产值**——开发期本机 80/443 被 nginx 占用，按 env.md §0 用 8090/8443） |
| 8080 | portal（backend 网络 + publish 仅 `127.0.0.1:8080` 回环，供 Traefik 反代/forwardAuth；开发期本机映射 `18080`，env.md §0） |
| 4000 | LLM 网关数据面（publish 仅 `127.0.0.1:4000` 回环；P1 由 station-mock-llm 占据，P3 由真实网关占据） |
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

历史参考：双模型评审在 PR #16–#20 曾抓出 ~25 个实质问题（认证绕过、跨 FDE 删除、forward-auth 放行、事件重试风暴等），做法存档于 git 历史/issue #13；需要第二意见时仍可**按需**调 copilot_cli（readonly 单次），但不作为门禁。

## 7. 已定架构决策（详见 docs/design/fde-platform.md 附录 A）

- D1 Traefik 作 ingress；D2 SSO + 本地 break-glass admin；D3 每 FDE 仅自己的 `/29` 独立网络（`control` 共享网络已取消，H-B 定稿 issue #5）
- D4 不 publish FDE 端口；D5 端口由平台分配（DB 为真相）；D6 LLM 走唯一出口网关（「改不了 endpoint」依赖安全团队网络层出口策略，非平台交付物——issue #3）
- D7 事件落 DB、portal 供 SSE；D8 隔离单元 = worktree

## 8. erix-agent 依赖与升级（0.3.5 → 0.9.0，2026-09 分析）

- **源仓库**：`~/projects/erix-llm-kit`（npm 包名就是 `erix-agent`；本地无同名目录，别再找错）。宿主契约 `docs/host-consumer-contract.md`；0.6.0 升级指南 `docs/host-upgrade-guide-0.6.0.md`；破坏性变化以 CHANGELOG 为准。
- runner 锁 `0.3.5`（runner/package.json），最新 `0.9.0`。升级为**大改动**：走分支 + PR + §6.1 评审。

### 必改项（breaking，不改跑不起来）

1. **`erix-agent/tools` 四个导入断供**（0.9.0 只剩 `createToolRegistry` + tool providers）：
   - `createJail` / `createFileTools` → 0.6.0 删除（ADR-009：库不提供沙箱）→ runner 自带 file 工具与 jail 路径边界（牢笼仍由本项目提供，不变式 1）；
   - `createRecallTool` → 0.8.0 随 recall 工具退役删除 → 删该工具，档案取回改 note 工作流（`note_take`/`note_read`/`note_list`，引擎要求 NotesStore；实现放 `src/store/notes.js` 导出 `createFileNotesStore`/`assertNotesStore`）。
2. **TranscriptStore 必需方法变 8 个**（0.6.0 起 run 前 fail-closed 校验，缺即 TypeError）：station 现有 7 个，缺 **`saveRunState`/`loadRunState`** → 三段链路都补：worker `makeStore`（IPC）→ agentd `handleStoreState` 加 case → portal internal 新端点（`PUT/GET /runs/:id/runstate`，落 `runs.run_state jsonb`，与不变式 3「DB 是状态真相」一致）。契约要求：写失败向上抛、runState 对象含 `state`/`stateVersion`。
3. **store.recall 不再必需**：引擎 0.8.0 起不再调用；agentd/portal 的 recall 端点可保留或删（升级时拍板，别留孤儿）。
4. **未知顶层选项抛 TypeError**：worker 现有传参已逐项核对在契约白名单内，无需改（后续加参数必须先对 `host-consumer-contract.md` 选项清单）。

### 需拍板的行为差异（不 crash，但改模型可见面/成本）

- `maxRounds: 8 + judge 已开`（`reflection: { enabled: true, roundJudge: true }`，用户 2026-09-22 拍板，推翻「P1 mock 关 judge」）→ 长任务 nearLimit 可经 round judge `extend` 扩轮；judge 请求失败 fail-closed 不扩轮（`roundJudgeFailures` 限 3 后本轮禁用）；judgeIntercept 默认开（工具透明审计）。
- 新默认值：output hygiene 4096（超限工具结果归档+截断提示）、工具结果 TTL 折叠（`ERIX_TOOL_RESULT_TTL` 默认 2）、retry `attempts:2`；单轮聚合预算在未传窗口配置时不生效（同 0.6.0 行为）。
- resume 语义拆分（0.7.0）：轮号跨 resume 连续，轮预算每次 run 从 0 起计 → wp3b-e2e 的 resume 用例要按新口径核对。

### 随动同步项

- `termination` 新枚举 `final_guard_unverified`（docs/data/schema.sql 注释还按 0.3.5 写）；`usage` 增可选 `cacheRead`/`cacheWrite`；新事件类型 `compaction`/`final_guard`、judge 事件带 `extend`/`passThrough` 决策 → portal 事件白名单/前端枚举核对。
- provider 导出 `createOpenAIProvider`/`createJsonFileModelConfigProvider` 与 `registry.executeTool(name, input, context)` 签名未变；worker 的 executeTool 已是结构化包装，无需改。
- 升级后对 station store adapter 跑 `erix-agent/contract-tests`（`transcriptStoreContract` 0.6.0 起更严：checkpoint 字节保真、多 runId 隔离、runState round-trip）。
- `runner/package.json` 版本号 + lock、wp3b-e2e、本节状态在 PR 内同步更新。

### 8.1 实施状态（feat-260922-01-erix-agent-090，2026-09-22）

- [x] **必改项 1**：`erix-agent/tools` 四导入断供 → runner 自带 jail + file 工具（`runner/lib/file-tools.js`，0.3.5 语义移植）；recall 工具删除，档案取回归 note 工作流（`runner/lib/notes-tools.js`，复用随包 notes 技能模块 + `createFileNotesStore`，落盘 `<worktree>/.notes`）。
- [x] **必改项 2**：store adapter 补 `saveRunState`/`loadRunState`（`runner/lib/store.js`，transport 可注入）→ agentd `handleStoreRequest` 两 case → portal `PUT/GET /runs/:id/runstate`（落 `runs.run_state jsonb`，迁移 `0003-run-state.sql`）。markRunState 双路：`'running'` → U2；引擎终态标记 → runstate 合并 `state`（不动 `runs.status`）。
- [x] **必改项 3**：store.recall 端点**保留**（引擎 0.8.0 起不调用；worker 不注册 recall 工具；非孤儿——既有断言面与只读兼容）。
- [x] **必改项 4**：worker 传参逐项核对在 `host-consumer-contract.md` 选项白名单内，未加契约外键。
- [x] **随动同步**：`runner/package.json` → 0.9.0 + lock；portal 事件白名单补 `compaction`/`final_guard`/`forced_final`（judge 事件 `extend`/`passThrough` 前端展示）；termination 枚举补 `final_guard_unverified` + `run_state` 列文档落 `docs/data/model.md`（**baseline 冻结规则优先**：`docs/data/schema.sql` 的修改已回滚——`migrate.js` 实时 sha256 校验，改 baseline 会让既有部署拒启；DDL 只走 `0003-run-state.sql`）；契约测试 `transcriptStoreContract` 对 station adapter 全绿（`runner/test/store-contract.test.js`）。
- [x] **wp3b-e2e 真机复跑全绿**（2026-09-22，隔离栈：`STATION_STACK_ID` + 端口/容器名/DB 目录 env 化；含 F3 sentinel 恢复断言）。配套修了两个真问题：F8 traefik 静态配置 `TRAEFIK_STATIC_HOST` env 化（CLI 覆盖被 `--configFile` 静态文件压制，实测证伪）；F9 orphan 清扫按 `station.stack` 标签过滤（同宿主双 portal 互删对方 FDE 的真缺陷，共享栈旧镜像需重建后才受保护）。
- [x] **judge（扩轮）已开**（2026-09-22 用户拍板）：`worker.js` `reflection: { enabled: true, roundJudge: true }`；F3 sentinel 断言可再加强为内容级（LOW，copilot 复审遗留）。

### 8.2 0.10.0 迁移记录（feat-260922-01-erix-agent-010-notes，issue #46，2026-09-22）

- [x] **notes 装配迁工厂**：`runner/lib/notes-tools.js` 重写——`createBuiltinNotesTools`（包根公开导出，零深路径 import、零手写 `__erix`，宿主作用域工厂内部强制注入）；返回工厂全套（definitions/executors/executeTool 双视图 + lifecycle + semanticStateProvider）；降级逻辑保留（动态 import，失败 → warn + 无 note 工具，不中断 run）。
- [x] **worker 接生命周期**（上游 `bin/cli.js` try/finally 模式）：`onRunStart`（janitor）在 runToolLoop 前（失败仅告警）；`onRunComplete`（completeRun→janitor）在 finally；返回的 `errors[]` 逐条 IPC warn 记账，**不覆盖 run 主错误**。note_* 走工厂结构化 `executeTool`，file 工具维持自带 registry。
- [x] **resume 丢 notes 修复（选项 A，logical-run 作用域）**：notesDir 从 `<worktree>/.notes` 迁 **run 数据目录** `<CFG.home>/runs/<runId>/notes/`（agentd claim 后备好、RUN_START 下行 `notes_dir`；旧 agentd 无该字段 → worker 回退 worktree 内 `.notes` 并 warn）。`cleanupWorktree` 照旧只清 worktree、**不再连带 notes**；`releaseAndRequeue`（resume/崩溃重排队）与 lease_lost 路径**不删** run 数据目录——attempt 间 notes 必保留。
- [x] **run 数据目录终态清理**：仅 U2 确认终态（finishRun 成功或 409 run_terminal 幂等命中）后 `cleanupRunData`；stop 路径（dropReason=stop_request/stop_heartbeat 补报 aborted）同判终态。清理失败/异常退出遗留的兜底 = **下次 agentd 启动 sweep**（`sweepRunDataDir`，claimLoop 之前跑）——**sweep 只删 mtime 超过保留期的目录**（默认 24h，`ERIX_RUN_DATA_TTL_HOURS` 可调，0=禁用；评审 HIGH 修正：启动时活跃集为空，无 TTL 会把崩溃后待 resume re-claim 的 notes 当残留删光，race 推导与单测见 `runner/lib/run-data.js`）。权限坑：file store 写时 chmod 0700/0600（属主 worker UID 1002），agentd（1001）直删 EACCES → `cleanupRunData` 直删失败后以 fork worker 同款 uid/gid 起一次性 helper 删（agentd 持 SETUID/SETGID ambient caps）。
- [x] **依赖**：`runner/package.json` erix-agent 0.9.0 → **0.10.0** + lockfile 同步（`npm view` 确认 0.10.0 已发布，含上游 PR #54 装配工厂）。
- [x] **测试**：`runner/test/notes-tools.test.js` 按工厂 API 重写（4 用例：工厂装配闭环、lifecycle errors[] 语义、**resume 跨实例不断档**、scope 非 run）；`runner/test/run-data.test.js` 覆盖 run 数据目录生命周期（sweep 新鲜保留/过期清扫/TTL 边界/禁用清扫、终态清理幂等）；不断言 `__erix` 细节（工厂内部行为）。既有 store-contract/file-tools 套件不动，根 `npm test` 全绿。
- [ ] **待办**：worker 暂未接 `semanticStateProvider`（ADR-015 槽位，工厂已透出，将来接 runToolLoop 参数时零成本）；wp3b-e2e resume 用例的 notes 断言属主 agent 范围（本 PR 不跑 docker/e2e）。
