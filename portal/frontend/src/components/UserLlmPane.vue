<script setup lang="ts">
// per-user LLM 配置 pane（旧 admin.html loadUserLlmPane 的逐行平移）：
//   GET /api/admin/fdes/<fde>/llm 取 config（api_key 仅掩码）+ active_run；
//   有活跃 run → warnbox；供应商下拉联动过滤三个模型下拉（主模型=text 且 tool_calling，
//   embedding/vision 各类型，均可空「（不配置）」，回填当前 config 对应 model_id）；
//   PUT 保存；409 active_run_conflict → 展示服务端原因 + 「确认无影响，强制保存」显式确认
//   （点击才带 force=true 重试，绝不静默 force）；provision 容器按钮。
import { computed, onMounted, ref, watch } from 'vue';
import { api, ApiError } from '../api';
import type { AdminUser, LlmModel, LlmProvider } from '../stores/admin';

const props = defineProps<{
  user: AdminUser;
  providers: LlmProvider[];
}>();

// config 回显结构（GET /api/admin/fdes/<fde>/llm → { config, active_run }；
// config.main/embedding/vision 各含 { model_id, ... }，api_key 为掩码）。
interface SlotEcho {
  model_id?: string | null;
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
const apiKey = ref('');
const mainModelId = ref('');
const embeddingModelId = ref('');
const visionModelId = ref('');

const okMsg = ref(''); // 旧 [data-llmmsg] 内的 .okmsg
const errMsg = ref(''); // 旧 [data-llmmsg] 内的 .syserr
const conflictMsg = ref(''); // 409 拒绝原因（旧 submitLlm 的显式确认分支）
const showForce = ref(false); // 「确认无影响，强制保存」按钮可见性

// 旧 keyhint：已配置 xxx，重输以修改 / 首次配置必填。
const keyHint = computed(() => (cfg.value?.api_key ? `已配置 ${cfg.value.api_key}，重输以修改` : '首次配置必填'));

// 当前供应商下启用中的模型（旧 ms = (p?.models ?? []).filter((m) => m.enabled)）。
const enabledModels = computed<LlmModel[]>(() => {
  const p = props.providers.find((x) => x.id === providerId.value);
  return (p?.models ?? []).filter((m) => m.enabled);
});

const mainOptions = computed(() => enabledModels.value.filter((m) => m.type === 'text' && m.tool_calling === true));
const embeddingOptions = computed(() => enabledModels.value.filter((m) => m.type === 'embedding'));
const visionOptions = computed(() => enabledModels.value.filter((m) => m.type === 'vision'));

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
    loadErr.value = '错误：' + (e instanceof Error ? e.message : String(e));
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
    if (apiKey.value) body.api_key = apiKey.value;
    if (force) body.force = true;
    const r = await api<{ config: FdeLlmConfig & { main: { model_id: string } } }>(`/api/admin/fdes/${fde}/llm`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    cfg.value = r.config;
    okMsg.value = `已保存：主模型 ${r.config.main.model_id}` + (r.config.api_key ? `（key ${r.config.api_key}）` : '');
    errMsg.value = '';
    conflictMsg.value = ''; // 旧版成功即清空消息区（含 409 拒绝与强制按钮）
    showForce.value = false;
    apiKey.value = ''; // 旧版成功后清空密码框
  } catch (err) {
    if (err instanceof ApiError && err.code === 'active_run_conflict' && !force) {
      // 服务端拒绝 → 展示原因 + 显式确认按钮（点击才算知情，才带 force=true 重试）。
      conflictMsg.value = '已拒绝（409）：' + err.message;
      showForce.value = true;
      return;
    }
    errMsg.value = '错误：' + (err instanceof Error ? err.message : String(err));
  }
}

async function onProvision() {
  okMsg.value = '';
  errMsg.value = '';
  try {
    const r = await api<{ container: string; network: string; subnet: string }>(`/api/admin/fdes/${fde}/provision`, {
      method: 'POST',
      body: '{}',
    });
    okMsg.value = `provision 完成：${r.container}（${r.network} ${r.subnet}）`;
  } catch (e) {
    errMsg.value = '错误：' + (e instanceof Error ? e.message : String(e));
  }
}

onMounted(loadPane);
</script>

<template>
  <p v-if="loading" class="muted">加载 LLM 配置…</p>
  <p v-else-if="loadErr" class="syserr">{{ loadErr }}</p>
  <template v-else>
    <!-- 活跃 run 告警盒（旧 .warnbox 语义） -->
    <div
      v-if="activeRun"
      class="my-2 rounded-lg border border-amber-500 bg-amber-50 px-3 py-2 text-[0.83rem] text-amber-800"
    >⚠️ 有活跃 run：更换供应商或 API key 会被服务端拒绝（影响进行中的 run）；纯模型变更不受影响。</div>

    <form class="mt-2 grid gap-2" style="grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr))" @submit.prevent="submitLlm(false)">
      <label class="flex flex-col gap-0.5 text-xs text-black/55">
        供应商
        <select
          v-model="providerId"
          data-test="provider-select"
          class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
        >
          <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
      <label class="flex flex-col gap-0.5 text-xs text-black/55">
        API Key（<span data-test="key-hint">{{ keyHint }}</span>）
        <input
          v-model="apiKey"
          type="password"
          autocomplete="new-password"
          :placeholder="cfg?.api_key ? '留空 = 保持不变' : ''"
          class="rounded-md border border-black/20 px-2 py-1 text-sm"
        >
      </label>
      <label class="flex flex-col gap-0.5 text-xs text-black/55">
        主模型（text · tool_calling）
        <select v-model="mainModelId" data-test="main-model" class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm">
          <option value="">（不配置）</option>
          <option v-for="m in mainOptions" :key="m.id" :value="m.id">{{ m.model_id }} — {{ m.name }}</option>
        </select>
      </label>
      <label class="flex flex-col gap-0.5 text-xs text-black/55">
        Embedding（可空）
        <select v-model="embeddingModelId" data-test="embedding-model" class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm">
          <option value="">（不配置）</option>
          <option v-for="m in embeddingOptions" :key="m.id" :value="m.id">{{ m.model_id }} — {{ m.name }}</option>
        </select>
      </label>
      <label class="flex flex-col gap-0.5 text-xs text-black/55">
        Vision（可空）
        <select v-model="visionModelId" data-test="vision-model" class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm">
          <option value="">（不配置）</option>
          <option v-for="m in visionOptions" :key="m.id" :value="m.id">{{ m.model_id }} — {{ m.name }}</option>
        </select>
      </label>
      <div class="flex items-end gap-2">
        <button type="submit" class="rounded-md bg-brand px-2.5 py-1 text-sm text-white hover:bg-brand-hover">保存 LLM 配置</button>
        <button type="button" class="rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5" @click="onProvision">provision 容器</button>
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
        >确认无影响，强制保存</button>
      </template>
    </div>
  </template>
</template>
