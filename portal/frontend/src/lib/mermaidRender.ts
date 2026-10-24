// mermaid 图表渲染（参考 pi-web components/MermaidBlock.tsx 的口径，适配本仓库零框架 DOM 路径）。
//
// 安全口径：securityLevel:'strict' —— mermaid 内部对节点文本走 DOMPurify 消毒后才产出 SVG，
// 与 pi-web 把 render 结果 dangerouslySetInnerHTML 进 DOM 是同一信任级；渲染失败不改页面结构
// （suppressErrorRendering:true，防半截图/错误节点炸布局）。
//
// 懒加载：mermaid 体积大（>1MB min），只在首个 mermaid 代码块真正出现时才 dynamic import
// （vite 会拆独立 chunk），普通对话不为它付一分包成本。
//
// 缓存：按源码字符串缓存渲染 Promise——流式重渲染、消息列表重挂载都只命中缓存，
// 失败不缓存（同样的文本可重试，且调用方拿到的 rejection 只服务于当次挂载）。

// mermaid 默认导出没有独立类型名可 import，用模块默认导出的推导类型代替
type MermaidInstance = typeof import('mermaid').default;

let mermaidLoader: Promise<MermaidInstance> | null = null;
const svgCache = new Map<string, Promise<string>>();

function loadMermaid(): Promise<MermaidInstance> {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid')
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          theme: 'default',
        });
        return mermaid;
      })
      .catch((e: unknown) => {
        // 加载失败（如离线拆包 404）不缓存 rejection，留重试机会
        mermaidLoader = null;
        throw e;
      });
  }
  return mermaidLoader;
}

function nextRenderId(): string {
  const c = globalThis.crypto;
  return c && 'randomUUID' in c
    ? 'md-md-' + c.randomUUID()
    : 'md-md-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

/** 渲染 mermaid 源码为 SVG 字符串；语法错误/渲染失败以 reject 抛出（调用方兜底展示源码）。 */
export function renderMermaidSvg(code: string): Promise<string> {
  const cached = svgCache.get(code);
  if (cached) return cached;
  const task = (async () => {
    const mermaid = await loadMermaid();
    // 先 parse 再 render：非法图直接 reject（pi-web 同口径，防 render 半途插错误节点）
    if (!(await mermaid.parse(code, { suppressErrors: true }))) throw new Error('invalid mermaid diagram');
    const { svg } = await mermaid.render(nextRenderId(), code);
    return svg;
  })();
  svgCache.set(code, task);
  task.catch(() => svgCache.delete(code));
  return task;
}
