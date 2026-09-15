// 登录/TOTP 失败限流（内存态，单实例）+ 并发 KDF 信号量。
// 依据：docs/api/portal.md §2.2/§2.3（失败达阈值 → 429 rate_limited + Retry-After）。
// 内存态在 portal 重启后清空——P1 单实例可接受（状态真相在 DB；此处仅作爆破缓解与 scrypt 资源保护）。

/**
 * 简单失败计数限流器。
 *   maxFailures: 窗口内连续失败多少次后封禁
 *   windowMs:    失败计数窗口（超过后自动清零）
 *   blockMs:     封禁时长（封禁期间一律拒绝，带 Retry-After）
 */
export function createRateLimiter({ maxFailures = 5, windowMs = 15 * 60 * 1000, blockMs = 60 * 1000 } = {}) {
  const entries = new Map(); // key -> { failures, lastFailureAt, blockedUntil }

  function prune(now) {
    for (const [key, e] of entries) {
      if (!e.blockedUntil && now - e.lastFailureAt > windowMs) entries.delete(key);
    }
  }

  function check(key, now = Date.now()) {
    prune(now);
    const e = entries.get(key);
    if (e && e.blockedUntil && now < e.blockedUntil) {
      return { allowed: false, retryAfterSeconds: Math.ceil((e.blockedUntil - now) / 1000) };
    }
    return { allowed: true };
  }

  function recordFailure(key, now = Date.now()) {
    prune(now);
    let e = entries.get(key);
    if (!e) {
      e = { failures: 0, lastFailureAt: now, blockedUntil: 0 };
      entries.set(key, e);
    }
    if (e.blockedUntil && now >= e.blockedUntil) {
      e.failures = 0;
      e.blockedUntil = 0;
    }
    e.failures += 1;
    e.lastFailureAt = now;
    if (e.failures >= maxFailures) {
      e.blockedUntil = now + blockMs;
    }
    const retryAfterSeconds = e.blockedUntil ? Math.ceil((e.blockedUntil - now) / 1000) : 0;
    return { allowed: false, failures: e.failures, retryAfterSeconds };
  }

  function reset(key) {
    entries.delete(key);
  }

  return { check, recordFailure, reset };
}

/** 计数信号量：限制并发执行的重量级操作（scrypt KDF）。 */
export function createSemaphore(max = 4) {
  let active = 0;
  const queue = [];
  const acquire = () =>
    new Promise((resolve) => {
      if (active < max) {
        active += 1;
        resolve();
        return;
      }
      queue.push(resolve);
    });
  const release = () => {
    const next = queue.shift();
    if (next) next(); // 把名额直接转交给等待者
    else active -= 1;
  };
  return { acquire, release };
}
