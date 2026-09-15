// 单测：TOTP（RFC 6238 附录 B 测试向量 + base32 + 6 位 + ±1 窗口 + 单码防重放）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Encode,
  base32Decode,
  hotp,
  totp,
  totpAtStep,
  verifyTotp,
  generateSecret,
  otpauthUri,
} from '../src/totp.js';

// RFC 6238 附录 B：SHA-1、8 位、seed = ASCII "12345678901234567890"
// base32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('base32 编码/解码 roundtrip（RFC 4648）', () => {
  const bytes = Buffer.from('12345678901234567890', 'ascii');
  assert.equal(base32Encode(bytes), RFC_SECRET_B32);
  assert.equal(base32Decode(RFC_SECRET_B32).toString('ascii'), '12345678901234567890');
  assert.equal(base32Decode('gezdgnbvgy3tqojqgezdgnbvgy3tqojq').toString('ascii'), '12345678901234567890'); // 小写
});

test('RFC 6238 附录 B 测试向量（8 位）', () => {
  const vectors = [
    [59, 0x0000000000000001, '94287082'],
    [1111111109, 0x00000000023523ec, '07081804'],
    [1111111111, 0x00000000023523ed, '14050471'],
    [1234567890, 0x000000000273ef07, '89005924'],
    [2000000000, 0x0000000003f940aa, '69279037'],
    [20000000000, 0x0000000027bc86aa, '65353130'],
  ];
  for (const [timeSec, T, expected] of vectors) {
    assert.equal(totpAtStep(RFC_SECRET_B32, T, { digits: 8 }), expected, `T=${T}`);
    assert.equal(totp(RFC_SECRET_B32, { digits: 8, time: timeSec * 1000 }), expected, `time=${timeSec}`);
  }
});

test('业务侧 6 位 / 30s / SHA-1：长度与格式', () => {
  const secret = generateSecret(20);
  const code = totp(secret);
  assert.match(code, /^\d{6}$/);
});

test('verifyTotp：±1 窗口通过，窗口外拒绝，格式非法拒绝', () => {
  const secret = generateSecret(20);
  const step = 123456789;
  const timeMs = step * 30 * 1000;
  const code = hotp(secret, step, { digits: 6 });

  assert.equal(verifyTotp(secret, code, { time: timeMs }).valid, true);
  assert.equal(verifyTotp(secret, code, { time: timeMs + 30 * 1000 }).valid, true); // 前一步
  assert.equal(verifyTotp(secret, code, { time: timeMs - 30 * 1000 }).valid, true); // 后一步
  assert.equal(verifyTotp(secret, code, { time: timeMs + 60 * 1000 }).valid, false); // 窗口外
  assert.equal(verifyTotp(secret, code, { time: timeMs - 60 * 1000 }).valid, false);
  assert.equal(verifyTotp(secret, '12345', { time: timeMs }).valid, false); // 长度不符
  assert.equal(verifyTotp(secret, 'abcdef', { time: timeMs }).valid, false); // 非数字
});

test('verifyTotp：单码防重放（lastStep 内同码拒绝）', () => {
  const secret = generateSecret(20);
  const step = 123456789;
  const code = hotp(secret, step, { digits: 6 });
  assert.equal(verifyTotp(secret, code, { time: step * 30 * 1000, lastStep: step }).valid, false);
  assert.equal(verifyTotp(secret, code, { time: step * 30 * 1000, lastStep: step }).replay, true);
  assert.equal(verifyTotp(secret, code, { time: step * 30 * 1000, lastStep: step - 1 }).valid, true);
});

test('otpauthUri：含 issuer/label/algorithm/digits/period', () => {
  const uri = otpauthUri('JBSWY3DPEHPK3PXP', { issuer: 'FDE Station', label: 'alice' });
  assert.ok(uri.startsWith('otpauth://totp/'));
  assert.ok(uri.includes('secret=JBSWY3DPEHPK3PXP'));
  assert.ok(uri.includes('issuer=FDE%20Station'));
  assert.ok(uri.includes('algorithm=SHA1'));
  assert.ok(uri.includes('digits=6'));
  assert.ok(uri.includes('period=30'));
});
