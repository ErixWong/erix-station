<script setup lang="ts">
// 管理台 · 提示词（issue #596 片 B，契约 `docs/api/portal.md` §4.16 / 设计稿 §7）。
//
// 这一页存在的理由只有一条：**平台对 agent 说的话不该要重建容器**。所以判据不在"能不能编辑"，而在：
//   ① 每卡显示**当前来源**（DB 覆写 / 跟随内置）、**字节数与上限**、**生效时机** —— 少了任何一条，
//      管理员都不知道自己在改什么、什么时候能看见。
//   ② 三条生效时机**各不相同**（追加段与整段覆写 = 下一次 run；标题提示词 = 下一次改名），
//      所以这里刻意写三句不同的话，不共用一句"保存后生效"。
//   ③ 保存后**用响应 DTO 回填**（它出自 `RETURNING` ⇒ 是真落库的那一份，不是回显输入）。
//   ④ `materializeEnqueued === 0` 必须**显式**出现「已保存，但物化未通知」——静默就是把
//      "改了但工位还没吃到"藏起来（§4.16-4）。
//   ⑤ 前端**不抢服务端的闸**（§4.16-2）：文本照发，越界由 `400 validation_failed` 回来标红；
//      只有"连长度都算不出"（进来的不是字符串）才不发请求。
//   ⑥ 只读那张卡**只列位置与代价，不显示全文**：portal 镜像不含 `runner/`
//      （`portal/Dockerfile` 只 `COPY portal/ portal/`），后端也只给 `key` —— 显示全文就是撒谎。
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAdminStore } from '../stores/admin';
import {
  formatBytes,
  shortUuid,
  utf8ByteLength,
  type PlatformPrompts,
  type PromptFieldKey,
  type ReadonlyPromptKey,
} from '../lib/platformPrompts';

const { t } = useI18n();
const admin = useAdminStore();

const prompts = computed<PlatformPrompts | null>(() => admin.platformPrompts);
const loaded = computed(() => admin.platformPromptsLoaded);
const loading = computed(() => admin.platformPromptsLoading);
const loadError = computed(() => admin.platformPromptsErr);

/**
 * 三张卡的元数据。**生效时机是三条不同的句子**（各自的键名不同 ⇒ 谁也不会不小心共用一句）。
 * `bytes` 是"当前落库那份"的字节数：`agentsMd` 的 DTO 没给 `override` 自身的字节数，
 * 所以那一卡自己按 UTF-8 现算（与后端 `Buffer.byteLength` 同口径，见 lib 的 `utf8ByteLength`）。
 */
const cards = computed(() => {
  const p = prompts.value;
  if (p === null) return [];
  return [
    {
      field: 'addendum' as const,
      text: p.addendum.text,
      isDefault: p.addendum.isDefault,
      bytes: p.addendum.bytes ?? utf8ByteLength(p.addendum.text),
      maxBytes: p.addendum.maxBytes,
      titleKey: 'admin.prompts.cardAddendum',
      labelKey: 'admin.prompts.addendumLabel',
      hintKey: 'admin.prompts.addendumHint',
      timingKey: 'admin.prompts.timingAddendum',
    },
    {
      field: 'agentsMd' as const,
      text: p.agentsMd.override,
      isDefault: p.agentsMd.isDefault,
      bytes: utf8ByteLength(p.agentsMd.override),
      maxBytes: p.agentsMd.maxBytes,
      titleKey: 'admin.prompts.cardAgentsMd',
      labelKey: 'admin.prompts.agentsMdLabel',
      hintKey: 'admin.prompts.agentsMdHint',
      timingKey: 'admin.prompts.timingAgentsMd',
    },
    {
      field: 'titlePrompt' as const,
      text: p.titlePrompt.text,
      isDefault: p.titlePrompt.isDefault,
      bytes: p.titlePrompt.bytes ?? utf8ByteLength(p.titlePrompt.text),
      maxBytes: p.titlePrompt.maxBytes,
      titleKey: 'admin.prompts.cardTitlePrompt',
      labelKey: 'admin.prompts.titlePromptLabel',
      hintKey: 'admin.prompts.titlePromptHint',
      timingKey: 'admin.prompts.timingTitlePrompt',
    },
  ];
});

/** 文本框的一手值（DOM 永远是字符串）；换算与判据全在 lib（纯函数，见 `lib/platformPrompts.ts`）。 */
const drafts = ref<Record<PromptFieldKey, string>>({ addendum: '', agentsMd: '', titlePrompt: '' });

function fillFrom(next: PlatformPrompts | null) {
  if (next === null) return;
  // 回填的是**落库那份**（GET 或 PUT 响应），于是"我以为写进去的"与"实际生效的"永不分离。
  drafts.value = {
    addendum: next.addendum.text,
    agentsMd: next.agentsMd.override,
    titlePrompt: next.titlePrompt.text,
  };
}

// ── 全局：来源、回落原因、最后修改 ────────────────────────────────────────────
/** `reason ≠ null` 时整页显示的都是**内置**文本（DB 读不到），这一行就是它的解释。 */
const reasonText = computed(() => {
  switch (prompts.value?.reason) {
    case 'no_row': return t('admin.prompts.reasonNoRow');
    case 'read_failed': return t('admin.prompts.reasonReadFailed');
    // `read_timeout`：查询发出去但没在 `PLATFORM_PROMPTS_READ_TIMEOUT_MS` 内回 —— 把这事说成
    // "管理台还没配过"会让值班去配一个值，而真故障在连接上（§4.16-1 的 `reason` 三条互不合并）。
    case 'read_timeout': return t('admin.prompts.reasonReadTimeout');
    // 后端新增的第四种 reason：不许塌成 `no_row`，也不许整行不显示。
    case 'unknown': return t('admin.prompts.reasonUnknown');
    default: return null;
  }
});

const updatedAtText = computed(() => {
  const raw = prompts.value?.updatedAt ?? null;
  if (raw === null) return t('admin.prompts.updatedAtNever');
  const at = new Date(raw);
  return Number.isNaN(at.getTime())
    ? t('admin.prompts.updatedAtUnparsable', { value: raw })
    : at.toLocaleString();
});

/** `updatedBy` 只有 uuid、没有显示名 ⇒ 短 uuid 或「—」，**不许空着**（空着像"没人改过"）。 */
const updatedByText = computed(() => shortUuid(prompts.value?.updatedBy ?? null) ?? t('admin.prompts.never'));

// ── 整段覆写卡：生效全文（只读 + 复制）──────────────────────────────────────
const showEffective = ref(false);
const copied = ref<'idle' | 'ok' | 'failed'>('idle');

async function copyEffective() {
  const text = prompts.value?.agentsMd.effectiveText ?? '';
  if (text === '' || typeof navigator === 'undefined' || !navigator.clipboard) {
    copied.value = 'failed';
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    copied.value = 'ok';
  } catch {
    copied.value = 'failed';
  }
}

// ── 只读卡：位置与代价（**没有全文**，全文在 runner 镜像里，portal 读不到）──────
const READONLY_KEYS: Record<ReadonlyPromptKey, { where: string; cost: string }> = {
  runnerSystemPrompt: {
    where: 'admin.prompts.readonly.runnerSystemPrompt.where',
    cost: 'admin.prompts.readonly.runnerSystemPrompt.cost',
  },
  childSystemPrompt: {
    where: 'admin.prompts.readonly.childSystemPrompt.where',
    cost: 'admin.prompts.readonly.childSystemPrompt.cost',
  },
  toolDescriptions: {
    where: 'admin.prompts.readonly.toolDescriptions.where',
    cost: 'admin.prompts.readonly.toolDescriptions.cost',
  },
  engineNotices: {
    where: 'admin.prompts.readonly.engineNotices.where',
    cost: 'admin.prompts.readonly.engineNotices.cost',
  },
};

// ── 保存 ─────────────────────────────────────────────────────────────────────
function fieldErrorOf(field: PromptFieldKey): string | null {
  return admin.promptSaveField === field ? admin.promptSaveErr : null;
}

/**
 * 保存后的物化通知那一行（§4.16-4）。只在**刚保存成功那张卡**下面出现。
 * 语义结论不在这里算（那是 lib 的 `materializeNoticeOf`，store 已折成 `promptNotice`）：
 * 两处各算一遍就是两本账。`titlePrompt` 不涉物化（响应里那个 0 是恒 0）⇒ 这一行**不出现**，
 * 否则就是说假话。
 */
function materializeText(field: PromptFieldKey): string | null {
  if (admin.promptSavedField !== field) return null;
  const count = prompts.value?.materializeEnqueued ?? null;
  switch (admin.promptNotice) {
    case 'enqueued': return t('admin.prompts.savedEnqueued', { count });
    case 'not_enqueued': return t('admin.prompts.savedButNotNotified');
    case 'enqueued_unknown': return t('admin.prompts.savedNoticeCountUnknown');
    default: return null;
  }
}

/** 越界的**提前提示**（不是拦截）：草稿字节数超过该格上限。上限没给就什么都不说。 */
function overLimitText(field: PromptFieldKey): string | null {
  const card = cards.value.find((item) => item.field === field);
  const max = card?.maxBytes ?? null;
  if (max === null) return null;
  const draft = drafts.value[field] ?? '';
  const bytes = utf8ByteLength(draft);
  return bytes > max ? t('admin.prompts.overLimit', { bytes, max }) : null;
}

function draftBytesText(field: PromptFieldKey): string {
  return t('admin.prompts.draftBytes', { bytes: utf8ByteLength(drafts.value[field] ?? '') });
}

/** 保存按钮的唯一禁用条件：正在保存 / 还没加载过 / 草稿连长度都算不出。 */
function saveDisabled(field: PromptFieldKey): boolean {
  const draft = drafts.value[field];
  return admin.promptSaving || !loaded.value || typeof draft !== 'string';
}

function saveOf(field: PromptFieldKey): (text: string) => Promise<string | null> {
  if (field === 'addendum') return admin.saveAddendumPrompt;
  if (field === 'agentsMd') return admin.saveAgentsMdPrompt;
  return admin.saveTitlePrompt;
}

async function onSave(field: PromptFieldKey) {
  const draft = drafts.value[field];
  if (saveDisabled(field)) return;
  const err = await saveOf(field)(draft);
  // 成功：用服务端回读的那一份回填（不是把输入原样留着）。失败：草稿保持用户写的内容，
  // 免得他被 400 打回来时还得重打一遍。
  if (err === null) fillFrom(prompts.value);
}

/** 「恢复内置」：就是往整段覆写那一格写空串（`{"text":""}`），不是另一个端点。 */
async function onRestoreBuiltin() {
  if (admin.promptSaving) return;
  const err = await admin.saveAgentsMdPrompt('');
  if (err === null) fillFrom(prompts.value);
}

async function onReload() {
  await admin.loadPlatformPrompts();
  fillFrom(prompts.value);
}

onMounted(async () => {
  await admin.loadPlatformPrompts();
  fillFrom(prompts.value);
});
</script>

<template>
  <section class="grid gap-3 p-3">
    <header>
      <h2 class="text-lg font-medium">{{ t('admin.prompts.title') }}</h2>
      <p class="max-w-prose text-xs text-black/55">{{ t('admin.prompts.intro') }}</p>
    </header>

    <p v-if="loading" data-test="prompts-loading" class="text-sm text-black/50">
      {{ t('admin.prompts.loading') }}
    </p>
    <p v-if="loadError" data-test="prompts-load-error" class="syserr text-sm" role="alert">{{ loadError }}</p>
    <p v-if="!loaded && !loading && !loadError" data-test="prompts-not-loaded" class="text-xs text-black/50">
      {{ t('admin.prompts.notLoaded') }}
    </p>

    <!-- 全局：这一页现在到底在显示哪一份，以及最后一次是谁改的 -->
    <dl v-if="prompts" data-test="prompts-meta" class="grid gap-1 rounded-md border border-black/10 bg-black/[0.02] p-2 text-xs">
      <div class="flex items-baseline gap-2">
        <dt class="text-black/55">{{ t('admin.prompts.updatedAt') }}</dt>
        <dd data-test="prompts-updated-at">{{ updatedAtText }}</dd>
      </div>
      <div class="flex items-baseline gap-2">
        <dt class="text-black/55">{{ t('admin.prompts.updatedBy') }}</dt>
        <dd data-test="prompts-updated-by">{{ updatedByText }}</dd>
      </div>
      <p v-if="reasonText" data-test="prompts-reason" class="text-amber-700">{{ reasonText }}</p>
    </dl>

    <!-- ① / ② / ③ 三张可编辑卡 -->
    <div
      v-for="card in cards"
      :key="card.field"
      :data-test="`card-${card.field}`"
      class="grid gap-2 rounded-md border border-black/10 p-3"
    >
      <h3 class="text-sm font-medium">{{ t(card.titleKey) }}</h3>

      <!-- 每卡必显示：当前来源 / 字节数与上限 / 生效时机（少一条这页就没价值） -->
      <p data-test="prompt-source" class="text-xs">
        <span class="text-black/55">{{ t('admin.prompts.source') }}：</span>
        <span :data-test="`source-${card.field}`">
          {{ card.isDefault ? t('admin.prompts.sourceBuiltin') : t('admin.prompts.sourceDb') }}
        </span>
        <span v-if="!card.isDefault" class="ml-1 text-black/40">{{ t('admin.prompts.sourceDbNote') }}</span>
      </p>
      <p :data-test="`bytes-${card.field}`" class="text-xs text-black/60">
        {{ t('admin.prompts.bytesOf', {
          bytes: formatBytes(card.bytes) ?? card.bytes,
          max: formatBytes(card.maxBytes) ?? t('admin.prompts.unknown'),
        }) }}
      </p>
      <p :data-test="`timing-${card.field}`" class="text-xs text-emerald-800">{{ t(card.timingKey) }}</p>

      <label class="flex flex-col gap-1 text-xs text-black/55">
        {{ t(card.labelKey) }}
        <textarea
          v-model="drafts[card.field]"
          :data-test="`input-${card.field}`"
          rows="5"
          spellcheck="false"
          class="rounded-md border border-black/20 px-2 py-1 font-mono text-xs"
          :class="fieldErrorOf(card.field) ? 'border-red-600' : ''"
          :aria-invalid="fieldErrorOf(card.field) ? 'true' : undefined"
        />
      </label>

      <p class="text-xs text-black/50">{{ t(card.hintKey) }}</p>
      <p :data-test="`draft-bytes-${card.field}`" class="text-xs text-black/50">
        {{ draftBytesText(card.field) }}
      </p>
      <p
        v-if="overLimitText(card.field)"
        :data-test="`over-limit-${card.field}`"
        class="text-xs text-amber-700"
      >{{ overLimitText(card.field) }}</p>
      <p
        v-if="fieldErrorOf(card.field)"
        :data-test="`field-error-${card.field}`"
        class="syserr text-xs"
        role="alert"
      >{{ fieldErrorOf(card.field) }}</p>

      <!-- 整段覆写那一卡的两件专属东西：偏离标记 + 查看生效全文 + 恢复内置 -->
      <template v-if="card.field === 'agentsMd' && prompts">
        <p
          v-if="prompts.agentsMd.isOverridden"
          data-test="agents-md-deviated"
          class="text-xs text-amber-700"
        >{{ t('admin.prompts.deviated') }}</p>
        <p v-else data-test="agents-md-follows" class="text-xs text-black/55">
          {{ t('admin.prompts.followsTemplate') }}
        </p>
        <p data-test="agents-md-render-budget" class="text-xs text-black/50">
          {{ t('admin.prompts.renderBudget', {
            effective: formatBytes(prompts.agentsMd.effectiveBytes) ?? '?',
            limit: formatBytes(prompts.agentsMd.renderedLimitBytes) ?? '?',
            template: formatBytes(prompts.agentsMd.templateBytes) ?? '?',
          }) }}
        </p>

        <div class="flex flex-wrap items-center gap-2">
          <button
            data-test="toggle-effective"
            type="button"
            class="rounded-md border border-black/20 px-2 py-1 text-xs"
            @click="showEffective = !showEffective"
          >{{ showEffective ? t('admin.prompts.hideEffective') : t('admin.prompts.viewEffective') }}</button>
          <button
            v-if="showEffective"
            data-test="copy-effective"
            type="button"
            class="rounded-md border border-black/20 px-2 py-1 text-xs"
            @click="copyEffective"
          >{{ t('admin.prompts.copy') }}</button>
          <button
            v-if="prompts.agentsMd.isOverridden"
            data-test="restore-builtin"
            type="button"
            class="rounded-md border border-black/20 px-2 py-1 text-xs"
            :disabled="admin.promptSaving"
            @click="onRestoreBuiltin"
          >{{ t('admin.prompts.restoreBuiltin') }}</button>
        </div>
        <p v-if="copied === 'ok'" data-test="copy-ok" class="text-xs text-emerald-700">
          {{ t('admin.prompts.copied') }}
        </p>
        <p v-else-if="copied === 'failed'" data-test="copy-failed" class="text-xs text-amber-700">
          {{ t('admin.prompts.copyFailed') }}
        </p>
        <!-- 只读全文（默认收起）。这是 portal 自己渲染的 `~/AGENTS.md`，**不是**只读那 4 条。 -->
        <pre
          v-if="showEffective"
          data-test="effective-text"
          class="max-h-64 overflow-auto rounded-md border border-black/10 bg-black/[0.02] p-2 font-mono text-[11px] whitespace-pre-wrap"
        >{{ prompts.agentsMd.effectiveText }}</pre>
      </template>

      <!-- 标题提示词那一卡给内置默认的字节数（全文太长，且它是"没配时实际发出去的那一份"） -->
      <p
        v-if="card.field === 'titlePrompt' && prompts"
        data-test="title-prompt-default"
        class="text-xs text-black/50"
      >{{ t('admin.prompts.titlePromptDefaultBytes', {
        bytes: formatBytes(utf8ByteLength(prompts.titlePrompt.defaultText)) ?? '?',
      }) }}</p>

      <div class="mt-1 flex items-center gap-2">
        <button
          :data-test="`save-${card.field}`"
          type="button"
          class="rounded-md bg-brand px-3 py-1 text-sm text-white disabled:opacity-50"
          :disabled="saveDisabled(card.field)"
          @click="onSave(card.field)"
        >{{ t('admin.prompts.save') }}</button>
        <p
          v-if="admin.promptSavedField === card.field"
          :data-test="`saved-${card.field}`"
          class="text-xs text-emerald-700"
        >{{ t('admin.prompts.saved') }}</p>
      </div>
      <!-- §4.16-4：`materializeEnqueued === 0` 不许静默 ⇒ 这一行必须出现（标题提示词不涉物化，
           所以那一卡压根不渲染这一行 —— 对它说"物化未通知"是撒谎）。 -->
      <p
        v-if="materializeText(card.field) !== null"
        :data-test="`materialize-${card.field}`"
        class="text-xs"
        :class="admin.promptNotice === 'not_enqueued' || admin.promptNotice === 'enqueued_unknown'
          ? 'text-amber-700' : 'text-black/55'"
      >{{ materializeText(card.field) }}</p>
    </div>

    <!-- ④ 只读说明卡：4 条住在镜像里的提示词，**只列位置与代价，不显示全文** -->
    <div data-test="card-readonly" class="grid gap-2 rounded-md border border-black/10 p-3">
      <h3 class="text-sm font-medium">{{ t('admin.prompts.readonlyTitle') }}</h3>
      <p class="text-xs text-black/55">{{ t('admin.prompts.readonlyIntro') }}</p>
      <!-- 这一句是本页的诚实声明：后端 `readonly[]` 只给 key，portal 也读不到全文。 -->
      <p data-test="readonly-no-fulltext" class="text-xs text-amber-700">
        {{ t('admin.prompts.readonlyNoFullText') }}
      </p>
      <ul class="grid gap-2">
        <li
          v-for="key in prompts?.readonly ?? []"
          :key="key"
          :data-test="`readonly-${key}`"
          class="grid gap-0.5 rounded-md border border-black/10 p-2 text-xs"
        >
          <code class="font-mono text-[11px]">{{ key }}</code>
          <span class="text-black/60">{{ t(READONLY_KEYS[key].where) }}</span>
          <span class="text-black/45">{{ t(READONLY_KEYS[key].cost) }}</span>
        </li>
      </ul>
      <p v-if="(prompts?.unknownReadonly.length ?? 0) > 0" data-test="readonly-unknown" class="text-xs text-black/45">
        {{ t('admin.prompts.readonlyUnknown', { keys: (prompts?.unknownReadonly ?? []).join('、') }) }}
      </p>
    </div>

    <div class="flex items-center gap-2">
      <button
        data-test="prompts-reload"
        type="button"
        class="rounded-md border border-black/20 px-3 py-1 text-sm disabled:opacity-50"
        :disabled="loading"
        @click="onReload"
      >{{ t('admin.prompts.reload') }}</button>
    </div>
    <p class="max-w-prose text-xs text-black/45">{{ t('admin.prompts.footnote') }}</p>
  </section>
</template>
