// issue #818：管理台侧栏分组图标——**自维护内联 SVG，不引任何图标库**（前端零图标依赖是现状）。
//
// 来源与许可：path 数据取自 **Lucide**（https://lucide.dev ，ISC 许可，https://iscorg.org ），
// 只抄 `d` 字符串（几何数据），不 import 它的包；Lucide 的 `<circle>` / `<rect>` / `<line>`
// 一律改写成等价的 `<path d="…">`，于是渲染侧（`components/AppIcon.vue`）只需要一种元素。
//
// 口径（工单 #818 §⑤，后面 #817 复用同一套规矩）：
//   ① 键名语义化（`users` / `cpu` / `plug` / `sliders` / `activity` / `zap` / `info`），
//      **不按调用点命名**（`adminGroupUsers` 那种名字逼每个新页面重抄一条）；
//   ② 值是一条或多条 `<path d>`；`AppIcon` 用统一 viewBox / stroke / stroke-width 渲染，
//      所以这里**只存几何**，不存颜色、不存尺寸、不存 class；
//   ③ 取不到的键 ⇒ `AppIcon` 渲染空 `<svg>`（不抛）：图标缺失是「少一个装饰」，
//      不是「导航整块消失」，所以这里宁可漏一个键也不能让它阻塞渲染。
//
// 什么时候才考虑换成图标库（升级触发条件，写在这里是为了将来不必重新争论）：
//   · 需要**几十个**不同图标、且每个都要人肉从 Lucide 抄 path（维护成本反超依赖成本）；
//   · 需要图标内多色 / 动画（内联单色 stroke 画不出来）；
//   · 需要 per-icon 单元测试之外的视觉回归工具链。
//   在这三条成立之前，新增图标就是一次提交里往本表加一行（配一行来源注释）。
export const ICON_PATHS: Record<string, string[]> = {
  // Lucide `users`（ISC）：两个人形。circle(cx=9,cy=7,r=4) 已改写成等价的圆弧 path。
  users: [
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
    'M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    'M22 21v-2a4 4 0 0 0-3-3.87',
    'M16 3.13a4 4 0 0 1 0 7.75',
  ],
  // Lucide `cpu`（ISC）：外框 + 内核 + 六根引脚。两个 rect 改写成圆角矩形 path。
  cpu: [
    'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
    'M10 9h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z',
    'M15 2v2',
    'M9 2v2',
    'M15 20v2',
    'M9 20v2',
    'M20 15h2',
    'M20 9h2',
    'M2 15h2',
    'M2 9h2',
  ],
  // Lucide `plug`（ISC）：平台接入（仓库 / 邮件 / 证书 = 对外的管子）。原生就是纯 path。
  plug: [
    'M12 22v-5',
    'M9 8V2',
    'M15 8V2',
    'M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z',
  ],
  // Lucide `sliders-horizontal`（ISC）：滑杆 = 平台配置。九条 line 改写成 M/h/v 形式。
  sliders: [
    'M21 4h-7',
    'M10 4H3',
    'M21 12h-9',
    'M8 12H3',
    'M21 20h-5',
    'M12 20H3',
    'M14 2v4',
    'M8 10v4',
    'M16 18v4',
  ],
  // Lucide `activity`（ISC）：折线 = 只读运行观察（系统 / 号池占用）。
  activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  // Lucide `zap`（ISC）：闪电 = 宏（事件触发）。polygon 改写成闭合 path。
  zap: ['M13 2 3 14h9l-1 8 10-12h-9l1-8z'],
  // Lucide `info`（ISC）：「关于」（底部固定项）。circle(r=10) 改写成圆弧 path。
  info: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', 'M12 16v-4', 'M12 8h.01'],
  // issue #817 步 3：管理台用户表的动作列也复用同一套表（见 `AdminUsersView.vue`）。
  // Lucide `folder`（ISC）：「会话 / 文件」= 这人的工位内容（原生就是纯 path）。
  folder: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
  // Lucide `pencil-line`（ISC）：「编辑」。键名按语义叫 `pencil`（口径 ①：不按调用点命名），
  // 几何取 pencil-line（带那一横，比 `pencil` 更易认）。两笔：笔身 + 下划线。
  pencil: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'],
};
