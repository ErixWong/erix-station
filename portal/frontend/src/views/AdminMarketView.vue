<script setup lang="ts">
// 能力市场 · 管理台 tab（issue #595 M2，契约 §7 管理面 + §8 管理台）。
//
// 这一页是**发布口**，不是校验器。四条口径：
//   ① 文件由浏览器打包成 `{files:[{path, content_base64}]}`（§1 硬约束 2：P0 不引 zip 库），
//      path 取 `webkitRelativePath || name`。
//   ② 前端只挡**一眼假**的 path（绝对路径 / 含 `..` / 含 `\` / 超长 / 空）——目的是不发一个
//      必然 400 的体。文件数 ≤50、单文件 ≤512 KiB、`skill.mjs` 在不在、`skill.id === slug`
//      这些**全在服务端**（`portal/src/market.js#validateBundle`），前端一律不冒充。
//   ③ `400 validation_failed` 的 `details.field` 回来标红那一格（认不出就不标，不猜）。
//   ④ 扫描分数与 warnings 是 **advisory**（§3）：只展示，不拦发布。
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import {
  ADMIN_MARKET_ITEMS_PATH,
  adminMarketItemPath,
  buildBundle,
  bundlePathOf,
  bytesText,
  CAPABILITY_STATES,
  checkBundlePaths,
  countText,
  marketErrorText,
  normalizeAdminDetail,
  normalizeAdminItems,
  stateMessageKey,
  validationFieldOf,
  type AdminFieldKey,
  type AdminMarketDetail,
  type AdminMarketItem,
  type BundlePathIssue,
  type BundlePathIssueCode,
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

async function openDetail(row: AdminMarketItem): Promise<void> {
  detailError.value = null;
  detailLoading.value = true;
  try {
    detail.value = normalizeAdminDetail(await api(adminMarketItemPath(row.id)));
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
}

const emptyForm = (): FormState => ({
  slug: '', name: '', summary: '', when_to_use: '', version: '',
  author: '', tags: '', license: '', description_md: '',
});

const formOpen = ref(false);
/** 非 null ⇒ 本次是编辑（PUT）；null ⇒ 新建发布（POST）。 */
const editingId = ref<string | null>(null);
const form = ref<FormState>(emptyForm());
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
  editingId.value = null;
  picked.value = [];
  pathIssues.value = [];
  formError.value = null;
  fieldError.value = null;
  scanResult.value = null;
  formOpen.value = true;
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
  };
  editingId.value = row.id;
  picked.value = [];
  pathIssues.value = [];
  formError.value = null;
  fieldError.value = null;
  editPrefillFailed.value = false;
  scanResult.value = null;
  formOpen.value = true;
  try {
    const full = normalizeAdminDetail(await api(adminMarketItemPath(row.id)));
    if (full === null || editingId.value !== row.id) return;
    // 只补**没填过**的格子：详情在路上时管理员可能已经敲了字，别覆盖他的输入。
    form.value.when_to_use = form.value.when_to_use || full.whenToUse;
    form.value.description_md = form.value.description_md || full.descriptionMd;
    form.value.author = form.value.author || (full.author ?? '');
    form.value.license = form.value.license || (full.license ?? '');
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

/** 请求体：只带填了的可选字段（`undefined` 会被 JSON 丢掉 ⇒ 不发送空串冒充「填过了」）。 */
function buildPayload(bundle?: { files: unknown[] }) {
  const tags = form.value.tags.split(',').map((x) => x.trim()).filter((x) => x !== '');
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
    bundle,
  };
}

async function submit(): Promise<void> {
  if (submitting.value) return;
  formError.value = null;
  fieldError.value = null;
  pathIssues.value = [];
  const files = picked.value;
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

        <!-- 多文件选择：浏览器侧读成 base64 bundle（path = webkitRelativePath || name）-->
        <div class="grid gap-1 border-t border-black/10 pt-2">
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
