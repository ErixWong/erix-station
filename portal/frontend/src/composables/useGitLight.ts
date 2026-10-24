// 收工灯的数据层（issue #359 / 决策 §7 D9，P0b）。形状照 `usePreviewPorts.ts`：
// 每次调用新建（不是模块级单例）、闭包 `reqSeq` 竞态守卫、30s 轮询 + 回前台即刷、`onScopeDispose` 收摊。
//
// 本层只管"取数与作废"，**显示口径一律在 `lib/gitLight.ts`**（那里钉"⚪ 不得显绿"）。
// 为什么不缓存 TTL / 不在这里判色：判色有两处就会漂移，前端只做一层兜底（旧后端回归时也不许洗成绿）。
import { computed, onScopeDispose, ref } from 'vue';
import { api } from '../api';
import {
  gitLightDisplay,
  gitLightPath,
  parseGitLightPayload,
  toGitLightApiError,
  type GitLightApiError,
  type GitLightPayload,
} from '../lib/gitLight';

export interface UseGitLightOptions {
  /** 当前目录（`~/projects/<name>` 形，与 store.dirCwd 同口径）。返回空 ⇒ 不发请求（没选目录）。 */
  cwd: () => string | null | undefined;
}

export function useGitLight(options: UseGitLightOptions) {
  const payload = ref<GitLightPayload | null>(null);
  const loading = ref(false);
  const loaded = ref(false);
  const error = ref<GitLightApiError | null>(null);

  let reqSeq = 0; // 迟到响应不得覆盖新目录的结果（切目录 = 换问题）

  /** 换目录/换上下文时调用：作废在途请求并清掉旧结论（旧目录的绿不许顶到新目录头上）。 */
  function reset(): void {
    reqSeq++;
    payload.value = null;
    loaded.value = false;
    error.value = null;
    loading.value = false;
  }

  async function load(): Promise<void> {
    const cwd = options.cwd();
    if (!cwd) { reset(); return; }
    const mySeq = ++reqSeq;
    loading.value = true;
    error.value = null;
    try {
      const raw = await api<unknown>(gitLightPath(cwd));
      if (mySeq !== reqSeq) return;
      const parsed = parseGitLightPayload(raw);
      if (parsed) {
        payload.value = parsed;
        loaded.value = true;
      } else {
        // 载荷形状不认识 ⇒ 当"没检查"处理（宁可灰，不拿不认识的东西显绿）。
        payload.value = null;
        loaded.value = false;
        error.value = { status: 200, code: 'bad_payload', message: 'git-light payload unrecognized' };
      }
    } catch (err) {
      if (mySeq !== reqSeq) return;
      error.value = toGitLightApiError(err);
      // 失败**保留旧结论**（与 usePreviewPorts 同口径）：灯不会一闪变成"没检查"，
      // 但 tooltip 会带上错误码，且此时 `loaded` 不变 ⇒ 视图仍能给出"上次结果 + 本次失败"。
    } finally {
      if (mySeq === reqSeq) loading.value = false;
    }
  }

  // 自动保鲜：30s 轮询 + 回到前台立即刷（页面上挂着不动也能见到 run 后的结果）。
  // 页面隐藏时不轮询（不打扰服务端、也不给睡眠标签攒请求）。
  const pollTimer = setInterval(() => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') void load();
  }, 30_000);
  const onVisible = () => {
    if (document.visibilityState === 'visible') void load();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);

  onScopeDispose(() => {
    reqSeq++; // 卸载：在途响应作废
    clearInterval(pollTimer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
  });

  return {
    payload,
    loading,
    loaded,
    error,
    /** 显示口径（唯一的判色入口）：`{ state, reasonKey, needsAction }`。 */
    display: computed(() => gitLightDisplay(payload.value)),
    load,
    reset,
  };
}
