<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useSiteStore } from '../stores/site';
import { hashUrl } from '../lib/hostGate';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const site = useSiteStore();

// #450 A2：「← 返回工作台」是**跨 host** 链接（管理台 `admin.<伞域>:9443` → 用户面 `station.<伞域>`）。
// A1 之后同一份 SPA 仍会从两个 host 下发，而 `/` 在当前 origin 上就是「管理台 host 上的工作台」=
// 页面渲染得出来、API 全 404。所以这里必须用 `site` store 的 `userBaseUrl` 拼**绝对地址**。
// 拿不到 site 信息（fail-open）时退回相对 hash `#/`：同 origin 的 hash 链接，行为与改动前完全一致
// （host 闸自己会在下一次导航里决定要不要换 host）。
const backToWorkbenchHref = computed(() => hashUrl(site.info?.userBaseUrl, '/') ?? '#/');
// 2026-11-06（真机蹦极）：**没有工位的管理员（#332 第①类人）不该看到这个链接**。
// 他点过去 ⇒ 用户面 `#/` ⇒ workbenchGate 改写 `/admin/users` ⇒ 跨 host 送回管理台 ⇒
// 而两个 host 的登录 cookie 互不相通（host-only，`#6`）⇒ 送回去就是登录页 ⇒ 登录完又只能点回来。
// 「Back to workbench」对一个没有工作台的人本来就是空承诺。
const hasWorkbench = computed(() => !!auth.user?.fde_name);

const who = computed(() => {
  const user = auth.user;
  if (!user) return '';
  return user.fde_name
    ? t('workbench.who', { login: user.login, role: user.role, fde: user.fde_name })
    : t('workbench.whoNoFde', { login: user.login, role: user.role });
});

const tabs = [
  { name: 'admin-users', label: 'admin.tabs.users' },
  { name: 'admin-llm', label: 'admin.tabs.llm' },
  { name: 'admin-repos', label: 'admin.tabs.repos' },
  // issue #449：邮件通道配置（登录第二因素「邮箱验证码」的开关）。放在仓库管理之后、号池之前：
  // 前四个 tab 都是「人 / 模型 / 仓库 / 发信」这类平台配置，号池占用是只读的运维快照，留在最后。
  { name: 'admin-mail', label: 'admin.tabs.mail' },
  // issue #456 M2：证书页。顺序 users → llm → repos → mail → **certs** → pool：
  // 「发信 / 边缘证书」同属平台入口配置，号池占用仍留最后（只读运维快照）。
  { name: 'admin-tls', label: 'admin.tabs.tls' },
  // issue #485 片 A：上传上限（§4.15）。紧随证书（两者都是平台配置）而在号池占用（只读快照）之前。
  // issue #596 片 B：提示词面板。与 upload 同属「改一行而不必重建镜像」的平台配置 ⇒ 紧接其后、
  // 号池占用（只读快照）之前。请求只在该视图挂载时发（`AdminPromptsView` 的 onMounted 是唯一触发点）。
  { name: 'admin-upload', label: 'admin.tabs.upload' },
  { name: 'admin-prompts', label: 'admin.tabs.prompts' },
  // issue #595 M2：能力市场发布台（条目表 + 发布/下线 + 扇描结果）。与证书/上传同为平台配置，
  // 因此排在号池占用（只读运维快照）之前。
  { name: 'admin-market', label: 'admin.tabs.market' },
  // issue #350：号池占用总览（只读）。放在最后：先看用户/配置，选段时才来这里。
  { name: 'admin-preview-pool', label: 'admin.tabs.previewPool' },
  // issue #529（事件平台 W6）：宏模板配置 + 宏执行历史。追加在末尾（模板 → 执行历史）。
  { name: 'admin-macros', label: 'admin.tabs.macros' },
  { name: 'admin-macro-runs', label: 'admin.tabs.macroRuns' },
  // issue #586：「关于」（版本三格，只读）。排在所有能操作的 tab 之后：它不帮人做决定，
  // 只在「现在跑的到底是哪份构建」出问题时被点开（v0.1.69 那次分裂的那一小时）。
  { name: 'admin-about', label: 'admin.tabs.about' },
] as const;

async function onLogout() {
  await auth.logout();
  router.replace('/login');
}
</script>

<template>
  <div class="min-h-screen flex flex-col bg-white">
    <header class="flex items-center gap-3 border-b border-black/10 px-3 py-2">
      <h1 class="text-xl font-medium mb-0">{{ t('admin.title') }}</h1>
      <span class="flex-1 text-black/50 text-sm">{{ who }}</span>
      <a v-if="hasWorkbench" data-test="back-to-workbench" :href="backToWorkbenchHref" class="text-sm underline">{{ t('admin.backToWorkbench') }}</a>
      <button
        class="rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5"
        @click="onLogout"
      >{{ t('common.logout') }}</button>
    </header>

    <nav class="flex gap-1 border-b border-black/10 px-3" :aria-label="t('admin.tabs.label')">
      <router-link
        v-for="tab in tabs"
        :key="tab.name"
        :to="{ name: tab.name }"
        class="border-b-2 px-3 py-2 text-sm"
        :class="route.name === tab.name
          ? 'border-brand font-semibold text-brand'
          : 'border-transparent text-black/60 hover:bg-black/5 hover:text-black'"
      >{{ t(tab.label) }}</router-link>
    </nav>

    <main class="flex-1 p-3">
      <router-view />
    </main>
  </div>
</template>
