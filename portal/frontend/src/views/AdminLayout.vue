<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const who = computed(() => {
  const user = auth.user;
  if (!user) return '';
  return user.fde_name
    ? t('workbench.who', { login: user.login, role: user.role, fde: user.fde_name })
    : t('workbench.whoNoFde', { login: user.login, role: user.role });
});

const tabs = [
  { name: 'admin-users', label: 'admin.tabs.users' },
  { name: 'admin-llm', label: 'admin.tabs.llm' },
  { name: 'admin-repos', label: 'admin.tabs.repos' },
  // issue #350：号池占用总览（只读）。放在最后：先看用户/配置，选段时才来这里。
  { name: 'admin-preview-pool', label: 'admin.tabs.previewPool' },
] as const;

async function onLogout() {
  await auth.logout();
  router.replace('/login');
}
</script>

<template>
  <div class="min-h-screen flex flex-col bg-white">
    <header class="flex items-center gap-3 border-b border-black/10 px-3 py-2">
      <h1 class="text-xl font-medium mb-0">{{ t('admin.title') }}</h1>
      <span class="flex-1 text-black/50 text-sm">{{ who }}</span>
      <router-link to="/" class="text-sm underline">{{ t('admin.backToWorkbench') }}</router-link>
      <button
        class="rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5"
        @click="onLogout"
      >{{ t('common.logout') }}</button>
    </header>

    <nav class="flex gap-1 border-b border-black/10 px-3" :aria-label="t('admin.tabs.label')">
      <router-link
        v-for="tab in tabs"
        :key="tab.name"
        :to="{ name: tab.name }"
        class="border-b-2 px-3 py-2 text-sm"
        :class="route.name === tab.name
          ? 'border-brand font-semibold text-brand'
          : 'border-transparent text-black/60 hover:bg-black/5 hover:text-black'"
      >{{ t(tab.label) }}</router-link>
    </nav>

    <main class="flex-1 p-3">
      <router-view />
    </main>
  </div>
</template>
