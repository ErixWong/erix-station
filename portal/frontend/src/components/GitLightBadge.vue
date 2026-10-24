<script setup lang="ts">
// 收工灯（issue #359 / 决策 §7 D9，P0b）：回答**唯一一个问题**——"你的活儿现在被 git 保护住了吗"。
//
// 产品口径（都在 §7 D9 / issue #359，这里只写界面侧的三条硬规矩）：
//   ① **颜色不是唯一语义通道**（`PreviewPortsPanel.vue:12` 立的规矩）：点旁边**必须**有文字标签，
//      完整口径进 `title` + `aria-label`（鼠标悬停与读屏拿到的是同一句话）。
//   ② **红是日常态，不是警报**：agent 正在干活就该是红 ⇒ 不用 `⚠`、不给告警底色，只是"还没落地"。
//   ③ **⚪ 不得渲染成绿**：显示口径唯一在 `lib/gitLight.ts` 的 `gitLightDisplay`，本组件不自己判色。
//
// 平台零 git 写（D9）：这里**没有** init/commit/push 按钮。唯一的动作是把话**预填进输入框**
// （发出去就是一次 run，烧容量与 token ⇒ 不能自动发），另给一条"问 AI"万能兜底。
import { computed, onMounted, onScopeDispose, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  checkedAgo,
  dirtyRepoNames,
  gitLightDisplay,
  type GitLightApiError,
  type GitLightPayload,
} from '../lib/gitLight';

const props = withDefaults(defineProps<{
  payload?: GitLightPayload | null;
  loading?: boolean;
  error?: GitLightApiError | null;
  /** 当前目录（只在 tooltip 里点名检查对象；不发请求，取数在 composable）。 */
  cwd?: string | null;
}>(), {
  payload: null,
  loading: false,
  error: null,
  cwd: null,
});

const emit = defineEmits<{
  (e: 'refresh'): void;
  /** 预填进输入框的整句话（父组件写 store.inputValue，**不自动发送**）。 */
  (e: 'prefill', text: string): void;
}>();

const { t } = useI18n();
const open = ref(false);
const root = ref<HTMLElement | null>(null);

const display = computed(() => gitLightDisplay(props.payload));
const label = computed(() => t(`gitLight.label.${display.value.state}`));
const reasonText = computed(() => t(display.value.reasonKey));
const ago = computed(() => (props.payload ? checkedAgo(props.payload.checked_at) : null));

/** 一句话完整口径：状态 + 原因 + 该说的补充（没查完 / 服务端没 git / 绿的诚实声明 / 本次失败）。 */
const tip = computed(() => {
  const parts = [`${label.value}：${reasonText.value}`];
  if (props.payload?.partial) parts.push(t('gitLight.tip.partial'));
  if (props.payload && props.payload.truncated_repos > 0) {
    parts.push(t('gitLight.tip.truncatedRepos', { count: props.payload.truncated_repos }));
  }
  if (props.payload && !props.payload.git_available) parts.push(t('gitLight.tip.gitUnavailable'));
  if (display.value.state === 'green') parts.push(t('gitLight.tip.greenHonest'));
  if (props.error) parts.push(t('gitLight.tip.error', { status: props.error.status, code: props.error.code }));
  if (ago.value) parts.push(t('gitLight.tip.checkedAgo', { ago: ago.value }));
  return parts.join(' ');
});

const dotClass = computed(() => ({
  red: 'bg-red-500',
  yellow: 'bg-amber-400',
  green: 'bg-emerald-500',
  grey: 'bg-black/25',
})[display.value.state]);

/** 逐仓库明细：全列（取最差已经在后端做过，这里不再筛——用户要能看到“到底哪个脏”）。 */
const rows = computed(() => props.payload?.repos ?? []);

function rowTip(row: { reason: string; light: string; branch: string | null; tracked_count: number; untracked_count: number; truncated: boolean; shell: boolean }): string {
  const parts = [t(`gitLight.reason.${rowReasonKey(row.reason)}`)];
  if (row.shell) parts.push(t('gitLight.row.shellNote'));
  if (row.tracked_count > 0 || row.untracked_count > 0) {
    parts.push(t('gitLight.row.counts', { tracked: row.tracked_count, untracked: row.untracked_count }));
  }
  if (row.truncated) parts.push(t('gitLight.row.truncated'));
  return parts.join(' ');
}

/** 与 lib 同一张 reason→key 表（不自己拼，避免两边漂移）。 */
function rowReasonKey(reason: string): string {
  const known = [
    'uncommitted', 'untracked', 'no_commits', 'unpushed_or_diverged', 'no_remote', 'no_upstream',
    'never_fetched', 'detached', 'synced', 'no_repo', 'covered_by_outer_repo', 'empty',
    'unchecked_partial', 'unchecked_failed', 'busy', 'unreadable', 'git_unavailable', 'shell', 'unknown',
  ];
  return known.includes(reason) ? reason : 'unknown';
}

function prefillFinish(): void {
  const { names, more } = dirtyRepoNames(props.payload);
  emit('prefill', t('gitLight.prefill.finish', {
    repos: names.length > 0 ? names.join('、') : t('gitLight.prefill.thisDir'),
    more: more > 0 ? t('gitLight.prefill.moreSuffix', { count: more }) : '',
  }));
  open.value = false;
}

function prefillAsk(): void {
  emit('prefill', t('gitLight.prefill.ask', {
    state: label.value,
    reason: reasonText.value,
    cwd: props.cwd ?? '',
  }));
  open.value = false;
}

function onRefresh(): void {
  emit('refresh');
}

function onDocPointerDown(event: MouseEvent): void {
  if (!open.value) return;
  if (root.value && event.target instanceof Node && root.value.contains(event.target)) return;
  open.value = false;
}

onMounted(() => {
  if (typeof document !== 'undefined') document.addEventListener('mousedown', onDocPointerDown);
});
onScopeDispose(() => {
  if (typeof document !== 'undefined') document.removeEventListener('mousedown', onDocPointerDown);
});
</script>

<template>
  <div ref="root" class="relative" data-test="git-light">
    <button
      type="button"
      data-test="git-light-badge"
      class="flex items-center gap-1.5 rounded-md border border-black/10 px-2 py-0.5 text-sm hover:bg-black/5"
      :class="loading && 'opacity-60'"
      :title="tip"
      :aria-label="tip"
      :aria-expanded="open ? 'true' : 'false'"
      @click="open = !open"
    >
      <!-- 颜色不承重：点只是复述，语义在旁边的文字标签与 title/aria-label 里 -->
      <span aria-hidden="true" class="inline-block h-2 w-2 rounded-full" :class="dotClass" data-test="git-light-dot" />
      <span data-test="git-light-label">{{ loading && !payload ? t('gitLight.loading') : label }}</span>
      <span v-if="payload?.partial" class="text-[11px] text-black/45" data-test="git-light-partial">{{ t('gitLight.partialBadge') }}</span>
    </button>

    <div
      v-if="open"
      class="absolute left-0 z-30 mt-1 w-80 rounded-md border border-black/10 bg-white p-2.5 shadow-lg"
      data-test="git-light-panel"
      role="dialog"
      :aria-label="t('gitLight.panelAria')"
    >
      <p class="text-[11px] leading-[1.5] text-black/55" data-test="git-light-tip">{{ tip }}</p>

      <ul v-if="rows.length" class="mt-2 space-y-1 max-h-52 overflow-auto">
        <li
          v-for="row in rows"
          :key="row.rel || '.'"
          class="flex items-center gap-1.5 text-sm"
          data-test="git-light-row"
          :title="rowTip(row)"
        >
          <span aria-hidden="true" class="inline-block h-1.5 w-1.5 shrink-0 rounded-full" :class="{
            'bg-red-500': row.light === 'red',
            'bg-amber-400': row.light === 'yellow',
            'bg-emerald-500': row.light === 'green',
            'bg-black/25': row.light !== 'red' && row.light !== 'yellow' && row.light !== 'green',
          }" />
          <span class="truncate">{{ row.rel === '' ? row.repo : row.rel }}</span>
          <span class="text-[11px] text-black/45">{{ t(`gitLight.label.${['red','yellow','green','grey'].includes(row.light) ? row.light : 'grey'}`) }}</span>
          <span v-if="row.branch" class="text-[11px] text-black/35">{{ row.branch }}</span>
        </li>
      </ul>
      <p v-else class="mt-2 text-[11px] text-black/45">{{ t('gitLight.noRepos') }}</p>

      <div class="mt-2.5 flex flex-wrap items-center gap-1.5">
        <button
          v-if="display.needsAction"
          type="button"
          data-test="git-light-finish"
          class="rounded-md border border-black/20 px-2 py-0.5 text-sm hover:bg-black/5"
          :title="t('gitLight.action.finishHint')"
          @click="prefillFinish"
        >{{ t('gitLight.action.finish') }}</button>
        <button
          type="button"
          data-test="git-light-ask"
          class="rounded-md border border-black/10 px-2 py-0.5 text-sm hover:bg-black/5"
          @click="prefillAsk"
        >{{ t('gitLight.action.ask') }}</button>
        <button
          type="button"
          data-test="git-light-refresh"
          class="rounded-md border border-black/10 px-2 py-0.5 text-sm hover:bg-black/5"
          @click="onRefresh"
        >{{ t('gitLight.action.refresh') }}</button>
      </div>
      <p v-if="display.needsAction" class="mt-1.5 text-[11px] leading-[1.5] text-black/40" data-test="git-light-finish-hint">
        {{ t('gitLight.action.finishHint') }}
      </p>
    </div>
  </div>
</template>
