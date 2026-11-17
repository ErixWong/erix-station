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
    // 顶栏「管理台」入口（role==='admin' 者可见；#332 后能站上工作台的 admin 必然同时有工位）
    adminConsole: '管理台',
    logout: '登出',
    // issue #332：`platformAdminHint` / `goToAdmin` 两句已删——无工位的平台管理员被路由守卫
    // 直接送进管理台，上两句在工作台上永久不可达（不留「以防万一」的死文案）。en.ts 同步删。
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
    workbenchEntrySeatlessAdmin: '这个账号是没有工位的平台管理员，工作台没有可用功能。请到管理台登录。',
    goToAdminConsole: '前往管理台 →',
    adminEntryFdeOnly: '当前账号不是管理员，不能在这里登录。请用上面的工作台链接到 FDE 工作台登录。',
    adminEntryNotice: '这是管理台入口，仅供管理员使用。两个入口的登录状态互不相通（安全隔离），需要在各自入口分别登录。',
    adminEntryWorkbench: '前往 FDE 工作台 →',
    title: 'FDE Station 登录',
    loginName: '登录名',
    password: '口令',
    next: '下一步',
    totpHint: '输入认证器 6 位码（本地账号两步登录）。',
    totpLabel: 'TOTP',
    totpSubmit: '验证并登录',
    backToLogin: '← 返回重新登录',
    // issue #449：第二步的另一条通道——邮箱验证码（portal.md §2.2/§2.3a/§2.3b）。
    // 措辞口径：只说「第二因素（邮箱验证码）」，**不写**「双因素强认证 / 防钓鱼」（前端不替后端承诺强度）。
    emailStepTitle: '输入邮箱验证码',
    emailStepHint: '验证码已发送到 {email}（第二因素）。没收到可以重发。',
    emailCodeLabel: '验证码',
    // 2026-11-10 用户要求「10 分钟有效这个写到 web 页面上」：分钟数来自服务端 `email_code_ttl_seconds`
    // （`EMAIL_CODE_TTL_SECONDS` 可覆盖），**前端不写死 10**；服务端没给 ⇒ 整句不渲染。
    emailCodeTtl: '验证码 {minutes} 分钟内有效。',
    emailCodeSubmit: '验证并登录',
    emailResend: '重发验证码',
    emailResendIn: '{seconds} 秒后可重发',
    emailResendFailed: '重新发送',
    emailBackToPassword: '← 返回上一步',
    // issue #449 二选一（`second_factor_choice`）：TOTP 与邮箱码并存时的入口，与降级说明。
    // 工单 feat-261110-01：旧的两行小字链接（useEmailCode / useTotp）已删，由下面的**两档 switch** 取代。
    // 口径：档名只说通道本身，不承诺强度；「已发到哪邮箱」直接复用上面的 emailStepHint，不另造近义键。
    factorSwitchLabel: '第二因素方式',
    factorTotp: '验证器应用',
    factorEmail: '邮箱验证码',
    // 懒发信（feat-261110-01）：切到邮箱档才发第一封，这段等待期输入框是禁用的，得说清在干什么。
    emailSending: '正在发送验证码…',
    emailChannelUnavailable: '邮件通道当前不可用，请使用验证器应用。',
  },
  // #255 首登强制改密（views/ForcePasswordChangeView.vue）：受限会话（portal.md §2.11a）的唯一出口界面文案。
  // 约束：不硬编码端口/域名（部署形态可变、docs/api/portal.md §2.5 cookie 口径与 host 无关），
  // 也不承诺口令最小长度（后端 §2.9.4 现状无该规则，前端不得先于后端承诺）。
  forcePassword: {
    title: '请先修改初始口令',
    intro: '你的口令由管理员代为设置，还没经过你本人之手。改好新口令之前，平台功能保持锁定。',
    currentLabel: '当前口令',
    newPasswordLabel: '新口令',
    confirmPasswordLabel: '确认新口令',
    submit: '修改口令',
    submitting: '修改中…',
    mismatch: '两次输入的新口令不一致',
    incomplete: '请填写当前口令和新口令',
    // 失败态文案：① 留下的 `serverError` / `genericError`（把 code/message 原样拼一句）已被
    // 下面的 `errors.*` 映射表整取代码（码 → 可行动文案），不在 locale 里留旧键免得后人以为还有两条链路。
    // 会话语义（§2.6a）：自助改密保留当前会话、只吊销其它会话 ⇒ 不要写成「需要重新登录」。
    sessionHint: '改密后本次登录继续有效，你在别处登录的会话会失效。',
    logout: '换个账号 / 退出登录',
    // #255 前端 ②：**错误码 → 可行动文案**映射表（portal.md §1.2 / §2.6a / §2.11 / §2.11a）。
    // 每条只写「下一步做什么」；服务端原文与错误码由 `detail` 统一附在句尾（error.message 不在前端翻译范围）。
    // 键名 = 服务端 `error.code`（`unknown_code` / `no_*` 是前端自造的兜底键，不对应任何码）。
    errors: {
      // 401 invalid_credentials：§2.6a 明确「与登录失败同一个码」⇒ 与 401 unauthorized 只能靠 code 区分，
      // 状态码映射绝不能盖过 code 映射（否则输错旧口令会被当成会话过期踢回登录页）。
      invalid_credentials: '「当前口令」不对：请重新输入你现在正在用的那一枚（不是准备换上的新口令）；想不起来就点下面的「换个账号 / 退出登录」，请管理员重新代设一枚。',
      validation_failed: '「{field}」这一项没通过校验：请按说明改好这一项再提交。',
      // 401 unauthorized：会话没了 ⇒ 改密屏已经没有能改密的会话，唯一出路是重新登录（行为见 action=relogin）。
      unauthorized: '本次登录已过期：改密需要一枚有效会话，请点下面的「换个账号 / 退出登录」回到登录页重新登录。',
      forbidden: '当前账号不能执行这次改密：请联系管理员确认账号状态后重试。',
      // 403 cross_origin_forbidden（#234 同源防线，§2.11）：与 forbidden 的差别是「没资格发这个请求」。
      cross_origin_forbidden: '浏览器把这次提交判定为跨站请求，已被同源防线拦下：请在浏览器地址栏里直接打开本站页面后重试，别从其它站点内嵌的窗口里改密。',
      // 405：§2.11a 特意让本端点「不限方法」，就是为了让它不被门改写成 403 ⇒ 见到 405 说明方法在半路被改。
      method_not_allowed: '这个接口只接受 POST：请求方法多半被代理或缓存改写了，请强制刷新页面后重试，仍然失败就把下面这行错误码交给管理员。',
      // 429 / 503 都带 Retry-After（§2.6a）：等待秒数由 {seconds} 注入；缺头时退到 *_no_retry 键。
      rate_limited: '改密尝试太频繁，已被临时限流：请 {seconds} 秒后再提交，期间反复点只会更久。',
      rate_limited_no_retry: '改密尝试太频繁，已被临时限流：请等一会儿再提交，期间反复点只会更久。',
      kdf_busy: '服务器正忙（口令派生的并发闸已满，一次改密要跑两次 scrypt）：这不是你的口令有问题，请 {seconds} 秒后重试。',
      kdf_busy_no_retry: '服务器正忙（口令派生的并发闸已满）：这不是你的口令有问题，请稍后重试。',
      internal: '服务端出错，这次改密没写成：请稍后重试一次，仍然失败就把下面这行错误码原样交给管理员。',
      // 409 `llm_model_not_found`（#289 切片 B2，§1.2 / §4.3）：绑定的 `model_info.id` 在网关里已不存在
      // （模型被删/重建 ⇒ id 变）。与 `forbidden` 的差别：不是没权限，而是**配的那东西没了**；
      // 解法只有一个（管理员在管理台重新选模型），故文案不带参数（`resolveErrorCode` 不给本键注参数）。
      llm_model_not_found: '绑定的模型已在 LLM 网关里被删除或重建：请到管理台 /admin 重新选择该槽位的模型后重试（无权限请联系管理员）。',
      // 未知码兜底：**不许静默成通用错误**，必须把 code 与 HTTP 状态码原样带出来供报障。
      unknown_code: '未收录的错误（HTTP {status}，错误码 {code}）：请重试一次，仍然失败就把上面这行状态码与错误码原样交给管理员。',
      // 统一附在句尾的原始证据（服务端 message 原样透传，不翻译）。
      detail: '服务端说明：{message}（错误码 {code}）',
      // 401 把人送回登录页后，登录页顶部要能解释「为什么被送回来」（措辞不再指改密屏上的按钮）。
      sessionExpiredNotice: '登录已过期：本次改密没有生效，请重新登录后再改一次（口令没有被改掉）。',
      no_message: '服务端未给出说明',
      no_code: '无错误码',
      // validation_failed 的 `error.details.field`（§4.7a 口径：把错误指到具体输入框）。
      field: {
        current_password: '当前口令',
        new_password: '新口令',
        confirm_password: '确认新口令',
        // 契约只保证 field 是字段名；出现没见过的名字（含非字符串）就原样带出来并明说认不出。
        other: '{field}（未收录的字段名）',
        // details 里根本没带 field（或 field 是空串）：不许渲染成空引号「」。
        missing: '未指明字段',
      },
    },
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
    // issue #595：顶栏进能力市场的入口（views/MarketView.vue，路由 #/market）。
    marketEntry: '市场',
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
    newDirLabel: '目录名（小写字母、数字、下划线、连字符；不能以连字符或下划线开头/结尾；最长 63 字符）',
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
    // issue #197：会话列表项副行的每会话消息数（口径同头部状态行：全量 messages 行含 synthetic）
    messageCount: '{count} 条消息',
    // issue #488：会话「隐藏」。**D1：界面一律用「隐藏」，不许出现「删除/delete」字样**
    //（tooltip、aria-label、确认文案、键名全算）——后端 DELETE /api/sessions/:id 写的是 status='archived'，
    // 账本（transcript / runs / messages / run_events）一个字节都不动，叫「删除」就是在撒谎。
    hide: '隐藏',
    hideBusy: '隐藏中…',
    hideConfirm: '隐藏这个会话？',
    hideConfirmOk: '确认隐藏',
    // **D2 的唯一补救提示，不是装饰**：全仓没有 unarchive 端点、listSessions 也不带 include_archived
    // ⇒ 隐藏后界面上找不回来。这句话必须出现在确认态里，否则用户会以为能从哪儿 Undo。
    hideConfirmNote: '隐藏后它不会再出现在列表里，界面上找不回来；如需找回请联系管理员。',
  },
  // 目录树面板（components/DirectoryTree.vue）
  tree: {
    title: '目录树',
    selectDirFirst: '先选择目录',
    // issue #472：上传（`POST /api/files/upload`）。文案覆盖工单要求的八项：按钮 / 上传中 / 成功 /
    // 失败 / 覆盖确认 / upload_disabled / 超限 / 断流。
    upload: {
      button: '上传',
      hint: '上传文件到当前目录（需管理员为该账号开启「文件上传」）',
      busy: '上传中…',
      success: '已上传 {count} 个文件',
      allSkipped: '未上传（{count} 个已存在的文件都选了不覆盖）',
      overwriteConfirm: '「{name}」已经存在。要用上传的版本覆盖它吗？（覆盖会丢掉磁盘上的现有内容）',
      errDisabled: '这个账号没有上传权限：请让管理员在管理台的用户编辑里开启「文件上传」。',
      errTooLarge: '文件超过单文件大小上限（FILE_UPLOAD_MAX_BYTES）。',
      errInterrupted: '上传中断了（网络或页面被切走），重试即可。',
      errNoDir: '目标目录不存在了：先 ↻ 刷新目录树。',
      errGeneric: '上传失败（HTTP {status}）。',
    },
  },
  // 消息流（components/StreamPanel.vue）+ SSE 事件状态行（composables/useEventStream.ts）
  stream: {
    chooseOrNewSession: '选择或新建会话',
    // 工具卡片单行摘要兜底（参数 JSON 尚未成形）
    argsPending: '（参数生成中…）',
    // 工具卡片 dig 兜底（tool_call_delta 阶段，args 仍在流式生成）
    argsStreaming: '（参数流式生成中…）',
    // issue #188：助手推理块标题（与正文分离、默认收起、可展开）
    reasoning: '推理过程',
    // issue #189：折叠段（compaction）横幅：独立分隔条样式 + 摘要默认收起 + 查看原文（只读懒加载）
    folded: {
      // #375：横幅只说轮范围。原先那个「N 条」取自投影 `meta.foldedPayloadMessages`，而 erix-agent
      // 0.25.0（erix-agent#461）之后它的语义变成「本条记录携带的归档条数」（会话级去重 + 夹断之后），
      // 长会话上会明显偏小 ⇒ 再说「已压缩 N 条」就是说假话。缺 range 的存量行才退回条数口径。
      range: '已压缩第 {from}–{to} 轮',
      countOnly: '已压缩 {count} 条消息',
      bare: '已压缩',
      // D 片（issue #392）：可见性说明。标题只回答「压缩了什么」，这一行回答「现在谁看不见它」——
      // 折叠之后原文对模型不再逐字可见，只剩摘要；而「有没有摘要」直接决定这句话是安慰还是空头
      // 支票，所以必须两态。`hasSummary` **键缺席**（旧 DTO）⇒ 整行不渲染，延续 #390-A「键缺席=不知道」
      // 那一条纪律：宁可不说，也不拿旧数据凭空断言「这次没摘要」。轮数只在有 `foldedRoundRange` 时报；
      // 拿 `foldedPayloadMessages` 报轮数是 #375 已经定过性的假话（那玩样儿是归档条数）。
      visibility: '这 {n} 轮原文对模型已不再逐字可见；下面这份摘要就是它留下的全部。',
      visibilityNoSummary: '这 {n} 轮原文对模型已不再逐字可见；本次没有生成摘要，要看原文请点「查看原文」。',
      visibilityBare: '这部分原文对模型已不再逐字可见；下面这份摘要就是它留下的全部。',
      visibilityNoSummaryBare: '这部分原文对模型已不再逐字可见；本次没有生成摘要，要看原文请点「查看原文」。',
      // issue #440：**三态**的前两态（数据来自账本 `foldedFacts`，不是 `hasSummary`）。
      // 第一态必须把「LLM 语义摘要」说出口：fold-llm 把 `record.summary` 写成字面量 "missing"，
      // 旧实现据此说「本次没有生成摘要」——而账本里明明躺着 2048 B 语义摘要，那是 #440 的原文病症。
      visibilityLlm: '这 {n} 轮原文对模型已不再逐字可见；留下的是 LLM 语义摘要（fold-llm），完整细节请看原文。',
      visibilityLlmBare: '这部分原文对模型已不再逐字可见；留下的是 LLM 语义摘要（fold-llm），完整细节请看原文。',
      // 第二态：只有机械替代物（fold-statistical）。如实说「没有 LLM 语义摘要」，不把它包装成语义摘要。
      visibilityMechanical: '这 {n} 轮原文对模型已不再逐字可见；本次只留下机械替代物（fold-statistical），没有 LLM 语义摘要，细节请看原文。',
      visibilityMechanicalBare: '这部分原文对模型已不再逐字可见；本次只留下机械替代物（fold-statistical），没有 LLM 语义摘要，细节请看原文。',
      // 「摘要被夹断」标记（账本 `truncated:true`）——挂在同一行末尾，零新增 UI 结构。
      summaryTruncated: '（摘要过长，已被夹断；完整内容请点「查看原文」。）',
      viewOriginal: '查看原文',
      // #388：原文块自己的收起入口（只隐藏、不清缓存，再展开不重发）
      collapseOriginal: '收起原文',
      // 原文只读展示
      originalEmpty: '（无文本内容）',
      // #384：一个 turn 在账本里有四类内容（`text` / `reasoning` / `toolCalls[]` / user 身份），旧实现只画
      // `text` ⇒ 真的干了活的那几轮（只有思考 + 工具调用）整片渲染成上面那个占位符（真机 round 100 的
      // 112 条里 40 条如此）。现四类都画，占位符语义收窄成「四类真的都空」。
      originalRoleUser: '用户',
      originalTool: '🔧 {name}｜{args}',
      originalToolFailed: '（失败）',
      // #375：404 语义已收窄成「range 与归档两条路都拿不出正文」。旧文案那句「上游未保留折叠前载荷」
      // 在 0.25.0 之后会在数据完好时说假话（差分被去重吸空也会走这条）。
      originalMissing: '这一段没有可显示的原文（账本里也没有）',
      // 归档只是差分/被夹断：用后端 `truncated` 布尔位判，条数取 `dropped_messages`
      //（只给布尔、截断标记由前端出，同 §4.4a-1 口径）。
      originalTruncated: '本次归档被截断（另有 {count} 条未单独存档），以下为按轮号从账本补齐的原文',
      originalError: '原文加载失败：{message}',
    },
    // issue #189（追加）：当前会话头部状态行「N 条消息 · 已压缩 M 次」+ 克制提示（仅 M≥1）
    sessionStats: '{count} 条消息',
    sessionStatsCompacted: '已压缩 {count} 次',
    sessionCompactionHint: '上下文已开始压缩；如需保留完整细节，建议新开会话',
    // #451（compactionStats 观测面）：会话头部的**本会话累计**压缩行。
    // 为什么单独一行而不并进上面那句：上面那个 folded 是「本页 DTO 里带 folded 字段的消息数」，
    // 口径不同（那是投影里看得见的折叠横幅条数，这是引擎逐轮写的层统计）；两个数并列会互相矛盾。
    // 措辞钉住两件事：① 是本会话累计（不是本次 run）；② 压缩是正常工作，不是故障（不红、不警告）。
    sessionCompactionSummary: '本会话压缩：{parts}',
    sessionCompactionLayer: '{layer} {count} 次',
    sessionCompactionLayerSaved: '{segment}（省 {saved} token）',
    sessionCompactionHintTitle: '累计自 {rounds} 轮统计，最近一次在第 {last} 轮',
    sessionCompactionHintTitleNoRound: '累计自 {rounds} 轮统计',
    // 层名（键 = 引擎 `COMPACTION_PIPELINE` 的 id；顺序由前端 lib 定，不靠对象键序）
    // 层名自带「折叠」二字：计数单位是「次」（TTL 折的是工具结果、窗口折的是整轮，都不是「条消息」，
    // 说「次」才两边都真）。模板因此只留 `{layer} {count} 次`，中文不必在标签后硬塞一个空格。
    sessionCompactionLayers: {
      ttl: 'TTL 折叠',
      slidingWindow: '窗口折叠',
      foldStatistical: '统计折叠',
      foldLlm: '策略折叠',
      anchors: '锚点折叠',
      enforceSize: '裁剪折叠',
    },
    // 试用台账 #10：更早消息分页入口（后端一直分页，前端此前从不取更早批次）。
    loadOlder: '加载更早消息',
    loadOlderLoading: '正在加载…',
    // issue #300：被停止/失败的 run 零助手锚点 ⇒ 正文区本来一片空白；历史端点把已生成的
    // assistant_delta 聚合成一条合成项下发。**中性口径**：既不说「已完成」（它没完成）也不说
    // 「错误」（半截正文不是错），zh 语义必为「已中止 · 部分输出」。
    partialOutput: {
      label: '已中止 · 部分输出',
      truncated: '输出在停止前未生成完全（已截断）',
      // issue #502 形态 M（#278 底线）：这次 run **一个字都没留住**（无 assistant 锚点，
      // `round_end.final_text` 与 `run_end.partial_text` 两处都空）⇒ 历史投影给一条占位合成项，
      // 界面出一行**中性**提示而不是空气泡。措辞不许写成故障（不是红色 .syserr 行）。
      placeholder: '这段输出的正文没能留存（中止时未落库），下面按终态继续。',
    },
    // mermaid 图块（参考 pi-web MermaidBlock）：预览/源码切换按钮文案与渲染失败提示
    mermaid: {
      preview: '预览',
      source: '源码',
      error: '图表渲染失败（语法错误），以上展示源码',
    },
    event: {
      resync: '事件流需重同步（{why}），正在重连补发…',
      resyncBufferOverflow: '服务端缓冲溢出',
      // issue #502 形态 M：这里原本的 `partialOutputLost` **是故意删掉的**：SSE 快照帧已不带占位
      //（后端在缓冲为空时**根本不发帧**），那行分隔行再也响不响；「正文没留住」这行现在由历史投影
      // 走 `stream.partialOutput.placeholder`。（旧文案尾巴「…后端帧 `source:'none'` + `placeholder:true`，
      // 中性分隔行不是错误」一并删除；本次跑不依赖它。）
      attempt: 'round {round} · 尝试 {attempt}/{max}',
      // issue #288（缺陷 B）：worker 被宿主杀掉并重排（之前用户只看到同一个工具卡片亮 3 次，
      // 最后拿一句没原因的 attempts exhausted）。载荷是 portal 在 release-requeue 分支合成的：
      // {attempt, max_attempts, reason, killed_by, silent_ms?}。**{silent} 是可选后缀片段**，
      // 调用方没时长时传空串（同 dash/paren 口径），所以本文案不得依赖 {silent} 非空。
      attemptKilled: '第 {attempt}/{max} 次尝试被终止（{cause}），已重排等待重试{silent}',
      // killed_by 只认这两个值（docs/api/portal.md §5.3）；键名用上报值原文，不 camelCase。
      attemptKilledCause: {
        watchdog: '执行期静默超时，被看门狗终止',
        crash: 'worker 非预期退出',
      },
      // 静默时长后缀：单位由 lib/toolSummary.formatDuration 连着数值一起给（文案不自带 ms）。
      attemptKilledSilent: '（静默 {dur}）',
      // killed_by 是 additive 字段：未知/缺失时的兼容文案（不得出现 [object Object] / undefined）。
      attemptKilledUnknown: '原因未知',
      // issue #288（缺陷 C）：崩溃恢复时引擎把「有 tool_use、无 tool_result」的挂起工具**不再
      // 自动重放**（runner 传 `replayPolicy: 'per-tool-declaration'`），是否重试交回模型。中性文案：
      // 不重放 ≠ 失败（工具卡片已由成对的 tool_result 亮成失败），所以走灰色分隔行而不是错误行。
      // {tool} 是**可选后缀片段**（同 attemptKilledSilent 口径）：工具名不可信时调用方传空串。
      toolReplaySkipped: '工具执行被中断，未重放，由模型决定是否重试{tool}',
      // 工具名后缀：名字来自 payload（引擎透传，属外来数据），脏值在调用方已被 typeof 守卫拦掉。
      toolReplayTool: '（{name}）',
      // issue #371-A：引擎 `persistence_error{fatal:false}`（erix-agent#461 起）——落盘失败但**不终止
      // 本次任务**（剥掉的是折叠归档，原文仍在各轮记录里，#375 负责取回）⇒ 中性分隔行，不用红色。
      // 致命的那条（`fatal:true` 或旧版无字段）不在这里刷，由 `run_end` 的 `persistence_failed` 红面负责。
      persistenceDegraded: '落盘降级：{operation} 记录未存入（本次任务不受影响）',
      // issue #421：引擎承诺、本站以前订不到的 4 类诊断事件（均为**中性分隔行**，不刷红——
      // 它们说的是“配置没生效 / 能力缺失 / 这批没入账”，不是“本轮失败”）。
      strategyFallback: '压缩未使用配置的策略：引擎兜底 sliding-window（整轮丢弃、不摘要，第 {round} 轮起）',
      metadataMissing: '模型上下文元数据缺失：本次 run 的压缩与聚合输出预算已关闭',
      capabilityDegraded: '存储端缺少 {method} 能力：本次 run 对应的持久化被跳过（中途崩溃不可恢复）',
      resumeJournalSkipped: '崩溃轮的 {count} 条工具结果未入账（第 {round} 轮），下次恢复将依赖快照',
      resumeJournalSome: '若干',
      // issue #438 切片 B（erix-agent 0.29.0）：`LoopEvent` 新增的两类**展示类**诊断事件。
      // 数字没给就 `?`（#283）、外来标识符过形状闸（#261）——调用方已归一，文案不得再编数。
      compactionDeferred: '本轮未折叠：请求尾部是未结清的工具调用（第 {round} 轮，{reason}），下一轮再折',
      budgetBelowWorkingSet: '折叠后仍超预算：工作集 {workingSet} tokens > 预算 {budget} tokens（连续 {attempts} 次），本次 run 提前收尾；引擎建议预算 ≥ {suggested}',
      // issue #442（erix-agent 0.30.0）：`LoopEvent` 27 类里唯一「进时间线」的新类型。它是随后那次上游 400
      // 的**唯一归因信号**，所以用中性分隔行（不是红面：「请求已原样发出」不是「本轮已失败」）。
      userTurnGuardUnrecoverable: '请求视图仍缺 user 轮（回补全失败，第 {round} 轮，{channel}/{reason}）：请求已原样发出，上游可能拒绝它',
      recovering: '重试中（{attempt}/{max}）',
      recovered: '重试成功',
      // issue #321（erix-station）：judge 永远只是**意见**，不是验收——分轴展示（工具审计 / 目标判断 /
      // 方向 / 扩轮是不同维度，可同时非空，不做三个互斥态）。「已完成」唯一来源是 run 终态分隔行
      //（run_end）；本站 runner 不传 finalGuard ⇒ verification 恒 skipped，本组文案一律不得出现
      //「已核验 / 已验证」这类承诺。axes 之间用「 · 」由调用方拼接。
      judgeAxes: 'judge：{axes}',
      // 轴一 · 工具审计：executed 的语义是「本次工具调用被放行」，不是任务完成（ISSUES.md 第 4 条放大器）。
      judgeAuditExecuted: '工具审计：已放行（非任务完成）',
      judgeAuditPassThrough: '工具审计：已放行（{mode}，非任务完成）',
      judgeAuditBlocked: '工具审计：已拦截（本次工具调用未执行）',
      // extend / extend+redirect / decline_extend 是扩轮处置而非审计结论（实测存在 kind=intercept 而
      // action=extend+redirect、真实审计为拦截的情形）⇒ 从这类 action 反推「工具已执行」会被骗，
      // 工具是否真的执行以**工具卡片**为准，这里只做中性说明。
      judgeAuditUndecided: '工具审计：结果未知（{action}），执行与否以工具卡片为准',
      // 轴二 · 目标判断：done=true 固定为「评审认为目标已达成（未独立核验）」并声明收尾由模型自判
      //——「任务主体完成但还有扫尾工作」是合法状态，不许写成「已完成」。confidence 仅有限数才透出。
      judgeGoalDoneTrue: '评审认为目标已达成（未独立核验；是否收尾由模型自行判定）',
      judgeGoalDoneFalse: '评审认为目标未达成',
      judgeConfidence: '（置信度 {confidence}）',
      judgeReason: '评审理由：{value}',
      // 轴三 · 方向：on_track 是常态不刷屏；uncertain / off_track 不得被 passThrough/extend 分支遮掉。
      judgeDirectionOffTrack: '方向：可能偏离',
      judgeDirectionUncertain: '方向：不确定',
      // 轴四 · 扩轮意见（来自 decision.extend；不虚构 tier、不做成本估算，那些属 #282）。
      judgeExtendSuggest: '建议扩轮',
      judgeExtendDecline: '不建议扩轮',
      // 中性降级：评审调用失败（degraded）与引擎新增的未知 action——灰色 judge 面板行，不刷红、不解读。
      judgeDegraded: '评审降级（{error}），本轮未给出意见',
      judgeUnknownAction: '评审动作：{action}',
      judgeNoDetail: '评审事件（无可解读细节）',
      compaction: '上下文折叠（round {round}，策略 {strategy}）：{folded} 轮折叠，{before} → {after} tokens{degrade}',
      // #464 A：策略名是引擎写实例上的那个名字（含库层兜底 `sliding-window`），不是配置项原文；
      // 旧事件没这个字段 ⇒ 拿它填一个显式的「未知」，而不是留空让人以为「策略叫不出名字」。
      compactionStrategyUnknown: '未知',
      // erix-agent #469 后续（A2）：折叠事实在引擎侧是**故意静默**的（只进
      // `CompactionStat.foldSummary`，不新增事件类型），不拼这里就只有去看日志的人才知道。
      // `degradeNote` 由本文件拼好（括号整块交给文案，代码不拼标点）。
      // ⚠ issue #442（erix-agent 0.30.0）：`compactionDegraded`（「摘要已降级：{kind}」）**已删除**
      // —— 引擎不再生产 `foldSummary.degradeKind`（摘要器失败现在是终局错误，见下面
      // `runErrorCode.summarizerFailed`）。删掉而不是留着，是为了让「已退役的键不许复活」在 i18n
      // 这一层也有据可查：想加回来就必须同时改这一行注释与那两条判据。
      compactionDegradeNote: '（⚠ {body}）',
      compactionBudgetExhausted: '摘要预算耗尽（没来得及自愈重试）',
      compactionInputClipped: '摘要输入被裁（丢 {rounds} 轮 / {messages} 条，据不完整材料写成）',
      compactionTruncated: '摘要被输出预算截断',
      finalGuard: 'final guard：{action}{dash}',
      forcedFinal: 'forced final（round {round}）：{reason}',
      // issue #442（erix-agent 0.30.0 / 上游 #476）：终稿正文是**引擎兜底文案**时的中性标记
      // （`termination.finalTextFallback === true`）。**中性、不进红色面**：它不是故障，
      // 是引擎在如实交代「这次收尾没产出正文」。缺这条的用户体验：正文区那段话看起来像模型写的。
      finalTextFallback: '（本次收尾未产出正文：以上为引擎兜底文案，非模型输出）',
      // issue #243（第 3 步）：终局正文是一段**被文本化的工具调用**（模型把 tool call 吐进 content，
      // 引擎当最终文本收下 ⇒ run 正常 finished，但交付报告没生成）。措辞是**状态词、不是警报**：
      // 不许出现「⚠ / 失败 / 错误」，也不许渲染成红色（它落在中性 `.roundsep` 分隔行上）。
      // `{dash}` 是命中的那条特征片段（`stream.event.dash`），**没给就是空串**——整句必须独立成立。
      toolCallTextualized: '模型把工具调用写进了正文，这次调用没有真的执行{dash}',
      runEnd: 'run 结束：{reason}{usage}',
      runEndNormal: '正常完成',
      missedRunEnd: '连接中断期间该 run 已结束（详情见运行记录）',
      runFailed: 'run 失败：{code} — {message}',
      // issue #442（erix-agent 0.30.0 / 上游 #661）：run 级错误码 → 人话。码表在
      // `lib/terminationReasons.ts#RUN_ERROR_CODE_LABELS`（与 `RUN_RETRYABLE_ERROR_CODES` 同一处，
      // 单一真相），这里只放文案。缺这条的用户体验：`failed — No summary was produced...`
      // （引擎原文，英文技术句），用户读不出「这是摘要器的问题，可以重试」。
      runErrorCode: {
        summarizerFailed: '压缩摘要器调用失败 ⇒ 本次运行失败（不是降级：上下文没能压缩，重试即可）',
      },
      // issue #212：失败原因的用户可读标签（双语必须同时补，en.ts 的 `satisfies MessageSchema`
      // 会在漏译时编译报错）。键名故意用引擎 reason 原文（不 camelCase），以便与
      // lib/terminationReasons.ts 的 RUN_END_LABEL_REASONS 逐项对齐。
      // issue #236：**除 `end_turn` 外的每个 reason 都有标签**（`end_turn` 走 runEndNormal）。#212 那条
      // 「既有 failed / aborted / max_rounds_cap 保持原样透传」在 #236 验收面（「按停止后看到的是母语
      // 文案」）下作废；且终态分隔条现在会从历史投影出来，任何 reason 都会上屏。引擎新增的未知值
      // 不进本表 ⇒ 文案回落 reason 原文（§5.3 向后兼容）。
      runEndReason: {
        // 快照没落盘 → 崩溃恢复可能重复工具副作用，语义最重（裁决理由见 docs/data/model.md §1.7）
        persistence_failed: '快照未落盘（崩溃恢复可能重复副作用）',
        // 终稿未经 final guard 核验 → 用户必须自己复核
        final_guard_unverified: '终稿未经核验',
        // issue #236：用户主动停止（最常看到的那一条，此前上屏是裸英文 `aborted`）
        aborted: '已中止',
        // 引擎判定失败（`termination.errorCode` 有值时另追加 `（code=…）`）
        failed: '运行失败',
        // 撞轮数上限（finished 收场，但属异常截断）
        max_rounds_cap: '达到轮数上限',
        // 模型不再调工具就收尾（引擎的正常终态之一）
        no_tool: '模型未再调用工具',
        // 评审判定「已完成」（意见，不是独立核验）
        judge_done: '评审判定完成',
        // 连续多轮没有新输出
        stall: '进展停滞',
        // 续跑（continuation）次数耗尽
        continuation_exhausted: '续跑次数耗尽',
      },
      // issue #212：persistence_failed 的落盘细节（worker 透传引擎 termination 的
      // operation/phase/sideEffect；工作台必须能看见 phase）
      runEndPersistence: '落盘细节 {operation}/{phase}/{sideEffect}',
      // 工具卡片结果行（tool_result：ok/err 标记 + 摘要 + 耗时）。括号里的时长由调用方
      // `formatDuration(ms)` 给全量可读串（`12ms` / `4.3s` / `1m 5s`），文案不再自带 `ms` 单位
      //（issue #283：单位与数值必须一起格式化，否则无法支持非毫秒档）。
      toolResult: '{mark} {digest}（{dur}）',
      // 没有时长时的同一行（issue #283：引擎未给 duration 的调用不得伪造成 `0ms`，也不得留空括号）
      toolResultNoDur: '{mark} {digest}',
      // 可选后缀片段（调用方按条件传空串占位）
      dash: ' — {value}',
      paren: '（{value}）',
    },
  },
  // 输入框上方常驻动量状态条 + 消息时刻（issue #282 A/B 两块）。
  // 口径（「不伪装精确」）：`~` 是速率估算标记（rateHint 双语都写了）；tokens 段只出 run_end.usage
  // 真值（拿不到就整段不出，绝不显示 0）；时长未知就不出（不写 00:00）。
  runStatus: {
    aria: '运行状态',
    running: '运行中',
    idle: '空闲',
    // `round` 是引擎侧标识符（不翻译），只拼数字
    round: 'round {round}',
    // 输出量（前端按收到的流式增量累计的 UTF-8 字节数）
    output: '↑ {size}',
    // 速率：**必须**带 `~`（前端滑窗估算，不是上游真值）
    rate: '~{rate} tok/s',
    rateHint: '速率是前端按字符数近似的估算值（非上游真值）',
    // 终态 tokens：只出 run_end.usage 真值；没给就整段不出（不显示 0 tokens）
    tokens: 'tokens ↑{input} ↓{output}',
    tokensInput: 'tokens ↑{input}',
    tokensOutput: 'tokens ↓{output}',
    runElapsed: '本 run {dur}',
    lastRunElapsed: '上次 run {dur}',
    tools: '工具 {count} 次',
    toolsAvg: '（均 {dur}）',
    // 冻结判据：最后一次流式/工具事件距今 > RUN_FROZEN_THRESHOLD_MS（5s）。#425 后这句只在
    // **相位未知**（旧后端/首帧前）时才用；颜色改由 RUN_STALL_THRESHOLD_MS 负责（见下面 phase*）。
    frozen: '已 {sec}s 没有新内容',
    // 硬刷新边界（状态条 tooltip）：`run_end` 不在历史回放白名单；#425 只把历史 `round_end` 的累计用量放进来了。
    refreshBoundary: '刷新后运行中的速率与时长会丢失（run_end 不在历史回放白名单）；上次 run 的 token 与上下文窗口仍会显示（来自历史 round_end 的累计用量）',
    runningElapsed: '已运行 {dur}',
    runningHint: '该 run 仍在执行：数值每 1 秒刷新',
    messageTimeTitle: '消息时刻',
    // ---- issue #425：相位与 token（目标：界面一直说得出自己在等什么，不让用户猜）----
    // 相位三选一（运行中常驻）。名字里的 {tool} 是上游给的工具名（英文标识符，不翻译）。
    phaseAwaiting: '等待模型回复中 {sec}s',
    phaseAwaitingHint: '请求已发出，模型还没开始回话。上下文越大，“首字节前的静默”可以正常地长达几十秒，这不是故障',
    phaseTool: '正在执行工具 {tool}（{sec}s）',
    phaseToolNoName: '正在执行工具（{sec}s）',
    phaseToolHint: '工具在容器内真实执行（构建/测试/dev server 等），这一步的时长不取决于模型',
    phaseStreaming: '正在生成',
    phaseSilent: '已 {sec}s 没有新内容',
    // 上下文占用：分子 = 本轮输入 token（上游真值），分母 = 模型窗口（管理员给该模型配的值）。
    context: '上下文 {pct}%（{used}/{window}）',
    contextHint: '本轮发给模型的上下文：{used} tokens，模型窗口 {window} tokens（接近满时平台会自动折叠旧轮内容）',
    // 本轮 / 本 run token：全部是上游真值（`usage` / `round_end`），不带 `~`。
    roundTokens: '本轮 tokens ↑{input} ↓{output}',
    roundTokensInput: '本轮 tokens ↑{input}',
    roundTokensOutput: '本轮 tokens ↓{output}',
    roundTokensHint: '本轮真实用量（上游返回的 usage）；↑ 是发给模型的上下文，不是花费',
    runTokens: '累计 {tokens}',
  },
  // 输入区（components/ComposerBar.vue）
  composer: {
    send: '发送',
    stop: '■ 停止',
    // issue #261B：上一条发送以失败终局收场时的一键重发（仅输入框为空 + 无活跃 run 时可见）。
    retry: '重试上一条',
    // issue #370：运行中说话的两个动作。命名纪律：叫「转向」不叫「打断并转向」——语义与 pi 的
    // steer 完全一致（当前轮工具调用跑完、下一次 LLM 调用之前停下），但 5 个字会在用户最需要
    // 按下它的那一刻把人吓住（理由全文见 docs/portal.md §4.3a）。
    placeholderRunning: '运行中也能说话：Enter 转向，Alt+Enter 排队',
    steer: '转向',
    steerHint: '当前这一轮跑完就停下来，用这句话继续（正在执行的工具会先跑完）· Enter',
    followUp: '排队',
    followUpHint: '等当前任务正常结束后，按顺序把这句话发出去 · Alt+Enter',
    hintEnterSend: '发送',
    hintEnterSteer: '转向',
    hintAltFollowUp: '排队',
    hintShiftNewline: '换行',
    hintSlash: '查看命令',
    hintAt: '引用文件',
  },
  // issue #370：待发送输入队列条（components/QueuedInputsBar.vue）
  queued: {
    count: '{n} 条待发送',
    steerCount: '{n} 条转向',
    followUpCount: '{n} 条排队',
    expand: '展开',
    collapse: '收起',
    recall: '全部取回',
    recallHint: '把队列里的话全部取回输入框（取回的文在前、已打的草稿在后）',
    // 暂停投递的原因（`queue_update.blocked`）。键名即服务端的机器码，拼成 `queued.blocked.<code>`
    // ——**服务端发码、前端出话**（#294：不在 SSE 里塞成人话）。
    blocked: {
      container_not_running: '容器未运行，队列暂停投递（容器起来后自动继续）',
      deliver_failed: '上次投递没成功，队列已暂停，可取回后重发',
    },
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
  // 子 run（delegation）只读抽屉 + 工具卡（issue #delegate P3）。
  // 状态键集 = `lib/delegate.ts#DELEGATE_ROSTER_STATES` 的 7 值 + `unknown`（脏值/缺位的中性态），
  // 分级尺规在 `delegateBadgeKind`，这里只出文案；`viewerTitle` 带短码占位 `{id}`。
  delegate: {
    openViewer: '查看子任务',
    closeViewer: '关闭子任务',
    viewerTitle: '子任务 {id}',
    refresh: '刷新',
    polling: '运行中，自动刷新',
    truncated: '只加载了最近一段，更早的记录未包含在内',
    viewer: {
      starting: '子任务正在启动，暂无输出',
      empty: '这个子任务没有留下任何输出',
      error: '读取子任务输出失败',
      // issue #602：父 run 已结束、名册却还写着活态（后台子随父 worker 进程消失 ⇒ `finishRun` 永不跑）。
      // 它是「状态未知」，**不是**失败（与 `activity.staleParentEnded` 同一口径），所以这句不带 ⚠ 也不染红。
      parentEnded: '父 run 已结束，子任务状态不再更新（实际状态未知）',
    },
    state: {
      queued: '排队中',
      running: '运行中',
      completed: '已完成',
      failed: '失败',
      aborted: '已停止',
      timeout: '超时',
      interrupted: '已中断',
      unknown: '状态未知',
    },
    // issue #592：活跃子 run 徽标（RunStatusBar 尾部）与展开面板（状态条下方）。
    // 状态词汇**复用**上面的 `state.*`（不另造一份）；这里的 `{count}` 是**活态**子数
    // （尺规 = `lib/delegate.ts#DELEGATE_LIVE_STATES`，终态子不计数）。
    activity: {
      title: '子任务 {count}',
      // 「读不到」与「没有」必须两种说法（徒标的降级态；设计 §4.2 末段 + D9 口径）。
      titleUnknown: '子任务 ?',
      toggleUnknown: '展开或收起子任务面板（状态暂不可读）',
      panelTitle: '子任务 {count}',
      toggle: '展开或收起子任务面板（{count} 个在跑）',
      hint: '每 2 秒刷新，只读当前 run 派出的子任务',
      collapse: '收起',
      elapsed: '已跑 {dur}',
      view: '查看',
      viewAria: '查看子任务 {id}',
      unreadable: '子任务状态暂不可读',
      // 名册还写着活态、但父 run 已终态（后台子随父进程消失 ⇒ `finishRun` 永远不会跑）。
      // 它是「状态未知」，不是失败也不是在跑（D9 的 ⚪ 口径）。
      staleParentEnded: '父 run 已结束，状态未知',
    },
  },
  // 文件预览 modal（components/FilePreviewModal.vue）
  preview: {
    title: '预览 {path}',
    download: '下载',
    downloadInstead: '下载该文件',
    notPreviewable: '该格式不支持在线预览',
    pdfUnsupported: '当前浏览器无法内嵌显示此 PDF，请用右上角下载后本地打开',
  },
  // 预览端口面板（issue #246 交付② 单 B：工作台「预览端口」区块 + 管理台 FDE 详情面板）。
  // 口径红线（portal.md §4.7a）：`active` 只代表「首次凭证放行过」⇒ 状态文案一律不写「健康 / 运行中」；
  // 服务端 error.message 原文透传（错误码 + 原文都要显示，不许吞成「操作失败」）。
  previewPorts: {
    title: '预览端口',
    adminTitle: '{fde} 的预览端口',
    // 工作台折叠条（issue #308 起在左侧栏底部，与目录树各自独立折叠；收起态也要给出可用信息）
    // #468 追加 A：端口池面板退役（用户裁定只要「端口池 总量/空闲」两个数），所以只剩进程监听一个折叠条；
    // poolToggle / poolToggleCount / poolToggleFailed 随池面板一起删除（零消费者，localeParity 守成对）。
    procToggle: '进程监听情况',
    procToggleCount: '进程监听（{count} 个）',
    // #468 追加 A D8：折叠条上的池用量，顺序是**池大小/空闲**（用户举例 `10/8`）。
    // 未 loaded 或有错误 ⇒ 整段不渲染（绝不显示 0/0），所以这里不需要「失败」版文案。
    poolUsage: '端口池 {total}/{idle}',
    poolUsageTitle: '端口池共 {total} 个，其中 {idle} 个空闲（没有进程在监听）',
    procEmpty: '当前项目里没有进程在监听。',
    spareGroup: '空闲（{count}）',
    // #468 D2：反推不出项目（cwd 在 ~//tmp 等非项目目录，或跨 uid 读不到 cwd）的观测**单列一组**，不许丢弃。
    unknownGroup: '未知项目（{count}）',
    // #468：未知项目组里每行前面那个黄色叹号的完整口径（鼠标悬停 / 读屏用）
    unknownMarkTitle: '这个进程不属于当前项目',
    currentBadge: '当前目录',
    colPort: '端口',
    colHostname: '预览域名',
    colState: '状态',
    colActions: '操作',
    openAction: '打开预览',
    signing: '签发通行票…',
    // issue #247：一键开整组（一次点击 = 签 + 开；不做二次确认——票 60 秒过期）
    // issue #256 交付②：429/503 带 Retry-After 时把「多久后重试」说成秒数（缺头走上面不带秒数的键）
    // issue #286：面向**人**的 Cookie 告知（边缘整体剥 Cookie 头是 by design，不是 bug；
    // 工位内的 agent 已由容器内 ~/AGENTS.md 第 7 条被告知，人类开发者在此告知）
    hostnameCopyTitle: '{url}（点击复制完整地址）',
    copiedUrl: '预览地址已复制到剪贴板。',
    copyFailed: '复制失败：',
    state: {
      // allocated = 已分配但从未放行过；active = 首次凭证放行过（不代表有应用在监听）
      allocated: '已分配 · 待首次访问',
      active: '已放行过（仅表示首次放行过）',
    },
    stateUnknown: '未知状态（{state}）',
    // issue #308：侧栏紧凑形态（variant='list'，约 163px 宽）的**短**标签；完整口径仍走 state.*，
    // 以同一元素的 title/aria-label 可达（不得只靠颜色传达）。键集与 state.* 一一对应（localeParity 钉）。
    stateShort: {
      allocated: '待首次访问',
      active: '已放行过',
    },
    stateShortUnknown: '未知状态',
    // issue #308 §3.4：端口是工位级资源；观测 MVP 后工作台视图按当前目录过滤——文案说真实行为。
    // 人侧文案面向不懂技术的业务用户：不出现端口/进程/监听这类词，只说动作层能执行的话；
    // 技术事实（Cookie 剥除、端口角色等）一律留在 agent 侧 ~/AGENTS.md，不进 UI。
    // 观测层 MVP（迁移 0022）：真实运行注解；无注解的行不渲染任何反向文案（null ≠ 空闲）。
    observedTitle: '正在使用这个地址的程序',
    observedUptime: '已运行 {ago}',
    // #468 D7：跨 uid（无 CAP_SYS_PTRACE + Yama）时 pid/cwd/cmd/branch 全读不到 ⇒ 行里给这句，不留空白行。
    observedOpaque: '进程细节不可读（跨用户）',
    duplicateWarn: '⚠ {cwd} 同时在 {ports} 两个地址上开着——可能是新旧两个版本并存，先确认哪个才是你要看的（旧任务留下的程序不会自己关）。',
    unroutedNote: '这个程序还不能用预览地址打开——可让助理把它改到分配好的端口上。',
    stateHint: '「已放行过」只表示该端口首次凭证放行过，不代表容器里有应用在监听。',
    emptySelf: '你还没有预览端口（平台尚未为账号分段，或已全部释放）。',
    emptyFde: '该 FDE 没有活着的预览端口（可能尚未开户或已下线）。',
    loadFailed: '预览端口加载失败（{code}）：{message}',
    ticketFailed: '签发预览通行票失败（{code}）：{message}',
    // issue #256 交付②：同上，单张签票的 429 提示
    ticketFailedRetry: '签发预览通行票失败（{code}）：{message}（约 {seconds} 秒后可重试）',
    popupBlocked: '浏览器拦截了新标签；',
    popupBlockedLink: '点此打开预览',
    noFdeName: '该用户没有 fde_name，因此没有预览端口。',
    // 管理台改块（搬迁）区（components/FdePreviewPortsPane.vue）
    admin: {
      moveTitle: '改块（搬迁预览端口段）',
      moveAction: '改块…',
      moving: '搬迁中…',
      blockStartLabel: '新块起点',
      blockStartPlaceholder: '例如 22010',
      blockHint: '号池 22000–29999，每段 10 个，起点必须按 10 对齐；改块是搬迁整段，不是再发一块。',
      alignHint: '该起点不在号池内或未按 10 对齐：服务端会拒绝（block_start 不合法）。',
      currentBlock: '当前段：{block}（{count} 条活端口）',
      currentBlockNone: '当前没有活预览端口段。',
      notInteger: 'block_start 必须是整数（例如 22010）。',
      confirmTitle: '确认迁移预览端口段',
      confirmBody: '把 {fde} 的预览端口段从 {oldBlock} 搬到 {newBlock}（{count} 条活端口）。',
      confirmBodyNoBlock: '为 {fde} 新建预览端口段 {newBlock}。',
      confirmWarning: '旧段的预览域名会立刻失效（真机实测直接 404），FDE 手里的旧链接会断，且不可撤销。',
      confirmOk: '确认搬迁',
      moved: '搬迁完成：{oldBlock} → {newBlock}；释放 {released} 条旧分配、撤销 {revoked} 条预览凭证、新分配 {inserted} 条。',
      movedNoop: '目标段 {block} 已经是该 FDE 的现有整块：零写入，什么都没改。',
      movedPorts: '新段端口：{ports}',
      fieldErrorBlockStart: '字段 block_start 不合法：{message}',
      moveFailed: '改块失败（{code}）：{message}',
      blockTakenHint: '该段已被占用（服务端不会自动换段）：换一个整块空闲的对齐起点后重试。',
      // issue #350：改块区接上「号池占用总览」（引用式：本面板**不**因看到空闲段就改输入框/自动提交）
      usageRefHint: '选段前先看号池占用总览：哪几段被谁占、哪几段整段空闲。',
      usageRefLink: '打开号池占用总览',
      occupancyTitle: '最近一次总览里这一段：',
      occupancyOccupied: '被占用（占用者：{names}；{count} 个活行）——改块会被服务端拒绝（409），请换一段。',
      occupancyOccupiedNoCount: '被占用（占用者：{names}）——改块会被服务端拒绝（409），请换一段。',
      occupancyOccupiedNoNames: '被占用（占用者未给出；{count} 个活行）——改块会被服务端拒绝（409），请换一段。',
      occupancyOccupiedBare: '被占用（占用者与活行数未给出）——改块会被服务端拒绝（409），请换一段。',
      occupancyFree: '整段空闲（在最近一次总览的空闲列表里）。',
      occupancyUnknown: '不知道这一段空不空：它不在最近一次总览的空闲列表里（那份列表是截断的），以服务端校验为准。',
    },
  },
  // 能力市场·用户面（views/MarketView.vue，issue #595；契约 docs/design/capability-market.md §8）。
  // 口径（§8）：红黄绿不引入——「已安装但未启用」是中性灰字，不是告警。
  market: {
    title: '能力市场',
    backToWorkbench: '← 返回工作台',
    reload: '刷新',
    loading: '正在读取市场目录…',
    empty: '还没有已发布的技能包。',
    intro: '这里列的是平台已发布的技能包：安装到你的 FDE 工位，启用后才会进入模型的工具面。',
    budgetHint: '一个启用的技能会把它的全部工具铺进每一轮请求：单个 FDE 最多同时启用 {max} 个。',
    footnote: '停用只改开关，不删文件也不重新下载；手改过包里的文件可以用「重新安装」盖回去；' +
      '卸载会真的删掉 <你的工位>/.erix/skills 下那个目录。',
    version: '版本 {version}',
    tools: '工具：{count}',
    securityScore: '安全分：{score}',
    scanHints: '{count} 条静态扫描提示',
    kindMcp: 'MCP 条目',
    installBlockedMcp: 'P0 不消费 MCP，装不了',
    driftHint: '已装版本 {installed}，市场版本 {version}：可重新安装覆盖。',
    installed: {
      notInstalled: '未安装',
      installedDisabled: '已安装 · 未启用',
      installedEnabled: '已安装 · 已启用',
    },
    install: '安装',
    reinstall: '重新安装',
    uninstall: '卸载',
    enable: '启用',
    disable: '禁用',
    busy: '处理中…',
    state: {
      draft: '草稿',
      published: '已发布',
      retired: '已下线',
      unknown: '未知状态',
    },
    result: {
      installed: '已安装 {name}；启用后下一次 run 就能用。',
      reinstalled: '已重新安装 {name}。',
      uninstalled: '已卸载 {name}（包目录已删除）。',
      enabled: '已启用 {name}；下一次 run 生效。',
      disabled: '已停用 {name}；文件保留，重新启用不需重新下载。',
    },
    detail: {
      open: '详情',
      close: '收起',
      loading: '正在读取详情…',
      whenToUse: '何时用',
      tools: '工具清单',
      toolsUnknown: '没拿到工具清单（服务端未下发）。',
      params: '参数：{params}',
      readme: 'SKILL.md 正文',
      readmeMissing: '这个包没附带 SKILL.md。',
      files: '文件清单',
    },
    errors: {
      notFound: '这个条目已经不在市场里了（可能被下线了）：刷新一下看看。',
      notPublished: '这个条目当前不是已发布态，装不了：需要管理员先发布。',
      budgetExceeded: '启用数量已达上限：单个 FDE 最多同时启用 {max} 个技能。' +
        '请先禁用一个再启用这一个。',
      kindUnsupported: 'MCP 类型的条目 P0 还不支持（runner 侧没有 MCP 客户端），只能看不能装。',
      installFailed: '安装没成功：{reason}',
      reasonUnknown: '原因未给出',
      validationFailed: '参数不合法：服务端点名了字段 {field}。',
      validationGeneric: '参数不合法：服务端没点名具体字段。',
      generic: '请求失败（HTTP {status}）：{message}',
    },
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
      mail: '邮件通道',
      tls: '证书',
      previewPool: '号池占用',
      // issue #485 片 A：上传上限（views/AdminUploadView.vue，契约 docs/api/portal.md §4.15）。
      // 放在证书之后、号池占用（只读运维快照）之前：它是一处**平台配置**。
      upload: '上传上限',
      // issue #596 片 B：平台提示词面板（views/AdminPromptsView.vue，契约 docs/api/portal.md §4.18）。
      // 顺序 upload → prompts：两者都是「改一行而不必重建 station-portal」的平台配置。
      prompts: '提示词',
      // issue #595 M2：能力市场发布台（views/AdminMarketView.vue，契约 §7 管理面）。
      // 排在上传之后、号池占用（只读运维快照）之前：它是一处平台配置。
      market: '能力市场',
      // issue #586：「关于」（版本三格，只读）；views/AdminAboutView.vue。
      about: '关于',
      // issue #528（事件平台 W5）：宏模板与宏流水的管理台栏目（按 `07` §21.1 的键名表）。
      macros: '宏模板',
      macroRuns: '宏流水',
    },
    // 能力市场·发布台（views/AdminMarketView.vue，issue #595 M2；契约 §7 管理面 + §8 管理台）。
    market: {
      title: '能力市场',
      intro: '发布与维护技能包：元数据 + 多文件包体。包内容的合法与否由服务端判。',
      footnote: '静态扫描是**提示不是闸门**（§3）：分数低不会拦住发布，也不会拦住安装。' +
        '路径/字节/条数的硬校验在服务端（validateBundle），本页只挡绝对路径与 `..` 这类一眼假。',
      loading: '正在读取条目…',
      empty: '还没有条目：点「发布新条目」建一个。',
      reload: '刷新',
      filterLabel: '状态',
      filterAll: '全部',
      colState: '状态',
      colSlug: '标识（slug）',
      colVersion: '版本',
      colInstalls: '安装数',
      colScore: '安全分',
      colActions: '操作',
      publish: '发布',
      retire: '下线',
      edit: '编辑',
      detail: '详情',
      close: '关闭',
      detailLoading: '正在读取详情…',
      files: '文件清单',
      filesUnknown: '没拿到文件清单（服务端未下发）。',
      scanScore: '静态扫描：{score} 分',
      scanClean: '扫描没有提示。',
      scanHintCount: '{count} 条提示',
      createTitle: '发布新条目',
      editTitle: '编辑条目',
      submitCreate: '发布',
      submitSave: '保存',
      cancel: '取消',
      formIntro: '带 * 的字段由服务端必填校验；本表单不做前端必填拦截。',
      fSlug: '标识（slug）*',
      slugHint: '目录名，全小写字母/数字/连字符；服务端还要求包里的 `skill.id` 等于它。',
      fName: '名称 *',
      fSummary: '一句话简介 *',
      fWhenToUse: '何时用 *',
      whenToUseHint: '这段会被注入模型的系统提示做路由信号（服务端限 8..500 字）。',
      fVersion: '版本 *',
      fAuthor: '作者',
      fTags: '标签',
      tagsHint: '逗号分隔（例：pdf,docs）。',
      fLicense: '许可证',
      fDescription: '详情正文（markdown）',
      filesLabel: '包内文件（可多选）',
      bundleHint: '根目录必须有 `skill.mjs`。path 取目录相对路径（没选目录就是文件名）；' +
        '文件数/字节上限、缺入口、id 对不上都由服务端报错。',
      noFilesPicked: '没选文件：新建时必须选，编辑时不选就是只改元数据。',
      detailMissingHint: '这个条目的详情没读到：「何时用」「正文」可能是空的，' +
        '请补齐再提交（否则可能把原值清空）。',
      pickedSummary: '已选 {count} 个文件，共 {bytes}',
      pathIssue: {
        empty: '路径是空的',
        absolute: '绝对路径（不允许）',
        separator: '路径里有反斜杠',
        parentRef: '路径含 `..`',
        tooLong: '路径太长（超 200 字节）',
      },
      resultCreated: '已发布条目 {slug}。',
      resultUpdated: '已更新条目 {slug}。',
      resultPublished: '已发布 {slug}（状态转成 published）。',
      resultRetired: '已下线 {slug}（已装的人仍可继续用）。',
    },
    macros: {
      title: '宏模板',
      intro: '配置自动化模板：先选类型，再填参数。类型建好之后不可修改。',
      loading: '正在读取模板…',
      loadFailed: '读取模板失败',
      retry: '重试',
      empty: '还没有模板。',
      includeDeleted: '含已删除',
      colName: '名称',
      colKind: '类型',
      colVisible: '可见',
      colStatus: '状态',
      colSubscribers: '订阅数',
      colActions: '操作',
      subscriberUnknown: '—',
      audienceAll: '全员可见',
      audienceAdmin: '仅管理员',
      deletedLabel: '已删除',
      deletedSuffix: '（已删除）',
      enable: '启用',
      disable: '停用',
      del: '删除',
      createTitle: '新建模板',
      pickKindFirst: '先选类型，再填下面的表。',
      kindLocked: '类型一旦创建就不可修改。',
      name: '名称',
      audience: '可见范围',
      paramsTitle: '参数',
      fixedByCode: '以下由代码固定',
      fixedHint: '这些判据与工具面由代码写死，不在这里配置。',
      fixedScope: '订阅范围：{scope}',
      scopeSession: '会话（session）',
      scopeUser: '用户（user）',
      cancel: '取消',
      submitCreate: '创建',
      createdTitle: '已创建 · 用户视角预览',
      userPreview: '用户在订阅里会看到：',
      triggerCost: '一次触发成本估算：{estimate}',
      triggerCostUnknown: '一次触发成本估算：暂无法估算',
      deleteHint: '删除后平台按数据自动判定：三处引用都不存在就物理删除；只要还有执行账或通知，就只能软删除（保留历史）。',
      deleteConfirm: '确定删除这个模板吗？',
      resultDeleted: '已物理删除。',
      resultDeletedWithAssignments: '已物理删除，并级联清除了 {count} 条订阅。',
      resultSoft: '已软删除（保留历史）：执行账 {runs} 条、通知 {notifications} 条。',
    },
    macroRuns: {
      title: '宏执行历史',
      intro: '按模板 / 状态 / 判决 / 时间 / 用户筛选；翻页用游标（keyset）。',
      loading: '正在读取执行历史…',
      loadFailed: '读取执行历史失败',
      retry: '重试',
      empty: '没有匹配的记录。',
      loadMore: '加载更多',
      noMore: '没有更多了',
      colTime: '开始时间',
      colTemplate: '模板',
      colUser: '用户',
      colStatus: '状态',
      colVerdict: '判决',
      colCriterion: '判据',
      colDuration: '耗时',
      colUsage: '花费',
      usageUnknown: '—',
      deletedSuffix: '（已删除）',
      summaryTitle: '汇总（随筛选变化）',
      sumTriggered: '触发',
      sumDone: '完成',
      sumSkipped: '跳过',
      sumFailed: '失败',
      sumSkippedHint: '跳过率偏高通常意味着参数配错，而不是正常。',
      verdictRatio: '判决占比（分母 = 完成）',
      ratioNote: '百分比的分母是「完成」，不是「触发」——被跳过的没有判决。',
      ratioValue: '{label}：{count}（{pct}%）',
      ratioNoDone: '没有已完成的记录，无法计算判决占比。',
    },
    // issue #485 片 A：单文件上传上限（`upload_settings` 单行表，迁移 0035）。
    // 这一页的存在理由只有一条：改一个数字不该要重建容器。所以文案的重心在「当前生效值 + 来源」，
    // 而不是「保存成功」——只报保存成功，运维仍然不知道现在到底听哪一边的。
    upload: {
      title: '单文件上传上限',
      intro: '工作台「上传」能传进来的单个文件最大多少字节。这里改完**不需要重启 portal、不需要重建容器**：上限是每次上传现读的，所以下一次上传就按新值走。',
      loading: '正在读取上传上限…',
      notLoaded: '尚未加载上传上限（还没请求）。',
      unknown: '未知',
      statusEffective: '当前生效值',
      statusSource: '来源',
      statusUpdatedAt: '最后修改',
      updatedAtNever: '从未修改（还没人在管理台存过这个值）',
      updatedAtUnknown: '时间无法解析：{value}',
      limits: '允许区间：{min} – {max}',
      field: '新的上限（字节）',
      fieldHint: '服务端才是闸：填了整数就照发（越界会报错并标红这个框），前端不提前拦。只接受整数，`1.5` / `1e7` 这种写法不算整数。',
      draftIs: '你填的是：{value}',
      draftNotInteger: '还不是一个整数（空、小数、科学计数法都算不是）——此时不会发请求。',
      hintBelow: '这个值低于允许区间（{min} – {max}），保存会被服务端拒。',
      hintAbove: '这个值高于允许区间（{min} – {max}），保存会被服务端拒。',
      save: '保存',
      reload: '重新读取',
      saved: '已保存，**下一次上传起生效**（显示的数就是服务端落库后回读的那一个）。',
      sourceDb: '管理台（DB 里的 upload_settings）',
      sourceEnv: '环境变量 FILE_UPLOAD_MAX_BYTES',
      sourceDefault: '内置默认（32 MiB）',
      reasonNoRow: '管理台还没存过值，现在用的是环境变量（没设则是默认）。在这里存一个数就会覆盖它。',
      reasonInvalid: 'DB 里那个值用不了（不在允许区间，或形状不对），已回落环境变量/默认值——所以下面那个数不是管理台里存的数。',
      reasonReadFailed: '读不到 upload_settings（表缺失或数据库抖动），已回落环境变量/默认值；上传本身不受影响。',
      reasonReadTimeout: '读 upload_settings 超时（数据库没在 UPLOAD_SETTINGS_READ_TIMEOUT_MS 内回答），已回落环境变量/默认值；上传本身不受影响。',
      srcDb: 'DB 里的值（可用时）',
      srcEnv: '环境变量那一档',
      srcDefault: '内置默认',
      envNotSet: '环境变量并未显式设置',
      footnote: '这是**单文件**上限，不是磁盘总量上限（总量配额是 #485 片 B，未实现）。它与 MAX_BODY_BYTES（JSON 请求体口径，默认 64 KiB）是两个不同的旋钮：上传不走后者。',
    },
    // issue #596 片 B：管理台「提示词」面板（views/AdminPromptsView.vue，契约 docs/api/portal.md §4.18）。
    // 三条生效时机各不相同 ⇒ 故意是三个键而不是一个共用句（判据 F7：三张卡不许共用一句）。
    // readonly 四条只写「住在哪 + 改它要付什么代价」，不写全文：portal 镜像不含 runner/。
    // ⚠ 这一段的值是纯文本渲染的（本页没有 markdown 渲染器，也不打算加依赖）⇒ 值里不许写成对星号
    //   当强调：它在界面上只是一串杂字符。要强调请用 class；机械闸见 localeParity.spec.ts。
    prompts: {
      title: '平台提示词',
      intro: '平台喂给模型的文本里，portal 侧可控的三条。改完不重启 portal、不重建镜像：物化与改名每次都现读数据库那一行。空串就是「跟随内置」。',
      loading: '正在读取提示词…',
      notLoaded: '尚未加载提示词（还没请求）。',
      unknown: '未知',
      never: '—',
      updatedAt: '最后保存',
      updatedBy: '操作人',
      updatedAtNever: '从未保存过（还没有人在管理台存过）',
      updatedAtUnparsable: '时间无法解析：{value}',
      reasonNoRow: '管理台从没存过任何一条 ⇒ 现在发出去的是内置提示词；在这里存一份就会覆盖它。',
      reasonReadFailed: '读不到 platform_prompts（表缺失或数据库抖动）⇒ 已回落内置提示词；物化与改名照常，不会被 500 弄挂。',
      reasonReadTimeout: '读 platform_prompts 超时（数据库没在 PLATFORM_PROMPTS_READ_TIMEOUT_MS 内回答）⇒ 已回落内置提示词；这不是「没人配过」，真故障在连接上。',
      reasonUnknown: '服务端回了一个本页不认识的回落原因（后端新加的 reason？）⇒ 现在用的是内置提示词，具体原因看服务端日志。',
      source: '当前来源',
      sourceDb: 'DB 覆写',
      sourceBuiltin: '跟随内置',
      sourceDbNote: '（这一格现在是管理台存的值，不是代码里那一份）',
      bytesOf: '当前 {bytes} / 上限 {max}',
      draftBytes: '草稿：{bytes}',
      overLimit: '草稿 {bytes} 已超过上限 {max}：保存会被服务端拒（400）——这里不提前拦，服务端才是闸。',
      cardAddendum: '平台补充约定（追加成 ~/AGENTS.md 末尾一节）',
      addendumLabel: '追加段正文',
      addendumHint: '那一节的标题与引言由平台撰写；你写的正文逐字节照搬，不加工不改写。清空就是不要那一节。',
      timingAddendum: '生效时机：保存 ⇒ 入队重物化 ⇒ 该工位下一次 run 吃到这一节（不是当场，也不是下一次 portal 重启）。',
      cardAgentsMd: '平台约定整段覆写（替换 ~/AGENTS.md 的正文主体）',
      agentsMdLabel: '覆写正文',
      agentsMdHint: '内置模板的正文主体整段被你这份替掉；末尾的「FDE 标识」行仍由代码追加，永远是最后一行、改不掉。',
      timingAgentsMd: '生效时机：与追加段共用同一次物化通知 ⇒ 该工位下一次 run 生效；入队没成功时，要等下一次 portal 重启的全量重建才收敛。',
      cardTitlePrompt: '会话标题提示词（AI 改名时的 system）',
      titlePromptLabel: '标题提示词',
      titlePromptHint: '它只决定「给会话起什么名」：不进 ~/AGENTS.md，也不参与物化。提示词不是守卫——落库前照旧 sanitize 标题。',
      timingTitlePrompt: '生效时机：下一次改名就生效（手工「AI 改名」与自动改名走同一条解析路径；每次现读、无缓存，不用等 run，也不通知物化）。',
      deviated: '已偏离内置模板：现在发出去的是你写的这份正文主体。',
      followsTemplate: '跟随内置模板：没有覆写，发出去的就是代码里那一份。',
      renderBudget: '整份 ~/AGENTS.md：生效 {effective} / 注入上限 {limit}（内置模板渲染出来是 {template}）',
      renderBudgetNote: '这个数是按固定示例工位名 example 渲染的预览值（零时间戳 ⇒ 可对比），不是某个真工位的文件大小；而保存时的渲染闸按最长合法工位名算 ⇒ 真名字更长时，它可能比这里显示的略大。',
      viewEffective: '查看当前生效全文',
      hideEffective: '收起生效全文',
      copy: '复制',
      copied: '已复制。',
      copyFailed: '复制失败（浏览器没给剪贴板能力），请手动选中。',
      restoreBuiltin: '恢复内置',
      titlePromptDefaultBytes: '内置默认（跟随内置时实际发出去的就是它）：{bytes}',
      save: '保存',
      reload: '重新读取',
      saved: '已保存（下面显示的就是服务端落库后回读的那一份，不是你敲的那一串）。',
      savedEnqueued: '已通知 {count} 个启用中的工位重新物化 ⇒ 各自下一次 run 生效。',
      savedButNotNotified: '已保存，但物化未通知（portal 重启后全量重建收敛）。',
      savedNoticeCountUnknown: '已保存，但服务端没回 materializeEnqueued ⇒ 本页按「未通知」处理，不说「已生效」。',
      readonlyTitle: '住在镜像里的四条（本页只读）',
      readonlyIntro: '这四条第一期不开放在线覆写。下面只写它们住在哪、改它要付什么代价。',
      readonlyNoFullText: '本页不显示它们的全文：portal 镜像里没有 runner/（Dockerfile 只 COPY portal/），后端运行时读不到、也只把 key 发过来——在这里显示全文就是撑不起的承诺。要看全文请读仓库源码。',
      readonlyUnknown: '服务端还列了本页没有说明文案的条目：{keys}（不猜它是什么）。',
      readonly: {
        runnerSystemPrompt: {
          where: '住在 runner/worker.js 的 SYSTEM_PROMPT：每个主 run 的 system，拼在 ~/AGENTS.md 注入段之前。',
          cost: '改它 = 改代码 + 重建并推送 FDE 镜像 + 重建全部 fde-* 容器（不是 station-portal），即一次全站发版；数据库里没有它的位置。',
        },
        childSystemPrompt: {
          where: '住在 runner/lib/delegation.js 的 CHILD_SYSTEM_PROMPT：被派出去的子 run 的 system（明说它没有 delegate 工具）。',
          cost: '同上：改代码 + 重建 FDE 镜像 + 重建容器。第一期不开放在线覆写（issue #596 把它排在 portal 侧三条之后）。',
        },
        toolDescriptions: {
          where: '住在 runner/lib/file-tools.js、shell-tools.js、notes-tools.js 等文件里每个工具 schema 的 description 字段。',
          cost: '改一句就要重建 FDE 镜像；工具描述直接决定模型怎么调参，回归面是全部工位的全部 run——比改措辞贵得多。',
        },
        engineNotices: {
          where: '住在 runner/lib/engine-notices.js：把引擎诊断事件翻译成人能读的 LOG 的那一层（界面之外的那一半）。',
          cost: '改它 = 改代码 + 重建 FDE 镜像，且它与 run_events 的键名逐条对账（runner/test/engine-notices.test.js）——不能只改字不改判据。',
        },
      },
      errNotText: '这一格的草稿不是一个文本，连长度都算不出 ⇒ 没有发请求。',
      footnote: '这三条之外平台还有 4 条提示词住在 runner 镜像里（见上面那张只读卡）。本期不做 per-FDE 覆盖，也不做版本历史：想知道是谁改的去看审计 action=admin.platform_prompts_updated（审计只存摘要，正文在这一行里）。',
    },
    // issue #449 管理台切片：邮件通道配置（views/AdminMailView.vue，契约 docs/api/portal.md §4.12）。
    // 本页是登录第二因素「邮箱验证码」的唯一开关；口令**只写不读**（服务端只回 hasPassword）。
    // 服务端透传的 error.message 一律不译（只加本地化前缀），故这里的键大多是前缀/自产文案。
    mail: {
      title: '邮件通道（SMTP）',
      intro: '登录第二因素「邮箱验证码」的唯一开关：这里配好 smtp 且保存后，没注册 TOTP 的账号登录才会走邮箱码；disabled 就退回纯口令。口令只写不读——服务端只回「已设置 / 未设置」，任何响应都不带明文。',
      loading: '正在读取邮件配置…',
      notLoaded: '尚未加载邮件配置（还没请求）。',
      unknownValue: '—',
      statusTransport: '当前通道',
      statusPassword: '口令',
      statusUpdatedAt: '最后修改',
      updatedAtNever: '从未修改（服务端回的是默认 DTO）',
      updatedAtUnknown: '时间无法解析：{value}',
      passwordSet: '已设置',
      passwordUnset: '未设置',
      transport: '通道',
      transportDisabled: 'disabled（不发信）',
      transportSmtp: 'smtp（真发信）',
      transportHint: 'disabled 时主机与发件人都不必填（后端也不校验），表单仍可编辑：可以先关掉再慢慢配。',
      host: 'SMTP 主机',
      hostHint: '内网 relay 填主机名即可（不带协议前缀）；transport=smtp 时必填。',
      port: '端口',
      secure: '使用隐式 TLS（465 形态）',
      secureHint: '勾选 = implicit TLS（常见 465）；不勾 = STARTTLS（常见 587）。',
      user: '认证用户名',
      userHint: '可空：内网 relay 常按来源 IP 放行，不需要认证。',
      password: 'SMTP 口令',
      passwordKeep: '已设置，留空不修改',
      passwordPlaceholder: '未设置（留空则保持未设置）',
      passwordHint: '口令不回填、不进页面状态、不写日志与地址栏：它只在输入框里，只在保存时随请求体走。',
      clearPassword: '清除已保存的口令',
      from: '发件人地址',
      fromHint: '验证码邮件的 From；transport=smtp 时必填，且必须是有效邮箱地址。',
      advanced: '高级：超时（毫秒）',
      timeoutConnection: '连接超时',
      timeoutGreeting: '握手超时',
      timeoutSocket: '套接字超时',
      timeoutHint: '正整数（上限 600000）；留空就用服务端默认值。',
      save: '保存配置',
      saving: '保存中…',
      saveOk: '已保存：服务端已让缓存失效，配置立刻生效。',
      testTitle: '测试发信',
      testIntro: '用已保存的配置真发一封探活信（不是用表单里还没保存的草稿）。每管理员每小时最多 5 次。',
      testTo: '收件人',
      testToPlaceholder: "ops{'@'}example.com",
      testSend: '发一封测试信',
      testing: '发送中…',
      testDisabledHint: '当前通道不是 smtp（未启用）：发不了信。先把通道改成 smtp 并保存。',
      testFormUnsaved: '表单里的通道和已保存的不一致：测试发信用的是已保存的配置。',
      testOk: '测试信已发出：{to}（{at}）',
      testOkNoTime: '服务端未给时间',
      testNotConfiguredPrefix: '邮件通道未启用（409 mail_not_configured）：',
      testFailedPrefix: '发信失败（502 email_send_failed）：',
      testRateLimited: '测试发信太频繁（429 rate_limited）：每位管理员每小时最多 5 次，请 {seconds} 秒后再试。',
      testRateLimitedNoRetry: '测试发信太频繁（429 rate_limited）：每位管理员每小时最多 5 次，请稍后再试。',
      testReason: '服务端原因：{reason}',
    },
    // issue #456 M2 前端切片：管理台「证书」页（views/AdminTlsView.vue，契约 docs/api/portal.md §4.13）。
    // 服务端透传的 error.message 一律不译（只加本地化前缀）；`warnings` 是机器码，文案在这里。
    tls: {
      title: '管理台证书',
      intro: '管理台入口（admin.<伞域>）用的那张证书：看现状 / 真机校验 / 上传更新 / 回滚。盘上的证书文件是唯一真相，数据库只是台账。',
      loading: '正在读取证书状态…',
      notLoaded: '尚未加载证书状态（还没请求）。',
      unknownValue: '—',
      statusTitle: '当前证书',
      configured: '已配置',
      notConfigured: '未配置',
      notConfiguredHint: '管理台入口当前用 Traefik 内建自签证书，浏览器会告警。用下面的表单装一张正式证书即可。',
      subjectCN: 'Subject CN',
      sans: 'SAN（证书覆盖的名字）',
      sansEmpty: '这张证书没有 DNS SAN（覆盖判定退回 CN）',
      issuerCN: 'Issuer CN',
      validFrom: '生效时间',
      validTo: '到期时间',
      fingerprint: 'SHA-256 指纹',
      copy: '复制',
      copied: '已复制',
      coverageOk: '覆盖管理台域名 {host}',
      coverageBad: '这张证书不覆盖 {host}，浏览器会报证书错误',
      expirySoon: '证书还有 {days} 天到期（{date}）',
      expiryToday: '证书今天到期（{date}）',
      expiryExpired: '证书已过期（{date}）',
      liveTitle: '真机校验',
      liveIntro: '连一次管理台入口，比对手里拿到的证书指纹与盘上的是否同一张。连不上只是探针失败，不影响上传/回滚。',
      liveCheck: '检查线上证书',
      liveChecking: '检查中…',
      liveNever: '还没检查过',
      liveCheckedAt: '检查时间：{at}',
      liveLive: '线上握手拿到的就是这张证书（指纹一致）',
      liveMismatch: '线上端出来的是另一张证书',
      liveMismatchChainIncomplete: '线上指纹与盘上一致，但服务端只发了 1 张证书（链深 {depth}）：客户端可能链校验失败（unable to verify the first certificate）。把中间证书一起拼进 PEM（叶子在前）后重新上传即可。',
      liveUnreachable: '连不上管理台入口',
      liveExpected: '盘上指纹',
      liveActual: '线上指纹',
      liveError: '错误原文：{error}',
      uploadTitle: '上传 / 更新证书',
      uploadIntro: '第一步「解析」只读不写：把整份 fullchain 与私钥粘进来，抽出证书里的域名；确认无误后第二步才真正安装。',
      certLabel: '证书 PEM（可以整份 fullchain，叶子证书在前）',
      certHint: '≤ 64 KiB。粘贴后点「解析证书」，不会立刻生效。',
      keyLabel: '私钥 PEM',
      keyHint: '≤ 64 KiB。只在本页输入框里，提交后立即清空；不进浏览器存储、不进日志、不进地址栏。',
      inspect: '解析证书',
      inspecting: '解析中…',
      inspectEmpty: '服务端没有返回证书信息（响应里没有 cert）。',
      inspectTitle: '解析结果',
      keyMatchesOk: '私钥与证书配对',
      keyMismatchBad: '私钥与这张证书不配对：装上去管理台入口会握手失败，不能安装',
      keyNotProvided: '没有提供私钥，无法判断是否配对',
      domainsTitle: '这张证书要覆盖的域名',
      domainsIntro: '已按证书里的 SAN 预填（没有 SAN 时用 CN）。可以改、可以删、可以加；但加不出证书覆盖不到的名字（后端会拒）。',
      domainsAdminTag: '管理台域名（必须包含）',
      domainAdd: '加一行',
      domainRemove: '删除',
      domainsEmpty: '一个域名都没有：至少保留管理台域名。',
      domainsMustInclude: '必须包含 {host}：不覆盖它的证书后端会拒绝安装。',
      coverageBlocksInstall: '这张证书不覆盖 {host}，后端会拒绝安装。',
      install: '确认并安装',
      installing: '安装中…',
      installOk: '已安装：线上证书已更新，状态卡已刷新。',
      installNeedsKey: '需要私钥才能安装（后端要用它做配对校验）。',
      warnExpired: '这张证书已过期：装上去浏览器会直接拒绝。',
      warnNotYetValid: '这张证书还没生效（notBefore 在未来）。',
      warnNoSans: '这张证书没有 DNS SAN：覆盖判定会退回 CN，现代浏览器不再看 CN。',
      warnNotCovered: '这张证书覆盖不到管理台域名。',
      warnLeafOnly: '这张证书只有叶子一张：Traefik 能加载，但客户端严格校验可能失败（unable to verify the first certificate）。建议把中间证书一起拼进 PEM（叶子在前），可以照常安装。',
      warnChainOrderSuspect: '证书顺序可能是反的：第一段看起来是中间证书，不是你的域名证书。这种形态 Traefik 会直接拒加载这张证书（退回内置自签），请把叶子证书放在最前面。',
      warnChainBroken: '证书链在段间接不上（拼进来的证书不是签发你这张叶子的那张）：客户端一定链校验失败。请核对中间证书。',
      rollbackTitle: '回滚',
      rollbackIntro: '把上一代证书装回线上（只保留一代，回滚不改写备份本身，可以重复点）。',
      rollbackPreviousCN: '上一代 Subject CN',
      rollbackPreviousFingerprint: '上一代指纹',
      rollbackPreviousSavedAt: '备份时间',
      rollback: '回滚到上一代',
      rollingBack: '回滚中…',
      rollbackConfirmTitle: '确认回滚？',
      rollbackConfirmBody: '回滚会立刻把上一代证书装回线上（管理台入口会重载）。这一步不能从界面撤销，只能再上传一次。',
      rollbackConfirmYes: '确认回滚',
      rollbackConfirmNo: '取消',
      rollbackOk: '已回滚：状态卡已刷新。',
      errCertInvalid: '证书 PEM 解析不出来（400 tls_cert_invalid）：',
      errKeyInvalid: '私钥 PEM 解析不出来（400 tls_key_invalid）：',
      errKeyMismatch: '私钥与证书不配对（400 tls_key_mismatch）：',
      errCertExpired: '证书已过期（400 tls_cert_expired）：',
      errDomainMismatch: '证书覆盖不到要求的域名（400 tls_cert_domain_mismatch）：',
      errDomainMissing: '缺少：{missing}',
      errNoPrevious: '没有可回滚的上一代证书（404 tls_no_previous）：',
      errValidation: '参数不合法（400 validation_failed）：',
      errRateLimited: '操作太频繁（429 rate_limited）：请 {seconds} 秒后再试。',
      errRateLimitedNoRetry: '操作太频繁（429 rate_limited）：请稍后再试。',
    },
    // issue #350：预览号池占用总览（views/PreviewPoolUsageView.vue）。**只读**：本页零写操作、
    // 不提供「一键用这段」，也不碰改块输入框（#256 口径：显式指定的段被占要报错，禁止偷偷换段）。
    previewPool: {
      title: '预览号池占用总览',
      intro: '只读快照：哪几段被谁占、哪几段整段空闲。给 FDE 选段（改块）之前先看这里，别再靠试错。',
      loading: '正在读取号池占用…',
      notLoaded: '尚未加载号池占用（还没请求）。',
      poolRange: '号池 {start}–{end}：每段 {size} 个端口，共 {total} 段。',
      poolMissing: '服务端没有给出号池边界（pool 缺失）：本页只显示它明确给出的数，不推断段边界。',
      summaryTitle: '汇总（按段计）',
      summaryTotal: '总段数',
      summaryFree: '整段空闲',
      summaryPartial: '部分占用',
      summaryOccupied: '整段占满',
      unknownValue: '—',
      occupiedTitle: '被占用的段（{count} 段）',
      occupiedEmpty: '服务端说当前没有任何被占用的段。',
      occupiedMissing: '服务端没有给出被占用段列表（occupied_blocks 缺失）。',
      occupiedCount: '{count} 个活行',
      occupiedCountUnknown: '活行数未给出',
      occupiedBy: '占用者：{names}',
      occupiedByUnknown: '占用者未给出',
      freeTitle: '整段空闲的段（已列出 {count} 段）',
      freeEmpty: '服务端说当前没有整段空闲的段。',
      freeMissing: '服务端没有给出空闲段列表（free_blocks 缺失）。',
      freeMore: '只显示前 {shown} 段，还有更多（服务端 limit={limit}）：别以为号池只剩这些。',
      freeMoreNoLimit: '只显示前 {shown} 段，还有更多：别以为号池只剩这些。',
      partialTitle: '注意：{count} 个段被「部分占用」——选段时要避开',
      partialBody: '这些段里已经有 1 到「每段端口数 − 1」个活行，它们不是空闲段（也不在空闲列表里）。改块选段请绕开它们，否则服务端会 409。',
      inconsistent: '服务端返回的数自相矛盾（{issues}）：本页按原样显示，请勿据此选段。',
      issueSep: '；',
      issue: {
        total: '总段数 ≠ 空闲 + 部分占用 + 整段占满',
        occupiedList: '被占用段列表比 occupied 计数还多',
        freeList: '空闲段列表比 free 计数还多',
        hasMore: 'has_more=true 但 free 计数不大于已列条数',
      },
    },
    // LLM 供应商/模型区（AdminView #llmSection + UserLlmPane）
    // issue #586：「关于」面板（views/AdminAboutView.vue，契约 docs/api/portal.md §4.16）。
    // 重心不在「有个版本号」，在**三格各自是谁、各自从哪儿读**：v0.1.69 那次 portal 烘了停在 0.1.68 的
    // 旧工作树，两边分裂一小时而界面上一个读面都没有 ⇒ 文案必须让人一眼看出哪格不作准。
    about: {
      title: '关于本站',
      intro: '只读。三个版本号各来自一处、互不代替：服务端与平台侧引擎读 portal 镜像里烘的 build-info.json；每台 FDE 的引擎读库里的派生副本。',
      loading: '正在读取版本信息…',
      notLoaded: '尚未加载版本信息（还没请求）。',
      fieldVersion: '版本',
      fieldRevision: '构建修订（git revision）',
      fieldBuiltAt: '构建时刻',
      unknown: '未知',
      unparsable: '无法解析：{value}',
      serverTitle: '服务端（portal 镜像）',
      serverHint: '这一格说的是 portal 容器自己在跑哪份构建。',
      sourceBuildInfo: '来源：镜像内 build-info.json（构建产物，唯一权威）',
      sourceEnv: '来源：环境变量显式覆盖（测试 / 临时钉版本用的），不是镜像里烘的那份',
      sourcePackage: '来源：本地 package.json（源码态退路，不是镜像里的构建产物）',
      sourceUnknown: '来源：未知（build-info.json 与 package.json 都没读到）',
      sourceUnknownShape: '来源：服务端没给或给了不认识的形状（不猜）',
      // 实际去读的 build-info 路径（`STATION_BUILD_INFO_PATH` / `ERIX_BUILD_INFO_PATH` 能改它 ⇒ 必须可见）。
      buildInfoPath: '读取路径：{path}',
      engineTitle: '平台侧引擎（portal 镜像内的 erix-agent）',
      engineHint: 'portal 进程自己用的那份引擎，不是每台 FDE 里跑的那份——那是下面第三格。',
      // 引擎那格的来源标注：跟着服务端推导出的 provenance 走（前端不自己判）。
      // `package.json` = 源码态退路 / 这份镜像里根本没烘 build-info.json（旧镜像）⇒ 不许顶着「构建产物」的标签。
      engineSourceBuildInfo: '来源：镜像内 build-info.json 的 engine_version（构建产物，唯一权威）',
      engineSourcePackage: '来源：本地 node_modules/erix-agent/package.json —— 源码态退路，或这份镜像里根本没有 build-info.json（旧镜像），不是镜像里的构建产物',
      engineSourceEnv: '来源：环境变量覆盖（portal 侧本不该出现，出现就说明它不是镜像构建产物）',
      engineSourceUnknown: '来源：未知（build-info.json 与 package.json 都没读到）',
      engineSourceUnknownShape: '来源：服务端没给或给了不认识的形状（不猜）',
      fdesTitle: '每台 FDE 的引擎',
      fdesHint: '读的是 containers.agent_version —— 派生副本，不作准。',
      snapshotProvision: 'provision 时快照',
      snapshotUnknown: '口径未给出',
      fdeProvisionedAt: 'provision 于 {at}',
      revoked: '已吊销',
      fdesEmpty: '服务端说当前没有 FDE 容器。',
      fdesUnreadable: '读不到 containers.agent_version（这是「读不到」，不是「没有 FDE」）。',
      caveat: '口径：唯一权威是镜像内烘的 build-info.json；package.json 只是构建输入，而 git tag / 镜像 tag / digest / containers.agent_version 都是派生副本，展示时必须标口径。',
    },
    llm: {
      sectionTitle: 'LLM 供应商',
      emptyProviders: '暂无供应商，先在下方新增。',
      // 模型明细展开按钮：{count} 为模型数量
      modelsCount: '模型明细（{count}）',
      collapseModels: '收起模型',
      emptyModels: '该供应商下暂无模型',
      colCallName: '调用名（FDE 请求实际发的名字）',
      colDisplayName: '显示名',
      editCallNameHint: '数据面真名：FDE 请求里发的就是它，`fde_llm_bindings.*_model_name` 与虚拟 key 白名单存的都是它。改了会立刻同步到这些 FDE 的绑定与白名单（新旧名并存，在途请求不断）。',
      editDisplayNameHint: '只改管理台/选择器里的展示，不影响 FDE 请求里发的名字。',
      callNameRequired: '调用名不能为空：它是 FDE 请求实际发的名字。',
      duplicateCallName: '调用名重复',
      duplicateCallNameHint: '多个模型共用同一个调用名：网关按名字选 deployment，会在它们之间轮询，而模型列表里只列一个。',
      confirmCallNameTitle: '确认修改调用名',
      confirmCallNameBody: '把调用名从 {from} 改成 {to}：FDE 请求里实际发的名字会跟着变，正在跑的任务也会立刻改用新名。',
      confirmCallNameWarning: '旧名会从路由里消失（白名单保留旧名，所以不再伪装成 auth 错误），仍在发旧名的请求会失败。',
      confirmCallNameAction: '确认改名',
      colType: '类型',
      colContextWindow: '上下文窗口',
      colMaxTokens: '最大输出 tokens',
      // #309：下面这组键只服务 `max_output_tokens` 一个字段（门户侧只有一个拼写）。
      // 列表里显示的是后端算好的**生效值**（没手填过时 = 上下文窗口的 1/4）。
      colMaxOutputTokens: '输出预算上限 tokens',
      // #314：「留空 = 不修改」必须是明文，且要写明**新建与编辑不对称**（新建发显式 `null`、编辑是省略字段）——
      // 这是管理员困惑的直接来源（#317 已记在 §4.9，界面上也得说清）。
      maxOutputTokensHint: '引擎侧把它当单次响应的输出预算上限。上限 = 上下文窗口的 1/4（由服务端校验，超限会被拒）。新建时留空 = 不写这个字段（不是「不修改」，新建没有现值），后端会按窗口的 1/4 假定一个生效值并下发。',
      editMaxOutputTokensHint: '留空 = 不修改（编辑发的是 PATCH，留空就是不带这个字段）。上限 = 上下文窗口的 1/4，超限由服务端拒绝；列表里显示的始终是生效值（没配过时按窗口 1/4 假定）。',
      maxOutputReset: '按当前窗口 1/4 重设',
      maxOutputResetHint: '把上面那个框填成「当前窗口的 1/4」，只是**填值、不会自动保存**（真网关清不掉这个字段，#314；想停止手填覆盖就重设后保存）。',
      maxOutputResetNeedsWindow: '没填窗口 ⇒ 算不出 1/4，先填上下文窗口。',
      colPricing: '定价',
      inputCostLabel: 'Input 单价（USD / 1M tokens）',
      outputCostLabel: 'Output 单价（USD / 1M tokens）',
      pricingMissing: '未设定价',
      pricingHintAdd: '选填。留空表示未设定价 → 该模型用量金额将记 0（LiteLLM 按每 token 单价计价，input/output 两项都需填写）。',
      pricingHintEdit: '留空保持现有值不变；填写后改为本模型显式定价。',
      pricingFromCostMap: '当前定价来自 LiteLLM 内置价目表（未显式设定）。',
      pricingClear: '清空定价（改为未设定价）',
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
      editMaxTokensHint: '留空保持现有值不变。',
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
    mailOtpSection: '邮件验证码',
    mailOtpHint: '为该用户启用邮箱验证码作为第二因素。这是按用户的开关，与 TOTP 并列；邮件通道（SMTP）只决定「能不能发信」。',
    mailOtpEnabledLabel: '登录时要求邮箱验证码',
    mailOtpEnabledHint: '关闭时该用户只用口令登录（没有第二因素）。',
    // #449 二选一（`second_factor_choice`）：已绑 TOTP 的账号不再「本开关不生效」，而是多一条可走的路；
    // 审计口径（较弱的那一条记 `email_code_alt`）必须写在这里，运维才不会以为开了就是强二因素。
    mailOtpEnabledLabelAlt: '邮件验证码（作为 TOTP 的替代方式）',
    mailOtpAltHint: '该账号已启用 TOTP。打开后，登录时可用 TOTP 或邮箱验证码任一通过；邮件码路径会在审计里记为 email_code_alt。',
    mailOtpCurrentEmail: '验证码将发到：{email}',
    mailOtpNeedsEmail: '该用户还没有邮箱 —— 请先在「基本资料」里填写，否则无法启用。',
    // 工单 feat-261110-03：「二次验证」改成两个勾选框 + 勾上才展开。
    // 这一句是**两个都没勾**时的红字。口径不是「两个 checkbox 都没勾」而是「这个账号现在拿不出
    // 第二因素」：`chooseSecondFactor` 的 `totpUsable` 还要看「绑没绑密钥」，所以上线迁移 0030 后
    // 「未绑定但 `totp_login_enabled` 为默认 true」的存量账号也算没有第二因素，红字照旧要出现。
    mailOtpSwitchWarning: '该账号将只用口令登录（没有第二因素）。',
    // 勾选框行上的短标签（长句说明仍在折叠块里的 mailOtpEnabled* / mailOtpAlt 那几条）。
    mailOtpCheckboxLabel: '邮件验证码',
    totpLoginEnabledLabel: '验证器应用（TOTP）',
    totpEnrolledState: '已绑定',
    totpNotEnrolled: '未绑定',
    saveMfaSettings: '保存二次验证设置',
    mfaSettingsSaved: '二次验证设置已保存。',
    // 2026-11-09（#472 片 A）：per-user「文件上传」开关（迁移 0029 / docs/api/portal.md）。
    // 开关只决定「能不能传」，服务端 403 才是闸；界面把三态说清（开启 / 关闭 / 未知）。
    fileUploadSection: '文件上传',
    fileUploadHint: '允许该用户从工作台往自己的工位目录上传文件。这是按用户的开关，与 TOTP / 邮件验证码同一口径：新建账号一律关闭，需管理员在这里显式打开。',
    fileUploadEnabledLabel: '允许上传文件',
    fileUploadEnabledHint: '关闭时上传会被服务端拒（403），工作台上也不会出现上传入口。停用后重新开户的账号会被清零，需重新打开。',
    fileUploadUnknown: '未知（该账号的开关未能读取，刷新后重试）—— 未知不等于已关闭，所以保存暂时禁用。',
    fileUploadSaved: '文件上传设置已保存。',
    saveFileUpload: '保存文件上传设置',
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
      userReactivated: '已重新激活既有 FDE 账号；历史与审计记录已保留，开户任务已重新排队。',
      llmBindingFailed: 'LLM 绑定失败',
      offboardingQueued: '已开始下线；账号立即停用，资源正在清理。',
      retryOffboarding: '重试下线',
      offboardingRetryQueued: '下线任务已重新排队。',
      offboardingTitle: '下线状态',
      workspacePurgeAfter: 'workspace 计划于 {date} 清理',
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
        'revoke-git-account-access': '吊销上游 Git 账号访问',
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
      // feat-261110-02：TOTP 与邮件验证码从「安全」里搬出来单独一档。
      editTabMfa: '二次验证',
      editTabLlm: 'LLM 与仓库',
      editTabPorts: '预览端口',
      editTabDanger: '危险操作',
      basicProfileSection: '基本资料',
      llmSection: 'LLM 绑定',
      dangerSection: '危险操作',
      totpSection: 'TOTP 设置',
      totpSectionHint: '管理该用户的 TOTP 注册状态；重新注册会立即使旧密钥失效。',
      // issue #497（迁移 0031）：「最后活动」= 最近一次用户输入，与「最近登录」是两个维度。
      // ⚠ 旧键 `lastLogin`（'最近登录'）已删：第 8 格换了语义之后它**零引用**（现验
      //   `grep -rn "fde\.lastLogin'" portal/frontend/src` 只剩 spec 里的反向断言），
      //   留着会让后来人以为那一格还是登录列。**只删这一个键**：下面 `neverLoggedIn` 仍在用
      //   （副行「登录于 …」与清退日期两格都读它）——相邻两键一起删是本单实际踩过一次的坑。
      neverLoggedIn: '从未登录',
      // ⚠ 措辞红线：「从未活动」/「从未登录」两个词必须分开，且都不许写成「今天」或留空
      //（空值渲染成「今天」= 没数据却做出承诺）。副行的「登录于 …」在从未登录时整行不渲染。
      lastActivity: '最后活动',
      neverActive: '从未活动',
      loginAt: '登录于 {time}',
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
      deleteUser: '停用用户',
      deleteUserTitle: '停用用户并下线',
      deleteUserHint: '账号将立即停用并开始 FDE 下线；用户记录永久保留，workspace 默认不会自动清理。请输入登录名 {login} 以确认。',
      deleteLoginLabel: '输入登录名确认',
      deleteLoginPlaceholder: '输入登录名',
      confirmDeleteUser: '停用账号并开始下线',
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
      totpReactivatedTitle: '用户已重新激活 · TOTP 设置',
      totpEnrollTitle: 'TOTP 已绑定 · 一次性密钥',
      qrAlt: 'TOTP 认证器二维码',
      // 一次性 TOTP 盒：{login} 与 {onlyOnce} 由模板插槽加粗（见 AdminView 模板）
      totpCreated: '用户 {login} 已创建。请用认证器 App 录入以下 otpauth URI 或种子（{onlyOnce}）：',
      totpReactivated: '用户 {login} 已重新激活，旧 TOTP 已替换。请用认证器 App 录入以下 otpauth URI 或种子（{onlyOnce}）：',
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
      githubHint: 'GitHub 无法由平台代铸：请勿配置 admin key，该 host 的模式恒为「需凭据」。每个 FDE 需在 portal 投放自己的 PAT（gh CLI 读取容器内 ~/.config/gh/hosts.yml）。',
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
    // issue #281：工作台初始化（GET /api/dirs 那一站）失败的**可见**文案。此前 onMounted 里的 await
    // 没人 catch ⇒ 失败只在控制台，界面停在「选择或新建会话」空态，用户以为服务没起。
    workspaceLoadFailed: '工作台初始化失败：{message}（可刷新重试；持续失败请联系管理员）',
    createSessionFailed: '建会话失败：{message}',
    stopFailed: '停止失败：{message}',
    dirNameInvalid: '目录名只能用小写字母、数字、下划线、连字符；不能以连字符或下划线开头/结尾；最长 63 字符。容器里已存在的目录（哪怕含其它字符）可直接在目录下拉里选中使用。',
    sendFailed: '发送失败：{message}',
    // issue #41：LLM 未绑定预检 409 → 友好指引（fde 角色可能无 /admin 权限 → 措辞兜底「联系管理员」）
    sendFailedLlmNotConfigured: '发送失败：该 FDE 未配置 LLM 上游，请到管理台 /admin 配置（无权限请联系管理员）',
    // 拼在 sendFailed 之后的可选后缀（zh 全角括号、en 前置空格 + 半角括号）
    sendFailedLlmModelNotFound: '发送失败：本 FDE 绑定的模型在 LLM 网关里已不存在（槽位 {slot}，模型 {model}）：请到管理台 /admin 重新选择模型后再发一次（无权限请联系管理员）',
    runInProgress: '（已有进行中任务）',
    treeLoadFailed: '目录树加载失败：{message}',
    // issue #107：侧栏内联重命名——空串本地拦截 / 提交失败回退旧标题时的轻提示
    renameEmpty: '会话名称不能为空',
    renameFailed: '重命名失败：{message}',
    // issue #114：AI 改名失败（message 为服务端文案：409 未配置 LLM / 502 上游失败）
    aiRenameFailed: 'AI 改名失败：{message}',
    // issue #488：隐藏会话失败。409 `run_in_progress` 沿用后端既有拒绝（**D5：不改契约、不加错误码**），
    // 界面只负责给母语提示 + **点名出路**（先停止再隐藏）；其它失败把服务端 message 拼在本地化前缀后
    //（服务端透传的 error.message 不译，沿用 stores/admin.ts 既有口径）。
    hideFailed: '隐藏失败：{message}',
    hideRunInProgress: '这个会话还有任务在跑，先停止再隐藏。',
    // issue #449：邮箱验证码这条链路的错误码文案（码 → 可行动文案，映射见 stores/auth.ts 的
    // EMAIL_LOGIN_ERROR_KEYS）。只写「下一步做什么」；不承诺「重试必成功」，也不写强度口径。
    emailCodeInvalid: '验证码不对或已失效：可以点「重发验证码」换一枚，或返回上一步重新登录。',
    emailNotRegistered: '当前账号未登记邮箱，收不到登录验证码：请联系管理员补录邮箱后再登录。',
    emailSendFailed: '验证码邮件这次没发出去：点「重新发送」再试一次，不用重新输入口令。',
    pendingExpired: '这次登录等待已过期：请重新输入登录名与口令。',
  },
  gitLight: {
    loading: '检查中…',
    partialBadge: '未查完',
    panelAria: '收工灯详情',
    noRepos: '这个目录里没找到 git 仓库。',
    label: { red: '未落地', yellow: '未推送', green: '已收工', grey: '未检查' },
    reason: {
      uncommitted: '有改动还没提交',
      untracked: '有文件还没纳入 git（未跟踪）',
      no_commits: '目录里有内容，但一次提交都没有',
      unpushed_or_diverged: '提交还没推送（或与远端分叉）',
      no_remote: '还没配远端，提交只存在这台机器上',
      no_upstream: '当前分支没有对应的远端跟踪分支',
      never_fetched: '有远端但从没 fetch 过，无法确认是否已推送',
      detached: '游离 HEAD（不在任何分支上）',
      synced: '已提交，且与你已知的远端一致',
      no_repo: '这个目录还不是 git 仓库（工作没有任何保护）',
      covered_by_outer_repo: '没找到独立仓库（外层另有仓库时以工作树为准）',
      empty: '目录是空的',
      unchecked_partial: '还没检查完',
      unchecked_failed: '有仓库没判完',
      busy: '有仓库正忙（git 索引被占用）',
      unreadable: '有仓库读不动',
      git_unavailable: '服务端没有 git，判不了未提交与未跟踪',
      shell: '根目录只是外壳，真正的仓库在它里面',
      unknown: '说不清（服务端给了不认识的状态）',
    },
    tip: {
      partial: '这是没检查完的结果：未检查的部分按未知处理，不得当成已收工。',
      truncatedRepos: '仓库太多，另有 {count} 个目录没检查。',
      gitUnavailable: '服务端没有 git，未提交与未跟踪判不了。',
      greenHonest: '绿只表示与你已知的远端一致；同事推过而你还没 fetch 到的东西，这里看不见。',
      error: '本次检查失败（HTTP {status} / {code}），显示的是上一次结果。',
      checkedAgo: '检查于 {ago} 前。',
    },
    row: {
      shellNote: '外壳目录：真正的仓库在它里面。',
      counts: '{tracked} 处改动 / {untracked} 个未跟踪文件。',
      truncated: '改动条目过多，只数了前 50 条。',
    },
    action: {
      finish: '让 AI 收尾',
      ask: '问 AI',
      refresh: '重新检查',
      finishHint: '只是把话填进输入框，不替你发送（发送就是一次运行）。',
    },
    prefill: {
      thisDir: '这个目录',
      moreSuffix: '（另有 {count} 个未列出）',
      finish: '【收工】请把这些仓库的改动收进 git：{repos}{more}。要求：未跟踪的文件也一并 git add（别漏）；一个目录里有多个仓库就逐个仓库分别提交（父目录的仓库不包含子目录的仓库）；有远端就 push，没远端或没配 upstream 的先问我，别替我猜远端。',
      ask: '【收工检查】这个目录的收工灯报「{state}：{reason}」（目录 {cwd}）。请逐个仓库讲清楚：哪些工作还没被 git 保护、后果是什么、收工要一步步做什么（提交 / 推送 / 配远端）。',
    },
  },
  // issue #528（事件平台 W5）用户面文案。键名按 `07` §21.1 定下的表（键名一旦定就不再改，
  // 改名 = 双语同时改，容易漏一边）。⚠ 原文枚举（`quiet_hours` 等）**不进 UI**：
  // 人话对照在 `lib/macroView.ts` 的 `skipMessageKey` / `verdictMessageKey` 里映射。
  macro: {
    title: '值守流水',
    loading: '加载中…',
    loadFailed: '加载失败',
    retry: '重试',
    chip: {
      enabled: '自动化 · {count} 启用',
      none: '自动化 · 未启用',
    },
    config: {
      title: '配置 ▾',
      intro: '勾选即生效，没有保存按钮；已触发的历史不回滚。',
      userScopeHint: '由管理员代配（用户级，不在会话里订阅）',
      // issue #623：`scope='user'` 模板（如定时任务）在顶栏可自己订阅——选一个 `~/projects/<name>` 目录即可。
      userScopeEnable: '启用',
      userScopeEnabled: '已启用',
      userScopeCancel: '取消订阅',
      userScopeChooseDir: '选择运行目录',
    },
    card: {
      enabledCount: '{count} 个启用',
      lastEvaluated: '上次评估 {at}',
      notEvaluated: '尚未评估',
    },
    health: {
      stale: '⚠ 上次评估在 {minutes} 分钟前，预期每 {everySeconds} 秒一次（超过 {staleAfterSeconds} 秒算陈旧）· 宏可能不生效',
      neverEvaluated: '⚠ 这些模板还没被评估过 · 宏可能不生效',
      nextStep: '持续不刷新请让管理员看执行器状态。',
    },
    filter: {
      template: '模板',
      verdict: '判决',
      allTemplates: '全部模板',
      allVerdicts: '全部判决',
      clear: '清除筛选',
      status: '状态',
      allStatuses: '全部状态',
      from: '起（含）',
      to: '止（含）',
      user: '用户',
      allUsers: '全部用户',
    },
    status: {
      pending: '排队中',
      running: '进行中',
      done: '已完成',
      skipped: '已跳过',
      failed: '失败',
      superseded: '已被取代',
      unknown: '状态未知',
    },
    // `07` §6.1 的唯一用词（旧稿的「未通过」「未达成」已全部替换）。
    verdict: {
      pass: '通过',
      red: '整改',
      noop: '未证实有改动',
      human: '需人工',
      unclassified: '未判',
    },
    // `09` §3.3 的人话对照。`humanPresent` **写中性事实不归责用户**（不写「因为你在说话」）。
    skip: {
      budget: '今日额度用完',
      quietHours: '静默时段（22:00–08:00）',
      humanPresent: '你刚发了消息，不插话',
      runInProgress: '会话里有 run 在跑',
      deferred: '会话里有 run 在跑，等它结束再送',
      deferredTimeout: '等排位超过 10 分钟，放弃',
      activeRunInCwd: '同一目录有 run 在跑',
      cancelledByUser: '你取消了值守',
      unknown: '被门禁挡下（原因未知）',
      aggregate: '最近 {count} 次同原因',
    },
    kind: {
      runNotify: '终态通知',
      runSilence: '静默告警',
      runReview: '完成审查',
      scheduledTask: '定时任务',
      unknown: '未知类型',
      desc: {
        runNotify: 'run 进终态时通知你',
        runSilence: '工具卡住超过阈值时告警',
        runReview: 'run 结束后审一遍，整改一次',
        scheduledTask: '每天固定时刻自己起一个宏会话',
        unknown: '这个类型还没有说明',
      },
    },
    field: {
      name: '名称',
      states: '盯哪些终态',
      channel: '通知渠道',
      threshold: '静默阈值',
      phases: '盯哪些相位',
      reviewDepth: '审查深度',
      onFail: '不过怎么办',
      maxRounds: '最多几轮',
      at: '时刻',
      cwd: '目录',
      task: '任务描述',
    },
    action: {
      regenerate: '重新生成',
      stopRun: '停止 run',
      openSettings: '打开设置',
      refresh: '刷新',
      close: '关闭',
      back: '返回',
    },
    detail: {
      depth: '深度 {depth}',
      noAction: '已执行',
    },
    // `07` §15：逐条实测、汇总标「估算」且默认折叠；单价未定 ⇒ 只给 token 不给钱。
    cost: {
      tokens: 'token',
      monthly: '本月',
      triggers: '本会话 {count} 次触发',
      unknown: '用量未知',
      estimateToggle: '估算详情',
      estimateHint: '估算（单价来自定价配置，可能不准）',
    },
    // `07` §17.2 的业务空态（技术态另走 `loading` / `loadFailed`）。
    empty: {
      noSubscription: '这个会话没挂模板',
      neverTriggered: '已启用 {count} 个，还没触发过。上次评估 {at}',
      filtered: '没有匹配的记录',
      chooseTemplate: '选择模板',
    },
  },
  // `07` §21.3：独立 `notifications` 表 + 顶铃铛（不复用会话流）。
  notifications: {
    title: '通知',
    aria: '通知，未读 {count} 条',
    loading: '加载中…',
    failed: '通知加载失败',
    empty: '暂无通知',
    markRead: '标记已读',
  },
  // `07` §21.4：侧栏单独分组「自动化」，默认折叠，组内会话**不允许发消息**。
  macroSidebar: {
    group: '自动化',
    readOnlyHint: '宏会话只读，不能在这里发消息',
  },
} as const;

/**
 * 消息 schema：由 zh-CN（key 权威来源）递归推导，叶子值放宽为 string。
 * 用途：① createI18n<[MessageSchema], AppLocale> 泛型；② DefineLocaleMessage 注入（见 ../types.d.ts）。
 * 之所以放宽叶子：en 的文案字面量与 zh-CN 不同，schema 只约束键结构 + 叶子类型（string）。
 */
export type MessageSchema = WidenLeaves<typeof zhCN>;

type WidenLeaves<T> = { [K in keyof T]: T[K] extends string ? string : WidenLeaves<T[K]> };
