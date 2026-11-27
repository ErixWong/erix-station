<script setup lang="ts">
// issue #818：管理台外壳。顶栏只留「我是谁 / 我怎么出去」，15 项导航**全部下沉**到左侧分组侧栏
// （6 组 + 底部固定「关于」）。两个滚动面分开：侧栏自己滚、main 自己滚（一个 overflow 管两边
// 会让长页面把导航顶出视野）。窄屏（< 900px）自动收成 44px 图标轨，全词提示靠 CSS 的
// :focus-within / :focus-visible 出（**不是** mouseenter —— 本仓库 #691 的教训：只绑鼠标的
// 提示键盘用户永远看不到）。
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useSiteStore } from '../stores/site';
import { hashUrl } from '../lib/hostGate';
// #804：管理台必须自己挂语言切换。它是独立 origin（`admin.<伞域>:<端口>`），偏好不跟用户面共享；
// 且 #450 边缘隔离之后「先在用户面切好再进来」这条前提已不成立（两个 host 各发一份 SPA）。
import LocaleSwitch from '../components/LocaleSwitch.vue';
// issue #818 §⑤：组图标 = 自维护内联 SVG（几何在 `lib/icons.ts`，**不引图标库**）。
import AppIcon from '../components/AppIcon.vue';
// issue #818 §③：「跳到…」过滤要**同时**匹配中文项名与英文译文（不管当前界面是哪门子语言，
// 用英文界面的人搜「宏」也该搜得到 Macro runs）。直接读两份 locale 树，不走 `t()` 的当前语言。
import { zhCN } from '../i18n/locales/zh-CN';
import { en } from '../i18n/locales/en';

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

// **红线（issue #818）**：这 15 项的 `name`（= `:to` 的路由名）与 `label`（= i18n 键）一个字都不许改，
// 改了就是断链接 + 断 i18n。#818 只做两件事：把它们**重排**进 6 个组，以及给每组配一个组名/图标。
const tabs = [
  { name: 'admin-users', label: 'admin.tabs.users' },
  // issue #727 片 2：「工位内容」（某个 FDE 的会话与文件，只读）。插在 users 之后：
  // 它是「看人」的延伸，users 行上的链接是它的第二个入口。
  { name: 'admin-seat-content', label: 'admin.tabs.seatContent' },
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
  // issue #677 P2b：运行时设置列表（§4.21）。紧随 prompts：upload / prompts / runtime 三块都是
  // 「改一行而不必重建镜像」的平台配置，因此仍排在号池占用（只读运维快照）之前。
  // 请求只在该视图挂载时发（`AdminRuntimeSettingsView` 的 onMounted 是唯一触发点）。
  { name: 'admin-runtime', label: 'admin.tabs.runtime' },
  // issue #595 M2：能力市场发布台（条目表 + 发布/下线 + 扇描结果）。与证书/上传同为平台配置，
  // 因此排在号池占用（只读运维快照）之前。
  { name: 'admin-market', label: 'admin.tabs.market' },
  // issue #650：「系统」（宿主 CPU / 内存 / 磁盘 / 容器数，只读）。插在能力市场之后、号池占用之前：
  // 与号池占用同属**只读宿主快照**（先看人/配置，再来看宿主与号池），工单 §tab 位置就写了这一句。
  { name: 'admin-system', label: 'admin.tabs.system' },
  // issue #350：号池占用总览（只读）。放在最后：先看用户/配置，选段时才来这里。
  { name: 'admin-preview-pool', label: 'admin.tabs.previewPool' },
  // issue #529（事件平台 W6）：宏模板配置 + 宏执行历史。追加在末尾（模板 → 执行历史）。
  { name: 'admin-macros', label: 'admin.tabs.macros' },
  { name: 'admin-macro-runs', label: 'admin.tabs.macroRuns' },
  // issue #586：「关于」（版本三格，只读）。排在所有能操作的 tab 之后：它不帮人做决定，
  // 只在「现在跑的到底是哪份构建」出问题时被点开（v0.1.69 那次分裂的那一小时）。
  { name: 'admin-about', label: 'admin.tabs.about' },
] as const;

type TabName = (typeof tabs)[number]['name'];

// issue #818 §②：6 个分组（数组顺序 = 侧栏渲染顺序，照工单的表）。`items` 只引用上面 `tabs` 里的
// `name`，**不重复 label**（组名另开 `admin.navGroup.*` 六个键，不复用项名 —— 工单红线）。
// 「15 项恰好被覆盖一次」由 `groupedTabs` 兜住（漏项 ⇒ 下面 `unassignedTabs` 非空，用例钉住）。
const navGroups = [
  { id: 'usersSeats', icon: 'users', label: 'admin.navGroup.usersSeats', items: ['admin-users', 'admin-seat-content'] },
  { id: 'models', icon: 'cpu', label: 'admin.navGroup.models', items: ['admin-llm', 'admin-market'] },
  { id: 'platformAccess', icon: 'plug', label: 'admin.navGroup.platformAccess', items: ['admin-repos', 'admin-mail', 'admin-tls'] },
  { id: 'platformConfig', icon: 'sliders', label: 'admin.navGroup.platformConfig', items: ['admin-upload', 'admin-prompts', 'admin-runtime'] },
  { id: 'observe', icon: 'activity', label: 'admin.navGroup.observe', items: ['admin-system', 'admin-preview-pool'] },
  { id: 'macros', icon: 'zap', label: 'admin.navGroup.macros', items: ['admin-macros', 'admin-macro-runs'] },
] as const satisfies readonly { id: string; icon: string; label: string; items: readonly TabName[] }[];

// 底部固定项（不分组）：「关于」不帮人做决定，所以不参与分组，钉在侧栏末尾。
const footerTabNames = ['admin-about'] as const;

const groupIds = navGroups.map((group) => group.id) as readonly string[];
const groupOf = (name: unknown): string | null =>
  navGroups.find((group) => (group.items as readonly string[]).includes(String(name)))?.id ?? null;

// ---- 「跳到…」过滤（§③）--------------------------------------------------------------
const query = ref('');
const filtering = computed(() => query.value.trim().length > 0);

/** 沿 `a.b.c` 取一份 locale 树里的字符串；取不到给空串（脏键不许抛）。 */
function messageAt(root: unknown, path: string): string {
  let node: unknown = root;
  for (const segment of path.split('.')) node = (node as Record<string, unknown>)[segment];
  return typeof node === 'string' ? node : '';
}

/** 命中判据：子串、大小写不敏感，**中文项名与英文译文任一命中**即可。 */
function matches(labelKey: string): boolean {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return true;
  return [messageAt(zhCN, labelKey), messageAt(en, labelKey)]
    .some((text) => text.toLowerCase().includes(needle));
}

const groupedTabs = computed(() =>
  navGroups.map((group) => ({
    ...group,
    items: group.items
      .map((name) => tabs.find((tab) => tab.name === name))
      .filter((tab): tab is (typeof tabs)[number] => !!tab && matches(tab.label)),
  })),
);
// 过滤态下整组没剩任何项 ⇒ 连组标题一起藏（否则「只剩匹配项」会被空组标题污染）。
const visibleGroups = computed(() => groupedTabs.value.filter((group) => group.items.length > 0));
const footerTabs = computed(() => tabs.filter((tab) => (footerTabNames as readonly string[]).includes(tab.name) && matches(tab.label)));
const noMatch = computed(() => filtering.value && visibleGroups.value.length === 0 && footerTabs.value.length === 0);
// 结构自检（不是装饰）：分组表漏抄一项 ⇒ 这一项在管理台里**没有任何入口**（历史上加 tab 只要往
// `tabs` 里塞一行就行，现在多了一层分组，漏分组 = 静默失联）。用例 `15 个链接不多不少` 钉住它。
const unassignedTabs = computed(() =>
  tabs.filter((tab) => !navGroups.some((group) => (group.items as readonly string[]).includes(tab.name))
    && !(footerTabNames as readonly string[]).includes(tab.name)).map((tab) => tab.name),
);

// ---- 展开态：默认只展开当前组 + 导航强制展开 + localStorage 往返（§③）----------------
// **不进 DB**：这是「这台浏览器今天想看哪几组」，不是账号属性（换机器不该带走，也不值得一次迁移）。
const EXPANDED_KEY = 'admin.nav.expanded';

function readExpanded(): string[] | null {
  // try/catch 是必需的：隐私模式 / 禁用存储的浏览器里 `localStorage` 本身就会抛（同 `i18n/index.ts`
  // 读语言偏好的口径），而导航不能因为存储不可用而消失。
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (raw === null) return null; // **没存过** ≠ 存了空数组：前者才走默认值
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((id): id is string => typeof id === 'string' && groupIds.includes(id));
  } catch {
    return null;
  }
}

function writeExpanded(ids: readonly string[]): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(ids));
  } catch {
    /* 存不下就算了：展开态丢了只是下次进来回到默认，不该弹错误条 */
  }
}

const expanded = ref<string[]>(readExpanded() ?? [groupOf(route.name)].filter((id): id is string => !!id));

function persistExpanded(): void {
  writeExpanded(expanded.value);
}

function toggleGroup(id: string): void {
  expanded.value = expanded.value.includes(id)
    ? expanded.value.filter((each) => each !== id)
    : [...expanded.value, id];
  persistExpanded();
}

// **导航时强制展开目标组**（哪怕用户刚手动收起过它）：人刚点进去的组收起着 = 看不见自己在哪。
// 首帧不需要这里管（默认值已经按当前路由算好）。
watch(() => route.name, (name) => {
  const id = groupOf(name);
  if (!id || expanded.value.includes(id)) return;
  expanded.value = [...expanded.value, id];
  persistExpanded();
});

/** 过滤态强制展开所有（残留的）组：搜出来 15 项却要逐组点开就等于没搜；清空后回到原展开态。 */
function isExpanded(id: string): boolean {
  return filtering.value ? true : expanded.value.includes(id);
}

/** 当前项标 `aria-current="page"`，其余项**不给这个属性**（给 `null`/`undefined` 以外的取值会
 *  在 DOM 上留下 `aria-current="false"`，读屏会把没选中的项也念成「当前」）。 */
/** `<router-link>` 的 props 类型里没有 `data-*` / `aria-*`（vue-tsc 只认组件声明过的 props，
 *  而 `ComponentCustomProps` 在本仓库是空的），所以这两颗只能走 **`v-bind` 一个带索引签名的对象**。
 *  取值口径：非当前项给 `undefined` ⇒ Vue 直接不写这个属性（写 `null` 会留下 `aria-current=""`，
 *  读屏会把没选中的项也念成「当前」）。 */
function navAttrs(name: TabName): Record<string, string | undefined> {
  return {
    'data-test': `nav-link-${name}`,
    'aria-current': route.name === name ? 'page' : undefined,
  };
}

// ---- 图标轨（§①）--------------------------------------------------------------------
// 窄屏靠 CSS 媒体查询自动收；这一颗是**宽屏上手也能动**的开关（侧栏常驻 210px 时也想看内容区）。
const rail = ref(false);

async function onLogout() {
  await auth.logout();
  router.replace('/login');
}
</script>

<template>
  <div class="min-h-screen flex flex-col bg-white">
    <!-- skip-to-content（§④）：读屏 / 键盘用户不必先TAB 过 15 项导航才到正文。
         `sr-only focus:not-sr-only` = 平时视觉隐藏、拿到焦点就现形；落点 `#admin-main` 在 main 上。 -->
    <a
      href="#admin-main"
      data-test="skip-to-content"
      class="sr-only focus:not-sr-only focus:absolute focus:top-1 focus:left-1 focus:z-50 focus:rounded-md focus:border focus:border-black/20 focus:bg-white focus:px-2 focus:py-1 focus:text-sm"
    >{{ t('admin.nav.skip') }}</a>

    <header class="flex items-center gap-3 border-b border-black/10 px-3 py-2">
      <h1 class="text-xl font-medium mb-0">{{ t('admin.title') }}</h1>
      <span class="flex-1 text-black/50 text-sm">{{ who }}</span>
      <a v-if="hasWorkbench" data-test="back-to-workbench" :href="backToWorkbenchHref" class="text-sm underline">{{ t('admin.backToWorkbench') }}</a>
      <!-- ⚠ 必须插在登出**之前**：本仓库 `AdminLayout.spec.ts` 用 `findAll('header button').at(-1)` 取登出那颗，
           插到它之后会把登出按钮「换掉」（收口判据当场失真）。侧栏那颗折叠按钮在 `<aside>` 里，同理不进 header。 -->
      <LocaleSwitch />
      <button
        class="rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5"
        @click="onLogout"
      >{{ t('common.logout') }}</button>
    </header>

    <!-- 一行两列：侧栏 210px / main 各自 `overflow-y-auto`（两个滚动面，不许合并）。 -->
    <div class="flex flex-1 min-h-0">
      <aside class="admin-side flex shrink-0 flex-col border-r border-black/10" :class="{ 'is-rail': rail }">
        <div class="p-2">
          <input
            v-model="query"
            type="search"
            data-test="nav-filter"
            :placeholder="t('admin.nav.filterPlaceholder')"
            :aria-label="t('admin.nav.filterPlaceholder')"
            class="w-full rounded-md border border-black/15 px-2 py-1 text-sm"
          />
        </div>

        <nav class="admin-nav flex-1 overflow-y-auto px-2 pb-3 text-sm" :aria-label="t('admin.tabs.label')">
          <p v-if="unassignedTabs.length" data-test="nav-unassigned" class="text-xs text-red-700">
            {{ unassignedTabs.join(', ') }}
          </p>

          <div
            v-for="group in visibleGroups"
            :key="group.id"
            class="mb-1"
            data-test="nav-group"
            :data-group="group.id"
          >
            <button
              type="button"
              class="nav-item nav-group-title flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-medium hover:bg-black/5"
              :data-test="`nav-group-${group.id}`"
              :aria-expanded="isExpanded(group.id) ? 'true' : 'false'"
              @click="toggleGroup(group.id)"
            >
              <AppIcon :name="group.icon" />
              <span class="nav-label flex-1 truncate">{{ t(group.label) }}</span>
              <span class="nav-caret text-black/40" aria-hidden="true">{{ isExpanded(group.id) ? '▾' : '▸' }}</span>
            </button>

            <!-- `v-show` 而不是 `v-if`：收起的组**链接仍在 DOM 里**（只是不可见），
                 这样「15 项一个不少」这条判据与展开态无关（v-if 会让它随展开态抖成 2/4/15）。 -->
            <ul v-show="isExpanded(group.id)" class="ml-2 flex flex-col gap-0.5">
              <li v-for="item in group.items" :key="item.name">
                <router-link
                  :to="{ name: item.name }"
                  class="nav-item flex items-center gap-2 rounded-md px-2 py-1"
                  v-bind="navAttrs(item.name)"
                  :class="route.name === item.name
                    ? 'bg-brand/10 font-semibold text-brand'
                    : 'text-black/70 hover:bg-black/5 hover:text-black'"
                >{{ t(item.label) }}</router-link>
              </li>
            </ul>
          </div>

          <p v-if="noMatch" data-test="nav-no-match" class="px-2 py-2 text-xs text-black/50">
            {{ t('admin.nav.noMatch') }}
          </p>

          <!-- 底部固定项：不参与分组（「关于」不帮人做决定），但仍在那 15 项里 ⇒ 留在同一个 <nav> 内。 -->
          <div class="border-t border-black/10 pt-2 mt-2" data-test="nav-footer">
            <router-link
              v-for="item in footerTabs"
              :key="item.name"
              :to="{ name: item.name }"
              class="nav-item flex items-center gap-2 rounded-md px-2 py-1"
              v-bind="navAttrs(item.name)"
              :class="route.name === item.name
                ? 'bg-brand/10 font-semibold text-brand'
                : 'text-black/70 hover:bg-black/5 hover:text-black'"
            >
              <AppIcon name="info" />
              <span class="nav-label">{{ t(item.label) }}</span>
            </router-link>
          </div>
        </nav>

        <button
          type="button"
          data-test="nav-rail-toggle"
          class="border-t border-black/10 px-2 py-1.5 text-left text-xs text-black/50 hover:bg-black/5"
          :aria-pressed="rail ? 'true' : 'false'"
          :aria-label="rail ? t('admin.nav.expand') : t('admin.nav.collapse')"
          :title="rail ? t('admin.nav.expand') : t('admin.nav.collapse')"
          @click="rail = !rail"
        >{{ rail ? '⇄' : '⇤' }}</button>
      </aside>

      <main id="admin-main" class="flex-1 overflow-y-auto p-3">
        <router-view />
      </main>
    </div>
  </div>
</template>

<style scoped>
/* issue #818 §①：侧栏宽度与窄屏图标轨。
   全词提示**必须键盘可触发** ⇒ 用 `:focus-within` / `:focus-visible`（#691 前科：只绑 mouseenter
   的提示键盘用户永远看不到）。这里刻意不写 JS 的 mouseenter 监听：CSS 能做的别拿 JS 做。
   ⚠ 44px 轨道 + 「hover/focus 出全词」在媒体查询与手动折叠两处规则相同，媒体查询无法与外层
   选择器表合并，所以下面整段是**有意的重复**（改一处要改两处）。 */
.admin-side {
  width: 210px;
}
.admin-nav {
  /* 只有一层滚动：侧栏自己滚，正文另算（见模板里的两个 overflow-y-auto）。 */
  overscroll-behavior: contain;
}
.nav-item {
  position: relative;
}

.admin-side.is-rail {
  width: 44px;
}
.admin-side.is-rail .nav-label,
.admin-side.is-rail .nav-caret,
.admin-side.is-rail [data-test='nav-filter'] {
  display: none;
}
.admin-side.is-rail .nav-item:hover .nav-label,
.admin-side.is-rail .nav-item:focus-within .nav-label,
.admin-side.is-rail .nav-item:focus-visible .nav-label {
  display: block;
  position: absolute;
  left: 38px;
  top: 2px;
  z-index: 30;
  max-width: 220px;
  white-space: nowrap;
  border-radius: 4px;
  border: 1px solid rgb(0 0 0 / 10%);
  background: #fff;
  padding: 2px 6px;
  box-shadow: 0 1px 4px rgb(0 0 0 / 12%);
}

@media (max-width: 899px) {
  .admin-side {
    width: 44px;
  }
  .admin-side .nav-label,
  .admin-side .nav-caret,
  .admin-side [data-test='nav-filter'] {
    display: none;
  }
  .admin-side .nav-item:hover .nav-label,
  .admin-side .nav-item:focus-within .nav-label,
  .admin-side .nav-item:focus-visible .nav-label {
    display: block;
    position: absolute;
    left: 38px;
    top: 2px;
    z-index: 30;
    max-width: 220px;
    white-space: nowrap;
    border-radius: 4px;
    border: 1px solid rgb(0 0 0 / 10%);
    background: #fff;
    padding: 2px 6px;
    box-shadow: 0 1px 4px rgb(0 0 0 / 12%);
  }
}
</style>
