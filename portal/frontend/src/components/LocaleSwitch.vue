<script setup lang="ts">
// 语言切换菜单（issue #101 P1）：小号下拉——按钮显示当前语言，菜单两项「中文」/「English」。
// 切换即调 setLocale（i18n 响应式生效 + localStorage 持久化 + <html lang> 同步）；
// 文案走 locale.* 命名空间（语言名用母语自名，两语言下取值一致）。
// 组件自带外部点击收起。挂载点四处：登录卡片头部 / 工作台顶栏 / 强制改密屏 / 管理台外壳顶栏 `AdminLayout`。
// 为什么管理台**必须**挂（#804）：它是独立 origin（`admin.<伞域>:<端口>`），而 localStorage 按 origin
// 隔离 ⇒ 偏好不跟用户面共享；「先在用户面切好再进来」这条旧前提在 #450 边缘隔离之后已不成立
// （两个 host 各发一份 SPA，语言只能就地在管理台里切）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { setLocale, type AppLocale } from '../i18n';
import { useAuthStore } from '../stores/auth';

const { t, locale } = useI18n();

// #828 复核查：顶栏要显示「语言偏好未保存到账号」一行——响应式读 store 的 localeSyncFailed 旗标。
// 无激活 pinia（纯组件测试 / 无会话挂载）⇒ 取不到 store ⇒ 恒不显示（不发也不提示，与「未登录不发」一致）。
let authStore: ReturnType<typeof useAuthStore> | null = null;
try {
  authStore = useAuthStore();
} catch {
  authStore = null;
}
const localeSyncFailed = computed(() => authStore?.localeSyncFailed ?? false);

const OPTIONS: readonly { value: AppLocale; labelKey: 'locale.zhCN' | 'locale.en' }[] = [
  { value: 'zh-CN', labelKey: 'locale.zhCN' },
  { value: 'en', labelKey: 'locale.en' },
];

const open = ref(false);
const root = ref<HTMLElement | null>(null);

// 当前语言按钮文案：读 locale.value 保证切语言后响应式更新。
const currentLabel = computed(() => {
  const current = OPTIONS.find((o) => o.value === locale.value) ?? OPTIONS[0];
  return t(current.labelKey);
});

function select(value: AppLocale) {
  // 用户亲自点开关 ⇒ 传 fromUser，立 `locale.userChosen` 标记 + 同作用域的 `locale_chosen` cookie
  // （#828 / #902 ①）：这台浏览器之后不再被账号默认语言抢走（账号种子不传 fromUser，两件事分开）。
  // 回写旁路见下方 syncAccountLocale。
  setLocale(value, { fromUser: true });
  open.value = false;
  // #828 / #902 ②：只有登录态才会把这次选择回写账号；未登录只落本地（见 syncAccountLocale）。
  // fire-and-forget：切换已经在上面生效，回写只是旁路。
  void syncAccountLocale(value);
}

/**
 * #828 / #902 ②：把顶栏语言切换回写到账号（经 store 的 `flushPendingLocale` 发 `PATCH /api/me/locale`）。
 *
 * #902 ②：**只有当前有登录用户时**才记 `pendingLocaleWrite`（带当前 login），再交给
 * `flushPendingLocale()` 补发。三种落点分开：
 * - 无激活 pinia（纯组件测试 / 无会话挂载）⇒ 不发、不记。
 * - **无会话**（`auth.user` 为 `null`，含登录页 / 强制改密屏 / 刚导航到另一 origin 后 `/api/me` 未回）：
 *   **只落本地、一枪都不发、也不记 pending**。为什么不再像旧代码那样记一个「无主哨兵」等补发：
 *   登录页切的是**这台设备**的偏好，不是某个人的账号偏好；旧哨兵会被 flushPendingLocale 当成
 *   「无主，谁先就绪发给谁」⇒ 共享设备上「我切语言，写进下一个登录者的账号」（#902 ② 的缺陷）。
 *   要给账号写就登录后再点一次（pending 是内存态、刷新即丢，见 store 的 #902 ② 边界注释）。
 * - **已登录**：记 pending 带当前 login，随即 flushPendingLocale 补发这一枪（就绪 ⇒ 会发；登录态下
 *   `user.login` 与 pending 一致 ⇒ 通过归属检查）。失败静默（flushPendingLocale 内已置 localeSyncFailed）。
 */
async function syncAccountLocale(value: AppLocale): Promise<void> {
  let auth: ReturnType<typeof useAuthStore>;
  try {
    auth = useAuthStore();
  } catch {
    return; // 无激活的 pinia（登录页以外的挂载形式）⇒ 不发、也不记
  }
  const user = auth.user;
  if (!user) return; // 无会话 ⇒ 只落本地（setLocale 已写 cookie+localStorage+标记），不发、不排队（#902 ②）
  // 有登录用户 ⇒ 记 pending 带当前 login，再立即补发（就绪 ⇒ flushPendingLocale 会发这一枪；
  // 失败也只在 store 里置 localeSyncFailed，不打断切换）。
  auth.pendingLocaleWrite = { login: user.login, locale: value };
  await auth.flushPendingLocale();
}

// 外部点击收起（点击组件内部元素不收起；mousedown 之外用 click 以兼容键盘触发）。
function onDocumentClick(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener('click', onDocumentClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick));
</script>

<template>
  <div ref="root" class="relative inline-block">
    <button
      type="button"
      class="flex items-center gap-1 rounded-md border border-black/20 px-2 py-0.5 text-sm text-black/70 hover:bg-black/5"
      :aria-label="t('locale.label')"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span>{{ currentLabel }}</span>
      <span aria-hidden="true" class="text-[0.6rem] leading-none">▾</span>
    </button>

    <ul
      v-if="open"
      role="menu"
      class="absolute right-0 z-10 mt-1 min-w-full overflow-hidden rounded-md border border-black/20 bg-white py-0.5 shadow-sm"
    >
      <li v-for="opt in OPTIONS" :key="opt.value" role="none">
        <button
          type="button"
          role="menuitem"
          class="block w-full whitespace-nowrap px-3 py-1 text-left text-sm hover:bg-black/5"
          :class="opt.value === locale ? 'text-brand' : 'text-black/80'"
          @click="select(opt.value)"
        >{{ t(opt.labelKey) }}</button>
      </li>
    </ul>

    <!-- #828 复核查：回写失败的可重试提示——不弹红条、不打断，仅一行小字；再点一次开关会重新尝试并自动收起。 -->
    <p
      v-if="localeSyncFailed"
      data-test="locale-sync-failed"
      class="mt-0.5 text-[0.7rem] leading-tight text-red-600"
    >{{ t('locale.accountSaveFailed') }}</p>
  </div>
</template>
