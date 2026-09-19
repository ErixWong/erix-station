/**
 * seq 分配器（§7.3 统一口径）：单行 `chat_sessions.last_seq` +1，messages 与 run_events 共享。
 * 抽为独立模块（issue #33）：`internal.js`（reaper A2 合成 run_end）与 `provisioner.js`（offboard 收敛
 * active runs 时合成 run_end）都必须用同一口径分配 seq——重复实现会漂移。
 */
export async function allocSeq(client, sessionId) {
  const res = await client.query(
    `UPDATE chat_sessions SET last_seq = last_seq + 1, updated_at = now() WHERE id = $1 RETURNING last_seq`,
    [sessionId],
  );
  return Number(res.rows[0].last_seq);
}
