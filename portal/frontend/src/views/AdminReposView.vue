<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
</script>

<template>
  <section class="rounded-lg border border-black/10 bg-white p-4">
    <h2 class="text-base font-semibold">{{ t('admin.repos.title') }}</h2>
    <p class="mt-2 text-sm text-black/55">{{ t('admin.repos.placeholder') }}</p>
  </section>
</template>
