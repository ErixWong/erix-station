// useFileBytes 单测（issue #795）：字节加载的四条出口 + 一条红线。
// 红线：超限必须**先看 content-length 就撤**（cancel 掉 body），不能把大文件读进内存——
// 所以断言 cancel() 被调、arrayBuffer() 一次都没被调。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileBytes } from './useFileBytes';
import { OFFICE_MAX_BYTES } from '../lib/previewRoute';

interface StubOpts {
  ok?: boolean;
  status?: number;
  /** null / undefined ⇒ 不发 content-length 头。 */
  length?: string | null;
  bytes?: number[];
  readThrows?: boolean;
}

/** Response 桩：只实现 composable 真正碰到的那几个成员（headers/ok/body.cancel/arrayBuffer）。 */
function stubRes(opts: StubOpts = {}) {
  const cancel = vi.fn(async () => {});
  const bytes = new Uint8Array(opts.bytes ?? [1, 2, 3, 4]);
  const arrayBuffer = vi.fn(async () => {
    if (opts.readThrows) throw new Error('body stream broke');
    return bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer;
  });
  const headers = new Headers(
    opts.length === undefined || opts.length === null ? {} : { 'content-length': opts.length });
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers,
    body: { cancel },
    arrayBuffer,
    cancel,
  };
}

function stubFetch(impl: () => Promise<unknown> | Response | Promise<Response>) {
  const fn = vi.fn(impl as (...args: unknown[]) => Promise<Response>);
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('useFileBytes（#795 前端渲染的字节装载）', () => {
  it('正常：走 mode=stream 的同一 URL，回 ok:true 与真实字节数', async () => {
    const fn = stubFetch(async () => stubRes({ length: '4' }) as unknown as Response);
    const { load, loading, result } = useFileBytes();
    const r = await load('~/projects/demo', 'docs/report.docx');
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.buffer.byteLength).toBe(4);
    expect(result.value).toMatchObject({ ok: true });
    expect(loading.value).toBe(false);
    const url = new URL(String(fn.mock.calls.at(-1)![0]), 'http://x');
    expect(url.pathname).toBe('/api/file');
    expect(url.searchParams.get('mode')).toBe('stream');
    expect(url.searchParams.get('cwd')).toBe('~/projects/demo');
    expect(url.searchParams.get('path')).toBe('docs/report.docx');
  });

  it('content-length 超限：too_large 且未读 body（cancel 被调、arrayBuffer 未被调）', async () => {
    const stub = stubRes({ length: String(OFFICE_MAX_BYTES + 1) });
    stubFetch(async () => stub as unknown as Response);
    const { load, loading, result } = useFileBytes();
    const r = await load('~', 'big.pptx');
    expect(r).toEqual({ ok: false, reason: 'too_large' });
    expect(result.value).toEqual({ ok: false, reason: 'too_large' });
    expect(loading.value).toBe(false);
    expect(stub.cancel).toHaveBeenCalledTimes(1);
    expect(stub.arrayBuffer).not.toHaveBeenCalled();
  });

  it('自定义 maxBytes 生效（同一份 5 字节，上限 4 就超限）', async () => {
    const stub = stubRes({ length: '5', bytes: [1, 2, 3, 4, 5] });
    stubFetch(async () => stub as unknown as Response);
    const { load } = useFileBytes(4);
    expect(await load('~', 'a.xlsx')).toEqual({ ok: false, reason: 'too_large' });
    expect(stub.arrayBuffer).not.toHaveBeenCalled();
  });

  it('边界：content-length 恰等于上限 ⇒ 照读（> 才算超限）', async () => {
    stubFetch(async () => stubRes({ length: '20971520' }) as unknown as Response);
    const { load } = useFileBytes();
    expect((await load('~', 'edge.docx')).ok).toBe(true);
  });

  it('无 content-length ⇒ 照读（缺头不是拒绝的理由）', async () => {
    const stub = stubRes({ bytes: [9, 9] });
    stubFetch(async () => stub as unknown as Response);
    const { load } = useFileBytes();
    const r = await load('~', 'mystery.zip');
    expect(r.ok && r.buffer.byteLength).toBe(2);
    expect(stub.arrayBuffer).toHaveBeenCalledTimes(1);
    expect(stub.cancel).not.toHaveBeenCalled();
  });

  it('缺头但实际字节超限 ⇒ 读完仍降级 too_large', async () => {
    const stub = stubRes({ bytes: [1, 2, 3, 4, 5], length: null });
    stubFetch(async () => stub as unknown as Response);
    expect(await useFileBytes(2).load('~', 'a.docx')).toEqual({ ok: false, reason: 'too_large' });
  });

  it('!res.ok（413/404）⇒ http_error，不读 body', async () => {
    const stub = stubRes({ ok: false, status: 413 });
    stubFetch(async () => stub as unknown as Response);
    const { load, loading } = useFileBytes();
    expect(await load('~', 'x.doc')).toEqual({ ok: false, reason: 'http_error' });
    expect(loading.value).toBe(false);
    expect(stub.arrayBuffer).not.toHaveBeenCalled();
  });

  it('fetch 抛 ⇒ network_error（loading 一定复位，不给悬挂态）', async () => {
    stubFetch(async () => { throw new Error('network down'); });
    const { load, loading, result } = useFileBytes();
    expect(await load('~', 'x.docx')).toEqual({ ok: false, reason: 'network_error' });
    expect(loading.value).toBe(false);
    expect(result.value).toEqual({ ok: false, reason: 'network_error' });
  });

  it('body 读取中途抛 ⇒ network_error', async () => {
    stubFetch(async () => stubRes({ readThrows: true }) as unknown as Response);
    expect(await useFileBytes().load('~', 'x.docx'))
      .toEqual({ ok: false, reason: 'network_error' });
  });

  it('加载中：load 挂起期间 loading 为 true，完成后落回 false', async () => {
    let release: ((r: Response) => void) | undefined;
    stubFetch(() => new Promise<Response>((r) => { release = r; }));
    const { load, loading } = useFileBytes();
    const p = load('~', 'x.docx');
    expect(loading.value).toBe(true);
    release!(stubRes({ length: '4' }) as unknown as Response);
    await p;
    expect(loading.value).toBe(false);
  });
});
