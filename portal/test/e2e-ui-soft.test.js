// @ts-check
// #932：钉死 e2e-ui-soft.mjs 三个导出的**实际行为**（照实现钉，不凭想象）。
// 运行：node --test 会自动发现 portal/test/*.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSoftSkip,
  uiSoft,
  hostResolverRules,
} from '../integration/lib/e2e-ui-soft.mjs';

// ---- shouldSoftSkip：阶段是唯一判据，message 不参与（实现里 void message）----

// ① phase:'run' 无论 message 是什么都 false——含网络类文案也要钉死。
test('shouldSoftSkip: phase=run + 网络文案 + soft:true 仍判 false（红，不降级）', () => {
  assert.equal(
    shouldSoftSkip({ soft: true, phase: 'run', message: 'net::ERR_NAME_NOT_RESOLVED at https://admin' }),
    false,
  );
  assert.equal(shouldSoftSkip({ soft: true, phase: 'run', message: 'ECONNREFUSED' }), false);
  assert.equal(shouldSoftSkip({ soft: true, phase: 'run', message: '' }), false);
  assert.equal(shouldSoftSkip({ soft: true, phase: 'run' }), false);
});

// ② phase:'probe' + 网络文案：soft:true ⇒ true，soft:false ⇒ false。
test('shouldSoftSkip: phase=probe + 网络文案，soft 决定 true/false', () => {
  assert.equal(shouldSoftSkip({ soft: true, phase: 'probe', message: 'net::ERR_CONNECTION_REFUSED' }), true);
  assert.equal(shouldSoftSkip({ soft: false, phase: 'probe', message: 'net::ERR_CONNECTION_REFUSED' }), false);
});

// ③ 未知 message / 空 message：实现只认 soft+phase，message 被 void ⇒ 与 soft 同真值。
test('shouldSoftSkip: 未知/空 message 不改判据（只认 soft+phase）', () => {
  // probe + soft ⇒ true，不管 message 是空、未知、还是缺失。
  assert.equal(shouldSoftSkip({ soft: true, phase: 'probe', message: '' }), true);
  assert.equal(shouldSoftSkip({ soft: true, phase: 'probe', message: '一些完全未知的中文原因' }), true);
  assert.equal(shouldSoftSkip({ soft: true, phase: 'probe' }), true); // message 走默认值 ''
  // soft 为假一律 false。
  assert.equal(shouldSoftSkip({ soft: false, phase: 'probe', message: '' }), false);
  // 无参调用：soft 默认 false ⇒ false。
  assert.equal(shouldSoftSkip(), false);
  // 既不是 probe 也不是 run 的 phase（例如 undefined）⇒ 非 probe ⇒ false。
  assert.equal(shouldSoftSkip({ soft: true, phase: undefined, message: 'net::x' }), false);
  assert.equal(shouldSoftSkip({ soft: true, message: 'net::x' }), false); // 无 phase
});

// ---- uiSoft ----

test('uiSoft: 只有 E2E_UI_SOFT=1 才为真', () => {
  assert.equal(uiSoft({ E2E_UI_SOFT: '1' }), true);
  assert.equal(uiSoft({ E2E_UI_SOFT: '0' }), false);
  assert.equal(uiSoft({ E2E_UI_SOFT: 'true' }), false);
  assert.equal(uiSoft({}), false);
});

// ---- hostResolverRules ----

// ④ E2E_RESOLVE 与 E2E_HOST_MAP 同时存在且不同：取前者 + 给出旧名被忽略的信号。
test('hostResolverRules: 两个变量同时存在且不同 ⇒ 只用 E2E_RESOLVE 并回 warning', () => {
  const r = hostResolverRules({
    E2E_RESOLVE: 'admin.example=1.2.3.4',
    E2E_HOST_MAP: 'admin.example=9.9.9.9',
  });
  assert.equal(r.rules, 'MAP admin.example 1.2.3.4');
  assert.equal(typeof r.warning, 'string');
  assert.ok(r.warning.includes('E2E_HOST_MAP'), `warning 应点名旧名 E2E_HOST_MAP，实得 ${JSON.stringify(r.warning)}`);
  assert.ok(r.warning.includes('E2E_RESOLVE'), `warning 应说明改用 E2E_RESOLVE，实得 ${JSON.stringify(r.warning)}`);
  // entries 也来自 E2E_RESOLVE，不含旧名那条 IP。
  assert.deepEqual(r.entries, [{ host: 'admin.example', ip: '1.2.3.4' }]);
});

// 两个变量同时存在但**相同** ⇒ 不报 warning（只有不同才提示）。
test('hostResolverRules: 两个变量相同 ⇒ 无 warning', () => {
  const r = hostResolverRules({ E2E_RESOLVE: 'admin.example=1.2.3.4', E2E_HOST_MAP: 'admin.example=1.2.3.4' });
  assert.equal(r.rules, 'MAP admin.example 1.2.3.4');
  assert.equal(r.warning, null);
});

// ⑤ 只有 E2E_HOST_MAP（旧名）时能用。
test('hostResolverRules: 只有旧名 E2E_HOST_MAP 时也能解析', () => {
  const r = hostResolverRules({ E2E_HOST_MAP: 'admin.example=5.6.7.8' });
  assert.equal(r.rules, 'MAP admin.example 5.6.7.8');
  assert.equal(r.warning, null);
  assert.deepEqual(r.entries, [{ host: 'admin.example', ip: '5.6.7.8' }]);
});

// ⑥ 无 `=` 的条目被丢弃，输出串形如 MAP a 1.2.3.4,MAP b 5.6.7.8（逗号连接）。
test('hostResolverRules: 丢弃无 = 的条目，多条规则逗号连接', () => {
  const r = hostResolverRules({ E2E_RESOLVE: 'a=1.2.3.4,,garbage-no-equals, b = 5.6.7.8 ,' });
  assert.equal(r.rules, 'MAP a 1.2.3.4,MAP b 5.6.7.8');
  assert.deepEqual(r.entries, [{ host: 'a', ip: '1.2.3.4' }, { host: 'b', ip: '5.6.7.8' }]);
});

// 缺省：两个变量都没有 ⇒ 用与现有脚本一致的缺省串（两条 host，映到本机回环）。
test('hostResolverRules: 两者皆无 ⇒ 缺省两条 host 映到 127.0.0.1', () => {
  const r = hostResolverRules({});
  assert.equal(r.rules, 'MAP admin.fde.erix.vip 127.0.0.1,MAP station.fde.erix.vip 127.0.0.1');
  assert.equal(r.warning, null);
  assert.deepEqual(r.entries, [
    { host: 'admin.fde.erix.vip', ip: '127.0.0.1' },
    { host: 'station.fde.erix.vip', ip: '127.0.0.1' },
  ]);
});
