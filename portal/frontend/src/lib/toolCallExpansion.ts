// 记住用户手动展开的工具卡片，按 callId 键（issue #85，参照 pi web lib/tool-call-expansion.ts）。
//
// 卡片默认收起；展开态存组件外的原因是消息流会随 SSE 事件补发/历史重放反复重渲染
//（entries 重建、v-for key 变化等都会重挂载卡片），纯组件状态会把用户刚打开的卡片
// 折回去。模块级 Set 让重挂载后的卡片保持展开。离开会话时由 workbench 在
// resetStreamState 的宿主调用点调 clearExpandedToolCalls() 清空。
const expandedToolCalls = new Set<string>();

export function isToolCallExpanded(callId: string | undefined): boolean {
  return callId !== undefined && expandedToolCalls.has(callId);
}

export function setToolCallExpanded(callId: string | undefined, expanded: boolean): void {
  if (!callId) return;
  if (expanded) expandedToolCalls.add(callId);
  else expandedToolCalls.delete(callId);
}

export function clearExpandedToolCalls(): void {
  expandedToolCalls.clear();
}
