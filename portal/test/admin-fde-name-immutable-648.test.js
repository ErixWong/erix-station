// issue #648 A：**工位（seat）实体化后 `fde_name` 不可改**（契约 docs/api/portal.md §`PATCH /api/admin/users/:id`）。
//
// 取证（见工单 #648）：改名端点确实存在——`updateUser` 的 PATCH 面（`http.js:2250` → `admin.js:521`）
// 只改 `users.fde_name` **一列**。但这个名字同时是物理工位的身份：`containers.fde_name`（schema.sql:148
// 冗余列）、`containers.container_name = fde-<name>`、`fde_networks.network_name = fde-<name>`、
// 家目录 `userSpaceRoot/<fde_name>`、以及 docker 容器/网络本体——全钉在旧名上。要诚实连带就得改
// docker + 文件系统，那是 runner/deploy 的范畴（本单红线），portal 事务里带不走 ⇒ 对**已实体化**的
// 工位拒绝改名（`409 fde_name_immutable`）；未实体化（无容器/无网络）时名字还没绑到任何物理资源 ⇒
// 允许，`fde_name_conflict` 查重路径不变。
//
// 隔离约定（docs/testing.md §2.1）：注入 fake pool，零真 DB、零容器。判据与 UPDATE **同一条 SQL**，
// fake 的红线：谓词在 SQL 里才判（与 admin-last-admin-648.test.js 的 `last_admin_guard` 同口径）——
// 实现被删 ⇒ SQL 里没那段谓词 ⇒ fake 老实把 UPDATE 落下 ⇒ 用例会红，不会被 fake 好心兜成假绿。
import test from 'node:test';
import assert from 'node:assert/strict';

import { AdminError, updateUser } from '../src/admin.js';
import { FakePool } from './fake-pool.js';

const ALICE = {
  id: '648a0000-0000-4000-8000-0000000000a1', login: 'alice', display_name: 'Alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
  file_upload_enabled: false,
};
const OTHER = {
  id: '648a0000-0000-4000-8000-0000000000b1', login: 'bob', display_name: 'Bob',
  role: 'fde', fde_name: 'bob', auth_source: 'local', status: 'active',
  file_upload_enabled: false,
};

/** UPDATE 里工位存在性谓词的指纹（`updateUser` 那段 WHERE）。fake 与用例都只认这些字面量。 */
const SEAT_MARK = 'FROM containers WHERE user_id = users.id';

class SeatPool extends FakePool {
  constructor(users, { containers = [], networks = [], offboardings = [] } = {}) {
    super({ users: users.map((u) => ({ ...u })) });
    this.containers = containers;   // [{user_id}]
    this.networks = networks;       // [{fde_id}]
    this.offboardings = offboardings; // [{fde_id}]
  }

  hasSeat(id) {
    return this.containers.some((c) => c.user_id === id)
      || this.networks.some((n) => n.fde_id === id);
  }

  async query(sql, params = []) {
    const text = String(sql);
    this.statements.push({ sql: text, params });

    // updateUser 的前置读（既有产品 SQL）。
    if (/SELECT id, login, fde_name FROM users WHERE id/.test(text)) {
      const u = this.users.find((x) => x.id === params[0]);
      return { rows: u ? [{ id: u.id, login: u.login, fde_name: u.fde_name ?? null }] : [] };
    }

    // 改名的查重（既有产品 SQL，先于 UPDATE）。
    if (/SELECT 1 FROM users WHERE fde_name = \$1 AND id <> \$2/.test(text)) {
      const dup = this.users.some((u) => u.fde_name === params[0] && u.id !== params[1]);
      return { rows: dup ? [{ '?column?': 1 }] : [] };
    }

    // 下线护栏的回查（status=active 或改 fde_name 时才有）。
    if (/FROM fde_offboarding WHERE fde_id = \$1/.test(text)) {
      return { rows: this.offboardings.some((o) => o.fde_id === params[0]) ? [{ '?column?': 1 }] : [] };
    }

    // #648 A：改名一格未命中后的**选错误码**回查（工位是否已实体化）。
    if (/SELECT 1 AS hit FROM containers WHERE user_id = \$1/.test(text)) {
      return { rows: this.hasSeat(params[0]) ? [{ hit: 1 }] : [] };
    }

    if (/WITH updated AS/.test(text) && /UPDATE users SET/.test(text)) {
      const user = this.users.find((u) => u.id === params[0]);
      if (!user) return { rows: [] };
      if (/NOT EXISTS \(SELECT 1 FROM fde_offboarding/.test(text)
        && this.offboardings.some((o) => o.fde_id === user.id)) {
        return { rows: [] };
      }
      // #648 A 的工位护栏：**按 SQL 说的做** —— 谓词在 SQL 里才判它。
      if (text.includes(SEAT_MARK) && this.hasSeat(user.id)) return { rows: [] };
      const field = (name) => {
        const m = new RegExp(`${name} = \\$([0-9]+)`).exec(text);
        return m ? params[Number(m[1]) - 1] : undefined;
      };
      for (const name of ['display_name', 'email', 'role', 'fde_name', 'file_upload_enabled',
        'mail_otp_enabled', 'totp_login_enabled', 'locale']) {
        const value = field(name);
        if (value !== undefined) user[name] = value;
      }
      return {
        rows: [{
          id: user.id, login: user.login, display_name: user.display_name,
          role: user.role, fde_name: user.fde_name ?? null,
          auth_source: user.auth_source, status: user.status,
          created_at: user.created_at ?? new Date(), last_activity_at: user.last_activity_at ?? null,
          locale: user.locale ?? null, totp_enabled: false, last_login_at: null,
        }],
      };
    }

    return super.query(sql, params);
  }
}

test('#648-A1 有容器的工位改名 ⇒ 409 fde_name_immutable（旧名一格都没改）', async () => {
  const pool = new SeatPool([ALICE], { containers: [{ user_id: ALICE.id }] });
  await assert.rejects(
    () => updateUser(pool, ALICE.id, { fde_name: 'alice-2' }, { actorId: ALICE.id }),
    (err) => {
      assert.ok(err instanceof AdminError);
      assert.equal(err.code, 'fde_name_immutable');
      assert.equal(err.httpStatus, 409);
      assert.equal(err.details.field, 'fde_name');
      assert.match(err.message, /工位名不可改，需新建/);
      return true;
    },
  );
  assert.equal(pool.users.find((u) => u.id === ALICE.id).fde_name, 'alice');
});

test('#648-A2 只有网络（容器尚未建）也算实体化 ⇒ 同样 409 fde_name_immutable', async () => {
  const pool = new SeatPool([ALICE], { networks: [{ fde_id: ALICE.id }] });
  await assert.rejects(
    () => updateUser(pool, ALICE.id, { fde_name: 'alice-2' }, { actorId: ALICE.id }),
    (err) => err.code === 'fde_name_immutable',
  );
  assert.equal(pool.users.find((u) => u.id === ALICE.id).fde_name, 'alice');
});

test('#648-A3 未实体化（无容器/无网络）⇒ 允许改名，users.fde_name 落库', async () => {
  const pool = new SeatPool([ALICE]);
  const r = await updateUser(pool, ALICE.id, { fde_name: 'alice-2' }, { actorId: ALICE.id });
  assert.equal(r.user.fde_name, 'alice-2');
  assert.equal(pool.users.find((u) => u.id === ALICE.id).fde_name, 'alice-2');
});

test('#648-A4 重名查重先于工位护栏：改成别人的名字 ⇒ 仍 409 fde_name_conflict（不是 immutable）', async () => {
  // alice 有容器（护栏会成立），但目标名 'bob' 已被 bob 占用 ⇒ 查重这一关先报，语义更具体。
  const pool = new SeatPool([ALICE, OTHER], { containers: [{ user_id: ALICE.id }] });
  await assert.rejects(
    () => updateUser(pool, ALICE.id, { fde_name: 'bob' }, { actorId: ALICE.id }),
    (err) => {
      assert.equal(err.code, 'fde_name_conflict');
      assert.equal(err.httpStatus, 409);
      return true;
    },
  );
  assert.equal(pool.users.find((u) => u.id === ALICE.id).fde_name, 'alice');
});

test('#648-A5 工位护栏与 UPDATE 同一条 SQL（先查后改的写法会在这里红）', async () => {
  const pool = new SeatPool([ALICE], { containers: [{ user_id: ALICE.id }] });
  await assert.rejects(
    () => updateUser(pool, ALICE.id, { fde_name: 'alice-2' }, { actorId: ALICE.id }),
    (err) => err.code === 'fde_name_immutable',
  );
  const stmts = pool.statements.map((x) => x.sql);
  const updateAt = stmts.findIndex((sql) => /WITH updated AS/.test(sql) && /UPDATE users SET/.test(sql));
  assert.ok(updateAt >= 0, '没找到那条 UPDATE');
  const updateSql = stmts[updateAt];
  // ① 容器 + 网络两段存在性谓词都必须在那条 UPDATE 自己的 WHERE 里（同语句 ⇒ 判定与写入共用一个快照）
  assert.match(updateSql, /WHERE id = \$1[\s\S]*FROM containers WHERE user_id = users\.id[\s\S]*FROM fde_networks WHERE fde_id = users\.id/);
  // ② 它之前不许出现「先查一遍工位是否存在」的语句（先查后改 = 并发下双双通过）
  const before = stmts.slice(0, updateAt);
  for (const sql of before) {
    assert.doesNotMatch(sql, /FROM containers WHERE user_id = \$1/, '工位护栏被拆成了先查后改（容器）');
    assert.doesNotMatch(sql, /FROM fde_networks WHERE fde_id = \$1/, '工位护栏被拆成了先查后改（网络）');
  }
});
