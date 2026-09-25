// 纯函数 env 解析（runner 侧可调参数）：无副作用、可单测。
// 约定：非法/越界一律回退默认值（fail-open 到安全默认，不阻断 run）。

/**
 * 解析 runToolLoop maxRounds（env ERIX_MAX_ROUNDS）。
 * 合法 = 1..200 的整数；非法（NaN/小数/越界/空串）→ defaultValue（16）。
 */
export function parseMaxRounds(raw, { defaultValue = 16, min = 1, max = 200 } = {}) {
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isInteger(n) || n < min || n > max) {
    return defaultValue;
  }
  return n;
}
