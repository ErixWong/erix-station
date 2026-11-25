// issue #787：`preview.kk_base_url` 运行时旋钮的判据（契约 `docs/api/portal.md` §4.21 + 工单 §3.1）。
//
// 只钉这一格新增的部分：parse/validate 的形状闸、registry 那一格（`kind:'text'` / `applyMode:'hot'`
// / `configPath`）、`HOT_READ_INVALIDATORS` 的**登记身份**、以及 `toSettingItem` 产出的 `kind`
// （parsed.ok 与回落两条分支都要带）。通用三档/缓存/回落那套在 `runtime-settings.test.js`，不重复。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KK_BASE_URL_KEY,
  KK_BASE_URL_DEFAULT,
  parseKkBaseUrl,
  validateKkBaseUrl,
  RUNTIME_SETTING_REGISTRY,
  HOT_READ_INVALIDATORS,
  invalidateKkBaseUrlCache,
  readKkBaseUrl,
  SESSION_TTL_KEY,
  listRuntimeSettingsAdmin,
} from '../src/runtime-settings.js';

// ---------------------------------------------------------------------------
// ① parse：合法 / 拒绝
// ---------------------------------------------------------------------------

test('KK-P-1 parse 合法地址 ⇒ {ok:true, value}', () => {
  for (const [raw, expect] of [
    ['http://kkfileview:8012', 'http://kkfileview:8012'],
    ['http://kkfileview:8012/', 'http://kkfileview:8012'], // 尾斜杠被去
    ['http://kkfileview:8012///', 'http://kkfileview:8012'],
    ['https://x:443/base', 'https://x:443/base'],
    ['https://kk.example.com', 'https://kk.example.com'],
  ]) {
    const r = parseKkBaseUrl(raw);
    assert.equal(r.ok, true, `合法应通过：${raw}`);
    assert.equal(r.value, expect, `value 应去尾斜杠：${raw}`);
  }
});

test('KK-P-2 parse 拒绝：scheme / userinfo / query / fragment / 空 / 非 string / 超长', () => {
  const cases = [
    ['file:///etc', 'bad_scheme'],
    ['ftp://x', 'bad_scheme'],
    ['http://u:p@x', 'has_userinfo'],
    ['http://x/?a=1', 'has_query_or_fragment'],
    ['http://x/#f', 'has_query_or_fragment'],
    ['', 'not_a_base_url'],
    [123, 'not_a_base_url'],
    [{}, 'not_a_base_url'],
    [null, 'not_a_base_url'],
    [undefined, 'not_a_base_url'],
    ['http://' + 'a'.repeat(300), 'too_long'],
  ];
  for (const [raw, reason] of cases) {
    const r = parseKkBaseUrl(raw);
    assert.equal(r.ok, false, `应拒绝：${String(raw)}`);
    assert.equal(r.reason, reason, `reason 应为 ${reason}（输入 ${String(raw)}，实际 ${r.reason}）`);
  }
});

test('KK-P-3 parse 绝不抛（哪怕 URL 畸形 / 任意类型）', () => {
  for (const raw of ['不是地址', 'http://', '://x', '   ', 'http:kkfileview', NaN, Symbol('s')]) {
    assert.doesNotThrow(() => parseKkBaseUrl(raw), `parse 不许抛：${String(raw)}`);
  }
});

// ---------------------------------------------------------------------------
// ② validate：只收 string；合法 true，其余中文原因串
// ---------------------------------------------------------------------------

test('KK-V-1 validate 合法 ⇒ true；非 string ⇒ 中文原因串', () => {
  assert.equal(validateKkBaseUrl('http://kkfileview:8012'), true);
  assert.equal(validateKkBaseUrl('https://x:443/base'), true);
  for (const bad of [123, 0, true, {}, [], null, undefined]) {
    const why = validateKkBaseUrl(bad);
    assert.notEqual(why, true, `非 string 必须给原因：${String(bad)}`);
    assert.equal(typeof why, 'string', `原因必须是 string：${String(bad)}`);
    assert.ok(why.length > 0, `原因不能是空串：${String(bad)}`);
  }
  // string 但不是合法 base ⇒ 原因串（服务端才是闸：空串也走这里被拒）
  assert.notEqual(validateKkBaseUrl(''), true);
  assert.notEqual(validateKkBaseUrl('ftp://x'), true);
});

// ---------------------------------------------------------------------------
// ③ registry 那一格
// ---------------------------------------------------------------------------

test('KK-R-1 registry 那一格：kind=text / applyMode=hot / configPath / envVar / 默认', () => {
  const entry = RUNTIME_SETTING_REGISTRY[KK_BASE_URL_KEY];
  assert.ok(entry, 'registry 必须有 preview.kk_base_url 这一格');
  assert.equal(entry.key, KK_BASE_URL_KEY);
  assert.equal(entry.kind, 'text', '只有这一格是 text');
  assert.equal(entry.applyMode, 'hot');
  assert.equal(entry.configPath, 'kkInternalBaseUrl');
  assert.equal(entry.envVar, 'KK_INTERNAL_BASE_URL');
  assert.equal(entry.defaultValue, KK_BASE_URL_DEFAULT);
  assert.equal(entry.defaultValue, 'http://kkfileview:8012');
  assert.equal(typeof entry.parse, 'function');
  assert.equal(typeof entry.validate, 'function');
});

test('KK-R-2 只有 kk 那一格带 kind；其余 12 格都不带 kind 字段（前端缺省 integer）', () => {
  for (const [key, entry] of Object.entries(RUNTIME_SETTING_REGISTRY)) {
    if (key === KK_BASE_URL_KEY) continue;
    assert.ok(!('kind' in entry), `其余格不该有 kind 字段：${key}`);
  }
});

// ---------------------------------------------------------------------------
// ④ 失效登记身份 + 热读入口导出
// ---------------------------------------------------------------------------

test('KK-I-1 HOT_READ_INVALIDATORS 登记的必须是 invalidateKkBaseUrlCache（身份，非间接层）', () => {
  const fn = HOT_READ_INVALIDATORS.get(KK_BASE_URL_KEY);
  assert.equal(typeof fn, 'function', '必须登记一个函数');
  assert.equal(fn, invalidateKkBaseUrlCache, '登记的必须是那个具名函数本身（漏登记=保存不失效）');
  assert.equal(typeof readKkBaseUrl, 'function', 'readKkBaseUrl 必须导出');
});

// ---------------------------------------------------------------------------
// ⑤ toSettingItem（经 listRuntimeSettingsAdmin）产出带 kind，两条分支都带
// ---------------------------------------------------------------------------

/** 最小 fake pool：整表 SELECT_ADMIN_SQL 返回给定行（value 已是驱动解析后的形状）。 */
class RowsPool {
  constructor(rows = []) {
    this.rows = rows;
  }

  async query() {
    return { rows: this.rows, rowCount: this.rows.length };
  }
}

const SILENT = { warn() {}, debug() {}, log() {} };

function itemsBy(items) {
  return new Map(items.map((it) => [it.key, it]));
}

test('KK-D-1 有合法行（db 分支）：kk 格 kind=text、其余=integer，且每项都带 kind', async () => {
  const pool = new RowsPool([
    { key: KK_BASE_URL_KEY, value: 'http://kkfileview:8012',
      updated_at: new Date(), updated_by: null },
    { key: SESSION_TTL_KEY, value: 86400, updated_at: new Date(), updated_by: null },
  ]);
  const { items } = await listRuntimeSettingsAdmin({ pool, config: {}, log: SILENT });
  const by = itemsBy(items);
  assert.equal(by.get(KK_BASE_URL_KEY).kind, 'text');
  assert.equal(by.get(KK_BASE_URL_KEY).source, 'db');
  assert.equal(by.get(SESSION_TTL_KEY).kind, 'integer');
  for (const it of items) {
    assert.ok(it.kind === 'text' || it.kind === 'integer', `每项都必须带合法 kind：${it.key}`);
  }
});

test('KK-D-2 无行（回落分支）：kind 仍然带，kk=text、其余=integer', async () => {
  const { items } = await listRuntimeSettingsAdmin({ pool: null, config: {}, log: SILENT });
  const by = itemsBy(items);
  assert.equal(by.get(KK_BASE_URL_KEY).kind, 'text', '回落分支也必须带 kind');
  assert.equal(by.get(SESSION_TTL_KEY).kind, 'integer');
});

test('KK-D-3 kk 行值非法（回落分支）：kind 仍是 text', async () => {
  const pool = new RowsPool([
    { key: KK_BASE_URL_KEY, value: 'ftp://not-a-base', updated_at: new Date(), updated_by: null },
  ]);
  const { items } = await listRuntimeSettingsAdmin({ pool, config: {}, log: SILENT });
  const kk = itemsBy(items).get(KK_BASE_URL_KEY);
  assert.equal(kk.kind, 'text');
  assert.notEqual(kk.source, 'db', '非法 db 值不应当作 db 生效');
});
