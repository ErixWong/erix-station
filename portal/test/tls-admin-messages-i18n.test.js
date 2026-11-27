// 单测：issue #803 返修单（#803 关单后 copilot 复审翻出的四处真漏里的 TLS + admin 两面）。
//
// 判据口径（与 `small-modules-messages-i18n.test.js` / `market-delegation-messages-i18n.test.js` 同）：
//   · **逐字**等值（`assert.equal`），不许 `includes` 文案；
//   · 每条中文腿与新增的英文腿**互不相同**（同一句贴四份 = 没翻）；
//   · 错误体形状不变：`code` / `message` / `retryable`（给了 `details` 才有 `details`），`en` 不外泄。
//
// 覆盖三组：
//   A. `validateUpload` 的**每一条**失败结果（返回面，不是 throw）：中文 `message` + 新增 `messageEn`；
//   B. 三个 `TlsCertError`（写盘步骤包裹 / `tls.yml 未发布` / 无上一代）的 `.en`；
//   C. 四个 TLS 限流文案：`locale=en` 走真 `handle` 腿，四条英文互不相同且与中文一一对应；
//   D. `admin.js` 开户经 `validateFdeNameForHostname` 的预览域名校验（`return` 面）两腿。
//
// ⚠ 同一条中文在**两处**抛（`tls.yml 未发布` 在 write/rollback 各一处）⇒ 两处都钉，缺一处就红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import * as tlsCert from '../src/tls-cert.js';
import * as projects from '../src/projects.js';
import { PREVIEW_PORT_BUDGET_PROBE_PORT } from '../src/previewpool.js';
import { FakePool } from './fake-pool.js';
import { makeCert, makeExpiredCert } from './tls-fixtures.js';

const SELF_UID = process.getuid?.() ?? 1000;
const SELF_GID = process.getgid?.() ?? 1000;

// 域名一律用 RFC 2606 保留的 `.test`（红线：仓库里不许出现真实域名）。
const ADMIN_HOST = 'station.example.test';
const LEAF = makeCert({ cn: '*.example.test', sans: ['*.example.test', ADMIN_HOST] });
const OTHER = makeCert({ cn: 'other.example.test', sans: ['other.example.test'] }); // 与 LEAF 不配对的私钥
const EXPIRED = makeExpiredCert({ cn: 'expired.example.test', sans: ['expired.example.test'] });

// 一条「坏到 OpenSSL 一定拒」的 PEM 体（Base64 里不许有 `@`）。
const GARBAGE_BLOCK = '-----BEGIN CERTIFICATE-----\n@@this is not base64@@\n-----END CERTIFICATE-----\n';
const GARBAGE_KEY = '-----BEGIN PRIVATE KEY-----\n@@this is not base64@@\n-----END PRIVATE KEY-----\n';

// ── HTTP 脚手架 ───────────────────────────────────────────────────────────────
const ADMIN = {
  id: 'a0000000-0000-4000-8000-00000000000a', login: 'root', display_name: 'Root',
  role: 'admin', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const ADMIN_TOKEN = 'tok-803r-tls-admin';
const GIT_HOST_ID = '90000000-0000-4000-8000-000000000009'; // 路由先按 UUID 正则卡一道，必须是合法十六进制

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `station-803r-${tag}-`));
}

/**
 * @param {{rateMaxFailures?: number, baseDomain?: string|null}} opts
 *   `rateMaxFailures:1` ⇒ 三个证书限流器都是「用过一次就 429」（限流腿靠真 gate，不 mock `tlsRateLimited`）。
 */
async function startServer({ rateMaxFailures = 100, baseDomain = null, withGitHost = false } = {}) {
  const dynamicDir = tmpdir('dyn');
  const staticDir = tmpdir('static');
  const userspace = tmpdir('userspace');
  const rl = { maxFailures: rateMaxFailures, windowMs: 60_000, blockMs: 60_000, maxEntries: 1000 };
  const config = {
    cookie: cookieSettings('dev-803r', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    loginRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, maxEntries: 10_000 },
    totpRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 100, maxEntries: 10_000 },
    kdfConcurrency: 2, kdfQueueLimit: 100, kdfQueueTimeoutMs: 30_000,
    maxLoginLength: 128, maxPasswordLength: 256,
    totp: { issuer: 'erix-station-test', digits: 6, period: 30, window: 1 },
    dockerHost: 'tcp://127.0.0.1:1', staticDir,
    userSpaceRoot: userspace, fdeUid: SELF_UID, fdeGid: SELF_GID, fileUploadMaxBytes: 32 * 1024 * 1024,
    traefikDynamicDir: dynamicDir,
    adminHost: ADMIN_HOST,
    adminPort: 9443,
    baseDomain,
    tlsUploadRateLimit: rl,
    tlsVerifyRateLimit: rl,
    tlsInspectRateLimit: rl,
  };
  // `POST /api/admin/users` 的第一道闸是 `llm.validateFdeLlmSelection`（先于 git_hosts 与 createUser），
  // 所以开户两腿必须带一个能列出 provider/model 的假网关（与 `admin.test.js` 同一份形状）。
  const llmGateway = {
    async listCredentials() { return { credentials: [{ credential_name: 'mock-provider', credential_info: { credential_name: 'mock-provider' } }] }; },
    async listModels() {
      return {
        data: [{
          model_name: 'mock-chat',
          litellm_params: { litellm_credential_name: 'mock-provider' },
          model_info: { id: 'mock-main', type: 'text', tool_calling: true },
        }],
      };
    },
  };
  const pool = new FakePool({ users: [ADMIN] });
  pool.sessions.push({
    id: 'ls-admin', user_id: ADMIN.id, token_hash: auth.hashToken(ADMIN_TOKEN),
    created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
  });
  if (withGitHost) {
    // 开户路由在 `admin.createUser` 之前要查 git_hosts（其余语句回落 FakePool ⇒ 未识别 SELECT = 空行）。
    const inner = pool.query.bind(pool);
    pool.query = (sql, params) => (typeof sql === 'string' && sql.includes('FROM git_hosts WHERE id = $1')
      ? Promise.resolve({ rows: [{ id: GIT_HOST_ID, provider: 'gitea', enabled: true }], rowCount: 1 })
      : inner(sql, params));
  }
  const server = createServer({
    pool, config, docker: null, llmGateway,
    log: { error: () => {}, warn: () => {}, log: () => {}, debug: () => {} },
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, config, dynamicDir,
    adminCookie: `${config.cookie.name}=${ADMIN_TOKEN}`,
    close: () => new Promise((res) => server.close(res))
      .finally(() => {
        fs.rmSync(dynamicDir, { recursive: true, force: true });
        fs.rmSync(staticDir, { recursive: true, force: true });
        fs.rmSync(userspace, { recursive: true, force: true });
      }),
  };
}

async function hit(base, { method, p, cookie, ct = 'application/json', body }) {
  const headers = {};
  if (ct) headers['content-type'] = ct;
  if (cookie) headers['cookie'] = cookie;
  const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
  const res = await fetch(base + p, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON：留 null */ }
  return { status: res.status, error: json?.error };
}

/** 两腿：`locale=en` 逐字英文 / 缺省逐字中文；另钉 `en` 不外泄、错误体键集合不变。 */
async function twoLeg(s, req, { code, enMsg, zhMsg, http, keys }) {
  const en = await hit(s.base, { ...req, cookie: `${req.cookie}; locale=en` });
  assert.ok(en.error, `en 腿应返回错误信封：${req.method} ${req.p}`);
  assert.equal(en.status, http, `en 腿 httpStatus 语义变了：${req.p}`);
  assert.equal(en.error.code, code, `en 腿 code 不符：${req.p}`);
  assert.equal(en.error.message, enMsg, `en 腿文案不符：${req.p}`);
  assert.ok(!('en' in en.error), `en 不得出现在错误体（en 腿）：${req.p}`);
  if (keys) assert.deepEqual(Object.keys(en.error).sort(), keys, `en 腿错误体键集合变了：${req.p}`);

  const zh = await hit(s.base, { ...req });
  assert.ok(zh.error, `缺省腿应返回错误信封：${req.method} ${req.p}`);
  assert.equal(zh.status, http, `缺省腿 httpStatus 语义变了：${req.p}`);
  assert.equal(zh.error.code, code, `缺省腿 code 不符：${req.p}`);
  assert.equal(zh.error.message, zhMsg, `缺省腿文案不符：${req.p}`);
  assert.ok(!('en' in zh.error), `en 不得出现在错误体（缺省腿）：${req.p}`);
  if (keys) assert.deepEqual(Object.keys(zh.error).sort(), keys, `缺省腿错误体键集合变了：${req.p}`);
}

// ── A. `validateUpload` 的失败结果面 ─────────────────────────────────────────
//
// 每条都写**逐字**的中文原文与逐字的英文对（同一条中文只能有一个英文对，四种语言腿两两不相同）。
// 带 OpenSSL 原始诊断的那两条不写死正文（措辞随 OpenSSL 版本变），改成钉「中文腿 = 中文前缀 + 原文」
// 「英文腿 = 英文前缀 + **同一份**原文」——逐字性仍在，只是不把第三方措辞当判据。
const UPLOAD_FAILURES = [
  {
    name: 'certPem 不是字符串',
    call: { certPem: 42, keyPem: LEAF.keyPem, adminHost: ADMIN_HOST },
    code: 'validation_failed',
    zh: 'certPem 必须是 PEM 字符串',
    en: 'certPem must be a PEM string',
    detailsField: 'certPem',
  },
  {
    name: 'keyPem 不是字符串（缺省不传）',
    call: { certPem: LEAF.certPem, adminHost: ADMIN_HOST },
    code: 'validation_failed',
    zh: 'keyPem 必须是 PEM 字符串',
    en: 'keyPem must be a PEM string',
    detailsField: 'keyPem',
  },
  {
    name: 'certPem 超字节上限',
    call: { certPem: 'x'.repeat(tlsCert.TLS_MAX_PEM_BYTES + 1), keyPem: LEAF.keyPem, adminHost: ADMIN_HOST },
    code: 'validation_failed',
    zh: `certPem 超过 ${tlsCert.TLS_MAX_PEM_BYTES} 字节上限`,
    en: `certPem exceeds the ${tlsCert.TLS_MAX_PEM_BYTES}-byte limit`,
    detailsField: 'certPem',
  },
  {
    name: 'keyPem 超字节上限',
    call: { certPem: LEAF.certPem, keyPem: 'y'.repeat(tlsCert.TLS_MAX_PEM_BYTES + 1), adminHost: ADMIN_HOST },
    code: 'validation_failed',
    zh: `keyPem 超过 ${tlsCert.TLS_MAX_PEM_BYTES} 字节上限`,
    en: `keyPem exceeds the ${tlsCert.TLS_MAX_PEM_BYTES}-byte limit`,
    detailsField: 'keyPem',
  },
  {
    name: 'certPem 是空白串',
    call: { certPem: '   ', keyPem: LEAF.keyPem, adminHost: ADMIN_HOST },
    code: 'tls_cert_invalid',
    zh: '证书 PEM 为空',
    en: 'certificate PEM is empty',
  },
  {
    name: 'certPem 里没有任何证书段',
    call: { certPem: 'hello world, not a pem', keyPem: LEAF.keyPem, adminHost: ADMIN_HOST },
    code: 'tls_cert_invalid',
    zh: '证书 PEM 里没有任何 BEGIN CERTIFICATE 段',
    en: 'the certificate PEM contains no BEGIN CERTIFICATE block',
  },
  {
    name: 'keyPem 是空白串',
    call: { certPem: LEAF.certPem, keyPem: '  ', adminHost: ADMIN_HOST },
    code: 'tls_key_invalid',
    zh: '私钥 PEM 为空',
    en: 'private key PEM is empty',
  },
  {
    name: '私钥与证书不配对',
    call: { certPem: LEAF.certPem, keyPem: OTHER.keyPem, adminHost: ADMIN_HOST },
    code: 'tls_key_mismatch',
    zh: '私钥与证书不配对（公钥不一致）',
    en: 'the private key does not match the certificate (public keys differ)',
    detailsField: 'keyPem',
  },
  {
    name: '叶子不在第一段（顺序反了）',
    // 两段独立自签证书：第一段是「中间证书」，与私钥配对的那张在第二段。
    call: { certPem: `${OTHER.certPem}${LEAF.certPem}`, keyPem: LEAF.keyPem, adminHost: ADMIN_HOST },
    code: 'tls_cert_order_invalid',
    zh: '第一个 BEGIN CERTIFICATE 必须是你的域名证书；现在第一个是「other.example.test」（中间证书），请把叶子证书放在最前面',
    en: 'the first BEGIN CERTIFICATE must be your own domain certificate; the first one here is "other.example.test" (an intermediate certificate) - please put the leaf certificate first',
  },
  {
    name: '链断在第一段接缝',
    // 叶子在前（过顺序闸），但第二段不是它的签发者 ⇒ `checkIssued` 为 false。
    call: { certPem: `${LEAF.certPem}${OTHER.certPem}`, keyPem: LEAF.keyPem, adminHost: ADMIN_HOST },
    code: 'tls_cert_chain_broken',
    zh: '第 1 段接不上：「*.example.test」的签发者是「*.example.test」，但下一段是「other.example.test」',
    en: 'section 1 does not chain: the issuer of "*.example.test" is "*.example.test", but the next section is "other.example.test"',
  },
  {
    name: '证书已过期',
    call: { certPem: EXPIRED.certPem, keyPem: EXPIRED.keyPem, adminHost: ADMIN_HOST },
    code: 'tls_cert_expired',
    // `notAfter` 由夹具写死（20200102000000Z ⇒ 该 ISO 串），不随运行时间变。
    zh: '证书已过期（notAfter=2020-01-02T00:00:00.000Z）',
    en: 'the certificate has expired (notAfter=2020-01-02T00:00:00.000Z)',
  },
  {
    name: '证书不覆盖管理台域名',
    call: { certPem: OTHER.certPem, keyPem: OTHER.keyPem, adminHost: ADMIN_HOST },
    code: 'tls_cert_domain_mismatch',
    zh: `证书不覆盖管理台域名 ${ADMIN_HOST}`,
    en: `the certificate does not cover the admin console hostname ${ADMIN_HOST}`,
  },
  {
    name: 'confirmDomains 不是数组',
    call: { certPem: LEAF.certPem, keyPem: LEAF.keyPem, adminHost: ADMIN_HOST, confirmDomains: 'nope' },
    code: 'validation_failed',
    zh: 'confirmDomains 必须是字符串数组',
    en: 'confirmDomains must be an array of strings',
    detailsField: 'confirmDomains',
  },
  {
    name: 'confirmDomains 超出证书能力',
    // 证书 SAN 是 `*.example.test`，**盖不到** `nomatch.other.test`（通配符只盖一层、且不同域）。
    call: { certPem: LEAF.certPem, keyPem: LEAF.keyPem, adminHost: ADMIN_HOST, confirmDomains: ['nomatch.other.test'] },
    code: 'tls_cert_domain_mismatch',
    zh: 'confirmDomains 里有证书覆盖不到的名字：nomatch.other.test',
    en: 'confirmDomains contains names the certificate does not cover: nomatch.other.test',
    detailsField: 'confirmDomains',
  },
  // 带 OpenSSL 原始诊断的两条：`zh` / `en` 写成「由内层错误派生」的函数（见下面的循环）。
  {
    name: '证书段无法解析（第 1 段）',
    call: { certPem: GARBAGE_BLOCK, keyPem: LEAF.keyPem, adminHost: ADMIN_HOST },
    code: 'tls_cert_invalid',
    inner: () => catchTls(() => tlsCert.parseCertificateChain(GARBAGE_BLOCK)),
    zhPrefix: '第 1 段证书无法解析：',
    enPrefix: 'certificate section 1 cannot be parsed: ',
  },
  {
    name: '私钥无法解析',
    call: { certPem: LEAF.certPem, keyPem: GARBAGE_KEY, adminHost: ADMIN_HOST },
    code: 'tls_key_invalid',
    inner: () => catchTls(() => tlsCert.parsePrivateKeyPem(GARBAGE_KEY)),
    zhPrefix: '私钥 PEM 无法解析：',
    enPrefix: 'private key PEM cannot be parsed: ',
  },
];

function catchTls(run) {
  let err;
  try {
    run();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof tlsCert.TlsCertError, '内层解析函数必须抛 TlsCertError');
  return err;
}

test('validateUpload：每一条失败结果都同时带中文 message 与逐字 messageEn', () => {
  const seenEn = new Map();
  for (const c of UPLOAD_FAILURES) {
    const r = tlsCert.validateUpload(c.call);
    assert.equal(r.ok, false, `${c.name}：应当判失败`);
    assert.equal(r.code, c.code, `${c.name}：code 不该随文案一起漂`);
    if (c.inner) {
      const inner = c.inner();
      assert.ok(inner.message.startsWith(c.zhPrefix), `${c.name}：内层中文前缀对不上（源文案变了？）`);
      assert.ok(inner.en.startsWith(c.enPrefix), `${c.name}：内层英文前缀对不上（源文案变了？）`);
      const tail = inner.message.slice(c.zhPrefix.length);
      assert.equal(r.message, `${c.zhPrefix}${tail}`, `${c.name}：中文腿必须逐字 = 前缀 + 原文`);
      assert.equal(r.messageEn, `${c.enPrefix}${inner.en.slice(c.enPrefix.length)}`, `${c.name}：英文腿必须逐字 = 英文前缀 + 同一份原文`);
      assert.equal(r.messageEn.slice(c.enPrefix.length), tail, `${c.name}：英文腿带的原文必须与中文腿同一份`);
    } else {
      assert.equal(r.message, c.zh, `${c.name}：中文腿逐字不符`);
      assert.equal(r.messageEn, c.en, `${c.name}：英文腿逐字不符`);
    }
    assert.equal(typeof r.messageEn, 'string', `${c.name}：messageEn 必须是字符串`);
    assert.ok(r.messageEn !== r.message, `${c.name}：英文腿不能等于中文腿`);
    if (c.detailsField) {
      assert.equal(r.details?.field, c.detailsField, `${c.name}：details.field 形状不许动`);
    }
    // 英文腿互不相同（同一条中文只能有一个英文对；两条不同中文共用一句英文 = 有一条没翻）。
    const dup = seenEn.get(r.messageEn);
    assert.equal(dup, undefined, `英文腿重复：「${c.name}」与「${dup ?? ''}」都是「${r.messageEn}」`);
    seenEn.set(r.messageEn, c.name);
  }
  assert.equal(seenEn.size, UPLOAD_FAILURES.length, '英文腿必须两两互不相同');
});

test('validateUpload：失败结果的键集合只有 ok/code/message/messageEn/details', () => {
  const r = tlsCert.validateUpload({ certPem: 42, keyPem: LEAF.keyPem, adminHost: ADMIN_HOST });
  assert.deepEqual(Object.keys(r).sort(), ['code', 'details', 'message', 'messageEn', 'ok']);
  assert.ok(!('en' in r), '结果对象用 messageEn，不再另挂一个 `en`（免得出现两份真相）');
});

// 解析辅助函数面（`validateUpload` 通过 `asFailure` 折进结果对象的那几个抛出点）。
// ⚠ 同一条中文可能同时出现在 `parseCertificatePem` 与 `parseCertificateChain`（「证书 PEM 为空」）
//   ⇒ 两支都钉，删一处另一处仍绿的坑就是这个（#803 返修第 ④ 条的同型坑）。
test('解析辅助函数的抛出点：中文不变、英文逐字、同文案两支共用同一句英文', () => {
  const a = catchTls(() => tlsCert.parseCertificatePem('  '));
  assert.equal(a.message, '证书 PEM 为空');
  assert.equal(a.en, 'certificate PEM is empty');
  const b = catchTls(() => tlsCert.parseCertificateChain('  '));
  assert.equal(b.message, '证书 PEM 为空', '同一条中文的第二处抛出点');
  assert.equal(b.en, 'certificate PEM is empty', '同一条中文必须配同一句英文');

  const unparsable = catchTls(() => tlsCert.parseCertificatePem(GARBAGE_BLOCK));
  assert.ok(unparsable.message.startsWith('证书 PEM 无法解析：'));
  const raw = unparsable.message.slice('证书 PEM 无法解析：'.length);
  assert.equal(unparsable.messageEn ?? unparsable.en, `certificate PEM cannot be parsed: ${raw}`,
    '英文腿 = 英文前缀 + 与中文腿同一份原文');

  const noBlocks = catchTls(() => tlsCert.selectLeaf([], null));
  assert.equal(noBlocks.message, '证书 PEM 里没有任何证书段');
  assert.equal(noBlocks.en, 'the certificate PEM contains no certificate block');

  // `certificateInfo` 的「公钥无法导出」：模块私有函数、且要一张「能解析成 X509 但 SPKI 导出炸」的证书
  // 才能从 PEM 侧触发（现实中造不出这种证书），所以这里从**导出的** `selectLeaf` 递一个假 block 进去，
  // 走的就是同一个 `certificateInfo`——比退到「读源码断字符串」更接近真触发路径。
  const exportBoom = catchTls(() => tlsCert.selectLeaf([{ publicKey: { export() { throw new Error('boom'); } } }], {}));
  assert.equal(exportBoom.message, '证书公钥无法导出：boom');
  assert.equal(exportBoom.en, 'unable to export the certificate public key: boom');
});

// ── B. 三个 `TlsCertError` 的 `.en` ──────────────────────────────────────────

test('写盘步骤失败包裹（证书<mkdir>步骤失败）：中文不变 + 英文逐字 + 状态码与 step 不动', async () => {
  const dir = tmpdir('step');
  try {
    const boom = new Error('boom');
    boom.code = 'EACCES';
    const fsImpl = { ...fs.promises, mkdir: async () => { throw boom; } };
    let err;
    try {
      await tlsCert.writeCertificateAssets({ dynamicDir: dir, certPem: LEAF.certPem, keyPem: LEAF.keyPem, fsImpl });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof tlsCert.TlsCertError, 'mkdir 失败必须抛 TlsCertError');
    assert.equal(err.code, 'internal');
    assert.equal(err.httpStatus, 500, 'httpStatus 500 语义不许动');
    assert.equal(err.step, 'mkdir', 'details.step / err.step 的语义不许动');
    assert.deepEqual(err.details, { step: 'mkdir' });
    assert.equal(err.message, '证书mkdir步骤失败：boom');
    assert.equal(err.en, 'the certificate mkdir step failed: boom');
    assert.equal(err.cause, boom, 'cause 仍指向原始错误（运维要看 errno）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// `tls.yml 未发布` 在 **write 与 rollback 两处**各抛一次（同一句中文两个抛出点 ⇒ 两处都钉）。
// 退到**模块级真触发**的理由：这条要求「证书与私钥已落盘、但物化面判定物料不可用」，而
// `writeCertificateAssets` 的写盘走真实 `atomicWriteFile`（不接受 `fsImpl` 注入），从 HTTP 面
// 只能造出「物化成功」或「步骤失败」两态，造不出「写完了但 materialize 说没物料」这一态；
// 这里注入一个 `stat` 恒报 `size:0` 的 `fsImpl`（私钥探测走 `statAsset`），让它稳定回
// `{published:false, code:'empty'}` ⇒ 真走到那条 throw，不靠读源码断字符串。
/**
 * 造一个「物料面说私钥是空的」的 `fsImpl`：`stat` 对 **prev 之外**的路径恒报 `size:0`。
 * 为什么需要路径判别：`readPreviousCertificate` 也用同一个 `stat` 判 prev 私钥在不在
 * （`keyPresent = isFile() && size > 0`），无条件报 0 会让 rollback 先落 `tls_no_previous`。
 */
function emptyAssetStat() {
  return async (p) => ({
    isFile: () => true,
    size: String(p).includes(`${path.sep}prev${path.sep}`) ? 1024 : 0,
    mtimeMs: 0,
  });
}

test('tls.yml 未发布（write 腿）：中文腿带 reason（含路径），英文腿只带机器码', async () => {
  const dir = tmpdir('unpub');
  try {
    const fsImpl = { ...fs.promises, stat: emptyAssetStat() };
    let err;
    try {
      await tlsCert.writeCertificateAssets({ dynamicDir: dir, certPem: LEAF.certPem, keyPem: LEAF.keyPem, fsImpl });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof tlsCert.TlsCertError);
    assert.equal(err.code, 'internal');
    assert.equal(err.httpStatus, 500);
    assert.equal(err.step, 'materialize');
    assert.equal(err.en, 'tls.yml was not published (empty)',
      '英文腿只带机器码：reason 是中文 + 服务器绝对路径，贴进英文腿等于没翻');
    const zhPrefix = 'tls.yml 未发布（';
    assert.ok(err.message.startsWith(zhPrefix), `中文腿逐字前缀：${err.message}`);
    assert.ok(err.message.endsWith('）'), `中文腿以全角括号收尾：${err.message}`);
    // 中文腿的 reason 尾部是**盘上绝对路径**（临时目录每次不同）⇒ 只能钉「含中文诊断 + 含私钥路径」。
    const tail = err.message.slice(zhPrefix.length, -1);
    assert.ok(tail.includes('是空文件'), `中文腿仍带 reason 原文：${tail}`);
    assert.equal(tail.includes(path.join('certs', 'tls.key')), true, `中文腿的 reason 指向私钥路径：${tail}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tls.yml 未发布（rollback 腿，同文案的第二处抛出点）：英文腿与 write 腿逐字同一句', async () => {
  const dir = tmpdir('unpub-rollback');
  try {
    // 先造出「有 prev 的一代」，再让物化面判私钥不可用 ⇒ 走到 rollback 里那条 throw。
    await fs.promises.mkdir(path.join(dir, 'certs', 'prev'), { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'certs', 'prev', 'tls.crt'), LEAF.certPem);
    await fs.promises.writeFile(path.join(dir, 'certs', 'prev', 'tls.key'), LEAF.keyPem);
    const fsImpl = {
      ...fs.promises,
      stat: emptyAssetStat(),
    };
    let err;
    try {
      await tlsCert.rollbackCertificateAssets({ dynamicDir: dir, fsImpl });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof tlsCert.TlsCertError);
    assert.equal(err.code, 'internal');
    assert.equal(err.httpStatus, 500);
    assert.equal(err.step, 'materialize');
    assert.equal(err.en, 'tls.yml was not published (empty)',
      '同一句中文的两处抛出点必须配同一句英文（缺一处就是半中半英）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('没有可回滚的上一代证书：中文不变 + 英文逐字 + 404 语义不动', async () => {
  const dir = tmpdir('noprev');
  try {
    let err;
    try {
      await tlsCert.rollbackCertificateAssets({ dynamicDir: dir });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof tlsCert.TlsCertError);
    assert.equal(err.code, 'tls_no_previous');
    assert.equal(err.httpStatus, 404, '404 语义不许动');
    assert.equal(err.message, '没有可回滚的上一代证书（certs/prev/ 不存在或不完整）');
    assert.equal(err.en, 'there is no previous certificate generation to roll back to (certs/prev/ does not exist or is incomplete)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── C. 四个限流文案（真 handle 腿）────────────────────────────────────────────
const RATE_KEYSET = ['code', 'message', 'retryable'];

test('四个证书限流文案：locale=en 出各自英文、四条互不相同、缺省腿逐字中文', async () => {
  const s = await startServer({ rateMaxFailures: 1 });
  try {
    const cases = [
      {
        name: '上传',
        req: { method: 'PUT', p: '/api/admin/tls', cookie: s.adminCookie, body: { certPem: LEAF.certPem, keyPem: LEAF.keyPem } },
        zh: '证书上传过于频繁，请稍后再试',
        en: 'Certificate upload is too frequent; try again later.',
      },
      {
        name: '解析',
        req: { method: 'POST', p: '/api/admin/tls/inspect', cookie: s.adminCookie, body: { certPem: LEAF.certPem } },
        zh: '证书解析过于频繁，请稍后再试',
        en: 'Certificate parsing is too frequent; try again later.',
      },
      {
        name: '校验',
        req: { method: 'POST', p: '/api/admin/tls/verify', cookie: s.adminCookie, body: {} },
        zh: '证书校验过于频繁，请稍后再试',
        en: 'Certificate validation is too frequent; try again later.',
      },
      {
        name: '回滚',
        req: { method: 'POST', p: '/api/admin/tls/rollback', cookie: s.adminCookie, body: {} },
        zh: '回滚过于频繁，请稍后再试',
        en: 'Rollback is too frequent; try again later.',
      },
    ];
    const englishLegs = [];
    for (const c of cases) {
      // 限流器是「失败计数 ≥ maxFailures 就封」⇒ 先打一次把额度用光（这次是什么状态不重要：
      // 200 / 400 / 404 都可能，计次都发生在闸之后），第二次必然落进 429 那条 throw。
      await hit(s.base, c.req);
      await twoLeg(s, c.req, { code: 'rate_limited', http: 429, keys: RATE_KEYSET, enMsg: c.en, zhMsg: c.zh });
      const retry = await hit(s.base, { ...c.req, cookie: `${c.req.cookie}; locale=en` });
      assert.equal(retry.error.retryable, true, `${c.name}：429 必须仍是 retryable:true`);
      englishLegs.push(c.en);
    }
    assert.equal(new Set(englishLegs).size, 4, `四条英文必须互不相同：${englishLegs.join(' | ')}`);
  } finally {
    await s.close();
  }
});

test('上传校验失败（不配对）从 HTTP 面出英文，且错误体不泄 en / PEM', async () => {
  const s = await startServer({ rateMaxFailures: 100 });
  try {
    await twoLeg(s, {
      method: 'PUT', p: '/api/admin/tls', cookie: s.adminCookie,
      body: { certPem: LEAF.certPem, keyPem: OTHER.keyPem },
    }, {
      code: 'tls_key_mismatch', http: 400,
      enMsg: 'the private key does not match the certificate (public keys differ)',
      zhMsg: '私钥与证书不配对（公钥不一致）',
      keys: ['code', 'details', 'message', 'retryable'],
    });
  } finally {
    await s.close();
  }
});

test('上传校验失败（不覆盖管理台域名）从 HTTP 面出英文', async () => {
  const s = await startServer({ rateMaxFailures: 100 });
  try {
    await twoLeg(s, {
      method: 'PUT', p: '/api/admin/tls', cookie: s.adminCookie,
      body: { certPem: OTHER.certPem, keyPem: OTHER.keyPem },
    }, {
      code: 'tls_cert_domain_mismatch', http: 400,
      enMsg: `the certificate does not cover the admin console hostname ${ADMIN_HOST}`,
      zhMsg: `证书不覆盖管理台域名 ${ADMIN_HOST}`,
      keys: ['code', 'details', 'message', 'retryable'],
    });
  } finally {
    await s.close();
  }
});

// ── D. admin 开户经 `validateFdeNameForHostname` 的 `return` 面 ────────────────
// 预算 55（= 63 − 固定段 8，#246 起端口 5 位）；56 字符 ⇒ 首标签 64 ⇒ `FDE 名过长`。
const FDE_NAME_TOO_LONG = 'a'.repeat(56);
const FDE_NAME_ZH = 'FDE 名过长：生成的预览域名单标签 64 字符，超过 DNS 上限 63（FDE 名请缩短到 55 以内）';
const FDE_NAME_EN = 'FDE name is too long: a single label of the generated preview hostname is 64 characters, exceeding the DNS limit of 63 (please shorten the FDE name to at most 55 characters)';

// `预览域名过长` 这一支要「总长 > 253」：用 5 个 63 字符的合法标签拼 base 域（319 字符），
// 加上首标签就 over 253；标签本身合法 ⇒ 不会先落进「单标签超 63」那一支。
const LONG_BASE = Array.from({ length: 5 }, () => 'b'.repeat(63)).join('.');
const LONG_HOSTNAME = projects.buildHostname({ fdeName: 'alice', port: PREVIEW_PORT_BUDGET_PROBE_PORT, baseDomain: LONG_BASE });

function createBody(extra) {
  return {
    login: 'newbie', display_name: 'Newbie', password: 'secret-pass-1',
    email: 'newbie@example.test', git_host_id: GIT_HOST_ID,
    llm: { provider_id: 'mock-provider', main_model_id: 'mock-main' },
    ...extra,
  };
}

test('admin 开户：FDE 名过长在 locale=en 出英文、缺省腿逐字中文（校验器的英文腿没在包装处丢掉）', async () => {
  const s = await startServer({ withGitHost: true });
  try {
    await twoLeg(s, {
      method: 'POST', p: '/api/admin/users', cookie: s.adminCookie,
      body: createBody({ fde_name: FDE_NAME_TOO_LONG }),
    }, {
      code: 'validation_failed', http: 400,
      enMsg: FDE_NAME_EN, zhMsg: FDE_NAME_ZH,
      keys: ['code', 'details', 'message', 'retryable'],
    });
  } finally {
    await s.close();
  }
});

test('admin 开户：预览域名过长（base 域把总长顶过 253）两腿逐字', async () => {
  assert.ok(LONG_HOSTNAME.length > 253, `夹具必须真的超 253：${LONG_HOSTNAME.length}`);
  const s = await startServer({ withGitHost: true, baseDomain: LONG_BASE });
  try {
    await twoLeg(s, {
      method: 'POST', p: '/api/admin/users', cookie: s.adminCookie,
      body: createBody({ fde_name: 'alice' }),
    }, {
      code: 'validation_failed', http: 400,
      enMsg: `preview hostname is too long: the generated hostname is ${LONG_HOSTNAME.length} characters, exceeding the 253-character limit for a full domain name`,
      zhMsg: `预览域名过长：生成的预览域名总长 ${LONG_HOSTNAME.length} 字符，超过整域名上限 253`,
      keys: ['code', 'details', 'message', 'retryable'],
    });
  } finally {
    await s.close();
  }
});

test('admin 开户：fde_name 形态非法与 base 域标签非法两支的英文腿（直接钉校验器 + 包装透传）', async () => {
  const bad = projects.validateFdeNameForHostname('BAD_NAME');
  assert.equal(bad.ok, false);
  assert.equal(bad.message, 'fde_name 非法（小写字母/数字/连字符，不以连字符开头或结尾）');
  assert.equal(bad.en, 'invalid fde_name (lowercase letters, digits, hyphens; must not start or end with a hyphen)');

  const badBase = projects.validateFdeNameForHostname('alice', { baseDomain: `${'b'.repeat(64)}.example` });
  assert.equal(badBase.ok, false);
  assert.equal(badBase.message, '预览域名非法：base 域标签「' + 'b'.repeat(64) + '」64 字符，超过 DNS 上限 63 或含非法字符');
  assert.equal(badBase.en, `invalid preview hostname: the base-domain label "${'b'.repeat(64)}" is 64 characters, exceeding the DNS limit of 63 or containing illegal characters`);

  // 包装处（`admin.createUser`）确实用了校验器算好的 `en`：形态非法这一支在 HTTP 面也是英文
  // （`fde_name` 形态闸排在预览域名闸之前，所以这里走的是 admin.js 那条独立文案，不能混为一条）。
  const s = await startServer({ withGitHost: true });
  try {
    await twoLeg(s, {
      method: 'POST', p: '/api/admin/users', cookie: s.adminCookie,
      body: createBody({ fde_name: 'BAD_NAME' }),
    }, {
      code: 'validation_failed', http: 400,
      enMsg: 'invalid fde_name (lowercase letters, digits, hyphens, ≤63)',
      zhMsg: 'fde_name 非法（小写字母/数字/连字符，≤63）',
      keys: ['code', 'details', 'message', 'retryable'],
    });
  } finally {
    await s.close();
  }
});
