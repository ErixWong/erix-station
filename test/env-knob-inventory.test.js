// issue #677 第一步：清点工具的判据钉。
// 全部跑在临时目录里的**假 compose / 假 portal / 假 proxy / 假 runner** 上：
//   · 不读真实仓库文件（`buildInventory` 只吃 `--root` 指过来的假目录）；
//   · 不读真实环境变量（本文件一次都没碰 `process.env`，工具的输入只有文件文本）；
//   · teardown 里 `rmSync(..., { recursive: true })`，不留残骸。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildInventory,
  classifyComposeValue,
  parseComposeEnv,
  parseInjectedEnv,
  parseProxyAllowlist,
  scanEnvReads,
  scanChildEnvAllowlists,
  renderTable,
  renderSummary,
  stripJsComments,
} from '../scripts/env-knob-inventory.mjs';

const FIXTURE = {
  'deploy/docker-compose.yml': `
version: "3.9"
services:
  station-docker-proxy:
    environment:
      PORT: "2375"
      IMAGE_ALLOWLIST: ${'${FDE_IMAGE:?必填：'}
        scratch 写 whoami}
      ALLOWED_USERS: ${'${FDE_ALLOWED_USERS:-1001:1000}'}
  station-portal:
    environment:
      OK_KNOB: ${'${OK_KNOB:-7}'}
      NO_ALLOW_KNOB: ${'${NO_ALLOW_KNOB:-1}'}
      DEAD_FIBER_KNOB: ${'${DEAD_FIBER_KNOB:-0}'}
      EMPTY_DEFAULT_KNOB: ${'${EMPTY_DEFAULT_KNOB:-}'}
      DEV_USER_KNOB: ${'${DEV_USER_KNOB-1001:1000}'}
      LITERAL_KNOB: "42"
      DATABASE_URL: postgres://u:p@db:5432/x
      # 注释里写 OK_KNOB 不算 compose 里写了它
  station-litellm:
    environment:
      HOME: /home/worker
volumes: {}
`,
  'portal/src/provisioner.js': `
export function buildContainerConfig({ env = process.env } = {}) {
  return {
    Env: [
      \`OK_KNOB=\${Number(process.env.OK_KNOB) || 7}\`,
      \`NO_ALLOW_KNOB=\${Number(process.env.NO_ALLOW_KNOB) || 1}\`,
      'DEAD_FIBER_KNOB=0',
    ],
  };
}
export function caller() {
  return buildContainerConfig({});
}
`,
  'portal/src/config.js': `
export function loadConfig(env = process.env) {
  return {
    databaseUrl: env.DATABASE_URL || 'x',
    emptyDefault: env.EMPTY_DEFAULT_KNOB || '',
  };
}
`,
  'deploy/fde-proxy/server.js': `
const ENV_KEY_ALLOW = new Set([
  'PATH',
  'OK_KNOB',
  'DEAD_FIBER_KNOB',
]);
export function check(key) {
  if (!ENV_KEY_ALLOW.has(key)) throw new Error('create_policy_denied');
}
`,
  'runner/worker.js': `
// DEAD_FIBER_KNOB 只出现在这行注释里（注释里的名字**不算读**，否则死光纤会被洗白）。
const rounds = Number(process.env.OK_KNOB) || 7;
export function readIt(env = process.env) {
  return env.NO_ALLOW_KNOB;
}
const baseEnv = { ...process.env };
baseEnv.CHILD_ONLY_KNOB = '1'; // 赋值给子进程：是写，不是读
export function dynamicChild(env = process.env, { key = LIVE_TABLE_ENV } = {}) {
  return env?.[key];
}
`,
  'runner/lib/tables.js': `
export const LIVE_TABLE_ENV = Object.freeze({ a: 'TABLE_READ_KNOB' });
export const DEAD_TABLE_ENV = Object.freeze({ b: 'TABLE_IGNORED_KNOB' });
export const STDIO_ENV_ALLOWLIST = Object.freeze(['PATH', 'HOME']);
export function resolve(env = process.env) {
  const out = {};
  for (const field of Object.keys(LIVE_TABLE_ENV)) {
    const envName = LIVE_TABLE_ENV[field];
    out[field] = env?.[envName];
  }
  return out;
}
`,
  'runner/lib/tables.test.js': `
process.env.TABLE_IGNORED_KNOB = '1'; // 测试文件不算消费者
`,
};

function withFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-knob-inventory-'));
  try {
    for (const [rel, text] of Object.entries(FIXTURE)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text, 'utf8');
    }
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const byName = (inv, name) => inv.knobs.find((k) => k.name === name);

test('① 注入但不在白名单 ⇒ 报「断在 proxy 白名单」并进小计', () => {
  withFixture((root) => {
    const inv = buildInventory(root);
    const knob = byName(inv, 'NO_ALLOW_KNOB');
    assert.ok(knob, 'NO_ALLOW_KNOB 必须在表里');
    assert.equal(knob.injected.length, 1);
    assert.match(knob.injected[0], /^portal\/src\/provisioner\.js:\d+$/);
    assert.equal(knob.allowlisted.length, 0);
    assert.ok(
      knob.breaks.some((b) => b.includes('断在 proxy 白名单')),
      `断链必须点名白名单，实际=${JSON.stringify(knob.breaks)}`,
    );
    assert.ok(inv.subtotals.injectedNotAllowlisted.includes('NO_ALLOW_KNOB'));
    // 反向确认：四处齐的那根不会因为同表其它键被误报
    assert.ok(!inv.subtotals.injectedNotAllowlisted.includes('OK_KNOB'));
  });
});

test('② 在白名单但没人读 ⇒ 报「死光纤」（注释里提到不算读）', () => {
  withFixture((root) => {
    const inv = buildInventory(root);
    const knob = byName(inv, 'DEAD_FIBER_KNOB');
    assert.ok(knob, 'DEAD_FIBER_KNOB 必须在表里');
    assert.equal(knob.allowlisted.length, 1);
    assert.match(knob.allowlisted[0], /^deploy\/fde-proxy\/server\.js:\d+$/);
    assert.equal(knob.runnerReads.length, 0, '只有注释提到它 ⇒ 不算 runner 读');
    assert.ok(
      knob.breaks.some((b) => b.includes('死光纤')),
      `必须报死光纤，实际=${JSON.stringify(knob.breaks)}`,
    );
    assert.ok(inv.subtotals.allowlistedNobodyRead.includes('DEAD_FIBER_KNOB'));
  });
});

test('③ 四处都齐 ⇒ 不报错，且判「能搬进 DB」', () => {
  withFixture((root) => {
    const inv = buildInventory(root);
    const knob = byName(inv, 'OK_KNOB');
    assert.deepEqual(knob.breaks, [], `实际=${JSON.stringify(knob.breaks)}`);
    assert.equal(knob.compose.form, '${VAR:-默认}');
    assert.ok(knob.injected.length >= 1);
    assert.equal(knob.allowlisted.length, 1);
    assert.equal(knob.runnerReads.length, 1);
    assert.equal(knob.runnerReads[0].ref, 'runner/worker.js:3');
    // 注入行上那句 `process.env.OK_KNOB` 是**转发**，不算 portal 消费
    assert.deepEqual(knob.portalReads, []);
    assert.equal(knob.bootWhy.length, 0);
    assert.equal(knob.pile, 'db');
    assert.ok(inv.piles.db.includes('OK_KNOB'));
    // 小计里三处都不该有它
    assert.ok(!inv.subtotals.injectedNotAllowlisted.includes('OK_KNOB'));
    assert.ok(!inv.subtotals.runnerReadNotInjected.includes('OK_KNOB'));
    assert.ok(!inv.subtotals.allowlistedNobodyRead.includes('OK_KNOB'));
  });
});

test('compose 写法分类：字面 / `${VAR:-默认}` / 默认空 / 单横线 / 必填多行', () => {
  assert.equal(classifyComposeValue('"42"'), '字面');
  assert.equal(classifyComposeValue('${OK_KNOB:-7}'), '${VAR:-默认}');
  assert.equal(classifyComposeValue('${OK_KNOB:-}'), '${VAR:-}（默认空）');
  assert.equal(classifyComposeValue('${OK_KNOB-1001:1000}'), '${VAR-默认}（单横线）');
  assert.equal(classifyComposeValue('${FDE_IMAGE:?必填}'), '${VAR:?必填}');
  assert.equal(classifyComposeValue('llm.${BASE_DOMAIN:-localhost}'), '${VAR:-默认}');
  assert.equal(classifyComposeValue(''), '空值');
  assert.equal(classifyComposeValue('http://127.0.0.1:4100'), '字面');

  withFixture((root) => {
    const services = parseComposeEnv(fs.readFileSync(path.join(root, 'deploy/docker-compose.yml'), 'utf8'));
    const portal = services['station-portal'];
    assert.deepEqual(
      portal.map((e) => e.name),
      ['OK_KNOB', 'NO_ALLOW_KNOB', 'DEAD_FIBER_KNOB', 'EMPTY_DEFAULT_KNOB', 'DEV_USER_KNOB', 'LITERAL_KNOB', 'DATABASE_URL'],
      '注释行与别的服务的键不许混进来',
    );
    assert.ok(portal.every((e) => e.line > 0));
    // proxy 服务自己的键（含跨行值）单独成组，且跨行被接回同一 raw
    const img = services['station-docker-proxy'].find((e) => e.name === 'IMAGE_ALLOWLIST');
    assert.equal(img.form, '${VAR:?必填}');
    assert.match(img.raw, /scratch 写 whoami/);
    // compose 里出现但只属于别的服务 ⇒ 标注服务名
    const inv = buildInventory(root);
    const home = byName(inv, 'HOME');
    assert.equal(home.compose.service, 'station-litellm');
  });
});

test('runner 侧读取形态：成员 / 点号别名 / 数据表；赋值与注释不算读', () => {
  withFixture((root) => {
    const reads = scanEnvReads(root, 'runner');
    assert.ok(reads.get('OK_KNOB').some((r) => r.ref === 'runner/worker.js:3'));
    assert.ok(reads.get('NO_ALLOW_KNOB').some((r) => r.ref === 'runner/worker.js:5'));
    // 数据表：被动态下标喂过的表算读，没被喂过的不算
    assert.ok(reads.has('TABLE_READ_KNOB'), '被 env[envName] 喂过的表必须登记');
    assert.equal(reads.has('TABLE_IGNORED_KNOB'), false, '没被喂过的表不许登记');
    // 赋值目标（`baseEnv.CHILD_ONLY_KNOB = ...`）与测试文件里的读都不算
    assert.equal(reads.has('CHILD_ONLY_KNOB'), false);
    assert.equal(reads.has('TABLE_IGNORED_KNOB'), false);
    // 子进程环境放行面单独归类
    assert.deepEqual([...scanChildEnvAllowlists(root, 'runner')].sort(), ['HOME', 'PATH']);
  });
});

test('剥注释不许吃掉代码（行号与串内斜杠都要保住）', () => {
  const src = [
    "const a = 'x // y'; // 注释里的 'quote",
    '/* 块注释 process.env.GONE_KNOB */',
    'const b = process.env.KEPT_KNOB; // 尾注',
  ].join('\n');
  const stripped = stripJsComments(src);
  assert.match(stripped, /'x \/\/ y'/, '字符串里的斜杠不许当注释');
  assert.doesNotMatch(stripped, /GONE_KNOB/);
  assert.match(stripped, /KEPT_KNOB/);
  assert.equal(stripped.split('\n').length, src.split('\n').length, '剥注释必须保行号');
});

test('注入与白名单的解析位置给到 file:line，供人工抽验', () => {
  withFixture((root) => {
    const inj = parseInjectedEnv(fs.readFileSync(path.join(root, 'portal/src/provisioner.js'), 'utf8'));
    assert.deepEqual(
      inj.map((x) => x.name),
      ['OK_KNOB', 'NO_ALLOW_KNOB', 'DEAD_FIBER_KNOB'],
    );
    assert.deepEqual(inj.map((x) => x.line), [5, 6, 7]);
    const allow = parseProxyAllowlist(fs.readFileSync(path.join(root, 'deploy/fde-proxy/server.js'), 'utf8'));
    assert.deepEqual(allow.map((x) => x.name), ['PATH', 'OK_KNOB', 'DEAD_FIBER_KNOB']);
    assert.deepEqual(allow.map((x) => x.line), [3, 4, 5]);
  });
});

test('启动前必知的判据：连库 / 容器身份 / 启动快照 / 基线环境各归各位', () => {
  withFixture((root) => {
    const inv = buildInventory(root);
    const db = byName(inv, 'DATABASE_URL');
    assert.ok(db.bootWhy.some((w) => w.startsWith('P1')), '连库串必须判 P1');
    assert.equal(db.pile, 'no');
    const img = byName(inv, 'IMAGE_ALLOWLIST');
    assert.equal(img.compose.service, 'station-docker-proxy');
    assert.ok(img.bootWhy.some((w) => w.startsWith('P2')), 'proxy 服务自己的键必须判 P2');
    assert.equal(img.pile, 'no');
    const empty = byName(inv, 'EMPTY_DEFAULT_KNOB');
    assert.ok(empty.bootWhy.includes('P3启动快照'), '被 portal 启动快照读的键必须判 P3');
    assert.equal(empty.pile, 'no');
    // 子进程基线环境（PATH/HOME）不进三堆
    assert.ok(inv.piles.nonKnob.includes('PATH'));
    assert.ok(!inv.piles.db.includes('PATH') && !inv.piles.no.includes('PATH') && !inv.piles.human.includes('PATH'));
    assert.ok(!inv.subtotals.runnerReadNotInjected.includes('PATH'));
  });
});

test('输出：每行八列，且小计与三堆都在渲染文本里', () => {
  withFixture((root) => {
    const inv = buildInventory(root);
    const lines = renderTable(inv);
    const header = lines[0].split(' | ');
    assert.equal(header.length, 8);
    assert.deepEqual(header.slice(0, 3), ['旋钮名', 'compose 里怎么写', '谁读它(file:line)']);
    for (const row of lines.slice(2)) {
      assert.equal(row.split(' | ').length, 8, `列数不对：${row}`);
      assert.ok(!/^\s*\|/.test(row));
    }
    const summary = renderSummary(inv).join('\n');
    assert.match(summary, /注入但没进白名单=1 \[NO_ALLOW_KNOB\]/);
    assert.match(summary, /在白名单但没人读（死光纤）=1 \[DEAD_FIBER_KNOB\]/);
    assert.match(summary, /能搬（三腿齐 \+ 非启动前必知 \+ portal 不读）=1 \[OK_KNOB\]/);
    assert.match(summary, /compose station-portal\.environment 键数=7/);
    assert.match(summary, /proxy ENV_KEY_ALLOW=3/);
  });
});

test('打不开的落点要显式说出来，不许静默当 0', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-knob-inventory-empty-'));
  try {
    fs.mkdirSync(path.join(root, 'runner'), { recursive: true });
    fs.writeFileSync(path.join(root, 'runner', 'worker.js'), 'process.env.LONE_KNOB;', 'utf8');
    const inv = buildInventory(root);
    assert.deepEqual(inv.missing.sort(), ['deploy/docker-compose.yml', 'deploy/fde-proxy/server.js', 'portal/src/provisioner.js']);
    assert.equal(inv.counts.composePortalKeys, 0);
    const knob = byName(inv, 'LONE_KNOB');
    assert.ok(knob.breaks.some((b) => b.includes('断在注入')), 'runner 读但没人注入 ⇒ 点名断链');
    assert.match(renderSummary(inv).join('\n'), /打不开/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
