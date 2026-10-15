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
| `npm test` | 单测（`node --test`，仓库根） |
| `cd runner && node --test` | runner 侧单测（**口径**：`node --test runner/test/` 在本机 Node 22/24 都把目录当模块加载 → `Cannot find module .../runner/test`、rc=1，别怀疑自己的改动；可用形式另含 `node --test 'runner/test/*.test.js'`） |
| `cd portal/frontend && npm run typecheck && npm test` | 前端 Vue SPA：vue-tsc 类型检查 + vitest 单测（devDependencies 需 `NODE_ENV=development npm install`，本机 NODE_ENV=production 会跳过） |
| `docker compose -f deploy/docker-compose.yml up -d` | 本地起平台栈 |

测试隔离约定：涉及用户配置/容器网络的测试必须注入路径参数，不碰真实环境。

派工环境约定（2026-10-08 实证）：git worktree **不含未跟踪的 `node_modules`**，worker 进去后测试一律跑不起来；补装极便宜（`npm ci --prefer-offline` 热缓存 ~1.4s），所以派单红线应写「不改依赖版本、不提交 lockfile 变动」，而不是「禁止安装依赖」。

⚠ **前端跑单条用例的形式（2026-10-14 一晚上连续两次踩同一坑）**：**`npx vitest run <文件>` 在本机会永久挂死**（实测主 agent 900s 零输出被 timeout 杀、worker 又拿同一形式占满 300s 无输出），而项目脚本 **3.4 秒**跑完 21 条。口径：只跑一个文件用 **`cd portal/frontend && timeout 240 npm test -- src/xxx.spec.ts`**（`test` 脚本本身就是 `vitest run`，`--` 后直接跟文件），类型检查用 **`npm run typecheck`**；**不要用 `npx vitest` / `npx vue-tsc`**。给 worker 的工单里写测试命令时**一律带 `timeout 240`**：否则一条挂死的命令看起来既不像成功也不像失败，会一直占着会话（attention 信号也只会被当成「命令开得久」）。

⚠ **主工作区 `node_modules` 会被别的 worktree 掏空（同一晚第三次复发）**：症状是 `npm test` 从 1022 项掉到 **510 项 + 34 失败**，且 `node_modules/erix-agent` 不存在——**不是代码回归**，先 `ls -d node_modules/erix-agent` 再下结论，`npm ci --prefer-offline` 重装即回基线。推论：**发版/验收前必须先重装一次并复跑拿到基线数**，别拿一个依赖不完整的树当验收基点。

⚠ **前端判绿只能看退出码，不能 grep 摘要行（2026-10-14 主 agent 自己犯的错，代价是一次返工重打 tag）**：vitest 在存在**未捕获拒绝**时照样打印 `Test Files 33 passed (33) / Tests 488 passed (488)`，**但进程以 rc=1 退出**。我当晚用 `npm test 2>&1 | grep -E "Test Files|Tests "` 连跑 3 次都读到「全绿」，实际每一次都是 rc=1、4 条 `Unhandled Rejection` —— 于是把红灯当绿灯合进了 main，直到 CI 步骤 ④ 红才发现。口径：**判绿 = 退出码 0**；要么直接 `npm test; echo rc=$?`，要么 `npm test && echo GREEN`。附带两条：① 这类泄漏的常见成因是 `onMounted` 里 `await` 一个会失败的请求且没 catch（Vue 不等 `onMounted` 返回的 Promise），产品侧实例见 issue #281；② 有 worker 把它归因成「本机 `NODE_ENV=production` ⇒ Vue 生产构建吞掉拒绝」，**该说法在本机已被主 agent 实测否证**（`production` 与 `NODE_ENV=test` 两种模式跑原始文件都是 rc=1）——别拿未在自己机器上复现的成因当结论。

### 4.1 dev 栈测试账号（仅本地 dev 环境，勿用于生产）

- 入口：`http://station.fde.erix.vip:8090/`（伞域泛解析，#57 阶段2，2026-10-08 起；旧的 `hp.inteva.vip:8090` 已随 Host 路由切换失效——Traefik 只认 `station.fde.erix.vip` / `100.100.0.3`。本机解析器负缓存解析不出时可用 playwright 容器 `erix_station_playwright`（:8935，resolver MAP 规则）或临时 hosts 条目兑底。deploy 栈 station-portal；代码更新后需 `docker compose build station-portal && docker compose up -d station-portal` 生效）
- 测试账号：`admin`（role=admin → 管理台）、`eric`（fde:eric → 工作台），两账号**共用同一口令**——明文**不入库不外传**：存 `~/.config/mcp/creds/station-dev.password`（600，轮换直接改该文件+跑密码重置流程）。两账号未注册 TOTP，密码直通（登录体字段是 `login` 不是 `username`）
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
- **CI / 发布（issue #235）**：`.github/workflows/ci.yml` = PR/main 质量门禁 + main 上按路径过滤的三镜像构建校验（只 `ubuntu-latest`，**禁止 matrix**）；`.github/workflows/release.yml` = tag `v*` → GHCR 三镜像（镜像名全小写、`--provenance=false --sbom=false`）+ `images-digest.json` digest 清单。口径、分钟预算语义（超额**是停跑不是扣费、且没有红灯**）、发布→部署的 digest pin（`deploy/.env` 两形态门 + 换 FDE 镜像必须重建容器）、e2e 为何不进 CI，一律见 [`docs/ops/ci-release.md`](docs/ops/ci-release.md)。
- **发布前置**：`package.json` 的 `version` 必须等于去掉 `v` 的 tag（`runner/package.json` 建议一并对齐），否则 `release.yml` 直接失败——现状 tag `v0.1.1` vs `package.json` `0.1.0` 就会被拦（ci-release.md §7）。

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

## 8. erix-agent 依赖与升级（当前 pin：**0.20.0**，2026-10-15 由 #299 从 0.18.0 两步升上；历史 0.14–0.18 记录见下）

- **源仓库**：`~/projects/erix-llm-kit`（npm 包名 `erix-agent`）。升级依据以该仓库 `docs/host-consumer-contract.md`、对应版本 host-upgrade-guide 和实际源码为准。
- runner 与 portal（根 package.json，运行时依赖）**两处 pin 同步**：自 P3 前置起 portal 也 pin（写侧预写改走引擎 `appendUserTurn`，见 §8.4；0.16.0 见 §8.5；0.17.0 见 §8.6；0.18.0 见 §8.8）。升级仍走分支 + PR + §6.1 评审。

### 0.14.0 当前宿主契约

- `TranscriptStore` **必需仅** `appendRound` + `load`；`saveRunSnapshot` / `loadLatestRunSnapshot`（latest-only crash snapshot）及 `saveRunState` / `loadRunState` / `markRunState` 为可选能力。快照方法已由 `saveCheckpoint` / `loadLatestCheckpoint` 更名；不要再把旧名暴露给引擎。station 仍把内部 HTTP 路径 `/checkpoint` 保留作传输实现细节。
- `saveRunState` 保存 deterministic/semantic run-state 数据，不写顶层 `state`；`markRunState` 写独立状态通道。宿主读 `loadRunStateStatus` 不属于引擎能力校验；上游实际 store 契约返回状态字符串，portal 响应记录由 adapter 读取 `status?.status`。旧 JSONB 快照里的 `state` 仍可回退读取，不需要数据回填。
- portal 以 `runs.run_state` / `chat_sessions.engine_run_state` 保存快照数据，以 `runs.run_state_status` / `chat_sessions.engine_run_state_status` 保存状态记录；增量迁移 `0014-run-state-status.sql` 提供新列，baseline `docs/data/schema.sql` 保持冻结。
- notes 工厂生命周期只有 `onRunComplete()`：完成 active → done，返回 `{ completed: {status, completed}, errors }`；**不再有 `onRunStart`，也不在生命周期内 purge/janitor**。notes maintenance 改宿主调度属于 PR B（ADR-018 D7）。
- `NotesStore` 六方法（`write/read/list/complete/revoke/purge`）由 `createBuiltinNotesTools` 在工厂创建时 fail-closed 校验。`note_list` 仅接收 `tag` / `includeInactive`；不传 `cursor` / `limit` / `source` / `minRelevance`。
- `worker.js` 只从包根导入 `createJsonFileModelConfigProvider`、`createOpenAIProvider`、`runToolLoop`；`createToolRegistry` 只从 `erix-agent/tools` 导入。`erix-agent/tools` 不再公开凭据 helper；notes 写侧凭据检测也已退役。本项目没有深路径 `src/loop.js` 导入。
- 不实现 0.14.0 的 opt-in tool replay 声明与 `partialPersistence`；维持默认行为。后续启用 partial persistence 必须同时启用 `stream: true`。 **（前半句已撤销，2026-10-14/#288：自该单起 `runToolLoop` 显式传 `replayPolicy: "per-tool-declaration"` 且 `shell` 声明 `replay: "unsafe"`，不再是「维持默认行为」；`partialPersistence` 仍未实现、本句后半仍成立。理由、边界、已测口径见 §8.22。）**

### 8.4 0.15.0 迁移记录（P3 前置，portal 写侧接 `appendUserTurn`）

- [x] **依赖**：`runner/package.json` 0.14.0 → **0.15.0**（增量、无破坏性变更，见 host-upgrade-guide-0.15.0）；**根 `package.json` 新增运行时依赖 `erix-agent: 0.15.0`**（非 dev：portal POST 事务直写 `appendUserTurn`，`portal/Dockerfile` 的 `npm ci --omit=dev` 必须能装到；包体积 ~百 KB 量级，镜像增量可忽略，已验证 omit=dev 安装面含 `src/` 与 `test/contract/`）；两处 lockfile 同步。
- [x] **写侧换 API**：POST 消息事务内的用户输入预写不再手搋 record，改引擎 `appendUserTurn(store, { key: sessionId, text, messageId })`（上游 #97）：round 推导（复用现有最大 round，空 store=0）、dedupKey（`<sessionId>:input:<messageId>`）、record 形态、幂等判据全在引擎侧。station 只提供极小 store 适配器 `portal/src/transcript-store.js`（`load`/`appendRound` 复用调用方事务 client，落库列形态与原手搋逐列等价：`run_id=NULL`、`folded=false`、`messages=record.messages` 派生列、`ON CONFLICT … DO NOTHING` 保留作并发最后防线）。顺序红线不变：先写 transcript、后入队 run（测试断言 BEGIN < messages INSERT < store load < transcript INSERT < run_queue < COMMIT，同一 client 流水）。
- [x] **空白 text 语义**：`appendUserTurn` 对纯空白 text 抛 `TypeError`；HTTP 路径不可达（`validateMessageBody` 已先行 400 `validation_failed`），`sessions.js` 仍做兜底捕获转同一错误码，保证不升格 500。
- [x] **契约自检**：`portal/test/engine-api-contract.test.js` 接入上游 `engineApiContract`（`erix-agent/contract-tests`），锁包入口导出面与最小预写行为；runner 侧 `transcriptStoreContract` 套件不动。
- [ ] **未接线（PR②b 及后续范围）**：读侧 `projectTranscriptForDisplay`（#95，替换 `session-view.js` 自研投影）；`loadRunStateStatus` 终态比较复核（#96，host-upgrade-guide-0.15.0 §3：0.14.0 升级指南示例读 `status?.status` 有误，引擎解析为状态字符串；station 侧 `runner/lib/store.js` 读的是自家 IPC 信封后经 adapter 返回字符串，语义已对齐——PR②b 终态比较切 transcript 时一并复核）。

### 8.5 0.16.0 迁移记录（store 保序迁移 + 投影 key 采用）

依据：`erix-agent/docs/host-upgrade-guide-0.16.0.md`。0.16.0 无 API 删除、无调用点变更，只有两条 store 硬要求 + 投影增补字段。

- **变更①（store 保真）**：store 必须**原样往返**完整 `RoundRecord`/message（含宿主未知字段），不得按白名单重建；`messages[].meta.source` 是引擎保留标记（分类合成消息），宿主不得当自己的 source 标签。**station 状态：已合规**——`transcript_rounds.record` 整条走 JSONB（读侧 `{ round, ...record }` 原样返回），契约套件「RoundRecord 与 message 未知字段及 source 标记完整往返」通过。
- **变更②（同 round 保序）**：`load()` 必须按**持久化追加顺序**返回同 `round` 记录（引擎不再二次排序）；不得依赖 DB 执行计划、主键扫描顺序或偶然行布局。**station 本次修复**：真机 `transcript_rounds` 有 58 组重复 `(transcript_key, round)`、共 183 行，且存在 `created_at` 完全相同的同轮行 → 原 `ORDER BY round, created_at` 顺序不确定。新增迁移 `0016-transcript-append-seq.sql`（`append_seq` 单调列 + 存量按 `created_at, id` 确定性回填 + `(transcript_key, round, append_seq)` 索引）；`getSessionTranscript` / legacy `getTranscript` 改 `ORDER BY round ASC, append_seq ASC`。**全部 6 处多行读点统一**：另含 `transcript-store.js` 的 `load`（`appendUserTurn` 消费面）、`sessions.js` / `session-text.js`（显示与文本读取）、`recallTranscript`（命中集 + `LIMIT 2000` 截断确定性）；按 `(run_id, round)` / `(transcript_key, dedup_key)` **点查单行**的 3 处由约束保证 ≤1 行，不需要排序。护栏：`portal/test/append-seq-ordering.test.js` 源码级断言 6 个读点必须含 `append_seq` 排序且无 `created_at` 排序残留。
- **变更③（投影增补）**：`projectTranscriptForDisplay` 新增轮级 `turn.key` 与 `toolCalls[].key`（单次投影内唯一、同输入确定性、由输入位置生成；**不是持久 ID、也不是 provider `tool_use.id`**），以及 `meta.sourceInferred`（仅按文本前缀分类合成消息时出现）。**station 采用**：对话流 DTO 逐字透传 `toolCalls[].key` 与 `turnKeys`（run 聚合各轮的 `turn.key`）；前端工具卡片在 provider `id` 缺失时用上游 `key`，不再自造 `proj:<锚点 id>:<序号>`（上游 #100 已由 0.16.0 交付）。
- **契约套件转绿**：上游 `test/contract/transcript-store.js` 新增「保真往返」「同轮保序」两条断言（指南明说：故意让不合规 store 失败——那是迁移信号，不是要放宽的测试）。runner 契约桩（`runner/test/store-contract.test.js` 内存 IPC peer）改为新语义：同 round 不同 dedupKey 共存、`load` 保追加序、dedupKey 幂等；`node --test runner/test/store-contract.test.js` 17/17 全绿。
- **依赖**：根 `package.json` 与 `runner/package.json` → `erix-agent: 0.16.0`，两处 lockfile 同步（无 API 变更，应用调用点不动）。
- **`UNIQUE (run_id, round)` 处置**：**保留不动**——session 维度行 `run_id IS NULL`（NULL 在唯一索引里互不相等）本就不受该约束限制（真机 58 组重复即 session 行）；legacy run 维度 `putRound` 仍以它做 ON CONFLICT 幂等，而 0.16.0 引擎 store 自 P2 起只走 session 端点，改它属「为改而改」（见迁移 0016 头注释）。

### 8.6 0.17.0 迁移记录（issue #193，PR #210）

依据：`erix-agent/docs/host-upgrade-guide-0.17.0.md`。0.17.0 **纯增量**：无 API 删除、无调用点变更、无强制 store 改动，0.16.x 宿主可直接升；唯一的 opt-in 是 `appendUserTurn` 的**成对可选快路径探针**（上游 #157）。

- **依赖**：根 `package.json` 与 `runner/package.json` 的 `erix-agent` 两处 pin `0.16.0` → **`0.17.0`**（exact 风格不变），**两份 lockfile 同步**（根 + `runner/`，均仅 `erix-agent` 一项变动）。未动其他依赖、未动 `runner/` 源码（runner 的内存 peer **故意不实现探针**，见下）。
- **探针采纳理由**：POST 消息事务内的用户输入预写（`portal/src/transcript-store.js`，P3 契约①）原先每次都靠全量 `load(key)`（`SELECT round, dedup_key, record … ORDER BY round, append_seq`）仅为了两件小事：按 dedupKey 判幂等 + 取最大 round。该读的成本随 session **行数与 payload 字节数双向增长**，而它坐在接收消息的事务里（契约 Timing 要求），长会话下把 messages 插入与 run 入队一起拖长。station 的行形态（每轮一行、`record` 整块 JSONB）正好适合点查 → 采纳两探针。内置 file store 故意不实现（点查对 JSONL 无意义），station 不跟随。
- **实现**（`createSessionTranscriptStore(client)` 返回对象内、`appendRound` 之后新增两方法，**依旧复用闭包里的事务 client**，绝不换 pool）：
  - `loadByDedupKey(key, dedupKey)` → `SELECT record FROM transcript_rounds WHERE transcript_key = $1 AND dedup_key = $2 LIMIT 1`，未命中 **返回 `null`（不是抛错）**。
  - `loadMaxRound(key)` → `SELECT MAX(round) AS max_round FROM transcript_rounds WHERE transcript_key = $1`，空 key 返回 `null`（引擎派生 round 0，与全量路径语义一致），非空时 `Number(max_round)` 兼容驱动包装层返字符串的情况。
  - **成对红线**：只实现其一 = 完全不生效（引擎整块退回全量 `load`）。`portal/test/append-seq-ordering.test.js` 的源码护栏已改为同时钉住两方法都在源码里；`portal/test/transcript-store.test.js` 钉住行为（全新预写 SQL 流水 = `loadByDedupKey → loadMaxRound → appendRound`，全程**零全量 load**；命中即返回，不再取 MAX、不再 INSERT）。
- **命中保真决策**：命中时**原样返回 `record` JSONB，不合成列字段**（不同于 `load` 把 `round`/`dedup_key` 以权威列合入 record 的既有 shape）。理由：0.16.0 起的保真要求是「宿主不得按白名单重建 record」，而引擎命中面直接透传该 record（`round`/`dedupKey` 由引擎从 record 自取），点查再合成列字段只会多出一个契约 deepEqual 不期望的字段。契约套件的「命中 record 与 append 入参 deepEqual」因此直接通过，包括宿主未知字段。
- **谓词等价注记**：契约谓词为 `(record.dedupKey ?? record.roundKey) === dedupKey`，station 点查用的是**列等值** `dedup_key = $2`。等价性成立因为 `dedup_key` 列在 `appendRound` 写入时恒等于 `record.dedupKey ?? record.roundKey`（迁移 0006 部分唯一索引列，`appendRound` 开头就是这条派生）；roundKey-only 记录的回退匹配因此天然成立（契约套件该用例也过）。已在 `transcript-store.js` 方法注释里写明该等价推导。
- **上游契约套件接入结果**：`erix-agent/contract-tests` 的 `transcriptStoreContract` 已在 `portal/test/transcript-store.test.js` 末尾接入，**15/15 全绿**——但接入点是 `contractShapeFixture()`（测试侧夹具）而非裸适配器：裸适配器直跑为 **4 过 / 11 失败**，11 项全源于 station 既有 shape（按红线不用产品代码迁就）：
  - **5 项**（`append/load 往返保真`、`RoundRecord 与 message 未知字段…往返`、`多 runId 隔离`、`round 0 种子记录与保序`、`folded/foldedPayload 元数据往返`）：上游用例的记录**不带 dedupKey/roundKey**，而 station 的 `appendRound` 把 dedupKey 当硬前置（幂等主判据与迁移 0006 部分唯一索引 `(transcript_key, dedup_key)` 全依赖它；`dedup_key` 列本身 nullable，但 0006 头注释定口径为「session 行必填」）→ 裸适配器抛 `transcript store: record.dedupKey is required`。夹具：写入时造合成键、读出时剥掉（同时消除 station `load` 合成 `dedupKey` 列与上游严格 deepEqual 的 shape 差异）。
  - **6 项**（run snapshot 往返/未知 runId/多 runId 隔离、run-state 保真/终态不入快照/未知 runId）：run snapshot / run-state 在 station **不由 transcript store 承担**——真相在 `portal/src/internal.js` 的 `chat_sessions.engine_run_state*` / `runs.run_state*` 列与 `runner/lib/store.js` 的 IPC 契约面（已由 `runner/test/store-contract.test.js` 覆盖），portal 适配器不实现 → 夹具给内存桩。
  - **关键：#157 成对探针用例对真实产品探针执行全绿**（夹具直接转发产品的 `load`/`appendRound`/`loadByDedupKey`/`loadMaxRound`）：含成对约束、未命中 null、命中 record 逐字段 deepEqual（含未知字段）、roundKey-only 回退匹配、`loadMaxRound == MAX(round)`、空 store 返回 null。
- **随动的测试侧镜像**（新 SQL 面进入各 fake pool，否则 strict fake 报 `unexpected SQL`）：`portal/test/session-title.test.js`（postMessage 流水顺序红线改为「`BEGIN < messages INSERT < 点查 < transcript INSERT < run_queue < COMMIT`」，并新增「事务内零全量 load」断言）、`portal/test/llm.test.js`、`portal/test/message-precheck.test.js`（两者原本对全量 load 返回空行，行为等价）。**产品侧 `load`/`appendRound` 的 SQL 与 client 绑定方式一字未改**，`load` 作为回退路径保留。
- **gate**：根 `npm test` **767 项：766 通过 / 1 跳过 / 0 失败**（基线 746，本 PR 净增 21 = 6 条探针行为单测 + 15 条上游契约用例；唯一跳过项为既有）；`node --test runner/test/store-contract.test.js` **18/18 全绿**（较 0.16.0 基线 17 多出的 1 项即上游新增的成对探针用例——runner 内存 peer 两探针**都不实现**，成对断言 `hasDedup === hasMax` 天然通过，故 runner 源码不改）；`portal/test/transcript-store.test.js` 27/27（12 条宿主断言 + 15 条契约）；`node --check` 对 6 个改动 JS 文件全过。
- **已知语义差（真机实测定性：对预写幂等不可达）**：若存在 `transcript_key` 非空但 `dedup_key` **列为 NULL**、而 `record` 内自带 dedupKey 的历史行，全量 `load` 路径会因列→record 回退合成而幂等命中，**点查快路径则会 miss 并多写一行**（容器内真 PG 直接验证：列 NULL + record 有键 → `loadByDedupKey` 返 null；`loadMaxRound=MAX(round)` 含这类行不受影响）。dev 真机盘点（2026-10-08）：共 96 行此类形状，**全部属 `:engine:round:*` 命名空间**（旧写路径遗留，2026-09-24 后零新增）；预写幂等键空间是 `:input:<messageId>`，与 `:engine:round:` 不相交（`:input:` 形态的 NULL 列行 = 0）→ 语义差对预写顺序重放**实际不可达**，无需数据修补迁移。巡检口径：监控「`transcript_key IS NOT NULL AND dedup_key IS NULL AND record->>'dedupKey' LIKE '%:input:%'`」应为 0（而非笼统的 NULL 列计数）；新写迁移/写点仍不得引入 `dedup_key IS NULL` 的 session 行，否则预写幂等会降级为「靠 `ON CONFLICT` 兜并发、不兜顺序重放」。

- **未采纳**：上游 #160（内置 file store 幂等缓存）属包内部优化，对 station 无动作；#158 为仓库侧文档示例校验。

### 8.7 0.17.0 后续修正：失败/中止终态透传与 reason 口径对齐（issue #212，2026-10-09）

- [x] **worker 透传引擎 termination**（`runner/worker.js` catch → `runner/lib/termination.js`）：0.17.0 的失败/中止走 `fail()` **抛异常**，完整 termination 挂在错误上（`erix-agent/src/loop/orchestrator.js:758-771` 定 reason 并挂 `operation`/`phase`/`sideEffect`，`src/loop/termination.js:40-49` `annotateTermination`）。此前 station 拍平成 `{reason:'failed'}`，`persistence_failed`（run snapshot / `markRunState` 没落盘 → 崩溃恢复可能重复副作用，**语义最重**）与落盘 phase 全丢。现原样透传，引擎没给才回退旧口径；唯一保留的本地修正是竞态兜底（signal 已 abort 而引擎给兜底值 `failed` → 以 `aborted` 呈现，保住「停止」= finished，并消除旧写法下 `error.code='aborted'` 与 `termination.reason='failed'` 自相矛盾的窗口）。
  - **已接受的边界**：abort 与持久化失败同时发生时（abort 晚于 `persistence_failed` 落地），`termination.reason` 仍以引擎为准 `persistence_failed`、而 `error.code` 为 `aborted`。不算回归（旧行为下会被拍平成 `failed`），但 UI 会从「已取消」变成红色失败；不再叠本地修正，避免遮蔽真实的落盘失败。**#220 修正成因**：此前这条边界最常见的触发者其实是 portal 的缺陷——停止把 `runs.status` 置 `cancelling` 后，引擎正常的 `markRunState('running')` 被 U2 状态机拒成 409 `invalid_transition`，于是每次停止都可能变成 `persistence_failed`（e2e 里稳定复现）。现该写入已收成无副作用的 2xx ack（`portal/src/internal.js` `setRunState`，口径 `docs/api/portal.md` §9.6「停止期间的 `running` 写入」），`persistence_failed` 回到它真正的语义（真实落盘失败，dev 真机注入已验），本条边界仅在真落盘失败时才可达。
- [x] **`error.retryable` 与上游对齐**：判据 = `err.retryable === true` 或码属 `{timeout, rate_limited, server, disconnect, checkpoint_failed}`（上游 `src/providers/errors.js:1` + `checkpoint_failed`）。此前是手写半截清单（只认 `checkpoint_failed` / `rate_limited`），`timeout`/`server`/`disconnect` 被误判为不可重试。
- [x] **前端红色集合补两值**（`portal/frontend/src/lib/terminationReasons.ts` 的 `RUN_FAIL_REASONS`：+`persistence_failed`、+`final_guard_unverified`，两者都走 `.syserr` 红色告警；`persistence_failed` 额外显示 `operation/phase/sideEffect`）+ i18n 双语标签（zh-CN/en）。**必须与上一条同 PR**：先透传再扩集合，否则 `persistence_failed` 会被渲染成灰色中性分隔条。
- [x] **单一常量落点**：`portal/frontend/src/lib/terminationReasons.ts`（零 import、只 erasable 语法；前端运行时 + vitest + `node --test`（Node 22 类型剥离）三端共用）。runner 侧因 FDE 镜像只 `COPY runner/*` 保留运行时镜像 `runner/lib/termination.js`，由测试钉住一致。**不新增依赖、不动 pin、不装包**。
- [x] **防漂移测试**：`portal/test/termination-contract.test.js` 断言「常量 ↔ 文档枚举表（`docs/data/model.md` §1.7、`docs/api/portal.md` §4.1/§5.3/§6.4 的 `<!-- DRIFT:* -->` 锚点）↔ erix-agent 包源码（typedef 9 值 + `persistence_failed` 字面量 + provider `RETRYABLE_CODES`）↔ runner 镜像」逐项一致，并断言引擎版本 == 常量声明版本 == 两处 package.json pin（升级引擎即 tripwire）。前端侧 `portal/frontend/src/lib/terminationReasons.spec.ts` 锁「常量 ↔ `useEventStream` 同一 Set 实例 ↔ i18n 双语键集」。
- [x] **`docs/data/schema.sql` 采用方案 A：一个字节未改**（`git diff` 为空）。理由（已写进 `docs/data/model.md` §1.7 口径注）：`portal/src/migrate.js:138` 对**整个 schema.sql 文本（含注释）**算 sha256，`:154-172` 与库中 baseline checksum 不符即 `refusing to start`，且该校验在增量迁移循环（`:185`）**之前**——「加一条迁移去 UPDATE checksum」救不了它。权威 reason 枚举落在 model.md §1.7 与 portal.md §4.1/§5.3，schema.sql 内那段注释（v0.3.5 + 已不存在的 `reflection_stop`）明确降级为「baseline 冻结的历史快照，不作为真值来源」；`deploy/migrations/` 亦未新增。
- [x] **测试**（合并 #213 后的全量口径）：根 `npm test` **796 项：795 通过 / 1 跳过 / 0 失败**（基线 767 = 本次净增 15（防漂移契约 6 + runner 终态信封 9）+ #211 净增 14）；`cd runner && node --test` **150/150**（基线 127 + #211 14 + 本次 9）；前端 `npm run typecheck` 干净、`npm test` **23 文件 / 317 通过**（基线 22/308，净增 9）。唯一跳过项为基线既有。
- [ ] **待办（主 agent）**：真机 e2e——造一次快照写失败，确认工作台红色告警且能看到 `phase`（步骤见 issue #212 / 本次交付报告）；以及 reason 全集若随引擎变更，按本节流程重开 issue。

### 8.8 0.18.0 迁移记录（上游 #176 / #180 / #182，2026-10-09）

依据：0.18.0 的 CHANGELOG + 包源码逐项核对（本工单不依赖 host-upgrade-guide 走查项）。对本项目是**终态口径的机械升级 + 三条 additive 红利的定点接入**：`reason` 全集、provider `RETRYABLE_CODES`、`persistence_failed` 字面量与我们的常量/文档**逐项一致**，终态语义零变化。

- [x] **依赖**：根 `package.json` 与 `runner/package.json` 的 `erix-agent` 两处 pin `0.17.0` → **`0.18.0`**（exact 风格不变），**两份 lockfile 同步**（根 + `runner/`，diff 里只出现 `erix-agent` 的 version/resolved/integrity 三行），未动其他依赖或任何其他 lockfile 条目；`npm ci` 后两处 `node_modules/erix-agent/package.json` 均为 `0.18.0`。
- [x] **tripwire 复核无变化**：`portal/test/termination-contract.test.js` **6/6 全绿**（常量 ↔ 文档枚举表 ↔ runner 运行时镜像 ↔ 包源码四条交叉核对零漂移，**未放宽任何断言**）。常量声明版本 `ENGINE_VERSION_FOR_TERMINATION_REASONS` 随 pin 同步为 `0.18.0`（`terminationReasons.ts` 头注与前端 vitest 断言同步跟上）；reason 集合**内容**零改动（0.18.0 全集没变）。注释里引用的上游行号刷新到 0.18.0 实际位置（typedef `orchestrator.js:511`、`persistence_failed` `:973-977`、`annotateTermination` `src/loop/termination.js:74-91`）。§8.5/§8.6/§8.7 与 #193 成对快路径相关历史注释（含 `portal/test/append-seq-ordering.test.js` 钉住的那条头注）**一个字节未动**。
- [x] **#180 接入（失败终态不再谎报零用量）**：`fail()` 上抛的错误除 `termination` 外还挂与 `makeResult` **同一对象口径**的 `usage`/`rounds`（`orchestrator.js:950-1008` 尾端 `:995-1000` 交 `readLoopPayload()`，`src/loop/termination.js:74-91` 挂载；累加器 `orchestrator.js:1513/1527/1733`），形状与正常路径的 `result.usage` 同形（`{input_tokens, output_tokens, 可选 cacheRead/cacheWrite}`，typedef `:511`）故**原样透传**。落点：`runner/lib/termination.js` 的 `buildFailureEnvelope` 增返回 `usage: err?.usage ?? {input_tokens:0, output_tokens:0}` 与 `rounds: err?.rounds ?? 0`（引擎没挂 → 回退零值，**不抛错**），`runner/worker.js` catch 消费二者（`final_text: ''` / `title: ''` 不变）。测试口径：`runner/test/termination.test.js` **净增 4 例**（①带真值 ②没挂→回退零值、只挂一半各自回退 ③`aborted` 带真值且保留 termination 里的 `partial` ④含 cache/total 类额外字段时原样保留），并把「worker 调用形状」断言由两字段**收紧**为四字段解构。
- [x] **#182 收口**：诊断事件 `model_metadata_missing` 加入 `portal/src/http.js` 的 `HISTORY_EVENT_TYPES`（此前 SSE 实时能推到、刷新后历史回放被白名单过滤 = 同一事件两种可见性）。**前端零改动**：`useEventStream.ts` 的事件 `switch` 已有 `default: return;`（`:382`）中性忽略未知类型，不新增 UI 元素、不加 i18n 键。`docs/api/portal.md` §5.x 历史端点白名单枚举同步该类型；测试：`portal/test/session-events-history.test.js` 新增一例（该类型可回放且 payload 原样下发，`run_end` 仍不下发）。
- [x] **#176 只补文档（零运行时改动）**：`reason === 'failed'` 的终局可带 additive 字段 `termination.errorCode`（引擎把错误上已有的分类码原样透出，无分类码则 `unknown`，**值域由引擎定义**；`src/loop/termination.js:43-57` + `orchestrator.js:981-984` 调用）。我们是「原样透传引擎 termination」，运行时零改动即已下发，故只写文档：`docs/api/portal.md` §4.1 字段表 / §5.2 `run_end` 事件行 / §5.3 注，与 `docs/data/model.md` §1.7 口径注；`docs/design/runner-integration.md` §7.5 第 9 步的 reject 载荷同步为 `{ok:false, termination, error, usage, rounds}`。
- [x] **`docs/data/schema.sql` 沿用方案 A：一个字节未改**（`git diff` 为空），理由同 §8.7：`portal/src/migrate.js:138` 对整个 schema.sql 文本（含注释）算 sha256 做 baseline 校验且它在增量迁移循环**之前**，改注释即 `refusing to start`。
- [x] **未采纳**：**#181**（provider `defaultHeaders`/`extraBody`）——理由：station 不包装 fetch，`runner/` 内无自包 fetch / 自定义 header 代码，接了是空操作；0.18.0 的 `searchText` / `edit` 新文件工具、`createFileTools` 与 skills loader 导出——属 issue **#228** 迁移范围，另派单（本次 `runner/lib/file-tools.js` 一字未动；文件工具部分**已交付**，见 §8.9，skills loader 仍未动）。`judge` 的 `writeToolNames` 默认值 0.18.0 变为 `["writeFile","edit"]`，本站 `runner/worker.js` 只传 `reflection: {enabled: true, roundJudge: true}`、未显式传该字段，**不需动**。
- [x] **测试口径（M6 全量复跑）**：根 `npm test` **807 项：806 通过 / 0 失败 / 1 跳过**（基点 `06b91c8` 基线 800 项：799 通过 / 1 跳过；净增 7 = 上游契约套件 +2、#180 用例 +4、#182 用例 +1）；`cd runner && node --test` **155 通过 / 0 失败**（基线 150；净增 5 = 上游契约 +1、本次 +4）；`node --test portal/test/termination-contract.test.js` **6/6**；唯一跳过项为基线既有。前端（`portal/frontend/node_modules` 本不存在，按工单以 `NODE_ENV=development npm ci` 装上后跑；**未向仓库引入任何前端 lockfile 变动**，装完 `git status` 仍干净）：`npm run typecheck`（`vue-tsc --noEmit`）**干净无报错**、`npm test`（vitest）**23 文件 / 321 测试全通过**（含 `terminationReasons.spec.ts` 里随 pin 同步为 `0.18.0` 的版本断言）。docker / compose / e2e 未跑（真机 e2e 归主 agent）。



### 8.9 文件工具迁上游（issue #228，2026-10-10）

依据：station issue **#228** / 上游 erix-agent **#184**（`createFileTools` 规范实现 + `fileToolsContract` 契约套件）。
`runner/lib/file-tools.js` 里那份 **erix-agent 0.3.5 文件工具 fork 停止演进**，改为装配上游实现；
`createJail` / `JailError` **不是** fork 的一部分（它们是 ADR-009「库不提供沙箱，牢笼由宿主提供」下的宿主边界），
行为与导出**逐字未动**。fork 的两个已知缺陷面（`readFile` 无上限 `readFileSync` → `RangeError: Invalid string length`、
`rg` 的无效正则 `new RegExp` **抛异常**）由上游实现消掉，本站不再在 fork 上打补丁。

- [x] **装配层落点**：`runner/lib/file-tools.js` 保留文件名，新增 `createStationFileTools({ jail, cwd, maskedPaths, allowRead, allowWrite })`，返回 runner 注册面需要的 `{ definitions, schemas, executors, executeTool, exposedToolNames }`：`definitions` = 上游全量 7 个（= `executeTool` 能执行的全集，也是上游契约套件的入参面），`schemas` / `executors` = 白名单过滤后的注册面。**`executors` 必须是 name→fn 对象**：上游原生那个 `executors` 是**函数**，`{ ...fileTools.executors }` 会铺出空集（worker 侧因此零适配代码）。fork 的四个 executor 与其专用辅助（`splitLines` / `readablePath` / `isMasked` / `normalizeSchema` / `normalizeNonNegativeInteger` / `MAX_FILE_BYTES` / `MAX_TREE_ENTRIES` / `ABORT_CHECKPOINT_EVERY` / 本地 `schemas` 表）全部删除，旧导出名 `createFileTools` 从本站消失（`grep -rn createFileTools runner/` 只剩上游 import 与测试内局部名）。
- [x] **契约决定：工具面只暴露 5 个**（§3.1）：`STATION_FILE_TOOL_NAMES = readFile / searchText / tree / edit / writeFile`，**不暴露弃用别名 `rg` / `grep`**（新宿主不继承弃用面）。白名单只列**名字**，schema 本体取自上游 `definitions`（契约测试断言逐字相等）——不复制一份工具清单。注册进 `createToolRegistry` 后别名拿不到 executor（测试钉 `Unknown tool: rg` / `Unknown tool: grep`）。
- [x] **边界谓词「相与」不是替换**（§2 接线红线）：喂给上游的 `allowRead` / `allowWrite` = **调用方谓词 ∧ ¬遮蔽 ∧ jail 谓词**；替换会让宿主注入的谓词静默失效。测试两面都钉：jail 全放行时调用方 `allowRead=false` 必须仍挡、调用方默认放行时 jail 越界必须仍挡。jail 的 `JailError` 在谓词里转成布尔，非 `JailError`（如 realpath 撞 EACCES）照旧上抛不静默吞。
- [x] **`maskedPaths`（密钥遮蔽）保命点**：上游契约**不覆盖**这条，必须自带测试——`runner/test/file-tools-contract.test.js` 分别钉 jail 侧 `maskedPaths` 与装配层 `maskedPaths` 入参：被遮蔽文件 `readFile` 拿不到内容（错误文本、一字节不泄露）、`searchText` 把它计入模型可见排除账（`[已跳过 … N 个宿主边界拒绝的路径]`）与 `metadata.searchSkipped.deniedPaths`、`tree` 不列出。**口径与 `createJail.assertReadable` 逐字对齐：只挡读、不挡写**（fork 同口径；`edit` 只吃写边界，所以遮蔽文件对 `edit` 仍可写——这是继承行为，不是本轮新洞）。
- [x] **`max_bytes` 口径**：**不显式设默认**，跟随上游 `FILE_READ_MAX_BYTES_DEFAULT = 262144`（`ERIX_FILE_READ_MAX_BYTES` 可覆盖，钳 1024–4194304）；FDE 镜像 / 容器**不注入**该变量（`docs/env.md` 未新增条目，`provisioner` 下行集未变）。行窗口是**流式**的（实测 82.9MB 文件取第 100 万行起 3 行 = 349ms / RSS +12MB），单次返回不超过 max_bytes（契约钉住）。
- [x] **`judge.writeToolNames` 口径**：**不显式传**——0.18.0 默认已是 `["writeFile","edit"]`，与本站新工具面天然一致（`edit` 是第二个写工具，写边界也走同一个 jail 谓词）；`runner/worker.js` 仍只传 `reflection: {enabled: true, roundJudge: true}`。
- [x] **中止链（issue #211 保证不回退）**：上游遍历类工具（`tree` / `searchText` / 别名）自带 checkpoint——每 32 项让出事件循环 + 查中止，**比 fork 的入口检查更强**（实测 24k 条目在 100ms 被 abort → 101ms 抛 `AbortError`）；但上游 `readFile` / `writeFile` / `edit` **不接 context**，所以装配层在入口统一补一次 `throwIfAborted`，保住「已中止的 run 不再开工」。worker 的 `executeTool` 包装把 `options.signal` 注入 `context.signal` 那条链路一字未动（`runner/test/abort-signal.test.js` 的源码级钉随实现等价改写：装配层入口查中止 + 两种调用形态都把 signal/context 下给上游 + 上游 checkpoint 仍在，上游若删掉 checkpoint 即 tripwire）。
- [x] **`tree` 根标签在装配层收口成 `./`（#228 真机验收后的修复，保住 #64 语义）**：上游只对 `path === "."` 给 `./`，其余根写法给工作目录 basename；真机上模型会把这个标签拷回去当下一次 `path` 并 ENOENT（`hello-station/` → `…/hello-station/hello-station`）。收口只动根标签（入口归一成 `path: "."` + 出口对「解析后就是根」的写法兑换首行），条目 / 截断 marker / 排除账一字不动，真实子目录名不过度归一。**上游侧已提单（erix-agent #215），上游修好后这段可撤**。
- [x] **前端兼容三套返回形态**（M3）：上游按工具分三套返回——`readFile` / `tree` / `edit` → **string**（截断信息写在尾部 marker）、`searchText` → **`{content, metadata}`**（metadata 进 transcript、**不上 wire**）、`writeFile` → **number**。新增 `portal/frontend/src/lib/toolSummary.ts#getToolResultSummary()`，在**两条入口**收敛成字符串：`useEventStream.ts` 的 `tool_result.result_digest` 与 DTO 投影 `projectToolCard` 的 `resultPreview`；`StreamPanel.vue` 展开区再走一次（幂等）防御。`{content, metadata}` **只展示 content**——截断/跳过信息本来就在 content 的 marker 文本里，**不另造 UI、不新增 i18n 文案**；`number` 0 不再被 `!!part` 判空吞掉，`null/undefined` 退化成空串。
- [x] **语义变更清单（模型 / 用户可见；旧 → 新 + 依据）**：
  1. **`rg` 退役 → `searchText`**：`mode` **必填**且无默认（`literal` / `regex`），缺失或非法直接错误结果、不猜（旧 `rg` 默认按正则）。依据：工单 §3.1 + 上游 #195。
  2. **搜索返回形态**：`rg` 返回 string → `searchText` 返回 `{content, metadata}`（`searchHits / searchMatchedLines / searchFiles / searchLimit / searchOffset / searchTruncated / searchNextOffset / searchSkipped{vendorDirectories,hiddenDirectories,largeFiles,binaryFiles,deniedPaths}`；模型侧仍读 marker 文本）。
  3. **无命中口径**：旧 `rg` 返回**空串**（模型分不清「没搜到」与「被静音」）→ 上游统一 `（无命中）`（有排除账时同批给出）。
  4. **越界 / 非可写 / 遮蔽**：旧形态 **抛 `JailError`**（引擎侧成 `is_error`）→ 新形态是上游统一的 `错误：读取被宿主边界拒绝：<相对路径>` / `错误：写入被宿主边界拒绝：…` **文本结果**且**不落盘**；`createJail` 自己照旧抛（jail 行为零变化，只是被谓词转成布尔）。
  5. **无效正则**：旧 `new RegExp(...)` **抛异常** → 新返回 `错误：无效正则：…` 文本。
  6. **`readFile` 有界 + marker 文案**：旧无上限整文件 `readFileSync`（>~512MB → `RangeError`）、续读提示 `[共 N 行，offset=M 继续]` → 新默认单次 ≤ 262144 字节、marker 升级为 `[共 N 行，剩余 K 行；下一步：readFile 传 offset=M 继续]`，触顶/未扫全/超宽行各有独立 marker（`[本次返回已达 max_bytes=…；下一步…]`、`[文件 … > max_bytes=…，行窗口之后的内容未读取；…]`、`[单行超过 max_bytes=…，已截断 …（文件 …，…）；下一步：readFile 传 offset=…, limit=1 并提高 max_bytes]`），字节数走可读单位（4KB 而非 4096）。行号与「共 N 行」口径不变。
  7. **搜索上限与行宽**：`max_results` / `maxResults` 都收、默认 50、**硬上限 200**（旧 fork 无硬上限）；超长命中行截到 500 字符 + `…`（旧 fork 原样返回整行，一条 minified 行可达几百 KB）。
  8. **`tree` 截断不再静默**：旧截到 500 条不给提示 → 新带 `[另有 N 条未列出，条目上限 500 已达；…]` 与 `[另有 N 个目录未展开，depth=… 已到上限；传 depth=… 查看更多]`。
  9. **`tree` 根标签：station 在装配层把根标签归一成 `./`（issue #64 语义保住了）**。上游 `createFileTools` **只对 `path === "."`** 给 `./`，`''` / `'./'`（含尾斜杠变体）/ 缺省 / `null` 会给成**工作目录 basename**——即 #64 那个修复在上游只被覆盖了一半。**真机证据（#228 真机验收，共享 dev 栈 / `fde-eric`）**：模型调 `tree {path:"./"}` 拿到首行 `hello-station/`，照着输出再调 `tree {path:"hello-station/"}` → `ENOENT: no such file or directory, stat '/home/erix/projects/hello-station/hello-station'`、`ok:false`——**真的失败一次并浪费一轮**，不是「属上游语义、本站不动」能交差的量级。因此 `createStationFileTools` 在 `tree` 上做**只动根标签一处**的收口：入口把根写法归一成 `path: "."`（走上游自己的 `./` 分支；上游的 `path` 只用于「解析目标 + 根标签」两处，条目与 marker 一律不引用它，所以不需要重算目录树），出口再兑一道（结果首行仍是工作目录 basename 就换成 `./`，同时接管「绝对根路径 / `sub/..` 这类解析后就是根的写法」，并在上游改了 `"."` 分支时兜住）；真实子目录名（`sub` / `sub/` / `sub/deeper`）**不被归一**，同名子目录的标签仍是它自己。测试：`runner/test/file-tools.test.js` 5 条（五种根写法 + 结构化调用形态、条目/marker 逐字不变、不过度归一、真机链路回归 + ENOENT 反证）。**上游侧已另行提单**（tree 根标签应由上游统一），**上游修好后这条收口可以撤**（同时删对应测试与这里的口径）。
  10. **默认跳过 vendor / 点目录**：旧遍历连 `node_modules` 一起扫 → 新默认跳过 `node_modules/dist/build/target/vendor` 与 dot 目录，尾部给 `[已跳过 …]` 且 `include_vendor` / `include_hidden` 可撤销。**默认搜不到 node_modules 里的东西**是本轮最容易被模型（和用户）感知的变化。
  11. **遍历不跟随 symlink**：上游遍历 `entry.isSymbolicLink() → continue`（旧 fork 会进 root 内 symlink 指向的目录）；单文件路径读写仍可穿透 root 内 symlink（用例仍绿）。root 外 symlink 仍被 jail 挡（现在是错误文本，见第 4 条）。
  12. **`edit` 进入工具面**（上游 #191）：`edits: [{oldText, newText}]`（也吃单对象 / JSON 字符串），**只做逐字节精确匹配**（无 NFKC / 弯引号 / 行尾空白兜底），0 命中与多处命中都是错误结果且整次不落盘，保留 BOM/CRLF，成功回显短 unified diff；写边界与 `writeFile` 同一个 `allowWrite`。
  13. **遮蔽不再全静默**：`maskedPaths` 命中的条目在遍历里计入排除账并在尾部 marker 明说「N 个宿主边界拒绝的路径」（旧 fork 静默跳过）；**内容仍一个字节都不回传**，模型只知道「有东西被挡」，不知道是什么。
  14. **中止强度提升**：遍历内真中断（每 32 项让出 + 查中止）取代 fork 的自研让出点；`readFile` / `writeFile` / `edit` 的入口检查由装配层补齐 → 「已中止的 run 不再开工」这条保证覆盖面从 4 个工具扩到 5 个。
- [x] **测试口径（M5 全量复跑 2026-10-10，以及 tree 根标签收口后的复跑）**：根 `npm test` **845 项：844 通过 / 0 失败 / 1 跳过**（基点 `edb94e6` 基线 807 项 / 806 通过 / 1 跳过；净增 38 = 上游契约套件 +28、station 装配特有 +5、`file-tools.test.js` 等价改写后 +2、根标签收口 +3）；`cd runner && node --test` **193 / 193**（基线 155；`node --test runner/test/` 这种「目录当参数」的形式在本机仍是坏的，与本次改动无关）；前端 `npm run typecheck` 干净、`npm test` **23 文件 / 329 通过**（基线 23 / 321，净增 8；根标签收口未动前端）；上游 `fileToolsContract` 是 **28 项**（工单写 29，0.18.0 实际套件是 28 个 `test(...)`），本站喂的是自己的装配工厂而非上游 `createFileTools`。唯一跳过项为基线既有。
- [x] **未动**：`docs/data/schema.sql` **一个字节未改**（`git diff` 为空；`portal/src/migrate.js:138` 对整文件算 sha256 做 baseline 校验，理由同 §8.7）；reason 常量与 `runner/lib/termination.js`；两份 `package.json` pin 与两份 lockfile（**不新增依赖**）；`runner/lib/shell-tools.js` 行为；`lib/abort.js`（继续给 shell 工具与装配层入口检查用）；skills loader（上游 #197，属另单）；docker / compose / e2e 未跑（真机 e2e 归主 agent）。
- [ ] **待办（主 agent）**：真机 e2e 看三件事——① 模型在新工具面上是否用得顺（尤其 `searchText` 的 `mode` 必填与默认跳过 `node_modules`）；② **`tree` 根标签收口已在装配层落地并有单测，但需真机确认收口真的生效了**（重跑 #228 那条链路：`tree {path:"./"}` 首行应为 `./`，拿它当下一次 `path` 不再 ENOENT）；③ 密钥遮蔽在真实项目（含 `.env` / `.ssh`）上的实际效果。


### 8.10 `worker.js` 的 SYSTEM_PROMPT 必须跟着上游工具面走（feat-261010-02，2026-10-10）

背景：#232 把文件工具换成上游 erix-agent 0.18.0 后，`runner/worker.js` 的 `SYSTEM_PROMPT` 还停在退役 fork 的时代（写着「只有 `writeFile`，没有 `edit`」、`grep`/`rg` 当可用工具、完全没提 `mode` 必填与默认跳过 `node_modules`）。模型对工具的错误先验会直接变成真失败：盲发没有 `mode` 的 `searchText`、把 `（无命中）` 当成「工具坏了」去 shell 里 `grep -r`、把 `edit` 的 0 命中当「大致一样」重试。

- [x] **提示词只描述真实注册面**：`readFile` / `searchText` / `tree` / `edit` / `writeFile`（名字以 `createStationFileTools(...).schemas` 为准）；`rg` / `grep` 只能以「退役别名、没注册」的面目出现。要写的语义：`searchText` 的 `mode` 必填无默认值、默认跳过 `node_modules`/`dist`/`build`/`target`/`vendor` 与点目录、尾部 `[已跳过 …]` 是**排除账而不是错误**、`include_vendor=true` / `include_hidden=true` 可撤销、`（无命中）` ≠ `错误：无效正则：…` ≠ `错误：…被宿主边界拒绝：…`；`edit` 是 `edits:[{oldText,newText}]` 且**只有逐字节精确匹配**（0 命中 / 多处命中都失败且整次不落盘）；`readFile` 单次 256KB 上限且截断 marker 自带下一步（`offset=` / `max_bytes`）。
- [x] **不抽独立模块**（工单留给实现判断）：继续留在 `worker.js`。理由——`worker.js` 是子进程入口，顶层就 `fork`/`process.on` 并起 IPC，抽成可 import 的模块要么入口变双入口（agentd `fork(config.workerPath)` 的路径契约要跟着改），要么在提示词与工具面之间新增一个跨模块契约；而防漂移靠源码级断言已经够（`system-prompt.test.js` 用正则从 `worker.js` 源码抠出 `SYSTEM_PROMPT` 模板字面量，**不 import worker**，避开它的顶层副作用与 `process.send` 判据）。
- [x] **防漂移测试的工具名来自注册面，不是手抄清单**：`runner/test/system-prompt.test.js` 从 `createStationFileTools(...).schemas` 取名字再逐个断言提示词提到它（与 `file-tools-contract.test.js:400-407` 同思路）。上游改名时，这条测试跟着改名；手写一份名字清单只会多一个会过期的真相源。
- [ ] **待办（主 agent）**：真机看模型在新提示词下是否不再盲发无 `mode` 的 `searchText`、是否不再把 `（无命中）` 当故障去 shell 里 `grep -r`（§8.9 待办 ① 的后续）。

### 8.11 预览鉴权的 CORS 口径（issue #241，2026-10-11）

背景：前后端分离的 FDE 应用（两个预览 host）在浏览器里“只要用到 `Authorization` 就必挂”。
真机定位：平台把 CORS 预检（`OPTIONS`）也送去鉴权，而预检按 Fetch 规范**不携带任何凭据**；
deny 的 403 又**不带 CORS 头**，于是浏览器报 `No 'Access-Control-Allow-Origin'`，把「需要预览票据」伪装成「应用 CORS 配错」。

- [x] **两条口径**（实现：`preview.js:isCorsPreflight` + `authorizeForwardAuth` 预检分支、`http.js:corsDenyHeaders` + deny 分支）：
  ① `OPTIONS` **且**带非空 `Access-Control-Request-Method` → 只免**凭证/exposure** 判定，第 1/2 步 fail-closed 照旧
  （未知 host 仍 404、已释放仍 403）；不带 ACRM 的裸 `OPTIONS` 仍 403；预检无主体，**不**触发 `allocated→active` 升级。
  ② deny（401/403/404）一律带 `Access-Control-Allow-Origin`（**回显**而非 `*`，带凭据时规范禁止通配）
  + `Allow-Credentials: true` + `Vary: Origin`；只接受 `scheme://host[:port]`（含 IPv6）或 `null`，多值/含 CR-LF 不回显（防头注入）；无 `Origin` 则不造 CORS 头（curl 响应体字节不变）。
- [x] **落点为何在 portal 而不在边缘**（实测依据，不是偏好）：`traefik:v3.7.13` 在 forwardAuth 非 2xx 短路时**会把 auth 子响应的状态码/响应体/自定义响应头透给客户端**（逐跳头 `Connection`/`Keep-Alive` 被丢），所以 portal 自己回显就生效；反之在边缘加 `cors`/`headers` 中间件会与上游 dev server 自带的 ACAO 叠成两个值（`ReverseProxy` 对后端响应是 **`Add` 而非 `Set`**）→ 浏览器报「multiple values」而**打断本已正常的带凭据请求**。预检被放行后由应用自己回 `Access-Control-Allow-*`（平台不代答）。
- [x] ⚠ **最容易复发的坑**：`forwardAuth.authRequestHeaders` 是**白名单**（不在列的头一律不进 auth 子请求）。portal 想读 `Origin` / `Access-Control-Request-Method` 就必须同时把它们写进**生成器** `portal/src/routes.js`；只改 portal 而忘改白名单，两条修正会**默默失效**（测试只能靠 `routes.test.js` 的字节快照钉住）。生成产物 `deploy/traefik/dynamic/routes.yml` 禁手改。
- [x] **审计枚举**：`details.grant_kind` 新增 `preflight`（`actor_id` 为 `NULL`），口径已同步 `docs/api/portal.md` §2.7；测试基线 **862/861/0/1**（净增 7 条，`docs/ops/ci-release.md` §1 与 `ci.yml` ② 注释同步）。
- [ ] **未做（已记录）**：FDE 级 grant（一次签票给整组 host 发 cookie，免「要点两次预览」）在 #241 正文另议；
  前端 host 自己的 dev server 不答 `OPTIONS`（返 200 + HTML 且无 ACAO）属**应用侧**，不在平台范围。



### 8.12 开户预分配 10 条 FDE 级预览域名（issue #240，2026-10-11）

> ⚠ **更正（issue #246 交付①，2026-10-11；原记录不删，只标失效项）**：本节的**分配粒度 = FDE 级**、
> 一次一段、`scope='fde'` / `role='spare'` / `state='allocated'` / `exposure='private'`、告知两处、
> 「派生同事务 + 靠部分唯一索引幂等」全部仍然成立；**以下四项已被 #246 取代**：
> ① **端口不再固定 `4000–4009`**——全局只有一个号池 `22000–29999`（800 段），开户默认发「池内最小的未占用
> 对齐块」（第 1 个 FDE `22000–22009`、下一个 `22010–22019`…，块大小 10），管理员可覆盖块起点/单端口；
> 常量单一来源 `portal/src/previewpool.js`（新叶模块，避免 portalloc↔projects 的 ESM 循环依赖）。
> ② **「该索引不能改成全表 UNIQUE」这句只对 `(fde_id,port)` 成立**：#240 那句「`port` 唯一性只按 FDE 判 ⇒
> **允许不同 FDE 同端口**」正是 bug 本体（真机 eric 与 tetris 同时持有 4000–4009 ⇒ 10 组重叠域名）。
> 迁移 **0019** 新增 `port_allocations_live_global_port_key UNIQUE (port) WHERE state <> 'released'`：
> 重叠在 **DB 层**不可能；`released` 行不占位 ⇒ **号码可回收复用**（这条是 #246 的硬判据）。
> ③ **「存量不迁移」已作废**：0019 把活行按 `fde_name` 定序重排进号池（`hostname`/`url` 同事务重写，base 域从
> 旧 hostname 反推、不硬编码伞域），装不进一段的溢出活行（真机只 `tetris` 的 4100）置 `released`；`released`
> 历史行（真机 `portsprobe` 的 4000–4009）保留旧号码。已接受代价：**eric/tetris 现有预览 URL 全改写**。
> ④ **预览域名预算 56 → 55**：端口段从 4 位变 5 位（首标签固定段 `-p-`+端口位数 = 8），预算必须从**池宽度**
> 推导而不是写死端口（写死 `4000` 会让 56 字符名过应用校验、再到 INSERT 被 0017 的 CHECK 炸成裸 23514）。
> 告知文案（`worker.js` SYSTEM_PROMPT、materializer 的 `AGENTS.md` 行）不再写端口数字，改说「**段由平台从
> 号池分配，`ports.json` 是唯一真相**」；防漂移测试随之改成「两处都不允许出现端口数字」。
> 当前全量口径见 fde-platform §8.2 与迁移 `0019-preview-port-pool.sql`；本节里的 `40XX` 域名样例、
> 「预算（56）」、「存量不迁移」均按上述更正读。

背景：`port_allocations` **从来没被产品代码写入过**（全仓 `INSERT` 0 命中），手工插行后 `routes.yml` 与容器内 `ports.json` 也一律不动，必须人工调
`enqueueFullRebuild` + `runMaterializerOnce`。本轮按决策者裁决实现「开户即预分配」并消灭那个人工动作。

- [x] **口径（决策者 2026-10-11）**：分配粒度 = **FDE 级**，固定 **10 条**（端口 `4000–4009`），`scope='fde'` / `role='spare'` / `state='allocated'` / `exposure='private'`；
  所谓「分配」的实质是 **在 Traefik 侧预建预览路由与域名**，**FDE 容器自己监听什么端口平台不管、不校验、不 reconcile**（「严格管理」这条设想作废，改为告知 + 尽力）。
  告知两处：容器内 `~/.erix/ports.json`（materializer）+ `runner/worker.js` 的 `SYSTEM_PROMPT`（materializer 还会在 FDE 家目录 `AGENTS.md` 里加一句）。
- [x] **写入口** `portal/src/portalloc.js`：`ensureFdePreviewPorts`（调用方事务内）+ `provisionFdePreviewPorts`（自起事务）；`onboardFde` 在「网络与容器已落地之后、LLM 联动之前」调用（预览域名正确性不依赖 LiteLLM 可达）。
  **写库与 route outbox / materialize revision 入队同一事务**，顺序固定：`BEGIN → 10×(INSERT → route_revisions → route_outbox) → materialize_revisions → materialize_outbox → COMMIT`（测试逐序 deepEqual）。
- [x] ⚠ **幂等只能靠既有部分唯一索引 + 带谓词的 ON CONFLICT**：`ON CONFLICT (fde_id, port) WHERE state <> 'released' DO NOTHING`——**不写谓词真库直接报** `there is no unique or exclusion constraint matching the ON CONFLICT specification`（已在真库复现）。
  该索引**不能**改成全表 `UNIQUE(fde_id,port)`：`released` 历史行要留档。`RETURNING id` 的行数即新写行数，0 行 ⇒ 完全不入队（不制造空转 revision）。
- [x] **迁移 `0018-port-allocations-scope-fde.sql`** 只做一件事：`port_allocations_scope_check` 放开为 `('project','run','fde')`；`CHECK ((scope='run') = (run_id IS NOT NULL))` 保留；**不新建索引**；
  建成 VALID 而非 `NOT VALID`（新集合是旧集合超集，存量必然仍满足）；`docs/data/schema.sql` **一个字节未改**（sha256 baseline 冻结，同 §8.7/§8.8）。
- [x] **存量不迁移**：遗留 `scope='project'` 行（真机 eric 4000/4008、tetris 4000/**4100**，后者在窗口之外）不改不删不回填；`routes.js:382` 只看 `state <> 'released'` 与 hostname、不看 scope，所以遗留行继续有效。
  `cli.js provision-fde --fde-name <name>` 重跑即补齐缺口（幂等，裁决第 7 条）。
- [x] **新决策（主 agent 拍）**：FDE 名超预览域名预算（56）⇒ 开户以 `preview_hostname_invalid` **失败**（`validateFdeNameForHostname` 的第四道强制点），**不降级为 warn**——
  「静默没有预览域名」正是本单要消灭的那类半截状态，且 0017 的 DB CHECK 反正会在事务中途炸掉（只是文案更烂）。`port_quota_exceeded` 已从文档删除（不再新造错误码）。
- [x] **真机验收（主 agent 亲手，不依赖 worker 自报）**：新建 FDE `portsprobe` → 开户自动写 10 行 `scope=fde` → `routes.yml` **自动**出现 10 条 `Host(\`portsprobe-p-40XX…\`)` → 容器内 `ports.json` `generation=2` / 10 条带真实 url → 签票 302 与 `allocated→active` 自动升级；
  eric 重跑 `provision-fde` 得到 `8/10 新写（2 条已存在）` → 第二次 `0/10`，`ports.json` 自动 `generation=3` / 10 条（8 `fde` + 2 遗留）。全量 **877/876/0/1**、runner **200/200**。
- [ ] **已知缺口（未在本单补）**：**签票入口缺失**（`GET /api/ports` 已随 P5 退役、SPA 内无任何端口列表/预览按钮 ⇒ 人只能靠 curl 调 API 拿票）；票据仍是 **host 级**（10 个端口要点 10 次）；
  `PORT_QUOTA` 已成死配置（文档已标注，摘除留后续 PR）；容器绑错端口（无人在听）时的可见性未量化。



### 8.13 预览端口全局号池 `22000–29999` 与块分配（issue #246 交付①，PR #248，2026-10-11）

背景：决策者裁决「端口按用户顺序发段、不许重叠，容量给到 800 段」。本节**取代** §8.12 的分配规则（原记录不删，§8.12 顶部已标失效项）。本单只做后端切片（交付①）；面板与列端口 API = 交付②。

- [x] **常量单一来源 `portal/src/previewpool.js`**（新叶模块）：号池 `22000–29999` / 默认块 10 / 800 段 / 块几何 / 域名预算。单独成模块的原因写在文件头：`portalloc.js` 已单向依赖 `projects.js`，反向 import 会构成 ESM 循环，`portalloc.test.js` / `system-prompt.test.js` 这类入口上顶层 `const` 会进 TDZ。
- [x] **重叠是 DB 保证的硬不变式，不是应用保证的**：迁移 `0019` 建 `port_allocations_live_global_port_key UNIQUE (port) WHERE state <> 'released'`。`portalloc.js` **不做**「先查后插」查重循环（有测试专门钉这一点，防将来「顺手加个查重」）；跨 FDE 抢号 ⇒ `(fde_id,port)` 冲突目标不匹配 ⇒ `23505` 冒出来 ⇒ 翻成 `preview_port_block_taken`。占用判据 = **全局活行端口**（不分 FDE/scope/role，与索引谓词同口径）；`released` 不占位 ⇒ **号码可回收**。判定块时**整块**跳过（段内有一个被占就整段不要），避免把外来行侵吞进自己段里。
- [x] ⚠ **迁移实际是四步不是三步**（worker 实测修正了工单）：**⓪ 先按名 `DROP` 旧 `port` CHECK** → ① 重排存量活行进池（按 `fde_name` 定序；`hostname`/`url` 同事务重写，base 域从旧 hostname 反推、**不硬编码伞域**；装不下的溢出活行置 `released`）→ **①′ 守卫 DO 块**（池外活行 / hostname 与端口不同步 ⇒ 带表名 RAISE，换掉裸 23514）→ ② `port` CHECK 改**按状态分支**（活行 `BETWEEN 22000 AND 29999`；`released` 行允许 `4000–29999` **保留历史号码**）→ ③ 建全局部分唯一索引。⓪ 不可省：旧区间 `4000–4999` 与新池**不相交**，带着它连 `UPDATE` 进池都当场 23514；`DROP`→`ADD` 之间的无 CHECK 窗口由「迁移 runner 单个显式事务 + `ACCESS EXCLUSIVE` 持到 COMMIT」兜住。
- [x] ⚠ **PG `lpad` 陷阱**：`lpad('22010',4,'0')` = `'2201'`（**截断**），而写侧 `String(port).padStart(4,'0')` 不截断——用 lpad 会把同块 10 行塑成同一 hostname 当场 23505。重写端口段用「截到旧端口段之前 + 新端口原样十进制 + base 后缀」。
- [x] **5 位端口连锁**：预算 `56 → 55`，且预算与探测端口都从**池上界宽度**推导（`PREVIEW_PORT_BUDGET_PROBE_PORT = PREVIEW_PORT_POOL_END`）。旧实现把 `4000` 写死在预算校验里，正是 #202 那个「56 字符名过应用校验 → INSERT 被 0017 CHECK 炸成裸 23514」的病根。边界测试：55 过 / 56 拒 / 57 拒（**`56 拒` 是相对现状的行为变化**）。
- [x] **告知面不再出现端口数字**：`runner/worker.js` 的 `SYSTEM_PROMPT` 与 materializer 生成的 FDE 家目录 `AGENTS.md` 统一改说「段由平台分配，`~/.erix/ports.json` 是唯一真相」；防漂移测试随之**禁止两处出现端口字面量**。真机证据：重绑 Tetris 的那次 run 自己去 `cat ~/.erix/ports.json` 取号，提交的标题就是「适配平台动态端口分配」，没有猜端口。
- [x] **测试口径**：根 `npm test` **889 / 888 通过 / 0 失败 / 1 跳过**（基线 877，净增 12）；`node --test runner/test/*.test.js` **200/200**；前端 `vue-tsc` 干净、vitest **23 文件 / 329 通过**。`docs/ops/ci-release.md` §1 与 `ci.yml` ② 注释已同步。`docs/data/schema.sql` **一个字节未改**（sha256 baseline 冻结）。
- [x] **真机验收（主 agent 亲手，不采信 worker 自报）**：临时库重建至 0018 → 灌真库 31 行 → 应用 0019 → 确认旧 CHECK 形态、活行端口全局唯一、eric `22000–22009`、tetris `22010–22019`、原 `4100` 转 `released` 保号、`portsprobe` 的 `4000–4009` 十条未动、`hostname`/`url` 与新端口一致、无 4 位残留、**重放幂等**（全表 md5 不变）；负例：活行 `4005` / 超界 `30001` 被 CHECK 拒、跨 FDE 撞 `22000` 被新索引拒。部署后派生链**三段全自动**：`routes.yml` 自动换成 `220XX` 且旧 `40XX`/`tetris-p-4100` 消失 → 容器内 `ports.json` `generation=3` 新 url → 签票 `302 + Set-Cookie` 且 `allocated→active` 自动升级；#241 的 CORS 行为未回退（无票 403 仍回显 `Access-Control-Allow-Origin`）；旧域名 `eric-p-4000` → 404（路由已撤）。
- [x] **已接受代价的修复也是真机跑的**：迁移后 Tetris 预览 `502 Bad Gateway`（鉴权已过、`state` 升 `active`，纯粹是应用还听旧端口）——由**平台自己的 agent** 在会话 `b35109c0…` / run `87a31661…`（`judge_done`，↑1.23M/↓12.8k）改绑到 `22010/22011` 并推送，主 agent 复跑应用测试 **22/22**，端到端 `22010` 首页 `200`、`/config.js` 指向新后端、`22011/api/healthz` `200 {"ok":true}`、`/api/leaderboard` `200` 真实数据。
- [ ] **已知边界（本单未补，交付②一并做）**：`onboardFde` 对 `preview_port_block_taken` **没有重试循环**——错误文案说「由调用方重试」，但开户路径遇错即整笔回滚，需重跑 `cli.js provision-fde`。只在「两个 FDE 同时开户抢同一块」时才触发（当前开户是 CLI/管理台串行），所以不是现实故障，但**不许拿它当已完成**。
- [ ] **仍未做**：面板 / 列端口 API / 一键签票（#246 交付②）、FDE 级 grant（#247）。
  ⇒ **列端口 API 已由单 A 交付**（2026-10-11，见 §8.14）；面板与一键签票仍是单 B。

### 8.14 预览端口列端点 + 管理员改块（#246 交付② 单 A）与撤 grant 修正（#252）（PR #251 / #253，2026-10-11）

背录：#246 拆两单——**单 A = 后端契约（本节）**，**单 B = 纯 UI（未做）**。`GET /api/ports` 随 P5 退役后根本没有任何列端口的 API，而签票端点吃的是人看不见的 allocation UUID ⇒ #240/#241 的浏览器验收全靠主 agent 手工 curl。

- [x] **三个端点**（实现全在 `portalloc.js`，`http.js` 只做分派/校验/错误映射/审计）：`GET /api/me/ports`（本人，admin 无 FDE ⇒ 空列表不是 404）、`GET /api/admin/fdes/:fdeName/ports`（**显式写恰好一行审计** `admin.fde_ports_listed`，因为现有 admin GET 并未一致落实）、`POST /api/admin/fdes/:fdeName/ports/block`。DTO 固定 8 列且**必含 `id`**（否则面板拿不到签票入参，本单就白做）。
- [x] ⚠ **改块 = 搬迁事务，不是追加**（copilot 评审拓出的错判，主 agent 复核确认：`grep -c 'UPDATE port_allocations' portal/src/portalloc.js` 当时 = **0**）：`ensureFdePreviewPorts` 是 insert-only，直接复用会让旧 10 行继续活且占号（真机就是 20 条活行）。口径：同一事务 `BEGIN → 取本 FDE 活行 → 取全局活行 →（幂等/冲突判定，零写）→ UPDATE 旧行 released → UPDATE preview_grants revoked → 10× INSERT（带谓词 ON CONFLICT）→ route 入队 → materialize 入队 → COMMIT`，任一步失败整笔回滚。真机反证：#252 那次 500 之后旧块一字未动。
- [x] **管理员显式指定的块被占 ⇒ 409 报错，禁止偷偷换块**（偷偷换段会让他以为分到了自己挑的那一段）；只有开户路径的自动选块才重算：`PREVIEW_BLOCK_MAX_ATTEMPTS = 3`（**含首试**，每次**新事务**重取占用）。注释与文档均写明 ⚠ **重试只覆盖端口分配这一段**（网络/容器已落地且不回滚；`withFdeLock` 锁键是 `fde:${fdeName}`，串行化不了不同 FDE 抢同一空闲块 ⇒ 0019 的全局唯一索引 + 新事务重算才是正解）。
- [x] **零新错误码**（全部复用 `preview_port_block_taken` / `preview_hostname_invalid` / `validation_failed` / `not_found`）；新文档面：`portal.md` **§4.7a**（DTO 理由、五段校验表、事务顺序、审计口径）+ §1.2 `preview_hostname_invalid` 首次入表；改块端点的 409 标 `retryable=false`（同码在开户路径是 retryable，差别就在「管理员指定」）。
- [x] **#252 是真机拓出来的更老缺陷（不是单 A 引入的）**：`preview_grants` 的 CHECK 是**双向**的 `((state='used') = (used_at IS NOT NULL))`（= `preview_grants_check3`），而先例谓词 `state IN ('active','used')` 会去改已消费的 ticket ⇒ **真机 45 条 `ticket|used` 一改就 23514**。`offboarding.js` 里同一谓词且撤权挂在「本次释放了行」的守卫上 ⇒ 撞 CHECK 的那笔回滚后，重试时本 FDE 已无活行 ⇒ **撤权整段静默跳过**（真机 21 条残渣而步骤记 `done`、`last_error` 空）。修正：三处（offboarding / `moveFdePreviewBlock` / **`admin.js` 停用用户**，后者原写 `used_at = NULL` 绕过 CHECK = **篡改历史**）统一只撤 `state='active'`；offboarding 改成按「本 FDE **全部** allocation ids」**无条件幂等撤**，两个计数分开打日志（`released=0 而 revoked>0` 就是补撤的形状）；数据修补走迁移 **`0020`**（零 DDL、可重放，`used`/`expired`/`revoked` 一律不动）。
- [x] ⚠ **本轮最值钱的教训：fake 必须模拟真库约束，并用变异测试验收**。#252 在单测里**结构上不可能被发现**（fake 只模拟了 `revoked ⇔ revoked_at`）。新增 `portal/test/preview-grant-checks.js`（baseline 五条 CHECK **同名同序** + **语句级原子**，两个 fake 共用，谓词从 SQL 里解析），主 agent 的**变异测试**：把谓词改回 `IN ('active','used')` ⇒ `preview-ports` 3 红 + `offboarding` 2 红并报真库原文 `23514`。⇒ **往后的约定：声称「fake 拦得住」必须附变异测试结果**（改回旧写法必须红）。
- [x] **新测试基线：根 `npm test` = 920 项 / 919 通过 / 0 失败 / 1 跳过**（2026-10-11；链路 889 → 910（单 A，+21）→ 920（#252，+9 用例 **+1 个无用例的 helper 文件**）。⚠ **`**/test/**/*.js` 会把 `test/` 目录里的任何 `.js` 算成 1 项**（含 helper，仓库既有 `fake-pool.js` 同理），所以新建共用 helper 会让总数 +1；`docs/ops/ci-release.md` §1 已写明。逐文件：`preview-ports` 24、`offboarding` 13、`migrations` 17、`portalloc` 20、runner 200。
- [x] **真机验收全绿**（主 agent 亲手，详见 #246 / #252 记录）：列端点/权限/审计恰一行/UUID 签票 302 全过；改块 `22000→22030`（released 10 / inserted 10 / revoked 21，`routes.yml` 自动换段、`ports.json` `generation` 3→4、旧域名 404）→ 幂等 `{changed:false}` 零审计 → 409 零残留 + 文案点名被占端口 → 400（非对齐/池外/非整数）→ **搬回 22000 证明号码回收**；`0020` 启动自动应用 ⇒ 残渣 `active@released` **11 → 0**，`used` 45 条 `used_at` **一字未动**，活 allocation 上 44 条 active 无误伤；人造残渣 + 步骤置 `failed` 后 retry ⇒ 日志「本次释放 allocation 0 条、撤预览 grant（仅 active）1 条」。
- [ ] **单 B（纯 UI）待做**：工作台列自己的段/域名/状态 + 每行「打开预览」（拿 `id` 调既有签票）；管理台列任意 FDE + 改块入口。⚠ **UI 必须在改块前给一次确认**——改块会让 FDE 手里的旧预览链接立即 404（已记在 #246）。UI 侧不需要新增后端。
- [ ] 未做（划界）：**#247**（FDE 级授予；因 `preview_grants.token_hash UNIQUE` + `allocation_id NOT NULL` 而定性为 **DDL 级**，已延期）、**#250**（改 exposure，已裁决不交付）。

### 8.15 v0.1.3 发布与按 digest 部署 + 单 B 真机验收 + 第二轮平台演练（2026-10-12 夜班）

经手：单 B（PR #254，纯前端）、版本 `0.1.3`、tag `v0.1.3`、GHCR 三镜像、按 digest 部署、新建 FDE `todo`、真机 e2e。详见 `docs/ops/drill-2026-10-12.md`。

- [x] **单 B（#246 交付② 预览端口 UI）已合并**：`main@4ec2e28`。**前端基线从 23 文件/329 变为 29 文件/391**（`docs/ops/ci-release.md` §1 步骤 ④ 已同步；**后端基线 920/919 不变**，因 `portal/src/**` 零字节）。主 agent 亲验：红线全净、6 个 spec 全是新增、**自己做的变异测试**（`requestMove()` 改成跳过确认直接搬迁 ⇒ `AdminPreviewPorts.spec.ts` 2 红）。
- [x] **发布与部署口径跑通（第一次真的拿发布物部署）**：三份 `package.json`+lockfile → `0.1.3`（每份 lockfile 恰好 2 行）→ `release.yml` 绿 → **`images-digest.json` 的 `imageId` 与部署机 `docker image inspect .Id` 三镜像全一致，`RepoDigests` 与清单 `digest` 一致** → `.env` 改形态① pin → `up -d --no-build`。⚠ **tag push 触发的 run 的 `event` 是 `push` 不是 `tag`**（按 `event=tag` 查会查不到）。⚠ `docker manifest inspect` 偶发失败（重试即可），**权威交叉核对走 `docker pull` + `image inspect`**。
- [x] **新建 FDE `todo` 落在新 FDE 镜像上**：开户 25 秒 done；容器 image ID == 清单 fde `imageId`（旧容器 `fde-eric`/`fde-tetris` 仍在旧镜像，`ensureFdeContainer` 不自动重建）；自动分到下一段 **22020–22029**；`ports.json` `generation=2`；LLM binding active。⚠ 建用户两个必给字段：**`email` 必填且要合法**、`git_host_id` 必须是存在的 UUID。
- [x] **单 B 真机验收全过（浏览器，不是 curl）**：折叠条 `Preview ports (10)`；10 行升序；`state` 文案无「healthy/running」且带口径行；点「Open preview」→ 新标签干净地址 + **502 Bad Gateway**（无应用监听，不是 403）；Retry 后该行变 `Admitted once`；管理台第 5 个 tab **懒挂载（恰好 1 次 GET，审计恰好 1 行）**；填 22000 点改块 → **确认前 `POST /ports/block` 请求数为 0**，确认条三要素齐全；409 **全文可见**（点名十个被占端口），失败零残留、不写改块审计。
- [x] **e2e（平台自己的 agent 写前后端分离 to-do）**：建项目 = `POST /api/sessions {cwd}`（服务端 mkdir）。四轮 run（`a08b5ab1` 18 轮 ↑504,200/↓28,326 / `7a54dfe9` 常驻 / `50ab7928` allowedHosts / `c8b24c02` CORS）。**告知面有效**：它自己读 `ports.json` 选了 22020/22021 并在 README 注明出处，没发明端口号。真机结论：多用户隔离（B 看到 `共 0 项`）、刷新持久、SQLite 直读归属正确、`password_hash` 非明文；vision 看图确认 Bootstrap 真生效。**#243 的 DSML 文本化本轮没复现**（终局是正常自然语言报告）——一个正面数据点，不是结案。
- [x] **本轮定性：预览域名下跑通一个普通前后端分离应用需要 6 条，其中 3 条未告知**（③ dev server `allowedHosts`→#257；④ 跳端口调用要带 `credentials:'include'` 因为通行凭证是 HttpOnly cookie、⑤ 后端 CORS 必须回显 `Origin`+`Allow-Credentials`⇒ #258；⑥ 每个 host 各需一次放行⇒#247）。另开 **#255**（首登不强制改密，需产品决策；**同时更正了 §六 里我上一轮写错的「首登强制改密 ✅」**）与 **#256**（号池占用总览端点，把改块从试错变选段）。**本轮靠我发第 3、4 条消息才把应用修通 ⇒ 缺口在告知面，不在 agent 能力。**
- [x] **新坑（已写进 drill-2026-10-12 §六）**：① **项目级 playwright 容器（:8935）的 MCP 版本参数名与默认实例不同**——点击/填表用 `target`（不是 `ref`）、`browser_console_messages` 必给 `level`、`browser_network_requests` 必给 `static`、`browser_take_screenshot` 必给 `scale`（**合法值只有 `css` / `device`**，写 `viewport` 会被 schema 拒）；② `POST /api/ports/:id/preview-ticket` **要求 `Content-Type: application/json`**（上一轮文档里的 curl 片段少了这个头，已改）；③ `POST /api/sessions/:id/messages` 字段是 **`content`**；④ 预览票据 60 秒过期，跳 host 要各 host 各有一票。

### 8.16 预览访问要求链的单一真相落 `~/AGENTS.md`（issue #257 + #258，工单 feat-261012-01，2026-10-12）

背景：§8.15 定性了「预览域名下跑通一个普通前后端分离应用需要 6 条，其中 3 条未告知」，#257/#258 把缺口登记在**告知面**。
决策者定稿的落点是**结构化**（不是为了省 token）：单一真相进 materializer 下发的 `~/AGENTS.md`，
`SYSTEM_PROMPT` 只留强制指针（#258 `#issuecomment-6117800165`）。前提单 **#259**（jail 家目录只读例外）与 **#247**
（FDE 级 grant，消掉第 6 条）**都不在本单**。

- [x] **`portal/src/materializer.js` 的 `renderHomeAgentsMd()` 新增「预览访问：外部浏览器要用这个应用，必须满足这 6 条」节**：
  ① 端口从 `~/.erix/ports.json` 取（不要发明端口）② 监听 `0.0.0.0` ③ **把预览 host 加进 dev server 自己的主机白名单**
  （host 取该条 `url`、窄范围优先、后缀匹配要说明它放开整棵子域、**禁 `allowedHosts: true` / `"all"` 一把梭**、
  Vite `server.allowedHosts` vs webpack-dev-server `devServer.allowedHosts`、其它框架按实际版本核实）
  ④ **跳预览端口调用要带凭据**（`credentials:'include'`，通行凭证是 host-only `HttpOnly` cookie）
  ⑤ **后端 CORS 不能回 `*`**（回显 `Origin` + `Access-Control-Allow-Credentials: true` + `Vary: Origin`，
  `OPTIONS` 预检不带凭据要在鉴权**之前**答）⑥ **每条预览 host 各需一次放行**（前端有票 ≠ 后端有票，现阶段逐条点「打开预览」）。
  外加**错误形态对照**：`Blocked request. This host … is not allowed.` = 应用给的 / `{"error":{"code":"preview_ticket_required",…}}` =
  平台边缘给的 / `502 Bad Gateway` = 没人在监听；并要求把 `code`/`message` 渲染出来而不是 `[object Object]`。
- [x] **红线由测试钉死**：新节零端口数字与端口区间（全文 4 位数只允许出现文件权限 `0644`）、全文零伞域字面量
  （不只禁现网那个值，也按**形状**禁 `fde.<可注册域>` 与 `localhost`）；`isPlatformManagedPath()` 导出并钉死
  「home 级 `AGENTS.md` 属平台文件」这个精确分支（它恒在 desired plan 里，从 stale 清理路径跑不到，只能直接钉）。
- [x] **`runner/worker.js` 的 `SYSTEM_PROMPT` 只加一句强制指针**（预览段首行「开工前先读 `~/AGENTS.md`」+ 本节有意不复述规则），
  并把「家目录文件工具读不到…用 shell 读」那句从只覆盖 `~/.erix/ports.json` **扩到同时覆盖 `~/AGENTS.md`**
  （#259 落地前 `createJail({ root: cwd })` 无只读例外，`readFile` 会撞「被宿主边界拒绝」白烧一轮）。**6 条一条也没拄进提示词**。
- [x] **单一来源防漂移断言（提示词里不得出现 `allowedHosts` / `credentials` / `CORS`）**：这三个词是 6 条里的具体规则词，
  出现在提示词里就说明有人开了第二份会过期的真相源（同 §8.10「工具名从注册面取、不手抄清单」）。测试同时**反向断言**
  这三个词必须在 `~/AGENTS.md` 里——否则「把提示词清空」也能假装成防漂移。
  **变异取证（主 agent 亲手跑的三条，不复用 worker 的）**：① 往提示词预览段插一条含 `allowedHosts` 的规则（反引号转义过的合法变异，
  `node --check` 仍过）⇒ **恰好 1 条红**（单一来源防漂移）；② 把强制指针整条从预览段**挖到「交付规则」段**（措辞一字不动、只挨位置）
  ⇒ **恰好 1 条红**（「必须落在预览段内」）；③ 把单一真相里的「**窄范围优先**」改成「范围优先」⇒ **恰好 1 条红**（6 条逐条锚点）。
  ⚠ 做变异时插裸反引号会**提前截断模板字符串**（我第一次就这么做错了，连带 9 条红）——先 `node --check` 再下结论。
  主 agent 另复跑全套：根 `npm test` **926/925/0/1**、`node --test runner/test/*.test.js` **202/202**，与交付一致。
- [x] **口径同步**：`docs/design/user-space.md` 新增 §4.1.2（`~/AGENTS.md` 的职责边界 = 工位约定 + 平台约束单一真相，
  含读取边界与红线）、`docs/design/fde-platform.md` §8.1 末段「告知落点」由两处改三处 + §8.2 加「应用侧要求链
  以 `~/AGENTS.md` 为准，本文不重抄」。
- [x] **测试基线：根 `npm test` 920/919 → 926/925**（0 失败 / 1 跳过不变）、**`node --test runner/test/*.test.js` 200 → 202**；
  `docs/ops/ci-release.md` §1 与 `.github/workflows/ci.yml` 步骤 ② 注释已同步。**前端零改动**（基线 29 文件 / 391 不变；
  本单没跑前端，沙箱里没有 `portal/frontend/node_modules`）。`docs/data/schema.sql` 一字节未动，零 DDL / 零依赖 / 零 lockfile，
  `runner/lib/**` 与 `portal/src/{preview,http}.js` 未动。
- [x] **真机 R-1 已跑并全部通过（v0.1.4，全新工位 `blind`，记录见 `docs/ops/drill-2026-10-12.md` §八）**：**P0 成立**——第 1 轮就 `cat ~/AGENTS.md; cat ~/.erix/ports.json`（起服务在第 6 轮，**读在前**），
  第 3/7 轮直接引用「AGENTS.md says… / note 4」，**零次「被宿主边界拒绝」**（shell 口径生效）；P3/P3b/P4/P5/P6 逐项过
  （预检实测 `204` + 回显 Origin + `Allow-Credentials: true` + `Vary: Origin`；`allowedHosts` 是**窄范围逐条**不是 `true`）。
  **1 条消息、零返修**（run `0831b43c`、27 轮、↑597,315 ↓23,317、`judge_done`），对照组就是夜班自己那 4 条消息。
  ⚠ **协议里的反向判据我自己写错了**：`messages` 表同时存 user 与 assistant ⇒ 正确口径是 **`role='user'` 计数 == 1**（已在 #258 更正）。
  ⚠ **#247 现场数据**：跳 host 要**点 2 次**「打开预览」（22030/22031 各一次）——不计入 R-1 失败，但是 #247 该做的又一条实测依据。
- [x] **真机 R-2「多轮对话」已跑（同工位，会话 `86aad08a…`，记录 §九，回帖 #258）**：对话质量达标——模糊抱怨先反问（该轮仅 ↑59K/↓508，是闷头做的 1/8）、跨 run 记忆/增量修改、约束不回归、**agent 质量侧返修 0 次**（infra 侧 8 次 provider 超时重发 → **#261**）。
  价值在挖到 R-1 测不到的陷阱：**cookie 会话在预览域名「写通读不通」**——裸 echo 实测 `strip-cookie` 只对 GET/HEAD 生效，POST 透传 `Cookie`（§6.4 B2 的实跑验证只验了读方法半边）⇒ 告知面缺口 #262、边缘实现半通 #263；T6 人报症状后 agent 改 Bearer，真机浏览器复验全通（容器内 21/21 全绿但测不到边缘——验收必须走真机 again 成立）。
  ⚠ **后续更正（#263 已证伪关闭，见其更正评论）**：「只对 GET/HEAD 生效」当晚被三重独立复测推翻——边缘是**全方法一致剥除**，与 B2 承诺一致、不是实现 bug；「写通读不通」真成因平凡得多（登录凭据走请求体、`Set-Cookie` 是响应头不被剥；读 cookie 的请求 GET/POST 一样死）。遗留：#262 按全剥口径修（已在 §8.17 随 v0.1.5 落地）、**双向探针入预览断言**（转办 #227）；另 v3 本就无 regex 头改写中间件，原 A 方案落地不了——若当时盲修会把不存在的能力当现成的用。

### 8.17 v0.1.5：超时止血 + 告知第 7 条 + 一键重试（2026-10-13 夜班，PR #264/#265/#266）

- **载荷**：① runner 显式四相 LLM 超时（`runner/lib/llm-timeouts.js`，关引擎 legacy 120s 绝对总闸；默认 240s 首字节/180s 空闲每 chunk 重置/总闸 `2147483647` 事实关闭/非流式 300s；`ERIX_LLM_TIMEOUT_*_MS` 可覆盖，§10.4 docs/env.md；#261 后端）；② `~/AGENTS.md` 预览访问节**第 7 条「应用登录态不要用 Cookie」**（#262，六→七条；单一来源禁词集 3→6）；③ 前端失败横幅透出 `（code=timeout）` + 一键「重试上一条」（仅内存、复用 send 链路、三条件同现才显；#261 前端）。
- **基线**：根 `npm test` **945/944/0/1**（#264 +19，`runner/test/llm-timeouts.test.js`）；runner **221/221**；前端 **29 文件 / 410**（#266 +19）；三处台账均已同步。
- **发布与部署（第二次按 digest 发版，全程无新坑）**：三份 package.json+lockfile → `0.1.5` → tag `v0.1.5`（run `38280258701`）→ 三镜像 pull+inspect `.Id` 与清单 `imageId` 全一致 → `.env` 形态① pin（备份 `/tmp/deploy.env.bak-015`）→ `up -d --no-build` healthy。
- **真机已验**：`fde-blind` 的 `/home/erix/AGENTS.md` 由对账**自动**刷出第 7 条（不需重建容器）；#241 预检/deny-CORS 无回归；签票→兑换→预览 200 全链正常；新前端 bundle 含「重试上一条」。超时修复的热patch冒烟（run `18485a78` 「pong」）在部署前已过。
- ~~既有 FDE 容器仍跑旧 runner 代码~~ **（2026-10-13 上午已完成重建）**：eric/tetris/todo/blind 四台已 `docker rm -f` + portal reconcile 自动重建到 v0.1.5 FDE 镜像（digest `d941e7b8…`，`ensureFdeContainer` 不检测镜像漂移、rm 后由 reconcile 按 `.env` pin 重建是标准姿势）；agentd 四台上线双向 ping、ports.json generations 不变、端到端冒烟 run finished（↑3,848/↓66）。blind 的热patch随重建退役。
- #263 当晚证伪收口（见 §8.16 更正块与 drill §九）；#261/#262 均已关闭，衍生小项（四个超时的 per-FDE 下发光纤）登记在 `docs/env.md` §10.4，要调参再开单。

### 8.18 e2e 隔离化与清场红线（2026-10-13 夜班，PR #267/#269，#226/#224 关单、#227 第 1-3 项）

- **护栏单一来源 `portal/integration/lib/isolated-env.mjs`**：`assertIsolatedEnvironment`/`resolveDbDir`/`createDbDirCleaner`/`assertHostPortsAvailable`/`writeTraefikStatic`/`deriveFdeIpamPools`/`defaultFdeIpamPools` 唯一定义处；wp2a/wp3a/wp3b/wp5/wp6 全部 import，`isolation-negative.mjs` 静态钉死（复制第二份即红）。缺省红线：`STATION_DB_DIR` 缺省/指向 `/docker/station-db` ⇒ **起栈前硬失败，一条 docker 不发**（旧行为是默默 `rm -rf` 共享 dev 库数据目录）；全仓 `allowSharedReset` 唯一声明处 = wp2b（有意重置共享 dev 库，豁免只对恰等于该路径生效）。
- **compose 一律显式 `-p`**（compose 文件 `name: station` 的隐式兜底已死）：隔离系 `${COMPOSE_PROJECT_NAME:?…}`、共享系 `:-station`；wp6 清场逐动作具名记账 + 按 `station.stack`/`com.docker.compose.project` 标签与按名双路零残留断言，**清理失败必须红**（#224 的「残留 fde-bob 却报 pass」在结构上不可能了）。
- **FDE_IPAM_POOLS 派生口径**：族 `10.201–10.299.0.0/16`、共享段 `10.200.0.0/16` 一律拒；脚本缺省注入 = 派生段 **+ 10.201.0.0/16**——因为 portal `POOLS.large` 钉死 `portal/src/ipam.js:14`（proxy 白名单必须覆盖 portal 实际分配段）。「两栈并行完全不撞池」还差 portal 池参数化，随 #268。
- **隔离跑法现状（#268 E/F 后更新）**：wp3a/wp2a **零手工预配**（FDE 镜像自建、IPAM 派生、watch 桩全自动）。操作者仍需 export 的只有两条：`BASE_DOMAIN`（漏了路由物化成 `station.localhost`、agentd 拿纯文本 404；`PORTAL_PUBLIC_BASE_URL` 与路由 host 必须同源）与 `HTTP_PROXY=172.20.0.35:19001`（镜像构建下载层被墙会卡 ~30 分钟；构建 arg 参与缓存键，带/不带代理互不命中）。`FDE_DEV_MODE=1` 对 tag 形态 FDE_IMAGE 仍必需（护栏强制）。**wp5 仍需手工三件套**（手建镜像 + 手传 IPAM，完整 env 见 #268 评审注释）。
- **edge file-provider watch 坑（e2e 语境已修，#268 第 3 项）**：traefik 启动时动态目录里没有 `routes.yml` ⇒ 后来 materializer 原子替换的文件**永远不会被 reload**（整栈看起来正常但预览/internal 全 404；`docker restart station-edge-<id>` 立刻通）。修法已落地：`writeDynamicStub` 在 compose up **之前**预写 `http: {}` 桩（wp2a/wp3a/wp3b/wp5/wp6 全部，顺序由 `isolation-negative` 静态钉住）——wp3a/wp2a 真机全程不再需要重启 edge。**人工起栈仍会踩**（drill-2026-10-12 §五 记录保留）；#227 第 4 项（单 test 粒度）有意未拆（新代码自 wp2a 重建起逐段 `t.test`），拆之前不往单条 test 堆断言。
- **真机验收口径新增**：e2e 隔离跑的断言必须带 **agentd 双向链路**（`sse connected`/`sse ping received`，或 GET+POST 探针——#263 教训同源：只验读方法会把半通当全通）。基线不变：根 945/944/0/1、runner 221、前端 410（`isolation-negative.mjs` 不在发现面，缺省 rc=1 是负例证据本体，进 CI 用 `--strict`）。

### 8.19 v0.1.6：#234 跨站写请求防线 + #275 预览被 released 历史行遮蔽（2026-10-13，PR #276 / issue #275）

- **载荷**：① **#234** CSRF/Origin 同源门（`routeApi` 统一鉴权步前，覆盖 login/logout/签票等写路；`/api/internal/*` 与 `/api/forward-auth` 豁免；
  ⚠ **`same-site` 不得直接放行**——portal host 与预览 host 共享注册域 `erix.vip`，`SameSite=Lax` 仍会带 host-only cookie，所以必落**注册域精确比对**）；
  ② **#275** 预览 hostname 查表改「活行优先 + 全序」（详 `#275` 正文与 `portal/src/preview.js` 注释）。
- **测试基线：根 `npm test` 976 / 975 通过 / 0 失败 / 1 跳过**（含 runner 221）、runner 221/221、前端 `vue-tsc` 干净 / vitest 410（本轮前端零改动）。
  台账已同步 `docs/ops/ci-release.md` §1 与 `ci.yml` 步骤 ②（945 → 967 → 969 → **976**）。
- **两次否掉的修法（主 agent 变异取证，不是偏好）**：#275 的「只加 `AND state <> 'released'`」朴素一行⇒ **5 红（含 #241 既有 2 条）**，
  因为它把 `allocation_released`(403) 打死并把「只有 released 行」的 host 挤成 404（改掉已有契约）；整段排序删掉 ⇒ 5 红。
- **发布与部署（第三次按 digest）**：三份 `package.json`+lockfile → `0.1.6`（每份 lockfile 恰好 2 行）→ tag `v0.1.6`（run `38391682946` success）
  → 三镜像 `docker pull` + `image inspect .Id` 与清单 `imageId` 全一致、`RepoDigests` 与 `digest` 一致 → `deploy/.env` 形态① pin（备份 `/tmp/deploy.env.bak-016`）
  → `docker compose -p station --profile litellm up -d --no-build`（portal 实跑 `bac03044…` = 清单 imageId）。
- **真机验收全绿**（请求从 host 网络容器 `erix_station_playwright` 发出，避開宓主透明代理假 401）：被遮蔽的 `eric-p-22000…` 由 `allocation_released` 变 **`preview_ticket_required`**；
  列端口 200 → 签票 201 → 兑换 **302 + Set-Cookie** → 带 cookie **502**（无人监听＝鉴权已过，修复前根本走不到）；未知 host 仍 404；
  #241 deny CORS 与预检无回归；#234 经边缘同源登录 200 / 预览 host same-site 写请求 403 `cross_origin_forbidden`；
  端到端冒烟 run `a300dee9…` **finished**（`judge_done`、↑3,829/↓63，正文落库含 `pong` 且有 1 条助手锢点——即 #278「中止后 0 锢点」的对照面）；
  FDE `agentd` 在 portal 重启后自愈（`sse disconnected → reconnect → sse connected`）。
- **已接受代价 / 遗留**：四台 FDE 容器仍在 v0.1.5 runner 镜像上（`ensureFdeContainer` 不检测镜像漂移；runner 代码本轮零改动 ⇒ 不专门 `rm -f` 重建，下次重建自然升级）。
  `#234` 的 https 半边仍卡在 `erix.vip` 泛域名 DNS-01 API token（外部依赖）；本轮只交付 CSRF/Origin 半边。

### 8.20 v0.1.7：#255 强制首登改密 + #277 排队停止收敛 + #280 迁移身份对齐（2026-10-14 夜班，tag `v0.1.7` = `b50d5e8`）

**载荷**（自 v0.1.6）：① **#255** 受限会话门（`RESTRICTED_SESSION_ALLOWLIST` 9 条，少一条=死锁、多一条=漏口）+ 登录响应 `password_change_required` + `POST /api/me/password`（保留当前会话、吊销其他）+ 前端改密屏（`App.vue` 闸门 ∧ `router` 改写 ∧ 三态判据 ∧ 重定向预算熔断）+ 全局 `403 password_change_required` 兜底 + 错误码→文案映射表；② **#277-A/A2** 排队中的 run 被停止 → 同事务 `queued→finished/aborted/cancelled_before_start` + 出队 + 合成 `run_end`（`client_event_id='<runId>:final:run_end'` + `ON CONFLICT DO NOTHING`），claimed 且有活租约的行不许直接终态；③ **#280** `migrate.js` 在 `applyBootstrap` 之后、迁移循环之前 `SET ROLE` 到平台库角色（`finally` 里 `RESET ROLE`），顺带灭掉灾难恢复库「增量表属主错、`station_portal` 写不进去」那颗更老的雷；④ **#255 收尾** `confirm_password` 服务端校验（**可选**字段，带了必须等于 `new_password`，`details.field='confirm_password'`；没带行为不变）。

**基线**：根 **1036/1032/0/4**（有 `TEST_DATABASE_URL` 时另跑 3 条真库迁移用例）、runner **221/221**、前端 **33 文件 / 488 通过**（`docs/ops/ci-release.md` §1 与 `ci.yml` ② 已同步）。

**发布与部署（第三次按 digest，流程无新坑）**：三份 `package.json`+lockfile → `0.1.7`（每份 lockfile 恰好 2 行）→ tag `v0.1.7` → CI+release 双绿 → `docker pull` + `image inspect .Id` 与清单 `imageId` 三镜像全一致 → `deploy/.env` 形态① pin（备份 `/tmp/deploy.env.bak-017`）→ `docker compose -p station -f deploy/docker-compose.yml --profile litellm up -d --no-build`。portal 实跑 `f85e3040…` = 清单 imageId；digest：portal `796095b6eb3c…` / fde `7e406e043c52…` / proxy `1660ef51f7cb…`。

**⚠ tag 挪过一次位**：第一次打 tag 落在 `690a7d5`，那次 **release 成功但 CI 步骤④ 红**——红在 #255 前端新测试自身（`ForcePasswordErrors.spec.ts` 挂整个 `App`，而夹具对所有请求返 403，`WorkbenchView.onMounted` 里两个 `await` 无 catch ⇒ 未捕获拒绝）。修法是消除不确定性（确定成功夹具 + 落地后再冲刷 + **「零未捕获拒绝」自检**），不是加重试；产品代码零字节改动。教训与「判绿看退出码」一并写进 §4。

**迁移与数据（真机，dev 栈）**：日志 `迁移身份已是平台库角色 station_platform（无副作用 no-op，不发 SET ROLE）` → `applying 0021-user-must-change-password`；`must_change_password` = `NOT NULL DEFAULT false`，**存量 6 个用户全部拿到 `false`**（部署不会把任何人锁进改密屏）。另在**真数据拷贝**上单独验过升级路径（`superuser` 只有 `DATABASE_URL` 的形态）：`SET ROLE station_platform` → `applying 0021` → `RESET ROLE`，存量同样全 `false`。

**真机验收**（请求从 host 网络容器 `erix_station_playwright` 发出，避开宿主透明代理假 401）：
- **#255 后端链 13/13 全过**：建用户（管理员代设口令）→ 本人首登旗标 `true` → 非白名单 GET/POST 均 `403 password_change_required` → 白名单 `/api/me`、`logout` 可用（不死锁）→ `confirm` 不一致 `400 + details.field` → **旧口令错是 `401` 且不带 `details.field`**（不泄露 confirm 判定）→ 自助改密 `200 {ok:true, password_change_required:false, sessions_revoked:1}` → 同会话立即可用不强制重登 → 新口令可重登、旧口令 `401` → **不带 `confirm_password` 仍可改**（向后兼容）。
- **#255 真浏览器链全过**（截图 `/docker/erix_station_playwright/v017-after-change-password.png`）：登录成功 URL 即被改写为 `#/change-password`；手打深链 `#/session/<uuid>` 也被改回去；改密屏无工作区外壳（router-view 被抑制）；两格不一致**本地先拦**并把红标落到「确认新口令」那一格（不是 `[object Object]`）；改密成功落 `#/` 且会话未被踢。控制台唯一 error 是登录前 `GET /api/me` 的 401（预期噪音）。
- **预览链无回归**：未知 host `404`；曾被 released 行遮蔽的 `eric-p-22000` 现在 `403 preview_ticket_required`（#275）；deny 仍回显 `Access-Control-Allow-Origin` + `Allow-Credentials`（#241）；带 `Access-Control-Request-Method` 的预检**被放行**（实测 `502`=已过鉴权、到应用但无人监听，CORS 由应用自答）；列端口 `200 {items:10}` → 签票 `201` → 用返回的 `url`（`?preview_ticket=`）兑换 `302 + Set-Cookie` → 带票访问 `502`（鉴权已过）。
- **#277** 真机只走到「运行中停止」那条支路（agentd `capacity=1` 但取走得快，run 实际跑完 `judge_done`）；**「排队中被停」那条没在真机上出现**，其证据是单测 `portal/test/session-stop-queued.test.js` + 主 agent 三条变异（删租约守卫 2 红 / 删 `ON CONFLICT` 1 红 / 删合成 `run_end` 3 红）。合成 `run_end` 可经 `GET /api/sessions/:id/events/history` 回放已实测（⚠ `/events` 是 SSE，别当历史读，会把调用挂住）。

**已接受代价 / 遗留**：① 四台既有 FDE 容器仍在 v0.1.5 runner 镜像（`ensureFdeContainer` 不检测镜像漂移；runner 逻辑本轮零改动，下次 `docker rm -f` + reconcile 自然升级）；② **#279 不进本版**（dev 数据面 0 复现，完整修法要动 runner ⇒ FDE 重建；判据 SQL 已贴 issue，等决策者在自己部署上跑）；③ **#281**（`WorkbenchView.onMounted` 两个 `await` 无 catch、`workbench.ts:691` 可读 `undefined.cwd`）是新登记的**既有**产品缺口，不在本版；④ `#277` 真机排队支路未跑；⑤ dev 栈遗留测试用户 `pw17*` / `ui17*`（口令是探针里写的一次性口令，非 dev 管理员口令）。

### 8.21 v0.1.8：#285 告知第 8 条（报「服务已起」必须给完整 URL）+ #283 工具时长不再恒显 0s（2026-10-14，PR #287 / #290）

**载荷**（自 v0.1.7）：① **#285** 告知面加「第 8 条」（PR #287）——`~/AGENTS.md` 预览访问节**新增第 8 条**（节标题「必须满足这 7 条」→「8 条」）：服务起着且预览路由已建时，报「已起/可访问/已完成」**不得只给 `localhost:端口` 或裸 host**，必须同时给该端口对应条目的**完整预览 URL**（取 `ports.json` 的 `url`，以 **markdown 链接**给出、可点），多 host 项目逐 host 各给一条，**逐 host 规则回指第 6 条**；第 8 条**不进「错误形态对照」表**（它是告知义务不是故障形态）。`runner/worker.js` 的 `SYSTEM_PROMPT` 只加一句强制指针（**8 条一条也没拄进提示词**，单一真相仍在 `~/AGENTS.md`；双向防漂移的 `RULE_WORDS` 禁词集 **6→8**，新增 `打开预览` / `markdown 链接`）。② **#283** 工具时长（PR #290）——三层各有一个洞：装配层让引擎写 duration（新 `runner/lib/tool-duration.js` + `executeTool` 出口包装）+ U3 回填 `tool_calls.duration_ms`/`result_digest`（UPDATE-only，**零 DDL**）+ 对话流 DTO 在投影**之后** join 宿主 `durationMs`；前端删两处 `?? 0` + 新增 `formatDuration`（`Nms`/`X.Ys`/`Xm Ys`）。

**⚠ #283 的根因更正（原单正文给的修法是空转，值得记一条）**：原单说「runner 读错层级、应读 `tool_result.metadata.duration`」——**否证**：引擎 `run-snapshot-executor.js:329-333` 把 `execution.metadata` 摊平到 `tool_result` **顶层**，宿主读顶层 `tr.duration` 是**正确读点**（上游 `host-upgrade-guide-0.17.0.md:114-117` 也是这么要求的）。真缺陷：引擎**只在 executor 返回结构化结果时**才写 duration（`:102`/`:119` 写；`:111` string/number/裸对象、`:80-86` 返回 Error、`:258-266` 抛异常**不写**），本站除 `searchText` 外全部落「不写」那几条。探针实测四形态 + dev 真库 **740 条 tool_result 只有 12 条带时长**；另外两层各自独立：**U3 从来没写过 `tool_calls` 两列**（只对 `tool_use` INSERT ⇒ 741 行全 NULL）与**引擎投影不带时长**（⇒ 刷新必丢，必须宿主 join）。口径：**抛异常/被中止的调用就是没有时长**（不在 worker 里 catch，不破坏引擎中止语义），前端显示成只有 ✓/✗，**绝不伪装成 `0ms`**；库里旧 740 行不可回填。

**上游**：[erix-agent #285](https://github.com/ErixWong/erix-agent/issues/285)（⚠ **与本站 #285 同号不同仓库**，说事必须带仓库名）——要「所有真执行过的工具都写 duration」+ 把「注入字段×返回形态」表写进 `host-consumer-contract.md`；明确**不要**改 duration 位置、不要给 executor 加参数。本车的适配器是**临时闸**：上游落地升版后整体可撤（先例 §8.9 的 `tree` 根标签收口），`runner/test/tool-duration.test.js` 里的「不包 ⇒ 引擎给不出 duration」就是**哨兵**，届时会红提示。本车 **0 上游依赖**（不升引擎、不动 pin）。

**基线**：根 **1058/1054/0/4**（#285 **+0**：第 8 条的锚点断言**并入既有用例**、防漂移用同一条用例扩禁词集）、#283 **+22**：runner 新建 `tool-duration.test.js` +9、`internal.test.js` +8、`session-view.test.js` +5）、runner **230/230**、前端 **33 文件 / 501**（#283 +13）。台账三处已同步。**两处 fake 按 §8.14 改成真模拟库约束**（`fake-internal-pool.js` 的 `tool_calls` 分支上 `UNIQUE(run_id,call_id)`+`ON CONFLICT`+`call_id NOT NULL`+**从 SQL 文本解析 `IS NULL` 谓词**；`SessionViewPool` 按 SQL 文本真筛）。

**主 agent 亲跑的变异（不复用 worker 的结论）**：① 把 `tool_result` 段挤到 `tool_use` 段之前 ⇒ `internal.test.js` **5 条红**（含具名的「顺序陷阱」那条）⇒ M2 的顺序前置是被测试钉住的；② DTO 给缺失值写 `durationMs: 0` ⇒ **恰好 1 条红**；③ 前端改成投影无条件覆盖实时 `dur` ⇒ **恰好 1 条红**；#285 那三条（节标题退回 7 ⇒ 3 条具名红 / 「完整 URL」改措辞 ⇒ 1 条红 / 把 `markdown 链接` 拄进提示词 ⇒ 防漂移红）见 PR #287。

**⚠ `gh api` 建 PR 的布尔坑（归 §3.7 那一族）**：`gh api -X POST .../pulls -f draft=false` 会建出一个 **draft** PR（form 编码把布尔变成字符串），随后 `PATCH --input '{"draft": false}'` 回读仍 `draft=true`，而 **`gh pr ready <n>` 一发即成**。合并前先回读 `.draft`。

**发布与部署**：三份 `package.json`+lockfile → `0.1.8`（每份 lockfile 恰好 2 行）→ tag `v0.1.8` → 三镜像按 digest pin。**告知面只需 portal 镜像**（`~/AGENTS.md` 由对账自动刷出第 8 条，不需重建容器）；**#283 的 M1 动 `runner/` ⇒ 必须重建 FDE 镜像 + `docker rm -f` 四台让 reconcile 重建**（`ensureFdeContainer` 不检镜像漂移，§8.17 先例）。

- [x] **#283 真机验收已过（v0.1.9，2026-10-14 夜班，主 agent 亲手）**：dev 栈会话 `1ead0b1a…` 两次真实调用——`sleep 6` ⇒ 库 `tool_calls.duration_ms=6013`、`sleep 400`（`timeout_ms:420000`）⇒ `duration_ms=400014`，`result_digest` 同批回填；浏览器（`erix_station_playwright` :8935，走 `station.fde.erix.vip:8090`）渲染出 **`6.0s` 与 `6m 40s`**，**`location.reload()` 硬刷新后两行仍在**（走宿主 join 的回放路径），整页 `innerText` **无 `0ms`、无 `undefined`、无 `[object Object]`**（vision 看图复核同一张截图 `/docker/erix_station_playwright/v019-accept-lines.png`）。已关 #283。
- [ ] **#285 R-1 真机（半条待判）**：全新工位 `acc019`（会话 `116090a0…` / run `9bdcfdb9…`，**`role='user'` 计数 == 1**、零返修）第 1 条回复就给出**两个 host 的完整预览 URL**（`http://acc019-p-22061.fde.erix.vip:8090` 与 `…-p-22060…/api/todos`，端口取自 `ports.json`，不是 `localhost`），还主动写了第 4/5/6 条（`credentials:'include'`、CORS 回显、逐 host 放行）。**但它是裸 URL（`- **http://…**`）不是 markdown 链接**，而 `portal/frontend/src/lib/markdown.ts` 只把 `[text](url)` 转成 `<a>`、**没有 GFM 裸 URL autolink**（实测：`:44-46` 只处理链接语法）⇒ SPA 里**不可点**。第 8 条要求「以 markdown 链接给出、可点」这半条未达成，待判修法（加强告知面措辞并给示例 vs 前端补 autolink）。


### 8.22 #288 缺陷 C：崩溃恢复不再盲目重放（`replayPolicy: "per-tool-declaration"`）

> **草稿（worker 写）**：本节只写「载荷 / 落点 / 测试口径 / 已知边界」。**发版号与真机结论一律留 `TODO(主 agent)` 占位**，不要照抄这里猜的号。

**撤销一条既有决定**：§0.14.0 契约清单里「不实现 0.14.0 的 opt-in tool replay 声明…维持默认行为」那条**自本单作废**（原文就地标注保留）。本站此前从没传过 `replayPolicy` ⇒ 吃的是引擎默认 `"always-replay"`。

**缺陷本体（真机标本）**：一条 `sleep 360` 的 shell 被 watchdog 杀掉后，resume 把**同一个 `tool_use` 从头再执行一遍**——`run_events` 里同 `call_id` 出现 **3 条 `tool_use`**。`shell` 跑的是 `kill` 旧进程 / 重启 backend / 重跑测试这类**非幂等**命令，每轮真的再掀一次桌。这不是引擎缺陷：能力 0.14.0 就有，**本站零接线**。

**引擎读点（erix-agent 0.18.0，逐个核过，别按猜的改）**：

| 位置 | 事实 |
|---|---|
| `loop/orchestrator.js:425` | 选项文档 `replayPolicy?: "always-replay"\|"per-tool-declaration"` |
| `:558` | **默认 `"always-replay"`** ⇒ 不显式传就是缺陷原样复发 |
| `:634-635` | 取值校验，写错字面量直接 TypeError（不静默退化） |
| `:667-670` | 工具定义 `replay` 只许 `"safe"\|"unsafe"`，其它值启动即拒 |
| `:707-715` | 声明会**从送模型的工具定义里剥掉** ⇒ 提示词零漂移（已测） |
| `:1770-1782` | `replayForToolUse`：**快照已记的值优先**（`:1775-1777`），否则读**工具对象顶层** `replay`（不是 `inputSchema`） |
| **`:1781`** | `definition?.replay === "safe" ? "safe" : "unsafe"` ⇒ **判据是 `=== "safe"`，「未标注」也落 `unsafe`**（`host-upgrade-guide-0.14.0.md:110-117` 那句「older snapshot with no `replay` field 按非 safe 处理」**与源码一致，已核实**） |
| `:1783-1786` + `:1808-1818` | 解析结果在崩溃**当时**被盖进 `run snapshot.pendingToolUses[].replay` 落盘 |
| `resume-manager.js:256-264` | `resumePendingTools` 来自 `snapshot.pendingToolUses`（按 `executedToolIds` / 已有结果过滤） |
| `:2565-2620` | resume 分支：`:2571` 门不进 ⇒ **不调 executor**，合成 `is_error:true` + `executionStatus:"interrupted"` 的 `tool_result`（`:2586-2597`）+ 发 `tool_replay_decision_required`（`:2605-2614`，`requiresHostDecision:true`）；**引擎自己不重试**，交还模型 |

**载荷**：① `runner/worker.js` 传 `replayPolicy: 'per-tool-declaration'`；② `runner/lib/shell-tools.js` 给 `shell` 声明顶层 `replay: 'unsafe'`；③ 放行新事件三处（`runner/worker.js loopEventPayload` + `portal/src/http.js HISTORY_EVENT_TYPES` + 前端 `EVENT_TYPES` 与 `HISTORY_REPLAY_TYPES`）；④ 前端一条中性分隔行「工具执行被中断，未重放，由模型决定是否重试（shell）」（双语成对、不新增 UI 结构、不走 `.syserr`）；⑤ 文档 `docs/api/portal.md` §5.3 第 15 行 + §4.4a + `docs/design/runner-integration.md`。

**测试口径**（新增，均不碰 LLM/DB/网络）：
- `runner/test/replay-policy.test.js`（+7，跑**真 `runToolLoop`** + 内存 store + 桩 provider）。判据是「resume 期 executor 有没有收到那个挂起 `call_id`」——⚠ **不能用「executor 被调了几次」**：不重放时模型自己会再要一次工具调用，次数相同，只有 **call_id** 能区分「引擎盲目重放」与「模型主动重试」。
- **行为断言用的策略值是从 `worker.js` 源码抠出来的**，不是测试里另抄一份字面量 —— 否则「删掉那行」这条变异永远测不出来。另有**反面对照**（`always-replay` ⇒ 真的重放）钉住判据本身不是恒绿。
- portal：`internal-replay-decision.test.js`（+3，U3 → 落库 + session SSE 实时推；跨层钉三处集合与文档同源）、`session-events-history.test.js`（+1，可回放且 payload 原样）。
- 前端：`useEventStream.spec.ts` +6（实时 / 回放 + **两条通路逐字一致** / 中性 / 脏值 / 载荷全缺 / en）、`localeParity.spec.ts` +1。

**⚠ 已知的两条「变异不红」，不是测试漏洞，别当巧合交差**：
1. **摘掉 `shell` 的 `replay` 声明 ⇒ 行为用例仍绿**。引擎 `:1781` 判据是 `=== "safe"`，**未标注同样落 `unsafe`** ⇒ 行为等价。所以改用**能红的方向**代替：把声明写成 `"safe"` ⇒ 恢复时真的重放 ⇒ 主口径与探针用例红；另用一条形状断言（`Object.hasOwn(schema,'replay')`）单独钉「声明必须在」。**显式写出来是刻意的**：口径要留在代码里，不能只活在注释和文档里。
2. **`EVENT_TYPES` 与 `HISTORY_REPLAY_TYPES` 必须分别单独摘才会分别红**（前者红=实时一条都收不到，后者红=刷新后消失）。这是 §8.8 那个「同一事件两种可见性」坑的**第三次**发作，三处集合的同步已由 `internal-replay-decision.test.js` 的跨层用例常驻钉住，不靠人记。

**已知边界 / 代价**：
- **未标注 = 不重放 ⇒ 5 个文件工具（`readFile`/`searchText`/`tree`/`edit`/`writeFile`）挂起时同样不重放**。上游 0.18.0 `createFileTools` 一个 `replay` 都没标（`src/tools/*.js` grep `replay:` 零命中），本站**不替上游代签「重放安全」**。写文件本身幂等，选「少跑一次」而不是「多跑一次」（多跑可能覆盖新内容，少跑模型能自己补）。已钉成显式口径用例；上游若将来标了 `safe`，该用例里的源码断言会红提示重评。
- **「撤销一条已记录的旧决定」不能只改工具定义**：`:1775-1777` 规定快照里已记的 `replay` 值**优先于当前定义**。将来把某工具改成 `replay:"safe"`，**存量挂起快照仍按旧值不重放**；要翻案得同时动 `replayPolicy` 或清快照。
- **引擎 `runId` 是 `transcriptKey` = `sessionId`**（issue #81 P2），不是 station run id。U3 payload 里落名 `engine_run_id`，与信封 `run_id` 并存但不同义。
- `partialPersistence` 仍未实现（本单不碰）；启用它必须同时 `stream: true`（已满足，`worker.js` 一直传 `stream: true`）。
- **0 上游依赖**：不升引擎、不动 pin/lockfile/`erix-agent` 0.18.0；`docs/data/schema.sql` 与 `deploy/migrations/` 零字节改动（**纯 additive 事件类型，无 DDL**）。

**基线（主 agent 亲测复跑，非照抄 worker 自报）**：根 `npm test` **1103 / 1099 通过 / 0 失败 / 4 跳过**（自分支 M1 的 1088/1079/**5 失败**/4 跳过起：M2 +4、M3 +11，5 红全部清零）、`node --test runner/test/*.test.js` **258/258**、前端 `npm run typecheck` rc=0 + `npm test` **33 文件 / 514 通过**、`cd portal && node --test portal/test/*.test.js` rc=0。归属：**runner +28**（A/D `shell-liveness` 21 + C `replay-policy` 7）、**portal +17**（B `internal-attempt-killed` 12 + `session-events-history` 1、C `internal-replay-decision` 3 + `session-events-history` 1）、**前端 +13**（B +6、C +7，两处各含 `localeParity` +1）；§1 台账与 `.github/workflows/ci.yml` 步骤② 已由主 agent 在合并时统一写（1058→1103 / 230→258 / 501→514）。

**主 agent 亲跑的变异（不复用 worker 的结论）**：`replayPolicy` 值改成 `always-replay` ⇒ **2 条具名红**（主口径 + 文件工具刻意保守那条）；把 `loopEventPayload` 的新 case 整段删掉（走 `default` 原样透传）⇒ **1 条红**（证明事件字段映射是被钉住的，不是只靠文档）；前端 `HISTORY_REPLAY_TYPES` 单独摘掉 ⇒ **恰好 1 条红**且实时用例仍绿（症状=刷新后消失，与 `EVENT_TYPES` 摘掉的「一条都收不到」可区分）；`silent_ms` 守卫改 `?? 0` ⇒ 恰 1 条红；`attempt_killed` 幂等键去掉 `:<attempt>` ⇒ 恰 1 条红。另**亲验真库** `run_events` 上确有 `UNIQUE (run_id, client_event_id)` **普通约束**（不是部分索引）⇒ `ON CONFLICT (run_id, client_event_id)` 在真 PG 上成立，fake 与真库同口径（§8.14 那类「fake 结构上拦不住」的坑本次已排）。

**发版与部署（已完成）**：tag `v0.1.9`（commit `466275a`，CI 绿后打）→ release run `38549138366` success → 清单 `images-digest` 三镜像 `docker pull` 后 `docker image inspect .Id` 与 `imageId` **全一致**（portal `c13c099c…` / fde `8e3e4260…` / proxy `8aae5417…`）→ `deploy/.env` 形态① pin（备份 `/tmp/deploy.env.bak-019`）→ `docker compose -p station --profile litellm up -d --no-build`（portal 实跑 `c13c099c…` = 清单 imageId，`/healthz` 200）→ **`docker rm -f` 六台 fde-* 后 reconcile 全部按新 pin 重建**（`fde-eric`/`tetris`/`todo`/`blind`/`pw173jscw`/`ui17kbwg` 镜像 ID 均为 `8e3e4260…`），新建的 `fde-acc019` 直接落在新镜像上。⚠ 本单动 `runner/` ⇒ 重建是**必须**的（`ensureFdeContainer` 不检镜像漂移，§8.17 先例）：不重建就还是旧默认 `always-replay`。⚠ M1 动 `runner/` ⇒ **必须重建 FDE 镜像 + `docker rm -f` 让 reconcile 重建**（`ensureFdeContainer` 不检镜像漂移，§8.17 先例）；老容器不重建就还是旧默认 `always-replay`。

- [x] **真机验收已过（v0.1.9，主 agent 亲手，一枪同时验 A/B/C/D）**：会话 `1ead0b1a…` 起一条 `sleep 120 && echo REPLAY_PROBE`（`timeout_ms:200000`），工具跑到 30s 时 `docker exec fde-eric kill -9 <worker pid>` 造真崩溃。
  - **A**：另一条 `sleep 400 / timeout_ms:420000` 在 0.1.9 上**跑满 400s 不被杀**（`tool_calls.duration_ms=400014`，run `judge_done`）——修复前 5:00 必死（标本就是同一台 `fde-eric`、同一台 dev 栈）。
  - **D**：kill worker 后 12 秒 `docker exec fde-eric ps` 里 `sleep 120` 与它的 bash **一条不剩**（旧行为会留下孤儿并与下一 attempt 并存）。
  - **B**：`run_events` 出现 `seq 164 attempt_killed {"reason":"worker_crashed","attempt":1,"killed_by":"crash","max_attempts":3}`（**无 `silent_ms` 键**，crash 上报本就没有 ⇒ 印证「有则出现，没有不写」）；界面上渲染「第 1/3 次尝试被终止（worker 非预期退出），已重排等待重试」，**硬刷新后仍在**，`zh-CN` / `en` 两种语言都逐字核对过。
  - **C**：同一 `call_id call_00_ET_MtdTBEViwR7OHZXeWY184379` 在 resume 后只出现「记录 + `167 tool_replay_decision_required {replay:"unsafe", requires_host_decision:true, engine_run_id=<sessionId>}` + `168 tool_result ok:false`（**无时长**）」，**没有第二次真执行**；模型拿到「被中断」后直接回 `probe-done`，**没有白烧 120s**。中性文案两语可见且刷新后仍在。
  - **已接受的呈现（不是 bug）**：被中断的那次工具卡片本身是**红色 ✗**——引擎给的合成 `tool_result` 是 `is_error:true`，卡片按失败渲染，解释由下面那行中性文案承担（刻意不把卡片也刷成中性，否则真失败与中断会混色）。




### 8.23 reaper 收敛的重排也可见（issue #292，2026-10-14）

**缺口性质**：#288 缺陷 B 把「attempt 被杀并重排」做成了用户可见，但只覆盖 **agentd 主动上报**（U12 release 带 `killed_by`）那一条路径。而**租约过期才是最常见的真崩溃形状**（agentd 自己被杀 / 容器被 `docker kill` / OOM / 网络断 ⇒ 根本没有上报）。`reapExpiredRuns` 的三条分支此前都不写 `attempt_killed` ⇒ 界面上仍是「同一个工具卡片亮几次，最后没有原因」。

**载荷**（`portal/src/internal.js` reaper 段，常量 `REAPER_KILL_REASON` / `REAPER_KILL_BY`）：
- 分支 ③（`attempts < max_attempts` → 回 pending）在**同一事务内**合成一条 `attempt_killed`，逐条照 `releaseRun` 的先例（#288/#277）：`allocSeq` + `client_event_id = <run_id>:attempt-killed:<attempt>` + `ON CONFLICT DO NOTHING RETURNING id` + **`rows.length > 0` 才推 SSE**（`COMMIT` 之后推）。**不做「先查重再分配 seq」**（那会让 `ON CONFLICT` 变成装饰），重复轮次白烧一个 seq 是 §5.1 已裁决的合法空洞。
- 固定字段 `{attempt, max_attempts, reason:'lease_expired', killed_by:'crash'}`：**`killed_by` 保守取 `crash`**（reaper 只看得见「没人续租」，无从区分 F6 看门狗与真崩，不冒认 `watchdog`）；**不写 `silent_ms`/`next_retry_in_ms`**——没有 IPC 上报就没有那个数，写 0 或自造估算都是伪装（#288 口径）。`reason` 是开放值 ⇒ **零新错误码**。
- 分支 ②（耗尽）的合成 `run_end` additive 挂 `last_reason='lease_expired'`，**`error.code` 逐字仍是 `max_attempts_exceeded`**，且**不带 `last_silent_ms`**。分支 ①（cancelling）零事件（用户点停止不是「被杀」）。
- **零 DDL**（`docs/data/schema.sql` 与 `deploy/migrations/` 一字节未动）、runner/前端零改动（渲染面 #288 已就位）。

**测试口径**：+9 条**全部并入既有文件** `portal/test/internal-attempt-killed.test.js`（12→21），无新测试文件 ⇒ 根 **1103 → 1112**（1108 通过 / 0 失败 / 4 跳过），runner 258、前端 514 不变。⚠ 同批把 `portal/test/fake-internal-pool.js` 的**事务撤销面收紧**：原本只撤销 `run_events` INSERT + `allocSeq`，现在把 `UPDATE run_queue/runs SET status=…` 的字面量改写也纳入 ⇒「COMMIT 失败只剩半截收敛」在单测里第一次可见（方向是收紧，不是放宽，§8.14）。

**主 agent 亲跑变异（不复用 worker 的结论）**：`REAPER_KILL_BY` 改成 `watchdog` ⇒ 恰 1 条具名红；去掉 `last_reason` ⇒ 恰 1 条红；**把 `attempt_killed` 的 SSE 推送挪到 `COMMIT` 之前 ⇒ 2 条红**（证明「先落库、后推送」的顺序是被钉住的，不靠人记）。worker 另跑 6 条（去 `ON CONFLICT` ⇒ 真库 23505 原文、幂等键去 `:<attempt>` ⇒ 2 红、INSERT 挪提交后 ⇒ 精确变体恰 1 红、硬塞 `silent_ms:0` ⇒ 2 红、去 SSE 门 ⇒ 恰 1 红、改 `error.code` ⇒ 恰 1 红）。

**已知边界（都是刻意口径）**：
- 界面看到的是「worker 非预期退出」，**不是「租约过期」**——`killed_by` 是已知值 `crash` ⇒ 前端命中固定标签，`reason='lease_expired'` 在界面上根本不出现。**要让二者可区分必须动契约**（新增 `killed_by` 取值 = 破坏「只认 `watchdog`/`crash」的既有契约；或给 payload 加来源判别键），单加一条 i18n 键不够。留作产品判断。
- **窗口期仍零事件**：worker 已死但租约未过期（≤90s + reaper ≤15s ⇒ 约 ≤105s）内界面没有任何说明；提前播报需要容器级心跳信号（另片）。
- **第一个写者赢**：分支 ③ 会把 `claim_token` 置空 ⇒ 迟到的 release 必 409 `lease_lost`，所以「reaper 先记 crash、agentd 复活后想报 watchdog」**不会**覆盖同幂等键的既有事件（那次真实死因不再上报）。
- reaper 循环本来就不写 `audit_log` ⇒「谁改了队列状态」只有事件面可查。

**发版与部署**：`TODO(主 agent)`。真机验收判据见 issue #292 交付报告（`docker pause fde-eric` ⇒ 等 90s+15s ⇒ 恰一条 `attempt_killed(killed_by:'crash', reason:'lease_expired', 无 silent_ms)` + 界面那一行无「（静默 …）」后缀 + 刷新后仍在 + `unpause` 后再 pause 一次应出现**第二条** `attempt:2`）。过了才关 #292。

### 8.24 渲染器补裸 URL 自动链接（#285 收尾，2026-10-14）

**为什么改渲染器而不是改告知面措辞**：#285 R-1 真机上 agent 第 1 条回复就给了两个 host 的完整预览 URL，但写的是**裸 URL**（`- **http://…**`），而 `portal/frontend/src/lib/markdown.ts` 只把 `[text](url)` 转成 `<a>` ⇒ SPA 里不可点。两个候选修法里选了这个：告知面加示例只治「下一条消息」，**autolink 对所有历史消息一次性生效**且不依赖模型照格式（模型侧写法本来就不可控）。

**实现要点**（顺序是安全前提，改动全在 `inline()` 里）：整体转义 → 行内代码占位 → 粗斜体 → **markdown 链接产出先写进 `links[]` 占位（`U+E001`，与代码占位符不同字符，互不串号）** → **裸 URL 自动链接** → 还原文本占位 → 最后统一还原链接。少任何一步都会 `<a>` 套 `<a>` 或把代码里的 URL 链掉。
- 字符集**只收 ASCII** ⇒ 非 ASCII（未百分号编码的中文路径）天然截断，与 cmark-gfm / linkify-it 同口径；**裸 `<` 被排除**是刻意的——转义之后正文里的 `<` 必然以 `&lt;` 形态存在，裸 `<` 只可能是我们自己插的标签。
- 只认 `http(s)` ⇒ `javascript:` / `data:` / `file:` / `mailto:` / `ftp:` / 裸 `www.` / 邮箱**不成链**（协议白名单有用例；放开协议会新开 `href` 面）。
- **尾部标点剥离按「整只实体当一个字符」判**：`&quot;` `&#39;` `&gt;` 整只剥回正文（剥下来的仍是**转义形态**），而 `&amp;` 解码是 `&` 不是标点 ⇒ **必须留在 URL 里**；中文/全角标点靠 ASCII 字符集天然截断（不是「允许后再剥」）。
- **刻意不做**：跨帧状态（流式半截 URL 会先链上、下一帧变长，不给渲染器引入状态）、括号配平、左边界判断、email/mailto、`www.`（各自钉了用例）。三个调用点（`stores/workbench.ts` 终稿、`StreamPanel.vue` 流式、`FilePreviewModal.vue` 预览 `.md`）共用同一个 `renderMarkdown` ⇒ **零调用点改动**，标签白名单未扩大 ⇒ XSS 面不变。

**测试口径**：`markdown.spec.ts` **11 → 30**，前端基线 **33 文件 / 514 → 533**（台账 §1 步骤④ 已同步；`ci.yml` 不带前端计数，无需改）。⚠ 其中 **15 条 golden 不是新实现自己的输出**，是把 `git show e61a035:.../markdown.ts` 复制成临时模块**实跑出来的旧输出**（含 `[点我](javascript:…)` ⇒ `<p>点我)</p>` 这种旧怪形状都逐字钉住）⇒「无 URL 的输入输出逐字相同」有证据，不是口头承诺；另有 156 条新旧差分（差分 = 0）作一次性验证，脚本不入库。

**纪律级教训（比实现更值钱）**：主 agent 亲跑变异时**有一条是空操作**（往 `ESC_ENTITY` 里加一对**本来就存在**的 `&amp; → &` 映射 ⇒ rc=0）。换成真正改变语义的变异（把 `&` 加进 `TRAILING_PUNCT`）⇒ **恰 1 条具名红**。⇒ **「变异没红」有两种成因**：覆盖真有缺口，或**变异根本没改变行为**。§8.14 只说了「声称拦得住必须附变异结果」，这里补后半句：**拿变异证明缺口之前，先证明变异不是空操作**。

**已知边界（都钉了用例，不是洞）**：`http://x/中文` 截断到 `http://x/`；`http://…/Foo_(bar)` 少一个 `)`（不做括号配平）；`xhttp://a/x` 会从中间切开（无左边界）；流式半截 URL 提前成链；**成对 `_` 截断 URL**（`http://h/a_b_c` ⇒ `http://h/a<em>b</em>c`，**既有缺陷，markdown 链接分支同样中招**，本单既没扩大也没修）；`见 http://.` 链成 `href="http://"`；大写协议会链（与本文件既有 `/i` 口径一致，与 cmark-gfm 只认小写不同）。

**发版与部署**：`TODO(主 agent)`。**本单不动 `runner/`**（告知面第 8 条随 portal 镜像下发即可）⇒ 真机复验 = 部署后打开 #285 R-1 那条会话（`116090a0…`），两个预览 URL 现在应是可点 `<a>`；过了才关 #285。

### 8.25 LiteLLM 数据面模型名对账（issue #289 切片 A + B1，2026-10-14）

**观测过的缺陷本体**（我亲手在 dev 复现，非推断）：`fde_llm_bindings.*_model_name` 与 **per-FDE 虚拟 key 的 `models` 白名单**都是**绑定时快照的名字**（`/key/info` 实测 `models: ['deepseek-flash']`；铸/改处 `llm.js:672`/`:793` `selectedModelNames()`）。LiteLLM 侧带外改数据面名（id 不变）⇒ 两处同时过期 ⇒ run 终态是**误导性的** `{"code":"auth","message":"The requested model 'X' is not available for this API key, or the model name is invalid."}`，且**烧了 6 轮**才死；把名字改回 ⇒ 同一条消息 `finished` 零错误（因果闭合）。

**⚠ 两条被推翻的前提（别按我最初的分析去找修复点）**
- **门户内「改名」不是漂移源**：`updateModel`（`llm.js:462`）把 `name` 写进 **`model_info.display_name`**，**不写 `model_name`**——实测 PATCH 200 后 `/model/info` 的数据面名一字未变。所以「改名后同步 bindings」是修一条不存在的路径；已改成**注释 + 用例钉住这个语义**，误导面另登记 **#296**。
  **#296 就地补注（工单 `feat-261015-03`：这句话本身就是那个「误导面」）**：上面那句**只对「只改展示名」成立**，而它当时的结论「改名后同步 bindings 是修一条不存在的路径」也只在这个前提下成立。管理台的「改名」已拆成两个字段：**显示名** `name`（→ `model_info.display_name`，既有语义一字未动，确实不是漂移源）与**调用名** `call_name`（→ **顶层 `model_name`** = FDE 请求实际发的那个名字，`fde_llm_bindings.*_model_name` 与 per-FDE key 白名单存的都是它）。**改调用名会把引用它的那些 FDE 当场变成漂移**：`*_model_name` 暂时指向旧名，且真机实测（dev 网关 v1.103.2）LiteLLM 在改名时自己把 key 的 `models` 重写成「只有新名」⇒ 不立刻对账就是直接 403。所以带 `call_name` 的 PATCH 成功后**必须立刻走一次上面的对账**（实现 `reconcileDataPlaneNameRename`：**复用** `getFdeLlmHeartbeatModels`、不另写第二份并集逻辑；首跳 `ttlMs=0` 绕开改名前那份旧映射 ⇒ N 个受影响 FDE 合计只打一次 `GET /model/info`；**只传 `ctx.llmGateway` 单例**——本节那条「另 new 一个 LlmClient 等于换一份缓存」的教训在这里一字不差地重演，单测用注入 gateway 盯不住）。旧调用名留在并集里 ⇒ 不再伪装成 auth 错误，但已从路由消失，仍发旧名的请求会失败；改名同样**不自动回滚**（理由同本节）。另一件事：**LiteLLM 不拦同名调用名**（实测两条 deployment 都 200，`GET /v1/models` 却只列一个、请求在两者间轮询）⇒ 门户必须拦，新增 `409 model_name_conflict`。两个名字的端点契约见 `docs/api/portal.md` §4.9。
- **只回写 DB 仍会 403**：key 白名单存的是名字 ⇒ 必须**两处一起**同步。

**载荷**（`llm.js` 新增模块级私有件 + 心跳调用点接线）
- `getFdeLlmHeartbeatModels(pool, userId, opts={gateway, now, ttlMs=60_000, listModels, updateKey})`：**不传 `gateway` ⇒ 整段跳过对账**（兼容面，`llm.test.js` 5 处旧调用与旧行为逐字节相同，别删）。
- 判据 = `model_info.id → model_name`（**id 稳定、名字可改**，复用现成 `gatewayModels()` + `modelId()`，不重复解析响应）。
- 动作顺序**固定**：**先** `updateKey({key: row.api_key, models: [旧名…, 新名…] 去重})`（**新旧并存**，摘旧名会打断在途请求），**后**一条 `UPDATE fde_llm_bindings SET <仅命中列>, updated_at = now()`（多槽位漂移合并成一条）。**反序会造出「DB 新名 / key 旧名」的持续 403 且下一次心跳不自愈。**
- 三种**保守放行**（都不失败、不写库）：`model_list_unavailable`（网关不可达——心跳路径不能被网关抖动拖死）/ `unknown_model_id`（**只 warn**：这是 agentd 心跳，抛错打不到用户；用户可见 fail-fast 属切片 B2）/ `binding_update_failed`（白名单已双名 ⇒ 继续用旧名仍可服务）。第四种 `/key/update` 失败的 warn **没有 `reason` 字段**（只有 `slots`/`error_status`）——文档 §9.5 按代码逐字写明，别让运维 grep 一个不存在的 reason。
- **触发点是 U4 心跳**，不是定时器（已接受代价：带外改名到「下次心跳 + TTL」之间仍发旧名，最坏 ≈15s+60s）。
- ⚠ **TTL 缓存按 client 对象身份分槽** ⇒ 接线必须传 `ctx.llmGateway`（`http.js:539` 的启动单例；`getGatewayClient` 对已具方法的对象**原样返回**，`llm.js:46-50`）。**在心跳里现造 client = 每跳多打一次 `GET /model/info`。**
- 零 DDL / 零依赖 / 不动 `runner/`；**未新增错误码**（`llm_model_not_found` 属 B2，未登记，别按它 grep）。

**测试口径**：新文件 `portal/test/llm-reconcile.test.js` **15 条**（A 10 + B1 5），根 **1112 → 1127**（1123 通过 / 0 失败 / 4 跳过，台账三处已同步）。B1 的关键一条是**端到端反休眠用例**（真 `createServer` + `POST /api/internal/heartbeat`）：断言下行用新名 **且两跳 `listModels` 只打一次**——后者同时钉住「接线还在」和「传的是单例」。

**主 agent 亲跑变异（不复用 worker 结论）**：① `http.js` 把 `llmGateway` 传成 `null` ⇒ 恰 1 条红（端到端那条）；② 代码里 reason 字面量 `binding_update_failed` 改名 ⇒ 恰 1 条红（文档 §9.5 逐字列的 reason 因此被间接钉住）；③ 切片 A 的 `binding_update_failed` 分支 `return effective` → `throw` 在我**审切片 A 时全绿**（先确认 diff 真变了 1 行，不是空操作）⇒ **定性为真覆盖缺口**，B1 已补第 15 条，补测后同一条变异 ⇒ 恰 1 红。worker 另跑 6 条（顺序反转 / 白名单只发新名 3 红 / TTL 两向各 1 红 / 删接线 1 红 / `Object.assign({},gw)` 造新对象身份 ⇒ 红在网关调用计数上，这才是隔离出性能语义的那条）。

**已知边界**：① 对账是 lazy 的（无启动扫描、无定时器）；② `unknown_model_id` 对用户仍静默（B2 的消息预检 fail-fast 未做）；③ 摘旧名不做（白名单只增不减，长期会攒历史名，未回收）；④ `updateKey` 成功而回写失败 ⇒ 不重试，只 warn；⑤ LiteLLM 侧「删除模型再重建」= **id 变**，本对账只会记 `unknown_model_id` 不回写 ⇒ 需人工改配（未在本单范围）。

**发版与部署（已完成）**：PR #297 → tag `v0.1.11`（CI 绿后打）→ release run `38582107319` → 清单 portal `imageId=4ca0875f…` / proxy `eabb763d…` 与部署机 `docker image inspect .Id` 逐个一致 → `.env` 形态① pin（备份 `/tmp/deploy.env.bak-0111`）→ `up -d --no-build` ⇒ `station-portal` 实跑 `4ca0875f…`、`/healthz` 200。**本版不动 `runner/` ⇒ 没重建 FDE 容器**（且 v0.1.10/0.1.11 的 `fde` 镜像在 ghcr 反复拉超时 ⇒ `FDE_IMAGE` 仍 pin 在 v0.1.9 摘要，见 `docs/ops/handoff-2026-10-14.md` §9）。
**真机 A/B 双向通过**（dev，主 agent 亲手）：带外 `PATCH /model/{id}/update` 改名 → **≈55s**（一次心跳 + TTL）后 `main_model_name` 自动回写、`/key/info` 白名单变**新旧并存**、期间消息 run `830404d0…` `finished` 零错误（同场景修复前是 `code=auth` + 烧 6 轮）；把名字改回去 → 反向对账同样成立。
⚠ **一条实测新事实**：LiteLLM 在改模型名时**自己会把 key 的 `models` 重写成「只有新名」**（改名、改回名各观测一次）⇒ 既实锤「只回写 DB 不够」，也证明我们取**并集**是对的（把 LiteLLM 摘掉的旧名兜了回来，不打断在途请求）。

### 8.26 发消息路径的模型 id fail-fast（issue #289 切片 B2，2026-10-14）

**为什么还要这一片**：切片 A/B1 的对账只挂在**心跳**上，而 `unknown_model_id` 在那里**只 warn**（心跳响应打给 agentd，抛错用户看不见）。当绑定里的 `model_info.id` 在网关里彻底消失（模型被删/重建 ⇒ **id 变**，名字对账救不了），用户发消息仍会正常入队，然后在 run 里跑出一个看不懂的错 ⇒ 这一片把它变成**发送时就说得清的错**。

**新错误码 `llm_model_not_found`（409，`retryable=true`）**
- 登记在 **`docs/api/portal.md` §1.2 通用错误码表**（工单里我写的「§4.1」是**对象表**、没有错误码表——worker 的纠正成立，别按 §4.1 去找）+ §4.3 发消息错误表补一行。
- `details = { slot, model_id }`；`message` 带**槽位中文名 + 模型 id + 出路**（去管理台重新选模型）。`retryable=true` 的语义是「**管理员改配后可原样重试**」，盲目立即重试仍是同一码——这句必须写在文档行里，否则前端会做成自动重试。
- **409 而非 424**：同端点已有 `409 llm_not_configured` / `409 run_in_progress` 同族；424 的语义是「前置**请求**失败」，这里没有前置请求，且全文无 424 先例。
- 前端：`lib/forcePasswordErrors.ts` 的 `ERROR_CODE_KEYS` 加一条（**param-free**，别给 locale 留 `{xxx}` 残渣）+ 工作台发送失败专用文案 `errors.sendFailedLlmModelNotFound`（槽位/模型 id 取自 `error.details` 并过 `toDisplayText`），**零新增 UI 结构**。

**三条不能改坏的口径**
1. **预检位置**：`validateMessageBody` 之后、**幂等 `fn` 之内且 `sessions.postMessage` 之前** ⇒ 失败时**不写 transcript、不入队 run、不占幂等位**（`idempotency.js` 只缓存成功，`fn` 抛错走 `release`；有测试钉「失败后同 key 重试能 202」）。
2. **三种放行**：无活绑定（`no_active_binding`，连 `/model/info` 都不打——「压根没配」是 `llm_not_configured` 的职责）/ 已配置槽位全命中 / **网关不可达 fail-open**（不能因为网关抖一下让用户发不出消息；放行必须留一条 warn）。
3. **必须传 `ctx.llmGateway` 单例**：`model_info.id → model_name` 的 TTL 缓存是**按 client 对象身份校验的单槽缓存**（⚠ 严格说不是「每 client 一项」，worker 复核纠正了我的措辞；两个 client 交替会互相踢掉，退化成每次打 `/model/info`）。有测试钉「同一 client 连续两次发消息只打一次网关」。

**已接受代价 / 边界**
- **TTL 窗口内滞留 409**：管理员改好配后，最长 `ttlMs`（60s）内同 client 仍可能拿 409。可选修法（失败时作废该缓存条目）代价是「模型真被删时每次发消息都打一次网关」，**留给下一片拍板**。
- 只覆盖**发消息**，不覆盖 `POST /api/sessions/:id/ai-title` 与 run 内部——同一个坏 id 在 AI 改名那条路上仍会在上游才炸（**别以为已全覆盖**）。
- 预检**只读**：零写库、零 `updateKey`（回写仍归心跳）。

**测试口径**：新文件 `portal/test/message-model-precheck.test.js` 11 条 + 前端 7 条；根 **1127 → 1138**、前端 **533 → 540**（台账三处已同步）。**主 agent 亲跑变异**：`retryable` 不透传 ⇒ 恰 1 红；传一个非单例的网关对象 ⇒ 5 红（fail-open 把 409 吃掉了 ⇒ 反证「必须传单例」这条接线被钉住）。worker 另跑 3 条：删整段预检 6 红 / 网关不可达改 fail-closed 2 红 / 预检挪到写 transcript 之后 1 红（**红在顺序红线断言**：`connected` 由 0 变 1）。

**发版与部署（已完成）**：PR #298 → tag `v0.1.12`（CI run `38589225119` 绿后打）→ release run `38589937146` → 清单 portal `imageId=fbbbf27c…` / proxy `3580b84d…` 与部署机 `docker image inspect .Id` 一致 → `.env` 形态① pin（备份 `/tmp/deploy.env.bak-0112`）→ `up -d --no-build` ⇒ portal 实跑 `fbbbf27c…`、`/healthz` 200（不动 `runner/` ⇒ 未重建 FDE）。
**真机四条全过**（dev，把 eric 绑定的 `main_model_id` 改成不存在的 UUID）：① API 契约逐字段对（`409` + `code` + `retryable:true` + `details{slot,model_id}` + 说人话的 message）；② **失败面干净**：`messages 15→15`、`run_queue 130→130`（两次被挡的尝试一字未写）；③ 浏览器里那句 `Send failed: … (slot main, model id 0000…)` **可见、无脏值、输入框原文还在**；④ 把 id 改回去 ⇒ 同一条消息 `202` → run `finished` `err=(无)`、消息 `+1 user +1 assistant`（反向证明 ②）。**#289 已关闭。**

### 8.27 erix-agent 0.18.0 → **0.19.0**（issue #299，2026-10-15）

**唯一的宿主可观测面 = `classifyHttpError` 的 4xx 不再一律 `unknown`**（0.19 起 400/422→`invalid_request`、404→`not_found`、409→`conflict`，`retryable` 仍 `false`）。
- **结论：我们的 `error.retryable` 逐条不变**（判据集合 `{timeout, rate_limited, server, disconnect, checkpoint_failed}` + `err.retryable===true`，4xx 不在里面），变的是 **`error.code` 的取值**（会进 `run_finished.error.code` / `runs.error_code`）。探针实测 0.18/0.19 两版逐 status 对照见 `~/worker-reports-261015/probe-engine-upgrade-299.md`。
- **不新增判据、不新增错误码**：值域仍「由引擎定义」，但运维侧若曾按 `error_code='unknown'` 统计「请求写错」这类，需要**重新分桶**（`invalid_request`/`not_found`/`conflict` 从 `unknown` 里分出去了）。`runner/lib/termination.js` 注释 + `portal/test/engine-error-code-contract.test.js` 钉住「三个新码都不得进可重试集合」。
- **两处「按指南说不用动、实际会红」**（都已按包真值改，**没有放宽任何断言**）：① 上游 2026-10-13 并入项把 `readFile` 续读 marker 加了「（文件 N B）」⇒ 逐字钉 marker 的用例红；② `runToolLoop` 返回值 typedef 从单行变多行 JSDoc 块 ⇒ 我们**解析包源码 JSDoc** 的防漂移契约（`portal/test/termination-contract.test.js`）取不到值。修法 = 正则容忍换行 + 前导 `*`，「九值逐项落在常量里」强度一字未放；`reason` 全集经复核**一字未变**，故 `ENGINE_VERSION_FOR_TERMINATION_REASONS` 只追号 + 重定位真值行号。**这两条已回灌上游文档建议（erix-agent #293）**。
- **`llm-timeouts.test.js` 的 `ENGINE_VERSION_PINNED` tripwire 是按设计红**：复核 = `diff` 上游 `src/providers/payload.js` 与 `src/providers/timeout.js` 在 0.18/0.19/0.20 **三版逐字节相同**（四相超时语义、legacy 120s、`streamTotal` 默认 300s 全不变）⇒ 只追版本号。
- **随包 `.d.ts` 对我们不适用**，判据是可执行断言而非 grep 命中数（`portal/test/engine-upgrade-299.test.js` 判据①）：前端 `import … from 'erix-agent'` 0 命中、前端 `package.json` 无该依赖、`portal/` 与 `runner/` 无 `tsconfig`（纯 JS，无 `tsc` 编译面）。
- ⚠ **我给的命令写错被 worker 纠正**：`npm install --exact` 不是有效开关（实测写出 `^0.19.0`，破坏 exact 风格），**必须 `--save-exact`**。

### 8.28 erix-agent 0.19.0 → **0.20.0**（BREAKING：工具事实进 `erix.*`，issue #299，2026-10-15）

**载荷本体**：`tool_result` 的顶层摊平字段**停写**（`TOOL_RESULT_CONTRACT.legacy = {written:false, retireAt:"下一个 minor", aliases:{erixRound→erix.round, duration→erix.durationMs, executionStatus→erix.executionStatus, success→erix.success, <宿主键>→metadata.<键>}}`）。引擎**读侧保留一代兼容**（老记录仍可读顶层），但**不再写**⇒ 顶层读法会**静默**退化，不报错。

**站内顶层读点只有一个**（升级前我按指南 §9 自查清单全量 grep 的结论，不是猜的）：
- `runner/worker.js` 的 `duration_ms`。现口径 = **`tr.erix?.durationMs ?? tr.duration`**，并把 `#283` 那条**主动误导**的旧注释整段重写（旧注释写着「顶层就是正确读点、别改 metadata」）。回退只为盘上 740+ 条旧 `tool_result` 保留，**挂账在 #303**（下次升引擎 minor 时清；**届时 `#299 ②` 那条用例应当变红——红了才是正确信号，别当回归修回去**）。

**#283 那个「引擎给不出时长」的临时计时闸已撤**（判据 = 探针 12 行，含 25ms 延时对照组、`writeFile` 返回 `0`、抛异常、返回 `Error`、裸对象、`null`）：0.20.0 下**无闸**四种真执行形态都写 `erix.durationMs`（延时 25ms 给 25ms），且落盘块上**没有**顶层 `duration`。⇒ 删 `runner/lib/tool-duration.js` + 出口包装 + 旧测（−9 项），并留**防回装双断言**（源码级：禁 `wrapToolResultForDuration(` 调用/导入、禁 `lib/tool-duration.js` 存在、禁装配层自起计时器；行为级：裸返回四形态都带 `erix.durationMs`——上游若把 erix-agent #285 收回去会红）。
- ⚠ **`erix.durationMs` 缺失 = 「不知道」，不是 0**（0.20.0 明说 `?? 0` 是把未知渲染成「瞬间完成」）。没值只剩三种情形：judge 拦截、unsafe 重放被中止、executor 未 settle 就被中止——与 #283 既定口径一致。

**`erix.executionStatus` 只在两种特殊状态存在**（`intercepted`/`interrupted`；普通块上**缺席**，不是空串也不是 `ok`）⇒ 站内 5 个读点逐个改成**拿值比**（新 `SPECIAL_EXECUTION_STATUSES` + `isSpecialExecutionStatus()`）：`toolSummary.ts`、`useEventStream.ts`（两处把「字段在」当「这块值得关注」的判据 + 普通块不再写伪键）、`StreamPanel.vue`、`workbench.ts` 类型注释、`session-view.js` DTO 说明。

**投影新增 `toolCallKey` / `durationMs` 的优先级（主 agent 裁决，勿自行改方向）**：`durationMs` = **投影有值用投影值 → 缺省回落宿主 `tool_calls.duration_ms` → 两者都缺则「键不存在」**（禁止 `?? 0`）；`toolCallKey` **不接进前端卡片身份**（§8.5 仍用投影自造 `key` + provider `tool_use.id`），只透传不匹配。

**接入随包 `toolResultEnvelopeContract`**（27 条断言零改动全绿）；`fileToolsContract` 随包 28→31（含 §6 四形态断言）也全绿——**没放宽套件**。`runner/lib/file-tools.js` 的 tree 根标签收口改用上游判别式 **`classifyFileToolResult`（`erix-agent/tools` 子路径，不在包根）**；前端 `toolSummary.ts` 因不依赖该包**保持手写**，但四形态表写进注释并点名判别式（`engine-upgrade-299.test.js` 判据②机器检查，删一支即红）。

**测试口径**：根 **1138 → 1177**（+39：随包信封 27 + 4xx 契约 4 + 三条升级判据 + 时长优先级 4 − 撤闸删 9 + 上游套件自身增长）、runner **258 → 286**、前端 **540 → 546**（台账三处已同步）。

**主 agent 亲跑变异（不复用 worker 的 7 条）**：① 拆掉随包套件接入 ⇒ 红在「四套契约套件接入面在册」守卫；② 删前端四形态表里 `writeFile` 一支 ⇒ 红在「表在册」守卫；③ **把存在性判据塞回 `StreamPanel.cardOut()` ⇒ 29 条全绿**——先自证不是空操作（diff 真改 1 行、只在 `executionStatus` 为非特殊值时改变行为）⇒ 定性**真覆盖缺口**（新加的 4 条都在 `useEventStream`，`cardOut` 从没喂过非特殊值），补测后同一变异**恰 1 条红且红在新用例**。④ 顺带修正一处**我们自己刚写下的误导注释**（它把防回装断言指向已删除的 `tool-duration.test.js`）。

**不在本单（已挂账）**：#300 消费 `error.finalText`（停止后助手文本整体消失，上游 §5 点名宿主侧边界）、**#301 `partialPersistence` 已评估并决定不开**（决策者口径 + dev 实测「10 天自然崩溃重排 ≈ 1 次」+ 机制与重开条件全在 issue 里；关键辨析：**显示走 `error.finalText`，续跑才走快照通道，后者界面看不见**），上游文档建议 [erix-agent #295]、#303 一代回退清账、`toolCallKey` 接进 UI。

**发版与部署（已完成）**：PR #304 → tag `v0.1.13`（main CI 含镜像构建校验全绿后打）→ release run `38696447739` → **三镜像一次拉成功**（前几日反复超时的 `fde` 这次没闹）→ 清单 `imageId` 与部署机 `docker image inspect .Id` 逐个一致（portal `197fd9ba…` / fde `d80973f3…` / proxy `adf566b4…`）→ `deploy/.env` 形态① pin **三个一起换**（含 `FDE_IMAGE`，备份 `/tmp/deploy.env.bak-0113`）→ `up -d --no-build` → **`docker rm -f` 全部 7 台 fde-\* 后 reconcile 全部落在 `d80973f3…` 且 healthy**（§8.17：动 `runner/` 不重建就还是旧引擎）。

**真机验收（v0.1.13，dev，主 agent 亲手，run `180d90c1…` / `72e2577d…`）**：
- **三种返回形态各一条**：`shell sleep 2` ⇒ 库 `duration_ms=2016`、界面 `✓ 2.0s`；**`writeFile` 写空文件**（digest `0`）⇒ `duration_ms=4`、界面 `✓ 4ms`（**这正是 #283 当年要靠临时闸才拿得到的那一支**，现在是引擎自己写的）；`readFile` ⇒ `3ms`。整页**无假 `0ms`**、无 `undefined`/`[object Object]`/`NaN`。
- **NULL 账**：新 run **0/3 为 NULL**；全库 `33 有 / 745 NULL`，745 全是升级前旧记录（不可回填，属**正确**历史，不是待修数据）。
- **0.20.0 §4 的中止语义**：跑到 25s 点「停止」⇒ `runs.termination = {reason:"aborted", partial:true, usage:{…}, rounds:24}`，**没有谎报 `judge_done`**（修复前那条窗口会给出 success 且**不带 usage/rounds/partial**）；被中止的那次 `shell` 在 `tool_calls` 里 `duration_ms IS NULL` 且无 digest ⇒ 界面不渲染时长（**没伪装成 0ms**）。
- **顺带在现场复现了 #300**：那次停止的 run `partial:true`（引擎把已生成文本挂在 `error.finalText`），而 `runner/worker.js` 固定 `final_text:''` ⇒ 该 run **零助手锚点**（库里只有 user）。**#300 已带这条实测数据**。

### 8.29 管理台「改名」变成受管改名：`call_name`（数据面）与 `name`（展示名）分开（issue #296，2026-10-15）

**病根（两行实现，不是概念分歧）**：`llm.js#toModel()` 的 `name = info.display_name ?? metadata.display_name ?? model_name`，而 `updateModel()` 的 `name` **只写** `model_info.display_name` ⇒ 管理台那一列跟着变、**看着生效**，但数据面 `model_name`（FDE 请求实际发的名字、`fde_llm_bindings.*_model_name`、per-FDE key 白名单存的东西）一字未动。

**定稿（两个名字分开，显式优于隐式）**：新增 `call_name` → **顶层 `model_name`**（操作面）；`name` 的既有语义（→ `display_name`）**一字未动**，兼容面保留。列表两列都可见，改调用名**必须先点确认**（同 #246 改块先例：确认前一个 PATCH 都不发）。

**三条实测换来的信息（worker 跑，主 agent 真机复验后落此节）**：
1. **LiteLLM 不拦同名** —— 两个 deployment 改成同一个 `model_name` 都返 200 ⇒ **拦在门户**：新错误码 `409 model_name_conflict`（登记 `portal.md` §1.2，`details={field:'call_name',call_name,conflicting_model_id}`）。
2. **改数据面名不会顺手改/清 `display_name`** ⇒ 两个字段确实互不干扰，才敢分开。
3. 改名时 **LiteLLM 自己把 key 的 `models` 重写成「只有新名」**（§8.25 已实测过一次）⇒ 我们铺**新旧名并集**正是为此，不打断在途请求。

**传播不新写机制**：`reconcileDataPlaneNameRename()` **复用 §8.25 心跳对账那条路径**（动作在里面转调 `getFdeLlmHeartbeatModels`，**禁止复制一份并集逻辑**），`http.js` 在 PATCH 成功后**立即触发一次**，并**必须传 `ctx.llmGateway` 单例**（§8.25 TTL 缓存按 client 对象身份的坑）；心跳仍是兜底。§8.25 那句「门户内『改名』不是漂移源」已**就地标注部分失效**（原句保留）。

**前端呈现**：沿用 `stores/admin.ts:12` 既有口径「服务端透传的 `error.message` 不译，只加本地化前缀」⇒ **不新增文案键**（与 #246「409 全文可见」同形）。

**测试**：根 **1177 → 1187**（+10，全在 `llm-reconcile.test.js`，含端到端「顶层名落网关 + 立刻铺并集与回写」）、前端 **546 → 552**（+6，`AdminView.spec.ts`）；台账三处已同步。
**主 agent 亲跑变异（不复用 worker 的）**：① 把 `call_name` 的数据面写入摘掉（复现 #296 原病症）⇒ **3 条具名红**；② 立即对账的 `ctx.llmGateway` 传成 `null` ⇒ **恰 1 条红**（端到端那条）；③ 前端确认门改成直接提交 ⇒ **恰 2 条红**（「确认前零请求」+ PATCH 形状）。

**事故记录（§3.0「收尾纪律不能依赖工具调用」又一次发作，这次代价最小）**：worker 主体两个 commit 全落地（后端 +113/+335、前端 +142/+165，沙箱内我复跑 1187/552 全绿），**却被自己一条 `ls /tmp/body-*.html`（glob 无匹配 → 退出码 2）判成终局失败**，报告没写出来。处置：`resume` 同一执行体只补报告、不改代码（主 agent 已并行完成三套复跑 + 三条变异 + 合并）。**口径：给 worker 的工单里，收尾产物一律「直接写文件」，不许用 glob 猜名字。**

**发版与部署**：`TODO(主 agent)`。本单**不动 `runner/`** ⇒ 只需 portal+proxy 两镜像，**不重建 FDE 容器**。真机判据：管理台改调用名 → ① LiteLLM 顶层 `model_name` 变、`display_name` 不变；② `fde_llm_bindings.*_model_name` 回写；③ `/key/info` 的 `models` = **新旧并集**；④ 撞名返 409 且文案点名被谁占用；⑤ 只改展示名 ⇒ 数据面一字不动、不触发对账。

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
