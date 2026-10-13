<script setup lang="ts">
// #255 首登强制改密屏（受限会话的唯一出口，portal.md §2.11a / §2.6a）。
//
// 为什么它「关不掉」：本视图不是 modal（不套 ModalShell、没有关闭按钮、没有遮罩可点、Esc 无事可做），
// 而是 App.vue 里 `<router-view />` 的**替代分支**（第一道）+ router.ts 全局守卫的导航改写（第二道）。
// 受限态下工作台/会话视图/管理台整棵子树压根不挂载，顶栏 ☰ 导航与「管理台」链接不存在；
// 手改 URL、深链 #/session/<id>、前进/后退、登录后访问 /login 全部被改写到 /change-password。
// 唯一的离开方式是服务端把旗标清掉：提交成功后 store 会重新 `GET /api/me` 取真实旗标。
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { afterLoginRoute, useAuthStore } from '../stores/auth';
import { describeError, errorMeansRelogin } from '../lib/forcePasswordErrors';
import LocaleSwitch from '../components/LocaleSwitch.vue';

const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();

const current = ref('');
const next = ref('');
const confirm = ref('');
// 本地预检文案（口令一致性只能在前端判：服务端只收 current/new，没有 confirm 字段，§2.6a）。
const localError = ref<string | null>(null);

const busy = computed(() => auth.loading);

// 失败态（前端 ②）：**码 → 可行动文案**的映射在 lib/forcePasswordErrors.ts（不在本视图里判码），
// 本视图只把它渲染成一行字符串。`describeError` 内部全部经 `toDisplayText` 退化 ⇒
// 模板里不可能出现 `[object Object]`（五种畸形形态的断言见 spec）。
const serverError = computed(() => (auth.changePasswordError ? describeError(auth.changePasswordError) : ''));

async function onSubmit() {
  localError.value = null;
  if (!current.value || !next.value) {
    localError.value = t('forcePassword.incomplete');
    return;
  }
  if (next.value !== confirm.value) {
    localError.value = t('forcePassword.mismatch');
    return;
  }
  const released = await auth.changeOwnPassword({
    current_password: current.value,
    new_password: next.value,
    confirm_password: confirm.value,
  });
  // released=true 的唯一来源是改密后 `GET /api/me` 回答「不受限」⇒ 才允许进正常界面。
  // 会话保留（§2.6a：只吊销其它会话），所以回落地页而不是 /login。
  if (released && auth.user) {
    router.replace(afterLoginRoute(auth.user));
    return;
  }
  // 401 unauthorized（会话过期）⇒ **不要停在改密屏**：手里已经没会话了，重试一次也只是再撞 401。
  // ⚠ 与 401 invalid_credentials（旧口令打错，仍应留在屏上重输）的区分全在 code 上，
  // 判据在 lib/forcePasswordErrors.ts（§2.6a：两个 401 共用状态码）。
  const err = auth.changePasswordError;
  if (err && errorMeansRelogin(err)) {
    auth.forgetExpiredSession();
    router.replace('/login');
  }
}

// 出口二：登出（§2.11a 放行清单里有 POST /api/auth/logout）——不想改密的人至少能换账号。
// 这是「离开会话」而不是「关掉界面」：换账号后若新会话仍受限，闸门照样落下。
async function onLogout() {
  await auth.logout();
  router.replace('/login');
}
</script>

<template>
  <!-- 与登录卡同一视觉语言（居中卡 + 品牌绿主按钮），但语义是「挡住整页」而非弹窗。 -->
  <div class="min-h-screen flex items-start md:items-center justify-center bg-white px-3 py-12" data-test="force-password">
    <div class="w-full max-w-[22rem] rounded-lg border border-black/10 bg-white shadow-sm">
      <div class="p-4">
        <div class="flex items-start justify-between gap-2 mb-3">
          <h2 class="text-xl font-medium">{{ t('forcePassword.title') }}</h2>
          <LocaleSwitch />
        </div>
        <p class="text-black/60 text-sm mb-3">{{ t('forcePassword.intro') }}</p>

        <form @submit.prevent="onSubmit">
          <label class="block text-xs text-black/50 mb-1" for="currentPassword">{{ t('forcePassword.currentLabel') }}</label>
          <input
            id="currentPassword" v-model="current" type="password" autocomplete="current-password"
            class="w-full rounded-md border border-black/20 px-3 py-1.5 mb-3 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand"
          >
          <label class="block text-xs text-black/50 mb-1" for="newPassword">{{ t('forcePassword.newPasswordLabel') }}</label>
          <input
            id="newPassword" v-model="next" type="password" autocomplete="new-password"
            class="w-full rounded-md border border-black/20 px-3 py-1.5 mb-3 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand"
          >
          <label class="block text-xs text-black/50 mb-1" for="confirmPassword">{{ t('forcePassword.confirmPasswordLabel') }}</label>
          <input
            id="confirmPassword" v-model="confirm" type="password" autocomplete="new-password"
            class="w-full rounded-md border border-black/20 px-3 py-1.5 mb-3 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand"
          >
          <button
            type="submit" :disabled="busy"
            class="w-full rounded-md bg-brand hover:bg-brand-hover active:bg-brand-active text-white py-1.5 disabled:opacity-75"
          >{{ busy ? t('forcePassword.submitting') : t('forcePassword.submit') }}</button>
        </form>

        <!-- 会话语义（§2.6a）：当前会话保留、只吊销其它会话 ⇒ 明说「不用重新登录」。 -->
        <p class="text-black/45 text-xs mt-3 mb-0">{{ t('forcePassword.sessionHint') }}</p>

        <!-- 失败态：本地预检与服务端错误各一条，都是纯字符串（role=alert 供读屏）。 -->
        <p v-if="localError" role="alert" class="text-red-600 text-sm mt-3 mb-0">{{ localError }}</p>
        <p v-else-if="serverError" role="alert" class="text-red-600 text-sm mt-3 mb-0" data-test="force-password-server-error">{{ serverError }}</p>

        <button
          type="button"
          class="w-full rounded-md border border-black/20 text-black/80 py-1.5 mt-3 hover:bg-black/5"
          @click="onLogout"
        >{{ t('forcePassword.logout') }}</button>
      </div>
    </div>
  </div>
</template>
