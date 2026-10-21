# CI 与 GHCR 发布 runbook（issue #235）

> 面向：主 agent / 运维。覆盖 `.github/workflows/ci.yml`（质量门禁 + 镜像构建校验）与
> `.github/workflows/release.yml`（tag → GHCR 三镜像 + digest 清单）。
> 不替代：`docs/design/deploy-contract.md`（应该是什么样）、`docs/env.md`（参数口径）、
> `docs/ops/deployment-2026-10-10.md`（实际部署成了什么样）。
>
> 三条硬口径：**① 只用 `ubuntu-latest` 单一运行器（禁止 matrix）；② 镜像名全小写；
> ③ 推送关 provenance/sbom，digest 要能和部署机 `docker image inspect .Id` 对上。**

---

## 1. 触发口径表

| 触发 | 跑什么 | 预计分钟量级（Linux `$0.006/min`） |
|---|---|---|
| `pull_request` | 只跑门禁：语法保底 → 根测 → runner 测 → 前端 typecheck+test | 3–5 min（大头是 checkout/setup-node/三次 npm ci，测试本身 ~25s） |
| `push`（main） | 门禁 + **按路径过滤**的镜像构建校验（`--load`，**不推送**） | 门禁 3–5 min + portal 3–6 min / fde-proxy <1 min / **FDE 冷构建 10–15 min** |
| `push`（tag `v*`） | `release.yml`：版本校验 + 三镜像构建并推 GHCR + digest 清单 | 15–25 min（FDE 镜像体积大，推送占大头；GHCR 带宽目前免费） |
| `workflow_dispatch`（ci.yml） | 门禁；`build_images=all` 时追加三镜像构建校验 | 同上 |
| `workflow_dispatch`（release.yml） | 手填 `tag`，跑与 tag push 完全相同的发布流程 | 同上 |

**门禁步骤（顺序执行，任一失败即红；`ci.yml` 步骤 ①、①′、②–④）**

1. （步骤 ①）`node --check` 扫全部 git 跟踪的 `*.js` / `*.mjs`（当前 142 个文件，按 `git ls-files -- '*.js' '*.mjs'` 实测；
   仓库 `type: module`，`node --check` 会按 `package.json` 的 type 解析，ESM 文件实测 rc=0）。
2. （步骤 ①′）**运行身份诊断**：`id -u` / `id -g` / `id` / `uname -a`（无 `continue-on-error`、无 `if: always()`）。
   为什么要这一步：属主类断言的成败完全取决于 runner 进程的 uid/gid（见 §8 第 1 条），
   有这四行就不用再猜「今天的 runner 是谁」。
3. （步骤 ②）根 `npm ci` + `npm test` → **1369 项 / 1365 通过 / 0 失败 / 4 跳过**（**`#337` 引擎升级 erix-agent 0.22.0→0.23.0 + 读侧折叠 +28**（升级片：pin + 三处版本 tripwire（含任务单未点名的第三处 `terminationReasons.spec.ts`），产品行为零改动，`src/providers/**` 与 `src/loop/termination.js` 经 `diff -r` 逐字节相同、`termination.reason` 九值逐字未变 ⇒ 只追版本号；折叠片：新 `portal/src/transcript-fold.js`（单一真相源，`foldLedgerRecords` 与 `foldTranscriptRows` 共用同一份 `planFold`）+ 在 `projectSessionMessages` **咽喉点**接线（全站唯一消费点，源码护栏钉住）；新 `portal/test/transcript-fold.test.js` **+20**（15→16 支与上游真件 `node_modules/erix-agent/src/store/message-rows.js` 的 `foldMessageRows` **按文件路径逐字段对拍**（深路径 import 即 tripwire）+ 4 条行为钉：无消息行 ⇒ **返回入参本身（`===` 同一引用）** / 非数组原样返回 / 纯函数（入参零改写、载体是新对象）/ `keyOf` 缺省口径）；新 `portal/test/transcript-fold-wiring.test.js` **+5**（正反两个方向：该折的咽喉点必须折、预写面 `transcript-store.js` 的 `load` 与两个点查探针 + `session-text.js#fetchInputTextByMessageId` 单行点查**不得折**、折叠模块只有一个消费点）；新 `portal/test/session-view-fold.test.js` **+3**（**test-first**：真 0.23 `runToolLoop` 产出 → 按生产列形状（`run_id: null`）装行 → `projectSessionMessages`，修复前 `resultPreview`/`isError` 双 absent ⇒ 卡片退化成 `…`；修复后回来且 `toolCalls.length` **不新增重复**；旧 0.22 账本输出逐字节不变）。**主 agent 亲跑变异 4 条**：① 摘掉咽喉点接线 ⇒ **恰 1 条具名红**（真 0.23 账本那条，`resultPreview` 变回 `undefined`）；② 抹平轮号（`round → 0`）⇒ **6 条红**（分组与载体识别一起失效）；③ 先折再排 ⇒ **8 条全绿** ⇒ 先自证非空操作（双载体输入下本站与上游的载体归属都随输入序变）⇒ 定性「先排序再折」目前不承重，注释是意图声明不是契约；④ 拆掉 `partOf` 合并的 `messages.length === 1` 守卫 ⇒ **19 条全绿 = 真覆盖缺口**（上游 `message-rows.js:137` 有同一守卫但无 fixture 走这条判别支）⇒ **主 agent 自己补一支 fixture**（分片行带两条消息 ⇒ 不当分片、正文照排），补测后重放同一变异 ⇒ **恰 1 条红在新用例上**。`runner/` 与前端零字节 ⇒ runner 321、前端 36 文件/640 不变。；**`#333` 引擎升级 erix-agent 0.20.0→0.22.0 +49**（根 **1292 → 1341**、runner **311 → 321**、前端 **35 文件 / 601** 不变（基线由 #334 从 33/585 推上来，本单前端零改动）；新 helper `portal/test/fake-transcript-rounds.js`（**+1**：`**/test/**/*.js` 会把 helper 算成一项，§8.14 既有口径）= `transcript_rounds` 真库行为仿真（部分唯一索引 + `ON CONFLICT DO NOTHING` ⇒ 零行且 `rowCount 0`；缺 `ON CONFLICT` ⇒ 抛真库 23505 原文；撞键读回**真存的那条 record** 而非空；空表 `MAX(round)` ⇒ null），四处 fake 接上它（`llm` / `message-precheck` / `message-model-precheck` / `session-stop-queued`）——旧写法则 INSERT 一律「出行」、读回一律空 ⇒ **首次预写就伪报冲突**（`existingFingerprint=sha256:0000…`），升级当时 root 10 红；新 `portal/test/transcript-round-dedup-conflict.test.js` **+6**：internal 两条轮写入端点（U5 `putRound` 与引擎轮记录真通路 `putSessionRound`）的**行为级**幂等/冲突判别（只漂顶层 `ts`/`round` ⇒ 幂等且不新增行不覆盖；真换正文/数组换序 ⇒ `409 round_conflict` + 两份指纹 + `differingFields`）——⚠ **这两条方向此前都不红**（把 `samePayload(...)` 改永真或永假，`internal.test.js`+`transcript-store.test.js` 都是 98 通过 0 失败）= 真覆盖缺口，补测后变异才各红：**永真 ⇒ 3 条「该 409」红、永假 ⇒ 3 条「该幂等」红**；新 `portal/test/transcript-payload.test.js` **+15**：本站指纹实现与**上游真件** `erix-agent/src/store/transcript-dedup.js`（不在包 exports 面里，按文件路径 import 当 tripwire）**逐字对拍**：11 组 payload 对 + 循环引用 + 非对象叶子 + 差异字段名 + `recordKey` 三种回退；变异：排除表多塞一个字段 ⇒ **3 条红**；新 `portal/test/session-view-judge-control.test.js` **+6**：0.22 引擎控制文本（`meta.source === 'judge-control'`）不进取数面 + 钉死两条上游口径现状（投影给 **user** 角色的控制消息**另打 `synthetic:true`** ⇒ 界面正文本来就不漏；**assistant** 角色的 `meta.source` 会被投影**抹掉** ⇒ 宿主侧故意不加接不住的守卫）；变异：撤掉宿主守卫 ⇒ **恰 1 红**（诚实结论：它是冗余守卫，只在直接喂 turn 时承重）、改成**整行判** ⇒ **2 红**（含 forced-final 那条，证明「逐条判」是被钉住的）；新 `runner/test/judge-done-advisory.test.js` **+4**：**真 `runToolLoop`** 跑通 `judgeDoneAdvisory`（含 `false` 与「不传 = 上游缺省 false」两条对照组 + 「judge 确实被调到」前置；⚠ 必须走 **2 次**工具调用 —— 拦截门槛是 `count >= judgeIntervalRound` 且计数**从 0 起、不审计那次才 +1**，只走 1 次会退化成 end_turn 那条 judge 支路 ⇒ advisory 恒 0 的假绿形状）；余量为 M2 预写幂等用例与随包契约套件自身增长。；`#114` 部署面默认对齐 **+2**（新文件 `portal/test/deploy-env-defaults.test.js`：compose 里 `ERIX_SESSION_AUTO_TITLE` 的插值默认必须是 `0` + **双向一致性**（把 compose 默认喂进 `loadConfig` 必须等于不喂 env 的代码默认 ⇒「文档说默认关、部署面默认开」这种分叉从此有机器判据；此前那行 `-1` 出自 #88 修订 `125eae9`，#114 改代码默认时漏改 ⇒ 任何 compose 部署上「默认关」从未生效过）。**主 agent 亲跑变异：compose 默认改回 1 ⇒ 2 条全红**（两条判据方向都对）））；（`#322` 自动改名**接线**修复 **+3**（新文件 `portal/test/session-auto-title-wiring.test.js`：两跳接线的源码级锁（`http.js` ⇒ `setRunState` 必带 `config: ctx.config`；`finishRun` ⇒ `scheduleAutoTitle` 必带 `config`）+ 把真机 A/B 的后果本身钉住（config 缺网关键 ⇒ 请求打到 `http://127.0.0.1:4100/…` = 容器内 ECONNREFUSED 那个地址；带 `llmGatewayAdminUrl` ⇒ 打到它）。**主 agent 亲跑变异 2 条各恰 1 条红在对应那条**：撤掉 `scheduleAutoTitle` 的 `config`（= v0.1.20 缺陷原样复发）⇒ 红在跳②、`http.js` 漏传 ⇒ 红在跳①；真机取证：v0.1.20 上自动改名从来没真的调过模型，A/B 打在 portal 容器里 = `null`/79ms vs `助手能力与交付说明`/1472ms））；（基线，2026-10-20 本机在 `fix-261020-06-322` 分支（基点 `59172a1`）上由**主 agent 复跑**；`#322` **+1 净**（portal `session-title.test.js` **+10**：自动生成走 `title-llm.js`、输入折叠空白并截 500 字、降级①无活绑定⇒一次请求都不发、降级②网关 5xx/网络错/超时三种都静默降级绝不上抛、清洗口径与手工改名同源、上游回空文本不写空标题、`title` 字段兼容面（容器传了也不吃）、两把结构锁（不许在 `session-title.js` 手搓 fetch/超时/`max_tokens`/URL；portal 侧「发一次对话」只有一个构造点）；runner `session-title.test.js` **删 −9**（那份重复实现整体删除）⇒ 根净 +1、runner 320→311；**主 agent 亲跑变异 3 条全红在具名用例**：`catch` 里 `return null` 改 `throw err` ⇒ 恰 1 条具名红（降级②）；在 `session-title.js` 里另立 `max_tokens: 512` + `new AbortController()`（行为不变，纯结构）⇒ 恰 1 条红（结构锁）；把 `runner/lib/session-title.js` 复活 ⇒ 恰 1 条红（我改写的「单一真相」锁，断言该文件必须不存在）。⚠ **一条我自己做错的变异已重做**：第一次拿「手搓 fetch」当变异时改出了语法错 ⇒ 文件级失败（`pass 0`），那不是行为变异（AGENTS §8.24「没红要先证明变异不是空操作」的反面：**红了也要证明红是行为/结构造成的，不是文件没跑起来**）；另 `#315` 的跨路径锁随之**改写**（不是删）：值仍钉 512 + 手工与 auto 共用同一常量 + `runner/lib/session-title.js` 必须不存在；2026-10-20 `fix-261020-04-314-318-325`（基点 `63420f9`）口径：`#318`+`#325` **+5**（`portal/test/llm.test.js` 73→78：写侧 `CONTEXT_WINDOW_MIN = 65_536` 的边界三件套（`65536` 放行 / `65535` 与 `2048` 拒，POST 与 PATCH 各钉，`details={field,reason,min,value}` 与文案逐字段）+ **次序判据**（「窗口 1000 + 上限 500」必须报 `context_window/too_small` 而不是 `max_output_tokens` 的 1/4 上限错，两个入口都是）+ **#325 归一**（落到网关的是 number 而非调用方原值：`"262144"` ⇒ `262144`，含镜像的 `metadata.context_window` 与绑死双写的 `max_output_tokens`；真小数/0/负数/非数字串拒；**PATCH 没带的字段不做归一写回**）+ 既有 1/4 上限与 `TOKEN_FIXTURES` 用例一条没放宽（只把「只是分母」的窗口值搬到 ≥ 下限处，并同步 #318 改了 reason 的那一格）；**主 agent 亲跑变异 2 条全红在具名用例**：拆掉 `window < CONTEXT_WINDOW_MIN` ⇒ 2 条具名红、`model_info.context_window` 回写调用方原值 ⇒ 恰 1 条红（#325 那条）；**一处对工单的收窄（已核可）**：`context_window: null` 不当下限判据——它是新建表单「留空」的既有拼写，拒它会把「建一个没配窗口的模型」堵死；copilot 审计说「null 是非法值」查的是 `positiveIntOrNull()` 的形态面，与「这个字段允许表达没配」不冲突）；#315 追加 **+19**（新文件 `portal/test/llm-chat.test.js`，注入假 fetch、离线不打真模型：URL 两形态 / **请求体必带 `max_tokens` 且默认 512** / 超时到点必出 502 不悬挂 / 未配置 409 / 上游 5xx 502 / 返回值与错误文本不含明文 key / 以及「`portal/src` 里构造 `chat/completions` 的只有 `llm-chat.js`」这条收口不变量；**主 agent 亲跑变异 3 条**：只拿掉请求体字段 ⇒ 19 红、字段与发出前断言一起拿掉（= #315 病根本体）⇒ 3 红、超时不给终局 ⇒ 1 红）；`#315` **+1**（`portal/test/session-ai-title.test.js`：请求体必带 `max_tokens` + **跨路径锁**（读 `runner/lib/session-title.js` 比对 `maxTokens: 512`，改一边就红）；主 agent 亲跑变异 2 条全红在具名用例：删 `max_tokens` 那行 ⇒ 恰 1 红（请求形状那条）、只改门户的数 ⇒ 恰 1 红（跨路径那条）；本单 `runner/` 只改注释 ⇒ 前端与 runner 计数不变），`#316`+`#317` 元数据形态口径统一 **+10**（两侧镜像的同一张 `TOKEN_FIXTURES` 表：runner `llm-models.test.js` +6（`parseHeartbeatModels` 入口归一：数字串/整值浮点 ⇒ 正整数、真小数/`≤0`/`NaN`/`Infinity`/非数字串 ⇒ **整键不写**，并含**真 `runToolLoop` + 真 `computeBudget` 闸**的贯通用例：`context_window` 存成数字串 ⇒ 请求体带 `max_tokens` 且不发 `model_metadata_missing`）+ portal `llm.test.js` +3 / `llm-reconcile.test.js` +1（读侧生效值与**心跳下行取值**过同一条 `positiveIntOrNull()`）；另**收紧一支既有口径**：`floor(正数 ctx/4)` ⇒ `floor(正整数 ctx/4)`，真小数窗口不再算出回退值（与 runner 对齐；写侧 1/4 上限本身一字未动，只是它读窗口用的就是这条判据 ⇒ 真小数在写侧按「没窗口」拒，`reason:'context_window_missing'` 复用既有码，**零新错误码**）；**主 agent 亲跑变异 4 条全红在具名用例**（先证每只变异只改 1 行且行为真变）：runner 归一回退成「字符串一律丢」⇒ 3 红、两侧各自把真小数 floor 掉 ⇒ 各 4/2 红、心跳下行不归一 ⇒ 恰 1 红；另主 agent **否证了 worker 的一句证据**（「兼容历史上存成数字串的值 ⇒ 存量真的存在」——那句注释出自本批 `42cb24c` 自己，dev 现网 6 条 deployment 的 `context_window` 全是整数、零实例 ⇒ 改注释为「写侧不校验类型 ⇒ 结构上可存」，这条是隐患收口不是活故障））；`#309` 切片 2+2b **+28**（`runner/test/llm-models.test.js` 6→18：`parseHeartbeatModels` 两键**只收正整数**、非法形态**整键不写**（不是置 `undefined`）、无两键时 `JSON.stringify` 与改前**逐字节相同**（向后兼容面）、`resolveModelMetadata` 的 1/4 钳制与边界（正好等于 `floor(ctx/4)` **不算被钳**）、**2b 的上游闸注入** 3 条（桩闸抛 ⇒ 整对不传 / 不传 probe ⇒ 逐字节兼容 / **闸优先于「钳了」的结论**）；新建 `runner/test/model-metadata.test.js` 10：跑**真 `runToolLoop` + 内存 store + 桩 provider**，判据 = **桩收到的请求体里 `max_tokens` 等于生效值**（决策者要的「显式发」唯一可判证据）+ `model_metadata_missing` 出现/不出现判压缩开关 + `ctx=1001/2000/2666` 走真闸 ⇒ 无 `max_tokens` 键且 **run 不失败**（反证：硬塞 250 ⇒ `invalid_budget` 且零请求）+ 源码级两把锁（camelCase 三键只在 `#309:engine-model-params` 一处；`llm-models.js` 禁出现引擎公式常量 `2000`/`0.1` ⇒ 公式零复制，且 worker 必须注入第二入参）；**主 agent 亲跑变异 5 条全红在具名用例**：删 `maxTokens` 传参 ⇒ 5 红、钳制改原样透传 ⇒ 5 红（日志真出现 `invalid_budget`）、ctx 缺失支路硬塞 0 ⇒ 4 红、`parseHeartbeatModels` 不接收 ⇒ 4 红、worker 不注入闸 ⇒ 恰 1 红在源码级那条；⚠ **我审出来的洞**：1/4 钳制保不住小窗口（`ctx=2000⇒−500`、`2666⇒0`、`2667` 才活），堵法是调**包根导出的** `computeBudget({contextWindowTokens, maxOutputTokens})`（**不是**两个位置参数，且**不复制公式**），抛 ⇒ 整对不传 = 压缩关掉但 run 照活）；`#309` 切片 1.5 **+7**（`portal/test/llm.test.js` +5、`portal/test/llm-reconcile.test.js` +2：四级回退链逐支钉（`model_info` / `litellm_params.max_tokens` / `floor(ctx/4)` / `null`）、`floor` 边界（262144→65536、512111→128027、非 4 倍数取整、数字串）、窗口 `0`/负数/非数字 ⇒ **不得算出 `0`/`NaN` 下发**、**一致性**（回退算出的值再提交也合法 ⇒ 1/4 既是上限也是回退，平台不自打）、回退值**不落库**（读时算，不篡改数据面值）、行为变化（什么都没配的存量模型开始带两键）、`context_window` 未配 ⇒ **两键都不出现**（不是 `key: null`）、既有「不注入 gateway ⇒ 下行字节逐字节相同」兼容面未放宽；**主 agent 亲跑 3 条变异全红**：回退改回 `null` ⇒ 5 红、删 1/4 上限只留回退 ⇒ 3 红（含新增那条一致性用例）、心跳恒带键 ⇒ 4 红（含 3 条既有 reconcile `deepEqual`））；`#309` 切片 1 **+12**（`portal/test/llm.test.js` 55→63 + `portal/test/llm-reconcile.test.js` 25→29：模型新字段 `max_output_tokens` 的**读侧回退链**三支（只 `model_info` / 只 `litellm_params.max_tokens` / 都无 ⇒ `null` 不是 0）、**绑死双写**（两处同值、`null` 一起清、legacy `max_tokens` 同传时以绑定字段为准）、**硬上限 `floor(context_window/4)`** 的边界三件套（`floor(ctx/4)` 过 / `+1` 拒 / 远超拒，`details.max_allowed` 逐字段）与 `context_window` 缺失时拒（`reason:'context_window_missing'`，不放行「只改一半」）、心跳 `models.main` **只在非 null 时带键**（没值 ⇒ 整个键不出现，下行字节与 #309 前逐字节相同）+ 按**对账后新名**取同一个 deployment + **复用对账那一趟 `GET /model/info`**（不新增网关调用）；**主 agent 亲跑变异 4 条全红在具名用例上**：`floor(window/4)` 改成引擎临界 ⇒ 2 红、摘掉 `params.max_tokens` 跟随写 ⇒ 4 红、`!= null` 改 `!== undefined`（让 `null` 也写成键）⇒ 4 红（含 3 条既有 `deepEqual`）、改成按存量旧名取 ⇒ 恰 1 红；另主 agent **否证并改掉了 worker 写的成因**（它归给「LiteLLM 建 ChatOpenAI 抱 `output_config.budget_tokens`」—— 容器内 grep 实测 LiteLLM v1.103.2 只在 Anthropic/Bedrock 的 `thinking` 分支有 `budget_tokens`；真机制是引擎 `computeBudget()` 抛 `invalid_budget`，实测文案 `Computed context budget must be positive (got -71)`，`budget.js:23-25` + `orchestrator.js:1141-1148` 无 try/catch）；`#300` 中止/失败 run 的部分正文 **+17**（新文件 `portal/test/session-partial-output.test.js`，自带按 SQL 文本裁决的 `PartialOutputPool`：三判据各钉一条（终态 `finished`/`failed` × 三态非终态各一条 / 有锚点——含 `synthetic=true`——一条都不出现 / 空文本不合成）、正文按 delta `seq` **升序**拼接（夹具插入序与 seq 序故意相反，且 fake **只在 SQL 真写了 `ORDER BY run_id, seq` 时才排序**，否则就是「fake 好心兼平」§8.14）、上限 2000 + `truncated` 且载荷里不塞「已截断」文本、whole-run 聚合不受 `before` 窗口影响、**合成项不占 `limit` 且 `next_cursor`/`hasOlder` 与无合成项时逐字相同**、**成本红线两条字面判据**（窗口无 run ⇒ 三条额外查询都不发 / 有 run 但全有锚点 ⇒ 聚合那条一条都不发，用 fake 的 `sqlLog` 计数钉住）、脏片段不 `String()` 进来、跨 run 不串号；**主 agent 亲跑变异**：把成本红线的早退挪到候选查询之后 ⇒ 恰 1 条具名红；把合成项改成追加到末尾（不按 seq 归并）⇒ **17 条全绿 ⇒ 定性为「不是契约面」**：前端 `openSession` 会按 `seq` 重排，后端归并顺序不承重（归并位的判据在前端那条，见步骤 ④）；`#296` 管理台受管改名 **+10**：`portal/test/llm-reconcile.test.js` —— `call_name` 只写顶层 `model_name` 不碰 `model_info`、`call_name`/`name` 同一条 PATCH 各写各的位置、同名撞车 409 `model_name_conflict`（**实测 LiteLLM 自己不拦同名**，两个 deployment 都返 200，所以拦在门户）、**端到端**：PATCH `call_name` ⇒ 顶层名落网关 + 立刻铺**新旧名并集**并回写 bindings（这条是 §8.25 心跳对账的立即触发版，复用同一函数、传 `ctx.llmGateway` 单例）；`#299` 引擎升级 0.18.0→0.19.0→0.20.0 **+39**`#299` 引擎升级 0.18.0→0.19.0→0.20.0 **+39**：`portal/test/engine-error-code-contract.test.js` +4（真调包里的 `classifyHttpError` ⇒ 喂 `buildFailureEnvelope` ⇒ 钉「0.19 的 4xx 新码 `invalid_request`/`not_found`/`conflict` **都不进可重试集合**、我们的 `error.retryable` 逐条不变）、`runner/test/tool-result-envelope-contract.test.js` +34（**新接入随包 `toolResultEnvelopeContract` 27 条** + 我们 7 条：防回装源码级与行为级、退役顶层键不得出现、墙钟回拨不造负时长）、`portal/test/engine-upgrade-299.test.js` +3（三条可执行判据：前端不引该包 / 四形态表在册 / **四套契约套件接入面在册**——拆掉任一套件接入就红，主 agent 亲测）、`portal/test/session-view.test.js` +4（时长优先级 投影>宿主>无键 的三支 + 老记录支路）；另有**上游套件自身随包增长**计入（`fileToolsContract` 28→31）与**删掉的 `runner/test/tool-duration.test.js` −9**（#283 临时计时闸已撤）；`#289` 切片 B2 **+11**`#289` 切片 B2 **+11**（新文件 `portal/test/message-model-precheck.test.js`：发消息路径按 `model_info.id` fail-fast ⇒ `409 llm_model_not_found` + `details {slot, model_id}` + `retryable:true`；**失败面干净**——不写 transcript、不入队 run、不占幂等位，改配后同 key 重试 202；三种放行 = 无活绑定 / 已配置 id 全命中 / **网关不可达 fail-open + 一条 warn**；**只读**断言全程零 INSERT/UPDATE/零 `updateKey`；**必须复用 `ctx.llmGateway` 单例**（同 client 两次发消息只打一次 `/model/info`）；主 agent 亲跑变异 2 条全红在具名用例：`retryable` 不透传 ⇒ 恰 1 红 / 传一个非单例的网关对象 ⇒ 5 红（fail-open 把 409 吃掉了）；worker 另跑 3 条：删整段预检 6 红 / 网关不可达改 fail-closed 2 红 / 预检挪到写 transcript 之后 1 红）；`#289` 切片 A+B1 **+15**（`portal/test/llm-reconcile.test.js``#289` 心跳模型名对账 **+15**（新文件 `portal/test/llm-reconcile.test.js`：切片 A 10 + 切片 B1 5——顺序红线「**先 `/key/update` 把白名单扩成新旧名并存，后回写 `fde_llm_bindings`**」/ TTL(60s) 命中与过期两向 / 无漂移零写 / `updateKey` 抛错 ⇒ 整笔不做 / id 未知只 warn / 网关不可达保守放行 / **`binding_update_failed` 分支**（主 agent 亲跑变异发现切片 A 漏钉：`return effective` 改 `throw` 曾全绿）/ 兼容面「不传 gateway ⇒ 完全跳过对账」（`llm.test.js` 5 处旧调用零改动仍绿）/ **端到端反休眠接线用例**：真 `createServer` + `POST /api/internal/heartbeat` ⇒ 断言两跳 `listModels` 只打一次（= 传的是 `ctx.llmGateway` 单例，缓存按 client 身份分槽）+ 下行用新名；主 agent 亲跑变异 3 条全红在具名用例上：`http.js` 把 `llmGateway` 传成 `null` ⇒ 恰 1 条红（端到端那条，即「以后有人拆回休眠会被抓」）/ 代码里 reason 字面量改名 ⇒ 恰 1 条红（文档 §9.5 逐字列的 reason 被间接钉住）/ 切片 A 的 `binding_update_failed` 改成上抛 ⇒ 补测后恰 1 红；worker 另跑 6 条（顺序反转、白名单只发新名 3 红、TTL 两向写死各 1 红、删接线 1 红、`Object.assign({},gw)` 造新对象身份 ⇒ 红在「两跳只打一次网关」的计数上）；`#292` reaper 合成 `attempt_killed` **+9**（全部并入既有文件 `portal/test/internal-attempt-killed.test.js` 12→21，无新测试文件：恰一条 + 载荷逐字段 deepEqual 且**断言 `silent_ms` 键不存在** / `allocSeq` 承重 / INSERT 必须落在 `BEGIN…COMMIT` 窗口内 / 重复轮次仍恰一条且**不重复推 SSE** / 幂等键必须带 `:<attempt>`（第 2 次尝试再死必须再来一条）/ cancelling 与「租约未过期」零事件 / 耗尽分支 `error.code` 逐字不变 + additive `last_reason` 且**不带** `last_silent_ms` / `failCommitOnce` 下事件与 seq 与队列改写一起作废；⚠ `portal/test/fake-internal-pool.js` 的事务撤销面由「只 `run_events` + `allocSeq`」**收紧**到含 `run_queue`/`runs` 的字面量状态改写（真库同事务语义，AGENTS §8.14 方向是收紧不是放宽）；主 agent 亲跑变异 3 条全红在具名用例上：`killed_by` 改成 `watchdog` ⇒ 恰 1 红、去掉 `last_reason` ⇒ 恰 1 红、**把 SSE 推送挪到 `COMMIT` 之前 ⇒ 2 红**（「先落库后推送」的顺序是被钉住的）；worker 另跑 6 条：去 `ON CONFLICT` ⇒ 抛真库 23505 原文、幂等键去 `:<attempt>` ⇒ 2 红、INSERT 挪 COMMIT 后（粗粒度 3 红 / 精确变体恰 1 红）、硬塞 `silent_ms:0` ⇒ 2 红、去 SSE 门 ⇒ 恰 1 红、改 `error.code` ⇒ 恰 1 红）；`#288` watchdog 误杀·静默重排·盲目重放四缺陷 A/B/C/D **+45**：runner **+28**（新 `runner/test/shell-liveness.test.js` 21：心跳与**工具返回正文逐字不变**、pgid 登记与销账、「**先杀 `-workerPid` 再杀登记的每个 `-pgid`**」的真实顺序、「SIGKILL 下 worker 跑不了 `exit` handler」的**真进程**前提、启动不变式与 env 非法值回落；新 `runner/test/replay-policy.test.js` 7：跑真 `runToolLoop`，判据 = 「resume 期 executor 有没有收到那个挂起 `call_id`」——⚠ **不能用调用次数**，不重放时模型会自己再要一次、次数相同；另含 `always-replay` 反面对照与「`replay` 不渗进模型可见定义」的提示词零漂移）+ portal **+17**（新 `portal/test/internal-attempt-killed.test.js` 12：同事务时序、`allocSeq` 承重、幂等恰一条、「没真插入行就不许多推 SSE」、COMMIT 失败不留孤儿、`silent_ms` 不得拿 0 冒充、终态 additive `last_reason`/`last_silent_ms`、cancelling 分支不受影响；新 `internal-replay-decision.test.js` 3（含跨层钉「三处集合与文档同源」）；`session-events-history.test.js` +2（两个新事件可回放且 payload 原样）——⚠ `fake-internal-pool.js` 再度真库化：`run_events` 的 `UNIQUE(run_id,client_event_id)`/`UNIQUE(session_id,seq)`/`payload NOT NULL` 改为按 SQL 文本裁决（没写 `ON CONFLICT` 就抛真 23505/23502），并**只为 run_events 建事务撤销日志**（`COMMIT` 才落库、`ROLLBACK` 连 `allocSeq` 一起回滚）⇒「同事务」第一次可断言；**主 agent 亲跑变异**：幂等键去掉 `:<attempt>` ⇒ 恰 1 条红、`silent_ms` 守卫改 `?? 0` ⇒ 恰 1 条红、前端回放集合单独摘 ⇒ 恰 1 条红、`replayPolicy` 改成 `always-replay` ⇒ 2 条具名红、删 `loopEventPayload` 新 case ⇒ 1 条红；另亲验真库确有 `UNIQUE (run_id, client_event_id)` **普通约束** ⇒ `ON CONFLICT` 目标在真 PG 成立，不是只骗过 fake）；`#283` 工具时长 **+22**：runner **+9**（新文件 `runner/test/tool-duration.test.js`：装配层适配器「非结构化返回 ⇒ 引擎写时长」+ 包装前后**模型看到的正文逐字节相同**（拿真 `runToolLoop` + 桩 provider 逐形态钉 string/number/0/boolean/裸对象/数组/null/undefined）+ `loopEventPayload` 的 `duration_ms` 有时长⇒有限数、没时长⇒`null` 绝不伪装成 0 + **上游缺口哨兵**「不包 ⇒ 引擎给不出 duration」，erix-agent #285 落地升版后该文件与适配器一起删）+ portal **+13**（`portal/test/internal.test.js` +8：同批写入 / 顺序陷阱 / 跨批 / 重复投递 / 空值不擦写 / 行缺失 0 行 / digest 逐字一致 / NULL 与无键跳过；`portal/test/session-view.test.js` +5：有值才出现 `durationMs`、NULL 与无行 ⇒ DTO 与旧形状**逐字相同**、join 发生在投影**之后**（直接问引擎要形状反证）、`(run_id, call_id)` 不串号、经 `getSession` 端到端且 `includeMessages=false` 不多查一次）；⚠ 本单**改了两处 fake 的行为强度**（AGENTS §8.14 口径）：`fake-internal-pool.js` 的 `tool_calls` 分支真模拟 `UNIQUE(run_id,call_id)`+`ON CONFLICT DO NOTHING`+`call_id NOT NULL`+**从 SQL 文本解析 `IS NULL` 谓词**，`SessionViewPool` 的 `FROM tool_calls` 分支按 SQL 文本真筛 ⇒ 变异取证（主 agent 亲跑，不复用 worker 的）：把 `tool_result` 段挪到 `tool_use` 段之前 ⇒ `internal.test.js` rc=1、**5 条红**（含具名的顺序陷阱那条）；DTO 给缺失值写 `durationMs: 0` ⇒ rc=1、**恰好 1 条红**；前端改成投影无条件覆盖实时 `dur` ⇒ rc=1、**恰好 1 条红**；`#285` 预览告知第 8 条 **+0**：第 8 条的锚点断言**并入既有用例** `portal/test/materializer.test.js`「预览访问节把 8 条要求链逐条写清」（照 #262 先例），双向禁词集 6→8 在 `runner/test/system-prompt.test.js` 同一条用例内扩词 ⇒ 两处**计数均不变**（根 1036 / runner 221），已实测变异取证：删第 8 条 ⇒ 2 条具名用例红（materializer 的条数断言 + 防漂移的反向断言），把第 8 条抄进提示词 ⇒ 1 条红（防漂移），删「回指第 6 条」⇒ 1 条红（⑧ 的锚点）；`#255` 收尾 `confirm_password` **+5**（`portal/test/must-change-password.test.js` 28→33：带了且相等仍 200、带了不等 400+`details.field`、**完全没带仍 200（不得变必填）**、旧口令错误响应逐字节不变、不参与限流计数）；`#280` 迁移身份 **+9**：`portal/test/migrate-role.test.js` 6 条（`SET ROLE` 落点在 bootstrap 之后 / 已是该角色 ⇒ 一条角色语句都不发 / 成功与异常两条路径都 `RESET ROLE` 且早于 unlock 与 release / fail-fast 不静默跳过）+ 新文件 `portal/test/migrate-fresh-db.test.js` 3 条**真库**用例（空库→baseline→bootstrap→全部增量以超级用户跑通到 head、compose 形态幂等且零角色语句、无权限角色 fail-fast）——⚠ **这 3 条在无 `TEST_DATABASE_URL` 时整体 skip，所以跳过数从 1 变 4；本机实跑（一次性 postgres:16）为 3/3 绿**；`#277-A`+`#277-A2` 被停止的 queued run 直接终态 **+17**，全在新文件 `portal/test/session-stop-queued.test.js`：第一步 queued→finished/aborted+出队+会话解锁 9 项，A2 的「已领走未写 running 落 cancelling」守卫 4 项与「同事务合成 `run_end`」4 项（含重复停止只一条、与 runs 终态同事务的源码级断言）；`#255` 强制首登改密后端片 **+29**：新文件 `portal/test/must-change-password.test.js` 28 项（迁移语义 / 代设口令置旗标 / `POST /api/me/password` / 受限会话门与 9 条放行清单 / 登录响应 `password_change_required` / 文档防漂移）+ `portal/test/migrations.test.js` 0021 断言 1 项；`#275` 预览 released 历史行遮蔽活行的 **+7**，全在 `portal/test/preview.test.js`：同 hostname 遮蔽回归 2 + 契约锁 3（只有 released 行仍 403 / `released_at` 同值靠 `id` 成全序 / 查不到 404）+ fake 自证部分唯一索引 1 + 源码级护栏 1；
   原 945/944 基线上新增 `#234`（工单 `feat-261013-01`，跨站写请求防线 Origin / `Sec-Fetch-Site` 同源校验）的 **24 项**（同分支返修 +2，见下）：
   全部在新文件 `portal/test/csrf-origin.test.js`（13 项纯判据：`checkSameOrigin` / `csrfGateFor` 的 a/b/c/d 四支 +
   **返修回归门：`same-site` 不得直接放行、必落 Origin 比对** +
   默认端口/非默认端口归一化 + IPv6 + `X-Forwarded-Host` 优先级 + 畸形 Origin + 豁免端点；
   11 项 HTTP 层：issue 明写的「跨站 POST 带 cookie ⇒ 403 `cross_origin_forbidden`」并断言**拒绝发生在副作用之前**、
   同源 200、无 Origin 放行、`cross-site` 无 Origin 拒、`same-origin` 无 Origin 放行、
   **预览 host 带 `same-site` 写 portal API ⇒ 403（返修回归门，带两个放行对照：Origin 相等 / Origin 缺失）**、
   GET/SSE/HEAD/OPTIONS 不受影响、
   `/api/internal/*` 与 `/api/forward-auth` 豁免、dev `:8090` 形态端口匹配与不同端口拒绝、畸形 Origin 在 HTTP 层就拒、
   拒绝响应带 ACAO/ACAC/Vary 且状态码仍 403、审计 `auth.csrf_denied` 的 details/target/失败不阻断）。
   变异自证（各自只红相关处）：删掉 `cross-site` 分支 ⇒ 4 红；Origin「解析失败即放行」⇒ 3 红；端口一律丢掉 ⇒ 5 红；
   **返修后另两枚（本单）：删掉判据 b 的 `same-origin` ⇒ 1 红（证 b 未成空壳）；把 `same-site` 短路回直接放行
   ⇒ 只有新增的两枚回归门红（纯判据 + HTTP 层），其余 22 全绿——钉住「同注册域不同 origin 被洗白」这个缺陷本体。**
   （返修前本行为 **967/966（22 项 = 12 纯 + 10 HTTP）**：`same-site` 直接放行的缺陷修掉后，原「判据 b：`same-site`
   放行」那枚按新口径改写为「落 Origin 比对后的三种结局」（不删除），并新增纯判据与 HTTP 层各 1 枚回归门 ⇒ +2。）
   原 926/925 基线上新增 `#261`（runner 显式 LLM 三相超时）的 **19 项**：
   `runner/test/llm-timeouts.test.js` +19（helper env 解析 / **回归门：`explicitPhase=true` 且 `legacyTimeoutMs=undefined`**
   ——钉的是「关掉引擎 legacy 120s 总闸」这个机制本身，对照组钉「`timeoutMs:900000` 这种直觉修法根本不关闸」/
   虚拟时钟行为门（legacy 有 chunk 回流仍被杀 vs 四相全活）/ `0`·`false`·`Infinity` 三个秒死陷阱实测钉 /
   worker 源码级钉 + docs/env.md 文档钉）；
   原 920/919 基线上新增 `#257 + #258`（工单 `feat-261012-01`，告知面单一真相落 `~/AGENTS.md`）的 **6 项**：
   `portal/test/materializer.test.js` +4（预览访问 6 条逐条锚点 / 错误形态对照 / 红线：零端口数字与区间、
   零伞域字面量 / `isPlatformManagedPath` 认 home 级 `AGENTS.md` 是平台文件）、
   `runner/test/system-prompt.test.js` +2（强制指针：措辞必须「先读」且同段自带 shell 读法 /
   单一来源防漂移：提示词里不得出现 `allowedHosts`·`credentials`·`CORS` 三个具体规则词，并反向断言它们必须在
   单一真相里）；同文件另**只加不减地扩了既有断言**（端口红线从「数字+区间」扩到按形状禁任何多段域名字面量）。
   再往前：原 910/909 基线上新增 `#252`（工单 `fix-261011-B`）撤预览 grant 只撤 `active` 的 **10 项**：
   `portal/test/preview-ports.test.js` +3（只撤 active / 谓词源码断言 / fake 真会拦 23514）、
   `portal/test/offboarding.test.js` +5（只撤 active / **重试路径** / 撤 0 行 / 旧谓词 23514 / 整笔回滚）、
   `portal/test/migrations.test.js` +1（0020 静态断言）、`portal/test/preview-grant-checks.js` +1
   （**这是 fake 共用的 CHECK 规则文件，本身没有用例**——见下面的发现规则，`test/` 目录下的每个 `.js` 都占 1 项，
   `fake-pool.js` 那三个 helper 同理，别把它当成一条真用例）；
   再往前是 `#246 交付②` 预览端口列端点与管理员改块的 21 项（`portal/test/preview-ports.test.js`）、
   `#246` 交付① 预分配号池块的 15 项（`portal/test/portalloc.test.js` 与 `portal/test/{migrations,materializer}.test.js`）
   与 `#241` 预览预检与 deny CORS 的 7 条。
   ⚠️ 根 `node --test` 的发现规则会把 `runner/test/*.test.js` 一起收进来 ⇒ **当前 1369 里已含 runner 的 321 项**（`#333` 起 **311→321** = `judge-done-advisory` 4 + IPC peer 复用上游指纹的既有用例改写与随包套件增长；`#316` **+6**（入口归一 + 贯通真环）；`#309` 切片 2+2b **+28**：`llm-models.test.js` 6→18 + 新建 `model-metadata.test.js` 10，逐项见上；`#299`：+28 = 新接的随包信封契约 27 + 防回装/退役键/墙钟等 7 − 删掉的 `tool-duration` 9 + 上游 fileTools +2 等，逐项见上）。
   ⚠️ 同一条发现规则（`**/test/**/*.js`）也会把 `portal/test/` 下的**非用例 helper**算成 1 项 ⇒ 净增用例数
   要按上面的拆解核对，别只看总数（实测：在 `portal/test/` 放一个空的 `x.js`，总数立刻 +1）。
4. （步骤 ③）`cd runner && npm ci && node --test` → **221/221**（#261 新增 19 项 `runner/test/llm-timeouts.test.js`；
   再往前 #257+#258 新增 2 项在 `runner/test/system-prompt.test.js`，那之前是 200/200）。口径见 `AGENTS.md` §4：
   **`node --test runner/test/`（目录当参数）在本机 Node 22/24 是坏的**（把目录当模块加载 → `Cannot find module`），别用。
5. （步骤 ④）`cd portal/frontend && NODE_ENV=development npm ci && npm run typecheck && npm test` → typecheck 干净 + **36 文件 / 640 通过**（`feat-261021-03` 前端三修 **#279 + #306 + #281 共 +39**（文件 35→36；零后端、零 runner、零 DDL）：**#279 +22** —— 新 `lib/toolCardKey.ts` 当**卡片身份的唯一构造点**（身份 = `<run_id>:<round>:<call_id>`；缺轮次用 `?`，**不伪装成第 0 轮**；投影侧轮次从上游 `key` 首段 `<round>#…` 取 ⇒ 与实时同源；关联索引 `callId → 最近一张卡` 只用于投递 `tool_result`、**不参与身份**），`useEventStream` 的 `ensureCard` 加 round 参数并从带轮次的事件（`round_start`/`tool_start`/`tool_input_delta`/`judge`/`final_guard`/`forced_final`/`extend`）观察轮次，`workbench.ts` 的 DTO 投影两处改走该函数（`turnKeys` 按索引取、越界 `?`）并把 `attempt`/`replayPending`/`intercepted` 三处改成**按身份精确匹配** + **跨 run 守卫**（实时 `runId` 与载荷 `run_id` 都在且不等 ⇒ 不跨 run 打标），`openSession` 把 `item.run_id` 透进 `replayEvent`（此前历史重放只给 `liveRunId ?? item.run_id` 而 `liveRunId` 恒 `''` ⇒ 归属信息在入口就丢了）；**#306 +10** —— `handleRunEnd` 在 `termination.reason ∈ RUN_FAIL_REASONS`（`aborted` 也在集合内）时**补拉一次 history**（`limit=500`），只喂 `partial_output` 进既有的幂等 `addPartialOutput`（id `partial:<run_id>`），**不重放 `judge`/`round_start`/`attempt_killed` 等非幂等事件**；三重竞态守卫（`sessionReqSeq`/`ctxSeq`/`sessionId`）；补拉失败静默（不能把终态处理弄失败）；**成功终态一个额外请求都不发**（成本红线）；**#281 +6**（另 2 个 locale 键）—— `WorkbenchView.onMounted` 两个 await 自己收尾：`openSession` 失败 ⇒ `addSyserr` 双语新键 `errors.workspaceLoadFailed`（服务端 message 过 `toDisplayText`，不 `[object Object]`）+ 回 `loadSessions()` 不白屏；`resolveRouteSession` 失败 ⇒ 清锚点 + 回工作台；两条路都不再产生未捕获拒绝、`onMounted` 永不抛；顺带修一处静默失败（切换项目时 `selectCwd` 失败原先只 console 一下、界面还显示**旧项目**的会话 ⇒ 现在也报一行）。**主 agent 亲跑变异 3 条全红在具名用例**：身份退回裸 `callId` ⇒ 一批具名红（跳轮复用 / 跳 run / 结果关联 / 实时-投影同一身份）；补拉改成无条件 ⇒ 具名成本红线红（成功终态零补拉那条）；投影轮次恒 `?` ⇒ 「实时与投影产出同一身份」那条红。**真机**（本地构建 portal 镜像顶掉 digest pin 实跑，验完还原）：#306 点「■ Stop」后 **1 秒内**部分正文就出现、**全程未刷新**，稳定 1 条，硬刷新后仍**恰好 1 条**（不重复）；#279 现跑一条三工具任务，实时卡片名字与时长各自正确（`🔧 writeFile p279.txt ✓ 2ms`、`🔧 readFile p279.txt ✓ 3ms`）且**硬刷新前后逐字一致**（36 张卡、`byName` 完全相同）、无 `undefined`/`[object Object]`/`NaN`；#281 深链一个不存在的会话 ⇒ 重定向回 `#/`、**零未捕获拒绝**、不白屏）；`#334` **+16**（前端准入闸：新增 `lib/workbenchGate.spec.ts`（三类人真值表 + 空串 `fde_name`）与 `views/SeatlessAdminGate.spec.ts`（零请求 + 反向对照）、`router.spec.ts` +4 守卫接线；**删 2 条变不可达的用例**（无工位管理员已进不到工作台 ⇒ 「灰条 + 禁用钮 + 按钮切换」与「disabled ⇒ 不给点」两条不再可达）⇒ 文件 33→35、净 +16；**主 agent 亲跑变异 2 条全红在具名用例**：注释掉 `router.ts` 守卫那两行 ⇒ 4 红（含深链那条与两条零请求）、判据删掉 `!fde_name` ⇒ 6 红（含「第②类人（admin + 有工位）→ 照常放行」）；⚠ 执行体**抱出上一手虚报的测试**：`router.spec.ts` 当时未改 ⇒ 摘掉守卫一条不红、注释引用的 `SeatlessAdminGate.spec.ts` 当时不存在 ⇒ 均已补；**本单 `portal/src/` 与 `runner/` 零文件 ⇒ 根 1292 / runner 311 计数不变**）；`#314` **+3**（`AdminView.spec.ts`：「按当前窗口 1/4 重设」**只填值不提交**（点它之后 PATCH 数为 0，点保存才发且 PATCH 形状对）、没填窗口 ⇒ 按钮禁用（不拿 null 算出一个数）、编辑态「留空 = 不修改」的口径文案落到位；**前端不复制服务端的数字校验**（65536 与 1/4 只有 `portal/src/llm.js` 一处真相源）；**主 agent 亲跑变异**：把重设按钮改成顺手提交 ⇒ 恰 1 条红（「PATCH 数为 0」那条））；`#321` **+10**（`useEventStream.spec` +6 / `StreamPanel.spec` +3 / `localeParity.spec` +1：judge 事件四轴独立呈现、`executed` 不再暗示任务完成；主 agent 在合并树 `cc8db70` 复跑 582/582，本单前端零改动 ⇒ 计数不变）；`#309` 切片 1.5 **+1**（`AdminView.spec.ts`：**显示的就是生效值**——夹具故意只给 `context_window` 不给输出上限，断言渲染出 `65536` 且**前端不出现自己的 `/ 4` 表达式** ⇒ 只有一个计算点；其余改动是标识符/文案层（拆掉 `Budget` 拼写、legacy 字段回到 `colMaxTokens`/`editMaxTokensHint`，两份 locale 同步）；主 agent 亲跑变异「回退改回 null」⇒ 该用例红）；`#309` 切片 1 **+2**（`AdminView.spec.ts`：列表渲染输出预算上限（没配则占位符）、新增表单带 1/4 提示且**照发越界值**（前端不做本地数字校验，服务端是唯一判据）、编辑回填现值含 `??` 回退、PATCH 带 `model_info` 全量字段、服务端超限文案**原样显示在页面上**）；`#300` **+17**：`stores/workbench.spec.ts` +10（**归并落点**：合成项排在 seq 归并位上 / **绝不喂 `es.replayEvent`** / `truncated` 透传不由 store 拼文案 / 同 run 有锚点不重复 / 脏载荷 4 例 / `renderedIds` 幂等 / `run_id` 缺失退化）、`components/StreamPanel.spec.ts` +4（zh 与 en 各一条：标签 + 正文走助手 markdown 且**类名不含 `syserr`**、截断提示双语成对、标签不得混进正文）、`composables/useEventStream.spec.ts` +2（`partial_output` **不在 `EVENT_TYPES`** ⇒ EventSource 没挂监听；`replayEvent` 收到它零副作用）、`i18n/localeParity.spec.ts` +1（钉**语义**：不得说「完成/错误」）；**主 agent 亲跑变异**：store 分流条件改永假 ⇒ **5 条具名红**；`truncated` 判定由 `=== true` 改 `!= null` ⇒ 恰 1 条红。⚠ 已知**不承重**的一处：把 `partial_output` 加进 `HISTORY_REPLAY_TYPES` 无测试会红（`replayEvent` 无该分支 ⇒ 落 `default` 中性忽略，「加了也看不见」），真正的防线是 store 侧不喂（上面那条变异）；`#296` **+6**：`AdminView.spec.ts` —— 改调用名先出确认且**确认前一个 PATCH 都不发**、确认后 PATCH 同时带 `call_name` 与 `name`、取消则零请求、列表两列都在（调用名是操作面）、留空不回退成旧名、i18n 双语成对；**主 agent 亲跑变异**：把确认门改成直接提交 ⇒ 恰 2 条红。`#299` **+6**：`useEventStream.spec` +4（`erix.executionStatus` 只在 `intercepted`/`interrupted` 存在 ⇒ 非特殊值不得仅凭「字段在」判成有结果、普通块不写伪键）、`StreamPanel.spec` +2（**主 agent 亲跑变异发现的缺口**：把存在性判据塞回 `cardOut()` 曾 29 条全绿 ⇒ 补「六支非特殊值夹具（含空串与上游未来可能多写的未知取值）不进展开区、不留空 ` · `」+「`interrupted`/`intercepted` 必须渲染」，补测后同一变异恰 1 红））；`#289` 切片 B2 **+7**：`forcePasswordErrors.spec` +4（新错误码 `llm_model_not_found` 进映射表、双语成对且不同串、param-free 无占位符残渣、脏 `details`/`message` 不退化成 `[object Object]`）、`workbench.spec` +3（发送失败专用文案带**槽位与模型 id**、脏 `details` 以 JSON 文本原样带出、切 English 后是英文且不含汉字））；`#285` 收尾 **+19**：`lib/markdown.ts` 加**裸 URL 自动链接**（GFM autolink 子集，只认 `http(s)`）。顺序是安全前提：整体转义 → 代码占位 → 粗斜体 → **markdown 链接产出先入 `links[]` 占位（`U+E001`，与代码占位符不同字符）** → 裸 URL 自动链接 → 还原文本占位 → 最后统一还原链接（少一步就 `<a>` 套 `<a>` 或把代码里的 URL 链掉）；URL 字符集 `[^^\s<>"'` + 控制字符 + 非 ASCII**只收 ASCII**（⇒ 未编码中文路径截断、与 cmark-gfm/linkify-it 同口径；**裸 `<` 被排除是刻意**——转义后正文里的 `<` 必然以 `&lt;` 存在）；`javascript:`/`data:`/`file:`/`mailto:`/`ftp:`/裸 `www.`/邮箱**不成链**（协议白名单钉住）；尾部标点按「**整只实体当一个字符**」剥离且 `&amp;` **不剥**；19 条用例含**真机标本** `- **http://…`、断实体全局面正则，另 **15 条 golden 是 `git show e61a035:…/markdown.ts` 实跑出来的旧输出**（无 URL 输入逐字不变，含 `[点我](javascript:…)` ⇒ `<p>点我)</p>` 这种旧怪形状都钉住）+ 156 条新旧差分（差分=0，脚本不入库）；主 agent 亲跑变异：去掉 `BARE_URL_RE` 的 `g` 标志 ⇒ 3 红；把 `&` 加进 `TRAILING_PUNCT` ⇒ 恰 1 红（「`&amp;` 实体完整留在 href 与文本里」）；⚠ 另有一条**变异自身是空操作**（往 `ESC_ENTITY` 加已存在的 `&amp;→&` 映射 ⇒ rc=0）⇒ 已定性为**变异写错**而非覆盖缺口，纪律：**「没红」必须先证明变异真的改变了行为**（AGENTS §8.24）；`#288` 前端 **+13**：M2 +6（`attempt_killed` 渲染「第 N/M 次尝试被终止…已重排等待重试」、双语键集逐字一致、脏值退化不出 `[object Object]`、缺 `silent_ms` 不留空括号、**实时与回放两条通路逐字一致**；localeParity +1）+ M3 +7（`tool_replay_decision_required` 中性分隔行、双语、脏值、载荷全缺；localeParity +1）；变异：`EVENT_TYPES` 与 `HISTORY_REPLAY_TYPES` **分别单独摘**分别红（前者 = 实时一条都收不到，后者 = 刷新后消失，两者症状可区分）；`#283` 前端 **+13**：M1 +8（`useEventStream.spec` 缺 `duration_ms` ⇒ `card.dur` 保持 `undefined`、文案不出现 `0ms`/`undefined`/空括号；`toolSummary.spec` 的 `formatDuration` 三档 `Nms`/`X.Ys`/`Xm Ys`；双语键 `stream.event.toolResultNoDur` 进 localeParity）、M3 +5（`useEventStream.spec` 投影带值/不带值 ⇒ `dur` 键存在性 + **实时值不被投影覆盖**、`StreamPanel.spec` 刷新路径渲染 `✓ 4.3s` 且旧数据不出现 `0ms`）；主 agent 亲跑变异：把 `?? 0` 加回 ⇒ 2 条红；改成投影无条件覆盖实时 ⇒ 恰好 1 条红。#255 前端②③④ 起 431→488：**新增 3 个 spec 文件 +57** —— `lib/forcePasswordGuard.spec.ts` 15（受限态守卫判据的函数级单测 11 + 熔断预算 3 + 「超预算后 `used` 不再增长」1，后两条是主 agent 亲跑变异「先加后判」当时全绿暴露的缺口）、`lib/forcePasswordErrors.spec.ts` 16（错误码 → 键的映射表表级断言 + 双语取真文案）、`views/ForcePasswordErrors.spec.ts` 24（渲染侧 / `[object Object]` 五形态 / 全局 403 兜底）；`router.spec.ts` 11→13（熔断接线：连续 16 次真落地导航不消耗预算 + `vi.mock` 造两态判据复现死环证明熔断不是装饰）；`views/ForcePasswordChangeView.spec.ts` 21 条一字未改。主 agent 独立复跑变异取证：`reset()` 空实现 / 默认预算 12→2 / 先加后判 / 注释 `router.afterEach` 归零（(a)(b) 双红）全部**秒级红在具名用例上、零挂死**。#255 前端①「强制首登改密屏」起 410→431：新文件 `views/ForcePasswordChangeView.spec.ts` 21 条 —— 闸门渲染、「关不掉」（无 dialog/遮罩/关闭按钮且改 URL 也进不去）、深链刷新重建、`/login` 不是绕过口、成功链路必须重新 `GET /api/me`（禁止本地清旗标）、**false 一切照旧**、双语键集逐字一致、`toDisplayText` 的 `[object Object]` 反证；旧 29 文件一字未改仍全绿。#261B「重试上一条」起 391→410（`workbench.spec` +8 状态机/守卫、`ComposerBar.spec` +7 三态渲染与转发、`useEventStream.spec` +4 横幅 errorCode 两态与 i18n 同形）；后端与 runner 基线不变（**1187 / 286**，2026-10-15 本机复现）。
   `NODE_ENV=development` 是**必需**的：devDependencies（vite/tailwind/vitest）在 `NODE_ENV=production` 下会被 `npm ci` 跳过。
   基线拆解：**23 文件 / 329 通过**（#246 交付② 单 A 与 #252 时的基线）+ `#246 交付② 单 B`（工单 `feat-261011-B2`，纯前端）净增 **6 文件 / 62 项**：
   预览端口面板的端点与票 URL 拼装 15（`src/lib/previewPorts.spec.ts`）、数据层（签票时机 / 新标签地址 / 改块 body）12
   （`src/composables/usePreviewPorts.spec.ts`）、列表四态与 `state` 口径 13（`src/components/PreviewPortsPanel.spec.ts`）、
   工作台区块（进视图拉列表 + **未点击不得签票**）6（`src/views/WorkbenchPreviewPorts.spec.ts`）、
   管理台改块（**未确认不得发 POST** / 409 全文 / 400 指 `block_start`）10（`src/views/AdminPreviewPorts.spec.ts`）、
   i18n 双语键集对齐 6（`src/i18n/localeParity.spec.ts`）。既有 329 项一条没改、一条没红。

**镜像构建校验的路径过滤（`ci.yml` 步骤 ⑤）**

| 镜像 | 构建上下文 / Dockerfile | 触发路径 |
|---|---|---|
| portal | context `.`（仓库根）+ `portal/Dockerfile`（= `deploy/docker-compose.yml:111-113` service `station-portal`） | `portal/**`、`package.json`、`package-lock.json`、**`docs/data/**`、`deploy/migrations/**`、`.dockerignore`** |
| FDE | context `runner/`（= `portal/integration/lib/fde-image.mjs:36` 的 `build -t <img> runner/`） | `runner/**` |
| fde-proxy | context `deploy/fde-proxy`（= `deploy/docker-compose.yml:63-65` service `station-docker-proxy`） | `deploy/fde-proxy/**` |

- 后三类是**按仓库实际补的**：`portal/Dockerfile:31` COPY 了 `docs/data/`、`:34` COPY 了 `deploy/migrations/`、
  根 `.dockerignore` 参与 context `.` 的上下文计算 ⇒ 它们变了镜像内容就变，不构建校验就是假绿。
  （工单原表只列了 `portal/**` + 根 `package*.json`。）
- **纯 docs 提交不构建任何镜像**（`docs/**` 除 `docs/data/` 外都不在触发集里）。
- 推入前的 commit 在本地历史里找不到（新分支首推 / force push）⇒ 保守起见三个全构建。
- CI **不传** `HTTP_PROXY/HTTPS_PROXY/NO_PROXY` build args，也不加 `--network=host`：
  `runner/Dockerfile:55-74` 那层从 github.com / dl.gitea.io / gitlab.com 直连下 gh/tea/glab，
  本开发机在墙内必须走代理（`fde-image.mjs:26-40`），GitHub runner 直连可达；
  而 **build args 参与 Docker 缓存键** ⇒ CI 恒不传，缓存键保持稳定。

---

## 2. 发布 → 部署（digest pin）

**流程一览**

```
① 对齐版本号（§7）→ ② git tag vX.Y.Z && git push --follow-tags（本沙箱里 = 主 agent cherry-pick 后推）
→ ③ release.yml 推三镜像，job summary / artifact `images-digest` 给出 digest 清单
→ ④ 部署机改 deploy/.env 三个 IMAGE 变量为不可变 pin → ⑤ docker compose up -d
→ ⑥ 换了 FDE 镜像还要重建 FDE 容器（见下面第 5 条）
```

**前置（部署机）：GHCR 拉取现在可以不带凭据**

仓库 `ErixWong/erix-station` **现为 public**（原为 private；可见性于 2026-10-19 实测确认，转公开的确切日期未考证），
三个 GHCR 包（`erix-station-portal` / `erix-station-fde` / `erix-station-fde-proxy`）REST `visibility` 均为 `public`
⇒ **部署机可匿名直接 `docker pull`，不必先 `docker login ghcr.io`**（实测：匿名 token 取 `latest` manifest `200`）。

```bash
docker pull ghcr.io/erixwong/erix-station-fde-proxy:latest   # 无需凭据
```

历史口径（包仍为私有的机器，或将来把包改回私有时才需要）：

```bash
# 用户名 = GitHub 用户名；口令 = PAT（classic 勾 `read:packages`；
# fine-grained 需给目标仓库 `Package: Read` + `Contents: Read`）
printf '%s' "$GHCR_PAT" | docker login ghcr.io -u ErixWong --password-stdin
docker pull ghcr.io/erixwong/erix-station-fde-proxy:latest   # 能拉过 = 登录到位
```

凭据落在 `~/.docker/config.json`；换 PAT 后需重登。CI **推**镜像仍走内置 `GITHUB_TOKEN`（`packages: write`），与本节无关。

⚠️ **两类拉取失败别混淆**（都是一副「镜像没推上去」的样子）：
- `denied: requested access to the resource is denied` = **权限**（包私有 / 未登录 / token 无 `read:packages`）——先看 Actions run 是否绿；
- `MANIFEST_UNKNOWN … OCI manifest found, but Accept header does not support OCI manifests` = **不是权限**，是探测命令的
  `Accept` 头少 `application/vnd.oci.image.manifest.v1+json`（用 `curl` 手搓 registry API 时最容易踩，补上即 200）。
  ⇒ 拿 `curl` 探可见性时，**404 不等于私有**；权威判据是 REST `GET /users/<user>/packages/container/<pkg>` 的 `visibility`。

1. **发布**：`git tag v0.2.0 && git push --follow-tags`。`release.yml` 校验
   `tag` 去掉 `v` 后必须等于 `package.json` 的 `version`，不等就**明确失败并打印两者当前值**。
2. **拿 digest**：三个来源任选（内容一致）——
   - `release.yml` 的 **job summary**（含可直接贴进 `deploy/.env` 的三行）；
   - artifact **`images-digest`** 里的 `images-digest.json`；
   - 若该 tag 已建 GitHub Release，同名文件会挂在 Release 附件上（tag push **不会**自动建 Release；
     要挂就先 `gh release create vX.Y.Z --notes '...'`，再用 `workflow_dispatch` 重跑 `release.yml`）。
3. **更新部署机 `deploy/.env`**（600 权限、不入库）：

   ```bash
   STATION_PORTAL_IMAGE=ghcr.io/erixwong/erix-station-portal@sha256:<digest>
   FDE_IMAGE=ghcr.io/erixwong/erix-station-fde@sha256:<digest>
   STATION_DOCKER_PROXY_IMAGE=ghcr.io/erixwong/erix-station-fde-proxy@sha256:<digest>
   ```

   ⚠️ **prod 模式（`FDE_DEV_MODE=0`）只接受两种形态**，否则 portal 拒启（`portal/src/config.js:121-123`）：
   - 形态① `image@sha256:<64hex>`（manifest digest，`images-digest.json` 的 `digest`）；
   - 形态② `sha256:<imageId>`（config digest，= 部署机 `docker image inspect --format '{{.Id}}'`；清单里的 `imageId`）。
   清单里两种都给了，任选；混用会核对不上（§3）。
4. **起栈**：`docker compose -f deploy/docker-compose.yml up -d`（compose 默认 tag 仍是 `:local`，
   **不设 env 就还是本地镜像**，CI/CD 不会自己改变部署形态；`FDE_IMAGE` 同时是 proxy 的 `IMAGE_ALLOWLIST`，
   `deploy/docker-compose.yml:93`，改 FDE pin 时两处同源，不用单独改 proxy 白名单）。
5. **换 FDE 镜像必须显式重建容器**：`ensureFdeContainer`（`portal/src/provisioner.js:305-322`）
   **只在容器不存在时创建**，不因镜像变化重建。

   ```bash
   docker rm -f fde-<name>
   docker compose -f deploy/docker-compose.yml exec -T station-portal \
     node portal/src/cli.js provision-fde --fde-name <name>
   docker inspect -f '{{.Image}}' fde-<name>   # 应等于新 imageId（sha256:<...>）
   ```
6. **核对**：`docker image inspect --format '{{.Id}}' <拉下来的镜像>` == 清单里的 `imageId`；
   `docker inspect -f '{{index .RepoDigests 0}}' <镜像>` 可取形态①用的 repo digest。

---

## 3. digest 语义：为什么必须 `--provenance=false --sbom=false`

- 开启 attestations（`docker/build-push-action@v6` 的 **provenance 默认是开的**）时，推上去的 digest 指向
  **attestation index**（子清单里除镜像外还有 provenance/sbom），它**不等于**部署机
  `docker image inspect --format '{{.Id}}'`（那是 **config blob 的 digest**）⇒ 我们拿 `.Id` / `@sha256:` 当部署 pin
  （`portal/src/config.js:119-123` 两形态门），人肉核对会永远对不上。
- 关掉后推的是**单张 image manifest**，其 `config.digest` 就是部署机看到的 `.Id`。本机实测等价性：
  `docker save` 出来的 `blobs/sha256/<Id>.json` **文件名就是 `.Id`**，且该文件内容的 sha256 又等于该文件名
  （内容寻址）⇒ `manifest.config.digest == docker image inspect .Id`。
- `release.yml` 步骤 ⑦ 因此记两样：`digest`（manifest，形态①）+ `imageId`（config，形态②），
  并用 `docker buildx imagetools inspect --raw` 现场读 registry manifest；若发现 manifest 里还挂着
  attestation 子清单，会在日志里显式警告（provenance/sbom 没关掉）。
- 步骤 ③ 用 `docker/setup-buildx-action`（docker-container 驱动）的原因：**默认 `docker` 驱动直接拒绝 attestation**
  （本机实测 `--provenance=true` → `Attestation is not supported for the docker driver`），
  在那个驱动下 `provenance/sbom` 开关形同虚设，也就无法保证「关掉」。
- `ci.yml` 的构建校验用 `docker buildx build --load`（默认 docker 驱动），产物只在本地、不推送，不存在 digest 问题。
- 单架构 `linux/amd64`，标签 `<version>` + `latest`；**不推 `:local`**、不改 compose 默认 tag。

---

## 4. 账号预算语义（超额是**停跑**，不是扣费）

- GitHub Free；Linux `$0.006/min`、Windows `$0.01/min`、**macOS 3-core `$0.062/min`（≈10 倍）**
  ⇒ 所以 workflow 里**没有 matrix、没有 macos/windows runner**，这是红线。
- **Actions 与 Packages 预算都是 `$0` 且 `Stop usage = Yes`** ⇒ 超额**不扣费而是停跑**。
  后果：**CI 可能月中被静默停掉，界面上没有红灯**（不会失败，只是不跑）。
  排查习惯：main 上提交后**确认 CI run 真的存在**；没有 run 就按下面的兜底人工复跑。
- Actions 存储（artifacts + cache）与 Packages 通用配额**共享 500MB** ⇒
  `release.yml` 的 artifact 只放一个 `images-digest.json`（<2KB，保留 14 天）；
  `ci.yml` 不放 artifact、不开 `setup-node` 的 npm 缓存、不开 buildx `type=gha` 缓存
  （三次 `npm ci` 热缓存共 ~3s，省这点秒数不值配额风险；真要加缓存先确认它不会把 500MB 吃穿）。
- **兜底 = 人工在本地复跑同一套门禁**（与 `ci.yml` 步骤 ①–④ 一一对应，仓库根执行）：

  ```bash
  # ① 语法保底
  git ls-files -z -- '*.js' '*.mjs' | xargs -0 -n1 node --check
  # ①′ 运行身份诊断（属主类失败先报这个）
  id -u; id -g; id; uname -a
  # ② 根单测
  npm ci && npm test
  # ③ runner 单测（别用 `node --test runner/test/`）
  ( cd runner && npm ci && node --test )
  # ④ 前端（NODE_ENV 必须非 production）
  ( cd portal/frontend && NODE_ENV=development npm ci && npm run typecheck && npm test )
  ```

  镜像构建校验的本地兜底：`docker buildx build --load -t x .`（portal，`-f portal/Dockerfile`）、
  `docker buildx build --load runner/`（FDE，本机需先按 `fde-image.mjs` 的口径传代理 + `--network=host`）、
  `docker buildx build --load deploy/fde-proxy`。

---

## 5. GHCR 为什么免费、以及退路

- 原文依据：GitHub Docs 对 **container packages** 的存储与带宽写的是 **"currently free of charge"**
  （政策变化会提前 **≥1 个月**通知）；收费的是通用 Packages 配额（Actions cache/artifacts + 非容器包），
  即 §4 里那个 500MB。我们推的三类都是 **container image** ⇒ 落在免费侧。
- **退路**：一旦开始计费，改推本机自托管 **`registry:2`**（数据目录按全局约定放 `/docker/registry`），
  compose 的 `FDE_IMAGE` / `STATION_PORTAL_IMAGE` / `STATION_DOCKER_PROXY_IMAGE` 换成
  `127.0.0.1:<port>/...@sha256:<digest>`（或 `registry:5000/...`，`portal/src/config.js:104-114` 的
  registry host 判定接受带端口的 host）。
  **代价**：GitHub Actions **推不进 NAT 后的本机**（没有到本机的入站通道）⇒ 届时**构建也回本机**，
  CI 退回「只跑门禁」，镜像构建/推送改成本机脚本 + 同一个 digest 清单口径。

---

## 6. e2e 为什么不进 CI

`portal/integration/wp*-e2e.mjs` 不进 CI，理由都是硬依赖：

1. 需要 **docker daemon + 起整栈**（postgres / traefik / litellm / portal / proxy / 真 FDE 容器）。
2. **按栈派生的 IPAM 池**（#227.3，取代旧「恰为 `['10.201.0.0/16']`」等值口径）：
   `assertIsolatedEnvironment()`（`lib/isolated-env.mjs`）硬断言 `FDE_IPAM_POOLS` 每一段都在隔离族
   `10.201.0.0/16–10.299.0.0/16` 内，共享段 `10.200.0.0/16` 一律拒；正规值由
   `deriveFdeIpamPools(STATION_STACK_ID)` 按栈 id 数字 mod 99 确定性派生（族外/含共享段的显式覆盖都拒，
   族内显式覆盖放行作为撞段逃生口）。⚠️ portal 侧分配钉死在 `POOLS.large`（`portal/src/ipam.js:14`，
   非 env 可配），proxy 白名单必须包含 `10.201.0.0/16`，所以脚本缺省注入 `defaultFdeIpamPools`
   （派生段+large 池段）。护栏还断言一堆隔离栈专属 env（容器名、端口、`FDE_DEV_MODE=1`（tag 形态
   FDE 镜像必需，#227.1）、`STATION_DB_DIR` 必须在临时目录且**不存在**）；GitHub runner 上没有这套网络前提。
3. 需要**泛域名解析 + Tailscale**（`*.fde.erix.vip` → `100.100.0.3`）与宿主 Traefik host 网络。
4. 分钟成本：一条 e2e 链路跑下来在 CI 里要占十几分钟，Free 额度撑不住（§4）。

**口径**：e2e 由**主 agent 在部署机上、本机隔离栈**跑（`wp2a` / `wp3a` / `wp3b` / `wp5` / `wp6`），**部署前**执行；
CI 只保证「语法 + 单测 + 类型 + 镜像能构建出来」。其中 `wp2a` 已按 #268 决策第 2 条重建为「FDE 开户 →
userspace/端口下发对账 → 预览签票链路 → 去置备 + offboarding 收敛」的小包（工单 F，旧形态里「POST
/api/projects → 项目级 ports.json → 删项目回收端口」的断言对象已从产品里消失），与其余几支共用
`lib/isolated-env.mjs` 的隔离护栏 / Traefik 静态配置 / edge watch 桩，另加 `lib/ports-reconcile.mjs`
（`~/.erix/ports.json` ↔ `port_allocations` 逐条对账件）；静态口径由 `portal/integration/isolation-negative.mjs`
钉住（它不在 `node --test` 发现面里，缺省 rc=1 是负例证据本体，进 CI 用 `--strict`）。

---

## 7. 首次发布前置：版本对齐（**现状会被拦住，属预期**）

- 现状：`package.json = 0.1.0`、`runner/package.json = 0.1.0`，但 git tag 已到 **`v0.1.1`**（历史遗留不一致）。
  ⇒ 直接拿 `v0.1.1` 跑 `release.yml` 会在步骤 ① **失败**（同时打印两者当前值）。本工单**没改**版本号。
- 发布前动作（一次改齐，别只改一个）：
  1. `package.json` 的 `version` = 目标版本（**这是硬门**）；
  2. `runner/package.json`（FDE 镜像与宿主引擎同源，`release.yml` 只警告不阻断）；
  3. `portal/frontend/package.json`（纯展示，建议一并对齐）。
  然后 `git commit` → `git tag vX.Y.Z` → 推 tag。
- 依赖 `erix-agent` 是公开包（三份 lockfile 的 `resolved` 全指 `registry.npmjs.org`）⇒ **CI 不需要 NPM_TOKEN**，
  也不需要任何新 secret（GHCR 登录用内置 `GITHUB_TOKEN`）。

---

## 8. 已知坑（本工单验证时实测）

- **runner 的 uid/gid 与开发机不同 ⇒ 属主类断言直接 EPERM**（工单 C2，Actions 首跑
  run 38041183692 / 38041175079：`npm test` 16 项红，错误全部是 `EPERM: operation not permitted, fchown`）。
  - 根因：非特权进程只能把属主改成**自己的 euid**、把属组改成**自己所属的组**（`chown(2)`/`fchown(2)` 硬约束）。
    开发机恰好是 `1000:1000`，与产品默认 `FDE_USER_UID/GID=1000`（`portal/src/config.js:211-212`）撞车 ⇒ 问题被掩盖；
    GitHub runner 的用户不是 `1000:1000` ⇒ `fchown(fd, 1000, 1000)` 当场 EPERM。
    本机实测复现：`docker run --rm -u 1001:1001 … node --test portal/test/git-credential.test.js portal/test/git-cli-config.test.js`
    在 `main` 代码上恰好复现出 CI 里那 16 条（名字逐一对得上）。
  - **口径：测试不得硬编码 uid/gid。**「宿主侧属主」一律取进程自身
    （`const SELF_UID = process.getuid?.() ?? 1000; const SELF_GID = process.getgid?.() ?? 1000;`，
    同时注入 `config.fdeUid/fdeGid` 并用作断言期望值）；只取自身并不是放水——断言仍然是
    「落盘属主 == 配置里给的 fde 属主」，只是那个属主在非特权环境**只能**是自身。
    确实需要「能 chown 到任意属主」才有意义的断言走 `process.getuid() === 0` 的 **root-only 分支**，
    跳过时显式打印原因，**不许用 try/catch 把 EPERM 静默吞掉**。
    语义钉桩见 `portal/test/fsutil-chown.test.js`（自身属主必成功 / 外部 uid 非 root 必 EPERM 且 fail-closed /
    组侧同受限 / root 分支断言真能 chown 到任意外部属主）。
  - **这不是产品缺陷**：生产 portal 以 root 运行（`portal/Dockerfile:37` ⇒ 持 `CAP_CHOWN`），
    `setGitCredential` / `git-cli-config` 里的 `uid: config.fdeUid ?? 1000` 在生产下成立；本轮产品代码零改动。
    （若将来 portal 改成非 root 跑，`setGitCredential` 会真的 EPERM——那是产品口径变更，需单开工单。）
  - **可移植性复跑口径**（不需要真 runner）：
    `docker run --rm -u 1001:1001 -v "$PWD":/work -w /work <node 镜像> npm test`（非 root 分支）
    与 `-u 0:0`（root 分支）各跑一遍，两次都必须 0 失败。
    本开发机上 `unshare -r` / `setpriv --reuid` 都不可用（`kernel.apparmor_restrict_unprivileged_userns=1`
    且没装 `newuidmap`/`newgidmap`）⇒ 用 docker 的 `-u` 代替。
  - ⚠️ 以 root 跑全量单测另有 4 条**既有**用例会红（`offboarding.test.js` 的 F3/D3、`routes.test.js` 的 F3-5/N5）：
    它们靠权限位模拟 EACCES，而 root 无视 0000 权限——与本轮属主口径无关（`main` 基线同样红），
    CI 跑在 uid 1001 上不受影响。
- **同机并发跑测试会假失败**：`runner/test/shell-tools.test.js` 的两条 abort 用例扫 `/proc` 找残留
  `sleep 30.211 / 30.212`（`runner/test/shell-tools.test.js:145-207`）。若同时有另一份测试在跑
  （例：根 `npm test` 与 `cd runner && node --test` 并行），会看到对方的进程 ⇒ 报「abort 后仍有残留命令」。
  CI 里各步是**顺序**执行的，不受影响；本机手工复跑时**别并行**。
- `docs/data/schema.sql` 是**冻结 baseline**：`portal/src/migrate.js:137-138` 对整个文件文本（含注释）算
  sha256 做启动校验 ⇒ 一个字节都别改（改了会让已应用 baseline 的库拒绝启动）。
- `portal/Dockerfile:2` 与本仓 §1 的前端那一步（步骤 ④）同理：镜像构建阶段也**不能**在 builder 里设 `NODE_ENV=production`。
- workflow 里嵌 JS 时**不要**用单引号包裹的多行 `node -e '...'`：JS 里的 `''` 会关掉 shell 引号
  （actionlint/shellcheck SC1078 抓到过），一律走 `cat > "$RUNNER_TEMP/x.mjs" <<'MJS'` 再 `node` 执行。
