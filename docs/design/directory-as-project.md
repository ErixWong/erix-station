# 去项目化：目录即项目（P5）+ 文件面板（P6）

> 状态：定稿（2026-09-24，决策者拍板）。上游决策链：D8 修订（cwd 直达项目目录，AGENTS.md §7）
> 的逻辑终点——worktree 拆除后，「项目注册」的存在感只剩一个下拉框，本设计把它也拆掉。
> 参照系：pi web（session = cwd 的绑定体，项目是推导出的分组视图，零注册）。

## 1. 背景与动机

「项目注册制」的前提是「平台先于工作」，但工位现实是「工作先于平台」：agent 直接
`mkdir ~/projects/meeting_asr_app && git clone` 十秒完成，注册沦为事后补票或干脆不补，
平台视图与磁盘真实状态漂移。验尸 projects 实体承载的五项职责，仅「端口分配锚点」是硬的，
其余（会话归属、run cwd、脚手架、slot/template）均可字符串化或退役。

## 2. 核心语义（定稿）

- **容器 = 给用户的一台小电脑；目录 = 项目**。平台从治理者退为「设施提供者 + 观察者」。
- **会话 = cwd + transcript 的绑定体**：`chat_sessions.project_id` → `cwd text`
  （存 `~/projects/<name>` 相对形式）；建会话时定死，会话期内不可改绑。
- **项目列表 = 推导视图**：`DISTINCT cwd FROM chat_sessions` ∪ `~/projects/` 一级目录枚举，
  无注册实体。
- **约定升级为边界**：会话 cwd 只能是 `~/projects/` 一级目录（不做任意路径手输）。
- **同项目并行放行（pi 对齐，不锁）**：`ERIX_AGENTD_CAPACITY` 默认 1 → 2（env 可调）。
  run 数据目录/notes/transcript/artifacts 全部 per-run/per-session 隔离，同 cwd 并行
  无结构冲突；工作文件碰撞 = 用户自担（git 兜底），踩踏案例出现后再补 per-cwd 执行锁
  （纯加法；claim SQL 方案已存档于 issue 讨论）。

## 3. 端口去项目化

- `port_allocations.project_id` 退役（迁移置空/删列按最小代价）；hostname 改
  `eric-p-<port>.fde.localhost`（URL 去项目名段，顺带消灭目录名→域名段的合法化清洗）。
- `ports.json` 升 FDE 级单一文件 `~/.erix/ports.json`；Traefik 动态配置模板同步。
- dev 环境旧 URL（`eric-p-<project>-<port>`）一次性切换，不做双读过渡。

## 4. UI（决策者拍板的布局）

```
┌────────────────────────────────┬──────────────────────────┐
│ [目录 ▾ llm-smoke ●2]    [↻]   │  会话标题  📁 cwd 徽标    │
├────────────────────────────────┤──────────────────────────│
│ 会话列表（该目录）               │                          │
│  ● 修排行榜排序        13:23    │  （消息流，现状不动）      │
│  [＋ 新会话]                    │                          │
├────────────────────────────────┤                          │
│ ▸ 目录树（默认收起，拉出）       │                          │
│   懒展开：点一级出一层           │  （输入框）        [发送] │
│   点击节点暂不处理（P6）         │                          │
└────────────────────────────────┴──────────────────────────┘
```

- **目录下拉**：`~/projects/` 一级目录（portal 直读宿主机 bind mount 枚举，零容器改动）；
  下拉项带运行态徽标（`llm-smoke ●2`，跨目录活跃感知的唯一入口）；含「＋ 新建目录」。
- **↻ 单按钮双刷**：同时刷新目录下拉与目录树。
- **目录树面板**：根 = 选中目录（= 会话 cwd = jail root，三锚合一）；懒展开
  （`GET /tree?path=` 单层 API）；默认全折叠、不跨刷新记忆；点击暂不处理。
- **会话列表**：左侧竖排沿用现状组件，`WHERE cwd = 选中目录`。
- **admin 台**：项目 CRUD 退役为只读；FDE/容器管理不动。

## 5. materializer 与模板

- 项目级物化（`.gitignore` / `.erix/ports.json` / `.erix/AGENTS.md`）退役；stale
  清理会顺带移除存量项目脚手架（manifest 追踪制，安全）。
- clone 指引与端口指引并进 FDE 级 `AGENTS.md`（工位约定单点）。
- `projects.slot` / `template` 预留字段随实体一并退役。

## 6. 迁移与部署

- 迁移增量：`chat_sessions` 加 cwd 列（回填 = projects.root_path 关联值）→ 数据校验 →
  应用层切读写 → project_id 退役。现有 6 项目 / 10 会话，量小一次到位。
- agentd：`run.project.name` → `run.cwd`；`prepareProjectCwd` 语义不变（mkdir 确保）。
- 部署序：**portal 先上（新代码兼容双列过渡）→ FDE 镜像后上**。

## 7. 非目标（防蔓延）

- 不做递归浏览与任意路径手输（逐级展开是唯一导航）；
- 不做执行锁（同项目并行放行，pi 对齐）；
- 文件面板只读，不做编辑/上传；
- transcript 存储 / session key 不动（P2 定稿不推翻）；
- 不动 admin 的 FDE/容器/LLM 管理面。

## 8. P6（独立跟进，不阻塞 P5）

文件面板点击预览：代码高亮 / Markdown 渲染 / 图片直显 + git 变更标记 +
run 终态自动刷新（SSE 已有终态事件）。实现通道 = portal 读 bind mount，只读，
边界 = 会话 cwd。

## 9. 补记（issue #284）：目录名不再受「域名段」约束

§3 的「URL 去项目名段」有个常被忘掉的推论：**目录名自此不进 hostname**（hostname =
`<工位名>-p-<端口>.<伞域>`，迁移 `0008-deprojectize.sql`），于是「DNS label / 合法域名段」不再是
目录名的约束来源——`projects` 表那条 `PROJECT_NAME_RE` 只服务已退役、只读的 `projects` 表。
目录名在服务端的唯一硬边界是「`~/projects/` 一级目录 + 无路径穿越」（`sessions.js` 的
`CWD_RE` / `validateSessionCwd`：只拒 `.` / `..` / 控制字符，字符集与长度不限，下划线天然合法）。
前端「＋ 新建目录」表单的 `DIR_NAME_RE` 是**另一层更严的、只管新建**的便利校验（issue #284 已补上
`_`，与后端对齐）；存量目录（哪怕含其它字符）始终可以在目录下拉里直接选中使用。
