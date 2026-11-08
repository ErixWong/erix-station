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
