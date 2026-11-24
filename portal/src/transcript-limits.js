// 单轮 transcript 记录体积上限的**叶子模块**（issue #261123-20 M1，纯重构自 `internal.js` 原样下沉）。
//
// 为什么单独成文件：常量原先长在 `internal.js`，而体积保险丝要放在**唯一写入口**
// `transcript-store.js#appendRound`（宿主预写与 agent 回传两条路都从那里过）。若
// `transcript-store.js` 反过来 import `internal.js` 取常量，会成环
// （`internal → transcript-store → internal`，`internal.js` 本来就 import 本 store 的恢复行三件套）。
// 故把常量下沉到本**无依赖叶子**：`internal.js` 与 `transcript-store.js` 各自 import 它，环消失。
// （原先经 `internal.js` 转发的那个 env 解析函数已随 env 一起删除，见下方 #677 说明。）

// portal.md §9.7：单轮 transcript 记录体积上限，**契约值 1 MiB，纯常量**。
// 历史（issue #371-B）：曾可由 env `MAX_ROUND_BYTES` 覆盖，但该 env **从未接进
// `deploy/docker-compose.yml` 的 station-portal environment 列表** ⇒ 生产上设了不生效，
// 是假旋钮（同台账 8.184 删 `MAX_BODY_BYTES` 的判据）⇒ issue #677 已删，不要再引入 env。
// 真机排障要把它调小（复现「宿主拒 → 引擎剥归档重试一次」要把闸调到几百 KB），
// **就改下面这一行并重跑**。⚠ 调之前先看下面的算术——调小于它，正常折叠记录也会天天碰闸。
// 算术（`test/internal-round-size-cap.test.js` 钉住）：上游 erix-agent#461 把折叠归档夹到 256 KiB
// （`ERIX_FOLD_ARCHIVE_MAX_BYTES`）+ 非归档部分真机稳定≈ 20 KiB + `messages` 满预算
// （203 161 估算 token × 2.78 B）≈ 565 KiB ⇒ 单条记录≈ 840 KiB < 1 MiB。
export const MAX_ROUND_BYTES = 1024 * 1024;
