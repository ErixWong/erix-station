<script setup lang="ts">
// 目录树面板（issue #84 P5.4，设计文档 §4 左下段）：默认收起（▸ 目录树）；展开后按
// GET /api/files/tree?cwd=&path= 懒加载单层列表——初始只有根一层，点某目录项展开下一层；
// 不跨刷新记忆，reload()（↻ 按钮路径）后回到全折叠；切换 cwd 时树自动归位。
// 根 = 选中目录（= 会话 cwd = jail root，三锚合一）；P6（issue #84）：文件节点点击 emit
// file-click（相对路径），由 SidebarPanel 打开 FilePreviewModal；目录节点维持折叠语义不变。
import { computed, ref, shallowReactive, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../api';
import { useAuthStore } from '../stores/auth';
import type { TreeEntry } from '../lib/tree';
import DirTreeNode from './DirTreeNode.vue';

// issue #101 P2：用户可见文案走 i18n（tree.* / common.*）。
const { t } = useI18n();

const props = defineProps<{ cwd: string | null }>();
const emit = defineEmits<{
  (e: 'file-click', path: string): void; // 文件节点相对路径（嵌套为 a/b/c）
  // issue #472：上传成功 ⇒ 磁盘上多了新文件。父级链（SidebarPanel → WorkbenchView）拿它去重判
  // 收工灯（D9：新文件未跟踪 ⇒ 灯该变红，红是进度不是警报）。不重判 = 骗人。
  (e: 'files-changed'): void;
}>();

// issue #472：上传是 per-user 能力位（片 A 的 users.file_upload_enabled，管理台里开）。
// ⚠ **`=== true`，不是「不为 false」**：缺键 = 不知道 = 不显示（旧 `/api/me` / 首登 DTO 漂移时
// 宁可少给一个按钮，不要给一个点了必 403 的按钮）。判据：B-13 三态。
const auth = useAuthStore();
const canUpload = computed(() => auth.user?.file_upload_enabled === true);

const open = ref(false); // 面板展开开关（默认收起）
const childMap = shallowReactive(new Map<string, TreeEntry[]>()); // pathKey → 单层条目
const expandedSet = shallowReactive(new Set<string>()); // 已展开目录（pathKey）
const loadingSet = shallowReactive(new Set<string>()); // 加载中的 pathKey
const error = ref('');

async function load(path: string) {
  if (!props.cwd) return;
  loadingSet.add(path);
  try {
    const data = await api<{ entries?: TreeEntry[] }>(
      `/api/files/tree?cwd=${encodeURIComponent(props.cwd)}&path=${encodeURIComponent(path)}`,
    );
    childMap.set(path, data.entries ?? []);
  } catch (e) {
    expandedSet.delete(path); // 加载失败：展开态回滚，错误行留在面板顶部
    error.value = t('errors.treeLoadFailed', { message: e instanceof Error ? e.message : String(e) });
  } finally {
    loadingSet.delete(path);
  }
}

/** 目录节点点击：展开/收起；首次展开触发下一层懒加载（点一级出一层）。 */
function toggleNode(pathKey: string) {
  error.value = '';
  if (expandedSet.has(pathKey)) {
    expandedSet.delete(pathKey);
    return;
  }
  expandedSet.add(pathKey);
  if (!childMap.has(pathKey)) void load(pathKey);
}

/** 文件节点点击：emit 相对路径（P6 预览，父级 SidebarPanel 打开 modal）。 */
function fileClick(pathKey: string) {
  emit('file-click', pathKey);
}

/** ↻ 双刷之一：清缓存与展开态（全折叠）；面板若开着则重载根层。SidebarPanel 经 ref 调用。 */
function reload() {
  childMap.clear();
  expandedSet.clear();
  loadingSet.clear();
  error.value = '';
  if (open.value) void load('');
}
defineExpose({ reload });

// ---------------------------------------------------------------------------
// issue #472：上传（原始字节体直传 `POST /api/files/upload`，零 multipart 依赖）
// ---------------------------------------------------------------------------

/** 与 docs/api/portal.md §4.14 的响应 DTO 同形。 */
interface UploadResult {
  path: string;
  bytes: number;
  overwritten: boolean;
}

const fileInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
/** 上传结果行：`busy` / `ok` / `err`（`err` 走 role=alert）。 */
const uploadLine = ref<{ kind: 'busy' | 'ok' | 'err'; text: string } | null>(null);

function uploadUrlFor(name: string, overwrite: boolean): string {
  const q = new URLSearchParams({ cwd: props.cwd ?? '', path: '.', name });
  if (overwrite) q.set('overwrite', '1');
  return `/api/files/upload?${q.toString()}`;
}

/** 字节体上传：**必须走 `api()`**（它带 #255 受限会话跳转、#246 的 details、错误信封与 ApiError.code；
 * 裸 fetch 把这些全丢掉 ⇒ 403/413/409 在前端变成一堆「请求失败」）。 */
function postFile(name: string, file: File, overwrite: boolean): Promise<UploadResult> {
  return api<UploadResult>(uploadUrlFor(name, overwrite), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
}

/** 服务端码 → 文案（只翻译我们**自己发过**的码；其余保留服务端 message，兜底 errors.requestFailed 已在 api() 里做过）。 */
function uploadErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'upload_disabled': return t('tree.upload.errDisabled');
      case 'file_too_large': return t('tree.upload.errTooLarge');
      case 'upload_interrupted': return t('tree.upload.errInterrupted');
      case 'not_found': return t('tree.upload.errNoDir');
      default: break;
    }
    return e.message || t('tree.upload.errGeneric', { status: e.status });
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * 上传单个文件。返回 `'ok'` / `'skip'`（409 而用户不覆盖）；其余失败抛出。
 * ⚠ 409 流程的硬约束（判据 B-14）：**确认之前零请求**——先 `confirm`，确认了才发第二个带
 * `overwrite=1` 的，而且**只对这一个文件**（批量里其余文件各自判自己的 409）。
 */
async function uploadOne(file: File): Promise<'ok' | 'skip'> {
  try {
    await postFile(file.name, file, false);
    return 'ok';
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.code === 'file_exists') {
      if (!window.confirm(t('tree.upload.overwriteConfirm', { name: file.name }))) return 'skip';
      await postFile(file.name, file, true);
      return 'ok';
    }
    throw e;
  }
}

function pickFiles() {
  fileInput.value?.click();
}

/** 选完文件：逐个顺次上传（串行 = 服务端同时只有一份 temp，失败也只影响自己那一个）。 */
async function onFilesPicked(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = ''; // 允许再选同一个文件（同名的 change 事件不会再来）
  if (!files.length || !props.cwd) return;
  uploading.value = true;
  uploadLine.value = { kind: 'busy', text: t('tree.upload.busy') };
  let ok = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const file of files) {
    try {
      if ((await uploadOne(file)) === 'ok') ok += 1;
      else skipped += 1;
    } catch (e) {
      failures.push(`${file.name}: ${uploadErrorMessage(e)}`);
    }
  }
  uploading.value = false;
  if (ok > 0) {
    reload(); // 树里看见新文件
    emit('files-changed'); // 收工灯重判（父级）
  }
  if (failures.length) uploadLine.value = { kind: 'err', text: failures.join('；') };
  else if (ok > 0) uploadLine.value = { kind: 'ok', text: t('tree.upload.success', { count: ok }) };
  else uploadLine.value = { kind: 'ok', text: t('tree.upload.allSkipped', { count: skipped }) };
}

// 切目录：树归位（全折叠 + 清缓存），新目录的根层在面板下次展开时加载。
watch(() => props.cwd, () => reload());
// 首次展开面板：加载根层（path=''）。
watch(open, (v) => { if (v && !childMap.has('') && !loadingSet.has('')) void load(''); });
</script>

<template>
  <!-- issue #112：目录树字号收敛——小节标题 11px/600/0.05em（中文不做 uppercase），行内 11–12px、行高收紧；懒展开交互不动 -->
  <div class="mt-3 border-t border-black/10 pt-2">
    <!-- issue #472：标题行改成 flex——**标题按钮仍是 DOM 里的第一个 button**（既有判据按
         `wrapper.get('button')` 拿它，顺序反过来会让整个旧 spec 假红）。 -->
    <div class="flex items-center gap-1">
      <button
        type="button"
        class="min-w-0 flex-1 rounded px-1 py-[3px] text-left text-[11px] font-semibold tracking-[0.05em] hover:bg-black/5"
        @click="open = !open"
      >{{ open ? '▾' : '▸' }} {{ t('tree.title') }}</button>
      <button
        v-if="canUpload"
        type="button"
        data-test="tree-upload"
        class="shrink-0 rounded px-1 py-[2px] text-[11px] text-black/60 hover:bg-black/5 disabled:opacity-50"
        :disabled="uploading || !cwd"
        :title="t('tree.upload.hint')"
        @click="pickFiles"
      >{{ t('tree.upload.button') }}</button>
      <!-- 隐藏的原生选择器：不自己造文件对话框（可访问性与移动端都靠它） -->
      <input
        v-if="canUpload"
        ref="fileInput"
        data-test="tree-upload-input"
        type="file"
        multiple
        class="hidden"
        @change="onFilesPicked"
      >
    </div>
    <p
      v-if="uploadLine"
      data-test="tree-upload-line"
      :class="uploadLine.kind === 'err' ? 'syserr px-1 py-0.5 text-[11px]' : 'px-1 py-0.5 text-[11px] text-black/50'"
      :role="uploadLine.kind === 'err' ? 'alert' : undefined"
    >{{ uploadLine.text }}</p>
    <div v-if="open" class="mt-1 text-[12px] leading-[1.5]">
      <p v-if="!cwd" class="px-1 py-0.5 text-[11px] text-black/50">{{ t('tree.selectDirFirst') }}</p>
      <p v-else-if="error" class="syserr px-1 py-0.5" role="alert">{{ error }}</p>
      <template v-else>
        <p v-if="loadingSet.has('')" class="px-1 py-0.5 text-[11px] text-black/50">{{ t('common.loading') }}</p>
        <p v-else-if="!childMap.get('')?.length" class="px-1 py-0.5 text-[11px] text-black/50">{{ t('common.emptyDir') }}</p>
        <DirTreeNode
          v-for="e in childMap.get('') ?? []"
          :key="e.name"
          v-bind="e"
          path=""
          :depth="0"
          :child-map="childMap"
          :expanded-set="expandedSet"
          :loading-set="loadingSet"
          :toggle-node="toggleNode"
          :file-click="fileClick"
        />
      </template>
    </div>
  </div>
</template>
