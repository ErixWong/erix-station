<script setup lang="ts">
// 管理台 · 某个 FDE 的预览端口面板（#246 交付② 单 B）：列表 + **改块**（搬迁）入口。
// 改块的两条硬要求（工单红线）：
//   ① **先二次确认，确认之前不得发出 POST**（旧段 10 条预览域名会当场失效、FDE 手里的链接会断，
//      这是不可撤销的用户可见影响 ⇒ 确认文案必须点名旧段与新段）；确认闸门就在本组件里，
//      `requestBlockMove()` 只在点「确认搬迁」后调用。
//   ② 409 `preview_port_block_taken` 的 message 点名了「哪一段、被哪几个号占」⇒ **全文显示**，
//      不吞成「操作失败」；400 `validation_failed`（details.field='block_start'）指到输入框。
// 确认条是内联的（不是第二层 modal）：外层 FDE 编辑框本身已是 ModalShell，套两层会让 Esc
// 同时触发内外两个 close（ModalShell 不在子层阻止冒泡）⇒ 一次 Esc 连编辑框一起关掉。
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import PreviewPortsPanel from './PreviewPortsPanel.vue';
import { requestBlockMove, usePreviewPorts } from '../composables/usePreviewPorts';
import {
  PREVIEW_BLOCK_START_MAX,
  PREVIEW_BLOCK_START_MIN,
  PREVIEW_PORT_BLOCK_SIZE,
  formatBlockRange,
  isAlignedBlockStart,
  parseBlockStart,
  previewBlockEnd,
  type PreviewApiError,
  type PreviewBlockMoveResult,
} from '../lib/previewPorts';

const props = defineProps<{ fdeName: string }>();

const { t } = useI18n();
const ports = usePreviewPorts({ fdeName: () => props.fdeName });

const blockStart = ref('');
/** 待确认的块起点：非 null = 确认条已弹出（此时仍未发出任何 POST）。 */
const pendingStart = ref<number | null>(null);
const moving = ref(false);
const moveError = ref<PreviewApiError | null>(null);
const fieldError = ref('');
const result = ref<PreviewBlockMoveResult | null>(null);
/** 确认/结果文案要点名的旧段（发请求前抓一份，搬迁后列表就换成新段了）。 */
const fromBlock = ref<string>('');
const confirmButton = useTemplateRef<HTMLButtonElement>('confirmButton');

const currentBlock = computed(() => formatBlockRange(ports.blockRange.value));
const portCount = computed(() => ports.items.value.length);
const isBlockTaken = computed(() => moveError.value?.code === 'preview_port_block_taken');

/** 新段标签（起点 + 块大小，不写死 +9）。 */
function newBlockLabel(start: number): string {
  return `${start}–${previewBlockEnd(start)}`;
}

async function reload() {
  await ports.load();
}

onMounted(() => { void reload(); });
watch(() => props.fdeName, () => {
  blockStart.value = '';
  pendingStart.value = null;
  moveError.value = null;
  fieldError.value = '';
  result.value = null;
  void reload();
});

/** 「改块…」：只做本地整数校验 + 弹确认，**不发请求**（未确认不得 POST）。 */
async function requestMove() {
  moveError.value = null;
  fieldError.value = '';
  result.value = null;
  const parsed = parseBlockStart(blockStart.value);
  if (parsed === null) {
    fieldError.value = t('previewPorts.admin.notInteger');
    return;
  }
  fromBlock.value = currentBlock.value;
  pendingStart.value = parsed;
  await nextTick();
  confirmButton.value?.focus();
}

function cancelMove() {
  pendingStart.value = null;
}

/** 确认后才有网络请求（409 全文 / 400 指字段 / 200 展示搬迁计数并刷新列表）。 */
async function confirmMove() {
  const start = pendingStart.value;
  if (start === null || moving.value) return;
  moving.value = true;
  moveError.value = null;
  fieldError.value = '';
  try {
    const outcome = await requestBlockMove(props.fdeName, start);
    if (outcome.ok) {
      result.value = outcome.result;
      pendingStart.value = null;
      await reload(); // 旧段已 released：列表要立刻换成新段的 10 行
    } else {
      const error = outcome.error;
      moveError.value = error;
      pendingStart.value = null; // 让管理员能直接改起点重试（不锁在确认条里）
      if (error.code === 'validation_failed' && (error.field === null || error.field === 'block_start')) {
        fieldError.value = t('previewPorts.admin.fieldErrorBlockStart', { message: error.message });
      }
    }
  } finally {
    moving.value = false;
  }
}

function resultText(moved: PreviewBlockMoveResult): string {
  return t('previewPorts.admin.moved', {
    // 旧段在发请求前抓的（搬完列表就换成新段了）；本来就没有活段时用「—」占位
    oldBlock: fromBlock.value || '—',
    newBlock: `${moved.block_start}–${moved.block_end}`,
    released: moved.released_allocations,
    revoked: moved.revoked_grants,
    inserted: moved.inserted_allocations,
  });
}

/** 409：错误条 = 「改块失败（码）」+ 服务端 message 全文（里面有被占的段与号）。 */
function errorText(error: PreviewApiError): string {
  return t('previewPorts.admin.moveFailed', { code: error.code, message: error.message });
}
</script>

<template>
  <div data-test="fde-ports-pane" class="grid gap-3">
    <PreviewPortsPanel
      scope="fde"
      :fde-name="props.fdeName"
      :items="ports.items.value"
      :loading="ports.loading.value"
      :loaded="ports.loaded.value"
      :error="ports.listError.value"
      :ticket-busy-id="ports.ticketBusyId.value"
      :ticket-error="ports.ticketError.value"
      :popup-blocked-url="ports.popupBlockedUrl.value"
      @retry="reload"
      @open="(item) => ports.openPreview(item)"
    />

    <section data-test="block-move" class="rounded-lg border border-amber-300/60 bg-amber-50/60 p-3">
      <h4 class="text-sm font-semibold text-amber-900">{{ t('previewPorts.admin.moveTitle') }}</h4>
      <p data-test="block-current-range" class="mt-1 text-xs text-black/65">
        {{ portCount > 0
          ? t('previewPorts.admin.currentBlock', { block: currentBlock, count: portCount })
          : t('previewPorts.admin.currentBlockNone') }}
      </p>
      <p class="mt-1 text-xs text-black/55">{{ t('previewPorts.admin.blockHint') }}</p>

      <div class="mt-2 flex flex-wrap items-end gap-2">
        <label class="flex min-w-40 flex-col gap-1 text-xs text-black/60">
          {{ t('previewPorts.admin.blockStartLabel') }}
          <input
            v-model="blockStart"
            data-test="block-start-input"
            type="number"
            inputmode="numeric"
            :step="PREVIEW_PORT_BLOCK_SIZE"
            :min="PREVIEW_BLOCK_START_MIN"
            :max="PREVIEW_BLOCK_START_MAX"
            :placeholder="t('previewPorts.admin.blockStartPlaceholder')"
            :aria-invalid="fieldError ? 'true' : undefined"
            :aria-describedby="fieldError ? 'block-start-error' : undefined"
            class="rounded-md border border-black/20 px-2 py-1 text-sm text-black disabled:bg-black/5"
            :disabled="moving"
            @keydown.enter.prevent="requestMove"
          >
        </label>
        <button
          type="button"
          data-test="open-block-move"
          class="rounded-md bg-brand px-2.5 py-1.5 text-sm text-white hover:bg-brand-hover disabled:opacity-50"
          :disabled="moving || pendingStart !== null"
          @click="requestMove"
        >{{ moving ? t('previewPorts.admin.moving') : t('previewPorts.admin.moveAction') }}</button>
      </div>

      <p
        v-if="fieldError"
        id="block-start-error"
        data-test="block-start-field-error"
        class="syserr mt-1 text-xs"
        role="alert"
      >{{ fieldError }}</p>
      <p
        v-else-if="pendingStart !== null && !isAlignedBlockStart(pendingStart)"
        data-test="block-start-align-hint"
        class="mt-1 text-xs text-amber-800"
        role="status"
      >{{ t('previewPorts.admin.alignHint') }}</p>

      <!-- 二次确认：弹出即说明旧域名会立刻失效；此时仍未发出任何 POST -->
      <div
        v-if="pendingStart !== null"
        data-test="block-move-confirm"
        role="alertdialog"
        aria-labelledby="block-move-confirm-title"
        class="mt-2 rounded-md border border-red-300 bg-white p-2.5"
      >
        <h5 id="block-move-confirm-title" class="text-sm font-semibold text-red-800">
          {{ t('previewPorts.admin.confirmTitle') }}
        </h5>
        <p class="mt-1 text-sm">
          {{ portCount > 0
            ? t('previewPorts.admin.confirmBody', {
              fde: props.fdeName,
              oldBlock: fromBlock,
              newBlock: newBlockLabel(pendingStart),
              count: portCount,
            })
            : t('previewPorts.admin.confirmBodyNoBlock', {
              fde: props.fdeName,
              newBlock: newBlockLabel(pendingStart),
            }) }}
        </p>
        <p class="mt-1 text-sm font-medium text-red-800">{{ t('previewPorts.admin.confirmWarning') }}</p>
        <div class="mt-2 flex gap-2">
          <button
            ref="confirmButton"
            type="button"
            data-test="confirm-block-move"
            :disabled="moving"
            class="rounded-md bg-red-700 px-2.5 py-1 text-sm text-white hover:bg-red-800 disabled:opacity-50"
            @click="confirmMove"
          >{{ t('previewPorts.admin.confirmOk') }}</button>
          <button
            type="button"
            data-test="cancel-block-move"
            class="rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5"
            @click="cancelMove"
          >{{ t('common.cancel') }}</button>
        </div>
      </div>

      <p v-if="moveError" data-test="block-move-error" class="syserr mt-2 text-sm" role="alert">
        {{ errorText(moveError) }}
      </p>
      <p v-if="isBlockTaken" data-test="block-move-taken-hint" class="mt-1 text-xs text-amber-900" role="status">
        {{ t('previewPorts.admin.blockTakenHint') }}
      </p>

      <template v-if="result">
        <p
          data-test="block-move-result"
          class="mt-2 text-sm text-green-800"
          role="status"
        >{{ result.changed
          ? resultText(result)
          : t('previewPorts.admin.movedNoop', { block: newBlockLabel(result.block_start) }) }}</p>
        <p v-if="result.changed" data-test="block-move-ports" class="mt-1 break-all text-xs text-black/60">
          {{ t('previewPorts.admin.movedPorts', { ports: result.ports.join(', ') }) }}
        </p>
      </template>
    </section>
  </div>
</template>
