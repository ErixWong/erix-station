// 测试夹具：#456 证书面的**真 PEM**。
//
// 为什么用 openssl 现生成而不是把证书提交进仓库：
//   * **私钥绝不入库**（红线）。测试要的是「配对/不配对」，用真私钥才有牙——所以只能在 `os.tmpdir()`
//     里现生成，用完即弃；
//   * 现网那张 `*.fde.erix.vip` 的 LE 证书 `notAfter=2027-02-03`：拿它当「未过期」夹具的话，
//     2027-02-03 之后整片测试会自己变红。夹具的有效期必须是**相对现在**算的。
//
// 依赖：`openssl` 在 PATH 里（CI 的 ubuntu-latest 自带；本机 OpenSSL 3.0.13 实测）。缺了会直接抛
// `ENOENT` —— 明确失败好过悄悄跳过（跳过 = 这片判据在 CI 里从没跑过）。
//
// 结果按参数缓存：同一份夹具只生成一次（每次 `openssl req` 都要现生成 EC 密钥，几十毫秒）。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cache = new Map();

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tlsfix-${tag}-`));
}

function openssl(args, cwd) {
  return execFileSync('openssl', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
}

function sansExt(sans) {
  return sans.map((s) => `DNS:${s}`).join(',');
}

/**
 * 生成一张自签证书 + 它的私钥。
 *
 * @param {{cn?: string, sans?: string[], days?: number}} opts
 *   `sans: []` ⇒ **不写 SAN 扩展**（用来测「无 SAN 时 CN 兜底」）。
 * @returns {{certPem: string, keyPem: string, dir: string}}
 */
export function makeCert({ cn = '*.fde.erix.vip', sans = ['*.fde.erix.vip', 'fde.erix.vip'], days = 365 } = {}) {
  const cacheKey = JSON.stringify({ cn, sans, days });
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const dir = tmpdir('leaf');
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  const args = [
    'req', '-x509', '-nodes',
    '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', keyPath, '-out', certPath,
    '-days', String(days),
    '-subj', `/CN=${cn}`,
  ];
  if (sans.length > 0) args.push('-addext', `subjectAltName=${sansExt(sans)}`);
  openssl(args, dir);

  const out = {
    certPem: fs.readFileSync(certPath, 'utf8'),
    keyPem: fs.readFileSync(keyPath, 'utf8'),
    dir,
  };
  cache.set(cacheKey, out);
  return out;
}

/**
 * 生成一张**已过期**的证书（`notBefore`/`notAfter` 显式指定）。
 *
 * `openssl req -x509` 只支持「从现在起 N 天」，造不出过期证书；这里走 `openssl ca -selfsign`
 * 的 `-startdate/-enddate`（同一把私钥自签，所以证书与私钥仍然配对 —— 这样「过期」这条判据
 * 是唯一会红的判据，不会被「不配对」抢跑）。
 *
 * @param {{cn?: string, sans?: string[], notBefore?: string, notAfter?: string}} opts
 *   `notBefore`/`notAfter` 用 openssl 的 `YYMMDDHHMMSSZ` 形式，默认 2020 年的两天。
 */
export function makeExpiredCert({
  cn = '*.fde.erix.vip',
  sans = ['*.fde.erix.vip', 'fde.erix.vip'],
  notBefore = '20200101000000Z',
  notAfter = '20200102000000Z',
} = {}) {
  const cacheKey = JSON.stringify({ expired: true, cn, sans, notBefore, notAfter });
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const dir = tmpdir('expired');
  const keyPath = path.join(dir, 'key.pem');
  const csrPath = path.join(dir, 'req.csr');
  const certPath = path.join(dir, 'cert.pem');
  const dbDir = path.join(dir, 'demoCA');
  fs.mkdirSync(path.join(dbDir, 'newcerts'), { recursive: true });
  fs.writeFileSync(path.join(dbDir, 'index.txt'), '');
  fs.writeFileSync(path.join(dbDir, 'serial'), '1000\n');
  const cnfPath = path.join(dir, 'ca.cnf');
  fs.writeFileSync(cnfPath, [
    '[ca]',
    'default_ca = CA_default',
    '[CA_default]',
    'dir = ./demoCA',
    'database = $dir/index.txt',
    'new_certs_dir = $dir/newcerts',
    'serial = $dir/serial',
    'default_md = sha256',
    'policy = policy_any',
    'x509_extensions = v3_req',
    'copy_extensions = copy',
    '[policy_any]',
    'commonName = optional',
    '[v3_req]',
    `subjectAltName = ${sansExt(sans)}`,
    '',
  ].join('\n'));

  openssl([
    'req', '-new', '-nodes',
    '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', keyPath, '-out', csrPath,
    '-subj', `/CN=${cn}`,
    '-addext', `subjectAltName=${sansExt(sans)}`,
  ], dir);
  openssl([
    'ca', '-batch', '-config', cnfPath, '-selfsign', '-keyfile', keyPath,
    '-in', csrPath, '-out', certPath,
    '-startdate', notBefore, '-enddate', notAfter,
  ], dir);

  const out = {
    certPem: fs.readFileSync(certPath, 'utf8'),
    keyPem: fs.readFileSync(keyPath, 'utf8'),
    dir,
  };
  cache.set(cacheKey, out);
  return out;
}

/**
 * 生成一条**真三级链** `root → intermediate → leaf`（issue #462 的链完整性判据要用）。
 *
 * 为什么必须是真链而不是「两张自签拼一起」：C7 的判据是 `X509Certificate#checkIssued()`，它对
 * **签发者名 + 签名 + CA 位（keyUsage keyCertSign）** 一起验——自签证书之间 `checkIssued` 恒 false，
 * 拼出来的「假链」会让 C1/C2 也判成断链，等于整片判据没有牙。所以这里老老实实签三级。
 *
 * `leaf` 的 CN/SAN 默认覆盖管理台域名（`admin.fde.erix.vip`），私钥与叶子配对；root/int 的私钥
 * 生成完就留在 tmpdir 里（**不入库、不进任何响应**，只用来签发）。
 *
 * @returns {{rootPem: string, intermediatePem: string, leafPem: string, keyPem: string,
 *            fullchainPem: string, withRootPem: string, wrongOrderPem: string, dir: string}}
 *   · `fullchainPem` = 叶子 + 中间（C1 的正确形态）
 *   · `withRootPem`  = 叶子 + 中间 + 根（C2）
 *   · `wrongOrderPem`= 中间 + 叶子（C5/C6 的故障形态）
 */
export function makeChain({
  leafCN = 'admin.fde.erix.vip',
  sans = ['admin.fde.erix.vip', '*.fde.erix.vip'],
  rootCN = 'Test Root CA',
  intermediateCN = 'Test Intermediate CA',
} = {}) {
  const cacheKey = JSON.stringify({ chain: true, leafCN, sans, rootCN, intermediateCN });
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const dir = tmpdir('chain');
  const p = (name) => path.join(dir, name);
  const ecKey = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'];

  // ① 根（自签，CA:TRUE + keyCertSign）
  openssl([
    'req', '-x509', '-nodes', ...ecKey,
    '-keyout', p('root.key'), '-out', p('root.pem'),
    '-days', '3650', '-subj', `/CN=${rootCN}`,
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ], dir);

  // ② 中间（由根签，CA:TRUE）
  fs.writeFileSync(p('int.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  openssl([
    'req', '-new', '-nodes', ...ecKey,
    '-keyout', p('int.key'), '-out', p('int.csr'), '-subj', `/CN=${intermediateCN}`,
  ], dir);
  openssl([
    'x509', '-req', '-in', p('int.csr'), '-CA', p('root.pem'), '-CAkey', p('root.key'),
    '-CAcreateserial', '-out', p('int.pem'), '-days', '3650', '-sha256', '-extfile', p('int.ext'),
  ], dir);

  // ③ 叶子（由中间签，CA:FALSE + serverAuth + SAN）—— 有效期相对现在算，别让 2027 之后自己变红
  const leafExt = [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    ...(sans.length > 0 ? [`subjectAltName=${sansExt(sans)}`] : []),
    '',
  ].join('\n');
  fs.writeFileSync(p('leaf.ext'), leafExt);
  openssl([
    'req', '-new', '-nodes', ...ecKey,
    '-keyout', p('leaf.key'), '-out', p('leaf.csr'), '-subj', `/CN=${leafCN}`,
  ], dir);
  openssl([
    'x509', '-req', '-in', p('leaf.csr'), '-CA', p('int.pem'), '-CAkey', p('int.key'),
    '-CAcreateserial', '-out', p('leaf.pem'), '-days', '365', '-sha256', '-extfile', p('leaf.ext'),
  ], dir);

  const rootPem = fs.readFileSync(p('root.pem'), 'utf8');
  const intermediatePem = fs.readFileSync(p('int.pem'), 'utf8');
  const leafPem = fs.readFileSync(p('leaf.pem'), 'utf8');
  const out = {
    rootPem,
    intermediatePem,
    leafPem,
    keyPem: fs.readFileSync(p('leaf.key'), 'utf8'),
    fullchainPem: `${leafPem}${intermediatePem}`,
    withRootPem: `${leafPem}${intermediatePem}${rootPem}`,
    wrongOrderPem: `${intermediatePem}${leafPem}`,
    dir,
  };
  cache.set(cacheKey, out);
  return out;
}
