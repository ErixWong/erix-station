<script setup lang="ts">
// 侧栏（issue #84 P5.4，设计文档 §4 左栏竖排三段；issue #92 改 aside 内 flex-col 三段布局）：
//   ① 固定头：目录下拉（DirSelect：目录名 + ●N 运行态徽标 + ↻ 双刷；末项「＋ 新建目录」
//      选中新版弹 modal —— NewDirectoryModal，不再内联挤在头部）+ 「＋ 新会话」按钮 +
//      🔍 浏览会话（issue #94 入口；Ctrl/⌘+K 同语义）——不随列表滚动
//   ② 会话列表段：flex-1 min-h-0 overflow-y-auto，独立内部滚动（空态文案「先创建目录」/
//      「暂无会话」/平台管理员提示也放这里）——列表再长也不推挤头与树
//   ③ 底部堆叠区（issue #308）：**一个**滚动容器（shrink-0 max-h-[50vh] overflow-y-auto）里装
//      「进程监听段 + 目录树面板」，两段**各自一个折叠开关**（都默认折叠、不持久化、不共用总开关）。
//      issue #468 追加 A：原本的「端口池面板」整块退役（用户裁定只要折叠条上的「端口池 总量/空闲」两个数），
//      所以这个栈里只剩一段端口相关 UI（折叠条 data-test="process-watch-toggle"，用量文本 data-test="pool-usage"）。
//      高度/滚动预算只留这一层：树与端口面板都不再自带 overflow/max-h，否则三层滚动会抢滚轮。
//      底部栈恒在列表之下 ⇒ 任意会话数下端口段与目录树恒可达，而列表仍然独立可滚。
// issue #94（评审裁决瘦身版）：SessionPickerModal（单次全量浏览）挂在本组件与 WorkbenchView。
// 移动端抽屉（≤768px）由父级 WorkbenchView 以 Tailwind max-md: 变体实现（旧 offcanvas 桥接的等价），
// 三段结构在抽屉内同样成立（aside 高度由 max-md:inset-y-0 撑满，h-full 生效）。
//
// issue #308 的几何测试钩子（名字照工单 §五.7，不得自创）：
//   data-test="sidebar-aside"（根）/ "sidebar-session-list"（列表段）/ "sidebar-bottom-stack"（底部栈）。
import { computed, nextTick, onMounted, ref } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';
import { useSiteStore } from '../stores/site';
import { useWorkbenchStore } from '../stores/workbench';
import type { Session } from '../stores/workbench';
import { SESSION_TITLE_MAX_LEN } from '../lib/constants';
import DirSelect from './DirSelect.vue';
import DirectoryTree from './DirectoryTree.vue';
import FilePreviewModal from './FilePreviewModal.vue';
import NewDirectoryModal from './NewDirectoryModal.vue';
import { listenerItemsForProject } from '../lib/previewPorts';
import { hashUrl } from '../lib/hostGate';
import { ADMIN_CONSOLE_PATH } from '../lib/workbenchGate';
import PreviewPortsPanel from './PreviewPortsPanel.vue';
import SessionPickerModal from './SessionPickerModal.vue';
import { usePreviewPorts } from '../composables/usePreviewPorts';

// issue #101 P2：用户可见文案走 i18n（sidebar.* / common.*；代码注释保持中文原文）。
const { t } = useI18n();
const store = useWorkbenchStore();
const auth = useAuthStore();
const site = useSiteStore();
const emit = defineEmits<{
  (e: 'select-session', id: string): void;
  (e: 'new-session'): void;
  // issue #472：目录树上传成功 ⇒ 磁盘上多了文件。本组件只做**透传**（判定的语义属树，动作的语义属视图：
  // WorkbenchView 拿它重判收工灯）。不在这里自己调 git-light：灯的数据所有权在视图侧的 useGitLight。
  (e: 'files-changed'): void;
}>();

// #450 A2：「管理台」入口是**跨 host** 链接（用户面 `station.<伞域>` → 管理台 `admin.<伞域>:9443`）。
// A1 之后 `/api/admin/*` 在用户入口上就是 404 ⇒ 这颗按钮若还走 router-link（相对 `/admin`），
// 结果是「在用户 host 上渲染出管理台页面、所有管理 API 全 404」。改成用 `site` store 的 `adminBaseUrl`
// 拼绝对地址；拿不到 site 信息时退回相对 hash `#/admin`（同 origin，行为与改动前一致，由 host 闸兜底）。
const adminConsoleHref = computed(() => hashUrl(site.info?.adminBaseUrl, ADMIN_CONSOLE_PATH) ?? `#${ADMIN_CONSOLE_PATH}`);

// ---- ↻ 单按钮双刷：/api/dirs（store.refreshDirs）+ 目录树（组件 reload → 全折叠重载根层）----
// issue #308 §四：↻ 语义**不动**——它继续只刷「目录列表 + 目录树」，**不**扩到刷新预览端口
// （端口段有自己的「重试」按钮；且 usePreviewPorts.load() 没有 in-flight 守卫，扩功能要先自己加并发闸门，本单不做）。
const treeRef = ref<InstanceType<typeof DirectoryTree> | null>(null);
function onRefresh() {
  void store.refreshDirs().catch(() => { /* loadDirs 失败静默：下拉保留旧数据，下次刷新重试 */ });
  treeRef.value?.reload();
}

// ---- issue #308：预览端口段（从工作台顶栏搬进侧栏底部，与目录树各自独立折叠）----
// 语义逐字保持 #246：进视图就拉一次 GET /api/me/ports（折叠也拉，aside 在移动端是「类隐藏」不是 v-if）；
// 但**预览 ticket 绝不预取**——60 秒过期且一次性，预取等于把它用废（点击当场才签，见 usePreviewPorts.openPreview）。
// #247 的批量签票同一条纪律：只在点「打开全部预览」时调 `openAllPreviews`（挂载不签、折叠不签）。
// 折叠态是纯本地 ref，**不持久化**（不写 localStorage、不发后端），刷新后回到折叠。
const ports = usePreviewPorts();
// ---- #468 追加 A：侧栏只留**一个**端口相关面板（进程监听=事实维度）----
// 端口池面板（地址维度）已整块退役：用户裁定「只要在 listener 上写一下端口池的数量和空闲数量就好了」
// ⇒ 池的总量/空闲两个数字改挂在**进程监听折叠条**上（data-test="pool-usage"），不再单独开一块列表。
// ⚠ 管理台的 FdePreviewPortsPane（variant='table'）不受影响（运维面仍要看全量明细）。
const procOpen = ref(false);

/**
 * 池行（#468 追加 A）：只当「端口池 总量/空闲」两个数字的数据源（不再是面板）。
 * `url` 非空 = 池内（`observed:<port>` 合成行 url=null ⇒ 天然不计入）。
 */
const poolRows = computed(() => ports.items.value.filter((item) => item.url));
/** 观测可用判据：DTO 无 observed 键 = 旧后端 ⇒ 进程面板退场（null ≠ 空闲，不谎报）。 */
const observationsAvailable = computed(() => ports.items.value.some((item) => 'observed' in item));
/**
 * 进程监听面板的行（#468 **D1**）：只显示**当前项目的进程 + 未知项目的进程**，
 * 其它项目不显示（旧实现把 `groupByProject` 拍平当列表用 ⇒ 当前项目是 shop 时也能看到 probe-451 的口）。
 * 判据在 `lib/previewPorts.listenerItemsForProject`（含 D6：`store.dirCwd` 反推不出项目时不过滤）。
 */
const procItems = computed(() => listenerItemsForProject(ports.items.value, store.dirCwd));

const procToggleLabel = computed(() =>
  procItems.value.length > 0
    ? t('previewPorts.procToggleCount', { count: procItems.value.length })
    : t('previewPorts.procToggle'),
);

/**
 * 折叠条上的池用量（#468 追加 A D8）：`端口池 {total}/{idle}`（**池大小在前、空闲在后**，用户举的例子就这个顺序）。
 *   - `total` = 池内行数（`poolRows`）；`idle` = 池内且**无观测**（「没人在听」）；
 *   - ⚠ **不渲染的三个条件**（任一成立整段不出现，**绝不显示 `0/0`**）：
 *     未 loaded / 加载中且未 loaded / `listError` 非空（失败时面板自己已有错误块，不再叠一个假数字）；
 *   - `title` 与 `aria-label` 逐字相同（截断时完整口径仍可达，照 #308 那套纪律）。
 */
const poolUsage = computed(() => {
  if (!ports.loaded.value || ports.listError.value !== null) return null;
  const total = poolRows.value.length;
  const idle = poolRows.value.filter((item) => !item.observed).length;
  return { total, idle };
});
const poolUsageText = computed(() => (poolUsage.value === null ? '' : t('previewPorts.poolUsage', poolUsage.value)));
const poolUsageTitle = computed(() => (poolUsage.value === null ? '' : t('previewPorts.poolUsageTitle', poolUsage.value)));

// load() 自带 try/catch/finally（失败落 listError），不会产生未捕获拒绝（AGENTS §4 / #281）。
onMounted(() => { void ports.load(); });

// ---- issue #84 P6：目录树文件点击 → 文件预览 modal（cwd 上下文 = store.dirCwd）----
const previewTarget = ref<{ cwd: string; path: string } | null>(null);
function onFileClick(path: string) {
  if (!store.dirCwd) return; // 无目录时树面板本不可交互，防御性兜底
  previewTarget.value = { cwd: store.dirCwd, path };
}

// ---- issue #94：会话选择 modal（固定头 🔍 入口；Ctrl/⌘+K 由 WorkbenchView 提供）----
const pickerOpen = ref(false);
const pickerScope = ref<'cwd' | 'all'>('cwd');
function openPicker(scope: 'cwd' | 'all') {
  pickerScope.value = scope;
  pickerOpen.value = true;
}
function onPickerSelect(id: string) {
  pickerOpen.value = false;
  emit('select-session', id); // 路由 push/跨目录逻辑由视图 onSelectSession 统一处理
}

// ---- 「＋ 新建目录」modal（原内联表单迁出至 NewDirectoryModal，创建成功后打开新会话）----
const newDirOpen = ref(false);
function onNewDirCreated(sessionId: string) {
  newDirOpen.value = false;
  emit('select-session', sessionId); // 新目录 + 首个会话：路由 push 由视图做
}

// ---- issue #107：会话卡片内联重命名（PATCH /api/sessions/:id，零后端接口改动）----
// 交互：hover 卡片右端浮现铅笔按钮 → 点击原地换 <input>（不弹 modal；autofocus + 全选）；Enter 提交 /
// Esc 取消 / blur 提交；空串/纯空白前端拦截不发请求（空串落库会置 title_source='manual'，
// 永久关掉后续自动命名——宁可无操作）。同一时刻只允许一个卡片处于编辑态。
const editingId = ref<string | null>(null);
const editTitle = ref('');
const editError = ref<{ id: string; text: string } | null>(null); // 失败轻提示（卡片内 transient 行）
const editInput = ref<HTMLInputElement | null>(null);

/** 函数式 ref：v-for 内的字符串 ref 会退化为数组，函数 ref 对「同时只有一个编辑框」最直白。 */
function setEditInput(el: Element | ComponentPublicInstance | null) {
  editInput.value = el instanceof HTMLInputElement ? el : null;
}

async function startEdit(s: Session) {
  const id = String(s.id);
  editingId.value = id;
  editTitle.value = s.title ?? '';
  editError.value = null;
  await nextTick(); // input 挂载后聚焦 + 全选（改整个名字，而非在尾部追加）
  editInput.value?.focus();
  editInput.value?.select();
}

function cancelEdit() {
  editingId.value = null;
  editTitle.value = '';
}

/** Enter 提交 / Esc 取消；组词中的 Enter/Esc（中文输入法确认候选）不得当作提交/取消。 */
function onEditKeydown(e: KeyboardEvent) {
  if (e.isComposing) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    void commitEdit();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelEdit();
  }
}

/**
 * 提交（Enter / blur）：先退出编辑态再发请求——blur 迟到不会重复提交；空串拦截不发请求。
 * 成功：store.renameSession 已原地更新列表项（title/title_source），无需整表刷新；
 * 失败：store 未被改动（卡片自动回退旧标题）+ 卡片内一条轻提示（项目无 toast 体系，沿用 .syserr 行内）。
 */
async function commitEdit() {
  const id = editingId.value;
  if (id == null) return; // 已取消 / 已提交（重复 blur）
  editingId.value = null;
  const raw = editTitle.value;
  editTitle.value = '';
  if (!raw.trim()) return;
  const { error } = await store.renameSession(id, raw);
  if (error) editError.value = { id, text: t('errors.renameFailed', { message: error }) };
}

// ---- issue #114：「AI 改名」按钮（铅笔旁同款 24px 浮现方块按钮）----
// 点击 → 行内 loading（按钮禁用 + 转圈）→ POST /api/sessions/:id/ai-title → 成功原地更新 store 标题；
// 失败走卡片内 `.syserr` 行内提示（沿用 #107 模式，无 toast 体系）。同一时刻只允许一个请求在飞。
const aiLoadingId = ref<string | null>(null);

async function aiRename(s: Session) {
  const id = String(s.id);
  if (aiLoadingId.value != null) return; // 已有一个在飞：忽略重复点击（含跨行）
  aiLoadingId.value = id;
  editError.value = null; // 清掉上一次的行内提示（重命名/AI 改名共用同一提示行）
  const { error } = await store.aiRenameSession(id);
  aiLoadingId.value = null;
  if (error) editError.value = { id, text: t('errors.aiRenameFailed', { message: error }) };
}

// ---- issue #112：左栏视觉收敛（向 pi-web 靠拢）----
// 行样式为纯呈现层：选中判定抽成函数供 class 绑定复用（与原内联表达式语义完全等价，不改选中逻辑）。
/** 该会话是否为当前选中（行样式：左 2px brand 竖条 + 浅绿底）。 */
function isActive(s: Session): boolean {
  return String(s.id) === String(store.sessionId);
}

/**
 * issue #197：列表项副行的消息数后缀（「 · N 条消息」，口径同头部状态行：后端 listSessions
 * COUNT 全量 messages 行含 synthetic）。缺失（旧后端/非列表来源）或 0（与头部状态行
 * messages > 0 才显示的阈值一致，新会话不显示「0 条」）→ 返回空串不渲染。
 */
function messageCountSuffix(s: Session): string {
  const n = s.message_count;
  return typeof n === 'number' && n > 0 ? ` · ${t('sidebar.messageCount', { count: n })}` : '';
}
</script>

<template>
  <div data-test="sidebar-aside" class="flex h-full min-h-0 flex-col">
    <!-- issue #92：aside 内 flex-col 三段（固定头 / 列表独立滚 / 底部栈）；h-full 铺满 aside 高 -->
    <!-- ⚠️ 根级不放注释：注释+元素会被 Vue 3 编成多根 fragment（禁用属性透传，也破坏单根断言） -->
    <!-- ① 固定头：不随会话列表滚动 -->
    <div class="shrink-0">
      <!-- 常驻「管理台」入口（旧 index.html header adminLink 的 SPA 等价；admin 角色才显示） -->
      <!-- issue #112：侧栏头控件统一 32px 高 / 7px 圆角 / 12px 字号（对齐 pi-web 控件规格） -->
      <a
        v-if="auth.user?.role === 'admin'"
        data-test="admin-console-link"
        :href="adminConsoleHref"
        class="mb-2 block h-8 rounded-[7px] border border-black/20 bg-black/[.03] px-2.5 text-center text-[12px] leading-8 hover:bg-black/10"
      >{{ t('common.adminConsole') }}</a>

      <!-- 目录下拉 + ↻ 双刷（issue #84 P5：替换原项目 select + 新项目表单） -->
      <DirSelect @refresh="onRefresh" @new-dir="newDirOpen = true" />

      <!-- 「＋ 新建目录」选 → 弹 NewDirectoryModal（表单不再内联挤在头部） -->

      <!-- 「＋ 新会话」+ 🔍 浏览会话（issue #94：默认当前目录，无目录时全量；Ctrl/⌘+K 同语义） -->
      <!-- issue #112：控件 32px 高 / 7px 圆角 / 12px 字号（bg-hover→bg-selected 映射为本项目黑阶两档） -->
      <div class="mt-3 flex gap-2">
        <button
          class="h-8 flex-1 rounded-[7px] border border-black/20 bg-black/[.03] px-2.5 text-[12px] hover:bg-black/10 disabled:opacity-50"
          :disabled="store.newSessDisabled"
          @click="emit('new-session')"
        >{{ t('sidebar.newSession') }}</button>
        <button
          type="button"
          :title="t('sidebar.browseTitle')"
          :aria-label="t('sidebar.browse')"
          class="h-8 w-8 shrink-0 rounded-[7px] border border-black/20 bg-black/[.03] text-[12px] hover:bg-black/10"
          @click="openPicker(store.dirCwd ? 'cwd' : 'all')"
        >🔍</button>
      </div>
    </div>

    <!-- ② 会话列表段（该目录）：flex-1 min-h-0 + 独立内部滚动；空态文案也放这里（issue #92） -->
    <!-- issue #308：data-test="sidebar-session-list" 是几何判据的稳定钩子（列表可视高度/独立可滚） -->
    <div data-test="sidebar-session-list" class="mt-2 min-h-0 flex-1 overflow-y-auto">
      <!-- issue #112：空态文案 11px / text-dim / padding 8px 10px（对齐 pi-web 空态规格） -->
      <!-- issue #332：这里原有 `v-if="store.isPlatformAdmin"` 分支（「平台管理员：请到管理台…」+「进入管理台」
           链接）已删——无工位的平台管理员被路由守卫挡在管理台，该分支在工作台上不可达。 -->
      <div v-if="store.noDir">
        <p class="px-2.5 py-2 text-[11px] leading-[1.5] text-black/50">{{ t('common.createFirstDir') }}</p>
      </div>
      <div v-else>
        <p v-if="store.sessions.length === 0" class="px-2.5 py-2 text-[11px] leading-[1.5] text-black/50">{{ t('sidebar.noSessions') }}</p>
        <!-- issue #112：会话卡片 → 扁平行（对齐 pi-web SessionItem）：无边框卡片、左 14 右 8 内边距、
             选中 = 左 2px brand 竖条 + 浅绿底（border-l-2 常驻以免布局跳动）、hover = 浅灰底。
             用 min-h-[54px]（而非固定 height）保留行内错误提示行增高能力，正常两行内容下恰为 54px。 -->
        <div
          v-for="s in store.sessions"
          :key="String(s.id)"
          data-session-row
          class="group flex min-h-[54px] cursor-pointer items-center gap-1.5 border-l-2 pl-3.5 pr-2"
          :class="isActive(s) ? 'border-l-brand bg-green-50' : 'border-l-transparent hover:bg-black/5'"
          @click="emit('select-session', String(s.id))"
        >
          <!-- issue #107：编辑态 = 原地 input（不弹 modal）；非编辑态 = 标题 + hover/focus 浮现的铅笔按钮 -->
          <!-- issue #112：input 收敛为 12px / 30px 高 / 5px 圆角（对齐 pi-web 重命名规格） -->
          <input
            v-if="editingId === String(s.id)"
            :ref="setEditInput"
            v-model="editTitle"
            :maxlength="SESSION_TITLE_MAX_LEN"
            :placeholder="t('sidebar.renamePlaceholder')"
            :aria-label="t('sidebar.rename')"
            class="h-[30px] min-w-0 flex-1 rounded-[5px] border border-brand bg-white px-2 text-[12px] outline-none"
            @click.stop
            @keydown="onEditKeydown"
            @blur="commitEdit"
          >
          <template v-else>
            <div class="min-w-0 flex-1">
              <!-- 标题行：12px（选中 500 / 常规 400）+ 单行 ellipsis -->
              <div class="flex min-w-0 items-center gap-1.5 text-[12px] leading-[1.4]">
                <span class="min-w-0 truncate" :class="isActive(s) ? 'font-medium' : ''">{{ s.title || t('common.unnamedSession') }}</span>
              </div>
              <!-- 副行：11px / text-dim / marginTop 2；issue #197：尾部追加「 · N 条消息」（同字体克制灰字，缺失/0 不显示） -->
              <div class="mt-0.5 truncate text-[11px] leading-[1.4] text-black/50">{{ store.sessMeta(s) }}{{ messageCountSuffix(s) }}</div>
              <p v-if="editError?.id === String(s.id)" class="syserr mt-0.5" role="alert">{{ editError.text }}</p>
            </div>
            <!-- @click.stop：重命名入口不得误触「选中会话」 -->
            <!-- issue #114：「AI 改名」按钮——与铅笔同款 24px 浮现方块（点击才调一次 LLM），
                 行内 loading 时禁用 + 转圈（opacity 由动态类强制可见，不依赖 hover） -->
            <button
              type="button"
              :title="aiLoadingId === String(s.id) ? t('sidebar.aiRenaming') : t('sidebar.aiRename')"
              :aria-label="t('sidebar.aiRename')"
              :disabled="aiLoadingId === String(s.id)"
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] border border-black/15 bg-white text-black/50 hover:bg-black/10"
              :class="aiLoadingId === String(s.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'"
              @click.stop="aiRename(s)"
            >
              <!-- 转圈：loading 态（同一按钮原地换图标，不新增占位元素） -->
              <svg
                v-if="aiLoadingId === String(s.id)"
                class="animate-spin"
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              <!-- 非 loading：星辉/魔法闪光（lucide sparkles 轮廓，stroke=currentColor 风格同 #112 铅笔） -->
              <svg
                v-else
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
                <path d="M20 3v4" />
                <path d="M22 5h-4" />
                <path d="M4 17v2" />
                <path d="M5 18H3" />
              </svg>
            </button>
            <!-- issue #112：重命名入口重做——emoji ✏️ → 内联 SVG 铅笔（stroke/currentColor，不自带红色）
                 + 浮现按钮形状（24px 方块 / 5px 圆角 / 细边框，对齐 pi-web 图标按钮规格）；
                 title/aria-label/@click.stop/编辑态隐藏 语义全部保留，浮现逻辑仍 opacity-0 → group-hover:opacity-100 -->
            <button
              type="button"
              :title="t('sidebar.rename')"
              :aria-label="t('sidebar.rename')"
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] border border-black/15 bg-white text-black/50 opacity-0 hover:bg-black/10 focus-visible:opacity-100 group-hover:opacity-100"
              @click.stop="startEdit(s)"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </button>
          </template>
        </div>
      </div>
    </div>

    <!-- ③ 底部堆叠区（issue #308）：**唯一**的底部滚动容器——#468 追加 A 后里面是
         「进程监听段（带池用量）+ 目录树面板」，两段各自折叠（原本前面的端口池段已退役）；
         max-h-[50vh] 是高度预算（1280×768 下：aside 内容高 ≈706px − 固定头 76/116px
         − 列表 mt-2 8px − 栈上限 384px ⇒ 列表仍有 ≈238/198px ≥ 120px 判据），overflow-y-auto 只这一层。
         子层（端口面板 / 目录树）一律不再自带 max-h/overflow ⇒ 不会出现嵌套滚动条抢滚轮。 -->
    <div data-test="sidebar-bottom-stack" class="mt-2 shrink-0 max-h-[50vh] overflow-y-auto">
      <!-- ③-a 进程监听段（#468 追加 A 后这是唯一的端口区块）：事实维度——容器里真有进程在听的端口（含池外口），
           按项目分组且**只跟随当前项目**（+ 未知项目）。端口池面板已退役，池的总量/空闲只在本折叠条上给两个数。
           旧后端无观测（DTO 无 observed 键）⇒ 面板退场（不拿 null 谎报「没进程」）；但**加载失败必须有个地方说错误**
           ⇒ 闸多了 `|| listError`：否则 items 为空 ⇒ 旧闸把它挡掉 ⇒ 失败在侧栏里完全静默。 -->
      <div v-if="observationsAvailable || ports.listError.value !== null" class="mt-1 border-t border-black/10 pt-2">
        <button
          type="button"
          data-test="process-watch-toggle"
          class="flex w-full items-center gap-1.5 rounded px-1 py-[3px] text-left text-[11px] font-semibold tracking-[0.05em] hover:bg-black/5"
          :aria-expanded="procOpen"
          aria-controls="process-watch-disclosure"
          @click="procOpen = !procOpen"
        >
          <span aria-hidden="true">{{ procOpen ? '▾' : '▸' }}</span>
          <span>{{ procToggleLabel }}</span>
          <!-- #468 追加 A D8：端口池面板退役后，池的总量/空闲就挂在这条折叠条上（池大小/空闲，用户举例 `10/8`）。
               三个不渲染条件见 `poolUsage`（未 loaded / 加载中且未 loaded / listError）；title 与 aria-label 逐字相同。 -->
          <span
            v-if="poolUsage !== null"
            data-test="pool-usage"
            class="min-w-0 shrink truncate text-black/55"
            :title="poolUsageTitle"
            :aria-label="poolUsageTitle"
          >{{ poolUsageText }}</span>
        </button>
        <div v-show="procOpen" id="process-watch-disclosure" class="mt-1 min-w-0">
          <!-- v-show（非 v-if）：面板常驻 DOM（#246 语义：折叠只是不占位）；票仍然只在点击时签。
               ⚠ `ticket-error` / `popup-blocked-url` 跟着退役的池面板**迁到这里**（#468 追加 A）：
               现在全侧栏只有这一块有「打开预览」按钮，不接这两个 props 则签票失败与弹窗拦截会变成「点了没反应」。 -->
          <PreviewPortsPanel
            variant="list"
            group-by-project
            :items="procItems"
            :current-cwd="store.dirCwd"
            :loading="ports.loading.value"
            :loaded="ports.loaded.value"
            :error="ports.listError.value"
            :ticket-busy-id="ports.ticketBusyId.value"
            :ticket-error="ports.ticketError.value"
            :popup-blocked-url="ports.popupBlockedUrl.value"
            :empty-label="t('previewPorts.procEmpty')"
            @open="(item) => void ports.openPreview(item)"
          />
        </div>
      </div>

      <!-- ③-b 目录树面板（默认收起，懒展开；文件点击 → P6 预览 modal）：与端口段同栈、恒在最后 -->
      <!-- issue #308：树自己那层 max-h-[40vh] overflow-y-auto 已撤（滚动预算只留底部栈一层），
           shrink-0 / mt-3 / border-t 的分隔与「不缩列表」语义保留。 -->
      <DirectoryTree
        ref="treeRef"
        class="shrink-0"
        :cwd="store.dirCwd"
        @file-click="onFileClick"
        @files-changed="emit('files-changed')"
      />
    </div>

    <!-- issue #84 P6：文件预览 modal（v-if 挂载：打开才发 /api/file，关闭即卸载归还焦点） -->
    <FilePreviewModal
      v-if="previewTarget"
      :cwd="previewTarget.cwd"
      :path="previewTarget.path"
      @close="previewTarget = null"
    />

    <NewDirectoryModal
      v-if="newDirOpen"
      @created="onNewDirCreated"
      @close="newDirOpen = false"
    />

    <!-- issue #94：会话选择 modal（teleport 无必要——侧栏抽屉/桌面布局下 fixed 遮罩均覆盖全屏） -->
    <SessionPickerModal
      v-if="pickerOpen"
      :scope="pickerScope"
      :cwd="store.dirCwd ?? undefined"
      @select="onPickerSelect"
      @close="pickerOpen = false"
    />
  </div>
</template>
