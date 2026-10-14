// issue #283：装配层适配器——让引擎给「真执行过的工具」都写上 duration。
//
// 事实基线（erix-agent 0.18.0 `src/loop/run-snapshot-executor.js` 的 `normalizeExecutionResult`，
// 主 agent 用桩 provider 探针实测 + dev 真库盘点，见 station issue #283 更正评论）：引擎只在 executor
// 返回**结构化**结果时才写 `metadata.duration`（随后在 :329-333 把 execution.metadata 摊平到
// `tool_result` 块顶层，所以宿主读 `toolResult.duration` 是正确读点）：
//   * 自有 `content` 键的对象 —— :102 写 duration；
//   * 自有 `data` 键的对象（`toolResultData`）—— :119 写 duration；
//   * string / number / 裸对象 / 数组 / null / undefined —— :111 那条**不写**；
//   * 返回 Error 对象 —— :80-86 那条**不写**（且 content 取 `error.message`、`success:false`）；
//   * executor **抛异常** —— :258-266 的 catch **不写**。
// 本站工具面上只有 `searchText` 返回 `{content, metadata}`，`shell`/`readFile`/`tree`/`edit`/
// `writeFile`/`note_*` 全落「不写」那几条 ⇒ dev 真库 740 条 tool_result 只有 12 条带时长（全是
// searchText），前端把「没有时长」伪装成 0（issue #283 的现象「每条工具调用恒显 0s」）。
//
// 本适配器只做一件事：在 worker 的 executeTool 出口把**非结构化**返回包成 `{ content, metadata: {} }`，
// 让引擎走它会写 duration 的 :102 分支。引擎随后执行 `toolResultContent(value.content)` ⇒
// **模型看到的正文逐字节不变**（string 原样；number 5 → "5"；裸对象/数组 → 同一份
// `JSON.stringify(…, null, 2)`；null → "null"；undefined → "undefined"），由
// runner/test/tool-duration.test.js 拿真引擎逐形态钉死。
//
// 口径：
//   * **原样透传（不二次包装）**：自有 `content` 键的对象、自有 `data` 键的对象、Error 实例
//     （Error 有自己的引擎分支，包了会把 `success:false` 翻成 true、把 content 从 message 变成 "{}"）；
//   * **不自己塞 `metadata.duration`**：引擎 :102 无条件覆盖 ⇒ 时长的单一真相仍是引擎，
//     适配器只开闸不编数（`metadata` 保持空对象）；
//   * **抛异常的路径不在这里处理**：worker 不 catch，保持引擎 catch ⇒ 该次调用没有时长，
//     前端显示成「没有时长」（不是 0）。
//
// ⚠ 可撤条件：上游 erix-agent issue **#285**（与本单同号不同仓库：要求「所有真执行过的工具都写
// duration」+ 把三种返回形态各缺哪些引擎注入字段写进 `host-consumer-contract.md`；明确不改
// duration 的位置）落地并升版后，本文件与 worker.js 的包装调用、以及测试里的「引擎缺口对照」用例
// 整体删除——先例见本项目 AGENTS §8.9 的 `tree` 根标签收口。

/**
 * 把工具执行结果包成「引擎会写 duration」的结构化形态；已是引擎结构化契约面形态的原样透传。
 * @param {unknown} value executor 的返回值
 * @returns {unknown} 原值（透传分支）或 `{ content, metadata: {} }`
 */
export function wrapToolResultForDuration(value) {
  // 引擎 :80-86 自带 Error 分支（content=message、success:false），包装会篡改这两处语义 ⇒ 原样透传。
  if (value instanceof Error) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    // 谓词与引擎 :91（content）/ :109+`toolResultData`（data）的判定同形（自有键才算，原型链上的 content/data 不算）。
    if (Object.prototype.hasOwnProperty.call(value, 'content')) return value; // 引擎 :102 写时长
    if (Object.prototype.hasOwnProperty.call(value, 'data')) return value;    // 引擎 :119 写时长
  }
  // 其余一切（string / number / boolean / 裸对象 / 数组 / null / undefined）：包一层开闸。
  return { content: value, metadata: {} };
}
