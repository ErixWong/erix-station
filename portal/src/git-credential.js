import fs from 'node:fs';
import path from 'node:path';
import { validateFdeName } from './projects.js';
import { assertSafePath, atomicWriteFile } from './fsutil.js';
import {
  deleteGitCliConfig,
  removeAllGitCliConfigFiles,
  upsertGitCliConfig,
} from './git-cli-config.js';
import { enqueueMaterializeChange } from './outbox.js';

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
/**
 * 写回 FDE 的 Git 账户/用户状态（issue #395：改名 `*With(client)`，事务边界上提到调用方，
 * 让「明文落库」与「状态翻转」共享同一个事务——见 `setGitCredential`。
 *
 * configured=true（投放凭据）时 awaiting_credential→active，并在**同一事务**内入队一次物化
 * revision（issue #183）：凭据到达前 FDE 处于 awaiting_credential，其平台文件可能尚未物化；
 * 状态翻转后必须补一次，否则 ~/.erix 永远缺失 → agent run ENOENT config.json 崩溃。
 * 重复入队无害（issue #183：materialize revision 为 head/latest-wins，见 materializer.js 消费逻辑）。
 * configured=false（删除凭据）active→awaiting_credential 不触发物化——凭据移除不改平台文件。
 *
 * ⚠ 这里的 `AND token_ref IS NULL` 是**原有语义**（只认「平台不持有远端 token」的 per_fde_pat 行），
 *   不要顺手放宽：minted 行的状态翻转由 `provisioner.js` 在 mint 之后显式 `UPDATE users SET status`，
 *   两条路径各自负责自己的模式。
 */
async function updateAssignedAccountWith(client, fdeName, host, username, configured) {
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
}

/**
 * 明文 token 落库 / 清库（issue #395）。
 *
 * 为什么需要它：`minted` 模式下平台铸出的 token 明文此**只**投放到 FDE 的 `~/.git-credentials`，
 * 库里 `token_ref` 存的是远端 token ID（吊销用），不是 secret ⇒ 明文的唯一副本躺在用户态、agent 可写的
 * 文件里。真机（现网 `eric`，2026-10-25）该文件被 agent 整文件重写，gitea 那行消失，平台既无副本也不会自愈。
 *
 * 语义（`0024-git-token-plaintext.sql` 的列注释是同一口径）：
 *   `token = <明文>` ⇒ 平台持有副本，具备重投能力；
 *   `token = null`  ⇒ 平台**没有**副本（`per_fde_pat` 下 FDE 自行在容器里配的密钥、以及 #395 之前的存量行）。
 * 所以**删除凭据必须把这一列一起置 NULL**：库里留着明文，自愈逻辑就会把用户刚刚删掉的凭据又投回文件里。
 *
 * host 匹配沿用 `updateAssignedAccountWith` 的做法：URL 解析在 JS 侧（库里没有 URL 解析函数），
 * 匹配不上就一行都不动——传进来的 host 没在 `git_hosts` 注册（例如 FDE 自己配的 github.com）时，
 * **不该**凭空造出副本，也不该报错：那只意味着「平台不知道这枚 token」，与 `token IS NULL` 的语义一致。
 *
 * @param {object} client pg 客户端（必须已在事务内）
 * @param {string|null} token 明文；`null` = 清除副本（删除路径）
 * @returns {Promise<number>} 被更新的行数（0 是正常结果，不是错误）
 */
async function persistTokenPlaintext(client, fdeName, host, token) {
  const rows = await client.query(
    `SELECT a.fde_id, a.git_host_id, h.base_url
       FROM fde_git_accounts a
       JOIN git_hosts h ON h.id = a.git_host_id
       JOIN users u ON u.id = a.fde_id
      WHERE u.fde_name = $1`,
    [fdeName],
  );
  let updated = 0;
  for (const row of rows.rows) {
    let assignedHost;
    try {
      assignedHost = new URL(row.base_url).host.toLowerCase();
    } catch {
      continue;
    }
    if (assignedHost !== host) continue;
    const result = await client.query(
      `UPDATE fde_git_accounts
          SET token = $3, updated_at = now()
        WHERE fde_id = $1 AND git_host_id = $2`,
      [row.fde_id, row.git_host_id, token],
    );
    updated += result.rowCount ?? 0;
  }
  return updated;
}

/** 兼容旧调用点的自包事务版本（删除路径与既有测试沿用）。 */
async function updateAssignedAccount(pool, fdeName, host, username, configured) {
  await withTransaction(pool, async (client) => {
    await updateAssignedAccountWith(client, fdeName, host, username, configured);
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

export async function setGitCredential({ pool, actorId = null, config, fdeName, host, username, token, protocol, auditAction = 'admin.git_credential_set', auditExtra } = {}) {
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
  // issue #395：审计 + 明文落库 + 账号状态翻转，同一个事务。
  // 为什么把状态翻转也拉进来（它此前自成一事务）：这三件事是同一个事实「该 FDE 现在有这枚凭据」的
  // 三个侧面，分开提交会出现「库里说明文有了，用户还挂在 awaiting_credential」或反之的中间态，
  // 而这两个状态各自都会被抓取/自愈逻辑当真。文件写在事务**之前**（不可回滚，沿用既有设计：
  // 投放成功是既成事实，DB 记账失败时最坏退化成 #395 修之前的样子——文件有、库无副本）。
  await withTransaction(pool, async (client) => {
    await writeAudit(client, actorId, auditAction, fdeName, {
      fde_name: fdeName,
      host: normalizedHost,
      ...auditExtra,
    });
    await persistTokenPlaintext(client, fdeName, normalizedHost, token);
    await updateAssignedAccountWith(client, fdeName, normalizedHost, username, true);
  });
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
  // issue #395：审计 + 清除明文副本 + 账号状态回退，同一个事务。
  // 未注册 host（deleted=false）也照跑：那时无行可更新，但审计不能丢。
  await withTransaction(pool, async (client) => {
    await writeAudit(client, actorId, 'admin.git_credential_deleted', fdeName, {
      fde_name: fdeName,
      host: normalizedHost,
      deleted,
    });
    await persistTokenPlaintext(client, fdeName, normalizedHost, null);
    if (deleted) await updateAssignedAccountWith(client, fdeName, normalizedHost, null, false);
  });
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

/**
 * issue #395：凭据自愈——库里持有明文、但文件里那一行没了，就重投一次。
 *
 * 治的是 #395 的后半段：`provisioner.js` 判「有没有凭据」用的一直是 `token_ref` 非空，而 `token_ref`
 * 只是远端 token 的 **ID**，与文件的真实状态毫无关系。现网实例（`eric`，2026-10-25）：agent 整文件重写
 * `~/.git-credentials` 把 gitea 那行冲掉，库里 `token_ref` 依然好端端挂着 ⇒ 平台以为一切正常，agent
 * 却永远报「没有凭据」，而重跑 provision 也不会补投（判据认为已经有了）——自愈路径是断的。
 *
 * 判定与动作（**只补，不覆盖**）：
 *   文件里有该 host 的行，且 username 与 `remote_login` 一致 → `present`，什么都不做；
 *   文件里有该 host 的行、但 username 不是 `remote_login`   → `different_identity`，**不动**：
 *     那是 FDE 自己在容器里换成的另一枚凭据（同 host 换账号），平台拿副本去盖就是擅自改人家的登录身份；
 *   文件里没有该 host 的行 + 库里有明文 → 重投（审计单独一条 `admin.git_credential_redeployed`，
 *     与人工投放区分开，运维才看得见"这是自愈补的，不是谁提交的"）；
 *   文件里没有该 host 的行 + 库里无明文 → `no_platform_copy`：**只能重铸或人工再提交一次**，
 *     这是 per_fde_pat 与 #395 之前存量行的固有形状（平台从未持有明文），报出来而不是装作修好了。
 *
 * @returns {Promise<{deployed: boolean, reason: string, host?: string}>}
 */
export async function ensureCredentialDeployed({ pool, actorId = null, config, fdeName, log = () => {} } = {}) {
  validateFde(fdeName);
  assertAuditPool(pool);
  const { target } = getCredentialPath(config, fdeName);
  const { rows } = await pool.query(
    `SELECT a.remote_login, a.token, a.token_ref, h.base_url, h.provider, h.enabled
       FROM fde_git_accounts a
       JOIN git_hosts h ON h.id = a.git_host_id
       JOIN users u ON u.id = a.fde_id
      WHERE u.fde_name = $1`,
    [fdeName],
  );
  const account = rows[0];
  if (!account) return { deployed: false, reason: 'no_account' };

  let host;
  try {
    host = new URL(account.base_url).host.toLowerCase();
  } catch {
    return { deployed: false, reason: 'host_unparsable' };
  }
  if (account.enabled === false) return { deployed: false, reason: 'host_disabled', host };

  const sameHost = fileLines(readCredentialFile(target))
    .map((line) => ({ line, cred: parseCredentialLine(line) }))
    .filter((entry) => entry.cred?.host === host);
  if (sameHost.length > 0) {
    const mine = sameHost.some((entry) => entry.cred.username === account.remote_login);
    if (mine) return { deployed: false, reason: 'present', host };
    log(`[git-credential] ${fdeName}@${host}: 文件里是另一个登录名（平台侧是 ${account.remote_login ?? '<无>'}），不覆盖 FDE 自己的凭据`);
    return { deployed: false, reason: 'different_identity', host };
  }

  if (!account.remote_login) return { deployed: false, reason: 'no_remote_login', host };
  if (!account.token) {
    log(`[git-credential] ${fdeName}@${host}: 文件里没有该 host 的凭据，而平台也没有明文副本（per_fde_pat 或 #395 之前的存量行）⇒ 需重铸或人工重新提交`);
    return { deployed: false, reason: 'no_platform_copy', host };
  }

  await setGitCredential({
    pool,
    actorId,
    config,
    fdeName,
    host,
    username: account.remote_login,
    token: account.token,
    auditAction: 'admin.git_credential_redeployed',
    auditExtra: { redeployed: true },
  });
  log(`[git-credential] ${fdeName}@${host}: 文件里缺该行，已按平台副本重投`);
  return { deployed: true, reason: 'redeployed', host };
}
