// 单测：cookie 属性随 COOKIE_PROFILE 正确切换（portal.md §2.5）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { cookieSettings } from '../src/config.js';

test('COOKIE_PROFILE=prod → __Host-fde_session + Secure', () => {
  const c = cookieSettings('prod', 604800);
  assert.equal(c.name, '__Host-fde_session');
  assert.equal(c.secure, true);
  assert.equal(c.httpOnly, true);
  assert.equal(c.sameSite, 'Lax');
  assert.equal(c.path, '/');
  assert.equal(c.maxAge, 604800);
});

test('COOKIE_PROFILE=dev-http → fde_session_dev + 无 Secure（去 __Host- 前缀）', () => {
  const c = cookieSettings('dev-http', 604800);
  assert.equal(c.name, 'fde_session_dev');
  assert.equal(c.secure, false);
  assert.ok(!c.name.startsWith('__Host-'));
  assert.equal(c.httpOnly, true);
  assert.equal(c.sameSite, 'Lax');
  assert.equal(c.path, '/');
});

test('未知 profile 回落 prod 语义', () => {
  const c = cookieSettings('nonsense', 100);
  assert.equal(c.name, '__Host-fde_session');
  assert.equal(c.secure, true);
  assert.equal(c.maxAge, 100);
});
