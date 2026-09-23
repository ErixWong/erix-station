<script setup lang="ts">
// 登录页：观感对齐旧 index.html renderLogin() 的 Bootstrap 登录卡（居中卡、品牌绿主按钮、
// 两步切换）。字段/按钮文案/错误展示位置保持逐字等价。
import { ref, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore, afterLoginRoute } from '../stores/auth';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

// 登录守卫携带的 redirect 回跳（如未登录访问 /session/<id> 深链）；仅允许站内路径。
function loginRedirect(): string {
  const r = route.query.redirect;
  return typeof r === 'string' && r.startsWith('/') ? r : afterLoginRoute(auth.user!);
}
const login = ref('');
const password = ref('');
const code = ref('');
const totpInput = ref<HTMLInputElement | null>(null);

async function onLoginSubmit() {
  await auth.login(login.value, password.value);
  if (auth.user) {
    router.replace(loginRedirect());
    return;
  }
  if (auth.pendingToken) {
    // 切第二步后聚焦 TOTP 输入框（旧版 $('totpCode').focus() 等价）。
    await nextTick();
    totpInput.value?.focus();
  }
}

async function onTotpSubmit() {
  await auth.submitTotp(code.value);
  if (auth.user) router.replace(loginRedirect());
}
</script>

<template>
  <div class="min-h-screen flex items-start md:items-center justify-center bg-white px-3 py-12">
    <div class="w-full max-w-[22rem] rounded-lg border border-black/10 bg-white shadow-sm">
      <div class="p-4">
        <h2 class="text-xl font-medium mb-3">FDE Station 登录</h2>

        <!-- 第一步：login + password -->
        <form v-if="!auth.pendingToken" @submit.prevent="onLoginSubmit">
          <label class="block text-xs text-black/50 mb-1" for="loginName">登录名</label>
          <input
            id="loginName" v-model="login" autocomplete="username"
            class="w-full rounded-md border border-black/20 px-3 py-1.5 mb-3 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand"
          >
          <label class="block text-xs text-black/50 mb-1" for="loginPass">口令</label>
          <input
            id="loginPass" v-model="password" type="password" autocomplete="current-password"
            class="w-full rounded-md border border-black/20 px-3 py-1.5 mb-3 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand"
          >
          <button
            type="submit" :disabled="auth.loading"
            class="w-full rounded-md bg-brand hover:bg-brand-hover active:bg-brand-active text-white py-1.5 disabled:opacity-75"
          >下一步</button>
        </form>

        <!-- 第二步：TOTP（pending_token 已换取） -->
        <form v-else @submit.prevent="onTotpSubmit">
          <p class="text-black/50 text-sm mb-3">输入认证器 6 位码（本地账号两步登录）。</p>
          <label class="block text-xs text-black/50 mb-1" for="totpCode">TOTP</label>
          <input
            id="totpCode" ref="totpInput" v-model="code"
            inputmode="numeric" maxlength="6" autocomplete="one-time-code"
            class="w-full rounded-md border border-black/20 px-3 py-1.5 mb-3 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand"
          >
          <button
            type="submit" :disabled="auth.loading"
            class="w-full rounded-md bg-brand hover:bg-brand-hover active:bg-brand-active text-white py-1.5 disabled:opacity-75"
          >验证并登录</button>
          <button
            type="button"
            class="w-full rounded-md border border-black/20 text-black/80 py-1.5 mt-2 hover:bg-black/5"
            @click="auth.backToLogin()"
          >← 返回重新登录</button>
        </form>

        <p class="text-red-600 text-sm mt-3 mb-0" role="alert">{{ auth.error }}</p>
      </div>
    </div>
  </div>
</template>
