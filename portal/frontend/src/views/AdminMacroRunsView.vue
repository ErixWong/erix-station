<script setup lang="ts">
// 管理台 · 宏执行历史（issue #529，事件平台 W6）。骨架占位，随后补全。
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
</script>

<template>
  <section data-test="admin-macro-runs" class="grid gap-3">
    <h2 class="text-lg font-medium">{{ t('admin.macroRuns.title') }}</h2>
  </section>
</template>
