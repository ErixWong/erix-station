<script setup lang="ts">
// 管理台 · 宏模板配置（issue #529，事件平台 W6；契约 `10` 篇 §3.2 / `07` §1.3、§2.3）。
//
// 三条硬口径：
//   ① 列表带**订阅数**列（不是装饰：停用/改参数前要知道影响谁）。后端 `adminTemplates` 已下发
//      `subscriberCount`（issue #613，只算启用订阅）；万一没下发就显示 `—`，**不拿 0 冒充「没人订」**。
//   ② 新建**先选 kind 再填表**；kind 建完**不可改**（后端 PATCH 白名单只允许
//      `{name?, params?, audience?, enabled?}`，body 里出现 kind/scope 直接 400）。
//   ③ 删除是**一个按钮 + 两句话**：平台按数据自己判硬删/软删，前端不猜——
//      DELETE 返回 `{mode}`，`deleted` / `deleted_with_assignments` / `soft` 各一句人话。
//
// 新建与编辑表单已抽成子组件 `MacroTemplateForm.vue`（issue #759）：同一套字段控件，靠 `mode`
// 分流「新建预填 schema default」与「编辑预填模板已有值」两种语义——这里只管开/关与列表更新。
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import { kindMessageKey } from '../lib/macroView';
import MacroTemplateForm from '../components/MacroTemplateForm.vue';

interface AdminTemplate {
  id: string;
  kind: string;
  name: string;
  params: Record<string, unknown>;
  audience: string;
  scope: string;
  enabled: boolean;
  deleted_at?: string | null;
  /** 后端下发订阅数（issue #613）；未下发时前端显示 `—` 而不是 0。 */
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

// ── 新建 / 编辑（表单在子组件里；这里只管开/关与列表就地更新）───────────────────
const formOpen = ref(false);
// 正在编辑的行（null = 没有编辑表单）。传给子组件做预填与 PATCH 目标。
const editing = ref<AdminTemplate | null>(null);

function openCreate(): void {
  formOpen.value = true;
}
function closeCreate(): void {
  formOpen.value = false;
}

function openEdit(row: AdminTemplate): void {
  editing.value = row;
}
function closeEdit(): void {
  editing.value = null;
}

/** 新建成功：把新模板插到列表头（子组件已留预览，表单保持打开——与 #529 原行为一致）。 */
function onCreateSaved(template: AdminTemplate): void {
  rows.value = [template, ...rows.value];
}

/**
 * 编辑成功：**就地替换那一行**（test ⑥：不整页重拉）。子组件 emit 的是后端 PATCH 返回的模板，
 * 已带最新 name/params/audience，直接顶替即可，省一次 GET。
 */
function onEditSaved(template: AdminTemplate): void {
  const idx = rows.value.findIndex((x) => x.id === template.id);
  if (idx >= 0) rows.value[idx] = template;
  editing.value = null;
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

    <!-- 新建表单（子组件；先选 kind 再填表，kind 建完不可改） -->
    <MacroTemplateForm
      v-if="formOpen"
      mode="create"
      @saved="onCreateSaved"
      @cancel="closeCreate"
    />

    <!-- 编辑表单（issue #759）：kind/scope 只读，name/audience/params 可改；保存 PATCH（不带 kind/scope） -->
    <MacroTemplateForm
      v-if="editing"
      :key="editing.id"
      mode="edit"
      :template="editing"
      @saved="onEditSaved"
      @cancel="closeEdit"
    />

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
              <!-- 编辑（issue #759）：打开编辑表单改 name/params/audience（kind/scope 只读）。
                   ⚠ 软删行不给入口（审查 #4）：后端 `updateTemplate` 的 WHERE 带 `deleted_at IS NULL`
                   ⇒ 编辑已删模板保存必然 404。启停按钮早就按同一条件藏了，编辑漏了。 -->
              <button
                v-if="row.deleted_at == null"
                type="button"
                :data-test="'edit-' + row.id"
                class="rounded border border-black/15 px-2 py-0.5 text-xs hover:bg-black/5"
                @click="openEdit(row)"
              >{{ t('admin.macros.edit') }}</button>
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
