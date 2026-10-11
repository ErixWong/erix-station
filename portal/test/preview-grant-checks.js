// `preview_grants` 的 baseline CHECK 在内存 fake 里的等价模拟（issue #252 的回归保护）。
//
// 为什么单独立一个文件：#252 那个 500（`preview_grants_check3`）能在单测全绿的情况下活到真机，
// 根因就是两侧 fake（`preview-ports.test.js` / `offboarding.test.js`）**只模拟了
// `revoked ⇔ revoked_at`**，从未模拟 `(state = 'used') = (used_at IS NOT NULL)` ——
// 「把已消费的 ticket 一并撤掉」这种写法在单测里**结构上不可能**被发现。
// 两个 fake 现在共用这里的规则，避免「一边补了、另一边还是摆设」。
//
// 事实来源：`docs/data/schema.sql` §4 `CREATE TABLE preview_grants`（**冻结 baseline，一字节不改**）。
// CHECK 的 constraint 名按 PG 规则 = 表名 + `_check` / `_check1` …（按 CREATE TABLE 里出现顺序），
// 所以这里的名字与真机报错（`preview_grants_check3`）逐字对齐——测试失败时能直接对上日志。
import assert from 'node:assert/strict';

export const PREVIEW_GRANT_STATES = ['active', 'used', 'revoked', 'expired'];
export const PREVIEW_GRANT_KINDS = ['ticket', 'session'];

/** 与 baseline 逐条同序、同名。`ok(row)` 返回 false 即真库会抛 23514。 */
export const PREVIEW_GRANT_CHECKS = [
  {
    name: 'preview_grants_check',
    label: "kind <> 'session' OR used_at IS NULL",
    ok: (row) => row.kind !== 'session' || row.used_at == null,
  },
  {
    name: 'preview_grants_check1',
    label: "kind <> 'ticket' OR issuer_id IS NOT NULL",
    ok: (row) => row.kind !== 'ticket' || row.issuer_id != null,
  },
  {
    name: 'preview_grants_check2',
    label: "(kind = 'session') = (parent_ticket_id IS NOT NULL)",
    ok: (row) => (row.kind === 'session') === (row.parent_ticket_id != null),
  },
  {
    name: 'preview_grants_check3',
    label: "(state = 'used') = (used_at IS NOT NULL)",
    ok: (row) => (row.state === 'used') === (row.used_at != null),
  },
  {
    name: 'preview_grants_check4',
    label: "(state = 'revoked') = (revoked_at IS NOT NULL)",
    ok: (row) => (row.state === 'revoked') === (row.revoked_at != null),
  },
];

/** 第一个被违反的 CHECK；全部满足则 null。值域（state/kind 的 IN 列表）也算 CHECK。 */
export function previewGrantCheckViolation(row) {
  if (!PREVIEW_GRANT_STATES.includes(row.state)) {
    return { name: 'preview_grants_state_check', label: `state IN (${PREVIEW_GRANT_STATES.map((s) => `'${s}'`).join(', ')})` };
  }
  if (!PREVIEW_GRANT_KINDS.includes(row.kind)) {
    return { name: 'preview_grants_kind_check', label: `kind IN (${PREVIEW_GRANT_KINDS.map((k) => `'${k}'`).join(', ')})` };
  }
  return PREVIEW_GRANT_CHECKS.find((check) => !check.ok(row)) ?? null;
}

/** 种子补齐 + baseline CHECK 自证（见 `./preview-grant-checks.js`）。 */
export function seedPreviewGrant(grant, { subject = 'u-alice', issuer = 'u-alice' } = {}) {
  const kind = grant.kind ?? 'ticket';
  const row = {
    user_id: subject,
    issuer_id: kind === 'session' ? null : issuer,
    parent_ticket_id: null,
    state: 'active',
    used_at: null,
    revoked_at: null,
    expires_at: '2099-01-01T00:00:00.000Z',
    ...grant,
    kind,
  };
  assertPreviewGrantRows([row], 'fake 种子');
  return row;
}

/** 与真库同形的 23514（`err.code` + 原文案），让调用方的错误处理走同一条路径。 */
export function previewGrantCheckError(row, violation) {
  const err = new Error(
    `new row for relation "preview_grants" violates check constraint "${violation.name}"`
    + ` [行 id=${row.id ?? '?'} state=${row.state} used_at=${row.used_at ? '非空' : 'NULL'} revoked_at=${row.revoked_at ? '非空' : 'NULL'}]`,
  );
  err.code = '23514';
  return err;
}

/** 逐行校验（写入口 / 种子数据都要过——种子本身不合 CHECK，测试就是在测一个真库不存在的状态）。 */
export function assertPreviewGrantRows(rows, where = 'fake 种子') {
  for (const row of rows) {
    const violation = previewGrantCheckViolation(row);
    if (violation) {
      assert.fail(`${where}里的 preview_grants 行本身就违反 baseline CHECK ${violation.name}`
        + `（${violation.label}）：${JSON.stringify(row)}`);
    }
  }
}

/**
 * 从撤权 SQL 里解析被撤的 state 集合（fake 必须**按 SQL 说的做**，不能自己另写一套谓词）。
 * 支持 `state = 'active'` 与 `state IN ('active', 'used')` 两种写法。
 */
export function revokeStatePredicate(sql) {
  const inList = sql.match(/state\s+IN\s*\(([^)]*)\)/i);
  if (inList) return [...inList[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  const eq = sql.match(/state\s*=\s*'([a-z]+)'/gi);
  const states = (eq ?? [])
    .map((clause) => clause.match(/'([a-z]+)'/i)[1])
    .filter((state) => state !== 'revoked');      // `SET state = 'revoked'` 不是谓词
  if (states.length === 0) {
    assert.fail(`fake 解析不出撤权谓词（SQL 形如：${sql.slice(0, 120)}）——fake 与实现的口径会静默漂移`);
  }
  return states;
}

/**
 * 执行一条「撤 preview_grants」的 UPDATE：`SET state='revoked', revoked_at=COALESCE(revoked_at, now())`
 * `WHERE allocation_id = ANY($1::uuid[]) AND <state 谓词>`。
 *
 * 语义与真库对齐：
 *   - 先算**全部**命中行的新值并逐条过 baseline CHECK，任何一条违反 ⇒ **整条语句**抛 23514、
 *     一行都不改（PG 的语句级原子性；调用方随后 ROLLBACK）。这就是「撤 used ticket 必红」的机关。
 *   - 通过才落盘（`revoked_at` 用 COALESCE 语义：不覆盖既有值）。
 *
 * @returns {{rows: Array<{id: string}>, rowCount: number}} RETURNING id 的结果
 */
export function applyRevokeGrantsSql({ sql, grants, allocationIds, now = () => new Date().toISOString() }) {
  assert.match(sql, /revoked_at = COALESCE\(revoked_at, now\(\)\)/, '撤 grant 必须写 revoked_at（CHECK revoked ⇔ revoked_at）');
  assert.doesNotMatch(sql, /used_at\s*=\s*NULL/i, '撤 grant 不得清空 used_at：那是篡改历史（#252 第 1 条口径）');
  const states = revokeStatePredicate(sql);
  const matched = grants.filter((grant) => allocationIds.includes(grant.allocation_id) && states.includes(grant.state));
  const proposed = matched.map((grant) => ({ ...grant, state: 'revoked', revoked_at: grant.revoked_at ?? now() }));
  for (const [index, row] of proposed.entries()) {
    const violation = previewGrantCheckViolation(row);
    if (violation) throw previewGrantCheckError(matched[index], violation);   // 语句级失败：零行改动
  }
  for (const [index, grant] of matched.entries()) {
    grant.state = proposed[index].state;
    grant.revoked_at = proposed[index].revoked_at;
  }
  return { rows: matched.map((grant) => ({ id: grant.id })), rowCount: matched.length };
}
