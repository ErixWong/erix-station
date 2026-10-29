<script setup lang="ts">
// per-user LLM 配置 pane（旧 admin.html loadUserLlmPane 的逐行平移）：
//   GET /api/admin/fdes/<fde>/llm 取 config（api_key 仅掩码）+ active_run；
//   有活跃 run → warnbox；供应商下拉联动过滤三个模型下拉（主模型=text 且 tool_calling，
//   embedding/vision 各类型，均可空「（不配置）」，回填当前 config 对应 model_id）；
//   PUT 保存；409 active_run_conflict → 展示服务端原因 + 「确认无影响，强制保存」显式确认
//   （点击才带 force=true 重试，绝不静默 force）；provision 容器按钮。
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../api';
import { modelOptionLabel } from '../lib/modelLabel';
import { useAdminStore, type AdminUser, type GitHost, type LlmModel, type LlmProvider } from '../stores/admin';

// issue #101 P3：pane 文案走 i18n（admin.llm.*）；服务端透传的 error.message 不译，
// 仅前缀（「错误：」/「已拒绝（409）：」）走 t()。
const { t } = useI18n();
const admin = useAdminStore();

const props = defineProps<{
  user: AdminUser;
  providers: LlmProvider[];
  gitHosts: GitHost[];
}>();

// config 回显结构（GET /api/admin/fdes/<fde>/llm → { config, active_run }；
// config.main/embedding/vision 各含 { model_id, ... }，api_key 为掩码）。
interface SlotEcho {
  model_id?: string | null;
  /** 数据面调用名（= fde_llm_bindings.*_model_name），后端 slot() 必给；不是展示名。 */
  name?: string | null;
}
interface FdeLlmConfig {
  provider_id: string | null;
  api_key?: string | null;
  main?: SlotEcho | null;
  embedding?: SlotEcho | null;
  vision?: SlotEcho | null;
}

const fde = encodeURIComponent(props.user.fde_name ?? '');
const loading = ref(true);
const loadErr = ref<string | null>(null);
const cfg = ref<FdeLlmConfig | null>(null);
const activeRun = ref(false);

const providerId = ref('');
const mainModelId = ref('');
const embeddingModelId = ref('');
const visionModelId = ref('');

const okMsg = ref(''); // 旧 [data-llmmsg] 内的 .okmsg
const errMsg = ref(''); // 旧 [data-llmmsg] 内的 .syserr
const conflictMsg = ref(''); // 409 拒绝原因（旧 submitLlm 的显式确认分支）
const showForce = ref(false); // 「确认无影响，强制保存」按钮可见性
const gitHostId = ref(props.user.git_host_id ?? '');
const credentialUsername = ref('');
const credentialToken = ref('');
const credentialErr = ref('');
const credentialSaved = ref(false);
const savingCredential = ref(false);
const awaitingCredential = ref(props.user.status === 'awaiting_credential');
const selectedGitHost = computed(() => props.gitHosts.find((host) => host.id === gitHostId.value) ?? null);
const enabledGitHosts = computed(() => props.gitHosts.filter((host) => host.enabled));
const actionButtonSizeClass = 'inline-flex min-h-8 items-center whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm';

// 当前供应商下启用中的模型（旧 ms = (p?.models ?? []).filter((m) => m.enabled)）。
const enabledModels = computed<LlmModel[]>(() => {
  const p = props.providers.find((x) => x.id === providerId.value);
  return (p?.models ?? []).filter((m) => m.enabled);
});

const mainOptions = computed(() => enabledModels.value.filter((m) => m.type === 'text' && m.tool_calling === true));
const embeddingOptions = computed(() => enabledModels.value.filter((m) => m.type === 'embedding'));
const visionOptions = computed(() => enabledModels.value.filter((m) => m.type === 'vision'));

// 下拉标签一律走 modelOptionLabel（展示名 [+ 调用名]）：**不要**再拼 model_id——那是 LiteLLM
// 主键 UUID，摊到界面上就是「920aa0c6-f336-… — deepseek-flash」这种读不得的东西。只管显示，
// 提交/回填仍用主键 id。
function modelOptionTitle(model: LlmModel) {
  return modelOptionLabel(model);
}

function selectedModelTitle(options: LlmModel[], id: string) {
  const model = options.find((item) => item.id === id);
  return model ? modelOptionTitle(model) : '';
}

async function loadPane() {
  loading.value = true;
  loadErr.value = null;
  try {
    const data = await api<{ config: FdeLlmConfig | null; active_run: boolean }>(`/api/admin/fdes/${fde}/llm`);
    cfg.value = data.config;
    activeRun.value = data.active_run === true;
    providerId.value = data.config?.provider_id ?? '';
    fillModelSelects();
  } catch (e) {
    loadErr.value = t('admin.errorPrefix') + (e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

// 旧 fillModelSelects：按类型/能力过滤三个模型下拉，并回填当前 config 对应 model_id。
function fillModelSelects() {
  const ms = enabledModels.value;
  mainModelId.value = '';
  embeddingModelId.value = '';
  visionModelId.value = '';
  if (cfg.value?.main?.model_id) {
    const cur = ms.find((m) => m.model_id === cfg.value!.main!.model_id && m.tool_calling === true && m.type === 'text');
    if (cur) mainModelId.value = cur.id;
  }
  for (const slot of ['embedding', 'vision'] as const) {
    const mid = cfg.value?.[slot]?.model_id;
    if (mid) {
      const cur = ms.find((m) => m.model_id === mid && m.type === slot);
      if (cur) {
        if (slot === 'embedding') embeddingModelId.value = cur.id;
        else visionModelId.value = cur.id;
      }
    }
  }
}

// 供应商下拉变化 → 重填模型下拉；providers 异步加载完成也要重填（pane 先渲染、列表后到）。
watch(enabledModels, fillModelSelects);

// F6（Round B 评审）：服务端对「活跃 run + 换 provider/key」返回 409 active_run_conflict。
// UI 必须真实处理 409：展示服务端原因，且只有在管理员**显式点击确认**后才带 force=true 重试——
// 绝不静默 force（fail-visible：运行中换 provider 会静默改变 run 的上游，必须留人工知情痕迹）。
async function submitLlm(force: boolean) {
  if (!force) {
    okMsg.value = '';
    errMsg.value = '';
    conflictMsg.value = '';
    showForce.value = false;
  }
  try {
    const body: Record<string, unknown> = {
      provider_id: providerId.value,
      main_model_id: mainModelId.value || undefined,
      embedding_model_id: embeddingModelId.value || null,
      vision_model_id: visionModelId.value || null,
    };
    if (force) body.force = true;
    const r = await api<{ config: FdeLlmConfig & { main: { model_id: string } } }>(`/api/admin/fdes/${fde}/llm`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    cfg.value = r.config;
    // 回显的 config.main.model_id 是 UUID，不能直接进文案：用刚选中的那个模型的标签。
    const saved = mainOptions.value.find((m) => m.id === mainModelId.value);
    okMsg.value = t('admin.llm.saved', { model: saved ? modelOptionLabel(saved) : (r.config.main.name ?? '') });
    errMsg.value = '';
    conflictMsg.value = ''; // 旧版成功即清空消息区（含 409 拒绝与强制按钮）
    showForce.value = false;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'active_run_conflict' && !force) {
      // 服务端拒绝 → 展示原因 + 显式确认按钮（点击才算知情，才带 force=true 重试）。
      conflictMsg.value = t('admin.llm.conflictPrefix') + err.message;
      showForce.value = true;
      return;
    }
    errMsg.value = t('admin.errorPrefix') + (err instanceof Error ? err.message : String(err));
  }
}

async function onProvision() {
  okMsg.value = '';
  errMsg.value = '';
  try {
    const r = await api<{ container: string; network: string; subnet: string; status?: string }>(`/api/admin/fdes/${fde}/provision`, {
      method: 'POST',
      body: JSON.stringify(gitHostId.value ? { git_host_id: gitHostId.value } : {}),
    });
    okMsg.value = r.status === 'awaiting_credential'
      ? t('admin.repos.credentialHint')
      : t('admin.llm.provisionDone', { container: r.container, network: r.network, subnet: r.subnet });
    awaitingCredential.value = r.status === 'awaiting_credential';
    await admin.loadUsers();
  } catch (e) {
    errMsg.value = t('admin.errorPrefix') + (e instanceof Error ? e.message : String(e));
  }
}

async function onSaveGitCredential() {
  const host = selectedGitHost.value;
  if (!host || savingCredential.value) return;
  credentialErr.value = '';
  credentialSaved.value = false;
  savingCredential.value = true;
  try {
    const hostname = new URL(host.base_url).host;
    await api(`/api/admin/fdes/${fde}/git-credential`, {
      method: 'PUT',
      body: JSON.stringify({
        host: hostname,
        username: credentialUsername.value,
        token: credentialToken.value,
      }),
    });
    credentialToken.value = '';
    credentialSaved.value = true;
    awaitingCredential.value = false;
    await admin.loadUsers();
  } catch (e) {
    credentialErr.value = t('admin.errorPrefix') + (e instanceof Error ? e.message : String(e));
  } finally {
    savingCredential.value = false;
  }
}

onMounted(loadPane);
</script>

<template>
  <p v-if="loading" class="muted">{{ t('admin.llm.loadingPane') }}</p>
  <p v-else-if="loadErr" class="syserr">{{ loadErr }}</p>
  <template v-else>
    <!-- 活跃 run 告警盒（旧 .warnbox 语义） -->
    <div
      v-if="activeRun"
      class="my-2 rounded-lg border border-amber-500 bg-amber-50 px-3 py-2 text-[0.83rem] text-amber-800"
    >{{ t('admin.llm.activeRunWarn') }}</div>

    <form class="mt-2 grid gap-3" @submit.prevent="submitLlm(false)">
      <label class="grid min-w-0 grid-cols-[minmax(7rem,9rem)_minmax(0,1fr)] items-center gap-x-3 text-xs text-black/55">
        <span>{{ t('admin.llm.providerLabel') }}</span>
        <select
          v-model="providerId"
          data-test="provider-select"
          :title="providers.find((p) => p.id === providerId)?.name ?? ''"
          class="min-w-0 w-full truncate rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
        >
          <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
      <div
        v-if="cfg?.api_key"
        data-test="virtual-key"
        class="grid min-w-0 grid-cols-[minmax(7rem,9rem)_minmax(0,1fr)] items-center gap-x-3"
      >
        <span class="text-xs text-black/55">{{ t('admin.llm.virtualKeyLabel') }}</span>
        <span :title="cfg.api_key" class="min-w-0 truncate font-mono text-sm text-black/70">{{ cfg.api_key }}</span>
      </div>
      <label class="grid min-w-0 grid-cols-[minmax(7rem,9rem)_minmax(0,1fr)] items-center gap-x-3 text-xs text-black/55">
        <span>{{ t('admin.repos.selectHost') }}</span>
        <select
          v-model="gitHostId"
          data-test="git-host-select"
          :title="selectedGitHost?.name ?? ''"
          class="min-w-0 w-full truncate rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
        >
          <option value="">{{ t('admin.repos.noHost') }}</option>
          <option v-for="host in enabledGitHosts" :key="host.id" :value="host.id">
            {{ host.name }} · {{ host.provider }} · {{ host.mode === 'minted' ? t('admin.repos.modeMinted') : t('admin.repos.modeCredential') }}
          </option>
        </select>
      </label>
      <label class="grid min-w-0 grid-cols-[minmax(7rem,9rem)_minmax(0,1fr)] items-center gap-x-3 text-xs text-black/55">
        <span class="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <span>{{ t('admin.llm.mainModelLabel') }}</span>
          <span class="text-xs text-black/45">{{ t('admin.llm.mainModelCapabilities') }}</span>
        </span>
        <select
          v-model="mainModelId"
          data-test="main-model"
          :title="selectedModelTitle(mainOptions, mainModelId)"
          class="min-w-0 w-full truncate rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
        >
          <option value="">{{ t('admin.llm.notConfigured') }}</option>
          <option v-for="m in mainOptions" :key="m.id" :value="m.id" :title="modelOptionTitle(m)">
            {{ modelOptionTitle(m) }}
          </option>
        </select>
      </label>
      <label class="grid min-w-0 grid-cols-[minmax(7rem,9rem)_minmax(0,1fr)] items-center gap-x-3 text-xs text-black/55">
        <span>{{ t('admin.llm.embeddingLabel') }}</span>
        <select
          v-model="embeddingModelId"
          data-test="embedding-model"
          :title="selectedModelTitle(embeddingOptions, embeddingModelId)"
          class="min-w-0 w-full truncate rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
        >
          <option value="">{{ t('admin.llm.notConfigured') }}</option>
          <option v-for="m in embeddingOptions" :key="m.id" :value="m.id" :title="modelOptionTitle(m)">
            {{ modelOptionTitle(m) }}
          </option>
        </select>
      </label>
      <label class="grid min-w-0 grid-cols-[minmax(7rem,9rem)_minmax(0,1fr)] items-center gap-x-3 text-xs text-black/55">
        <span>{{ t('admin.llm.visionLabel') }}</span>
        <select
          v-model="visionModelId"
          data-test="vision-model"
          :title="selectedModelTitle(visionOptions, visionModelId)"
          class="min-w-0 w-full truncate rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
        >
          <option value="">{{ t('admin.llm.notConfigured') }}</option>
          <option v-for="m in visionOptions" :key="m.id" :value="m.id" :title="modelOptionTitle(m)">
            {{ modelOptionTitle(m) }}
          </option>
        </select>
      </label>
      <div class="flex flex-wrap gap-2">
        <button type="submit" :class="[actionButtonSizeClass, 'bg-brand text-white hover:bg-brand-hover']">{{ t('admin.llm.save') }}</button>
        <button
          type="button"
          :class="[actionButtonSizeClass, 'border border-black/20 hover:bg-black/5']"
          @click="onProvision"
        >{{ t('admin.llm.provision') }}</button>
      </div>
    </form>

    <!-- 旧 [data-llmmsg] 消息区 -->
    <div class="mt-2 text-[0.85rem]">
      <p v-if="okMsg" class="text-green-700">{{ okMsg }}</p>
      <p v-if="errMsg" class="syserr">{{ errMsg }}</p>
      <template v-if="conflictMsg">
        <p class="syserr">{{ conflictMsg }}</p>
        <button
          v-if="showForce"
          type="button"
          data-test="force-save"
          class="rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5"
          @click="submitLlm(true)"
        >{{ t('admin.llm.forceSave') }}</button>
      </template>
    </div>

    <form
      v-if="awaitingCredential && selectedGitHost?.mode === 'per_fde_pat'"
      data-test="git-credential-form"
      class="mt-3 grid gap-2 rounded-md border border-amber-500 bg-amber-50 p-3"
      @submit.prevent="onSaveGitCredential"
    >
      <p class="text-sm font-medium">{{ t('admin.repos.credentialTitle') }}</p>
      <p class="text-xs text-black/55">{{ t('admin.repos.credentialHint') }}</p>
      <label class="flex flex-col gap-0.5 text-xs text-black/55">
        {{ t('admin.repos.credentialUsername') }}
        <input v-model="credentialUsername" required autocomplete="off" class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <label class="flex flex-col gap-0.5 text-xs text-black/55">
        {{ t('admin.repos.credentialToken') }}
        <input v-model="credentialToken" type="password" required autocomplete="new-password" class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <p v-if="credentialErr" class="syserr" role="alert">{{ credentialErr }}</p>
      <button
        type="submit"
        data-test="save-git-credential"
        :disabled="savingCredential"
        class="justify-self-start rounded-md bg-brand px-2.5 py-1 text-sm text-white hover:bg-brand-hover disabled:opacity-50"
      >{{ t('admin.repos.saveCredential') }}</button>
    </form>
    <p v-if="credentialSaved" data-test="git-credential-saved" class="mt-2 text-sm text-green-700">
      {{ t('admin.repos.credentialSaved') }}
    </p>
  </template>
</template>
