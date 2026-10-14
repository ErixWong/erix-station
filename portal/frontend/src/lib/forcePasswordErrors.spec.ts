// #255 前端 ②（任务 1）：**错误码 → 文案映射表**的表级单测（纯函数，不挂载组件）。
//
// 分工：这里钉「码 → 键 → 参数」的映射本身（含两个 401 的区分、Retry-After 注入、未知码兜底），
// 渲染侧（进 DOM 后是什么样）在 views/ForcePasswordErrors.spec.ts。
// 约定照 ① ：装配真实 i18n 单例、不 mock t()；每例 localStorage.clear() + setLocale('zh-CN')。
import { beforeEach, describe, expect, it } from 'vitest';
import { ERROR_CODE_KEYS, describeError, describeField, errorMeansRelogin, resolveErrorCode } from './forcePasswordErrors';
import { en } from '../i18n/locales/en';
import { zhCN } from '../i18n/locales/zh-CN';
import { setLocale } from '../i18n';

/** 表里每个键必须在两份 locale 里真的存在（拼错键名时 vue-i18n 会原样回显键名，故这样钉）。 */
const errorsRoot = (root: { forcePassword: { errors: Record<string, unknown> } }) => root.forcePassword.errors;

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
});

describe('#255 错误码映射表：码 → 键', () => {
  it('§2.6a 列出的每个失败码都在表里，且键名在 zh/en 两侧都取得到真文案', () => {
    const required = [
      'invalid_credentials',
      'validation_failed',
      'unauthorized',
      'cross_origin_forbidden',
      'rate_limited',
      'kdf_busy',
      'method_not_allowed',
    ];
    for (const code of required) {
      expect(ERROR_CODE_KEYS[code], `表里缺 ${code}`).toBeTruthy();
      const key = ERROR_CODE_KEYS[code];
      expect(typeof errorsRoot(zhCN)[key], key).toBe('string');
      expect(typeof errorsRoot(en)[key], key).toBe('string');
    }
  });

  it('invalid_credentials（旧口令不对）：文案说的是「重输当前口令」，不是「重新登录」', () => {
    expect(resolveErrorCode({ status: 401, code: 'invalid_credentials' })).toEqual({
      key: 'invalid_credentials',
      params: {},
      relogin: false,
    });
    expect(describeError({ status: 401, code: 'invalid_credentials', message: 'invalid credentials' }))
      .toMatch('当前口令');
  });

  it('⚠ 同为 401，unauthorized 与 invalid_credentials 必须分道（后者绝不能把人踢回登录页）', () => {
    // §2.6a：本端点的旧口令错误**故意复用**登录失败的码 ⇒ 状态码在这里没有区分力。
    expect(resolveErrorCode({ status: 401, code: 'unauthorized' }).relogin).toBe(true);
    expect(resolveErrorCode({ status: 401, code: 'invalid_credentials' }).relogin).toBe(false);
    expect(resolveErrorCode({ status: 401, code: 'unauthorized' }).key).toBe('unauthorized');
  });

  it('unauthorized（会话过期）⇒ relogin=true，且文案指向「回登录页」而不是「再试一次」', () => {
    const text = describeError({ status: 401, code: 'unauthorized', message: 'unauthorized' });
    expect(text).toMatch('重新登录');
    expect(errorMeansRelogin({ status: 401, code: 'unauthorized' })).toBe(true);
  });

  it('validation_failed 带 details.field ⇒ 把字段名说成人话（三个框都覆盖）', () => {
    for (const [field, zh] of [
      ['new_password', '新口令'],
      ['current_password', '当前口令'],
      ['confirm_password', '确认新口令'],
    ] as const) {
      const resolved = resolveErrorCode({ status: 400, code: 'validation_failed', details: { field } });
      expect(resolved.key).toBe('validation_failed');
      expect(resolved.params.field, field).toBe(zh);
      expect(describeError({ status: 400, code: 'validation_failed', details: { field } })).toContain(zh);
    }
  });

  it('validation_failed 的 field 是陌生名字 ⇒ 原样带出并明说认不出（不猜、不空着）', () => {
    const text = describeError({ status: 400, code: 'validation_failed', details: { field: 'new_passwrd' } });
    expect(text).toContain('new_passwrd');
    expect(text).toContain('未收录的字段名');
  });

  it('validation_failed 压根没带 field ⇒ 明说「未指明字段」，不渲染成空引号', () => {
    expect(describeField(undefined)).toBe('未指明字段');
    const text = describeError({ status: 400, code: 'validation_failed' });
    expect(text).toContain('未指明字段');
    expect(text).not.toContain('「」');
  });

  it('cross_origin_forbidden（#234 同源防线）：文案给出「在本站地址栏直接打开后重试」这一步', () => {
    expect(resolveErrorCode({ status: 403, code: 'cross_origin_forbidden' }).key).toBe('cross_origin_forbidden');
    expect(describeError({ status: 403, code: 'cross_origin_forbidden' })).toMatch('地址栏');
  });

  it('forbidden 与 cross_origin_forbidden 是两码两话（越权 ≠ 没资格发这个请求）', () => {
    expect(resolveErrorCode({ status: 403, code: 'forbidden' }).key).toBe('forbidden');
    const plain = describeError({ status: 403, code: 'forbidden' });
    const xorigin = describeError({ status: 403, code: 'cross_origin_forbidden' });
    expect(plain).not.toBe(xorigin);
    expect(plain).toMatch('管理员');
  });

  it('rate_limited(429) ⇒ 把 Retry-After 的秒数说进文案；缺头则换不带秒数的键（不演 "undefined 秒"）', () => {
    expect(resolveErrorCode({ status: 429, code: 'rate_limited', retryAfter: 42 }))
      .toMatchObject({ key: 'rate_limited', params: { seconds: 42 } });
    expect(describeError({ status: 429, code: 'rate_limited', retryAfter: 42 })).toContain('42');

    expect(resolveErrorCode({ status: 429, code: 'rate_limited' })).toMatchObject({ key: 'rate_limited_no_retry' });
    const noHeader = describeError({ status: 429, code: 'rate_limited' });
    expect(noHeader).not.toMatch('undefined');
    expect(noHeader).toMatch('一会儿');
    // zh/en 两侧都得真的备有兜底键（缺一个就是运行期回显键名）。
    expect(typeof errorsRoot(zhCN).rate_limited_no_retry).toBe('string');
    expect(typeof errorsRoot(en).rate_limited_no_retry).toBe('string');
  });

  it('kdf_busy(503) ⇒ 说清「不是你的口令有问题」+ Retry-After 秒数', () => {
    expect(resolveErrorCode({ status: 503, code: 'kdf_busy', retryAfter: 5 })).toMatchObject({
      key: 'kdf_busy',
      params: { seconds: 5 },
    });
    const text = describeError({ status: 503, code: 'kdf_busy', retryAfter: 5 });
    expect(text).toMatch('不是你的口令有问题');
    expect(text).toContain('5');
  });

  it('405（method_not_allowed）：文案给出「强制刷新后重试，仍失败拿码去报障」', () => {
    expect(resolveErrorCode({ status: 405, code: 'method_not_allowed' }).key).toBe('method_not_allowed');
    expect(describeError({ status: 405, code: 'method_not_allowed' })).toMatch('强制刷新');
  });

  it('**未知码不许静默成通用错误**：兜底文案原样带上 code 与 HTTP 状态码', () => {
    const resolved = resolveErrorCode({ status: 418, code: 'teapot_surprise', message: 'unexpected' });
    expect(resolved).toMatchObject({ key: 'unknown_code', params: { status: 418, code: 'teapot_surprise' } });
    const text = describeError({ status: 418, code: 'teapot_surprise', message: 'unexpected' });
    expect(text).toContain('teapot_surprise');
    expect(text).toContain('418');
    expect(text).toContain('unexpected');
    // 也不许把码「翻译」成某个已知码的说法。
    expect(text).not.toMatch('当前口令');
  });

  it('code 缺失时才允许按状态码兜底；code 存在但不认识时**状态码不许盖过它**', () => {
    // 429 且没有 code ⇒ 按状态码走限流文案（带 Retry-After）。
    expect(resolveErrorCode({ status: 429, retryAfter: 7 })).toMatchObject({ key: 'rate_limited', params: { seconds: 7 } });
    // 429 且带一个前端不认识的 code ⇒ 必须走 unknown_code（把码带出来），不许冒充限流。
    expect(resolveErrorCode({ status: 429, code: 'weird_limiter' })).toMatchObject({ key: 'unknown_code' });
    // 同理 401 + 陌生 code：不许冒充「会话过期」把人踢回登录页。
    const odd = resolveErrorCode({ status: 401, code: 'weird_auth' });
    expect(odd.key).toBe('unknown_code');
    expect(odd.relogin).toBe(false);
  });

  it('每条已知码的文案都要「可行动」：既不能只说「出错了」，也不能把键名演给人看', () => {
    const generic = /^(出错了|请求失败|操作失败|Error)/i;
    for (const code of Object.keys(ERROR_CODE_KEYS)) {
      const text = describeError({ status: 400, code, message: 'x' });
      expect(text, code).not.toMatch(generic);
      expect(text, code).not.toContain('forcePassword.errors');
      // 已知码的文案必须落到一个具体动作上（重输 / 等多少秒 / 强制刷新 / 重登 / 找管理员 / 改这一项）。
      expect(text, code).toMatch(/重|等|刷新|登录|管理员|改|打开/);
    }
  });

  it('文案里不许出现 i18n 占位符残渣或端口/域名（部署形态可变，照 ① 的口径）', () => {
    const banned = [/localhost/i, /127\.0\.0\.1/, /:\d{2,5}\b/, /https?:\/\//, /\{[a-z]+\}/];
    for (const locale of ['zh-CN', 'en'] as const) {
      setLocale(locale);
      for (const code of Object.keys(ERROR_CODE_KEYS)) {
        const text = describeError({ status: 429, code, retryAfter: 9, message: 'm', details: { field: 'new_password' } });
        for (const re of banned) expect(`${locale} ${code}: ${text}`, `${locale} ${code}`).not.toMatch(re);
      }
    }
    setLocale('zh-CN');
  });
});

// ---------------------------------------------------------------------------
// issue #261014 切片 B2：`llm_model_not_found`（发消息预检把「绑定的模型 id 已不在网关里」报成
// 用户看得见的 409）。这里钉三件事：① 码进表且中英两侧都有真文案（不是拿中文交差）；
// ② 该键 param-free（`resolveErrorCode` 不给它注参数，所以 locale 里不许留 `{xxx}` 占位符）；
// ③ 脏值（服务端塞嵌套对象/非字符串）不退化成 `[object Object]`。
// 发送路径那一层的文案在 stores/workbench.spec.ts（同一个码，另一个消费方）。
// ---------------------------------------------------------------------------

const CJK = /[\u4e00-\u9fff]/;

describe('#261014 B2 llm_model_not_found：进表、双语成对、脏值不退化', () => {
  it('码在表里，键名与码逐字相同，且不触发 relogin（会话没死，别把人踢回登录页）', () => {
    expect(ERROR_CODE_KEYS.llm_model_not_found).toBe('llm_model_not_found');
    expect(resolveErrorCode({ status: 409, code: 'llm_model_not_found' })).toEqual({
      key: 'llm_model_not_found', params: {}, relogin: false,
    });
    // 409 不在 STATUS_KEYS 里：认识 code 时绝不走状态码兜底（表头注释的口径）。
    expect(resolveErrorCode({ status: 409, code: 'llm_model_not_found' }).key).not.toBe('unknown_code');
  });

  it('zh-CN 与 en 两侧都有该键、语义都真写了（zh 含汉字、en 不含汉字且不与 zh 同串）', () => {
    const zh = errorsRoot(zhCN).llm_model_not_found;
    const english = errorsRoot(en).llm_model_not_found;
    expect(typeof zh).toBe('string');
    expect(typeof english).toBe('string');
    expect(zh).toMatch(CJK);
    expect(english).not.toMatch(CJK);
    expect(english).not.toBe(zh);
  });

  it('本键 param-free：locale 里不许留 i18n 占位符（resolveErrorCode 不给它注参数，留了就是残渣）', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      setLocale(locale);
      const text = describeError({ status: 409, code: 'llm_model_not_found', message: 'm' });
      expect(text).not.toMatch(/\{[a-z_]+\}/);
      expect(text).not.toContain('forcePassword.errors');
      // 必须给出处置动作（改模型 / 找管理员），不许演成「出错了」。
      expect(text).toMatch(/重新选择|管理台|管理员|re-select|administrator/);
    }
    setLocale('zh-CN');
  });

  it('脏 details / 脏 message：经 toDisplayText 收口，绝不演成 [object Object] 或 undefined', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      setLocale(locale);
      const text = describeError({
        status: 409,
        code: 'llm_model_not_found',
        // 服务端按契约给字符串，但 `describeError` 不信任它（再过一次 toDisplayText）——
        // 这里故意塞非字符串，所以要 `as unknown as string` 把契约外的形状递进去。
        message: { slot: { deep: [1, 2] } } as unknown as string,
        details: { slot: {}, model_id: undefined },
      });
      expect(text).not.toContain('[object Object]');
      expect(text).not.toContain('undefined');
      expect(text).toContain('llm_model_not_found');
    }
    setLocale('zh-CN');
  });
});
