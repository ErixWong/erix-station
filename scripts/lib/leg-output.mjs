// issue #758：真库腿判红时，把捕获到的 TAP / stderr 切成「可诊断切片」。
//
// 背景：scripts/check-required-legs.mjs 过去只打一行汇总（rc/pass/fail），
// CI 日志里看不到那条 `not ok` 断言了什么（期望/实际/stack）。本模块把
// 「从文本切出 not ok 块」与「输出截断」做成**纯函数**——无顶层执行、
// 不碰 process.exit——所以脚本与单测都能安全 import。
//
// 判定口径不在这里，本模块只负责「红的时候给人看什么」。

// TAP 失败用例头行：可能带缩进（子测试），如 `    not ok 1 - 名字`。
const NOT_OK_RE = /^\s*not ok\b/;

/**
 * 从一段文本里切出所有 `not ok` 块：命中行 + 其后最多 contextLines 行。
 * 每块天然含随后的 AssertionError / expected / actual / stack 首行。
 * 返回「块」的数组（每块是行数组）；无命中返回 []。
 * @param {string} text 待切的文本（通常是 stdout + '\n' + stderr）
 * @param {number} [contextLines=20] 每条 not ok 之后最多再带几行
 * @returns {string[][]}
 */
export function extractNotOkBlocks(text, contextLines = 20) {
  const lines = String(text ?? '').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (NOT_OK_RE.test(lines[i])) {
      blocks.push(lines.slice(i, i + 1 + contextLines));
    }
  }
  return blocks;
}

/**
 * 取文本尾部最后 n 行（忽略末尾换行造成的空尾行）。
 * @param {string} text
 * @param {number} n
 * @returns {string[]}
 */
export function tailLines(text, n) {
  const lines = String(text ?? '').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(Math.max(0, lines.length - n));
}

/**
 * 把行数组截到最多 maxTotal 行；超限则截断并回报 truncated=true。
 * @param {string[]} lines
 * @param {number} maxTotal
 * @returns {{lines: string[], truncated: boolean}}
 */
export function capLines(lines, maxTotal) {
  const arr = Array.isArray(lines) ? lines : [];
  if (arr.length <= maxTotal) return { lines: arr.slice(), truncated: false };
  return { lines: arr.slice(0, maxTotal), truncated: true };
}

/**
 * 组装一条腿判红时要打印的行：定位头 + not ok 切片（无则退化尾部）。
 *
 * · 优先打印所有 not ok 块；一个都没匹配到（崩溃/语法错）则退化打印
 *   尾部最后 tailFallback 行（传进来的是 stdout+stderr，stderr 拼在末尾，
 *   所以退化时尾部以 stderr 为主，正是崩溃堆栈所在）。
 * · 总行数（含定位头与可能的「已截断」标记）保证 ≤ maxTotalLines。
 *
 * @param {string} text stdout + '\n' + stderr
 * @param {{legId?: string, label?: string, maxTotalLines?: number,
 *   contextLines?: number, tailFallback?: number}} [opts]
 * @returns {string[]} 直接逐行 console.log 即可
 */
export function buildDiagnosis(text, opts = {}) {
  const {
    legId = '',
    label,
    maxTotalLines = 120,
    contextLines = 20,
    tailFallback = 60,
  } = opts;
  const header = `---- ${label || legId} 输出 ----`;
  const blocks = extractNotOkBlocks(text, contextLines);
  let body;
  if (blocks.length > 0) {
    body = [];
    for (const b of blocks) body.push(...b);
  } else {
    body = tailLines(text, tailFallback);
  }
  if (1 + body.length <= maxTotalLines) return [header, ...body];
  const allowedBody = Math.max(0, maxTotalLines - 2);
  return [header, ...body.slice(0, allowedBody), '…（已截断）'];
}
