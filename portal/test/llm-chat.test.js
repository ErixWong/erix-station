// issue #315 追加（工单 261020-04）：`portal/src/llm-chat.js` —— portal 侧唯一的「发一次
// OpenAI 兼容 chat/completions」出口。离线：一律注入假 fetch，不打真模型、不碰 DB / 网络。
//
// 这张文件守的是**收口本身**：
//   ① URL 两种形态（base 带 /v1 / 不带）都必须对；
//   ② **请求体里恒有 `max_tokens`**（#315 的本体：省略 ⇒ 网关注入模型级预算 ⇒ 小窗口模型直接拒请求）；
//      缺省值必须是显式的 512，且与 `sessions.js` 的 `AI_TITLE_MAX_TOKENS` 是同一个数；
//   ③ 超时到点**必须明确报错**（不许悬挂）→ 502 `llm_upstream_failed`；
//   ④ provider 未配置 → 409 `llm_not_configured`（且一个上游请求都不发）；上游 5xx → 502；
//   ⑤ key 纪律：`api_key` 只进 `Authorization` 头，返回值 / 错误文本 / 日志里都不许出现明文；
//   ⑥ 结构不变量：portal 侧构造 `chat/completions` 的地方**只有** `llm-chat.js`（手搓那条已退役）。
//
// 反证（变异）见工单报告：把 `max_tokens` 从请求体里拿掉 ⇒ ②的断言必须红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  chatCompletion, chatCompletionsUrl, extractAssistantText, redactSecret, resolveMaxTokens,
  LLM_CHAT_DEFAULT_MAX_TOKENS, LLM_CHAT_DEFAULT_TIMEOUT_MS, LlmChatError,
} from '../src/llm-chat.js';
import { AI_TITLE_MAX_TOKENS, AI_TITLE_TIMEOUT_MS, SessionError } from '../src/sessions.js';

const HERE = import.meta.dirname;
/** 测试用上游 key（断言它绝不出现在返回值/错误文本/日志里）。 */
const API_KEY = 'sk-test-secret-key-123456';
const provider = (over = {}) => ({ base_url: 'http://station-litellm:4000', api_key: API_KEY, model: 'deepseek-flash', ...over });
const messages = [{ role: 'user', content: '帮我修复登录页白屏' }];

/** 注入假 fetch：记录调用，返回给定响应（或抛错/永不 settle）。 */
function fakeFetch({ respond, throws, neverSettles, honorsAbort = true } = {}) {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    if (neverSettles) {
      return new Promise((_res, reject) => {
        if (honorsAbort && init?.signal) {
          init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
        }
      });
    }
    if (throws) return Promise.reject(new Error(throws));
    return Promise.resolve(respond);
  };
  return { calls, fetchImpl };
}

const response = (status, body, { raw } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(raw ?? JSON.stringify(body)),
});

const okResponse = (content = '登录页白屏修复') =>
  response(200, { choices: [{ message: { content } }] });

const call = (over = {}) => chatCompletion({ provider: provider(), messages, ...over });

// ---------------------------------------------------------------------------
// ① URL 拼接：base 带 /v1 直接用，否则补 /v1（口径同 erix-agent provider）
// ---------------------------------------------------------------------------

test('#315 追加：URL 两种形态都对（base 带 /v1 / 不带 / 带尾斜杠 / 带路径前缀）', async () => {
  assert.equal(chatCompletionsUrl('http://gw:4000'), 'http://gw:4000/v1/chat/completions');
  assert.equal(chatCompletionsUrl('http://gw:4000/v1'), 'http://gw:4000/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://llm.example.com/v1/'), 'https://llm.example.com/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://llm.example.com///'), 'https://llm.example.com/v1/chat/completions');
  assert.equal(chatCompletionsUrl('http://gw:4000/gateway/v1'), 'http://gw:4000/gateway/v1/chat/completions');
  assert.equal(chatCompletionsUrl('http://gw:4000/gateway'), 'http://gw:4000/gateway/v1/chat/completions');

  for (const base of ['http://gw:4000', 'http://gw:4000/v1']) {
    const f = fakeFetch({ respond: okResponse() });
    const out = await call({ provider: provider({ base_url: base }), fetchImpl: f.fetchImpl });
    assert.equal(f.calls[0].url, 'http://gw:4000/v1/chat/completions', `${base} ⇒ 只能有一个 /v1`);
    assert.equal(out.url, 'http://gw:4000/v1/chat/completions');
    assert.equal((String(f.calls[0].url).match(/\/v1\//g) ?? []).length, 1, '不得拼出 /v1/v1');
  }
});

// ---------------------------------------------------------------------------
// ② `max_tokens` **必发**（#315 的本体）
// ---------------------------------------------------------------------------

test('#315 追加：调用方不给 max_tokens ⇒ 请求体里仍有 max_tokens，且等于显式默认 512', async () => {
  const f = fakeFetch({ respond: okResponse() });
  const out = await call({ fetchImpl: f.fetchImpl });
  const body = f.calls[0].body;

  assert.ok(Object.hasOwn(body, 'max_tokens'), '请求体里必须有 max_tokens 这个键（#315 的病根就是省了它）');
  assert.equal(body.max_tokens, 512, '默认值钉在 512');
  assert.equal(body.max_tokens, LLM_CHAT_DEFAULT_MAX_TOKENS);
  assert.equal(body.max_tokens, AI_TITLE_MAX_TOKENS, '与 sessions.js 的 AI 改名预算是同一个数');
  assert.equal(out.maxTokens, 512);
  // 「键存在」必须能在序列化后的原始报文里看到（JSON.stringify 会丢掉 undefined，光断言对象键不够）。
  assert.match(f.calls[0].init.body, /"max_tokens"\s*:\s*512/);
});

test('#315 追加：显式给了 max_tokens 就照用（不覆盖、不省略）', async () => {
  const f = fakeFetch({ respond: okResponse() });
  const out = await call({ fetchImpl: f.fetchImpl, maxTokens: 128 });
  assert.equal(f.calls[0].body.max_tokens, 128);
  assert.equal(out.maxTokens, 128);
});

test('#315 追加：max_tokens 的取值口径（纯函数）——没给⇒默认；给了非正整数⇒非法（不静默省略）', () => {
  assert.equal(resolveMaxTokens(undefined), LLM_CHAT_DEFAULT_MAX_TOKENS);
  assert.equal(resolveMaxTokens(null), LLM_CHAT_DEFAULT_MAX_TOKENS);
  assert.equal(resolveMaxTokens(512), 512);
  assert.equal(resolveMaxTokens(1), 1);
  for (const bad of [0, -1, 1.5, NaN, '512', true, {}]) {
    assert.equal(resolveMaxTokens(bad), null, `${String(bad)} 必须判非法，不能悄悄发上去或省掉字段`);
  }
});

test('#315 追加：非法 max_tokens ⇒ 400 validation_failed（不新增错误码），且不发任何上游请求', async () => {
  const f = fakeFetch({ respond: okResponse() });
  await assert.rejects(() => call({ fetchImpl: f.fetchImpl, maxTokens: 0 }), (e) => {
    assert.equal(e.code, 'validation_failed');
    assert.equal(e.httpStatus, 400);
    assert.deepEqual(e.details, { field: 'max_tokens' });
    return true;
  });
  assert.equal(f.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 请求形状 / 返回值
// ---------------------------------------------------------------------------

test('请求形状：POST + Bearer key + model/messages/stream/temperature，key 只在 Authorization 头里', async () => {
  const f = fakeFetch({ respond: okResponse() });
  const out = await call({ fetchImpl: f.fetchImpl, temperature: 0.2 });
  const { url, init, body } = f.calls[0];

  assert.equal(url, 'http://station-litellm:4000/v1/chat/completions');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.ok(init.signal instanceof AbortSignal, '必须带 AbortSignal（超时要靠它掐掉上游）');
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.messages, messages);
  assert.equal(body.stream, false);
  assert.equal(body.temperature, 0.2);
  assert.equal(typeof init.body, 'string');
  assert.equal(init.body.includes(API_KEY), false, 'key 不进请求体');

  assert.equal(out.text, '登录页白屏修复');
  assert.equal(out.status, 200);
  assert.equal(JSON.stringify(out).includes(API_KEY), false, '返回值里不含明文 key');
});

test('temperature 不给就整个字段省略；助手文本三种形态（字符串 / 分片数组 / 缺失）都能取，取不到就是空串', async () => {
  const f = fakeFetch({ respond: okResponse() });
  await call({ fetchImpl: f.fetchImpl });
  assert.equal(Object.hasOwn(f.calls[0].body, 'temperature'), false);

  assert.equal(extractAssistantText({ choices: [{ message: { content: 'x' } }] }), 'x');
  assert.equal(extractAssistantText({ choices: [{ message: { content: [{ text: 'a' }, 'b'] } }] }), 'ab');
  assert.equal(extractAssistantText({ choices: [] }), '');
  assert.equal(extractAssistantText(null), '');

  const blank = fakeFetch({ respond: response(200, { choices: [{ message: { content: '   ' } }] }) });
  const out = await call({ fetchImpl: blank.fetchImpl });
  assert.equal(out.text, '   ', '取不到有效内容由调用方判（AI 改名侧 ⇒ 502），不在 client 里猜');

  const notJson = fakeFetch({ respond: response(200, null, { raw: '<html>bad gateway proxy</html>' }) });
  const out2 = await call({ fetchImpl: notJson.fetchImpl });
  assert.equal(out2.text, '');
  assert.equal(out2.body, null);
});

// ---------------------------------------------------------------------------
// ③ 超时：到点必须明确报错，不许悬挂
// ---------------------------------------------------------------------------

test('超时到点 ⇒ 明确报 502 llm_upstream_failed（原因含「超时」），且**不悬挂**（注入的假 fetch 完全不理会 AbortSignal 也拦得住）', async () => {
  // 假 fetch 永不 settle 且**不理会 signal**：只有 client 自己那把竞速定时器能在此刻给出终局。
  const f = fakeFetch({ neverSettles: true, honorsAbort: false });
  const startedAt = Date.now();
  await assert.rejects(() => call({ fetchImpl: f.fetchImpl, timeoutMs: 30 }), (e) => {
    assert.equal(e.code, 'llm_upstream_failed');
    assert.equal(e.httpStatus, 502);
    assert.match(e.message, /超时/);
    assert.match(e.message, /LLM 调用失败/);
    assert.deepEqual(e.details, { reason: 'timeout', timeoutMs: 30 });
    return true;
  });
  assert.ok(Date.now() - startedAt < 2000, '超时到点必须立刻给出终局，不能等到天荒地老');
});

test('超时（假 fetch 理会 AbortSignal，真实 fetch 的形态）⇒ 同样是 502 且原因为超时；日志文本已脱敏', async () => {
  const f = fakeFetch({ neverSettles: true });
  const warns = [];
  await assert.rejects(
    () => call({ fetchImpl: f.fetchImpl, timeoutMs: 20, log: { warn: (m) => warns.push(String(m)) }, logTag: 'ai-title', logContext: 'session=s1' }),
    (e) => e.code === 'llm_upstream_failed' && e.httpStatus === 502 && /超时/.test(e.message),
  );
  assert.equal(warns.length, 1, '失败必须留一条 warn（运维要能定位是上游还是我们）');
  assert.match(warns[0], /\[ai-title\].*session=s1/);
  assert.equal(warns[0].includes(API_KEY), false, '日志里不含明文 key');
});

test('缺省超时沿用收口前的现值（AI_TITLE_TIMEOUT_MS），本单不改数值', () => {
  assert.equal(LLM_CHAT_DEFAULT_TIMEOUT_MS, 15_000);
  assert.equal(LLM_CHAT_DEFAULT_TIMEOUT_MS, AI_TITLE_TIMEOUT_MS, '与 sessions.js 是同一个数');
});

// ---------------------------------------------------------------------------
// ④ 未配置 → 409；上游失败/网络错误 → 502
// ---------------------------------------------------------------------------

test('provider 未配置（缺 base_url / api_key / model 任一）⇒ 409 llm_not_configured，且一个上游请求都不发', async () => {
  for (const over of [{ base_url: '' }, { api_key: '' }, { model: '' }, { api_key: '   ' }, 'skip-provider', null]) {
    const f = fakeFetch({ respond: okResponse() });
    // 'skip-provider' / null ⇒ 根本不传 provider（连 provider 对象都没有的调用点）。
    const arg = over === 'skip-provider' || over === null ? {} : { provider: provider(over) };
    await assert.rejects(() => chatCompletion({ ...arg, messages, fetchImpl: f.fetchImpl }), (e) => {
      assert.equal(e.code, 'llm_not_configured', `未配置必须沿用现有码（不新增）：got ${e.code}`);
      assert.equal(e.httpStatus, 409);
      assert.match(e.message, /管理台/, '文案给可操作指引');
      assert.ok(Array.isArray(e.details.missing) && e.details.missing.length > 0);
      return true;
    });
    assert.equal(f.calls.length, 0, '未配置不得发起上游请求');
  }
});

test('messages 非法（空数组 / 缺 role）⇒ 400 validation_failed，不发上游', async () => {
  for (const bad of [undefined, [], [{ content: '缺 role' }], 'not-an-array']) {
    const f = fakeFetch({ respond: okResponse() });
    await assert.rejects(() => chatCompletion({ provider: provider(), messages: bad, fetchImpl: f.fetchImpl }), (e) => {
      assert.equal(e.code, 'validation_failed');
      assert.equal(e.httpStatus, 400);
      return true;
    });
    assert.equal(f.calls.length, 0);
  }
});

test('上游 5xx ⇒ 502 llm_upstream_failed，原因带 HTTP 状态码（不新增错误码）', async () => {
  for (const status of [500, 502, 503]) {
    const f = fakeFetch({ respond: response(status, { error: { message: 'upstream exploded' } }) });
    await assert.rejects(() => call({ fetchImpl: f.fetchImpl }), (e) => {
      assert.equal(e.code, 'llm_upstream_failed');
      assert.equal(e.httpStatus, 502);
      assert.match(e.message, new RegExp(`HTTP ${status}`));
      assert.match(e.message, /upstream exploded/);
      assert.deepEqual(e.details, { reason: 'upstream_status', status });
      return true;
    });
  }
});

test('网络错误（fetch 抛错）⇒ 502，原因透传；非 2xx 的响应体不是 JSON 时不给细节但仍带状态码', async () => {
  const f = fakeFetch({ throws: 'connect ECONNREFUSED 127.0.0.1:4100' });
  await assert.rejects(() => call({ fetchImpl: f.fetchImpl }), (e) => {
    assert.equal(e.code, 'llm_upstream_failed');
    assert.equal(e.httpStatus, 502);
    assert.match(e.message, /ECONNREFUSED/);
    assert.deepEqual(e.details, { reason: 'network' });
    return true;
  });

  const html = fakeFetch({ respond: response(502, null, { raw: '<html>502 Bad Gateway</html>' }) });
  await assert.rejects(() => call({ fetchImpl: html.fetchImpl }), (e) => {
    assert.equal(e.httpStatus, 502);
    assert.match(e.message, /HTTP 502/);
    assert.equal(e.message.includes('Bad Gateway'), false, '非 JSON 响应体不回显整块内容');
    return true;
  });
});

// ---------------------------------------------------------------------------
// ⑤ key 纪律：只进 Authorization 头
// ---------------------------------------------------------------------------

test('key 纪律：上游 4xx 回显了 key ⇒ 错误文本与日志都被脱敏；details 只放状态码不放 key', async () => {
  const f = fakeFetch({ respond: response(401, { error: { message: `invalid api key ${API_KEY}` } }) });
  const warns = [];
  const err = await call({ fetchImpl: f.fetchImpl, log: { warn: (m) => warns.push(String(m)) } }).catch((e) => e);
  assert.equal(err.code, 'llm_upstream_failed');
  assert.equal(err.httpStatus, 502);
  assert.match(err.message, /invalid api key \*\*\*/, '已知 key 被替换成 ***');
  assert.equal(err.message.includes(API_KEY), false, '错误文本不含明文 key');
  assert.equal(JSON.stringify(err.details).includes(API_KEY), false);
  assert.equal([...warns, err.message].join('\n').includes(API_KEY), false);
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${API_KEY}`, 'key 该在的地方仍在');
});

test('key 纪律：上游错误文本里是**别家**的 sk- 形态串也会被遮（redactSecret 的兜底形态）', () => {
  assert.equal(redactSecret('nested sk-abcdefgh123 leaked', API_KEY).includes('abcdefgh123'), false);
  assert.equal(redactSecret(`used ${API_KEY} here`, API_KEY), 'used *** here');
  assert.equal(redactSecret('x'.repeat(400), API_KEY).length, 200, '长度截断（不进无限长的上游回声）');
});

// ---------------------------------------------------------------------------
// ⑥ 结构不变量：portal 侧只有一个地方构造 chat/completions
// ---------------------------------------------------------------------------

test('收口证明：portal/src 里构造 chat/completions 的文件只有 llm-chat.js；sessions.js 不再手搓 fetch/超时', () => {
  const srcDir = path.resolve(HERE, '../src');
  const builders = fs.readdirSync(srcDir)
    .filter((name) => name.endsWith('.js'))
    .filter((name) => fs.readFileSync(path.join(srcDir, name), 'utf8').includes('/chat/completions'));
  assert.deepEqual(builders, ['llm-chat.js'],
    'URL 拼接必须只在 llm-chat.js；再出现第二个文件 = 又有人手搓了一次对话请求');

  const sessionsSrc = fs.readFileSync(path.join(srcDir, 'sessions.js'), 'utf8');
  assert.equal(/fetch\s*\(/.test(sessionsSrc), false, 'sessions.js 里不该再出现 fetch 调用');
  assert.equal(sessionsSrc.includes('new AbortController'), false, '超时逻辑归 llm-chat.js');
  assert.equal(/max_tokens\s*:/.test(sessionsSrc), false, '请求体（含 max_tokens 这个键）归 llm-chat.js 构造');
  assert.match(sessionsSrc, /from '\.\/llm-chat\.js'/, 'AI 改名改为消费统一 client');
});

test('llm-chat.js 零依赖：不 import 任何模块（更不 import erix-agent），也不引新依赖', () => {
  const src = fs.readFileSync(path.join(HERE, '../src/llm-chat.js'), 'utf8');
  assert.equal(/^\s*import\s/m.test(src), false, '本文件必须保持零 import（含 erix-agent）');
  assert.equal(/from\s+'erix-agent'/.test(src), false, '不许把引擎包拉进对话调用面（凭据纪律：真 key 在 runner 侧）');
  assert.equal(/require\s*\(/.test(src), false, '零依赖也适用于 CJS 形态');
});

test('ErrorCtor 注入：sessions.js 传 SessionError ⇒ http.js 的错误映射面不变（同一个类型 / 同一个码）', async () => {
  const notConfigured = await chatCompletion({ provider: provider({ api_key: '' }), messages, ErrorCtor: SessionError })
    .catch((e) => e);
  assert.ok(notConfigured instanceof SessionError, '必须是 SessionError（否则 http.js 映射不到 ⇒ 500）');
  assert.equal(notConfigured.code, 'llm_not_configured');
  assert.equal(notConfigured.httpStatus, 409);

  const upstream = await chatCompletion({
    provider: provider(), messages, ErrorCtor: SessionError,
    fetchImpl: fakeFetch({ respond: response(500, { error: { message: 'boom' } }) }).fetchImpl,
    log: { warn() {} },
  }).catch((e) => e);
  assert.ok(upstream instanceof SessionError);
  assert.equal(upstream.code, 'llm_upstream_failed');
  assert.equal(upstream.httpStatus, 502);

  // 缺省类型是自己家的错误类（构造签名与 SessionError 同构）。
  const bare = await chatCompletion({ provider: provider({ model: '' }), messages, fetchImpl: fakeFetch({ respond: okResponse() }).fetchImpl }).catch((e) => e);
  assert.ok(bare instanceof LlmChatError);
  assert.equal(bare.name, 'LlmChatError');
});
