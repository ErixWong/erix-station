// issue #586 判据 B：`/healthz` 与 `/api/health` 的 200 响应 additive 一块 `version`。
//
// 为什么必须有这块读数（真事故）：发 v0.1.69 时 `git pull --ff-only` 网络抖动只 fetch 没 pull，
// `docker compose build station-portal` 烘的是停在 **0.1.68** 的宿主工作树 ⇒ 真机上 FDE 报 0.1.69、
// portal 报 0.1.68，分裂一小时，而**没有任何对外读数能发现它**（portal 镜像当时没有 build-info.json，
// `ci.yml` ⑤′ 只查 FDE 镜像）。本文件钉的就是「从此 `curl /api/health` 能直接读出跑的是哪份构建」。
//
// 形状红线（与 #515 的 `partialBuffer` 同一套纪律，逐条对应下面的用例）：
//   * **additive**：既有键（`status`、`partialBuffer`）一字未动，旧客户端解析不受影响；
//   * **只有三格**：`station` / `revision` / `builtAt` —— **没有** `engine`。两个引擎数（portal 镜像里的
//     erix-agent 与每台 FDE 的 erix-agent）混进一个公开、零鉴权的端点必被读错，引擎只进管理台面板；
//   * **503 分支形状逐字不变**（readiness 链吃的是状态码 + 错误信封，`deploy-contract.md` §2.3）；
//   * **缺字段是 `unknown` 不是 `undefined`**：`JSON.stringify` 会把 `undefined` 整个键丢掉，
//     于是「没读到」与「没有这个字段」在响应里无法区分——而 `unknown` 是显式的「不知道」。
//
// 隔离（docs/testing.md §2.1）：注入内存 fake pool + 临时 static 目录；`partialOutputs` 单例前后清空。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as migrate from '../src/migrate.js';
import { partialOutputs } from '../src/run-partial-buffer.js';
import { healthVersionBlock, readStationVersion, BUILD_INFO_PATH, PACKAGE_DIR } from '../src/version-info.js';
import { UNKNOWN } from '../src/build-info.js';
import { FakePool } from './fake-pool.js';

/** 把 `deploy/migrations` 的全部版本号当成「已应用」⇒ `/healthz` 走 200 分支（真判据，不 stub 布尔）。 */
class ReadyPool extends FakePool {
  constructor({ migrationsDir = migrate.defaultMigrationsDir(), ready = true } = {}) {
    super();
    this.versions = ready ? migrate.computeExpectedVersions(migrationsDir) : [];
  }

  async query(sql, params = []) {
    if (String(sql).includes('FROM schema_migrations')) {
      return { rows: this.versions.map((version) => ({ version })) };
    }
    return super.query(sql, params);
  }
}

async function startServer(pool = new ReadyPool()) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-586-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800, sessionRenewIntervalSeconds: 3600, pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 5, maxEntries: 100 },
    kdfConcurrency: 2, kdfQueueLimit: 10, kdfQueueTimeoutMs: 5000,
    maxLoginLength: 128, maxPasswordLength: 256, staticDir,
  };
  const server = createServer({ pool, config });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      await new Promise((res) => server.close(res));
      fs.rmSync(staticDir, { recursive: true, force: true });
    },
  };
}

/** 在临时目录里放一份「与仓库 `package.json` 不同版本」的 build-info，返回路径（判据 D-1 的注入点）。 */
function injectBuildInfo(values) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-586-bi-'));
  const file = path.join(dir, 'build-info.json');
  fs.writeFileSync(file, JSON.stringify(values));
  return file;
}

/** 跑一段「env 被改过」的代码，结束后原样恢复（同文件里多条用例共用进程 env）。 */
function withEnv(patch, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return (async () => {
    try {
      return await fn();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  })();
}

// ─────────────────────────────────────────────────────────────────────────────
// 形状：additive，且只有三格
// ─────────────────────────────────────────────────────────────────────────────
test('#586B：`/api/health` 的 200 多一块 `version{station,revision,builtAt}`，既有键一个没动', async () => {
  partialOutputs.clear();
  const s = await startServer();
  try {
    const body = await (await fetch(`${s.base}/api/health`)).json();
    assert.equal(body.status, 'ok', '`status` 的语义一字未动（就绪判据还是它）');
    assert.ok(body.partialBuffer, '`partialBuffer`（#515）还在，没被本单的块挤掉');
    assert.deepEqual(Object.keys(body.partialBuffer).sort(), ['entries', 'evictedActive', 'maxEntries'],
      '旧客户端读的那三键形状与本单无关（additive：本单一个字没改）');
    assert.deepEqual(Object.keys(body.version).sort(), ['builtAt', 'revision', 'station'],
      `恰好三格，多一格少一格都算改坏形状：${JSON.stringify(body.version)}`);
    assert.ok(!('engine' in body.version) && !('engineVersion' in body.version) && !('agentVersion' in body.version),
      '不带引擎版本：portal 侧引擎与每台 FDE 的引擎是两个数，混进公开端点会被读错（判据 B 的硬口径）');
    assert.ok(Object.values(body.version).every((v) => typeof v === 'string' && v !== ''),
      `三格全是非空字符串（缺值也得是 "unknown"）：${JSON.stringify(body.version)}`);
  } finally {
    partialOutputs.clear();
    await s.close();
  }
});

test('#586B：`/healthz` 与 `/api/health` 是同一条 handler ⇒ 逐字节同一份 body（两条路径不许长成两个样子）', async () => {
  partialOutputs.clear();
  const s = await startServer();
  try {
    const a = await (await fetch(`${s.base}/healthz`)).json();
    const b = await (await fetch(`${s.base}/api/health`)).json();
    assert.deepEqual(a, b);
    assert.deepEqual(a.version, b.version);
  } finally {
    partialOutputs.clear();
    await s.close();
  }
});

test('#586B：旧客户端不受影响 —— 只看 `status` 与健康检查那条链的行为一个字没变', async () => {
  partialOutputs.clear();
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/healthz`);
    assert.equal(res.status, 200, '容器健康检查判的是 `res.ok`（`cli.js#healthcheck` 不解析 body）');
    const body = await res.json();
    assert.equal(body.status, 'ok');
    const post = await fetch(`${s.base}/healthz`, { method: 'POST' });
    assert.equal(post.status, 405, '非 GET 的 405 口径不变（不新增错误码）');
  } finally {
    partialOutputs.clear();
    await s.close();
  }
});

test('#586B：503 分支的形状逐字不变（未就绪时不带 `version`，也不带 `partialBuffer`）', async () => {
  const s = await startServer(new ReadyPool({ ready: false }));
  try {
    const res = await fetch(`${s.base}/api/health`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(),
      { error: { code: 'migration_failed', message: 'not ready', retryable: false } },
      '503 的错误信封逐字不变：readiness 链（deploy-contract §8）吃的是状态码与信封，本单只动 200 分支');
  } finally {
    await s.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 缺读数时的表现：`unknown` 而不是 `undefined`
// ─────────────────────────────────────────────────────────────────────────────
test('#586B：镜像里没有 build-info（本地源码态）⇒ 缺的格是 `unknown`，不是 `undefined`、不是空串', async () => {
  const missing = path.join(os.tmpdir(), `station-586-none-${process.pid}.json`);
  const v = readStationVersion({ env: {}, buildInfoPath: missing, packageDir: PACKAGE_DIR });
  assert.equal(v.revision, UNKNOWN, 'revision 只有构建期 ARG 能给 ⇒ 没有 build-info 时**必须**是 unknown');
  assert.equal(v.builtAt, UNKNOWN, 'built_at 同上（不许拿 commit 时间或 now() 冒充构建时间）');
  assert.equal(v.source, 'package', 'dev 源码态退到仓库根 package.json（这就是 BUILD_INFO_PATH 在本地不存在时的正确表现）');
  const block = healthVersionBlock(() => v);
  assert.deepEqual(Object.keys(block).sort(), ['builtAt', 'revision', 'station']);
  assert.ok(Object.values(block).every((x) => typeof x === 'string' && x.length > 0),
    `JSON.stringify 会把 undefined 的键整个丢掉 ⇒ 三格必须都在且非空：${JSON.stringify(block)}`);
});

test('#586B：读数面坏掉也不把 readiness 端点打挂（注入一个抛异常的 reader ⇒ 三格 unknown，200 照旧）', () => {
  assert.deepEqual(healthVersionBlock(() => { throw new Error('读版本的链路炸了'); }),
    { station: UNKNOWN, revision: UNKNOWN, builtAt: UNKNOWN },
    '观测面不承重（#515 同口径）：一个附加块不该让 readiness 链翻成 500');
  assert.deepEqual(healthVersionBlock(() => null),
    { station: UNKNOWN, revision: UNKNOWN, builtAt: UNKNOWN }, 'reader 返回空 ⇒ 三格 unknown');
  assert.deepEqual(healthVersionBlock(() => ({ station: 42, revision: '  ', builtAt: undefined })),
    { station: UNKNOWN, revision: UNKNOWN, builtAt: UNKNOWN },
    '脏形状（数字 / 空白串 / undefined）一律退化到 unknown，**不**做 String() 硬转（那会把脏值伪装成版本）');
});

test('#586B：注入一份 build-info ⇒ 端点显示的就是它（读的是文件，不是代码里的常量）', async () => {
  partialOutputs.clear();
  const file = injectBuildInfo({
    station_version: '9.9.9-injected', engine_version: '0.99.9-injected',
    revision: 'a'.repeat(40), built_at: '2026-11-16T00:00:00Z',
  });
  await withEnv({ STATION_BUILD_INFO_PATH: file }, async () => {
    const s = await startServer();
    try {
      const body = await (await fetch(`${s.base}/api/health`)).json();
      assert.equal(body.version.station, '9.9.9-injected', '健康端点的 station 来自 build-info.json');
      assert.equal(body.version.revision, 'a'.repeat(40));
      assert.equal(body.version.builtAt, '2026-11-16T00:00:00Z');
      assert.ok(!JSON.stringify(body.version).includes('0.99.9-injected'),
        '注入的引擎版本不许从后门漏进健康端点（只有三格）');
    } finally {
      await s.close();
    }
  });
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  partialOutputs.clear();
});

test('#586B：默认路径与 dev 退路落点是钉死的常量（镜像布局变了就要回来改，别让它悄悄漂）', () => {
  assert.equal(BUILD_INFO_PATH, '/app/build-info.json',
    '与 portal/Dockerfile 末尾烘的位置必须同一个路径（`version-surface.test.js` 里两侧对拍）');
  assert.equal(PACKAGE_DIR, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    'dev 退路 = `portal/src` 的上两级 = 仓库根（镜像内同一形状 = `/app`）');
});
