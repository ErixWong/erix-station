// 单轮 transcript 记录体积上限的**叶子模块**（issue #261123-20 M1，纯重构自 `internal.js` 原样下沉）。
//
// 为什么单独成文件：常量原先长在 `internal.js`，而体积保险丝要放在**唯一写入口**
// `transcript-store.js#appendRound`（宿主预写与 agent 回传两条路都从那里过）。若
// `transcript-store.js` 反过来 import `internal.js` 取常量，会成环
// （`internal → transcript-store → internal`，`internal.js` 本来就 import 本 store 的恢复行三件套）。
// 故把常量下沉到本**无依赖叶子**：`internal.js` 与 `transcript-store.js` 各自 import 它，环消失。
//
// `internal.js` 保留 `export { resolveMaxRoundBytes }` 转发——既有导入面（含
// `test/internal-round-size-cap.test.js`）不破。

// portal.md §9.7：单轮 transcript 记录体积上限。**默认仍是契约值 1 MiB**，issue #371-B 起可由
// env `MAX_ROUND_BYTES` 覆盖（真机复现「宿主拒 → 引擎剥归档重试一次」要把闸调小到几百 KB，
// 不可能为此跑 160 轮）。⚠ 调之前先看下面那个算术——调小于它，正常折叠记录也会天天碰闸。
// 算术（`test/internal-round-size-cap.test.js` 钉住）：上游 erix-agent#461 把折叠归档夹到 256 KiB
// （`ERIX_FOLD_ARCHIVE_MAX_BYTES`）+ 非归档部分真机稳定≈ 20 KiB + `messages` 满预算
// （203 161 估算 token × 2.78 B）≈ 565 KiB ⇒ 单条记录≈ 840 KiB < 1 MiB。
const MAX_ROUND_BYTES_DEFAULT = 1024 * 1024;

/**
 * 单轮上限解析（#371-B）：显式 env > 默认 1 MiB。非法值（非整数 / ≤0 / 乱码）**退回默认**，
 * 不拒启动——本值只是防护上限，配错时宁可回到契约值也不要让 portal 起不来。
 */
export function resolveMaxRoundBytes(raw = process.env.MAX_ROUND_BYTES) {
  if (raw === undefined || raw === null || raw === '') return MAX_ROUND_BYTES_DEFAULT;
  const parsed = Number(String(raw).trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return MAX_ROUND_BYTES_DEFAULT;
  return parsed;
}
export const MAX_ROUND_BYTES = resolveMaxRoundBytes();
