# erix-station — 项目 AGENTS.md

> 项目特有规则；共享约定见 `~/projects/AGENTS.md`（全局）。本文件随仓库走。
> 远程 `https://github.com/ErixWong/erix-station.git`（public）；**issue / PR 在 GitHub**，不在 Gitea。
> **本页只放 policy**：能改写成祈使句（做 X / 不做 X / 冲突时怎么办）才配进来；
> 「X 是什么值 / 是什么样 / 曾经出过什么事」是事实——写进 `docs/` 并在这里留指针。
> 闸：`npm run check:agents-hotlayer`（口径见 `scripts/agents-hotlayer-budget.mjs` 文件头）。

## 1. 项目定位

**FDE Station** —— 给 FDE 用的开发工位平台（宿主平台）。

- **每 FDE 一台容器小电脑**，容器内 `~/projects/<project>` 一个项目，worker 的 cwd 直达该项目目录（§7）
- **erix-agent 是引擎**：本项目不实现 agent 逻辑，只做「谁在用 / 在哪跑 / 怎么访问 / 花多少」= 宿主侧
- **统一入口**：Traefik 单入口 + 泛域名，认证在边缘，应用不感知
- **边界**：agent 不内置安全（erix ADR-009），**牢笼由本项目提供**
- **对 erix-agent 只依赖公开 API**（`runToolLoop` / `TranscriptStore` / `erix-agent/tools`），
  **不改它的行为**；上游能力缺口提到
  [erix-agent](https://github.com/ErixWong/erix-agent) 的 issue，不在本项目里绕

## 2. 三条不变式（改代码前先读）

1. **容器是信任边界**：FDE 容器不 publish 端口、不挂 `docker.sock`、不持有平台密钥
2. **ingress 是唯一的路**：任何「绕过 Traefik 也能访问」的设计都是 bug
3. **DB 是状态真相**：容器是牲口，重建后必须能从 DB + 卷恢复

## 3. 代码与文档结构

```
portal/     # 管理平台服务：用户/项目/端口/容器生命周期/事件/LLM 网关
runner/     # 容器内 agent worker（接 erix-agent，跑 runToolLoop）
deploy/     # compose、traefik 配置模板、FDE 容器模板
docs/       # 文档地图 docs/README.md + design/ + api/ + data/ + ops/ + deploy/ + maintenance/
```

- **动手前先读三份**：`docs/README.md`（文档地图）、`docs/design/fde-platform.md`（主规格）、
  `docs/design/principles.md`（为什么与被否决方案）
- **文本/语义类变更不设脚本闸**（翻译、措辞、提示词、文档正文都在此列）：脚本只会看形状，看不出意思，
  为了「看起来像审过」而写的 `if/else` 只会把注意力换成改常量的力气。闸只配管**可机械判定的事实**
  （文件在不在、脚本能不能加载、命令退出码、契约字段形状、坐标有没有漏进仓库）；
  文本对不对由**单测钉具体字面期望** + 真机腿看渲染 + 人读。案例与被否方案 ⇒ `docs/design/principles.md` §3（#803）。
- **文档纪律**：规格未覆盖时按原理推导，不与规格冲突就写进文档；**冲突则提 issue，不自行改设计**

## 4. 开发命令

| 命令 | 用途 |
|---|---|
| `node --check <file>` | 语法保底（零依赖 Node ESM） |
| `npm test` | 单测（`node --test`，仓库根）；**判定只认退出码，别 grep 摘要行** |
| `node --test 'runner/test/*.test.js'` | runner 侧单测（`node --test runner/test/` 在本机 rc=1，是口径不是回归） |
| `npm run check:frontend` | 前端闸（根目录一条命令 = `typecheck` + `vitest`，**判定只认退出码**，见 `docs/testing.md` §1.2.2）；**单文件用 `timeout 240 npm test -- src/xxx.spec.ts`**（`npx vitest run <文件>` 本机永久挂死） |
| `docker compose -f deploy/docker-compose.yml up -d` | 本地起平台栈 |

- **测试隔离**：涉及用户配置 / 容器网络的测试必须注入路径参数，不碰真实环境。
- **跑前端测试别设 `NODE_ENV=production`**（会让 `emitted()` 恒空 ⇒ 假红）；新用例别用 `w.emitted()`，
  改用 DOM / 请求桩断言。
- **验收 / 发版前先重装依赖再复跑拿基线**；每个 worktree 自备 `node_modules`（`npm ci --offline`）。
  派单红线是「不改依赖版本、不提交 lockfile 变动」，**不是**「禁止安装依赖」。
- 本机测试环境的坑与 dev 栈登录事实 ⇒ `docs/testing.md` §1.3；本机坐标（版本/端口占用/口令路径）⇒ 冷层 `~/projects/docs/station-dev-machine.md`。
- **本机连 GitHub 不通时先现验代理配置再动 git，别反复重试** ⇒ 全局 §3.7；本机代理取值/主机名 ⇒ 冷层 `~/projects/docs/station-dev-machine.md`。

### 4.1 dev 栈访问与探针口径（仅本地 dev）

- 入口、账号、口令文件位置、第二因素现状 ⇒ `docs/testing.md` §1.3；**登录体字段是 `login` 不是 `username`**
- **脚本/agent 要调 API ⇒ 登 dev 专用脚本账号**（**名字是 dev 坐标 → 取值与口令路径一律看冷层**
  `~/projects/docs/station-dev-machine.md`；下面统称「脚本账号」）（口令直通：不开邮箱码也不开 TOTP ⇒ 零邮件、
  不卡第二因素；`Origin` 要求 ⇒ `docs/testing.md` §1.3）。
  **别登人的账号**——开着邮箱验证码的账号每登一次寄一封真邮件，而脚本读不到那枚码
- 要管理员面就登 `admin`；要测第二因素：自建带 TOTP 的种子账号走 step1+step2（做法同 §1.3）
- **别用 `Authorization: Bearer` 打 API**（令牌路由当前关着；关的是路由、能力保留），**脚本一律登脚本账号走会话**；
  现场与启用开关 ⇒ `docs/api/portal.md` §2.13

### 4.2 LLM 网关（LiteLLM）

- **模型目录与上游凭据的唯一真相源是 LiteLLM 的 DB**；本项目不再自建 provider/model 表，
  管理台 LLM tab 只是它的薄代理（`portal/src/llm-gateway.js`）
- **起栈要显式启用 profile**：`docker compose --profile litellm up -d`（默认不起）
- **改 FDE 模型白名单走 `/key/update` 原地更新，不重铸 key**（同 alias 铸新 key 撞唯一约束）
- **credential 没有启停语义**：模型启停只能映射到 `/model/block|unblock`
- **上游模型 id 必须自带 provider 前缀**（`openai/<model>`），系统不会自动加
- **`LITELLM_SALT_KEY` 写过之后不可更改**（旧密文将无法解密）
- **不对外暴露 LiteLLM 自带 UI**（不在验收面上）
- 端口 / 凭据变量 / 路由细节 / 遗留项 ⇒ `docs/env.md`、`docs/design/deploy-contract.md`、
  `docs/deploy/edge-routing.md`、`docs/design/fde-platform.md` §11.4–§11.5

## 5. 端口

- **FDE 容器内的端口由平台分配（DB 为真相），不对宿主机 publish**（不变式 1、D4）
- **容器清单只从 DB 取**（`containers` 表），禁按 `^fde-` 前缀批量操作容器
- 本机端口占用实况与开发期取值 ⇒ 冷层 `~/projects/docs/station-dev-machine.md`；平台端口不变式 ⇒ `docs/env.md` §5；
  管理台入口 9443「改端口要动哪两处」与来源白名单 ⇒ `docs/deploy/edge-routing.md` §4 / §6

## 6. Git 与流程

- 大改动走分支 `feat-YYMMDD-NN-<描述>` / `fix-...` → PR 合并 main；小改/文档可直推——
  但**任何变更都不许直接在 main 上改**（全局 §3.1，没有小改动例外）
- 提交信息：conventional commits + 中文摘要；**不提交任何密钥**，凭据走环境变量 / 凭据文件
- **CI 与发布**（`.github/workflows/ci.yml`、`release.yml`）：门禁口径、分钟预算语义、digest pin、
  `--provenance=false` 的理由、e2e 为何不进 CI、**发布前置的版本对齐要现验**，一律 ⇒ `docs/ops/ci-release.md`
- **不写逐单台账**：一单做了什么、怎么验的，写进 **issue 与 PR 正文**（GitHub 是唯一真相源）；
  以后还要遵守的判据写进本页（**须用户拍板**）；环境 / 参数 / 坐标事实写进 `docs/` 对应页。
  **禁止新建逐单叙事文件**，也禁止把逐单叙事写进本页（本页每次 agent run 全额注入）。
- **仓库文档必须可公开**：本机/内网坐标（内网 IP、tailnet IP、内网主机名、凭据文件路径、宿主端口占用）不写进本仓库，一律放 `~/projects/docs/`，仓库里只留指针与现验判据；闸 `npm run check:doc-portable`（经 `npm test` 跑到）。⚠ **本闸只查坐标，不查账号名**（原「身份词表」已按用户裁决移除）：坐标一律子串匹配，且会扫 `*.js`/`*.mjs`/`*.cjs`/`*.ts`/`*.vue` 的**注释行**（261124 实测：只写 `*.js` 拦不住 `.mjs` 注释里的代理 IP）。**代码行只在一种情况下被拦**：`portal/integration/**` 里同一行同时含两个凭据路径片段（#897，唯一豁免 = `portal/integration/lib/dev-creds.mjs`）；其余代码行仍是坐标的合法藏身处。dev 账号名属冷层坐标、仍不进仓库（见上），但不再由本闸强制。
- **证据与依据只写形态，不写值**：验收记账写「寄到该账号绑定的邮箱并收到」，**不写**邮箱地址 /
  主机名 / 绝对路径 / 端口；注释写「存量里有带下划线的」，**不写**真实目录名 / 容器名 / 入口地址。
  **证据段落是身份与坐标的集中营**。

### 6.1 代码 PR 评审要求（合并前主 agent 必须亲自做完；文档 PR 不强制）

1. **亲审 diff**：逐文件读改动，不照单全收 worker / 评审员结论；属实才修，不属实记录裁决理由
2. **亲自复跑全部验证**：单测全绿 + 相关 e2e 全绿 + 关键探针亲手复现（别人跑过不算），且只认退出码
3. **每条修复带验证**；修复引入的回归用 e2e 抓
4. **合并后收尾**：merge-commit + 删分支
5. **stacked PR 一开始就 `--base main`**，或下层合并后**先别删分支**再改上层 base
   （base 分支被删会让 GitHub 直接关闭上层 PR，且 reopen / `--base` 都救不回来）

需要第二意见 ⇒ 见全局 `~/projects/AGENTS.md` §3.1：**代码 PR 必须在合并前**有独立第三方评审
（评审结论逐条现验：属实才修，不属实记裁决理由）。**合并之后再审只能落成补修 PR，不再是闸门**；
模型与权限档用法按全局 §2。**文档 / 配置类 PR 可免。**

## 7. 已定架构决策（详见 docs/design/fde-platform.md 附录 A）

- D1 Traefik 作 ingress；D2 SSO + 本地 break-glass admin；D3 每 FDE 仅自己的 `/29` 独立网络
- D4 不 publish FDE 端口；D5 端口由平台分配（DB 为真相）；D6 LLM 走唯一出口网关
  （「改不了 endpoint」依赖安全团队的网络层出口策略，非平台交付物——issue #3）
- D7 事件落 DB、portal 供 SSE；D8 隔离单元 = worktree（**已修订** ↓）；
  D9 目录 git 状态 = 一颗红/黄/绿灯（issue #359 ↓）

- **D8 已修订（附录 A.1）**：隔离单元 = **项目目录（cwd）**，`prepareWorktree` / `cleanupWorktree` 已拆除；
  agent 弄脏项目由用户 git 自治，真要并行跑同一项目再按项目粒度加执行锁——**不预支 worktree 复杂度**
- **D9（issue #359）收工灯**：灯 = **收工进度**，一句话判据「每天忙完之后要保证它是绿的」；
  🔴 未落地 → 🟡 未推送 → 🟢 已收工，**⚪ 不得渲染成绿**；**未跟踪与未提交同罪归红**；红是进度不是警报，
  措辞用状态词、不给告警底色。**portal 零 git 写**（不 init / commit / push / checkout / 代 clone），
  写一律走 run，「让 AI 收尾」**只预填不自动发**；数据源 `git status --porcelain -uall`，
  **不得用 `-uno`**（实测它会撒谎）。四态语义、实测与成本上界 ⇒ 附录 A.2；**引 `D9` 必带 issue 号**（理由 ⇒ 附录 A.3）

## 8. erix-agent 依赖与升级

- **pin 以 `package.json` 的 `erix-agent` 字段现读为准，本页不写死版本号**
- **源仓库**：`~/projects/erix-llm-kit`（npm 包名 `erix-agent`）。升级依据以该仓库 `docs/host-consumer-contract.md`、对应版本 host-upgrade-guide 和实际源码为准。
- runner 与 portal（根 package.json，运行时依赖）**两处 pin 同步**：自 P3 前置起 portal 也 pin（写侧预写改走引擎 `appendUserTurn`）。升级仍走分支 + PR + §6.1 评审。

> **现契约不在本页**：以 `erix-llm-kit` 的 `docs/host-consumer-contract.md` 与对应版本
> `host-upgrade-guide-*.md` 为准（本节引言第二条已给路径）。
