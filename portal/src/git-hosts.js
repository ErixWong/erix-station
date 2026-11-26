// Git host 注册表：admin_key 仅在写入时接收，列表与更新响应永远只返回掩码。

const HOST_FIELDS = `id, name, provider, base_url, admin_key, mode, enabled, created_at, updated_at`;
const PROVIDERS = new Set(['gitea', 'github', 'gitlab']);
const MINT_PROVIDERS = new Set(['gitea', 'gitlab']);

export class GitHostError extends Error {
  constructor(code, message, { httpStatus = 400, details, en } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    // issue #803 S2-D：可选英文对（同 AdminError/HttpError/SessionError/DirError 口径）。`super(message)` 仍传中文原文，
    // http.js 的 pickMessage 按 locale 读 `err.en`，缺省照旧出中文——错误体形状与 message 一字不动。
    this.en = en;
  }
}

function fail(field, message) {
  throw new GitHostError('validation_failed', message, { details: { field } });
}

function objectInput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('body', '请求体必须是对象');
  return value;
}

function cleanName(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > 120
      || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('name', 'name 必须是 1–120 个字符');
  }
  return value.trim();
}

function cleanProvider(value) {
  if (value === 'azure') {
    throw new GitHostError('provider_unsupported', 'azure provider 尚不支持', { httpStatus: 400, en: 'the azure provider is not yet supported', details: { field: 'provider' } });
  }
  if (typeof value !== 'string' || !PROVIDERS.has(value)) {
    fail('provider', 'provider 必须是 gitea、github 或 gitlab');
  }
  return value;
}

function cleanBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') fail('base_url', 'base_url 为必填字段');
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    fail('base_url', 'base_url 必须是有效的绝对 URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('base_url', 'base_url 仅支持不含凭据、查询或片段的 http/https URL');
  }
  return parsed.href.replace(/\/+$/, '');
}

function cleanAdminKey(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('admin_key', 'admin_key 必须是有效的非空文本');
  }
  return value.trim();
}

function modeFor(provider, adminKey) {
  if (adminKey !== null && !MINT_PROVIDERS.has(provider)) {
    throw new GitHostError('admin_key_unsupported', '该 provider 不支持平台代铸，不能配置 admin_key', {
      httpStatus: 400,
      en: 'this provider does not support platform-managed token minting, so admin_key cannot be configured',
      details: { field: 'admin_key' },
    });
  }
  return MINT_PROVIDERS.has(provider) && adminKey !== null ? 'minted' : 'per_fde_pat';
}

function maskAdminKey(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length <= 4 ? '****' : `****${value.slice(-4)}`;
}

function toGitHost(row) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    base_url: row.base_url,
    admin_key: maskAdminKey(row.admin_key),
    admin_key_configured: row.admin_key != null,
    mode: row.mode,
    enabled: row.enabled,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function mapConflict(err) {
  if (err?.code === '23505') {
    throw new GitHostError('name_conflict', 'git host name 已存在', { httpStatus: 409, en: 'the git host name is already taken' });
  }
}

export async function listGitHosts(pool) {
  const result = await pool.query(`SELECT ${HOST_FIELDS} FROM git_hosts ORDER BY name`);
  return { items: result.rows.map(toGitHost) };
}

export async function createGitHost(pool, fields = {}) {
  fields = objectInput(fields);
  if (fields.mode !== undefined) fail('mode', 'mode 由 provider 与 admin_key 自动决定');
  const name = cleanName(fields.name);
  const provider = cleanProvider(fields.provider);
  const baseUrl = cleanBaseUrl(fields.base_url);
  const adminKey = cleanAdminKey(fields.admin_key);
  const mode = modeFor(provider, adminKey);
  const enabled = fields.enabled === undefined ? true : fields.enabled;
  if (typeof enabled !== 'boolean') fail('enabled', 'enabled 必须是布尔值');
  try {
    const result = await pool.query(
      `INSERT INTO git_hosts (name, provider, base_url, admin_key, mode, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${HOST_FIELDS}`,
      [name, provider, baseUrl, adminKey, mode, enabled],
    );
    return toGitHost(result.rows[0]);
  } catch (err) {
    mapConflict(err);
    throw err;
  }
}

export async function updateGitHost(pool, id, fields = {}) {
  fields = objectInput(fields);
  const currentResult = await pool.query(`SELECT ${HOST_FIELDS} FROM git_hosts WHERE id = $1`, [id]);
  const current = currentResult.rows[0];
  if (!current) throw new GitHostError('not_found', 'git host 不存在', { httpStatus: 404, en: 'the git host does not exist' });

  if (fields.mode !== undefined) fail('mode', 'mode 由 provider 与 admin_key 自动决定');
  if (fields.clear_admin_key !== undefined && typeof fields.clear_admin_key !== 'boolean') {
    fail('clear_admin_key', 'clear_admin_key 必须是布尔值');
  }
  if (fields.clear_admin_key === true && fields.admin_key != null && fields.admin_key !== '') {
    fail('admin_key', 'clear_admin_key 不能与 admin_key 同时设置');
  }

  const name = fields.name === undefined ? current.name : cleanName(fields.name);
  const provider = fields.provider === undefined ? current.provider : cleanProvider(fields.provider);
  const baseUrl = fields.base_url === undefined ? current.base_url : cleanBaseUrl(fields.base_url);
  let adminKey = current.admin_key;
  if (fields.clear_admin_key === true) adminKey = null;
  else if (fields.admin_key !== undefined && fields.admin_key !== null && fields.admin_key !== '') {
    adminKey = cleanAdminKey(fields.admin_key);
  }
  const mode = modeFor(provider, adminKey);
  const enabled = fields.enabled === undefined ? current.enabled : fields.enabled;
  if (typeof enabled !== 'boolean') fail('enabled', 'enabled 必须是布尔值');

  if ((provider !== current.provider || baseUrl !== current.base_url)
      && (await pool.query('SELECT 1 FROM fde_git_accounts WHERE git_host_id = $1 LIMIT 1', [id])).rows.length > 0) {
    throw new GitHostError('host_in_use', '已有 FDE 使用该 host，不能更改 provider 或 base_url', { httpStatus: 409, en: 'an FDE already uses this host, so provider or base_url cannot be changed' });
  }

  try {
    const result = await pool.query(
      `UPDATE git_hosts
          SET name = $2, provider = $3, base_url = $4, admin_key = $5, mode = $6,
              enabled = $7, updated_at = now()
        WHERE id = $1
        RETURNING ${HOST_FIELDS}`,
      [id, name, provider, baseUrl, adminKey, mode, enabled],
    );
    if (!result.rows[0]) throw new GitHostError('not_found', 'git host 不存在', { httpStatus: 404, en: 'the git host does not exist' });
    return toGitHost(result.rows[0]);
  } catch (err) {
    mapConflict(err);
    throw err;
  }
}

export async function deleteGitHost(pool, id) {
  const used = await pool.query('SELECT 1 FROM fde_git_accounts WHERE git_host_id = $1 LIMIT 1', [id]);
  if (used.rows.length > 0) {
    throw new GitHostError('host_in_use', '仍有 FDE 使用该 host，不能删除', { httpStatus: 409, en: 'an FDE still uses this host, so it cannot be deleted' });
  }
  try {
    const result = await pool.query('DELETE FROM git_hosts WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) throw new GitHostError('not_found', 'git host 不存在', { httpStatus: 404, en: 'the git host does not exist' });
  } catch (err) {
    if (err instanceof GitHostError) throw err;
    if (err?.code === '23503') {
      throw new GitHostError('host_in_use', '仍有 FDE 使用该 host，不能删除', { httpStatus: 409, en: 'an FDE still uses this host, so it cannot be deleted' });
    }
    throw err;
  }
}
