<script setup lang="ts">
// 管理台 · 邮件通道配置（issue #449 管理台切片，契约 `docs/api/portal.md` §4.12）。
//
// 这页是登录第二因素「邮箱验证码」（§2.3a/§2.3b）的**唯一开关**：`transport='smtp'` 且配全了，
// 没注册 TOTP 的账号登录才会走邮箱码；`disabled` 就退回纯口令（§2.2 选择规则第④分支）。
//
// 六条硬口径（逐条由 `AdminMailView.spec.ts` 的用例名钉住）：
//   ① 打开即 `GET /api/admin/mail/settings` **恰好一次**并回填；**口令框永远为空**（服务端也不发口令，
//      只有 `hasPassword`）——`hasPassword=true` 时 placeholder 写「已设置，留空不修改」。
//   ② 改 host 保存 ⇒ `PUT` 请求体里**没有 `password` 键**（键缺席 = 不修改，§4.12-3 的三态）。
//   ③ 勾「清除口令」⇒ 请求体 `password: null`（清除）。
//   ④ `400 validation_failed` + `details.field` ⇒ **那个**输入框标红（aria-invalid + 红边）并在其下显示
//      服务端 message；认不出字段名才退到整表一条错误（不猜是哪个框）。
//   ⑤ `transport !== 'smtp'`（**已保存的**配置，测试发信用的是它，不是表单里的草稿）⇒ 测试发信按钮禁用 + 一句说明。
//   ⑥ 测试发信成功 / `409` / `502` / `429` 各自给人话；`429` 显示 `Retry-After` 秒数。
//
// 红线（§4.12-6）：口令明文只在输入框里、只在提交时随请求体走——不回填、不进 store、不进
// 浏览器本地存储、不进地址栏、不写日志。所以本文件**没有**任何本地存储 / 控制台 / 路由相关的调用
// （这条由 `AdminMailView.spec.ts` 的源码级断言钉住）。
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAdminStore } from '../stores/admin';
import {
  MAIL_TRANSPORTS,
  buildMailSettingsPayload,
  type MailFieldKey,
  type MailFormValues,
  type MailSettings,
} from '../lib/mailSettings';

const { t } = useI18n();
const admin = useAdminStore();

/** 表单的一手值（数字框在 DOM 里是字符串，提交时才转数字；空/非法 ⇒ null = 用服务端默认值）。 */
const form = reactive<MailFormValues>({
  transport: 'disabled',
  host: '',
  port: '',
  secure: true,
  user: '',
  from: '',
  connectionMs: '',
  greetingMs: '',
  socketMs: '',
  password: '',
  clearPassword: false,
});

const settings = computed<MailSettings | null>(() => admin.mailSettings);
const loaded = computed(() => admin.mailSettingsLoaded);
const loading = computed(() => admin.mailSettingsLoading);
const loadError = computed(() => admin.mailSettingsErr);
const fieldError = computed<MailFieldKey | null>(() => admin.mailSaveField);
const saveError = computed(() => admin.mailSaveErr);
/** 整表错误：只有在「服务端没说清是哪个字段」时才单独渲染（④ 的反面）。 */
const generalSaveError = computed(() => (fieldError.value === null ? saveError.value : null));

const transport = computed(() => settings.value?.transport ?? null);
const hasPassword = computed(() => settings.value?.hasPassword === true);
/** 测试发信用的是**已保存**的配置 ⇒ 按钮的可用性看它，不看表单草稿。 */
const testEnabled = computed(() => transport.value === 'smtp');
const formTransportDiffers = computed(() => transport.value !== null && transport.value !== form.transport);

const passwordPlaceholder = computed(() => (hasPassword.value
  ? t('admin.mail.passwordKeep')
  : t('admin.mail.passwordPlaceholder')));

const updatedAtText = computed(() => {
  const raw = settings.value?.updatedAt ?? null;
  if (raw === null) return t('admin.mail.updatedAtNever');
  const at = new Date(raw);
  return Number.isNaN(at.getTime())
    ? t('admin.mail.updatedAtUnknown', { value: raw })
    : at.toLocaleString();
});

function fillForm(next: MailSettings) {
  form.transport = next.transport;
  form.host = next.smtp.host;
  form.port = next.smtp.port === null ? '' : String(next.smtp.port);
  form.secure = next.smtp.secure;
  form.user = next.smtp.user;
  form.from = next.smtp.from;
  form.connectionMs = next.smtp.timeouts.connectionMs === null ? '' : String(next.smtp.timeouts.connectionMs);
  form.greetingMs = next.smtp.timeouts.greetingMs === null ? '' : String(next.smtp.timeouts.greetingMs);
  form.socketMs = next.smtp.timeouts.socketMs === null ? '' : String(next.smtp.timeouts.socketMs);
  // 口令框**永不回填**（红线）：服务端不发，前端也不猜。保存成功后清空同理。
  form.password = '';
  form.clearPassword = false;
}

/** 该字段当前的服务端校验消息（不是这个字段 ⇒ null；页面据此决定标不标红）。 */
function fieldErrorText(key: MailFieldKey): string | null {
  return fieldError.value === key ? saveError.value : null;
}

/** 三档超时的字段标识（折叠区里的错误落点按同一顺序渲染）。 */
const TIMEOUT_FIELDS = ['timeoutConnection', 'timeoutGreeting', 'timeoutSocket'] as const;

/** 超时三档折叠在「高级」里：报错时自动展开，否则用户看不见红在哪。 */
const advancedOpen = computed(() => fieldError.value === 'timeoutConnection'
  || fieldError.value === 'timeoutGreeting'
  || fieldError.value === 'timeoutSocket');

async function onSave() {
  if (admin.mailSaving) return;
  const payload = buildMailSettingsPayload(form);
  const err = await admin.saveMailSettings(payload);
  // 成功：用响应 DTO 回填（服务端已 invalidate()，改完立刻生效），并清空口令框与「清除」勾选。
  if (!err && admin.mailSettings) fillForm(admin.mailSettings);
}

const testTo = ref('');

async function onSendTest() {
  if (admin.mailTesting || !testEnabled.value) return;
  await admin.sendTestMail(testTo.value);
}

function testOkText(): string {
  const ok = admin.mailTestOk;
  if (!ok) return '';
  return t('admin.mail.testOk', {
    to: ok.to,
    at: ok.at === null ? t('admin.mail.testOkNoTime') : new Date(ok.at).toLocaleString(),
  });
}

onMounted(() => {
  // 唯一触发点（判据①）。store 的 action 自己 catch ⇒ 这里不会产生未捕获拒绝（AGENTS.md §4 的 rc=1 坑）。
  void admin.loadMailSettings().then((err) => {
    if (!err && admin.mailSettings) fillForm(admin.mailSettings);
  });
});
</script>

<template>
  <section data-test="admin-mail" class="grid gap-3">
    <header>
      <h2 class="text-lg font-medium">{{ t('admin.mail.title') }}</h2>
      <p class="mt-1 text-xs text-black/60">{{ t('admin.mail.intro') }}</p>
    </header>

    <p v-if="loading" data-test="mail-loading" class="text-sm text-black/60" role="status">
      {{ t('admin.mail.loading') }}
    </p>
    <p v-if="loadError" data-test="mail-load-error" class="syserr text-sm" role="alert">{{ loadError }}</p>

    <!-- 顶部状态行：当前通道 + 口令「已设置/未设置」+ 最后修改时间 -->
    <dl data-test="mail-status" class="grid gap-x-4 gap-y-1 rounded-lg border border-black/10 p-3 text-sm sm:grid-cols-3">
      <div>
        <dt class="text-xs text-black/55">{{ t('admin.mail.statusTransport') }}</dt>
        <dd data-test="mail-status-transport" class="font-mono">{{ transport ?? t('admin.mail.unknownValue') }}</dd>
      </div>
      <div>
        <dt class="text-xs text-black/55">{{ t('admin.mail.statusPassword') }}</dt>
        <dd data-test="mail-status-password">{{ hasPassword ? t('admin.mail.passwordSet') : t('admin.mail.passwordUnset') }}</dd>
      </div>
      <div>
        <dt class="text-xs text-black/55">{{ t('admin.mail.statusUpdatedAt') }}</dt>
        <dd data-test="mail-status-updated-at">{{ updatedAtText }}</dd>
      </div>
    </dl>

    <p v-if="!loaded && !loading && !loadError" data-test="mail-not-loaded" class="text-sm text-black/60">
      {{ t('admin.mail.notLoaded') }}
    </p>

    <form data-test="mail-form" class="grid gap-3 rounded-lg border border-black/10 p-3" @submit.prevent="onSave">
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.mail.transport') }}
        <select
          v-model="form.transport"
          data-test="mail-transport"
          :aria-invalid="fieldErrorText('transport') ? 'true' : undefined"
          class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
        >
          <option v-for="value in MAIL_TRANSPORTS" :key="value" :value="value">
            {{ value === 'smtp' ? t('admin.mail.transportSmtp') : t('admin.mail.transportDisabled') }}
          </option>
        </select>
      </label>
      <p data-test="mail-transport-hint" class="text-xs text-black/50">{{ t('admin.mail.transportHint') }}</p>
      <p v-if="fieldErrorText('transport')" data-test="field-error-transport" class="syserr text-xs" role="alert">
        {{ fieldErrorText('transport') }}
      </p>

      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.mail.host') }}
        <input
          v-model="form.host"
          data-test="mail-host"
          type="text"
          autocomplete="off"
          :aria-invalid="fieldErrorText('host') ? 'true' : undefined"
          :class="fieldErrorText('host') ? 'border-red-600' : 'border-black/20'"
          class="rounded-md border px-2 py-1 text-sm"
        >
      </label>
      <p class="text-xs text-black/50">{{ t('admin.mail.hostHint') }}</p>
      <p v-if="fieldErrorText('host')" data-test="field-error-host" class="syserr text-xs" role="alert">
        {{ fieldErrorText('host') }}
      </p>

      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.mail.port') }}
        <input
          v-model="form.port"
          data-test="mail-port"
          type="number"
          inputmode="numeric"
          min="1"
          max="65535"
          :aria-invalid="fieldErrorText('port') ? 'true' : undefined"
          :class="fieldErrorText('port') ? 'border-red-600' : 'border-black/20'"
          class="rounded-md border px-2 py-1 text-sm"
        >
      </label>
      <p v-if="fieldErrorText('port')" data-test="field-error-port" class="syserr text-xs" role="alert">
        {{ fieldErrorText('port') }}
      </p>

      <label class="flex items-center gap-2 text-xs text-black/55">
        <input
          v-model="form.secure"
          data-test="mail-secure"
          type="checkbox"
          class="accent-brand"
          :aria-invalid="fieldErrorText('secure') ? 'true' : undefined"
        >
        {{ t('admin.mail.secure') }}
      </label>
      <p class="text-xs text-black/50">{{ t('admin.mail.secureHint') }}</p>
      <p v-if="fieldErrorText('secure')" data-test="field-error-secure" class="syserr text-xs" role="alert">
        {{ fieldErrorText('secure') }}
      </p>

      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.mail.user') }}
        <input
          v-model="form.user"
          data-test="mail-user"
          type="text"
          autocomplete="off"
          :aria-invalid="fieldErrorText('user') ? 'true' : undefined"
          :class="fieldErrorText('user') ? 'border-red-600' : 'border-black/20'"
          class="rounded-md border px-2 py-1 text-sm"
        >
      </label>
      <p class="text-xs text-black/50">{{ t('admin.mail.userHint') }}</p>
      <p v-if="fieldErrorText('user')" data-test="field-error-user" class="syserr text-xs" role="alert">
        {{ fieldErrorText('user') }}
      </p>

      <!-- 口令：type=password + autocomplete=new-password，**永不回填**（值只来自用户输入） -->
      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.mail.password') }}
        <input
          v-model="form.password"
          data-test="mail-password"
          type="password"
          autocomplete="new-password"
          :placeholder="passwordPlaceholder"
          :aria-invalid="fieldErrorText('password') ? 'true' : undefined"
          :class="fieldErrorText('password') ? 'border-red-600' : 'border-black/20'"
          class="rounded-md border px-2 py-1 text-sm"
        >
      </label>
      <p data-test="mail-password-hint" class="text-xs text-black/50">{{ t('admin.mail.passwordHint') }}</p>
      <p v-if="fieldErrorText('password')" data-test="field-error-password" class="syserr text-xs" role="alert">
        {{ fieldErrorText('password') }}
      </p>
      <label class="flex items-center gap-2 text-xs text-black/55">
        <input v-model="form.clearPassword" data-test="mail-clear-password" type="checkbox" class="accent-brand">
        {{ t('admin.mail.clearPassword') }}
      </label>

      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.mail.from') }}
        <input
          v-model="form.from"
          data-test="mail-from"
          type="text"
          autocomplete="off"
          :aria-invalid="fieldErrorText('from') ? 'true' : undefined"
          :class="fieldErrorText('from') ? 'border-red-600' : 'border-black/20'"
          class="rounded-md border px-2 py-1 text-sm"
        >
      </label>
      <p class="text-xs text-black/50">{{ t('admin.mail.fromHint') }}</p>
      <p v-if="fieldErrorText('from')" data-test="field-error-from" class="syserr text-xs" role="alert">
        {{ fieldErrorText('from') }}
      </p>

      <details data-test="mail-advanced" class="rounded-md border border-black/10 px-2 py-1" :open="advancedOpen">
        <summary class="cursor-pointer text-xs text-black/60">{{ t('admin.mail.advanced') }}</summary>
        <div class="mt-2 grid gap-2 sm:grid-cols-3">
          <label class="flex flex-col gap-1 text-xs text-black/55">
            {{ t('admin.mail.timeoutConnection') }}
            <input
              v-model="form.connectionMs"
              data-test="mail-timeout-connection"
              type="number"
              inputmode="numeric"
              min="1"
              max="600000"
              :aria-invalid="fieldErrorText('timeoutConnection') ? 'true' : undefined"
              :class="fieldErrorText('timeoutConnection') ? 'border-red-600' : 'border-black/20'"
              class="rounded-md border px-2 py-1 text-sm"
            >
          </label>
          <label class="flex flex-col gap-1 text-xs text-black/55">
            {{ t('admin.mail.timeoutGreeting') }}
            <input
              v-model="form.greetingMs"
              data-test="mail-timeout-greeting"
              type="number"
              inputmode="numeric"
              min="1"
              max="600000"
              :aria-invalid="fieldErrorText('timeoutGreeting') ? 'true' : undefined"
              :class="fieldErrorText('timeoutGreeting') ? 'border-red-600' : 'border-black/20'"
              class="rounded-md border px-2 py-1 text-sm"
            >
          </label>
          <label class="flex flex-col gap-1 text-xs text-black/55">
            {{ t('admin.mail.timeoutSocket') }}
            <input
              v-model="form.socketMs"
              data-test="mail-timeout-socket"
              type="number"
              inputmode="numeric"
              min="1"
              max="600000"
              :aria-invalid="fieldErrorText('timeoutSocket') ? 'true' : undefined"
              :class="fieldErrorText('timeoutSocket') ? 'border-red-600' : 'border-black/20'"
              class="rounded-md border px-2 py-1 text-sm"
            >
          </label>
        </div>
        <p class="mt-1 text-xs text-black/50">{{ t('admin.mail.timeoutHint') }}</p>
        <template v-for="key in TIMEOUT_FIELDS" :key="key">
          <p
            v-if="fieldErrorText(key)"
            :data-test="`field-error-${key}`"
            class="syserr mt-1 text-xs"
            role="alert"
          >{{ fieldErrorText(key) }}</p>
        </template>
      </details>

      <!-- ④ 的反面：服务端没说清字段（或不是 400）时给一条整表错误，而不是静默 -->
      <p v-if="generalSaveError" data-test="mail-save-error" class="syserr text-sm" role="alert">
        {{ generalSaveError }}
      </p>
      <p v-if="admin.mailSaveOk" data-test="mail-save-ok" class="text-sm text-green-700" role="status">
        {{ t('admin.mail.saveOk') }}
      </p>

      <div>
        <button
          type="submit"
          data-test="mail-save"
          :disabled="admin.mailSaving"
          class="rounded-md bg-brand px-2.5 py-1 text-sm text-white hover:bg-brand-hover disabled:opacity-50"
        >{{ admin.mailSaving ? t('admin.mail.saving') : t('admin.mail.save') }}</button>
      </div>
    </form>

    <!-- 测试发信：用的是**已保存**的配置（§4.12-4），所以可用性看已保存的 transport，不看草稿 -->
    <section data-test="mail-test" class="grid gap-2 rounded-lg border border-black/10 p-3">
      <h3 class="text-sm font-semibold">{{ t('admin.mail.testTitle') }}</h3>
      <p class="text-xs text-black/60">{{ t('admin.mail.testIntro') }}</p>
      <p v-if="!testEnabled" data-test="mail-test-disabled-hint" class="text-xs text-amber-800">
        {{ t('admin.mail.testDisabledHint') }}
      </p>
      <p v-else-if="formTransportDiffers" data-test="mail-test-unsaved-hint" class="text-xs text-amber-800">
        {{ t('admin.mail.testFormUnsaved') }}
      </p>
      <div class="flex flex-wrap items-end gap-2">
        <label class="flex min-w-56 flex-col gap-1 text-xs text-black/55">
          {{ t('admin.mail.testTo') }}
          <input
            v-model="testTo"
            data-test="mail-test-to"
            type="text"
            autocomplete="off"
            :placeholder="t('admin.mail.testToPlaceholder')"
            class="rounded-md border border-black/20 px-2 py-1 text-sm"
          >
        </label>
        <button
          type="button"
          data-test="mail-test-send"
          :disabled="admin.mailTesting || !testEnabled"
          class="rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5 disabled:opacity-50"
          @click="onSendTest"
        >{{ admin.mailTesting ? t('admin.mail.testing') : t('admin.mail.testSend') }}</button>
      </div>
      <p v-if="admin.mailTestOk" data-test="mail-test-ok" class="text-sm text-green-700" role="status">
        {{ testOkText() }}
      </p>
      <p v-if="admin.mailTestErr" data-test="mail-test-error" class="syserr text-sm" role="alert">
        {{ admin.mailTestErr }}
      </p>
      <p v-if="admin.mailTestReason" data-test="mail-test-reason" class="text-xs text-black/60">
        {{ t('admin.mail.testReason', { reason: admin.mailTestReason }) }}
      </p>
    </section>
  </section>
</template>
