# P3 执行报告：子 run 只读抽屉（DelegateChildDrawer）

## 取证边界

* **本报告只覆盖**：`DelegateChildDrawer.vue` + 它的 spec + `delegate.*` 双语 i18n 键（工单 P3 交付 1/2/3）。
  **工具卡（`StreamPanel.vue`）本轮未做**（工单明确排除）。
* 读过的既有文件只有 4 个（工单纪律）：`FilePreviewModal.vue`（前 120 行，抄 dialog/Esc/焦点/锁滚动）、
  `lib/terminationReasons.ts`（grep 红色集合）、`i18n/locales/zh-CN.ts`（grep `stream.folded` 的键形状）、
  `lib/delegate.ts`（已存在的前序产物，直接复用其尺规）；另 `grep` 了 `package.json` / `vite.config.ts` /
  `localeParity.spec.ts` 确认测试口径。**未读** `workbench.ts` / `useEventStream.ts` / `StreamPanel.vue` /
  `pi-web`。
* 所有「绿」的判据都是**退出码**（`echo rc=$?`），不是散文：见下方「自检结果」的命令与输出摘要。
* **未验证的部分**：没有真后端联调（`/api/sessions/:id/delegates/:child` 的 P2 读侧契约只按工单给的
  形状打桩）；没有浏览器实测（焦点归还、滚动锁只有 jsdom 层面的断言）。

## 交付 1：`portal/frontend/src/components/DelegateChildDrawer.vue`

* props `{ sessionId, parentRunId, childRunId, label? }`、emits `close`。
* 数据：`lib/delegate.ts#delegateTranscriptUrl` 生成
  `GET /api/sessions/<sid>/delegates/<cid>?runId=<pid>&tail=100`（两个 id 都 `encodeURIComponent`）。
* dialog 语义（对齐 `FilePreviewModal`）：`role="dialog"` + `aria-modal="true"` + `aria-label`（含短码）、
  打开焦点进 dialog、Esc 关闭（document 级 keydown）、卸载归还触发元素焦点与 `body.style.overflow`、遮罩点击关闭。
* **轮询四条纪律**（逐条有反证用例）：
  1. 单飞 —— `inFlight` 守卫，挂住期间一次都不多发，落定后恢复按拍；
  2. 只在 `document.visibilityState === 'visible'` 发；不可见时**只续排程不发请求**，
     `visibilitychange` 回可见立刻补一发；
  3. 终态即停 —— 排程入口唯一（`schedule()`），`isDelegateTerminal(state)` ⇒ 不排程；
     **打开即终态 ⇒ 恰好一次**（终态集由 `lib/delegate.ts` 从 7 值封闭集减活态导出，不手抄）；
  4. `onUnmounted` 清 timer + `AbortController.abort()`；`AbortError` 不当故障、卸载后 `schedule()` 直接返回（timer 不复活）。
* 三态：请求失败且无内容 ⇒ `delegate.viewer.error` + 原文 message + 重试按钮；
  空 + 非终态 ⇒ `delegate.viewer.starting`；空 + 终态 ⇒ `delegate.viewer.empty`；
  已有内容时再失败 ⇒ 只在顶部挂条幅（不把已有正文抹掉）。
* 渲染：`role==='user'` 右对齐小字、**原样文本**（不解释 Markdown）；其余 `renderMarkdown(text)`；
  工具行 `🔧 name · argsSummary`，**无 `argsSummary` 不渲染**（`delegateToolCallText`）。
* 分级：**唯一入口** `delegateBadgeKind` ⇒ 红色只可能来自 `RUN_TERMINATION_SYSERR_REASONS`
  （未另造集合）；`aborted` 琥珀、`running/queued` `text-brand`、`completed` 绿；
  `completed` + `termination=persistence_failed` ⇒ **判红**（谎报成功反例）。

## 交付 2：i18n（zh-CN + en 成对，`localeParity.spec.ts` 已跑绿）

`delegate.openViewer / closeViewer / viewerTitle({id}) / refresh / polling / truncated /
viewer.{starting,empty,error} / state.{queued,running,completed,failed,aborted,timeout,interrupted,unknown}`
—— 除工单点名的 6 个 state 键外补了 `queued` 与 `unknown`：`delegateStateKey()` 的取值域就是
7 值 + `unknown`，少一个键就会渲染出裸键名。

## 交付 3：`DelegateChildDrawer.spec.ts`（13 例，`vi.useFakeTimers` + 桩 `global.fetch`）

工单点名的 6 条全覆盖：① 终态开 ⇒ 1 次且 +10s 仍 1 次；② 活态 +2s ⇒ 第二次；
③ 第二次转 completed ⇒ +10s 不增；④ 单飞（挂住时 +2s×2 无并发，落定后恢复）；
⑤ 卸载 ⇒ signal aborted 且 +10s 不增；⑥ 三态文案（空+活态 / 空+终态 / 500）。
另补：可见性纪律、分级颜色（含 `completed`+syserr 判红）、渲染形状（user 原样 / Markdown / 工具行）、
dialog 语义与焦点与滚动锁归还、短码标题与刷新按钮。

## 自检结果

| 命令 | 结果 |
| --- | --- |
| `timeout 240 npm test -- src/components/DelegateChildDrawer.spec.ts` | **rc=0，13 passed** |
| `timeout 400 npm test`（全套） | rc=1：**1181 passed / 3 failed**，失败全在 `GitLightBadge.spec.ts`（非本人改动，见下） |
| `npx vue-tsc --noEmit` | **rc=0** |
| `src/i18n/localeParity.spec.ts` | 绿（全套里通过：键集相等 + 无空串叶子） |

提交：`f5eba2f feat(delegate): 子 run 只读抽屉（轮询四纪律 + 三态 + 分级）`、
`9b1b30e test(delegate): 抽屉轮询四纪律 + 三态 + 分级 13 例`（未 push）。

## 遗留问题 / 需要关注

1. **`GitLightBadge.spec.ts` 在我工作期间被并发改动**（`git status` 显示 ` M`，且**单跑该文件也红**，
   失败形状是 `w.emitted('refresh')` 为 `undefined`）。不是我引入的：我没碰过它，也没碰过它的依赖。
   同一症状我在自己的用例里遇到过 —— 这个 vitest/VTU 组合下 `wrapper.emitted('x')` 拿不到事件，
   本仓库既有 spec 的写法是**传 `onXxx` 桩函数再断言调用次数**（`FilePreviewModal.spec.ts:167-173`），
   我的 dialog 用例已改成该写法。建议 whoever owns 那条 spec 照此修。
2. **一次测试运行里读到过旧的 i18n 文案**（首轮跑出「只显示最后 {n} 条」这类不属于本文件的文案，
   随后消失）：像是并发写同一批 locale 文件 / vite transform 缓存交错。**同一 worktree 里并发跑
   vitest + 改 locale 有互相污染的风险**，建议串行。
3. `delegate.truncated` 我写成了不带占位的整句（工单只点名键名）；若后续想报具体条数，
   需要把 `DELEGATE_TAIL` 或 DTO 的 `totalTurns` 作参数传进去（现在只有 `totalTurns` 进副标题）。
4. `label` 只进了头部副标题（`label · totalTurns`），没有别消费点；工具卡接线时请确认它想要的到底是
   任务描述还是短码。
5. 后端契约按工单给的形状打桩：真实响应若把 `termination` 写成对象而非字符串，
   `delegateBadgeKind` 会**不当命中 syserr**（`lib/delegate.ts` 的既定口径），届时要看 P2 读侧归一化。

---

# P3 执行报告（接线轮）：把子 run 抽屉接到工具卡上

## 取证边界

* **本报告只覆盖**本轮三个交付：`useEventStream.ts` 的 `ToolCardState.runId`（两条建卡路径）、
  `StreamPanel.vue` 的 delegate 工具卡 + 抽屉挂载点、新建 `DelegateToolCard.spec.ts`（5 例）。
  **未改** `DelegateChildDrawer.vue` / `lib/delegate.ts` / i18n（`delegate.openViewer` 双语键上一轮已在）。
* 按工单纪律**只读了 3 个既有文件的规定片段**：`StreamPanel.vue`（import 段 + 工具卡模板 + 卡片取数助手
  `summaryText/statusMark/cardArgs/cardOut`）、`useEventStream.ts`（`ToolCardState` + `toolCard()` +
  `projectToolCard()`）、`workbench.ts`（`StreamEntry`）；另外只 `grep` 取符号位置与少量定义体：
  `lib/terminationReasons.ts`（红色集合定义）、`lib/delegate.ts`（`delegateBadgeKind/DELEGATE_BADGE_CLASS/shortRunId`）、
  `lib/toolCardKey.ts`（`runSegment`）、`i18n/locales/*`（`openViewer` 键存在性）、`toolSummary.ts`（`getToolResultSummary`
  对非字符串结果的归一形状）、`DelegateChildDrawer.spec.ts`/`StreamPanel.spec.ts`/`useRunMomentum.spec.ts`（测试装配口径）。
  **未读** pi-web 源码（32px 按钮形状按工单文字 + 站内既有 `PreviewPortsPanel` 图标按钮风格落地）。
* 所有「绿」的判据是**退出码**（见「自检结果」），不是散文。**未做真后端联调**：抽屉端点仍按 P2 契约打桩，
  本轮没有起 portal 服务验证「真实 delegate 卡片 → 真实子 run 正文」端到端。

## 交付 1：`ToolCardState.runId`（工单 §2.0 + 中途补条）

* `ToolCardState` 增可选 `runId?: string`（= 卡片所属 run = 抽屉端点的 `parentRunId`）。
* **两条建卡路径都填**：实时 `toolCard(key, callId, name, input, runId)` 用 `runSegment(runId)` 归一；
  投影 `projectToolCard(key, fields, alias)` 用 `runSegment(alias?.runId)` 归一。脏值 ⇒ `null` ⇒ **不写这个键**
  （与 `dur` / `executionStatus` 的「不拿 undefined 占位」同口径）。
* 投影**归并到已有卡片**那一支只在 `existing.runId === undefined` 时补，不覆盖实时值（与 `dur` 的「实时优先」同口径）。
* `cardIdentity` / `cardForCorrelation` / 事件集合**一字未改**。

## 交付 2：`StreamPanel.vue` 的 delegate 工具卡

* 只在 `card.name === 'delegate'` 且结果里能解出 JSON 对象时启用专属展示；解不开（预览被 400 字截断、
  工具给了自由文本、旧数据）⇒ **整段退回既有 `summaryText` + ✓/✗/…**，解析全程 `try/catch`，**永不抛**。
  实时路 `card.out` 是「✓ {json} (1.2s)」这种包裹串 ⇒ 先整体 `JSON.parse`，再退一步取首个 `{...}` 片段解析。
* 摘要位：`action · <子runId 短码>`（短码走 `lib/delegate.shortRunId`，不重造口径）。
* 状态位：`queued/running` ⇒ `svg.animate-spin` + `text-brand`；`completed` ⇒ ✓ 绿；`aborted` ⇒ ■ 琥珀；
  `failed/timeout/interrupted` ⇒ ✗ 红。分级**唯一入口**是 `lib/delegate#delegateBadgeKind(state, termination)`
  —— 它内部就是 `RUN_TERMINATION_SYSERR_REASONS` 那道闸且判序在 `completed` 之前 ⇒
  **`completed` + `persistence_failed` 仍红**，组件里**没有第二份枚举**（这就是「从 terminationReasons 导入」的落地方式）。
* 头行右侧图标按钮：`h-8 w-8` + `border-l border-black/10`、`aria-label`/`title` = `t('delegate.openViewer')`，
  仅 `payload.ok === true && payload.runId !== ''` 时出现。它在折叠 `<button>` 的**外层 wrapper** 里
  （HTML 不允许嵌套 button，故头行从「单个满宽 button」改成「flex wrapper = 折叠 button(flex-1) + 图标 button」）。
* 抽屉挂载点**全组件一处**（`<template>` 底部 `v-if="delegateOpen"`）：`sessionId=store.sessionId ?? ''`、
  `parentRunId=card.runId`、`childRunId=` 解析出的 runId、`label=card.name`、`@close` 置空；
  另把解析到的 `termination` 递下去（抽屉自己端点不带它，而「completed + syserr 仍红」在抽屉里也得成立）。

## 交付 3：`DelegateToolCard.spec.ts`（5 例，全绿）

卡片一律用**真实入口**驱动（`store.es.handleEvent('tool_use'/'tool_result')`、`store.es.projectToolCard(...)`），
不手搓窄类型卡片对象。

1. `tool_result` = `{ok:true,runId,state:'completed'}` ⇒ `.delegate-open-viewer` 出现（`aria-label`/`title` 齐）+
   摘要位 `dispatch · <短码>` + 状态位 ✓ 绿；
2. 载荷 `{ok:false,reason:'capacity_full'}` ⇒ **无按钮**（闸看载荷 `ok`，不看卡片 `ok`；用例特意让
   `tool_result.ok=true` 而载荷 `ok=false`，这样「看错字段」也会红）；
3. `state:'failed'` ⇒ `text-red-600` + ✗；`state:'completed'` + `termination:'persistence_failed'` ⇒ **仍** `text-red-600` + ✗；
4. 点按钮 ⇒ `findComponent(DelegateChildDrawer)` 存在、props 为
   `{sessionId:'sess-1', parentRunId:'run-1', childRunId:'sub-child-aaaa', label:'delegate'}`、`close` 后卸载
   （同一例顺带钉 `state:'running'` ⇒ `text-brand` + `svg.animate-spin`）；
5. **刷新/加载路径**：`projectToolCard(key, {...delegate 结果...}, {key, runId:'run-1', roundToken:'?', callId:'c1'})`
   建卡后 `toolCards.get(key).runId === 'run-1'`，且渲染出按钮、点击后抽屉 props 的 `parentRunId` 就是 `'run-1'`
   —— 这条就是「不填投影路径 ⇒ 刷新后全部打不开」的反证。

## 自检结果

| 命令 | rc | 结果 |
| --- | --- | --- |
| `timeout 240 npm test -- src/components/DelegateToolCard.spec.ts` | **0** | 5 passed (5) |
| `timeout 300 npm test -- src/components/StreamPanel.spec.ts`（**被改组件的既有回归**） | **0** | 66 passed (66) |
| `timeout 300 npm test -- src/composables/useEventStream.spec.ts`（**被改 composable 的既有回归**） | **0** | 83 passed (83) |
| `timeout 420 npm run typecheck`（`vue-tsc --noEmit`） | **0** | 无输出 |

**未跑全量 `npm test`**（按工单纪律）；`GitLightBadge.spec.ts` 一字未动。

## 遗留问题 / 需要关注

* **工作区里有一条不属于本轮的未提交改动**：`DelegateChildDrawer.vue` 的 `schedule()` 被改成
  `void poll()`（删掉了 `setTimeout(..., DELEGATE_POLL_MS)`）。若那是终稿，**活态轮询会退化成无间隔紧循环**
  （纪律 ①「按拍」与 ③ 的排程语义都没了，且 `DELEGATE_POLL_MS` 变成未使用）。本轮**没有 stage 也没有改**那个文件；
  本轮用例返回的是终态 `completed`，两种实现都只发一发，所以不掩盖该问题、也不被它影响。
* 头行结构由「单个满宽 button」变成「wrapper + 折叠 button」：既有 66 例全绿（它们抓的是 `button[aria-expanded]`），
  但任何**未跑到的**外部样式/E2E 若按「卡片第一个子元素就是 button」定位，需要跟着改（`.delegate-open-viewer` /
  `.delegate-summary` / `.delegate-state` 三个类名是本轮新钉的稳定钩子）。
* `card.runId` 缺失（旧数据、事件帧没带 `run_id`）时按钮**仍会出现**（工单把出现条件写成「载荷 ok && runId」），
  此时抽屉会带 `runId=''` 去拉端点 ⇒ 展示为拉取失败，不抛。要更严可把按钮条件加上 `card.runId`，本轮按工单文字执行。
* 载荷里 `state` 缺席/脏值（例如只有 `{ok:false,reason:'capacity_full'}`）时状态位**沿用既有 ✓/✗/…**、
  不猜成红色（宁可不显示也不谎报）；工单「其余 ⇒ ✗ 红」按「已知的失败类 state」理解。
