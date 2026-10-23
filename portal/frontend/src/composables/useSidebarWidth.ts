// 侧栏宽度拖拽调整（issue #90）：≥md 静态侧栏右缘把手，pointer 拖拽 + 键盘微调 + 双击复位。
// 钳制/持久化抽成纯函数便于单测；composable 只负责交互编排与响应式状态。
import { computed, onMounted, ref } from 'vue';

export const SIDEBAR_MIN = 180; // 钳制下限
export const SIDEBAR_MAX = 480; // 钳制上限
export const SIDEBAR_DEFAULT = 240; // 默认宽（= 旧 w-60），双击把手复位到此值
export const SIDEBAR_STEP = 16; // 键盘 ←/→ 微调步长
export const SIDEBAR_STORAGE_KEY = 'station.sidebarWidth';

/** 钳制到 [min, max]；非法输入（NaN / Infinity / 非数）回退默认。 */
export function clampSidebarWidth(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(value)));
}

/** 从 localStorage 读回宽度；缺失 / 非法值 / 存储不可用时回退默认。 */
export function loadSidebarWidth(storage: Pick<Storage, 'getItem'> = localStorage): number {
  try {
    const raw = storage.getItem(SIDEBAR_STORAGE_KEY);
    if (raw === null || raw === '') return SIDEBAR_DEFAULT;
    return clampSidebarWidth(Number(raw));
  } catch {
    return SIDEBAR_DEFAULT; // 隐私模式等存储不可用：静默回退默认
  }
}

/** 写入 localStorage（先钳制再落盘）；存储异常静默降级，不阻断交互。 */
export function saveSidebarWidth(width: number, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(SIDEBAR_STORAGE_KEY, String(clampSidebarWidth(width)));
  } catch { /* 存储不可用：本次会话内宽度仍生效，仅不持久化 */ }
}

export function useSidebarWidth() {
  const width = ref(SIDEBAR_DEFAULT);
  const dragging = ref(false);

  // onMounted 读回持久化宽度（非法值在 loadSidebarWidth 内已回退默认）
  onMounted(() => { width.value = loadSidebarWidth(); });

  /** 统一改宽入口：钳制 + 持久化。 */
  function setWidth(w: number) {
    width.value = clampSidebarWidth(w);
    saveSidebarWidth(width.value);
  }

  function resetWidth() {
    setWidth(SIDEBAR_DEFAULT); // 双击把手恢复默认
  }

  // pointerdown → setPointerCapture → pointermove 实时改宽（仅内存）→ pointerup 落盘并结束。
  // 持久化节流：onMove 高频触发不写 localStorage，避免拖拽途中反复同步写；松手按最终宽度写一次。
  // 把手是 aside 的兄弟元素（issue #308 起 aside 是 overflow-hidden，内部滚动只有列表段与底部栈两层；
  // 把手放在内部会与那两层的滚动条打架）。
  function onHandlePointerDown(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    if (e.button !== 0) return; // 只响应主键，避免误占中/右键
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    dragging.value = true;
    const startX = e.clientX;
    const startWidth = width.value;
    const onMove = (ev: PointerEvent) => {
      // 节流落盘：拖拽中只改内存宽度，localStorage 写推迟到 pointerup（按最终宽度写一次）
      width.value = clampSidebarWidth(startWidth + (ev.clientX - startX));
    };
    const onUp = (ev: PointerEvent) => {
      dragging.value = false;
      saveSidebarWidth(width.value); // 松手落盘：此时 width 已是钳制后的最终值
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  }

  // 键盘 ←/→ ±SIDEBAR_STEP 微调（无障碍：role=separator 的标准交互）
  function onHandleKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setWidth(width.value - SIDEBAR_STEP);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setWidth(width.value + SIDEBAR_STEP);
    }
  }

  // aside 宽度只作用于 ≥md 静态侧栏：<md 抽屉态沿用 max-md: 变体布局，不受行内宽影响
  const asideStyle = computed(() => ({ '--sidebar-w': `${width.value}px` }));

  return {
    width,
    dragging,
    asideStyle,
    setWidth,
    resetWidth,
    onHandlePointerDown,
    onHandleKeydown,
  };
}
