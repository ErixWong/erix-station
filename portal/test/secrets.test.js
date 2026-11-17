// portal/test/secrets.test.js —— 配置槽值的判据（issue #608，契约 §3.1）
//
// 值以**明文**存库（决策见 `deploy/migrations/0042-mcp-plaintext-values.sql` 头部）。
// 所以这里不再有加解密用例；留下的是**与加密无关、且真正挡住泄漏**的那几条：
//   S-1 空串拒（空串与「未设置」语义分不开 ⇒ 会做出「设置了但注入空值」）
//   S-2 超长拒（凭据不该有 1 KiB 以上；超了几乎必然贴错东西）
//   S-3 resolveSlots：fde 覆盖 global；缺必填进 missing；空串按「没有值」处理（fail-closed）
//   S-4【反向】`resolveSlots` 的返回值里**只有**声明过的槽（DB 里有野行也不放行）
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SecretError, normalizeValue, resolveSlots } from '../src/secrets.js';

const ITEM = '11111111-1111-1111-1111-111111111111';
const FDE_A = '22222222-2222-2222-2222-222222222222';

test('S-1【反向】空串不是「设置了值」：写入当场拒', () => {
  assert.throws(() => normalizeValue({ name: 'TOKEN', value: '' }),
    (e) => e instanceof SecretError && e.code === 'capability_slot_invalid');
  assert.throws(() => normalizeValue({ name: 'TOKEN', value: null }),
    (e) => e.code === 'capability_slot_invalid');
  assert.equal(normalizeValue({ name: 'TOKEN', value: '  padded  ' }), '  padded  ',
    '不 trim：有些 token 两端空白是真的');
});

test('S-2【反向】超过 1024 字符的值拒（凭据不该这么长）', () => {
  assert.equal(normalizeValue({ name: 'TOKEN', value: 'x'.repeat(1024) }).length, 1024);
  assert.throws(() => normalizeValue({ name: 'TOKEN', value: 'x'.repeat(1025) }),
    (e) => e.code === 'capability_slot_invalid' && e.details.length === 1025);
});

test('S-3 resolveSlots：fde 覆盖 global；缺必填进 missing；空串按没值算', async () => {
  const rowsParams = [
    { name: 'A_URL', kind: 'config', inject: 'env', required: true },
    { name: 'B_TOKEN', kind: 'secret', inject: 'env', required: true },
    { name: 'C_OPT', kind: 'config', inject: 'env', required: false },
    { name: 'D_EMPTY', kind: 'secret', inject: 'env', required: true },
  ];
  const pool = {
    async query(sql, p) {
      if (sql.includes('FROM capability_params')) return { rows: rowsParams };
      if (sql.includes('FROM capability_param_values')) {
        assert.deepEqual(p, [ITEM, FDE_A]);
        return {
          rows: [
            { name: 'A_URL', scope: 'global', fde_id: null, value_plain: 'http://g' },
            { name: 'A_URL', scope: 'fde', fde_id: FDE_A, value_plain: 'http://f' },
            { name: 'D_EMPTY', scope: 'global', fde_id: null, value_plain: '' },
          ],
        };
      }
      throw new Error(`unexpected: ${sql}`);
    },
  };
  const r = await resolveSlots({ pool, itemId: ITEM, fdeId: FDE_A });
  assert.equal(r.values.A_URL, 'http://f', 'fde 覆盖 global');
  assert.deepEqual(r.missing, ['B_TOKEN', 'D_EMPTY'], '缺行与空串都算「没有值」');
  assert.equal('C_OPT' in r.values, false, '可选槽没值就不出现在 values 里');
});

test('S-4【反向】DB 里的野行（未声明的槽名）不许进 values', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('FROM capability_params')) {
        return { rows: [{ name: 'DECLARED', kind: 'secret', inject: 'env', required: true }] };
      }
      return {
        rows: [
          { name: 'DECLARED', scope: 'global', fde_id: null, value_plain: 'v1' },
          { name: 'SMUGGLED', scope: 'global', fde_id: null, value_plain: 'v2' },
        ],
      };
    },
  };
  const r = await resolveSlots({ pool, itemId: ITEM, fdeId: null });
  assert.deepEqual(Object.keys(r.values), ['DECLARED'],
    '注入面只认**声明过的槽**：手工往库里塞一行就等于往子进程环境里塞任意变量');
});
