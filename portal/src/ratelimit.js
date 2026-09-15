// 登录/TOTP 失败限流（内存态，单实例）+ 并发 KDF 信号量。
// 依据：docs/api/portal.md §2.2/§2.3（失败达阈值 → 429 rate_limited + Retry-After）。
// 内存态在 portal 重启后清空——P1 单实例可接受（状态真相在 DB；此处仅作爆破缓解与 scrypt 资源保护）。

/**
 * 简单失败计数限流器。
 *   maxFailures: 窗口内连续失败多少次后封禁
 *   windowMs:    失败计数窗口（超过后自动清零）
 *   blockMs:     封禁时长（封禁期间一律拒绝，带 Retry-After）
 *   maxEntries:  Map 最大条目数（超限按最旧淘汰，防内存泄漏）
 *
 * prune 同时清理：①未封禁但已超出窗口的陈旧条目；②封禁已过期且超出窗口的条目。
 */
export function createRateLimiter({ maxFailures = 5, windowMs = 15 * 60 * 1000, blockMs = 60 * 1000, maxEntries = 10000 } = {}) {
  const entries = new Map(); // key -> { failures, lastFailureAt, blockedUntil }

  function isExpired(e, now) {
    if (e.blockedUntil && now < e.blockedUntil) return false; // 仍在封禁期
    return now - e.lastFailureAt > windowMs; // 封禁已过期（或从未封禁）且已超出窗口
  }

  function prune(now) {
    for (const [key, e] of entries) {
      if (isExpired(e, now)) entries.delete(key);
    }
  }

  /** 超限时按最旧（lastFailureAt 最小）淘汰，避免 Map 无界增长。 */
  function evictOldest(now) {
    let oldestKey = null;
    let oldestAt = now;
    for (const [key, e] of entries) {
      if (e.lastFailureAt <= oldestAt) {
        oldestAt = e.lastFailureAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) entries.delete(oldestKey);
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
      if (entries.size >= maxEntries) evictOldest(now);
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

  return { check, recordFailure, reset, size: () => entries.size };
}

/**
 * 计数信号量：限制并发执行的重量级操作（scrypt KDF）。
 *   max：            最大并发数
 *   maxQueue：       等待队列长度上限（队列满时快速失败，不让请求无限排队）
 *   queueTimeoutMs： 排队超时（超时快速失败）
 * acquire() 在队列满或超时时 reject，错误对象带 code（'kdf_queue_full' | 'kdf_queue_timeout'）。
 */
export function createSemaphore({ max = 4, maxQueue = 100, queueTimeoutMs = 30000 } = {}) {
  let active = 0;
  const queue = []; // [{ resolve, reject, timer }]

  const kdfError = (code, message) => {
    const err = new Error(message);
    err.code = code;
    return err;
  };

  const acquire = () =>
    new Promise((resolve, reject) => {
      if (active < max) {
        active += 1;
        resolve();
        return;
      }
      if (queue.length >= maxQueue) {
        reject(kdfError('kdf_queue_full', 'KDF queue full'));
        return;
      }
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const idx = queue.indexOf(entry);
        if (idx !== -1) queue.splice(idx, 1);
        reject(kdfError('kdf_queue_timeout', 'KDF queue timeout'));
      }, queueTimeoutMs);
      queue.push(entry);
    });

  const release = () => {
    const next = queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(); // 把名额直接转交给等待者
    } else {
      active -= 1;
    }
  };

  return { acquire, release, active: () => active, pending: () => queue.length };
}
