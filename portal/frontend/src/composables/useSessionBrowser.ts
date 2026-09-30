// 会话浏览 composable（issue #94，架构评审裁决瘦身版）：SessionPickerModal 的数据层，与组件解耦便于单测。
// 语义（评审裁决：选择器降级为单次全量浏览，分页/搜索待真实需求再加回）：
//   一次拉全（limit=100，后端上限），弹窗内列表滚动；条件（scope/cwd）变更 → 重新拉全量，
//   请求序号防竞态（迟到响应不得覆盖新条件的列表）；失败保留旧列表 + 重试（重新拉全量）。
import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { api, ApiError } from '../api';

/** 列表项（GET /api/sessions items 子集；title/cwd/active_run_id 供结果行渲染）。 */
export interface PickerSession {
  id: string;
  title?: string | null;
  cwd?: string | null;
  updated_at?: string;
  active_run_id?: string | null;
}

/** 单次全量拉取的条数（后端 listSessions 上限 100）。 */
const BROWSE_LIMIT = 100;

export interface UseSessionBrowserOptions {
  /** 当前范围（modal 内 segmented 恒可改 → 传 Ref）。 */
  scope: Ref<'cwd' | 'all'>;
  /** scope='cwd' 时的目录绑定（相对形式 ~/projects/<name>）。 */
  cwd: Ref<string | null>;
}

export function useSessionBrowser(opts: UseSessionBrowserOptions) {
  const items = ref<PickerSession[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  let reqSeq = 0; // 请求序号守卫：迟到响应不得覆盖新条件的列表

  async function fetchAll(): Promise<void> {
    const mySeq = ++reqSeq;
    loading.value = true;
    try {
      const p = new URLSearchParams();
      p.set('limit', String(BROWSE_LIMIT));
      if (opts.scope.value === 'cwd' && opts.cwd.value) p.set('cwd', opts.cwd.value);
      const data = await api<{ items: PickerSession[] }>(`/api/sessions?${p.toString()}`);
      if (mySeq !== reqSeq) return; // 旧请求：丢弃（竞态防护）
      error.value = null;
      items.value = data.items;
    } catch (e) {
      if (mySeq !== reqSeq) return;
      error.value = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
      // 失败保留旧列表：重试走 retry()。
    } finally {
      if (mySeq === reqSeq) loading.value = false;
    }
  }

  /** 条件变更：立即重新拉全量。 */
  function reload(): void {
    error.value = null;
    void fetchAll();
  }

  watch([opts.scope, opts.cwd], reload);
  void fetchAll(); // 首屏立即拉取

  /** 三态之「无结果」（非加载、非失败、空列表）。 */
  const empty = computed(() => !loading.value && !error.value && items.value.length === 0);

  /** 失败重试：重新拉全量（无游标/追加语义）。 */
  function retry(): void {
    if (loading.value) return;
    void fetchAll();
  }

  onScopeDispose(() => {
    reqSeq++; // 组件卸载：迟到响应作废
  });

  return { items, loading, error, empty, retry };
}
