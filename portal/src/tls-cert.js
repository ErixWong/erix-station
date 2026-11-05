// 证书生命周期（issue #456 M1 后端切片）：解析 / 校验 / 写盘 / 备份 / 回滚 / 真机握手比对。
//
// 分工（与 #450 D5 的装载面配合，别混）：
//   · `tlsassets.js` —— 装载面：`certs/tls.{crt,key}` 齐 ⇒ 物化 `<dynamic>/tls.yml`（Traefik 的唯一 reload 把手）；
//   · 本模块        —— 生命周期：把一份 PEM 校验干净、写进 `certs/`、备份上一代、必要时回滚，再**调**装载面。
// 本模块**不自己拼 tls.yml**（那是 tlsassets 的唯一职责），也**不碰** routes.yml / llm-routes.yml。
//
// 四条真机事实（2026-11-05 实测，见 AGENTS §8.94 / docs/deploy/edge-routing.md §5，照做别重推）：
//   ① 私钥必须「属主 = Traefik 进程 uid（root）+ mode 600」——`station-edge` 里 root 没有
//      `CAP_DAC_OVERRIDE`，属主/模式不对 ⇒ 握手直接失败（连自签兜底都没有）。portal 容器内也是 root
//      ⇒ `atomicWriteFile(path, pem, { mode: 0o600, root: dynamicDir })` 天然满足（tmp+rename 后属主仍是 root）。
//      **绝不**用 chmod 644 绕（那是把私钥交给同机任何进程读）。
//   ② 只换 `certs/*` **不会**触发 Traefik 重载 —— 必须重写 `tls.yml`（`materializeTlsAssets` 的
//      `keymtime` 进 fingerprint，所以只换私钥也会变）。
//   ③ portal 容器**解析不了** `admin.<伞域>`（`dns.lookup` ⇒ ENOTFOUND）⇒ 真机校验连**默认网关**的
//      管理台端口 + `servername=adminHost`，比对 `getPeerCertificate().fingerprint256`。
//   ④ `curl https://127.0.0.1:9443` 会因 SAN 不含 IP 而失败 ⇒ 校验面只看指纹（`rejectUnauthorized:false`），
//      **不要**顺手加 hostname 校验。
//
// 红线：私钥只落盘（0600）、只以**路径**形式出现在 `tls.yml`；不进 DB / 日志 / 审计 / 响应。
// 本模块返回的证书对象里只有**公钥**（`publicKeyPem`），任何对外 DTO 都由 `describeTls` 逐键白名单拼装。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

import { atomicWriteFile } from './fsutil.js';
import { materializeTlsAssets, readTlsAssets, tlsPaths } from './tlsassets.js';

/** 两份 PEM 各自的大小上限（字节）。超限 ⇒ `400 validation_failed` + `details.field`。 */
export const TLS_MAX_PEM_BYTES = 64 * 1024;
/** 证书文件模式：公开信息，谁读都行（Traefik 也要读）。 */
export const TLS_CERT_MODE = 0o644;
/** 私钥文件模式：见事实①。**不要**为了「读得动」把它放宽。 */
export const TLS_KEY_MODE = 0o600;
/** 备份目录名（相对 `certs/`）：只保一代，覆盖式（别无限堆私钥）。 */
export const TLS_PREV_DIRNAME = 'prev';
/** 备份元数据文件名（**不含 PEM**，只放指纹与有效期）。 */
export const TLS_PREV_META_FILENAME = 'meta.json';
/** 真机握手超时（毫秒）。 */
export const TLS_VERIFY_TIMEOUT_MS = 5000;

/**
 * 证书面的错误。`code` 取值**只有**工单 §4 登记的那几个（+ 既有的 `validation_failed` / `internal`），
 * 别在别处发明新码（`docs/api/portal.md` §1.2 是唯一登记处）。
 */
export class TlsCertError extends Error {
  constructor(code, message, { httpStatus = 400, details, step } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    // 写盘链路专用：说清失败在**哪一步**（mkdir / backup / cert / key / materialize），
    // 便于运维区分「盘满了」与「证书本身有问题」。不新增错误码，走既有 `internal` + `details.step`。
    this.step = step;
  }
}

function fail(code, message, opts) {
  return new TlsCertError(code, message, opts);
}

// ---------------------------------------------------------------------------
// 纯函数：解析
// ---------------------------------------------------------------------------

/** `CN=xxx` 从 X509 的 subject/issuer 文本里取（Node 给的是 `C=..\nO=..\nCN=..` 这种多行串）。 */
function commonNameOf(field) {
  const m = /(?:^|\n)\s*CN=([^\n]*)/.exec(String(field ?? ''));
  return m ? m[1].trim() : null;
}

/**
 * `subjectAltName` 文本（Node 给的是 `DNS:a.example, DNS:b.example, IP Address:1.2.3.4`）⇒ DNS 名数组。
 * 只取 `DNS:` 项：IP / email / URI 形式的 SAN 对「证书覆盖哪个 host」没有意义（浏览器也不拿它们比 host）。
 */
function dnsNamesOf(subjectAltName) {
  if (typeof subjectAltName !== 'string' || subjectAltName === '') return [];
  return subjectAltName
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('DNS:'))
    .map((s) => s.slice(4).trim())
    .filter((s) => s !== '');
}

/**
 * 解析证书 PEM ⇒ 元数据。fullchain 也可以（`X509Certificate` 只看第一份 = 叶子证书，正是 Traefik 会端出来的那张）。
 *
 * @returns {{subjectCN: string|null, sans: string[], issuerCN: string|null, notBefore: string,
 *            notAfter: string, fingerprintSha256: string, publicKeyPem: string}}
 */
export function parseCertificatePem(pem) {
  if (typeof pem !== 'string' || pem.trim() === '') {
    throw fail('tls_cert_invalid', '证书 PEM 为空');
  }
  let cert;
  try {
    cert = new crypto.X509Certificate(pem);
  } catch (err) {
    throw fail('tls_cert_invalid', `证书 PEM 无法解析：${err?.message ?? err}`);
  }
  let publicKeyPem;
  try {
    publicKeyPem = cert.publicKey.export({ type: 'spki', format: 'pem' });
  } catch (err) {
    throw fail('tls_cert_invalid', `证书公钥无法导出：${err?.message ?? err}`);
  }
  return {
    subjectCN: commonNameOf(cert.subject),
    sans: dnsNamesOf(cert.subjectAltName),
    issuerCN: commonNameOf(cert.issuer),
    // ISO 字符串（不是 Date 对象）：这个对象会被塞进 JSON 响应与 DB 参数，别让调用方去猜类型。
    notBefore: new Date(cert.validFromDate ?? cert.validFrom).toISOString(),
    notAfter: new Date(cert.validToDate ?? cert.validTo).toISOString(),
    // 冒号分隔大写 —— 与 `tls.getPeerCertificate().fingerprint256` 同形，verify 端点直接逐字符比对。
    fingerprintSha256: cert.fingerprint256,
    publicKeyPem,
  };
}

/** 解析私钥 PEM（PKCS#8 / PKCS#1 / SEC1 都行，交给 OpenSSL）。非法 ⇒ `tls_key_invalid`。 */
export function parsePrivateKeyPem(pem) {
  if (typeof pem !== 'string' || pem.trim() === '') {
    throw fail('tls_key_invalid', '私钥 PEM 为空');
  }
  try {
    return crypto.createPrivateKey(pem);
  } catch (err) {
    throw fail('tls_key_invalid', `私钥 PEM 无法解析：${err?.message ?? err}`);
  }
}

/**
 * 私钥是否与证书配对：两边都导出 SPKI **DER** 逐字节比（不是比 PEM 文本——文本有换行/头部差异，
 * 同一个公钥可以有多种编码）。
 */
export function keyMatchesCert(certInfo, keyObj) {
  try {
    const fromKey = crypto.createPublicKey(keyObj).export({ type: 'spki', format: 'der' });
    const fromCert = crypto.createPublicKey(certInfo.publicKeyPem).export({ type: 'spki', format: 'der' });
    return Buffer.compare(Buffer.from(fromKey), Buffer.from(fromCert)) === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 纯函数：域名覆盖
// ---------------------------------------------------------------------------

function normalizeHost(host) {
  return String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
}

/**
 * 单个名字模式是否覆盖 host。
 * **通配符只匹配一层**：`*.fde.erix.vip` 覆盖 `admin.fde.erix.vip`，**不**覆盖 `a.b.fde.erix.vip`
 * （与 RFC 6125 / 浏览器口径一致；`endsWith` 那种写法会把两级也放过去，等于放宽了证书能力）。
 * 只认最左一个 `*`（`a.*.b` 这类非法形态一律按不匹配处理，不去猜）。
 */
function patternCoversHost(host, pattern) {
  const p = normalizeHost(pattern);
  if (p === '' || host === '') return false;
  if (!p.includes('*')) return p === host;
  if (!p.startsWith('*.') || p.indexOf('*', 1) !== -1) return false;
  const suffix = p.slice(1); // ".fde.erix.vip"
  if (!host.endsWith(suffix)) return false;
  const label = host.slice(0, host.length - suffix.length);
  return label !== '' && !label.includes('.');
}

/**
 * 证书是否覆盖 `host`。
 *
 * **有 SAN 时忽略 CN**（浏览器口径：SAN 存在即唯一权威，CN 只作兜底）——这条不做的话，
 * 「SAN 只写了别的域名、CN 写了 admin」的证书会被判成覆盖，而浏览器会拒。
 */
export function certCoversHost(host, sans = [], subjectCN = null) {
  const h = normalizeHost(host);
  if (h === '') return false;
  const list = Array.isArray(sans) ? sans.filter((s) => typeof s === 'string') : [];
  if (list.length > 0) return list.some((s) => patternCoversHost(h, s));
  return subjectCN ? patternCoversHost(h, subjectCN) : false;
}

/** 证书「自称覆盖」的名字集合（给 `details.certDomains` 用；有 SAN 用 SAN，否则用 CN）。 */
export function certificateDomains({ sans, subjectCN }) {
  const list = Array.isArray(sans) ? sans.filter((s) => typeof s === 'string' && s !== '') : [];
  if (list.length > 0) return list;
  return subjectCN ? [subjectCN] : [];
}

// ---------------------------------------------------------------------------
// 校验（拒绝比接受重要：这四处任何一处漏掉都可能把管理台锁死）
// ---------------------------------------------------------------------------

/**
 * 上传前的全套校验。**纯函数**（不碰盘、不碰 DB），`now` 可注入 ⇒ 过期判据可单测。
 *
 * 顺序（每条都能被单测打红）：PEM 可解析 → 私钥可解析 → 公钥配对 → 未过期 → 覆盖 `adminHost`
 * → `confirmDomains` 每个名字都在证书里（用户声明不能超出证书能力）。
 *
 * @returns {{ok: true, cert: object} | {ok: false, code: string, message: string, details?: object}}
 */
export function validateUpload({ certPem, keyPem, adminHost, confirmDomains, now = new Date() } = {}) {
  const asFailure = (err) => ({
    ok: false,
    code: err.code,
    message: err.message,
    details: err.details,
  });

  // 大小闸在解析之前：64 KiB 的 base64 也要先拒，别把 OpenSSL 拖进去（同时也是「别把私钥塞进日志」的护栏）。
  for (const [field, value] of [['certPem', certPem], ['keyPem', keyPem]]) {
    if (typeof value !== 'string') {
      return { ok: false, code: 'validation_failed', message: `${field} 必须是 PEM 字符串`, details: { field } };
    }
    if (Buffer.byteLength(value, 'utf8') > TLS_MAX_PEM_BYTES) {
      return {
        ok: false,
        code: 'validation_failed',
        message: `${field} 超过 ${TLS_MAX_PEM_BYTES} 字节上限`,
        details: { field, max_bytes: TLS_MAX_PEM_BYTES },
      };
    }
  }

  let cert;
  try {
    cert = parseCertificatePem(certPem);
  } catch (err) {
    return asFailure(err);
  }

  let keyObj;
  try {
    keyObj = parsePrivateKeyPem(keyPem);
  } catch (err) {
    return asFailure(err);
  }

  if (!keyMatchesCert(cert, keyObj)) {
    return {
      ok: false,
      code: 'tls_key_mismatch',
      message: '私钥与证书不配对（公钥不一致）',
      details: { field: 'keyPem' },
    };
  }

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const notAfterMs = Date.parse(cert.notAfter);
  if (!Number.isFinite(notAfterMs) || notAfterMs <= nowMs) {
    return {
      ok: false,
      code: 'tls_cert_expired',
      message: `证书已过期（notAfter=${cert.notAfter}）`,
      details: { notAfter: cert.notAfter },
    };
  }

  const certDomains = certificateDomains(cert);
  if (!certCoversHost(adminHost, cert.sans, cert.subjectCN)) {
    return {
      ok: false,
      code: 'tls_cert_domain_mismatch',
      message: `证书不覆盖管理台域名 ${normalizeHost(adminHost)}`,
      details: { adminHost: normalizeHost(adminHost), missing: [normalizeHost(adminHost)], certDomains },
    };
  }

  // confirmDomains 是「用户声明这张证书要覆盖哪些名字」。它**不能超出**证书能力（否则前端预填的
  // 可编辑 input 就变成了「让用户承诺一件证书做不到的事」），但也**不要求**覆盖平台全部名字——
  // 缺 station.<base> 只是提示（#456 决策记录第 3 条：标出来，不阻断）。
  if (confirmDomains !== undefined && confirmDomains !== null) {
    if (!Array.isArray(confirmDomains) || confirmDomains.some((d) => typeof d !== 'string')) {
      return {
        ok: false,
        code: 'validation_failed',
        message: 'confirmDomains 必须是字符串数组',
        details: { field: 'confirmDomains' },
      };
    }
    const missing = confirmDomains
      .map((d) => normalizeHost(d))
      .filter((d) => d !== '' && !certCoversHost(d, cert.sans, cert.subjectCN));
    if (missing.length > 0) {
      return {
        ok: false,
        code: 'tls_cert_domain_mismatch',
        message: `confirmDomains 里有证书覆盖不到的名字：${missing.join(', ')}`,
        details: { adminHost: normalizeHost(adminHost), missing, certDomains, field: 'confirmDomains' },
      };
    }
  }

  return { ok: true, cert };
}

/** 证书 PEM 的 sha256 指纹（冒号分隔大写，与 `getPeerCertificate().fingerprint256` 同形）。 */
export function fingerprintOfPem(pem) {
  let cert;
  try {
    cert = new crypto.X509Certificate(pem);
  } catch (err) {
    throw fail('tls_cert_invalid', `证书 PEM 无法解析：${err?.message ?? err}`);
  }
  return cert.fingerprint256;
}

// ---------------------------------------------------------------------------
// 盘上状态（**盘是真相**：GET 一律读盘，不信 DB）
// ---------------------------------------------------------------------------

/**
 * 读盘上当前生效的证书。
 * 任何读/解析失败都**不抛**（证书面坏了不该把管理台整页拖死）：返回 `{configured:false, reason}`，
 * 调用方按「未配置」呈现（与 `tlsassets.js` 的失败隔离口径一致）。
 */
export async function readActiveCertificate({ dynamicDir, fsImpl = fs.promises } = {}) {
  const state = await readTlsAssets({ dynamicDir, fsImpl });
  if (!state.ok) return { configured: false, reason: state.code };
  const { certPath } = tlsPaths(dynamicDir);
  let text;
  try {
    text = (await fsImpl.readFile(certPath)).toString('utf8');
  } catch (err) {
    return { configured: false, reason: err?.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    return { configured: true, cert: parseCertificatePem(text) };
  } catch (err) {
    return { configured: false, reason: 'unparsable', error: err.message };
  }
}

function prevPaths(dynamicDir) {
  const { certDir } = tlsPaths(dynamicDir);
  const prevDir = path.posix.join(certDir, TLS_PREV_DIRNAME);
  return {
    prevDir,
    certPath: path.posix.join(prevDir, 'tls.crt'),
    keyPath: path.posix.join(prevDir, 'tls.key'),
    metaPath: path.posix.join(prevDir, TLS_PREV_META_FILENAME),
  };
}

/**
 * 读上一代证书的**元数据**（`certs/prev/meta.json`；缺失时从 prev 里的证书现算）。
 * 不存在 ⇒ `{present:false}`。**永不返回 PEM**（meta.json 里也没有）。
 */
export async function readPreviousCertificate({ dynamicDir, fsImpl = fs.promises } = {}) {
  const prev = prevPaths(dynamicDir);
  let certText;
  try {
    certText = (await fsImpl.readFile(prev.certPath)).toString('utf8');
  } catch {
    return { present: false };
  }
  let keyPresent = true;
  try {
    const st = await fsImpl.stat(prev.keyPath);
    keyPresent = st.isFile() && st.size > 0;
  } catch {
    keyPresent = false;
  }
  let meta = null;
  try {
    meta = JSON.parse((await fsImpl.readFile(prev.metaPath)).toString('utf8'));
  } catch {
    meta = null;
  }
  let derived = null;
  try {
    derived = parseCertificatePem(certText);
  } catch {
    derived = null;
  }
  return {
    present: true,
    keyPresent,
    certPath: prev.certPath,
    keyPath: prev.keyPath,
    // meta.json 优先（它是「当时」的快照），但字段缺失时用盘上证书补齐——绝不让 meta 的残缺
    // 把「有备份」说成「没备份」。
    meta: {
      fingerprintSha256: meta?.fingerprintSha256 ?? derived?.fingerprintSha256 ?? null,
      subjectCN: meta?.subjectCN ?? derived?.subjectCN ?? null,
      notAfter: meta?.notAfter ?? derived?.notAfter ?? null,
      savedAt: meta?.savedAt ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// 写盘 / 备份 / 回滚
// ---------------------------------------------------------------------------

function stepError(step, err) {
  const wrapped = new TlsCertError('internal', `证书${step}步骤失败：${err?.message ?? err}`, {
    httpStatus: 500,
    details: { step },
    step,
  });
  wrapped.cause = err;
  return wrapped;
}

/**
 * 备份现有一代到 `certs/prev/`（覆盖式，只保一代）。两文件不齐 ⇒ 不备份（返回 null）。
 * `meta.json` **不含 PEM**：只放指纹 / CN / notAfter / savedAt。
 */
async function backupCurrent({ dynamicDir, fsImpl = fs.promises } = {}) {
  const { certPath, keyPath } = tlsPaths(dynamicDir);
  let certBuf;
  let keyBuf;
  try {
    certBuf = await fsImpl.readFile(certPath);
    keyBuf = await fsImpl.readFile(keyPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return null; // 首次上传：没有上一代可备份
    throw err;
  }
  if (certBuf.length === 0 || keyBuf.length === 0) return null;

  const prev = prevPaths(dynamicDir);
  await fsImpl.mkdir(prev.prevDir, { recursive: true, mode: 0o755 });

  let info = null;
  try {
    info = parseCertificatePem(certBuf.toString('utf8'));
  } catch {
    info = null; // 旧证书不可解析也要备份（它是唯一能回去的东西），meta 里留 null
  }
  const meta = {
    fingerprintSha256: info?.fingerprintSha256 ?? null,
    subjectCN: info?.subjectCN ?? null,
    notAfter: info?.notAfter ?? null,
    savedAt: new Date().toISOString(),
  };

  // 顺序：先写两文件，再写 meta（meta 是「这份备份是什么」的索引，最后落 ⇒ 半途失败不会留下
  // 「有 meta 但没证书」的假备份）。
  atomicWriteFile(prev.certPath, certBuf, { mode: TLS_CERT_MODE, root: dynamicDir });
  atomicWriteFile(prev.keyPath, keyBuf, { mode: TLS_KEY_MODE, root: dynamicDir });
  atomicWriteFile(prev.metaPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o644, root: dynamicDir });
  return meta;
}

/**
 * 写一版新证书：**先备份 → 写 crt → 写 key → 物化 tls.yml**（顺序是硬要求，见事实②）。
 *
 * 失败语义：任一步失败都抛 `TlsCertError`（`code='internal'`，`details.step` 指明步骤）。
 * 写 key 失败时**best-effort 把 crt 还原成备份那一版**——否则盘上会留下「新 crt + 旧 key」的
 * 不配对组合，Traefik 会拿着它端出一张浏览器直接拒的证书（比「维持旧证书」更糟）。
 */
export async function writeCertificateAssets({ dynamicDir, certPem, keyPem, fsImpl = fs.promises, log = console } = {}) {
  const paths = tlsPaths(dynamicDir);

  try {
    await fsImpl.mkdir(paths.certDir, { recursive: true, mode: 0o755 });
  } catch (err) {
    throw stepError('mkdir', err);
  }

  let backup = null;
  try {
    backup = await backupCurrent({ dynamicDir, fsImpl });
  } catch (err) {
    throw stepError('backup', err);
  }

  try {
    atomicWriteFile(paths.certPath, certPem, { mode: TLS_CERT_MODE, root: dynamicDir });
  } catch (err) {
    throw stepError('cert', err);
  }

  try {
    atomicWriteFile(paths.keyPath, keyPem, { mode: TLS_KEY_MODE, root: dynamicDir });
  } catch (err) {
    // best-effort 还原 crt（见函数头注释）。还原也失败时把两件事都说清。
    let restored = false;
    if (backup) {
      try {
        const prev = prevPaths(dynamicDir);
        const oldCert = await fsImpl.readFile(prev.certPath);
        atomicWriteFile(paths.certPath, oldCert, { mode: TLS_CERT_MODE, root: dynamicDir });
        restored = true;
      } catch (e2) {
        log.error?.(`[tls] 写私钥失败后还原证书也失败（${e2?.message ?? e2}）—— 盘上可能是「新 crt + 旧 key」，请人工检查 ${paths.certPath}`);
      }
    }
    const wrapped = stepError('key', err);
    wrapped.details = { ...wrapped.details, certRestored: restored };
    throw wrapped;
  }

  let tlsOut;
  try {
    tlsOut = await materializeTlsAssets({ dynamicDir, log, fsImpl });
  } catch (err) {
    throw stepError('materialize', err);
  }
  if (!tlsOut.published) {
    const err = new TlsCertError('internal', `tls.yml 未发布（${tlsOut.reason ?? tlsOut.code ?? 'unknown'}）`, {
      httpStatus: 500,
      details: { step: 'materialize' },
      step: 'materialize',
    });
    throw err;
  }
  return { backup, tlsOut };
}

/**
 * 回滚到 `certs/prev/` 那一代：两文件写回原位 + 物化 `tls.yml`。
 * prev 不存在（或 prev 缺私钥）⇒ `404 tls_no_previous`（本单**允许**新增的码，见 §1.2）。
 *
 * 回滚**不改写 prev 本身**（它仍是那一代）⇒ 重复回滚幂等。
 */
export async function rollbackCertificateAssets({ dynamicDir, fsImpl = fs.promises, log = console } = {}) {
  const prev = await readPreviousCertificate({ dynamicDir, fsImpl });
  if (!prev.present || !prev.keyPresent) {
    throw new TlsCertError('tls_no_previous', '没有可回滚的上一代证书（certs/prev/ 不存在或不完整）', {
      httpStatus: 404,
    });
  }
  const paths = tlsPaths(dynamicDir);
  let certBuf;
  let keyBuf;
  try {
    certBuf = await fsImpl.readFile(prev.certPath);
    keyBuf = await fsImpl.readFile(prev.keyPath);
  } catch (err) {
    throw stepError('restore', err);
  }
  try {
    atomicWriteFile(paths.certPath, certBuf, { mode: TLS_CERT_MODE, root: dynamicDir });
    atomicWriteFile(paths.keyPath, keyBuf, { mode: TLS_KEY_MODE, root: dynamicDir });
  } catch (err) {
    throw stepError('restore', err);
  }
  let tlsOut;
  try {
    tlsOut = await materializeTlsAssets({ dynamicDir, log, fsImpl });
  } catch (err) {
    throw stepError('materialize', err);
  }
  if (!tlsOut.published) {
    throw new TlsCertError('internal', `tls.yml 未发布（${tlsOut.reason ?? tlsOut.code ?? 'unknown'}）`, {
      httpStatus: 500,
      details: { step: 'materialize' },
      step: 'materialize',
    });
  }
  let cert = null;
  try {
    cert = parseCertificatePem(certBuf.toString('utf8'));
  } catch {
    cert = null;
  }
  return { cert, tlsOut };
}

// ---------------------------------------------------------------------------
// 真机校验：默认网关 + servername（事实③④）
// ---------------------------------------------------------------------------

/**
 * 从 `/proc/net/route` 文本里取默认网关（`Destination == 00000000` 那一行）。
 * `Gateway` 是**小端** 32 位 hex：`010020AC` ⇒ `172.32.0.1`（现网实测值）。
 * 解析不出来 ⇒ `null`（调用方报 `unreachable`，不要瞎猜一个地址去连）。
 */
export function parseDefaultGateway(routeText) {
  const lines = String(routeText ?? '').split('\n');
  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    const [, dest, gateway] = cols;
    if (dest !== '00000000') continue;
    if (!/^[0-9a-fA-F]{8}$/.test(gateway)) continue;
    const bytes = [];
    for (let i = 6; i >= 0; i -= 2) bytes.push(parseInt(gateway.slice(i, i + 2), 16));
    return bytes.join('.');
  }
  return null;
}

/** 读 `/proc/net/route` 并取默认网关（读不到 ⇒ null，不抛）。 */
export async function readDefaultGateway({ routePath = '/proc/net/route', fsImpl = fs.promises } = {}) {
  try {
    return parseDefaultGateway((await fsImpl.readFile(routePath)).toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * 对管理台入口做一次真 TLS 握手，比对 `fingerprint256`。
 *
 * 为什么连**默认网关**而不是 `adminPublicBaseUrl` 的 hostname：portal 容器解析不了 `admin.<伞域>`
 * （实测 `dns.lookup` ⇒ ENOTFOUND）。`servername` 传 adminHost 是为了让 Traefik 选中正确的证书
 * （SNI），不是为了做 hostname 校验——事实④：`rejectUnauthorized:false`，只比指纹。
 *
 * 三种结果（`status`）：`live`（指纹一致）/ `mismatch`（握手成功但端出来的是另一张）/ `unreachable`
 * （连不上 / 超时 / 拿不到对端证书 / 解析不出网关）。**永不抛**——这是探针，不是断言。
 *
 * `connect` 可注入（单测用假 `tls.connect`）。
 */
export async function verifyLiveCertificate({
  expectedFingerprint,
  adminHost,
  adminPort,
  connect = tls.connect,
  routePath = '/proc/net/route',
  fsImpl = fs.promises,
  timeoutMs = TLS_VERIFY_TIMEOUT_MS,
} = {}) {
  const checkedAt = new Date().toISOString();
  const gateway = await readDefaultGateway({ routePath, fsImpl });
  if (!gateway) {
    return { status: 'unreachable', checkedAt, error: 'no_default_gateway' };
  }
  return new Promise((resolve) => {
    let socket;
    let timer;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        /* 已经关了 */
      }
      resolve({ checkedAt, ...result });
    };
    timer = setTimeout(() => finish({ status: 'unreachable', error: 'timeout' }), timeoutMs);
    try {
      socket = connect({
        host: gateway,
        port: adminPort,
        servername: adminHost,
        rejectUnauthorized: false, // 事实④：证书 SAN 不含 IP，校验面只看指纹
      });
    } catch (err) {
      finish({ status: 'unreachable', error: String(err?.code ?? err?.message ?? err) });
      return;
    }
    socket.once('secureConnect', () => {
      let peer;
      try {
        peer = socket.getPeerCertificate();
      } catch (err) {
        finish({ status: 'unreachable', error: String(err?.message ?? err) });
        return;
      }
      if (!peer || !peer.fingerprint256) {
        finish({ status: 'unreachable', error: 'no_peer_certificate' });
        return;
      }
      const fingerprintSha256 = String(peer.fingerprint256).toUpperCase();
      let subjectCN = null;
      try {
        subjectCN = commonNameOf(new crypto.X509Certificate(peer.raw).subject);
      } catch {
        subjectCN = null;
      }
      if (expectedFingerprint && fingerprintSha256 === String(expectedFingerprint).toUpperCase()) {
        finish({ status: 'live', fingerprintSha256, subjectCN });
      } else {
        finish({ status: 'mismatch', fingerprintSha256, subjectCN });
      }
    });
    socket.once('error', (err) => finish({ status: 'unreachable', error: String(err?.code ?? err?.message ?? err) }));
    socket.once('timeout', () => finish({ status: 'unreachable', error: 'timeout' }));
  });
}

// ---------------------------------------------------------------------------
// DB 台账（**不是真相源**：只记「谁什么时候装了什么」）
// ---------------------------------------------------------------------------

/** 落一行台账。`details` 只有元数据，**没有 PEM / 私钥**（红线）。 */
export async function recordCertificateRow(pool, { cert, kind, uploadedBy = null } = {}) {
  const res = await pool.query(
    `INSERT INTO tls_certificates
       (subject_cn, sans, issuer_cn, not_before, not_after, fingerprint_sha256, kind, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, uploaded_at`,
    [
      cert?.subjectCN ?? null,
      Array.isArray(cert?.sans) ? cert.sans : [],
      cert?.issuerCN ?? null,
      cert?.notBefore ?? null,
      cert?.notAfter ?? null,
      cert?.fingerprintSha256 ?? null,
      kind,
      uploadedBy,
    ],
  );
  return res?.rows?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// 响应 DTO（**逐键白名单**：任何新增字段都必须过这里，防「顺手把 keyPem 加进去」）
// ---------------------------------------------------------------------------

/**
 * GET / PUT / verify / rollback 共用的响应形状。
 *
 * 键集**恰好**是 `{configured, active, coverage, live, previous}`：
 *   · `active`：`{subjectCN, sans, issuerCN, notBefore, notAfter, fingerprintSha256}`（**没有** publicKeyPem）
 *   · `coverage`：`{adminHost, covered}`
 *   · `live`：`{status, checkedAt}` + 可选 `{fingerprintSha256, subjectCN, error}`
 *   · `previous`：`{fingerprintSha256, subjectCN, notAfter, savedAt}` 或 `null`
 * 私钥正文、`certPem`/`keyPem` 原文、任何密钥派生值**一律不出现**。
 */
export async function describeTls({ dynamicDir, adminHost, live = null, fsImpl = fs.promises } = {}) {
  const active = await readActiveCertificate({ dynamicDir, fsImpl });
  const previous = await readPreviousCertificate({ dynamicDir, fsImpl });
  const host = normalizeHost(adminHost);
  const covered = active.configured ? certCoversHost(host, active.cert.sans, active.cert.subjectCN) : false;
  return {
    configured: active.configured,
    active: active.configured
      ? {
        subjectCN: active.cert.subjectCN,
        sans: active.cert.sans,
        issuerCN: active.cert.issuerCN,
        notBefore: active.cert.notBefore,
        notAfter: active.cert.notAfter,
        fingerprintSha256: active.cert.fingerprintSha256,
      }
      : null,
    coverage: { adminHost: host, covered },
    live: live
      ? {
        status: live.status,
        checkedAt: live.checkedAt ?? null,
        ...(live.fingerprintSha256 !== undefined ? { fingerprintSha256: live.fingerprintSha256 } : {}),
        ...(live.subjectCN !== undefined ? { subjectCN: live.subjectCN } : {}),
        ...(live.error !== undefined ? { error: live.error } : {}),
      }
      : { status: 'unknown', checkedAt: null },
    previous: previous.present
      ? {
        fingerprintSha256: previous.meta.fingerprintSha256,
        subjectCN: previous.meta.subjectCN,
        notAfter: previous.meta.notAfter,
        savedAt: previous.meta.savedAt,
      }
      : null,
  };
}
