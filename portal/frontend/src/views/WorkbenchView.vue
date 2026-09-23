<script setup lang="ts">
// 工作台占位（P2 迁移中）：显示 who（login+role+fde_name）+ 登出 + 管理台入口（admin 角色，对齐旧 header）。
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const auth = useAuthStore();

// 旧版 who 文案：`login（role / fde_name）`，无 fde_name 时只显示 role。
const who = computed(() => {
  const u = auth.user;
  if (!u) return '';
  return `${u.login}（${u.role}${u.fde_name ? ' / ' + u.fde_name : ''}）`;
});

async function onLogout() {
  await auth.logout();
  router.replace('/login');
}
</script>

<template>
  <div class="min-h-screen flex flex-col bg-white">
    <header class="flex items-center gap-3 border-b border-black/10 px-3 py-2">
      <h1 class="text-xl font-medium mb-0">FDE Station</h1>
      <span class="flex-1 text-black/50 text-sm">{{ who }}</span>
      <router-link v-if="auth.user?.role === 'admin'" to="/admin" class="text-sm underline">管理台</router-link>
      <button
        class="rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5"
        @click="onLogout"
      >登出</button>
    </header>
    <main class="flex-1 p-3">
      <p class="text-black/50 text-sm">工作台 P2 迁移中。</p>
    </main>
  </div>
</template>
