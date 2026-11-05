// 单测：#456 证书生命周期（`portal/src/tls-cert.js`）——**纯函数**为主。
//
// 判据来源：工单 `.work-orders/feat-261105-03-456-tls-api.md` §2/§5，issue #456。
// 夹具：`tls-fixtures.js` 在 `os.tmpdir()` 用 openssl 现生成（**私钥绝不入库**）。
//
// 每条判据都能被打红（工单要求的四条变异落在这里的三条）：
//   ① 去掉「覆盖 adminHost」判据 ⇒ 「不覆盖 adminHost 必须拒」红；
//   ② 通配符改成 `endsWith`（两级也放过）⇒ 「通配符只一层」红；
//   ③ 过期判据去掉 ⇒ 「过期必须拒」红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  TLS_KEY_MODE,
  TLS_MAX_PEM_BYTES,
  TlsCertError,
  certCoversHost,
  certificateDomains,
  describeChain,
  describeTls,
  fingerprintOfPem,
  inspectCertificate,
  keyMatchesCert,
  parseCertificateChain,
  parseCertificatePem,
  parseDefaultGateway,
  parsePrivateKeyPem,
  peerChainDepth,
  readPreviousCertificate,
  selectLeaf,
  validateUpload,
  verifyLiveCertificate,
  writeCertificateAssets,
  rollbackCertificateAssets,
  readActiveCertificate,
} from '../src/tls-cert.js';
import { makeCert, makeChain, makeExpiredCert } from './tls-fixtures.js';

const ADMIN_HOST = 'admin.fde.erix.vip';
const WILDCARD = makeCert(); // CN=*.fde.erix.vip, SAN=*.fde.erix.vip,fde.erix.vip
const OTHER = makeCert({ cn: 'other.example', sans: ['other.example'] });
const NO_SAN_CN = makeCert({ cn: ADMIN_HOST, sans: [] });
const SAN_WITHOUT_ADMIN = makeCert({ cn: ADMIN_HOST, sans: ['other.example'] });
const EXPIRED = makeExpiredCert();
// #462：真三级链 root → intermediate → leaf（叶子 CN/SAN 覆盖 adminHost）。
const CHAIN = makeChain();

// ---------------------------------------------------------------------------
// ① 通配符只匹配一层 / 大小写 / SAN 与 CN 的优先级
// ---------------------------------------------------------------------------

test('#456 域名覆盖：通配符只匹配**一层**（*.fde.erix.vip 覆盖 admin.fde.erix.vip，不覆盖 a.b.…）', () => {
  assert.equal(certCoversHost('admin.fde.erix.vip', ['*.fde.erix.vip'], null), true);
  assert.equal(
    certCoversHost('a.b.fde.erix.vip', ['*.fde.erix.vip'], null),
    false,
    '两级子域**不**被单层通配覆盖（`endsWith` 那种写法会把它放过去，等于放宽证书能力）',
  );
  // 裸域由 SAN 里的精确项覆盖，不是靠通配
  assert.equal(certCoversHost('fde.erix.vip', ['*.fde.erix.vip', 'fde.erix.vip'], null), true);
  assert.equal(certCoversHost('fde.erix.vip', ['*.fde.erix.vip'], null), false);
});

test('#456 域名覆盖：大小写不敏感 + 结尾点归一', () => {
  assert.equal(certCoversHost('ADMIN.FDE.ERIX.VIP', ['*.fde.erix.vip'], null), true);
  assert.equal(certCoversHost('admin.fde.erix.vip.', ['*.FDE.erix.vip'], null), true);
});

test('#456 域名覆盖：**有 SAN 时忽略 CN**（浏览器口径），无 SAN 时才用 CN 兜底', () => {
  // SAN 只写了 other.example、CN 写了 admin ⇒ 不覆盖（浏览器会拒，我们不能放行）
  assert.equal(
    certCoversHost(ADMIN_HOST, ['other.example'], ADMIN_HOST),
    false,
    '有 SAN 时 CN 不参与匹配',
  );
  // 无 SAN ⇒ CN 兜底
  assert.equal(certCoversHost(ADMIN_HOST, [], ADMIN_HOST), true);
  assert.equal(certCoversHost(ADMIN_HOST, [], 'other.example'), false);
  // 非法形态（* 不在最左 / 多个 *）一律不匹配，不去猜
  assert.equal(certCoversHost('a.b.example.com', ['a.*.example.com'], null), false);
  assert.equal(certCoversHost('example.com', ['*.*.example.com'], null), false);
});

test('#456 certificateDomains：有 SAN 用 SAN，否则用 CN（给 details.certDomains 用）', () => {
  assert.deepEqual(certificateDomains({ sans: ['a.example', 'b.example'], subjectCN: 'x' }), ['a.example', 'b.example']);
  assert.deepEqual(certificateDomains({ sans: [], subjectCN: 'x.example' }), ['x.example']);
  assert.deepEqual(certificateDomains({ sans: [], subjectCN: null }), []);
});

// ---------------------------------------------------------------------------
// ② 解析 + 公钥配对
// ---------------------------------------------------------------------------

test('#456 parseCertificatePem：CN/SAN/有效期/指纹形状（冒号分隔大写）', () => {
  const info = parseCertificatePem(WILDCARD.certPem);
  assert.equal(info.subjectCN, '*.fde.erix.vip');
  assert.deepEqual(info.sans, ['*.fde.erix.vip', 'fde.erix.vip']);
  assert.match(info.fingerprintSha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, '指纹必须是冒号分隔大写（与 getPeerCertificate 同形）');
  assert.ok(Date.parse(info.notAfter) > Date.now(), '夹具必须是未过期的（相对现在算有效期）');
  assert.ok(info.publicKeyPem.includes('BEGIN PUBLIC KEY'));
  // fullchain 也认：只看第一份（叶子）——Traefik 端出来的就是它
  const chain = parseCertificatePem(`${WILDCARD.certPem}${OTHER.certPem}`);
  assert.equal(chain.fingerprintSha256, info.fingerprintSha256, 'fullchain 取叶子证书');
});

test('#456 parseCertificatePem / parsePrivateKeyPem：非法输入抛具名错误码', () => {
  assert.throws(() => parseCertificatePem('not a pem'), (err) => err instanceof TlsCertError && err.code === 'tls_cert_invalid');
  assert.throws(() => parseCertificatePem(''), (err) => err.code === 'tls_cert_invalid');
  assert.throws(() => parsePrivateKeyPem(WILDCARD.certPem), (err) => err.code === 'tls_key_invalid');
});

test('#456 keyMatchesCert：配对为真，**错配必须为假**（DER 比较，不比 PEM 文本）', () => {
  const info = parseCertificatePem(WILDCARD.certPem);
  assert.equal(keyMatchesCert(info, parsePrivateKeyPem(WILDCARD.keyPem)), true);
  assert.equal(
    keyMatchesCert(info, parsePrivateKeyPem(OTHER.keyPem)),
    false,
    '别人的私钥必须被判为不配对（这条是「装错私钥 ⇒ 管理台握手全挂」的唯一防线）',
  );
});

test('#456 fingerprintOfPem：与 parseCertificatePem 的指纹逐字符相同', () => {
  assert.equal(fingerprintOfPem(WILDCARD.certPem), parseCertificatePem(WILDCARD.certPem).fingerprintSha256);
});

// ---------------------------------------------------------------------------
// ③ validateUpload：五道判据（顺序固定，失败零副作用）
// ---------------------------------------------------------------------------

test('#456 validateUpload：合法证书 ⇒ ok + 解析结果', () => {
  const out = validateUpload({ certPem: WILDCARD.certPem, keyPem: WILDCARD.keyPem, adminHost: ADMIN_HOST });
  assert.equal(out.ok, true);
  assert.equal(out.cert.subjectCN, '*.fde.erix.vip');
});

test('#456 validateUpload：**不覆盖 adminHost 必须拒**，details 点名缺哪个域名 + 证书有哪些域名', () => {
  const out = validateUpload({ certPem: OTHER.certPem, keyPem: OTHER.keyPem, adminHost: ADMIN_HOST });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'tls_cert_domain_mismatch');
  assert.deepEqual(out.details.missing, [ADMIN_HOST], 'details.missing 必须点名 adminHost');
  assert.deepEqual(out.details.certDomains, ['other.example']);
  assert.equal(out.details.adminHost, ADMIN_HOST);
});

test('#456 validateUpload：**过期必须拒**（now 可注入，不依赖系统时钟）', () => {
  const expired = validateUpload({ certPem: EXPIRED.certPem, keyPem: EXPIRED.keyPem, adminHost: ADMIN_HOST });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, 'tls_cert_expired');
  // 同一张证书把时钟拨回 2019 年 ⇒ 通过（证明拒的理由确实是「过期」而不是别的）
  const backThen = validateUpload({
    certPem: EXPIRED.certPem,
    keyPem: EXPIRED.keyPem,
    adminHost: ADMIN_HOST,
    now: new Date('2019-12-31T00:00:00Z'),
  });
  assert.equal(backThen.ok, true, '过期判据只由 notAfter 与 now 决定');
});

test('#456 validateUpload：私钥不配对 ⇒ tls_key_mismatch', () => {
  const out = validateUpload({ certPem: WILDCARD.certPem, keyPem: OTHER.keyPem, adminHost: ADMIN_HOST });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'tls_key_mismatch');
});

test('#456 validateUpload：confirmDomains **不能超出证书能力**（用户声明 ≠ 证书能力）', () => {
  const out = validateUpload({
    certPem: WILDCARD.certPem,
    keyPem: WILDCARD.keyPem,
    adminHost: ADMIN_HOST,
    confirmDomains: [ADMIN_HOST, 'a.b.fde.erix.vip'],
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'tls_cert_domain_mismatch');
  assert.deepEqual(out.details.missing, ['a.b.fde.erix.vip'], '只点名超出能力的那个');
  // 子集（证书覆盖得到）⇒ 通过
  const ok = validateUpload({
    certPem: WILDCARD.certPem,
    keyPem: WILDCARD.keyPem,
    adminHost: ADMIN_HOST,
    confirmDomains: [ADMIN_HOST, 'fde.erix.vip'],
  });
  assert.equal(ok.ok, true);
});

test('#456 validateUpload：无 SAN 的证书靠 CN 兜底也算覆盖', () => {
  const out = validateUpload({ certPem: NO_SAN_CN.certPem, keyPem: NO_SAN_CN.keyPem, adminHost: ADMIN_HOST });
  assert.equal(out.ok, true);
  // 反过来：SAN 存在但只写了别的名字 ⇒ CN 不救场
  const out2 = validateUpload({
    certPem: SAN_WITHOUT_ADMIN.certPem, keyPem: SAN_WITHOUT_ADMIN.keyPem, adminHost: ADMIN_HOST,
  });
  assert.equal(out2.ok, false);
  assert.equal(out2.code, 'tls_cert_domain_mismatch');
});

test('#456 validateUpload：PEM 各 ≤ 64 KiB（超限 ⇒ validation_failed + details.field）', () => {
  const huge = `-----BEGIN CERTIFICATE-----\n${'A'.repeat(TLS_MAX_PEM_BYTES)}\n-----END CERTIFICATE-----\n`;
  const out = validateUpload({ certPem: huge, keyPem: WILDCARD.keyPem, adminHost: ADMIN_HOST });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'validation_failed');
  assert.equal(out.details.field, 'certPem');
  const out2 = validateUpload({ certPem: WILDCARD.certPem, keyPem: huge, adminHost: ADMIN_HOST });
  assert.equal(out2.details.field, 'keyPem');
  // 非字符串同样拦（否则会在 OpenSSL 里变成另一种错误）
  const out3 = validateUpload({ certPem: 123, keyPem: WILDCARD.keyPem, adminHost: ADMIN_HOST });
  assert.equal(out3.code, 'validation_failed');
});

// ---------------------------------------------------------------------------
// ④ 写盘 / 备份 / 回滚（盘是真相）
// ---------------------------------------------------------------------------

function tmpDynamicDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tlscert-${tag}-`));
}

const quietLog = () => ({ warn() {}, error() {}, log() {} });

test('#456 writeCertificateAssets：先备份 → 写 crt(644) → 写 key(600) → 物化 tls.yml', async () => {
  const dir = tmpDynamicDir('write');
  try {
    const first = await writeCertificateAssets({
      dynamicDir: dir, certPem: WILDCARD.certPem, keyPem: WILDCARD.keyPem, log: quietLog(),
    });
    assert.equal(first.backup, null, '首次上传没有上一代可备份');
    assert.equal(first.tlsOut.published, true);
    const certPath = path.join(dir, 'certs', 'tls.crt');
    const keyPath = path.join(dir, 'certs', 'tls.key');
    assert.equal(fs.readFileSync(certPath, 'utf8'), WILDCARD.certPem);
    assert.equal(fs.readFileSync(keyPath, 'utf8'), WILDCARD.keyPem);
    assert.equal(fs.statSync(keyPath).mode & 0o777, TLS_KEY_MODE, '私钥必须 0600（事实①：属主 root + 600 才读得动）');
    assert.equal(fs.statSync(certPath).mode & 0o777, 0o644);
    const tlsYml = fs.readFileSync(path.join(dir, 'tls.yml'), 'utf8');
    assert.match(tlsYml, /# fingerprint=sha256:[0-9a-f]{64} keymtime=\d+/);
    assert.ok(tlsYml.includes(certPath) && tlsYml.includes(keyPath), '私钥只以**路径**形式出现在 tls.yml');
    assert.ok(!tlsYml.includes('PRIVATE KEY'), 'tls.yml 正文里绝不许有私钥内容');

    // 第二次上传 ⇒ 上一代进 prev/，meta.json 存在且**不含 PEM**
    const second = await writeCertificateAssets({
      dynamicDir: dir, certPem: OTHER.certPem, keyPem: OTHER.keyPem, log: quietLog(),
    });
    assert.ok(second.backup, '覆盖上传必须留一代备份');
    const prev = await readPreviousCertificate({ dynamicDir: dir });
    assert.equal(prev.present, true);
    assert.equal(prev.meta.fingerprintSha256, parseCertificatePem(WILDCARD.certPem).fingerprintSha256);
    const metaText = fs.readFileSync(path.join(dir, 'certs', 'prev', 'meta.json'), 'utf8');
    assert.ok(!metaText.includes('BEGIN'), 'meta.json 里不许有 PEM');
    assert.ok(!metaText.includes('PRIVATE KEY'));
    assert.equal(fs.statSync(path.join(dir, 'certs', 'prev', 'tls.key')).mode & 0o777, TLS_KEY_MODE, '备份的私钥同样 0600');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#456 writeCertificateAssets：写私钥失败要说清是 key 这一步（盘上不留「新 crt + 旧 key」）', async () => {
  const dir = tmpDynamicDir('step');
  try {
    // 用「tls.key 是个目录」制造 key 写入失败（rename 到目录上必然失败）。
    fs.mkdirSync(path.join(dir, 'certs', 'tls.key'), { recursive: true });
    await assert.rejects(
      () => writeCertificateAssets({ dynamicDir: dir, certPem: WILDCARD.certPem, keyPem: WILDCARD.keyPem, log: quietLog() }),
      (err) => {
        assert.equal(err.code, 'internal');
        assert.equal(err.details.step, 'key', '失败步骤必须可判（运维要区分盘满 / 证书坏）');
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#456 rollback：prev 不存在 ⇒ 404 tls_no_previous；存在 ⇒ 还原 + 重新物化', async () => {
  const dir = tmpDynamicDir('rollback');
  try {
    await assert.rejects(
      () => rollbackCertificateAssets({ dynamicDir: dir, log: quietLog() }),
      (err) => err.code === 'tls_no_previous' && err.httpStatus === 404,
    );

    await writeCertificateAssets({ dynamicDir: dir, certPem: WILDCARD.certPem, keyPem: WILDCARD.keyPem, log: quietLog() });
    await writeCertificateAssets({ dynamicDir: dir, certPem: OTHER.certPem, keyPem: OTHER.keyPem, log: quietLog() });
    assert.equal((await readActiveCertificate({ dynamicDir: dir })).cert.subjectCN, 'other.example');

    const out = await rollbackCertificateAssets({ dynamicDir: dir, log: quietLog() });
    assert.equal(out.tlsOut.published, true);
    assert.equal(out.cert.subjectCN, '*.fde.erix.vip', '回滚到上一代（prev 里的那张）');
    const active = await readActiveCertificate({ dynamicDir: dir });
    assert.equal(fs.readFileSync(path.join(dir, 'certs', 'tls.crt'), 'utf8'), WILDCARD.certPem);
    assert.equal(fs.statSync(path.join(dir, 'certs', 'tls.key')).mode & 0o777, TLS_KEY_MODE);
    assert.match(fs.readFileSync(path.join(dir, 'tls.yml'), 'utf8'), /# fingerprint=/);
    assert.equal(active.configured, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#456 readActiveCertificate：无证书 ⇒ configured:false 且不抛', async () => {
  const dir = tmpDynamicDir('empty');
  try {
    assert.deepEqual(await readActiveCertificate({ dynamicDir: dir }), { configured: false, reason: 'missing' });
    // 只有 crt 没有 key ⇒ 仍是「未配置」（tls.yml 也不会生成）
    fs.mkdirSync(path.join(dir, 'certs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'certs', 'tls.crt'), WILDCARD.certPem);
    const out = await readActiveCertificate({ dynamicDir: dir });
    assert.equal(out.configured, false);
    assert.equal(out.reason, 'missing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#456 describeTls：无证书 ⇒ 白名单形状 + coverage.covered=false（GET 的基线）', async () => {
  const dir = tmpDynamicDir('describe');
  try {
    const dto = await describeTls({ dynamicDir: dir, adminHost: ADMIN_HOST });
    assert.deepEqual(dto, {
      configured: false,
      active: null,
      coverage: { adminHost: ADMIN_HOST, covered: false },
      live: { status: 'unknown', checkedAt: null },
      previous: null,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#456 describeTls：有证书 ⇒ active 只有六个键（**没有** publicKeyPem）', async () => {
  const dir = tmpDynamicDir('describe2');
  try {
    await writeCertificateAssets({ dynamicDir: dir, certPem: WILDCARD.certPem, keyPem: WILDCARD.keyPem, log: quietLog() });
    const dto = await describeTls({ dynamicDir: dir, adminHost: ADMIN_HOST });
    assert.equal(dto.configured, true);
    assert.deepEqual(Object.keys(dto.active).sort(), [
      'fingerprintSha256', 'issuerCN', 'notAfter', 'notBefore', 'sans', 'subjectCN',
    ]);
    assert.equal(dto.coverage.covered, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⑤ 默认网关 + 真机握手比对（事实③④）
// ---------------------------------------------------------------------------

test('#456 parseDefaultGateway：现网 `/proc/net/route` ⇒ 172.32.0.1（小端 hex）', () => {
  const real = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'eth0\t00000000\t010020AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
    'eth0\t0000AC14\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
    '',
  ].join('\n');
  assert.equal(parseDefaultGateway(real), '172.32.0.1');
  // 没有默认路由 / 空文本 ⇒ null（调用方报 unreachable，不瞎猜地址）
  assert.equal(parseDefaultGateway('Iface\tDestination\tGateway\n'), null);
  assert.equal(parseDefaultGateway(''), null);
  assert.equal(parseDefaultGateway(undefined), null);
});

function fakeRouteFile(gatewayHex = '010020AC') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlsroute-'));
  const p = path.join(dir, 'route');
  fs.writeFileSync(p, `Iface\tDestination\tGateway\tFlags\tRefCount\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t${gatewayHex}\t0003\t0\t0\t0\t00000000\t0\t0\t0\n`);
  return { path: p, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('#456 verifyLiveCertificate：指纹一致 ⇒ live；不一致 ⇒ mismatch；连不上 ⇒ unreachable', async () => {
  const { EventEmitter } = await import('node:events');
  const route = fakeRouteFile();
  const expected = parseCertificatePem(WILDCARD.certPem).fingerprintSha256;
  const raw = new crypto.X509Certificate(WILDCARD.certPem).raw;
  const makeConnect = ({ fingerprint256, raw: peerRaw, error }) => (opts) => {
    assert.equal(opts.host, '172.32.0.1', '连的是默认网关（事实③：portal 解析不了 admin.<伞域>）');
    assert.equal(opts.servername, ADMIN_HOST, 'SNI 传 adminHost，让 Traefik 选中正确的证书');
    assert.equal(opts.rejectUnauthorized, false, '事实④：证书 SAN 不含 IP，只看指纹');
    const sock = new EventEmitter();
    sock.destroy = () => {};
    sock.getPeerCertificate = () => ({ fingerprint256, raw: peerRaw });
    if (error) {
      setImmediate(() => sock.emit('error', Object.assign(new Error(error), { code: error })));
    } else {
      setImmediate(() => sock.emit('secureConnect'));
    }
    return sock;
  };

  try {
    const live = await verifyLiveCertificate({
      expectedFingerprint: expected,
      adminHost: ADMIN_HOST,
      adminPort: 9443,
      routePath: route.path,
      connect: makeConnect({ fingerprint256: expected, raw }),
    });
    assert.equal(live.status, 'live');
    assert.equal(live.fingerprintSha256, expected);

    const mismatch = await verifyLiveCertificate({
      expectedFingerprint: expected,
      adminHost: ADMIN_HOST,
      adminPort: 9443,
      routePath: route.path,
      connect: makeConnect({ fingerprint256: OTHER_FP(), raw }),
    });
    assert.equal(mismatch.status, 'mismatch', '端出来的是另一张证书 ⇒ mismatch（这是「上传了但没生效」的唯一证据）');
    assert.equal(mismatch.fingerprintSha256, OTHER_FP());

    const unreachable = await verifyLiveCertificate({
      expectedFingerprint: expected,
      adminHost: ADMIN_HOST,
      adminPort: 9443,
      routePath: route.path,
      connect: makeConnect({ fingerprint256: expected, raw, error: 'ECONNREFUSED' }),
    });
    assert.equal(unreachable.status, 'unreachable');
    assert.equal(unreachable.error, 'ECONNREFUSED');

    // 超时 ⇒ unreachable（5s 默认，这里把 timeoutMs 压到 20ms 且让 socket 永不握手）
    const silent = (opts) => {
      const sock = new EventEmitter();
      sock.destroy = () => {};
      sock.getPeerCertificate = () => ({});
      return sock;
    };
    const timeout = await verifyLiveCertificate({
      expectedFingerprint: expected,
      adminHost: ADMIN_HOST,
      adminPort: 9443,
      routePath: route.path,
      connect: silent,
      timeoutMs: 20,
    });
    assert.equal(timeout.status, 'unreachable');
    assert.equal(timeout.error, 'timeout');

    // 解析不出网关 ⇒ unreachable（不瞎猜地址）
    const noRoute = await verifyLiveCertificate({
      expectedFingerprint: expected,
      adminHost: ADMIN_HOST,
      adminPort: 9443,
      routePath: '/nonexistent/route',
      connect: makeConnect({ fingerprint256: expected, raw }),
    });
    assert.equal(noRoute.status, 'unreachable');
    assert.equal(noRoute.error, 'no_default_gateway');
  } finally {
    route.cleanup();
  }
});

function OTHER_FP() {
  return parseCertificatePem(OTHER.certPem).fingerprintSha256;
}

// ---------------------------------------------------------------------------
// ⑥ #462 链完整性（M1）：parseCertificateChain / selectLeaf / describeChain + C1–C7
//
// 判据来源：工单 `.work-orders/fix-261105-05-462-tls-chain.md` §1.2 的 C1–C7 判定表。
// 每条都能被打红（变异取证见 `AGENTS.md` §8.100）。
// ---------------------------------------------------------------------------

test('#462 parseCertificateChain：逐段切分（fullchain=2 / with-root=3），空串与无段抛 tls_cert_invalid', () => {
  const full = parseCertificateChain(CHAIN.fullchainPem);
  assert.equal(full.blocks.length, 2, '叶子 + 中间 = 2 段');
  assert.equal(full.pem.length, 2);
  assert.equal(parseCertificatePem(full.pem[0]).subjectCN, 'admin.fde.erix.vip', '第 1 段是叶子');
  assert.equal(parseCertificatePem(full.pem[1]).subjectCN, 'Test Intermediate CA');
  assert.equal(parseCertificateChain(CHAIN.withRootPem).blocks.length, 3);
  // 每段都是原样切片（不重新序列化）⇒ 与输入里的那一段逐字相同（落盘字节由调用方负责，这里只证不篡改）
  assert.equal(full.pem[0], CHAIN.leafPem.trimEnd(), '第 1 段必须与用户提交的叶子 PEM 逐字相同');
  assert.equal(full.pem[1], CHAIN.intermediatePem.trimEnd(), '第 2 段同理（不重排、不重新序列化）');
  assert.throws(() => parseCertificateChain(''), (err) => err.code === 'tls_cert_invalid');
  assert.throws(() => parseCertificateChain('no pem here'), (err) => err.code === 'tls_cert_invalid');
});

test('#462 selectLeaf：有私钥时找**配对的那段**（第二段也能找到）；无私钥取第一段；对不上 ⇒ index:-1', () => {
  const blocks = parseCertificateChain(CHAIN.wrongOrderPem).blocks; // [中间, 叶子]
  const keyObj = parsePrivateKeyPem(CHAIN.keyPem);
  const picked = selectLeaf(blocks, keyObj);
  assert.equal(picked.index, 1, '叶子在第二段 ⇒ index=1（`blocks[0]` 那种写法会把中间证书当叶子）');
  assert.equal(parseCertificatePem(picked.leaf.toString()).subjectCN, 'admin.fde.erix.vip');

  const noKey = selectLeaf(blocks);
  assert.equal(noKey.index, 0, '没私钥就无法从密钥判断，按约定取第一段');
  assert.equal(noKey.leaf, blocks[0]);

  const wrongKey = selectLeaf(blocks, parsePrivateKeyPem(OTHER.keyPem));
  assert.equal(wrongKey.index, -1, '一把对不上的私钥 ⇒ 没有任何一段配对');
  assert.equal(wrongKey.leaf, blocks[0], '退回第一段，由调用方决定报什么');
});

test('#462 describeChain：三级链 links=[true,true]；自签单张 depth=1；**隔代不算**（leaf.checkIssued(root)=false）', () => {
  const chain = describeChain(parseCertificateChain(CHAIN.withRootPem).blocks);
  assert.deepEqual(chain, { depth: 3, links: [true, true] });
  const leafAndRoot = describeChain([
    new crypto.X509Certificate(CHAIN.leafPem),
    new crypto.X509Certificate(CHAIN.rootPem),
  ]);
  assert.deepEqual(leafAndRoot.links, [false], '叶子不是根签的（隔了一代）⇒ 链断');
  const selfSigned = describeChain([new crypto.X509Certificate(WILDCARD.certPem)]);
  assert.deepEqual(selfSigned, { depth: 1, links: [] }, '单张自签的链就是 1 层，没有「接不上」这回事');
  // 自签的自我签发关系成立（这就是「自签」的机器定义，也是 C4 不警告的根据）
  const self = new crypto.X509Certificate(WILDCARD.certPem);
  assert.equal(self.checkIssued(self), true);
});

test('#462 C1：叶子 + 中间（正确顺序）⇒ 200 语义，**无 chainWarnings**，cert 取叶子', () => {
  const out = validateUpload({ certPem: CHAIN.fullchainPem, keyPem: CHAIN.keyPem, adminHost: ADMIN_HOST });
  assert.equal(out.ok, true);
  assert.deepEqual(out.chainWarnings, [], 'bundle = 叶子 + 中间 是**期望形态**，不许警告');
  assert.equal(out.cert.subjectCN, 'admin.fde.erix.vip', 'cert DTO 必须是叶子');
  assert.deepEqual(out.cert.sans, ['admin.fde.erix.vip', '*.fde.erix.vip']);
  assert.equal(out.cert.issuerCN, 'Test Intermediate CA');
  assert.notEqual(
    out.cert.fingerprintSha256,
    parseCertificatePem(CHAIN.intermediatePem).fingerprintSha256,
    '指纹必须是叶子的（不是第 1 段 = 中间证书）',
  );
});

test('#462 C2：叶子 + 中间 + 根 ⇒ 通过且**不警告**（实测多发一张根无害）', () => {
  const out = validateUpload({ certPem: CHAIN.withRootPem, keyPem: CHAIN.keyPem, adminHost: ADMIN_HOST });
  assert.equal(out.ok, true);
  assert.deepEqual(out.chainWarnings, [], '带根证书不许警告（实测 3 层 + 严格校验 0 ok）');
  assert.equal(out.cert.subjectCN, 'admin.fde.erix.vip');
});

test('#462 C3：只有叶子且非自签 ⇒ **通过**（警告不拒）+ chainWarnings=[chain_looks_leaf_only]', () => {
  const out = validateUpload({ certPem: CHAIN.leafPem, keyPem: CHAIN.keyPem, adminHost: ADMIN_HOST });
  assert.equal(out.ok, true, 'C3 的输入是「我知道我只有叶子」——可接受的自担风险，不许改成 400');
  assert.deepEqual(out.chainWarnings, ['chain_looks_leaf_only']);
});

test('#462 C4：只有叶子且**自签** ⇒ 通过且无警告（自签的链就是 1 层）', () => {
  const out = validateUpload({ certPem: WILDCARD.certPem, keyPem: WILDCARD.keyPem, adminHost: ADMIN_HOST });
  assert.equal(out.ok, true);
  assert.deepEqual(out.chainWarnings, []);
});

test('#462 C5：顺序反了（中间在前）⇒ 400 tls_cert_order_invalid，**不是** tls_key_mismatch', () => {
  const out = validateUpload({ certPem: CHAIN.wrongOrderPem, keyPem: CHAIN.keyPem, adminHost: ADMIN_HOST });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'tls_cert_order_invalid', '私钥是对的；报 tls_key_mismatch 是误导（#462 的病根）');
  assert.notEqual(out.code, 'tls_key_mismatch');
  assert.deepEqual(Object.keys(out.details).sort(), ['firstSubjectCN', 'leafSubjectCN']);
  assert.equal(out.details.firstSubjectCN, 'Test Intermediate CA', 'details 必须点名「现在第一个是谁」');
  assert.equal(out.details.leafSubjectCN, 'admin.fde.erix.vip', '以及「你的域名证书是哪张」');
  assert.match(out.message, /第一个 BEGIN CERTIFICATE 必须是你的域名证书/);
});

test('#462 C7：段间接不上（混了别人的证书）⇒ 400 tls_cert_chain_broken + details 点名第几段', () => {
  const out = validateUpload({
    certPem: `${CHAIN.leafPem}${OTHER.certPem}`, keyPem: CHAIN.keyPem, adminHost: ADMIN_HOST,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'tls_cert_chain_broken');
  assert.deepEqual(out.details, {
    index: 1, // 段号从 1 起（与文案里的「第 N 段」同数）
    subjectCN: 'admin.fde.erix.vip',
    issuerCN: 'Test Intermediate CA',
    nextSubjectCN: 'other.example',
  });
  assert.match(out.message, /第 1 段接不上/);
});

test('#462 inspect：C1/C3/C6/C7 的 warnings 与「cert 一律取叶子」', () => {
  // C1：正确 bundle（有/无私钥都无警告）
  const c1 = inspectCertificate({ certPem: CHAIN.fullchainPem, keyPem: CHAIN.keyPem, adminHost: ADMIN_HOST });
  assert.deepEqual(c1.warnings, []);
  assert.equal(c1.cert.subjectCN, 'admin.fde.erix.vip');
  assert.equal(c1.keyMatches, true);
  assert.deepEqual(inspectCertificate({ certPem: CHAIN.fullchainPem, adminHost: ADMIN_HOST }).warnings, []);

  // C2：带根同样无警告
  assert.deepEqual(
    inspectCertificate({ certPem: CHAIN.withRootPem, keyPem: CHAIN.keyPem, adminHost: ADMIN_HOST }).warnings,
    [],
  );

  // C3：只有叶子（非自签）⇒ 警告
  assert.deepEqual(
    inspectCertificate({ certPem: CHAIN.leafPem, keyPem: CHAIN.keyPem, adminHost: ADMIN_HOST }).warnings,
    ['chain_looks_leaf_only'],
  );

  // C6：顺序反了但**没私钥** ⇒ 只能警告（拿不到配对信息）
  const c6 = inspectCertificate({ certPem: CHAIN.wrongOrderPem, adminHost: ADMIN_HOST });
  assert.ok(c6.warnings.includes('chain_order_suspect'), `实际 warnings=${JSON.stringify(c6.warnings)}`);
  assert.ok(!c6.warnings.includes('chain_broken'), '顺序可疑时不再叠一条「断链」（修法不同，会让人猜）');

  // C7：接不上 ⇒ chain_broken
  const c7 = inspectCertificate({
    certPem: `${CHAIN.leafPem}${OTHER.certPem}`, keyPem: CHAIN.keyPem, adminHost: ADMIN_HOST,
  });
  assert.deepEqual(c7.warnings, ['chain_broken']);
});

test('#462 inspect：顺序反了**且有私钥** ⇒ 400 tls_cert_order_invalid（与 PUT 同码）', () => {
  assert.throws(
    () => inspectCertificate({ certPem: CHAIN.wrongOrderPem, keyPem: CHAIN.keyPem, adminHost: ADMIN_HOST }),
    (err) => {
      assert.equal(err.code, 'tls_cert_order_invalid');
      assert.equal(err.httpStatus, 400);
      assert.equal(err.details.firstSubjectCN, 'Test Intermediate CA');
      assert.equal(err.details.leafSubjectCN, 'admin.fde.erix.vip');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// ⑦ #462 真机校验（M2）：数链深，不只比指纹
// ---------------------------------------------------------------------------

test('#462 peerChainDepth：leaf-only ⇒ 1；带 issuer ⇒ 2；自签（Node 把自己当 issuer）⇒ 1；防环', () => {
  const leafRaw = new crypto.X509Certificate(CHAIN.leafPem).raw;
  const intRaw = new crypto.X509Certificate(CHAIN.intermediatePem).raw;
  const leafFp = new crypto.X509Certificate(CHAIN.leafPem).fingerprint256;
  const intFp = new crypto.X509Certificate(CHAIN.intermediatePem).fingerprint256;

  assert.equal(peerChainDepth({ fingerprint256: leafFp, raw: leafRaw }), 1, 'leaf-only ⇒ 1 层');
  assert.equal(
    peerChainDepth({ fingerprint256: leafFp, raw: leafRaw, issuerCertificate: { fingerprint256: intFp, raw: intRaw } }),
    2,
    'fullchain ⇒ 2 层',
  );
  const self = new crypto.X509Certificate(WILDCARD.certPem);
  assert.equal(
    peerChainDepth({ fingerprint256: self.fingerprint256, raw: self.raw, issuerCertificate: { fingerprint256: self.fingerprint256, raw: self.raw } }),
    1,
    '自签时 Node 会把自己当 issuer ⇒ 不能数成 2 层',
  );
  // 防环：两个对象互相指向对方 ⇒ 停在重复指纹上（不会无限递归）
  const a = { fingerprint256: 'AA', issuerCertificate: null };
  const b = { fingerprint256: 'BB', issuerCertificate: a };
  a.issuerCertificate = b;
  assert.equal(peerChainDepth(a), 2);
});

test('#462 verifyLiveCertificate：指纹一致但链深 1 且非自签 ⇒ mismatch/chain_incomplete（带 chainDepth）', async () => {
  const { EventEmitter } = await import('node:events');
  const route = fakeRouteFile();
  const expected = new crypto.X509Certificate(CHAIN.leafPem).fingerprint256;
  const leafRaw = new crypto.X509Certificate(CHAIN.leafPem).raw;
  const intRaw = new crypto.X509Certificate(CHAIN.intermediatePem).raw;
  const intFp = new crypto.X509Certificate(CHAIN.intermediatePem).fingerprint256;
  const makeConnect = (peer) => () => {
    const sock = new EventEmitter();
    sock.destroy = () => {};
    sock.getPeerCertificate = (detailed) => {
      assert.equal(detailed, true, '#462：必须传 true 才拿得到 issuerCertificate');
      return peer;
    };
    setImmediate(() => sock.emit('secureConnect'));
    return sock;
  };

  try {
    // 链深 1（服务端只发了叶子）⇒ 指纹对也不算 live：客户端会 unable to verify the first certificate
    const incomplete = await verifyLiveCertificate({
      expectedFingerprint: expected,
      adminHost: ADMIN_HOST,
      adminPort: 9443,
      routePath: route.path,
      connect: makeConnect({ fingerprint256: expected, raw: leafRaw }),
    });
    assert.equal(incomplete.status, 'mismatch', '指纹一致但链不完整 ⇒ 不能报 live');
    assert.equal(incomplete.reason, 'chain_incomplete');
    assert.equal(incomplete.chainDepth, 1);
    assert.equal(incomplete.subjectCN, 'admin.fde.erix.vip');

    // 链深 2 ⇒ live
    const full = await verifyLiveCertificate({
      expectedFingerprint: expected,
      adminHost: ADMIN_HOST,
      adminPort: 9443,
      routePath: route.path,
      connect: makeConnect({
        fingerprint256: expected,
        raw: leafRaw,
        issuerCertificate: { fingerprint256: intFp, raw: intRaw },
      }),
    });
    assert.equal(full.status, 'live');
    assert.equal(full.chainDepth, 2);
    assert.equal(full.reason, undefined, 'live 不带 reason');

    // 自签 + 链深 1 ⇒ live（自签的链就是 1 层）
    const self = new crypto.X509Certificate(WILDCARD.certPem);
    const selfSigned = await verifyLiveCertificate({
      expectedFingerprint: self.fingerprint256,
      adminHost: ADMIN_HOST,
      adminPort: 9443,
      routePath: route.path,
      connect: makeConnect({ fingerprint256: self.fingerprint256, raw: self.raw }),
    });
    assert.equal(selfSigned.status, 'live');
    assert.equal(selfSigned.chainDepth, 1);

    // 指纹不一致 ⇒ mismatch + reason:'fingerprint_mismatch'（现状语义不变，只多一个 reason）
    const otherFp = new crypto.X509Certificate(OTHER.certPem).fingerprint256;
    const mismatch = await verifyLiveCertificate({
      expectedFingerprint: expected,
      adminHost: ADMIN_HOST,
      adminPort: 9443,
      routePath: route.path,
      connect: makeConnect({ fingerprint256: otherFp, raw: new crypto.X509Certificate(OTHER.certPem).raw }),
    });
    assert.equal(mismatch.status, 'mismatch');
    assert.equal(mismatch.reason, 'fingerprint_mismatch');
  } finally {
    route.cleanup();
  }
});

// ---------------------------------------------------------------------------
// ⑧ #462 / 安全文档 S4：回滚用 `copyFile`（不把私钥读进进程内存）
// ---------------------------------------------------------------------------

test('#462/S4 rollback：copyFile 语义——prev 与恢复出的两文件逐字节相同、模式仍是 644/600、零次读 prev 私钥', async () => {
  const dir = tmpDynamicDir('s4rollback');
  try {
    await writeCertificateAssets({ dynamicDir: dir, certPem: WILDCARD.certPem, keyPem: WILDCARD.keyPem, log: quietLog() });
    await writeCertificateAssets({ dynamicDir: dir, certPem: OTHER.certPem, keyPem: OTHER.keyPem, log: quietLog() });
    const prevCertPath = path.join(dir, 'certs', 'prev', 'tls.crt');
    const prevKeyPath = path.join(dir, 'certs', 'prev', 'tls.key');
    const prevKeyBytes = fs.readFileSync(prevKeyPath);

    // 包一层 fsImpl：记录每一次 readFile，用来证明回滚路径没读过 prev 的私钥
    const readPaths = [];
    const fsImpl = {
      async stat(p, ...rest) { return fs.promises.stat(p, ...rest); },
      async readFile(p, ...rest) { readPaths.push(p); return fs.promises.readFile(p, ...rest); },
      async copyFile(a, b, ...rest) { return fs.promises.copyFile(a, b, ...rest); },
      async chmod(p, m) { return fs.promises.chmod(p, m); },
      async mkdir(p, o) { return fs.promises.mkdir(p, o); },
      async unlink(p) { return fs.promises.unlink(p); },
    };

    const out = await rollbackCertificateAssets({ dynamicDir: dir, log: quietLog(), fsImpl });
    assert.equal(out.tlsOut.published, true);
    assert.equal(out.cert.subjectCN, '*.fde.erix.vip', '回滚后返回的是 prev 那一代');

    const certPath = path.join(dir, 'certs', 'tls.crt');
    const keyPath = path.join(dir, 'certs', 'tls.key');
    assert.deepEqual(fs.readFileSync(keyPath), prevKeyBytes, '恢复出的私钥与 prev 里的**逐字节相同**');
    assert.equal(fs.readFileSync(certPath, 'utf8'), fs.readFileSync(prevCertPath, 'utf8'));
    assert.equal(fs.statSync(keyPath).mode & 0o777, TLS_KEY_MODE, '回滚后私钥必须仍是 0600');
    assert.equal(fs.statSync(certPath).mode & 0o777, 0o644);
    assert.ok(!readPaths.includes(prevKeyPath), '回滚**不许**把 prev 的私钥读进内存（copyFile 就够了）');
    assert.ok(!readPaths.includes(keyPath), '恢复出的私钥同样不该被读过');
    // 幂等：再回滚一次结论不变
    assert.equal((await rollbackCertificateAssets({ dynamicDir: dir, log: quietLog(), fsImpl })).tlsOut.published, true);
    assert.deepEqual(fs.readFileSync(keyPath), prevKeyBytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
