// issue #803 返修②：`portalloc` 这一族（预览端口块 / 预览域名预算）以前整条链没有 `en` 通道——
// 错误码齐全（前端能分支），文案却只有中文，`locale=en` 的请求直出中文。本文件把补上的英文腿逐字钉住：
//   ① `projects.validateFdeNameForHostname` 的**四个**失败 return（含「FDE 名过长：」）
//      与 `projects.validateHostnameGrammar` 的**三个** return（同族多 return，少钉一个就是漏翻）；
//   ② `portalloc` 的两个 hostname 抛点（`ensureFdePreviewPorts:` / `moveFdePreviewBlock:` 前缀不同 ⇒
//      英文必然不同，各钉各的）；
//   ③ `preview_port_block_taken` 的**四个**抛点（同一个码四副面孔，中文各不相同）；
//   ④ 经 `http.js` 重包后的出口断言（`locale=en` ⇒ 英文 / 不带 locale ⇒ 中文逐字）。
//
// 判据口径（与 `tls-admin-messages-i18n.test.js` 同）：一律**逐字** `assert.equal`，不许 `includes` 文案；
// 每条英文与对应中文互不相同；错误信封形状（`code` / `message` / `details`）不变。
// 只有「模块级断言」用整段匹配源码，理由写在对应测试的注释里（不是偷懒）。
//
// 本文件不碰本机/内网坐标：base 域一律 RFC 2606 保留的 `.test`。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { validateFdeNameForHostname, validateHostnameGrammar } from '../src/projects.js';
import * as portalloc from '../src/portalloc.js';
import {
  PREVIEW_PORT_COUNT, PREVIEW_PORT_POOL_START, assertAlignedPreviewBlockStart,
} from '../src/previewpool.js';
import { FakePool } from './fake-pool.js';

const SELF_UID = process.getuid?.() ?? 1000;
const SELF_GID = process.getgid?.() ?? 1000;

const BASE = 'example.test';            // 伞域（红线：不写真实域名）
const POOL_START = PREVIEW_PORT_POOL_START;
const COUNT = PREVIEW_PORT_COUNT;
const POOL_END = portalloc.PREVIEW_PORT_POOL_END;
const NAME_56 = 'a'.repeat(56);         // 预算 55 ⇒ 超一个字符，落「FDE 名过长」那条
const SECOND_BLOCK = POOL_START + COUNT;

// 「FDE 名过长」那一条的中文原文与新增英文腿（两处抛点共用同一句内核）。
const ZH_TOO_LONG = 'FDE 名过长：生成的预览域名单标签 64 字符，超过 DNS 上限 63（FDE 名请缩短到 55 以内）';
const EN_TOO_LONG = 'FDE name is too long: a single label of the generated preview hostname is 64 characters, '
  + 'exceeding the DNS limit of 63 (please shorten the FDE name to at most 55 characters)';

// 模块级断言用的字面量匹配（把源码里的整段当正则字面量，避免手工转义出错）。
const SRC_PORTALLOC = readFileSync(new URL('../src/portalloc.js', import.meta.url), 'utf8');
const SRC_HTTP = readFileSync(new URL('../src/http.js', import.meta.url), 'utf8');
const lit = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

// ───────────── ① 同族多 return：中文逐字 + 英文逐字，且英文互不相同 ─────────────

test('validateFdeNameForHostname 的四个失败 return：中文逐字未动、英文腿逐字、四条英文互不相同', () => {
  // 四条各自的构造：非法字符 / 整域名过长 / 单标签过长（「FDE 名过长：」）/ base 域标签非法。
  const cases = [
    {
      name: 'fde_name 本身非法',
      run: () => validateFdeNameForHostname('Alice_Bad!', { baseDomain: BASE }),
      message: 'fde_name 非法（小写字母/数字/连字符，不以连字符开头或结尾）',
      en: 'invalid fde_name (lowercase letters, digits, hyphens; must not start or end with a hyphen)',
    },
    {
      name: '整域名超 253',
      run: () => validateFdeNameForHostname('a'.repeat(50), { baseDomain: `${'x'.repeat(200)}.test` }),
      message: '预览域名过长：生成的预览域名总长 264 字符，超过整域名上限 253',
      en: 'preview hostname is too long: the generated hostname is 264 characters, exceeding the 253-character limit for a full domain name',
    },
    {
      name: '单标签超 63（FDE 名过长）',
      run: () => validateFdeNameForHostname(NAME_56, { baseDomain: BASE }),
      message: ZH_TOO_LONG,
      en: EN_TOO_LONG,
    },
    {
      name: 'base 域标签非法',
      run: () => validateFdeNameForHostname('alice', { baseDomain: 'Bad_Label.test' }),
      message: '预览域名非法：base 域标签「Bad_Label」9 字符，超过 DNS 上限 63 或含非法字符',
      en: 'invalid preview hostname: the base-domain label "Bad_Label" is 9 characters, exceeding the DNS limit of 63 or containing illegal characters',
    },
  ];
  const english = new Set();
  for (const one of cases) {
    const r = one.run();
    assert.equal(r.ok, false, `${one.name} 应当校验失败`);
    assert.equal(r.message, one.message, `${one.name} 的中文原文被改了`);
    assert.equal(r.en, one.en, `${one.name} 的英文腿逐字不符（或根本没补）`);
    english.add(r.en);
  }
  assert.equal(english.size, cases.length, '四条英文必须互不相同（同一句贴四份等于没翻）');
});

test('validateHostnameGrammar 的三个 return：reasonEn 逐字，三条英文互不相同', () => {
  const cases = [
    {
      name: '空 hostname',
      run: () => validateHostnameGrammar(''),
      reason: 'hostname 为空',
      reasonEn: 'hostname is empty',
    },
    {
      name: '总长超 253',
      run: () => validateHostnameGrammar(`${'a'.repeat(254)}.test`),
      reason: '总长 259 字符，超过整域名上限 253',
      reasonEn: 'total length 259 characters, exceeding the 253-character limit for a full domain name',
    },
    {
      name: '单标签含非法字符',
      run: () => validateHostnameGrammar('Bad_Label.test'),
      reason: '单标签「Bad_Label」9 字符，超过 DNS 上限 63 或含非法字符',
      reasonEn: 'the label "Bad_Label" is 9 characters, exceeding the DNS limit of 63 or containing illegal characters',
    },
  ];
  const english = new Set();
  for (const one of cases) {
    const r = one.run();
    assert.equal(r.ok, false, `${one.name} 应当校验失败`);
    assert.equal(r.reason, one.reason, `${one.name} 的中文原文被改了`);
    assert.equal(r.reasonEn, one.reasonEn, `${one.name} 的英文腿逐字不符（或根本没补）`);
    english.add(r.reasonEn);
  }
  assert.equal(english.size, cases.length, '三条英文必须互不相同');
});

// ───────────── ② portalloc 的两个 hostname 抛点：前缀不同 ⇒ 英文不同 ─────────────

// 这两个入口的 hostname 校验都在**任何 SQL 之前**，所以传一个「一动 SQL 就炸」的对象：
// 拿到的仍是 hostname 错误码 ⇒ 顺带钉住「400 类错误零 SQL」这条既有判据。
const NO_SQL = {
  query: async () => { throw new Error('不该发 SQL'); },
  connect: async () => { throw new Error('不该连连接'); },
};

test('portalloc · ensureFdePreviewPorts 抛点：中文带自己的前缀，英文腿同前缀逐字对齐', async () => {
  const err = await portalloc.ensureFdePreviewPorts(NO_SQL, {
    fdeId: 7, fdeName: NAME_56, baseDomain: BASE,
  }).then(() => null, (e) => e);
  assert.equal(err.code, 'preview_hostname_invalid');
  assert.equal(err.message, `ensureFdePreviewPorts: ${ZH_TOO_LONG}`);
  assert.equal(err.en, `ensureFdePreviewPorts: ${EN_TOO_LONG}`);
});

test('portalloc · moveFdePreviewBlock 抛点：英文与上一处不同（不是复制粘贴）', async () => {
  const err = await portalloc.moveFdePreviewBlock(NO_SQL, { baseDomain: BASE },
    { fdeId: 7, fdeName: NAME_56, blockStart: SECOND_BLOCK }).then(() => null, (e) => e);
  assert.equal(err.code, 'preview_hostname_invalid');
  assert.equal(err.message, `moveFdePreviewBlock: ${ZH_TOO_LONG}`);
  assert.equal(err.en, `moveFdePreviewBlock: ${EN_TOO_LONG}`);
  // 两处以前都只贴中文 ⇒ 现在两句英文必须真的不同。
  assert.notEqual(err.en, `ensureFdePreviewPorts: ${EN_TOO_LONG}`);
});

// ───────────── ③ preview_port_block_taken 的四个抛点 ─────────────

/**
 * 只演 `moveFdePreviewBlock` 需要的三类取数：本 FDE 活行 / 全局活行 / 事务语句。
 * 搬迁在「撞外来活行」这一步就抛，因此零写库、只需 `ROLLBACK` + `release()`。
 */
function makeMoveClient({ ownPorts = [], globalPorts = [] }) {
  const queries = [];
  async function query(sql, params) {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    queries.push({ sql: flat, params });
    if (/SELECT DISTINCT port FROM port_allocations/.test(flat)) {
      const scoped = /fde_id = \$3/.test(flat);
      return { rows: (scoped ? ownPorts : globalPorts).map((port) => ({ port })) };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/.test(flat)) return {};
    return { rows: [], rowCount: 0 };
  }
  return { queries, query, release() {} };
}

test('block_taken · 撞外来活行（真构造）：中文逐字 + .en 逐字，两句不是同一份', async () => {
  const label = portalloc.previewBlockLabel(SECOND_BLOCK);
  const foreignPort = SECOND_BLOCK + 3;
  const client = makeMoveClient({ globalPorts: [foreignPort] });
  const pool = { connect: async () => client, query: client.query };
  const err = await portalloc.moveFdePreviewBlock(pool, { baseDomain: BASE },
    { fdeId: 7, fdeName: 'alice', blockStart: SECOND_BLOCK }).then(() => null, (e) => e);
  assert.equal(err.code, 'preview_port_block_taken');
  assert.equal(err.message,
    `预览端口块 ${label} 已被占用（外来活行端口：${foreignPort}；占用判据 = 全局活行 state <> 'released'，`
    + `本 FDE 自己的活行不算冲突）：先释放或改走那段，或换一个整块空闲的对齐起点（${POOL_START}、`
    + `${POOL_START + COUNT}、…，每段 ${COUNT} 个）`);
  assert.equal(err.en,
    `preview port block ${label} is already taken (foreign live ports: ${foreignPort}; `
    + `the occupancy rule is the global live rows state <> 'released' - this FDE's own live rows do not count as a conflict): `
    + `free or move those ports first, or choose another fully free aligned block start `
    + `(${POOL_START}, ${POOL_START + COUNT}, ..., ${COUNT} ports per block)`);
  assert.notEqual(err.en, err.message);
});

// 模块级断言的理由（**不是偷懒**）：剩下三个 `preview_port_block_taken` 抛点分别要
//   ① 真 PG 唯一索引在 INSERT 时抛 23505（`clash.en`）；
//   ② `provisionFdePreviewPorts` 三次重试全撞（重试用尽那条，英文优先取 `lastErr.en`）；
//   ③ `INSERT … SELECT` 少插一行（并发抢号 ⇒ 搬迁中途插入不足）。
// 三者的触发条件都是「PG 在真实约束 / 并发下的行为」，用 fake client 硬演会变成「我让它抛什么它就抛什么」
// 的假绿断言，反而不如整段匹配源码诚实。这里只钉「中文旁边确实配了英文」这一件事，以及四句英文互不相同。
test('block_taken · 另三个抛点（23505 重叠 / 重试用尽 / 搬迁中途插入不足）中文旁边确实配了英文', () => {
  const englishFragments = [
    'clash.en = `preview port block ${previewBlockLabel(block)} overlaps existing live rows `',
    // #902 ①：以前这里钉的是 `${lastErr?.en ?? lastErr?.message ?? …}` ⇒ 「英文腿里可能混中文」被**当源码片段钉成了契约**
    // （片段断言只能证明「源码写了这句」，中文真涌进英文句时它照样绿）。现在钉不带 `.message` 的那一句，
    // 并在下面反向钉「不许再出现 `lastErr?.message`」+ 另加一条真行为判据（见下一条测试）。
    '${lastErr?.en ?? \'preview port block overlaps existing live rows\'} ',
    'tried ${maxAttempts} times = the first attempt plus',
    'is already taken (foreign live ports:',
    '`moving to preview port block ${targetLabel} inserted only ${out.inserted.length}/${PREVIEW_PORT_COUNT} rows `',
  ];
  for (const fragment of englishFragments) {
    assert.match(SRC_PORTALLOC, lit(fragment), `portalloc.js 里找不到这段英文腿：${fragment}`);
  }
  assert.equal(new Set(englishFragments).size, englishFragments.length, '四句英文必须互不相同');
  // 反向钉子：英文腿那一格里不许再有「回退到中文 `message`」这一级。
  assert.doesNotMatch(SRC_PORTALLOC, /\$\{lastErr\?\.en[^}]*lastErr\?\.message/,
    'portalloc.js 重试用尽那条英文腿又带上了 lastErr?.message 中文回退（#902 ①）');
});

// #902 ① 的真行为判据（上面那条只钉源码片段，片段里混中文它看不出来）：内层 `preview_port_block_taken`
// **只有中文 `message`、没有 `en`**（真库 23505 那条一定带 `clash.en`，但「某个内层抛点漏配英文」正是
// 这里要防的病）⇒ 重试用尽后抛出的 `err.en` 必须**一个汉字都没有**。
test('block_taken · 重试用尽：内层只有中文 message 无 en ⇒ 最终英文腿不含汉字（不回退中文）', async () => {
  const zhOnlyError = () => {
    const e = new Error('预览端口块与既有活行重叠：并发抢号，请管理员显式改块');
    e.code = 'preview_port_block_taken';
    return e;
  };
  // 每个事务的第一句 SQL（`BEGIN`）就抛 ⇒ 三次重试全部落同一颗只有中文的错。
  const client = { query: async () => { throw zhOnlyError(); }, release() {} };
  const pool = { connect: async () => client, query: client.query };
  const err = await portalloc.provisionFdePreviewPorts(pool, { baseDomain: BASE },
    { fdeId: 7, fdeName: 'alice', log: { warn() {} } }).then(() => null, (e) => e);
  assert.equal(err.code, 'preview_port_block_taken');
  // 中文腿照旧带内层中文原文（中文腿逐字口径不许动）。
  assert.ok(err.message.includes('预览端口块与既有活行重叠'), '中文腿应仍带上内层中文原文');
  // 判据本体：英文腿里零汉字（旧写法会把中文 `message` 拼进来 ⇒ 这里红）。排在下面两句片段匹配**之前**，
  // 保证回归时报出来的是这条判据本身，而不是被前面的片段匹配先吃掉。
  assert.equal(/[\u4e00-\u9fa5]/.test(err.en), false, `英文腿混进了汉字：${err.en}`);
  assert.match(err.en, /preview port block overlaps existing live rows/);
  assert.match(err.en, /tried 3 times = the first attempt plus 2 automatic recomputes/);
});

// ───────────── preview_port_block_invalid：中文在 previewpool，英文在 http 出口 ─────────────

test('preview_port_block_invalid · 中文逐字仍在 previewpool（没被改），英文对照挂在 http.js 出口', () => {
  const bad = POOL_START + 1;                          // 未对齐 ⇒ 非法块起点
  const err = (() => {
    try { assertAlignedPreviewBlockStart(bad); return null; } catch (e) { return e; }
  })();
  assert.equal(err.code, 'preview_port_block_invalid');
  // 中文原文逐字（红线：这条不许改，改了这条就该红）。它自己**不带** `en`。
  assert.equal(err.message,
    `预览端口块起点 ${bad} 不合法：必须是 ${COUNT} 的倍数、且整块落在号池 ${POOL_START}–${POOL_END} 内`
    + `（合法起点：${POOL_START}、${POOL_START + COUNT}、…、${POOL_END - COUNT + 1}）`);
  assert.equal(err.en, undefined);
  // 英文在 `http.js` 的重包出口给出。退模块级的理由：同一个判据被**入口**前置拦住
  // （`handleAdminMoveFdePortsBlock` 先查 `isPreviewPortInPool` + `isAlignedPreviewBlockStart`），
  // 所以这条出口腿在 HTTP 上打不到、是防御腿 ⇒ 只能整段匹配源码钉它存在。
  assert.match(SRC_HTTP, lit(
    'en: `preview port block start ${JSON.stringify(blockStart)} is invalid: it must be a multiple of ${PREVIEW_PORT_COUNT} `',
  ));
});

// ───────────── ④ 经 http.js 重包的出口断言（真 server + 真会话） ─────────────

const ADMIN = {
  id: 'a0000000-0000-4000-8000-00000000000a', login: 'root', display_name: 'Root',
  role: 'admin', fde_name: 'admin', auth_source: 'local', status: 'active',
};
const ADMIN_TOKEN = 'tok-803r-portalloc';

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `station-803r-${tag}-`));
}

/**
 * 起一个真 server，pool 只在三类语句上接管（FDE 反查 / 占用取数 / 事务语句），其余回落 FakePool。
 * `fdeRow` 控制 `resolveFdeByName` 反查回来的 FDE 名（从而控制进入搬迁的名字），
 * `globalPorts` 控制目标块里有没有外来活行。
 */
async function startServer({ fdeRow = null, ownPorts = [], globalPorts = [] } = {}) {
  const staticDir = tmpdir('static');
  const userspace = tmpdir('userspace');
  const config = {
    cookie: cookieSettings('dev-803r-portalloc', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    loginRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, maxEntries: 10_000 },
    totpRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 100, maxEntries: 10_000 },
    kdfConcurrency: 2, kdfQueueLimit: 100, kdfQueueTimeoutMs: 30_000,
    maxLoginLength: 128, maxPasswordLength: 256,
    totp: { issuer: 'erix-station-test', digits: 6, period: 30, window: 1 },
    dockerHost: 'tcp://127.0.0.1:1', staticDir,
    userSpaceRoot: userspace, fdeUid: SELF_UID, fdeGid: SELF_GID, fileUploadMaxBytes: 32 * 1024 * 1024,
    traefikDynamicDir: tmpdir('dyn'),
    adminHost: 'station.example.test',
    adminPort: 9443,
    baseDomain: BASE,
  };
  const base_ = new FakePool({ users: [ADMIN] });
  base_.sessions.push({
    id: 'ls-admin', user_id: ADMIN.id, token_hash: auth.hashToken(ADMIN_TOKEN),
    created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
  });
  const inner = base_.query.bind(base_);
  const client = makeMoveClient({ ownPorts, globalPorts });
  base_.query = (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    if (/FROM users WHERE fde_name = \$1/.test(flat)) return Promise.resolve({ rows: fdeRow ? [fdeRow] : [] });
    if (/SELECT DISTINCT port FROM port_allocations/.test(flat)) {
      const scoped = /fde_id = \$3/.test(flat);
      return Promise.resolve({ rows: (scoped ? ownPorts : globalPorts).map((port) => ({ port })) });
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/.test(flat)) return Promise.resolve({});
    if (/FROM port_allocations/.test(flat)) return Promise.resolve({ rows: [], rowCount: 0 });
    return inner(sql, params);
  };
  base_.connect = async () => ({ query: (sql, params) => base_.query(sql, params), release() {} });
  const server = createServer({
    pool: base_, config, docker: null,
    llmGateway: { async listModels() { return { data: [] }; } },
    log: { error: () => {}, warn: () => {}, log: () => {}, debug: () => {} },
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    cookie: `${config.cookie.name}=${ADMIN_TOKEN}`,
    queries: client.queries,
    close: () => new Promise((res) => server.close(res))
      .finally(() => {
        fs.rmSync(staticDir, { recursive: true, force: true });
        fs.rmSync(userspace, { recursive: true, force: true });
      }),
  };
}

async function hit(base, { method = 'POST', p, cookie, locale, body }) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (locale) headers['accept-language'] = locale;
  const res = await fetch(base + p, { method, headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON：留 null */ }
  return { status: res.status, error: json?.error };
}

test('出口 · preview_hostname_invalid：locale=en ⇒ 英文逐字，缺省 ⇒ 中文逐字（400，details 不变）', async () => {
  // 反查回来的 FDE 名超预算 ⇒ 搬迁事务在开事务前就抛 `preview_hostname_invalid`。
  const s = await startServer({ fdeRow: { id: 7, fde_name: NAME_56 } });
  try {
    const en = await hit(s.base, {
      p: `/api/admin/fdes/${NAME_56}/ports/block`, cookie: s.cookie, locale: 'en',
      body: { block_start: SECOND_BLOCK },
    });
    assert.equal(en.status, 400, 'en 腿 httpStatus 语义变了');
    assert.equal(en.error.code, 'preview_hostname_invalid');
    assert.equal(en.error.message, `moveFdePreviewBlock: ${EN_TOO_LONG}`);
    assert.deepEqual(en.error.details, { field: 'fde_name' });

    const zh = await hit(s.base, {
      p: `/api/admin/fdes/${NAME_56}/ports/block`, cookie: s.cookie,
      body: { block_start: SECOND_BLOCK },
    });
    assert.equal(zh.status, 400);
    assert.equal(zh.error.code, 'preview_hostname_invalid');
    assert.equal(zh.error.message, `moveFdePreviewBlock: ${ZH_TOO_LONG}`);
    assert.notEqual(en.error.message, zh.error.message);
  } finally {
    await s.close();
  }
});

test('出口 · preview_port_block_taken：locale=en ⇒ 英文逐字，缺省 ⇒ 中文逐字（409）', async () => {
  const foreignPort = SECOND_BLOCK + 3;
  const s = await startServer({ fdeRow: { id: 7, fde_name: 'alice' }, globalPorts: [foreignPort] });
  const label = portalloc.previewBlockLabel(SECOND_BLOCK);
  const zhMsg = `预览端口块 ${label} 已被占用（外来活行端口：${foreignPort}；占用判据 = 全局活行 state <> 'released'，`
    + `本 FDE 自己的活行不算冲突）：先释放或改走那段，或换一个整块空闲的对齐起点（${POOL_START}、`
    + `${POOL_START + COUNT}、…，每段 ${COUNT} 个）`;
  const enMsg = `preview port block ${label} is already taken (foreign live ports: ${foreignPort}; `
    + `the occupancy rule is the global live rows state <> 'released' - this FDE's own live rows do not count as a conflict): `
    + `free or move those ports first, or choose another fully free aligned block start `
    + `(${POOL_START}, ${POOL_START + COUNT}, ..., ${COUNT} ports per block)`;
  try {
    const en = await hit(s.base, {
      p: '/api/admin/fdes/alice/ports/block', cookie: s.cookie, locale: 'en-GB,en;q=0.9',
      body: { block_start: SECOND_BLOCK },
    });
    assert.equal(en.status, 409, 'en 腿 httpStatus 语义变了');
    assert.equal(en.error.code, 'preview_port_block_taken');
    assert.equal(en.error.message, enMsg);

    const zh = await hit(s.base, {
      p: '/api/admin/fdes/alice/ports/block', cookie: s.cookie,
      body: { block_start: SECOND_BLOCK },
    });
    assert.equal(zh.status, 409);
    assert.equal(zh.error.code, 'preview_port_block_taken');
    assert.equal(zh.error.message, zhMsg);
    assert.notEqual(en.error.message, zh.error.message);
  } finally {
    await s.close();
  }
});

test('出口 · 入口前置的 block_start 非法那条：既有英文腿逐字未动（同一族的第四句）', async () => {
  const s = await startServer({ fdeRow: { id: 7, fde_name: 'alice' } });
  try {
    const en = await hit(s.base, {
      p: '/api/admin/fdes/alice/ports/block', cookie: s.cookie, locale: 'en',
      body: { block_start: POOL_START + 1 },
    });
    assert.equal(en.status, 400);
    assert.equal(en.error.code, 'validation_failed');
    assert.equal(en.error.message,
      `block_start must be an integer block start within the pool ${POOL_START}-${POOL_END}, aligned to ${COUNT}`
      + ` (valid values: ${POOL_START}, ${POOL_START + COUNT}, ...)`);
    const zh = await hit(s.base, {
      p: '/api/admin/fdes/alice/ports/block', cookie: s.cookie,
      body: { block_start: POOL_START + 1 },
    });
    assert.equal(zh.error.message,
      `block_start 必须是号池 ${POOL_START}–${POOL_END} 内、按 ${COUNT} 对齐的整数块起点`
      + `（合法值：${POOL_START}、${POOL_START + COUNT}、…）`);
  } finally {
    await s.close();
  }
});
