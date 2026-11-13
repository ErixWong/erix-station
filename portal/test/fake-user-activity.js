// issue #497（工单 feat-261112-01）：`UPDATE users SET last_activity_at = now() WHERE id = $1` 的**共用仿真**。
//
// 为什么要有这个文件：这句话只有两个写入点（`sessions.js#postMessage` 与
// `queued-inputs.js#enqueueQueuedInput`），而它路过的假池有四个（llm / queued-inputs /
// session-title / session-stop-queued），外加本单自己的判据文件。本仓假池的红线是
// 「**未覆盖的 SQL 一律抛错**」（AGENTS §8.14：不许把未知语句好心吞掉 = 假绿），
// 所以每处都得认识它；把语义收在一处，四处才不会各写一份漂移的仿真。
//
// 仿真做三件事（都在「按 SQL 说的做」这条线内）：
//   ① **真改内存行**：命中 `users` 表里存在的那一行才推进 `last_activity_at`；
//   ② `rowCount` 按真语义给（用户不存在 ⇒ 0 行，不假装写成功）；
//   ③ 记账 `writes`（`{userId, at}`，按调用顺序）——「变新 / 不许动 / 恰好一次」三类判据都读它。
//
// 时钟：PG 的 `now()` 是**事务时间戳**，同一事务里多次调用返回同一时刻。这里给一个
// **确定性单调时钟**（每次写 +1s，起点固定），理由不是仿真 `now()`，而是让判据能写出
// 「严格变大」的断言而不用睡进真实时间（真实时钟在 CI 上会让「比刚才新」退化成「不等于」）。
// ⚠ 别把它当 `now()` 的等价物读：跨事务它也会前进，而真 PG 不会。
//
// ⚠ **本文件里不写 `test(...)`**：它既被 `node --test` 当测试文件收集（`**/test/**/*.js`），
//   又被四个假池 import（每个测试文件一个进程）⇒ 写在这里的用例会**跑五遍**（实测），
//   同名用例重复计数的同时，还让「这条判据在哪个文件里」变得含混。自用例在
//   `user-last-activity-at.test.js` 的 W-0 里（含「别的语句不许被接管」那条反向自证）。

/** 两个写入点用的那一条 SQL（字面形状由本单在 `sessions.js` / `queued-inputs.js` 里钉死）。 */
export const USER_ACTIVITY_UPDATE
  = /UPDATE\s+users\s+SET\s+last_activity_at\s*=\s*now\(\)\s+WHERE\s+id\s*=\s*\$\s*1\s*$/i;

export function createUserActivityWorld({ users = [], baseMs = Date.UTC(2026, 10, 12, 0, 0, 0) } = {}) {
  const byId = new Map(users.map((u) => [u.id, u]));
  const world = {
    byId,
    writes: [],
    /** 确定性单调时钟（见文件头 ⚠）。 */
    now() {
      return new Date(baseMs + world.writes.length * 1000);
    },
    /** 命中 ⇒ 返回结果；不命中 ⇒ 返回 `null`（调用方继续自己的分派链，最后该抛还是抛）。 */
    query(sql, params = []) {
      if (!USER_ACTIVITY_UPDATE.test(sql.trim())) return null;
      const userId = params[0];
      const at = world.now();
      world.writes.push({ userId, at });
      const row = byId.get(userId);
      if (row) row.last_activity_at = at;
      return { rows: [], rowCount: row ? 1 : 0 };
    },
  };
  return world;
}
