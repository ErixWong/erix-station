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

const { t, locale } = useI18n();

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
  setLocale(value);
  open.value = false;
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
  </div>
</template>
