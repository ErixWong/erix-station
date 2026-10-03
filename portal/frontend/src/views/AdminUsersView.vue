<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ModalShell from '../components/ModalShell.vue';
import UserLlmPane from '../components/UserLlmPane.vue';
import { useAdminStore } from '../stores/admin';

const { t } = useI18n();
const admin = useAdminStore();
const showAddUser = ref(false);
const showTotp = ref(false);
const submitting = ref(false);
const userForm = reactive({ login: '', display_name: '', password: '', fde_name: '' });

function resetUserForm() {
  userForm.login = '';
  userForm.display_name = '';
  userForm.password = '';
  userForm.fde_name = '';
}

function closeAddUser() {
  showAddUser.value = false;
  resetUserForm();
}

async function onAddUser() {
  if (submitting.value) return;
  submitting.value = true;
  try {
    const err = await admin.addUser({
      login: userForm.login.trim(),
      display_name: userForm.display_name.trim(),
      password: userForm.password,
      ...(userForm.fde_name.trim() ? { fde_name: userForm.fde_name.trim() } : {}),
    });
    if (!err && admin.totpOnce) {
      closeAddUser();
      showTotp.value = true;
    }
  } finally {
    submitting.value = false;
  }
}

function closeTotp() {
  showTotp.value = false;
  admin.dismissTotpOnce();
}

onMounted(() => {
  void Promise.all([admin.loadUsers(), admin.loadProviders(), admin.loadGitHosts()]);
});

onBeforeUnmount(() => {
  if (admin.totpOnce) admin.dismissTotpOnce();
});
</script>

<template>
  <section class="rounded-lg border border-black/10 bg-white">
    <div class="p-3">
      <h2 class="text-base font-semibold">{{ t('admin.fde.sectionTitle') }}</h2>
      <p v-if="admin.fdeErr" class="syserr my-1" role="alert">{{ admin.fdeErr }}</p>

      <div data-test="user-list">
        <p v-if="!admin.usersLoaded" class="muted">{{ t('common.loading') }}</p>
        <p v-else-if="admin.users.length === 0" class="muted">{{ t('admin.fde.emptyUsers') }}</p>

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
            <span v-else class="muted">{{ t('admin.fde.noFdeName') }}</span>
            <span
              class="rounded border px-1.5 py-0.5 text-xs font-medium"
              :class="u.status === 'active' ? 'border-green-600 bg-green-50 text-green-700' : 'border-black/30 bg-black/5 text-black/50'"
            >{{ u.status }}</span>
            <span class="flex-1"></span>
            <button
              type="button"
              class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
              @click.stop="admin.toggleExpandedUser(String(u.id))"
            >{{ admin.expandedUsers.includes(String(u.id)) ? t('admin.collapse') : t('admin.expand') }}</button>
          </div>

          <div v-if="admin.expandedUsers.includes(String(u.id))" class="border-t border-dashed border-black/15 px-3 py-2">
            <p v-if="!u.fde_name" class="muted">{{ t('admin.fde.noFdeNameHint') }}</p>
            <UserLlmPane v-else :user="u" :providers="admin.providers" :git-hosts="admin.gitHosts" />
          </div>
        </div>
      </div>

      <button
        type="button"
        data-test="open-add-user"
        class="mt-3 rounded-md bg-brand px-2.5 py-1 text-sm text-white hover:bg-brand-hover"
        @click="showAddUser = true"
      >{{ t('admin.fde.addUser') }}</button>
    </div>
  </section>

  <ModalShell
    v-if="showAddUser"
    :label="t('admin.fde.addUserTitle')"
    @close="closeAddUser"
  >
    <div class="flex items-center gap-2 border-b border-black/10 px-3 py-2">
      <h2 class="text-sm font-medium">{{ t('admin.fde.addUserTitle') }}</h2>
      <button
        type="button"
        :aria-label="t('common.close')"
        class="ml-auto shrink-0 rounded-md px-2 py-1 text-sm hover:bg-black/5"
        @click="closeAddUser"
      >✕</button>
    </div>
    <form data-test="add-user-form" class="grid gap-3 px-3 py-3" @submit.prevent="onAddUser">
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.fde.loginLabel') }}
        <input v-model="userForm.login" required autocomplete="off" class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.fde.displayNameLabel') }}
        <input v-model="userForm.display_name" autocomplete="off" class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.fde.passwordLabel') }}
        <input v-model="userForm.password" type="password" required autocomplete="new-password" class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.fde.fdeNameLabel') }}
        <input v-model="userForm.fde_name" placeholder="alice" autocomplete="off" class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <p v-if="admin.fdeErr" class="syserr" role="alert">{{ admin.fdeErr }}</p>
      <div class="flex gap-2">
        <button
          type="submit"
          :disabled="submitting"
          class="flex-1 rounded-md bg-brand px-2.5 py-1 text-sm text-white hover:bg-brand-hover disabled:opacity-50"
        >{{ t('admin.fde.addUser') }}</button>
        <button
          type="button"
          class="flex-1 rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5"
          @click="closeAddUser"
        >{{ t('common.cancel') }}</button>
      </div>
    </form>
  </ModalShell>

  <ModalShell
    v-if="showTotp && admin.totpOnce"
    :label="t('admin.fde.totpTitle')"
    dialog-class="max-h-[90vh] overflow-y-auto md:w-[32rem]"
    @close="closeTotp"
  >
    <div class="flex items-center gap-2 border-b border-black/10 px-3 py-2">
      <h2 class="text-sm font-medium">{{ t('admin.fde.totpTitle') }}</h2>
      <button
        type="button"
        :aria-label="t('common.close')"
        class="ml-auto shrink-0 rounded-md px-2 py-1 text-sm hover:bg-black/5"
        @click="closeTotp"
      >✕</button>
    </div>
    <div data-test="totp-box" class="p-3 text-[0.85rem]">
      <img :src="admin.totpOnce.qr" :alt="t('admin.fde.qrAlt')" class="my-2 block h-48 w-48" style="image-rendering: pixelated">
      <i18n-t keypath="admin.fde.totpCreated" tag="div" scope="global">
        <template #login><b>{{ admin.totpOnce.login }}</b></template>
        <template #onlyOnce><b>{{ t('admin.fde.totpOnlyOnce') }}</b></template>
      </i18n-t>
      <div>{{ t('admin.fde.otpauthUri') }}<code class="break-all select-all">{{ admin.totpOnce.uri }}</code></div>
      <div>{{ t('admin.fde.totpSecret') }}<code class="break-all select-all">{{ admin.totpOnce.secret }}</code></div>
      <div>{{ t('admin.fde.nextStep') }}</div>
      <button
        type="button"
        class="mt-3 rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5"
        @click="closeTotp"
      >{{ t('common.close') }}</button>
    </div>
  </ModalShell>
</template>
