<script setup lang="ts">
// 登录页：观感对齐旧 index.html renderLogin() 的 Bootstrap 登录卡（居中卡、品牌绿主按钮、
// 两步切换）。字段/按钮文案/错误展示位置保持逐字等价。
// issue #101 P1：用户可见文案走 i18n（login.*，zh-CN/en 逐字等价），卡片右上角挂语言切换菜单。
// 注意：错误提示 auth.error 来自 auth store（P2 归 errors.*），本阶段保持原样。
// issue #449：第二步现在按 `auth.factor` 分叉——`'totp'` 保持原样（一字不改），`'email'` 是邮箱验证码
// （portal.md §2.3a/§2.3b：6 位码 + 重发 + 冷却倒计时 + 返回上一步）。
import { ref, nextTick, computed, watch, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore, afterLoginRoute } from '../stores/auth';
import LocaleSwitch from '../components/LocaleSwitch.vue';

const { t } = useI18n();
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
// #449：邮箱验证码输入框（与 TOTP 那个分开：两条通道不会同时在场，但各自要能自动聚焦）。
const emailCode = ref('');
const emailInput = ref<HTMLInputElement | null>(null);

async function onLoginSubmit() {
  await auth.login(login.value, password.value);
  if (auth.user) {
    router.replace(loginRedirect());
    return;
  }
  if (auth.pendingToken) {
    // 切第二步后聚焦验证码输入框（旧版 $('totpCode').focus() 等价；邮箱通道同理）。
    await nextTick();
    if (auth.factor === 'email') emailInput.value?.focus();
    else totpInput.value?.focus();
  }
}

async function onTotpSubmit() {
  await auth.submitTotp(code.value);
  if (auth.user) router.replace(loginRedirect());
}

// ---- issue #449：邮箱验证码第二步 ----
async function onEmailSubmit() {
  await auth.submitEmailCode(emailCode.value);
  if (auth.user) router.replace(loginRedirect());
}

async function onEmailResend() {
  // 冷却倒计时由下面的 watcher 接管（成功拿到 resend_after / 被 429 的 Retry-After 都会落到 cooldownSeconds）。
  await auth.resendEmailCode();
}

/**
 * 重发按钮文案：发信失败 ⇒ 「重新发送」（且不受冷却限制，§2.3b 评审返修 ①：此时服务端还没有码行）；
 * 冷却中 ⇒ 「{n} 秒后可重发」；其余 ⇒ 「重发验证码」。
 */
const resendLabel = computed(() => {
  if (auth.sendFailed) return t('login.emailResendFailed');
  if (auth.cooldownSeconds > 0) return t('login.emailResendIn', { seconds: auth.cooldownSeconds });
  return t('login.emailResend');
});

// 冷却倒计时：秒数由 store 持有（服务端 `resend_after` / `Retry-After`），这里只负责每秒滴答。
// 为什么计时器在视图：store 不该持有 setInterval（换页/登出后没人清），而按钮只在本视图存在。
let cooldownTimer: ReturnType<typeof setInterval> | null = null;
function stopCooldownTicker() {
  if (cooldownTimer !== null) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
}
watch(
  () => auth.cooldownSeconds,
  (seconds) => {
    if (seconds <= 0) {
      stopCooldownTicker();
      return;
    }
    if (cooldownTimer !== null) return; // 已在滴答：不重置相位
    cooldownTimer = setInterval(() => {
      auth.tickCooldown();
      if (auth.cooldownSeconds <= 0) stopCooldownTicker();
    }, 1000);
  },
  // immediate：进屏时就带着冷却（上一个视图实例留下的秒数）也要能自己走完，不能卡成永久禁用。
  { immediate: true },
);
onUnmounted(stopCooldownTicker);
</script>

<template>
  <div class="min-h-screen flex items-start md:items-center justify-center bg-white px-3 py-12">
    <div class="w-full max-w-[22rem] rounded-lg border border-black/10 bg-white shadow-sm">
      <div class="p-4">
        <!-- 卡片头部：标题 + 语言切换（flex 头部，不遮挡表单） -->
        <div class="flex items-start justify-between gap-2 mb-3">
          <h2 class="text-xl font-medium">{{ t('login.title') }}</h2>
          <LocaleSwitch />
        </div>

        <!-- 第一步：login + password -->
        <form v-if="!auth.pendingToken" @submit.prevent="onLoginSubmit">
          <label class="block text-xs text-black/50 mb-1" for="loginName">{{ t('login.loginName') }}</label>
          <input
            id="loginName" v-model="login" autocomplete="username"
            class="w-full rounded-md border border-black/20 px-3 py-1.5 mb-3 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand"
          >
          <label class="block text-xs text-black/50 mb-1" for="loginPass">{{ t('login.password') }}</label>
          <input
            id="loginPass" v-model="password" type="password" autocomplete="current-password"
            class="w-full rounded-md border border-black/20 px-3 py-1.5 mb-3 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand"
          >
          <button
            type="submit" :disabled="auth.loading"
            class="w-full rounded-md bg-brand hover:bg-brand-hover active:bg-brand-active text-white py-1.5 disabled:opacity-75"
          >{{ t('login.next') }}</button>
        </form>

        <!-- 第二步（#449）：邮箱验证码（pending_token 已换取，factor==='email'） -->
        <form v-else-if="auth.factor === 'email'" @submit.prevent="onEmailSubmit">
          <p class="text-sm mb-1">{{ t('login.emailStepTitle') }}</p>
          <p class="text-black/50 text-sm mb-3">{{ t('login.emailStepHint', { email: auth.emailHint ?? '' }) }}</p>
          <label class="block text-xs text-black/50 mb-1" for="emailCode">{{ t('login.emailCodeLabel') }}</label>
          <input
            id="emailCode" ref="emailInput" v-model="emailCode"
            inputmode="numeric" maxlength="6" autocomplete="one-time-code"
            class="w-full rounded-md border border-black/20 px-3 py-1.5 mb-3 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand"
          >
          <button
            type="submit" :disabled="auth.loading"
            class="w-full rounded-md bg-brand hover:bg-brand-hover active:bg-brand-active text-white py-1.5 disabled:opacity-75"
          >{{ t('login.emailCodeSubmit') }}</button>
          <button
            id="emailResend" type="button"
            :disabled="auth.loading || (!auth.sendFailed && auth.cooldownSeconds > 0)"
            class="w-full rounded-md border border-black/20 text-black/80 py-1.5 mt-2 hover:bg-black/5 disabled:opacity-75"
            @click="onEmailResend"
          >{{ resendLabel }}</button>
          <button
            id="emailBack" type="button"
            class="w-full text-black/60 text-sm py-1.5 mt-1 underline"
            @click="auth.backToLogin()"
          >{{ t('login.emailBackToPassword') }}</button>
        </form>

        <!-- 第二步：TOTP（pending_token 已换取） -->
        <form v-else @submit.prevent="onTotpSubmit">
          <p class="text-black/50 text-sm mb-3">{{ t('login.totpHint') }}</p>
          <label class="block text-xs text-black/50 mb-1" for="totpCode">{{ t('login.totpLabel') }}</label>
          <input
            id="totpCode" ref="totpInput" v-model="code"
            inputmode="numeric" maxlength="6" autocomplete="one-time-code"
            class="w-full rounded-md border border-black/20 px-3 py-1.5 mb-3 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand"
          >
          <button
            type="submit" :disabled="auth.loading"
            class="w-full rounded-md bg-brand hover:bg-brand-hover active:bg-brand-active text-white py-1.5 disabled:opacity-75"
          >{{ t('login.totpSubmit') }}</button>
          <button
            type="button"
            class="w-full rounded-md border border-black/20 text-black/80 py-1.5 mt-2 hover:bg-black/5"
            @click="auth.backToLogin()"
          >{{ t('login.backToLogin') }}</button>
        </form>

        <p class="text-red-600 text-sm mt-3 mb-0" role="alert">{{ auth.error }}</p>
      </div>
    </div>
  </div>
</template>
