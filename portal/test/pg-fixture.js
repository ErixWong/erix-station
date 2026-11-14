// issue #502 F-1：**真库测试夹具的唯一实现**（此前 `portal/test/delta-not-persisted-db.test.js`
// 与 `portal/test/migrate-fresh-db.test.js` 各带一份复制版，两份都在同一台注入实例上跑
// `bootstrap.sql` 的**集群级**角色 DDL ⇒ 并发跑会撞）。
//
// 撞的是什么（现查，不是猜）：
//   · `docs/data/bootstrap.sql:37-38` 每次 bootstrap 都发
//     `ALTER ROLE station_platform LOGIN …` / `ALTER ROLE station_portal LOGIN …`
//     —— 写的是**集群目录** `pg_authid` 的同一行；
//   · `migrate-fresh-db.test.js` 还额外发 `ALTER ROLE … PASSWORD` 与 `CREATE ROLE`（同样集群级）；
//   · 两个测试文件在 `npm test`（`node --test` 按 CPU 数并发跑文件）里**各自新建数据库**，
//     于是两条连接在**不同库里**同时改同一行集群目录 ⇒ `tuple concurrently updated`(XX000)。
//   · `portal/src/migrate.js:251` 的 `pg_advisory_lock($1)` **挡不住**：advisory lock 的作用域带
//     database OID，而这里的两个持锁者在两个**不同**的新库里 ⇒ 互相看不见。生产没这个形状
//     （生产只有一个库、一条迁移通路），所以这是**测试夹具特有的竞态**，修在夹具这一层。
//
// 锁的选择：文件锁（不是 DB 锁）。理由——要串的正是「对集群目录动 DDL」这段，锁必须**在库外**
// 才可能覆盖到「新建库之前」；Node 没有 `flock(2)` 绑定，故用 `open(..., 'wx')` 的原子创建 +
// **pid 活性探测 + mtime 兜底**做等价语义（持有者崩溃不会把后面的套件永久钉住）。
// 释放只在「锁里记的 token 还是我的」时 unlink：超时那条腿已经放手时，不能去删别人刚拿到的锁。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const LOCK_FILE = path.join(os.tmpdir(), 'station-test-bootstrap.lock');
const LOCK_TIMEOUT_MS = Number(process.env.STATION_TEST_LOCK_TIMEOUT_MS || 900_000);
const LOCK_STALE_MS = Number(process.env.STATION_TEST_LOCK_STALE_MS || 600_000);
const LOCK_RETRY_MS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } // ESRCH ⇒ 死了
};

/**
 * 拿跨进程文件锁。返回 release（幂等）。
 * 超时 ⇒ 抛错而不是无限等（宁可红一条用例，也不要让整条 `npm test` 挂死）。
 */
export async function acquireBootstrapLock({
  file = LOCK_FILE,
  timeoutMs = LOCK_TIMEOUT_MS,
  staleMs = LOCK_STALE_MS,
} = {}) {
  const token = crypto.randomBytes(8).toString('hex');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token, at: Date.now() }), { flag: 'wx' });
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        try {
          const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (cur?.token === token) fs.rmSync(file, { force: true });
        } catch { /* 锁已被别人抢走或已被清：不是我该删的那个 */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let steal = false;
      try {
        const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
        // 持有者进程已不存在（崩溃/被 kill）⇒ 立刻抢；进程还活着但超过 staleMs ⇒ 也抢
        //（活着但卡住的持锁者会把整条套件钉到超时，而它卡住本身已经是需要红一条用例的事实）。
        steal = !pidAlive(cur?.pid) || Date.now() - Number(cur?.at || 0) > staleMs;
      } catch { steal = true; } // 读不到/JSON 脏 ⇒ 当成脏锁抢
      if (steal) {
        try { fs.rmSync(file, { force: true }); } catch { /* 别人已经抢着删了 */ }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `拿不到真库夹具文件锁 ${file}（等了 ${timeoutMs}ms）：`
          + `另一个测试进程可能卡在 bootstrap/migrate 上。删掉该文件可强行放行。`,
        );
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

/**
 * 建一套「一次性夹具」：连到注入的实例上，每个用例自建新库、跑完整迁移、用完即删。
 *
 * @param {string} adminUrl 注入的 `TEST_DATABASE_URL`（超级用户）
 * @param {(ctx: {database: string, url: string, pool: object|null, dbUrl: Function, adminPool: object}) => any} fn
 * @param {{prefix?: string, migrate?: boolean, poolMax?: number, log?: Function}} [opts]
 *        `migrate: false` ⇒ 只建库不迁移（`migrate-fresh-db.test.js` 要自己控制迁移身份/多次跑）
 * @param {{prefix?: string, lockFile?: string,
 *   createDatabase?: (name: string) => Promise<unknown>,
 *   dropDatabase?: (name: string) => Promise<unknown>}} [options]
 *   后两个钩子是**审计第 8 条留的注入点**：不注入就只能靠「库名非法」这种隔山打牛的方式去测
 *   「建库失败会不会泄锁」。`lockFile` 让夹具测试用自己那个锁文件 —— 默认那个是与真库用例共用的，
 *   `npm test` 并发跑时去碰它就是自找竞态。
 */
export function createPgFixture(adminUrl, {
  prefix = 'wfx', lockFile = LOCK_FILE, createDatabase = null, dropDatabase = null,
} = {}) {
  const adminPool = adminUrl ? createPool(adminUrl, { max: 2 }) : null;
  const admin = adminUrl ? new URL(adminUrl) : null;
  const loginRole = admin ? decodeURIComponent(admin.username) : '';
  const loginPw = admin ? decodeURIComponent(admin.password || '') : '';

  /** 建库 / 删库（默认真打注入的那台实例；测试可注入一个报错的钩子）。 */
  const createDb = createDatabase ?? ((name) => adminPool.query(`CREATE DATABASE ${name}`));
  const dropDb = dropDatabase ?? ((name) => adminPool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));

  /** 在注入的实例上换库 / 换登录角色拼连接串（只碰注入的那台，§2.2.4）。 */
  function dbUrl(database, user = loginRole, pw = loginPw) {
    const u = new URL(adminUrl);
    u.username = encodeURIComponent(user);
    u.password = encodeURIComponent(pw);
    u.pathname = `/${database}`;
    return u.toString();
  }

  async function withFreshDatabase(fn, opts = {}) {
    const { migrate: runMigrate = true, poolMax = 2, log = () => {} } = opts;
    const name = `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
    // 锁覆盖「CREATE DATABASE → bootstrap/migrate → 用例体 → DROP DATABASE」整段：
    // 要串的正是集群级角色 DDL，而用例体里也可能再发（migrate-fresh 的 ALTER/CREATE ROLE）。
    //
    // ⚠ **审计第 8 条（真 bug）：锁一拿到就必须包进 `try/finally`**。原形状是
    //   `const release = await acquireBootstrapLock();`
    //   `await adminPool.query('CREATE DATABASE …');`   ← **在 try 之外**
    //   `try { … } finally { … release(); }`
    // ⇒ 建库报错（名字撞 / 实例满 / 连接掉）时 `release()` **永不执行**，锁文件留在那裡
    // 直到 stale 阈值（默认 10 分钟）才被抢 ⇒ 同一次 `npm test` 里后面那些真库用例全卡在锁上
    //（症状是「套件突然慢十分钟」而不是「一条红」，所以一直没人报）。
    // 下面把 acquire 与建库一并放进同一个 `try`，**任何异常都释放**。
    const release = await acquireBootstrapLock({ file: lockFile });
    const url = dbUrl(name);
    let pool = null;
    try {
      await createDb(name); // ← 原来这一行在 `try` **外面**（锁泄就泄在这里）
      if (runMigrate) {
        // baseline(schema.sql) → bootstrap.sql → 全部增量。
        pool = createPool(url, { max: poolMax });
        await migrate(pool, { env: { DATABASE_URL: url }, log: { log } });
      }
      return await fn({ database: name, url, pool, dbUrl, adminPool });
    } finally {
      if (pool) await pool.end().catch(() => {});
      await dropDb(name).catch(() => {});
      release();
    }
  }

  return { adminPool, adminUrl, loginRole, loginPw, dbUrl, withFreshDatabase, lockFile };
}

/** 用例侧的 env 门口径（两处共用同一句话，别再抄出第三种说法）。 */
export const SKIP_WITHOUT_PG = 'TEST_DATABASE_URL 未设置：真库用例需一次性 postgres:16（docs/testing.md §2.2.1），无 PG 时整体跳过';
