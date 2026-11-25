// issue #787：kkFileView 预览后端的「可用性探针」。
//
// 为什么需要它：docx/xlsx/pptx/zip 一律走 kkFileView 通道，但 kk 是否配置/可达系统此前不知道。
// 签票永远成功（本地 HMAC），iframe 拿到 502 后父页面跨域读不到 ⇒ 用户看到白框里一段 JSON，
// 且没有下载兜底。本模块把「有没有 kk」变成一个可探测的状态：前端据此决定「渲染 iframe」
// 还是「降级到下载」。
//
// 探针口径（契约照抄，别自由发挥）：
//   · `configured`：baseUrl 是非空 string ⇒ true；未配置**不发任何请求**（探针不是反代）。
//   · `available`：已配置时 `GET <base 去尾斜杠>/index`，`AbortSignal.timeout`，`res.ok` ⇒ true；
//     任何异常（超时 / DNS / 连接拒绝 / 非 2xx）⇒ false，**绝不抛**（这是状态查询，不是错误）。
//   · 缓存按 **baseUrl 字符串**分槽，TTL 内命中；命中时 `checkedAt` 返回**首次探测那一刻**；
//     换地址立刻落到另一槽 ⇒ 重探。不带任何用户身份头。
export const PROBE_TIMEOUT_MS = 1200;
export const PROBE_CACHE_TTL_MS = 10_000;

/**
 * baseUrl(string) ⇒ `{ available, checkedAt, expiresAt }`。进程内单例；`resetProbeCache()` 仅供单测。
 * @type {Map<string, { available: boolean, checkedAt: string, expiresAt: number }>}
 */
const probeCache = new Map();

/** 清空探针缓存（**仅供单测**：生产靠 TTL 自然过期 + 换地址换槽）。 */
export function resetProbeCache() {
  probeCache.clear();
}

/**
 * 探测一个 kkFileView base URL 是否配置且可达。
 *
 * @param {object} [opts]
 * @param {unknown} [opts.baseUrl] 生效的 base URL（热读结果；非 string / 空 ⇒ 视为未配置）
 * @param {(input: any, init?: any) => Promise<any>} [opts.fetchImpl] 注入的 fetch（默认真实
 *   `globalThis.fetch`；单测塞桩数请求次数 / 造超时与非 2xx）
 * @param {() => number} [opts.now] 时间源（默认 `Date.now`；单测可注入造 TTL 命中/过期）
 * @param {number} [opts.timeoutMs] 单次探测超时（默认 `PROBE_TIMEOUT_MS`）
 * @param {number} [opts.cacheTtlMs] 缓存 TTL（默认 `PROBE_CACHE_TTL_MS`）
 * @returns {Promise<{ configured: boolean, available: boolean, checkedAt: string }>}
 *   `checkedAt` 是 ISO 串；**永不抛**、**永不回 baseUrl**（探针结果里不该出现内网坐标）。
 */
export async function probePreviewBackend({
  baseUrl,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = PROBE_TIMEOUT_MS,
  cacheTtlMs = PROBE_CACHE_TTL_MS,
} = {}) {
  const configured = typeof baseUrl === 'string' && baseUrl.trim() !== '';
  // 未配置 ⇒ 不发请求，直接给「不可用」；checkedAt 仍取当下（保持形状一致，前端不用分叉）。
  if (!configured) {
    return { configured: false, available: false, checkedAt: new Date(now()).toISOString() };
  }

  const slotKey = baseUrl;
  const cached = probeCache.get(slotKey);
  if (cached && cached.expiresAt > now()) {
    return { configured: true, available: cached.available, checkedAt: cached.checkedAt };
  }

  const checkedAt = new Date(now()).toISOString();
  let available = false;
  try {
    const target = `${baseUrl.replace(/\/+$/, '')}/index`;
    const res = await fetchImpl(target, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    available = Boolean(res && res.ok);
  } catch {
    // 超时 / DNS / 连接拒绝 / fetch 本身缺失 / 非 2xx（下面已置 false）都收敛到这里。绝不抛。
    available = false;
  }

  probeCache.set(slotKey, { available, checkedAt, expiresAt: now() + cacheTtlMs });
  return { configured: true, available, checkedAt };
}
