// 默认语言（zh-CN）——i18n key 的权威来源（issue #101 P1；P2 补工作台全量文案，P3 补管理台）。
//
// 约定：
//   ① 新增文案一律先加在这里，再补 en.ts 对译（en.ts 用 `satisfies MessageSchema` 保证键集一致）；
//   ② 命名空间按页面/组件划分：common.*（跨页面复用）、locale.*（语言切换菜单自身）、
//      login.*（登录页）、workbench.*（工作台壳/顶栏）、sidebar.*（侧栏）、tree.*（目录树）、
//      stream.*（消息流 + SSE 事件状态行）、composer.*（输入区）、picker.*（会话浏览 modal）、
//      preview.*（文件预览 modal）、errors.*（运行时错误/兜底提示文案）、
//      admin.*（管理台：llm.* 供应商/模型区 + per-user pane、fde.* FDE 用户区）；
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
    newDirTitle: '新建目录',
    newDirLabel: '目录名（小写字母/数字/连字符）',
    newDirPlaceholder: '例如 my-project',
    newSession: '＋ 新会话',
    browse: '浏览会话',
    browseTitle: '浏览会话（Ctrl/⌘+K）',
    noSessions: '暂无会话',
    // issue #107：会话卡片内联重命名（铅笔图标按钮的 title/aria-label + 编辑框占位符；#112 改 SVG 图标）
    rename: '重命名',
    renamePlaceholder: '会话名称',
    // issue #114：「AI 改名」按钮（点击才调一次 LLM 生成标题）+ 行内 loading 提示
    aiRename: 'AI 改名',
    aiRenaming: 'AI 命名中…',
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
  // 管理台（views/AdminLayout.vue / AdminUsersView.vue / AdminView.vue + components/UserLlmPane.vue）
  // 注：服务端透传的 error.message 一律不译，仅译前端自产文案（含「错误：」前缀与 409 拒绝前缀）。
  admin: {
    title: 'FDE Station 管理台',
    backToWorkbench: '← 返回工作台',
    // 前端自产的错误前缀（拼在服务端 error.message 之前）
    errorPrefix: '错误：',
    // 供应商/模型/用户通用状态与动作
    enabled: '启用',
    disabled: '停用',
    delete: '删除',
    edit: '编辑',
    save: '保存',
    confirmDeleteTitle: '确认删除',
    expand: '展开',
    collapse: '收起',
    tabs: {
      label: '管理台栏目',
      users: '用户管理',
      llm: 'LLM 管理',
      repos: '仓库管理',
    },
    // LLM 供应商/模型区（AdminView #llmSection + UserLlmPane）
    llm: {
      sectionTitle: 'LLM 供应商',
      emptyProviders: '暂无供应商，先在下方新增。',
      // 模型明细展开按钮：{count} 为模型数量
      modelsCount: '模型明细（{count}）',
      collapseModels: '收起模型',
      emptyModels: '该供应商下暂无模型',
      colName: '名称',
      colType: '类型',
      colContextWindow: '上下文窗口',
      colMaxOutput: '最大输出 tokens',
      upstreamModelId: '上游模型 ID',
      colStatus: '状态',
      addModel: '＋ 新增模型',
      addModelTitle: '新增模型',
      providerName: '供应商名',
      addProvider: '＋ 新增供应商',
      addProviderTitle: '新增供应商',
      editProviderTitle: '编辑供应商 {name}',
      providerApiKeyLabel: '上游 API Key',
      providerApiKeyAddHint: '选填；mock 模型可留空，真实上游请填写 API key。',
      providerApiKeyEditHint: '留空保持原值不变；出于安全考虑不会回显已保存的 key。',
      editModelTitle: '编辑模型 {model}',
      editContextWindowHint: '留空保持现有值；当前 API 不支持清空该值。',
      editMaxOutputHint: '留空保持现有值不变。',
      editUpstreamModelHint: '填写 LiteLLM 使用的完整模型 ID（例如 openai/gpt-4o）；留空保持原值不变。',
      confirmDeleteProvider: '确认删除供应商 {name}？其下模型将一并删除。',
      confirmDeleteModel: '确认删除模型 {model}？',
      // per-user LLM 配置 pane（UserLlmPane.vue）
      loadingPane: '加载 LLM 配置…',
      activeRunWarn: '⚠️ 有活跃 run：更换供应商或 API key 会被服务端拒绝（影响进行中的 run）；纯模型变更不受影响。',
      providerLabel: '供应商',
      virtualKeyLabel: '当前虚拟 key：',
      mainModelLabel: '主模型',
      mainModelCapabilities: 'text · tool_calling',
      embeddingLabel: 'Embedding（可空）',
      visionLabel: 'Vision（可空）',
      notConfigured: '（不配置）',
      save: '保存 LLM 配置',
      saved: '已保存：主模型 {model}',
      provision: 'provision 容器',
      provisionDone: 'provision 完成：{container}（{network} {subnet}）',
      // 409 active_run_conflict：前缀译，其后拼服务端原因（不译）
      conflictPrefix: '已拒绝（409）：',
      forceSave: '确认无影响，强制保存',
    },
    // FDE 用户区（AdminView #fdeSection）
    fde: {
      sectionTitle: 'FDE 用户',
      emptyUsers: '暂无用户。',
      noFdeName: '无 fde_name',
      noFdeNameHint: '该用户未配置 fde_name，无需 LLM 配置。',
      searchPlaceholder: '搜索登录名、显示名或 FDE 名称',
      searchEmpty: '没有匹配的用户。',
      loadingUsers: '正在加载用户',
      createUser: '＋ 创建用户',
      colLogin: '登录名',
      colDisplayName: '显示名',
      colRole: '角色',
      colFde: 'FDE',
      colMfa: 'MFA',
      colStatus: '状态',
      colOnboarding: '开户状态',
      colLifecycle: '开户 / 下线',
      colActions: '操作',
      roleFde: 'FDE',
      roleAdmin: '管理员',
      statusActive: '活跃',
      statusDisabled: '停用',
      statusAwaitingCredential: '等待凭据',
      retryOnboarding: '重试',
      onboardingRetryQueued: '开户任务已重新排队。',
      llmBindingFailed: 'LLM 绑定失败',
      offboardingQueued: '已开始下线；账号立即停用，资源正在清理。',
      retryOffboarding: '重试下线',
      offboardingRetryQueued: '下线任务已重新排队。',
      offboardingTitle: '下线状态',
      workspacePurgeAfter: 'workspace 计划于 {date} 清除',
      onboarding: {
        pending: '开户中',
        running: '开户中',
        awaiting_credential: '待凭据',
        done: '已就绪',
        failed: '失败',
      },
      offboarding: {
        pending: '下线中',
        running: '下线中',
        done: '已下线；workspace 保留中',
        failed: '下线失败',
      },
      offboardingSteps: {
        'disable-user': '停用账号并停止 run',
        'stop-container': '停止 FDE 容器',
        'revoke-runner-token': '吊销 runner token',
        'revoke-llm-key': '吊销 LLM key',
        'delete-git-credential': '删除 Git 凭据',
        'release-network-routes': '释放网络与路由',
        'schedule-workspace-purge': '安排清除 workspace',
      },
      mfaEnabled: '已启用',
      mfaDisabled: '未启用',
      editAction: '编辑',
      enableUser: '启用',
      disableUser: '停用',
      editUserTitle: '编辑用户资料',
      editTabProfile: '资料',
      editTabSecurity: '安全',
      editTabLlm: 'LLM 与仓库',
      editTabDanger: '危险操作',
      basicProfileSection: '基本资料',
      llmSection: 'LLM 绑定',
      dangerSection: '危险操作',
      totpSection: 'TOTP 设置',
      totpSectionHint: '管理该用户的 TOTP 注册状态；重新注册会立即使旧密钥失效。',
      lastLogin: '最近登录',
      neverLoggedIn: '从未登录',
      updateProfile: '保存资料',
      profileUpdated: '资料已更新。',
      statusUpdated: '用户状态已更新。',
      resetPasswordTitle: '重置用户密码',
      resetPasswordHint: '重置后，用户需要使用新密码重新登录。',
      newPassword: '新密码',
      submitPasswordReset: '确认重置密码',
      passwordResetDone: '密码已重置，用户需要重新登录。',
      resetTotpHint: '此操作会清除用户当前的 TOTP 绑定并撤销其登录会话。',
      confirmTotpReset: '确认重置 TOTP',
      totpResetDone: 'TOTP 已重置，用户需要重新登录。',
      enrollTotp: '绑定 TOTP',
      reenrollTotp: '重绑 TOTP（旧码作废）',
      enrollTotpHint: '将为该账号生成新的 TOTP 密钥并撤销其全部登录会话。新密钥仅本次显示。',
      reenrollTotpHint: '旧密钥将立即作废，用户的全部登录会话将被撤销；新密钥仅本次显示。',
      totpEnrollDone: 'TOTP 已绑定/重绑，用户需要重新登录。',
      deleteUser: '删除用户',
      deleteUserTitle: '删除用户',
      deleteUserHint: '账号将立即停用并开始 FDE 下线；workspace 会保留配置的期限后再清除。请输入登录名 {login} 以确认。',
      deleteLoginLabel: '输入登录名确认',
      deleteLoginPlaceholder: '输入登录名',
      confirmDeleteUser: '开始下线 / 删除用户',
      randomPassword: '随机生成',
      copyFailed: '复制失败：',
      createPasswordPlaceholder: '输入密码或随机生成',
      totpSaved: '我已保存',
      copiedFeedback: '已复制到剪贴板。',
      addUserTitle: '新增 FDE 用户',
      loginLabel: '登录名',
      displayNameLabel: '显示名',
      passwordLabel: '口令',
      fdeNameLabel: 'fde_name',
      emailLabel: '邮箱',
      gitHostLabel: 'Git host',
      selectGitHost: '选择 Git host',
      noOnboardableGitHosts: '没有可用的 Git host，请先添加并启用非 Azure host。',
      llmModelSection: 'LLM 模型（必选）',
      llmCatalogError: '无法加载 LiteLLM 模型目录。请先启用或修复可选 LiteLLM profile 后再创建用户。{error}',
      retryLlmCatalog: '重试加载目录',
      loadingLlmCatalog: '正在加载 LiteLLM 模型目录…',
      noOnboardableLlmModels: '没有可用的启用中、支持 tool-calling 的文本模型。请在 LLM 管理中添加或启用模型。',
      llmProviderLabel: '供应商',
      selectLlmProvider: '选择供应商',
      llmMainModelLabel: '主模型（必选）',
      selectLlmMainModel: '选择主模型',
      llmEmbeddingModelLabel: 'Embedding 模型（可选）',
      llmVisionModelLabel: 'Vision 模型（可选）',
      llmModelNotConfigured: '（不配置）',
      totpEnabledOpt: '启用 TOTP',
      totpEnabledHint: '默认不启用；启用后需用认证器 App 扫码绑定。',
      addUser: '创建用户',
      totpTitle: '用户已创建 · TOTP 设置',
      totpEnrollTitle: 'TOTP 已绑定 · 一次性密钥',
      qrAlt: 'TOTP 认证器二维码',
      // 一次性 TOTP 盒：{login} 与 {onlyOnce} 由模板插槽加粗（见 AdminView 模板）
      totpCreated: '用户 {login} 已创建。请用认证器 App 录入以下 otpauth URI 或种子（{onlyOnce}）：',
      totpEnrolled: '用户 {login} 的 TOTP 已绑定或重绑。请录入以下新密钥（{onlyOnce}；旧密钥已作废）：',
      totpOnlyOnce: '仅此一次显示',
      otpauthUri: 'otpauth URI：',
      totpSecret: 'TOTP 种子：',
      nextStep: '请妥善保存并安全地分享 TOTP 信息。确认已保存密钥后关闭此提示。',
    },
    repos: {
      title: '仓库管理',
      empty: '暂无 Git host，先添加一个。',
      add: '＋ 新增 Git host',
      addTitle: '新增 Git host',
      editTitle: '编辑 Git host',
      name: '名称',
      provider: '提供方',
      baseUrl: 'Base URL',
      adminKey: '平台 admin key（可选）',
      adminKeyPlaceholder: 'Gitea / GitLab 管理员凭据',
      adminKeyKeep: '留空保持不变',
      adminKeyConfigured: '已配置 key：{key}',
      clearAdminKey: '清除已配置 key（改为需凭据）',
      modeAuto: '模式由提供方与 admin key 自动判定；GitHub 和未配置管理员 key 的 host 需逐 FDE 提供凭据。',
      modeMinted: '代铸',
      modeCredential: '需凭据',
      confirmDelete: '确认删除 Git host「{name}」？已分配给 FDE 的 host 不能删除。',
      selectHost: 'Git host',
      noHost: '不配置 Git host',
      credentialTitle: '录入 FDE 的 Git 凭据',
      credentialHint: '此 host 需要 FDE 本人的凭据；token 只写入该 FDE 的凭据文件，不保存到数据库。',
      credentialUsername: 'Git 用户名',
      credentialToken: 'Personal access token',
      saveCredential: '保存凭据',
      credentialSaved: '凭据已保存，FDE 账号已启用。',
    },
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
    // issue #107：侧栏内联重命名——空串本地拦截 / 提交失败回退旧标题时的轻提示
    renameEmpty: '会话名称不能为空',
    renameFailed: '重命名失败：{message}',
    // issue #114：AI 改名失败（message 为服务端文案：409 未配置 LLM / 502 上游失败）
    aiRenameFailed: 'AI 改名失败：{message}',
  },
} as const;

/**
 * 消息 schema：由 zh-CN（key 权威来源）递归推导，叶子值放宽为 string。
 * 用途：① createI18n<[MessageSchema], AppLocale> 泛型；② DefineLocaleMessage 注入（见 ../types.d.ts）。
 * 之所以放宽叶子：en 的文案字面量与 zh-CN 不同，schema 只约束键结构 + 叶子类型（string）。
 */
export type MessageSchema = WidenLeaves<typeof zhCN>;

type WidenLeaves<T> = { [K in keyof T]: T[K] extends string ? string : WidenLeaves<T[K]> };
