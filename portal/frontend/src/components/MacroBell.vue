<script setup lang="ts">
// 顶栏铃铛（issue #528，`07` §21.3「通知落点」：独立 `notifications` 表 + 顶栏铃铛）。
//
// 未读数角标 + 列表 + 标记已读。形态照 `GitLightBadge.vue`（相对定位 + 按钮 + 绝对面板 + 外部点击关闭）。
// 数字口径：`GET /api/notifications/unread-count`（后端把它注册在 `/:id` 之前，不会互相吞）。
// ⚠ 测试不许用 `w.emitted()`（`NODE_ENV=production` 下恒空）⇒ 点击一律断言**请求桩**与 DOM 变化。
import { computed, onMounted, onScopeDispose, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMacroStore } from '../stores/macro';
import { formatClock } from '../lib/macroView';

const { t } = useI18n();
const macro = useMacroStore();
const open = ref(false);
const root = ref<HTMLElement | null>(null);

const badge = computed(() => (macro.unreadCount > 99 ? '99+' : String(macro.unreadCount)));
const hasUnread = computed(() => macro.unreadCount > 0);

/** 未读在前（列表按后端倒序，未读的排到前面才看得到「有新东西」）。 */
const listed = computed(() => {
  const items = [...macro.notifications];
  return items.sort((a, b) => Number(a.readAt !== null) - Number(b.readAt !== null));
});

async function toggleOpen(): Promise<void> {
  open.value = !open.value;
  if (open.value) await Promise.all([macro.loadNotifications(), macro.refreshUnreadCount()]);
}

async function markRead(id: string): Promise<void> {
  await macro.markRead(id);
}

function onDocPointerDown(event: MouseEvent): void {
  if (!open.value) return;
  if (root.value && event.target instanceof Node && root.value.contains(event.target)) return;
  open.value = false;
}

onMounted(() => {
  // 顶栏常驻 ⇒ 只拉未读数（列表等展开再拉，`07` §16「面板关着的时候一个请求都不该发」）。
  void macro.refreshUnreadCount();
  if (typeof document !== 'undefined') document.addEventListener('mousedown', onDocPointerDown);
});

onScopeDispose(() => {
  if (typeof document !== 'undefined') document.removeEventListener('mousedown', onDocPointerDown);
});
</script>

<template>
  <div ref="root" class="relative" data-test="macro-bell">
    <button
      type="button"
      data-test="macro-bell-button"
      class="relative flex items-center gap-1 rounded-md border border-black/10 px-2 py-0.5 text-sm hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
      :aria-label="t('notifications.aria', { count: macro.unreadCount })"
      :aria-expanded="open ? 'true' : 'false'"
      @click="toggleOpen"
    >
      <span aria-hidden="true">🔔</span>
      <span
        v-if="hasUnread"
        data-test="macro-bell-badge"
        :data-count="macro.unreadCount"
        class="ml-0.5 inline-flex min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] leading-4 text-white"
      >{{ badge }}</span>
    </button>

    <div
      v-if="open"
      data-test="macro-bell-panel"
      role="dialog"
      :aria-label="t('notifications.title')"
      class="absolute right-0 z-40 mt-1 w-80 rounded-md border border-black/10 bg-white p-2.5 shadow-lg dark:border-white/15 dark:bg-neutral-900"
    >
      <p class="text-xs font-medium">{{ t('notifications.title') }}</p>

      <p v-if="macro.notificationsLoading && !macro.notificationsLoaded" data-test="notifications-loading"
         class="mt-2 text-xs text-black/50 dark:text-white/50">{{ t('notifications.loading') }}</p>
      <p v-else-if="macro.notificationsFailed && !macro.notificationsLoaded" data-test="notifications-failed"
         class="mt-2 text-xs text-red-600">{{ t('notifications.failed') }}</p>
      <p v-else-if="listed.length === 0" data-test="notifications-empty"
         class="mt-2 text-xs text-black/50 dark:text-white/50">{{ t('notifications.empty') }}</p>

      <ul v-else class="mt-2 max-h-64 space-y-1.5 overflow-auto">
        <li
          v-for="n in listed"
          :key="n.id"
          data-test="notification-item"
          :data-notification-id="n.id"
          :data-read="n.readAt !== null ? 'true' : 'false'"
          :data-severity="n.severity"
          class="flex items-start gap-2"
        >
          <span
            aria-hidden="true"
            class="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            :class="n.severity === 'error' ? 'bg-red-500' : n.severity === 'warn' ? 'bg-amber-400' : 'bg-black/25'"
          />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm">{{ n.title }}</span>
            <span v-if="n.body" class="block text-[11px] leading-[1.5] text-black/55 dark:text-white/55">{{ n.body }}</span>
            <span class="block text-[11px] text-black/40 dark:text-white/40">{{ formatClock(n.createdAt) }}</span>
          </span>
          <button
            v-if="n.readAt === null"
            type="button"
            data-test="notification-mark-read"
            class="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-brand hover:underline"
            @click="markRead(n.id)"
          >{{ t('notifications.markRead') }}</button>
        </li>
      </ul>
    </div>
  </div>
</template>
