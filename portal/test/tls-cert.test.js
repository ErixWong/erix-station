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
  describeTls,
  fingerprintOfPem,
  keyMatchesCert,
  parseCertificatePem,
  parseDefaultGateway,
  parsePrivateKeyPem,
  readPreviousCertificate,
  validateUpload,
  verifyLiveCertificate,
  writeCertificateAssets,
  rollbackCertificateAssets,
  readActiveCertificate,
} from '../src/tls-cert.js';
import { makeCert, makeExpiredCert } from './tls-fixtures.js';

const ADMIN_HOST = 'admin.fde.erix.vip';
const WILDCARD = makeCert(); // CN=*.fde.erix.vip, SAN=*.fde.erix.vip,fde.erix.vip
const OTHER = makeCert({ cn: 'other.example', sans: ['other.example'] });
const NO_SAN_CN = makeCert({ cn: ADMIN_HOST, sans: [] });
const SAN_WITHOUT_ADMIN = makeCert({ cn: ADMIN_HOST, sans: ['other.example'] });
const EXPIRED = makeExpiredCert();

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
