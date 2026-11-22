<script setup lang="ts">
// 管理台 · 运行时设置（issue #677 P2b，契约 `docs/api/portal.md` §4.21）。
//
// 这一页存在的理由只有一条：**改一个数字不该要重建容器**。而它比 §4.15 上传上限多出来的东西是
// 「一列表」——P3 会往 registry 里一格一格加旋钮，所以这里按列表渲染，硬编码单个旋钮的页面
// 下个月就得重写。判据也因此不是"能不能填"，而是：
//   ① 每行把**生效值 + 来源 + 生效方式**一起显示：只显示一个数字，运维不知道「我改的这个数听不听」。
//      `source`（db/env/default）与 `applyMode`（hot/restart）都是服务端**声明**的事实，本页照抄，
//      不自己猜（lib 的归一化把不认识的取值各归 `default` / `restart`，安全侧）。
//   ② 保存后**用响应 DTO 回填那一行**（它出自 `RETURNING`），于是页面显示的永远是"库里现在的值"，
//      不是"我以为写进去的值"。
//   ③ 前端**不抢服务端的闸**：解析得出整数就照发（哪怕越界），由 `400 validation_failed` +
//      `details.field` 回来标红；解析不出整数才不发请求。所以这里**没有** min/max 之类的区间校验。
//   ④ `value` 是 `null`（服务端没给/给了不认识的形状）⇒ 显示「未知」，**不是 0**（#390-A 纪律）。
//   ⑤ 一行的错误只标那一行：`details.field='value'` 落在被按下的那一行的输入框上，别跟着抖。
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAdminStore } from '../stores/admin';
import {
  buildRuntimeSettingPayload,
  draftOf,
  formatRuntimeValue,
  type RuntimeSettingApplyMode,
  type RuntimeSettingItem,
  type RuntimeSettingSource,
} from '../lib/runtimeSettings';

const { t } = useI18n();
const admin = useAdminStore();

const items = computed<RuntimeSettingItem[]>(() => admin.runtimeSettings);
const loaded = computed(() => admin.runtimeSettingsLoaded);
const loading = computed(() => admin.runtimeSettingsLoading);
const loadError = computed(() => admin.runtimeSettingsErr);

/**
 * 数字框的一手值：`v-model` 在 `<input type="number">` 上会**把值 cast 成 number**（Vue 对
 * number 输入的内置行为），于是 `drafts[key]` 不保证是字符串。一律过 `draftText` 再交给 lib
 * （lib 的解析只收字符串，直传一个 number 就是当场 `draft.trim is not a function`）。
 */
const drafts = reactive<Record<string, string | number>>({});

function draftText(key: string): string {
  const raw = drafts[key];
  return raw === null || raw === undefined ? '' : String(raw);
}

/**
 * 最近一次**由本页按下**的保存是哪一行。
 *
 * ⚠ 为什么需要它而 `admin.runtimeSaving` 不够：`runtimeSaving` 是"正在写"的瞬时态，请求一结束就归
 * `null`，而 400 的错误恰恰是在那之后才要显示的。没有这个指针，一次失败保存的红就会糊到每一行上
 * （`runtimeSaveField` 只说"错在值里"，不说错在哪一行）。
 */
const attemptKey = ref<string | null>(null);

// ── 展示：值 / 来源 / 生效方式 / 更新时间（四件事必须一起说，缺一件这页就没价值）──────
function valueText(item: RuntimeSettingItem): string {
  return formatRuntimeValue(item.value) ?? t('admin.runtime.unknown');
}

/** 来源三档各一句人话；默认分支给「未知」——lib 已把不认识的归 `default`，这里只兜类型。 */
function sourceText(source: RuntimeSettingSource): string {
  switch (source) {
    case 'db': return t('admin.runtime.sourceDb');
    case 'env': return t('admin.runtime.sourceEnv');
    case 'default': return t('admin.runtime.sourceDefault');
    default: return t('admin.runtime.unknown');
  }
}

/** 生效方式两档。`restart` 是安全侧：宁可多提醒一次重启，不许让人以为已经生效。 */
function applyText(mode: RuntimeSettingApplyMode): string {
  return mode === 'hot' ? t('admin.runtime.applyHot') : t('admin.runtime.applyRestart');
}

/**
 * 更新时间**原样显示 ISO 串**：这一列是运维拿去和审计对账的，本仓没有第二处做这种对账；
 * `toLocaleString()` 会按浏览器时区重排它，于是"页面上的时间"与"审计里的时间"看起来不一样。
 * `null` = 这一档不是管理台存的（env / 默认值）⇒ 说「从未」，不显示一个空串或假时间。
 */
function updatedAtText(item: RuntimeSettingItem): string {
  return item.updatedAt ?? t('admin.runtime.never');
}

// ── 每行的错误 / 成功态 ─────────────────────────────────────────────────────────
/** 这一行有没有错误：只有**被按下的那一行**才有（别的行什么都没做过）。 */
function rowError(item: RuntimeSettingItem): string | null {
  if (attemptKey.value !== item.key) return null;
  return admin.runtimeSaveErr;
}

/** 输入框标红的条件：错误确实指向"值"这一档（`key`/`body` 不是这一行的框错了）。 */
function rowInvalid(item: RuntimeSettingItem): boolean {
  return rowError(item) !== null && admin.runtimeSaveField === 'value';
}

/**
 * `key` / `body` 级的错误：它不是某个输入框的错，但也不该静默 ⇒ 单独一行点名服务端指的是哪一处。
 * `value` 级由那一行的红框 + 文案承担，这里不再重复一遍。
 */
const pageFieldError = computed<string | null>(() => {
  const err = admin.runtimeSaveErr;
  if (err === null || attemptKey.value === null) return null;
  if (admin.runtimeSaveField === 'value' || admin.runtimeSaveField === null) return null;
  const field = admin.runtimeSaveField === 'key'
    ? t('admin.runtime.fieldKey')
    : t('admin.runtime.fieldBody');
  return `${err}${t('admin.runtime.fieldPointed', { field })}`;
});

/** 保存按钮的禁用条件：没加载完 / 有别的旋钮在写 / 这一格草稿解析不出整数。 */
function saveDisabled(item: RuntimeSettingItem): boolean {
  if (admin.runtimeSaving !== null || !loaded.value) return true;
  return buildRuntimeSettingPayload(draftText(item.key)) === null;
}

// ── 数据流 ─────────────────────────────────────────────────────────────────────
/** 回填输入框：显示的是**服务端回读的值**（`draftOf` 把「未知」与布尔折成空串，不预填假数）。 */
function fillFrom(list: RuntimeSettingItem[]): void {
  for (const item of list) drafts[item.key] = draftOf(item);
}

async function onReload(): Promise<void> {
  await admin.loadRuntimeSettings();
  fillFrom(admin.runtimeSettings);
}

async function onSave(item: RuntimeSettingItem): Promise<void> {
  if (saveDisabled(item)) return;
  attemptKey.value = item.key;
  const err = await admin.saveRuntimeSetting(item.key, draftText(item.key));
  // 成功：只回填**那一行**（别的行可能正被用户改到一半，不许被一次不相关的保存冲掉）。
  if (err === null) {
    const saved = admin.runtimeSettings.find((row) => row.key === item.key);
    if (saved) drafts[saved.key] = draftOf(saved);
  }
}

onMounted(async () => {
  await admin.loadRuntimeSettings();
  fillFrom(admin.runtimeSettings);
});
</script>

<template>
  <section data-test="admin-runtime" class="grid gap-3 p-3">
    <header>
      <h2 class="text-lg font-medium">{{ t('admin.runtime.title') }}</h2>
      <p class="max-w-prose text-xs text-black/55">{{ t('admin.runtime.intro') }}</p>
    </header>

    <div class="flex items-center gap-2">
      <button
        data-test="runtime-reload"
        type="button"
        class="rounded-md border border-black/20 px-3 py-1 text-sm
          hover:bg-black/5 disabled:opacity-50"
        :disabled="loading"
        @click="onReload"
      >{{ t('admin.runtime.reload') }}</button>
      <p v-if="loading" data-test="runtime-loading" class="text-sm text-black/50" role="status">
        {{ t('admin.runtime.loading') }}
      </p>
    </div>

    <!-- 三态各一个 data-test：加载中 / 加载失败 / 未加载（没请求）互不冒充 -->
    <p v-if="loadError" class="text-xs text-black/55">{{ t('admin.runtime.loadError') }}</p>
    <p v-if="loadError" data-test="runtime-load-error" class="syserr text-sm" role="alert">
      {{ loadError }}
    </p>
    <p
      v-if="!loaded && !loading && !loadError"
      data-test="runtime-not-loaded"
      class="text-xs text-black/50"
    >
      {{ t('admin.runtime.notLoaded') }}
    </p>

    <table class="w-full text-left text-sm">
      <thead class="text-xs text-black/55">
        <tr>
          <th class="py-1 pr-2">{{ t('admin.runtime.colKey') }}</th>
          <th class="py-1 pr-2">{{ t('admin.runtime.colValue') }}</th>
          <th class="py-1 pr-2">{{ t('admin.runtime.colSource') }}</th>
          <th class="py-1 pr-2">{{ t('admin.runtime.colApplyMode') }}</th>
          <th class="py-1 pr-2">{{ t('admin.runtime.colUpdatedAt') }}</th>
          <th class="py-1">{{ t('admin.runtime.colChange') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="item in items"
          :key="item.key"
          :data-test="`runtime-row-${item.key}`"
          class="border-t border-black/10 align-top"
        >
          <td class="py-1 pr-2">
            <span :data-test="`runtime-label-${item.key}`" class="text-sm">{{ item.label }}</span>
            <code
              :data-test="`runtime-key-${item.key}`"
              class="mt-0.5 block text-[11px] text-black/45"
            >{{ item.key }}</code>
          </td>
          <td class="py-1 pr-2">
            <span
              :data-test="`runtime-value-${item.key}`"
              class="font-medium"
            >{{ valueText(item) }}</span>
          </td>
          <td class="py-1 pr-2">
            <span
              :data-test="`runtime-source-${item.key}`"
              class="rounded-full border border-black/15 px-2 py-0.5 text-xs"
              :class="item.source === 'db' ? 'bg-black/[0.04]' : 'text-amber-800'"
            >{{ sourceText(item.source) }}</span>
          </td>
          <td class="py-1 pr-2">
            <span
              :data-test="`runtime-apply-${item.key}`"
              class="rounded-full border border-black/15 px-2 py-0.5 text-xs"
              :class="item.applyMode === 'hot' ? 'text-emerald-800' : 'text-black/60'"
            >{{ applyText(item.applyMode) }}</span>
          </td>
          <td class="py-1 pr-2">
            <code :data-test="`runtime-updated-${item.key}`" class="text-[11px] text-black/60">
              {{ updatedAtText(item) }}
            </code>
          </td>
          <td class="py-1">
            <div class="flex flex-wrap items-center gap-2">
              <input
                v-model="drafts[item.key]"
                :data-test="`runtime-input-${item.key}`"
                :aria-label="t('admin.runtime.fieldValue')"
                type="number"
                inputmode="numeric"
                step="1"
                :aria-invalid="rowInvalid(item) ? 'true' : undefined"
                :class="rowInvalid(item) ? 'border-red-600' : 'border-black/20'"
                class="w-32 rounded-md border px-2 py-1 text-sm"
              >
              <button
                :data-test="`runtime-save-${item.key}`"
                type="button"
                class="rounded-md bg-brand px-3 py-1 text-sm text-white disabled:opacity-50"
                :disabled="saveDisabled(item)"
                @click="onSave(item)"
              >{{ t('admin.runtime.save') }}</button>
              <span
                v-if="admin.runtimeSaving === item.key"
                :data-test="`runtime-saving-${item.key}`"
                class="text-xs text-black/50"
              >{{ t('admin.runtime.saving') }}</span>
              <!-- 生效时机跟着 applyMode 说：对 hot 说「已保存」就够了，对 restart 那句不够 -->
              <span
                v-if="admin.runtimeSavedKey === item.key"
                :data-test="`runtime-saved-${item.key}`"
                class="text-xs text-emerald-700"
              >{{ t('admin.runtime.saved', { apply: applyText(item.applyMode) }) }}</span>
            </div>
            <p
              v-if="rowError(item)"
              :data-test="`runtime-error-${item.key}`"
              class="syserr mt-1 text-xs"
              role="alert"
            >{{ rowError(item) }}</p>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 空态：服务端 200 但 items 为空（registry 里没有可显示的项）——与「加载失败」是两句话 -->
    <p
      v-if="loaded && !loading && !loadError && items.length === 0"
      data-test="runtime-empty"
      class="text-sm text-black/50"
    >{{ t('admin.runtime.empty') }}</p>

    <p v-if="pageFieldError" data-test="runtime-field-error" class="syserr text-xs" role="alert">
      {{ pageFieldError }}
    </p>

    <p class="max-w-prose text-xs text-black/45">{{ t('admin.runtime.footnote') }}</p>
  </section>
</template>
