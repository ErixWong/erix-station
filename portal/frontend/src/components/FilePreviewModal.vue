<script setup lang="ts">
// 文件预览 modal（issue #84 P6 第一版；#366 P0/P1/P2 扩通道）：目录树文件节点点击 → 本 modal。
// 四条渲染通道（lib/previewRoute.ts 的纯函数按扩展名分流）：
//   native-json —— 文本/Markdown/图片：/api/file JSON 契约，逐字节沿用 #84 行为
//                  （Markdown 复用 lib/markdown.ts + mermaid；文本 <pre>；图片 base64 <img>）；
//   native-stream — PDF/音视频：浏览器原生 <object>/<video>/<audio>，src=/api/file?mode=stream；
//   kkfile —— Office/压缩包等：POST /api/preview-tickets 签能力码 → iframe 指 /pv/<码>/onlinePreview
//                  （sandbox="allow-scripts" 无 allow-same-origin：kk 产物页脚本拿不到 portal 会话）；
//   other —— 清单外：不发任何请求，直接给下载。
// 失败态（413/415/502/网络）：错误 message 直显 + 「下载」按钮（P0：死路页的出口）。
// 交互对齐 SessionPickerModal：dialog 语义（role/aria-modal）、Esc 关闭、打开焦点进 dialog、
// 关闭归还触发按钮、锁背景滚动。
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import { renderMarkdown } from '../lib/markdown';
// 与 StreamPanel 同口径：.md 预览里的 ```mermaid 块也挂图（v-html 落定后 DOM 后处理）。
import { vMermaid } from '../directives/mermaid';
import {
  downloadUrl, isMarkdownName, jsonPreviewUrl, previewChannel, streamMediaKind, streamPreviewUrl,
} from '../lib/previewRoute';

// issue #101 P2：用户可见文案走 i18n（preview.* / common.*）；错误 message 来自后端（原样展示）。
const { t } = useI18n();

const props = defineProps<{ cwd: string; path: string }>(); // path = 相对 tree 根（= cwd）的路径
const emit = defineEmits<{ (e: 'close'): void }>();

interface FilePreview {
  name: string;
  path: string;
  kind: 'image' | 'text';
  data: string;
}
interface PreviewTicket {
  url: string;
  expires_in: number;
}

const channel = computed(() => previewChannel(props.path));
const mediaKind = computed(() => streamMediaKind(props.path));
const dlUrl = computed(() => downloadUrl(props.cwd, props.path));

const loading = ref(true);
const error = ref('');
const preview = ref<FilePreview | null>(null);
const kkUrl = ref('');

// Markdown 分支（.md/.markdown）复用既有渲染器；其余文本原样 <pre>。
const isMarkdown = computed(() => isMarkdownName(preview.value?.name ?? ''));
const html = computed(() =>
  preview.value && isMarkdown.value ? renderMarkdown(preview.value.data) : '',
);

/** native-json 通道：#84 的原逻辑（成功进 preview，失败进 error + 下载出口）。 */
async function loadJson(): Promise<void> {
  try {
    preview.value = await api<FilePreview>(jsonPreviewUrl(props.cwd, props.path));
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * kkfile 通道：签能力码。票据 403 preview_code_expired（文件被 agent 改写 / 码过期）时重签一次
 * ——这是 cache-buster 语义的闭环：改写后旧码作废，自动换新码让 kk 重转。其它错误直显 + 下载。
 */
async function loadTicket(attempt = 1): Promise<void> {
  try {
    const tk = await api<PreviewTicket>('/api/preview-tickets', {
      method: 'POST',
      body: JSON.stringify({ cwd: props.cwd, path: props.path }),
    });
    kkUrl.value = tk.url;
  } catch (e) {
    const expired = e instanceof Object && 'code' in e && (e as { code?: string }).code === 'preview_code_expired';
    if (expired && attempt === 1) return loadTicket(2);
    error.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(async () => {
  // 焦点管理 + 背景滚动锁定：打开焦点进 dialog，关闭归还触发按钮（对齐 SessionPickerModal）。
  previousFocus = document.activeElement;
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  await nextTick();
  dialogEl.value?.focus();
  if (channel.value === 'native-json') await loadJson();
  else if (channel.value === 'kkfile') await loadTicket();
  // native-stream / other 不发请求：媒体元素自加载；other 只给下载。
  loading.value = false;
});
onUnmounted(() => {
  document.body.style.overflow = previousOverflow;
  (previousFocus as HTMLElement | null)?.focus?.();
});

const dialogEl = useTemplateRef<HTMLElement>('dialogEl');
let previousFocus: Element | null = null;
let previousOverflow = '';

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}
</script>

<template>
  <!-- 遮罩 + dialog 同一固定容器：移动端全屏层、桌面居中 dialog（对齐 SessionPickerModal 布局） -->
  <div class="fixed inset-0 z-50" @keydown="onKeydown">
    <div class="absolute inset-0 bg-black/40" @click="emit('close')"></div>
    <div
      ref="dialogEl"
      role="dialog"
      aria-modal="true"
      :aria-label="t('preview.title', { path: props.path })"
      tabindex="-1"
      class="absolute inset-x-0 top-10 bottom-0 flex flex-col bg-white shadow-xl outline-none max-md:rounded-t-lg md:inset-auto md:left-1/2 md:top-1/2 md:w-[52rem] md:max-w-[92vw] md:h-[80vh] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg"
    >
      <!-- 头：文件名 + 相对路径 + 下载 + 关闭 -->
      <div class="flex items-center gap-2 border-b border-black/10 px-3 py-2">
        <span class="shrink-0 text-sm">📄 {{ preview?.name ?? props.path.split('/').pop() }}</span>
        <span class="muted min-w-0 truncate text-xs" :title="props.path">{{ props.path }}</span>
        <a
          :href="dlUrl"
          class="ml-auto shrink-0 rounded-md px-2 py-1 text-sm hover:bg-black/5"
          :download="props.path.split('/').pop()"
        >{{ t('preview.download') }}</a>
        <button
          type="button"
          :aria-label="t('common.close')"
          class="shrink-0 rounded-md px-2 py-1 text-sm hover:bg-black/5"
          @click="emit('close')"
        >✕</button>
      </div>

      <!-- 通道内容：加载中 / 失败（带下载）/ 四通道渲染 -->
      <div class="min-h-0 flex-1 overflow-auto px-3 py-2">
        <p v-if="loading" class="muted py-6 text-center text-sm">{{ t('common.loading') }}</p>
        <div v-else-if="error" class="py-6 text-center" role="alert">
          <p class="syserr text-sm">{{ error }}</p>
          <a :href="dlUrl" class="mt-3 inline-block rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5" :download="props.path.split('/').pop()">
            {{ t('preview.downloadInstead') }}
          </a>
        </div>
        <template v-else-if="channel === 'native-json' && preview">
          <img v-if="preview.kind === 'image'" :src="preview.data" :alt="preview.name" class="mx-auto max-h-full max-w-full">
          <!-- Markdown：渲染器输出走 v-html（先转义后格式化，无注入面），.md 类复用全局样式 -->
          <div v-else-if="isMarkdown" v-mermaid class="md text-sm" v-html="html"></div>
          <pre v-else class="overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{{ preview.data }}</pre>
        </template>
        <!-- native-stream：浏览器原生渲染；src 后端 MIME 白名单兜底（html 一律 attachment，不在此渲染） -->
        <object v-else-if="channel === 'native-stream' && mediaKind === 'pdf'" type="application/pdf" :data="streamPreviewUrl(props.cwd, props.path)" class="h-full w-full">
          <p class="muted py-6 text-center text-sm">{{ t('preview.pdfUnsupported') }}</p>
        </object>
        <video v-else-if="channel === 'native-stream' && mediaKind === 'video'" controls class="mx-auto max-h-full max-w-full" :src="streamPreviewUrl(props.cwd, props.path)"></video>
        <audio v-else-if="channel === 'native-stream' && mediaKind === 'audio'" controls class="mx-auto mt-6 w-full" :src="streamPreviewUrl(props.cwd, props.path)"></audio>
        <!-- kkfile：kkFileView iframe。sandbox 不给 allow-same-origin：预览内容脚本拿不到 portal 会话/存储 -->
        <iframe v-else-if="channel === 'kkfile' && kkUrl" :src="kkUrl" class="h-full w-full rounded-md border border-black/10 bg-white" sandbox="allow-scripts" :title="props.path"></iframe>
        <!-- other：清单外不猜格式，唯一出口是下载 -->
        <div v-else class="py-6 text-center">
          <p class="muted text-sm">{{ t('preview.notPreviewable') }}</p>
          <a :href="dlUrl" class="mt-3 inline-block rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5" :download="props.path.split('/').pop()">
            {{ t('preview.download') }}
          </a>
        </div>
      </div>
    </div>
  </div>
</template>
