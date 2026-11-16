/**
 * issue #538（W4b）：宏「审查 run」的判决解析、事实工作包、回灌与生命周期。
 *
 * 分工：W2 已 claim（拿到已占位的 macroRunId），W4a 已建快照（macro-snapshot.js），
 * 本模块负责 ①事实采集→工作包 ②首行判决解析（fail closed） ③`red` 回灌 ④失败出口
 * ⑤`until` 到期与在途审查的竞争。
 */

import { finishMacroRun, MACRO_VERDICTS } from './macros.js';
import { postMessage, SessionError } from './sessions.js';
import { SNAPSHOT_FAILURE_REASONS } from './macro-snapshot.js';

/** 首行判决：完整匹配，不锚定不算（fail closed）。 */
export const VERDICT_LINE_RE = /^结论：(通过|整改|未证实有改动|需人工)$/;
export const VERDICT_BY_LABEL = Object.freeze({
  通过: 'pass',
  整改: 'red',
  未证实有改动: 'no-op-claim',
  需人工: 'needs-human',
});

export const MAX_BRIEF_BYTES = 8 * 1024;

// TODO(skeleton): parseVerdictLine / buildReviewBrief / runMacroReview
