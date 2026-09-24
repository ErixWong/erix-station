// portal/src/artifacts.js 单测（issue #64 R1）：上传鉴权/大小上限/sha 校验/落盘/表行/幂等 409，
// 取回鉴权（admin/属主/非属主 404），以及 http 路由层（internal PUT + 用户面 GET 流式）。
// 隔离约定：tmp 目录作 artifactsRoot；fake pool 只应答本模块的 SQL 形态；不写真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  ARTIFACT_KIND,
  extractTarGzEntry,
  putRunArtifact,
  getRunArtifact,
} from '../src/artifacts.js';
import { buildTar } from '../../runner/lib/artifacts.js';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';

const RUN_ID = '11111111-2222-3333-4444-555555555555';

function makeBundle({ truncated = false, files = [{ path: 'a.js', data: 'x' }] } = {}) {
  const manifest = {
    schema: 1, run_id: RUN_ID, captured_at: new Date().toISOString(),
    worktree: '/home/erix/worktrees/p-' + RUN_ID, git: true, truncated,
    diff_bytes: 3, files: files.map((f, i) => ({
      path: f.path, size: Buffer.byteLength(f.data), sha256: '0'.repeat(64), tar: `files/${String(i).padStart(6, '0')}`,
    })),
  };
  const entries = [{ name: 'diff.patch', data: 'd' }];
  files.forEach((f, i) => entries.push({ name: `files/${String(i).padStart(6, '0')}`, data: f.data }));
  entries.push({ name: 'manifest.json', data: JSON.stringify(manifest) });
  return zlib.gzipSync(buildTar(entries));
}

/** fake pool：只应答 artifacts 模块的 SQL（归属/插入/查询）。 */
function makePool({ ownerId = 'u1', rows = [] } = {}) {
  const state = { rows };
  return {
    state,
    async query(sql, params = []) {
      if (sql.includes('JOIN chat_sessions s') && sql.includes('s.user_id = $2')) {
        const ok = params[0] === RUN_ID && params[1] === ownerId;
        return { rows: ok ? [{ id: RUN_ID }] : [] };
      }
      if (sql.startsWith('INSERT INTO artifacts')) {
        const [runId, kind, p, size, sha, manifest] = params;
        if (state.rows.some((r) => r.run_id === runId && r.kind === kind)) return { rows: [] }; // ON CONFLICT DO NOTHING
        const row = { id: 'art-1', run_id: runId, kind, path: p, size, sha, manifest: JSON.parse(manifest), owner_id: ownerId, created_at: new Date() };
        state.rows.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (sql.includes('FROM artifacts a')) {
        const row = state.rows.find((r) => r.run_id === params[0] && r.kind === params[1]);
        return { rows: row ? [row] : [] };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
    },
  };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'erix-portal-art-'));
}

test('extractTarGzEntry：与 runner writer 成对约定（短名条目可读，缺失返回 null）', () => {
  const tar = buildTar([{ name: 'manifest.json', data: '{"a":1}' }, { name: 'files/000000', data: 'zz' }]);
  const gz = zlib.gzipSync(tar);
  assert.equal(extractTarGzEntry(gz, 'manifest.json').toString(), '{"a":1}');
  assert.equal(extractTarGzEntry(gz, 'files/000000').toString(), 'zz');
  assert.equal(extractTarGzEntry(gz, 'nope'), null);
  assert.equal(extractTarGzEntry(Buffer.from('not-gzip'), 'manifest.json'), null);
});

test('putRunArtifact：落盘 + 表行（manifest 落 jsonb）+ 返回登记信息', async () => {
  const root = tmpRoot();
  const pool = makePool();
  const data = makeBundle();
  const sha = null; // 未带 header 时 portal 自算
  const res = await putRunArtifact(pool, {
    user: { id: 'u1' }, runId: RUN_ID, data, sha256: sha,
    artifactsRoot: root, maxBytes: 20 * 1024 * 1024, log: { info: () => {} },
  });
  assert.equal(res.size, data.length);
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  assert.equal(res.truncated, false);
  const file = path.join(root, `${RUN_ID}.tar.gz`);
  assert.ok(fs.existsSync(file), 'bundle 落盘持久卷');
  assert.deepEqual(fs.readFileSync(file), data, '落盘字节与上传一致');
  const row = pool.state.rows[0];
  assert.equal(row.kind, ARTIFACT_KIND);
  assert.equal(row.manifest.files.length, 1);
  assert.equal(row.manifest.run_id, RUN_ID);
  fs.rmSync(root, { recursive: true, force: true });
});

test('putRunArtifact：truncated manifest 原样落 jsonb', async () => {
  const root = tmpRoot();
  const pool = makePool();
  const res = await putRunArtifact(pool, {
    user: { id: 'u1' }, runId: RUN_ID, data: makeBundle({ truncated: true }),
    sha256: null, artifactsRoot: root, maxBytes: 20 * 1024 * 1024, log: { info: () => {} },
  });
  assert.equal(res.truncated, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('putRunArtifact：X-Sha-256 不一致 400；超上限 413；非属主 404；无 manifest 400', async () => {
  const root = tmpRoot();
  const pool = makePool();
  const data = makeBundle();
  const good = { user: { id: 'u1' }, runId: RUN_ID, data, sha256: null, artifactsRoot: root, maxBytes: 100, log: { info: () => {} } };
  // sha 不一致
  await assert.rejects(() => putRunArtifact(pool, { ...good, maxBytes: 20 * 1024 * 1024, sha256: 'f'.repeat(64) }),
    (e) => e.status === 400 && e.code === 'sha256_mismatch');
  // 超上限（maxBytes=100 < bundle 体积）
  await assert.rejects(() => putRunArtifact(pool, good), (e) => e.status === 413 && e.code === 'artifact_too_large');
  // 非属主
  await assert.rejects(() => putRunArtifact(pool, { ...good, maxBytes: 20 * 1024 * 1024, user: { id: 'u2' } }),
    (e) => e.status === 404 && e.code === 'run_not_found');
  // 无 manifest.json
  const bad = zlib.gzipSync(buildTar([{ name: 'diff.patch', data: 'x' }]));
  await assert.rejects(() => putRunArtifact(pool, { ...good, data: bad, maxBytes: 20 * 1024 * 1024 }),
    (e) => e.status === 400 && e.code === 'invalid_artifact');
  fs.rmSync(root, { recursive: true, force: true });
});

test('putRunArtifact：同 run 重复上传 409 artifact_exists，且不覆盖已落盘产物', async () => {
  const root = tmpRoot();
  const pool = makePool();
  const opts = { user: { id: 'u1' }, runId: RUN_ID, sha256: null, artifactsRoot: root, maxBytes: 20 * 1024 * 1024, log: { info: () => {} } };
  const first = await putRunArtifact(pool, { ...opts, data: makeBundle() });
  const file = path.join(root, `${RUN_ID}.tar.gz`);
  await assert.rejects(() => putRunArtifact(pool, { ...opts, data: makeBundle({ files: [{ path: 'b.js', data: 'yyyy' }] }) }),
    (e) => e.status === 409 && e.code === 'artifact_exists');
  const onDisk = fs.readFileSync(file);
  assert.equal(onDisk.length, first.size, '既有产物字节未被覆盖');
  fs.rmSync(root, { recursive: true, force: true });
});

test('getRunArtifact：属主可取、admin 可取、非属主 404、无行 404', async () => {
  const root = tmpRoot();
  const data = makeBundle();
  const pool = makePool();
  const opts = { user: { id: 'u1' }, runId: RUN_ID, sha256: null, artifactsRoot: root, maxBytes: 20 * 1024 * 1024, log: { info: () => {} } };
  await putRunArtifact(pool, { ...opts, data });
  const base = { runId: RUN_ID, artifactsRoot: root };
  const got = await getRunArtifact(pool, { ...base, sessionUser: { id: 'u1', role: 'fde' } });
  assert.equal(got.filePath, path.join(root, `${RUN_ID}.tar.gz`));
  assert.equal(got.row.manifest.run_id, RUN_ID);
  await getRunArtifact(pool, { ...base, sessionUser: { id: 'admin1', role: 'admin' } });
  await assert.rejects(() => getRunArtifact(pool, { ...base, sessionUser: { id: 'u2', role: 'fde' } }),
    (e) => e.status === 404);
  await assert.rejects(() => getRunArtifact(makePool(), { ...base, sessionUser: { id: 'u1', role: 'fde' } }),
    (e) => e.status === 404 && e.code === 'artifact_not_found');
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// http 路由层：internal PUT（鉴权/413）+ 用户面 GET（流式/鉴权）
// ---------------------------------------------------------------------------

function makeSessionPool({ userId = 'u1', role = 'fde', ownerId = 'u1', rows = [] } = {}) {
  const user = {
    id: userId, login: userId, display_name: userId, role, fde_name: userId,
    auth_source: 'local', status: 'active',
    session_id: 'sess-1', expires_at: new Date(Date.now() + 3600e3), last_seen_at: new Date(),
  };
  const art = makePool({ ownerId, rows });
  return {
    art,
    async query(sql, params = []) {
      if (sql.includes('FROM login_sessions s') && sql.includes('JOIN users')) {
        return { rows: [user] };
      }
      if (sql.includes('FROM containers c') && sql.includes('JOIN users u')) {
        const c = params[0] === hashToken('tok')
          ? { id: 'c1', user_id: ownerId, revoked_at: null, container_status: 'running', fde_name: 'fde1', container_name: 'fde1', token_generation: 1 }
          : null;
        const u = c && { login: 'fde1', status: 'active' };
        return { rows: c ? [{ ...c, login: u.login, user_status: u.status }] : [] };
      }
      return art.query(sql, params);
    },
  };
}

async function startHttp({ pool, maxBytes = 20 * 1024 * 1024 } = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-art-static-'));
  const artifactsRoot = tmpRoot();
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800, sessionRenewIntervalSeconds: 3600, pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 15 * 60e3, blockMs: 60e3, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 5, windowMs: 15 * 60e3, blockMs: 60e3, perTokenMaxFailures: 5, maxEntries: 10000 },
    kdfConcurrency: 2, kdfQueueLimit: 100, kdfQueueTimeoutMs: 30000,
    maxBodyBytes: 64 * 1024, maxLoginLength: 128, maxPasswordLength: 256,
    staticDir, artifactsRoot, artifactMaxBytes: maxBytes,
  };
  const server = createServer({ pool, config, log: { info: () => {}, warn: () => {}, error: () => {} } });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    artifactsRoot,
    close: async () => { server.close(); fs.rmSync(staticDir, { recursive: true, force: true }); fs.rmSync(artifactsRoot, { recursive: true, force: true }); },
  };
}

const sessionCookie = 'fde_session_dev=test-session';

test('PUT /api/internal/runs/:id/artifact：Bearer 鉴权 + 落盘 + 表行；坏 token 401；超限 413', async () => {
  const pool = makeSessionPool();
  const { base, artifactsRoot, close } = await startHttp({ pool });
  try {
    const data = makeBundle();
    // 坏 token → 401
    const bad = await fetch(`${base}/api/internal/runs/${RUN_ID}/artifact`, {
      method: 'PUT', headers: { Authorization: 'Bearer nope' }, body: data,
    });
    assert.equal(bad.status, 401);
    // 正常上传 → 200
    const ok = await fetch(`${base}/api/internal/runs/${RUN_ID}/artifact`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/gzip' },
      body: data,
    });
    if (ok.status !== 200) assert.fail(`unexpected ${ok.status}: ${await ok.text()}`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.size, data.length);
    assert.ok(fs.existsSync(path.join(artifactsRoot, `${RUN_ID}.tar.gz`)));
    assert.equal(pool.art.state.rows.length, 1);
    // 重复上传 → 409
    const dup = await fetch(`${base}/api/internal/runs/${RUN_ID}/artifact`, {
      method: 'PUT', headers: { Authorization: 'Bearer tok' }, body: data,
    });
    assert.equal(dup.status, 409);
  } finally {
    await close();
  }
});

test('PUT /api/internal/runs/:id/artifact：Content-Length 超限提前 413', async () => {
  const pool = makeSessionPool();
  const { base, close } = await startHttp({ pool, maxBytes: 100 });
  try {
    const res = await fetch(`${base}/api/internal/runs/${RUN_ID}/artifact`, {
      method: 'PUT', headers: { Authorization: 'Bearer tok' }, body: makeBundle(),
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error.code, 'payload_too_large');
  } finally {
    await close();
  }
});

test('GET /api/runs/:id/artifact：属主流式取回 tar.gz；非属主 404；admin 可取；未登录 401', async () => {
  // 预置一行 + 落盘文件
  const root = tmpRoot();
  const data = makeBundle();
  fs.writeFileSync(path.join(root, `${RUN_ID}.tar.gz`), data);
  const seedRows = [{
    id: 'art-1', run_id: RUN_ID, kind: ARTIFACT_KIND, path: path.join(root, `${RUN_ID}.tar.gz`),
    size: data.length, sha: 's', manifest: { run_id: RUN_ID, truncated: false }, owner_id: 'u1', created_at: new Date(),
  }];
  const pool = makeSessionPool({ ownerId: 'u1', rows: seedRows });
  const { base, close } = await startHttp({ pool });
  try {
    // 属主
    const ok = await fetch(`${base}/api/runs/${RUN_ID}/artifact`, { headers: { cookie: sessionCookie } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'application/gzip');
    assert.equal(Number(ok.headers.get('content-length')), data.length);
    assert.match(ok.headers.get('content-disposition'), /attachment/);
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), data, '流式字节与落盘一致');
    // 非属主 → 404（不泄露存在性）
    const pool2 = makeSessionPool({ userId: 'u2', ownerId: 'u1', rows: seedRows });
    const srv2 = await startHttp({ pool: pool2 });
    const deny = await fetch(`${srv2.base}/api/runs/${RUN_ID}/artifact`, { headers: { cookie: sessionCookie } });
    assert.equal(deny.status, 404);
    await srv2.close();
    // admin → 200
    const pool3 = makeSessionPool({ userId: 'adm', role: 'admin', ownerId: 'u1', rows: seedRows });
    const srv3 = await startHttp({ pool: pool3 });
    const adm = await fetch(`${srv3.base}/api/runs/${RUN_ID}/artifact`, { headers: { cookie: sessionCookie } });
    assert.equal(adm.status, 200);
    await srv3.close();
    // 未登录 → 401
    const anon = await fetch(`${base}/api/runs/${RUN_ID}/artifact`);
    assert.equal(anon.status, 401);
  } finally {
    await close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
