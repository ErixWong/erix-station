// 管理台「系统」面板（issue #650，契约 `docs/api/portal.md` §4.18）的纯逻辑：
// 端点响应 → 强类型 DTO + 展示用格式化。**渲染红线全部落在这个文件**，`.vue` 里只做搬运。
//
// 本文件存在的理由与 #586（版本三格）同形：**真相本来就有**（`htop` / `free` / `df` / `docker ps`），
// 但界面上一个读数都没有。所以这里的硬口径不是「格式化得漂亮」，而是**不许把不知道说成数**：
//   1. **缺值一律 `null`，绝不 `?? 0`**。服务端 `latest` 里任何一项拿不到都给 `null`（#586 口径），
//      把 `null` 兜成 `0` 会把「不知道宿主忙不忙」演成「宿主很闲」——那正是 #650 要治的病。
//   2. **三态各自独立降级**：`enabled`（采样器开没开）、`latest`（有没有第一拍）、`seriesError`
//      （历史读不读得到）是**三个互不蕴含**的事实。`seriesError` 非空时 `latest` 仍是好的，
//      四张卡照常渲染，只有图区说「历史不可用」。一个错就整页红 = 读面在最需要的时候反而没读数。
//   3. **数组里一个脏元素不许打死整张图**：脏点丢弃 + 计数（`dropped`），页面可以说「有 N 个点被丢掉」。
//
// `enabled` 为什么必须服务端说而不是前端从 `latest === null` 反推：那个形状同时兼容
// 「采样已关闭」与「刚重启还没第一拍」两个**相反结论**（前者要去改 env 重启，后者只要等 30s）。
import type { ApiError } from '../api';

/** 端点路径（唯一拼法；`?range=` 由 `systemMetricsPath()` 拼）。 */
export const SYSTEM_METRICS_PATH = '/api/admin/system/metrics';

/** 五个合法范围（服务端 `METRIC_RANGES` 的镜像；缺省 `1h` 由服务端说了算，这里不复制缺省）。 */
export const METRIC_RANGES = ['1h', '6h', '24h', '7d', '30d'] as const;
export type MetricRange = (typeof METRIC_RANGES)[number];

/** sparkline 每卡最多取多少个点（工单：取 `series.points` 最后 60 点；30d/6h 桶都会超）。 */
export const SPARK_MAX_POINTS = 60;

/** 端点 URL。非法 / 缺省 range ⇒ **不带参数**（让服务端回落 `1h`，前端不自己造第二个缺省口径）。 */
export function systemMetricsPath(range?: string | null): string {
  return isMetricRange(range) ? `${SYSTEM_METRICS_PATH}?range=${range}` : SYSTEM_METRICS_PATH;
}

export function isMetricRange(value: unknown): value is MetricRange {
  return typeof value === 'string' && (METRIC_RANGES as readonly string[]).includes(value);
}

/**
 * 范围的展示标签。**五个合法取值直接回 token**（`1h` / `6h` / `24h` / `7d` / `30d`）——
 * 这不是偷懒：issue #650 把按钮写死成这五个字面量，它们本身就是 locale 中立的单位写法。
 *
 * 不认识 / 没给 ⇒ `null`（页面渲染「未知」）。⚠ **不许退成 `'1h'`**：服务端会把非法入参
 * 回落成 `1h` 并在 `range` 里回显生效值，所以这里收到不认识的值意味着「它没说」——
 * 替它说「1h」就是把页面的选中态画错（而选中态必须是**生效**的那个）。
 */
export function rangeLabel(range: unknown): string | null {
  return isMetricRange(range) ? range : null;
}

// ── DTO ────────────────────────────────────────────────────────────────────────────────

export interface CpuCell {
  usagePct: number | null;
  cores: number | null;
  /** `[load1, load5, load15]`，**每格都可能是 `null`**（服务端逐格降级）。 */
  load: [number | null, number | null, number | null];
}

export interface MemCell {
  totalBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  cachedBytes: number | null;
  swapUsedBytes: number | null;
  usedPct: number | null;
}

/** 一行 = 一个**物理盘（一个文件系统）**：服务端已按设备去重，前端不许再去重或合并。 */
export interface DiskRow {
  device: string | null;
  path: string | null;
  fs: string | null;
  totalBytes: number | null;
  usedBytes: number | null;
  availBytes: number | null;
  usedPct: number | null;
}

/** 配了但 `statfs` 失败的路径 —— 必须露面，否则「已监控 N 个文件系统」是少了一行的谎。 */
export interface DiskUnreadable {
  path: string | null;
  reason: string | null;
}

/** `DB N 台 ↔ Docker M 台` 的对账结果（不一致时才点名）。 */
export interface DriftCell {
  db: number | null;
  docker: number | null;
  onlyDb: string[];
  onlyDocker: string[];
  count: number | null;
}

/** `null`（整格）= docker 不可达，**不是 0 台**。 */
export interface ContainersCell {
  total: number | null;
  running: number | null;
  paused: number | null;
  stopped: number | null;
  station: number | null;
  fde: number | null;
  fdeRunning: number | null;
  /** `null` = 服务端没读到 DB 侧的名字（说「没读到」，不说「一致」）。 */
  drift: DriftCell | null;
}

export interface LatestSnapshot {
  sampledAt: string | null;
  cpu: CpuCell;
  mem: MemCell;
  disk: DiskRow[];
  diskUnreadable: DiskUnreadable[];
  containers: ContainersCell | null;
  /** `disk` 里被丢掉的脏元素数（>0 时页面要显式说一句，不静默少一行）。 */
  diskDropped: number;
}

export interface SeriesPoint {
  t: string | null;
  cpuAvg: number | null;
  cpuMax: number | null;
  memUsed: number | null;
  containersRunning: number | null;
  samples: number | null;
}

export interface SystemMetrics {
  /**
   * 采样器到底开没开。**三态**：`true` / `false` 是服务端说了；`null` = 没说
   * （老后端 / 桩给半截）—— `null` 不许渲染成「采样已关闭」（那是把「没说」读成「说了不是」）。
   */
  enabled: boolean | null;
  /** `null` = 采样器没跑**或**还没第一拍（这两个分支靠 `enabled` 区分，不许在这里合并成一个）。 */
  latest: LatestSnapshot | null;
  series: {
    bucketSeconds: number | null;
    points: SeriesPoint[];
    /** 被丢掉的脏点数（>0 要显式说出来）。 */
    dropped: number;
  };
  /** **生效的** range（非法入参已被服务端回落）。`null` = 服务端没说。 */
  range: string | null;
  retentionDays: number | null;
  /** 非 `null` ⇒ 历史读不到（`latest` 仍可能有数）。这里存的是**原因字符串**，不是 Error。 */
  seriesError: string | null;
}

// ── 归一化原语 ──────────────────────────────────────────────────────────────────────────

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 有限数：只认 `number` 与「可解析成有限数的字符串」（pg 的 `numeric` 驱动回字符串是既成事实），
 * 其余（`null` / `''` / `NaN` / `Infinity` / 布尔 / 对象）⇒ `null`。
 * ⚠ **不 `Number(value) || 0`**：`''`、`false`、`NaN` 都会被那个 `||` 演成 `0`。
 */
function numOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 非负数（字节、核数、台数、秒数都是非负量）：负数是脏值 ⇒ `null`，不夹成 0（夹=替数据做主）。 */
function nonNegativeOrNull(value: unknown): number | null {
  const n = numOrNull(value);
  return n === null || n < 0 ? null : n;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** 只认真布尔（#643B 同口径：`'true'` / `1` 不算「服务端说了是」）。 */
function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function numberArrayOrNull(value: unknown, length: number): (number | null)[] | null {
  if (!Array.isArray(value) || value.length < length) return null;
  return value.slice(0, length).map((item) => numOrNull(item));
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringOrNull(item)).filter((item): item is string => item !== null);
}

// ── 归一化 ──────────────────────────────────────────────────────────────────────────────

function normalizeCpu(raw: Record<string, unknown> | null): CpuCell {
  const load = numberArrayOrNull(raw?.load, 3) ?? [null, null, null];
  return {
    usagePct: numOrNull(raw?.usagePct ?? raw?.usage_pct),
    cores: nonNegativeOrNull(raw?.cores),
    load: [load[0] ?? null, load[1] ?? null, load[2] ?? null],
  };
}

function normalizeMem(raw: Record<string, unknown> | null): MemCell {
  return {
    totalBytes: nonNegativeOrNull(raw?.totalBytes ?? raw?.total_bytes),
    usedBytes: nonNegativeOrNull(raw?.usedBytes ?? raw?.used_bytes),
    availableBytes: nonNegativeOrNull(raw?.availableBytes ?? raw?.available_bytes),
    cachedBytes: nonNegativeOrNull(raw?.cachedBytes ?? raw?.cached_bytes),
    swapUsedBytes: nonNegativeOrNull(raw?.swapUsedBytes ?? raw?.swap_used_bytes),
    usedPct: numOrNull(raw?.usedPct ?? raw?.used_pct),
  };
}

function normalizeDrift(raw: unknown): DriftCell | null {
  const record = recordOf(raw);
  if (record === null) return null;
  return {
    db: nonNegativeOrNull(record.db),
    docker: nonNegativeOrNull(record.docker),
    onlyDb: stringList(record.onlyDb ?? record.only_db),
    onlyDocker: stringList(record.onlyDocker ?? record.only_docker),
    count: nonNegativeOrNull(record.count),
  };
}

function normalizeContainers(raw: unknown): ContainersCell | null {
  const record = recordOf(raw);
  if (record === null) return null;   // `null` / 脏形状都 ⇒ 整格未知（docker 不可达，不是 0 台）
  return {
    total: nonNegativeOrNull(record.total),
    running: nonNegativeOrNull(record.running),
    paused: nonNegativeOrNull(record.paused),
    stopped: nonNegativeOrNull(record.stopped),
    station: nonNegativeOrNull(record.station),
    fde: nonNegativeOrNull(record.fde),
    fdeRunning: nonNegativeOrNull(record.fdeRunning ?? record.fde_running),
    drift: normalizeDrift(record.drift),
  };
}

function normalizeLatest(raw: unknown): LatestSnapshot | null {
  const root = recordOf(raw);
  if (root === null) return null;     // `null` / 缺键 / 数组 / 字符串 ⇒ 「没有这一拍」
  const diskRaw = Array.isArray(root.disk) ? (root.disk as unknown[]) : [];
  const disk: DiskRow[] = [];
  let diskDropped = 0;
  for (const item of diskRaw) {
    const row = recordOf(item);
    // 丢件判定要说准：**整条记录不是对象**才算脏；对象里字段脏是逐格 `null`（服务端逐格降级）。
    if (row === null) {
      diskDropped += 1;
      continue;
    }
    disk.push({
      // 服务端缺设备名时给字面量 `unknown`（`toApiLatest`）——那是「不知道是哪个设备」，收成 `null`。
      device: nullIfUnknown(stringOrNull(row.device)),
      path: stringOrNull(row.path),
      fs: nullIfUnknown(stringOrNull(row.fs)),
      totalBytes: nonNegativeOrNull(row.totalBytes ?? row.total_bytes),
      usedBytes: nonNegativeOrNull(row.usedBytes ?? row.used_bytes),
      availBytes: nonNegativeOrNull(row.availBytes ?? row.avail_bytes),
      usedPct: numOrNull(row.usedPct ?? row.used_pct),
    });
  }
  const unreadableRaw = Array.isArray(root.diskUnreadable) ? (root.diskUnreadable as unknown[]) : [];
  return {
    sampledAt: stringOrNull(root.sampled_at ?? root.sampledAt),
    cpu: normalizeCpu(recordOf(root.cpu)),
    mem: normalizeMem(recordOf(root.mem)),
    disk,
    diskUnreadable: unreadableRaw
      .map((item) => recordOf(item))
      .filter((item): item is Record<string, unknown> => item !== null)
      .map((item) => ({ path: stringOrNull(item.path), reason: stringOrNull(item.reason) })),
    containers: normalizeContainers(root.containers),
    diskDropped,
  };
}

/** 服务端的降级字面量 `unknown`（`toApiLatest` 给设备名/文件系统类型用的）＝「不知道」⇒ `null`。 */
function nullIfUnknown(value: string | null): string | null {
  return value === null || value.toLowerCase() === 'unknown' ? null : value;
}

function normalizeSeries(raw: unknown): SystemMetrics['series'] {
  const root = recordOf(raw);
  const pointsRaw = Array.isArray(root?.points) ? ((root?.points as unknown[])) : [];
  const points: SeriesPoint[] = [];
  let dropped = 0;
  for (const item of pointsRaw) {
    const point = recordOf(item);
    if (point === null) {
      dropped += 1;
      continue;
    }
    // 整行都没有时刻、也没有任何量值 ⇒ 这个点画不出来（丢，但计数）。
    const values = [point.cpuAvg, point.cpuMax, point.memUsed, point.containersRunning];
    const hasValue = values.some((value) => numOrNull(value) !== null);
    const t = stringOrNull(point.t);
    if (!hasValue && t === null) {
      dropped += 1;
      continue;
    }
    points.push({
      t,
      cpuAvg: numOrNull(point.cpuAvg ?? point.cpu_avg),
      cpuMax: numOrNull(point.cpuMax ?? point.cpu_max),
      memUsed: nonNegativeOrNull(point.memUsed ?? point.mem_used),
      containersRunning: nonNegativeOrNull(point.containersRunning ?? point.containers_running),
      samples: nonNegativeOrNull(point.samples),
    });
  }
  return { bucketSeconds: nonNegativeOrNull(root?.bucketSeconds ?? root?.bucket_seconds), points, dropped };
}

/** 端点响应 → DTO。入参 `unknown`：服务端换形、桩给半截、字段脏值都不许炸，也不许猜。 */
export function normalizeSystemMetrics(raw: unknown): SystemMetrics {
  const root = recordOf(raw) ?? {};
  const seriesError = stringOrNull(root.seriesError ?? root.series_error);
  return {
    enabled: booleanOrNull(root.enabled),
    latest: normalizeLatest(root.latest),
    series: normalizeSeries(root.series),
    range: isMetricRange(root.range) ? root.range : null,
    retentionDays: nonNegativeOrNull(root.retentionDays ?? root.retention_days),
    // 空串按「没说」处理（`seriesError` 的契约是 `null` 或非空原因串；空串是脏值不是原因）。
    seriesError,
  };
}

// ── sparkline 取点 ──────────────────────────────────────────────────────────────────────

export interface ChartPointLike {
  x: number;
  y: number;
}

/**
 * `series.points` → 折线用的 `{x,y}[]`（`x` = epoch 毫秒）。
 *
 * 三条不许含糊的取法：
 *   · **时刻不可解析的点丢掉**（x 没有坐标轴可落，硬画会把线拉到 1970）；
 *   · **量值 `null` 的点丢掉**（`null` 是「那一阵没读到」，画成 0 就是把未知画成贴底——
 *     本单的硬口径在图上的体现就是这一条）；
 *   · 只取**最后 `SPARK_MAX_POINTS` 个**（30d/6h 桶是 72~168 点，sparkline 不需要那么细，
 *     而全塞进 `<path>` 只让 DOM 变胖）。
 */
export function sparkPoints(
  points: SeriesPoint[] | null | undefined,
  pick: (point: SeriesPoint) => number | null,
  limit: number = SPARK_MAX_POINTS,
): ChartPointLike[] {
  if (!Array.isArray(points)) return [];
  const out: ChartPointLike[] = [];
  for (const point of points) {
    const raw = point === null || typeof point !== 'object' ? null : point.t;
    const y = pick(point);
    if (typeof raw !== 'string' || raw === '' || y === null) continue;
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) continue;
    out.push({ x: at, y });
  }
  const cap = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : out.length;
  return out.length > cap ? out.slice(out.length - cap) : out;
}

// ── 展示用纯函数（可单测；`.vue` 里不许再写一遍）────────────────────────────────────────

/** 一 KiB = 1024 字节……一 GiB = 1024³（**二进制口径**，后缀写死 `KiB/MiB/GiB/TiB`，不许写成 GB）。 */
const BINARY_STEPS = [
  { divisor: 1024 ** 4, unit: 'TiB' },
  { divisor: 1024 ** 3, unit: 'GiB' },
  { divisor: 1024 ** 2, unit: 'MiB' },
  { divisor: 1024, unit: 'KiB' },
] as const;

/** 一 KB = 1000 字节……一 TB = 1000⁴（**十进制口径**，`df --si` / 厂商标称用；与上面**不许混**）。 */
const DECIMAL_STEPS = [
  { divisor: 1000 ** 4, unit: 'TB' },
  { divisor: 1000 ** 3, unit: 'GB' },
  { divisor: 1000 ** 2, unit: 'MB' },
  { divisor: 1000, unit: 'KB' },
] as const;

/**
 * 字节数 → 人话，**保留 1 位小数**。
 *
 * 口径写清（工单判据）：`kind='binary'`（缺省）走 1024 并输出 `KiB/MiB/GiB/TiB`；
 * `kind='decimal'` 走 1000 并输出 `KB/GB/TB`。选哪个不是审美问题——`free -m` 是 1024，
 * `df -h` 默认也是 1024 但**后缀写的是 K/G/T**（GNU coreutils 的历史包袱），而 `df --si` 才是 1000。
 * 我们**只认自己输出的后缀**：单位写在数字里，就不会有人拿 `GiB` 的数去对 `GB` 的标称值。
 *
 * `null` / 负数 / 脏值 ⇒ `null`（调用方渲染「未知」）。⚠ **不许**在这里 `?? 0`。
 */
export function formatBytes(bytes: number | null | undefined, kind: 'binary' | 'decimal' = 'binary'): string | null {
  const value = nonNegativeOrNull(bytes);
  if (value === null) return null;
  const steps = kind === 'decimal' ? DECIMAL_STEPS : BINARY_STEPS;
  for (const step of steps) {
    if (value >= step.divisor) return `${round1(value / step.divisor)} ${step.unit}`;
  }
  return `${Math.round(value)} B`;
}

/**
 * 保留 1 位小数，**去掉多余的 `.0`**（`30.0 GiB` 满屏很难读，`30 GiB` 与 `1.6 GiB` 共存才自然）。
 * 先除后取整再 `String()`：`Math.round(x*10)/10` 已经把浮点尾巴（`0.30000000000000004`）刷掉，
 * `String` 给出最短表示，所以这里**不许**改用 `toFixed(1)`（那会退回满屏 `.0`）。
 */
function round1(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** 百分比：服务端已经算过口径（`usedPct`），这里只格式化，**不重新除**。缺值 ⇒ `null`。 */
export function formatPct(pct: number | null | undefined, digits = 1): string | null {
  const value = numOrNull(pct);
  if (value === null) return null;
  const fixed = Number.isFinite(digits) && digits >= 0 ? Math.floor(digits) : 1;
  return `${value.toFixed(fixed)}%`;
}

/** 整数（台数、核数、秒数）：脏值 ⇒ `null`。负数按脏处理（这些量在本契约里不可能为负）。 */
export function formatCount(value: number | null | undefined): string | null {
  const n = nonNegativeOrNull(value);
  return n === null ? null : String(Math.trunc(n));
}

/**
 * load 的**归一化幅度**（`load1 / cores × 100`）。36 核机器上 `load 5.26` 会被读成「快炸了」，
 * 说成「≈ 14.6%」才是可判读的事实（工单 §前端 点名的那条）。
 *
 * 口径：这是**近似**，不是 CPU 使用率（load 含不可中断 IO，且不按核加权），所以文案里要留
 * 「≈」而不是「=」。`cores` 缺值或 0 ⇒ `null`（没有分母就不许给百分比）。
 */
export function loadNormalizedPct(load1: number | null | undefined, cores: number | null | undefined): number | null {
  const load = numOrNull(load1);
  const n = nonNegativeOrNull(cores);
  if (load === null || n === null || n === 0) return null;
  return (load / n) * 100;
}

export interface LoadLineParts {
  load: string;
  cores: string;
  pct: string | null;
}

/**
 * load 行的三段（句子留在 i18n 里：`admin.system.loadLine`，中英两套各说各的）。
 * 分三段而不是拼死一个中文字符串：lib 里出现中文就是英文界面下的假账。
 * `load1` 或 `cores` 缺值 ⇒ `null`（整行不渲染归一化那半句）。
 */
export function formatLoadLine(
  load: readonly (number | null)[] | null | undefined,
  cores: number | null | undefined,
): LoadLineParts | null {
  const first = Array.isArray(load) ? numOrNull(load[0]) : null;
  const coresText = formatCount(cores);
  if (first === null || coresText === null) return null;
  return {
    load: round1ish(first),
    cores: coresText,
    pct: formatPct(loadNormalizedPct(first, cores), 1),
  };
}

/** load 是浮点，保留 2 位（`5.26`）；`0` 就写 `0`，`1.2` 就写 `1.2`（不补 `1.20`）。 */
function round1ish(value: number): string {
  return String(Math.round(value * 100) / 100);
}

// ── 「多久之前」──────────────────────────────────────────────────────────────────────────

export type AgoResult =
  | { kind: 'unknown' }
  | { kind: 'raw'; text: string }
  | { kind: 'future'; text: string }
  | { kind: 'now' }
  | { kind: 'ago'; unit: 'seconds' | 'minutes' | 'hours' | 'days'; value: number };

/**
 * 采样时刻 → 「30 秒前 / 3 分钟前」。
 *
 * `nowMs` 由调用方给（**这里不 `Date.now()`**）：单测要能钉住「给定 now 就说给定的一句话」，
 * 而 #586 的源码级红线也是「lib 不许自己造当下时刻」。
 *
 * 三条不许编：
 *   · 不可解析 / `null` ⇒ `unknown` 或 `raw`（脏值**原样给出**，不静默丢掉）；
 *   · 时间在未来 ⇒ `future` + 原样串（时钟漂移或假夹具，**不许**夹成「刚刚」——那会把
 *     「采样器与本机时钟不一致」这个真问题抹平）；
 *   · `|差值| < 5s` ⇒ `now`（轮询就是 5s，小于一个轮询周期的差没有区分度）。
 */
export function formatAgo(sampledAt: string | null | undefined, nowMs: number): AgoResult {
  if (sampledAt === null || sampledAt === undefined) return { kind: 'unknown' };
  const at = Date.parse(sampledAt);
  if (!Number.isFinite(at)) return { kind: 'raw', text: sampledAt };
  const now = numOrNull(nowMs);
  if (now === null) return { kind: 'raw', text: sampledAt };
  const deltaMs = now - at;
  if (deltaMs < -5_000) return { kind: 'future', text: sampledAt };
  const seconds = Math.floor(Math.max(0, deltaMs) / 1000);
  if (seconds < 5) return { kind: 'now' };
  if (seconds < 60) return { kind: 'ago', unit: 'seconds', value: seconds };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { kind: 'ago', unit: 'minutes', value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { kind: 'ago', unit: 'hours', value: hours };
  return { kind: 'ago', unit: 'days', value: Math.floor(hours / 24) };
}

/**
 * 坐标轴端点的本地时间（工单：X 轴标两端本地时间）。
 * 脏值 / 缺值 ⇒ `unknown` 或 `raw`（原样给，不猜）。`withDate` = 区间跨天时带上日期。
 */
export function formatAxisTime(
  raw: string | null | undefined,
  locale: string,
  withDate = false,
): { kind: 'unknown' } | { kind: 'raw'; text: string } | { kind: 'formatted'; text: string } {
  if (raw === null || raw === undefined) return { kind: 'unknown' };
  const at = new Date(raw);
  if (!Number.isFinite(at.getTime())) return { kind: 'raw', text: raw };
  try {
    const options: Intl.DateTimeFormatOptions = withDate
      ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
      : { hour: '2-digit', minute: '2-digit', hour12: false };
    return { kind: 'formatted', text: at.toLocaleString(locale, options) };
  } catch {
    // 脏 locale（`toLocaleString` 对非法 locale 抛 RangeError）⇒ 退回不带 locale 的本地格式。
    try {
      return { kind: 'formatted', text: at.toLocaleString() };
    } catch {
      return { kind: 'raw', text: raw };
    }
  }
}

/** 桶宽 → 「每点 30 秒」的秒/分/小时三段（句子留在 i18n；缺值 ⇒ `null`，不猜成 30）。 */
export function bucketParts(seconds: number | null | undefined): { value: number; unit: 'seconds' | 'minutes' | 'hours' } | null {
  const value = nonNegativeOrNull(seconds);
  if (value === null || value === 0) return null;
  if (value < 60) return { value, unit: 'seconds' };
  if (value < 3600) return { value: Math.round(value / 60), unit: 'minutes' };
  return { value: Math.round(value / 3600), unit: 'hours' };
}

/**
 * `seriesError`（**响应里的原因字符串**）→ 展示文本。空 / 脏 ⇒ `null` = 「没有这句话」。
 * 服务端只给原因（`code` 优先，没 code 才给 message），堆栈与 SQL 不会出现在这里。
 */
export function seriesErrorText(seriesError: unknown): string | null {
  return stringOrNull(seriesError);
}

/**
 * **请求本身**失败（403 / 网络断）的展示文本：服务端 message 原文不翻译（与 #350 / #586 同口径）。
 * 与 `seriesErrorText` 分开是刻意的：前者是「这次请求没成功」，后者是「请求成功了但历史读不到」。
 */
export function metricsErrorText(err: unknown): string {
  const error = err as Partial<ApiError> | null | undefined;
  if (error && typeof error.message === 'string' && error.message !== '') return error.message;
  if (err instanceof Error && err.message !== '') return err.message;
  return String(err);
}
