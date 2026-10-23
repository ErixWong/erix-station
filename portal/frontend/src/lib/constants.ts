// 工作台共享常量（portal/static/index.html 内联 JS 逐字平移）。

// issue #55 A2：距底超过该值视为「离开底部」，暂停自动跟随。
export const AUTO_FOLLOW_GAP = 80;

// 目录名校验（「＋ 新建目录」表单，错误文案在 NewDirectoryModal 组件内）。
// issue #84 P5：目录即项目，~/projects/ 一级目录名沿用原项目名规则的**形状**（首尾字母数字、≤63）。
// issue #284：字符集补上 `_`——后端 sessions.js 的 validateSessionCwd 早已允许下划线（容器内用户
// 自建目录的自由命名权，存量如 `meeting_asr_app`），前端表单此前比后端更严、把 `_` 误拒。
// ⚠ 该正则**只服务「＋ 新建目录」表单**，与预览 hostname 无关（P5 起 hostname = <工位名>-p-<端口>.<伞域>，
// 项目/目录名不进域名，见迁移 0008 与 docs/design/directory-as-project.md §3）。
export const DIR_NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;

// issue #107：会话标题长度上限——与后端 sessions.updateSession 的校验口径一致（>200 → 400）。
// 前端超长时先截断再提交（不把 400 抛给用户）；`maxlength` 输入框同样按此值限长。
export const SESSION_TITLE_MAX_LEN = 200;
