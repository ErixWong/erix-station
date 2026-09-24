// issue #69：会话历史下行（portal claim ticket → agentd RUN_START → 引擎 initialMessages）。
// 纯映射函数：portal 侧已按预算限幅（STATION_HISTORY_MAX_MESSAGES / STATION_HISTORY_MAX_BYTES），
// 本模块不做二次校验/截断；入参非法（非数组 / 元素缺 role）安全回退 []。
// 红线：history 内容不进任何日志/落盘（agentd/worker 侧只可记条数）。

/**
 * 把 ticket.history（[{role, content:string}]）映射为引擎 runToolLoop 的 initialMessages
 * （[{role, content:[{type:'text', text}]}]，与引擎 orchestrator 自建消息同构，契约见
 * erix-llm-kit docs/host-consumer-contract.md 白名单）。
 * @param {unknown} history
 * @returns {Array<{role:string, content:Array<{type:'text', text:string}>}>}
 */
export function mapHistoryToInitialMessages(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const item of history) {
    if (!item || typeof item !== 'object' || typeof item.role !== 'string' || item.role.length === 0) {
      return []; // 元素缺 role：整体回退（引擎空数组 = 全新会话，与现状等价）
    }
    out.push({
      role: item.role,
      content: [{ type: 'text', text: item.content == null ? '' : String(item.content) }],
    });
  }
  return out;
}
