// localeCookie 单测（issue #804）：Domain 推导口径 + 序列化字面量 + jsdom 下的读写往返。
// 两类断言各有分工：纯函数断言「属性拼对了没有」（jsdom 会因 document.domain 不匹配丢掉带
// Domain 的 cookie，只断言 document.cookie 测不到 Domain/Secure），jsdom 往返断言「真装进 jar 后
// 读得回来」。测试里的 hostname 是夹具字面量（闸只扫注释行）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCALE_COOKIE_MAX_AGE,
  LOCALE_COOKIE_NAME,
  clearLocaleCookie,
  localeCookieDomainOf,
  readLocaleCookie,
  serializeLocaleCookie,
  writeLocaleCookie,
} from './localeCookie';

/** 清干净 jar：本模块的名字 + 用例里当噪声用的其它名字（jsdom 的 document.cookie 同文件共享）。 */
function wipeCookies() {
  for (const name of [LOCALE_COOKIE_NAME, 'other', 'x']) {
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

  it('编码过的脏值原样解回（读回来的合法性由调用方 isAppLocale 判定）', () => {
    document.cookie = `${LOCALE_COOKIE_NAME}=a%20b; Path=/`;
    expect(readLocaleCookie()).toBe('a b');
  });
});
