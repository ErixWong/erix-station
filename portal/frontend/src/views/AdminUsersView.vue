<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ModalShell from '../components/ModalShell.vue';
import UserLlmPane from '../components/UserLlmPane.vue';
import { useAdminStore, type AdminUser, type LlmModel, type LlmProvider } from '../stores/admin';
import { useAuthStore } from '../stores/auth';

const { t, locale } = useI18n();
const admin = useAdminStore();
const auth = useAuthStore();
const searchTerm = ref('');
const rowErrors = reactive<Record<string, string>>({});
const rowMessages = reactive<Record<string, string>>({});
const busyUserId = ref<string | null>(null);
const showAddUser = ref(false);
const showTotp = ref(false);
const resumeEditAfterTotp = ref(false);
const submitting = ref(false);
const userForm = reactive({
  login: '', display_name: '', password: '', email: '', fde_name: '', git_host_id: '', totpEnabled: false,
  llm: { provider_id: '', main_model_id: '', embedding_model_id: '', vision_model_id: '' },
});

const editUserId = ref<string | null>(null);
const editModalOpen = ref(false);
type EditTab = 'profile' | 'security' | 'llm' | 'danger';
const editTab = ref<EditTab>('profile');
const deleteUserId = ref<string | null>(null);
const returnToEditAfterDelete = ref(false);
const editForm = reactive({ display_name: '', role: 'fde' as AdminUser['role'], fde_name: '' });
const resetPasswordValue = ref('');
const deleteConfirmation = ref('');
const copiedTotpValue = ref('');
const totpCopyError = ref('');
const profileBusy = ref(false);
const passwordBusy = ref(false);
const totpBusy = ref(false);
const deleteBusy = ref(false);
const profileError = ref('');
const profileMessage = ref('');
const onboardingBusyId = ref<string | null>(null);
const offboardingBusyId = ref<string | null>(null);
const passwordError = ref('');
const passwordMessage = ref('');
const totpError = ref('');
const totpMessage = ref('');
const deleteError = ref('');

const editUser = computed(() =>
  admin.users.find((user) => user.id === editUserId.value) ?? null,
);
const deleteUser = computed(() =>
  admin.users.find((user) => user.id === deleteUserId.value) ?? null,
);
const filteredUsers = computed(() => {
  const query = searchTerm.value.trim().toLocaleLowerCase(locale.value);
  if (!query) return admin.users;
  return admin.users.filter((user) =>
    [user.login, user.display_name ?? '', user.fde_name ?? '']
      .some((value) => value.toLocaleLowerCase(locale.value).includes(query)),
  );
});
const deleteMatchesLogin = computed(() =>
  Boolean(deleteUser.value && deleteConfirmation.value === deleteUser.value.login),
);
const onboardableGitHosts = computed(() =>
  admin.gitHosts.filter((host) => host.enabled && host.provider !== 'azure'),
);
const isEnabledModel = (model: LlmModel) => model.enabled;
const onboardableLlmProviders = computed<LlmProvider[]>(() =>
  admin.providers.filter((provider) =>
    provider.models.some((model) => isEnabledModel(model) && model.type === 'text' && model.tool_calling)),
);
const selectedNewLlmProvider = computed(() =>
  onboardableLlmProviders.value.find((provider) => provider.id === userForm.llm.provider_id) ?? null,
);
const newMainModelOptions = computed(() =>
  (selectedNewLlmProvider.value?.models ?? [])
    .filter((model) => isEnabledModel(model) && model.type === 'text' && model.tool_calling),
);
const newEmbeddingModelOptions = computed(() =>
  (selectedNewLlmProvider.value?.models ?? []).filter((model) => isEnabledModel(model) && model.type === 'embedding'),
);
const newVisionModelOptions = computed(() =>
  (selectedNewLlmProvider.value?.models ?? []).filter((model) => isEnabledModel(model) && model.type === 'vision'),
);
const addUserLlmValid = computed(() =>
  admin.providersLoaded
  && !admin.llmErr
  && newMainModelOptions.value.some((model) => model.id === userForm.llm.main_model_id),
);
const canSubmitAddUser = computed(() =>
  !submitting.value
  && admin.gitHostsLoaded
  && onboardableGitHosts.value.some((host) => host.id === userForm.git_host_id)
  && addUserLlmValid.value
  && userForm.login.trim() !== ''
  && userForm.password !== ''
  && userForm.email.trim() !== ''
  && userForm.fde_name.trim() !== '',
);

watch(() => userForm.llm.provider_id, () => {
  userForm.llm.main_model_id = '';
  userForm.llm.embedding_model_id = '';
  userForm.llm.vision_model_id = '';
});

function resetUserForm() {
  userForm.login = '';
  userForm.display_name = '';
  userForm.password = '';
  userForm.email = '';
  userForm.fde_name = '';
  userForm.git_host_id = '';
  userForm.totpEnabled = false;
  userForm.llm.provider_id = '';
  userForm.llm.main_model_id = '';
  userForm.llm.embedding_model_id = '';
  userForm.llm.vision_model_id = '';
}

function closeAddUser() {
  showAddUser.value = false;
  resetUserForm();
}

function randomIndex(max: number): number {
  const value = new Uint32Array(1);
  window.crypto.getRandomValues(value);
  return (value[0] ?? 0) % max;
}

function generatePassword(): string {
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const alphabet = `${lower}${upper}${digits}`;
  const chars = [
    lower[randomIndex(lower.length)] ?? 'a',
    upper[randomIndex(upper.length)] ?? 'A',
    digits[randomIndex(digits.length)] ?? '0',
    ...Array.from({ length: 13 }, () => alphabet[randomIndex(alphabet.length)] ?? 'a'),
  ];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    const current = chars[i] ?? '';
    chars[i] = chars[j] ?? '';
    chars[j] = current;
  }
  return chars.join('');
}

function fillRandomPassword() {
  userForm.password = generatePassword();
}

async function onAddUser() {
  if (!canSubmitAddUser.value) return;
  submitting.value = true;
  try {
    const err = await admin.addUser({
      login: userForm.login.trim(),
      display_name: userForm.display_name.trim(),
      password: userForm.password,
      email: userForm.email.trim(),
      fde_name: userForm.fde_name.trim(),
      git_host_id: userForm.git_host_id,
      llm: {
        provider_id: userForm.llm.provider_id,
        main_model_id: userForm.llm.main_model_id,
        embedding_model_id: userForm.llm.embedding_model_id || null,
        vision_model_id: userForm.llm.vision_model_id || null,
      },
      totpEnabled: userForm.totpEnabled,
    });
    if (!err) {
      closeAddUser();
      if (admin.totpOnce) showTotp.value = true;
    }
  } finally {
    submitting.value = false;
  }
}

async function retryOnboarding(user: AdminUser) {
  if (onboardingBusyId.value) return;
  clearFeedback(user.id);
  onboardingBusyId.value = user.id;
  try {
    const error = await admin.retryOnboarding(user.id);
    if (error) {
      rowErrors[user.id] = error;
      if (editUserId.value === user.id) profileError.value = error;
    } else {
      rowMessages[user.id] = t('admin.fde.onboardingRetryQueued');
      if (editUserId.value === user.id) profileMessage.value = rowMessages[user.id];
    }
  } finally {
    onboardingBusyId.value = null;
  }
}

async function retryOffboarding(user: AdminUser) {
  if (offboardingBusyId.value) return;
  clearFeedback(user.id);
  offboardingBusyId.value = user.id;
  try {
    const error = await admin.retryOffboarding(user.id);
    if (error) {
      rowErrors[user.id] = error;
      if (editUserId.value === user.id) profileError.value = error;
    } else {
      rowMessages[user.id] = t('admin.fde.offboardingRetryQueued');
      if (editUserId.value === user.id) profileMessage.value = rowMessages[user.id];
    }
  } finally {
    offboardingBusyId.value = null;
  }
}

function closeTotp() {
  showTotp.value = false;
  admin.dismissTotpOnce();
  copiedTotpValue.value = '';
  totpCopyError.value = '';
  if (resumeEditAfterTotp.value && editUserId.value) {
    editTab.value = 'security';
    void nextTick(() => {
      editModalOpen.value = true;
    });
  }
  resumeEditAfterTotp.value = false;
}

function ignoreTotpDismiss() {
  // The one-time secret stays visible until the administrator confirms it was saved.
}

async function copyTotpValue(key: string, value: string) {
  try {
    await navigator.clipboard.writeText(value);
    copiedTotpValue.value = key;
    totpCopyError.value = '';
  } catch (error) {
    totpCopyError.value = t('admin.fde.copyFailed') + (error instanceof Error ? error.message : String(error));
  }
}

function isCurrentUser(user: AdminUser): boolean {
  return auth.user?.id === user.id || auth.user?.login === user.login;
}

function clearFeedback(id: string) {
  delete rowErrors[id];
  delete rowMessages[id];
}

async function toggleStatus(user: AdminUser) {
  if (busyUserId.value) return;
  clearFeedback(user.id);
  busyUserId.value = user.id;
  try {
    const error = await admin.updateUser(user.id, {
      status: user.status === 'disabled' ? 'active' : 'disabled',
    });
    if (error) rowErrors[user.id] = error;
    else rowMessages[user.id] = t('admin.fde.statusUpdated');
  } finally {
    busyUserId.value = null;
  }
}

function clearSectionFeedback() {
  profileError.value = '';
  profileMessage.value = '';
  passwordError.value = '';
  passwordMessage.value = '';
  totpError.value = '';
  totpMessage.value = '';
}

function openEditModal(user: AdminUser) {
  clearFeedback(user.id);
  editUserId.value = user.id;
  editTab.value = 'profile';
  editModalOpen.value = true;
  editForm.display_name = user.display_name ?? '';
  editForm.role = user.role;
  editForm.fde_name = user.fde_name ?? '';
  resetPasswordValue.value = '';
  clearSectionFeedback();
}

function closeEditModal() {
  editModalOpen.value = false;
  editUserId.value = null;
  editTab.value = 'profile';
}

function openDeleteModal(user: AdminUser) {
  clearFeedback(user.id);
  deleteUserId.value = null;
  deleteConfirmation.value = '';
  deleteError.value = '';
  returnToEditAfterDelete.value = editModalOpen.value && editUserId.value === user.id;
  if (returnToEditAfterDelete.value) {
    editTab.value = 'danger';
    editModalOpen.value = false;
    void nextTick(() => {
      deleteUserId.value = user.id;
    });
  } else {
    deleteUserId.value = user.id;
  }
}

function closeDeleteModal() {
  const shouldReturnToEdit = returnToEditAfterDelete.value;
  deleteUserId.value = null;
  deleteError.value = '';
  deleteBusy.value = false;
  returnToEditAfterDelete.value = false;
  if (shouldReturnToEdit && editUserId.value) {
    void nextTick(() => {
      editModalOpen.value = true;
    });
  }
}

function setSectionError(user: AdminUser, error: string, target: 'profile' | 'password' | 'totp') {
  if (target === 'profile') profileError.value = error;
  else if (target === 'password') passwordError.value = error;
  else totpError.value = error;
  rowErrors[user.id] = error;
}

async function saveProfile() {
  const user = editUser.value;
  if (!user || profileBusy.value) return;
  profileBusy.value = true;
  profileError.value = '';
  profileMessage.value = '';
  try {
    const error = await admin.updateUser(user.id, {
      display_name: editForm.display_name.trim(),
      role: editForm.role,
      fde_name: editForm.fde_name.trim() || null,
    });
    if (error) setSectionError(user, error, 'profile');
    else {
      profileMessage.value = t('admin.fde.profileUpdated');
      delete rowErrors[user.id];
      rowMessages[user.id] = profileMessage.value;
    }
  } finally {
    profileBusy.value = false;
  }
}

async function submitPasswordReset() {
  const user = editUser.value;
  if (!user || passwordBusy.value) return;
  passwordBusy.value = true;
  passwordError.value = '';
  passwordMessage.value = '';
  try {
    const error = await admin.resetPassword(user.id, resetPasswordValue.value);
    if (error) setSectionError(user, error, 'password');
    else {
      passwordMessage.value = t('admin.fde.passwordResetDone');
      resetPasswordValue.value = '';
      delete rowErrors[user.id];
      rowMessages[user.id] = passwordMessage.value;
    }
  } finally {
    passwordBusy.value = false;
  }
}

async function confirmTotpReset() {
  const user = editUser.value;
  if (!user || totpBusy.value) return;
  totpBusy.value = true;
  totpError.value = '';
  totpMessage.value = '';
  try {
    const error = await admin.resetTotp(user.id);
    if (error) setSectionError(user, error, 'totp');
    else {
      totpMessage.value = t('admin.fde.totpResetDone');
      delete rowErrors[user.id];
      rowMessages[user.id] = totpMessage.value;
    }
  } finally {
    totpBusy.value = false;
  }
}

async function confirmTotpEnroll() {
  const user = editUser.value;
  if (!user || totpBusy.value) return;
  totpBusy.value = true;
  totpError.value = '';
  totpMessage.value = '';
  try {
    const error = await admin.enrollTotp(user.id);
    if (error) setSectionError(user, error, 'totp');
    else {
      totpMessage.value = t('admin.fde.totpEnrollDone');
      delete rowErrors[user.id];
      rowMessages[user.id] = totpMessage.value;
      editModalOpen.value = false;
      resumeEditAfterTotp.value = true;
      void nextTick(() => {
        showTotp.value = true;
      });
    }
  } finally {
    totpBusy.value = false;
  }
}

async function confirmUserDelete() {
  const user = deleteUser.value;
  if (!user || !deleteMatchesLogin.value || isCurrentUser(user) || deleteBusy.value) return;
  deleteBusy.value = true;
  deleteError.value = '';
  try {
    const error = await admin.deleteUser(user.id);
    if (error) {
      deleteError.value = error;
      rowErrors[user.id] = error;
    } else {
      delete rowErrors[user.id];
      if (admin.users.some((entry) => entry.id === user.id && entry.offboarding)) {
        rowMessages[user.id] = t('admin.fde.offboardingQueued');
      } else {
        delete rowMessages[user.id];
      }
      if (editUserId.value === user.id) closeEditModal();
      deleteUserId.value = null;
      returnToEditAfterDelete.value = false;
    }
  } finally {
    deleteBusy.value = false;
  }
}

function formatLastLogin(value: string | null): string {
  if (!value) return t('admin.fde.neverLoggedIn');
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? value : new Date(timestamp).toLocaleString(locale.value);
}

onMounted(() => {
  void Promise.all([admin.loadUsers(), admin.loadProviders(), admin.loadGitHosts()]);
});

let lifecyclePoll: ReturnType<typeof setInterval> | null = null;
watch(
  () => admin.users.some((user) =>
    user.onboarding?.state === 'pending' || user.onboarding?.state === 'running'
    || user.offboarding?.state === 'pending' || user.offboarding?.state === 'running'),
  (active) => {
    if (active && lifecyclePoll === null) {
      lifecyclePoll = setInterval(() => {
        if (!admin.usersLoading) void admin.loadUsers();
      }, 3000);
    } else if (!active && lifecyclePoll !== null) {
      clearInterval(lifecyclePoll);
      lifecyclePoll = null;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (lifecyclePoll !== null) clearInterval(lifecyclePoll);
  lifecyclePoll = null;
  if (admin.totpOnce) admin.dismissTotpOnce();
});
</script>

<template>
  <section class="mx-auto w-full max-w-5xl">
    <header class="mb-3 flex flex-wrap items-center gap-3">
      <h2 class="text-base font-semibold">{{ t('admin.fde.sectionTitle') }}</h2>
      <div class="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto">
        <label class="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
          <span class="sr-only">{{ t('admin.fde.searchPlaceholder') }}</span>
          <span aria-hidden="true" class="absolute left-2 top-1/2 -translate-y-1/2 text-black/45">🔍</span>
          <input
            v-model="searchTerm"
            data-test="user-search"
            type="search"
            class="w-full rounded-md border border-black/20 py-1.5 pl-8 pr-2 text-sm"
            :placeholder="t('admin.fde.searchPlaceholder')"
          >
        </label>
        <button
          type="button"
          data-test="open-add-user"
          class="shrink-0 rounded-md bg-brand px-2.5 py-1.5 text-sm text-white hover:bg-brand-hover"
          @click="showAddUser = true"
        >{{ t('admin.fde.createUser') }}</button>
      </div>
    </header>

    <p v-if="admin.fdeErr" class="syserr mb-2 flex flex-wrap items-center gap-2" role="alert">
      <span>{{ admin.fdeErr }}</span>
      <button
        type="button"
        data-test="retry-users"
        class="rounded border border-current px-2 py-0.5 text-xs hover:bg-black/5"
        @click="admin.loadUsers()"
      >{{ t('common.retry') }}</button>
    </p>

    <div data-test="user-list" class="rounded-lg border border-black/10 bg-white">
      <div
        v-if="!admin.usersLoaded && admin.usersLoading"
        data-test="user-skeleton"
        :aria-label="t('admin.fde.loadingUsers')"
      >
        <div v-for="n in 3" :key="n" class="flex h-12 items-center gap-4 border-b border-black/10 px-4 last:border-b-0">
          <span class="h-3 w-24 animate-pulse rounded bg-black/10"></span>
          <span class="h-3 w-32 animate-pulse rounded bg-black/10"></span>
          <span class="h-3 w-14 animate-pulse rounded bg-black/10"></span>
          <span class="h-3 w-20 animate-pulse rounded bg-black/10"></span>
          <span class="h-3 w-16 animate-pulse rounded bg-black/10"></span>
        </div>
      </div>

      <div v-else-if="admin.usersLoaded && admin.users.length === 0" class="px-4 py-10 text-center">
        <p class="muted">{{ t('admin.fde.emptyUsers') }}</p>
        <button
          type="button"
          class="mt-3 rounded-md bg-brand px-3 py-1.5 text-sm text-white hover:bg-brand-hover"
          @click="showAddUser = true"
        >{{ t('admin.fde.createUser') }}</button>
      </div>

      <div v-else-if="admin.usersLoaded && filteredUsers.length === 0" class="px-4 py-8 text-center muted">
        {{ t('admin.fde.searchEmpty') }}
      </div>

      <table v-else-if="admin.usersLoaded" data-test="user-table" class="w-full table-fixed text-left text-sm">
          <colgroup>
            <col class="w-[11%]">
            <col class="w-[15%]">
            <col class="w-[8%]">
            <col class="w-[12%]">
            <col class="w-[5%]">
            <col class="w-[8%]">
            <col class="w-[13%]">
            <col class="w-[15%]">
            <col class="w-[13%]">
          </colgroup>
          <thead class="border-b border-black/10 bg-black/[0.025] text-xs text-black/55">
            <tr>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('admin.fde.colLogin') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('admin.fde.colDisplayName') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('admin.fde.colRole') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('admin.fde.colFde') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('admin.fde.colMfa') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('admin.fde.colStatus') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('admin.fde.colLifecycle') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('admin.fde.lastLogin') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('admin.fde.colActions') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="user in filteredUsers" :key="user.id">
              <tr data-test="user-row" class="border-b border-black/10">
                <td class="truncate px-3 py-2.5 font-medium" :title="user.login">{{ user.login }}</td>
                <td class="truncate px-3 py-2.5 text-black/65" :title="user.display_name ?? user.login">
                  {{ user.display_name || user.login }}
                </td>
                <td class="px-3 py-2.5">
                  <span class="inline-flex rounded-full border border-black/20 px-2 py-0.5 text-xs text-black/70">
                    {{ user.role === 'admin' ? t('admin.fde.roleAdmin') : t('admin.fde.roleFde') }}
                  </span>
                </td>
                <td class="truncate px-3 py-2.5">
                  <span v-if="user.fde_name" class="max-w-full truncate">{{ user.fde_name }}</span>
                  <span v-else class="text-black/35">—</span>
                </td>
                <td class="px-3 py-2.5">
                  <span :aria-label="user.totp_enabled ? t('admin.fde.mfaEnabled') : t('admin.fde.mfaDisabled')">
                    {{ user.totp_enabled ? '✓' : '—' }}
                  </span>
                </td>
                <td class="px-3 py-2.5">
                  <span v-if="user.status === 'active'" class="inline-flex items-center gap-1.5 text-green-700">
                    <span aria-hidden="true">●</span>{{ t('admin.fde.statusActive') }}
                  </span>
                  <span v-else-if="user.status === 'disabled'" class="inline-flex items-center gap-1.5 text-black/50">
                    <span aria-hidden="true">○</span>{{ t('admin.fde.statusDisabled') }}
                  </span>
                  <span v-else class="inline-flex items-center gap-1.5 text-black/50">
                    <span aria-hidden="true">○</span>{{ t('admin.fde.statusAwaitingCredential') }}
                  </span>
                </td>
                <td class="px-2 py-2.5">
                  <div v-if="user.onboarding" class="mb-1">
                    <span
                      data-test="onboarding-status"
                      :title="user.onboarding.llm_binding?.state === 'failed'
                        ? user.onboarding.llm_binding.error ?? ''
                        : user.onboarding.state === 'failed' ? user.onboarding.error ?? '' : undefined"
                      :class="user.onboarding.state === 'failed' || user.onboarding.llm_binding?.state === 'failed'
                        ? 'text-red-700' : 'text-black/65'"
                    >
                      {{ t(`admin.fde.onboarding.${user.onboarding.state}`) }}
                      <span v-if="user.onboarding.llm_binding?.state === 'failed'"> · {{ t('admin.fde.llmBindingFailed') }}</span>
                    </span>
                    <button
                      v-if="!user.offboarding && (user.onboarding?.state === 'failed' || user.onboarding?.llm_binding?.state === 'failed')"
                      type="button"
                      data-test="retry-onboarding"
                      class="ml-1 rounded border border-black/15 px-1 py-0.5 text-xs hover:bg-black/5 disabled:opacity-50"
                      :disabled="onboardingBusyId !== null"
                      @click.stop="retryOnboarding(user)"
                    >{{ t('admin.fde.retryOnboarding') }}</button>
                  </div>
                  <div
                    v-if="user.offboarding"
                    data-test="offboarding-status"
                    :title="user.offboarding.error ?? undefined"
                    :class="user.offboarding.state === 'failed' ? 'text-red-700' : 'text-black/65'"
                  >
                    {{ t(`admin.fde.offboarding.${user.offboarding.state}`) }}
                    <span v-if="user.offboarding.step"> · {{ t(`admin.fde.offboardingSteps.${user.offboarding.step}`) }}</span>
                    <span v-if="user.offboarding.workspace_purge_after">
                      · {{ t('admin.fde.workspacePurgeAfter', { date: formatLastLogin(user.offboarding.workspace_purge_after) }) }}
                    </span>
                    <button
                      v-if="user.offboarding.state === 'failed'"
                      type="button"
                      data-test="retry-offboarding"
                      class="ml-1 rounded border border-black/15 px-1 py-0.5 text-xs hover:bg-black/5 disabled:opacity-50"
                      :disabled="offboardingBusyId !== null"
                      @click.stop="retryOffboarding(user)"
                    >{{ t('admin.fde.retryOffboarding') }}</button>
                  </div>
                  <span v-if="!user.onboarding && !user.offboarding" class="text-black/35">—</span>
                </td>
                <td class="truncate px-3 py-2.5" :title="formatLastLogin(user.last_login_at)">
                  {{ formatLastLogin(user.last_login_at) }}
                </td>
                <td class="px-2 py-2">
                  <div class="flex flex-wrap items-center justify-end gap-1">
                    <button
                      v-if="!user.offboarding"
                      type="button"
                      class="rounded-md border border-black/15 px-2 py-1 text-xs hover:bg-black/5 disabled:opacity-50"
                      :disabled="busyUserId !== null"
                      :aria-label="user.status === 'disabled' ? t('admin.fde.enableUser') : t('admin.fde.disableUser')"
                      @click.stop="toggleStatus(user)"
                    >{{ user.status === 'disabled' ? t('admin.fde.enableUser') : t('admin.fde.disableUser') }}</button>
                    <button
                      type="button"
                      data-test="edit-user"
                      class="rounded-md border border-black/15 px-2 py-1 text-xs hover:bg-black/5"
                      @click.stop="openEditModal(user)"
                    >{{ t('admin.fde.editAction') }}</button>
                  </div>
                </td>
              </tr>
              <tr v-if="rowErrors[user.id] || rowMessages[user.id]" class="border-b border-black/10">
                <td colspan="9" class="px-3 py-1.5 text-xs">
                  <p v-if="rowErrors[user.id]" class="syserr" role="alert">{{ rowErrors[user.id] }}</p>
                  <p v-else class="text-green-700" role="status">{{ rowMessages[user.id] }}</p>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
    </div>
  </section>

  <ModalShell v-if="showAddUser" :label="t('admin.fde.addUserTitle')" @close="closeAddUser">
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
      <div class="flex flex-col gap-1 text-xs text-black/55">
        <label for="new-user-password">{{ t('admin.fde.passwordLabel') }}</label>
        <div class="flex gap-2">
          <input
            id="new-user-password"
            v-model="userForm.password"
            type="text"
            required
            autocomplete="new-password"
            :placeholder="t('admin.fde.createPasswordPlaceholder')"
            class="min-w-0 flex-1 rounded-md border border-black/20 px-2 py-1 text-sm text-black"
          >
          <button
            type="button"
            data-test="generate-password"
            class="shrink-0 rounded-md border border-black/20 px-2 py-1 text-sm text-black hover:bg-black/5"
            @click="fillRandomPassword"
          >{{ t('admin.fde.randomPassword') }}</button>
        </div>
      </div>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.fde.emailLabel') }}
        <input v-model="userForm.email" data-test="user-email" type="email" required autocomplete="email" class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.fde.fdeNameLabel') }}
        <input v-model="userForm.fde_name" data-test="user-fde-name" required placeholder="alice" autocomplete="off" class="rounded-md border border-black/20 px-2 py-1 text-sm">
      </label>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.fde.gitHostLabel') }}
        <select v-model="userForm.git_host_id" data-test="new-user-git-host" required class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm">
          <option disabled value="">{{ t('admin.fde.selectGitHost') }}</option>
          <option v-for="host in onboardableGitHosts" :key="host.id" :value="host.id">{{ host.name }} ({{ host.provider }})</option>
        </select>
        <span v-if="admin.gitHostsLoaded && onboardableGitHosts.length === 0" class="text-amber-800">{{ t('admin.fde.noOnboardableGitHosts') }}</span>
      </label>
      <section class="grid gap-2 rounded-md border border-black/10 p-2" data-test="new-user-llm">
        <h3 class="text-xs font-medium text-black/70">{{ t('admin.fde.llmModelSection') }}</h3>
        <p v-if="admin.llmErr" class="syserr" role="alert">
          {{ t('admin.fde.llmCatalogError', { error: admin.llmErr }) }}
          <button type="button" class="ml-1 underline" @click="admin.loadProviders()">
            {{ t('admin.fde.retryLlmCatalog') }}
          </button>
        </p>
        <p v-else-if="!admin.providersLoaded" class="text-xs text-black/55" role="status">
          {{ t('admin.fde.loadingLlmCatalog') }}
        </p>
        <p v-else-if="onboardableLlmProviders.length === 0" class="text-xs text-amber-800" role="alert">
          {{ t('admin.fde.noOnboardableLlmModels') }}
        </p>
        <label class="flex flex-col gap-1 text-xs text-black/55">
          {{ t('admin.fde.llmProviderLabel') }}
          <select
            v-model="userForm.llm.provider_id"
            data-test="new-user-llm-provider"
            required
            :disabled="!admin.providersLoaded || Boolean(admin.llmErr) || onboardableLlmProviders.length === 0"
            class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
          >
            <option disabled value="">{{ t('admin.fde.selectLlmProvider') }}</option>
            <option v-for="provider in onboardableLlmProviders" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-black/55">
          {{ t('admin.fde.llmMainModelLabel') }}
          <select
            v-model="userForm.llm.main_model_id"
            data-test="new-user-main-model"
            required
            :disabled="!selectedNewLlmProvider || Boolean(admin.llmErr)"
            class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
          >
            <option disabled value="">{{ t('admin.fde.selectLlmMainModel') }}</option>
            <option v-for="model in newMainModelOptions" :key="model.id" :value="model.id">
              {{ model.model_id }} — {{ model.name }}
            </option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-black/55">
          {{ t('admin.fde.llmEmbeddingModelLabel') }}
          <select
            v-model="userForm.llm.embedding_model_id"
            data-test="new-user-embedding-model"
            :disabled="!selectedNewLlmProvider || Boolean(admin.llmErr)"
            class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
          >
            <option value="">{{ t('admin.fde.llmModelNotConfigured') }}</option>
            <option v-for="model in newEmbeddingModelOptions" :key="model.id" :value="model.id">
              {{ model.model_id }} — {{ model.name }}
            </option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-black/55">
          {{ t('admin.fde.llmVisionModelLabel') }}
          <select
            v-model="userForm.llm.vision_model_id"
            data-test="new-user-vision-model"
            :disabled="!selectedNewLlmProvider || Boolean(admin.llmErr)"
            class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
          >
            <option value="">{{ t('admin.fde.llmModelNotConfigured') }}</option>
            <option v-for="model in newVisionModelOptions" :key="model.id" :value="model.id">
              {{ model.model_id }} — {{ model.name }}
            </option>
          </select>
        </label>
      </section>
      <div class="flex flex-col gap-1 text-xs text-black/55">
        <label class="flex items-center gap-2">
          <input
            v-model="userForm.totpEnabled"
            data-test="user-totp-enabled"
            type="checkbox"
            class="rounded border-black/20"
          >
          {{ t('admin.fde.totpEnabledOpt') }}
        </label>
        <p>{{ t('admin.fde.totpEnabledHint') }}</p>
      </div>
      <p v-if="admin.fdeErr" class="syserr" role="alert">{{ admin.fdeErr }}</p>
      <div class="flex gap-2">
        <button
          type="submit"
          :disabled="!canSubmitAddUser"
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
    :label="admin.totpOnce.purpose === 'enrolled' ? t('admin.fde.totpEnrollTitle') : t('admin.fde.totpTitle')"
    dialog-class="max-h-[90vh] overflow-y-auto md:w-[32rem]"
    @close="ignoreTotpDismiss"
  >
    <div class="flex items-center gap-2 border-b border-black/10 px-3 py-2">
      <h2 class="text-sm font-medium">
        {{ admin.totpOnce.purpose === 'enrolled' ? t('admin.fde.totpEnrollTitle') : t('admin.fde.totpTitle') }}
      </h2>
    </div>
    <div data-test="totp-box" class="grid gap-3 p-3 text-[0.85rem]">
      <img :src="admin.totpOnce.qr" :alt="t('admin.fde.qrAlt')" class="my-1 block h-48 w-48" style="image-rendering: pixelated">
      <i18n-t v-if="admin.totpOnce.purpose === 'created'" keypath="admin.fde.totpCreated" tag="div" scope="global">
        <template #login><b>{{ admin.totpOnce.login }}</b></template>
        <template #onlyOnce><b>{{ t('admin.fde.totpOnlyOnce') }}</b></template>
      </i18n-t>
      <i18n-t v-else keypath="admin.fde.totpEnrolled" tag="div" scope="global">
        <template #login><b>{{ admin.totpOnce.login }}</b></template>
        <template #onlyOnce><b>{{ t('admin.fde.totpOnlyOnce') }}</b></template>
      </i18n-t>
      <div>
        <div class="mb-1">{{ t('admin.fde.otpauthUri') }}</div>
        <div class="flex items-start gap-2">
          <code class="min-w-0 flex-1 break-all select-all">{{ admin.totpOnce.uri }}</code>
          <button
            type="button"
            data-test="copy-totp-uri"
            class="shrink-0 rounded border border-black/20 px-2 py-1 text-xs hover:bg-black/5"
            @click="copyTotpValue('uri', admin.totpOnce.uri)"
          >{{ copiedTotpValue === 'uri' ? t('common.copied') : t('common.copy') }}</button>
        </div>
      </div>
      <div>
        <div class="mb-1">{{ t('admin.fde.totpSecret') }}</div>
        <div class="flex items-start gap-2">
          <code class="min-w-0 flex-1 break-all select-all">{{ admin.totpOnce.secret }}</code>
          <button
            type="button"
            data-test="copy-totp-secret"
            class="shrink-0 rounded border border-black/20 px-2 py-1 text-xs hover:bg-black/5"
            @click="copyTotpValue('secret', admin.totpOnce.secret)"
          >{{ copiedTotpValue === 'secret' ? t('common.copied') : t('common.copy') }}</button>
        </div>
      </div>
      <p v-if="totpCopyError" class="syserr" role="alert">{{ totpCopyError }}</p>
      <p>{{ t('admin.fde.nextStep') }}</p>
      <p v-if="copiedTotpValue" class="text-sm text-green-700" role="status">{{ t('admin.fde.copiedFeedback') }}</p>
      <button
        type="button"
        data-test="totp-saved"
        class="w-full rounded-md bg-brand px-2.5 py-2 text-sm text-white hover:bg-brand-hover"
        @click="closeTotp"
      >{{ t('admin.fde.totpSaved') }}</button>
    </div>
  </ModalShell>

  <ModalShell
    v-if="editModalOpen && editUser"
    data-test="user-edit-modal"
    :label="t('admin.fde.editUserTitle')"
    dialog-class="flex max-h-[90vh] flex-col overflow-y-auto md:w-[40rem]"
    @close="closeEditModal"
  >
    <header class="flex shrink-0 items-center gap-3 border-b border-black/10 px-3 py-2">
      <div class="min-w-0">
        <h2 class="truncate text-sm font-medium">{{ t('admin.fde.editUserTitle') }}</h2>
        <p class="truncate text-xs text-black/55">{{ editUser.login }}</p>
      </div>
      <button
        type="button"
        :aria-label="t('common.close')"
        class="ml-auto shrink-0 rounded-md px-2 py-1 text-sm hover:bg-black/5"
        @click="closeEditModal"
      >✕</button>
    </header>
    <div role="tablist" class="flex shrink-0 flex-wrap gap-1 border-b border-black/10 px-3 py-2">
      <button
        id="edit-tab-profile"
        type="button"
        role="tab"
        data-test="edit-tab-profile"
        :aria-selected="editTab === 'profile'"
        aria-controls="edit-panel-profile"
        :class="editTab === 'profile' ? 'border-black/30 bg-black/5 font-medium' : 'border-transparent hover:bg-black/5'"
        class="rounded-md border px-2.5 py-1.5 text-sm"
        @click="editTab = 'profile'"
      >{{ t('admin.fde.editTabProfile') }}</button>
      <button
        id="edit-tab-security"
        type="button"
        role="tab"
        data-test="edit-tab-security"
        :aria-selected="editTab === 'security'"
        aria-controls="edit-panel-security"
        :class="editTab === 'security' ? 'border-black/30 bg-black/5 font-medium' : 'border-transparent hover:bg-black/5'"
        class="rounded-md border px-2.5 py-1.5 text-sm"
        @click="editTab = 'security'"
      >{{ t('admin.fde.editTabSecurity') }}</button>
      <button
        id="edit-tab-llm"
        type="button"
        role="tab"
        data-test="edit-tab-llm"
        :aria-selected="editTab === 'llm'"
        aria-controls="edit-panel-llm"
        :class="editTab === 'llm' ? 'border-black/30 bg-black/5 font-medium' : 'border-transparent hover:bg-black/5'"
        class="rounded-md border px-2.5 py-1.5 text-sm"
        @click="editTab = 'llm'"
      >{{ t('admin.fde.editTabLlm') }}</button>
      <button
        id="edit-tab-danger"
        type="button"
        role="tab"
        data-test="edit-tab-danger"
        :aria-selected="editTab === 'danger'"
        aria-controls="edit-panel-danger"
        :class="editTab === 'danger' ? 'border-black/30 bg-black/5 font-medium' : 'border-transparent hover:bg-black/5'"
        class="rounded-md border px-2.5 py-1.5 text-sm"
        @click="editTab = 'danger'"
      >{{ t('admin.fde.editTabDanger') }}</button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto p-3">
      <section
        id="edit-panel-profile"
        v-show="editTab === 'profile'"
        role="tabpanel"
        tabindex="0"
        data-test="edit-panel-profile"
        aria-labelledby="edit-tab-profile"
        class="rounded-lg border border-black/10 p-3"
      >
        <h3 class="mb-2 font-semibold">{{ t('admin.fde.basicProfileSection') }}</h3>
        <form data-test="user-profile-form" class="grid gap-3" @submit.prevent="saveProfile">
          <label class="flex flex-col gap-1 text-xs text-black/55">
            {{ t('admin.fde.displayNameLabel') }}
            <input v-model="editForm.display_name" autocomplete="off" class="rounded-md border border-black/20 px-2 py-1.5 text-sm text-black">
          </label>
          <label class="flex flex-col gap-1 text-xs text-black/55">
            {{ t('admin.fde.colRole') }}
            <select v-model="editForm.role" class="rounded-md border border-black/20 bg-white px-2 py-1.5 text-sm text-black">
              <option value="fde">{{ t('admin.fde.roleFde') }}</option>
              <option value="admin">{{ t('admin.fde.roleAdmin') }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-xs text-black/55">
            {{ t('admin.fde.fdeNameLabel') }}
            <input v-model="editForm.fde_name" autocomplete="off" class="rounded-md border border-black/20 px-2 py-1.5 text-sm text-black">
          </label>
          <p v-if="profileError" class="syserr" role="alert">{{ profileError }}</p>
          <p v-if="profileMessage" class="text-sm text-green-700" role="status">{{ profileMessage }}</p>
          <button
            type="submit"
            :disabled="profileBusy"
            class="justify-self-end rounded-md bg-brand px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >{{ t('admin.fde.updateProfile') }}</button>
        </form>
        <section v-if="editUser?.onboarding" data-test="profile-onboarding" class="mt-4 grid gap-2 border-t border-black/10 pt-3 text-sm">
          <h4 class="font-semibold">{{ t('admin.fde.colOnboarding') }}</h4>
          <p>{{ t(`admin.fde.onboarding.${editUser.onboarding.state}`) }}</p>
          <p v-if="editUser.onboarding.error" class="break-words text-red-700" :title="editUser.onboarding.error">
            {{ editUser.onboarding.error }}
          </p>
          <button
            v-if="editUser.onboarding.state === 'failed' && !editUser.offboarding"
            type="button"
            data-test="retry-onboarding-profile"
            class="justify-self-start rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5 disabled:opacity-50"
            :disabled="onboardingBusyId !== null"
            @click="retryOnboarding(editUser)"
          >{{ t('admin.fde.retryOnboarding') }}</button>
        </section>
        <section v-if="editUser?.offboarding" data-test="profile-offboarding" class="mt-4 grid gap-2 border-t border-black/10 pt-3 text-sm">
          <h4 class="font-semibold">{{ t('admin.fde.offboardingTitle') }}</h4>
          <p>{{ t(`admin.fde.offboarding.${editUser.offboarding.state}`) }}
            <span v-if="editUser.offboarding.step"> · {{ t(`admin.fde.offboardingSteps.${editUser.offboarding.step}`) }}</span>
          </p>
          <p v-if="editUser.offboarding.workspace_purge_after">
            {{ t('admin.fde.workspacePurgeAfter', { date: formatLastLogin(editUser.offboarding.workspace_purge_after) }) }}
          </p>
          <p v-if="editUser.offboarding.error" class="break-words text-red-700" :title="editUser.offboarding.error">
            {{ editUser.offboarding.error }}
          </p>
          <button
            v-if="editUser.offboarding.state === 'failed'"
            type="button"
            data-test="retry-offboarding-profile"
            class="justify-self-start rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5 disabled:opacity-50"
            :disabled="offboardingBusyId !== null"
            @click="retryOffboarding(editUser)"
          >{{ t('admin.fde.retryOffboarding') }}</button>
        </section>
      </section>

      <section
        id="edit-panel-security"
        v-show="editTab === 'security'"
        role="tabpanel"
        tabindex="0"
        data-test="edit-panel-security"
        aria-labelledby="edit-tab-security"
        class="space-y-3"
      >
        <section class="rounded-lg border border-black/10 p-3">
          <h3 class="font-semibold">{{ t('admin.fde.resetPasswordTitle') }}</h3>
          <p class="mt-1 text-sm text-black/65">{{ t('admin.fde.resetPasswordHint') }}</p>
          <form data-test="user-password-form" class="mt-3 grid gap-3" @submit.prevent="submitPasswordReset">
            <label class="flex flex-col gap-1 text-xs text-black/55">
              {{ t('admin.fde.newPassword') }}
              <input v-model="resetPasswordValue" type="password" required autocomplete="new-password" class="rounded-md border border-black/20 px-2 py-1.5 text-sm text-black">
            </label>
            <p v-if="passwordError" class="syserr" role="alert">{{ passwordError }}</p>
            <p v-if="passwordMessage" class="text-sm text-green-700" role="status">{{ passwordMessage }}</p>
            <button
              type="submit"
              :disabled="passwordBusy"
              class="justify-self-end rounded-md border border-black/20 px-3 py-1.5 text-sm hover:bg-black/5 disabled:opacity-50"
            >{{ t('admin.fde.submitPasswordReset') }}</button>
          </form>
        </section>

        <section class="rounded-lg border border-black/10 p-3">
          <h3 class="font-semibold">{{ t('admin.fde.totpSection') }}</h3>
          <p class="mt-1 text-sm text-black/65">{{ t('admin.fde.totpSectionHint') }}</p>
          <p class="mt-2 text-sm text-black/65">
            {{ editUser.totp_enabled ? t('admin.fde.reenrollTotpHint') : t('admin.fde.enrollTotpHint') }}
          </p>
          <p v-if="editUser.totp_enabled" class="mt-2 text-sm text-black/65">{{ t('admin.fde.resetTotpHint') }}</p>
          <p v-if="totpError" class="syserr mt-2" role="alert">{{ totpError }}</p>
          <p v-if="totpMessage" class="mt-2 text-sm text-green-700" role="status">{{ totpMessage }}</p>
          <div class="mt-3 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              data-test="confirm-totp-enroll"
              :disabled="totpBusy"
              class="rounded-md bg-brand px-3 py-1.5 text-sm text-white hover:bg-brand-hover disabled:opacity-50"
              @click="confirmTotpEnroll"
            >{{ editUser.totp_enabled ? t('admin.fde.reenrollTotp') : t('admin.fde.enrollTotp') }}</button>
            <button
              v-if="editUser.totp_enabled"
              type="button"
              data-test="confirm-totp-reset"
              :disabled="totpBusy"
              class="rounded-md bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-800 disabled:opacity-50"
              @click="confirmTotpReset"
            >{{ t('admin.fde.confirmTotpReset') }}</button>
          </div>
        </section>
      </section>

      <section
        id="edit-panel-llm"
        v-show="editTab === 'llm'"
        role="tabpanel"
        tabindex="0"
        data-test="edit-panel-llm"
        aria-labelledby="edit-tab-llm"
      >
        <h3 class="mb-2 font-semibold">{{ t('admin.fde.llmSection') }}</h3>
        <div class="rounded-lg border border-black/10 p-3">
          <p v-if="!editUser.fde_name" class="muted">{{ t('admin.fde.noFdeNameHint') }}</p>
          <UserLlmPane
            v-else
            :key="`${editUser.id}:${editUser.fde_name}`"
            :user="editUser"
            :providers="admin.providers"
            :git-hosts="admin.gitHosts"
          />
        </div>
      </section>

      <section
        id="edit-panel-danger"
        v-show="editTab === 'danger'"
        role="tabpanel"
        tabindex="0"
        data-test="edit-panel-danger"
        aria-labelledby="edit-tab-danger"
        class="rounded-lg border border-red-200 bg-red-50/50 p-3"
      >
        <h3 class="mb-2 font-semibold text-red-800">{{ t('admin.fde.dangerSection') }}</h3>
        <button
          v-if="!isCurrentUser(editUser)"
          type="button"
          data-test="open-user-delete"
          class="rounded-md px-2.5 py-1.5 text-sm text-red-700 underline hover:bg-red-100"
          @click="openDeleteModal(editUser)"
        >{{ t('admin.fde.deleteUser') }}</button>
      </section>
    </div>
  </ModalShell>

  <ModalShell
    v-if="deleteUser"
    data-test="user-delete-modal"
    :label="t('admin.fde.deleteUserTitle')"
    dialog-class="md:w-[30rem]"
    @close="closeDeleteModal"
  >
    <header class="flex items-center gap-3 border-b border-black/10 px-3 py-2">
      <h2 class="text-sm font-medium">{{ t('admin.fde.deleteUserTitle') }}</h2>
      <button
        type="button"
        :aria-label="t('common.close')"
        class="ml-auto shrink-0 rounded-md px-2 py-1 text-sm hover:bg-black/5"
        @click="closeDeleteModal"
      >✕</button>
    </header>
    <form class="grid gap-3 p-3" @submit.prevent="confirmUserDelete">
      <p class="text-sm text-black/65">{{ t('admin.fde.deleteUserHint', { login: deleteUser.login }) }}</p>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.fde.deleteLoginLabel') }}
        <input
          v-model="deleteConfirmation"
          data-test="delete-login-confirmation"
          autocomplete="off"
          :placeholder="t('admin.fde.deleteLoginPlaceholder')"
          class="rounded-md border border-black/20 px-2 py-1.5 text-sm text-black"
        >
      </label>
      <p v-if="deleteError" class="syserr" role="alert">{{ deleteError }}</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="rounded-md border border-black/20 px-3 py-1.5 text-sm" @click="closeDeleteModal">{{ t('common.cancel') }}</button>
        <button
          type="submit"
          data-test="confirm-user-delete"
          :disabled="!deleteMatchesLogin || deleteBusy || isCurrentUser(deleteUser)"
          class="rounded-md bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-800 disabled:opacity-50"
        >{{ t('admin.fde.confirmDeleteUser') }}</button>
      </div>
    </form>
  </ModalShell>
</template>
