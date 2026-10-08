// 单测：runner 侧会话标题生成（issue #88 修订——agent 侧生成、随 run_finished 上报、portal 落库）。
// 覆盖：
//   * 纯函数：sanitizeTitle（自 portal 同函数移植，各守一侧）、buildTitlePrompt（首条用户消息
//     + finalText 各截 500 字符、≤30 字符约束）、resolveFirstUserContent（P3 PR③ 后只取当前 task）。
//   * generateSessionTitle（mock provider，零网络）：成功清洗落值、失败/超时/空/纯 reasoning → 空串，
//     缺 provider → 空串；断言非流式参数（maxTokens 512 / temperature 0.2 / AbortSignal 注入）。
// 隔离约定（docs/testing.md §2.1）：不碰真实网络 / LLM。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_TITLE_MAX_LEN,
  AUTO_TITLE_TIMEOUT_MS,
  sanitizeTitle,
  buildTitlePrompt,
  resolveFirstUserContent,
  generateSessionTitle,
} from '../lib/session-title.js';

// ---------------------------------------------------------------------------
// 纯函数：清洗 / prompt / 首条用户消息推导
// ---------------------------------------------------------------------------

test('sanitizeTitle：去包裹/首行/折叠空白/截断 ≤30 字符；空 → null（与 portal 侧同构）', () => {
  assert.equal(sanitizeTitle('修复登录流程'), '修复登录流程');
  assert.equal(sanitizeTitle('「修复登录流程」'), '修复登录流程', '去中文引号');
  assert.equal(sanitizeTitle('"Fix login"'), 'Fix login', '去英文引号');
  assert.equal(sanitizeTitle('《发布脚本》'), '发布脚本', '去书名号');
  assert.equal(sanitizeTitle('第一行\n第二行'), '第一行', '取首行');
  assert.equal(sanitizeTitle('  a   b  '), 'a b', '折叠空白');
  assert.equal(sanitizeTitle('   '), null);
  assert.equal(sanitizeTitle(''), null);
  assert.equal(sanitizeTitle(null), null);
  assert.equal(sanitizeTitle(undefined), null);
  assert.equal(sanitizeTitle('长'.repeat(50)), '长'.repeat(AUTO_TITLE_MAX_LEN), '截断到 30 字符');
});

test('buildTitlePrompt：含首条用户消息 + finalText + 长度约束；finalText 截 500 字符', () => {
  const p = buildTitlePrompt({ firstUserContent: '修复登录', finalText: '已修复并补测试' });
  assert.ok(p.includes(`不超过 ${AUTO_TITLE_MAX_LEN} 个字符`));
  assert.ok(p.includes('只输出标题文本本身'), '要求纯文本标题');
  assert.ok(p.includes('对话首条用户消息：修复登录'));
  assert.ok(p.includes('助手最终回复摘要：已修复并补测试'));
  // finalText 与首条相同 → 不重复携带。
  const p2 = buildTitlePrompt({ firstUserContent: 'hi', finalText: 'hi' });
  assert.ok(!p2.includes('助手最终回复摘要'));
  // 各截 500 字符（防超长输入）。
  const long = 'x'.repeat(1000);
  const p3 = buildTitlePrompt({ firstUserContent: long, finalText: long });
  assert.ok(p3.includes(`对话首条用户消息：${'x'.repeat(500)}`));
  assert.ok(!p3.includes('x'.repeat(501)), '首条用户消息截断在 500 字符');
});

test('resolveFirstUserContent：P3 PR③ 后只取 task（历史下行已退役）；空白/缺失 → null', () => {
  assert.equal(resolveFirstUserContent({ task: '当前任务' }), '当前任务');
  // 旧形状入参（已退役的 history）不再参与推导：只能返回 task。
  assert.equal(
    resolveFirstUserContent({ history: [{ role: 'user', content: '会话首条' }], task: '当前任务' }),
    '当前任务',
    'history 已不再是取数源',
  );
  assert.equal(resolveFirstUserContent({ task: '   ' }), null, '空白 task → null');
  assert.equal(resolveFirstUserContent({ task: '' }), null);
  assert.equal(resolveFirstUserContent({}), null);
});

// ---------------------------------------------------------------------------
// generateSessionTitle：mock provider（零网络）
// ---------------------------------------------------------------------------

/** mock OpenAI provider：script 为响应对象 / Error / 函数(req)。 */
function mockProvider(script) {
  const calls = [];
  const chat = async (req) => {
    calls.push(req);
    const s = typeof script === 'function' ? script(req) : script;
    if (s instanceof Error) throw s;
    return s;
  };
  return { provider: { chat }, calls };
}

const OK_RES = { content: [{ type: 'text', text: '「修复登录白屏」' }], stopReason: 'stop' };

test('generateSessionTitle：成功 → 清洗后标题；非流式小请求参数锚定', async () => {
  const { provider, calls } = mockProvider(OK_RES);
  const title = await generateSessionTitle({
    provider, firstUserContent: '帮我修复登录白屏', finalText: 'done', log: { warn() {} },
  });
  assert.equal(title, '修复登录白屏', '引号包裹被清洗');
  assert.equal(calls.length, 1);
  const req = calls[0];
  assert.equal(req.maxTokens, 512, 'maxTokens 512（给思考型模型 reasoning 余量）');
  assert.equal(req.temperature, 0.2);
  assert.ok(req.signal instanceof AbortSignal, 'AbortController 信号注入（10s 超时）');
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].role, 'user');
  assert.ok(req.messages[0].content.includes('帮我修复登录白屏'));
  assert.ok(req.messages[0].content.includes('done'), 'prompt 含 finalText');
});

test('generateSessionTitle：provider.chat 抛错 → 空串（不阻塞终态上报）', async () => {
  const { provider } = mockProvider(new Error('connect ECONNREFUSED'));
  const warns = [];
  const title = await generateSessionTitle({
    provider, firstUserContent: 'hi', finalText: '', log: { warn: (m) => warns.push(m) },
  });
  assert.equal(title, '');
  assert.ok(warns.some((m) => m.includes('ECONNREFUSED')), '失败留 warn 便于排查');
});

test('generateSessionTitle：超时 → AbortController 触发 → 空串', async () => {
  // 模拟不返回的 LLM：一直等 abort 信号（真实路径 = 10s；测试用 30ms 短超时锚定语义）。
  const { provider, calls } = mockProvider((req) => new Promise((_, reject) => {
    req.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
  }));
  const started = Date.now();
  const title = await generateSessionTitle({
    provider, firstUserContent: 'hi', finalText: '', timeoutMs: 30, log: { warn() {} },
  });
  assert.equal(title, '');
  assert.ok(Date.now() - started < 2000, '超时快速返回，不拖住 run_finished');
  assert.equal(calls.length, 1);
});

test('generateSessionTitle：空 content / 纯 reasoning / 清洗后空 → 空串', async () => {
  assert.equal(await generateSessionTitle({ provider: mockProvider({ content: [] }).provider, log: { warn() {} } }), '');
  assert.equal(
    await generateSessionTitle({ provider: mockProvider({ content: [{ type: 'reasoning', text: '思考中…' }] }).provider, log: { warn() {} } }),
    '',
    '纯 reasoning（无 text block）→ 空串',
  );
  assert.equal(
    await generateSessionTitle({ provider: mockProvider({ content: [{ type: 'text', text: '「」' }] }).provider, log: { warn() {} } }),
    '',
    '清洗后为空（引号无内容）→ 空串',
  );
});

test('generateSessionTitle：缺 provider / chat 非函数 → 空串（静默跳过）', async () => {
  assert.equal(await generateSessionTitle({ provider: null, log: { warn() {} } }), '');
  assert.equal(await generateSessionTitle({ provider: {}, log: { warn() {} } }), '');
  assert.equal(await generateSessionTitle({ log: { warn() {} } }), '');
});

test('generateSessionTitle：默认超时为 10s（与实现口径一致）', () => {
  assert.equal(AUTO_TITLE_TIMEOUT_MS, 10_000);
});
