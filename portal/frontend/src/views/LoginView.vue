<script setup lang="ts">
// 登录页：观感对齐旧 index.html renderLogin() 的 Bootstrap 登录卡（居中卡、品牌绿主按钮、
// 两步切换）。字段/按钮文案/错误展示位置保持逐字等价。
// issue #101 P1：用户可见文案走 i18n（login.*，zh-CN/en 逐字等价），卡片右上角挂语言切换菜单。
// 注意：错误提示 auth.error 来自 auth store（P2 归 errors.*），本阶段保持原样。
// issue #449：第二步现在按 `auth.factor` 分叉——`'totp'` 与 `'email'`（邮箱验证码，口径见
// portal.md §2.3a/§2.3b：6 位码 + 重发 + 冷却倒计时 + 返回上一步）。
// 工单 feat-261110-01：二选一的入口从「TOTP 表单下面一行下划线小字」换成**真正的两档 switch**
//（默认 TOTP，UI 随档位变）；邮箱码改成懒发信——切到邮箱档那一刻才发第一封（store 里
// `switchFactor('email')` → `requestEmailCode()` → 既有的 §2.3b resend 端点）。
import { ref, nextTick, computed, watch, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore, afterLoginRoute, type LoginSecondFactor } from '../stores/auth';
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
 * feat-261110-01：**只有两条通道时**才渲染 switch。
 * `choiceMethods` 直接来自后端 `methods`（`email_sent:false` 那条已被 store 剥成只剩 `['totp']`），
 * 而单一通道（`totp_required` / `email_code_required` / 降级）都是 1 条 ⇒ 不渲染，表单走原样。
 */
const showFactorSwitch = computed(() => auth.choiceMethods.length === 2);

/**
 * 选档。切换本身在 store 里（懒发信的第一封也在：`switchFactor('email')` → `requestEmailCode()`），
 * 这里只补一句「把光标交给即将出现的那个输入框」。发送中不 focus：禁用中的输入框 focus 不进去，
 * 而且会把光标从「正在发送…」上抢走。
 */
async function onPickFactor(factor: LoginSecondFactor): Promise<void> {
  auth.switchFactor(factor);
  if (auth.factor !== factor) return; // 单通道 / 这条不可用 ⇒ store 是空操作，别动焦点
  await nextTick();
  if (factor === 'email') {
    if (!auth.emailSending) emailInput.value?.focus();
  } else {
    totpInput.value?.focus();
  }
}

/**
 * 邮箱码有效期（分钟，至少 1）：**只从服务端给的秒数换算**（`email_code_ttl_seconds`）。
 * 服务端没给（旧后端 / 脏值）⇒ `0` ⇒ 那句话整句不渲染——宁可不写，也不写一个可能与
 * `EMAIL_CODE_TTL_SECONDS` 不符的数字（默认 600s ⇒ 10 分钟）。
 */
const emailCodeTtlMinutes = computed(() => {
  const secs = auth.emailCodeTtlSeconds;
  if (typeof secs !== 'number' || !(secs > 0)) return 0;
  return Math.max(1, Math.round(secs / 60));
});

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

        <!-- 第二步（#449）：两条通道共用一枚 pending_token ⇒ 上方放 switch，下方是当前档的表单。
             整块挂在 `<template v-else>` 上：Vue 要求 `v-else` 与 `v-if` 紧邻，而 switch 必须排在
             表单**上方** ⇒ 不能把 switch 插进旧的三段 `v-if / v-else-if / v-else` 链中间。 -->
        <template v-else>
          <!-- feat-261110-01：两档 switch（默认 TOTP）。可访问性：radiogroup + radio/aria-checked；
               键盘直接用 `<button type="button">` 自带的 Tab 聚焦 + Enter/Space 触发，不自己重实现 tabindex 轮换。 -->
          <div
            v-if="showFactorSwitch"
            data-test="factor-switch"
            role="radiogroup"
            :aria-label="t('login.factorSwitchLabel')"
            class="mb-3 grid grid-cols-2 gap-1 rounded-md border border-black/15 bg-black/[0.03] p-1"
          >
            <button
              type="button"
              role="radio"
              :aria-checked="auth.factor === 'totp'"
              data-test="factor-option-totp"
              :disabled="auth.emailSending"
              :class="auth.factor === 'totp' ? 'bg-white text-black shadow-sm' : 'text-black/60 hover:bg-black/5'"
              class="rounded px-2 py-1.5 text-sm font-medium disabled:opacity-75"
              @click="onPickFactor('totp')"
            >{{ t('login.factorTotp') }}</button>
            <button
              type="button"
              role="radio"
              :aria-checked="auth.factor === 'email'"
              data-test="factor-option-email"
              :disabled="auth.emailSending"
              :class="auth.factor === 'email' ? 'bg-white text-black shadow-sm' : 'text-black/60 hover:bg-black/5'"
              class="rounded px-2 py-1.5 text-sm font-medium disabled:opacity-75"
              @click="onPickFactor('email')"
            >{{ t('login.factorEmail') }}</button>
          </div>

          <!-- 第二步：邮箱验证码（pending_token 已换取，factor==='email'） -->
          <form v-if="auth.factor === 'email'" @submit.prevent="onEmailSubmit">
            <p class="text-sm mb-1">{{ t('login.emailStepTitle') }}</p>
            <!-- 懒发信的三个态：正在发 / 已发到。「已发到」直接复用既有的 emailStepHint（不另造键）；
                 既没发也没在发（= 第一封失败了）就不写「已发」这种谎，错误走卡片底部那个 role="alert"。 -->
            <p v-if="auth.emailSending" data-test="emailSendingHint" class="text-black/50 text-sm mb-3">
              {{ t('login.emailSending') }}
            </p>
            <p v-else-if="auth.emailSent" data-test="emailSentHint" class="text-black/50 text-sm mb-3">
              {{ t('login.emailStepHint', { email: auth.emailHint ?? '' }) }}
            </p>
            <label class="block text-xs text-black/50 mb-1" for="emailCode">{{ t('login.emailCodeLabel') }}</label>
            <input
              id="emailCode" ref="emailInput" v-model="emailCode"
              :disabled="auth.emailSending"
              inputmode="numeric" maxlength="6" autocomplete="one-time-code"
              class="w-full rounded-md border border-black/20 px-3 py-1.5 mb-3 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand disabled:opacity-60"
            >
            <!-- 2026-11-10：有效期写在页面上（用户要求）。分钟数来自服务端，缺省整句不出。
                 `-mt-2` 抵掉输入框自带的 `mb-3`，这样有/无这一行时下方按钮的位置不变。 -->
            <p
              v-if="emailCodeTtlMinutes > 0"
              data-test="emailCodeTtl"
              class="text-black/50 text-xs mb-3 -mt-2"
            >{{ t('login.emailCodeTtl', { minutes: emailCodeTtlMinutes }) }}</p>
            <button
              type="submit" :disabled="auth.loading || auth.emailSending"
              class="w-full rounded-md bg-brand hover:bg-brand-hover active:bg-brand-active text-white py-1.5 disabled:opacity-75"
            >{{ t('login.emailCodeSubmit') }}</button>
            <button
              id="emailResend" type="button"
              :disabled="auth.loading || auth.emailSending || (!auth.sendFailed && auth.cooldownSeconds > 0)"
              class="w-full rounded-md border border-black/20 text-black/80 py-1.5 mt-2 hover:bg-black/5 disabled:opacity-75"
              @click="onEmailResend"
            >{{ resendLabel }}</button>
            <button
              id="emailBack" type="button"
              class="w-full text-black/60 text-sm py-1.5 mt-1 underline"
              @click="auth.backToLogin()"
            >{{ t('login.emailBackToPassword') }}</button>
            <!-- #449 旧版「改用验证器应用（TOTP）」小字链接已删：职责并入上面的 switch
                 （单通道的 `email_code_required` 本来也不渲染它；「返回上一步」`#emailBack` 仍在）。 -->
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
        </template>

        <!-- #449：`email_sent:false` ⇒ 不给邮箱入口，换成一句「邮件通道当前不可用」的说明。
             旧版并列的「改用邮箱验证码」小字链接已由 switch 取代：降级时 store 已把 `choiceMethods`
             剥成只剩 `['totp']` ⇒ switch 根本不渲染，这句话就是唯一的说明。 -->
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
