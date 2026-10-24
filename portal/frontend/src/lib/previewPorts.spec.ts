// 预览端口纯逻辑单测（#246 交付② 单 B）：把「最容易做坏」的两条判据钉在函数层——
// ① 签票端点吃的是**列表里的 allocation UUID**；② ticket 在目标 URL 里**只出现一次**
// （后端 §2.8 返回的 url 已含 ?preview_ticket=，前端再拼一遍就是两张票）。
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_BLOCK_START_MAX,
  PREVIEW_BLOCK_START_MIN,
  PREVIEW_PORT_STATES,
  adminFdePortsBlockPath,
  adminFdePortsPath,
  asPreviewPortState,
  batchTicketsPath,
  currentBlockRange,
  formatBlockRange,
  isAlignedBlockStart,
  myPortsPath,
  parseBlockStart,
  previewBlockEnd,
  previewTargetUrl,
  previewTicketPath,
  retryAfterSeconds,
  toPreviewApiError,
  type PreviewPortItem,
} from './previewPorts';

function portItem(overrides: Partial<PreviewPortItem> = {}): PreviewPortItem {
  return {
    id: '7b0a1f2e-9c3d-4e5f-8a6b-1c2d3e4f5a6b',
    port: 22000,
    hostname: 'alice-p-22000.fde.erix.vip',
    url: 'http://alice-p-22000.fde.erix.vip:8090',
    state: 'allocated',
    scope: 'fde',
    role: 'spare',
    exposure: 'private',
    ...overrides,
  };
}

describe('端点路径（portal.md §4.7a / §2.8）', () => {
  it('本人 / 管理员列端点与改块端点逐字对齐文档', () => {
    expect(myPortsPath).toBe('/api/me/ports');
    expect(adminFdePortsPath('alice')).toBe('/api/admin/fdes/alice/ports');
    expect(adminFdePortsBlockPath('alice')).toBe('/api/admin/fdes/alice/ports/block');
  });

  it('fde_name 里的特殊字符走 encodeURIComponent（与 admin 面其它端点一致）', () => {
    expect(adminFdePortsPath('a b/c')).toBe('/api/admin/fdes/a%20b%2Fc/ports');
    expect(adminFdePortsBlockPath('a b/c')).toBe('/api/admin/fdes/a%20b%2Fc/ports/block');
  });

  it('#247 批量签票端点逐字对齐文档（路径里不带 allocation id）', () => {
    expect(batchTicketsPath).toBe('/api/me/ports/batch-tickets');
  });

  it('签票端点的路径参数是 allocation UUID，不是端口号', () => {
    const item = portItem();
    expect(previewTicketPath(item.id)).toBe(`/api/ports/${item.id}/preview-ticket`);
    expect(previewTicketPath(String(item.port))).not.toBe(previewTicketPath(item.id));
  });
});

describe('previewTargetUrl：ticket 只出现一次', () => {
  it('后端 url 已含 ?preview_ticket=（§2.8 形态）⇒ 原样使用，不再拼第二张票', () => {
    const url = previewTargetUrl({
      url: 'http://alice-p-22000.fde.erix.vip:8090/?preview_ticket=pt_abc',
      ticket: 'pt_abc',
      expires_in: 60,
    });
    expect(url).toBe('http://alice-p-22000.fde.erix.vip:8090/?preview_ticket=pt_abc');
    expect(url.match(/preview_ticket=/g)).toHaveLength(1);
  });

  it('裸 url ⇒ 补挂 ?preview_ticket=<ticket>（工单要求的形态 <url>/?preview_ticket=…）', () => {
    const url = previewTargetUrl({
      url: 'http://alice-p-22000.fde.erix.vip:8090',
      ticket: 'pt_abc',
      expires_in: 60,
    });
    expect(url).toBe('http://alice-p-22000.fde.erix.vip:8090?preview_ticket=pt_abc');
  });

  it('#247 批量响应的单项（url/ticket/expires_at）与单据响应共用同一拼法', () => {
    const url = previewTargetUrl({
      id: '7b0a1f2e-9c3d-4e5f-8a6b-1c2d3e4f5a6b',
      port: 22001,
      url: 'http://alice-p-22001.fde.erix.vip:8090/?preview_ticket=pt_batch',
      ticket: 'pt_batch',
      expires_at: '2026-10-23T12:01:00.000Z',
    });
    expect(url).toBe('http://alice-p-22001.fde.erix.vip:8090/?preview_ticket=pt_batch');
    expect(url.match(/preview_ticket=/g)).toHaveLength(1);
  });

  it('已带别的查询参数时用 & 拼接；ticket 做 URL 编码', () => {
    expect(previewTargetUrl({ url: 'https://a-p-22010.fde.erix.vip/x?y=1', ticket: 'pt a+b', expires_in: 60 }))
      .toBe('https://a-p-22010.fde.erix.vip/x?y=1&preview_ticket=pt%20a%2Bb');
  });

  it('ticket 为空串（后端已拼好且没另给字段）时返回原 url，不产生空参数', () => {
    expect(previewTargetUrl({ url: 'http://h:8090/?preview_ticket=pt_z', ticket: '', expires_in: 60 }))
      .toBe('http://h:8090/?preview_ticket=pt_z');
    expect(previewTargetUrl({ url: 'http://h:8090', ticket: '', expires_in: 60 })).toBe('http://h:8090');
  });
});

describe('block_start 输入判据（本地只拦「连整数都不是」，其余交服务端判）', () => {
  it('整数才认；空串 / 小数 / 非数字 / 指数写法一律 null', () => {
    expect(parseBlockStart('22010')).toBe(22010);
    expect(parseBlockStart('  22010 ')).toBe(22010);
    expect(parseBlockStart('')).toBeNull();
    expect(parseBlockStart('2201a')).toBeNull();
    expect(parseBlockStart('22010.5')).toBeNull();
    expect(parseBlockStart('1e4')).toBeNull();
  });

  it('对齐判据与号池口径（22000 起、每段 10、上限 29990）只用于提示', () => {
    expect(isAlignedBlockStart(22000)).toBe(true);
    expect(isAlignedBlockStart(29990)).toBe(true);
    expect(isAlignedBlockStart(22005)).toBe(false);
    expect(isAlignedBlockStart(21990)).toBe(false);
    expect(isAlignedBlockStart(30000)).toBe(false);
    expect(previewBlockEnd(22010)).toBe(22019);
    expect(PREVIEW_BLOCK_START_MIN).toBe(22000);
    expect(PREVIEW_BLOCK_START_MAX).toBe(29990);
  });
});

describe('当前段（改块确认文案要点名旧段）', () => {
  it('活行的最小/最大端口 = 当前段起止', () => {
    const items = [portItem({ port: 22000 }), portItem({ port: 22007 }), portItem({ port: 22009 })];
    expect(currentBlockRange(items)).toEqual({ start: 22000, end: 22009 });
    expect(formatBlockRange(currentBlockRange(items))).toBe('22000–22009');
  });

  it('空列表 → null（文案走「当前没有活预览端口段」分支）', () => {
    expect(currentBlockRange([])).toBeNull();
    expect(formatBlockRange(null)).toBe('');
  });
});

describe('state 取值面（§4.7a：released 不列 ⇒ 只剩 allocated / active）', () => {
  it('在册取值只有 allocated 与 active；未知值不猜语义', () => {
    expect([...PREVIEW_PORT_STATES]).toEqual(['allocated', 'active']);
    expect(asPreviewPortState('active')).toBe('active');
    expect(asPreviewPortState('released')).toBeNull();
    expect(asPreviewPortState('healthy')).toBeNull();
  });
});

describe('toPreviewApiError：错误码 / message / details.field 三面都不许丢', () => {
  it('ApiError 形态 → 三面齐全（409 全文与 400 的字段都靠它）', () => {
    const err = Object.assign(new Error('预览端口块 22010–22019 已被占用（外来活行端口：22011,22012'), {
      status: 409,
      code: 'preview_port_block_taken',
    });
    expect(toPreviewApiError(err)).toEqual({
      status: 409,
      code: 'preview_port_block_taken',
      message: '预览端口块 22010–22019 已被占用（外来活行端口：22011,22012',
      field: null,
      // #256 交付②：`ApiError.retryAfter` 原样带走（没有该字段 ⇒ null，不是 undefined）
      retryAfter: null,
    });
  });

  it('#256② Retry-After 秒数透传：429 带 42 ⇒ retryAfter=42；脏值 ⇒ null（不把 NaN 带进文案）', () => {
    const rate = Object.assign(new Error('预览 ticket 签发过于频繁'), {
      status: 429, code: 'rate_limited', retryAfter: 42,
    });
    expect(toPreviewApiError(rate).retryAfter).toBe(42);
    expect(retryAfterSeconds(toPreviewApiError(rate))).toBe(42);

    const noHeader = Object.assign(new Error('x'), { status: 429, code: 'rate_limited', retryAfter: null });
    expect(toPreviewApiError(noHeader).retryAfter).toBeNull();
    expect(retryAfterSeconds(toPreviewApiError(noHeader))).toBeNull();

    for (const dirty of [Number.NaN, Number.POSITIVE_INFINITY, '30', 0, -3]) {
      const err = Object.assign(new Error('x'), { status: 429, code: 'rate_limited', retryAfter: dirty });
      expect(retryAfterSeconds(toPreviewApiError(err)), String(dirty)).toBeNull();
    }
  });

  it('400 validation_failed 的 details.field 透传（指到 block_start）', () => {
    const err = Object.assign(new Error('block_start 必须是整数块起点'), {
      status: 400,
      code: 'validation_failed',
      details: { field: 'block_start' },
    });
    expect(toPreviewApiError(err).field).toBe('block_start');
  });

  it('非 ApiError（网络断等）→ code 兜底 unknown，message 仍有内容', () => {
    const info = toPreviewApiError(new TypeError('Failed to fetch'));
    expect(info.code).toBe('unknown');
    expect(info.status).toBe(0);
    expect(info.message).toContain('Failed to fetch');
  });
});

// ---------------------------------------------------------------------------
// 观测层 MVP 的纯判据（组件侧只留装配）。
// ---------------------------------------------------------------------------
import { duplicateObservedGroups, formatStartedAgo } from './previewPorts';

function item(port: number, cwd: string | null): PreviewPortItem {
  return {
    id: `id-${port}`, port, hostname: `h-${port}`, url: `http://h-${port}`,
    state: 'allocated', scope: 'fde', role: 'spare', exposure: 'private',
    observed: cwd === null ? null : { pid: 1, cwd, cmd: null, branch: null, started_at: null, observed_at: null },
  };
}

describe('duplicateObservedGroups（同目录多实例 = 「两个分支各占一口」的判据）', () => {
  it('同 cwd ≥2 条 ⇒ 一组（端口升序）；单条/无观测/无 cwd 不入组', () => {
    const groups = duplicateObservedGroups([
      item(22005, '~/projects/shop'),
      item(22000, '~/projects/shop'),
      item(22001, '~/projects/other'),
      item(22002, null),
    ]);
    expect(groups).toEqual([{ cwd: '~/projects/shop', ports: [22000, 22005] }]);
  });
});

describe('formatStartedAgo（相对时刻：1m/h/d，坏输入宁缺毋滥）', () => {
  const now = Date.parse('2026-10-24T12:00:00.000Z');
  it.each([
    [30_000, '1m'],           // 不足 1 分钟报 1m，不出 0m
    [5 * 60_000, '5m'],
    [59 * 60_000 + 999, '59m'],
    [2 * 3_600_000, '2h'],
    [25 * 3_600_000, '1d'],
  ])('启动于 %sms 前 ⇒ %s', (agoMs, expected) => {
    expect(formatStartedAgo(new Date(now - agoMs).toISOString(), now)).toBe(expected);
  });
  it('未来时刻（时钟漂移）与不可解时间戳 ⇒ null', () => {
    expect(formatStartedAgo(new Date(now + 60_000).toISOString(), now)).toBeNull();
    expect(formatStartedAgo('nonsense', now)).toBeNull();
  });
});
