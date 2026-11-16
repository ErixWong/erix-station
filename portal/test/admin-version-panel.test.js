// issue #586 判据 C：管理台「关于」面板的后端面 `GET /api/admin/version`（版本三格）。
//
// 本单要治的真事故：发 v0.1.69 时宿主工作树停在 0.1.68，portal 镜像烘的就是那份旧树 ⇒
// **真机上 FDE 报 0.1.69、portal 报 0.1.68 分裂一小时，没有任何机器判据发现它**。根因是三个版本号
// （服务端 / 平台侧引擎 / 每台 FDE 的引擎）**只在人脑里分开**，界面上一个读面都没有。
// 本文件钉的就是那条最小读面：三段各自来自哪里、互不互抄、拿不到时说什么。
//
// 判据（与工单 261116-12 的 C 段一一对应）：
//   C-1 三段分开：`server`（服务端）/ `platformEngine`（平台侧引擎）/ `fdes[]`（每台 FDE）
//   C-2 **不许互抄**：FDE 那格必须来自 `containers.agent_version`，与 build-info 的 `engine_version`
//       是两个独立的数（本文件故意让两者不同，抄了就红）
//   C-3 FDE 段带**口径标注**（`snapshot: 'provision'` + `provenance.fdes`），前端据此渲染「provision 时快照」
//   C-4 鉴权同其余 admin 端点（无会话 401、非 admin 403），只读 GET，非 GET 走 404（不新增错误码）
//   C-5 「读不到」≠「一台 FDE 都没有」（#350 同口径）⇒ `fdesPresent:false`，页面才有资格说「读不到」
//
// 隔离（docs/testing.md §2.1）：注入内存 FakePool + 临时 static 目录 + 临时 build-info 文件，
// 不碰真实 DB、不碰仓库里的 `package.json`。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { aboutPanel, normalizeFdeRow } from '../src/version-info.js';
import { UNKNOWN } from '../src/build-info.js';
import { FakePool } from './fake-pool.js';

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const FDE_ID = '00000000-0000-4000-8000-0000000000a2';
const ADMIN_TOKEN = 'version-admin-session';
const FDE_TOKEN = 'version-fde-session';

/**
 * 注入用的 build-info：版本故意与仓库 `package.json`（现读 0.1.x）**不同**，引擎版本也故意与
 * `containers.agent_version` **不同** ⇒ 任何一格「顺手抄了别处」都会在这里露馅。
 */
const INJECTED = {
  station_version: '9.1.1-from-image',
  engine_version: '0.900.1-platform-engine',
  revision: 'b'.repeat(40),
  built_at: '2026-11-16T03:45:00Z',
};

const CONTAINERS = [
  {
    fde_name: 'eric', agent_version: '0.910.7-fde-side', image: 'ghcr.io/erixwong/erix-station-fde@sha256:aaa',
    created_at: new Date('2026-11-16T02:00:00Z'), rotated_at: null,
    last_heartbeat: new Date('2026-11-16T04:00:00Z'), revoked_at: null,
  },
  {
    fde_name: 'bob', agent_version: '0.910.6-fde-old', image: 'ghcr.io/erixwong/erix-station-fde@sha256:bbb',
    created_at: new Date('2026-10-01T02:00:00Z'), rotated_at: null,
    last_heartbeat: null, revoked_at: new Date('2026-11-01T02:00:00Z'),
  },
];

class VersionPool extends FakePool {
  constructor({ containers = CONTAINERS, failContainers = false } = {}) {
    super({
      users: [
        { id: ADMIN_ID, login: 'admin', role: 'admin', status: 'active', auth_source: 'local' },
        { id: FDE_ID, login: 'alice', role: 'fde', fde_name: 'alice', status: 'active', auth_source: 'local' },
      ],
    });
    this.containers = containers;
    this.failContainers = failContainers;
    this.containerQueries = 0;
  }

  async query(sql, params = []) {
    const text = String(sql);
    if (text.includes('FROM containers')) {
      this.containerQueries += 1;
      if (this.failContainers) throw new Error('db down');
      // 按 SQL 说的做（AGENTS §8.14）：SELECT 里没点名的列**不补**，产品代码漏选就会拿 undefined；
      // `ORDER BY fde_name` 也只在本 fake 真的读到这句时才排 —— 否则「产品代码丢了 ORDER BY」会被
      // 插入序兼平成假绿。
      const ordered = /ORDER BY\s+fde_name/i.test(text)
        ? [...this.containers].sort((a, b) => (a.fde_name > b.fde_name ? 1 : -1))
        : this.containers;
      return {
        rows: ordered.map((row) => ({
          fde_name: /\bfde_name\b/.test(text) ? row.fde_name : undefined,
          agent_version: /\bagent_version\b/.test(text) ? row.agent_version : undefined,
          image: /\bimage\b/.test(text) ? row.image : undefined,
          created_at: /\bcreated_at\b/.test(text) ? row.created_at : undefined,
          last_heartbeat: /\blast_heartbeat\b/.test(text) ? row.last_heartbeat : undefined,
          revoked_at: /\brevoked_at\b/.test(text) ? row.revoked_at : undefined,
        })),
      };
    }
    return super.query(sql, params);
  }
}

function injectBuildInfo(values = INJECTED) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-586-panel-'));
  const file = path.join(dir, 'build-info.json');
  fs.writeFileSync(file, JSON.stringify(values));
  return { dir, file };
}

async function startServer(pool = new VersionPool(), envPatch = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-586-pstatic-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'INDEX');
  const config = {
    cookie: cookieSettings('version-api-test', 600),
    sessionTtlSeconds: 600, sessionRenewIntervalSeconds: 3600, pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 20, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: { maxFailures: 20, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 20, maxEntries: 100 },
    kdfConcurrency: 1, kdfQueueLimit: 10, kdfQueueTimeoutMs: 1000,
    maxBodyBytes: 64 * 1024, maxLoginLength: 128, maxPasswordLength: 256, staticDir,
  };
  const savedEnv = new Map();
  for (const [key, value] of Object.entries(envPatch)) {
    savedEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const [id, token] of [[ADMIN_ID, ADMIN_TOKEN], [FDE_ID, FDE_TOKEN]]) {
    pool.sessions.push({
      id: `session-${id}`, user_id: id, token_hash: hashToken(token),
      created_at: new Date(), expires_at: new Date(Date.now() + 600_000),
      last_seen_at: new Date(), revoked_at: null,
    });
  }
  const server = createServer({ pool, config, log: { error() {}, warn() {}, log() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    pool,
    base: `http://127.0.0.1:${server.address().port}`,
    adminCookie: `${config.cookie.name}=${ADMIN_TOKEN}`,
    fdeCookie: `${config.cookie.name}=${FDE_TOKEN}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(staticDir, { recursive: true, force: true });
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

async function get(srv, cookie = srv.adminCookie) {
  const res = await fetch(`${srv.base}/api/admin/version`, { headers: cookie ? { cookie } : {} });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}

// ─────────────────────────────────────────────────────────────────────────────
// C-1 / C-2 / C-3：三段分开、来源互不互抄
// ─────────────────────────────────────────────────────────────────────────────
test('#586C：`GET /api/admin/version` 回三段，且每格的值出自**它自己那一格**的来源', async () => {
  const { dir, file } = injectBuildInfo();
  const srv = await startServer(new VersionPool(), { STATION_BUILD_INFO_PATH: file });
  try {
    const { status, body } = await get(srv);
    assert.equal(status, 200);
    assert.deepEqual(body.server, {
      station: INJECTED.station_version,
      revision: INJECTED.revision,
      builtAt: INJECTED.built_at,
      source: 'build-info',
    }, '服务端段 = portal 镜像内 build-info.json 的三格（`source` 说清它是烘进来的还是现读的）');
    assert.deepEqual(body.platformEngine, { version: INJECTED.engine_version },
      '平台侧引擎段 = 同一份 build-info 的 engine_version');

    assert.equal(body.fdes.length, 2);
    assert.deepEqual(body.fdes.map((f) => f.name), ['bob', 'eric'], '按 fde_name 排序（面板要能扫）');
    const eric = body.fdes.find((f) => f.name === 'eric');
    assert.equal(eric.agentVersion, '0.910.7-fde-side',
      '**判据 C-2**：FDE 段读的是 `containers.agent_version`，不是平台侧引擎版本（抄了就红）');
    assert.notEqual(eric.agentVersion, body.platformEngine.version,
      '两个引擎数必须分得开（夹具故意让它们不同）');
    assert.equal(eric.image, 'ghcr.io/erixwong/erix-station-fde@sha256:aaa', '附镜像引用（digest 形态），供对账');
    assert.equal(eric.provisionedAt, new Date('2026-11-16T02:00:00Z').toISOString(),
      'provision 时刻 = 建行时刻（`containers.created_at`，口径由面板标注）');
    assert.equal(eric.snapshot, 'provision', '**判据 C-3**：机器可读的快照口径标注');
    assert.equal(eric.versionSource, 'containers.agent_version', '来源标注：前端不许自己再算一份版本');
    assert.equal(eric.revoked, false);
    assert.equal(body.fdes.find((f) => f.name === 'bob').revoked, true,
      '已吊销的行要带标记（否则一台不存在的 FDE 会顶着旧版本留在面板上）');

    assert.deepEqual(body.provenance, {
      server: 'build-info.json',
      platformEngine: 'build-info.json',
      fdes: 'containers.agent_version',
      fdesSnapshot: 'provision',
    });
    assert.equal(srv.pool.containerQueries, 1, 'FDE 段只查一次 containers（不多打一趟 DB）');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#586C：FDE 段那一格**不是**从服务端那格推出来的（把 containers 清空 ⇒ 只剩空数组，两格仍各自独立）', async () => {
  const { dir, file } = injectBuildInfo();
  const srv = await startServer(new VersionPool({ containers: [] }), { STATION_BUILD_INFO_PATH: file });
  try {
    const { body } = await get(srv);
    assert.deepEqual(body.fdes, [], '没有 FDE ⇒ 空数组');
    assert.equal(body.fdesPresent, true, '查成功且真的零行 ≠ 「读不到」（判据 C-5 的另一面）');
    assert.equal(body.server.station, INJECTED.station_version, '服务端段不受 FDE 段有没有行影响');
    assert.equal(body.platformEngine.version, INJECTED.engine_version);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#586C：「读不到」不许伪装成「一台都没有」——containers 查询失败 ⇒ `fdesPresent:false`，端点仍 200', async () => {
  const { dir, file } = injectBuildInfo();
  const srv = await startServer(new VersionPool({ failContainers: true }), { STATION_BUILD_INFO_PATH: file });
  try {
    const { status, body } = await get(srv);
    assert.equal(status, 200, '观测面不承重：一段读不到不把整个面板打成 500');
    assert.deepEqual(body.fdes, []);
    assert.equal(body.fdesPresent, false, '页面据此说「读不到」，而不是「0 台 FDE」');
    assert.equal(body.server.station, INJECTED.station_version, '另外两格照常');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// C-4：鉴权与其余 admin 端点同口径（`requireAdmin`），只读
// ─────────────────────────────────────────────────────────────────────────────
test('#586C：鉴权同其余 admin 端点 —— 无会话 401、非 admin 403、admin 200', async () => {
  const { dir, file } = injectBuildInfo();
  const srv = await startServer(new VersionPool(), { STATION_BUILD_INFO_PATH: file });
  try {
    assert.equal((await get(srv, '')).status, 401, '无会话 ⇒ 401（走 requireSession，不新造错误码）');
    assert.equal((await get(srv, srv.fdeCookie)).status, 403, 'fde 角色 ⇒ 403（面板是管理台面）');
    assert.equal((await get(srv)).status, 200, 'admin ⇒ 200');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#586C：只读端点 —— 非 GET 不落在本端点上（404 `not_found`，不新增 405 与错误码）', async () => {
  const { dir, file } = injectBuildInfo();
  const srv = await startServer(new VersionPool(), { STATION_BUILD_INFO_PATH: file });
  try {
    const res = await fetch(`${srv.base}/api/admin/version`, {
      method: 'POST', headers: { cookie: srv.adminCookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'not_found');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 降级面：没有 build-info（dev 源码态）与脏行
// ─────────────────────────────────────────────────────────────────────────────
test('#586C：没有 build-info（本地源码态）⇒ 两格引擎/服务端数从 `package.json` 与 `unknown` 来，绝不抛', async () => {
  const body = await aboutPanel({
    pool: new VersionPool(),
    readVersion: () => ({ station: '0.1.69', engine: UNKNOWN, revision: UNKNOWN, builtAt: UNKNOWN, source: 'package' }),
  });
  assert.equal(body.server.station, '0.1.69');
  assert.deepEqual(body.platformEngine, { version: UNKNOWN }, 'dev 源码态没烘引擎版本 ⇒ unknown，不是空串、不是 0');
  assert.equal(body.server.source, 'package', '面板能看出这格是「现读的 package.json」而不是镜像里烘的');
  assert.deepEqual(Object.values(body.server).every((v) => typeof v === 'string' && v !== ''), true);
});

test('#586C：脏行不猜版本 —— 缺列 / 非字符串 / 空串一律落 `unknown`，但整行不丢', () => {
  assert.deepEqual(normalizeFdeRow({ fde_name: 'x', agent_version: null }), {
    name: 'x', agentVersion: UNKNOWN, image: UNKNOWN, provisionedAt: null,
    lastHeartbeatAt: null, revoked: false, versionSource: 'containers.agent_version', snapshot: 'provision',
  }, '`agent_version` 为 NULL ⇒ unknown（一个看起来合法的假值比空值毒）');
  assert.equal(normalizeFdeRow({ fde_name: 'x', agent_version: '   ' }).agentVersion, UNKNOWN);
  assert.equal(normalizeFdeRow({ fde_name: 'x', agent_version: 1.69 }).agentVersion, UNKNOWN,
    '数字不做 String() 硬转（那会把脏形状伪装成版本号）');
  assert.equal(normalizeFdeRow({ agent_version: '0.1.2' }).name, UNKNOWN, '没有 fde_name 也要留行（丢行 = 少一台 FDE）');
  assert.equal(normalizeFdeRow({ fde_name: 'y', created_at: '2026-11-16T02:00:00Z' }).provisionedAt,
    '2026-11-16T02:00:00Z', '字符串形态原样透出（Date 才 ISO 化）');
});
