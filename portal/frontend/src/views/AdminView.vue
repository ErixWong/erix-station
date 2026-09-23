<script setup lang="ts">
// 管理台（issue #61 P3）：旧 portal/static/admin.html（Bootstrap+jQuery 风格内联页）逐行平移进 Vue SPA。
// 两段：LLM 供应商（卡片 + 模型明细表 + 增删/启停）与 FDE 管理（用户卡片 + per-user LLM 配置
// pane + 新增用户一次性 TOTP 盒）。状态/动作在 stores/admin.ts；per-user 配置 pane 在
// components/UserLlmPane.vue。后端零改动：全部走既有 /api/admin/* 端点。
import { computed, onMounted, reactive } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { MODEL_TYPES, useAdminStore, type LlmModel, type LlmProvider } from '../stores/admin';
import UserLlmPane from '../components/UserLlmPane.vue';

const router = useRouter();
const auth = useAuthStore();
const admin = useAdminStore();

const who = computed(() => {
  const u = auth.user;
  if (!u) return '';
  return `${u.login}（${u.role}${u.fde_name ? ' / ' + u.fde_name : ''}）`;
});

// ---- 顶部新增供应商表单（旧 #addProviderForm）----
const providerForm = reactive({ name: '', base_url: '' });

async function onAddProvider() {
  const err = await admin.addProvider(providerForm.name.trim(), providerForm.base_url.trim());
  if (!err) {
    providerForm.name = '';
    providerForm.base_url = '';
  }
}

// ---- 供应商下新增模型表单（旧 [data-addmodel] 表单；per-provider 本地表单态）----
const modelForms = reactive<Record<string, { model_id: string; name: string; type: string; tool_calling: boolean; context_window: string }>>({});
function modelForm(providerId: string) {
  if (!modelForms[providerId]) {
    modelForms[providerId] = { model_id: '', name: '', type: 'text', tool_calling: false, context_window: '' };
  }
  return modelForms[providerId];
}
async function onAddModel(providerId: string) {
  const f = modelForm(providerId);
  const err = await admin.addModel(providerId, {
    model_id: f.model_id.trim(),
    name: f.name.trim(),
    type: f.type,
    tool_calling: f.tool_calling,
    context_window: f.context_window ? Number(f.context_window) : null,
  });
  if (!err) {
    f.model_id = '';
    f.name = '';
    f.type = 'text';
    f.tool_calling = false;
    f.context_window = '';
  }
}

// ---- 供应商/模型删除（旧 confirm 文案逐字保留）----
function onDeleteProvider(p: LlmProvider) {
  if (!confirm(`确认删除供应商 ${p.name}？其下模型将一并删除。`)) return;
  admin.removeProvider(p);
}
function onDeleteModel(m: LlmModel) {
  if (!confirm(`确认删除模型 ${m.model_id}？`)) return;
  admin.removeModel(m);
}

// ---- 新增 FDE 用户表单（旧 #addUserForm）----
const userForm = reactive({ login: '', display_name: '', password: '', fde_name: '' });

async function onAddUser() {
  const err = await admin.addUser({
    login: userForm.login.trim(),
    display_name: userForm.display_name.trim(),
    password: userForm.password,
    ...(userForm.fde_name.trim() ? { fde_name: userForm.fde_name.trim() } : {}),
  });
  if (!err) {
    userForm.login = '';
    userForm.display_name = '';
    userForm.password = '';
    userForm.fde_name = '';
  }
}

async function onLogout() {
  await auth.logout();
  router.replace('/login');
}

onMounted(() => {
  // 旧 boot()：Promise.all([loadProviders(), loadUsers()])。
  void Promise.all([admin.loadProviders(), admin.loadUsers()]);
});
</script>

<template>
  <div class="min-h-screen flex flex-col bg-white">
    <header class="flex items-center gap-3 border-b border-black/10 px-3 py-2">
      <h1 class="text-xl font-medium mb-0">FDE Station 管理台</h1>
      <span class="flex-1 text-black/50 text-sm">{{ who }}</span>
      <router-link to="/" class="text-sm underline">← 返回工作台</router-link>
      <button
        class="rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5"
        @click="onLogout"
      >登出</button>
    </header>

    <main class="flex-1 p-3 flex flex-col gap-4">
      <!-- ==================== LLM 供应商（旧 #llmSection）==================== -->
      <section class="rounded-lg border border-black/10 bg-white">
        <div class="p-3">
          <h2 class="text-base font-semibold">LLM 供应商</h2>
          <p v-if="admin.llmErr" class="syserr my-1" role="alert">{{ admin.llmErr }}</p>

          <div data-test="provider-list">
            <p v-if="!admin.providersLoaded" class="muted">加载中…</p>
            <p v-else-if="admin.providers.length === 0" class="muted">暂无供应商，先在下方新增。</p>

            <!-- 供应商卡片（旧 .card .head + .detail） -->
            <div
              v-for="p in admin.providers"
              :key="p.id"
              data-test="provider-card"
              class="mt-2 rounded-lg border border-black/15"
            >
              <div class="flex flex-wrap items-center gap-3 px-3 py-2">
                <span class="font-semibold">{{ p.name }}</span>
                <span class="text-black/50 text-xs break-all">{{ p.base_url }}</span>
                <span
                  class="rounded border px-1.5 py-0.5 text-xs font-medium"
                  :class="p.enabled ? 'border-green-600 bg-green-50 text-green-700' : 'border-black/30 bg-black/5 text-black/50'"
                >{{ p.enabled ? '启用' : '停用' }}</span>
                <span class="flex-1"></span>
                <button
                  type="button"
                  class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
                  @click="admin.toggleExpandedProvider(String(p.id))"
                >{{ admin.expandedProviders.includes(String(p.id)) ? '收起模型' : `模型明细（${p.models.length}）` }}</button>
                <button
                  type="button"
                  class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
                  @click="admin.toggleProvider(p)"
                >{{ p.enabled ? '停用' : '启用' }}</button>
                <button
                  type="button"
                  class="rounded-md border border-red-600/60 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50"
                  @click="onDeleteProvider(p)"
                >删除</button>
              </div>

              <!-- 模型明细 + 新增模型表单（旧 .detail） -->
              <div v-if="admin.expandedProviders.includes(String(p.id))" class="border-t border-dashed border-black/15 px-3 py-2">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="text-left text-black/60">
                      <th class="py-1 pr-3 font-medium">model_id</th>
                      <th class="py-1 pr-3 font-medium">名称</th>
                      <th class="py-1 pr-3 font-medium">类型</th>
                      <th class="py-1 pr-3 font-medium">tool_calling</th>
                      <th class="py-1 pr-3 font-medium">上下文窗口</th>
                      <th class="py-1 pr-3 font-medium">状态</th>
                      <th class="py-1 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-if="p.models.length === 0">
                      <td colspan="7" class="muted py-1">该供应商下暂无模型</td>
                    </tr>
                    <tr v-for="m in p.models" :key="m.id" class="border-t border-black/5">
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
                        >{{ m.enabled ? '启用' : '停用' }}</span>
                      </td>
                      <td class="py-1">
                        <button
                          type="button"
                          class="mr-1 rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
                          @click="admin.toggleModel(m)"
                        >{{ m.enabled ? '停用' : '启用' }}</button>
                        <button
                          type="button"
                          class="rounded-md border border-red-600/60 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50"
                          @click="onDeleteModel(m)"
                        >删除</button>
                      </td>
                    </tr>
                  </tbody>
                </table>

                <!-- 供应商下新增模型表单（旧 [data-addmodel]） -->
                <form data-test="add-model-form" class="mt-2 flex flex-wrap items-end gap-2" @submit.prevent="onAddModel(String(p.id))">
                  <label class="flex flex-col gap-1 text-xs text-black/55">
                    model_id
                    <input
                      v-model="modelForm(String(p.id)).model_id" required placeholder="gpt-4o"
                      class="rounded-md border border-black/20 px-2 py-1 text-sm"
                    >
                  </label>
                  <label class="flex flex-col gap-1 text-xs text-black/55">
                    名称
                    <input
                      v-model="modelForm(String(p.id)).name" required placeholder="GPT-4o"
                      class="rounded-md border border-black/20 px-2 py-1 text-sm"
                    >
                  </label>
                  <label class="flex flex-col gap-1 text-xs text-black/55">
                    类型
                    <select
                      v-model="modelForm(String(p.id)).type"
                      class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
                    >
                      <option v-for="t in MODEL_TYPES" :key="t" :value="t">{{ t }}</option>
                    </select>
                  </label>
                  <label class="flex flex-col gap-1 text-xs text-black/55">
                    上下文窗口
                    <input
                      v-model="modelForm(String(p.id)).context_window" type="number" min="1" placeholder="128000"
                      class="rounded-md border border-black/20 px-2 py-1 text-sm"
                    >
                  </label>
                  <label class="flex items-center gap-1 pb-1.5 text-xs text-black/55">
                    <input v-model="modelForm(String(p.id)).tool_calling" type="checkbox" class="accent-brand"> tool_calling
                  </label>
                  <button type="submit" class="rounded-md bg-brand px-2.5 py-1 text-sm text-white hover:bg-brand-hover">＋ 新增模型</button>
                </form>
              </div>
            </div>
          </div>

          <!-- 顶部新增供应商表单（旧 #addProviderForm） -->
          <form data-test="add-provider-form" class="mt-3 flex flex-wrap items-end gap-2" @submit.prevent="onAddProvider">
            <label class="flex flex-col gap-1 text-xs text-black/55">
              供应商名
              <input
                v-model="providerForm.name" required placeholder="openai"
                class="rounded-md border border-black/20 px-2 py-1 text-sm"
              >
            </label>
            <label class="flex flex-col gap-1 text-xs text-black/55">
              Base URL
              <input
                v-model="providerForm.base_url" required placeholder="https://api.openai.com/v1"
                class="rounded-md border border-black/20 px-2 py-1 text-sm"
              >
            </label>
            <button type="submit" class="rounded-md bg-brand px-2.5 py-1 text-sm text-white hover:bg-brand-hover">＋ 新增供应商</button>
          </form>
        </div>
      </section>

      <!-- ==================== FDE 管理（旧 #fdeSection）==================== -->
      <section class="rounded-lg border border-black/10 bg-white">
        <div class="p-3">
          <h2 class="text-base font-semibold">FDE 管理</h2>
          <p v-if="admin.fdeErr" class="syserr my-1" role="alert">{{ admin.fdeErr }}</p>

          <!-- 一次性 TOTP 展示盒（旧 #totpOnce / .totpbox，仅此一次显示） -->
          <div
            v-if="admin.totpOnce"
            data-test="totp-box"
            class="my-2 rounded-lg border border-brand bg-green-50 p-3 text-[0.85rem]"
          >
            <img :src="admin.totpOnce.qr" alt="TOTP 认证器二维码" class="my-2 block h-48 w-48" style="image-rendering: pixelated">
            <div>用户 <b>{{ admin.totpOnce.login }}</b> 已创建。请用认证器 App 录入以下 otpauth URI 或种子（<b>仅此一次显示</b>）：</div>
            <div>otpauth URI：<code class="break-all select-all">{{ admin.totpOnce.uri }}</code></div>
            <div>TOTP 种子：<code class="break-all select-all">{{ admin.totpOnce.secret }}</code></div>
            <div>下一步：展开该用户卡片 → 配置 LLM 上游 → 点击 provision 容器；将登录名/口令与本二维码交给用户扫码录入认证器。</div>
          </div>

          <div data-test="user-list">
            <p v-if="!admin.usersLoaded" class="muted">加载中…</p>
            <p v-else-if="admin.users.length === 0" class="muted">暂无用户。</p>

            <!-- 用户卡片（旧 .head.row-head：点卡片头展开，按钮除外） -->
            <div
              v-for="u in admin.users"
              :key="u.id"
              data-test="user-card"
              class="mt-2 rounded-lg border border-black/15"
            >
              <div
                class="flex flex-wrap items-center gap-3 px-3 py-2 cursor-pointer hover:bg-green-50"
                @click="admin.toggleExpandedUser(String(u.id))"
              >
                <span class="font-semibold">{{ u.login }}</span>
                <span class="text-black/50 text-xs">{{ u.display_name }}</span>
                <span class="rounded border border-sky-600 bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-700">{{ u.role }}</span>
                <span v-if="u.fde_name" class="rounded border border-green-600 bg-green-50 px-1.5 py-0.5 text-xs font-medium text-green-700">{{ u.fde_name }}</span>
                <span v-else class="muted">无 fde_name</span>
                <span
                  class="rounded border px-1.5 py-0.5 text-xs font-medium"
                  :class="u.status === 'active' ? 'border-green-600 bg-green-50 text-green-700' : 'border-black/30 bg-black/5 text-black/50'"
                >{{ u.status }}</span>
                <span class="flex-1"></span>
                <button
                  type="button"
                  class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
                  @click.stop="admin.toggleExpandedUser(String(u.id))"
                >{{ admin.expandedUsers.includes(String(u.id)) ? '收起' : '展开' }}</button>
              </div>

              <!-- per-user LLM 配置 pane（旧 [data-pane="llm"]；无 fde_name 的提示文案逐字保留） -->
              <div v-if="admin.expandedUsers.includes(String(u.id))" class="border-t border-dashed border-black/15 px-3 py-2">
                <p v-if="!u.fde_name" class="muted">该用户未配置 fde_name，无需 LLM 配置。</p>
                <UserLlmPane v-else :user="u" :providers="admin.providers" />
              </div>
            </div>
          </div>

          <!-- 新增 FDE 用户表单（旧 #addUserForm） -->
          <h2 class="mt-4 text-base font-semibold">新增 FDE 用户</h2>
          <form data-test="add-user-form" class="mt-2 flex flex-wrap items-end gap-2" @submit.prevent="onAddUser">
            <label class="flex flex-col gap-1 text-xs text-black/55">
              登录名
              <input v-model="userForm.login" required autocomplete="off" class="rounded-md border border-black/20 px-2 py-1 text-sm">
            </label>
            <label class="flex flex-col gap-1 text-xs text-black/55">
              显示名
              <input v-model="userForm.display_name" autocomplete="off" class="rounded-md border border-black/20 px-2 py-1 text-sm">
            </label>
            <label class="flex flex-col gap-1 text-xs text-black/55">
              口令
              <input v-model="userForm.password" type="password" required autocomplete="new-password" class="rounded-md border border-black/20 px-2 py-1 text-sm">
            </label>
            <label class="flex flex-col gap-1 text-xs text-black/55">
              fde_name（可空）
              <input v-model="userForm.fde_name" placeholder="alice" autocomplete="off" class="rounded-md border border-black/20 px-2 py-1 text-sm">
            </label>
            <button type="submit" class="rounded-md bg-brand px-2.5 py-1 text-sm text-white hover:bg-brand-hover">＋ 创建用户</button>
          </form>
        </div>
      </section>
    </main>
  </div>
</template>
