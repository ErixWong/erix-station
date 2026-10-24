// v-html 内容里 mermaid 代码块的 DOM 后处理增强（参考 pi-web MermaidBlock 的交互口径）。
//
// 为什么在 DOM 层做、不动 lib/markdown.ts：渲染器是「先整体转义后格式化」的零依赖白名单实现
// （XSS 判据所在，spec golden 逐字钉住），不为其引入第二输出形态；且渲染器输出是纯字符串、
// 无生命周期，SVG 渲染天然属于挂载后阶段。增强是**幂等**的（data-mermaid 状态位），v-html
// 重渲染后重新扫描即可，同源码命中 mermaidRender 的缓存不重复画图。
//
// 交互对齐 pi-web：默认预览图（defaultPreview），头部按钮在「图 ↔ 源码」间切换；渲染中/失败
// 保持源码可见（失败补一行提示），绝不让半截状态炸布局。流式增量气泡**不挂**本增强
//（pi-web 同口径：isStreaming 时禁用预览），终稿落定后才画图，避免每个 chunk 重渲。

import { watch } from 'vue';
import { i18n } from '../i18n';
import { renderMermaidSvg } from './mermaidRender';

/** 增强状态位属性：无该属性 = 未处理；pending / ready / error。 */
const MARK = 'data-mermaid';
type LabelKey = 'preview' | 'source' | 'error';

const t = (key: LabelKey): string => i18n.global.t('stream.mermaid.' + key);

// 语言切换时刷新所有已增强块的按钮/提示文案（模块级单例 watcher，首次增强时装上）。
let labelWatcherInstalled = false;
function ensureLabelWatcher(): void {
  if (labelWatcherInstalled) return;
  labelWatcherInstalled = true;
  watch(
    () => i18n.global.locale.value,
    () => {
      document
        .querySelectorAll<HTMLElement>('[data-mermaid-label]')
        .forEach((el) => { el.textContent = t((el.dataset.mermaidLabel ?? 'preview') as LabelKey); });
    },
  );
}

function enhanceBlock(block: HTMLElement): void {
  const header = block.querySelector<HTMLElement>('.md-lang');
  const pre = block.querySelector('pre');
  const codeEl = block.querySelector<HTMLElement>('pre code');
  if (!header || !pre || !codeEl) return;
  if (header.textContent?.trim().toLowerCase() !== 'mermaid') return;

  block.setAttribute(MARK, 'pending');
  block.classList.add('md-mermaid');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'md-mermaid-toggle';
  const setLabel = (showingPreview: boolean): void => {
    const key: LabelKey = showingPreview ? 'source' : 'preview';
    toggle.dataset.mermaidLabel = key;
    toggle.textContent = t(key);
  };
  toggle.addEventListener('click', () => {
    const showing = block.classList.toggle('md-mermaid-preview');
    setLabel(showing);
  });
  header.appendChild(toggle);

  renderMermaidSvg(codeEl.textContent ?? '')
    .then((svg) => {
      // v-html 可能已把这块 DOM 换掉：不在文档里就安静退场（缓存结果对后续重扫仍可复用）
      if (!block.isConnected) return;
      const holder = document.createElement('div');
      holder.className = 'md-mermaid-svg';
      // 信任级与 pi-web 一致：securityLevel:'strict' 下 mermaid 输出的 SVG 已过 DOMPurify
      holder.innerHTML = svg;
      block.insertBefore(holder, pre);
      block.setAttribute(MARK, 'ready');
      block.classList.add('md-mermaid-preview'); // 默认展示图（pi-web defaultPreview 口径）
      setLabel(true);
    })
    .catch(() => {
      if (!block.isConnected) return;
      block.setAttribute(MARK, 'error');
      toggle.remove();
      const note = document.createElement('div');
      note.className = 'md-mermaid-error';
      note.dataset.mermaidLabel = 'error';
      note.textContent = t('error');
      block.appendChild(note);
    });
}

/** 扫描 root 内未增强的 ```mermaid 代码块并挂上预览渲染（幂等，可对同一 root 反复调用）。 */
export function enhanceMermaid(root: HTMLElement): void {
  const blocks = root.querySelectorAll<HTMLElement>('.md-code:not([data-mermaid])');
  if (blocks.length === 0) return;
  ensureLabelWatcher();
  blocks.forEach(enhanceBlock);
}
