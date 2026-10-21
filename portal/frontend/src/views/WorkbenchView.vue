<script setup lang="ts">
// 工作台壳（P2）：侧栏（移动端抽屉）+ 消息流 + composer + 深链/自动跟随。
// 深链 #/session/<id> 已迁入 vue-router（/session/:id 路由，issue #55 B1 语义平移）：
//   列表内直开 / 跨项目切项目后打开（写回深链）/ 404 静默回退清路由 / 其他错误保留路由 + 报错。
// popstate（前进/后退）由 vue-router hash 模式驱动路由参数变化 → 本组件 watcher 等价旧 popstate 处理器。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { setWorkbenchHooks, useWorkbenchStore } from '../stores/workbench';
import { AUTO_FOLLOW_GAP } from '../lib/constants';
import { useSidebarWidth, SIDEBAR_MAX, SIDEBAR_MIN } from '../composables/useSidebarWidth';
import SidebarPanel from '../components/SidebarPanel.vue';
import StreamPanel from '../components/StreamPanel.vue';
import ComposerBar from '../components/ComposerBar.vue';
import SessionPickerModal from '../components/SessionPickerModal.vue';
import LocaleSwitch from '../components/LocaleSwitch.vue';
import PreviewPortsPanel from '../components/PreviewPortsPanel.vue';
import { usePreviewPorts } from '../composables/usePreviewPorts';

// issue #101 P2：顶栏文案走 i18n（workbench.* / common.*）；LocaleSwitch 挂管理台/登出旁。
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

// ---- 路由钩子注入（store 保持 router 无关，便于单测）----
setWorkbenchHooks({
  onClearRoute: () => router.replace('/'),
  onDeepLinkRestored: (sid) => router.replace(`/session/${encodeURIComponent(sid)}`),
});

// ---- 深链解析（resolveHashSession 语义平移；popstate = 路由参数变化）----
watch(
  () => route.params.id,
  async (sid) => {
    if (sid) {
      if (String(sid) === String(store.sessionId)) return;
      await store.resolveRouteSession(String(sid));
    } else if (store.sessionId) {
      store.resetSessionView();
    }
  },
);

async function onSelectSession(id: string) {
  // 评审修复：同会话重开只刷新（旧 replaceState 语义），不重复 push 历史
  if (String(id) === String(store.sessionId)) {
    await store.openSession(id);
    return;
  }
  drawerOpen.value = false; // issue #55 B4：移动端选中会话后自动收起抽屉
  await router.push(`/session/${encodeURIComponent(id)}`);
}

async function onNewSession() {
  const s = await store.createSession();
  if (s) await router.push(`/session/${encodeURIComponent(String(s.id))}`);
}

async function onLogout() {
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

// ---- issue #246 交付② 单 B：预览端口区块（折叠在顶栏下方，默认收起）----
// 进视图就拉 GET /api/me/ports（面板常驻 DOM，折叠只是不占位）；但**预览 ticket 绝不预取**
// ——60 秒过期且一次性，预取等于把它用废（点击当场才签，见 usePreviewPorts.openPreview）。
const ports = usePreviewPorts();
const portsOpen = ref(false);
const portCount = computed(() => ports.items.value.length);
const portsToggleLabel = computed(() => {
  if (ports.listError.value !== null) return t('previewPorts.toggleFailed');
  return portCount.value > 0
    ? t('previewPorts.toggleCount', { count: portCount.value })
    : t('previewPorts.toggle');
});

onMounted(async () => {
  void ports.load(); // 与 auth 守卫无关：进视图就拉自己的端口列表（能走到这里的人已由 #332 守卫保证有工位）
  if (!auth.user) return; // 守卫保证已登录
  await store.initWorkspace();
  // issue #55 B1：启动时若路由带 /session/<id>（旧 #/session/<id>），走统一深链解析
  if (route.params.id) await store.resolveRouteSession(String(route.params.id));
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
      <span class="flex-1 text-black/50 text-sm">{{ who }}</span>
      <router-link v-if="auth.user?.role === 'admin'" to="/admin" class="text-sm underline">{{ t('common.adminConsole') }}</router-link>
      <LocaleSwitch />
      <button
        class="rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5"
        @click="onLogout"
      >{{ t('common.logout') }}</button>
    </header>

    <!-- issue #246 交付② 单 B：预览端口区块（折叠条 + 展开面板）；面板常驻 ⇒ 进视图即拉列表 -->
    <div class="border-b border-black/10 bg-black/[0.02]">
      <button
        type="button"
        data-test="preview-ports-toggle"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-black/5"
        :aria-expanded="portsOpen"
        aria-controls="preview-ports-disclosure"
        @click="portsOpen = !portsOpen"
      >
        <span aria-hidden="true">{{ portsOpen ? '▾' : '▸' }}</span>
        <span class="font-medium">{{ portsToggleLabel }}</span>
      </button>
      <div
        v-show="portsOpen"
        id="preview-ports-disclosure"
        class="max-h-72 overflow-y-auto border-t border-black/10 px-3 py-2"
      >
        <PreviewPortsPanel
          :items="ports.items.value"
          :loading="ports.loading.value"
          :loaded="ports.loaded.value"
          :error="ports.listError.value"
          :ticket-busy-id="ports.ticketBusyId.value"
          :ticket-error="ports.ticketError.value"
          :popup-blocked-url="ports.popupBlockedUrl.value"
          @retry="ports.load()"
          @open="(item) => void ports.openPreview(item)"
        />
      </div>
    </div>

    <main class="flex flex-1 min-h-0">
      <!-- 移动端抽屉遮罩（旧 #backdrop） -->
      <div
        v-if="drawerOpen"
        class="fixed inset-0 z-30 bg-black/40 md:hidden"
        @click="drawerOpen = false"
      ></div>
      <!-- 侧栏：≥md 静态；<md 抽屉（旧 offcanvas-md + body.drawer-open 的 Tailwind 等价） -->
      <!-- w-60 改 CSS 变量绑定（仅 ≥md 生效），shrink-0 保留 -->
      <!-- issue #92：aside 改 flex-col 以承载 SidebarPanel 的三段布局（固定头/列表独立滚/树固定底）；
           overflow-y-auto 保留作兜底——正常三段结构下列表段内部消化滚动，整栏不再滚 -->
      <aside
        class="flex w-60 md:w-(--sidebar-w) flex-col shrink-0 overflow-y-auto border-r border-black/10 bg-white p-2"
        :style="sidebar.asideStyle.value"
        :class="drawerOpen
          ? 'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:shadow-lg'
          : 'max-md:hidden'"
      >
        <SidebarPanel @select-session="onSelectSession" @new-session="onNewSession" />
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
        <div ref="streamEl" class="flex-1 overflow-auto p-3" @scroll="onStreamScroll">
          <StreamPanel />
        </div>
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
  </div>
</template>
