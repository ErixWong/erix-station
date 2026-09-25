// useSidebarWidth 单测（issue #90）：
//   ① 纯函数：钳制边界（180/480/回退默认）、持久化读（缺失/非法/存储异常回退）写（钳制落盘/异常静默）；
//   ② composable 交互：onMounted 读回、pointer 拖拽实时改宽、双击复位、键盘 ←/→ ±16 微调并钳制；
//   ③ WorkbenchView 集成：把手为 aside 兄弟元素（role=separator + aria）、宽度绑定 CSS 变量、<md 抽屉态不变。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import {
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
  useSidebarWidth,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SIDEBAR_STEP,
  SIDEBAR_STORAGE_KEY,
} from './useSidebarWidth';
import WorkbenchView from '../views/WorkbenchView.vue';
import { createAppRouter } from '../router';
import { useAuthStore } from '../stores/auth';

// ---- jsdom 指针事件补齐：setPointerCapture 等不存在，打桩为可断言的 spy ----
let captureSpy: ReturnType<typeof vi.fn>;
let releaseSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  captureSpy = vi.fn();
  releaseSpy = vi.fn();
  Element.prototype.setPointerCapture = captureSpy as (pointerId: number) => void;
  Element.prototype.releasePointerCapture = releaseSpy as (pointerId: number) => void;
  Element.prototype.hasPointerCapture = vi.fn(() => true) as (pointerId: number) => boolean;
});

/** jsdom 无 PointerEvent 且 VTU trigger 对 getter-only 属性赋值会抛错：用 MouseEvent 改名派发 + defineProperty 补 pointerId。 */
function firePointer(el: Element, type: string, init: PointerEventInit = {}) {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: init.button ?? 0,
    clientX: init.clientX ?? 0,
  });
  Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 0 });
  el.dispatchEvent(ev);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('clampSidebarWidth · 钳制边界', () => {
  it('界内值保留（含 180/480 端点），浮点取整', () => {
    expect(clampSidebarWidth(180)).toBe(180);
    expect(clampSidebarWidth(480)).toBe(480);
    expect(clampSidebarWidth(300)).toBe(300);
    expect(clampSidebarWidth(300.6)).toBe(301);
  });

  it('越界值钳到端点', () => {
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(179)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(481)).toBe(SIDEBAR_MAX);
    expect(clampSidebarWidth(99999)).toBe(SIDEBAR_MAX);
  });

  it('非法输入（NaN / Infinity / null / undefined / 非数）回退默认 240', () => {
    expect(clampSidebarWidth(Number('abc'))).toBe(SIDEBAR_DEFAULT);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT);
    expect(clampSidebarWidth(Infinity)).toBe(SIDEBAR_DEFAULT);
    expect(clampSidebarWidth(-Infinity)).toBe(SIDEBAR_DEFAULT);
    expect(clampSidebarWidth(null)).toBe(SIDEBAR_DEFAULT);
    expect(clampSidebarWidth(undefined)).toBe(SIDEBAR_DEFAULT);
  });
});

describe('loadSidebarWidth · 持久化读回退', () => {
  it('缺失 key 回退默认', () => {
    expect(loadSidebarWidth()).toBe(SIDEBAR_DEFAULT);
  });

  it('合法值读回；越界值钳制；非法字符串/空串回退默认', () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, '320');
    expect(loadSidebarWidth()).toBe(320);
    localStorage.setItem(SIDEBAR_STORAGE_KEY, '9999');
    expect(loadSidebarWidth()).toBe(SIDEBAR_MAX);
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'abc');
    expect(loadSidebarWidth()).toBe(SIDEBAR_DEFAULT);
    localStorage.setItem(SIDEBAR_STORAGE_KEY, '');
    expect(loadSidebarWidth()).toBe(SIDEBAR_DEFAULT);
  });

  it('存储抛异常（隐私模式等）回退默认，不抛出', () => {
    const broken = { getItem: () => { throw new Error('denied'); } };
    expect(loadSidebarWidth(broken)).toBe(SIDEBAR_DEFAULT);
  });
});

describe('saveSidebarWidth · 持久化写入', () => {
  it('写入钳制后的字符串值', () => {
    saveSidebarWidth(320);
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('320');
    saveSidebarWidth(9999);
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe(String(SIDEBAR_MAX));
    saveSidebarWidth(Number.NaN);
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe(String(SIDEBAR_DEFAULT));
  });

  it('存储抛异常时静默降级，不阻断交互', () => {
    const broken = { setItem: () => { throw new Error('denied'); } };
    expect(() => saveSidebarWidth(320, broken)).not.toThrow();
  });
});

/** 内联测试组件：复刻 WorkbenchView 把手语义（aria/事件绑定与视图一致），隔离验证 composable 交互。 */
const HandleStub = defineComponent({
  setup() {
    const s = useSidebarWidth();
    return { s, SIDEBAR_MIN, SIDEBAR_MAX };
  },
  template: `
    <div
      class="handle"
      :class="s.dragging.value ? 'bg-brand/60' : 'bg-black/10'"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧栏宽度"
      :aria-valuenow="s.width.value"
      :aria-valuemin="SIDEBAR_MIN"
      :aria-valuemax="SIDEBAR_MAX"
      tabindex="0"
      @pointerdown="s.onHandlePointerDown"
      @dblclick="s.resetWidth"
      @keydown="s.onHandleKeydown"
    ></div>
  `,
});

describe('useSidebarWidth · composable 交互', () => {
  it('onMounted 从 localStorage 读回宽度；无值时默认 240', async () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, '333');
    const w1 = mount(HandleStub);
    await flushPromises();
    expect(w1.find('.handle').attributes('aria-valuenow')).toBe('333');
    w1.unmount();

    localStorage.clear();
    const w2 = mount(HandleStub);
    await flushPromises();
    expect(w2.find('.handle').attributes('aria-valuenow')).toBe(String(SIDEBAR_DEFAULT));
  });

  it('pointer 拖拽：capture → move 实时改宽 → up 结束并 release；宽度钳制且持久化', async () => {
    const wrapper = mount(HandleStub);
    await flushPromises();
    const el = wrapper.find('.handle').element;

    firePointer(el, 'pointerdown', { button: 0, clientX: 500, pointerId: 7 });
    await wrapper.vm.$nextTick();
    expect(captureSpy).toHaveBeenCalledWith(7);
    expect(wrapper.find('.handle').classes()).toContain('bg-brand/60'); // 拖拽中高亮

    // 向右拖 60px：240 → 300（实时写 localStorage）
    firePointer(el, 'pointermove', { clientX: 560 });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.handle').attributes('aria-valuenow')).toBe('300');
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('300');

    // 拖过上限：钳到 480
    firePointer(el, 'pointermove', { clientX: 5000 });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.handle').attributes('aria-valuenow')).toBe(String(SIDEBAR_MAX));

    firePointer(el, 'pointerup', { pointerId: 7 });
    await wrapper.vm.$nextTick();
    expect(releaseSpy).toHaveBeenCalledWith(7);
    expect(wrapper.find('.handle').classes()).toContain('bg-black/10'); // 结束恢复
  });

  it('pointerdown 非主键（button=2）不进入拖拽', async () => {
    const wrapper = mount(HandleStub);
    await flushPromises();
    firePointer(wrapper.find('.handle').element, 'pointerdown', { button: 2, clientX: 500, pointerId: 1 });
    await wrapper.vm.$nextTick();
    expect(captureSpy).not.toHaveBeenCalled();
    expect(wrapper.find('.handle').classes()).toContain('bg-black/10');
  });

  it('双击把手恢复默认 240 并持久化', async () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, '400');
    const wrapper = mount(HandleStub);
    await flushPromises();
    await wrapper.find('.handle').trigger('dblclick');
    expect(wrapper.find('.handle').attributes('aria-valuenow')).toBe(String(SIDEBAR_DEFAULT));
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe(String(SIDEBAR_DEFAULT));
  });

  it('键盘 ←/→ 以 16px 步长微调并钳制', async () => {
    const wrapper = mount(HandleStub);
    await flushPromises();
    const handle = wrapper.find('.handle');

    await handle.trigger('keydown', { key: 'ArrowRight' });
    expect(handle.attributes('aria-valuenow')).toBe(String(SIDEBAR_DEFAULT + SIDEBAR_STEP));
    await handle.trigger('keydown', { key: 'ArrowLeft' });
    await handle.trigger('keydown', { key: 'ArrowLeft' });
    expect(handle.attributes('aria-valuenow')).toBe(String(SIDEBAR_DEFAULT - SIDEBAR_STEP));

    // 连续 ← 到下限：钳在 180
    for (let i = 0; i < 10; i++) await handle.trigger('keydown', { key: 'ArrowLeft' });
    expect(handle.attributes('aria-valuenow')).toBe(String(SIDEBAR_MIN));
    // 连续 → 到上限：钳在 480
    for (let i = 0; i < 40; i++) await handle.trigger('keydown', { key: 'ArrowRight' });
    expect(handle.attributes('aria-valuenow')).toBe(String(SIDEBAR_MAX));
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe(String(SIDEBAR_MAX));
  });
});

describe('WorkbenchView · 把手集成（aside 兄弟元素 + aria + 宽度绑定）', () => {
  async function mountWorkbench() {
    const pinia = createPinia();
    setActivePinia(pinia);
    useAuthStore().user = {
      id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local',
    };
    const router = createAppRouter(createMemoryHistory());
    router.push('/');
    await router.isReady();
    // 无目录空态：/api/dirs 返回空，initWorkspace 提前返回，不触其余 API
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ dirs: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const wrapper = mount(WorkbenchView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return wrapper;
  }

  it('把手渲染为 aside 的兄弟元素，带 role=separator / aria-orientation / aria-valuenow(240)', async () => {
    const wrapper = await mountWorkbench();
    const handle = wrapper.find('[role="separator"]');
    expect(handle.exists()).toBe(true);
    expect(handle.attributes('aria-orientation')).toBe('vertical');
    expect(handle.attributes('aria-valuenow')).toBe(String(SIDEBAR_DEFAULT));
    expect(handle.attributes('aria-valuemin')).toBe(String(SIDEBAR_MIN));
    expect(handle.attributes('aria-valuemax')).toBe(String(SIDEBAR_MAX));
    expect(handle.attributes('tabindex')).toBe('0');
    // 把手是 aside 的下一个兄弟（flex row 内），不在 aside 内部
    const aside = wrapper.find('aside');
    expect(aside.element.nextElementSibling).toBe(handle.element);
  });

  it('aside 宽度经 CSS 变量绑定（--sidebar-w），保留 w-60 基准（<md 抽屉态）与 shrink-0', async () => {
    const wrapper = await mountWorkbench();
    const aside = wrapper.find('aside');
    expect(aside.attributes('style')).toContain('--sidebar-w: 240px');
    expect(aside.classes()).toContain('w-60');
    expect(aside.classes()).toContain('shrink-0');
  });

  it('集成链路：键盘微调 → aria-valuenow 与 CSS 变量同步 + localStorage 落盘', async () => {
    const wrapper = await mountWorkbench();
    await wrapper.find('[role="separator"]').trigger('keydown', { key: 'ArrowRight' });
    expect(wrapper.find('[role="separator"]').attributes('aria-valuenow')).toBe('256');
    expect(wrapper.find('aside').attributes('style')).toContain('--sidebar-w: 256px');
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('256');
  });

  it('双击把手恢复默认；onMounted 读回 localStorage 非法值回退默认', async () => {
    const wrapper = await mountWorkbench();
    const handle = wrapper.find('[role="separator"]');
    await handle.trigger('keydown', { key: 'ArrowRight' });
    await handle.trigger('dblclick');
    expect(handle.attributes('aria-valuenow')).toBe(String(SIDEBAR_DEFAULT));

    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'not-a-number');
    const wrapper2 = await mountWorkbench();
    expect(wrapper2.find('[role="separator"]').attributes('aria-valuenow')).toBe(String(SIDEBAR_DEFAULT));
  });
});
