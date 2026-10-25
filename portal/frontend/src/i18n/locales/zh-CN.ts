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
    title: 'FDE Station 登录',
    loginName: '登录名',
    password: '口令',
    next: '下一步',
    totpHint: '输入认证器 6 位码（本地账号两步登录）。',
    totpLabel: 'TOTP',
    totpSubmit: '验证并登录',
    backToLogin: '← 返回重新登录',
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
    // 试用台账 #10：更早消息分页入口（后端一直分页，前端此前从不取更早批次）。
    loadOlder: '加载更早消息',
    loadOlderLoading: '正在加载…',
    // issue #300：被停止/失败的 run 零助手锚点 ⇒ 正文区本来一片空白；历史端点把已生成的
    // assistant_delta 聚合成一条合成项下发。**中性口径**：既不说「已完成」（它没完成）也不说
    // 「错误」（半截正文不是错），zh 语义必为「已中止 · 部分输出」。
    partialOutput: {
      label: '已中止 · 部分输出',
      truncated: '输出在停止前未生成完全（已截断）',
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
      compaction: '上下文折叠（round {round}）：{folded} 轮折叠，{before} → {after} tokens',
      finalGuard: 'final guard：{action}{dash}',
      forcedFinal: 'forced final（round {round}）：{reason}',
      runEnd: 'run 结束：{reason}{usage}',
      runEndNormal: '正常完成',
      missedRunEnd: '连接中断期间该 run 已结束（详情见运行记录）',
      runFailed: 'run 失败：{code} — {message}',
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
    // 冻结判据：最后一次流式/工具事件距今 > RUN_FROZEN_THRESHOLD_MS（5s）⇒ 状态条标黄 + 这句
    frozen: '上游已 {sec}s 无输出',
    // 硬刷新边界（状态条 tooltip）：run_end / usage 不在历史回放白名单
    refreshBoundary: '运行态数字只在本页有效：硬刷新后只保留消息时间戳（run_end / usage 不在历史回放白名单）',
    runningElapsed: '已运行 {dur}',
    runningHint: '该 run 仍在执行：数值每 1 秒刷新',
    messageTimeTitle: '消息时刻',
  },
  // 输入区（components/ComposerBar.vue）
  composer: {
    send: '发送',
    stop: '■ 停止',
    // issue #261B：上一条发送以失败终局收场时的一键重发（仅输入框为空 + 无活跃 run 时可见）。
    retry: '重试上一条',
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
    // 双面板拆分（用户裁定）：端口池=地址维度、进程监听=事实维度，各自按项目分组。
    poolToggle: '端口池使用情况',
    poolToggleCount: '端口池（{count} 个）',
    poolToggleFailed: '端口池（加载失败）',
    procToggle: '进程监听情况',
    procToggleCount: '进程监听（{count} 个）',
    procEmpty: '项目里没有进程在监听。',
    spareGroup: '空闲（{count}）',
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
      previewPool: '号池占用',
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
      editTabLlm: 'LLM 与仓库',
      editTabPorts: '预览端口',
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
    sendFailedLlmModelNotFound: '发送失败：本 FDE 绑定的模型在 LLM 网关里已不存在（槽位 {slot}，模型 id {model_id}）：请到管理台 /admin 重新选择模型后再发一次（无权限请联系管理员）',
    runInProgress: '（已有进行中任务）',
    treeLoadFailed: '目录树加载失败：{message}',
    // issue #107：侧栏内联重命名——空串本地拦截 / 提交失败回退旧标题时的轻提示
    renameEmpty: '会话名称不能为空',
    renameFailed: '重命名失败：{message}',
    // issue #114：AI 改名失败（message 为服务端文案：409 未配置 LLM / 502 上游失败）
    aiRenameFailed: 'AI 改名失败：{message}',
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
} as const;

/**
 * 消息 schema：由 zh-CN（key 权威来源）递归推导，叶子值放宽为 string。
 * 用途：① createI18n<[MessageSchema], AppLocale> 泛型；② DefineLocaleMessage 注入（见 ../types.d.ts）。
 * 之所以放宽叶子：en 的文案字面量与 zh-CN 不同，schema 只约束键结构 + 叶子类型（string）。
 */
export type MessageSchema = WidenLeaves<typeof zhCN>;

type WidenLeaves<T> = { [K in keyof T]: T[K] extends string ? string : WidenLeaves<T[K]> };
