<script setup lang="ts">
// 管理台 · 预览号池占用总览（issue #350）。
//
// 存在的理由（§4.7a）：改块原本只能填一个数字试错，撞 `409 preview_port_block_taken` 才知道那段被占。
// 本页把「哪几段被谁占、哪几段整段空闲」一次画出来，管理员**先看这里再选段**。
//
// 判据（工单 ①-⑥，逐条都有 spec 用例钉住）：
//   ① 懒挂载：进管理台不请求，切到本 tab 才发**恰好 1 次** `GET /api/admin/preview-ports/usage`
//      （`onMounted` 是唯一触发点，本组件不 watch 任何东西）；
//   ② 零端口/号池字面量：段边界 / 块大小 / 总段数**全部来自响应的 `pool`**（源码级断言在 spec 里）；
//   ③ 不猜数：缺失/脏值显示「—」，`free_blocks.items` 为空与「还没请求」分开呈现，
//      `has_more=true` 必须说「只显示前 N 段，还有更多」并给出 `limit`；
//   ⑤ `partial > 0` 有独立呈现（不并进 free/occupied）；
//   ⑥ 请求失败给一行错误（复用既有 `.syserr` 形态；服务端 message 原文，只加本地化前缀）。
//
// 本页**只读**：没有任何写操作、不碰 `block_start_input`、不提供「一键用这段」按钮
// （#256 口径：管理员显式指定的段被占要报错，禁止偷偷换段）。
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAdminStore } from '../stores/admin';
import {
  blockEnd,
  formatBlockLabel,
  usageConsistencyIssues,
  type PreviewOccupiedBlock,
  type UsageIssueKey,
} from '../lib/previewPoolUsage';

const { t } = useI18n();
const admin = useAdminStore();

const usage = computed(() => admin.previewUsage);
const loaded = computed(() => admin.previewUsageLoaded);
const loading = computed(() => admin.previewUsageLoading);
const error = computed(() => admin.previewUsageErr);
const pool = computed(() => usage.value?.pool ?? null);
const summary = computed(() => usage.value?.summary ?? {
  totalBlocks: null, free: null, partial: null, occupied: null,
});
const occupiedBlocks = computed(() => usage.value?.occupiedBlocks ?? []);
const freeBlocks = computed(() => usage.value?.freeBlocks ?? { items: [], limit: null, hasMore: null });
const blockSize = computed(() => pool.value?.blockSize ?? null);
const issues = computed<UsageIssueKey[]>(() => (usage.value ? usageConsistencyIssues(usage.value) : []));

/** 缺值一律「—」（判据③：不许把缺失/脏值渲染成 0）。 */
function numText(value: number | null): string {
  return value === null ? t('admin.previewPool.unknownValue') : String(value);
}

/** 空闲段的末端由 `pool.block_size` 推导（响应只给起点）；块大小缺失 ⇒ 只显示起点，不编造末端。 */
function freeLabel(start: number): string {
  return formatBlockLabel(start, blockEnd(start, blockSize.value));
}

function occupiedLabel(block: PreviewOccupiedBlock): string {
  return formatBlockLabel(block.start, block.end ?? blockEnd(block.start, blockSize.value));
}

function issueText(key: UsageIssueKey): string {
  return t(`admin.previewPool.issue.${key}`);
}

onMounted(() => {
  // 唯一触发点（判据①）。store 的 action 自己 catch ⇒ 这里不会产生未捕获拒绝（AGENTS.md §4 的 rc=1 坑）。
  void admin.loadPreviewUsage();
});
</script>

<template>
  <section data-test="preview-pool-usage" class="grid gap-3">
    <header>
      <h2 class="text-lg font-medium">{{ t('admin.previewPool.title') }}</h2>
      <p class="mt-1 text-xs text-black/60">{{ t('admin.previewPool.intro') }}</p>
    </header>

    <p v-if="loading" data-test="usage-loading" class="text-sm text-black/60" role="status">
      {{ t('admin.previewPool.loading') }}
    </p>
    <!-- 判据⑥：错误面 = 既有 .syserr 形态；服务端 message 原文（不翻译），前缀本地化 -->
    <p v-if="error" data-test="usage-error" class="syserr text-sm" role="alert">{{ error }}</p>

    <!-- 判据③：「还没请求」与「请求到了但一个都没有」是两种不同的画面 -->
    <p v-if="!loaded && !loading && !error" data-test="usage-not-loaded" class="text-sm text-black/60">
      {{ t('admin.previewPool.notLoaded') }}
    </p>

    <template v-if="loaded">
      <p data-test="usage-pool" class="text-sm">
        <template v-if="pool">
          {{ t('admin.previewPool.poolRange', {
            start: pool.start, end: pool.end, size: pool.blockSize, total: pool.totalBlocks,
          }) }}
        </template>
        <template v-else>{{ t('admin.previewPool.poolMissing') }}</template>
      </p>

      <p v-if="issues.length > 0" data-test="usage-inconsistent" class="syserr text-sm" role="alert">
        {{ t('admin.previewPool.inconsistent', {
          issues: issues.map(issueText).join(t('admin.previewPool.issueSep')),
        }) }}
      </p>

      <section data-test="usage-summary" class="rounded-lg border border-black/10 p-3">
        <h3 class="text-sm font-semibold">{{ t('admin.previewPool.summaryTitle') }}</h3>
        <dl class="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <div>
            <dt class="text-xs text-black/55">{{ t('admin.previewPool.summaryTotal') }}</dt>
            <dd data-test="summary-total">{{ numText(summary.totalBlocks) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-black/55">{{ t('admin.previewPool.summaryFree') }}</dt>
            <dd data-test="summary-free">{{ numText(summary.free) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-black/55">{{ t('admin.previewPool.summaryPartial') }}</dt>
            <dd data-test="summary-partial">{{ numText(summary.partial) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-black/55">{{ t('admin.previewPool.summaryOccupied') }}</dt>
            <dd data-test="summary-occupied">{{ numText(summary.occupied) }}</dd>
          </div>
        </dl>
      </section>

      <!-- 判据⑤：partial 独立成块（显眼、且文案说清「选段要避开」），绝不并进 free/occupied -->
      <section
        v-if="summary.partial !== null && summary.partial > 0"
        data-test="usage-partial"
        class="rounded-lg border border-amber-400 bg-amber-50 p-3"
        role="alert"
      >
        <h3 class="text-sm font-semibold text-amber-900">
          {{ t('admin.previewPool.partialTitle', { count: summary.partial }) }}
        </h3>
        <p class="mt-1 text-sm text-amber-900">{{ t('admin.previewPool.partialBody') }}</p>
      </section>

      <section data-test="usage-occupied" class="rounded-lg border border-black/10 p-3">
        <h3 class="text-sm font-semibold">{{ t('admin.previewPool.occupiedTitle', { count: occupiedBlocks.length }) }}</h3>
        <p v-if="!usage?.occupiedPresent" data-test="occupied-missing" class="mt-1 text-sm text-black/60">
          {{ t('admin.previewPool.occupiedMissing') }}
        </p>
        <p v-else-if="occupiedBlocks.length === 0" data-test="occupied-empty" class="mt-1 text-sm text-black/60">
          {{ t('admin.previewPool.occupiedEmpty') }}
        </p>
        <ul v-else class="mt-1 grid gap-1 text-sm">
          <li
            v-for="block in occupiedBlocks"
            :key="block.start"
            data-test="occupied-block"
            class="flex flex-wrap gap-x-2 border-b border-black/5 pb-1 last:border-b-0"
          >
            <span class="font-mono" data-test="occupied-block-range">{{ occupiedLabel(block) }}</span>
            <span data-test="occupied-block-count" class="text-black/60">
              {{ block.occupiedCount === null
                ? t('admin.previewPool.occupiedCountUnknown')
                : t('admin.previewPool.occupiedCount', { count: block.occupiedCount }) }}
            </span>
            <span data-test="occupied-block-names">
              {{ block.fdeNames.length > 0
                ? t('admin.previewPool.occupiedBy', { names: block.fdeNames.join(', ') })
                : t('admin.previewPool.occupiedByUnknown') }}
            </span>
          </li>
        </ul>
      </section>

      <section data-test="usage-free" class="rounded-lg border border-black/10 p-3">
        <h3 class="text-sm font-semibold">
          {{ t('admin.previewPool.freeTitle', { count: freeBlocks.items.length }) }}
        </h3>
        <p v-if="!usage?.freePresent" data-test="free-missing" class="mt-1 text-sm text-black/60">
          {{ t('admin.previewPool.freeMissing') }}
        </p>
        <p v-else-if="freeBlocks.items.length === 0" data-test="free-empty" class="mt-1 text-sm text-black/60">
          {{ t('admin.previewPool.freeEmpty') }}
        </p>
        <ul v-else class="mt-1 flex flex-wrap gap-1 text-sm">
          <li
            v-for="start in freeBlocks.items"
            :key="start"
            data-test="free-block"
            class="rounded border border-black/15 px-1.5 py-0.5 font-mono"
          >{{ freeLabel(start) }}</li>
        </ul>
        <!-- 判据③：has_more 必须说清「只显示前 N 段，还有更多」+ 把 limit 显示出来 -->
        <p
          v-if="freeBlocks.hasMore === true"
          data-test="free-more"
          class="mt-1 text-sm text-amber-900"
          role="status"
        >{{ freeBlocks.limit === null
          ? t('admin.previewPool.freeMoreNoLimit', { shown: freeBlocks.items.length })
          : t('admin.previewPool.freeMore', { shown: freeBlocks.items.length, limit: freeBlocks.limit }) }}</p>
      </section>
    </template>
  </section>
</template>
