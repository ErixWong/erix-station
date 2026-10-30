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
| — | 附带发现（决策者 2026-10-24 口述）：目录下拉第一项是 `.pnpm-store`，真项目被顶掉 | 无 issue（当日直修） | **已修**（两层：`dirs.js` 下拉不列 `.` 开头目录 + `runner/Dockerfile` 把 npm/pnpm/corepack/pip 缓存默认钉到 `~/cache`；现网已热补，**镜像未重建**；PR #360 / 台账 §8.51） |

**非本文条目但同批推进的**：**#277**（停止无送达 / 停在 `queued` 的 run 卡死会话）**已关闭** —— v0.1.7 就发布了代码，缺的只是「run 停在队列里」的真机窗口，2026-10-23 在 v0.1.27 上造出来并逐项复验（`termination={"reason":"aborted","detail":"cancelled_before_start"}`、会话立即解锁 `202`）；顺带更正该单原判据措辞：出队是 `run_queue.status='cancelled'`，**不是物理删行**。见 issue 评论 `#issuecomment-6370402000`。

**#278**（中止/运行中的部分输出不落库也不呈现）**已关闭**（2026-10-24）——不是一张修完，而是三块分别落在 **#300**（`partial_output` 响应期合成，v0.1.15）/ **#306**（点停止当场出现，v0.1.23）/ **#236-1**（终局标记从 `runs.termination` 投影成 `run_termination`，main `135ddf6`，**未发版**）。硬红线真机取证（会话 `481b7dd8…`，跑在部署中的 v0.1.27）：**停止前 644 字 → 停止后 645 → 硬刷新后 645（逐位相同）且工具卡保留**；中止那张卡的 `…` 是诚实的（宿主 `tool_calls` 该行 `duration_ms`/`result_digest` 均 NULL = 停止时真在跑，#283 口径）。`partialPersistence` **不开**（#301 已评估并记重开条件）；顺带在同一现场拿到 **#288 不盲目重放**的真机形状（round6 合成「上次执行被中断」、round7 是模自己重试）。

**#236**（首次部署验收里的低优先项，3 条）**已关闭**（2026-10-24，PR #347，merge `135ddf6`）：第 1 条「终止文案看不见」= 双语标签 + 刷新后终态分隔条改为**从 `runs.termination` 投影**（`run_termination` 合成项，**没把 `run_end` 塞进历史白名单** —— 那是该单定的红线）；第 2 条「空 body 的 POST 强制 `Content-Type`」= 按请求是否可能带主体判定，`Content-Type` 只在真有主体时强制。真机：`curl -X POST …/stop` 无 body 无 CT 由 **400 → 200**（反面：带 body 不声明 CT 仍 400），重开 `aborted` 会话可见中性中文 `run 结束：aborted — 已中止`，`failed` 仍红色且带 `code=`，**硬刷新后条数不变（4→5→刷新仃 5）**。呈现上有一处改判需决策者过目：`aborted` 实时也从红色改中性（与历史同色）。**第 3 条拆到 #348**（每 run token/成本护栏 —— 需产品决策）。台账 `AGENTS.md` §8.47；**未发版**（v0.1.27 不含它）。

### 🌙 夜班批次（2026-10-24 无人值守：v0.1.28 → **v0.1.29**）

| 条目 | 状态 |
|---|---|
| **#273** 工作区 setgid 假话 | ✅ **已交付 + 评审 blocker 已返修**（`e274d49` + `87e4365`）：决策 = 改口 `0770` 不加 `CAP_FSETID`；真机取证确认**同一棵树混着**（`eric/projects/probe-343`=2770 / 同树 `probe-261014`=770）；补上「属主写点必须同传 uid+gid」前提与 `2755/775` 继承解释 |
| **#295** markdown 裸 URL 三修 | ✅ **已交付 + 评审返修 + 发布物真机验收**（`7d1ccce` + `3edd679`）：占位符保护（非重排序）、左边界三层派生单一来源 `URL_WORD_SYMBOLS`、删不可达的 `&`；v0.1.29 上带两个 `_` 的裸 URL → 单一 `<a>` 全文保留且无 `<em>`，`[**x**](…)` 的 `**` 未进 `href` |
| **#256** 号池占用总览 + 429 带秒数 | ✅ **API + 前端已交付 + 评审返修 + 发布物真机验收**（`83e3080`/`d12b714`/`b14bf54`/`41dd2cd` + `e66ac16`/`03d5842`）：fake 从子串匹配改成**真解析 SQL**、零字面量按**数值**判、`?limit=` 空串语义定死；v0.1.29 上 `summary` 逐字段自洽 `800 = 795+0+5`、审计恰 1 行。**面板 UI = #350 open** |
| **#349**（新）前端测试环境脆弱 | ✅ **已修并关闭**（`bd2a32e`）：`?raw` 取代 `node:fs`，全量门第一次不依赖 vitest transform 缓存 |
| **v0.1.28** | ✅ **已发布并部署**（`8c7906d`；portal imageId `4ce2a7db…`、proxy `3b44b32f…` 逐位核对；服务 bundle `index-Zms29SHi.js`） |
| **v0.1.29** | ✅ **已发布并部署**（`5d967c6`；main CI `40004642827` 绿后打 tag → release `40005238179`；portal `imageId=2a32a0f4…`/`digest=ea45ec01…`、proxy `imageId=ba408140…`/`digest=56fc03b3…` 逐位核对；服务 bundle **`index-BrgEGHCI.js`**；经 Traefik `healthz=200`）。载荷 = 上面四单；`runner/` 零实质改动 ⇒ **五台 FDE 容器故意未重建** |
| **#350** 管理台号池占用总览页 | ✅ **已交付 + 发布物真机验收**（`491cb9d` cherry-pick（patch-id SAME）+ 我补的 `50eff39`）：管理台第 4 个 tab，真数据逐字段对得上直采 API；改块提示三态「被占用（点名占用者 + 会被 409）/ 整段空闲 / **不知道**（空闲列表是截断的）」在真机上成立，开面板隐式请求 0 次、零自动提交。**worker 推翻了我工单两条契约字段**（`start_block` 不存在；自洽关系是 `= partial + occupied`） |
| **#351**（新）会话砖化 | ✅ **已关闭**（当时登记 → 另一台主机以 `4ae2634`「引擎面向的 `store.load()` 做读侧折叠」根治，**本机的发布面验收在 10-27 的 v0.1.43 上才做到**，见下方新批次）：正面对象 `ec8a77b3…`（结果行在、被 `:input:` 插队）发一条消息 ⇒ `judge_done`；新会话现跑「起长命令 → 点停止 → 再发一条」⇒ `judge_done`（修复前该动作会永久砖化）。另一标本 `1ead0b1a…` 仍红 ⇒ **顺带查出第四种砖化形状**（见下） |

### 🌙 夜班批次（2026-10-27 接班：仓库快进 94 个提交 → **v0.1.43** 部署到本机）

> 接班先分清**三层**：仓库同步（已快进到 `0c47329`）≠ 部署面（本机还跑 **v0.1.30**、缺迁移 `0022/0023/0024`）≠ 存量数据。`#351`/`#352` 的「还 open」在这一天全部是**后两层**，不是代码待办。

| 条目 | 状态 |
|---|---|
| **v0.1.43** | ✅ **已发布并部署**（`fafe4a7`；main CI 两个 job 绿后打 tag → release `40527305596`；portal `imageId=827ec194…`/`digest=aa036666…`、fde `78ec7b00…`/`6882cb5a…`、proxy `aa91d2fa…`/`d5453b04…` 逐位核对 → 五台 `fde-*` 重建后容器内 `erix-agent` = **0.26.0**、agentd 双向链路通；迁移 0022–0024 由 portal 启动自动应用）。⚠ **不发已发布的 v0.1.42**：它含 #416 但**不含** #419 补漏（`fde-proxy` env 白名单缺 `ERIX_AGENT_VERSION` ⇒ `provision-fde` 上线即炸），「有 tag」≠「能部署」 |
| **测试可移植性（新）** | ✅ `53191cd`：`runner/test/listeners.test.js` 的跳 UID 用例写死 fixture owner uid=1000，而实现故意「owner == 自身 uid 就切而不切」⇒ **在 uid=1000 的开发机上必然红**（CI 是 1001 所以看不见的）。改 `OTHER_UID` 后本机 **399/399**；三条变异各恰 1 条红 ⇒ 不是放宽断言 |
| **#352** 按项目看端口占用 | ✅ **已关闭（观测层 B+）+ 发布物真机验收**：agentd 采样 `/proc` → U4 心跳 → `port_observations`（迁移 0022）→ `GET /api/me/ports` 每行加 `observed`（只做加法，原 8 列不动）。真机特意造了 **agentd=uid 1001 / 监听进程=uid 1000** 的跳 UID 形状 ⇒ `pid/cwd/branch/cmd` 全拿到（这条单测在 uid=1000 机上结构上测不到）；池外 3000 合成 `state='observed'` 只读行，而 Docker 内嵌 DNS（uid 0、无项目 cwd）**入库但不进面板**（按 `~/projects/` 过滤，设想的）；界面 `probe-351  Current` 分组排最前 + `Spare (9)` 折叠 + 「同目录同时候在 3000 与 22000」告警（截图 `/docker/erix_station_playwright/v0143-352-two-panels.png`） |
| **账本第四种砖化形状（新）** | ✅ **已定位 + 已修数据 + 两个会话真机复活**：`:resume` 载体裸重放「已在**别的轮**结清的 `tool_use`」⇒ 折叠救不了（造不出缺失的那条 `tool_result`）。判据与手术整节落 `docs/ops/transcript-ledger-inspection.md` **§7**（⚠ 判据必须**带轮**：按 id 查孤儿得「干净」假结论，按记录判在 0.23+ 上是 9 会话误报）。定性 = **历史化石**（两条载体 ts 是 10-08 / 10-15 旧引擎；0.26.0 现跑的 `:resume` 行不带 `messages`）。修前/修后都拿**引擎自己的校验器**判（`index 36` / `index 73` → PASS），真机两会话 `judge_done` |
| 基线刷新 | 根 **1656 / 1652 / 0 失败 / 4 跳过**、runner **399/399**、前端 **50 文件 / 925** + `typecheck` rc=0（台账原值 1493 / 221→323 / 47 文件 857 均过期）；台账 `AGENTS.md` §8.72 |

### 🔭 观察队列（不指派，等信号）

- **#367**（存量链式 `partOf` 修数据）：**本机无事可做** —— §1.1 巡检 **0 行**、§6.1 超 1 MiB **0 行**，且该单点名的会话 `9e0c8a17…` 在本机 DB 里**不存在**（那是另一台部署的标本）。⇒ 这类 issue 的「还 open」是**别台机器的存量**，不是本机待办；巡检手册 §7.1 已新增第四类判据。
- **#341**：上游已把**写侧**链式 `partOf` 修掉（erix-agent 0.26.0 `orchestrator.js` 锤定首片，注释点名 issue #430），但**读侧仍解不了存量链** ⇒ 站内临时闸（`portal/src/transcript-fold.js` / `runner/lib/transcript-fold.js` + 哨兵用例）继续留着，**不要拆**。
- **#303**：0.23.0 读侧仍有 7 条路径认顶层旧名 ⇒ `?? tr.duration` **不许删**；触发条件已改成「旧 transcript 行归档时」。
- **#331**：`ERIX_SESSION_AUTO_TITLE` 死光纤（#322 之后 `runner/` 零读取，但撤它要动 portal + 两处测试）。
- **#346 / #348 / #321 残留**：需产品决策。

### 📋 未关闭 issue 分层（2026-10-27，27 个 open 全量过一遍）

> 判据不是「issue 还 open」而是**代码/部署/数据三层分别在哪**。取证方式：`git log v0.1.30..HEAD` 里的 issue 引用 +
> `AGENTS.md` 各小节覆盖 + 关键实现 grep（本节每条都点到了具体文件/提交/小节）。**结论先说：真正需要写代码的只有 6 条**，
> 其余是「已交付待关」「产品决策」「上游阻塞」「陈旧」。

#### A. 代码已落 ⇒ 只需一次收尾动作（可关）

| issue | 依据 | 关它需要什么 |
|---|---|---|
| **#404** containers.image / agent_version 不回写 | §8.69（三条写路径 + 409 幂等）+ §8.70（`runner/lib/build-info.js`、心跳回写 `portal/src/internal.js` 的 `agent_version` 均已在 main）；结案评论已实测现网自动改写 | 只剩「谁读这一列」的**消费面**（§8.70 明说本片不做）⇒ 关它并把消费面另开一单，或标 not planned |
| **#366** 文件预览定稿（kkFileView） | PR #372 merged（`aaf8294`）、§8.57；`deploy/docker-compose.yml` 的 `kkfileview` 服务在册 | 遗留 ① kk 镜像 push GHCR + digest 钉 ② 发版窗口；本机 v0.1.43 **未启用该 profile** ⇒ 部署面未验。建议：关 #366（方案已落），部署验收另开 ops 单 |
| **#356** 自托管 kkFileView | 被 #366 取代并已实现 | 直接关（注明 superseded by #366） |
| **#359** 目录 git 一颗灯 | §8.53（告知面）/ §8.54（`GET /api/git-light` 已在 `portal/src/http.js`）/ §8.55（portal 镜像装 git）/ §8.56（灯上界面） | P0a/P0b/P0c 全交付；剩下的是「每天绿」的产品习惯与 P1 项 ⇒ 关它，P1 另开 |
| **#392** 长会话压缩退化成静默硬删 | §8.65（`context.strategy` 已配，`runner/worker.js` 有 `strategy:`）/ §8.66 C 片 / §8.67 E 片（含当场抓到的死光纤）/ §8.68 D 片 | A/C/D/E 四片都在 ⇒ 关它 |
| **#412** wp3b 在部署机跑不起来 | ④ 已交付（§8.71）；其余子项（worktree 缺 `deploy/.env`、物化目录 EACCES、proxy bind source realpath）**未见对应提交** | 部分交付：关④子项，把剩下三项拆成独立单（否则这张单永远「半开」） |
| **#371** 接住 0.25.0 落盘面 | A（`persistence_error{fatal:false}`）/ B（`MAX_ROUND_BYTES` env）/ E（归档去重命中性）已交付（§8.59/§8.60）；0.25.0 已升 pin（§8.60） | 剩 **C**（`record` + `folded_payload` 双列存储去重）与巡检改写 ⇒ 部分，建议拆单 |
| **#367** 存量链式 `partOf` 修数据 | **本机 0 行**（§1.1 巡检）、点名的会话 `9e0c8a17…` 本机 DB 不存在 ⇒ 是别台部署的存量；本机侧另加了第四种形状判据（手册 §7，2026-10-27 评论） | 只有**持有那份数据的那台部署**能关它；本机无事可做 |

#### B. 真待做（要写代码，按建议顺序）

| issue | 为什么是真待做（取证） | 面 |
|---|---|---|
| **#421** 引擎 16 类事件里 5 类前端收不到 | 实测：`tool_input_delta` 在 `useEventStream.ts` 与 `http.js` 历史白名单里**都是 0 命中**；`model_metadata_missing` 历史有、实时没订（EVENT_TYPES 0 命中）；`round_start`/`persistence_error`/`attempt_killed` 已通 | 中（三处同步判据 + 历史回放） |
| **#387** 「查看原文」工具只有「调了什么」没有「返回了什么」 | §8.62 记录实测 `resultPreview` **0/98**；主消息流靠 `tool_calls` join，重建路没配对 ⇒ 要动 `rebuildFoldedRange` | 中 |
| **#399 / #395** Git 凭据文件一次 401 就被静默删行 | 无任何提交/小节覆盖；#395 已改判为 #399 的口径 | 中（安全） |
| **#378** `node_modules` 被当符号链接提交（指向自己） | 无提交；**今晚我又踩了一次**（`npm ci` 后 `git status` 显示 ` D node_modules`，必须手动不提交） | 小（一次 `git rm --cached` + `.gitignore` + 判据） |
| **#259** jail 只有项目根一个读边界 | 无提交；现状仍靠 shell 读 `~/AGENTS.md` / `~/.erix/ports.json`（#258 的告知面就是为此绕的） | 中（写边界不动，只加只读例外） |
| **#233** 防火墙 P1 零实现（FDE→宿主端口未收紧） | 无提交；deploy-contract §4.4/§7.1 已选定方案 | 大（安全，需设计确认） |

#### C. 产品决策阻塞（等拍，不是缺代码）

- **#348** 单次 run 无 token/成本上限（#236 第 3 条拆出）。
- **#346** 起跑前取消的消息留在会话里、下一个 run 当待办重做（取消语义）。
- **#331** `ERIX_SESSION_AUTO_TITLE` 死光纤：撤掉下发表 vs 接回 portal（#322 之后 `runner/` 零读取）。

#### D. 上游 / 版本阻塞（站内只能挂账）

- **#341** 引擎 0.26.0 只修**写侧**（`orchestrator.js` 锚定首片，点名 erix-agent #430）；**读侧 `parts.set` 仍恰好一处** ⇒ 存量链式行解不了 ⇒ 站内解链闸（`portal/src/transcript-fold.js` / `runner/lib/transcript-fold.js` + 哨兵）**必须留**。
- **#303** 两处「一代回退」挂账：触发条件已改成「旧 transcript 行归档时」，**不是**「下次升 minor」；`?? tr.duration` 不许提前删。

#### E. 陈旧 / 载体已转移

- **#274** SESSION HANDOFF 2026-10-13：已被后续 handoff 与 `AGENTS.md` 台账取代 ⇒ 可关（或改成一个「当前交接在哪」的指针）。
- **#163** GitLab 上游能力：已裁决搁置（待实例）⇒ 关或标 not planned。
- **#135** SSO/OIDC P2：阻塞于 IdP 事实（issuer/client 注册/group claim）⇒ 保持 open 但别当待办。
- **#227 / #270**：e2e 隔离第二阶段（1–3 项已做，剩「单 test 粒度」；#270 的 `POOLS.large` 参数化是并行隔离的前提）⇒ 合并成一张「e2e 并行化」单更清晰。
- **#231** 文件工具迁上游遗留：`SYSTEM_PROMPT` 已写 `edit`/`searchText`（§8.10）、`maskedPaths` 已注入（§8.9）⇒ 只剩三项确认项，需逐项核后再关。

### 刷新过的过期指针

- **版本**：本机现跑 **v0.1.30**（试用栈 `station.vc.cn-ai.vip` 仍 v0.1.5 且不可达）。伞域 `fde.erix.vip`，预览端口段 = 全局号池 `22000–29999`（§8.13）。
- **#236 的「未发版」口径过期**：其载荷（PR #347 `135ddf6`）已随 **v0.1.28** 发布，红色/中性两支都在发布物上重验过（`1ead0b1a…` 10 条分隔条里 3 条红带 `code=invalid_messages`，`ec8a77b3…` 5 条全中性且硬刷新后不变）。
- **#278 引用的 #236-1** 同样已发版（v0.1.28）。
- **测试基线**：根 `npm test` **1426 / 1422 通过 / 0 失败 / 4 跳过**、runner **323/323**、前端 **43 文件 / 782**（台账 `docs/ops/ci-release.md` §1）。
- **#350 已随 v0.1.30 发布**（`imageId=0602a027…`/`digest=e2103740…`；bundle `index-xHmHZy-g.js`；`runner/` 零实质改动 ⇒ 五台 FDE 故意未重建）。台账 `AGENTS.md` §8.50。
- **台账**：本批全过程在 `AGENTS.md` §8.48 / §8.49。⚠ **一条新坑**：主工作区里未提交的文档改动会被 worktree 化的子代理机制回退（本次丢了 ISSUES.md 的整段夜班表，AGENTS.md 因先提交而幸存）⇒ **文档台账改完就提交，别留窗口**。
