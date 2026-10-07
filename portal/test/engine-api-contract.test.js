// erix-agent 0.15.0 宿主自检（host-upgrade-guide-0.15.0 §4）：
// 用上游 engineApiContract 锁定包入口导出面（appendUserTurn / projectTranscriptForDisplay）
// 与最小预写行为。portal 是 0.15.0 新 API 的直接消费方（POST 预写走 appendUserTurn，
// 见 portal/src/transcript-store.js），升级/换包后本套件必须全绿。
// 读侧 projectTranscriptForDisplay 的接线属 PR②b 范围（conversation-state.md §6），本文件只锁 API 面。
import { engineApiContract } from 'erix-agent/contract-tests';

engineApiContract('station-portal', () => import('erix-agent'));
