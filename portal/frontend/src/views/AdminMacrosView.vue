<script setup lang="ts">
// 管理台 · 宏模板配置（issue #529，事件平台 W6；契约 `10` 篇 §3.2 / `07` §1.3、§2.3）。
//
// 三条硬口径：
//   ① 列表带**订阅数**列（不是装饰：停用前要知道影响谁）。⚠ 后端 `toTemplateSnapshot` 目前
//      不下发订阅数列（见交付报告的「偏离」），前端拿不到就显示 `—`，**不拿 0 冒充「没人订」**。
//   ② 新建**先选 kind 再填表**；kind 建完**不可改**（后端 PATCH 白名单只允许
//      `{name?, params?, audience?, enabled?}`，body 里出现 kind/scope 直接 400）。
//   ③ 删除是**一个按钮 + 两句话**：平台按数据自己判硬删/软删，前端不猜——
//      DELETE 返回 `{mode}`，`deleted` / `deleted_with_assignments` / `soft` 各一句人话。
//
// 字段表从 `@shared/macro-kinds` 的 `KIND_SCHEMA` 取；判据与工具面写死显示在「以下由代码固定」区。
// 枚举一律从 shared 迭代，绝不在此抄字面量（单源自检 `portal/test/macro-kinds-single-source.test.js`）。
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import { KINDS, KIND_SCHEMA, KIND_SCOPE } from '@shared/macro-kinds';
import { kindMessageKey } from '../lib/macroView';

/** `KIND_SCHEMA` 的松散视图（shared 是 JS，无类型；这里只声明渲染要的字段）。 */
interface FieldSpec {
  type: string;
  values?: unknown[];
  min?: number;
  max?: number;
  /** 契约 §1 的默认值（#625）：表单初值**只从这里取**，与后端 `validateKindParams` 补的是同一份。 */
  default?: unknown;
  /** 契约 §1 的必填标记（#625）：缺了后端 400，前端只用来标「必填」。 */
  required?: boolean;
}
const SCHEMA = KIND_SCHEMA as unknown as Record<string, Record<string, FieldSpec>>;
const SCOPE = KIND_SCOPE as unknown as Record<string, string>;

interface AdminTemplate {
  id: string;
  kind: string;
  name: string;
  params: Record<string, unknown>;
  audience: string;
  scope: string;
  enabled: boolean;
  deleted_at?: string | null;
  /** 后端将来补订阅数列时，前端自动显示（当前不下发 ⇒ 显示 `—`）。 */
  subscriberCount?: number;
}
interface DeleteResult {
  mode: 'deleted' | 'deleted_with_assignments' | 'soft';
  assignmentsRemoved?: number;
  notifications?: number;
  macroRuns?: number;
}

const { t } = useI18n();

const rows = ref<AdminTemplate[]>([]);
const includeDeleted = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);
const resultText = ref<string | null>(null);

// ── 列表 ──────────────────────────────────────────────────────────────────────
async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await api<{ items: AdminTemplate[] }>(
      `/api/admin/macro-templates${includeDeleted.value ? '?includeDeleted=true' : ''}`,
    );
    rows.value = res.items;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function toggleIncludeDeleted(): void {
  includeDeleted.value = !includeDeleted.value;
  void load();
}

function statusLabel(row: AdminTemplate): string {
  if (row.deleted_at != null) return t('admin.macros.deletedLabel');
  return row.enabled ? t('admin.enabled') : t('admin.disabled');
}
function audienceLabel(row: AdminTemplate): string {
  return row.audience === 'admin' ? t('admin.macros.audienceAdmin') : t('admin.macros.audienceAll');
}
function nameLabel(row: AdminTemplate): string {
  return row.deleted_at != null ? `${row.name}${t('admin.macros.deletedSuffix')}` : row.name;
}
/** 订阅数：后端没下发就显示 `—`（绝不用 0 冒充「没人订」）。 */
function subscriberLabel(row: AdminTemplate): string {
  return typeof row.subscriberCount === 'number' ? String(row.subscriberCount) : t('admin.macros.subscriberUnknown');
}

// ── 新建 ──────────────────────────────────────────────────────────────────────
const formOpen = ref(false);
const form = reactive<{ kind: string; name: string; audience: string; params: Record<string, unknown> }>({
  kind: '', name: '', audience: 'all', params: {},
});
const createdTpl = ref<AdminTemplate | null>(null);
const createError = ref<string | null>(null);

const schemaEntries = computed<Array<[string, FieldSpec]>>(() =>
  form.kind && SCHEMA[form.kind] ? Object.entries(SCHEMA[form.kind]) : [],
);
const fixedScopeLabel = computed(() => {
  const scope = form.kind ? SCOPE[form.kind] : null;
  return scope === 'user' ? t('admin.macros.scopeUser') : t('admin.macros.scopeSession');
});

/**
 * 表单初值：**只取 schema 的 `default`**（issue #625）。
 *
 * 以前这里是一套「通用兜底规则」（enum 取首值、enum[] 取 `[]`、int 取 `min`），
 * 它把「没写默认值」当成「默认就是空/下界」，于是：
 *   - `run-notify` 建出来 `states: []` ⇒ **永远不会通知**，界面却显示 Enabled；
 *   - `maxRounds` 变成 1（契约是 16）、`max_rounds` 同理。
 * 现在后端 `validateKindParams` 会按契约补默认值，两边必须同源：
 *   **schema 没写 `default` 的字段就不预填**（控件自然为空，要么用户填、要么按可选省略），
 *   绝不在这层再造一套规则。
 */
function initialParams(entries: Array<[string, FieldSpec]>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, spec] of entries) {
    if (!('default' in spec)) continue; // 无默认 ⇒ 不预填（而不是猜一个）
    const d = spec.default;
    // 数组要拷一份：否则 `toggleArrayValue` 会直接改到共享的 `KIND_SCHEMA` 常量上。
    next[key] = Array.isArray(d) ? [...d] : d;
  }
  return next;
}

function openCreate(): void {
  formOpen.value = true;
  createdTpl.value = null;
  createError.value = null;
}
function closeCreate(): void {
  formOpen.value = false;
}

/** 换 kind：按新 kind 的 schema 重建 params（切 kind 时不残留别的 kind 的字段）。 */
function onKindChange(): void {
  form.params = initialParams(schemaEntries.value);
}

function toggleArrayValue(key: string, value: unknown): void {
  const cur = Array.isArray(form.params[key]) ? (form.params[key] as unknown[]) : [];
  form.params[key] = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
}
function isArrayChecked(key: string, value: unknown): boolean {
  const cur = form.params[key];
  return Array.isArray(cur) && cur.includes(value);
}

async function submitCreate(): Promise<void> {
  createError.value = null;
  try {
    const res = await api<{ template: AdminTemplate }>('/api/admin/macro-templates', {
      method: 'POST',
      // scope 由 kind 决定（后端也这么校验），前端照 `KIND_SCOPE` 送，绝不让用户手填。
      body: JSON.stringify({
        kind: form.kind, name: form.name, params: form.params,
        audience: form.audience, scope: form.kind ? SCOPE[form.kind] : undefined, enabled: true,
      }),
    });
    createdTpl.value = res.template;
    rows.value = [res.template, ...rows.value];
  } catch (e) {
    createError.value = e instanceof Error ? e.message : String(e);
  }
}

// ── 动作：启停 / 删除 ──────────────────────────────────────────────────────────
async function patchEnabled(row: AdminTemplate, enabled: boolean): Promise<void> {
  error.value = null;
  try {
    const res = await api<{ template: AdminTemplate }>(
      `/api/admin/macro-templates/${encodeURIComponent(row.id)}`,
      { method: 'PATCH', body: JSON.stringify({ enabled }) },
    );
    const idx = rows.value.findIndex((x) => x.id === row.id);
    if (idx >= 0) rows.value[idx] = res.template;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function remove(row: AdminTemplate): Promise<void> {
  error.value = null;
  resultText.value = null;
  try {
    const res = await api<DeleteResult>(
      `/api/admin/macro-templates/${encodeURIComponent(row.id)}`,
      { method: 'DELETE' },
    );
    resultText.value = deleteResultText(res);
    if (res.mode === 'soft') {
      await load(); // 软删：行仍在（带 deleted_at），重取以刷新标记
    } else {
      rows.value = rows.value.filter((x) => x.id !== row.id);
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function deleteResultText(res: DeleteResult): string {
  if (res.mode === 'deleted_with_assignments') {
    return t('admin.macros.resultDeletedWithAssignments', { count: res.assignmentsRemoved ?? 0 });
  }
  if (res.mode === 'soft') {
    return t('admin.macros.resultSoft', { runs: res.macroRuns ?? 0, notifications: res.notifications ?? 0 });
  }
  return t('admin.macros.resultDeleted');
}

// 用户视角预览 + 一次触发成本估算（usage 后端目前恒 null ⇒ 成本「暂无法估算」）。
const createdPreview = computed(() => {
  const tpl = createdTpl.value;
  if (!tpl) return '';
  const vis = tpl.audience === 'admin' ? t('admin.macros.audienceAdmin') : t('admin.macros.audienceAll');
  return `${tpl.name} · ${t(kindMessageKey(tpl.kind))} · ${vis}`;
});

onMounted(() => { void load(); });
</script>

<template>
  <section data-test="admin-macros" class="grid gap-3">
    <header>
      <h2 class="text-lg font-medium">{{ t('admin.macros.title') }}</h2>
      <p class="mt-1 text-xs text-black/60">{{ t('admin.macros.intro') }}</p>
    </header>

    <div class="flex items-center gap-3">
      <button
        type="button"
        data-test="macros-create-open"
        class="rounded border border-black/15 px-2 py-1 text-xs hover:bg-black/5"
        @click="openCreate"
      >{{ t('admin.macros.createTitle') }}</button>
      <label class="flex items-center gap-1 text-xs text-black/55">
        <input data-test="macros-include-deleted" type="checkbox" :checked="includeDeleted" @change="toggleIncludeDeleted">
        {{ t('admin.macros.includeDeleted') }}
      </label>
    </div>

    <p v-if="loading" data-test="macros-loading" class="text-sm text-black/60" role="status">{{ t('admin.macros.loading') }}</p>
    <p v-if="error" data-test="macros-error" class="syserr text-sm" role="alert">{{ error }}</p>
    <p v-if="resultText" data-test="macros-result" class="text-sm text-emerald-700" role="status">{{ resultText }}</p>

    <!-- 新建表单：先选 kind 再填表 -->
    <form
      v-if="formOpen"
      data-test="macros-create-form"
      class="grid gap-3 rounded-lg border border-black/10 p-3"
      @submit.prevent="submitCreate"
    >
      <p class="text-xs text-black/60">{{ t('admin.macros.pickKindFirst') }}</p>

      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.macros.colKind') }}
        <select
          v-model="form.kind"
          data-test="create-kind"
          class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
          @change="onKindChange"
        >
          <option value="" disabled>—</option>
          <option v-for="k in KINDS" :key="k" :value="k">{{ t(kindMessageKey(k)) }}</option>
        </select>
      </label>
      <p data-test="create-kind-locked" class="text-xs text-amber-700">{{ t('admin.macros.kindLocked') }}</p>

      <template v-if="form.kind">
        <label class="flex flex-col gap-1 text-xs text-black/55">
          {{ t('admin.macros.name') }}
          <input v-model="form.name" data-test="create-name" type="text" maxlength="40"
            class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm">
        </label>

        <label class="flex flex-col gap-1 text-xs text-black/55">
          {{ t('admin.macros.audience') }}
          <select v-model="form.audience" data-test="create-audience"
            class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm">
            <option value="all">{{ t('admin.macros.audienceAll') }}</option>
            <option value="admin">{{ t('admin.macros.audienceAdmin') }}</option>
          </select>
        </label>

        <fieldset class="grid gap-2 border-t border-black/10 pt-2">
          <legend class="text-xs font-medium">{{ t('admin.macros.paramsTitle') }}</legend>
          <div v-for="[key, spec] in schemaEntries" :key="key" class="flex flex-col gap-1 text-xs text-black/55">
            <span data-test="param-label">{{ key }} · {{ spec.type }}</span>

            <select
              v-if="spec.type === 'enum'"
              :value="form.params[key] as string"
              :data-test="'param-' + key"
              class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
              @change="form.params[key] = ($event.target as HTMLSelectElement).value"
            >
              <option v-for="val in spec.values" :key="String(val)" :value="String(val)">{{ String(val) }}</option>
            </select>

            <div v-else-if="spec.type === 'enum[]'" class="flex flex-wrap gap-2">
              <label v-for="val in spec.values" :key="String(val)" class="flex items-center gap-1">
                <input
                  type="checkbox"
                  :data-test="'param-array-' + key + '-' + String(val)"
                  :checked="isArrayChecked(key, val)"
                  @change="toggleArrayValue(key, val)"
                >
                <span>{{ String(val) }}</span>
              </label>
            </div>

            <input
              v-else-if="spec.type === 'int'"
              :value="form.params[key] as number"
              :data-test="'param-' + key"
              type="number"
              :min="spec.min"
              :max="spec.max"
              class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
              @change="form.params[key] = Number(($event.target as HTMLInputElement).value)"
            >

            <input
              v-else
              :value="form.params[key] as string"
              :data-test="'param-' + key"
              type="text"
              class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
              @change="form.params[key] = ($event.target as HTMLInputElement).value"
            >
          </div>
        </fieldset>

        <!-- 「以下由代码固定」区：判据与工具面写死 -->
        <div data-test="create-fixed" class="rounded bg-black/5 p-2 text-xs text-black/60">
          <p class="font-medium">{{ t('admin.macros.fixedByCode') }}</p>
          <p>{{ t('admin.macros.fixedHint') }}</p>
          <p data-test="create-fixed-scope">{{ t('admin.macros.fixedScope', { scope: fixedScopeLabel }) }}</p>
        </div>
      </template>

      <p v-if="createError" data-test="create-error" class="syserr text-xs" role="alert">{{ createError }}</p>

      <div class="flex gap-2">
        <button type="submit" data-test="create-submit" :disabled="!form.kind || !form.name"
          class="rounded bg-brand px-3 py-1 text-sm text-white disabled:opacity-50">
          {{ t('admin.macros.submitCreate') }}
        </button>
        <button type="button" data-test="create-cancel" class="rounded border border-black/15 px-3 py-1 text-sm"
          @click="closeCreate">{{ t('admin.macros.cancel') }}</button>
      </div>

      <!-- 创建后：用户视角预览 + 一次触发成本估算 -->
      <div v-if="createdTpl" data-test="created-preview" class="rounded border border-emerald-300 bg-emerald-50 p-2 text-xs">
        <p class="font-medium">{{ t('admin.macros.createdTitle') }}</p>
        <p data-test="created-preview-text">{{ t('admin.macros.userPreview') }} {{ createdPreview }}</p>
        <p data-test="created-cost">{{ t('admin.macros.triggerCostUnknown') }}</p>
      </div>
    </form>

    <!-- 列表 -->
    <table v-if="rows.length" data-test="macros-table" class="w-full border-collapse text-left text-sm">
      <thead>
        <tr class="text-xs text-black/55">
          <th class="py-1 pr-2">{{ t('admin.macros.colName') }}</th>
          <th class="py-1 pr-2">{{ t('admin.macros.colKind') }}</th>
          <th class="py-1 pr-2">{{ t('admin.macros.colVisible') }}</th>
          <th class="py-1 pr-2">{{ t('admin.macros.colStatus') }}</th>
          <th class="py-1 pr-2">{{ t('admin.macros.colSubscribers') }}</th>
          <th class="py-1 pr-2">{{ t('admin.macros.colActions') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id" data-test="macro-row" :data-template-id="row.id">
          <td class="py-1 pr-2" data-test="row-name">{{ nameLabel(row) }}</td>
          <td class="py-1 pr-2">{{ t(kindMessageKey(row.kind)) }}</td>
          <td class="py-1 pr-2" data-test="row-visible">{{ audienceLabel(row) }}</td>
          <td class="py-1 pr-2" data-test="row-status">{{ statusLabel(row) }}</td>
          <td class="py-1 pr-2 font-mono" data-test="row-subs">{{ subscriberLabel(row) }}</td>
          <td class="py-1 pr-2">
            <div class="flex items-center gap-2">
              <button
                v-if="row.deleted_at == null"
                type="button"
                :data-test="'toggle-' + row.id"
                class="rounded border border-black/15 px-2 py-0.5 text-xs hover:bg-black/5"
                @click="patchEnabled(row, !row.enabled)"
              >{{ row.enabled ? t('admin.macros.disable') : t('admin.macros.enable') }}</button>
              <!-- 删除：一个按钮 + 两句话（硬删/软删由平台判） -->
              <button
                type="button"
                :data-test="'delete-' + row.id"
                class="rounded border border-red-300 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50"
                :title="t('admin.macros.deleteConfirm')"
                @click="remove(row)"
              >{{ t('admin.macros.del') }}</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <p v-if="!loading && rows.length === 0 && !error" data-test="macros-empty" class="text-sm text-black/60">
      {{ t('admin.macros.empty') }}
    </p>

    <!-- 删除规则说明（两句话，常驻在列表下方） -->
    <p data-test="macros-delete-hint" class="text-xs text-black/55">{{ t('admin.macros.deleteHint') }}</p>
  </section>
</template>
