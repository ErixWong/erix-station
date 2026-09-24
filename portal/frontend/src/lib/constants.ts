// 工作台共享常量（portal/static/index.html 内联 JS 逐字平移）。

// issue #55 A2：距底超过该值视为「离开底部」，暂停自动跟随。
export const AUTO_FOLLOW_GAP = 80;

// 目录名校验（「＋ 新建目录」表单，错误文案在 SidebarPanel 组件内）。
// issue #84 P5：目录即项目，~/projects/ 一级目录名沿用原项目名规则（合法 hostname 段）。
export const DIR_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
