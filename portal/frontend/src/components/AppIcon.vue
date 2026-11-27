<script setup lang="ts">
// issue #818 §⑤：自维护内联 SVG 图标的**唯一渲染点**（几何数据在 `lib/icons.ts`，不引图标库）。
//
// 与 `MacroBell.vue` 里手写 `<svg>` 同款口径：`viewBox="0 0 24 24"`、`stroke="currentColor"`、
// `aria-hidden="true"`（图标是装饰，读屏读的是旁边那个词）。
//
// ⚠ `name` 不在表里 ⇒ 渲染**空 `<svg>`，不抛**。理由见 `lib/icons.ts` 文件头 ③：
// 少一个键的后果必须是「少一个装饰」，不能是「整块导航没了」。
import { computed } from 'vue';
import { ICON_PATHS } from '../lib/icons';

const props = defineProps<{ name: string }>();

const paths = computed<string[]>(() => ICON_PATHS[props.name] ?? []);
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="h-4 w-4 shrink-0"
    data-test="app-icon"
    :data-icon="name"
  >
    <path v-for="(d, index) in paths" :key="index" :d="d" />
  </svg>
</template>
