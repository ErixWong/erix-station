<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useSiteStore } from '../stores/site';
import { hashUrl } from '../lib/hostGate';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const site = useSiteStore();

// #450 A2：「← 返回工作台」是**跨 host** 链接（管理台 `admin.<伞域>:9443` → 用户面 `station.<伞域>`）。
// A1 之后同一份 SPA 仍会从两个 host 下发，而 `/` 在当前 origin 上就是「管理台 host 上的工作台」=
// 页面渲染得出来、API 全 404。所以这里必须用 `site` store 的 `userBaseUrl` 拼**绝对地址**。
// 拿不到 site 信息（fail-open）时退回相对 hash `#/`：同 origin 的 hash 链接，行为与改动前完全一致
// （host 闸自己会在下一次导航里决定要不要换 host）。
const backToWorkbenchHref = computed(() => hashUrl(site.info?.userBaseUrl, '/') ?? '#/');

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
  // issue #449：邮件通道配置（登录第二因素「邮箱验证码」的开关）。放在仓库管理之后、号池之前：
  // 前四个 tab 都是「人 / 模型 / 仓库 / 发信」这类平台配置，号池占用是只读的运维快照，留在最后。
  { name: 'admin-mail', label: 'admin.tabs.mail' },
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
      <a data-test="back-to-workbench" :href="backToWorkbenchHref" class="text-sm underline">{{ t('admin.backToWorkbench') }}</a>
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
