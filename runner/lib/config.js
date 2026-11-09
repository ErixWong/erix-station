// 纯函数 env 解析（runner 侧可调参数）：无副作用、可单测。
// 约定：非法/越界一律回退默认值（fail-open 到安全默认，不阻断 run）。

/**
 * 通用整数 env 解析：合法 = [min, max] 闭区间整数；非法（NaN/小数/越界/空串）→ defaultValue。
 */
export function parseIntEnv(raw, defaultValue, { min = 1, max = 2 ** 31 } = {}) {
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isInteger(n) || n < min || n > max) {
    return defaultValue;
  }
  return n;
}

/**
 * 解析 runToolLoop maxRounds（env ERIX_MAX_ROUNDS）。
 * 合法 = 1..200 的整数；非法（NaN/小数/越界/空串）→ defaultValue（16）。
 */
export function parseMaxRounds(raw, { defaultValue = 16, min = 1, max = 200 } = {}) {
  return parseIntEnv(raw, defaultValue, { min, max });
}

// ---------------------------------------------------------------------------
// delegation（子 run）的四个 env（issue delegation P1，2026-11-08）
//
// 与 `parseMaxRounds` 同族：**合法区间外的整数一律钳到边界并 warn**（运维写了就该看得见生效），
// 非数字 / 空串 / 小数才回退默认。注意这与上面「越界即回退默认」的通用口径**不同**，
// 因为 `ERIX_DELEGATE_CHILD_TIMEOUT_MS` 的上限是**安全边界**（必须 < agentd 的 300s F6 watchdog）：
// 静默回退成 240000 与钳到 240000 结果相同，但钳住 + warn 能让人知道「你写的值没生效」。
// ---------------------------------------------------------------------------

/**
 * delegation 总开关（**2026-11-09 决策者：默认开**）。
 *
 * 口径：**未设 / 空串 ⇒ 开**；显式值只有字符串 `'1'` 算开，其它（`'0'` / `'true'` / `'yes'` / 数字）一律关。
 * 与 `ERIX_SESSION_AUTO_TITLE` 的差别只有一处：那个是「未设 ⇒ 关」，这个是「未设 ⇒ 开」——
 * delegation 的缺省行为是「能力存在、模型可以不用」，不是「一上来就烧 token 的默认动作」。
 * 显式值仍保持「只认 `'1'`」的严格性：写错字（`'true'` / `'yes'`）宁可关掉，也别让人以为自己开了。
 */
export function isDelegateEnabled(raw) {
  if (raw === undefined || raw === null || raw === '') return true;
  return raw === '1';
}

/** 钳位版整数解析：越界 → 钳到边界并返回 `{ value, clamped }`；非整数 → 默认值。 */
export function clampIntEnv(raw, { defaultValue, min, max }) {
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isInteger(n)) {
    return { value: defaultValue, clamped: false };
  }
  if (n < min) return { value: min, clamped: true };
  if (n > max) return { value: max, clamped: true };
  return { value: n, clamped: false };
}

/** 每 FDE 子 run 并发上限（`ERIX_DELEGATE_MAX`，默认 2，钳 1..8）。 */
export function parseDelegateMax(raw) {
  return clampIntEnv(raw, { defaultValue: 2, min: 1, max: 8 });
}

/** 子 run 轮数预算（`ERIX_DELEGATE_CHILD_ROUNDS`，默认 8，钳 1..32）。 */
export function parseDelegateChildRounds(raw) {
  return clampIntEnv(raw, { defaultValue: 8, min: 1, max: 32 });
}

/**
 * 子 run 时间预算（`ERIX_DELEGATE_CHILD_TIMEOUT_MS`，默认 240000，钳 1000..240000）。
 * ⚠ **上限必须 < 300000**：agentd 的 F6 watchdog 默认 300s，子 run 执行期父 worker 靠子的心跳
 * 刷 `lastIpcAt`；一旦子的预算超过 watchdog 且心跳没来（例如子卡在单个长 shell 里），
 * 父 worker 会被 SIGKILL 并**重放整条命令**（issue #288 的真机形状）。改这个上限要连 watchdog 一起想。
 */
export function parseDelegateChildTimeoutMs(raw) {
  return clampIntEnv(raw, { defaultValue: 240_000, min: 1_000, max: 240_000 });
}

