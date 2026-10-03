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
const modelForm = reactive({
  model_id: '',
  name: '',
  type: 'text',
  tool_calling: false,
  context_window: '',
});
const modelEditForm = reactive({ name: '', tool_calling: false, context_window: '' });

type DeleteTarget = { type: 'provider'; provider: LlmProvider } | { type: 'model'; model: LlmModel };
const deleteTarget = ref<DeleteTarget | null>(null);
const deleteMessage = computed(() => {
  const target = deleteTarget.value;
  if (!target) return '';
  return target.type === 'provider'
    ? t('admin.llm.confirmDeleteProvider', { name: target.provider.name })
    : t('admin.llm.confirmDeleteModel', { model: target.model.model_id });
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
  modelForm.name = '';
  modelForm.type = 'text';
  modelForm.tool_calling = false;
  modelForm.context_window = '';
  selectedProviderId.value = providerId;
}

function closeAddModel() {
  selectedProviderId.value = null;
}

async function onAddModel() {
  const providerId = selectedProviderId.value;
  if (!providerId) return;
  const err = await admin.addModel(providerId, {
    model_id: modelForm.model_id.trim(),
    name: modelForm.name.trim(),
    type: modelForm.type,
    tool_calling: modelForm.tool_calling,
    context_window: modelForm.context_window ? Number(modelForm.context_window) : null,
  });
  if (!err && !admin.llmErr) closeAddModel();
}

function openEditModel(model: LlmModel) {
  modelEditForm.name = model.name;
  modelEditForm.tool_calling = model.tool_calling;
  modelEditForm.context_window = model.context_window === null ? '' : String(model.context_window);
  editingModel.value = model;
}

async function onUpdateModel() {
  const model = editingModel.value;
  if (!model) return;
  const err = await admin.updateModel(model, {
    name: modelEditForm.name.trim(),
    tool_calling: modelEditForm.tool_calling,
    ...(modelEditForm.context_window ? { context_window: Number(modelEditForm.context_window) } : {}),
  });
  if (!err) editingModel.value = null;
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
      <h2 class="text-base font-semibold">{{ t('admin.llm.sectionTitle') }}</h2>
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
          <div class="flex flex-wrap items-center gap-3 px-3 py-2">
            <span class="font-semibold">{{ p.name }}</span>
            <span class="text-black/50 text-xs break-all">{{ p.base_url }}</span>
            <span class="flex-1"></span>
            <button
              type="button"
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
                  <th class="py-1 pr-3 font-medium">model_id</th>
                  <th class="py-1 pr-3 font-medium">{{ t('admin.llm.colName') }}</th>
                  <th class="py-1 pr-3 font-medium">{{ t('admin.llm.colType') }}</th>
                  <th class="py-1 pr-3 font-medium">tool_calling</th>
                  <th class="py-1 pr-3 font-medium">{{ t('admin.llm.colContextWindow') }}</th>
                  <th class="py-1 pr-3 font-medium">{{ t('admin.llm.colStatus') }}</th>
                  <th class="py-1 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="p.models.length === 0">
                  <td colspan="7" class="muted py-1">{{ t('admin.llm.emptyModels') }}</td>
                </tr>
                <tr v-for="m in p.models" :key="m.id" data-test="model-row" class="border-t border-black/5">
                  <td class="py-1 pr-3">{{ m.model_id }}</td>
                  <td class="py-1 pr-3">{{ m.name }}</td>
                  <td class="py-1 pr-3">
                    <span class="rounded border border-sky-600 bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-700">{{ m.type }}</span>
                  </td>
                  <td class="py-1 pr-3">{{ m.tool_calling ? '✓' : '—' }}</td>
                  <td class="py-1 pr-3">{{ m.context_window ?? '—' }}</td>
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

            <button
              type="button"
              data-test="open-add-model"
              class="mt-2 rounded-md bg-brand px-2.5 py-1 text-sm text-white hover:bg-brand-hover"
              @click="openAddModel(String(p.id))"
            >{{ t('admin.llm.addModel') }}</button>
          </div>
        </div>
      </div>

      <button
        type="button"
        data-test="open-add-provider"
        class="mt-3 rounded-md bg-brand px-2.5 py-1 text-sm text-white hover:bg-brand-hover"
        @click="showAddProvider = true"
      >{{ t('admin.llm.addProvider') }}</button>
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
        model_id
        <input v-model="modelForm.model_id" required placeholder="gpt-4o" class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.colName') }}
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
    :label="t('admin.llm.editModelTitle', { model: editingModel.model_id })"
    dialog-class="max-h-[90vh] overflow-y-auto md:w-[36rem]"
    @close="editingModel = null"
  >
    <div class="flex items-center gap-2 border-b border-black/10 px-3 py-2">
      <h2 class="text-sm font-medium">{{ t('admin.llm.editModelTitle', { model: editingModel.model_id }) }}</h2>
      <button type="button" :aria-label="t('common.close')" class="ml-auto rounded-md px-2 py-1 text-sm hover:bg-black/5" @click="editingModel = null">✕</button>
    </div>
    <form data-test="edit-model-form" class="grid gap-3 px-3 py-3 sm:grid-cols-2" @submit.prevent="onUpdateModel">
      <p class="text-sm">model_id: {{ editingModel.model_id }}</p>
      <p class="text-sm">{{ t('admin.llm.colType') }}: {{ editingModel.type }}</p>
      <label class="flex flex-col gap-1 text-xs text-black/55 sm:col-span-2">
        {{ t('admin.llm.colName') }}
        <input v-model="modelEditForm.name" required class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.llm.colContextWindow') }}
        <input v-model="modelEditForm.context_window" type="number" min="1" placeholder="128000" class="rounded-md border border-black/20 px-2 py-1 text-sm">
        <span class="text-[0.7rem] text-black/45">{{ t('admin.llm.editContextWindowHint') }}</span>
      </label>
      <label class="flex items-center gap-1 text-xs text-black/55">
        <input v-model="modelEditForm.tool_calling" type="checkbox" class="accent-brand"> tool_calling
      </label>
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
