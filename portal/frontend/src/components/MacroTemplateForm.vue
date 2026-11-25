<script setup lang="ts">
// 宏模板表单子组件（issue #759）：新建与编辑**共用同一套字段控件**，靠 `mode` 分流两种语义。
//
// 为什么抽成子组件而不是复制一份表单：判据字段渲染（enum / enum[] / int / 文本）与
// `toggleArrayValue` / `isArrayChecked` 若两处各写一遍迟早漂；单源自检
// （`portal/test/macro-kinds-single-source.test.js`）只管枚举，管不到「两份表单各漏一个类型分支」。
//
// ⚠ `params` 预填分两种，**不能混**：
//   - `mode === 'create'`：取 `KIND_SCHEMA` 的 `default`（`initialParams()`，issue #625 硬口径：
//     schema 没写 default 就不预填，绝不在这层再造一套兜底规则）。
//   - `mode === 'edit'`：取**模板已有的值**（`cloneParams(props.template.params)`，包括用户
//     之前留空的字段）——编辑时「模板里有什么就显示什么」，不拿 schema default 覆盖。
//
// ⚠ 保存语义也不同：create 走 POST（带 kind/scope/enabled）；edit 走 PATCH，body **只带**
//   `name` / `params` / `audience`，**绝不含 kind/scope**（后端 `adminPatchTemplate` 见这俩直接 400）。
//   校验仍交给后端 `validateKindParams`；后端 400 ⇒ 错误文案原样显示、表单不关、输入不清空。
import { computed, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import { KINDS, KIND_SCHEMA, KIND_SCOPE, AUDIENCES } from '@shared/macro-kinds';
import { kindMessageKey } from '../lib/macroView';

/** `KIND_SCHEMA` 的松散视图（shared 是 JS，无类型；这里只声明渲染要的字段）。 */
interface FieldSpec {
  type: string;
  values?: unknown[];
  min?: number;
  max?: number;
  /** 契约 §1 的默认值（#625）：新建初值**只从这里取**，与后端 `validateKindParams` 补的是同一份。 */
  default?: unknown;
  /** 契约 §1 的必填标记（#625）：缺了后端 400，前端只用来标「必填」。 */
  required?: boolean;
}
interface FormTemplate {
  id: string;
  kind: string;
  name: string;
  params: Record<string, unknown>;
  audience: string;
  scope: string;
  enabled: boolean;
  deleted_at?: string | null;
  subscriberCount?: number;
}

const props = withDefaults(defineProps<{
  mode: 'create' | 'edit';
  template?: FormTemplate | null;
}>(), { template: null });

const emit = defineEmits<{
  (e: 'saved', template: FormTemplate): void;
  (e: 'cancel'): void;
}>();

const SCHEMA = KIND_SCHEMA as unknown as Record<string, Record<string, FieldSpec>>;
const SCOPE = KIND_SCOPE as unknown as Record<string, string>;

const { t } = useI18n();

const isEdit = computed(() => props.mode === 'edit');

/** 拷一份 params：数组必须拷，否则 `toggleArrayValue` 会直接改到共享常量 / 列表行对象上。 */
function cloneParams(src: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src ?? {})) {
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

/**
 * 新建初值：**只取 schema 的 `default`**（issue #625）。
 * 没写 `default` 的字段就不预填（而不是猜一个空/下界）——与后端 `validateKindParams` 同源。
 */
function initialParams(entries: Array<[string, FieldSpec]>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, spec] of entries) {
    if (!('default' in spec)) continue; // 无默认 ⇒ 不预填（而不是猜一个）
    const d = spec.default;
    next[key] = Array.isArray(d) ? [...d] : d; // 数组拷一份：别改到共享的 `KIND_SCHEMA` 常量
  }
  return next;
}

// 表单初值按 mode 分流：**只在挂载时取一次**（父组件用 `v-if` + `:key` 控制重开即重置）。
const tpl = props.mode === 'edit' ? props.template ?? null : null;
const form = reactive<{ kind: string; name: string; audience: string; params: Record<string, unknown> }>({
  kind: tpl ? tpl.kind : '',
  name: tpl ? tpl.name : '',
  audience: tpl ? tpl.audience : (AUDIENCES[0] ?? 'all'),
  // create：schema default；edit：模板已有值（含留空字段）。两条路径绝不相交。
  params: tpl ? cloneParams(tpl.params) : {},
});

const submitError = ref<string | null>(null);
const createdTpl = ref<FormTemplate | null>(null);

const schemaEntries = computed<Array<[string, FieldSpec]>>(() =>
  form.kind && SCHEMA[form.kind] ? Object.entries(SCHEMA[form.kind]) : [],
);
const scopeLabel = computed(() => {
  const scope = form.kind ? SCOPE[form.kind] : null;
  return scope === 'user' ? t('admin.macros.scopeUser') : t('admin.macros.scopeSession');
});

/** 换 kind（仅新建可达）：按新 kind 的 schema 重建 params，不残留别的 kind 的字段。 */
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

/**
 * 保存：create ⇒ POST（带 kind/scope/enabled）；edit ⇒ PATCH（body **不含 kind/scope**）。
 * 成功：emit `saved`，新建再就地留一份预览（编辑由父组件关掉表单）。失败：错误文案留下、不清空、不关。
 */
/** 提交中标记（审查 #1：防重复提交）。 */
const submitting = ref(false);

async function submit(): Promise<void> {
  // 审查 #1：提交中没有防重 ⇒ 连点 / 重复回车会发两次 POST，后端 `(kind,name)` 索引**不是唯一索引**
  // ⇒ 真的会留下两条模板。这里用 submitting 同时挡住「按钮可点」与「函数被重入」。
  if (submitting.value) return;
  submitting.value = true;
  submitError.value = null;
  try {
    if (isEdit.value) {
      // ⚠ 绝不带 kind / scope：后端 `adminPatchTemplate` 见这俩直接 400。enabled 有独立启停按钮，也不带。
      const res = await api<{ template: FormTemplate }>(
        `/api/admin/macro-templates/${encodeURIComponent(props.template?.id ?? '')}`,
        { method: 'PATCH', body: JSON.stringify({ name: form.name, params: form.params, audience: form.audience }) },
      );
      emit('saved', res.template);
    } else {
      const res = await api<{ template: FormTemplate }>('/api/admin/macro-templates', {
        method: 'POST',
        // scope 由 kind 决定（后端也这么校验），前端照 `KIND_SCOPE` 送，绝不让用户手填。
        body: JSON.stringify({
          kind: form.kind, name: form.name, params: form.params,
          audience: form.audience, scope: form.kind ? SCOPE[form.kind] : undefined, enabled: true,
        }),
      });
      createdTpl.value = res.template;
      emit('saved', res.template);
    }
  } catch (e) {
    // 后端 400（validateKindParams / kind-scope 白名单）⇒ 原样显示、表单不关、输入不清空。
    submitError.value = e instanceof Error ? e.message : String(e);
  } finally {
    // 成败都复位：否则一次 400 之后按钮永久禁用（表单不关，用户改完也发不出去）。
    submitting.value = false;
  }
}

function cancel(): void {
  emit('cancel');
}

const createdPreview = computed(() => {
  const t0 = createdTpl.value;
  if (!t0) return '';
  const vis = audienceLabel(t0.audience);
  return `${t0.name} · ${t(kindMessageKey(t0.kind))} · ${vis}`;
});

const formTest = computed(() => (isEdit.value ? 'macros-edit-form' : 'macros-create-form'));
const errorTest = computed(() => (isEdit.value ? 'edit-error' : 'create-error'));
const submitTest = computed(() => (isEdit.value ? 'edit-submit' : 'create-submit'));
/**
 * 整数控件的变更处理（审查 #2）：**清空要删键，不是写 0**。
 *
 * 原来直接 `form.params[key] = Number(value)`，而 `Number('') === 0`：
 * 可选整数（如 `max_per_day`，无 default、min=1）本该「省略」，清空后却提交 `0` ⇒ 后端
 * `validateKindParams` 按 min 拒掉，用户看到的是一个莫名其妙的错误。
 */
function onIntChange(key: string, raw: string): void {
  const v = String(raw ?? '').trim();
  if (v === '') {
    delete form.params[key]; // 空 = 不填（省略这个键），不是 0
    return;
  }
  form.params[key] = Number(v);
}

/** `audience` 值 → 文案。**从 shared 枚举派生**，不抄字面量（审查 #5）。 */
function audienceLabel(a: string): string {
  return a === 'admin' ? t('admin.macros.audienceAdmin') : t('admin.macros.audienceAll');
}

const canSubmit = computed(() => (isEdit.value ? form.name.trim() !== '' : !!(form.kind && form.name)));
</script>

<template>
  <form
    :data-test="formTest"
    class="grid gap-3 rounded-lg border border-black/10 p-3"
    @submit.prevent="submit"
  >
    <!-- 编辑态标题（新建态不需要，新建由父级按钮已表明意图） -->
    <p v-if="isEdit" class="text-xs font-medium">{{ t('admin.macros.editFormTitle') }}</p>

    <!-- 新建：先选 kind；编辑：kind / scope 只读展示（后端 PATCH 到 kind/scope 直接 400，界面不该让用户试） -->
    <template v-if="!isEdit">
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
    </template>

    <!-- 编辑态：kind / scope 是纯文本（span，无 input / select） -->
    <template v-else>
      <p class="flex items-center gap-2 text-xs text-black/55">
        <span>{{ t('admin.macros.colKind') }}</span>
        <span data-test="edit-kind" class="font-medium text-black/80">{{ t(kindMessageKey(form.kind)) }}</span>
      </p>
      <p data-test="edit-kind-locked" class="text-xs text-amber-700">{{ t('admin.macros.kindLocked') }}</p>
    </template>

    <template v-if="form.kind">
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.macros.name') }}
        <input v-model="form.name" :data-test="isEdit ? 'edit-name' : 'create-name'" type="text" maxlength="40"
          class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm">
      </label>

      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.macros.audience') }}
        <select v-model="form.audience" :data-test="isEdit ? 'edit-audience' : 'create-audience'"
          class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm">
          <option v-for="a in AUDIENCES" :key="a" :value="a">{{ audienceLabel(a) }}</option>
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
            @change="onIntChange(key, ($event.target as HTMLInputElement).value)"
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

      <!-- 「以下由代码固定」区：判据与工具面写死；scope 只读展示（编辑态也在此显示，纯文本） -->
      <div :data-test="isEdit ? 'edit-fixed' : 'create-fixed'" class="rounded bg-black/5 p-2 text-xs text-black/60">
        <p class="font-medium">{{ t('admin.macros.fixedByCode') }}</p>
        <p>{{ t('admin.macros.fixedHint') }}</p>
        <p :data-test="isEdit ? 'edit-scope' : 'create-fixed-scope'">{{ t('admin.macros.fixedScope', { scope: scopeLabel }) }}</p>
      </div>
    </template>

    <p v-if="submitError" :data-test="errorTest" class="syserr text-xs" role="alert">{{ submitError }}</p>

    <div class="flex gap-2">
      <button type="submit" :data-test="submitTest" :disabled="!canSubmit || submitting"
        class="rounded bg-brand px-3 py-1 text-sm text-white disabled:opacity-50">
        {{ isEdit ? t('admin.macros.submitEdit') : t('admin.macros.submitCreate') }}
      </button>
      <button type="button" :data-test="isEdit ? 'edit-cancel' : 'create-cancel'"
        class="rounded border border-black/15 px-3 py-1 text-sm"
        @click="cancel">{{ t('admin.macros.cancel') }}</button>
    </div>

    <!-- 创建后：用户视角预览 + 一次触发成本估算（编辑态不需要） -->
    <div v-if="createdTpl" data-test="created-preview" class="rounded border border-emerald-300 bg-emerald-50 p-2 text-xs">
      <p class="font-medium">{{ t('admin.macros.createdTitle') }}</p>
      <p data-test="created-preview-text">{{ t('admin.macros.userPreview') }} {{ createdPreview }}</p>
      <p data-test="created-cost">{{ t('admin.macros.triggerCostUnknown') }}</p>
    </div>
  </form>
</template>
