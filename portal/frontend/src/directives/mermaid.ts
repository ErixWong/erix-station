// v-mermaid：给承载 markdown v-html 的容器挂 mermaid 图后处理（实现见 lib/mermaidEnhance）。
//
// 时序：mounted/updated 都经 nextTick 再扫描——nextTick 落在本次渲染 flush 之后，
// 保证读到的是 v-html 补丁完成后的 DOM（v-html 与自定义指令同宿主时执行次序不保证先后，
// 推迟一拍就不依赖次序）。增强幂等 + 渲染按源码缓存，updated 高频触发也只付扫描成本。
import { nextTick, type Directive } from 'vue';
import { enhanceMermaid } from '../lib/mermaidEnhance';

export const vMermaid: Directive<HTMLElement> = {
  mounted: (el) => { nextTick(() => enhanceMermaid(el)); },
  updated: (el) => { nextTick(() => enhanceMermaid(el)); },
};
