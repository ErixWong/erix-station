// 通过 Gitea/GitLab 管理 API 为 FDE 建账号并铸最小范围的 Git token。
// 所有上游错误都只包含 provider 与 HTTP 状态，不透传响应体或凭据。
import crypto from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 10_000;
const httpErrorResponses = new WeakMap();

export class GitMintError extends Error {
  constructor(code, message, { httpStatus = 502 } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function inputBase(baseUrl, adminKey, login) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new GitMintError('git_host_invalid', 'git host base_url is invalid', { httpStatus: 400 });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password
      || parsed.search || parsed.hash) {
    throw new GitMintError('git_host_invalid', 'git host base_url is invalid', { httpStatus: 400 });
  }
  if (typeof adminKey !== 'string' || adminKey.trim() === '') {
    throw new GitMintError('git_admin_key_missing', 'git host admin key is not configured', { httpStatus: 400 });
  }
  if (typeof login !== 'string' || login.trim() === '' || login.length > 255
      || /[\u0000-\u001f\u007f]/.test(login)) {
    throw new GitMintError('git_login_invalid', 'remote login is invalid', { httpStatus: 400 });
  }
  return parsed.href.replace(/\/+$/, '');
}

function apiUrl(base, path) {
  return `${base}${path}`;
}

async function requestJson({ fetchImpl, timeoutMs, provider, url, method, headers, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method,
      headers: { accept: 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = {};
    if (text !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        throw new GitMintError('git_host_invalid_response', `${provider} API returned invalid JSON`);
      }
    }
    if (!response.ok) {
      const error = new GitMintError('git_host_request_failed', `${provider} API request failed (HTTP ${response.status})`);
      httpErrorResponses.set(error, { status: response.status, data });
      throw error;
    }
    return data;
  } catch (err) {
    if (err instanceof GitMintError) throw err;
    if (controller.signal.aborted || err?.name === 'AbortError') {
      throw new GitMintError('git_host_timeout', `${provider} API request timed out`);
    }
    throw new GitMintError('git_host_unreachable', `${provider} API request failed`);
  } finally {
    clearTimeout(timer);
  }
}

function tokenResult(provider, data) {
  const tokenRef = data?.id ?? data?.token_id;
  const tokenPlaintext = provider === 'gitea' ? (data?.sha1 ?? data?.token) : data?.token;
  if ((typeof tokenRef !== 'string' && typeof tokenRef !== 'number')
      || typeof tokenPlaintext !== 'string' || tokenPlaintext.length === 0) {
    throw new GitMintError('git_host_invalid_response', `${provider} API omitted token details`);
  }
  return { tokenRef: String(tokenRef), tokenPlaintext };
}

function randomPassword() {
  return crypto.randomBytes(32).toString('base64url');
}

function isGiteaUserExistsError(error) {
  const response = httpErrorResponses.get(error);
  if (!response || ![409, 422].includes(response.status)) return false;
  const messages = [];
  const collectStrings = (value) => {
    if (typeof value === 'string') messages.push(value);
    else if (Array.isArray(value)) value.forEach(collectStrings);
    else if (value && typeof value === 'object') Object.values(value).forEach(collectStrings);
  };
  collectStrings(response.data);
  return messages.some((message) => (
    /\balready\b.{0,40}\b(?:exist(?:s|ed)?|taken|registered|in\s+use)\b/i.test(message)
    || /\b(?:user|username|login(?:_name|\s+name)?)\b.{0,40}\b(?:exists?|already\s+(?:taken|registered))\b/i.test(message)
  ));
}

function giteaExistingUser(data) {
  if ((typeof data?.id !== 'number' && typeof data?.id !== 'string')
      || typeof data?.login !== 'string' || data.login === ''
      || typeof data?.login_name !== 'string'
      || typeof data?.source_id !== 'number') {
    throw new GitMintError('git_host_invalid_response', 'gitea API omitted user details');
  }
  return { login: data.login, loginName: data.login_name, sourceId: data.source_id };
}

async function mintGitea({ baseUrl, adminKey, login, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const base = inputBase(baseUrl, adminKey, login);
  const password = randomPassword();
  const authorization = `token ${adminKey}`;
  let created = false;
  let remoteLogin = login;
  try {
    let user;
    try {
      user = await requestJson({
        fetchImpl,
        timeoutMs,
        provider: 'gitea',
        url: apiUrl(base, '/api/v1/admin/users'),
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: {
          username: login,
          email: `station-${crypto.randomBytes(12).toString('hex')}@users.invalid`,
          password,
          must_change_password: false,
          send_notify: false,
        },
      });
      created = true;
      remoteLogin = user?.login ?? user?.username ?? login;
    } catch (err) {
      if (!isGiteaUserExistsError(err)) throw err;
      const existing = giteaExistingUser(await requestJson({
        fetchImpl,
        timeoutMs,
        provider: 'gitea',
        url: apiUrl(base, `/api/v1/users/${encodeURIComponent(login)}`),
        method: 'GET',
        headers: { authorization },
      }));
      remoteLogin = existing.login;

      // Gitea has no admin endpoint to mint another user's token; its user token endpoint
      // requires that user's password, and exchanging an existing token returns 401.
      // In minted mode, holding the Gitea admin key therefore permits password resets
      // for platform-managed accounts; this is an inherent, expected capability.
      await requestJson({
        fetchImpl,
        timeoutMs,
        provider: 'gitea',
        url: apiUrl(base, `/api/v1/admin/users/${encodeURIComponent(remoteLogin)}`),
        method: 'PATCH',
        headers: { authorization, 'content-type': 'application/json' },
        // Gitea rejects PATCH without login_name and source_id (422 [LoginName]: Required);
        // preserve both values returned by GET while resetting only the password.
        body: {
          login_name: existing.loginName,
          source_id: existing.sourceId,
          password,
          must_change_password: false,
        },
      });
    }

    const token = await requestJson({
      fetchImpl,
      timeoutMs,
      provider: 'gitea',
      url: apiUrl(base, `/api/v1/users/${encodeURIComponent(remoteLogin)}/tokens`),
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${remoteLogin}:${password}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      // #148 real-host acceptance (Gitea 1.27.2, worker UID 1002, delivered tea
      // config): tea pulls create failed with "token does not have at least one of
      // required scope(s), required=[read:issue], token scope=write:repository,write:user".
      // `read:issue` supports PR/issue reads and PR creation; both read:issue and
      // write:issue variants created a PR in acceptance, so grant the minimum.
      // Do not grant write:issue: issue creation/comments are out of scope pending
      // a future decision. write:user allows repo creation under the FDE account;
      // write:repository allows repository access and push. `--owner <org>` instead
      // requires write:organization, intentionally not granted pending a decision.
      body: {
        name: `erix-station-${crypto.randomBytes(8).toString('hex')}`,
        scopes: ['write:user', 'write:repository', 'read:issue'],
      },
    });
    const { tokenRef, tokenPlaintext } = tokenResult('gitea', token);
    return { remoteLogin, tokenRef, tokenPlaintext };
  } catch (err) {
    if (created) {
      // #148 real-host acceptance confirms offboarding leaves upstream Gitea accounts.
      // Never delete a reused account if resetting it or minting its token fails.
      await requestJson({
        fetchImpl,
        timeoutMs,
        provider: 'gitea',
        url: apiUrl(base, `/api/v1/admin/users/${encodeURIComponent(remoteLogin)}`),
        method: 'DELETE',
        headers: { authorization },
      }).catch(() => {});
    }
    if (created && !(err instanceof GitMintError)) {
      // No upstream exception text is surfaced because it may contain request credentials.
      throw new GitMintError('git_host_unreachable', 'gitea API request failed');
    }
    throw err;
  }
}

async function mintGitlab({ baseUrl, adminKey, login, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const base = inputBase(baseUrl, adminKey, login);
  const password = randomPassword();
  const headers = { 'private-token': adminKey, 'content-type': 'application/json' };
  let userId = null;
  try {
    const user = await requestJson({
      fetchImpl,
      timeoutMs,
      provider: 'gitlab',
      url: apiUrl(base, '/api/v4/users'),
      method: 'POST',
      headers,
      body: {
        username: login,
        name: login,
        email: `station-${crypto.randomBytes(12).toString('hex')}@users.invalid`,
        password,
        skip_confirmation: true,
      },
    });
    userId = user?.id;
    if (typeof userId !== 'number' && typeof userId !== 'string') {
      throw new GitMintError('git_host_invalid_response', 'gitlab API omitted user id');
    }
    const token = await requestJson({
      fetchImpl,
      timeoutMs,
      provider: 'gitlab',
      url: apiUrl(base, `/api/v4/users/${encodeURIComponent(userId)}/impersonation_tokens`),
      method: 'POST',
      headers,
      body: {
        name: `erix-station-${crypto.randomBytes(8).toString('hex')}`,
        // glab repo create creates a project, but GitLab's CLI docs do not state its
        // minimum scope. write_repository supports Git-over-HTTP only, not API auth;
        // `api` is the documented API read/write scope. Do not treat this token as
        // sufficient for API-based project creation; leave unchanged pending a decision.
        scopes: ['write_repository'],
      },
    });
    const { tokenRef, tokenPlaintext } = tokenResult('gitlab', token);
    return { remoteLogin: user?.username ?? login, tokenRef, tokenPlaintext };
  } catch (err) {
    if (userId !== null) {
      await requestJson({
        fetchImpl,
        timeoutMs,
        provider: 'gitlab',
        url: apiUrl(base, `/api/v4/users/${encodeURIComponent(userId)}`),
        method: 'DELETE',
        headers: { 'private-token': adminKey },
      }).catch(() => {});
    }
    throw err;
  }
}

export async function mintGiteaAccount(options = {}) {
  return mintGitea(options);
}

export async function mintGitlabAccount(options = {}) {
  return mintGitlab(options);
}

export async function mintGitAccount({ provider, mode, ...options } = {}) {
  if (mode !== 'minted' || !['gitea', 'gitlab'].includes(provider)) {
    throw new GitMintError('mint_unsupported', `platform token minting is unsupported for ${provider ?? 'unknown'} (${mode ?? 'unknown'})`, {
      httpStatus: 400,
    });
  }
  return provider === 'gitea' ? mintGiteaAccount(options) : mintGitlabAccount(options);
}
