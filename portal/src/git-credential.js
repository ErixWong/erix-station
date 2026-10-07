import fs from 'node:fs';
import path from 'node:path';
import { validateFdeName } from './projects.js';
import { assertSafePath, atomicWriteFile } from './fsutil.js';
import {
  deleteGitCliConfig,
  removeAllGitCliConfigFiles,
  upsertGitCliConfig,
} from './git-cli-config.js';

const CREDENTIAL_FILE = '.git-credentials';
const FILE_MODE = 0o640;
const MAX_TOKEN_LENGTH = 4096;
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class GitCredentialError extends Error {
  constructor(code, message, { httpStatus = 400, details } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

function fail(field, message) {
  throw new GitCredentialError('validation_failed', message, { details: { field } });
}

function validateFde(fdeName) {
  if (!validateFdeName(fdeName).ok) fail('fde_name', 'fde_name 非法');
}

function validateHost(host) {
  if (typeof host !== 'string' || host.length > 253) fail('host', 'host 必须是有效 DNS 主机名');
  let parsed;
  try {
    parsed = new URL(`https://${host}`);
  } catch {
    fail('host', 'host 必须是有效 DNS 主机名');
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    fail('host', 'host 必须是有效 DNS 主机名');
  }
  const hostname = parsed.hostname.toLowerCase();
  const labels = hostname.split('.');
  if (labels.some((label) => label.length > 63 || !DNS_LABEL_RE.test(label))) {
    fail('host', 'host 必须是有效 DNS 主机名');
  }
  return parsed.host.toLowerCase();
}

function getCredentialPath(config, fdeName) {
  validateFde(fdeName);
  if (typeof config?.userSpaceRoot !== 'string' || config.userSpaceRoot === '') {
    throw new GitCredentialError('credential_storage_unavailable', 'git credential storage unavailable', { httpStatus: 500 });
  }

  const root = path.resolve(config.userSpaceRoot);
  const homeDir = path.join(root, fdeName, 'home');
  const target = path.join(homeDir, CREDENTIAL_FILE);
  try {
    assertSafePath(root, target);
    const rootReal = fs.realpathSync(root);
    const homeReal = fs.realpathSync(homeDir);
    const relative = path.relative(rootReal, homeReal);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new GitCredentialError('credential_path_unsafe', 'git credential path is unsafe', { httpStatus: 500 });
    }
  } catch (err) {
    if (err instanceof GitCredentialError) throw err;
    if (err?.code === 'materialize_path_tampered' || err?.code === 'ELOOP') {
      throw new GitCredentialError('credential_path_unsafe', 'git credential path is unsafe', { httpStatus: 500 });
    }
    throw err;
  }
  return { root, target, homeDir };
}

export function removeGitCredentialFile({ config, fdeName } = {}) {
  validateFde(fdeName);
  if (typeof config?.userSpaceRoot !== 'string' || config.userSpaceRoot === '') {
    throw new GitCredentialError('credential_storage_unavailable', 'git credential storage unavailable', { httpStatus: 500 });
  }

  const root = path.resolve(config.userSpaceRoot);
  try {
    fs.realpathSync(root);
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
  const fdeDir = path.join(root, fdeName);
  assertSafePath(root, fdeDir);
  try {
    fs.lstatSync(fdeDir);
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }

  const homeDir = path.join(fdeDir, 'home');
  assertSafePath(root, homeDir);
  try {
    fs.lstatSync(homeDir);
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }

  const { root: safeRoot, target } = getCredentialPath(config, fdeName);
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  if (stat && !stat.isFile()) {
    throw new GitCredentialError('credential_file_invalid', 'git credential file must be a regular file', { httpStatus: 500 });
  }
  if (stat) fs.unlinkSync(target);
  removeAllGitCliConfigFiles({ root: safeRoot, homeDir });
  return Boolean(stat);
}

function readCredentialFile(target) {
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) {
      throw new GitCredentialError('credential_file_invalid', 'git credential file must be a regular file', { httpStatus: 500 });
    }
    return fs.readFileSync(fd, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return '';
    if (err?.code === 'ELOOP' || err?.code === 'materialize_path_tampered') {
      throw new GitCredentialError('credential_path_unsafe', 'git credential path is unsafe', { httpStatus: 500 });
    }
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function parseCredentialLine(line) {
  try {
    const parsed = new URL(line);
    if (!parsed.hostname) return null;
    return {
      host: parsed.host.toLowerCase(),
      protocol: parsed.protocol.slice(0, -1),
      username: decodeURIComponent(parsed.username),
      token: decodeURIComponent(parsed.password),
    };
  } catch {
    return null;
  }
}

function credentialHost(line) {
  try {
    return new URL(line).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

function fileLines(contents) {
  if (contents === '') return [];
  const lines = contents.split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  return lines.filter((line) => line.trim() !== '');
}

function serializeLines(lines) {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function replaceHostLine(contents, host, replacement) {
  const lines = fileLines(contents).filter((line) => credentialHost(line) !== host);
  if (replacement !== null) lines.push(replacement);
  return serializeLines(lines);
}

function encodeUserInfo(value) {
  try {
    return encodeURIComponent(value);
  } catch {
    fail('credential', 'credential contains invalid Unicode');
  }
}

function maskToken(token) {
  return token.length > 4 ? `****${token.slice(-4)}` : '****';
}

async function writeAudit(pool, actorId, action, fdeName, details) {
  await pool.query(
    `INSERT INTO audit_log (actor_id, action, target, details) VALUES ($1, $2, $3, $4)`,
    [actorId, action, fdeName, JSON.stringify(details)],
  );
}

async function updateAssignedAccount(pool, fdeName, host, username, configured) {
  const result = await pool.query(
    `SELECT u.id AS fde_id, a.git_host_id, h.base_url
       FROM users u
       JOIN fde_git_accounts a ON a.fde_id = u.id AND a.token_ref IS NULL
       JOIN git_hosts h ON h.id = a.git_host_id
      WHERE u.fde_name = $1`,
    [fdeName],
  );
  for (const row of result.rows) {
    let assignedHost;
    try {
      assignedHost = new URL(row.base_url).host.toLowerCase();
    } catch {
      continue;
    }
    if (assignedHost !== host) continue;
    await pool.query(
      `UPDATE fde_git_accounts
          SET remote_login = $3, updated_at = now()
        WHERE fde_id = $1 AND git_host_id = $2 AND token_ref IS NULL`,
      [row.fde_id, row.git_host_id, configured ? username : null],
    );
    await pool.query(
      `UPDATE users SET status = $2
        WHERE id = $1 AND status = $3`,
      [row.fde_id, configured ? 'active' : 'awaiting_credential', configured ? 'awaiting_credential' : 'active'],
    );
  }
}

function validateUsername(username) {
  if (typeof username !== 'string' || username.trim().length === 0 || username.length > 255 || /[\u0000-\u001f\u007f]/.test(username)) {
    fail('username', 'username 必须是非空文本');
  }
}

function validateToken(token) {
  if (typeof token !== 'string' || token.trim().length === 0) fail('token', 'token 不能为空');
  if (token.length > MAX_TOKEN_LENGTH) fail('token', `token 长度不能超过 ${MAX_TOKEN_LENGTH}`);
}

function validateProtocol(protocol) {
  if (protocol === undefined) return undefined;
  if (protocol !== 'http' && protocol !== 'https') fail('protocol', 'protocol 必须是 http 或 https');
  return protocol;
}

async function resolveGitHost(pool, host) {
  const result = await pool.query('SELECT base_url, provider FROM git_hosts');
  for (const row of result.rows) {
    try {
      const baseUrl = new URL(row.base_url);
      if (baseUrl.host.toLowerCase() !== host) continue;
      return {
        protocol: baseUrl.protocol === 'http:' ? 'http' : baseUrl.protocol === 'https:' ? 'https' : undefined,
        provider: row.provider,
      };
    } catch {
      // Invalid configuration rows cannot identify a credential host.
    }
  }
  return {};
}

function assertAuditPool(pool) {
  if (typeof pool?.query !== 'function') {
    throw new GitCredentialError('audit_unavailable', 'credential audit unavailable', { httpStatus: 500 });
  }
}

export async function setGitCredential({ pool, actorId = null, config, fdeName, host, username, token, protocol } = {}) {
  const normalizedHost = validateHost(host);
  validateFde(fdeName);
  validateUsername(username);
  validateToken(token);
  const requestedProtocol = validateProtocol(protocol);
  assertAuditPool(pool);
  const { root, target, homeDir } = getCredentialPath(config, fdeName);
  const contents = readCredentialFile(target);
  const registeredHost = await resolveGitHost(pool, normalizedHost);
  const scheme = requestedProtocol ?? registeredHost.protocol ?? 'https';
  const credentialLine = `${scheme}://${encodeUserInfo(username)}:${encodeUserInfo(token)}@${normalizedHost}`;
  const nextContents = replaceHostLine(contents, normalizedHost, credentialLine);
  atomicWriteFile(target, nextContents, {
    mode: FILE_MODE,
    uid: config.fdeUid ?? 1000,
    gid: config.fdeGid ?? 1000,
    root,
  });
  upsertGitCliConfig({
    root,
    homeDir,
    config,
    provider: registeredHost.provider,
    host: normalizedHost,
    username,
    token,
    protocol: scheme,
  });
  await writeAudit(pool, actorId, 'admin.git_credential_set', fdeName, {
    fde_name: fdeName,
    host: normalizedHost,
  });
  await updateAssignedAccount(pool, fdeName, normalizedHost, username, true);
  return { host: normalizedHost, username, configured: true };
}

export async function deleteGitCredential({ pool, actorId = null, config, fdeName, host } = {}) {
  const normalizedHost = validateHost(host);
  validateFde(fdeName);
  assertAuditPool(pool);
  const { root, target, homeDir } = getCredentialPath(config, fdeName);
  const registeredHost = await resolveGitHost(pool, normalizedHost);
  const contents = readCredentialFile(target);
  const lines = fileLines(contents);
  const nextLines = lines.filter((line) => credentialHost(line) !== normalizedHost);
  const deleted = nextLines.length !== lines.length;
  atomicWriteFile(target, serializeLines(nextLines), {
    mode: FILE_MODE,
    uid: config.fdeUid ?? 1000,
    gid: config.fdeGid ?? 1000,
    root,
  });
  deleteGitCliConfig({
    root,
    homeDir,
    config,
    provider: registeredHost.provider,
    host: normalizedHost,
  });
  await writeAudit(pool, actorId, 'admin.git_credential_deleted', fdeName, {
    fde_name: fdeName,
    host: normalizedHost,
    deleted,
  });
  if (deleted) await updateAssignedAccount(pool, fdeName, normalizedHost, null, false);
  return { host: normalizedHost, deleted };
}

export async function listGitCredentials({ config, fdeName } = {}) {
  const { target } = getCredentialPath(config, fdeName);
  const hosts = [];
  for (const line of fileLines(readCredentialFile(target))) {
    const credential = parseCredentialLine(line);
    if (!credential?.username || !credential.token) continue;
    hosts.push({
      host: credential.host,
      protocol: credential.protocol,
      username: credential.username,
      token: maskToken(credential.token),
    });
  }
  return { hosts };
}
