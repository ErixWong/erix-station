// previewRoute 纯函数单测（#366）：四通道分流的每一条边界 + 与后端 MIME/嗅探表的两处漂移钉。
import { describe, expect, it } from 'vitest';
import {
  IMAGE_EXTS, KKFILE_EXTS, PDF_EXTS, VIDEO_EXTS, AUDIO_EXTS,
  downloadUrl, extOf, isMarkdownName, jsonPreviewUrl, previewChannel, streamMediaKind, streamPreviewUrl,
} from './previewRoute';

describe('extOf', () => {
  it('常规/多级/大写/隐藏文件/无扩展名', () => {
    expect(extOf('a/b/Report.DOCX')).toBe('docx');
    expect(extOf('archive.tar.gz')).toBe('gz');
    expect(extOf('.gitignore')).toBe('gitignore');
    expect(extOf('Makefile')).toBe('makefile');
    expect(extOf('dir/')).toBe('');
    expect(extOf('')).toBe('');
  });
});

describe('previewChannel 四通道', () => {
  it('native-json：文本族与图片族', () => {
    for (const p of ['README.md', 'a.txt', 'main.py', 'pkg.json', 'x.yaml', 'logo.PNG', 'i.jpeg']) {
      expect(previewChannel(p)).toBe('native-json');
    }
  });
  it('native-stream：PDF/视频/音频', () => {
    expect(previewChannel('spec.pdf')).toBe('native-stream');
    expect(previewChannel('v.MP4')).toBe('native-stream');
    expect(previewChannel('song.mp3')).toBe('native-stream');
  });
  it('kkfile：Office/压缩包/CAD', () => {
    for (const p of ['a.docx', 'b.XLSX', 'c.ppt', 'd.zip', 'e.rar', 'f.dwg']) {
      expect(previewChannel(p)).toBe('kkfile');
    }
  });
  it('other：清单外一律不猜（含 html 陷阱名与无扩展名）', () => {
    // 注意 html 在 TEXT 桶（JSON 通道按文本原样看源码）；这里 other 用真正不在清单的。
    for (const p of ['binary.bin', 'x.parquet', 'noext', 'a.unk']) {
      expect(previewChannel(p)).toBe('other');
    }
  });
  it('html/htm 归 native-json（按源码文本预览，不当作可渲染页执行）', () => {
    expect(previewChannel('page.html')).toBe('native-json');
  });
});

describe('streamMediaKind', () => {
  it('族分类与 null 边界', () => {
    expect(streamMediaKind('a.pdf')).toBe('pdf');
    expect(streamMediaKind('a.webm')).toBe('video');
    expect(streamMediaKind('a.wav')).toBe('audio');
    expect(streamMediaKind('a.png')).toBeNull();
    expect(streamMediaKind('a.docx')).toBeNull();
  });
});

describe('与后端表的漂移钉（改一边必须改另一边）', () => {
  it('图片桶逐字对齐后端 IMAGE_MIME 的扩展名集', () => {
    expect([...IMAGE_EXTS].sort().join(',')).toBe(['bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'].sort().join(','));
  });
  it('流式媒体桶逐字对齐后端 STREAM_MIME 的非图片部分', () => {
    expect([...PDF_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS].sort().join(','))
      .toEqual(['m4a', 'm4v', 'mp3', 'mp4', 'mov', 'ogg', 'pdf', 'wav', 'webm'].sort().join(','));
  });
  it('kkfile 桶覆盖 Office 三件套与常见压缩包', () => {
    for (const e of ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'rar', '7z']) {
      expect(KKFILE_EXTS).toContain(e);
    }
  });
});

describe('URL 构造', () => {
  it('三通道 URL 都带编码后的 cwd/path，mode 参数正确', () => {
    const cwd = '~/projects/demo app';
    const p = 'sub/报告 v1.pdf';
    const j = new URL(jsonPreviewUrl(cwd, p), 'http://x');
    expect(j.searchParams.get('cwd')).toBe(cwd);
    expect(j.searchParams.get('path')).toBe(p);
    expect(j.searchParams.get('mode')).toBeNull();
    const s = new URL(streamPreviewUrl(cwd, p), 'http://x');
    expect(s.searchParams.get('mode')).toBe('stream');
    const d = new URL(downloadUrl(cwd, p), 'http://x');
    expect(d.searchParams.get('mode')).toBe('download');
  });
});

describe('isMarkdownName', () => {
  it('.md/.markdown 大小写', () => {
    expect(isMarkdownName('README.md')).toBe(true);
    expect(isMarkdownName('A.MARKDOWN')).toBe(true);
    expect(isMarkdownName('a.ts')).toBe(false);
    expect(isMarkdownName('')).toBe(false);
  });
});
