# erix-station — 项目 AGENTS.md

> 项目特有规则；共享约定见 `~/projects/AGENTS.md`（全局）。本文件随仓库走。
> 主远程：`https://github.com/ErixWong/erix-station.git`（**public**；原为 private，现可见性于 2026-10-19 实测确认，转公开的确切日期未考证。三个 GHCR 包随之可匿名拉取，口径见 `docs/ops/ci-release.md` §2）。Issue / PR 在 **GitHub**（不在 Gitea：本仓无项目级 `.mcp.json` 的 gitea 覆盖）。

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

派工环境约定：git worktree **不含未跟踪的 `node_modules`**，worker 进去后测试跑不起来；补装极便宜
（`npm ci --prefer-offline` 热缓存 ~1.4s）。所以派单红线写「不改依赖版本、不提交 lockfile 变动」，
**不是**「禁止安装依赖」。

⚠ **前端只跑一个文件的形式**：**`npx vitest run <文件>` 在本机永久挂死**（`npx vue-tsc` 同），而项目
脚本 3.4 秒跑完 21 条。口径：**`cd portal/frontend && timeout 240 npm test -- src/xxx.spec.ts`**
（`test` 脚本本身就是 `vitest run`，`--` 后直接跟文件）+ **`npm run typecheck`**；工单里写测试命令
**一律带 `timeout 240`**——挂死的命令既不像成功也不像失败，会一直占着会话。

⚠ **每个 worktree 自备 `node_modules`**（`npm ci --offline` 热缓存 ~0.5s）。历史上 `node_modules` 曾被
当文件提交过（mode 120000 符号链接指向绝对路径；`.gitignore` 写的是 `node_modules/`，**带斜杠只匹配目录**），
一棵树被十几个 worktree 共享 ⇒ 任何一处 `npm install` 顺链接剪别处的依赖。形态已由 #396（`679519a`）
消除，判据 `test/repo-hygiene.test.js`（H1 跟踪必须为空，并带「删规则必须看得见」的反向自证）。

**验收 / 发版前先重装一次并复跑拿到基线数**——别拿依赖不完整的树当验收基点（症状：项数从 1022 掉到
510 + 34 失败、`node_modules/erix-agent` 不存在，而代码没回归）。旧 worktree 里遗留的链接现在是未跟踪
文件，`ls -ld node_modules` 看出形态后 `rm` 掉再装。

⚠ **判绿只看退出码**：存在未捕获拒绝时 vitest 照样打印 `Test Files 33 passed (33) / Tests 488 passed
(488)`，**但进程以 rc=1 退出** ⇒ `npm test; echo rc=$?` 或 `npm test && echo GREEN`，**别 grep 摘要行**。
这类泄漏的常见成因：`onMounted` 里 `await` 一个会失败的请求且没 catch（Vue 不等 `onMounted` 返回的
Promise）；产品实例 issue #281。

⚠ **`NODE_ENV=production` 让前端测试假红**：`@vue/test-utils@2.5.1` 的 `emitted()` 靠 Vue devtools
hook 捕获事件，生产构建不发 devtools 事件 ⇒ `w.emitted()` 恒空。同一台机器同一份未改代码实测：未设
18/18 绿、`production` 3 红、`NODE_ENV=test` 18/18 绿。口径：① 跑前端测试**不要设 `NODE_ENV=production`**
（本仓 shell 默认未设）；② 见 `GitLightBadge.spec.ts` 那 3 条红先 `echo $NODE_ENV`，不是并发负载也不是
「worker 环境」；③ 新前端用例**别用 `w.emitted()`**，改用 DOM / 请求桩断言。

⚠ **GitHub 连不上先怀疑本机 DNS / 代理，别反复重试 git**：内网 DNS（`10.56.16.16`）会把 `github.com`
钉到半死不活的地址（TCP 连得上、TLS 握得手、HTTP 不回话），且是**间歇性**的。先现验本机配置，别信文档：
`git config --global --get-regexp '^http\.'`（261110 本机实测只有 `http.https://git.erix.vip/.proxy`，
**github.com 那条根本没配**，所以直连 `direct=000` 超时、显式代理 1.1s 通）。不通时显式带：
`git -c http.proxy=http://172.20.0.35:19001 -c https.proxy=http://172.20.0.35:19001 push origin <ref>`；
**`gh` 不读 git 配置**，得自己带 `HTTPS_PROXY=… gh …`。**别在全局 env 设 `HTTP(S)_PROXY`**——把本来就通
的链代理掉是负收益（曾因此把 `api.ai.erix.vip` 的中转请求代理到卡死）。容器内的 `127.0.0.1` 不是宿主，
也不继承本机代理。别改 `/etc/hosts`（无 sudo）。最新口径见 `~/projects/AGENTS.md`。

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
| 9443 | **管理台入口**（Traefik entrypoint `adminsecure`，#450；host `admin.<伞域>`，TLS 走 `dynamic/tls.yml` 装载的证书）。⚠️ 端口在 `deploy/traefik/traefik.yml` 里**写死**（静态文件不插值）+ `deploy/.env` 的 `TRAEFIK_ADMIN_PORT`，**改端口要同时改两处并重启边缘**；`ADMIN_IP_ALLOWLIST` 空 = 放行全部（#233 防火墙未落地 ⇒ FDE 容器可达）。见 `docs/deploy/edge-routing.md` |
| 4100 | **LLM 网关数据面/管理面**：`station-litellm`（`litellm` profile），默认 publish 到 `127.0.0.1:4100` 回环（`LITELLM_HOST_PORT` 可覆盖），Traefik 经 `LLM_GATEWAY_HOST` 访问；portal 经 backend 网络访问管理 API。见 §4.2 |
| 5432 | DB（backend 网络内，不 publish） |

FDE 容器内的端口由平台分配（见设计文档 §8），不对宿主机 publish。

## 6. Git 与流程

- 大改动走分支 `feat-YYMMDD-NN-<描述>` / `fix-...` → PR 合并 main；小改/文档可直推
- 提交信息：conventional commits + 中文摘要
- **不提交任何密钥**；凭据一律环境变量 / 凭据文件注入
- **CI / 发布（issue #235）**：`.github/workflows/ci.yml` = PR/main 质量门禁 + main 上按路径过滤的三镜像构建校验（只 `ubuntu-latest`，**禁止 matrix**）；`.github/workflows/release.yml` = tag `v*` → GHCR 三镜像（镜像名全小写、`--provenance=false --sbom=false`）+ `images-digest.json` digest 清单。口径、分钟预算语义（超额**是停跑不是扣费、且没有红灯**）、发布→部署的 digest pin（`deploy/.env` 两形态门 + 换 FDE 镜像必须重建容器）、e2e 为何不进 CI，一律见 [`docs/ops/ci-release.md`](docs/ops/ci-release.md)。
- **一单一账写 `docs/maintenance/task-ledger.md`**（编号续用 `8.N`，全局唯一、不重排；挑号前先
  `grep -n '^### 8\.' docs/maintenance/task-ledger.md | tail -3`——并行 session 会撞号，见台账 §8.116），
  **别写进本页**：本页随每次 agent run 全额注入（261111 已把逐单台账搬走，见 §8 末指针）。
  闸：`npm run check:agents-hotlayer`（热层字节预算 + 台账不许多处 + 禁手抄当下数字；`--sync` 才改预算）
- **发布前置**：`package.json` 的 `version` 必须等于去掉 `v` 的 tag（`runner/package.json` 建议一并对齐），
  否则 `release.yml` 直接失败。**这条现在是否成立要现验**（`git tag --sort=-creatordate | head -1` 与
  `node -p "require('./package.json').version"`），别抄本文里写过的数（261110 实测两边都是 `0.1.66`，
  而本页曾长期写着「tag v0.1.1 vs package.json 0.1.0，会被拦」）。细则见 `docs/ops/ci-release.md` §7。

### 6.1 代码 PR 评审要求

**代码 PR 合并前主 agent 必须亲自完成**（文档 PR 不强制；不再要求外部模型评审）：

1. **亲审 diff**：逐文件读改动，不照单全收 worker/评审员结论，属实才修，不属实记录裁决理由。
2. **亲自复跑全部验证**：单测全绿 + 相关 e2e 全绿 + 关键探针亲手复现（别人跑过不算）。
3. **每条修复带验证**；修复引入的回归用 e2e 抓（评审史与实例见 `docs/maintenance/task-ledger.md`）。
4. **合并后收尾**：merge-commit + 删分支。
5. **stacked PR 的 base 分支不要先删**：下层 PR 合并**并删分支**会让 GitHub **直接关闭**上层 PR
   （不是自动 retarget），且 base 已删后 `reopen` 报错、`--base` 也改不动。二选一：① 下层合并后
   **先别删分支**，把上层 base 改成 main 再删；② 上层一开始就 `--base main`（diff 含下层提交，
   下层合并后自动收敛）。

需要第二意见时按需调 copilot_cli 复核（用法按全局 `~/projects/AGENTS.md`，本项目无特殊定义）。

## 7. 已定架构决策（详见 docs/design/fde-platform.md 附录 A）

- D1 Traefik 作 ingress；D2 SSO + 本地 break-glass admin；D3 每 FDE 仅自己的 `/29` 独立网络（`control` 共享网络已取消，H-B 定稿 issue #5）
- D4 不 publish FDE 端口；D5 端口由平台分配（DB 为真相）；D6 LLM 走唯一出口网关（「改不了 endpoint」依赖安全团队网络层出口策略，非平台交付物——issue #3）
- D7 事件落 DB、portal 供 SSE；D8 隔离单元 = worktree（**已修订**，见下方 D8 修订段）；D9 目录 git 状态 = 一颗红/黄/绿灯（见下方 D9 段，issue #359）

### 7.1 D8 修订：cwd 直达项目目录，拆除 worktree

D8 原文「隔离单元 = worktree」修订为「**隔离单元 = 项目目录（cwd）**」：

- **新语义**：worker cwd = `~/projects/<project>`（jail 可写边界不变）；`prepareWorktree` /
  `cleanupWorktree` 已拆除，产物捕获目标改项目目录，非 git 项目不再需要 mkdir 兜底。
- **边界**：agent 弄脏项目由用户 git 自治（工位语义本就如此）；真要并行跑同一项目，再按项目粒度加
  执行锁，**不预支 worktree 复杂度**。
- 决策理由与实证过程见 `docs/design/fde-platform.md` 附录 A。

### 7.2 D9（issue #359）：目录 git 状态只以「红/黄/绿」一颗灯呈现

- **语义**：灯 = **收工进度**，一句话给用户的判据是「**每天忙完之后要保证它是绿的**」。
  🔴 未落地（未提交 / 未跟踪 / 0 提交但有内容）→ 🟡 未推送（有提交未推 / 无远端 / 从未 fetch）
  → 🟢 已收工；⚪ 读不到或未查完——**⚪ 不得渲染成绿**（绿是承诺，没扫完就没资格承诺）。
- **渲染规则**：**未跟踪与未提交同罪**（都是零兜底）⇒ 同归于红；红是**进度不是警报**（agent 一改就
  红，直到收工）⇒ 措辞用状态词、不给 `⚠` 与告警底色。
- **边界**：portal **零 git 写操作**（不 init / 不 commit / 不 push / 不 checkout / 不代 clone，
  与 D-「平台不 clone」同口径），写一律走 run = 界面上的「让 AI 收尾」（只**预填**输入框不自动发：
  发 run 占 capacity 且花 token）。搞不清就「问 AI」——**每个态都留这条兜底**，这是闭环的最后一环。
  唯一保留的 git 细节是「**仓库名**」，因为预填给 AI 的话必须指名目标仓库（一个目录多个仓库是真实现状）。
- **数据源**：宿主 portal 直读 `<userSpaceRoot>/<fde>/projects/<dir>/.git`（与 `/api/dirs`、`/api/files/tree`
  同一条 bind mount 通道）；一个仓库 = 一条 `git status --porcelain -uall` + 三次纯文本读 sha。
  ⚠ **不得用 `-uno`**（实测它让 0 提交的根仓库对三个脏子仓库报空输出、rc=0，自认干净 ⇒ 直接撒谎）。
  成本上界靠 `.gitignore` 剪枝 + stdout 流式数到 50 即 kill + 2s 超时（超时落 ⚪）。
- **不做什么**：分支列表/分支数、detached、worktree/子模块结构、最后提交时刻、↑N/↓N、diff 内容、
  inotify 事件源——全不做（决策理由、交付过程与实测记录在 `docs/design/fde-platform.md` 附录 A.2
  与 issue #359；**注意附录 A 的 `D9` 是「认证放边缘」，与本页这条 `D9` 编号撞车，引用要带 issue 号**）。

## 8. erix-agent 依赖与升级

- **pin 以 `package.json` 的 `erix-agent` 字段现读为准，本页不写死版本号**
- **源仓库**：`~/projects/erix-llm-kit`（npm 包名 `erix-agent`）。升级依据以该仓库 `docs/host-consumer-contract.md`、对应版本 host-upgrade-guide 和实际源码为准。
- runner 与 portal（根 package.json，运行时依赖）**两处 pin 同步**：自 P3 前置起 portal 也 pin（写侧预写改走引擎 `appendUserTurn`，见 §8.4；0.16.0 见 §8.5；0.17.0 见 §8.6；0.18.0 见 §8.8）。升级仍走分支 + PR + §6.1 评审。

> **`§8.N` 台账已整体搬家（261110，编号不变）**：上面三条引言之后原有的全部内容——113 条
> `### 8.N` 逐单记录、若干叙事块，以及《0.14.0 宿主契约快照》——**原文搬进
> [`docs/maintenance/task-ledger.md`](docs/maintenance/task-ledger.md)**，一条没删、一个编号没改。
> 本页从此只到这里为止：**逐单历史不是每轮要注入的判据**（搬走 652,581 字节）。
>
> - **查某一单**：`grep -n '^### 8\.42 ' docs/maintenance/task-ledger.md`（编号 = 全局坐标）
> - **写新账**：续用 `8.114` 起的编号，写在那同一个文件（规矩见 §6）
> - **不许改号、不许重排**：`§8.N` 是全仓解析坐标；引用面由 `npm run check:agents-hotlayer` 现算
>   并设地板（只升不降，掉了就是有人改号或删引用）
> - **现契约**不在这里：以 `erix-llm-kit` 的 `docs/host-consumer-contract.md` 与对应版本
>   `host-upgrade-guide-*.md` 为准（本节引言第二条已给路径）
