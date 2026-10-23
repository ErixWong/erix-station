// 消息时间戳展示（issue #282 A 块）。
//
// 数据面事实（不在本单重做、也不改后端）：每条消息的时刻取自对话流 DTO 的 `created_at`，
// 由宿主在 `portal/src/session-view.js:473` 从 `messages` 锚点行透传（ISO 串或原值）。
// 前端只做**展示**：不推导时区、不重排、不参与任何运行态判定。
//
// 红线（issue #282 验收 ①）：缺失/脏值必须**一字不出**——绝不允许 `undefined` / `Invalid Date` /
// `NaN` 上屏。故本函数只认「非空字符串」这一种形状：
//   * `undefined` / `null` / `''`（旧后端、合成行没带锚点）→ `''`；
//   * 数字/对象/Date 实例（脏载荷）→ `''`：DTO 契约是字符串，别的形状属于上游违约，
//     **不去猜**（拿 `new Date(number)` 硬解析会把一个错误形状演成看起来正确的时间）；
//   * 解析不出（`'not-a-date'`、`'undefined'` 字面量）→ `''`。
export function formatMessageTime(value: unknown, locale: string): string {
  // 空值分支（变异哨兵：删掉它，数字时间戳用例必须红——`new Date(1700000000000)` 是可解析的）。
  if (typeof value !== 'string' || value === '') return '';
  const date = new Date(value);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return ''; // 脏串分支（Invalid Date ⇒ getTime() = NaN）
  try {
    return date.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    // locale 脏值（`toLocaleTimeString` 对非法 locale 会抛 RangeError）：宁可不出时间，不出脏字。
    return '';
  }
}
