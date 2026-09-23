<script setup lang="ts">
// 管理台占位（P3 迁移中）：供应商/模型 CRUD、用户管理、TOTP 二维码等对齐旧 admin.html。
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const auth = useAuthStore();

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
      <h1 class="text-xl font-medium mb-0">FDE Station 管理台</h1>
      <span class="flex-1 text-black/50 text-sm">{{ who }}</span>
      <router-link to="/" class="text-sm underline">工作台</router-link>
      <button
        class="rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5"
        @click="onLogout"
      >登出</button>
    </header>
    <main class="flex-1 p-3">
      <p class="text-black/50 text-sm">管理台 P3 迁移中。</p>
    </main>
  </div>
</template>
