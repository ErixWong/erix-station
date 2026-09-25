<script setup lang="ts">
// 工作台壳（P2）：侧栏（移动端抽屉）+ 消息流 + composer + 深链/自动跟随。
// 深链 #/session/<id> 已迁入 vue-router（/session/:id 路由，issue #55 B1 语义平移）：
//   列表内直开 / 跨项目切项目后打开（写回深链）/ 404 静默回退清路由 / 其他错误保留路由 + 报错。
// popstate（前进/后退）由 vue-router hash 模式驱动路由参数变化 → 本组件 watcher 等价旧 popstate 处理器。
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { setWorkbenchHooks, useWorkbenchStore } from '../stores/workbench';
import { AUTO_FOLLOW_GAP } from '../lib/constants';
import { useSidebarWidth, SIDEBAR_MAX, SIDEBAR_MIN } from '../composables/useSidebarWidth';
import SidebarPanel from '../components/SidebarPanel.vue';
import StreamPanel from '../components/StreamPanel.vue';
import ComposerBar from '../components/ComposerBar.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const store = useWorkbenchStore();

// ---- issue #90：侧栏宽度拖拽调整（钳制/持久化/键盘微调在 composable 内）----
const sidebar = useSidebarWidth();

// 旧 who 文案：`login（role / fde_name）`，无 fde_name 时只显示 role。
const who = computed(() => {
  const u = auth.user;
  if (!u) return '';
  return `${u.login}（${u.role}${u.fde_name ? ' / ' + u.fde_name : ''}）`;
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

onMounted(async () => {
  if (!auth.user) return; // 守卫保证已登录
  await store.initWorkspace(auth.user);
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
        aria-label="打开导航"
        @click="drawerOpen = !drawerOpen"
      >☰ 导航</button>
      <h1 class="text-xl font-medium">FDE Station</h1>
      <!-- issue #84 P5.4：cwd 徽标（📁 短名；hover 显示全路径；点击复制） -->
      <button
        v-if="store.dirCwd"
        type="button"
        class="rounded-md border border-black/10 px-2 py-0.5 text-sm hover:bg-black/5"
        :title="`${store.dirCwd}（点击复制）`"
        @click="copyCwd"
      >📁 {{ dirShortName }}<span v-if="copied" class="text-black/40"> 已复制</span></button>
      <span class="flex-1 text-black/50 text-sm">{{ who }}</span>
      <router-link v-if="auth.user?.role === 'admin'" to="/admin" class="text-sm underline">管理台</router-link>
      <button
        class="rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5"
        @click="onLogout"
      >登出</button>
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
      <aside
        class="w-60 md:w-(--sidebar-w) shrink-0 overflow-y-auto border-r border-black/10 p-2 bg-white"
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
        aria-label="调整侧栏宽度"
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
        <!-- issue #55 A2：「↓ 最新」悬浮按钮 -->
        <button
          v-if="showToLatest"
          type="button"
          class="absolute right-4 bottom-24 z-10 rounded-full border border-black/10 bg-white px-3 py-1.5 text-sm shadow text-brand"
          @click="jumpToLatest"
        >↓ 最新</button>
      </section>
    </main>
  </div>
</template>
