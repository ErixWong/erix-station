<script setup lang="ts">
// 管理台 · 「关于」（issue #586，契约 docs/api/portal.md §4.16）。**只读**，没有任何写操作。
//
// 这一页存在的理由不是「让人看到版本号」，而是**把三个版本号彻底分开摆**：
//   ① 服务端（portal 镜像自己） ② 平台侧引擎（portal 镜像里的 erix-agent） ③ 每台 FDE 的引擎。
// v0.1.69 那次发布，宿主工作树停在 0.1.68，portal 烘的就是那份旧树 ⇒ 真机上 FDE 报 0.1.69、portal 报
// 0.1.68，分裂一小时而**界面上一个读面都没有**。三格并排 + 各自标来源，就是为了让这种分裂一眼看得出来。
//
// 三条渲染红线（每条都有 spec 用例钉住）：
//   * **不猜数**：服务端缺字段给字面量 `unknown`，lib 把它收成 `null` ⇒ 这里渲染成显式的「未知」，
//     绝不渲染成空串、`0`、或「和平台侧引擎一样」。
//   * **第三格必须带口径**：`containers.agent_version` 是**派生副本**（provision 时写入），
//     所以每一项都必须显示「provision 时快照」字样；服务端没给快照标注时也要显式说「口径未给出」。
//   * **不请求就不显示**（懒挂载，与 #350 同口径）：`onMounted` 是唯一触发点。
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAdminStore } from '../stores/admin';
import {
  formatInstant,
  shortRevision,
  type FdeCell,
} from '../lib/versionSurface';

const { t } = useI18n();
const admin = useAdminStore();

const info = computed(() => admin.versionInfo);
const loaded = computed(() => admin.versionInfoLoaded);
const loading = computed(() => admin.versionInfoLoading);
const error = computed(() => admin.versionInfoErr);
const server = computed(() => info.value?.server ?? { station: null, revision: null, builtAt: null, source: 'other' as const });
const fdes = computed<FdeCell[]>(() => info.value?.fdes ?? []);
const fdesPresent = computed(() => info.value?.fdesPresent === true);

/** `unknown` / 缺失一律走「未知」文案（判据：不许把缺失伪装成 0 或空）。 */
function valueText(value: string | null): string {
  return value ?? t('admin.about.unknown');
}

/** 时间格：能解析给本地时间，解析不了**原样显示**（脏值不许静默丢掉）。 */
function instantText(raw: string | null): string {
  const at = formatInstant(raw);
  if (at.kind === 'unknown') return t('admin.about.unknown');
  if (at.kind === 'raw') return t('admin.about.unparsable', { value: at.text });
  return at.text;
}

/** `server.source`：这一格到底从哪儿读到的（`build-info` = 镜像里烘的构建产物）。 */
const sourceText = computed(() => {
  switch (server.value.source) {
    case 'build-info': return t('admin.about.sourceBuildInfo');
    case 'env': return t('admin.about.sourceEnv');
    case 'package': return t('admin.about.sourcePackage');
    case 'unknown': return t('admin.about.sourceUnknown');
    default: return t('admin.about.sourceUnknownShape');
  }
});

/** FDE 项的快照口径标注（判据 C：这一格必须带口径，缺标注也要显式说出来）。 */
function snapshotText(fde: FdeCell): string {
  return fde.snapshot === 'provision' ? t('admin.about.snapshotProvision') : t('admin.about.snapshotUnknown');
}

onMounted(() => {
  // 唯一触发点（懒挂载）。action 自己 catch ⇒ 不产生未捕获拒绝（AGENTS.md §4 的 rc=1 坑）。
  void admin.loadVersionInfo();
});
</script>

<template>
  <section data-test="admin-about" class="grid gap-3">
    <header>
      <h2 class="text-lg font-medium">{{ t('admin.about.title') }}</h2>
      <p class="mt-1 text-xs text-black/60">{{ t('admin.about.intro') }}</p>
    </header>

    <p v-if="loading" data-test="about-loading" class="text-sm text-black/60" role="status">
      {{ t('admin.about.loading') }}
    </p>
    <p v-if="error" data-test="about-error" class="syserr text-sm" role="alert">{{ error }}</p>
    <p v-if="!loaded && !loading && !error" data-test="about-not-loaded" class="text-sm text-black/60">
      {{ t('admin.about.notLoaded') }}
    </p>

    <template v-if="loaded">
      <!-- ① 服务端：portal 镜像自己 -->
      <section data-test="about-server" class="rounded-lg border border-black/10 p-3">
        <h3 class="text-sm font-semibold">{{ t('admin.about.serverTitle') }}</h3>
        <p class="mt-0.5 text-xs text-black/55">{{ t('admin.about.serverHint') }}</p>
        <dl class="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <div>
            <dt class="text-xs text-black/55">{{ t('admin.about.fieldVersion') }}</dt>
            <dd data-test="server-station" class="font-mono">{{ valueText(server.station) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-black/55">{{ t('admin.about.fieldRevision') }}</dt>
            <dd data-test="server-revision" class="font-mono" :title="server.revision ?? ''">
              {{ valueText(shortRevision(server.revision)) }}
            </dd>
          </div>
          <div>
            <dt class="text-xs text-black/55">{{ t('admin.about.fieldBuiltAt') }}</dt>
            <dd data-test="server-built-at">{{ instantText(server.builtAt) }}</dd>
          </div>
        </dl>
        <p data-test="server-source" class="mt-2 text-xs text-black/55">{{ sourceText }}</p>
      </section>

      <!-- ② 平台侧引擎：portal 镜像里的 erix-agent。**不是**每台 FDE 的那个引擎 -->
      <section data-test="about-engine" class="rounded-lg border border-black/10 p-3">
        <h3 class="text-sm font-semibold">{{ t('admin.about.engineTitle') }}</h3>
        <p class="mt-0.5 text-xs text-black/55">{{ t('admin.about.engineHint') }}</p>
        <p data-test="engine-version" class="mt-2 font-mono text-sm">{{ valueText(info?.platformEngineVersion ?? null) }}</p>
      </section>

      <!-- ③ 每台 FDE：`containers.agent_version`，派生副本 ⇒ 必须带「provision 时快照」口径 -->
      <section data-test="about-fdes" class="rounded-lg border border-black/10 p-3">
        <h3 class="text-sm font-semibold">{{ t('admin.about.fdesTitle') }}</h3>
        <p class="mt-0.5 text-xs text-black/55">{{ t('admin.about.fdesHint') }}</p>
        <p v-if="!fdesPresent" data-test="fdes-unreadable" class="syserr mt-2 text-sm" role="alert">
          {{ t('admin.about.fdesUnreadable') }}
        </p>
        <p v-else-if="fdes.length === 0" data-test="fdes-empty" class="mt-2 text-sm text-black/60">
          {{ t('admin.about.fdesEmpty') }}
        </p>
        <ul v-else class="mt-2 grid gap-2 text-sm">
          <li
            v-for="fde in fdes"
            :key="fde.name"
            data-test="fde-item"
            class="border-b border-black/5 pb-1 last:border-b-0"
          >
            <span data-test="fde-name" class="font-medium">{{ fde.name }}</span>
            <span v-if="fde.revoked" data-test="fde-revoked" class="ml-2 text-xs text-amber-900">
              {{ t('admin.about.revoked') }}
            </span>
            <span class="ml-2 font-mono" data-test="fde-agent-version">
              {{ valueText(fde.agentVersion) }}
            </span>
            <!-- 判据 C：口径标注。这一格是快照，不是实时事实。 -->
            <span class="ml-2 rounded border border-black/15 px-1 text-xs text-black/60" data-test="fde-snapshot">
              {{ snapshotText(fde) }}
            </span>
            <span class="ml-2 text-xs text-black/55" data-test="fde-provisioned-at">
              {{ t('admin.about.fdeProvisionedAt', { at: instantText(fde.provisionedAt) }) }}
            </span>
            <span v-if="fde.image" class="ml-2 text-xs text-black/45 font-mono" data-test="fde-image">
              {{ fde.image }}
            </span>
          </li>
        </ul>
      </section>

      <!-- 口径本身（不写进代码就不算说清楚）：谁不作准 -->
      <p data-test="about-caveat" class="text-xs text-black/55">{{ t('admin.about.caveat') }}</p>
    </template>
  </section>
</template>
