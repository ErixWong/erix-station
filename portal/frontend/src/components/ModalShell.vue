<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, useTemplateRef } from 'vue';

withDefaults(defineProps<{
  label: string;
  dialogClass?: string;
}>(), {
  dialogClass: 'md:w-[26rem]',
});

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const dialogEl = useTemplateRef<HTMLElement>('dialogEl');
let previousFocus: HTMLElement | null = null;
let previousOverflow = '';

onMounted(async () => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  await nextTick();
  const dialog = dialogEl.value;
  const firstInput = dialog?.querySelector<HTMLElement>(
    'input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
  );
  const firstButton = dialog?.querySelector<HTMLElement>('button:not([disabled])');
  (firstInput ?? firstButton ?? dialog)?.focus();
});

onUnmounted(() => {
  document.body.style.overflow = previousOverflow;
  previousFocus?.focus();
});

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50" @keydown="onKeydown">
    <div data-test="modal-backdrop" class="absolute inset-0 bg-black/40" @click.self="emit('close')"></div>
    <div
      ref="dialogEl"
      role="dialog"
      aria-modal="true"
      :aria-label="label"
      tabindex="-1"
      class="absolute inset-x-0 top-10 bottom-auto bg-white shadow-xl outline-none max-md:rounded-t-lg md:inset-auto md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg"
      :class="dialogClass"
    >
      <slot />
    </div>
  </div>
</template>
