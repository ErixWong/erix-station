# FDE Station 试用问题记录

> **台账（2026-10-23 更新）**：本文是 2026-10-13 的原始反馈记录（保留历史原文，不改写）。
> 7 条已全部登记到 GitHub issue，**追踪以 issue 为准**，见文末「条目 → issue 对照」。

部署：本机 `station.vc.cn-ai.vip:8090`，portal/fde 镜像 = 上游 GHCR v0.1.5（digest 见 deploy/.env）。
发现日期：2026-10-13。反馈渠道：内部记录，择机整理成上游 issue。

---

## 1. 对话页不显示每条消息的时间戳（体验）

**现象**：FDE 对话页每条消息（尤其 agent 长回复/工具循环）不显示返回时间。
命令跑 2 分钟时，用户无法判断"还在执行 / 卡死 / 刚返回"，只能盲等。

**期望**：
- 每条 assistant 消息（或每个 run 的终态）显示完成时刻，至少给"已运行 XXs"的进行中计时；
- run 进行中给出心跳类视觉信号（转圈/脉冲），终态后定格用时。

**代码线索**：`portal/frontend/src/components/StreamPanel.vue` 渲染消息流；
后端事件里应已有时间戳（session events / transcript 落库带 created_at），大概率纯前端展示缺失。

---

## 2. 工具调用时长恒显 `0s`（疑似 bug）

**现象**：每条工具调用折叠行后面都带 `0s`，即使命令实际跑了很久（npm ci 数分钟也显示 0s）。
时长没有正确计算或根本没传给前端。

**排查方向**：
- runner/agentd → portal 的 run 事件是否携带工具调用的开始/结束时间（查 `runner/worker.js` 事件上报与 `docs/api/portal.md` §5.3 run 事件流）；
- 若事件只有 seq 无时间戳 → 上游缺字段（加 additive 字段）；
- 若后端有、前端没算 → `StreamPanel.vue` 展示逻辑问题。

---

## 3. 项目目录名不允许下划线（约束确认 + 建议）

> ⚠ **本文的「代码事实」与「为什么这么定」两条到 2026-10-23 都已过期**：
> ① `PROJECT_NAME_RE` 随 **P5（迁移 `0008-deprojectize.sql`）退役**，今天的校验点在
>    `portal/src/sessions.js#validateSessionCwd`（**一直允许 `_`**）；
> ② 预览 hostname 现在只用**工位名 + 端口**（`<fde>-p-<端口>.<伞域>`），**项目名不进域名**
>    ——「目录名要当 DNS label」这个理由早已不成立（`DNS_LABEL_RE` 也随 P5 走了）。
> 已按「只把 `_` 加进前端表单」交付 = issue **#284**（PR #345，见 `AGENTS.md` §8.44）。

**现象**：新建项目报
`Directory name must be lowercase letters / digits / hyphens, and must not start or end with a hyphen (max 63 characters)`
下划线 `_` 不接受（如 `cmms_test` 被拒）。

**代码事实**：`portal/src/projects.js:21`
`PROJECT_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/`

**为什么这么定（推测，待上游确认）**：目录名直接用作预览 hostname 的 DNS label
（同文件 `:80` `DNS_LABEL_RE` 与之相同——RFC 952/1123 的 DNS label 不允许下划线，
预览域名 `<fde>-p-<port>.<伞域>` 要与项目名对齐，所以项目名被拉齐到 DNS label 语法）。
**结论：不是随手写死的校验，放开头可能是设计使然**（issue #202 就是用真实伞域拼 hostname 做整体校验的）。

**建议**：
- 短期（用户侧习惯）：项目名用连字符替代下划线，`cmms_test` → `cmms-test`；
- 长期（可选上游 issue）：解耦「目录名」与「预览 DNS label」——目录允许 `_`，
  生成 hostname 时做映射/消毒。代价：名字不再 1:1，需文档说明。是否值得，上游定夺。

**注意**：`FDE_NAME_RE`（工位名，同样是 DNS label 语法、进容器名/域名）与此同构，
即便放宽项目名，FDE 名大概率仍需保持 DNS label——提 issue 时别混为一谈。

---

## 4. judge 已判定目标达成，循环却继续跑工具调用（疑似引擎 bug）

**现象**（2026-10-13 实跑，项目 production-scheduling，会话流实录）：

```
round 9 · attempt 1/1
  🔧 shell  cd ~/projects/production-scheduling && python3 -V && python3 -m venv .venv && ...
  judge: executed — 代码已成功从指定 Git 仓库拉取到当前文件夹，git status 确认
         工作树干净且跟踪远程分支，原始任务目标已达成。
round 10 · attempt 1/1   ← 之后继续
  🔧 shell  grep -n "INIT_ADMIN_PASSWORD|..." ...
round 11~13 ...
```

任务本身（clone 到目录）round 9 前就完成了，judge 也明说「原始任务目标已达成」，
但循环没有终止，后续还在 venv/pip/grep/readFile 一路跑（并且又开始装依赖、读 app.py——
有把「达成」之外的事继续自我扩包的倾向）。若用户意图只是 clone，等于白烧十几轮。

**引擎语义**（erix-agent 0.18.0，termination reason 枚举有 `judge_done`）：
worker 侧每轮 `end_turn` 走 round judge 评估（runner/worker.js:410 注：judge 扩轮已开，
`DEFAULT_REFLECTION_MIN_ROUNDS=16` 对齐），judge 常规结论应能触发终局。

**疑点两问（上游定性用）**：
1. `judge: executed` 的 `executed` 是「judge 工具已执行」还是「判定已达成」？若判定的
   结论是 done，为何未产生 `judge_done` 终局？——疑似 judge 评估与终局断链。
2. 也可能是设计如此：judge 只负责 nearLimit 扩轮，不主动叫停，任务边界完全靠模型自觉。
   若如此，需要的是「judge=done → 终局」的可配置开关（用户拍板级），否则长任务会习惯性
   过冲（本例：任务=clone，实际干到了装依赖读源码）。

**附带观察**：本会话所有工具调用都显示 `✓ 0ms`（与问题 2 同源）；round 11 同一文件
`readFile app.py` 连续出现两次（轻微冗余，一并记录）。

---

## 5. 流式输出无活动度指标：建议每条消息显示 TPS / 已收字节（体验，与问题 1 同域）

**现象**：agent 流式回复/长工具执行期间，前端没有任何「活着」的量化信号
（无速率、无字节数、无动量），输出慢时与卡死无法区分——和问题 1 是同一个焦虑的
两种表现：1 要的是「什么时候完成的」，本条要的是「此刻还在不在动」。

**建议**（流式 assistant 消息上，任选其一或组合）：
- 实时 **TPS**（输出 tokens/s，SSE chunk 滑窗估算即可，不必精确）；
- 或 **已收字节/字符数** 计数（如 `↑ 3.2 KB · 14 tok/s`）；
- 终态后定格：总 tokens（若事件里有 usage 就用真值）+ 总耗时。

**方案细化（2026-10-13 补充）：会话页顶部常驻状态栏**（而非每条消息内嵌）：

```
● running · round 12/16 · attempt 1/1 · ↑ 4.1 KB · 27 tok/s · 本 run 03:42 · 工具 8 次（均 12s）
```

- 数据全部前端可得（SSE chunk 滑窗 + 已解析的 round/工具事件），不依赖上游改协议，
  与逐条 TPS 不冲突：全局动量看状态栏，单条定位看消息级时间戳（问题 1）；
- 空闲态显示 run 概况（上次 run 时长/tokens），运行态切实时流；数字冻结 > N 秒
  可自动标黄提示「上游 Xs 无输出」；
- 落点：`portal/frontend` 会话视图（Workbench 聊天区顶部），`StreamPanel.vue` 同一层；
  要精确 token 真值才需 run 终态事件带 usage（待查 §5.3）。

**判断依据**：TPS/字节数是比转圈强的心跳：数值在涨 = 上游在吐字；数值冻结 > N 秒 =
真可疑（前端可顺带提示「上游已 Xs 无输出」）。成本主要在 `StreamPanel.vue` 渲染层，
SSE 事件本身已到前端（逐字渲染存在即证明），纯前端可先行，不依赖上游改协议；
若要精确 token 数才需 run 事件带 usage（待查 §5.3 事件是否已有）。

---

## 6. agent 报「端口已监听」时应同时给出对应的预览 URL（体验，规则层可修）

**现象**（2026-10-13 实跑）：agent 告诉用户「服务在 22000 监听了」就完事。
但对外入口根本**不是** `:22000`（真实 URL 是 `http://eric-p-22000.vc.cn-ai.vip:8090`，
还要门户签票据才能访问）——用户拿着「22000」这个信息无法直达应用，得自己再去
翻 `ports.json` / 猜域名拼接规则，预览链路的最后一公里在对话里断头。

**平台事实**（不是 agent 缺信息，是缺行为约束）：
- `~/.erix/ports.json` 每条分配自带现成的 `url` 字段（实测）；
- 家目录 `~/AGENTS.md`（materializer 生成）已写了预览 7 条要求 + 错误形态对照，
  但只讲「服务怎么起才能被访问到」，**没有一条要求 agent 在对话里把 url 告知用户**；
- worker 系统提示词（`runner/worker.js:73-78`）同样只说「对外访问用清单里的 url」，
  未要求告知。

**建议**：在 `~/AGENTS.md`（materializer 模板）加一条硬规则：
> 起 dev server / 任何对外服务后，回复里必须给出该端口在 `ports.json` 里对应的
> **完整 url**（不是裸端口号），并提醒用户需从门户「打开预览」放行（首次需票据）。

改动面：materializer 模板文本 + `portal/test/materializer.test.js` 断言同步；纯告知层，
不动路由/票据机制。可顺手要求 agent 用 markdown 链接直接给可点击 URL。

---

## 7. 边缘剥 Cookie 头 × cookie-session SSR 应用：预览 URL 登录态必碎（集成缺陷，非单方 bug）

**定性**（工位 agent 实测报告，2026-10-13，项目 production-scheduling）：
平台边缘按设计剥掉整个请求 `Cookie` 头（`~/AGENTS.md` 第 7 条，by design，全方法一致），
而目标是经典 **SSR + Flask cookie session** 应用（`app.py` 93 路由 + blueprints 20 = 113 路由、
41 个 Jinja 模板，仅 4 处 fetch；grep `Authorization|Bearer|request.headers` = 零命中，
认证只有 `login_manager.user_loader` + session cookie）。两边各自自洽，但组合后
**预览 URL 通道上登录态必碎**：POST 登录成功 → 下一跳回 `/login`。

**实证的访问路径矩阵**（agent 实测，非推断）：

| 路径 | 会话可用？ |
|---|---|
| 预览 URL（eric-p-22000…:8090，过边缘） | ❌ 仅 /healthz 与一次性 POST 可用；无 Cookie 头时 GET / = 302 → /login（= 边缘转发后的真实形状） |
| 容器内 127.0.0.1:22000 / 10.200.0.2:22000 | ✅ 全流程通（登录→改密→11 页 200） |
| 宿主 socat LAN 转发（绕过边缘） | ✅ |
| 仓库自带 docker-compose.test.yml（nginx :8001）/生产 nginx | ✅ ——这才是该仓库被构建出来的部署形态 |

**严重度**：预览 URL 走查 = blocker；应用本身与其既定部署 = 不受影响。

**候选方案与真实成本**（agent 评估，建议一并带上游）：

| 方案 | 代码量 | 适用 | 备注 |
|---|---|---|---|
| A. 宿主 socat LAN 转发 → `http://<LAN-ip>:22000` | 0 | 自己/局域网上手测 | 无平台票据链路，cookie 完整；代价 = 宿主开一个口 |
| B. 用应用自带 test 环境（compose + nginx :8001） | 0 | 给干系人演示 | 仓库设计内路径 |
| C. URL 短时签名 token + `before_request` 重填会话（机制同 `main.js:226` 已有的 CSRF 注入；~40-60 行 app.py + ~30 行 main.js，触 base.html） | 中 | 预览 URL | token 进 URL → 日志/Referer/history 污染，必须短命、单用途、外链剪枝 |
| D. 全面 Bearer 重构 | 大 | — | 113 SSR 路由 + 浏览器导航设不了 header ≈ SPA 重写，**不值得** |

**结论建议**：上手测走 A，演示走 B；只有「预览 URL 必须成为真实访问通道」时才做 C；不做 D。
若做 C：按工位规矩开分支（`fix/preview-session-cookie-stripping`）+ env 门
（`URL_SESSION_TOKEN=1`），保证 test/prod 部署保持纯 cookie 会话。

**平台侧追问（值得单独上游讨论）**：剥 Cookie 头的 by-design 动机需要重审——它的防护
目标是什（防 FDE 应用拿平台票据 cookie 做文章？），但代价是把「cookie-session 应用」
（企业内存量 Web 的主流形态）整个排除在预览通道之外。候选的平台侧改法：边缘只剥
**平台自己种的** cookie（按前缀/名字），保留应用 cookie；或反过来把平台票据改塞
header（需 dev server 不依赖）。收益面比方案 C 这类应用侧适配大得多。

---

## 条目 → issue 对照（2026-10-23）

| # | 本文条目 | issue | 状态（截至 v0.1.26） |
|---|---|---|---|
| 1 | 对话页不显示时间戳 | **#282** | **已修**（v0.1.27：每条消息 `<time>` 时刻 + 顶部常驻状态条；真机见 §8.46） |
| 2 | 工具调用时长恒显 `0s` | **#283** | **已修**（v0.1.9 真机验收：`sleep 400` 显 `6m 40s`、硬刷新不丢；`AGENTS.md` §8.21/§8.28） |
| 3 | 目录名不允许下划线 | **#284** | **已修**（PR #345 `eb079c8`：前端补 `_`，后端不动；§8.44） |
| 4 | judge 判达成但循环继续 | **#321** | **已关**：文案（v0.1.19）+ 达成意见回灌（0.22 `judgeDoneAdvisory`，v0.1.22 显式开启）都已真机验证；**但「少跑几轮」未量化**——真机上模型拿到意见后仍继续干了 4 轮才收尾（advisory 是软提示，by design）。真要省轮数需要「judge=done ⇒ 硬停」，那是产品决策，另开单 |
| 5 | 无活动度指标（TPS/字节） | **#282** | **已修**（同上：`↑ 3.8 KB · ~101 tok/s · this run 00:12 · 工具均值`，5s 无输出转黄并点名「上游已 Xs 无输出」） |
| 6 | 报「端口已监听」要同时给预览 URL | **#285** | **已修**（告知面第 8 条 v0.1.8 + 前端裸 URL 自动链接 v0.1.10，§8.24/§8.21） |
| 7 | 剥 Cookie × cookie-session SSR | **#286** | **已关（`not_planned`）**：不改边缘剥 Cookie（两条改法都被否，理由进 `docs/design/principles.md`），只补面向人的告知（侧栏面板 `preview-cookie-notice`）；agent 侧第 7 条早就有 |
| — | 附带发现：逐字流式失效（整段一次出现） | **#342** | **已修**（PR #343 `06bbaa2`，v0.1.26；§8.42） |
| — | 附带发现：预览要点 10 次票 | **#247** | **已修**（v0.1.27：`POST /api/me/ports/batch-tickets` 一次签 N 张 + 前端一键开 N 个标签；真机 0→1 请求开 10 标签。**票据仍是 host 级**，FDE 级单票要 DDL，未做） |
| — | 崩溃恢复后账本 `partOf` 链式 | **#341** + 上游 **erix-agent #415** | 站内读侧已解（`c47a692`）；**引擎 resume 侧未修**，巡检/修数据见 `docs/ops/transcript-ledger-inspection.md` |
| — | 附带发现（#277 验收中）：起跑前被取消的消息，下一个 run 会当待办重做 | **#346** | **open，待产品决策**（三个候选方向的代价已在 issue 里；不是缺陷：取消不撤销消息、也没留助手锚点 ⇒ 模型照上文做事是对的，但用户观感是「取消了又跑去睡 240 秒」） |

**非本文条目但同批推进的**：**#277**（停止无送达 / 停在 `queued` 的 run 卡死会话）**已关闭** —— v0.1.7 就发布了代码，缺的只是「run 停在队列里」的真机窗口，2026-10-23 在 v0.1.27 上造出来并逐项复验（`termination={"reason":"aborted","detail":"cancelled_before_start"}`、会话立即解锁 `202`）；顺带更正该单原判据措辞：出队是 `run_queue.status='cancelled'`，**不是物理删行**。见 issue 评论 `#issuecomment-6370402000`。

> 试用环境口径也已过期：本机现跑 **v0.1.27**（不是 v0.1.5），伞域换成 `fde.erix.vip`，
> 预览端口段从 `40XX` 换成全局号池 `22000–29999`（§8.13）。试用栈 `station.vc.cn-ai.vip` 目前不可达。
