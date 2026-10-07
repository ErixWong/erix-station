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
    // 评审 B：单标签首段大写——docker 视其为 namespace（须小写），不得借 host 解释放行
    `FOO/bar@sha256:${HEX64}`,
    `Foo/bar@sha256:${HEX64}`,
    // 评审 B 第四轮：host 分支缺外层分组导致「合法 host + :数字 + 非法尾缀」被拆成 port+path 放行
    `registry.example.com:5000x/fde@sha256:${HEX64}`,
    `gcr.io:5000v2/fde@sha256:${HEX64}`,
    `localhost:5000x/fde@sha256:${HEX64}`,
    `192.168.1.1:5000x/fde@sha256:${HEX64}`,
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
    // 单标签 host + 端口（含 `:` → docker 视为 registry；评审 B 实测的 false-reject 回归）
    `registry:5000/fde@sha256:${HEX64}`,
    `192.168.1.1:5000/fde@sha256:${HEX64}`,
    `myhost:5000/fde@sha256:${HEX64}`,
    `harbor:5000/ns/fde@sha256:${HEX64}`,
    `Localhost:5000/fde@sha256:${HEX64}`,
    `fde@sha256:${HEX64}`,
    `sha256:${HEX64}`,
    // docker 允许 `__` / 多个 `-` 作名称段分隔符（评审 B info：旧模式会误拒，fail-closed 但口径不符）
    `foo__bar@sha256:${HEX64}`,
    `foo--bar@sha256:${HEX64}`,
    `foo.bar@sha256:${HEX64}`,
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

// ---------------------------------------------------------------------------
// issue #114：ERIX_SESSION_AUTO_TITLE 默认翻转为关（默认标题改由首条消息截断 + 手工/AI 改名承担）
// ---------------------------------------------------------------------------

test('issue #114：sessionAutoTitle 默认关；仅显式 ERIX_SESSION_AUTO_TITLE=1 开回 #88 行为', () => {
  const base = { ...DEV, FDE_IMAGE: 'traefik/whoami' };
  assert.equal(loadConfig(base).sessionAutoTitle, false, '缺省 → 关（#114 修订）');
  assert.equal(loadConfig({ ...base, ERIX_SESSION_AUTO_TITLE: '0' }).sessionAutoTitle, false);
  assert.equal(loadConfig({ ...base, ERIX_SESSION_AUTO_TITLE: '1' }).sessionAutoTitle, true, '显式 1 → 开');
  assert.equal(loadConfig({ ...base, ERIX_SESSION_AUTO_TITLE: 'yes' }).sessionAutoTitle, false, '非 1 值不视为开');
  assert.equal(loadConfig(base).sessionAutoTitleMinNew, 3, '防抖阈值缺省不变');
});

test('issue #117 phase 1：gateway 配置默认 self，并从环境读取 admin API 和 master key', () => {
  const base = { ...DEV, FDE_IMAGE: 'traefik/whoami' };
  const defaults = loadConfig(base);
  assert.equal(defaults.llmGatewayMode, 'self');
  assert.equal(defaults.llmGatewayUrl, 'http://127.0.0.1:4100');
  assert.equal(defaults.llmGatewayAdminUrl, 'http://station-litellm:4000');
  assert.equal(defaults.llmGatewayMasterKey, '');

  const configured = loadConfig({
    ...base,
    LLM_GATEWAY_MODE: 'external',
    LLM_GATEWAY_HOST: 'https://gateway.example.test',
    LLM_GATEWAY_ADMIN_URL: 'https://gateway.example.test',
    LLM_GATEWAY_MASTER_KEY: 'sk-test-only',
  });
  assert.equal(configured.llmGatewayMode, 'external');
  assert.equal(configured.llmGatewayUrl, 'https://gateway.example.test');
  assert.equal(configured.llmGatewayAdminUrl, 'https://gateway.example.test');
  assert.equal(configured.llmGatewayMasterKey, 'sk-test-only');
});

test('issue #110：workspace retention 默认 0（永不自动清理），正数显式开启且拒绝负数', () => {
  const base = { ...DEV, FDE_IMAGE: 'traefik/whoami' };
  assert.equal(loadConfig(base).workspaceRetentionDays, 0);
  assert.equal(loadConfig({ ...base, ERIX_WORKSPACE_RETENTION_DAYS: '0' }).workspaceRetentionDays, 0);
  assert.equal(loadConfig({ ...base, ERIX_WORKSPACE_RETENTION_DAYS: '14' }).workspaceRetentionDays, 14);
  assert.equal(loadConfig({ ...base, ERIX_WORKSPACE_RETENTION_DAYS: '-1' }).workspaceRetentionDays, 0);
});

test('issue #117 phase 1：拒绝未知 gateway mode', () => {
  assert.throws(
    () => loadConfig({ ...DEV, FDE_IMAGE: 'traefik/whoami', LLM_GATEWAY_MODE: 'proxy' }),
    /LLM_GATEWAY_MODE/,
  );
});

test('PORTAL_INTERNAL_HOSTS：缺省为空，逗号分隔值 trim 并过滤空项', () => {
  const base = { ...DEV, FDE_IMAGE: 'traefik/whoami' };
  assert.deepEqual(loadConfig(base).portalInternalHosts, []);
  assert.deepEqual(
    loadConfig({
      ...base,
      PORTAL_INTERNAL_HOSTS: ' 100.100.0.3, , internal.example.test ,, ',
    }).portalInternalHosts,
    ['100.100.0.3', 'internal.example.test'],
  );
});
