<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ModalShell from '../components/ModalShell.vue';
import { MODEL_TYPES, useAdminStore, type LlmModel, type LlmProvider } from '../stores/admin';

const { t } = useI18n();
const admin = useAdminStore();

const showAddProvider = ref(false);
const editingProvider = ref<LlmProvider | null>(null);
const selectedProviderId = ref<string | null>(null);
const editingModel = ref<LlmModel | null>(null);
const deleting = ref(false);

const providerForm = reactive({ name: '', base_url: '', api_key: '' });
const providerEditForm = reactive({ base_url: '', api_key: '' });
// issue #164：定价以「USD / 1M tokens」呈现（LiteLLM 存的是每 token 单价，提交前换算）。
const PER_MILLION = 1_000_000;
const modelForm = reactive({
  model_id: '',
  model: '',
  name: '',
  type: 'text',
  tool_calling: false,
  context_window: '',
  max_tokens: '',
  // #309 切片 1：输出预算上限。**前端不做本地数字校验**（服务端是唯一判据，避免第二套规则）。
  max_output_tokens: '',
  input_cost_per_1m: '' as string | number,
  output_cost_per_1m: '' as string | number,
});
const modelEditForm = reactive({
  model: '', call_name: '', name: '', type: 'text', tool_calling: false, context_window: '', max_tokens: '',
  max_output_tokens: '',
  input_cost_per_1m: '' as string | number, output_cost_per_1m: '' as string | number, clear_pricing: false,
});
// #296：改「调用名」= 改 FDE 手里正在用的那个名字 ⇒ 必须点一次确认（确认前零请求，同 #246 改块先例）。
// 非 null 就渲染确认框；payload 是已组装好、等确认后才发出去的那一份 PATCH。
type ModelPatch = Parameters<typeof admin.updateModel>[1];
const pendingCallName = ref<{ from: string; to: string; payload: ModelPatch } | null>(null);
const callNameError = ref('');

/** 调用名重复集（跳供应商：LiteLLM 的路由名是全局的）。网关不拦重名 ⇒ 至少让人看出来。 */
const duplicateCallNames = computed(() => {
  const counts = new Map<string, number>();
  for (const provider of admin.providers) {
    for (const model of provider.models) counts.set(model.model_name, (counts.get(model.model_name) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name));
});

/** 每 token 单价 → 「每 1M tokens」输入框字符串（空值保持为空）。 */
function perTokenToInput(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return String(Number((value * PER_MILLION).toPrecision(6)));
}

/** 「每 1M tokens」输入 → 每 token 单价；空值返回 undefined（表示「不变/不填」）。 */
function inputToPerToken(raw: string | number | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value / PER_MILLION;
}

/** 表格展示：每 token 单价 → 每 1M tokens 的可读字符串。 */
function formatPerMillion(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `$${Number((value * PER_MILLION).toPrecision(6))}`;
}

const editPricingFromCostMap = computed(() => editingModel.value?.pricing_source === 'cost_map');

type DeleteTarget = { type: 'provider'; provider: LlmProvider } | { type: 'model'; model: LlmModel };
const deleteTarget = ref<DeleteTarget | null>(null);
const deleteMessage = computed(() => {
  const target = deleteTarget.value;
  if (!target) return '';
  return target.type === 'provider'
    ? t('admin.llm.confirmDeleteProvider', { name: target.provider.name })
    : t('admin.llm.confirmDeleteModel', { model: target.model.name });
});

function clearProviderForm() {
  providerForm.name = '';
  providerForm.base_url = '';
  providerForm.api_key = '';
}

function closeEditProvider() {
  editingProvider.value = null;
  providerEditForm.base_url = '';
  providerEditForm.api_key = '';
}

function closeAddProvider() {
  showAddProvider.value = false;
  clearProviderForm();
}

async function onAddProvider() {
  const err = await admin.addProvider(
    providerForm.name.trim(),
    providerForm.base_url.trim(),
    providerForm.api_key,
  );
  if (!err && !admin.llmErr) closeAddProvider();
}

function openEditProvider(provider: LlmProvider) {
  providerEditForm.base_url = provider.base_url;
  providerEditForm.api_key = '';
  editingProvider.value = provider;
}

async function onUpdateProvider() {
  const provider = editingProvider.value;
  if (!provider) return;
  const err = await admin.updateProvider(
    provider,
    providerEditForm.base_url.trim(),
    providerEditForm.api_key,
  );
  if (!err) closeEditProvider();
}

function openAddModel(providerId: string) {
  modelForm.model_id = '';
  modelForm.model = '';
  modelForm.name = '';
  modelForm.type = 'text';
  modelForm.tool_calling = false;
  modelForm.context_window = '';
  modelForm.max_tokens = '';
  modelForm.max_output_tokens = '';
  modelForm.input_cost_per_1m = '';
  modelForm.output_cost_per_1m = '';
  selectedProviderId.value = providerId;
}

function closeAddModel() {
  selectedProviderId.value = null;
}

async function onAddModel() {
  const providerId = selectedProviderId.value;
  if (!providerId) return;
  const inputCost = inputToPerToken(modelForm.input_cost_per_1m);
  const outputCost = inputToPerToken(modelForm.output_cost_per_1m);
  const err = await admin.addModel(providerId, {
    model_id: modelForm.model_id.trim(),
    model: modelForm.model.trim(),
    name: modelForm.name.trim(),
    type: modelForm.type,
    tool_calling: modelForm.tool_calling,
    context_window: modelForm.context_window ? Number(modelForm.context_window) : null,
    max_tokens: modelForm.max_tokens ? Number(modelForm.max_tokens) : null,
    // #309：没填就发 null（后端的「清空/不写」语义），填了就原样发——超限与否由服务端判。
    max_output_tokens: modelForm.max_output_tokens ? Number(modelForm.max_output_tokens) : null,
    ...(inputCost === undefined ? {} : { input_cost_per_token: inputCost }),
    ...(outputCost === undefined ? {} : { output_cost_per_token: outputCost }),
  });
  if (!err && !admin.llmErr) closeAddModel();
}

function openEditModel(model: LlmModel) {
  modelEditForm.model = model.litellm_params?.model ?? '';
  // #296：两个名字分开回填——调用名取数据面 model_name，展示名取 name（后端缺省回退成调用名）。
  modelEditForm.call_name = model.model_name ?? '';
  modelEditForm.name = model.name;
  modelEditForm.type = model.type;
  modelEditForm.tool_calling = model.tool_calling;
  modelEditForm.context_window = model.context_window === null ? '' : String(model.context_window);
  modelEditForm.max_tokens = model.max_tokens === null ? '' : String(model.max_tokens);
  // #309：旧后端 / 旧数据可能没这个字段 ⇒ `== null` 一并当「留空（= 不改）」处理。
  modelEditForm.max_output_tokens = model.max_output_tokens == null ? '' : String(model.max_output_tokens);
  // 只回填本模型「显式」定价；价目表自动命中时不回填，避免把当日价目表冻结成覆盖值。
  const hasOverride = model.pricing_source === 'override';
  modelEditForm.input_cost_per_1m = hasOverride ? perTokenToInput(model.input_cost_per_token) : '';
  modelEditForm.output_cost_per_1m = hasOverride ? perTokenToInput(model.output_cost_per_token) : '';
  modelEditForm.clear_pricing = false;
  pendingCallName.value = null;
  callNameError.value = '';
  editingModel.value = model;
}

/** 组装 PATCH：调用名**只在真的改了才带**（没改就不去碰数据面，更不触发立即对账）。 */
function buildModelPatch(callName: string | null): ModelPatch {
  const inputCost = modelEditForm.clear_pricing ? null : inputToPerToken(modelEditForm.input_cost_per_1m);
  const outputCost = modelEditForm.clear_pricing ? null : inputToPerToken(modelEditForm.output_cost_per_1m);
  return {
    ...(modelEditForm.model.trim() ? { model: modelEditForm.model.trim() } : {}),
    ...(callName === null ? {} : { call_name: callName }),
    name: modelEditForm.name.trim(),
    type: modelEditForm.type,
    tool_calling: modelEditForm.tool_calling,
    ...(modelEditForm.context_window ? { context_window: Number(modelEditForm.context_window) } : {}),
    ...(modelEditForm.max_tokens ? { max_tokens: Number(modelEditForm.max_tokens) } : {}),
    // #309：与 `max_tokens`/窗口同口径——**留空 = 不带键 = 保持现有值**（PATCH 里清空是显式 null，
    // 表单不提供「清空」按钮，避免把「留空」误读成「清空」）。超限由服务端拒，文案直接透传。
    ...(modelEditForm.max_output_tokens ? { max_output_tokens: Number(modelEditForm.max_output_tokens) } : {}),
    ...(inputCost === undefined ? {} : { input_cost_per_token: inputCost }),
    ...(outputCost === undefined ? {} : { output_cost_per_token: outputCost }),
  };
}

// --- issue #314：「按当前窗口 1/4 重设」 ----------------------------------------------------
// 为什么不是「清空」：真 LiteLLM v1.103.2 对 `litellm_params.max_tokens` 的显式 JSON `null` 是**忽略**
// 语义（管理台与手工两条路各实测一次：返 200 但值一字未动；网关源码里能被 `null` 清的字段在一个
// frozenset 白名单里，`max_tokens` 不在）⇒ 「手填过就再也撤不掉」。而管理员真正想要的不是「清空」，
// 是「让平台重新按新窗口兜底」⇒ 直接把值设成 `floor(窗口/4)` 就覆盖了这个需求（与门户读侧回退同一个算法）。
// ⚠ **这里不复制一份服务端的数字校验**（下限 65536 / 1/4 上限只有一处真相源：`portal/src/llm.js`）：
// 下面的 `floor(/4)` 只是「替人按一下计算器」，填进去的值照样要过服务端，超限就把 `error.message` 原样透出。
// 写第二套校验 = 多一个会过期的真相源（#309/#314 定死的口径），所以宁可不做本地拦截。
const editWindowValue = computed<number | null>(() => {
  // 窗口取**这一行**的现值：弹窗打开时输入框回填的就是它；管理员若在同一次编辑里改了窗口，
  // 就用改后的那个数（否则「把窗口从 262144 扩到 512000 后按新窗口重设」这个主场景根本成立不了）。
  const raw = modelEditForm.context_window;
  const candidate = raw === '' ? editingModel.value?.context_window : Number(raw);
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
});
const maxOutputQuarterWindow = computed(() => (editWindowValue.value === null ? null : Math.floor(editWindowValue.value / 4)));

/** #314：把输出预算上限**填进输入框**（不提交、不发请求）；用户还能继续改，改完自己点保存。 */
function resetMaxOutputToQuarterWindow() {
  const quarter = maxOutputQuarterWindow.value;
  if (quarter === null) return;
  modelEditForm.max_output_tokens = String(quarter);
}

async function submitModelEdit(payload: ModelPatch) {
  const model = editingModel.value;
  if (!model) return;
  const err = await admin.updateModel(model, payload);
  if (!err) {
    editingModel.value = null;
    pendingCallName.value = null;
  }
}

async function onUpdateModel() {
  const model = editingModel.value;
  if (!model) return;
  const callName = modelEditForm.call_name.trim();
  if (!callName) {
    // 不静默回退成旧名：留空就是没填（服务端也会 `validation_failed` + details.field=call_name）。
    callNameError.value = t('admin.llm.callNameRequired');
    return;
  }
  callNameError.value = '';
  if (callName !== model.model_name) {
    // 只到「确认」为止：此刻还一个请求都没发。
    pendingCallName.value = { from: model.model_name, to: callName, payload: buildModelPatch(callName) };
    return;
  }
  pendingCallName.value = null;
  await submitModelEdit(buildModelPatch(null));
}

async function onConfirmCallName() {
  const pending = pendingCallName.value;
  if (!pending) return;
  await submitModelEdit(pending.payload);
}

function cancelCallName() {
  pendingCallName.value = null;
}

async function onConfirmDelete() {
  const target = deleteTarget.value;
  if (!target || deleting.value) return;
  deleting.value = true;
  try {
    if (target.type === 'provider') await admin.removeProvider(target.provider);
    else await admin.removeModel(target.model);
    if (!admin.llmErr) deleteTarget.value = null;
  } finally {
    deleting.value = false;
  }
}

onMounted(() => {
  void admin.loadProviders();
});
</script>

<template>
  <section class="rounded-lg border border-black/10 bg-white">
    <div class="p-3">
      <div class="flex items-center gap-3">
        <h2 class="text-base font-semibold">{{ t('admin.llm.sectionTitle') }}</h2>
        <span class="flex-1"></span>
        <button
          type="button"
          data-test="open-add-provider"
          class="rounded-md bg-brand px-2.5 py-1 text-sm text-white hover:bg-brand-hover"
          @click="showAddProvider = true"
        >{{ t('admin.llm.addProvider') }}</button>
      </div>
      <p v-if="admin.llmErr" class="syserr my-1" role="alert">{{ admin.llmErr }}</p>

      <div data-test="provider-list">
        <p v-if="!admin.providersLoaded" class="muted">{{ t('common.loading') }}</p>
        <p v-else-if="admin.providers.length === 0" class="muted">{{ t('admin.llm.emptyProviders') }}</p>

        <div
          v-for="p in admin.providers"
          :key="p.id"
          data-test="provider-card"
          class="mt-2 rounded-lg border border-black/15"
        >
          <div data-test="provider-header" class="flex flex-wrap items-center gap-3 px-3 py-2">
            <span class="font-semibold">{{ p.name }}</span>
            <span class="text-black/50 text-xs break-all">{{ p.base_url }}</span>
            <span class="flex-1"></span>
            <button
              type="button"
              data-test="open-add-model"
              class="rounded-md bg-brand px-2 py-0.5 text-xs text-white hover:bg-brand-hover"
              @click="openAddModel(String(p.id))"
            >{{ t('admin.llm.addModel') }}</button>
            <button
              type="button"
              data-test="toggle-provider-models"
              class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
              @click="admin.toggleExpandedProvider(String(p.id))"
            >{{ admin.expandedProviders.includes(String(p.id)) ? t('admin.llm.collapseModels') : t('admin.llm.modelsCount', { count: p.models.length }) }}</button>
            <button
              type="button"
              data-test="edit-provider"
              class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
              @click="openEditProvider(p)"
            >{{ t('admin.edit') }}</button>
            <button
              type="button"
              class="rounded-md border border-red-600/60 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50"
              @click="deleteTarget = { type: 'provider', provider: p }"
            >{{ t('admin.delete') }}</button>
          </div>

          <div v-if="admin.expandedProviders.includes(String(p.id))" class="border-t border-dashed border-black/15 px-3 py-2">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-black/60">
                  <th class="py-1 pr-3 font-medium">{{ t('admin.llm.colCallName') }}</th>
                  <th class="py-1 pr-3 font-medium">{{ t('admin.llm.colDisplayName') }}</th>
                  <th class="py-1 pr-3 font-medium">{{ t('admin.llm.colType') }}</th>
                  <th class="py-1 pr-3 font-medium">tool_calling</th>
                  <th class="py-1 pr-3 font-medium">{{ t('admin.llm.colContextWindow') }}</th>
                  <th class="py-1 pr-3 font-medium">{{ t('admin.llm.colMaxTokens') }}</th>
                  <th class="py-1 pr-3 font-medium" :title="t('admin.llm.maxOutputTokensHint')">{{ t('admin.llm.colMaxOutputTokens') }}</th>
                  <th class="py-1 pr-3 font-medium">{{ t('admin.llm.colPricing') }}</th>
                  <th class="py-1 pr-3 font-medium">{{ t('admin.llm.colStatus') }}</th>
                  <th class="py-1 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="p.models.length === 0">
                  <td colspan="10" class="muted py-1">{{ t('admin.llm.emptyModels') }}</td>
                </tr>
                <tr v-for="m in p.models" :key="m.id" data-test="model-row" class="border-t border-black/5">
                  <td class="py-1 pr-3">
                    <!-- #296：调用名是**操作面**（FDE 请求实际发的名字）；网关不拦重名 ⇒ 重复就标出来 -->
                    <span data-test="model-call-name" class="font-mono text-xs">{{ m.model_name }}</span>
                    <span
                      v-if="duplicateCallNames.has(m.model_name)"
                      data-test="model-call-name-duplicate"
                      :title="t('admin.llm.duplicateCallNameHint')"
                      class="ml-1 rounded border border-amber-600 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700"
                    >{{ t('admin.llm.duplicateCallName') }}</span>
                  </td>
                  <td class="py-1 pr-3">{{ m.name }}</td>
                  <td class="py-1 pr-3">
                    <span class="rounded border border-sky-600 bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-700">{{ m.type }}</span>
                  </td>
                  <td class="py-1 pr-3">{{ m.tool_calling ? '✓' : '—' }}</td>
                  <td class="py-1 pr-3">{{ m.context_window ?? '—' }}</td>
                  <td class="py-1 pr-3">{{ m.max_tokens ?? '—' }}</td>
                  <!-- #309 切片 1.5：这一列显示的是后端给的**生效值**（没手填过时它是 floor(context_window/4)）
                       —— 前端不参与算，也就永远不会出现「列表与心跳下行各执一词」。 -->
                  <td class="py-1 pr-3" data-test="model-max-output-tokens">{{ m.max_output_tokens ?? '—' }}</td>
                  <td class="py-1 pr-3">
                    <span
                      v-if="!m.pricing_configured"
                      data-test="model-pricing-missing"
                      class="rounded border border-amber-600 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700"
                    >{{ t('admin.llm.pricingMissing') }}</span>
                    <span v-else data-test="model-pricing" class="text-xs text-black/70">
                      {{ formatPerMillion(m.input_cost_per_token) }} / {{ formatPerMillion(m.output_cost_per_token) }}<span class="text-black/40"> · /1M</span>
                    </span>
                  </td>
                  <td class="py-1 pr-3">
                    <span
                      class="rounded border px-1.5 py-0.5 text-xs font-medium"
                      :class="m.enabled ? 'border-green-600 bg-green-50 text-green-700' : 'border-black/30 bg-black/5 text-black/50'"
                    >{{ m.enabled ? t('admin.enabled') : t('admin.disabled') }}</span>
                  </td>
                  <td class="py-1 whitespace-nowrap">
                    <button
                      type="button"
                      class="mr-1 rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
                      @click="admin.toggleModel(m)"
                    >{{ m.enabled ? t('admin.disabled') : t('admin.enabled') }}</button>
                    <button
                      type="button"
                      data-test="edit-model"
                      class="mr-1 rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
                      @click="openEditModel(m)"
                    >{{ t('admin.edit') }}</button>
                    <button
                      type="button"
                      class="rounded-md border border-red-600/60 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50"
                      @click="deleteTarget = { type: 'model', model: m }"
                    >{{ t('admin.delete') }}</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

    </div>
  </section>

  <ModalShell
    v-if="showAddProvider"
    :label="t('admin.llm.addProviderTitle')"
    @close="closeAddProvider"
  >
    <div class="flex items-center gap-2 border-b border-black/10 px-3 py-2">
      <h2 class="text-sm font-medium">{{ t('admin.llm.addProviderTitle') }}</h2>
      <button type="button" :aria-label="t('common.close')" class="ml-auto rounded-md px-2 py-1 text-sm hover:bg-black/5" @click="closeAddProvider">✕</button>
    </div>
    <form data-test="add-provider-form" class="grid gap-3 px-3 py-3" @submit.prevent="onAddProvider">
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.providerName') }}
        <input v-model="providerForm.name" required placeholder="openai" class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        Base URL
        <input v-model="providerForm.base_url" required placeholder="https://api.openai.com/v1" class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.providerApiKeyLabel') }}
        <input
          v-model="providerForm.api_key"
          data-test="add-provider-api-key"
          type="password"
          autocomplete="new-password"
          class="rounded-md border border-black/20 px-2 py-1 text-sm"
        >
        <span class="text-[0.7rem] text-black/45">{{ t('admin.llm.providerApiKeyAddHint') }}</span>
      </label>
      <p v-if="admin.llmErr" class="syserr" role="alert">{{ admin.llmErr }}</p>
      <div class="flex gap-2">
        <button type="submit" class="flex-1 rounded-md bg-brand px-2.5 py-1 text-sm text-white hover:bg-brand-hover">{{ t('admin.llm.addProvider') }}</button>
        <button type="button" class="flex-1 rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5" @click="closeAddProvider">{{ t('common.cancel') }}</button>
      </div>
    </form>
  </ModalShell>

  <ModalShell
    v-if="editingProvider"
    :label="t('admin.llm.editProviderTitle', { name: editingProvider.name })"
    @close="closeEditProvider"
  >
    <div class="flex items-center gap-2 border-b border-black/10 px-3 py-2">
      <h2 class="text-sm font-medium">{{ t('admin.llm.editProviderTitle', { name: editingProvider.name }) }}</h2>
      <button type="button" :aria-label="t('common.close')" class="ml-auto rounded-md px-2 py-1 text-sm hover:bg-black/5" @click="closeEditProvider">✕</button>
    </div>
    <form data-test="edit-provider-form" class="grid gap-3 px-3 py-3" @submit.prevent="onUpdateProvider">
      <p class="text-sm">{{ editingProvider.name }}</p>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        Base URL
        <input v-model="providerEditForm.base_url" required class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.providerApiKeyLabel') }}
        <input
          v-model="providerEditForm.api_key"
          data-test="edit-provider-api-key"
          type="password"
          autocomplete="new-password"
          class="rounded-md border border-black/20 px-2 py-1 text-sm"
        >
        <span class="text-[0.7rem] text-black/45">{{ t('admin.llm.providerApiKeyEditHint') }}</span>
      </label>
      <p v-if="admin.llmErr" class="syserr" role="alert">{{ admin.llmErr }}</p>
      <div class="flex gap-2">
        <button type="submit" class="flex-1 rounded-md bg-brand px-2.5 py-1 text-sm text-white hover:bg-brand-hover">{{ t('admin.save') }}</button>
        <button type="button" class="flex-1 rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5" @click="closeEditProvider">{{ t('common.cancel') }}</button>
      </div>
    </form>
  </ModalShell>

  <ModalShell
    v-if="selectedProviderId"
    :label="t('admin.llm.addModelTitle')"
    dialog-class="max-h-[90vh] overflow-y-auto md:w-[36rem]"
    @close="closeAddModel"
  >
    <div class="flex items-center gap-2 border-b border-black/10 px-3 py-2">
      <h2 class="text-sm font-medium">{{ t('admin.llm.addModelTitle') }}</h2>
      <button type="button" :aria-label="t('common.close')" class="ml-auto rounded-md px-2 py-1 text-sm hover:bg-black/5" @click="closeAddModel">✕</button>
    </div>
    <form data-test="add-model-form" class="grid gap-3 px-3 py-3 sm:grid-cols-2" @submit.prevent="onAddModel">
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.colCallName') }}
        <input
          v-model="modelForm.model_id"
          data-test="add-model-call-name"
          required
          placeholder="gpt-4o"
          class="rounded-md border border-black/20 px-2 py-1 text-sm"
        >
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.upstreamModelId') }}
        <input
          v-model="modelForm.model"
          data-test="add-model-upstream-id"
          required
          placeholder="openai/&lt;model&gt;"
          class="rounded-md border border-black/20 px-2 py-1 text-sm"
        >
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.colDisplayName') }}
        <input v-model="modelForm.name" required placeholder="GPT-4o" class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.colType') }}
        <select v-model="modelForm.type" class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm">
          <option v-for="type in MODEL_TYPES" :key="type" :value="type">{{ type }}</option>
        </select>
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.colContextWindow') }}
        <input v-model="modelForm.context_window" type="number" min="1" placeholder="128000" class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.colMaxTokens') }}
        <input v-model="modelForm.max_tokens" data-test="add-model-max-tokens" type="number" min="1" placeholder="16384" class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <!-- #309 切片 1：只加提示，**不在前端卡数字**（上限由服务端单一判定，失败文案直接透传）。 -->
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.colMaxOutputTokens') }}
        <input v-model="modelForm.max_output_tokens" data-test="add-model-max-output-tokens" type="number" min="1" placeholder="32000" class="rounded-md border border-black/20 px-2 py-1 text-sm">
        <span class="text-[0.7rem] text-black/45">{{ t('admin.llm.maxOutputTokensHint') }}</span>
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.inputCostLabel') }}
        <input v-model="modelForm.input_cost_per_1m" data-test="add-model-input-cost" type="number" min="0" step="any" placeholder="0.28" class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.outputCostLabel') }}
        <input v-model="modelForm.output_cost_per_1m" data-test="add-model-output-cost" type="number" min="0" step="any" placeholder="1.10" class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <p class="text-[0.7rem] text-black/45 sm:col-span-2">{{ t('admin.llm.pricingHintAdd') }}</p>
      <label class="flex items-center gap-1 text-xs text-black/55">
        <input v-model="modelForm.tool_calling" type="checkbox" class="accent-brand"> tool_calling
      </label>
      <p v-if="admin.llmErr" class="syserr sm:col-span-2" role="alert">{{ admin.llmErr }}</p>
      <div class="flex gap-2 sm:col-span-2">
        <button type="submit" class="flex-1 rounded-md bg-brand px-2.5 py-1 text-sm text-white hover:bg-brand-hover">{{ t('admin.llm.addModel') }}</button>
        <button type="button" class="flex-1 rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5" @click="closeAddModel">{{ t('common.cancel') }}</button>
      </div>
    </form>
  </ModalShell>

  <ModalShell
    v-if="editingModel"
    :label="t('admin.llm.editModelTitle', { model: editingModel.name })"
    dialog-class="max-h-[90vh] overflow-y-auto md:w-[36rem]"
    @close="editingModel = null"
  >
    <div class="flex items-center gap-2 border-b border-black/10 px-3 py-2">
      <h2 class="text-sm font-medium">{{ t('admin.llm.editModelTitle', { model: editingModel.name }) }}</h2>
      <button type="button" :aria-label="t('common.close')" class="ml-auto rounded-md px-2 py-1 text-sm hover:bg-black/5" @click="editingModel = null">✕</button>
    </div>
    <form data-test="edit-model-form" class="grid gap-3 px-3 py-3 sm:grid-cols-2" @submit.prevent="onUpdateModel">
      <label class="flex flex-col gap-1 text-xs text-black/55 sm:col-span-2">
        {{ t('admin.llm.upstreamModelId') }}
        <input
          v-model="modelEditForm.model"
          data-test="edit-model-upstream-id"
          placeholder="openai/&lt;model&gt;"
          class="rounded-md border border-black/20 px-2 py-1 text-sm"
        >
        <span class="text-[0.7rem] text-black/45">{{ t('admin.llm.editUpstreamModelHint') }}</span>
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55 sm:col-span-2">
        {{ t('admin.llm.colCallName') }}
        <input
          v-model="modelEditForm.call_name"
          data-test="edit-model-call-name"
          required
          class="rounded-md border border-black/20 px-2 py-1 text-sm font-mono"
        >
        <span class="text-[0.7rem] text-black/45">{{ t('admin.llm.editCallNameHint') }}</span>
        <span
          v-if="editingModel && duplicateCallNames.has(modelEditForm.call_name.trim()) && modelEditForm.call_name.trim() !== editingModel.model_name"
          data-test="edit-model-call-name-duplicate"
          class="text-[0.7rem] text-amber-800"
          role="status"
        >{{ t('admin.llm.duplicateCallNameHint') }}</span>
        <span v-if="callNameError" data-test="edit-model-call-name-error" class="text-[0.7rem] text-red-700" role="alert">{{ callNameError }}</span>
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55 sm:col-span-2">
        {{ t('admin.llm.colDisplayName') }}
        <input
          v-model="modelEditForm.name"
          data-test="edit-model-display-name"
          required
          class="rounded-md border border-black/20 px-2 py-1 text-sm"
        >
        <span class="text-[0.7rem] text-black/45">{{ t('admin.llm.editDisplayNameHint') }}</span>
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.colType') }}
        <select v-model="modelEditForm.type" data-test="edit-model-type" class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm">
          <option v-for="type in MODEL_TYPES" :key="type" :value="type">{{ type }}</option>
        </select>
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.colContextWindow') }}
        <input v-model="modelEditForm.context_window" data-test="edit-model-context-window" type="number" min="1" placeholder="128000" class="rounded-md border border-black/20 px-2 py-1 text-sm">
        <span class="text-[0.7rem] text-black/45">{{ t('admin.llm.editContextWindowHint') }}</span>
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.colMaxTokens') }}
        <input v-model="modelEditForm.max_tokens" data-test="edit-model-max-tokens" type="number" min="1" placeholder="16384" class="rounded-md border border-black/20 px-2 py-1 text-sm">
        <span class="text-[0.7rem] text-black/45">{{ t('admin.llm.editMaxTokensHint') }}</span>
      </label>
      <!-- #309 切片 1：同上——提示可以写，本地校验不要写（否则就是第二套会过期的规则）。
           #314：字段说明里写死「留空 = 不修改」（PATCH 省略字段），与新建表单的「留空发显式 null」不对称同屏说清；
           「清空」做不到的事不给它「看起来能做」的错觉，只给一个把值填成 floor(窗口/4) 的重设按钮（不自动提交）。 -->
      <div class="flex flex-col gap-1 text-xs text-black/55">
        <label class="flex flex-col gap-1">
          {{ t('admin.llm.colMaxOutputTokens') }}
          <input v-model="modelEditForm.max_output_tokens" data-test="edit-model-max-output-tokens" type="number" min="1" placeholder="32000" class="rounded-md border border-black/20 px-2 py-1 text-sm">
        </label>
        <button
          type="button"
          data-test="reset-max-output-tokens"
          :disabled="maxOutputQuarterWindow === null"
          :title="maxOutputQuarterWindow === null ? t('admin.llm.maxOutputResetNeedsWindow') : t('admin.llm.maxOutputResetHint')"
          class="self-start rounded-md border border-black/20 px-2 py-1 text-xs hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50"
          @click="resetMaxOutputToQuarterWindow"
        >{{ t('admin.llm.maxOutputReset') }}</button>
        <span data-test="edit-model-max-output-tokens-hint" class="text-[0.7rem] text-black/45">{{ t('admin.llm.editMaxOutputTokensHint') }}</span>
        <span class="text-[0.7rem] text-black/45">{{ t('admin.llm.maxOutputResetHint') }}</span>
      </div>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.inputCostLabel') }}
        <input v-model="modelEditForm.input_cost_per_1m" data-test="edit-model-input-cost" type="number" min="0" step="any" :disabled="modelEditForm.clear_pricing" class="rounded-md border border-black/20 px-2 py-1 text-sm disabled:bg-black/5">
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.outputCostLabel') }}
        <input v-model="modelEditForm.output_cost_per_1m" data-test="edit-model-output-cost" type="number" min="0" step="any" :disabled="modelEditForm.clear_pricing" class="rounded-md border border-black/20 px-2 py-1 text-sm disabled:bg-black/5">
      </label>
      <p class="text-[0.7rem] text-black/45 sm:col-span-2">
        <template v-if="editPricingFromCostMap">{{ t('admin.llm.pricingFromCostMap') }} </template>{{ t('admin.llm.pricingHintEdit') }}
      </p>
      <label class="flex items-center gap-1 text-xs text-black/55">
        <input v-model="modelEditForm.tool_calling" type="checkbox" class="accent-brand"> tool_calling
      </label>
      <label
        v-if="editingModel?.pricing_source === 'override'"
        class="flex items-center gap-1 text-xs text-black/55"
      >
        <input v-model="modelEditForm.clear_pricing" data-test="edit-model-clear-pricing" type="checkbox" class="accent-brand"> {{ t('admin.llm.pricingClear') }}
      </label>
      <!-- #296：改调用名的二次确认——弹出即说明「FDE 手里正在用的名字会变」，**此时仍未发出 PATCH** -->
      <div
        v-if="pendingCallName"
        data-test="call-name-confirm"
        role="alertdialog"
        aria-labelledby="call-name-confirm-title"
        class="rounded-md border border-red-300 bg-white p-2.5 sm:col-span-2"
      >
        <h5 id="call-name-confirm-title" class="text-sm font-semibold text-red-800">{{ t('admin.llm.confirmCallNameTitle') }}</h5>
        <p class="mt-1 text-sm">{{ t('admin.llm.confirmCallNameBody', { from: pendingCallName.from, to: pendingCallName.to }) }}</p>
        <p class="mt-1 text-sm font-medium text-red-800">{{ t('admin.llm.confirmCallNameWarning') }}</p>
        <div class="mt-2 flex gap-2">
          <button
            type="button"
            data-test="confirm-call-name"
            class="flex-1 rounded-md bg-red-700 px-2.5 py-1 text-sm text-white hover:bg-red-800"
            @click="onConfirmCallName"
          >{{ t('admin.llm.confirmCallNameAction') }}</button>
          <button
            type="button"
            data-test="cancel-call-name"
            class="flex-1 rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5"
            @click="cancelCallName"
          >{{ t('common.cancel') }}</button>
        </div>
      </div>
      <p v-if="admin.llmErr" class="syserr sm:col-span-2" role="alert">{{ admin.llmErr }}</p>
      <div class="flex gap-2 sm:col-span-2">
        <button type="submit" class="flex-1 rounded-md bg-brand px-2.5 py-1 text-sm text-white hover:bg-brand-hover">{{ t('admin.save') }}</button>
        <button type="button" class="flex-1 rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5" @click="editingModel = null">{{ t('common.cancel') }}</button>
      </div>
    </form>
  </ModalShell>

  <ModalShell
    v-if="deleteTarget"
    :label="t('admin.confirmDeleteTitle')"
    @close="deleteTarget = null"
  >
    <div class="flex items-center gap-2 border-b border-black/10 px-3 py-2">
      <h2 class="text-sm font-medium">{{ t('admin.confirmDeleteTitle') }}</h2>
      <button type="button" :aria-label="t('common.close')" class="ml-auto rounded-md px-2 py-1 text-sm hover:bg-black/5" @click="deleteTarget = null">✕</button>
    </div>
    <div class="p-3">
      <p>{{ deleteMessage }}</p>
      <p v-if="admin.llmErr" class="syserr mt-2" role="alert">{{ admin.llmErr }}</p>
      <div class="mt-3 flex gap-2">
        <button
          type="button"
          data-test="confirm-delete"
          :disabled="deleting"
          class="flex-1 rounded-md bg-red-700 px-2.5 py-1 text-sm text-white hover:bg-red-800 disabled:opacity-50"
          @click="onConfirmDelete"
        >{{ t('admin.delete') }}</button>
        <button
          type="button"
          class="flex-1 rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5"
          @click="deleteTarget = null"
        >{{ t('common.cancel') }}</button>
      </div>
    </div>
  </ModalShell>
</template>
