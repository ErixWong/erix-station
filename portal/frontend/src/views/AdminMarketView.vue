<script setup lang="ts">
// 能力市场 · 管理台 tab（issue #595 M2，契约 §7 管理面 + §8 管理台；#608 叠加 MCP 发布面）。
//
// 这一页是**发布口**，不是校验器。四条口径：
//   ① 文件由浏览器打包成 `{files:[{path, content_base64}]}`（§1 硬约束 2：P0 不引 zip 库），
//      path 取 `webkitRelativePath || name`。
//   ② 前端只挡**一眼假**的 path（绝对路径 / 含 `..` / 含 `\` / 超长 / 空）——目的是不发一个
//      必然 400 的体。文件数 ≤50、单文件 ≤512 KiB、`skill.mjs` 在不在、`skill.id === slug`
//      这些**全在服务端**（`portal/src/market.js#validateBundle`），前端一律不冒充。
//   ③ `400 validation_failed` 的 `details.field` 回来标红那一格（认不出就不标，不猜）。
//   ④ 扫描分数与 warnings 是 **advisory**（§3）：只展示，不拦发布。
//
// MCP（#608 §8.1）另加三条：
//   ⑤ `kind='mcp'` 时没有包体，只有连接声明：`transport`/`command`+`args`|`url`/`exposure`/
//      `lifecycle`/`timeout_ms`/`reason`（必选）/`slots`。槽的 `inject` 由 transport **锁死**
//      （§4.2 组合矩阵），表单里是只读文本，不是可选下拉。
//   ⑥ 「凭据」区只写不读（§3.1）：每行只有 `name / kind / has_value / updated_at`，设值 modal
//      永不回填旧值，保存后只显示「已设置」。页面上**没有任何能拿到明文的入口**。
//   ⑦ MCP 的本地拦项只有 `checkMcpForm` 那几条一眼假（缺 `reason` / 缺 command|url /
//      timeout 非正整数 / 槽名空或重名）；保留名、正则、url 协议、command 含空格全部留给服务端。
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import {
  ADMIN_MARKET_ITEMS_PATH,
  adminMarketItemPath,
  adminMarketSecretsPath,
  buildBundle,
  buildMcpFields,
  buildSecretPayload,
  bundlePathOf,
  bytesText,
  CAPABILITY_STATES,
  checkBundlePaths,
  checkMcpForm,
  countText,
  emptyMcpForm,
  emptyMcpSlot,
  exposureMessageKey,
  injectForTransport,
  marketErrorText,
  MCP_EXPOSURES,
  MCP_LIFECYCLES,
  MCP_REASONS,
  MCP_SLOT_KINDS,
  MCP_TRANSPORTS,
  normalizeAdminDetail,
  normalizeAdminItems,
  normalizeMcpSecrets,
  reasonMessageKey,
  stateMessageKey,
  validationFieldOf,
  type AdminFieldKey,
  type AdminMarketDetail,
  type AdminMarketItem,
  type BundlePathIssue,
  type BundlePathIssueCode,
  type McpFormDraft,
  type McpFormIssue,
  type McpSecretSlot,
} from '../lib/market';
import ModalShell from '../components/ModalShell.vue';

const { t } = useI18n();

const rows = ref<AdminMarketItem[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
const actionError = ref<string | null>(null);
const resultText = ref<string | null>(null);
/** 列表过滤（§7-3 的 `?state=`）；空串 = 不带 query（全部）。 */
const stateFilter = ref('');
/** 正在做状态迁移的条目 id（禁着那一行的按钮，避免连点发两趟）。 */
const busyId = ref<string | null>(null);

function listPath(): string {
  return stateFilter.value === ''
    ? ADMIN_MARKET_ITEMS_PATH
    : `${ADMIN_MARKET_ITEMS_PATH}?state=${encodeURIComponent(stateFilter.value)}`;
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    rows.value = normalizeAdminItems(await api(listPath()));
  } catch (e) {
    rows.value = [];
    loadError.value = marketErrorText(e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => { void load(); });

function onFilterChange(): void {
  void load();
}

// ── 状态迁移（§7-5：publish / retire）────────────────────────────────────────
async function transition(row: AdminMarketItem, action: 'publish' | 'retire'): Promise<void> {
  if (busyId.value !== null) return;
  busyId.value = row.id;
  actionError.value = null;
  resultText.value = null;
  try {
    await api(`${adminMarketItemPath(row.id)}/${action}`, { method: 'POST', body: '{}' });
    await load(); // 状态以服务端为准：迁移动作可能改版本（publish 记 published_at）
    resultText.value = action === 'publish'
      ? t('admin.market.resultPublished', { slug: row.slug })
      : t('admin.market.resultRetired', { slug: row.slug });
  } catch (e) {
    actionError.value = marketErrorText(e);
  } finally {
    busyId.value = null;
  }
}

// ── 详情（§7-7：文件清单 + 扫描结果，不回包内容）──────────────────────────────
const detail = ref<AdminMarketDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);

/** 凭据区（#608 §8.1）：只在 `kind='mcp'` 的详情里出现；内容只有声明 + 有没有值。 */
const secretSlots = ref<McpSecretSlot[]>([]);
const secretsLoading = ref(false);
const secretsError = ref<string | null>(null);
/** 上一次写值的结果句（只会是「已设置 / 已清除」这类话，**永远不是值**）。 */
const secretResult = ref<string | null>(null);

/**
 * 读凭据声明（GET 只回 `has_value`，永不回值）。它失败不影响详情其余部分（各自一条错误行）。
 * 地址只可能是 `…/items/:id/secrets`：不带 query，也不存在「按槽名读值」的子路径（§7.2）。
 */
async function loadSecrets(id: string): Promise<void> {
  secretsLoading.value = true;
  secretsError.value = null;
  try {
    secretSlots.value = normalizeMcpSecrets(await api(adminMarketSecretsPath(id)));
  } catch (e) {
    secretSlots.value = [];
    secretsError.value = marketErrorText(e);
  } finally {
    secretsLoading.value = false;
  }
}

async function openDetail(row: AdminMarketItem): Promise<void> {
  detailError.value = null;
  detailLoading.value = true;
  secretSlots.value = [];
  secretsError.value = null;
  secretResult.value = null;
  try {
    const full = normalizeAdminDetail(await api(adminMarketItemPath(row.id)));
    detail.value = full;
    // 凭据只对 MCP 条目存在（skill 的槽走 `context`，不入加密表）⇒ 不多发一趟注定空读的请求。
    if (full !== null && full.kind === 'mcp') await loadSecrets(full.id || row.id);
  } catch (e) {
    detail.value = null;
    detailError.value = marketErrorText(e);
  } finally {
    detailLoading.value = false;
  }
}

function closeDetail(): void {
  detail.value = null;
  detailError.value = null;
  secretSlots.value = [];
  secretsError.value = null;
  secretResult.value = null;
}

// ── 凭据设值 modal（#608 §3.1：只写不读）──────────────────────────────
const secretFormOpen = ref(false);
/** modal 正在处理哪个槽（null = 关着）。 */
const secretSlotName = ref<string | null>(null);
/** 输入框里的新值；**初值永远是空串**（没有可回填的旧值可读）。 */
const secretValue = ref('');
const secretScope = ref<'global' | 'fde'>('global');
const secretFdeId = ref('');
const secretSaving = ref(false);
const secretFormError = ref<string | null>(null);

function openSecretForm(name: string): void {
  secretSlotName.value = name;
  secretValue.value = '';
  secretScope.value = 'global';
  secretFdeId.value = '';
  secretFormError.value = null;
  secretResult.value = null;
  secretFormOpen.value = true;
}

function closeSecretForm(): void {
  secretFormOpen.value = false;
  secretSlotName.value = null;
  secretValue.value = '';
}

/**
 * 保存（PUT）：`values:{NAME: 文本 | null}`。空串提交发 `null`（§7.2：`null` = 删除该值），
 * 发空串会被存成一个真的空值。成功后只重读声明 ⇒ 屏上变的只是 `has_value` 那一格。
 */
async function saveSecret(): Promise<void> {
  const name = secretSlotName.value;
  const id = detail.value?.id ?? '';
  if (name === null || id === '' || secretSaving.value) return;
  secretSaving.value = true;
  secretFormError.value = null;
  try {
    const value = secretValue.value;
    await api(adminMarketSecretsPath(id), {
      method: 'PUT',
      body: buildSecretPayload(
        { [name]: value === '' ? null : value },
        secretScope.value,
        secretFdeId.value,
      ),
    });
    secretResult.value = value === ''
      ? t('admin.market.secrets.cleared', { name })
      : t('admin.market.secrets.setResult', { name });
    closeSecretForm();
    await loadSecrets(id);
  } catch (e) {
    // 503 `secret_key_missing` 走凭据区自己的文案（§3.1：没 key 时写入失败且解密路径不可用）。
    secretFormError.value = (e as { code?: string }).code === 'secret_key_missing'
      ? t('admin.market.secrets.keyMissing')
      : marketErrorText(e);
  } finally {
    secretSaving.value = false;
  }
}

// ── 发布 / 编辑表单（§8：元数据 + 多文件选择，浏览器侧打包）──────────────────
interface FormState {
  slug: string;
  name: string;
  summary: string;
  when_to_use: string;
  version: string;
  author: string;
  tags: string;
  license: string;
  description_md: string;
  /** §4.4：`skill` / `mcp`（切换后下面整块字段组与包体区互斥）。 */
  kind: 'skill' | 'mcp';
}

const emptyForm = (): FormState => ({
  slug: '', name: '', summary: '', when_to_use: '', version: '',
  author: '', tags: '', license: '', description_md: '', kind: 'skill',
});

const formOpen = ref(false);
/** 非 null ⇒ 本次是编辑（PUT）；null ⇒ 新建发布（POST）。 */
const editingId = ref<string | null>(null);
const form = ref<FormState>(emptyForm());
/**
 * MCP 字段组（§8.1）。与 `form` 分开存：切 `kind` 时不丢已填的包元数据，也不把 MCP 那几格
 * 混进 skill 的 payload（§4.4：skill 带 `reason` ⇒ 服务端忽略，但前端不该去试）。
 */
const mcpForm = ref<McpFormDraft>(emptyMcpForm());
const picked = ref<File[]>([]);
const pathIssues = ref<BundlePathIssue[]>([]);
const submitting = ref(false);
const formError = ref<string | null>(null);
const fieldError = ref<AdminFieldKey | null>(null);
/** 上一次提交的扫描结果（§3：advisory，发布后要在页面上看得见）。 */
const scanResult = ref<AdminMarketDetail | null>(null);
/** 编辑时「补全元数据的那次详情读失败了」——界面必须说清那几格可能是空的（不假装表单是全的）。 */
const editPrefillFailed = ref(false);

const formTitle = computed(() =>
  (editingId.value === null ? t('admin.market.createTitle') : t('admin.market.editTitle')));
const submitLabel = computed(() =>
  (editingId.value === null ? t('admin.market.submitCreate') : t('admin.market.submitSave')));

function openCreate(): void {
  form.value = emptyForm();
  mcpForm.value = emptyMcpForm();
  editingId.value = null;
  picked.value = [];
  pathIssues.value = [];
  mcpIssues.value = [];
  formError.value = null;
  fieldError.value = null;
  scanResult.value = null;
  formOpen.value = true;
}

/** 详情里的 MCP 配置 → 表单草稿（§8.1 编辑回填；数字转文本，数组按行拼）。 */
function mcpDraftFrom(detail: AdminMarketDetail): McpFormDraft {
  const mcp = detail.mcp;
  return {
    transport: mcp.transport === 'http' ? 'http' : mcp.transport === 'stdio' ? 'stdio' : 'stdio',
    command: mcp.command,
    args: mcp.args.join('\n'),
    url: mcp.url,
    exposure: mcp.exposure === '' ? 'deferred' : mcp.exposure,
    lifecycle: mcp.lifecycle === '' ? 'run' : mcp.lifecycle,
    timeoutMs: mcp.timeoutMs === null ? '' : String(mcp.timeoutMs),
    reason: mcp.reason ?? '',
    slots: mcp.slots.map((slot) => ({
      name: slot.name,
      kind: slot.kind === 'config' ? 'config' : 'secret',
      required: slot.required,
      description: slot.description,
    })),
  };
}

/**
 * 编辑：先用列表行填能填的，再取一次详情把 §7-3 列表**不保证带**的那几格补上。
 *
 * 为什么必须先取详情：`when_to_use` 是必填（§3），而列表 DTO 里它可能缺席。直接开表单 ⇒
 * 管理员只改版本号，PUT 却把 `when_to_use` 发成空串 ⇒ 服务端 400 或**把原值清空**。
 * 详情读失败（404 / 网络）⇒ 那几格留空，但**页面上说清楚**（`detailMissingHint`），
 * 让管理员知道要重写而不是以为表单是全的。
 */
async function openEdit(row: AdminMarketItem): Promise<void> {
  form.value = {
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    when_to_use: '',
    version: row.version,
    author: '',
    tags: row.tags.join(', '),
    license: '',
    description_md: '',
    // 种类先按列表行定（§7-3 的列表带 `kind`）；MCP 那几格等详情回来再填。
    kind: row.kind === 'mcp' ? 'mcp' : 'skill',
  };
  editingId.value = row.id;
  picked.value = [];
  pathIssues.value = [];
  mcpIssues.value = [];
  formError.value = null;
  fieldError.value = null;
  editPrefillFailed.value = false;
  scanResult.value = null;
  mcpForm.value = emptyMcpForm();
  formOpen.value = true;
  try {
    const full = normalizeAdminDetail(await api(adminMarketItemPath(row.id)));
    if (full === null || editingId.value !== row.id) return;
    // 只补**没填过**的格子：详情在路上时管理员可能已经敲了字，别覆盖他的输入。
    form.value.when_to_use = form.value.when_to_use || full.whenToUse;
    form.value.description_md = form.value.description_md || full.descriptionMd;
    form.value.author = form.value.author || (full.author ?? '');
    form.value.license = form.value.license || (full.license ?? '');
    if (full.kind === 'mcp' && mcpForm.value.slots.length === 0 && mcpForm.value.reason === '') {
      form.value.kind = 'mcp';
      mcpForm.value = mcpDraftFrom(full);
    }
  } catch {
    if (editingId.value === row.id) editPrefillFailed.value = true;
  }
}

function closeForm(): void {
  formOpen.value = false;
}

function onFilesPicked(event: Event): void {
  const input = event.target as HTMLInputElement;
  picked.value = Array.from(input.files ?? []);
  // 不 reset input.value：表单还开着时要能看见已选清单（重选会整体替换，语义一致）。
}

const pickedPaths = computed(() => picked.value.map((file) => bundlePathOf(file)));
const pickedBytes = computed(() => picked.value.reduce((sum, file) => sum + file.size, 0));

/** 「一眼假」的 path 判据在 lib（纯函数），这里只做显示与拦提交。 */
const PATH_ISSUE_KEY: Record<BundlePathIssueCode, string> = {
  empty: 'admin.market.pathIssue.empty',
  absolute: 'admin.market.pathIssue.absolute',
  separator: 'admin.market.pathIssue.separator',
  parentRef: 'admin.market.pathIssue.parentRef',
  tooLong: 'admin.market.pathIssue.tooLong',
};

function issueText(issue: BundlePathIssue): string {
  return `${issue.path || '∅'} · ${t(PATH_ISSUE_KEY[issue.code])}`;
}

// ── MCP 字段组的派生量与拦项（§4.2 / §8.1）───────────────────────────────

const isMcp = computed(() => form.value.kind === 'mcp');
const mcpIssues = ref<McpFormIssue[]>([]);

/** 槽位 `inject` 由 transport 锁死（§4.2）；transport 不认识 ⇒ `null`（不锁也不猜）。 */
const lockedInject = computed(() => injectForTransport('mcp', mcpForm.value.transport));

/** transport 的只读说明：把「为什么这个格不能选」写在界面上，而不是让人去猜矩阵。 */
const injectLockText = computed(() =>
  t('admin.market.form.mcp.injectLocked', {
    transport: mcpForm.value.transport,
    inject: lockedInject.value ?? '—',
  }));

const MCP_ISSUE_KEY: Record<McpFormIssue['code'], string> = {
  reasonMissing: 'admin.market.form.mcp.issueReason',
  commandMissing: 'admin.market.form.mcp.issueCommand',
  urlMissing: 'admin.market.form.mcp.issueUrl',
  timeoutInvalid: 'admin.market.form.mcp.issueTimeout',
  slotNameMissing: 'admin.market.form.mcp.issueSlotName',
  slotNameDuplicate: 'admin.market.form.mcp.issueSlotDuplicate',
};

function mcpIssueText(issue: McpFormIssue): string {
  const text = t(MCP_ISSUE_KEY[issue.code]);
  return issue.detail === undefined ? text : `${text} · ${issue.detail}`;
}

/** 改 transport ⇒ 所有槽的 inject 跟着重锁（锁的是派生量，不是存在槽里的值，所以无需回写）。 */
function onTransportChange(): void {
  mcpIssues.value = [];
}

function addSlot(): void {
  mcpForm.value.slots.push(emptyMcpSlot());
}

function removeSlot(index: number): void {
  mcpForm.value.slots.splice(index, 1);
}

/** 详情里的 MCP 配置摘要行（只读，不拼任何值）。 */
function mcpSummaryLine(mcp: AdminMarketDetail['mcp']): string {
  const endpoint = mcp.transport === 'http'
    ? (mcp.url || '—')
    : [mcp.command, ...mcp.args].filter((x) => x !== '').join(' ') || '—';
  return `${mcp.transport || '—'} · ${endpoint}`;
}

/** 请求体：只带填了的可选字段（`undefined` 会被 JSON 丢掉 ⇒ 不发送空串冒充「填过了」）。 */
function buildPayload(bundle?: { files: unknown[] }) {
  const tags = form.value.tags.split(',').map((x) => x.trim()).filter((x) => x !== '');
  const mcpFields = isMcp.value ? buildMcpFields(mcpForm.value) : {};
  return {
    slug: form.value.slug,
    name: form.value.name,
    summary: form.value.summary,
    when_to_use: form.value.when_to_use,
    version: form.value.version,
    author: form.value.author === '' ? undefined : form.value.author,
    tags: tags.length > 0 ? tags : undefined,
    license: form.value.license === '' ? undefined : form.value.license,
    description_md: form.value.description_md === '' ? undefined : form.value.description_md,
    kind: form.value.kind,
    // 契约 §7.2 只钉了「`kind='mcp'` 的字段面 = §4」，没钉这些键进服务端后落在**顶层还是 `manifest`**；
    // 两处发同一份 `buildMcpFields()` 输出 ⇒ 后端读哪边都对，也不会出现两份矛盾的值。
    ...mcpFields,
    ...(isMcp.value ? { manifest: mcpFields } : {}),
    bundle,
  };
}

async function submit(): Promise<void> {
  if (submitting.value) return;
  formError.value = null;
  fieldError.value = null;
  pathIssues.value = [];
  mcpIssues.value = [];
  const files = picked.value;
  // ② MCP：只挡 `checkMcpForm` 那几条一眼假（缺 reason / 缺 command|url / timeout 非法 / 槽名重名），
  //    **有问题就不发请求**；其余组合矩阵、保留名、url 协议全交给服务端（§4.1）。
  if (isMcp.value) {
    const issues = checkMcpForm(mcpForm.value);
    if (issues.length > 0) {
      mcpIssues.value = issues;
      fieldError.value = issues[0].code === 'reasonMissing' ? 'reason' : 'slots';
      return;
    }
  }
  // ① 前端只挡明显非法的 path；**有非法 path 就不发请求**（不发一个必然 400 的体）。
  const issues = checkBundlePaths(pickedPaths.value);
  if (issues.length > 0) {
    pathIssues.value = issues;
    fieldError.value = 'bundle';
    return;
  }
  submitting.value = true;
  try {
    // 编辑且没重选文件 ⇒ 不带 `bundle`（§7-4：只改元数据）。
    const bundle = files.length > 0 ? await buildBundle(files) : undefined;
    const creating = editingId.value === null;
    const url = creating ? ADMIN_MARKET_ITEMS_PATH : adminMarketItemPath(editingId.value as string);
    const saved = normalizeAdminDetail(
      await api(url, { method: creating ? 'POST' : 'PUT', body: JSON.stringify(buildPayload(bundle)) }),
    );
    scanResult.value = saved;
    resultText.value = creating
      ? t('admin.market.resultCreated', { slug: form.value.slug })
      : t('admin.market.resultUpdated', { slug: form.value.slug });
    formOpen.value = false;
    await load();
  } catch (e) {
    formError.value = marketErrorText(e);
    fieldError.value = validationFieldOf(e);
  } finally {
    submitting.value = false;
  }
}

/** 某格有 400 命中时的样式（认不出字段就整表一条错误，不猜）。 */
function invalid(key: AdminFieldKey): boolean {
  return fieldError.value === key;
}
</script>

<template>
  <section data-test="admin-market" class="grid gap-3">
    <header class="grid gap-1">
      <h2 class="text-lg font-medium">{{ t('admin.market.title') }}</h2>
      <p class="text-xs text-black/55">{{ t('admin.market.intro') }}</p>
    </header>

    <div class="flex flex-wrap items-center gap-3">
      <button
        data-test="market-create-open"
        type="button"
        class="rounded-md bg-brand px-3 py-1 text-sm text-white"
        @click="openCreate"
      >{{ t('admin.market.createTitle') }}</button>
      <label class="flex items-center gap-1 text-xs text-black/55">
        {{ t('admin.market.filterLabel') }}
        <select
          v-model="stateFilter"
          data-test="market-filter"
          class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
          @change="onFilterChange"
        >
          <option value="">{{ t('admin.market.filterAll') }}</option>
          <option v-for="state in CAPABILITY_STATES" :key="state" :value="state">
            {{ t(stateMessageKey(state)) }}
          </option>
        </select>
      </label>
      <button
        data-test="market-reload"
        type="button"
        class="rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5 disabled:opacity-50"
        :disabled="loading"
        @click="load()"
      >{{ t('admin.market.reload') }}</button>
    </div>

    <p v-if="loading" data-test="market-loading" class="text-sm text-black/50" role="status">
      {{ t('admin.market.loading') }}
    </p>
    <p v-if="loadError" data-test="market-load-error" class="syserr text-sm" role="alert">
      {{ loadError }}
    </p>
    <p v-if="actionError" data-test="market-error" class="syserr text-sm" role="alert">
      {{ actionError }}
    </p>
    <p v-if="resultText" data-test="market-result" class="text-sm text-black/60" role="status">
      {{ resultText }}
    </p>

    <table class="w-full text-left text-sm">
      <thead class="text-xs text-black/55">
        <tr>
          <th class="py-1 pr-2">{{ t('admin.market.colState') }}</th>
          <th class="py-1 pr-2">{{ t('admin.market.colSlug') }}</th>
          <th class="py-1 pr-2">{{ t('admin.market.colVersion') }}</th>
          <th class="py-1 pr-2">{{ t('admin.market.colInstalls') }}</th>
          <th class="py-1 pr-2">{{ t('admin.market.colScore') }}</th>
          <th class="py-1">{{ t('admin.market.colActions') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.id || row.slug"
          :data-test="`market-row-${row.slug}`"
          class="border-t border-black/10"
        >
          <td class="py-1 pr-2 text-black/70">{{ t(stateMessageKey(row.state)) }}</td>
          <td class="py-1 pr-2"><code>{{ row.slug }}</code></td>
          <td class="py-1 pr-2">{{ row.version || '—' }}</td>
          <td class="py-1 pr-2">{{ countText(row.installs) }}</td>
          <td class="py-1 pr-2">{{ countText(row.securityScore) }}</td>
          <td class="py-1">
            <div class="flex flex-wrap gap-1">
              <button
                v-if="row.state !== 'published'"
                :data-test="`market-publish-${row.slug}`"
                type="button"
                class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5 disabled:opacity-50"
                :disabled="busyId !== null"
                @click="transition(row, 'publish')"
              >{{ t('admin.market.publish') }}</button>
              <button
                v-if="row.state === 'published'"
                :data-test="`market-retire-${row.slug}`"
                type="button"
                class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5 disabled:opacity-50"
                :disabled="busyId !== null"
                @click="transition(row, 'retire')"
              >{{ t('admin.market.retire') }}</button>
              <button
                :data-test="`market-edit-${row.slug}`"
                type="button"
                class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
                @click="openEdit(row)"
              >{{ t('admin.market.edit') }}</button>
              <button
                :data-test="`market-detail-${row.slug}`"
                type="button"
                class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
                @click="openDetail(row)"
              >{{ t('admin.market.detail') }}</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    <p
      v-if="!loading && !loadError && rows.length === 0"
      data-test="market-empty"
      class="text-sm text-black/50"
    >{{ t('admin.market.empty') }}</p>

    <!-- 详情：文件清单 + 扫描结果（§7-7，不回包内容）-->
    <section
      v-if="detail !== null || detailLoading || detailError !== null"
      data-test="market-detail"
      class="grid w-full max-w-2xl gap-2 rounded-lg border border-black/10 p-3"
    >
      <div class="flex items-center gap-2">
        <h3 class="min-w-0 flex-1 truncate text-sm font-medium">
          {{ detail ? `${detail.slug} · ${detail.version}` : '' }}
        </h3>
        <button
          data-test="market-detail-close"
          type="button"
          class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
          @click="closeDetail"
        >{{ t('admin.market.close') }}</button>
      </div>
      <p v-if="detailLoading" data-test="market-detail-loading" class="text-sm text-black/50">
        {{ t('admin.market.detailLoading') }}
      </p>
      <p v-if="detailError" data-test="market-detail-error" class="syserr text-sm" role="alert">
        {{ detailError }}
      </p>
      <template v-if="detail">
        <p data-test="market-detail-scan" class="text-xs text-black/60">
          {{ t('admin.market.scanScore', { score: countText(detail.securityScore) }) }}
        </p>
        <ul v-if="detail.warnings.length" data-test="market-detail-warnings" class="grid gap-0.5 text-xs text-black/60">
          <li
            v-for="(warning, index) in detail.warnings"
            :key="`${warning.code}-${index}`"
            :data-test="`market-warning-${index}`"
          >
            <code>{{ warning.code ?? '—' }}</code>
            <span v-if="warning.path"> · {{ warning.path }}<span v-if="warning.line !== null">:{{ warning.line }}</span></span>
            <span v-if="warning.note"> — {{ warning.note }}</span>
          </li>
        </ul>
        <p v-else data-test="market-detail-warnings-none" class="text-xs text-black/45">
          {{ t('admin.market.scanClean') }}
        </p>
        <div data-test="market-detail-files">
          <h4 class="text-xs font-semibold text-black/55">{{ t('admin.market.files') }}</h4>
          <p v-if="detail.files.length === 0" class="text-xs text-black/45">
            {{ t('admin.market.filesUnknown') }}
          </p>
          <ul v-else class="grid gap-0.5 text-xs text-black/60">
            <li v-for="file in detail.files" :key="file.path" class="flex justify-between gap-2">
              <code class="break-all">{{ file.path }}</code>
              <span class="shrink-0">{{ bytesText(file.bytes) }}</span>
            </li>
          </ul>
        </div>

        <!-- MCP 连接声明（#608 §8.1）：只读摘要，不拼任何凭据值 -->
        <div v-if="detail.kind === 'mcp'" data-test="market-detail-mcp" class="grid gap-1">
          <h4 class="text-xs font-semibold text-black/55">{{ t('admin.market.form.mcp.title') }}</h4>
          <p data-test="detail-mcp-endpoint" class="text-xs text-black/60">
            {{ mcpSummaryLine(detail.mcp) }}
          </p>
          <p class="text-xs text-black/60">
            <span data-test="detail-mcp-exposure">{{ t(exposureMessageKey(detail.exposure ?? detail.mcp.exposure)) }}</span>
            ·
            <span>{{ t('admin.market.form.mcp.lifecycle') }}: {{ detail.mcp.lifecycle || '—' }}</span>
            ·
            <span>{{ t('admin.market.form.mcp.timeout') }}: {{ detail.mcp.timeoutMs === null ? '—' : detail.mcp.timeoutMs }}</span>
          </p>
          <p data-test="detail-mcp-reason" v-if="detail.reason !== null" class="text-xs text-black/60">
            {{ t('admin.market.form.mcp.reason') }}: {{ t(reasonMessageKey(detail.reason)) }}
          </p>
        </div>

        <!-- 工具清单（§8.1：`manifest.tools_cache` + `tools_cache_at`；portal 不连 server，没回填过就是空）-->
        <div v-if="detail.kind === 'mcp'" data-test="market-detail-toolscache" class="grid gap-1">
          <h4 class="text-xs font-semibold text-black/55">{{ t('admin.market.toolsCacheTitle') }}</h4>
          <p v-if="detail.tools.length === 0" data-test="market-detail-toolscache-none" class="text-xs text-black/45">
            {{ t('admin.market.toolsCacheEmpty') }}
          </p>
          <template v-else>
            <p data-test="market-detail-toolscache-at" class="text-[11px] text-black/45">
              {{ t('admin.market.toolsCacheAt', { at: detail.mcp.toolsCacheAt ?? '—' }) }}
            </p>
            <ul class="grid gap-0.5 text-xs text-black/60">
              <li v-for="tool in detail.tools" :key="tool.name">
                <code>{{ tool.name }}</code>
                <span v-if="tool.description"> — {{ tool.description }}</span>
              </li>
            </ul>
          </template>
        </div>

        <!-- 凭据区（§8.1 + §3.1：只写不读。每行只有 name / kind / has_value / updated_at）-->
        <div v-if="detail !== null && detail.kind === 'mcp'" data-test="market-secrets" class="grid gap-1">
          <h4 class="text-xs font-semibold text-black/55">{{ t('admin.market.secrets.title') }}</h4>
          <p class="text-[11px] text-black/45">{{ t('admin.market.secrets.hint') }}</p>
          <p v-if="secretsLoading" data-test="secrets-loading" class="text-xs text-black/50" role="status">
            {{ t('admin.market.secrets.loading') }}
          </p>
          <p v-if="secretsError" data-test="secrets-error" class="syserr text-xs" role="alert">
            {{ secretsError }}
          </p>
          <p
            v-else-if="!secretsLoading && secretSlots.length === 0"
            data-test="secrets-none"
            class="text-xs text-black/45"
          >{{ t('admin.market.secrets.noSlots') }}</p>
          <ul v-if="secretSlots.length" class="grid gap-1">
            <li
              v-for="slot in secretSlots"
              :key="slot.name"
              :data-test="`secret-row-${slot.name}`"
              class="flex flex-wrap items-center gap-2 text-xs text-black/70"
            >
              <code class="break-all">{{ slot.name }}</code>
              <span class="text-black/45">{{ t(`admin.market.secrets.kind.${slot.kind === 'config' ? 'config' : 'secret'}`) }}</span>
              <span
                :data-test="`secret-has-value-${slot.name}`"
                :class="slot.hasValue ? 'text-black/60' : 'text-black/45'"
              >{{ t(slot.hasValue ? 'admin.market.secrets.hasValue' : 'admin.market.secrets.missing') }}</span>
              <span class="text-black/45">{{ slot.updatedAt ?? '—' }}</span>
              <button
                :data-test="`secret-set-${slot.name}`"
                type="button"
                class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
                @click="openSecretForm(slot.name)"
              >{{ t('admin.market.secrets.set') }}</button>
            </li>
          </ul>
          <p v-if="secretResult" data-test="secrets-result" class="text-xs text-black/60" role="status">
            {{ secretResult }}
          </p>
        </div>
      </template>
    </section>

    <!-- 发布 / 编辑 modal（§8）-->
    <ModalShell
      v-if="formOpen"
      :label="formTitle"
      dialog-class="md:w-[34rem]"
      @close="closeForm"
    >
      <form data-test="market-form" class="grid max-h-[80vh] gap-2 overflow-y-auto p-3" @submit.prevent="submit">
        <h3 class="text-base font-medium">{{ formTitle }}</h3>
        <p class="text-xs text-black/55">{{ t('admin.market.formIntro') }}</p>
        <p
          v-if="editPrefillFailed"
          data-test="form-prefill-failed"
          class="syserr text-xs"
          role="alert"
        >{{ t('admin.market.detailMissingHint') }}</p>

        <!-- 条目种类（#608 §8.1）：切换后下面的字段组与包体区互斥 -->
        <label class="flex flex-col gap-1 text-xs text-black/55">
          {{ t('admin.market.fKind') }}
          <select
            v-model="form.kind"
            data-test="field-kind"
            class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
          >
            <option value="skill">{{ t('market.kind.skill') }}</option>
            <option value="mcp">{{ t('market.kind.mcp') }}</option>
          </select>
          <span class="text-[11px] text-black/45">{{ t('admin.market.kindHint') }}</span>
        </label>

        <label class="flex flex-col gap-1 text-xs text-black/55">
          {{ t('admin.market.fSlug') }}
          <input
            v-model="form.slug"
            data-test="field-slug"
            type="text"
            class="rounded-md border border-black/20 px-2 py-1 text-sm"
            :aria-invalid="invalid('slug') ? 'true' : undefined"
          >
          <span class="text-[11px] text-black/45">{{ t('admin.market.slugHint') }}</span>
        </label>

        <label class="flex flex-col gap-1 text-xs text-black/55">
          {{ t('admin.market.fName') }}
          <input
            v-model="form.name"
            data-test="field-name"
            type="text"
            class="rounded-md border border-black/20 px-2 py-1 text-sm"
            :aria-invalid="invalid('name') ? 'true' : undefined"
          >
        </label>

        <label class="flex flex-col gap-1 text-xs text-black/55">
          {{ t('admin.market.fSummary') }}
          <input
            v-model="form.summary"
            data-test="field-summary"
            type="text"
            class="rounded-md border border-black/20 px-2 py-1 text-sm"
            :aria-invalid="invalid('summary') ? 'true' : undefined"
          >
        </label>

        <label class="flex flex-col gap-1 text-xs text-black/55">
          {{ t('admin.market.fWhenToUse') }}
          <textarea
            v-model="form.when_to_use"
            data-test="field-when_to_use"
            rows="2"
            class="rounded-md border border-black/20 px-2 py-1 text-sm"
            :aria-invalid="invalid('when_to_use') ? 'true' : undefined"
          ></textarea>
          <span class="text-[11px] text-black/45">{{ t('admin.market.whenToUseHint') }}</span>
        </label>

        <label class="flex flex-col gap-1 text-xs text-black/55">
          {{ t('admin.market.fVersion') }}
          <input
            v-model="form.version"
            data-test="field-version"
            type="text"
            class="rounded-md border border-black/20 px-2 py-1 text-sm"
            :aria-invalid="invalid('version') ? 'true' : undefined"
          >
        </label>

        <label class="flex flex-col gap-1 text-xs text-black/55">
          {{ t('admin.market.fAuthor') }}
          <input v-model="form.author" data-test="field-author" type="text" class="rounded-md border border-black/20 px-2 py-1 text-sm">
        </label>

        <label class="flex flex-col gap-1 text-xs text-black/55">
          {{ t('admin.market.fTags') }}
          <input
            v-model="form.tags"
            data-test="field-tags"
            type="text"
            class="rounded-md border border-black/20 px-2 py-1 text-sm"
          >
          <span class="text-[11px] text-black/45">{{ t('admin.market.tagsHint') }}</span>
        </label>

        <label class="flex flex-col gap-1 text-xs text-black/55">
          {{ t('admin.market.fLicense') }}
          <input v-model="form.license" data-test="field-license" type="text" class="rounded-md border border-black/20 px-2 py-1 text-sm">
        </label>

        <label class="flex flex-col gap-1 text-xs text-black/55">
          {{ t('admin.market.fDescription') }}
          <textarea v-model="form.description_md" data-test="field-description_md" rows="2" class="rounded-md border border-black/20 px-2 py-1 text-sm"></textarea>
        </label>

        <!-- MCP 字段组（#608 §8.1）：连接声明 + 准入理由 + 配置槽；没有包体 -->
        <div v-if="isMcp" data-test="form-mcp" class="grid gap-2 border-t border-black/10 pt-2">
          <span class="text-xs font-semibold text-black/55">{{ t('admin.market.form.mcp.title') }}</span>

          <label class="flex flex-col gap-1 text-xs text-black/55">
            {{ t('admin.market.form.mcp.transport') }}
            <select
              v-model="mcpForm.transport"
              data-test="field-transport"
              class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
              :aria-invalid="invalid('transport') ? 'true' : undefined"
              @change="onTransportChange"
            >
              <option v-for="item in MCP_TRANSPORTS" :key="item" :value="item">{{ item }}</option>
            </select>
            <span class="text-[11px] text-black/45">{{ t('admin.market.form.mcp.transportHint') }}</span>
          </label>

          <template v-if="mcpForm.transport === 'http'">
            <label class="flex flex-col gap-1 text-xs text-black/55">
              {{ t('admin.market.form.mcp.url') }}
              <input
                v-model="mcpForm.url"
                data-test="field-url"
                type="text"
                class="rounded-md border border-black/20 px-2 py-1 text-sm"
                :aria-invalid="invalid('url') ? 'true' : undefined"
              >
              <span class="text-[11px] text-black/45">{{ t('admin.market.form.mcp.urlHint') }}</span>
            </label>
          </template>
          <template v-else>
            <label class="flex flex-col gap-1 text-xs text-black/55">
              {{ t('admin.market.form.mcp.command') }}
              <input
                v-model="mcpForm.command"
                data-test="field-command"
                type="text"
                class="rounded-md border border-black/20 px-2 py-1 text-sm"
                :aria-invalid="invalid('command') ? 'true' : undefined"
              >
              <span class="text-[11px] text-black/45">{{ t('admin.market.form.mcp.commandHint') }}</span>
            </label>
            <label class="flex flex-col gap-1 text-xs text-black/55">
              {{ t('admin.market.form.mcp.args') }}
              <textarea
                v-model="mcpForm.args"
                data-test="field-args"
                rows="2"
                class="rounded-md border border-black/20 px-2 py-1 text-sm"
              ></textarea>
              <span class="text-[11px] text-black/45">{{ t('admin.market.form.mcp.argsHint') }}</span>
            </label>
          </template>

          <label class="flex flex-col gap-1 text-xs text-black/55">
            {{ t('admin.market.form.mcp.exposure') }}
            <select
              v-model="mcpForm.exposure"
              data-test="field-exposure"
              class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
            >
              <option v-for="item in MCP_EXPOSURES" :key="item" :value="item">{{ item }}</option>
            </select>
            <!-- 三档各一行解释（§4.3 的可观察差异；选哪档就说哪档的话）-->
            <span
              data-test="mcp-exposure-hint"
              class="text-[11px] text-black/45"
            >{{ t(`admin.market.form.mcp.exposureHint.${mcpForm.exposure === 'direct' || mcpForm.exposure === 'deferred' || mcpForm.exposure === 'hidden' ? mcpForm.exposure : 'deferred'}`) }}</span>
          </label>

          <div class="flex flex-wrap items-start gap-3">
            <label class="flex min-w-0 flex-1 flex-col gap-1 text-xs text-black/55">
              {{ t('admin.market.form.mcp.lifecycle') }}
              <select
                v-model="mcpForm.lifecycle"
                data-test="field-lifecycle"
                class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
              >
                <option v-for="item in MCP_LIFECYCLES" :key="item" :value="item">{{ item }}</option>
              </select>
              <span class="text-[11px] text-black/45">{{ t('admin.market.form.mcp.lifecycleHint') }}</span>
            </label>
            <label class="flex min-w-0 flex-1 flex-col gap-1 text-xs text-black/55">
              {{ t('admin.market.form.mcp.timeout') }}
              <input
                v-model="mcpForm.timeoutMs"
                data-test="field-timeout_ms"
                type="text"
                inputmode="numeric"
                class="rounded-md border border-black/20 px-2 py-1 text-sm"
                :aria-invalid="invalid('timeout_ms') ? 'true' : undefined"
              >
              <span class="text-[11px] text-black/45">{{ t('admin.market.form.mcp.timeoutHint') }}</span>
            </label>
          </div>

          <label class="flex flex-col gap-1 text-xs text-black/55">
            {{ t('admin.market.form.mcp.reason') }}
            <select
              v-model="mcpForm.reason"
              data-test="field-reason"
              class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
              :aria-invalid="invalid('reason') ? 'true' : undefined"
            >
              <option value="">{{ t('admin.market.form.mcp.reasonPick') }}</option>
              <option v-for="item in MCP_REASONS" :key="item" :value="item">
                {{ t(reasonMessageKey(item)) }}
              </option>
            </select>
            <span class="text-[11px] text-black/45">{{ t('admin.market.form.mcp.reasonHint') }}</span>
          </label>

          <!-- 配置槽：`inject` 是锁死的只读说明（§4.2 组合矩阵），不是可选下拉 -->
          <div class="grid gap-1 border-t border-black/10 pt-2">
            <div class="flex items-center gap-2">
              <span class="flex-1 text-xs font-semibold text-black/55">{{ t('admin.market.form.mcp.slots') }}</span>
              <button
                data-test="mcp-slot-add"
                type="button"
                class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
                @click="addSlot"
              >{{ t('admin.market.form.mcp.slotAdd') }}</button>
            </div>
            <p data-test="mcp-inject-locked" class="text-[11px] text-black/45">{{ injectLockText }}</p>
            <p v-if="mcpForm.slots.length === 0" data-test="mcp-slots-none" class="text-[11px] text-black/45">
              {{ t('admin.market.form.mcp.slotsNone') }}
            </p>
            <ul class="grid gap-2">
              <li
                v-for="(slot, index) in mcpForm.slots"
                :key="index"
                :data-test="`mcp-slot-${index}`"
                class="grid gap-1 rounded-md border border-black/10 p-2"
              >
                <div class="flex flex-wrap items-center gap-2">
                  <input
                    v-model="slot.name"
                    :data-test="`mcp-slot-${index}-name`"
                    type="text"
                    class="min-w-0 flex-1 rounded-md border border-black/20 px-2 py-1 text-sm"
                    :placeholder="t('admin.market.form.mcp.slotName')"
                  >
                  <select
                    v-model="slot.kind"
                    :data-test="`mcp-slot-${index}-kind`"
                    class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
                  >
                    <option v-for="item in MCP_SLOT_KINDS" :key="item" :value="item">{{ item }}</option>
                  </select>
                  <!-- 只读锁：文案里点名是 transport 决定的，管理员改它只能去改 transport -->
                  <span
                    :data-test="`mcp-slot-${index}-inject`"
                    class="rounded border border-black/10 px-1.5 py-1 text-xs text-black/55"
                  >{{ lockedInject ?? '—' }}</span>
                  <label class="flex items-center gap-1 text-xs text-black/55">
                    <input
                      v-model="slot.required"
                      :data-test="`mcp-slot-${index}-required`"
                      type="checkbox"
                    >
                    {{ t('admin.market.form.mcp.slotRequired') }}
                  </label>
                  <button
                    :data-test="`mcp-slot-${index}-remove`"
                    type="button"
                    class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
                    @click="removeSlot(index)"
                  >{{ t('admin.market.form.mcp.slotRemove') }}</button>
                </div>
                <input
                  v-model="slot.description"
                  :data-test="`mcp-slot-${index}-description`"
                  type="text"
                  class="rounded-md border border-black/20 px-2 py-1 text-sm"
                  :placeholder="t('admin.market.form.mcp.slotDescription')"
                >
              </li>
            </ul>
          </div>

          <ul v-if="mcpIssues.length" data-test="mcp-issues" class="grid gap-0.5 text-xs text-black/70">
            <li v-for="(issue, index) in mcpIssues" :key="index" role="listitem">{{ mcpIssueText(issue) }}</li>
          </ul>
        </div>

        <!-- 多文件选择：浏览器侧读成 base64 bundle（path = webkitRelativePath || name）。MCP 没有包体 -->
        <div v-if="!isMcp" class="grid gap-1 border-t border-black/10 pt-2">
          <span class="text-xs text-black/55">{{ t('admin.market.filesLabel') }}</span>
          <input data-test="field-bundle" type="file" multiple @change="onFilesPicked">
          <p class="text-[11px] text-black/45">{{ t('admin.market.bundleHint') }}</p>
          <p data-test="picked-summary" class="text-xs text-black/60">
            {{ picked.length === 0
              ? t('admin.market.noFilesPicked')
              : t('admin.market.pickedSummary', { count: picked.length, bytes: bytesText(pickedBytes) }) }}
          </p>
          <ul v-if="picked.length" data-test="picked-paths" class="grid gap-0.5 text-[11px] text-black/55">
            <li v-for="(path, index) in pickedPaths" :key="`${path}-${index}`" class="break-all">
              <code>{{ path }}</code>
            </li>
          </ul>
          <ul v-if="pathIssues.length" data-test="path-issues" class="grid gap-0.5 text-xs text-black/70">
            <li v-for="(issue, index) in pathIssues" :key="`${issue.path}-${index}`" role="listitem">
              {{ issueText(issue) }}
            </li>
          </ul>
        </div>

        <p v-if="formError" data-test="form-error" class="syserr text-xs" role="alert">{{ formError }}</p>

        <div class="flex items-center gap-2">
          <button
            data-test="market-submit"
            type="submit"
            class="rounded-md bg-brand px-3 py-1 text-sm text-white disabled:opacity-50"
            :disabled="submitting"
          >{{ submitLabel }}</button>
          <button
            data-test="market-form-cancel"
            type="button"
            class="rounded-md border border-black/20 px-3 py-1 text-sm"
            @click="closeForm"
          >{{ t('admin.market.cancel') }}</button>
        </div>
      </form>
    </ModalShell>

    <!-- 凭据设值 modal（#608 §8.1）：输入框**从不回填旧值**，保存后只重读 `has_value` -->
    <ModalShell
      v-if="secretFormOpen"
      :label="t('admin.market.secrets.setTitle', { name: secretSlotName ?? '' })"
      @close="closeSecretForm"
    >
      <form
        data-test="secret-form"
        class="grid max-h-[80vh] gap-2 overflow-y-auto p-3"
        @submit.prevent="saveSecret"
      >
        <h3 class="text-base font-medium">
          {{ t('admin.market.secrets.setTitle', { name: secretSlotName ?? '' }) }}
        </h3>
        <p class="text-xs text-black/55">{{ t('admin.market.secrets.setHint') }}</p>

        <label class="flex flex-col gap-1 text-xs text-black/55">
          {{ t('admin.market.secrets.valueLabel') }}
          <input
            v-model="secretValue"
            data-test="secret-value"
            type="password"
            autocomplete="new-password"
            class="rounded-md border border-black/20 px-2 py-1 text-sm"
          >
          <span class="text-[11px] text-black/45">{{ t('admin.market.secrets.valueHint') }}</span>
        </label>

        <div class="flex flex-wrap items-start gap-3">
          <label class="flex flex-col gap-1 text-xs text-black/55">
            {{ t('admin.market.secrets.scopeLabel') }}
            <select
              v-model="secretScope"
              data-test="secret-scope"
              class="rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
            >
              <option value="global">{{ t('admin.market.secrets.scopeGlobal') }}</option>
              <option value="fde">{{ t('admin.market.secrets.scopeFde') }}</option>
            </select>
          </label>
          <label v-if="secretScope === 'fde'" class="flex min-w-0 flex-1 flex-col gap-1 text-xs text-black/55">
            {{ t('admin.market.secrets.fdeLabel') }}
            <input
              v-model="secretFdeId"
              data-test="secret-fde-id"
              type="text"
              class="rounded-md border border-black/20 px-2 py-1 text-sm"
            >
          </label>
        </div>

        <p v-if="secretFormError" data-test="secret-error" class="syserr text-xs" role="alert">
          {{ secretFormError }}
        </p>

        <div class="flex items-center gap-2">
          <button
            data-test="secret-submit"
            type="submit"
            class="rounded-md bg-brand px-3 py-1 text-sm text-white disabled:opacity-50"
            :disabled="secretSaving"
          >{{ t('admin.market.secrets.save') }}</button>
          <button
            data-test="secret-cancel"
            type="button"
            class="rounded-md border border-black/20 px-3 py-1 text-sm"
            @click="closeSecretForm"
          >{{ t('admin.market.cancel') }}</button>
        </div>
      </form>
    </ModalShell>

    <!-- 上一次提交的扫描结果（§3：advisory，看得见但不拦发布）-->
    <section
      v-if="scanResult !== null"
      data-test="market-scan-result"
      class="grid max-w-2xl gap-1 rounded-lg border border-black/10 p-3"
    >
      <p class="text-xs text-black/60">
        {{ t('admin.market.scanScore', { score: countText(scanResult.securityScore) }) }}
        ·
        {{ t('admin.market.scanHintCount', { count: scanResult.warnings.length }) }}
      </p>
      <ul class="grid gap-0.5 text-xs text-black/60">
        <li v-for="(warning, index) in scanResult.warnings" :key="`${warning.code}-${index}`">
          <code>{{ warning.code ?? '—' }}</code>
          <span v-if="warning.path"> · {{ warning.path }}</span>
          <span v-if="warning.note"> — {{ warning.note }}</span>
        </li>
      </ul>
    </section>

    <p class="max-w-prose text-xs text-black/40">{{ t('admin.market.footnote') }}</p>
  </section>
</template>
