// issue #740：`clientIp(req)` 单元判据 + 防回潮闸。
//
// 判据来源：docs/api/portal.md §2.2/§2.4（按 IP 的限流/失败计数改用真客户端 IP）。
// 隔离约定（docs/testing.md §2.1）：`clientIp` 是纯函数（吃一个 `{socket, headers}` 形状的 req），
// 不碰 DB / 网络；端到端的「发信限流真按客户端分桶」在 login-email-code.test.js（A5）。
//
// 编号对齐工单 §1：
//   A1 对端 loopback + `X-Forwarded-For: 203.0.113.9` ⇒ 用 `203.0.113.9`。
//   A2 头是 `bogus-not-an-ip, 198.51.100.7` ⇒ 用 `198.51.100.7`（最右、不被最左伪造带跑）。
//   A3 对端公网（绕过 edge）+ XFF ⇒ 用对端地址，头被无视。
//   A4 没有头 ⇒ 用 socket 地址（回归不变，老行为不许变）。
//   A6 防回潮闸：`portal/src/**/*.js` 里除 `clientIp` 内部，出现 `req.socket.remoteAddress` 就红。
// 外加最右项语义、IPv6 zone、`::ffff:` 还原、ULA/RFC1918 可信边界的判别式参数化。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientIp } from '../src/http.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 造一个最小 req：对端 `peer`（socket.remoteAddress）+ 可选 `xff`（x-forwarded-for 头）。 */
function req(peer, xff) {
  const headers = {};
  if (xff !== undefined) headers['x-forwarded-for'] = xff;
  return { socket: { remoteAddress: peer }, headers };
}

// ---------------------------------------------------------------------------
// A1：可信对端（loopback）+ 单值 XFF ⇒ 采信头里的客户端。
// ---------------------------------------------------------------------------
test('#740 A1 对端 loopback + XFF ⇒ 用头里的真客户端（127.0.0.1 只是 Traefik）', () => {
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.9')), '203.0.113.9');
});

// ---------------------------------------------------------------------------
// A2：多值 XFF ⇒ 取**最右一项**，不被最左的伪造项带跑。
// ---------------------------------------------------------------------------
test('#740 A2 XFF 多值 ⇒ 取最右（edge 追加的那项），最左伪造项被忽略', () => {
  // 最左是客户端自己写的 bogus，最右是 edge 追加的真客户端。
  assert.equal(clientIp(req('127.0.0.1', 'bogus-not-an-ip, 198.51.100.7')), '198.51.100.7');
  // 常见三层链：最左可伪造、最右是 edge 看到的真客户端。
  assert.equal(clientIp(req('::1', '1.1.1.1, 8.8.8.8, 203.0.113.9')), '203.0.113.9');
});

test('#740 A2b 最右一项解析不出合法 IP ⇒ 回落 socket（不向左继续找）', () => {
  // 语义（工单 §0）：最右项不可解析就回落 socket，**不能**退回去用左边能解析的 1.2.3.4。
  assert.equal(clientIp(req('127.0.0.1', '1.2.3.4, garbage')), '127.0.0.1');
  assert.equal(clientIp(req('127.0.0.1', '   ')), '127.0.0.1'); // 全空 ⇒ 回落
});

// ---------------------------------------------------------------------------
// A3：对端是公网地址（绕过 edge 直连）⇒ 不信头，用 socket 对端。
// ---------------------------------------------------------------------------
test('#740 A3 对端公网（绕过 edge）⇒ 头被无视，用 socket 地址', () => {
  assert.equal(clientIp(req('203.0.113.77', '203.0.113.9')), '203.0.113.77');
  // 公网 IPv6 对端同理：非 ULA/非 ::1 ⇒ 不可信。
  assert.equal(clientIp(req('2606:4700:4700::1111', '203.0.113.9')), '2606:4700:4700::1111');
});

// ---------------------------------------------------------------------------
// A4：没有头 ⇒ 用 socket 地址（老行为回归不变）。
// ---------------------------------------------------------------------------
test('#740 A4 无头 ⇒ 用 socket 地址（回归不变）；socket 缺失回落 unknown', () => {
  assert.equal(clientIp(req('127.0.0.1')), '127.0.0.1');
  assert.equal(clientIp(req('192.168.5.20')), '192.168.5.20');
  assert.equal(clientIp(req('::ffff:172.18.0.1')), '172.18.0.1'); // 映射地址先还原 v4
  assert.equal(clientIp(req(undefined)), 'unknown'); // socket 对端读不到 ⇒ unknown（保留旧兜底）
});

// ---------------------------------------------------------------------------
// 可信代理边界的判别式参数化（哪些对端会采信头）。
// ---------------------------------------------------------------------------
test('#740 可信对端边界：RFC1918 / loopback / ULA / ::1 采信头；公网不采信', () => {
  const XFF = '203.0.113.9';
  const trusted = [
    '127.0.0.1', '127.5.5.5', // 127/8
    '10.0.0.1', '10.255.255.255', // 10/8
    '172.16.0.1', '172.31.255.255', // 172.16/12
    '192.168.0.1', '192.168.255.255', // 192.168/16
    '::1',
    'fd12:3456:789a::1', 'fc00::1', // ULA fc00::/7
    '::ffff:192.168.1.1', // 映射回私网
  ];
  for (const peer of trusted) {
    assert.equal(clientIp(req(peer, XFF)), XFF, `可信对端 ${peer} 应采信头`);
  }
  const untrusted = [
    '172.15.0.1', // 172.16/12 下界之外
    '172.32.0.1', // 172.16/12 上界之外
    '11.0.0.1', // 10/8 之外
    '193.168.0.1', // 192.168/16 之外
    '8.8.8.8', '1.1.1.1',
    'fe80::1', // 链路本地，非 ULA、非 ::1
    '2001:db8::1', // 文档用公网段
    'ffff::1', // 非 ULA
  ];
  for (const peer of untrusted) {
    assert.equal(clientIp(req(peer, XFF)), clientIp(req(peer)), `不可信对端 ${peer} 应忽略头、用 socket`);
    assert.notEqual(clientIp(req(peer, XFF)), XFF, `不可信对端 ${peer} 绝不能采信头`);
  }
});

// ---------------------------------------------------------------------------
// 归一化细节：IPv6 zone 去掉、映射地址还原、非法值回落。
// ---------------------------------------------------------------------------
test('#740 归一化：去 zone（%eth0）、还原 ::ffff:v4、非法值不采信头', () => {
  // 可信 ULA 对端带 zone：先去掉 % 才认得出是 ULA ⇒ 采信头。
  assert.equal(clientIp(req('fd12::1%eth0', '203.0.113.9')), '203.0.113.9');
  // 头里的值也去 zone / 还原映射：
  assert.equal(clientIp(req('127.0.0.1', '::ffff:203.0.113.9')), '203.0.113.9');
  // 头里是非法/空 ⇒ 回落 socket（这里 socket 是可信但对头无效）。
  assert.equal(clientIp(req('127.0.0.1', 'not-an-ip')), '127.0.0.1');
});

// ===========================================================================
// A6：防回潮闸 —— `portal/src/**/*.js` 除 `clientIp` 内部不许再出现 `req.socket.remoteAddress`。
// ===========================================================================

const FORBIDDEN = /req\??\.socket\??\.remoteAddress/;

/** 逐行扫一段源码文本，返回所有命中 `req.socket.remoteAddress`（含可选链变体）的 {line, text}。 */
function scanForbiddenLines(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (FORBIDDEN.test(line)) hits.push({ line: i + 1, text: line.trim() });
  });
  return hits;
}

/** 递归列出 `dir` 下所有 `.js` 文件（绝对路径）。 */
function listJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path ?? dir, entry.name);
    if (full.endsWith('.js')) out.push(full);
  }
  return out.sort();
}

/** 定位 `clientIp` helper 的「豁免区」行区间：含其上方紧邻的 doc 注释块 + 函数体到闭合 `}`。 */
function clientIpExemptLines(lines) {
  const start = lines.findIndex((l) => /^\s*export\s+function\s+clientIp\s*\(/.test(l));
  if (start === -1) return null;
  // 向上吞掉紧邻的块注释（doc）：一直走到空行为止。
  let docStart = start;
  for (let i = start - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === '') break;
    docStart = i;
  }
  // 向下走到函数体第一个顶格 `}`。
  let end = lines.length - 1;
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '}') { end = i; break; }
  }
  const set = new Set();
  for (let i = docStart; i <= end; i++) set.add(i + 1); // 1-based
  return set;
}

test('#740 A6 防回潮闸：portal/src 里除 clientIp 内部，出现 req.socket.remoteAddress 就红', () => {
  const srcDir = path.join(HERE, '..', 'src');
  const offenders = [];
  for (const file of listJs(srcDir)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const hits = scanForbiddenLines(lines.join('\n'));
    if (hits.length === 0) continue;
    const rel = path.relative(path.join(HERE, '..'), file);
    if (path.basename(file) === 'http.js') {
      const exempt = clientIpExemptLines(lines);
      assert.ok(exempt, '在 http.js 里找不到 clientIp helper，防回潮闸失去锚点（helper 被改名/挪走了？）');
      for (const h of hits) {
        if (!exempt.has(h.line)) offenders.push(`${rel}:${h.line}  ${h.text}`);
      }
    } else {
      for (const h of hits) offenders.push(`${rel}:${h.line}  ${h.text}`);
    }
  }
  assert.deepEqual(offenders, [], '有人绕过 clientIp 直接读 socket 对端（#740 回潮）：\n' + offenders.join('\n'));
});

test('#740 A6b 防回潮闸自证非恒绿（能抓 req.socket.remoteAddress 与可选链变体）', () => {
  const a = scanForbiddenLines('  const x = req.socket.remoteAddress || "unknown";');
  assert.equal(a.length, 1, 'plain 写法必须被抓');
  const b = scanForbiddenLines('  const x = req?.socket?.remoteAddress;');
  assert.equal(b.length, 1, '可选链变体也必须被抓（否则把写法改成 ?. 就能绕过闸）');
  const c = scanForbiddenLines('  // 只是注释里提 clientIp 之外没有 socket 读法\n  return clientIp(req);');
  assert.equal(c.length, 0, '不含被禁写法的代码不该被抓（非恒红）');
});
