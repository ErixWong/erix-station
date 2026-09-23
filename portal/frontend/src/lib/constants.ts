// 工作台共享常量（portal/static/index.html 内联 JS 逐字平移）。

// issue #55 A2：距底超过该值视为「离开底部」，暂停自动跟随。
export const AUTO_FOLLOW_GAP = 80;

// 项目名校验（新项目表单，错误文案同步在 SidebarForm 组件内）。
export const PROJECT_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
