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
} from './platformPrompts';

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
