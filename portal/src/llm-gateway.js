// Zero-dependency LiteLLM admin API client. Never include credentials in errors.
import { createHash } from 'node:crypto';

// issue #719 评审必修 1：`/key/info` 是 GET，明文虚拟 key 会拼进 URL 的 query（`?key=sk-...`），
// 而 LiteLLM 的 access log 会记录完整请求 URL ⇒ 明文 key 落盘。改传 **key 的 sha256 hex**：
// LiteLLM v1.103.2 的 `/key/info` 接受 token 的 sha256（主 agent 真机验过：`?key=<64位hex>` ⇒ 200，
// key_alias/spend 均正确），既保留查询能力又不泄露明文。**脱敏责任在本模块**：调用方（llm.js）永远
// 给明文 key，只有出网时换成 hash，所有既有调用点（不只 #719 新加的）因此一并受益。
export function hashKeyForInfo(key) {
  return createHash('sha256').update(String(key ?? '')).digest('hex');
}

export class LlmGatewayError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'LlmGatewayError';
    this.status = status;
    this.upstreamMessage = message;
  }
}

function collectSecrets(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectSecrets(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/^(api[_-]?key|master[_-]?key|authorization|key)$/i.test(key) && typeof child === 'string' && child) {
        out.push(child);
      } else if (/^keys$/i.test(key) && Array.isArray(child)) {
        out.push(...child.filter((item) => typeof item === 'string' && item));
      } else {
        collectSecrets(child, out);
      }
    }
  }
  return out;
}

function safeMessage(message, secrets) {
  let safe = String(message ?? 'LiteLLM request failed');
  for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) {
    safe = safe.split(secret).join('[redacted]');
  }
  safe = safe.replace(
    /((?:api[_-]?key|master[_-]?key|authorization)\s*["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
    '$1[redacted]',
  );
  safe = safe.replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/gi, '[redacted]');
  return safe.slice(0, 500);
}

function errorMessage(body) {
  if (body && typeof body === 'object') {
    const message = body.error?.message ?? body.detail ?? body.message;
    if (typeof message === 'string' && message) return message;
  }
  return typeof body === 'string' && body ? body : 'LiteLLM request failed';
}

export function createLlmGatewayClient({
  adminUrl,
  masterKey,
  fetchImpl = fetch,
  timeoutMs = 10_000,
} = {}) {
  let baseUrl;
  try {
    const parsed = new URL(adminUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('invalid URL');
    }
    parsed.search = '';
    parsed.hash = '';
    baseUrl = parsed.toString().replace(/\/+$/, '');
  } catch {
    throw new TypeError('LiteLLM adminUrl must be a valid HTTP(S) URL');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');

  async function request(method, pathname, { body, query } = {}) {
    if (typeof masterKey !== 'string' || masterKey.length === 0) {
      throw new LlmGatewayError(503, 'LiteLLM master key is not configured');
    }
    const url = new URL(`${baseUrl}${pathname}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value != null) url.searchParams.set(key, String(value));
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const secrets = [masterKey, ...collectSecrets(body), ...collectSecrets(query)];
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${masterKey}`,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new LlmGatewayError(504, `LiteLLM request timed out after ${timeoutMs}ms`);
        }
        throw new LlmGatewayError(502, safeMessage(err?.message || 'LiteLLM request failed', secrets));
      }
      let text;
      try {
        text = await response.text();
      } catch (err) {
        if (controller.signal.aborted) {
          throw new LlmGatewayError(504, `LiteLLM request timed out after ${timeoutMs}ms`);
        }
        throw new LlmGatewayError(502, safeMessage(err?.message || 'LiteLLM request failed', secrets));
      }
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      }
      if (!response.ok) {
        throw new LlmGatewayError(response.status, safeMessage(errorMessage(payload), secrets));
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  const post = (path, body) => request('POST', path, { body });
  const patch = (path, body) => request('PATCH', path, { body });
  const namePath = (name) => `/credentials/${encodeURIComponent(name)}`;
  return Object.freeze({
    createUser: (body) => post('/user/new', body),
    generateKey: (body) => post('/key/generate', body),
    updateKey: (body) => post('/key/update', body),
    deleteKey: (body) => post('/key/delete', body),
    blockKey: (body) => post('/key/block', body),
    unblockKey: (body) => post('/key/unblock', body),
    keyInfo: (key) => request('GET', '/key/info', { query: { key: hashKeyForInfo(key) } }),
    // issue #719：读 LiteLLM 自己的每日用量聚合端点，portal 绝不自算 token。
    userDailyActivity: (query) => request('GET', '/user/daily/activity/aggregated', { query }),
    // issue #800：整表读所有 key 的 spend/budget 字段（网关 size 上限 100，实测 v1.103.2 `le=100`）。
    listKeys: ({ page = 1, size = 100, return_full_object = true } = {}) =>
      request('GET', '/key/list', { query: { page, size, return_full_object } }),
    listModels: () => request('GET', '/model/info'),
    createModel: (body) => post('/model/new', body),
    updateModel: ({ model_id, ...body }) => patch(`/model/${encodeURIComponent(model_id)}/update`, body),
    deleteModel: (id) => post('/model/delete', { id }),
    blockModel: (modelId) => post('/model/block', { model_id: modelId }),
    unblockModel: (modelId) => post('/model/unblock', { model_id: modelId }),
    listCredentials: () => request('GET', '/credentials'),
    createCredential: (body) => post('/credentials', body),
    updateCredential: (name, body) => patch(namePath(name), body),
    deleteCredential: (name) => request('DELETE', namePath(name)),
  });
}
