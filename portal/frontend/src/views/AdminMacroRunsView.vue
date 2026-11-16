<script setup lang="ts">
// 管理台 · 宏执行历史（issue #529，事件平台 W6；契约 `10` 篇 §3.3）。
//
// 后端形状（`portal/src/macro-routes.js`，已合并在 main，本单不改）：
//   GET /api/admin/macro-runs?…&cursor&limit  → { items: [toAdminRunItem], nextCursor }
//   GET /api/admin/macro-runs/summary?…        → { triggered, done, skipped, failed, byVerdict, usage:null }
// 三个最容易做错的口径，都在这里钉死：
//   ① **「跳过」单独成列**，不并进「完成」——跳过率高说明参数配错，视觉上却像正常。
//   ② **判决百分比的分母是 `done`（后端给的），不是 `triggered`**：被跳过的没有判决，
//      不该进分母。⚠ 前端**绝不自己再算分母**，直接用后端 `summary.done`。
//   ③ **筛选变了汇总要跟着变**：`filters` 一变就同时重取 list 与 summary（否则数字与列表对不上）。
//
// ⚠ 后端 admin 流水**不含 sessionId / childSessionId**（决策者 2026-11-15）⇒ 没有会话列、
//   没有点进会话的链接。软删模板的「（已删除）」由前端从 `includeDeleted` 的模板表**派生**
//   （后端流水是 INNER JOIN，模板行仍在，但没下发 deleted 标志）。
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import { VERDICT } from '@shared/macro-kinds';
import { formatClock, statusMessageKey, verdictMessageKey } from '../lib/macroView';
import MacroRunFilter, { type MacroRunFilters } from '../components/MacroRunFilter.vue';

const PAGE_LIMIT = 50;

/** 后端 `toAdminRunItem` 的行形状（⚠ 无 session 两列）。 */
interface AdminRunItem {
  id: string;
  startedAt: string;
  templateId: string;
  templateName: string;
  userId: string;
  userName: string;
  anchor: string | null;
  criterion: string | null;
  status: string | null;
  verdict: string | null;
  durationMs: number | null;
  usage: number | null;
}
interface AdminSummary {
  triggered: number;
  done: number;
  skipped: number;
  failed: number;
  byVerdict: Record<string, number>;
  usage: number | null;
}
interface AdminTemplate {
  id: string;
  name: string;
  deleted_at?: string | null;
}

const { t } = useI18n();

const emptyFilters = (): MacroRunFilters => ({
  templateId: '', status: '', verdict: '', from: '', to: '', userId: '',
});

const filters = ref<MacroRunFilters>(emptyFilters());
const items = ref<AdminRunItem[]>([]);
const nextCursor = ref<string | null>(null);
const summary = ref<AdminSummary | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

/** 模板 id → { name, deleted }：来自 `includeDeleted` 的模板表，用于「（已删除）」标记与名字兜底。 */
const templates = ref<Array<{ id: string; name: string }>>([]);
const deletedIds = ref<Set<string>>(new Set());

/** `datetime-local` 的 `2026-11-16T08:30` → ISO（后端 `toTimeParam` 要能 `new Date()` 解析）。 */
function toIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function buildQuery(cursor: string | null): URLSearchParams {
  const q = new URLSearchParams();
  const f = filters.value;
  if (f.templateId) q.set('templateId', f.templateId);
  if (f.status) q.set('status', f.status);
  if (f.verdict) q.set('verdict', f.verdict);
  if (f.userId) q.set('userId', f.userId);
  const from = toIso(f.from);
  if (from) q.set('from', from);
  const to = toIso(f.to);
  if (to) q.set('to', to);
  if (cursor) q.set('cursor', cursor);
  q.set('limit', String(PAGE_LIMIT));
  return q;
}

async function loadList(cursor: string | null): Promise<void> {
  const res = await api<{ items: AdminRunItem[]; nextCursor: string | null }>(
    `/api/admin/macro-runs?${buildQuery(cursor).toString()}`,
  );
  items.value = cursor ? [...items.value, ...res.items] : res.items;
  nextCursor.value = res.nextCursor;
}

async function loadSummary(): Promise<void> {
  // summary 与 list 共用同一份筛选（后端 `adminRunsFilters` 就是同一谓词），但**不带游标**。
  const q = buildQuery(null);
  q.delete('limit');
  summary.value = await api<AdminSummary>(`/api/admin/macro-runs/summary?${q.toString()}`);
}

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    // 顺序无关，但要**同时**刷新列表与汇总——判据③「筛选后汇总跟着变」的实现点就在这里：
    // 把 loadSummary 从这条链里摘掉，汇总就停在旧筛选上，与列表对不上（反向自证③ 打的就是这行）。
    await Promise.all([loadList(null), loadSummary()]);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  if (!nextCursor.value) return;
  loading.value = true;
  error.value = null;
  try {
    await loadList(nextCursor.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

/** 模板名 + 「（已删除）」后缀（软删模板从 `deletedIds` 判定；名字优先用模板表现值）。 */
function templateLabel(run: AdminRunItem): string {
  const known = templates.value.find((x) => x.id === run.templateId);
  const name = known?.name ?? run.templateName;
  return deletedIds.value.has(run.templateId) ? `${name}${t('admin.macroRuns.deletedSuffix')}` : name;
}

function durationText(ms: number | null): string {
  if (ms === null) return t('admin.macroRuns.usageUnknown');
  return `${ms} ms`;
}

/** 判决占比：**分母 = 后端给的 `summary.done`**，不是 `triggered`（红线②）。 */
function verdictPct(verdict: string): number | null {
  const s = summary.value;
  if (!s || s.done <= 0) return null;
  // ⚠ 分母写死 `s.done`：改成 `s.triggered` 会被反向自证① 打红（分母口径漂移）。
  const count = s.byVerdict[verdict] ?? 0;
  return Math.round((count / s.done) * 100);
}

function ratioValue(verdict: string): string {
  const s = summary.value;
  const count = s?.byVerdict[verdict] ?? 0;
  const pct = verdictPct(verdict);
  return t('admin.macroRuns.ratioValue', {
    label: t(verdictMessageKey(verdict)),
    count,
    pct: pct === null ? '—' : pct,
  });
}

onMounted(async () => {
  try {
    const list = await api<{ items: AdminTemplate[] }>('/api/admin/macro-templates?includeDeleted=true');
    templates.value = list.items.map((x) => ({ id: x.id, name: x.name }));
    deletedIds.value = new Set(list.items.filter((x) => x.deleted_at != null).map((x) => x.id));
  } catch {
    /* 模板表拿不到只影响「（已删除）」标记，不阻塞流水加载 */
  }
  await refresh();
});

// 判据③：筛选一变就重取列表 + 汇总。deep watch 是因为 filters 是嵌套对象（此处为平铺但保持一致写法）。
watch(filters, () => { void refresh(); }, { deep: true });
</script>

<template>
  <section data-test="admin-macro-runs" class="grid gap-3">
    <header>
      <h2 class="text-lg font-medium">{{ t('admin.macroRuns.title') }}</h2>
      <p class="mt-1 text-xs text-black/60">{{ t('admin.macroRuns.intro') }}</p>
    </header>

    <MacroRunFilter v-model="filters" scope="admin" :templates="templates" />

    <!-- 汇总（判据①③）：触发 / 完成 / 跳过（单列） / 失败 -->
    <div
      v-if="summary"
      data-test="macro-runs-summary"
      class="grid gap-x-4 gap-y-2 rounded-lg border border-black/10 p-3 text-sm sm:grid-cols-4"
    >
      <div>
        <span class="text-xs text-black/55">{{ t('admin.macroRuns.sumTriggered') }}</span>
        <div data-test="sum-triggered" class="font-mono text-base">{{ summary.triggered }}</div>
      </div>
      <div>
        <span class="text-xs text-black/55">{{ t('admin.macroRuns.sumDone') }}</span>
        <div data-test="sum-done" class="font-mono text-base">{{ summary.done }}</div>
      </div>
      <div>
        <span class="text-xs text-black/55">{{ t('admin.macroRuns.sumSkipped') }}</span>
        <div data-test="sum-skipped" class="font-mono text-base text-amber-700">{{ summary.skipped }}</div>
      </div>
      <div>
        <span class="text-xs text-black/55">{{ t('admin.macroRuns.sumFailed') }}</span>
        <div data-test="sum-failed" class="font-mono text-base text-red-700">{{ summary.failed }}</div>
      </div>
      <p data-test="sum-skipped-hint" class="text-xs text-black/55 sm:col-span-4">
        {{ t('admin.macroRuns.sumSkippedHint') }}
      </p>

      <!-- 判决占比（判据②）：分母 = done -->
      <div class="sm:col-span-4">
        <p class="text-xs font-medium">{{ t('admin.macroRuns.verdictRatio') }}</p>
        <p class="text-[11px] text-black/50">{{ t('admin.macroRuns.ratioNote') }}</p>
        <p v-if="summary.done <= 0" data-test="ratio-no-done" class="text-xs text-black/55">
          {{ t('admin.macroRuns.ratioNoDone') }}
        </p>
        <ul v-else class="mt-1 space-y-0.5">
          <li
            v-for="v in VERDICT"
            :key="v"
            :data-test="'ratio-' + v"
            class="text-xs"
          >{{ ratioValue(v) }}</li>
        </ul>
      </div>
    </div>

    <p v-if="loading" data-test="macro-runs-loading" class="text-sm text-black/60" role="status">
      {{ t('admin.macroRuns.loading') }}
    </p>
    <p v-if="error" data-test="macro-runs-error" class="syserr text-sm" role="alert">{{ error }}</p>

    <p v-if="!loading && items.length === 0 && !error" data-test="macro-runs-empty" class="text-sm text-black/60">
      {{ t('admin.macroRuns.empty') }}
    </p>

    <table v-if="items.length" data-test="macro-runs-table" class="w-full border-collapse text-left text-sm">
      <thead>
        <tr class="text-xs text-black/55">
          <th class="py-1 pr-2">{{ t('admin.macroRuns.colTime') }}</th>
          <th class="py-1 pr-2">{{ t('admin.macroRuns.colTemplate') }}</th>
          <th class="py-1 pr-2">{{ t('admin.macroRuns.colUser') }}</th>
          <th class="py-1 pr-2">{{ t('admin.macroRuns.colStatus') }}</th>
          <th class="py-1 pr-2">{{ t('admin.macroRuns.colVerdict') }}</th>
          <th class="py-1 pr-2">{{ t('admin.macroRuns.colCriterion') }}</th>
          <th class="py-1 pr-2">{{ t('admin.macroRuns.colDuration') }}</th>
          <th class="py-1 pr-2">{{ t('admin.macroRuns.colUsage') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="run in items"
          :key="run.id"
          data-test="macro-run-row"
          :data-template-id="run.templateId"
        >
          <td class="py-1 pr-2 font-mono text-xs">{{ formatClock(run.startedAt) ?? '—' }}</td>
          <td class="py-1 pr-2" data-test="row-template">{{ templateLabel(run) }}</td>
          <td class="py-1 pr-2" data-test="row-user">{{ run.userName }}</td>
          <td class="py-1 pr-2" data-test="row-status">{{ run.status ? t(statusMessageKey(run.status)) : '—' }}</td>
          <td class="py-1 pr-2" data-test="row-verdict">{{ run.verdict ? t(verdictMessageKey(run.verdict)) : '—' }}</td>
          <td class="py-1 pr-2 text-xs">{{ run.criterion ?? '—' }}</td>
          <td class="py-1 pr-2 font-mono text-xs">{{ durationText(run.durationMs) }}</td>
          <td class="py-1 pr-2">{{ t('admin.macroRuns.usageUnknown') }}</td>
        </tr>
      </tbody>
    </table>

    <div class="flex items-center gap-3">
      <button
        v-if="nextCursor"
        type="button"
        data-test="macro-runs-more"
        class="rounded border border-black/15 px-2 py-1 text-xs hover:bg-black/5"
        @click="loadMore"
      >{{ t('admin.macroRuns.loadMore') }}</button>
      <span v-else-if="items.length" data-test="macro-runs-no-more" class="text-xs text-black/50">
        {{ t('admin.macroRuns.noMore') }}
      </span>
    </div>
  </section>
</template>
