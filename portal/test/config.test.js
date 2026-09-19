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

test('F12 prod（审计 #34 F-D）：lax-accept 收紧——伪 sha256: 尾缀不得通过', () => {
  const bad = [
    `evil-sha256:${HEX64}`,          // 无 @，前缀是任意串
    `repo@evilsha256:${HEX64}`,      // @ 前缀不是 sha256:
    `sha256:${HEX64}x`,              // 结尾多余字符
    `@sha256:${HEX64}`,              // 空引用
    `-bad/name@sha256:${HEX64}`,     // 引用不合法的起始字符
    `erix-station/fde:1.0 @sha256:${HEX64}`, // 引用含空格
    // 评审 A：仅字符集校验会放行的 malformed（docker reference 语法违规）
    `repo//foo@sha256:${HEX64}`,     // 空 path 段
    `repo/:@sha256:${HEX64}`,        // 空 path 段 + 空 tag
    `repo:tag:extra@sha256:${HEX64}`,// tag 中出现第二个冒号
    `repo/FOO@sha256:${HEX64}`,      // path 段大写（repository 必须小写）
    `repo./x@sha256:${HEX64}`,       // path 段以分隔符结尾
  ];
  for (const img of bad) {
    assert.throws(() => loadConfig({ ...PROD, FDE_IMAGE: img }), /image@sha256/, `应拒绝：${img}`);
  }
});

test('F12 prod（审计 #34 F-D）：合法引用形态不误伤（registry/tag/path）', () => {
  const good = [
    `erix-station/fde:1.0.0-abc@sha256:${HEX64}`,
    `localhost:5000/fde@sha256:${HEX64}`,
    `registry.example.com:8443/ns/sub/fde:v2@sha256:${HEX64}`,
    `fde@sha256:${HEX64}`,
    `sha256:${HEX64}`,
  ];
  for (const img of good) {
    assert.equal(loadConfig({ ...PROD, FDE_IMAGE: img }).fdeImage, img, `应放行：${img}`);
  }
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
