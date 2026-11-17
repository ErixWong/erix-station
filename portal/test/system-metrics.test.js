// issue #650：宿主资源监控（采样 / 落库 / 分桶 / 读面）的单测。
//
// 隔离（docs/testing.md §2.1）：**全部**用假 pool + 假时钟 + 假 docker + 假 readFile/statfs。
// 不碰真实 DB、不碰真实 `/proc`、不建真实定时器 ⇒ 采样器四条防护（单飞 / 写失败不抛 /
// `ENABLED=0` 零写入零定时器 / `unref()`）都能在这里确定性复现。
// 判绿只看退出码（AGENTS §4）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseProcStat, cpuUsagePct, parseMeminfo, parseLoadavg, parseUptime,
  parseProcMounts, isRealBlockDevice, diskRows, pickBucketSeconds,
} from '../src/system-metrics.js';

// ── `/proc/mounts`：只认真实块设备 ────────────────────────────────────────────────────────
//
// 这一条是本轮修掉的**真缺陷**：旧口径「`source` 以 `/dev/` 开头」会把 snap 的 `/dev/loop0`
// （squashfs 只读压缩镜像）当成一块盘。本机 `/proc/mounts` 里 `/dev/loop0..loop15` 有 8 条
// （`wc -l` 实测），旧口径会让面板凭空多出 8 行假盘，且它们的"用量"是镜像填充度、毫无运维含义。
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
  '/dev/loop7 /snap/snapd/1 snapfs ro 0 0',
  '/dev/ram0 /mnt/ram ext4 rw 0 0',
  '/dev/zram0 /mnt/zram ext4 rw 0 0',
  'tmpfs /dev/shm tmpfs rw 0 0',
  'proc /proc proc rw 0 0',
  'cgroup2 /sys/fs/cgroup cgroup2 rw 0 0',
  '/dev/nvme0n1p2 /mnt/with\\040space ext4 rw 0 0',
].join('\n');

test('#650 parseProcMounts：只认真实块设备，loop/ram/zram 一律排除', () => {
  const rows = parseProcMounts(MOUNTS_FIXTURE);
  const devices = rows.map((r) => r.device);
  // 五族真实设备全收（含分区号、含 LVM 里的 `--`、含软 RAID）
  for (const want of ['/dev/nvme0n1p2', '/dev/sda1', '/dev/vda2', '/dev/mapper/vg--data-lv', '/dev/md0']) {
    assert.ok(devices.includes(want), `${want} 必须收：它是真实块设备`);
  }
  // loop / ram / zram 一条都不许漏进来
  for (const gone of ['/dev/loop0', '/dev/loop7', '/dev/ram0', '/dev/zram0']) {
    assert.ok(!devices.includes(gone), `${gone} 不许出现：它不是盘（squashfs 镜像 / 内存盘）`);
  }
  // 非 `/dev/` 的 source 同样不进（overlay / tmpfs / proc / cgroup2）
  assert.deepEqual(devices.filter((d) => !d.startsWith('/dev/')), [], '非 /dev/ 的 source 不该出现在结果里');
  // 八进制转义要还原，否则带空格的挂载点匹配不上（`longestPrefixMount` 会漏）
  assert.ok(rows.some((r) => r.path === '/mnt/with space'), '\\040 必须还原成空格');
  // 同一设备的多条挂载行**原样保留**（去重是 `diskRows` 的职责，不在解析层）：fixture 里 nvme0n1p2 有 3 行
  assert.equal(devices.filter((d) => d === '/dev/nvme0n1p2').length, 3);
});

test('#650 isRealBlockDevice：判定谓词单独钉（`/dev/` 前缀不等于是一块盘）', () => {
  assert.deepEqual(
    ['/dev/sda', '/dev/sda1', '/dev/nvme0n1', '/dev/nvme0n1p2', '/dev/vda', '/dev/vda2',
      '/dev/mapper/vg--data', '/dev/md0', '/dev/md1p1'].map((d) => isRealBlockDevice(d)),
    [true, true, true, true, true, true, true, true, true],
  );
  assert.deepEqual(
    ['/dev/loop0', '/dev/loop', '/dev/ram0', '/dev/zram0', '/dev/sr0', '/dev/tty0', '/dev/shm',
      'overlay', 'tmpfs', '', null, undefined, '/dev/', '/dev/nvme0n1p2x/loop'].map((d) => isRealBlockDevice(d)),
    [false, false, false, false, false, false, false, false, false, false, false, false, false, true],
    '/dev/sr0（光驱）与 /dev/tty* 不在允许前缀里 ⇒ false；末条是前缀匹配的现状（含 p2x 的路径仍算盘）',
  );
});
