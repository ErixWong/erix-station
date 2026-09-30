// 默认语言（zh-CN）——i18n key 的权威来源（issue #101 P1；P2 补工作台全量文案）。
//
// 约定：
//   ① 新增文案一律先加在这里，再补 en.ts 对译（en.ts 用 `satisfies MessageSchema` 保证键集一致）；
//   ② 命名空间按页面/组件划分：common.*（跨页面复用）、locale.*（语言切换菜单自身）、
//      login.*（登录页）、workbench.*（工作台壳/顶栏）、sidebar.*（侧栏）、tree.*（目录树）、
//      stream.*（消息流 + SSE 事件状态行）、composer.*（输入区）、picker.*（会话浏览 modal）、
//      preview.*（文件预览 modal）、errors.*（运行时错误/兜底提示文案）；
//   ③ `as const` 保留字面量类型，供 vue-i18n 泛型与 DefineLocaleMessage 推导 key 类型；
//   ④ 语言名（locale.zhCN / locale.en）用母语自名（endonym），两种语言下取值相同，不随当前 locale 翻译；
//   ⑤ 插值片段（stream.event.dash / paren）是「可选后缀」的载体：调用方按条件传空串占位，
//      zh 与 en 各自决定后缀的形态（全角/半角括号、破折号间距）。
//   ⑥ 代码注释一律保持中文原文（注释不是用户可见文案，不进 i18n）。

export const zhCN = {
  // 跨页面复用骨架
  common: {
    copy: '复制',
    copied: '已复制',
    close: '关闭',
    loading: '加载中…',
    retry: '重试',
    cancel: '取消',
    create: '创建',
    // 会话默认标题（后端未生成标题时展示）
    unnamedSession: '未命名会话',
    // 会话运行态徽标（侧栏列表项 / 会话浏览 modal）
    runningBadge: '● 运行中',
    // 空态/占位
    emptyDir: '（空目录）',
    noDir: '（无目录）',
    createFirstDir: '先创建目录',
    // 平台管理员引导（侧栏空态 / 消息流空态 / composer 占位符共用）
    adminConsole: '管理台',
    logout: '登出',
    platformAdminHint: '平台管理员：请到管理台创建 FDE 用户与分配资源',
    goToAdmin: '进入管理台',
  },
  // 语言切换菜单自身文案
  locale: {
    label: '语言',
    zhCN: '中文',
    en: 'English',
  },
  // 登录页（views/LoginView.vue）——覆盖该视图全部用户可见文案。
  // 注意：登录失败/校验失败的提示来自服务端 error.message（auth store 原样透传），不在前端翻译范围内。
  login: {
    title: 'FDE Station 登录',
    loginName: '登录名',
    password: '口令',
    next: '下一步',
    totpHint: '输入认证器 6 位码（本地账号两步登录）。',
    totpLabel: 'TOTP',
    totpSubmit: '验证并登录',
    backToLogin: '← 返回重新登录',
  },
  // 工作台壳（views/WorkbenchView.vue 顶栏 + workbench store 的展示文案/通知）
  workbench: {
    nav: '☰ 导航',
    openNavigation: '打开导航',
    // who 拼接：login（role / fde_name）；无 fde_name 时用 whoNoFde（en 侧改半角括号）
    who: '{login}（{role} / {fde}）',
    whoNoFde: '{login}（{role}）',
    cwdCopyTitle: '{cwd}（点击复制）',
    toLatest: '↓ 最新',
    resizeSidebar: '调整侧栏宽度',
    // composer 占位符（store.inputPlaceholder 计算属性）
    inputPlaceholder: '输入任务，Enter 发送（Shift+Enter 换行）',
    // synthetic 消息前缀（store.addMessage 拼接）
    systemInjection: '〔系统注入〕{content}',
    // 停止请求已发出（消息流分隔行）
    stopRequested: '已请求停止…',
    // 桌面通知（run_end 且页面在后台）
    notifyFailed: '运行失败：{code} — {message}',
    notifyEnded: '运行结束：{reason}',
    notifyDone: '运行完成',
  },
  // 侧栏（components/SidebarPanel.vue / DirSelect.vue）
  sidebar: {
    dirLabel: '目录',
    newDirOption: '＋ 新建目录',
    refreshTitle: '刷新目录列表与目录树',
    newDirLabel: '目录名（小写字母/数字/连字符）',
    newDirPlaceholder: '例如 my-project',
    newSession: '＋ 新会话',
    browse: '浏览会话',
    browseTitle: '浏览会话（Ctrl/⌘+K）',
    noSessions: '暂无会话',
  },
  // 目录树面板（components/DirectoryTree.vue）
  tree: {
    title: '目录树',
    selectDirFirst: '先选择目录',
  },
  // 消息流（components/StreamPanel.vue）+ SSE 事件状态行（composables/useEventStream.ts）
  stream: {
    chooseOrNewSession: '选择或新建会话',
    // 工具卡片单行摘要兜底（参数 JSON 尚未成形）
    argsPending: '（参数生成中…）',
    // 工具卡片 dig 兜底（tool_call_delta 阶段，args 仍在流式生成）
    argsStreaming: '（参数流式生成中…）',
    event: {
      resync: '事件流需重同步（{why}），正在重连补发…',
      resyncBufferOverflow: '服务端缓冲溢出',
      attempt: 'round {round} · 尝试 {attempt}/{max}',
      recovering: '重试中（{attempt}/{max}）',
      recovered: '重试成功',
      judgePassThrough: 'judge：放行（{mode}）',
      judgeExtend: 'judge：扩轮{dash}{paren}',
      judgeNoExtend: 'judge：不扩轮{dash}',
      judgeAction: 'judge：{action}{dash}',
      compaction: '上下文折叠（round {round}）：{folded} 轮折叠，{before} → {after} tokens',
      finalGuard: 'final guard：{action}{dash}',
      forcedFinal: 'forced final（round {round}）：{reason}',
      runEnd: 'run 结束：{reason}{usage}',
      runEndNormal: '正常完成',
      runFailed: 'run 失败：{code} — {message}',
      // 工具卡片结果行（tool_result：ok/err 标记 + 摘要 + 耗时）
      toolResult: '{mark} {digest}（{ms}ms）',
      // 可选后缀片段（调用方按条件传空串占位）
      dash: ' — {value}',
      paren: '（{value}）',
    },
  },
  // 输入区（components/ComposerBar.vue）
  composer: {
    send: '发送',
    stop: '■ 停止',
  },
  // 会话浏览 modal（components/SessionPickerModal.vue）
  picker: {
    title: '浏览会话',
    scopeLabel: '会话范围',
    currentDir: '当前目录：{name}',
    currentDirTitle: '当前目录：{cwd}',
    noDirSelected: '未选择目录',
    allDirs: '全部目录',
    listLabel: '会话列表',
    empty: '该范围暂无会话',
    staleListKept: '（旧列表已保留）',
  },
  // 文件预览 modal（components/FilePreviewModal.vue）
  preview: {
    title: '预览 {path}',
  },
  // 运行时错误/兜底提示（api.ts + workbench store + 目录树）
  errors: {
    requestFailed: '请求失败（HTTP {status}）',
    sessionLoadFailed: '会话加载失败，可刷新重试',
    createSessionFailed: '建会话失败：{message}',
    stopFailed: '停止失败：{message}',
    dirNameInvalid: '目录名必须符合：小写字母/数字/连字符，且不能以连字符开头或结尾（最多 63 个字符）',
    sendFailed: '发送失败：{message}',
    // issue #41：LLM 未绑定预检 409 → 友好指引（fde 角色可能无 /admin 权限 → 措辞兜底「联系管理员」）
    sendFailedLlmNotConfigured: '发送失败：该 FDE 未配置 LLM 上游，请到管理台 /admin 配置（无权限请联系管理员）',
    // 拼在 sendFailed 之后的可选后缀（zh 全角括号、en 前置空格 + 半角括号）
    runInProgress: '（已有进行中任务）',
    treeLoadFailed: '目录树加载失败：{message}',
  },
} as const;

/**
 * 消息 schema：由 zh-CN（key 权威来源）递归推导，叶子值放宽为 string。
 * 用途：① createI18n<[MessageSchema], AppLocale> 泛型；② DefineLocaleMessage 注入（见 ../types.d.ts）。
 * 之所以放宽叶子：en 的文案字面量与 zh-CN 不同，schema 只约束键结构 + 叶子类型（string）。
 */
export type MessageSchema = WidenLeaves<typeof zhCN>;

type WidenLeaves<T> = { [K in keyof T]: T[K] extends string ? string : WidenLeaves<T[K]> };
