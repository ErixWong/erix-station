// localeCookie 单测（issue #804）：Domain 推导口径 + 序列化字面量 + jsdom 下的读写往返。
// 两类断言各有分工：纯函数断言「属性拼对了没有」（jsdom 会因 document.domain 不匹配丢掉带
// Domain 的 cookie，只断言 document.cookie 测不到 Domain/Secure），jsdom 往返断言「真装进 jar 后
// 读得回来」。测试里的 hostname 是夹具字面量（闸只扫注释行）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCALE_CHOSEN_COOKIE_NAME,
  LOCALE_COOKIE_MAX_AGE,
  LOCALE_COOKIE_NAME,
  clearLocaleCookie,
  localeCookieDomainOf,
  readLocaleChosenCookie,
  readLocaleCookie,
  serializeLocaleCookie,
  writeLocaleCookie,
} from './localeCookie';

/** 清干净 jar：本模块的名字 + 用例里当噪声用的其它名字（jsdom 的 document.cookie 同文件共享）。 */
function wipeCookies() {
  // #902 ① 之后本模块有两个 cookie（`locale` 与 `locale_chosen`），噪声名字也会随用例增加；
  // 手写清单漏一个就会让后面的用例被前面写进 jar 的值污染（实测就是这么抓到漏清的）。
  // 所以按 jar 现状枚举，再并上这几个已知名字（万一某个只在带 Domain 的属性下写过）。
  const names = new Set([LOCALE_COOKIE_NAME, LOCALE_CHOSEN_COOKIE_NAME, 'other', 'x']);
  for (const pair of (document.cookie || '').split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0) names.add(pair.slice(0, idx).trim());
  }
  for (const name of names) {
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
}

beforeEach(() => {
  wipeCookies();
});
afterEach(() => {
  wipeCookies();
});

describe('localeCookieDomainOf（Domain 推导：保守，拿不到就 null）', () => {
  it('两个子域各自去掉最左一段 ⇒ 同一个父域（这正是跨 origin 共享的机制）', () => {
    expect(localeCookieDomainOf('admin.fde.erix.vip')).toBe('fde.erix.vip');
    expect(localeCookieDomainOf('station.fde.erix.vip')).toBe('fde.erix.vip');
  });

  it('localhost / IP / IPv6 ⇒ null（IP 上不能设 Domain，开发期自动 fail-open）', () => {
    expect(localeCookieDomainOf('localhost')).toBeNull();
    expect(localeCookieDomainOf('127.0.0.1')).toBeNull();
    expect(localeCookieDomainOf('::1')).toBeNull();
    expect(localeCookieDomainOf('[::1]')).toBeNull();
  });

  it('两段 hostname 与空串 ⇒ null（不去猜一个顶级域出来）', () => {
    expect(localeCookieDomainOf('erix.vip')).toBeNull();
    expect(localeCookieDomainOf('')).toBeNull();
  });

  it('大小写与尾部点号归一', () => {
    expect(localeCookieDomainOf('ADMIN.FDE.erix.vip')).toBe('fde.erix.vip');
    expect(localeCookieDomainOf('a.b.c.')).toBe('b.c');
  });
});

describe('serializeLocaleCookie（属性齐全性在纯函数上断言）', () => {
  it('子域 + https ⇒ 含 Domain 与 Secure', () => {
    const raw = serializeLocaleCookie('en', { hostname: 'admin.fde.erix.vip', secure: true });
    expect(raw).toContain(`${LOCALE_COOKIE_NAME}=en`);
    expect(raw).toContain('Path=/');
    expect(raw).toContain(`Max-Age=${LOCALE_COOKIE_MAX_AGE}`);
    expect(raw).toContain('SameSite=Lax');
    expect(raw).toContain('Domain=fde.erix.vip');
    expect(raw).toContain('Secure');
  });

  it('localhost + http ⇒ host-only 兜底（不含 Domain / Secure）', () => {
    const raw = serializeLocaleCookie('en', { hostname: 'localhost', secure: false });
    expect(raw).toContain(`${LOCALE_COOKIE_NAME}=en`);
    expect(raw).toContain('Path=/');
    expect(raw).not.toContain('Domain=');
    expect(raw).not.toContain('Secure');
  });
});

describe('jsdom 往返（写进 jar 后读得回来）', () => {
  it('writeLocaleCookie(en) ⇒ readLocaleCookie() 为 en；clearLocaleCookie() ⇒ null', () => {
    writeLocaleCookie('en');
    expect(readLocaleCookie()).toBe('en');

    clearLocaleCookie();
    expect(readLocaleCookie()).toBeNull();
  });

  it('jar 里混着别的 cookie 也能读到自己那一份', () => {
    document.cookie = 'other=1; Path=/';
    document.cookie = `${LOCALE_COOKIE_NAME}=en; Path=/`;
    document.cookie = 'x=2; Path=/';
    expect(readLocaleCookie()).toBe('en');
  });

  // #902 评审：`readCookieValue` 现在是 `locale` 与 `locale_chosen` 共用的通用解析器，
  // 边界必须有钉子 —— 它一旦从「完整名比较」退化成「前缀匹配」，两个名字就会互相串（而
  // `locale_chosen` 决定「账号默认语言要不要抢」，串了就是行为缺陷，不是难看）。
  it('名字不许前缀误命中：xlocale_chosen / locale_chosenX 都不是 locale_chosen', () => {
    document.cookie = 'xlocale_chosen=0; Path=/';
    document.cookie = 'locale_chosenX=0; Path=/';
    expect(readLocaleChosenCookie()).toBe(false); // 只写了别人的名字 ⇒ 自己那一份确实没有（解析器若退化成前缀匹配，这条会因 `xlocale_chosen=0` 里那个 0 而说不清，所以再补一条下面那种）
    document.cookie = `${LOCALE_CHOSEN_COOKIE_NAME}=1; Path=/`;
    expect(readLocaleChosenCookie()).toBe(true); // 真写上了才读得到（前缀那两条没把它盖掉）
  });

  it('别人名字的值恰好也是 1 时不许被认成自己（钉「子串匹配」退化：前缀退化由上面两条钉）', () => {
    document.cookie = 'xlocale_chosen=1; Path=/';
    document.cookie = 'zzz_locale_chosen=1; Path=/';
    expect(readLocaleChosenCookie()).toBe(false); // 自己那一份没写 ⇒ false；退化成前缀/子串匹配就会误判 true
  });

  it('值里带 = 不被截断、串首/串中/串尾都读得到（jar 里别的 cookie 挤在前后）', () => {
    document.cookie = 'a=1; Path=/';
    document.cookie = `${LOCALE_CHOSEN_COOKIE_NAME}=1; Path=/`;
    expect(readLocaleChosenCookie()).toBe(true); // 串中
    document.cookie = 'b=c=d; Path=/';
    expect(readLocaleChosenCookie()).toBe(true); // 别人的值里带 = 也不影响自己
    document.cookie = `${LOCALE_COOKIE_NAME}=a%20b; path=/`;
    expect(readLocaleCookie()).toBe('a b'); // 自己的值里带编码空格 ⇒ 原样解回
  });

  it('编码过的脏值原样解回（读回来的合法性由调用方 isAppLocale 判定）', () => {
    document.cookie = `${LOCALE_COOKIE_NAME}=a%20b; Path=/`;
    expect(readLocaleCookie()).toBe('a b');
  });
});
