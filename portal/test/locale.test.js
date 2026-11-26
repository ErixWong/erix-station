// issue #803 S1：`portal/src/locale.js` 的请求语言谈判单测。
//
// 覆盖契约的每一级落回：cookie 命中 / cookie 脏值落回 Accept-Language / 只有 Accept-Language
// （含 q 值、`zh-TW`、`en-GB`、`*`、乱串）/ 两者都无 ⇒ `zh-CN` / 脏 headers 与缺 headers 不抛
// / cookie 与 Accept-Language 冲突时 cookie 赢。
//
// 隔离约定（docs/testing.md §2.1）：纯函数，不碰 DB、不起 HTTP、不 import http.js。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUPPORTED_LOCALES, DEFAULT_LOCALE, parseAcceptLanguage, normalizeLocale, resolveRequestLocale,
} from '../src/locale.js';

test('LC-1 常量：白名单是 [zh-CN, en]，缺省是 zh-CN', () => {
  assert.deepEqual([...SUPPORTED_LOCALES], ['zh-CN', 'en']);
  assert.equal(DEFAULT_LOCALE, 'zh-CN');
});

test('LC-2 normalizeLocale：只认 zh-CN / en（大小写与空白忽略），脏值 ⇒ null', () => {
  assert.equal(normalizeLocale('zh-CN'), 'zh-CN');
  assert.equal(normalizeLocale('en'), 'en');
  assert.equal(normalizeLocale('  en  '), 'en');
  assert.equal(normalizeLocale('EN'), 'en');
  assert.equal(normalizeLocale('zh-cn'), 'zh-CN');
  // 脏值：不在白名单（cookie 侧不做前缀匹配）
  assert.equal(normalizeLocale('zh'), null);
  assert.equal(normalizeLocale('en-GB'), null);
  assert.equal(normalizeLocale('fr'), null);
  assert.equal(normalizeLocale(''), null);
  assert.equal(normalizeLocale('   '), null);
  assert.equal(normalizeLocale(undefined), null);
  assert.equal(normalizeLocale(null), null);
  assert.equal(normalizeLocale(42), null);
  assert.equal(normalizeLocale({}), null);
  assert.equal(normalizeLocale('constructor'), null); // 原型链上的名字不许混进来
});

test('LC-3 parseAcceptLanguage：基本匹配与前缀归类', () => {
  assert.equal(parseAcceptLanguage('en'), 'en');
  assert.equal(parseAcceptLanguage('zh-CN'), 'zh-CN');
  assert.equal(parseAcceptLanguage('zh-TW'), 'zh-CN');   // zh* ⇒ zh-CN
  assert.equal(parseAcceptLanguage('zh-Hans'), 'zh-CN');
  assert.equal(parseAcceptLanguage('en-GB'), 'en');       // en* ⇒ en
  assert.equal(parseAcceptLanguage('en-US,en;q=0.9'), 'en');
});

test('LC-4 parseAcceptLanguage：q 值择优（高 q 赢，同 q 保序）', () => {
  // en 明确高于 zh：en 赢
  assert.equal(parseAcceptLanguage('zh-CN;q=0.3, en;q=0.8'), 'en');
  // zh 明确高于 en：zh 赢
  assert.equal(parseAcceptLanguage('en;q=0.5, zh-CN;q=0.9'), 'zh-CN');
  // 缺省 q=1：裸标签排在带低 q 的候选前 ⇒ 裸的赢
  assert.equal(parseAcceptLanguage('fr-FR, en;q=0.8'), 'en'); // fr 无匹配 ⇒ 落 en
  // 同 q 靠前者优先（稳定序）
  assert.equal(parseAcceptLanguage('zh-CN;q=0.5, en;q=0.5'), 'zh-CN');
  assert.equal(parseAcceptLanguage('en;q=0.5, zh-CN;q=0.5'), 'en');
});

test('LC-5 parseAcceptLanguage：* 与其他语言落回（不匹配、不抛）', () => {
  assert.equal(parseAcceptLanguage('*'), null);                 // 通配 ⇒ 落回（调用方给缺省）
  assert.equal(parseAcceptLanguage('fr, de, es'), null);        // 全是别国语言 ⇒ 落回
  assert.equal(parseAcceptLanguage('*, en'), 'en');             // * 跳过、en 仍中（* q 与 en q 都 1，靠后也中）
  assert.equal(parseAcceptLanguage('fr;q=1.0, en;q=0.5'), 'en'); // 高 q 的 fr 不匹配 ⇒ 次高 en
  // 注：`q<=0` 按 RFC 算「不要」（不参与匹配），单独一条时落回 `null` ⇒ 调用方给缺省；见 LC-5b。
});

test('LC-5b parseAcceptLanguage：q<=0 的项不参与匹配（RFC 的「我不要这个语言」）', () => {
  // 单独一条 `q=0` ⇒ 没有任何可匹配项 ⇒ `null`（由调用方落回缺省），**而不是选中它**。
  // 这是 #803 返修 m4 改的行为：旧实现只拿 q 排序 ⇒「明确说了不要」还能当选，与头注相互矛盾。
  assert.equal(parseAcceptLanguage('zh;q=0'), null);
  assert.equal(parseAcceptLanguage('en;q=0'), null);
  assert.equal(parseAcceptLanguage('zh-CN;q=0.0, en;q=0'), null);
  assert.equal(parseAcceptLanguage('en;q=0.00'), null);
  assert.equal(parseAcceptLanguage('en;q=-1'), null);           // 负数同口径（也只能是「不要」）
  // 但同时有更正的候选 ⇒ q=0 的让位（新旧实现这条结果相同，留着防「把带 q 的整段一律丢掉」那种过度修正）。
  assert.equal(parseAcceptLanguage('zh;q=0, en'), 'en');
  assert.equal(parseAcceptLanguage('en;q=0, zh-CN'), 'zh-CN');
  // 被排除的那项不许「连累」候选：它排最前，次高的受支持项仍赢。
  assert.equal(parseAcceptLanguage('en;q=0, fr;q=0.9, zh-CN;q=0.1'), 'zh-CN');
  // 非法 / 缺值的 q **不算排除**（写法坑 ≠ 拒绝）：该标签照常参与匹配（与 LC-6 同一口径）。
  assert.equal(parseAcceptLanguage('en;q=abc'), 'en');
  assert.equal(parseAcceptLanguage('zh-CN;q='), 'zh-CN');
});

test('LC-6 parseAcceptLanguage：脏输入不抛，尽量落回 null', () => {
  assert.equal(parseAcceptLanguage(''), null);
  assert.equal(parseAcceptLanguage(',,,'), null);
  assert.equal(parseAcceptLanguage(';;;'), null);
  assert.equal(parseAcceptLanguage('en;;q=abc;zzz'), 'en');   // 坏 q 不致命，标签照常匹配
  assert.equal(parseAcceptLanguage('zh-CN;q='), 'zh-CN');      // 缺 q 值 ⇒ 当默认 1
  assert.equal(parseAcceptLanguage(undefined), null);
  assert.equal(parseAcceptLanguage(null), null);
  assert.equal(parseAcceptLanguage(123), null);
  assert.equal(parseAcceptLanguage(['en']), null);            // 非字符串一律落回
});

test('LC-7 resolveRequestLocale：cookie 命中优先', () => {
  assert.equal(resolveRequestLocale({ headers: { cookie: 'locale=en' } }), 'en');
  assert.equal(resolveRequestLocale({ headers: { cookie: 'locale=zh-CN' } }), 'zh-CN');
  // 与其他 cookie 混在一起
  assert.equal(resolveRequestLocale({ headers: { cookie: 'fde=x; locale=en; y=1' } }), 'en');
});

test('LC-8 resolveRequestLocale：cookie 脏值 ⇒ 落回 Accept-Language', () => {
  assert.equal(
    resolveRequestLocale({ headers: { cookie: 'locale=fr', 'accept-language': 'en' } }),
    'en',
  );
  assert.equal(
    resolveRequestLocale({ headers: { cookie: 'locale=', 'accept-language': 'zh-TW' } }),
    'zh-CN',
  );
  assert.equal(
    resolveRequestLocale({ headers: { cookie: 'locale=zh', 'accept-language': 'en-GB' } }),
    'en',
  );
});

test('LC-9 resolveRequestLocale：只有 Accept-Language（cookie 里没有 locale）', () => {
  assert.equal(resolveRequestLocale({ headers: { 'accept-language': 'en-GB,en;q=0.9' } }), 'en');
  assert.equal(resolveRequestLocale({ headers: { 'accept-language': 'zh-TW' } }), 'zh-CN');
  assert.equal(resolveRequestLocale({ headers: { cookie: 'other=1', 'accept-language': 'en' } }), 'en');
  // `q<=0` 被排除后没有候选 ⇒ 落回缺省 `zh-CN`（谈判层的结果，不只是解析层返 null）。
  assert.equal(resolveRequestLocale({ headers: { 'accept-language': 'en;q=0' } }), 'zh-CN');
  assert.equal(resolveRequestLocale({ headers: { 'accept-language': 'zh-CN;q=0, en' } }), 'en');
});

test('LC-10 resolveRequestLocale：cookie 与 Accept-Language 冲突 ⇒ cookie 赢', () => {
  assert.equal(
    resolveRequestLocale({ headers: { cookie: 'locale=zh-CN', 'accept-language': 'en' } }),
    'zh-CN',
  );
  assert.equal(
    resolveRequestLocale({ headers: { cookie: 'locale=en', 'accept-language': 'zh-CN' } }),
    'en',
  );
});

test('LC-11 resolveRequestLocale：两者都无 ⇒ 缺省 zh-CN', () => {
  assert.equal(resolveRequestLocale({ headers: {} }), 'zh-CN');
  assert.equal(resolveRequestLocale({ headers: { cookie: 'x=1' } }), 'zh-CN');
  assert.equal(resolveRequestLocale({ headers: { 'accept-language': 'fr,de,*' } }), 'zh-CN');
});

test('LC-12 resolveRequestLocale：脏 headers / 缺 headers / 缺 req 都不抛，落回 zh-CN', () => {
  assert.equal(resolveRequestLocale(), 'zh-CN');
  assert.equal(resolveRequestLocale(null), 'zh-CN');
  assert.equal(resolveRequestLocale(undefined), 'zh-CN');
  assert.equal(resolveRequestLocale({}), 'zh-CN');               // 没有 headers
  assert.equal(resolveRequestLocale({ headers: null }), 'zh-CN');
  assert.equal(resolveRequestLocale({ headers: 42 }), 'zh-CN');  // headers 非对象
  assert.equal(resolveRequestLocale('garbage'), 'zh-CN');        // req 非对象
  assert.equal(resolveRequestLocale({ headers: { cookie: 123, 'accept-language': {} } }), 'zh-CN');
});

test('LC-13 resolveRequestLocale：返回值永远是白名单里的一档（不变量）', () => {
  const cases = [
    undefined, null, {}, { headers: {} },
    { headers: { cookie: 'locale=en' } },
    { headers: { cookie: 'locale=xx', 'accept-language': 'zh-TW,en;q=0.2' } },
    { headers: { 'accept-language': '*;q=1, fr;q=0.9' } },
    { headers: { 'accept-language': 'garbage,,;q=,,zh,en' } },
  ];
  for (const req of cases) {
    assert.ok(SUPPORTED_LOCALES.includes(resolveRequestLocale(req)),
      `谈判结果必须在白名单内：got ${JSON.stringify(resolveRequestLocale(req))}`);
  }
});
