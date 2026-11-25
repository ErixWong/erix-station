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
// 追加刀（拓扑校正，工单 #740b）：
//   A7 夹具默认路由 nexthop = `172.32.0.1` ⇒ 对端 `172.32.0.1` + XFF ⇒ 采信头（部署形态复刻）。
//   A8 夹具读不到 / 无默认路由 / Gateway `00000000` ⇒ 集合空 ⇒ 不信头（回落 socket）。
//   A9 nexthop 是别的地址（`10.0.0.1`）⇒ `172.32.0.1` **不**被顺带信任（防「信一切」退化）。
//   A10 十六进制小端反序还原单独钉一格（工单样例 `0101A8C0`：反序还原 vs 大端直读必须可区分）。
//   A11 懒算缓存：首次算过一次后不再重读文件（按路径缓存）。
//   A12 真实 /proc/net/route：不炸且只返合法 v4。
//   A13 夹具目录必须被清：mkdtemp 的临时目录一律登记 + 文件级 after() 兜底 rmSync（全局 AGENTS.md §3.2），
//      且这条 teardown 纪律**自己也有断言**（不许只删不证）。
// 外加最右项语义、IPv6 zone、`::ffff:` 还原、ULA/RFC1918 可信边界的判别式参数化。

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { clientIp, defaultGatewayAddrs } from '../src/http.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 造一个最小 req：对端 `peer`（socket.remoteAddress）+ 可选 `xff`（x-forwarded-for 头）。 */
function req(peer, xff) {
  const headers = {};
  if (xff !== undefined) headers['x-forwarded-for'] = xff;
  return { socket: { remoteAddress: peer }, headers };
}

/**
 * 造一个 `/proc/net/route` 形状的夹具（tab 分隔、地址十六进制小端）。
 * @param {Array<{iface?: string, dest?: string, gw?: string}>} rows
 * @returns {string} 文件文本（含真机同形状的表头行）
 */
function routeFile(rows) {
  const header = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT';
  const lines = rows.map((r) =>
    [
      r.iface ?? 'eth0',
      r.dest ?? '00000000',
      r.gw ?? '00000000',
      r.dest === '00000000' ? '0003' : '0001',
      '0',
      '0',
      '100',
      r.dest === '00000000' ? '00000000' : '00FFFFFF',
      '0',
      '0',
      '0',
    ].join('\t'),
  );
  return [header, ...lines].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// teardown（全局 AGENTS.md §3.2：`mkdtemp` 出来的必须在本文件 teardown 里 `rmSync(…, { recursive: true })`）。
// 写法照仓里现成的两处，别自创：`portal/test/admin.test.js:1071` 的单例 `t.after(() => fs.rmSync(root, { recursive: true, force: true }))`
// + `portal/test/login-email-code.test.js:161` 的文件级 `after()` 兜底（那份兜底防的是「断言一抛就轮不到收尾」的泄漏）。
// 本文件的夹具散在 A7/A8/A9/A10/A11/A13 六个 test 里 ⇒ 逐个 `t.after` 容易漏，改成**模块级登记 + 文件级兜底**：
// 所有临时目录只能经 `mkTempFixture` 诞生（漏登记会被 A13 的计数断言打红），收摊由下面两个 `after()` 负责。
// 顺序实测（node v22）：文件级 `after()` 在**全部 test 之后**、按注册顺序跑 ⇒ 先删、再验「真的没了」。
// ---------------------------------------------------------------------------

const tempDirs = new Set();

/** `mkdtempSync` + 登记进 teardown 集合：本文件的临时目录必须经这里诞生。 */
function mkTempFixture(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

/** 清理前的快照，供第二个 `after()`（A13 的后半格）验「真的被删了」。 */
let cleanedDirs = [];

after(() => {
  cleanedDirs = [...tempDirs];
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

after(() => {
  // A13 的后半格（工单要求「在 `after()` 里断言它们已不存在」）：纪律不许只删不证。
  assert.ok(cleanedDirs.length >= 15, `A13：清理快照必须非空（只拿到 ${cleanedDirs.length} 个）⇒ 登记通道没接上`);
  const leaked = cleanedDirs.filter((d) => fs.existsSync(d));
  assert.deepEqual(
    leaked,
    [],
    `A13：夹具目录没被清（§3.2 违规，每跑一次往 /tmp 堆 ${leaked.length} 个目录）：\n${leaked.join('\n')}`,
  );
});

/**
 * 在独立临时目录里写一个夹具，返回绝对路径（nexthop 集合按路径懒算并缓存，所以临时目录必须隔离）。
 * 目录经 `mkTempFixture` 登记 ⇒ 跑完由文件级 `after()` 一律 `rmSync`（A13 钉这条纪律）。
 */
function writeRouteFixture(name, text) {
  const dir = mkTempFixture('proc-route-740b-');
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
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
  // 注入空 nexthop 集合：这两行钉的是「公网对端不信头」，与跑测试那台机器的真实默认路由无关。
  const opts = { gatewayAddrs: [] };
  assert.equal(clientIp(req('203.0.113.77', '203.0.113.9'), opts), '203.0.113.77');
  // 公网 IPv6 对端同理：非 ULA/非 ::1 ⇒ 不可信。
  assert.equal(clientIp(req('2606:4700:4700::1111', '203.0.113.9'), opts), '2606:4700:4700::1111');
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
    '172.32.0.1', // 172.16/12 上界之外（静态集合仍不信；它只在 nexthop 夹具里被信，见 A7）
    '11.0.0.1', // 10/8 之外
    '193.168.0.1', // 192.168/16 之外
    '8.8.8.8', '1.1.1.1',
    'fe80::1', // 链路本地，非 ULA、非 ::1
    '2001:db8::1', // 文档用公网段
    'ffff::1', // 非 ULA
  ];
  // 注入空 nexthop 集合：这一格钉的是**静态可信段**边界，与跑测试那台机器的真实默认路由无关（hermetic）。
  const opts = { gatewayAddrs: [] };
  for (const peer of untrusted) {
    assert.equal(clientIp(req(peer, XFF), opts), clientIp(req(peer), opts), `不可信对端 ${peer} 应忽略头、用 socket`);
    assert.notEqual(clientIp(req(peer, XFF), opts), XFF, `不可信对端 ${peer} 绝不能采信头`);
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
// A7–A12（追加刀，工单 #740b 拓扑校正）：可信集合再并上「本机默认路由的 nexthop」。
// 路径可注入（夹具文件），集合懒算一次并缓存；读不到就**回落原集合**。
// ===========================================================================
test('#740 A7 默认路由 nexthop=172.32.0.1（compose 网关）⇒ 对端 172.32.0.1 + XFF ⇒ 采信头', () => {
  // 部署形态复刻：portal 只 publish 127.0.0.1，edge 经 DNAT 打进来 ⇒ 对端是 bridge 网关 172.32.0.1。
  // 夹具：两条默认路由 nexthop 都是 172.32.0.1（钉去重）+ 一条子网直连路（Gateway 00000000，必须被忽略）。
  const route = writeRouteFixture('route', routeFile([
    { iface: 'eth0', dest: '00000000', gw: '010020AC' }, // → 172.32.0.1
    { iface: 'eth0', dest: '00000000', gw: '010020AC' }, // 重复 ⇒ 去重
    { iface: 'eth0', dest: '000020AC', gw: '00000000' }, // 172.32.0.0/24 直连路，不是默认路由
  ]));
  assert.deepEqual(defaultGatewayAddrs({ procRoutePath: route }), ['172.32.0.1'], '只取默认路由行且去重');
  // 不预注入集合：只给夹具路径，走 helper 自己的懒算 + 可信判定（这一格就是真机判据的单元复刻）。
  assert.equal(clientIp(req('172.32.0.1', '203.0.113.9'), { procRoutePath: route }), '203.0.113.9');
  // 同一夹具下公网对端仍不信（nexthop 只扩容那一个地址）。
  assert.equal(clientIp(req('203.0.113.77', '203.0.113.9'), { procRoutePath: route }), '203.0.113.77');
});

test('#740 A8 读不到 / 无默认路由 / Gateway=00000000 ⇒ nexthop 集合空 ⇒ 不信头（回落 socket）', () => {
  const missing = path.join(mkTempFixture('proc-route-740b-missing-'), 'route'); // 同样登记 ⇒ 由文件级 after() 清（A13）
  const cases = [
    ['文件读不到', missing],
    ['只有子网直连路（无目的 00000000 的行）', writeRouteFixture('r1', routeFile([{ dest: '000020AC', gw: '00000000' }]))],
    ['默认路由的 Gateway 就是 00000000', writeRouteFixture('r2', routeFile([{ dest: '00000000', gw: '00000000' }]))],
    ['只有表头', writeRouteFixture('r3', 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\n')],
  ];
  for (const [label, file] of cases) {
    assert.deepEqual(defaultGatewayAddrs({ procRoutePath: file }), [], `${label} ⇒ nexthop 集合必须为空`);
    assert.equal(clientIp(req('172.32.0.1', '203.0.113.9'), { procRoutePath: file }), '172.32.0.1', `${label} ⇒ 必须回落原集合（不信头）`);
  }
});

test('#740 A9 nexthop 是另一地址（10.0.0.1）⇒ 172.32.0.1 不被顺带信任（防退化成信一切）', () => {
  const route = writeRouteFixture('route', routeFile([{ dest: '00000000', gw: '0100000A' }])); // → 10.0.0.1
  assert.deepEqual(defaultGatewayAddrs({ procRoutePath: route }), ['10.0.0.1']);
  // nexthop 本身 ⇒ 可信（证集合真被并进去了，不是恒 false）。
  assert.equal(clientIp(req('10.0.0.1', '203.0.113.9'), { procRoutePath: route }), '203.0.113.9');
  // 但不能因为「nexthop 机制上线」就顺带信 172.32.0.1（那会退化成「任何对端都信头」）。
  assert.equal(clientIp(req('172.32.0.1', '203.0.113.9'), { procRoutePath: route }), '172.32.0.1');
  // 公网对端同样不信。
  assert.equal(clientIp(req('203.0.113.77', '203.0.113.9'), { procRoutePath: route }), '203.0.113.77');
  // 正向腿再钉一次（上面的 nexthop 本身属于 RFC1918，单独看不能区分「并了 nexthop」与「只看静态集合」）：
  // nexthop 换成非 RFC1918 的 `198.51.100.1` ⇒ 它可信，而 `172.32.0.1` 依旧不可信。
  const other = writeRouteFixture('route', routeFile([{ dest: '00000000', gw: '016433C6' }])); // → 198.51.100.1
  assert.deepEqual(defaultGatewayAddrs({ procRoutePath: other }), ['198.51.100.1']);
  assert.equal(clientIp(req('198.51.100.1', '203.0.113.9'), { procRoutePath: other }), '203.0.113.9');
  assert.equal(clientIp(req('172.32.0.1', '203.0.113.9'), { procRoutePath: other }), '172.32.0.1');
});

test('#740 A10 十六进制小端要按字节反序还原（0101A8C0 → 192.168.1.1）', () => {
  const samples = [
    ['0101A8C0', '192.168.1.1'], // 工单给的样例
    ['0114A8C0', '192.168.20.1'], // 本机宿主 eno1 的真实默认网关
    ['010011AC', '172.17.0.1'], // docker0 默认网关
    ['010020AC', '172.32.0.1'], // compose backend 网关（= 真机判据那条）
  ];
  for (const [hex, ip] of samples) {
    const file = writeRouteFixture('route', routeFile([{ dest: '00000000', gw: hex }]));
    assert.deepEqual(defaultGatewayAddrs({ procRoutePath: file }), [ip], `${hex} 必须还原成 ${ip}`);
  }
  // 反证：按大端直读（不反序）得到的是另一个地址 ⇒ 断言在钉字节序，而不是「能解析出某个 IP」。
  const be = writeRouteFixture('route', routeFile([{ dest: '00000000', gw: '0101A8C0' }]));
  assert.notDeepEqual(defaultGatewayAddrs({ procRoutePath: be }), ['1.1.168.192']);
});

test('#740 A11 nexthop 懒算一次并缓存（按路径）：首算之后改文件不重读', () => {
  const dir = mkTempFixture('proc-route-740b-cache-'); // 同样登记 ⇒ 由文件级 after() 清（A13）
  const file = path.join(dir, 'route');
  fs.writeFileSync(file, routeFile([{ dest: '00000000', gw: '010020AC' }])); // 172.32.0.1
  assert.equal(clientIp(req('172.32.0.1', '203.0.113.9'), { procRoutePath: file }), '203.0.113.9', '首次：读文件并缓存');
  fs.writeFileSync(file, routeFile([{ dest: '00000000', gw: '0100000A' }])); // 改成 10.0.0.1
  assert.deepEqual(defaultGatewayAddrs({ procRoutePath: file }), ['10.0.0.1'], 'defaultGatewayAddrs 本身是纯解析（不缓存），必须看到新内容');
  assert.equal(clientIp(req('172.32.0.1', '203.0.113.9'), { procRoutePath: file }), '203.0.113.9', '已缓存 ⇒ 不得重读文件（否则 172.32.0.1 会掉出可信集合）');
  // 另一路径 = 另一槽位：不受上面那份缓存影响（真懒算，不是一份全局写死的值）。
  const other = writeRouteFixture('route', routeFile([{ dest: '00000000', gw: '0100000A' }]));
  assert.equal(clientIp(req('10.0.0.1', '203.0.113.9'), { procRoutePath: other }), '203.0.113.9');
  assert.equal(clientIp(req('172.32.0.1', '203.0.113.9'), { procRoutePath: other }), '172.32.0.1');
});

test('#740 A12 真实 /proc/net/route（不传 opts = 生产调用形状）：不炸且只返合法 v4，loopback 仍采信头', () => {
  const addrs = defaultGatewayAddrs();
  assert.ok(Array.isArray(addrs), '返回必须是数组');
  assert.ok(addrs.every((a) => net.isIPv4(a)), `每一项必须是合法 v4，得到：${JSON.stringify(addrs)}`);
  // 生产那 7 个调用点都是 clientIp(req)：不传 opts 也必须照旧采信 loopback 对端的头。
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.9')), '203.0.113.9');
});

test('#740 A13 夹具目录必须被清（§3.2 teardown 纪律自己也要有断言，不许只删不证）', () => {
  // 本格跑在文件级 `after()` **之前**，所以它能钉清理断言的前半：登记到位 + 目录此刻确实存在
  // （「此刻存在」是把后半变强的关键：否则「删完之后不存在」可以是「删了个本来就不存在的名字」那种恒真空转）。
  // 后半（「删完必须不存在」）在上面两个 `after()` 里；两半合起来才是完整判据。
  const dir = path.dirname(writeRouteFixture('a13', routeFile([{ dest: '00000000', gw: '010020AC' }])));
  assert.ok(tempDirs.has(dir), `A13：mkdtemp 目录必须登记进 teardown 集合，实际没登记：${dir}`);
  assert.ok(fs.existsSync(dir), `A13：夹具目录此刻必须存在（否则清理断言是恒真的空转）：${dir}`);
  // 计数钉死「所有夹具都走了登记通道」：A7 1 + A8 4（含 missing 目录）+ A9 2 + A10 5 + A11 2 + 本格 1 = 15。
  // 以后新增夹具若绕过 `mkTempFixture`，这里会红——比「/tmp 慢慢堆目录」早得多。
  assert.equal(tempDirs.size, 15, `A13：此刻应恰好登记 15 个临时目录（见本格注释的逐项构成），实际 ${tempDirs.size} 个`);
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
