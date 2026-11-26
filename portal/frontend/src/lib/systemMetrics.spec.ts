// `lib/systemMetrics` 的用例（issue #650 管理台「系统」面板）。
//
// 这一层的全部风险是**把「不知道」演成数**（#586 的返工点，也是 #650 立单的理由），所以断言
// 几乎都围着三件事写：缺值必须是 `null`、脏值必须是 `null`、`null` 必须原样传到页面手里
// （`.vue` 只许搬运，不许在这里之外再兜一次 `?? 0`）。
// 夹具形状照**真库跑出来的响应**（工单里那份逐字段 JSON），不自己发明形状。
import { describe, expect, it } from 'vitest';
import {
  METRIC_RANGES,
  SPARK_MAX_POINTS,
  SYSTEM_METRICS_PATH,
  bucketParts,
  diskTrendFor,
  formatAgo,
  formatAxisTime,
  formatBytes,
  formatCount,
  formatLoadLine,
  formatPct,
  isMetricRange,
  loadNormalizedPct,
  metricsErrorText,
  normalizeSystemMetrics,
  rangeLabel,
  seriesErrorText,
  sparkPoints,
  systemMetricsPath,
} from './systemMetrics';

/** 真库形状（照工单 §后端已经给你什么 逐字段抄，数值有辨识度以便断言）。 */
const REAL = {
  latest: {
    sampled_at: '2026-11-17T07:40:00.000Z',
    cpu: { usagePct: 12.5, cores: 36, load: [1.2, 1.3, 1.4] },
    mem: {
      totalBytes: 1000, usedBytes: 400, availableBytes: 600,
      cachedBytes: 100, swapUsedBytes: 0, usedPct: 40,
    },
    disk: [{
      device: '/dev/nvme0n1p2', path: '/', fs: 'ext4',
      totalBytes: 1000, usedBytes: 700, availBytes: 300, usedPct: 70,
    }],
    diskUnreadable: [{ path: '/data', reason: 'ENOENT' }],
    containers: {
      total: 4, running: 3, paused: 0, stopped: 1, station: 2, fde: 2, fdeRunning: 2,
      drift: { db: 2, docker: 2, onlyDb: [], onlyDocker: [], count: 0 },
    },
  },
  series: {
    bucketSeconds: 30,
    points: [{
      t: '2026-11-17T07:30:30.000Z', cpuAvg: 63.46, cpuMax: 63.46,
      memUsed: 32685326336, containersRunning: 3, samples: 1,
    }],
  },
  range: '1h',
  retentionDays: 30,
  seriesError: null,
  enabled: true,
};

const AT = Date.parse('2026-11-17T07:40:30.000Z');

// ─────────────────────────────────────────────────────────────────────────────
describe('端点路径与范围口径', () => {
  it('systemMetricsPath：合法 range 才拼 `?range=`；非法 / 缺省 ⇒ 不带参数（让服务端回落，前端不造第二个缺省）', () => {
    expect(systemMetricsPath('6h')).toBe(`${SYSTEM_METRICS_PATH}?range=6h`);
    expect(systemMetricsPath('1h')).toBe(`${SYSTEM_METRICS_PATH}?range=1h`);
    for (const bad of [null, undefined, '', '1w', '25h', '30D']) {
      expect(systemMetricsPath(bad), `脏 range ${String(bad)}`).toBe(SYSTEM_METRICS_PATH);
    }
    expect([...METRIC_RANGES]).toEqual(['1h', '6h', '24h', '7d', '30d']);
    expect(isMetricRange('7d')).toBe(true);
    expect(isMetricRange(7)).toBe(false);
  });

  it('rangeLabel：认得的原样给，认不得 ⇒ null（**不许**替服务端猜成 1h）', () => {
    expect(rangeLabel('24h')).toBe('24h');
    expect(rangeLabel('1w')).toBeNull();
    expect(rangeLabel(null)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('normalizeSystemMetrics：真库形状逐项搬齐，一个都不丢', () => {
  const normalized = normalizeSystemMetrics(REAL);

  it('latest 四组读数逐项对得上（对不上就是有人在中间「算了一下」）', () => {
    expect(normalized.latest?.sampledAt).toBe('2026-11-17T07:40:00.000Z');
    expect(normalized.latest?.cpu).toEqual({ usagePct: 12.5, cores: 36, load: [1.2, 1.3, 1.4] });
    expect(normalized.latest?.mem).toEqual({
      totalBytes: 1000, usedBytes: 400, availableBytes: 600,
      cachedBytes: 100, swapUsedBytes: 0, usedPct: 40,
    });
    expect(normalized.latest?.disk).toEqual([{
      device: '/dev/nvme0n1p2', path: '/', fs: 'ext4',
      totalBytes: 1000, usedBytes: 700, availBytes: 300, usedPct: 70,
    }]);
    expect(normalized.latest?.diskUnreadable).toEqual([{ path: '/data', reason: 'ENOENT' }]);
    expect(normalized.latest?.containers).toEqual({
      total: 4, running: 3, paused: 0, stopped: 1, station: 2, fde: 2, fdeRunning: 2,
      drift: { db: 2, docker: 2, onlyDb: [], onlyDocker: [], count: 0 },
    });
    expect(normalized.series).toEqual({ bucketSeconds: 30, points: [{
      t: '2026-11-17T07:30:30.000Z', cpuAvg: 63.46, cpuMax: 63.46,
      memUsed: 32685326336, memAvailable: null, memCached: null, swapUsed: null, load1: null,
      containersRunning: 3, samples: 1,
    }], dropped: 0, disks: [] });
    expect(normalized.range).toBe('1h');
    expect(normalized.retentionDays).toBe(30);
    expect(normalized.seriesError).toBeNull();
    expect(normalized.enabled).toBe(true);
  });

  it('`enabled` 三态：只认真布尔（`\'true\'` / `1` / 缺键 ⇒ null = 服务端没说）', () => {
    expect(normalizeSystemMetrics({ ...REAL, enabled: false }).enabled).toBe(false);
    expect(normalizeSystemMetrics({ ...REAL, enabled: 'true' }).enabled).toBeNull();
    expect(normalizeSystemMetrics({ ...REAL, enabled: 1 }).enabled).toBeNull();
    // 键根本不存在（老后端 / 桩给半截）⇒ null = 「没说」。
    const { enabled: _dropped, ...noKey } = REAL;
    expect(normalizeSystemMetrics(noKey).enabled).toBeNull();
    // 关键三态组合：采样关闭 + 没第一拍 ⇒ `enabled:false` **且** `latest:null`（页面据此说「采样已关闭」）。
    const off = normalizeSystemMetrics({ ...REAL, enabled: false, latest: null });
    expect(off.enabled).toBe(false);
    expect(off.latest).toBeNull();
    // 而「刚重启还没第一拍」是 `enabled:true` + `latest:null` —— 两格**互不蕴含**，页面才分得开。
    const warming = normalizeSystemMetrics({ ...REAL, enabled: true, latest: null });
    expect(warming.enabled).toBe(true);
    expect(warming.latest).toBeNull();
  });

  it('pg 把 numeric / bigint 回成**字符串**也要认（脏形状不是异常，是驱动既成事实）', () => {
    const stringly = normalizeSystemMetrics({
      latest: { cpu: { usagePct: '12.50', cores: '36', load: ['1.20', null, '1.40'] } },
      series: { bucketSeconds: '900', points: [{ t: 'x', cpu_avg: '1.5', mem_used: '1024' }] },
    });
    expect(stringly.latest?.cpu.usagePct).toBe(12.5);
    expect(stringly.latest?.cpu.cores).toBe(36);
    expect(stringly.latest?.cpu.load).toEqual([1.2, null, 1.4]);
    expect(stringly.series.bucketSeconds).toBe(900);
    expect(stringly.series.points[0]).toEqual({
      t: 'x', cpuAvg: 1.5, cpuMax: null, memUsed: 1024,
      memAvailable: null, memCached: null, swapUsed: null, load1: null,
      containersRunning: null, samples: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('normalizeSystemMetrics：缺值 ⇒ null（绝不 `?? 0`）', () => {
  it('`latest: null` 收成 null，不是空对象、不是四组 0', () => {
    const empty = normalizeSystemMetrics({ ...REAL, latest: null });
    expect(empty.latest).toBeNull();
    expect(empty.series.points.length, 'latest 空不许连带抹掉历史').toBeGreaterThan(0);
  });

  it('逐项缺失 / 脏值 ⇒ 该项 null，**别项照常**（一格坏不能让四张卡一起变未知）', () => {
    const partial = normalizeSystemMetrics({
      latest: {
        sampled_at: null,
        cpu: { usagePct: null, cores: 'abc', load: [null] },
        mem: { totalBytes: 1000, usedBytes: null, usedPct: null },
        disk: [],
        containers: null,
      },
    });
    expect(partial.latest?.sampledAt).toBeNull();
    expect(partial.latest?.cpu).toEqual({ usagePct: null, cores: null, load: [null, null, null] });
    expect(partial.latest?.mem).toEqual({
      totalBytes: 1000, usedBytes: null, availableBytes: null,
      cachedBytes: null, swapUsedBytes: null, usedPct: null,
    });
    // `containers: null` 是「docker 不可达」整格未知，**不是 0 台**。
    expect(partial.latest?.containers).toBeNull();
  });

  it('`NaN` / `Infinity` / 负数 / 布尔 / 空串都不算数（负数不夹成 0：夹就是替数据做主）', () => {
    const dirty = normalizeSystemMetrics({
      latest: {
        cpu: { usagePct: NaN, cores: Infinity, load: 'not-an-array' },
        mem: { totalBytes: -5, usedBytes: true, cachedBytes: '' },
      },
    });
    expect(dirty.latest?.cpu.usagePct).toBeNull();
    expect(dirty.latest?.cpu.cores).toBeNull();
    expect(dirty.latest?.cpu.load).toEqual([null, null, null]);
    expect(dirty.latest?.mem.totalBytes).toBeNull();
    expect(dirty.latest?.mem.usedBytes).toBeNull();
    expect(dirty.latest?.mem.cachedBytes).toBeNull();
  });

  it('`containers` 里某一格脏 ⇒ 那一格 null，其余保留（逐格降级，不是整格作废）', () => {
    const mixed = normalizeSystemMetrics({
      latest: { containers: { total: 41, running: 'oops', fde: 7, drift: 'no' } },
    });
    expect(mixed.latest?.containers?.total).toBe(41);
    expect(mixed.latest?.containers?.running).toBeNull();
    expect(mixed.latest?.containers?.fde).toBe(7);
    expect(mixed.latest?.containers?.drift).toBeNull();
  });

  it('服务端给的降级字面量 `unknown`（设备名 / fs 类型）收成 null，不原样上屏', () => {
    const unknowns = normalizeSystemMetrics({
      latest: { disk: [{ device: 'unknown', fs: 'unknown', path: '/' }] },
    });
    expect(unknowns.latest?.disk[0].device).toBeNull();
    expect(unknowns.latest?.disk[0].fs).toBeNull();
    expect(unknowns.latest?.disk[0].path).toBe('/');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('normalizeSystemMetrics：脏元素丢弃 + 计数（一个坏点不许打死整张图）', () => {
  it('disk 数组里的非对象元素被丢弃并计入 diskDropped', () => {
    const mixed = normalizeSystemMetrics({
      latest: { disk: [{ path: '/', totalBytes: 10 }, null, 'x', 42, { path: '/srv', fs: 'xfs' }] },
    });
    expect(mixed.latest?.disk.map((row) => row.path)).toEqual(['/', '/srv']);
    expect(mixed.latest?.diskDropped).toBe(3);
  });

  it('series.points 里的坏点被丢弃并计入 dropped，好点照常进图', () => {
    const mixed = normalizeSystemMetrics({
      series: {
        bucketSeconds: 300,
        points: [
          { t: '2026-11-17T07:30:00.000Z', cpuAvg: 1 },
          null,
          { cpuMax: null, t: null },
          { t: '2026-11-17T07:35:00.000Z', cpuAvg: 2 },
        ],
      },
    });
    expect(mixed.series.points.map((p) => p.t)).toEqual(['2026-11-17T07:30:00.000Z', '2026-11-17T07:35:00.000Z']);
    expect(mixed.series.dropped).toBe(2);
  });

  it('半截 / null / 数组 / 字符串 / 数字都不许抛', () => {
    for (const raw of [null, undefined, {}, [], 'x', 42, { latest: 'x', series: [], range: 7 }]) {
      expect(() => normalizeSystemMetrics(raw)).not.toThrow();
    }
    expect(normalizeSystemMetrics(null)).toEqual({
      enabled: null, latest: null, series: { bucketSeconds: null, points: [], dropped: 0, disks: [] },
      range: null, retentionDays: null, seriesError: null, disksError: null,
    });
  });

  it('`seriesError` 非空 ⇒ 只收成原因串，`latest` 不受影响（两格各自独立降级）', () => {
    const degraded = normalizeSystemMetrics({ ...REAL, seriesError: '57P01', series: { bucketSeconds: 900, points: [] } });
    expect(seriesErrorText(degraded.seriesError)).toBe('57P01');
    expect(degraded.latest?.cpu.usagePct).toBe(12.5);
    expect(degraded.series.points).toEqual([]);
    expect(seriesErrorText('')).toBeNull();
    expect(seriesErrorText(null)).toBeNull();
    // 非字符串的原因不算「说了话」（契约上是原因串）。
    expect(seriesErrorText(42)).toBeNull();
  });

  it('`range` / `retentionDays` 脏值 ⇒ null（不猜 `1h` / 30）', () => {
    expect(normalizeSystemMetrics({ range: '1w', retentionDays: 'thirty' })).toMatchObject({
      range: null, retentionDays: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('formatBytes：口径写进后缀，保留 1 位', () => {
  it('二进制口径 ⇒ KiB/MiB/GiB/TiB（1024），十进制 ⇒ KB/GB/TB（1000），两者不许混', () => {
    expect(formatBytes(1024)).toBe('1 KiB');
    expect(formatBytes(1024 ** 2)).toBe('1 MiB');
    expect(formatBytes(1024 ** 3)).toBe('1 GiB');
    expect(formatBytes(1024 ** 4)).toBe('1 TiB');
    expect(formatBytes(1000, 'decimal')).toBe('1 KB');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1000, 'decimal')).toBe('1 KB');
    expect(formatBytes(1000 ** 3, 'decimal')).toBe('1 GB');
    // 同一个数两种口径必须给出**不同**的数（差 ~7% 在 TB 级是几百 GB，不许混用）。
    const gib = 1_099_511_627_776;
    expect(formatBytes(gib)).toBe('1 TiB');
    expect(formatBytes(gib, 'decimal')).toBe('1.1 TB');
  });

  it('保留 1 位小数；整数不写成 `30.0`', () => {
    expect(formatBytes(30 * 1024 ** 3 + 1)).toBe('30 GiB');
    expect(formatBytes(Math.round(1.6 * 1024 ** 3))).toBe('1.6 GiB');
    expect(formatBytes(1536)).toBe('1.5 KiB');
  });

  it('`null` / 脏值 / 负数 ⇒ null（**不许**出现 `0 B`）', () => {
    for (const bad of [null, undefined, NaN, -1, Infinity, 'x' as never, {} as never]) {
      expect(formatBytes(bad), `脏值 ${String(bad)}`).toBeNull();
    }
    expect(formatBytes(0), '真的是 0 才许写 0').toBe('0 B');
    // 字符串数字要认（pg 的 bigint 就是字符串），但脏串不算。
    expect(formatBytes('1073741824' as never)).toBe('1 GiB');
  });
});

describe('formatPct / formatCount', () => {
  it('百分比保留 1 位；缺值 ⇒ null（不是 `0.0%`）', () => {
    expect(formatPct(12.34)).toBe('12.3%');
    expect(formatPct(40)).toBe('40.0%');
    expect(formatPct(0), '真的是 0 才许写 0').toBe('0.0%');
    expect(formatPct(null)).toBeNull();
    expect(formatPct(NaN)).toBeNull();
    // 字符串数字也认（服务端 `numeric` 回串是既成事实），脏串 ⇒ null。
    expect(formatPct('12.5' as never)).toBe('12.5%');
    expect(formatPct('abc' as never)).toBeNull();
  });

  it('台数 / 核数：整数出串，脏值与负数 ⇒ null', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(36)).toBe('36');
    expect(formatCount(null)).toBeNull();
    expect(formatCount(-1)).toBeNull();
    expect(formatCount('x' as never)).toBeNull();
    expect(formatCount('41' as never)).toBe('41');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 工单点名的那条：36 核机器上 `load 5.26` 会被读成「快炸了」，必须给归一化幅度。
describe('load 归一化（工单 §前端）', () => {
  it('loadNormalizedPct：load1 / cores × 100', () => {
    expect(loadNormalizedPct(5.26, 36)).toBeCloseTo(14.611, 3);
    expect(loadNormalizedPct(0, 36)).toBe(0);
    // 没有分母就不许给百分比（`cores` 是 `null` 时说「≈ 0%」是假账）。
    expect(loadNormalizedPct(5.26, null)).toBeNull();
    expect(loadNormalizedPct(5.26, 0)).toBeNull();
    expect(loadNormalizedPct(null, 36)).toBeNull();
  });

  it('formatLoadLine：给 load / cores / pct 三段（句子留在 i18n，lib 里不许出现中文单位）', () => {
    expect(formatLoadLine([5.26, 3.1, 2.4], 36)).toEqual({ load: '5.26', cores: '36', pct: '14.6%' });
    expect(formatLoadLine([1.2, 1.3, 1.4], 4)).toEqual({ load: '1.2', cores: '4', pct: '30.0%' });
    expect(formatLoadLine([0, 0, 0], 8)).toEqual({ load: '0', cores: '8', pct: '0.0%' });
    // load1 缺值 / 核数缺值 ⇒ 整段 null（页面不渲染归一化那半句，也不渲染 `NaN%`）。
    expect(formatLoadLine([null, 1, 2], 36)).toBeNull();
    expect(formatLoadLine([5.26, 3, 2], null)).toBeNull();
    expect(formatLoadLine(null, 36)).toBeNull();
    expect(formatLoadLine(undefined, undefined)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('formatAgo：采样时刻（未来与脏值不许编）', () => {
  const SAMPLED = '2026-11-17T07:40:00.000Z';
  const S = Date.parse(SAMPLED);

  it('正常流逝 ⇒ 刚刚 / 秒 / 分 / 时 / 天', () => {
    expect(formatAgo(SAMPLED, S + 2_000), '小于一个轮询周期（5s）没有区分度').toEqual({ kind: 'now' });
    expect(formatAgo(SAMPLED, S + 30_000)).toEqual({ kind: 'ago', unit: 'seconds', value: 30 });
    expect(formatAgo(SAMPLED, S + 180_000)).toEqual({ kind: 'ago', unit: 'minutes', value: 3 });
    expect(formatAgo(SAMPLED, S + 2 * 3_600_000)).toEqual({ kind: 'ago', unit: 'hours', value: 2 });
    expect(formatAgo(SAMPLED, S + 25 * 3_600_000)).toEqual({ kind: 'ago', unit: 'days', value: 1 });
    expect(formatAgo(SAMPLED, S)).toEqual({ kind: 'now' });
  });

  it('未来时间 ⇒ future + 原样串（**不许**夹成「刚刚」把时钟漂移抹平）', () => {
    const future = formatAgo('2026-11-17T07:45:00.000Z', AT);
    expect(future.kind).toBe('future');
    expect(future.kind === 'future' && future.text).toBe('2026-11-17T07:45:00.000Z');
  });

  it('不可解析 ⇒ raw 原样；缺值 ⇒ unknown；now 脏 ⇒ raw', () => {
    expect(formatAgo('昨天下午', AT)).toEqual({ kind: 'raw', text: '昨天下午' });
    expect(formatAgo(null, AT)).toEqual({ kind: 'unknown' });
    expect(formatAgo(undefined, AT)).toEqual({ kind: 'unknown' });
    expect(formatAgo('2026-11-17T07:40:00.000Z', NaN)).toEqual({ kind: 'raw', text: '2026-11-17T07:40:00.000Z' });
  });
});

describe('formatAxisTime / bucketParts', () => {
  it('端点时间：能解析给本地时间，解析不了原样，缺值 unknown', () => {
    const formatted = formatAxisTime('2026-11-17T07:30:00.000Z', 'zh-CN');
    expect(formatted.kind).toBe('formatted');
    expect(formatAxisTime('nope', 'zh-CN')).toEqual({ kind: 'raw', text: 'nope' });
    expect(formatAxisTime(null, 'zh-CN')).toEqual({ kind: 'unknown' });
    // 脏 locale 不许抛（`toLocaleString` 对非法 locale 会 RangeError）。
    expect(formatAxisTime('2026-11-17T07:30:00.000Z', 'not a locale').kind).toBe('formatted');
    // 跨日范围要带日期，否则两端都叫「08:00」读不出是哪天。
    expect(formatAxisTime('2026-11-17T07:30:00.000Z', 'zh-CN', true).kind).toBe('formatted');
  });

  it('桶宽 ⇒ 值 + 单位（缺值 / 0 ⇒ null，页面不说「每点 0 秒」）', () => {
    expect(bucketParts(30)).toEqual({ value: 30, unit: 'seconds' });
    expect(bucketParts(300)).toEqual({ value: 5, unit: 'minutes' });
    expect(bucketParts(21600)).toEqual({ value: 6, unit: 'hours' });
    expect(bucketParts(null)).toBeNull();
    expect(bucketParts(0)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('sparkPoints：sparkline 取点', () => {
  const points = [
    { t: '2026-11-17T07:30:00.000Z', cpuAvg: 1, cpuMax: 2, memUsed: 100, containersRunning: 3, samples: 1 },
    { t: '2026-11-17T07:35:00.000Z', cpuAvg: 5, cpuMax: 9, memUsed: 200, containersRunning: 4, samples: 2 },
  ];

  it('x = epoch 毫秒，y = 选的那一列', () => {
    expect(sparkPoints(points, (p) => p.cpuAvg)).toEqual([
      { x: Date.parse('2026-11-17T07:30:00.000Z'), y: 1 },
      { x: Date.parse('2026-11-17T07:35:00.000Z'), y: 5 },
    ]);
  });

  it('量值 `null` 的点**丢掉**（画成 0 就是把未知画成贴底——本单硬口径在图上的那一条）', () => {
    const withHole = [...points, { t: '2026-11-17T07:40:00.000Z', cpuAvg: null, cpuMax: 99, memUsed: 0, containersRunning: 0, samples: 1 }];
    expect(sparkPoints(withHole, (p) => p.cpuAvg).map((p) => p.y)).toEqual([1, 5]);
    // 同一点在「有值」的列上照常出现（丢的是这一列的未知，不是整行）。
    expect(sparkPoints(withHole, (p) => p.cpuMax).map((p) => p.y)).toEqual([2, 9, 99]);
  });

  it('时刻脏 / 缺 ⇒ 丢掉（没有 x 坐标可落，硬画会把线拉到 1970）', () => {
    expect(sparkPoints([{ t: null, cpuAvg: 1 }], (p) => p.cpuAvg)).toEqual([]);
    expect(sparkPoints([{ t: 'nope', cpuAvg: 1 }], (p) => p.cpuAvg)).toEqual([]);
    expect(sparkPoints(null, () => 1)).toEqual([]);
  });

  it('超过 60 点只留**最后** 60 个（sparkline 要的是最近趋势，不是把 168 点塞进 DOM）', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      t: new Date(Date.parse('2026-11-17T00:00:00.000Z') + i * 60_000).toISOString(),
      cpuAvg: i, cpuMax: i, memUsed: i, containersRunning: i, samples: 1,
    }));
    const picked = sparkPoints(many, (p) => p.cpuAvg);
    expect(picked).toHaveLength(SPARK_MAX_POINTS);
    expect(picked[0].y).toBe(140);
    expect(picked[picked.length - 1].y).toBe(199);
  });
});

describe('错误文本（服务端 message 原文，不翻译）', () => {
  it('metricsErrorText 取 message 原文；没 message 才 String 兜底', () => {
    expect(metricsErrorText(new Error('kaboom'))).toBe('kaboom');
    expect(metricsErrorText({ message: 'from-server' })).toBe('from-server');
    expect(metricsErrorText(undefined)).toBe('undefined');
  });
});

// ────────────────────────────────────────────────────
// #814：服务端补齐了四个历史列与按设备归组的磁盘序列，前端只能接、不许替它造数。
const T0 = '2026-11-17T07:30:00.000Z';
const T1 = '2026-11-17T07:35:00.000Z';

describe('normalizeSystemMetrics：series 新增四列（脏值 ⇒ null；swap 的 0 是真 0）', () => {
  it('memAvailable/memCached/swapUsed/load1 camel+snake 都接；`swap_used: 0` ⇒ 0', () => {
    const p = normalizeSystemMetrics({
      series: { points: [{ t: T0, memAvailable: 'abc', mem_cached: 1024, swap_used: 0, load_1: 1.024 }] },
    }).series.points[0];
    expect(p.memAvailable, '脏串 ⇒ null（不 `?? 0`）').toBeNull();
    expect(p.memCached).toBe(1024);
    expect(p.swapUsed, '0 是真 0，与 null 是两件事').toBe(0);
    expect(p.load1).toBe(1.024);
  });

  it('只有缓存有值的点不会被判成「没值」而丢掉；负数 / NaN ⇒ null（load 不可能为负）', () => {
    const r = normalizeSystemMetrics({
      series: { points: [{ t: T0, memCached: 512, swapUsed: -3, load1: NaN }] },
    });
    expect(r.series.dropped, '新四列要进脏点判定，否则只剩缓存的点会被当成空点丢掉').toBe(0);
    expect(r.series.points[0].memCached).toBe(512);
    expect(r.series.points[0].swapUsed).toBeNull();
    expect(r.series.points[0].load1).toBeNull();
  });
});

describe('normalizeSystemMetrics：series.disks 归组 / 排序 / unknown 真值 / 不污染 dropped', () => {
  it('按 device 字典序排；snake 也接；unknown 是真值（不过 nullIfUnknown）、path 过 nullIfUnknown', () => {
    const r = normalizeSystemMetrics({
      series: { disks: [
        { device: '/dev/sdb', path: '/srv', points: [{ t: T0, usedBytes: 100, totalBytes: 200, samples: 1 }] },
        { device: '/dev/nvme0n1p2', path: '/', points: [{ t: T0, used_bytes: '50', total_bytes: '100', samples: '2' }] },
        { device: 'unknown', path: 'unknown', points: [{ t: T1, usedBytes: 0 }] },
        null,
        { path: '/no-device' },
      ] },
    });
    expect(r.series.disks.map((d) => d.device)).toEqual(['/dev/nvme0n1p2', '/dev/sdb', 'unknown']);
    const unknown = r.series.disks.find((d) => d.device === 'unknown');
    expect(unknown, 'unknown 是分组键的真值，不许当没有丢掉').toBeDefined();
    expect(unknown!.path, 'path 是展示用引用 ⇒ nullIfUnknown').toBeNull();
    expect(unknown!.points[0].usedBytes, '0 是真 0').toBe(0);
    const nvme = r.series.disks[0];
    expect(nvme.points[0].usedBytes, 'snake used_bytes 也接').toBe(50);
    expect(nvme.points[0].samples).toBe(2);
  });

  it('非数组 ⇒ 空数组；无 t 的点丢掉；disks 的脏不进 series.dropped（不覆盖 points 计数）', () => {
    expect(normalizeSystemMetrics({ series: { disks: 'x' } }).series.disks).toEqual([]);
    const r = normalizeSystemMetrics({
      series: {
        points: [{ cpuAvg: null, t: null }, { t: T1, cpuAvg: 2 }],
        disks: [null, { path: '/x' }, { device: '/dev/sdc', points: [{ usedBytes: 1 }] }],
      },
    });
    expect(r.series.dropped, 'dropped 只数 points 的脏点，不被 disks 覆盖').toBe(1);
    expect(r.series.disks.map((d) => d.device)).toEqual(['/dev/sdc']);
    expect(r.series.disks[0].points, '无 t 的点被丢').toEqual([]);
  });
});

describe('diskTrendFor：卡片行对上一条历史序列', () => {
  const disks = [
    { device: '/dev/nvme0n1p2', path: '/', points: [{ t: T0, usedBytes: 1, totalBytes: 2, samples: 1 }] },
    { device: 'unknown', path: null, points: [{ t: T0, usedBytes: 3, totalBytes: 4, samples: 1 }] },
  ];
  it('device 精确相等才配对', () => {
    expect(diskTrendFor(disks, { device: '/dev/nvme0n1p2' })?.device).toBe('/dev/nvme0n1p2');
  });
  it('卡片 device 为 null ⇔ 序列里的 unknown', () => {
    expect(diskTrendFor(disks, { device: null })?.device).toBe('unknown');
  });
  it('对不上 ⇒ null（**不许**退成随便拿一块盘的线）', () => {
    expect(diskTrendFor(disks, { device: '/dev/sda1' })).toBeNull();
    expect(diskTrendFor(null, { device: '/dev/nvme0n1p2' })).toBeNull();
    expect(diskTrendFor([], { device: null })).toBeNull();
  });
});

describe('normalizeSystemMetrics：disksError 三态（与 seriesError 各自独立）', () => {
  it('缺失 ⇒ null；空串 ⇒ null；原因串 ⇒ 原样；snake 也接', () => {
    expect(normalizeSystemMetrics({}).disksError).toBeNull();
    expect(normalizeSystemMetrics({ disksError: '' }).disksError).toBeNull();
    expect(normalizeSystemMetrics({ disksError: 'disk-query-failed' }).disksError).toBe('disk-query-failed');
    expect(normalizeSystemMetrics({ disks_error: 'snake-reason' }).disksError).toBe('snake-reason');
  });
  it('disksError 非空不代表 points 没数（独立降级）', () => {
    const r = normalizeSystemMetrics({ ...REAL, disksError: 'boom' });
    expect(r.disksError).toBe('boom');
    expect(r.series.points.length).toBeGreaterThan(0);
    expect(r.seriesError, 'seriesError 不受 disksError 影响').toBeNull();
  });
});
