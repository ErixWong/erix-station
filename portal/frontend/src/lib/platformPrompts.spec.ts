// @vitest-environment node
// issue #596 片 B：`lib/platformPrompts.ts` 的纯函数单测。
//
// 为什么这一层必须单独有文件（照 `lib/uploadSettings.spec.ts` 的分工）：
//   * 「只读卡显示什么」的真判据是**归一化丢掉了什么** —— 后端 `readonly[]` 只给 `key`，
//     若归一化把没点名的键（例：日后有人加了 `text`）透传进状态，视图就会画出一份
//     portal 运行时根本读不到的文本（那才是撒谎）。这一族在 DOM 层只能看到结果。
//   * `materializeEnqueued` 的 `0` / 缺键 / `titlePrompt` 恒 0 三种形状，视图里各只有一句文案，
//     语义判据在纯函数层才钉得住。
//   * `'1e3'` / emoji 这类**字符串形状**在 `<textarea>` 里到不了 lib（DOM 给什么就是什么）。
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_PROMPTS_PATH,
  READONLY_PROMPT_KEYS,
  buildPromptPayload,
  materializeNoticeOf,
  normalizePlatformPrompts,
  platformPromptPath,
  promptValidationFieldOf,
  shortUuid,
  utf8ByteLength,
  EFFECTIVE_AGENTS_MD_PATH,
  EFFECTIVE_DISK_STATES,
  normalizeEffectiveAgentsMd,
  effectiveAgentsMdPath,
  effectiveVerdictOf,
  draftDirtyOf,
  type EffectiveAgentsMd,
} from './platformPrompts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 后端 `P8c` 钉住的那份 GET DTO（默认态，三块全跟随内置）。 */
const DTO = {
  addendum: { text: '', isDefault: true, maxBytes: 8192, bytes: 0 },
  agentsMd: {
    override: '', isOverridden: false, isDefault: true,
    templateBytes: 9231, effectiveBytes: 9231, effectiveText: '# FDE 工位约定\n（FDE 标识：example）\n',
    maxBytes: 16384, renderedLimitBytes: 16384,
  },
  titlePrompt: { text: '', isDefault: true, defaultText: '给这段对话起个标题', maxBytes: 2000, bytes: 0 },
  readonly: [{ key: 'runnerSystemPrompt' }, { key: 'childSystemPrompt' },
    { key: 'toolDescriptions' }, { key: 'engineNotices' }],
  updatedAt: null,
  updatedBy: null,
  reason: 'no_row',
};

describe('utf8ByteLength：与后端的 UTF-8 口径一致（上限都是字节不是字符）', () => {
  it('ASCII / CJK / emoji 分别算 1 / 3 / 4 字节', () => {
    expect(utf8ByteLength('')).toBe(0);
    expect(utf8ByteLength('- 收工前跑 smoke。')).toBe(23);
    expect(utf8ByteLength('中文')).toBe(6);
  });

  it('代理对（emoji）算一个 4 字节字符，不被双计成 6', () => {
    expect(utf8ByteLength('🚧')).toBe(4);
    // 代理对在 UTF-16 里是 2 个 code unit，`.length` 会说 2 —— 那正是"按长度算字节"的经典假账
    expect('🚧'.length).toBe(2);
    expect(utf8ByteLength('a🚧中')).toBe(1 + 4 + 3);
  });

  it('非字符串输入不抛（归一化之外的调用方）', () => {
    expect(utf8ByteLength(undefined as unknown as string)).toBe(0);
    expect(utf8ByteLength(null as unknown as string)).toBe(0);
  });
});

describe('normalizePlatformPrompts：显式白名单 + 永不抛', () => {
  it('完整 DTO 归一化后逐块可用，来源由 `text === \'\'` 派生', () => {
    const got = normalizePlatformPrompts(DTO);
    expect(got.addendum).toEqual({ text: '', isDefault: true, maxBytes: 8192, bytes: 0 });
    expect(got.agentsMd.isOverridden).toBe(false);
    expect(got.agentsMd.templateBytes).toBe(9231);
    expect(got.titlePrompt.defaultText).toBe('给这段对话起个标题');
    expect(got.readonly).toEqual([...READONLY_PROMPT_KEYS]);
    expect(got.unknownReadonly).toEqual([]);
    expect(got.reason).toBe('no_row');
    // `GET` 不带这个键 ⇒ 「不知道」，不许折成 0（0 的意思是「一台都没入队」）
    expect(got.materializeEnqueued).toBeNull();
  });

  it('三种回落 reason 两两可区分；后端新增的第四种 ⇒ `unknown`（不塌成 `no_row`）', () => {
    for (const reason of ['no_row', 'read_failed', 'read_timeout'] as const) {
      expect(normalizePlatformPrompts({ ...DTO, reason }).reason).toBe(reason);
    }
    expect(normalizePlatformPrompts({ ...DTO, reason: 'read_lagging' }).reason).toBe('unknown');
    expect(normalizePlatformPrompts({ ...DTO, reason: null }).reason).toBeNull();
    expect(normalizePlatformPrompts(DTO).reason).toBe('no_row');
  });

  it('`PUT` 响应多出的 `materializeEnqueued` 收进状态；缺键是 null 而不是 0', () => {
    expect(normalizePlatformPrompts({ ...DTO, materializeEnqueued: 0 }).materializeEnqueued).toBe(0);
    expect(normalizePlatformPrompts({ ...DTO, materializeEnqueued: 7 }).materializeEnqueued).toBe(7);
    expect(normalizePlatformPrompts({ ...DTO, materializeEnqueued: '3' }).materializeEnqueued).toBeNull();
  });

  it('只认 `readonly[].key`：后端多塞 `text` 也不许进状态（portal 镜像不含 runner/ ⇒ 显示全文就是撒谎）', () => {
    const got = normalizePlatformPrompts({
      ...DTO,
      readonly: [
        { key: 'runnerSystemPrompt', text: '你是运行在 FDE 工作台容器中的编码 agent' },
        'childSystemPrompt',
        { key: 42 },
        { key: null },
        {},
        null,
      ],
    });
    expect(got.readonly).toEqual(['runnerSystemPrompt', 'childSystemPrompt']);
    expect(JSON.stringify(got)).not.toContain('编码 agent');
    expect(JSON.stringify(got)).not.toContain('42');
  });

  it('后端多给一个前端没登记的 key ⇒ 原样留在 `unknownReadonly`（不显示文案，也不丢消息）', () => {
    const got = normalizePlatformPrompts({
      ...DTO,
      readonly: [{ key: 'engineNotices' }, { key: 'engineSomethingNew' }],
    });
    expect(got.readonly).toEqual(['engineNotices']);
    expect(got.unknownReadonly).toEqual(['engineSomethingNew']);
  });

  // #390-A 纪律：键缺席不是 0 / false。`maxBytes` 没给 ⇒ 不许显示一个编出来的上限。
  it('键缺席的形状（`{}`、块不是对象、上限是字符串）都不抛，且数值位是 null', () => {
    for (const raw of [undefined, null, 'x', 42, [], { addendum: 'x', agentsMd: 7 }]) {
      expect(() => normalizePlatformPrompts(raw)).not.toThrow();
    }
    const got = normalizePlatformPrompts({ addendum: { maxBytes: '8192' }, agentsMd: [] });
    expect(got.addendum.maxBytes).toBeNull();
    expect(got.addendum.bytes).toBe(0);
    expect(got.agentsMd.maxBytes).toBeNull();
    expect(got.agentsMd.effectiveText).toBe('');
    expect(got.readonly).toEqual([]);
  });

  it('超长值照用（读侧不做长度校验）：手工 `UPDATE` 进来的 9 KiB 追加段不被换成内置', () => {
    const long = 'x'.repeat(9000);
    const got = normalizePlatformPrompts({ ...DTO, addendum: { text: long, maxBytes: 8192 } });
    expect(got.addendum.text).toBe(long);
    expect(got.addendum.isDefault).toBe(false);
    expect(got.addendum.bytes).toBe(9000);
  });

  it('`updatedAt` / `updatedBy` 只认非空字符串（空串当「没给」）', () => {
    const got = normalizePlatformPrompts({ updatedAt: '', updatedBy: '0f1e2d3c-0000-4000-8000-0000000000a1' });
    expect(got.updatedAt).toBeNull();
    expect(got.updatedBy).toBe('0f1e2d3c-0000-4000-8000-0000000000a1');
  });
});

describe('buildPromptPayload：服务端才是闸 ⇒ 只有「连长度都算不出」才不发请求', () => {
  it('任何字符串都放行（含越界的 20 KiB 与 `\'\'`）', () => {
    expect(buildPromptPayload('')).toEqual({ text: '' });
    expect(buildPromptPayload('x'.repeat(20 * 1024))).toEqual({ text: 'x'.repeat(20 * 1024) });
    expect(buildPromptPayload('  带空白  ')).toEqual({ text: '  带空白  ' });
    expect(buildPromptPayload('1e3')).toEqual({ text: '1e3' });
    expect(buildPromptPayload('🚧')).toEqual({ text: '🚧' });
  });

  it('非字符串 ⇒ null（调用方不发请求，也不发 `{text:null}`）', () => {
    for (const bad of [undefined, null, 42, {}, [], true]) {
      expect(buildPromptPayload(bad)).toBeNull();
    }
  });
});

describe('platformPromptPath：slug 只有一处拼法', () => {
  it('三个字段各自的 URL 与后端路由一致', () => {
    expect(PLATFORM_PROMPTS_PATH).toBe('/api/admin/prompts');
    expect(platformPromptPath('addendum')).toBe('/api/admin/prompts/addendum');
    expect(platformPromptPath('agentsMd')).toBe('/api/admin/prompts/agents-md');
    expect(platformPromptPath('titlePrompt')).toBe('/api/admin/prompts/title-prompt');
  });
});

describe('promptValidationFieldOf：`details.field` 不点卡片名，所以「哪张卡」只能由发送方给', () => {
  const err = (status: number, details?: Record<string, unknown>) => ({ status, details });

  it('400 + `text` / `body` / `field` ⇒ 指到刚保存的那张卡', () => {
    for (const field of ['text', 'body', 'field']) {
      expect(promptValidationFieldOf(err(400, { field }), 'agentsMd')).toBe('agentsMd');
    }
  });

  it('渲染超限的 400（details 带四个键）同样指到那张卡', () => {
    expect(promptValidationFieldOf(
      err(400, { field: 'text', max_bytes: 8192, rendered_bytes: 20000, render_limit_bytes: 16384 }),
      'addendum',
    )).toBe('addendum');
  });

  it('非 400 / 没有 details / 认不出的 field ⇒ null（退化成整页一条错误，不猜是哪个框）', () => {
    expect(promptValidationFieldOf(err(500, { field: 'text' }), 'addendum')).toBeNull();
    expect(promptValidationFieldOf(err(403), 'addendum')).toBeNull();
    expect(promptValidationFieldOf(err(400, { max_bytes: 8192 }), 'addendum')).toBeNull();
    expect(promptValidationFieldOf(err(400, { field: 'unknown_thing' }), 'addendum')).toBeNull();
    expect(promptValidationFieldOf(null, 'addendum')).toBeNull();
    expect(promptValidationFieldOf('boom', 'addendum')).toBeNull();
  });
});

describe('materializeNoticeOf：`0` 是要显式说出口的事，`titlePrompt` 的 0 是另一回事', () => {
  it('追加段 / 整段覆写：>0 已通知；0 未通知；缺键未知', () => {
    for (const field of ['addendum', 'agentsMd'] as const) {
      expect(materializeNoticeOf(field, 3)).toBe('enqueued');
      expect(materializeNoticeOf(field, 0)).toBe('not_enqueued');
      expect(materializeNoticeOf(field, null)).toBe('enqueued_unknown');
    }
  });

  it('标题提示词不涉物化 ⇒ 恒 `no_materialize`（此时说「物化未通知」是撒谎）', () => {
    expect(materializeNoticeOf('titlePrompt', 0)).toBe('no_materialize');
    expect(materializeNoticeOf('titlePrompt', 5)).toBe('no_materialize');
    expect(materializeNoticeOf('titlePrompt', null)).toBe('no_materialize');
  });
});

describe('shortUuid：只有 uuid、没有显示名 ⇒ 短形式或原样，绝不空着', () => {
  it('uuid 取前 8 位 + 省略号；非 uuid 原样给（不裁成看不懂的片段）', () => {
    expect(shortUuid('3f2c0000-0000-4000-8000-0000000000a1')).toBe('3f2c0000…');
    expect(shortUuid('not-a-uuid')).toBe('not-a-uuid');
    expect(shortUuid(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 契约节号机械闸（#596）：提示词面板那批源码只许引用 portal.md §4.19。
// 为什么常驻：本节号连撞三次，肉眼发现漂移太脆，改成机器判。
// §4.16 现是「关于」(#586)、§4.18 现是「MCP」(#608)，§4.20 是预留位——
// 专属文件整文件判；共享文件只判提示词语境行，不误伤别人的 §4.16
// 不扫本 spec：反向自证的 §4.18 样本是内存字符串，不该把文件判红。
// ---------------------------------------------------------------------------

/** 只认 §4.16 / §4.18 / §4.20 三号违规，§4.19 不在其列。 */
const FORBIDDEN_SECTION = /§4\.16|§4\.18|§4\.20/;

/** 提示词上下文标记，用于把别人合法的 §4.16 从共享文件里排除。 */
const PROMPT_CONTEXT = /提示词|[Pp]rompts/;

/** 提示词面板专属文件：整文件都是本页 ⇒ 任何旧/预留节号算漂移。 */
const PROMPT_OWNED = [
  './platformPrompts.ts',
  '../views/AdminPromptsView.vue',
  '../views/AdminPromptsView.spec.ts',
];

/** 共享文件：他面板同处一文件 ⇒ 只判提示词语境行上的旧号。 */
const SHARED_FILES = [
  '../stores/admin.ts',
  '../router.ts',
  '../i18n/locales/zh-CN.ts',
  '../i18n/locales/en.ts',
];

/**
 * 命中 §4.16 / §4.18 / §4.20 的行，返回 label:行号: 那一行。
 * requireContext=true（共享文件）时，只算同一行还带提示词上下文的那些。
 */
function findSectionDrift(text: string, label: string, requireContext: boolean): string[] {
  const bad: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!FORBIDDEN_SECTION.test(line)) continue;
    if (requireContext && !PROMPT_CONTEXT.test(line)) continue;
    bad.push(`${label}:${i + 1}: ${line.trim()}`);
  }
  return bad;
}

describe('契约节号机械闸：面板只许 §4.19（第三次撞号后的常驻闸）', () => {
  it('扫面板那批源码，不得出现 §4.16 / §4.18 / §4.20', () => {
    const here = fileURLToPath(new URL('./', import.meta.url));
    const drift: string[] = [];
    for (const rel of PROMPT_OWNED) {
      drift.push(...findSectionDrift(readFileSync(here + rel, 'utf8'), rel, false));
    }
    for (const rel of SHARED_FILES) {
      drift.push(...findSectionDrift(readFileSync(here + rel, 'utf8'), rel, true));
    }
    expect(drift, `发现漂移的旧契约节号：\n${drift.join('\n')}`).toEqual([]);
  });

  it('反向自证：写着 §4.18 的样本喂进函数必须判红并点名', () => {
    // 提示词语境行 + §4.18 ⇒ 必须红（共享文件 requireContext=true）。
    const sample = 'NODE=x\n// 提示词面板旧号 §4.18-2（测试样本，非真引用）\n';
    const hits = findSectionDrift(sample, '.env.example', true);
    expect(hits, '提示词语境的旧号 §4.18 必须被判红').toHaveLength(1);
    expect(hits[0]).toContain('.env.example:2');
    expect(hits[0]).toContain('§4.18-2');
    // 反向自证另半边：同行没有提示词上下文（他人 §4.16）不该红。
    const notMine = findSectionDrift('// 关于面板 §4.16', 'other.ts', true);
    expect(notMine, '非提示词语境的 §4.16 不该判红').toEqual([]);
  });
});

// ── issue #801：生效面 lib 判据（N1–N6）────────────────────────────────────────
describe('issue #801 生效面 lib', () => {
  const base = (): Record<string, unknown> => ({
    fdeName: 'alice',
    disk: { state: 'ok', bytes: 10, mtime: '2026-01-01T00:00:00.000Z', text: 'D', sha256: 'aa', truncated: false },
    expected: { bytes: 10, sha256: 'aa', text: 'E' },
    matches: true,
    source: 'builtin',
    reason: null,
    db: { addendumBytes: 0, overrideBytes: 0 },
    renderLimitBytes: 16384,
  });

  it('N1 归一化永不抛', () => {
    for (const bad of [null, 42, [], 'x', undefined]) {
      expect(() => normalizeEffectiveAgentsMd(bad)).not.toThrow();
      expect(normalizeEffectiveAgentsMd(bad)).toBeNull(); // 非纯对象 ⇒ null
    }
    // 纯对象但缺键 ⇒ 全「未知」形状，不抛、不 null
    const partial = normalizeEffectiveAgentsMd({});
    expect(partial).not.toBeNull();
    expect(partial?.disk.state).toBe('read_failed'); // 无 state ⇒ 兜底 read_failed
    expect(partial?.disk.text).toBeNull();
    expect(partial?.expected.text).toBe('');
    expect(partial?.matches).toBeNull();
  });

  it('N2 matches 三态不塌', () => {
    const withMatches = (m: unknown) => normalizeEffectiveAgentsMd({ ...base(), matches: m });
    expect(withMatches(undefined)?.matches).toBeNull();
    expect(withMatches(null)?.matches).toBeNull();
    expect(withMatches('true')?.matches).toBeNull();
    expect(withMatches(1)?.matches).toBeNull();
    expect(withMatches(false)?.matches).toBe(false);
    expect(withMatches(true)?.matches).toBe(true);
    // 缺键那份（删掉 matches）也 ⇒ null
    const noKey = base(); delete (noKey as Record<string, unknown>).matches;
    expect(normalizeEffectiveAgentsMd(noKey)?.matches).toBeNull();
  });

  it('N3 disk.state 白名单', () => {
    const mk = (state: unknown) => normalizeEffectiveAgentsMd({ ...base(), disk: { ...(base().disk as object), state } });
    expect(mk('weird')?.disk.state).toBe('read_failed'); // 第五种 ⇒ 归成 read_failed
    expect(mk(undefined)?.disk.state).toBe('read_failed');
    expect(mk('ok')?.disk.state).toBe('ok');
    expect(mk('missing')?.disk.state).toBe('missing');
    expect(mk('not_a_file')?.disk.state).toBe('not_a_file');
    expect(mk('read_failed')?.disk.state).toBe('read_failed');
    // 未知 state 不许被渲染成 ok
    expect(mk('weird')?.disk.state).not.toBe('ok');
    expect(EFFECTIVE_DISK_STATES).toEqual(['ok', 'missing', 'not_a_file', 'read_failed']);
  });

  it('N4 verdictOf 三态', () => {
    const ok = normalizeEffectiveAgentsMd({ ...base(), matches: true }) as EffectiveAgentsMd;
    const stale = normalizeEffectiveAgentsMd({ ...base(), matches: false }) as EffectiveAgentsMd;
    const un = normalizeEffectiveAgentsMd({ ...base(), matches: null }) as EffectiveAgentsMd;
    expect(effectiveVerdictOf(ok)).toBe('ok');
    expect(effectiveVerdictOf(stale)).toBe('stale');
    expect(effectiveVerdictOf(un)).toBe('unavailable');
    expect(effectiveVerdictOf(null)).toBe('unavailable');
  });

  it('N5 draftDirtyOf', () => {
    expect(draftDirtyOf('', '')).toBe(false);
    expect(draftDirtyOf('a', '')).toBe(true);
    expect(draftDirtyOf('', 'a')).toBe(true);
    // 非串输入不抛
    expect(() => draftDirtyOf(undefined as unknown as string, '' as string)).not.toThrow();
    expect(draftDirtyOf(undefined as unknown as string, '' as string)).toBe(false);
  });

  it('N6 effectiveAgentsMdPath 转义', () => {
    expect(effectiveAgentsMdPath('alice')).toBe(`${EFFECTIVE_AGENTS_MD_PATH}?fde=alice`);
    // 含特殊字符要过 encodeURIComponent
    expect(effectiveAgentsMdPath('a b/c')).toContain(`fde=${encodeURIComponent('a b/c')}`);
  });
});
