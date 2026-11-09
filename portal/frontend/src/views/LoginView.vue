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
import { useSiteStore } from '../stores/site';
import LocaleSwitch from '../components/LocaleSwitch.vue';

const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const site = useSiteStore();

// 2026-11-06：**入口提示**。管理台是独立 host（`admin.<伞域>:9443`），而登录 cookie 是 host-only 的
// （`#6` 的隔离设计）⇒ 「在用户面登录了管理员账号」会被送到这里、且**还要再登录一次**。
// 不解释一句，用户看到的就是「我明明刚登录过，怎么又让我登」。判据只读 `/api/site` 的两个公开 URL，
// 拿不到就不显示（fail-open，与 host 闸同口径）。
const isAdminEntry = computed(() => {
  const base = site.info?.adminBaseUrl;
  if (typeof base !== 'string') return false;
  try {
    return new URL(base).hostname.toLowerCase() === window.location.hostname.toLowerCase();
  } catch {
    return false;
  }
});
const userEntryUrl = computed(() => (typeof site.info?.userBaseUrl === 'string' ? site.info.userBaseUrl : null));
const adminEntryUrl = computed(() => (typeof site.info?.adminBaseUrl === 'string' ? site.info.adminBaseUrl : null));
void site.ensureSite();

// 2026-11-06（真机环）：**管理台入口只接受管理员**。
// 反例：在 `admin.<伞域>:9443` 用 FDE 账号登录 ⇒ 会话 cookie 种在**管理台 host**（host-only），
// 而 FDE 的落地页是 `/`（用户面 `station.<伞域>`）⇒ 跳过去立刻 401 ⇒ 又回登录页 ⇒
// 「登录成功却用不了」的来回重定向。这里直接拦住并说清楚，而不是把人送进那个环。
const entryRoleError = ref('');
async function guardEntryRole(): Promise<boolean> {
  if (!auth.user) return true;
  // ① 管理台入口：只接受管理员（否则会话种在管理台 host，而 FDE 落地页在用户面 ⇒ 立刻 401 被踢回）。
  if (isAdminEntry.value) {
    if (auth.user.role === 'admin') return true;
    const message = t('login.adminEntryFdeOnly');
    await auth.logout();          // 清本地态（管理台 host 上那个会话对用户面无效，留着只会再触发跳转）
    entryRoleError.value = message; // logout 之后设，免得被它清掉
    return false;
  }
  // ② 用户面：**没有工位的管理员**在这里没有任何可用功能（#332 会把每条工作台路径都改写到管理台），
  //   而两个 host 的会话互不相通 ⇒ 让他登录成功再跳过去，等于让他登录两次、还要在两个入口之间来回。
  //   直接说清楚「去管理台登录」，并把这个用不上的会话撤掉。
  if (auth.user.role === 'admin' && !auth.user.fde_name) {
    const message = t('login.workbenchEntrySeatlessAdmin');
    await auth.logout();
    entryRoleError.value = message;
    return false;
  }
  return true;
}

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
    if (!(await guardEntryRole())) return;
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
  if (auth.user) {
    if (!(await guardEntryRole())) return;
    router.replace(loginRedirect());
  }
}

// ---- issue #449：邮箱验证码第二步 ----
async function onEmailSubmit() {
  await auth.submitEmailCode(emailCode.value);
  if (auth.user) {
    if (!(await guardEntryRole())) return;
    router.replace(loginRedirect());
  }
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

        <!-- 入口提示（2026-11-06）：管理台入口 + 工作台入口是两个登录态，说清楚免得「刚登录又要登录」 -->
        <p v-if="isAdminEntry" data-test="login-entry-notice" class="mb-3 rounded-md bg-black/[0.03] px-3 py-2 text-xs leading-relaxed text-black/60">
          {{ t('login.adminEntryNotice') }}
          <a v-if="userEntryUrl" :href="userEntryUrl" class="underline hover:text-black">{{ t('login.adminEntryWorkbench') }}</a>
        </p>
        <p v-if="entryRoleError" data-test="login-entry-role-error" class="syserr mb-3 text-xs" role="alert">
          {{ entryRoleError }}
          <a v-if="!isAdminEntry && adminEntryUrl" :href="adminEntryUrl" class="underline">{{ t('login.goToAdminConsole') }}</a>
        </p>

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
          <!-- #449 二选一：切回 TOTP。只改 factor（同一枚 pending_token），不重新登录、不重新发码。 -->
          <button
            v-if="auth.choiceMethods.includes('totp')"
            id="emailUseTotp"
            type="button"
            class="w-full text-black/60 text-sm py-1 underline"
            @click="auth.switchFactor('totp')"
          >{{ t('login.useTotp') }}</button>
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

        <!-- #449 二选一的切换入口与降级说明。**刻意放在 TOTP <form> 之外**：
             「TOTP 第二步模板逐字未改」是 #449 已有的结构判据（见 LoginView.spec 的源码级用例），
             而这两样东西只是面板下方的次要操作/说明，放进表单里会弄伤那条判据。
             （因此两个都要再挂 `factor === 'totp'`：它们不在 `v-else` 里，不锁住就会在口令步 /
             邮箱码步也冒出来。） -->
        <button
          v-if="auth.factor === 'totp' && auth.choiceMethods.includes('email')"
          id="useEmailCode"
          type="button"
          class="w-full text-black/60 text-sm py-1.5 underline"
          @click="auth.switchFactor('email')"
        >{{ t('login.useEmailCode') }}</button>
        <!-- #449：`email_sent:false` ⇒ 不给邮箱入口，换成一句「邮件通道当前不可用」的说明。 -->
        <p
          v-if="auth.factor === 'totp' && auth.emailUnavailable"
          id="emailUnavailableNotice"
          class="text-black/50 text-sm mt-2 mb-0"
        >
          {{ t('login.emailChannelUnavailable') }}
        </p>

        <p class="text-red-600 text-sm mt-3 mb-0" role="alert">{{ auth.error }}</p>
      </div>
    </div>
  </div>
</template>
