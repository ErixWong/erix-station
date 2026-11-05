// 管理台 TLS 装载面（issue #450 D5 / feat-261105-01）：把运维手工放好的证书物化成 Traefik 动态配置
// `<dynamic>/tls.yml`。**证书生命周期（上传/校验/回滚）是 #456，不在本单**——本模块只做「有证书就亮起来」。
//
// 为什么是动态配置而不是静态配置：`<dynamic>` 目录 portal 可写、Traefik 侧 `watch: true` ⇒ 换证书
// **不需要重启边缘**（静态配置改一行要重启整个 Traefik，等于用户面 + 全部预览 + 管理台一起抖一下）。
//
// 三个动态文件的分工（互不重叠、各自独立物化）：
//   · routes.yml      —— 路由（portal routes.js 全量重建，禁手改）
//   · llm-routes.yml  —— LLM 段 + per-FDE key 明文（同上，mode 600）
//   · tls.yml         —— **只**声明证书装载面（本模块物化）；#456 将来只重写这一个文件
// 三者同目录、互不引用：任一份坏掉都不该连坐另外两份（这也是「两文件齐才生成」的理由——一份指向
// 不存在文件的 tls.yml 会让 file provider 整个目录加载失败，连带丢路由）。
//
// 红线：私钥只以**路径**形式出现在生成物里（不读进正文、不进日志、不进 DB）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './fsutil.js';

export const TLS_CERT_FILENAME = 'tls.crt';
export const TLS_KEY_FILENAME = 'tls.key';
/** 生成的动态文件名（与 routes.yml / llm-routes.yml 同级、互不重叠）。 */
export const TLS_DYNAMIC_FILE = 'tls.yml';
/** 证书目录名（相对 `<dynamic>`）：运维把 tls.crt / tls.key 放这里（宿主侧 `<TRAEFIK_DYNAMIC_DIR_HOST>/certs/`）。 */
export const TLS_CERT_DIRNAME = 'certs';

/** 证书/私钥/生成物的绝对路径（portal 容器内路径；Traefik 挂的是同一个宿主目录，故路径对它同样成立）。 */
export function tlsPaths(dynamicDir) {
  const certDir = path.posix.join(dynamicDir, TLS_CERT_DIRNAME);
  return {
    certDir,
    certPath: path.posix.join(certDir, TLS_CERT_FILENAME),
    keyPath: path.posix.join(certDir, TLS_KEY_FILENAME),
    target: path.posix.join(dynamicDir, TLS_DYNAMIC_FILE),
  };
}

/**
 * 渲染 tls.yml（纯函数，可单测）。
 *
 * `defaultCertificate` + `certificates` 两处都要写：
 *   · `tls.certificates` 是「可用的证书清单」（SNI 匹配用）；
 *   · `tls.stores.default.defaultCertificate` 是**兜底证书**——SNI 不匹配时用它。
 * 只有 certificates 时，用 `admin.<伞域>` 之外的名字访问会拿到 Traefik 内建自签证书（浏览器告警），
 * 而管理台正是靠「一张证书覆盖 admin.<伞域>」成立的（#456 的硬校验口径）。
 *
 * @param {{certPath: string, keyPath: string, fingerprint: string}} args
 */
export function renderTlsConfig({ certPath, keyPath, fingerprint }) {
  const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return [
    '# 由 portal 的 tlsassets 物化（issue #450 D5 装载面；证书生命周期 #456）。**禁手改**——下一次物化整份重写。',
    '# 三个动态文件互不重叠、各自独立物化：routes.yml（路由）/ llm-routes.yml（LLM 含密段）/ tls.yml（本文件）。',
    '# 生成条件：certs/tls.crt 与 certs/tls.key 都存在且非空；任一缺失 ⇒ 本文件被删除（不留指向不存在文件的配置）。',
    '# 私钥只以路径形式出现，正文/日志/DB 里都没有它。',
    `# fingerprint=${fingerprint}`,
    'tls:',
    '  stores:',
    '    default:',
    '      defaultCertificate:',
    `        certFile: ${q(certPath)}`,
    `        keyFile: ${q(keyPath)}`,
    '  certificates:',
    `    - certFile: ${q(certPath)}`,
    `      keyFile: ${q(keyPath)}`,
    '',
  ].join('\n');
}

/**
 * 读一份证书物料。**任何读失败都不抛**（证书面坏了不许把 materializer 拖死）：
 * 返回值区分「不存在/空/不可读」，调用方一律按「不可用」处理（= 不生成 tls.yml）。
 */
async function readAsset(p, fsImpl) {
  try {
    const st = await fsImpl.stat(p);
    if (!st.isFile()) return { ok: false, code: 'not-file', reason: `${p} 不是普通文件` };
    const buf = await fsImpl.readFile(p);
    if (buf.length === 0) return { ok: false, code: 'empty', reason: `${p} 是空文件` };
    return { ok: true, buf, mtimeMs: st.mtimeMs };
  } catch (err) {
    const code = err?.code ?? 'unknown';
    // 缺失与「读得到但读不了」要分开：前者是稳态（未部署证书），后者是故障（权限/挂载错），
    // 后者必须每次物化都响一次（否则运维只会看到「管理台证书没了」而不知道原因）。
    return { ok: false, code: code === 'ENOENT' ? 'missing' : 'unreadable', reason: `${p} 读取失败（${code}）` };
  }
}

/**
 * 只探测一份物料的**存在性与大小**，**绝不读字节**（#462 / 安全文档 S4：私钥读路径不碰正文）。
 *
 * 判据与 `readAsset` 逐条对齐（不是普通文件 / 空文件 / 缺失 / 读不了），**只是不 `readFile`**：
 *   · `stat.size > 0` 就是「非空」——内容是不是一把合法的钥匙不归装载面管（那是上传时的事）；
 *   · `mtimeMs` 是 fingerprint 里的 reload 把手（只换私钥不动证书时靠它变化）；
 *   · 失败仍然不抛，语义与 `readAsset` 完全一致（调用方无需分支）。
 */
async function statAsset(p, fsImpl) {
  try {
    const st = await fsImpl.stat(p);
    if (!st.isFile()) return { ok: false, code: 'not-file', reason: `${p} 不是普通文件` };
    if (!(st.size > 0)) return { ok: false, code: 'empty', reason: `${p} 是空文件` };
    return { ok: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch (err) {
    const code = err?.code ?? 'unknown';
    return { ok: false, code: code === 'ENOENT' ? 'missing' : 'unreadable', reason: `${p} 读取失败（${code}）` };
  }
}

/**
 * 探测证书物料是否齐备。
 * fingerprint = `sha256:<证书字节哈希> keymtime=<私钥 mtimeMs>`：
 *   · 证书换新 ⇒ 哈希变；只换私钥（证书不变）⇒ mtime 变。两者都覆盖，且**不含私钥内容的任何派生值**。
 *   · 这一行是给 #456 的 reload 把手：Traefik 的 file provider 是文件驱动的，只替换 certs/* 而不动
 *     tls.yml 可能不触发 reload（证书文件本身不是被 watch 的配置文件），改这一行必然触发。
 *
 * **私钥只 `stat`，不 `readFile`**（#462 / 安全文档 S4）：portal 的读路径永不接触私钥字节，
 * 只有上传那一刻必须接收管理员递来的。副作用（好的那种）：以非 root 身份跑时
 * `GET /api/admin/tls` 不再因为「私钥读不动」而报 `unreadable`。
 */
export async function readTlsAssets({ dynamicDir, fsImpl = fs.promises } = {}) {
  const { certPath, keyPath, target } = tlsPaths(dynamicDir);
  const cert = await readAsset(certPath, fsImpl);
  if (!cert.ok) return { ok: false, target, code: cert.code, reason: cert.reason, certPath, keyPath };
  // ⚠ 这里是 S4 的全部：私钥走 `statAsset`（只看 size / mtimeMs），**没有 readFile(keyPath)**。
  const key = await statAsset(keyPath, fsImpl);
  if (!key.ok) return { ok: false, target, code: key.code, reason: key.reason, certPath, keyPath };
  const digest = crypto.createHash('sha256').update(cert.buf).digest('hex');
  return {
    ok: true,
    target,
    certPath,
    keyPath,
    fingerprint: `sha256:${digest} keymtime=${Math.round(key.mtimeMs)}`,
  };
}

/**
 * 物化 `<dynamic>/tls.yml`：两文件齐且非空 ⇒ 写；否则**删除**已有文件（幂等，ENOENT 视为成功）。
 *
 * **本函数不抛**（除参数编程错误）：证书面的任何失败都只降级为「管理台入口没有自定义证书」
 * （Traefik 回落内建自签证书），绝不让 routes.yml/llm-routes.yml 的发布跟着失败——
 * 用户面与全部预览的可用性高于管理台的证书质量。
 *
 * @param {{dynamicDir: string, log?: Console, fsImpl?: typeof fs.promises}} args
 * @returns {Promise<{target: string, published: boolean, reason?: string}>}
 */
export async function materializeTlsAssets({ dynamicDir, log = console, fsImpl = fs.promises } = {}) {
  const state = await readTlsAssets({ dynamicDir, fsImpl });
  const { target } = state;
  if (!state.ok) {
    let removed = false;
    let removalFailed = false;
    try {
      await fsImpl.unlink(target);
      removed = true;
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        // 摘除失败：盘上可能留着一份指向不存在文件的 tls.yml ⇒ Traefik 会把整个动态目录判死
        //（连带丢全部路由）。这是必须响的异常态，但仍然不抛（见函数头注释）。
        removalFailed = true;
        log.error?.(`[tls] ${state.reason} 且旧 tls.yml 摘除失败（${err?.code ?? err?.message}）—— 可能残留一份坏配置，请人工检查 ${target}`);
      }
    }
    // 日志口径：只在「有事发生」时说一句——① 摘除了旧文件（状态变化）；② 证书存在但不可用
    //（空文件/不是普通文件/权限错）。「本来就没证书、也没旧文件」是稳态，不刷屏。
    if (!removalFailed && (removed || state.code !== 'missing')) {
      log.warn?.(`[tls] ${state.reason} ⇒ 不生成 tls.yml（${removed ? '已摘除旧文件' : '本无旧文件'}；管理台入口回落 Traefik 内建自签证书）`);
    }
    return { target, published: false, code: state.code, reason: state.reason };
  }
  const text = renderTlsConfig({
    certPath: state.certPath,
    keyPath: state.keyPath,
    fingerprint: state.fingerprint,
  });
  try {
    // 0644：本文件只含路径与哈希，无私钥内容。
    atomicWriteFile(target, text, { mode: 0o644, root: dynamicDir });
  } catch (err) {
    log.error?.(`[tls] tls.yml 写入失败（${err?.code ?? err?.message}）—— 管理台入口回落 Traefik 内建自签证书`);
    return { target, published: false, reason: String(err?.message ?? err) };
  }
  return { target, published: true };
}
