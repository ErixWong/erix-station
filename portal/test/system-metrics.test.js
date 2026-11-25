// issue #650：宿主资源监控（`/proc` 解析 / 采样器防护 / 分桶查询 / 读面）的单测。
//
// 要治的真事故：管理台没有任何宿主资源读面，CPU/内存/磁盘/容器数只能 SSH 上机看 ⇒ 「FDE 变慢」
// 而平台不知道宿主是不是快满了（与 #586 的版本分裂同形状）。本文件钉的是这个读面的**语义**：
// 「读不到」说什么、什么情况下不写库、DB 挂了界面还剩什么。
//
// 隔离（docs/testing.md §2.1 + AGENTS §4）：**全部**注入假 pool + 假时钟 + 假 docker + 假
// readFile/statfs + 假 setInterval。不碰真实 DB、不碰真实 `/proc`、不建真实定时器 ⇒ 四条防护
// （单飞 / 写失败不抛 / `ENABLED=0` 零写入零定时器 / `unref()`）在这里都是确定性复现，不吃时序。
// 采样器只在 `cli.js serve` 启动、`createServer` 不启动它 ⇒ 本文件的 HTTP 用例也不会被定时器拖住。
// 判绿只看退出码（AGENTS §4）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseProcStat, cpuUsagePct, parseMeminfo, parseLoadavg, parseUptime,
  parseProcMounts, isRealBlockDevice, diskRows, pickBucketSeconds, seriesSql,
  retentionPurgeSql, purgeSystemMetrics, querySeries, clearSeriesCache,
  countContainers, containerDrift, startMetricsSampler, toApiLatest, metricsApiPayload,
  disksInsertSql, WRITE_METRICS_SQL,
  BUCKET_SECONDS, SERIES_TARGET_POINTS, METRIC_RANGES, DOCKER_LIST_TTL_MS,
} from '../src/system-metrics.js';
import { startReaperLoop } from '../src/internal.js';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { FakePool } from './fake-pool.js';

// ── 夹具 ─────────────────────────────────────────────────────────────────────────────────
// `PROC_STAT` 是真机形状（字段数与顺序照原样，含 guest 两列）；采样器用例另用 `STAT_STEPS`，
// 因为「使用率」是**两点相减**——同一份文本读两次必然算不出（见 `priming` 那条用例）。
const PROC_STAT = [
  'cpu  1017 0 904 3674125 28 0 66 0 100 0',
  'cpu0 300 0 250 918000 8 0 20 0 30 0',
  'cpu1 280 0 240 918200 7 0 18 0 25 0',
  'intr 12345678 0 0',
  'ctxt 999',
  'btime 1700000000',
  'processes 4242',
  'procs_running 3',
].join('\n');

// 两拍之间 total 涨 1000、idle 涨 750 ⇒ busy 250 ⇒ **恰好 25%**（断言里不用魔数就能核对口径）。
// 写成 `n` 的函数而不是两个固定文本：采样器每个拍都会重读 `/proc/stat`，只给两份文本的话
// 第三拍就没得减了（多个用例要跑三拍以上）。
function statText(n) {
  const busy = 200 + 250 * (n - 1);
  const idle = 800 + 750 * (n - 1);
  return `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 ${busy / 2} 0 0 ${idle / 2} 0 0 0 0 0 0\n`
    + `cpu1 ${busy / 2} 0 0 ${idle / 2} 0 0 0 0 0 0`;
}

const PROC_MEMINFO = [
  'MemTotal:       131809112 kB',
  'MemFree:          500000 kB',
  'MemAvailable:   100000000 kB',
  'Buffers:         8000000 kB',
  'Cached:         20000000 kB',
  'SwapCached:            0 kB',
  'Active:         30000000 kB',
  'SwapTotal:      8388604 kB',
  'SwapFree:       6291452 kB',
  'SReclaimable:    3000000 kB',
  'HugePages_Total:       0',
].join('\n');

/**
 * 假 readFile：`overrides` 里给**函数**就是「第 N 次读返回 `fn(N)`」。
 * 采样器需要它：CPU 使用率是相邻两拍相减，同一份文本永远算不出（而多拍用例要跑 ≥3 拍）。
 */
function makeReadFile(overrides = {}) {
  const files = {
    stat: (n) => statText(n),
    meminfo: PROC_MEMINFO,
    loadavg: '5.26 3.10 2.40 2/1234 4321\n',
    uptime: '123456.78 360000.00\n',
    mounts: '/dev/nvme0n1p2 / ext4 rw,relatime 0 0\noverlay / overlay rw 0 0\n',
    ...overrides,
  };
  const reads = {};
  const read = async (p) => {
    const name = String(p).split('/').pop();
    read.calls.push(p);
    if (!(name in files)) {
      const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
      err.code = 'ENOENT';
      throw err;
    }
    const value = files[name];
    if (typeof value === 'function') {
      reads[name] = (reads[name] ?? 0) + 1;
      return value(reads[name]);
    }
    return value;
  };
  read.calls = [];
  read.files = files;
  return read;
}

function makeStatfs(sizes = {}, { slowFirstCall = null } = {}) {
  const table = { '/': { blocks: 937000000, bfree: 214000000, bavail: 150000000 }, ...sizes };
  let calls = 0;
  return async (p) => {
    calls += 1;
    if (calls === 1 && slowFirstCall) await slowFirstCall;
    const hit = table[p];
    if (!hit) {
      const err = new Error(`ENOENT: statfs '${p}'`);
      err.code = 'ENOENT';
      throw err;
    }
    return { bsize: 4096, blocks: hit.blocks, bfree: hit.bfree, bavail: hit.bavail };
  };
}

const CONTAINER_LIST = [
  { Id: 'a', Names: ['/station-portal'], State: 'running', Labels: {} },
  { Id: 'b', Names: ['/fde-eric'], State: 'running', Labels: { 'station.managed': 'true' } },
  { Id: 'c', Names: ['/fde-bob'], State: 'paused', Labels: { 'station.managed': 'true' } },
  { Id: 'd', Names: ['/fde-old'], State: 'exited', Labels: { 'station.managed': 'true' } },
  { Id: 'e', Names: ['/unmanaged-by-name'], State: 'running', Labels: {} },
];

function makeDocker({ list = CONTAINER_LIST, status = 200, throwOnCall = null } = {}) {
  const handle = { calls: 0 };
  handle.call = async () => {
    handle.calls += 1;
    if (throwOnCall) throw throwOnCall;
    return { status, data: list };
  };
  return handle;
}

/** 采样器用的假 pool：按 SQL 文本分流；未点名的语句归 `other`。 */
class MetricsPool {
  constructor({ dbNames = [], failWrite = false } = {}) {
    this.dbNames = dbNames;
    this.failWrite = failWrite;
    this.queries = [];      // {sql, params, kind}
    this.commits = 0;
    this.rollbacks = 0;
    this.releases = 0;
  }

  _kind(sql) {
    const text = String(sql);
    if (/DELETE FROM system_metrics\b/.test(text)) return 'purge';
    if (/FROM system_metrics\b/.test(text)) return 'series';
    if (/FROM containers\b/.test(text)) return 'dbNames';
    if (/INSERT INTO system_metrics_disks\b/.test(text)) return 'insertDisks';
    if (/INSERT INTO system_metrics\b/.test(text)) return 'insertMetrics';
    if (/^\s*BEGIN\b/i.test(text)) return 'begin';
    if (/^\s*COMMIT\b/i.test(text)) return 'commit';
    if (/^\s*ROLLBACK\b/i.test(text)) return 'rollback';
    return 'other';
  }

  _rowsFor(kind) {
    if (kind === 'dbNames') return this.dbNames.map((n) => ({ container_name: n }));
    if (kind === 'series') {
      return [{
        bucket: new Date('2026-11-17T03:00:00Z'), cpu_avg: '12.34', cpu_max: '33.33',
        mem_used: '50671616', containers_running: 3, samples: 7,
      }];
    }
    return [];
  }

  async query(sql, params = []) {
    const kind = this._kind(sql);
    this.queries.push({ sql: String(sql), params, kind });
    if (this.failWrite && (kind === 'insertMetrics' || kind === 'insertDisks')) {
      const err = new Error('insert boom');
      err.code = '23505';
      throw err;
    }
    if (kind === 'commit') this.commits += 1;
    if (kind === 'rollback') this.rollbacks += 1;
    return { rows: this._rowsFor(kind), rowCount: kind === 'purge' ? 3 : 0 };
  }

  async connect() {
    const self = this;
    return {
      query: (sql, params) => self.query(sql, params),
      release() { self.releases += 1; },
    };
  }

  countOf(kind) {
    return this.queries.filter((q) => q.kind === kind).length;
  }

  find(kind) {
    return this.queries.find((q) => q.kind === kind);
  }
}

function makeClock(start = 1_700_000_000_000) {
  const clock = { at: start };
  clock.now = () => clock.at;
  clock.pass = (ms) => { clock.at += ms; };
  return clock;
}

/** 假 setInterval：记录节拍与 `unref()`，**永不真的定时**（用例靠 `tickOnce()` 推进）。 */
function makeIntervalFake() {
  const fake = { set: [], cleared: [], unrefed: 0 };
  fake.setInterval = (fn, ms) => {
    const timer = { id: fake.set.length + 1, fn, ms, cleared: false };
    timer.unref = () => { fake.unrefed += 1; };
    fake.set.push(timer);
    return timer;
  };
  fake.clearInterval = (timer) => {
    fake.cleared.push(timer);
    if (timer) timer.cleared = true;
  };
  return fake;
}

const SILENT_LOG = { warn() {}, log() {}, debug() {}, error() {} };

/** 一套完整的采样器依赖（默认可写、docker 可达、不自动跑启动拍）。 */
function makeSampler(options = {}) {
  const clock = options.clock ?? makeClock();
  const pool = options.pool ?? new MetricsPool({ dbNames: ['fde-eric', 'fde-bob'] });
  const timers = makeIntervalFake();
  const docker = options.docker === undefined ? makeDocker() : options.docker;
  const logs = { warn: [], log: [], debug: [] };
  const log = {
    warn: (m) => logs.warn.push(String(m)),
    log: (m) => logs.log.push(String(m)),
    debug: (m) => logs.debug.push(String(m)),
    error: () => {},
  };
  const config = options.config ?? {
    dockerHost: 'unix:///fixture/docker.sock',
    systemMetrics: { enabled: true, intervalSeconds: 30, retentionDays: 30, diskPaths: ['/'] },
  };
  const readFile = options.readFile ?? makeReadFile();
  const sampler = startMetricsSampler({
    pool,
    docker,
    config,
    log,
    now: clock.now,
    readFile,
    statfs: options.statfs ?? makeStatfs(),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    procRoot: options.procRoot ?? '/proc',
    tickOnStart: options.tickOnStart ?? false,
  });
  return { sampler, pool, docker, clock, timers, logs, config, readFile };
}

/** 跑满「两拍」：第一拍 priming（不写库），第二拍两点可减 ⇒ 真写。返回第二拍的结果。 */
async function runTwoTicks(ctx, gapMs = 30_000) {
  await ctx.sampler.tickOnce();
  ctx.clock.pass(gapMs);
  return ctx.sampler.tickOnce();
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// 1) `/proc` 解析
// ─────────────────────────────────────────────────────────────────────────────────────────

test('#650 parseProcStat：cpu 汇总行 + 核数数的是 cpuN 行条数；guest 两列不双计', () => {
  const stat = parseProcStat(PROC_STAT);
  assert.equal(stat.cores, 2, 'cores = `cpuN` 行的条数（不是 os.cpus().length：同一次采样只留一个真相）');
  // user+nice+system+idle+iowait+irq+softirq+steal = 1017+0+904+3674125+28+0+66+0
  assert.equal(stat.total, 3676140, 'total 不含 guest/guest_nice（内核已把它们计进 user/nice）');
  assert.equal(stat.idle, 3674125 + 28, 'idle = idle + iowait');
  assert.equal(stat.fields.guest, 100, '`fields` 仍保留 guest 原值（只有求和时排除）');
  assert.equal(parseProcStat('btime 1700000000\n'), null, '没有 cpu 行 = 读到的不是 /proc/stat ⇒ null');
});

test('#650 parseProcStat：老内核缺字段按 0 参与求和，但 fields 里保留 null（说得出「没给」）', () => {
  const stat = parseProcStat('cpu  100 0 50 800\n');   // 没有 iowait/irq/softirq/steal/guest
  assert.equal(stat.total, 950);
  assert.equal(stat.idle, 800);
  assert.equal(stat.fields.iowait, null, '缺的字段是 null，不是 0');
  assert.equal(stat.fields.steal, null);
  assert.equal(stat.cores, 0, '只有汇总行 ⇒ 核数按 0 计（不猜）');
});

test('#650 cpuUsagePct：两点相减；回绕/重置/没走一个 jiffy 一律 null（不是 0）', () => {
  const prev = { total: 1000, idle: 800 };
  assert.equal(cpuUsagePct(prev, { total: 2000, idle: 1700 }), 10,
    '增量 total 1000 / idle 900 ⇒ busy 100 = 10%');
  assert.equal(cpuUsagePct(prev, { total: 900, idle: 700 }), null,
    'cur.total < prev.total = 计数器回绕/被重置（宿主机重启、/proc 换命名空间）⇒ 不知道');
  assert.equal(cpuUsagePct(prev, { total: 1000, idle: 800 }), null,
    '两次采样间一个 jiffy 都没走 ⇒ 没得减，不是 0%');
  assert.equal(cpuUsagePct(prev, { total: 2000, idle: 1900 }), null,
    'idle 增量(1100) 比总增量(1000) 还大 = 两侧不同源，宁可说不知道');
  assert.equal(cpuUsagePct(prev, { total: 2000, idle: 800 }), 100, '全 busy ⇒ 截到 100，不给 120%');
  assert.equal(cpuUsagePct(null, { total: 2000, idle: 1900 }), null, '没有上一拍（启动第一拍）⇒ null');
  assert.equal(cpuUsagePct(prev, { total: 'x', idle: 900 }), null, '脏值（非有限数）⇒ null');
  assert.equal(cpuUsagePct(STAT1(), STAT2()), 25, '夹具自证：两拍差值恰好 25%');
});

function STAT1() { return parseProcStat(statText(1)); }
function STAT2() { return parseProcStat(statText(2)); }

test('#650 parseMeminfo：used = MemTotal - MemAvailable（**不是** - MemFree）', () => {
  const mem = parseMeminfo(PROC_MEMINFO);
  assert.equal(mem.memTotalBytes, 131809112 * 1024);
  assert.equal(mem.memUsedBytes, (131809112 - 100000000) * 1024,
    'page cache 是可回收的占用：拿 free 当可用会把 128G 的机器读成只剩 10G');
  assert.equal(mem.memAvailableBytes, 100000000 * 1024);
  assert.equal(mem.memCachedBytes, (8000000 + 20000000 + 3000000) * 1024,
    'cached = Buffers + Cached + SReclaimable（给「used 为什么这么高」一个解释）');
  assert.equal(mem.swapUsedBytes, (8388604 - 6291452) * 1024);
});

test('#650 parseMeminfo：MemAvailable 缺失不回落到 MemFree（换口径就是撒谎）', () => {
  const mem = parseMeminfo('MemTotal: 1000 kB\nMemFree: 900 kB\n');   // < 3.14 的内核
  assert.equal(mem.memUsedBytes, null, '宁可空着，也不拿另一个口径的数填同一个格子');
  assert.equal(mem.memFreeBytes, 900 * 1024, 'free 自己那格照常给');
  assert.equal(mem.memCachedBytes, 0, '一个可回收字段都没有 = 真 0');
  assert.equal(mem.swapUsedBytes, null, '没有 SwapTotal 行 = 不知道，不是「没有 swap」');
  const noTotal = parseMeminfo('MemFree: 900 kB\n');
  assert.equal(noTotal.memTotalBytes, null);
  assert.equal(noTotal.memUsedBytes, null, '连总量都不知道时不给百分比');
  // 没有 `kB` 单位的行（HugePages 一族）也认（按字节存）
  assert.equal(parseMeminfo('HugePages_Total:       8\n').memFreeBytes, null);
});

test('#650 parseLoadavg / parseUptime：0 是真 0，脏值才是 null', () => {
  assert.deepEqual(parseLoadavg('0.00 0.00 0.00 1/200 9\n'), { load1: 0, load5: 0, load15: 0 });
  assert.deepEqual(parseLoadavg('5.26 3.1 2.4 2/1234 4321'), { load1: 5.26, load5: 3.1, load15: 2.4 });
  assert.deepEqual(parseLoadavg('garbage'), { load1: null, load5: null, load15: null });
  assert.deepEqual(parseLoadavg(''), { load1: null, load5: null, load15: null });
  assert.deepEqual(parseLoadavg('-1 2 3'), { load1: null, load5: 2, load15: 3 }, '负数是脏值');
  assert.deepEqual(parseUptime('123456.78 360000'), { uptimeSeconds: 123456 }, '取整秒');
  assert.deepEqual(parseUptime('nonsense'), { uptimeSeconds: null });
});

// ── `/proc/mounts`：只认真实块设备 ────────────────────────────────────────────────────────
//
// 这条是本轮修掉的**真缺陷**：旧口径「source 以 /dev/ 开头」会把 snap 的 `/dev/loop0`（squashfs
// 只读压缩镜像）当成一块盘。本机 `/proc/mounts` 里 `/dev/loop*` 有 8 条（`grep -c` 实测）⇒
// 旧口径会让面板凭空多出 8 行假盘，而它们的「用量」是镜像填充度、毫无运维含义。
const MOUNTS_FIXTURE = [
  'overlay / overlay rw,relatime,lowerdir=/a,upperdir=/b 0 0',
  '/dev/nvme0n1p2 /srv/erix/users ext4 rw,relatime 0 0',
  '/dev/nvme0n1p2 /srv/erix/artifacts ext4 rw,relatime 0 0',
  '/dev/nvme0n1p1 /boot/efi vfat rw 0 0',
  '/dev/sda1 /mnt/sata ext4 rw 0 0',
  '/dev/vda2 /mnt/virtio ext4 rw 0 0',
  '/dev/mapper/vg--data-lv ext4 rw 0 0',
  '/dev/md0 /mnt/md ext4 rw 0 0',
  '/dev/loop0 /snap/core20/2866 squashfs ro,nodev,relatime 0 0',
  '/dev/loop7 /snap/snapd/1 squashfs ro 0 0',
  '/dev/ram0 /mnt/ram ext4 rw 0 0',
  '/dev/zram0 /mnt/zram ext4 rw 0 0',
  'tmpfs /dev/shm tmpfs rw 0 0',
  'proc /proc proc rw 0 0',
  'cgroup2 /sys/fs/cgroup cgroup2 rw 0 0',
  '/dev/nvme0n1p2 /mnt/with\\040space ext4 rw 0 0',
].join('\n');

test('#650 parseProcMounts：解析层**全收**（块设备判定交给 isRealBlockDevice / diskRows）', () => {
  // 261118 真机验收改的口径：容器里 `/` 是 `overlay`，解析层若把它滤掉，面板上唯一那块盘的
  // 设备名与类型就都成了「未知」。所以解析层不再过滤，「哪一行算一块盘」由 diskRows 决定。
  const rows = parseProcMounts(MOUNTS_FIXTURE);
  const devices = rows.map((r) => r.device);
  for (const want of ['/dev/nvme0n1p2', '/dev/sda1', '/dev/vda2', '/dev/mapper/vg--data-lv', '/dev/md0']) {
    assert.ok(devices.includes(want), `${want} 必须在结果里（真实块设备）`);
  }
  assert.ok(devices.includes('overlay'), '`overlay` 必须收：容器里的 `/` 就是它（兜底要用）');
  assert.ok(devices.includes('tmpfs'), '`tmpfs` 也收（兜底用；它不会参与去重键）');
  assert.ok(rows.some((r) => r.path === '/mnt/with space'), '\\040 必须还原成空格，否则前缀匹配会漏');
  // 同一设备的多条挂载行**原样保留**（去重是 `diskRows` 的职责，不在解析层）：fixture 里 3 行
  assert.equal(devices.filter((d) => d === '/dev/nvme0n1p2').length, 3);
  assert.deepEqual(rows.find((r) => r.device === '/dev/md0'),
    { device: '/dev/md0', path: '/mnt/md', fs: 'ext4' });
  // 但「是不是一块盘」这个判断本身没变松：loop/ram/zram 依旧 false（它们只是**不被拿来当设备名**）。
  for (const notDisk of ['/dev/loop0', '/dev/loop7', '/dev/ram0', '/dev/zram0']) {
    assert.equal(isRealBlockDevice(notDisk), false, `${notDisk} 不是盘`);
  }
});

test('#650 isRealBlockDevice：判定谓词逐值钉（`/dev/` 前缀不等于「是一块盘」）', () => {
  assert.deepEqual(
    ['/dev/sda', '/dev/sda1', '/dev/nvme0n1', '/dev/nvme0n1p2', '/dev/vda', '/dev/vda2',
      '/dev/mapper/vg--data', '/dev/md0', '/dev/md1p1'].map((d) => isRealBlockDevice(d)),
    [true, true, true, true, true, true, true, true, true],
  );
  assert.deepEqual(
    ['/dev/loop0', '/dev/loop', '/dev/ram0', '/dev/zram0', '/dev/sr0', '/dev/tty0', '/dev/shm',
      'overlay', 'tmpfs', '', null, undefined, '/dev/'].map((d) => isRealBlockDevice(d)),
    [false, false, false, false, false, false, false, false, false, false, false, false, false],
    '/dev/sr0（光驱）与 /dev/tty* 不在允许前缀里 ⇒ false',
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 2) 磁盘：一个物理盘 = 一行
// ─────────────────────────────────────────────────────────────────────────────────────────

test('#650 diskRows：同一设备多路径去重成一行，path 取最短那个', async () => {
  const same = { blocks: 937000000, bfree: 214000000, bavail: 150000000 };
  const { rows, unreadable } = await diskRows({
    paths: ['/srv/erix/artifacts', '/srv/erix/users'],
    mounts: parseProcMounts(MOUNTS_FIXTURE),
    statfs: makeStatfs({
      '/srv/erix/artifacts': same,
      '/srv/erix/users': same,
      '/boot/efi': { blocks: 256000, bfree: 200000, bavail: 200000 },
    }),
  });
  assert.equal(unreadable.length, 0);
  assert.deepEqual(rows.map((r) => [r.device, r.path, r.fs]),
    [['/dev/nvme0n1p2', '/srv/erix/users', 'ext4']],
    '同一块盘 bind 了两个路径 ⇒ 只出一行，path 取最短的那个（否则面板会出现两行一模一样的 937G）');
  assert.equal(rows[0].totalBytes, 4096 * 937000000);
  assert.equal(rows[0].usedBytes, 4096 * (937000000 - 214000000), 'used = total - bfree（`df` 的口径）');
  assert.equal(rows[0].availBytes, 4096 * 150000000,
    'avail 用 bavail（扣掉 root 预留块），拿 bfree 去算会与 `df -h` 差一截');
});

test('#650 diskRows：statfs 读不到的路径进 unreadable（不写 0、不让整页失败）', async () => {
  const { rows, unreadable } = await diskRows({
    paths: ['/', '/srv/not-mounted'],
    mounts: [{ device: '/dev/nvme0n1p2', path: '/', fs: 'ext4' }],
    statfs: makeStatfs(),   // 只有 `/` 有值
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].device, '/dev/nvme0n1p2', '设备名来自挂载表（bind mount 报宿主设备，实测）');
  assert.deepEqual(unreadable, [{ path: '/srv/not-mounted', reason: 'ENOENT' }],
    '读不到的路径要露面（否则「已监控 N 个文件系统」会变成悄悄少了一行的谎）');
});

test('#650 diskRows：设备名取**最长前缀**匹配的挂载行；匹配不到 ⇒ unknown 但仍出这一行', async () => {
  const mounts = [
    { device: '/dev/sdb1', path: '/srv/erix', fs: 'xfs' },
    { device: '/dev/sdc1', path: '/srv/erix/users', fs: 'ext4' },
  ];
  const { rows } = await diskRows({
    paths: ['/srv/erix/users/alice', '/var/lib/docker'],
    mounts,
    // 两个路径给**不同**数值：去重键是 statfs 三元组，同值会被并成一行（那是另一条用例的事）。
    statfs: makeStatfs({
      '/srv/erix/users/alice': { blocks: 100, bfree: 10, bavail: 5 },
      '/var/lib/docker': { blocks: 200, bfree: 20, bavail: 10 },
    }),
  });
  assert.deepEqual(rows.map((r) => [r.path, r.device, r.fs]), [
    ['/srv/erix/users/alice', '/dev/sdc1', 'ext4'],
    ['/var/lib/docker', 'unknown', 'unknown'],
  ], '最长前缀优先：`/srv/erix/users` 赢过 `/srv/erix`；挂载表里没有前缀匹配的行 ⇒ unknown（仍然出这一行）');

  const rootOnly = await diskRows({
    paths: ['/'],
    mounts: [{ device: '/dev/nvme0n1p2', path: '/', fs: 'ext4' }],
    statfs: makeStatfs(),
  });
  assert.equal(rootOnly.rows[0].device, '/dev/nvme0n1p2', '挂载表只有 `/` 时它就是那一行');
});

test('#650 diskRows：容器里的 `/` 是 overlay ⇒ 设备名/类型取挂载行，**不再双「未知」**（261118 真机）', async () => {
  // 真机反例：部署后 `/api/admin/system/metrics` 返回 device='unknown', fs='unknown'，面板上唯一那块盘
  // 两格都是「未知」。根因是解析层把非块设备滤掉了。现在兜底取挂载行 ⇒ `overlay` / `overlay`。
  const { rows } = await diskRows({
    paths: ['/'],
    mounts: parseProcMounts(MOUNTS_FIXTURE),   // fixture 第一条就是 `overlay / overlay ...`
    statfs: makeStatfs(),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].device, 'overlay', '设备名诚实地报 overlay（不冒充 /dev/xxx）');
  assert.equal(rows[0].fs, 'overlay', '类型也报 overlay');
  assert.ok(rows[0].totalBytes > 0, '尺寸/用量照样有（statfs 走的是底层文件系统）');
});

test('#650 diskRows：overlay 与 /dev/… 是**同一个文件系统** ⇒ 并成一行，且升级成真实设备名', async () => {
  // 容器里 `/` 是 overlay、bind 进来的宿主目录是 `/dev/nvme0n1p2`，两者 statfs 三个数一模一样。
  // 按设备名去重会出两行同数的盘；按 statfs 三元组归并 ⇒ 一行，且真实设备名优先。
  const same = { blocks: 937000000, bfree: 214000000, bavail: 150000000 };
  const { rows } = await diskRows({
    paths: ['/', '/srv/erix/users'],
    mounts: parseProcMounts(MOUNTS_FIXTURE),
    statfs: makeStatfs({ '/': same, '/srv/erix/users': same }),
  });
  assert.equal(rows.length, 1, '同一文件系统只能一行（否则面板出现两行一模一样的 937G）');
  assert.equal(rows[0].device, '/dev/nvme0n1p2', '真实块设备名优先于 overlay');
  assert.equal(rows[0].fs, 'ext4');
  assert.equal(rows[0].path, '/', 'path 取最短那个');
});

test('#650 diskRows：statfs 结果缺字段 ⇒ unreadable（NOT NULL 三列不许写「不知道」）', async () => {
  const { rows, unreadable } = await diskRows({
    paths: ['/'],
    mounts: [],
    statfs: async () => ({ bsize: 4096, blocks: 100 }),   // 缺 bfree/bavail
  });
  assert.deepEqual(rows, []);
  assert.deepEqual(unreadable, [{ path: '/', reason: 'statfs_incomplete' }]);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 3) 分桶
// ─────────────────────────────────────────────────────────────────────────────────────────

test('#650 pickBucketSeconds：目标 ≤240 点，取**最小**能装下的档位', () => {
  assert.equal(pickBucketSeconds(METRIC_RANGES['1h']), 30, '1h/30s = 120 点 ⇒ 最细的 30s 就够');
  assert.equal(pickBucketSeconds(METRIC_RANGES['6h']), 300, '6h/60s = 360 点 > 240 ⇒ 升到 5m（72 点）');
  assert.equal(pickBucketSeconds(METRIC_RANGES['24h']), 900, '24h/300s = 288 点 > 240 ⇒ 15m（96 点）');
  assert.equal(pickBucketSeconds(METRIC_RANGES['7d']), 3600, '7d/900s = 672 点 ⇒ 1h（168 点）');
  assert.equal(pickBucketSeconds(METRIC_RANGES['30d']), 21600,
    '30d/3600s = 720 点 ⇒ 最粗的 6h（120 点）：绝不把 8.6 万个原始点发给浏览器');
  assert.equal(pickBucketSeconds(SERIES_TARGET_POINTS * 30), 30, '恰好 240 点 ⇒ 留下这一档（`≤` 不是 `<`）');
  assert.equal(pickBucketSeconds(SERIES_TARGET_POINTS * 30 + 1), 60, '多一个点就得升档');
  assert.equal(pickBucketSeconds(SERIES_TARGET_POINTS * 21600 + 1), 21600, '超出所有档位 ⇒ 停在最粗一档');
  assert.equal(pickBucketSeconds(0), BUCKET_SECONDS[0], '脏范围 ⇒ 最细档（range 校验层另兜）');
  assert.equal(pickBucketSeconds(-5), BUCKET_SECONDS[0]);
  assert.equal(pickBucketSeconds('abc'), BUCKET_SECONDS[0]);
});

test('#650 querySeries：服务端分桶 + 按 range 缓存 5s + 脏值不当 0', async () => {
  clearSeriesCache();
  const pool = new MetricsPool();
  const clock = makeClock();
  const first = await querySeries(pool, { range: '6h', now: clock.now });
  assert.equal(first.bucketSeconds, 300);
  assert.equal(first.range, '6h');
  assert.equal(first.cached, false);
  assert.equal(first.points.length, 1);
  assert.equal(first.points[0].t, '2026-11-17T03:00:00.000Z', '桶起点给 ISO 字符串（时区是渲染层的事）');
  assert.equal(first.points[0].cpuAvg, 12.34,
    'numeric 在 pg 驱动里是字符串 ⇒ 必须转成数（否则前端拼出 "12.34%" 之外的算术错）');
  assert.equal(first.points[0].cpuMax, 33.33);
  assert.equal(first.points[0].containersRunning, 3);
  const [since, bucket] = pool.queries[0].params;
  assert.equal(bucket, 300);
  assert.equal(since.getTime(), clock.at - METRIC_RANGES['6h'] * 1000,
    'since 由注入的 `now` 算（落库时间戳的权威仍是 DB 的 now()，这里只算窗口）');
  assert.ok(/\$1/.test(seriesSql()) && /\$2/.test(seriesSql()) && /GROUP BY 1/.test(seriesSql()));

  clock.pass(4000);
  const second = await querySeries(pool, { range: '6h', now: clock.now });
  assert.equal(second.cached, true, '5s 内同 range 命中缓存：10 个人同开这页 = 1 个人的 DB 查询量');
  assert.equal(pool.countOf('series'), 1, '第二次不许再查库');
  clock.pass(2000);   // 累计 6s > TTL
  assert.equal((await querySeries(pool, { range: '6h', now: clock.now })).cached, false);
  assert.equal(pool.countOf('series'), 2, '过了 TTL 必须重查');

  clearSeriesCache();
  const other = await querySeries(pool, { range: 'nonsense', now: clock.now });
  assert.equal(other.range, '1h', '非法 range 在查询层也回落 1h（与读面同一口径）');
  assert.equal(other.bucketSeconds, 30);

  clearSeriesCache();
  const empty = await querySeries(
    { async query() { return { rows: [{ bucket: null, cpu_avg: null, cpu_max: null, mem_used: null, containers_running: null, samples: null }] }; } },
    { range: '1h', now: clock.now },
  );
  assert.deepEqual(empty.points[0], {
    t: null, cpuAvg: null, cpuMax: null, memUsed: null, containersRunning: null, samples: null,
  }, '一格都没有 ⇒ 全 null，不是 0');
  clearSeriesCache();
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 4) 容器计数与对账
// ─────────────────────────────────────────────────────────────────────────────────────────

test('#650 countContainers：FDE **只认 station.managed 标签**，名字前缀不算（261118 真机误报）', () => {
  const c = countContainers(CONTAINER_LIST);
  assert.equal(c.total, 5, '`/containers/json?all=1` 的全部；不带 all=1 会少三台 ⇒ 「总数」是错数');
  assert.equal(c.running, 3);
  assert.equal(c.paused, 1);
  assert.equal(c.stopped, 1, '既非 running 也非 paused 都算 stopped（exited / created）');
  assert.equal(c.station, 3, '只有打了 station.managed 标签的算平台开户的');
  assert.equal(c.fde, 3);
  assert.equal(c.fdeRunning, 1, 'paused 与 exited 都不算 running');
  assert.deepEqual(c.fdeNames, ['fde-bob', 'fde-eric', 'fde-old'],
    '名字集合给对账用（对账要的是**谁**）；前导 `/` 由 nameOf 剥掉');
  // 真机反例：另一个项目的两个容器叫 `fde-otherproj-db` / `fde-otherproj-db-old-261107`，没有任何
  // station 标签，却被前缀规则算成 FDE ⇒ 面板显示「DB 6 台 ↔ Docker 8 台」并点名这两台。
  const collision = countContainers([
    { Names: ['/fde-otherproj-db'], State: 'running', Labels: {} },
    { Names: ['/fde-otherproj-db-old-261107'], State: 'exited', Labels: {} },
    { Names: ['/fde-eric'], State: 'running', Labels: { 'station.managed': 'true' } },
  ]);
  assert.equal(collision.fde, 1, '名字像 FDE 但没标签 ⇒ 不算（前缀是别人的命名空间，不是判据）');
  assert.deepEqual(collision.fdeNames, ['fde-eric']);

  assert.deepEqual(countContainers('not-an-array'), {
    total: 0, running: 0, paused: 0, stopped: 0, station: 0, fde: 0, fdeRunning: 0, fdeNames: [],
  }, '脏输入 ⇒ 空计数（调用方按 status/形状判过才走到这里）');
});

test('#650 containerDrift：DB ↔ Docker 的对称差要点名', () => {
  assert.deepEqual(containerDrift(['fde-eric', 'fde-ghost'], ['fde-eric', 'fde-new']), {
    db: 2, docker: 2, onlyDb: ['fde-ghost'], onlyDocker: ['fde-new'], count: 2,
  });
  assert.equal(containerDrift(['a'], ['a']).count, 0, '一致时对账行不点名');
  assert.equal(containerDrift(null, null).count, 0);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 5) 采样器三条防护
// ─────────────────────────────────────────────────────────────────────────────────────────

test('#650 采样器：启动那一拍不写库（使用率没得减），第二拍才落库', async () => {
  const ctx = makeSampler();
  const first = await ctx.sampler.tickOnce();
  assert.equal(first.written, false);
  assert.equal(first.skipped, 'priming',
    '「没有可减的上一拍」是预定中的事不是故障 ⇒ 走 debug：每次重启都 warn 一条就是噪声');
  assert.equal(ctx.logs.debug.length, 1);
  assert.equal(ctx.logs.warn.length, 0, '启动那一拍不许 warn');
  assert.equal(ctx.pool.countOf('insertMetrics'), 0);
  assert.ok(ctx.sampler.latest(), '内存里那一拍当场就有数（卡片不等第二拍）');
  assert.equal(ctx.sampler.latest().cpuUsagePct, null, '没得减 ⇒ null，页面渲染「未知」');

  ctx.clock.pass(30_000);
  const second = await ctx.sampler.tickOnce();
  assert.equal(second.written, true, '两点能减了就要落库');
  assert.equal(ctx.pool.countOf('insertMetrics'), 1);
  assert.equal(ctx.pool.countOf('insertDisks'), 1, '磁盘行走同一条事务的第二条语句');
  assert.equal(ctx.pool.commits, 1, '一个事务：主表 + 磁盘表一起提交');
  assert.equal(ctx.pool.releases, 1, '连接必须释放（否则一拍漏一个，几百拍就池耗尽）');
  const { sql, params } = ctx.pool.find('insertMetrics');
  assert.ok(/ON CONFLICT \(sampled_at\) DO NOTHING/.test(sql), '自然键幂等：同一采样时刻重放是空操作');
  assert.equal(params.length, 19, '19 个参数（顺序钉住，错位会静默写错列）');
  assert.ok(params[0] instanceof Date && params[18] instanceof Date);
  assert.notEqual(params[0], params[18], 'written_at 是应用侧另取的一份（DDL 不写 DEFAULT now()）');
  assert.equal(params[1], 25, 'cpu_usage_pct = 两拍差值（夹具自证：busy 250 / total 1000）');
  assert.equal(params[2], 2, 'cpu_cores');
  assert.equal(params[12], 5, 'containers_total');
  assert.equal(params[17], 1,
    'drift_count：DB 说 fde-eric/fde-bob ↔ Docker 说 fde-eric/fde-bob/fde-old ⇒ 差 1（点名 fde-old）');
});

test('#650 采样器：单飞 —— 上一拍没回来就跳过这一拍，不排队堆内存', async () => {
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = makeSampler({ statfs: makeStatfs({}, { slowFirstCall: gate }) });
  ctx.sampler.tickOnce();                        // 不 await：它正卡在 statfs 上
  const skipped = await ctx.sampler.tickOnce();  // 第二拍必须当场被拒
  assert.equal(skipped.written, false);
  assert.equal(skipped.skipped, 'inflight',
    '排队会让 DB 卡住时排出一串 Promise 堆在内存里，而每一拍都读到同一个「现在」——毫无意义');
  release();
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  ctx.clock.pass(30_000);
  const third = await ctx.sampler.tickOnce();
  assert.equal(third.skipped, undefined, '单飞不能变成「永久卡死」：inflight 必须随那一拍结束清掉');
  assert.equal(third.written, true);
});

test('#650 采样器：写失败只 warn —— 不抛、不重试风暴、下一照常跑', async () => {
  const pool = new MetricsPool({ dbNames: [], failWrite: true });
  const ctx = makeSampler({ pool });
  await ctx.sampler.tickOnce();
  ctx.clock.pass(30_000);
  const res = await ctx.sampler.tickOnce();
  assert.equal(res.written, false);
  assert.equal(res.skipped, 'error', '异常在 tickOnce 里被接住：绝不冒到 setInterval 的回调上');
  assert.equal(ctx.logs.warn.length, 1);
  assert.match(ctx.logs.warn[0], /这一拍失败/);
  assert.equal(pool.commits, 0, '没提交');
  assert.equal(pool.rollbacks, 1, '回滚了（事务不许半开）');
  assert.equal(pool.releases, 1, '失败路径也必须释放连接（finally）');
  ctx.clock.pass(30_000);
  const next = await ctx.sampler.tickOnce();
  assert.equal(next.skipped, 'error', '下一拍照试：一拍一次，没有排队积压，也不是退避重试风暴');
  assert.equal(ctx.logs.warn.length, 2, '写失败每拍说一次（它是新的一次失败，不是重复的跳过原因）');
});

test('#650 采样器：ENABLED=0 ⇒ 零定时器、零写入、零外部读取', async () => {
  const ctx = makeSampler({
    config: { systemMetrics: { enabled: false, intervalSeconds: 30, retentionDays: 30, diskPaths: ['/'] } },
    tickOnStart: true,   // 即使要求启动即拍，disabled 也不许动
  });
  assert.deepEqual(ctx.timers.set, [], 'ENABLED=0 时**根本不建定时器**（判据由此成立）');
  assert.equal(ctx.pool.queries.length, 0, '一条 SQL 都不发 ⇒ #506 的空闲基线不被污染');
  assert.deepEqual(ctx.readFile.calls, [], '连 /proc 都不读');
  assert.equal(ctx.sampler.enabled, false);
  assert.equal((await ctx.sampler.tickOnce()).skipped, 'disabled');
  assert.equal(ctx.sampler.latest(), null);
  ctx.sampler.stop();
  assert.deepEqual(ctx.timers.cleared, [], '没有定时器就没有可清的（stop() 不许炸）');
});

test('#650 采样器：定时器必须 unref（portal 是单进程 + SSE + LLM 代理，定时器不许拖住退出）', () => {
  const ctx = makeSampler();
  assert.equal(ctx.timers.set.length, 1, '默认建一个定时器');
  assert.equal(ctx.timers.set[0].ms, 30_000, '节拍来自 config.systemMetrics.intervalSeconds');
  assert.equal(ctx.timers.unrefed, 1, '必须调 timer.unref()');
  ctx.sampler.stop();
  assert.equal(ctx.timers.cleared.length, 1);
  assert.equal(ctx.timers.set[0].cleared, true);
  ctx.sampler.stop();
  assert.equal(ctx.timers.cleared.length, 1, 'stop() 重入不许多清');
});

test('#650 采样器：intervalSeconds 脏值 ⇒ 保底 1s（错拼的 env 不许把节拍变成 0）', () => {
  const ctx = makeSampler({
    config: { systemMetrics: { enabled: true, intervalSeconds: 0, retentionDays: 30, diskPaths: ['/'] } },
  });
  assert.equal(ctx.timers.set[0].ms, 1000);
});

test('#650 采样器：docker 不可达 ⇒ 容器格是「未知」而不是 0 台，且这一拍不落库', async () => {
  const err = new Error('connect ENOENT /var/run/docker.sock');
  err.code = 'ENOENT';
  const ctx = makeSampler({ docker: makeDocker({ throwOnCall: err }) });
  await ctx.sampler.tickOnce();
  assert.equal(ctx.sampler.latest().containers, null, '**不是** {total:0}（docker 挂了 ≠ 0 台容器）');
  assert.equal(ctx.logs.warn.filter((m) => /容器数读取失败/.test(m)).length, 1, '第一拍就点名原因');
  ctx.clock.pass(30_000);
  const res = await ctx.sampler.tickOnce();
  assert.equal(res.written, false,
    '那一行全是 NOT NULL ⇒ 读不全就不写，历史上留一个洞比写 0 诚实');
  assert.equal(res.skipped, 'incomplete');
  assert.ok(res.missing.includes('containers'));
  assert.equal(ctx.pool.countOf('insertMetrics'), 0);
});

test('#650 采样器：docker 回 500 同样降级；list 缓存按 3s TTL 复用', async () => {
  const bad = makeDocker({ status: 500, list: null });
  const ctx = makeSampler({ docker: bad });
  await ctx.sampler.tickOnce();
  assert.equal(ctx.sampler.latest().containers, null, 'status ≠ 200 ⇒ 抛给调用方降级，这里不猜数');
  assert.equal(bad.calls, 1);

  const ok = makeDocker();
  const ctx2 = makeSampler({ docker: ok });
  await ctx2.sampler.tickOnce();
  ctx2.clock.pass(DOCKER_LIST_TTL_MS - 1000);
  await ctx2.sampler.tickOnce();
  assert.equal(ok.calls, 1, 'TTL 内复用缓存（同一拍里只需要一次 docker 往返，实测 22ms/217 容器）');
  ctx2.clock.pass(2000);
  await ctx2.sampler.tickOnce();
  assert.equal(ok.calls, 2, '过了 TTL 要重取');
});

test('#650 采样器：/proc 某个文件读不到 ⇒ 该项未知 + 点名是哪个文件，其它格照常', async () => {
  const readFile = makeReadFile();
  delete readFile.files.loadavg;
  const ctx = makeSampler({ readFile });
  await ctx.sampler.tickOnce();
  assert.equal(ctx.logs.warn.filter((m) => /loadavg/.test(m)).length, 1, '点名是哪个文件读不到');
  assert.equal(ctx.sampler.latest().memTotalBytes, 131809112 * 1024, '内存那格不受影响');
  ctx.clock.pass(30_000);
  const res = await ctx.sampler.tickOnce();
  assert.equal(res.skipped, 'incomplete');
  assert.ok(res.missing.includes('load1'), 'load 三格未知 ⇒ 不写这一拍（NOT NULL，写 NULL 是当场 23502）');
});

test('#650 采样器：statfs 读不到的路径出现在 latest.diskUnreadable（页面得露面）', async () => {
  const ctx = makeSampler({
    config: {
      systemMetrics: {
        enabled: true, intervalSeconds: 30, retentionDays: 30, diskPaths: ['/', '/srv/erix/users'],
      },
    },
  });
  await ctx.sampler.tickOnce();
  const latest = ctx.sampler.latest();
  assert.equal(latest.disks.length, 1, '只有一条路径 statfs 成功 ⇒ 一行');
  assert.deepEqual(latest.diskUnreadable, [{ path: '/srv/erix/users', reason: 'ENOENT' }]);
});

test('#650 采样器：读 /proc 用注入的 procRoot（单测不碰真实 /proc）', async () => {
  const ctx = makeSampler({ procRoot: '/fixture/proc' });
  await ctx.sampler.tickOnce();
  assert.deepEqual([...new Set(ctx.readFile.calls)].sort(), [
    '/fixture/proc/loadavg', '/fixture/proc/meminfo', '/fixture/proc/mounts',
    '/fixture/proc/stat', '/fixture/proc/uptime',
  ]);
});

test('#650 采样器：diskPaths 缺省 ⇒ 只看 `/`（env 没配也要有东西可看）', async () => {
  const ctx = makeSampler({
    config: { systemMetrics: { enabled: true, intervalSeconds: 30, retentionDays: 30 } },
    statfs: makeStatfs({ '/srv/erix/users': { blocks: 100, bfree: 10, bavail: 5 } }),
  });
  await ctx.sampler.tickOnce();
  assert.deepEqual(ctx.sampler.latest().disks.map((d) => d.path), ['/']);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 6) 保留期清理
// ─────────────────────────────────────────────────────────────────────────────────────────

test('#650 写库 SQL 形状：列数 = 表达式数、占位符连续无空洞（假 pool 抓不到，只有真库会 42601）', () => {
  // 这条判据的由来：`disksInsertSql` 曾把每行参数写成 5 个（实际 6 个）⇒ 七列六个值 ⇒
  // **每一拍写库都 42601 `INSERT has more target columns than expressions`**。37 条假 pool 单测全绿，
  // 因为假 pool 只记 SQL 文本、不解析它；只有真 postgres 会拒。⇒ 这里直接钉语句的**形状**。
  const cols = /INSERT INTO system_metrics \(([\s\S]*?)\)\s*VALUES/.exec(WRITE_METRICS_SQL)[1]
    .split(',').map((s) => s.trim()).filter(Boolean);
  const vals = /\bVALUES\s*\(([\s\S]*?)\)\s*ON CONFLICT/.exec(WRITE_METRICS_SQL)[1]
    .split(',').map((s) => s.trim()).filter(Boolean);
  assert.equal(cols.length, vals.length, `WRITE_METRICS_SQL：${cols.length} 列就要 ${vals.length} 个值`);
  assert.deepEqual(vals.map((v) => Number(v.slice(1))),
    Array.from({ length: cols.length }, (_, i) => i + 1), 'WRITE_METRICS_SQL 的 $1..$N 必须连续');

  for (const count of [1, 2, 5]) {
    const sql = disksInsertSql(count);
    const dcols = /INSERT INTO system_metrics_disks \(([\s\S]*?)\)\s*VALUES/.exec(sql)[1]
      .split(',').map((s) => s.trim()).filter(Boolean);
    const tuples = [...sql.split(/\bVALUES\b/)[1].split(/\bON CONFLICT\b/)[0].matchAll(/\(([^)]*)\)/g)]
      .map((m) => m[1].split(',').map((s) => s.trim()));
    assert.equal(tuples.length, count, `count=${count} 就该有 ${count} 行`);
    for (const t of tuples) {
      assert.equal(t.length, dcols.length, `每行 ${dcols.length} 列就要 ${dcols.length} 个表达式（旧 bug 就死在这一句）`);
    }
    // `$1`（sampled_at）在每行**复用**（所以 flat 里 1 会重复出现 count 次），每行自己的 6 个参数不重复
    // ⇒ 判据是「去重后的集合恰好是 1..1+count*6」，不是「flat 等于 1..N」。
    const flat = tuples.flat().map((p) => Number(p.slice(1)));
    const uniq = [...new Set(flat)].sort((a, b) => a - b);
    assert.deepEqual(uniq, Array.from({ length: 1 + count * 6 }, (_, i) => i + 1),
      `count=${count}：占位符集合必须恰好是 1..${1 + count * 6}（既不能跳号也不能多出来）`);
    assert.equal(flat.filter((n) => n === 1).length, count, '$1 每行复用一次（sampled_at 每行相同）');
  }
});

test('#650 purgeSystemMetrics：日期参数走绑定变量（配置写错不许变成 SQL 语法错）', async () => {
  const pool = new MetricsPool();
  const n = await purgeSystemMetrics(pool, { retentionDays: 30 });
  assert.equal(n, 3, 'rowCount 原样返回（reaper 用它打日志）');
  const { sql, params } = pool.queries[0];
  assert.deepEqual(params, [30], '**绑定变量**，不是把 30 插进 `interval \'30 days\'` 文本');
  assert.ok(/make_interval\(days => \$1::integer\)/.test(sql), '参数化之后语句形状固定');
  assert.ok(/DELETE FROM system_metrics\b/.test(sql));
  assert.ok(!/system_metrics_disks/.test(retentionPurgeSql()),
    '磁盘行不写 DELETE：靠 FK 的 ON DELETE CASCADE 跟着走（一小时一个事务，不是两个）');
  assert.ok(/MAX\(sampled_at\)/.test(sql),
    '保住最新一拍：采样器停了很久再启动时，全删会让历史彻底空白');

  const quiet = new MetricsPool();
  for (const bad of [0, -1, 1.5, NaN, undefined, null, 'abc']) {
    assert.equal(await purgeSystemMetrics(quiet, { retentionDays: bad }), 0, `${bad} ⇒ 不跑`);
  }
  assert.equal(quiet.queries.length, 0, '非法保留期一条语句都不发');
});

test('#650 保留期清理挂在 reaper 已有的小时级槽（不单开循环，失败只 warn）', async () => {
  const fakes = makeReaperSleep();
  const pool = new MetricsPool({ dbNames: [] });
  let t = 1_700_000_000_000;
  const loop = startReaperLoop(pool, {
    log: SILENT_LOG, sleep: fakes.sleep, now: () => t, systemMetricsRetentionDays: 30,
  });
  await fakes.tick();
  assert.equal(pool.countOf('purge'), 1, '启动那一拍就该挂上（与幂等键清理同一个槽）');
  t += 30 * 60 * 1000;
  await fakes.tick();
  assert.equal(pool.countOf('purge'), 1, '没跨 1h 闸门不许再清（否则「一小时一个事务」等于没生效）');
  t += 60 * 60 * 1000;
  await fakes.tick();
  assert.equal(pool.countOf('purge'), 2, '跨闸门必清');
  assert.deepEqual(pool.find('purge').params, [30], '保留期天数是从 config 递下来的，不是写死 30');
  loop.stop();
  await loop.settled;

  // 清理失败只 warn：reaper 的主职（租约回收）不许被观测面拖住
  const fakes2 = makeReaperSleep();
  const broken = {
    async query(sql) {
      if (/DELETE FROM system_metrics/.test(String(sql))) throw new Error('deadlock detected');
      return { rows: [] };
    },
  };
  const warns = [];
  const loop2 = startReaperLoop(broken, {
    log: { warn: (m) => warns.push(String(m)), log() {} },
    sleep: fakes2.sleep,
    now: () => 1_700_000_000_000,
    systemMetricsRetentionDays: 30,
  });
  await fakes2.tick();
  loop2.stop();
  await loop2.settled;
  assert.ok(warns.some((w) => /system_metrics purge error/.test(w) && /deadlock/.test(w)),
    '点名原因，但循环照常在下一拍继续');
  assert.equal(loop2.failure(), null, '清理失败不许把 reaper 变成已拒绝的循环');

  // 不传旋钮 ⇒ 一条 system_metrics 语句都不发（旧调用点与 #520 单测的行为逐字不变）
  const fakes3 = makeReaperSleep();
  const quiet = new MetricsPool();
  const loop3 = startReaperLoop(quiet, { log: SILENT_LOG, sleep: fakes3.sleep, now: () => 1 });
  await fakes3.tick();
  loop3.stop();
  await loop3.settled;
  assert.equal(quiet.countOf('purge'), 0);
});

/**
 * reaper 的假 sleep（拄 `idle-backoff-520.test.js` 同一套打法，不吃墙钟）。
 * ⚠ **必须听 abort**：`stop()` 是在循环停在 sleep 上时发的，不听信号的假 sleep 会把
 *   `await loop.settled` 永挂（实测：测试被 parent 取消 + 一堆cancelledByParent）。
 */
function makeReaperSleep() {
  const fake = { sleeps: [] };
  let pending = null;
  fake.sleep = (ms, signal) => new Promise((resolve) => {
    fake.sleeps.push(ms);
    const entry = { ms, done: false };
    entry.finish = (ok) => {
      if (entry.done) return;
      entry.done = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (pending === entry) pending = null;
      resolve(ok);
    };
    const onAbort = () => entry.finish(false);
    if (signal?.aborted) { entry.finish(false); return; }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    pending = entry;
  });
  /** 等到循环停在 sleep 上，然后放行这一拍（=「假时钟走完了」）。 */
  fake.tick = async () => {
    for (let i = 0; i < 50 && !pending; i += 1) await new Promise((r) => setImmediate(r));
    assert.ok(pending, '循环必须停在某一拍的 sleep 上（没停住 = 循环抛错或已经退了）');
    pending.finish(true);
    for (let i = 0; i < 50; i += 1) await new Promise((r) => setImmediate(r));
  };
  fake.parked = () => pending !== null;
  return fake;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// 7) latest 的形状（缺值 ⇒ null，绝不 0）
// ─────────────────────────────────────────────────────────────────────────────────────────

test('#650 toApiLatest：null 进 null 出；缺格是 null 不是 0；disk 带 usedPct 与设备名', () => {
  assert.equal(toApiLatest(null), null);
  const api = toApiLatest({
    sampledAt: new Date('2026-11-17T03:00:00Z'),
    cpuUsagePct: null, cpuCores: 36, load1: 5.26, load5: null, load15: 2.4,
    memTotalBytes: 1000, memUsedBytes: 400, memAvailableBytes: 600,
    memCachedBytes: 100, swapUsedBytes: null, uptimeSeconds: 10,
    containers: null, drift: null,
    disks: [{
      device: '/dev/nvme0n1p2', path: '/', fs: 'ext4', totalBytes: 1000, usedBytes: 250, availBytes: 500,
    }],
    diskUnreadable: [{ path: '/x', reason: 'ENOENT' }],
  });
  assert.equal(api.sampled_at, '2026-11-17T03:00:00.000Z');
  assert.deepEqual(api.cpu, { usagePct: null, cores: 36, load: [5.26, null, 2.4] },
    'load 缺失那一格是 null（前端渲染「未知」），不是 0');
  assert.equal(api.mem.usedPct, 40);
  assert.equal(api.mem.swapUsedBytes, null);
  assert.equal(api.disk.length, 1);
  assert.equal(api.disk[0].usedPct, 25);
  assert.equal(api.disk[0].device, '/dev/nvme0n1p2',
    '设备名要露面：面板给「设备 + 挂载点 + 类型 + 用量」四格，不是一个孤零零的百分比');
  assert.deepEqual(api.diskUnreadable, [{ path: '/x', reason: 'ENOENT' }]);
  assert.equal(api.containers, null, 'docker 不可达 = 读不到，不是 0 台');
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 8) 读面（纯函数层）
// ─────────────────────────────────────────────────────────────────────────────────────────

test('#650 metricsApiPayload：非法 range 回落 1h（不报 400），range 回的是**生效值**', async () => {
  const clock = makeClock();
  for (const bad of ['bogus', '', 'P1Y', undefined]) {
    clearSeriesCache();
    const payload = await metricsApiPayload({ pool: new MetricsPool(), range: bad, now: clock.now });
    assert.equal(payload.range, '1h', `${JSON.stringify(bad)} ⇒ 回落 1h`);
    assert.equal(payload.series.bucketSeconds, 30);
    assert.equal(payload.seriesError, null);
    assert.equal(payload.latest, null, '没有采样器 ⇒ latest 是 null，不是 500');
  }
  clearSeriesCache();
});

test('#650 metricsApiPayload：DB 挂了 ⇒ seriesError 给原因，latest 照常（这是端点存在的理由）', async () => {
  clearSeriesCache();
  const clock = makeClock();
  const sample = makeSample();
  const sampler = { latest: () => sample };
  const brokenPool = {
    async query() { const e = new Error('connection terminated unexpectedly'); e.code = '57P01'; throw e; },
  };
  const payload = await metricsApiPayload({
    pool: brokenPool, sampler, retentionDays: 45, range: '24h', now: clock.now,
  });
  assert.equal(payload.seriesError, '57P01', '给原因字符串（code 优先），不把堆栈与 SQL 塞进响应');
  assert.equal(payload.range, '24h');
  assert.equal(payload.retentionDays, 45);
  assert.deepEqual(payload.series, { bucketSeconds: pickBucketSeconds(86400), points: [] },
    '空 points ⇒ 页面画「该区间无数据」，不画一条贴底的假线');
  assert.equal(payload.latest.cpu.usagePct, 14.6, '**latest 必须还在**：卡片读的是进程内那一拍');
  clearSeriesCache();

  const noCode = await metricsApiPayload({
    pool: { async query() { throw new Error('boom'); } }, sampler, now: clock.now,
  });
  assert.equal(noCode.seriesError, 'boom', '没有 code 就给 message');
  assert.equal(noCode.retentionDays, null, '没配 ⇒ null（不是 0、不是猜 30）');
  clearSeriesCache();
});

// `enabled`（前端「采样已关闭」文案的唯一依据，issue #650 前端单）。
// 为什么不能只靠 `latest === null`：那个形状同时包含「采样已关闭」与「刚重启还没第一拍」
// 两个完全不同结论（前者要去改 env 重启，后者只要等 30s），前端自己分不出来。
test('#650 metricsApiPayload：采样器在跑且启用 ⇒ enabled:true（additive，不改其余字段）', async () => {
  clearSeriesCache();
  const clock = makeClock();
  const payload = await metricsApiPayload({
    pool: new MetricsPool(), sampler: { latest: () => makeSample(), enabled: true }, now: clock.now,
  });
  assert.equal(payload.enabled, true, '采样器句柄自己的 enabled 直接搬过去（前端不许反推）');
  assert.notEqual(payload.latest, null, '其余字段形状不变');
  assert.equal(payload.seriesError, null);
  clearSeriesCache();
});

test('#650 metricsApiPayload：没有采样器 / 采样器被关 ⇒ enabled:false（不是 null、不是缺键）', async () => {
  clearSeriesCache();
  const clock = makeClock();
  // `ENABLED=0` 时 `cli.js serve` 根本不建采样器 ⇒ `http.js` 递进来的是 `null`。
  const noSampler = await metricsApiPayload({ pool: new MetricsPool(), now: clock.now });
  assert.equal(noSampler.enabled, false, '没有采样器 ⇒ false，页面才能说「采样已关闭」');
  assert.equal(noSampler.latest, null, '两个读数各自独立：这一格是 false 不改变 latest 的 null');
  // 句柄存在但 `enabled:false`（建了没跑）与脏值（`'true'` / 缺键）⇒ 只认真布尔，其余都是 false。
  for (const enabled of [false, 'true', 1, null, undefined]) {
    const payload = await metricsApiPayload({
      pool: new MetricsPool(), sampler: { latest: () => null, enabled }, now: clock.now,
    });
    assert.equal(payload.enabled, false, `enabled=${JSON.stringify(enabled)} ⇒ false（只认真布尔）`);
  }
  clearSeriesCache();
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 9) 读面（HTTP 层）：admin 200 / 非 admin 403 / 降级不报错
// ─────────────────────────────────────────────────────────────────────────────────────────

const ADMIN_ID = '00000000-0000-4000-8000-0000000000b1';
const FDE_ID = '00000000-0000-4000-8000-0000000000b2';
const ADMIN_TOKEN = 'sysmetrics-admin-session';
const FDE_TOKEN = 'sysmetrics-fde-session';

class MetricsHttpPool extends FakePool {
  constructor({ seriesFails = false } = {}) {
    super({
      users: [
        { id: ADMIN_ID, login: 'admin', role: 'admin', status: 'active', auth_source: 'local' },
        { id: FDE_ID, login: 'alice', role: 'fde', fde_name: 'alice', status: 'active', auth_source: 'local' },
      ],
    });
    this.seriesFails = seriesFails;
    this.seriesQueries = [];
  }

  async query(sql, params = []) {
    if (/FROM system_metrics\b/.test(String(sql))) {
      this.seriesQueries.push({ sql: String(sql), params });
      if (this.seriesFails) throw new Error('connection to server failed');
      return { rows: [] };
    }
    return super.query(sql, params);
  }
}

function makeSample() {
  const containers = countContainers(CONTAINER_LIST);
  return {
    sampledAt: new Date('2026-11-17T03:00:00Z'),
    cpuUsagePct: 14.6, cpuCores: 36, load1: 5.26, load5: 3.1, load15: 2.4,
    memTotalBytes: 131809112 * 1024, memUsedBytes: 31809112 * 1024,
    memAvailableBytes: 100000000 * 1024, memCachedBytes: 31000000 * 1024, swapUsedBytes: 0,
    uptimeSeconds: 123456,
    containers,
    drift: containerDrift(['fde-eric', 'fde-bob'], containers.fdeNames),
    disks: [{
      device: '/dev/nvme0n1p2', path: '/', fs: 'ext4', totalBytes: 937, usedBytes: 676, availBytes: 214,
    }],
    diskUnreadable: [],
  };
}

async function startServer({ pool, sampler, retentionDays = 30 } = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-650-static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'INDEX');
  const config = {
    cookie: cookieSettings('sysmetrics-api-test', 600),
    sessionTtlSeconds: 600, sessionRenewIntervalSeconds: 3600, pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 20, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: { maxFailures: 20, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 20, maxEntries: 100 },
    kdfConcurrency: 1, kdfQueueLimit: 10, kdfQueueTimeoutMs: 1000,
    maxLoginLength: 128, maxPasswordLength: 256, staticDir,
    systemMetrics: { enabled: true, intervalSeconds: 30, retentionDays, diskPaths: ['/'] },
    metricsSampler: sampler,
  };
  for (const [id, token] of [[ADMIN_ID, ADMIN_TOKEN], [FDE_ID, FDE_TOKEN]]) {
    pool.sessions.push({
      id: `session-${id}`, user_id: id, token_hash: hashToken(token),
      created_at: new Date(), expires_at: new Date(Date.now() + 600_000),
      last_seen_at: new Date(), revoked_at: null,
    });
  }
  const server = createServer({ pool, config, log: { error() {}, warn() {}, log() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    adminCookie: `${config.cookie.name}=${ADMIN_TOKEN}`,
    fdeCookie: `${config.cookie.name}=${FDE_TOKEN}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(staticDir, { recursive: true, force: true });
    },
  };
}

async function getMetrics(srv, { cookie = '', query = '', method = 'GET' } = {}) {
  const res = await fetch(`${srv.base}/api/admin/system/metrics${query}`, {
    method,
    headers: cookie ? { cookie } : {},
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}

test('#650 GET /api/admin/system/metrics：admin 200，latest 与 series 同时给', async () => {
  clearSeriesCache();
  const pool = new MetricsHttpPool();
  const srv = await startServer({ pool, sampler: { latest: () => makeSample() } });
  try {
    const { status, body } = await getMetrics(srv, { cookie: srv.adminCookie, query: '?range=6h' });
    assert.equal(status, 200);
    assert.equal(body.range, '6h');
    assert.equal(body.retentionDays, 30);
    assert.equal(body.seriesError, null);
    assert.equal(body.latest.sampled_at, '2026-11-17T03:00:00.000Z');
    assert.deepEqual(body.latest.cpu, { usagePct: 14.6, cores: 36, load: [5.26, 3.1, 2.4] });
    assert.equal(body.latest.mem.totalBytes, 131809112 * 1024);
    assert.equal(body.latest.mem.usedPct, 24.1, 'used% 由服务端算一次（前端再算一遍就是第四份真相）');
    assert.deepEqual(body.latest.disk, [{
      device: '/dev/nvme0n1p2', path: '/', fs: 'ext4',
      totalBytes: 937, usedBytes: 676, availBytes: 214, usedPct: 72.1,
    }]);
    assert.equal(body.latest.containers.total, 5);
    assert.equal(body.latest.containers.fde, 3);
    assert.equal(body.latest.containers.drift.count, 1, '对账行：DB 2 台 ↔ Docker 3 台');
    assert.deepEqual(body.latest.containers.drift.onlyDocker, ['fde-old']);
    assert.equal(body.series.bucketSeconds, 300, '6h ⇒ 5m 桶（目标 ≤240 点，服务端选档）');
    assert.deepEqual(body.series.points, [], '空库 ⇒ 空数组（前端画「该区间无数据」）');
    assert.equal(pool.seriesQueries.length, 1, '一次请求只查一次库');
    assert.deepEqual(pool.seriesQueries[0].params[1], 300);
    assert.ok(pool.seriesQueries[0].params[0] instanceof Date);
  } finally {
    await srv.close();
    clearSeriesCache();
  }
});

test('#650 GET /api/admin/system/metrics：非 admin 403（既有 requireAdmin 闸，零新错误码）', async () => {
  clearSeriesCache();
  const pool = new MetricsHttpPool();
  const srv = await startServer({ pool, sampler: { latest: () => makeSample() } });
  try {
    const asFde = await getMetrics(srv, { cookie: srv.fdeCookie });
    assert.equal(asFde.status, 403);
    assert.equal(asFde.body.error.code, 'forbidden');
    assert.equal(pool.seriesQueries.length, 0, '**鉴权在查询之前**：非 admin 一条 SQL 都不发');
    assert.equal((await getMetrics(srv)).status, 401, '无会话 401（与其余 admin 端点同口径）');
  } finally {
    await srv.close();
    clearSeriesCache();
  }
});

test('#650 GET /api/admin/system/metrics：DB 挂了 latest 仍 200；采样器没跑时 latest 是 null', async () => {
  clearSeriesCache();
  const pool = new MetricsHttpPool({ seriesFails: true });
  const srv = await startServer({ pool, sampler: { latest: () => makeSample() } });
  try {
    const { status, body } = await getMetrics(srv, { cookie: srv.adminCookie });
    assert.equal(status, 200, 'DB 不可用不许把观测面变成 500（卡片读的是进程内那一拍）');
    assert.equal(body.seriesError, 'connection to server failed');
    assert.deepEqual(body.series.points, []);
    assert.equal(body.latest.cpu.usagePct, 14.6, 'latest 一格都没少');
    assert.equal(body.range, '1h', '没带 range ⇒ 1h');
  } finally {
    await srv.close();
    clearSeriesCache();
  }

  // 采样器在、但还没有第一拍（刚启动 / ENABLED=0 时句柄仍在）
  const srv2 = await startServer({ pool: new MetricsHttpPool(), sampler: { latest: () => null } });
  try {
    const { status, body } = await getMetrics(srv2, { cookie: srv2.adminCookie });
    assert.equal(status, 200);
    assert.equal(body.latest, null, '采样器没跑 / 没有第一拍 ⇒ null，不是 500、也不是全 0 的假样本');
    assert.equal(body.seriesError, null);
    assert.equal(body.series.bucketSeconds, 30);
  } finally {
    await srv2.close();
    clearSeriesCache();
  }

  // 连采样器都没有（非 serve 入口 / 单测形态）
  const srv3 = await startServer({
    pool: new MetricsHttpPool(), sampler: undefined, retentionDays: null,
  });
  try {
    const { status, body } = await getMetrics(srv3, { cookie: srv3.adminCookie, query: '?range=bogus' });
    assert.equal(status, 200);
    assert.equal(body.latest, null);
    assert.equal(body.range, '1h', '非法 range 回落 1h，**不报 400**');
    assert.equal(body.retentionDays, null);
  } finally {
    await srv3.close();
    clearSeriesCache();
  }
});

test('#650 端点只读：非 GET 不许命中它；baseline schema.sql 没被回写', async () => {
  clearSeriesCache();
  const pool = new MetricsHttpPool();
  const srv = await startServer({ pool, sampler: { latest: () => makeSample() } });
  try {
    const res = await getMetrics(srv, { cookie: srv.adminCookie, method: 'POST' });
    assert.ok(res.status === 404 || res.status === 405, `非 GET 不该命中这个端点（拿到 ${res.status}）`);
    assert.equal(pool.seriesQueries.length, 0);
  } finally {
    await srv.close();
    clearSeriesCache();
  }
  const schema = fs.readFileSync(new URL('../../docs/data/schema.sql', import.meta.url), 'utf8');
  assert.ok(!/system_metrics/.test(schema), 'baseline schema.sql 冻结：0044 的东西不许回写进 baseline');
});
