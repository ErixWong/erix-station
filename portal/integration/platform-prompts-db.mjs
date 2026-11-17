// 真库集成腿（issue #596 片 A 返修 / 契约 §8 第 12 行 `P12`、评审 F1 + F2 + F4 + F5 的「不许冻人」）：
// 把 `platform-prompts.js` 的 `SAVE_SQL` 放到**真实 Postgres** 上跑一遍。
// 不参与 `npm test`（与 `db-integration.mjs` 同族：要真库，docker-free 的主套件里不该出现）。
//
// 运行（`TEST_DATABASE_URL` 必须指向**专用临时库** —— 见下面「自清理」那一节）：
//   docker run -d --name p596-itest-pg -e POSTGRES_USER=station -e POSTGRES_PASSWORD=station \
//     -e POSTGRES_DB=station_test -p 127.0.0.1:55432:5432 postgres:16
//   TEST_DATABASE_URL=postgres://station:station@127.0.0.1:55432/station_test \
//     npm run test:integration:prompts
//
// 为什么必须有这一腿 —— 假池证不了的两件事，都在这里证：
//   ① **`FOR UPDATE` 真的挡得住另一个并发保存**：假池里那把"锁"是我们自己写的 `if`；真库里它得是
//      PG 的元组锁。这里用 `pg_stat_activity` 直接**看见**第二条卡在锁上（看不见就判红，不含糊）。
//   ② **SQL 里那段渲染算术真的与 JS 同数**：`gate` 那个 CTE 用 `octet_length` / `convert_to(… 'UTF8')`
//      / `sha256()`，假池跑的是 JS 的等价实现，判据 `P6b` 也只比 JS 两侧。中文、emoji、`''` 这些差别
//      必须在 PG 的表达式上出结果才算数 ⇒ 这里逐组对账。
//
// 反向自证（评审要求，两种口径都有）：
//   · 常驻一腿 `P12d-db`：把种行 `DELETE` 掉 ⇒ 同样的交错必须**真的**丢更新（不需要人工配合）。
//   · 一次性开关 `P596_SKIP_SEED_ROW=1`：临时库回到 0040 **没种首行**的那个形态（等价于把迁移里
//     那句 INSERT 去掉），此时 `P12a-db` / `P12b-db` 必须自己变红 —— 用来自证那两格的绿是种行给的。
//
// ⚠ **凡「故意开着事务模拟竞态」的腿都自带硬超时**（`LOCK_WAIT_MS` / `LEG_GUARD_MS`）：到点自己
//   `pg_terminate_backend` 把两条后端杀掉并**让那一腿判失败**。上一单就是被这种形状冻了 5 分钟
//   （A 持锁不提交、B 卡在锁上，两边都在等同伴先动），所以这里不许依赖「有人进容器杀进程」。
//
// 自清理 / 反复可跑：自己的临时 schema（`p596_prompts_itest`），每条腿开头重建、`test.after` 删掉；
//   每条腿开头还会先杀掉**本库里**卡着事务的残留后端（上一条腿被硬超时杀剩的、或上一轮人跑挂的）。
//   ⚠ 正因为会杀「本库其他后端」，`TEST_DATABASE_URL` 只许指向专用临时库，不许指向任何有别人的库。
//   不碰 public 里那套真表（`SAVE_SQL` 用非限定表名 ⇒ 靠 search_path 落到临时表，同名表被遮蔽）。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db.js';
import {
  SAVE_SQL, updatePlatformPrompts, AGENTS_MD_INJECT_MAX_BYTES, ADDENDUM_MAX_BYTES,
  AUDIT_ACTION, AUDIT_TARGET,
} from '../src/platform-prompts.js';
import {
  agentsMdGateRenderBudget, agentsMdRenderedBytes, agentsMdGateFdeName, AGENTS_MD_SECTION_SEPARATOR,
} from '../src/materializer.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL 未设置。先起一个临时 postgres:16 并导出该变量（口径同 db-integration.mjs）。');
}

/** 反向自证开关：不种首行 ⇒ 回到 0040 加种行**之前**的形态（`P12a-db`/`P12b-db` 必须红）。 */
const SKIP_SEED_ROW = process.env.P596_SKIP_SEED_ROW === '1';

const SCHEMA = 'p596_prompts_itest';
const ACTOR = 'a1111111-1111-4111-8111-111111111111';
const FDE_IDS = ['00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000f2'];

/**
 * 两根超时（都可 env 覆盖，默认值就是给"冻住"这件事定的量级，不是给 DB 定的）：
 *   · `LOCK_WAIT_MS`（默认 3000）：等「B 真的卡在 Lock 上」这件事出现的时间预算。
 *     到点没看见 ⇒ **判这一腿红**（不是重试、不是继续等 —— 看不见就等于核心事实没被证明）。
 *   · `LEG_GUARD_MS`（默认 5000）：**整条交错腿**的硬超时。到点 ⇒ 自己 `pg_terminate_backend`
 *     杀掉这两条后端并判红。它挡的是「两条互相等」这种谁都动不了的形状 —— 那种情况下
 *     上面那个观察循环也醒不过来（它等的正是 B 动起来），只能靠外部一刀。
 */
const LOCK_WAIT_MS = Number(process.env.P596_LOCK_WAIT_MS || 3_000);
const LEG_GUARD_MS = Number(process.env.P596_LEG_GUARD_MS || 5_000);

/** ≥2：并发腿要**两条各自一条连接**（挤在同一根连接上就不叫并发，锁也观察不到）。 */
const pool = createPool(DATABASE_URL, { max: 6 });

const sha = (text) => crypto.createHash('sha256')
  .update(Buffer.from(String(text), 'utf8')).digest('hex');
const bytes = (text) => Buffer.byteLength(String(text ?? ''), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class LegTimeout extends Error {}

/** 本条腿开过的 backend pid（硬超时要知道该杀谁）。 */
function pidBag() {
  const pids = new Set();
  return {
    add: (pid) => pid && pids.add(Number(pid)),
    list: () => [...pids],
  };
}

/** 用**另一条**连接杀后端（不能用正要被杀的那条）。杀不成的（已经退了 / 权限）一律忽略。 */
async function terminateBackends(pids) {
  const killed = [];
  for (const pid of pids) {
    try {
      const r = await pool.query('SELECT pg_terminate_backend($1) AS ok', [pid]);
      if (r.rows?.[0]?.ok) killed.push(pid);
    } catch {
      // 杀不动就算了：这一腿的判定不依赖"杀成功"，只依赖"不再挂着别人"。
    }
  }
  return killed;
}

/**
 * 给「故意开着事务」那段套硬超时。超时 ⇒ 先杀后端再判红（**顺序不能反**：先 assert 就没人收尾了）。
 * 返回被杀掉的 pid 列表（正常收尾时是空数组）。
 */
async function withLegGuard(label, bag, body) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new LegTimeout()), LEG_GUARD_MS);
  });
  try {
    return await Promise.race([body(), guard]);
  } catch (err) {
    if (err instanceof LegTimeout) {
      const killed = await terminateBackends(bag.list());
      assert.fail(`${label}：这段故意持锁的交会在 ${LEG_GUARD_MS}ms 内没走完（谁都没动 = 上一单冻住 5 分钟`
        + ' 的那个形状）⇒ 判失败，已自动 pg_terminate_backend 收尾 '
        + `${JSON.stringify(killed)}（不想等人进容器杀进程）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 建一张最小的 `platform_prompts` + `audit_log`（+ 入队面那三张）：形状照迁移 0042 与 0026/0036，
 * 只留这条语句用得上的东西（整库迁移不是这一腿的职责，那是 `db-integration.mjs`）。
 * ⚠ 种首行必须在这里也有：它正是被验那件事的前提（没有它，①的结论只能解释成"锁不住才正常"）。
 */
async function freshSchema() {
  // 先清掉**本库里**卡着事务的残留后端（上一轮硬超时杀剩的 / 人工跑挂的），否则下面的
  // `DROP SCHEMA … CASCADE` 会排在别人那把 ACCESS EXCLUSIVE 后面排队 —— 那又是一次冻人。
  await terminateStrayBackends();
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await c.query(`CREATE SCHEMA ${SCHEMA}`);
    await c.query(`CREATE TABLE ${SCHEMA}.platform_prompts (
  id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  agents_md_addendum text NOT NULL DEFAULT '',
  agents_md_override text NOT NULL DEFAULT '',
  title_prompt       text NOT NULL DEFAULT '',
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid
)`);
    if (!SKIP_SEED_ROW) {
      await c.query(`INSERT INTO ${SCHEMA}.platform_prompts (id) VALUES (1)
        ON CONFLICT (id) DO NOTHING`);
    }
    await c.query(`CREATE TABLE ${SCHEMA}.audit_log (
  id         bigserial PRIMARY KEY,
  actor_id   uuid,
  action     text NOT NULL,
  target     text,
  details    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)`);
    // 入队面（`enqueueMaterializeForAllFdes` → `outbox.js`）：两台启用中的工位，好让 op 也能在真库上点名。
    await c.query(`CREATE TABLE ${SCHEMA}.users (id uuid PRIMARY KEY, fde_name text, status text)`);
    for (const id of FDE_IDS) {
      await c.query(`INSERT INTO ${SCHEMA}.users (id, fde_name, status) VALUES ($1, $2, 'active')`,
        [id, `fde-${id.slice(-2)}`]);
    }
    await c.query(`CREATE TABLE ${SCHEMA}.materialize_revisions (
  fde_id uuid PRIMARY KEY, revision bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
)`);
    await c.query(`CREATE TABLE ${SCHEMA}.materialize_outbox (
  id bigserial PRIMARY KEY, fde_id uuid, op text, revision bigint, payload jsonb, state text
)`);
  } finally {
    c.release();
  }
}

/** 杀掉**本库**里卡着事务的其他后端（不碰 `pg_backend_pid()` 自己；口径见文件头的「自清理」）。 */
async function terminateStrayBackends() {
  try {
    const { rows } = await pool.query(`
      SELECT pid, pg_terminate_backend(pid) AS ok
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND state IN ('idle in transaction', 'idle in transaction (aborted)')`);
    return rows.filter((r) => r.ok).map((r) => Number(r.pid));
  } catch {
    return [];                       // 看不到 pg_stat_activity ⇒ 交给下面的硬超时兜底
  }
}

/**
 * 一条绑到临时 schema 的连接。`SAVE_SQL` 用的是**非限定**表名 ⇒ 全靠 search_path 落到这里。
 * 顺手记下 backend pid（①那条判据要拿它去 `pg_stat_activity` 里认人，硬超时也要杀它），
 * 并在归还前清掉 search_path（池化连接上裸 `SET` 会漏给下一个使用者）。
 */
async function schemaClient(bag = null) {
  const client = await pool.connect();
  const originalRelease = client.release.bind(client);
  await client.query(`SET search_path TO ${SCHEMA}, public`);
  const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
  client.backendPid = Number(rows[0].pid);
  bag?.add(client.backendPid);
  client.release = async () => {
    await client.query('RESET search_path').catch(() => {});
    await originalRelease();
  };
  return client;
}

/** 还连接，但不让"回滚"这一步把脚本挂住（后端可能已经被杀，`ROLLBACK` 就永远不返回）。 */
async function releaseQuietly(client) {
  if (!client) return;
  try {
    await Promise.race([client.query('ROLLBACK'), sleep(300)]);
  } catch { /* 连接可能已经断了 */ }
  try {
    await client.release();
  } catch { /* 池已经关了 */ }
}

/** `SAVE_SQL` 的参数：`$4/$5/$6` 必须是**最坏情况**那份预算（评审 F2）。 */
function gateParams(column, text) {
  const b = agentsMdGateRenderBudget();
  return [column, text, ACTOR, b.templateBytes, b.addendumOverheadBytes, b.identityTailBytes,
    AGENTS_MD_INJECT_MAX_BYTES, AUDIT_ACTION, AUDIT_TARGET];
}

/** 自己拿一条连接跑一次保存（并发用例要的就是"两条各自一条连接"）。 */
async function saveOnce(column, text) {
  const client = await schemaClient();
  try {
    const r = await client.query(SAVE_SQL, gateParams(column, text));
    return r.rows[0];
  } finally {
    await client.release();
  }
}

const readRow = async () => (await pool.query(
  `SELECT agents_md_addendum, agents_md_override, title_prompt, updated_by
     FROM ${SCHEMA}.platform_prompts WHERE id = 1`,
)).rows[0];

const auditRows = async () => (await pool.query(
  `SELECT action, target, details FROM ${SCHEMA}.audit_log ORDER BY id`,
)).rows;

async function waitingOnLock(pid) {
  const { rows } = await pool.query(
    'SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1', [pid]);
  if (rows.length === 0) return null;             // 看不到这条后端（权限）⇒ 由调用方判红
  return rows[0].wait_event_type === 'Lock';
}

async function waitUntilWaitingOnLock(pid, { timeoutMs = LOCK_WAIT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await waitingOnLock(pid)) return true;
    if (Date.now() > deadline) return false;
    await sleep(20);
  }
}

/**
 * 交错跑两条保存：**A 开事务写第一格并持锁不提交**，B 另起一条连接写第二格（必须卡在锁上），
 * **确认看见了**才提交 A、等 B、提交 B。返回 `{ rowA, rowB, sawWait }`。
 *
 * 两个顺序都是刻意的，写反一个就把这一腿变成自证：
 *   1. `COMMIT A` 必须在 `await bRun` **前面**。反过来（上一单的形状）就是「B 等 A 提交，
 *      而脚本等 B 返回」——脚本自己造的死锁，与产品无关，但它会把整台机器冻住 5 分钟。
 *   2. 但 `COMMIT A` 又必须在「看见 B 真的在等」**之后**。反过来（本文件实测过的另一个红）就是
 *      把交错抹平：A 先提交 ⇒ B 的快照拿到的已经是 A 提交后那份 ⇒「无种行会丢更新」那一档
 *      退化成假绿（实测：`'A：本该活下来' !== ''`）。
 *   ⇒ `sawWait` 是**前置事实**：有种行时它证「真锁真等待」，无种行时它证「交错真的发生了」。
 *
 * 同一套持法给出两个**相反**的结果（这正是反向自证要的口径，也是「别用同一种持法证两件事」
 * 的正解：持法相同、要证的两件事靠**结果**区分，不靠 wait_event 的名字）：
 *   · 有种行（`P12a`/`P12b`）：B 等的是 `snap … FOR UPDATE` 那把**行锁**；放行后它重读到 A 刚
 *     提交那份（READ COMMITTED 下 `FOR UPDATE` 醒来取更新后的版本）⇒ **不丢**。
 *   · 无种行（`P12d`）：空表里 `FOR UPDATE` 锁不到任何东西 ⇒ B 等的是**唯一索引的插入仲裁**，
 *     而它的 `snap` CTE **早就算完了（空）** ⇒ 放行后 `DO UPDATE` 用的 `EXCLUDED` 仍是 stale
 *     ⇒ 整行覆盖 ⇒ **丢更新**。
 *   两种等待在 `pg_stat_activity` 里**同名**（`Lock`/`transactionid`）⇒ 分不出来，所以判据
 *   全部打在**结果**上（丢没丢），`wait_event` 只当「确实在等」的证据。
 */
async function interleavedSave({ firstColumn, firstText, secondColumn, secondText, label }) {
  const bag = pidBag();
  let a = null;
  let b = null;
  try {
    return await withLegGuard(label, bag, async () => {
      a = await schemaClient(bag);
      b = await schemaClient(bag);
      await a.query('BEGIN');
      const ra = await a.query(SAVE_SQL, gateParams(firstColumn, firstText));
      assert.equal(Number(ra.rows[0].written), 1, 'A 这一笔必须已经写进去（否则 B 等的就不是它）');
      await b.query('BEGIN');
      const bRun = b.query(SAVE_SQL, gateParams(secondColumn, secondText));
      bRun.catch(() => {});                        // B 被硬超时杀掉时会 reject ⇒ 别变成未处理拒绝
      const sawWait = await waitUntilWaitingOnLock(b.backendPid);
      await a.query('COMMIT');                     // ★ 先放行，再等 B（顺序反了就是自己造死锁）
      const rb = await bRun;
      await b.query('COMMIT');
      return { rowA: ra.rows[0], rowB: rb.rows[0], sawWait };
    });
  } finally {
    await releaseQuietly(a);
    await releaseQuietly(b);
  }
}

// ---------------------------------------------------------------------------
// 0) 环境自证：这个库能不能看见 `pg_stat_activity`（看不见 ⇒ ①那条判据只能假绿）
// ---------------------------------------------------------------------------

test('P0-db：TEST_DATABASE_URL 连得上、能看见自己的 backend 与 pg_stat_activity（看不见就判红）',
  async () => {
    const client = await schemaClient();
    try {
      assert.ok(client.backendPid > 0, 'pg_backend_pid() 应当给出一个正整数 pid');
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1', [client.backendPid]);
      assert.equal(rows[0].n, 1,
        'pg_stat_activity 里看不见自己的后端 ⇒ `P12a-db`/`P12b-db` 的「B 卡在 Lock 上」永远观察不到'
        + '（要超级用户或 pg_read_all_stats 的角色）');
    } finally {
      await client.release();
    }
  });

// ---------------------------------------------------------------------------
// 1) SQL 侧那段渲染算术在真库里逐组对账（判据 `P6b` 的 SQL 那半边）+ 超限一格不写
// ---------------------------------------------------------------------------

test('P6b-db：gate 那段算术在真 PG 上与 agentsMdRenderedBytes 逐组同数；超限那档 written=0、审计 0 行、一格没写',
  async () => {
    await freshSchema();
    const budget = agentsMdGateRenderBudget();
    // 先钉送参那份标识行确实是最坏情况那份（否则这一腿是在拿预览口径验闸）。
    assert.equal(budget.identityTailBytes,
      bytes(AGENTS_MD_SECTION_SEPARATOR) + bytes(`（FDE 标识：${agentsMdGateFdeName()}）`) + 1,
      '$6 必须等于「分隔 + 最长合法工位名的标识行 + 末尾换行」');

    const cases = [
      ['', ''],
      ['短', ''],
      ['x'.repeat(8000), ''],
      ['', '# 覆写'],
      ['', 'O'.repeat(1000)],
      ['追加', '覆写'],
      ['\n\n', '\n'],
      ['中文与 emoji 🚀 的字节数不是字符数', ''],
      ['x'.repeat(ADDENDUM_MAX_BYTES), ''],
    ];
    let fits = 0;            // 写成功的那几档（下面逐组数出来的，不在末尾再算一遍）
    for (const [addendum, override] of cases) {
      // 先把库里那一格摆成这一组的样子，再跑一次「写入同样的值」的保存 ⇒ 期望值就是这一组本身。
      await pool.query(
        `UPDATE ${SCHEMA}.platform_prompts SET agents_md_addendum = $1, agents_md_override = $2`,
        [addendum, override]);
      const column = override === '' ? 'agents_md_addendum' : 'agents_md_override';
      const text = override === '' ? addendum : override;
      const got = await saveOnce(column, text);
      const expect = agentsMdRenderedBytes(budget, { addendum, override });
      const label = `addendum=${bytes(addendum)}B override=${bytes(override)}B`;
      assert.equal(Number(got.rendered_bytes), expect, `${label}：PG 算出来的必须与 JS 同数`);
      if (expect <= AGENTS_MD_INJECT_MAX_BYTES) {
        fits += 1;
        assert.equal(Number(got.written), 1, `${label}：线内必须写`);
        assert.equal(Number(got.audit_rows), 1, `${label}：写了就必须有恰好一条审计`);
      } else {
        // ★ 超限这一档：靠 SQL 闸自己拦（这里没有 JS 预闸，也没有回滚兜着）。
        assert.equal(Number(got.written), 0, `${label}：超限 ⇒ 喂给 INSERT 的 SELECT 出 0 行`);
        assert.equal(Number(got.audit_rows), 0, `${label}：超限 ⇒ 审计也是 0 行（同生共死）`);
        const row = await readRow();
        assert.equal(row.agents_md_addendum, addendum, `${label}：一格没写（追加段仍是原值）`);
        assert.equal(row.agents_md_override, override, `${label}：一格没写（覆写仍是原值）`);
      }
    }
    // 整段跑完：审计条数 = 写成功的那几档条数（超限的一档都不该在里面）。
    assert.equal((await auditRows()).length, fits, '审计只由写成功的那些笔产生');
  });

// ---------------------------------------------------------------------------
// 2) 产品入口那一腿：一次保存 = 一行设置 + 恰好一条审计 + op=upsert（真库上的 `P8` / `P10`）
// ---------------------------------------------------------------------------

test('P8-db：走 updatePlatformPrompts 保存一次 ⇒ 设置一行更新、audit_log 恰好一行、outbox 的 op 是 upsert',
  async () => {
    await freshSchema();
    const client = await schemaClient();
    try {
      const saved = await updatePlatformPrompts({
        pool: client, field: 'addendum', text: '收工前跑 npm test。', actorId: ACTOR,
      });
      assert.ok(saved.renderedBytes > 0, '渲染后的字节数出自 SQL（不是 JS 猜的）');
      assert.equal(saved.prompts.addendum.text, '收工前跑 npm test。', '响应出自 RETURNING（库里那份）');
      assert.equal(saved.materializeEnqueued, FDE_IDS.length, '两台启用中的工位 ⇒ 真库里也入队两条');
      const row = await readRow();
      assert.equal(row.agents_md_addendum, '收工前跑 npm test。');
      assert.equal(row.updated_by, ACTOR);
      const audits = await auditRows();
      assert.equal(audits.length, 1, '每次保存恰好一条审计（不多写、不漏写）');
      assert.equal(audits[0].action, AUDIT_ACTION);
      assert.equal(audits[0].target, AUDIT_TARGET);
      assert.deepEqual(Object.keys(audits[0].details).sort(),
        ['field', 'previous_bytes', 'previous_sha256', 'text_bytes', 'text_sha256'], '审计只存摘要不存正文');
      assert.equal(audits[0].details.text_sha256, sha('收工前跑 npm test。'),
        'encode(sha256(convert_to(…))) 与 JS 的 sha256 同数');
      assert.equal(audits[0].details.previous_sha256, sha(''), '种下来的那一行就是「之前没人配过」');
      const out = await pool.query(
        `SELECT op, payload, state FROM ${SCHEMA}.materialize_outbox ORDER BY id`);
      assert.deepEqual(out.rows.map((r) => r.op), ['upsert', 'upsert'], 'op 在真库里也是字面量 upsert');
      assert.deepEqual(out.rows.map((r) => r.state), ['pending', 'pending'],
        'state=pending（循环可消费）');
      assert.deepEqual(out.rows.map((r) => r.payload), [{}, {}], 'payload 空对象（latest-wins，不带正文）');
    } finally {
      await client.release();
    }
  });

// ---------------------------------------------------------------------------
// 3) 真并发（`P12`）：`FOR UPDATE` 挡得住人 ⇒ 无丢更新、previous_* 是紧邻前值
// ---------------------------------------------------------------------------

test('P12a-db：同字段真并发 ⇒ B 的 prev_text 是 A 刚写的那份（不是空串），库里也没有丢更新', async () => {
  await freshSchema();
  const { rowB, sawWait } = await interleavedSave({
    label: 'P12a-db（同字段交错）',
    firstColumn: 'title_prompt', firstText: '第一版提示词',
    secondColumn: 'title_prompt', secondText: '第二版提示词',
  });
  assert.ok(sawWait,
    `B 没卡在锁上（${LOCK_WAIT_MS}ms 内 pg_stat_activity 里看不到 Lock）⇒ 这一腿的核心「真锁真等待」`
    + '没被证明（种行没生效、或该角色看不见 pg_stat_activity）');
  assert.equal(Number(rowB.written), 1, 'B 也写成了（等锁不是失败）');
  assert.equal(rowB.prev_text, '第一版提示词', '★ B 的旧值必须是 A 刚提交那份（`FOR UPDATE` 的全部意义）');
  assert.notEqual(rowB.prev_text, '', '空串就意味着 A 那一笔被丢了');
  assert.equal((await readRow()).title_prompt, '第二版提示词', '最后一笔赢，而不是赢在空串上');
  const audits = await auditRows();
  assert.equal(audits.length, 2, '两次保存两条审计');
  assert.equal(audits[1].details.previous_sha256, sha('第一版提示词'), '审计里也是紧邻前值');
  assert.equal(audits[1].details.previous_bytes, bytes('第一版提示词'));
});

test('P12b-db：跨字段真并发 ⇒ 两格都在，先写那一格没被整行覆盖刷成空', async () => {
  await freshSchema();
  const { rowB, sawWait } = await interleavedSave({
    label: 'P12b-db（跨字段交错）',
    firstColumn: 'agents_md_addendum', firstText: 'A：平台补充约定',
    secondColumn: 'agents_md_override', secondText: 'B：整段覆写文',
  });
  assert.ok(sawWait, 'B 没卡在锁上 ⇒ 「锁挡住了别人」这件事没被观察到（同 `P12a-db`）');
  assert.equal(Number(rowB.written), 1);
  const row = await readRow();
  assert.equal(row.agents_md_addendum, 'A：平台补充约定', '★ 后一条不得把别人那一格刷掉');
  assert.equal(row.agents_md_override, 'B：整段覆写文');
  assert.equal((await auditRows()).length, 2);
});

test('P12c-db：两条 Promise.all 直接赛跑（同一格 / 两格各一组）⇒ 谁都不许丢，审计条数 = 保存条数',
  async () => {
    // 这一组不带显式事务（就是产品路径的形状：一条语句 = 一个隐式事务），纯靠那条语句里的锁。
    // 也不持锁 ⇒ 不需要硬超时（谁都动得了），但仍值得跑：它证的是**产品代码在自动提交下不丢更新**。
    await freshSchema();
    const texts = ['并发甲', '并发乙'];
    await Promise.all(texts.map((text) => saveOnce('title_prompt', text)));
    const same = await readRow();
    assert.ok(texts.includes(same.title_prompt), '同一格：两笔里必须留下一笔，不能是空串');
    const sameAudits = await auditRows();
    assert.equal(sameAudits.length, 2, '两条保存 = 两条审计');
    // 锁把两条排成先后 ⇒ 后落笔那条的 previous_* 必然指向先落笔那条（这一条与谁先谁后无关）。
    assert.equal(sameAudits[0].details.previous_sha256, sha(''), '先落笔那条：之前没人配过');
    assert.equal(sameAudits[1].details.previous_sha256, sameAudits[0].details.text_sha256,
      '★ 后落笔那条的 previous_* 必须是前一条的指纹（并发下审计仍然可信）');

    await freshSchema();
    await Promise.all([saveOnce('agents_md_addendum', '甲段'), saveOnce('title_prompt', '乙提示')]);
    const both = await readRow();
    assert.equal(both.agents_md_addendum, '甲段', '跨字段：两格都必须在');
    assert.equal(both.title_prompt, '乙提示');
    assert.equal((await auditRows()).length, 2);
  });

// ---------------------------------------------------------------------------
// 4) 反向自证：把首行删掉（= 未种行的旧形态）⇒ 同样的交错必须**真的**丢更新
// ---------------------------------------------------------------------------

test('P12d-db：删掉种行后同样的交错真的丢更新 ⇒ 上面那些绿是种行给的，不是运气', async () => {
  await freshSchema();
  await pool.query(`DELETE FROM ${SCHEMA}.platform_prompts`);   // 回到 0040 加种行之前的形态
  // 与 `P12b-db` **逐字同参**（同一套持法、同一个交错），差别只在「表里没有那一行」。
  const { rowB, sawWait } = await interleavedSave({
    label: 'P12d-db（无种行的交错）',
    firstColumn: 'agents_md_addendum', firstText: 'A：本该活下来',
    secondColumn: 'agents_md_override', secondText: 'B：整段覆写',
  });
  // ★ 前提：交错真的发生了。无种行时 B 等的不是我们那把行锁（空表里无行可锁）而是唯一索引的
  //   插入仲裁，但它确实卡住了 ⇒ 它的 `snap` 已经算完（空）⇒ 下面那个 stale 覆盖才成立。
  //   没等到就提交 A = 把交错抹平，那一档会退化成「什么都没丢」的假绿（本文件实测过）。
  assert.ok(sawWait,
    `B 没卡在锁上（${LOCK_WAIT_MS}ms 内 pg_stat_activity 里看不到 Lock）⇒ 本腿没造出交错，`
    + '什么也推不了（无种行时它等的是唯一索引的插入仲裁，照样算 Lock）');
  assert.equal(Number(rowB.written), 1, '两条都"成功"了 —— 丢更新最难受的形状就是没人报错');
  assert.equal(rowB.prev_text, '', 'B 的旧值是空串：它压根没看见 A');
  const row = await readRow();
  assert.equal(row.agents_md_addendum, '', '★ A 那一格被刷回空 = 丢更新（评审 F1 说的那个洞，真库里存在）');
  assert.equal(row.agents_md_override, 'B：整段覆写');
  const audits = await auditRows();
  assert.equal(audits.length, 2, '审计两条都在，其中一条在撒谎');
  assert.equal(audits[1].details.previous_sha256, sha(''), '那条审计的 previous_sha256 就是空串的指纹');
});

test.after(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  await terminateStrayBackends().catch(() => {});
  await pool.end().catch(() => {});
});
