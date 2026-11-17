<script setup lang="ts">
// 能力市场 · 用户面（issue #595 M1，契约 `docs/design/capability-market.md` §7 用户面 + §8 工作台）。
//
// 这一页只回答三个动作：安装 / 卸载 / 启停。三条口径：
//   ① **状态显示文字承重**（§8）：「已安装但未启用」是**中性灰字**，不是告警色、不是红黄绿灯。
//      三态判据在 `lib/market.ts#installStateOf`（纯函数可单测），这里只负责给它灰字。
//   ② **动作后一律重读列表**：卡片显示的是服务端事实，不是"我以为装好了"。
//      预算闸（§4：单 FDE 启用 ≤ 12）是 policy，前端**不提前拦**，409 回来照实说。
//   ③ 缺键 ⇒ `—`，不 ⇒ 0（`lib/market.ts` 的归一化保证）。
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import { renderMarkdown } from '../lib/markdown';
import {
  MARKET_ITEMS_PATH,
  bytesText,
  countText,
  exposureMessageKey,
  installStateMessageKey,
  installStateOf,
  kindMessageKey,
  marketErrorText,
  marketUserItemPath,
  MAX_ENABLED_SKILLS,
  normalizeMarketDetail,
  normalizeMarketItems,
  reasonMessageKey,
  type MarketDetail,
  type MarketListItem,
} from '../lib/market';

const { t } = useI18n();

const items = ref<MarketListItem[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
/** 正在处理的 slug（同一时刻只让一张卡的动作按钮禁着，避免连点发两趟）。 */
const busySlug = ref<string | null>(null);
const actionError = ref<string | null>(null);
const resultText = ref<string | null>(null);

// ── 列表 ──────────────────────────────────────────────────────────────────────
async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    items.value = normalizeMarketItems(await api(MARKET_ITEMS_PATH));
  } catch (e) {
    items.value = [];
    loadError.value = marketErrorText(e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => { void load(); });

// ── 详情（§8：详情抽屉 = when_to_use + SKILL.md 正文 + 工具清单）───────────────
const selectedSlug = ref<string | null>(null);
const detail = ref<MarketDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);

/** SKILL.md 正文走站内同一套 markdown 渲染（与 FilePreviewModal 同源，不另起炉灶）。 */
const readmeHtml = computed(() => (detail.value?.readme ? renderMarkdown(detail.value.readme) : ''));

async function openDetail(item: MarketListItem): Promise<void> {
  selectedSlug.value = item.slug;
  detailError.value = null;
  detailLoading.value = true;
  try {
    detail.value = normalizeMarketDetail(await api(marketUserItemPath(item.slug)));
  } catch (e) {
    detail.value = null;
    detailError.value = marketErrorText(e);
  } finally {
    detailLoading.value = false;
  }
}

function closeDetail(): void {
  selectedSlug.value = null;
  detail.value = null;
  detailError.value = null;
}

// ── 三个动作（§7：install / uninstall / enabled）───────────────────────────────

/**
 * 一次动作 = 一趟请求 + 一次重读。
 * ⚠ 动作失败**不重读**（服务端没变），也不显示"已安装"；成功才刷新，于是屏上永远是库里的状态。
 */
async function run(
  item: MarketListItem,
  path: string,
  body: string,
  okText: string,
): Promise<void> {
  if (busySlug.value !== null) return;
  busySlug.value = item.slug;
  actionError.value = null;
  resultText.value = null;
  try {
    await api(path, { method: 'POST', body });
    await load();
    resultText.value = okText;
    // 详情开着 ⇒ 一起刷新，否则详情里的「已装态」会停在动作前的旧值。
    if (selectedSlug.value === item.slug) await openDetail(item);
  } catch (e) {
    actionError.value = marketErrorText(e);
  } finally {
    busySlug.value = null;
  }
}

function onInstall(item: MarketListItem): void {
  // 空体 `{}`：`enabled` 由服务端缺省（§7-3 的 `{enabled?:true}`），前端不替它决定。
  void run(
    item,
    `${marketUserItemPath(item.slug)}/install`,
    '{}',
    item.installed
      ? t('market.result.reinstalled', { name: item.name })
      : t('market.result.installed', { name: item.name }),
  );
}

function onUninstall(item: MarketListItem): void {
  void run(
    item,
    `${marketUserItemPath(item.slug)}/uninstall`,
    '{}',
    t('market.result.uninstalled', { name: item.name }),
  );
}

function onToggleEnabled(item: MarketListItem): void {
  // 双保险：按钮已经 disabled，但 `secrets_ready=false` 时一次请求都不该发出去（§8.2）。
  if (secretsBlocked(item)) return;
  const next = !item.enabled;
  void run(
    item,
    `${marketUserItemPath(item.slug)}/enabled`,
    JSON.stringify({ enabled: next }),
    next
      ? t('market.result.enabled', { name: item.name })
      : t('market.result.disabled', { name: item.name }),
  );
}

/** MCP 条目（#608 §8.2）：种类不同只在「要不要提凭据」上分岔，动作本身一模一样。 */
function isMcp(item: MarketListItem): boolean {
  return item.kind === 'mcp';
}

/**
 * `secrets_ready === false` ⇒ 「启用」是死按钮（§8.2：用户面**没有填值入口**，
 * 只能等管理员在管理台写入）。三档里的 `null`（服务端没说）**不拦**——以服务端 409 为准。
 */
function secretsBlocked(item: MarketListItem): boolean {
  return isMcp(item) && item.secretsReady === false;
}

/** 工具数：MCP 且从没被 FDE 连过 ⇒ 「工具数未知…」，**不写 0**（与管理台 toolscache 同一口径）。 */
function toolsText(item: MarketListItem): string {
  return item.toolCount === null && isMcp(item)
    ? t('market.mcp.toolsUnknown')
    : t('market.tools', { count: countText(item.toolCount) });
}
</script>

<template>
  <section data-test="market-view" class="grid gap-3 p-3">
    <header class="grid gap-1">
      <div class="flex flex-wrap items-center gap-3">
        <!-- 返回工作台：市场是用户面页面，相对 hash 就够（不涉及 #450 的跨 host） -->
        <router-link
          data-test="market-back"
          :to="{ name: 'workbench' }"
          class="text-sm underline text-black/60"
        >{{ t('market.backToWorkbench') }}</router-link>
        <h2 class="text-lg font-medium">{{ t('market.title') }}</h2>
        <button
          data-test="market-reload"
          type="button"
          class="rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5 disabled:opacity-50"
          :disabled="loading"
          @click="load()"
        >{{ t('market.reload') }}</button>
      </div>
      <p class="text-xs text-black/55">{{ t('market.intro') }}</p>
      <p data-test="market-budget-hint" class="text-xs text-black/55">
        {{ t('market.budgetHint', { max: MAX_ENABLED_SKILLS }) }}
      </p>
    </header>

    <p v-if="loading" data-test="market-loading" class="text-sm text-black/50" role="status">
      {{ t('market.loading') }}
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
    <p
      v-if="!loading && !loadError && items.length === 0"
      data-test="market-empty"
      class="text-sm text-black/50"
    >{{ t('market.empty') }}</p>

    <div class="flex flex-col gap-4 lg:flex-row lg:items-start">
      <!-- 卡片列表 -->
      <ul class="grid min-w-0 flex-1 gap-2 md:grid-cols-2">
        <li
          v-for="item in items"
          :key="item.slug"
          :data-test="`market-card-${item.slug}`"
          class="grid gap-2 rounded-lg border border-black/10 p-3"
        >
          <div class="flex flex-wrap items-baseline gap-2">
            <h3 class="text-base font-medium">{{ item.name || item.slug }}</h3>
            <span v-if="item.version" class="text-xs text-black/45">
              {{ t('market.version', { version: item.version }) }}
            </span>
            <span
              :data-test="`market-kind-${item.slug}`"
              class="rounded border border-black/10 px-1.5 text-xs text-black/55"
            >{{ t(kindMessageKey(item.kind)) }}</span>
          </div>
          <p class="text-sm text-black/70">{{ item.summary }}</p>

          <p v-if="item.tags.length" class="flex flex-wrap gap-1">
            <span
              v-for="tag in item.tags"
              :key="tag"
              class="rounded border border-black/10 px-1.5 text-xs text-black/55"
            >{{ tag }}</span>
          </p>

          <!-- #608 §4.4：准入理由走 i18n（不直接把英文枚举喷给人看）；skill 带了理由 ⇒ 忽略 -->
          <p
            v-if="isMcp(item) && item.reason !== null"
            :data-test="`market-reason-${item.slug}`"
            class="text-xs text-black/55"
          >{{ t('market.reasonLabel', { reason: t(reasonMessageKey(item.reason)) }) }}</p>

          <!-- 数字缺失 ⇒ 「—」，不是 0（归一化层已保证 null，这里只负责显示）-->
          <p class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-black/55">
            <span :data-test="`market-tools-${item.slug}`">
              {{ toolsText(item) }}
            </span>
            <!-- MCP 卡面多一个档位在眼前（§8.2：让人知道它是展开、走网关、还是根本没物化）-->
            <span v-if="isMcp(item)" :data-test="`market-exposure-${item.slug}`">
              {{ t('market.mcp.exposureLabel', { exposure: t(exposureMessageKey(item.exposure)) }) }}
            </span>
            <span :data-test="`market-score-${item.slug}`">
              {{ t('market.securityScore', { score: countText(item.securityScore) }) }}
            </span>
            <span v-if="item.warningCount !== null">
              {{ t('market.scanHints', { count: item.warningCount }) }}
            </span>
          </p>

          <!-- 已装态：文字承重，三态各一句；**未启用是中性灰字**（§8，不是告警色）-->
          <p
            :data-test="`market-state-${item.slug}`"
            class="text-xs"
            :class="installStateOf(item) === 'installedEnabled'
              ? 'text-black/70'
              : 'text-black/45'"
          >{{ t(installStateMessageKey(installStateOf(item))) }}</p>
          <p
            v-if="item.installed && item.installedVersion && item.installedVersion !== item.version"
            :data-test="`market-drift-${item.slug}`"
            class="text-xs text-black/45"
          >{{ t('market.driftHint', { installed: item.installedVersion, version: item.version }) }}</p>

          <div class="flex flex-wrap items-center gap-2">
            <button
              :data-test="`market-install-${item.slug}`"
              type="button"
              class="rounded-md bg-brand px-2.5 py-1 text-sm text-white disabled:opacity-50"
              :disabled="busySlug !== null"
              @click="onInstall(item)"
            >{{ item.installed ? t('market.reinstall') : t('market.install') }}</button>
            <button
              v-if="item.installed"
              :data-test="`market-toggle-${item.slug}`"
              type="button"
              class="rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5 disabled:opacity-50"
              :disabled="busySlug !== null || secretsBlocked(item)"
              @click="onToggleEnabled(item)"
            >{{ item.enabled ? t('market.disable') : t('market.enable') }}</button>
            <!-- 缺凭据：只说在等谁，**不给填值框**（用户面不能写凭据，§8.2）-->
            <span
              v-if="secretsBlocked(item)"
              :data-test="`market-secrets-pending-${item.slug}`"
              class="text-xs text-black/55"
            >{{ t('market.mcp.secretsPending') }}</span>
            <button
              v-if="item.installed"
              :data-test="`market-uninstall-${item.slug}`"
              type="button"
              class="rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5 disabled:opacity-50"
              :disabled="busySlug !== null"
              @click="onUninstall(item)"
            >{{ t('market.uninstall') }}</button>
            <button
              :data-test="`market-detail-${item.slug}`"
              type="button"
              class="rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5"
              @click="openDetail(item)"
            >{{ t('market.detail.open') }}</button>
            <span
              v-if="busySlug === item.slug"
              :data-test="`market-busy-${item.slug}`"
              class="text-xs text-black/45"
            >{{ t('market.busy') }}</span>
          </div>
        </li>
      </ul>

      <!-- 详情：when_to_use + SKILL.md 正文 + 工具清单 + 文件清单（§8）-->
      <aside
        v-if="selectedSlug !== null"
        data-test="market-detail"
        class="grid w-full gap-3 rounded-lg border border-black/10 p-3 lg:sticky lg:top-3 lg:w-96"
      >
        <div class="flex items-center gap-2">
          <h3 class="min-w-0 flex-1 truncate text-base font-medium">{{ detail?.name || selectedSlug }}</h3>
          <button
            data-test="market-detail-close"
            type="button"
            class="rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
            @click="closeDetail"
          >{{ t('market.detail.close') }}</button>
        </div>
        <p v-if="detailLoading" data-test="market-detail-loading" class="text-sm text-black/50">
          {{ t('market.detail.loading') }}
        </p>
        <p v-if="detailError" data-test="market-detail-error" class="syserr text-sm" role="alert">
          {{ detailError }}
        </p>
        <template v-if="detail">
          <section v-if="detail.whenToUse" data-test="market-detail-when">
            <h4 class="text-xs font-semibold text-black/55">{{ t('market.detail.whenToUse') }}</h4>
            <p class="text-sm text-black/75">{{ detail.whenToUse }}</p>
          </section>

          <section data-test="market-detail-tools">
            <h4 class="text-xs font-semibold text-black/55">{{ t('market.detail.tools') }}</h4>
            <p v-if="detail.tools.length === 0" class="text-xs text-black/45">
              {{ t('market.detail.toolsUnknown') }}
            </p>
            <ul v-else class="grid gap-1">
              <li
                v-for="tool in detail.tools"
                :key="tool.name"
                :data-test="`market-tool-${tool.name}`"
                class="text-sm"
              >
                <code class="text-[13px]">{{ tool.name }}</code>
                <span v-if="tool.description" class="text-xs text-black/60"> — {{ tool.description }}</span>
                <span
                  v-if="tool.params.length"
                  :data-test="`market-tool-params-${tool.name}`"
                  class="block text-xs text-black/50"
                >{{ t('market.detail.params', { params: tool.params.map((p) => `${p.name}: ${p.type ?? '?'}`).join('、') }) }}</span>
              </li>
            </ul>
          </section>

          <section data-test="market-detail-readme">
            <h4 class="text-xs font-semibold text-black/55">{{ t('market.detail.readme') }}</h4>
            <p v-if="!detail.readme" class="text-xs text-black/45">{{ t('market.detail.readmeMissing') }}</p>
            <!-- eslint-disable-next-line vue/no-v-html —— 站内统一的 markdown 出口（lib/markdown）-->
            <div v-else class="md-body text-sm" v-html="readmeHtml"></div>
          </section>

          <section v-if="detail.files.length" data-test="market-detail-files">
            <h4 class="text-xs font-semibold text-black/55">{{ t('market.detail.files') }}</h4>
            <ul class="grid gap-0.5 text-xs text-black/60">
              <li v-for="file in detail.files" :key="file.path" class="flex justify-between gap-2">
                <code class="break-all">{{ file.path }}</code>
                <span class="shrink-0">{{ bytesText(file.bytes) }}</span>
              </li>
            </ul>
          </section>
        </template>
      </aside>
    </div>

    <!-- 判据可见性：把 path 判据挂在页面上，单测能直接打到 lib（不另开测试专用出口）-->
    <p class="max-w-prose text-xs text-black/40">{{ t('market.footnote') }}</p>
  </section>
</template>
