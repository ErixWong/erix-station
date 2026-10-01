// 工作台共享常量（portal/static/index.html 内联 JS 逐字平移）。

// issue #55 A2：距底超过该值视为「离开底部」，暂停自动跟随。
export const AUTO_FOLLOW_GAP = 80;

// 目录名校验（「＋ 新建目录」表单，错误文案在 NewDirectoryModal 组件内）。
// issue #84 P5：目录即项目，~/projects/ 一级目录名沿用原项目名规则（合法 hostname 段）。
export const DIR_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// issue #107：会话标题长度上限——与后端 sessions.updateSession 的校验口径一致（>200 → 400）。
// 前端超长时先截断再提交（不把 400 抛给用户）；`maxlength` 输入框同样按此值限长。
export const SESSION_TITLE_MAX_LEN = 200;
