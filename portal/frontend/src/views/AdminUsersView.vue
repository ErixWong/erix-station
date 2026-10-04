<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ModalShell from '../components/ModalShell.vue';
import UserLlmPane from '../components/UserLlmPane.vue';
import { useAdminStore, type AdminUser } from '../stores/admin';
import { useAuthStore } from '../stores/auth';

const { t, locale } = useI18n();
const admin = useAdminStore();
const auth = useAuthStore();
const root = ref<HTMLElement | null>(null);
const searchTerm = ref('');
const menuUserId = ref<string | null>(null);
const selectedUserId = ref<string | null>(null);
const rowErrors = reactive<Record<string, string>>({});
const rowMessages = reactive<Record<string, string>>({});
const busyUserId = ref<string | null>(null);
const showAddUser = ref(false);
const showTotp = ref(false);
const submitting = ref(false);
const userForm = reactive({ login: '', display_name: '', password: '', fde_name: '' });

type UserModalAction = 'edit' | 'password' | 'totp' | 'delete';
const modalAction = ref<UserModalAction | null>(null);
const modalUserId = ref<string | null>(null);
const modalError = ref('');
const modalBusy = ref(false);
const editForm = reactive({ display_name: '', role: 'fde' as AdminUser['role'], fde_name: '' });
const resetPasswordValue = ref('');
const deleteConfirmation = ref('');
const copiedTotpValue = ref('');
const totpCopyError = ref('');
let drawerPreviousOverflow = '';

const selectedUser = computed(() =>
  admin.users.find((user) => user.id === selectedUserId.value) ?? null,
);
const actionUser = computed(() =>
  admin.users.find((user) => user.id === modalUserId.value) ?? null,
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
  Boolean(actionUser.value && deleteConfirmation.value === actionUser.value.login),
);

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
  copiedTotpValue.value = '';
  totpCopyError.value = '';
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

function openDrawer(user: AdminUser) {
  menuUserId.value = null;
  selectedUserId.value = user.id;
}

function closeDrawer() {
  selectedUserId.value = null;
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

function openUserModal(action: UserModalAction, user: AdminUser) {
  clearFeedback(user.id);
  modalUserId.value = user.id;
  modalAction.value = action;
  modalError.value = '';
  if (action === 'edit') {
    editForm.display_name = user.display_name ?? '';
    editForm.role = user.role;
    editForm.fde_name = user.fde_name ?? '';
  } else if (action === 'password') {
    resetPasswordValue.value = '';
  } else if (action === 'delete') {
    deleteConfirmation.value = '';
  }
  menuUserId.value = null;
}

function closeUserModal() {
  modalAction.value = null;
  modalUserId.value = null;
  modalError.value = '';
  modalBusy.value = false;
}

function setModalError(user: AdminUser, error: string) {
  modalError.value = error;
  rowErrors[user.id] = error;
}

async function saveProfile() {
  const user = actionUser.value;
  if (!user || modalBusy.value) return;
  modalBusy.value = true;
  modalError.value = '';
  try {
    const error = await admin.updateUser(user.id, {
      display_name: editForm.display_name.trim(),
      role: editForm.role,
      fde_name: editForm.fde_name.trim() || null,
    });
    if (error) setModalError(user, error);
    else {
      rowMessages[user.id] = t('admin.fde.profileUpdated');
      closeUserModal();
    }
  } finally {
    modalBusy.value = false;
  }
}

async function submitPasswordReset() {
  const user = actionUser.value;
  if (!user || modalBusy.value) return;
  modalBusy.value = true;
  modalError.value = '';
  try {
    const error = await admin.resetPassword(user.id, resetPasswordValue.value);
    if (error) setModalError(user, error);
    else {
      rowMessages[user.id] = t('admin.fde.passwordResetDone');
      closeUserModal();
    }
  } finally {
    modalBusy.value = false;
  }
}

async function confirmTotpReset() {
  const user = actionUser.value;
  if (!user || modalBusy.value) return;
  modalBusy.value = true;
  modalError.value = '';
  try {
    const error = await admin.resetTotp(user.id);
    if (error) setModalError(user, error);
    else {
      rowMessages[user.id] = t('admin.fde.totpResetDone');
      closeUserModal();
    }
  } finally {
    modalBusy.value = false;
  }
}

async function confirmUserDelete() {
  const user = actionUser.value;
  if (!user || !deleteMatchesLogin.value || isCurrentUser(user) || modalBusy.value) return;
  modalBusy.value = true;
  modalError.value = '';
  try {
    const error = await admin.deleteUser(user.id);
    if (error) setModalError(user, error);
    else {
      rowErrors[user.id] = '';
      delete rowMessages[user.id];
      if (selectedUserId.value === user.id) closeDrawer();
      closeUserModal();
    }
  } finally {
    modalBusy.value = false;
  }
}

function toggleMenu(user: AdminUser) {
  menuUserId.value = menuUserId.value === user.id ? null : user.id;
}

function closeMenuOnOutsidePointer(event: PointerEvent) {
  if (event.target instanceof Node && !root.value?.contains(event.target)) {
    menuUserId.value = null;
  }
}

function closeDrawerOnEscape(event: KeyboardEvent) {
  if (event.key === 'Escape' && !modalAction.value && selectedUserId.value) closeDrawer();
}

watch(selectedUserId, (id) => {
  if (id) {
    drawerPreviousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeDrawerOnEscape);
  } else {
    document.body.style.overflow = drawerPreviousOverflow;
    window.removeEventListener('keydown', closeDrawerOnEscape);
  }
});

function formatLastLogin(value: string | null): string {
  if (!value) return t('admin.fde.neverLoggedIn');
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? value : new Date(timestamp).toLocaleString(locale.value);
}

onMounted(() => {
  document.addEventListener('pointerdown', closeMenuOnOutsidePointer);
  void Promise.all([admin.loadUsers(), admin.loadProviders(), admin.loadGitHosts()]);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeMenuOnOutsidePointer);
  window.removeEventListener('keydown', closeDrawerOnEscape);
  if (selectedUserId.value) document.body.style.overflow = drawerPreviousOverflow;
  if (admin.totpOnce) admin.dismissTotpOnce();
});
</script>

<template>
  <section ref="root" class="mx-auto w-full max-w-5xl">
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

    <div data-test="user-list" class="overflow-hidden rounded-lg border border-black/10 bg-white">
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

      <div v-else-if="admin.usersLoaded" class="overflow-x-auto">
        <table class="w-full min-w-[48rem] table-fixed text-left text-sm">
          <colgroup>
            <col class="w-[16%]">
            <col class="w-[19%]">
            <col class="w-[13%]">
            <col class="w-[16%]">
            <col class="w-[10%]">
            <col class="w-[13%]">
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
              <th scope="col" class="px-3 py-2 font-medium">{{ t('admin.fde.colActions') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="user in filteredUsers" :key="user.id">
              <tr
                data-test="user-row"
                tabindex="0"
                class="cursor-pointer border-b border-black/10 transition-colors hover:bg-black/[0.025] focus:bg-black/[0.025] focus:outline-none"
                :class="selectedUserId === user.id ? 'bg-black/[0.035]' : ''"
                @click="openDrawer(user)"
                @keydown.self.enter.prevent="openDrawer(user)"
              >
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
                  <button
                    v-if="user.fde_name"
                    type="button"
                    class="max-w-full truncate underline decoration-transparent underline-offset-4 hover:decoration-current"
                    @click.stop="openDrawer(user)"
                  >{{ user.fde_name }}</button>
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
                <td class="px-2 py-2">
                  <div class="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      class="rounded-md border border-black/15 px-2 py-1 text-xs hover:bg-black/5 disabled:opacity-50"
                      :disabled="busyUserId !== null"
                      :aria-label="user.status === 'disabled' ? t('admin.fde.enableUser') : t('admin.fde.disableUser')"
                      @click.stop="toggleStatus(user)"
                    >{{ user.status === 'disabled' ? t('admin.fde.enableUser') : t('admin.fde.disableUser') }}</button>
                    <div class="relative">
                      <button
                        type="button"
                        data-test="user-menu-button"
                        class="rounded-md px-2 py-1 text-base leading-none hover:bg-black/5"
                        :aria-label="t('admin.fde.userMenu', { login: user.login })"
                        :aria-expanded="menuUserId === user.id"
                        @click.stop="toggleMenu(user)"
                      >···</button>
                      <div
                        v-if="menuUserId === user.id"
                        role="menu"
                        class="absolute right-0 z-10 mt-1 w-44 rounded-md border border-black/15 bg-white py-1 shadow-lg"
                        @click.stop
                      >
                        <button
                          type="button"
                          role="menuitem"
                          class="block w-full px-3 py-1.5 text-left text-sm hover:bg-black/5"
                          @click="openDrawer(user); menuUserId = null"
                        >{{ t('admin.fde.details') }}</button>
                        <button
                          type="button"
                          role="menuitem"
                          class="block w-full px-3 py-1.5 text-left text-sm hover:bg-black/5"
                          @click="openUserModal('edit', user)"
                        >{{ t('admin.fde.editProfile') }}</button>
                        <button
                          type="button"
                          role="menuitem"
                          class="block w-full px-3 py-1.5 text-left text-sm hover:bg-black/5"
                          @click="openUserModal('password', user)"
                        >{{ t('admin.fde.resetPassword') }}</button>
                        <button
                          type="button"
                          role="menuitem"
                          class="block w-full px-3 py-1.5 text-left text-sm hover:bg-black/5"
                          @click="openUserModal('totp', user)"
                        >{{ t('admin.fde.resetTotp') }}</button>
                        <button
                          v-if="!isCurrentUser(user)"
                          type="button"
                          role="menuitem"
                          class="block w-full px-3 py-1.5 text-left text-sm text-red-700 hover:bg-red-50"
                          @click="openUserModal('delete', user)"
                        >{{ t('admin.fde.deleteUser') }}</button>
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
              <tr v-if="rowErrors[user.id] || rowMessages[user.id]" class="border-b border-black/10">
                <td colspan="7" class="px-3 py-1.5 text-xs">
                  <p v-if="rowErrors[user.id]" class="syserr" role="alert">{{ rowErrors[user.id] }}</p>
                  <p v-else class="text-green-700" role="status">{{ rowMessages[user.id] }}</p>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>

    <Transition name="user-drawer">
      <div
        v-if="selectedUser"
        data-test="user-drawer"
        class="fixed inset-0 z-40 bg-black/40"
        @click.self="closeDrawer"
      >
        <aside
          role="dialog"
          aria-modal="true"
          :aria-label="t('admin.fde.openDetails', { login: selectedUser.login })"
          tabindex="-1"
          class="absolute inset-y-0 right-0 w-full max-w-xl overflow-y-auto bg-white shadow-2xl"
        >
          <header class="sticky top-0 z-10 flex items-center gap-3 border-b border-black/10 bg-white px-4 py-3">
            <div class="min-w-0">
              <h2 class="truncate text-base font-semibold">{{ selectedUser.login }}</h2>
              <p class="truncate text-xs text-black/55">{{ selectedUser.display_name || selectedUser.login }}</p>
            </div>
            <button
              type="button"
              :aria-label="t('common.close')"
              class="ml-auto rounded-md px-2 py-1 text-sm hover:bg-black/5"
              @click="closeDrawer"
            >✕</button>
          </header>
          <div class="space-y-5 p-4">
            <section>
              <div class="mb-2 flex items-center gap-2">
                <h3 class="font-semibold">{{ t('admin.fde.profileSection') }}</h3>
                <button
                  type="button"
                  class="ml-auto text-sm underline hover:text-brand"
                  @click="openUserModal('edit', selectedUser)"
                >{{ t('admin.fde.editProfile') }}</button>
              </div>
              <dl class="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-2 rounded-lg border border-black/10 p-3 text-sm">
                <dt class="text-black/55">{{ t('admin.fde.colLogin') }}</dt><dd class="break-all">{{ selectedUser.login }}</dd>
                <dt class="text-black/55">{{ t('admin.fde.colDisplayName') }}</dt><dd>{{ selectedUser.display_name || selectedUser.login }}</dd>
                <dt class="text-black/55">{{ t('admin.fde.colRole') }}</dt>
                <dd>{{ selectedUser.role === 'admin' ? t('admin.fde.roleAdmin') : t('admin.fde.roleFde') }}</dd>
                <dt class="text-black/55">{{ t('admin.fde.colFde') }}</dt><dd>{{ selectedUser.fde_name || '—' }}</dd>
                <dt class="text-black/55">{{ t('admin.fde.colMfa') }}</dt>
                <dd>{{ selectedUser.totp_enabled ? t('admin.fde.mfaEnabled') : t('admin.fde.mfaDisabled') }}</dd>
                <dt class="text-black/55">{{ t('admin.fde.lastLogin') }}</dt>
                <dd>{{ formatLastLogin(selectedUser.last_login_at) }}</dd>
                <dt class="text-black/55">{{ t('admin.fde.colStatus') }}</dt>
                <dd>
                  <span :class="selectedUser.status === 'active' ? 'text-green-700' : 'text-black/50'">
                    {{ selectedUser.status === 'active'
                      ? t('admin.fde.statusActive')
                      : selectedUser.status === 'disabled'
                        ? t('admin.fde.statusDisabled')
                        : t('admin.fde.statusAwaitingCredential') }}
                  </span>
                </dd>
              </dl>
              <p v-if="rowErrors[selectedUser.id]" class="syserr mt-2" role="alert">{{ rowErrors[selectedUser.id] }}</p>
              <p v-else-if="rowMessages[selectedUser.id]" class="mt-2 text-sm text-green-700" role="status">
                {{ rowMessages[selectedUser.id] }}
              </p>
            </section>

            <section>
              <h3 class="mb-2 font-semibold">{{ t('admin.fde.llmSection') }}</h3>
              <div class="rounded-lg border border-black/10 p-3">
                <p v-if="!selectedUser.fde_name" class="muted">{{ t('admin.fde.noFdeNameHint') }}</p>
                <UserLlmPane
                  v-else
                  :key="`${selectedUser.id}:${selectedUser.fde_name}`"
                  :user="selectedUser"
                  :providers="admin.providers"
                  :git-hosts="admin.gitHosts"
                />
              </div>
            </section>

            <section class="rounded-lg border border-red-200 bg-red-50/50 p-3">
              <h3 class="mb-3 font-semibold text-red-800">{{ t('admin.fde.dangerSection') }}</h3>
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  class="rounded-md border border-black/20 bg-white px-2.5 py-1.5 text-sm hover:bg-black/5 disabled:opacity-50"
                  :disabled="busyUserId !== null"
                  @click="toggleStatus(selectedUser)"
                >{{ selectedUser.status === 'disabled' ? t('admin.fde.enableUser') : t('admin.fde.disableUser') }}</button>
                <button
                  type="button"
                  class="rounded-md border border-black/20 bg-white px-2.5 py-1.5 text-sm hover:bg-black/5"
                  @click="openUserModal('password', selectedUser)"
                >{{ t('admin.fde.resetPassword') }}</button>
                <button
                  type="button"
                  class="rounded-md border border-black/20 bg-white px-2.5 py-1.5 text-sm hover:bg-black/5"
                  @click="openUserModal('totp', selectedUser)"
                >{{ t('admin.fde.resetTotp') }}</button>
                <button
                  v-if="!isCurrentUser(selectedUser)"
                  type="button"
                  class="rounded-md px-2.5 py-1.5 text-sm text-red-700 underline hover:bg-red-100"
                  @click="openUserModal('delete', selectedUser)"
                >{{ t('admin.fde.deleteUser') }}</button>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </Transition>
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
    @close="ignoreTotpDismiss"
  >
    <div class="flex items-center gap-2 border-b border-black/10 px-3 py-2">
      <h2 class="text-sm font-medium">{{ t('admin.fde.totpTitle') }}</h2>
    </div>
    <div data-test="totp-box" class="grid gap-3 p-3 text-[0.85rem]">
      <img :src="admin.totpOnce.qr" :alt="t('admin.fde.qrAlt')" class="my-1 block h-48 w-48" style="image-rendering: pixelated">
      <i18n-t keypath="admin.fde.totpCreated" tag="div" scope="global">
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
    v-if="modalAction && actionUser"
    :label="modalAction === 'edit'
      ? t('admin.fde.editUserTitle')
      : modalAction === 'password'
        ? t('admin.fde.resetPasswordTitle')
        : modalAction === 'totp'
          ? t('admin.fde.resetTotpTitle')
          : t('admin.fde.deleteUserTitle')"
    dialog-class="md:w-[30rem]"
    @close="closeUserModal"
  >
    <div class="flex items-center gap-2 border-b border-black/10 px-3 py-2">
      <h2 class="text-sm font-medium">
        {{ modalAction === 'edit'
          ? t('admin.fde.editUserTitle')
          : modalAction === 'password'
            ? t('admin.fde.resetPasswordTitle')
            : modalAction === 'totp'
              ? t('admin.fde.resetTotpTitle')
              : t('admin.fde.deleteUserTitle') }}
      </h2>
      <button
        type="button"
        :aria-label="t('common.close')"
        class="ml-auto shrink-0 rounded-md px-2 py-1 text-sm hover:bg-black/5"
        @click="closeUserModal"
      >✕</button>
    </div>

    <form v-if="modalAction === 'edit'" class="grid gap-3 p-3" @submit.prevent="saveProfile">
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
      <p v-if="modalError" class="syserr" role="alert">{{ modalError }}</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="rounded-md border border-black/20 px-3 py-1.5 text-sm" @click="closeUserModal">{{ t('common.cancel') }}</button>
        <button type="submit" :disabled="modalBusy" class="rounded-md bg-brand px-3 py-1.5 text-sm text-white disabled:opacity-50">
          {{ t('admin.fde.updateProfile') }}
        </button>
      </div>
    </form>

    <form v-else-if="modalAction === 'password'" class="grid gap-3 p-3" @submit.prevent="submitPasswordReset">
      <p class="text-sm text-black/65">{{ t('admin.fde.resetPasswordHint') }}</p>
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.fde.newPassword') }}
        <input v-model="resetPasswordValue" type="password" required autocomplete="new-password" class="rounded-md border border-black/20 px-2 py-1.5 text-sm text-black">
      </label>
      <p v-if="modalError" class="syserr" role="alert">{{ modalError }}</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="rounded-md border border-black/20 px-3 py-1.5 text-sm" @click="closeUserModal">{{ t('common.cancel') }}</button>
        <button type="submit" :disabled="modalBusy" class="rounded-md bg-brand px-3 py-1.5 text-sm text-white disabled:opacity-50">
          {{ t('admin.fde.submitPasswordReset') }}
        </button>
      </div>
    </form>

    <div v-else-if="modalAction === 'totp'" class="grid gap-3 p-3">
      <p class="text-sm text-black/65">{{ t('admin.fde.resetTotpHint') }}</p>
      <p v-if="modalError" class="syserr" role="alert">{{ modalError }}</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="rounded-md border border-black/20 px-3 py-1.5 text-sm" @click="closeUserModal">{{ t('common.cancel') }}</button>
        <button
          type="button"
          data-test="confirm-totp-reset"
          :disabled="modalBusy"
          class="rounded-md bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-800 disabled:opacity-50"
          @click="confirmTotpReset"
        >{{ t('admin.fde.confirmTotpReset') }}</button>
      </div>
    </div>

    <form v-else class="grid gap-3 p-3" @submit.prevent="confirmUserDelete">
      <p class="text-sm text-black/65">{{ t('admin.fde.deleteUserHint', { login: actionUser.login }) }}</p>
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
      <p v-if="modalError" class="syserr" role="alert">{{ modalError }}</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="rounded-md border border-black/20 px-3 py-1.5 text-sm" @click="closeUserModal">{{ t('common.cancel') }}</button>
        <button
          type="submit"
          data-test="confirm-user-delete"
          :disabled="!deleteMatchesLogin || modalBusy || isCurrentUser(actionUser)"
          class="rounded-md bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-800 disabled:opacity-50"
        >{{ t('admin.fde.confirmDeleteUser') }}</button>
      </div>
    </form>
  </ModalShell>
</template>

<style scoped>
.user-drawer-enter-active,
.user-drawer-leave-active {
  transition: background-color 180ms ease;
}

.user-drawer-enter-active aside,
.user-drawer-leave-active aside {
  transition: transform 180ms ease;
}

.user-drawer-enter-from,
.user-drawer-leave-to {
  background-color: transparent;
}

.user-drawer-enter-from aside,
.user-drawer-leave-to aside {
  transform: translateX(100%);
}
</style>
