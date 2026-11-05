<script setup lang="ts">
// 管理台 · 证书页（issue #456 M2 前端切片，契约 `docs/api/portal.md` §4.13 / §4.13-2a）。
//
// 这一页做四件事，全部只读 `GET /api/admin/tls` 的 DTO（唯一例外是四个动作各自打一次对应端点）：
//   ① 状态卡（`configured` 两态 + 覆盖徽标 + 到期提醒）；
//   ② 真机校验（`POST /api/admin/tls/verify`，三种结果分别呈现）；
//   ③ 上传/更新（**两步**：`POST /api/admin/tls/inspect` 只解析 → 用户确认域名 → `PUT /api/admin/tls`）；
//   ④ 回滚（`previous` 非空时出现，**确认对话框之前一个请求都不发**）。
//
// 红线（本文件是这条红线唯一的持有者）：
//   · 两个 PEM textarea 的值**只活在组件里**——不进 pinia store、不进浏览器存储（local/session）、
//     不进 URL、不进控制台日志、不进错误文案（错误文案只带服务端 `message`，经 `toDisplayText`）；
//   · 安装成功立刻清空两个 textarea（私钥不许在页面里多留一秒），`onUnmounted` 也清空；
//   · 请求体的两个 PEM 字段名**只在这里出现**（lib/store 里连字面量都没有，判据见 spec ⑬）。
//
// 一条口径：**前端不替后端做判定**。域名编辑框删掉/改掉 `adminHost` 那行时「确认安装」仍然可点
// （服务端是唯一判据，它会回 400 `tls_cert_domain_mismatch` + `details.missing`）；前端只把
// 「这张证书覆盖不到 `adminHost`」这个**证书事实**（inspect 的 `coverage.covered`）当成禁用条件。
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAdminStore } from '../stores/admin';
import {
  certificateDomains,
  expiryState,
  formatLocalTime,
  isAdminHostRow,
  normalizeDomainRows,
  type TlsCertInfo,
  type TlsRequestBody,
} from '../lib/tlsSettings';

const { t } = useI18n();
const admin = useAdminStore();

/** 两个 PEM 输入框的一手值。**只在组件内**（见文件头的红线）。 */
const certText = ref('');
const keyText = ref('');
/** 域名编辑器的行（inspect 成功后按证书 SAN 预填；可增可删可改）。 */
const domainRows = ref<string[]>([]);
/** 回滚的确认对话框：`true` 之前**一个请求都不发**（#296/#246 的先例）。 */
const confirmingRollback = ref(false);
const copied = ref(false);

const status = computed(() => admin.tlsStatus);
const inspect = computed(() => admin.tlsInspect);
const active = computed<TlsCertInfo | null>(() => status.value?.active ?? null);
/** 管理台域名：优先取状态 DTO（页面一打开就有），没加载时退回解析结果的同名格子。 */
const adminHost = computed(() => status.value?.coverage.adminHost
  || inspect.value?.coverage.adminHost
  || '');
const coverage = computed(() => status.value?.coverage ?? null);

/** 到期提醒（< 30 天黄条 / 已过期红条 / 不足一天写「今天到期」，**不显示「0 天」**）。 */
const expiry = computed(() => expiryState(active.value?.notAfter ?? null));
const notAfterText = computed(() => formatLocalTime(active.value?.notAfter ?? null));

/** 服务端字段名 → 页面上的哪一格（映射表**只在视图里**：lib/store 不认识这些字段名）。 */
type TlsFieldKey = 'cert' | 'key' | 'domains';
const FIELD_KEYS: Readonly<Record<string, TlsFieldKey>> = {
  certPem: 'cert',
  keyPem: 'key',
  confirmDomains: 'domains',
};
const fieldError = computed<TlsFieldKey | null>(() => (admin.tlsSaveField === null
  ? null
  : FIELD_KEYS[admin.tlsSaveField] ?? null));
/** 整表错误：只有服务端没说清是哪一格时才单独渲染（认不出字段名就不猜）。 */
const generalSaveError = computed(() => (fieldError.value === null ? admin.tlsSaveErr : null));

function fieldErrorText(key: TlsFieldKey): string | null {
  return fieldError.value === key ? admin.tlsSaveErr : null;
}

/** 「确认安装」的禁用条件：全部是**事实**（解析结果 / 私钥是否给了），不含用户的域名编辑。 */
const canInstall = computed(() => inspect.value !== null
  && inspect.value.keyMatches !== false
  && inspect.value.coverage.covered === true
  && keyText.value.trim() !== ''
  && certText.value.trim() !== ''
  && !admin.tlsSaving);

/** 真机校验的三种结果（`unknown` 不是结论，页面写「还没检查过」）。 */
const live = computed(() => status.value?.live ?? null);
const liveCheckedAt = computed(() => formatLocalTime(live.value?.checkedAt ?? null));

/**
 * `mismatch` 的一句话（#462：按 `reason` 分两句）。
 *
 * `chain_incomplete` = 指纹**一致**但服务端只发了 1 张证书 ⇒ 客户端可能链校验失败
 * （实测 `21 unable to verify the first certificate`）。它和「端出来的是另一张」是**两种病**，
 * 修法也不同（补中间证书 vs 让 Traefik 真加载上），所以不能共用一句话。
 * 老服务端没有 `reason` ⇒ 退回原来的措辞（缺席语义照旧）。
 */
const liveMismatchText = computed(() => {
  const current = live.value;
  if (current && current.reason === 'chain_incomplete') {
    return t('admin.tls.liveMismatchChainIncomplete', {
      depth: current.chainDepth ?? t('admin.tls.unknownValue'),
    });
  }
  return t('admin.tls.liveMismatch');
});

async function onInspect() {
  if (admin.tlsInspecting) return;
  // 私钥没填就**不带这个键**（后端据此回 `keyMatches:null`；空串也是「没给」）。
  const body: TlsRequestBody = { certPem: certText.value };
  if (keyText.value.trim() !== '') body.keyPem = keyText.value;
  const err = await admin.inspectTls(body);
  if (err === null && admin.tlsInspect) {
    // ⑤ 域名输入被预填成证书里的 SAN（没有 SAN 时用 CN）——与后端 `certificateDomains()` 同一口径。
    domainRows.value = certificateDomains(admin.tlsInspect.cert);
  }
}

async function onInstall() {
  if (!canInstall.value) return;
  const body: TlsRequestBody = {
    certPem: certText.value,
    keyPem: keyText.value,
    confirmDomains: normalizeDomainRows(domainRows.value),
  };
  const err = await admin.saveTls(body);
  if (err === null) {
    // ⑧ 安装成功：清空两格（私钥不留）、清空域名草稿；状态卡已由 store 用响应 DTO 刷新。
    certText.value = '';
    keyText.value = '';
    domainRows.value = [];
    copied.value = false;
  }
}

function addDomainRow() {
  domainRows.value.push('');
}

function removeDomainRow(index: number) {
  domainRows.value.splice(index, 1);
}

async function onVerify() {
  if (admin.tlsVerifying) return;
  await admin.verifyTls();
}

function askRollback() {
  confirmingRollback.value = true;
}

function cancelRollback() {
  confirmingRollback.value = false;
}

async function doRollback() {
  if (admin.tlsRollingBack) return;
  const err = await admin.rollbackTls();
  confirmingRollback.value = false;
  // 「成功/失败都要刷新状态卡」：成功那份响应已经是新状态；失败时再拉一次，免得卡片停在旧快照。
  if (err !== null) await admin.loadTls();
}

async function copyFingerprint() {
  const fp = active.value?.fingerprintSha256 ?? '';
  if (fp === '' || typeof navigator === 'undefined' || !navigator.clipboard) return;
  try {
    await navigator.clipboard.writeText(fp);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}

/**
 * 解析结果里的告警码 → 人话（服务端只发码不发话）。
 *
 * #462 追加三条**链形态**告警：`chain_looks_leaf_only`（只有叶子，警告不拒）、
 * `chain_order_suspect`（顺序可能反了，只在没给私钥时出现）、`chain_broken`（段间接不上）。
 * ⚠ 现状是「未知 code **被过滤掉**」（下面 `warnings` 的 filter），不是「走未知警告兜底」——
 * 所以后端每新增一个码都必须在这里登记一行，否则页面上完全看不见（工单 §5 的说法与代码不符，已如实上报）。
 */
const WARNING_KEYS: Readonly<Record<string, string>> = {
  cert_expired: 'admin.tls.warnExpired',
  not_yet_valid: 'admin.tls.warnNotYetValid',
  no_sans: 'admin.tls.warnNoSans',
  admin_host_not_covered: 'admin.tls.warnNotCovered',
  chain_looks_leaf_only: 'admin.tls.warnLeafOnly',
  chain_order_suspect: 'admin.tls.warnChainOrderSuspect',
  chain_broken: 'admin.tls.warnChainBroken',
};
const warnings = computed(() => (inspect.value?.warnings ?? [])
  .filter((code) => WARNING_KEYS[code] !== undefined));

onMounted(() => {
  // 唯一触发点（进管理台不请求，切到本 tab 才恰好 1 次）。store 的 action 自己 catch ⇒ 不会产生未捕获拒绝。
  void admin.loadTls();
});

onUnmounted(() => {
  // 红线：离开页面即清空（私钥/证书不许留在内存里等下一个组件实例）。
  certText.value = '';
  keyText.value = '';
  domainRows.value = [];
  confirmingRollback.value = false;
});
</script>

<template>
  <section data-test="admin-tls" class="grid gap-3">
    <header>
      <h2 class="text-lg font-medium">{{ t('admin.tls.title') }}</h2>
      <p class="mt-1 text-xs text-black/60">{{ t('admin.tls.intro') }}</p>
    </header>

    <p v-if="admin.tlsLoading" data-test="tls-loading" class="text-sm text-black/60" role="status">
      {{ t('admin.tls.loading') }}
    </p>
    <p v-if="admin.tlsError" data-test="tls-load-error" class="syserr text-sm" role="alert">{{ admin.tlsError }}</p>

    <!-- ① 状态卡 -->
    <section data-test="tls-status" class="grid gap-2 rounded-lg border border-black/10 p-3">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="text-sm font-semibold">{{ t('admin.tls.statusTitle') }}</h3>
        <span
          data-test="tls-status-configured"
          class="rounded-full border px-2 py-0.5 text-xs"
          :class="status?.configured ? 'border-green-600 text-green-700' : 'border-amber-600 text-amber-800'"
        >{{ status?.configured ? t('admin.tls.configured') : t('admin.tls.notConfigured') }}</span>
        <span
          v-if="coverage"
          data-test="tls-coverage"
          class="rounded-full border px-2 py-0.5 text-xs"
          :class="coverage.covered ? 'border-green-600 text-green-700' : 'border-red-600 text-red-700'"
        >{{ coverage.covered
          ? t('admin.tls.coverageOk', { host: coverage.adminHost })
          : t('admin.tls.coverageBad', { host: coverage.adminHost }) }}</span>
      </div>

      <!-- ③ 覆盖不到 adminHost：红字（显眼）+ 下方安装按钮禁用 -->
      <p v-if="coverage && !coverage.covered" data-test="tls-coverage-bad" class="syserr text-sm" role="alert">
        {{ t('admin.tls.coverageBad', { host: coverage.adminHost }) }}
      </p>

      <!-- ④ 到期提醒：< 30 天黄条、已过期红条、不足一天写「今天到期」（不出现「0 天」） -->
      <p
        v-if="expiry.kind === 'soon'"
        data-test="tls-expiry-warn"
        class="rounded-md border border-amber-600/40 bg-amber-50 px-2 py-1 text-sm text-amber-800"
        role="status"
      >{{ t('admin.tls.expirySoon', { days: expiry.days, date: notAfterText ?? t('admin.tls.unknownValue') }) }}</p>
      <p
        v-else-if="expiry.kind === 'today'"
        data-test="tls-expiry-warn"
        class="rounded-md border border-amber-600/40 bg-amber-50 px-2 py-1 text-sm text-amber-800"
        role="status"
      >{{ t('admin.tls.expiryToday', { date: notAfterText ?? t('admin.tls.unknownValue') }) }}</p>
      <p
        v-else-if="expiry.kind === 'expired'"
        data-test="tls-expiry-expired"
        class="syserr rounded-md border border-red-600/40 bg-red-50 px-2 py-1 text-sm"
        role="alert"
      >{{ t('admin.tls.expiryExpired', { date: notAfterText ?? t('admin.tls.unknownValue') }) }}</p>

      <!-- 已配置：逐字段（含 SAN 列表） -->
      <dl v-if="status?.configured && active" data-test="tls-active" class="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt class="text-xs text-black/55">{{ t('admin.tls.subjectCN') }}</dt>
          <dd data-test="tls-subject-cn" class="font-mono">{{ active.subjectCN ?? t('admin.tls.unknownValue') }}</dd>
        </div>
        <div>
          <dt class="text-xs text-black/55">{{ t('admin.tls.issuerCN') }}</dt>
          <dd data-test="tls-issuer-cn" class="font-mono">{{ active.issuerCN ?? t('admin.tls.unknownValue') }}</dd>
        </div>
        <div>
          <dt class="text-xs text-black/55">{{ t('admin.tls.validFrom') }}</dt>
          <dd data-test="tls-not-before">{{ formatLocalTime(active.notBefore) ?? t('admin.tls.unknownValue') }}</dd>
        </div>
        <div>
          <dt class="text-xs text-black/55">{{ t('admin.tls.validTo') }}</dt>
          <dd data-test="tls-not-after">{{ notAfterText ?? t('admin.tls.unknownValue') }}</dd>
        </div>
        <div class="sm:col-span-2">
          <dt class="text-xs text-black/55">{{ t('admin.tls.sans') }}</dt>
          <dd>
            <ul v-if="active.sans.length > 0" data-test="tls-sans" class="flex flex-wrap gap-1 font-mono">
              <li v-for="name in active.sans" :key="name" data-test="tls-san" class="rounded bg-black/5 px-1.5">{{ name }}</li>
            </ul>
            <span v-else data-test="tls-sans-empty" class="text-black/60">{{ t('admin.tls.sansEmpty') }}</span>
          </dd>
        </div>
        <div class="sm:col-span-2">
          <dt class="text-xs text-black/55">{{ t('admin.tls.fingerprint') }}</dt>
          <dd class="flex flex-wrap items-center gap-2">
            <span data-test="tls-fingerprint" class="break-all font-mono text-xs">{{ active.fingerprintSha256 ?? t('admin.tls.unknownValue') }}</span>
            <button
              v-if="active.fingerprintSha256"
              type="button"
              data-test="tls-copy-fingerprint"
              class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
              @click="copyFingerprint"
            >{{ copied ? t('admin.tls.copied') : t('admin.tls.copy') }}</button>
          </dd>
        </div>
      </dl>

      <!-- 未配置：说明回落到内建自签证书 + 指路下面的表单 -->
      <p v-else-if="status" data-test="tls-not-configured" class="text-sm text-black/70">
        {{ t('admin.tls.notConfiguredHint') }}
      </p>
      <p v-else-if="!admin.tlsLoading && !admin.tlsError" data-test="tls-not-loaded" class="text-sm text-black/60">
        {{ t('admin.tls.notLoaded') }}
      </p>
    </section>

    <!-- ② 真机校验（只是探针：不 live 也不锁住上传/回滚） -->
    <section data-test="tls-live" class="grid gap-2 rounded-lg border border-black/10 p-3">
      <h3 class="text-sm font-semibold">{{ t('admin.tls.liveTitle') }}</h3>
      <p class="text-xs text-black/60">{{ t('admin.tls.liveIntro') }}</p>
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-test="tls-live-check"
          :disabled="admin.tlsVerifying"
          class="rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5 disabled:opacity-50"
          @click="onVerify"
        >{{ admin.tlsVerifying ? t('admin.tls.liveChecking') : t('admin.tls.liveCheck') }}</button>
        <span v-if="liveCheckedAt" data-test="tls-live-checked-at" class="text-xs text-black/60">
          {{ t('admin.tls.liveCheckedAt', { at: liveCheckedAt }) }}
        </span>
      </div>

      <!-- unknown：**不写成「未知」当结论**，写「还没检查过」 -->
      <p v-if="!live || live.status === 'unknown'" data-test="tls-live-unknown" class="text-sm text-black/60">
        {{ t('admin.tls.liveNever') }}
      </p>
      <p v-else-if="live.status === 'live'" data-test="tls-live-live" class="text-sm text-green-700" role="status">
        {{ t('admin.tls.liveLive') }}
      </p>
      <div v-else-if="live.status === 'mismatch'" data-test="tls-live-mismatch" class="grid gap-1">
        <p class="syserr text-sm" role="alert">{{ liveMismatchText }}</p>
        <p class="text-xs text-black/60">{{ t('admin.tls.liveExpected') }}：<span data-test="tls-live-expected" class="font-mono">{{ active?.fingerprintSha256 ?? t('admin.tls.unknownValue') }}</span></p>
        <p class="text-xs text-black/60">{{ t('admin.tls.liveActual') }}：<span data-test="tls-live-actual" class="font-mono">{{ live.fingerprintSha256 ?? t('admin.tls.unknownValue') }}</span></p>
      </div>
      <div v-else data-test="tls-live-unreachable" class="grid gap-1">
        <p class="text-sm text-black/60">{{ t('admin.tls.liveUnreachable') }}</p>
        <p v-if="live.error" data-test="tls-live-error" class="text-xs font-mono text-black/60">
          {{ t('admin.tls.liveError', { error: live.error }) }}
        </p>
      </div>
      <p v-if="admin.tlsVerifyErr" data-test="tls-verify-error" class="syserr text-sm" role="alert">
        {{ admin.tlsVerifyErr }}
      </p>
    </section>

    <!-- ③ 上传 / 更新：两步 -->
    <section data-test="tls-upload" class="grid gap-2 rounded-lg border border-black/10 p-3">
      <h3 class="text-sm font-semibold">{{ t('admin.tls.uploadTitle') }}</h3>
      <p class="text-xs text-black/60">{{ t('admin.tls.uploadIntro') }}</p>

      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.tls.certLabel') }}
        <textarea
          v-model="certText"
          data-test="tls-cert-input"
          rows="5"
          spellcheck="false"
          autocomplete="off"
          :aria-invalid="fieldErrorText('cert') ? 'true' : undefined"
          :class="fieldErrorText('cert') ? 'border-red-600' : 'border-black/20'"
          class="rounded-md border px-2 py-1 font-mono text-xs"
        />
      </label>
      <p class="text-xs text-black/50">{{ t('admin.tls.certHint') }}</p>
      <p v-if="fieldErrorText('cert')" data-test="field-error-cert" class="syserr text-xs" role="alert">
        {{ fieldErrorText('cert') }}
      </p>

      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t('admin.tls.keyLabel') }}
        <textarea
          v-model="keyText"
          data-test="tls-key-input"
          rows="4"
          spellcheck="false"
          autocomplete="off"
          :aria-invalid="fieldErrorText('key') ? 'true' : undefined"
          :class="fieldErrorText('key') ? 'border-red-600' : 'border-black/20'"
          class="rounded-md border px-2 py-1 font-mono text-xs"
        />
      </label>
      <p class="text-xs text-black/50">{{ t('admin.tls.keyHint') }}</p>
      <p v-if="fieldErrorText('key')" data-test="field-error-key" class="syserr text-xs" role="alert">
        {{ fieldErrorText('key') }}
      </p>

      <div>
        <button
          type="button"
          data-test="tls-inspect"
          :disabled="admin.tlsInspecting || certText.trim() === ''"
          class="rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5 disabled:opacity-50"
          @click="onInspect"
        >{{ admin.tlsInspecting ? t('admin.tls.inspecting') : t('admin.tls.inspect') }}</button>
      </div>
      <p v-if="admin.tlsInspectErr" data-test="tls-inspect-error" class="syserr text-sm" role="alert">
        {{ admin.tlsInspectErr }}
      </p>

      <!-- 解析结果（只读；未提供私钥 ⇒ keyMatches=null，不配对 ⇒ 红字 + 禁用安装） -->
      <div v-if="inspect" data-test="tls-inspect-result" class="grid gap-2 rounded-md border border-black/10 p-2">
        <h4 class="text-xs font-semibold">{{ t('admin.tls.inspectTitle') }}</h4>
        <dl class="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          <div>
            <dt class="text-xs text-black/55">{{ t('admin.tls.subjectCN') }}</dt>
            <dd data-test="tls-inspect-subject-cn" class="font-mono">{{ inspect.cert.subjectCN ?? t('admin.tls.unknownValue') }}</dd>
          </div>
          <div>
            <dt class="text-xs text-black/55">{{ t('admin.tls.issuerCN') }}</dt>
            <dd data-test="tls-inspect-issuer-cn" class="font-mono">{{ inspect.cert.issuerCN ?? t('admin.tls.unknownValue') }}</dd>
          </div>
          <div>
            <dt class="text-xs text-black/55">{{ t('admin.tls.validFrom') }}</dt>
            <dd data-test="tls-inspect-not-before">{{ formatLocalTime(inspect.cert.notBefore) ?? t('admin.tls.unknownValue') }}</dd>
          </div>
          <div>
            <dt class="text-xs text-black/55">{{ t('admin.tls.validTo') }}</dt>
            <dd data-test="tls-inspect-not-after">{{ formatLocalTime(inspect.cert.notAfter) ?? t('admin.tls.unknownValue') }}</dd>
          </div>
          <div class="sm:col-span-2">
            <dt class="text-xs text-black/55">{{ t('admin.tls.fingerprint') }}</dt>
            <dd data-test="tls-inspect-fingerprint" class="break-all font-mono text-xs">{{ inspect.cert.fingerprintSha256 ?? t('admin.tls.unknownValue') }}</dd>
          </div>
        </dl>

        <p v-if="inspect.keyMatches === true" data-test="tls-key-matches-ok" class="text-sm text-green-700">
          {{ t('admin.tls.keyMatchesOk') }}
        </p>
        <p v-else-if="inspect.keyMatches === false" data-test="tls-key-mismatch" class="syserr text-sm" role="alert">
          {{ t('admin.tls.keyMismatchBad') }}
        </p>
        <p v-else data-test="tls-key-not-provided" class="text-sm text-black/60">
          {{ t('admin.tls.keyNotProvided') }}
        </p>

        <ul v-if="warnings.length > 0" data-test="tls-warnings" class="grid gap-1">
          <li v-for="code in warnings" :key="code" data-test="tls-warning" class="text-xs text-amber-800">
            {{ t(WARNING_KEYS[code]) }}
          </li>
        </ul>

        <!-- 域名区：按 SAN 预填、可增删改；adminHost 那行高亮（硬闸） -->
        <div data-test="tls-domains" class="grid gap-2">
          <h4 class="text-xs font-semibold">{{ t('admin.tls.domainsTitle') }}</h4>
          <p class="text-xs text-black/60">{{ t('admin.tls.domainsIntro') }}</p>
          <p data-test="tls-domains-must-include" class="text-xs text-amber-800">
            {{ t('admin.tls.domainsMustInclude', { host: adminHost || t('admin.tls.unknownValue') }) }}
          </p>
          <div
            v-for="(name, index) in domainRows"
            :key="index"
            data-test="tls-domain-row"
            class="flex flex-wrap items-center gap-2"
          >
            <input
              v-model="domainRows[index]"
              data-test="tls-domain-input"
              type="text"
              autocomplete="off"
              spellcheck="false"
              class="min-w-56 flex-1 rounded-md border border-black/20 px-2 py-1 font-mono text-sm"
            >
            <span
              v-if="isAdminHostRow(name, adminHost)"
              data-test="tls-domain-admin-tag"
              class="rounded-full border border-brand px-2 py-0.5 text-xs text-brand"
            >{{ t('admin.tls.domainsAdminTag') }}</span>
            <button
              type="button"
              data-test="tls-domain-remove"
              class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
              @click="removeDomainRow(index)"
            >{{ t('admin.tls.domainRemove') }}</button>
          </div>
          <p v-if="domainRows.length === 0" data-test="tls-domains-empty" class="text-xs text-black/60">
            {{ t('admin.tls.domainsEmpty') }}
          </p>
          <div>
            <button
              type="button"
              data-test="tls-domain-add"
              class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
              @click="addDomainRow"
            >{{ t('admin.tls.domainAdd') }}</button>
          </div>
        </div>

        <p
          v-if="inspect.coverage.covered === false"
          data-test="tls-coverage-blocks"
          class="syserr text-sm"
          role="alert"
        >{{ t('admin.tls.coverageBlocksInstall', { host: inspect.coverage.adminHost }) }}</p>
        <p v-if="keyText.trim() === ''" data-test="tls-install-needs-key" class="text-xs text-black/60">
          {{ t('admin.tls.installNeedsKey') }}
        </p>

        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-test="tls-install"
            :disabled="!canInstall"
            class="rounded-md bg-brand px-2.5 py-1 text-sm text-white hover:bg-brand-hover disabled:opacity-50"
            @click="onInstall"
          >{{ admin.tlsSaving ? t('admin.tls.installing') : t('admin.tls.install') }}</button>
        </div>
        <p v-if="fieldErrorText('domains')" data-test="field-error-domains" class="syserr text-xs" role="alert">
          {{ fieldErrorText('domains') }}
        </p>
      </div>

      <!-- 安装的成功/失败提示放在解析区块**之外**：装成功后 `tlsInspect` 会被清空（整块收起），
           提示不能跟着一起消失。 -->
      <p v-if="generalSaveError" data-test="tls-save-error" class="syserr text-sm" role="alert">
        {{ generalSaveError }}
      </p>
      <p v-if="admin.tlsSaveOk" data-test="tls-install-ok" class="text-sm text-green-700" role="status">
        {{ t('admin.tls.installOk') }}
      </p>
    </section>

    <!-- ④ 回滚：`previous` 非空才出现；确认前一个请求都不发。
         成功/失败提示**不**跟着 `previous` 一起收起：回滚成功后上一代就没了，但「已回滚」必须看得见。 -->
    <section
      v-if="status?.previous || admin.tlsRollbackErr || admin.tlsRollbackOk"
      data-test="tls-rollback"
      class="grid gap-2 rounded-lg border border-black/10 p-3"
    >
      <h3 class="text-sm font-semibold">{{ t('admin.tls.rollbackTitle') }}</h3>
      <p class="text-xs text-black/60">{{ t('admin.tls.rollbackIntro') }}</p>
      <dl v-if="status?.previous" class="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <div>
          <dt class="text-xs text-black/55">{{ t('admin.tls.rollbackPreviousCN') }}</dt>
          <dd data-test="tls-previous-cn" class="font-mono">{{ status.previous?.subjectCN ?? t('admin.tls.unknownValue') }}</dd>
        </div>
        <div>
          <dt class="text-xs text-black/55">{{ t('admin.tls.rollbackPreviousFingerprint') }}</dt>
          <dd data-test="tls-previous-fingerprint" class="break-all font-mono text-xs">{{ status.previous?.fingerprintSha256 ?? t('admin.tls.unknownValue') }}</dd>
        </div>
        <div>
          <dt class="text-xs text-black/55">{{ t('admin.tls.rollbackPreviousSavedAt') }}</dt>
          <dd data-test="tls-previous-saved-at">{{ formatLocalTime(status.previous?.savedAt ?? null) ?? t('admin.tls.unknownValue') }}</dd>
        </div>
      </dl>
      <div v-if="status?.previous">
        <button
          type="button"
          data-test="tls-rollback-ask"
          class="rounded-md border border-red-600/60 px-2.5 py-1 text-sm text-red-700 hover:bg-red-50"
          @click="askRollback"
        >{{ t('admin.tls.rollback') }}</button>
      </div>
      <div v-if="confirmingRollback" data-test="tls-rollback-dialog" class="grid gap-2 rounded-md border border-red-600/40 bg-red-50 p-2" role="dialog">
        <p class="text-sm font-medium">{{ t('admin.tls.rollbackConfirmTitle') }}</p>
        <p class="text-xs text-black/70">{{ t('admin.tls.rollbackConfirmBody') }}</p>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            data-test="tls-rollback-confirm"
            :disabled="admin.tlsRollingBack"
            class="rounded-md bg-red-700 px-2.5 py-1 text-sm text-white hover:bg-red-800 disabled:opacity-50"
            @click="doRollback"
          >{{ admin.tlsRollingBack ? t('admin.tls.rollingBack') : t('admin.tls.rollbackConfirmYes') }}</button>
          <button
            type="button"
            data-test="tls-rollback-cancel"
            class="rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5"
            @click="cancelRollback"
          >{{ t('admin.tls.rollbackConfirmNo') }}</button>
        </div>
      </div>
      <p v-if="admin.tlsRollbackErr" data-test="tls-rollback-error" class="syserr text-sm" role="alert">
        {{ admin.tlsRollbackErr }}
      </p>
      <p v-if="admin.tlsRollbackOk" data-test="tls-rollback-ok" class="text-sm text-green-700" role="status">
        {{ t('admin.tls.rollbackOk') }}
      </p>
    </section>
  </section>
</template>
