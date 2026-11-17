// issue #596 片 B：管理台「提示词」页的单测（`AdminPromptsView.vue`，契约 `docs/api/portal.md` §4.19）。
//
// 装配照 `AdminUploadView.spec.ts`：直接挂视图（本页不依赖路由）+ 真实 i18n 单例 + pinia +
// 按 URL/方法分派的 fetch 桩（判据要读**请求体**，所以桩必须把 body 记下来）。
// ⚠ 断言一律走 DOM / 请求桩，**不用 `w.emitted()`**（本机 `NODE_ENV=production` 下恒空 ⇒ 假红）。
//
// 用例名 F1–F7 就是工单里的判据编号：
//   F1 挂载只发 1 次 GET
//   F2 保存后页面显示的是**响应 DTO** 的值，不是输入值（响应出自 `RETURNING`）
//   F3 覆写态与默认态文案不同，且「恢复内置」发的 body 是 `{"text":""}`
//   F4 `materializeEnqueued=0` 时那句警告出现、`>0` 时不出现
//   F5 `400` 带 `details.field` 时对应输入框被标红（别的卡不标）
//   F6 只读卡 4 个 key 全渲染，且页面不含任何提示词全文
//   F7 生效时机三条各不相同（三张卡各自的时机文案，不许共用一句）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import AdminPromptsView from './AdminPromptsView.vue';
import { i18n, setLocale } from '../i18n';
import { useAdminStore } from '../stores/admin';
import { READONLY_PROMPT_KEYS } from '../lib/platformPrompts';

const GET_PATH = '/api/admin/prompts';
const PUT_PATHS = {
  addendum: '/api/admin/prompts/addendum',
  agentsMd: '/api/admin/prompts/agents-md',
  titlePrompt: '/api/admin/prompts/title-prompt',
} as const;

/**
 * 只读那 4 条**真实的开头**（取自 `runner/`）。它们一个字节都不该出现在页面上：
 * portal 镜像只 `COPY portal/ portal/`，后端 `readonly[]` 也只给 `key`。
 */
const RUNNER_TEXTS = [
  '你是运行在 FDE 工作台容器中的编码 agent',
  '你是由父 run 派出的**子 run**',
  'compaction_strategy_fallback',
];

/** 后端 `P8c` 钉住的 GET DTO（默认态：三块全跟随内置）。全文位都是可识别的哨兵。 */
function dto(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    addendum: { text: '', isDefault: true, maxBytes: 8192, bytes: 0 },
    agentsMd: {
      override: '', isOverridden: false, isDefault: true,
      templateBytes: 9231, effectiveBytes: 9231,
      effectiveText: 'EFFECTIVE-AGENTS-MD-FULL-TEXT',
      maxBytes: 16384, renderedLimitBytes: 16384,
    },
    titlePrompt: {
      text: '', isDefault: true, maxBytes: 2000, bytes: 0,
      defaultText: 'TITLE-SYSTEM-PROMPT-FULL-TEXT',
    },
    readonly: READONLY_PROMPT_KEYS.map((key) => ({ key })),
    updatedAt: null,
    updatedBy: null,
    reason: 'no_row',
    ...over,
  };
}

/** 覆写态的 DTO（`override` 非空 ⇒ 「已偏离内置模板」）。 */
function overriddenDto(over: Record<string, unknown> = {}) {
  return dto({
    agentsMd: {
      override: '- 收工前跑 smoke。', isOverridden: true, isDefault: false,
      templateBytes: 9231, effectiveBytes: 9260,
      effectiveText: 'EFFECTIVE-AGENTS-MD-FULL-TEXT',
      maxBytes: 16384, renderedLimitBytes: 16384,
    },
    updatedAt: '2026-11-16T09:00:00.000Z',
    updatedBy: '3f2c0000-0000-4000-8000-0000000000a1',
    reason: null,
    ...over,
  });
}

interface RecordedCall { url: string; method: string; body: unknown }
type Handler = (call: RecordedCall) => Response | undefined | Promise<Response | undefined>;

function stubFetch(handler: Handler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = typeof init?.body === 'string' ? init.body : null;
    const call: RecordedCall = { url, method, body: raw === null ? null : JSON.parse(raw) };
    calls.push(call);
    const response = await handler(call);
    if (!response) throw new Error(`fetch 桩没有处理 ${method} ${url}`);
    return response;
  }));
  return calls;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string, details?: Record<string, unknown>): Response {
  return jsonResponse(status, { error: { code, message, retryable: false, ...(details ? { details } : {}) } });
}

/** 把「刚保存那一格」换成落库后的值（其余保持默认）+ `materializeEnqueued: 2`。 */
function savedDto(path: string, text: string): Record<string, unknown> {
  if (path === PUT_PATHS.agentsMd) {
    return dto({
      agentsMd: {
        override: text, isOverridden: text !== '', isDefault: text === '',
        templateBytes: 9231, effectiveBytes: 9231,
        effectiveText: 'EFFECTIVE-AGENTS-MD-FULL-TEXT',
        maxBytes: 16384, renderedLimitBytes: 16384,
      },
      materializeEnqueued: 2,
    });
  }
  if (path === PUT_PATHS.titlePrompt) {
    return dto({
      titlePrompt: {
        text, isDefault: text === '', maxBytes: 2000, bytes: text.length,
        defaultText: 'TITLE-SYSTEM-PROMPT-FULL-TEXT',
      },
      materializeEnqueued: 0,
    });
  }
  return dto({
    addendum: { text, isDefault: text === '', maxBytes: 8192, bytes: text.length },
    materializeEnqueued: 2,
  });
}

/** 默认桩：GET 回 `get`；PUT 回 `put(call)`（缺省 = 原样落库 + 通知 2 台）。 */
function stubDefault(
  get: unknown,
  put?: (call: RecordedCall) => Response,
): RecordedCall[] {
  const putPaths: readonly string[] = Object.values(PUT_PATHS);
  return stubFetch((call) => {
    if (call.url === GET_PATH && call.method === 'GET') return jsonResponse(200, get);
    if (call.method === 'PUT' && putPaths.includes(call.url)) {
      const text = (call.body as { text: string }).text;
      return put ? put(call) : jsonResponse(200, savedDto(call.url, text));
    }
    return undefined;
  });
}

async function mountView(): Promise<VueWrapper> {
  const wrapper = mount(AdminPromptsView, { global: { plugins: [i18n] } });
  await flushPromises();
  return wrapper;
}

const text = (w: VueWrapper, testId: string) => w.get(`[data-test="${testId}"]`).text();
const exists = (w: VueWrapper, testId: string) => w.find(`[data-test="${testId}"]`).exists();
const textareaEl = (w: VueWrapper, field: string) =>
  w.get(`[data-test="input-${field}"]`).element as HTMLTextAreaElement;
const gets = (calls: RecordedCall[]) => calls.filter((c) => c.method === 'GET');
const puts = (calls: RecordedCall[]) => calls.filter((c) => c.method === 'PUT');

async function setDraft(w: VueWrapper, field: string, value: string) {
  await w.get(`[data-test="input-${field}"]`).setValue(value);
  await flushPromises();
}

async function click(w: VueWrapper, testId: string) {
  await w.get(`[data-test="${testId}"]`).trigger('click');
  await flushPromises();
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('F1 挂载只发 1 次 GET', () => {
  it('一次 GET 打到 /api/admin/prompts；来源、字节数与上限一起渲染', async () => {
    const calls = stubDefault(dto());
    const w = await mountView();

    expect(gets(calls)).toHaveLength(1);
    expect(gets(calls)[0].url).toBe(GET_PATH);
    expect(puts(calls)).toHaveLength(0);
    // 「三块都在跟随内置」+ 每卡的字节数与上限（少一条这一页就没价值）
    expect(text(w, 'source-addendum')).toContain('跟随内置');
    expect(text(w, 'bytes-addendum')).toContain('8 KiB');
    expect(text(w, 'bytes-titlePrompt')).toContain('1.95 KiB');
    expect(text(w, 'agents-md-render-budget')).toContain('16 KiB');
    // 预算口径必须说清：DTO 那个数用示例名 `example` 渲染，而写侧闸按最长合法工位名算
    // （契约 §4.19-3 评审 F2）⇒ 不写清就变成「页面没顶到上限就存得进去」的错承诺。
    expect(text(w, 'agents-md-render-budget-note')).toContain('example');
    expect(text(w, 'agents-md-render-budget-note')).toContain('最长合法工位名');
  });

  it('store 侧：loadPlatformPrompts 成功返回 null 且 loaded=true（区分「没请求」与「服务端回的是内置」）', async () => {
    stubDefault(dto());
    await mountView();
    const store = useAdminStore();
    expect(store.platformPromptsLoaded).toBe(true);
    expect(store.platformPromptsErr).toBeNull();
    expect(store.platformPrompts?.reason).toBe('no_row');
  });

  it('GET 失败（非 200）⇒ 给错误条，不白屏', async () => {
    stubFetch((call) => (call.method === 'GET'
      ? errorResponse(500, 'internal', 'db down')
      : undefined));
    const w = await mountView();
    expect(exists(w, 'prompts-load-error')).toBe(true);
    expect(exists(w, 'card-addendum')).toBe(false);
  });

  it('`reason` 三种回落各一句话，后端新增的 reason 不许塌成「没配过」', async () => {
    stubDefault(dto({ reason: 'read_timeout' }));
    const w = await mountView();
    expect(text(w, 'prompts-reason')).toContain('PLATFORM_PROMPTS_READ_TIMEOUT_MS');

    stubDefault(dto({ reason: 'read_failed' }));
    const w2 = await mountView();
    expect(text(w2, 'prompts-reason')).toContain('读不到 platform_prompts');

    stubDefault(dto({ reason: 'read_lagging' }));
    const w3 = await mountView();
    expect(text(w3, 'prompts-reason')).toContain('不认识');
  });
});

describe('F2 保存后显示响应 DTO 的值，不是输入值', () => {
  it('输入「我敲的」，服务端回的是「落库的」⇒ 文本框变成后者', async () => {
    stubDefault(dto(), () => jsonResponse(200, dto({
      addendum: { text: '落库的（RETURNING 那份）', isDefault: false, maxBytes: 8192, bytes: 30 },
      materializeEnqueued: 2,
    })));
    const w = await mountView();
    await setDraft(w, 'addendum', '我敲的');
    await click(w, 'save-addendum');

    expect(textareaEl(w, 'addendum').value).toBe('落库的（RETURNING 那份）');
    expect(text(w, 'source-addendum')).toContain('DB 覆写');
    expect(exists(w, 'saved-addendum')).toBe(true);
  });

  it('保存失败时草稿保持用户写的内容（不许把他刚写的清空）', async () => {
    stubDefault(dto(), () => errorResponse(400, 'validation_failed', 'text 超过上限 8192 字节', {
      field: 'text', max_bytes: 8192,
    }));
    const w = await mountView();
    await setDraft(w, 'addendum', '一段越界的话');
    await click(w, 'save-addendum');

    expect(textareaEl(w, 'addendum').value).toBe('一段越界的话');
    expect(exists(w, 'saved-addendum')).toBe(false);
  });

  it('请求体只有一个 `text`（字符串，原样不 trim）', async () => {
    const calls = stubDefault(dto());
    const w = await mountView();
    await setDraft(w, 'titlePrompt', '  带空白  ');
    await click(w, 'save-titlePrompt');

    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0].url).toBe(PUT_PATHS.titlePrompt);
    expect(JSON.stringify(puts(calls)[0].body)).toBe('{"text":"  带空白  "}');
  });
});

describe('F3 覆写态与默认态文案不同 + 恢复内置', () => {
  it('默认态：「跟随内置模板」，没有「恢复内置」按钮', async () => {
    stubDefault(dto());
    const w = await mountView();
    expect(text(w, 'agents-md-follows')).toContain('跟随内置模板');
    expect(exists(w, 'agents-md-deviated')).toBe(false);
    expect(exists(w, 'restore-builtin')).toBe(false);
  });

  it('覆写态：「已偏离内置模板」+ 恢复内置按钮，且两态文案不是一句', async () => {
    stubDefault(overriddenDto());
    const w = await mountView();
    expect(text(w, 'agents-md-deviated')).toContain('已偏离内置模板');
    expect(exists(w, 'agents-md-follows')).toBe(false);
    expect(text(w, 'source-agentsMd')).toContain('DB 覆写');
    expect(exists(w, 'restore-builtin')).toBe(true);
  });

  it('点「恢复内置」发的 body 恰好是 {"text":""}（不是另一个端点、不带别的键）', async () => {
    const calls = stubFetch((call) => {
      if (call.url === GET_PATH && call.method === 'GET') return jsonResponse(200, overriddenDto());
      if (call.url === PUT_PATHS.agentsMd && call.method === 'PUT') {
        return jsonResponse(200, dto({ materializeEnqueued: 2 }));
      }
      return undefined;
    });
    const w = await mountView();
    await click(w, 'restore-builtin');

    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0].url).toBe(PUT_PATHS.agentsMd);
    expect(JSON.stringify(puts(calls)[0].body)).toBe('{"text":""}');
    // 恢复之后页面回到默认态（响应 DTO 就是新的真相）
    expect(exists(w, 'agents-md-follows')).toBe(true);
    expect(textareaEl(w, 'agentsMd').value).toBe('');
  });

  it('「查看当前生效全文」默认收起，展开后是只读的 `effectiveText` 且可复制', async () => {
    stubDefault(dto());
    const w = await mountView();
    expect(exists(w, 'effective-text')).toBe(false);
    await click(w, 'toggle-effective');
    expect(text(w, 'effective-text')).toBe('EFFECTIVE-AGENTS-MD-FULL-TEXT');
    expect(w.get('[data-test="effective-text"]').element.tagName).toBe('PRE');

    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => { written.push(value); } },
    });
    await click(w, 'copy-effective');
    expect(written).toEqual(['EFFECTIVE-AGENTS-MD-FULL-TEXT']);
    expect(exists(w, 'copy-ok')).toBe(true);
  });
});

describe('F4 materializeEnqueued=0 的警告不许静默', () => {
  it('保存追加段回 0 ⇒ 出现「已保存，但物化未通知（portal 重启后全量重建收敛）」', async () => {
    stubDefault(dto(), () => jsonResponse(200, dto({
      addendum: { text: '- 收工前跑 smoke。', isDefault: false, maxBytes: 8192, bytes: 24 },
      materializeEnqueued: 0,
    })));
    const w = await mountView();
    await setDraft(w, 'addendum', '- 收工前跑 smoke。');
    await click(w, 'save-addendum');

    expect(text(w, 'materialize-addendum')).toContain('已保存，但物化未通知');
    expect(text(w, 'materialize-addendum')).toContain('portal 重启后全量重建收敛');
    expect(text(w, 'materialize-addendum')).not.toContain('已生效');
  });

  it('同一个保存回 2 ⇒ 那句不出现，改成「已通知 2 台」', async () => {
    stubDefault(dto(), () => jsonResponse(200, dto({
      addendum: { text: '- 收工前跑 smoke。', isDefault: false, maxBytes: 8192, bytes: 24 },
      materializeEnqueued: 2,
    })));
    const w = await mountView();
    await setDraft(w, 'addendum', '- 收工前跑 smoke。');
    await click(w, 'save-addendum');

    expect(exists(w, 'materialize-addendum')).toBe(true);
    expect(text(w, 'materialize-addendum')).not.toContain('物化未通知');
    expect(text(w, 'materialize-addendum')).toContain('已通知 2 个');
  });

  it('响应没带那个键 ⇒ 按「未通知」处理，不许说成已生效', async () => {
    stubDefault(dto(), () => jsonResponse(200, dto({
      addendum: { text: 'x', isDefault: false, maxBytes: 8192, bytes: 1 },
    })));
    const w = await mountView();
    await setDraft(w, 'addendum', 'x');
    await click(w, 'save-addendum');
    expect(text(w, 'materialize-addendum')).toContain('没回 materializeEnqueued');
  });

  it('标题提示词的 `materializeEnqueued=0` 不说「物化未通知」（它本来就不涉物化）', async () => {
    stubDefault(dto(), () => jsonResponse(200, dto({
      titlePrompt: {
        text: '起个短标题', isDefault: false, maxBytes: 2000, bytes: 15,
        defaultText: 'TITLE-SYSTEM-PROMPT-FULL-TEXT',
      },
      materializeEnqueued: 0,
    })));
    const w = await mountView();
    await setDraft(w, 'titlePrompt', '起个短标题');
    await click(w, 'save-titlePrompt');

    expect(exists(w, 'materialize-titlePrompt')).toBe(false);
    expect(text(w, 'saved-titlePrompt')).toContain('已保存');
  });
});

describe('F5 400 按 details.field 标红对应的框', () => {
  it('保存追加段回 400 + details.field=text ⇒ 只有追加段那个框 aria-invalid', async () => {
    stubDefault(dto(), () => errorResponse(400, 'validation_failed', '渲染后的整份 ~/AGENTS.md 超过注入上限', {
      field: 'text', max_bytes: 8192, rendered_bytes: 20000, render_limit_bytes: 16384,
    }));
    const w = await mountView();
    await setDraft(w, 'addendum', 'x'.repeat(9000));
    await click(w, 'save-addendum');

    expect(textareaEl(w, 'addendum').getAttribute('aria-invalid')).toBe('true');
    expect(textareaEl(w, 'agentsMd').getAttribute('aria-invalid')).not.toBe('true');
    expect(textareaEl(w, 'titlePrompt').getAttribute('aria-invalid')).not.toBe('true');
    expect(text(w, 'field-error-addendum')).toContain('注入上限');
    expect(useAdminStore().promptSaveField).toBe('addendum');
    // 越界的提前提示也在（不拦截：请求真的发出去了）
    expect(exists(w, 'over-limit-addendum')).toBe(true);
  });

  it('存整段覆写时的 400 标的是覆写那个框（`details.field` 不点卡片名 ⇒ 由发送方定）', async () => {
    stubDefault(dto(), () => errorResponse(400, 'validation_failed', 'text 必须是字符串', {
      field: 'text', max_bytes: 16384,
    }));
    const w = await mountView();
    await setDraft(w, 'agentsMd', '正文');
    await click(w, 'save-agentsMd');

    expect(textareaEl(w, 'agentsMd').getAttribute('aria-invalid')).toBe('true');
    expect(textareaEl(w, 'addendum').getAttribute('aria-invalid')).not.toBe('true');
  });

  it('认不出的 details.field ⇒ 不猜是哪个框（退化成整页一条错误）', async () => {
    stubDefault(dto(), () => errorResponse(400, 'validation_failed', '请求体必须是对象', {
      field: 'something_else',
    }));
    const w = await mountView();
    await setDraft(w, 'addendum', 'x');
    await click(w, 'save-addendum');

    expect(useAdminStore().promptSaveField).toBeNull();
    for (const field of ['addendum', 'agentsMd', 'titlePrompt']) {
      expect(textareaEl(w, field).getAttribute('aria-invalid')).not.toBe('true');
    }
    expect(useAdminStore().promptSaveErr).toContain('请求体必须是对象');
  });

  it('500 不指字段（只有 400 才映射到框）', async () => {
    stubDefault(dto(), () => errorResponse(500, 'internal', '保存成功但审计写了 0 行'));
    const w = await mountView();
    await setDraft(w, 'addendum', 'x');
    await click(w, 'save-addendum');
    expect(useAdminStore().promptSaveField).toBeNull();
    expect(useAdminStore().promptSaveErr).toContain('审计写了 0 行');
  });
});

describe('F6 只读卡：4 个 key 全渲染，且页面不含任何提示词全文', () => {
  it('4 个 key 各有一条「住在哪 + 改它的代价」，并明写本页不显示全文', async () => {
    stubDefault(dto());
    const w = await mountView();

    for (const key of READONLY_PROMPT_KEYS) {
      expect(exists(w, `readonly-${key}`), `只读条目 ${key} 必须渲染`).toBe(true);
      expect(text(w, `readonly-${key}`)).toContain(key);
      expect(text(w, `readonly-${key}`)).toContain('住在');
      expect(text(w, `readonly-${key}`)).toContain('镜像');
    }
    expect(text(w, 'readonly-no-fulltext')).toContain('不显示它们的全文');
    expect(text(w, 'readonly-no-fulltext')).toContain('runner/');
    // `updatedBy` 没给 ⇒ 「—」而不是空（空着就是"没人改过"的样子）
    expect(text(w, 'prompts-updated-by')).toBe('—');
    expect(text(w, 'prompts-updated-at')).toContain('从未保存');
  });

  it('后端即使误发 `text` 也不显示；镜像里那几条的全文一个字节都不出现在页面上', async () => {
    stubDefault(dto({
      readonly: [
        { key: 'runnerSystemPrompt', text: RUNNER_TEXTS[0] },
        { key: 'childSystemPrompt', text: RUNNER_TEXTS[1] },
        { key: 'toolDescriptions', text: '文件工具怎么用（照做可省掉大量返工）' },
        { key: 'engineNotices', text: RUNNER_TEXTS[2] },
      ],
    }));
    const w = await mountView();
    const page = w.text();
    for (const runnerText of RUNNER_TEXTS) {
      expect(page, `页面不该出现 runner 文本：${runnerText}`).not.toContain(runnerText);
    }
    expect(w.find('[data-test="card-readonly"] pre').exists()).toBe(false);
    expect(w.find('[data-test="card-readonly"] textarea').exists()).toBe(false);
    // 生效全文（portal 自己渲染的 ~/AGENTS.md）默认收起 ⇒ 首屏也不含任何全文
    expect(page).not.toContain('EFFECTIVE-AGENTS-MD-FULL-TEXT');
    expect(page).not.toContain('TITLE-SYSTEM-PROMPT-FULL-TEXT');
  });

  it('后端多给一个前端没文案的 key ⇒ 按原文列出来，不编一句说明', async () => {
    stubDefault(dto({
      readonly: [{ key: 'engineNotices' }, { key: 'engineSomethingNew' }],
    }));
    const w = await mountView();
    expect(text(w, 'readonly-unknown')).toContain('engineSomethingNew');
    expect(exists(w, 'readonly-engineNotices')).toBe(true);
  });

  it('`updatedBy` 只有 uuid ⇒ 显示成短 uuid，不是空着像没改过', async () => {
    stubDefault(overriddenDto());
    const w = await mountView();
    expect(text(w, 'prompts-updated-by')).toContain('3f2c0000');
    expect(text(w, 'prompts-updated-by').trim()).not.toBe('');
    expect(text(w, 'prompts-updated-at')).not.toContain('从未保存');
  });
});

describe('F7 三条生效时机各不相同', () => {
  it('三张卡各自的时机文案两两不同，各自点到自己的落点', async () => {
    stubDefault(dto());
    const w = await mountView();

    const addendum = text(w, 'timing-addendum');
    const agentsMd = text(w, 'timing-agentsMd');
    const title = text(w, 'timing-titlePrompt');
    expect(addendum).not.toBe(agentsMd);
    expect(addendum).not.toBe(title);
    expect(agentsMd).not.toBe(title);

    // 追加段：下一次 run
    expect(addendum).toContain('下一次 run');
    expect(addendum).not.toContain('改名');
    // 整段覆写：也是下一次 run，但要说清「入队失败要等全量重建」这条与追加段不同的后果
    expect(agentsMd).toContain('下一次 run');
    expect(agentsMd).toContain('全量重建');
    // 标题提示词：下一次改名，且不涉物化
    expect(title).toContain('下一次改名');
    expect(title).not.toContain('下一次 run');
  });

  it('英文 locale 下三条同样各不相同（双语都真的写了）', async () => {
    setLocale('en');
    stubDefault(dto());
    const w = await mountView();
    const three = [
      text(w, 'timing-addendum'),
      text(w, 'timing-agentsMd'),
      text(w, 'timing-titlePrompt'),
    ];
    expect(new Set(three).size).toBe(3);
    expect(three[2]).toContain('next rename');
    expect(text(w, 'source-addendum')).toContain('built-in');
  });
});

describe('store 层：三个 save action 与「连长度都算不出」那道闸', () => {
  it('addendum / agentsMd / titlePrompt 各打自己的 URL（slug 只在 lib 一处）', async () => {
    const calls = stubDefault(dto());
    await mountView();
    const store = useAdminStore();

    await store.saveAddendumPrompt('a');
    await store.saveAgentsMdPrompt('b');
    await store.saveTitlePrompt('c');
    expect(puts(calls).map((call) => call.url)).toEqual([
      PUT_PATHS.addendum, PUT_PATHS.agentsMd, PUT_PATHS.titlePrompt,
    ]);
  });

  it('草稿不是字符串 ⇒ 零请求 + 指到那张卡（不发一个必然 400 的垃圾体）', async () => {
    const calls = stubDefault(dto());
    await mountView();
    const store = useAdminStore();

    const err = await store.saveAddendumPrompt(undefined);
    expect(err).toContain('连长度都算不出');
    expect(puts(calls)).toHaveLength(0);
    expect(gets(calls)).toHaveLength(1);
    expect(store.promptSaveField).toBe('addendum');
    expect(store.promptSavedField).toBeNull();
  });

  it('成功后状态里是响应 DTO（含 materializeEnqueued），`promptNotice` 是语义结论', async () => {
    stubDefault(dto(), () => jsonResponse(200, dto({
      addendum: { text: '落库的', isDefault: false, maxBytes: 8192, bytes: 9 },
      materializeEnqueued: 0,
    })));
    await mountView();
    const store = useAdminStore();

    await store.saveAgentsMdPrompt('x');
    expect(store.platformPrompts?.addendum.text).toBe('落库的');
    expect(store.platformPrompts?.materializeEnqueued).toBe(0);
    expect(store.promptNotice).toBe('not_enqueued');
    expect(store.promptSavedField).toBe('agentsMd');
    expect(store.promptSaving).toBe(false);
  });
});

describe('英文 locale 的同一页（双语都真的写了）', () => {
  it('物化未通知那句、只读卡那句都是英文', async () => {
    setLocale('en');
    stubDefault(dto(), () => jsonResponse(200, dto({
      addendum: { text: 'x', isDefault: false, maxBytes: 8192, bytes: 1 },
      materializeEnqueued: 0,
    })));
    const w = await mountView();
    await setDraft(w, 'addendum', 'x');
    await click(w, 'save-addendum');

    expect(text(w, 'materialize-addendum')).toContain('materialization was not notified');
    expect(text(w, 'readonly-no-fulltext')).toContain('does not show their text');
    expect(text(w, 'source-addendum')).not.toMatch(/[一-鿿]/);
  });
});

// 界面缺陷回归（issue #596 片 B）：这一页把 markdown 星号**原样显示**出来了 —— 宿主截图
// `/docker/erix_station_playwright/596-after-save.png` 里肉眼可见 `**next run**`、`**not**`。
// 成因：整个前端**没有 markdown 渲染器**（也不打算为一句文案加依赖），i18n 文案在模板里是
// `{{ t('…') }}` 纯文本插值 ⇒ 文案里的记号就是界面上的杂字符。要强调请用 class（那些
// `text-emerald-800` / `text-amber-700` 已经在做）。
// 断言走 DOM（**不用 `w.emitted()`**：本机 NODE_ENV=production 下恒空 ⇒ 假红）。
// ⚠ 只钉被点名的那几行：`readonly-*` 条目里的 `fde-*` 是真 glob 写法，不是 markdown。
describe('markdown 星号不许进界面：三张卡的 timing-* 与 readonly-no-fulltext（#596）', () => {
  const MARKER_TARGETS = [
    'timing-addendum', 'timing-agentsMd', 'timing-titlePrompt',
    // 后两条是工单里一并点名的残留：整段覆写卡的预算免责那句（zh 侧原本写着 `**最长合法工位名**`）
    'readonly-no-fulltext', 'agents-md-render-budget-note',
  ];

  for (const locale of ['zh-CN', 'en'] as const) {
    it(`${locale}：三张卡的 timing-* 与 readonly-no-fulltext 渲染出来的文本不含 *`, async () => {
      setLocale(locale);
      stubDefault(dto());
      const w = await mountView();

      for (const testId of MARKER_TARGETS) {
        const rendered = text(w, testId); // w.get() ⇒ 元素缺失当场红，不会空跑假绿
        expect(rendered.trim(), `${locale} ${testId} 不许是空文本`).not.toBe('');
        expect(rendered, `${locale} ${testId} 渲染出了 markdown 星号`).not.toContain('*');
      }
      // 兼带一道全屏闸：任何一张卡新写进文案的成对星号都会在这里现形（单星号只在上面那五个
      // 被点名的位置上当杂字符处理 —— readonly 条目里的 `fde-*` 是真 glob，不是 markdown）。
      expect(w.text(), `${locale} 整页还带着 markdown 强调记号`).not.toContain('**');
    });
  }
});
