// previewRoute 纯函数单测（#366 / #795）：各通道分流的每一条边界 +
// 与后端 MIME/嗅探表的两处漂移钉。#795：office/zip 已改前端渲染，kkfile 不再被产出。
import { describe, expect, it } from 'vitest';
import {
  IMAGE_EXTS, KKFILE_EXTS, OFFICE_EXTS, PDF_EXTS, VIDEO_EXTS, AUDIO_EXTS, ZIP_EXTS,
  OFFICE_MAX_BYTES,
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

describe('previewChannel 通道分流', () => {
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
  it('native-office：docx/xlsx/xls/pptx（#795 前端渲染）', () => {
    for (const p of ['a.docx', 'b.XLSX', 'c.xls', 'd.PPTX', 'sub/报告 v2.docx']) {
      expect(previewChannel(p)).toBe('native-office');
    }
  });
  it('native-zip：zip（只列目录）', () => {
    expect(previewChannel('pack.zip')).toBe('native-zip');
    expect(previewChannel('sub/A.ZIP')).toBe('native-zip');
  });
  it('其余 Office / 压缩包一律 other（#795：kkfile 不再被产出，也不猜）', () => {
    for (const p of ['a.doc', 'b.ppt', 'c.wps', 'd.visio', 'e.cad', 'f.rar', 'g.7z',
      'h.tar.gz', 'i.epub', 'j.ofd']) {
      expect(previewChannel(p)).toBe('other');
    }
  });
  it('other：清单外一律不猜（含 html 陷阱名与无扩展名）', () => {
    // 注意 html 在 TEXT 桶（JSON 通道按文本原样看源码）；这里 other 用真正不在清单的。
    for (const p of ['binary.bin', 'x.parquet', 'noext', 'a.unk']) {
      expect(previewChannel(p)).toBe('other');
    }
  });
  it('OFFICE_MAX_BYTES = 20MB（超限降级下载，不尝试前端渲染）', () => {
    expect(OFFICE_MAX_BYTES).toBe(20971520);
  });
  it('清单常量本身照契约（前端渲染只这四个 office + 一个 zip）', () => {
    const want = ['docx', 'pptx', 'xls', 'xlsx'].sort().join(',');
    expect([...OFFICE_EXTS].sort().join(',')).toBe(want);
    expect([...ZIP_EXTS]).toEqual(['zip']);
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
  it('kkfile 桶常量仍覆盖 Office 三件套与常见压缩包（常量暂留，通道已死，#795）', () => {
    for (const e of ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'rar', '7z']) {
      expect(KKFILE_EXTS).toContain(e);
    }
  });
  it('kkfile 常量不再是路由依据：任何扩展名都不会路由到 kkfile', () => {
    for (const e of KKFILE_EXTS) expect(previewChannel(`a.${e}`)).not.toBe('kkfile');
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
