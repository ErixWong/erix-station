<script setup lang="ts">
// 侧栏（issue #84 P5.4，设计文档 §4 左栏竖排三段；issue #92 改 aside 内 flex-col 三段布局）：
//   ① 固定头：目录下拉（DirSelect：目录名 + ●N 运行态徽标 + ↻ 双刷；末项「＋ 新建目录」
//      选中新版弹 modal —— NewDirectoryModal，不再内联挤在头部）+ 「＋ 新会话」按钮 +
//      🔍 浏览会话（issue #94 入口；Ctrl/⌘+K 同语义）——不随列表滚动
//   ② 会话列表段：flex-1 min-h-0 overflow-y-auto，独立内部滚动（空态文案「先创建目录」/
//      「暂无会话」/平台管理员提示也放这里）——列表再长也不推挤头与树
//   ③ 目录树面板（DirectoryTree，默认收起，懒展开）：固定底部，任意会话数下恒可达
// issue #94（评审裁决瘦身版）：SessionPickerModal（单次全量浏览）挂在本组件与 WorkbenchView。
// 移动端抽屉（≤768px）由父级 WorkbenchView 以 Tailwind max-md: 变体实现（旧 offcanvas 桥接的等价），
// 三段结构在抽屉内同样成立（aside 高度由 max-md:inset-y-0 撑满，h-full 生效）。
import { nextTick, ref } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';
import { useWorkbenchStore } from '../stores/workbench';
import type { Session } from '../stores/workbench';
import { SESSION_TITLE_MAX_LEN } from '../lib/constants';
import DirSelect from './DirSelect.vue';
import DirectoryTree from './DirectoryTree.vue';
import FilePreviewModal from './FilePreviewModal.vue';
import NewDirectoryModal from './NewDirectoryModal.vue';
import SessionPickerModal from './SessionPickerModal.vue';

// issue #101 P2：用户可见文案走 i18n（sidebar.* / common.*；代码注释保持中文原文）。
const { t } = useI18n();
const store = useWorkbenchStore();
const auth = useAuthStore();
const emit = defineEmits<{
  (e: 'select-session', id: string): void;
  (e: 'new-session'): void;
}>();

// ---- ↻ 单按钮双刷：/api/dirs（store.refreshDirs）+ 目录树（组件 reload → 全折叠重载根层）----
const treeRef = ref<InstanceType<typeof DirectoryTree> | null>(null);
function onRefresh() {
  void store.refreshDirs().catch(() => { /* loadDirs 失败静默：下拉保留旧数据，下次刷新重试 */ });
  treeRef.value?.reload();
}

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
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- issue #92：aside 内 flex-col 三段（固定头 / 列表独立滚 / 树固定底）；h-full 铺满 aside 高 -->
    <!-- ⚠️ 根级不放注释：注释+元素会被 Vue 3 编成多根 fragment（禁用属性透传，也破坏单根断言） -->
    <!-- ① 固定头：不随会话列表滚动 -->
    <div class="shrink-0">
      <!-- 常驻「管理台」入口（旧 index.html header adminLink 的 SPA 等价；admin 角色才显示） -->
      <!-- issue #112：侧栏头控件统一 32px 高 / 7px 圆角 / 12px 字号（对齐 pi-web 控件规格） -->
      <router-link
        v-if="auth.user?.role === 'admin'"
        to="/admin"
        class="mb-2 block h-8 rounded-[7px] border border-black/20 bg-black/[.03] px-2.5 text-center text-[12px] leading-8 hover:bg-black/10"
      >{{ t('common.adminConsole') }}</router-link>

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
    <div class="mt-2 min-h-0 flex-1 overflow-y-auto">
      <!-- issue #112：空态文案 11px / text-dim / padding 8px 10px（对齐 pi-web 空态规格） -->
      <div v-if="store.noDir">
        <p v-if="store.isPlatformAdmin" class="px-2.5 py-2 text-[11px] leading-[1.5] text-black/50">
          {{ t('common.platformAdminHint') }}<br><router-link to="/admin" class="underline">{{ t('common.goToAdmin') }}</router-link>
        </p>
        <p v-else class="px-2.5 py-2 text-[11px] leading-[1.5] text-black/50">{{ t('common.createFirstDir') }}</p>
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
              <!-- 副行：11px / text-dim / marginTop 2 -->
              <div class="mt-0.5 truncate text-[11px] leading-[1.4] text-black/50">{{ store.sessMeta(s) }}</div>
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

    <!-- ③ 目录树面板（默认收起，懒展开；文件点击 → P6 预览 modal）：固定底部恒可达 -->
    <!-- shrink-0 经属性透传合并到 DirectoryTree 根元素，树展开再多条目也不缩列表段为负；
         max-h-[40vh] + overflow-y-auto：树面板自身限高内部滚动，不无限侵占侧栏高度（issue #92） -->
    <DirectoryTree ref="treeRef" class="shrink-0 max-h-[40vh] overflow-y-auto" :cwd="store.dirCwd" @file-click="onFileClick" />

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
