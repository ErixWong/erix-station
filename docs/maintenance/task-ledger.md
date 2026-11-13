# 工单台账（erix-station）

> **这里是一单一账的家**。`AGENTS.md` 随每次 agent run 全额注入，写进它 = 每次运行都重付一遍；
> 本文件不注入，随便写多长。261110 立此约定（起因见 `~/projects/docs/erix-station-agents-hotlayer-261110.md`）。

## 规矩

- **编号续用 `8.N`**，全局唯一、不重排、不复用：`AGENTS.md` 与全仓文档里已有的 **581 处 `§8.N`
  引用**（分布在 54 个文件）就是靠这个编号解析的，所以**编号不许动**。
- 新单在文件末尾追加，标题写法：`### 8.N <一句话结论>（issue #x / PR #y，YYYY-MM-DD）`。
- 内容自由（过程账、判据、变异读数、真机验收、遗留），但**别把结论性口径留在这里**：
  默认值、端口、pin、门禁现价这类「现在成立的事实」要落到 `docs/` 对应文档，台账里只留过程。
- `AGENTS.md` 里只改判据与决策，不改过程。写进 `AGENTS.md` 之前先问：这句话会不会改变
  一个没碰过这段代码的 agent 的下一步动作？不会就别写。

## 现状

- 存量 113 条 `### 8.N`（§8.1–§8.113）已随 §8.117 整体搬进本文件，编号一个没动；`AGENTS.md` §8 只留指针。
- **新账编号 = 本文件当前最大号 +1**。挑号前先 `grep -n '^### 8\.' docs/maintenance/task-ledger.md | tail -3`
  ——并行 session 会撞号（§8.116 顶部就是一次 `8.115` 撞车登记）。**本文不写死下一个号**。

## 台账

### 8.114 热层止血：一单一账改住本文件，pin 不再手抄（2026-11-10，本条即新约定第一单）

- `AGENTS.md`：§6 加「一单一账写本文件、别写进本页」；§8 标题里的 `当前 pin：**0.29.0**` 拿掉
  —— `package.json` 实测已是 `0.31.0`，那是同一个标题第三次漂移（前两次：停在 0.20.0、§8.65 修正），
  所以这次改机制而不是改数字：标题不带版本，正文写「以 `package.json` 现读为准」。
- `### 0.14.0 当前宿主契约` 改名 `0.14.0 宿主契约快照（已过时…）`：标题带「当前」而正文是 0.14.0
  的快照，读的人会把 8 个版本前的契约当现况。
- `.github/workflows/ci.yml`：步骤 ② 上面那条注释里挂着 **12,034 字节**的逐单沿革（整行 1 条），
  现改成 3 行指针——「现价」由 `docs/ops/ci-release.md` §1 单独持有（该节今天已写明自己是现价持有者，
  并点名三处台账要同值；三本账留一本）。ci.yml 32,719 → 12,454 字节（−62%）。
  ⚠ 订正：本条初稿写的「24,633」是凭印象的数，实测改前是 32,719（`wc -c` 对备份
  `/tmp/ci.yml.bak-261110`），已按实测更正。
- 验证：`python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` 通过，
  jobs 仍是 `gate` / `images`；改动全在注释与文档，`git diff --numstat` = 13 增 5 删（不含他人
  在飞的 `docs/README.md`）；根 `npm test` 复跑读数见本条末尾的追加行。

- 复跑（同日改动后）：根 `npm test` = **2136 / 2132 通过 / 0 失败 / 4 跳过**，与
  `docs/ops/ci-release.md` §1 的现价块同值（本单没动代码，这个读数只用于证明没弄坏东西）。

- 同日跟进（用户复核指出这两句都是废话）：
  - §8 那条「沿革（0.26.0→0.29.0、`0.27.0` 从未发布、§8.65 修过标题）」整条删。标题既然已经不写
    版本，就不需要在热层解释「为什么不写」；漂移史本条已记，`0.27.0` 从未发布这件事 §8.82 正文
    本来就有（`npm` 版本线 0.26.0 → 0.28.0 → 0.29.0）。
  - `### 0.14.0 宿主契约快照` 后面那句「（已过时：现契约以 erix-llm-kit 的 host-consumer-contract
    为准）」也删。标题写着 0.14.0 而 pin 是 0.31.0，「已过时」不携带新信息；那个指向 §8 引言第一条
    三行之前就有，是重复指针。
  - `AGENTS.md` 675,809 → **675,242 字节**（本条两次删减合计 −567；另抹掉一行多余空行）。复跑根 `npm test` =
    2132 通过 / 0 失败 / 4 跳过（项数不变，本单零代码改动）。

### 8.116 热层清退第二批：叙述性文字搬出 `AGENTS.md`（用户口径「正确的废话 / 无信息增量」）

> **编号撞车登记（本条原本写的是 `8.115`）**：与 §8.115《管理台 MFA 保存入口收敛》**同号撞车**——那一条由
> 并行 session 在 `d305e74`（分支 `feat-261111-01`）写进同一个文件，两边各自挑了同一个下一号。**本条改号为
> `8.116`**（无人引用，改它不伤坐标；MFA 那条保持 `8.115` 不动）。这正是新加的 `npm run check:agents-hotlayer`
> 里 `ledger-integrity` 一格要拦的东西——它第一次真跑就抓到了这次撞号。
> **日期订正**：本条与 §8.114 里那些 `261110` 戳**早了一天**：`date` 现查今天是 **2026-11-11 星期三**，
> 戳是从上一轮会话沿用的。已落文件的戳不回改（改了反而与当时的 commit 对不上），此后一律现查。

**判据**（沿用用户 261104 定的那条）：一句话会不会改变「此刻没碰这块代码的 agent」的下一步动作。会 ⇒
留；只是解释「为什么有这条规则」、或描述某个早已变化的机器态 ⇒ 搬走或删。逐条复核 §4 / §6 / §7 的结果：

| 位置 | 原判 | 处置 | 事实去哪了 |
|---|---|---|---|
| §4 派工环境约定 | 开头挂「（2026-10-08 实证）」 | 留规则，删日期标签 | 结论本身在热层，日期无消费方 |
| §4 前端单条用例 | 「一晚上连续两次踩同一坑」「主 agent 900s 被 timeout 杀、worker 又占满 300s」 | 留口径（`npm test -- <文件>` + `timeout 240`，禁 `npx vitest`/`npx vue-tsc`），删事故现场 | 本条 |
| §4 `node_modules` 两条 ⚠ + 根因块 | 一条讲「会被掏空」，下一条开头就说**根因已由 #396 消除**——热层同时供着症状和「症状已死」 | 合成一条：每 worktree 自备 + 验收前重装复跑 + `test/repo-hygiene.test.js` 判据；机制细节留一句（mode 120000 / `.gitignore` 带斜杠只匹配目录） | 实测数字（2026-10-27 一次 `npm install --omit=dev` 把共享树清空、另一 worktree 折叠族整片红；main 要 0.26.0 而共享树是 0.25.0；1022 → 510 + 34 失败）留本条 |
| §4 判绿看退出码 | 「2026-10-14 主 agent 自己犯的错，代价是一次返工重打 tag」+ 当晚连跑 3 次的过程 + 「有 worker 归因成 NODE_ENV，主 agent 实测否证」 | 留判据（vitest 有未捕获拒绝仍打印全绿但 rc=1 ⇒ 只看退出码）与 `onMounted` 成因 | 否证史与下一条合并留本条 |
| §4 `NODE_ENV=production` | 「亲手三组对照，**推翻此前 7 次归因**」+ 点名 §8.63 / §8.82 / §8.88 / §8.100 / §8.103 写错了成因 + 最小复现细节 | 留机制（`emitted()` 靠 devtools hook、生产构建不发）与三条口径 | 「观察没错、归因错（主 agent shell 里 `NODE_ENV` 是空的）」这条横切更正留本条：那五条 §8 账里写的「worker 报基线红、主 agent 空载恒绿」成因全部作废，观察保留 |
| §4 GitHub 连不上 | 一整段机器态叙述：DNS 把域名钉到哪两个 IP、曾自建 `127.0.0.1:18443` CONNECT 代理又删掉、「本机已按域名注入 `http.https://github.com/.proxy`」 | **改成先现验**：`git config --global --get-regexp '^http\.'` + 显式代理命令 + `gh` 不读 git 配置 + 别设全局 env 代理 + 别改 `/etc/hosts` | 见下方「GitHub 代理现验」 |
| §6 发布前置 | 手抄「现状 tag `v0.1.1` vs `package.json` `0.1.0` 就会被拦」 | 改成现验命令；`docs/ops/ci-release.md` §7 的同一处旧账一并改 | 见下方「版本对账」 |
| §6.1 评审史 | 「（2026-09-23 起简化：取消双模型评审门禁，省 premium 额度）」+「PR #16–#20 曾抓出 ~25 个实质问题（认证绕过、跨 FDE 删除、forward-auth 放行、事件重试风暴）」+「PR #20 实例：F4 修复曾劫持崩溃恢复路径」 | 全删出热层，只留 5 条评审动作 | 本条：那 ~25 个问题的类别与「做法存档于 git 历史 / issue #13」在此留档，需要恢复门禁时有据 |
| §7.1 D8 | 热层里供着「理由 + 实施 + 参照系 pi」（而 §7 标题自己写着「详见设计文档附录 A」） | 热层只留新语义与边界；理由与实证搬进**它声称的家** | `docs/design/fde-platform.md` 附录 A.1（工位容器、俄罗斯方块手动抢救、`hello.sh` 报 worktree 路径、`capacity=1` ⇒ 隔离收益拿不到、`f402a11` 产物捕获、#81 P2.5） |
| §7.2 D9 | 「理由」的修辞 + 整条「告知面先行」（是**交付状态**叙述，灯与前端组件早已上线） | 留渲染规则（同罪 / 进度不是警报 / ⚪ 不得当绿）与实现红线 | 设计文档附录 A.2：噪音论证、告知面先行与 §8.53、以及**现验过的实现坐标** |

**GitHub 代理现验（261110，本机）**：`git config --global --get-regexp '^http\.'` 只有
`http.https://git.erix.vip/.proxy`（空值），**热层原文声称的 `http.https://github.com/.proxy =
http://10.41.24.146:18099` 在本机根本不存在**；实测 `10.41.24.146:18099` TCP 连不上（curl rc=124），
`172.20.0.35:19001`（全局冷层 `~/projects/docs/git-github-ops.md` §5 那条）`api.github.com` 200 / 1.1s。
当晚推 erix-station：直连 `github.com` `direct=000` / 20s 超时，显式带 `172.20.0.35:19001` 推送成功。
⇒ 原文那两条地址与「已注入」的断言一起降级为「现验后再用」，不再当事实。
> **裁定（261111，用户）**：`10.41.24.146:18099` **已经不用了**，本机唯一入口是 `172.20.0.35:19001`；
> **不去配** git 全局配置（保持「需要时显式 `-c`」，与全局冷层 `git-github-ops.md` §5 开头那条决定一致），
> 裁定与实测量已写进 `pi-tools` 冷层（commit `5c1bee3`）。遗留只是历史文字：本节与 §8.115 里那两个
> 地址作为「曾经存在过的错误断言」留档，不当事实用。

**版本对账（261110）**：最新 tag `v0.1.66`、`package.json` = `0.1.66` ⇒ 热层与 `ci-release.md` §7 的
「现状会被拦住，属预期」双双失效：两处都改成现验写法（`git tag --sort=-creatordate | head -1` 与
`node -p "require('./package.json').version"`），§7 标题里的「首次」也去掉（这不再是首次）。

**顺带查出的坐标撞车（未重排，只登记）**：`docs/design/fde-platform.md` 附录 A 的 `D9` = 认证放边缘，
而 `AGENTS.md` §7 与 portal 代码的 `D9` = #359 收工灯；全仓 `*.md` 里 `D8` 30 处、`D9` 24 处。
两边都不动编号，改为在附录 A.3 写明「引用 `D9` 必须同时带 issue 号」。

**净效果（实测，不是估算）**：`AGENTS.md` 675,242 → **671,151 字节**（−4,091）。热层口径按「§8 标题之前」
量：**22,197 → 18,106 字节**（−4,091，本批删减全部落在 §1–§7）。`docs/design/fde-platform.md`
94,888 → 98,538、本台账 3,121 → 约 9.7 KB。**搬走 ≠ 删掉**：真正被删的只有日期标签、修辞与已失效的
机器态断言（`http.https://github.com/.proxy` 「已注入」、`v0.1.1` vs `0.1.0`）。
`§8.N` 引用面 581 → 586：只增加（搬走的段落在新家继续带指针），**没有任何一条被改号或删掉**
（`AGENTS.md` 内被引用的编号集合与改前逐条相同）。

### 8.115 管理台 MFA 保存入口收敛 + 探活信双语（PR #492，2026-11-11，v0.1.67）

- **删掉冗余的「保存邮件码设置」按钮**（`saveMailOtp()` / `data-test="save-mail-otp"`）：它的载荷
  `{mail_otp_enabled}` **严格是** `save-mfa-settings` 的 `mfaChanges`（exact-keys 两字段 diff）的子集，
  「没邮箱不许开」那条守卫 `saveMfaSettings` 也已有两处（`:disabled` 的 `mfaMailNeedsEmail` + 函数体第二道闸）
  ⇒ 零能力损失。随之退场：`mailOtpBusy` / `mailOtpError` / `mailOtpMessage` 三个 ref 与两条反馈行、i18n
  `admin.fde.saveMailOtp` / `admin.fde.mailOtpSaved`（两边成对删）。
- **探活信改双语**（`mail-settings.js#buildTestMessage`）：主题、正文的「这是测试信」「这不是验证码」、
  时间戳行**各写两种语言**；仍纯函数、仍不含验证码。
- **一条原先无覆盖的判据被补上**：「勾上邮件码但账号没邮箱 ⇒ 不许保存」的两道闸各自钉住。
  关键取证：jsdom 里禁用按钮的 `element.click()` / VTU `trigger('click')` **根本不派发** ⇒ 只点按钮
  永远验不到函数体那道闸，必须**把 `disabled` 摘掉再硬点**。
- **一处假绿风险被消灭**：`AdminUsersView.spec.ts` 的 `MAIL_OTP_BLOCK` 结束锚点原来是
  `indexOf('data-test="save-mail-otp"')` —— 按钮删掉后 `indexOf` 返回 `-1`，`slice(start, -1)`
  **不报错也不切空**，而是静默胖到文件末尾。改成仍然存在的 `id="edit-panel-llm"`，并补两条
  `not.toContain` 把「没越界」钉住（变异 B 证明它有牙）。
- 门禁：根 **2136 / 2132 / 0 失败 / 4 跳过**、前端 **63 文件 / 1316**、`typecheck` rc=0、后端单文件 14/14。
- 主 agent 亲跑 4 条变异（与 worker 的 4 条不重叠）：i18n 文案改空串 / 结束锚点改回已删的 id /
  勾选框 `:disabled` 加 `totp_login_enabled` 条件 / 主题去掉中文 —— 各红在具名用例。
  ⚠ 第一条**第一次跑错文件**（跑了 `AdminUsersView.spec.ts`，而新用例在 `AdminView.spec.ts`）⇒ 6/6 绿，
  差点误判成覆盖缺口；换对文件后红在具名用例。**「变异不红」先核对「跑的是不是那条用例所在的文件」。**
- 台账同步：`AGENTS.md` §8.112 / §8.113 里那两句「还留着该按钮」「测试发信仍是中文单语」已按本单改掉
  （热层不保留已失效的现状断言）。
- **发版与部署（v0.1.67）**：PR #492 质量门禁绿 → merge `c9017a2` → 版本 bump `bd227e2`（六文件 9 增 9 删）
  → main CI `42942166678` 两个 job 全绿（质量门禁 + 三镜像构建校验）→ tag `v0.1.67` → release `42942776168`
  → 清单 `imageId` 与部署机 `docker image inspect .Id` **逐个一致**（portal `98a6fbcd…` / digest `69b8848b…`；
  proxy `8966720e…` / digest `1b79e28a…`）→ `deploy/.env` 形态① pin **只两个**
  （`git diff --name-only v0.1.66..v0.1.67 -- runner/` 去掉 package 文件后为空 ⇒ `FDE_IMAGE` 故意留在 v0.1.66 摘要、
  **5 台 FDE 容器没重建**；备份 `/tmp/deploy.env.bak-0167`）→ `up -d --no-build station-portal`（连带重建
  `station-docker-proxy`）⇒ portal 实跑 `98a6fbcd…`、`0.1.67`、healthy、用户面 `healthz=200`、管理台 `9443/api/site` 200。
- **发布物取证**：容器内 `buildTestMessage` 实跑输出双语（主题 + 两件事 + 时间戳行各两份）；
  前端 bundle `index-DR-moTu5.js` 里 `save-mail-otp` / `saveMailOtp` / `mailOtpSaved` **各 0 命中**、
  `save-mfa-settings` 1 命中。
- ⚠ **浏览器面本轮未取证（如实记）**：本机可用的 playwright MCP 实例解析不了 `*.fde.erix.vip`
  （`ERR_NAME_NOT_RESOLVED`，项目级 `playwright` server 被项目审批挡住），所以「二次验证 tab 里那个按钮真的没了」
  的证据是「部署产物字节 + 组件层用例」，不是 DOM 断言。要在浏览器上补验，得先让 playwright 实例带
  `--host-resolver-rules=MAP * 100.100.0.3`。

---

<!-- 以下 652,581 字节是 261110 从 AGENTS.md §8 原文整体搬入：逐字未改，编号即坐标。《0.14.0 宿主契约快照》也在其中（历史快照，现契约看上游）。-->

### 0.14.0 宿主契约快照

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

**发版与部署（已过期补记，2026-10-15 接班核对）**：本单随 **v0.1.10** 发布（`git tag --contains 450e197` 首个 tag = v0.1.10）。**真机复验已在 v0.1.10 完成并据此关掉 #292**（记录在 issue #292 最后一条评论，本文件不重抄）：`docker pause fde-eric` 造租约过期的真崩形状 ⇒ `attempt-killed:1` 与 `:2` **各恰一条**、payload 无 `silent_ms` 键、界面渲染「第 N/3 次尝试被终止（worker 非预期退出）」且**硬刷新后仍在**、zh/en 双语都**无「（静默 …）」后缀**；冻结→落库实测 ≈73s。本轮（v0.1.14 接班）**没重跑 pause 演练**——上面是引用已落地的验收记录，不是我今天亲手跑出来的。

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

**发版与部署（已过期补记，2026-10-15 接班亲手验）**：本单随 **v0.1.10** 发布（`git tag --contains feec932` 首个 tag = v0.1.10）；**#285 已据此关闭**。原判据「打开 #285 R-1 那条会话」在 dev 栈上**执行不了**——那条会话属 `acc019`，**admin 打开会被踢回 `#/`**（属主校验，不是 bug）。接班在 **v0.1.14** 上另走了一次等价真机：以 `eric` 登录 `station.fde.erix.vip:8090`，会话 `457fe11a…` / run `b87f3601…`（`judge_done`）让助手回一行**裸 URL** ⇒ DOM 里 `a[href="http://acc019-p-22061.fde.erix.vip:8090"]` **真的成了可点链接**（整屏 `a[href]` 计数恰为 1）。**反面同屏可见**：用户消息里同一条裸 URL **没**成链（`addMessage` 的 `isMd = role==='assistant' && !synthetic` 是既有口径，不是漏做）——顺带这也是 v0.1.14 部署后第一跑端到端 run（runner 未变 ⇒ 容器仍是 v0.1.13 镜像，不影响）。

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

**接班补充（同一条纪律的第二次发作，这次差点丢交付物）**：worker 补出来的报告落在**沙箱的 `.work-orders/`**（未跟踪目录），主树看不到、`git status` 也看不见——上一个 session 在「打完 tag 之前」做上下文压缩时崩掉，接班第一动作若是 `rm -rf` 沙箱（§2.7 的收尾动作），这 26 KB 报告就随沙箱一起没了。**口径：删沙箱前先把 `.work-orders/*` 归档到 `~/worker-reports-<日期>/`**（本单已归档 `~/worker-reports-261015/feat-261015-03-296-report.md`）；并且**沙箱三个 commit 是否真进 main，用 `git patch-id --stable` 逐条比**（cherry-pick 后 SHA 必然不同，`git log main..HEAD` 会一律显示「未合并」，别拿它当丢失证据）。

**发版与部署（已完成，2026-10-15 接班收尾）**：PR #305 合并（`341fae0`）→ main CI `38723692966` 绿（含镜像构建校验，这是打 tag 的前置）→ tag `v0.1.14`（`04ced19`）→ release run `38731694512` success → 清单 `images-digest` 与部署机 `docker pull` 后 `docker image inspect` **逐个一致**：portal `imageId=e64e2c50…` / `digest=8f4b8d30…`、proxy `imageId=0519b5ac…` / `digest=b8a18c9e…` → `deploy/.env` 形态① pin（备份 `/tmp/deploy.env.bak-0114`）→ `docker compose -p station --profile litellm up -d --no-build` ⇒ portal 实跑 `e64e2c50…`、proxy `0519b5ac…`，两者 healthy。
⚠ **本版只 pin 两个镜像**：`git diff --name-only 5b80dfa..341fae0 | grep -c '^runner/'` = **0** ⇒ `FDE_IMAGE` **故意仍 pin 在 v0.1.13 摘要**（`dbea0545…` = imageId `d80973f3…`，与七台在跑的容器一致），**没重建 FDE 容器**。别把它当漏做。

**真机验收五条全过**（dev 栈，主 agent 亲手；请求从 host 网络容器 `erix_station_playwright` 发出——容器内 node 没有 system DNS（`--host-resolver-rules` 只管 chromium），所以走 `127.0.0.1:8090` + 显式 `Host: station.fde.erix.vip:8090`，**仍然经 Traefik**，不变式 2 没绕过）。标本 = 模型 `1a770ab8…`（调用名 `deepseek-flash`，**只有 fde-eric 一个绑定引用它** ⇒ 影响面最小）：
1. **判据①** `PATCH {call_name:"acc296-probe"}` ⇒ 200：LiteLLM deployment **顶层 `model_name` 变**、`model_info.display_name` **一字未动**、`litellm_params.model` 不变、目录仍 6 条。
2. **判据②** `fde_llm_bindings.main_model_name` 回写成新名（`main_model_id` 不变），portal 日志 `[llm] model rename reconcile { status: 'reconciled' }`。
3. **判据③** `/key/info` 的 `fde-eric` 白名单 = `["deepseek-flash","acc296-probe"]` —— **新旧并集**（实测印证 §8.25 那条：LiteLLM 改名时自己把 key 重写成只剩新名，门户这一手把旧名兜了回来）。
4. **判据④** 改成别人正在用的 `deepseek-v4-pro` ⇒ `409 model_name_conflict`、`retryable:false`、`details={field:'call_name',call_name,conflicting_model_id:'abfd93f5…'}`、文案「调用名「deepseek-v4-pro」已被模型 abfd93f5-… 占用」；**且网关零部分写入**（顶层名仍是上一个探针值 ⇒ 拦在 PATCH 之前）。
5. **判据⑤** 只改展示名（干净窗口 `docker logs --since <ts>`）⇒ 该窗口 **0 条** reconcile/rename 日志、顶层 `model_name` 一字未动、binding 与白名单未动。

**UI 侧也走了一次真浏览器**（playwright :8935 + vision 看图，截图 `/docker/erix_station_playwright/v0114-296-ui-confirm.png`）：列表两列并存（表头 `Call name (what FDE requests actually send)` / `Display name`），编辑弹窗两个字段各自带口径说明；改调用名点 Save ⇒ 出 `Confirm call-name change` 确认框（文案点名旧名→新名 + 说明旧名从路由消失、白名单保留），**确认前网络里 PATCH 数 = 0**（`browser_network_requests` 只有 login + providers），点 Rename 才发出那条 PATCH 200 并刷新成新名。**「确认前零请求」在部署后的真机上成立，不只是单测里。**

**探针复原与残渣清理（都做了，别信「应该没事」）**：调用名与展示名都改回基线 ⇒ `/model/info` 与基线**逐行 IDENTICAL**（6 条）、`fde_llm_bindings` 里 `acc296%` 计数 **0**。另手工清了一类**门户自己不会清**的残渣：并集对账只增不减（§8.25 边界），两次改名把 `acc296-probe` / `acc296-ui` 留在了 eric 的虚拟 key 白名单里 ⇒ `/key/update` 收回到 `["deepseek-flash"]`（这是探针造成的，不是历史名，留着会污染下一次人工核对）。

**一条可读性观察（不是缺陷）**：409 的文案用**冲突方的 model id** 点名，不是它的调用名。契约（§1.2 `details.conflicting_model_id`）就是这么定的，但管理员看到的是 UUID；要不要换成人话名字属产品判断，未动。

### 8.30 中止/失败 run 的「部分正文」不再空白：历史端点响应期合成 `partial_output`（issue #300，2026-10-15）

**缺陷本体**：被停止 / 失败的 run **正文区一片空白**（工具卡片在、正文没）。根因：`runner/worker.js` 的 catch 固定 `final_text: ''` ⇒ 该 run 在 `messages` 里**零助手锚点**，而对话正文本来就从锚点渲染。标本：run `72e2577d…` / 会话 `1ead0b1a…`（`termination={reason:"aborted", partial:true, usage, rounds:24}`、助手锚点数 = 0）。

**为什么不动 `runner/`**（这条决定了代价）：原方案「消费 `err.finalText`」要改 runner ⇒ 重建 FDE 镜像 + 一次产品口径变更（半截话进不进模型上文）。但 **`assistant_delta` 本来就逐 chunk 落 `run_events`**（`worker.js:438` → U3，全库 5.4 万条），所以在**只读重建端点**里聚合回来就够了。dev 实测规模：134 条 run 里**只有 4 条**需要它（`failed` 1 / `aborted` 3），内容 37–133 字符 ⇒ **不是刚需，但空白是硬的**。**零 DDL、零依赖、不动 runner、不动 pin、`docs/data/schema.sql` 一字节未改。**

**契约（三条同时成立才出现，一条 run 至多一条）**：① 该 run 出现在本次响应窗口里；② **`runs.status IN ('finished','failed')` 且零助手锚点**（锚点算 `role='assistant'` 的**任意**行，含 `synthetic=true`）；③ 聚合出**非空**文本。字段与既有事件项**同形**（`seq` = 该 run 最后一条 delta 的 seq，**不是新分配**；`payload = {text, chunks, truncated}`）。完整口径在 `docs/api/portal.md` **§4.4a-1**。

**三条最容易做错的地方（都已钉住）**：
- **「有锚点绝不能再渲染一遍」**是头号坑（`judge_done`/`max_rounds_cap` 那 103 条全在这一侧；后者**本来就有正文**，「失败类一律空白」是误解）。
- **终态判定不能省**：工单原文只说「无锚点」，但那样**正在跑的 run** 刷新一下就被标成「已中止」⇒ 那是新造的误导，所以判据必须带 `status`（`queued`/`running`/`cancelling` 三态各钉一条用例）。
- **不落库、不进 SSE、不进两个前端集合**。`partial_output` 只在响应期合成 ⇒ 前端 `EVENT_TYPES`（实时监听）与 `HISTORY_REPLAY_TYPES`（回放）**都不加**，`assistant_delta` 也**不得**进 `HISTORY_EVENT_TYPES`（否则同一段正文来两遍）。前端的落点是 `StreamEntry` 新 `kind:'partial'`，在 `openSession` 归并循环里**于 `es.replayEvent` 之前**分流（幂等靠 `id=partial:<run_id>` 走 `renderedIds`），渲染成**中性助手气泡**（复用 `.msg assistant .md` + 一条墨色左竖线；**不进红色 `.syserr`**：半截正文不是错误）。这是 §8.8「同一事件两种可见性」那个坑的**反方向**——那里是「漏加集合 ⇒ 刷新后消失」，这里是「多加集合 ⇒ 实时一条 + 历史一条」。
- **成本红线**：窗口 `run_id` 去重后无 run ⇒ **整段跳过、一条额外查询都不发**；有 run 但全有锚点 ⇒ **聚合那条一条都不发**。聚合只对候选发、走既有 `run_events_run_idx (run_id, seq)`（**不新增索引**）。工单里我那句「全有锚点 ⇒ 三条都不发」与判定顺序自相矛盾（想知道有没有锚点就必须查库），worker 按顺序实现并**拆成两条字面判据**（窗口无 run ⇒ 三条都不发 / 全有锚点 ⇒ 聚合那条不发）——**这裁决成立，已采纳**。

**测试**：新文件 `portal/test/session-partial-output.test.js` **+17**（自带 `PartialOutputPool`，按 SQL 文本裁决状态过滤 / `EXISTS` / `ANY` / `ORDER BY`，并记 `sqlLog` 钉成本）；前端 **+17**（`workbench.spec` +10、`StreamPanel.spec` +4、`useEventStream.spec` +2、`localeParity.spec` +1）。基线：根 **1187 → 1204**（1200 通过 / 0 失败 / 4 跳过）、runner **286** 不变、前端 **33 文件 / 552 → 569**，台账三处已同步。

**主 agent 亲跑变异（不复用 worker 的 8 条）**：① 把「窗口无 run ⇒ 早退」挪到候选查询**之后** ⇒ **恰 1 条具名红**（成本红线是被钉住的）；② store 分流条件改永假 ⇒ **5 条具名红**；③ `truncated` 由 `=== true` 改 `!= null` ⇒ **恰 1 条红**。另我自己补了一条**探覆盖面的变异**：把合成项从「按 seq 归并」改成「追加到末尾」⇒ **17 条全绿**——先 `git diff` 证明不是空操作，再定性：**后端归并顺序不是契约面**（前端 `openSession` 本来按 `seq` 重排），真正的归并位判据在 ② 那条前端用例上。

**已知边界（都是刻意口径，别当 bug 修）**：
- **刚停止那一刻仍看不到**：合成项只在 `GET /events/history` 里，而该响应只在 `openSession`（打开/刷新/重进会话）时拉；终态后的 `refreshSession` 不重拉 history ⇒ **要刷新一次才出现**（已登记 [#306](https://github.com/ErixWong/erix-station/issues/306)；**真机实测坐实**：点停止前/后 4s `.msg.partial` 都仍是1 条（只有历史那条），刷新后变 2 条）。
- **合成项只出现在「该 run 真的落在本次窗口里」的那一页**：真机一个会话有 **14.4 万条事件**，标本 run 在 seq 30785–39411 ⇒ 不翻到那一页就看不到（判据①的必然结果，**不是 bug**；翻到即出现）。
- **`HISTORY_REPLAY_TYPES` 这条判据目前不承重**：把 `partial_output` 加进去无测试会红（`replayEvent` 无该分支 ⇒ 落 `default` 中性忽略，「加了也看不见」）。**不加新导出面去钉一个没有后果的性质**；防线在 store 侧不喂（变异 ② 恰 5 红）。
- 聚合把候选 run 的全部 delta 拉回 JS 再截 2000 字（SQL 侧 `LIMIT` 更省，但会改 `chunks` 语义 = 一次口径决定）；`chunks` = **实际拼进正文的片段数**（脏片段不计，文档已写死这句）；合成项的 `seq` 可能落在分页窗口外（whole-run 聚合的必然结果）。
- ⚠ **标签是响应式回溯翻译的**（真机实测，**推翻我工单里写的「取词即快照」**）：模板直接 `t('stream.partialOutput.label')` ⇒ 不刷新页面把界面从 English 切到中文，**已渲染的那条气泡标签当场变成「已中止 · 部分输出」**。快照口径只适用于 store 侧写进 entry 字段的文本，别拿它当这个元素的现状。

**不在本单**：SSE 通路合成、把 `assistant_delta` 进下发白名单、`reasoning_delta` 聚合、`termination.reason` 参与判据（现在只看 `status`）、单 run 极多片时的熔断上限。

**发版与部署（已完成）**：PR **#307** 合并（`ddeead8`，PR CI `38745692367` 绿）→ main CI `38747249886` 绿（含**镜像构建校验**，这是打 tag 的前置）→ tag `v0.1.15` → release run `38747759997` success → 清单 `images-digest` 与部署机 `docker pull` 后 `docker image inspect` **逐个一致**：portal `imageId=edf15e52…` / `digest=3721b8cc…`、proxy `imageId=777d7789…` / `digest=1904b7eb…` → `deploy/.env` 形态① pin（备份 `/tmp/deploy.env.bak-0115`）→ `docker compose -p station --profile litellm up -d --no-build` ⇒ portal 实跑 `edf15e52…`、proxy 实跑 `777d7789…`，两者 healthy，经 Traefik `/healthz` 200。
⚠ **本版只 pin 两个镜像**：本版 `runner/` 下**只有版本号变动**（`runner/package.json` + lockfile；`git diff --name-only … | grep -c '^runner/.*\.js$'` = **0**）⇒ `FDE_IMAGE` **故意仍 pin 在 v0.1.13 摘要**、**没重建 FDE 容器**（别当漏做；所说「不动 runner」指**不动 runner 代码**）。

**真机验收全过（dev，v0.1.15，主 agent 亲手）**：
- **API 面四类标本**（从 host 网络容器 `erix_station_playwright` 发，**带 `Origin`**）：`aborted` 25 字（会话 `457fe11a…`/run `9cd252a6…`）与 `aborted` 133 字（`f7eee43c…`/`f3b715a1…`）各**恰一条**，`chunks`/`len` 与库里 `assistant_delta` **逐字相等**（13/25、31/133）；`failed` 37 字（`e67eaef5…`/`f5b6df8e…`）在**深窗**（`before=39412&limit=500`）里拿到恰一条，`chunks=22`/`len=37` 与库同；**工具中被停的那条**（`72e2577d…`：669 条 `reasoning_delta`、**0 条 `assistant_delta`**）**零合成项**——判据③在真机上成立（⚠ **我原先拿它当标本是选错了**：它在工具调用里被停，根本没吐正文，而我先在 §8.30 写的判据就拿它写了「应看到气泡」）。`POST /api/auth/login` **不带 `Origin` 会 400**（#234 同源门），脚本补 `Origin` 后 200。
- **不重复 / 不占额度**：`assistant_delta` 在四个会话响应里出现次数全为 **0**（不会同一段正文来两遍）；`limit=500` 的深窗返回 **501** 条 = **500 真实事件 + 1 合成项**（「合成项不占 `limit`」在真数据上成立）；含合成项在内 `seq` 全序升序。
- **浏览器面**：`.msg.partial` **恰好 1 条**，类名 `msg assistant md partial`、**不含 `syserr`**；computed style 实测 `border-left: 3px solid rgba(0,0,0,.18)`（普通助手消息 `0px`）⇒ **中性墨色左竖线**是这个面的唯一视觉标识，未引入新颜色；英/中双语标签逐字对上；正文走助手 markdown；硬刷新后仍在；整页无 `[object Object]`/`NaN`（`undefined` 只出现在一条旧助手消息的 `<code>` 块里，已逐节点定位＝**内容不是脏值**）。
- **负例与截断都在真机上拿到**：同会话里一条 `judge_done` 长文 run（7400+ 字、**有锚点**）**没多出一条**（`partialCount` 保持 1）；再发一条 12000 字请求、跑到 **7418 字**时点「停止」⇒ 停前/停后 `partialCount` 都是 1（**#306 边界坐实**），**刷新后变 2 条**，新那条 `truncated=true` 带「输出在停止前未生成完全（已截断）」、正文钉在 2000 字。截图 `/docker/erix_station_playwright/v0115-300-partial-paizhao.png`（vision 读图复核：标签中性灰、无红色告警、无脏值；截断提示在气泡尾部、该屏折叠线以下所以图上看不到，DOM 断言已钉）。
- **dev 残渣**：会话 `457fe11a…` 多了两条我发的探针消息（一篇 3000 字已完成长文 + 一篇停在 7418 字的长文），**故意不清**：它们同时是「有锚点不重复」与「截断」两块面的现成回放标本。

**#300 已关闭。**

### 8.31 模型元数据打通：压缩开关不再是隐含的（issue #309，切片 0/1/1.5/2+2b，2026-10-19，随 **v0.1.16** 发布）

**缺陷本体（全部实跑复现，不是推论）**：erix-agent 0.20.0 的压缩开关是**隐含**的 —— `runToolLoop` 必须**同时**拿到 `modelMetadata.contextWindowTokens` 与 `maxOutputTokens` 才推得出 `budgetTokens`；缺任一 ⇒ `overBudget` 恒 false ⇒ **压缩与单轮聚合输出预算一起关闭** ⇒ 长会话无压缩涨到 `ContextWindowExceededError`，run `failed`。而且是**静默**的：`model_metadata_missing` 那个一次性告警被 `budgetsKnown` 短路（`orchestrator.js:1272`），元数据全缺时反而不发（事故标本：92 轮 `compaction=0`、零告警）。本站两个断点：`runner/worker.js` 全文 `modelMetadata` / `contextWindowTokens` / `maxOutputTokens` **各 0 命中**；`runner/lib/llm-models.js` 的 `parseHeartbeatModels()` 只拷 `{model,type}` ⇒ 心跳新字段在这一层被**静默丢掉**。

**引擎算术（已写死在多处，别再推）**：`budget = ctx − maxOut − max(2000, ⌈10%·ctx⌉)`（`src/compact/budget.js:23-25`，调用点 `orchestrator.js:1141-1148` **无 try/catch**）⇒ `budget ≤ 0` 抛 `KitError invalid_budget`（`retryable:false`，实测文案 `Computed context budget must be positive (got -71)`）⇒ **每个 run 第 1 轮之前就死**。所以「填个更大的输出上限」不是旋钮，是能把自己锁死的闸。

**四个切片**（决策者定稿：1/4 上限 + 上游真值为源 + 非法值按 1/4 兜底 + **显式发 `max_tokens`** + **命名不许发散**）

- **切片 0（数据，零代码）**：dev 6 条 deployment 的 `model_info.max_output_tokens` 与 `litellm_params.max_tokens` 都设 32768（各自 1/4 内）。**另一台服务器仍欠这一步**（那台 `litellm_params.max_tokens=131072` 是事故链另一半：`170393+131072 > 262144`）。
  ⚠ **2026-11-09 复核：这条是运维账，不是本机待办**——那台部署在本仓**没有任何标识**（全仓 grep 只有「另一台」这类泛指，无主机名/IP/URL；`131072` 只存在于本文件这两句散文里），唯一实物证据是当初贴进会话的失败样本（LiteLLM 请求 id 前缀 `20261016`）。判「是不是本机」用**模型目录名**而不是数字：本机 dev 网关数据面 6 条（`kimi-for-coding` / `erix-deepseek-flash` / `glm-5.3-flash-awq` / `deepseek-v4-pro` / `k3` / `deepseek-flash`）**没有**事故那个 `qwen3.8-flash-next`，且 6 条 `max_output_tokens` 全为 32768、131072 命中 0 ⇒ 确为另一台。本仓对那台**没有远程下发 / 对账探针 / 版本闸**，它既不升级也不改数据，仓库侧无从影响 ⇒ 别再当本机待办引。
- **切片 1（PR #311）**：门户 `max_output_tokens` 字段 + 硬上限 `≤ floor(context_window/4)` + `model_info`/`litellm_params.max_tokens` **绑死双写** + 心跳 `models.main` 两键（非 null 才带）。
- **切片 1.5（PR #312）**：读侧**四级回退** `model_info.max_output_tokens ?? litellm_params.max_tokens ?? floor(正数 ctx/4) ?? null` ⇒ **缺元数据不再等于关压缩**（唯一还关着的是「连 `context_window` 都没配」，那时上游一次性告警就是它的告警）。**1/4 既是手填上限也是回退值** ⇒ 平台永远不会造出被自己校验拒的数（有专测）。决策者**否决**「区分配置值 vs 平台假定值」的字段拆分（原话：有个数字就行）⇒ 没有 `effective_`/`source`。命名统一到 `max_output_tokens`（前端拆掉 `Budget` 拼写，legacy 字段回 `colMaxTokens`），`portal.md` §4.9 加**一个数跨六层的别名对照表**。
- **切片 2+2b（PR #313）**：`parseHeartbeatModels` 收两键（**只收正整数**，非法形态**整键不写**而非置 `undefined` ⇒ 无元数据时与改前**逐字节相同**）+ 纯函数 `resolveModelMetadata(models, {computeBudget})` 做钳制（判据必须能在纯函数层单测）+ worker **唯一一处**映射（`#309:engine-model-params` 标记包住）成 `modelMetadata.{contextWindowTokens,maxOutputTokens}` 与**显式 `maxTokens`（同一个数）**。

**为什么必须显式发 `max_tokens`**：引擎只保证 `prompt ≤ budget`，安全条件是**实际输出上限 ≤ 假定值**。ctx=262144 / 假定 65536 ⇒ budget 170393；显式 65536 ⇒ 235929 正好卡住窗口；留给网关注入（事故那台 131072）⇒ 301465 **照样撞窗**。

**1/4 钳制保不住的那一支（我审出来、2b 才堵）**：引擎真正的死判据是上面那条公式，**小窗口钳完仍然非正**（`ctx=1001→250→−1249`、`2000→500→−500`、`2666→666→0`，`2667` 才活）⇒ 管理员把 `context_window` 误填成 `2048` 这类笔误会让你整个 FDE **每次 run 启动即死**。堵法**不复制上游公式**：调**包根导出的** `computeBudget({contextWindowTokens, maxOutputTokens})`（⚠ **入参是一个对象**，不是两个位置参数），**抛 ⇒ 整对不传**（压缩关掉、run 照活），且**优先于「钳了」的结论**；`runner/lib/llm-models.js` 里禁止出现 `2000`/`0.1`（源码级用例钉「公式零复制」），worker **必须**注入第二入参（另一条源码级用例）。口径：**配错元数据最多让压缩关掉，绝不能把 run 弄死**。

**测试口径**（合并树 `3f2ca25` 上亲手复跑，判绿=退出码）：根 **1251 / 1247 通过 / 0 失败 / 4 跳过**、`node --test runner/test/*.test.js` **314/314**、前端 `typecheck` 干净 + **33 文件 / 572 通过**（台账三处 1216→1251 / 286→314 / 571→572 已同步）。**变异：worker 7 条 + 主 agent 亲跑 8 条**，无一空转；行为级判据是**桩 provider 收到的请求体里 `max_tokens` 等于生效值**（「显式发」唯一可判证据）+ `model_metadata_missing` 出现/不出现判压缩开关。

**发版与部署（v0.1.16）**：main `556e64d`（main CI 含**三镜像构建校验**全绿后才打 tag）→ release run `39225514910` → 三镜像 `docker pull` 后 `image inspect` 与清单**逐个一致**（portal `eb89d5c6…` / fde `179c3ece…` / proxy `59fc9755…`）→ `deploy/.env` 形态① pin **三项**（本版动 `runner/` ⇒ 含 `FDE_IMAGE`；备份 `/tmp/deploy.env.bak-0116`）→ `up -d --no-build` → **`docker rm -f` 全部 7 台 `fde-*` 后 reconcile 全部落在 `179c3ece…`**（§8.17：不重建就还是旧引擎）。

**真机验收（v0.1.16，dev，主 agent 亲手；会话 `16261d57…` / 项目 `~/projects/probe-309`）** —— 探针手法：把 eric 绑定模型 `deepseek-flash` 的 `context_window` **带外**改成 16000（输出上限仍 32768 ⇒ 必触发钳制，且预算只剩 10000 ⇒ 几条消息就能压）：

- **P1 钳制**：runner 告警逐字 `model metadata clamped: max_output_tokens 32768 → 4000 (limit = floor(context_window/4), context_window=16000)`，且该 run 事件里**没有** `model_metadata_missing`。
- **P2 压缩真开火**：`compaction` 事件 1 条 + transcript **1 条 `folded` 行**，载荷 `round:7 / slidingWindow triggered:2 / tokensSaved:10520 / tokensBefore:10537 → tokensAfter:17 / foldedRounds:8`（预算算出来正是 10000）。**修复前结构上不可能出现**（标本 92 轮 `compaction=0`）。
- **P3 小窗口闸（2b）**：ctx 改 2000 ⇒ run `86c41ce5` **`finished`/`judge_done`**（不是 `invalid_budget`）+ `model_metadata_missing` 恰 1 条 + 告警点名两种成因 `… computed context budget is not positive (engine computeBudget rejected this pair, even at the 1/4 cap) → … not sent; engine compaction stays off (= 现状)`。
- **P4 复原** ctx=512000 ⇒ 零钳制告警、零 missing。
- **P5 切片 1.5 显示面**：新建一条 LiteLLM **不认识**的上游（`openai/probe309-unknown-xyz`，ctx=262144，不带任何输出字段）⇒ 网关侧 `model_info.max_output_tokens = null` 且 `litellm_params` 无 `max_tokens` 键，**门户列表显示 65536**（第三级回退在真门户上生效）。探针已删，目录回到 6 条且 ctx/两个上限**全部基线**。
- **用户可见变化**：元数据到位后 `outputHygieneLimit` 从恒定 **4096** 变成 `clamp(⌈15%·ctx⌉, 8192, 100000)`（dev 窗口下 8192 / 39321 / 76800），单轮聚合输出预算同时打开。

**三条实测换来的新事实（都已登记，别按旧口径推）**

1. **LiteLLM 会给「它认识的 upstream」自动注入 `model_info.max_output_tokens`**（用 `openai/k3` 新建、一个输出字段都没传，网关自己填了 `32768` 外加整套定价/能力元数据）⇒ 「目录里都是 `null`」只在**自定义 relay 名**上成立，#309 的成因描述要按这个收窄。
2. **`PATCH … : null` 在真 LiteLLM v1.103.2 上是 no-op**（手工与门户两条路各实测一次：200 但值一字未动）⇒ 门户文档那句「传 `null` 两处一起清」在真网关上**做不到**（单测钉的是**发给网关的请求形状**，fake 会清）⇒ 已登记 issue，改配路径要么用 LiteLLM 的正确清空语义，要么改成「设值不可清空」的口径。
3. **探针方法坑（两次假故障都是它）**：undici `fetch` **忽略** `Host` 头覆盖（forbidden header）⇒ 容器里打 `127.0.0.1:8090` + `Host: station.fde.erix.vip` 会被边缘判成无路由 ⇒ **404 假故障**（`curl -H "Host: …"` 带不带 `:8090` 都正常）；另 #234 同源门要求 `Origin` 与请求 Host **逐字同源（含端口）**，`Host` 不带端口 + `Origin` 带 `:8090` 会 `403 cross_origin_forbidden`。

**追加（#316 + #317，2026-10-19，分支 `fix-261019-06-316-317`；上面切片 1.5 / 2 里的三句旧表述以此为准）**：

1. **token 数只有一条规则，两侧各自执行一次**：必须正整数；**数字串与整值浮点归一成正整数**（落盘的是
   `number`，不是原字符串），**真小数 / `≤0` / `NaN` / `Infinity` / 非数字串判不可得**（不 floor、不兜 0）。
   实现：`runner/lib/llm-models.js:positiveIntOrNull()`（**入口归一**，在 `parseHeartbeatModels` 里做；
   `resolveModelMetadata` 的钳制与预算闸**一字未动**，继续用严格的 `isPositiveInt`）↔
   `portal/src/llm.js:positiveIntOrNull()`（读侧生效值 + 心跳下行取值）。测试 = **两侧镜像的同一张
   fixture 表**（`TOKEN_FIXTURES` 在 `runner/test/llm-models.test.js` 与 `portal/test/llm.test.js` 各一份，
   心跳面在 `portal/test/llm-reconcile.test.js`），**改一侧必须改对面**。后果：切片 2 那句「只收正整数、
   字符串一律丢键」收窄作废（数字串现在认）；切片 1.5 那句 `floor(正数 ctx/4)` 收紧成
   `floor(正整数 ctx/4)`（真小数窗口不再能算出回退值 ⇒ 与 runner 对齐）。
   #316 的病症本体（主 agent 在 `631bc46` 上探针复现）：`ctx:"262144"` ⇒ 门户显示着窗口而 runner 整键丢掉
   ⇒ `resolveModelMetadata` 返回 `null` ⇒ **压缩静默关**。今天的贯通用例走**真 runToolLoop + 真
   `computeBudget` 闸**，判据是请求体里有 `max_tokens` 且 `model_metadata_missing` 不再出现。
   ⚠ **dev 现网不活**（网关 6 条 deployment 的 `context_window` 全是整数 `262144`/`512000`，**零实例**）。⚠ **证据边界**
   （主 agent 验收时否证了 worker 的一句论证）：那句「兼容历史上存成数字串的值」的注释**出自本批 `42cb24c` 自己**，
   不是存量证据；真正的入口是**写侧对 `input.context_window` 不做类型校验**（`llm.js` 原样透传给网关）⇒ 字符串
   **结构上能存进来**。⇒ 本单性质 = **隐患收口**，不是正在流血的故障；**根因（写侧不校验类型）本单未闭合**，
   是否改成「只加写侧一条校验、读侧不必两侧归一」由独立过度设计审计判（工单 `~/worker-reports-261019/copilot-261019-A-order.md`）。
2. **压缩仍关着的情形是三种**（不是「唯一一种连窗口都没配」）：① 没配窗口；② 窗口形态 runner 不认
   （真小数 / `≤0` / 非数字）；③ 窗口小到 1/4 兜底仍算不出正预算（`ctx ≤ 2666`）。① ② 靠上游一次性
   `model_metadata_missing`，③ 靠 runner 的 `model metadata unusable` warn。`portal.md` §4.9 已按三条改对，
   别名对照表也从「五层」补成**六层**（补上 runner 那一层，与本节切片 1.5 那句「六层」对齐）。
3. **runner 告警文案**：不可用支路的成因 a 从 `(not a positive integer)` 改成**同时点名「下行未带」与
   「形态非法」并指向 `parseHeartbeatModels`**——入口归一后 worker 只能看见「键不在」，根分不出是
   portal 没发还是发了个不合法的数，旧文案会把运维引向错路。
4. #317 其余纠偏是**纯文字**（判据一条没改松）：§4.9 两处「传 `null` 两处一起清」改成「当前清不掉：真
   LiteLLM v1.103.2 对 JSON `null` 是**忽略**语义（#314），设值仍有效」，并补上「编辑表单留空 = 省略
   字段、新建才是显式 `null`」的不对称（⇒ 管理员看不到「清空失败」，只看到「数清不掉」）。

**验收与取证（主 agent 亲手，2026-10-20）**：三套基线在**沙箱合并树**上复跑 —— 根 `npm test` **1261/1257/0/4 rc=0**、
`node --test runner/test/*.test.js` **320/320 rc=0**、前端 `typecheck` rc=0 + vitest **33 文件/572 rc=0**（前端零改动 ⇒ 计数不变）。
**主 agent 亲跑变异 4 条全红在具名用例**（每条先证只改 1 行且行为真变）：runner 归一回退成「字符串一律丢」⇒ 3 红；
runner / portal 各自把真小数 `Math.floor` 掉 ⇒ 4 红 / 2 红；心跳下行不归一（直传 `model.context_window`）⇒ 恰 1 红。
worker 交付的**收尾纪律第三次发作**：终局文本停在「Now let me review the full diff」，报告是**中途快照**（写着「进行中」）；
主 agent 用 `git apply` 在一次性沙箱（`~/erix316-sandbox`，`--no-hardlinks` + detached + `remote remove origin`）里落地后逐文件审，
并以 **`git patch-id --stable` 逐条比对**证明沙箱两个 commit 与主仓分支提交同内容。取证全文见
`~/worker-reports-261019/feat-261019-06-316-317.md`（已由主 agent 补完）。

**追加（#315 + 独立审计的措辞处置，2026-10-20，分支 `fix-261020-01-315`）**

1. **#315 修好了**：门户的「AI 改名」（`POST /api/sessions/:id/ai-title`）现在**显式**发 `max_tokens: 512`。
   病根不是「忘了走包装层」——`docs/api/portal.md` §4.5a 与 `sessions.js` 注释都记着这个端点是**决策者批准的例外**
   （范围仅此端点）⇒ 它天生是手搓 `fetch`（全站**只有这一个**裸调用点）。
   **工单 261020-04（#315 追加）已把这一个裸调用点收进 `portal/src/llm-chat.js`**（portal 侧**对话调用面**
   的唯一出口：URL 拼接 / `max_tokens` 必发 / 超时到点必报错 / 错误映射 / key 只进 `Authorization` 头都在那里，
   且发出前还有一道「请求体必须有 `max_tokens`」的断言）；`sessions.js` 只留会话业务，`llm.js` 继续当**网关
   管理面**（不发对话）。⇒ 以后 portal 再加直连对话**不许**自己拼 `fetch`，一律走 `llm-chat.js`。⚠ **那句注释的出处过去记错了**：写着
   「原则出自 #88『portal 不持 LLM 客户端』」，而 #88 原文是「只动 portal + 前端展示；runner/agentd 零改动」——
   **方向相反**。真实成因是实现把自动标题放到了 runner ⇒ 同一件事两份实现（`runner/lib/session-title.js` ↔
   `portal/src/session-title.js` 镜像，`30`/`sanitizeTitle` 各一份、**无测试锁**）。**统一到 portal 侧已登记 #322**
   （含备选条款：那张单近期排不上才补镜像锁，二选一，别两个都做）。不发时
   LiteLLM 注入该 deployment 的 `litellm_params.max_tokens`（#309 切片 1 起 = **模型级**输出预算，现网 32768）
   ⇒ 拿模型级预算去生成一行标题，且 `context_window` 被配得很小时上游按「prompt + 预留 32768」判超限 ⇒
   **请求被拒**，症状是「点了 AI 改名没反应」（不是 run 失败）。512 取自 `runner/lib/session-title.js` 的
   `maxTokens: 512`（两条路径干同一件事，过去只有一条设了上限 = 这张单的登记理由）。测试除了钉请求体带 512，
   还**跨路径比对** runner 源码里的 `maxTokens: 512`（改一边就红）。变异：删那行 ⇒ 恰 1 红（请求形状那条）；
   只改门户的数 ⇒ 恰 1 红（跨路径那条）。⚠ **dev 现网不触发**（六个模型窗口都 262144/512000），
   「小窗口下上游真的会拒」这一步**未实测**（copilot 也标 `[未验]`）⇒ 这条是**消不一致 + 消隐患**。
2. **1/4 上限的定性改了（copilot 审计唯一判「过度设计」的那项）**：原来 `portal/src/llm.js` 写着
   「双保险，谁都不许拆」并把「每个 run 启动即死」当它的理由 —— **措辞过度**。事实是：引擎致命判据只有
   预算非正那一条；1/4 比引擎临界**更严**（`ctx=262144`：临界 ≈235928 vs 1/4 = 65536），会拒掉**引擎其实跑得动**
   的值（填 `200000` 预算 35929、能跑，只是每轮都在压缩）；而且**带外配置根本不经过写侧校验** ⇒ 致命面真正的兜底
   是切片 2b 那道上游闸。**数值保留**（它是决策者定的产品约束：管理员能心算 + 给输入留窗口空间），改的是
   「不能以『引擎兜得住』为理由自行放宽」这句纪律。`docs/api/portal.md` §4.9 / `fde-platform.md` §11.5 /
   `portal/test/llm.test.js` 注释同步改口。
3. **审计其余处置**：`runner/worker.js` 那句「camelCase 三键**全站**唯一」是**事实错误**（锁只数 `worker.js`，
   而 `runner/lib/session-title.js` 有一处合法的 `maxTokens: 512`）⇒ 措辞收窄成「本文件内、`runToolLoop`
   入参的唯一映射点」。`portal/src/llm.js` 心跳注释那句「『没值』只剩一种」按 #316/#317 改成**三种**。
   上面「已接受代价」里那条 wrap-up 副作用要加门：**本站 `worker.js` 传 `wrapup: false`** ⇒ 引擎
   `wrapupEnabled=false`（`orchestrator.js:1268` + `:1297-1300` 共同开门）⇒ 该路径**当前不可达**，不是活风险。

**发版与部署（v0.1.17 / v0.1.18，2026-10-20 上午）**

- **v0.1.17** = `e7eb8a7`（#316 元数据形态口径统一 + #317 文档纠偏，PR #320）：main CI（含三镜像构建校验）绿后打 tag → release run `39354576986` success
  → 三镜像 `docker pull` 后 `image inspect .Id` 与清单 `imageId` **逐个一致** → `deploy/.env` 形态① pin **三项**（本版动 `runner/` 实质代码 ⇒ 含 `FDE_IMAGE`；备份 `/tmp/deploy.env.bak-0117`）
  → `up -d --no-build` → **`docker rm -f` 全部 7 台 `fde-*`，reconcile 15 秒内全部落在 fde `imageId=sha256:047eab6c…` 且 healthy**。portal 实跑 `fb4c89ba…`、proxy `4bb20a9b…`，经 Traefik `/healthz` 200。
- **v0.1.18** = `5a5aacc`（#315 显式 `max_tokens=512` + 审计措辞处置 + #88 出处更正，PR #323）：release run `39363594675` success → 清单三镜像与部署机逐个一致（portal `1f0e32ee…` / fde `543c90bd…` / proxy `8b2d6520…`）
  → pin 三项（备份 `/tmp/deploy.env.bak-0118`）→ `up -d --no-build` ⇒ portal 实跑 `1f0e32ee…` healthy、`/healthz` 200。
  ⚠ **本版故意不重建 FDE 容器**（§8.19 先例）：`git diff v0.1.17..v0.1.18 -- runner/` 里非 version 文件只有 `runner/worker.js`，实质差异 **4 行且全是注释**（`// 全站只允许…` → `// 在本文件里只允许…`）⇒ 零行为差异，七台容器仍跑 v0.1.17 镜像 `047eab6c…`，下次重建自然升级。**别把它记成「runner 有改动所以必须重建」的先例。**
- **真机验收（v0.1.18）**：`POST /api/sessions/:id/ai-title` 端到端 **200** + 标题落库（`Shell命令与大文件读取测试`）+ portal 日志 `[ai-title] 会话标题已更新（source=fde_binding）`。
  ⚠ **网关侧独立证据拿不到**：LiteLLM v1.103.2 在本网关配置下 `LiteLLM_SpendLogs.proxy_server_request` 是**空对象**、`metadata` 的键里**没有请求参数** ⇒ 「请求体里确实带了 `max_tokens: 512`」的证据只有**单测**（请求形状断言 + 跨路径锁 + 两条变异各恰 1 红），**不许声称已在网关侧证实**。

**追加（#318 + #325 + #314，2026-10-20，分支 `fix-261020-04-314-318-325`；门户写侧三条，零 DDL、零依赖、不动 `runner/`）**

1. **#318 = 写侧硬下限 `CONTEXT_WINDOW_MIN = 65_536`**（`portal/src/llm.js:validateContextWindow()`）。**定性写进注释与文档**：它和 1/4 上限一样是**产品约束**，不是引擎安全必需（引擎致命判据只有「预算非正」，`ctx=32768/maxOut=8192` 预算 ≈21,507，引擎跑得动）；选 64k 的实测依据：固定前缀 ≈3,328 / 最省单轮回回来回 3,829–4,404 / 近 7 天 35 条 run 单 run 输入平均 27,641（最小 3,555、最大 257,207）⇒ 64k ≈ 平均用量的 2.3 倍，32k 只有 1.2 倍。**为什么不再单独加「压缩已关闭」提示**：下限把 `ctx ≤ 2666` 那个死区在门户里堵死，提示逻辑不必预支（runner 上游闸仍兜带外配置）。
2. **#325 = 落库写归一结果**（`model_info.context_window` / 镜像的 `metadata.context_window` / 绑死双写的 `max_output_tokens`+`litellm_params.max_tokens` 一律写 `positiveIntOrNull()` 的返回值，**不写调用方原值**）。**PATCH 没出现的字段不做归一写回**（留空 = 不修改）。
3. **#314 = 「清空」换成「按当前窗口 1/4 重设」**：`litellm_params.max_tokens` **不在** LiteLLM 的 `NULL_CLEARABLE_LITELLM_PARAMS`（源码实测），显式 `null` 是 no-op ⇒ 「手填过就撤不掉」是真限制；管理员真正要的是「让平台重新按新窗口兜底」⇒ 按钮把值填成 `Math.floor(窗口/4)`（与门户读侧回退同一算法），**只填不提交**、无窗口时禁用。两个表单的不对称同屏说清（编辑留空 = 不修改 / 新建留空 = 不写这个字段）。**前端不复制服务端数字校验**（65536 与 1/4 的唯一真相源是 `llm.js`）。
4. **次序（D2）**：窗口的形态 + 下限排在「输出上限 ≤ 1/4」**之前**，PATCH 里还排在**任何网关请求之前** ⇒ 窗口配错时网关零请求、零部分写入（照 #296 `model_name_conflict` 的形状）；症状「窗口 1000 + 上限 500」报 `context_window/too_small`，不报上限错。**零新错误码**（`validation_failed` + `details.reason='too_small'|'not_positive_integer'`）。
5. **一处对工单的收窄（主 agent 核可）**：`context_window: null` **不当下限判据**——它是新建表单「留空」的既有拼写，拒它会把「建一个没配窗口的模型」堵死；copilot 那句「null 是非法值」查的是 `positiveIntOrNull()` 的形态面，与「该字段允许表达没配」不冲突。

**验收**：根 **1262 → 1286**（1282 通过 / 0 失败 / 4 跳过；#318+#325 **+5**）、runner **320 不变**、前端 **582 → 585**（#314 **+3**）、typecheck 干净。**主 agent 亲跑变异 3 条全红在具名用例**：拆掉 `window < CONTEXT_WINDOW_MIN` ⇒ 2 条具名红；`model_info.context_window` 回写原值 ⇒ 恰 1 红；重设按钮改成顺手提交 ⇒ 恰 1 红（「PATCH 数为 0」那条）。

**已接受代价 / 遗留**：另一台服务器的切片 0 仍待它自己做（本版上线后 runner 显式发 `max_tokens`，那个 131072 不再影响平台流量，只咬**绕过平台直接调网关**的调用方）；wrap-up 归一化 judge **继承**宿主 `maxTokens`（`orchestrator.js:3115`，变严不是变松；round judge `:2319` 固定 1024 不受影响）；`context_window` 未配 ⇒ 压缩仍关（靠上游一次性事件告警，~~界面上不可见，未单开 UI~~ **2026-11-09 复核该半句已过期**：`model_metadata_missing` 三处承接面都在 ——`portal/src/http.js` 的 `HISTORY_EVENT_TYPES` 下发白名单、前端 `useEventStream.ts` 的 `EVENT_TYPES` 实时订阅、`HISTORY_REPLAY_TYPES` 回放与对应 `case` 分支——由 #420（§8.74）那波事件承接面关掉；「压缩关闭」这件事界面上现在看得见的就是这条事件行）；dev 残渣会话 `16261d57…`（`probe-309` + `big.txt` 200KB）**故意不清**——它是「钳制 + 压缩」两块的现成回放标本。


### 8.32 v0.1.19 发版：#318 / #325 / #314 落地 + 真机复验（2026-10-20 晚）

**载荷**（自 v0.1.18）：#324 前端 judge 事件分轴展示、#326 portal 侧对话调用收进统一 `llm-chat.js`（`max_tokens` 必发做成结构性保证）、#327 门户写侧三条（见 §8.31 追加块）。**本版 `runner/` 实质零改动**（`git diff --name-only v0.1.18..main -- runner/` 只有 `package.json` + lockfile）⇒ 只 pin portal + proxy 两镜像、**七台 FDE 容器故意没重建**（§8.19 先例）。

**发版与部署**：`0.1.19`（commit `f52bbf9`）→ main CI `39408033937` 绿（含三镜像构建校验）→ release run `39408039251` 绿 → 清单 `imageId` 与部署机 `docker inspect .Image` 逐个一致（portal `b8c6838c…` / proxy `3b5da731…`）→ `deploy/.env` 形态① pin（备份 `/tmp/deploy.env.bak-0119`）→ `up -d --no-build` ⇒ 两容器 healthy、经 Traefik `healthz=200`。
⚠ **本版 tag 早于 main CI 结束**（我把「推 tag」与「等 CI」并行了，与 §6 惯例「main CI 绿后才打 tag」不符）。本次结果无害（两条 run 都绿），但**下一次仍应先等 main CI 绿再打 tag**——CI 红时 tag 已推就会发出一个不该存在的版本。

**真机复验（主 agent 亲手，dev 栈）**：`PATCH {"context_window":2048}` ⇒ **400** `details={field:'context_window',reason:'too_small',min:65536,value:2048}`；被拒之后立刻读网关，该 deployment 的 `context_window` **仍是 512000**（「网关零请求、零部分写入」在真机上成立）；`PATCH {"context_window":"262144"}`（故意发字符串）⇒ 200 且**网关真值是整数 `262144`**（`model_info` 与 `metadata` 镜像两处都是 number = #325）；边界 `65536` 放行；探针全部复原（目录 6 条、`ctx` 全整数、两个输出上限 `32768`）；端到端冒烟会话 `16261d57…` ⇒ `202` + run `5c70e920…` + 助手回 `pong`。
⚠ **两条探针方法坑（都是这次现场踩的，别再踩）**：① `curl` 的 `Host` 与 `Origin` **必须都带 `:8090`**——`Host` 不带端口而 `Origin` 带端口会被 #234 同源门判 `403 cross_origin_forbidden`（`login` 第一次就 403）；② `erix_station_playwright` 容器里**没有 curl**，而宿主机的 undici/`fetch` 会忽略 `Host` 头（forbidden header）⇒ 这类带 `Host` 覆盖的探针一律用**宿主机 `curl --noproxy '*'`**。

### 8.33 会话标题统一到 portal 侧（issue #322，2026-10-20）

**病根不是「标题起得不好」，是同一件事有两份代码**：`runner/lib/session-title.js`（每次 run 终态后在 FDE 容器里自己调模型起标题）↔ `portal/src/sessions.js` 的手工「AI 改名」，两份各自写着 prompt、`sanitizeTitle`、`AUTO_TITLE_MAX_LEN=30`、`max_tokens`，**且无测试锁**。#315 是这份重复开的第一张账单：runner 那份设了 `max_tokens: 512`、portal 那份没设 ⇒ 同一件「起标题」的事，**走哪条路决定要不要吃网关注入的模型级预算**（小窗口模型下请求被拒，症状是「点了 AI 改名没反应」）。当时的修法是「把没设的那边也设上」= 承认有两处要同步。

**分层落点（今后加直连对话不许自己拼 fetch）**：`sessions.js` / `session-title.js` = 会话业务 → **`portal/src/title-llm.js` = 标题业务**（prompt、输入折叠空白并截 500 字、provider 解析、`TITLE_LLM_MAX_TOKENS = LLM_CHAT_DEFAULT_MAX_TOKENS`）→ **`portal/src/llm-chat.js` = 对话调用面唯一出口**；`llm.js` 仍是网关管理面（不发对话）。

**行为变化（用户可见的两条）**：① **自动改名不再从 FDE 容器里发**，改由 portal 在 run 终态后用「该 run 最后一段助手文本」生成 ⇒ 那次调用不再占容器配额、也不再要求容器在线；② U2 的 `title` 字段**摄入退役**——旧容器（v0.1.18 及以前）仍会带真标题，portal **照旧接受不报错**（非字符串照旧 400 `validation_failed`，那是 #88 以来的既有契约，**零新错误码**），但值不再进任何生成链；v0.1.19+ 的 worker **恒发空串**。

**「例外」这个词消失了**：§4.5a 过去把 AI 改名记成「portal 不持 LLM 客户端」的例外，而那条原则的出处本来就记错（#88 原文方向相反，见 §8.31 末）。portal 成为唯一实现点后它不再是例外，文档已改成「portal 是标题的唯一实现点，走 `llm-chat.js`」。

**降级是硬的**：无活绑定 ⇒ 一次请求都不发；网关 5xx / 网络错 / 超时 ⇒ 静默退到降级链（首条用户消息截断 → cwd basename），**绝不向上抛**——自动改名是锦上添花，不能把 run 的终态处理弄失败。

**验收**：根 **1286 → 1287**（+1 净：portal +10、runner 删 −9）、runner **320 → 311**、前端 585 不变、typecheck 干净。**主 agent 亲跑变异 3 条全红在具名用例**：`catch` 里 `return null` 改 `throw err` ⇒ 恰 1 红（降级②）；在 `session-title.js` 另立 `max_tokens: 512` + `new AbortController()`（行为不变纯结构）⇒ 恰 1 红（结构锁）；复活 `runner/lib/session-title.js` ⇒ 恰 1 红（改写后的「单一真相」锁）。⚠ **我有一条变异第一次做错了**：改出语法错 ⇒ 文件级失败（`pass 0`）看着像红。§8.24 说「没红要先证明变异不是空操作」，这是它的**反面**：**红了也要证明红是行为/结构造成的，而不是文件根本没跑起来**。

**发版**：本单**动 `runner/`** ⇒ 三镜像 + `FDE_IMAGE` pin + **`docker rm -f` 七台让 reconcile 重建**（§8.17；不重建就还是容器侧自己起标题）。

**真机验收抓到一格（v0.1.20 静默降级，2026-10-20 夜班，分支 `fix-261020-07-322-gateway`）**：合并树发了 v0.1.20 后我去真机跑「发消息 → run 终态 → 标题自动变」，**标题落的是降级链第 2 级「首条用户消息截断」，portal 日志一条 `[auto-title]` 都没有**。A/B 直接打在 portal 容器里（同一会话同一 run `e11dc9ce…`）：不带 `config` ⇒ `null`/79ms + `LLM 生成失败，退到降级链`；带 `LLM_GATEWAY_ADMIN_URL` ⇒ `"助手能力与交付说明"`/1472ms。**根因是接线，不是生成逻辑**：`http.js → internal.setRunState` 与 `finishRun → scheduleAutoTitle` 两跳都没带 `config` ⇒ `title-llm.js` 退回默认网关 `http://127.0.0.1:4100`，而**该地址在 portal 容器内 ECONNREFUSED**（容器里实测 `curl 127.0.0.1:4100/health/liveliness` = Connection refused；容器内只能走 `http://station-litellm:4000`）⇒ 每次自动改名都静默降级，而**界面看不出异常**（标题照样会变，只是从来不是模型起的）。⇒ 与 §8.25「必须传 `ctx.llmGateway` 单例」同族：**单测全都自己注入 config/gatewayUrl，结构上看不见这两跳**。修法 = 两跳各带 `config`；判据 = 新 `portal/test/session-auto-title-wiring.test.js` 3 条（两跳源码级锁 + 把「缺网关键 ⇒ 打到那个不可达地址」的后果本身钉住，防有人只改默认值就当接线修好了）。主 agent 亲跑变异 2 条各恰 1 条红在对应那条。基线根 **1290 / 1286 / 0 / 4**、runner 311、前端 585（前端零改动）。**教训：把「真机 R-1」留给别人/留给以后 = 把交付判据留空——这格从合并到实测隔了一整个版本。**

**同一格的验收结论要按 v0.1.21 的更正读（我当天写错了一次归因，代价 = 一条错评论）**：真机第一次探到「标题 = 首条消息截断 + 零 `[auto-title]` 日志」时，我把成因归给接线漏传 config。**该观察本身被防抖门槛解释**（`shouldRefreshTitle:55`：已有标题且 `auto_title_seq IS NULL` ⇒ 需 ≥3 轮新 user 消息，我只发了 1 轮 ⇒ 整段静默 return，连 warn 都不发）。接线缺陷**是另一件事，且证据是容器内 A/B**（同 config 之外一字不改 ⇒ 不带 config 的请求 `fetch failed`/79ms，带 ⇒ 真出标题/1472ms），不是那次界面观察。**口径：漏传 config 会让「门槛命中后的每一次生成」都静默失败；但「标题是首条消息」不等于接线坏了**。补两轮消息后 v0.1.21 真机全绿：标题 `HTTP幂等性与GET安全性`（模型起的）+ 日志 `[auto-title] 会话标题已更新（session=d48654c8…）` + `auto_seq` 从 NULL 前进到 483。**新登记的口径不一致（待决策者拍）**：`config.js:196` 按 #114 把 `sessionAutoTitle` 默认设**关**（省 token），但 `deploy/docker-compose.yml:188` 的 `ERIX_SESSION_AUTO_TITLE: ${ERIX_SESSION_AUTO_TITLE:-1}` 出自 #88 修订（`125eae9`，2026-09-25），**在部署面把它默认成开** ⇒ #114 那句「默认关」在任何 compose 部署的栈上从未生效（此前 worker 侧也一样吃这个 env 默认 1）。要么改 compose 对齐 #114，要么把文档改成「compose 默认开 = 有意」，二选一，别让它继续两头说法。

**决策落地（2026-10-21，决策者：「自动起名可以关掉」）= compose 默认改 0**：口径 = **默认标题取用户首条提问的前 N 字**（用户写得糊涂名字就糊涂），要换成模型起的名字**由用户自己点「AI 改名」**——决策者的理由是「通常此时已经历几轮对话，自动取名会比较准确」，所以准确性交给用户按需触发，不默认烧 token。改动只有 `deploy/docker-compose.yml` 那行 `-1` ⇒ `-0`（顺带删掉那句「生成移到 worker 侧」的过期注释，#322 之后生成者只有 portal），代码默认（#114）本来就没动。**判据形状是双向一致性而不是各钉各的**：新 `portal/test/deploy-env-defaults.test.js` 把 compose 插值出来的默认值喂进 `loadConfig`，要求等于「不喂 env 的代码默认」——各钉各的正是当初「文档说关、部署面开」能存活 20 天的失效形状。变异：compose 默认改回 `1` ⇒ **2 条全红**。基线根 **1292 / 1288 / 0 / 4**（+2）、runner 311、前端 585 不变。⚠ **遗留未清**：provisioner 仍把同名 env 下发给 FDE 容器（`portal/test/provisioner.test.js` 钉它默认 0、`fde-proxy.test.js` 钉它在代理白名单里），但 #322 之后 `runner/` 对这个 env **零读取** ⇒ 那根光纤是死的，撤它要动 portal 代码 + 两处测试，另开单做，别顺手删（它同时是「运维想单独给某台容器开自动起名」的唯一旋钮）⇒ 已登记 **issue #331**。**部署事实**：这次是 compose-only 改动 ⇒ **没发版**（portal 镜像仍是 v0.1.21 `146cc187…`），`up -d --no-build` 重建 portal 容器即生效（容器内实测 `ERIX_SESSION_AUTO_TITLE=0`）。**真机两个场景（dev，会话 `ab5fbdb4…`）**：① 默认关时连发 3 轮（门槛本来会命中）⇒ 标题停在首条提问截断、`auto_seq=NULL`、`auto-title` 日志 **0 行**（整条链一次没跑）；② 手点「AI 改名」⇒ `200` + 模型标题 + `title_source=manual`。对照面：同一栈在 v0.1.21 开着开关时，3 轮后标题被模型改成 `HTTP幂等性与GET安全性` 并写日志⇒ 「零日志」在这里是**开关关掉**的证据，不是又一条静默失败（§上文的区分判据反着用了一次）。

**过程账（同一个坑的第二次发作，代价 = 两小时）**：worker 连撞两次 30 分钟超时（我传的 50 分钟未生效，**实测上限就是 1800000ms**），两次都**没有 commit**；第一次的补丁与当时新合并的 PR #326 冲突（整份应用会删掉 `llm-chat.js`）⇒ 只能重做；第二次的补丁基点正好是当前 main ⇒ 主 agent `git apply` 落到分支后测出「只差一把跨文件锁」。**口径：worker 的补丁落主仓后必须先跑一遍数出真实缺口，再决定补哪里；跨文件读源码的锁在被读文件被删时必红，删它必须同时改锁的方向。**

### 8.34 没有工位的平台管理员不再停留 FDE 工作台（issue #332，PR #334，2026-10-21）

**判据本体（别再改错方向）**：「没有工位」= `users.role === 'admin' && !users.fde_name`。⚠ `role` 的 CHECK 是 `('fde','admin')` **单值互斥**（`docs/data/schema.sql:80-81`），而 `fde_name` 是**独立列**（`:82-83`）⇒ 「既是管理员又有工位」的人（`role='admin'` + `fde_name` 有值）**必须照常进得来**。挡的是「没工位」，不是「admin」这个词；判据里 `!fde_name` 与 `role==='admin'` 缺一个都错（只看 role 会误伤第②类人，只看 fde_name 会去挡「fde 但 fde_name 为空」的畸形账号）。这条不变式在单测与真机两侧各有判据。

**单一真相落点**：`portal/frontend/src/lib/workbenchGate.ts`（纯函数、零 vue-router 依赖，照 `lib/forcePasswordGuard.ts` 先例）：`isSeatlessAdmin` / `isWorkbenchPath` / `seatAwareLanding` / `workbenchGateDecision`。**router 守卫与 `auth.afterLoginRoute` 都委派它**（登录落点与入口闸共用一条判据，不许有第二份）。**必须在守卫里做、不能在 `WorkbenchView` 里做**：视图一旦挂载，`onMounted` 就去打 `GET /api/dirs` + `GET /api/sessions` + `GET /api/me/ports` 三趟换一个空壳（这正是 #308 审计量到的形状）。

**#332 原文有一格是我写错的（更正记录）**：写着「服务端没闸，会 mkdir、会建一条派发不出去的会话」—— 不实。`portal/src/sessions.js:213-222` 在 mkdir **之前**就查 `fde_name`，抛 **400 `validation_failed` + `details.field='fde_name'`**（`portal/test/sessions-cwd.test.js:99` 钉着）⇒ 零副作用早已成立。「400 改 403」经决策者判定**不做**（改了没人受益，却要动一条被测试钉住的既有契约）⇒ `sessions.js` 一个字节未动。今后别再按「服务端缺写闸」去找修复点。

**执行体过程账（两条纪律被实证）**：① pi `worker` 撞 **30 分钟硬顶**（`1800000ms` 是上限，传更大不生效）**0 commit**，靠 AGENTS 的「里程碑式写报告」留下了 4.2KB 现场 + 一份 45KB patch（`subagent` 的 `worktree-diffs/…patch` 含 untracked 新文件全文，worktree 被自动清理后仍可全量复活）。② 同一份改动交 `erix_run` 收尾（`maxRounds=100` / `timeoutMs=3600000` / `sessionDir` 必给）⇒ `judge_done`、59 轮、↑3,579,444/↓42,467、扩轮 0/2 未触发、transcript+judge.log+status.json 全落盘。**它抓出上一手虚报的测试**：`router.spec.ts` 当时没改 ⇒ 摘掉守卫**一条都不红**；两处注释引用的 `views/SeatlessAdminGate.spec.ts` **文件不存在** ⇒ §二.2「三趟空请求」其实没被钉。**口径：交接「测试已加」必须自己复跑变异，别信上一手的自报。**⚠ 一条待观察：`judge.log` 里 7 次 `extendDecision` 全 `missing`（引擎口径「缺失 = fail-closed 不扩轮」），本次自然结束无害，但真需要扩轮时这 7 次一次都扩不到。

**验收**：根 **1292 / 1288 / 0 / 4 不变**（`portal/src/` 与 `runner/` 零文件）、runner 311 不变、前端 **33 文件 / 585 → 35 文件 / 601**（+2 文件 / 净 +16，含删掉 2 条变不可达的用例）。主 agent 亲跑变异 2 条：**注释掉 `router.ts` 守卫那两行 ⇒ 4 条具名红**（含深链那条与两条零请求）、**判据删掉 `!fde_name` ⇒ 6 条红**（含「第②类人 → 照常放行」）；两条都先证只改 1-2 行且行为真变。**CI 质量门禁 pass**（镜像构建校验在 PR 上是 skipping，只在 main 跑）。

**真机 5 条全过（路线 A = 先验再合；手法值得复用）**：`docker build -f portal/Dockerfile`（build context = 仓库根，30 秒）→ `deploy/.env` 的 `STATION_PORTAL_IMAGE` 临时指到本地 tag（原值先备份）→ `up -d --no-build station-portal` → 浏览器走 `station.fde.erix.vip:8090`（经 Traefik）→ **验完还原 .env 并重新 `up -d`**（否则 digest pin 就假了）。结果：`admin` 落 `#/admin/users` 且工作台标记不存在；`#/` 与深链 `#/session/<uuid>` 都弹回管理台；三趟请求命中数**恒 0**；`eric` 落 `#/`、标记存在、三趟各发了（命中 3）；临时 `UPDATE users SET fde_name='adm334'` 让 `admin` 变成第②类人 ⇒ 落 `#/`、标记存在（**这条是「挡的是没工位不是 admin」的真机证据**），验完 `fde_name` 改回 NULL、无容器无 allocation 残留。⚠ 探针方法：登录按钮文案是 **`Next`**；`input[type="text"]` 属性选择器抓不到**没写 `type` 属性**的输入框（`.type` 属性读出来才是 `text`）。

**已知边界（都不算洞，且已并给 #308）**：~~管理台的「← Back to workbench」链接对无工位管理员是死链~~（**2026-11-10 更正**：`AdminLayout.vue` 已改成「无工位 ⇒ 不渲染该链接」，`AdminLayout.spec.ts` 两条钉住），但**点了会被守卫弹回**（实测 `#/admin/users` + 零请求），不构成误导，隐藏与否另开小单；`#/sessions` **不是路由**（router 只有 `/login`、`/change-password`、`/`、`/session/:id`、`/admin*`，全仓无人链它）⇒ `isWorkbenchPath` 只认 `/` 与 `/session/` 是对的；~~`WorkbenchView.spec.ts` / `WorkbenchPreviewPorts.spec.ts:207` 的夹具仍是「无工位管理员」~~（**2026-11-10 更正**：两处夹具已换成第②类人 / 畸形 `fde`，见 §8.41 与两文件头注）；~~`workbench.ts` / `DirSelect.vue` 里注释写的「服务端另有 403 写闸」与实际 **400** 不符 ⇒ 纯措辞，随 #308 一并更正~~（**2026-11-10 更正**：这两处注释与 `lib/workbenchGate.spec.ts` 的用例名都已按实际 **400 `validation_failed` + `details.field='fde_name'`** 写对）。
### 8.35 erix-agent 0.20.0 → **0.22.0**（issue #333，2026-10-21）

**上游事实（先核发布物再说，别照 changelog 推）**：npm 最新 `0.22.0`（2026-10-21 发）；**`0.21.0` 从未发布过**
（版本号被并进 0.22.0）⇒ 升级是一跳，官方指南 `docs/host-upgrade-guide-0.22.0.md` 也按 0.20→0.22 写。
`providers/payload.js` / `timeout.js` / `errors.js` 与 `termination.reason` 九值在 0.20↔0.22 之间**逐字节/逐字未变**
⇒ `llm-timeouts.test.js` 的 `ENGINE_VERSION_PINNED` tripwire 只追版本号（§8.27 同一处置）。

**唯一的宿主必改项 = 「同 dedupKey 异 payload 冲突」的处理**（不是可选能力，是硬要求）
- 0.22 引擎新写三类行：`<key>:engine:round:<n>:control:<slot>`（`judge-nudge`/`extend`/`guard-revise`/`forced-final`）、
  `:fold:<fp>`、`:ttl:<fp>`，**每次写都带 `ts: new Date()`** ⇒ resume 重放同一 dedupKey 必然拿到新 `ts`
  （session 作用域下 `round` 也会漂，宿主取 `MAX(round)+1`）。
- 本站旧判据是**整条 record 的 sha256**（含顶层 `ts`/`round`）⇒ 重放**伪报 `409 round_conflict`**；
  而 `runner/lib/store.js` 对非 2xx **一律上抛**（全文件零 409 分支）⇒ 引擎按持久化失败处理 ⇒ 终局
  **`persistence_failed`**（语义最重的那一类：崩溃恢复可能重复副作用）。
- 修法 = **三处一把尺**：新 `portal/src/transcript-payload.js`（只剔**顶层** `dedupKey`/`roundKey`/`round`/`ts`；
  **嵌套层的 `ts` 仍算 payload**）被 `portal/src/internal.js`（U5 `putRound` + 引擎轮记录真通路 `putSessionRound`）、
  `portal/src/transcript-store.js`（发消息预写适配器）与 `runner/lib/store.js`（IPC peer）**共用**；
  与上游 `src/store/transcript-dedup.js` 按文件路径**逐字对拍**（该件不在包 exports 面里，import 本身就是 tripwire）。
  真冲突仍 `409 round_conflict`（**零新错误码**），`details` = `existingFingerprint`/`incomingFingerprint`/`differingFields`（≤8）。
- ⚠ **改适配器但不改 `internal.js` = 把「静默丢弃」换成「真 run 失败」**——引擎轮记录走的是 U6 那个端点，不是 U5。
- ⚠ 我一度想加 `409 idempotency_conflict`（发消息幂等位撞车）——**不成立**：`messageId` 由服务端生成
  （`sessions.js` 用插入行的 `id`），撞幂等位的形状不可达 ⇒ 按「不做测不到的分支」撤掉。

**决策者采纳的两条行为变化**
1. **`reflection.judgeDoneAdvisory: true`**（`runner/worker.js`）：评审判「已达成」且置信度过阈值时，把那句
   评审意见作为一条普通文本消息注入下文（软提示，不硬断 run）。**上游缺省是 false**（不显式传 = 没开）；
   传非布尔被引擎 `TypeError` 拒。**故意不给 env 旋钮**（#331 死光纤前例）。风险如实说：judge 误判「已完成」
   会让模型提前收手——这条证据只能真机跑，不是单测。
   ⚠ 生效路径是**中途拦截审计**（`run-snapshot-executor.js:420`），不是 end_turn 那条 `judge_done` 停止分支；
   测试要跑通它必须真的走 **2 次**工具调用（门槛 `count >= judgeIntervalRound`，计数从 0 起、不审计那次才 +1）。
2. **引擎控制文本在界面上隐藏**（不新增 UI、不加 i18n 键）。落地时发现我给 worker 的工单有两处**说错了**，
   以实测为准：① **对话正文本来就不漏**——正文来自 `messages` 锚点 + run 文本表，且投影会给带 `meta.source` 的
   **user** 消息**另外打 `synthetic: true`**，既有过滤早已拦住（宿主新加的那条 `!isEngineControlTurn` 是**冗余守卫**，
   变异实测：撤掉它只有「直接喂 turn」那条用例会红）；② 投影对 **assistant** 消息会**连 `meta.source` 一起抹掉**
   ⇒ 给 assistant 侧加守卫是**结构上接不住**的死代码，故意不加，并把该上游口径钉成用例（红 = 上游开始保留该字段，届时再评）。
   **必须逐条消息判、不能按整行判**：`…:control:forced-final` 同一行里既有注入指令又有**不带 marker 的真终稿**，
   按行滤会把终稿一起吞掉（#300 之后那就是「中止/失败 run 正文又空了」）——这条被变异钉住（整行判 ⇒ 2 红）。

**被更正的历史记录**：**#303 重新挂账**（触发条件从「下次升引擎 minor」改成「旧 transcript 行被归档时」——
`worker.js` 那句 `?? tr.duration` 回退读的是**我们盘上的旧行**，与引擎版本无关，0.22 不触发它）；
§8.28 那句「`toolCallKey` 不接进卡片身份」被上游新的稳定 `erix.toolCallKey` **推翻**，但 #279 的用户标本未到，
**本单不动前端卡片键**（没有复现材料就不要改行为，见 #279 重挂的判据）。

**基线**：根 **1341 / 1337 通过 / 0 失败 / 4 跳过**（+49）、`node --test runner/test/*.test.js` **321/321**（+10）、
前端 `typecheck` 干净 + **35 文件 / 601 通过**（本单前端零改动；基线由 #334 从 33/585 推上来）。台账三处已同步。

⚠ **编号说明**：本节原写为 §8.34，合并 main 时发现 #334 已占用 ⇒ 顺延为 **§8.35**（时间上两单同日）。

**主 agent 亲跑的变异（不复用 worker 的）**：① 把 `samePayload(...)` 改永真 ⇒ 3 条「该 409」红；改永假 ⇒ 3 条「该幂等」红
（**这两条在本单之前都不红**：曾经跑过 `internal.test.js`+`transcript-store.test.js` = 98 通过 / 0 失败 ⇒ 定性为真覆盖缺口）；
② `ts` 塞回指纹 ⇒ 4 条具名红；③ 排除表清空 ⇒ 4 条红；④ 与上游对拍时排除表多塞一字段 ⇒ 3 条红；
⑤ 撤宿主守卫 ⇒ 恰 1 红；⑥ 改整行判 ⇒ 2 红（含 forced-final）。

⚠ **本单我自己的操作教训（代价 = 一次 amend）**：`git checkout -- <file>` 是从 **index** 复原，
**未 `git add` 的改动会被「变异复原」一起抹掉**——我做 M3 变异时把刚写的守卫抹了，直到全量跑才露出来
（那条新用例在全量里红、单跑绿）。**口径：做变异前先提交（或先 `git stash` 兜一份），别拿未入库的工作区当基线。**

**已知边界（都是刻意口径，别当 bug 修）**：真 PG 上「撞键 ⇒ 插入出行 ⇒ 之后读回」那条支路**不可达**
（部分唯一索引把并发串行化了）⇒ 它的行为面只在 fake 上成立；摘掉 key 白名单里的旧名不做（§8.25 同族）；
`portal/src/internal.js` 端点侧**没有**真库级行为判据（只有 fake + 源码级「同一把尺」断言）。

**发版与部署（v0.1.22，主 agent 亲手）**：PR **#335** 合并（`f9b5d5c`）→ PR 质量门禁绿 → main CI `39546100010` **两个 job 全绿**（含三镜像构建校验，这是打 tag 的前置，§6 惯例）→ tag `v0.1.22` → release run `39546457093` success → 清单 `images-digest`：portal `imageId=967c1911…`/`digest=4b443f3d…`、fde `imageId=10b47dc5…`/`digest=f546a65e…`、proxy `imageId=d5317d45…`/`digest=8addad01…` → `deploy/.env` 形态① pin **三项**（本版动 `runner/` ⇒ 含 `FDE_IMAGE`；备份 `/tmp/deploy.env.bak-0122`）→ `up -d --no-build` ⇒ portal 实跑 `967c1911…` = 清单 imageId、经 Traefik `/healthz` 200 → **`docker rm -f` 全部 7 台 `fde-*`，reconcile 40 秒内全部落在 `10b47dc5…` 且 healthy**（§8.17：动 `runner/` 不重建就还是 0.20.0 引擎）。

⚠ **本版新踩的运维坑（值得记，下次直接照做）**：GHCR **直连拉 fde 镜像时好时坏**——portal/proxy 一次成功，fde 的 422MB 单层实测 **0 B/s**（docker 不支持断点续传 ⇒ 每轮从 0 重来，永远撞同一层）。解法（**不动 daemon、不重启栈**）：① 从 manifest 读每层声明的 `size`（**别用 HEAD 取 Content-Length**，镜像站 HEAD 不给）；② `curl -C -` 走公共镜像站 `ghcr.nju.edu.cn`（实测 1.7–3.4 MB/s）逐层续传，**每层落盘后校验 sha256 == 文件名摘要**；③ 拼 legacy tar（`manifest.json` 的 `RepoTags` **必须全小写**，`LOCAL-FDE` 会被 docker 拒）+ `docker load`；④ **再按 digest 原样 `docker pull` 一次** —— 层已在本地 ⇒ 全是 `Already exists`，秒回，本地于是有了 `repo@sha256:` 这个 digest 引用，pin 保持形态① 不变（`docker tag` **不接受** digest 形态的目标名，别指望它造引用）。核对点：`docker load` 出来的 `.Id` 必须等于清单 `imageId`（本次逐位一致）。

**真机验收（v0.1.22，dev 栈，主 agent 亲手；会话 `2f980de4…` / 工位 `fde-eric` / 项目 `~/projects/probe-333`）**：
- **0.22 引擎真在 FDE 里跑**：三条 run 全部正常终态（`judge_done`），第一条 8 轮 / 16 次工具调用 / ↑45,737 ↓1,799；`transcript` 里 `erix.toolCallKey` / `erix.durationMs` / `erix.round` 均在（0.20 的 `erix.*` 形状）。
- **`judgeDoneAdvisory` 端到端成立（这是它唯一的生效路径，真机拿到了）**：构造「关键步骤已完成、加分项还在做」的任务 ⇒ 中途拦截审计第 1 次 `done:true`（`b06–b10` 尚未创建），引擎**投喂** advisory，模型收到后继续干到第 13 轮再由第 2 次审计正常收尾。advisory 落盘形态逐字确认：`role=user`、`meta.source="judge-control"`、文本以 `（附评审意见：评审认为本任务可能已达成原始目标——…` 开头。
- **控制文本没有漏进界面面**：`messages` 表含「附评审意见」的行数 = **0**；`GET /api/sessions/:id/events/history` 全文 **0 处**；会话标题仍是首条用户消息截断（未被控制文本污染）⇒ M3 的按条过滤在真数据上生效。
- **崩溃恢复不误报冲突（M2 的存储侧判据）**：一条 `sleep 60` 的 shell 跑到一半 `docker exec fde-eric kill -9 <worker>` ⇒ run 自动恢复并最终 `finished / judge_done`（16 轮），transcript 行数 16→**19**、**重复 `dedup_key` = 0**、portal 日志**无 `round_conflict` / 无 `persistence_failed`**。⚠ **证据边界**：本轮只证「恢复没有把重放判成冲突、也没有重复行」；**没有**单独证「重放记录恰好只在漂移字段上不同」（那才是新旧判据的分水岭），那一条的分水岭证据在单测（漂 `ts` 重放 ⇒ `{inserted:false}`）+ 真库仿真（`ON CONFLICT` 跳过 + 读回第一次那条 + 缺 `ON CONFLICT` 抛 23505 原文）。
- **dev 残渣（故意不清，是回放标本）**：会话 `2f980de4…`（含真投出来的 advisory 控制行 round 11）与 `fde-eric:/home/erix/projects/probe-333`（f01–f12、total.txt、done.txt、b01–b10）。

### 8.36 前端三修：卡片身份含轮次（#279）、中止后部分正文当场出现（#306）、工作台加载失败可见（#281）（2026-10-21，v0.1.23）

**零后端、零 `runner/`、零 DDL** —— 三个都是前端缺陷（标本与判据全部来自已关闭的 issue，本单不重抄成因）。

**#279 病根与唯一架构判断：身份与关联必须分开**。卡片身份以前是**裸 provider `tool_call_id`**，而上游 0.20 起明说「id 只保证单次投影内唯一」（`toolCallIdStrategy=cross_round`）⇒ 跨轮复用 id 时两张卡并成一张，**名字还是第一次那个**（用户报的「每轮恒 `✓ readFile`」）。新身份 = **`<run_id>:<round>:<call_id>`**（新 `lib/toolCardKey.ts` 是**唯一构造点**；缺轮次用 `?`，**不伪装成第 0 轮**；投影侧轮次从上游 `key` 首段 `<round>#…` 取 ⇒ 与实时同源，否则会出现永远对不上的两把尺）；而「把 `tool_result` 送回它那一轮那条卡」改用 `callId → 最近一张卡` 的**关联索引**——**索引不是身份**（名字永不被后续结果覆盖 ⇒ #279 的「冻结不覆盖」裁定在新身份下自然成立，不必再特判）。附带修两处同根问题：`attempt`/`replayPending`/`intercepted` 三处原来按 `callId` **全量刷**（一个 run 的 `attempt_killed` 会打上同 callId 的旧轮卡片）⇒ 改按身份精确匹配 + **跳 run 守卫**；`openSession` 原来不透 `item.run_id` 给 `replayEvent`（`liveRunId` 恒 `''`）⇒ 历史重放从入口就丢了归属。

**⚠ 定性：本单是按契约形状改的，不是按 dev 复现改的**。dev 栈 131 个 run / 1161 行 `tool_calls` 里**跳轮复用 0 例**（6 例都是同轮内不同 call_id）⇒ 真机只能验「**不回归 + 两把尺归并**」，新旧判据的分水岭证据在单测（`read_r1`→`read_r2` 复用与 `run-A/run-B` 同轮同 id 两组夹具）。用户部署上是否真的发生过复用，那条 SQL 仍然有效（`GROUP BY run_id, round, tool_call_id HAVING count(*)>1`）。

**#306**：`handleRunEnd` 在终态且 `termination.reason ∈ RUN_FAIL_REASONS`（`aborted` 也在集合内）时**补拉一次 history**（#300 的 `partial_output` 只在 history 里，此前只有 `openSession` 会拉 ⇒ 不刷新永远看不到）。只喂 `partial_output` 进既有幂等 `addPartialOutput`（id `partial:<run_id>`），**不重放 `judge`/`round_start`/`attempt_killed` 等非幂等事件**；三重竞态守卫（`sessionReqSeq`/`ctxSeq`/`sessionId`）；补拉失败静默。**成本红线：成功终态一个额外请求都不发**。**边界（刻意的）**：只覆盖 SSE `run_end` 通路（`reconcileActiveRun` 看不到终态原因，那条路上仍需刷新）；`queued` 被停属 `aborted` 族，会有一次零正文的补拉。

**#281**：`WorkbenchView.onMounted` 两个 await 自己收尾 ⇒ 失败变成界面上看得见的错误行（复用既有 `.syserr`，零新 UI 结构；新键 `errors.workspaceLoadFailed` 双语成对，服务端 message 过 `toDisplayText`）+ 不白屏；`resolveRouteSession` 失败则清锚点回工作台；`onMounted` 永不抛。顺带修一处静默失败：切换项目时 `selectCwd` 失败原先只 console 一下、界面还显示**旧项目**的会话列表。

**过程账（执行体超时的第三次，也是「先报现场再换体」口径的一次止确）**：第一次 30 分钟硬顶时只有 #279 已 commit、#306 半截（8 红）、#281 未做、报告未写。主 agent **没有自己接手**，而是报现场 + 给三个选项；决策者选 **A（续跑同一执行体）** ⇒ 续跑把三件事做完并自测变异。**口径：派单超时不等于可以擅改执行体**（AGENTS §3.0）。

**验收**：前端 `npm run typecheck` rc=0 + `timeout 240 npm test` **36 文件 / 640 通过**（基线 35/601 → **#279 +22、#306 +10、#281 +7（含 `localeParity` +1）**）；根 **1341 / 1337 / 0 / 4** 与 runner **321/321** 不变（`portal/src/` 与 `runner/` 零字节）。**主 agent 亲跑变异 3 条全红在具名用例**（每条先证只改 1–2 行且行为真变）：身份退回裸 `callId` ⇒ 一批具名红（跳轮复用 / 跳 run / 结果关联 / 实时-投影同一身份）；补拉改无条件 ⇒ 具名成本红线红；投影轮次恒 `?` ⇒ 「实时与投影产出同一身份」那条红。

**真机（本地构建 portal 镜像顶掉 digest pin 实跑，验完还原 `.env` 并重新 `up -d`）**：#306 —— UI 发一条长正文消息、流式中建了基线（`.msg.partial` = 0）、点「■ Stop」后 **1 秒内**部分正文就出现且**全程未刷新**，四个采样稳定 1 条、类名 `msg assistant md partial`（**不含 `syserr`**），**硬刷新后仍恰好 1 条**（不重复）。#279 —— 现跑一条三工具任务，实时卡片名字与时长各自正确（`🔧 writeFile p279.txt ✓ 2ms`、`🔧 readFile p279.txt ✓ 3ms`），**硬刷新前后逐字一致**（36 张卡、`byName` 完全相同），无 `undefined`/`[object Object]`/`NaN`。#281 —— 深链一个不存在的会话 ⇒ 重定向回 `#/`、**零未捕获拒绝**、不白屏。⚠ 一个现场发现：停止产生的红色中止行刷新后会消失（既有 #236「刷新后分隔条消失」，**不属本单**）。

**发版与部署（v0.1.23）**：PR **#336** 合并（`d4ce14d`）→ PR 质量门禁绿 → main CI `39579950588` **两个 job 全绿**（含镜像构建校验，这是打 tag 的前置）→ tag `v0.1.23` → release run `39580472883` success → 清单：portal `imageId=sha256:16e6f314…`/`digest=sha256:f0f2d6a4…`、proxy `imageId=sha256:a73a5661…`/`digest=sha256:dc06c02c…`，两个都是**直连一次拉成**，`docker image inspect .Id` 与清单逐个一致 → `deploy/.env` 形态① pin（**只两个**；备份 `/tmp/deploy.env.bak-0123`）→ `up -d --no-build` ⇒ portal 实跑 `16e6f314…`、healthy、经 Traefik `/healthz` 200。
⚠ **本版故意不重建 FDE 容器**：`git diff --name-only v0.1.22..main -- runner/` 里**非版本文件 = 0** ⇒ `FDE_IMAGE` 仍 pin 在 v0.1.22 摘要（`f546a65e…`），七台容器未动（§8.19 先例，别当漏做）；`STATION_DOCKER_PROXY_IMAGE` 已跟着升到 v0.1.23（只影响以后新建的 FDE）。
**在发布物上重跑一次现场判据**（不是只信本地镜像）：会话 `d724165a…` 已有一条历史 partial（基线 = 1），UI 发一条长正文消息、点「■ Stop」后**新 run 的部分正文 1 秒内出现且全程未刷新**（计数 1→2，两条各自独立 ⇒ 幂等键 `partial:<run_id>` 按 run 分开了，既没重复也没覆盖）。

### 8.37 erix-agent 0.22.0 → **0.23.0**（「存储收敛」，issue #337；本片 = pin + tripwire，展示面折叠另片）（2026-10-21）

**0.23 的宿主可观测面只有一件事**：轮记录**不再写 `messages`**，正文与 `tool_result` 搬进每轮多条 `kind:"message"` 事实行
（`dedupKey = <key>:msg:<round>:<seq>`，带整数 `seq` 与可空 `partOf`）。`src/providers/**` 与 `src/loop/termination.js`
经 `diff -r` **逐字节相同**，`termination.reason` 九值**逐字未变** ⇒ 两处版本 tripwire（+ 前端第三处）**只追版本号**。

**三处版本 tripwire**（工单只点名两处，worker 找出第三处，已修）：`runner/test/llm-timeouts.test.js` 的 `ENGINE_VERSION_PINNED`、
`portal/frontend/src/lib/terminationReasons.ts` 的 `ENGINE_VERSION_FOR_TERMINATION_REASONS`、
⚠ **`portal/frontend/src/lib/terminationReasons.spec.ts`（vitest 侧也硬写了一份版本号）** —— 不改它前端必红 1 条。
**约定**：下次升级前先 `grep -rn "0\.23\.0" --include="*.js" --include="*.ts" --exclude-dir=node_modules .` 数一遍断言位（注释里的历史复核记录不算）。
**主 agent 亲跑的变异（与 worker 的 4 条不重叠）**：把引擎 `payload.js` 的 `legacyTimeoutMs: hasExplicitPhase ? undefined : requestTimeoutMs`
改成无条件带上 `requestTimeoutMs`（= #261 那个 120s 绝对总闸复活）⇒ **3 条具名红**（含 ②【回归门】与 ③【实测】）
⇒ 证明超时门**对引擎行为漂移真有牙，不只是版本号**。⚠ 另有两条**故意记下不红的变异**：改 `payload.js:152` 的 `120000` 缺省值
（改 root 或改 `runner/node_modules` 两份都一样）**不红** —— 先自证不是空操作后定性：本站**永远显式传四相**，
那个 legacy 缺省在站内**根本不可达** ⇒ 断言没钉它是对的，不是覆盖缺口。

### ❌ 我（主 agent）在 issue 正文里写错、被 worker 推翻并被源码/实测坐实的两处

1. **「同一轮出两条 assistant turn / DTO 重复项」在生产形状下不成立**。session 作用域行 `run_id` 恒 **NULL**
   （`putSessionRound` 写 `VALUES (NULL, …)`），而 `session-view.js` 的 `isSessionRound` 只认
   `<sessionId>:round:` / `<sessionId>:engine:round:` 两个前缀 ⇒ 消息行的 dedupKey `<sessionId>:msg:…` **在 `:424` 被整行 `continue` 丢弃**，
   一次投影都不进。重复只在「`run_id` 非 NULL 的旧 run 作用域账本」这种**非生产形状**下出现（runner 自 P2 起只写 session 行）。
2. **`recallTranscript` 的 `LIMIT 2000` 风险不成立** —— 它是 `WHERE run_id = $1`（run 作用域 legacy），0.23 的新行是 session 行
   ⇒ **根本不在命中集里**。真正按行计的是 **`getSessionTranscript` 的 `LIMIT 10000`**（引擎 resume 取上下文走它），
   实测 **3.33 行/轮** ⇒ 有效轮容量 10000 → **≈3000 轮**，另开 [#338](https://github.com/ErixWong/erix-station/issues/338)。

**生产上真正会坏的只有一件事**（主 agent 独立重做的 A/B：同一份 `session-view.js`、同一场景，只换账本形状）：
**刷新/重开后每张工具卡片从 `✓`/`✗` 退化成 `…`** —— `resultPreview` / `isError` / `executionStatus` 三件全 `absent`
⇒ `useEventStream.ts:489-491` 的 `hasResult` 恒假 ⇒ `card.ok = null` ⇒ `StreamPanel.vue` 的 `statusMark` 出 `…`。
**正文没坏、不重复**（0.22 与 0.23 两侧都是「收工。」）。

**引擎侧结论对、依据要改**（别照我原来那句「裸 flatMap 等价」去论证）：0.23 的 resume 用
`foldLedgerMessages(records)`（`resume-manager.js:96`，`:102` 注释自己写着「口径不是裸 `records.flatMap(record.messages)`」）。
裸 flatMap 在**一轮 ≥2 个工具调用**时**不等价**（拆成两条 user 消息 ⇒ `validateMessages` 要求 `tool_use` 由紧随其后的那条 user 结清
⇒ `invalid_messages`）。⇒ ~~**runner 侧不需要补折叠**（站内 `runner/lib/store.js` 直通，引擎自己折）~~
**⚠ 这句已被 [#351](https://github.com/ErixWong/erix-station/issues/351) 推翻（2026-10-24 复核）**：引擎只调 `foldLedgerMessages`（只把 `partOf` 分片接回原消息），**载体折叠 `foldMessageRows` 是 store 的职责**（`host-consumer-contract.md:2405-2409 / :2442`；`resume-manager.js:239-241` 的 `seq` 播种本就为折叠后的 `load()` 输出设计）。本站 `load()` 直通原始行 ⇒ 引擎侧从来没折过，这就是 #351 的根因；修法是把 `portal/src/transcript-fold.js` 接到引擎面向的 `load()`（同一份折叠同时覆盖本单的链式 `partOf`）。

**为什么升级后三套全绿（绿灯不代表展示面没坏）** —— 主 agent 独立取证：`grep -rl "partOf|kind: *'message'" portal/test runner/test portal/integration`
= **零命中**；把真引擎产出喂进 `projectSessionMessages` 的用例 = **零条**；随包契约套件里 `kind:"message"`/`partOf` 命中 **0**
⇒ 回归面**完全落在**「站内展示面 × 真账本形状」这个交叉处。⇒ **约定：账本形状类升级必须自带一条「真引擎 → 展示面」的贯通用例**，
不能只靠随包契约（它们测 store 方法语义，结构上测不到这条链路）。

**运行时新事实**（主 agent 亲跑，供以后查）：0.23 轮行的键集实测为
`round,roundKey,dedupKey,ts,response,textPreview,toolUses,summary,l0facts,runState` —— **没有 `messages`**；
`summary` 引擎自己写成字符串 `"missing"`；`l0facts` 仍在（所以下面那条丢失只影响 timeline）。
**已上报上游** [erix-agent #353](https://github.com/ErixWong/erix-agent/issues/353)：`resume-manager.js:136` 的
`buildTimeline(record.messages ?? [])` 在 0.23 下恒空 ⇒ **resume 后 governor 的 `timeline` / `filesWritten` 不再从账本重建**
（上游 `test/` 无恢复路径断言 ⇒ 在他们 CI 里不可见）。**站内无法修**，只登记。

**基线不变**：根 **1341 / 1337 / 0 / 4**、runner **321/321**、前端 `typecheck` rc=0 + **36 文件 / 640**（三套 rc 全 0，
与升级前逐位相同；台账里前端基线本来就是 36/640，**我派工单时抄成 35 是旧的**）。零 DDL、`docs/data/schema.sql` 与
`deploy/migrations/` 一字节未动、`portal/src/**` 与 `runner/lib/**` 一字节未动、零新错误码、无新依赖。

**本片是「pin-first」的机械片**（§8.27/§8.35 先例）：折叠行为只能在**真 0.23** 上被测（0.22 账本压根没有消息行，折了也无物可折），
所以先升 pin 让展示面变红、再在下一片用 test-first 折回来。**读侧折叠已落地 = §8.38。**

### 8.38 0.23 读侧折叠：刷新后工具卡片不再退化成 `…`（issue #337 切片 A+B，2026-10-21，随 **v0.1.24** 发布）

⚠ **先记一条跨镜像类推的坑（我在 issue 正文里写错过，代价 = 一次发布动作差点漏做）**：
`runner/Dockerfile:88` 用 `runner/package.json` + lockfile 在 **FDE 镜像里** `npm ci` 装 erix-agent —— **引擎是装在 FDE 容器里的**
（worker 在 FDE 内跑 `runToolLoop`），portal 那份只用于投影/预写。所以**引擎升 pin 不属于 §8.19「runner 只有版本号变动 ⇒ 不重建容器」那一类**：
那次先例的前提是「runner **代码**没变」，而这里 `runner/package-lock.json` 换了引擎 ⇒ **FDE 镜像内容变了** ⇒ 必须重建镜像 + `docker rm -f` 全部 `fde-*`。
真机基线取证（重建前）：`fde-eric` 内 `/opt/erix/node_modules/erix-agent` 是 **0.22.0**；重建后 7 台全部 **0.23.0**。

**单一真相源 `portal/src/transcript-fold.js`**：`MESSAGE_ROW_KIND` / `isFoldableMessageRow` / `foldLedgerRecords(records, {keyOf})`（record 级）
/ `foldTranscriptRows(rows, {recordOf, withRecord, keyOf})`（DB 行级）——**两种入口共用同一份内部 `planFold` 计划**，不是两套折叠规则。
谓词与上游 `src/store/message-rows.js` 逐字同构：可折叠 = `kind === "message" && Number.isSafeInteger(seq) && Array.isArray(messages) && messages.length > 0`；
载体 = key 以 `:round:<n>` 或 `:round:<n>:resume` 结尾的**非消息行**，每轮取**第一个**；`partOf` 只在**该行只有一条消息**时当分片接回（与上游 `message-rows.js:137` 同一守卫）。
**硬口径：无可折叠行 ⇒ 返回入参本身（`===` 同一数组引用）**，旧 0.22 账本逐字节不变、零迁移。

**接线只有一个点：`session-view.js#projectSessionMessages`**（喂 `projectTranscriptForDisplay` 之前）。理由：它是全站两个业务读点
（`sessions.js#fetchSession` 对话流、`session-text.js#projectAnchors` 取文本）的**咽喉点**，一处接线不会「改了一个漏一个」；
源码护栏另钉「折叠模块只有一个消费点」。**故意不折四处**（`transcript-store.js` 的 `load` 与两个点查探针 = 发消息预写幂等面必须看见自己那条 `:input:` 行；
`session-text.js#fetchInputTextByMessageId` = 按 `dedup_key` 点查单行；`internal.js` 的 `getSessionTranscript`/`getTranscript`/`recallTranscript`/`collectRoundText`
= 引擎自己 `foldLedgerMessages`、以及 run 作用域 legacy 根本不在命中集）⇒ **正反两个方向都有源码级护栏**，变异⑥（把预写面也折上）恰 1 条红证明反方向有牙。

**`recordOf` 是注入的**（`session-view.js` 传 `recordForProjection`）⇒ `dedupKey`/`round` 的合成口径**只有一份**，折叠模块不复制规则。

**一处与工单措辞的差异（worker 按上游实现，主 agent 核可）**：「载体不在场 ⇒ 分片拼成一条独立记录」是**我写错了**——
上游 `foldMessageRows` 的语义是「消息行**原样留在数组里**」（各自一条记录、key/round 都是它自己的、`partOf` 保持未合并）。
两种写法都满足「不许静默丢内容」，但只有上游那种能过对拍 ⇒ **按上游**。另 **`foldMessageRows(records)` 没有 `keyOf` 参数**
（工单里我写「不传 keyOf 会退化成 `round:<n>`」是错的；站内缺省 `keyOf` 本就与上游同式），显式传 `keyOf` 的真实价值是「防缺省口径将来漂了导致对拍假绿」。

**主 agent 亲跑变异 4 条（与 worker 的 6 条不重叠）**：① 摘咽喉点接线 ⇒ **恰 1 条具名红**（真 0.23 账本那条）；② 抹平轮号 ⇒ **6 条红**；
③ 先折再排 ⇒ **8 条全绿** ⇒ 先自证非空操作（双载体输入下载体归属随输入序变，本站与上游同形）⇒ 定性「先排序再折」目前**不承重**（注释是意图声明不是契约）；
④ 拆 `partOf` 的单消息守卫 ⇒ **19 条全绿 = 真覆盖缺口**（上游有同一守卫，但没 fixture 走这条判别支）⇒ **主 agent 自己补一支 fixture**，
补测后重放同一变异 ⇒ **恰 1 条红在新用例上**（§8.24 口径：「没红」必须先证明变异真的改变行为）。

**顺带发现的一件既有事（不属本片，另开单）**：同一轮同时存在 `…:engine:round:<n>` 与 `…:engine:round:<n>:resume` 时（崩溃恢复后是真的），
逐行投影会给同一条 `tool_use` 出**两张卡**（一张有结果一张没有）。**0.22 上也一样**（两行都在、都带 `messages`），不是 0.23 引入的；
上游 `foldLedgerMessages` 根本不认载体（只按序拼消息），所以「取第一个载体」是本站为逐行投影引入的选择。

**基线**：根 **1369 / 1365 / 0 / 4**（+28）、runner **321/321** 不变、前端 `typecheck` rc=0 + **36 文件 / 640** 不变（`runner/`、前端、依赖、DDL 全部零字节）。

**发版与部署（v0.1.24，主 agent 亲手）**：PR 合并后 main `4eef2f7`（折叠）→ `3209c38`（台账）→ `e6fcc39`（版本 0.1.24），三次 main CI 全绿后才打 tag
→ release run `39639770354` success → 清单 `images-digest`：portal `imageId=ad997919…`/`digest=c0874607…`、fde `imageId=d707535d…`/`digest=941a157c…`、proxy `imageId=6c5a491d…`/`digest=2c64790e…`
→ **三镜像直连一次拉齐**（§8.35 那个 fde 422MB 单层 0 B/s 没复现），`docker image inspect .Id` 与清单 `imageId` **逐个一致**、`RepoDigests` 含清单 digest
→ `deploy/.env` 形态① pin **三项**（本版动 `runner/` 依赖 ⇒ 含 `FDE_IMAGE`；备份 `/tmp/deploy.env.bak-0124`）→ `up -d --no-build` ⇒ portal 实跑 `ad997919…`、经 Traefik `healthz=200`
→ **`docker rm -f` 全部 7 台 `fde-*`，reconcile 60 秒内全部重建在 `d707535d…` 且引擎 `0.23.0`**（§8.17 + 上面那条跨镜像类推的坑）。
⚠ 清单里 proxy 的镜像名是 **`erix-station-fde-proxy`**（不是 `erix-station-proxy`），照角色名硬拼会 `manifest unknown`。

**真机验收（两次：本地镜像预验 + 发布物复验；本单动引擎与读侧，值这个代价）**
- **预验路线（§8.34 路线 A 的变体）**：`docker build -f portal/Dockerfile`（30 秒，context=仓库根）+ **把 0.23 引擎整目录热patch 进 `fde-eric`**
  （`erix-agent` **零运行时依赖** ⇒ `rm -rf` + `docker cp` + `docker restart` 就够，不必构建 FDE 镜像）。⚠ **本地构建 FDE 镜像这条路当时走不通**：
  第 13 层要从 **github.com** 下 `gh`/`tea`/`glab`，而本机 github.com 直连 `000`（§3.7）；带 `--build-arg HTTP_PROXY=http://172.20.0.35:19001` 也连不上该代理
  （构建容器到 `prod` 网段不通）⇒ 热patch 是唯一低成本路子，且**它随容器重建自动消失**，不留残渣。
- **真 run 产出的账本形状（不是造夹具）**：`<sid>:msg:<round>:<seq>` 行 **4 条**（其中一条带 `partOf`，正是主 agent 补的那条守卫的真机样本）、
  `:engine:round:<n>` 行的 `messages` 是**空数组**（⇒ 不折就配不上 `tool_result`）。
- **同一批真库行在 portal 容器内的 A/B**（决定性）：`折叠前（修复前的喂法）= tool_use 若干 / 带结果 0`；`折叠后 = toolCalls 2 / 带结果 2`，
  `resultPreview="1: 24"`、`durationMs=4`。
- **浏览器面**（DOM 文本断言；vision relay 当时挂了，两次都 `http_request_failed`，DOM 断言更硬）：卡片 `🔧 readFile total.txt ✓ 4ms` / `🔧 shell exit 3 ✓ 10ms`，
  展开后结果文本 `1: 24` 与 `exit_code` **都在**；**硬刷新后仍是这两条**、无 `undefined`/`[object Object]`/`NaN`。
  ⚠ 卡片默认**折叠**，结果预览只在展开区（`StreamPanel.vue`）——**判「有没有退化」不能只看 innerText 里有没有 `…`**：
  实测那两处 `…` 是左侧会话列表 CSS `truncate` 出来的标题省略号，与卡片无关。
- **旧账本不回归**：0.22 时代会话两条（无 `:msg:` 行、轮行 `messages` 非空）DTO `toolCalls` **79/79 与 33/33 都带 `resultPreview`**，
  其中一条 `isError=true`（就是当年被杀的那个 `sleep`）；浏览器里 32 张卡片名字/状态/时长/展开结果逐条正常。
  ⚠ 更早那条会话 `带时长=0` 是**正确**的（早于 #283 回填，NULL = 不知道，不伪装成 `0ms`）。
- **发布物复验**：删容器重建后重跑一条端到端（会话 `ec8a77b3…` / run `25aa4f7a…`）⇒ 助手回「到」、`toolCalls=2` 且**两条都带预览与时长**、
  账本仍是 0.23 形状（4 条 `:msg:` + 2 条空 `messages` 轮行）⇒ **热patch 撤掉后结论在发布物上重述一遍成立**。

**验收中顺手发现、不属本片的一件事（另开 issue）**：同一轮同时存在 `…:engine:round:<n>` 与 `…:engine:round:<n>:resume` 时，
逐行投影会给同一条 `tool_use` 出两张卡（一张有结果一张没有）——当时附了一句「**0.22 上同样存在**，不是 0.23 引入的回归」。
⚠ **该句已被 #339 复核判为误判（2026-10-23，见 §8.40）：机制成立，但写侧在 0.22 与 0.23 都不可达**（0.22 有同轮互斥守卫、
0.23 的 `:resume` 行只写引擎控制文本）⇒ 已改判为「已钉住的夹具哨兵」，口径见 `docs/design/conversation-state.md` §6。

**环境侧副产品**：本机解析不出 `station.fde.erix.vip`（解析器负缓存）且没有免密 sudo 改 hosts ⇒ 临时起了一个
`127.0.0.1:18099 → 127.0.0.1:8090` 的 `Host`/`Origin` 改写小代理（`/tmp/hostproxy337.mjs`，验完已 kill）供浏览器验收用；
`erix_station_playwright` 容器是 **isolated** 实例，自己拿 JSON-RPC 戳它的 `/mcp` 会在页面加载后掉会话（`Session not found`），
但 pi 的 playwright MCP 走的是它、工作正常——**先用 MCP 工具，别自己手写 JSON-RPC**。


### 8.39 session transcript 分页换成 `(round, append_seq)` 真 keyset（issue #338，2026-10-22）

**缺陷本体（真库实测，不是推论）**：`getSessionTranscript` 的 `LIMIT` 量纲是**行**，游标却只带 `round` 且过滤 `round > cursor`（严格大于）⇒ 页边界切在一轮肚子里时，该轮剩余行被**永久跳过**。0.23「一轮 = 多行」把这件事从极端变成常态（dev 实测 2.2–3.3 行/轮）。后果不是「少几行」：引擎 `foldLedgerMessages` 建出的消息序列里 `tool_use` 没结清 ⇒ `validateMessages` 抛 **`invalid_messages`**，而切点由行数决定、稳定重现 ⇒ **重试无效，会话砖化**。

**触发面比「崩溃恢复」宽**：`runner/lib/transcript-seed.js:17-22` 只要账本非空就返回 `resume: true` ⇒ **第二条消息起每一条**都走账本重建。dev 单会话最大 106 行所以现网还没撞；这是「注册过的雷」不是「正在流血」。

**修法 = 真 keyset，不是调大 limit**（调大只是把页边界推远；且 `limit` 已被钳在 10000）。三处一把尺：
- `portal/src/internal.js#getSessionTranscript`：SQL 用**行值比较** `(round, append_seq) > ($2::int, $3::bigint)`，`ORDER BY round ASC, append_seq ASC` 不变；`next_cursor` = 本页**末行**的 `"<round>:<append_seq>"`，**本页 0 行才 `null`**；**先算游标再剥 `append_seq`** ⇒ 返回 record 的字段集与改前逐字相同（分页内部列不外泄）。
- `portal/src/http.js`：游标**原样字符串透传**（旧 `Number(...)` 会把 `"1:1070"` 变成 `NaN` ⇒ 第二页从头重读 ⇒ agentd 循环永不终止），形态校验 `^[0-9]+:[0-9]+$`，非法 ⇒ `400 validation_failed` + `details.field='cursor'`（**零新错误码**）。⚠ **`append_seq` 是 bigint**：JS 侧全程字符串、只在 SQL 侧 `::bigint`（`Number()` 在 `> 2^53` 会静默错值）。
- `runner/agentd.js`：`encodeURIComponent(cursor)` + `pages > 1` 时一条 warn（纯可观测，**不是 run event**、不前进 `run_events`）。

**零 DDL 的实测依据**：PG 的行值构造器能吃既有复合索引 —— `EXPLAIN` 里 `Index Scan using transcript_rounds_session_append_idx`、`Index Cond: ((transcript_key = …) AND (ROW(round, append_seq) > ROW(1, '1070'::bigint)))`。（MySQL/MariaDB 的 range 优化不吃多列构造器，那是**别的库**的告诫，本项目不适用。）

**故意不做的三件事**（都写进了注释/文档，别当漏做）：① **run 作用域 legacy `getTranscript` 不改** —— `UNIQUE (run_id, round)` 保证一轮一行、结构上无跨页，且 0.23+ 只有版本错配可达；② **不做纯数字旧游标双形态兼容** —— 唯一消费者是 agentd，它只回传 portal 给的串，兼容分支不可测；③ **不在服务端折叠**（折叠属另一片，且必须先有「不丢行」的分页，否则半轮被折进去）。

**顺带清掉一处文档假话**：`docs/api/portal.md` 与 `docs/testing.md` 都写着「单响应序列化体 8MB 上限 ⇒ `400 response_too_large`」——`grep -rn response_too_large portal/src` **零命中**，读侧从来没有体积闸（体积闸在**写**侧：`INTERNAL_ROUND_LIMIT = 1.5MB` ⇒ `413 payload_too_large`）。

**测试口径**：根 **1369 → 1378**（1374 通过 / 0 失败 / 4 跳过）、runner **321 → 323**、前端 **36 文件 / 640** 不变（`portal/frontend` 零字节）。判据形状是本案的关键：**分页并集与单页全量按 `[round, dedupKey]` 逐项有序全等**，不是「条数相等」也不是「集合相等」——后两种在旧语义下恰好也成立（少 2 行、无重复）。新 `portal/test/transcript-keyset-wiring.test.js` 跨文件钉三处（SQL 谓词 / http 透传 / agentd 回传）。⚠ **`fake-internal-pool` 保留旧语义分支并按 SQL 文本裁决**：只留 keyset 一支的话，「谓词改回 `AND round > $2`」这条变异会被 fake 用旧参数硬套 keyset 语义兜成**空操作**——fake 不许替 mutant 兜底（§8.14 同族）。既有源码护栏 `append-seq-ordering.test.js` 的锚点随旧谓词退役一起重锚，**保序断言一字未放**（下面变异 ① 证明它还有牙）。

**主 agent 亲跑变异 3 条全红在具名用例**（每条先证只改 1 行且行为真变，不复用 worker 的 5 条）：① `ORDER BY` 丢掉 `append_seq` ⇒ 恰 1 条红在重锚后的保序护栏；② `append_seq` 漏进返回 record ⇒ 恰 1 条红在 P1；③ 游标形态放宽成接受纯数字 ⇒ 恰 1 条红在非法形态负例。worker 另跑 5 条（含「`next_cursor` 只回 round 段」实测**先被 http 形态校验挡成 400**，于是另用「游标取本页首行」证明「重复读」那条断言不是死的 —— 防御有两层，诚实记录命中在哪一层）。

**真机 A/B（同一真库、同一会话 `4becb332…`，7 行 / 3 轮；探针脚本只桩掉「租约断言」那一条查询，transcript SQL 打真库）**：
- 修复前（**部署中的 v0.1.24 代码**）：`limit=3` 三页并集 **5 行 ≠ 单页 7 行**，被永久跳过的正是 `:msg:1:2` 与 `:engine:round:1`；重复读 0 行（所以「集合/条数」判据确实抓不住语义，但这里连条数都少 ⇒ 有序全等是唯一够硬的判据）。
- 修复后（`docker build -f portal/Dockerfile` 的本地镜像临时顶掉 digest pin）：游标形态 `"2:1074"`，四页并集 **7 行 = 单页 7 行有序全等**。
- **混版冒烟**（新 portal + 七台仍是 v0.1.24 runner 的 FDE 容器）：发一条真消息 ⇒ run `da6d955a…` `finished / judge_done`，transcript 正常增长 ⇒ 不透明游标对「只回传不解析」的旧 agentd 天然兼容。⚠ dev 会话最大 106 行 ⇒ **真 agentd 的多页翻页**本身仍是 `[未验]`（要 >10000 行才触发）。
- 验完还原 `deploy/.env` 并重新 `up -d`，portal 回到 pin 的 `ad997919…`、经 Traefik `healthz=200`。

**已接受代价 / 后续**：① **末页非空也要给游标** ⇒ 每次 `load` 到底多一次空页往返；keyset 下 `rows.length < limit` 是**可靠**的到底信号（旧语义下不可靠，这正是当年不判的原因），改成那样能省一次往返，**留后续单**；② `?cursor=`（空串）从「从头」变成 **400** —— 有意的收紧，agentd 结构上打不出该请求，已在负例钉住；③ 真库 `append_seq` 量级远未到 `2^53`，字符串纪律属**隐患收口**，其超界行为只在 fake 上成立。

**三件后续的顺序（已定，勿自行改方向）**：**B = 本单（已完成）→ C = #339 文档更正 + 夹具哨兵（零产品代码）→ A = 引擎读路径折叠（#353 的站内义务）**。A 必须在 B 之后（否则会把半轮折进一页），且必须等 C 定稿「载体怎么取」——因为 A 会成为 `portal/src/transcript-fold.js` 的**第二个**消费者。

**发版与部署（v0.1.25，2026-10-23）**：main `8d241cd`（版本 0.1.25，两个 job 全绿：质量门禁 + **三镜像构建校验**）→ tag `v0.1.25` → release run `39884453753` success → 清单三镜像与部署机 `docker pull` 后 `docker image inspect .Id` **逐个一致**（portal `9fef3faf…`/`ccce1c7a…`、fde `1642d582…`/`de16b78b…`、proxy `78d68779…`/`f1dcf047…`）→ `deploy/.env` 形态① pin **三项**（本版动 `runner/agentd.js` ⇒ 含 `FDE_IMAGE`；备份 `/tmp/deploy.env.bak-0125`）→ `up -d --no-build` ⇒ portal 实跑 `9fef3faf…`、经 Traefik `healthz=200` → **`docker rm -f` 五台 `fde-*`，reconcile ≈45s 全部重建在 `1642d582…` 且容器内引擎 `0.23.0`**、agentd `sse connected` + `sse ping received`（§8.18 双向链路口径）。

⚠ **只有五台**：发版前经决策者同意 offboard 了两台验收残渣（`pw173jscw` / `ui17kbwg`，10-13 那次浏览器验收建的临时账号）。平台自己的下线流程顺手拿到一次真机记账：`released 10 + 10` 条 allocation、`撤预览 grant（仅 active）0` 条（本来就是 0，关键是 #252 那把「只撤 active」的闸没撞 `used` 行的双向 CHECK）、两台容器消失、`routes.yml` 里两台 host 计数归零、用户 `disabled` + 下线任务 `done`。

**发布物上复验**（不是只信本地镜像）：会话 `4becb332…` 一条真消息 ⇒ run `f49dc486…` `finished / judge_done`（6 轮、↑11,017 ↓179、cacheRead 9,344），`tool_calls` 里 `shell dur=4015ms / exit_code: 0`（#283 的时长面在新镜像上仍正常），助手正文 `done`。dev 残渣：该会话多了两条探针消息（混版冒烟 + 发版冒烟），故意不清。

### 8.40 #339 改判：从「待修缺陷」降为「已钉住的夹具哨兵」+ 载体口径落档（工单 feat-261023-01，2026-10-23，**零产品代码**）

**背景**：§8.38 验收时我记下一条「同轮双载体 ⇒ 两张工具卡片」并附「0.22 上同样存在」。本片把它推到底：**机制成立、可达性不成立**。

**四条证据（均现网/包真件）**：① dev 真库对两种载体行 `GROUP BY transcript_key, round HAVING count(*) > 1` ⇒ **0 行**；② 62 个会话的生产投影按 `(round, call_id)` 与 `(run_id, round, call_id)` 都是 **0 重复卡片**；③ 0.22 `resume-manager.js` 有同轮互斥守卫；④ 0.23 `orchestrator.js` 写 `:resume` 行用的是 `messages: cloneState(resumeEngineText)` —— `resumeEngineText` 只收方向提示 / 达成 advisory **两种引擎控制文本**，不含 `tool_use` ⇒ 结构上给不出第二张卡（工具结果另走 `journalResumedToolResults()` 逐条 `:msg:` 行）。因此**不修**：为零可达面加读侧丢弃逻辑，只引入「静默丢内容」风险。

**载体口径（单一真相 `portal/src/transcript-fold.js#isRoundCarrier` + `planFold`，已写进 `docs/design/conversation-state.md` §6）**：候选 = key 以 `:round:<n>` 或 `:round:<n>:resume` 结尾的非消息行；**每轮取行序第一个**，其余候选行原样保留；**这是本站为「逐行投影」引入的选择，上游 `foldLedgerMessages` 根本不认载体**（只按 `seq` 拼回轮行）⇒ 不许当引擎既有语义引用。
⚠ **对工单的一处收窄（worker 实测，主 agent 核可）**：「第一个」的二级键是 **`created_at` 不是 `append_seq`** —— `projectSessionMessages` 折叠前用 `compareTranscriptRows`（`round` → `created_at`）**稳定**重排；生产 SELECT 按 `(round, append_seq)` 给行，两者一致时等价，**时钟回拨时载体跟着 `created_at` 走**（已钉成用例）。另：`foldTranscriptRows` / `foldLedgerRecords` **自己不排序**（排序是调用方责任）⇒ 「第一个载体」只在调用方排完序之后成立。
⚠ 还钉到一条：**`toolCalls[].key` 是位置型键（`round#recordIndex:entryIndex:t<i>`）会跨行撞** ⇒ 不能当去重判据。
**底线（与上游同语义）**：载体不在场（分页切在轮中间 / 崩溃早于轮行）时消息行**原样留在数组里**，不丢不拼；代价是该页出不了该轮卡片，正文仍在库里。**「内容丢失」不可接受，「这页没卡片」可接受。**

**随带文档更正**：`docs/api/portal.md` §9.8b 行序旧写 `round ASC, created_at ASC`——与 #338 的 S1 分页段自相矛盾且 `created_at` 有完全相同的行、不能确定性还原 ⇒ 改对为 `round ASC, append_seq ASC`。

**测试**：新 `portal/test/session-view-resume-carrier.test.js` **10 条**（**故意不并入 `session-view-fold.test.js`** —— 后者红 = 折叠坏了，本文件红 = 上游写侧形状变了 / 载体口径漂了，混在一起就没法「按红点定位上游文件」）。正向钉「0.23 真实形状只 1 张卡」（注释点名第一站去看 `orchestrator.js` 写 `:resume` 那处）；退化面按实测钉形状 A（2 张卡、`call_id` 同、视图 key 也同）；载体选择两侧（折叠侧归属 + 投影侧 `key` entryIndex 变化）；只有 `:resume` 载体的崩溃常态；无载体不丢内容；**分组键是 `round` 不是 `run_id`**（夹具全 `run_id: null`）；行序二级键。基线：根 **1378 → 1388**（1384 通过 / 0 失败 / 4 跳过）、runner **323 不变**、前端零字节未跑。

**变异（worker 5 条 + 主 agent 亲跑 3 条，不重叠）**：主 agent —— ① `compareTranscriptRows` 二级键反向 ⇒ 3 条具名红（含「行序二级键」）；② `planFold` 无载体分支改成「丢行」⇒ 2 红（本文件的底线用例 + #337 的与上游逐字段一致用例）；③ **夹具变异**（`shapeB` 删掉 `tool_result` 行）⇒ 3 红（红在「唯一那张卡必须带着工具结果」）。⚠ **本单我自己差点犯一次空操作**：第一次夹具变异因文本不匹配而**根本没改文件**（`git diff` 零行）⇒ 33/33 全绿不能当证据；按纪律先证 `0 1` 的删行再重跑才拿到 3 红（§8.24 / §8.36 同族：红了要证明不是文件没跑，没红要证明不是变异没改行为）。worker 另跑 5 条，其中一条是**判据自身**的变异（把重复判据改成 `(run_id, round, call_id)` ⇒ **不红 = 假绿** ⇒ 该判据是死的，硬判据必须用 `(round, call_id)`，已写进文档与用例注释）。

**下一片（A：引擎读路径折叠，#353 的站内义务）的前置已就位**：载体口径只此一份，`foldTranscriptRows` 把 `recordOf` 注入化就是为第二个消费者准备 ⇒ **A 不许在新消费点重写载体规则**；接线时要同时改 `portal/test/transcript-fold-wiring.test.js` 对 `internal.js` 的**反向**锁（改成正向）并保留其余反向锁。

### 8.41 预览端口段从工作台顶栏搬进左栏底部堆叠区（issue #308，PR #340，2026-10-23，**纯前端**）

**目的**：端口横条过去卡在顶栏与消息流之间，每次开工作台先吃一垂。搬进**左侧栏底部**与目录树同一堆叠区，各自独立折叠。**14 个文件全在 `portal/frontend/src/**`**；`portal/src/`、`runner/`、`docs/`、两份 lockfile、`docs/data/schema.sql` 零改动。

**已定稿口径**（写进 #308 正文，实现不得再发明）：默认折叠 · **两个独立折叠区**（不共用总开关）· 折叠态**不持久化** · `↻` 语义**不动**（继续只刷目录列表 + 目录树；`usePreviewPorts.load()` **没有 in-flight 守卫**，扩它之前要先加并发闸门，否则手快一点就是并发 GET）· 不预留 #247 图标位 · 不做「无工位管理员」空态分支（#334 已把人挡在门外）。

**三个容易改坏的地方**：
- **数据所有权跟着搬**：`usePreviewPorts` + `onMounted(load)` 从 `WorkbenchView` 移到 `SidebarPanel`，否则默认折叠的侧栏面板永远不会拉（#246 「进视图就拉一次、折叠也拉、**ticket 绝不预取**」三条语义逐字保持）。
- **滚动预算只留两层**：列表段（`flex-1 min-h-0 overflow-y-auto`）与底部栈（`max-h-[50vh] overflow-y-auto`）。`<aside>` 由 `overflow-y-auto` 改 **`overflow-hidden`**，目录树自己那层 `max-h-[40vh] overflow-y-auto` **撑掉**。三层嵌套滚动抢滚轮是 #308 审计量出来的真缺陷。
- **`variant` 默认仍是 `table`**：新形态 `variant='list'`（每行 = 端口 + 短状态 + 打开按钮，第二行 hostname `block w-full min-w-0 truncate`，完整口径挂同元素 `title`/`aria-label`）。侧栏可用宽 ≈**163px**、hostname 继承 14px ⇒ 溢出是被断言的；管理台 `FdePreviewPortsPane` 不传 variant ⇒ 零改动（真机重验：表头 `Port | Preview host | State | Actions` 仍在、list 标记不存在）。

**钩子与契约**：新 `data-test="sidebar-aside" / "sidebar-session-list" / "sidebar-bottom-stack"`（几何/归并判据用）；`preview-ports-toggle` **名字不改**（`ForcePasswordChangeView.spec.ts:115` 拿它当工作台挂载标记，现在在侧栏里、仍全页唯一）；`↻` 的 `title="刷新目录列表与目录树"` 一字未动（两处测试按精确 title 选它）；`GET /api/me/ports` DTO 不碰。

**既有测试没靠放宽变绿**：`SidebarPanel.spec` 的 `paneEls()` 从「根下恰好 3 个子节点、树在最后」改成按钩子定位 + 「树在底部栈**末位**」（意图保留）；树限高断言从「树自己 40vh」改成「栈 50vh + 树不再自带滚动（负面断言）」。

**基线**：根 **1388 / 1384 / 0 / 4 不变**（`portal/src/` 与 `runner/` 零字节）；前端 **36 文件 / 640 → 653**（+13）；typecheck 干净。执行体自跑变异 5 条（并开关 / 默认展开 / 删两个 `data-test` / 去 `truncate`），全红在具名用例。

**主 agent 亲跑变异 3 条（不重叠）+ 一条真覆盖缺口**：① 把树那层 `max-h-[40vh] overflow-y-auto` 加回去 ⇒ **2 条具名红**；② 侧栏 `variant` 用成 `table` ⇒ **3 条具名红**；③ `<aside>` 的 `overflow-hidden` 改回 `overflow-y-auto` ⇒ ⚠ **66 条全绿**——原断言只查「栈内部没有第二个滚动元素」，`aside` 那一层没人钉 ⇒ **定性真覆盖缺口**，补断言后重放同一变异 ⇒ **恰 1 条红**在具名那条（§8.24 / §8.14 口径：「没红」先证明变异不是空操作）。

**真机 5 条全过（路线 A：先验再合，同 §8.34 手法）**：本地构建 PR 镜像临时顶掉 digest pin（备份 `/tmp/deploy.env.bak-308`，验完已还原）⇒ `header.nextElementSibling === MAIN`（横条真的没了）、折叠条在 `aside` 的底部栈内且全页唯一、默认 `aria-expanded=false`、`aside` 无滚动类且**栈内 `overflow-*` 元素数 = 0**、四步开关序列证明两区互不影响（只关端口 ⇒ 树仍可见）、签票 `POST …/preview-ticket` **恰 1 次** + 新标签落预览 host + 当前页 URL 不留票、管理台 Ports tab 仍表格形态。截图 `/docker/erix_station_playwright/pr308-sidebar-ports-expanded.png`。

**真机量到的一条 UX 后果（按设计，不是 bug）**：两区**都展开**时底部栈可视高 `360px` / 内容 `838px` ⇒ 目录树折叠条落在栈底之下 ≈391px，**要在栈里往下滚 ≈478px 才够到**（够得到）；会话列表段可视高 `205px`（≥120px 判据成立）。这是「一套底部滚动预算」的直接结果；要改得在产品上二选一（调大 `50vh` / 两栏都展开时优先保树），另开单拍。像素几何在 jsdom 里是**算术不是实测**，真机不达标时**先调 `50vh`，别再给目录树加回第二层滚动**。

**随带清掉 #334 两笔尾巴**（同一 PR）：`SeatlessAdminGate.spec` / `workbenchGate.spec` 的「无工位管理员」直接挂载夹具（守卫上线后形状已不可达）换成**第②类人 / 畸形 `fde`**；`workbench.ts` / `DirSelect.vue` 注释里「服务端另有 403 写闸」按实际 **400 `validation_failed` + `details.field='fde_name'`** 更正（服务端面零改动）。

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

### 8.42 流式正文为什么「不是逐字出」：裸对象进了响应式数组（issue #342，PR #343，2026-10-23，merge `06bbaa2`）

**症状与病根**（issue 里的根因分析我独立复现，不是照抄）：run 正常终态、SSE 健康、库里 delta 事件与终稿都在，但界面上正文**不是逐字出**——像 run 结束才一次刷出来。机制是 Vue 响应式的一条老坑：`addDeltaEntry()` 返回**裸对象**，裸对象 `push` 进 `entries.value` 之后，闭包里继续持有并修改那个**裸引用**——读走 proxy（`track`）、写打在裸对象上（碰不到 trigger 逻辑）⇒ 不通知 ⇒ 不重渲染。只有结构性变化（`run_end` 移除 delta、追加终稿锚点）才触发一次渲染，于是整段答案一次出现。`useEventStream.toolCard()` 同根同因（`Map` 存裸引用，首帧 `card.text` 不触发）。

**载荷只有 3 个前端文件（+76/−1）**：`stores/workbench.ts` 流式那行改取 `entries.value[entries.value.length - 1]`（push 后立刻回读 proxy，`shallowRef` 的 `triggerRef` 兜底也走同一条更新路径）；`composables/useEventStream.ts` 的 `toolCard()` 改 `return toolCards.get(key)!`；`workbench.spec.ts` +2 条回归。

**验证与变异（主 agent 亲跑，不采信 PR 自报）**：PR head 上 `typecheck` rc=0、前端 **36 文件 / 655 通过** rc=0（= main 基线 653 + 2）、根 **1388 / 1384 / 0 / 4** 与基线逐位相同（`portal/src/` 与 `runner/` 零字节）。变异：撤掉 proxy 取回那两行 ⇒ **恰好 1 条具名红**；`toolCard()` 退回 `return card` ⇒ **全绿 ⇒ 这处改动没有对应的红变异**。按纪律先自证不是空操作（核 `toolCard()` 全部 2 个调用点：`card` 只在 handler 局部、无跨事件缓存裸引用，丢触发那一帧发生在任何人能订阅之前，且创建本身是结构变更会触发同批渲染）⇒ **定性为加固而非第二个现象**，#342 正文那句「同类隐患」按此收口，别当「修了两处 bug」记账。

**真机 A/B（决定性；同一会话、同一 prompt 形态「120 行编号要点、禁工具」，只换 portal 镜像）**

| 环境 | 画面增长次数 | 平均每次 | 形态 |
|---|---|---|---|
| 部署中的 v0.1.25（修复前） | **3**（93s / 466 采样） | 1439 字符 | 整段答案 **一跳 +4283 字符** |
| PR 构建 `index-CZEDYy1L.js` | **24** | 175 字符 | 每 ~200ms 一次 60–130 字符 = 打字机 |

总字数 4317 vs 4206（内容量相同，只差画法）；残渣 `.msg.assistant.md` 空节点 **0**（那个 `stored?.kind === 'delta'` 防御分支没留孤儿空气泡）、整页无 `NaN`/`[object Object]`/`undefined`、console error 0。部署手法 = §8.34 路线 A（worktree 里 `docker build -f portal/Dockerfile` → `.env` 临时顶掉 digest pin，备份 `/tmp/deploy.env.bak-343` → 验完还原并 `up -d`，还原后实跑 `9fef3faf…` = v0.1.25 pin、`healthz 200`）。

⚠ **本案最值钱的一条口径（我差点测出错）**：第一次「修复后」只测到 2 次增长，看着像「修复没效果」——真因是**浏览器在跑缓存里的旧 bundle**（加载 `index-BSvpdxB0.js`，而新镜像是 `index-CZEDYy1L.js`）。⇒ **前端 A/B 必须先断言浏览器实际加载的 bundle 文件名**（`performance.getEntriesByType('resource')` 里筛 `assets/index-*.js` 与容器内 `index.html` 对比），加 `?nocache=` 重载再测；否则就是把旧代码当新代码下结论。

**状态**：已合 main（`06bbaa2`，PR 自动关 #342），**未发版** —— 试用栈仍 pin v0.1.5，那条路上「整段一次出现」依旧会复现，别当回归。台账：前端基线 653 → **655**（`docs/ops/ci-release.md` §1 步骤 ④）。

### 8.43 v0.1.26 发版与部署（2026-10-23，载荷 = #308 预览端口搬左栏 + #342 打字机修复）

**载荷**（自 v0.1.25，共 13 个提交）：`#340`（issue #308，预览端口段从工作台顶栏搬进左栏底部堆叠区，前端基线 640→653）、`#343`（issue #342，delta 气泡/toolCard 持响应式 proxy，653→**655**）、三批 test/docs（#339 哨兵与载体口径、#338 发版补记）。⚠ **本版 `runner/` 代码零改动**（`git diff --name-only v0.1.25..v0.1.26 -- runner/` 去掉 package 文件后为空）⇒ **故意不重建 FDE 容器**、`FDE_IMAGE` 仍 pin 在 v0.1.25 摘要 `de16b78b…`（§8.19 先例，别当漏做）。

**流程**（这次严格按「先等 main CI 绿再打 tag」，§8.32 那条纠偏落地）：版本 bump `32a2801`（六文件：三份 `package.json` 各 1 行 + 三份 lockfile 各 2 行，diff 恰好 9 增 9 删）→ main CI run `39906003775` **两个 job 全绿**（质量门禁 + 三镜像构建校验）→ 才打 tag `v0.1.26` → release run `39906538060` success（`event=push`，§8.15 那条老口径仍然成立）→ 清单 artifact 名是 **`images-digest`**（不是 `images-digest.json`，那是里面的文件名；`gh run download -n images-digest.json` 会报 no artifact）。
digest：portal `8a0b7b7c…` / imageId `8b3dec6d…`；fde `48c72116…` / imageId `e29d20c2…`；proxy `04d98cc4…` / imageId `a43c4e3e…`。**三镜像直连一次拉齐**（§8.35 那个 fde 422MB 单层 0 B/s 没复现；本版只 pull 了要 pin 的两个，fde 用 `docker manifest inspect ghcr.io/erixwong/erix-station-fde:0.1.26` 探到即算在 GHCR 存在）。`deploy/.env` 形态① pin **只两行**（备份 `/tmp/deploy.env.bak-0126`）→ `up -d --no-build` ⇒ portal 实跑 `8b3dec6d…` = 清单 imageId、healthy、经 Traefik `healthz 200`；`station-docker-proxy` 实跑 `a43c4e3e…` 一并跟上（只影响以后新建的 FDE）；五台 `fde-*` 仍在 `de16b78b`。

**发布物上的真机复验（主 agent 亲手，1280×768）**
- **bundle 核对先行**（§8.42 那条口径反着用）：容器内 `index.html` 与浏览器 `performance` 里的入口都是 **`index-CZEDYy1L.js`**，且**不等于**修复前 v0.1.25 的 `index-BSvpdxB0.js` ⇒ 下面这组数据测的确实是新代码。
- **#342**：同一条 120 行 prompt ⇒ 374 次采样里**画面增长 62 次**、平均每次 **120 字符**、从 t=1.0s 起每 ~200ms 一跳（60–80 字符）= 打字机在发布物上成立。对照修复前 v0.1.25 是「3 次增长、其中一跳 +4283 字符」。
- **#308**：`data-test="sidebar-aside"` / `sidebar-bottom-stack` / `preview-ports-toggle` 三者关系正确（**预览切换在底部栈内**），`#preview-ports-disclosure` 的 `closest('[data-test="sidebar-aside"]')` 命中 ⇒ 顶部没有全宽预览条残留；`sidebar-session-list` 可视高 532px（会话列表仍独立可滚，滚动预算只有一层）。
- 浏览器 cookie 会随页面上下文重置丢掉 ⇒ 处置：在页面里 `fetch('/api/auth/login')` 一次（同源自动带 `Origin`，#234 同源门不拦），比走表单稳。

### 8.44 目录名允许下划线：修的是「前端比后端严」，不是「放宽 DNS 约束」（issue #284，PR #345，2026-10-23，merge `eb079c8`）

**决策者选 (a)「只把 `_` 加进前端」**。派单前用两名只读 reviewer 独立分析（并行、各自出报告），**两份都推翻了我给的前提**，所以这一节先记被纠正的事实——否则下一个人会按我原来的错说法去改：

1. **「目录名要当 DNS label」这个理由早已失效，而且不是我说的 #246 —— 是 P5 / 迁移 `deploy/migrations/0008-deprojectize.sql`**。预览 URL 全仓只有一个生成点：`projects.js#buildHostname({fdeName, port, baseDomain})` ⇒ `<工位名>-p-<端口零填充≥4位>.<伞域>`（现网实例 `http://eric-p-22000.fde.erix.vip:8090`）。**项目/目录名不进 hostname**，也不进容器名、网络名、任何下发文件。
2. **我建议的「后端收紧到前端」被否**，理由硬到不能含糊：`sessions.js:42-44` 原话写着目录名允许下划线是**有意的**（「用户在容器内自建目录的自由命名权」）；后端收紧会让唯一带 `_` 的真实项目 `meeting_asr_app`（真库 **15 次 run**，含 `judge_done`）变成「看得见、选得中、建不了会话」，而目录名在用户磁盘上、**平台无权改名**。⇒ **方向只有「前端补完到后端」一条**。
3. **不会重现 #202 那类「过应用校验、被 DB CHECK 炸成裸 23514」**：真库 `pg_constraint` 实查 `chat_sessions.cwd` 的 CHECK 数 = **0**；唯一那条 DNS CHECK 是 `port_allocations_hostname_dns_check`，作用在 `hostname` 列上，而该列**永远不含项目名**。
4. **FDE 名一个字符都不能跟着放**，且比 #284 正文说的更硬：**`users_fde_name_check` 是真库 CHECK**（`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`）+ 域名预算 55（`63 − len("-p-" + 5 位端口)`）+ 进容器名/网络名/凭据路径/LLM key alias。**「挡的是没工位的人」那类判据混淆在这里的对应物是：项目名与工位名是两条独立正则、两条独立约束，放宽前者在物理上不可能影响后者——唯一要防的是有人「顺手统一」。**

**DNS 事实口径（决策者问过「`_` 和 `-` 是不是都可以」）**：`_` 在 **DNS 记录名**（`_dmarc.` / `_acme-challenge.` / `_sip._tcp.`，RFC 2181 放宽成 8-bit clean）**可以**，在**主机名 / URL host**（RFC 952 LDH + RFC 1123 只放宽「可数字打头」）**不可以**；且有硬后果：**CA/Browser Forum 基线要求 2019-04-30 起证书 `dNSName` MUST NOT 含 `_`** ⇒ 预览域名将来要上公共通配证书，工位名带 `_` 就签不出来。**「DNS label 是刚需」这句没错，但它挂的是工位名，不是目录名。**

**载荷**（前端 6 文件 + `projects.js` 注释 + 3 篇文档）：`DIR_NAME_RE` 只把字符类 `-` 扩成 `_-`（首尾/长度/其余字符集**一字不改** ⇒ `cmms_test` 通过、`_x`/`x_` 仍拒，与今天 `-x`/`x-` 对称）；中英文案重写（说全规则 + 「容器里已存在的目录哪怕含其它字符都可在下拉里选中」，并**禁止再出现「预览域名/DNS」**）；新 `src/lib/dirNameRule.spec.ts`；`docs/api/portal.md` 顺带把 `POST /api/sessions` 按代码真值更正（原表写请求体 `project_id`、响应裸 `ChatSession`，实现是 `201 { session }` = `http.js:1456`、`project_id` 只是 P5 别名 = `sessions.js:7`、目录不存在则 `mkdir` = `sessions.js:198`）。**零后端行为、零 DDL、零依赖、`docs/data/schema.sql` 与 `deploy/migrations/` 一字节未动。**

**验收**：根 **1388 / 1384 / 0 / 4 rc=0**（与基点逐位相同）、前端 **37 文件 / 661 通过 rc=0**（基线 36/655 ⇒ +1 文件 +6 用例）、`typecheck` rc=0、PR #345 质量门禁 pass（镜像构建校验在 PR 上 skipping，只在 main 跑）。

**主 agent 亲跑变异 3 条（不采信 worker 自报）**：① 删掉前端 `_` ⇒ **3 条具名红**；② **反向的牙**：给 `validateSessionCwd` 插一条字符集白名单（模拟「将来有人反过来收紧后端」）⇒ **防漂移锁红**，消息逐字「后端对目录名新增了字符集校验」；③ 把「会用作预览域名 DNS label」塞回中文 label ⇒ **文案断言红**。⚠ **第一次变异 ① 是空操作**（sed 模式写错 ⇒ 文件零改动、87 条全绿差点被当成证据），靠「先 `git diff` 自证真改了」抓回来（§8.24 同族，第 N 次发作）。

**已知边界（刻意不做，别当 bug）**：前端仍比后端严——**后端宽得远不止 `_`**（实测还收大写 `Bad_Name`、空格 `My Project`、`中文目录`、前导/尾随 `-`、80 字符长度）。本单只对齐 `_`；「要不要让前端也照 `validateSessionCwd` 放开（代价：UI 能建出 `中文目录`）」是另一个决策，未拍。存量口径由文案兜住：**已有目录永远走目录下拉，不受表单规则约束**。

### 8.45 读侧折叠解 `partOf` 链（引擎写侧链式的站内**临时闸**）+ 会话账本巡检手册（issue #341，2026-10-23，直推 main `c47a692`）

**上游缺陷**（已提 [erix-agent #415](https://github.com/ErixWong/erix-agent/issues/415)，主 agent 在**发布物** 0.23.0 上现跑复现）：写侧 `src/loop/orchestrator.js:3394 / :3396` 每落一片就 `toolResultRowKey = persistedRowKey`（**覆盖**）⇒ 第 3 个并行工具调用起 `partOf` 指向**前一片**（链式 `msg:1:3 → msg:1:2 → msg:1:1`）；而读侧 `src/store/message-rows.js:129-143` 的 `parts` 表**只登记非分片行的 key**（分片行在 `parts.set` 之前就 `continue`）⇒ 链上第 2 跳查不到目标 ⇒ **一轮并行 ≥3 个工具调用**之后任何 resume 都会把一条聚合 `tool_result` 劈成多条 user 消息 ⇒ `validateMessages` 抛 `invalid_messages`，**会话永久卡死**（`retryable:false`、零请求出网）。实测对照：链式 ⇒ 折出 2 条 user 消息 ⇒ 抛 `Invalid message at index 1: tool_result ids do not match assistant tool_use ids`；恒指首片 ⇒ 1 条 ⇒ 通过。触发面 **≥3**（≤2 时链式恰好等于首片式 ⇒ 上游测试没抓到，也是它没被发现的原因）。

**我（主 agent）写错、被 worker 实测推翻的一条（台账按这条改）**：站内 #341 正文与我给工单的前提都写着「本站折叠同样中招 ⇒ 刷新后工具卡片掉 `resultPreview`」——**不成立**。原因：上游 `src/display/projection.js:444` 的 `toolResultsOf(messages)` **扫整条 record 的全部 messages** 并按 `tool_use_id` 建 Map ⇒ 被劈出去那条 user 消息里的结果照样配得上对；纯 `tool_result` 消息 `textOf()` 是空串 ⇒ 也不多冒气泡。**主 agent 独立复核结果**：形状差是真的（同一夹具：撤闸折出 `[assistant, [t1,t2], [t3]]` 3 条，解链后 `[assistant, [t1,t2,t3]]` 2 条），机制也是真的（源码级全扫），但**「DTO 逐字节相同」这一半我只复现到「形状差 + 机制」，没独立复现 DTO 对比**（我自己的夹具产不出非空 DTO）。⇒ 口径：**界面无可见差异，真实伤害在引擎 resume**；`session-view-fold.test.js` 那条贯通用例同时断两件事，**撤闸时红只由「折回 1 条聚合」触发**，别拿卡片那一半当解链证据。

**载荷（产品码只有 1 行）**：`portal/src/transcript-fold.js#planFold` 分片分支 `continue` **之前**加 `if (key !== '') parts.set(key, partTargetIndex);`（分片行也登记、指向它被接进去的那个同一消息下标 ⇒ 链自然解回链头，与上游 #415 建议的读侧修法同形）。判据谓词（`isFoldableMessageRow` / `isRoundCarrier` / 「每轮取行序第一个载体」/「`partOf` 只在单消息行上当分片」）**一字未动**；无链账本输出逐字节不变。
**这是闸、不是设计**：文件头写明「上游 #415 落地并升 pin 后本段整体可撤」（先例 §8.28 撤 #283 计时闸、§8.9 撤 `tree` 根标签收口），并钉了**源码级哨兵**用例（读 `node_modules/erix-agent/src/store/message-rows.js`，断上游分片分支仍无 `parts.set`、且整个 `foldMessageRows` 里 `parts.set` 恰好一处）。⚠ **哨兵红了不是回归，是提示撤闸**。

**引擎 resume 这条路本站修不了**（引擎自己调 `foldLedgerMessages`）⇒ 中招的会话只能**修数据**。新增 `docs/ops/transcript-ledger-inspection.md`（已在 `docs/README.md` 登记）：巡检 SQL（「`partOf` 指向的行本身也带 `partOf`」计数，期望 **0**）+ 会话/轮定位 + 单轮形状自检 + **递归解链到链头**的幂等可重放 UPDATE + 备份/预演/复验/回滚 + 「别做的事」。dev 现网现状：**0 行链式** ⇒ 本单性质是**隐患收口**，不是正在流血的故障。

**验收（主 agent 亲手复跑，不采信 worker 自报）**：根 **1393 / 1389 通过 / 0 失败 / 4 跳过 rc=0**（基线 1388/1384/4 ⇒ **+5**：`transcript-fold.test.js` +4、`session-view-fold.test.js` +1）、runner **323/323**、前端 **37 文件 / 661 不变**（前端零字节）；`portal/src/**` 只有 `transcript-fold.js` 一个文件；零 DDL、零依赖、两份 lockfile 与 `docs/data/schema.sql`、`deploy/migrations/` 一字节未动。
**亲跑变异 2 条**（每条先自证锚点唯一匹配，不做空操作）：① 撤掉解链那一行 ⇒ **3 条具名红**；② **反向验哨兵**：在 `node_modules` 的上游真件里模拟 #415 已修（分片分支加 `parts.set`）⇒ **只有哨兵那 1 条红**（跑完已还原 `node_modules`）⇒ 「上游修好就提示撤闸」真有牙。

**剩余（`#341` 保持 open）**：引擎 resume 侧仍待 erix-agent 发版升 pin，或按手册修数据；本站**不做**「检测到链式就告警」的运行时探针（没有消费者，先靠巡检 SQL）。

### 8.46 消息时间戳 + 会话页动量状态条（#282）与预览票据一键批量签发（#247 / #286）（2026-10-23，随 **v0.1.27** 发布）

**三个 issue 一张单，全部零后端行为变更（除新增一个只读型端点）/ 零 DDL / 零依赖 / 不动 `runner/`** ⇒ 本版**故意不重建 FDE 容器**（§8.19 先例）。分支：`f65786a`（#282）+ `4d7aa40`（#247+#286），两者都在独立 worktree 里写、主 agent cherry-pick 进 main（`git status` 干净、两份 lockfile 零变动）。

**#282 = 决策者选的方案 B（两块都做，不许只做一块）**
- **A 消息级时刻**：数据源是对话流 DTO 已有的 `created_at`（`session-view.js` 早已下发，**零后端改动**）；新 `lib/messageTime.ts` **只认「非空字符串」**这一种形状，数字/对象/`Date`/脏串/脏 locale 一律回 `''` ⇒ **宁可不显示，不显示 `Invalid Date`/`NaN`/猜出来的时间**（`new Date(1700000000000)` 是**可解析**的，所以「空值守卫」这条是真判据，用例里明说是变异哨兵）。渲染 `<time class="msg-time">`，用户与助手消息都算。
- **B 顶部常驻状态条**：新 `RunStatusBar.vue`（挂 `WorkbenchView` 的滚动容器**上方**、不在 `StreamPanel` 渲染循环内）+ 分层 `lib/runMomentum.ts`（**纯计算**，可单测）/ `composables/useRunMomentum.ts`（状态机 + 1s 时钟 + 自注册 `onUnmounted` 清定时器）/ 事件入口用 `useEventStream` 新增的**只读旁路** `onEvent(type, d, history)`（在 `switch` **之前**通知 ⇒ `usage`/`round_end` 这类「接收但不展示」的类型也能被看到；不参与既有分支、不改载荷）。
- **三条「不许伪装」的口径（本单最值钱的部分，都有用例）**：① **`~` tok/s 是前端滑窗估算**（界面带 `~` + tooltip 双语说明是估算；样本跨度 < 1s 或字符无增量 ⇒ **不出数**）；② `usage` 事件载荷是**单次 provider 调用**用量（`orchestrator.js` 每轮 emit），**不当 run 累计 tokens 显示**，只用它推进「最后活动时刻」；终态**没带 usage 就不显示 token 数字**（`?? 0` 会把「不知道」渲染成「0 tokens」= #283 同一族）；③ **起跑时刻未知不出时长**——`applyServerRunState` 只给 run id 时 `beginRun(id, null)`，**不从「我看到它」那一刻假装 0:00**（页面中途打开/刷新都会命中这条）。
- **硬刷新边界如实交代**：`run_end` / `usage` 不在 `HISTORY_REPLAY_TYPES` ⇒ 刷新后运行态数字拿不回来，状态条回落成「空闲」，边界写进 tooltip 与 composable 头注，**没有拿历史帧假装在跑**（`history=true` 的帧一律短路，有用例）。
- **冻结判据**：最后一次流式/工具事件距今 > `RUN_FROZEN_THRESHOLD_MS`（5s，单一常量）⇒ 标黄 +「上游已 Xs 无输出」；**恰好 5s 不冻结**（边界有用例）。

**#247 = `POST /api/me/ports/batch-tickets`（一次请求签 N 张票 + 前端一键开 N 个标签）**
- **命名与理由**：`batch-tickets` 走 kebab-case，与本仓既有路径同风格（`:batch` 那种冒号风格本仓零先例）。
- **上限 = `PREVIEW_PORT_COUNT`**（从 `previewpool.js` 取，与号池块大小同源，**不写死 10**）；越界（不存在 / 已 released / **别人的**）三种**回同一句 `404 not_found`**（否则就成了存在性探针）；`admin` 无工位 / 尚未分段 ⇒ **`201 {"items": []}`**（与 `GET /api/me/ports` 的「空列表不是 404」同口径）。
- **原子性 = 对外「要么全成、要么报错」，但不是靠大事务**：每张票本就是独立 INSERT、读者逐张独立消费，包进一个事务不更原子只白占连接 ⇒ 实现是「**先全量预检（在任何签发之前）→ 逐张签发 → 失败补偿**」，补偿用一条 `UPDATE … state='revoked' WHERE token_hash = ANY(...)` 收回本批已签的票再抛错 ⇒ **既不返回半截 `items`，库里也不留 60 秒内还能换 cookie 的残票**。
- **限流按放大倍数计**：`check` 一次 + **逐张** `recordFailure`（一次点击 = N 张票，必须计入 `20/60s`，否则批量端点成了配额的旁路）。
- ⚠ **一处实证推翻工单**（worker 查出、主 agent 复核确认）：工单写「审计与单据端点同 action/details 形状，先读现写法照抄」——**单据端点 `POST /api/ports/:id/preview-ticket` 目前写零行审计**（`http.js` 全文 `INSERT INTO audit_log` 0 命中，签发路径 `auth.audit` 也只有批量这一处；全仓 5 个文件写审计，无签发）。⇒ **没有可照抄的现写法**，本单是**新增**这条审计（逐张各一行，`details` 只放 `token_hash_prefix`，**绝不入 ticket 明文、绝不入带票的 `url`**，同 forward-auth 的 `pathOnly` 纪律）；**单据端点故意不动**（`preview.js#issuePreviewTicket` 一字未改 ⇒ 签发口径仍只有一份，红线守住）。
- **前端**：`usePreviewPorts` 加批量签发 + **弹窗拦截兜底**（浏览器拦了 ⇒ 收回已开标签并给 N 条可点兜底链接，`batchBlockedUrls`）；**挂载与展开都不预取票据**（#246 那条「折叠也拉列表、但 ticket 绝不预取」语义逐字保持，有「请求数 = 0」用例）。

**#286 = 只做面向人的告知**（评审否掉了「改边缘剥 Cookie」的两条路，理由记进 `docs/design/principles.md` 的**被否决方案表**：只剥平台 cookie = 把信任边界从 fail-closed 翻成 fail-open；票据塞 header = 顶层导航/子资源设不了自定义头，而预览第一跳就是顶层导航）。落点：容器内 `~/AGENTS.md` 第 7 条**早已存在且已有防漂移锚点**（决策者在 #262 定的稿，本单复核未改措辞）+ **工作台预览端口面板说明区**（双语，面向人）。⇒ **#286 按 `not_planned` 关单**，不是「修了」。

**基线（主 agent 在合并树亲手复跑，判绿 = 退出码）**：根 `npm test` **1401 / 1397 通过 / 0 失败 / 4 跳过 rc=0**（基点 1393/1389 ⇒ **#247 后端 +8**，全在既有 `portal/test/preview-ports.test.js`）；`node --test runner/test/*.test.js` **323/323 rc=0 不变**；前端 `npm run typecheck` rc=0 + `timeout 300 npm test` **42 文件 / 731 通过 rc=0**（基点 37/661 ⇒ **#282 +53 条 / +5 文件**、**#247 +17 条 / +0 文件**）。

**主 agent 亲跑变异 6 条，全红在具名用例**（每条先 `git diff` 自证不是空操作，不复用 worker 的结论）：① 删掉批量端点的归属判据 `row.fde_id !== session.user.id` ⇒ **恰 1 条红**（跨 FDE 那条）；② 失败补偿的 `if (issued.length > 0)` 改永假 ⇒ **恰 1 条红**（残票那条）；③ `formatMessageTime` 的空值守卫退化成只判 `''`/`null`/`undefined` ⇒ **恰 1 条红**且用例名逐字是「非字符串形状不猜（DTO 契约是字符串）—— 空值分支的变异哨兵」；④ `tokensPerSec` 不再区分运行态 ⇒ **恰 1 条红**（「终态残留的滑窗值会误导成『还在跑』」）；⑤ 冻结判据 `frozen` 写死 `false` ⇒ **2 条红**（纯函数层 + 渲染层各一条，症状可区分）；⑥ `clearInterval` 注释掉 ⇒ **恰 1 条红**（「卸载清定时器：mount 后有 interval，unmount 后一个都不剩」）。

**真机验收（v0.1.27，dev 栈，主 agent 亲手；发布物上跑，bundle 先断言 = `index-BHXYJf-N.js`，不是 v0.1.26 那个 `index-CZEDYy1L.js`）**
- **#282 状态条（会话 `ec8a77b3…`，两条真 run）**：运行态 `● running · round 3 · this run 00:01 · 1 tool calls` 且心跳 `animate-pulse` 在；`sleep 6` 期间**转黄并出**`· no upstream output for 5s`（脉冲同时停）⇒「命令在跑但没输出」与「卡死」第一次可区分，这正是 #282/#285 原始诉求；工具均值 `1 tool calls (avg 6.0s)`（真值 6s）；终态 `idle · last run 00:09 · ↑ 10 B · tokens ↑14509 ↓190`（**usage 真值**）；第二条 80 条要点的 run 出 `↑ 3.8 KB · ~101 tok/s`（**带 `~`**）；
- **硬刷新边界按口径落地**：刷新后状态条只剩 `● idle`、**分段数 = 0**、整页 `00:00` 计数 = 0、`undefined`/`NaN`/`Invalid Date`/`[object Object]` 全 0 ⇒ 「刷新后运行态数字拿不回来」是**空着**而不是编一个 0；同屏 `.msg-time` **仍在（6 条）**（时刻来自 DTO `created_at`，属历史面，本来就该保留）；会话 `1ead0b1a…` 上 20 条消息的时刻逐条真实（`10:52:02` / `13:35:43`…）。
- **#247 一键开（同屏侧栏面板）**：挂载 + 展开后 `batch-tickets` **请求数 = 0**（#246「ticket 绝不预取」语义在真机上成立）；点「Open all previews」⇒ **一次 POST** + **真的开出 10 个标签**（`eric-p-22000 … 22009`）；抽查其中一个 = **`502 Bad Gateway`**（不是 403 `preview_ticket_required`）⇒ 10 张票**逐张有效**、只是没人监听；`preview-cookie-notice`（#286 面向人的告知）在面板内可见。
- **API 面四条**（`--noproxy` + `Host`/`Origin` 都带 `:8090`）：① 签 3 张 ⇒ `201`、`items` 3 条、键 `{id,port,url,ticket,expires_at}`、`url` 已带 `?preview_ticket=`、整批**同一** `expires_at`；② 11 个 id ⇒ `400 validation_failed` + `details.field='allocation_ids'` + 文案点名上限 10（取自 `PREVIEW_PORT_COUNT`）；③ 拿**真实属于别的 FDE** 的 allocation ⇒ `404 not_found`（与「不存在」同一句）且**那次没签出任何票**（库里该 allocation 2 分钟内 active 票数 = 0）；④ 审计**逐张 3 行** `auth.preview_ticket_issued`，`details` 只有 `token_hash_prefix`（12 位哈希前缀）+ `port`/`allocation_id`/`expires_at`，**无 ticket 明文、无 `url`**。
- **dev 残渣（故意留）**：会话 `ec8a77b3…` 多两条探针 run（`sleep 6` + 80 条要点，用量真实）；`1ead0b1a…` 多一条**失败** run —— `invalid_messages`（index 50，`retryable:false`，0.3s 即终态）：它是当年 #283/#300 的标本会话，账本形状早就砖化（今天 04:53/04:55 两次同样的失败**早于本次部署**）⇒ **不是 v0.1.27 的回归**，正是 #341「引擎 resume 侧站内修不了」的现成现场；浏览器里留着 10 个预览标签（502 页面，dev 容器重启即清）。

**过程账（我这一手的两次操作失误，代价 = 一次 7 分钟空转）**：把「写工单/脚本文件」和「派工调用」放进**同一条消息**，工具并行执行 ⇒ 派工时脚本还不存在，`#282` 那一次实际重跑了 `#341` 的 worktree（无产出、无分支），`#247` 那次根本没起来。另一条：workflow 脚本里 `const a = await runs.run(...)` 的 `await` 会**等子跑完**，所以两条派工变成串行（并行要用 `runs.all([...])`）。**口径：派工脚本与工单必须先落盘、在下一条消息里再派；要并行就 `runs.all`，别靠「去掉中间 await」猜。**

### 8.47 终止文案可见性（母语标签 + 刷新后终态分隔条从 run 终态投影）与空 body POST 的 `Content-Type`（issue #236 第 1、2 条，2026-10-24，`fix-261023-06-236-termination-visibility`）

工单 `feat-261023-06-236`（只做 #236 的**第 1、2 条**；第 3 条「每 run 成本护栏」另单）。基点 main `e791abb`。

**第 1 条 (a)：`aborted` 等 reason 没有母语标签。** 现状核实 = **标签不存在**（不是「有标签没接上」）：`EXPLAINED_FAIL_REASONS` 只有 `persistence_failed` / `final_guard_unverified` 两项，`i18n/locales/*.ts` 的 `stream.event.runEndReason` 也只有这两个键（`terminationReasons.spec.ts:74` 钉着键集相等）。
- **#212「既有 failed / aborted / max_rounds_cap 逐字保持原样」作废**（逐字原文见 `useEventStream.ts#failReasonText` 头注与 `git show b5e46cc`）：那条口径的理由只是「不改既有中文基线与既有断言面」，而 #236 的验收面是「用户按停止后看到的是母语文案，不是裸 `aborted`」；且本单把终态分隔条投影进历史后**任何** reason 都会上屏（含最常见的 `judge_done`）⇒ 只补 `aborted` 等于把「裸英文枚举」从一处搬到另一处。**新口径**：`RUN_END_LABEL_REASONS` = 引擎 reason 全集 **减 `end_turn`**（它走既有 `runEndNormal`），9 个键双语成对；**未知 reason 不在表里 ⇒ 回落 reason 原文**（§5.3，不编造翻译）。文案形状与 #212 一致：`<reason> — <标签>`（reason 原文保留作技术前缀，与 `errorCode` 同一种「技术细节留在行上」的口径）。
- **呈现分级改判 `aborted` 为中性**（`RUN_TERMINATION_SYSERR_REASONS` = `RUN_FAIL_REASONS` **减 `aborted`**，由后者派生、不手抄）：用户按「停止」不是故障。#236 原文「`failed` 类仍走 `.syserr` 红色」⇒ `failed` / `max_rounds_cap` / `persistence_failed` / `final_guard_unverified` **仍然红，没有把红色降级成中性**（§8.7 的判据不变）。`RUN_FAIL_REASONS` 本体**一字未动**——它仍决定「重试上一条」（#261B）与「终态后补拉 history」（#306），`aborted` 仍在其内（那两个面把停止算非正常收尾是对的）。**实时 `run_end` 与历史合成项共用 `runEndLine` 一个函数**（同文案同分级，否则刷新一次颜色就变）。

**第 1 条 (b)：刷新后终态分隔条消失。** 根因 = `run_end` 不在历史下发白名单（`HISTORY_EVENT_TYPES` / `HISTORY_REPLAY_TYPES`），分隔条只在实时 SSE 出现过一次（#217 只对账**活跃** run，不覆盖终态回放）。**红线照旧：`run_end` 不塞进任何一个白名单集合。** 修法 = 照 #300 的先例**从 run 终态字段投影**：
- 后端 `portal/src/http.js`：合成项 **`type = 'run_termination'`**（新名字，故意不叫 `run_end`），只在 `GET /api/sessions/:id/events/history` 的**响应期**存在（不落库、不进 SSE、不进 `HISTORY_EVENT_TYPES`）。判据三条：① run 在本次窗口里；② `status IN ('finished','failed')`（`queued`/`running`/`cancelling` 一律不合成）；③ `termination.reason` 非空字符串（脏载荷不合成，**绝不拿 status 编一个 reason**）。`seq` = 该 run 在 `run_events` 里的**最大 seq**（`run_end` 行本来就在表里 ⇒ 天然排在该 run 内容之后；整 run 口径、不受 `before` 限制、**不新分配**）。`payload = {status, termination}`（termination 原样透传，字符串叶值截 2000）。
- **成本红线**：`findPartialCandidateRunIds` 升级为 `loadWindowRuns`（同一条 SQL 多取 `status`/`termination`/`MAX(seq)`），**一条查询同时服务 #300 的候选判定与本单的终态投影** ⇒ 窗口无 run 时**一条查询都不发**，有 run 时**也只有那一条**（用例钉「恰好 1 条」）。
- 前端 `stores/workbench.ts`：在 `openSession` 归并循环里**于 `replayEvent` 之前**分流（与 #300 的 `partial_output` 同一种接法）；**幂等键 = `termination:<run_id>`** 走 `renderedIds`。实时 `run_end` 渲染后 `onCurrentRunEnd` 立刻登记同一 id ⇒ 同一视图里「实时一条 + 历史一条」不会发生（`#306` 那条补拉现在**同时喂** `partial_output` 与 `run_termination`，**零新增请求**——这就是与 #336 的关系）；硬刷新后 `renderedIds` 重建 ⇒ 历史项正常渲染。`applyServerRunState` 的通用「连接中断期间该 run 已结束」提示在历史已给出具体 reason 时**不再叠一条**。
- **合成项不带 `usage`**（实时那条的 `· tokens a+b` 后缀在历史里不重建，与 #282「刷新后运行态数字拿不回来」同一口径）。

**第 2 条：空 body 的 POST 强制 `Content-Type`。** `requireJson`（所有 JSON 写端点的统一闸，40+ 调用点）新增一格：**没有 `Content-Type` 头 且 请求确定无 body**（`Content-Length: 0`，或既无 CL 也无 `Transfer-Encoding`）⇒ 放行（体按 `{}`）。其余逐格不变：有 body 没声明 / 声明非 json / 无 body 但显式声明非 json ⇒ 仍 400；chunked 且未声明 ⇒ 400（体不可知，fail-closed）。契约落 `portal.md` §1.5（新增）。⚠ #234 的 Origin 同源门在它之前，语义零改动。

**测试（并入既有文件，零新建）**：根 `npm test` **1413 项 / 1409 通过 / 0 失败 / 4 跳过**（基线 1401；净 +12 = `session-events-history.test.js` +9：终态投影逐字段 / 非终态三态各一条 / 脏 termination 四形态 / 一条 run 至多一条 + 跨 run 不串号 / 库里伪造 `run_termination` 行也不下发（红线）/ 成本红线两条 / 不占 limit 与 next_cursor；`session-http.test.js` +3：空 body 无 CT 不再 400 / 同端点五种组合逐条 / 统一闸对 `ai-title` 同样生效且 GET 不受影响）。`node --test runner/test/*.test.js` **323/323**（runner 零字节）。前端 `npm run typecheck` 干净、`npm test` **42 文件 / 740 通过**（基线 731；净 +9 = `workbench.spec` +6 / `useEventStream.spec` +2 / `terminationReasons.spec` +1）。`portal/test/session-partial-output.test.js` 的 fake 升级为**同一条 SQL 返回新列**（status/termination/last_seq 真算），`realsOf` 把两个合成类型都排除——#300 的 17 条判据一条未放宽。

**变异（worker 亲跑 9 条，每条先 `diff` 自证非空操作）**：M1 成本红线早退挪到查询之后 ⇒ 恰 1 条具名红（成本红线那条）；M2 删 SQL 的 `status IN (...)` ⇒ 4 红（非终态三态 + 成本红线）；M3 删 `reason === ''` 守卫 ⇒ 恰 1 红（脏载荷）；M4 把 `run_end` 塞进 `HISTORY_EVENT_TYPES` ⇒ 6 红（白名单三条既有 + #236 两条 + #300 一条）；M5 `markRunTerminationRendered` 空实现 ⇒ 恰 1 红（实时+历史不重复）；M6 分级退回 `RUN_FAIL_REASONS` ⇒ 7 红（含 `aborted` 中性那条）；M7 摘掉 store 的历史分流分支 ⇒ 3 红（aborted 中性 / failed 红 / 幂等）；M8 撤掉 CT 放宽那一行 ⇒ 2 红；M9 从标签表删 `aborted` ⇒ 4 红。⚠ **M9 第一版写错并已重做**：锚点文本同时出现在 `TERMINATION_REASONS` 与 `RUN_END_LABEL_REASONS` 里，`replace(...,1)` 命中了**前者** ⇒ 红的却是「引擎取值面逐项在册」这类无关用例；改成按 `export const RUN_END_LABEL_REASONS = [` 切块后再删，才红在标签/文案用例上（**红了也要证明红来自你以为的那处改动**）。

**已知边界 / 我没做什么**：① 历史合成项只在「该 run 真落在本次响应窗口里」的那一页出现（同 #300 的窗口口径）；② 不带 `usage`（同上）；③ 前端只拉一页 history（无分页 UI），所以「一条 run 至多一条」的排序在单页内成立即可；④ **真机 e2e 未跑**（本单只 commit，不 push/不部署）：`curl -X POST .../stop`（无 body 无 CT）与「重开 aborted 会话看到中性『已中止』」两条验收面在真机上由主 agent 复验；⑤ 未动 #236 第 3 条（每 run 成本护栏）；⑥ 未改 `runner/`、`docs/data/schema.sql`、`deploy/migrations/`、任何 lockfile 与依赖。


**主 agent 验收与合并补记（2026-10-24，PR #347 合并为 `135ddf6`）**

- **合并树三套复跑（判绿 = 退出码）**：根 **1414 / 1410 通过 / 0 失败 / 4 跳过 rc=0**、runner **323/323**、前端 `npm run typecheck` rc=0 + `timeout 600 npm test` **42 文件 / 741 通过 rc=0**。计数比上表 +1/+1 来自下面那条补测。
- **主 agent 亲跑 4 条不重叠变异，其中 2 条不红 ⇒ 判为真覆盖缺口并当场补测（`fcf0c4d`）**：① `seq` 钉成固定 0 ⇒ 3 条具名红；② 合成载荷少 `status` ⇒ 恰 1 条红；③ `requestHasNoBody` 改成永真（= 完全不做形状判定）⇒ **全绿**；④ 把 `RUN_TERMINATION_SYSERR_REASONS` 换成内容等价的**手抄**枚举 ⇒ **全绿**。③ 的原因：`fetch` 永远自动带 `Content-Length`，worker 那条组合用例的「chunked」夹具实际走的是 CL 分支（`Transfer-Encoding` 只是被塞进 map，没走判据）⇒ **chunked 分支零覆盖**；④ 的原因：既有断言只比**内容等价**、不比**派生写法**。补的两条用例：手工 `node:http` 请求（`Transfer-Encoding: chunked` + 有 body + 无 CT 必须仍 400）+ 源码级「定义必须引用 `RUN_FAIL_REASONS` 与 `USER_STOP_TERMINATION_REASON` 且体内不含任何 reason 字面量」。补完**重放同一变异 ⇒ 各恰 1 条红在新用例上**（§8.24 口径：没红先证明变异不是空操作）。
- ⚠ **我自己被 CI 抓了一次（代价 = 一次 CI 红 + 一次重推）**：补测用例里 `def[0]` 在 `strict` 下报 **TS18047 'def' is possibly 'null'** —— `expect(def).not.toBeNull()` **不是类型守卫**，vue-tsc 不因此收窄（改 `if (!def) throw` 既收窄又保留同样的失败文案）。根因是我复跑时**只跑了 root test 与前端 vitest，漏跑 `npm run typecheck`**。口径：合并树复跑是**四件套**（root / runner / 前端 test / **typecheck**），少一件就可能「本地全绿、CI 步骤④ 红」。
- **真机验收（§8.34 路线 A：`docker build -f portal/Dockerfile` 顶掉 digest pin，验完还原 `.env` 并 `up -d`、临时镜像 `docker rmi` 删除）**。bundle 断言先行：页面实际加载 `assets/index-Zms29SHi.js`，与部署中 v0.1.27 的 `index-BHXYJf-N.js` 不同名 ⇒ 测的确实是本 PR 的代码。
  ⚠ **§8.42 那条口径今天又默了一次，而且是新的成因**：不是浏览器缓存，而是**我自己验完就还原了 `.env`** —— 随后为了 #278 另开一轮观测时，页面已在跑 v0.1.27，却把「实时终态条红色且无母语标签」当成了 #236 的回归（实际它是修复前的正确行为）。口径：**还原 pin 之后的任何观测都是旧版本**，下一轮验收开头就必须重断 bundle，别拿上一轮的镜像记忆当现状。
  - **#236-2**：`POST /api/sessions/<id>/stop` **无 body 无 Content-Type** ⇒ **200**（`{"run":{"id":"58ffb56a…","status":"finished"}}`，修复前是 400 `Content-Type 必须为 application/json`）；**反面**同端点带 body `-d '{}'` 不带 CT ⇒ **仍 400**（放宽没过头）。
  - **API 面**：会话 `ec8a77b3…` 返回 **4 条 `run_termination`**、`run_end` 下发数 **0**（红线：`run_end` 没进 `HISTORY_EVENT_TYPES`/`HISTORY_REPLAY_TYPES`）、`seq` 全序升序、payload 键集恰为 `{status, termination}`、一条 run 一条。
  - **界面面（zh-CN）**：中性条 `.roundsep` computed style `color rgba(0,0,0,.55)`、无背景无边框，文案逐字 `run 结束：aborted — 已中止` / `run 结束：judge_done — 评审判定完成`；红色条 `.syserr` `color rgb(220,53,69)`，文案 `run 结束：failed — 运行失败（code=invalid_messages）`（`errorCode` 照旧透出，红色集合没降级）。整页 `undefined`/`[object Object]`/`NaN`/`Invalid Date` 计数全 0。
  - **实时 + 历史不重复（本案最难验的一条）**：在页面上发一条消息（状态条同屏实时给出 `运行中 · round 7 · 本 run 00:08 · 工具 2 次 · 上游已 6s 无输出`，顺带证明 #282 正常），点「■ 停止」⇒ 分隔条 4 → **5**，新那条带 usage 后缀 `已中止 · tokens 9020+169`；**硬刷新后仍恰好 5 条**（不是 6 条 ⇒ 幂等键 `<runId>:final:run_termination` 有效），且后缀按声明不重建（历史不带 usage）。截图 `/docker/erix_station_playwright/v0347-236-separators.png`。
  - ⚠ **一条比 worker 边界表更具体的新边界（判据①的必然结果，不修）**：**「起跑前被取消」的 run 重开会话时没有分隔条**。标本 `58ffb56a…`（#277 验收造的 `cancelled_before_start`）在 `run_events` 里**只有 1 行 `run_end`**（#277 合成的那条），而 `run_end` 不在历史白名单 ⇒ 该 run 在响应窗口里**零可见行** ⇒ 判据①「该 run 出现在本次窗口里」不满足。已用 SQL + 该会话 history 的 run 分布双向确认（history 里 30 行全属 `9bde380a`）。影响面：那条 run `rounds=0` 且无正文，界面上只留用户消息（与 #346 是同一族观感）。
- **呈现改判需要决策者过目**（PR 正文已显式标注，这里再记一次）：`aborted` 的**实时**呈现从红色 `.syserr` 改成中性 `roundsep`（判据 = 「是否用户自己按了停止」，单一常量 `USER_STOP_TERMINATION_REASON`）。依据是 #236 正文那句「用户主动停止是常规操作，不该与真故障同色」，且 #236-1 让所有 reason 都上屏后，旧 #212「保持红色不变」那句已被本单作废。**其余红色成员一字未改**。
- **未发版**：本单已进 main，但 v0.1.27 部署面**不含**它；下次发版才带上（试用栈那条路上「刷新后分隔条消失」仍会复现，别当回归）。
### 8.48 v0.1.28 发版 + 夜班三车道（#273 / #295 / #256）与「派工 → 独立评审 → 返修」闭环（2026-10-24 夜班，无人值守）

**决策者睡觉期间自主推进**：发版 v0.1.28 → 收 stale issue（#302/#303/#331 取证后处置）→ 三车道派工（worktree 隔离）→ 三名 fresh-context reviewer 独立评审 → 按评审返修（文档我自己改、代码/测试另派三车道）。

#### 发版 v0.1.28（纯前端载荷 ⇒ 只 pin portal + proxy）

载荷 = `#347`（issue #236 第 1、2 条，§8.47）+ `#345`（#284）。`git diff --name-only v0.1.27..HEAD -- runner/` 去掉 package 文件后**为空** ⇒ `FDE_IMAGE` 故意仍 pin v0.1.25 摘要、**五台 FDE 容器未重建**（§8.19 先例）。流程：版本 bump `8c7906d`（六文件、9 增 9 删）→ **先等 main CI 两个 job 全绿再打 tag**（§8.32 纠偏第二次遵守）→ release run `40000640087` → 清单 `imageId` 与部署机 `docker image inspect .Id` 逐个一致（portal `4ce2a7db…` / proxy `3b44b32f…`）→ `.env` 形态① pin（备份 `/tmp/deploy.env.bak-0128`）→ `up -d --no-build` → `healthz=200`、服务 bundle = **`index-Zms29SHi.js`**（与 PR #347 的构建逐字同名 = 内容一致性旁证）。

**#236 在发布物上把两条支路都验完**（此前只验过本地构建镜像 + 中性支路）：会话 `ec8a77b3…` **恰好 5 条** run 结束分隔条（3 `judge_done` + 2 `aborted`），computed color 全为中性 `rgba(0, 0, 0, 0.55)`、祖先无 `.syserr`、**硬刷新后仍是 5 条**；红色支路用标本会话 `1ead0b1a…`（`failed` = `invalid_messages` 砖化账本）⇒ 10 条里 **3 条红** `rgb(220, 53, 69)` 且带 `code=invalid_messages`，另 7 条中性，整页无 `undefined`/`[object Object]`/`NaN`。中英双语标签都逐字读过。

#### 三车道派工（`worktree: true`，各 30 分钟硬顶）与逐笔 cherry-pick

| issue | 交付 | 落地 | 关键取证 |
|---|---|---|---|
| **#273** 工作区 setgid 假话（文档承诺 `2770`、真机 `0770`） | 决策 = **C：改口 `0770`，不加 `CAP_FSETID`**；新 `portal/test/userspace-dir-mode-doc.test.js` | `e274d49`（patch-id SAME）+ 我的返修 `87e4365` | worker **推翻我给的两条前提**（① 清 setgid 的不是 `chown` 是**缺 `CAP_FSETID` 时的 `chmod`**——内核 `chown(2)` 对目录不清；② `umask 0002` 早就设了，`644` 是 `docker exec` 临时 shell 的 `0022`），两条我都独立复现（`CapEff=0xcb`、`0xcb & 0x10 == 0`） |
| **#295** markdown 裸 URL 被 `_` 截断 / 缺左边界 / 邮箱未记录 | 占位符保护 `U+E002`（**不是**把 `_` 处理挪到链接之后——那会吞掉链接文字里的 `**` 并把星号卷进 `href`）+ 左边界 lookbehind + 邮箱定为刻意范围 | `7d1ccce`（SAME） | 30 条既有 golden（含 `[点我](javascript:alert(1))` ⇒ `<p>点我)</p>`）**零改动**；主 agent 跑新旧差分确认「无 URL 输入逐字相同」 |
| **#256** 号池占用总览端点 + 429 带秒数 | `GET /api/admin/preview-ports/usage`（`{pool, occupied_blocks:[{start_block, fde_names[]}], free_blocks:{items,limit,has_more}, summary}`）、审计 `admin.preview_ports_usage_listed` 只计数 | `83e3080`/`d12b714`/`b14bf54`/`41dd2cd`（范围 patch-id SAME） | 占用判据与迁移 `0019` 的部分唯一索引 `WHERE state <> 'released'` **逐字同口径**；**429 只改前端一条路**（`api.ts` 早已把 `Retry-After` 解析成 `ApiError.retryAfter` ⇒ 我工单里那句「可能没秒数」是假问题，worker 否证、评审复核为真） |

⚠ **纪律更新（本轮踩实）**：worker **多笔 commit** 时必须 cherry-pick **整段范围**（`base..branch`），只挑 tip 会因新增文件产生 DU 冲突（#256 实测）。

#### 评审闭环：三名 fresh-context reviewer 各抓到的东西（都值得再来一轮）

- **#273 → 1 blocker**：worker 把**实测混着的 setgid 写成「一致 `0770`」**——正是这单要消灭的那类假话。真机 `/srv/erix/users`：`eric/projects/probe-343`、`blind/projects/r1-app` = **`2770`**，同树 `probe-261014` = `770`，遗留 `home/worktrees` = `2755`（**在 `2770` 父目录里新建会继承 setgid**）。正确口径 = 「portal 每轮 reconcile 的目录 `0770` + 只建一次的 `projects/<p>` 停在 `2770`，同一棵树混着」。另 4 条：§9.1 创建者写错（`projects/<p>` 由 `sessions.js createSession` 建，materializer 的 P5 项目级物化早已退役）、spool 行给既成事实数字（**尚未实现**，口径应随创建者）、`(b)` 缺「所有 FDE 属主写点必须同传 uid+gid」这条**前提**（`ensureDirSafe` 的 `gid` 缺省 `null` ⇒ 只传 uid 会留 `gid=0`，那时 setgid 才真承重）、compose 注释仍写 `2770` 无指路、`docs/env.md` 给一个**不存在的 env** 编了默认值。
- **#295 → 1 major + 2 minor**：全量门红是既有脆弱项（≠ 本单，见 #349）；`URL_LEFT_BOUNDARY` 是**第三份手写字面量**且 `&` 成员**永不生效**（`esc()` 已把 `&` 变 `&amp;` ⇒ lookbehind 看到的是 `;`，注释与实测不符）；左边界带来的行为面**宽于**工单举的四种（`:`/`#`/`~`/`@` 前缀一并挡掉，零用例零注释）；「与 cmark-gfm / linkify-it 同口径」**无出处**。
- **#256 → 0 blocker/major + 5**：`docs/api/portal.md` 示例**内部自相矛盾**（`items` 2 段却与 `free`/`has_more` 对不上）；注释行号错位（真实锚点 = `parseRetryAfter` 与 `new ApiError(...)` 的末位实参）；**fake 是子串前缀匹配 ⇒ 有假绿窗口**；零字面量断言被 `22_000` 逃逸且不覆盖 `http.js` handler；`?limit=` 空串语义未定。

#### 返修（第二波三车道，全部已合并）

- `3edd679`（#295b）：`URL_WORD_SYMBOLS` → `URL_WORD_CHARS` → `URL_LEFT_BOUNDARY` 三层派生（**两个集合不硬并成假单一来源**）；删不可达的 `&` 并把原因写进注释；`: # ~ @ % ? +` 逐前缀用例 + **逐成员遍历**；三处「同 cmark 口径」降级为「按工单口径」。46 个探针跑改前/改后 **diff 逐字节相同**（行为零变更自证）。
- `e66ac16` + `03d5842`（#256b）：fake 从子串匹配改成 **`compileWhere()` 真解析**（原子子句 + 括号 + AND/OR 优先级 + `BETWEEN` 内的 `AND` 不切分，解析不了直接 `throw`）；零字面量改**按数值**判（`22_000` / `0x5618` 都拦）并覆盖 handler；`?limit=` 空串 = 用默认值、`%20` 仍 400（**零新错误码**）；示例按 `?limit=3` 重写做到逐字段可推（800 = 797+2+1）。⚠ worker **反过来纠正了我的工单**：我给的变异形态 `WHERE (A OR B) AND …` 在旧 fake 下也是红的（多个 `(` 让前缀正则失配），**证明不了假绿**；真假绿形态是 `… AND pa.port BETWEEN $1 AND $2 OR pa.state = 'released'`（旧绿 / 新红，双方各自实测）。
- `bd2a32e`（**新登记的 #349**）：`terminationReasons.spec.ts` 在全局 `jsdom` 下裸 `import 'node:fs'` ⇒ 三个 agent 各见 `Error: No such built-in module: node:`（suite 载入失败、0 test 被计）而我主仓**连跑 3 次 + 冷缓存都复现不到**（vitest 版本四处都是 5.0.1，排除了版本差）。worker 走路 B：`import src from './terminationReasons.ts?raw'` 取代 `readFileSync`，**同一份源码文本、断言一字未改**；路 A（docblock 切 node env）**实测被挡**——`useEventStream.ts:18 → ../i18n` 会加载 `src/i18n/index.ts:74` 的顶层 `document` 副作用（我工单里以为该 spec 不经 index，错）。⇒ 修完后这条门第一次是**无条件绿**（不再依赖 vitest 的 transform 缓存状态）。

**主 agent 亲跑的 4 条返修变异（与 worker 不重叠，全红在具名用例）**：删 `URL_WORD_SYMBOLS` 里的 `~` ⇒ 2 红（逐前缀 + 逐成员）；占用判据放宽成永真 `… OR pa.state = 'released'` ⇒ 恰 1 红（新 fake 有牙）；号池起点写死 `22_000` ⇒ 恰 1 红（`#256③`）；把 `?raw` 指向别的文件 ⇒ 恰 1 红（源码层派生锁读的是对的源码）。⚠ 第一次给 `22_000` 那条我的 python 锚点没匹配上 = **空操作**（§8.24 那条纪律第 N 次在自己手上发作——先 `git diff --numstat` 再谈红绿）。

**基线（合并树亲手复跑，判绿 = 退出码）**：根 **1426 / 1422 通过 / 0 失败 / 4 跳过**、runner **323/323**、前端 `typecheck` rc=0 + **42 文件 / 755 通过**。台账三处已同步（`docs/ops/ci-release.md` §1：1414→1426 / 741→755）。

**新登记的 follow-up**：**#349**（已随本批修完）、**#350**（管理台号池占用总览 UI —— #256 只交付端点，人还在试错）。**仍 open**：#341（上游 erix-agent #415 **未发版**，npm 最新就是 0.23.0）、#303（0.23.0 读侧仍有 7 条路径认顶层旧名 ⇒ `?? tr.duration` **不许删**，取证已贴 issue）、#331（`ERIX_SESSION_AUTO_TITLE` 死光纤，撤它要动 portal + 两处测试）、#346 / #348 / #321 残留（需产品决策）。

### 8.49 v0.1.29 发版 + 发布物验收 + 验收过程中挖到的 **#351（会话砖化）**（2026-10-24 02:52 CST，夜班收尾）

**v0.1.29** = `5d967c6`（载荷 = 本批全部：#256 + #295 + #273 + #349 + 台账）。本批 `runner/` 除版本文件外**零差异** ⇒ **只 pin portal + fde-proxy**，五台 FDE 容器故意未重建（§8.19）。流程：`d8d1ee5`（台账 + 基线）→ `5d967c6` bump → main CI `40004642827` 全绿后才打 tag → release `40005238179` → 清单 portal `imageId=2a32a0f4…`/`digest=ea45ec01…`、proxy `imageId=ba408140…`/`digest=56fc03b3…`，两个都**直连一次拉成**且 `docker image inspect .Id` 逐位一致 → `.env` pin（备份 `/tmp/deploy.env.bak-0129`）→ `up -d --no-build` → portal/proxy 实跑镜像 ID = 清单、经 Traefik `healthz=200`、**服务 bundle = `index-BrgEGHCI.js`**（先断言 bundle 再测，§8.42）。

**在发布物上重跑两条用户可见面**（不只信本地测）：
- **#256 占用总览**（admin cookie 会话经 Traefik）：`pool` 22000–29999 / 块 10 / 800 段；`summary` **逐字段自洽 800 = 795 free + 0 partial + 5 occupied**；`occupied_blocks` 5 段带 `fde_names` 数组；`free_blocks` `items=50 limit=50 has_more=true` 与实际一致；审计 `admin.preview_ports_usage_listed` **恰 1 行**；handler 经 `http.js:1405` 委派 `previewPortPoolUsage`；函数体数字字面量只剩注释里的 `0019` 与状态码 `404`。⚠ **我第一条探针把「源码零端口字面量」测到了响应上**（响应里本来就得有段号）⇒ 假阴性；探针对错面比探针本身重要。
- **#295 裸 URL**（新建会话 `5b0292eb…` / `~/projects/probe-351`，让助手原样复述）：带两个 `_` 的裸 URL → **单一** `<a href="…/probe_351_x_2">`全文保留、内部**无 `<em>`**；`[**加粗链接**](…)` → `<strong>` 仍在锚内、`**` 未进 `href`。

#### 🔴 新登记 **#351**：被停止的 run 留下未结清的 `tool_use` ⇒ 同会话再发消息**永久** `invalid_messages`（验收自己撞上的）

验 #295 时先往旧会话 `ec8a77b3…` 发消息，run 直接 `failed`：`invalid message at index 11: assistant tool_use has no immediately following user tool_result`（`retryable:false`，「重试上一条」永远同错）。**两个真机标本同族、子形状不同**（都是今天「停止 → 再发一条」造出来的）：`ec8a77b3…` = index 11，结果行**在**但被下一条 `:input:` **插队**；`1ead0b1a…` = index 50，被停止那次的 `tool_result` **根本没落账本**。

标本 1 真库账本（`append_seq` 升序 = 引擎读取序）：`msg:6:0`（assistant + `tool_use` sleep 240）→ **`input:128b5d39…`（用户下一条）** → `msg:6:1`（迟到的 `tool_result`）→ `engine:round:6:resume`。把**真行**喂进引擎自己的 `foldLedgerMessages`（`0.23.0`，`src/store/message-rows.js:197`）+ `validateMessages`（`src/messages/rounds.js:43`）**逐字复现 index 11**。
**不是 #341**：巡检 SQL（`partOf` 指向的行自身也带 `partOf`）在两个标本会话与**全库**都 **0 行**，标本 1 唯一分片行 `msg:1:2 → msg:1:1` 形状正确 ⇒ `docs/ops/transcript-ledger-inspection.md` **测不到这一类**（手册判「干净」的会话照样砖）。机理也非竞态：停止时结果行不写，等到**下一次 run resume** 才由 `journalResumedToolResults()` 逐条写 `:msg:`；而 `:input:` 是发消息当时写的（#162 顺序红线）⇒ 「停止 → 再发一条」**构造上必现**。issue 里给了三个候选修法（A 终态即结清 / B 发消息前置幂等补结清 / C 引擎按 round 归位）并明说**未拍**，同时要求**存量已砖会话要修数据**。本单**未动代码**。
⚠ 可复用的取证手法：**把真账本行喂进引擎自己的折叠/校验函数**比看错误文案硬得多（两行 `await import` 就能在本地逐字重现一个只在真库上出现的错误）。

### 8.50 管理台「预览号池占用总览」页（issue #350，PR 由主 agent 直推，随 **v0.1.30** 发布）

**为什么值这一张**：#256 只交付了端点（§8.48），管理员给 FDE 改预览端口段仍在试错——挑一段 → 409 → 换一段。本单把 `GET /api/admin/preview-ports/usage` 画成管理台第 4 个 tab。**纯前端**：`portal/src/**`、`runner/`、`docs/`、`deploy/`、两份 lockfile 零字节（worker 交付 9 文件 +1283/−0，我核过非前端文件数 = 0）。

**worker 推翻了我工单里两条契约字段（都独立坐实，不是它一家的说法）**
1. `occupied_blocks[].start_block` **不存在**，真形状 `{start, end, occupied_count, fde_names}`。证据：我今天在 v0.1.29 真机抓的响应键集 = `['end','fde_names','occupied_count','start']` + `docs/api/portal.md` §4.7a。照工单写，被占段那一栏会渲染成 `undefined`。
2. 自洽关系不是 `len(occupied_blocks) ≤ occupied` 而是 **`= partial + occupied`**——`docs/api/portal.md:1289` 逐字写着这句（`occupied_blocks` 数的是**全部**被占段）。真机 `len=5`、`partial=0`、`occupied=5` 两边都成立，但只有等号那条在 `partial>0` 时不报假矛盾。

**两条收窄（主 agent 核可）**：① 「前端零端口字面量」**不可能全域判**——`lib/previewPorts.ts:78-82`（#246 交付②）早就镜像过 `22000/29999/10`，所以判据只覆盖本单新增的两个文件；② 前端**不复制**服务端 `PREVIEW_USAGE_FREE_LIMIT_DEFAULT = 50`：请求不带 query，页面显示的 `limit` 一律取响应值（服务端改默认值时前端不会撒谎）。
**worker 自己补的一条**：`free_blocks.items` 是**截断的** ⇒ 一段「不在占用列表里」**不等于**空闲。`classifyBlock` 因此有第三种取值 `unknown`（页面说「不知道，以服务端校验为准」），否则就是给管理员一个假保证、把人推去撞 409。

**主 agent 亲跑变异 4 条（与 worker 的 6 条不重叠，每条先 `git diff` 自证非空操作）**：`classifyBlock` 把「不在空闲列表」当 free ⇒ 2 条具名红；自洽告警行永不显示 ⇒ 恰 1 条红；错误行丢掉服务端 `message` 原文 ⇒ 2 条红；**给 `FdePreviewPortsPane.onMounted` 加一句 `loadPreviewUsage()`（让它隐式发总览请求）⇒ 36 条全绿** ⇒ 先自证非空操作后定性 **真覆盖缺口**：「本面板不发占用总览请求」只活在注释里。补一条 `判据④：打开改块面板**不会**隐式发占用总览请求` 后重放同一变异 ⇒ **恰 1 条红在新用例上**（§8.24 / §8.41 那条纪律第 N 次发作，每次都抓到东西）。

**基线**：根 **1426 / 1422 通过 / 0 失败 / 4 跳过**、runner **323/323** 不变，前端 `typecheck` rc=0 + **43 文件 / 782 通过**（worker 交付 781 + 主 agent 补的 1 条）。`docs/ops/ci-release.md` §1 步骤 ④ 已同步。

**发版与部署（v0.1.30）**：`491cb9d`（cherry-pick，`patch-id --stable` 与 worker 的 `991ac2a` SAME）→ `50eff39`（补测）→ `e2646c7`（版本 0.1.30，六文件 9 增 9 删）→ main CI `40010571884` **两个 job 全绿**（含三镜像构建校验，这是打 tag 的前置）→ tag `v0.1.30` → release `40011042026` success → 清单 portal `imageId=0602a027…`/`digest=e2103740…`、proxy `imageId=60636b92…`/`digest=275d2494…`，两个都直连一次拉成、`docker image inspect .Id` 逐位一致 → `.env` 形态① pin（只两行；备份 `/tmp/deploy.env.bak-0130`）→ `up -d --no-build` ⇒ portal 实跑 `0602a027…`、经 Traefik `healthz=200`。⚠ **本版 `git diff --name-only v0.1.29..v0.1.30 -- runner/` 只有 `package.json` + lockfile** ⇒ 五台 FDE 容器故意未重建（§8.19）。

**真机验收两轮（路线 A 预验 + 发布物复验；截图 `/docker/erix_station_playwright/station-pr350-pool-usage.png`）**
- **预验**（`docker build -f portal/Dockerfile` 本地镜像临时顶掉 pin）：管理台 tab 出现（`用户管理 / LLM 管理 / 仓库管理 / 号池占用`）；落 `/admin/users` 时占用请求 **0 次**，点 tab 后**恰好 1 次**且 URL **不带 query**；真数据逐字段对得上我今天直采的 API（`800 = 795 空闲 + 0 部分 + 5 占满`，被占段 `22000–22009 … 10 个活行 · 占用者：eric`…共 5 段真名）；`partial=0` ⇒ 无警报块、无自洽告警、无错误行、整页无 `undefined`/`NaN`/`[object Object]`、console error 0。
- **改块提示三态在真机上成立**（这是本单的最终目的）：输入 `22000` ⇒ 「被占用（占用者：eric；10 个活行）——改块会被服务端拒绝（409），请换一段」；`22100` ⇒ 「整段空闲（在最近一次总览的空闲列表里）」；`29990` ⇒ 「**不知道**这一段空不空：它不在最近一次总览的空闲列表里（那份列表是截断的），以服务端校验为准」。开面板 ⇒ 占用请求增量 **0**（隐式请求为零，真机版）；`/ports/block` POST 数 **0**、输入框值原样保留（不自动改值/不自动提交）。
- **发布物复验**：浏览器实际加载 `index-xHmHZy-g.js`，**与本地构建同名**（内容逐字节一致旁证，同 §8.43 那次先例），汇总与占用段渲染同上、四类脏值全 0。

### 8.51 目录下拉第一项是 `.pnpm-store`：展示层过滤 + 镜像钉死依赖缓存落位（2026-10-24，决策者口述、无 issue，**PR #360**，merge `444d2ca`）

> **编号为什么是 8.51 不是 8.50**：我在 `0ea54dc` 上开工，当时 `AGENTS.md` 末节是 §8.49；合并时 main 已被 **#350 占了 §8.50**（v0.1.30）。两条不是同一件事，本条顺延 —— 台账里出现两个同号小节比改号更坏（后续所有 `§8.50` 引用会歧义）。

**现象**：决策者开 FDE 界面点开目录下拉，第一项是 `.pnpm-store`，真实项目被挤到后面。

**取证推翻了「worker 的 HOME 不可写」这个直觉归因**（我先这么说，实测否掉）：`runner/agentd.js:984` 本来就写 `childEnv.HOME = CFG.home`（= `/home/erix`），且 `/home/erix/.local` 的属主确实是 `erix-worker`(1002)——HOME 一直可写。真因是 pnpm 自己的落位规则：**默认 store 与项目不在同一卷时，它在「项目所在卷」上另找地方建 `.pnpm-store`**，而 `~/projects` 正是 `projects` 这个 bind mount 的根（容器内 `stat -c %d`：`/home`=**52**、`/home/erix`=**64512**、`/home/erix/projects`=**64512**）。eric 空间现场：**388 MB / 22781 文件**的 `~/projects/.pnpm-store`，属主 `erix-worker`，触发者是 `lingolens`（唯一带 `pnpm-lock.yaml` 的项目）。
⇒ **结论：只要缓存落位由工具自己选，换个工具（corepack / pip）就会再长一次。** 两层分开做，缺一层都只剩一半。

**① 展示层（`portal/src/dirs.js`）**：新增 `isListedDirName` = `isSafeDirName` + 非 `.` 开头，只用在 `listDirs` 的枚举处。下拉是**项目选择器**不是文件管理器，这类目录不可能被选为 cwd，列出来只是噪音（且 `.` 码点排在所有字母之前 ⇒ 必然顶掉第一项）。**只影响列表可见性**：`validateSessionCwd` / `fileTree` 不筛点开头，已存在的 `~/projects/.xxx` 会话 cwd 仍可读写与展开——不是收紧旧口径，只是不加严。

**② 落位层（`runner/Dockerfile`）**：写 npm 的 **globalconfig**（容器内 `npm config get globalconfig` 实测 = `/usr/local/etc/npmrc`），`cache=/home/erix/cache/npm` + `store-dir=/home/erix/cache/pnpm-store`；`corepack`/`pip` 不读 npmrc ⇒ 镜像 ENV `COREPACK_HOME` / `PIP_CACHE_DIR`。三条不能换的做法：
- **选 globalconfig 而不是 `ENV npm_config_*`、也不是往家目录物化 `.npmrc`**：它是 npmrc 链**最低一层**，只给默认值。真机实测优先级——只给它时 `npm config get cache=/home/erix/cache/npm`，再放一个 `~/.npmrc` 写 `cache=/tmp/override` ⇒ 立刻变 `/tmp/override`。⇒ 不与 user-space §4.2「`~/cache` 内容 FDE 自管」冲突，也不会静默盖掉用户/项目 `.npmrc`。家目录那条走不通另有其因：`~/` 下的平台文件每轮 reconcile 覆盖（`materializer.js`），用户改一次就丢。
- **落点用既有的 `~/cache`**（§4.2 已划定的依赖缓存区、独立 bind mount、不进目录下拉），不新增概念。不预建子目录：工具自建，agentd(1001)/worker(1002) 主组 1000 + umask 0002 ⇒ 跨 UID 可复用（已实测 worker 在 `~/cache/pnpm-store` 里 `touch` 成功）。
- **层序**：必须排在镜像自身 `npm install --omit=dev` **之后**，否则构建期缓存也落 `~/cache/npm`、运行时被宿主 bind mount 盖住 ⇒ 镜像白占一层且不可回收。这条顺序进了判据。

**线上热补（不等镜像重建，当日已执行）**：`fde-eric` / `fde-jim` 两容器写入同一份 `/usr/local/etc/npmrc`（写在容器可写层：`docker restart` 还在、**`docker rm` 后没了** ⇒ 固化必须靠新镜像）；eric 的 store 用 `cp -a` 搬进 `~/cache/pnpm-store`（`find -type f` 源=目标 **22781=22781** 才删源，不重下）并 `chown erix:erix` + `chmod 0770`（组 rwx 让 agentd/worker 复用）。eric 的 `~/projects` 现只剩 6 个真项目。

**告知面**：`~/AGENTS.md` 那条「`node_modules` 每项目一份 → 用 pnpm store / npm cache 共享（`~/cache`）」改成「**已由镜像默认指到 `~/cache`**——不要把 store/cache 改到 `~/projects` 下，也不要在项目里建 `.pnpm-store`」。不改这句，agent 要么以为要自己配，要么反向把它挪回去。

**基线**：根 **1430 / 1426 / 0 / 4**（基点 §8.49 / §8.50 都记的 **1426 / 1422 / 0 / 4**，净 **+4** = `dirs.test.js` +1、新 `portal/test/runner-image-cache-dir.test.js` +3）、runner **323/323** 不变、**前端零字节**。

**合并树复跑**（在 `origin/main` = `bf23258`〔含同期 merge 的 **#358 端口观测**〕上亲手跑，判绿 = 退出码）：根 **1441 / 1437 / 0 / 4**、runner **328 / 328**。⚠ 与本单声明基线的差额（根 +11、runner +5）**全部来自 #358，不是本单** —— 本单增量恒为根 +4 / runner 0 / 前端 0。改动面：`portal/src/dirs.js`、`portal/src/materializer.js`、`runner/Dockerfile`、`docs/design/user-space.md` §4.2、`ISSUES.md` 条目→issue 对照表一行（无 issue，写明当日直修）、两个测试文件。

**主 agent 亲跑变异 3 条（每条先自证 `git diff` 非空操作）**：① 撤掉 `isListedDirName` 的非隐藏判定 ⇒ `dirs.test.js` **恰 1 条红**（新用例）；② 删掉告知句里的「别挪进 `~/projects`」⇒ **恰 1 条红**；③ 把 globalconfig 层挪到 `npm install` 之前 ⇒ **恰 1 条红在层序那条**，且附顺序自检（`npmrc@5148 < install@5479`）。⚠ **③ 的第一次尝试是假变异**：脚本按 `t.index('WORKDIR /opt/erix')` 取切点，而该锚点在文件里出现得**更早**（`j < i`）⇒ 切出一段重复文本、相对顺序根本没变 ⇒ 3 条全绿差点被当成判据。按 §8.24 先量「变异后两个锚点的实际偏移」重做才拿到红（这条纪律又一次自己抓到东西）。

**未做 / 待决**（**PR #360 已 merge 进 main**，merge `444d2ca`；main CI 两个 job 全绿 = 质量门禁 + **三镜像构建校验**，后者顺带证明新加的 globalconfig 层能构建）：
- **镜像未重建**：现网 `FDE_IMAGE=ghcr.nju.edu.cn/erixwong/erix-station-fde@sha256:de16b78b513c…`（portal env + `IMAGE_ALLOWLIST` 全串精确匹配）。生效需要 build → 新 image ID → 同步这两处 env → recreate `fde-eric` / `fde-jim`（**会打断正在跑的 run**）。在此之前线上靠上面那份热补撑着。
- **未发版**（不进 v0.1.31 的任何承诺，等决策者定窗口）。
- 展示层过滤**没**同步到目录树（`fileTree`）：树面板里点开头目录仍可见可展开，是刻意的——树是浏览器的用法，人可能就是要看 `.git` / `.github`；下拉才是被污染的那一面。

### 8.52 引擎面向的 `store.load()` 补上读侧折叠（issue #351，会话砖化的根治性止血）

**触发**：决策者真机连撞两次 `invalid_messages`（同一会话 `9e0c8a17…`，8 分钟内两个不同的 index）。

**取证手法（值得复用）**：把**真账本行**喂进引擎自己的 `foldLedgerMessages` + `validateMessages`，
比读错误文案硬得多；再用两张备份表把账本**还原成修数据之前**的原始形状做 A/B：

| 读法 | 原始 158 行真账本 |
|---|---|
| 本站 `store.load()` 过去那样直通原始行 | **FAIL `index 56`**（= 界面上第一次红） |
| 先过上游 `foldMessageRows`（= file/memory store 的读法） | **FAIL `index 81`**（= 界面上第二次红；上游解不了链式 `partOf` = #415） |
| 本单：`runner/lib/transcript-fold.js` | **OK（92 条逻辑消息）** |

**归因推翻了两条在册口径**（都在册很久）：
① `AGENTS.md:1107`「runner 侧不需要补折叠（引擎自己折）」——**错**：引擎只调 `foldLedgerMessages`
（只把 `partOf` 分片接回原消息），**载体折叠 `foldMessageRows` 是 store 的职责**
（上游 `host-consumer-contract.md:2405-2409` + `:2442`；`resume-manager.js:239-241` 的 `seq` 播种本就面向折叠后的输出）。
② #341 与巡检手册「引擎 resume 侧本站修不了，只能修数据（等上游 #415）」——**错**：本站 `portal/src/transcript-fold.js`
是上游读侧的**超集**（分片行也登记自己的 key ⇒ 解链），链式夹具实测上游 FAIL / 本站 OK。

**修法**：折叠接在 `runner/lib/store.js#load`，**且必须在全量拉齐之后**（agentd `case 'load'` 已把游标翻页聚合成一个数组）——
接在 portal 分页端点的页内会在「一轮跨两页」时漏折（#338 同根）。新建 `runner/lib/transcript-fold.js` 是
`portal/src/transcript-fold.js` 的**镜像**（FDE 镜像 build context = `runner/`，运行期拿不到 portal 源码；先例：
`runner/lib/llm-models.js` 的 `positiveIntOrNull`）。两份的 `SHARED-FOLD-CORE` 区间**逐字节**由测试钉住
⇒ 口径漂移只能两边一起改。`portal/src/transcript-fold.js` 只加了标记注释，逻辑零改动。

**主 agent 亲跑变异 4 条**（每条先自证只改 1 行、且**一条一还原**）：
① 摘掉接线（`return records`）⇒ **恰 4 条红**（标本①② + 真 `runToolLoop` 贯通 + 源码级「load 必须折」）；
② 撤 runner 那份的 #341 解链闸 ⇒ **恰 2 条红**（标本② + 两份镜像字节对拍）；
③ 单边改 portal 口径（`isFoldableMessageRow(record) && seq >= 0`）⇒ 镜像字节锁红（同一轮还顺手证明了「单边改」正是字节锁要拦的）；
④ 让载体不接正文（`attached.set` 注释掉）⇒ **5 条红**（标本①② + 真 `runToolLoop` 贯通 + 镜像字节锁 + 与上游逐字段对拍）。
⚠ ②③ 第一次连跑时**忘了还原 ②** 就测 ③ ⇒ 多出一条假红（标本②）——变异取证必须一条一还原。

**⚠ 一条自己差点放过的假绿（本单最值钱的一处）**：`runToolLoop` 贯通用例**第一版只跑到崩溃后那次 resume，
变异① 摘接线时它照样绿**（当时另三条变异也没把它打红）。原因：崩溃现场那次 resume 引擎自己会把宿主的 `:input:` 行当尾巴延后拼
（`resume-manager.js:196-215`），**不折也能过**；砖发生在**下一次** resume（快照干净、尾巴支路不走）——
真机正是这个次序（`07237084…` 崩溃后 resume 成功跑 8 轮 → `4f857875…` 才报 `index 56/81`）。
⇒ 用例补成「崩溃 → 追问 → resume → **再 resume**」并加**前提自证**（`:input:` 行必须排在迟到的
`tool_result` 之前），补完后变异① 才红在它上面。**教训：resume 类判据必须跑到「快照干净后的第二次 resume」。**

**基线**：根 `node --test` **1460 项 / 1456 通过 / 0 失败 / 4 跳过**（同树不含本单 **1448 / 1444 / 0 / 4**
⇒ 本单 **+12**：新 `runner/test/store-load-fold.test.js` 11 + `portal/test/transcript-fold-wiring.test.js` +1）。
前端与 `portal/src` 运行时零改动（`portal/src/transcript-fold.js` 只加注释与标记）。
`portal/test/transcript-fold-wiring.test.js` 那条「折叠模块只有一个消费点」顺带修了自身空转：
它用「文件里出现 `transcript-fold.js` 字符串」当消费点判据，而本单在模块自己的文件头注释里点名了镜像 ⇒ 自己咬自己
⇒ 判据排除模块自身（注释不是消费点）。

**存量**：接线后新会话不再需要修数据、**已砖会话读侧自愈**。今天两次修数据照旧执行过（打地鼠，见 #367 与手册 §2/§5），
备份表 `transcript_rounds_input_seq_bak_20261024`（1 行 `append_seq`）与 `transcript_rounds_partof_bak_20261024`（92 行 `partOf`）。

**遗留**：上游 [erix-agent #458](https://github.com/ErixWong/erix-agent/issues/458)（把「宿主 `load()` 必须返回折叠后形状」
从散文变成 exports + 契约判据）、[#415](https://github.com/ErixWong/erix-agent/issues/415)（写侧别再写链，落地并升 pin 后
**两份镜像的解链闸要同时撤**——`runner/test/store-load-fold.test.js` 与 `portal/test/transcript-fold.test.js` 的源码级哨兵会红提示。
**2026-10-25 更新：这条还没到撤的时候**——0.25.0 只修了**写侧**（新账本不再产链），读侧 `parts.set` 仍恰好一处 ⇒ 存量 0.23 链式行照旧需要本站的闸。真判据是「巡检 SQL 查出存量链式 `partOf` 清零」，不是「上游版本号涨了」。详见 §8.60 的判定表。）
**口径范围（2026-10-24 补，别把本节读成「砖化都修完了」）**：本节止血的是**读侧形状**那一类
（`invalid_messages`：账本装得下、引擎 `load()` 出来的序列过不了校验）。**写侧还有独立的一类**：
单条折叠记录把 `from:1` 起的全部被折叠消息重发一遍，体积随会话长度线性增长，撞到 portal §9.7 的
**1 MiB** 单轮上限 ⇒ `400 validation_failed` ⇒ run 以 `persistence_failed` 终局。它**根本不经过
`load()`**，本节的读侧折叠一点也帮不上；判据也不同（要量 `octet_length` 字节，§1/§5 两条巡检都判不出）。
上游修在 erix-agent **#461**（0.25.0 `src/compact/fold-archive.js`：sha256 去重 + 256 KiB 夹断），
本站配套 **#371 / #375**（见 §8.59），巡检与算术余量见 `docs/ops/transcript-ledger-inspection.md` §6。

### 8.53 收工纪律进 `~/AGENTS.md`：D9 的告知面先行（issue #359 P0c，2026-10-24，分支 `feat-261024-05-git-light-agents-md`）

**交付的只有 D9（§7）的告知面，灯本身没做**：`renderHomeAgentsMd` 的 `## git` 段从 2 行扩到 5 行——
①「平台不 clone、不下发凭据，**也不替你提交**：首次运行只对还不是仓库的目录执行一次 `git init -b main`」
②「**收工即提交**：任务完成（含新建/修改的文件，未跟踪的与改过的同样算没兜底）就 `git commit`，有远端就 `git push`」
③「**一个目录里有多个仓库就逐个仓库分别提交**：父目录的仓库**不包含**子目录里的仓库，在父目录提交是白干的」
④「目录还没有远端 ⇒ 提醒用户自行配置」。`portal/test/materializer.test.js` 加 1 条用例钉这四条**语义**（改字可以，改口径不行）。

**为什么告知面要先走**：容器里的 agent **看不见灯**，而平台零 git 写操作（`worker.js:270 ensureGitRepo` 只 init 不 commit）
⇒ 不先把要求写进它读的 `~/AGENTS.md`，灯上线后就是「把问题摆给用户，却没人负责让它变绿」。顺序反了 D9 就不闭环。
③ 那句还顺手堵住 #359 §4.0 那个「空壳根仓库」的坑——它是在 AI 侧阻止事故，比在 UI 侧提示便宜。

**生效路径（与 §8.50 那条「镜像未重建」不同类，值得单独记）**：materializer 跑在 **portal 进程内**，
`isPlatformManagedPath` 认 `home/AGENTS.md` 是平台文件（`materializer.test.js` 那条钉着）⇒ **portal 发布后
下一次 reconcile 重写** `<userSpaceRoot>/<fde>/home/AGENTS.md`，经 bind mount 立即可见于容器
⇒ **不需要重建 FDE 镜像、不需要 recreate 容器、不打断正在跑的 run**。

**基线**：基点 `origin/main` `1655d7a` **1445 / 1441 / 0 / 4** → 本次 **1446 / 1442 / 0 / 4**，**净 +1**
（本次 diff 里 `^+test(` 计数 = 1，可校），`npm test` **rc=0**（判绿看退出码，§4.1）；`runner/` 与 `portal/frontend/` **零字节**。

**未做 / 待决**：
- **P0a**（`portal/src/gitlight.js` 三判据 + `GET /api/git-light?cwd=`）、**P0b**（顶栏灯 + `让 AI 收尾` 预填 + `问 AI` 兜底 + zh/en）都在 #359 挂着，**灯现在界面上不存在**。
- **未发版**（不进任何版本承诺，等决策者定窗口）。
- ⚠ 给接手 P0a 的 session：**动手前先读 #359 附录那 6 条实测**——尤其「`-uno` 会让 0 提交根仓库对脏子仓库报空输出（撒谎）」、「本机 `-u` 与 `-uall` 逐字相同、`.gitignore` 会剪掉整棵 `node_modules`」、「linked worktree 的 refs 在 `commondir` 而不是 `.git` 文件指向的目录」。**`listeners.js:112-126` 没处理 `commondir`，照抄会错。**

**顺带挖到的仓库级坑（与本单无关，未动，只登记）**：`origin/main` 的 `1655d7a` 把 **`node_modules` 当文件提交成了指向它自己的符号链接**
（`git ls-files -s` 是 mode `120000`，内容 = `/home/adminwange/projects/fde_station/erix-station/node_modules`；`file` 报 *broken symbolic link*）。
后果：**任何新 checkout / 切分支到该 tip 之后，`npm test` 直接 `ERR_MODULE_NOT_FOUND: Cannot find package 'erix-agent'`**
（本次切分支就撞上了，看着像自己的改动把测试弄挂）。本机用 `npm ci` 恢复（它先 `Removing non-directory node_modules` 再装 16 个包，0.7s）。
CI 不受伤（`npm ci` 路径），但**本地开发受伤**，而且症状完全误导人。
⇒ 本单**没动这个路径**（工作区里那份删除是 `npm ci` 的副作用，未入提交）；后续要么 `git rm --cached node_modules` + 进 `.gitignore`，要么把它改成真的相对符号链接——**别在不知道它存在的情况下再提交它一次**。

### 8.54 收工灯的判定端点（issue #359 P0a，2026-10-24，分支 `feat-261024-05-git-light-agents-md`，接 §8.53）

**交付**：`portal/src/gitlight.js`（新增）+ `GET /api/git-light?cwd=`（`http.js`，挂在 `/api/file` 之后）
+ `docs/api/portal.md` §0.1 补 4 行 + **28 条单测**（`portal/test/gitlight.test.js`）。**界面上还没有灯**（P0b 未做），
现在只能 curl 这个端点看判定结果。

**三条判据落到实现（口径与实测记录都在 #359）**：
- 未提交 + 未跟踪 = **一条** `git status --porcelain -uall`（不用 `-uno`，它会撒谎）；stdout 流式读，**数到 50 条即 kill**。
- 未推送 = 纯文本：`HEAD` → 分支 → **`refs/remotes/<remote>/<br>`** 与 HEAD sha 比对（松散 ref 与 `packed-refs` 都读）。
- 0 提交 = 纯文本（HEAD 指向的 ref 解析不出来）；⚪ 灰（含 `index.lock` 正忙 / `.git` 读不动 / 判不完）**一律不显绿**。

**⚠ 两条实测纠正（都进了单测，别再走一遍）**：
1. **`--no-optional-locks` 是 git 级选项**，必须排在 `status` **之前**。写成 `git status --porcelain --no-optional-locks`
   ⇒ `error: unknown option` 直接退出 ⇒ **所有仓库默默变灰**，不报错、不显眼（#359 正文原先就把它写在子命令后面，已同步改正）。
2. **`branch.<n>.merge = refs/heads/main` 指的是远端那条分支**，要拿 `refs/remotes/<remote>/main` 比。
   拿 `cfg.merge` 直接比 = **HEAD 跟自己比** ⇒ 未推送永远判绿。
   另外 worktree 的 `refs/`/`packed-refs`/`config` 在 **`commondir`** 指向的目录（per-worktree 目录只有 HEAD/index）——
   `runner/lib/listeners.js:112-126` 只解到 `gitdir` 这一层，**照抄它会把 worktree 判成「从未同步」**。

**`partial` 的语义 = 「这不是完整结论」总开关**（扫描预算耗尽 ∪ 仓库数封顶 ∪ 任一仓库没判完），具体差在哪由 `reason` 说；
前端拿它当「不得显绿 + 必须给 ↻」的依据。空壳根仓库（0 提交 + 无已跟踪改动 + 看得见的东西**全是别的仓库**）标 `shell: true`，
**不参与拉高灯色**（它恒为红会把一切染红），只在展开态出那一行解释。成本上界：20 仓库 / 发现 300ms 或 1500 目录 /
单条 status 2s / 流式 50 条 / **单请求总预算 6s**（仓库多时逐个 2s 会把请求拖到几十秒）。

**基线**：接 §8.53 的 **1446 / 1442 / 0 / 4** → **1474 / 1470 / 0 / 4**（**净 +28**），`npm test` **rc=0**；`runner/`、`portal/frontend/` 零字节。

**主 agent 亲跑变异 5 条（每条先自证 `git diff` 非空操作）**：① `-uall` 退化成 `-uno` ⇒ **4 条红**；
② 撤掉 `--no-optional-locks` ⇒ **第一次是假绿**——哨兵只判了「排在 `status` 之前」，参数整个删掉时 `indexOf` 返回 `-1`
反而更小 ⇒ 判定通过（§8.50 那条「先量变异是否非空操作」的纪律又抓到东西）；补上「参数必须存在 + 顺序」双断言后 ⇒ 1 条红；
③ 不读 `commondir` ⇒ 1 条红；④ 不读 `packed-refs` ⇒ 1 条红；⑤ upstream 退回与本地分支自比 ⇒ 2 条红。

**未做 / 待决（重要）**：
- **portal 镜像还没装 git**（`portal/Dockerfile` 无 apt-get）⇒ 现网这个端点对所有仓库都会返回 `grey / git_unavailable`，
  只有纯文本那半（未推送、0 提交）不受伤。**P0b 上线前必须先给 portal 装 git**，否则灯永远是灰，比没有灯更糟。
- 后端 TTL 缓存与全局并发闸（#359 §7）未加：现在只有一个消费方（还没有），加了要先把 `partial`/`checked_at` 口径带进缓存。
- ⚠ **CI 红过一次，红在夹具而不是实现**：worktree 那条用例我钉了「per-worktree 的 gitdir 里不该有 `refs/`」——
  本机 git 2.43.0 确实没有，**CI 的 ubuntu-latest 有**（`refs/` 空壳），断言当场炸。教训：**别把 git 的磁盘布局当断言**，
  要钉性质（`.git` 是文件、`commondir` 指回主仓库 `.git`、分支 ref 在 common dir）。实现同步改成
  「`refs/` 两处都找、**common 优先**」（与 git files backend 的重定向一致），并顺手模拟 CI 那种布局进夹具。
  变异自证：只读 per-worktree 目录 ⇒ 1 红；不读 `commondir` ⇒ 1 红。
- 端点未接任何前端调用；`/api/dirs`、`/api/files/tree`、`/api/file` 此前**根本没进 API 端点清单**（本次一并补上，见 §0.1 的「此前漏记，现补」标注）。


### 8.55 portal 运行镜像装 git（#359 收工灯的硬前置，2026-10-24，同分支接 §8.54）

**为什么 portal 自己也要 git**：`GET /api/git-light` 的「未提交 + 未跟踪」两路要跑一条
`git status --porcelain -uall`。未推送 / 0 提交那两路是纯文本读 `.git`，不需要 git 二进制；
**但缺 git 时灯只能恒报 `grey / git_unavailable`**——一颗恒灰的灯比没有灯更糟（绿是承诺、灰是无信息，
用户会当它坏了而不再看）。§8.54 把这条登记成 P0b 前置，本次直接做掉。

**改动**（Dockerfile 一处 + 新测试一个）：运行阶段加
`apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*`，
层序照 `runner/Dockerfile`（重且稳定的 apt 层排在 `npm ci` 之前，改 portal 代码不触发重装）。
**只装 read 侧**：不装 openssh-client、不配凭据、不碰网络——D9 定了 portal 零 git 写。
体积代价：apt 计划 109 MB（git 拖 perl/perl-modules/libcurl3-gnutls 等），对 341 MB 的 portal 镜像是
**+30% 量级**——这是本次唯一的成本，换来的是灯能真判。

**新测试 `portal/test/portal-image-git.test.js`（+4，判据形状照 `runner-image-cache-dir.test.js`：读文本不跑部署）**。
为什么必须钉：**这个失效在 CI 里看不见**——根单测跑在 CI runner 自己的 git 上，镜像里没 git 也全绿。
四条 = 运行阶段装了 git / apt 层排在 `npm ci` 之前 / 不许顺手装进前端 builder /
缺 git 时代码必须落 `grey / git_unavailable`（**另一半锁**：镜像装了 git 管「能不能判」，这条管「判不了怎么表现」）。
变异 2 条（先自证非空操作）：apt 里把 git 换成 `ca-certificates` ⇒ 1 条具名红；apt 层挪到 `npm ci` 之后 ⇒ 1 条具名红。

**真机 A/B（同一份判定代码 + 同一套四态夹具，只换运行环境；探针脚本用完即删、不入库）**：

| 夹具 | 现网 `station-portal:latest`（无 git） | 有 git 的环境（FDE 镜像，**git 2.39.5** ＝ bookworm 版，也正是 portal 将拿到的版本） |
|---|---|---|
| 已提交已推送 | `grey / git_unavailable` | **`green / synced`** |
| 已提交未推送（有 upstream、从未 fetch） | `grey / git_unavailable` | **`yellow / never_fetched`** |
| 有改动 + 有未跟踪 | `grey / git_unavailable` | **`red / uncommitted`** |
| 已提交、无 remote | `grey / git_unavailable` | **`yellow / no_remote`** |
| 目录不存在 | 404 `not_found` | 同左 |

右列顺带证了**判定模块在 bookworm 的 git 2.39.5 上口径不变**（开发机 2.43.0、CI ubuntu-latest 更新，三处对齐）。

**⚠ 本机没能把带 git 的 portal 镜像 build 完**（不是 Dockerfile 的问题，记下来省后人时间）：
`apt` 的**大文件传输**在本机反复被掐——第一次 `Packages`(8.8 MB) 卡 8 分钟；第二次过了 update、卡在
`perl-modules`(2.8 MB)；第三次换 `--network=host` 仍卡在同一处。而**同一时刻容器内小请求 5 秒正常返回**
（`deb.debian.org` 的 404 页 5.2s）⇒ 症状与「GitHub 边缘半死」同一族：长流量被掐，不是 DNS、也不是 bridge 网络。
所以这层的**首次真构建发生在合入后的发布构建**（GitHub runner 上；PR 上 image job 是 `skipped`，
CI 也不会替这层背书）。风险面低：与 `runner/Dockerfile` 同一套 apt 写法，那层在 CI 天天构建成功。

**自伤两次、值得写下来**：`pkill -f "portal/Dockerfile"` / `pkill -f "buildx build --load -t fde-portal-gittest"`
都**匹配到了自己这条 bash**（命令串里含该字符串）⇒ SIGTERM 打死自己，后面所有语句全没跑（`nohup` 起的构建
也被进程组带走）。口径：**先 `pgrep` 看清再按 PID 杀**，且模式要写成不匹配自身的形式（如 `[p]ortal/Dockerfile`）。

**基线**：接 §8.54 的 **1474 / 1470 / 0 / 4** → **1478 / 1474 / 0 / 4**，`npm test` **rc=0**；
`runner/`、`portal/frontend/`、`portal/src/` 零字节（本次只动 Dockerfile + 测试 + 文档）。


### 8.56 收工灯上线到界面（issue #359 P0b，2026-10-24，分支 `feat-261024-05-git-light-agents-md`，接 §8.54 / §8.55）

**这是 D9 那颗灯真正被看见的一次**：顶栏 cwd 徽标旁多一颗灯 + 一个词，点开是逐仓库明细与两个动作。
新增 4 个文件（`lib/gitLight.ts` / `composables/useGitLight.ts` / `components/GitLightBadge.vue` + 各自 spec），
改动只有 `WorkbenchView.vue`（接线 20 行）与两份 locale。**后端零改动**（§8.54 的端点原样消费）。

**分层**（防"两处判色"漂移）：`lib/gitLight.ts` 是**显示口径唯一入口**（纯函数、无 DOM）、
`useGitLight.ts` 只管取数与作废（形状照 `usePreviewPorts.ts`：闭包 `reqSeq`、30s 轮询 + 回前台即刷、
`onScopeDispose` 收摊）、组件**不判色**也不发请求（动作只 `emit('prefill')`）。

**刷新时机三条**：切目录（先 `reset()` 再拉）、**一个 run 结束的那一刻**（`running` true→false）、
挂载时；加上 composable 自带的 30s 兜底轮询（页面隐藏不轮询）。run 结束这条是重点：
用户刚让 AI 干完活，30s 拖尾不可接受（§8.54 记过"灯必须立刻反映 run 后的状态"，这里落地）。

**界面侧红线（都有单测）**：
- **颜色不承重**：点旁边就是文字（`未落地 / 未推送 / 已收工 / 未检查`），完整口径同时进 `title` 与 `aria-label`
  （两者逐字相同，读屏与鼠标拿到同一句话）；点本身 `aria-hidden`。
- **⚪ 不得显绿**做**两层**：后端已把 `partial`/未判完压成灰，前端 `gitLightDisplay` 再压一次——
  变异取证：撤掉前端这层 ⇒ 2 条具名红（钉的是"旧后端把 partial 的绿漏过来时界面也不许骗人"）。
- **红是日常态**：无 `⚠`、无告警底色、文案不说"错误/失败"（`localeParity` 与组件各钉一条，源码级哨兵钉模板里不许出现 `⚠`）。
- **绿的诚实**：文案必须写"与你**已知的**远端一致"+ 说明"同事推过而你没 fetch 的看不见"；
  `localeParity` 反向钉不许出现"远端是最新的 / up to date"。
- **平台零 git 写**：没有提交/推送按钮，动作只有「让 AI 收尾」（红/黄才出现）与「问 AI」（永远在），
  两者**只写 `store.inputValue`**；界面上明写"只是填进输入框，不替你发送（发送就是一次运行）"。
- 脏值面：`reason` 不在表上 ⇒ `gitLight.reason.unknown`；行内 `light` 也过枚举表；错误码缺失退 `unknown`
  （三条都各有红变异）。`reason` 键集合与 lib 的已知表**跨文件逐字对齐**（加 reason 不补文案就红）。

**基线**：前端 **44 文件 / 796 → 47 文件 / 857**（**+3 文件 / +61**：lib 27 / composable 10 / 组件 19 —— 组件里
两条是双语与源码哨兵；另 `WorkbenchView.spec` +5 接线、`localeParity` +5 语义）；根 **1493 / 1489 / 0 / 4** 不变
（`portal/src/` 零字节）；`npm run typecheck` 干净；两侧 `rc=0`。

**主 agent 亲跑变异 7 条**（每条先自证非空操作）：撤"partial 压回灰" 2 红 / 没数据显绿 2 红 /
撤文字标签（只剩颜色）6 红 / run 结束不重判 1 红 / 切目录不 `reset()` **第一次 0 红**
（接线用例只看了"最后一次请求的 URL"，看不见"旧结论有没有被清掉"）⇒ 改成"新目录请求故意挂住 +
断言标签不再是已收工"后 1 红 / 空壳也拿去点名 1 红 / 错误码允许 `undefined` 1 红。
**另一条自伤**：非空操作探测用 `git diff --stat`，而**新建文件还没进索引** ⇒ 未跟踪文件的 diff 永远为空，
五条新文件变异被误判成"空操作"；改成直接比字节（口径：**未跟踪文件不要拿 git diff 当非空操作判据**）。

**未做 / 边界**：① 现网后端还没有 `/api/git-light`（P0a 未合入发布）⇒ 真机 A/B 只能到"组件对旧后端
报 `grey + 本次检查失败"这一格，完整真机（真目录、真仓库、真 run 结束刷新）要等本 PR 进镜像；
② 后端 TTL/并发闸仍未加（现在只有一个消费方）；③ 灯只在**有目录**时出现（`v-if="store.dirCwd"`），
没选目录的用户看不到"这个平台不管 git"这件事——留观察，先不加噪声。

### 8.57 文件预览四通道 + kkFileView 自建 5.0.3 接入（issue #366，**PR #372 已 merge**，merge `aaf8294`，分支 `feat-261024-06-file-preview-p0p1` 已删）

> **编号为什么是 8.57 不是 8.52**：我在 `1ae464a` 上开工写台账时末节是 §8.51，落笔占了 §8.52；合并时 main 已被 **#351（8.52）与 #359 三连（8.53–8.56）** 抢先——按 §8.51 同一条纪律，本条顺延并把号让干净，后续引用以 §8.57 为准。

> 规格 = issue **#366**（定稿），前史 #356（其中「签名票据下载」一节基于「文件在 FDE 容器内」的**事实错误**，已被 #366 作废：文件在宿主 bind mount `/docker/erix/users`，portal 与 kk 挂同一棵盘即可 ro 直读）。契约落在 `docs/api/portal.md` **§4.11**，env 面在 `docs/env.md`（`KK_*` 四行），部署面在 `deploy/README.md` + `deploy/docker-compose.yml`（`station-kkfileview`，profile `kkfileview`）。

**交付**：① `GET /api/file` 加 `mode=stream|download`——共享牢笼 `dirs.resolveJailedFile`（与 JSON 预览/文件树同一红线），单 Range→206（多 Range/非法降级整身）、MIME 白名单外一律 `octet-stream`+强制 attachment、**`text/html` 永不直出**（同源 XSS），上限 512MB 不读进内存；② 415/413 埋点（迁移 **0023** `preview_miss_stats` 按 日×kind|ext UPSERT + `GET /api/admin/preview-misses`，写失败只 warn 不拖预览）；③ **kkFileView 全量接入**——`POST /api/preview-tickets` 签能力码（`base64url(JSON)+HMAC(user,path,mtime,exp)`，TTL 600s，密钥 = `SESSION_SIGNING_KEY`）→ `GET/HEAD /pv/<code>/**` 反代（会话→验签→路径白名单→归属→时效五道闸，`onlinePreview?url=` **永远由 portal 重写**成自产 `file://` URL——SSRF 面 = portal 自己；HTML 根链接改写挂前缀 + `SERVER_FORWARD_HEADERS_STRATEGY=native` 双保险；kk 头消毒 + portal CSP；kk 死 502 `preview_backend_unavailable`）；④ 前端四通道（`previewRoute.ts` 纯函数 + 模态框 json/stream/kkfile-iframe(`sandbox="allow-scripts"` 无 same-origin)/download-only，`preview_code_expired` 自动重签一次）。

**镜像这一课（决策点，别重蹈）**：官方 Docker Hub `keking/kkfileview` **停在 4.1.0**（2022-08），而 `file://` 本地协议（`DownloadUtils.isFileUrl`/`handleFileProtocol`）是 **5.x 才实现**——4.1.0 里 `file:` url 直接落「不能识别」分支，**ro 挂载设计在 4.1.0 上根本不成立**；上游 5.0.x 又没发镜像（其 Dockerfile 基座 `keking/kkfileview-base:5.0.0` Hub 404）。→ **自建**：`deploy/kkfileview/`（`build-image.sh` = codeload tar → maven 打包 → ubuntu noble 基座〔openjdk-21-jre + libreoffice-nogui + wqy 字体，aliyun apt 45s 建完〕→ 应用层）。⚠ 上游镜像 tag 存在 ≠ 版本新，**先读目标能力的引入版本再定镜像**。

**真机 E2E 四个坑（全部源码+实测双证，已写进注释/文档）**：① 5.0.3 `TrustHostFilter.isNotTrustHost` 对**空 host 一律 403**（检查在通配符之前）——`file:///abs` 三斜杠形态全挂，必须拼 `file://<KK_TRUST_HOST>/<abs>` 命名 authority（TrustDirFilter 只看 path 不受影响）；compose `KK_TRUST_HOST` 与 portal `previewproxy.KK_TRUST_HOST` 同值，改一侧 = 全量 403。② kk 把转换产物挂 web 根（`/testdocx.pdf`）且模板生成**绝对 URL**——正解是 `X-Base-Url`（BaseUrlFilter 优先级 1 的官方多域名钩子，portal 每请求注 `<origin>/pv/<码>/`），闸门内链接自闭环；另加产物尾缀白名单透传（1–2 段）。③ XFP 开关在 Boot 3 是 `SERVER_FORWARD_HEADERS_STRATEGY`（写成 `SPRING_*` 静默失效，属性改名于 Boot 2.4）。④ 容器里 `cp -a` 会保留本机 AD 大 gid（>2097151），maven-assembly 写 tar 报 `group id too big`——打包前源码必须 `cp -r` 成容器本地属主。真机验收：docx → LibreOffice 转 pdf → 产物经 `/pv/<码>/docdocx.pdf` **200 / %PDF 魔数**；未登录/穿越/未知尾缀均按闸门 401/404。

**基线**：本单增量 = 根 **+21**（`file-stream-miss.test.js` 14 + `pv-proxy.test.js` 7；migrations.test 改断言不改数）、前端 **+1 文件 / +20**（`previewRoute.spec.ts` 12 + `FilePreviewModal.spec.ts` 8）、runner 零字节。**合并树复跑**（`origin/main` = `e662e3e`〔#351/#359 系已进〕，判绿 = 退出码）：根 **1516 / 1512 / 0 / 4**、前端 **48 文件 / 878**、typecheck rc=0。（分支期数字 1468/45-816 系基 `1ae464a`，勿与本行混引。）⚠ **node_modules 教训**：main 里入库的自指 symlink 会在 merge checkout 时静默顶掉工作区真实依赖目录（`git stash -u` 也会把它卷走），症状 = 测试 rc=216 且输出只有两行 banner；恢复 = `rm node_modules && npm ci`，判绿前先确认依赖目录真实存在。镜像产物：`erix-station/kkfileview-base:5.0.3` + `erix-station/kkfileview:5.0.3`（本机已建，生产按 digest 钉）。

### 8.58 `v0.1.32` 是个没进 main 的孤儿 tag（**已发版、已在跑、不可删**）与 `v0.1.33` 的处置（2026-10-25，分支 `release-261025-0-1-33`）

**取证（三条都实测，不是推断）**
- `v0.1.32` 是附注 tag（对象 `ac53f05`）→ 提交 `cea06d5`，**已推到 origin**；`release.yml` run `40095479683` success ⇒ **GHCR 三镜像真的推出去了**。
- **现网就在跑它**：`docker exec station-portal` 与 `fde-eric` 里 `package.json` 都是 `0.1.32`，`deploy/.env` 三行 digest pin + `FDE_AGENT_VERSION=0.1.32-088e41e`。⇒ **tag 删不掉**，它是有部署实体的发布物。
- 但 `cea06d5` **不是 main 的祖先**：它从当时的 main `e662e3e` 切出后就直接打 tag，`release-261024-0-1-32` 分支至今 `ahead 1 / behind 10`。于是**版本号与内容两条线分叉**：main 写着 `0.1.31`，内容却已含 `0.1.32` 的全部代码（`#369` 是 squash 进 main 的，`e662e3e` 就是当时的 main tip）；反过来 `v0.1.32` 这个发布物比 main 落后 10 个提交（32 文件 / +1773 −69），**缺 `#366` 文件预览四通道（含迁移 `0023`、`/pv` 网关、kkFileView 部署面）与 `#282` 状态条位置**。

**第二次漏账（同一个发布提交里）**：`cea06d5` 只动了 **3 个文件**（`package.json` + 根 `package-lock.json` + `runner/package.json`），漏了 `runner/package-lock.json`、`portal/frontend/package.json`、`portal/frontend/package-lock.json` —— 三处至今仍是 `0.1.31`。对照惯例：`872fd7f`（v0.1.31）与 `e2646c7`（v0.1.30）都是**六文件 / 9 行**。提交信息里那句「版本同步自查」只自查了 root 与 `runner/package.json` 两处，漏项就是这么来的。

**处置（为什么不"把 0.1.32 合回 main"）**：合回去只会带回一个**内容落后 10 个提交的 0.1.32 号**，且六文件缺口还得再补一刀，版本号继续说谎。所以：
1. `v0.1.32` tag **保留**，语义就此钉死为「只含 `#369` 的孤儿快照，勿当部署基线」；
2. 从 `main@e219b43` 出 **`0.1.33`**（六文件 9 行，与 `872fd7f` 模板逐字同形），内容 = main 全量 ⊇ `v0.1.32`；
3. 部署时 `0.1.33` 一次性把 `#366` + `#282` 带上线（`deploy/docker-compose.yml` 的 `station-kkfileview` profile + 两个 kk 镜像按 digest 钉、迁移 `0023` 启动自动应用）。本批 `runner/src|lib` **零字节**（只漂了 `runner/package.json` 的版本号）⇒ 按 §8.17 口径 **FDE 容器不必 `docker rm -f` 重建**，portal 前端与后端实质变。

**基线复跑**（`release-261025-0-1-33` = `main@e219b43` + 版本号，判绿 = 退出码）：`node --check` 全量 js/mjs rc=0；根 `npm test` **1516 / 1512 / 0 fail / 4 skip**；`node --test runner/test/*.test.js` **342 / 342**；前端 `typecheck` rc=0、`vitest` **48 文件 / 879 通过**。⚠ §8.57 记的前端 **878 是 `#373` merge 之前的口径**，`+1` 出自 `#373` 在 `WorkbenchView.spec.ts` 补的状态条位置用例（`777cbbd` +39 行）；runner 342 同理高于 §8.51 时代的 323，别再引旧数。

**两条纪律（下次发布当场可执行）**
- **发布提交必须从 main 的最新提交切、并且先合回 main 再打 tag**。判据一条：`git merge-base --is-ancestor <release-commit> origin/main` 必须为真，否则 tag 就是孤儿。分支直接打 tag（`#369` 那次）等于造一条没人认领的版本线。
- **发布自查按六文件表逐处 `grep '"version"'`**，判据是「六个文件里所有 `version` 字段等于新版本号，`git show --stat` = 6 files / 9 insertions」——不是"看一眼根 package.json"。
### 8.59 折叠归档写侧 1 MiB：「取不到原文」与「看不见失败」两面（issue #375 + #371，2026-10-24）

**同一次故障、两处独立缺陷**（真机标本：会话 `9e0c8a17-13c6-41d2-b637-ddc28665ce52`，轮 162 的折叠记录
≈1.13 MB 被 §9.7 的 1 MiB 闸拒掉，run 以 `persistence_failed` 终局；同一会话 3 行折叠记录占全账本字节
**53%**）。上游把归档改成有界差分（erix-agent **#461** / 0.25.0）之后，**本站这两处才开始失真**：

- **PR #376（#375，「查看原文」）**：`sessions.js#getFoldedPayload` 只读那一行的归档，而差分被会话级
  去重吸空时归档是**空的** ⇒ 旧口径一律 `404 folded_payload_not_found` ⇒ 界面「原文已不可用（上游未
  保留折叠前载荷）」——**假 404**，原文一行都没丢，全在各自的轮行里。改成三路：有 `foldedRoundRange`
  ⇒ 从轮行重建（`source:'rebuilt'`）；否则退回归档（`source:'archive'`）；两条都空才 404。
  `truncated` 只给布尔位（先例 §4.4a-1），行数上限 2000 与 U7 recall 同尺。**DTO 向后兼容**（`{round,
  turns}` 未动，三个新键可选）⇒ 前端不改也不坏。前端半边同时改掉两处说假话的文案：横幅那个
  `foldedPayloadMessages` 现在含义是「本条记录携带的归档条数」（去重+夹断后），长会话上偏小，
  所以**有 range 就只报轮范围**；`originalMissing` 改写 + 新增 `originalTruncated`。
- **PR #377（#371-A/B，「看不见失败」）**：⚠ **本单原先写「库里存着、只是界面不显示」是错的**——
  `SELECT count(*) FROM run_events WHERE type='persistence_error'` = **0 行**。真因：引擎的落盘失败走
  **`diagnostics.error`（`orchestrator.js:873`），不走 `onEvent`**，而本站 `runToolLoop` 参数里**从来没有
  `diagnostics`**，只有 `onPersistenceError`（只拿得到 `Error`，且只落一条 IPC warn）⇒ 事件在源头就丢。
  而且**不依赖升 pin**：通道与 `fatal:false` 在 pin 的 0.23.0 里就存在（`:895` 宿主端口桥）。
  四处一起接：runner `diagnostics.error → emitEvent`（映射在 `loopEventPayload`：`fatal` 缺字段算致命、
  `stack` 刻意不透传、引擎 `runId` 落名 `engine_run_id`）+ 三处集合（`http.js HISTORY_EVENT_TYPES` /
  前端 `EVENT_TYPES` / `HISTORY_REPLAY_TYPES`，#288 那个「三处独立存亡」的坑第三次发作）+ 前端**只把
  `fatal === false` 刷中性行**（红面仍归 `run_end` 的 `persistence_failed`，重复刷就是把一件事报两遍）
  + `portal.md` §5.3 **第 16 行**。#371-B：`MAX_ROUND_BYTES` 改 env（默认仍契约值 1 MiB）并把与上游
  256 KiB 归档上限的**算术余量**钉成用例（峰值 ≈840 KiB < 1 MiB）。

**取证口径（值得复用）**：全程用 **`octet_length()` 而不是 `length()`**（CJK 一字 3 字节，`length`
系统性低估约 20%，同一批记录会出现「`length` 判有余量、`octet_length` 已越界」）；并实测 B/估算 token
≈**2.785** 稳定、非归档部分 ≈**20.4 KB** 稳定 ⇒ 才敢把「满预算 messages ≈565 KiB」写进算术。
巡检 SQL、标本数字与「为什么不修数据」已落 `docs/ops/transcript-ledger-inspection.md` **§6**；
`docs/api/portal.md` 补了 **§4.4b**（这个 #189 端点此前在 API 文档里**根本没有条目**）。

**基线**（main = 根 **1516 / 1512 / 0 / 4**（含 `runner/test`）、`runner` 单独 **342**、前端 **48 文件 / 879**）：
#375 片 ⇒ 根 **1521 / 1517 / 0 / 4**、前端 **885**；#377 片 ⇒ 根 **1529 / 1525 / 0 / 4**、`runner` **347**、
前端 **883**。两片都 merge 后预期 根 **1534 / 1530**、`runner` **347**、前端 **890**。
变异（每条先证只改 1 行、跑完立刻还原）：`range` 强制 `null` ⇒ **恰 3 红**（旧 4 格全绿）；`truncated`
写死 `false` ⇒ **恰 1 红**；摘掉 `worker.js` 的 `diagnostics` 接线 ⇒ **恰 1 红**（源码级哨兵，行为格①
**不红**——它自己传了 `diagnostics`，这正是「行为面测不到的接线必须单独钉」）；`http.js` 白名单去类型
⇒ **恰 2 红**；前端 `EVENT_TYPES` 去类型 ⇒ 前端 **3 红** + 跨层哨兵 **1 红**。

**遗留更新（2026-10-25，erix-agent 0.25.0 已升 pin，见 §8.60）**：**#371-E 已实测交付**——会话级归档去重
在**本站折叠后的 `load()` 形状上命中**（三条老正文 3/3 命中；反向对照「剥掉 `foldedPayload`」⇒ 命中归零），
判据落在 `portal/test/fold-archive-dedup-on-station-load.test.js`。机制：引擎 pre-seed 扫的是
`record.foldedPayload`，而本站折叠从不改写它（③ 格钉住）。**遗留**：#371-C（`record` + `folded_payload` 双列存储去重）等按新归档尺寸重新量收益；
#371-E（归档去重**命中性**）：erix-agent **0.25.0 已上 npm**（2026-10-25 02:14，上游 PR #463 merged；`latest` 已是 0.25.0），但本站 pin 仍 0.23.0 ⇒ 待升 pin 片后实测判据 `foldedPayloadMeta.dedupedMessages > 0`——本站
`load()` 现在过 #351 的 `foldLedgerRecords`，消息形状被改写就可能**指纹命不中**，那是要改代码的；
上游 erix-agent **#462**（resume 按 `foldedThrough` 裁剪）只做性能，不动。⚠ **#415 未修** ⇒
`runner/lib/transcript-fold.js` 与 `portal/src/transcript-fold.js` 的**解链闸必须留着**。

### 8.60 引擎升 pin 0.23.0 → **0.25.0**：契约把三处散文判据变成了红格（2026-10-25，分支 `feat-261025-01-erix-agent-0.25.0`）

**这**不是**「只追版本号」的升级**（对比 §8.53 的 0.22→0.23 那一票：那次 `diff -r` 关键面逐字节相同）。
0.24/0.25 改了 **52 个 src 文件**、新增 6 个模块（`fold-archive` / `pending-tool-result` / `deliverables` /
`resume-notice` / `slot-provider` / `normalization` / `text/repair-json`），并把三条原先只写在散文里的
宿主义务**变成随包契约断言** ⇒ 升级当场翻红 **14 格**，每一格都对应一处本站的真实欠账：

| 红格 | 上游改了什么 | 本站怎么办（**不是**把断言改绿） |
|---|---|---|
| `station-portal-adapter` 折叠 ×4（`test/contract/transcript-store.js` #401/#458） | 上游 #458 把「**宿主 `store.load()` 必须返回折叠后形状**」变成契约判据 | `portal/src/transcript-store.js#load` 接 `foldLedgerRecords`。**#337 当年「故意不折」的顾虑没作废**：幂等判据实际走 `loadByDedupKey` 点查（照旧不折），且 `:input:` 行不带 `kind`/`seq` 根本折不走 ⇒ 两条同时成立，`transcript-fold-wiring.test.js` 把**两个方向**都钉住（load 必须折 / 两个探针必须不折） |
| 折叠对拍 ×4（`transcript-fold.test.js` / `store-load-fold.test.js`） | `message-rows.js` 加 `stampRowTs`（#439 A：折叠时把**行级 `ts`** 盖到消息上，只盖非分片支路）+ 「载体已有同一批正文（忽略 `ts`）⇒ 消息行当**重复副本**丢弃」的幂等判据 | 两份镜像（`portal/src/transcript-fold.js` / `runner/lib/transcript-fold.js`）**同时**加 `stampRowTs` / `withoutJournalTs` / 幂等丢弃，SHARED 区仍逐字节一致 |
| `#309 上游前提` | wrap-up 的 judge 请求从 `orchestrator.js:3474` 搬进 `reflection/wrapup.js`，改写成 spread | **副作用没变**（宿主 `maxTokens` 仍继承）⇒ 换锚点不换判据，注释写明「搬家要跟着换、不许删断言」 |
| `executionStatus` 枚举 | `tool-fact.js` 加第三个值 **`rejected`**（引数解析失败，工具**从未执行**，上游 #409） | 前端 `SPECIAL_EXECUTION_STATUSES` 加值 + 两处注释「两种」改口径；这张表**必须跟着上游常量走**，手抄已经错过一次 |
| `tree` 首行 ×3 | 上游自己实现 #358：**非根目标首行 = 相对根的完整路径**（`nested/sub/`），并且不存在的路径抛的是引擎自己的「路径不存在」而非 fs 的 `ENOENT` | ①本站入口判据 `isRootFormPath` 有个**潜伏真 bug**：`startsWith('./')` 把 `./nested/sub` 当成根 ⇒ 整棵树退化成根目录（模型看到**错目录的树**）。0.23 时代上游自己也不区分所以没炸，是上游的修正把它**揭出来**了 ⇒ 改成逐段判；②两条本站旧断言按新契约改写（`deeper/`→`sub/deeper/`、`code==='ENOENT'`→文案含「路径不存在」） |

**#415 的判定（重要，别照字面撤闸）**：0.25.0 修的是**写侧**（`orchestrator.js:3927`
`if (toolResultRowKey === undefined && …)` ⇒ 新账本的 `partOf` 全部直指链头），但**读侧
`message-rows.js` 的 `parts.set` 仍恰好一处**（分片分支照旧不登记）⇒ **现网 0.23 时代的链式行上游依旧解不了**。
结论：**两份镜像的解链闸必须留着**，服务对象从「所有链」缩成「存量链」。判据因此从「依赖引擎真产出链」
改成**合成夹具驱动**：`portal/test/session-view-fold.test.js` 拆成两格——① 真 0.25 引擎 ⇒ `partOf` 直指链头
（上游若改回写链，这条先红）② 手工还原 0.23 链式形状 ⇒ 本站仍折回 1 条聚合 `tool_result`
（撤闸即红）。撤闸的真判据 = 巡检 SQL 确认存量链式 `partOf` 清零，不是「上游版本号涨了」。

**#371-E 当场验掉**（判据见 §8.59 与本节末）：会话级归档去重在本站折叠后的 `load()` 形状上**命中**，
新文件 `portal/test/fold-archive-dedup-on-station-load.test.js`（5 格：命中本体 / 剥归档⇒归零的反向对照 /
折叠不许动 `foldedPayload` / 两份镜像一致 / 指纹语义）。变异：让折叠顺手丢 `foldedPayload` ⇒ **恰 3 格红**。

**基线**（判绿 = 退出码）：根 `node --test` **1553 项 / 1549 通过 / 0 失败 / 4 跳过**；`runner` 单独
**359 / 359 / 0**；前端 **48 文件 / 885**、`vue-tsc` 干净。根计数比 §8.59 记的「两片都合 1534/1530」涨得多，
是**随包契约套件本身长大了**（0.25 的 #401/#458/#439/#358 新判据都算在根里）+ 本站新增 19 格。
`erix-agent` 三处版本 tripwire（`terminationReasons.ts` + 其 spec + `runner/test/llm-timeouts.test.js`）
同步到 `0.25.0`；`termination.js` 与 `providers/openai.js` 的 diff 逐条读过：`termination.reason` 取值集合
未变，provider 侧改动不影响本站 LiteLLM 通路（三相超时与 `max_tokens` 口径的用例全绿）。

### 8.61 部署后复查推翻了自己：#375 的「假 404」有**更早的真病根**，与 erix-agent 0.25.0 无关（2026-10-25，v0.1.34 部署当场验出）

v0.1.34 起来第一件事就是拿真机那条砖会话（`9e0c8a17`）验 #375 的重建路，结果**三轮折叠全部照旧 404**
（`folded_payload_not_found`）。而 `rebuildFoldedRange` 单拎出来跑得好好的（range 1–94 扫到 210 行、投影出
112 条 turn）⇒ 病不在重建，在**取哪一行**。

**真病根**：`getFoldedPayload` 取折叠行用的是 `WHERE round=$2 ORDER BY append_seq ASC LIMIT 1`。
一个 round 在账本里有**多行**（引擎轮行 + 逐条消息行 + 折叠发生时**追加**的那一行），而折叠指针
（`folded` 位、`foldedRoundRange`、`folded_payload`）**只长在最后那一行**。真机 round 100 实测：
`append_seq` 1818（轮行，`folded_payload` 是 JSON `null`）/ 1819 / 1820 / **1821 = 折叠行**
（`folded=true`、range `{1,94}`、归档 550 KB）。`LIMIT 1` 挑中的是 1818 ⇒ 两条路都拿不出正文 ⇒ 404
⇒ 前端「原文已不可用（上游未保留折叠前载荷）」。**这条从 #189 起就错着**，跟 0.25.0 的差分归档只是
叠在一起，我之前把它整个记在 0.25.0 账上，是**只读了代码没跑真账本**的代价。

修法：该轮**取多行**（`LIMIT $3`，上限 64——一轮的行数极小）再显式挑：`folded===true` 且带指针/正文
⇒ 任意带 range ⇒ 任意带正文 ⇒ 都没有才退回第一行并照旧 404。fake pool 原来 `.slice(0, 1)` 模拟 SQL，
**等于把「挑错行」这个病从测试里抹掉**（AGENTS §8.42「fake 必须模拟真库形状」的反例），现改成返回
该轮全部行；新增两格行为判据（真机形状：折叠行在最后 ⇒ 200 且 range 上界那轮必须在；反向：该轮真的
什么都没有 ⇒ 仍 404）+ 一格源码级哨兵（SQL 里不许再出现 `LIMIT 1`、必须取 `folded` 列、必须显式调
`pickFoldCarrierRow`）。**变异**：把挑选改回取第一行 ⇒ **恰这 2 格红**（老 10 格全绿，说明旧测试对这个
病是瞎的）。同型病灶排查：`grep -rn "transcript_rounds" portal/src/*.js | grep -i "limit 1"` 零命中，
U7 `recallTranscript` 是范围扫（`LIMIT 2000`）不受影响。

**教训（写给自己）**：一个 404 文案说「上游没保留」的 bug，正确动作是**先去账本里把那一行捞出来**
（`select append_seq, folded, octet_length(folded_payload::text) ... where round=100 order by append_seq`），
而不是照着上游 CHANGELOG 讲故事。§8.59 里「病根 = 0.25.0 差分归档」那句要按本节理解：**差分归档是
第二层病**（会让重建只剩差分），**取错行是第一层病**（让端点压根看不到折叠行）。

### 8.62 「查看原文」满屏「（无文本内容）」是渲染层的谎（2026-10-25，#384）

#375 两层病修完、真机验收时用户第一眼看到的是：正文确实出来了，但**夹着二十几行「（无文本内容）」**。
先去账本量而不是先猜（§8.61 那条教训的直接应用）：容器内直调 `getFoldedPayload` 把 112 条 turn 的
形状分布打出来 ⇒ `text` 为空的有 **40 条**，而它们**全部带着 `toolCalls`**，`reasoning` 更是 91/112 条非空。
样例那条 turn 里有 `reasoning`（"The user wants to pull code…"）+ 两条 `shell` 的 `tool_use`——**活干了，
只是没写正文**。

病根是一行模板：`{{ turn.text || t('stream.folded.originalEmpty') }}`。DTO 的 turn 有**四类**内容
（`text` / `reasoning` / `toolCalls[]` / 是不是 user 说的），模板只画第一类。修法就是四类都画
（user 身份标记 → 灰斜体 reasoning → text → 每个工具一行 `🔧 名称｜argsSummary`，`isError` 标「失败」），
占位符语义收窄成「四类真的都空」。数据侧一行没动：`toolCalls[].argsSummary` 与 `reasoning` 上游投影本来就在给
（现网 98/98 工具调用带 `argsSummary`）。

判据变异恰 1 格红（删掉工具行那个 `div`）。**已知不足另单跟**：重建路上 `resultPreview` 实测 **0/98**——
工具**结果**在紧随其后的 `tool_result` 块里，`projectTranscriptForDisplay` 不做配对（主消息流那条预览是靠
`tool_calls` 表 join 出来的，见 §8 里 #282 那段），所以原文里看得到"调了什么"看不到"返回了什么"；要补是
后端 `rebuildFoldedRange` 那侧的一片，不是前端。

**通用教训**：一个「数据没取到」的观感，先证明**它到底取到了什么**（把 DTO 的形状分布打出来：
`role/text 有无/toolCalls 条数` 一张计数表就够），再决定改哪一层。这次如果直接去改后端配对，就会花一整片
的预算在一个纯前端问题上。

### 8.63 折叠横幅三件套：收起入口（#388）+ markdown（#389）+ 「没有真摘要就别画展开控件」（#390-A）（2026-10-25）

一片做完三张单，全在 `StreamPanel.vue` 那一块。**后端一位判据 + 前端两处渲染**。

**#390-A 判据落在后端**：`portal/src/session-view.js` 新增 `hasRealSummary(record)`，DTO 的
`folded.hasSummary`（boolean，**宿主判定、不是上游字段**）。判据直接抄上游契约
（`erix-agent/src/store/file.js:25` / `store/memory.js:19` 逐字同款：`summary?:{action:string,note:string}|"missing"`）：
只有 `{action,note}` 且至少一项非空才算有；**字面量 `"missing"` 是上游的「没有摘要」标记**（现网 17/17 条
折叠行都是这个值），缺键 / `{}` / 两项全空 / 数组都算没有。**存否与 `round` 绑同一个守卫**：轮号取不到
就整个不带这个键，前端把「缺席」当「不知道」，不许当 `false`（否则旧数据凭空丢掉展开控件——变异 ④
把 `!== false` 写成 truthy 判定，**恰有 6 格红**，其中 5 格是旧用例，说明这条红线本来就有护栏）。
另钉一格**上游契约哨兵**（读随包 `store/file.js` 的形态串），上游哪天改标记就得重核判据。

**#388 收起**：原文块原来挂在 `v-if="foldedOriginalState(en)"`，**不在 `isFoldedExpanded` 管辖内**
⇒ 标题「收起」只收起摘要，836 KB / 157 条 turn 的原文孤儿地挂在页面上，而 `.view-original` 再点只是命中
缓存 ⇒ 展开后根本没有收起入口。现在可见性收进 `foldedOriginalVisible()`（横幅收起 ⇒ 摘要与原文一起收起；
原文块自带 `.folded-original-collapse`，**只隐藏不清缓存**——判据是「收起再展开后 `fetch('/folded/')`
总次数仍为 1」，专门防「收起 = 删缓存」那种假修法）。`loadOriginal` 顺手展开横幅并解除本地收起
（否则收起态点「查看原文」等于没反应）。

**#389 markdown**：摘要与原文 turn 的 `text` 改走站内既有的 `renderMarkdown()`（先转义后格式化、标签白名单、
href 只放 https，助手气泡本来就是这条路），`<pre>` + `whitespace-pre-wrap` 换成 `div.md` + `v-html`
（markdown 自己重排，叠加 `pre-wrap` 会双倍行距）。**`reasoning` 与工具行刻意保持纯文本插值**并有反向判据
钉住（模型独白和 `ls -la *_all*` 这种一格式化就出鬼）。成本实测过再决定做不做：真机 round 137 的 157 条
turn 全量渲染 **text 7 ms / reasoning 13 ms** ⇒ 性能根本不是理由，也不需要虚拟滚动。

**判据**：根 **1564 / 1560 / 0 / 4**、runner **359 / 359 / 0**、前端 **48 文件 / 896**、`vue-tsc` 全 0
（前端新增 10 格、后端新增 3 格；变异四次：①去 `isFoldedExpanded` 前置 ⇒ 恰 1 红；②「收起原文」改成清缓存
⇒ 恰 1 红；③原文 `v-html` 改回插值 ⇒ 恰 1 红；④`!== false` 写成 truthy ⇒ 6 红）。

**并行作业的两条环境教训**（这次真踩到）：
1. **主检出正被另一个 session 编辑时不要在里面干活**——我用 `git worktree add ../wt390 origin/main` 开独立
   检出（三处 `npm ci` 各 <1 分钟），主检出的他人未提交改动一行没动。**别在别人的工作树上 `git checkout`**：
   我建分支建在主检出，害得要先 `git checkout main` 把分支删掉才能建 worktree。
2. **别在这台机器上同时跑两套重活**。子代理报「基线就有 3 条 `GitLightBadge` 失败 + 2 条偶发红」，
   我单独跑该文件 **18/18 绿**、连跑两次全量 **896/896 绿** ⇒ 那 3+2 是**我并行跑根测试把它压出来的**，
   不是预存失败。子代理的基线数字必须自己复算一遍，不能照抄。


### 8.64 对话输入队列：运行中可说话（转向 / 排队），pi 的两条队列落到 DB（issue #370，2026-10-25，分支 `feat-261025-01-chat-input-queue`）

现象是一句很日常的话：**任务在跑时输入框是灰的**。前端 `send()` 见 `activeRunId` 静默 return（连报错都没有），
后端 `postMessage` 撞 `ACTIVE_RUN_STATES` 409。参照系是 pi / pi-web（本机 `~/.npm/_npx/…/pi-agent-core` 与
`/tmp/pi-web-agegr`），它有两条队列：`steer`（转向：当前轮跑完就停下用这句继续）与 `follow_up`（排队：任务
正常结束后依次发）。**照抄三条口径，改造三处本站化**。

**照抄的三条**（证据在 #370「参照系」节，动 `portal/src/queued-inputs.js` 前先读那条）：① **入队还是直发必须在
服务端事务内判**（pi `agent-session.js:1633` 读完 `isStreaming` 就分岔，中间不 await）——反过来「前端先看 running
再决定调哪个端点」在「点发送那一刻 run 刚好结束」时会退化成 409，pi 注释管这叫 *strand a message in an idle
queue*；② **只有整队取回，没有单条删除**（pi `clear_queue`：单条删要和 loop 的 pull 竞态）；③ **停止不清队列**
（pi `agent.js:218` `abort()` 不碰队列），aborted 轮留下的 follow_up 在下一次终态自动带出。

**本站化的三处**：① 队列落 **DB**（`queued_inputs`，迁移 `0024`）而不是 pi 的内存队列——pi 自己的注释承认
"dead wrapper (no state) means the queue is gone"，而不变式 3 是「DB 是状态真相」，实测症状就是**关页面 = 那句话
蒸发**；② 投递由 portal 在 **run 终态**驱动，不是浏览器的 `agent_end` 回调 ⇒ 关页面也照发；③ `queue_update`
是**状态帧不是历史事件**：信封要求 `run_id NOT NULL` 而入队时压根没有 run，所以它不落 `run_events`、不进历史
白名单，刷新后靠 `GET /api/sessions/:id` 的 `session.queued_messages` 全量补齐（前端三处集合各漏一处的症状
不同，#288 已证，这次一格 `es.emits('queue_update').length === 1` 钉住监听面）。

**转向的实现路径没有动引擎**（这是本片最省钱的地方）：erix-agent 0.25.0 的 `onRound` 是**被 await 的**、且
**在本轮 transcript 落库之后、`round_end` 之前**才响（`src/loop/orchestrator.js:4342`），而轮循环**圈顶先查一次
中止**（`:3722`）。一「轮」= 一次 provider 调用 + 它的工具执行 ⇒ 在 `onRound` 里 `abort()` 得到的正是
「当前轮工具调用全部跑完、下一次 LLM 调用之前」，**与 pi 对 steer 投递点的定义逐字重合**。
两条引擎红线写进代码注释：**抛错不是控制流**（#173：观察者抛错只记一笔、run 继续，要停只认 `signal.abort()`）、
**不得在 `onRound` 里 park 等输入**（它被 await，park = 静默卡 run，拿 90s 租约与 #288 静默看门狗冒险）。
配套：**转向只写 `cancel_requested_at`、绝不写 `status='cancelling'`**——`cancelling` 是「worker 立刻按进程组
SIGKILL 正在跑的工具」的开关（#211），而转向要「本轮跑完再停」；「这次 abort 是转向还是用户按了停止」的判据
落 `queued_inputs.interrupted_run_id`，**run 状态机与 termination reason 零改动**（runner 只在 `detail` 补
`steered`，用例钉住「不改 reason / 不覆盖引擎给的 detail」）。

**五条终态产出点必须全部接线**（`finishRun` / `releaseRun` / `reapExpiredRuns` / 停止端点的直接终态分支 /
offboard 收敛）。它们不在一条调用链上，加第六处时没人会回头改前四处，漏一处的症状是「队列偶尔静默卡死」
而界面毫无线索 ⇒ 把「谁调了它」写成断言（`portal/test/queued-inputs-wiring.test.js`，含「`queued-inputs`
不得 import `internal.js`」与「`sessions.js` 不得反向 import 它」两条依赖方向红线——后者是我自己先写出环来，
被断言逼着把快照挂载移到 DTO 出口才拆掉的）。

**过程中被测试抓出来的两个真 bug**（都不是测试迁就代码）：① `executeWithIdempotency` 约定的 fn 返回形状是
`{statusCode, response}`，我按业务结果写 ⇒ 无 key 时靠对象展开蒙对、**带 `Idempotency-Key` 恒 500**；
② 幂等台账里存的必须是**响应体**而非业务结果，否则回放给出裸 DB 行（多 `session_id`/`status`/
`interrupted_run_id`），首次与回放形状不同 ⇒ 改成两条路共用同一个 `queuedInputResponse()` 映射。
前端也抓到一处：服务端裁决成直发（`{posted}`）时**永远不会有 `queue_update` 到达**，乐观条目必须手动摘掉，
否则那句话同时以「已发送气泡」和「待发送」两种身份挂在界面上。

**拍板点三条已全部落定**（原文与理由在 #370）：每条 follow-up = 一个新 run（各带一份 `maxRounds=16` 预算）
+ `runs.trigger_kind` 先测量两周再决定是否合并投递；容器不在 ⇒ **不投不丢** + `blocked='container_not_running'`
让界面说清「为什么还没发」；按钮叫**「转向」**不叫「打断并转向」（5 个字会在用户最需要按下它的那一刻吓到他）。

**自评轮抓出的四条，全部先写红测再修**（不是合并前的礼貌扫一眼，是真去找「我的测试测不到的地方」）：
1. **`CLAIM_STALE_MS` 是一根没人读的光纤**（#331 前例）：迁移注释与本模块注释都承诺「`claimed_at` 过期可被
   重新认领」，但 pick 与 CAS 两条 SQL 都只认 `status='pending'` ⇒ 认领后崩在建 run 之前的那行**永久停
   在 `delivering`**：不投递、取不回（recall 只动 pending）、还算在 20 条上限里。修法是 pick 与 CAS 共用
   同一条 CLAIMABLE 判据（pending 或过期 delivering），两处必须同源否则「选得出来却永远抢不到」。
   ⚠ **这条行为测试天然测不到**：判据在 SQL 里，而假池自己实现了一份同判据的 JS —— 变异「把 pick 改回
   只认 pending」实测 **25/25 仍然全绿**。必须补源码级断言（`queued-inputs-wiring.test.js`），补完变异才红。
2. **队列投递出去的 run 前端根本不认识**：本站前端只有两条路知道活跃 run（自己 POST 的响应、会话详情的
   `active_run_id`），队列投递两条都不走 ⇒ 旧 run 的 run_end 到了就清空运行态，新 run 在跑而状态条显示
   空闲；更糟的是新 run 自己那条 `run_end` 因 `d.run_id !== activeRunId` 被整条丢弃 ⇒ **终稿永不刷新**。
   修法：`queue_update` 带 `delivered_run_id`，前端仅在 `activeRunId == null` 时接管（不抢用户正在看的那个）。
3. **转向会把「重试上一条」点亮**：转向也是 `reason=aborted`，落在 `RUN_FAIL_REASONS` 里 ⇒ 用户刚说「用这句
   继续」，界面却给一个「把上一条原话重发」。用 `termination.detail === 'steered'` 抑制，**不动 reason 集合
   本体**（它还管 #306 的补拉 history）。
4. **`send(override)` 会被队列委派静默吞掉**：`retryLast()` 传的是原文，而运行中那条委派走
   `sendQueued` 读的是输入框 ⇒ 该重发的那句丢了、反倒把草稿排了队。改成带 override 不进队列，
   把「不许串味」写进结构而不是依赖调用方永远记得守。
自评还顺手发现自己写的一个**空操作断言**：`applyRetryFaceOnRunEnd` 没导出，`(store as any).fn?.()` 调的是
`undefined?.()` ⇒ 改前改后都绿，等于没测。改成驱动真实 `run_end` 帧，并同时钉「普通 abort 仍要亮」。

**判据**：根 **1604 / 1600 / 0 / 4**（基线 1564，本片新增 40 格：判定表 22 + HTTP 面 10 + 接线防漂移 6 +
迁移 1 + runner termination 1）、前端 **50 文件 / 916**（基线 896，新增 20 格）、`vue-tsc` 全 0。
被本工单**有意改掉**的旧断言四处，均已在注释写明（`sendDisabled` 运行中不再为 true ×2、ComposerBar 运行中
键位 ×2、`buildFailureEnvelope` 入参表 ×2 处跨两文件）。

**⚠ 运维坑**（§8.17 同型）：`steer_arm` 与 `onRound` 全在 **worker 进程**里 ⇒ 必须重建 FDE 镜像并
`docker rm -f` 掉全部 `fde-*` 容器；旧容器收到 `steer_arm` 当未知 IPC 类型忽略，症状是「按了转向、run 照跑到
自然结束、转向的话在终态后才发出」——功能退化不报错，极易误判成「已经生效」。

### 8.65 引擎升 pin 0.25.0 → **0.26.0**：折叠替代物有了投递出口，`judge_done` 不再终局零正文（2026-10-25，分支 `feat-261025-09-erix-agent-0.26.0`）

上游这五单（erix-agent #468 / #472 / #474 / #471 / #477）已 squash 进 `main` `aef25b0d`，并随 **0.26.0** 上 npm（2026-10-25，`npm view erix-agent version = 0.26.0`，发布走的是 AGENTS §4 那套 npm12 device-flow）。
与 §8.60（0.23→0.25 当场翻红 14 格）不同，**这次只翻红 9 格，而且全是同一种形状**：两处把引擎版本钉成常量的**版本线闸**——`runner/test/llm-timeouts.test.js:48` 的 `ENGINE_VERSION_PINNED`（一个常量拖住 4 格，根测与 runner 测各跑一遍所以看起来像 8 格）与
`portal/frontend/src/lib/terminationReasons.ts:45` 的 `ENGINE_VERSION_FOR_TERMINATION_REASONS`（连带 `portal/test/termination-contract.test.js` 与前端 spec 共 1 格 + 1 格）。闸门原话是「版本变了必须**先人工复核**再改常量与文档」，所以复核做在改常量之前：

| 线闸要求复核的东西 | 复核方法（实做，不是读上游 CHANGELOG） | 结论 |
|---|---|---|
| `termination.reason` 全集 | 两个**已安装**版本的 `src/loop/termination.js` 字面量集合逐一对照 | **两侧完全相同**：`aborted / end_turn / failed / judge_done / max_rounds_cap / no_tool` ⇒ 常量与前端码集**不动** |
| 超时相语义（四相 vs legacy 120s 总闸） | `diff -rq <0.25.0>/src/providers <0.26.0>/src/providers` | **整目录 0 差异**，超时相关模块一个没碰 ⇒ `llm-timeouts` 断言前提不变 |

真正变了的是**强制收尾白名单**：`["max_rounds_cap","stall","continuation_exhausted"]` → **追加 `judge_done`**（#467）。⇒ 本站新增一条验收口径：**终局可不可信要看 `termination.forcedFinal`，不能只看「有没有正文」**；引擎代写的正文带 `forced-final` 标记（#323 的 marker 规矩），呈现时不允兆冒充模型自答。
⚠ 同一个洞在 `end_turn` / `no_tool` 上**仍在**（上游 #475 / #476 未动，评审判据侧是 #473），所以**别写成「任何终局都有正文」**。

新增的宿主可用面（本站下一片接）：`record.foldedFacts`（每次折叠的有界机械索引，默认 `FOLDED_FACTS_MAX_BYTES = 2048`）与 `context.onFoldSummary`（折叠定稿那一刻投递 `{ ...foldedFacts, round }`；钩子抛错只落 `persistence_error{operation:"onFoldSummary", phase:"fold_summary_delivery", fatal:false}`，永远不改 run 结果；不传则逐字节不变）。
**C 片**用它做折叠入注（不再轮询账本），**D 片**用它把横幅从「272530→5004 压缩比」改成「N 轮原文对模型不再可见」并如实标 `src` 两态（`strategy` / `llm`）。另 `compaction.strategyName` + 一次性 `compaction_strategy_fallback`（#464 A）已可用 ⇒ PR #400 A 片选的 `fold-statistical` 从此**能被证明真的在跑**，不用再靠猜。

门禁（本机 worktree 实测，判据 = 退出码）：根 `npm test` **1608 / 1604 通过 / 0 失败 / 4 跳过**；`cd runner && node --test` **360 / 360 / 0**；前端 `vue-tsc --noEmit` 干净 + `npm test` **50 文件 / 920 全过**。
本次动的文件：pin 两处（`package.json`、`runner/package.json`）+ 两份 lock；版本线闸三处（`runner/test/llm-timeouts.test.js:48`、`portal/frontend/src/lib/terminationReasons.ts:45`、`.../terminationReasons.spec.ts:61`）；本节 + §8 标题的 pin 口径。

⚠ **顺带修正一条本站旧结论**：容器 `/home/erix/.erix/config.json` 三个槽位此前**都没有** `contextWindowTokens` / `maxOutputTokens`，模型名还是上游已撤的 `deepseek-flash`。
**线上 run 不受影响**（模型与预算走 portal 心跳下行，网关 `LiteLLM_ProxyModelTable` 实查 `context_window=262144` / `max_output_tokens=32768`，runner 的 `resolveModelMetadata` 拿到的就是这两个数）；但 **e2e 与 CLI 读的是占位文件**（`resolveRunModel` 无下行时取占位 model，endpoint/key 永远取占位）⇒ `modelMetadata` 不成对 ⇒ `modelMetadataMissing` ⇒ `examples/pi-extension/erix-run-e2e.test.js` 的 **E6「装配自查」恒红**（上游 `ERIX_E2E_REAL=1 npm run check:release:real` 的 4/5 就是它）。
2026-10-25 已给三个槽位补齐两键并把模型名改成 `qwen3.8-flash-next`（备份 `config.json.bak-20261025`；两个数字的来源：网关错误原文 *"maximum context length is 262144 tokens"* 与 `/v1/models` 的 `max_output_tokens: 32768`，与网关配置一致），补齐后真上游五步 **5/5 全绿**。
**结论：占位文件里这两键不是可选项**——它决定 e2e 能不能跑、以及 CLI 手工验证时压缩是否真开；别当成冗余删掉。

### 8.66 折叠摘要入注（issue #392 C 片）：折一次记一次，摘要不再是「产出来就扔」（2026-10-26，分支 `feat-261026-01-fold-notes`）

A 片（§8.65 前后的 `context.strategy='fold-statistical'`）只解决「折叠**产出**替代物」；替代物产出之后
没人投递，用户侧感知与「静默硬删」完全一致——摘要生出来就扔了。本片补上投递这一环，让
**折一次记一次**成为可验证的不变量。

引擎侧 0.26.0 已把出口给全（本站不往引擎加任何东西）：`context.onFoldSummary(payload)`，
`payload = { ...record.foldedFacts, round }` = `{ text, source, chars, bytes, truncated, round }`；
契约三条边界都写在引擎里——**无 text 不调用**、宿主回调抛错只落
`persistence_error{operation:"onFoldSummary", phase:"fold_summary_delivery", fatal:false}` 不杀 run、
不接这个回调则行为与 0.25.0 逐字相同。投递方向是**宿主的事**（erix-agent#470 定调：引擎里没有
notesStore 句柄，也不该塞 fs/DB）。

落地位置（三处，前两处是新增文件）：

| 位置 | 职责 | 为什么切在这儿 |
|---|---|---|
| `runner/lib/fold-notes-key.js` | 纯函数：key 与正文 | 零依赖 ⇒ 单测能把 key 形态钉死，不必装引擎 |
| `runner/lib/fold-notes.js` | 投递 + 失败纪律 + 序号 | 只有这里知道 `noteTools.executors`，也只有这里该知道 |
| `runner/worker.js` `#392:C-fold-notes` / `#392:C-onFoldSummary` | 装配 + 条件接线 | 判据从源码抠值求值，删掉那行必红（技法同 A 片） |

四条写在代码里的硬约束：

1. **key 必须能排时间线，且永不重复**。同 scope 下 key 就是笔记 id：固定 key ⇒ 第二个 run 的第一次折叠
   撞重复、注直接丢掉、台账从此只有一条。key 还必须过 store 的
   `SAFE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/`（`erix-agent src/store/notes.js:47`），不过就被哈希成
   `h<digest>`——人在 `note_list` 里既读不出顺序也认不出是哪次折叠 ⇒ 时刻用 **basic 形态**
   `fold-20261026T021530Z-r57-s1`（带 `-` `:` `.` 的 ISO 过不了这条）。
2. **投递处不传 `scopeRef` / `runId`**。作用域由 B 片的工厂绑定成 `sessionId`；这里再传一次就是伪造
   `__erix`，会把注写回 run 目录，正好抵消 B 片的收益（判据 C7 / C13）。
3. **写注失败绝不打死 run**：笔记是台账不是事实源，失败只上报 `fatal:false`（连上报通道自己抛错也不
   传染，C8 / C9）。
4. **无 text 不写空注**：引擎契约是本不该调用；真被调到算异常形态，只上报（`reason:'no_summary_text'`），
   不写一条空笔记在 `note_list` 里冒充「已存档」（C6）。

`pinned:false`——pinned 的唯一豁免是 memory，折叠摘要不算。

**两条已知边界（别当成已解决）**：

- **精确轮次范围 `a–b` 拿不到**：payload 只有 `round`，没有折叠水位线的前后值，也没有 `foldedRounds`。
  所以正文只能写「round N 及之前的原文已退出可见上下文」。要写「折走第 12–57 轮」得让上游
  在 payload 里补 `foldedRoundsBefore/After`（additive，一小格），本片不假装知道。
- **序号是 run 内的**：折叠水位线本身仍是 run 作用域（#462 补的是读侧裁剪，没把它抬到 session），
  所以「第 N 次折叠」在新 run 里从 1 重来。正文里同时写 run id 与绝对时刻，就是为了让读者能自己
  判断这不是全局序号——不谎报。

未做：**D 片**（banner 两态：显示 `compaction.strategyName` 与「已折走 N 轮原文对模型不再可见」）；
`context.keepRounds`（0.25.0 里没人读，A 片已钉死）；env 旋钮（延续 A 片口径：策略与投递不是运维参数）。

验证：`runner/test/fold-notes.test.js` 新增 **13 条**（C1–C13），runner 全量 **386/386**；语法门
`node --check` 204 文件 0 失败。根套件 1634 条里唯一那格红是 `portal/test/termination-contract.test.js`
的 tripwire 读**安装态**引擎版本（本地 `node_modules` 是借来的 0.25.0），CI `npm ci` 下即 0.26.0 ——
它红得正好：那根线闸的作用就是「版本变了必须重开 issue 复核 reason 全集」（§8.65）。

### 8.67 E 片：端到端验「折叠 → 写注 → 注回到模型输入」，当场抓到 C 片是死光纤（2026-10-26，分支 `feat-261026-02-fold-notes-e2e`）

§8.66 的 C 片有 13 条判据全绿。它们证明的是「给定一个 `foldedFacts` 形态的 payload，投递器会把注写对」。
它们**没有**证明：引擎在真折叠时会调用那个回调、以及写出的注会不会回到模型可见输入。补一片端到端
（`runner/test/fold-notes-e2e.test.js`，真 `runToolLoop` + 桩 provider 录下每一份请求 + 真 notes 工厂与
真投递器落真目录）当天就抓到两件事：

**① C 片的接线是错的，而且是本站最经典的那种错。** `onFoldSummary` 我塞进了 `context`，而引擎从
**顶层 options** 解构它（`src/loop/option-normalization.js` 的 `RUN_TOOL_LOOP_OPTION_NAMES` 里有它；
`context` 里目前只认 `strategy`）。后果：折叠照跑、`record.foldedFacts` 照落账、注**一条也不写**、
**且不报错**——#331 那根「没人读的光纤」原样重现，而这次是我自己造的。E2 那一格（`sink.seq() >= 1`）
就是它的探测器：真跑一次折叠，`seq=0` 立刻现形。

教训不是"下次仔细点"，而是：**手工喂 payload 的单测证明不了接线**。凡跨包/跨层的回调接线，判据里必须
有一格是「让对面真的调我一次」。已把它固化成防回装：C14 直接读**已安装引擎**的白名单源码比对，
并断言 `context` 段里再出现 `onFoldSummary` 就红。

**② 注确实回到了模型输入，但形态是小抄，不是全文。** 引擎的 semantic 段渲染成：

```
[notes 小抄目录]（note_read key=... 取全文）
- fold-20261025T184024Z-r1-s1 (@agent): 折走存档：第 1 次折叠（run …）
```

于是 E4 的探针只能取**小抄行里有的东西**（注首行）。第一版我拿正文第二句当探针，得到"注没回去"的
**假红**——这类"探针选错"的假红比真红更危险，因为它会把正确实现判死、把错误结论写进 issue。
所以 E4 之外必须配 E5 对照组（不接 `semanticStateProvider` ⇒ 注仍在盘上、但请求里查不到）：
E4 绿 + E5 绿 才叫「注是经 semantic 段回去的」，只有 E4 绿说明不了归因。

**约束（下次调 harnes 别再猜）**：引擎预算
`budget = cw - maxOutput - max(2000, ⌈cw×比例⌉)`（`src/compact/budget.js:23-25`），预留**硬底 2000**
⇒ `context_window: 900` 直接 `Computed context budget must be positive (got -1300)`，四格空转。
本文件用 `6000 / maxOutput 200`：够小所以两三必然折一次（真机要上百轮，那是成本不是机制），又不至于被硬底打死。

六条判据的分工：E1 折叠真发生（否则全是空断言）· E2 真折叠真写注（抓死光纤）· E3 无投递失败且 run 跑完 ·
E4 闭环（小抄进请求 + `note_read` 指引 + provider 真被调）· E5 对照组（E4 的归因兜底）·
E6 同一份替代物**同时**进轮记录 `foldedFacts`（投递与落账不是二选一，#470-B/#470-D 两路都要在）。

**顺带修正 §8.66 的一处措辞**：那里写「精确轮次范围 `a–b` 拿不到」——`onFoldSummary` 的 payload 确实
还是没有范围，但引擎**自己的摘要文本里**带范围（`早期第 … 轮（共 … 轮）已折叠`，见 §8.65 A3 判据）。
所以缺的是**结构化**的 `from/to`（给 DB 与 banner 用），不是"系统不知道范围"。erix-agent#479 的诉求据此收窄。

### 8.68 D 片：折叠横幅补上「谁现在看不见它」——横幅两态 + 事件行显示实例策略名（2026-10-26，分支 `feat-261026-03-fold-banner-d`）

A/B/C/E 四片都在修「折叠丢了东西」，而轴三（**人得知道丢了**）一直只有 #388/#389/#390-A 那半套：
横幅标题说「已压缩第 2–5 轮」，但**「压缩」这个词在用户那里并不自动等于「模型从此看不见它」**。
折叠的全部意义恰在那后半句，而它此前只存在于实现者脑子里。这片就补这半句，顺带把「谁折的」显示出来。

| 位置 | 改动 | 为什么在这儿 |
|---|---|---|
| `StreamPanel.vue` `foldedVisibilityNotice()` | 横幅标题下新增一行，**两态** | 数据全在现有 DTO 里（`foldedRoundRange` + `hasSummary`），**零后端改动** |
| `zh-CN.ts` / `en.ts` `stream.folded.visibility*` | 四个键：有/无摘要 × 有/无轮数 | 措辞必须跟着事实分叉，见下 |
| `useEventStream.ts` + `stream.event.compaction` | 事件行加「策略 {strategy}」 | `compaction` 事件本就带 `strategyName`（erix-agent #464 A），此前没人显示 |

三条口径（都不是措辞偏好，是防说谎）：

1. **两态是必需，不是润色**。`hasSummary === false` 时下面那份「摘要」其实是复述标题的兜底句
   （#390-A 因此已经不画展开控件）。此时若还说「摘要就是它留下的全部」就是**空头支票** ⇒ 无摘要态改成
   指路「查看原文」。
2. **`hasSummary` 键缺席 ⇒ 整行不渲染**，不能当 `false`。存量行没有这个键，当 false 处理等于让旧数据
   凭空多出一句「本次没有生成摘要」的断言——与 #390-A「键缺席 = 不知道，宁可保持现状」同一条纪律。
3. **轮数只从 `foldedRoundRange` 算**（`to − from + 1`）。拿 `foldedPayloadMessages` 报轮数是 #375 已经
   定过性的假话（那字段是「本条记录携带的归档条数」，去重 + 夹断后明显偏小）。无 range 就退成不带数字的
   措辞，**不猜**。

`strategyName` 缺失时显式渲染成「未知」而不是留空：留空会让人以为策略名字是空串，而真相是「这条事件
比该字段古老」。**注意**：引擎只把策略名放进 `compaction` 事件，**不落轮记录**（`roundRecord` 上只有
`folded` / `foldedPayload` / `foldedRoundRange` / `navigationRecord` / `foldedFacts`），所以历史行里
显示不出「谁折的」——这不是本站漏做，是 erix-agent#479 那半格（宿主侧目前只能用 `foldedFacts.source`
近似，两者在降级路径下会不一致）。

判据 5 条：横幅 4 条（有摘要报轮数 / 无摘要不许许诺并指路 / **键缺席整行不出** / 无 range 不报数字）+
事件行 1 条（有 `strategyName` 原样显示；旧的三处文案期望同步成「策略 未知」）。
前端 **925/925**、`vue-tsc` 干净。

**部署口径**：前端在 portal 镜像里 ⇒ 生效只需 portal 换镜像 + 重启，**不需要**重建 `fde-*`（runner 侧零改动）。


### 8.69 issue #404：`containers.image` 必须跟上现实，不是停在开户那一刻（2026-10-26，分支 `fix-261026-01-container-image-ledger`）

现网实测的账实不一致：`fde-eric`/`fde-jim` 跑的是 v0.1.38 的 digest，库里 `image` 还写着 v0.1.37 的；
`agent_version` 停在 `0.1.32-088e41e`。后果不是难看，是**问不出答案**——「这个 FDE 在跑哪个 runner」
只能人肉 `docker inspect`，我这两天的部署核对全这么过来的。

病根是写面的形状，不是某处漏了一行：`image` 只出现在 `onboardFde` 里**「DB 没有行」那条 INSERT** 上。
其余三条路径——① 复用（容器在、env token 匹配）② 重建（有行、token 轮换那条 UPDATE）③ reconcile 的
adopt 分支（`res.created === false`）——**一条都不写** ⇒ 一次开户定终身。所以修法是给三条路径都补写，
而不是改 INSERT。

**写"实际"而不是写"期望"**（这条是本片的判断核心）：adopt 场景里容器可能正是上个版本遗留的，把
`config.fdeImage` 写进去只是把一种谎换成另一种。于是 `ensureFdeContainer` 现在把容器**实际**镜像带回
调用方（adopt 取 `Config.Image`，新建取 create body 的 `Image`），调用方只有一条写法：`res.image` 写账。
唯一写期望值的地方是「token 轮换 UPDATE 之后紧接着就是 create(config.fdeImage)」——那里期望值就是真话，
且 `status='creating'` 已把"还没起来"标出来了。

顺手修同一条路径上的 409：`ensureFdeContainer` 原先只认 204/304，而 **409 是 Docker 在说「它已经在跑了」**
——正是本函数要的终态。并发（reconcile 与 provision-fde 同时动同一个名字）时赢的那一方拿 409 抛错，
reconcile 因此抱怨 `start container … failed: HTTP 409`，把真故障淹在噪音里。现在 409 当幂等成功，且
`started` 保持 `false`：它本来就在跑，不是我们启动的，不许谎报。

判据 3 条：409 幂等（含"必须先查后起"与"不许谎报 started"）/ 新建路径回报实际镜像 / 三条写路径都在源码
契约上钉住（`onboardFde` 全链 fake 成本高，沿用本文件既有做法；`ensureFdeContainer` 真跑）。
provisioner 34/34、portal+root 全量绿。

> **本节写完当场发现的一句话错误，保留在此而不是悄悄改**：原文说"`agent_version` 由心跳自报"，**不成立**。
> 实际链条是 `deploy/.env` 里一个静态 `FDE_AGENT_VERSION=0.1.32-088e41e` →（compose）→ `config.fdeAgentVersion`
> → 建容器时写库、并作为 env 注进容器 → `runner/agentd.js:44` 上报的就是**那个 env 标签**；而
> `portal/src/internal.js` 的 heartbeat 收到 `agent_version`（`agentd.js:421` 确实报了）**从不写这一列**。
> 所以该字段的真实语义是「建容器时我以为版本是多少」，且"以为"的出处是一个没人再动的 .env 值——
> v0.1.40 的容器写着 `0.1.32` 即由此来。修它需要两处同时动：runner 报自己 `package.json` 的真实版本
> （env 仅作 override）+ portal 在 heartbeat 里落账（同值不写，免得每心跳刷 `updated_at`）。详见 #404 结案评论。
>
> **`image` 那一半已实测修好**：v0.1.41 上线后第一个 reconcile tick 就把两行改写成容器实际引用，全长等值。
> 核对时注意读数陷阱——用 `right(image,12)` 比 `docker inspect | cut -c8-20` 会把**同一个** digest 的
> 后 12 位与前 12 位当成两个值，看着像"写平了但写错对象"。**digest 必须比全长。**
### 8.70 版本改成构建产物：`build-info.json` 是运行时唯一真相，env 只剩 override（2026-10-26，分支 `feat-261026-06-version-as-artifact`）

#404 结案评论里定的修法。为什么不是"把那个 .env 值改对"：**它还有第二个来源，就一定会再漂**。
当时的三方各说各话是这样的——

| 位置 | 当时写的 | 真相 |
|---|---|---|
| `containers.agent_version` | `0.1.32-088e41e` | 容器已换过两版 |
| 出处 | `deploy/.env` 一行没人再动的 `FDE_AGENT_VERSION` | 且**重建也不会修正**（重建路径写的还是同一个 env） |
| agentd 心跳上报 | `0.1.0` | `ERIX_AGENT_VERSION` **从来没被任何地方设过** ⇒ 落到兜底常量 |
| 全仓读者 | 无 | API 不返回、前端不显示、reconcile 不判 |

**规则**：未知就写 `unknown`，不要写兜底版本号。`0.1.0` 和 `0.1.32-088e41e` 这两个"看起来合法的假值"
骗过了所有看的人，比空值毒。

| 改动 | 为什么在这儿 |
|---|---|
| `runner/Dockerfile` 构建期写 `/opt/erix/build-info.json` | `station_version` / `engine_version` **从镜像内的 `package.json` 与 `node_modules/erix-agent/package.json` 读**，不从 ARG 传——少一条"必须与构建同步的手工输入"就少一次漂移；只有 `.git` 拿不到的 `revision` / `built_at` 走 ARG。ARG 与 RUN 放 Dockerfile 末尾，把缓存失效压到最小 |
| `runner/lib/build-info.js`（新） | 三级来源 + **绝不抛错**（心跳热路径上读版本不能把心跳打死）：env override > `build-info.json` > 本地 `package.json`（dev）> `unknown` |
| `runner/agentd.js` | 删掉 `\|\| '0.1.0'`；心跳新增 `runner_version` / `build_revision`（additive，旧 portal 忽略） |
| `portal/src/internal.js` 心跳 | 落账 `agent_version`：空/缺 ⇒ **不写**（不许拿 unknown 覆盖上一次真值）；`IS DISTINCT FROM` ⇒ 同值不写，否则 15s 一次的心跳把 `updated_at` 刷成噪音；截断 64 防一个怪 tag 把心跳打成 500 |
| `portal/src/provisioner.js` | `FDE_AGENT_VERSION` 降级成 override：**默认不注入**容器 env；`dev` 是占位、不算钉值（注入它等于让占位冒充上报值） |
| `.github/workflows/release.yml` | 传 `STATION_VERSION` / `STATION_REVISION` / `STATION_BUILD_DATE` |
| `.github/workflows/ci.yml` | 构建校验里加 tripwire：`build-info.json` 必须存在、`station_version` 必须等于仓库 pin、`revision` 必须等于本次 commit、`engine_version` 不许 unknown |

口径与坑：

- **`agent_version` 的契约语义是 erix-agent（引擎）版本**（`docs/api/portal.md` U4 早就这么定义），
  runner 自身版本另放 `runner_version`。以前三方混用一个字段，正是它腐烂的原因。
- 读引擎版本**不能** `require('erix-agent/package.json')`：那个包的 `exports` 只开 `.` / `./tools` /
  `./contract-tests`，裸 spec 会 `ERR_PACKAGE_PATH_NOT_EXPORTED`；这里按文件路径直接读。
- CI 那段是 YAML 块标量里的 shell + `node -e`：单引号内的行尾 `\` **会**进字符串（JS 里是语法错误），
  所以脚本行一律不带续行符；`EXPECTED` 要靠 `docker run -e EXPECTED` 才进得了容器，只在 shell 里赋值没用。
  两处都用 `bash -n` + `node --check` 真验过，不是"看着像对"。
- 判据里"不许出现 `|| '0.1.0'`"要**先剥注释再查**：本条文档自己就原样引用了被禁的写法，不剥会判据过敏。
- ⚠ **本片上线即炸过一次现网**：`buildContainerConfig` 新增注入 `ERIX_AGENT_VERSION`，但
  `deploy/fde-proxy/server.js` 的 `ENV_KEY_ALLOW` 是**另一个模块**、没同步 ⇒ `provision-fde` 报
  `create_policy_denied: Env key not allowed`，而那时两个 FDE 容器已经被流程删掉，短暂全停。
  单侧测试查不出来（注入方与放行方各自都"对"）。已补白名单 + 一条**交叉核对**判据：
  provisioner 可能注入的键集合必须 ⊆ proxy 白名单。**"我加了个 env"从来不是一句无害的话。**
- 消费面（谁读这列）**本片故意不做**：现网只有两个容器，人一眼看得过来；先把真相做对，读者等有需求再加。
  判据是 `#404` 结案评论里那三条触发条件，不是"以后再说"。
- ⚠ **两个 workflow 文件不在本 PR 里**，不是忘了：本机 `gh` 用的是 OAuth App token，scopes 只有
  `gist, read:org, repo`，GitHub 直接拒绝无 `workflow` scope 的推送（`refusing to allow an OAuth App to
  create or update workflow`）。release 的 build-args 与 CI 的 tripwire 以补丁形式挂在 PR 评论里，
  等有 `workflow` scope 的凭据（或本人）再推。**在它落地之前**：`revision` / OCI label 会是 `unknown`
  （`station_version` / `engine_version` 仍是真值，因为它们从镜像内文件读，不依赖 ARG），
  而"版本没烘进去"这件事暂时**没有自动检查**——就是上面反复强调的"第三问：谁在检查"仍然空着。
- ✅ **已补（2026-11-09，`861d323`）**：两个 workflow 落进仓库了（`git push` 走的是 credential-store 里的
  PAT，**有** `workflow` scope；当初拒推的是 `gh` 的 OAuth App token，两者不是同一个凭据——这条差别值得记住）。
  `release.yml` 新增步骤 ③′ 取 UTC 时间戳 + 步骤 ⑤ 传三个 ARG（`STATION_VERSION` / `STATION_REVISION` /
  `STATION_BUILD_DATE`）；`ci.yml` 步骤 ⑤ 同样传，并新增**步骤 ⑤′**：`docker run --rm --entrypoint cat`
  读回 `build-info.json` 后逐格断言（`station_version` == 仓库 pin、`revision` == 本次 commit、
  `engine_version` 非 `unknown`、`built_at` 非 `unknown`）。
  **端到端已验**（main CI run `42573190051` 两个 job 全绿，日志逐字）：
  `{"station_version":"0.1.57","engine_version":"0.31.0","revision":"861d3231b17d…","built_at":"2026-11-09T06:29:42Z"}`
  ⇒ 修复前实测同一镜像族是 `{"station_version":"0.1.53",…,"revision":"unknown","built_at":"unknown"}`、两个 OCI
  label 也是空串。⚠ 两个 ARG 声明在 Dockerfile **末尾** ⇒ 只让 build-info 层与 label 层缓存失效，不重跑 `npm ci`。
  ⚠ 仍未做：**部署面读这列的人还没有**（`containers.agent_version` 的消费面，§8.70 末段已记）。

### 8.71 #412④：隔离跑的宿主写路径必须**逐条证明与共享栈不相等**，"有没有设"不是判据（2026-10-26，分支 `fix-261026-07-host-write-paths`）

先纠正我自己写进 #412 的一句话：原以为病根是"compose 里 `${TRAEFIK_DYNAMIC_DIR_HOST:-默认}` 这个不安全默认值"。
**不对**：那个默认值是相对路径 `./traefik/dynamic`，而我今晚覆掉生产配置时它**有值**——值是
`--env-file deploy/.env` 从生产 `.env` 里带进来的（`/docker/station-edge/dynamic`）。所以改成必填挡不住：
`--env-file` 永远会填上。缺的不是"设没设"，是**"这个值是不是我这套栈的"**。

判据因此做成"**与共享 `.env` 的值逐条不相等**"：`assertHostWritePathsIsolated({env, envFile})` 读
`deploy/.env`（缺文件则只判绝对路径），对四条宿主写路径逐一比对——

| env | 写错会怎样 | 现网生产值 |
|---|---|---|
| `TRAEFIK_DYNAMIC_DIR_HOST` | **直接改写生产边缘的路由文件**（今晚 502 就是这个） | `/docker/station-edge/dynamic` |
| `ERIX_USERSPACE_ROOT_HOST` | 隔离用户目录落进生产 userspace | `/docker/erix/users` |
| `ERIX_ARTIFACTS_ROOT_HOST` | run 产物混进生产 | `/docker/erix/artifacts` |
| `STATION_DB_DIR` | 两个实例开同一份数据文件 | `/docker/station-db` |

未设置也算命中（未设置 ⇒ compose 用默认值或 env-file 的值，两种都不是"我这套栈的目录"）。
拿真实生产 `.env` 实测：原样使用四个值 ⇒ 直接拒；换 `/tmp/*` ⇒ 放行。

两个刻意的形状，别改回去：

- **这条判据不挂在 `assertIsolatedEnvironment` 里**。各脚本只在 `compose('up', extraEnv)` 传这三个
  `ERIX_*` 路径，`process.env` 里常常没有 ⇒ 挂总断言会误伤所有老脚本，而"判错方向"比不判更糟。
  规则是**谁 `up` 栈谁调**，传 `{...process.env, ...extraEnv}`。本 PR 先接 `wp3b`（我手工起栈踩过的那条路）。
- 没动 compose 的默认值。改成 `:?` 只是把"静默用共享目录"换成"另一种静默"，还会让
  `docker compose config` 这类无 env 的解析场景一起炸——收益低、面大。**先修判据，默认值的事另议**。

另外记一条排障口径：**"容器全 healthy" 不能证明系统没事**。今晚 502 的时候 `docker ps` 六个容器
全 `Up (healthy)`、portal 直连正常，坏的是配置**内容**。判入口要打到真入口：
`curl -o /dev/null -w '%{http_code}' http://station.vc.cn-ai.vip:8090/`，以及 `/api/sessions` 期望 401。

### 8.72 接班部署 v0.1.43 + #351/#352 发布物验收 + 账本**第四种砖化形状**（`:resume` 载体裸重放）（2026-10-27 夜班，本机 = 部署机）

背景：本机 main 停在 `6cffeb9`（#350 时代），另一台主机三天里推到 `v0.1.42`（94 个提交）。接班第一动作是分清**三层**（仓库同步 / 部署面 / 存量数据），别把「issue 还 open」一律当「还要写代码」：仓库已快进到 `0c47329`（干净），但本机仍跑 **v0.1.30**、`FDE_IMAGE` 仍 pin 在 v0.1.25 摘要、DB 缺迁移 `0022/0023/0024` ⇒ `#351`/`#352` 的修复**在本机根本还没生效**。

**为什么发 v0.1.43 而不是直接部署已发布的 v0.1.42**：`v0.1.42` 含 #416（`ERIX_AGENT_VERSION` 下发）但**不含** main 上的 #419 补漏（`fde-proxy` env 白名单没带这个键 ⇒ `provision-fde` 上线即炸 `create_policy_denied: Env key not allowed: ERIX_AGENT_VERSION`）。⇒ 从 HEAD 发新版，别把「有 tag」当「能部署」。

**部署面四件套（本机 uid=1000 才会暴露的那条）**

- ⚠ **`runner/test/listeners.test.js` 的跨 UID 用例在 uid=1000 的开发机上必然红**（fixture 写死 socket owner uid=1000，而实现故意「owner == 自身 uid 就不切换」`ownerKeys.filter(u => u !== selfUid)`；CI 是 1001 所以一直绿）。修法 = `OTHER_UID = (process.getuid?.() ?? 0) === 1000 ? 1001 : 1000`（`53191cd`）。**取证**：改回写死 ⇒ 该用例红；摘掉 `u !== selfUid` ⇒ 1 红；去掉 uid 还原 ⇒ 1 红（`runner/lib/listeners.js` 验完无 diff）。⇒ 这条**不是放宽断言**，是把「主机 uid」从测试的隐含前提里拿掉。
- **四件套基线（本机实测，判绿=退出码）**：根 `npm test` **1656 / 1652 通过 / 0 失败 / 4 跳过**、`node --test runner/test/*.test.js` **399/399**、前端 `typecheck` rc=0 + **50 文件 / 925 通过**（台账原值 1493 / 221→323 / 47 文件 857 均已过期，本次按合并树真值刷新）。
- **发版与部署**：main CI（`53191cd` 与 bump `fafe4a7`）两个 job 全绿后才打 tag（#419 那条 `质量门禁` 显示 `cancelled` 是「我随后又推了一个提交」把在跑的 run 取消了，不是失败）→ tag `v0.1.43` → release `40527305596` success → 清单 portal `imageId=sha256:827ec194…` / `digest=sha256:aa036666…`、fde `imageId=sha256:78ec7b00…` / `digest=sha256:6882cb5a…`、proxy `imageId=sha256:aa91d2fa…` / `digest=sha256:d5453b04…`，三个都 `docker image inspect .Id` **逐位一致**。
- ⚠ **GHCR 直连拉 `fde` 又卡层**（§8.35 那条老坑复发，两次重试都在同一层 `eddb72140443` 0 B/s 耗尽重试）：解法仍是镜像站——`docker pull ghcr.nju.edu.cn/erixwong/erix-station-fde:0.1.43` 一次成功（回来的 Digest 与清单一致），**再按 digest `docker pull ghcr.io/…`** 一次 ⇒ 层已在本地、秒回，于是有 `repo@sha256:` 引用、pin 保持形态①。比手工拼 tar 更省事。
- `deploy/.env` 三项一起 pin（本版 `runner/` 非版本文件有变动 ⇒ 含 `FDE_IMAGE`；备份 `/tmp/deploy.env.bak-0143`）→ `up -d --no-build` → portal 实跑 `827ec194…`、`healthz=200`、日志 `[migrate] applying 0022-port-observations / 0023-preview-miss-stats / 0024-queued-inputs`（**三条迁移是 portal 启动自动应用的**，无需手工跑）→ `docker rm -f` 五台 `fde-*` → reconcile ≈10s 全部落在 `78ec7b00…`，容器内 `erix-agent` = **0.26.0**，agentd `sse connected` + `sse ping received`（§8.18 双向口径）。

**#351 在发布物上的验收（两个方向都跑）**

- **正面对象复活**：标本 `ec8a77b3…`（当年 `index 11`，结果行在、被 `:input:` 插队）发一条消息 ⇒ `finished / judge_done` + 助手正文落库。
- **现跑对照**（不是只信老标本）：新会话 `3fe993c7…` 起 `sleep 120` → 跑到一半点停止（run1 `aborted`）→ **再发一条** ⇒ run2 `judge_done`。**修复前这个动作会把会话永久砖掉**。⚠ 账本里那条插队 `:input:` 行**照样留下**（全库 §5.1 计数 2→3）⇒ **折叠在 `store.load()` 兜住了它，巡检计数 > 0 不再等于会话坏**（这条口径已写进巡检手册 §7.5，别再去「修数据修到 0」）。
- **但另一标本 `1ead0b1a…` 仍红**（`invalid_messages index 50`，v0.1.43 上）⇒ 顺着查出**第四种形状**，见下。

**账本第四种砖化形状（新）：`:resume` 载体裸重放「已在别的轮结清的 `tool_use`」**——折叠救不了（造不出缺失的那条 `tool_result`），只能修数据。判据与手术已整节落 `docs/ops/transcript-ledger-inspection.md` **§7**，这里只留最值钱的三条：

1. **判据必须带轮**。按 id 集合查孤儿会得出「账本干净」的**假结论**（`tool_use` 17 / `tool_result` 16，但「有 use 无 result」= 0——那个 id 的结果在**别的轮**）；而按**记录**判在 0.23+ 上又是**常态误报**（`use` 与 `result` 本就分 `:msg:` 行，实测 9 会话 / 几十行）。只有「同轮任何行都没有结果 **且** 别的轮结清过」精确（本机 = 6 行 / 2 会话，全在 `:engine:round:N:resume`）。
2. **定性是历史化石，不是现行写侧**：两条陈旧载体的 `ts` 是 10-08 与 10-15（旧引擎）；同一天 0.26.0 现跑的 `:engine:round:1:resume` **不带 `messages`**。⇒ 别拿 0.23/0.26 源码去推断老数据（`:resume` 载体的内容口径跨版本变过，§8.40 那条「只写引擎控制文本」对这两行不成立）。
3. **修数据前后都用引擎自己的校验器判**：`1ead0b1a` FAIL `index 36` → 删 1 条陈旧 assistant turn → **PASS**；`3dcab38b` FAIL `index 73` → 删 5 条 → **PASS**；落库 `INSERT 0 1 / UPDATE 1` ×2、备份表 3→2 与 7→2、重放第二遍 `UPDATE 0` ×2、判据复跑 **0 行**、真机两个会话都 `judge_done`（`1ead0b1a` 是 10-23 起连砖 4 次那个标本）。⚠ **我自己的空操作**：第一版生成器把字段名写错 ⇒ `dedup_key = 'undefined'`，两遍都是 `UPDATE 0`，看着像幂等证明其实啥也没写 ⇒ **口径：修数据首跑必须看到 `UPDATE 1`**，并用 `INSERT` 行数 + 备份表的 `jsonb_array_length(before/after)` 双向对一次（§8.24 那条纪律在 SQL 落库上的版本）。
4. `#367`（存量链式 `partOf`）在**本机无事可做**：§1.1 巡检 **0 行**、§6.1 超 1 MiB **0 行**，且它点名的会话 `9e0c8a17…` 在本机 DB 里**不存在**（那是另一台部署的标本）⇒ 这类 issue 的「还 open」是**别台机器的存量**，不是本机的待办。

**#352 在发布物上的验收（观测层，端到端）**

- **跨 UID 真采样**（我修的正是这条路径的单测，所以真机特意造了这个形状）：agentd 跑在 **uid 1001**、两个 `python3 -m http.server` 在 **uid 1000**，`port_observations` 里 22000（池内）与 3000（池外）都拿到了 `pid + cwd=~/projects/probe-351 + branch=main + cmd` ⇒ setuid 重扫在真机上成立（这条在 uid=1000 的机器上单测结构上测不到）。
- **DTO 只做加法**：`GET /api/me/ports` = 原 8 列 + `observed`，11 行 = 池 10 + 池外观测行（`state='observed'`、`hostname/url=null`），`observed=null` 有 9 行 = 「不知道」而不是「空闲」。
- **池外只报「用户的项目」**：`/proc` 里还有 Docker 内嵌 DNS（`127.0.0.11:34957`，uid 0）落了 `port_observations`，但门户按 `cwd` 是否 `~/projects/` 过滤掉（`portalloc.js` 那句注释写明「agentd 自己的 4000、root 的内部口不算用户的项目」）⇒ **表里有、面板里没有**，别当丢数据。
- **界面面**（bundle 先断言 = `index-1_vis29R.js`）：`Port pool (10)` 分组头 `probe-351  Current` 排最前 + `Spare (9)` 折叠；`Listeners (2)` 面板给出「同一目录同时开在 3000 与 22000，多半是两个版本并存」告警，池外那条给「还不能在预览地址打开——让助手挪到分配的口」。截图 `/docker/erix_station_playwright/v0143-352-two-panels.png`。
- 探针残渣：fde-eric 里那两个 `http.server` 已 kill（新鲜度窗 45s，之后面板自动掉）；两个会话各多一条探针消息（`复活`）。

### 8.73 erix-agent #469 的宿主侧后续：摘要口径、降级出口、起跑前校验（2026-10-27，分支 `feat-261027-01-392-host-followup`）

上游 #469（折叠摘要器无超时/无上限/从不看 `finish_reason`）已关单，六张 PR：#482 超时不吞、
#487 死线与不泄 `ProviderError`、#488 四个上限、#489 跨 run 不重复烧钱、#490 默认摘要预算 1400、
#493 装配口白名单。**本站仍留在 `fold-statistical`**，闸门三条（缺一不可，见 §8.65 与本节末）：
① 上述 PR 随 **0.27.0 真发版**（npm 最新仍是 0.26.0，本站只认版本号不认 git SHA）；② pin 完在
**隔离实例**跑真长会话，看 `foldSummary.degradeKind` / `finishReason` / 摘要字节数 / 横幅四件都是活的；
③ 量住「每轮多花多少时间」「每次多喂多少字节」，量完才能说"可接受"。这一节写的是**不等发版**
就该做完的四件事。

**A1 是一处真 bug，不是美化。** `runner/lib/fold-notes-key.js` 的 `deriveFoldNote` 一直在读
`payload.chars`——而引擎**从来没有这个键**。真链路键面（`runToolLoop` + `fold-statistical`，
0.26.0 实测）是 `{text, source, strategy, bytes, fingerprint, round}`，被夹断时多
`truncated`/`bytesBefore`，策略给出区间时多 `from`/`to`/`rounds`。⇒ 生产上那条折走存档**永远**写
「摘掉正文 ? 字」，规模这一维自 #392 C 片上线起就没通过。而 §8.66 那 13 条判据一直全绿，因为
夹具手写了 `chars: 184_320`：**#331「没人读的光纤」这次复发的位置是测试夹具本身**——喂进去的
形状是手搓的，不是从引擎取的。现在：规模以 `bytes` 为主口径（截断过就一并写「夹断前 N B」），
`chars` 只在引擎真给了时才写，两个都没有就老实写「规模未知」；`K`/`C15` 钉值，`C18` 直接读
**已安装引擎的源码**钉住「给 `bytes` 不给 `chars`」（与 `C14` 同一手法：不信注释不信夹具）。

**A1b：erix-agent #485（已合 main、未发版）追加的三键按「有就写、没有就不写」处理。**
`foldedRoundRange{from,to}` → 「折走第 a–b 轮」，退回引擎自己的平铺 `from`/`to`，两者都缺才退回
旧的「第 N 轮及之前」；`foldedThrough` → 「水位线到第 X 轮」；`foldedRoundCount` → 「本 run 累计折
N 轮」——契约（host-consumer-contract #479）明写它是 **run 作用域**、resume 后归零，所以文案里
那个「本 run」是**口径不是措辞**，写成「会话累计」就是把一个会归零的数说成不会归零的数。
不发 `0` 也不发 `?`：那会把「引擎没给」读成「水位线是 0」。后果是现在合进 0.26.0 表现逐字不变
（少写两行），pin 到 ≥0.27.0 之后自动亮。

**A2：降级在引擎侧是故意静默的，出口必须宿主自己接。** 上游裁定一是「降级不新增事件类型，只记进
`CompactionStat.foldSummary`」，而 `fold-statistical` 下那五个键**全缺席**（契约不是 bug）——于是
「折了 46 轮」和「折了 46 轮、但摘要是超时降级的次品」在界面上逐字一样。两条嘴：
`worker.js` 导出的 `foldDegradeNotice`（→ agentd 一条 `level:'warn'`，优先 `degradeKind` 短枚举，
只拿到 #482/#491 的整句 `degradeReason` 时退回它并截 200 字）与前端 `compactionDegradeText`
（→ #392-D 横幅后缀 `（⚠ …）`）。两处都**只加不改**：不改 `compaction` 事件本体、不改终态——
摘要降级不是 run 失败，模型拿到的仍是机械摘要，把正常完成的 run 刷红是误报；无降级时文案逐字
不变（历史回放里的旧事件不得多出一段括号）。

**A4：本站走直连 `runToolLoop`，上游的装配期校验一次也不会触发。** #488/#493 的校验（未知子键抛
`TypeError`、旋钮值必须安全正整数）只挂在 `createAssemblyPort` 上，而本站从不用它。真链路实测
（`K6`）：`context: { strategy:'fold-statistical', summarizerTimeout:5000, maxSummaryTokens:'abc' }`
——键名少了 `Ms`、值是个字符串——在引擎里一路 `end_turn`，不抛错、不发事件、不红。所以
`runner/lib/compact-knobs.js` 是本站唯一的拦截点：键名白名单 + 安全正整数，`worker.js` 里
`context:` 包一层 `assertCompactContext(…)`（抛错走 §8 里的 #212 失败信封，有 `RUN_FINISHED failed`
+ 人能读的 reason，比静默跑默认值和比 exit 1 无终态都好看）。`fold-strategy.test.js` 的抠块求值
现在**注入真校验器**而不是桩，于是往 worker 的 `context` 里加一个拼错的键，那条老判据当场红。
`keepRounds: 0` 是合法值（含义是「折掉除最后一轮以外的全部」），所以那一支单独按「非负整数」判，
不能套「>0 才算给」。

**四个上限仍然不写、也不给 env 旋钮**（§8.65 同一条理由：策略与上限不是运维参数，改它要改的是
判据不是配置）。上游的默认值就是本站的裁定值（30 000 ms / 30 000 ms / 49 152 B / 24 576 B /
1 400 tok），省略与写死等价，`K5` 钉住"写死也不会被自己的白名单拦下"。`worker.js` 里两处口径注释
同步改了：`fold-llm` 那条从「#469 未修」改成「已修 + 本站三条闸门」，`maxTokens` 继承那条加了
「pin 0.27.0 后变成 `min(宿主 maxTokens, maxSummaryTokens ?? 1400)`，方向是变严，届时重跑口径」。

**基线**（主 agent 亲跑，`wt-392f` 干净依赖 `npm ci --prefer-offline`）：根 `npm test`
**1656 → 1671**（0 失败 / 4 跳过不变；净 +15 = `runner/test/compact-knobs.test.js` 新建 11 条 +
`fold-notes.test.js` 的 C15–C18 四条）、`runner` `node --test` **399 → 414**（0 失败）、前端
**50 文件 / 925 → 926**（`useEventStream.spec.ts` +1 条，`vue-tsc --noEmit` 干净）。⚠ `.github/workflows/ci.yml`
里那句「1401 项基线」自 #282 起就没再跟（现值 1671），本单**不动它**——那是 §8 反复警告过的
「顺手修陈旧物」，要修得单开一单把整串台账一次理直。

**别改回去的四件事**：① `deriveFoldNote` 里那个 `bytes` 主口径（读 `chars` 的那版本在 0.26.0 上
**永远**输出「?」，而单测照样全绿）；② `C18` 那条读引擎源码的 tripwire（它就是为了①而存在的）；
③ `fold-strategy.test.js` 注入的是**真**校验器不是桩（换成桩，worker 里加错键就又看不见了）；
④ A2 两处「只加不改」（改了事件本体或终态，就是把一次正常完成的 run 刷成错误，还会让历史回放里
的旧事件多出一段括号）。

**收口补丁：A2 读过一个引擎从不发的键（`foldSummary.unshrinkable`），现在是 K12 这条对账在守。**
上游 #494 合进 0.27.0 的发布收尾期间顺手核了一遍契约，发现本单 A2 里那个「截了等于没截」的判据
读的是 `foldSummary.unshrinkable`——**这个键在中英契约与 `src/` 全文 grep 零命中**，是本站按
「#490 应该会发这个」的记忆造的。后果不是报错而是**永不触发**：一条永不响的告警比没有告警更坏，
而且它已经长进了判据（K10）、前端文案和两份 i18n。改回契约真有的那批（erix-agent 契约
「compaction stat」那一行）：`degradeKind` / `degradeReason` / `budgetExhausted`（整条摘要步骤剩余
预算不足 2 秒 ⇒ 连自愈重试都没发生）/ `inputTruncated` + `droppedRounds`（48 KB 按整轮裁）/
`droppedMessages`（token 守卫逐条裁）/ `finishReason`。`droppedRounds: 0` 与 `false` 是「没裁」，
不许据此报事，否则每个正常折叠都刷一条。

**K12 的写法是重点，不只是补一条断言**：待检键名**从两处生产代码里正则抠**（`worker.js` 的
`foldDegradeNotice` 里的 `stat.*` 与前端 `compactionDegradeText` 里的 `s.*`），不手抄清单；然后
两半检查——**永远跑的那半**比一份手抄自上游 main 的键清单（今天真正的防线），**随 pin 自动接管的
那半**与已安装引擎随包的 `docs/host-consumer-contract.md` 逐键对账。跳过必须有机判据：按已安装引擎
**版本号**判（`<0.26.0 无此面` 是 0.26.0 的正常事实），并反向钉住「版本低 ⇒ 契约确实没有这一面」——
上游若把字段面回移到老版本，这条会红，而不是让跳过状态一直用「引擎版本旧」这句话自证。

### 8.74 #421：事件承接面要按**引擎承诺的清单**对账，不是按"界面上想展示什么"（2026-10-27，分支 `feat-261027-01-392-host-followup`）

清点方式先说清楚，因为它比结论有用：**把上游对宿主承诺的事件面取出来，与本站三处白名单逐条对**。
承诺面不是我自己挑样本，而是上游源码里的类型声明 —— `erix-agent` `src/loop/orchestrator.js` 中
`LoopEvent` 的 `@property` 联合类型，**16 类**。对出来的结果：

| | 数量 | 后果 |
|---|---|---|
| 上游承诺 | 16 | — |
| 本站前端订得到（`useEventStream.ts` 的 `EVENT_TYPES`） | 11 | 另外 **5 类浏览器一条都收不到** |
| 前端 `HISTORY_REPLAY_TYPES` / 后端 `http.js` 的 `HISTORY_EVENT_TYPES` | 各 20（彼此严格相等） | 5 类里 **4 类两处都没有 ⇒ 实时没有、刷新后也没有**；`model_metadata_missing` 只有后端下发、前端不处理 |

写入侧不过白名单（`internal.js` 直接 `INSERT INTO run_events`）⇒ **这 5 类每轮都在往库里写**，是读侧
把它们丢了。这就是 #371-A 的形状（库里存着、读不出来），也正是 #288 立"三处同步"纪律要防的那件事。
最讽刺的一条：`compaction_strategy_fallback` 是上游 #464-A 专门为"你配的策略不是真跑的那条"造的
信号，而 #392 正是本站在这上面栽过的一跤 —— 信号一直发，我们接不到。

**三条口径**：

1. **三处集合各自独立存亡**，只加一边就得到两种可见性不一致（"实时有刷新没" / "刷新有实时没"）。
   对账测把 **16 类清单钉死在测里**（`portal/test/event-surface-contract.test.js`）：上游改联合类型、
   本站删监听、豁免不写理由，都会红。跨端读后端源码这件事住在 `portal/test` —— 前端 vitest 是 jsdom，
   读源码只能 `?raw`，而 vite 的 fs 边界不许越出 `portal/frontend`（#349 踩过）。
   另有一条**等式**判据：前端回放集合必须与后端下发白名单**逐项相等**（不是子集，今天 20 = 20）。
2. **"订得到"不可豁免，"展示"可以豁免但必须写理由**。`run_outcome` 每 run 一条、与 `run_end` 语义
   重叠且今天无读者 ⇒ 显式不进时间线/历史白名单，理由写在测里的豁免表（`EXEMPT_FROM_TIMELINE`）；
   等 §12 台账或结算面板真用它时再接。**豁免表空着不算做过决定。**
3. **界面之外还要有运维的嘴**：`runner/lib/engine-notices.js` 把这 5 类翻成 LOG（四类 `warn`、
   `run_outcome` 是 `info` —— 每轮都有的东西刷成 warn 会把 warn 面淹掉）。只修界面，等于"只读
   LOG 的人仍然不知道"。文案口径照旧：数字没给就 `?`/「若干」，绝不拿 0 冒充（#283）；外来标识符
   过形状闸，绝不 `[object Object]`（#261）。

变异逐条证过这四条锁会红：删 `EVENT_TYPES` 里的 `run_outcome`（后端 2 红 + 前端 4 红）；删后端白名单
里的 `compaction_strategy_fallback`（2 红）；删前端回放集合里的 `resume_journal_skipped`（后端 2 红 +
前端 2 红）；删 `en` 一条 key（2 红）。复原后全绿。

顺带清掉一个**文档假前提**：`http.js` 里 `model_metadata_missing` 那条注释写着"SSE 实时路径会原样推给
前端（前端 `default: return;` 中性忽略）"—— 前端从没订过这个类型，EventSource 不订就不是"收到但不
展示"，而是**根本没收到**。注释与实际不符本身就是缺陷面的一部分，改代码时必须一起改，不然下一个人
会照着它再推一遍错的结论。

### 8.75 状态条从「出事才说话」改成「一直在说话」（#425；#282 的后续，2026-10-26）

> **编号更正记录**：这片活起草时（在主工作区未提交状态里躺了两天）把代码注释、测试名、本台账一律写成
> `#387`，而真实的 #387 是另一条**仍未修**的后端问题（「查看原文」里 `resultPreview` 实测 0/98）。本片的血脉是
> **#282**（顶部常驻状态栏）的后续 ⇒ 立项为 **#425** 并把全部引用改指本号。**教训**：写台账引用前先
> `gh issue view <号>` 核一遍标题——凭记忆填号，错号会跟着代码永久留在仓库里，比没写更难查。

用户口述的三件不适：① 看不到**上下文吃了多少 / 这一轮烧了多少 token**；② `上游已 6s 无输出` 读起来像
故障，而它当时**几乎常亮**；③ agent 中间大段静默时，非专业用户分不清「在干活」与「已经死了」。
对应三处改动，全在展示层 + runner 提示词，**零 DDL、零后端行为变更、零新事件类型**。

**① `usage` 事件从「整条丢掉」改成「放行展示」**（`runner/worker.js`）：`onEvent` 里原本有一句
`if (event?.type === 'usage') return;`——那是 **#282 为了「不拿单次调用冒充整 run 汇总」**加的，但它同时
把数字从界面上抹掉了。现在事件照发、照落 `run_events`，记账面一字未动（`onUsage` 仍是空实现，计费仍只吃
U2 终态载荷，§7.3/§6.3-6 口径不变）。同一处加宿主侧 additive 字段 `context_window`（值 = 喂给引擎
`modelMetadata.contextWindowTokens` 的那个数，#309），**判据用 `Number.isSafeInteger` 而不是 `isFinite`**
——与 #316 入口 `parseHeartbeatModels` 同一形状口径；小数/字符串/≤0 ⇒ **整键不写**，前端整段不出，
绝不画一个「0% / 上限 0」的假进度条。

**② token 三个面**（`lib/runMomentum.ts` / `RunStatusBar.vue`）：`roundUsage`（最近一次 `usage`，
同轮多次调用累加，换 `round_start` 才清）、`runUsage`（最近一次 `round_end.usage`）、上下文占用
= 本轮输入 / 窗口。**累计量运行中就有**：真机 `run_events` 里 `round_end.usage` 单调递增、最后一轮 =
`run_end.usage` ⇒ 引擎给的是**本 run 累计**（口径来自引擎实现而非契约文档，所以注释写死「截至上一轮」）。
`round_end` **不清**本轮用量（清了会在轮间空档闪没），重置点放在下一个 `round_start`。

**③ 相位**：`round_start`/`attempt`/`recovering` ⇒ `awaiting_llm`；`assistant_delta`/`reasoning_delta` ⇒
`streaming`；`tool_use` ⇒ `tool_running`（带工具名）；最后一个 `tool_result` 交差 ⇒ 回 `awaiting_llm`。
`enterPhase` **只在换相位时重置计时**（同相位内重复 delta 会把「已等 42s」每秒抹回 0）。
颜色与文案解耦：`RUN_FROZEN_THRESHOLD_MS`（5s）降级成「该提一句」的阈值（相位秒数上屏），标黄另用
`RUN_STALL_THRESHOLD_MS = 60_000`——取数依据是本站自己下发的 `firstByteTimeoutMs=240s` /
`streamIdleTimeoutMs=180s` 与 300s 看门狗（量级参考，**不抄那两个数的字面量**：它们住在容器 env，改它不必改这里）。

**④ 提示词「过程播报」段**（`SYSTEM_PROMPT`）：开工先回一句再动手 / 每阶段报结果 / 只在真的需要用户参与时
提问（工具报错不许拿去打断用户）/ 长命令先说要做什么、失败也要报 / 播报是进度不是第二段摘要。
静默多久算久由界面负责，提示词里**不写阈值数字**（单一真相在前端常量）。

**硬刷新口子的形状**（这条最容易写错，已按它单测）：历史回放白名单没动，但状态机对 `history=true` 开了
**一个**例外——历史 `round_end` 的 `usage` 与 `context_window`。它必须①在通用 run 登记**之前**处理
（否则 `beginRun(rid, nowMs)` 会假出一个「上次 run 00:00」）、②把登记的 run 直接标 `endedAt`（否则历史帧
被当成「现在在跑」）、③`startedAt=null`（时长不出）、④允许**历史帧之间**后者盖前者（seq 升序，不盖就是少报）
却**不许回退实时 `run_end` 的值**（靠 `state.usageFromHistory` 一个布尔区分来源，不进视图）。

**基线（主 agent 亲跑，判绿 = 退出码）**：根 `npm test` **1567 / 1563 通过 / 0 失败 / 4 跳过 rc=0**
（基点 1561 ⇒ **+6**）；`node --test runner/test/*.test.js` **365/365 rc=0**（基点 359 ⇒ `usage-event` +3 /
`system-prompt` 的 #425 段 +3）；前端 `npm run typecheck` rc=0 + `npm test` **48 文件 / 912 通过 rc=0**
（基点 886 ⇒ **+26**：lib 层 10 条、状态机组 12 条、组件层 4 条）。
过程中被自己的钉子抓到并修掉三次：`SYSTEM_PROMPT` 收尾漏分号（抠取器断言先红）、`context_window`
用 `isFinite` 放过 1.5、历史 `round_end` 抢走正在跑的活 run 登记。

**已知不足（另单跟）**：相位在 `usage` 之后不主动改（没有工具调用时它停在 `awaiting_llm`，语义上「下一轮
即将开始」，不算错，但界面上会出现「刚收到 usage 却说在等回音」的一瞬）；`roundUsage` 是**本轮**口径而
`runUsage` 是**截至上一轮**口径，两个数并排时用户可能以为它们同源；提示词的播报效果只能真机看 transcript 验收。

### 8.76 调查现场必须进仓库，仓库外（workspace 顶层）不留散件（2026-10-28，分支 `chore-261027-01-loose-artifacts`）

**现象**：`fde_station/` 顶层（**仓库外**）躺着四件 10-24 的产物，两周没人碰：`ISSUES.md`（412 行）、
`relay-bug/`（**空目录**）、`toolcall-truncation-report.md`（10 KB）、`toolcall-truncation-repro.py`（6.6 KB）。

**代价不是「乱」，是「台账残缺」**：那份顶层 `ISSUES.md` 有 **12 条**，而仓库里被跟踪的那份只有 **7 条**——
第 8~12 条（`partOf` 链式 resume 必炸、打字机丢失 Vue 响应性、前端从不消费 `next_cursor`、预览端口呈现盲区、
kkFileView 提案）**在仓库里根本不存在**。两份台账长成了两份，且**被跟踪的那份才是残缺的那份**。
这是我们反复讲的「绿灯不代表没坏」的镜像命题：**没入仓不代表没发生**。

**`relay-bug/` 是空目录**这件事单独值得记：现场被清过、壳留着，两周后没人知道它曾经装过什么、bug 是不是
还在。现场要么留下证据（进仓），要么写进台账（带结论），**不要只留一个名字**。本次直接删。

**规矩（三条）**：

1. **调查产物一律进仓库**：报告 `docs/design/<主题>-<YYYY-MM-DD>.md`、脚本同目录（`-repro.py` 后缀，
   已有先例 `docs/design/audit-2026-09-16.md`）；并在 `ISSUES.md` 留一条正文 + 文末对照表加一行，指向追踪
   issue 与 AGENTS 章节。本次的落点：`docs/design/toolcall-args-truncation-2026-10-24.md` / `-repro.py`
   → 台账第 13 条 → 追踪单 **#426**。
2. **workspace 顶层只放仓库与 worktree**，不放散件。散件的判断标准：`git -C <仓库> status` 看不见它 = 散件。
3. **落笔引用 issue 号之前先 `gh issue view <号>` 核标题**（与 §8.75 同源教训：错号会跟着代码永久留在仓库里，
   比没写更难查）。

**这条为什么没有机器判据**：`test/repo-hygiene.test.js` 只能看见仓库内部；「仓库父目录不得有散件」在 CI 里
父目录是 `<runner>/work/<repo>/`，形状与本机不同，硬加就是一条会因环境假红的判据。**兜底方式是台账**：
`ISSUES.md` 条目数从 7 → 13、对照表 8~13 行都在，任何人可以核对本机顶层是否还剩散件。

### 8.77 SPA 化把登出 `location.reload()` 顺带承担的「清场」职责弄丢了：换账号必须显式认领（issue #428，2026-10-28，分支 `fix-261028-01-428-user-switch-reset`）

**现象**：同一个浏览器标签里换账号（登出 → 换号登录）落到工作台首页（`/`，没选任何会话），
**中间对话窗口还是上一个账号的那段对话**；侧栏列表是新账号的（被 `/api/sessions` 覆盖了），于是看起来
像「列表是新的、聊天区是旧的」。刷新一次就好了 ⇒ 典型的内存态没跟人走。

**根因是两层，缺一层都不会发生**：

1. 登出只做两件事——`auth.logout()` 清 auth store + `router.replace('/login')`。**SPA 不重载页面**，
   而 `stores/workbench.ts` 是 pinia 全局单例（setup store，无 `$reset`）⇒ 消息流 `entries`、目录 /
   会话列表、`drafts`（模块内 `Map`）、#370 队列、#189 折叠原文缓存、乃至**那条 `EventSource` 连接**
   全部原样活到下一个账号。
2. 现成的 `resetSessionView()` 本来会清这些，但它**唯一的自动触发点**是
   `WorkbenchView` 里 `watch(() => route.params.id, …)` 的 `else` 分支，且**没有 `immediate`**：
   重新登录挂载时 `params.id` 恒为 `undefined` 且**没有发生变化** ⇒ 回调根本不跑。`onMounted` 里的
   `initWorkspace()` 只重拉 `/api/dirs` + `loadSessions()`，从不碰 `entries`。

**⚠ 这条的通用教训**：SPA 化之前旧版 `static/index.html` 的登出是 `location.reload()`——它**顺带**
承担了「全局内存态清零」。改成 `router.replace` 时没人写下「reload 本来在承担什么」，职责就凭空消失了。
**凡是靠整页重载白拿的干净状态，改 SPA / 改路由时都必须显式接回来**，并在注释里写明它原来在干什么。

**修法（两处接线 + 一个 store 动作）**：

- `resetForUserSwitch()`：清的是**整个用户的可见面**，不是「一个会话的详情区」——目录也一起清，
  因为目录的 `cwd` 是上一个账号家目录下的路径，本身就算跨账号信息。顺序：先撞开全部代次/序号
  （`ctxSeq` / `projectReqSeq` / `sessionReqSeq` / `runStateCheckSeq`，**新加 `dirsReqSeq`**——
  `/api/dirs` 此前是唯一没有迟到守卫的那条），再断 SSE（`es.resetStreamState()` 内含 `closeEs()`），
  然后清消息流 / 目录 / 会话 / 草稿 / 队列 / 重试面 / 动量 / 卡片展开记忆。
- `claimOwnership(userId)`：store 记一个 `ownedBy`，身份不同才复位。**调用点在视图层两处**——
  `WorkbenchView.onMounted` 第一步 `claimOwnership(auth.user.id)`、`onLogout()` 里 `claimOwnership(null)`。
- ⚠ **为什么必须在 `initWorkspace()` 之前同步执行**，而不是写进 `watch(() => auth.user?.id)`：后者要赌
  「父组件 watcher 先于子组件 `onMounted`」这个时序，赌输一次 `initWorkspace` 的成果就被洗成空目录。
  同步接线没有竞态，且**覆盖不经过 `logout()` 的换账号路径**（会话过期后 `forgetExpiredSession()` 回登录页、
  直接粘 `/login` 重登）。登出那次 `claimOwnership(null)` 的作用是**当场**断 SSE 并清空，不给登录页留旧内容。

**顺带查清的一件事（源码对账，未改代码）**：`send()` 用 `sessionId.value` 定位会话，复位之前它是
**上一个账号的会话 id** ⇒ 界面看着是「新账号首页」，POST 却打到别人的会话。本修法把 `sessionId` 归
null，症状随之消失。而**后端本来就挡着**（2026-10-28 对账 `portal/src/sessions.js` / `http.js`）：
`fetchSession()` 一条 SQL 里同时做存在性与属主校验，`!row || row.user_id !== userId` 与「不存在」
**同一个 `404 not_found`**（不泄露存在性）；`POST /messages` 在幂等 fn 内先 `assertSessionOwner()`
（就是 `fetchSession` 的别名）再动笔，`postMessage()` 自己还带 `FOR UPDATE` 二次校，SSE
`handleSessionStream` 走 `getSession()` 同一口径 ⇒ **跨账号写不会串号，只是把用户看到的一行错误文案
变得莫名其妙**（"会话不存在"出现在一个看起来刚建好的首页上）。这类「前端状态穿越账号」的 bug 因此
定级为体验 + 信息泄漏，**不是数据完整性**。

### 8.78 「在途响应全部作废」要按**写点清单**核对，不是按请求清单；登出收口要按**按钮清单**核对（issue #431 = #428 未尽部分，2026-10-28，分支 `fix-261028-01-431-logout-scope-and-late-writes`）

#428（§8.77）合并后做独立评审，抓出两处**它自己的注释已经承诺、但代码没做完**的事。两处的形状值得记，
因为它们都不是"想不到"，而是**按错误的清单核对**：

**① 登出有三颗按钮，认领只接了一颗。** `claimOwnership(null)` 原本写在
`WorkbenchView.onLogout` 里；而全站有**三颗**登出按钮——工作台顶栏、`AdminLayout.vue:29`、
`ForcePasswordChangeView.vue:70`，后两颗是裸 `auth.logout()`。`WorkbenchView` **没有 `onUnmounted`
关流的钩子**（它的 `onUnmounted` 只清 keydown），SSE 归 `useEventStream.ts` 自己管，而那里
`:467` 的注释写着「EventSource 自动重连，带 Last-Event-ID」⇒ **从管理台或改密屏登出时，上一个账号
那条 `/api/sessions/<id>/events` 不会关**，服务端会话一死它不当终态、按规范无限重连，浏览器后台
一直替别人的会话要事件流，挂到标签页关掉为止。界面看不见（进工作台的任何路径第一步都认领 ⇒ 数据
会被复位），代价是纯资源/背景请求。

**修法：收口到唯一的汇合点** `stores/auth.ts` 的 `logout()`（**在 `await` 之前**——会话本来就可能
已经死了，下面还 catch 着失败，SSE 不该等服务端回包）与 `forgetExpiredSession()`。为不把整个工作台
面（`useEventStream` / `useRunMomentum` / `lib/markdown`）拖进登录页首屏 chunk（路由是懒加载的），
新增 `lib/userScope.ts`：形状**照本仓已有的 `lib/restrictedSession.ts`**（`set*Listener` + `notify*`，
最后一次注册生效、传 null 注销）。⚠ **注册只装不卸**：只有工作台挂载过一次才有东西要清，`onUnmounted`
里注销就等于把「从管理台登出」这条路径重新漏掉。

**② 「在途响应全部作废」当时是按"我加过守卫的请求"核对的，正确的清单是"await 之后的写点"。**
逐函数核 `stores/workbench.ts` 里 `await` 之后直接写界面而无代次守卫的位置，四条：

| 路径 | 迟到后写什么 | 处置 |
|---|---|---|
| `createDir` | **整块**目录上下文（`dirCwd` / `sessionId=null` / `sessions` / `dirs.push` / `updateAvailability`） | **加守卫，但比的是新增的「用户代次 `scopeSeq`」而不是 `ctxSeq`**（评审实测指出：`selectDir` 与 `refreshDirs` 的回退在**同一个人**身上也撞 `ctxSeq`，拿它当判据会把「新建成功」误判成作废 ⇒ 目录建了、modal 既不报错也不跳转、界面**无声**消失）。目录与会话服务端已建，不算失败 ⇒ 换人时返回 `{error:null}` 且**不带 `session`** ⇒ `NewDirectoryModal` 不 `emit('created')` ⇒ 不会路由到一个已不属于当前登录者的会话 |
| `recallQueue` | `inputValue` + 队列快照 | 加守卫，但**守卫之前先按原会话存回 `drafts`**：DELETE 已在服务端把整队掏走，直接丢弃 = 文本两头没（先例 = `sendQueued` 的 catch 分支「守卫之前先 `drafts.set`」） |
| `stop` | `entries.push(sep)` | 加守卫：「已请求停止」是上一条流的事，不许插进新账号的消息流末尾 |
| `loadFoldedOriginal` | `foldedOriginals[<sid>:<round>]` | **故意不加**（键含 `sessionId` ⇒ 只是内存残留，新账号撞不上；同账号回头再开这个会话，这条缓存本来就该命中。加守卫反而丢掉已拿到的原文） |

**兜底方式**：`stores/workbench.spec.ts` 的 `#431` describe 用挂起的 Promise 真实造出「A 在途 →
换账号 → A 的回包最后落地」，三条各一条；把三个守卫改成 `if (false)` ⇒ 恰好三条红。登出收口由
`stores/auth.spec.ts`（含**顺序断言**：`['reset', 'fetch']`）+ `WorkbenchView.spec.ts`
「工作台挂载过之后在别处登出」钉住；后者删掉 `setUserScopeResetListener` 注册即红（实测）。

**⚠ 可复用的三条核对法**：① 说"某类状态/请求已作废"之前，先 `grep` 出**所有 await 之后的写点**逐条打勾，
不要凭"我改过哪几个函数"；② 说"登出时会 X"之前，先 `grep` 出**全站有几颗登出按钮**，接在按钮上就等于
接在三个地方；③ **守卫要比对的代次必须匹配"作废的原因"**——`ctxSeq` 的语义是「上下文变了」（同一个人
切目录也撞），而 #431 要防的是「人变了」，所以 `createDir` 认 `scopeSeq`。拿一个"碰巧也会变"的计数器当
判据，代价是**把成功误判成失败**，比原 bug 更难查（界面一句话都不说）。判据：
`stores/workbench.spec.ts` 里「同一个人切目录不得把新建成功的目录吞掉」那条用例，把守卫换回 `ctxSeq`
就红（实测）。

顺带补齐的证据链：新增 `views/AdminLayout.spec.ts`（此前**该组件零 spec**）钉「AdminLayout 那颗登出按钮
= `auth.logout()`」这段胶水。`stores/auth.spec.ts` 钉的是 `logout()` ⇒ `notify`，
`WorkbenchView.spec.ts` 钉的是 `notify` ⇒ 断流清空，缺了中间这段，「三颗按钮都收口」就只是说法。

### 8.79 登出只属于 portal 平面：预览凭证是独立能力，回收必须显式做（issue #429，2026-10-29，分支 `fix-261029-01-429-preview-logout-lineage`）

**现象**：同一浏览器登出 → 换号登录，**上一个账号开着的预览 URL 照常打开、能操作**，
`audit_log` 把新账号的点击全记在旧账号名下；只要页面持续有请求，滚动续期让这个状态无限持续。
用户拿它对照设计意图（「不同用户之间/直接访问打不开 webapp」）来问——那两条路径实测都还成立
（无 cookie 无 ticket ⇒ `403 preview_ticket_required`；`public` 免票是 §2.7 的设计豁免），
**破功的只有「共享浏览器换账号」这一条**。

**根因不是实现偏差，是 spec 缺口**（这条最容易被"照 spec 实现"的人漏）：
- §2.4 登出语义历史上就只写「删 `login_sessions`」；§2.8 登出对预览的撤销写的是
  「**可选**显式撤销**未使用的 ticket**」——这个可选项没实现，且 `kind='session'`（正握着 cookie 的那种）
  根本不在任何登出路径的清单里。
- forwardAuth **故意**不查 `login_sessions`：登录 cookie host-only 于 `station.<base>`（#6），
  物理上到不了预览 host——「门在它身上没有可判的主体」（§2.11a 原话）。exposure 判定用 grant 上
  **冻结的 `user_id`**，浏览器当前登录着谁，边缘既不知道也不需要知道。
- 于是登出对预览平面**什么都不是**：cookie 在浏览器 jar 里、grant 在库里 `active`、滚动续期无绝对上限。

**修法 = 凭证血缘（issue #429 方案 B）**：`preview_grants.login_session_id`（迁移 `0025`，可空、
FK `ON DELETE SET NULL`——offboarding/停用会 DELETE `login_sessions` 行，RESTRICT 会当场撞 FK），
ticket 签发时写、forwardAuth 兑换时**继承**；`auth.revokeSession` 改成**同语句 CTE**：吊销会话 + 按血缘
撤 `active` grant（SET 形状与谓词口径与 #252 撤 grant 逐字同形，是「撤 grant」的第四个写入口，只是命中列换成血缘）。
多设备语义靠血缘天然成立：撤的是**这次登录会话**签的票，不是这个 user 的所有票——按 `user_id` 撤会把
A 在另一台设备的预览连坐掉。forwardAuth 保持零改动（回收只发生在登出时刻）。

**⚠ 可复用的三条**：
① 「登出/禁用/释放会不会回收 X」要**按撤销写入口清单**核对（本仓共四个：offboarding、改块、停用用户、登出），
  少接一处就是 #252（撤权漏重试路径）与 #429（登出压根不在清单）的复发形状；
② 两套独立凭证的平面（登录面 / 预览面），**任何一面的「退出」语义都必须显式跨面广播**——
  「凭证独立」是隔离性的来源，也是回收遗漏的来源；
③ fake 建模新列时**按 SQL 说的做**（`preview.test.js` 的 INSERT 按参数位解析、`fake-pool` 的血缘撤权
  从 SQL 文本认 `state = 'active'` 谓词）：实现漂移（多一列 / 改谓词）fake 当场红，
  不重演 #252「单测结构上测不到」。

### 8.80 给人看的地方不许出现主键：模型下拉把 LiteLLM 的 UUID 摊了出来（issue #434，2026-10-29，分支 `fix-261029-02-434-model-label-uuid`）

**现象**：管理台「编辑用户 → LLM 配置」选模型，下拉每一项是 `920aa0c6-f336-4085-b6b1-607660883b35 — deepseek-flash`。
同一屏的模型表格（#296 那轮改的「调用名 / 显示名」两列）是对的——**下拉与两条错误文案是漏网之鱼**。

**根因**：`toModel()` 发给前端的 `model_id = model_info.id`，而建模型时我们**从不写** `model_info.id`
⇒ LiteLLM 自己生成 UUID（现网两个模型实测全是 UUID，`display_name` 与调用名相同）。
凡 `${model.model_id} — ${model.name}` 都在打这个 UUID。**单测没抓到是因为 mock 把 `model_id` 写成
`'gpt-4o'`**——形状与真机不符，这种 mock 只能测逻辑不能测语义。

**同类 6 处一次收口**（不是一个下拉的事）：`UserLlmPane` 三个下拉 + 选中项 `title`、`AdminUsersView`
新建 FDE 的三个下拉、保存成功 toast（取 `config.main.model_id`）、`AdminView` **新增**模型表单第一个
字段的裸 label（编辑表单 #296 已改，新增表单漏——同文件下方就有 `not.toContain('model_id')` 这条既有判据，
照着抄一遍就行）、后端调用名撞车 409 的 `已被模型 <UUID> 占用`、以及**给 FDE 终端用户看的**
`llm_model_not_found` 预检文案与它的前端 i18n 版。

**修法**：`lib/modelLabel.ts::modelOptionLabel()` = `展示名 (调用名)`，两者相同（现网绝大多数）只显示一次，
**绝不打主键**；与表格两列同源，不引入第三套叫法。错误文案优先报**绑定里存的调用名**（用户认得的那个），
UUID 退到括号里做排障引用，`details` 补 `model_name`，前端名字优先、老服务端没带才退 `model_id`。
**提交/回填一律仍走主键 `id`** ——本收口只动显示面，不碰任何契约字段。

**⚠ 可复用的三条**：
① 「主键能不能给人看」判据：**只有 UUID/自增 id 是主键，就不许出现在下拉、toast、聊天 syserr 里**；
  要给人看就用 `#296` 那两个名字（展示名 / 调用名），要排障就放 `details` 或括号；
② **同一类"给人看的标签"必须收到一个函数里**（本轮之前它散在 2 个文件 6 处）——散落形状下，
  修一处 = 漏五处，#296 那一轮正是这么漏的；
③ mock 的字面值要**长得像真机的形状**（`pk-m1` / UUID 形态），`model_id: 'gpt-4o'` 这种"看着像人名"的
  mock 会让 UUID 泄漏在结构上测不出来。

### 8.106 v0.1.44 发版与部署（含 #434 模型标签收口 + #429 登出回收预览凭证真机验收）（2026-10-30）

> ⚠ **编号更正（2026-11-09）**：本节**原误记为 §8.73**，与 §8.73「erix-agent #469 的宿主侧后续」重号。
> 全仓 `§8.73` 的引用（`worker.js` / `engine-notices.js` / 各测试 / `.work-orders/*`）指向的都是**那一条**
> （折叠策略、降级出口、"策略不是运维参数"口径），所以改的是本节号、不是那一条。本节按发现顺序排在 8.80 之后，
> 但取号用**下一个空号**（8.106）而不是顺移 8.81–8.105 —— 顺移会让既有引用全部错位。

**为什么这次一次发**：main 上积了 **21 个未发版提交**（#396 `node_modules` 解除跟踪 / #399 Git 凭据搬 ro bind / #420 事件承接面 / #425 状态条 / #428 换账号串号 / #429 登出回收预览凭证 / #431 登出收口 + #434 模型标签），而最新 tag 还是 `v0.1.43` ⇒ 现网落后两天。⇒ 合完 #434 直接发 **v0.1.44**。

**#434（PR #435，另一台主机做的，我按 §6.1 亲审 + 复跑 + 变异后合并）**

- diff 形状：新增 `portal/frontend/src/lib/modelLabel.ts`（`modelOptionLabel()` = `展示名 (调用名)`，同名只显示一次，**绝不打主键**；提交/回填仍走 `model_id`）+ 6 处调用点收口（三个下拉 + `AdminUsersView` 三个新建下拉 + 保存 toast + `AdminView` 新增模型表单 label + `llm.js` 的 409 文案与消息预检文案）。`llm.js` 的两处把「模型 id」换成「撞车/绑定模型的名字」，**id 仍留在 `details` 里**给运维与日志。
- **四件套（在独立 worktree `5cf8801` 上亲跑，判绿=退出码）**：根 **1710 / 1705 / 0 失败 / 5 跳过**、runner **430 / 429 / 0**、前端 **53 文件 / 982 通过**、`typecheck` rc=0。
- **我自己的两条变异（每条先 `git diff --numstat` 自证非空操作）**：① `modelOptionLabel` 改回 `${model_id} — ${display}` ⇒ `modelLabel.spec` **2 条具名红**；② `llm.js` 的 `clashLabel` 改回裸 `modelId(conflicting)` ⇒ `llm-reconcile.test.js` **`not ok 19`（409 文案那条）**。各自还原后 `git status` 干净。
- 合并：`gh api -X PUT .../pulls/435/merge` → `f860302`（PR 质量门禁 SUCCESS、镜像构建校验 SKIPPED 属 PR 常态）。
- **真机验收（v0.1.44 发布物，bundle 先断言 = `index-XmXg4_i6.js`，与 v0.1.43 的 `index-1_vis29R.js` 不同名）**：管理台 → eric 的 Edit → **LLM & Repository** 标签，三个下拉选项实测 = `(not configured)` / `deepseek-v4-pro` / `deepseek-flash`，**整页 UUID 正则命中 0 次**（修复前是 `920aa0c6-… — deepseek-flash`）；新增模型表单里 `model_id` 字面量不再作为字段 label 出现。截图 `/docker/erix_station_playwright/v0144-434-model-dropdowns.png`。
  ⚠ 探针坑：抽屉内容要等 ~2s 才渲染完（第一次读只看到 1 个 select 就以为「下拉不存在」）；且 admin 自己没有 FDE ⇒ LLM 面板不出模型下拉，**必须挑 FDE 用户（eric）那一行**。

**#429（登出回收预览平面）真机验收**（这次一起发的安全面，顺手验掉）：以 eric 登录 → 列端口拿 allocation → 签票 `201` → 库里该 grant `kind=ticket / state=active / login_session_id IS NOT NULL`（**血缘写上了**）→ `POST /api/auth/logout` `204` → 该 grant **`state=revoked` 且 `revoked_at` 非空**。⚠ **已知边界**：迁移 0025 之前签的 grant **没有血缘** ⇒ 登出撤不掉（真机同屏就有一条 `kind=session / state=active` 的老凭证），这是「历史行不可追认」的必然代价，不是漏做。

**发版与部署（v0.1.44）**：`git diff v0.1.43..HEAD -- runner/` 有 **13 个非版本文件** ⇒ **必须重建 FDE 镜像**；新增迁移 `0025-preview-grant-login-session.sql`。
版本 bump `eaea3d8`（六文件 +9/−9，`npm version 0.1.44 --no-git-tag-version` ×3 目录）→ main CI（质量门禁 + **三镜像构建校验**）两个 job 全绿后才打 tag → release `41018144161` success → 清单 portal `imageId=646a1c65…`/`digest=9daa73ba…`、fde `imageId=cd43ed63…`/`digest=df324165…`、proxy `imageId=df93027e…`/`digest=a52ecc96…`，三个都 `docker image inspect .Id` **逐位一致**。
⚠ **fde 又一次直连拉不动**（这次 `rc=124` 直接超时）⇒ 老办法：`docker pull ghcr.nju.edu.cn/erixwong/erix-station-fde:0.1.44` 成功后**再按 digest 拉 ghcr 一次**（层已在本地、秒回），于是有 `repo@sha256:` 引用、pin 保持形态①。
`deploy/.env` 三项 pin（备份 `/tmp/deploy.env.bak-0144`）→ `up -d --no-build` ⇒ portal 实跑 `646a1c65…`、迁移 **0025 自动应用**、`healthz=200` → `docker rm -f` 五台 `fde-*` → reconcile 16 秒内全部落在 `cd43ed63…`、容器内 `station 0.1.44 / engine 0.26.0`、agentd `sse connected` + `sse ping received`。

⚠ **一条操作坑（与 §8.24 同族）**：`while read … docker pull … done < file` 里 **docker 会吃掉 stdin** ⇒ 循环只跑了一条就静默结束（我这次就是 portal/fde 跑完、proxy 根本没执行）。⇒ 逐个显式调用，或 `docker pull < /dev/null`。

### 8.81 FDE 镜像补 .NET SDK 10（与 SDK 8 side-by-side，issue #436，2026-11-02）

**需求**：一个项目同时需要 SDK 8 与 SDK 10（既有 net8.0 解决方案 + 新 net10.0 项目）。镜像原本只有 SDK 8（`runner/Dockerfile` 从 `mcr.microsoft.com/dotnet/sdk:8.0` COPY `/usr/share/dotnet`）。

**决策路径**：主 agent 先实测「两个官方镜像的 `/usr/share/dotnet` 叠加 COPY = 目录合并 = side-by-side」可行，再把四条路（继续胖镜像 / 按档位分镜像 / 用户态装 / sidecar）摆给决策者 ⇒ **选 A（继续胖镜像）**，成本 +620 MB。sidecar 那条**本来就已被否决**（`fde-platform.md:754`：跨容器 `localhost` 语义坑），按档位分镜像要动 `FDE_IMAGE` 单值 + provisioner + 管理台 + 多套 pin，未选。

**实测（合并后镜像，uid 1000）**：`dotnet --list-sdks` = 8.0.424 + 10.0.403；`--list-runtimes` = NETCore.App / AspNetCore.App 各 8.0.30 与 10.0.14；net8.0 与 net10.0 两个 ASP.NET Core 应用 publish 后起在 22000/22001，`curl` 分别 `ok-8.0.30` / `ok-10.0.14`；`global.json` 钉 `8.0.424` ⇒ `dotnet --version`=8.0.424，不钉 ⇒ **10.0.403**。

**两条必须记住的事实**：
1. **默认 SDK 会从 8 变成 10**（两版并存时选最高版）⇒ 老 .NET 8 项目会静默用 10 构建。要钉 8 必须放 `global.json`。这条已写进下发的 `~/AGENTS.md`（`materializer.js` 环境事实段），agent 与人都能读到。
2. **属于官方矩阵之外**：`sdk:10.0` 底座是 Ubuntu 24.04 / glibc 2.39，微软**没有发布 bookworm 变体**（`10.0-bookworm` / `-bookworm-slim` / `-trixie-slim` 全不存在，只有 `10.0` 与 `10.0-noble`），我们在 Debian 12 / glibc 2.36 上跑。兜底 = Dockerfile 里的**离线 CoreCLR 烟测**（`dotnet <sdk/10.*>/Roslyn/bincore/csc.dll -version`，真加载运行时；`--list-sdks` 只跑 muxer 看不出来）。哪天 10.0.x 抬高 glibc 要求，**镜像构建期就红**，不会等用户跑起来才炸。真失效时唯一出路是把 FDE 底座升 trixie/noble（apt 包 + playwright 依赖全量重测），本单不做。

**改动**（6 文件 / +128 −6）：`runner/Dockerfile`（加 `COPY --from=dotnet/sdk:10.0` + 断言收紧成「两个 major 都在」+ 离线烟测 + 三条注释）、`portal/src/materializer.js`（告知面：SDK 8 与 10 并存 + 默认选最高版 + `global.json` 形状）、`portal/test/runner-image-dotnet.test.js`（新，4 条静态判据）、`portal/test/materializer.test.js`（+1，按节取「环境事实」并再钉零端口数字）、`docs/design/deploy-contract.md` §6 + `docs/env.md` `FDE_IMAGE` 行（矩阵与体积同步）。零依赖变动、零 lockfile、零 DDL、零版本号改动。

**体积**：`/usr/share/dotnet` 578 MB → 1.2 GB；镜像 2.43 GB → **3.08 GB**（`docker image inspect .Size` = 3082044237 字节）。**整机一份**（所有 FDE 共用同一 image 层），不是每台 FDE 各 620 MB。

**验收（主 agent 亲跑，不采信 worker 自报）**：根 `npm test` **1715 / 1710 通过 / 0 失败 / 5 跳过 rc=0**、`node --test runner/test/*.test.js` **430 / 429 / 0 / 1 跳过 rc=0**（净 +5 = 新文件 4 + materializer 1）；**我自己的构建 rc=0，imageId 与 worker 的逐位相同 `sha256:131de5e5…`**（可复现）；镜像内 uid 1000 实测见上；顺带核对 node 22.23.3 / python 3.11.2 / gh·tea·glab / `station-agentd-entrypoint`·`healthcheck` / `build-info.json`（0.1.44 + engine 0.26.0）**全部完好**（防中段改动误伤）。

**我自己的三条变异（每条先 `git diff --numstat` 自证非空操作，复原后 `git status` 干净）**：① 删掉 `grep -q '^10\.'` ⇒ `not ok 2`（断言那条）；② 把两条 COPY 顺序反转 ⇒ `not ok 1`（顺序那条，正是「10 被 8 的 muxer 盖掉」的静态哨兵）；③ `materializer` 告知面退回旧文案 ⇒ `not ok 14`（SDK 8+10 那条）。

**环境坑（本机，值得记）**：本机 `github.com` **直连已挂**（`--noproxy '*'` 20s 无响应），`docker build` 会卡在 CLI 下载层（#16）二十多分钟直到超时。必须走代理：`docker build --network=host --build-arg HTTP_PROXY=http://172.20.0.35:19001 --build-arg HTTPS_PROXY=… --build-arg NO_PROXY=127.0.0.1,localhost`（与 `portal/integration/lib/fde-image.mjs` 的既有写法一致；实测 `curl -x` 到 github 200）。另：这次两条 dotnet COPY 与断言层**在直连构建里全部 CACHED** ⇒ 可以直接判定 recipe 未变、失败纯属网络。

**已知 nit（故意保留）**：新测试对 **Dockerfile 全文**禁 `8.0.<数字>` / `10.0.<数字>`（含注释），所以将来谁想在某条注释里写「实测 8.0.427 通过」会红。这是刻意的——官方 tag 浮动，把补丁号写进镜像会随官方推补丁漂移；要记实测版本请记在本台账或 issue 里，别记进 Dockerfile。

**未做 / 待办**：① ~~发版 + `docker rm -f` 全部 `fde-*` 让 reconcile 重建~~ **已完成**（2026-11-09 现查）：随 **v0.1.45** 发布，并已随 v0.1.57 部署到 5 台 `fde-*` —— 容器内 `dotnet --list-sdks` = 8.0.427 + 10.0.403、`build-info.json` = station 0.1.57 / engine 0.31.0；② 本单**不碰** per-FDE / per-language 镜像（`FDE_IMAGE` 仍是全局单值，要改是另一个决策）；③ 不装 .NET 9、不改底座、不动 `FDE_MEMORY_LIMIT=4g`。

### 8.82 引擎升 pin 0.26.0 → **0.29.0**：扁平入参面被删，pin 与迁移必须同一次落地（2026-11-02，分支 `feat-261102-01-erix-agent-0.29.0`）

**载荷**：`erix-agent` 0.26.0 → **0.29.0**（两份 `package.json` + 两份 lockfile，`npm install --save-exact`）。
0.27.0 **从未发布**（npm 版本线 `0.26.0 → 0.28.0 → 0.29.0`；`npm view erix-agent version` = `0.29.0`、
`dist-tags.latest` = `0.29.0`，2026-11-02 现查），所以本站是**一跳**上去，没有 0.27 的中间形态要迁。

**为什么这一片不能 pin-first（与 §8.37 / §8.65 的差异，务必记住）**：0.28.0 是 **BREAKING**——上游
#498 S3 + #545 把 44 个扁平配置键从 `RUN_TOOL_LOOP_OPTION_NAMES` 里删了，写成扁平**在启动期就抛**：

```
unknown runToolLoop option: "maxRounds" (its canonical home is config.run.maxRounds; the flat spelling is rejected)
```

本站 `runner/worker.js` 走**直连** `runToolLoop`，此前传的 13 个扁平键
（`system` / `task` / `wrapup` / `context` / `modelMetadata` / `maxTokens` / `runId` / `resume` /
`maxRounds` / `stream` / `replayPolicy` / `reflection` / `initialUserMessage`）**全部被拒**。⇒
「先升 pin 让它变红、再按红格修」这条 0.22→0.23（§8.37）、0.25→0.26（§8.65）用过的节奏在这里**不成立**：
只升 pin 的后果是**每一个 run 在第 1 轮之前就抛**（不是「跑起来但某条判据红」）。0.29.0 本身则**不动入参面**
（§8 的 0.29 指南：没有选项被退役/改名/搬家），所以本片的迁移量全部来自 0.28。

**落点**（写侧住址只有一处：`runner/worker.js` 的 `await runToolLoop({`）：
- `system` / `wrapup` / `initialUserMessage` → `config.input.*`；`task` / `modelMetadata` → `config.metadata.*`；
  `maxTokens` → `config.tuning.maxTokens`；`context` → `config.folding.context`；
  `runId` / `resume` / `maxRounds` / `stream` / `replayPolicy` / `reflection`（三个数据成员）→ `config.run.*`。
- **观察者与端口保持顶层**（0.29 白名单 26 个名字里除 `config` / `capabilities` / `session` 外全是行为载体）：
  `provider` / `tools` / `executeTool` / `store` / `signal` / `semanticStateProvider` / 12 个 `on*` /
  `diagnostics`。`onFoldSummary` 也在顶层（#331 那根死光纤的老坑，C12/C14 钉着）。
- 三处标记注释**跟到新住址**（`#309:engine-model-params` → `config.metadata`/`config.tuning` 两组整组在标记内装配；
  `#392:context-strategy` → `config.folding.context`；`#392:C-onFoldSummary` 原地不动）。`#309` 的
  「camelCase 三键（`contextWindowTokens` / `maxOutputTokens` / `maxTokens`）各只出现一次、且只在那一对标记里」
  这把锁**一格没放宽**：`model-metadata.test.js` 的求值器改成「把标记段放回 `config` 里再求值」，
  断言换成 `modelParamsOf(params)`（判据仍是「两个叶子都不在 = 什么都不传」）。
- `assertCompactContext` **继续包住** `config.folding.context`（值一字未改：`{ strategy: 'fold-statistical' }`）。
- `config.run.stream` 传**布尔** `true`（0.28 新增值规则，非布尔两条路都抛）。
- 折叠策略**仍是 `fold-statistical`**（§8.73 的三条闸门：0.29.0 已发版 ⇒ 条件① 满足，②③ 未做 ⇒ 不动）。

**被更正 / 作废的旧口径**（都是这次实测推翻的，别再照旧引用）：
1. **「直连路径不校验 `context` 子键」已作废**。0.26.0 时成立（`option-normalization.js` 里没有语义相），
   0.28.0 把 `assertSemanticOptionValues` 放进了**两条路的公共前置**（上游 #496 S1）⇒ 现在**直连也拒**
   （`unknown assembly policy context option: "summarizerTimeout"; maxSummaryTokens must be a positive integer`）。
   `compact-knobs.test.js` K6 的标题与判据随之改写（从「引擎不校验」改成「引擎现在也校验」，**强度是升的**）；
   `assertCompactContext` 仍然保留，理由变成「本站口径的 fail-fast + 值必须同时过两道闸」，K7 继续钉着。
2. **`#309` 装配段不再在顶层**；`context` 也不再是顶层选项。任何按老住址抠源码的判据都要跟位
   （`fold-strategy.test.js` / `fold-notes.test.js` C14 / `compact-knobs.test.js` K7 / `fold-notes-e2e.test.js` 的求值器）。
3. **上游 `src/tools/` 不再平铺**：0.29.0 新增 `src/tools/delegation/` 子目录，`replay-policy.test.js` 里
   「上游工具源码零 `replay:` 标注」那条的读点从 `readdirSync` 平铺改成**递归收 `.js`**（判据强度不变、覆盖面更大）。
4. `worker.js` 里那句「pin 到 0.27.0 之后摘要 maxTokens 口径会变」的注释：**0.29.0 已含 #493**
   （摘要 `maxTokens = min(宿主 maxTokens, context.maxSummaryTokens ?? 1400)`），但本站仍不选 `fold-llm` ⇒ 真机不走到那条路。

**测试口径**（判绿 = 退出码 0）：
- 根 `npm test` **1718 格 / 1714 通过 / 0 失败 / 4 跳过，rc=0**（净 +3 = 新增 `runner/test/worker-options-address.test.js` 的 3 条；
  原本 `compact-knobs.test.js` K12 里那条「装上 0.27.0 后自动接管」的跳过格现在**真跑**了，与 4 个既有跳过格无关）。
- `node --test runner/test/*.test.js` **433 格 / 433 通过 / 0 失败 / 0 跳过，rc=0**（基线 430 = 429 通过 + 1 跳过，即 K12 那条「装上 0.27.0 后自动接管」的格；本片 +3 新格、且那 1 格现在**真跑**。⚠ 别用目录形式，本机是坏的）。
- `cd portal/frontend && npm run typecheck` **rc=0**。
- `cd portal/frontend && timeout 240 npm test`：**主 agent 在合并树上复跑两次，两次都是 53 文件 / 982 格全绿，rc=0**。
  worker 交回的是 **rc=1 / 3 格红**（`src/components/GitLightBadge.spec.ts` 的 `git-light-finish` / `git-light-ask` /
  `git-light-refresh`，报 `Target cannot be null or undefined`），并把它记成「既有基线红，在未改动的 main 上单跑同样 3 红」——
  **那句被现验推翻**：我在**未改动的 main 检出**（`/home/eric/projects/erix-station`，HEAD `201dd09`）单跑同一个 spec
  = **18/18 绿 rc=0**；又在合并树上做过**并发负载复现**（后台跑全量、同时单跑该 spec ×2）也**全绿**。
  ⇒ 定性：**worker 那 3 格红是它那一侧的环境性红灯，本机不可复现**（同 spec 同症状在 §8.48 有过先例：那次是主 agent
  并行跑重活压出来的）。**不是本片引入，也不是基线红** —— 两个说法都不成立，别再引用「基线 3 红」这句。
  ⚠ 本机 `NODE_ENV=production` ⇒ `npm ci` 默认**不装 devDependencies**，跑前端四件套前必须 `npm ci --include=dev`
  （否则 `vue-tsc: not found`）——这条是 worker 说对的一条运维口径。
- 四套随包契约（`transcriptStoreContract` / `toolResultEnvelopeContract` / `fileToolsContract` +
  `portal/test/transcript-store.test.js`）**零放宽**：0.29.0 没有新增翻红格；上面第 3 条那处只是**读点**更新。

**变异（每条先 `git diff --numstat` 自证非空操作，跑完 `git checkout --` 复原、`git status` 干净）**：
① `config.run.maxRounds` 搬回顶层扁平 `maxRounds`（`1 1 runner/worker.js`）⇒ `worker-options-address` **①、②③ 两格红**
（① = 顶层键不在引擎白名单；②③ = `config.run.maxRounds` 不在装配里）；
② 摘掉 `assertCompactContext` 那层包装（`2 2 runner/worker.js`）⇒ `compact-knobs` **K7 恰 1 格红**；
③ 版本线闸改回 `0.26.0`（`1 1 runner/test/llm-timeouts.test.js`）⇒ `llm-timeouts` **② 组 4 格红**（回归门那 4 条）；
同一变异改前端常量（`1 1 portal/frontend/src/lib/terminationReasons.ts`）⇒ `portal/test/termination-contract.test.js`
第 6 条 + `terminationReasons.spec.ts` 的「引擎取值面逐项在册」各 1 格红；
④ 折叠策略改 `fold-llm`（`1 1 runner/worker.js`）⇒ `fold-strategy` **A3 1 格红** + `compact-knobs` **K7 1 格红**（策略值那条）。

**主 agent 验收（2026-11-02，合并树 `review-029A`，依赖由 lockfile `npm ci` 装上后 `node_modules/erix-agent` 两处均 0.29.0）**：
- 四件套复跑与 worker 逐位相同：根 **1718 / 1714 / 0 失败 / 4 跳过 rc=0**、runner **433 / 433 rc=0**、
  `typecheck` **rc=0**、前端 **53 文件 / 982 rc=0**（前端那 3 格红见上一条的更正）。
- **亲跑 6 条变异**（不复用 worker 的结论；每条先自证**非空操作**、跑完复原并**用 md5 对一次**）：
  ① `replayPolicy` 值改 `always-replay` ⇒ `replay-policy` **2 格具名红**（主口径 + 刻意保守那条）；
  ② 折叠策略改 `fold-llm` ⇒ `compact-knobs` **K7** + `fold-strategy` **A3** 各 1 格红；
  ③ runner 版本线闸退回 `0.26.0` ⇒ `llm-timeouts` **4 格红**（② 组回归门）；
  ④ 前端版本线闸退回 `0.26.0` ⇒ `termination-contract` **第 6 格红**（引擎源码交叉核对）；
  ⑤ `maxRounds` 搬回顶层扁平 ⇒ `worker-options-address` **①②③ 两格红**；
  ⑥ **叶子放错组**（`metadata.modelMetadata` 改名挪位）⇒ `model-metadata` **5 格行为级红**
  —— 顺带量到一条覆盖面事实：`worker-options-address` 的 ②③ **看不见条件 spread 里面的键**
  （`...(engineModelMetadata ? { modelMetadata: … } : {})`），所以那一层的牙在 `model-metadata` 的行为级判据上。
  ⚠ 我自己有一次**空操作变异**（锚点缩进写错 ⇒ md5 前后相同），靠「先证变异真的改变文件」抓回（§8.24 同族，又一次）。
- **一条新的引擎事实（给切片 B 用，别按被作废的旧理由推理）**：0.29.0 的直连路径**会**校 `context` 的
  拼错键与旋钮非法值（`unknown assembly policy context option` / `maxSummaryTokens must be a positive integer`，
  我亲手探针复现），但**不校 `keepRounds`**：`{ strategy:'fold-statistical', keepRounds:-1 }` **跑通不报错**，
  而 `selectFoldedRounds` 的 `target = max(0, rounds.length - keepRounds)`（`src/compact/helpers.js`）会把
  **尾部轮也折掉**。⇒ `assertCompactContext` 的现役理由从「引擎不校」改成「**引擎漏校 `keepRounds`，且本站要
  的是 0 合法 / 负数拒**」；切片 B 传 `keepRounds: 6` 时这条闸必须已在。

**过程账（主 agent 的操作失误，代价 = worker 的 5 个 commit 只剩 patch）**：我按 §2.7 的收尾动作清理 worker worktree 时，
**在它自己 commit 之后立刻 `git worktree remove --force` + `git branch -D`**，而那 5 个 commit 既没 push 也没进 main
⇒ 提交对象随分支删除而不可达，**唯一载体是 subagent 自动导出的 `worktree-diffs/…worker.patch`（含 untracked 新文件）**。
落回方式：`git apply` 那份 patch（21 文件 / +902 −230，一次成功）。⚠ 连带一条更狠的同类坑：**补丁没 `git add` 时，
做变异用的 `git checkout -- <file>` 会把补丁一起抹掉**（它从 index 复原，而 index 还是 HEAD）——我一轮变异后就中了，
表现是「变异结果仍然对得上」但测的其实是未迁移的旧 worker。⇒ **口径：把外部交回的补丁 review 之前先 `git add -A`**，
此后 `git checkout --` 才只撤销变异；清理别人的 worktree 之前先确认它的 commit 已进 main 或已 push。

**已知边界 / 本片未做**：
- **不接派生面**：`createDelegateTool` / `config.run.parentRunId` / 五个端口（`runChild` / `notifyParent` /
  `transcriptPathFor` / `cwdFor` / `isProcessAlive`）**一律不接**。理由：本站 runner 没有「启动子 run」的原语
  （一个 run = 一个 worker 子进程，由 agentd fork），而且名册目录 `~/.erix/delegation/` 是**共享**的
  （0.29 指南 §3 明写：不接 `isProcessAlive` 就没有陈旧清理，别的进程能改写你那条记录）。要接是另一片活。
- **三个新叶子故意不传**：`config.folding.context.foldAtRatio`（默认 1.0 = 与今天逐字等价）、
  `workingSetRecentRounds`（默认 0 = 关；上游量的结论是**打开反而更贵**：11,467 → 46,476 token、重读 3 → 9）、
  `config.continuity.handoff`（默认 `off`；开了就由引擎当默认写者，请求里多一条 ~80 token 指令并落
  `~/.erix/continuity/`）。传了就是引入未量的行为变化 ⇒ 一律不传，只在这里登记它们存在。
- **事件承接面三处集合不动**：`compaction_deferred` / `config_override_conflict` / `budget_below_working_set`
  属**切片 B**（前端 `EVENT_TYPES` + `docs/api/portal.md` + `docs/data/model.md`），本片一个字节都不碰，
  避免两切片在同一片代码上打架。
- 不发版、不打 tag、不部署、不 `docker rm`；不动 `docs/data/schema.sql` 与 `deploy/migrations/`（本片零 DDL）；
  不动 `package.json` 的 `version`；不新增依赖。

**待办（主 agent）**：
- ~~**切片 B（工单 `.work-orders/erix-agent-0.29-sliceB.md`）**~~ ✅ **已落地，见 §8.83**（2026-11-02）：
  ① 事件承接面按**已安装引擎的 `LoopEvent`
  联合类型**重新对账（`compaction_deferred` / `config_override_conflict` / `budget_below_working_set`，以及只在
  `onEvent` 里出现、不在 typedef 联合里的 `continuity_injection_skipped` —— 要接就三处都接，要豁免就写理由，
  不允许「豁免表空着」）；② 折叠策略 `fold-statistical` → **`fold-llm`** 并**显式**传 `keepRounds: 6`（决策者
  2026-11-02 定）。理由：上游为语义折叠下的那些投资（`degradeKind` / `foldedFacts.origin:'llm'` / 横幅两态 /
  A2 降级告警）在本站**结构性不可达**，而 #469 那六张 PR 已随 0.29.0 发版（§8.73 闸门条件① 已满足）。
  配套：`assertCompactContext` 白名单加 `keepRounds`（**非负**安全整数，0 合法）；降级出口已核：`foldSummary`
  在 0.29.0 仍**只在 `compaction` 事件里**（不落轮记录），故 D 片横幅不声称降级，降级面归事件行 + runner LOG。
  ⚠ 两条不许写错的事实：**不传 `keepRounds` ≠ `0`**（引擎缺省 `?? 6`），且 `estimatedTokens / budget > 2` 时会
  自动收到 **2**（设计，不是 bug）；摘要调用**计入整 run 用量与 LiteLLM 账单**，但不污染 `latestApiInputTokens`、
  不计轮次/停滞。成本闸（②③）未量完之前不得发版。
- ✅ **发版号与真机结论见 §8.84**（`v0.1.46` / release `41459809767`；五台 `fde-*` 重建后引擎实测 `0.29.0`；
  真机三项——`fold-statistical` 时代的替代物问题由 `fold-llm` 的 `src:llm` 注取代、`usage.context_window` 与
  `max_tokens` 按元数据走、`judgeDoneAdvisory` 仍注入——都在 §8.84 的四个 run 里覆盖到了）。
  ⚠ 本片**动 `runner/`** ⇒ 必须重建 FDE 镜像 + `docker rm -f` 让 reconcile 重建（§8.17）。

### 8.83 切片 B：事件承接面对齐 0.29 的 19 类 + 折叠策略切 **`fold-llm`**（显式 `keepRounds: 6`）（issue #438，2026-11-02，分支 `feat-261102-02-erix-agent-0.29-sliceB`）

**本节收口 §8.82 末尾那条「待办：切片 B」**：① 事件承接面已按**已安装引擎的 `LoopEvent` 联合类型**重新对账；
② 折叠策略已切 `fold-llm` 并显式传 `keepRounds: 6`。发版号与真机结论仍留主 agent（见本节末）。

**载荷与落点**

- **承接面清单不再手抄**：`portal/test/event-surface-contract.test.js` 的 `ENGINE_PROMISED_EVENTS` 从
  `runner/node_modules/erix-agent/src/loop/orchestrator.js` 的 `LoopEvent` `@property` 联合类型**解析**得到
  （0.29.0 = **19 类**），解析不到就**抛**（整文件红），不许退化成硬抄清单——手抄清单正是这次的病灶
  （16 类那份不会自己红）。发射点扫描面 = 引擎 `src/` 下**全部 `.js`**（`attempt`/`recovering`/`recovered`
  在 `loop/provider-runner.js`、`run_outcome` 的记录体在 `loop/judge-record.js`）。
- **逐类三桶决定**（测里是三张表，每条都要么进时间线、要么写理由）：
  - **进时间线**（三处集合 + 中英双语标签）：新增 `compaction_deferred`、`budget_below_working_set`；
  - **只订不回放**：`usage`（运行态语义事件，#89 红线）；
  - **显式豁免**：`run_outcome`（0.29 下与 `run_end` 的重叠关系复核仍成立）、`config_override_conflict`
    （本站只写 `config.<组>.<叶>` ⇒ 结构上不可能；账在 runner warn LOG）、`continuity_injection_skipped`
    （**经 `onEvent` 真发但不在联合类型里**；本站不传 continuity ⇒ 注入分支进不去）。
- **联合类型之外真发的还有两个**：`continuity_written` / `continuity_write_failed`（续接块的写者那一半，
  `config.continuity.handoff=off` ⇒ 不发）——**故意不订**，理由写在测里的 `NOT_SUBSCRIBED` 表。
- **运维的嘴**（`runner/lib/engine-notices.js`）：`compaction_deferred` = **info**（每轮可能一条的正常推迟）、
  `budget_below_working_set` = **warn**（预算装不下工作集、run 提前收尾）、`config_override_conflict` = **warn**
  （宿主代码 bug）。数字缺 ⇒ `?`（#283），外来标识符过形状闸（#261），`conflicts` 缺席写 `?` 不写 `0`。
- **折叠策略**：`runner/worker.js` 的 `#392:context-strategy` 块现在是
  `assertCompactContext({ strategy: 'fold-llm', keepRounds: 6 })`（两个值都在标记区间内，`fold-strategy.test.js`
  按锚点抠块求值并**注入真 `assertCompactContext`**，§8.73 口径）。
- **判据翻向、强度只增**：`fold-strategy.test.js` B1 钉「策略名 = `fold-llm`」+「`keepRounds` **必须在场且 = 6**」
  （删掉那一行必须红——它测的是**显式写**，不是「引擎缺省也是 6」）+「除这两项外一个键都不许有」；
  B2 逐个钉四个上限（`summarizerTimeoutMs` / `firstByteTimeoutMs` / `maxSummaryBytes` / `maxSummaryTokens`）、
  `workingSetRecentRounds`、`foldAtRatio` **仍然不在场**；B3 钉 `config.continuity` / `continuityProvider` 不传。
  `compact-knobs.test.js` K4 把 `keepRounds` 的负例补齐（`-1` / `1.5` / `'3'` / `NaN` / 超安全整数 / `null`），
  正向钉 `0` 合法（= 全折，不能按 `>0` 判）。

**成本口径**（写清楚，别让下一个人以为折叠是免费的）

- 摘要器 = **本 run 的主力 provider / 同一模型**，摘要那一发**并入 run 总账**并转发宿主 `onUsage`
  ⇒ 界面上的 token 数**与 LiteLLM 的 spend 都会涨**（涨的是「折叠一次 = 一次额外 LLM 调用」这份钱）。
- 摘要那一发的 `maxTokens = min(宿主 maxTokens, context.maxSummaryTokens ?? 1400)`（erix-agent #493）
  ⇒ 本站按窗口算出来的 `max_output_tokens` 在摘要这条路上**不再说了算**（方向是变严）。
- 摘要在**轮循环之外** ⇒ **不计轮次、不参与 stall 判定**（erix-agent #167 那段注释的口径）。
- 本站**仍不传**那四个上限（上游缺省即本站裁定值，§8.73），也不给 env 旋钮：策略与尾窗不是运维参数。

**§8.73 三条闸门的状态**

1. 上游六张 PR（#482/#487/#488/#489/#490/#493）随 **0.29.0 已发版** ⇒ **① 满足**；
2. ② 隔离实例跑真长会话看 `foldSummary.degradeKind` / `finishReason` / 摘要字节数 / 横幅三件是活的
   —— ✅ **已做，见 §8.84**（真机上 `foldSummary = {inputTokens 8983, outputTokens 741, finishReason end_turn}`、
   无 `degradeKind`、折走存档 `tags=['fold','src:llm']`、事件行 `strategy fold-llm` 都实测到了；
   但**横幅那一件暴露了真缺口**：它显示「本次没有生成摘要」⇒ #440）；
3. ③ 量住「每轮多花多少时间」与「每次多嗂多少字节」 —— ✅ **已做，见 §8.84**（四个 run 的成本/重复读对照表，
   以及最重要的一条：门户合法窗口下策略层基本不触发，是 `ttl` 层在压）。

②③ 量不过 ⇒ **一行退回** `fold-statistical`（`worker.js` 那个块 + `fold-strategy.test.js` B1 + 本节；
`fold-notes-e2e.test.js` 的 E1/E2/E6 与 `session-view-fold.test.js` 的 B4 会跟着红，正好提醒你它们也要改）。

**已知边界**（事实，不是排期）

- **摘要器失败在 0.29 是 degrade 不是终态**：`foldSummary.degradeKind ∈ {timeout, context_window_exceeded,
  error, empty_summary}`，run 照旧跑完、模型拿到机械摘要；上游 main 已把这条改成终态错误 ⇒ **0.30 未发布**，
  届时升级要重核 `runner/lib/engine-notices.js` 的 A2 出口与 `fold-notes-e2e.test.js` 的 E8。
- 实测一条口径：走**引擎默认 provider 摘要器**时「摘要器回空文本」先被它自己拦成
  `default fold-llm summarizer returned no text`（不带 `summarizer_empty_summary` 码）⇒ 分类是 **`error`**；
  `empty_summary` 只在宿主注入的 summarizer 直接返回空串时可达（`fold-llm.js#assertUsableSummary`）。
- `compaction` 事件里的 `foldSummary` **不含 `source`**（`compact/pipeline.js:228-232` 明确只收诊断信号；
  `source` 在轮记录 `foldedFacts.source` 上）⇒ 谁在事件上读 `foldSummary.source`，谁就是在造第二个
  `unshrinkable`（永不触发的推测键）。判据：`fold-notes-e2e.test.js` E7 的 `hasOwn` 反向断言。
- `foldedFacts.origin` 的值域是 `mechanical|semantic|host`（**不是**字面量 `llm`）：`source: 'llm'` ⇒ `semantic`。
- 跨端边界（同 #349）：前端 jsdom 里跑不了引擎，也不许给 `portal/frontend` 加 `erix-agent` 依赖
  ⇒ A2 的**前端**文案只能用「runner 侧真跑实测出来的键面」钉，形状本身由 runner 侧真跑用例守着。

**待办（主 agent）**

- 发版号：**`v0.1.46`**（`deb3f2a`，release `41459809767`）；真机结论：**见 §8.84**。
- 真机四项**全部实测到**（§8.84 发现 ①）：① `compaction.strategyName = "fold-llm"` 且 `layers.foldLlm.triggered = 1`；
  ② 折走存档 `tags=['fold','src:llm']`；③ 摘要那一发 `inputTokens 8983 / outputTokens 741` 计入 run 总账；
  ④ 事件行实测 `Context compaction (round 25, strategy fold-llm): 1 rounds folded, 15136 → 6282 tokens`。
- ⚠ 本片**动 `runner/`** ⇒ 必须重建 FDE 镜像 + `docker rm -f` 让 reconcile 重建（§8.17：`ensureFdeContainer`
  不检镜像漂移）。

### 8.84 v0.1.46 发版与部署 + 闸门 ②③ 真机结论（issue #438，2026-11-02）

**载荷**：切片 A（PR #437）+ 切片 B（PR #439）。**本版动 `runner/` ⇒ FDE 镜像必须重建**（§8.17）。

**发版与部署**：`deb3f2a`（六文件 9 增 9 删）→ main CI `2f79bd8` 两个 job 全绿（含三镜像构建校验，**先等绿再打 tag**，
§8.32 那条纠偏）→ tag `v0.1.46` → release `41459809767` success → 清单 `imageId` 与部署机 `docker image inspect .Id`
**逐个一致**（portal `a5b08583…` / fde `7da8e5b8…` / proxy `d583a89e…`）→ `deploy/.env` 形态① pin **三项**
（备份 `/tmp/deploy.env.bak-0146`）→ `up -d --no-build` ⇒ portal 实跑 `a5b08583…`、迁移自动应用、经 Traefik `healthz=200`
→ **`docker rm -f` 五台 `fde-*` 后 reconcile 全部重建在 `0.1.46` + 容器内引擎 `0.29.0`**。

⚠ **tag push 又撞 github.com 直连不通**（`Failed to connect … port 443 after 133074 ms`）。判据与解法照 §3.7：
`--noproxy '*'` 探 `github.com` = `000`、探 `api.github.com` = `200`（两者可达性不同，所以 `gh api` 全程正常）；
`10.41.24.146:18099` 也不通，**本机可用的是 `172.20.0.35:19001`**（v2ray，实测 200/1.7s）⇒
`git -c http.proxy=http://172.20.0.35:19001 -c https.proxy=http://172.20.0.35:19001 push origin v0.1.46`。

⚠ **一条我自己犯的清理事故（零例外纪律的反面教材）**：我删 FDE 容器时用了
`docker rm -f $(docker ps -aq --filter "name=fde-")` —— 这个 filter **把用户的 `fde-workshop-db`（postgres:16.15，
另一个 session 正在用的测试库）一起删了**。§8.18 早就写过「清场必须按 `station.stack` / `com.docker.compose.project`
标签过滤，不能用宽名字匹配」，我违反了它。后果被那个 session 自己的重建机制吸收（容器与库都被它重建回来了），
但**这条口径必须按零例外执行**：删 FDE 容器前先 `docker ps --filter "name=fde-" --format '{{.Names}} {{.Image}}'`
**逐个人眼确认**，或按平台标签过滤；任何 `name=fde-` 的宽匹配都不许用。

### 闸门 ②③ 真机结论（决策：**保留 fold-llm + keepRounds 6，不回退**）

探针手法：带外把 `deepseek-flash`（只有 `fde-eric` 一个绑定引用，影响面最小）的 `context_window` /
`max_output_tokens` / `litellm_params.max_tokens` 临时改小逼出折叠，跑完**已复原并逐字段对照基线**。

| run | budget | 轮 | readFile | 重复读 | 折叠事件 | **foldLlm 真生效** | run 输入 token |
|---|---|---|---|---|---|---|---|
| 1 | 28000 | 9 | 40 | **0** | 0 | 0 | 148,656 |
| 2 | 14000 | 26 | 191 | **150（78.5%）** | 6 | **1** | 390,086 |
| 3 | 42598（门户下限 65536） | 11 | 41 | — | 9（全 `ttl` 层） | 0 | — |
| 4 | 42598 | 11 | 40 | — | 9（全 `ttl` 层） | 0 | 209,512 |

**① fold-llm 真生效时确实更好（硬证据）**：`layers.foldLlm.triggered=1`、`tokensSaved=8854`、
`tokensAfter=6282`（兜底层是 **268**）；`foldSummary = {inputTokens 8983, outputTokens 741, finishReason end_turn}`
（一次额外 LLM 调用、**无降级**）；轮记录 `foldedFacts.source='llm' / origin='semantic' / strategy='fold-llm'`；
折走存档 `tags=['fold','src:llm']`（另 5 条兜底的是 `src:strategy`）；摘要正文是语义化的
（`## 阶段 / ## 已改文件 / ## 已验证项 / ## 下一步 / ## 主题词面包屑 / ## 教训与坑`，并明确写
「已完成项禁止重做：不要重读 item-01.md 至 item-10.md」+ 逐个列出已读到的值），对比兜底层的
`【上下文折叠·v1】早期第 1–1 轮（共 1 轮）已折叠。工具足迹：无。`。界面事件行实测
`Context compaction (round 25, strategy fold-llm): 1 rounds folded, 15136 → 6282 tokens`。
⇒ **`strategyName` 显示面 / 折叠写注的 llm 形态 / `foldedFacts.origin=semantic` 三处死代码在真机上全部变活。**

**② 小 budget 下策略折不动 ⇒ 5/6 次落兜底全折 ⇒ 78.5% 重复读**：`rounds.length <= keepRounds(6)` 时
`target = max(0, len - 6) = 0`，引擎按设计叠 `slidingWindow(keepRounds: 0)` 全折到 268 token
⇒ 模型手上只剩一条摘要 ⇒ 重复读 150 次、输入 token 从 148,656 涨到 390,086（**2.6×**）。

**③ 最重要：门户合法窗口下策略层基本不触发，是 `ttl` 层在压。** run 3/4 用门户下限 65536（budget 42598）：
9 次折叠**全是 `ttl` 层**（`strategyName` 未设、`foldedRounds: 0`），`tokensBefore` 最高只到 **22,043 < 42,598**
⇒ 策略层一次都没被调用。原因：`ttl` 层对**工具结果**做 TTL 折叠（`toolResultFold`），把上下文稳定压在 ~20K；
探针是工具密集型所以它一直压得住。⇒ **生产窗口（`ctx=512000` ⇒ budget ≈ 460K）下 `fold-llm` 与
`fold-statistical` 都不会在短会话触发**（近 7 天实测单 run 输入平均 27,641、最大 257,207）——
切策略是「为更长的会话准备好」，**不是当前就能看到的收益**，别以为切了界面就会变。
真要在真机复现策略层折叠，必须**同时**满足 budget 小到 TTL 压不住（< ~20K）**且** 可折轮数 > 6。

**为什么不回退**：真生效时产出的是「经验」而非「足迹」（①的摘要正文是最好的证据）；生产窗口下不触发
⇒ 无成本代价；小窗口的退化（②）是 `keepRounds` 与 budget 的比例问题，回退到 `fold-statistical` 只会让
「能折的时候折得更差」，不会改善重复读。

**新发现的功能面缺口 → #440**：界面横幅对这次 fold-llm 折叠显示「**本次没有生成摘要**」，**这是错的**。
`session-view.js#hasRealSummary` 只读轮记录 `summary`（fold-llm 路径下引擎写的是字面量 `"missing"`），
而 LLM 摘要落在 `record.foldedFacts.text`（实测 2048 B 语义摘要）⇒ **fold-llm 唯一的价值面被系统性显示成
「没生成摘要」**。另开单，本版不修（要动 #390-A 钉着的 `hasSummary` 语义，得先定口径）。

**探针复原与残渣**：`deepseek-flash` 三字段全部改回基线（`ctx=512000 / maxout=32768 / litellm_max_tokens=32768`），
6 个模型逐字段核对通过。dev 残渣**故意保留**：会话 `e02d96cb…`（6 条折走存档，含 1 条 `src:llm`）、
`28b9f360…`、`e0a1e7eb…`，目录 `~/projects/probe-438`（80 小文件 + 40 个 13KB 大文件）—— 它们是横幅两态、
事件行策略名、折走存档三块面的现成回放标本。截图
`/docker/erix_station_playwright/v0146-438-fold-banner.png`。

**界面验收用的临时 Host 改写代理（本机解析不出 `station.fde.erix.vip` 时）**：`erix_station_playwright` 是
**host 网络**且带 `--host-resolver-rules=MAP * 100.100.0.3` ⇒ 浏览器直接访问
`http://station.fde.erix.vip:8090/` **就能通**（Traefik 收到正确 Host、浏览器自动带同源 `Origin`）。
⚠ 别绕远路：`http://127.0.0.1:8090/` 会 404（Traefik 只认那个 Host）、自己写 Host 改写代理还要处理
`Origin` 与 `Set-Cookie Domain`，白花时间（本次先绕了一圈）。

### 8.85 v0.1.47：#440 折叠替代物进 DTO（横幅三态）+ `folding.toolResultTtl` 旋钮（2026-11-03 凌晨）

§8.84 收尾时用户问「上游升级的红利都用上了吗，特别是折叠面」。审计结论里最扎眼的一条是：
**`fold-llm` 每次折叠真花 8983+741 token 生成的语义摘要，界面上一个字节都看不到**——本片修它，
顺带把两个从未传过的折叠旋钮显式传上（但**没能证明收益**，见下）。

**M1 = #440 本体。** 病根两层都在读侧：`hasRealSummary(record)` 只读 `record.summary`（`fold-llm`
写的是字面量 `"missing"`）⇒ `folded.hasSummary` 恒 false；而 `foldedTurnFields()` 的 `text` 取的是
**上游投影生成的折叠 turn 文本**，账本 `foldedFacts.text` **压根没进 DTO**。修法：新增三个**可选**键
`summaryText` / `summarySource` / `truncated`（键缺席语义照 #390-A：不写 `false`/`null` 冒充），
`hasSummary` 语义**一字未动**，横幅从两态扩成**三态**，零新增 UI 结构。
⚠ **机械路径刻意不换正文**：`fold-statistical` 的 `foldedFacts.text` 带引擎内部 marker
（`【上下文折叠·v1·erix-9f6e2c】`），只有 `source === 'llm'` 才用 `summaryText` —— 否则就是把引擎内部
版本号撒到用户界面上（这正是上游 #565 造 `foldedFacts.title` 要消灭的东西）。
⚠ `summarySource` 用**白名单** `llm|statistical` 而不是原样透传：引擎缺省是 `'strategy'`、另有 `'host'`，
这两个值在本站横幅上**没有第三态可落**（说是语义摘要是假话、说是机械替代物也不准）⇒ 整个键不给。

**真机验收用「旧账本、零重跑」**：会话 `e02d96cb…` 第 25 轮是 v0.1.46 时代折的，部署 v0.1.47 后
DTO 立刻给出 `round=25 hasSummary=False src=llm trunc=True text=1278B range={22,22}`，界面横幅变成
「what remains is an LLM semantic summary (fold-llm)」+ 夹断标记，展开画的是**账本里的语义摘要正文**
（`## 阶段 / ## 已改文件 / ## 已验证项 …`），不再是投影兜底句。截图 `v0147-440-fold-llm-summary.png`。
⇒ 读侧改动可以**只换 portal 镜像、不重跑 run、不动账本**验证，这条比「再造一个长会话」便宜一个数量级。

**M2 = `folding.toolResultTtl=6` / `toolResultFoldMinTokens=8000`（引擎默认 `2 / 4000`）。**
⚠ **本片没能用 A/B 证明收益，注释与台账都如实写「待验证的裁定」**（⚠ **这段的结论已被 §8.87 两次更正**——
「0 条 `compaction` 事件」对**那次探针 run 是正确观察**（上下文最大 9 万 < 预算 46 万，确实没折），
错的是把它推广成「死旋钮」；TTL 层**是**发 `compaction` 事件的）：v0.1.46 真机基线（12 个 4971 token
文件、8 轮、budget≈460K）观测到 **0 条 `compaction` 事件**、`input_tokens` **单调递增**
`4891→10639→18403→26962→43266→55463→68010→90263`（TTL 若折过必然回落）。引擎侧 `shouldSchedule`
要求 `remaining > 2` **且** `lowBudgetPrompted !== true`（`src/compact/pipeline.js:21-27`）
⇒ 这一层是**有条件**调度，不是「多轮任务必然关掉」（todo-multi 那 60 轮在第 50–57 轮折了 75 次，
两个条件在那里是满足的 —— 见 §8.87）。
⇒ 教训：**「引擎有这个旋钮」不等于「这一次的 run 会走到它」**；调参前先量「这一层到底触发没有」，
否则你以为在调参、其实那次 run 根本没到那一层（#331 死光纤的同族）。两行集中在 `#440:ttl-knobs` 标记里，回退 = 删两行。
另核实：引擎**不校验**这两个叶子的类型（`CONFIG_LEAF_VALUE_RULE_PATHS` 只有 `run.stream` /
`continuity.handoff` / `metadata.modelMetadata`；真链路实测 `'6'` / `-1` / `null` / `1.5` 全部正常收尾、不抛不告警，
静默退化成「TTL 折叠失效」）⇒ 本站补 `assertFoldingToolResultKnobs`（`0` 合法 = 关掉）。
**该缺口已作为 erix-agent#718 提出**（2026-11-05，P2，取证与三段复现脚本在单里）。

**基线**：根 **1727/1723/0/4 → 1736/1732/0/4**（+9）、runner **439 → 443**、前端 **53 文件 / 985 → 993**、
`typecheck` rc=0。**主 agent 亲跑 6 条变异**全红在具名用例，其中 **M6（`foldedFactsByRound` 用数组下标
当键）原 10 条全绿 ⇒ 定性真覆盖缺口**，补 `#440-D4`（两个折叠行 round 3/7）后重放**恰 1 条红在新用例上**。
⚠ 单折叠行夹具（round=1）恰好让下标键命中，这类「夹具太单薄导致变异测不出」的形状值得记住。

**发版与部署（v0.1.47）**：`e5513a7`（PR #441）→ `cca8d3f`（版本 0.1.47，六文件 9 增 9 删）→
main CI `41478854611` 两个 job 全绿（含三镜像构建校验）→ tag `v0.1.47` → release `41479818422` success →
清单三镜像 `docker image inspect .Id` **逐个一致**（portal `8400dceb…` / fde `eac553a6…` / proxy `e5d8d1a7…`）。
⚠ **fde 与 proxy 直连 GHCR 又拉不动**（`docker pull` rc=1）⇒ 老办法：先拉
`ghcr.nju.edu.cn/...:0.1.47`（成功），**再按 digest 拉 ghcr 一次**（层已在本地、秒回）⇒ 拿到 `repo@sha256:`
引用、pin 保持形态①。`deploy/.env` 三项 pin（备份 `/tmp/deploy.env.bak-0147`）→ `up -d --no-build` ⇒
portal healthy、`healthz=200` → **重建 5 台 FDE**，全部 `0.1.47 / engine 0.29.0`。

**两条过程账（都值一次记录）**：
1. **`git push -q -c http.proxy=…` 是错的写法**——`-c` 是**全局**选项，写在子命令后面会被当成 push 的参数，
   报出来的是 curl 的 `-6, --ipv6` 帮助文本（完全误导）。正解 `git -c http.proxy=… push`。
2. **重建 FDE 容器不能用 `--filter name=fde-`**：本站 5 台带 `label=station.stack=default`，而
   `fde-workshop-db`（另一个 session 的 postgres）**没有**这个标签 ⇒ 用
   `--filter label=station.stack=default --filter name=fde-` 精确圈定（§8.84 那次误删的正是它）。
3. **playwright 里「用 fetch 调 `/api/auth/login`」进不去 SPA 工作台**：cookie 种上了（`/api/me` 200），
   但 SPA 的 auth store 没被填充，路由守卫照样踢回 `/login`。正解 = **走登录表单**（或登录后
   `location.reload()` 让 store 从 `/api/me` 初始化）。本次用的是后者，且要等 ~2.5 s 再断言 DOM。

**未做 / 待验证**：① TTL 旋钮的 A/B（见上，需要「轮数充足 + 未进入催收尾」的长 run 才能触发 TTL 层）；
② `foldedFacts` 的 `origin` / `strategy` / `bytesBefore` 未进 DTO（只有 `source`/`text`/`truncated` 三个够用）；
③ 中文界面真机面未单独走（靠 `localeParity` + 组件用例兜底，英文面已真机验）。

### 8.86 v0.1.48：erix-agent 0.29.0 → **0.30.0**（LoopEvent 19→27 / `summarizer_failed` 终局 / `finalTextFallback`）（issue #442，2026-11-03）

⚠ **开工复核推翻了上游文档与我自己工单的前提，这条先记**：上游 `docs/host-upgrade-guide-0.30.0_cn.md` 写
「0.30.0 就是那个破坏包：16 个导出名被删除」，而 **npm 上发布的 0.30.0 一个都没删**——`exports` 仍指向
`src/index.js`，16 个名字全在导出面（只挂了 `@deprecated … removed in 0.30` 标记），上游 `origin/main` 的
`src/index.js` 也还在。包内 `CHANGELOG.md` 自述「`## [0.30.0] - 2026-11-03（未发布 / unpublished）`…the
published line is 0.29.0」，**与 npm 事实矛盾**（`dist-tags.latest = 0.30.0`，2026-11-03T01:38Z 发布，
`dist.shasum` 与本地 `npm pack` 的 tgz 同值 ⇒ 不是拉错了包）。⇒ **「安排」与「事实」的又一次分家**：
指南描述的是「0.30 这个破坏包会删」，而实际发出去的是「只带了摘要器终局那一条 Breaking 的 0.30」。
本片因此把 M1 的导出面那一半从「仍在导出面就红」改成「**版本章 + 导出面快照对账**」（照字面写会一落地就红），
**零消费者闸门仍是硬判据**。

**实际载荷**（比指南多，都是我在 `/tmp/ea30/package` 里量出来的）：

| # | 事实 | 本站处置 |
|---|---|---|
| 1 | 16 个导出名**仍在**（没删） | 零命中（逐个 grep 7 个目录）+ 新 `portal/test/engine-removed-exports.test.js`（Z0 扫描面 / Z1 零消费者 / Z2 版本章 / Z3 导出面快照 / Z4 名单自洽） |
| 2 | **`LoopEvent` 19 → 27 类**（+8，零移除） | 逐类三选一：`EVENT_TYPES` +6、`HISTORY_REPLAY_TYPES` +1、`http.js` +1、`engine-notices.js` 5 个 LOG、双语标签；`event-surface-contract.test.js` 三张表 + S6 反向 |
| 3 | **`summarizer_failed` = 终局错误**（#661） | `reason='failed'` + `errorCode='summarizer_failed'`；**「降级为统计摘要」路径已删** ⇒ 本站 §8.73 的 A2 降级出口读的 `foldSummary.degradeKind` **从此无值 = 死分支**（删；但 `inputTruncated`/`droppedRounds`/`budgetExhausted`/`finishReason` **仍生产，保留**） |
| 4 | **`finalTextFallback` 是新红利**（#476） | 全链透传：`termination.js` → `worker.js` → `agentd.js` → `internal.js`（只认 `=== true`，落 `runs.termination.finalTextFallback`，**零 DDL**）→ 前端**中性**分隔行（不进 `.syserr`：引擎如实交代不是故障） |
| 5 | `termination.reason` 字面量 | **零变化**（diff 确认；新增的是 `guardVerdict`/`finalTextFallback`/`deliverablesFailures` 这些附加字段） |
| 6 | `src/providers/**` | 只有 `anthropic.js` 变（工厂删除）；本站走 OpenAI 兼容 ⇒ 四相超时语义未动 |

**基线**：根 **1736/1732/0/4 → 1755/1751/0/4**（+19）、runner **443 → 451**、前端 **53 文件 / 993 → 998**、
`typecheck` rc=0。**主 agent 亲跑 6 条变异**全红在具名用例；其中 **V3（把读 `degradeKind` 的函数加回
`engine-notices.js`）原 10 条全绿 ⇒ 真覆盖缺口**（0.30 起引擎不再生产该键，行为级用例永远喂不出它），
补一条**源码级判据**（剥注释后不许出现 `degradeKind`）后重放恰 1 条红。
⚠ **V3 第一次做成了语法错误**（bash 把模板字符串里的 `${...}` 展开了）⇒ `# pass 0` 的红**不算数**，
重做后才定性（§8.33 那条「红了也要证明红来自你以为的那处改动」）。
⚠ 前端侧**不需要**额外源码级判据：V5（前端加回读 `degradeKind`）已被既有行为用例拦住（2 条红）。

**发版与部署（v0.1.48）**：`263e643`（PR #443）→ `e3d3485`（版本 0.1.48，六文件 9 增 9 删）→
main CI `41577347490` 两个 job 全绿 → tag `v0.1.48` → release `41577923228` success →
清单三镜像 `docker image inspect .Id` **逐个一致**（portal `0ffdc198…` / fde `909ca778…` / proxy `e46e1cff…`）。
⚠ fde 又是**先拉 `ghcr.nju.edu.cn/...:0.1.48`、再按 digest 拉 ghcr 一次**（第三次同一手法，已成标准动作）。
`deploy/.env` 三项 pin（备份 `/tmp/deploy.env.bak-0148`）→ `up -d --no-build` ⇒ portal healthy、`healthz=200`
→ **重建 5 台 FDE**（`--filter label=station.stack=default`，不是 `name=fde-`），全部 `0.1.48 / engine 0.30.0`。

**真机验收（v0.1.48）**：普通多轮 run（12 个 4971 token 文件）⇒ `finished/judge_done`、11 轮、12 个 readFile
**全唯一、0 重复读**、21 条 toolCall 全带 `resultPreview`、`messages` 2 条正文正常、agentd
`sse connected` + `sse ping received`、portal 日志无 error/warn ⇒ **零回归**。

**⚠ `folding.toolResultTtl=6` / `toolResultFoldMinTokens=8000` 在 0.30 下**依然一次没触发**（0 条 `compaction` 事件）**（⚠ **此判据已被证伪，见 §8.87**）——
这是**第二次**同结论（§8.85 首次）。不是版本问题：引擎 `shouldSchedule` 要求
`effectiveMaxRounds - budgetRounds > 2` **且** `lowBudgetPrompted !== true`（`src/compact/pipeline.js:21-26`），
而多轮任务一旦开始催收尾就关掉 TTL 层。⇒ **这两个旋钮至今没有收益证据**，仍属「待验证的裁定」；
真要验证必须造「轮数充足 + 全程未催收尾」的 run（另一片）。

**未做（如实记）**：① `summarizer_failed` 终局路径**没做真机注入**（要人为破坏摘要器/网关，风险高于收益）
——证据在单测（`runner/test/engine-notices.test.js` 的 `summarizerFailureNotice` + 前端 `RUN_ERROR_CODE_LABELS`）；
② `finalTextFallback` 的**真机造场**（需要 forcedFinal + 终稿空正文）同样未做，证据在
`runner/test/final-text-fallback.test.js` 与 `internal.test.js` 的落库/幂等用例；③ `budgetTokens` 显式预算未接
（窗口派生够用，要接得先量差）；④ `verification.guardVerdict` / `deliverables` 结构上不产生，不接。

### 8.87 §8.85/§8.86 的「TTL 没作用」是错的（它省了 31.4 万 token）——但**这次纠错自己也编了一个假机制**，2026-11-10 二次更正

> **两轮错误，按时间顺序读**（别只看中间那段就以为是最终结论）：
> **第一轮（§8.85/§8.86）**：8 轮探针 run 观测到 0 条 `compaction` 事件 ⇒ 结论写成「TTL 是死旋钮」。
> **第二轮（本节 2026-11-03 原文）**：为纠正上一条，我编了一个机制——「TTL 层根本不发 `compaction` 事件，
> 那条事件只由预算层发」。
> **第三轮（2026-11-10 复核，本节现状）**：那个机制**是假的**，TTL 层**会**发 `compaction` 事件。

#### 现在成立的事实（2026-11-10 现查 0.31.0 源码 + 真库）

**① TTL 层发 `compaction` 事件，而且一直在发。**

- 源码：`provider-runner.js:228-238` 在 `ttlStats.foldedCount > 0` 时调
  `ctx.recordCompactionLayer({layerId:'ttl', …})`；`orchestrator.js` 的 `recordCompactionLayer` →
  `recordCompactionStat`，而 `recordCompactionStat` **无条件**
  `emitEvent({type:'compaction', round, compaction})`。0.30.0 与 0.31.0 逐字相同。
- 真库：`run_events` 里 `type='compaction'` 且 `layers.ttl.triggered > 0` 的行存在——todo-multi 那三个 run
  分别 **27 / 13 / 13** 条，逐条带 `layers.ttl.{triggered,tokensSaved}`。

**② 所以 §8.85/§8.86 那次「0 条事件」不是判据用错落点，而是那次 run 真的没折。**

12 个 4971 token 文件、8–11 轮、`input_tokens` 单调爬到 90 263，而预算 ≈460 K ⇒ 上下文从来没到过折叠线，
`ttl` 层一次都没被调度。**0 是正确观察**，错的是把它推广成「死旋钮」。

**③ `ttl` 层的调度条件是「有条件」，不是「多轮任务必然关掉」。**
`compact/pipeline.js:21-27`：`remaining = effectiveMaxRounds − budgetRounds`，要求 `remaining > 2`
**且** `lowBudgetPrompted !== true`。todo-multi 那 60 轮在第 50–57 轮折了 75 次 ⇒ 那两个条件在那里**是满足的**。
所以「多轮任务一旦开始催收尾 TTL 就关」这句也是过度概括。

**④ 仍然成立的观测缺口（→ #451 / §8.88）**：`runner/worker.js` **从不消费** `result.compactionStats`
（只读 `termination`/`usage`/`rounds`/`finalText`/`finalTextFallback`），所以「这一层到底折了多少」
在会话级界面上看不见。§8.88 的 `session.compaction` 就是补这个。

**真相（现查全库 82 条带 `compactionStats` 的轮记录，2026-11-03 快照）**：

| 层 | triggered | tokensSaved |
|---|---|---|
| **ttl** | **75** | **314 518** |
| slidingWindow | 8 | （同批） |
| foldLlm | 1 | （同批） |
| enforceSize | 1 | |
| foldStatistical / anchors | 0 | 0 |

75 次**全部来自 todo-multi 那三轮多轮对话**（`ce0260ca-…`，29 / 44 / 60 轮，输入 1.12M / 1.31M / 1.95M token），
集中在第 50–57 轮。⇒ **TTL 层在长会话里每轮折 1 条、累计省 31.4 万 token**（占三轮总输入 4.37M 的 7%）；
在短 run（8–11 轮）里确实不触发（上下文还没堆到那个程度）。

**所以 `toolResultTtl` 2 vs 6 的区别是真实的**：`ttl=2` 时第 N 轮的工具结果第 N+2 轮变占位符，`ttl=6` 时第 N+6 轮才变
⇒ 多保留 4 轮原文（好处是不用重读，代价是上下文更大、可能更早触发策略折叠）。**但 `ttl=6` 至今没有长会话数据**
—— 2026-11-10 现查：TTL 折叠**最后一次发生在 11-02**，全是 v0.1.47 之前的 `ttl=2` 时代；v0.1.47 之后**一次都没折过**
（因为没有再出现过 ≥30 轮的会话）。⇒ 6 是好是坏**仍未验证**，要验只能真跑一个 60 轮 ~2M token 的任务
（基线 = todo-multi 第 3 轮：60 轮 / 1.95M token / 75 次 TTL 折叠）。**当前裁定：不做这个 A/B**
（2M token 换一个配置值，而项目正在跑安全线）；等自然出现一个 ≥30 轮会话时样本免费到手。

**教训（比结论值钱，两轮都适用）**：

- **「引擎有这个层」≠「它在事件面可见」** —— 这句话本身对，但它当时把我推向了「既然不可见，那它一定不发事件」
  的**编造**。**不可见 ≠ 不存在**：先 `grep` 发射点，再下结论。
- **一个 8 轮的探针 run 证明不了「某一层从来不工作」**。它只证明「这次没走到」。要推广到「死旋钮」
  必须有跨会话样本（那次现查全库才拿到，而第二次我连这一步都省了）。
- **每个事实都有自己的出口**：`foldSummary` 只在 `compaction` 事件里（§8.73）、`finalTextFallback` 只在
  `runToolLoop` 返回值上（§8.86）、TTL 的计数**既发事件也落轮记录**。猜出口会得出反向结论。
- ⚠ 代价不是返工：第一轮我差点建议用户**撤掉一个正在省 31 万 token 的配置**；第二轮又把这个配置的观测面描述错，
  等于给下一个人埋了同一颗雷。⇒ **撤或改之前，先证明它在自己的落点上确实（没）工作。**

**修法**（已完成，见 §8.88）：读侧从 `transcript_rounds.record.compactionStats` 聚合出 `session.compaction`
（零 DDL、覆盖存量），前端在既有位置给一行「压缩：TTL 折 N 条（省 X token）· 窗口折 M 次」。
这样「压缩有没有在工作」一眼可见，不必每次翻 SQL。

### 8.88 v0.1.49：`compactionStats` 观测面（#445）—— 压缩有没有在工作，界面上看得见（2026-11-03）

§8.87 那次纠错的落地。**零 DDL、零 runner 改动、纯读侧聚合**。

**载荷**：① 后端 `session-view.js#collectTranscriptFacts` 把「折叠真摘要 / 折叠替代物 / 压缩层聚合」收进
**同一次** `transcriptRows` 扫描（成本红线：`sessions.js` 只有一处 `FROM transcript_rounds`），
`getSession` 一次算好既喂投影又挂 DTO `session.compaction = {rounds, layers:{<id>:{triggered,tokensSaved}}, tokensSaved, lastRound}`；
② 前端 `lib/compactionSummary.ts`（纯函数 + `formatTokenCount` 复用）+ `StreamPanel.vue` 在**既有** `.session-stats`
行下追加一行，零新增容器、不进 `.syserr`、双语成对。

**三条硬口径**（都有判据）：**并入既有扫描**（不另发 SQL）/ **键缺席而非零**（一条 stats 都没有 ⇒ 整个键不给，
不是「0 次压缩」）/ **脏数据逐条跳过不炸**（`compactionStats: "oops"` / `layers: null` / `triggered: "abc"` /
`tokensSaved: -5` 四种形态 ⇒ 跳过该轮、其余照常、HTTP 200）。

**基线**：根 **1755/1751/0/4 → 1767/1763/0/4**（+12）、runner **451 不变**（不动 `runner/`）、
前端 **53/998 → 54/1012**、`typecheck` rc=0。

**变异**（主 agent 亲跑 3 条 + 源码审查 1 条）：C1 键缺席改成全零对象 ⇒ 判据 2 + HTTP 那条；
C2 去掉 `triggered > 0` 过滤 ⇒ 4 条 + 一趟扫描那条；**C3 只读 `stats[0]` ⇒ 判据 1 不红（真覆盖缺口，worker 如实报并补
「同轮多条」用例）**，红在补的判据 4 + 脏数据那条；C4（另起扫描）由源码审查确认（`sessions.js` 只有一处查询）。

**真机验收（v0.1.49，主 agent 亲手）**：会话 `ce0260ca-…`（todo-multi，60 轮量级）的 DTO
`compaction = {rounds:53, layers:{ttl:{triggered:53, tokensSaved:210481}}, tokensSaved:210481, lastRound:57}`，
界面 `.session-stats` 那行显示 **`Session compaction: TTL ×53 (saved 210.5k tokens)`**；对照一个没有折叠的会话
⇒ **整键缺席**（前端一个字节都不渲染）。截图 `/docker/erix_station_playwright/v0149-451-compaction-stats.png`。
⚠ 这个数**只覆盖最后加载的那一页**（`rounds=53` 是分页窗口内有 stats 的轮数，不是全会话 259 轮的全部）——
`lastRound=57` 与真库对得上，但「会话累计」这个词在超长会话上是**近似**（读侧只扫当前页的 transcript 行）。
若将来要精确全会话累计，得单独一条聚合查询（成本红线要重新评估），本片不做。

**发版与部署（v0.1.49）**：`bb0352d`（PR #444）→ `8943156`（版本 0.1.49）→ main CI 绿 → tag `v0.1.49` →
release `41741485753` success → **只 pin portal + proxy 两个**（`git diff v0.1.48..v0.1.49 -- 'runner/**/*.js'` **为空** ⇒
`FDE_IMAGE` 故意留在 v0.1.48 摘要 `fe46c38a…`、**不重建 5 台 FDE**）。portal 实跑 `86fd009a…`、`healthz=200`。

**⚠ 前端 3 条 `GitLightBadge.spec.ts` 红第三次出现（worker 环境）**：worker 报「主树同样 3 红」，
我在**无其他负载**下跑同一 worktree = **54 文件 / 1012 全绿 rc=0**。⇒ 与 §8.63/§8.82 同一形状：
**worker 跑前端测试时主 agent 并行跑重活**（根测试 / 大 SQL）会把它们压红。口径：派工跑前端期间，
主 agent 不要并行起重活；看到这类红先自己空载复跑，别改代码。

### 8.89 #446 真机演练（`summarizer_failed`）抓到两件事：注入路径不可行 + 历史回放缺人话（v0.1.50，2026-11-03）

**先说结论**：这次演练**没能在真机上让引擎真的抛 `summarizer_failed`**，但**抓到并修掉了一个真缺口**——
「同一个错误码，实时面有人话、刷新后只剩 `code=xxx`」。

**① 注入路径为什么不可行（结构性，不是成本问题）**。要让 `fold-llm` 的摘要器失败，唯一可造的形状是
「摘要器输入超窗 ⇒ 网关 400 ⇒ `context_window_exceeded`」。但引擎有两道结构约束把这条路堵死：

- 摘要器输入受 `keepRounds` 与窗口共同约束：被折轮 ≈ `总轮数 - keepRounds(6)`，而**主模型请求**是保留的那 6 轮
  + 系统提示（≈3300 token）⇒ 要让「被折轮 > 窗口」同时「保留轮 < 窗口」，必须精确控制单轮体积
  （`ctx=9000` 时 `per_round < 950` 且总轮数 > 15.5；`ctx=65536` 时 `per_round < 10373` 且 > 12.3 轮）。
- 更致命的是**超窗会自动重试一次，且重试是「砍一半」**（`fold-llm.js:573 retryBoundFor` → `Math.floor(current/2)`）
  ⇒ 要让重试也超窗，首次输入必须 > **2×窗口**，于是 `总轮数 > 2×ctx/per + 6`（`ctx=9000` 时 ≈ **25 轮**，
  且 `per_round` 要卡在 900 上下——主模型请求只剩 300 token 余量）。**这不是「跑一次就能造出来」的形状。**

⇒ 口径：**`summarizer_failed` 的引擎侧（`throw new KitError(...)`）由上游代码与本站单测覆盖，不做真机注入**；
真机只验**我们自己那一段**（终态落库 → DTO → 前端文案）。这条写下来是为了下次别再花 20 分钟算一遍。

**② 演练抓到的真缺口（已修，v0.1.50）**：`RUN_ERROR_CODE_LABELS`（`summarizer_failed → summarizerFailed`
的人话表）原先**只在实时 `run_end` 的 `d.error` 信封那一支被查**（`useEventStream.ts:1004`），而
**历史合成项 `run_termination` 只有 `termination`、没有 `error` 信封** ⇒ 同一个 `summarizer_failed`：
实时显示「压缩摘要器调用失败 ⇒ …」，**刷新后只剩 `run ended: failed — run failed（code=summarizer_failed）`**。
这违反 §8.47 立的口径「实时 `run_end` 与历史合成项**共用 `runEndLine`**（同文案同分级，否则刷新一次颜色就变）」。
修法 = 把查表挪进 `runEndReasonText`（两条路的唯一汇合点），未命中的码逐字保持 `（code=xxx）`。

**判据**：新用例 `historyRunEndEntry` 那条（真机形状：`run_termination` + `termination.errorCode='summarizer_failed'`
⇒ 文案含「压缩摘要器调用失败」+「重试」+ `code=`）+ 反向对照（未登记的码逐字不变）。
**变异**：把查表挪回只有实时面 ⇒ 恰 1 条红。基线 根 **1767/1763/0/4 不变**、前端 **54 文件 / 1012 → 1013**、
runner 451 不变、`typecheck` rc=0。

**真机验证（v0.1.50，DB 注入终态 + 浏览器）**：注入 `{reason:'failed', errorCode:'summarizer_failed'}` 到探针 run
⇒ 历史回放渲染 `run ended: failed — run failed（the compaction summarizer failed, so this run failed (this is not
a degraded summary: the context was not compacted; retry) · code=summarizer_failed）`（修复前只有 `code=…`）；
验完已复原（`judge_done` / `finished`），模型元数据 6 条全在基线（`ctx 512000|262144`、`maxout 32768`、
`litellm_max 32768`）。截图 `v0150-451-summarizer-failed-human-text.png`。

**⚠ 过程账（同一条坑第二次）**：我做变异时 `git checkout -- <file>` 把**尚未 commit 的修复**一起抹掉了
（§8.82 记过一模一样的教训）。⇒ **口径：做变异前先 `git commit`**，否则「复原变异」会把修复也复原掉；
发现后重新应用修复并**先提交再变异**，变异才红得可信。

### 8.90 v0.1.51：erix-agent 0.30.0 → **0.31.0**（16 个导出真删 / 六格全不变 / Z3 翻向成硬判据）（issue #447，2026-11-04）

**上游把 0.30 那句谎话修掉了。** 0.31.0 指南开篇就写：「这一版才是真正落地那 16 个删除的破坏包——0.30.0 指南宣布了
它们，而 0.30.0 的包里一个都没删」，并在 `CHANGELOG` 里给 0.30 那一页做了**勘误**（上游 issue #686）——
正是我在 §8.86 量到的矛盾。

**这一版对我们几乎是零改动**（指南 §4 六格逐格「不变」），我把三处复核做成了实测而不是引用：

| 复核项 | 实测结果 |
|---|---|
| `termination.js` 两份解包 `diff -u` | **逐字节相同**；reason 字面量两侧同十个值、typedef 两侧同九值同顺序 |
| `src/providers/**` | 只有 `anthropic.js` 变，且**只有一行注释**（`removed in 0.30` → `in 0.31`，工厂实现仍在）；`payload.js`/`timeout.js`/`errors.js`/`openai.js` 逐字节相同、`RETRYABLE_CODES` 同四码 |
| `budget.js` + `tool-result-ttl.js` | `diff -u` **无输出**；`TOOL_RESULT_TTL_DEFAULT=2` / `FOLD_MIN_TOKENS=4000` / `computeBudget` 全在原位 |
| `LoopEvent` | 仍 **27 类**逐名相同 |
| 16 个被删导出 | 0.31.0 两个入口**一个都不在**（0.30.0 时全在） |

**载荷**：pin 0.31.0（两处 + 两份 lockfile，`--save-exact` 未破）+ 三处版本线闸追号（`llm-timeouts` /
`terminationReasons.ts` / 其 spec）+ **Z3 翻向**。

**Z3 翻向是本单唯一的值**：`portal/test/engine-removed-exports.test.js` 的 ② 在 0.30 时代是「与实测快照逐名对账」
（因为那 16 个名字**还在**导出面，照字面写「必须不在」会一落地就红）；现在改成**硬判据**
`SURFACE_SNAPSHOT_0_31_0 = {'.': [], './tools': []}` + 断言「必须一个都不在」。**Z1（零消费者）一字未动**，
并在注释里补了一句「**上游删了也不许撤这一条**：将来上游把名字加回来时，Z1 是第一道（也是唯一一道）防线」。
Z4 的 `NOTE_VALUE_MAX_CHARS` 改成两入口**双向钉**（名单侧 + 快照结构侧），比原先更强。

**基线**：根 **1767/1763/0/4 → 1767/1763/0/4**（**逐数相同**，本片只改版本号常量与 Z3 快照）、runner **451 不变**、
前端 **54 文件 / 1013 不变**、`typecheck` rc=0。
**主 agent 亲跑 3 条变异**：W1 快照塞回一个名字 ⇒ `Z3` + `Z4` 红；W2 真 import `estimateMessagesTokens` ⇒ `Z1` 红；
W3 runner 版本闸回退 `0.30.0` ⇒ `llm-timeouts` 的 ② 组 4 条红（含「legacy 120s 绝对总闸」那条）。

**发版与部署（v0.1.51）**：`c71c3f8`（PR #448）→ `25752a3`（版本 0.1.51）→ main CI 绿 → tag `v0.1.51` →
release `41772471962` success → 清单三镜像 `image inspect .Id` **逐个一致**（portal `574ec081…` / fde `08621b3a…` /
proxy `c3ab6488…`）→ `deploy/.env` 形态① pin **三项**（本版 `runner/package-lock.json` 变 = **引擎 pin 变了** ⇒
**含 `FDE_IMAGE`**；备份 `/tmp/deploy.env.bak-0151`）→ `up -d --no-build` ⇒ portal healthy、`healthz=200` →
**`docker rm -f` 5 台 FDE，reconcile 全部重建在 `0.1.51 / engine 0.31.0`**。

⚠ **「引擎 pin 变」必须重建 FDE 容器**（§8.38 那条跨镜像类推的坑）：引擎装在 FDE 镜像里，
`git diff -- runner/**/*.js` 为空**不代表**镜像没变——`runner/package-lock.json` 变了镜像就变了。
这与 §8.19「runner 只有版本号变动就不重建」不是同一类（那次是站内 runner 代码没变且引擎 pin 没动）。

**真机验收（v0.1.51）**：端到端 run ⇒ `finished/judge_done` + 助手回 `pong`；agentd `sse connected` +
`sse ping received`；portal 日志无 error/warn；**容器内实测 0.31 的导出面**：`createAnthropicProvider` /
`estimateMessagesTokens` / `serializeFoldedMessages` / `parseSummary` 四个抽样名字**全部「已删 ✓」**
（这是 Z3 断言在真机上的镜像验证，不只是单测）。

### 8.91 宿主注入 AGENTS.md 层级链（issue #451）：告知面不再靠模型自觉

**需求**（决策者 2026-11-05）：「作为宿主需要实现一个功能，让 agent 读取 `AGENTS.md` 以及上级目录的 `AGENTS.md`」——
参照 pi 的 `global → 父目录 → 当前目录` 逐级拼接。评估稿：`docs/design/agents-md-layering-2026-11-05.md`（含全部实测与设计）。

**为什么不是「再加一条提示词」**（14 天真机实测，`station-db` 现查）：35 个 run 里只有 **5 个**跑过含 `AGENTS.md` 的命令
（14%，其中 **4 个是我自己的验收探针**，真实任务 5 个 run 只有 1 个读过）；读过的 5 个里 **4 个**自带 `head -50/60/80` 截断，
而 `~/AGENTS.md` 共 67 行、**「收工即提交」（#359 D9）在第 53–54 行** ⇒ `head -50` 正好把它切掉。第三条是机制性的：
`cat` 结果住在某一轮里，**整轮被 `fold-llm`/`sliding-window` 折走时一起消失**，而 system prompt 永不折叠
（⚠ dev 全库只有 2 个会话折过轮、都没读过 `AGENTS.md` ⇒ 这条是「机制上必然、dev 尚未观测」，别写成已修 bug）。
另外两个既有欠账一并解决：**父目录层今天根本不存在**（提示词只提 `~/AGENTS.md`）；`readFile` 读不到它们（jail root = cwd，#259 未落地）。

**裁决（决策者 2026-11-05，四条）**：① **平台节优先**——与 pi 的「内层一律优先」有意不同，平台规则是运行期硬约束
（端口号池、边缘剥 Cookie），违反 = 应用必挂；② 注入范围 = 祖先链（`$HOME` → `$HOME/projects` → 项目根）+ **子目录索引**
（只列路径、≤5 条、不注入正文：仓库自带的 `AGENTS.md` 不在 cwd 的祖先链上）；③ **#259 另开一单**（本单 `runner/lib/file-tools.js` 一字节未动）；
④ **不加 env 旋钮**（§8.73 口径），回滚 = 删 `worker.js` 里那一个接线点。

**实现**：新增 `runner/lib/agents-md.js`（362 行，纯函数 + 可注入 fs）——`resolveAgentsMdChain` / `collectAgentsMd` /
`renderAgentsMdSection`；`runner/worker.js` 在 **`startRun` 内部**采集（cwd 已知之后）并 `system: SYSTEM_PROMPT + agentsMdSection`。
八条硬口径：链由外到内 · `scope` 三档（`platform`/`workspace`/`project`）· 不存在/空白/非普通文件/**sha256 相同**一律跳过 ·
`realpath` 越界（symlink 逃逸）跳过 · 单文件 16 KiB / 全链 48 KiB（**超限从内层开始整份挤掉**，平台节必须完整）·
任何读取失败降级为「跳过 + note」**绝不抛** · 子目录索引排序后取前 5 · **渲染禁时间戳/run id/generation**
（system 是引擎 `markStablePrefix` 的缓存稳定前缀；文件不变 ⇒ 输出逐字节不变；**无 blocks ⇒ 空串**，`system` 逐字节等于原值）。
**口径补齐（#451 评审 M2）**：子目录索引**只在至少注入了一份文件时才渲染**（`blocks` 为空 ⇒ 整段为空串、索引不单独出现：口径 7「子目录索引」与口径 8「无 blocks ⇒ 空串」的真取舍，实现按 8 裁）；补偿是 `worker.js` 那条 info 记账里拼上**前 2 条 note 摘要**（超过 2 条加 `…`，仍是 `MSG.LOG`、不新增事件类型）。
抬头由**宿主**生成（正文归 materializer，抬头归 runner，两边不互相引用）：顺序由外到内 / 平台节不可覆盖且冲突要告知用户 /
已注入勿重复 `cat` / 本 run 内改动下次 run 才生效。记账走现成 `MSG.LOG`（info，`files= bytes= truncated= subdir_hints= notes=`），
**不新增事件类型**；指针段（`worker.js:89`）从「开工前先读」改成「已随本次 run 注入」，保留 `cat ~/.erix/ports.json`（动态清单）
与 shell 复核口径。

**⚠ 返修 F1（主 agent 亲审抓到的真缺口）**：第一版采集器**会抛** —— `realpathOr()` 把 `path.resolve(p)` 写在 try 外面，
`collectAgentsMd({})` / `({cwd})` / `({home})` 三种入参都抛 `TypeError: The "paths[0]" argument must be of type string`。
而调用点在 `startRun` 里、`runToolLoop` **之前** ⇒ 抛出去 = worker 进程死 ⇒ agentd 当崩溃 requeue ⇒ 3 次耗尽，
用户只看到「attempts exhausted」，根因只是一个路径参数形态不对（工单「失败一律降级」的反例）。两处一起修：
模块侧非字符串/空串 ⇒ `null` 降级（`cwd` 不可用 ⇒ 空链，**不凭空造 `process.cwd()`**；`home` 不可用 ⇒ 只按 cwd 采集）+
worker 侧整段包 `try/catch`（失败 ⇒ 空段 + warn，catch 内不得再抛），各配判据。

**基线**（主 agent 亲跑，判绿 = 退出码）：根 `npm test` **1767/1763/0/4 → 1789/1785/0/4**（+22 = `runner/test/agents-md.test.js` **20 格**
+ `system-prompt.test.js` 两条接线锁；指针用例**等强度换向**：从「必须写先读」改成「必须写已注入」+ 显式禁旧口径，
**8 规则词禁词与 `0.0.0.0` 断言一字未动**）；`cd runner && node --test` **451 → 473**。零 DDL、零依赖、零 lockfile、
`portal/**` 与 `portal/frontend/**` 零字节。

**变异（主 agent 亲跑 6 条 + 返修后 4 条，每条先 `git diff --numstat` 自证非空操作、跑完还原）**：渲染插时间戳 ⇒ 恰 1 红（确定性）·
去 `dirs.reverse()` ⇒ 10 红 · 摘 symlink 越界守卫 ⇒ 恰 1 红 · 全链超限改从外层截 ⇒ 恰 1 红 · 顶层多一处 `collectAgentsMd(` ⇒ 恰 1 红（锁①）·
无 blocks 也渲染抬头 ⇒ 恰 1 红 · **守卫+try/catch 一起移除（回到返修前形状）⇒ 3 红**（含「绝不抛」那条）·
`catch` 里塞非空注入段 ⇒ 恰 1 红（锁③）· try/catch 摘掉（语法合法版）⇒ 恰 1 红（锁③）。
⚠ 我第一次做「只摘字符串守卫」时**只有 2 条红**（`path.resolve('')` 返回 cwd 而非抛），说明单靠守卫不够、try/catch 才是兜底 ——
这条正是把两者都保留的理由。

**真机验收（2026-11-05，dev 栈，主 agent 亲手；手法 = 把新 `worker.js` + `lib/agents-md.js` 热 patch 进 `fde-eric:/opt/erix/`，
验完 `docker rm -f` 让 reconcile 从 pin 镜像重建、热 patch 自动消失）**：

- **D1（无读也照做）**：会话 `bc9b222f…` / run `b3c9f528…`（11 轮，`judge_done`）。`run_events` 里含 `AGENTS.md` 的
  tool_use **0 次**（只有 1 次读 `ports.json`，那是设计内），而 agentd 日志 `agents-md injected: files=1 bytes=9018 truncated=0`。
  回复：端口取自清单（22000）、`--bind 0.0.0.0`、**给了完整预览 URL 且是 markdown 链接**、提醒逐 host 放行（第 2/6/8 条全中）。
- **D2（`head -50` 丢的那条）**：同一个 run **自己提交了** `3ae9129 Add minimal index.html`，`git status` 干净 —— 收工纪律生效。
- **D3（冲突夹具，验证裁决①）**：往项目里写 `AGENTS.md`「端口固定 3000，不要用清单端口」后重跑（run `49ad0966…`）：
  日志 `files=2 bytes=9182`、tool_use 读 `AGENTS.md` 仍 **0 次**；模型**主动指出这处冲突**、按平台节选了 22001，并给了两条理由
  （平台节优先 + 3000 没有预览路由、外部打不开），最后**告知用户冲突**并要求平台把 3000 纳入分配段 —— 抬头四句里那句
  「冲突按平台节执行并在回复里告知用户」在真机上真的被执行了。
- **D4（成本，含对照组）**：注入后 run `b3c9f528`（11 轮 / 输入 128 842 / `cacheRead` 105 984 = **82.3%**）、
  run `49ad0966`（16 轮 / 91 023 / 68 224 = **74.9%**）。**对照 = 把原 `worker.js` 换回去**跑同一道题（run `b14e70a7…`）：
  它**读了** `AGENTS.md`（1 次）且带 **3 次 `head -`**，10 轮 / 99 146 / 86 272 = 87.0%。
  ⇒ 结论按设计稿 §4.4 的口径落地：**对「本来就会读」的 run，注入的边际成本 ≈ 1 轮的量**（每轮 +1.8 k，远小于 4.4 k 的名义增量，
  因为对照组把那 9 KB 也揣在上下文里）；`cacheRead` 比例没有变差（注入的 system 前缀照样命中缓存）。
  真正的净增只出现在「今天压根没读」的那 86% run 上 —— 而那正是要修的部分。
- **D5（长会话后半程不丢规则）未做**：要 60 轮量级 + 触发折叠，成本高；机制上 system prompt 不参与折叠
  （折叠摘要进的是 **user** 消息，`summaryRole` 默认 `"user"`，`src/compact/budget-fit.js:134`），且 dev 只有 2 个会话折过轮。
  已如实记在设计稿 §7 的 S4 行，**没有**拿「机制」冒充「已验」。

**已知边界 / 后续**：① **#259（jail 只读例外）仍独立**——注入是主路径，`readFile ~/AGENTS.md` 依旧会撞边界，shell `cat` 是复核手段；
② `~/.erix/ports.json` **不注入**（动态清单，仍 `cat`），要不要注入另议；③ 子仓库的 `AGENTS.md` **只给索引不给正文**，
模型要进那个目录才读；④ 不给 env 开关；⑤ 成本口径只在「一个任务形状 + 一个对照组」上量过，不是统计结论。

**⚠ 顺带更正两处错号**（本单开工时发现）：§8.88（`compactionStats` 观测面）与 §8.89（`summarizer_failed` 真机演练）都写着 `#451`，
真实分别是 **#445** 与 **#446** —— 而 `#451` 现在正是本单，不改就会指向错对象（标题行已改）。

**发版与部署（v0.1.52，2026-11-05，主 agent 亲手）**：main `55edff4`（版本 bump 六文件 9 增 9 删）→ main CI
**两个 job 全绿**（质量门禁 + 三镜像构建校验，先等绿再打 tag）→ tag `v0.1.52` → release run `41977575433` success →
清单 `images-digest`：portal `imageId=1bda4ff3…`/`digest=8b3cb82c…`、fde `imageId=983cc2bb…`/`digest=4e2fa6fd…`、
proxy `imageId=7bae3eca…`/`digest=538ecc32…`。
⚠ **本版只 pin `FDE_IMAGE`**（`deploy/.env`，备份 `/tmp/deploy.env.bak-0152`），portal/proxy **仍留 v0.1.51**：
本单改动全在 runner（注入生效只需新 FDE 镜像），而 main 上同期还有**另一个 session** 在推 #449（登录第二因素邮箱码）
的后端/管理台切片 —— 它的 portal 侧代码不必随本单上线（三片都 default-off，但没必要替别人做部署决定）。
`docker pull` 只拉了 fde：`docker image inspect .Id` = `sha256:983cc2bb…` **与清单 imageId 逐位一致**、`RepoDigests` 含清单 digest。
`docker compose -p station up -d --no-build station-portal` 重建 portal（拿到新 `FDE_IMAGE`）时 **`station-docker-proxy` 被作为依赖连带重建**
⇒ 它的 `IMAGE_ALLOWLIST` 同步换成新 digest（**这是必须的**：白名单是**另一个容器**的 env，只改 portal 的 `FDE_IMAGE`
会在 `docker create` 时被 proxy 拒成 `create_policy_denied`，§8.70 那个事故的同型坑）→
`docker rm -f` 五台 `fde-*`（**按 `label=station.stack=default` + `name=fde-` 双过滤**，§8.84 误删 `fde-workshop-db` 的教训）→
reconcile 40 秒内全部重建在 `983cc2bb…` 且 healthy、容器内 `station 0.1.52 / engine 0.31.0`、agentd `sse connected` + `sse ping received`。

**发布物验收**（不是只信热 patch）：会话 `83b57016…` / run `3440e8a8…`（9 轮）——agentd 日志
`agents-md injected: files=1 bytes=9018 truncated=0 subdir_hints=0 notes=0`；**9 次 tool_use 里含 `AGENTS.md` 的 0 次**；
回复给了完整预览 URL（`eric-p-22000`）+ `--bind 0.0.0.0` + 403/502 两种失败形态对照 + `git commit 4f75781` 收工。
dev 残渣（故意留作标本）：`~/projects/probe-451`（含那条「端口固定 3000」的冲突夹具 `AGENTS.md`）、`probe-451b`（对照组）、`probe-451c`。

### 8.92 #450 管理台独立入口（9443 + TLS 装载面 + 边缘双向隔离）——A1 切片（2026-11-05，分支 `feat-261105-01-450-admin-entry-A1`）

**规格来源是 #450 的「决策记录」评论**（用户裁决 + 我按原理补的四条），不是我的转述。一句话：
**能力边界由「host × entrypoint 的交集」决定**，与页面在哪个 origin 渲染无关。

| # | 决策 | 落点 |
|---|---|---|
| D0 | 端口 **9443**，配置住部署面 `TRAEFIK_ADMIN_PORT`；**管理台不提供端口写入口** | `deploy/traefik/traefik.yml` 的 `adminsecure` + `deploy/.env` + `portal/src/config.js` |
| D1 | 独立 host `admin.<伞域>`（`ADMIN_PUBLIC_HOST` 可覆盖，非法形态回退默认 + warn） | `config.js#resolveAdminHost`（复用 `validateHostnameGrammar`，零新错误码） |
| D2 | 边缘双向隔离：管理台入口只挂 ①SPA ②`/api/admin` ③`/api/auth`+`/api/me`；用户入口 deny `/api/admin/*`；管理台 host 上其它 `/api/*` 也 deny；**预览路由不挂管理台入口** | `portal/src/routes.js`（`admin-api`/`admin-auth`/`admin-spa`/`admin-deny-user`/`admin-deny-api`） |
| D4 | `ADMIN_IP_ALLOWLIST`（逗号分隔 CIDR，**空 = 不挂中间件 = 放行全部** = 今天的现状） | `config.js#resolveAdminIpAllowlist` + `admin-allow` 中间件 |
| D5 | 证书走**动态**配置：`<dynamic>/tls.yml`，**两文件齐才生成**，带随证书变化的 fingerprint 注释当 reload 把手 | `portal/src/tlsassets.js` |

**四条实测换来的事实（都不许按文档/直觉重推）**

1. **`${VAR}` 在 Traefik 静态配置文件里不插值**（`traefik:v3.7.13` + `--configFile` 三种写法逐一实测）：
   `"${TRAEFIK_ADMIN_PORT:19443}"` ⇒ `listen tcp: lookup tcp/19443}: unknown port`；`"${TRAEFIK_ADMIN_PORT}"` ⇒
   `missing port in address`；`TRAEFIK_ENTRYPOINTS_ADMINSECURE_ADDRESS` 这类 env 静态覆盖**同样被忽略**。
   ⇒ 端口只能**写死**在 `deploy/traefik/traefik.yml`。**于是它有两处真值**（静态文件 + `deploy/.env` 的
   `TRAEFIK_ADMIN_PORT`），由 `portal/test/deploy-env-defaults.test.js` 把「静态字面量 / compose 插值默认 /
   代码默认」三条读出来对比钉住——人记不住，让机器记。
2. **`station-edge` 是 `network_mode: host` ⇒ 写 `ports:` 会被 Docker 静默丢弃**（`Published ports are discarded`，
   compose 连警告都不给）。所以工单里那句「publish 9443」在本仓不成立，改成注释 + 单点真值（宿主端口 = 容器端口）。
3. **`ipAllowList` 的 `sourceRange` 不能是空数组**：Traefik 会 `ERR sourceRange is empty, IPAllowLister not created`
   —— 中间件**根本不存在** ⇒ 路由回落 catch-all ⇒ **静默放行**。所以 ① `ADMIN_IP_ALLOWLIST` 为空时**不生成**
   `admin-allow` 也不挂它（不是挂一个空 sourceRange）；② deny 中间件用 **RFC 5737 的 `192.0.2.0/24`**（文档网段、
   永不匹配真实客户端）+ `rejectStatusCode: 404` + `service: noop@internal` = 「恒拒 + 不碰任何后端」。
   v3.7 没有「直接返状态码」的中间件（`headers` 只有 `customResponseHeaders`），这是唯一稳定产 404 的路子。
4. **deny 的优先级取 300**（> internal 200 > portal 100）。取 150 也够用（`/api/admin` 与 `/api/internal` 不交），
   但那样「deny 生效」就依赖「路径永不重叠」这条隐式前提；300 把不变量写成「deny 永远压过一切本地路由」。

**真机验证（一次性 `traefik:v3.7.13` + 本仓真实静态文件 + 真实生成物 + 逐请求打 access log 的 nginx 后端；
现网容器零动作）**：隔离矩阵 13 条（用户入口 `/api/admin*` ⇒ 404、管理台入口 `/api/sessions`+`/api/internal/x` ⇒ 404、
两个「别人的 host」⇒ 404、允许面全 200）；**deny 的后端命中 0 行**（不是从状态码猜，是数 nginx access log）；
免重启换证往返（`CN=admin.fde.erix.vip` ↔ `TRAEFIK DEFAULT CERT`，全程路由不丢）；`ADMIN_IP_ALLOWLIST` 两态（名单外 403/0 命中、
名单内 200，且 deny 不受白名单影响）。⚠ 探针坑：`traefik/whoami` **不逐请求打日志** ⇒ `grep -c` 数出 0 是**假信号**；
nginx 默认站对未知路径回 404 又会让「允许但没这个文件」和「被 deny」看起来一样 ⇒ 换成「恒 200 + access log」才消歧。

**基线（主 agent 亲跑，判绿 = 退出码）**：基点 `41e76b0` **1833 / 1829 / 0 / 4** ⇒ 本单 **1859 / 1855 / 0 / 4**
（净 **+26** = `tls-assets` 8 + `routes` 9 + `config` 7 + `deploy-env-defaults` 2）；`runner` **473/473 不变**；
前端 **1072 不变**（本单前端零字节）。**主 agent 亲跑 6 条变异全红在具名用例**（每条先 `git diff --numstat` 自证
非空操作、跑完还原）：`admin-api` 摘 `tls:{}` ⇒ 2 红；deny 优先级 300→150 ⇒ 2 红；空 allowlist 也生成并挂
`admin-allow` ⇒ 2 红；fingerprint 写死 ⇒ 3 红；证书缺失时不摘旧 `tls.yml` ⇒ 2 红；adminHost 非法不回退 ⇒ 1 红。
worker 另跑 3 条（预览路由挂管理台入口 / deny 不挡 `/api/admin` / 一文件也生成 `tls.yml`）。

**上线口径（本单没碰现网，所以 9443 现在不通）**：`deploy/.env` 加 `TRAEFIK_ADMIN_PORT=9443`（可选
`ADMIN_PUBLIC_HOST` / `ADMIN_IP_ALLOWLIST`）→ `docker compose up -d --force-recreate station-edge`（**静态配置只在启动时读**）
→ `up -d station-portal`（拿新 env）。**首张证书人工落盘** `<dynamic>/certs/tls.{crt,key}`（鸡生蛋：没 TLS 进不去管理台，
进不去就传不了证书），必须覆盖 `admin.<伞域>`；不放则管理台用 Traefik 内建自签证书应答（`__Host-` cookie 仍成立）。
⚠ **A2 未做前不要部署**：用户入口已经 deny `/api/admin/*`，而管理台 SPA 仍随用户面下发、不会自动跳管理台
⇒ 现网在用户 host 上打开 `#/admin…` 会「页面在、API 全 404」。A2 = host-aware 跳转（#450 D3）。

### 8.93 #450 A2：host 闸（用户面 ↔ 管理台跨 host 跳转）——不跳就是「页面在、API 全 404」（2026-11-05）

A1（§8.92）把**边缘**隔离做实了，但 SPA 还是同一份、两个 host 都下发。于是「在用户 host 上打开
`#/admin/users`」= 页面渲染得出来、**所有管理 API 404**（用户入口 deny `/api/admin/*`）；反方向
「管理台 host 上打开 `#/session/<id>`」= `/api/sessions` 被 deny。⇒ A2 只做一件事：**发现自己在错的 host 上就换地址**。
**D3 未变**：不改成 path 路由、不拆两份产物、hash 路由形态一字不动。

**载荷（19 文件，前后端各一半）**

| 面 | 落点 |
|---|---|
| 后端 | `GET /api/site`（**公开、零秘密**）：`{userBaseUrl, adminBaseUrl}`，两个值都取既有配置（`resolvePublicBaseUrl()` 与 A1 的 `adminPublicBaseUrl`），**handler 里不另拼 URL**；非 GET ⇒ 405 |
| 路由生成 | `admin-auth` 允许面加 `/api/site`，`admin-deny-api` 排除列表**同步**加 `!PathPrefix(/api/site)` |
| 判据 | `portal/frontend/src/lib/hostGate.ts`（纯函数、零 vue-router 依赖）：六行矩阵 + **防环** + **fail-open** + 深链保真 |
| 状态 | `stores/site.ts`：**单飞**（并发导航只发一次）、失败 **30s 冷却**（不永久放弃也不每次重打）、**缺字段 ⇒ 不可用** |
| 接线 | `router.ts` 的 `beforeEach` **最前面**（在 `auth.ensureMe()` 之前——「我在哪个 host」与「我是谁」是两件事）；命中 redirect ⇒ `window.location.replace` + **`return false`** |
| 硬链接 | 用户面顶栏/侧栏「管理台」、`AdminLayout` 的「← 返回工作台」改成**跨 host 绝对地址**（`hashUrl(base, path)` 是唯一拼法） |

**四条口径（都能被变异打红，不是措辞）**

1. **fail-open 优先于「跳对」**：`/api/site` 拿不到 ⇒ **不跳**。跳错方向的代价是把用户踢到一个死地址，
   而他连「改回来」都得手打 URL。所以 `parseOrigin` 解析失败/空串一律 `allow`。
2. **防环由判据自己算**：只有 `new URL(target).origin !== new URL(here).origin` 才跳。
   ⚠ **必须用 `new URL().origin` 而不是字符串前缀**：`https://admin.x:443` 与 `https://admin.x` 是同一 origin，
   前缀比较会在「443 与显式端口」这两种合法形态之间判错——那正是重定向环的入口。
3. **`return false` 而不是 `return { path }`**：后者是「在**当前** origin 上继续导航」，而我们刚判定这个 origin 是错的。
4. **允许面与排除列表逐条互补**：deny 优先级 300 > 允许 200 ⇒ 漏一条就是「deny 把允许的吃掉」。
   `routes.test.js` 用**规则求值器**把「管理台入口上 `/api/site` 命中 `admin-auth` 而非 `admin-deny-api`」写成断言，
   不是靠人比对两个字符串。

**一处规格外的自定（worker 提出、我核可）**：`/api/site` 进 `RESTRICTED_SESSION_ALLOWLIST`（#255 受限会话门）。
公开端点拿「欠不欠改密」去挡不自洽，且被挡的后果不是 403 而是**静默降级**（前端把「site 不可用」当 fail-open ⇒
受限会话在错的 host 上照样渲染一片 404）。

**基线（主 agent 亲跑）**：根 **1859 → 1864**（+5：`http.test.js` 4 + `routes.test.js` 1）、runner **473 不变**、
前端 **56 文件 / 1072 → 1106**（+34：`hostGate.spec` 16 + `site.spec` 9 + `router.spec` 3 + 三处硬链接/侧栏 +6）、
`typecheck` rc=0。**主 agent 亲跑 5 条变异全红在具名用例**：去掉防环 ⇒ 6 红；fail-open 改成照跳 ⇒ 1 红；
`isAdminPath` 边界放宽（`/adminx` 也算管理台）⇒ 1 红；`parseSiteInfo` 允许缺 `adminBaseUrl` ⇒ 1 红；
deny 排除列表去掉 `/api/site` ⇒ 4 红。worker 另跑 3 条（工单要求的那三条）。

**仍未做（部署前必须知道）**：真机验收归主 agent（`admin.<伞域>:9443` 尚未在现网 publish，A1 的 edge 重建 + 首张证书
还没做）；`#456` 的证书上传/校验面仍未开工。

### 8.94 v0.1.53 发版与部署：#450 A1+A2 上线（管理台搬到 `admin.<伞域>:9443`）+ 三条只有真机才给得出的事实（2026-11-05）

**载荷**：`#458`（A1 边缘/路由/证书装载面）+ `#459`（A2 host 闸 + `/api/site`）+ `deploy/traefik/dynamic/.gitignore`
（私钥红线，放证书**之前**先上闸）。**本版 `runner/` 只有版本号变动** ⇒ 五台 FDE 容器**故意没重建**（仍在 v0.1.52，
`build-info.json` 实测 `0.1.52 / engine 0.31.0`），`FDE_IMAGE` 仍 pin 到 v0.1.53 摘要（下次新建/重建自然升级）。

**流程**：`e9d2055` → 版本 bump `6226842`（六文件 9 增 9 删）→ main CI `41998175157` 两个 job 全绿 →
tag `v0.1.53` → release `41999559918` success → 三镜像 `docker pull` 后 `image inspect .Id` 与清单 `imageId`
**逐个一致**（portal `0314e233…` / fde `561887ff…` / proxy `2731d8a7…`）→ `deploy/.env` 形态① pin **三项**
（备份 `/tmp/deploy.env.bak-0153`）+ 新增 `TRAEFIK_ADMIN_PORT=9443` / `ADMIN_PUBLIC_HOST=` / `ADMIN_IP_ALLOWLIST=`。

**三条只有真机才给得出的事实（都写进了 `docs/deploy/edge-routing.md` §5，别再自己推一遍）**

1. **`docker compose up -d station-edge` 不会因为静态配置文件内容变了就重建容器**（那份 `traefik.yml` 是 bind mount，
   compose 眼里「配置没变」）⇒ 改静态配置后必须 `docker restart station-edge`（或 `--force-recreate`）。
   本次就是先 `up -d` 看到 9443 根本没 listen 才发现。
2. **私钥属主是硬要求**：`station-edge` 里 root **没有 `CAP_DAC_OVERRIDE`**（compose 收紧了 caps），
   所以 `eric`(1000) 属主的 `0600` 私钥 ⇒ `open …/tls.key: permission denied` + `Error while creating
   certificate store` ⇒ **9443 上 TLS 握手直接失败**（`SSL_ERROR_SYSCALL`，连自签兜底都没有，不是「浏览器告警」那么轻）。
   正解 `chown 0:0 tls.key && chmod 600`（**不是**把私钥 chmod 644）。
3. **只换 `certs/*` 不会触发重载**：chown 修好后握手**仍然**失败，直到 `tls.yml` 被重写一次
   （`cat > tls.yml` 同内容即可）才生效 ⇒ A1 那行 `# fingerprint=… keymtime=…` 注释是**唯一 reload 把手**，
   不是文档装饰。这条同时是「#456 上传面必须主动重写 `tls.yml`」的真机证据。

**真机验收（v0.1.53，dev 栈，主 agent 亲手；请求带 `Host` 直打边缘）**

| 请求 | 用户入口 `station.fde.erix.vip:8090` | 管理台入口 `admin.fde.erix.vip:9443` |
|---|---|---|
| `/` | 200 | 200 |
| `/api/site` | 200（`userBaseUrl=http://station.fde.erix.vip:8090` / `adminBaseUrl=https://admin.fde.erix.vip:9443`） | 200（同值） |
| `/api/admin/users` | **404**（边缘 deny） | 401（到 portal，未登录） |
| `/api/sessions` | 401（到 portal） | **404**（边缘 deny） |
| `/api/internal/x` | — | **404** |
| `/api/health` | 200 | — |

预览 host `eric-p-22004` 未签票 **403**（#241 行为无回归）；`websecure`(8443) 仍全 404（用户面 TLS 是另一单）；
`routes.yml` 里五条管理台 router + 两条 deny + `admin-deny` 中间件都在，`tls.yml` 由 portal 自动生成（带 fingerprint 行）；
portal 日志 8 分钟内零 error/warn。**A2 的 host 闸在真浏览器上成立**：访问 `http://station.fde.erix.vip:8090/#/admin/users`
⇒ 页面**当场换到** `https://admin.fde.erix.vip:9443/…`（落到 Chrome 的 Privacy error，即证书不受信，见下）。

**正式证书已装（2026-11-05，决策者提供 `/docker/cert/fde.erix.vip/`）**：Let's Encrypt `*.fde.erix.vip` + `fde.erix.vip`
（`notAfter 2027-02-03`，`fullchain.pem` 4 层链，`privkey.pem` 与证书公钥配对）。装入 `certs/tls.{crt,key}`
（**fullchain 整份当 crt**，`chown 0:0` + key `600`）+ 重写 `tls.yml` ⇒ `openssl s_client -servername admin.fde.erix.vip`
`Verify return code: 0 (ok)`。⚠ 该证书**同时覆盖 `station.fde.erix.vip`**（`*.fde.erix.vip` 单层），
所以用户面将来上 HTTPS（`websecure`/443）不需要另签一张，但那是**另一单**（今天 `websecure` 仍一条路由都没挂）。

**浏览器级验收（正式证书到位后补做，v0.1.53，`erix_station_playwright` 真机）**：
① 管理台入口 `https://admin.fde.erix.vip:9443/#/login` 正常渲染（**不再有证书告警**），admin 登录 ⇒ 落 `#/admin/users`，
`/api/admin/users`、`/api/admin/llm/providers`、`/api/admin/git-hosts` 全 **200**；
② 「Mail channel」tab（#457 那一片）在新入口上渲染正常（transport=disabled / password=not set / 测试发信按钮禁用并解释原因）；
③ 「← Back to workbench」是**绝对地址** `http://station.fde.erix.vip:8090#/`（`hashUrl()` 的唯一拼法生效）；
④ **A2 两个方向都实测**：管理台 `#/session/<id>` ⇒ 换到用户面（无会话 ⇒ `/login?redirect=/session/<id>`）；
用户面 `#/admin/users` ⇒ 换到管理台并直接落在管理页（管理台会话 cookie 在）；
⑤ **#332 × A2 组合**：无工位管理员在用户面打开 `#/` ⇒ 守卫先改写 `/admin/users` ⇒ host 闸换到管理台 ⇒ 落管理页。

**⚠ 一条探针方法坑**：`curl https://127.0.0.1:9443` 在正式证书下**必然报 `subjectAltName does not match 127.0.0.1`**
（证书只覆盖 `*.fde.erix.vip`）。要打本机端口又走真实证书校验，用
`curl --resolve admin.fde.erix.vip:9443:127.0.0.1 https://admin.fde.erix.vip:9443/…`；`-k` 能绕过但那样就
验不到「证书与 host 匹配」这件事（而它正是本单要保证的）。

**已知遗留**：`ADMIN_IP_ALLOWLIST` **按决策者 2026-11-05 的口径留空**（原话：「这个不需要我们考虑，这个留空就好」）
⇒ 管理台入口对 FDE 容器可达是**已接受的现状**，不是待办；#233 防火墙落地后这条自然消失，别把它当平台欠账再提。
⚠ 现状取证（供将来判断是否要改主意）：在 `fde-eric` 容器里 `curl -H 'Host: admin.fde.erix.vip:9443'
https://100.100.0.3:9443/api/site` ⇒ **200**、`/api/admin/users` ⇒ **401**（= 容器够得到管理台，只剩登录这一层）。
`#456`（证书上传/校验/回滚）**后端切片已开工**（工单 `.work-orders/feat-261105-03-456-tls-api.md`）。

### 8.95 #456 M1：管理台证书生命周期（后端四端点 + 迁移 0027）（2026-11-05）

**要治什么**：管理台入口（#450）的证书今天只能登服务器手工放文件，换证/回滚/「到底装了什么」全靠人记。
本片把**上传 / 覆盖校验 / 真机校验 / 回滚**搬进管理台。**盘上的证书文件是唯一真相**，DB（`tls_certificates`）
只是台账——Traefik 只认文件，DB 再准也换不了线上握手。

| 端点 | 语义 |
|---|---|
| `GET /api/admin/tls` | 盘上证书元数据 + 覆盖判定 + **最近一次真机校验结果（只读缓存，不主动连）** + 有无可回滚备份 |
| `PUT /api/admin/tls` | `{certPem, keyPem, confirmDomains?}` → 校验 → 限流 → 备份 → 写 crt → 写 key → **物化 `tls.yml`** → 台账 → 审计 |
| `POST /api/admin/tls/verify` | 真 TLS 握手比对 `fingerprint256` ⇒ `live` / `mismatch` / `unreachable` |
| `POST /api/admin/tls/rollback` | 从 `certs/prev/` 还原上一代 + 物化 + 台账（`kind='rollback'`） |

**四条落地口径（都能被变异打红）**

1. **校验失败零副作用**：所有判据（PEM 可解析 / 私钥可解析 / 公钥配对 / 未过期 / **覆盖 `adminHost`** /
   `confirmDomains` 不得超出证书能力）都在写盘之前，且**不烧限流配额**（改一张 PEM 常常要试几次）。
2. **`confirmDomains` 的方向是「用户声明 ⊆ 证书能力」**：前端把 SAN 抽出来给可编辑输入，但用户改不出证书里没有的名字；
   缺 `station.<伞域>` 只是提示不阻断（#456 决策第 3 条）。
3. **写盘顺序固定**：备份 → crt → key → `materializeTlsAssets()`。写 key 失败会 **best-effort 把 crt 还原成备份那一版**
   ——否则盘上留下「新 crt + 旧 key」，Traefik 会端出一张浏览器直接拒的证书，比维持旧证书更糟。
4. **verify 连默认网关，不连域名**：portal 容器解析不了 `admin.<伞域>`（实测 `ENOTFOUND`），而证书 SAN 也不含 IP
   ⇒ 连 `/proc/net/route` 里的默认网关 + `servername=adminHost` + `rejectUnauthorized:false`，**只比指纹**。
   网关解析失败 ⇒ `unreachable`（不瞎猜地址）。

**红线复核（机器可查）**：私钥/PEM **不进 DB、不进日志、不进审计、不进响应、不进 `tls.yml` 正文**；
`describeTls()` 逐键白名单（`configured/active/coverage/live/previous`，`active` 六个字段），有专门用例钉「键集恰好是白名单」；
`git ls-files | grep -E '\.(pem|key|crt)$'` 空；`docs/data/schema.sql` 一字节未改（迁移 0027 增量，baseline sha256 冻结）。

**基线（主 agent 亲跑）**：根 **1864 → 1901**（1897 通过 / 0 失败 / 4 跳过，净 **+37** = `tls-cert` 23 + `tls-api` 12 + migrations 1）、
runner 473 与前端 1106 不变、`node --check` 全过。**主 agent 亲跑 6 条变异全红在具名用例**：去覆盖判据 ⇒ 3 红；
key 写 0644 ⇒ 1 红；上传后不物化 `tls.yml` ⇒ 1 红；通配符放宽成多级 ⇒ 2 红；DTO 塞回 `keyPem` ⇒ 1 红；审计塞 PEM ⇒ 1 红。
worker 另跑 4 条（工单要求的那四条）。

**真证书 + 真网络预验（部署前就做了，不等上线）**：把模块挂进 portal 镜像跑在 `station_backend` 网络上 ——
`readActiveCertificate` 解析现网 4 层 fullchain 正常（`subjectCN=fde.erix.vip`、SAN 两项、`notAfter 2027-02-03`）；
`certCoversHost('admin.fde.erix.vip')=true` / `('a.b.fde.erix.vip')=false`（通配符单层）；
`verifyLiveCertificate` 对真边缘 ⇒ **`live`** 且指纹与盘上逐字符相同，错指纹 ⇒ `mismatch`，死端口 ⇒ `unreachable`。

**⚠ 一条只有 root 才看得到的坑**：`certs/tls.key` 是 `0600 root:root`（Traefik 的要求，见 §8.94），所以
**以 `eric` 身份在本机跑 `readActiveCertificate` 会得到 `configured:false, reason:'unreadable'`** ——
这不是 bug（portal 容器内是 root）。做本地验证要用 portal 镜像起容器，别在宿主上直接 node 跑。

**未做（M2 = 前端切片）**：管理台「Certificates」tab（状态卡 / SAN 自动提取成可编辑输入 / 确认后提交 /
verify 按钮 / 回滚按钮 / 过期提醒）。**本片前端零字节**。

### 8.96 安全现状与风险清单落档（2026-11-05，`docs/design/security-posture-2026-11-05.md`）

决策者要求「把现状（含 FDE 独立网段）、风险点、可能的解决方案写成一份文档」。落点是
**`docs/design/security-posture-2026-11-05.md`**（照 `audit-2026-09-16.md` / `toolcall-args-truncation-2026-10-24.md`
的先例：**日期命名的盘点/审计类文档**，不是规格），已登记 `docs/README.md` 文档地图，
并在 `topology.md` 末尾加了一句指针（那条加固清单至今未落地的后果）。

**文档里最值钱的不是结论，是「实测」这两个字**：所有「通/不通」都是在真机容器里打真端口得出的，
附录给了 7 组可复制命令。三个此前只活在对话里的数字：

1. **宿主有 41 个端口绑在 `0.0.0.0`**，**全部**对 FDE 容器可达（抽样七条全 OPEN：1433 MSSQL / 5432 PG /
   9000 Portainer / 19001 v2ray 代理 / 443 nginx / 7681 ttyd / 2222 sshd）。
2. **`19001` 是能直接用的 HTTP 代理**（容器内 `curl -x http://10.200.0.1:19001 https://api.github.com` ⇒ **200**）
   ⇒ 容器拿得到一条出网隧道。这条是 R1 里最容易被忽略的一格。
3. **容器之间、容器→portal/DB/socket-proxy 直连都是被挡住的**（跨 bridge FORWARD 无规则，实测 TIMEOUT），
   而**容器→宿主自身**（INPUT 链）畅通 —— 这解释了为什么「必须能到 Traefik」与「不能到 DB」可以同时成立。

**同时明确的三件「已经是对的」**（免得将来被误当洞去"修"）：FDE 容器**不能**改 Traefik 规则（无挂载/无 socket）；
`internal` API 用 **per-container bearer token**（只能冒充自己）；`deploy/fde-proxy` 对建容器是**字段级 allowlist**
（挡得住「portal 被攻破后起 privileged 容器挂 `/`」）。

**风险编号与方案编号**（后续引用用这些号）：R1 容器→宿主 0.0.0.0（高，`#233`）· R2 管理台 9443 对容器可达（**已接受**）·
R3 portal 被攻破 ⇒ 路由可任意改写（高，后端无白名单）· R4 portal 被攻破 ⇒ **私钥可被读出**（高，读路径 `readFile`）·
R5 规则文件手改无对账（中）· R6 用户面仍明文 HTTP（中）· R7 `#233` 未落地（R1 根因）· R8 internal 无速率限制（低）·
R9 预览端口段对容器可达（低，设计如此）。方案：S1 `#233` · S2 路由后端白名单不变量 · S3 规则漂移对账 ·
S4 私钥读路径改 `stat` + 回滚改 `copyFile` · S5 用户面上 HTTPS · S6 独立发布者进程（暂不建议）。
**建议顺序：S4（半天）→ S2+S3（一天）→ S1（单独设计+演练）→ S5。**

**2026-11-05 追加（决策者口径，已落 §9 / §5 / §4 的 S7）**：
① **数据库可以继续 `0.0.0.0` + 靠 DB 内部权限控制**（理由：「本来也是按数据库账号限制 access 的」）——但前提是
per-FDE 账号 + 库级授权 + 与平台库凭据不同源 + 收紧 `public`；`unix socket 挂载`（不通用，MSSQL 无 socket）与
`per-FDE 独立实例`（资源不够）**两个方案被否**；`DB 协议代理` 记为 **S7 补充方案，后期再考虑**。
② **该口径只覆盖数据库**：`9000`(Portainer) / `2201-2203`(SSH 进容器) / `19001`(实测可用的出网代理) 与 DB 权限无关，仍须关
⇒ **`#233` 收窄成「控制面 + 出网 + 容器 SSH」三类 + DB 按登记表放行**，不再是"一刀切关 41 个"。
③ ⚠ **`#233` 必须同时写 `DOCKER-USER` 与 `INPUT` 两条链**（实测：41 个 `0.0.0.0` 端口里 **27 个是 docker publish**
走 DNAT/FORWARD，**INPUT 规则管不到**；只有 11 个是宿主进程/host 网络容器）。只写 INPUT 会出现「INPUT 侧生效、
27 个一个没挡」的假绿 —— 这是本单最容易做假的地方。

### 8.97 #456 M2：管理台「证书」页（状态卡 / 两步上传 / 真机校验 / 回滚）+ `inspect` 端点（2026-11-05）

M1（§8.95）只给了四个端点，管理台里没有入口。M2 把它变成能用的页面，并补了**唯一允许的后端追加**：
`POST /api/admin/tls/inspect`——**解析但不落盘**。为什么非它不可：决策者定的交互是「粘贴 → 自动抽出证书里的域名 →
域名变成可编辑输入 → 用户确认后才装」，而 `PUT` 会直接写盘、`GET` 只读盘上那张 ⇒ 没有"解析但不装"这一步。

**`inspect` 的语义边界（与 `PUT` 有意不同，别"统一"掉）**：
- `keyMatches:false`（私钥不配对）⇒ **200**，不是 400 —— 把事实交给 UI，由它禁用「确认安装」并说清为什么；
- **不覆盖 `adminHost` / 已过期 ⇒ 不报错**，只进 `coverage.covered:false` 与 `warnings[]`（用户可能就是在传一张还没生效的证书）；
- **零副作用**：不写盘、不写台账、不写审计、不动 `tlsLive`、不烧上传配额（有专门用例用盘上快照 + 写语句扫描钉住）。

**前端（`/admin/tls`，导航 users → llm → repos → mail → **certs** → pool）**
- 状态卡两态（未配置时明说「当前用 Traefik 内建自签证书」）+ 覆盖徽标（`coverage.covered:false` ⇒ 红字 + **禁用安装**）+
  到期三档（`ok` / `soon`(<30 天，黄) / `expired`(红) / `today`，**不出现「0 天」**）。
- 真机校验三态：`live`（绿）/ `mismatch`（红，附两侧指纹）/ `unreachable`（灰，附 `error` 原文）；
  `unknown` 一律写「还没检查过」，**不把「未知」当结论**；**不 live 不锁上传**（连不上不该锁住救命的路）。
- 两步上传：解析 → SAN 预填成可编辑行（`adminHost` 那行高亮）→ 确认安装；成功后**清空两个 textarea**
  （私钥不在页面里多留一秒）；删掉 `adminHost` 行**前端不拦**（服务端是唯一判据），按 400 的 `details.missing` 显示。
- 回滚：确认框（照 #296/#246 先例：**确认前一个请求都不发**）。

**红线复核**：`lib/tlsSettings.ts` 是 DTO 白名单（`keyPem` 这类键进不了 store，有源码级断言）；
两个 textarea 的值只活在组件里（不进 pinia / localStorage / URL / 日志），提交后清空；不新增依赖（解析在服务端）。

**基线（主 agent 在合并树上亲跑）**：根 **1901 → 1905**（+4 inspect 用例）、前端 **56 文件 / 1106 → 59 文件 / 1146**（+40）、
`typecheck` rc=0；runner 与 `docs/data/schema.sql` 零字节。**主 agent 亲跑 7 条变异全红在具名用例**：
安装成功不清空两格 ⇒ 1 红；`coverage` 不参与禁用 ⇒ 1 红；DTO 透传 `keyPem` ⇒ 15 红；到期判定写死 ⇒ 1 红；
inspect 返回 `publicKeyPem` ⇒ 1 红；**inspect handler 顺手写盘 ⇒ 2 红**（零副作用判据有牙）；`adminHost` 行高亮失效 ⇒ 2 红。

⚠ **我自己两次把变异做成空操作**（往 `inspectCertificate` 里加「仅当 `arguments[0].dynamicDir` 存在才写盘」——
而 handler 根本不传 `dynamicDir`；另一次写 `/tmp`，快照判据看不到）。⇒ 又一次印证 §8.24：**红了要证明红来自你以为的那处改动，
没红要先证明变异真的改变了行为**。真变异要落在**调用链上真实存在的那一层**（这里 = `handleAdminTlsInspect`）。

### 8.98 v0.1.54 发版与部署：#456 M2 上线 + 真机把「装证书 → 回滚」跑通（顺带挖出 #462）

**载荷**：`#461`（`#456` M2 证书页 + `POST /api/admin/tls/inspect`）。**本版 `runner/` 非版本文件零改动**
⇒ 按 §8.19 只 pin **portal + proxy** 两个镜像，五台 FDE 容器**故意不重建**（仍在 v0.1.53 摘要）。

**发版与部署**：`880a35f`（PR #461 merge）→ `7eeeabe`（版本 0.1.54，六文件 9 增 9 删）→ main CI `42043703529`
**两个 job 全绿**（先等绿再打 tag）→ tag `v0.1.54` → release `42044827640` success → 清单 `imageId` 与部署机
`docker image inspect .Id` **逐个一致**（portal `ae54f4cd…` / proxy `feb166e6…`；fde `918c1bfc…` 只探到存在、未拉）→
`deploy/.env` 形态① pin 两行（备份 `/tmp/deploy.env.bak-0154`）→ `up -d --no-build station-portal station-docker-proxy`
⇒ portal healthy、经 Traefik `healthz=200`。
⚠ **`up -d station-portal` 会连带重建 `station-docker-proxy`**（compose 依赖），所以 proxy 的 `IMAGE_ALLOWLIST`
必须同步 pin 新 digest（§8.70 那个「只改一边 ⇒ `create_policy_denied`」的同型坑）。

**真机验收（v0.1.54，dev 栈，主 agent 亲手；`erix_station_playwright` 直连 `https://admin.fde.erix.vip:9443/`，
正式证书已装 ⇒ **无证书告警**）**

| 面 | 结果 |
|---|---|
| 导航 | `User management / LLM management / Repository management / Mail channel / **Certificates** / Pool usage`（证书页在 mail 与 pool 之间，符合设计） |
| 状态卡 | `configured` + 「Covers the admin host admin.fde.erix.vip」+ Subject `fde.erix.vip` / Issuer `YE1` / 有效期到 `2/3/2027` / SAN 两条 / 指纹 `63:AA:DC:8E…`（**无脏值**） |
| 真机校验 | 点按钮 ⇒ **绿**「The live handshake serves exactly this certificate (fingerprints match)」+ 时刻戳 |
| 两步上传 | 只给证书 ⇒ 解析出 `*.fde.erix.vip`、`fde.erix.vip` 两行可编辑域名 + 「No private key provided…」+ 安装按钮**禁用** + 提示「A private key is required to install」；补上私钥再解析 ⇒ 「The private key matches the certificate」+ 按钮**启用** |
| 安装 | 200 ⇒ 「Installed…」；**两个 textarea 与域名草稿当场清空**（`certLen=0 / keyLen=0 / domainRows=0`，inspect 结果块也收起）；`certs/prev/{tls.crt,tls.key,meta.json}` 生成（meta 只有指纹/主题/到期/时刻，**无 PEM**）；`tls_certificates` 落一行 `upload`；审计 `admin.tls_updated` 的 `details` **只有指纹与 SAN，无 PEM** |
| 回滚 | 先点「Rollback」⇒ 出确认框（**确认前 `admin.tls_rolled_back` 计数 = 0**）；确认后 200 ⇒ 「Rolled back」、`certs/tls.crt` 恢复成 **4832 B 全链、`sha256 9686693a…` 与上传前逐字节相同**、`openssl` **`Verify return code: 0`**（4 层链齐全）、台账 +1 `rollback` 行、审计 `admin.tls_rolled_back` |

**顺手挖出一个真缺口 → [#462](https://github.com/ErixWong/erix-station/issues/462)（已开单，本版不修）**：
我这次故意只粘了 **leaf** 去做上传验收，装完发现 `certs/tls.crt` 从 4832 B 变成 1306 B ⇒
`openssl s_client` 直接 **`Verify return code: 21 (unable to verify the first certificate)`**（客户端链校验失败），
而页面上的「真机校验」**照样报 live ✓** —— 因为它只比 `fingerprint256`（leaf 指纹，装 leaf-only 前后完全相同）。
⇒ 对「唯一入口」来说这是**一次上传就把自己锁在门外**的形状。两条修法（`validateUpload` 加 `chain_looks_leaf_only`
警告 / `verifyLiveCertificate` 比 `issuerCertificate` 是否存在）已写进 issue，**警告不拒**（确有只发 leaf 也够用的部署）。
现网已**回滚复原**（`sha256` 与上传前逐字节相同、`Verify return code: 0`），台账里那两行是回滚功能的正常产物、不是残渣。

**过程账**：这次验收是**真上传真回滚**（不是只点按钮看提示），代价是 `certs/` 被改写了两次——所以每一步都先取
`sha256` / 计数基线，回滚后**逐字节比对**确认复原。**「验收后能复原」本身就该是验收的一部分**（先例 §8.94 那条
「验完还原 `.env` 并 `up -d`」）。

### 8.99 #451 的独立评审（erix_run）：1 blocker + 3 major —— 其中一条是「本单最强调的不变量无锁」（2026-11-05）

派工方式：`erix_run`（`cwd` = 主工作区，只读、禁改仓库、报告写固定路径），`maxRounds=100` / `timeoutMs=3600000` /
`sessionDir` 必给。终局 `judge_done`、54 轮、↑2.96M / ↓54k。报告 264 行（已归档 `~/worker-reports-261105/review-451-erix-run.md`）。

**结论：1 blocker + 3 major + 6 minor。核心逻辑与八条硬口径在常见路径上确实做到了（两套测试 20/20、14/14 全绿、
`node --check` 全 0），但下列四条是真的。**

- **blocker：16 KiB 上限在「整文件读进内存并转成 JS 字符串」之后才生效**（`runner/lib/agents-md.js:223` `readFileSync`
  无长度限制 → `:230` `buf.toString('utf8')` 在 read 的 try **之外** → `:241` 才判 `buf.length > maxFileBytes`）。
  主 agent 独立复现（`/tmp` 稀疏文件）：600 MiB ⇒ **抛 `ERR_STRING_TOO_LONG`**、RSS 647 MB、563 ms，
  而 `:198` 的 `stat.size` 从头到尾没用过。破「绝不抛」（硬口径 6）的后果被放大：`worker.js:424-434` 的兜底把
  **整段置空** ⇒ 连 9 KB 平台节都不注入。修法：先按 `stat.size` 判，超限只 `readSync` 前 16 KiB；顺带把解码挪进 try。
- **major：设计稿 §4.1 规则 6 承诺「解码失败 ⇒ 跳过 + note」是死光纤**——`buf.toString('utf8')` 是 lossy 解码、
  **永不失败**（`grep -n 'TextDecoder\|fatal'` 零命中）⇒ 二进制/GBK 的 `AGENTS.md` 被当正文注入（含 U+FFFD 与 `\u0000`），
  且 `notes=[]` 让日志看起来完全正常。修法：`new TextDecoder('utf-8',{fatal:true})` 包 try。
- **major：`blocks=[]` 时 `subdirHints` 与 `notes` 一起被丢**（`agents-md.js:332` 提前返回不看它们）。实测：
  项目根无 `AGENTS.md` + 5 个子仓库各有一份（**正是规则 7 的动机形态**）⇒ 渲染 0 字节、索引一条不出现。
  口径 7 与口径 8 是**真冲突**，实现按 8 裁了，但 `§8.91` 与 `user-space.md:184` 都写成「7 条全部落地」，没有任何地方记这个取舍。
- **major：接线锁①/③ 只比文本位置，钉不住「采集必须在 `startRun` 内」**。主 agent 独立复现（`/tmp` 副本，先跑未变异
  对照）：把采集整段（含 try/catch）移到**模块顶层**、`startRun` 里只留 `if (agentsMdOk) { sendIpc … }`
  ⇒ `agents-md.test.js` **20/20 全绿**、`system-prompt.test.js` 与对照**逐字相同**（12/14，红的 2 条是副本环境读
  `portal/**` 的相对路径噪声，真仓库 14/14）。这正是 §8.64 `steerArmed` 的同型老账，而它是本单注释里最强调的那条。

6 条 minor 里两条值得单独记：**`realpath` → `readFileSync` 的 TOCTOU**（检查后换 symlink 指向，实测越界内容可注入，
用例文案「一个字节都不许注入」比实现强）；**去重 sha 用的是原始字节** ⇒ BOM/CRLF 差异让去重失效、同一段规则注入两遍且 `notes=0`。

**⚠ 派工产物落点的教训（本次真实踩到，零例外）**：报告让 `erix_run` 写进 `<仓库>/.review-451/report.md`（未跟踪），
而**同一个主工作区还有另一个会话在干活** ⇒ 它提交文档时 `git add -A` 把这份 27 KB 报告一起扫进了 `6078e30`
并推到 origin/main。已用 `5336b83` 删除（历史不改写：强推 main 会踩并行会话）。
⇒ **口径：派工产物一律不落共享主工作区的仓库内**——写 `/tmp`、写 worktree、或写 `~/worker-reports-<日期>/`。
这条与「多个 worker 禁止共享同一 git 工作目录」同族，但更隐蔽：**受害的不是我的执行体，而是别人提交时的一个 `-A`**。

### 8.100 #462 证书链完整性：`new X509Certificate(多段PEM)` 只取第一段，而 Traefik 对「中间在前」直接拒加载（2026-11-05）

**病根（一行）**：`parseCertificatePem` 用 `new X509Certificate(整份 PEM)`，而 Node **只解析第一段** ⇒
「中间在前、叶子在后」的 bundle 会把**中间证书**当叶子 ⇒ 私钥配对判 false ⇒ 报 `tls_key_mismatch`
（**用户的私钥是对的**，这个提示是误导）。更糟的是这种形态 **Traefik 直接拒加载**，整条 `tls.certificates`
项失效、退回内置自签 ⇒ 管理台变成浏览器硬告警。

**载荷 / 实测四形态（2026-11-05 真机 Traefik v3.7.13 + file provider + `tls.certificates`，一次性 root→int→leaf PKI）**：

| 提交的 PEM 形态 | 段数 | Traefik 加载 | 服务端实际发出链层数 | 客户端严格校验（`-CAfile root`） |
|---|---|---|---|---|
| `leaf-only` | 1 | ok | **1** | **21 unable to verify the first certificate** |
| `fullchain`（叶子+中间） | 2 | ok | **2** | **0 ok** ✅ |
| `with-root`（叶子+中间+根） | 3 | ok | **3** | **0 ok** ✅（多发一张根，无害） |
| `wrong-order`（中间在前） | 2 | ❌ `Unable to parse certificate … tls: private key does not match public key` | 1（退回内置自签） | 18 self-signed certificate |

Node 侧同批实测：`getPeerCertificate(true)` 在 `rejectUnauthorized:false` 下**仍给** `issuerCertificate`
（leaf-only ⇒ 无 / fullchain ⇒ 有）；`checkIssued`：`leaf→int` true、`int→root` true、**`leaf→root` false**（隔代）、
`root→root` true（自签）。这四条是本单全部判据的机器基础。

**判定表（C1–C7，`portal/test/tls-cert.test.js` 逐条钉住）**：

| # | 输入 | `inspect` | `PUT` |
|---|---|---|---|
| C1 | 叶子+中间（正确顺序） | 200 无 warning，`cert`=叶子 | 200 落盘（**原样字节**） |
| C2 | 叶子+中间+根 | 200 无 warning | 200 |
| C3 | 只有叶子、非自签 | 200 + `chain_looks_leaf_only` | **200**（警告不拒）+ 审计 `details.chainWarnings` |
| C4 | 只有叶子、自签 | 200 无 warning | 200 |
| C5 | 顺序反了（有私钥） | **400 `tls_cert_order_invalid`** | 400 同码 |
| C6 | 顺序反了（无私钥） | 200 + `chain_order_suspect` | 400 `tls_cert_order_invalid`（PUT 必带私钥） |
| C7 | 段间接不上 | 200 + `chain_broken` | **400 `tls_cert_chain_broken`** |

**为什么 C3 是 200 而 C7 是 400**：C3 的输入是「我知道我只有叶子」（可接受的自担风险，确有只发 leaf 也够用的内部部署）；
C7 的输入是「我以为我给了链，其实接不上」——发出去客户端一定链校验失败，而用户没有别的信号。

**落点**：`tls-cert.js` 新增 `parseCertificateChain` / `selectLeaf` / `describeChain`（`parseCertificatePem` **保持**
「解析单张」的语义，被 `describeTls`/`readActiveCertificate` 共用，链判据不许塞进去）；`validateUpload` 的判据顺序
变成 `解析链 → 选叶子 → **顺序(C5)** → 配对失败/链完整(C7) → 未过期 → 覆盖 → confirmDomains`（**C5 必须早于配对报**，
否则又变成 `tls_key_mismatch`）；`cert` DTO 一律取叶子；落盘字节 = 用户提交的原样 PEM；审计 `details.chainWarnings`
只在非空时写（**零 DDL**）。M2：`peerChainDepth()`（`getPeerCertificate(true)` + 最多 6 层防环 + 自签只算 1 层）⇒
指纹一致但链深 <2 且非自签 ⇒ `mismatch` + `reason:'chain_incomplete'`。M3 = 安全文档 S4：`readTlsAssets` 对私钥
**只 `stat`**、回滚改 `copyFile` ⇒ portal 读路径永不接触私钥字节。

**基线（本机实测，判绿 = 退出码 0）**：根 **1905 → 1932**（1901 → 1928 通过 / 0 失败 / 4 跳过；+27 =
`tls-cert.test.js` 23→38（+15：C1–C7 逐条 + `selectLeaf` + `describeChain` + `parseCertificateChain` + inspect 的
C1/C3/C6/C7 + inspect C5 的 400 + M2 链深 + S4 回滚 + 伪链）/ `tls-api.test.js` 16→26（+10：inspect C1/C3/C5/C6/C7、
PUT C5/C7、原样落盘 + 台账取叶子、审计 `chainWarnings`、verify DTO 透出）/ `tls-assets.test.js` 8→10（+2：S4 两条））；
runner **473 不变**；
前端 **59 文件 / 1146 → 1149 通过**（**+3**：链告警三条文案 / `chain_incomplete` 带链深 / `fingerprint_mismatch` 与无 reason 的旧措辞；
**主 agent 空载连跑两次都是 59 文件 / 1149 全绿 rc=0**）。
⚠ **worker 报的「3 条 `GitLightBadge.spec.ts` 预存失败」不成立**（它连基线 worktree 也报了 3 红，并据此把
`ci-release.md` 记成「1146 通过 + 3 预存失败」）——这是同一形状的**第 6 次**：worker 跑前端全量时会红那 3 条，
主 agent 空载复跑恒绿（单跑该文件 18/18、全量 1149/1149 ×2）。⇒ **worker 报的基线数字必须自己复算，不许照抄进台账**
（§8.63 / §8.82 / §8.88 同族）。

**变异（主 agent 亲跑，每条先 `git diff --numstat` 自证非空操作，跑完 `git checkout --` 复原）**：

| # | 变异 | 红格 |
|---|---|---|
| 1 | 删掉 C5 顺序判据 | `#462 C5`、`#462API⑥`（且实际码变成 `tls_cert_chain_broken`——**不是**工单预言的 `tls_key_mismatch`） |
| 2 | C3 改成 400 | `#462 C3`、`#462API⑨`、`#462API⑩`（后者是 PUT leaf-only 前置被拒的连带） |
| 3 | `selectLeaf` 退回「只看第一段」（= 旧行为） | `#462 selectLeaf`、`#462 C5`、`#462 inspect C5 400`、`#462API③`、`#462API⑥`；实际码退回 `tls_key_mismatch` |
| 4 | `verifyLiveCertificate` 去掉链深判据 | `#462 verifyLiveCertificate…chain_incomplete`、`#462API⑩` |
| 5 | `readTlsAssets` 改回 `readFile` 私钥 | S4 两条（注入 EACCES / 真 chmod 000） |
| 6 | 链间判据换成 `subjectCN === issuerCN` 字符串比 | **8 条**：`#462 describeChain`、`#462 C1`、`#462 C2`、`#462 C7 伪链`、`#462API①`、`#462API⑥`、`#462API⑧`、`#462 inspect C1/C3/C6/C7` |
| 7 | （工单 §7 #3 的字面形态）`cert` DTO 改回 `blocks[0]` | **全绿 = 空操作**：成功路径上 `leaf === blocks[0]`（C5 在构造 DTO **之前**就 400 了）⇒ 该变异在本实现里观察不到差异。用 #3 代替它取证 |
| 8 | 删掉 `chainWarnings` 的 push（C3 不再提示） | `#462 C3`、`#462API⑨` |
| 9 | `peerChainDepth` 恒 `+1`（差一） | `#462 peerChainDepth`、`#462 verifyLiveCertificate…chain_incomplete`、`#462API⑩` |
| 10 | `rollbackCertificateAssets` 不用 `copyFile` | `#462/S4 rollback：copyFile 语义`、`#456 rollback` 两条 |
| 11 | 审计无条件写 `chainWarnings`（空数组也写） | `#462API⑧`（「无 `chainWarnings` 键」那条）、`#456API②` |
| 12 | `statAsset` 去掉 `size > 0` | `#450 tls.yml：空文件视为缺失` |
| 13 | inspect 的 C6 去掉 `!keyGiven` 守卫 | **全绿 = 冗余守卫**（有钥时 C5 已先抛 400，走不到那行）——**不是覆盖缺口**，代码里留着是给读者看边界 |

**变异 6 顺带挖出一个真覆盖缺口并已补**：字符串比在**两个方向**都有害——它会让合法链判成断链（被 C1/C2 抓到），
也会让「同名不同钥」的伪链**看起来接得上**（原先没有用例）。补的用例造一条伪中间证书（CN 与真中间证书相同、
签发者 CN 故意写成叶子的 subject CN）⇒ `blocks[0].subjectCN === blocks[1].issuerCN` 成立而 `checkIssued` false，
**字符串比 ⇒ 红、`checkIssued` ⇒ 绿**，这才是「`checkIssued` 有牙」的证据。

**已知边界**：① `parseCertificatePem` 仍是「第一段」语义（`describeTls` / `readActiveCertificate` 用它，盘上有效证书
第一段就是叶子；C5 已在写盘前拦住，盘上不会出现顺序反的 bundle）；② `chain_order_suspect` 只是**启发式**
（只比 CN，且只在没给私钥时出现）——`PUT` 一定有私钥，走的是 C5 的硬判据；③ `chain_incomplete` 的判定依赖
服务端「只发 1 张」这个事实，若某个前置代理补链，verify 看到的是补链后的结果（这本来就是我们要的事实）；
④ S4 砍掉的是**日常读写路径上的无意暴露面**，不是「portal 被攻破后主动 `readFile` 的能力」（那要动权限模型，见安全文档 R4 残余）。

### 8.101 v0.1.55 发版与部署：#462 证书链 + S4 上线，真机六条全过（2026-11-05 深夜）

**载荷**：`#463`（#462 链完整性 + 安全文档 S4）。**`runner/` 非版本文件零改动** ⇒ 只 pin portal + proxy，五台 FDE 不重建。

**发版与部署**：`30d24e2`（PR #463 merge）→ `dd7c6b9`（版本 0.1.55）→ main CI `42063254168` 两个 job 全绿（先等绿再打 tag）
→ tag `v0.1.55` → release `42064531259` success → portal/proxy `docker pull` 后 `image inspect .Id` **逐个一致**
（portal `83d0973a…` / proxy `ee908a10…`；fde `a26f9f09…` 未拉）→ `.env` pin 两行（备份 `/tmp/deploy.env.bak-0155`）
→ `up -d --no-build station-portal station-docker-proxy` ⇒ portal healthy、`healthz=200`、`openssl Verify return code: 0`。

**真机验收（v0.1.55，dev 栈，主 agent 亲手；API 面用 admin 会话 + `Host`/`Origin` 都带 `:9443`，UI 面用 playwright）**

| # | 动作 | 结果 |
|---|---|---|
| A1 | PUT **真 4 段 fullchain（bundle）** | **200**、审计**无 `chainWarnings` 键**、落盘 `sha256 9686693a…` **与提交逐字节相同**、服务端 4 层、`Verify return code: 0` |
| A2 | inspect **leaf-only** | 200、`keyMatches:true`、`coverage.covered:true`、`warnings:['chain_looks_leaf_only']`（UI 上文案可见） |
| A2 | PUT leaf-only | **200（警告不拒）**、审计 `details.chainWarnings=["chain_looks_leaf_only"]`、服务端变 **1 层**、严格校验 **21** |
| A2 | **verify（#462 的核心）** | **`mismatch` + `reason:'chain_incomplete'` + `chainDepth:1`**（修复前这里报 `live ✓`）；UI 文案逐字：「live fingerprint matches this certificate, but the server sent only 1 certificate (chain depth 1)…」 |
| A2b | rollback | 200、`sha256` 回到 `9686693a…` **逐字节相同**、4 层、`Verify return code: 0`、verify 回 `live`（`chainDepth 5`） |
| A3 | PUT **wrong-order（中间证书在前）** | **400 `tls_cert_order_invalid`**、`retryable:false`、`details={firstSubjectCN:'YE1', leafSubjectCN:'fde.erix.vip'}`、文案点名「现在第一个是「YE1」（中间证书）」；**盘上一个字节没动** |
| A4 | inspect wrong-order **带钥** | **400 同码**（有配对证据 ⇒ 直接拒，不给可疑警告） |
| A5 | inspect wrong-order **不带钥** | 200 + `chain_order_suspect`（另带 `no_sans`/`admin_host_not_covered`，因为此时 `cert` 只能取第一段=中间证书，是**如实**的） |
| A6 | PUT **断链**（叶子 + 跳过中间证书的 Root YE） | **400 `tls_cert_chain_broken`**、`details={index:1, subjectCN:'fde.erix.vip', issuerCN:'YE1', nextSubjectCN:'Root YE'}` |
| A7 | inspect 断链 | 200 + `chain_broken`（`keyMatches:true`） |

**「bundle 带根」的真机数据（回答决策者 2026-11-05 的提问）**：现网那张就是 **4 段**（leaf + YE1 + Root YE + ISRG Root X2）
⇒ 加载正常、4 层、严格校验 0；一次性测试 PKI 上另测了 leaf+int（2 层，严格校验 0）与 leaf+int+root（3 层，0）⇒
**bundle 无论带不带根都不警告**。⚠ 但真机上 **leaf+YE1（2 层）在本机系统 CA 下验不过（error 20）** ——
因为这张证书的链要经 Root YE 才接到受信根，所以「链长够不够」不能靠段数判，判据只能是 `checkIssued` 逐对成立
（我们的实现正是如此），**再加真机校验的链深**兜底。

**收尾**：探针用的临时私钥 `/tmp/key-real.pem`、cookie jar、各 body/响应文件**全部删除**；`certs/tls.crt` 终态
`sha256 9686693a…`（与部署前逐字节相同）、4 层、`Verify return code: 0`、verify `live`。台账里新增的是
A1/A2/A2b 三条 `upload`/`rollback` 行（正常产物，非残渣）。

**⚠ 版本号已被并行会话推进到 `0.1.56`**：我做本单时另一个会话合并了 PR #464（#451 评审返修，改的是 `runner/lib/agents-md.js`
⇒ 属 **FDE 镜像**侧）并 bump 了 `0.1.56`，但**尚未打 tag / 未发版**（`git tag` 最新仍是 `v0.1.55`）。我的 `#463`（`30d24e2`）
是 `0.1.56` 的祖先 ⇒ **下一次发版会同时带上这两批**；现网 portal 停在 v0.1.55 摘要（含 #462 + S4，不含 #451 的 runner 改动——
那本来就要等 FDE 镜像重建才生效）。⇒ **发版前先 `git log --oneline -5` 看一眼 main 是不是被别的会话推过**，
别按自己上次看到的版本号打 tag。

**⚠ worker 环境性红第 6 次**：worker 报「3 条 `GitLightBadge.spec.ts` 预存失败（基线 83447df 上同样 3 红）」并据此改了
`ci-release.md` 与 AGENTS —— **不成立**：主 agent 空载连跑两次都是 **59 文件 / 1149 全绿 rc=0**（单跑该文件 18/18），
CI 也绿。两处已更正，并把「worker 报的基线数字必须自己复算」写进 §8.100。

### 8.102 v0.1.56：#451 评审返修上线（blocker 上限前置 / 解码死光纤 / 接线锁函数体定界）（2026-11-06 凌晨）

**载荷**：PR #464（`c71c8bd`）= §8.99 那 9 条 finding 的修复。本版**动 `runner/` 实质代码** ⇒ 五台 FDE 必须重建（§8.17）。

**修法要点（每条都有主 agent 亲跑的变异）**

- **B1 blocker**：新增 `readPrefix()`（定长 `maxFileBytes+4` 的 `Buffer.alloc` + `openSync`/`readSync`/`closeSync` 放 finally）
  与 `canPrefixRead()`；**先按 `stat.size` 判**（`stat.size` 为 0 或不可信时仍走 `readFileSync`，防御不丢），超限只读前缀；
  Buffer 归一与解码**挪进同一层 try**。
- **M1**：`decodeUtf8Strict()` = `TextDecoder('utf-8',{fatal:true, ignoreBOM:true})`，失败 ⇒ 跳过 + note（带前 16 字节 hex）。
  配套 `trimIncompleteUtf8Tail()`：前缀读切在字符中间是**读法**造成的不完整，先剔再解码——否则 M1 会把合法中文误判。
  ⚠ **`ignoreBOM: true` 是 worker 自己发现的回归**：`TextDecoder` 默认**吞前导 BOM**，与「展示 = 原文」冲突。
- **M2**：产品行为**不变**（无文件时注入段仍是空串）；三处文档补口径 + `worker.js` info 记账带**前 2 条 note 摘要**（`MSG.LOG`，零新事件类型）。
- **M3**：两条接线锁改成**先取 `startRun` 函数体边界**（`\n}` 定界，不用括号计数——有模板字符串）再断言三点落在体内，
  加语义锁「采集必须在 `const { task, cwd } = msg;` 之后」。
- **m1/m2/m3/m4/m5**：锁③ 补 `try < render < catch`；TOCTOU 口径写准；16 KiB 与 marker 的量纲写进注释；
  去重键改 `dedupeKey()`（去 BOM + CRLF→LF + trim，**展示仍用原文**）；三处文档对齐（S4 状态 / 28 格 / §4.2 拼接式）。

**基线**：根 **1905/1901/0/4 → 1936/1932/0/4**（含 main 前进的 #462 测试）、runner **473 → 481**、`node --check` 全过。
`git diff` 只碰 7 个文件（`agents-md.js` +145 / `agents-md.test.js` +206 / `system-prompt.test.js` +41 / `worker.js` +9 / 3 篇文档），
**零依赖、零 lockfile、零 DDL**。

**主 agent 亲跑 4 条变异（不复用 worker 的 8 条，每条先 `git diff --numstat` 自证非空操作）**：
采集整段移到模块顶层 ⇒ **锁③ 恰 1 红 + 锁① 恰 1 红**（**修复前是 34 条零红**，这就是这条 finding 的全部意义）；
B1 去掉 `stat.size` 预判 ⇒ 恰 1 红（「`readFileSync` 对该路径一次都没调」）；M1 改回 `toString('utf8')` ⇒ 恰 1 红；
m1 渲染移出 try ⇒ 恰 1 红（`system-prompt` 仍 14/14）。

**blocker 实质修复实测（600 MiB 稀疏文件）**：

| | 修复前 | 修复后 |
|---|---|---|
| 耗时 | 563 ms | **3 ms** |
| RSS | 647 MB | **46 MB** |
| 结果 | 抛 `ERR_STRING_TOO_LONG`，**平台节一起丢** | 不抛，`blocks=2`，平台节在，`truncated=true`，`bytes=16483` |

**发版与部署（v0.1.56）**：`1070342`（六文件 9 增 9 删）→ main CI 绿（中间另一个 session 又推了 2 个纯文档提交，
`f5b3cce` 那条还主动记了「并行会话把版本推到 0.1.56，下次发版会同时带上 #463 与 #464」——**它没抢版本号**）→
tag `v0.1.56`（打在 `f5b3cce`，version 匹配）→ release `42067503370` success → 三镜像 `docker image inspect .Id`
与清单**逐个一致**（portal `9158c3a2…` / fde `99bea2d2…` / proxy `86a0e30a…`）→ `deploy/.env` 三项 pin
（备份 `/tmp/deploy.env.bak-0156`）→ `up -d --no-build station-portal`（连带重建 `station-docker-proxy`，
`IMAGE_ALLOWLIST` 同步含新 fde digest）→ portal 实跑 `9158c3a2…`、经 Traefik `healthz=200` →
**`docker rm -f` 五台 `fde-*`（双过滤 `label=station.stack=default` + `name=fde-`，对照确认排除了 `fde-workshop-db`）
→ reconcile 20 秒内全部重建在 `99bea2d2…`**，容器内 `station 0.1.56 / engine 0.31.0`、`lib/agents-md.js` 含新代码（9 处命中）、
agentd `sse connected` + `sse ping received`。

**真机验收（发布物，非热 patch）**

1. 端到端 run `db6f0f88…` ⇒ `finished / judge_done`，日志 `agents-md injected: files=1 bytes=9018 truncated=0 subdir_hints=0 notes=0`。
2. **M2 的可观测性修复真机验到**：在 `probe-451fix` 里造 `AGENTS.md -> /etc/passwd` 的 symlink ⇒ 下一个 run
   `run 935c4947…` 的日志变成
   `notes=1(跳过 ~/projects/probe-451fix/AGENTS.md：真实路径 /etc/passwd 越出 /home/erix)`，且 `files=1`（内容**没被注入**）。
   **修复前这里只有一个 `notes=1`**，看不出为什么。验完 symlink 已删。
3. dev 残渣（故意留）：会话 `1d13ff13…`（两条探针消息，标题「用一句话回答：pong」）。

**⚠ 本轮两条自己的操作教训**

1. **`docker pull` 被 `timeout 60` 截断时 rc 仍是 0**（管道掩盖了 SIGTERM）⇒ 我据此以为 fde 拉完了，实际镜像不在本地，
   `docker image inspect` 才露馅。**口径：pull 之后必须 `docker image inspect <ref> --format '{{.Id}}'` 对一次 imageId，
   别信 pull 的退出码与「Download complete」。**
2. **派工前没查「这个 issue 是不是已经有人在做」**：我在 23:56 给 #462 派了一张工单，而另一个 session 那时已经修完并发了
   v0.1.55（它的 `#463` 比我的工单更完整：按整条链判 + 两个新错误码 + 私钥只 stat）。我的 run 跑了 121 轮 / ↑10.4M tokens
   **全部白烧**（分支已丢弃，报告归档 `~/worker-reports-261105/462-duplicate-report.md`）。
   ⇒ **口径：派工前 `gh issue view <n> --comments` 看有没有人正在做 + `git fetch` 看 main 最近提交；
   issue 是我自己开的也不等于它还空着。** 这条与 §8.99 的「派工产物落点」同族：并行的不只是工作树，还有 issue 本身。

### 8.103 delegation（子 run）接入 P1+P2+P3：宿主嵌套 `runToolLoop` / 门户只读两端点 / 卡片+抽屉（2026-11-09 凌晨，分支 `feat-261108-0{1,2,3,4}-delegate-*`）

**决策前提**：三份独立评估（erix_run `judge_done` 96 轮 / pi worker / copilot 两次都因派单方材料缺口停）交叉对账后，主 agent 裁定**接最小片**（初版默认关）。
理由不是「在册理由过期」，而是「不接已是用户可见的错觉」（用户会问「station 有没有开 subagent」，本身就说明界面看不出它没有）；
但对外**只声称「上下文隔离 + 读密集并行」**，不承诺写并行（D8 之后子共用父 cwd 会互踩）。

**子 run 不是本站真 run**（两条 DDL 硬约束）：`runs.session_id NOT NULL`（`schema.sql:205`）+ `runs_one_active_per_session`（`:222-223`）
⇒ 父在跑时同会话塞不进第二个活跃 run。所以子 = **同进程嵌套的第二个 `runToolLoop`**（引擎 `bin/delegation.js:20-24` 的 v1 形态）。

**落盘布局（门户与 runner 同源，唯一真相）**：`<home>/delegation/{roster/<parentRunId>, leases, transcripts}`。
roster 按父 run 分片（模型的 `list` 只看见自己的子）· leases 每 FDE 共享（`link(2)` ⇒ 跨进程真配额）· transcripts 扁平按子 runId。
**不放在 `runs/<runId>/` 下**：`cleanupRunData` 会连名册一起删，而 UI 要回看。

**三处只有真机才会炸的坑（都已在代码注释里）**
1. **`termination` 只认字符串**（`tool.js:94-98`，对象 ⇒ 一律 `failed`）⇒ 本站判「正常收尾」的 `no_tool` / `continuation_exhausted` 必须**交给库之前**归一成 `end_turn`（原始 reason 只进日志，因为 `finishRun` 只搬白名单键）。
2. **前台子的 `cancel` 恒 `not_owned`**（`owned` 只在后台分支登记，`tool.js:455`/`:547`），库自己的 `AbortController` 不接外层 ⇒ **中止只能靠宿主把父 signal 串进子的 `runToolLoop`**。erix 的评估在这里给错了方案（建议 `action=cancel` 级联），真机会静默失效。
3. **子跑超过 300s watchdog 会把父 SIGKILL**（`agentd.js:68`）⇒ 子执行期必须发 `SHELL_LIVENESS.heartbeat`（复用既有通道，agentd 零改动，15s 节流）。

**其它落点**：`deadlineMs` 是**时长**而引擎 `config.timing.deadlineMs` 是**绝对时刻**（换算只在 `delegation.js` 一处）·
子工具面**显式构造**（文件工具 + shell，**不含** `delegate`/`note_*`/skills——notes 的 single-writer 不变量靠 `runs_one_active_per_session`，同进程两个 loop 它管不到）·
子的 usage **并进父** `RUN_FINISHED.usage`（`usage_ledger_run_source_key UNIQUE (run_id, source)` + `ON CONFLICT DO NOTHING` ⇒ 另发一行会被静默吞掉）·
名册目录由 **agentd 预建 + `runAsWorker` 改属主**（1001 建的 755 目录 1002 写不进）· env 三腿（compose → provisioner → `fde-proxy` 的 `ENV_KEY_ALLOW`，§8.70 同型坑）。

**门户读侧（P2）**：`GET /api/sessions/:id/delegates?runId=` 与 `.../delegates/:childRunId?runId=&tail=`，只读、零 DDL、零新错误码。
窄路径解析器（两个 id 正则锁死 + `path.resolve` + 前缀断言；**不复用** `dirs.js#resolveJailedFile`——它的 jail 根是 `projects/<name>`）。
投影顺序固定 **`foldLedgerRecords`（本站超集镜像）→ `projectTranscriptForDisplay` → 才 `slice(-tail)`**；
⚠ `foldLedgerMessages` / `foldMessageRows` **不在 `erix-agent` 导出面**（实测 `undefined`，深引被 `exports` 挡）。

**前端（P3）**：照 pi-web 形态（`SubagentViewer.tsx` / `AgentSessionPanel.tsx:129-165` / `MessageView.tsx:1282-1295`）——
工具卡右侧 32px 图标按钮 → 只读抽屉；抽屉**轮询 2s、单飞、可见性门控、终态即停**（`completed` 打开只拉一次，真机 18s 内 0 请求）。
station 用**抽屉**而不是右栏 tab（无 tab 架构）。

**真机验收（v0.1.57 前的集成镜像，主 agent 亲手）**
- 派两个读密集子任务 ⇒ 名册 2 条 `completed`/`end_turn`、账本 24.7 KB / 30.0 KB、**`parentRunId` = 真 runId**（不是 sessionId）。
- **usage 不双记**：`usage_ledger` 恰好 1 行、`run_id` = 父。
- **中止级联**：父 stop ⇒ 子 `state=aborted`。
- **看门狗**：子跑 **364 秒**（>300s）⇒ 父 `finished/judge_done`、`attempt_killed` **0 条**、agentd 无 kill 日志。
- **UI**：卡片按钮 → 抽屉（`✓ Completed / Sub-task 62979dda` + 子 run 任务原文 / reasoning / 6 条工具调用 / 终稿）；刷新后按钮仍在。

**变异验证（主 agent 亲跑，每条先证非空操作、跑完还原）**
P1：不覆盖 `parentRunId` ⇒ D1 红 · `termination` 透传对象 ⇒ D2+D3×2 红 · `deadlineMs` 不换算 ⇒ D9 红 · 不串父 signal ⇒ D5 红 · 子工具面塞回 `note_*` ⇒ D8 红。
P2：摘 `fetchSession` ⇒ B1 红 · 投影前不折叠 ⇒ C5+F1 红 · `hasTranscript` 恒 true ⇒ B10+B11 红 · 放宽 `childRunId` 正则 ⇒ A2 红 · 不查名册 ⇒ B9+C3+H1 红。
P3：终态不停轮询 ⇒ 3 红 · 卡片分级忽略 `termination` ⇒ 1 红 · **摘掉截断串的第④层正则兜底 ⇒ 恰 1 红**。

**⚠ 真机挖出并修掉的一个必现缺陷**：`delegate` 结果的 `resultPreview` / `result_digest` 被**截断到 400 字符**（末尾 `…`）⇒ `JSON.parse` 必然抛
⇒ **刷新后「查看子 run」按钮消失**（实时路 `out` 也是截断串，所以两条路都坏）。修法 = `lib/delegate.ts#parseDelegateResult` 四层兜底
（对象 → 整串 parse → 抠 `{…}` → **逐字段正则**），全程不抛；`runId`+`state` 都取不到才返回 `null`。

**⚠ 两条纪律级教训（本单重复踩到）**
1. **worker 报的「既有红」必须自己复算**：本次 `GitLightBadge.spec.ts` 被三个不同执行体各报一次「预存 3 红」，
   而主 agent 在**未修改**状态下单跑恒 **18/18 绿**（全量 1192 也全绿）。这是本仓第 7 次同型「环境性红」（§8.63/§8.82/§8.88/§8.100）。
   有个 worker 据此改了那份 spec，已被主 agent 回退。
2. **同一 worktree 不许有两个执行体**：本单我 resume 了旧 worker 之后又新派了一个，结果三个同时写 `wt-del3`
   （一个在跑变异、一个在建组件），出现「我的 spec 被别人追加用例」「未提交的变异残留」。
   停止旧 run 后残留的那个变异（删掉 `setTimeout` 的变体）被我回退。**并行只允许不同 worktree。**

**已知边界（不许当 bug 修）**
- 子 run **不是会话**：刷新后要从工具卡的 `runId` 重新拉，不能靠「最近会话」。
- 名册/账本**无 TTL**（会累积）；清理是后续片。
- 子共用父 cwd ⇒ 写并行会互踩；对外只说读密集并行。
- 子**不给** notes 工具（父子共用 `scopeRef=sessionId` 的同一批笔记，并发写破坏引擎 single-writer 约定）。
- 抽屉的「单飞」纪律在**链式 `setTimeout` 排程**下**结构上不可证伪**（变异不红：上一发落定才排下一发 ⇒ 并发本就不可能）。
  功能正确，但要让它成为真判据需改成 `setInterval` + `inFlight`（pi-web 形状）——记为后续，未做。
- 名册目录的 TTL / 跨 FDE 统计 / 管理台视图均未做。

**开关默认值翻向（2026-11-09，决策者：「ERIX_DELEGATE_ENABLED = 1 默认允许啊」）**：初版是「未设 ⇒ 关」，现改为
**未设 / 空串 ⇒ 开**；显式值仍只认字符串 `1`（写 `true` / `yes` 反而关——写错字宁可关掉，也别让人以为开了）。
三处默认值必须同源，任一处漏改就会出现「文档说开、容器里是关」那类两头说法：
`runner/lib/config.js#isDelegateEnabled`（未设 ⇒ `true`）· `deploy/docker-compose.yml`（`:-1`）·
`portal/src/provisioner.js#delegateEnvValue()`（未设 ⇒ `'1'`）；判据 `portal/test/deploy-env-delegate.test.js`
（它把 compose 插值默认喂进 runner 的真函数比对，不是各钉各的）。
⚠ 常驻成本随之变成**默认**：开着时每次请求多带 `DELEGATE_DEFINITION` 的 2065 字节（≈516 token）。

**发布物真机复验（v0.1.57，2026-11-09 中午，主 agent 亲手；这次**不是**热 patch，是 ghcr 上的发布镜像）**：
`station-portal 0.1.57` + `fde-eric station 0.1.57 / engine 0.31.0`、容器 env `ERIX_DELEGATE_ENABLED=1`、
`/home/erix/delegation` 由 agentd 自动预建 ⇒ 「默认开」在部署面真的生效了（不再是我 11-09 凌晨热 patch 的那个形状）。
`~/worker-reports-261108/e2e-delegate.mjs` 重跑（父 run `c9f3ae7b…`，`finished/judge_done`）：
2 个子 `completed/end_turn`、`parentRunId` = 真 runId、账本 21142 B/13 行 与 38813 B/24 行、
`GET /delegates` 200 两项 `hasTranscript:true`、`GET /delegates/:id` 200 五条消息、
`usage_ledger` **恰好 1 行**（79686/5143，与 `runs.usage` 逐字段相同）。
**答案正确性也验了**（不只是"跑通了"）：子 A 报 3 个 `.md` / 15 行（我 `printf` 出来的确实是每份 5 行）、
子 B 报 `config.json → alpha,beta` 与 `meta.json → name,version,tags`，逐项对得上。
UI（真浏览器、**先 reload**）：两张 delegate 卡各带 `View sub-task` 按钮（**截断修复在发布物上成立**），
点开抽屉 `✓ Completed / Sub-task 2145bfe9`、正文是子 run 的真实任务+reasoning+4 条工具调用+完整答案，
**终态 9 秒内 0 次 `/delegates` 轮询**。截图 `~/worker-reports-261108/e2e-drawer-v0157-live.png`。
⚠ 一条观察：`probe-delegate` 顶栏 git 灯是**红的**（"Not saved"）——因为我刚往里写了 5 个文件没提交，
这是 D9 的正确呈现，不是缺陷。

### 8.104 v0.1.57 发版与部署：把本地 hotfix 镜像换回发布物（邮箱可见可改 / per-user 邮件验证码 / #468 / delegation）（2026-11-09）

**先记一条账实不符**：`b0b29da`（管理台可显示/修改用户邮箱）与 `45cf6c7`（per-user 邮件验证码开关）**从未走过 PR** ——
它们提交在 main 上，随后被 delegate 那波的 `push origin main` 一起带上去了（`git branch -r --contains` 两条都指向
`origin/main`）。⇒ 想「补一个 PR」时已经无 PR 可提（提交已是 main 祖先）。**口径重申**：改动型提交**不要**直接落在
main 上等人来问「提了吗」——一旦被并行会话的 push 顺带带走，PR 评审这道闸就永久跳过了。以后同类改动走分支 + PR。

**载荷**（自 v0.1.56）：`b0b29da` 邮箱可见可改 · `45cf6c7` per-user `mail_otp_enabled`（迁移 **0028**）· `#468` 端口面板
跟随项目 + 未知项目分组 · delegation 接入（PR #471，§8.103）· 开关默认值翻向（未设 ⇒ 开）。

**发版流程（照惯例，全部先绿再动手）**：`8c8faf2`（六文件 9 增 9 删）→ main CI `42555481846` **两个 job 全绿**
（质量门禁 + 三镜像构建校验）→ tag `v0.1.57` → release `42555885220` success → 三镜像 **直连一次拉齐**（本机
github.com 不通但 GHCR 通；`docker pull` 后 `image inspect .Id` 与清单 `imageId` **逐个一致**：portal `5bd39ae5…` /
fde `cb8d031b…` / proxy `dccb48aa…`，`RepoDigests` 含清单 digest）→ `deploy/.env` 形态① pin **三项**
（备份 `/tmp/deploy.env.bak-0157`）→ `up -d --no-build station-portal`（连带重建 `station-docker-proxy`；
`IMAGE_ALLOWLIST` 由 `${FDE_IMAGE}` 派生，不需要单独改）→ portal 实跑 `5bd39ae5…`、经 Traefik `healthz=200` →
**`docker rm -f` 五台 `fde-*`（双过滤 `label=station.stack=default` + `name=fde-`，对照确认 `fde-workshop-db` 无标签被排除）
→ reconcile 5 秒内全部重建在 `cb8d031b…`**，容器内 `build-info.json` = `station 0.1.57 / engine 0.31.0`、
`ERIX_DELEGATE_ENABLED=1`、agentd `sse connected` + `sse ping received`。

**基线（主 agent 亲跑，判绿 = 退出码）**：根 `npm test` **2001 / 1997 通过 / 0 失败 / 4 跳过**、`node --test runner/test/*.test.js`
**505 / 505**、前端 `typecheck` rc=0 + **61 文件 / 1217 通过**。（台账里 §8.100/§8.102 的 1948 / 481 / 1171 已被
delegate + #468 那几波推高，别再引旧数。）

> ⚠ **2026-11-10 现价刷新**（`main@13be2ce` 实测，四步 rc 全 0）：根 **2120 / 2116 通过 / 0 失败 / 4 跳过**、
> runner **505 / 505** 不变、`node --check` **252** 个文件、前端 **61 文件 / 1249 通过**。上段那组是 §8.104
> 当时的快照（v0.1.57），此后 v0.1.58–v0.1.62 的 #472/#468/delegation 等把根 +119、前端 +32、文件 +9。
> **三处台账（本节 / `docs/ops/ci-release.md` 现价块 / `ci.yml` 步骤 ② 注释）已同批改成这一组值。**

**台账三处对齐（2026-11-09，`main@91e748a` 复跑同值）**：这组数此前只有本节对，另外两处台账各停在不同版本——
`docs/ops/ci-release.md` §1 步骤② 写着 `1932 / 1928`、`:66` 写「当前 1460 里已含 runner 的 334 项」、步骤③ `473/473`、
步骤④ `59 文件 / 1149`、步骤① 「142 个文件」；`.github/workflows/ci.yml` 步骤② 注释写 `1401 项基线`。
已一次性对齐到「① **243** 个文件 / ② **2001·1997·0·4**（含 runner 505） / ③ **505·505** / ④ **61 文件·1217** + typecheck rc=0」，
并在 ci-release §1 加了一个**「现价」权威块**：
每步后面那一大段括号是**历史沿革**（逐单净增记录），**旧数字彼此矛盾，查现价只看那一块**。
⚠ 别再零散改这三处：要么三处一起改，要么不改（分头改正是「文档说关、部署面开」那类两头说法的温床）。

**真机验收（发布物，不是 hotfix 镜像）**：① 管理台 `GET /api/admin/users` 9 个用户，DTO 键含 `email` 与
`mail_otp_enabled`（`admin` / `eric` 的邮箱已在）；② 迁移 0028 在位（`schema_migrations` 有 `0028-user-mail-otp`，
列 `mail_otp_enabled boolean default=false`，存量 9 人全 `false`）；③ 端到端 run（eric，8443 登录 + TOTP）
`1e987488…` ⇒ `finished / judge_done`、8 轮、usage 落库；④ 用户面 `https://station.fde.erix.vip:8443/` 200、
管理台 `https://admin.fde.erix.vip:9443/` 200、`/api/site` 在 8443 上报 `userBaseUrl=https://…:8443`、
预览票 URL 是 **`https://eric-p-22000.fde.erix.vip:8443?preview_ticket=…`**（#465 的 mixed content 修复在发布物上成立）。

**已知遗留**：`build-info.json` 的 `revision` / `built_at` 仍是 `unknown` —— §8.70 那两个 workflow 补丁
（release 传 `STATION_REVISION`、CI 加 tripwire）因 `gh` token 缺 `workflow` scope 一直没推上去，
所以「版本没烘进去」这件事至今**没有自动检查**（`station_version` / `engine_version` 是真值，它们从镜像内文件读）。

### 8.105 运维事故：`docker stop` 触发内核 cgroup-writeback 活锁（2026-10-31，本机）

- **现象**：`docker stop` 报 `tried to kill container, but did not receive an exit event`；随后 `docker exec` 全部 5–8s 超时（`timeout 2` 一律 rc=124）、所有容器健康检查失败、`sync` 挂死、load 84→634，`kworker/*+inode_switch_wbs` 持续 60%+ CPU。
- **内核栈**（`journalctl -k` 的 hung task 报告）：`do_exit → cleanup_mnt → generic_shutdown_super → cgroup_writeback_umount → __flush_workqueue` —— 容器退出卸载 overlay 时等 writeback 工作队列，而 `inode_switch_wbs_work_fn` 在活锁（Ubuntu 6.8.0-147）。
- **结局**：**21 小时后自解**，未重启（5 台 `fde-*` 最终都是 `Exited (0)` —— 即 stop 当时其实已成功，只是 dockerd 报不出退出事件）。用户态无法解除：D 状态进程杀不掉、`sync` 也挂。
- **口径**：见到这个报错 + `kworker/*inode_switch_wbs` 高 CPU，**别再批量发 docker 命令**——每发一条就多堆一批卡住的 `runc`（实测 426→544，load 继续爬）；先看 `/proc/loadavg` 与 D 进程数判断是否在自愈，只能等或重启主机。

### 8.107 前端假红（issue #473 family B）：`vi.waitFor` 的 1000ms 墙钟被 CPU 争抢饿死（2026-11-10）

**症状**：4 路并发全量前端测试时随机红，红的都是路由断言（`expected '/login' to be '/'`、`expected '/admin/users' to be '/admin/llm'`），
单跑必绿。此前 7 次被 worker 报成「预存红」，§8.63/§8.82/§8.88/§8.100 记的也是同一族。

**根因（三步互证，不是推断）**：`await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(X))` 的
**默认超时是 1000ms**，本质是墙钟轮询；而守卫里有一跳 `await useSiteStore().ensureSite()`，CPU 被抢时 jsdom 里
一次真实导航实测 **1195ms**（空闲 0–1ms）⇒ 超时。
① 探针轨迹显示 `afterEach /login -> /` 正常发生，逻辑全对，只是晚于 1000ms；
② 只把超时放大到 15000ms、逻辑一字不改 ⇒ 同负载 3/3 全绿；
③ 旧写法单独放回一处，在 §3 配方下 3/8 红（1488/1646/2075ms），新写法 20/20 绿。

**修法（零墙钟）**：新 `portal/frontend/src/test-utils/navigation.ts#nextRouteLanding(router)`——**先订阅 `router.afterEach`、
再触发动作、再 await 落地**（顺序反了会漏掉已发生的导航）。已核对 vue-router 4.6：守卫 `return { path }` 走
`NAVIGATION_GUARD_REDIRECT` 分支并 `return pushWithRedirect(...)` **提前返回**，中间层不触发 `afterEach` ⇒ 一条重定向链
只在最终落地 fire 一次，「resolve 第一次落地」拿到的就是最终地址。
**失败语义两条都必须显式**：落地到别处 ⇒ 立刻返回**实际** path，由 `expect` 给出差异（`expected '/login' to be '/'`）；
压根没有导航 ⇒ promise 不 resolve ⇒ 用例超时变红（实测 5000ms，属可接受的显式红）。
**19 处路由判据**（`ForcePasswordChangeView` 4 / `LoginView` 7 / `ForcePasswordErrors` 4 / `SeatlessAdminGate` 3 / `AdminView` 1）+
`PreviewPoolUsageView` 的 `clickTab`（等懒加载组件挂载，同族最后一处）。**两处经实测判定为「不导航」**，
改成直接断言当前路由（照抄订阅会必然超时）：`LoginView` 的平台管理员直通用例（`guardEntryRole()` 对无工位管理员
**就地 logout + return false**，走不到 `router.replace`）、`ForcePasswordErrors` 的 `invalid_credentials` 用例（语义是「留在改密屏」）。
5 个 spec 各加 `enableAutoUnmount(afterEach)`（历史上 `ForcePasswordChangeView.spec.ts` 21 个用例 0 次 unmount）。

**红线**：禁止 `sleep` / 把 `vi.waitFor` 的 timeout 调大（那是换一个墙钟预算，不是判据）/ `setTimeout` 重试。
判据只在**落地**这件事上，不在「机器够快」上。

**验收（主 agent 亲跑，`NODE_ENV` 为空）**：`typecheck` rc=0；5+1 文件空闲单跑全 rc=0；14 burner 下 5 文件 ×5 = **25/25 rc=0**、
`PreviewPoolUsageView` ×5 = 5/5 rc=0；**§3 原始配方 4 路并发全量 ×5 轮 = 20/20 rc=0**；全量空闲 rc=0（62 文件 / 1249 用例）。

**变异（主 agent 亲跑，每条先 `git diff --numstat` 自证非空操作、跑完复原）**：落地改成 `/session/zzz` ⇒ 差异断言
`expected '/session/zzz' to be '/'`；删掉 `router.replace(loginRedirect())` ⇒ 2 条 5000ms timeout（显式红）；
`AdminView` 那一处退回 `vi.waitFor` ⇒ §3 配方 3/8 红；`awaitSelector` 改成不存在的选择器 ⇒ 1051ms 内
`[data-test="__nope473__"] 未挂载（tab=号池占用）`（不是 timeout）。
⚠ **`enableAutoUnmount` 变异不红**（去掉后 7 次全绿）⇒ 隔离是防御性改进，**不是**本次假红的判据，别记成「它修好了假红」。

**残留风险（已实测存在，未在本单修）**：`AdminPreviewPorts.spec.ts` 偶发 `Test timed out in 5000ms`（**用例级**超时，
不是断言级，属另一类；worker 环境见过 1/12，主 agent 20 次未复现）；`DirectoryTree.spec.ts` 有 **17 处**非路由
`vi.waitFor`（等 DOM），`workbench.spec.ts` 3 处、`mermaidEnhance.spec.ts` 4 处——同一根墙钟，只是还没在并发下红过。
`setRestrictedSessionListener` 是模块级单例（`lib/restrictedSession.ts`），陈旧 router 的回调会打到最新注册者，属同族隐患。

**family A 不在本单**：`GitLightBadge.spec.ts` 的 `Target cannot be null` 在 4 路并发里复现 **0 次**，按工单要求一字未动。

### 8.108 v0.1.60：文件浏览区「上传」按钮 + 管理台按用户开关（`file_upload_enabled`）（issue #472，2026-11-09）

**需求**：工作台目录树里能直接把本地文件传进 FDE 项目目录；谁能传由管理台按用户开关控制（默认关）。

**两片串行**（A 先合，B 在其上）：A = 开关全链（迁移 + 管理台三态 + 会话 DTO），PR **#478**（`fb1e610`）；B = 上传端点 + 按钮，PR **#479**（`810d949`）；发布 PR **#480**（`6e8f000`）→ tag **`v0.1.60`**（release run `42591423435`）。

**只 pin portal 一个镜像**（`runner/` 零改动）：`/srv/erix/users` 是 portal 与 FDE 容器**共享的 RW bind mount** ⇒ 上传完全落在宿主文件系统上，**不需要重建 FDE 镜像/容器、不需要改 `deploy/fde-proxy` 的 `IMAGE_ALLOWLIST`**。这是本单最省的一处设计判断（对照 §8.70 那个「只改一边 ⇒ `create_policy_denied`」的坑：本单压根没有 env 下发面）。

**上传契约**（`docs/api/portal.md` §4.14）：`POST /api/files/upload`，`Content-Type: application/octet-stream`，query `cwd` / `path` / `name` / `overwrite=1`；成功 `201`（覆盖时 `200`）`{path, bytes, overwritten}`。**零 multipart 依赖**（portal 是零依赖 Node ESM，`readRawBody` 那套模式直接复用）。

**六条硬口径（都有判据，别改回去）**

1. **403 `upload_disabled` 在读 body 之前**（`requireSession` → `fde_name` 400 → `file_upload_enabled !== true` ⇒ 403 `details.action='enable_in_admin_console'`）。判据不是「响应码是 403」，而是 **response `finish` 时刻的 `data` 事件数为 0**——否则「先读完再拒」也能过码面判据（这也是 B-1 那 9 条红最初失败的原因：Node 的 `_dump()` 会在响应后继续抽干 body，计数必须在 `finish` 时快照）。
2. **不覆盖是默认**：目标存在 ⇒ `409 file_exists`（`details.path`）；`overwrite=1` 才覆盖。`rename` 的 `EISDIR`/`ENOTEMPTY` 映射成 `409 file_exists` + `details.reason='target_is_dir'`（否则是 500 裸错误）。
3. **no-clobber 只有 `linkSync` 是保证**：`renameSync` **恒覆盖**（它就是覆盖语义），`lstat` 快路径是**优化不是安全保证**。实现 = 流式写 `.upload-*.tmp`（`O_CREAT|O_EXCL|O_NOFOLLOW`、`0600`）→ `fchown(fdeUid, fdeGid)` → `fchmod 0660` → `fsync` → `linkSync`（`EEXIST` ⇒ `false` ⇒ 409）。abort / 超限 ⇒ `unlink` 临时文件，**不留残留、不留半截文件**。
4. **portal 以 root 跑 ⇒ 必须 `fchown` 同时给 uid 与 gid**：只给 uid 会留 `gid=0`（§8.71 同族），FDE 里的 agent（uid 1002 / 主组 1000）就改不动收到的文件。真机实测 `-rw-rw---- 1 eric eric` 逐条对过。
5. **上限 32 MiB 独立于 `MAX_BODY_BYTES`**（`FILE_UPLOAD_MAX_BYTES`，`413 file_too_large` + `details.max_bytes`）。⚠ **compose 必须显式写 `environment`**——portal 服务**没有 `env_file`**，只在 `deploy/.env` 里加变量不生效（`deploy-env-defaults` 那族判据盯的就是这种两头说法）。
6. **`=== true` 全站，不许 `Boolean()`**：`Boolean('f') === true` 会让 `"false"` 字符串变成「已开启」。开关三处（`admin.js#safeUser`、`auth.js#toSessionUser`、前端 `stores/auth.ts`）全部 `=== true`；**前端缺键 = 未知 = 不显示按钮**（与 #390-A「键缺席不是 false」同一纪律）。

**开关全链（片 A）**：迁移 **`0029-user-file-upload.sql`**（`ADD COLUMN IF NOT EXISTS … boolean NOT NULL DEFAULT false`，`schema.sql` 一字节未改）；`toSessionUser(row)` 是**唯一 DTO 构造器**（`authenticate` / `verifyTotp` / `loadActiveUser` / `findSessionUser` 四处共用，四处 SELECT 都必须带列——漏一处就是「登录后没按钮、刷新后有」）；`createUser` 的**复活分支显式 `file_upload_enabled = false`**（重新启用 = 重新授权，不继承旧权限）；管理台**三态**（缺键 = 未知 ⇒ 禁用保存，且保存只提交该字段，不顺手回写别的）。

**前端（片 B）**：`DirectoryTree.vue` 的 `v-if="canUpload"` 按钮 + 隐藏多选 `input`；上传走 `api()`（保住 #255 受限会话重定向与错误信封）；409 ⇒ `window.confirm`（**确认前零请求**，真机实测网络序列 `201 → 409 → overwrite=1 200`）；成功后 `emit('files-changed')` ⇒ `WorkbenchView` 转给 `gitLight.load()`（D9 的灯必须当场变红——新文件是未跟踪 = 零兜底）。

**门禁与变异**（主 agent 亲跑，判绿 = 退出码）：根 **2119 / 2115 通过 / 0 失败 / 4 跳过**、runner **505/505**、`vue-tsc` rc=0、前端 **62 文件 / 1249**。4 条变异：去掉 255 字节名上限 ⇒ B-6 红；去掉「目标是目录」判据 ⇒ B-9 红；去掉 `emit('files-changed')` ⇒ B-15 红；**去掉 `resolveJailedDir` 的终态 `lstat` ⇒ 40/40 全绿** ⇒ 先自证非空操作后**定性为冗余守卫**（真正的 TOCTOU 窗口在 `await writeTempFileFromStream(...)` 期间，不在提交点），按「纵深防御」保留并把注释改成真话——这类「变异不红」必须如实写进台账，别当测试缺口去补。

**真机验收（本地构建镜像 + 发布物各跑一轮，主 agent 亲手）**：登录 DTO 带 `upload`；`201` 落盘属主/权限/字节逐条对；重复上传 `409` 且原文件未变；`overwrite=1` `200` 内容替换；0 字节 `201`；`path=../../etc` / `a%2Fb` / 目标是目录 ⇒ `400 validation_failed` 三条文案各对；33 MiB ⇒ `413` 且**无 `.tmp` 残留**；Playwright 真浏览器上传 + 覆盖确认框 + 预览可见；管理台关闸后端点 `403`、**真刷新**后按钮与 input 计数归 0。

**三条过程账（都比代码值钱）**

1. **worker 报的「既有 3 红」是 `NODE_ENV=production`**，不是并发负载：`GitLightBadge.spec.ts` 那 3 条用 `w.emitted()`，而 `@vue/test-utils@2.5.1` 的 `emitted()` 靠 Vue devtools hook ⇒ 生产构建不发事件 ⇒ 必红。三组对照（未设 / `production` / `test` ⇒ 18/18 / 3 红 / 18/18）已写进 §4；归因错误的代价是**执行体会去「修」一个不存在的 bug**（#473 里发生过一次，已被回退）。
2. **`git worktree remove` 会连 `.work-orders/*.md` 报告一起删**：片 A 的 294 行报告在清理 worktree 时丢了（未跟踪文件不进对象库、`git fsck --unreachable` 也捞不回）。⇒ **口径：删 worktree 前先把 `.work-orders/*` 归档到 `~/worker-reports-<日期>/`**（片 B 报告已按此归档，片 A 只有本节的转述）。
3. **开工前必须 `git fetch` + 看 main**：本单从计划到发布跨了几小时，期间别的 session 合了 `df15e7c`（片 A 因此需要一次 merge 解冲突）；退役前的最终核对也发现本地落后 origin/main 13 个提交、现网已被另一个 session 部署到 **v0.1.62**。⇒ **「我这单发版了」不等于「现网跑的是我这版」**，报告部署结论前先现查容器版本。

**现状（2026-11-10 退役核对）**：`#472` CLOSED；本单代码在现网 **v0.1.62** 里完好（`upload_disabled` / `file_upload_enabled` / `resolveJailedRoot` 均在，`schema_migrations` head = `0029-user-file-upload`）。**开关现状（决策者 2026-11-10 拍板）**：`eric` 的 `file_upload_enabled = true` **有意保留**（验收时开启，`audit_log` `2026-11-09 08:56:36Z`、`target=eric`；其余用户全 `false` = 出厂默认）——**别再当「探针残留」去复原它**。

**已知边界**：v1 **无配额**（任一用户可写满 userspace，影响所有容器）——**已开单 [#485](https://github.com/ErixWong/erix-station/issues/485) 承接**（① 单文件上限进管理台、DB 优先 env；② 每 FDE 目录总量上限走**文件系统配额**，判据是「容器里 `dd` 也必须失败」，不是「上传被拦」）；`MAX_BODY_BYTES` 与上传上限是两套数，改一个不影响另一个；上传只落到 `~/projects/<project>` 内（沿用 `dirs.js` 同一个 jail 谓词，`resolveJailedRoot` 是从那里**抽出来的**，不是复制的第二份）。⚠ userspace 真实路径是 **`/srv/erix/users`**（`ERIX_USERSPACE_ROOT_HOST`），文档惯例写的 `/docker/erix/users` 在本机不存在，别照惯例 grep。

### 8.109 composer 输入框按内容自适应高度（issue #466 / #467，2026-11-10 落地）

**两张单是同一件事**（#467 是 #466 的重复单）。代码早在 2026-11-06 就写完了，落在
`origin/feat-261106-01-466-composer-autosize` 的 `0a04369`，**但一直没合进 main**（分支 1 ahead / 50 behind），
所以两张单挂着 open 而「代码未处理」这件事只有翻分支才看得见。本次是 **rebase 落地**，前端 4 文件逐字未改。

**性质**：纯展示层。多行输入早就是既有能力（Shift+Enter，#370），长文本进框也有四条常态路
（发送失败回填 `workbench.ts:1350` / 入队失败回填 `:1475` / 切会话恢复草稿 `:904` / 多条拼接 `:1513`），
但 `ComposerBar.vue` 把 textarea 钉死 `style="height: 3.2rem"` + `resize-none` ⇒ 第 3 行之后被藏住。
store 语义 / 三键语义 / 依赖全不动。

**四条实现要点（缺一条就是半截）**：① 夹逼算法出纯函数 `lib/composerHeight.ts`（jsdom 不做布局、
`scrollHeight` 恒 0，逻辑留在组件里只能断言恒真的废话）；② **`watch(store.inputValue)` 而不是 DOM `input`
事件**（那四条回填路全是程序改值，只挂 DOM 事件正好把要修的场景测不到）；③ 量之前先 `height='auto'`
（`scrollHeight` 是 `max(内容, 盒高)`，不松开就只涨不落——发完长消息空框一直撑在那）；④ 封顶是**预算**
不是像素（min 沿用 3.2rem ⇒ 空输入视觉不变；max = 视口 40%，顶到预算 `overflowY:auto` 自己滚，
并监听 `resize` 重算；`borderBoxExtraPx()` 补 border-box 下 `scrollHeight` 不含的上下边框）。

**判据**（前端 62 文件 / 1249 → **63 文件 / 1266**，`typecheck` rc=0；根与 runner 零改动）：纯函数层 11 条
（min/max/NaN/非 px 根字号/两位小数取齐）+ 组件层 6 条。组件层的 `scrollHeight` **不是假成常数**，而是按
`max(行数×行高+padding, 当前盒高)` 建的最小布局模型——否则「内容变短要回落」那条测的是常数比常数。

**主 agent 亲跑 6 条变异（每条先 `git diff --numstat` 自证非空操作，跑完 `git checkout --` 复原）**：
删 `height='auto'` 复位 ⇒ 1 红（回落那条）· 删 `watch` ⇒ **4 红**（含「只改 store 值也重算」那条）·
封顶比例 0.4→0.5 ⇒ 2 红 · 删 `overflowY` 切换 ⇒ 2 红 · `parseRootFontPx` 放宽成 `parseFloat` ⇒ 1 红 ·
删 min 夹逼 ⇒ **4 红**（两层同时咬）。

**真机浏览器验收（2026-11-10，1280×720，`erix_station_playwright`；手法 = 本地 `npm run build` 的 dist
`docker cp` 进 `station-portal:/app/portal/static/app/`，验完 cp 回基线并核对入口文件名复原）**

| 场景 | 实测 |
|---|---|
| 空输入（1 行） | inline `height: 62px`（= `scrollHeight 60` + 2px border），`min-h-[3.2rem]`=51.2 **不生效** |
| 5 行 / 10 行 | 134px / 254px（逐行增长） |
| 60 行 | **288px = 720×40%**，`overflowY: auto` ⇒ 封顶与滚动条都成立 |
| 对话区高度 | 594px → 368px（60 行时）⇒ **没被挤没**，封顶就是为了这个 |
| 程序改值（切走再切回会话，草稿由 store 恢复） | 62px → **254px** ⇒ 「watch store 而不是 DOM `input` 事件」在真浏览器上成立 |

⚠ **一处口径更正（只有真浏览器给得出）**：本节初稿与提交信息都写「min 沿用 3.2rem ⇒ **空输入时视觉一字不变**」，
**不成立**——真实行高下空 textarea 的 `scrollHeight` 已经是 60 > 51.2，`min` 根本不 bind，空框从改动前的
51.2px 变成 **62px**。单测里那条「空内容 ⇒ 51.2px」是**布局模型参数**（20px/行）造成的，不是真机事实：
夹逼函数本身没错，错的是「视觉不变」这句承诺。`min-h` 保留（根字号被调小时它才承重），承诺改成
「空输入时高度 = 一行内容的自然高度（≈62px），不再是钉死的 3.2rem」。

**已知边界（刻意）**：预算取视口 40%（不是固定像素）⇒ 极小窗口下 min 优先（`maxPx = max(minPx, vh×40%)`）；
`overflow-x` 常关（textarea 默认软换行，长 URL 靠换行而非横向滚动）。

### 8.110 v0.1.63：登录第二步改成真 switch + 邮件码懒发信（#449 尾巴，PR #487，2026-11-10）

**用户反馈两条，都成立**：① `#449` 的「二选一」在界面上等于不存在——入口只是 TOTP 表单下面一行
下划线小字「改用邮箱验证码」，没人看见，输完 TOTP 就进去了；② **每次登录都收到一封验证码邮件**——
`handleSecondFactorChoice` 在口令一通过就发信，哪怕用户根本不用邮件码（两天 7 封）。

**后端（`portal/src/http.js#handleSecondFactorChoice`）**：第一步**一封都不发**。删掉
`mailer.send` / `createEmailCode` / `invalidateOtherCodes` / `auth.email_code_sent` 审计 /
`emailSendLimiter.recordFailure`；保留 `createPendingToken`（两路共用一枚）。成功形状改成
`email_deferred: true` 且**不带 `email_sent`**——前端不可用判据是
`email_sent === false || email_unavailable === true`，「还没发」必须与「不可用」分得开，
否则邮箱档在第一步就被剥掉（正是要修的那个缺陷）。仍做**非消费型预检**：`mailer.enabled !== true`
或 `email:<ip>` 限流不允许 ⇒ 走既有降级形状（`methods:['totp']` + `email_unavailable` +
`notice`，错误码与文案零改动，绝不 503）。无 TOTP 账号（`email_code_required`）**仍第一步就发**，
加了回归锁。**零新端点**：第一封由前端切档时调既有 §2.3b resend 端点发出——
`recordResend` 的「该 pending 下零码行 ⇒ 当首次发信、不套 60s 冷却」本来就是为这条路径准备的。

**前端**：第二步表单**上方**两档 switch（`role="radiogroup"` + 两档 `role="radio"` + `aria-checked`，
默认 TOTP），表单随档位切换；`choiceMethods.length < 2`（单通道 / 降级）**不渲染 switch**。
store 新增 `emailSent`（手上有没有码）与 `emailSending`（重入闸 + UI 禁用）；`requestEmailCode()`
**复用** `resendEmailCode()`（后者改成返回布尔，additive），不复制第二份请求代码；
`switchFactor('email')` 触发一次，**切回 totp 零请求**，已发过再切回不再发；发信失败**不**强行切回 TOTP。
i18n 新增 `factorSwitchLabel` / `factorTotp` / `factorEmail` / `emailSending`，删掉 `useEmailCode` / `useTotp`。

**判据**（主 agent 亲跑，判绿=退出码）：根 **2122 / 2118 通过 / 0 失败 / 4 跳过**（基线 2120/2116）、
`npm run typecheck` rc=0、前端 **63 文件 / 1283 通过**（基线 62/1249）。**主 agent 自己的 3 条变异**：
`email_deferred`→`email_sent` ⇒ 后端 4 条具名红；`showFactorSwitch` 放宽成 `length >= 1` ⇒ 前端 3 红；
`switchFactor` 去掉 `factor === 'email'` ⇒ 恰 1 红（「切回 TOTP 零请求」）。执行体另跑 A–I 共 9 条全红，
并**自曝 3 处自家假绿**（`emailSending` 重入门在切档路径打不到、`aria-checked` 只在默认档断过、
「切回 TOTP 不发信」只在 `emailSent=true` 后断过）——三处都补了用例，这正是「变异不红先自证非空操作」的收益。

**真机验收（v0.1.63 发布物，主 agent 亲手，真浏览器）**：`eric` + 口令 ⇒ 第二步出现
`radiogroup "Second factor method"` + 两个 radio，默认 `Authenticator app` 选中，而**库里的码行/发信审计
停在 10/10 一动不动**（懒发信成立）；点「Email code」⇒ 表单当场换成邮箱码（「A code was sent to
e***@i***.com」+ 重发冷却 57s）且计数变 **11/11**（**恰好一封**）；切回 TOTP 再切回邮箱 ⇒ 仍是 **11/11**
（不重复发）；随后用 TOTP 完成登录 ⇒ 落 `#/`，审计 `auth.login_success method=totp`。
截图 `/docker/erix_station_playwright/v0163-switch-totp.png`。

**过程账（三条，都比代码值钱）**
1. **执行体撞 30 分钟硬顶**（`1800000ms` 是上限）：M1 落地后被掐，M2/M3 未做。用户选「续跑同一执行体」，
   续跑后三个里程碑全绿。⇒ 派工给宽活时**里程碑必须各自 commit**（这次 M1 的 commit 让续跑不用重做）。
2. **变异脚本自己坏了**：`/tmp/mut.py` 对 B–F 全抛 `KeyError`（字典没那些键），而外层循环打印的 `rc=0`
   是 **shell 的退出码**⇒ 6 条变异里 5 条是空操作。若不拦，结论会变成「测试覆盖不足」。
   ⇒ **口径：变异脚本必须先打印键名 + 每条变异用 `git diff --numstat` 自证改了字节**。
3. **测试泄漏让每条变异白等 5 分钟**：helper **先开 server 再断言**，断言一抛 server 没人 `close()`，
   事件循环永不空 ⇒ 跑完 24 条 ok 也不退出。修法：断言移出 helper（调用方本来有 `try/finally`），
   或模块级 `after()` 统一收摊。判据：单文件应 **4 秒内退出**（实测 3.9s）。

**已知边界**：① 懒发信之后「SMTP 配了但当下发不出去」**第一步看不出来了**（不试发就不知道），
失败推迟到切档发第一封时（`503 email_send_failed`，pending 不作废，可切回 TOTP）——这是「先拨才发」的
必然代价，已用 ⑭b 钉住；② `emailSent = data.email_sent === true` 是**新前端 + 旧后端**的兼容位
（旧后端第一步真发了信就不为一次切换白寄）；③ 「二选一」**没有功能旗标 env**（§8.73 口径），
要全站关掉就关管理台的 Mail channel（⚠ 那会让「无 TOTP + 开关开」的账号登不进去）。

**部署**：本版只 pin **portal**（`474a62ed…` / imageId `751b6807…`）；`runner/` 的改动来自并行 session 的
`#486`（`compact-knobs.js`），**故意没重建 5 台 FDE**——那批改动等它自己的发版窗口。

### 8.111 会话「隐藏」入口进侧栏（issue #488，2026-11-10，分支 `feat-261110-03-488-hide-session`，**纯前端**）

**需求是决策者一句口述**：「fde 界面的 session，加一个删除按钮，也就是隐藏掉。」关键在**后半句**——要的是
从列表里消失，账本一个字节都不动。取证结论是**后端早就全做完了，缺的只有界面上那颗按钮**：
`chat_sessions.status` 的 CHECK 从 baseline 起就是 `('active','archived')`（`docs/data/schema.sql:194-195`）、
`DELETE /api/sessions/:id` 早已实现（`sessions.js:490` `archiveSession`）并进了契约（`portal.md:71`/`:1121`）、
`listSessions` 的 where 里**硬过滤** `status='active'`（`sessions.js:158`）、`fetchSession` 对非 active 会话直接 404
（`:120`，不泄露存在性）⇒ 本片 `portal/src/**`、`runner/`、`schema.sql`、`deploy/migrations/`、lockfile **零字节**，
生效只需换 portal 镜像（不重建 FDE）。

**五条决策（决策者 2026-11-10 采纳默认值，逐条有判据）**：**D1 界面只说「隐藏」**，不许出现「删除/delete」
（图标用 lucide `eye-off` 而**不是垃圾桶**——垃圾桶在语义上撒谎：后端只归档）；**D2 本片不做找回**（全仓没有
unarchive 端点、`listSessions` 无 `include_archived`）⇒ 隐藏后界面上永久找不回，**这条后果必须写在确认态里**
（`sidebar.hideConfirmNote`，它是唯一的补救提示不是装饰）；**D3 确认前 `DELETE` 请求数 = 0**（`askHide()` 里没有
`await`）；**D4 隐藏当前会话 ⇒ 回首页 + 清空对话窗口**（摘项后 `resetSessionView()`，它内部既有
`workbenchHooks.onClearRoute?.()` ⇒ `WorkbenchView:60` 的 `router.replace('/')`）；**D5 有活跃 run 沿用后端既有
`409 run_in_progress`，不改契约、不加错误码**，界面只给母语提示 + 点名出路。

**交互形态 = (a) 同一行原地确认**（点隐藏 → 该行换成「隐藏 / ✕」两颗同款方块 + 两行确认文案），不是
`window.confirm`：后者阻塞渲染且样式不可控，而**原地确认让「确认态按行分槽」结构上成立**（A 行确认中 B 行不受影响），
不靠标志位维持。

**四件套（主 agent 亲手复跑）**：根 **2122 / 2118 通过 / 0 失败 / 4 跳过**、runner **505/505**、前端 **63 文件 / 1302**、
`typecheck` rc=0。⚠ **根计数与 `origin/main` 逐数相同**（在 detach 的 `origin/main` worktree 上实测同值）——
因为本片非前端文件零改动；**同时纠正 §8.104 记的「根 2120/2116、前端 61 文件/1249」是 `main@13be2ce` 时代的现价**，
main 已前进到 `83bf230`。

**变异 11 条全红在具名用例**（worker 6 条 + 主 agent 5 条，每条先 `git diff --numstat` 自证非空操作、跑完复原）：
主 agent 那 5 条 = 不复位详情区 / 复位条件放宽成无条件 / D2 后果提示置空 / `aria-label` 塞「删除」/ 去掉在飞守卫。

**真机三条全过**（本地构建镜像顶 pin，验完还原；bundle 先断言 = `index-BsJZeRng.js`，与镜像内同名）：
① 点隐藏只进确认态，**确认前 network 里 DELETE = 0**，全页确认按钮数 = 1（分槽），整页 `delete|删除` 命中 0；
② 确认后 **恰 1 发 204**、行消失、**URL 从 `#/session/…` 变 `#/`**、`.msg` 归 0、**没有**后续整表 `GET /api/sessions`；
③ **硬刷新后该行不出现** 且 DB `status='archived'` ⇒ 真归档不是前端本地摘项；
④ **409 支路真机跑通**：起一条 `sleep 120` 的 run 后点隐藏 ⇒ 行不消失 + 行内 `.syserr`「still has a run in progress —
stop it first, then hide it」，Stop 后再点即成功。

**过程账（本单是「worker 撞硬顶但交付完整」的一次）**：worker 撞 30 分钟硬顶（76 轮 / ↑10.6M / ↓115k），
**两个 commit 与全部测试都已落地、工作树干净、6 条变异全红**，只差终局报告 ⇒ 主 agent 没有重烧也没有换执行体，
直接接手验收（复跑四件套 + 5 条自己的变异 + 真机）+ 补报告（`~/worker-reports-261110/488-report.md`）。
⇒ **口径：硬顶后先看现场再决定，`git log` 里有没有 commit 比「它有没有写完报告」重要**；「报告缺失」不等于「活没干」。

**已知边界**：不做找回 / 不做批量隐藏 / 不做撤销 toast；`SessionPickerModal` 走同一个 active 列表 ⇒ 隐藏后那里也看不到
（一致，不是漏做）；隐藏不删 run / transcript / messages / notes，LLM 用量账仍计入该用户。

**发版与部署（v0.1.64，2026-11-10）**：`6e0d4ae`（六文件 9 增 9 删）→ main CI `42767596000` 系两个 job 全绿
（含三镜像构建校验）→ tag `v0.1.64` → release `42767714882` success → 清单 portal `digest=89694378…` /
`imageId=47b83d49…`，`docker pull` 后 `docker image inspect .Id` **逐位一致** → `deploy/.env` 形态① pin
**只 pin portal**（`git diff v0.1.63..v0.1.64 -- runner/` 去掉版本文件后为空 ⇒ `FDE_IMAGE` 仍 v0.1.63 摘要、
**5 台 FDE 容器故意没重建**；备份 `/tmp/deploy.env.bak-0164`）→ `up -d --no-build station-portal` ⇒
portal 实跑 `47b83d49…`、`healthz=200`、浏览器 bundle = `index-BsJZeRng.js`（与本地构建同名）。

⚠ **一条交付节奏的教训（决策者当场催过一次）**：「代码已合进 main」不等于「用户能用」——纯前端切片尤其容易犯：
本片合完 PR 后我按惯例「等发版窗口」，而决策者看到的是**界面上根本没有那颗按钮**（现网仍 v0.1.63）。
⇒ **口径：纯前端/纯 portal 的可见变更，合完就顺手发版**（只 pin portal 一个镜像、不重建 FDE、几分钟），
别把「等窗口」用在「用户马上要看的按钮」上。截图 `/docker/erix_station_playwright/488-hide-button-live.png`
（会话行 hover 后右侧第三颗 = 眼睛带斜线，前两颗仍是 ✨ AI 改名 / ✏️ 重命名）。

⚠ **现网已被后续版本覆盖（2026-11-10 现查）**：我发的是 `v0.1.64`，但随后并行的 session 又发了 `v0.1.65` / `v0.1.66`
（§8.112 / §8.113），现网 `station-portal` 实跑 `892a027c…` = v0.1.66 的 imageId。**代码没丢**：
`git merge-base --is-ancestor dd8c937 v0.1.66` = 真，且容器内 bundle 实测仍含 `sidebar-hide` / `hideSession` /
`hideConfirmNote` 与中英双语确认文案 ⇒ 按钮在现网上活着。⇒ 引用本节时**别把「现网 = v0.1.64」当事实**，
它是「本片发版那一刻」的记录。


### 8.112 v0.1.65：管理台「二次验证」tab + 两个 checkbox + 后端 `totp_login_enabled` 一维（PR #490，2026-11-10）

**用户三轮反馈收口**：① 管理台里找不到「二选一」（埋在 `安全` tab、是个原始勾选框）；②「你这谁看了会觉得
这是 switch？」；③「把邮件和 TOTP 这两个放到单独的 tabpage」「用 checkbox 就行，check 了就显示相关控件」。

**UI**：用户编辑抽屉新增 **`二次验证`** tab（`资料 / 安全 / 二次验证 / LLM 与仓库 / 预览端口 / 危险操作`），
`TOTP 设置` 与 `邮件验证码` 从 `安全` 搬进去（`安全` 只留 `重置密码` + `文件上传`）。里面是**两个独立
checkbox**（`data-test="mfa-totp-checkbox"` / `mail-otp-enabled`）：勾上才 `v-if` 展开对应块；TOTP **未绑定**
⇒ 该框禁用 + 显示「未绑定」+ 绑定按钮就在这一行；**两个都不勾** ⇒ tab 顶部 `.syserr` 红字
「该账号将只用口令登录（无第二因素）」（决策者 2026-11-10 拍板：**允许**，但必须警告）。
保存按钮 `save-mfa-settings` **只提交改动过的那一位**（PATCH body exact keys），且**永远可见**
——勾选框与保存按钮刻意住在折叠块**外面**，否则「取消勾选」会把自己和保存按钮一起收起，关掉这件事就再也提交不了。

**后端新增一维 `users.totp_login_enabled`（迁移 `0030`，默认 `true`）**：此前「绑过 TOTP」
（`totp_secret IS NOT NULL`）与「允许用 TOTP 登录」是**同一位**，于是「密钥留着、但登录只走邮箱验证码」
在界面上根本表达不出来（要嘛重绑、要嘛删密钥）。现在 `chooseSecondFactor` 的判据变成
`totpUsable = 绑过 && totpLoginEnabled !== false`，五分支表见 `docs/api/portal.md` §2.2。
**关掉不清密钥**（`totp_secret` 一字不动）；默认 `true` ⇒ 存量用户升级后行为**一字不变**；
`totpLoginEnabled` **缺参/缺键按 true**（「没读到」= 「没人关过」）。`auth.js` 两处 SELECT 都要带这一列
（漏一处就是「登录后和刷新后不一样」）。

**判据**（主 agent 亲跑，判绿=退出码）：根 **2134 / 2130 通过 / 0 失败 / 4 跳过**、`npm run typecheck` rc=0、
前端 **63 文件 / 1311 通过**。**主 agent 自己的 2 条变异**：红字 `v-if` 改 `false` ⇒ 2 条具名红；
`mfaChanges` 改成永远提交 `mail_otp_enabled` ⇒ 恰 1 红（「保存只带改动那一位（exact keys）」）。
执行体另跑 5 条变异全红（含「TOTP 框未绑定时不禁用」「TOTP 块 `v-if` 改 `v-show`」
「邮件码框被 `totp_enabled` 连带置灰 = #449 红线回归」）。

**真机验收（v0.1.65 发布物，主 agent 亲手，真浏览器）**：tab 列表第 3 项是 `Two-factor`；
`eric` 两个框都勾着、两块都展开、保存按钮 `disabled`（无改动）；**取消 TOTP** ⇒ TOTP 块消失、
邮件块仍在、无红字；**两个都取消** ⇒ 两块都消失 + `.syserr` 红字
「⚠ This account will sign in with the password only (no second factor).」；再勾回来 ⇒ 恢复原状、
保存按钮回到 `disabled`。**全程没点保存**：事后 `users` 表 `eric` 仍是
`mail_otp_enabled=t / totp_login_enabled=t / totp_enrolled=t`，`admin.user_updated` 30 分钟内 **0 行**
（证明「切换 → 不保存 ⇒ 库里一个字节没动」）。截图 `/docker/erix_station_playwright/v0165-mfa-tab.png`。

（那个与 `save-mfa-settings` 并存的冗余「保存邮件码设置」按钮已于 v0.1.67 删除，见台账 §8.115。）

**过程账**：这块前端切片连折两个执行体——一次撞 30 分钟硬顶、一次**进程直接消失**（`stale-run
reconciliation` 判死，内存与系统日志无 OOM 痕迹），两次都**零提交**。⇒ 主 agent 第一次在死之前
`git add -A` 把后端 WIP 落盘（`8da1286`，61/61 绿），第二次续跑才做完。**教训：执行体死掉时先看工作区有没有
未提交的成果，`git add -A` + 一条 `wip(...)` 提交是最便宜的保险**（否则 30 分钟的活直接蒸发）。

### 8.113 v0.1.66：验证码邮件双语 + 登录页写出「N 分钟内有效」（PR #491，2026-11-10）

**两条用户要求**（2026-11-10，同一轮提出）：「验证码邮件请使用双语」+「然后 10 分钟有效这个写到 web 页面上」。

**① 邮件双语**（`portal/src/http.js#emailCodeMessage`）：主题
`FDE Station 登录验证码 / Sign-in verification code`；正文**中文一行 + 英文一行，两种语言各写一次同一个码与
同一个有效期**，末尾两句安全提示同样双语。理由：收件人未必读得懂中文，而验证码邮件是登录的**唯一**凭据
来源——看不懂就等于收不到。分钟数由 `ttlSeconds` 现算（`EMAIL_CODE_TTL_SECONDS` 可覆盖），**不写死 10**。

**② 登录页写出有效期（服务端驱动）**：新字段 `email_code_ttl_seconds`（**码**的 TTL）四处统一下发——
`email_code_required` / `second_factor_choice`（含降级形状）/ 其 `503 email_send_failed` 的 `details` /
`resend`。⚠ **它与 `expires_in` 不是同一个数**：`expires_in` 是**待决令牌**的有效期
（`max(PENDING_TOKEN_TTL_SECONDS, EMAIL_CODE_TTL_SECONDS)`），拿它渲染「N 分钟内有效」在
`PENDING_TOKEN_TTL_SECONDS > EMAIL_CODE_TTL_SECONDS` 时会直接说错。前端 `stores/auth.ts` 新增
`emailCodeTtlSeconds`，四条来路收口 + `resetPendingLogin()` 一并作废；**只认正数**，缺席 / 字符串 / `0` /
负数 = 「不知道」⇒ 那句话**整句不渲染**（不猜，也不退化成「0 分钟」）。`LoginView.vue` 把它渲染在
**输入框与提交按钮之间**（`-mt-2` 抵掉输入框自带的 `mb-3` ⇒ 有/无这一行时按钮位置不变），两档之间切换不丢。

**判据（+6）**：后端 ⑰ 邮件双语逐字（主题中英 + 两行各含同一个码与 `10 分钟` + 两句提示双语）；
⑱ `email_code_ttl_seconds` 四处下发，且**覆盖 `EMAIL_CODE_TTL_SECONDS=120` ⇒ 字段与邮件正文一起变成 2 分钟**
（这条就是「前端不许写死 10」的判据）；前端 4 条（600s ⇒ 「验证码 10 分钟内有效。」且位于输入框与按钮之间 /
120s ⇒ 「2 分钟」/ 缺席与三种脏值 ⇒ 整句不渲染 / 二选一切档后仍在，中英各一次）。

**基线**：根 **2134 / 2130 / 0 / 4 → 2136 / 2132 / 0 / 4**（+2）、runner **505 不变**（`runner/` 零字节）、
前端 **63 文件 / 1311 → 1315**（+4）、`typecheck` rc=0。台账三处（本节 / `docs/ops/ci-release.md` §1 现价块 /
`ci.yml` 步骤 ② 注释）同批刷新。

**主 agent 亲跑 4 条变异**（每条先证 `git diff --numstat` 非空、跑完为空）：邮件去掉英文行 ⇒ 2 红；
`second_factor_choice` 不下发 TTL ⇒ 2 红（响应键集那条 + ⑱）；前端写死 `return 10` ⇒ 2 红；
`normalizeEmailCodeTtl` 改成接受字符串 ⇒ 1 红（脏值 `'600'`）。

**发版与部署（v0.1.66）**：PR #491 → `chore(release): 0.1.66`（六文件 9 增 9 删）→ main CI 两个 job 全绿 →
tag `v0.1.66` → release `42776650239` → 清单 portal `digest=ae90a9a6…` / `imageId=892a027c…`、proxy
`digest=aa7a5b6d…` / `imageId=71bc1f3c…`，`docker pull` 后 `image inspect .Id` **逐个一致** → `deploy/.env`
形态① pin 两行（备份 `/tmp/deploy.env.bak-0166`）→ `up -d --no-build station-portal`（连带重建
`station-docker-proxy`）⇒ 容器内 `0.1.66`、经 Traefik `healthz=200`。**本版 `runner/` 零改动 ⇒ 五台 FDE
容器故意不重建**（`FDE_IMAGE` 未动）。

**真机验收（v0.1.66 发布物，主 agent 亲手）**：API `POST /api/auth/login`（eric）⇒
`email_code_required` + `email_code_ttl_seconds: 600`；浏览器（`meeting_asr_app_playwright` + 临时 Host/Origin
改写代理 `127.0.0.1:18099 → 8090`，验完已 kill）走到邮箱码第二步，DOM 里
`[data-test="emailCodeTtl"]` 中英各读一次：`The code is valid for 10 minutes.` / `验证码 10 分钟内有效。`，
位置在输入框之后、按钮之前；容器内 `grep` 确认 `/app/portal/src/http.js` 有双语主题行、
`/app/portal/static/app/assets/api-*.js` 同时含中英两条 i18n 串。⚠ **vision relay 当时挂了**
（`http_request_failed` 两次）⇒ 截图的看图复核没做，改以 DOM 断言为准（`/docker/meeting_asr_app_playwright/v0166-code-ttl-zh.png`）。

**已知遗留 / 现场事实**：
- 验收时发现 `eric` 的 `totp_login_enabled = false`（`totp_secret` 仍在）⇒ 他现在走的是
  `email_code_required`（邮箱码是唯一第二因素），两档 switch 对他是隐藏的。**不是本单改的**，
  是管理台侧某次保存的结果；要恢复 TOTP 登录去「二次验证」tab 勾回来即可。
- 本次验收真实发出了两封双语验证码邮件（curl 探针一封 + 浏览器一封，收件人 `ewang2@intevaproducts.com`）。

**过程账（一次真的把别人的工作区搞脏了，已完整复原）**：我在 worktree `wt449h` 里为了做版本号 bump 跑了
`git checkout -q main || git checkout -q -B main origin/main` —— 第一支因「`main` 已在主工作区检出」失败，
**第二支的 `-B` 把共享的 `main` ref 直接重置到了 `origin/main`**，于是**主工作区的 HEAD 跟着跳了**
（它的 index/工作树还停在旧提交）。后果：主工作区 `git status` 突然显示 37 个文件「已暂存」、3623 行删除，
看起来像有人在乱改；真相是「HEAD 前进、index 没动」的假象，**里面还压着另一个 session 未提交的
`docs/README.md` 一行 + 未跟踪的 `docs/design/event-platform/`**。
复原：先备份 `docs/README.md` → `git reset --hard HEAD`（`--hard` 不动未跟踪文件）→ 把那一行原样插回 →
`diff` 证明与复原前**逐字节相同**。
⇒ **口径：worktree 里做版本号/发布提交，绝不 `git checkout -B <branch>`（或 `git branch -f`）一个「已在别的
worktree 检出」的分支**——ref 一移动，别人的 HEAD 与 index 就分家了。正解：在**主工作区**做 bump 提交
（它就是 main），或在本 worktree 里用**自己的分支名** `git reset --hard origin/main`。

### 8.117 热层清退 S2 + S3：台账搬家与预算闸（261111，主 agent）

**S2 搬家**：`AGENTS.md` 第 201 行到文件尾**整块原文**搬进本文件（前置一条 `---` 与来源注释），
热层只留 §8 三条引言 + 一段指针。搬运是**可证明无损**的：把「保留的前 200 行」与「搬走的尾块」
拼回原文件，md5 与搬运前一致。搬走 **652,581 字节**，`AGENTS.md` 671,281 → **19,994 字节**，
热层口径（`## 8.` 之前）**18,371 字节**。113 条 `8.N`、若干叙事块、《0.14.0 宿主契约快照》全部
原样在此，编号一个没动。

**S3 上闸**：`scripts/agents-hotlayer-budget.mjs` + `npm run check:agents-hotlayer`，并用
`test/agents-hotlayer.test.js` 把它挂进 `npm test`（沿 `test/repo-hygiene.test.js` 的先例，
不动 `.github/workflows/ci.yml`）。五格判据：

| 格 | 判什么 | 现值 |
|---|---|---|
| `ledger-stays-out-of-hot` | `AGENTS.md` 里 `### 8.N` 标题必须为 0（台账不许再长回热层） | 0 |
| `hand-copied-pin` | 抓「当前/现状/最新 … pin/tag/version + x.y.z」这类手抄当下断言 | 绿 |
| `hand-copied-suite-count` | 抓热层抄门禁条数 | 绿 |
| `hand-copied-tool-count` | 抓热层抄工具条数 | 绿 |
| `hot-byte-budget` | 热层字节 vs 预算（`ceil512(实测)+1024`，只有 `--sync` 能写） | 18,371 / 19,456 |
| `ledger-ref-floor` | `§8.N` 引用面**只升不降**的地板（掉了 = 有人改号或删引用） | 595 / 595 |
| `ledger-integrity` | 台账条目数 ≥113 且**编号不许重复** | 116 条，无重复 |

反向自证：`--self-test` 六条用例（四类断言必须被抓 + 两种合法写法必须放过），已作为一条测试跑。
**它第一次真跑就抓到东西**：本文件里 `8.115` 与并行 session 的 `8.115` 撞号（见 §8.116 顶部登记）。

**顺带对齐的账**：`docs/ops/ci-release.md` §1 现价按最终树重测后刷新（① 255 文件 · ② 2138 / 2134 /
0 / 4 · ③ runner 505 / 505 · ④ 前端沿用 `bd227e2` 的 63 文件 / 1316，本笔未动前端），并在他们那句
「三处台账同值」后面补了实况——那三处如今只剩本节写数字。

**最终验证**：`npm run check:agents-hotlayer` rc=0（七格全绿）；`npm test` = **2138 / 2134 通过 /
0 失败 / 4 跳过**；`git status` 只剩他单在飞的 `docs/README.md` 与 `docs/design/event-platform/`。

### 8.118 事件驱动平台可研：13 份设计文档 + 一次独立 UI 评审（261111，主 agent，**纯文档、不排期、未开发**）

> **挑号订正**：用户口径是「编号从 §8.115 续」，但 `8.115` 已被《管理台 MFA 保存入口收敛》占用
> （并行 session 那次撞号见 §8.116 顶部登记）。按 §6 口径现查 `grep -n '^### 8\.' … | tail -3`，
> 本文件当时最大号是 **8.117** ⇒ 本条取 **8.118**。同时把「现状」里那句写死的
> 「编号从 8.114 续」改成「最大号 +1，挑号前先 grep」——写死下一个号就是下一次撞号。

**定位**：`erix-station` 要大升级，所以这件事**只做讨论与可行性分析**，不排期、不写产品代码。
目录 `docs/design/event-platform/`（14 个 md，含 README），与 `design/fde-platform.md` 分开住——
后者是 station 的规格（「一个 run 怎么安全地发生」），前者回答「这个 run 该不该发生、发生完算不算数」。
混在一起会让两份文档互相污染，而 station 马上要大改，污染代价翻倍。

**13 份文档各回答什么**（README 是索引）：

| 文件 | 一句话 |
|---|---|
| `01-positioning` | 不是 n8n（节点是 API 调用）、不是 Dify（用户造应用）；产物是「一条被证据关闭的工作项」 |
| `02-model` | 六字段事实消息、封闭 `state` 枚举、幂等键 `(source, object_key, state)`、影子表而非消息总线 |
| `03-verdict` | 判决四档 `pass/red/no-op-claim/needs-human`；判据必须独立于执行者；变异是「判据的判据」 |
| `04-scope` | 简化版 / 加强版按「系统内 / 系统外」切；五个事件四个已有 |
| `05-feasibility` | 五条可证伪命题 + 五种死法 + 三层结论判据 |
| `06-macros` | 宏五格；「是什么」在代码、「开不开/参数」在 DB；**宏是范围缩减，不是便利** |
| `07-scenarios` | 五个正例 + **一个反例**（会话砖化不是宏，是平台故障） |
| `08-scheduled-and-sessions` | 打卡型宏不需要 subagent；自动开会话要 `origin`+确定性标题+jitter；跨会话记忆是硬阻塞 |
| `09-catalog` | 5 事件 × 12 动作 × 6 参数类型；「谁需要被叫醒」判据；状态型必须分档 |
| `10-first-macros` | 第一版 3 条（M1 终态通知 / M8 静默告警 / M7 定时任务）；E2/E3/E4 挂账 |
| `11-review-and-recovery` | 完成→审查→回灌（只回灌一次）；失败→分诊（七种 reason 只有两格半该起 agent） |
| `12-surfaces` | 模板类型（代码）/ 模板实例（管理台）/ 订阅（用户下拉）三层；执行器在 portal 进程内 |
| `13-macro-panel` | 用户端面板，单位是「一次触发」不是「一条配置」；含 §10 独立评审记录 |

**几条立住的判据**（这几条是会改变别人下一步动作的，其余都在文档里）：

1. **平台能自己修的故障不是事件。** 会话砖化、队列卡 `delivering`、租约耗尽、镜像漂移、证书
   `not_reloaded` —— 这些做成宏就是把平台责任转嫁给用户，而且事件表会变成无限长的 bug 列表。
   去处是内置告警 + 运维手册。
2. **事件清单 ≠ 第一版宏目录。** 前者是「平台能观测什么」，后者是「第一版配哪些」。
   E4 证书留在清单上但第一版不配宏（真过期没意义、动作只有通知、agent 换不了证）。
3. **一个源可以同时有边沿 state 和状态 state。** `run:<id>` 的终态是边沿，`silent` 是状态；
   区别在求值方式，不在源的身份。**状态型宏的阈值必须小于「会改变该状态的上游机制」的阈值**——
   静默告警必须 < `ERIX_AGENTD_WATCHDOG_MS`（300s），否则 worker 真死那一类全被 watchdog 吃掉。
4. **静默要用 `run_events` 量，不能用 IPC 量。** `shell` 工具执行期每 30s 发 `shell_liveness` 心跳
   （`worker.js:593-603` 明写「绝不得走 emitEvent」）⇒ 长命令期间 IPC 一直有、`run_events` 一条没有。
   用户感知的「没反馈」是后者。站内现有四套静默判据（引擎四相超时 / agentd watchdog / reaper 租约 /
   前端 stall）**互不覆盖，且没有一套会通知用户**——前端那个 60s 只是变黄。
5. **回灌是唯一能让系统成环的边。** 所以只有这里必须上血统（`trigger_kind='synthetic'` 零迁移 +
   `runs.actor` + `depth ≤ 1`），且只回灌一次：两轮「AI 说成了 / AI 说没成」说明判据本身不清楚。
6. **审查要新会话，恢复要原会话。** 判据：要独立性就换会话，要上下文就留会话。
7. **参数进宏模板，不进订阅。** 参数进订阅会让「这个宏在干什么」变成 N 种配置的并集，运维无法审计。
   但 `state` 枚举与阈值仍是两回事（用户填 N 写进 state ⇒ 造出没人评审过的新 state，幂等键不可枚举）。

**独立 UI 评审（copilot，两单）**：只读、独立 detached worktree、`allow=work`、`gpt-6-luna` /
`context=default` / `effort=xhigh`。

- **第一单 `cp-2611101417-5k395k`：aborted（看门狗，40 分钟），报告零字节。** 根因在派单不在执行体——
  我把「每条结论必须指回 file:line」和「交付报告」串行化了，取证吃掉全部预算。
- **第二单 `cp-2611101459-4dsapf`：completed（45 分钟预算内）。** prompt 开头加纪律：
  「10 分钟内必须落盘骨架、第 25 分钟不管写到哪立刻落盘」。报告 68 行。
- **消费前抽验 8 条 file:line，全部对得上**（`13` 确实 198 行、`style.css:17/19` 是
  `.roundsep`/`.roundsep.judge-panel`、`SidebarPanel.vue:401` 是 `max-h-[50vh]`、
  `RunStatusBar.vue:190` 是 `flex flex-wrap`、`GitLightBadge.vue:134-145` 是色点+文字+aria-label、
  `StreamPanel.vue:593` 是 `.roundsep`、`WorkbenchView.vue:324-336` 是四段分区、
  `DelegateChildDrawer.vue:217-225` 是覆盖式）。
- **它抓到的 blocker 是真错**：我在 `13` 里写「形状照 delegate 抽屉」，却画了「消息流变窄 + 右栏并排」
  的线框；而 `DelegateChildDrawer.vue:217-225` 是 `fixed inset-0` + `max-w-xl`（576px）覆盖式。
  **承诺必须只有一个。** 采纳并改：覆盖式 480–520px。
- 另外 6 处采纳：四级链默认折叠（原写「不折叠」是错的）、附注按数据有无显示（原写固定三行）、
  跳过同因聚合 + 颜色分级（`human_present` 不归责用户）、成本默认折叠且标估算（原写常驻 `≈ ¥x.xx`）、
  空态补三种技术态并把「评估循环没跑」移出空态区（它可能在有记录时也存在）、`user` scope 流水从「待定」
  改为「已定：不在用户面显示」（与 `12` §2.2 统一）。
- 报告落 `~/worker-reports-261108/copilot-ui-review-macro-panel.md`（在仓库外，worktree 删了也不丢）。

**遵守的两条既有口径**（不是新结论，只是本条的执行证据）：

- **热层只留判据与决策**：13 份文档全部落在 `docs/design/event-platform/`，`AGENTS.md` **一字未改**；
  本条的判据也没进热层。§8.117 已搬走 652,581 字节，热层 18,371 / 19,456 字节。
- **worktree 里绝不 `git checkout -B` / `git branch -f` 一个已在别处检出的分支**（§8.113 那次把
  `wt449h` 搞脏的成因）。本条的评审沙箱是 `git worktree add --detach`，全程没碰任何分支 ref，
  用完 `git worktree remove --force` 清掉；报告不落在沙箱里。

**⚠ 本批唯一没取证的一格**：管理台「二次验证」tab 的 **DOM 断言**（属 §8.112 / PR #490）。
本机 playwright 实例解析不了 `*.fde.erix.vip`，所以没有可提交的自动化 DOM 断言；
现有证据只有两条：**部署产物字节**（`/docker/erix_station_portal` 里构建出的 JS 含
`data-test="mfa-totp-checkbox"` / `mail-otp-enabled` / `save-mfa-settings`）+ **组件层用例**
（前端 63 文件 / 1311 条里的 MFA 那几条）。⇒ 「真机 tab 渲染正确」这件事**是主 agent 手工看过截图，
不是断言跑出来的**；把「§8.112 已真机验收」读成「有自动化 DOM 断言」是误读。

**补记（同日，清理合并 14 → 8）**：独立评审（copilot `cp-2611111142-shcw7u`，45 分钟预算内完成，
报告 `~/worker-reports-261108/copilot-doc-review-14files.md`，109 行）独立得出**同样是 8 份**，
且分组比我原计划更合理 —— 关键理由是**场景压测（原 07）与首版清单（原 10）必须分开**，
否则「讨论过的场景」会被读成「首版承诺」。按它的分组执行合并：

| 新文件 | 来源 | 行 |
|---|---|---|
| `README.md` | 重写（加 5 行决策卡，删 14 行逐篇摘要） | 105 |
| `01-decision-and-feasibility` | 01 + 04 + 05 | 514 |
| `02-event-model-and-verdict` | 02 + 03 | 414 |
| `03-macro-model-and-catalog` | 06 + 09 | 610 |
| `04-scenarios` | 07 | 261 |
| `05-first-macros` | 10 | 474 |
| `06-execution-and-recovery` | 08 + 11 | 412 |
| `07-surfaces-and-panel` | 12 + 13 | 654 |

**合并是脚本 + 校验做的，不是手拼**：约 290 处 `§N.M` 节号引用要跟着重排，其中 `§8.NN` 是台账引用
（不能改）、`§7.A` 是字母子节、`10-first-macros` 的 `## 0.5` 是「顶层节写成子节号」的坏编号。
脚本先建全局 `旧节号 → 新节号` 映射，再一次性改写标题与引用，**校验器零问题才允许写入**
（校验器查：残留旧文件名、链接后 `§` 是否落到存在的标题、裸 `§` 是否同文件可解析）。
两次写错的教训：① `§(\d+(?:\.\d+)?)` 贪婪会把 `§1.1` 整段吃成一个键 ⇒ 必须拆成 `§(\d+)(?:\.(\d+))?`；
② 改编号的正则如果顺序执行会**级联**（`## 0.` → `## 1.` 又被下一条 `## 1.` → `## 3.` 再吃一次），
必须一次查表替换。**第二次级联把 `10-first-macros.md` 改坏，而它是未跟踪文件、没有 git 兜底**，
靠之前派单留下的干净 worktree 副本还原 —— 这条值得单独记：**未跟踪文件做批量改写前先复制一份**。

**评审抓出并已修的 6 处真实矛盾**（我只知道其中 2 处）：① 03 里「会话是不是事实对象」自相矛盾
（同一节先说「必须是合法事实对象」又说「不是事实对象」）；② 03 §12「第一个该设计的宏＝收工提醒」
是已被 05 的 E1+E5 决策取代的旧提案；③ 06 的「第一版先做文件+通知」与 05 的 M7 宏会话冲突；
④ 05 的 M1/M8 作用域写「用户／我的所有会话」，与 07 的会话级下拉冲突；⑤ 07 的模板类型与下拉示例
把 review/recover 列成「已启用」，与 05 首版三条冲突；⑥ `runner-integration.md:601` 仍称 notes 是
logical-run 作用域，与 `runner/worker.js:553-557` 的现行代码不符（**这条属站内文档过时，本批没改**）。

**状态**：本批**不排期、未开发**（`docs/design/event-platform/` 只是可研），
六个待决策项在 `10-first-macros.md` §7 / `12-surfaces.md` §7（模板是代码常量还是可编辑数据）/
`13-macro-panel.md` §9.2。

### 8.119 open issue 全量对账：关 5 条 / 拆 4 条（261111，主 agent，**零代码改动**）

用户问「哪些已经做完了但没关」。判据用**当前树的 file:line**，不用 `ISSUES.md` 里 10-30 那份
分层表（二手事实，它自己那批建议已执行掉 9 条：#404/#356/#395/#371/#378/#233/#274/#163/#440 已关）。

**关掉 5 条**（结案评论逐条点到位置）：**#392**（五片全在：`runner/worker.js:933-938` A /
`:575-581`+`:569` B / `:771-789`+`:1094-1103` C / `StreamPanel.vue:342` D /
`runner/test/fold-notes-e2e.test.js` E；D 片暴露的横幅缺口另开的 #440 已关）·
**#359**（P0a `gitlight.js:352`+`http.js:1031` / P0b `GitLightBadge.vue` / P0c `AGENTS.md` §7.2；
唯一未裁的「partial 压红」拆 #494）· **#366**（PR #372 `aaf8294` + `deploy/README.md:60` +
`docs/env.md:332-334`；部署面拆 #493）· **#412**（③④ 已修，①② 拆 #495）·
**#473**（family B = PR #483 `309f9a9`；family A 拆 #496）。open 数 20 → **19**。

**新开 4 条**：**#493** kkFileView 镜像 push GHCR + digest 钉 + profile 起起来并真机验收 ·
**#494** 「没扫完」不该把已证实的红压成灰（三候选 + 代价，`needs-product-decision`，**等拍**）·
**#495** wp3b 的 ①②（起跑前预检 `--env-file`；把 EACCES 与「没物化」分开报）·
**#496** 3 个 spec / 6 处 `w.emitted(...)` 换 DOM/请求桩。

**本批新测出来的事实（原单里都没记）**

1. family A 的环境地板**不止 `GitLightBadge`**：`NODE_ENV=production` 跑三个 spec ⇒ **rc=1 / 4 红**
   （`GitLightBadge` 3 + **`SidebarPanel.spec.ts` 1**），同一批 `env -u NODE_ENV` ⇒ **97/97 rc=0**。
   全仓还剩 3 个 spec / 6 处 `.emitted(`（`DelegateChildDrawer.spec.ts` 那处在此环境下仍绿）。
2. **#366 之前被当成「已交付」，但部署面三条判据全空**（现验）：`ghcr.io/erix-station/kkfileview:5.0.3`
   ⇒ `manifest unknown`；`docker ps -a | grep -i kk` ⇒ 无；`grep -c KKFILEVIEW deploy/.env` ⇒ 0
   ⇒ **现网点 `.docx` 其实没有预览**。
3. **#412 的 ③ 早被修成工单要的「映射」而非加挂载**（`deploy/fde-proxy/server.js:9`+`:278`），
   ④ 由 `portal/integration/lib/isolated-env.mjs:195`+`:220`（判据是「与共享 `.env` 逐条不相等」）承住；
   ①② 原样未动（`wp3b-e2e.mjs:83` 固定 `--env-file`、`:480` 仍 `fs.existsSync`）。
4. **#367 现验**：点名的会话 `9e0c8a17…` 在本机 `chat_sessions` 命中 **0**（全库 136 会话）
   ⇒ 那条 open 是**别台部署的存量**，不是本机待办。**#341**：引擎 0.31.0 读侧仍「`partOf` 只认首片」
   （`node_modules/erix-agent/src/store/message-rows.js:284-296`）⇒ 站内解链闸不许拆。
   **#303**：回退 `runner/worker.js:285` 仍在承重（盘上 34 行旧记录）。

**坑（我第一遍就踩了）**：数「还有没有 `w.emitted()`」**不能用 `grep -c 'emitted()'`** ——
实际写法是 `w.emitted('prefill')` 带实参，括号里非空 ⇒ 计数 0 ⇒ 我当场把 family A 误判成「已修」。
判据要按**调用形状**写（`grep -rn '\.emitted('`），并且任何「这条已交付」的结论最后都得落到
**跑一次退出码**（本批就是 `NODE_ENV=production` 那一跑把范围测全的）。

**剩下的 19 条 open 分桶**：真待做 #387 / #259 / #231 / #243 / #485 / #270 / #227（第 4 项）·
等拍 #348 / #346 / #331 / **#494** · 上游与别台 #341 / #367 / #426 · 挂账 #303 · 外部 #135 ·
新拆 #493 / #495 / #496。**「open 数」不是进度**：本批 20→19 只动了 1 格，但五张半开的单被拆清了。

### 8.120 用户「最后活动」列：一个语义缺口、两处写入点、十次变异（issue #497 / 工单 feat-261112-01，2026-11-12，worker 五个里程碑 + 主 agent 复验）

> **挑号**：落笔前现查 `grep -n '^### 8\.' docs/maintenance/task-ledger.md | tail -3` ⇒ 最大号 **8.119**，本条取 **8.120**。
> 结论性口径**不在本节**：字段语义在 `docs/data/model.md` §1.1，API 面在 `docs/api/portal.md` §12，
> 迁移自证在 `deploy/migrations/0031-user-last-activity-at.sql` 的文件头注释。本节只留过程与读数。

**治的是什么**：管理台此前只有 `last_login_at`（= `login_sessions` 里最新的 `created_at`，语义是「最近一次把门推开」）。
它答不出管理员真正想问的那句「**这个人还在用吗**」——页面刷新/重开会写它、自动续期会写它、一句话没说的人可以天天「登录」。
所以「活跃度」这一维此前是**缺的**，不是不准。人已拍板口径 **A3**：`users.last_activity_at` = 该用户
**按下发送那一刻**；刻意**不加第三处**写入点。**五个里程碑 · 七个提交**（分支 `feat-261112-01-user-last-activity-at`，写本节时未 push）：
`b7bc2c8` 迁移 0031 · `eab7216` model.md §1.1 · `70a8ab7` 后端两处写入点 + 15 条测试 ·
`05beaf8` 管理台那一格 + DOM/源码断言 · `e8e7326` 删孤儿键 `admin.fde.lastLogin` ·
`05beaf8` 之后的文档提交（§12 + §1.1 + 本段）与 **M5 那一枚**（补 e2e 抓到的副行 `:title` 回归 + 本段 M5 小节）
——它们的哈希写不进自己，现读 `git log --oneline main..HEAD`；
其中文档提交在本地 `--amend` 过几轮（补变异读数计数、拿掉写不进自己的那个哈希——不写死计数，这类自指每改一次就漂一次），**全程未 push**，所以 amend 不伤人。

**写入点全仓两处（现读坐标，M4 复核一字未动）**：`portal/src/sessions.js:597`（`postMessage`，本站唯一发送路）
与 `portal/src/queued-inputs.js:156`（`enqueueQueuedInput`）。两处都是同一句
`UPDATE users SET last_activity_at = now() WHERE id = $1`，都**在既有事务里用既有 `client`**（红线：消息回滚了活动位不许前进），
都**不节流**（人已拍板「一次输入写一次」）。管理台那一格：`AdminUsersView.vue` 第 8 格两行
（主行 `data-test="user-activity-main"` = 活动，副行 `user-login-sub` = `登录于 {time}`），**列数与列宽一字未动**（colgroup 9 / th 9 / 行内 td 9）。

**四个「看着该写、其实不许写」**（M2 变异 B 逐条钉死，见下表）：run 生命周期与终态、会话改名、归档、**登录本身**。
最后一条是这一列的立身之本：它**允许比 `last_login_at` 旧**——M4 现验 dev 库 9 个用户里**真有 2 个是这个形状**
（`last_activity_at < MAX(login_sessions.created_at)`）。读侧与界面都不许把这种「倒挂」当脏数据去「修正」。

**四个陷阱（全是实测，不是设想）**

1. **「一次输入恰好写一次」不显然**：`enqueueQueuedInput` 的直发分岔（`!activeRunId`，`queued-inputs.js:111`）
   **先 COMMIT 再转 `postMessage`**，所以它**不写**第 156 行那一处——两条分岔合起来恰好一次。
   断言必须按「**恰好一次**」写（`W-5`），只写「写过」就永远抓不到双写。
2. **源码级断言要先剥整行注释**：M2 变异 A 第一次跑**假绿**——把写入语句 `//` 掉之后，未剥注释的实现文本仍匹配得上。
   补上「剥掉整行 `//` 注释再匹配」才红。同理 M3 那条「那一格无硬编码中文」也要先剥 `<!-- -->` / `/* */` / 整行 `//`，
   否则中文注释会被当成硬编码文案。
3. **`node --test` 会收 `portal/test/` 下所有 `.js`**：共享桩文件（`portal/test/fake-user-activity.js`）里一旦写 `test(...)`
   就会被每个 importer 重复执行（同一批用例跑好几遍，读数全歪）。helper **只导出函数**，用例住在 `*.test.js` 里。
4. **删 i18n 键会顺手带走相邻的活键**（M4 本单实际踩的）：删 `admin.fde.lastLogin` 时把下一行 `neverLoggedIn`
   一起删了 ⇒ 前端 `npm test` rc=1（1 红）+ `npm run typecheck` rc=2（`TS2339: Property 'neverLoggedIn' does not exist` ×3）。
   两道门禁各抓一次，没有靠人眼。相邻两键一起删是这类清理的默认风险。

**真库核对（dev `station-db` / DB `station`，表在 `public` 而非同名 schema；M4 现验）**

- `information_schema.columns`：`nullable=YES` / `timestamp with time zone` / `default=(none)` ⇒ 可空与无默认值都是**现况**不是愿望。
- `pg_indexes`（`users`）只有 `users_pkey` + 4 枚 unique key ⇒ 本列**确实没有索引**（契约是「只作返回列」）。
- `schema_migrations`：`0031-user-last-activity-at` = `sha256:522c8c232228ed3cbc15c48c39e0f5d67c6ef015abc8a68830280842a286601b`，
  与盘上 `sha256sum deploy/migrations/0031-user-last-activity-at.sql` **逐字相同** ⇒ M3/M4 没偷偷回改已应用的迁移。
- 计数：`total=9 / 非空=5 / NULL=4`，与 M1 首次回填的读数一致（`NULL` 是真话，不是没跑回填）。
- 重放：把回填那条 UPDATE 放进 `BEGIN … ROLLBACK` 再跑一遍 ⇒ **`UPDATE 0`**（只动 `IS NULL` 的行，本迁移自己可重放）。
- 冻结 baseline `docs/data/schema.sql`：`git diff main..HEAD` **为空**（一字节未改；sha256 `461a35ee…de25a` 留作坐标）。

**变异实验（「断言可失败」的唯一证据；M1–M4 期间 8 次 = 我的 6 次 + 主 agent 独立 2 次；M5 另加 2 次见下一张小表；全部已复原）**

| 片 | 变异 | 读数 |
|---|---|---|
| M2-A | 注释掉两处写入点 | rc=1：`W-0b W-5 W-1 W-1b W-1c W-2 W-2b` **7 红**，四个反例 `W-3*` 仍绿 |
| M2-B | 在改名/归档/登录/run 状态四处**加写** | rc=1：`W-3 W-3b W-3c W-3d W-5` **5 红** |
| M3-C | 第 8 格退回旧单行 `formatLastLogin(last_login_at)` | rc=1：**3 红 / 71 绿**（2 条 DOM + 1 条源码锚） |
| M3-D | 只把表头键退回 `lastLogin` | rc=1：**4 红**（表头/列数锚 + 2 条 DOM） |
| M3-E | 空值渲染成「今天」 | rc=1：**3 红**（分层锚 + 2 条 DOM） |
| M3-类型 | 从夹具摘掉 `last_activity_at` | typecheck rc=2：`TS2741 … required in type 'AdminUser'` |
| 主 agent MUT-Y | `v-if="user.last_login_at"` → `v-if="true"` | rc=1：**恰好 3 红 / 71 绿** |
| 主 agent MUT-Z | 空值分支改成渲染 `new Date()` | rc=1：**恰好 3 红 / 71 绿** |

⚠ **方法学（主 agent 上的一条，我认）**：「红得多」不等于「钉得牢」。MUT-Y 第一次手滑把 `v-if` 换成 HTML 注释
塞进标签属性区 ⇒ 模板语法坏掉，**36 红雪崩**，那读数什么也不证明。只有「恰好 3 红 / 71 绿」这种**定向**读数才算证据。

**M5：真机 e2e 抓到一处本 PR 自己弄丢的回归（副行丢了 hover 全文）**

主 agent 换本地镜像 + playwright 真浏览器打 `#/admin/users`（console errors 0）看那一格，三种形态全在、
读数与库里逐字一致（`blind` 的活动 `10/12 3:57 PM` 确实比登录 `10/12 5:04 PM` **旧**，倒挂在真数据里成立）。
但截图里副行被列宽截断成 `Signed in 11/12/2026,…` 而 **hover 什么也给不出**：
旧形态是 `<td class="truncate …" :title="formatLastLogin(user.last_login_at)">` **整格有 title**，
M3 拆成两行时 `<td>` 的 title 随单元格重写一起消失了——主行 `span` 自己补了 `:title`，**副行漏了**。
⇒ 「看全文」是**既有能力**，被本 PR 丢掉就得由本 PR 补回（不是「既有瑕疵」，别当存量留着）。

- 修法：副行 `data-test="user-login-sub"` 那个 span 加
  `:title="t('admin.fde.loginAt', { time: formatLastLogin(user.last_login_at) })"` —— 与它自己显示的那句
  **同一个 `t()` 调用、同一个时间源 `last_login_at`**（不许拿活动时刻填，也不许只填裸时间让 hover 文案与显示文案漂）。
- 断言落点：DOM 层在 `portal/frontend/src/views/AdminView.spec.ts` 那条 `issue #497：第 8 格两行…` 用例里加 ④ 段
  —— 两行各自 `attributes('title')` 与**完整期望串**相等、且 `title === 该 span 自己的 text`（这就是「看全文」的定义），
  外加「副行 title 不许含活动时刻」；源码层在 `AdminUsersView.spec.ts` 的「两行结构」锚里钉
  「**两行都必须带 `:title`**」+「副行的 `t('admin.fde.loginAt'` 必须出现**两处**（title 与文本同形，不会各漂各的）」。
- 追加两次变异（**定向**，各 2 红 / 72 绿，不是雪崩）：

| 片 | 变异 | 读数 |
|---|---|---|
| M5-F | 去掉副行的 `:title`（正是 e2e 抓到的那个形状） | rc=1：**恰好 2 红 / 72 绿**（DOM `issue #497：第 8 格两行…` + 源码锚「两行结构」） |
| M5-G | 副行 `:title` 改拿**活动**时刻填 | rc=1：**恰好 2 红 / 72 绿**（`登录于 2026-11-11 09:32:38` ≠ `登录于 2026-10-3 20:00:00`） |

- M5 门禁：`env -u NODE_ENV timeout 300 npm test` rc=**0**（63 文件 / **1322** 例）、`timeout 300 npm run typecheck` rc=**0**；
  后端与文档未动。前端生产构建由主 agent 那次 `docker compose build` 顺带补上（`vite build ✓ built in 2.54s`）。
- ⚠ **教训（要落成判据，别只记在心里）**：把「一格」拆成「两行」时，**挂在外层元素上的 hover / 可访问性属性不会自己搬到子元素**。
  这类丢失 DOM 值断言看不见（文本还是对的），只有**真机看那一格**才暴露 ⇒ 改呈现形态的 PR，交付前要么真机看一眼，
  要么在断言里把「旧的 `title` / `aria-*` 还在不在」一起钉上（本单两种都做了）。

**门禁读数（最终树，M4 跑一次）**：仓库根 `npm test` rc=**0**（`tests 2155 / pass 2151 / fail 0 / skipped 4`）·
`portal/frontend` `timeout 300 npm test` rc=**0**（`Test Files 63 / Tests 1322`）· `timeout 300 npm run typecheck` rc=**0** ·
改动过的 js 逐个 `node --check` rc=**0**。前端门槛请一律 `env -u NODE_ENV`：这台 shell 的 `NODE_ENV=production` 是脏的
（不是项目设的），带着它 vitest 会走 production 分支、失败信号变钝（同一现象在 §8.119 也测到过）。
`npm run build` 本地不必跑：**质量门禁 job** 只有 ① `node --check` ② 根 `npm test` ③ runner `node --test`
④ 前端 `typecheck + vitest`（`.github/workflows/ci.yml:37`，④ 还显式 `NODE_ENV=development npm ci`），
生产构建由**镜像构建校验** job 覆盖（`portal/Dockerfile:9 RUN npm run build`）。

**遗留（交棒面）**

- **未 push、未开 PR**：push（带显式代理）、开 PR、真机 e2e（playwright + vision 看管理台那一格）、
  按 §6.1 亲审全量 diff 后合并，都由主 agent 做。分支 `feat-261112-01-user-last-activity-at`（`main@9f7b3c5` 上 5 个提交）。
- 孤儿键 `admin.fde.lastLogin` 已在 `e8e7326` **zh/en 成对删**；`AdminUsersView.spec.ts:174` 那条**反向**断言保留
  （键不存在时它照样成立，而且更严）。`neverLoggedIn` 保留——副行与清退日期两格仍在读它。
- **「入队即活动」是拍板口径，不是自然律**：若将来改成「投递成功才算」，那是**契约改动**
  （要动 `queued-inputs.js:156` 与 `W-2` / `W-2b` 两条断言），别顺手改。
- `admin.js#createUser` 的 RETURNING 里带 `last_activity_at` 是 M2 的**读侧诚实** additions（重激活旧行时界面要显示真实值），
  比工单原句多做了一点，主 agent 已收下（`git diff main..HEAD` 里可见）。

### 8.121 热层引用闸自己在 CI 连红：计数漏了「只数 git 跟踪的文件」（PR #498 附带修，2026-11-12，主 agent 定位根因 + worker 落地）

**现象**：PR #498 的 CI 红一条 `ledger-ref-floor: §8.N 引用 528 处 / 31 个文件，地板 596`。
**但它不是 #497（用户最后活动那一单）造成的**：`main` 上同一条已经连红三次（run 495 / 496 / 497，
`9f7b3c5` 那次读数是 **527 / 31**）。起点是 `07f9198`「逐单台账整体搬出热层 + 上热层预算闸」——
**闸上线那天，地板就是在脏树上量的**。

**根因（一句话）**：`scripts/agents-hotlayer-budget.mjs` 的 `countRefs()` / `refFiles()` 用
`grep -r --include=*.md .` 从仓库根往下数 ⇒ **被 `.gitignore` 忽略的本地过程产物也数了进去**
（`.gitignore:14` 的 `.work-orders/`、`:17` 的 `tasks/`，理论上还包括 `node_modules` 里的 md，
grep 不认识 `.gitignore`）。本机实测三种口径：

| 口径 | 引用 / 文件 |
|---|---|
| 脏树 `grep -r`（旧口径，本地 `npm test` 吃的就是它） | **610 / 53** ⇒ 本地**假绿** |
| 只数 git 跟踪的 `.md`（新口径） | **528 / 31** |
| CI 干净 checkout（同新口径） | **528 / 31** ⇒ 与上一行**逐字相同** |

差额来源可指到具体目录：`.work-orders/` 里 22 个含引用的 md 白送 **82 处**。而地板 596 是当年
`--sync` **在脏树上**写进 `scripts/agents-hotlayer-budget.json` 的 ⇒ 干净 checkout 上**永不满足**。

**教训（本片真正的产出）**：**闸自己变成了假绿发生器**。它数的是「我这台机器上此刻有什么」，
CI 数的是「仓库里有什么」；两者一旦不等，本地越跑越安心、CI 越跑越红，而且红得像是新 PR 的错
（#497 就是这么被牵连的）。所以：**判据口径必须来自跟踪态（`git ls-files`），不是「从仓库根 grep 一切」**；
并且**不许 hardcode 屏蔽目录名**——今天屏蔽 `.work-orders/`，明天冒出别的目录照样骗过去，
跟踪态则是一个不会腐烂的定义。

**改了什么**（`fix(hotlayer-gate)`，只动这条计数与它的重基线，其余检查项一字未动）

- `countRefs()` 与 `refFiles()` 合并成一次 `scanRefs()`：文件清单来自 `git ls-files -z -- '*.md'`（**索引/跟踪态**），
  内容按工作区读 ⇒ 改号/删引用当场可见，未跟踪与被忽略的一律不进读数；两个读数出自同一次扫描，不可能再各走一套口径。
- 那一行现在自带**测量口径**，并把排除掉的东西说出来：
  `…（口径：只数 git 跟踪的 .md；未跟踪/被忽略的 .md 里还有 22 个含引用、本来会白送 82 处，**没算进来**）`
  ——CI 干净树上是 0，尾巴自动消失；本地脏树才会露出来（这就是「遮丑当场可见」）。
- 新增 **`--rebaseline="<理由>"`**：只有它能**降**地板，理由（≥10 字）必填，没理由 rc=1 且**不碰登记表**；
  登记字段 `refFloorReason` / `refFloorMeasuredWith`（口径字符串）/ `refFloorTreeHead` / `refFloorTreeDirty`。
  `--sync` 仍然 `Math.max` ——**引用面只升不降**这条纪律没废；也正因如此别指望 sync 降历史高地板
  （实测：sync 把 596 原样保住，这就是「闸的红没法用脚本来收拾」的那一步）。sync 现在会保住重基线的原因与口径。
- 本次重基线：**596 → `529`**（`measuredRefs` 也是 529；`hotBytesBudget` 保持 19456 不动——重基线只管地板这一件事），理由是「旧地板在脏树上量得、含 82 处未跟踪引用；新值按 `git ls-files '*.md'` 现算」。

**反向自证（`test/agents-hotlayer.test.js`；夹具是 `/tmp` 下独立 `git init` 的小仓库，不动真树）**

1. 夹具基线 4 处 / 2 个文件；塞进一个**未跟踪** md（5 处）与一个 **gitignore 目录**里的 md（3 处）
   ⇒ 读数必须**一字不变**，且那一行必须说出「本来会白送 3 处」。**脏树不得遮丑**。
2. 删掉**跟踪** md 里的一处引用 ⇒ 读数 4→3、那一行 `RED`、rc≠0（**地板真拦得住改号/删引用**）；
   顺带钉：`--sync` 不降地板、`--rebaseline=`（空理由/一句话打发）被拒且不写文件、带理由才按现值重置
   并登记理由/口径/HEAD/脏净、重基线之后 sync 仍只抬不降且不许抹掉原因。
3. 另加一条**真树对账**：闸的读数必须等于测试自己用 `git ls-files` 独立重算的值，且那一行必须写着口径
   ——口径再漂一次就当场红。
   ⚠ 夹具必须跑**副本**脚本：`ROOT` 是从脚本自己的位置推出来的，跑仓库那份再改 `cwd` 也没用
   （worker 第一版就是这么错的：夹具数到真仓库的 528，两条夹具断言一起红，红得很像实现错了）。

**CI 等价证明（本片的真判据，不是「本地跑过就好」）**：`git clone` 本仓到 `/tmp` 下一个干净副本（**不在仓库里面**）
检出本分支跑 `node scripts/agents-hotlayer-budget.mjs` ⇒ `VERDICT ok`，读数
**`§8.N 引用 529 处 / 31 个文件，地板 529（口径：只数 git 跟踪的 .md）`**——干净树上没有脏文件，
所以那一行**不带**「本来会白送 N 处」的尾巴；主读数与本地「只数跟踪文件」的结果逐字相同
（本地脏树跑出来的同一行只多一句「还有 22 个含引用、本来会白送 82 处，**没算进来**」——
两种树的主读数一致、脏的部分被说出来而不是被算进去，这才是这条闸应有的样子）。

**门禁**：仓库根 `npm test` rc=**0**；`node scripts/agents-hotlayer-budget.mjs` 在**脏本地树**与**干净 clone** 两种树上各跑一次都 ok；
`git diff --check` 干净。前端本轮未动（没改任何被前端断言读的 md 引用）。
