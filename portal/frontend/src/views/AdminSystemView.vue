<script setup lang="ts">
// 管理台 · 「系统」（issue #650，契约 `docs/api/portal.md` §4.20）。**只读**，没有任何写操作。
//
// 这页存在的理由与「关于」（#586）同形：宿主 CPU / 内存 / 磁盘 / 容器数一直有真相（`htop` / `free` /
// `df` / `docker ps`），但界面上一个读数都没有 —— 症状是「FDE 变慢」，而平台不知道宿主快满了。
//
// 四条渲染红线（逐条有 spec 用例钉住）：
//   1. **拿不到一律「未知」**，绝不 `?? 0`（#586 口径）。`containers === null` 是「docker 不可达」，
//      不是「0 台」；`latest === null` 是「这一拍没有」，不是「宿主很闲」。
//   2. **三个降级各自独立**：`enabled`（采样器开没开）、`latest`（有没有第一拍）、`seriesError`
//      （历史读不读得到）互不蕴含。DB 挂了只有图区说「历史不可用」，**四张卡照常渲染** ——
//      卡片读的是进程内那一拍，这正是本端点存在的理由，不是降级补丁。一个错就整页红 = 最需要读数
//      的时候反而没读数。
//   3. **load 必须给归一化**（`load 5.26 / 36 核 ≈ 14.6%`）：36 核机器上裸 load=5 会被读成「快炸了」。
//   4. **磁盘按设备一行**（服务端已去重，一块物理盘一行），且 `diskUnreadable` 的路径必须露面 ——
//      否则「已监控 N 个文件系统」是悄悄少了一行的谎。
//
// 轮询 5s 是 issue #650 写死的常量（设了没人调，设错是新的故障面）；`document.hidden` 时暂停，
// 回到前台**立刻**拉一次（否则切回来看到的还是最长 5s 前的旧数，而「切回来看一眼」正是这页的用法）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAdminStore } from '../stores/admin';
import MetricChart from '../components/MetricChart.vue';
import {
  METRIC_RANGES,
  SPARK_MAX_POINTS,
  diskTrendFor,
  formatAgo,
  formatBytes,
  formatCount,
  formatLoadLine,
  formatPct,
  rangeLabel,
  seriesErrorText,
  sparkPoints,
  type ContainersCell,
  type DiskRow,
  type LatestSnapshot,
  type MetricRange,
  type SeriesPoint,
} from '../lib/systemMetrics';

const { t } = useI18n();
const admin = useAdminStore();

/** 轮询周期（issue #650 写死：5s，与服务端分桶缓存 TTL 对齐）。 */
const POLL_MS = 5_000;

/** 请求的区间。选中态渲染的是**生效**区间（`metrics.range`），不是这个值——见 `activeRange`。 */
const requestedRange = ref<MetricRange>('1h');

const metrics = computed(() => admin.systemMetrics);
const loaded = computed(() => admin.systemMetricsLoaded);
const loading = computed(() => admin.systemMetricsLoading);
const error = computed(() => admin.systemMetricsErr);

/**
 * 选中态用**服务端回显的生效区间**（§4.20：非法入参被回落成 `1h` 并把生效值回在 `range` 里）。
 * 首次请求还没回来时用本地值，否则一排按钮会有一瞬间全不亮。
 */
const activeRange = computed<string>(() => metrics.value?.range ?? requestedRange.value);

/** 「多久前」的基准：每次拉到数据时刷新（lib 里不许自己 `Date.now()`，#586 R-2 同口径）。 */
const nowMs = ref(0);

const latest = computed<LatestSnapshot | null>(() => metrics.value?.latest ?? null);
const enabled = computed(() => metrics.value?.enabled ?? null);
const seriesPoints = computed<SeriesPoint[]>(() => metrics.value?.series.points ?? []);
/** 图区专属的一句话：`seriesError` ⇒「历史不可用：<原因>」，**只进图区，不进卡片**。 */
const chartNote = computed(() => {
  const reason = seriesErrorText(metrics.value?.seriesError);
  return reason === null ? null : t('admin.system.historyUnavailable', { reason });
});
const withDate = computed(() => activeRange.value === '7d' || activeRange.value === '30d');

/** 采样时刻（每卡一条）。脏值/未来时间**原样给出**，不夹成「刚刚」（时钟漂移是真问题，不是噪声）。 */
function sampledText(snapshot: LatestSnapshot | null): string {
  const at = formatAgo(snapshot?.sampledAt ?? null, nowMs.value);
  if (at.kind === 'unknown') return t('admin.system.unknown');
  if (at.kind === 'raw') return t('admin.system.timeUnparsable', { value: at.text });
  if (at.kind === 'future') return t('admin.system.timeFuture', { value: at.text });
  if (at.kind === 'now') return t('admin.system.agoNow');
  return t(`admin.system.ago${at.unit.charAt(0).toUpperCase()}${at.unit.slice(1)}`, { value: at.value });
}

/** 缺值 ⇒ 「未知」（判据 1：这条函数是本页唯一的 `null` 出口，`.vue` 里不许出现 `?? 0`）。 */
function unknownText(): string {
  return t('admin.system.unknown');
}
function pctText(value: number | null): string {
  return formatPct(value) ?? unknownText();
}
function bytesText(value: number | null): string {
  return formatBytes(value) ?? unknownText();
}
function countText(value: number | null): string {
  return formatCount(value) ?? unknownText();
}

/** CPU 使用率那格固定 0~100 的 y 界：百分比的界是**已知**的，用它才不会每次轮询都重标 y 轴。 */
const cpuBounds = { min: 0, max: 100 } as const;

const cpuSpark = computed(() => sparkPoints(seriesPoints.value, (point) => point.cpuAvg, SPARK_MAX_POINTS));
const memSpark = computed(() => sparkPoints(seriesPoints.value, (point) => point.memUsed, SPARK_MAX_POINTS));
const containersSpark = computed(() => sparkPoints(seriesPoints.value, (point) => point.containersRunning, SPARK_MAX_POINTS));

// #814 补齐的趋势线（都是同一个 `seriesPoints` 源，只是选不同列）。
const cpuMaxSpark = computed(() => sparkPoints(seriesPoints.value, (point) => point.cpuMax, SPARK_MAX_POINTS));
const loadSpark = computed(() => sparkPoints(seriesPoints.value, (point) => point.load1, SPARK_MAX_POINTS));
const memAvailSpark = computed(() => sparkPoints(seriesPoints.value, (point) => point.memAvailable, SPARK_MAX_POINTS));
const memCachedSpark = computed(() => sparkPoints(seriesPoints.value, (point) => point.memCached, SPARK_MAX_POINTS));
const memSwapSpark = computed(() => sparkPoints(seriesPoints.value, (point) => point.swapUsed, SPARK_MAX_POINTS));

/** 磁盘历史（按设备归组，一块盘一条线）。 */
const diskSeries = computed(() => metrics.value?.series.disks ?? []);

/**
 * 磁盘图的提示：`disksError` **独立于** `seriesError`，只让磁盘那条线说「历史不可用」；
 * 否则回落到通用 `chartNote`（磁盘查询挂掉不能让内存/容器图也红）。
 */
const diskNote = computed(() => {
  const reason = metrics.value?.disksError ?? null;
  return reason !== null ? t('admin.system.disksUnavailable', { reason }) : chartNote.value;
});

/**
 * 磁盘那一行要不要配图：
 *   · `disksError` 非空 ⇒ 磁盘那条查询挂了、拿不到任何线，**仍要出图**说「历史不可用」（空态 + 原因）；
 *   · 否则只有「这块盘真的对上了历史」才出图——卡片里有但历史里没有的盘**不配图**（不拿别的盘的历史糊上去）。
 */
function hasDiskTrend(row: DiskRow): boolean {
  if ((metrics.value?.disksError ?? null) !== null) return true;
  return diskTrendFor(diskSeries.value, row) !== null;
}

/** 卡片那一行对上它自己的历史；对不上 ⇒ 空数组（**不许**拿别的盘的线糊上去）。 */
function diskSpark(row: DiskRow) {
  const trend = diskTrendFor(diskSeries.value, row);
  return trend === null ? [] : sparkPoints(trend.points, (point) => point.usedBytes, SPARK_MAX_POINTS);
}

/** load 归一化（判据 3）：三段拼进 i18n 句子；任一段缺值 ⇒ 整句不出（不出 `NaN%`）。 */
const loadLine = computed(() => {
  const parts = formatLoadLine(latest.value?.cpu.load ?? null, latest.value?.cpu.cores ?? null);
  if (parts === null || parts.pct === null) return null;
  return t('admin.system.loadLine', { load: parts.load, cores: parts.cores, pct: parts.pct });
});

/** 桶宽一句话：`samples === 1` 时也要说清粒度（§4.20：一个点时分桶结果与原始点等价，读者需要知道）。 */
const bucketText = computed(() => {
  const seconds = metrics.value?.series.bucketSeconds ?? null;
  const parts = bucketPartsOf(seconds);
  if (parts === null) return null;
  return t(`admin.system.bucket${parts.unit.charAt(0).toUpperCase()}${parts.unit.slice(1)}`, { value: parts.value });
});

function bucketPartsOf(seconds: number | null): { value: number; unit: string } | null {
  if (seconds === null || seconds <= 0) return null;
  if (seconds < 60) return { value: seconds, unit: 'seconds' };
  if (seconds < 3600) return { value: Math.round(seconds / 60), unit: 'minutes' };
  return { value: Math.round(seconds / 3600), unit: 'hours' };
}

const diskRows = computed<DiskRow[]>(() => latest.value?.disk ?? []);
const diskUnreadable = computed(() => latest.value?.diskUnreadable ?? []);
const containers = computed<ContainersCell | null>(() => latest.value?.containers ?? null);

/** 对账行：只有 `drift.count > 0` 才点名（一致时列名字是噪声；不一致时不点名就得让人自己去数）。 */
const driftNamesShown = computed(() => {
  const drift = containers.value?.drift ?? null;
  if (drift === null) return null;
  const count = drift.count ?? drift.onlyDb.length + drift.onlyDocker.length;
  if (count <= 0) return null;
  return {
    onlyDb: drift.onlyDb.length > 0 ? t('admin.system.driftOnlyDb', { names: drift.onlyDb.join(', ') }) : null,
    onlyDocker: drift.onlyDocker.length > 0 ? t('admin.system.driftOnlyDocker', { names: drift.onlyDocker.join(', ') }) : null,
  };
});

function rangeText(range: unknown): string {
  return rangeLabel(range) ?? unknownText();
}

async function chooseRange(range: MetricRange): Promise<void> {
  if (requestedRange.value === range) return;
  requestedRange.value = range;
  await refresh();
}

/** 一次拉取（轮询、点开、切区间、回到前台都走这里）。action 自己 catch ⇒ 不产生未捕获拒绝。 */
async function refresh(): Promise<void> {
  const before = admin.systemMetricsLoaded;
  const message = await admin.fetchSystemMetrics(requestedRange.value);
  if (message === null || !before) nowMs.value = Date.now();
}

let timer: ReturnType<typeof setInterval> | null = null;

function onVisibility(): void {
  // 回到前台立刻拉一次：隐藏期间定时器照常空转是浪费，而停在后台 5s 的旧数会让人误判「现在就没事」。
  if (!document.hidden) void refresh();
}

onMounted(() => {
  void refresh();
  timer = setInterval(() => {
    if (!document.hidden) void refresh();
  }, POLL_MS);
  document.addEventListener('visibilitychange', onVisibility);
});

onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer);
  timer = null;
  document.removeEventListener('visibilitychange', onVisibility);
});

/** 首次加载：骨架（**不显示 0**，也不显示「未知」——那时候连「服务端说了什么」都还不知道）。 */
const showSkeleton = computed(() => loading.value && !loaded.value);
const retentionText = computed(() => {
  const days = metrics.value?.retentionDays ?? null;
  return days === null ? null : t('admin.system.retention', { days });
});
</script>

<template>
  <section data-test="admin-system" class="grid gap-3">
    <header class="grid gap-1">
      <h2 class="text-lg font-medium">{{ t('admin.system.title') }}</h2>
      <p class="text-xs text-black/60">{{ t('admin.system.intro') }}</p>
      <p v-if="retentionText" data-test="system-retention" class="text-xs text-black/45">{{ retentionText }}</p>
    </header>

    <!-- 范围切换：选中态 = **生效**区间（服务端回显），不是本地点过的那个 -->
    <nav data-test="range-buttons" class="flex flex-wrap gap-1" :aria-label="t('admin.system.rangeLabel')">
      <button
        v-for="range in METRIC_RANGES"
        :key="range"
        :data-test="`range-${range}`"
        type="button"
        class="rounded-md border px-2.5 py-1 text-sm"
        :class="activeRange === range
          ? 'border-brand font-semibold text-brand'
          : 'border-black/20 text-black/60 hover:bg-black/5'"
        :aria-pressed="activeRange === range ? 'true' : 'false'"
        :aria-busy="loading && requestedRange === range ? 'true' : 'false'"
        @click="chooseRange(range)"
      >{{ range }}</button>
    </nav>

    <!-- 首次加载的骨架：三格灰条，一个数字都没有（判据：不许出现 0 / 未知 / 空值假线） -->
    <div v-if="showSkeleton" data-test="system-loading" role="status" class="grid gap-2">
      <p class="text-sm text-black/60">{{ t('admin.system.loading') }}</p>
      <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div v-for="n in 4" :key="n" class="h-32 animate-pulse rounded-lg bg-black/5" />
      </div>
    </div>

    <p v-if="error" data-test="system-error" class="syserr text-sm" role="alert">{{ error }}</p>

    <p v-if="!loaded && !loading && !error" data-test="system-not-loaded" class="text-sm text-black/60">
      {{ t('admin.system.notLoaded') }}
    </p>

    <template v-if="loaded && !showSkeleton">
      <!-- 采样器状态条：三态各自独立（`enabled === null` = 服务端没说 ⇒ 这里一个字都不说） -->
      <p
        v-if="enabled === false"
        data-test="system-disabled"
        class="rounded-lg border border-black/15 bg-black/5 p-2 text-sm"
      >
        {{ t('admin.system.samplingDisabled') }}
      </p>
      <p
        v-else-if="enabled === true && latest === null"
        data-test="system-waiting"
        class="rounded-lg border border-black/10 p-2 text-sm text-black/60"
      >
        {{ t('admin.system.waitingFirstSample') }}
      </p>

      <!-- 图区专属：历史读不到只说这一句，四张卡照常渲染（判据 2） -->
      <p v-if="chartNote" data-test="system-series-error" class="text-sm text-black/60" role="status">
        {{ chartNote }}
      </p>

      <!-- ① CPU -->
      <section data-test="card-cpu" class="rounded-lg border border-black/10 p-3">
        <h3 class="text-sm font-semibold">{{ t('admin.system.cpuTitle') }}</h3>
        <div class="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div>
            <span class="text-xs text-black/55">{{ t('admin.system.cpuUsage') }}</span>
            <p data-test="cpu-usage" class="font-mono">{{ pctText(latest?.cpu.usagePct ?? null) }}</p>
          </div>
          <div>
            <span class="text-xs text-black/55">{{ t('admin.system.cpuCores') }}</span>
            <p data-test="cpu-cores" class="font-mono">{{ countText(latest?.cpu.cores ?? null) }}</p>
          </div>
        </div>
        <!-- 判据 3：load 必须带归一化 -->
        <p data-test="cpu-load" class="mt-1 font-mono text-sm">
          {{ loadLine ?? t('admin.system.unknown') }}
        </p>
        <MetricChart
          class="mt-2 max-w-md"
          :points="cpuSpark"
          :min="cpuBounds.min"
          :max="cpuBounds.max"
          metric-id="cpu-avg"
          :caption="t('admin.system.chartCpuAvg')"
          :note="chartNote"
          :empty-text="t('admin.system.noData')"
          :format-y="(value: number) => `${Math.round(value)}%`"
          :with-date="withDate"
          :label="t('admin.system.cpuTitle')"
        />
        <MetricChart
          class="mt-1 max-w-md"
          :points="cpuMaxSpark"
          :min="0"
          :max="100"
          metric-id="cpu-max"
          :caption="t('admin.system.chartCpuMax')"
          :note="chartNote"
          :empty-text="t('admin.system.noData')"
          :format-y="(value: number) => `${Math.round(value)}%`"
          :with-date="withDate"
          :label="t('admin.system.cpuTitle')"
        />
        <MetricChart
          class="mt-1 max-w-md"
          :points="loadSpark"
          :min="0"
          metric-id="load1"
          :caption="t('admin.system.chartLoad1')"
          :note="chartNote"
          :empty-text="t('admin.system.noData')"
          :format-y="(v: number) => v.toFixed(2)"
          :with-date="withDate"
          :label="t('admin.system.cpuTitle')"
        />
        <p data-test="cpu-sampled-at" class="mt-1 text-xs text-black/50">
          {{ t('admin.system.sampledAt', { at: sampledText(latest) }) }}
        </p>
      </section>

      <!-- ② 内存 -->
      <section data-test="card-mem" class="rounded-lg border border-black/10 p-3">
        <h3 class="text-sm font-semibold">{{ t('admin.system.memTitle') }}</h3>
        <p data-test="mem-used" class="mt-2 font-mono text-sm">
          {{ bytesText(latest?.mem.usedBytes ?? null) }} / {{ bytesText(latest?.mem.totalBytes ?? null) }}
          <span class="text-xs text-black/45">{{ pctText(latest?.mem.usedPct ?? null) }}</span>
        </p>
        <dl class="mt-1 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <div>
            <dt class="text-xs text-black/55">{{ t('admin.system.memAvailable') }}</dt>
            <dd data-test="mem-available" class="font-mono">{{ bytesText(latest?.mem.availableBytes ?? null) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-black/55">{{ t('admin.system.memCached') }}</dt>
            <dd data-test="mem-cached" class="font-mono">{{ bytesText(latest?.mem.cachedBytes ?? null) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-black/55">{{ t('admin.system.memSwap') }}</dt>
            <dd data-test="mem-swap" class="font-mono">{{ bytesText(latest?.mem.swapUsedBytes ?? null) }}</dd>
          </div>
        </dl>
        <MetricChart
          class="mt-2 max-w-md"
          :points="memSpark"
          :min="0"
          metric-id="mem-used"
          :caption="t('admin.system.chartMemUsed')"
          :note="chartNote"
          :empty-text="t('admin.system.noData')"
          :format-y="(value: number) => formatBytes(value) ?? String(value)"
          :with-date="withDate"
          :label="t('admin.system.memTitle')"
        />
        <MetricChart
          class="mt-1 max-w-md"
          :points="memAvailSpark"
          :min="0"
          metric-id="mem-available"
          :caption="t('admin.system.chartMemAvailable')"
          :note="chartNote"
          :empty-text="t('admin.system.noData')"
          :format-y="(value: number) => formatBytes(value) ?? String(value)"
          :with-date="withDate"
          :label="t('admin.system.memTitle')"
        />
        <MetricChart
          class="mt-1 max-w-md"
          :points="memCachedSpark"
          :min="0"
          metric-id="mem-cached"
          :caption="t('admin.system.chartMemCached')"
          :note="chartNote"
          :empty-text="t('admin.system.noData')"
          :format-y="(value: number) => formatBytes(value) ?? String(value)"
          :with-date="withDate"
          :label="t('admin.system.memTitle')"
        />
        <MetricChart
          class="mt-1 max-w-md"
          :points="memSwapSpark"
          :min="0"
          metric-id="mem-swap"
          :caption="t('admin.system.chartMemSwap')"
          :note="chartNote"
          :empty-text="t('admin.system.noData')"
          :format-y="(value: number) => formatBytes(value) ?? String(value)"
          :with-date="withDate"
          :label="t('admin.system.memTitle')"
        />
        <p data-test="mem-sampled-at" class="mt-1 text-xs text-black/50">
          {{ t('admin.system.sampledAt', { at: sampledText(latest) }) }}
        </p>
      </section>

      <!-- ③ 磁盘（按设备去重：一块物理盘一行） -->
      <section data-test="card-disk" class="rounded-lg border border-black/10 p-3">
        <h3 class="text-sm font-semibold">{{ t('admin.system.diskTitle') }}</h3>
        <p data-test="disk-monitored" class="mt-0.5 text-xs text-black/55">
          {{ t('admin.system.diskMonitored', { count: diskRows.length }) }}
        </p>
        <p v-if="diskRows.length === 0" data-test="disk-empty" class="mt-2 text-sm text-black/60">
          {{ latest === null ? t('admin.system.noSample') : t('admin.system.diskNone') }}
        </p>
        <ul v-else class="mt-2 grid gap-2 text-sm">
          <li v-for="row in diskRows" :key="`${row.device ?? ''}|${row.path ?? ''}`" data-test="disk-row" class="grid gap-1">
            <div class="flex flex-wrap items-baseline gap-x-2">
              <span data-test="disk-device" class="font-mono font-medium">{{ row.device ?? unknownText() }}</span>
              <span data-test="disk-mount" class="font-mono text-black/60">{{ row.path ?? unknownText() }}</span>
              <span data-test="disk-fs" class="rounded border border-black/15 px-1 text-xs text-black/55">
                {{ row.fs ?? unknownText() }}
              </span>
            </div>
            <div class="h-2 w-full max-w-md overflow-hidden rounded bg-black/10" role="presentation">
              <div
                data-test="disk-bar"
                class="h-full bg-brand/70"
                :style="{ width: `${row.usedPct === null ? 0 : Math.max(0, Math.min(100, row.usedPct))}%` }"
              />
            </div>
            <p data-test="disk-usage" class="font-mono text-xs text-black/70">
              {{ bytesText(row.usedBytes) }} / {{ bytesText(row.totalBytes) }}
              ({{ pctText(row.usedPct) }}) · {{ t('admin.system.diskAvail', { value: bytesText(row.availBytes) }) }}
            </p>
            <!-- 只对「真的对上了历史」或「磁盘查询报错」的行出图；卡片里有但历史里没有的盘不配图（不拿别的盘糊） -->
            <MetricChart
              v-if="hasDiskTrend(row)"
              class="mt-1 max-w-md"
              :points="diskSpark(row)"
              :min="0"
              :metric-id="`disk-${row.device ?? 'unknown'}-used`"
              :caption="t('admin.system.chartDiskUsed')"
              :note="diskNote"
              :empty-text="t('admin.system.noData')"
              :format-y="(value: number) => formatBytes(value) ?? String(value)"
              :with-date="withDate"
              :label="t('admin.system.diskTitle')"
            />
          </li>
        </ul>
        <!-- 配了但读不到的路径也要露面，否则「已监控 N 个」是少了一行的谎 -->
        <ul v-if="diskUnreadable.length > 0" class="mt-2 grid gap-1 text-sm">
          <li v-for="row in diskUnreadable" :key="`unreadable-${row.path ?? ''}`" data-test="disk-unreadable" class="text-black/60">
            <span class="font-mono">{{ row.path ?? unknownText() }}</span>
            <span class="ml-1">{{ t('admin.system.diskUnreadable', { reason: row.reason ?? unknownText() }) }}</span>
          </li>
        </ul>
        <p v-if="diskRows.length > 0 && diskUnreadable.length === 0" data-test="disk-unreadable-none" class="mt-1 text-xs text-black/40">
          {{ t('admin.system.diskUnreadableNone') }}
        </p>
        <p class="mt-1 text-xs text-black/45">{{ t('admin.system.diskCaveat') }}</p>
      </section>

      <!-- ④ 容器 -->
      <section data-test="card-containers" class="rounded-lg border border-black/10 p-3">
        <h3 class="text-sm font-semibold">{{ t('admin.system.containersTitle') }}</h3>
        <p v-if="containers === null" data-test="containers-unknown" class="mt-2 text-sm text-black/60">
          {{ latest === null ? t('admin.system.noSample') : t('admin.system.containersUnreadable') }}
        </p>
        <template v-else>
          <p data-test="containers-running" class="mt-2 font-mono text-sm">
            {{ countText(containers.running) }} / {{ countText(containers.total) }}
          </p>
          <dl class="mt-1 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            <div>
              <dt class="text-xs text-black/55">{{ t('admin.system.containersStation') }}</dt>
              <dd data-test="containers-station" class="font-mono">{{ countText(containers.station) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-black/55">{{ t('admin.system.containersFde') }}</dt>
              <dd data-test="containers-fde" class="font-mono">
                {{ countText(containers.fdeRunning) }} / {{ countText(containers.fde) }}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-black/55">{{ t('admin.system.containersPausedStopped') }}</dt>
              <dd data-test="containers-paused-stopped" class="font-mono">
                {{ countText(containers.paused) }} / {{ countText(containers.stopped) }}
              </dd>
            </div>
          </dl>
          <!-- 对账行：DB 说 N 台 ↔ Docker 实际 M 台（不一致才点名，见 `driftNamesShown`） -->
          <p v-if="containers.drift !== null" data-test="containers-drift" class="mt-2 text-sm font-mono">
            {{ t('admin.system.driftLine', { db: countText(containers.drift.db), docker: countText(containers.drift.docker) }) }}
          </p>
          <p v-else data-test="containers-drift-unknown" class="mt-2 text-sm text-black/60">
            {{ t('admin.system.driftUnknown') }}
          </p>
          <template v-if="driftNamesShown">
            <p v-if="driftNamesShown.onlyDb" data-test="drift-only-db" class="text-sm text-amber-900">
              {{ driftNamesShown.onlyDb }}
            </p>
            <p v-if="driftNamesShown.onlyDocker" data-test="drift-only-docker" class="text-sm text-amber-900">
              {{ driftNamesShown.onlyDocker }}
            </p>
          </template>
        </template>
        <MetricChart
          class="mt-2 max-w-md"
          :points="containersSpark"
          metric-id="containers-running"
          :caption="t('admin.system.chartContainers')"
          :note="chartNote"
          :empty-text="t('admin.system.noData')"
          :with-date="withDate"
          :label="t('admin.system.containersTitle')"
        />
        <p data-test="containers-sampled-at" class="mt-1 text-xs text-black/50">
          {{ t('admin.system.sampledAt', { at: sampledText(latest) }) }}
        </p>
      </section>

      <!-- 口径本身（不写进界面就不算说清楚）-->
      <p class="text-xs text-black/50">
        {{ t('admin.system.caveat', { range: rangeText(metrics?.range ?? null) }) }}
        <span v-if="bucketText" data-test="system-bucket" class="ml-2">{{ bucketText }}</span>
        <span v-if="(metrics?.series.dropped ?? 0) > 0" data-test="system-dropped" class="ml-2">
          {{ t('admin.system.droppedPoints', { count: metrics?.series.dropped ?? 0 }) }}
        </span>
        <span v-if="(latest?.diskDropped ?? 0) > 0" data-test="disk-dropped" class="ml-2">
          {{ t('admin.system.diskDropped', { count: latest?.diskDropped ?? 0 }) }}
        </span>
      </p>
    </template>
  </section>
</template>
