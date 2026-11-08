# P2 交付报告 · 门户读侧（子 run 名册 + 账本两个只读端点）

分支 `feat-261108-02-delegate-p2`（基于 main `45cf6c7`）。工单 `P2-WORKORDER.md`，设计 `docs/design/delegation-2026-11-08.md` §3/§5。
**未 push、未开 PR**（工单 §7）。

## 取证边界

写在这里，是为了让下一个人不把下面的数字读成比它实际范围更大的结论。

- **本机、单测层**。判绿 = `timeout 900 npm test` 退出码 0（AGENTS §4 红线：不 grep 摘要行）。没有真机 e2e：`deploy/` 栈没起、FDE 容器没建、`ERIX_DELEGATE_ENABLED` 没下发过 —— 那是 P4（设计 §7，主 agent 亲手）。
- **P1 宿主代码在 main 上还不存在**（`runner/lib/delegation.js` 不存在，`feat-261108-01-delegate-p1` 与 main 同点 ⇒ 未合）。所以「引擎真的会把名册/账本写成这个形状」这一条，**不是**从 P1 的真产物取的，而是从两处取证：
  1. 引擎侧源码 `node_modules/erix-agent/src/tools/delegation/roster.js`（`OPTIONAL_KEYS` 22 项白名单、`state` 封闭 7 值、`runId` 必须等于文件名 = 本模块 `rosterItem` / 跳过判据的逐条依据）；
  2. 一次真 `runToolLoop` + `createFileTranscriptStore` 的落盘探针（桩 provider、一轮三个 `tool_use`），输出逐行形状 = 测试里 `engineLedgerLines()` 的行形状（`:msg:<round>:<seq>` 消息行 + `partOf` + `<id>:engine:round:<n>` 载体行 + 轮记录不带正文）。
  ⇒ **端点与真产物之间没有跑通过一次**。合 P1 后 P4 必须补这一格。
- **测试里的账本是手写的 fixture，不是真引擎现跑的**。理由写在测试文件头：跑一次要 provider 桩 + 折叠策略，而本单要钉的是**读侧**；对拍过的形状对得上就够。`F2` 那条另用「同一批行、顺序不同 ⇒ 2 条 turn vs 0 条」把「为什么必须先折再切」钉成可执行事实，不靠注释。
- **两处事实按主 agent 的实测结论执行，没有自己推**：`foldLedgerMessages` / `foldMessageRows` 不在 `erix-agent` 导出面（0.31.0 实测 `foldLedgerMessages === undefined`）⇒ 用本站 `portal/src/transcript-fold.js#foldLedgerRecords`；路径解析不复用 `dirs.js#resolveJailedFile`（它的 jail 根是 `projects/<name>`）⇒ 本模块自建窄解析器。
- `createFileTranscriptStore` 的 `transcriptPath` 在 0.31.0 已是 `./src/store/file.js` 的导出，但**包根导出面上没有**（实测 `'transcriptPath' in await import('erix-agent') === false`）⇒ 仍手拼 `<childRunId>.jsonl`；`sub-<uuid>` 过 `safeRunId` 恒等，所以这里的手拼与引擎同形而不是近似。
- **未做**：缓存层（P3）、TTL 清理、前端（P3）、`notifyParent` 投递。审计**没写**（只读端点，与 `GET /api/sessions/:id` 同口径，工单 §3）。

## 基线数字

| | 改前（`45cf6c7`） | 改后（`1e5d4f3`） |
|---|---|---|
| `timeout 900 npm test` 退出码 | 0 | **0** |
| tests / pass / fail / skipped | 1948 / 1944 / 0 / 4 | **1970 / 1966 / 0 / 4** |
| 新增用例 | — | **+22**（`portal/test/delegation.test.js`），另 1 条既有护栏改写（折叠消费点清单） |

`npm ci --prefer-offline` 冷装 1.4s 量级；`node --check` 两个源文件都过。

## 交付

| 文件 | 内容 |
|---|---|
| `portal/src/delegation.js`（新） | `delegationRoot` / `rosterDir` / `transcriptPath`（窄解析器：两个 id 正则锁死 + `path.resolve` + 前缀断言）、`listDelegates`、`getDelegateTranscript`、`DelegationError`、`nodeFs` 注入缝 |
| `portal/src/http.js` | 两条 GET 路由 + `requireDelegateRunId` + `DelegationError` → 标准错误信封。**零新错误码**（`not_found` / `validation_failed` / `payload_too_large` / `internal` 全是既有） |
| `portal/test/delegation.test.js`（新） | 22 例：工单 10 条判据 + 白名单/排序/tail 边界/坏行/大写 id 归一/HTTP 接线 |
| `docs/api/portal.md` | §4.4c 新节 + §0.1 端点清单两行 |
| `portal/test/transcript-fold-wiring.test.js` | `#337` 折叠消费点护栏从 2 个放行到 3 个（`delegation.js`），理由写在断言上方 |

零 DDL、零新事件类型、零新错误码、零依赖变动、没碰 `runner/` 与 `portal/frontend/`。

## 判据 × 变异（工单 §5，10 条逐条）

每条：改一处 → 跑 `node --test portal/test/delegation.test.js` → 记下变红的用例 → `git checkout --` 还原。变异前先 commit（AGENTS 那条踩过多次的坑）。

| # | 判据 | 变异 | 变红 | 判定 |
|---|---|---|---|---|
| 1 | 跨用户不可见（与「不存在」同体） | `fetchSession(...)` → `void (...)` | `B1,B2`（HTTP 侧 `H1` 逐字比对同一响应体） | ✅ |
| 2 | 跨会话不可见 | 摘掉 `SELECT 1 FROM runs` 的 404 分支 | **首跑：一条都不红** → 修 `B2` 后：`B2` | ✅（原本假绿，见下） |
| 3 | childRunId 必须在名册里、且不读账本 | 把 `not_in_roster` 改成 `no_transcript` | `B9,C3,H1` | ✅ |
| 4 | 坏名册文件不 500 | 坏 JSON 的 `catch` 改成 `throw e` | `B4` | ✅ |
| 5 | 投影与主对话同形 | 不折叠直接投影（`foldLedgerRecords` 摘掉） | `C5,F1` | ✅ |
| 5b | 折叠解链口径（#341 闸） | `portal/src/transcript-fold.js` 里 `parts.set(key, partTargetIndex)` → `if (false)` | `F1` + 既有 `transcript-fold.test.js` 两条 #341 用例 | ✅ |
| 6 | 切尾在投影之后 | `foldLedgerRecords(records)` → `(records.slice(-2))` | `C5,C6,C15,F1,H1` | ✅ |
| 7 | 超大账本 413 | `st.size > 8MiB` → `false && ...` | `C7`（并断言超限后一个 `readFile` 都没发） | ✅ |
| 8 | 路径穿越 400 + 零 fs | 把 id 校验挪到归属查询之后 | `C8,H1`；另：`assertShape` 整体失效 → `A2,C8,H1` | ✅ |
| 9 | 名册目录不存在 ⇒ `{items:[],skipped:0}` | ENOENT 分支失效 | **首跑：不红** → 修 `B9` 后：`B9` | ✅（原本假绿，见下） |
| 10 | `hasTranscript` 不读内容 | `existsSync` → `readFile().length > 0` | `B4,B10,B11,H1` | ✅ |

加测的 14 条（都不在 10 条里，钉的是契约与红线）：`tail` 上限失效 → `C13,H1`；`state` 非字符串不再算损坏 → `B12`；整条 record 原样下发（白名单漏了）→ `B11`；`resultTruncated` 恒 true → `B11`；文件名形状判据摘掉 → `B4`；`record.runId` 与文件名一致性摘掉 → `B4`；`hasTranscript` 恒 false → `B10,H1`；账本后缀写成 `.json` → `A1,B10,C5,C6,C7,C13,C15,F1,H1,H2`；`run_id` 不下发 → `C5,H1`；`state` 不下发 → `C5`；`seq` 改用切尾后的局部下标 → `C6`；`created_at` 恒 null → `C5`；前缀断言单独撤 → **不红**（它是第二道防线，正则在前），与前缀断言+正则一起撤 → `A2,C8,H1` ✅。

### 变异抓到的三个假绿（这才是变异验证的价值，不是仪式）

1. **`B2`** 直调 `listDelegates({...h})` 漏了 `userId` ⇒ 那条 404 其实来自「会话不属你」而不是「父 run 不属该会话」，**摘掉 `SELECT 1 FROM runs` 归属查询不会红**。改成走统一的 `callList` 助手后才有牙。
2. **`B4`** 原本断言 `skipped >= 3`，且 `not-a-child.json` 内容写得不完整 ⇒ 后面的「`runId` 与文件名不符」会替它挡掉，文件名形状那道判据摘掉也不红。改成 `skipped === 3` + 那个文件的**内容自身完全合法**（只有名字不合格）才有牙。
3. **`B9`** 的 harness 已经把名册目录建出来了 ⇒ 它测的是「目录在但空」，不是判据 9 的「目录不存在」，ENOENT 分支整条摘掉也不红。改成先 `rm -rf roster/<runId>` 才有牙（并补一条：账本入口在名册目录整个缺失时也必须 404 而不是 500）。

## `git diff --numstat main..HEAD`

```
57	0	docs/api/portal.md
340	0	portal/src/delegation.js
71	0	portal/src/http.js
770	0	portal/test/delegation.test.js
7	3	portal/test/transcript-fold-wiring.test.js
5 files changed, 1245 insertions(+), 3 deletions(-)
```

7 个提交（工单 §7 的 4 个里程碑 + 3 个变异修正）：

```
498cf40 门户读侧路径解析 + 名册列表 + 账本投影（§2）
0bf5338 两个只读路由（§3）
418d245 判据 1–10 + 白名单/成本红线 + HTTP 接线（§5，22 例）
3011744 portal.md §4.4c + 折叠消费点护栏放行 delegation.js
83dc0e0 B9 真把名册目录拿掉
9010a3f B4 钉死 skipped === 3 + 白名单缺位归一
1e5d4f3 B2 改走 callList
```

## 契约要点（P3 前端会撞上的四条）

1. **`state` 是名册词汇（7 值），`termination` 才是引擎 reason**：`TERMINATION_TO_STATE` 把未列出的一切判成 `failed`，而 P1 已把 `no_tool` / `continuation_exhausted` 归一成 `end_turn`（⇒ 名册 `completed`）。UI 分级必须过 `portal/frontend/src/lib/terminationReasons.ts` 的 `RUN_TERMINATION_SYSERR_REASONS`，只看 `state` 会把 `persistence_failed` / `final_guard_unverified` 染绿。本模块只透传，不做归一。
2. `404` 有三种，靠 `details.reason` 分：`not_in_roster` / `no_transcript` / 无 details（会话或父 run 不存在）。空态文案要靠它（设计 §6.2）。
3. `messages[]` 的 `created_at` 是**轮行落盘时刻**（投影的 `turn.ts` 读载体行），不是消息成型时刻 —— 别拿它当「这条消息什么时候出现」的精确尺。
4. `seq` / `id` 用**投影后全量下标**，所以向前翻页时同一条消息的 id 不漂移；`totalTurns` 是切尾前的条数。

## 遗留 / 需要关注

- **P1 未合 ⇒ 端到端没跑通过一次**（见「取证边界」）。P4 真机时第一件事是拿一份真名册 + 真账本喂这两个端点。
- **名册按父 run 分片，账本按子 run 扁平** ⇒ `listDelegates` 只能一个父 run 一次请求。工具卡上要「这个会话所有子 run」得逐父 run 拉；真要合并统计，是设计 §5.2 说的 P3+ 迁移。
- `getDelegateTranscript` 的名册脏 JSON（在、但解析不出）一律 `state: null` 而不是 500：账本才是正文来源。这条不在工单里，是我加的，doc 写了。
- `hasTranscript` 与账本读取之间是 TOCTOU（子 run 正在写）：给的是布尔，抽屉下一次轮询自取，不追求一致快照。
- `docs/design/delegation-2026-11-08.md` 与 `P2-WORKORDER.md` 在本 worktree 里原本是**未跟踪**文件（派单时放进来的），现已随收尾提交一并入库（`git add -A`）。若主 agent 想让它们走另一条提交/另一个分支，`git rm --cached` 即可，内容我没动。
- `portal/frontend` 完全没动（工单 §6 红线）；P3 需要 `terminationReasons.ts` 直接吃 `termination` 字符串。
