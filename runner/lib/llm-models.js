// issue #38 Phase B2：心跳下行模型集的 agent 侧纯函数（零依赖，可单测）。
//
// 传导链：portal 心跳响应 `models` 字段（{ main: {model,type}, embedding?, vision? }，上游真模型名）
//   → agentd parseHeartbeatModels 存 state.llmModels（IPC 内存传递，**不落任何文件/日志**）
//   → spawnWorker 的 RUN_START 带模型快照（run 启动瞬间锁定）
//   → worker resolveRunModel 用下行名覆盖占位 config.json 的 model 字段（endpoint/key 仍走占位文件）。
//
// 向后兼容：旧 portal 不下行 models / 无配置（models: null）/ 未知字段 → parseHeartbeatModels 返回
// null → state.llmModels=null → RUN_START 不带 models → worker 用占位 config 的 model 名（现状行为）。

/**
 * 解析心跳响应的 models 字段。结构非法/缺失/空 → null（与「无下行」同义，调用方保持现状行为）。
 * 只认三个已知槽位且 model 必须是非空字符串；type 以 portal 下行值为准（portal 侧已按槽位校验）。
 */
export function parseHeartbeatModels(data) {
  const m = data?.models;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const out = {};
  for (const slot of ['main', 'embedding', 'vision']) {
    const s = m[slot];
    if (s && typeof s === 'object' && typeof s.model === 'string' && s.model.length > 0) {
      out[slot] = { model: s.model, type: typeof s.type === 'string' ? s.type : slot === 'main' ? 'text' : slot };
    }
  }
  // main 是必备位：portal 有 active binding 时必带；缺 main 视为不完整下行，整体不采用。
  if (!out.main) return null;
  return out;
}

/**
 * 解析 run 实际使用的模型名：RUN_START 带下行模型集 → 用 main.model（真模型名，进请求体 model 字段）；
 * 否则（旧 agentd / 无配置）→ 占位 config.json 的 model 名。endpoint/key 始终走占位文件，本函数只定 model 名。
 */
export function resolveRunModel(defaultModel, models) {
  const m = models?.main?.model;
  return typeof m === 'string' && m.length > 0 ? m : defaultModel;
}
