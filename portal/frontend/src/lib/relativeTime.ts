// 相对时间格式化（issue #94 会话选择 modal 结果行用；不引第三方库）。
// 规则：<1 分钟「刚刚」；<60 分钟「N 分钟前」；<24 小时「N 小时前」；<7 天「N 天前」；
// 更早回退本地日期（zh-CN）。now 可注入以便单测。

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** ISO 时间串 → 中文相对时间；非法/缺省输入回退空串（调用方自行兜底展示）。 */
export function formatRelativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = now.getTime() - t;
  if (diff < 0 || diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}
