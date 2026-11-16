<script setup lang="ts">
// 管理台 · 上传上限（issue #485 片 A，契约 `docs/api/portal.md` §4.15）。
//
// 这一页存在的理由只有一条：**改一个数字不该要重建容器**。所以它的判据不在"能不能填"，而在：
//   ① 显示的是**当前生效值**（`maxFileBytes`）与它的**来源**（DB / env / 默认）——只显示一个数字，
//      运维就不知道「我改的这个数到底听不听」；`source ≠ db` 时还要说清为什么（`reason`）。
//   ② 保存后**用响应 DTO 回填**（它出自 `RETURNING`），于是页面显示的永远是"库里现在的值"，
//      不是"我以为写进去的值"。
//   ③ 前端**不抢服务端的闸**：解析得出整数就照发（哪怕越界），由 `400 validation_failed` +
//      `details.field` 回来标红那个框；解析不出整数（空、`1.5`、`1e7`）才不发请求——
//      发一个 `null` 只是把"用户还没填"伪装成"用户填了个非法值"。
//   ④ 「改完立即生效」这句话不许写成承诺而不验证：页面把生效时刻说成"下一次上传"，
//      真机判据由后端单测（`portal/test/upload-settings.test.js` US-8）与主 agent 的真机验收共同兜。
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAdminStore } from '../stores/admin';
import {
  buildUploadSettingsPayload,
  draftRangeHint,
  formatBytes,
  formatDraftBytes,
  type UploadSettings,
} from '../lib/uploadSettings';

const { t } = useI18n();
const admin = useAdminStore();

const settings = computed<UploadSettings | null>(() => admin.uploadSettings);
const loaded = computed(() => admin.uploadSettingsLoaded);
const loading = computed(() => admin.uploadSettingsLoading);
const loadError = computed(() => admin.uploadSettingsErr);
const saveError = computed(() => admin.uploadSaveErr);
const fieldError = computed(() => (admin.uploadSaveField === 'maxFileBytes' ? admin.uploadSaveErr : null));

/** 数字框的一手值是字符串（DOM 如此）；换算与校验全在 lib（纯函数，见 `lib/uploadSettings.ts`）。 */
const draft = ref('');

// ── 生效值与来源 ──────────────────────────────────────────────────────────────
const effectiveText = computed(() => formatBytes(settings.value?.maxFileBytes ?? null) ?? t('admin.upload.unknown'));
const effectiveRaw = computed(() => settings.value?.maxFileBytes ?? null);

/** 来源三态各一句话；`null` = 服务端没给/给了不认识的形状 ⇒ 不许编一个来源。 */
const sourceText = computed(() => {
  switch (settings.value?.source) {
    case 'db': return t('admin.upload.sourceDb');
    case 'env': return t('admin.upload.sourceEnv');
    case 'default': return t('admin.upload.sourceDefault');
    default: return t('admin.upload.unknown');
  }
});

/** `source ≠ db` 的原因（为什么现在生效的不是管理台里那个数）。 */
const reasonText = computed(() => {
  switch (settings.value?.reason) {
    case 'no_row': return t('admin.upload.reasonNoRow');
    case 'invalid_db_value': return t('admin.upload.reasonInvalid');
    case 'read_failed': return t('admin.upload.reasonReadFailed');
    // `read_timeout` 是新引入的第四种（复 audit 活一：那次读取有超时了）。缺这个 case 会掉进 default ⇒ 整条
    // 原因不显示，运维看到的就是「不知道为啥生效值不是管理台那个数」。
    case 'read_timeout': return t('admin.upload.reasonReadTimeout');
    default: return null;
  }
});

const limitsText = computed(() => {
  const limits = settings.value?.limits;
  if (!limits || limits.minBytes <= 0 || limits.maxBytes <= 0) return null;
  return t('admin.upload.limits', {
    min: formatBytes(limits.minBytes) ?? limits.minBytes,
    max: formatBytes(limits.maxBytes) ?? limits.maxBytes,
  });
});

const updatedAtText = computed(() => {
  const raw = settings.value?.updatedAt ?? null;
  if (raw === null) return t('admin.upload.updatedAtNever');
  const at = new Date(raw);
  return Number.isNaN(at.getTime())
    ? t('admin.upload.updatedAtUnknown', { value: raw })
    : at.toLocaleString();
});

// ── 输入的即时反馈（换算 + 越界**提前提示**，都不拦截）────────────────────────
const draftReadable = computed(() => formatDraftBytes(draft.value));
const rangeHint = computed(() => {
  const hint = draftRangeHint(draft.value, settings.value);
  if (hint === null) return null;
  const limits = settings.value?.limits;
  return t(hint === 'below' ? 'admin.upload.hintBelow' : 'admin.upload.hintAbove', {
    min: formatBytes(limits?.minBytes ?? null) ?? '?',
    max: formatBytes(limits?.maxBytes ?? null) ?? '?',
  });
});

/** 未加载完成 / 正在保存 / 草稿解析不出整数 ⇒ 禁保存（不发一个必然 400 的体）。 */
const saveDisabled = computed(() => admin.uploadSaving || !loaded.value || buildUploadSettingsPayload(draft.value) === null);

function fillFrom(next: UploadSettings | null) {
  // 回填的是**生效值**：管理员多数场景是"在现有值上微调"，而"未知"填进输入框会变成 0 那种更坏的形态。
  const value = next?.maxFileBytes;
  draft.value = value === null || value === undefined ? '' : String(value);
}

/** 重读一遍：生效值会被另一个管理员改，本页不缓存。 */
async function onReload() {
  await admin.loadUploadSettings();
  fillFrom(admin.uploadSettings);
}

onMounted(async () => {
  await admin.loadUploadSettings();
  fillFrom(admin.uploadSettings);
});

async function onSave() {
  const payload = buildUploadSettingsPayload(draft.value);
  if (payload === null || admin.uploadSaving) return;
  const err = await admin.saveUploadSettings(payload);
  // 成功：用服务端回读的值回填（不是把输入原样留着），于是"保存成功"与"生效值"永远是同一个数。
  if (err === null) fillFrom(admin.uploadSettings);
}
</script>

<template>
  <section class="grid gap-3 p-3">
    <header>
      <h2 class="text-lg font-medium">{{ t('admin.upload.title') }}</h2>
      <p class="text-xs text-black/55">{{ t('admin.upload.intro') }}</p>
    </header>

    <p v-if="loading" data-test="upload-loading" class="text-sm text-black/50">{{ t('admin.upload.loading') }}</p>
    <p v-if="loadError" data-test="upload-load-error" class="syserr text-sm" role="alert">{{ loadError }}</p>
    <p v-if="!loaded && !loading && !loadError" data-test="upload-not-loaded" class="text-xs text-black/50">
      {{ t('admin.upload.notLoaded') }}
    </p>

    <!-- ① 当前生效值 + 来源：这一页的全部价值就在这一格 -->
    <dl v-if="settings" data-test="upload-effective" class="grid gap-1 rounded-md border border-black/10 bg-black/[0.02] p-2 text-sm">
      <div class="flex items-baseline gap-2">
        <dt class="text-xs text-black/55">{{ t('admin.upload.statusEffective') }}</dt>
        <dd class="font-medium">
          <span data-test="upload-effective-value">{{ effectiveText }}</span>
          <span v-if="effectiveRaw !== null" class="text-xs text-black/40">({{ effectiveRaw }} B)</span>
        </dd>
      </div>
      <div class="flex items-baseline gap-2">
        <dt class="text-xs text-black/55">{{ t('admin.upload.statusSource') }}</dt>
        <dd data-test="upload-effective-source">{{ sourceText }}</dd>
      </div>
      <p v-if="reasonText" data-test="upload-reason" class="text-xs text-amber-700">{{ reasonText }}</p>
      <div class="flex items-baseline gap-2">
        <dt class="text-xs text-black/55">{{ t('admin.upload.statusUpdatedAt') }}</dt>
        <dd class="text-xs">{{ updatedAtText }}</dd>
      </div>
      <p v-if="limitsText" data-test="upload-limits" class="text-xs text-black/50">{{ limitsText }}</p>
    </dl>

    <!-- ② 改这个数 -->
    <div class="grid gap-1 sm:max-w-sm">
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.upload.field') }}
        <input
          v-model="draft"
          data-test="upload-input"
          type="number"
          inputmode="numeric"
          step="1"
          :min="settings?.limits?.minBytes ?? undefined"
          :max="settings?.limits?.maxBytes ?? undefined"
          :aria-invalid="fieldError ? 'true' : undefined"
          :class="fieldError ? 'border-red-600' : 'border-black/20'"
          class="rounded-md border px-2 py-1 text-sm"
        >
      </label>
      <p data-test="upload-draft-readable" class="text-xs text-black/50">
        {{ draftReadable ? t('admin.upload.draftIs', { value: draftReadable }) : t('admin.upload.draftNotInteger') }}
      </p>
      <p v-if="rangeHint" data-test="upload-range-hint" class="text-xs text-amber-700">{{ rangeHint }}</p>
      <p v-if="fieldError" data-test="field-error-maxFileBytes" class="syserr text-xs" role="alert">{{ fieldError }}</p>
      <p v-else-if="saveError" data-test="upload-save-error" class="syserr text-xs" role="alert">{{ saveError }}</p>
      <p v-if="admin.uploadSaveOk" data-test="upload-save-ok" class="text-xs text-emerald-700">
        {{ t('admin.upload.saved') }}
      </p>
      <p class="text-xs text-black/50">{{ t('admin.upload.fieldHint') }}</p>

      <div class="mt-1 flex items-center gap-2">
        <button
          data-test="upload-save"
          type="button"
          class="rounded-md bg-brand px-3 py-1 text-sm text-white disabled:opacity-50"
          :disabled="saveDisabled"
          @click="onSave"
        >
          {{ t('admin.upload.save') }}
        </button>
        <button
          data-test="upload-reload"
          type="button"
          class="rounded-md border border-black/20 px-3 py-1 text-sm disabled:opacity-50"
          :disabled="loading"
          @click="onReload"
        >
          {{ t('admin.upload.reload') }}
        </button>
      </div>
    </div>

    <!-- ③ 三个来源一起摆出来：排查时不用猜"现在到底哪一边在说话" -->
    <dl v-if="settings" data-test="upload-sources" class="grid gap-1 text-xs text-black/60 sm:max-w-lg">
      <div class="flex gap-2">
        <dt class="w-40 shrink-0">{{ t('admin.upload.srcDb') }}</dt>
        <dd>{{ formatBytes(settings.dbMaxFileBytes) ?? t('admin.upload.unknown') }}</dd>
      </div>
      <div class="flex gap-2">
        <dt class="w-40 shrink-0">{{ t('admin.upload.srcEnv') }}</dt>
        <dd>
          {{ formatBytes(settings.envMaxFileBytes) ?? t('admin.upload.unknown') }}
          <span v-if="!settings.envIsExplicit" class="text-black/40">({{ t('admin.upload.envNotSet') }})</span>
        </dd>
      </div>
      <div class="flex gap-2">
        <dt class="w-40 shrink-0">{{ t('admin.upload.srcDefault') }}</dt>
        <dd>{{ formatBytes(settings.defaultMaxFileBytes) ?? t('admin.upload.unknown') }}</dd>
      </div>
    </dl>

    <p class="max-w-prose text-xs text-black/45">{{ t('admin.upload.footnote') }}</p>
  </section>
</template>
