// portal/test/secrets.test.js —— 配置槽加解密的判据（issue #608，契约 §3.1）
//
// 三条必须是**反向**判据（实现退化时必须红）：
//   S-2 跨 FDE 搬移密文解不开（v1 设计漏了 fde_id 进 AAD，copilot 审计必修 3）
//   S-3 换条目解不开（密文被搬到别的槽位）
//   S-4 缺 key ⇒ 加解密都抛 secret_key_missing（绝不用默认 key 兜底）
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  KEY_BYTES, SecretError, aadFor, decryptValue, encryptValue, parseKey, resolveSlots,
} from '../src/secrets.js';

const KEY = Buffer.alloc(KEY_BYTES, 3);
const ITEM = '11111111-1111-1111-1111-111111111111';
const FDE_A = '22222222-2222-2222-2222-222222222222';
const FDE_B = '33333333-3333-3333-3333-333333333333';

test('S-1 往返：加密后能解回原文；两次加密的密文不同（iv 随机）', () => {
  const a = encryptValue({ itemId: ITEM, name: 'TOKEN', scope: 'global', plaintext: 's3cr3t', key: KEY });
  const b = encryptValue({ itemId: ITEM, name: 'TOKEN', scope: 'global', plaintext: 's3cr3t', key: KEY });
  assert.notEqual(a.toString('hex'), b.toString('hex'), 'iv 必须随机（否则相同明文密文相同）');
  assert.equal(decryptValue({ itemId: ITEM, name: 'TOKEN', scope: 'global', blob: a, key: KEY }), 's3cr3t');
});

test('S-2【反向】跨 FDE 搬移解不开（AAD 含 fde_id）', () => {
  const blob = encryptValue({ itemId: ITEM, name: 'TOKEN', scope: 'fde', fdeId: FDE_A, plaintext: 'x', key: KEY });
  assert.equal(decryptValue({ itemId: ITEM, name: 'TOKEN', scope: 'fde', fdeId: FDE_A, blob, key: KEY }), 'x');
  assert.throws(
    () => decryptValue({ itemId: ITEM, name: 'TOKEN', scope: 'fde', fdeId: FDE_B, blob, key: KEY }),
    (e) => e instanceof SecretError,
    '把 A 工位的密文改绑到 B 工位必须解不开',
  );
});

test('S-3【反向】换条目/换槽名解不开（密文不可搬移）', () => {
  const blob = encryptValue({ itemId: ITEM, name: 'TOKEN', scope: 'global', plaintext: 'x', key: KEY });
  assert.throws(() => decryptValue({
    itemId: '99999999-9999-9999-9999-999999999999', name: 'TOKEN', scope: 'global', blob, key: KEY,
  }), (e) => e instanceof SecretError);
  assert.throws(() => decryptValue({ itemId: ITEM, name: 'OTHER', scope: 'global', blob, key: KEY }),
    (e) => e instanceof SecretError);
});

test('S-4【反向】缺 key / 长度不对 ⇒ secret_key_missing（没有默认 key 兜底）', () => {
  assert.throws(() => parseKey(undefined), (e) => e.code === 'secret_key_missing');
  assert.throws(() => parseKey(''), (e) => e.code === 'secret_key_missing');
  assert.throws(() => parseKey(Buffer.alloc(16).toString('base64')), (e) => e.code === 'secret_key_missing');
  const blob = encryptValue({ itemId: ITEM, name: 'T', scope: 'global', plaintext: 'x', key: KEY });
  assert.throws(() => decryptValue({ itemId: ITEM, name: 'T', scope: 'global', blob, key: undefined }),
    (e) => e.code === 'secret_key_missing');
});

test('S-5 空串不许当值（删除要用 null）', () => {
  assert.throws(
    () => encryptValue({ itemId: ITEM, name: 'T', scope: 'global', plaintext: '', key: KEY }),
    (e) => e.code === 'capability_slot_invalid',
  );
});

test('S-6 aadFor 的域校验', () => {
  assert.throws(() => aadFor({ itemId: ITEM, name: 'T', scope: 'weird' }), TypeError);
  assert.throws(() => aadFor({ itemId: '', name: 'T', scope: 'global' }), TypeError);
});

test('S-7 resolveSlots：fde 覆盖 global；解不开的值进 missing（fail-closed）', async () => {
  const rowsParams = [
    { name: 'A_URL', kind: 'config', inject: 'env', required: true },
    { name: 'B_TOKEN', kind: 'secret', inject: 'env', required: true },
    { name: 'C_OPT', kind: 'config', inject: 'env', required: false },
  ];
  const goodA = encryptValue({ itemId: ITEM, name: 'A_URL', scope: 'global', plaintext: 'http://g', key: KEY });
  const fdeA = encryptValue({ itemId: ITEM, name: 'A_URL', scope: 'fde', fdeId: FDE_A, plaintext: 'http://f', key: KEY });
  const brokenB = Buffer.from('not-a-ciphertext');
  const pool = {
    async query(sql, p) {
      if (sql.includes('FROM capability_params')) return { rows: rowsParams };
      if (sql.includes('FROM capability_param_values')) {
        assert.deepEqual(p, [ITEM, FDE_A]);
        return {
          rows: [
            { name: 'A_URL', scope: 'global', fde_id: null, value_encrypted: goodA },
            { name: 'A_URL', scope: 'fde', fde_id: FDE_A, value_encrypted: fdeA },
            { name: 'B_TOKEN', scope: 'global', fde_id: null, value_encrypted: brokenB },
          ],
        };
      }
      throw new Error(`unexpected: ${sql}`);
    },
  };
  const r = await resolveSlots({ pool, itemId: ITEM, fdeId: FDE_A, key: KEY });
  assert.equal(r.values.A_URL, 'http://f', 'fde 覆盖 global');
  assert.deepEqual(r.missing, ['B_TOKEN'], '解不开的必填值必须进 missing');
  assert.equal('C_OPT' in r.values, false, '可选槽没值就不出现在 values 里');
});
