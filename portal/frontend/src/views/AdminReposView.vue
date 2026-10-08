<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ModalShell from '../components/ModalShell.vue';
import { useAdminStore, type GitHost } from '../stores/admin';

const { t } = useI18n();
const admin = useAdminStore();
const showAdd = ref(false);
const editingHost = ref<GitHost | null>(null);
const deletingHost = ref<GitHost | null>(null);
const submitting = ref(false);
const form = reactive({
  name: '',
  provider: 'gitea' as GitHost['provider'],
  base_url: '',
  admin_key: '',
  clear_admin_key: false,
});

function resetForm() {
  form.name = '';
  form.provider = 'gitea';
  form.base_url = '';
  form.admin_key = '';
  form.clear_admin_key = false;
}

function closeForm() {
  showAdd.value = false;
  editingHost.value = null;
  resetForm();
}

function openEdit(host: GitHost) {
  resetForm();
  form.name = host.name;
  form.provider = host.provider;
  form.base_url = host.base_url;
  editingHost.value = host;
}

async function saveHost() {
  if (submitting.value) return;
  submitting.value = true;
  try {
    const host = editingHost.value;
    const fields = {
      name: form.name.trim(),
      provider: form.provider,
      base_url: form.base_url.trim(),
      ...(form.admin_key && form.provider !== 'github' ? { admin_key: form.admin_key } : {}),
      ...(host && form.clear_admin_key ? { clear_admin_key: true } : {}),
    };
    const err = host
      ? await admin.updateGitHost(host, fields)
      : await admin.addGitHost(fields);
    if (!err && !admin.gitHostsErr) closeForm();
  } finally {
    submitting.value = false;
  }
}

async function confirmDelete() {
  const host = deletingHost.value;
  if (!host || submitting.value) return;
  submitting.value = true;
  try {
    await admin.removeGitHost(host);
    if (!admin.gitHostsErr) deletingHost.value = null;
  } finally {
    submitting.value = false;
  }
}

onMounted(() => {
  void admin.loadGitHosts();
});
</script>

<template>
  <section class="rounded-lg border border-black/10 bg-white">
    <div class="p-3">
      <h2 class="text-base font-semibold">{{ t('admin.repos.title') }}</h2>
      <p v-if="admin.gitHostsErr" class="syserr my-1" role="alert">{{ admin.gitHostsErr }}</p>

      <div data-test="git-host-list">
        <p v-if="!admin.gitHostsLoaded" class="muted">{{ t('common.loading') }}</p>
        <p v-else-if="admin.gitHosts.length === 0" class="muted">{{ t('admin.repos.empty') }}</p>

        <article
          v-for="host in admin.gitHosts"
          :key="host.id"
          data-test="git-host-card"
          class="mt-2 rounded-lg border border-black/15 px-3 py-2"
        >
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold">{{ host.name }}</span>
            <span data-test="provider-badge" class="rounded border border-sky-600 bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-700">{{ host.provider }}</span>
            <span
              data-test="mode-badge"
              class="rounded border px-1.5 py-0.5 text-xs font-medium"
              :class="host.mode === 'minted'
                ? 'border-green-600 bg-green-50 text-green-700'
                : 'border-amber-600 bg-amber-50 text-amber-800'"
            >{{ host.mode === 'minted' ? t('admin.repos.modeMinted') : t('admin.repos.modeCredential') }}</span>
            <span
              class="rounded border px-1.5 py-0.5 text-xs font-medium"
              :class="host.enabled ? 'border-green-600 bg-green-50 text-green-700' : 'border-black/30 bg-black/5 text-black/50'"
            >{{ host.enabled ? t('admin.enabled') : t('admin.disabled') }}</span>
            <span class="flex-1"></span>
            <button
              type="button"
              data-test="toggle-git-host"
              class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
              @click="admin.toggleGitHost(host)"
            >{{ host.enabled ? t('admin.disabled') : t('admin.enabled') }}</button>
            <button
              type="button"
              data-test="edit-git-host"
              class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
              @click="openEdit(host)"
            >{{ t('admin.edit') }}</button>
            <button
              type="button"
              data-test="delete-git-host"
              class="rounded-md border border-red-600/60 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50"
              @click="deletingHost = host"
            >{{ t('admin.delete') }}</button>
          </div>
          <p class="mt-1 break-all text-xs text-black/55">{{ host.base_url }}</p>
          <p v-if="host.admin_key_configured" data-test="admin-key-mask" class="mt-1 text-xs text-black/45">
            {{ t('admin.repos.adminKeyConfigured', { key: host.admin_key }) }}
          </p>
        </article>
      </div>

      <button
        type="button"
        data-test="open-add-git-host"
        class="mt-3 rounded-md bg-brand px-2.5 py-1 text-sm text-white hover:bg-brand-hover"
        @click="showAdd = true"
      >{{ t('admin.repos.add') }}</button>
    </div>
  </section>

  <ModalShell
    v-if="showAdd || editingHost"
    :label="editingHost ? t('admin.repos.editTitle') : t('admin.repos.addTitle')"
    dialog-class="max-h-[90vh] overflow-y-auto md:w-[32rem]"
    @close="closeForm"
  >
    <div class="flex items-center gap-2 border-b border-black/10 px-3 py-2">
      <h2 class="text-sm font-medium">{{ editingHost ? t('admin.repos.editTitle') : t('admin.repos.addTitle') }}</h2>
      <button type="button" :aria-label="t('common.close')" class="ml-auto rounded-md px-2 py-1 text-sm hover:bg-black/5" @click="closeForm">✕</button>
    </div>
    <form data-test="git-host-form" class="grid gap-3 px-3 py-3" @submit.prevent="saveHost">
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.repos.name') }}
        <input v-model="form.name" required maxlength="120" autocomplete="off" class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.repos.provider') }}
        <select v-model="form.provider" data-test="git-host-provider" class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm">
          <option value="gitea">Gitea</option>
          <option value="gitlab">GitLab</option>
          <option value="github">GitHub</option>
        </select>
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.repos.baseUrl') }}
        <input v-model="form.base_url" type="url" required placeholder="https://git.example.com" class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.repos.adminKey') }}
        <input
          v-model="form.admin_key"
          data-test="git-host-admin-key"
          type="password"
          autocomplete="new-password"
          :disabled="form.provider === 'github'"
          :placeholder="editingHost?.admin_key_configured ? t('admin.repos.adminKeyKeep') : t('admin.repos.adminKeyPlaceholder')"
          class="rounded-md border border-black/20 px-2 py-1 text-sm disabled:bg-black/5 disabled:text-black/40"
        >
      </label>
      <p v-if="form.provider === 'github'" data-test="git-host-github-hint" class="rounded-md border border-amber-500 bg-amber-50 px-2 py-1 text-xs text-amber-800">
        {{ t('admin.repos.githubHint') }}
      </p>
      <p v-if="editingHost?.admin_key_configured" class="text-xs text-black/45">
        {{ t('admin.repos.adminKeyConfigured', { key: editingHost.admin_key }) }}
      </p>
      <label v-if="editingHost?.admin_key_configured" class="flex items-center gap-2 text-xs text-black/55">
        <input v-model="form.clear_admin_key" type="checkbox" class="accent-brand">
        {{ t('admin.repos.clearAdminKey') }}
      </label>
      <p class="text-xs text-black/50">{{ t('admin.repos.modeAuto') }}</p>
      <p v-if="admin.gitHostsErr" class="syserr" role="alert">{{ admin.gitHostsErr }}</p>
      <div class="flex gap-2">
        <button type="submit" :disabled="submitting" class="flex-1 rounded-md bg-brand px-2.5 py-1 text-sm text-white hover:bg-brand-hover disabled:opacity-50">
          {{ editingHost ? t('admin.save') : t('admin.repos.add') }}
        </button>
        <button type="button" class="flex-1 rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5" @click="closeForm">{{ t('common.cancel') }}</button>
      </div>
    </form>
  </ModalShell>

  <ModalShell
    v-if="deletingHost"
    :label="t('admin.confirmDeleteTitle')"
    @close="deletingHost = null"
  >
    <div class="flex items-center gap-2 border-b border-black/10 px-3 py-2">
      <h2 class="text-sm font-medium">{{ t('admin.confirmDeleteTitle') }}</h2>
      <button type="button" :aria-label="t('common.close')" class="ml-auto rounded-md px-2 py-1 text-sm hover:bg-black/5" @click="deletingHost = null">✕</button>
    </div>
    <div class="p-3">
      <p>{{ t('admin.repos.confirmDelete', { name: deletingHost.name }) }}</p>
      <p v-if="admin.gitHostsErr" class="syserr mt-2" role="alert">{{ admin.gitHostsErr }}</p>
      <div class="mt-3 flex gap-2">
        <button
          type="button"
          data-test="confirm-delete-git-host"
          :disabled="submitting"
          class="flex-1 rounded-md bg-red-700 px-2.5 py-1 text-sm text-white hover:bg-red-800 disabled:opacity-50"
          @click="confirmDelete"
        >{{ t('admin.delete') }}</button>
        <button type="button" class="flex-1 rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5" @click="deletingHost = null">
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>
  </ModalShell>
</template>
