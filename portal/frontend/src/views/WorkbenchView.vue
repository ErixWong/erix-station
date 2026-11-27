<script setup lang="ts">
// 工作台壳（P2）：侧栏（移动端抽屉）+ 消息流 + composer + 深链/自动跟随。
// 深链 #/session/<id> 已迁入 vue-router（/session/:id 路由，issue #55 B1 语义平移）：
//   列表内直开 / 跨项目切项目后打开（写回深链）/ 404 静默回退清路由 / 其他错误保留路由 + 报错。
// popstate（前进/后退）由 vue-router hash 模式驱动路由参数变化 → 本组件 watcher 等价旧 popstate 处理器。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { setWorkbenchHooks, useWorkbenchStore, type FoldedOriginalState } from '../stores/workbench';
// issue #431：用户 scope 结束的接线（注册方，触发方在 stores/auth.ts）。
import { setUserScopeResetListener } from '../lib/userScope';
import { AUTO_FOLLOW_GAP } from '../lib/constants';
// issue #816 第③⑥步：折叠呈现的派生全部在纯函数里（模板只塞插值；竖串定位是纯数学，不量 DOM）。
import { foldFootprint, foldHeadline, foldRange, foldRailNodes, type FoldEntry } from '../lib/foldIndex';
import { useSidebarWidth, SIDEBAR_MAX, SIDEBAR_MIN } from '../composables/useSidebarWidth';
import SidebarPanel from '../components/SidebarPanel.vue';
import StreamPanel from '../components/StreamPanel.vue';
// issue #816 第④步a：面板行「查看原文」的渲染本体（与 StreamPanel 旧横幅共用同一份实现）。
import FoldOriginalTurns from '../components/FoldOriginalTurns.vue';
// issue #282：输入框上方常驻动量状态条（run 级量化信号；消息级时刻在 StreamPanel 里）。
import RunStatusBar from '../components/RunStatusBar.vue';
import ComposerBar from '../components/ComposerBar.vue';
import QueuedInputsBar from '../components/QueuedInputsBar.vue';
// issue #592：子 run 活动面板（设计 §4.3 的落点：状态条**下方**、队列条**上方**，读序
// 「现在在跑什么 → 还排队说什么 → 输入框」）。徒标在 `RunStatusBar` 尾部，两边读 store 里同一份账。
import DelegateActivityBar from '../components/DelegateActivityBar.vue';
import SessionPickerModal from '../components/SessionPickerModal.vue';
import LocaleSwitch from '../components/LocaleSwitch.vue';
// issue #359（决策 §7 D9）P0b：顶栏「收工灯」——只回答“你的活儿被 git 保护住了吗”，平台零 git 写。
import GitLightBadge from '../components/GitLightBadge.vue';
import UsageBadge from '../components/UsageBadge.vue';
// issue #528（事件平台 W5）：宏用户面三件——会话头的「自动化」chip、顶栏铃铛、覆盖式流水抽屉。
// 入口职责分开（`07` §3.1）：chip 只开抽屉，抽屉里的 [配置 ▾] 只开模板下拉。
import MacroMenu from '../components/MacroMenu.vue';
import MacroDrawer from '../components/MacroDrawer.vue';
import MacroBell from '../components/MacroBell.vue';
import { useMacroStore } from '../stores/macro';
import { useGitLight } from '../composables/useGitLight';
import { useMyUsage } from '../composables/useMyUsage';
import { toDisplayText } from '../api'; // issue #281：失败详情进文案前过一道收口（不渗 [object Object]/undefined）

// issue #101 P2：顶栏文案走 i18n（workbench.* / common.*）；LocaleSwitch 挂登出旁（#821 后顶栏不再有「管理台」入口）。
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const store = useWorkbenchStore();

// ---- issue #90：侧栏宽度拖拽调整（钳制/持久化/键盘微调在 composable 内）----
const sidebar = useSidebarWidth();

// 旧 who 文案：`login（role / fde_name）`，无 fde_name 时只显示 role。
// issue #101 P2：括号形态随语言（zh 全角 / en 半角），两种形态各一个 key（模板插值）。
const who = computed(() => {
  const u = auth.user;
  if (!u) return '';
  return u.fde_name
    ? t('workbench.who', { login: u.login, role: u.role, fde: u.fde_name })
    : t('workbench.whoNoFde', { login: u.login, role: u.role });
});

// ---- issue #528：宏用户面的接线 ----
const macro = useMacroStore();
const macroDrawerOpen = ref(false);
/** 抽屉的会话指向：`string` ⇒ 会话级；`null` ⇒ 用户级全局（issue #614）。 */
const macroDrawerSessionId = ref<string | null>(null);

/** 会话头 chip：开该会话的流水抽屉（`07` §3.1——不在这里开模板下拉）。 */
function openSessionMacroDrawer(): void {
  if (!store.sessionId) return;
  macroDrawerSessionId.value = store.sessionId;
  macroDrawerOpen.value = true;
  void macro.openDrawer(store.sessionId);
}

/** 顶栏用户级 chip：开用户级全局流水抽屉（跨会话；流水走 `/api/macro-runs`，卡片显示用户级模板）。 */
function openUserMacroDrawer(): void {
  macroDrawerSessionId.value = null;
  macroDrawerOpen.value = true;
  void macro.openDrawer(null);
}

function closeMacroDrawer(): void {
  macroDrawerOpen.value = false;
  macro.closeDrawer();
}

/** 切会话 ⇒ 会话抽屉与面板数据一起收（不要把上一个会话的订阅/流水留在屏上）。
 *  用户级抽屉不绑会话（issue #614），切会话不把它关掉。 */
watch(() => store.sessionId, () => {
  if (macroDrawerOpen.value && macroDrawerSessionId.value !== null) closeMacroDrawer();
  macro.reset();
});

// ---- 路由钩子注入（store 保持 router 无关，便于单测）----
setWorkbenchHooks({
  onClearRoute: () => router.replace('/'),
  onDeepLinkRestored: (sid) => router.replace(`/session/${encodeURIComponent(sid)}`),
});

// issue #431：把「本轮用户结束 → 工作台不再归属任何人」注册到应用级信号上（`auth.logout()` / 会话
// 过期都会 notify）。**只注册不注销**：`onUnmounted` 里清掉就等于重新漏掉「从管理台登出」那条路径——
// 卸载后 listener 仍指向同一个 pinia 单例，正是需要的语义。口径详见 lib/userScope.ts。
setUserScopeResetListener(() => { store.claimOwnership(null); });

// ---- 深链解析（resolveHashSession 语义平移；popstate = 路由参数变化）----
watch(
  () => route.params.id,
  async (sid) => {
    if (sid) {
      if (String(sid) === String(store.sessionId)) return;
      // issue #863：Vue **不等 watcher 返回的 Promise**（与 `onMounted` 那条 #281 注释同一个道理）。
      // 点侧栏/下拉换会话会走到这里，`resolveRouteSession` 收尾阶段抛错（例：环境里没有 EventSource）
      // 就演成未捕获拒绝：界面不动、什么也不说，而且能让整条前端闸 rc=1 而用例全绿（#862）。
      try {
        await store.resolveRouteSession(String(sid));
      } catch (e) {
        store.pushStreamError(t('errors.sessionLoadFailed')); // 与深链同一个 key，中英已翻
        console.error('Failed to resolve route session', e);
      }
    } else if (store.sessionId) {
      store.resetSessionView();
    }
  },
);

// issue #863：调用方是 `void onSelectSession(id)`（会话浏览）与侧栏模板绑定
// `@select-session="onSelectSession"`——两处都把返回的 Promise 丢掉 ⇒ **本函数不许把拒绝传出去**，
// 否则同会话分支的 `await store.openSession(id)` 一旦在收尾阶段抛错就是未捕获拒绝（#281 同一个道理，
// 代价见 #862/#864：整条前端闸可以 rc=1 而用例全绿）。收尾形状照下方 `onMounted` 那道 catch：
// **不重试**，只把失败变成界面上看得见的错误行。
async function onSelectSession(id: string) {
  try {
    // 评审修复：同会话重开只刷新（旧 replaceState 语义），不重复 push 历史
    if (String(id) === String(store.sessionId)) {
      await store.openSession(id);
      return;
    }
    drawerOpen.value = false; // issue #55 B4：移动端选中会话后自动收起抽屉
    await router.push(`/session/${encodeURIComponent(id)}`);
  } catch (e) {
    store.pushStreamError(t('errors.sessionLoadFailed'));
    console.error('Failed to open session', e);
  }
}

async function onNewSession() {
  const s = await store.createSession();
  if (s) await router.push(`/session/${encodeURIComponent(String(s.id))}`);
}

async function onLogout() {
  // issue #428/#431：本地收摊（关 SSE + 清上一个账号的可见面）由 `auth.logout()` 开头的
  // `notifyUserScopeReset()` 统一触发（三颗登出按钮共用那一个汇合点），本视图只需注册
  // `setUserScopeResetListener`（见上方），不在这里再抄一份。
  await auth.logout();
  router.replace('/login');
}

// ---- issue #94：Ctrl/⌘+K 全局快捷键打开会话浏览（scope='all' 跨目录找回）----
const pickerOpen = ref(false);
function onGlobalKeydown(e: KeyboardEvent) {
  // 组合键判定：Ctrl/⌘+K 且非输入法组合（e.isComposing）——普通键入不经此拦截，不与输入框冲突
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  if (e.key.toLowerCase() !== 'k' || e.isComposing) return;
  e.preventDefault();
  pickerOpen.value = true;
}
onMounted(() => window.addEventListener('keydown', onGlobalKeydown));
onUnmounted(() => window.removeEventListener('keydown', onGlobalKeydown));
function onPickerSelect(id: string) {
  pickerOpen.value = false;
  void onSelectSession(id); // 复用现有深链逻辑（同会话刷新 / 跨目录 / 路由 push）
}

// ---- issue #308：预览端口段已从本视图的顶栏横条搬进左侧栏底部（SidebarPanel 内，与目录树各自折叠）----
// 数据所有权也跟着走：usePreviewPorts + onMounted(load) 现在在 SidebarPanel（侧栏在工作台挂载时恒在，
// 折叠只是不占位）⇒ 「进视图就拉一次、折叠也拉、ticket 绝不预取」的语义逐字不变，
// 只是不再占消息流上方的垂直空间。本视图不再碰 /api/me/ports。

onMounted(async () => {
  if (!auth.user) return; // 守卫保证已登录
  // issue #428：SPA 登出**不重载页面** ⇒ 本视图重挂载时 workbench store 还是上一个账号的。
  // 第一步就按当前登录者认领（身份变了则先全量复位），且必须在 `initWorkspace` 之前同步跑完。
  store.claimOwnership(String(auth.user.id));
  // issue #281：**Vue 不等 onMounted 返回的 Promise** ⇒ 里面每一个 `await` 都必须自己收尾，否则一次
  // /api/dirs 失败就是 Unhandled Rejection（代价真实发生过：v0.1.7 打 tag 时 CI 步骤④ 就红在这两个
  // 无 catch 的 await 上，AGENTS §4 与 §8.20）。本地 catch ≠ 加一层重试：**不重试**，只把失败变成
  // 界面上看得见的错误行（以前是「空着像服务没起」，只有控制台知道）。准入闸（lib/workbenchGate.ts，
  // #332/#334）不在本钩子里，本钩子只改失败的可观测性，不改谁能进来。
  try {
    await store.initWorkspace();
  } catch (e) {
    store.pushStreamError(t('errors.workspaceLoadFailed', {
      message: toDisplayText(e instanceof Error ? e.message : e),
    }));
    return; // 目录都没拉到，别再走深链（resolveRouteSession 依赖目录/会话列表）
  }
  // issue #55 B1：启动时若路由带 /session/<id>（旧 #/session/<id>），走统一深链解析
  if (!route.params.id) return;
  try {
    await store.resolveRouteSession(String(route.params.id));
  } catch (e) {
    // 深链自己内部已经处理了 404（静默回默认视图）与其他 ApiError（已推 syserr）；走到这里的是
    // **形状意外**（旧后端回包缺键等），同样不许演成未捕获拒绝（#281 的 `session.cwd` TypeError 就属这类）。
    store.pushStreamError(t('errors.sessionLoadFailed'));
    console.error('Failed to resolve route session', e);
  }
});

// ---- issue #55 B4：移动端抽屉（≤768px，Tailwind max-md: 变体替代旧 offcanvas 桥接）----
const drawerOpen = ref(false);
// 切目录/切会话（离开会话）时收起抽屉——旧 switchProject/openSession 的 classList.remove('drawer-open')。
watch([() => store.dirCwd, () => store.sessionId], () => { drawerOpen.value = false; });

// ---- issue #84 P5.4：顶栏 cwd 徽标（📁 短名；hover 全路径；点击复制）----
const dirShortName = computed(() => store.currentDir?.name ?? store.dirCwd?.split('/').pop() ?? '');
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copyCwd() {
  if (!store.dirCwd) return;
  try {
    await navigator.clipboard.writeText(store.dirCwd);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied.value = false; }, 1500);
  } catch { /* 剪贴板不可用（非安全上下文等）：静默降级，title 仍可看全路径 */ }
}

// ---- issue #359 P0b：收工灯（数据层 useGitLight，显示口径 lib/gitLight.ts）----
// 刷新时机（**没有轮询以外的定时器**除外：composable 自带 30s 兵底 + 回前台即刷）：
//   ① 切目录 ⇒ 先 reset 再拉（旧目录的绿不得顶到新目录头上）；
//   ② **一个 run 结束的那一刻**（running 从 true 落 false）⇒ 重判——这是灯最需要新鲜的时刻，
//      用户刚让 AI 干完活，30s 轮询的拖尾在这里不可接受；
//   ③ onMounted 拉一次（initWorkspace 之后才有 dirCwd，所以给 watch 加 immediate）。
const gitLight = useGitLight({ cwd: () => store.dirCwd });
watch(
  () => store.dirCwd,
  (cwd) => {
    gitLight.reset();
    if (cwd) void gitLight.load();
  },
  { immediate: true },
);
watch(
  () => store.running,
  (now, prev) => {
    if (prev && !now) {
      void gitLight.load();
      // issue #808：一个 run 结束的那一刻也是额度最需要新鲜的时刻（刚烧了钱）——与收工灯同一个挂点。
      void myUsage.load();
    }
  },
);

// ---- issue #808：顶栏「账周期/用量」徽标（数据层 useMyUsage，判断 lib/usageLabel）----
// 额度是**人**的维度（不随目录变）⇒ dirCwd 变化不重拉；登录后拉一次 + 60s 轮询（composable 自带）。
const myUsage = useMyUsage();
onMounted(() => {
  if (auth.user) void myUsage.load();
});
/** 弹窗打开 ⇒ 拉 30 天用量（不在挂载预取）；打开期间每 60s 的再拉由 UsageBadge 驱动 `refresh-usage`。 */
function onOpenUsage(): void {
  void myUsage.loadUsage();
}
/** 「让 AI 收尾」/「问 AI」都只预填不发送（发送 = 一次 run，烧容量与 token，得用户自己按）。 */
function onGitLightPrefill(text: string) {
  store.inputValue = text;
}

// ---- issue #55 A2：自动跟随 + 「↓ 最新」悬浮按钮（AUTO_FOLLOW_GAP=80）----
const streamEl = ref<HTMLElement | null>(null);
const autoFollow = ref(true);
const showToLatest = ref(false);

function scrollDown() {
  if (!autoFollow.value) return;
  const el = streamEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}
// 旧 scrollDown() 挂点：消息/分隔行/工具卡片追加 + 流式增量追加（entries.length / deltaText 变化）。
watch(() => store.entries.length, () => nextTick(scrollDown));
watch(() => store.es.deltaText, () => nextTick(scrollDown));
// 试用台账 #10：「加载更早消息」整段前插后锚定滚动位置——新批次把原内容往下顶，不锚定
// 视口就会跳到顶。watch 在 pre-flush 跑：此刻 DOM 尚未重渲染，读到的是**旧**高度；
// nextTick 后新高度已知，把高度差补进 scrollTop 即保持原视觉位置。本 watcher 注册在
// scrollDown 之后 → 同一 flush 内它的 nextTick 回调后执行，锚定值最继覆盖自动贴底。
watch(() => store.olderPrependSeq, () => {
  const el = streamEl.value;
  if (!el) return;
  const prevHeight = el.scrollHeight;
  const prevTop = el.scrollTop;
  nextTick(() => { el.scrollTop = prevTop + (el.scrollHeight - prevHeight); });
});

function onStreamScroll() {
  const el = streamEl.value;
  if (!el) return;
  const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (gap > AUTO_FOLLOW_GAP) {
    if (autoFollow.value) { autoFollow.value = false; showToLatest.value = true; }
  } else if (!autoFollow.value) {
    autoFollow.value = true; showToLatest.value = false;
  }
}

function jumpToLatest() {
  autoFollow.value = true;
  showToLatest.value = false;
  const el = streamEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

// ---- issue #816 第③⑥步：折叠常驻条 + 展开面板 + 右侧竖串 ----
// 数据在 `store.sessionFolds`（会话级、不受消息窗口限制），口径在 `lib/foldIndex`；
// 本视图只做三件事：拼文案、开关面板（视图态）、把 topPct 写成 `top: {pct}%`。

/** 展开面板的开关是**视图态**（默认收起）；换会话复位——不把上一个会话的展开态留给下一个。 */
const foldPanelOpen = ref(false);
const foldPanelEl = ref<HTMLElement | null>(null);
/**
 * issue #816 第④步a：面板行内的「查看原文」展开态（按**落账轮号**记，视图态）。
 *
 * 与旧横幅 #388 同口径：再点一次只是收起，**不清缓存**（`store.foldedOriginals` 里的原文
 * 不删，下次展开直接命中，不重发）；换会话复位（与 `foldPanelOpen` 同一处）。
 * 轮号不是安全整数的折叠行没有可查的轮（拿范围去查端点必然 404）⇒ 连按钮都不渲染。
 */
const foldOriginalsOpen = ref<Record<number, boolean>>({});
watch(() => store.sessionId, () => { foldPanelOpen.value = false; foldOriginalsOpen.value = {}; });

/** 可用于查询端点的轮号（非安全整数 ⇒ null ⇒ 按钮与原文都不出）。 */
function foldQueryRound(fold: FoldEntry): number | null {
  return Number.isSafeInteger(fold.round) ? (fold.round as number) : null;
}

/** 有展开态且有 state（点过「查看原文」）才给状态；否则 undefined ⇒ 整块一个字节都不渲染。 */
function foldRowOriginalState(fold: FoldEntry): FoldedOriginalState | undefined {
  const round = foldQueryRound(fold);
  if (store.sessionId == null || round === null || !foldOriginalsOpen.value[round]) return undefined;
  return store.getFoldedOriginal(store.sessionId, round);
}

/** 点一行「查看原文」= 展开该行并懒加载（命中与否由 store 自己判）；再点 = 收起（不清缓存）。 */
function toggleFoldOriginal(fold: FoldEntry): void {
  const round = foldQueryRound(fold);
  if (store.sessionId == null || round === null) return;
  foldOriginalsOpen.value[round] = !foldOriginalsOpen.value[round];
  void store.loadFoldedOriginal(store.sessionId, round);
}

/** 原文加载失败后的重试：强拉一次（与旧横幅 `retryOriginal` 同口径）。 */
function retryFoldOriginal(fold: FoldEntry): void {
  const round = foldQueryRound(fold);
  if (store.sessionId == null || round === null) return;
  void store.loadFoldedOriginal(store.sessionId, round, { force: true });
}
// #816：展开/收起折叠面板会改变 streamEl 的可视高度（面板是它的**兄弟**、不是子节点：`shrink-0` 抢走
// 一节高度）⇒ 原本贴底的用户，最新内容会被挤出视口，而**没发生滚动** ⇒ `@scroll` 不跑、
// `showToLatest` 连「↓ 最新」都点不亮。所以开关面板后主动复算一次：仍自动跟随就重新贴底，
// 否则按真实间距走 `onStreamScroll` 的同一套间距计算（不写第二份）。
// （注：本 watch 必须放在 `foldPanelOpen` 声明之后 —— `watch(source)` 在 setup 里就地求值，提前写会碰 TDZ。）
watch(foldPanelOpen, () => nextTick(() => {
  if (autoFollow.value) scrollDown();
  else onStreamScroll();
}));

/**
 * 范围文本（**渲染层**，缺陷 #816①）：lib 只给结构（`foldRange`），措辞在 i18n `workbench.foldBar.range*`。
 * 硬编码中文在 `html lang=en` 下会拼出 `Folded 22 rounds · 第 22 轮`（真机实测）。
 * 常驻条 / 面板行 / 竖串卡三处共用本函数 ⇒ 同一折叠在三个位置仍是同一个写法（身份不变量）。
 */
function rangeText(fold: FoldEntry): string {
  const range = foldRange(fold);
  if (range.kind === 'range') return t('workbench.foldBar.range', { from: range.from, to: range.to });
  if (range.kind === 'single') return t('workbench.foldBar.rangeSingle', { to: range.to });
  if (range.kind === 'tail') return t('workbench.foldBar.rangeTail', { to: range.to });
  return t('workbench.foldBar.rangeUnknown');
}

/**
 * 那一行「讲了什么」的那半句，**已与范围去重**：`foldHeadline` 给 `null`（没有可读标题）或给出的标题
 * 正好与范围文本同字 ⇒ `null`，调用方只渲染范围（缺陷 #816②：`Folded 22 rounds · 第 22 轮` 把同一件事
 * 说了两遍）。 */
function headlineText(fold: FoldEntry): string | null {
  const headline = foldHeadline(fold);
  return headline !== null && headline !== rangeText(fold) ? headline : null;
}

/**
 * 常驻条全文：有**与范围不同**的 headline 才拼 ` · {headline}`，否则用 `summaryBare`（#816②）。
 * `rounds` 是「已折叠总轮数」，与最新那条的范围（如 `round 22`）常常是同一个数字 ⇒ 不重复。 */
const foldBarText = computed(() => {
  const rounds = store.foldedThroughRound ?? 0;
  const latest = store.latestFold;
  const headline = latest ? headlineText(latest) : null;
  if (headline === null) return t('workbench.foldBar.summaryBare', { rounds });
  return t('workbench.foldBar.summary', { rounds, headline });
});

/**
 * 竖串节点（`topPct` = `to / max(lastRound, maxTo)`，纯数学）。
 * `lastRound` 取 `session.compaction.lastRound`：前端**没有**会话级「最新轮号」的来源（对话流 DTO 不带
 * `round`，`round_start` 只在实时与历史回放里可见），拿不到就传 `null` ⇒ lib 退化成「最后一条折叠落在
 * 100%」（有意降级，见 `lib/foldIndex#foldRailNodes`）。
 */
const foldNodes = computed(() => foldRailNodes(store.sessionFolds, store.sessionCompaction?.lastRound ?? null));

/** 竖串里 active（实心）那一个的下标：「覆盖最远那条」= `to` 等于 `store.foldedThroughRound`（= max(to)）。
 *  **不是** `foldNodes.length - 1`：后端只按 `from` 升序，末项可以是区间被包住的那条（#816 评审）。
 *  同 `to` 有多条时只标**第一个**命中的（恰好一颗实心）。 */
const activeFoldIndex = computed(() => {
  const target = store.foldedThroughRound;
  if (target === null) return -1;
  return foldNodes.value.findIndex((n) => n.fold.to === target);
});

/** 点竖串节点 ⇒ 打开面板并滚到那一行（**不是**跳到消息流里的对应位置——那是第④步）。
 *  jsdom 不实现 `scrollIntoView` ⇒ 可选调用（真实浏览器才有）。 */
function onFoldNodeClick(index: number): void {
  foldPanelOpen.value = true;
  void nextTick(() => {
    const row = foldPanelEl.value?.querySelectorAll<HTMLElement>('[data-test="fold-row"]')[index];
    row?.scrollIntoView?.({ block: 'nearest' });
  });
}
</script>

<template>
  <!-- 拖拽期间 select-none 防选中文本 -->
  <div class="h-screen flex flex-col bg-white" :class="sidebar.dragging.value && 'select-none'">
    <header class="flex items-center gap-3 border-b border-black/10 px-3 py-2">
      <button
        class="rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5 md:hidden"
        :aria-label="t('workbench.openNavigation')"
        @click="drawerOpen = !drawerOpen"
      >{{ t('workbench.nav') }}</button>
      <h1 class="text-xl font-medium">FDE Station</h1>
      <!-- issue #84 P5.4：cwd 徽标（📁 短名；hover 显示全路径；点击复制） -->
      <button
        v-if="store.dirCwd"
        type="button"
        class="rounded-md border border-black/10 px-2 py-0.5 text-sm hover:bg-black/5"
        :title="t('workbench.cwdCopyTitle', { cwd: store.dirCwd })"
        @click="copyCwd"
      >📁 {{ dirShortName }}<span v-if="copied" class="text-black/40"> {{ t('common.copied') }}</span></button>
      <!-- issue #359 P0b：收工灯（颜色不承重：旁边就有文字；完整口径在 title/aria-label） -->
      <GitLightBadge
        v-if="store.dirCwd"
        :payload="gitLight.payload.value"
        :loading="gitLight.loading.value"
        :error="gitLight.error.value"
        :cwd="store.dirCwd"
        @refresh="gitLight.load()"
        @prefill="onGitLightPrefill"
      />
      <!-- issue #528：会话级宏入口（与收工灯同族的「会话级设置」）。只列 `scope='session'` 的模板。 -->
      <MacroMenu
        v-if="store.sessionId"
        scope="session"
        :session-id="store.sessionId"
        @open-runs="openSessionMacroDrawer"
      />
      <span data-test="who" class="text-black/50 text-sm">{{ who }}</span>
      <!-- issue #808：账周期/用量徽标（紧跟用户名；无绑定时整块不渲染）。flex-1 撑位挪到它**之后**的空 span，
           保证徽标紧跟 who；徽标是 header > button，位置在「登出」之前（既有断言）。 -->
      <UsageBadge
        :quota="myUsage.quota.value"
        :reason="myUsage.reason.value"
        :loading="myUsage.loading.value"
        :loaded="myUsage.loaded.value"
        :error="myUsage.error.value"
        :days="myUsage.days.value"
        :totals="myUsage.totals.value"
        :usage-loading="myUsage.usageLoading.value"
        :usage-error="myUsage.usageError.value"
        @refresh="myUsage.load()"
        @open="onOpenUsage"
        @refresh-usage="myUsage.loadUsage()"
      />
      <span class="flex-1"></span>
      <!-- issue #595 M1：能力市场入口（`#/market`）。用 `<a>` 而不是 `<button>`：既有顶栏单测拿的是
           `header > button` 序列（登出必须是最后一颗），多一颗 button 会把那些用例假红。 -->
      <router-link
        data-test="market-entry-link"
        :to="{ name: 'market' }"
        class="text-sm underline"
      >{{ t('workbench.marketEntry') }}</router-link>
      <!-- issue #528：顶栏那份是**用户级**模板（只读，管理员代配）+ 通知铃铛（未读角标）。 -->
      <!-- issue #614：chip 点击必须打开**用户级**流水抽屉（以前没人接 emit ⇒ 静默丢弃）。 -->
      <MacroMenu scope="user" @open-runs="openUserMacroDrawer" />
      <MacroBell />
      <LocaleSwitch />
      <button
        class="rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5"
        @click="onLogout"
      >{{ t('common.logout') }}</button>
    </header>

    <main class="flex flex-1 min-h-0">
      <!-- 移动端抽屉遮罩（旧 #backdrop） -->
      <div
        v-if="drawerOpen"
        class="fixed inset-0 z-30 bg-black/40 md:hidden"
        @click="drawerOpen = false"
      ></div>
      <!-- 侧栏：≥md 静态；<md 抽屉（旧 offcanvas-md + body.drawer-open 的 Tailwind 等价） -->
      <!-- w-60 改 CSS 变量绑定（仅 ≥md 生效），shrink-0 保留 -->
      <!-- issue #92：aside 改 flex-col 以承载 SidebarPanel 的三段布局（固定头/列表独立滚/底部栈）；
           issue #308：aside 改 overflow-hidden——滚动预算只给两处：列表段（flex-1 min-h-0 overflow-y-auto）
           与底部栈（max-h-[50vh] overflow-y-auto）。aside 自己不再当第三层滚动容器（否则整栏滚与内层抢滚轮）。 -->
      <aside
        class="flex w-60 md:w-(--sidebar-w) flex-col shrink-0 overflow-hidden border-r border-black/10 bg-white p-2"
        :style="sidebar.asideStyle.value"
        :class="drawerOpen
          ? 'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:shadow-lg'
          : 'max-md:hidden'"
      >
        <!-- issue #472：上传成功 ⇒ 重判收工灯（新文件未跟踪 ⇒ 灯该变红；D9「红是进度不是警报」）。
             不重判就是骗人：磁盘上多了没跟踪的文件，灯还说「已收工」。 -->
        <SidebarPanel @select-session="onSelectSession" @new-session="onNewSession" @files-changed="gitLight.load()" />
      </aside>
      <!-- issue #90：拖拽把手 = aside 右缘兄弟元素（aside 内 overflow-y-auto，不放内部避免与滚动条打架） -->
      <div
        class="hidden md:block w-1 shrink-0 cursor-col-resize touch-none transition-colors"
        :class="sidebar.dragging.value ? 'bg-brand/60' : 'bg-black/10 hover:bg-brand/40'"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('workbench.resizeSidebar')"
        :aria-valuenow="sidebar.width.value"
        :aria-valuemin="SIDEBAR_MIN"
        :aria-valuemax="SIDEBAR_MAX"
        tabindex="0"
        @pointerdown="sidebar.onHandlePointerDown"
        @dblclick="sidebar.resetWidth"
        @keydown="sidebar.onHandleKeydown"
      ></div>

      <section class="relative flex flex-1 flex-col min-w-0">
        <!-- issue #816 常驻条：在滚动容器**之外**（不随消息流滚走），无折叠（`sessionFolds === []`）时
             整条不渲染。它是「这个会话已经丢了多早期细节」的真信号（#197 同源口径），展开才看清单。 -->
        <button
          v-if="store.sessionFolds.length > 0"
          type="button"
          data-test="fold-bar"
          class="flex shrink-0 items-center gap-1 border-b border-black/10 bg-white px-3 py-1.5 text-left text-sm text-black/60 hover:bg-black/5"
          :aria-expanded="foldPanelOpen"
          aria-controls="fold-panel"
          @click="foldPanelOpen = !foldPanelOpen"
        >
          <span data-test="fold-bar-text" class="min-w-0 flex-1 truncate">{{ foldBarText }}</span>
          <span aria-hidden="true" class="shrink-0">{{ foldPanelOpen ? '▾' : '▸' }}</span>
        </button>
        <!-- issue #816 展开面板：紧贴常驻条下方，逐条列**全部**折叠（不受消息窗口限制）。
             行内不出现 mechanical 折的 title——口径在 `foldHeadline`（实测那是把范围又念一遍的模板句），
             去重与 i18n 渲染在 `headlineText` / `rangeText`（#816①②）。 -->
        <div
          v-if="foldPanelOpen && store.sessionFolds.length > 0"
          id="fold-panel"
          ref="foldPanelEl"
          data-test="fold-panel"
          class="max-h-56 shrink-0 overflow-auto border-b border-black/10 bg-white px-3 py-1.5 text-xs"
        >
          <div class="mb-1 text-black/40">{{ t('workbench.foldBar.panelTitle', { count: store.sessionFolds.length }) }}</div>
          <template
            v-for="fold in store.sessionFolds"
            :key="`r${fold.round ?? 'x'}-${fold.from}-${fold.to}`"
          >
            <div data-test="fold-row" class="flex items-baseline gap-2 py-0.5">
              <span data-test="fold-row-range" class="shrink-0 text-black/60">{{ rangeText(fold) }}</span>
              <span
                v-if="headlineText(fold)"
                data-test="fold-row-headline"
                class="shrink-0"
              >{{ headlineText(fold) }}</span>
              <span v-if="foldFootprint(fold)" data-test="fold-row-footprint" class="min-w-0 truncate text-black/40">{{ foldFootprint(fold) }}</span>
              <span v-if="fold.truncated" data-test="fold-row-truncated" class="shrink-0 text-black/40">{{ t('workbench.foldBar.truncated') }}</span>
              <!-- #816④a：轮号不可用（非安全整数/缺席）就根本不渲染这个按钮（与旧横幅同口径：
                   拿 from/to 去查是查错行、必然 404）。 -->
              <button
                v-if="foldQueryRound(fold) !== null"
                type="button"
                data-test="fold-row-original"
                class="shrink-0 rounded-md border border-black/20 px-1.5 py-0.5 text-black/50 hover:bg-black/5"
                @click="toggleFoldOriginal(fold)"
              >{{ t('workbench.foldBar.viewOriginal') }}</button>
            </div>
            <!-- 该行下方那段原文：**同一个组件**（StreamPanel 旧横幅也用它）。`foldRowOriginalState` 在没有
                 展开态、或从未点过（无 state）⇒ undefined ⇒ 整块一个字节都不出。 -->
            <!-- ⚠ `FoldOriginalTurns` 是**多根模板**（loading / missing / loaded / error 各一个根），
                 Vue 不会把调用处传的 `class` 落到任何一个根上 ⇒ 包裹层必须自己带这些类（评审 nit）。 -->
            <div
              v-if="foldRowOriginalState(fold)"
              class="folded-original mb-1 border-l-2 border-black/10 pl-2"
            >
              <FoldOriginalTurns
                :state="foldRowOriginalState(fold)!"
                :fold="fold"
                @retry="retryFoldOriginal(fold)"
              />
            </div>
          </template>
        </div>
        <!-- issue #816 右侧竖串与消息流**同一行**：竖串不参与滚动（它是 `relative` 容器 + 节点绝对定位，
             自己不是滚动容器）。行包装给 `overflow-auto` 是刻意的：#282 那条「状态条落点」的结构断言按
             「会话区直系子元素里含 overflow-auto 的那一个」定位消息流，行包装继承同一个类名以免旧断言漂移
             （真正的滚动仍在 `streamEl`；`overflow-y-hidden` 保证 hover 卡顶到行上沿时不会多一条滚动条）。
             移动端（<768px）整条竖串隐藏，不另做抽屉。 -->
        <section class="flex min-h-0 flex-1 overflow-auto overflow-y-hidden">
          <div ref="streamEl" class="flex-1 overflow-auto p-3" @scroll="onStreamScroll">
            <StreamPanel />
          </div>
          <div
            v-if="foldNodes.length > 0"
            data-test="fold-rail"
            class="relative my-2 hidden w-9 shrink-0 md:block"
            role="group"
            :aria-label="t('workbench.foldBar.railAria')"
          >
            <button
              v-for="(node, i) in foldNodes"
              :key="`n${node.fold.round ?? 'x'}-${node.fold.from}-${node.fold.to}`"
              type="button"
              data-test="fold-node"
              :data-fold-to="node.fold.to"
              :data-active="i === activeFoldIndex ? 'true' : 'false'"
              :aria-label="t('workbench.foldBar.nodeAria', { round: node.fold.to })"
              class="group absolute left-1/2 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full hover:bg-black/5"
              :style="{ top: `${node.topPct}%` }"
              @click="onFoldNodeClick(i)"
            >
              <!-- 最新那条实心（颜色不是唯一判据：`data-active` 与 data-test 都在），其余空心 -->
              <span
                :data-test="i === activeFoldIndex ? 'fold-node-active' : 'fold-node-idle'"
                class="block h-2 w-2 rounded-full border border-brand"
                :class="i === activeFoldIndex ? 'bg-brand' : 'bg-white'"
              ></span>
              <!-- hover 卡：纯 CSS（group-hover / group-focus-visible），不跟随鼠标。
                   锚在节点的**左侧**（`right-full`）——竖串贴在会话区右缘，居中展开会把卡片顶出右缘
                   而多出一条横向滚动条。上/下翻转看 `topPct`（同一个纯数学量，不靠量布局）：
                   顶部附近的折叠卡往下开，免得卡被行上沿刷掉。 -->
              <span
                data-test="fold-tip"
                class="pointer-events-none absolute right-full z-10 hidden max-w-[240px] rounded-md border border-black/10 bg-white px-2 py-1 text-left text-xs shadow group-hover:block group-focus-visible:block"
                :class="node.topPct < 25 ? 'top-0 mt-1' : 'bottom-0 mb-1'"
              >
                <span class="block text-black/60">{{ rangeText(node.fold) }}</span>
                <span
                  v-if="headlineText(node.fold)"
                  data-test="fold-tip-headline"
                  class="block"
                >{{ headlineText(node.fold) }}</span>
                <span v-if="foldFootprint(node.fold)" data-test="fold-tip-footprint" class="block text-black/50">{{ foldFootprint(node.fold) }}</span>
                <span v-if="node.fold.truncated" data-test="fold-tip-truncated" class="block text-black/40">{{ t('workbench.foldBar.truncated') }}</span>
              </span>
            </button>
          </div>
        </section>
        <!-- issue #282：状态条挂在消息流**下方**、输入框**上方**（不塞进 StreamPanel 的渲染循环，也不在
             滚动容器里——常驻可见）。原来在流上方，顶部一行容易被忽略；贴到 composer 上沿后视线自然落到它。
             无选中会话时不挂（没有 run 可报，也不白起一个 1s 时钟）。 -->
        <RunStatusBar v-if="store.sessionId" />
        <!-- issue #592：展开态面板（徒标点开后才会挂；无内容时整段不渲染，不会顶出一条空栏）。 -->
        <DelegateActivityBar v-if="store.sessionId" />
        <!-- issue #370：队列条夹在状态条与 composer 之间——它是「还没发出去的话」，
             读序必须是「现在在跑什么 → 还排队说什么 → 输入框」。 -->
        <QueuedInputsBar v-if="store.sessionId" />
        <ComposerBar />
        <!-- issue #94：会话选择 modal（Ctrl/⌘+K，scope='all'） -->
        <SessionPickerModal
          v-if="pickerOpen"
          scope="all"
          :cwd="store.dirCwd ?? undefined"
          @select="onPickerSelect"
          @close="pickerOpen = false"
        />
        <!-- issue #55 A2：「↓ 最新」悬浮按钮 -->
        <button
          v-if="showToLatest"
          type="button"
          class="absolute right-4 bottom-24 z-10 rounded-full border border-black/10 bg-white px-3 py-1.5 text-sm shadow text-brand"
          @click="jumpToLatest"
        >{{ t('workbench.toLatest') }}</button>
      </section>
    </main>

    <!-- issue #528：覆盖式右抽屉（不是并排）。挂在根层：遮罩要盖整个视口，包含侧栏与顶栏。
         issue #614：用户级抽屉 `session-id=null`，不能再用 `store.sessionId` 门掉（无会话也要能开）。 -->
    <MacroDrawer
      v-if="macroDrawerOpen"
      :session-id="macroDrawerSessionId"
      @close="closeMacroDrawer"
    />
  </div>
</template>
