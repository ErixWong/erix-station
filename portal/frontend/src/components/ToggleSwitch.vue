<script setup lang="ts">
// 通用「轨道 + 滑块」开关（工单 feat-261110-02）。
//
// 为什么要有这个组件：管理台用户抽屉里的「邮件验证码」「文件上传」原先是裸 `<input type=checkbox>`，
// 用户的话是「你这谁看了会觉得这是 switch？」——勾选框在视觉上没有「档位」可言。这里做成
// 一眼能看出「是个开关 + 现在停在哪一档」的形态：56×28 的轨道、24 的圆形滑块、开=品牌色关=灰。
//
// 可访问性口径沿用 `LoginView.vue` 的 #449 两档 switch：`<button type="button">` 自带 Tab 聚焦 +
// Space/Enter 触发，所以**不自己实现 tabindex 轮换**；状态只由 `role="switch"` + `aria-checked` 承载。
// `aria-label` 只放「这是什么开关」的短标签（长句说明留在调用方的可见文案里，别塞进 aria-label）。
const props = withDefaults(defineProps<{
  modelValue: boolean;
  /** 短标签（进 `aria-label`）：说「这是什么的开关」，不放整句说明。 */
  label: string;
  disabled?: boolean;
  /** 挂在**按钮**上的 `data-test`（用例按它选元素，与旧 checkbox 的同名 test id 保持连续）。 */
  testId?: string;
}>(), {
  disabled: false,
  testId: undefined,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();

function toggle(): void {
  // 禁用态在这里再挡一道：`disabled` 属性已经让浏览器不触发 click，但组件不该依赖调用方记得绑它。
  if (props.disabled) return;
  emit('update:modelValue', !props.modelValue);
}
</script>

<template>
  <button
    type="button"
    role="switch"
    :data-test="testId"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    :class="modelValue ? 'border-brand bg-brand' : 'border-black/25 bg-black/20'"
    class="relative inline-flex h-7 w-14 shrink-0 items-center rounded-full border transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
    @click="toggle"
  >
    <!-- 滑块：轨道内边距 3px，行程 = 56 - 2(边框) - 24(滑块) - 3(左) - 1(右余量) = 26px。
         纯位移过渡（transition-transform），不动 layout。 -->
    <span
      aria-hidden="true"
      class="pointer-events-none absolute left-[3px] h-6 w-6 rounded-full bg-white shadow transition-transform duration-150"
      :class="modelValue ? 'translate-x-[26px]' : 'translate-x-0'"
    ></span>
  </button>
</template>
