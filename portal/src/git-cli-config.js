import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { assertSafePath, atomicWriteFile, ensureDirSafe } from './fsutil.js';

// Schemas are from the pinned CLI sources:
// tea: https://gitea.com/gitea/tea/raw/tag/v0.16.0/modules/config/config.go
//      https://gitea.com/gitea/tea/raw/tag/v0.16.0/modules/config/login.go
// gh: https://github.com/cli/cli/blob/v2.102.0/internal/config/config.go
//     https://github.com/cli/cli/blob/v2.102.0/internal/config/migration/multi_account.go
// glab: https://gitlab.com/gitlab-org/cli/-/blob/v1.121.0/internal/config/schema.go
const CLI_CONFIGS = Object.freeze({
  gitea: ['.config', 'tea', 'config.yml'],
  github: ['.config', 'gh', 'hosts.yml'],
  gitlab: ['.config', 'glab-cli', 'config.yml'],
});
const FILE_MODE = 0o640;
const DIR_MODE = 0o750;

function isMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function emptyMap() {
  return Object.create(null);
}

function copyMap(value) {
  if (value === undefined || value === null) return emptyMap();
  if (!isMap(value)) {
    const error = new Error('git CLI configuration has an invalid structure');
    error.code = 'git_cli_config_invalid';
    error.httpStatus = 500;
    throw error;
  }
  return Object.assign(emptyMap(), value);
}

function yamlError() {
  const error = new Error('git CLI configuration is invalid');
  error.code = 'git_cli_config_invalid';
  error.httpStatus = 500;
  return error;
}

function getConfigPath(root, homeDir, provider) {
  if (!Object.hasOwn(CLI_CONFIGS, provider)) return null;
  const parts = CLI_CONFIGS[provider];
  const target = path.join(homeDir, ...parts);
  try {
    assertSafePath(root, target);
    const rootReal = fs.realpathSync(root);
    const homeReal = fs.realpathSync(homeDir);
    const relative = path.relative(rootReal, homeReal);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('unsafe home path');
    }
  } catch (err) {
    if (err?.code === 'materialize_path_tampered' || err?.code === 'ELOOP' || err?.message === 'unsafe home path') {
      const error = new Error('git CLI configuration path is unsafe');
      error.code = 'credential_path_unsafe';
      error.httpStatus = 500;
      throw error;
    }
    throw err;
  }
  return target;
}

function ensureConfigDirectories(root, homeDir, target, config) {
  const options = {
    mode: DIR_MODE,
    uid: config.fdeUid ?? 1000,
    gid: config.fdeGid ?? 1000,
  };
  ensureDirSafe(root, path.join(homeDir, '.config'), options);
  ensureDirSafe(root, path.dirname(target), options);
}

function readYamlDocument(target) {
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) throw yamlError();
    const contents = fs.readFileSync(fd, 'utf8');
    let document;
    try {
      document = parse(contents);
    } catch {
      throw yamlError();
    }
    return { exists: true, document: copyMap(document) };
  } catch (err) {
    if (err?.code === 'ENOENT') return { exists: false, document: emptyMap() };
    if (err?.code === 'ELOOP') {
      const error = new Error('git CLI configuration path is unsafe');
      error.code = 'credential_path_unsafe';
      error.httpStatus = 500;
      throw error;
    }
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeYamlDocument(target, document, { root, config }) {
  let contents;
  try {
    contents = stringify(document, { lineWidth: 0 });
  } catch {
    throw yamlError();
  }
  atomicWriteFile(target, contents, {
    mode: FILE_MODE,
    uid: config.fdeUid ?? 1000,
    gid: config.fdeGid ?? 1000,
    root,
  });
}

function matchingTeaLogin(login, host) {
  if (!isMap(login)) return false;
  if (typeof login.url === 'string') {
    try {
      return new URL(login.url).host.toLowerCase() === host;
    } catch {
      // Keep malformed unrelated entries; only the exact configured host is managed.
    }
  }
  return typeof login.name === 'string' && login.name.toLowerCase() === host;
}

function upsertTea(document, host, username, token, protocol) {
  const logins = document.logins ?? [];
  if (!Array.isArray(logins)) throw yamlError();

  let updated = false;
  const nextLogins = [];
  for (const login of logins) {
    if (!matchingTeaLogin(login, host)) {
      nextLogins.push(login);
      continue;
    }
    if (updated) continue;
    nextLogins.push(Object.assign(copyMap(login), {
      name: host,
      url: `${protocol}://${host}`,
      token,
      user: username,
    }));
    updated = true;
  }
  if (!updated) nextLogins.push({ name: host, url: `${protocol}://${host}`, token, user: username });
  document.logins = nextLogins;
}

function deleteTea(document, host) {
  const logins = document.logins ?? [];
  if (!Array.isArray(logins)) throw yamlError();
  const nextLogins = logins.filter((login) => !matchingTeaLogin(login, host));
  const changed = nextLogins.length !== logins.length;
  if (changed) document.logins = nextLogins;
  return changed;
}

function upsertGithub(document, host, username, token) {
  const hostConfig = copyMap(document[host]);
  const users = copyMap(hostConfig.users);
  const userConfig = copyMap(users[username]);
  userConfig.oauth_token = token;
  users[username] = userConfig;
  hostConfig.user = username;
  hostConfig.users = users;
  // gh's active-host token is mirrored here by AuthConfig.activateUser for compatibility.
  hostConfig.oauth_token = token;
  document[host] = hostConfig;
}

function deleteGithub(document, host) {
  if (!Object.hasOwn(document, host)) return false;
  delete document[host];
  return true;
}

function upsertGitlab(document, host, username, token) {
  const hosts = copyMap(document.hosts);
  const hostConfig = copyMap(hosts[host]);
  hostConfig.token = token;
  hostConfig.user = username;
  hosts[host] = hostConfig;
  document.hosts = hosts;
}

function deleteGitlab(document, host) {
  const hosts = copyMap(document.hosts);
  if (!Object.hasOwn(hosts, host)) return false;
  delete hosts[host];
  document.hosts = hosts;
  return true;
}

const PROVIDER_HANDLERS = Object.freeze({
  gitea: { upsert: upsertTea, remove: deleteTea },
  github: { upsert: upsertGithub, remove: deleteGithub },
  gitlab: { upsert: upsertGitlab, remove: deleteGitlab },
});

export function upsertGitCliConfig({ root, homeDir, config, provider, host, username, token, protocol }) {
  const handler = Object.hasOwn(PROVIDER_HANDLERS, provider) ? PROVIDER_HANDLERS[provider] : null;
  if (!handler) return;
  const target = getConfigPath(root, homeDir, provider);
  ensureConfigDirectories(root, homeDir, target, config);
  const { document } = readYamlDocument(target);
  handler.upsert(document, host, username, token, protocol);
  writeYamlDocument(target, document, { root, config });
}

export function deleteGitCliConfig({ root, homeDir, config, provider, host }) {
  const handler = Object.hasOwn(PROVIDER_HANDLERS, provider) ? PROVIDER_HANDLERS[provider] : null;
  if (!handler) return;
  const target = getConfigPath(root, homeDir, provider);
  const { exists, document } = readYamlDocument(target);
  if (!exists || !handler.remove(document, host)) return;
  writeYamlDocument(target, document, { root, config });
}

function unlinkConfigFile(root, homeDir, provider) {
  const target = getConfigPath(root, homeDir, provider);
  if (!target) return;
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  if (!stat.isFile()) {
    const error = new Error('git CLI configuration file must be a regular file');
    error.code = 'git_cli_config_invalid';
    error.httpStatus = 500;
    throw error;
  }
  fs.unlinkSync(target);
}

export function removeAllGitCliConfigFiles({ root, homeDir }) {
  for (const provider of Object.keys(CLI_CONFIGS)) unlinkConfigFile(root, homeDir, provider);
}
