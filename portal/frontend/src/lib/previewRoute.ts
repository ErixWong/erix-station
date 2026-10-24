// 文件预览路由（#366）：扩展名 → 渲染通道的**纯函数**（无 DOM/无 fetch，可单独钉测）。
// 两桶清单是 #356 评审定稿的前端侧：
//   - native-json：现有 /api/file JSON 契约（文本/Markdown/图片，≤2MB）——零改动沿用；
//   - native-stream：浏览器原生能播的二进制（PDF/音视频），走 /api/file?mode=stream；
//   - kkfile：Office/压缩包/CAD 等，走 kkFileView iframe（P2，POST /api/preview-tickets 签码）；
//   - other：两桶之外一律「不预览」——点开即给下载（红线：清单外不猜格式，也不产生 kk 票）。
// 后端各自还有内容级判据（JSON 通道的 NUL 嗅探、stream 通道的 MIME 白名单），本清单只决定
// 「点开后前端拿哪个通道试」；猜错的兜底方向永远是下载不是渲染。

/** 与后端 IMAGE_MIME 同集（改一边必须改另一边，测试钉漂移）。 */
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];

/** Markdown 与纯文本（JSON 通道，后端还有 8KB NUL 嗅探兜底）。 */
export const TEXT_EXTS = [
  'md', 'markdown', 'txt', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'css', 'scss',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'py', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp',
  'sh', 'bash', 'zsh', 'sql', 'ini', 'conf', 'env', 'properties', 'log', 'csv', 'tsv', 'makefile', 'dockerfile',
  'gitignore', 'lock', 'yaml', 'tf', 'r', 'lua', 'pl', 'rb', 'php', 'swift', 'gradle', 'bat', 'ps1',
];

/** 浏览器原生渲染的流式桶（与后端 STREAM_MIME 媒体白名单同源；测试钉漂移）。 */
export const PDF_EXTS = ['pdf'];
export const VIDEO_EXTS = ['mp4', 'webm', 'm4v', 'mov'];
export const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'm4a'];

/** kkFileView 桶（#356 清单的 kkfile 半区）：Office / 压缩包 / CAD / 电子书。 */
export const KKFILE_EXTS = [
  // Office
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'wps', 'et', 'dps', 'visio', 'vsd', 'vsdx', 'msword',
  // 压缩包
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'tar.gz',
  // CAD / 图形 / 电子书
  'cad', 'dwg', 'dxf', 'psd', 'eps', 'tif', 'tiff', 'ceb', 'epub', 'chm', 'ofd',
];

export type PreviewChannel = 'native-json' | 'native-stream' | 'kkfile' | 'other';

/** 取小写扩展名（无点；隐藏文件去点按整名计，.env 算 env、.gitignore 算 gitignore；目录尾斜杠 → ''）。 */
export function extOf(path: string): string {
  const raw = String(path ?? '');
  const base = raw.endsWith('/') ? '' : (raw.split('/').pop() ?? '');
  const stripped = base.startsWith('.') ? base.slice(1) : base;
  const dot = stripped.lastIndexOf('.');
  if (dot <= 0) return stripped.toLowerCase();
  return stripped.slice(dot + 1).toLowerCase();
}

/** 文件名是否 Markdown（modal 的渲染分支用，与旧版正则同口径）。 */
export function isMarkdownName(name: string): boolean {
  return /\.(md|markdown)$/i.test(String(name ?? ''));
}

/** 扩展名 → 预览通道。清单外一律 other（不猜）。 */
export function previewChannel(path: string): PreviewChannel {
  const ext = extOf(path);
  if (IMAGE_EXTS.includes(ext) || TEXT_EXTS.includes(ext)) return 'native-json';
  if (PDF_EXTS.includes(ext) || VIDEO_EXTS.includes(ext) || AUDIO_EXTS.includes(ext)) return 'native-stream';
  if (KKFILE_EXTS.includes(ext)) return 'kkfile';
  return 'other';
}

/** native-stream 桶里的媒体族（modal 选 <object>/<video>/<audio>）。 */
export function streamMediaKind(path: string): 'pdf' | 'video' | 'audio' | null {
  const ext = extOf(path);
  if (PDF_EXTS.includes(ext)) return 'pdf';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  return null;
}

/** JSON 通道 URL（现有契约）。 */
export function jsonPreviewUrl(cwd: string, path: string): string {
  return `/api/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`;
}

/** 流式通道 URL（PDF/音视频；Range 由浏览器自己带）。 */
export function streamPreviewUrl(cwd: string, path: string): string {
  return `${jsonPreviewUrl(cwd, path)}&mode=stream`;
}

/** 下载出口（413/415/清单外的唯一路径）。 */
export function downloadUrl(cwd: string, path: string): string {
  return `${jsonPreviewUrl(cwd, path)}&mode=download`;
}
