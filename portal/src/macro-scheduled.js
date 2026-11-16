// issue #536 (W7 / M7)：定时任务执行器。
//
// W2（macro-eval）每轮求值只产出 `tick` 意图（见 macro-eval.js `evalClock`），
// 本模块是消费这些意图、真正「起一个 run」的执行体。契约见
// docs/design/event-platform/10-implementation-contract.md §7。
//
// 设计要点（详见各段注释）：
//  - 宏会话：每个 (user, template) 一条长期会话，origin='macro:<name>'，复用。
//  - 起 run：postMessage(pool, {..., triggerKind:'synthetic'})；cwd/maxRounds/task 用意图快照。
//  - 失败：不补跑，通知用户，finishMacroRun(status:'failed', reason)。
//  - 产物：平台写 reportsRoot/<macro>/<date>.md（默认 ~/reports），不是模型写文件。

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { postMessage } from './sessions.js';
import { finishMacroRun } from './macros.js';
import { deliverIntent } from './notifications.js';

export const MACRO_SESSION_ORIGIN_PREFIX = 'macro:';

/**
 * 执行一条 scheduled-task 的 tick 意图。
 * @returns 执行摘要
 */
export async function executeScheduledIntent(pool, intent, {
  reportsRoot = path.join(os.homedir(), 'reports'),
  runTask, // 桩 runner 注入点（测试不真调模型）
  now = new Date(),
  log = console,
} = {}) {
  // TODO
}
