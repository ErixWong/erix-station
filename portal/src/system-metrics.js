// issue #650：宿主资源指标的**唯一读写面**（采样器 + `/proc` 解析 + 分桶查询）。
//
// 要治的真事故：管理台今天没有任何宿主资源读面，CPU / 内存 / 磁盘 / 容器数只能靠人 SSH 上机
// `htop` + `docker ps`。症状是「FDE 变慢」而平台不知道宿主是不是快满了 —— 与 #586 那次版本分裂
// 同一个形状（真相存在，界面上一个读面都没有）。本文件交付的是「有机器可读的读面」这件事的本体。
//
// 三条决定决定了本文件的形状（全文见 issue #650 与 `docs/ops/system-metrics.md`）：
//   1. **DB 是历史真相**（不变式 3）：每 N 秒落一行，图表只读 DB；进程内只留「最新一拍」给卡片，
//      所以卡片在 DB 挂掉时照样有实时值，而历史图会显式说「该区间无数据」。
//   2. **零新挂载、零安全面改动**：宿主指标读容器内 `/proc` + `fs.statfs`（261117 实测这些在
//      `station-portal` 容器里就是宿主值），容器数走**已在 Docker 白名单**的 `/containers/json`
//      （`portal/src/provisioner.js:98` 与 `deploy/fde-proxy/server.js:30` 两条名单一字未动）。
//      ⚠ 用的是 `docker.call('GET', '/containers/json?all=1')` 而不是 `docker.listContainers()`：
//      后者不带 `all=1`，docker 默认**只回运行中的容器** ⇒ 「总数」会是个偏小的错数。
//   3. **只存原始点，查询时分桶**：不搞「原始 + 小时汇总」双层表（两套写路径 + 一个降采样 job，
//      换不来东西）。目标点数 240 **写死成常量**（刻意不设 env：设了没人调，设错是新的故障面）。
//
// 三条防护（缺一条就是埋雷，逐条有单测）：**单飞**（上一次写没回来就跳过本拍，不排队堆内存）、
// **写失败只 warn 不抛**（历史图上有个洞，比 portal 崩了强）、**定时器 `unref()`**（portal 是单进程
// + SSE + LLM 代理，定时器不许拖住退出）。`SYSTEM_METRICS_ENABLED=0` 时**根本不建定时器**。
import fs from 'node:fs';

import { createDockerClient } from './provisioner.js';

// ── 写死的常量（issue #650「刻意不设 env」那一节）─────────────────────────────────────────
/** 分桶目标点数上限：超过它就把桶宽升到下一档。 */
export const SERIES_TARGET_POINTS = 240;
/** 桶宽档位（秒）。选档规则见 `pickBucketSeconds()`。 */
export const BUCKET_SECONDS = Object.freeze([30, 60, 300, 900, 3600, 21600]);
/** 查询范围 → 秒数。缺省 `1h`（前端的默认范围也是它）。 */
export const METRIC_RANGES = Object.freeze({
  '1h': 3600,
  '6h': 21600,
  '24h': 86400,
  '7d': 604800,
  '30d': 2592000,
});
export const DEFAULT_METRIC_RANGE = '1h';
/** 分桶结果的内存缓存 TTL（按 `range` 一份）。 */
export const SERIES_CACHE_TTL_MS = 5000;
/** `listContainers` 的内存缓存 TTL（同一拍里磁盘/CPU 之外只需要一次 docker 往返）。 */
export const DOCKER_LIST_TTL_MS = 3000;
/** 容器内读宿主指标的 `/proc` 根（可注入，单测拿它喂 fixture）。 */
export const DEFAULT_PROC_ROOT = '/proc';

/** 保留期清理的 SQL（`now() - make_interval(days => $1)`）。 */
export function retentionPurgeSql() {
  return `DELETE FROM system_metrics
           WHERE sampled_at < now() - make_interval(days => $1::integer)
             AND sampled_at < (SELECT MAX(sampled_at) FROM system_metrics)`;
}

/**
 * 按保留期物理删除旧采样行（磁盘行靠 `system_metrics_disks` 的 `ON DELETE CASCADE` 跟着走）。
 *
 * 为什么写成 `make_interval(days => $1::integer)` 而不是 issue 原文的 `interval '<N> days'` 字符串插值：
 * 值是配置项，插进 SQL 文本等于把「配置写错」变成「SQL 语法错」（而它的报错形态和「DB 挂了」分不开）。
 * 参数化之后形状固定，`retentionDays` 只可能是整数或这一句根本不跑。
 *
 * 尾句 `AND sampled_at < (SELECT MAX(sampled_at) ...)`：保住**最新一拍**——采样器停了很久再启动时，
 * 「now() - 30d」可能已经晚于库里唯一那批旧行，全删会让面板的历史彻底空白（读侧无从显示「更早的趋势」）。
 * 这是**小代价的保守**：多一个 MAX 扫描（主键上的 index scan，毫秒级），换来「历史至少留最后一行」。
 * @param {{query: (sql: string, params?: unknown[]) => Promise<{rows?: unknown[]}>}} pool
 * @param {{retentionDays: number}} opts
 * @returns {Promise<number>} 删除行数
 */
export async function purgeSystemMetrics(pool, { retentionDays }) {
  const days = Number(retentionDays);
  if (!Number.isSafeInteger(days) || days < 1) return 0;
  const res = await pool.query(retentionPurgeSql(), [days]);
  return Number(res?.rowCount ?? 0);
}

// ── 纯解析函数（全部可注入文本，单测不碰真实 `/proc`）────────────────────────────────────

/**
 * 只认有限数字；其余（缺字段 / `NaN` / 脏值）⇒ `null`，**绝不当成 0**（#586 口径）。
 *
 * ⚠ 本轮修掉的**第二个缺陷**（旧实现把「没给」当 0）：`Number(String(undefined ?? '').trim())`
 *   = `Number('')` = **0**，而 `Number(null)` 也是 0 ⇒ 缺字段、空行、`null` 全都静默变成「真的 0」。
 *   后果逐条：`/proc/loadavg` 整个读不到 ⇒ load 三格变 0.00（面板说「负载很轻」）；
 *   `statfs` 少一个 `bavail` ⇒ 算出「用了 100%」；pg 回 `NULL` 的分桶行 ⇒ 图上出现一排 0 点。
 *   全部方向都是「把不知道说成很忙/很忙」，而这一个监控页面存在的理由就是分辨宿主忙不忙。
 *   现在：空串 / 纯空白 / `null` / `undefined` / 非有限数 ⇒ `null`；`'0'` 与 `0` 仍是真 0。
 */
function numOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits) {
  if (value === null || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * `/proc/stat` 的 `cpu` 汇总行（**不**含每核 `cpuN`，那些只用来数核数）。
 *
 * 返回 `{ cores, total, idle, fields }`；`total` 是**除 guest 两列之外**的字段和（内核把 guest 时间
 * 已经计进 `user`，再加一次就是双计），`idle` = `idle + iowait`。
 * 缺字段（老内核没有 `steal`/`iowait`）⇒ 按 0 参与求和，`fields` 里保留 `null` 以便上层说得出「没给」。
 * 没有 `cpu` 行（读到的不是 `/proc/stat`）⇒ `null`。
 *
 * ⚠ `cores` 数的是 `cpuN` 行的条数，**不是** `os.cpus().length`：后者在容器里同样是宿主值，
 * 但两者来源不同（一个来自 `/proc/stat`，一个来自 `sysconf`/亲和性），同一次采样里必须只有一个真相。
 */
export function parseProcStat(text) {
  const lines = String(text ?? '').split('\n');
  let aggregate = null;
  let cores = 0;
  for (const line of lines) {
    if (!line.startsWith('cpu')) continue;
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'cpu') aggregate = parts.slice(1);
    else if (/^cpu\d+$/.test(parts[0])) cores += 1;
  }
  if (aggregate === null) return null;
  const names = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal', 'guest', 'guest_nice'];
  const fields = {};
  names.forEach((name, i) => {
    fields[name] = numOrNull(aggregate[i]);
  });
  // guest / guest_nice（下标 8/9）已被内核计进 user / nice ⇒ 求和时排除，别双计。
  let total = 0;
  for (const name of names.slice(0, 8)) total += fields[name] ?? 0;
  const idle = (fields.idle ?? 0) + (fields.iowait ?? 0);
  return { cores, total, idle, fields };
}

/**
 * 两次采样的 CPU 使用率（百分比，两位小数）。
 *
 * 必须是**差值**：`/proc/stat` 的 `cpu` 行是自启动以来的累计值，单点的「35%」没有意义。
 * 返回 `null` 的三种情形（都是「不知道」，不是 0）：任一侧缺值、计数器**回绕/被重置**
 * （`cur.total < prev.total`，实测发生在宿主机重启或 `/proc` 换命名空间时）、两次采样的时间差里
 * 一个 jiffy 都没走（`cur.total === prev.total`）。
 */
export function cpuUsagePct(prev, cur) {
  if (!prev || !cur) return null;
  const total = [prev, cur].every((s) => Number.isFinite(s?.total)) ? cur.total - prev.total : NaN;
  const idle = [prev, cur].every((s) => Number.isFinite(s?.idle)) ? cur.idle - prev.idle : NaN;
  if (!Number.isFinite(total) || !Number.isFinite(idle)) return null;
  if (total <= 0) return null;          // 回绕 / 重置 / 同一拍重复读
  const busy = total - idle;
  if (busy < 0) return null;            // idle 增量比总增量还大 = 两侧不同源，宁可说不知道
  return round(Math.min(100, Math.max(0, (busy / total) * 100)), 2);
}

/**
 * `/proc/meminfo` → 落库那一行的内存格。
 *
 * 口径（必须写死并写进文档，否则每个页面自己算一遍就是四份互相矛盾的数）：
 *   · `mem_used_bytes`      = `MemTotal - MemAvailable`（**不是** `MemTotal - MemFree`：
 *                             page cache 是「可回收的占用」，拿 free 当可用会把 128G 的机器读成只剩 10G）
 *   · `mem_cached_bytes`    = `Buffers + Cached + SReclaimable`（可回收那部分，单独一格给「为什么
 *                             used 这么高」一个解释）
 *   · `swap_used_bytes`     = `SwapTotal - SwapFree`（没有 swap ⇒ 0，那是真 0 不是「不知道」）
 * `MemTotal` 缺失 ⇒ 整格 `null`（连总量都不知道时不给一个百分比）。
 * `MemAvailable` 缺失（< 3.14 的内核）⇒ `memUsedBytes` 落 `null` 并**不**回落到 `MemFree`——
 * 拿一个不同口径的数填同一个格子就是撒谎。
 */
export function parseMeminfo(text) {
  const values = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = /^([A-Za-z0-9_]+):\s+(\d+)\s*kB\s*$/.exec(line.trim());
    if (m) values[m[1]] = Number(m[2]) * 1024;
    else {
      const bare = /^([A-Za-z0-9_]+):\s+(\d+)\s*$/.exec(line.trim());
      if (bare) values[bare[1]] = Number(bare[2]);
    }
  }
  const total = values.MemTotal ?? null;
  const available = values.MemAvailable ?? null;
  const free = values.MemFree ?? null;
  // 可回收那部分单独一格：它存在的理由就是给「used 为什么这么高」一个看得见的解释。
  const cachedBytes = (values.Buffers ?? 0) + (values.Cached ?? 0) + (values.SReclaimable ?? 0);
  const swapTotal = values.SwapTotal ?? null;
  const swapFree = values.SwapFree ?? null;
  return {
    memTotalBytes: total,
    memUsedBytes: total !== null && available !== null ? total - available : null,
    memAvailableBytes: available,
    memFreeBytes: free,
    memCachedBytes: cachedBytes,
    swapUsedBytes: swapTotal !== null ? swapTotal - (swapFree ?? 0) : null,
  };
}

/** `/proc/loadavg` → `{load1, load5, load15}`（脏值 ⇒ `null`；`0` 是真 0）。 */
export function parseLoadavg(text) {
  const parts = String(text ?? '').trim().split(/\s+/);
  const [load1, load5, load15] = [parts[0], parts[1], parts[2]].map((v) => {
    const n = numOrNull(v);
    return n === null || n < 0 ? null : round(n, 3);
  });
  return { load1, load5, load15 };
}

/** `/proc/uptime` → `{uptimeSeconds}`（取整秒；读不到 ⇒ `null`）。 */
export function parseUptime(text) {
  const first = String(text ?? '').trim().split(/\s+/)[0];
  const n = numOrNull(first);
  return { uptimeSeconds: n === null ? null : Math.floor(n) };
}

/**
 * `/proc/mounts` → **只有真实块设备**的挂载行：`{device, path, fs}`。
 *
 * 只认真实块设备前缀（`/dev/sd*`、`/dev/nvme*`、`/dev/vd*`、`/dev/mapper/*`、`/dev/md*`，见
 * `REAL_BLOCK_DEVICE_PREFIXES`）：`overlay` / `tmpfs` / `cgroup` / `proc` 那几十行不是「一块盘」，
 * 进面板就是噪声。
 *
 * ⚠ **比「`source` 以 `/dev/` 开头」窄**（这是本轮修掉的缺陷）：`/dev/loop0` 是 snap 的 squashfs、
 *   `/dev/ram*` 是内存盘、`/dev/zram*` 是压缩内存盘 —— 它们确实挂在 `/dev/` 下，但既不是宿主数据盘、
 *   用量也毫无运维含义（snap 的 squashfs 是**只读**压缩镜像，`statfs` 报的百分比是镜像填充度）。
 *   本机 `/proc/mounts` 里 `/dev/loop0..loop15` 有十几条 ⇒ 旧口径会让面板凭空多出十几行假盘。
 *   排除名单见 `PSEUDO_DEVICE_PATTERN`；分区号（`nvme0n1p2`、`sda1`、`vda2`、`md1`）都在允许前缀之后，
 *   不需要额外规则。
 *
 * ⚠ 代价必须写清：容器内的 `/proc/mounts` 是**容器自己的命名空间**，所以
 *   · bind mount 会报**宿主设备**（实测 `/srv/erix/users` → `/dev/nvme0n1p2 ext4`）⇒ 设备名拿得到；
 *   · 而**没被挂进 portal 的盘根本不在这里**⇒ 不会自动出现（`docs/ops/system-metrics.md` 的边界条）。
 * 八进制转义（`\040` = 空格）要还原，否则带空格的挂载点匹配不上。
 */
export function parseProcMounts(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [source, mountPoint, fstype] = parts;
    if (!isRealBlockDevice(unescapeMountPath(source))) continue;
    rows.push({
      device: unescapeMountPath(source),
      path: unescapeMountPath(mountPoint),
      fs: fstype,
    });
  }
  return rows;
}

/**
 * 真实块设备的允许前缀（issue #650 磁盘口径 + 本轮缺陷修正）。
 * 只列「是一块数据盘」的那几族；loop/ram/zram 见 `PSEUDO_DEVICE_PATTERN`。
 */
export const REAL_BLOCK_DEVICE_PREFIXES = Object.freeze([
  '/dev/sd',      // SATA / SCSI（含分区 sda1）
  '/dev/nvme',    // NVMe（含分区 nvme0n1p2）
  '/dev/vd',      // virtio / 云盘（含分区 vda2）
  '/dev/mapper/', // LVM 与 LUKS（dm-<n> 的别名，运维读得懂的就是这个名）
  '/dev/md',      // 软 RAID（md0、md1p1）
]);

/**
 * 挂在 `/dev/` 下但**不是盘**的那些：snap 的 squashfs（loop）、内存盘（ram）、压缩内存盘（zram）。
 * 必须在前缀判定之后再过一遍：`/dev/loop0` 不以五个允许前缀开头，理论上已经进不来，但
 * `/dev/md…`/`/dev/sd…` 这类前缀将来若被别的名字蹭到，这一道仍然挡得住（防御性冗余，成本一个正则）。
 */
export const PSEUDO_DEVICE_PATTERN = /^\/dev\/(loop\d*|ram\d*|zram\d*)$/;

/** `source` 是不是一块真实数据盘（`/proc/mounts` 第一列）。 */
export function isRealBlockDevice(source) {
  const value = String(source ?? '');
  if (!value.startsWith('/dev/')) return false;
  if (PSEUDO_DEVICE_PATTERN.test(value)) return false;
  return REAL_BLOCK_DEVICE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function unescapeMountPath(value) {
  // 键写成**字符串**：`{040: …}` 在严格模式下是非法的八进制字面量（`/proc/mounts` 的转义就是这种三位数字）。
  return String(value).replace(/\\(040|011|012|134)/g, (_, code) => (
    { '040': ' ', '011': '\t', '012': '\n', '134': '\\' }[code]
  ));
}

/** `statfs` 结果（Node 的 `{bsize, blocks, bfree, bavail}`）→ 字节数。缺字段 ⇒ `null`。 */
function statfsBytes(info) {
  const bsize = numOrNull(info?.bsize);
  const blocks = numOrNull(info?.blocks);
  const bfree = numOrNull(info?.bfree);
  const bavail = numOrNull(info?.bavail);
  if (bsize === null || blocks === null || bfree === null || bavail === null) return null;
  const totalBytes = bsize * blocks;
  // `df` 的口径：used = total - free（`bfree`）；avail = `bavail`（扣掉 root 预留块）。
  // 拿 bavail 当 free 去算 used 会把预留那几十 G 算成「没人用」，与 `df -h` 差一截。
  return { totalBytes, usedBytes: totalBytes - bsize * bfree, availBytes: bsize * bavail };
}

/**
 * 被测路径 + 挂载表 + statfs ⇒ **每个文件系统一行**。
 *
 * 规则（issue #650「一个物理盘 = 一行」）：
 *   · 设备名 = 挂载表里**最长前缀**匹配到的 `/dev/` 来源（`/srv/erix/users` 匹配到它自己而不是 `/`）；
 *     匹配不到 ⇒ `device='unknown'`、`fs='unknown'`（**仍然出这一行**，只是说不清它是谁；
 *     典型场合：容器里的 `/` 是 overlay，`/proc/mounts` 里那行的 source 不是 `/dev/`）；
 *   · **按 device 去重**：同一块盘 bind 了多个路径时 statfs 结果完全相同 ⇒ 只出一行，`path` 取
 *     其中**最短**的那个（最短 = 最接近挂载点本身，读起来最像「这块盘」）；
 *   · `statfs` 失败的路径 ⇒ 不进 `rows`（DB 那三列是 NOT NULL，不能写「不知道」），
 *     改出现在 `unreadable` 里，由 API 原样带给页面显示「未知」——**不是** 0、也不是整页失败。
 *
 * @param {{paths: string[], mounts: Array<{device:string,path:string,fs:string}>,
 *          statfs: (path: string) => Promise<unknown>}} input
 * @returns {Promise<{rows: Array<object>, unreadable: Array<{path: string, reason: string}>}>}
 */
export async function diskRows({ paths, mounts, statfs }) {
  const mountList = Array.isArray(mounts) ? mounts : [];
  const byDevice = new Map();
  const unreadable = [];
  for (const rawPath of Array.isArray(paths) ? paths : []) {
    const path = String(rawPath ?? '').trim();
    if (!path) continue;
    let info = null;
    try {
      info = await statfs(path);
    } catch (err) {
      unreadable.push({ path, reason: err?.code ?? err?.message ?? 'statfs_failed' });
      continue;
    }
    const bytes = statfsBytes(info);
    if (bytes === null) {
      unreadable.push({ path, reason: 'statfs_incomplete' });
      continue;
    }
    const mount = longestPrefixMount(mountList, path);
    const row = {
      device: mount?.device ?? 'unknown',
      fs: mount?.fs ?? 'unknown',
      path,
      ...bytes,
    };
    const prev = byDevice.get(row.device);
    // 同设备多路径 ⇒ 取最短 path（长度相同再按字典序，保证**确定性**：同一台机器每次给同一行）。
    if (!prev || row.path.length < prev.path.length
      || (row.path.length === prev.path.length && row.path < prev.path)) {
      byDevice.set(row.device, row);
    }
  }
  const rows = [...byDevice.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { rows, unreadable };
}

/** 挂载表里与 `path` 前缀匹配**最长**的那一行（`/srv/erix/users` 优先于 `/`）。 */
function longestPrefixMount(mounts, path) {
  let best = null;
  for (const mount of mounts) {
    const base = mount.path === '/' ? '/' : mount.path.replace(/\/+$/, '');
    const hit = base === '/' || path === base || path.startsWith(base + '/');
    if (hit && (!best || base.length > (best.path === '/' ? 1 : best.path.length))) best = mount;
  }
  return best;
}

// ── 采样器 ────────────────────────────────────────────────────────────────────────────────

/** 选桶宽：从档位里挑**最小的**、能让点数 ≤ `SERIES_TARGET_POINTS` 的那个。 */
export function pickBucketSeconds(rangeSeconds, target = SERIES_TARGET_POINTS) {
  const span = Number(rangeSeconds);
  if (!Number.isFinite(span) || span <= 0) return BUCKET_SECONDS[0];
  for (const bucket of BUCKET_SECONDS) {
    if (Math.ceil(span / bucket) <= target) return bucket;
  }
  return BUCKET_SECONDS[BUCKET_SECONDS.length - 1];
}

/** 分桶 SQL（导出来给单测钉文本；`$1` = since，`$2` = 桶宽秒数）。 */
export function seriesSql() {
  return `SELECT to_timestamp(floor(extract(epoch FROM sampled_at) / $2) * $2) AS bucket,
                 round(avg(cpu_usage_pct), 2)  AS cpu_avg,
                 max(cpu_usage_pct)            AS cpu_max,
                 round(avg(mem_used_bytes))    AS mem_used,
                 max(containers_running)       AS containers_running,
                 count(*)::integer             AS samples
            FROM system_metrics
           WHERE sampled_at >= $1
           GROUP BY 1
           ORDER BY 1`;
}

// `(range) → {at, value}` 的进程内缓存。模块级：portal 是单进程，两个 sampler 共享一份历史读数
// 不会互相抹掉（值只由 DB 决定）。测试用 `clearSeriesCache()` 复位。
const seriesCache = new Map();

export function clearSeriesCache() {
  seriesCache.clear();
}

/**
 * 历史序列：服务端分桶，**绝不把 8.6 万个原始点发给浏览器**（30d × 30s = 86,400 行）。
 *
 * 桶宽按 `pickBucketSeconds()` 选（目标 ≤240 点），扫描就是主键的范围扫（24h = 2880 行、
 * 30d = 86,400 行，毫秒级），结果按 `range` 缓存 5s——前端轮询也是 5s，两个 5s 对齐之后
 * 「10 个人同开这一页」的 DB 查询量与 1 个人相同。
 *
 * `now` 只用于**两件事**：算 `since` 窗口、算缓存 TTL。落库时间戳的权威仍是 DB（`now()`），
 * 这里不改那条口径。
 * @returns {Promise<{bucketSeconds:number, points:Array<object>, range:string, cached:boolean}>}
 */
export async function querySeries(pool, { range = DEFAULT_METRIC_RANGE, now = () => Date.now() } = {}) {
  const key = METRIC_RANGES[range] ? range : DEFAULT_METRIC_RANGE;
  const spanSeconds = METRIC_RANGES[key];
  const at = Number(now());
  const hit = seriesCache.get(key);
  if (hit && at - hit.at < SERIES_CACHE_TTL_MS) return { ...hit.value, range: key, cached: true };

  const bucketSeconds = pickBucketSeconds(spanSeconds);
  const since = new Date(at - spanSeconds * 1000);
  const res = await pool.query(seriesSql(), [since, bucketSeconds]);
  const points = (res?.rows ?? []).map((row) => ({
    // ISO 字符串（前端只做渲染，不做时区推算；页面按 UTC+8 显示是前端的事）。
    t: row.bucket instanceof Date ? row.bucket.toISOString() : row.bucket ?? null,
    cpuAvg: numOrNull(row.cpu_avg),
    cpuMax: numOrNull(row.cpu_max),
    memUsed: numOrNull(row.mem_used),
    containersRunning: numOrNull(row.containers_running),
    samples: numOrNull(row.samples),
  }));
  const value = { bucketSeconds, points };
  seriesCache.set(key, { at, value });
  return { ...value, range: key, cached: false };
}

/**
 * 容器计数（口径写死：总数 = 宿主全部，明细 = `station.managed` / `fde-*`）。
 *
 * `data` 脏（不是数组）或 status ≠ 200 ⇒ 抛错，由调用方降级成 `unknown`——**这里不猜数**。
 */
export function countContainers(list) {
  const items = Array.isArray(list) ? list : [];
  const nameOf = (c) => String((c?.Names?.[0] ?? c?.name ?? '')).replace(/^\//, '');
  const managed = (c) => (c?.Labels ?? {})['station.managed'] === 'true';
  const isFde = (c) => managed(c) || /^fde-/.test(nameOf(c));
  const running = (c) => c?.State === 'running';
  const paused = (c) => c?.State === 'paused';
  const runningFde = items.filter((c) => isFde(c) && running(c));
  return {
    total: items.length,
    running: items.filter(running).length,
    paused: items.filter(paused).length,
    stopped: items.filter((c) => !running(c) && !paused(c)).length,
    station: items.filter(managed).length,
    fde: items.filter(isFde).length,
    fdeRunning: runningFde.length,
    // 名字集合给「DB N 台 ↔ Docker M 台」的对账用（对账要的是**谁**，不只是差几个）。
    fdeNames: items.filter(isFde).map(nameOf).sort(),
  };
}

/** DB 侧的 FDE 容器名（`containers` 表里还没 removed 的那些）。 */
export const DB_CONTAINER_NAMES_SQL = `SELECT container_name
    FROM containers
   WHERE status <> 'removed'
   ORDER BY container_name`;

/** 两个名字集合的对称差（`onlyDb` / `onlyDocker`），给对账行点名用。 */
export function containerDrift(dbNames, dockerNames) {
  const a = new Set(Array.isArray(dbNames) ? dbNames : []);
  const b = new Set(Array.isArray(dockerNames) ? dockerNames : []);
  const onlyDb = [...a].filter((n) => !b.has(n)).sort();
  const onlyDocker = [...b].filter((n) => !a.has(n)).sort();
  return { db: a.size, docker: b.size, onlyDb, onlyDocker, count: onlyDb.length + onlyDocker.length };
}

/**
 * `GET /api/admin/system/metrics` 的响应本体（契约 `docs/api/portal.md` §4.18，字段形状见 issue #650 §API）。
 *
 * 抽成函数而不是写在 `http.js` 的 if 链里，理由：`http.js` 已 5000+ 行，而本端点的业务全部是
 * 「拼三份读数 + 一个降级分支」，写在路由链里会让那段注释比代码长（本仓已多次为此把业务抽出去）。
 *
 * 三条硬口径（逐条有单测）：
 *   · `range` 非法 ⇒ **回落 `1h`**，不报 400——这是一个只读观测面，把一个拼错的查询参数变成错误页
 *     只会让人多进一次后台；回落后把**生效的值**回在 `range` 字段里（页面据此渲染选中态，不撒谎）。
 *   · `querySeries` 抛错 ⇒ `seriesError` 给原因字符串，而 **`latest` 仍必须 200 正常返回**：
 *     卡片读的是进程内那一拍，DB 挂了它依旧有数（决定 2）——这是本端点存在的理由，不是降级补丁。
 *     此时 `series.points` 给空数组（页面画「该区间无数据」，不画一条贴底的假线）。
 *   · 采样器没跑（`SYSTEM_METRICS_ENABLED=0`）或还没有第一拍 ⇒ `latest: null`，**不是 500**。
 *
 * @param {{pool: object, sampler?: {latest?: () => object|null}, retentionDays?: number|null,
 *          range?: string, now?: () => number}} input
 */
export async function metricsApiPayload({
  pool, sampler = null, retentionDays = null, range = DEFAULT_METRIC_RANGE, now = () => Date.now(),
} = {}) {
  // 非法 `range` 在这里（而不是在 HTTP 层）回落：`querySeries` 本来也是同一个口径，两处共用一个判定。
  const key = METRIC_RANGES[range] ? range : DEFAULT_METRIC_RANGE;
  const latest = toApiLatest(typeof sampler?.latest === 'function' ? sampler.latest() : null);
  let series = { bucketSeconds: pickBucketSeconds(METRIC_RANGES[key]), points: [] };
  let seriesError = null;
  try {
    const { bucketSeconds, points } = await querySeries(pool, { range: key, now });
    series = { bucketSeconds, points };
  } catch (err) {
    // 只给原因字符串（`code` 优先，没 code 才给 message）：堆栈与 SQL 片段不该出现在管理台响应里。
    seriesError = String(err?.code ?? err?.message ?? err);
  }
  return { latest, series, range: key, retentionDays: retentionDays ?? null, seriesError };
}

/**
 * 采样器：每 `intervalMs` 一拍 —— 读 `/proc` + `statfs` + `listContainers` ⇒
 * ① 更新进程内「最新一拍」② 一个事务写 `system_metrics` + `system_metrics_disks`。
 *
 * 全部外部依赖都可注入（`readFile` / `statfs` / `docker` / `now` / `setInterval` / `clearInterval`），
 * 所以「单飞、写失败不抛、ENABLED=0 零写入、docker 不可达降级」这四条**都能在假对象上测**。
 *
 * @param {{pool: object, docker?: object, config: {systemMetrics: object},
 *          now?: () => number, log?: object,
 *          readFile?: (path: string, encoding: string) => Promise<string>,
 *          statfs?: (path: string) => Promise<unknown>,
 *          setInterval?: Function, clearInterval?: Function,
 *          procRoot?: string, tickOnStart?: boolean}} deps
 * @returns {{stop: () => void, tickOnce: () => Promise<object>, latest: () => object|null,
 *            done?: undefined}}
 */
export function startMetricsSampler({
  pool,
  docker = null,
  config,
  now = () => Date.now(),
  log = console,
  readFile = (p) => fs.promises.readFile(p, 'utf8'),
  statfs = (p) => fs.promises.statfs(p),
  setInterval: setIntervalImpl = globalThis.setInterval,
  clearInterval: clearIntervalImpl = globalThis.clearInterval,
  procRoot = DEFAULT_PROC_ROOT,
  tickOnStart = true,
} = {}) {
  const settings = config?.systemMetrics ?? {};
  const enabled = settings.enabled !== false;
  const intervalMs = Math.max(1000, Number(settings.intervalSeconds ?? 30) * 1000);
  const diskPaths = Array.isArray(settings.diskPaths) && settings.diskPaths.length > 0
    ? settings.diskPaths : ['/'];

  const client = docker ?? createDockerClient({ dockerHost: config?.dockerHost });
  /** @type {object|null} 进程内的「最新一拍」——卡片唯一的数据源（DB 挂了也看得见实时值）。 */
  let latest = null;
  /** 定时器句柄（`null` = 没建，`ENABLED=0` 就是这个形态）。 */
  let timer = null;
  /** @type {object|null} 上一拍的 `/proc/stat`（使用率必须两点相减）。 */
  let prevStat = null;
  let stopped = false;
  /** @type {Promise<object>|null} 正在进行的那一拍（单飞靠它）。 */
  let inflight = null;
  let lastSkipReason = null;
  let dockerCache = { at: 0, data: null };

  /** 只在「原因变了」时说一次：每 30s 一条同样的 warn 等于没有 warn。 */
  function warnOnce(reason, message) {
    if (lastSkipReason === reason) return;
    lastSkipReason = reason;
    log?.warn?.(message);
  }

  async function readProc(name) {
    try {
      return await readFile(`${procRoot}/${name}`, 'utf8');
    } catch (err) {
      warnOnce(`proc-${name}`, `[system-metrics] 读 ${procRoot}/${name} 失败（${err?.code ?? err?.message ?? 'unknown'}）：这一拍的该项是未知`);
      return null;
    }
  }

  async function listContainers() {
    const at = Number(now());
    if (dockerCache.data !== null && at - dockerCache.at < DOCKER_LIST_TTL_MS) return dockerCache.data;
    const res = await client.call('GET', '/containers/json?all=1');
    if (res?.status !== 200 || !Array.isArray(res?.data)) {
      const err = new Error(`docker listContainers → ${res?.status ?? 'no-response'}`);
      err.code = 'docker_list_failed';
      throw err;
    }
    dockerCache = { at, data: res.data };
    return res.data;
  }

  /** DB 侧的容器名（对账用）。读失败 ⇒ 抛出，由调用方把 drift 落成未知。 */
  async function dbContainerNames() {
    const res = await pool.query(DB_CONTAINER_NAMES_SQL);
    return (res?.rows ?? []).map((r) => r.container_name).filter((n) => typeof n === 'string');
  }

  async function runTick() {
    const sampledAtMs = Number(now());
    const stat = parseProcStat(await readProc('stat'));
    const mem = parseMeminfo(await readProc('meminfo'));
    const load = parseLoadavg(await readProc('loadavg'));
    const uptime = parseUptime(await readProc('uptime'));
    const mountsText = await readProc('mounts');
    const mounts = mountsText === null ? [] : parseProcMounts(mountsText);
    const { rows: disks, unreadable } = await diskRows({ paths: diskPaths, mounts, statfs });

    let containers = null;
    try {
      containers = countContainers(await listContainers());
    } catch (err) {
      // docker 不可达 ≠ 0 台：整格落成未知，页面说「未知」，历史这一拍不落库（下面 `missing` 那条）。
      warnOnce('docker', `[system-metrics] 容器数读取失败（${err?.code ?? err?.message ?? 'unknown'}）：这一拍的容器格是未知`);
    }

    const usagePct = cpuUsagePct(prevStat, stat);
    // ⚠ **只在真的读到新 stat 时才覆盖上一拍**：读失败那一拍必须保留旧值，否则一次临时错误
    // 会把基线清掉，下一拍又变成「第一拍」（白丢一个本来可写的拍）。
    if (stat) prevStat = stat;

    const sample = {
      sampledAt: new Date(sampledAtMs),
      cpuUsagePct: usagePct,
      cpuCores: stat?.cores ?? null,
      load1: load.load1,
      load5: load.load5,
      load15: load.load15,
      ...mem,
      uptimeSeconds: uptime.uptimeSeconds,
      containers,
      // 对账（DB ↔ Docker）先留空，写事务里读到 DB 名字才填；读不到就是 null（页面说「没读到」）。
      drift: null,
      disks,
      diskUnreadable: unreadable,
    };
    latest = sample;

    // 「哪一格没有值」——`system_metrics` 那一行全是 NOT NULL，任何一格未知就**不写这一拍**
    // （写 0 是撒谎，写 NULL 是当场 23502）。历史图上留一个洞，正是 issue #650 选的那一侧。
    //
    // ⚠ 「使用率算不出」必须单独分出来：它是两点相减，**启动那一拍必然算不出**（以及
    // 上一拍没读到 / 计数器回绕）。那是预定中的事不是故障，走 `log.debug`（默认不响）；
    // 混进「读不全」里叫，每次 portal 重启都呌一条无关的 warn。
    const missing = [];
    if (sample.cpuCores === null) missing.push('cpu_cores');
    for (const key of ['load1', 'load5', 'load15', 'memTotalBytes', 'memUsedBytes',
      'memAvailableBytes', 'memCachedBytes', 'swapUsedBytes', 'uptimeSeconds']) {
      if (sample[key] === null) missing.push(key);
    }
    if (sample.containers === null) missing.push('containers');
    if (missing.length > 0) {
      warnOnce('incomplete', `[system-metrics] 这一拍读不全（缺 ${missing.join(', ')}），跳过落库：历史图上会有一个洞，比写 0 诚实`);
      return { written: false, skipped: 'incomplete', missing };
    }
    if (sample.cpuUsagePct === null) {
      // 只有「没得减」这一项（启动后第一拍，或上一拍 `stat` 没读到）：下一拍自然就有。
      log?.debug?.('[system-metrics] 没有可减的上一拍 ⇒ CPU 使用率未知，这一拍不落库');
      return { written: false, skipped: 'priming' };
    }

    const drift = containerDrift(await dbContainerNames(), sample.containers.fdeNames);
    sample.drift = drift;
    await writeSample(pool, sample, drift);
    lastSkipReason = null;
    return { written: true, sample };
  }

  const handle = {
    stop() {
      stopped = true;
      if (timer !== null) { clearIntervalImpl(timer); timer = null; }
    },
    /** 一拍（单飞：正在进行时直接跳过，不排队）。`ENABLED=0` 时是 no-op。 */
    async tickOnce() {
      if (!enabled) return { written: false, skipped: 'disabled' };
      if (stopped) return { written: false, skipped: 'stopped' };
      // 单飞（三条防护之一）：上一拍的写还没回来就**跳过**这一拍。排队会让 DB 卡住时
      // 排出一串 Promise 堆在内存里，而每一拍都会读到同一份「现在」——毫无意义。
      if (inflight) return { written: false, skipped: 'inflight' };
      inflight = runTick().catch((err) => {
        // 写失败只 warn：不抛、不重试风暴（portal 是单进程 + SSE + LLM 代理，观测面不承重）。
        log?.warn?.(`[system-metrics] 这一拍失败（${err?.code ?? err?.message ?? 'unknown'}），下一拍继续`);
        return { written: false, skipped: 'error', error: err?.message ?? String(err) };
      }).finally(() => { inflight = null; });
      return inflight;
    },
    latest() {
      return latest;
    },
    enabled,
    intervalMs,
  };

  // 定时器在句柄之后建：`stop()` 必须能在任何时刻被调用（包括 `ENABLED=0` 那一支）。
  // `ENABLED=0` ⇒ **这一整块根本不执行**：不建定时器、不跑启动那一拍 ⇒「零写入」判据由此成立。
  if (enabled) {
    timer = setIntervalImpl(() => { void handle.tickOnce(); }, intervalMs);
    // 三条防护之一：定时器不许拖住进程退出（portal 是单进程 + SSE + LLM 代理）。
    if (typeof timer?.unref === 'function') timer.unref();
    // 启动即拍一次（与其余 reconciler 同一形状）：不等第一拍的话，刚重启的 portal 会让四张卡
    // 空着半分钟。那一拍只是**不写库**（使用率没得减），内存/磁盘/容器数当场就有数。
    // 单测用 `tickOnStart: false` 回到「只有显式 tick 才动」的确定性形状。
    if (tickOnStart) void handle.tickOnce();
  }

  return handle;
}

/** 写事务：一行 `system_metrics` + N 行 `system_metrics_disks`，都带 `ON CONFLICT DO NOTHING`。 */
export async function writeSample(pool, sample, drift) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const params = [
      sample.sampledAt,
      sample.cpuUsagePct,
      sample.cpuCores,
      sample.load1, sample.load5, sample.load15,
      sample.memTotalBytes, sample.memUsedBytes, sample.memAvailableBytes,
      sample.memCachedBytes, sample.swapUsedBytes,
      sample.uptimeSeconds,
      sample.containers.total, sample.containers.running, sample.containers.station,
      sample.containers.fde, sample.containers.fdeRunning,
      drift.count,
      new Date(sample.sampledAt.getTime()),   // written_at：应用侧写（DDL 不写 DEFAULT now()）
    ];
    await client.query(WRITE_METRICS_SQL, params);

    const disks = sample.disks ?? [];
    if (disks.length > 0) {
      // 多值 INSERT：每拍一条语句，`sampled_at` 由 `$1` 复用（每行 5 个自己的参数）。
      const diskParams = [sample.sampledAt];
      for (const disk of disks) {
        diskParams.push(disk.device, disk.path, disk.fs, disk.totalBytes, disk.usedBytes, disk.availBytes);
      }
      await client.query(disksInsertSql(disks.length), diskParams);
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    try {
      await client.release();
    } catch { /* 释放失败没有可修的东西：连接随进程走 */ }
  }
}

/** `system_metrics` 那一行的 INSERT（`ON CONFLICT` 打在自然键上 ⇒ 同一采样时刻重放是空操作）。 */
export const WRITE_METRICS_SQL = `INSERT INTO system_metrics (
    sampled_at, cpu_usage_pct, cpu_cores,
    load1, load5, load15,
    mem_total_bytes, mem_used_bytes, mem_available_bytes, mem_cached_bytes, swap_used_bytes,
    uptime_seconds,
    containers_total, containers_running, containers_station,
    fde_total, fde_running, drift_count,
    written_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
  ON CONFLICT (sampled_at) DO NOTHING`;

/** 磁盘行的多值 INSERT（每拍一条语句；冲突目标是复合主键 `(sampled_at, device)`）。 */
export function disksInsertSql(count) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const base = i * 5;
    rows.push(`($1, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
  }
  return `INSERT INTO system_metrics_disks (sampled_at, device, path, fs, total_bytes, used_bytes, avail_bytes)
    VALUES ${rows.join(', ')}
    ON CONFLICT (sampled_at, device) DO NOTHING`;
}

/**
 * 进程内那一拍 → API 的 `latest`（响应形状的唯一定义处，契约 `docs/api/portal.md` §4.18）。
 *
 * 三条硬口径：
 *   · 缺值 ⇒ `null`，**永不**是 `0` / 空串 / `undefined`（#586：拿不到的指标渲染成「未知」）；
 *   · `containers` 整格可能是 `null`（docker 不可达）——那是「读不到」，不是「0 台」；
 *   · `disk[]` 之外另带 `diskUnreadable[]`：读不到的路径也要在页面上露面（不然「已监控 N 个
 *     文件系统」这句会变成悄悄少了一行的谎）。
 */
export function toApiLatest(sample) {
  if (!sample) return null;
  const pct = (used, total) => (Number.isFinite(used) && Number.isFinite(total) && total > 0
    ? round((used / total) * 100, 1) : null);
  return {
    sampled_at: sample.sampledAt instanceof Date ? sample.sampledAt.toISOString() : sample.sampledAt,
    cpu: {
      usagePct: sample.cpuUsagePct ?? null,
      cores: sample.cpuCores ?? null,
      load: [sample.load1, sample.load5, sample.load15].map((v) => v ?? null),
    },
    mem: {
      totalBytes: sample.memTotalBytes ?? null,
      usedBytes: sample.memUsedBytes ?? null,
      availableBytes: sample.memAvailableBytes ?? null,
      cachedBytes: sample.memCachedBytes ?? null,
      swapUsedBytes: sample.swapUsedBytes ?? null,
      usedPct: pct(sample.memUsedBytes, sample.memTotalBytes),
    },
    disk: (sample.disks ?? []).map((d) => ({
      device: d.device ?? 'unknown',
      path: d.path ?? null,
      fs: d.fs ?? 'unknown',
      totalBytes: d.totalBytes ?? null,
      usedBytes: d.usedBytes ?? null,
      availBytes: d.availBytes ?? null,
      usedPct: pct(d.usedBytes, d.totalBytes),
    })),
    diskUnreadable: (sample.diskUnreadable ?? []).map((d) => ({ path: d.path, reason: d.reason })),
    containers: sample.containers === null || sample.containers === undefined ? null : {
      total: sample.containers.total,
      running: sample.containers.running,
      paused: sample.containers.paused,
      stopped: sample.containers.stopped,
      station: sample.containers.station,
      fde: sample.containers.fde,
      fdeRunning: sample.containers.fdeRunning,
      drift: sample.drift ?? null,
    },
  };
}
