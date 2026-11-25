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
//   ⑤ 错误**按 `details.field` 归到唯一一处**（§4.21，与 `AdminUploadView` 的 `maxFileBytes` 同口径）：
//      `field='value'` ⇒ 只落在被按下的那一行（那一行的输入框标红 + 那一行下面一句文案）；
//      `field='key'` / `'body'` 以及**认不出 field 的错误** ⇒ 只落在整页那一行。同一句错**只出一次**，
//      不许既挂在那一行又写进整页（#702 review 的 LOW：两处同时渲染 ⇒ 用户看到同一句错两次，
//      而"整页一行"的定位被那一行的红框削弱）。归属由 `rowError()` 一处决定，别处只消费结果。
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
/**
 * 这一行的行内错误 —— **唯一的 field 分派点**。
 *
 * 两个条件缺一不可：
 *   · `details.field === 'value'`：服务端（或本层的"不是整数"）明说错在**值**里 ⇒ 那才是这一行的框；
 *     `key` / `body` / 认不出 field 的错误跟某个输入框无关，一律走整页那一行（`pageFieldError`）。
 *   · 且它必须是**被按下的那一行**：`runtimeSaveField` 只说"错在值里"，不说错在哪一行。
 *
 * ⚠ `rowInvalid()` 与模板里的行文案都只读这个函数的结果 ⇒ 分派口径只有一处，改这里就够。
 */
function rowError(item: RuntimeSettingItem): string | null {
  if (admin.runtimeSaveField !== 'value') return null;
  if (attemptKey.value !== item.key) return null;
  return admin.runtimeSaveErr;
}

/** 输入框标红：与行内文案同一个判据（错误归这一行 ⇒ 框才红）。 */
function rowInvalid(item: RuntimeSettingItem): boolean {
  return rowError(item) !== null;
}

/**
 * 整页那一行的错误：`key` / `body` / **认不出 field** 的保存错误（`value` 级由那一行承担，这里不重复）。
 * 认不出 field 时不拼"错在：xxx"那句 —— 不知道是哪一处就别假装知道，但这句话**不许丢**
 * （`admin.ts` 里 `runtimeSaveField` 的注释早就写了「null ⇒ 退化成整页一条」，之前渲染层没做到）。
 */
const pageFieldError = computed<string | null>(() => {
  const err = admin.runtimeSaveErr;
  if (err === null || attemptKey.value === null) return null;
  if (admin.runtimeSaveField === 'value') return null;
  const field = admin.runtimeSaveField === 'key'
    ? t('admin.runtime.fieldKey')
    : admin.runtimeSaveField === 'body' ? t('admin.runtime.fieldBody') : null;
  return field === null ? err : `${err}${t('admin.runtime.fieldPointed', { field })}`;
});

/** 保存按钮的禁用条件：没加载完 / 有别的旋钮在写 / 这一格发不出 payload。 */
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
            <!-- 服务端登记了 hint 的那一行才有的小字（§4.21：只在那一格带 `hint` 键）。
                 `item.hint` 出自 lib 的归一化：没登记 ⇒ **键不存在**，于是这一整个 `<p>` 不渲染
                 （不是留一个空 `<p>` 撑高度）。文案是服务端给的，本页原样照抄：不翻译、不补写、
                 也不拿它做任何判定（真相在 registry 与 §4.21，这里只是把它说给人看）。 -->
            <p
              v-if="item.hint"
              :data-test="`runtime-hint-${item.key}`"
              class="mt-0.5 block max-w-prose text-[11px] leading-4 text-black/50"
            >{{ item.hint }}</p>
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
