import fs from 'node:fs';
import path from 'node:path';
import { validateFdeName } from './projects.js';
import { assertSafePath, atomicWriteFile, ensureDirSafe } from './fsutil.js';
import {
  deleteGitCliConfig,
  removeAllGitCliConfigFiles,
  upsertGitCliConfig,
} from './git-cli-config.js';
import { enqueueMaterializeChange } from './outbox.js';

// #399：平台托管凭据从 FDE 可写的 `home/.git-credentials` 搬进平台独占目录：
//   宿主 <userSpaceRoot>/<fde>/platform/git/credentials → 容器 /run/erix/git/credentials（ro bind）。
//   写者只剩 portal：git 自己的「认证被拒 ⇒ erase」与 agent 的整文件重写都再也碰不到它。
//   镜像 /etc/gitconfig 里平台 helper（fill-only，读 /run/erix/git/credentials）排在 store 前，先答先赢。
const CREDENTIAL_FILE = '.git-credentials'; // 遗留位置（FDE 自配凭据文件；迁移后平台不再往它写）
const PLATFORM_SUBPATH = path.join('platform', 'git', 'credentials');
const FILE_MODE = 0o640; // 遗留 home 文件的模式（存量搬运/删除时重写用）
const PLATFORM_FILE_MODE = 0o644; // 容器内 agentd(1001)/worker(1002) 需可读；ro 挂载防写，目录不是安全边界
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

/**
 * 平台独占凭据文件路径（#399）：<userSpaceRoot>/<fde>/platform/git/credentials。
 * 防逃逸同 getCredentialPath；目录不存在时由 ensurePlatformCredentialDir 创建。
 */
export function getPlatformCredentialPath(config, fdeName) {
  validateFde(fdeName);
  if (typeof config?.userSpaceRoot !== 'string' || config.userSpaceRoot === '') {
    throw new GitCredentialError('credential_storage_unavailable', 'git credential storage unavailable', { httpStatus: 500 });
  }
  const root = path.resolve(config.userSpaceRoot);
  const fdeDir = path.join(root, fdeName);
  const target = path.join(fdeDir, PLATFORM_SUBPATH);
  try {
    assertSafePath(root, target);
    const rootReal = fs.realpathSync(root);
    const fdeReal = fs.realpathSync(fdeDir);
    const relative = path.relative(rootReal, fdeReal);
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
  return { root, target };
}

/** 确保平台凭据目录存在（portal 属主，0755：容器内只读挂载仍需按 UID 可读）。 */
export function ensurePlatformCredentialDir({ config, fdeName, log = console } = {}) {
  const { root, target } = getPlatformCredentialPath(config, fdeName);
  const dir = path.dirname(target);
  ensureDirSafe(root, dir, { mode: 0o755, uid: null, gid: null, log });
  return { root, target };
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
  let removedPlatform = false;
  // #399：平台那份（platform/git/credentials）也归本函数收尾——offboarding 不留残留托管凭据。
  try {
    const platformTarget = getPlatformCredentialPath(config, fdeName).target;
    let platformStat;
    try {
      platformStat = fs.lstatSync(platformTarget);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    if (platformStat && !platformStat.isFile()) {
      throw new GitCredentialError('credential_file_invalid', 'git credential file must be a regular file', { httpStatus: 500 });
    }
    if (platformStat) {
      fs.unlinkSync(platformTarget);
      removedPlatform = true;
    }
  } catch (err) {
    if (err instanceof GitCredentialError) throw err;
    if (err?.code !== 'ENOENT') throw err;
  }
  removeAllGitCliConfigFiles({ root: safeRoot, homeDir });
  // 返回值语义 = 「本次有没有清掉凭据」：#399 后主面在平台文件，两份任一命中都算 true。
  return Boolean(stat) || removedPlatform;
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

async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 写回 FDE 的 Git 账户/用户状态。
 *
 * configured=true（投放凭据）时 awaiting_credential→active，并在**同一事务**内入队一次物化
 * revision（issue #183）：凭据到达前 FDE 处于 awaiting_credential，其平台文件可能尚未物化；
 * 状态翻转后必须补一次，否则 ~/.erix 永远缺失 → agent run ENOENT config.json 崩溃。
 * 重复入队无害（materialize revision 为 head/latest-wins，见 materializer.js 消费逻辑）。
 * configured=false（删除凭据）active→awaiting_credential 不触发物化——凭据移除不改平台文件。
 */
async function updateAssignedAccount(pool, fdeName, host, username, configured) {
  await withTransaction(pool, async (client) => {
    const result = await client.query(
      `SELECT u.id AS fde_id, a.git_host_id, h.base_url
         FROM users u
         JOIN fde_git_accounts a ON a.fde_id = u.id AND a.token_ref IS NULL
         JOIN git_hosts h ON h.id = a.git_host_id
        WHERE u.fde_name = $1`,
      [fdeName],
    );
    const materializeEnqueued = new Set();
    for (const row of result.rows) {
      let assignedHost;
      try {
        assignedHost = new URL(row.base_url).host.toLowerCase();
      } catch {
        continue;
      }
      if (assignedHost !== host) continue;
      await client.query(
        `UPDATE fde_git_accounts
            SET remote_login = $3, updated_at = now()
          WHERE fde_id = $1 AND git_host_id = $2 AND token_ref IS NULL`,
        [row.fde_id, row.git_host_id, configured ? username : null],
      );
      const flipped = await client.query(
        `UPDATE users SET status = $2
          WHERE id = $1 AND status = $3
          RETURNING id`,
        [row.fde_id, configured ? 'active' : 'awaiting_credential', configured ? 'awaiting_credential' : 'active'],
      );
      // 仅「凭据到达且确实从 awaiting_credential 翻到 active」时补物化（同事务）。
      if (configured && flipped.rows.length > 0 && !materializeEnqueued.has(row.fde_id)) {
        await enqueueMaterializeChange(client, { fdeId: row.fde_id, op: 'upsert' });
        materializeEnqueued.add(row.fde_id);
      }
    }
  });
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

/** 某 host 的行是否在文件内容里（只判存在，不回 token）。 */
function credentialHostInLines(contents, host) {
  return fileLines(contents).some((line) => credentialHost(line) === host);
}

/**
 * 存在性判据（#399 替代 token_ref）：平台那份文件里这一行在不在。
 * 用户空间尚未落盘（ENOENT）= 不在；路径篡改（path_unsafe）照抛——判据不能吞安全错误。
 */
export function platformCredentialPresent({ config, fdeName, host } = {}) {
  const normalizedHost = String(host ?? '').toLowerCase();
  let target;
  try {
    target = getPlatformCredentialPath(config, fdeName).target;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
  return credentialHostInLines(readCredentialFile(target), normalizedHost);
}

/**
 * 存量一次性搬运（#399 要点 5）：把遗留 home/.git-credentials 里指定 host 的行
 * **整行原样**搬进平台文件（token 不变、agent 无感），不新造副本。
 * 返回搬动的行数。只动目标 host，FDE 自配的其它行（如 github）一律不碰。
 */
export function migrateLegacyCredential({ config, fdeName, host, log = console } = {}) {
  const normalizedHost = String(host ?? '').toLowerCase();
  let legacy;
  try {
    legacy = getCredentialPath(config, fdeName);
  } catch (err) {
    if (err?.code === 'ENOENT') return 0; // 用户空间未落盘 = 无存量可搬
    throw err;
  }
  const legacyContents = readCredentialFile(legacy.target);
  const moved = fileLines(legacyContents).filter((line) => credentialHost(line) === normalizedHost);
  if (moved.length === 0) return 0;
  const { root: platformRoot, target: platformTarget } = ensurePlatformCredentialDir({ config, fdeName, log });
  let next = readCredentialFile(platformTarget);
  for (const line of moved) next = replaceHostLine(next, normalizedHost, line);
  atomicWriteFile(platformTarget, next, { mode: PLATFORM_FILE_MODE, root: platformRoot });
  atomicWriteFile(legacy.target, replaceHostLine(legacyContents, normalizedHost, null), {
    mode: FILE_MODE,
    uid: config.fdeUid ?? 1000,
    gid: config.fdeGid ?? 1000,
    root: legacy.root,
  });
  log.log?.(`[git-credential] migrated legacy credential line for host=${normalizedHost} fde=${fdeName} (token unchanged)`);
  return moved.length;
}

export async function setGitCredential({ pool, actorId = null, config, fdeName, host, username, token, protocol } = {}) {
  const normalizedHost = validateHost(host);
  validateFde(fdeName);
  validateUsername(username);
  validateToken(token);
  const requestedProtocol = validateProtocol(protocol);
  assertAuditPool(pool);
  // 校验顺序：遗留 home 路径（含 symlink 逃逸检查）先行，再建平台目录——两者任一不安全都零写入零审计。
  const legacy = getCredentialPath(config, fdeName);
  const legacyHome = fs.existsSync(legacy.homeDir) ? legacy : null;
  // #399：写目标从 FDE 可写的 home/.git-credentials 改为平台独占 platform/git/credentials（容器内 ro）。
  const { root: platformRoot, target: platformTarget } = ensurePlatformCredentialDir({ config, fdeName });
  const platformContents = readCredentialFile(platformTarget);
  const registeredHost = await resolveGitHost(pool, normalizedHost);
  const scheme = requestedProtocol ?? registeredHost.protocol ?? 'https';
  const credentialLine = `${scheme}://${encodeUserInfo(username)}:${encodeUserInfo(token)}@${normalizedHost}`;
  atomicWriteFile(platformTarget, replaceHostLine(platformContents, normalizedHost, credentialLine), {
    mode: PLATFORM_FILE_MODE,
    root: platformRoot,
  });
  // 遗留 home 文件不碰：旧代次容器（单条 store helper）只认它，清了会当场断认；
  // 新代次里即使残留旧行也无害——helper 逐序询问、平台那份先答，store 只在平台未命中时才兼答。
  if (legacyHome) {
    upsertGitCliConfig({
      root: legacy.root,
      homeDir: legacy.homeDir,
      config,
      provider: registeredHost.provider,
      host: normalizedHost,
      username,
      token,
      protocol: scheme,
    });
  }
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
  const { root: platformRoot, target: platformTarget } = ensurePlatformCredentialDir({ config, fdeName });
  const registeredHost = await resolveGitHost(pool, normalizedHost);
  const platformContents = readCredentialFile(platformTarget);
  const platformLines = fileLines(platformContents);
  const nextPlatformLines = platformLines.filter((line) => credentialHost(line) !== normalizedHost);
  const deleted = nextPlatformLines.length !== platformLines.length;
  atomicWriteFile(platformTarget, serializeLines(nextPlatformLines), { mode: PLATFORM_FILE_MODE, root: platformRoot });
  // 遗留文件里的同 host 行一并清（历史上两处都可能写过）。
  const legacy = getCredentialPath(config, fdeName);
  if (fs.existsSync(legacy.homeDir)) {
    const legacyContents = readCredentialFile(legacy.target);
    if (credentialHostInLines(legacyContents, normalizedHost)) {
      atomicWriteFile(legacy.target, replaceHostLine(legacyContents, normalizedHost, null), {
        mode: FILE_MODE,
        uid: config.fdeUid ?? 1000,
        gid: config.fdeGid ?? 1000,
        root: legacy.root,
      });
    }
    deleteGitCliConfig({
      root: legacy.root,
      homeDir: legacy.homeDir,
      config,
      provider: registeredHost.provider,
      host: normalizedHost,
    });
  }
  await writeAudit(pool, actorId, 'admin.git_credential_deleted', fdeName, {
    fde_name: fdeName,
    host: normalizedHost,
    deleted,
  });
  if (deleted) await updateAssignedAccount(pool, fdeName, normalizedHost, null, false);
  return { host: normalizedHost, deleted };
}

export async function listGitCredentials({ config, fdeName } = {}) {
  // #399：平台文件优先列出；遗留 home 文件里 FDE 自配的行（如 github）仍展示（只读，不归平台管）。
  // 同 host 两处都有时取平台那份（实际生效的就是它：helper 排序先答先赢）。
  const sources = [];
  try {
    sources.push(getPlatformCredentialPath(config, fdeName).target);
  } catch {
    /* userSpaceRoot 不可用交给遗留路径的同一错误 */
  }
  sources.push(getCredentialPath(config, fdeName).target);
  const hosts = [];
  const seen = new Set();
  for (const target of sources) {
    for (const line of fileLines(readCredentialFile(target))) {
      const credential = parseCredentialLine(line);
      if (!credential?.username || !credential.token) continue;
      if (seen.has(credential.host)) continue;
      seen.add(credential.host);
      hosts.push({
        host: credential.host,
        protocol: credential.protocol,
        username: credential.username,
        token: maskToken(credential.token),
      });
    }
  }
  return { hosts };
}
