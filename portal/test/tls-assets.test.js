// 单测：tlsassets.js —— 管理台 TLS 装载面（issue #450 D5 / feat-261105-01）。
// 判据（都能红）：两文件齐才生成、缺任一/空文件 ⇒ 摘除旧 tls.yml、读失败不抛、
// 生成物里**没有私钥内容**（只以路径形式出现）、fingerprint 随证书变化（#456 的 reload 把手）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  materializeTlsAssets,
  readTlsAssets,
  renderTlsConfig,
  tlsPaths,
  TLS_DYNAMIC_FILE,
} from '../src/tlsassets.js';

const CERT_PEM = '-----BEGIN CERTIFICATE-----\nMIIBdummycert\n-----END CERTIFICATE-----\n';
const KEY_PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvSECRETKEYMATERIAL\n-----END PRIVATE KEY-----\n';

function tmpDynamicDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tlsassets-${tag}-`));
}

function writeCerts(dir, { cert = CERT_PEM, key = KEY_PEM } = {}) {
  const { certDir, certPath, keyPath } = tlsPaths(dir);
  fs.mkdirSync(certDir, { recursive: true });
  if (cert !== null) fs.writeFileSync(certPath, cert);
  if (key !== null) fs.writeFileSync(keyPath, key);
  return { certDir, certPath, keyPath };
}

const quietLog = () => {
  const lines = [];
  const push = (level) => (msg) => lines.push({ level, msg: String(msg) });
  return { lines, warn: push('warn'), error: push('error'), log: push('info') };
};

test('#450 tls.yml：两文件齐 ⇒ 生成，含 cert/key 路径 + 兜底证书 + 变化注释', async () => {
  const dir = tmpDynamicDir('both');
  try {
    const { certPath, keyPath } = writeCerts(dir);
    const log = quietLog();
    const out = await materializeTlsAssets({ dynamicDir: dir, log });
    assert.equal(out.published, true);
    assert.equal(out.target, path.join(dir, TLS_DYNAMIC_FILE));

    const text = fs.readFileSync(out.target, 'utf8');
    // 装载面本体：stores.default.defaultCertificate（SNI 不匹配时的兜底）+ certificates 清单
    assert.match(text, /^tls:$/m);
    assert.match(text, /^  stores:$/m);
    assert.match(text, /^    default:$/m);
    assert.match(text, /^      defaultCertificate:$/m);
    assert.ok(text.includes(`certFile: "${certPath}"`), '证书路径必须指向 <dynamic>/certs/tls.crt');
    assert.ok(text.includes(`keyFile: "${keyPath}"`), '私钥只以路径形式出现');
    assert.match(text, /^  certificates:$/m);
    // 随证书变化的注释（#456 的 reload 把手：file provider 是文件驱动的，只换 certs/* 不必然触发 reload）
    assert.match(text, /^# fingerprint=sha256:[0-9a-f]{64} keymtime=\d+$/m, '必须有一行随证书变化的注释');
    // 权限：本文件无私钥内容 ⇒ 0644
    assert.equal(fs.statSync(out.target).mode & 0o777, 0o644);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#450 tls.yml：生成物里**不含私钥内容**（私钥只能以路径形式出现）', async () => {
  const dir = tmpDynamicDir('nokey');
  try {
    writeCerts(dir);
    const out = await materializeTlsAssets({ dynamicDir: dir, log: quietLog() });
    const text = fs.readFileSync(out.target, 'utf8');
    assert.ok(!text.includes('MIIEvSECRETKEYMATERIAL'), '私钥正文绝不能进生成物');
    assert.ok(!text.includes('BEGIN PRIVATE KEY'), '私钥 PEM 头也不能出现');
    assert.ok(!text.includes('BEGIN CERTIFICATE'), '证书正文同样不进生成物（只给路径）');
    // 整份文件只有一行注释与 tls 段，没有多余内容
    assert.ok(!/\n\S*\s*PRIVATE/.test(text));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#450 tls.yml：缺 cert / 缺 key ⇒ **摘除**已有 tls.yml（不留指向不存在文件的配置）', async () => {
  for (const missing of ['cert', 'key']) {
    const dir = tmpDynamicDir(`missing-${missing}`);
    try {
      // 先造一份「上一轮生成过」的 tls.yml
      writeCerts(dir);
      const first = await materializeTlsAssets({ dynamicDir: dir, log: quietLog() });
      assert.equal(first.published, true, '前置：先有一份 tls.yml');
      const target = path.join(dir, TLS_DYNAMIC_FILE);
      assert.ok(fs.existsSync(target));

      // 再抽掉一个文件
      const { certPath, keyPath } = tlsPaths(dir);
      fs.rmSync(missing === 'cert' ? certPath : keyPath);
      const log = quietLog();
      const second = await materializeTlsAssets({ dynamicDir: dir, log });
      assert.equal(second.published, false, `缺 ${missing} 时不得生成`);
      assert.equal(fs.existsSync(target), false, `缺 ${missing} 时必须摘除旧 tls.yml`);
      assert.ok(log.lines.some((l) => l.level === 'warn'), '摘除必须留下 warn（否则运维不知道管理台没有自定义证书）');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('#450 tls.yml：空文件视为缺失（0 字节的 tls.key 不算「有证书」）', async () => {
  for (const empty of ['cert', 'key']) {
    const dir = tmpDynamicDir(`empty-${empty}`);
    try {
      const { certPath, keyPath } = writeCerts(dir);
      fs.writeFileSync(empty === 'cert' ? certPath : keyPath, '');
      const log = quietLog();
      const out = await materializeTlsAssets({ dynamicDir: dir, log });
      assert.equal(out.published, false, `空 ${empty} 必须视为缺失`);
      assert.equal(fs.existsSync(path.join(dir, TLS_DYNAMIC_FILE)), false);
      assert.match(out.reason ?? '', /空文件/, '原因要可读（不是一句 unknown）');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('#450 tls.yml：读失败（EACCES/ENOENT/目录当文件）**不抛**，只降级为「不生成」', async () => {
  // ① 目录根本不存在（ENOENT）
  {
    const dir = tmpDynamicDir('enoent');
    try {
      const out = await materializeTlsAssets({ dynamicDir: dir, log: quietLog() });
      assert.equal(out.published, false);
      assert.equal(fs.existsSync(path.join(dir, TLS_DYNAMIC_FILE)), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // ② certs/tls.crt 是个目录（读它 → EISDIR，非 ENOENT）
  {
    const dir = tmpDynamicDir('isdir');
    try {
      const { certDir, keyPath } = tlsPaths(dir);
      fs.mkdirSync(path.join(certDir, 'tls.crt'), { recursive: true });
      fs.writeFileSync(keyPath, KEY_PEM);
      const out = await materializeTlsAssets({ dynamicDir: dir, log: quietLog() });
      assert.equal(out.published, false, '不是普通文件 ⇒ 当作不可用');
      assert.match(out.reason ?? '', /不是普通文件/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // ③ 注入 EACCES（root 下 chmod 000 无效，故用 fs 注入点模拟真实权限错误）
  {
    const dir = tmpDynamicDir('eacces');
    try {
      const { certPath, keyPath } = tlsPaths(dir);
      const eacces = Object.assign(new Error(`EACCES: permission denied, open '${certPath}'`), { code: 'EACCES' });
      const fakeFs = {
        async stat(p) {
          if (p === certPath) throw eacces;
          return { isFile: () => true, mtimeMs: 1 };
        },
        async readFile() {
          return Buffer.from(KEY_PEM);
        },
        async unlink() {
          const e = new Error('ENOENT');
          e.code = 'ENOENT';
          throw e;
        },
      };
      const log = quietLog();
      const out = await materializeTlsAssets({ dynamicDir: dir, log, fsImpl: fakeFs });
      assert.equal(out.published, false, 'EACCES 不得抛，只降级');
      assert.match(out.reason ?? '', /EACCES/, '原因里要点名 EACCES（排障要看得见）');
      assert.ok(log.lines.some((l) => l.level === 'warn'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // ④ 摘除失败（非 ENOENT）也不抛，但必须 error 级明示「可能残留坏配置」
  {
    const dir = tmpDynamicDir('unlinkfail');
    try {
      const fakeFs = {
        async stat() {
          const e = new Error('ENOENT');
          e.code = 'ENOENT';
          throw e;
        },
        async readFile() {
          throw new Error('unreachable');
        },
        async unlink() {
          const e = new Error('EACCES: unlink');
          e.code = 'EACCES';
          throw e;
        },
      };
      const log = quietLog();
      const out = await materializeTlsAssets({ dynamicDir: dir, log, fsImpl: fakeFs });
      assert.equal(out.published, false);
      assert.ok(
        log.lines.some((l) => l.level === 'error' && l.msg.includes('可能残留')),
        '摘除失败必须 error 级明示（一份指向不存在文件的 tls.yml 会让整个动态目录加载失败）',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('#450 tls.yml：换证书 ⇒ fingerprint 变（reload 把手真的随证书变化），同状态两次字节相同', async () => {
  const dir = tmpDynamicDir('fingerprint');
  try {
    writeCerts(dir);
    const first = await materializeTlsAssets({ dynamicDir: dir, log: quietLog() });
    const text1 = fs.readFileSync(first.target, 'utf8');
    const fp1 = /^# fingerprint=(.+)$/m.exec(text1)[1];

    // 幂等：同状态再物化一次，字节不变
    const again = await materializeTlsAssets({ dynamicDir: dir, log: quietLog() });
    assert.equal(fs.readFileSync(again.target, 'utf8'), text1, '同状态必须字节幂等');

    // 换证书内容 ⇒ 指纹必须变（否则 #456 换证后 Traefik 可能不 reload）
    const { certPath } = tlsPaths(dir);
    fs.writeFileSync(certPath, `${CERT_PEM}extra\n`);
    const second = await materializeTlsAssets({ dynamicDir: dir, log: quietLog() });
    const fp2 = /^# fingerprint=(.+)$/m.exec(fs.readFileSync(second.target, 'utf8'))[1];
    assert.notEqual(fp2, fp1, '证书换了，fingerprint 必须变');
    assert.match(fp2, /^sha256:[0-9a-f]{64} keymtime=\d+$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#450 readTlsAssets：返回值形状（ok/target/路径/fingerprint），不读写正文到调用方以外', async () => {
  const dir = tmpDynamicDir('read');
  try {
    const { certPath, keyPath } = writeCerts(dir);
    const state = await readTlsAssets({ dynamicDir: dir });
    assert.equal(state.ok, true);
    assert.equal(state.certPath, certPath);
    assert.equal(state.keyPath, keyPath);
    assert.equal(state.target, path.join(dir, TLS_DYNAMIC_FILE));
    assert.match(state.fingerprint, /^sha256:[0-9a-f]{64} keymtime=\d+$/);
    assert.equal(state.cert, undefined, '不把证书字节挂到返回值上（少一个泄露面）');
    assert.equal(state.key, undefined, '不把私钥字节挂到返回值上');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#450 renderTlsConfig：路径里的引号/反斜杠被转义（YAML 注入面）', () => {
  const text = renderTlsConfig({ certPath: '/a"b/tls.crt', keyPath: '/c\\d/tls.key', fingerprint: 'sha256:x keymtime=1' });
  assert.ok(text.includes('certFile: "/a\\"b/tls.crt"'));
  assert.ok(text.includes('keyFile: "/c\\\\d/tls.key"'));
});

// ---------------------------------------------------------------------------
// #462 / 安全文档 S4：**私钥读路径不碰字节**（`readTlsAssets` 只 stat）
// ---------------------------------------------------------------------------

test('#462/S4 readTlsAssets：私钥**只 stat 不 readFile**（注入 EACCES 仍判「有证书」）', async () => {
  const dir = tmpDynamicDir('s4stat');
  try {
    const { certPath, keyPath } = writeCerts(dir);
    const readPaths = [];
    const fsImpl = {
      async stat(p, ...rest) {
        return fs.promises.stat(p, ...rest);
      },
      async readFile(p, ...rest) {
        readPaths.push(p);
        if (p === keyPath) {
          // 真实的「私钥读不动」形态（非 root 下 chmod 000 就是这个码）
          throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' });
        }
        return fs.promises.readFile(p, ...rest);
      },
      async unlink(p) {
        return fs.promises.unlink(p);
      },
    };

    const state = await readTlsAssets({ dynamicDir: dir, fsImpl });
    assert.equal(state.ok, true, '私钥读不动也必须判「有证书」：读路径根本不碰私钥字节');
    assert.match(state.fingerprint, /^sha256:[0-9a-f]{64} keymtime=\d+$/);
    assert.deepEqual(readPaths, [certPath], 'readFile 只被证书调用过一次：私钥一次都没读');

    // 物化同样不受影响（tls.yml 只需要路径 + 证书哈希 + 私钥 mtime）
    const out = await materializeTlsAssets({ dynamicDir: dir, fsImpl, log: quietLog() });
    assert.equal(out.published, true);
    assert.equal(readPaths.filter((p) => p === keyPath).length, 0, '整条物化链路零次读私钥');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  '#462/S4 readTlsAssets：真 chmod 000 的私钥文件仍判「有证书」（非 root 才有效，root 会跳过）',
  { skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'root 下 chmod 000 不生效' : false },
  async () => {
    const dir = tmpDynamicDir('s4chmod');
    try {
      const { keyPath } = writeCerts(dir);
      fs.chmodSync(keyPath, 0o000);
      // 前置：这个 uid 确实读不动它（否则这条用例什么也没证明）
      await assert.rejects(() => fs.promises.readFile(keyPath), (err) => err.code === 'EACCES');
      const state = await readTlsAssets({ dynamicDir: dir });
      assert.equal(state.ok, true, '只看 stat.size ⇒ 私钥不可读不影响「有证书」判定');
      const out = await materializeTlsAssets({ dynamicDir: dir, log: quietLog() });
      assert.equal(out.published, true);
    } finally {
      fs.chmodSync(path.join(dir, 'certs', 'tls.key'), 0o600);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
