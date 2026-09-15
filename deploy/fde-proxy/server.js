// 自研最小 admission proxy（零依赖 Node）：替换 tecnativa/docker-socket-proxy。
// 与 portal 的代码层白名单（provisioner.DOCKER_ALLOWED_PATHS）对应，这里是**真正安全边界**——
// 方法+路径白名单 + POST /containers/create 的字段级 allowlist（deny-by-default）+ 生命周期 API 资源 scope。
// 其余放行路径原样转发（含流式），不缓冲。
//
// 环境变量：
//   SOCKET_PATH           /var/run/docker.sock 路径（默认 /var/run/docker.sock）
//   USERSPACE_ROOT        容器内 bind source 根挂载路径（默认 /srv/erix/users）
//   USERSPACE_ROOT_HOST   宿主侧 bind source 根路径（默认 = USERSPACE_ROOT；用于宿主路径→容器路径换算）
//   IMAGE_ALLOWLIST       逗号分隔的镜像**全串精确**白名单（默认 traefik/whoami）
//   MAX_MEMORY            允许的 Memory 上限（字节；0 = 不限）
//   MAX_PIDS              允许的 PidsLimit 上限（0 = 不限）
//   ALLOWED_USERS         允许的容器 User 值，逗号分隔（默认 1001:1000）
//   IPAM_POOLS            允许的 network create subnet 池，逗号分隔 CIDR（默认 10.200.0.0/16,10.201.0.0/16）
//   PORT                  监听端口（默认 2375）
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const NAME_SEG = '[^/]+';

// 12 条契约路径（与 provisioner.DOCKER_ALLOWED_PATHS 一致，deploy-contract §5）。
const ALLOWED_PATHS = [
  { method: 'GET', re: /^\/_ping$/ },
  { method: 'GET', re: /^\/version$/ },
  { method: 'GET', re: /^\/containers\/json$/ },
  { method: 'POST', re: /^\/containers\/create$/ },
  { method: 'GET', re: new RegExp(`^/containers/${NAME_SEG}/json$`) },
  { method: 'POST', re: new RegExp(`^/containers/${NAME_SEG}/start$`) },
  { method: 'POST', re: new RegExp(`^/containers/${NAME_SEG}/stop$`) },
  { method: 'DELETE', re: new RegExp(`^/containers/${NAME_SEG}$`) },
  { method: 'GET', re: /^\/networks$/ },
  { method: 'POST', re: /^\/networks\/create$/ },
  { method: 'GET', re: new RegExp(`^/networks/${NAME_SEG}$`) },
  { method: 'DELETE', re: new RegExp(`^/networks/${NAME_SEG}$`) },
];

// ---------------------------------------------------------------------------
// 字段级 allowlist（P1 deny-by-default；deploy-contract §5 B6 / §6.2）
// ---------------------------------------------------------------------------
// R2：NetworkingConfig 直接剔除（provisioner 用 HostConfig.NetworkMode，不需要它）。
const TOP_LEVEL_FIELDS = new Set([
  'Image',
  'Cmd', // §6.2 entrypoint/command
  'Entrypoint', // §6.2 entrypoint/command
  'Env',
  'Labels',
  'User', // env §10：whoami 等镜像无 1001 用户时 `--user` 兜底（⚠️ dev 偏差）
  'HostConfig',
]);
// R5：ExtraHosts 直接剔除（不需要 --add-host）。
const HOST_CONFIG_FIELDS = new Set([
  'Binds',
  'NetworkMode',
  'CapAdd',
  'CapDrop',
  'SecurityOpt',
  'Memory',
  'MemorySwap',
  'RestartPolicy',
  'Init',
  'PidsLimit',
]);
const CAP_ADD_ALLOW = new Set(['SETUID', 'SETGID', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL']);
const NETWORK_NAME_RE = /^fde-[a-z0-9-]+$/;
const CONTAINER_NAME_RE = /^\/fde-[a-z0-9-]+$/;
const FDE_NAME_RE = /^[a-z0-9-]+$/;
const RESTART_POLICY_NAMES = new Set(['unless-stopped']);
// R3：Env 键白名单（其余 Env 值一律拒）。
const ENV_KEY_ALLOW = new Set(['PATH', 'ERIX_STATION_TOKEN', 'ERIX_STATION_BASE_URL', 'ERIX_FDE_NAME']);
// R4：任何层禁止的原型污染键。
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function matchPath(method, pathname) {
  const p = String(pathname).split('?')[0];
  return ALLOWED_PATHS.some((r) => r.method === method && r.re.test(p));
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// 严格 JSON 解析：拒绝重复键（防 parser differential）+ 原型污染键（P1/R4）
// ---------------------------------------------------------------------------
export function parseJsonStrict(text) {
  const s = String(text);
  let i = 0;
  const fail = (msg) => {
    const e = new SyntaxError(`${msg} at position ${i}`);
    e.code = 'json_parse_error';
    throw e;
  };
  const dup = (key) => {
    const e = new SyntaxError(`duplicate JSON key: ${key}`);
    e.code = 'json_duplicate_key';
    throw e;
  };
  const forbidden = (key) => {
    const e = new SyntaxError(`forbidden JSON key: ${key}`);
    e.code = 'json_forbidden_key';
    throw e;
  };
  const skipWs = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const parseString = () => {
    if (s[i] !== '"') fail('expected string');
    i++;
    let out = '';
    while (i < s.length) {
      const c = s[i];
      if (c === '"') {
        i++;
        return out;
      }
      if (c === '\\') {
        i++;
        const e = s[i++];
        if (e === 'u') {
          const hex = s.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('bad unicode escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else if (e === 'r') out += '\r';
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else if (e === '"') out += '"';
        else if (e === '\\') out += '\\';
        else if (e === '/') out += '/';
        else fail('bad escape');
      } else {
        out += c;
        i++;
      }
    }
    fail('unterminated string');
  };
  const parseNumber = () => {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    if (!m) fail('invalid number');
    i += m[0].length;
    return Number(m[0]);
  };
  const expectWord = (w) => {
    if (s.slice(i, i + w.length) !== w) fail('unexpected token');
    i += w.length;
  };
  const parseObject = () => {
    i++; // {
    const obj = {};
    const seen = new Set();
    skipWs();
    if (s[i] === '}') {
      i++;
      return obj;
    }
    for (;;) {
      skipWs();
      const key = parseString();
      if (FORBIDDEN_KEYS.has(key)) forbidden(key);
      if (seen.has(key)) dup(key);
      seen.add(key);
      skipWs();
      if (s[i] !== ':') fail('expected ":"');
      i++;
      obj[key] = parseValue();
      skipWs();
      if (s[i] === ',') {
        i++;
        continue;
      }
      if (s[i] === '}') {
        i++;
        return obj;
      }
      fail('expected "," or "}"');
    }
  };
  const parseArray = () => {
    i++; // [
    const arr = [];
    skipWs();
    if (s[i] === ']') {
      i++;
      return arr;
    }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      if (s[i] === ',') {
        i++;
        continue;
      }
      if (s[i] === ']') {
        i++;
        return arr;
      }
      fail('expected "," or "]"');
    }
  };
  const parseValue = () => {
    skipWs();
    const c = s[i];
    if (c === '"') return parseString();
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === 't') return expectWord('true'), true;
    if (c === 'f') return expectWord('false'), false;
    if (c === 'n') return expectWord('null'), null;
    return parseNumber();
  };
  skipWs();
  const v = parseValue();
  skipWs();
  if (i !== s.length) fail('trailing content');
  return v;
}

// ---------------------------------------------------------------------------
// 资源名段解码 + 拒绝编码绕过（R7）
// ---------------------------------------------------------------------------
const ENCODED_DANGEROUS_RE = /%(?:2f|5c|2e|0[0-9a-f]|1[0-9a-f]|7f)/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/** 解码并校验单个资源名段；拒绝 %2F/%2e/反斜杠/./.. 段/控制字符。非法返回 null。 */
export function decodeName(raw) {
  const s = String(raw);
  if (ENCODED_DANGEROUS_RE.test(s)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(s);
  } catch {
    return null;
  }
  if (!decoded || decoded === '.' || decoded === '..') return null;
  if (decoded.includes('/') || decoded.includes('\\')) return null;
  if (CONTROL_CHAR_RE.test(decoded)) return null;
  return decoded;
}

// ---------------------------------------------------------------------------
// bind source 校验（P3：realpath 防 symlink 逃逸）
// ---------------------------------------------------------------------------

/** realpath 一个可能尚不存在的路径：逐段向上找最深存在的祖先，realpath 后补回剩余段。 */
export function realpathExisting(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        const parent = path.dirname(cur);
        if (parent === cur) throw err;
        tail.unshift(path.basename(cur));
        cur = parent;
      } else {
        throw err;
      }
    }
  }
}

/** 宿主 bind source 路径 → proxy 容器内可见路径（映射换算）；越界返回 null。 */
export function mapBindSourceToContainer(src, { userSpaceRootHost, userSpaceRoot }) {
  const hostRoot = path.resolve(userSpaceRootHost || userSpaceRoot);
  const containerRoot = path.resolve(userSpaceRoot);
  const lexSrc = path.resolve(src || '');
  const rel = path.relative(hostRoot, lexSrc);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return path.join(containerRoot, rel);
}

/** 校验单条 bind source；返回理由字符串，空 = 通过。 */
export function validateBindSource(src, { userSpaceRootHost, userSpaceRoot }) {
  if (!src || typeof src !== 'string') return 'bind source is empty';
  const containerSrc = mapBindSourceToContainer(src, { userSpaceRootHost, userSpaceRoot });
  if (containerSrc === null) return `bind source not under USERSPACE_ROOT: ${src}`;
  let resolvedRoot;
  let resolvedSrc;
  try {
    resolvedRoot = realpathExisting(path.resolve(userSpaceRoot));
    resolvedSrc = realpathExisting(containerSrc);
  } catch {
    return `bind source not resolvable: ${src}`;
  }
  if (resolvedSrc !== resolvedRoot && !resolvedSrc.startsWith(resolvedRoot + path.sep)) {
    return `bind source escapes USERSPACE_ROOT (symlink?): ${src} -> ${resolvedSrc}`;
  }
  return null;
}

/** 校验 bind destination 必须在容器 home 下（/home/erix 或 /home/erix/...）。 */
export function validateContainerDest(dest) {
  if (typeof dest !== 'string' || dest.length === 0) return 'bind destination is empty';
  if (!dest.startsWith('/')) return `bind destination must be absolute: ${dest}`;
  const home = '/home/erix';
  if (dest !== home && !dest.startsWith(home + '/')) return `bind destination not under container home: ${dest}`;
  const rest = dest === home ? '' : dest.slice(home.length + 1);
  if (rest.split('/').some((seg) => seg === '..')) return `bind destination contains "..": ${dest}`;
  return null;
}

// ---------------------------------------------------------------------------
// CIDR / IP 工具（network create subnet 池校验，R2）
// ---------------------------------------------------------------------------
export function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

export function parseCidr(cidr) {
  const m = String(cidr).match(/^([0-9]{1,3}(?:\.[0-9]{1,3}){3})\/(\d{1,2})$/);
  if (!m) return null;
  const prefix = Number(m[2]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const base = ipv4ToInt(m[1]);
  if (base === null) return null;
  return { base, prefix };
}

function prefixMask(prefix) {
  if (prefix === 0) return 0;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

/** 判断 subnet CIDR 是否被某个允许池 CIDR 包含。 */
export function isCidrInPools(cidr, pools) {
  const c = parseCidr(cidr);
  if (!c) return false;
  for (const p of pools) {
    const pool = parseCidr(p);
    if (!pool || c.prefix < pool.prefix) continue;
    const mask = prefixMask(pool.prefix);
    if ((c.base & mask) === (pool.base & mask)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 生命周期 API 资源 scope（P2）
// ---------------------------------------------------------------------------

/** 容器 inspect 结果必须带 station.managed=true 且名字为 /fde-<name>。 */
export function isManagedContainerInfo(info) {
  const labels = info?.Config?.Labels ?? {};
  return labels['station.managed'] === 'true' && typeof info?.Name === 'string' && CONTAINER_NAME_RE.test(info.Name);
}

/** 网络 inspect 结果必须带 station.managed=true 且名字为 fde-<name>。 */
export function isManagedNetworkInfo(info) {
  const labels = info?.Labels ?? {};
  return labels['station.managed'] === 'true' && typeof info?.Name === 'string' && NETWORK_NAME_RE.test(info.Name);
}

/** POST /networks/create 策略校验（R2：严格白名单）。返回理由数组；空 = 通过。 */
export function validateNetworkBody(body, opts = {}) {
  const { ipamPools = [] } = opts;
  const reasons = [];
  if (!isPlainObject(body)) return ['network create body must be a JSON object'];

  const allowedTop = new Set(['Name', 'Driver', 'IPAM', 'Labels']);
  for (const key of Object.keys(body)) {
    if (!allowedTop.has(key)) reasons.push(`network create field not allowed: ${key}`);
  }

  if (typeof body.Name !== 'string' || !NETWORK_NAME_RE.test(body.Name)) {
    reasons.push('Name must match ^fde-[a-z0-9-]+$');
  }
  if (body.Driver !== 'bridge') {
    reasons.push('Driver must be exactly "bridge"');
  }
  if (!isPlainObject(body.IPAM)) {
    reasons.push('IPAM must be an object');
  } else {
    if (body.IPAM.Driver !== undefined && body.IPAM.Driver !== 'default') {
      reasons.push('IPAM.Driver must be "default"');
    }
    const configs = body.IPAM.Config;
    if (!Array.isArray(configs) || configs.length !== 1 || !isPlainObject(configs[0])) {
      reasons.push('IPAM.Config must be an array with exactly one object');
    } else {
      const cfg = configs[0];
      if (typeof cfg.Subnet !== 'string' || !isCidrInPools(cfg.Subnet, ipamPools)) {
        reasons.push(`IPAM.Subnet not in allowed pools: ${cfg.Subnet}`);
      }
      if (cfg.Gateway !== undefined) {
        const c = parseCidr(cfg.Subnet);
        const g = ipv4ToInt(cfg.Gateway);
        if (!c || g === null || (g & prefixMask(c.prefix)) !== (c.base & prefixMask(c.prefix))) {
          reasons.push(`IPAM.Gateway not in subnet: ${cfg.Gateway}`);
        }
      }
    }
  }
  if (!isPlainObject(body.Labels) || body.Labels['station.managed'] !== 'true') {
    reasons.push('Labels must include station.managed=true');
  }
  return reasons;
}

/** POST /containers/create 策略校验（deploy-contract §5 B6 / §6.2 + R3/R5）。返回理由数组；空 = 通过。 */
export function validateCreateBody(body, opts = {}) {
  const {
    userSpaceRoot = '/srv/erix/users',
    userSpaceRootHost = userSpaceRoot,
    imageAllowlist = '',
    maxMemory = 0,
    fdeName = null, // 裸 FDE 名（'alice'），来自 ?name=fde-alice
    containerName = fdeName ? `fde-${fdeName}` : null,
    allowedUsers = '1001:1000',
    maxPids = 0, // 0 = 不限
  } = opts;
  const reasons = [];
  if (!isPlainObject(body)) return ['create body must be a JSON object'];

  // P1：顶层字段级 allowlist（deny-by-default，未知字段一律拒）。
  for (const key of Object.keys(body)) {
    if (!TOP_LEVEL_FIELDS.has(key)) reasons.push(`unknown top-level field: ${key}`);
  }

  const hc = body.HostConfig;
  const h = isPlainObject(hc) ? hc : {};
  if (hc !== undefined && !isPlainObject(hc)) {
    reasons.push('HostConfig must be an object');
  } else if (isPlainObject(hc)) {
    // P1：HostConfig 字段级 allowlist。
    for (const key of Object.keys(hc)) {
      if (!HOST_CONFIG_FIELDS.has(key)) reasons.push(`HostConfig field not allowed: ${key}`);
    }
  }

  // R3：create 必须绑定具体 FDE。
  if (fdeName !== null) {
    if (!isPlainObject(body.Labels)) {
      reasons.push('Labels must include station.managed=true and fde.name=<fde>');
    } else {
      if (body.Labels['station.managed'] !== 'true') reasons.push('Labels must include station.managed=true');
      if (body.Labels['fde.name'] !== fdeName) reasons.push(`Labels.fde.name must equal ${fdeName}`);
    }
    if (!Array.isArray(body.Env)) {
      reasons.push('Env must include ERIX_FDE_NAME=<fde>');
    } else {
      let hasFdeName = false;
      for (const e of body.Env) {
        if (typeof e !== 'string') {
          reasons.push('Env entries must be strings');
          continue;
        }
        const eq = e.indexOf('=');
        if (eq <= 0) {
          reasons.push(`Env entry must be KEY=VALUE: ${e}`);
          continue;
        }
        const key = e.slice(0, eq);
        if (!ENV_KEY_ALLOW.has(key)) {
          reasons.push(`Env key not allowed: ${key}`);
          continue;
        }
        if (key === 'ERIX_FDE_NAME') {
          if (e.slice(eq + 1) !== fdeName) reasons.push(`Env ERIX_FDE_NAME must equal ${fdeName}`);
          hasFdeName = true;
        }
      }
      if (!hasFdeName) reasons.push('Env must include ERIX_FDE_NAME=<fde>');
    }
  }

  // R3：User 必须匹配 ALLOWED_USERS 或不存在（生产 root+entrypoint 降权）。
  if (body.User !== undefined) {
    const allowed = String(allowedUsers || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (typeof body.User !== 'string' || !allowed.includes(body.User)) {
      reasons.push(`User not in ALLOWED_USERS: ${body.User}`);
    }
  }

  // P1：值校验。
  if (!Array.isArray(h.CapDrop) || h.CapDrop.length !== 1 || h.CapDrop[0] !== 'ALL') {
    reasons.push('CapDrop must be exactly ["ALL"]');
  }
  if (!Array.isArray(h.SecurityOpt) || h.SecurityOpt.length !== 1 || h.SecurityOpt[0] !== 'no-new-privileges') {
    reasons.push('SecurityOpt must be exactly ["no-new-privileges"]');
  }
  if (h.CapAdd !== undefined) {
    if (!Array.isArray(h.CapAdd) || h.CapAdd.some((c) => !CAP_ADD_ALLOW.has(c))) {
      reasons.push(`CapAdd not in allowlist: ${JSON.stringify(h.CapAdd)}`);
    }
  }
  if (h.Binds !== undefined) {
    if (!Array.isArray(h.Binds)) {
      reasons.push('Binds must be an array');
    } else {
      const fdeRootHost = fdeName ? path.join(path.resolve(userSpaceRootHost), fdeName) : path.resolve(userSpaceRootHost);
      const fdeRootContainer = fdeName ? path.join(path.resolve(userSpaceRoot), fdeName) : path.resolve(userSpaceRoot);
      for (const b of h.Binds) {
        if (typeof b !== 'string') {
          reasons.push('Binds entries must be strings');
          continue;
        }
        if (b.includes('docker.sock')) {
          reasons.push('bind containing docker.sock is forbidden');
          continue;
        }
        const parts = b.split(':');
        if (parts.length < 2 || parts.length > 3) {
          reasons.push(`bind must be "src:dest[:mode]": ${b}`);
          continue;
        }
        const [src, dest, mode] = parts;
        const srcReason = validateBindSource(src, { userSpaceRootHost: fdeRootHost, userSpaceRoot: fdeRootContainer });
        if (srcReason) reasons.push(srcReason);
        const destReason = validateContainerDest(dest);
        if (destReason) reasons.push(destReason);
        if (mode !== undefined && mode !== 'rw') reasons.push(`bind mode must be "rw" or empty: ${b}`);
      }
    }
  }
  // R3：NetworkMode 必填且 === fde-<name>。
  if (containerName) {
    if (typeof h.NetworkMode !== 'string' || h.NetworkMode !== containerName) {
      reasons.push(`NetworkMode must be exactly ${containerName}`);
    }
  } else if (h.NetworkMode !== undefined) {
    if (typeof h.NetworkMode !== 'string' || !NETWORK_NAME_RE.test(h.NetworkMode)) {
      reasons.push(`NetworkMode not allowed: ${h.NetworkMode}`);
    }
  } else {
    reasons.push('NetworkMode is required');
  }
  // R5：RestartPolicy 只允许 {"Name":"unless-stopped"} 且无其它子字段。
  if (h.RestartPolicy !== undefined) {
    const rp = h.RestartPolicy;
    if (!isPlainObject(rp) || Object.keys(rp).length !== 1 || rp.Name !== 'unless-stopped') {
      reasons.push('RestartPolicy must be exactly {"Name":"unless-stopped"}');
    }
  }
  if (h.Memory !== undefined) {
    if (typeof h.Memory !== 'number' || !Number.isFinite(h.Memory) || h.Memory < 0) {
      reasons.push('Memory must be a non-negative number');
    } else if (maxMemory > 0 && h.Memory > maxMemory) {
      reasons.push(`Memory exceeds limit: ${h.Memory} > ${maxMemory}`);
    }
  }
  // R5：MemorySwap ≤ 2×Memory。
  if (h.MemorySwap !== undefined) {
    if (typeof h.MemorySwap !== 'number' || !Number.isFinite(h.MemorySwap) || h.MemorySwap < 0) {
      reasons.push('MemorySwap must be a non-negative number');
    } else if (typeof h.Memory === 'number' && h.Memory > 0 && h.MemorySwap > 2 * h.Memory) {
      reasons.push(`MemorySwap must be <= 2x Memory: ${h.MemorySwap} > 2*${h.Memory}`);
    }
  }
  // R5：PidsLimit ≤ env 上限。
  if (h.PidsLimit !== undefined) {
    if (typeof h.PidsLimit !== 'number' || !Number.isInteger(h.PidsLimit) || h.PidsLimit < 0) {
      reasons.push('PidsLimit must be a non-negative integer');
    } else if (maxPids > 0 && h.PidsLimit > maxPids) {
      reasons.push(`PidsLimit exceeds limit: ${h.PidsLimit} > ${maxPids}`);
    }
  }
  // R5：Init 必须为 true。
  if (h.Init !== true) {
    reasons.push('Init must be true');
  }

  // P5：镜像全串精确匹配。
  const image = body.Image;
  const allow = String(imageAllowlist || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const imageOk = typeof image === 'string' && image.length > 0 && allow.includes(image);
  if (!imageOk) reasons.push(`Image not in allowlist: ${image}`);

  return reasons;
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.removeAllListeners('data');
        req.resume();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 上游 inspect（返回 { status, text }，不缓冲上限超出时 abort；R6 5s 超时）。 */
function inspectUpstream(socketPath, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: pathname, method: 'GET', timeout: 5000 }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 4 * 1024 * 1024) {
          res.destroy();
          reject(new Error('inspect body too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 502, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('inspect upstream timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** 转发到 unix socket 上的 Docker API（含响应体上限 + 上游超时，P7）。 */
function forward(req, res, socketPath, { maxResponseBytes = 64 * 1024 * 1024, timeoutMs = 30_000, upstreamPath = null } = {}) {
  const upstream = http.request(
    {
      socketPath,
      path: upstreamPath ?? req.url,
      method: req.method,
      headers: req.headers,
      timeout: timeoutMs,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      let size = 0;
      upRes.on('data', (c) => {
        size += c.length;
        if (size > maxResponseBytes) {
          upRes.destroy();
          res.destroy();
          return;
        }
        res.write(c);
      });
      upRes.on('end', () => res.end());
      upRes.on('error', () => res.destroy());
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) sendJson(res, 502, { message: 'docker upstream unreachable' });
    else res.destroy();
  });
  upstream.on('timeout', () => {
    upstream.destroy(new Error('upstream timeout'));
  });
  req.pipe(upstream);
}

/** 经解析后的校验通过 body 转发（canonical body，不再转发原始字节；R4）。 */
function forwardJson(socketPath, req, res, body) {
  const payload = Buffer.from(JSON.stringify(body));
  const headers = { ...req.headers, 'Content-Length': String(payload.length) };
  delete headers['transfer-encoding'];
  delete headers['Transfer-Encoding'];
  const upstream = http.request({ socketPath, path: req.url, method: req.method, headers, timeout: 30_000 }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) sendJson(res, 502, { message: 'docker upstream unreachable' });
    else res.destroy();
  });
  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.end(payload);
}

export function createHandler({
  socketPath = '/var/run/docker.sock',
  userSpaceRoot,
  userSpaceRootHost,
  imageAllowlist,
  maxMemory,
  maxPids,
  allowedUsers,
  ipamPools,
} = {}) {
  const root = userSpaceRoot || '/srv/erix/users';
  const hostRoot = userSpaceRootHost || root;
  const allowlist = imageAllowlist ?? 'traefik/whoami';
  const memMax = Number(maxMemory ?? 0) || 0;
  const pidsMax = Number(maxPids ?? 0) || 0;
  const users = allowedUsers ?? '1001:1000';
  const pools = String(ipamPools ?? '10.200.0.0/16,10.201.0.0/16')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return async (req, res) => {
    const url = new URL(req.url, 'http://proxy.local');
    const { pathname } = url;
    if (!matchPath(req.method, pathname)) {
      return sendJson(res, 403, { error: 'docker_path_denied', message: `path not in allowlist: ${req.method} ${pathname}` });
    }

    const seg = pathname.split('/');

    // R1/R7：容器 inspect / 生命周期 —— 先解码名字（拒绝编码绕过），再向上游 inspect 做 scope（fail-closed）。
    const isContainerSingle =
      (req.method === 'GET' && /^\/containers\/[^/]+\/json$/.test(pathname)) ||
      (req.method === 'POST' && /^\/containers\/[^/]+\/(?:start|stop)$/.test(pathname)) ||
      (req.method === 'DELETE' && /^\/containers\/[^/]+$/.test(pathname));
    const isNetworkSingle =
      (req.method === 'GET' || req.method === 'DELETE') && /^\/networks\/[^/]+$/.test(pathname);

    let upstreamPath = req.url;
    if (isContainerSingle || isNetworkSingle) {
      const name = decodeName(seg[2]);
      if (name === null) {
        return sendJson(res, 400, { error: 'invalid_resource_name', message: 'resource name contains illegal characters' });
      }
      upstreamPath = req.url.replace(seg[2], encodeURIComponent(name));

      let info;
      try {
        const inspectPath = isContainerSingle
          ? `/containers/${encodeURIComponent(name)}/json`
          : `/networks/${encodeURIComponent(name)}`;
        const r = await inspectUpstream(socketPath, inspectPath);
        if (r.status === 404) {
          return sendJson(res, 404, { error: isContainerSingle ? 'no_such_container' : 'no_such_network', message: `resource not found: ${name}` });
        }
        if (r.status !== 200) return sendJson(res, 502, { message: `docker inspect failed: ${r.status}` });
        info = parseJsonStrict(r.text);
      } catch {
        return sendJson(res, 502, { message: 'docker inspect failed' });
      }
      const managed = isContainerSingle ? isManagedContainerInfo(info) : isManagedNetworkInfo(info);
      if (!managed) {
        return sendJson(res, 403, { error: 'resource_scope_denied', message: `resource not platform-managed: ${name}` });
      }
    }

    if (req.method === 'POST' && pathname === '/containers/create') {
      const te = String(req.headers['transfer-encoding'] || '').toLowerCase();
      if (te === 'chunked') {
        return sendJson(res, 400, { error: 'unsupported_transfer_encoding', message: 'Transfer-Encoding: chunked is not supported' });
      }
      // R3：?name= 必须匹配 ^fde-[a-z0-9-]+$。
      const name = url.searchParams.get('name');
      if (!name || !NETWORK_NAME_RE.test(name)) {
        return sendJson(res, 403, { error: 'create_policy_denied', reasons: ['name query param must match ^fde-[a-z0-9-]+$'] });
      }
      const fdeName = name.slice('fde-'.length);
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        return sendJson(res, 413, { error: 'payload_too_large', message: 'create body too large' });
      }
      let body = null;
      try {
        body = raw.length ? parseJsonStrict(raw.toString('utf8')) : {};
      } catch (e) {
        if (e.code === 'json_duplicate_key' || e.code === 'json_forbidden_key') {
          return sendJson(res, 403, { error: 'create_policy_denied', reasons: [e.message] });
        }
        return sendJson(res, 400, { error: 'invalid_json', message: 'create body is not valid JSON' });
      }
      const reasons = validateCreateBody(body, {
        userSpaceRoot: root,
        userSpaceRootHost: hostRoot,
        imageAllowlist: allowlist,
        maxMemory: memMax,
        fdeName,
        containerName: name,
        allowedUsers: users,
        maxPids: pidsMax,
      });
      if (reasons.length > 0) {
        return sendJson(res, 403, { error: 'create_policy_denied', reasons });
      }
      forwardJson(socketPath, req, res, body);
      return;
    }

    if (req.method === 'POST' && pathname === '/networks/create') {
      const te = String(req.headers['transfer-encoding'] || '').toLowerCase();
      if (te === 'chunked') {
        return sendJson(res, 400, { error: 'unsupported_transfer_encoding', message: 'Transfer-Encoding: chunked is not supported' });
      }
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        return sendJson(res, 413, { error: 'payload_too_large', message: 'network create body too large' });
      }
      let body = null;
      try {
        body = raw.length ? parseJsonStrict(raw.toString('utf8')) : {};
      } catch (e) {
        if (e.code === 'json_duplicate_key' || e.code === 'json_forbidden_key') {
          return sendJson(res, 403, { error: 'network_create_policy_denied', reasons: [e.message] });
        }
        return sendJson(res, 400, { error: 'invalid_json', message: 'network create body is not valid JSON' });
      }
      const reasons = validateNetworkBody(body, { ipamPools: pools });
      if (reasons.length > 0) {
        return sendJson(res, 403, { error: 'network_create_policy_denied', reasons });
      }
      forwardJson(socketPath, req, res, body);
      return;
    }

    forward(req, res, socketPath, { upstreamPath });
  };
}

function main() {
  const port = Number(process.env.PORT || 2375);
  const handler = createHandler({
    socketPath: process.env.SOCKET_PATH || '/var/run/docker.sock',
    userSpaceRoot: process.env.USERSPACE_ROOT || '/srv/erix/users',
    userSpaceRootHost: process.env.USERSPACE_ROOT_HOST || process.env.USERSPACE_ROOT || '/srv/erix/users',
    imageAllowlist: process.env.IMAGE_ALLOWLIST || 'traefik/whoami',
    maxMemory: Number(process.env.MAX_MEMORY || 0) || 0,
    maxPids: Number(process.env.MAX_PIDS || 0) || 0,
    allowedUsers: process.env.ALLOWED_USERS || '1001:1000',
    ipamPools: process.env.IPAM_POOLS || '10.200.0.0/16,10.201.0.0/16',
  });
  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: 'proxy error' });
      else res.destroy();
    });
  });
  server.listen(port, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`[fde-proxy] listening :${port} -> ${process.env.SOCKET_PATH || '/var/run/docker.sock'}`);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
