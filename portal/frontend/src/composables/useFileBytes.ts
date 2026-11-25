// 文件字节加载器（issue #795）：Office/压缩包改由前端库渲染，需要先拿到整份字节。
// 走现有 /api/file?mode=stream（同源 fetch）；未知类型后端本就回 application/octet-stream，
// 而 fetch 不受 Content-Disposition: attachment 影响，所以下载头不会挡我们。
// 关键红线：先看 content-length，超限立刻 cancel() 丢掉 body——绝不把 20MB+ 读进内存，
// 否则 docx/xlsx 的解析会在主线程上把页面卡死。缺 content-length 时照读（缺头不是拒绝理由）。
import { ref, shallowRef, type Ref, type ShallowRef } from 'vue';
import { OFFICE_MAX_BYTES, streamPreviewUrl } from '../lib/previewRoute';

export type FileBytesFailReason = 'too_large' | 'http_error' | 'network_error';

export type FileBytesResult =
  | { ok: true; buffer: ArrayBuffer }
  | { ok: false; reason: FileBytesFailReason };

export function useFileBytes(maxBytes: number = OFFICE_MAX_BYTES) {
  const loading = ref(false);
  // shallowRef：ArrayBuffer 不需要深层响应式，且 reactive 代理会让渲染库拿到 Proxy。
  const result: ShallowRef<FileBytesResult | null> = shallowRef(null);

  function finish(r: FileBytesResult): FileBytesResult {
    result.value = r;
    loading.value = false;
    return r;
  }

  async function load(cwd: string, path: string): Promise<FileBytesResult> {
    loading.value = true;
    result.value = null;
    let res: Response;
    try {
      res = await fetch(streamPreviewUrl(cwd, path));
    } catch {
      return finish({ ok: false, reason: 'network_error' });
    }
    if (!res.ok) return finish({ ok: false, reason: 'http_error' });
    const header = res.headers.get('content-length');
    const declared = header === null ? Number.NaN : Number(header);
    if (Number.isFinite(declared) && declared > maxBytes) {
      // 丢弃 body（不读进内存）；cancel 本身失败不影响「已决定降级」这个结论。
      await res.body?.cancel().catch(() => {});
      return finish({ ok: false, reason: 'too_large' });
    }
    try {
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > maxBytes) return finish({ ok: false, reason: 'too_large' });
      return finish({ ok: true, buffer });
    } catch {
      return finish({ ok: false, reason: 'network_error' });
    }
  }

  return { load, loading: loading as Ref<boolean>, result };
}
