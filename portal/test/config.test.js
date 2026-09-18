// 单测：config.js F12 —— FDE_IMAGE pin 双轨（issue #27）：prod 拒绝非不可变引用（fail-closed）、
// 两形态放行（repo digest / image ID）、dev 允许 tag 仅警告。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const HEX64 = 'a'.repeat(64);
const PROD = { FDE_DEV_MODE: '0', SESSION_SIGNING_KEY: 'k'.repeat(32) };
const DEV = { FDE_DEV_MODE: '1', SESSION_SIGNING_KEY: 'dev-key' };

test('F12 prod：repo digest 形态（image@sha256:<64hex>）放行', () => {
  const cfg = loadConfig({ ...PROD, FDE_IMAGE: `erix-station/fde:1.0.0-abc@sha256:${HEX64}` });
  assert.equal(cfg.fdeImage, `erix-station/fde:1.0.0-abc@sha256:${HEX64}`);
});

test('F12 prod：image ID 形态（sha256:<64hex>，本地 build 无 RepoDigests）放行', () => {
  const cfg = loadConfig({ ...PROD, FDE_IMAGE: `sha256:${HEX64}` });
  assert.equal(cfg.fdeImage, `sha256:${HEX64}`);
});

test('F12 prod：tag 形态 fail-closed 抛错', () => {
  assert.throws(() => loadConfig({ ...PROD, FDE_IMAGE: 'erix-station/fde:1.0.0' }), /image@sha256/);
});

test('F12 prod：缺省（whoami 占位）同样 fail-closed', () => {
  assert.throws(() => loadConfig({ ...PROD }), /image@sha256/);
});

test('F12 prod：畸形串拒绝——63/65 hex、大写 hex、裸 digest 无前缀', () => {
  assert.throws(() => loadConfig({ ...PROD, FDE_IMAGE: `sha256:${'a'.repeat(63)}` }));
  assert.throws(() => loadConfig({ ...PROD, FDE_IMAGE: `sha256:${'a'.repeat(65)}` }));
  assert.throws(() => loadConfig({ ...PROD, FDE_IMAGE: `sha256:${'A'.repeat(64)}` }));
  assert.throws(() => loadConfig({ ...PROD, FDE_IMAGE: HEX64 })); // 无 sha256: 前缀
});

test('F12 dev：tag 允许（仅警告，不抛错）', () => {
  const cfg = loadConfig({ ...DEV, FDE_IMAGE: 'traefik/whoami' });
  assert.equal(cfg.fdeImage, 'traefik/whoami');
});

test('F12 dev：digest 两形态同样放行', () => {
  assert.equal(loadConfig({ ...DEV, FDE_IMAGE: `sha256:${HEX64}` }).fdeImage, `sha256:${HEX64}`);
  assert.equal(
    loadConfig({ ...DEV, FDE_IMAGE: `erix-station/fde:x@sha256:${HEX64}` }).fdeImage,
    `erix-station/fde:x@sha256:${HEX64}`,
  );
});

test('F12 prod：FDE_MEMORY_LIMIT 默认 4g（issue #27 已决），env 覆盖生效', () => {
  assert.equal(loadConfig({ ...PROD, FDE_IMAGE: `sha256:${HEX64}` }).fdeMemoryLimit, '4g');
  assert.equal(
    loadConfig({ ...PROD, FDE_IMAGE: `sha256:${HEX64}`, FDE_MEMORY_LIMIT: '0' }).fdeMemoryLimit,
    '0',
  );
});
