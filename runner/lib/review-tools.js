// issue #537（W4a 审查快照与隔离）：审查 run 的**只读工具装配**。
//
// 为什么单独一个模块：审查 run 的工具面只留 `readFile`/`searchText`/`tree`——
//   * 不给 `shell`：`shell` 是 `bash -c`、无命令白名单（见 runner/lib/shell-tools.js:84-98），
//     `cwd` 只是起点，`cd ~/projects/foo` 就逃出 worktree；审查 agent 不该有执行能力。
//   * 不给 `note_*`：审查是只读观察，笔记写的是宿主会话目录，不该污染。
//
// ⚠ 这个模块**只 import node: 内建**，因此既能被 `runner/worker.js` import（同包），
//   也能被 `portal/test/macro-snapshot.test.js` import（跨目录的纯函数，不拖 erix-agent）。
//   worker.js 的两处装配点（registry 与 baseToolSchemas）**共用这里的同一份口径**——
//   「只改一处等于没改」，所以口径收敛到一个常量 + 两个过滤函数，两处都调它。
import process from 'node:process';

/** 审查 run 允许的工具名（只读三件套）。反向自证二的靶子：把 `shell` 加回这里，只读用例即变红。 */
export const REVIEW_ONLY_TOOL_NAMES = Object.freeze(['readFile', 'searchText', 'tree']);

/** 本次进程是否为「审查 run」（环境变量开关，**不动 DB schema**）。 */
export function isReviewOnly(env = process.env) {
  return env.RUN_REVIEW_ONLY === '1';
}

/** 过滤 executors（name→fn 对象）到审查只读集。 */
export function filterReviewExecutors(executors, allowed = REVIEW_ONLY_TOOL_NAMES) {
  const allow = new Set(allowed);
  const out = {};
  for (const [name, fn] of Object.entries(executors || {})) {
    if (allow.has(name)) out[name] = fn;
  }
  return out;
}

/** 过滤 schemas（name 在 allowed 内）到审查只读集。 */
export function filterReviewSchemas(schemas, allowed = REVIEW_ONLY_TOOL_NAMES) {
  const allow = new Set(allowed);
  return (schemas || []).filter((s) => s && allow.has(s.name));
}
